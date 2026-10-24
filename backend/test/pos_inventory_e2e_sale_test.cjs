'use strict';

/**
 * OAK HIMS — E2E POS Cashier & Automatic Stock Deduction Integration Test
 * =========================================================================
 *
 * File: backend/test/pos_inventory_e2e_sale_test.cjs
 *
 * Skenario Pengujian:
 *   - Skenario 1: Penjualan POS produk tunggal terlacak (track_inventory = true)
 *                 memotong saldo stock_balances, mencatat stock_movements (POS_SALE),
 *                 dan kartu stok (Stock Ledger) merefleksikan running balance terbaru.
 *   - Skenario 2: Pesanan kombinasi campuran (mixed order: item A & B terlacak,
 *                 item C jasa/non-tracked). Hanya item terlacak yang dipotong stoknya.
 *   - Skenario 3: Pesanan dengan 100% item non-tracked. Pembayaran sukses tanpa
 *                 menghasilkan mutasi stok persediaan.
 *   - Skenario 4: Proteksi saldo persediaan (insufficient stock). Jika saldo kurang,
 *                 pembayaran ditolak dengan HTTP 422 INSUFFICIENT_STOCK_BALANCE,
 *                 transaksi di-rollback atomik (order tetap OPEN, saldo utuh).
 *   - Skenario 5: Idempotency & Replay Protection. Request pembayaran berulang dengan
 *                 Idempotency-Key sama mengembalikan status REPLAY tanpa double-deduction.
 *   - Skenario 6: Verifikasi Invarian Persediaan: drift = 0, running balance konsisten,
 *                 tidak ada saldo negatif (chk_stock_balance_non_negative).
 *
 * Keamanan:
 *   - Menggunakan container Docker PostgreSQL 15 terisolasi.
 *   - Dibersihkan tuntas di blok finally (zero container residue).
 *   - Tidak membaca backend/.env maupun kredensial produksi.
 */

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const BACKEND_DIR = path.resolve(__dirname, '..');

const IMAGE = 'postgres:15';
const TEST_DB = 'oak_hims_pos_sale_e2e_test';
const TEST_USER = 'oak_sale_runner';
const CONTAINER_PREFIX = 'oak-hims-pos-sale-e2e-';

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

  const schemaPath = path.join(BACKEND_DIR, 'dist', 'db', 'schema_v3.js');
  const stockServicePath = path.join(BACKEND_DIR, 'dist', 'domains', 'pos', 'stockInventoryService.js');
  const settlementServicePath = path.join(BACKEND_DIR, 'dist', 'domains', 'pos', 'posSettlementService.js');
  const orderCreateHandlerPath = path.join(BACKEND_DIR, 'dist', 'domains', 'pos', 'posOrderCreateHandler.js');

  for (const p of [schemaPath, stockServicePath, settlementServicePath, orderCreateHandlerPath]) {
    if (!fs.existsSync(p)) {
      throw new Error(`Build produksi belum tersedia: ${p}. Jalankan "npm --prefix backend run build" lebih dulu.`);
    }
  }

  const schema = require(schemaPath);
  const stockService = require(stockServicePath);
  const settlementService = require(settlementServicePath);
  const orderCreateHandler = require(orderCreateHandlerPath);

  const posOrderExpansion = require(path.join(BACKEND_DIR, 'dist', 'db', 'migrations', 'pos_order_expansion_v1.js'));
  const posIdempotency = require(path.join(BACKEND_DIR, 'dist', 'db', 'migrations', 'pos_idempotency_v1.js'));
  const posServiceTax = require(path.join(BACKEND_DIR, 'dist', 'db', 'migrations', 'pos_service_tax_v1.js'));
  const posPaymentSettlement = require(path.join(BACKEND_DIR, 'dist', 'db', 'migrations', 'pos_payment_settlement_v1.js'));
  const posReceiptSnapshot = require(path.join(BACKEND_DIR, 'dist', 'db', 'migrations', 'pos_receipt_snapshot_v1.js'));
  const mp03c = require(path.join(BACKEND_DIR, 'dist', 'db', 'migrations', 'product_master_mp03c_v1.js'));
  const mp04bB1 = require(path.join(BACKEND_DIR, 'dist', 'db', 'migrations', 'product_inventory_mp04b_b1_v1.js'));
  const mp04bB3 = require(path.join(BACKEND_DIR, 'dist', 'db', 'migrations', 'product_inventory_mp04b_b3_v1.js'));

  const envAfter = Object.fromEntries(WATCHED_ENV_KEYS.map((k) => [k, process.env[k] ?? null]));
  for (const key of WATCHED_ENV_KEYS) {
    if (envBefore[key] !== envAfter[key]) {
      throw new Error(`Impor modul produksi mengubah variabel lingkungan ${key}; dotenv guard gagal.`);
    }
  }

  return {
    schema,
    stockService,
    settlementService,
    orderCreateHandler,
    posOrderExpansion,
    posIdempotency,
    posServiceTax,
    posPaymentSettlement,
    posReceiptSnapshot,
    mp03c,
    mp04bB1,
    mp04bB3,
    interceptedCalls,
  };
}

let pg = null;
const allPools = [];

function makePoolConfig(applicationName) {
  return {
    host: '127.0.0.1',
    port: globalThis.__POS_SALE_PORT__,
    user: TEST_USER,
    password: globalThis.__POS_SALE_PASSWORD__,
    database: TEST_DB,
    max: 10,
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
    const client = new pg.Client({ ...makePoolConfig('pos-sale-readiness'), connectionTimeoutMillis: 3000 });
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

// ─────────────────────────────────────────────────────────────────────────────
// Main Test Runner
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  log('========================================================================');
  log('OAK HIMS — E2E POS Kasir & Pemotongan Stok Otomatis (MP-04B)');
  log('========================================================================');

  let container = null;

  try {
    // 1. Guard & load production modules
    const prod = await step('preflight: modul produksi & dotenv stub guard', async () => {
      const p = loadProductionModules();
      pg = require(require.resolve('pg', { paths: [BACKEND_DIR] }));
      return p;
    });

    // 2. Start PostgreSQL container
    container = await step('preflight: container PostgreSQL 15 terisolasi', async () => {
      const c = startContainer();
      const port = resolveHostPort(c.name);
      globalThis.__POS_SALE_PORT__ = port;
      globalThis.__POS_SALE_PASSWORD__ = c.password;
      await waitForPostgres(90000);
      return { name: c.name, port };
    });

    const pool = newPool('pos-sale-e2e-runner');

    // 3. Initialize complete database schema & migrations
    await step('setup: inisialisasi skema lengkap database schema_v3 & migrations', async () => {
      await prod.schema.initializeDatabase(pool);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS property_payment_instructions (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL UNIQUE REFERENCES properties(id) ON DELETE CASCADE,
          bank_name VARCHAR(100),
          bank_account_name VARCHAR(150),
          bank_account_number VARCHAR(100),
          bank_branch VARCHAR(100),
          payment_note TEXT,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_by VARCHAR(100)
        );
      `);

      const mSettlement = await prod.posPaymentSettlement.runPosPaymentSettlementMigration(pool);
      if (!mSettlement.ok && mSettlement.status !== 'already-applied') {
        throw new Error(`posPaymentSettlement failed: ${mSettlement.errors.join(', ')}`);
      }

      const mExpansion = await prod.posOrderExpansion.runPosOrderExpansionMigration(pool);
      if (!mExpansion.ok && mExpansion.status !== 'already-applied') {
        throw new Error(`posOrderExpansion failed: ${mExpansion.errors.join(', ')}`);
      }

      const mIdemp = await prod.posIdempotency.runPosIdempotencyMigration(pool);
      if (!mIdemp.ok && mIdemp.status !== 'already-applied') {
        throw new Error(`posIdempotency failed: ${mIdemp.errors.join(', ')}`);
      }

      const mTax = await prod.posServiceTax.runPosServiceTaxMigration(pool);
      if (!mTax.ok && mTax.status !== 'already-applied') {
        throw new Error(`posServiceTax failed: ${mTax.errors.join(', ')}`);
      }

      const mReceipt = await prod.posReceiptSnapshot.runPosReceiptSnapshotMigration(pool);
      if (!mReceipt.ok && mReceipt.status !== 'already-applied') {
        throw new Error(`posReceiptSnapshot failed: ${mReceipt.errors.join(', ')}`);
      }

      await prod.mp03c.runProductMasterMp03cMigration(pool);
      await prod.mp04bB1.runProductInventoryMp04bB1Migration(pool);
      await prod.mp04bB3.runProductInventoryMp04bB3Migration(pool);
      log('  skema v3 dan migrasi POS berhasil diinisialisasi');
    });

    // 4. Seed fixtures: Property, User, Stock Locations, Menu Categories, Menu Items
    const fixtures = await step('setup: seed master data properti, lokasi, dan produk POS', async () => {
      // Property
      const propRes = await pool.query(
        `INSERT INTO properties (name, property_code) VALUES ('OAK Prime Resort', 'OAKPR') RETURNING id`
      );
      const propertyId = propRes.rows[0].id;

      // Role & User
      const roleCheck = await pool.query(
        `SELECT id FROM roles WHERE LOWER(TRIM(name)) = 'pos / resto' OR LOWER(TRIM(name)) = 'front office' LIMIT 1`
      );
      let roleId;
      if (roleCheck.rows.length > 0) {
        roleId = roleCheck.rows[0].id;
      } else {
        const insRole = await pool.query(
          `INSERT INTO roles (property_id, name, description, is_system_role)
           VALUES ($1, 'Cashier', 'POS Cashier Role', FALSE) RETURNING id`,
          [propertyId]
        );
        roleId = insRole.rows[0].id;
      }

      const userRes = await pool.query(
        `INSERT INTO users (property_id, role_id, username, full_name, email, password_hash)
         VALUES ($1, $2, 'cashier_01', 'Kasir Utama Resto', 'cashier01@oak.hotel', 'hash')
         RETURNING id`,
        [propertyId, roleId]
      );
      const cashierId = userRes.rows[0].id;

      // Property Payment Instructions (enable TRANSFER and DEBIT)
      await pool.query(
        `INSERT INTO property_payment_instructions (
           property_id, bank_name, bank_account_name, bank_account_number,
           transfer_enabled, debit_enabled
         ) VALUES ($1, 'Bank Mandiri', 'PT OAK Prime Resort', '123-00-9876543-2', TRUE, TRUE)
         ON CONFLICT (property_id) DO UPDATE SET
           bank_name = EXCLUDED.bank_name,
           bank_account_number = EXCLUDED.bank_account_number,
           transfer_enabled = TRUE,
           debit_enabled = TRUE`,
        [propertyId]
      );

      // Stock Locations (Gudang Utama & Outlet Resto POS)
      const locGudangRes = await pool.query(
        `INSERT INTO stock_locations (property_id, code, name, location_type, is_active)
         VALUES ($1, 'WH-MAIN', 'Gudang Persediaan Utama', 'WAREHOUSE', TRUE)
         RETURNING id`,
        [propertyId]
      );
      const whLocationId = locGudangRes.rows[0].id;

      const locOutletRes = await pool.query(
        `INSERT INTO stock_locations (property_id, code, name, location_type, is_active)
         VALUES ($1, 'POS-RESTO', 'Outlet Kasir Restoran', 'POS_OUTLET', TRUE)
         RETURNING id`,
        [propertyId]
      );
      const posOutletLocationId = locOutletRes.rows[0].id;

      // Menu Category
      const catFoodRes = await pool.query(
        `INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, 'Food & Beverage') RETURNING id`,
        [propertyId]
      );
      const catFoodId = catFoodRes.rows[0].id;

      const catServiceRes = await pool.query(
        `INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, 'Service & Facility') RETURNING id`,
        [propertyId]
      );
      const catServiceId = catServiceRes.rows[0].id;

      // Product 1: Kopi Arabika (Tracked, track_stock = TRUE, track_inventory = TRUE)
      const p1Res = await pool.query(
        `INSERT INTO pos_menu_items (
           property_id, category_id, item_code, name, price, is_active, is_sellable_pos,
           base_unit, canonical_base_unit_code, track_stock, track_inventory
         ) VALUES ($1, $2, 'FNB-COF-01', 'Signature Americano', 35000, TRUE, TRUE, 'CUP', 'CUP', TRUE, TRUE)
         RETURNING id`,
        [propertyId, catFoodId]
      );
      const coffeeId = p1Res.rows[0].id;

      // Product 2: Croissant Butter (Tracked, track_inventory = TRUE)
      const p2Res = await pool.query(
        `INSERT INTO pos_menu_items (
           property_id, category_id, item_code, name, price, is_active, is_sellable_pos,
           base_unit, canonical_base_unit_code, track_stock, track_inventory
         ) VALUES ($1, $2, 'FNB-CRS-01', 'Butter Croissant', 25000, TRUE, TRUE, 'PCS', 'PCS', TRUE, TRUE)
         RETURNING id`,
        [propertyId, catFoodId]
      );
      const croissantId = p2Res.rows[0].id;

      // Product 3: Live Music / Corkage Fee (Non-Tracked, track_stock = FALSE, track_inventory = FALSE)
      const p3Res = await pool.query(
        `INSERT INTO pos_menu_items (
           property_id, category_id, item_code, name, price, is_active, is_sellable_pos,
           base_unit, canonical_base_unit_code, track_stock, track_inventory
         ) VALUES ($1, $2, 'SVC-CRK-01', 'Corkage Fee Wine', 100000, TRUE, TRUE, 'SERVICE', NULL, FALSE, FALSE)
         RETURNING id`,
        [propertyId, catServiceId]
      );
      const corkageFeeId = p3Res.rows[0].id;

      // Set initial stock balances for tracked products at POS Outlet
      // Kopi Americano: Initial saldo 50 CUP
      await prod.stockService.recordOpeningBalance(pool, {
        property_id: propertyId,
        product_id: coffeeId,
        location_id: posOutletLocationId,
        quantity: '50.000',
        unit_cost: '12000.00',
        operation_key: `OP-INIT-COF-${propertyId}`,
        notes: 'Saldo awal Kopi Americano di Outlet',
        created_by: cashierId,
      });

      // Croissant Butter: Initial saldo 20 PCS
      await prod.stockService.recordOpeningBalance(pool, {
        property_id: propertyId,
        product_id: croissantId,
        location_id: posOutletLocationId,
        quantity: '20.000',
        unit_cost: '8000.00',
        operation_key: `OP-INIT-CRS-${propertyId}`,
        notes: 'Saldo awal Butter Croissant di Outlet',
        created_by: cashierId,
      });

      return {
        propertyId,
        cashierId,
        whLocationId,
        posOutletLocationId,
        coffeeId,
        croissantId,
        corkageFeeId,
      };
    });

    const createOrderHandler = prod.orderCreateHandler.createPosOrderCreateHandler({
      pool,
      connect: () => pool.connect(),
      release: (client) => client.release(),
      assertPropertyScope: async () => {},
      broadcastEvent: () => {},
    });

    // =========================================================================
    // Skenario 1: Penjualan POS produk tunggal terlacak
    // =========================================================================
    await step('skenario 1: penjualan POS single tracked item (Kopi 2 CUP) memotong stok & mencatat POS_SALE', async () => {
      // 1. Buat pesanan POS: 2 CUP Americano
      const createReq = makeReq({
        body: {
          property_id: fixtures.propertyId,
          table_number: 'Table 01',
          guest_name: 'Budi Santoso',
          location_id: fixtures.posOutletLocationId,
          items: [
            { menu_item_id: fixtures.coffeeId, quantity: 2 },
          ],
        },
      });
      const createRes = makeRes();
      await createOrderHandler(createReq, createRes);

      assert.strictEqual(createRes.statusCode, 201, `Order create harus 201, got ${createRes.statusCode}: ${safeStringify(createRes.body)}`);
      const order = createRes.body.data;
      assert.ok(order && order.id, 'Order harus memiliki ID');
      const orderId = order.id;

      // 2. Bayar pesanan (Settlement CASH)
      const payClient = await pool.connect();
      let payResult;
      try {
        payResult = await prod.settlementService.payPosOrder(payClient, {
          propertyId: fixtures.propertyId,
          orderId,
          idempotencyKey: `PAY-E2E-ORD-${orderId}`,
          paymentMethod: 'CASH',
          methodInput: { cashReceived: 100000 },
          actorUserId: String(fixtures.cashierId),
          actorName: 'Kasir Resto',
        });
      } finally {
        payClient.release();
      }

      assert.strictEqual(payResult.created, true, 'Payment harus berstatus created: true');
      assert.strictEqual(payResult.settlement.status, 'SUCCESS', 'Settlement harus SUCCESS');
      assert.ok(payResult.stockDeduction, 'Harus ada hasil stockDeduction');
      assert.strictEqual(payResult.stockDeduction.replayed, false);
      assert.strictEqual(payResult.stockDeduction.items_deducted.length, 1);
      assert.strictEqual(payResult.stockDeduction.items_deducted[0].product_id, fixtures.coffeeId);
      assert.strictEqual(payResult.stockDeduction.items_deducted[0].quantity, 2);
      assert.strictEqual(payResult.stockDeduction.items_deducted[0].new_balance, '48.000');

      // 3. Verifikasi saldo di tabel stock_balances
      const balRes = await pool.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
        [fixtures.propertyId, fixtures.coffeeId, fixtures.posOutletLocationId]
      );
      assert.strictEqual(balRes.rows.length, 1);
      assert.strictEqual(parseFloat(balRes.rows[0].quantity), 48.0);

      // 4. Verifikasi entri stock_operations dan stock_movements
      const movRes = await pool.query(
        `SELECT so.operation_type, so.notes, sm.quantity_delta, sm.base_unit_code
           FROM stock_movements sm
           JOIN stock_operations so ON so.id = sm.operation_id
          WHERE sm.property_id = $1 AND sm.product_id = $2 AND so.operation_type = 'POS_SALE'`,
        [fixtures.propertyId, fixtures.coffeeId]
      );
      assert.strictEqual(movRes.rows.length, 1);
      assert.strictEqual(movRes.rows[0].operation_type, 'POS_SALE');
      assert.strictEqual(parseFloat(movRes.rows[0].quantity_delta), -2.0);
      assert.strictEqual(movRes.rows[0].base_unit_code, 'CUP');
      assert.ok(movRes.rows[0].notes.includes(`Order #${orderId}`));

      // 5. Verifikasi Kartu Stok (Stock Ledger)
      const ledger = await prod.stockService.getStockLedgerCard(pool, {
        property_id: fixtures.propertyId,
        product_id: fixtures.coffeeId,
        location_id: fixtures.posOutletLocationId,
      });

      assert.strictEqual(ledger.closing_balance, '48.000');
      assert.strictEqual(ledger.current_system_balance, '48.000');
      assert.strictEqual(ledger.movements.length, 2); // 1 OPENING_BALANCE + 1 POS_SALE
      const saleMov = ledger.movements.find((m) => m.operation_type === 'POS_SALE');
      assert.ok(saleMov, 'Harus ada mutasi POS_SALE pada kartu stok');
      assert.strictEqual(saleMov.out_quantity, '2.000');
      assert.strictEqual(saleMov.running_balance, '48.000');

      return { orderId, newBalance: '48.000' };
    });

    // =========================================================================
    // Skenario 2: Pesanan kombinasi campuran (mixed order: tracked + non-tracked)
    // =========================================================================
    await step('skenario 2: pesanan kombinasi (Kopi + Croissant + Jasa Corkage) hanya memotong item terlacak', async () => {
      // Order: 3 CUP Americano (Tracked), 2 PCS Croissant (Tracked), 1 Corkage Fee (Non-Tracked)
      const createReq = makeReq({
        body: {
          property_id: fixtures.propertyId,
          table_number: 'VIP Lounge 2',
          guest_name: 'Ibu Ratna',
          location_id: fixtures.posOutletLocationId,
          items: [
            { menu_item_id: fixtures.coffeeId, quantity: 3 },
            { menu_item_id: fixtures.croissantId, quantity: 2 },
            { menu_item_id: fixtures.corkageFeeId, quantity: 1 },
          ],
        },
      });
      const createRes = makeRes();
      await createOrderHandler(createReq, createRes);

      assert.strictEqual(createRes.statusCode, 201);
      const orderId = createRes.body.data.id;

      // Bayar pesanan
      const payClient = await pool.connect();
      let payResult;
      try {
        payResult = await prod.settlementService.payPosOrder(payClient, {
          propertyId: fixtures.propertyId,
          orderId,
          idempotencyKey: `PAY-E2E-MIX-${orderId}`,
          paymentMethod: 'TRANSFER',
          methodInput: { paymentReference: 'BCA-9876543210' },
          actorUserId: String(fixtures.cashierId),
          actorName: 'Kasir Resto',
        });
      } finally {
        payClient.release();
      }

      assert.strictEqual(payResult.created, true);
      assert.ok(payResult.stockDeduction);
      assert.strictEqual(payResult.stockDeduction.items_deducted.length, 2, 'Hanya 2 item terlacak yang dipotong');
      assert.strictEqual(payResult.stockDeduction.skipped_non_tracked, 1, '1 item jasa di-skip');

      // Cek saldo Kopi: 48 - 3 = 45
      const cofBal = await pool.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
        [fixtures.propertyId, fixtures.coffeeId, fixtures.posOutletLocationId]
      );
      assert.strictEqual(parseFloat(cofBal.rows[0].quantity), 45.0);

      // Cek saldo Croissant: 20 - 2 = 18
      const crsBal = await pool.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
        [fixtures.propertyId, fixtures.croissantId, fixtures.posOutletLocationId]
      );
      assert.strictEqual(parseFloat(crsBal.rows[0].quantity), 18.0);

      // Pastikan Corkage Fee sama sekali tidak memiliki saldo di stock_balances
      const crkBal = await pool.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2`,
        [fixtures.propertyId, fixtures.corkageFeeId]
      );
      assert.strictEqual(crkBal.rows.length, 0, 'Produk jasa non-tracked tidak boleh memiliki row stock_balances');

      return { orderId, cofBalance: '45.000', crsBalance: '18.000' };
    });

    // =========================================================================
    // Skenario 3: Pesanan 100% item non-tracked
    // =========================================================================
    await step('skenario 3: pesanan 100% non-tracked (Corkage Fee) selesai tanpa mencatat mutasi stok', async () => {
      const createReq = makeReq({
        body: {
          property_id: fixtures.propertyId,
          table_number: 'Table 09',
          guest_name: 'Pak Hendra',
          items: [
            { menu_item_id: fixtures.corkageFeeId, quantity: 2 },
          ],
        },
      });
      const createRes = makeRes();
      await createOrderHandler(createReq, createRes);

      assert.strictEqual(createRes.statusCode, 201);
      const orderId = createRes.body.data.id;

      const payClient = await pool.connect();
      let payResult;
      try {
        payResult = await prod.settlementService.payPosOrder(payClient, {
          propertyId: fixtures.propertyId,
          orderId,
          idempotencyKey: `PAY-E2E-NON-${orderId}`,
          paymentMethod: 'CASH',
          methodInput: { cashReceived: 200000 },
          actorUserId: String(fixtures.cashierId),
        });
      } finally {
        payClient.release();
      }

      assert.strictEqual(payResult.created, true);
      assert.ok(payResult.stockDeduction);
      assert.strictEqual(payResult.stockDeduction.items_deducted.length, 0, 'Nol item terlacak dipotong');
      assert.strictEqual(payResult.stockDeduction.skipped_non_tracked, 1);

      // Pastikan tidak ada stock_operations baru yang dibuat untuk order ini
      const opRes = await pool.query(
        `SELECT id FROM stock_operations WHERE property_id = $1 AND operation_key = $2`,
        [fixtures.propertyId, `POS-SALE-${fixtures.propertyId}-${orderId}`]
      );
      assert.strictEqual(opRes.rows.length, 0, 'Tidak boleh ada stock_operations untuk order non-tracked');

      return { orderId, itemsDeducted: 0 };
    });

    // =========================================================================
    // Skenario 4: Proteksi saldo persediaan (insufficient stock) & rollback atomik
    // =========================================================================
    await step('skenario 4: insufficient stock memicu 422 dan me-rollback transaksi pembayaran secara atomik', async () => {
      // Saldo Croissant saat ini: 18 PCS. Order: minta 50 PCS (melebihi saldo)
      const createReq = makeReq({
        body: {
          property_id: fixtures.propertyId,
          table_number: 'Bakery Takeaway',
          guest_name: 'Pemesan Borongan',
          location_id: fixtures.posOutletLocationId,
          items: [
            { menu_item_id: fixtures.croissantId, quantity: 50 },
          ],
        },
      });
      const createRes = makeRes();
      await createOrderHandler(createReq, createRes);

      assert.strictEqual(createRes.statusCode, 201);
      const orderId = createRes.body.data.id;

      // Coba bayar
      const payClient = await pool.connect();
      let errorThrown = null;
      try {
        await prod.settlementService.payPosOrder(payClient, {
          propertyId: fixtures.propertyId,
          orderId,
          idempotencyKey: `PAY-E2E-OOM-${orderId}`,
          paymentMethod: 'CASH',
          methodInput: { cashReceived: 1500000 },
          actorUserId: String(fixtures.cashierId),
        });
      } catch (err) {
        errorThrown = err;
      } finally {
        payClient.release();
      }

      assert.ok(errorThrown, 'Pembayaran harus melempar error karena saldo tidak cukup');
      assert.strictEqual(errorThrown.statusCode, 422, 'Status code harus 422');
      assert.strictEqual(errorThrown.code, 'INSUFFICIENT_STOCK_BALANCE', 'Code harus INSUFFICIENT_STOCK_BALANCE');
      assert.ok(errorThrown.message.includes('Butter Croissant'), 'Pesan error menyebut nama produk');

      // Verifikasi ROLLBACK atomik:
      // 1. Status order tetap OPEN (bukan PAID)
      const ordCheck = await pool.query(`SELECT status FROM pos_orders WHERE id = $1`, [orderId]);
      assert.strictEqual(ordCheck.rows[0].status, 'OPEN', 'Status order harus tetap OPEN');

      // 2. Tidak ada pos_settlements
      const setCheck = await pool.query(`SELECT id FROM pos_settlements WHERE pos_order_id = $1`, [orderId]);
      assert.strictEqual(setCheck.rows.length, 0, 'Tidak boleh ada record settlement');

      // 3. Saldo Croissant tetap utuh di 18 PCS (tidak berubah)
      const crsCheck = await pool.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
        [fixtures.propertyId, fixtures.croissantId, fixtures.posOutletLocationId]
      );
      assert.strictEqual(parseFloat(crsCheck.rows[0].quantity), 18.0, 'Saldo harus tetap utuh 18.000');

      return { orderId, rejectedCode: errorThrown.code, balanceRemained: '18.000' };
    });

    // =========================================================================
    // Skenario 5: Idempotency & Replay Protection
    // =========================================================================
    await step('skenario 5: payment replay idempotency tidak menyebabkan pemotongan ganda', async () => {
      // 1. Buat pesanan baru: 1 CUP Americano
      const createReq = makeReq({
        body: {
          property_id: fixtures.propertyId,
          table_number: 'Bar Counter',
          guest_name: 'Pak Ridwan',
          location_id: fixtures.posOutletLocationId,
          items: [
            { menu_item_id: fixtures.coffeeId, quantity: 1 },
          ],
        },
      });
      const createRes = makeRes();
      await createOrderHandler(createReq, createRes);
      const orderId = createRes.body.data.id;

      // Saldo sebelum bayar: 45 CUP
      const preBal = await pool.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
        [fixtures.propertyId, fixtures.coffeeId, fixtures.posOutletLocationId]
      );
      assert.strictEqual(parseFloat(preBal.rows[0].quantity), 45.0);

      const idempotencyKey = `PAY-IDEM-COF-${orderId}`;

      // Eksekusi pembayaran pertama (first execution)
      const client1 = await pool.connect();
      let res1;
      try {
        res1 = await prod.settlementService.payPosOrder(client1, {
          propertyId: fixtures.propertyId,
          orderId,
          idempotencyKey,
          paymentMethod: 'CASH',
          methodInput: { cashReceived: 50000 },
          actorUserId: String(fixtures.cashierId),
        });
      } finally {
        client1.release();
      }

      assert.strictEqual(res1.created, true);
      assert.strictEqual(res1.replayed, false);

      // Saldo setelah pembayaran pertama: 45 - 1 = 44 CUP
      const postBal1 = await pool.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
        [fixtures.propertyId, fixtures.coffeeId, fixtures.posOutletLocationId]
      );
      assert.strictEqual(parseFloat(postBal1.rows[0].quantity), 44.0);

      // Eksekusi pembayaran kedua dengan Idempotency-Key sama (Replay)
      const client2 = await pool.connect();
      let res2;
      try {
        res2 = await prod.settlementService.payPosOrder(client2, {
          propertyId: fixtures.propertyId,
          orderId,
          idempotencyKey,
          paymentMethod: 'CASH',
          methodInput: { cashReceived: 50000 },
          actorUserId: String(fixtures.cashierId),
        });
      } finally {
        client2.release();
      }

      assert.strictEqual(res2.created, false);
      assert.strictEqual(res2.replayed, true, 'Harus terdeteksi sebagai replay');

      // Saldo setelah replay: HARUS TETAP 44 CUP (TIDAK BERKURANG LAGI!)
      const postBal2 = await pool.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
        [fixtures.propertyId, fixtures.coffeeId, fixtures.posOutletLocationId]
      );
      assert.strictEqual(parseFloat(postBal2.rows[0].quantity), 44.0, 'Replay tidak boleh memotong saldo lagi');

      // Pastikan jumlah entri pergerakan stok untuk order ini tetap 1
      const movsCount = await pool.query(
        `SELECT COUNT(*) AS total FROM stock_movements sm
           JOIN stock_operations so ON so.id = sm.operation_id
          WHERE sm.property_id = $1 AND so.operation_key = $2`,
        [fixtures.propertyId, `POS-SALE-${fixtures.propertyId}-${orderId}`]
      );
      assert.strictEqual(parseInt(movsCount.rows[0].total, 10), 1, 'Hanya boleh ada 1 mutasi stok');

      return { orderId, replayed: true, finalBalance: '44.000' };
    });

    // =========================================================================
    // Skenario 6: Verifikasi Invarian Persediaan & Audit Trail
    // =========================================================================
    await step('skenario 6: verifikasi invarian drift = 0, running balance konsisten, dan integritas ledger', async () => {
      // 1. Tidak ada saldo negatif di stock_balances
      const negBalances = await pool.query(`SELECT * FROM stock_balances WHERE quantity < 0`);
      assert.strictEqual(negBalances.rows.length, 0, 'Invarian: tidak boleh ada quantity < 0 di stock_balances');

      // 2. Kopi Americano: Initial 50 - 2 (Order 1) - 3 (Order 2) - 1 (Order 4) = 44.000
      const cofSum = await pool.query(
        `SELECT COALESCE(SUM(quantity_delta), 0) AS total_delta
           FROM stock_movements
          WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
        [fixtures.propertyId, fixtures.coffeeId, fixtures.posOutletLocationId]
      );
      const cofBal = await pool.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
        [fixtures.propertyId, fixtures.coffeeId, fixtures.posOutletLocationId]
      );
      assert.strictEqual(parseFloat(cofSum.rows[0].total_delta), 44.0);
      assert.strictEqual(parseFloat(cofBal.rows[0].quantity), 44.0);

      // 3. Croissant: Initial 20 - 2 (Order 2) = 18.000
      const crsSum = await pool.query(
        `SELECT COALESCE(SUM(quantity_delta), 0) AS total_delta
           FROM stock_movements
          WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
        [fixtures.propertyId, fixtures.croissantId, fixtures.posOutletLocationId]
      );
      const crsBal = await pool.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
        [fixtures.propertyId, fixtures.croissantId, fixtures.posOutletLocationId]
      );
      assert.strictEqual(parseFloat(crsSum.rows[0].total_delta), 18.0);
      assert.strictEqual(parseFloat(crsBal.rows[0].quantity), 18.0);

      // 4. Verifikasi Kartu Stok lengkap mencocokkan running balance
      const cofLedger = await prod.stockService.getStockLedgerCard(pool, {
        property_id: fixtures.propertyId,
        product_id: fixtures.coffeeId,
        location_id: fixtures.posOutletLocationId,
      });
      assert.strictEqual(cofLedger.closing_balance, '44.000');
      assert.strictEqual(cofLedger.current_system_balance, '44.000');
      assert.strictEqual(cofLedger.movements.length, 4); // 1 Opening + 3 POS_SALE

      // 5. Verifikasi Laporan Valuasi Persediaan
      const valuation = await prod.stockService.getInventoryValuationReport(pool, {
        property_id: fixtures.propertyId,
        location_id: fixtures.posOutletLocationId,
      });
      assert.strictEqual(valuation.summary.total_items, 2);
      assert.strictEqual(valuation.items.length, 2);
      const cofVal = valuation.items.find((i) => i.product_id === fixtures.coffeeId);
      assert.ok(cofVal);
      assert.strictEqual(cofVal.quantity, '44.000');

      return {
        drift: 0,
        coffeeFinalBalance: '44.000',
        croissantFinalBalance: '18.000',
        valuationItemCount: valuation.summary.total_items,
      };
    });

    log('========================================================================');
    log('HASIL PENGUJIAN: SELURUH SKENARIO E2E POS SALE LULUS (PASS 100%)');
    log('========================================================================');
    for (const r of results) {
      log(`  - [PASS] ${r.name} (${r.durationMs} ms)`);
    }

    return true;
  } finally {
    await closeAllPools();
    if (container && container.name) {
      log(`Membersihkan container docker: ${container.name}`);
      stopContainer(container.name);
      log('Container docker dibersihkan tuntas.');
    }
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('FATAL TEST FAILURE:', err);
    process.exit(1);
  });
