/**
 * POS Order Edit Requests — CORRECTIVE RUNTIME PRIVILEGES v1
 * Test suite untuk modul corrective GRANT oak_app.
 *
 * Cakupan:
 *   1. Static Contract & Source Verification (selalu berjalan, tidak membutuhkan DB aktif)
 *   2. Dynamic Integration Test (hanya berjalan jika TEST_DATABASE_URL disposable tersedia)
 */

'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0;
const failures = [];

function check(label, cond) {
  if (cond) {
    passed++;
    console.log('  PASS  ' + label);
  } else {
    failures.push(label);
    console.error('  FAIL  ' + label);
  }
}

console.log('\n=== 1. VERIFIKASI STATIK & KONTRAK SOURCE POS ORDER EDIT PRIVILEGES ===');

// 1.1 Load modul dist
const distPath = path.resolve(__dirname, '..', 'dist', 'db', 'migrations', 'pos_order_edit_requests_runtime_privileges_v1.js');
check('File dist/db/migrations/pos_order_edit_requests_runtime_privileges_v1.js ada', fs.existsSync(distPath));

let mod;
try {
  mod = require(distPath);
  check('Modul dist berhasil di-require', true);
} catch (e) {
  check('Modul dist berhasil di-require: ' + e.message, false);
}

// 1.2 Export contracts
const REQUIRED_EXPORTS = [
  'MARKER',
  'PRIMARY_MARKER',
  'TABLE_EDIT_REQUESTS',
  'SEQUENCE_EDIT_REQUESTS',
  'TABLE_POS_ORDERS',
  'ROLE',
  'checkPrivilegesPrerequisites',
  'inspectPrivilegesState',
  'privilegesComplete',
  'runPosOrderEditRequestsRuntimePrivilegesMigration',
];
for (const exp of REQUIRED_EXPORTS) {
  check('Export ' + exp + ' tersedia', typeof mod[exp] !== 'undefined');
}

// 1.3 Nilai konstanta
check('MARKER = pos_order_edit_requests_runtime_privileges_v1', mod.MARKER === 'pos_order_edit_requests_runtime_privileges_v1');
check('PRIMARY_MARKER = pos_order_update_v1', mod.PRIMARY_MARKER === 'pos_order_update_v1');
check('TABLE_EDIT_REQUESTS = pos_order_edit_requests', mod.TABLE_EDIT_REQUESTS === 'pos_order_edit_requests');
check('SEQUENCE_EDIT_REQUESTS = pos_order_edit_requests_id_seq', mod.SEQUENCE_EDIT_REQUESTS === 'pos_order_edit_requests_id_seq');
check('TABLE_POS_ORDERS = pos_orders', mod.TABLE_POS_ORDERS === 'pos_orders');
check('ROLE = oak_app', mod.ROLE === 'oak_app');

// 1.4 Source code analysis pada TypeScript source
const tsSrcPath = path.resolve(__dirname, '..', 'src', 'db', 'migrations', 'pos_order_edit_requests_runtime_privileges_v1.ts');
check('Source TypeScript ada', fs.existsSync(tsSrcPath));
const tsContent = fs.readFileSync(tsSrcPath, 'utf8');

// Kontrak SQL GRANT
check('Hanya GRANT SELECT, INSERT pada pos_order_edit_requests',
  tsContent.includes('GRANT SELECT, INSERT') &&
  tsContent.includes('ON TABLE public.${TABLE_EDIT_REQUESTS}') &&
  !tsContent.includes('GRANT ALL ON TABLE public.${TABLE_EDIT_REQUESTS}') &&
  !tsContent.includes('GRANT DELETE ON TABLE public.${TABLE_EDIT_REQUESTS}')
);

check('GRANT USAGE, SELECT pada SEQUENCE pos_order_edit_requests_id_seq',
  tsContent.includes('GRANT USAGE, SELECT') &&
  tsContent.includes('ON SEQUENCE public.${SEQUENCE_EDIT_REQUESTS}')
);

check('GRANT UPDATE pada TABLE pos_orders bersyarat (hanya bila belum ada)',
  tsContent.includes('GRANT UPDATE') &&
  tsContent.includes('ON TABLE public.${TABLE_POS_ORDERS}') &&
  tsContent.includes('currentOrdersUpdate.rows[0]?.v !== true')
);

check('Idempotent schema marker: ON CONFLICT (version) DO NOTHING',
  tsContent.includes('INSERT INTO schema_migrations (version)') &&
  tsContent.includes('ON CONFLICT (version) DO NOTHING')
);

check('Advisory lock digunakan sebelum mutasi',
  tsContent.includes('pg_advisory_xact_lock') &&
  tsContent.includes('oak_hims_schema_migrations_lock')
);

check('Fail-closed: verifikasi privilegesComplete() setelah GRANT',
  tsContent.includes('if (!privilegesComplete(afterState))') &&
  tsContent.includes('ROLLBACK')
);

// 1.5 Runner Staging Verification
const stagingRunnerPath = path.resolve(__dirname, '..', 'scripts', 'run_pos_order_edit_requests_runtime_privileges_migration_staging.js');
check('Staging runner script ada', fs.existsSync(stagingRunnerPath));
const stagingRunnerContent = fs.readFileSync(stagingRunnerPath, 'utf8');

check('Staging runner target Cloud SQL exact match',
  stagingRunnerContent.includes('/cloudsql/oak-lawang-pms:asia-southeast2:oak-hims-staging-db15') &&
  stagingRunnerContent.includes('5432') &&
  stagingRunnerContent.includes('oak_hotel_db') &&
  stagingRunnerContent.includes('postgres')
);

check('Staging runner wajib NODE_ENV=production',
  stagingRunnerContent.includes("REQUIRED_NODE_ENV = 'production'")
);

check('Staging runner mode --check read-only (SET TRANSACTION READ ONLY)',
  stagingRunnerContent.includes('SET TRANSACTION READ ONLY')
);

// 1.6 Dockerfile & Cloud Build verification
const rootDir = path.resolve(__dirname, '..', '..');
const dockerfilePath = path.join(rootDir, 'Dockerfile.pos-order-edit-requests-runtime-privileges-migration-staging');
check('Dockerfile staging runner ada', fs.existsSync(dockerfilePath));
const dockerContent = fs.readFileSync(dockerfilePath, 'utf8');
check('Dockerfile default command adalah --check', dockerContent.includes('CMD ["--check"]'));

const cloudbuildPath = path.join(rootDir, 'cloudbuild.pos-order-edit-requests-runtime-privileges-migration-staging.yaml');
check('Cloud Build YAML ada', fs.existsSync(cloudbuildPath));
const cbContent = fs.readFileSync(cloudbuildPath, 'utf8');
check('Cloud Build hanya build & push (tanpa execute job)',
  cbContent.includes('build-image') &&
  cbContent.includes('push-image') &&
  !cbContent.includes('run jobs execute') &&
  !cbContent.includes('gcloud run jobs')
);

// 1.7 privilegesComplete logic testing
const completeState = {
  markerExists: true,
  primaryMarkerExists: true,
  schemaMigrationsExists: true,
  roleExists: true,
  tableExists: true,
  sequenceExists: true,
  posOrdersExists: true,
  hasSelect: true,
  hasInsert: true,
  hasSeqUsage: true,
  hasSeqSelect: true,
  posOrdersHasSelect: true,
  posOrdersHasUpdate: true,
  missingObjects: [],
};
check('privilegesComplete mengembalikan true jika semua privilege terpenuhi', mod.privilegesComplete(completeState) === true);

const incompleteState1 = { ...completeState, hasInsert: false };
check('privilegesComplete mengembalikan false jika hasInsert false', mod.privilegesComplete(incompleteState1) === false);

const incompleteState2 = { ...completeState, hasSeqUsage: false };
check('privilegesComplete mengembalikan false jika hasSeqUsage false', mod.privilegesComplete(incompleteState2) === false);

const incompleteState3 = { ...completeState, posOrdersHasUpdate: false };
check('privilegesComplete mengembalikan false jika posOrdersHasUpdate false', mod.privilegesComplete(incompleteState3) === false);

// ── 2. DYNAMIC INTEGRATION TEST (OPSIONAL JIKA DISPOSABLE DB TERSEDIA) ─────────
const testDbUrl = process.env.TEST_DATABASE_URL;
if (!testDbUrl) {
  console.log('\n[INFO] TEST_DATABASE_URL tidak diset. Uji statis & kontrak source selesai.');
  console.log(`\nHASIL: ${passed} PASS, ${failures.length} FAIL.`);
  if (failures.length > 0) {
    process.exit(1);
  }
  process.exit(0);
}

// Jika TEST_DATABASE_URL ada, verifikasi keamanannya (hanya allowlist 127.0.0.1:15434/oak_minibar_test)
let target;
try {
  const u = new URL(testDbUrl.trim());
  target = {
    host: u.hostname,
    port: Number(u.port),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
  };
  if (
    !['postgres:', 'postgresql:'].includes(u.protocol) || u.search || u.hash ||
    target.host !== '127.0.0.1' || target.port !== 15434 ||
    target.user !== 'minibar_test' || target.database !== 'oak_minibar_test' || !target.password
  ) {
    throw new Error('mismatch');
  }
} catch (_) {
  console.error('[SAFETY] TEST_DATABASE_URL tidak sesuai target disposable (127.0.0.1:15434/oak_minibar_test, user minibar_test). Menghentikan dynamic test.');
  process.exit(1);
}

const { Pool } = require('pg');
const pool = new Pool({
  host: target.host,
  port: target.port,
  user: target.user,
  password: target.password,
  database: target.database,
});

async function runDynamicTests() {
  console.log('\n=== 2. INTEGRATION TEST DINAMIS PADA DISPOSABLE DB (oak_minibar_test) ===');
  let client;
  let roleCreated = false;
  try {
    client = await pool.connect();
    // Cek apakah fixture oak_app perlu dibuat
    const roleRes = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [mod.ROLE]);
    if ((roleRes.rowCount ?? 0) === 0) {
      await client.query(`CREATE ROLE ${mod.ROLE} NOLOGIN`);
      roleCreated = true;
    }

    // Bersihkan state awal
    await client.query('DELETE FROM schema_migrations WHERE version = $1', [mod.MARKER]);
    await client.query(`REVOKE ALL ON TABLE public.${mod.TABLE_EDIT_REQUESTS} FROM ${mod.ROLE}`);
    await client.query(`REVOKE ALL ON SEQUENCE public.${mod.SEQUENCE_EDIT_REQUESTS} FROM ${mod.ROLE}`);

    // Test inspect di state awal
    const s1 = await mod.inspectPrivilegesState(client);
    check('Dynamic: state awal markerExists = false', s1.markerExists === false);
    check('Dynamic: state awal privilegesComplete = false', mod.privilegesComplete(s1) === false);

    // Apply #1
    const r1 = await mod.runPosOrderEditRequestsRuntimePrivilegesMigration(pool);
    check('Dynamic: apply #1 status=applied', r1.status === 'applied' && r1.ok === true && r1.applied === true);

    const s2 = await mod.inspectPrivilegesState(client);
    check('Dynamic: setelah apply, privilegesComplete = true', mod.privilegesComplete(s2) === true);
    check('Dynamic: marker ada di schema_migrations', s2.markerExists === true);

    // Apply #2 (idempotent)
    const r2 = await mod.runPosOrderEditRequestsRuntimePrivilegesMigration(pool);
    check('Dynamic: apply #2 status=already-applied', r2.status === 'already-applied' && r2.ok === true && r2.applied === false);
  } catch (err) {
    failures.push('Dynamic test error: ' + err.message);
    console.error('Dynamic test error:', err);
  } finally {
    if (client) {
      try {
        if (roleCreated) {
          await client.query(`REVOKE ALL ON TABLE public.${mod.TABLE_EDIT_REQUESTS} FROM ${mod.ROLE}`);
          await client.query(`REVOKE ALL ON SEQUENCE public.${mod.SEQUENCE_EDIT_REQUESTS} FROM ${mod.ROLE}`);
          await client.query(`DROP ROLE IF EXISTS ${mod.ROLE}`);
        }
      } catch (_) {}
      client.release();
    }
    await pool.end();
  }

  console.log(`\nHASIL AKHIR: ${passed} PASS, ${failures.length} FAIL.`);
  if (failures.length > 0) {
    process.exit(1);
  }
}

runDynamicTests();
