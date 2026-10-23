'use strict';

/**
 * OAK HIMS — MP-04B Batch 4 PostgreSQL Integration Test
 * =====================================================
 *
 * Memverifikasi Penyesuaian Stok, Opname Fisik, dan Transfer Antar Lokasi:
 *   - Skenario 1: Penyesuaian stok keluar (RUSAK/HILANG) memotong saldo.
 *   - Skenario 2: Penyesuaian stok melebihi saldo ditolak 400 INSUFFICIENT_STOCK_BALANCE.
 *   - Skenario 3: Opname fisik surplus menambah saldo (+variance).
 *   - Skenario 4: Opname fisik defisit mengurangi saldo (-variance).
 *   - Skenario 5: Opname fisik match tidak mengubah saldo, tercatat status MATCH tanpa mutasi ledger.
 *   - Skenario 6: Transfer stok antar lokasi sukses memotong asal dan menambah tujuan dalam 1 transaksi atomik.
 *   - Skenario 7: Transfer melebihi saldo asal di-rollback total.
 *   - Skenario 8: Transfer ke lokasi yang sama ditolak 400 SAME_LOCATION_TRANSFER_FORBIDDEN.
 *   - Skenario 9: Konversi satuan kemasan pada transfer (e.g. Dus ke botol).
 *   - Skenario 10: Idempotency replay (key sama -> replay 200, beda payload -> 409).
 *   - Skenario 11: HTTP Route Handlers & Query Riwayat (adjustments, opnames, transfers).
 *   - Invariants: Saldo stock_balances sinkron dengan sum(stock_movements) dan trigger append-only aktif.
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
const TEST_DB = 'oak_hims_mp04b_b4_test';
const TEST_USER = 'oakmp04bb4_runner';
const CONTAINER_PREFIX = 'oak-hims-mp04b-b4-test-';

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
    port: globalThis.__MP04B_B4_PORT__,
    user: TEST_USER,
    password: globalThis.__MP04B_B4_PASSWORD__,
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
    const client = new pg.Client({ ...makePoolConfig('mp04b-b4-readiness'), connectionTimeoutMillis: 3000 });
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
  log('OAK HIMS — MP-04B Batch 4: Penyesuaian Stok, Opname Fisik, & Transfer');
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
      };
    });

    // 2. Start PostgreSQL container
    container = await step('preflight: container PostgreSQL 15 terisolasi', async () => {
      const c = startContainer();
      const port = resolveHostPort(c.name);
      globalThis.__MP04B_B4_PORT__ = port;
      globalThis.__MP04B_B4_PASSWORD__ = c.password;
      await waitForPostgres(90000);
      return { name: c.name, port };
    });

    const pool = newPool('mp04b-b4-test-runner');

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
      `);

      const p = loadProductionModules();
      await p.mp03cMigration.runProductMasterMp03cMigration(pool);
      await p.mp04bB1Migration.runProductInventoryMp04bB1Migration(pool);
      await p.mp04bB3Migration.runProductInventoryMp04bB3Migration(pool);

      // Seed initial master fixtures
      await pool.query(`
        INSERT INTO properties (id, name) VALUES
          (1, 'Hotel OAK Seminyak'),
          (2, 'Hotel OAK Canggu');

        INSERT INTO users (id, username, full_name) VALUES
          (1, 'admin_pos', 'Admin POS Staff'),
          (2, 'storekeeper', 'Petugas Gudang');

        INSERT INTO stock_locations (id, property_id, code, name, location_type, is_active) VALUES
          (10, 1, 'WH-01', 'Gudang Utama Seminyak', 'WAREHOUSE', TRUE),
          (11, 1, 'KIT-01', 'Dapur Seminyak', 'KITCHEN', TRUE),
          (12, 1, 'BAR-01', 'Bar Seminyak', 'POS_OUTLET', TRUE),
          (13, 1, 'OLD-01', 'Gudang Lama (Nonaktif)', 'WAREHOUSE', FALSE),
          (20, 2, 'WH-02', 'Gudang Canggu', 'WAREHOUSE', TRUE);

        INSERT INTO pos_menu_items (id, property_id, name, price, base_unit, canonical_base_unit_code, track_stock) VALUES
          (201, 1, 'Air Mineral 600ml', 10000, 'botol', 'BOTOL', TRUE),
          (202, 1, 'Beras Premium Ramos', 15000, 'kg', 'KG', TRUE),
          (203, 1, 'Kopi Arabika Bean', 120, 'gram', 'GRAM', TRUE),
          (204, 1, 'Jasa Antar Barang', 25000, 'kali', NULL, FALSE);

        INSERT INTO product_packaging_conversions (id, property_id, menu_item_id, packaging_code, packaging_label, base_unit_code, to_base_factor, idempotency_key, is_active) VALUES
          (301, 1, 201, 'DUS24', 'Dus 24 Botol', 'BOTOL', 24.000, 'SEED-PPC-201-DUS24', TRUE),
          (302, 1, 202, 'SAK50', 'Sak 50 Kg', 'KG', 50.000, 'SEED-PPC-202-SAK50', TRUE);
      `);

      // Pasang Saldo Awal (Opening Balance):
      // 201 (Air Mineral) di WH-01: 100.000 botol
      // 202 (Beras Ramos) di WH-01: 200.000 kg
      await p.stockService.recordOpeningBalance(pool, {
        property_id: 1,
        product_id: 201,
        location_id: 10,
        quantity: '100.000',
        operation_key: 'INIT-BAL-201-WH01',
      });

      await p.stockService.recordOpeningBalance(pool, {
        property_id: 1,
        product_id: 202,
        location_id: 10,
        quantity: '200.000',
        operation_key: 'INIT-BAL-202-WH01',
      });

      return { seeded: true };
    });

    const stock = prod.stockService;

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 1: Penyesuaian stok keluar (RUSAK/HILANG) memotong saldo
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 1: Penyesuaian stok keluar (RUSAK / HILANG) memotong saldo', async () => {
      // 1a. Penyesuaian OUT karena RUSAK: 10 botol
      const adj1 = await stock.recordStockAdjustment(pool, {
        property_id: 1,
        product_id: 201,
        location_id: 10,
        adjustment_type: 'OUT',
        reason_code: 'RUSAK',
        quantity: '10.000',
        operation_key: 'ADJ-OUT-001',
        notes: '10 botol bocor saat pemindahan rak',
      });

      assert.strictEqual(adj1.adjustment_type, 'OUT');
      assert.strictEqual(adj1.reason_code, 'RUSAK');
      assert.strictEqual(adj1.quantity_delta, '-10.000');
      assert.strictEqual(adj1.current_balance, '90.000');
      assert.strictEqual(adj1.is_replay, false);

      // 1b. Penyesuaian OUT karena HILANG: 5 botol
      const adj2 = await stock.recordStockAdjustment(pool, {
        property_id: 1,
        product_id: 201,
        location_id: 10,
        adjustment_type: 'OUT',
        reason_code: 'HILANG',
        quantity: '5.000',
        operation_key: 'ADJ-OUT-002',
        notes: 'Selisih 5 botol tidak ditemukan',
      });

      assert.strictEqual(adj2.quantity_delta, '-5.000');
      assert.strictEqual(adj2.current_balance, '85.000');

      // 1c. Penyesuaian IN karena KOREKSI_ADMIN: +15 botol
      const adj3 = await stock.recordStockAdjustment(pool, {
        property_id: 1,
        product_id: 201,
        location_id: 10,
        adjustment_type: 'IN',
        reason_code: 'KOREKSI_ADMIN',
        quantity: '15.000',
        operation_key: 'ADJ-IN-001',
        notes: 'Koreksi penemuan botol terselip',
      });

      assert.strictEqual(adj3.quantity_delta, '15.000');
      assert.strictEqual(adj3.current_balance, '100.000');

      // Kembalikan ke 85.000 untuk pengujian berikutnya (potong 15 PEMAKAIAN_INTERNAL)
      const adj4 = await stock.recordStockAdjustment(pool, {
        property_id: 1,
        product_id: 201,
        location_id: 10,
        adjustment_type: 'OUT',
        reason_code: 'PEMAKAIAN_INTERNAL',
        quantity: '15.000',
        operation_key: 'ADJ-OUT-003',
        notes: 'Konsumsi meeting direksi',
      });
      assert.strictEqual(adj4.current_balance, '85.000');

      return { balance_after_adjustments: adj4.current_balance };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 2: Penyesuaian stok melebihi saldo ditolak 400 INSUFFICIENT_STOCK_BALANCE
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 2: Penyesuaian stok melebihi saldo ditolak 400 INSUFFICIENT_STOCK_BALANCE', async () => {
      // Saldo saat ini: 85.000 botol. Coba kurangi 90.000 botol.
      let threw = false;
      try {
        await stock.recordStockAdjustment(pool, {
          property_id: 1,
          product_id: 201,
          location_id: 10,
          adjustment_type: 'OUT',
          reason_code: 'RUSAK',
          quantity: '90.000',
          operation_key: 'ADJ-FAIL-001',
        });
      } catch (err) {
        threw = true;
        assert.strictEqual(err.statusCode, 400);
        assert.strictEqual(err.code, 'INSUFFICIENT_STOCK_BALANCE');
      }
      assert.strictEqual(threw, true, 'Harus melempar 400 INSUFFICIENT_STOCK_BALANCE');

      // Validasi bahwa alasan tidak valid juga ditolak 400
      let invalidReasonThrew = false;
      try {
        await stock.recordStockAdjustment(pool, {
          property_id: 1,
          product_id: 201,
          location_id: 10,
          adjustment_type: 'OUT',
          reason_code: 'ALASAN_PALSU',
          quantity: '5.000',
          operation_key: 'ADJ-FAIL-INVALID-REASON',
        });
      } catch (err) {
        invalidReasonThrew = true;
        assert.strictEqual(err.statusCode, 400);
        assert.strictEqual(err.code, 'INVALID_ADJUSTMENT_REASON');
      }
      assert.strictEqual(invalidReasonThrew, true, 'Harus melempar 400 INVALID_ADJUSTMENT_REASON');

      // Pastikan saldo tetap 85.000
      const balRes = await pool.query(
        'SELECT quantity FROM stock_balances WHERE property_id = 1 AND product_id = 201 AND location_id = 10'
      );
      assert.strictEqual(balRes.rows[0].quantity, '85.000');

      return { balance_unchanged: balRes.rows[0].quantity };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 3: Opname fisik surplus menambah saldo (+variance)
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 3: Opname fisik surplus menambah saldo (+variance)', async () => {
      // Saldo sistem 201 saat ini: 85.000 botol.
      // Hasil fisik ditemukan: 95.000 botol (+10.000 surplus).
      const opnameRes = await stock.recordStockOpname(pool, {
        property_id: 1,
        location_id: 10,
        items: [
          {
            product_id: 201,
            physical_quantity: '95.000',
            notes: 'Fisik ditemukan 95 botol di rak A',
          },
        ],
        operation_key: 'OPN-2026-001',
        notes: 'Opname rutin mingguan',
      });

      assert.strictEqual(opnameRes.operation_type, 'STOCK_OPNAME');
      assert.strictEqual(opnameRes.items.length, 1);
      const item = opnameRes.items[0];
      assert.strictEqual(item.system_quantity, '85.000');
      assert.strictEqual(item.physical_quantity, '95.000');
      assert.strictEqual(item.variance_quantity, '10.000');
      assert.strictEqual(item.status, 'SURPLUS');
      assert.ok(item.movement_id !== null, 'Item surplus harus menghasilkan mutasi ledger');

      // Cek saldo di stock_balances
      const balRes = await pool.query(
        'SELECT quantity FROM stock_balances WHERE property_id = 1 AND product_id = 201 AND location_id = 10'
      );
      assert.strictEqual(balRes.rows[0].quantity, '95.000');

      return { new_balance: balRes.rows[0].quantity, status: item.status };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 4: Opname fisik defisit mengurangi saldo (-variance)
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 4: Opname fisik defisit mengurangi saldo (-variance)', async () => {
      // Saldo sistem 201 saat ini: 95.000 botol.
      // Hasil fisik ditemukan: 90.000 botol (-5.000 defisit).
      const opnameRes = await stock.recordStockOpname(pool, {
        property_id: 1,
        location_id: 10,
        items: [
          {
            product_id: 201,
            physical_quantity: '90.000',
            notes: '5 botol tidak ditemukan',
          },
        ],
        operation_key: 'OPN-2026-002',
        notes: 'Opname susulan',
      });

      assert.strictEqual(opnameRes.items.length, 1);
      const item = opnameRes.items[0];
      assert.strictEqual(item.system_quantity, '95.000');
      assert.strictEqual(item.physical_quantity, '90.000');
      assert.strictEqual(item.variance_quantity, '-5.000');
      assert.strictEqual(item.status, 'DEFICIT');
      assert.ok(item.movement_id !== null, 'Item defisit harus menghasilkan mutasi ledger');

      // Cek saldo di stock_balances
      const balRes = await pool.query(
        'SELECT quantity FROM stock_balances WHERE property_id = 1 AND product_id = 201 AND location_id = 10'
      );
      assert.strictEqual(balRes.rows[0].quantity, '90.000');

      return { new_balance: balRes.rows[0].quantity, status: item.status };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 5: Opname fisik match tidak mengubah saldo, tercatat status MATCH
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 5: Opname fisik match tidak mengubah saldo, status MATCH tanpa mutasi ledger', async () => {
      // Saldo sistem 201 saat ini: 90.000 botol.
      // Hasil fisik dihitung: tepat 90.000 botol (selisih 0).
      const movCountBefore = await pool.query('SELECT COUNT(*) FROM stock_movements');

      const opnameRes = await stock.recordStockOpname(pool, {
        property_id: 1,
        location_id: 10,
        items: [
          {
            product_id: 201,
            physical_quantity: '90.000',
            notes: 'Fisik cocok sempurna',
          },
        ],
        operation_key: 'OPN-2026-003',
      });

      assert.strictEqual(opnameRes.items.length, 1);
      const item = opnameRes.items[0];
      assert.strictEqual(item.system_quantity, '90.000');
      assert.strictEqual(item.physical_quantity, '90.000');
      assert.strictEqual(item.variance_quantity, '0.000');
      assert.strictEqual(item.status, 'MATCH');
      assert.strictEqual(item.movement_id, null, 'Status MATCH tidak membuat baris mutasi ledger');

      // Pastikan stock_movements tidak bertambah
      const movCountAfter = await pool.query('SELECT COUNT(*) FROM stock_movements');
      assert.strictEqual(movCountBefore.rows[0].count, movCountAfter.rows[0].count);

      // Saldo tetap 90.000
      const balRes = await pool.query(
        'SELECT quantity FROM stock_balances WHERE property_id = 1 AND product_id = 201 AND location_id = 10'
      );
      assert.strictEqual(balRes.rows[0].quantity, '90.000');

      return { match_status: item.status, balance: balRes.rows[0].quantity };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 6: Transfer stok antar lokasi sukses memotong asal dan menambah tujuan
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 6: Transfer stok antar lokasi sukses memotong asal dan menambah tujuan', async () => {
      // WH-01 (id 10) punya 90.000 botol. Transfer 30.000 ke KIT-01 (id 11).
      const transferRes = await stock.recordStockTransfer(pool, {
        property_id: 1,
        from_location_id: 10,
        to_location_id: 11,
        items: [
          {
            product_id: 201,
            quantity: '30.000',
            notes: 'Transfer stok untuk dapur operasional',
          },
        ],
        operation_key: 'TRF-WH01-KIT01-001',
        notes: 'Permintaan dapur harian',
      });

      assert.strictEqual(transferRes.operation_type, 'STOCK_TRANSFER');
      assert.strictEqual(transferRes.items.length, 1);
      const item = transferRes.items[0];
      assert.strictEqual(item.product_id, 201);
      assert.strictEqual(item.base_quantity, '30.000');
      assert.strictEqual(item.origin_balance, '60.000');
      assert.strictEqual(item.destination_balance, '30.000');
      assert.ok(item.out_movement_id > 0);
      assert.ok(item.in_movement_id > 0);
      assert.notStrictEqual(item.out_movement_id, item.in_movement_id);

      // Verifikasi stock_balances kedua lokasi di database
      const originBal = await pool.query(
        'SELECT quantity FROM stock_balances WHERE property_id = 1 AND product_id = 201 AND location_id = 10'
      );
      const destBal = await pool.query(
        'SELECT quantity FROM stock_balances WHERE property_id = 1 AND product_id = 201 AND location_id = 11'
      );

      assert.strictEqual(originBal.rows[0].quantity, '60.000');
      assert.strictEqual(destBal.rows[0].quantity, '30.000');

      // Verifikasi stock_movements memuat OUT (-) dan IN (+)
      const outMov = await pool.query('SELECT quantity_delta, location_id FROM stock_movements WHERE id = $1', [
        item.out_movement_id,
      ]);
      const inMov = await pool.query('SELECT quantity_delta, location_id FROM stock_movements WHERE id = $1', [
        item.in_movement_id,
      ]);

      assert.strictEqual(outMov.rows[0].quantity_delta, '-30.000');
      assert.strictEqual(outMov.rows[0].location_id, 10);
      assert.strictEqual(inMov.rows[0].quantity_delta, '30.000');
      assert.strictEqual(inMov.rows[0].location_id, 11);

      return { origin_bal: originBal.rows[0].quantity, dest_bal: destBal.rows[0].quantity };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 7: Transfer melebihi saldo asal di-rollback total
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 7: Transfer melebihi saldo asal di-rollback total', async () => {
      // Saldo WH-01 saat ini adalah 60.000 botol. Coba transfer 70.000 botol.
      let threw = false;
      try {
        await stock.recordStockTransfer(pool, {
          property_id: 1,
          from_location_id: 10,
          to_location_id: 11,
          items: [
            {
              product_id: 201,
              quantity: '70.000',
            },
          ],
          operation_key: 'TRF-FAIL-EXCEED-001',
        });
      } catch (err) {
        threw = true;
        assert.strictEqual(err.statusCode, 400);
        assert.strictEqual(err.code, 'INSUFFICIENT_STOCK_BALANCE');
      }
      assert.strictEqual(threw, true, 'Harus melempar 400 INSUFFICIENT_STOCK_BALANCE');

      // Pastikan kedua saldo tidak berubah sama sekali
      const originBal = await pool.query(
        'SELECT quantity FROM stock_balances WHERE property_id = 1 AND product_id = 201 AND location_id = 10'
      );
      const destBal = await pool.query(
        'SELECT quantity FROM stock_balances WHERE property_id = 1 AND product_id = 201 AND location_id = 11'
      );
      assert.strictEqual(originBal.rows[0].quantity, '60.000');
      assert.strictEqual(destBal.rows[0].quantity, '30.000');

      return { origin_unchanged: originBal.rows[0].quantity, dest_unchanged: destBal.rows[0].quantity };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 8: Transfer ke lokasi yang sama ditolak 400
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 8: Transfer ke lokasi yang sama ditolak 400 SAME_LOCATION_TRANSFER_FORBIDDEN', async () => {
      let threw = false;
      try {
        await stock.recordStockTransfer(pool, {
          property_id: 1,
          from_location_id: 10,
          to_location_id: 10, // Lokasi sama!
          items: [
            {
              product_id: 201,
              quantity: '5.000',
            },
          ],
          operation_key: 'TRF-SAME-LOC-001',
        });
      } catch (err) {
        threw = true;
        assert.strictEqual(err.statusCode, 400);
        assert.strictEqual(err.code, 'SAME_LOCATION_TRANSFER_FORBIDDEN');
      }
      assert.strictEqual(threw, true, 'Harus melempar 400 SAME_LOCATION_TRANSFER_FORBIDDEN');

      return { rejected: true };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 9: Konversi satuan kemasan pada transfer (Dus ke Botol)
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 9: Konversi satuan kemasan pada transfer (2 Dus @ 24 = 48 Botol)', async () => {
      // WH-01 punya 60.000 botol. Transfer 2 Dus (packaging 301 = 24 botol/dus) ke BAR-01 (id 12).
      // Total kuantitas dasar: 2 * 24 = 48.000 botol.
      // Saldo WH-01 menjadi: 60 - 48 = 12.000 botol.
      // Saldo BAR-01 menjadi: 48.000 botol.
      const transferRes = await stock.recordStockTransfer(pool, {
        property_id: 1,
        from_location_id: 10,
        to_location_id: 12,
        items: [
          {
            product_id: 201,
            packaging_id: 301,
            quantity: '2.000',
            notes: 'Kirim 2 dus air mineral ke Bar',
          },
        ],
        operation_key: 'TRF-PKG-DUS24-001',
      });

      assert.strictEqual(transferRes.items.length, 1);
      const item = transferRes.items[0];
      assert.strictEqual(item.quantity, '2.000');
      assert.strictEqual(item.base_quantity, '48.000');
      assert.strictEqual(item.packaging_id, 301);
      assert.strictEqual(item.packaging_code, 'DUS24');
      assert.strictEqual(item.origin_balance, '12.000');
      assert.strictEqual(item.destination_balance, '48.000');

      // Periksa stock_movements mencatat kemasan
      const movRes = await pool.query(
        'SELECT packaging_id, packaging_code, quantity_delta FROM stock_movements WHERE id = $1',
        [item.in_movement_id]
      );
      assert.strictEqual(movRes.rows[0].packaging_id, 301);
      assert.strictEqual(movRes.rows[0].packaging_code, 'DUS24');
      assert.strictEqual(movRes.rows[0].quantity_delta, '48.000');

      return { converted_qty: item.base_quantity, bar_balance: item.destination_balance };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 10: Idempotency Replay (200 OK replay vs 409 Conflict mismatch)
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 10: Idempotency replay (key sama -> replay, payload beda -> 409)', async () => {
      // 10a. Replay transfer yang sama dengan identical payload
      const replayRes = await stock.recordStockTransfer(pool, {
        property_id: 1,
        from_location_id: 10,
        to_location_id: 12,
        items: [
          {
            product_id: 201,
            packaging_id: 301,
            quantity: '2.000',
            notes: 'Kirim 2 dus air mineral ke Bar',
          },
        ],
        operation_key: 'TRF-PKG-DUS24-001',
      });

      assert.strictEqual(replayRes.is_replay, true);
      assert.strictEqual(replayRes.operation_key, 'TRF-PKG-DUS24-001');

      // Pastikan saldo BAR-01 tidak terduplikasi (tetap 48.000)
      const barBal = await pool.query(
        'SELECT quantity FROM stock_balances WHERE property_id = 1 AND product_id = 201 AND location_id = 12'
      );
      assert.strictEqual(barBal.rows[0].quantity, '48.000');

      // 10b. Kirim key yang sama namun beda payload (minta 3 dus bukannya 2 dus)
      let threw409 = false;
      try {
        await stock.recordStockTransfer(pool, {
          property_id: 1,
          from_location_id: 10,
          to_location_id: 12,
          items: [
            {
              product_id: 201,
              packaging_id: 301,
              quantity: '3.000', // Beda kuantitas!
            },
          ],
          operation_key: 'TRF-PKG-DUS24-001',
        });
      } catch (err) {
        threw409 = true;
        assert.strictEqual(err.statusCode, 409);
        assert.strictEqual(err.code, 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
      }
      assert.strictEqual(threw409, true, 'Harus melempar 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');

      return { replay_verified: true, mismatch_blocked: true };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 11: HTTP Express Route Handlers & Riwayat Query
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 11: HTTP Route Handlers & Query Filters (Adjustments, Opnames, Transfers)', async () => {
      const deps = makeDeps(pool);
      const userAdmin = { id: 1, username: 'admin_pos', role: 'SUPERADMIN' };
      const userUnauthorized = { id: 99, username: 'guest_user', role: 'GUEST', permissions: [] };

      // 11a. Test POST /api/pos/stock/adjustments via handler
      const adjHandler = stock.createStockAdjustmentHandler(deps);
      const reqAdj = makeReq({
        body: {
          property_id: 1,
          product_id: 202, // Beras Ramos (saldo 200.000 kg)
          location_id: 10,
          adjustment_type: 'OUT',
          reason_code: 'KADALUARSA',
          quantity: '5.000',
          operation_key: 'HTTP-ADJ-001',
          notes: '5 kg beras terkena kutu/kadaluarsa',
        },
        user: userAdmin,
      });
      const resAdj = makeRes();
      await adjHandler(reqAdj, resAdj);

      assert.strictEqual(resAdj.statusCode, 201);
      assert.strictEqual(resAdj.body?.status, 'OK');
      assert.strictEqual(resAdj.body?.data?.current_balance, '195.000');

      // 11b. Test GET /api/pos/stock/adjustments via query handler
      const adjQueryHandler = stock.createStockAdjustmentsQueryHandler(deps);
      const reqAdjQuery = makeReq({
        query: { property_id: 1, product_id: 202 },
        user: userAdmin,
      });
      const resAdjQuery = makeRes();
      await adjQueryHandler(reqAdjQuery, resAdjQuery);

      assert.strictEqual(resAdjQuery.statusCode, 200);
      assert.ok(Array.isArray(resAdjQuery.body?.data));
      assert.ok(resAdjQuery.body.data.length >= 1);
      assert.strictEqual(resAdjQuery.body.data[0].reason_code, 'KADALUARSA');

      // 11c. Test GET /api/pos/stock/opnames via query handler
      const opnQueryHandler = stock.createStockOpnamesQueryHandler(deps);
      const reqOpnQuery = makeReq({
        query: { property_id: 1, location_id: 10 },
        user: userAdmin,
      });
      const resOpnQuery = makeRes();
      await opnQueryHandler(reqOpnQuery, resOpnQuery);

      assert.strictEqual(resOpnQuery.statusCode, 200);
      assert.ok(Array.isArray(resOpnQuery.body?.data));
      assert.ok(resOpnQuery.body.data.length >= 3);

      // 11d. Test GET /api/pos/stock/transfers via query handler
      const trfQueryHandler = stock.createStockTransfersQueryHandler(deps);
      const reqTrfQuery = makeReq({
        query: { property_id: 1, from_location_id: 10 },
        user: userAdmin,
      });
      const resTrfQuery = makeRes();
      await trfQueryHandler(reqTrfQuery, resTrfQuery);

      assert.strictEqual(resTrfQuery.statusCode, 200);
      assert.ok(Array.isArray(resTrfQuery.body?.data));
      assert.ok(resTrfQuery.body.data.length >= 2);

      // 11e. Test Guard Izin: User unauthorized ditolak 403
      const reqUnauthorized = makeReq({
        body: {
          property_id: 1,
          product_id: 201,
          location_id: 10,
          adjustment_type: 'OUT',
          reason_code: 'RUSAK',
          quantity: '1.000',
          operation_key: 'UNAUTH-ADJ-001',
        },
        user: userUnauthorized,
      });
      const resUnauthorized = makeRes();
      await adjHandler(reqUnauthorized, resUnauthorized);
      assert.strictEqual(resUnauthorized.statusCode, 403);
      assert.strictEqual(resUnauthorized.body?.code, 'FORBIDDEN');

      return { http_endpoints_verified: true };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 12 & Invariants: Validasi Integritas Ledger & Database
    // ─────────────────────────────────────────────────────────────────────────
    await step('Invariants: Konsistensi saldo ledger = SUM(stock_movements) & trigger append-only', async () => {
      // 1. Verifikasi saldo stock_balances konsisten 100% dengan akumulasi mutasi ledger
      const reconcilRes = await pool.query(`
        SELECT sb.property_id, sb.product_id, sb.location_id,
               sb.quantity AS balance_qty,
               COALESCE(SUM(sm.quantity_delta), 0.000) AS movement_sum
          FROM stock_balances sb
          LEFT JOIN stock_movements sm
            ON sm.property_id = sb.property_id
           AND sm.product_id = sb.product_id
           AND sm.location_id = sb.location_id
         GROUP BY sb.property_id, sb.product_id, sb.location_id, sb.quantity
      `);

      assert.ok(reconcilRes.rows.length > 0, 'Harus ada saldo tercatat');
      for (const row of reconcilRes.rows) {
        const bal = BigInt(Math.round(Number(row.balance_qty) * 1000));
        const sum = BigInt(Math.round(Number(row.movement_sum) * 1000));
        assert.strictEqual(
          bal,
          sum,
          `Drift terdeteksi pada prod ${row.product_id} loc ${row.location_id}: balance=${row.balance_qty}, sum=${row.movement_sum}`
        );
      }

      // 2. Verifikasi Append-Only Trigger pada stock_movements
      // UPDATE harus ditolak trigger
      let updateThrew = false;
      try {
        await pool.query('UPDATE stock_movements SET quantity_delta = 999.000 WHERE id = (SELECT MIN(id) FROM stock_movements)');
      } catch (err) {
        updateThrew = true;
        assert.ok(
          err.message.toLowerCase().includes('append_only') ||
          err.message.toLowerCase().includes('append-only') ||
          err.message.includes('dilarang')
        );
      }
      assert.strictEqual(updateThrew, true, 'Trigger append-only harus menolak UPDATE pada stock_movements');

      // DELETE harus ditolak trigger
      let deleteThrew = false;
      try {
        await pool.query('DELETE FROM stock_movements WHERE id = (SELECT MIN(id) FROM stock_movements)');
      } catch (err) {
        deleteThrew = true;
        assert.ok(
          err.message.toLowerCase().includes('append_only') ||
          err.message.toLowerCase().includes('append-only') ||
          err.message.includes('dilarang')
        );
      }
      assert.strictEqual(deleteThrew, true, 'Trigger append-only harus menolak DELETE pada stock_movements');

      // 3. Verifikasi check constraint saldo non-negatif
      let negBalThrew = false;
      try {
        await pool.query(`
          INSERT INTO stock_balances (property_id, product_id, location_id, quantity, updated_at)
          VALUES (1, 201, 10, -5.000, NOW())
        `);
      } catch (err) {
        negBalThrew = true;
        assert.ok(err.message.includes('chk_stock_balance_non_negative') || err.message.includes('check constraint'));
      }
      assert.strictEqual(negBalThrew, true, 'Check constraint harus menolak saldo negatif');

      return {
        rows_reconciled: reconcilRes.rows.length,
        append_only_verified: true,
        non_negative_guarded: true,
      };
    });

    log('========================================================================');
    log('HASIL PENGUJIAN: SEMUA 12 SKENARIO & INVARIANTS LULUS (PASS 100%)');
    log('========================================================================');
  } catch (err) {
    log('TEST FAILED with ERROR:', err?.message || err);
    if (err.stack) log(err.stack);
    process.exitCode = 1;
  } finally {
    await closeAllPools();
    if (container) {
      log(`Membersihkan container PostgreSQL: ${container.name}`);
      stopContainer(container.name);
    }
  }
}

main().catch((err) => {
  console.error('Fatal unhandled error:', err);
  process.exit(1);
});
