'use strict';

/**
 * OAK HIMS — MP-04B Batch 3 PostgreSQL Integration Test
 * =====================================================
 *
 * Memverifikasi Penerimaan Barang Pembelian (Goods Receipt per Baris):
 *   - Skenario 1: Penerimaan penuh (100% order) berhasil menambah mutasi ledger & stock_balances, status menjadi DITERIMA_LENGKAP.
 *   - Skenario 2: Penerimaan parsial (pesan 100, terima 40) saldo bertambah +40, status DITERIMA_SEBAGIAN;
 *                 penerimaan kedua +60 menyelesaikan status menjadi DITERIMA_LENGKAP.
 *   - Skenario 3: Penerimaan melebihi plafon PO (pesan 100, coba terima 105) ditolak dengan 400 RECEIPT_QUANTITY_EXCEEDS_ORDERED (R-07).
 *                 Penerimaan parsial kedua yang melebihi sisa pesanan juga ditolak.
 *   - Skenario 4: Penerimaan via kemasan (pesan 10 Dus @ 24) menambah saldo tepat 240.000 botol di stock_balances (R-06).
 *   - Skenario 5: Baris non-stok / service tidak dicatat ke stock_movements, namun tetap tercatat di binding penerimaan administratif (R-03).
 *   - Skenario 6: Void finansial tidak membalik atau menghapus saldo fisik barang yang sudah diterima (R-02 Anti-Void Reversal).
 *   - Skenario 7: Idempotent replay dengan operation_key sama mengembalikan respons identik tanpa menduplikasi stok (R-05).
 *                 Mismatched payload dengan operation_key sama ditolak 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH.
 *   - Skenario 8 & Invariants:
 *                 - Query riwayat penerimaan via GET /api/pos/stock/purchase-receipts
 *                 - Trigger append-only menolak UPDATE dan DELETE pada stock_movements
 *                 - Saldo stock_balances tepat sama dengan akumulasi stock_movements
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
const TEST_DB = 'oak_hims_mp04b_b3_test';
const TEST_USER = 'oakmp04bb3_runner';
const CONTAINER_PREFIX = 'oak-hims-mp04b-b3-test-';

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
  const txServicePath = path.join(BACKEND_DIR, 'dist', 'domains', 'transactions', 'transactionService.js');

  for (const p of [
    mp03cMigrationPath,
    mp04bB1MigrationPath,
    mp04bB3MigrationPath,
    stockServicePath,
    unitsPath,
    stage1Path,
    txServicePath,
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
  const txService = require(txServicePath);

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
    txService,
    interceptedCalls,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PostgreSQL Helpers & Mock HTTP Request/Response
// ─────────────────────────────────────────────────────────────────────────────
let pg = null;
const allPools = [];

function makePoolConfig(applicationName) {
  return {
    host: '127.0.0.1',
    port: globalThis.__MP04B_B3_PORT__,
    user: TEST_USER,
    password: globalThis.__MP04B_B3_PASSWORD__,
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
    const client = new pg.Client({ ...makePoolConfig('mp04b-b3-readiness'), connectionTimeoutMillis: 3000 });
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
  log('OAK HIMS — MP-04B Batch 3: Penerimaan Barang Pembelian (Goods Receipt)');
  log('========================================================================');

  let container = null;

  try {
    // 1. Guard & load production modules
    const prod = await step('preflight: modul produksi & dotenv stub guard', async () => {
      const p = loadProductionModules();
      pg = require(require.resolve('pg', { paths: [BACKEND_DIR] }));
      return {
        interceptedCalls: p.interceptedCalls,
        stockService: p.stockService,
        units: p.units,
        stage1: p.stage1,
        txService: p.txService,
      };
    });

    // 2. Start PostgreSQL container
    container = await step('preflight: container PostgreSQL 15 terisolasi', async () => {
      const c = startContainer();
      const port = resolveHostPort(c.name);
      globalThis.__MP04B_B3_PORT__ = port;
      globalThis.__MP04B_B3_PASSWORD__ = c.password;
      await waitForPostgres(90000);
      return { name: c.name, port };
    });

    const pool = newPool('mp04b-b3-test-runner');

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
          price DECIMAL(12,2),
          is_active BOOLEAN DEFAULT TRUE,
          is_sellable_pos BOOLEAN NOT NULL DEFAULT TRUE,
          base_unit VARCHAR(50)
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
      `);

      const p = loadProductionModules();
      await p.mp03cMigration.runProductMasterMp03cMigration(pool);
      await p.mp04bB1Migration.runProductInventoryMp04bB1Migration(pool);
      await p.mp04bB3Migration.runProductInventoryMp04bB3Migration(pool);

      // Seed initial data
      await pool.query(`
        INSERT INTO properties (id, name) VALUES
          (1, 'Hotel OAK Seminyak'),
          (2, 'Hotel OAK Canggu');

        INSERT INTO users (id, username, full_name) VALUES
          (1, 'admin_pos', 'Admin POS Staff'),
          (2, 'purchasing_staff', 'Staff Pembelian');

        INSERT INTO stock_locations (id, property_id, code, name, location_type, is_active) VALUES
          (10, 1, 'WH-01', 'Gudang Utama Seminyak', 'WAREHOUSE', TRUE),
          (11, 1, 'KIT-01', 'Dapur Seminyak', 'KITCHEN', TRUE),
          (12, 1, 'BAR-01', 'Bar Seminyak', 'POS_OUTLET', TRUE),
          (13, 1, 'OLD-01', 'Gudang Lama (Nonaktif)', 'WAREHOUSE', FALSE),
          (20, 2, 'WH-02', 'Gudang Canggu', 'WAREHOUSE', TRUE);

        -- Produk:
        -- 201: Air Mineral 600ml (track_stock = TRUE, base_unit = BOTOL)
        INSERT INTO pos_menu_items (id, property_id, name, price, base_unit, canonical_base_unit_code, track_stock) VALUES
          (201, 1, 'Air Mineral 600ml', 10000, 'botol', 'BOTOL', TRUE),
          (202, 1, 'Beras Premium Ramos', 15000, 'kg', 'KG', TRUE),
          (203, 1, 'Kopi Robusta Beans', 30000, 'gram', 'GRAM', TRUE),
          (204, 1, 'Jasa Angkut dan Bongkar', 50000, 'pcs', 'PCS', FALSE);

        -- Kemasan untuk Produk 201: DUS24 = 24 BOTOL
        INSERT INTO product_packaging_conversions (
          id, property_id, menu_item_id, packaging_code, packaging_label, base_unit_code, to_base_factor, idempotency_key
        ) VALUES (
          301, 1, 201, 'DUS24', 'Dus 24 Botol', 'BOTOL', 24.000, 'SEED-PPC-201-DUS24'
        );

        -- Kemasan untuk Produk 202: SAK50 = 50 KG
        INSERT INTO product_packaging_conversions (
          id, property_id, menu_item_id, packaging_code, packaging_label, base_unit_code, to_base_factor, idempotency_key
        ) VALUES (
          302, 1, 202, 'SAK50', 'Karung Sak 50 KG', 'KG', 50.000, 'SEED-PPC-202-SAK50'
        );

        -- Seed Transaksi Pembelian untuk pengujian:
        -- PO-1001: 1 baris stok (50 BOTOL Air Mineral)
        INSERT INTO transactions (id, property_id, transaction_no, transaction_type, source_type, category_code, category_name, description, amount, net_amount, receiving_status)
        VALUES (1001, 1, 'PO-2026-0001', 'PURCHASE', 'MANUAL_PURCHASE', 'BEV', 'Beverage', 'Pembelian Air Mineral', 250000, 250000, 'BELUM_DITERIMA');

        INSERT INTO transaction_lines (id, property_id, transaction_id, product_id, description_snapshot, quantity, unit, unit_price, line_total)
        VALUES (5001, 1, 1001, 201, 'Air Mineral 600ml', 50.000, 'botol', 5000, 250000);

        -- PO-1002: 1 baris stok (100 KG Beras)
        INSERT INTO transactions (id, property_id, transaction_no, transaction_type, source_type, category_code, category_name, description, amount, net_amount, receiving_status)
        VALUES (1002, 1, 'PO-2026-0002', 'PURCHASE', 'MANUAL_PURCHASE', 'FOOD', 'Food Supplies', 'Pembelian Beras Premium', 1500000, 1500000, 'BELUM_DITERIMA');

        INSERT INTO transaction_lines (id, property_id, transaction_id, product_id, description_snapshot, quantity, unit, unit_price, line_total)
        VALUES (5002, 1, 1002, 202, 'Beras Premium Ramos', 100.000, 'kg', 15000, 1500000);

        -- PO-1003: 1 baris stok (100 GRAM Kopi)
        INSERT INTO transactions (id, property_id, transaction_no, transaction_type, source_type, category_code, category_name, description, amount, net_amount, receiving_status)
        VALUES (1003, 1, 'PO-2026-0003', 'PURCHASE', 'MANUAL_PURCHASE', 'BEV', 'Coffee', 'Pembelian Kopi Robusta', 300000, 300000, 'BELUM_DITERIMA');

        INSERT INTO transaction_lines (id, property_id, transaction_id, product_id, description_snapshot, quantity, unit, unit_price, line_total)
        VALUES (5003, 1, 1003, 203, 'Kopi Robusta Beans', 100.000, 'gram', 3000, 300000);

        -- PO-1004: 1 baris stok via kemasan (10 DUS Air Mineral @ 24 BOTOL = 240 BOTOL)
        INSERT INTO transactions (id, property_id, transaction_no, transaction_type, source_type, category_code, category_name, description, amount, net_amount, receiving_status)
        VALUES (1004, 1, 'PO-2026-0004', 'PURCHASE', 'MANUAL_PURCHASE', 'BEV', 'Beverage', 'Pembelian Air Mineral Dus', 1200000, 1200000, 'BELUM_DITERIMA');

        INSERT INTO transaction_lines (id, property_id, transaction_id, product_id, description_snapshot, quantity, unit, unit_price, line_total)
        VALUES (5004, 1, 1004, 201, 'Air Mineral 600ml Dus24', 10.000, 'dus', 120000, 1200000);

        -- PO-1005: Campuran 2 baris (Baris 1 = 20 KG Beras (STOCK), Baris 2 = 1 Jasa Angkut (SERVICE))
        INSERT INTO transactions (id, property_id, transaction_no, transaction_type, source_type, category_code, category_name, description, amount, net_amount, receiving_status)
        VALUES (1005, 1, 'PO-2026-0005', 'PURCHASE', 'MANUAL_PURCHASE', 'FOOD', 'Food and Logistics', 'Pembelian Bahan & Jasa Kirim', 350000, 350000, 'BELUM_DITERIMA');

        INSERT INTO transaction_lines (id, property_id, transaction_id, product_id, description_snapshot, quantity, unit, unit_price, line_total)
        VALUES
          (5005, 1, 1005, 202, 'Beras Premium Ramos', 20.000, 'kg', 15000, 300000),
          (5006, 1, 1005, 204, 'Jasa Angkut dan Bongkar', 1.000, 'pcs', 50000, 50000);

        -- PO-1006: 1 baris stok untuk uji void finansial R-02 (30 BOTOL Air Mineral)
        INSERT INTO transactions (id, property_id, transaction_no, transaction_type, source_type, category_code, category_name, description, amount, net_amount, receiving_status)
        VALUES (1006, 1, 'PO-2026-0006', 'PURCHASE', 'MANUAL_PURCHASE', 'BEV', 'Beverage', 'Pembelian Air Mineral Void Test', 150000, 150000, 'BELUM_DITERIMA');

        INSERT INTO transaction_lines (id, property_id, transaction_id, product_id, description_snapshot, quantity, unit, unit_price, line_total)
        VALUES (5007, 1, 1006, 201, 'Air Mineral 600ml', 30.000, 'botol', 5000, 150000);

        -- PO-1007: 1 baris stok untuk uji idempotensi R-05 (15 BOTOL Air Mineral)
        INSERT INTO transactions (id, property_id, transaction_no, transaction_type, source_type, category_code, category_name, description, amount, net_amount, receiving_status)
        VALUES (1007, 1, 'PO-2026-0007', 'PURCHASE', 'MANUAL_PURCHASE', 'BEV', 'Beverage', 'Pembelian Air Mineral Idempotency Test', 75000, 75000, 'BELUM_DITERIMA');

        INSERT INTO transaction_lines (id, property_id, transaction_id, product_id, description_snapshot, quantity, unit, unit_price, line_total)
        VALUES (5008, 1, 1007, 201, 'Air Mineral 600ml', 15.000, 'botol', 5000, 75000);
      `);

      return { seededProperties: 2, seededProducts: 4, seededLocations: 5, seededTransactions: 7 };
    });

    const receiptHandler = prod.stockService.createPurchaseReceiptHandler(makeDeps(pool));
    const receiptQueryHandler = prod.stockService.createPurchaseReceiptsQueryHandler(makeDeps(pool));

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 1: Penerimaan Penuh (100% order) -> Ledger + Saldo + DITERIMA_LENGKAP
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 1: Penerimaan penuh (100% order) berhasil menambah mutasi & saldo, status DITERIMA_LENGKAP', async () => {
      const req = makeReq({
        body: {
          property_id: 1,
          transaction_id: 1001,
          location_id: 10,
          operation_key: 'OP-REC-PO1001-FULL',
          created_by: 2,
          notes: 'Penerimaan penuh PO-1001 di Gudang Utama Seminyak',
          received_lines: [
            {
              transaction_line_id: 5001,
              product_id: 201,
              location_id: 10,
              quantity_received: '50.000',
            },
          ],
        },
      });
      const res = makeRes();
      await receiptHandler(req, res);

      assert.ok([200, 201].includes(res.statusCode), `Expected 200 but got ${res.statusCode}: ${safeStringify(res.body)}`);
      assert.ok(["OK", "SUCCESS"].includes(res.body.status));
      assert.strictEqual(res.body.data.receiving_status, 'DITERIMA_LENGKAP');
      assert.strictEqual(res.body.data.is_replay, false);

      // Verifikasi ledger stock_operations
      const opRes = await pool.query(
        'SELECT * FROM stock_operations WHERE property_id = 1 AND transaction_id = 1001 AND operation_type = $1',
        ['PURCHASE_RECEIPT']
      );
      assert.strictEqual(opRes.rowCount, 1);
      assert.strictEqual(opRes.rows[0].operation_key, 'OP-REC-PO1001-FULL');

      // Verifikasi stock_movements
      const movRes = await pool.query(
        'SELECT * FROM stock_movements WHERE operation_id = $1',
        [opRes.rows[0].id]
      );
      assert.strictEqual(movRes.rowCount, 1);
      assert.strictEqual(String(movRes.rows[0].quantity_delta), '50.000');
      assert.strictEqual(Number(movRes.rows[0].location_id), 10);
      assert.strictEqual(Number(movRes.rows[0].product_id), 201);

      // Verifikasi stock_balances
      const balRes = await pool.query(
        'SELECT quantity FROM stock_balances WHERE property_id = 1 AND product_id = 201 AND location_id = 10'
      );
      assert.strictEqual(balRes.rowCount, 1);
      assert.strictEqual(String(balRes.rows[0].quantity), '50.000');

      // Verifikasi stock_purchase_line_bindings
      const bindRes = await pool.query(
        'SELECT * FROM stock_purchase_line_bindings WHERE property_id = 1 AND transaction_id = 1001 AND transaction_line_id = 5001'
      );
      assert.strictEqual(bindRes.rowCount, 1);
      assert.strictEqual(String(bindRes.rows[0].received_quantity), '50.000');
      assert.strictEqual(String(bindRes.rows[0].ordered_quantity), '50.000');

      // Verifikasi transactions receiving_status
      const txRes = await pool.query('SELECT receiving_status, received_at FROM transactions WHERE id = 1001');
      assert.strictEqual(txRes.rows[0].receiving_status, 'DITERIMA_LENGKAP');
      assert.ok(txRes.rows[0].received_at !== null);

      return { balanceAfter: balRes.rows[0].quantity, receivingStatus: txRes.rows[0].receiving_status };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 2: Penerimaan Parsial (Pesan 100, terima 40 -> DITERIMA_SEBAGIAN, terima 60 -> DITERIMA_LENGKAP)
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 2: Penerimaan parsial (pesan 100, terima 40 lalu 60) dan transisi status', async () => {
      // Bagian 1: Terima 40.000
      const req1 = makeReq({
        body: {
          property_id: 1,
          transaction_id: 1002,
          location_id: 10,
          operation_key: 'OP-REC-PO1002-PART1',
          created_by: 2,
          received_lines: [
            {
              transaction_line_id: 5002,
              product_id: 202,
              location_id: 10,
              quantity_received: '40.000',
            },
          ],
        },
      });
      const res1 = makeRes();
      await receiptHandler(req1, res1);

      assert.ok([200, 201].includes(res1.statusCode));
      assert.strictEqual(res1.body.data.receiving_status, 'DITERIMA_SEBAGIAN');

      const balPart1 = await pool.query(
        'SELECT quantity FROM stock_balances WHERE property_id = 1 AND product_id = 202 AND location_id = 10'
      );
      assert.strictEqual(String(balPart1.rows[0].quantity), '40.000');

      const txPart1 = await pool.query('SELECT receiving_status FROM transactions WHERE id = 1002');
      assert.strictEqual(txPart1.rows[0].receiving_status, 'DITERIMA_SEBAGIAN');

      // Bagian 2: Terima sisa 60.000
      const req2 = makeReq({
        body: {
          property_id: 1,
          transaction_id: 1002,
          location_id: 10,
          operation_key: 'OP-REC-PO1002-PART2',
          created_by: 2,
          received_lines: [
            {
              transaction_line_id: 5002,
              product_id: 202,
              location_id: 10,
              quantity_received: '60.000',
            },
          ],
        },
      });
      const res2 = makeRes();
      await receiptHandler(req2, res2);

      assert.ok([200, 201].includes(res2.statusCode));
      assert.strictEqual(res2.body.data.receiving_status, 'DITERIMA_LENGKAP');

      const balPart2 = await pool.query(
        'SELECT quantity FROM stock_balances WHERE property_id = 1 AND product_id = 202 AND location_id = 10'
      );
      assert.strictEqual(String(balPart2.rows[0].quantity), '100.000');

      const bindPart2 = await pool.query(
        'SELECT received_quantity, ordered_quantity FROM stock_purchase_line_bindings WHERE transaction_id = 1002'
      );
      assert.strictEqual(String(bindPart2.rows[0].received_quantity), '100.000');

      const txPart2 = await pool.query('SELECT receiving_status FROM transactions WHERE id = 1002');
      assert.strictEqual(txPart2.rows[0].receiving_status, 'DITERIMA_LENGKAP');

      return { cumulativeBalance: balPart2.rows[0].quantity, finalStatus: txPart2.rows[0].receiving_status };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 3: Plafon Kuantitas PO (R-07) - Penolakan Penerimaan Melebihi Pesanan
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 3: Penerimaan melebihi plafon PO ditolak dengan 400 RECEIPT_QUANTITY_EXCEEDS_ORDERED (R-07)', async () => {
      // 1. Coba terima 105.000 pada PO-1003 (pesanan cuma 100.000)
      const overReq = makeReq({
        body: {
          property_id: 1,
          transaction_id: 1003,
          location_id: 10,
          operation_key: 'OP-REC-PO1003-OVER',
          created_by: 2,
          received_lines: [
            {
              transaction_line_id: 5003,
              product_id: 203,
              location_id: 10,
              quantity_received: '105.000',
            },
          ],
        },
      });
      const overRes = makeRes();
      await receiptHandler(overReq, overRes);

      assert.strictEqual(overRes.statusCode, 400);
      assert.strictEqual(overRes.body.code, 'RECEIPT_QUANTITY_EXCEEDS_ORDERED');

      // Saldo belum berubah
      const balEmpty = await pool.query(
        'SELECT quantity FROM stock_balances WHERE property_id = 1 AND product_id = 203 AND location_id = 10'
      );
      assert.strictEqual(balEmpty.rowCount, 0, 'Saldo harus tetap 0/belum ada');

      // 2. Sekarang terima 90.000 sah
      const validReq = makeReq({
        body: {
          property_id: 1,
          transaction_id: 1003,
          location_id: 10,
          operation_key: 'OP-REC-PO1003-PART1',
          created_by: 2,
          received_lines: [
            {
              transaction_line_id: 5003,
              product_id: 203,
              location_id: 10,
              quantity_received: '90.000',
            },
          ],
        },
      });
      const validRes = makeRes();
      await receiptHandler(validReq, validRes);
      assert.ok([200, 201].includes(validRes.statusCode));

      // 3. Coba terima 15.000 (sisa tinggal 10.000) -> harus ditolak lagi
      const overPart2Req = makeReq({
        body: {
          property_id: 1,
          transaction_id: 1003,
          location_id: 10,
          operation_key: 'OP-REC-PO1003-OVER2',
          created_by: 2,
          received_lines: [
            {
              transaction_line_id: 5003,
              product_id: 203,
              location_id: 10,
              quantity_received: '15.000',
            },
          ],
        },
      });
      const overPart2Res = makeRes();
      await receiptHandler(overPart2Req, overPart2Res);

      assert.strictEqual(overPart2Res.statusCode, 400);
      assert.strictEqual(overPart2Res.body.code, 'RECEIPT_QUANTITY_EXCEEDS_ORDERED');

      // Saldo tetap 90.000
      const balAfter = await pool.query(
        'SELECT quantity FROM stock_balances WHERE property_id = 1 AND product_id = 203 AND location_id = 10'
      );
      assert.strictEqual(String(balAfter.rows[0].quantity), '90.000');

      return { rejectedDirect: true, rejectedPartialOverage: true, preservedBalance: balAfter.rows[0].quantity };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 4: Penerimaan via Kemasan (R-06) - 10 Dus @ 24 = 240 Botol
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 4: Penerimaan via kemasan (10 Dus @ 24) menambah saldo tepat 240.000 botol (R-06)', async () => {
      // Saldo awal produk 201 di WH-01 adalah 50.000 (dari skenario 1)
      const prevBalRes = await pool.query(
        'SELECT quantity FROM stock_balances WHERE property_id = 1 AND product_id = 201 AND location_id = 10'
      );
      const prevQty = Number(prevBalRes.rows[0].quantity);

      const req = makeReq({
        body: {
          property_id: 1,
          transaction_id: 1004,
          location_id: 10,
          operation_key: 'OP-REC-PO1004-PKG',
          created_by: 2,
          received_lines: [
            {
              transaction_line_id: 5004,
              product_id: 201,
              location_id: 10,
              quantity_received: '10.000',
              packaging_id: 301, // DUS24: factor 24.000
            },
          ],
        },
      });
      const res = makeRes();
      await receiptHandler(req, res);

      assert.ok([200, 201].includes(res.statusCode));
      assert.strictEqual(res.body.data.receiving_status, 'DITERIMA_LENGKAP');

      // Verifikasi movement snapshot kemasan
      const movRes = await pool.query(
        `SELECT sm.* FROM stock_movements sm
           JOIN stock_operations so ON so.id = sm.operation_id
          WHERE so.operation_key = 'OP-REC-PO1004-PKG'`
      );
      assert.strictEqual(movRes.rowCount, 1);
      assert.strictEqual(String(movRes.rows[0].quantity_delta), '240.000', 'Delta harus 10 x 24 = 240.000');
      assert.strictEqual(Number(movRes.rows[0].packaging_id), 301);
      assert.strictEqual(movRes.rows[0].packaging_code, 'DUS24');
      assert.strictEqual(movRes.rows[0].packaging_label, 'Dus 24 Botol');

      // Verifikasi saldo bertambah tepat 240.000
      const newBalRes = await pool.query(
        'SELECT quantity FROM stock_balances WHERE property_id = 1 AND product_id = 201 AND location_id = 10'
      );
      const expectedNewBal = (prevQty + 240).toFixed(3);
      assert.strictEqual(String(newBalRes.rows[0].quantity), expectedNewBal);

      // Verifikasi received_quantity pada binding adalah 10.000 (sesuai unit kemasan PO)
      const bindRes = await pool.query(
        'SELECT received_quantity, packaging_id FROM stock_purchase_line_bindings WHERE transaction_id = 1004'
      );
      assert.strictEqual(String(bindRes.rows[0].received_quantity), '10.000');
      assert.strictEqual(Number(bindRes.rows[0].packaging_id), 301);

      return { packagingDelta: movRes.rows[0].quantity_delta, totalBalance: newBalRes.rows[0].quantity };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 5: Baris Non-Stok / Service Tidak Menambah Mutasi Ledger (R-03)
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 5: Baris non-stok / service tidak dicatat ke stock_movements (R-03)', async () => {
      // Inisialisasi binding eksplisit dengan baris 1: STOCK, baris 2: SERVICE
      await prod.stockService.bindPurchaseLines(pool, {
        property_id: 1,
        transaction_id: 1005,
        lines: [
          {
            transaction_line_id: 5005,
            line_type: 'STOCK',
            product_id: 202,
            destination_location_id: 10,
            ordered_quantity: '20.000',
            base_unit_code: 'KG',
          },
          {
            transaction_line_id: 5006,
            line_type: 'SERVICE',
            product_id: 204,
            destination_location_id: 10,
            ordered_quantity: '1.000',
            base_unit_code: 'PCS',
          },
        ],
      });

      const req = makeReq({
        body: {
          property_id: 1,
          transaction_id: 1005,
          location_id: 10,
          operation_key: 'OP-REC-PO1005-MIXED',
          created_by: 2,
          received_lines: [
            {
              transaction_line_id: 5005,
              product_id: 202,
              location_id: 10,
              quantity_received: '20.000',
            },
            {
              transaction_line_id: 5006,
              product_id: 204,
              location_id: 10,
              quantity_received: '1.000',
            },
          ],
        },
      });
      const res = makeRes();
      await receiptHandler(req, res);

      assert.ok([200, 201].includes(res.statusCode));
      assert.strictEqual(res.body.data.receiving_status, 'DITERIMA_LENGKAP');

      // Pastikan stock_movements HANYA ada untuk baris STOCK (produk 202), bukan produk 204
      const movRes = await pool.query(
        `SELECT sm.* FROM stock_movements sm
           JOIN stock_operations so ON so.id = sm.operation_id
          WHERE so.operation_key = 'OP-REC-PO1005-MIXED'`
      );
      assert.strictEqual(movRes.rowCount, 1, 'Hanya boleh 1 movement untuk baris STOCK');
      assert.strictEqual(Number(movRes.rows[0].product_id), 202);
      assert.strictEqual(String(movRes.rows[0].quantity_delta), '20.000');

      // Pastikan tidak ada record di stock_balances untuk produk 204
      const balService = await pool.query(
        'SELECT * FROM stock_balances WHERE property_id = 1 AND product_id = 204'
      );
      assert.strictEqual(balService.rowCount, 0, 'Produk service/non-tracked tidak boleh memiliki saldo fisik');

      // Binding administratif untuk kedua baris tetap terupdate
      const bindAll = await pool.query(
        'SELECT transaction_line_id, line_type, received_quantity FROM stock_purchase_line_bindings WHERE transaction_id = 1005 ORDER BY transaction_line_id'
      );
      assert.strictEqual(bindAll.rowCount, 2);
      assert.strictEqual(bindAll.rows[0].line_type, 'STOCK');
      assert.strictEqual(String(bindAll.rows[0].received_quantity), '20.000');
      assert.strictEqual(bindAll.rows[1].line_type, 'SERVICE');
      assert.strictEqual(String(bindAll.rows[1].received_quantity), '1.000');

      return { stockMovementCount: movRes.rowCount, serviceTracked: false };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 6: Void Finansial Tidak Membalik Mutasi / Saldo Fisik (R-02)
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 6: Void finansial tidak membalik atau menghapus saldo fisik barang yang sudah diterima (R-02)', async () => {
      // 1. Terima barang PO-1006
      const req = makeReq({
        body: {
          property_id: 1,
          transaction_id: 1006,
          location_id: 10,
          operation_key: 'OP-REC-PO1006-PREVOID',
          created_by: 2,
          received_lines: [
            {
              transaction_line_id: 5007,
              product_id: 201,
              location_id: 10,
              quantity_received: '30.000',
            },
          ],
        },
      });
      const res = makeRes();
      await receiptHandler(req, res);
      assert.ok([200, 201].includes(res.statusCode));

      // Catat saldo dan count movement sebelum void finansial
      const balBefore = await pool.query(
        'SELECT quantity FROM stock_balances WHERE property_id = 1 AND product_id = 201 AND location_id = 10'
      );
      const qtyBefore = balBefore.rows[0].quantity;

      const movBefore = await pool.query(
        `SELECT COUNT(*) AS c FROM stock_movements sm
           JOIN stock_operations so ON so.id = sm.operation_id
          WHERE so.operation_key = 'OP-REC-PO1006-PREVOID'`
      );
      const movCountBefore = Number(movBefore.rows[0].c);
      assert.strictEqual(movCountBefore, 1);

      // 2. Lakukan Void Finansial via voidTransaction
      const voidResult = await prod.txService.voidTransaction(pool, 1, 1006, {
        reason: 'Uji R-02 Pembatalan Finansial PO',
        actorName: 'Admin POS Staff',
        actorUserId: '1',
      });

      assert.strictEqual(voidResult.original.transaction_status, 'VOIDED');

      // 3. Verifikasi R-02: Mutasi fisik dan saldo tetap utuh!
      const balAfter = await pool.query(
        'SELECT quantity FROM stock_balances WHERE property_id = 1 AND product_id = 201 AND location_id = 10'
      );
      assert.strictEqual(
        String(balAfter.rows[0].quantity),
        String(qtyBefore),
        'Saldo fisik tidak boleh berubah akibat void finansial transaksi'
      );

      const movAfter = await pool.query(
        `SELECT COUNT(*) AS c FROM stock_movements sm
           JOIN stock_operations so ON so.id = sm.operation_id
          WHERE so.operation_key = 'OP-REC-PO1006-PREVOID'`
      );
      assert.strictEqual(Number(movAfter.rows[0].c), 1, 'Record pergerakan stok penerimaan fisik tidak boleh dihapus');

      const bindCheck = await pool.query(
        'SELECT received_quantity FROM stock_purchase_line_bindings WHERE transaction_id = 1006'
      );
      assert.strictEqual(String(bindCheck.rows[0].received_quantity), '30.000', 'Catatan kuantitas diterima fisik tetap 30.000');

      return { financialStatus: voidResult.original.transaction_status, physicalBalancePreserved: balAfter.rows[0].quantity };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 7: Idempotent Replay & Mismatched Fingerprint Detection (R-05)
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 7: Idempotent replay mengembalikan data identik tanpa menduplikasi stok (R-05)', async () => {
      const payload = {
        property_id: 1,
        transaction_id: 1007,
        location_id: 10,
        operation_key: 'OP-REC-PO1007-IDEMP',
        created_by: 2,
        received_lines: [
          {
            transaction_line_id: 5008,
            product_id: 201,
            location_id: 10,
            quantity_received: '15.000',
          },
        ],
      };

      // 1. Panggilan Pertama
      const req1 = makeReq({ body: payload });
      const res1 = makeRes();
      await receiptHandler(req1, res1);

      assert.ok([200, 201].includes(res1.statusCode));
      assert.strictEqual(res1.body.data.is_replay, false);
      const initialOpId = res1.body.data.operation_id;

      const balBeforeReplay = await pool.query(
        'SELECT quantity FROM stock_balances WHERE property_id = 1 AND product_id = 201 AND location_id = 10'
      );

      // 2. Replay dengan operation_key dan payload identik
      const reqReplay = makeReq({ body: payload });
      const resReplay = makeRes();
      await receiptHandler(reqReplay, resReplay);

      assert.ok([200, 201].includes(resReplay.statusCode));
      assert.strictEqual(resReplay.body.data.is_replay, true);
      assert.strictEqual(resReplay.body.data.operation_id, initialOpId);

      // Saldo tidak boleh bertambah ganda
      const balAfterReplay = await pool.query(
        'SELECT quantity FROM stock_balances WHERE property_id = 1 AND product_id = 201 AND location_id = 10'
      );
      assert.strictEqual(
        String(balAfterReplay.rows[0].quantity),
        String(balBeforeReplay.rows[0].quantity),
        'Saldo tidak boleh bertambah saat replay idempotent'
      );

      // 3. Replay dengan operation_key sama namun payload berbeda (misal kuantitas berbeda)
      const reqMismatch = makeReq({
        body: {
          ...payload,
          received_lines: [
            {
              transaction_line_id: 5008,
              product_id: 201,
              location_id: 10,
              quantity_received: '10.000', // beda kuantitas
            },
          ],
        },
      });
      const resMismatch = makeRes();
      await receiptHandler(reqMismatch, resMismatch);

      assert.strictEqual(resMismatch.statusCode, 409);
      assert.strictEqual(resMismatch.body.code, 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');

      return { isReplayVerified: true, mismatchRejected: true };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 8 & Invariants: Query Riwayat, Konsistensi Saldo & Trigger Append-Only
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 8: Query riwayat penerimaan pembelian (GET /api/pos/stock/purchase-receipts)', async () => {
      const req = makeReq({
        query: {
          property_id: 1,
          transaction_id: 1002, // PO 1002 punya 2 penerimaan (PART1 & PART2)
        },
      });
      const res = makeRes();
      await receiptQueryHandler(req, res);

      assert.ok([200, 201].includes(res.statusCode));
      assert.ok(["OK", "SUCCESS"].includes(res.body.status));
      assert.strictEqual(res.body.data.transaction_id, 1002);
      assert.strictEqual(res.body.data.receiving_status, 'DITERIMA_LENGKAP');
      assert.strictEqual(res.body.data.receipts.length, 2, 'Harus memiliki 2 riwayat penerimaan');

      return { totalReceiptsQueried: res.body.data.receipts.length };
    });

    await step('Invariants: Konsistensi saldo stock_balances dengan sum(stock_movements)', async () => {
      const checkRes = await pool.query(`
        SELECT sb.property_id, sb.product_id, sb.location_id,
               sb.quantity AS balance_qty,
               COALESCE(SUM(sm.quantity_delta), 0) AS movements_sum
          FROM stock_balances sb
          JOIN stock_movements sm ON sm.property_id = sb.property_id
                                 AND sm.product_id = sb.product_id
                                 AND sm.location_id = sb.location_id
         GROUP BY sb.property_id, sb.product_id, sb.location_id, sb.quantity
      `);

      assert.ok(checkRes.rows.length >= 3);
      for (const row of checkRes.rows) {
        assert.strictEqual(
          String(row.balance_qty),
          String(row.movements_sum),
          `Saldo ${row.balance_qty} harus sama dengan sum mutasi ${row.movements_sum} untuk item ${row.product_id}`
        );
      }

      return { verifiedBalancesCount: checkRes.rows.length };
    });

    await step('Invariants: Trigger append-only menolak UPDATE dan DELETE pada stock_movements', async () => {
      // UPDATE ditolak
      let updateThrew = false;
      try {
        await pool.query('UPDATE stock_movements SET quantity_delta = 999 WHERE product_id = 201');
      } catch (err) {
        updateThrew = true;
      }
      assert.strictEqual(updateThrew, true, 'UPDATE pada stock_movements harus ditolak');

      // DELETE ditolak
      let deleteThrew = false;
      try {
        await pool.query('DELETE FROM stock_movements WHERE product_id = 201');
      } catch (err) {
        deleteThrew = true;
      }
      assert.strictEqual(deleteThrew, true, 'DELETE pada stock_movements harus ditolak');

      return { appendOnlyEnforced: true };
    });

    log('========================================================================');
    log(`SEMUA ${results.length} PENGUJIAN MP-04B BATCH 3 BERHASIL (PASS)!`);
    log('========================================================================');

  } catch (err) {
    log(`FATAL ERROR: ${err?.message || err}`);
    if (err?.stack) log(err.stack);
    process.exitCode = 1;
  } finally {
    await closeAllPools();
    if (container) {
      log(`Membersihkan container ${container.name}...`);
      stopContainer(container.name);
      log('Container terisolasi berhasil dibersihkan.');
    }
  }
}

main().catch((err) => {
  console.error('Unhandled fatal error in test runner:', err);
  process.exit(1);
});



