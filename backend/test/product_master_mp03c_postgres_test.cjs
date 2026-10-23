'use strict';

/**
 * OAK HIMS — MP-03C PostgreSQL 15 Integration & Concurrency Test
 * =============================================================
 *
 * Tujuan: menutup kekurangan bukti eksekusi nyata (bukan mock) untuk MP-03C:
 *   1. Migrasi produksi dijalankan DUA KALI pada database PostgreSQL nyata
 *      (idempotensi DDL + data fixture tidak berubah makna).
 *   2. Verifikasi katalog PostgreSQL: kolom, constraint, unique index,
 *      dan ketiga guard trigger.
 *   3. Uji transaksi BERSAMAAN memakai handler produksi dengan barrier
 *      terkontrol: buktikan operasi kedua benar-benar menunggu row lock
 *      (pg_stat_activity / pg_blocking_pids), bukan sekadar berurutan.
 *   4. Validasi guard DB: snapshot immutable, kemasan nonaktif menyimpan
 *      satuan lama, identitas lokasi immutable, relasi kamar lintas properti,
 *      dan duplikasi lokasi minibar.
 *
 * Batasan:
 *   - Tidak membaca backend/.env maupun kredensial aplikasi. dotenv.config
 *     diganti stub SEBELUM modul produksi diimpor, dan variabel DB_* diawasi
 *     agar tidak berubah akibat impor.
 *   - Tidak menjalankan index.ts / bootstrap aplikasi.
 *   - Seluruh koneksi pg memakai konfigurasi eksplisit ke container test.
 *   - Container dibuat & dihapus HANYA oleh runner ini (nama unik berawalan
 *     oak-hims-mp03c-test-). Tidak ada docker prune / container lain disentuh.
 *
 * Prasyarat: Docker aktif, image postgres:15 tersedia, backend sudah dibangun
 * (`npm --prefix backend run build`) agar dist/ memuat source produksi terbaru.
 *
 * Output: ringkasan di stdout + report JSON & log di MP03C_REPORT_DIR.
 *
 * Exit code: 0 = semua lulus, 1 = ada kegagalan/fatal.
 */

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND_DIR = path.resolve(__dirname, '..');
const REPO_DIR = path.resolve(BACKEND_DIR, '..');

const IMAGE = 'postgres:15';
const TEST_DB = 'oak_hims_mp03c_test';
const TEST_USER = 'oakmp03c_runner';
const CONTAINER_PREFIX = 'oak-hims-mp03c-test-';

const REPORT_DIR = process.env.MP03C_REPORT_DIR
  ? path.resolve(process.env.MP03C_REPORT_DIR)
  : path.join(__dirname, 'artifacts-mp03c-postgres');

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
  // Cegah unhandled rejection bila timeout memenangkan race.
  promise.catch(() => {});
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`Batas waktu ${ms} ms terlampaui: ${label}`);
          err.code = 'TEST_TIMEOUT';
          reject(err);
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hasil pengujian
// ─────────────────────────────────────────────────────────────────────────────
const results = [];
const artifacts = {};

async function step(name, fn) {
  const started = Date.now();
  const out = await fn();
  const durationMs = Date.now() - started;
  results.push({ name, ok: true, durationMs, detail: out === undefined ? null : out });
  log(`PASS  ${name} (${durationMs} ms)${out === undefined ? '' : ` :: ${typeof out === 'string' ? out : JSON.stringify(out)}`}`);
  return out;
}

async function scenario(name, fn, timeoutMs = 60000) {
  const started = Date.now();
  try {
    const detail = await withTimeout(fn, timeoutMs, name);
    const durationMs = Date.now() - started;
    results.push({ name, ok: true, durationMs, detail: detail === undefined ? null : detail });
    log(`PASS  ${name} (${durationMs} ms)${detail === undefined ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
    return true;
  } catch (err) {
    const durationMs = Date.now() - started;
    const detail = {
      error: err?.message || String(err),
      code: err?.code || null,
      sqlState: err?.sqlState || null,
      constraint: err?.constraint || null,
    };
    results.push({ name, ok: false, durationMs, detail });
    log(`FAIL  ${name} (${durationMs} ms) :: ${err?.name || 'Error'}${err?.code ? ` code=${err.code}` : ''} ${err?.message || String(err)}`);
    if (err?.sqlState) log(`      SQLSTATE=${err.sqlState}${err?.constraint ? ` constraint=${err.constraint}` : ''}`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Docker
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

function listOurContainers() {
  const out = docker(
    ['ps', '-a', '--filter', `name=${CONTAINER_PREFIX}`, '--format', '{{.Names}}'],
    { allowFail: true, timeout: 30000 }
  );
  if (!out) return [];
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
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

function inspectContainer(containerName) {
  const raw = docker(['inspect', containerName], { timeout: 30000 });
  const [info] = JSON.parse(raw);
  const mounts = (info.Mounts || []).map((m) => ({
    type: m.Type,
    name: m.Name || null,
    destination: m.Destination,
  }));
  const portBindings = info.HostConfig?.PortBindings || {};
  return {
    id: info.Id,
    name: String(info.Name || '').replace(/^\//, ''),
    image: info.Config?.Image || null,
    imageId: info.Image || null,
    mounts,
    portBindings,
    created: info.Created || null,
  };
}

function stopContainer(containerName) {
  if (!containerName) return { attempted: false, removed: false, stillPresent: [] };
  const removed = docker(['rm', '-f', containerName], { allowFail: true, timeout: 60000 }) !== null;
  const stillPresent = docker(['inspect', containerName], { allowFail: true, timeout: 30000 }) !== null;
  return { attempted: true, removed, stillPresent: stillPresent ? [containerName] : [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Modul produksi (dist) + guard dotenv
// ─────────────────────────────────────────────────────────────────────────────
const WATCHED_ENV_KEYS = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'DB_PORT'];

function loadProductionModules() {
  const envBefore = Object.fromEntries(WATCHED_ENV_KEYS.map((k) => [k, process.env[k] ?? null]));

  const dotenvPath = require.resolve('dotenv', { paths: [BACKEND_DIR] });
  const dotenv = require(dotenvPath);
  const dotenvState = { interceptedConfigCalls: 0 };
  dotenv.config = () => {
    dotenvState.interceptedConfigCalls += 1;
    // Tidak membaca file .env apa pun.
    return { parsed: {} };
  };

  const migrationPath = path.join(BACKEND_DIR, 'dist', 'db', 'migrations', 'product_master_mp03c_v1.js');
  const unitsPath = path.join(BACKEND_DIR, 'dist', 'domains', 'pos', 'productUnitsAndLocations.js');
  const stage1Path = path.join(BACKEND_DIR, 'dist', 'domains', 'pos', 'productMasterStage1.js');
  for (const p of [migrationPath, unitsPath, stage1Path]) {
    if (!fs.existsSync(p)) {
      throw new Error(`Build produksi belum tersedia: ${p}. Jalankan "npm --prefix backend run build" lebih dulu.`);
    }
  }

  const migration = require(migrationPath);
  const units = require(unitsPath);
  const stage1 = require(stage1Path);

  const envAfter = Object.fromEntries(WATCHED_ENV_KEYS.map((k) => [k, process.env[k] ?? null]));
  for (const key of WATCHED_ENV_KEYS) {
    if (envBefore[key] !== envAfter[key]) {
      throw new Error(`Impor modul produksi mengubah variabel lingkungan ${key}; dotenv guard gagal.`);
    }
  }
  if (typeof migration.runProductMasterMp03cMigration !== 'function') {
    throw new Error('runProductMasterMp03cMigration tidak diekspor oleh modul migrasi produksi.');
  }
  if (typeof units.createProductPackagingCreateHandler !== 'function') {
    throw new Error('createProductPackagingCreateHandler tidak diekspor oleh productUnitsAndLocations.');
  }
  if (typeof stage1.createPosMenuItemPatchHandler !== 'function') {
    throw new Error('createPosMenuItemPatchHandler tidak diekspor oleh productMasterStage1.');
  }

  return {
    migration,
    units,
    stage1,
    dotenvPath,
    dotenvState,
    envBefore,
    envAfter,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PostgreSQL helpers
// ─────────────────────────────────────────────────────────────────────────────
let pg = null;
const allPools = [];

function makePoolConfig(applicationName, { max = 3, withTimeouts = true } = {}) {
  const cfg = {
    host: '127.0.0.1',
    port: globalThis.__MP03C_PORT__,
    user: TEST_USER,
    password: globalThis.__MP03C_PASSWORD__,
    database: TEST_DB,
    max,
    application_name: applicationName,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
  };
  if (withTimeouts) {
    cfg.options = '-c statement_timeout=30000 -c lock_timeout=15000';
  }
  return cfg;
}

function newPool(applicationName, opts) {
  const pool = new pg.Pool(makePoolConfig(applicationName, opts));
  pool.on('error', (err) => log(`  [pool:${applicationName}] error idle client: ${err.message}`));
  allPools.push(pool);
  return pool;
}

async function closePool(pool) {
  if (!pool) return;
  try {
    await withTimeout(pool.end(), 5000, 'pool.end');
  } catch {
    // Diabaikan: proses akan keluar eksplisit setelah laporan ditulis.
  }
}

async function waitForPostgres(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    const client = new pg.Client({ ...makePoolConfig('mp03c-readiness', { max: 1, withTimeouts: false }), connectionTimeoutMillis: 3000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (err) {
      lastErr = err;
      try {
        await client.end();
      } catch {
        // ignore
      }
      await sleep(500);
    }
  }
  throw new Error(`PostgreSQL tidak siap dalam ${timeoutMs} ms: ${lastErr?.message || 'unknown'}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture schema: diambil dari source repository
// ─────────────────────────────────────────────────────────────────────────────
function extractCreateTableBlock(source, table, sourceLabel) {
  const start = source.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start < 0) throw new Error(`DDL ${table} tidak ditemukan di ${sourceLabel}`);
  const end = source.indexOf('\n    );', start);
  if (end < 0) throw new Error(`Penutup DDL ${table} tidak ditemukan di ${sourceLabel}`);
  return source.slice(start, end + 7);
}

function buildFixtureSchemaSql() {
  const schemaV2 = fs.readFileSync(path.join(BACKEND_DIR, 'src', 'db', 'schema_v2.ts'), 'utf8');
  const schemaV3 = fs.readFileSync(path.join(BACKEND_DIR, 'src', 'db', 'schema_v3.ts'), 'utf8');

  const properties = extractCreateTableBlock(schemaV2, 'properties', 'schema_v2.ts');
  const rooms = extractCreateTableBlock(schemaV2, 'rooms', 'schema_v2.ts');
  const categories = extractCreateTableBlock(schemaV3, 'pos_menu_categories', 'schema_v3.ts');
  let menuItems = extractCreateTableBlock(schemaV3, 'pos_menu_items', 'schema_v3.ts');

  // Baseline pra-MP-03C: kolom canonical_base_unit_code BELUM ada, sehingga
  // langkah 01 migrasi produksi benar-benar menambahkannya (bukan no-op).
  const stripped = menuItems.replace(/^[ \t]*canonical_base_unit_code VARCHAR\(20\),[ \t]*\r?\n/mi, '');
  if (stripped === menuItems) {
    throw new Error('Gagal menyiapkan baseline pra-MP-03C: baris canonical_base_unit_code tidak ditemukan pada DDL pos_menu_items.');
  }
  menuItems = stripped;

  return [
    properties,
    rooms,
    'ALTER TABLE rooms ADD COLUMN IF NOT EXISTS property_id INTEGER;',
    `CREATE INDEX IF NOT EXISTS mp03c_test_rooms_property_idx ON rooms(property_id);`,
    categories,
    'ALTER TABLE pos_menu_categories ADD COLUMN IF NOT EXISTS property_id INTEGER;',
    menuItems,
    'ALTER TABLE pos_menu_items ADD COLUMN IF NOT EXISTS property_id INTEGER;',
    `CREATE INDEX IF NOT EXISTS mp03c_test_pos_menu_items_property_idx ON pos_menu_items(property_id);`,
  ].join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler produksi + request/response test object
// ─────────────────────────────────────────────────────────────────────────────
function depsFor(pool) {
  return {
    pool,
    assertPropertyScope: async () => {},
  };
}

function makeReq({ params = {}, body = {}, query = {} } = {}) {
  return { params, body, query };
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

async function invoke(handler, req) {
  const res = makeRes();
  await handler(req, res);
  return res;
}

// Barrier: jeda SETELAH statement SQL nyata selesai & transaksi masih terbuka,
// sehingga row lock benar-benar dipegang saat operasi kedua dijalankan.
function createBarrier() {
  let reachResolve = null;
  let releaseResolve = null;
  let armed = false;
  let released = false;
  const reached = new Promise((resolve) => {
    reachResolve = resolve;
  });
  const releasePromise = new Promise((resolve) => {
    releaseResolve = resolve;
  });

  return {
    reached,
    armOnce() {
      if (armed) return;
      armed = true;
      reachResolve();
    },
    waitRelease() {
      return releasePromise;
    },
    release() {
      if (released) return;
      released = true;
      releaseResolve();
    },
  };
}

const ITEM_ROW_LOCK_MATCHER = (sql) => /from\s+pos_menu_items[\s\S]*?\bfor\s+update\b/i.test(sql);

function createGatedPool(pool, barrier) {
  let triggered = false;
  return {
    query: (sql, params) => pool.query(sql, params),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql, params) => {
          const res = await client.query(sql, params);
          if (!triggered && ITEM_ROW_LOCK_MATCHER(String(sql))) {
            triggered = true;
            barrier.armOnce();
            await barrier.waitRelease();
          }
          return res;
        },
        release: () => client.release(),
      };
    },
  };
}

async function waitForLockWait(monitorPool, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await monitorPool.query(
      `SELECT a.pid,
              a.application_name,
              a.wait_event_type,
              a.wait_event,
              LEFT(a.query, 160) AS query,
              pg_blocking_pids(a.pid) AS blockers
         FROM pg_stat_activity a
        WHERE a.datname = current_database()
          AND a.pid <> pg_backend_pid()
          AND a.wait_event_type = 'Lock'
        ORDER BY a.pid`
    );
    if (rows.length > 0) return rows;
    await sleep(50);
  }
  return null;
}

async function captureSqlError(pool, sql, params) {
  try {
    await pool.query(sql, params);
    return null;
  } catch (err) {
    return {
      code: err.code || null,
      message: err.message || String(err),
      constraint: err.constraint || null,
      detail: err.detail || null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RACE: dua transaksi independen + barrier terkontrol
// ─────────────────────────────────────────────────────────────────────────────
async function runRace({
  name,
  op1,
  op2,
  expect1,
  expect2,
  verify,
  monitorPool,
}) {
  const gate = createBarrier();
  const app1 = `mp03c-op1-${name}`;
  const app2 = `mp03c-op2-${name}`;
  const pool1 = newPool(app1, { max: 2 });
  const pool2 = newPool(app2, { max: 2 });

  let p1 = null;
  let p2 = null;
  let settled1 = false;
  let settled2 = false;
  let released = false;

  const assertOutcome = (label, res, expect) => {
    if (expect.status !== undefined) {
      if (res.statusCode !== expect.status) {
        throw new Error(
          `${label}: status ${res.statusCode} (diharapkan ${expect.status}); body=${JSON.stringify(res.body)}`
        );
      }
    }
    if (expect.code !== undefined) {
      const actual = res.body?.code ?? null;
      if (actual !== expect.code) {
        throw new Error(
          `${label}: code "${actual}" (diharapkan "${expect.code}"); body=${JSON.stringify(res.body)}`
        );
      }
    }
    if (expect.replayed !== undefined && res.body?.replayed !== expect.replayed) {
      throw new Error(`${label}: replayed=${res.body?.replayed} (diharapkan ${expect.replayed})`);
    }
  };

  try {
    // Operasi 1 selalu pemegang lock pertama (di-gate SETELAH row lock-nya
    // benar-benar diperoleh, sebelum transaksi di-commit).
    const handler1 = op1.handler(createGatedPool(pool1, gate));
    const handler2 = op2.handler(pool2);

    p1 = invoke(handler1, op1.req).then((r) => {
      settled1 = true;
      return r;
    });
    p1.catch(() => {});

    await withTimeout(gate.reached, 6000, `barrier operasi 1 (${name})`);

    const startWait = Date.now();
    p2 = invoke(handler2, op2.req).then((r) => {
      settled2 = true;
      return r;
    });
    p2.catch(() => {});

    const blockedRows = await waitForLockWait(monitorPool, 6000);
    const waitedMs = Date.now() - startWait;

    if (!blockedRows) {
      throw new Error(
        'Tidak ada backend yang berstatus menunggu lock (pg_stat_activity.wait_event_type = Lock) dalam 6000 ms; ' +
          'skenario ini TIDAK dapat disebut konkurensi terkontrol.'
      );
    }

    const gatedSettled = settled1;
    if (gatedSettled) {
      throw new Error('Operasi pemegang lock sudah selesai sebelum gate dilepas; barrier tidak valid.');
    }

    const gatedApp = app1;
    const gatedPidRows = (
      await monitorPool.query(
        `SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = $1 AND state <> 'idle'`,
        [gatedApp]
      )
    ).rows;
    if (gatedPidRows.length !== 1) {
      throw new Error(`Tidak dapat mengidentifikasi tepat satu backend pemegang lock (${gatedApp}); ditemukan ${gatedPidRows.length}.`);
    }
    const gatedPid = Number(gatedPidRows[0].pid);

    for (const row of blockedRows) {
      const blockers = (row.blockers || []).map(Number);
      if (!blockers.includes(gatedPid)) {
        throw new Error(
          `Backend ${row.pid} menunggu lock tetapi tidak diblokir oleh PID ${gatedPid} (blockers=${JSON.stringify(blockers)}).`
        );
      }
    }

    const evidence = {
      gatedPid,
      blockedPids: blockedRows.map((r) => Number(r.pid)),
      waitEventType: blockedRows.map((r) => r.wait_event_type),
      waitEvent: blockedRows.map((r) => r.wait_event),
      blockers: blockedRows.map((r) => (r.blockers || []).map(Number)),
      blockedQuery: blockedRows.map((r) => r.query),
      waitedMs,
    };

    gate.release();
    released = true;

    const [r1, r2] = await withTimeout(Promise.all([p1, p2]), 20000, `penyelesaian race (${name})`);

    assertOutcome('Operasi 1', r1, expect1);
    assertOutcome('Operasi 2', r2, expect2);

    const verifyDetail = verify ? await verify({ r1, r2, evidence }) : null;

    return {
      lockHolder: 'op1',
      first: op1.label,
      second: op2.label,
      op1: { status: r1.statusCode, code: r1.body?.code ?? null },
      op2: { status: r2.statusCode, code: r2.body?.code ?? null },
      blocking: evidence,
      verify: verifyDetail,
    };
  } finally {
    if (!released) gate.release();
    await closePool(pool1);
    await closePool(pool2);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const startedAt = new Date();
  log('=== OAK HIMS — MP-03C PostgreSQL 15 Integration & Concurrency Test ===');
  log(`waktu       : ${startedAt.toISOString()}`);
  log(`workspace   : ${REPO_DIR}`);
  log(`runner      : ${__filename}`);
  log(`report dir  : ${REPORT_DIR}`);

  let container = null;
  let containerStarted = false;
  let fatal = null;
  let cleanup = null;
  let identity = null;
  let fixtureIds = null;

  const containersBefore = (() => {
    try {
      return listOurContainers();
    } catch (err) {
      return [`<tidak dapat membaca docker: ${err.message}>`];
    }
  })();
  artifacts.containersBefore = containersBefore;

  try {
    // ── Preflight: Docker & image ───────────────────────────────────────────
    await step('preflight: Docker daemon & image postgres:15', async () => {
      const ver = docker(['version', '--format', '{{.Server.Version}}'], { timeout: 30000 });
      const img = docker(['image', 'ls', IMAGE, '--format', '{{.Repository}}:{{.Tag}}'], { timeout: 30000 });
      if (!img) {
        throw new Error(`Image ${IMAGE} tidak tersedia lokal; runner tidak menarik image otomatis.`);
      }
      return { dockerServer: ver, image: img };
    });

    // ── Preflight: modul produksi + dotenv guard ────────────────────────────
    const prod = await step('preflight: impor modul produksi tanpa membaca .env', async () => {
      const loaded = loadProductionModulesCached();
      return {
        dotenvModule: loaded.dotenvPath.replace(REPO_DIR, '<repo>'),
        dotenvConfigInterceptedCalls: loaded.dotenvState.interceptedConfigCalls,
        envUnchanged: true,
        distModules: [
          'dist/db/migrations/product_master_mp03c_v1.js',
          'dist/domains/pos/productUnitsAndLocations.js',
          'dist/domains/pos/productMasterStage1.js',
        ],
      };
    });
    if (prod.dotenvConfigInterceptedCalls < 1) {
      throw new Error('dotenv.config stub tidak pernah dipanggil saat impor modul produksi; guard tidak membuktikan apa pun.');
    }
    const loadedProd = loadProductionModulesCached();
    pg = require(require.resolve('pg', { paths: [BACKEND_DIR] }));

    // ── Container ───────────────────────────────────────────────────────────
    const started = await step('preflight: container PostgreSQL 15 terisolasi', async () => {
      const c = startContainer();
      container = c;
      containerStarted = true;
      const port = resolveHostPort(c.name);
      globalThis.__MP03C_PORT__ = port;
      globalThis.__MP03C_PASSWORD__ = c.password;
      await waitForPostgres(90000);
      const info = inspectContainer(c.name);
      const bindMounts = info.mounts.filter((m) => m.type === 'bind');
      if (bindMounts.length > 0) {
        throw new Error(`Container memakai bind mount (dilarang): ${JSON.stringify(bindMounts)}`);
      }
      const binding = info.portBindings['5432/tcp'] || [];
      if (!binding.length || binding.some((b) => b.HostIp !== '127.0.0.1')) {
        throw new Error(`Port 5432 tidak dipublikasikan hanya ke 127.0.0.1: ${JSON.stringify(binding)}`);
      }
      if (info.name !== c.name) {
        throw new Error(`Nama container tidak sesuai: ${info.name} vs ${c.name}`);
      }
      artifacts.container = {
        name: info.name,
        id: info.id,
        image: info.image,
        imageId: info.imageId,
        hostPort: port,
        hostIp: '127.0.0.1',
        mounts: info.mounts,
        portBindings: binding,
        created: info.created,
      };
      return { name: c.name, hostPort: port, bindMounts: bindMounts.length, mounts: info.mounts.length };
    });
    log(`      container=${started.name} hostPort=${started.hostPort}`);

    // ── Identitas database ──────────────────────────────────────────────────
    const adminPool = newPool('mp03c-admin');
    identity = await step('preflight: identitas database/user/versi PostgreSQL', async () => {
      const { rows } = await adminPool.query(
        `SELECT current_database() AS db,
                current_user       AS usr,
                current_setting('server_version_num') AS version_num,
                version() AS version_text`
      );
      const row = rows[0];
      const major = Math.floor(Number(row.version_num) / 10000);
      if (row.db !== TEST_DB) throw new Error(`current_database()=${row.db}, diharapkan ${TEST_DB}`);
      if (row.usr !== TEST_USER) throw new Error(`current_user=${row.usr}, diharapkan ${TEST_USER}`);
      if (major !== 15) throw new Error(`Versi mayor PostgreSQL=${major} (server_version_num=${row.version_num}), diharapkan 15`);
      artifacts.postgres = {
        container: container.name,
        database: row.db,
        user: row.usr,
        versionNum: Number(row.version_num),
        major,
        versionText: row.version_text,
      };
      return { database: row.db, user: row.usr, major, versionNum: Number(row.version_num) };
    });

    const monitorPool = newPool('mp03c-monitor', { max: 2, withTimeouts: false });
    const workPool = newPool('mp03c-work', { max: 3, withTimeouts: false });

    // ── Fixture schema (baseline pra-MP-03C) ────────────────────────────────
    await step('fixture: schema prasyarat dari source repository', async () => {
      const sql = buildFixtureSchemaSql();
      await workPool.query(sql);
      const { rows } = await workPool.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema='public' AND table_name IN ('properties','rooms','pos_menu_categories','pos_menu_items')
          ORDER BY table_name`
      );
      const names = rows.map((r) => r.table_name);
      if (names.length !== 4) throw new Error(`Tabel prasyarat tidak lengkap: ${names.join(', ')}`);
      const col = await workPool.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='pos_menu_items' AND column_name='canonical_base_unit_code'`
      );
      if (col.rowCount !== 0) {
        throw new Error('Baseline pra-MP-03C tidak valid: kolom canonical_base_unit_code sudah ada sebelum migrasi.');
      }
      return { tables: names, canonicalColumnPresentBeforeMigration: false };
    });

    // ── Migrasi #1 ──────────────────────────────────────────────────────────
    const migStepCount = loadedProd.migration.PRODUCT_MASTER_MP03C_STEPS.length;
    await step(`migration #1: ${migStepCount} langkah pada baseline pra-MP-03C`, async () => {
      const t0 = Date.now();
      await loadedProd.migration.runProductMasterMp03cMigration(workPool);
      const durationMs = Date.now() - t0;
      const col = await workPool.query(
        `SELECT data_type, character_maximum_length, is_nullable
           FROM information_schema.columns
          WHERE table_schema='public' AND table_name='pos_menu_items' AND column_name='canonical_base_unit_code'`
      );
      if (col.rowCount !== 1) throw new Error('Migrasi #1 tidak menambahkan kolom canonical_base_unit_code.');
      artifacts.migration = {
        steps: migStepCount,
        firstRunMs: durationMs,
        column: col.rows[0],
      };
      return { steps: migStepCount, durationMs, column: col.rows[0] };
    });

    // ── Fixture data ────────────────────────────────────────────────────────
    fixtureIds = await step('fixture: data produk, kemasan, dan lokasi', async () => {
      const props = await workPool.query(
        `INSERT INTO properties (name, property_code)
         VALUES ('MP-03C Test Property A', 'MPA'), ('MP-03C Test Property B', 'MPB')
         RETURNING id, property_code`
      );
      const propertyA = Number(props.rows.find((r) => r.property_code === 'MPA').id);
      const propertyB = Number(props.rows.find((r) => r.property_code === 'MPB').id);

      const rooms = await workPool.query(
        `INSERT INTO rooms (room_number, name, status, property_id)
         VALUES ('MPA-101', 'MPA Room 101', 'Ready', $1),
                ('MPB-201', 'MPB Room 201', 'Ready', $2)
         RETURNING id, property_id, room_number`,
        [propertyA, propertyB]
      );
      const roomA = Number(rooms.rows.find((r) => r.room_number === 'MPA-101').id);
      const roomB = Number(rooms.rows.find((r) => r.room_number === 'MPB-201').id);

      const itemDefs = [
        ['MP03C Race Create A', 'KG'],
        ['MP03C Race Create B', 'KG'],
        ['MP03C Race Reactivate A', 'KG'],
        ['MP03C Race Reactivate B', 'KG'],
        ['MP03C Idempotency', 'KG'],
        ['MP03C Guard Snapshot', 'KG'],
      ];
      const items = {};
      for (const [name, canonical] of itemDefs) {
        const res = await workPool.query(
          `INSERT INTO pos_menu_items
             (property_id, name, price, is_sellable_pos, base_unit, canonical_base_unit_code, product_type, product_kind)
           VALUES ($1, $2, 1000, TRUE, 'Kg', $3, 'RAW_MATERIAL', 'STANDARD')
           RETURNING id`,
          [propertyA, name, canonical]
        );
        items[name] = Number(res.rows[0].id);
      }

      const inactiveSnapshot = loadedProd.units.buildPackagingCreatePayloadSnapshot({
        packaging_code: 'KRT',
        packaging_label: 'Karton Lama',
        base_unit_code: 'KG',
        to_base_factor: '10.000',
        is_default_purchase: false,
      });
      const inactiveHash = loadedProd.units.computePackagingCreatePayloadHash(inactiveSnapshot);

      const makeInactivePackaging = async (itemId, key) => {
        const res = await workPool.query(
          `INSERT INTO product_packaging_conversions
             (property_id, menu_item_id, packaging_code, packaging_label, base_unit_code,
              to_base_factor, is_default_purchase, is_active, idempotency_key,
              create_payload_hash, create_payload_snapshot)
           VALUES ($1, $2, 'KRT', 'Karton Lama', 'KG', '10.000'::numeric(12,3), FALSE, FALSE, $3, $4, $5::jsonb)
           RETURNING id`,
          [propertyA, itemId, key, inactiveHash, JSON.stringify(inactiveSnapshot)]
        );
        return Number(res.rows[0].id);
      };

      const pkgReactA = await makeInactivePackaging(items['MP03C Race Reactivate A'], 'seed-inactive-react-a');
      const pkgReactB = await makeInactivePackaging(items['MP03C Race Reactivate B'], 'seed-inactive-react-b');
      const pkgGuard = await makeInactivePackaging(items['MP03C Guard Snapshot'], 'seed-inactive-guard');

      const locs = await workPool.query(
        `INSERT INTO stock_locations (property_id, code, name, location_type, room_id)
         VALUES ($1, 'GDG-MPA', 'Gudang MPA', 'WAREHOUSE', NULL),
                ($1, 'MBR-MPA101', 'Minibar MPA-101', 'ROOM_MINIBAR', $2)
         RETURNING id, code`,
        [propertyA, roomA]
      );
      const warehouseA = Number(locs.rows.find((r) => r.code === 'GDG-MPA').id);
      const minibarA = Number(locs.rows.find((r) => r.code === 'MBR-MPA101').id);

      return {
        propertyA,
        propertyB,
        roomA,
        roomB,
        items,
        packaging: { reactA: pkgReactA, reactB: pkgReactB, guard: pkgGuard },
        locations: { warehouseA, minibarA },
      };
    });

    // ── Migrasi #2 (idempotensi + data tidak berubah) ───────────────────────
    const snapshotData = async () => {
      const q = async (sql) => (await workPool.query(sql)).rows;
      return {
        pos_menu_items: await q(
          `SELECT id, property_id, name, base_unit, canonical_base_unit_code,
                  price::text AS price, is_active, is_sellable_pos
             FROM pos_menu_items ORDER BY id`
        ),
        product_packaging_conversions: await q(
          `SELECT id, property_id, menu_item_id, packaging_code, packaging_label, base_unit_code,
                  to_base_factor::text AS to_base_factor, is_default_purchase, is_active,
                  idempotency_key, create_payload_hash, create_payload_snapshot::text AS create_payload_snapshot
             FROM product_packaging_conversions ORDER BY id`
        ),
        stock_locations: await q(
          `SELECT id, property_id, code, name, location_type, room_id, is_active
             FROM stock_locations ORDER BY id`
        ),
      };
    };

    const beforeData = await snapshotData();
    const beforeChecksum = crypto.createHash('sha256').update(JSON.stringify(beforeData)).digest('hex');

    await step('migration #2: eksekusi ulang pada database yang sama', async () => {
      const t0 = Date.now();
      await loadedProd.migration.runProductMasterMp03cMigration(workPool);
      const durationMs = Date.now() - t0;
      artifacts.migration.secondRunMs = durationMs;
      return { durationMs };
    });

    await step('migration: data fixture tidak berubah makna setelah eksekusi kedua', async () => {
      const afterData = await snapshotData();
      const afterChecksum = crypto.createHash('sha256').update(JSON.stringify(afterData)).digest('hex');
      if (beforeChecksum !== afterChecksum) {
        throw new Error(`Checksum data fixture berubah setelah migrasi kedua (${beforeChecksum} -> ${afterChecksum}).`);
      }
      artifacts.migration.dataChecksum = beforeChecksum;
      return {
        checksum: beforeChecksum,
        rows: {
          pos_menu_items: beforeData.pos_menu_items.length,
          product_packaging_conversions: beforeData.product_packaging_conversions.length,
          stock_locations: beforeData.stock_locations.length,
        },
      };
    });

    // ── Verifikasi katalog ──────────────────────────────────────────────────
    await step('catalog: kolom canonical_base_unit_code', async () => {
      const { rows } = await workPool.query(
        `SELECT data_type, character_maximum_length, is_nullable
           FROM information_schema.columns
          WHERE table_schema='public' AND table_name='pos_menu_items'
            AND column_name='canonical_base_unit_code'`
      );
      if (rows.length !== 1) throw new Error('Kolom canonical_base_unit_code tidak ditemukan.');
      const col = rows[0];
      if (col.data_type !== 'character varying') throw new Error(`Tipe kolom=${col.data_type}, diharapkan character varying`);
      if (Number(col.character_maximum_length) !== 20) {
        throw new Error(`Panjang kolom=${col.character_maximum_length}, diharapkan 20`);
      }
      if (col.is_nullable !== 'YES') throw new Error(`Kolom harus nullable, aktual=${col.is_nullable}`);
      return col;
    });

    await step('catalog: constraint & unique index', async () => {
      const expectedConstraints = [
        ['pos_menu_items', 'chk_pos_menu_items_canonical_base_unit'],
        ['product_packaging_conversions', 'fk_ppc_property_menu_item'],
        ['product_packaging_conversions', 'chk_ppc_packaging_code_format'],
        ['product_packaging_conversions', 'chk_ppc_packaging_label_non_empty'],
        ['product_packaging_conversions', 'chk_ppc_base_unit_code_valid'],
        ['product_packaging_conversions', 'chk_ppc_factor_positive'],
        ['product_packaging_conversions', 'chk_ppc_idempotency_key_non_empty'],
        ['stock_locations', 'fk_stock_locations_property_room'],
        ['stock_locations', 'chk_stock_locations_code_format'],
        ['stock_locations', 'chk_stock_locations_name_non_empty'],
        ['stock_locations', 'chk_stock_locations_type'],
        ['stock_locations', 'chk_stock_locations_room_minibar_rule'],
      ];
      const { rows: conRows } = await workPool.query(
        `SELECT conrelid::regclass::text AS rel, conname
           FROM pg_constraint
          WHERE conname = ANY($1::text[])`,
        [expectedConstraints.map(([, name]) => name)]
      );
      const found = new Set(conRows.map((r) => `${r.rel}|${r.conname}`));
      const missing = expectedConstraints.filter(([rel, name]) => !found.has(`${rel}|${name}`));
      if (missing.length > 0) {
        throw new Error(`Constraint tidak ditemukan: ${missing.map(([r, n]) => `${r}.${n}`).join(', ')}`);
      }

      const expectedIndexes = [
        'uq_pos_menu_items_property_id_id',
        'uq_rooms_property_id_id',
        'uq_ppc_item_packaging_code',
        'uq_ppc_item_packaging_label',
        'uq_ppc_item_idempotency_key',
        'uq_ppc_default_purchase_per_item',
        'uq_stock_locations_property_code',
        'uq_stock_locations_property_name',
        'uq_stock_locations_property_room_minibar',
      ];
      const { rows: idxRows } = await workPool.query(
        `SELECT indexname, indexdef
           FROM pg_indexes
          WHERE schemaname='public' AND indexname = ANY($1::text[])`,
        [expectedIndexes]
      );
      const foundIdx = new Set(idxRows.map((r) => r.indexname));
      const missingIdx = expectedIndexes.filter((name) => !foundIdx.has(name));
      if (missingIdx.length > 0) throw new Error(`Unique index tidak ditemukan: ${missingIdx.join(', ')}`);

      return { constraints: expectedConstraints.length, uniqueIndexes: expectedIndexes.length };
    });

    await step('catalog: tiga guard trigger aktif', async () => {
      const expectedTriggers = [
        'trg_guard_pos_menu_item_base_unit',
        'trg_guard_product_packaging_conversion',
        'trg_guard_stock_location_identity',
      ];
      const { rows } = await workPool.query(
        `SELECT t.tgname,
                t.tgenabled,
                c.relname AS table_name,
                p.proname AS function_name
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE NOT t.tgisinternal AND t.tgname = ANY($1::text[])
          ORDER BY t.tgname`,
        [expectedTriggers]
      );
      const found = new Set(rows.map((r) => r.tgname));
      const missing = expectedTriggers.filter((n) => !found.has(n));
      if (missing.length > 0) throw new Error(`Trigger tidak ditemukan: ${missing.join(', ')}`);
      for (const row of rows) {
        if (row.tgenabled !== 'O') throw new Error(`Trigger ${row.tgname} tidak aktif (tgenabled=${row.tgenabled})`);
      }
      return rows.map((r) => ({ trigger: r.tgname, table: r.table_name, function: r.function_name, enabled: r.tgenabled }));
    });

    // ── RACE 1: CREATE kemasan, produk berubah lebih dulu ──────────────────
    await scenario('race A1: produk KG→GRAM lebih dulu; POST kemasan KG harus menunggu lalu ditolak', async () => {
      const itemId = fixtureIds.items['MP03C Race Create A'];
      return runRace({
        name: 'A1',
        monitorPool,
        op1: {
          label: 'PATCH produk KG->GRAM',
          handler: (p) => loadedProd.stage1.createPosMenuItemPatchHandler(depsFor(p)),
          req: makeReq({ params: { id: itemId }, body: { property_id: fixtureIds.propertyA, base_unit: 'Gram', canonical_base_unit_code: 'GRAM' } }),
        },
        op2: {
          label: 'POST kemasan KG',
          handler: (p) => loadedProd.units.createProductPackagingCreateHandler(depsFor(p)),
          req: makeReq({
            params: { id: itemId },
            body: {
              property_id: fixtureIds.propertyA,
              packaging_code: 'KRT',
              packaging_label: 'Karton 12 Botol',
              base_unit_code: 'KG',
              to_base_factor: '12',
              is_default_purchase: false,
              idempotency_key: `race-a1-${crypto.randomUUID()}`,
            },
          }),
        },
        expect1: { status: 200 },
        expect2: { status: 409, code: 'PACKAGING_BASE_UNIT_MISMATCH' },
        verify: async () => {
          const item = await workPool.query(
            `SELECT canonical_base_unit_code, base_unit FROM pos_menu_items WHERE id=$1`,
            [itemId]
          );
          if (item.rows[0].canonical_base_unit_code !== 'GRAM') {
            throw new Error(`Satuan produk akhir=${item.rows[0].canonical_base_unit_code}, diharapkan GRAM`);
          }
          const active = await workPool.query(
            `SELECT count(*)::int AS cnt FROM product_packaging_conversions
              WHERE property_id=$1 AND menu_item_id=$2 AND is_active=TRUE AND base_unit_code='KG'`,
            [fixtureIds.propertyA, itemId]
          );
          if (active.rows[0].cnt !== 0) {
            throw new Error(`Ada ${active.rows[0].cnt} kemasan aktif KG pada produk bersatuan GRAM (harus 0).`);
          }
          return { productCanonical: 'GRAM', activeKgPackaging: 0 };
        },
      });
    }, 60000);

    // ── RACE 2: CREATE kemasan lebih dulu ──────────────────────────────────
    await scenario('race B1: POST kemasan KG lebih dulu; PATCH produk KG→GRAM harus menunggu lalu ditolak', async () => {
      const itemId = fixtureIds.items['MP03C Race Create B'];
      return runRace({
        name: 'B1',
        monitorPool,
        op1: {
          label: 'POST kemasan KG',
          handler: (p) => loadedProd.units.createProductPackagingCreateHandler(depsFor(p)),
          req: makeReq({
            params: { id: itemId },
            body: {
              property_id: fixtureIds.propertyA,
              packaging_code: 'KRT',
              packaging_label: 'Karton 12 Botol',
              base_unit_code: 'KG',
              to_base_factor: '12',
              is_default_purchase: false,
              idempotency_key: `race-b1-${crypto.randomUUID()}`,
            },
          }),
        },
        op2: {
          label: 'PATCH produk KG->GRAM',
          handler: (p) => loadedProd.stage1.createPosMenuItemPatchHandler(depsFor(p)),
          req: makeReq({ params: { id: itemId }, body: { property_id: fixtureIds.propertyA, base_unit: 'Gram', canonical_base_unit_code: 'GRAM' } }),
        },
        expect1: { status: 201 },
        expect2: { status: 409, code: 'BASE_UNIT_LOCKED_BY_USAGE' },
        verify: async () => {
          const item = await workPool.query(
            `SELECT canonical_base_unit_code FROM pos_menu_items WHERE id=$1`,
            [itemId]
          );
          if (item.rows[0].canonical_base_unit_code !== 'KG') {
            throw new Error(`Satuan produk berubah menjadi ${item.rows[0].canonical_base_unit_code} padahal harus tetap KG.`);
          }
          const active = await workPool.query(
            `SELECT count(*)::int AS cnt FROM product_packaging_conversions
              WHERE property_id=$1 AND menu_item_id=$2 AND is_active=TRUE AND base_unit_code='KG'`,
            [fixtureIds.propertyA, itemId]
          );
          if (active.rows[0].cnt !== 1) {
            throw new Error(`Kemasan aktif KG=${active.rows[0].cnt}, diharapkan 1.`);
          }
          return { productCanonical: 'KG', activeKgPackaging: 1 };
        },
      });
    }, 60000);

    // ── RACE 3: REACTIVATION, produk berubah lebih dulu ────────────────────
    await scenario('race A2: produk KG→GRAM lebih dulu; reaktivasi kemasan KG harus menunggu lalu ditolak', async () => {
      const itemId = fixtureIds.items['MP03C Race Reactivate A'];
      const packagingId = fixtureIds.packaging.reactA;
      return runRace({
        name: 'A2',
        monitorPool,
        op1: {
          label: 'PATCH produk KG->GRAM',
          handler: (p) => loadedProd.stage1.createPosMenuItemPatchHandler(depsFor(p)),
          req: makeReq({ params: { id: itemId }, body: { property_id: fixtureIds.propertyA, base_unit: 'Gram', canonical_base_unit_code: 'GRAM' } }),
        },
        op2: {
          label: 'PATCH reaktivasi kemasan KG',
          handler: (p) => loadedProd.units.createProductPackagingPatchHandler(depsFor(p)),
          req: makeReq({ params: { id: itemId, packagingId }, body: { property_id: fixtureIds.propertyA, is_active: true } }),
        },
        expect1: { status: 200 },
        expect2: { status: 409, code: 'PACKAGING_BASE_UNIT_MISMATCH' },
        verify: async () => {
          const pkg = await workPool.query(
            `SELECT base_unit_code, is_active FROM product_packaging_conversions WHERE id=$1`,
            [packagingId]
          );
          if (pkg.rows[0].is_active !== false) throw new Error('Kemasan nonaktif berubah menjadi aktif.');
          if (pkg.rows[0].base_unit_code !== 'KG') throw new Error('Satuan lama kemasan nonaktif tidak dipertahankan.');
          return { packagingBaseUnit: 'KG', packagingActive: false };
        },
      });
    }, 60000);

    // ── RACE 4: REACTIVATION lebih dulu ────────────────────────────────────
    await scenario('race B2: reaktivasi kemasan KG lebih dulu; PATCH produk KG→GRAM harus menunggu lalu ditolak', async () => {
      const itemId = fixtureIds.items['MP03C Race Reactivate B'];
      const packagingId = fixtureIds.packaging.reactB;
      return runRace({
        name: 'B2',
        monitorPool,
        op1: {
          label: 'PATCH reaktivasi kemasan KG',
          handler: (p) => loadedProd.units.createProductPackagingPatchHandler(depsFor(p)),
          req: makeReq({ params: { id: itemId, packagingId }, body: { property_id: fixtureIds.propertyA, is_active: true } }),
        },
        op2: {
          label: 'PATCH produk KG->GRAM',
          handler: (p) => loadedProd.stage1.createPosMenuItemPatchHandler(depsFor(p)),
          req: makeReq({ params: { id: itemId }, body: { property_id: fixtureIds.propertyA, base_unit: 'Gram', canonical_base_unit_code: 'GRAM' } }),
        },
        expect1: { status: 200 },
        expect2: { status: 409, code: 'BASE_UNIT_LOCKED_BY_USAGE' },
        verify: async () => {
          const pkg = await workPool.query(
            `SELECT is_active FROM product_packaging_conversions WHERE id=$1`,
            [packagingId]
          );
          if (pkg.rows[0].is_active !== true) throw new Error('Reaktivasi kemasan gagal padahal operasi pertama harus berhasil.');
          const item = await workPool.query(`SELECT canonical_base_unit_code FROM pos_menu_items WHERE id=$1`, [itemId]);
          if (item.rows[0].canonical_base_unit_code !== 'KG') throw new Error('Satuan produk berubah padahal harus tetap KG.');
          return { packagingActive: true, productCanonical: 'KG' };
        },
      });
    }, 60000);

    // ── RACE 5: idempotency identik bersamaan ──────────────────────────────
    await scenario('race IDEM: dua POST identik bersamaan → satu baris, ID sama', async () => {
      const itemId = fixtureIds.items['MP03C Idempotency'];
      const key = `race-idem-${crypto.randomUUID()}`;
      const payload = {
        property_id: fixtureIds.propertyA,
        packaging_code: 'KRG',
        packaging_label: 'Karung 25 Kg',
        base_unit_code: 'KG',
        to_base_factor: '25',
        is_default_purchase: false,
        idempotency_key: key,
      };
      return runRace({
        name: 'IDEM',
        monitorPool,
        op1: {
          label: 'POST kemasan #1',
          handler: (p) => loadedProd.units.createProductPackagingCreateHandler(depsFor(p)),
          req: makeReq({ params: { id: itemId }, body: { ...payload } }),
        },
        op2: {
          label: 'POST kemasan #2 (payload identik)',
          handler: (p) => loadedProd.units.createProductPackagingCreateHandler(depsFor(p)),
          req: makeReq({ params: { id: itemId }, body: { ...payload } }),
        },
        expect1: { status: 201, replayed: false },
        expect2: { status: 200, replayed: true },
        verify: async ({ r1, r2 }) => {
          const rows = await workPool.query(
            `SELECT id FROM product_packaging_conversions
              WHERE property_id=$1 AND menu_item_id=$2 AND BTRIM(idempotency_key)=$3`,
            [fixtureIds.propertyA, itemId, key]
          );
          if (rows.rowCount !== 1) throw new Error(`Baris dengan idempotency_key yang sama = ${rows.rowCount}, diharapkan 1.`);
          const idFromDb = Number(rows.rows[0].id);
          const id1 = Number(r1.body?.data?.id);
          const id2 = Number(r2.body?.data?.id);
          if (!Number.isInteger(id1) || id1 !== idFromDb) throw new Error(`ID respons #1=${id1} tidak sama dengan baris DB=${idFromDb}.`);
          if (id1 !== id2) throw new Error(`ID respons #1=${id1} berbeda dengan respons #2=${id2}.`);
          return { rowsForIdempotencyKey: 1, idFromDb, idOp1: id1, idOp2: id2 };
        },
      });
    }, 60000);

    // ── Guard: snapshot/hash immutable ─────────────────────────────────────
    await scenario('guard: create_payload_hash/snapshot tidak dapat diubah', async () => {
      const pkgId = fixtureIds.packaging.guard;
      const hashErr = await captureSqlError(
        workPool,
        `UPDATE product_packaging_conversions SET create_payload_hash = repeat('a', 64) WHERE id = $1`,
        [pkgId]
      );
      if (!hashErr) throw new Error('UPDATE create_payload_hash diterima; trigger immutability tidak bekerja.');
      if (hashErr.code !== 'P0001' || !String(hashErr.message).includes('IMMUTABLE_CREATE_PAYLOAD_SNAPSHOT')) {
        throw new Error(`Error tidak sesuai: SQLSTATE=${hashErr.code} message=${hashErr.message}`);
      }
      const snapErr = await captureSqlError(
        workPool,
        `UPDATE product_packaging_conversions SET create_payload_snapshot = '{"tampered":true}'::jsonb WHERE id = $1`,
        [pkgId]
      );
      if (!snapErr) throw new Error('UPDATE create_payload_snapshot diterima; trigger immutability tidak bekerja.');
      if (snapErr.code !== 'P0001' || !String(snapErr.message).includes('IMMUTABLE_CREATE_PAYLOAD_SNAPSHOT')) {
        throw new Error(`Error snapshot tidak sesuai: SQLSTATE=${snapErr.code} message=${snapErr.message}`);
      }
      return { hashSqlState: hashErr.code, snapshotSqlState: snapErr.code };
    }, 30000);

    // ── Guard: kemasan nonaktif mempertahankan satuan lama ─────────────────
    await scenario('guard: kemasan nonaktif mempertahankan satuan lama setelah satuan produk berubah', async () => {
      const itemId = fixtureIds.items['MP03C Race Reactivate A'];
      const pkgId = fixtureIds.packaging.reactA;
      const row = await workPool.query(
        `SELECT i.canonical_base_unit_code AS item_unit, p.base_unit_code AS pkg_unit, p.is_active
           FROM pos_menu_items i
           JOIN product_packaging_conversions p ON p.menu_item_id = i.id AND p.property_id = i.property_id
          WHERE i.id=$1 AND p.id=$2`,
        [itemId, pkgId]
      );
      const r = row.rows[0];
      if (!r) throw new Error('Fixture kemasan nonaktif tidak ditemukan.');
      if (r.item_unit !== 'GRAM') throw new Error(`Satuan produk=${r.item_unit}, diharapkan GRAM (hasil race A2).`);
      if (r.pkg_unit !== 'KG') throw new Error(`Satuan kemasan nonaktif berubah menjadi ${r.pkg_unit}; harus tetap KG.`);
      if (r.is_active !== false) throw new Error('Kemasan seharusnya tetap nonaktif.');
      return { productUnit: r.item_unit, packagingUnit: r.pkg_unit, active: r.is_active };
    }, 30000);

    // ── Guard: identitas lokasi immutable ──────────────────────────────────
    await scenario('guard: identitas stock_locations (property_id/location_type/room_id) immutable', async () => {
      const locId = fixtureIds.locations.minibarA;
      const moveErr = await captureSqlError(
        workPool,
        `UPDATE stock_locations SET location_type='KITCHEN', room_id=NULL WHERE id=$1`,
        [locId]
      );
      if (!moveErr) throw new Error('UPDATE identitas lokasi diterima; trigger tidak bekerja.');
      if (moveErr.code !== 'P0001' || !String(moveErr.message).includes('IMMUTABLE_LOCATION_IDENTITY')) {
        throw new Error(`Error tidak sesuai: SQLSTATE=${moveErr.code} message=${moveErr.message}`);
      }
      const propErr = await captureSqlError(
        workPool,
        `UPDATE stock_locations SET property_id=$2 WHERE id=$1`,
        [locId, fixtureIds.propertyB]
      );
      if (!propErr || propErr.code !== 'P0001' || !String(propErr.message).includes('IMMUTABLE_LOCATION_IDENTITY')) {
        throw new Error(`Perubahan property_id tidak ditolak sesuai guard: ${JSON.stringify(propErr)}`);
      }
      return { sqlState: moveErr.code, propertyChangeSqlState: propErr.code };
    }, 30000);

    // ── Guard: kamar lintas properti ───────────────────────────────────────
    await scenario('guard: kamar lintas properti ditolak (handler 422 + FK 23503)', async () => {
      const handler = loadedProd.units.createStockLocationCreateHandler(depsFor(workPool));
      const res = await invoke(
        handler,
        makeReq({
          body: {
            property_id: fixtureIds.propertyA,
            code: 'MBR-XPROP',
            name: 'Minibar Lintas Properti',
            location_type: 'ROOM_MINIBAR',
            room_id: fixtureIds.roomB,
          },
        })
      );
      if (res.statusCode !== 422 || res.body?.code !== 'ROOM_PROPERTY_MISMATCH') {
        throw new Error(`Handler: status=${res.statusCode} code=${res.body?.code}, diharapkan 422 ROOM_PROPERTY_MISMATCH`);
      }
      const sqlErr = await captureSqlError(
        workPool,
        `INSERT INTO stock_locations (property_id, code, name, location_type, room_id)
         VALUES ($1, 'MBR-XPROP-SQL', 'Minibar X SQL', 'ROOM_MINIBAR', $2)`,
        [fixtureIds.propertyA, fixtureIds.roomB]
      );
      if (!sqlErr || sqlErr.code !== '23503' || !String(sqlErr.constraint || '').includes('fk_stock_locations_property_room')) {
        throw new Error(`FK lintas properti tidak menolak: ${JSON.stringify(sqlErr)}`);
      }
      return { handlerStatus: res.statusCode, handlerCode: res.body?.code, sqlState: sqlErr.code, constraint: sqlErr.constraint };
    }, 30000);

    // ── Guard: duplikasi lokasi minibar ────────────────────────────────────
    await scenario('guard: duplikasi lokasi minibar untuk kamar sama ditolak (409 + 23505)', async () => {
      const handler = loadedProd.units.createStockLocationCreateHandler(depsFor(workPool));
      const res = await invoke(
        handler,
        makeReq({
          body: {
            property_id: fixtureIds.propertyA,
            code: 'MBR-DUP',
            name: 'Minibar Duplikat',
            location_type: 'ROOM_MINIBAR',
            room_id: fixtureIds.roomA,
          },
        })
      );
      if (res.statusCode !== 409 || res.body?.code !== 'ROOM_MINIBAR_LOCATION_EXISTS') {
        throw new Error(`Handler: status=${res.statusCode} code=${res.body?.code}, diharapkan 409 ROOM_MINIBAR_LOCATION_EXISTS`);
      }
      const sqlErr = await captureSqlError(
        workPool,
        `INSERT INTO stock_locations (property_id, code, name, location_type, room_id)
         VALUES ($1, 'MBR-DUP-SQL', 'Minibar Dup SQL', 'ROOM_MINIBAR', $2)`,
        [fixtureIds.propertyA, fixtureIds.roomA]
      );
      if (!sqlErr || sqlErr.code !== '23505' || !String(sqlErr.constraint || '').includes('uq_stock_locations_property_room_minibar')) {
        throw new Error(`Unique index minibar tidak menolak: ${JSON.stringify(sqlErr)}`);
      }
      return { handlerStatus: res.statusCode, handlerCode: res.body?.code, sqlState: sqlErr.code, constraint: sqlErr.constraint };
    }, 30000);

    // ── Guard: aturan room_id vs location_type ─────────────────────────────
    await scenario('guard: aturan room_id/location_type (chk_stock_locations_room_minibar_rule)', async () => {
      const withRoomErr = await captureSqlError(
        workPool,
        `INSERT INTO stock_locations (property_id, code, name, location_type, room_id)
         VALUES ($1, 'GDG-BAD', 'Gudang Salah', 'WAREHOUSE', $2)`,
        [fixtureIds.propertyA, fixtureIds.roomA]
      );
      if (!withRoomErr || withRoomErr.code !== '23514') {
        throw new Error(`WAREHOUSE + room_id tidak ditolak 23514: ${JSON.stringify(withRoomErr)}`);
      }
      const withoutRoomErr = await captureSqlError(
        workPool,
        `INSERT INTO stock_locations (property_id, code, name, location_type, room_id)
         VALUES ($1, 'MBR-NOROOM', 'Minibar Tanpa Kamar', 'ROOM_MINIBAR', NULL)`,
        [fixtureIds.propertyA]
      );
      if (!withoutRoomErr || withoutRoomErr.code !== '23514') {
        throw new Error(`ROOM_MINIBAR tanpa room_id tidak ditolak 23514: ${JSON.stringify(withoutRoomErr)}`);
      }
      return { warehouseWithRoom: withRoomErr.code, minibarWithoutRoom: withoutRoomErr.code };
    }, 30000);
  } catch (err) {
    fatal = {
      message: err?.message || String(err),
      code: err?.code || null,
      sqlState: err?.sqlState || null,
      constraint: err?.constraint || null,
      stack: err?.stack || null,
    };
    log(`FATAL :: ${err?.name || 'Error'}${err?.code ? ` code=${err.code}` : ''} ${err?.message || String(err)}`);
  } finally {
    // ── Cleanup: tutup koneksi, hapus HANYA container milik runner ─────────
    for (const pool of allPools) {
      await closePool(pool);
    }
    if (containerStarted && container) {
      cleanup = stopContainer(container.name);
      log(
        `CLEANUP :: container=${container.name} removed=${cleanup.removed} stillPresent=${
          cleanup.stillPresent.length > 0 ? cleanup.stillPresent.join(',') : 'tidak ada'
        }`
      );
    } else {
      cleanup = { attempted: false, removed: false, stillPresent: [] };
    }
    const containersAfter = (() => {
      try {
        return listOurContainers();
      } catch (err) {
        return [`<tidak dapat membaca docker: ${err.message}>`];
      }
    })();
    artifacts.containersAfter = containersAfter;
    artifacts.cleanup = cleanup;
    artifacts.cleanupLeftoverPrefixContainers = containersAfter.length;

    if (containerStarted) {
      const stillThere = containersAfter.includes(container.name);
      const cleanupOk = !stillThere && !cleanup.stillPresent.length;
      results.push({
        name: 'cleanup: container pengujian dihapus',
        ok: cleanupOk,
        durationMs: 0,
        detail: { container: container.name, stillPresent: stillThere ? [container.name] : [], leftoverWithPrefix: containersAfter.length },
      });
      log(`${cleanupOk ? 'PASS' : 'FAIL'}  cleanup: container pengujian dihapus :: ${container.name}`);
    }

    // ── Laporan ────────────────────────────────────────────────────────────
    const failed = results.filter((r) => r.ok === false);
    const exitCode = fatal || failed.length > 0 ? 1 : 0;

    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const report = {
      suite: 'MP-03C PostgreSQL 15 integration & concurrency',
      generatedAt: new Date().toISOString(),
      startedAt: startedAt.toISOString(),
      workspace: REPO_DIR,
      runner: __filename,
      git: {
        branch: safeGit(['rev-parse', '--abbrev-ref', 'HEAD']),
        head: safeGit(['rev-parse', 'HEAD']),
      },
      container: artifacts.container || null,
      postgres: artifacts.postgres || null,
      migration: artifacts.migration || null,
      dotenvGuard: {
        watchedEnvKeys: WATCHED_ENV_KEYS,
        appEnvVarsRead: false,
      },
      results,
      fatal,
      cleanup,
      leftoverPrefixContainers: containersAfter,
      summary: {
        total: results.length,
        passed: results.filter((r) => r.ok).length,
        failed: failed.length,
        exitCode,
      },
      notExecuted: [
        'Tidak menjalankan index.ts/bootstrap aplikasi penuh (sesuai batas tugas).',
        'Tidak menguji jalur HTTP Express nyata (request/response berupa objek test; SQL & transaksi tetap nyata).',
        'Tidak menguji endpoint foto produk/property branding.',
        'Tidak memakai kredensial/.env aplikasi maupun database live/staging.',
        'Tidak menjalankan suite backend mock/frontend/POS yang sudah lulus.',
      ],
    };

    fs.writeFileSync(path.join(REPORT_DIR, 'postgres-test-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(REPORT_DIR, 'postgres-test-output.log'), `${logLines.join('\n')}\n`, 'utf8');

    log('');
    log('=== RINGKASAN ===');
    for (const r of results) {
      log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
    }
    log(`Total: ${report.summary.passed}/${report.summary.total} lulus, gagal=${report.summary.failed}`);
    if (fatal) log(`FATAL: ${fatal.message}`);
    log(`Laporan: ${path.join(REPORT_DIR, 'postgres-test-report.json')}`);
    log(`EXIT_CODE=${exitCode}`);

    return exitCode;
  }

  return 0;
}

function safeGit(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_DIR, encoding: 'utf8', timeout: 15000 }).trim();
  } catch {
    return null;
  }
}

let cachedProdModules = null;
function loadProductionModulesCached() {
  if (!cachedProdModules) cachedProdModules = loadProductionModules();
  return cachedProdModules;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    console.error('RUNNER GAGAL:', err);
    process.exit(1);
  });
