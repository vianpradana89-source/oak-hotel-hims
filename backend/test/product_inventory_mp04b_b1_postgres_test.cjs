'use strict';

/**
 * OAK HIMS — MP-04B Batch 1 PostgreSQL Integration Test
 * =====================================================
 *
 * Memverifikasi fondasi skema ledger, proyeksi saldo, dan invariants:
 *   1. Migration idempotent: dijalankan 2x tanpa error.
 *   2. pos_menu_items.track_stock:
 *      - Default FALSE untuk item yang sudah ada sebelum migrasi.
 *      - Default FALSE untuk item baru yang di-insert tanpa track_stock.
 *   3. stock_operations:
 *      - Indeks unik uq_stock_operations_prop_key mencegah reuse key di properti yang sama.
 *      - Mengizinkan key yang sama pada properti berbeda (property-scoped).
 *   4. stock_balances:
 *      - Saldo >= 0 berhasil disimpan (termasuk 0.000).
 *      - Constraint chk_stock_balance_non_negative menolak saldo < 0 (SQLSTATE 23514)
 *        dan memicu rollback total transaksi.
 *      - Unique constraint uq_stock_balances_product_location mencegah duplikasi pasangan.
 *   5. stock_movements:
 *      - INSERT mutasi berhasil.
 *      - UPDATE ditolak oleh trigger trg_guard_stock_movements_append_only.
 *      - DELETE ditolak oleh trigger trg_guard_stock_movements_append_only.
 *      - TRUNCATE ditolak oleh trigger trg_guard_stock_movements_no_truncate.
 *   6. stock_cutover_windows:
 *      - Status OPEN unik per properti (uq_stock_cutover_prop_active).
 *
 * Keamanan:
 *   - Tidak membaca backend/.env maupun kredensial aplikasi.
 *   - Menggunakan container PostgreSQL 15 terisolasi dan selalu dibersihkan.
 */

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND_DIR = path.resolve(__dirname, '..');
const REPO_DIR = path.resolve(BACKEND_DIR, '..');

const IMAGE = 'postgres:15';
const TEST_DB = 'oak_hims_mp04b_test';
const TEST_USER = 'oakmp04b_runner';
const CONTAINER_PREFIX = 'oak-hims-mp04b-test-';

const logLines = [];
function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  logLines.push(line);
  console.log(line);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(input, ms, label) {
  const promise = typeof input === 'function' ? Promise.resolve().then(input) : Promise.resolve(input);
  promise.catch(() => {});
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`Timeout ${ms} ms terlampaui: ${label}`);
          err.code = 'TEST_TIMEOUT';
          reject(err);
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const results = [];

async function step(name, fn) {
  const started = Date.now();
  const out = await fn();
  const durationMs = Date.now() - started;
  results.push({ name, ok: true, durationMs, detail: out === undefined ? null : out });
  log(`PASS  ${name} (${durationMs} ms)${out === undefined ? '' : ` :: ${typeof out === 'string' ? out : JSON.stringify(out)}`}`);
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

  for (const p of [mp03cMigrationPath, mp04bMigrationPath]) {
    if (!fs.existsSync(p)) {
      throw new Error(`Build produksi belum tersedia: ${p}. Jalankan "npm --prefix backend run build" lebih dulu.`);
    }
  }

  const mp03cMigration = require(mp03cMigrationPath);
  const mp04bMigration = require(mp04bMigrationPath);

  const envAfter = Object.fromEntries(WATCHED_ENV_KEYS.map((k) => [k, process.env[k] ?? null]));
  for (const key of WATCHED_ENV_KEYS) {
    if (envBefore[key] !== envAfter[key]) {
      throw new Error(`Impor modul produksi mengubah variabel lingkungan ${key}; dotenv guard gagal.`);
    }
  }

  return {
    mp03cMigration,
    mp04bMigration,
    interceptedCalls,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PostgreSQL Helpers
// ─────────────────────────────────────────────────────────────────────────────
let pg = null;
const allPools = [];

function makePoolConfig(applicationName) {
  return {
    host: '127.0.0.1',
    port: globalThis.__MP04B_PORT__,
    user: TEST_USER,
    password: globalThis.__MP04B_PASSWORD__,
    database: TEST_DB,
    max: 3,
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
    const client = new pg.Client({ ...makePoolConfig('mp04b-readiness'), connectionTimeoutMillis: 3000 });
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

// ─────────────────────────────────────────────────────────────────────────────
// Main Test Runner
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  log('========================================================================');
  log('OAK HIMS — MP-04B Batch 1: Schema Ledger, Projection & Invariants Test');
  log('========================================================================');

  let container = null;

  try {
    // 1. Guard & load production modules
    const prod = await step('preflight: modul produksi & dotenv stub guard', async () => {
      const p = loadProductionModules();
      pg = require(require.resolve('pg', { paths: [BACKEND_DIR] }));
      return {
        mp03cMigration: p.mp03cMigration,
        mp04bMigration: p.mp04bMigration,
        interceptedCalls: p.interceptedCalls,
      };
    });

    // 2. Start PostgreSQL container
    container = await step('preflight: container PostgreSQL 15 terisolasi', async () => {
      const c = startContainer();
      const port = resolveHostPort(c.name);
      globalThis.__MP04B_PORT__ = port;
      globalThis.__MP04B_PASSWORD__ = c.password;
      await waitForPostgres(90000);
      return { name: c.name, port };
    });

    const pool = newPool('mp04b-test-runner');

    // 3. Create baseline schema prior to MP-04B
    await step('setup: skema baseline (properties, users, rooms, pos_menu_items pre-MP04B)', async () => {
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
          name VARCHAR(100) NOT NULL,
          price DECIMAL(12,2),
          is_active BOOLEAN DEFAULT TRUE,
          is_sellable_pos BOOLEAN NOT NULL DEFAULT TRUE,
          base_unit VARCHAR(50)
        );
      `);

      // Run MP-03C migration to establish packaging and stock locations
      await prod.mp03cMigration.runProductMasterMp03cMigration(pool);

      // Insert pre-migration fixture rows
      await pool.query(`
        INSERT INTO properties (id, name) VALUES
          (1, 'Hotel OAK Seminyak'),
          (2, 'Hotel OAK Canggu');

        INSERT INTO users (id, username, full_name) VALUES
          (1, 'auditor', 'Staff Auditor');

        INSERT INTO stock_locations (property_id, code, name, location_type) VALUES
          (1, 'WH-01', 'Gudang Utama Seminyak', 'WAREHOUSE'),
          (1, 'KIT-01', 'Dapur Seminyak', 'KITCHEN'),
          (2, 'WH-02', 'Gudang Utama Canggu', 'WAREHOUSE');

        -- Item yang sudah ada SEBELUM MP-04B diterapkan
        INSERT INTO pos_menu_items (id, property_id, name, price, base_unit, canonical_base_unit_code) VALUES
          (101, 1, 'Air Mineral 600ml', 10000, 'botol', 'BOTOL'),
          (102, 1, 'Nasi Goreng Spesial', 45000, 'porsi', 'PORSI');

        INSERT INTO product_packaging_conversions (
          property_id, menu_item_id, packaging_code, packaging_label, base_unit_code, to_base_factor, idempotency_key
        ) VALUES (
          1, 101, 'DUS24', 'Dus 24 Botol', 'BOTOL', 24.000, 'SEED-PPC-101-DUS24'
        );
      `);

      return { preMigrationItems: 2, stockLocations: 3 };
    });

    // 4. Migration Execution 1st run
    await step('migration: eksekusi pertama runProductInventoryMp04bB1Migration', async () => {
      await prod.mp04bMigration.runProductInventoryMp04bB1Migration(pool);
      return 'OK';
    });

    // 5. Migration Idempotency: Execution 2nd run
    await step('migration: eksekusi kedua (uji idempotensi, tidak boleh error)', async () => {
      await prod.mp04bMigration.runProductInventoryMp04bB1Migration(pool);
      return 'OK';
    });

    // 6. Verify track_stock defaults
    await step('invariant: pos_menu_items.track_stock bernilai FALSE untuk item existing dan item baru', async () => {
      // Periksa item yang sudah ada sebelum migrasi (101 dan 102)
      const existingRes = await pool.query(
        'SELECT id, track_stock FROM pos_menu_items WHERE id IN (101, 102) ORDER BY id'
      );
      if (existingRes.rows.length !== 2) throw new Error('Item existing tidak ditemukan');
      for (const row of existingRes.rows) {
        if (row.track_stock !== false) {
          throw new Error(`Item existing ${row.id} track_stock bernilai ${row.track_stock}, diharapkan false`);
        }
      }

      // Insert item baru tanpa menyertakan kolom track_stock
      const insertRes = await pool.query(`
        INSERT INTO pos_menu_items (id, property_id, name, price, base_unit, canonical_base_unit_code)
        VALUES (103, 1, 'Es Teh Manis', 12000, 'gelas', 'GELAS')
        RETURNING track_stock
      `);
      if (insertRes.rows[0].track_stock !== false) {
        throw new Error(`Item baru 103 track_stock bernilai ${insertRes.rows[0].track_stock}, diharapkan default false`);
      }

      // Update opt-in ke TRUE berhasil
      await pool.query('UPDATE pos_menu_items SET track_stock = TRUE WHERE id = 101');
      const optInRes = await pool.query('SELECT track_stock FROM pos_menu_items WHERE id = 101');
      if (optInRes.rows[0].track_stock !== true) {
        throw new Error('Gagal mengaktifkan track_stock = TRUE pada item 101');
      }

      // Periksa keberadaan indeks parsial
      const idxCheck = await pool.query(`
        SELECT indexname FROM pg_indexes
         WHERE tablename = 'pos_menu_items'
           AND indexname = 'idx_pos_menu_items_property_track_stock'
      `);
      if (idxCheck.rowCount === 0) {
        throw new Error('Indeks idx_pos_menu_items_property_track_stock tidak ditemukan');
      }

      return { existingDefaultFalse: true, newDefaultFalse: true, optInWorking: true };
    });

    // 7. Verify stock_operations uniqueness (property_id, operation_key)
    await step('invariant: stock_operations mencegah reuse idempotency key di properti yang sama', async () => {
      // 1. Insert operasi pertama di properti 1 -> sukses
      await pool.query(`
        INSERT INTO stock_operations (
          property_id, operation_type, operation_key, payload_fingerprint, created_by
        ) VALUES (
          1, 'OPENING', 'OP-KEY-1001', 'fingerprint_hash_abc_1', 1
        )
      `);

      // 2. Insert operasi kedua dengan key sama di properti 1 -> harus gagal (23505)
      let duplicateCaught = false;
      try {
        await pool.query(`
          INSERT INTO stock_operations (
            property_id, operation_type, operation_key, payload_fingerprint, created_by
          ) VALUES (
            1, 'RECEIPT', 'OP-KEY-1001', 'fingerprint_hash_abc_2', 1
          )
        `);
      } catch (err) {
        if (err.code === '23505') {
          duplicateCaught = true;
        } else {
          throw err;
        }
      }
      if (!duplicateCaught) {
        throw new Error('Constraint uq_stock_operations_prop_key gagal menolak key duplikat di properti yang sama');
      }

      // 3. Insert operasi dengan key sama tapi di properti 2 -> harus berhasil (property-scoped)
      await pool.query(`
        INSERT INTO stock_operations (
          property_id, operation_type, operation_key, payload_fingerprint, created_by
        ) VALUES (
          2, 'OPENING', 'OP-KEY-1001', 'fingerprint_hash_prop2', 1
        )
      `);

      return { samePropertyRejected: true, crossPropertyAllowed: true };
    });

    // 8. Verify stock_balances non-negative constraint and transaction rollback
    await step('invariant: stock_balances menolak saldo < 0 dan memicu rollback total', async () => {
      const locRes = await pool.query("SELECT id FROM stock_locations WHERE property_id = 1 AND code = 'WH-01'");
      const locId = locRes.rows[0].id;

      // 1. Saldo valid >= 0 (10.000 dan 0.000)
      await pool.query(`
        INSERT INTO stock_balances (property_id, product_id, location_id, quantity)
        VALUES (1, 101, $1, 10.000)
      `, [locId]);

      await pool.query(`
        INSERT INTO stock_balances (property_id, product_id, location_id, quantity)
        VALUES (1, 102, $1, 0.000)
      `, [locId]);

      // 2. Transaksi yang mencoba memasukkan saldo negatif harus gagal dan di-rollback total
      const client = await pool.connect();
      let checkViolationCaught = false;
      try {
        await client.query('BEGIN');
        // Operasi awal di dalam transaksi
        await client.query(`
          INSERT INTO stock_operations (
            property_id, operation_type, operation_key, payload_fingerprint
          ) VALUES (
            1, 'ADJUSTMENT', 'OP-KEY-FAIL-TX', 'fp_fail'
          )
        `);

        // Mencoba insert saldo negatif (-0.001)
        await client.query(`
          INSERT INTO stock_balances (property_id, product_id, location_id, quantity)
          VALUES (1, 103, $1, -0.001)
        `, [locId]);

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23514' && err.constraint === 'chk_stock_balance_non_negative') {
          checkViolationCaught = true;
        } else {
          throw err;
        }
      } finally {
        client.release();
      }

      if (!checkViolationCaught) {
        throw new Error('chk_stock_balance_non_negative gagal menolak saldo negatif');
      }

      // Verifikasi rollback total: operasi OP-KEY-FAIL-TX tidak tersimpan
      const opCheck = await pool.query(
        "SELECT 1 FROM stock_operations WHERE operation_key = 'OP-KEY-FAIL-TX'"
      );
      if (opCheck.rowCount !== 0) {
        throw new Error('Rollback gagal: operasi bisnis tetap tersisa di stock_operations');
      }

      // 3. Update yang membuat saldo negatif juga harus ditolak
      let updateViolationCaught = false;
      try {
        await pool.query(`
          UPDATE stock_balances
             SET quantity = -1.000
           WHERE property_id = 1 AND product_id = 101 AND location_id = $1
        `, [locId]);
      } catch (err) {
        if (err.code === '23514') {
          updateViolationCaught = true;
        } else {
          throw err;
        }
      }
      if (!updateViolationCaught) {
        throw new Error('chk_stock_balance_non_negative gagal menolak UPDATE ke saldo negatif');
      }

      // Saldo item 101 harus tetap 10.000
      const balCheck = await pool.query(`
        SELECT quantity FROM stock_balances
         WHERE property_id = 1 AND product_id = 101 AND location_id = $1
      `, [locId]);
      if (Number(balCheck.rows[0].quantity) !== 10.000) {
        throw new Error(`Saldo item 101 berubah menjadi ${balCheck.rows[0].quantity}, diharapkan 10.000`);
      }

      // 4. Unique constraint uq_stock_balances_product_location
      let dupeBalCaught = false;
      try {
        await pool.query(`
          INSERT INTO stock_balances (property_id, product_id, location_id, quantity)
          VALUES (1, 101, $1, 5.000)
        `, [locId]);
      } catch (err) {
        if (err.code === '23505') {
          dupeBalCaught = true;
        } else {
          throw err;
        }
      }
      if (!dupeBalCaught) {
        throw new Error('uq_stock_balances_product_location gagal menolak duplikasi pasangan produk×lokasi');
      }

      return { nonNegativeEnforced: true, rollbackVerified: true, uniquePairEnforced: true };
    });

    // 9. Verify stock_movements append-only invariants (reject UPDATE, DELETE, TRUNCATE)
    await step('invariant: stock_movements bersikap APPEND-ONLY (tolak UPDATE, DELETE, TRUNCATE)', async () => {
      const opRes = await pool.query("SELECT id FROM stock_operations WHERE operation_key = 'OP-KEY-1001'");
      const opId = opRes.rows[0].id;
      const locRes = await pool.query("SELECT id FROM stock_locations WHERE property_id = 1 AND code = 'WH-01'");
      const locId = locRes.rows[0].id;

      // 1. INSERT mutasi berhasil
      const insMov = await pool.query(`
        INSERT INTO stock_movements (
          operation_id, property_id, product_id, location_id, packaging_id,
          packaging_code, packaging_label, quantity_delta, base_unit_code, unit_cost
        ) VALUES (
          $1, 1, 101, $2, NULL, NULL, NULL, 10.000, 'BOTOL', 5000.00
        )
        RETURNING id, quantity_delta
      `, [opId, locId]);
      const movementId = insMov.rows[0].id;

      // 2. UPDATE harus ditolak trigger
      let updateRejected = false;
      try {
        await pool.query('UPDATE stock_movements SET quantity_delta = 99.000 WHERE id = $1', [movementId]);
      } catch (err) {
        if (err.message && err.message.includes('STOCK_MOVEMENTS_APPEND_ONLY')) {
          updateRejected = true;
        } else {
          throw err;
        }
      }
      if (!updateRejected) {
        throw new Error('Trigger gagal menolak UPDATE pada stock_movements');
      }

      // 3. DELETE harus ditolak trigger
      let deleteRejected = false;
      try {
        await pool.query('DELETE FROM stock_movements WHERE id = $1', [movementId]);
      } catch (err) {
        if (err.message && err.message.includes('STOCK_MOVEMENTS_APPEND_ONLY')) {
          deleteRejected = true;
        } else {
          throw err;
        }
      }
      if (!deleteRejected) {
        throw new Error('Trigger gagal menolak DELETE pada stock_movements');
      }

      // 4. TRUNCATE harus ditolak trigger
      let truncateRejected = false;
      try {
        await pool.query('TRUNCATE TABLE stock_movements');
      } catch (err) {
        if (err.message && err.message.includes('STOCK_MOVEMENTS_APPEND_ONLY')) {
          truncateRejected = true;
        } else {
          throw err;
        }
      }
      if (!truncateRejected) {
        throw new Error('Trigger gagal menolak TRUNCATE pada stock_movements');
      }

      // 5. Buktikan data mutasi tidak berubah sama sekali
      const movCheck = await pool.query('SELECT quantity_delta FROM stock_movements WHERE id = $1', [movementId]);
      if (Number(movCheck.rows[0].quantity_delta) !== 10.000) {
        throw new Error('Kuantitas mutasi berubah setelah percobaan UPDATE/DELETE!');
      }

      return { insertAllowed: true, updateRejected: true, deleteRejected: true, truncateRejected: true };
    });

    // 10. Verify stock_cutover_windows active constraint
    await step('invariant: stock_cutover_windows status OPEN unik per properti', async () => {
      // 1. Window OPEN pertama di properti 1 -> sukses
      await pool.query(`
        INSERT INTO stock_cutover_windows (property_id, cutover_at, status)
        VALUES (1, NOW(), 'OPEN')
      `);

      // 2. Window OPEN kedua di properti 1 -> gagal
      let dupeOpenCaught = false;
      try {
        await pool.query(`
          INSERT INTO stock_cutover_windows (property_id, cutover_at, status)
          VALUES (1, NOW(), 'OPEN')
        `);
      } catch (err) {
        if (err.code === '23505') {
          dupeOpenCaught = true;
        } else {
          throw err;
        }
      }
      if (!dupeOpenCaught) {
        throw new Error('uq_stock_cutover_prop_active gagal menolak multiple OPEN windows pada properti yang sama');
      }

      // 3. Window OPEN di properti 2 -> sukses
      await pool.query(`
        INSERT INTO stock_cutover_windows (property_id, cutover_at, status)
        VALUES (2, NOW(), 'OPEN')
      `);

      return { singleActivePerProperty: true, crossPropertyAllowed: true };
    });

    log('');
    log('========================================================================');
    log('HASIL AKHIR: SEMUA SKENARIO MP-04B BATCH 1 LULUS DENGAN LENGKAP!');
    log('========================================================================');
    for (const r of results) {
      log(`PASS [${r.durationMs}ms] ${r.name}`);
    }

    return 0;
  } catch (err) {
    log('');
    log(`FATAL ERROR: ${err.message || err}`);
    if (err.stack) log(err.stack);
    return 1;
  } finally {
    await closeAllPools();
    if (container) {
      stopContainer(container.name);
      log(`Container ${container.name} dibersihkan.`);
    }
  }
}

main().then((code) => {
  process.exit(code);
}).catch((err) => {
  console.error('Fatal in test process:', err);
  process.exit(1);
});
