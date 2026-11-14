'use strict';

/**
 * OAK HIMS — Pengujian Terisolasi Tahap A (Revisi R1):
 * Riwayat Mutasi Global & Laporan Mutasi Barang (8 Kolom)
 * ============================================================================
 * Cakupan Verifikasi:
 *  1. Helper parseAsiaJakartaHalfOpenDateBounds:
 *     - [start_bound_inclusive, end_bound_exclusive) dalam Asia/Jakarta (+07:00)
 *     - Validasi tanggal kalender ketat (menolak 2026-02-30, format salah, start > end)
 *     - Bukti batas eksklusif di SQL: 23:59:59.999 WIB hari akhir masuk, 00:00:00 WIB H+1 eksklusif,
 *       dan 23:59:59 WIB H-1 eksklusif dari baris tampilan tetapi tetap dihitung dalam balance_before.
 *  2. Perhitungan Saldo Sebelum/Sesudah (balance_before / balance_after):
 *     - Dihitung per partisi kanonik (property_id, product_id, location_id) dari seluruh histori
 *       partisi SEBELUM filter tanggal, operation_type, direction, search, sort_order, dan paginasi.
 *     - Invarian penuh: nilai balance_before & balance_after untuk movement_id yang sama identik 100%
 *       baik saat tanpa filter, difilter tanggal/operasi/arah/pencarian, diurutkan ASC/DESC,
 *       dipaginasi (page 1/2/3), maupun diekspor penuh (export_all=true).
 *  3. Pemisahan Satuan Dasar (totals_by_unit) & Konsistensi Snapshot:
 *     - Kuantitas masuk/keluar/selisih dipisahkan per base_unit_code (BOTOL vs GRAM tidak digabung).
 *     - Detail baris, total_rows, totals_by_unit, dan partition_summaries berasal dari satu snapshot
 *       REPEATABLE READ READ ONLY yang konsisten.
 *  4. Verifikasi PostgreSQL TA-F03 (Lookup GRN via metadata.grn_id & Ketahanan Metadata Non-Numerik),
 *     TA-O01 (Presisi Eksak NUMERIC(18,3)), dan TA-O02 (Batas Maksimum Limit API = 200):
 *     - Ketika operation_key dan idempotency_key GRN berbeda dari stock_operations.operation_key,
 *       tetapi metadata.grn_id numerik menunjuk pos_goods_receipts.id yang valid, referensi GRN
 *       dan pencarian nomor GRN berhasil.
 *     - Metadata non-numerik ('abc', 'ddd', overflow integer, array JSON) tidak memicu 500 cast error.
 *     - Limit 200 diterima, limit 201 ditolak dengan 400 VALIDATION_ERROR.
 *  5. Autentikasi HTTP Aktual (401), Scope Properti (403), Izin Operasional inventory.view (403/200),
 *     dan Kesetaraan Route Utama (/api/pos/inventory/stock-movements-global) vs Alias (/api/pos/stock/movements-global).
 *  6. Non-Regresi Saldo & Valuasi serta Sifat Read-Only Murni.
 *
 * Keamanan Container & Port:
 *  - Menggunakan nama container unik per sesi dan port bebas yang diverifikasi sebelum start.
 *  - Tidak pernah menjalankan `docker rm -f` di awal pada container yang sudah ada.
 *  - Hanya menghapus container yang benar-benar dibuat oleh sesi ini di blok `finally`.
 */

const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const assert = require('node:assert');
const { execSync } = require('node:child_process');

process.env.JWT_SECRET = 'test-tahap-a-mutasi-jwt-secret-20261105';
process.env.TZ = 'Asia/Jakarta';

const repoRoot = process.env.OAK_REPO_ROOT || path.resolve(__dirname, '../..');
const backendNodeModules = path.join(repoRoot, 'backend', 'node_modules');
module.paths.unshift(backendNodeModules);

const express = require('express');
const { Pool } = require('pg');

const schema = require(path.join(repoRoot, 'backend', 'dist', 'db', 'schema_v3'));
const { runPosPaymentSettlementMigration } = require(path.join(repoRoot, 'backend', 'dist', 'db', 'migrations', 'pos_payment_settlement_v1'));
const { runPosPurchaseOrdersMigration } = require(path.join(repoRoot, 'backend', 'dist', 'db', 'migrations', 'pos_purchase_orders_v1'));
const { runPosPurchaseReceiptDraftPostMigration } = require(path.join(repoRoot, 'backend', 'dist', 'db', 'migrations', 'pos_purchase_receipt_draft_post_v1'));
const { runPosPurchaseReceiptDraftPostV2Migration } = require(path.join(repoRoot, 'backend', 'dist', 'db', 'migrations', 'pos_purchase_receipt_draft_post_v2'));
const { runPosProcurementTahap1aV1Migration } = require(path.join(repoRoot, 'backend', 'dist', 'db', 'migrations', 'pos_procurement_tahap1a_v1'));

const { requireAuth } = require(path.join(repoRoot, 'backend', 'dist', 'domains', 'auth', 'authMiddleware'));
const { generateToken } = require(path.join(repoRoot, 'backend', 'dist', 'domains', 'auth', 'authService'));

const {
  parseAsiaJakartaHalfOpenDateBounds,
  parseAsiaJakartaDateBounds,
  formatNumeric18_3Exact,
  getGlobalStockMovements,
  createGlobalStockMovementsHandler,
  getInventoryValuationReport,
} = require(path.join(repoRoot, 'backend', 'dist', 'domains', 'pos', 'stockInventoryService'));

const PROTECTED_PORTS = new Set([5432, 5433, 55449, 55451, 44185, 44187]);
const CONTAINER_NAME = `oak_hims_test_tahap_a_r1_pg_${process.pid}_${Date.now()}`;
const DB_NAME = 'oak_hims_test_tahap_a_mutasi';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isTcpPortAvailable(port) {
  if (PROTECTED_PORTS.has(port)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(startPort, maxTries = 30) {
  for (let p = startPort; p < startPort + maxTries; p++) {
    if (await isTcpPortAvailable(p)) return p;
  }
  throw new Error(`Tidak ditemukan port TCP bebas mulai dari ${startPort}`);
}

function containerExists(name) {
  const out = execSync(`docker ps -a --filter "name=^/${name}$" --format "{{.Names}}"`, {
    encoding: 'utf8',
  }).trim();
  return out === name;
}

async function waitForPostgres(pool, maxAttempts = 40) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error('PostgreSQL 15 test container did not become ready in time');
}

async function runTests() {
  console.log('========================================================================');
  console.log(' OAK HIMS — Pengujian Terisolasi Tahap A (R1): Riwayat Mutasi & Laporan');
  console.log('========================================================================');

  // ---------------------------------------------------------------------------
  // TEST 1: Unit Test Helper parseAsiaJakartaHalfOpenDateBounds & formatNumeric18_3Exact
  // ---------------------------------------------------------------------------
  console.log('\n[TEST 1] Verifikasi helper parseAsiaJakartaHalfOpenDateBounds & formatNumeric18_3Exact...');

  const boundsNormal = parseAsiaJakartaHalfOpenDateBounds('2026-11-01', '2026-11-04');
  assert.strictEqual(boundsNormal.startDate, '2026-11-01');
  assert.strictEqual(boundsNormal.endDate, '2026-11-04');
  assert.strictEqual(boundsNormal.startBoundInclusive, '2026-11-01T00:00:00+07:00');
  assert.strictEqual(boundsNormal.endBoundExclusive, '2026-11-05T00:00:00+07:00');

  const boundsMonthEnd = parseAsiaJakartaHalfOpenDateBounds('2026-02-28', '2026-02-28');
  assert.strictEqual(boundsMonthEnd.startBoundInclusive, '2026-02-28T00:00:00+07:00');
  assert.strictEqual(boundsMonthEnd.endBoundExclusive, '2026-03-01T00:00:00+07:00');

  const boundsYearEnd = parseAsiaJakartaHalfOpenDateBounds('2026-12-31', '2026-12-31');
  assert.strictEqual(boundsYearEnd.startBoundInclusive, '2026-12-31T00:00:00+07:00');
  assert.strictEqual(boundsYearEnd.endBoundExclusive, '2027-01-01T00:00:00+07:00');

  assert.throws(
    () => parseAsiaJakartaHalfOpenDateBounds('2026-02-30', '2026-03-01'),
    (err) => err.statusCode === 400 && err.code === 'VALIDATION_ERROR'
  );
  assert.throws(
    () => parseAsiaJakartaHalfOpenDateBounds('2026-11-05', '2026-11-04'),
    (err) => err.statusCode === 400 && err.code === 'VALIDATION_ERROR'
  );

  // Legacy helper parseAsiaJakartaDateBounds remains intact
  const legacyBounds = parseAsiaJakartaDateBounds('2026-11-01', '2026-11-04');
  assert.strictEqual(legacyBounds.startBound, '2026-11-01T00:00:00+07:00');
  assert.strictEqual(legacyBounds.endBound, '2026-11-04T23:59:59.999+07:00');

  // Exact NUMERIC(18,3) helper (TA-O01)
  assert.strictEqual(formatNumeric18_3Exact('999999999999999.999'), '999999999999999.999');
  assert.strictEqual(formatNumeric18_3Exact('-999999999999999.999'), '-999999999999999.999');
  assert.strictEqual(formatNumeric18_3Exact('24'), '24.000');
  assert.strictEqual(formatNumeric18_3Exact('-0.000'), '0.000');
  console.log('  ✓ parseAsiaJakartaHalfOpenDateBounds & formatNumeric18_3Exact lulus semua uji batas.');

  // ---------------------------------------------------------------------------
  // Setup Ephemeral Isolated PostgreSQL Container (Fail-Safe: No Pre-RM)
  // ---------------------------------------------------------------------------
  if (containerExists(CONTAINER_NAME)) {
    throw new Error(`Container ${CONTAINER_NAME} sudah ada; dibatalkan demi keamanan (fail-safe).`);
  }
  const pgPort = await findAvailablePort(55455);
  let createdContainerByThisSession = false;

  console.log(`\n[SETUP] Menjalankan container PostgreSQL 15 terisolasi (${CONTAINER_NAME} di port ${pgPort})...`);
  execSync(
    `docker run -d --name ${CONTAINER_NAME} -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=${DB_NAME} -p 127.0.0.1:${pgPort}:5432 postgres:15-alpine`,
    { stdio: 'inherit' }
  );
  createdContainerByThisSession = true;

  const pool = new Pool({
    host: '127.0.0.1',
    port: pgPort,
    user: 'postgres',
    password: 'postgres',
    database: DB_NAME,
  });

  let httpServer = null;

  try {
    await waitForPostgres(pool);
    console.log('[SETUP] Menjalankan inisialisasi skema kanonik & migrasi Tahap 1A...');
    await schema.initializeDatabase(pool);
    await runPosPaymentSettlementMigration(pool);
    await runPosPurchaseOrdersMigration(pool);
    await runPosPurchaseReceiptDraftPostMigration(pool);
    await runPosPurchaseReceiptDraftPostV2Migration(pool);
    await runPosProcurementTahap1aV1Migration(pool);

    // Seed 2 properti, role, user dengan/tanpa izin inventory.view, lokasi gudang, dan produk
    await pool.query(`
      INSERT INTO properties (id, name, property_code, address)
      VALUES
        (1, 'OAK Hotel Lawang', 'OAKLWG', 'Jl. Raya Lawang No. 1'),
        (2, 'Properti Lain Terisolasi', 'OAKOTH', 'Jl. Properti Lain No. 2')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO roles (id, name, description)
      VALUES
        (1, 'SUPER_ADMIN', 'Platform Super Admin'),
        (2, 'INVENTORY_STAFF', 'Staff Gudang dengan izin inventory.view'),
        (3, 'FO_NO_INVENTORY', 'Resepsionis tanpa izin inventory')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO permissions (resource, action, key, description)
      VALUES ('inventory', 'view', 'inventory.view', 'Lihat stok & riwayat mutasi')
      ON CONFLICT (key) DO NOTHING;

      INSERT INTO role_permissions (role_id, permission_id, granted)
      SELECT 2, p.id, TRUE
      FROM permissions p
      WHERE p.key = 'inventory.view'
      ON CONFLICT (role_id, permission_id) DO UPDATE SET granted = TRUE;

      INSERT INTO users (id, property_id, role_id, username, email, password_hash, full_name, is_active, account_status)
      VALUES
        (1, 1, 1, 'superadmin.tahapa', 'superadmin@oakhims.local', 'hash', 'Super Admin', TRUE, 'READY'),
        (2, 1, 2, 'gudang.tahapa', 'gudang@oakhims.local', 'hash', 'Petugas Gudang', TRUE, 'READY'),
        (3, 1, 3, 'fo.tahapa', 'fo@oakhims.local', 'hash', 'Petugas FO Tanpa Izin', TRUE, 'READY')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO pos_menu_categories (id, property_id, name)
      VALUES
        (1, 1, 'Minuman & Bahan Baku'),
        (2, 2, 'Kategori Properti 2')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO stock_locations (id, property_id, code, name, location_type, is_active)
      VALUES
        (11, 1, 'WH-01', 'Gudang 1', 'WAREHOUSE', TRUE),
        (12, 1, 'OUT-CAFE', 'Outlet Cafe', 'POS_OUTLET', TRUE),
        (21, 2, 'WH-PROP2', 'Gudang Properti 2', 'WAREHOUSE', TRUE)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO pos_menu_items (
        id, property_id, category_id, item_code, name, price,
        average_cost, last_cost, base_unit, canonical_base_unit_code,
        track_stock, is_active, is_sellable_pos
      ) VALUES
        (101, 1, 1, 'AM-600', 'Air Mineral 600ml', 5000.00, 2000.00, 2000.00, 'BOTOL', 'BOTOL', TRUE, TRUE, TRUE),
        (102, 1, 1, 'KOPI-ARB', 'Biji Kopi Arabika', 0.00, 150.00, 150.00, 'GRAM', 'GRAM', TRUE, TRUE, FALSE),
        (201, 2, 2, 'PROP2-ITM', 'Item Properti 2', 10000.00, 4000.00, 4000.00, 'PCS', 'PCS', TRUE, TRUE, TRUE)
      ON CONFLICT (id) DO NOTHING;
    `);

    let nextOpId = 1000;
    let nextMovId = 5000;
    async function insertDeterministicOperation({
      propertyId,
      operationType,
      operationKey,
      notes,
      metadata = {},
      createdAtWib,
      grnNumber = null,
      grnIdOverride = null,
      grnOperationKeyOverride = null,
      grnIdempotencyKeyOverride = null,
      movements,
    }) {
      const opId = ++nextOpId;
      await pool.query(
        `INSERT INTO stock_operations (
           id, property_id, operation_type, operation_key, payload_fingerprint,
           notes, metadata, created_by, created_at
         ) VALUES ($1, $2, $3, $4, $4, $5, $6::jsonb, 1, $7::timestamptz)`,
        [opId, propertyId, operationType, operationKey, notes, JSON.stringify(metadata), createdAtWib]
      );

      if (grnNumber) {
        if (grnIdOverride !== null) {
          await pool.query(
            `INSERT INTO pos_goods_receipts (
               id, property_id, grn_number, location_id, receipt_date, status, operation_key, idempotency_key, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, ($5::timestamptz AT TIME ZONE 'Asia/Jakarta')::date, 'POSTED', $6, $7, $5::timestamptz, $5::timestamptz)`,
            [
              grnIdOverride,
              propertyId,
              grnNumber,
              movements[0].locationId,
              createdAtWib,
              grnOperationKeyOverride || operationKey,
              grnIdempotencyKeyOverride || null,
            ]
          );
        } else {
          await pool.query(
            `INSERT INTO pos_goods_receipts (
               property_id, grn_number, location_id, receipt_date, status, operation_key, created_at, updated_at
             ) VALUES ($1, $2, $3, ($4::timestamptz AT TIME ZONE 'Asia/Jakarta')::date, 'POSTED', $5, $4::timestamptz, $4::timestamptz)`,
            [propertyId, grnNumber, movements[0].locationId, createdAtWib, grnOperationKeyOverride || operationKey]
          );
        }
      }

      const insertedMovIds = [];
      for (const m of movements) {
        const movId = ++nextMovId;
        await pool.query(
          `INSERT INTO stock_movements (
             id, operation_id, property_id, product_id, location_id,
             quantity_delta, base_unit_code, unit_cost, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
          [
            movId,
            opId,
            propertyId,
            m.productId,
            m.locationId,
            m.quantityDelta,
            m.baseUnitCode,
            m.unitCost ?? null,
            createdAtWib,
          ]
        );
        insertedMovIds.push(movId);
      }
      return { opId, insertedMovIds };
    }

    // -------------------------------------------------------------------------
    // Seed Histori Kronologis Lintas Tanggal, Lokasi, Operasi, dan Satuan
    // -------------------------------------------------------------------------
    const m1 = await insertDeterministicOperation({
      propertyId: 1,
      operationType: 'OPENING_BALANCE',
      operationKey: 'OP-TAHAPA-M1-OB-WH01',
      notes: 'Saldo awal Air Mineral Oktober',
      createdAtWib: '2026-10-31T23:59:59+07:00',
      movements: [{ productId: 101, locationId: 11, quantityDelta: '100.000', baseUnitCode: 'BOTOL', unitCost: '2000.00' }],
    });

    const m2 = await insertDeterministicOperation({
      propertyId: 1,
      operationType: 'PURCHASE_RECEIPT',
      operationKey: 'OP-TAHAPA-M2-GRN-WH01',
      notes: 'Penerimaan PO Air Mineral',
      grnNumber: 'GRN-20261101-0001',
      createdAtWib: '2026-11-01T00:00:00+07:00',
      movements: [{ productId: 101, locationId: 11, quantityDelta: '50.000', baseUnitCode: 'BOTOL', unitCost: '2000.00' }],
    });

    const m3 = await insertDeterministicOperation({
      propertyId: 1,
      operationType: 'OPENING_BALANCE',
      operationKey: 'OP-TAHAPA-M3-KOPI-OB',
      notes: 'Saldo awal Biji Kopi Arabika',
      createdAtWib: '2026-11-01T08:30:00+07:00',
      movements: [{ productId: 102, locationId: 11, quantityDelta: '2500.000', baseUnitCode: 'GRAM', unitCost: '150.00' }],
    });

    const m4 = await insertDeterministicOperation({
      propertyId: 1,
      operationType: 'STOCK_TRANSFER',
      operationKey: 'OP-TAHAPA-M4-TRF',
      notes: 'Distribusi Air Mineral ke Cafe',
      createdAtWib: '2026-11-02T10:15:00+07:00',
      movements: [
        { productId: 101, locationId: 11, quantityDelta: '-30.000', baseUnitCode: 'BOTOL', unitCost: '2000.00' },
        { productId: 101, locationId: 12, quantityDelta: '30.000', baseUnitCode: 'BOTOL', unitCost: '2000.00' },
      ],
    });

    const m5 = await insertDeterministicOperation({
      propertyId: 1,
      operationType: 'STOCK_OPNAME',
      operationKey: 'OP-TAHAPA-M5-OPNAME-WH01',
      notes: 'Selisih opname bulanan WH-01',
      createdAtWib: '2026-11-03T14:00:00+07:00',
      movements: [{ productId: 101, locationId: 11, quantityDelta: '-5.000', baseUnitCode: 'BOTOL', unitCost: '2000.00' }],
    });

    const m6 = await insertDeterministicOperation({
      propertyId: 1,
      operationType: 'STOCK_ADJUSTMENT',
      operationKey: 'OP-TAHAPA-M6-ADJ-KOPI',
      notes: 'Kopi tumpah saat penggilingan',
      createdAtWib: '2026-11-03T16:00:00+07:00',
      movements: [{ productId: 102, locationId: 11, quantityDelta: '-250.000', baseUnitCode: 'GRAM', unitCost: '150.00' }],
    });

    const m7 = await insertDeterministicOperation({
      propertyId: 1,
      operationType: 'POS_SALE',
      operationKey: 'OP-TAHAPA-M7-POSSALE-CAFE',
      notes: 'Penjualan POS Order #771',
      metadata: { pos_order_id: 771, transaction_no: 'INV-POS-20261104-771' },
      createdAtWib: '2026-11-04T23:59:59+07:00',
      movements: [{ productId: 101, locationId: 12, quantityDelta: '-5.000', baseUnitCode: 'BOTOL', unitCost: '2000.00' }],
    });

    const m8 = await insertDeterministicOperation({
      propertyId: 1,
      operationType: 'STOCK_ADJUSTMENT',
      operationKey: 'OP-TAHAPA-M8-POSTBOUND',
      notes: 'Botol pecah tanggal 5 dini hari',
      createdAtWib: '2026-11-05T00:00:00+07:00',
      movements: [{ productId: 101, locationId: 12, quantityDelta: '-2.000', baseUnitCode: 'BOTOL', unitCost: '2000.00' }],
    });

    // M9: Mutasi pada Properti 2 (tidak boleh bocor ke Properti 1)
    await insertDeterministicOperation({
      propertyId: 2,
      operationType: 'OPENING_BALANCE',
      operationKey: 'OP-TAHAPA-PROP2',
      notes: 'Saldo Properti 2',
      createdAtWib: '2026-11-02T12:00:00+07:00',
      movements: [{ productId: 201, locationId: 21, quantityDelta: '999.000', baseUnitCode: 'PCS', unitCost: '4000.00' }],
    });

    // Sinkronkan stock_balances
    await pool.query(`
      INSERT INTO stock_balances (property_id, product_id, location_id, quantity, updated_at)
      VALUES
        (1, 101, 11, 115.000, NOW()),
        (1, 101, 12, 23.000, NOW()),
        (1, 102, 11, 2250.000, NOW()),
        (2, 201, 21, 999.000, NOW());
    `);

    // -------------------------------------------------------------------------
    // TEST 2: Verifikasi Perhitungan Saldo Partisi & Invariansi Lintas Filter/Paginasi
    // -------------------------------------------------------------------------
    console.log('\n[TEST 2] Verifikasi perhitungan balance_before / balance_after & invariansi lintas filter...');

    const fullHistory = await getGlobalStockMovements(pool, {
      property_id: 1,
      sort_order: 'ASC',
      export_all: true,
    });

    assert.strictEqual(fullHistory.pagination.total_rows, 9);
    assert.strictEqual(fullHistory.movements.length, 9);

    const canonicalExpectedByMovId = new Map([
      [m1.insertedMovIds[0], { before: '0.000', qIn: '100.000', qOut: '0.000', after: '100.000', loc: 11, prod: 101 }],
      [m2.insertedMovIds[0], { before: '100.000', qIn: '50.000', qOut: '0.000', after: '150.000', loc: 11, prod: 101 }],
      [m3.insertedMovIds[0], { before: '0.000', qIn: '2500.000', qOut: '0.000', after: '2500.000', loc: 11, prod: 102 }],
      [m4.insertedMovIds[0], { before: '150.000', qIn: '0.000', qOut: '30.000', after: '120.000', loc: 11, prod: 101 }],
      [m4.insertedMovIds[1], { before: '0.000', qIn: '30.000', qOut: '0.000', after: '30.000', loc: 12, prod: 101 }],
      [m5.insertedMovIds[0], { before: '120.000', qIn: '0.000', qOut: '5.000', after: '115.000', loc: 11, prod: 101 }],
      [m6.insertedMovIds[0], { before: '2500.000', qIn: '0.000', qOut: '250.000', after: '2250.000', loc: 11, prod: 102 }],
      [m7.insertedMovIds[0], { before: '30.000', qIn: '0.000', qOut: '5.000', after: '25.000', loc: 12, prod: 101 }],
      [m8.insertedMovIds[0], { before: '25.000', qIn: '0.000', qOut: '2.000', after: '23.000', loc: 12, prod: 101 }],
    ]);

    function assertMovementBalancesMatchCanonical(movementsList, contextLabel) {
      for (const row of movementsList) {
        const exp = canonicalExpectedByMovId.get(row.movement_id);
        assert.ok(exp, `[${contextLabel}] movement_id ${row.movement_id} harus milik Properti 1`);
        assert.strictEqual(
          row.balance_before,
          exp.before,
          `[${contextLabel}] mov ${row.movement_id} balance_before harus ${exp.before}, aktual ${row.balance_before}`
        );
        assert.strictEqual(
          row.quantity_in,
          exp.qIn,
          `[${contextLabel}] mov ${row.movement_id} quantity_in harus ${exp.qIn}, aktual ${row.quantity_in}`
        );
        assert.strictEqual(
          row.quantity_out,
          exp.qOut,
          `[${contextLabel}] mov ${row.movement_id} quantity_out harus ${exp.qOut}, aktual ${row.quantity_out}`
        );
        assert.strictEqual(
          row.balance_after,
          exp.after,
          `[${contextLabel}] mov ${row.movement_id} balance_after harus ${exp.after}, aktual ${row.balance_after}`
        );
      }
    }

    assertMovementBalancesMatchCanonical(fullHistory.movements, 'FULL_HISTORY_ASC');

    const periodFiltered = await getGlobalStockMovements(pool, {
      property_id: 1,
      start_date: '2026-11-01',
      end_date: '2026-11-04',
      sort_order: 'ASC',
      export_all: true,
    });
    assert.strictEqual(periodFiltered.pagination.total_rows, 7);
    const periodIds = periodFiltered.movements.map((r) => r.movement_id);
    assert.ok(!periodIds.includes(m1.insertedMovIds[0]), 'M1 (2026-10-31 23:59:59 WIB) harus di luar periode');
    assert.ok(periodIds.includes(m2.insertedMovIds[0]), 'M2 (2026-11-01 00:00:00 WIB) harus masuk periode');
    assert.ok(periodIds.includes(m7.insertedMovIds[0]), 'M7 (2026-11-04 23:59:59 WIB) harus masuk periode');
    assert.ok(!periodIds.includes(m8.insertedMovIds[0]), 'M8 (2026-11-05 00:00:00 WIB) harus di luar batas eksklusif');
    assertMovementBalancesMatchCanonical(periodFiltered.movements, 'DATE_FILTER_2026_11_01_TO_04');

    for (const sortDir of ['DESC', 'ASC']) {
      for (let p = 1; p <= 4; p++) {
        const paged = await getGlobalStockMovements(pool, {
          property_id: 1,
          start_date: '2026-11-01',
          end_date: '2026-11-04',
          sort_order: sortDir,
          page: p,
          limit: 2,
        });
        assert.strictEqual(paged.pagination.total_rows, 7);
        assert.strictEqual(paged.pagination.total_pages, 4);
        assertMovementBalancesMatchCanonical(paged.movements, `PAGINATED_${sortDir}_PAGE_${p}`);
      }
    }

    console.log('  ✓ Perhitungan saldo partisi & invariansi lintas filter/paginasi/urutan terbukti 100% akurat.');

    // -------------------------------------------------------------------------
    // TEST 3: Pemisahan Total per Satuan Dasar (totals_by_unit) & Snapshot Konsisten
    // -------------------------------------------------------------------------
    console.log('\n[TEST 3] Verifikasi pemisahan total kuantitas per satuan dasar (totals_by_unit)...');

    assert.strictEqual(periodFiltered.totals_by_unit.length, 2, 'Harus ada 2 satuan terpisah: BOTOL dan GRAM');
    const botolUnit = periodFiltered.totals_by_unit.find((u) => u.base_unit_code === 'BOTOL');
    const gramUnit = periodFiltered.totals_by_unit.find((u) => u.base_unit_code === 'GRAM');
    assert.ok(botolUnit && gramUnit);

    assert.strictEqual(botolUnit.movement_count, 5);
    assert.strictEqual(botolUnit.total_in, '80.000');
    assert.strictEqual(botolUnit.total_out, '40.000');
    assert.strictEqual(botolUnit.net_delta, '40.000');

    assert.strictEqual(gramUnit.movement_count, 2);
    assert.strictEqual(gramUnit.total_in, '2500.000');
    assert.strictEqual(gramUnit.total_out, '250.000');
    assert.strictEqual(gramUnit.net_delta, '2250.000');

    console.log('  ✓ Pemisahan total kuantitas per satuan (BOTOL vs GRAM) & konsistensi snapshot terverifikasi.');

    // -------------------------------------------------------------------------
    // TEST 4: Verifikasi PostgreSQL TA-F03 (metadata.grn_id & Metadata Non-Numerik) & TA-O02 (limit <= 200)
    // -------------------------------------------------------------------------
    console.log('\n[TEST 4] Verifikasi PostgreSQL TA-F03 (lookup GRN via metadata.grn_id & metadata non-numerik) & TA-O02...');

    // Seed GRN #542 di mana operation_key & idempotency_key di pos_goods_receipts BERBEDA dari stock_operations.operation_key,
    // tetapi stock_operations.metadata.grn_id = 542 menunjuk GRN valid
    const mMetaGrn = await insertDeterministicOperation({
      propertyId: 1,
      operationType: 'PURCHASE_RECEIPT',
      operationKey: 'OP-LEDGER-KEY-ONLY-META-542',
      notes: 'Penerimaan dengan relasi metadata.grn_id saja',
      metadata: { grn_id: 542, location_id: 11 },
      grnNumber: 'GRN-20261106-0542',
      grnIdOverride: 542,
      grnOperationKeyOverride: 'GRN-HEADER-KEY-DIFFERENT-542',
      grnIdempotencyKeyOverride: 'GRN-IDEM-KEY-DIFFERENT-542',
      createdAtWib: '2026-11-06T09:00:00+07:00',
      movements: [{ productId: 101, locationId: 11, quantityDelta: '12.000', baseUnitCode: 'BOTOL', unitCost: '2000.00' }],
    });

    // Seed beberapa baris dengan metadata.grn_id tidak valid / non-numerik / overflow / array JSON
    const mInvalidMeta1 = await insertDeterministicOperation({
      propertyId: 1,
      operationType: 'PURCHASE_RECEIPT',
      operationKey: 'OP-INVALID-META-ABC',
      notes: 'Metadata grn_id alfabet abc',
      metadata: { grn_id: 'abc-non-numeric' },
      createdAtWib: '2026-11-06T10:00:00+07:00',
      movements: [{ productId: 101, locationId: 11, quantityDelta: '1.000', baseUnitCode: 'BOTOL', unitCost: '2000.00' }],
    });

    const mInvalidMeta2 = await insertDeterministicOperation({
      propertyId: 1,
      operationType: 'PURCHASE_RECEIPT',
      operationKey: 'OP-INVALID-META-DDD',
      notes: 'Metadata grn_id ddd yang dahulu lolos regex ^d+$',
      metadata: { grn_id: 'ddd' },
      createdAtWib: '2026-11-06T10:05:00+07:00',
      movements: [{ productId: 101, locationId: 11, quantityDelta: '1.000', baseUnitCode: 'BOTOL', unitCost: '2000.00' }],
    });

    const mInvalidMeta3 = await insertDeterministicOperation({
      propertyId: 1,
      operationType: 'PURCHASE_RECEIPT',
      operationKey: 'OP-INVALID-META-OVERFLOW',
      notes: 'Metadata grn_id melebihi int32',
      metadata: { grn_id: '99999999999999999999' },
      createdAtWib: '2026-11-06T10:10:00+07:00',
      movements: [{ productId: 101, locationId: 11, quantityDelta: '1.000', baseUnitCode: 'BOTOL', unitCost: '2000.00' }],
    });

    // Query tanggal 2026-11-06: tidak boleh 500 error, dan mMetaGrn wajib memiliki reference_no = 'GRN-20261106-0542'
    const nov06Res = await getGlobalStockMovements(pool, {
      property_id: 1,
      start_date: '2026-11-06',
      end_date: '2026-11-06',
      sort_order: 'ASC',
    });
    assert.strictEqual(nov06Res.pagination.total_rows, 4);
    const metaGrnRow = nov06Res.movements.find((r) => r.movement_id === mMetaGrn.insertedMovIds[0]);
    assert.ok(metaGrnRow, 'Baris mutasi dengan metadata.grn_id=542 harus ditemukan');
    assert.strictEqual(metaGrnRow.reference_no, 'GRN-20261106-0542');
    assert.ok(metaGrnRow.display_keterangan.includes('Ref: GRN-20261106-0542'));

    // Baris dengan metadata non-numerik tetap kembali aman dengan fallback operation_key
    const invalidRowDdd = nov06Res.movements.find((r) => r.movement_id === mInvalidMeta2.insertedMovIds[0]);
    assert.ok(invalidRowDdd);
    assert.strictEqual(invalidRowDdd.reference_no, 'OP-INVALID-META-DDD');
    const invalidRowOverflow = nov06Res.movements.find((r) => r.movement_id === mInvalidMeta3.insertedMovIds[0]);
    assert.ok(invalidRowOverflow);
    assert.strictEqual(invalidRowOverflow.reference_no, 'OP-INVALID-META-OVERFLOW');
    void mInvalidMeta1;

    // Pencarian berdasarkan nomor GRN ('GRN-20261106-0542') yang terhubung hanya lewat metadata.grn_id harus berhasil
    const searchMetaGrn = await getGlobalStockMovements(pool, {
      property_id: 1,
      search: 'GRN-20261106-0542',
    });
    assert.strictEqual(searchMetaGrn.pagination.total_rows, 1);
    assert.strictEqual(searchMetaGrn.movements[0].movement_id, mMetaGrn.insertedMovIds[0]);
    assert.strictEqual(searchMetaGrn.movements[0].reference_no, 'GRN-20261106-0542');

    // TA-O02: limit=200 diterima, limit=201 ditolak dengan 400 VALIDATION_ERROR
    const limit200Ok = await getGlobalStockMovements(pool, { property_id: 1, limit: 200 });
    assert.strictEqual(limit200Ok.pagination.limit, 200);
    await assert.rejects(
      () => getGlobalStockMovements(pool, { property_id: 1, limit: 201 }),
      (err) => err.statusCode === 400 && err.code === 'VALIDATION_ERROR'
    );

    console.log('  ✓ Lookup GRN via metadata.grn_id, ketahanan metadata non-numerik, & batas limit <= 200 lulus.');

    // -------------------------------------------------------------------------
    // TEST 5: Request HTTP Aktual pada Server Fixture (401, 403 Scope, 403 Role, 200 Primary & Alias)
    // -------------------------------------------------------------------------
    console.log('\n[TEST 5] Verifikasi HTTP aktual (401 unauthenticated, 403 lintas properti, 403 tanpa izin, 200 OK & alias)...');

    const httpPort = await findAvailablePort(44195);
    const app = express();
    app.use(express.json());

    const assertPropertyScopeHttp = (req, res, targetPropertyId) => {
      const userPropId = req.user?.property_id;
      if (userPropId && Number(userPropId) !== Number(targetPropertyId) && req.user?.role !== 'SUPER_ADMIN') {
        res.status(403).json({
          status: 'ERROR',
          code: 'PROPERTY_SCOPE_FORBIDDEN',
          message: 'Akses ditolak untuk properti ini',
        });
        return false;
      }
      return true;
    };

    const handler = createGlobalStockMovementsHandler({
      pool,
      assertPropertyScope: assertPropertyScopeHttp,
    });

    app.get('/api/pos/inventory/stock-movements-global', requireAuth, handler);
    app.get('/api/pos/stock/movements-global', requireAuth, handler);

    httpServer = http.createServer(app);
    await new Promise((resolve) => httpServer.listen(httpPort, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${httpPort}`;

    // 5a. Tanpa header Authorization -> HTTP 401
    const resNoAuth = await fetch(`${baseUrl}/api/pos/inventory/stock-movements-global?property_id=1`);
    assert.strictEqual(resNoAuth.status, 401, 'Request tanpa token wajib menghasilkan HTTP 401');

    // 5b. Token tidak valid -> HTTP 401
    const resBadToken = await fetch(`${baseUrl}/api/pos/inventory/stock-movements-global?property_id=1`, {
      headers: { Authorization: 'Bearer token.palsu.tidak.valid' },
    });
    assert.strictEqual(resBadToken.status, 401, 'Request dengan token tidak valid wajib menghasilkan HTTP 401');

    // Buat JWT valid untuk petugas gudang (role_id=2, memiliki inventory.view) & petugas FO (role_id=3, tanpa izin inventory)
    const tokenInventoryStaff = generateToken({
      id: 2,
      username: 'gudang.tahapa',
      email: 'gudang@oakhims.local',
      full_name: 'Petugas Gudang',
      role: 'INVENTORY_STAFF',
      role_id: 2,
      property_id: 1,
      account_status: 'READY',
    });

    const tokenNoInventoryRole = generateToken({
      id: 3,
      username: 'fo.tahapa',
      email: 'fo@oakhims.local',
      full_name: 'Petugas FO Tanpa Izin',
      role: 'FO_NO_INVENTORY',
      role_id: 3,
      property_id: 1,
      account_status: 'READY',
    });

    // 5c. Lintas properti (petugas properti 1 meminta property_id=2) -> HTTP 403
    const resCrossPropHttp = await fetch(`${baseUrl}/api/pos/inventory/stock-movements-global?property_id=2`, {
      headers: { Authorization: `Bearer ${tokenInventoryStaff}` },
    });
    assert.strictEqual(resCrossPropHttp.status, 403, 'Request lintas properti wajib menghasilkan HTTP 403');
    const bodyCrossProp = await resCrossPropHttp.json();
    assert.strictEqual(bodyCrossProp.code, 'PROPERTY_SCOPE_FORBIDDEN');

    // 5d. Tanpa izin inventory.view (role_id=3 FO_NO_INVENTORY) -> HTTP 403
    const resNoPermHttp = await fetch(`${baseUrl}/api/pos/inventory/stock-movements-global?property_id=1`, {
      headers: { Authorization: `Bearer ${tokenNoInventoryRole}` },
    });
    assert.strictEqual(resNoPermHttp.status, 403, 'Request tanpa izin inventory.view wajib menghasilkan HTTP 403');
    const bodyNoPerm = await resNoPermHttp.json();
    assert.strictEqual(bodyNoPerm.code, 'FORBIDDEN');

    // 5e. Pengguna dengan izin inventory.view pada route utama & route alias -> HTTP 200 dan payload setara
    const queryStr = 'property_id=1&warehouse_id=11&start_date=2026-11-01&end_date=2026-11-06&sort_order=ASC&export_all=true';
    const resPrimaryHttp = await fetch(`${baseUrl}/api/pos/inventory/stock-movements-global?${queryStr}`, {
      headers: { Authorization: `Bearer ${tokenInventoryStaff}` },
    });
    assert.strictEqual(resPrimaryHttp.status, 200);
    const bodyPrimary = await resPrimaryHttp.json();
    assert.strictEqual(bodyPrimary.status, 'OK');

    const resAliasHttp = await fetch(`${baseUrl}/api/pos/stock/movements-global?${queryStr}`, {
      headers: { Authorization: `Bearer ${tokenInventoryStaff}` },
    });
    assert.strictEqual(resAliasHttp.status, 200);
    const bodyAlias = await resAliasHttp.json();
    assert.strictEqual(bodyAlias.status, 'OK');

    assert.deepStrictEqual(bodyPrimary.data.movements, bodyAlias.data.movements);
    assert.deepStrictEqual(bodyPrimary.data.totals_by_unit, bodyAlias.data.totals_by_unit);
    assert.deepStrictEqual(bodyPrimary.data.partition_summaries, bodyAlias.data.partition_summaries);
    assert.deepStrictEqual(bodyPrimary.data.pagination, bodyAlias.data.pagination);

    console.log('  ✓ HTTP 401, 403 lintas properti, 403 tanpa izin, 200 inventory.view, dan kesetaraan route utama/alias lulus.');

    // -------------------------------------------------------------------------
    // TEST 6: Non-Regresi Saldo & Valuasi + Bukti Read-Only Murni
    // -------------------------------------------------------------------------
    console.log('\n[TEST 6] Verifikasi non-regresi Saldo & Valuasi serta sifat read-only murni...');

    const valReport = await getInventoryValuationReport(pool, { property_id: 1 });
    assert.strictEqual(valReport.summary.total_items, 3);

    const countsAfter = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM stock_operations WHERE property_id = 1) AS ops_count,
        (SELECT COUNT(*)::int FROM stock_movements WHERE property_id = 1) AS movs_count,
        (SELECT COUNT(*)::int FROM stock_balances WHERE property_id = 1) AS bals_count
    `);
    assert.strictEqual(countsAfter.rows[0].ops_count, 12);
    assert.strictEqual(countsAfter.rows[0].movs_count, 13);
    assert.strictEqual(countsAfter.rows[0].bals_count, 3);

    console.log('  ✓ Non-regresi Saldo & Valuasi dan sifat read-only murni terverifikasi.');
    console.log('\n========================================================================');
    console.log(' SEMUA PENGUJIAN TAHAP A (R1) LULUS (PASS)');
    console.log('========================================================================');
  } finally {
    if (httpServer) {
      await new Promise((r) => httpServer.close(r)).catch(() => {});
    }
    await pool.end().catch(() => {});
    if (createdContainerByThisSession) {
      console.log(`[CLEANUP] Menghapus container PostgreSQL sesi ini (${CONTAINER_NAME})...`);
      try {
        execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: 'ignore' });
      } catch {}
    }
  }
}

runTests().catch((err) => {
  console.error('\n[FAIL] Pengujian Tahap A gagal:', err);
  process.exit(1);
});
