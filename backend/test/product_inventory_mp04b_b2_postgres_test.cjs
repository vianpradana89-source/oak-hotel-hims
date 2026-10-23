'use strict';

/**
 * OAK HIMS — MP-04B Batch 2 PostgreSQL Integration Test
 * =====================================================
 *
 * Memverifikasi Layanan Saldo Awal (Opening Balance) & Query Saldo:
 *   - Skenario 1: Posting saldo awal berhasil menambah mutasi & mengisi stock_balances.
 *   - Skenario 2: Posting saldo awal kedua pada produk & lokasi yang sama ditolak (mencegah kasus 10+10=20).
 *   - Skenario 3: Replay request dengan operation_key dan payload identik mengembalikan 200 OK id sama (idempotent, saldo tidak bertambah ganda).
 *                 Replay request dengan operation_key sama namun payload berbeda ditolak (409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH).
 *   - Skenario 4: Saldo awal dengan satuan kemasan (misal 5 dus x 24) tersimpan tepat 120.000 di stock_balances beserta snapshot kemasan.
 *   - Skenario 5: Saldo awal bernilai 0.000 tetap mengunci satuan dasar produk:
 *                 - checkProductBaseUnitLockStatus melaporkan BASE_UNIT_LOCKED_BY_STOCK
 *                 - PATCH base_unit lewat API ditolak (409 BASE_UNIT_LOCKED_BY_STOCK)
 *                 - Direct SQL UPDATE base_unit ditolak trigger database
 *   - Skenario 6: Produk dengan track_stock = FALSE ditolak untuk saldo awal (D-01: 400 PRODUCT_STOCK_NOT_TRACKED).
 *   - Skenario 7: Query saldo (getStockBalances & GET /api/pos/stock/balances) mengembalikan data saldo yang tepat.
 *   - Invariants: Verifikasi ledger append-only, saldo konsisten dengan mutasi, dan pencegahan kuantitas negatif.
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
const TEST_DB = 'oak_hims_mp04b_b2_test';
const TEST_USER = 'oakmp04bb2_runner';
const CONTAINER_PREFIX = 'oak-hims-mp04b-b2-test-';

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
  const mp04bMigrationPath = path.join(BACKEND_DIR, 'dist', 'db', 'migrations', 'product_inventory_mp04b_b1_v1.js');
  const stockServicePath = path.join(BACKEND_DIR, 'dist', 'domains', 'pos', 'stockInventoryService.js');
  const unitsPath = path.join(BACKEND_DIR, 'dist', 'domains', 'pos', 'productUnitsAndLocations.js');
  const stage1Path = path.join(BACKEND_DIR, 'dist', 'domains', 'pos', 'productMasterStage1.js');

  for (const p of [mp03cMigrationPath, mp04bMigrationPath, stockServicePath, unitsPath, stage1Path]) {
    if (!fs.existsSync(p)) {
      throw new Error(`Build produksi belum tersedia: ${p}. Jalankan "npm --prefix backend run build" lebih dulu.`);
    }
  }

  const mp03cMigration = require(mp03cMigrationPath);
  const mp04bMigration = require(mp04bMigrationPath);
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
    mp04bMigration,
    stockService,
    units,
    stage1,
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
    port: globalThis.__MP04B_B2_PORT__,
    user: TEST_USER,
    password: globalThis.__MP04B_B2_PASSWORD__,
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
    const client = new pg.Client({ ...makePoolConfig('mp04b-b2-readiness'), connectionTimeoutMillis: 3000 });
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
    assertPropertyScope: async (req, propId) => Number(propId),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Test Runner
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  log('========================================================================');
  log('OAK HIMS — MP-04B Batch 2: Layanan Saldo Awal & Query Saldo Test');
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
      globalThis.__MP04B_B2_PORT__ = port;
      globalThis.__MP04B_B2_PASSWORD__ = c.password;
      await waitForPostgres(90000);
      return { name: c.name, port };
    });

    const pool = newPool('mp04b-b2-test-runner');

    // 3. Setup Baseline & Migrations (MP-03C + MP-04B B1)
    await step('setup: skema baseline dan eksekusi migrasi MP-03C & MP-04B B1', async () => {
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
      `);

      const p = loadProductionModules();
      await p.mp03cMigration.runProductMasterMp03cMigration(pool);
      await p.mp04bMigration.runProductInventoryMp04bB1Migration(pool);

      // Seed initial data
      await pool.query(`
        INSERT INTO properties (id, name) VALUES
          (1, 'Hotel OAK Seminyak'),
          (2, 'Hotel OAK Canggu');

        INSERT INTO users (id, username, full_name) VALUES
          (1, 'admin_pos', 'Admin POS Staff'),
          (2, 'auditor_user', 'Auditor User');

        INSERT INTO stock_locations (id, property_id, code, name, location_type, is_active) VALUES
          (10, 1, 'WH-01', 'Gudang Utama Seminyak', 'WAREHOUSE', TRUE),
          (11, 1, 'KIT-01', 'Dapur Seminyak', 'KITCHEN', TRUE),
          (12, 1, 'BAR-01', 'Bar Seminyak', 'POS_OUTLET', TRUE),
          (13, 1, 'OLD-01', 'Gudang Lama (Nonaktif)', 'WAREHOUSE', FALSE),
          (20, 2, 'WH-02', 'Gudang Canggu', 'WAREHOUSE', TRUE);

        -- Produk 201: Air Mineral (track_stock = TRUE, base_unit = BOTOL)
        INSERT INTO pos_menu_items (id, property_id, name, price, base_unit, canonical_base_unit_code, track_stock) VALUES
          (201, 1, 'Air Mineral 600ml', 10000, 'botol', 'BOTOL', TRUE),
          -- Produk 202: Beras Premium (track_stock = TRUE, base_unit = KG)
          (202, 1, 'Beras Premium Ramos', 15000, 'kg', 'KG', TRUE),
          -- Produk 203: Kopi Robusta (track_stock = TRUE, base_unit = GRAM)
          (203, 1, 'Kopi Robusta Beans', 30000, 'gram', 'GRAM', TRUE),
          -- Produk 204: Jasa Cuci Mobil (track_stock = FALSE, non-tracked)
          (204, 1, 'Jasa Cuci Mobil', 50000, 'pcs', 'PCS', FALSE),
          -- Produk 205: Produk Properti 2 (Canggu)
          (205, 2, 'Air Mineral Canggu', 10000, 'botol', 'BOTOL', TRUE);

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
      `);

      return { seededProperties: 2, seededProducts: 5, seededLocations: 5, seededPackagings: 2 };
    });

    const openingHandler = prod.stockService.createStockOpeningBalanceHandler(makeDeps(pool));
    const balancesHandler = prod.stockService.createStockBalancesHandler(makeDeps(pool));
    const patchItemHandler = prod.stage1.createPosMenuItemPatchHandler(makeDeps(pool));

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 1: Posting Saldo Awal Berhasil Menambah Mutasi & Mengisi stock_balances
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 1: Posting saldo awal berhasil (mutasi ledger + saldo bertambah)', async () => {
      const req = makeReq({
        body: {
          property_id: 1,
          product_id: 201,
          location_id: 10,
          quantity: '50.000',
          operation_key: 'OP-INIT-201-WH01',
          created_by: 1,
          unit_cost: '4500.00',
        },
      });
      const res = makeRes();
      await openingHandler(req, res);

      assert.strictEqual(res.statusCode, 201, `Status code harus 201, didapat: ${res.statusCode} body: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body.status, 'OK');
      assert.strictEqual(res.body.data.operation_type, 'OPENING_BALANCE');
      assert.strictEqual(res.body.data.operation_key, 'OP-INIT-201-WH01');
      assert.strictEqual(res.body.data.quantity_delta, '50.000');
      assert.strictEqual(res.body.data.base_unit_code, 'BOTOL');
      assert.strictEqual(res.body.data.current_balance, '50.000');
      assert.strictEqual(res.body.data.is_replay, false);

      // Verifikasi baris di tabel stock_operations
      const opRes = await pool.query('SELECT * FROM stock_operations WHERE id = $1', [res.body.data.operation_id]);
      assert.strictEqual(opRes.rows.length, 1);
      assert.strictEqual(opRes.rows[0].operation_type, 'OPENING_BALANCE');
      assert.strictEqual(opRes.rows[0].operation_key, 'OP-INIT-201-WH01');
      assert.ok(opRes.rows[0].payload_fingerprint, 'payload_fingerprint harus terisi');

      // Verifikasi baris di tabel stock_movements
      const movRes = await pool.query('SELECT * FROM stock_movements WHERE id = $1', [res.body.data.movement_id]);
      assert.strictEqual(movRes.rows.length, 1);
      assert.strictEqual(String(movRes.rows[0].quantity_delta), '50.000');
      assert.strictEqual(movRes.rows[0].base_unit_code, 'BOTOL');
      assert.strictEqual(String(movRes.rows[0].unit_cost), '4500.00');

      // Verifikasi saldo di tabel stock_balances
      const balRes = await pool.query(
        'SELECT * FROM stock_balances WHERE property_id = 1 AND product_id = 201 AND location_id = 10'
      );
      assert.strictEqual(balRes.rows.length, 1);
      assert.strictEqual(String(balRes.rows[0].quantity), '50.000');

      return { operationId: res.body.data.operation_id, balance: res.body.data.current_balance };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 2: Posting Saldo Awal Kedua pada Produk & Lokasi Sama Ditolak (R-04)
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 2: Posting saldo awal kedua pada produk & lokasi sama ditolak (409 STOCK_OPENING_ALREADY_EXISTS, 10+10!=20)', async () => {
      const req = makeReq({
        body: {
          property_id: 1,
          product_id: 201,
          location_id: 10,
          quantity: '10.000', // Mencoba menambah 10 lagi
          operation_key: 'OP-INIT-201-WH01-SECOND', // Key baru
          created_by: 1,
        },
      });
      const res = makeRes();
      await openingHandler(req, res);

      assert.strictEqual(res.statusCode, 409, `Harus ditolak 409, didapat ${res.statusCode}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body.code, 'STOCK_OPENING_ALREADY_EXISTS');

      // Pastikan saldo TIDAK bertambah menjadi 60.000
      const balRes = await pool.query(
        'SELECT quantity FROM stock_balances WHERE property_id = 1 AND product_id = 201 AND location_id = 10'
      );
      assert.strictEqual(String(balRes.rows[0].quantity), '50.000', 'Saldo harus tetap 50.000, tidak boleh 60.000');

      return { rejectedCode: res.body.code, balanceUnchanged: '50.000' };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 3: Replay Idempotent vs Mismatched Payload (R-05)
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 3A: Idempotent replay dengan operation_key dan payload sama mengembalikan 200 OK id sama (saldo tidak bertambah ganda)', async () => {
      const req = makeReq({
        body: {
          property_id: 1,
          product_id: 201,
          location_id: 10,
          quantity: '50.000',
          operation_key: 'OP-INIT-201-WH01', // Identik dengan Skenario 1
          created_by: 1,
          unit_cost: '4500.00',
        },
      });
      const res = makeRes();
      await openingHandler(req, res);

      assert.strictEqual(res.statusCode, 200, `Replay harus 200 OK, didapat ${res.statusCode}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body.data.is_replay, true);
      assert.strictEqual(res.body.data.operation_key, 'OP-INIT-201-WH01');
      assert.strictEqual(res.body.data.current_balance, '50.000');

      // Pastikan tidak ada penambahan mutasi di database
      const movCount = await pool.query(
        'SELECT COUNT(*) AS c FROM stock_movements WHERE product_id = 201 AND location_id = 10'
      );
      assert.strictEqual(Number(movCount.rows[0].c), 1, 'Hanya ada 1 row mutasi');

      return { isReplay: true, movementsCount: 1 };
    });

    await step('Skenario 3B: Replay dengan operation_key sama namun payload berbeda ditolak (409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH)', async () => {
      const req = makeReq({
        body: {
          property_id: 1,
          product_id: 201,
          location_id: 10,
          quantity: '99.000', // Kuantitas diubah
          operation_key: 'OP-INIT-201-WH01', // Key lama
          created_by: 1,
        },
      });
      const res = makeRes();
      await openingHandler(req, res);

      assert.strictEqual(res.statusCode, 409, `Harus ditolak 409, didapat ${res.statusCode}`);
      assert.strictEqual(res.body.code, 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');

      return { rejectedCode: res.body.code };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 4: Saldo Awal dengan Satuan Kemasan (R-06)
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 4: Saldo awal dengan kemasan (5 dus x 24 = 120.000 botol) tersimpan tepat beserta snapshot kemasan', async () => {
      // Buka saldo di lokasi KIT-01 (Dapur Seminyak, location_id: 11) untuk Produk 201
      const req = makeReq({
        body: {
          property_id: 1,
          product_id: 201,
          location_id: 11,
          packaging_id: 301, // DUS24, factor 24.000
          quantity: '5.000',  // 5 dus
          operation_key: 'OP-INIT-201-KIT01-DUS',
          created_by: 1,
          unit_cost: '96000.00', // Harga 1 dus
        },
      });
      const res = makeRes();
      await openingHandler(req, res);

      assert.strictEqual(res.statusCode, 201, `Status code harus 201: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body.data.quantity_delta, '120.000', '5 dus x 24 harus = 120.000 base unit');
      assert.strictEqual(res.body.data.base_unit_code, 'BOTOL');
      assert.strictEqual(res.body.data.packaging_id, 301);
      assert.strictEqual(res.body.data.packaging_code, 'DUS24');
      assert.strictEqual(res.body.data.packaging_label, 'Dus 24 Botol');
      assert.strictEqual(res.body.data.current_balance, '120.000');

      // Periksa baris mutasi di database
      const movRes = await pool.query('SELECT * FROM stock_movements WHERE id = $1', [res.body.data.movement_id]);
      assert.strictEqual(String(movRes.rows[0].quantity_delta), '120.000');
      assert.strictEqual(movRes.rows[0].packaging_code, 'DUS24');
      assert.strictEqual(movRes.rows[0].packaging_label, 'Dus 24 Botol');

      // Periksa saldo di lokasi KIT-01
      const balRes = await pool.query(
        'SELECT quantity FROM stock_balances WHERE property_id = 1 AND product_id = 201 AND location_id = 11'
      );
      assert.strictEqual(String(balRes.rows[0].quantity), '120.000');

      return { packagingCode: 'DUS24', factor: '24', calculatedBaseQty: '120.000' };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 5: Saldo Awal 0.000 Mengunci Satuan Dasar (R-01)
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 5A: Saldo awal bernilai 0.000 berhasil dicatat di stock_balances', async () => {
      // Produk 203 (Kopi Robusta Beans, base_unit = GRAM) dibuka saldo 0.000 di BAR-01 (location_id: 12)
      const req = makeReq({
        body: {
          property_id: 1,
          product_id: 203,
          location_id: 12,
          quantity: '0.000',
          operation_key: 'OP-INIT-203-BAR01-ZERO',
          created_by: 1,
        },
      });
      const res = makeRes();
      await openingHandler(req, res);

      assert.strictEqual(res.statusCode, 201, `Status code harus 201: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body.data.quantity_delta, '0.000');
      assert.strictEqual(res.body.data.current_balance, '0.000');

      const balRes = await pool.query(
        'SELECT quantity FROM stock_balances WHERE property_id = 1 AND product_id = 203 AND location_id = 12'
      );
      assert.strictEqual(String(balRes.rows[0].quantity), '0.000');

      return { balance: '0.000' };
    });

    await step('Skenario 5B: checkProductBaseUnitLockStatus melaporkan BASE_UNIT_LOCKED_BY_STOCK (R-01)', async () => {
      const lockStatus = await prod.units.checkProductBaseUnitLockStatus(pool, 1, 203);
      assert.strictEqual(lockStatus.isLocked, true, 'Produk harus terkunci');
      assert.strictEqual(lockStatus.hasStockMovements, true, 'hasStockMovements harus true');
      assert.strictEqual(lockStatus.lockCode, 'BASE_UNIT_LOCKED_BY_STOCK');
      assert.strictEqual(lockStatus.lockedReason, 'STOCK_MOVEMENTS');

      return { isLocked: true, lockCode: lockStatus.lockCode, lockedReason: lockStatus.lockedReason };
    });

    await step('Skenario 5C: PATCH base_unit lewat API ditolak dengan 409 BASE_UNIT_LOCKED_BY_STOCK', async () => {
      const req = makeReq({
        params: { id: 203 },
        body: {
          property_id: 1,
          base_unit: 'kg',
          canonical_base_unit_code: 'KG',
        },
      });
      const res = makeRes();
      await patchItemHandler(req, res);

      assert.strictEqual(res.statusCode, 409, `Harus 409: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body.code, 'BASE_UNIT_LOCKED_BY_STOCK');

      return { rejectedCode: res.body.code };
    });

    await step('Skenario 5D: Direct SQL UPDATE base_unit ditolak oleh trigger trg_fn_guard_pos_menu_item_base_unit', async () => {
      let threw = false;
      let errMsg = '';
      try {
        await pool.query("UPDATE pos_menu_items SET base_unit = 'kg', canonical_base_unit_code = 'KG' WHERE id = 203");
      } catch (err) {
        threw = true;
        errMsg = err.message;
      }
      assert.strictEqual(threw, true, 'Direct SQL UPDATE harus ditolak oleh trigger');
      assert.ok(errMsg.includes('mutasi stok') || errMsg.includes('stock_movements'), `Pesan error trigger harus menyebut mutasi: ${errMsg}`);

      return { triggerRejection: errMsg };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 6: Produk dengan track_stock = FALSE Ditolak (D-01)
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 6: Produk dengan track_stock = FALSE ditolak (400 PRODUCT_STOCK_NOT_TRACKED)', async () => {
      // Produk 204: Jasa Cuci Mobil (track_stock = FALSE)
      const req = makeReq({
        body: {
          property_id: 1,
          product_id: 204,
          location_id: 10,
          quantity: '10.000',
          operation_key: 'OP-INIT-204-WH01',
          created_by: 1,
        },
      });
      const res = makeRes();
      await openingHandler(req, res);

      assert.strictEqual(res.statusCode, 400, `Harus 400: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body.code, 'PRODUCT_STOCK_NOT_TRACKED');

      return { rejectedCode: res.body.code };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario Tambahan: Validasi Guard Input (Lokasi Nonaktif, Kuantitas Negatif, Cross-Property)
    // ─────────────────────────────────────────────────────────────────────────
    await step('Guard Tambahan: Lokasi nonaktif ditolak (400 LOCATION_INACTIVE)', async () => {
      // Lokasi 13 (OLD-01, is_active = FALSE)
      const req = makeReq({
        body: {
          property_id: 1,
          product_id: 202,
          location_id: 13,
          quantity: '10.000',
          operation_key: 'OP-INIT-202-INACT',
          created_by: 1,
        },
      });
      const res = makeRes();
      await openingHandler(req, res);

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.code, 'LOCATION_INACTIVE');

      return { rejectedCode: res.body.code };
    });

    await step('Guard Tambahan: Kuantitas negatif ditolak (400 INVALID_QUANTITY)', async () => {
      const req = makeReq({
        body: {
          property_id: 1,
          product_id: 202,
          location_id: 10,
          quantity: '-5.000',
          operation_key: 'OP-INIT-202-NEG',
          created_by: 1,
        },
      });
      const res = makeRes();
      await openingHandler(req, res);

      assert.strictEqual(res.statusCode, 400);
      assert.ok(
        res.body.code === 'DECIMAL_STRING_REQUIRED' || res.body.code === 'INVALID_QUANTITY',
        `Error code harus DECIMAL_STRING_REQUIRED atau INVALID_QUANTITY, didapat: ${res.body.code}`
      );

      return { rejectedCode: res.body.code };
    });

    await step('Guard Tambahan: Produk properti lain ditolak (404 PRODUCT_NOT_FOUND)', async () => {
      // Produk 205 adalah milik properti 2, tetapi dikirim di properti 1
      const req = makeReq({
        body: {
          property_id: 1,
          product_id: 205,
          location_id: 10,
          quantity: '10.000',
          operation_key: 'OP-INIT-205-CROSS',
          created_by: 1,
        },
      });
      const res = makeRes();
      await openingHandler(req, res);

      assert.strictEqual(res.statusCode, 404);
      assert.strictEqual(res.body.code, 'PRODUCT_NOT_FOUND');

      return { rejectedCode: res.body.code };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Skenario 7: Query Saldo (getStockBalances & GET /api/pos/stock/balances)
    // ─────────────────────────────────────────────────────────────────────────
    await step('Skenario 7A: getStockBalances mengembalikan seluruh baris saldo properti 1 dengan metadata produk & lokasi', async () => {
      // Buat saldo untuk Beras Premium (produk 202) di WH-01 (lokasi 10) pakai kemasan SAK50 (50kg) x 2 sak = 100 kg
      await prod.stockService.recordOpeningBalance(pool, {
        property_id: 1,
        product_id: 202,
        location_id: 10,
        packaging_id: 302,
        quantity: '2.000',
        operation_key: 'OP-INIT-202-WH01',
        created_by: 1,
      });

      const rows = await prod.stockService.getStockBalances(pool, { property_id: 1 });
      // Di properti 1:
      // - Produk 201 di WH-01 (loc 10): 50.000 BOTOL
      // - Produk 201 di KIT-01 (loc 11): 120.000 BOTOL
      // - Produk 203 di BAR-01 (loc 12): 0.000 GRAM
      // - Produk 202 di WH-01 (loc 10): 100.000 KG
      assert.strictEqual(rows.length, 4, `Total baris saldo harus 4, didapat: ${rows.length}`);

      const item201Loc10 = rows.find((r) => r.product_id === 201 && r.location_id === 10);
      assert.ok(item201Loc10);
      assert.strictEqual(item201Loc10.quantity, '50.000');
      assert.strictEqual(item201Loc10.product_name, 'Air Mineral 600ml');
      assert.strictEqual(item201Loc10.canonical_base_unit_code, 'BOTOL');
      assert.strictEqual(item201Loc10.location_code, 'WH-01');

      const item202Loc10 = rows.find((r) => r.product_id === 202 && r.location_id === 10);
      assert.ok(item202Loc10);
      assert.strictEqual(item202Loc10.quantity, '100.000');
      assert.strictEqual(item202Loc10.canonical_base_unit_code, 'KG');

      return { totalBalances: rows.length };
    });

    await step('Skenario 7B: GET /api/pos/stock/balances HTTP handler mendukung filter product_id dan location_id', async () => {
      // Filter product_id = 201
      const reqProd = makeReq({
        query: { property_id: 1, product_id: 201 },
      });
      const resProd = makeRes();
      await balancesHandler(reqProd, resProd);

      assert.strictEqual(resProd.statusCode, 200);
      assert.strictEqual(resProd.body.status, 'OK');
      assert.strictEqual(resProd.body.data.length, 2); // loc 10 & loc 11

      // Filter location_id = 11 (KIT-01)
      const reqLoc = makeReq({
        query: { property_id: 1, location_id: 11 },
      });
      const resLoc = makeRes();
      await balancesHandler(reqLoc, resLoc);

      assert.strictEqual(resLoc.statusCode, 200);
      assert.strictEqual(resLoc.body.data.length, 1);
      assert.strictEqual(resLoc.body.data[0].product_id, 201);
      assert.strictEqual(resLoc.body.data[0].quantity, '120.000');

      return { filterProductCount: resProd.body.data.length, filterLocationCount: resLoc.body.data.length };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Invariants & Append-Only Verification
    // ─────────────────────────────────────────────────────────────────────────
    await step('Invariants: Tidak ada saldo negatif dan total mutasi konsisten dengan saldo', async () => {
      // 1. Cek saldo negatif di stock_balances
      const negRes = await pool.query('SELECT COUNT(*) AS c FROM stock_balances WHERE quantity < 0');
      assert.strictEqual(Number(negRes.rows[0].c), 0, 'Saldo negatif harus 0');

      // 2. Verifikasi total kuantitas mutasi sama persis dengan saldo per (property, product, location)
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

      assert.ok(checkRes.rows.length >= 4);
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
    log(`SEMUA ${results.length} PENGUJIAN MP-04B BATCH 2 BERHASIL (PASS)!`);
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
