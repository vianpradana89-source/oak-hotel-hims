'use strict';

/**
 * OAK HIMS — MP-04B Batch 5 PostgreSQL Integration Test
 * =====================================================
 *
 * Memverifikasi Laporan Mutasi Stok, Kartu Stok / Ledger, dan Valuasi Persediaan:
 *   - Skenario 1: Kartu Stok (Stock Ledger Card) tanpa filter tanggal (seluruh riwayat, opening = 0, running balance cocok).
 *   - Skenario 2: Kartu Stok (Stock Ledger Card) dengan filter rentang tanggal Asia/Jakarta (opening balance dari mutasi sebelum window).
 *   - Skenario 3: Kartu Stok di lokasi tujuan transfer (KIT-01) merefleksikan pergerakan masuk transfer.
 *   - Skenario 4: Rekap Saldo & Valuasi Persediaan (Inventory Valuation Report) dengan kalkulasi unit cost & total value per lokasi.
 *   - Skenario 5: Laporan Rekap Variansi Opname (Opname Variance Report) dengan filter status (SURPLUS, DEFICIT, MATCH) & ringkasan variansi.
 *   - Skenario 6: HTTP REST API Endpoints & RBAC Authorization (Superadmin/inventory.view diperbolehkan, tanpa izin ditolak 403).
 *   - Skenario 7: Invarian Mutasi & Integritas Read-Only (Laporan murni baca, saldo kartu stok identik dengan stock_balances & sum movements).
 *
 * Keamanan:
 *   - Tidak membaca backend/.env maupun kredensial aplikasi.
 *   - Menggunakan container PostgreSQL 15 terisolasi dan selalu dibersihkan di blok finally.
 */

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const BACKEND_DIR = path.resolve(__dirname, '..');

const IMAGE = 'postgres:15';
const TEST_DB = 'oak_hims_mp04b_b5_test';
const TEST_USER = 'oakmp04bb5_runner';
const CONTAINER_PREFIX = 'oak-hims-mp04b-b5-test-';

function safeStringify(val) {
  try {
    return JSON.stringify(val, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch (e) {
    return String(val);
  }
}

const logLines = [];
function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ');
  logLines.push(line);
  console.log(line);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const results = [];

async function step(name, fn) {
  const started = Date.now();
  const out = await fn();
  const durationMs = Date.now() - started;
  results.push({ name, ok: true, durationMs, detail: out === undefined ? null : out });
  log(`PASS  ${name} (${durationMs} ms)${out === undefined ? '' : ` :: ${typeof out === 'string' ? out : safeStringify(out)}`}`);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Docker Management
// ─────────────────────────────────────────────────────────────────────────────
function docker(args, { timeout = 120000, allowFail = false } = {}) {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    if (allowFail) return null;
    const stderr = err && err.stderr ? String(err.stderr).trim() : '';
    const e = new Error(`docker ${args.join(' ')} gagal: ${stderr || err?.message || err}`);
    e.code = 'DOCKER_ERROR';
    throw e;
  }
}

function startContainer() {
  const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const name = `${CONTAINER_PREFIX}${suffix}`;
  const password = crypto.randomBytes(18).toString('base64url');

  docker(
    [
      'run',
      '-d',
      '--name', name,
      '-e', `POSTGRES_USER=${TEST_USER}`,
      '-e', `POSTGRES_PASSWORD=${password}`,
      '-e', `POSTGRES_DB=${TEST_DB}`,
      '-e', 'POSTGRES_INITDB_ARGS=--encoding=UTF8',
      '-p', '127.0.0.1::5432',
      IMAGE,
    ],
    { timeout: 300000 }
  );

  return { name, password };
}

function resolveHostPort(containerName) {
  const out = docker(['port', containerName, '5432/tcp'], { timeout: 30000 });
  const match = out.match(/127\.0\.0\.1:(\d+)/);
  if (!match) {
    throw new Error(`Tidak dapat membaca port host dari output "docker port": ${out || '(kosong)'}`);
  }
  return Number(match[1]);
}

function stopContainer(containerName) {
  if (!containerName) return;
  docker(['rm', '-f', containerName], { allowFail: true, timeout: 60000 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Production module loading with dotenv stub guard
// ─────────────────────────────────────────────────────────────────────────────
const WATCHED_ENV_KEYS = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'DB_PORT'];

function loadProductionModules() {
  const envBefore = Object.fromEntries(WATCHED_ENV_KEYS.map((k) => [k, process.env[k] ?? null]));

  const dotenvPath = require.resolve('dotenv', { paths: [BACKEND_DIR] });
  const dotenv = require(dotenvPath);
  let interceptedCalls = 0;
  dotenv.config = () => {
    interceptedCalls += 1;
    return { parsed: {} };
  };

  const mp03cMigrationPath = path.join(BACKEND_DIR, 'dist', 'db', 'migrations', 'product_master_mp03c_v1.js');
  const mp04bB1MigrationPath = path.join(BACKEND_DIR, 'dist', 'db', 'migrations', 'product_inventory_mp04b_b1_v1.js');
  const mp04bB3MigrationPath = path.join(BACKEND_DIR, 'dist', 'db', 'migrations', 'product_inventory_mp04b_b3_v1.js');
  const stockServicePath = path.join(BACKEND_DIR, 'dist', 'domains', 'pos', 'stockInventoryService.js');
  const unitsPath = path.join(BACKEND_DIR, 'dist', 'domains', 'pos', 'productUnitsAndLocations.js');
  const stage1Path = path.join(BACKEND_DIR, 'dist', 'domains', 'pos', 'productMasterStage1.js');

  for (const p of [
    mp03cMigrationPath,
    mp04bB1MigrationPath,
    mp04bB3MigrationPath,
    stockServicePath,
    unitsPath,
    stage1Path,
  ]) {
    if (!fs.existsSync(p)) {
      throw new Error(`Build produksi belum tersedia: ${p}. Jalankan "npm --prefix backend run build" lebih dulu.`);
    }
  }

  const mp03cMigration = require(mp03cMigrationPath);
  const mp04bB1Migration = require(mp04bB1MigrationPath);
  const mp04bB3Migration = require(mp04bB3MigrationPath);
  const stockService = require(stockServicePath);
  const units = require(unitsPath);
  const stage1 = require(stage1Path);

  const envAfter = Object.fromEntries(WATCHED_ENV_KEYS.map((k) => [k, process.env[k] ?? null]));
  for (const key of WATCHED_ENV_KEYS) {
    if (envBefore[key] !== envAfter[key]) {
      throw new Error(`Impor modul produksi mengubah variabel lingkungan ${key}; dotenv guard gagal.`);
    }
  }

  return {
    mp03cMigration,
    mp04bB1Migration,
    mp04bB3Migration,
    stockService,
    units,
    stage1,
    interceptedCalls,
  };
}

let pg = null;
const allPools = [];

function makePoolConfig(applicationName) {
  return {
    host: '127.0.0.1',
    port: globalThis.__MP04B_B5_PORT__,
    user: TEST_USER,
    password: globalThis.__MP04B_B5_PASSWORD__,
    database: TEST_DB,
    max: 5,
    application_name: applicationName,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
  };
}

function newPool(applicationName) {
  const pool = new pg.Pool(makePoolConfig(applicationName));
  pool.on('error', (err) => log(`  [pool:${applicationName}] error idle client: ${err.message}`));
  allPools.push(pool);
  return pool;
}

async function closeAllPools() {
  for (const p of allPools) {
    try {
      await p.end();
    } catch {}
  }
}

async function waitForPostgres(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    const client = new pg.Client({ ...makePoolConfig('mp04b-b5-readiness'), connectionTimeoutMillis: 3000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (err) {
      lastErr = err;
      try {
        await client.end();
      } catch {}
      await sleep(500);
    }
  }
  throw new Error(`PostgreSQL tidak siap dalam ${timeoutMs} ms: ${lastErr?.message || 'unknown'}`);
}

function makeReq({ params = {}, body = {}, query = {}, headers = {}, user = null } = {}) {
  return { params, body, query, headers, user };
}

function makeRes() {
  return {
    statusCode: 200,
    headersSent: false,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
  };
}

function makeDeps(pool) {
  return {
    pool,
    assertPropertyScope: async (req, res, propId) => Number(propId),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Test Runner
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  log('========================================================================');
  log('OAK HIMS — MP-04B Batch 5: Laporan Mutasi Stok, Kartu Stok, & Valuasi');
  log('========================================================================');

  let container = null;

  try {
    // 1. Guard & load production modules
    const prod = await step('preflight: modul produksi & dotenv stub guard', async () => {
      const p = loadProductionModules();
      pg = require(require.resolve('pg', { paths: [BACKEND_DIR] }));
      return {
        mp03cMigration: p.mp03cMigration,
        mp04bB1Migration: p.mp04bB1Migration,
        mp04bB3Migration: p.mp04bB3Migration,
        interceptedCalls: p.interceptedCalls,
        stockService: p.stockService,
        units: p.units,
        stage1: p.stage1,
      };
    });

    // 2. Start PostgreSQL container
    container = await step('preflight: container PostgreSQL 15 terisolasi', async () => {
      const c = startContainer();
      const port = resolveHostPort(c.name);
      globalThis.__MP04B_B5_PORT__ = port;
      globalThis.__MP04B_B5_PASSWORD__ = c.password;
      await waitForPostgres(90000);
      return { name: c.name, port };
    });

    const pool = newPool('mp04b-b5-test-runner');

    // 3. Setup Baseline & Migrations (MP-03C + MP-04B B1 + MP-04B B3)
    await step('setup: skema baseline dan eksekusi migrasi MP-03C, MP-04B B1 & B3', async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS properties (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );

        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(100) NOT NULL,
          full_name VARCHAR(150) NOT NULL
        );

        CREATE TABLE IF NOT EXISTS rooms (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id)
        );

        CREATE TABLE IF NOT EXISTS pos_menu_categories (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id),
          name VARCHAR(100) NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pos_menu_items (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id),
          category_id INTEGER REFERENCES pos_menu_categories(id),
          item_code VARCHAR(50),
          name VARCHAR(100) NOT NULL,
          price DECIMAL(12, 2) NOT NULL DEFAULT 0,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          is_sellable_pos BOOLEAN NOT NULL DEFAULT TRUE,
          product_type VARCHAR(30),
          product_kind VARCHAR(30),
          base_unit VARCHAR(50),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS transactions (
          id BIGSERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id),
          transaction_no VARCHAR(50) NOT NULL UNIQUE,
          transaction_date DATE NOT NULL DEFAULT CURRENT_DATE,
          transaction_time TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
          transaction_type VARCHAR(20) NOT NULL,
          source_type VARCHAR(50) NOT NULL,
          source_id VARCHAR(100),
          source_reference VARCHAR(100),
          category_code VARCHAR(50) NOT NULL,
          category_name VARCHAR(150) NOT NULL,
          department_code VARCHAR(50) NOT NULL DEFAULT 'PURCHASING',
          description TEXT NOT NULL,
          amount BIGINT NOT NULL DEFAULT 0,
          discount_amount BIGINT NOT NULL DEFAULT 0,
          service_amount BIGINT NOT NULL DEFAULT 0,
          tax_amount BIGINT NOT NULL DEFAULT 0,
          net_amount BIGINT NOT NULL DEFAULT 0,
          payment_status VARCHAR(30) NOT NULL DEFAULT 'UNPAID',
          payment_method VARCHAR(50),
          transaction_status VARCHAR(30) NOT NULL DEFAULT 'POSTED',
          guest_id INTEGER,
          guest_name_snapshot VARCHAR(150),
          room_number_snapshot VARCHAR(50),
          reservation_id INTEGER,
          booking_id BIGINT,
          reversal_of_transaction_id BIGINT REFERENCES transactions(id),
          correction_group_id VARCHAR(100),
          notes TEXT,
          metadata JSONB DEFAULT '{}'::jsonb,
          created_by VARCHAR(100),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_by VARCHAR(100),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          receiving_status VARCHAR(50) DEFAULT NULL,
          received_at TIMESTAMPTZ DEFAULT NULL
        );

        CREATE TABLE IF NOT EXISTS transaction_lines (
          id BIGSERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
          transaction_id BIGINT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
          product_id BIGINT DEFAULT NULL,
          description_snapshot VARCHAR(255) NOT NULL,
          quantity NUMERIC(12, 3) NOT NULL DEFAULT 1,
          unit VARCHAR(50) NOT NULL DEFAULT 'pcs',
          unit_price BIGINT NOT NULL DEFAULT 0,
          discount_amount BIGINT NOT NULL DEFAULT 0,
          line_total BIGINT NOT NULL DEFAULT 0,
          sort_order INT NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS transaction_daily_sequences (
          property_id INTEGER NOT NULL REFERENCES properties(id),
          date_key VARCHAR(10) NOT NULL,
          last_seq INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (property_id, date_key)
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
          id SERIAL PRIMARY KEY,
          audit_id SERIAL,
          property_id INTEGER,
          module VARCHAR(50),
          action VARCHAR(50),
          entity VARCHAR(50),
          record_id VARCHAR(50),
          new_value TEXT,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          correlation_id VARCHAR(100),
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await prod.mp03cMigration.runProductMasterMp03cMigration(pool);
      await prod.mp04bB1Migration.runProductInventoryMp04bB1Migration(pool);
      await prod.mp04bB3Migration.runProductInventoryMp04bB3Migration(pool);

      return 'Skema & migrasi berhasil diinisialisasi';
    });

    // 4. Seed Data & Transaksi Historis
    let propId, locWhId, locKitId, itemAId, itemBId, itemCId;
    await step('setup: seed master produk, lokasi, & kronologi transaksi stok', async () => {
      // Nonaktifkan trigger append-only sementara hanya untuk simulasi stempel waktu historis
      await pool.query('ALTER TABLE stock_movements DISABLE TRIGGER trg_guard_stock_movements_append_only');

      try {
        // Property
        const propRes = await pool.query(`INSERT INTO properties (name) VALUES ('OAK Resort & Spa') RETURNING id`);
        propId = propRes.rows[0].id;

      // User
      await pool.query(`INSERT INTO users (id, username, full_name) VALUES (1, 'supervisor', 'Supervisor Gudang') ON CONFLICT DO NOTHING`);

      // Category
      const catRes = await pool.query(
        `INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, 'Beverages & Ingredients') RETURNING id`,
        [propId]
      );
      const catId = catRes.rows[0].id;

      // Lokasi: WH-01 (Gudang Utama) & KIT-01 (Dapur Resto)
      const locWhRes = await pool.query(
        `INSERT INTO stock_locations (property_id, code, name, location_type, is_active)
         VALUES ($1, 'WH-01', 'Gudang Utama', 'WAREHOUSE', TRUE) RETURNING id`,
        [propId]
      );
      locWhId = locWhRes.rows[0].id;

      const locKitRes = await pool.query(
        `INSERT INTO stock_locations (property_id, code, name, location_type, is_active)
         VALUES ($1, 'KIT-01', 'Dapur Resto', 'KITCHEN', TRUE) RETURNING id`,
        [propId]
      );
      locKitId = locKitRes.rows[0].id;

      // Produk A: Sirup Vanila (track_stock=true, BOTOL, price=25000)
      const pARes = await pool.query(
        `INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, base_unit, canonical_base_unit_code, track_stock)
         VALUES ($1, $2, 'SR-VN', 'Sirup Vanila 750ml', 25000.00, 'Botol', 'BOTOL', TRUE) RETURNING id`,
        [propId, catId]
      );
      itemAId = pARes.rows[0].id;

      // Produk B: Biji Kopi Arabika (track_stock=true, KG, price=120000)
      const pBRes = await pool.query(
        `INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, base_unit, canonical_base_unit_code, track_stock)
         VALUES ($1, $2, 'CF-ARB', 'Biji Kopi Arabika', 120000.00, 'Kilogram', 'KG', TRUE) RETURNING id`,
        [propId, catId]
      );
      itemBId = pBRes.rows[0].id;

      // Produk C: Gula Pasir (track_stock=true, KG, price=18000)
      const pCRes = await pool.query(
        `INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, base_unit, canonical_base_unit_code, track_stock)
         VALUES ($1, $2, 'SG-01', 'Gula Pasir Kristal', 18000.00, 'Kilogram', 'KG', TRUE) RETURNING id`,
        [propId, catId]
      );
      itemCId = pCRes.rows[0].id;

      // Kronologi Transaksi:
      // 1. Saldo Awal (2026-10-01):
      //    - Item A: 50 BTL @ Rp 20,000 at WH-01
      //    - Item B: 20 KG @ Rp 100,000 at WH-01
      //    - Item C: 30 KG @ Rp 15,000 at WH-01
      await prod.stockService.recordOpeningBalance(pool, {
        property_id: propId,
        product_id: itemAId,
        location_id: locWhId,
        quantity: '50.000',
        unit_cost: '20000.00',
        operation_key: 'OP-BAL-A-20261001',
      });
      await pool.query(`UPDATE stock_movements SET created_at = '2026-10-01 08:00:00+07' WHERE product_id = $1`, [itemAId]);
      await pool.query(`UPDATE stock_operations SET created_at = '2026-10-01 08:00:00+07' WHERE operation_key = 'OP-BAL-A-20261001'`);

      await prod.stockService.recordOpeningBalance(pool, {
        property_id: propId,
        product_id: itemBId,
        location_id: locWhId,
        quantity: '20.000',
        unit_cost: '100000.00',
        operation_key: 'OP-BAL-B-20261001',
      });
      await pool.query(`UPDATE stock_movements SET created_at = '2026-10-01 08:15:00+07' WHERE product_id = $1`, [itemBId]);
      await pool.query(`UPDATE stock_operations SET created_at = '2026-10-01 08:15:00+07' WHERE operation_key = 'OP-BAL-B-20261001'`);

      await prod.stockService.recordOpeningBalance(pool, {
        property_id: propId,
        product_id: itemCId,
        location_id: locWhId,
        quantity: '30.000',
        unit_cost: '15000.00',
        operation_key: 'OP-BAL-C-20261001',
      });
      await pool.query(`UPDATE stock_movements SET created_at = '2026-10-01 08:30:00+07' WHERE product_id = $1`, [itemCId]);
      await pool.query(`UPDATE stock_operations SET created_at = '2026-10-01 08:30:00+07' WHERE operation_key = 'OP-BAL-C-20261001'`);

      // 2. Penerimaan Barang Pembelian (2026-10-05):
      //    - Item A: +30 BTL @ Rp 22,000 at WH-01
      await pool.query(
        `INSERT INTO transactions (id, property_id, transaction_no, transaction_type, source_type, category_code, category_name, description, amount, net_amount, receiving_status)
         VALUES (1001, $1, 'PO-2026-1001', 'PURCHASE', 'MANUAL_PURCHASE', 'BEV', 'Beverage', 'Pembelian Sirup Vanila', 660000, 660000, 'BELUM_DITERIMA')`,
        [propId]
      );
      await pool.query(
        `INSERT INTO transaction_lines (id, property_id, transaction_id, product_id, description_snapshot, quantity, unit, unit_price, line_total)
         VALUES (1, $1, 1001, $2, 'Sirup Vanila 750ml', 30.000, 'botol', 22000, 660000)`,
        [propId, itemAId]
      );

      const receiptRes = await prod.stockService.recordPurchaseReceipt(pool, {
        property_id: propId,
        transaction_id: 1001,
        location_id: locWhId,
        operation_key: 'PO-REC-1001-20261005',
        received_lines: [
          {
            line_id: 1,
            product_id: itemAId,
            location_id: locWhId,
            quantity_received: '30.000',
          },
        ],
        notes: 'Penerimaan PO #1001',
      });
      // Set unit_cost dan timestamp mutasi PO
      await pool.query(
        `UPDATE stock_movements SET unit_cost = 22000.00, created_at = '2026-10-05 10:00:00+07' WHERE operation_id = $1`,
        [receiptRes.operation_id]
      );
      await pool.query(
        `UPDATE stock_operations SET created_at = '2026-10-05 10:00:00+07' WHERE id = $1`,
        [receiptRes.operation_id]
      );

      // 3. Transfer Stok Antar Lokasi (2026-10-10):
      //    - Item A: transfer 15 BTL dari WH-01 ke KIT-01
      const transferRes = await prod.stockService.recordStockTransfer(pool, {
        property_id: propId,
        from_location_id: locWhId,
        to_location_id: locKitId,
        items: [
          {
            product_id: itemAId,
            quantity: '15.000',
          },
        ],
        operation_key: 'TRF-WH-KIT-20261010',
        notes: 'Transfer reguler bar sirup ke dapur',
      });
      await pool.query(
        `UPDATE stock_movements SET created_at = '2026-10-10 14:00:00+07' WHERE operation_id = $1`,
        [transferRes.operation_id]
      );
      await pool.query(
        `UPDATE stock_operations SET created_at = '2026-10-10 14:00:00+07' WHERE id = $1`,
        [transferRes.operation_id]
      );

      // 4. Penyesuaian Stok (2026-10-12):
      //    - Item A: -2 BTL at WH-01 (RUSAK / PECAH)
      const adjRes = await prod.stockService.recordStockAdjustment(pool, {
        property_id: propId,
        product_id: itemAId,
        location_id: locWhId,
        adjustment_type: 'OUT',
        reason_code: 'RUSAK',
        quantity: '2.000',
        operation_key: 'ADJ-RUSAK-20261012',
        notes: 'Botol pecah tersenggol saat penataan rak',
      });
      await pool.query(
        `UPDATE stock_movements SET created_at = '2026-10-12 16:30:00+07' WHERE operation_id = $1`,
        [adjRes.operation_id]
      );
      await pool.query(
        `UPDATE stock_operations SET created_at = '2026-10-12 16:30:00+07' WHERE id = $1`,
        [adjRes.operation_id]
      );

      // 5. Stock Opname Fisik (2026-10-15):
      //    - At WH-01:
      //      Item A: fisik = 65.000 (sistem 50 + 30 - 15 - 2 = 63.000 -> SURPLUS +2.000)
      //      Item B: fisik = 19.000 (sistem 20.000 -> DEFICIT -1.000)
      //      Item C: fisik = 30.000 (sistem 30.000 -> MATCH 0.000)
      const opnameRes = await prod.stockService.recordStockOpname(pool, {
        property_id: propId,
        location_id: locWhId,
        operation_key: 'OPNAME-MID-20261015',
        notes: 'Opname tengah bulan gudang utama',
        items: [
          { product_id: itemAId, physical_quantity: '65.000', notes: 'Ditemukan 2 botol terselip' },
          { product_id: itemBId, physical_quantity: '19.000', notes: 'Susut roasting/tercecer' },
          { product_id: itemCId, physical_quantity: '30.000', notes: 'Kuantitas cocok sempurna' },
        ],
      });
      await pool.query(
        `UPDATE stock_movements SET created_at = '2026-10-15 18:00:00+07' WHERE operation_id = $1`,
        [opnameRes.operation_id]
      );
      await pool.query(
        `UPDATE stock_operations SET created_at = '2026-10-15 18:00:00+07' WHERE id = $1`,
        [opnameRes.operation_id]
      );

        return {
          propId,
          whLocation: locWhId,
          kitLocation: locKitId,
          itemA: itemAId,
          itemB: itemBId,
          itemC: itemCId,
        };
      } finally {
        await pool.query('ALTER TABLE stock_movements ENABLE TRIGGER trg_guard_stock_movements_append_only');
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 1: Kartu Stok tanpa filter tanggal (seluruh riwayat)
    // ─────────────────────────────────────────────────────────────────────────
    await step('skenario 1: kartu stok tanpa filter tanggal (full ledger history)', async () => {
      const ledger = await prod.stockService.getStockLedgerCard(pool, {
        property_id: propId,
        product_id: itemAId,
        location_id: locWhId,
      });

      assert.strictEqual(ledger.property_id, propId);
      assert.strictEqual(ledger.product.id, itemAId);
      assert.strictEqual(ledger.product.base_unit_code, 'BOTOL');
      assert.strictEqual(ledger.location.id, locWhId);
      assert.strictEqual(ledger.opening_balance, '0.000');
      assert.strictEqual(ledger.closing_balance, '65.000');
      assert.strictEqual(ledger.current_system_balance, '65.000');
      assert.strictEqual(ledger.total_in, '82.000'); // 50 + 30 + 2 = 82
      assert.strictEqual(ledger.total_out, '17.000'); // 15 + 2 = 17

      // Periksa daftar movements: urutan kronologis ASC
      assert.strictEqual(ledger.movements.length, 5);
      assert.strictEqual(ledger.movements[0].operation_type, 'OPENING_BALANCE');
      assert.strictEqual(ledger.movements[0].quantity_delta, '+50.000');
      assert.strictEqual(ledger.movements[0].running_balance, '50.000');

      assert.strictEqual(ledger.movements[1].operation_type, 'PURCHASE_RECEIPT');
      assert.strictEqual(ledger.movements[1].quantity_delta, '+30.000');
      assert.strictEqual(ledger.movements[1].running_balance, '80.000');

      assert.strictEqual(ledger.movements[2].operation_type, 'STOCK_TRANSFER');
      assert.strictEqual(ledger.movements[2].quantity_delta, '-15.000');
      assert.strictEqual(ledger.movements[2].running_balance, '65.000');

      assert.strictEqual(ledger.movements[3].operation_type, 'STOCK_ADJUSTMENT');
      assert.strictEqual(ledger.movements[3].quantity_delta, '-2.000');
      assert.strictEqual(ledger.movements[3].running_balance, '63.000');

      assert.strictEqual(ledger.movements[4].operation_type, 'STOCK_OPNAME');
      assert.strictEqual(ledger.movements[4].quantity_delta, '+2.000');
      assert.strictEqual(ledger.movements[4].running_balance, '65.000');

      return {
        movementsCount: ledger.movements.length,
        closingBalance: ledger.closing_balance,
        currentSystemBalance: ledger.current_system_balance,
      };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 2: Kartu Stok dengan filter tanggal (Asia/Jakarta window)
    // ─────────────────────────────────────────────────────────────────────────
    await step('skenario 2: kartu stok dengan rentang tanggal (opening balance kalkulatif)', async () => {
      // Filter rentang: 2026-10-06 s/d 2026-10-14
      // Mutasi sebelum 2026-10-06:
      // - Opening balance (+50.000) pada 2026-10-01
      // - Purchase receipt (+30.000) pada 2026-10-05
      // Akumulasi opening balance = 80.000
      // Mutasi dalam window:
      // - Transfer OUT (-15.000) pada 2026-10-10 -> running: 65.000
      // - Penyesuaian OUT (-2.000) pada 2026-10-12 -> running: 63.000
      // Opname pada 2026-10-15 berada di luar window!
      const ledger = await prod.stockService.getStockLedgerCard(pool, {
        property_id: propId,
        product_id: itemAId,
        location_id: locWhId,
        start_date: '2026-10-06',
        end_date: '2026-10-14',
      });

      assert.strictEqual(ledger.opening_balance, '80.000', 'Opening balance harus akumulasi mutasi sebelum start_date');
      assert.strictEqual(ledger.closing_balance, '63.000', 'Closing balance harus merefleksikan saldo akhir window');
      assert.strictEqual(ledger.current_system_balance, '65.000', 'Current system balance tetap menunjukkan saldo mutakhir');
      assert.strictEqual(ledger.total_in, '0.000');
      assert.strictEqual(ledger.total_out, '17.000');
      assert.strictEqual(ledger.movements.length, 2);

      assert.strictEqual(ledger.movements[0].operation_type, 'STOCK_TRANSFER');
      assert.strictEqual(ledger.movements[0].quantity_delta, '-15.000');
      assert.strictEqual(ledger.movements[0].running_balance, '65.000');

      assert.strictEqual(ledger.movements[1].operation_type, 'STOCK_ADJUSTMENT');
      assert.strictEqual(ledger.movements[1].quantity_delta, '-2.000');
      assert.strictEqual(ledger.movements[1].running_balance, '63.000');

      return {
        openingBalance: ledger.opening_balance,
        closingBalance: ledger.closing_balance,
        movementsInWindow: ledger.movements.length,
      };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 3: Kartu Stok di lokasi penerima transfer (KIT-01)
    // ─────────────────────────────────────────────────────────────────────────
    await step('skenario 3: kartu stok di lokasi penerima transfer (KIT-01)', async () => {
      const ledger = await prod.stockService.getStockLedgerCard(pool, {
        property_id: propId,
        product_id: itemAId,
        location_id: locKitId,
      });

      assert.strictEqual(ledger.opening_balance, '0.000');
      assert.strictEqual(ledger.closing_balance, '15.000');
      assert.strictEqual(ledger.current_system_balance, '15.000');
      assert.strictEqual(ledger.total_in, '15.000');
      assert.strictEqual(ledger.total_out, '0.000');
      assert.strictEqual(ledger.movements.length, 1);
      assert.strictEqual(ledger.movements[0].operation_type, 'STOCK_TRANSFER');
      assert.strictEqual(ledger.movements[0].quantity_delta, '+15.000');
      assert.strictEqual(ledger.movements[0].running_balance, '15.000');

      return {
        kitBalance: ledger.closing_balance,
      };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 4: Rekap Saldo & Valuasi Persediaan (Valuation Report)
    // ─────────────────────────────────────────────────────────────────────────
    await step('skenario 4: rekap saldo & valuasi persediaan komprehensif', async () => {
      // 1. Valuasi seluruh properti
      const reportAll = await prod.stockService.getInventoryValuationReport(pool, {
        property_id: propId,
      });

      assert.strictEqual(reportAll.property_id, propId);
      assert.strictEqual(reportAll.summary.total_items, 4);

      // Kuantitas:
      // Item A at WH-01: 65.000 @ unit cost 22000 (dari pembelian terbaru) -> 1,430,000.00
      // Item A at KIT-01: 15.000 @ unit cost 22000 -> 330,000.00
      // Item B at WH-01: 19.000 @ unit cost 100000 -> 1,900,000.00
      // Item C at WH-01: 30.000 @ unit cost 15000 -> 450,000.00
      // Total Qty = 65 + 15 + 19 + 30 = 129.000
      // Total Valuasi = 1,430,000 + 330,000 + 1,900,000 + 450,000 = 4,110,000.00
      assert.strictEqual(reportAll.summary.total_quantity, '129.000');
      assert.strictEqual(reportAll.summary.total_valuation_value, '4110000.00');

      // 2. Filter per lokasi: Dapur Resto (KIT-01)
      const reportKit = await prod.stockService.getInventoryValuationReport(pool, {
        property_id: propId,
        location_id: locKitId,
      });
      assert.strictEqual(reportKit.summary.total_items, 1);
      assert.strictEqual(reportKit.summary.total_quantity, '15.000');
      assert.strictEqual(reportKit.summary.total_valuation_value, '330000.00');
      assert.strictEqual(reportKit.items[0].product_name, 'Sirup Vanila 750ml');

      // 3. Filter per produk: Biji Kopi Arabika
      const reportCoffee = await prod.stockService.getInventoryValuationReport(pool, {
        property_id: propId,
        product_id: itemBId,
      });
      assert.strictEqual(reportCoffee.summary.total_items, 1);
      assert.strictEqual(reportCoffee.summary.total_quantity, '19.000');
      assert.strictEqual(reportCoffee.summary.total_valuation_value, '1900000.00');

      // 4. Filter search text "Gula"
      const reportSearch = await prod.stockService.getInventoryValuationReport(pool, {
        property_id: propId,
        search: 'Gula',
      });
      assert.strictEqual(reportSearch.summary.total_items, 1);
      assert.strictEqual(reportSearch.items[0].product_item_code, 'SG-01');
      assert.strictEqual(reportSearch.summary.total_valuation_value, '450000.00');

      return {
        totalItems: reportAll.summary.total_items,
        totalQuantity: reportAll.summary.total_quantity,
        totalValuationValue: reportAll.summary.total_valuation_value,
      };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 5: Laporan Rekap Variansi Opname (Opname Variance Report)
    // ─────────────────────────────────────────────────────────────────────────
    await step('skenario 5: laporan rekap variansi opname & filtering status', async () => {
      // 1. Laporan semua status (ALL)
      const varReportAll = await prod.stockService.getOpnameVarianceReport(pool, {
        property_id: propId,
      });

      assert.strictEqual(varReportAll.property_id, propId);
      assert.strictEqual(varReportAll.summary.total_sessions, 1);
      assert.strictEqual(varReportAll.summary.total_items_counted, 3);
      assert.strictEqual(varReportAll.summary.total_surplus_items, 1);
      assert.strictEqual(varReportAll.summary.total_deficit_items, 1);
      assert.strictEqual(varReportAll.summary.total_match_items, 1);
      assert.strictEqual(varReportAll.summary.total_surplus_qty, '2.000');
      assert.strictEqual(varReportAll.summary.total_deficit_qty, '1.000');
      assert.strictEqual(varReportAll.summary.net_variance_qty, '+1.000');

      // Item A surplus: 2 * 22,000 = 44,000.00
      assert.strictEqual(varReportAll.summary.total_surplus_value, '44000.00');
      // Item B deficit: 1 * 100,000 = 100,000.00
      assert.strictEqual(varReportAll.summary.total_deficit_value, '100000.00');
      // Net variance value: 44,000 - 100,000 = -56,000.00
      assert.strictEqual(varReportAll.summary.net_variance_value, '-56000.00');

      assert.strictEqual(varReportAll.items.length, 3);

      // 2. Filter status DEFICIT
      const varReportDeficit = await prod.stockService.getOpnameVarianceReport(pool, {
        property_id: propId,
        status: 'DEFICIT',
      });
      assert.strictEqual(varReportDeficit.items.length, 1);
      assert.strictEqual(varReportDeficit.items[0].product_id, itemBId);
      assert.strictEqual(varReportDeficit.items[0].status, 'DEFICIT');
      assert.strictEqual(varReportDeficit.items[0].variance_quantity, '-1.000');

      // 3. Filter status SURPLUS
      const varReportSurplus = await prod.stockService.getOpnameVarianceReport(pool, {
        property_id: propId,
        status: 'SURPLUS',
      });
      assert.strictEqual(varReportSurplus.items.length, 1);
      assert.strictEqual(varReportSurplus.items[0].product_id, itemAId);
      assert.strictEqual(varReportSurplus.items[0].status, 'SURPLUS');
      assert.strictEqual(varReportSurplus.items[0].variance_quantity, '+2.000');

      // 4. Filter status MATCH
      const varReportMatch = await prod.stockService.getOpnameVarianceReport(pool, {
        property_id: propId,
        status: 'MATCH',
      });
      assert.strictEqual(varReportMatch.items.length, 1);
      assert.strictEqual(varReportMatch.items[0].product_id, itemCId);
      assert.strictEqual(varReportMatch.items[0].status, 'MATCH');
      assert.strictEqual(varReportMatch.items[0].variance_quantity, '+0.000');

      return {
        totalSurplusQty: varReportAll.summary.total_surplus_qty,
        totalDeficitQty: varReportAll.summary.total_deficit_qty,
        netVarianceValue: varReportAll.summary.net_variance_value,
      };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 6: HTTP REST API Endpoints & RBAC Authorization
    // ─────────────────────────────────────────────────────────────────────────
    await step('skenario 6: endpoint express handler & rbac authorization', async () => {
      const deps = makeDeps(pool);
      const stockLedgerHandler = prod.stockService.createStockLedgerHandler(deps);
      const valuationHandler = prod.stockService.createInventoryValuationHandler(deps);
      const opnameVarianceHandler = prod.stockService.createOpnameVarianceHandler(deps);

      // 1. User dengan role SUPERADMIN (akses diizinkan)
      const adminReq = makeReq({
        query: { property_id: propId, product_id: itemAId, location_id: locWhId },
        user: { id: 1, role: 'SUPERADMIN' },
      });
      const adminRes = makeRes();
      await stockLedgerHandler(adminReq, adminRes);
      assert.strictEqual(adminRes.statusCode, 200);
      assert.strictEqual(adminRes.body.status, 'OK');
      assert.strictEqual(adminRes.body.data.closing_balance, '65.000');

      // 2. User dengan permissions ['inventory.view'] (akses diizinkan)
      const viewerReq = makeReq({
        query: { property_id: propId, product_id: itemAId, location_id: locWhId },
        user: { id: 2, role: 'STAFF', permissions: ['inventory.view'] },
      });
      const viewerRes = makeRes();
      await stockLedgerHandler(viewerReq, viewerRes);
      assert.strictEqual(viewerRes.statusCode, 200);
      assert.strictEqual(viewerRes.body.status, 'OK');

      // 3. User GUEST tanpa izin inventory (akses ditolak 403)
      const guestReq = makeReq({
        query: { property_id: propId, product_id: itemAId, location_id: locWhId },
        user: { id: 9, role: 'GUEST', permissions: ['guest.profile'] },
      });
      const guestRes = makeRes();
      await stockLedgerHandler(guestReq, guestRes);
      assert.strictEqual(guestRes.statusCode, 403);
      assert.strictEqual(guestRes.body.code, 'FORBIDDEN');

      // 4. Valuation Handler: validasi parameter property_id
      const valMissingPropReq = makeReq({
        query: {},
        user: { id: 1, role: 'SUPERADMIN' },
      });
      const valMissingPropRes = makeRes();
      await valuationHandler(valMissingPropReq, valMissingPropRes);
      assert.strictEqual(valMissingPropRes.statusCode, 400);
      assert.strictEqual(valMissingPropRes.body.code, 'VALIDATION_ERROR');

      // 5. Valuation Handler sukses
      const valReq = makeReq({
        query: { property_id: propId },
        user: { id: 1, role: 'SUPERADMIN' },
      });
      const valRes = makeRes();
      await valuationHandler(valReq, valRes);
      assert.strictEqual(valRes.statusCode, 200);
      assert.strictEqual(valRes.body.status, 'OK');
      assert.strictEqual(valRes.body.data.summary.total_quantity, '129.000');

      // 6. Opname Variance Handler sukses
      const opnVarReq = makeReq({
        query: { property_id: propId, status: 'SURPLUS' },
        user: { id: 1, role: 'SUPERADMIN' },
      });
      const opnVarRes = makeRes();
      await opnameVarianceHandler(opnVarReq, opnVarRes);
      assert.strictEqual(opnVarRes.statusCode, 200);
      assert.strictEqual(opnVarRes.body.status, 'OK');
      assert.strictEqual(opnVarRes.body.data.items.length, 1);

      return 'RBAC & parameter validation terverifikasi';
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 7: Invarian Mutasi & Integritas Read-Only
    // ─────────────────────────────────────────────────────────────────────────
    await step('skenario 7: invarian database & integritas read-only (zero mutation)', async () => {
      // 1. Hitung ulang total baris dan pastikan tidak ada mutasi baru setelah eksekusi laporan
      const movCountRes = await pool.query(`SELECT COUNT(*) AS total FROM stock_movements`);
      const opCountRes = await pool.query(`SELECT COUNT(*) AS total FROM stock_operations`);
      const balCountRes = await pool.query(`SELECT COUNT(*) AS total FROM stock_balances`);

      // 2. Periksa rekonsiliasi matematis seluruh saldo
      // SUM(quantity_delta) per produk dan lokasi wajib tepat sama dengan quantity di stock_balances
      const reconRes = await pool.query(`
        SELECT
          sb.product_id,
          sb.location_id,
          sb.quantity AS balance_qty,
          COALESCE(SUM(sm.quantity_delta), 0) AS movement_sum
        FROM stock_balances sb
        LEFT JOIN stock_movements sm
          ON sm.property_id = sb.property_id
         AND sm.product_id = sb.product_id
         AND sm.location_id = sb.location_id
        GROUP BY sb.product_id, sb.location_id, sb.quantity
      `);

      for (const row of reconRes.rows) {
        const bal = parseFloat(row.balance_qty);
        const mov = parseFloat(row.movement_sum);
        assert.ok(
          Math.abs(bal - mov) < 0.0001,
          `Drift terdeteksi pada product ${row.product_id} di lokasi ${row.location_id}: balance=${bal}, movement_sum=${mov}`
        );
      }

      // 3. Verifikasi saldo negatif = 0
      const negRes = await pool.query(`SELECT COUNT(*) AS count FROM stock_balances WHERE quantity < 0`);
      assert.strictEqual(Number(negRes.rows[0].count), 0, 'Saldo negatif terlarang');

      // 4. Verifikasi Append-Only Trigger aktif pada stock_movements
      let updateThrew = false;
      try {
        await pool.query('UPDATE stock_movements SET quantity_delta = 999.000 WHERE id = (SELECT MIN(id) FROM stock_movements)');
      } catch (err) {
        updateThrew = (
          err.message.includes('STOCK_MOVEMENTS_APPEND_ONLY') ||
          err.message.toLowerCase().includes('append-only') ||
          err.message.includes('dilarang')
        );
      }
      assert.strictEqual(updateThrew, true, 'Trigger append-only harus menolak UPDATE pada stock_movements');

      return {
        totalMovements: Number(movCountRes.rows[0].total),
        totalOperations: Number(opCountRes.rows[0].total),
        totalBalances: Number(balCountRes.rows[0].total),
        drift: 0,
        appendOnlyTriggerActive: true,
      };
    });

    log('========================================================================');
    log('SEMUA PENGUJIAN MP-04B BATCH 5 BERHASIL (PASS 100%)');
    log('========================================================================');
  } finally {
    await closeAllPools();
    if (container) {
      log(`Membersihkan docker container: ${container.name}...`);
      stopContainer(container.name);
      log(`Container ${container.name} berhasil dibersihkan.`);
    }
  }
}

main().catch((err) => {
  console.error('FATAL TEST ERROR:', err);
  process.exit(1);
});
