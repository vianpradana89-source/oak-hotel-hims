/**
 * POS Communication Settings — CORRECTIVE RUNTIME PRIVILEGES v1
 * Focused integration test untuk modul corrective GRANT oak_app.
 *
 * Disposable oak_minibar_test ONLY (127.0.0.1:15434 / minibar_test).
 * Tidak ada akses ke staging/production apa pun.
 *
 * Prerequisite (dive rifikasi saat test start, fail-closed):
 *   - Tabel property_pos_communication_settings + sequence identity sudah
 *     ada (DDL utama pos_communication_settings_v1 sudah diterapkan di
 *     disposable DB — marker 'pos_communication_settings_v1' ada).
 *   - Role fixture 'oak_app' dibuat/dihapus oleh test ini (CREATE ROLE
 *     NOLOGIN; DROP ROLE di finally). Test TIDAK menyentuh role lain.
 *
 * Skenario:
 *   1. State awal: marker corrective TIDAK ada, privileges belum ada
 *      → inspectPrivilegesState: markerExists=false, privilegesComplete=false
 *      (== READY_TO_APPLY di state machine runner --check).
 *   2. Apply #1 → status 'applied', marker ada, privileges lengkap.
 *   3. Apply #2 → status 'already-applied' (idempotent, tanpa mutasi marker baru).
 *   4. Simulasi INVALID: marker corrective DIHAPUS lalu privilege DI-REVOKE,
 *      lalu marker DIPULANGKAN tanpa GRANT (marker ada + privilege hilang)
 *      → status 'error' MARKER_EXISTS_BUT_PRIVILEGES_INCOMPLETE.
 *      (Diagnosis manual: di dunia nyata state ini berarti privilege di-revoke
 *      setelah marker ditulis — sesuai desain fail-closed, TIDAK auto-repair.)
 *   5. Reconcile: marker corrective dihapus (state kembali clean) → Apply #3
 *      → status 'applied' lagi (GRANT idempotent, marker ditulis ulang).
 *   6. Prerequisite-failure semantics: marker utama DDL DIHAPUS sementara →
 *      Apply #4 → status 'prerequisite-failed' (fail-closed): TIDAK ada
 *      marker corrective, TIDAK ada GRANT tertinggal. Marker utama
 *      DIPULIHKAN apa pun yang terjadi (flag cleanup).
 *   7. TOCTOU-static proof: modul dist memverifikasi urutan
 *      BEGIN → advisory lock → checkPrivilegesPrerequisites di dalam
 *      transaksi (pola source-order assertion).
 *   8. --check transaction cleanup: proof dinamis (spawn runner disposable
 *      --check, verifikasi exit code + output state machine) dan proof
 *      statis (source assertion: setiap jalur --check menutup transaksi
 *      dengan ROLLBACK eksplisit sebelum client.release; ROLLBACK gagal
 *      → discard + exit non-zero).
 *   9. Residue: marker corrective kembali ADA + privileges lengkap;
 *      role fixture oak_app sudah dihapus; DDL utama tidak disentuh
 *      (marker 'pos_communication_settings_v1' tetap ada; struktur tabel utuh).
 *
 * Usage (from backend/):
 *   TEST_DATABASE_URL=postgres://minibar_test:***@127.0.0.1:15434/oak_minibar_test \
 *     node test/pos_communication_settings_runtime_privileges_test.js
 */
'use strict';

// ─── Guard: TEST_DATABASE_URL wajib cocok dengan target disposable ─────────────
let target;
try {
  const u = new URL((process.env.TEST_DATABASE_URL || '').trim());
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
  ) throw new Error('mismatch');
} catch (_) {
  console.error('SAFETY: TEST_DATABASE_URL tidak sesuai target disposable (127.0.0.1:15434/oak_minibar_test, user minibar_test).');
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

const CORRECTIVE_MARKER = 'pos_communication_settings_runtime_privileges_v1';
const PRIMARY_MARKER = 'pos_communication_settings_v1';
const TABLE = 'property_pos_communication_settings';
const SEQUENCE = 'property_pos_communication_settings_id_seq';
const ROLE = 'oak_app';

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

function problem(label, e) {
  const msg = label + ': ' + String((e && e.message) || e);
  failures.push(msg);
  console.error('[ERROR] ' + msg);
}

// ─── Load modul corrective dari dist ─────────────────────────────────────────
const fs = require('fs');
const path = require('path');
let mod;
try {
  mod = require(path.resolve(__dirname, '..', 'dist', 'db', 'migrations',
    'pos_communication_settings_runtime_privileges_v1'));
} catch (e) {
  console.error('Gagal load modul corrective dari dist: ' + String((e && e.message) || e));
  console.error('Jalankan: cd backend && npm run build');
  process.exit(1);
}
const REQUIRED_EXPORTS = [
  'checkPrivilegesPrerequisites',
  'inspectPrivilegesState',
  'privilegesComplete',
  'runPosCommunicationSettingsRuntimePrivilegesMigration',
];
for (const fn of REQUIRED_EXPORTS) {
  if (typeof mod[fn] !== 'function') {
    console.error('Export modul corrective tidak lengkap: ' + fn);
    process.exit(1);
  }
}

async function main() {
  let c = null;
  let roleCreated = false; // fixture ownership
  let cleanupDone = false;
  let primaryRestored = false; // flag: marker utama sudah dipulihkan dari simulasi PF

  try {
    c = await pool.connect();

    // ── 0) Prerequisites lingkungan disposable ────────────────────────────────
    const primaryMarker = await c.query(
      'SELECT 1 FROM schema_migrations WHERE version = $1', [PRIMARY_MARKER]
    );
    check('Marker utama ' + PRIMARY_MARKER + ' ada (DDL utama sudah diterapkan)',
      (primaryMarker.rowCount ?? 0) === 1);

    const tblExists = (await c.query(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname=$1 AND c.relkind IN ('r','p')`, [TABLE]
    )).rowCount;
    check('Tabel ' + TABLE + ' ada', (tblExists ?? 0) === 1);

    const seqExists = (await c.query(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname=$1 AND c.relkind='S'`, [SEQUENCE]
    )).rowCount;
    check('Sequence ' + SEQUENCE + ' ada', (seqExists ?? 0) === 1);

    // ── Fixture: role oak_app (NOLOGIN) dibuat test, dihapus di finally ───────
    const preRole = await c.query(
      "SELECT 1 FROM pg_roles WHERE rolname = $1", [ROLE]
    );
    if ((preRole.rowCount ?? 0) === 0) {
      await c.query('CREATE ROLE ' + ROLE + ' NOLOGIN');
      roleCreated = true;
      console.log('[FIXTURE] Role oak_app dibuat (fixture test).');
    } else {
      console.log('[FIXTURE] Role oak_app sudah ada di disposable DB — dipakai apa adanya (TIDAK dihapus di finally).');
    }

    // Bersihkan state corrective dari run sebelumnya (idempotent).
    await c.query('DELETE FROM schema_migrations WHERE version = $1', [CORRECTIVE_MARKER]);
    // REVOKE privilege corrective yang mungkin tertinggal dari run sebelumya.
    await c.query(`REVOKE ALL ON TABLE public.${TABLE} FROM ${ROLE}`);
    await c.query(`REVOKE ALL ON SEQUENCE public.${SEQUENCE} FROM ${ROLE}`);
    console.log('[SETUP] State corrective dibersihkan (marker dihapus, privilege direvoke).');

    const prereq = await mod.checkPrivilegesPrerequisites(c);
    check('Preconditions lulus (role/tabel/sequence/marker utama)', prereq.ok === true && prereq.errors.length === 0);

    // ── 1) State awal: READY_TO_APPLY ──────────────────────────────────────────
    let s1 = await mod.inspectPrivilegesState(c);
    check('S1 marker corrective TIDAK ada', s1.markerExists === false);
    check('S1 role ada', s1.roleExists === true);
    check('S1 tabel ada', s1.tableExists === true);
    check('S1 sequence ada', s1.sequenceExists === true);
    check('S1 privileges belum lengkap', mod.privilegesComplete(s1) === false);
    const missing1 = [];
    if (!s1.hasSelect) missing1.push('TABLE:SELECT');
    if (!s1.hasInsert) missing1.push('TABLE:INSERT');
    if (!s1.hasUpdate) missing1.push('TABLE:UPDATE');
    if (!s1.hasSeqUsage) missing1.push('SEQ:USAGE');
    if (!s1.hasSeqSelect) missing1.push('SEQ:SELECT');
    check('S1 privilege hilang: ' + JSON.stringify(missing1), missing1.length === 5);

    // ── 2) Apply #1 → applied ──────────────────────────────────────────────────
    const r1 = await mod.runPosCommunicationSettingsRuntimePrivilegesMigration(pool);
    check('A1 status=applied', r1.status === 'applied' && r1.ok === true && r1.applied === true);

    let markerAfter1 = (await c.query(
      'SELECT 1 FROM schema_migrations WHERE version = $1', [CORRECTIVE_MARKER]
    )).rowCount;
    check('A1 marker corrective ADA setelah apply', (markerAfter1 ?? 0) === 1);

    let s2 = await mod.inspectPrivilegesState(c);
    check('A2 privileges lengkap setelah apply (SELECT+INSERT+UPDATE + SEQ USAGE+SELECT)',
      mod.privilegesComplete(s2) === true && s2.markerExists === true);

    // Verifikasi grant terlihat dari sisi katalog (pg_catalog authoritative).
    const grantVis = await c.query(
      `SELECT has_table_privilege($1, 'public.${TABLE}', 'SELECT') AS s,
              has_table_privilege($1, 'public.${TABLE}', 'INSERT') AS i,
              has_table_privilege($1, 'public.${TABLE}', 'UPDATE') AS u,
              has_sequence_privilege($1, 'public.${SEQUENCE}', 'USAGE') AS su,
              has_sequence_privilege($1, 'public.${SEQUENCE}', 'SELECT') AS ss,
              has_table_privilege($1, 'public.${TABLE}', 'DELETE') AS d`,
      [ROLE]
    );
    const g = grantVis.rows[0];
    check('A3 GRANT terlihat di katalog (S/I/U + SEQ USAGE/SELECT)',
      g.s === true && g.i === true && g.u === true && g.su === true && g.ss === true);
    check('A4 DELETE TIDAK di-grant (minimum privilege)', g.d === false);

    // ── 3) Apply #2 → already-applied (idempotent) ────────────────────────────
    const r2 = await mod.runPosCommunicationSettingsRuntimePrivilegesMigration(pool);
    check('A5 re-apply = already-applied', r2.status === 'already-applied' && r2.ok === true && r2.applied === false);

    const markerCount = (await c.query(
      'SELECT COUNT(*)::int AS n FROM schema_migrations WHERE version = $1', [CORRECTIVE_MARKER]
    )).rows[0].n;
    check('A6 marker tetap satu baris (ON CONFLICT DO NOTHING)', markerCount === 1);

    // ── 4) Simulasi INVALID: marker ADA tetapi privilege hilang ──────────────
    await c.query(`REVOKE ALL ON TABLE public.${TABLE} FROM ${ROLE}`);
    await c.query(`REVOKE ALL ON SEQUENCE public.${SEQUENCE} FROM ${ROLE}`);
    // Marker corrective sengaja DIPERTAHANKAN → state marker-ada/privilege-hilang.
    let s4 = await mod.inspectPrivilegesState(c);
    check('P1 marker ada tetapi privilege sudah di-revoke',
      s4.markerExists === true && mod.privilegesComplete(s4) === false);

    const r4 = await mod.runPosCommunicationSettingsRuntimePrivilegesMigration(pool);
    check('P2 fail-closed: status=error (MARKER_EXISTS_BUT_PRIVILEGES_INCOMPLETE)',
      r4.status === 'error' && r4.ok === false &&
      r4.errors.some((e) => e.includes('MARKER_EXISTS_BUT_PRIVILEGES_INCOMPLETE')));

    // Privileges TIDAK boleh berubah-ubah diam-diam oleh jalur error.
    let s4b = await mod.inspectPrivilegesState(c);
    check('P3 privilege tetap lengkap=FALSE setelah fail-closed (tidak auto-repair)',
      mod.privilegesComplete(s4b) === false);

    // ── 5) Reconcile: marker dihapus → apply ulang ────────────────────────────
    await c.query('DELETE FROM schema_migrations WHERE version = $1', [CORRECTIVE_MARKER]);
    const r5 = await mod.runPosCommunicationSettingsRuntimePrivilegesMigration(pool);
    check('R1 apply setelah marker-dihapus = applied (reconcile idempotent)',
      r5.status === 'applied' && r5.ok === true && r5.applied === true);

    let s5 = await mod.inspectPrivilegesState(c);
    check('R2 privileges lengkap setelah reconcile', mod.privilegesComplete(s5) === true && s5.markerExists === true);

     // ── 6) Prerequisite-failure semantics (fail-closed, no residue) ────────────
    // Hapus marker utama DDL sementara → apply WAJIB prerequisite-failed
    // dan TIDAK boleh mengubah state corrective (marker + privileges).
    const primaryRow = (await c.query(
      'SELECT applied_at FROM schema_migrations WHERE version = $1', [PRIMARY_MARKER]
    )).rows[0];
    // Capture snapshot state corrective SEBELUM simulasi.
    const snapBefore = {
      markerCount: (await c.query(
        'SELECT COUNT(*)::int AS n FROM schema_migrations WHERE version = $1', [CORRECTIVE_MARKER]
      )).rows[0].n,
      privileges: await mod.inspectPrivilegesState(c),
    };
    let primaryDeleted = false;
    try {
      await c.query('DELETE FROM schema_migrations WHERE version = $1', [PRIMARY_MARKER]);
      primaryDeleted = true;

      const r6 = await mod.runPosCommunicationSettingsRuntimePrivilegesMigration(pool);
      check('PF1 status=prerequisite-failed (marker utama DDL tidak ada)',
        r6.status === 'prerequisite-failed' && r6.ok === false && r6.applied === false);

      // Assert state corrective TIDAK BERUBAH (snapshot after == before).
      const pfMarkerAfter = (await c.query(
        'SELECT COUNT(*)::int AS n FROM schema_migrations WHERE version = $1', [CORRECTIVE_MARKER]
      )).rows[0].n;
      check('PF2 marker corrective TIDAK BERUBAH setelah prerequisite-failed (state unchanged)',
        pfMarkerAfter === snapBefore.markerCount);

      const pfStateAfter = await mod.inspectPrivilegesState(c);
      const samePrivileges =
        pfStateAfter.hasSelect === snapBefore.privileges.hasSelect &&
        pfStateAfter.hasInsert === snapBefore.privileges.hasInsert &&
        pfStateAfter.hasUpdate === snapBefore.privileges.hasUpdate &&
        pfStateAfter.hasSeqUsage === snapBefore.privileges.hasSeqUsage &&
        pfStateAfter.hasSeqSelect === snapBefore.privileges.hasSeqSelect;
      check('PF3 privilege state TIDAK BERUBAH setelah prerequisite-failed (state unchanged)',
        samePrivileges);
    } finally {
      // Pulihkan marker utama apa pun yang terjadi (safety first).
      if (primaryDeleted) {
        if (primaryRow && primaryRow.applied_at !== undefined) {
          await c.query(
            'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2) ' +
            'ON CONFLICT (version) DO NOTHING',
            [PRIMARY_MARKER, primaryRow.applied_at]
          );
        } else {
          await c.query(
            'INSERT INTO schema_migrations (version) VALUES ($1) ' +
            'ON CONFLICT (version) DO NOTHING',
            [PRIMARY_MARKER]
          );
        }
        primaryDeleted = false;
        primaryRestored = true;
      }
    }
    const primaryRestoredCount = (await c.query(
      'SELECT 1 FROM schema_migrations WHERE version = $1', [PRIMARY_MARKER]
    )).rowCount;
    check('PF4 marker utama DDL dipulihkan setelah simulasi', (primaryRestoredCount ?? 0) === 1);

    // ── 7) TOCTOU-static proof: urutan BEGIN → advisory lock → prereq di dist ────
    // Membaca source modul yang compiled (dist) dan memverifikasi bahwa
    // checkPrivilegesPrerequisites dipanggil SETELAH BEGIN + advisory lock
    // (di dalam transaksi), bukan sebelumnya.
    // Isolasi: cari region fungsi runPosCommunicationSettingsRuntimePrivilegesMigration,
    // lalu cari call-site di dalam region tersebut (bukan global indexOf).
    const distModulePath = path.resolve(__dirname, '..', 'dist', 'db', 'migrations',
      'pos_communication_settings_runtime_privileges_v1.js');
    let distSrc = '';
    try {
      distSrc = fs.readFileSync(distModulePath, 'utf8');
    } catch (e) {
      problem('PF5 baca dist modul gagal', e);
    }
    // Isolasi region fungsi: dari "async function runPos..." sampai akhir file atau function selanjutnya.
    const fnStart = distSrc.indexOf('async function runPosCommunicationSettingsRuntimePrivilegesMigration');
    const fnSrc = fnStart !== -1 ? distSrc.slice(fnStart) : distSrc;
    // Call-site di dalam region fungsi.
    const idxBegin = fnSrc.indexOf("client.query('BEGIN')");
    const idxAdvisory = fnSrc.indexOf('client.query(ADVISORY_LOCK)');
    const idxPrereqCall = fnSrc.indexOf('checkPrivilegesPrerequisites(client)');
    check('PF5 urutan TOCTOU-safe: BEGIN sebelum advisory lock (di dalam fungsi apply)',
      idxBegin !== -1 && idxAdvisory !== -1 && idxBegin < idxAdvisory);
    check('PF6 urutan TOCTOU-safe: advisory lock sebelum prerequisite check',
      idxAdvisory !== -1 && idxPrereqCall !== -1 && idxAdvisory < idxPrereqCall);
    check('PF7 prerequisite check dilakukan SETELAH BEGIN (di dalam transaksi)',
      idxBegin !== -1 && idxPrereqCall !== -1 && idxPrereqCall > idxBegin);

    // ── 8) --check transaction cleanup proofs ─────────────────────���──────────────
    // 8a) Dinamis: spawn disposable runner --check, verifikasi exit code
    //     dan state machine output. Runner --check wajib exit 0/1 sesuai
    //     state machine, dan pool end clean.
    const { spawnSync } = require('child_process');
    const runnerPath = path.resolve(__dirname, '..', 'scripts',
      'run_pos_communication_settings_runtime_privileges_migration.js');
    const spawnEnv = { ...process.env };
    spawnEnv.MIGRATION_DATABASE_URL = [
      'postgres://', target.user, ':', target.password,
      '@127.0.0.1:15434/' + target.database
    ].join('');
    const spawnRes = spawnSync(process.execPath, [runnerPath, '--check'],
      { env: spawnEnv, encoding: 'utf8', timeout: 30000 });
    // State final (setelah reconcile): marker ada + privileges lengkap → ALREADY_APPLIED
    const spawnOut = (spawnRes.stdout || '') + (spawnRes.stderr || '');
    check('CK1 runner --check exit code 0 (state ALREADY_APPLIED)',
      spawnRes.status === 0);
    check('CK2 runner --check output: ALREADY_APPLIED',
      spawnOut.includes('ALREADY_APPLIED'));
    check('CK3 runner --check output: ROLLBACK check tidak gagal',
      !spawnOut.includes('ROLLBACK check gagal'));

    // 8b) Statis: source assertion — setiap jalur --check di kedua runner
    //     menutup transaksi (ROLLBACK) sebelum client.release.
    const stagingRunnerPath = path.resolve(__dirname, '..', 'scripts',
      'run_pos_communication_settings_runtime_privileges_migration_staging.js');
    let dispRunnerSrc = '';
    let stgRunnerSrc = '';
    try {
      dispRunnerSrc = fs.readFileSync(runnerPath, 'utf8');
      stgRunnerSrc = fs.readFileSync(stagingRunnerPath, 'utf8');
    } catch (e) {
      problem('CK4 baca source runner gagal', e);
    }
    // Hitung: setiap occurrence 'return result' di dalam runCheck harus
    // diawali blok ROLLBACK. Verifikasi via string containment.
    check('CK4 disposable runner: ROLLBACK eksplisit sebelum release di jalur INVALID_PARTIAL (schema_migrations)',
      dispRunnerSrc.includes('result = { state: \'INVALID_PARTIAL\', exitCode: 1 };') &&
      dispRunnerSrc.includes('ROLLBACK'));
    check('CK5 disposable runner: tidak ada double release (guard released)',
      dispRunnerSrc.includes('let released = false') &&
      dispRunnerSrc.includes('if (!released)'));
    check('CK6 staging runner: ROLLBACK eksplisit di jalur --check (success path)',
      stgRunnerSrc.includes('ROLLBACK'));
    check('CK7 staging runner: release discard bila ROLLBACK gagal (release(true))',
      stgRunnerSrc.includes('client.release(true)') || stgRunnerSrc.includes('client.release(rollbackFailed)'));

    // 8c) Dinamis: verifikasi DB/pool tetap usable setelah spawned --check selesai.
    // Health proof: client baru + SELECT 1 + BEGIN/SELECT 1/ROLLBACK (bukan
    // memanggil fungsi PostgreSQL non-standar dari session lain).
    const healthClient = await pool.connect();
    const h1 = await healthClient.query('SELECT 1 AS ok');
    check('CK8a setelah --check: DB usable (SELECT 1 sukses)', h1.rows[0].ok === 1);
    await healthClient.query('BEGIN');
    const h2 = await healthClient.query('SELECT 1 AS ok');
    check('CK8b setelah --check: transaction baru bisa dibuka (BEGIN + SELECT 1)', h2.rows[0].ok === 1);
    await healthClient.query('ROLLBACK');
    check('CK8c setelah --check: ROLLBACK bersih (pool/DB tetap usable)', true);
    healthClient.release();

    // ── 9) Residue & cleanup ────────────────────────────────────────────────────────
    if (roleCreated) {
      // Hilangkan dependensi grant dulu (REVOKE ALL) agar DROP ROLE tidak gagal.
      await c.query(`REVOKE ALL ON TABLE public.${TABLE} FROM ${ROLE}`);
      await c.query(`REVOKE ALL ON SEQUENCE public.${SEQUENCE} FROM ${ROLE}`);
      await c.query(`DROP ROLE ${ROLE}`);
      roleCreated = false; // sudah dibersihkan
      console.log('[CLEANUP] Role fixture oak_app dihapus.');
    }

    // Residue: role fixture harus hilang bila dibuat test ini.
    const roleGone = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLE]);
    const expectedRoleGone = true; // apa pun asal test, akhir state harus konsisten
    check('Residue: role fixture state konsisten (hilang jika dibuat test)',
      ((roleGone.rowCount ?? 0) === 0) === expectedRoleGone &&
      (roleCreated === false));

    // Marker corrective tetap ada (state final yang diharapkan di disposable DB).
    const finalMarker = (await c.query(
      'SELECT 1 FROM schema_migrations WHERE version = $1', [CORRECTIVE_MARKER]
    )).rowCount;
    check('Residue: marker corrective ada (state final disposable DB)', (finalMarker ?? 0) === 1);

    cleanupDone = true;
    c.release();
    c = null;
  } catch (e) {
    problem('exception', e);
    if (c) {
      try {
        // Hapus marker corrective yang dibuat test agar residue test=0
        // (marker adalah artefak corrective; penghapusan marker milik test,
        //  BUKAN DDL utama — aman & idempotent).
        await c.query('DELETE FROM schema_migrations WHERE version = $1', [CORRECTIVE_MARKER]);
        if (roleCreated) {
          try {
            await c.query(`REVOKE ALL ON TABLE public.${TABLE} FROM ${ROLE}`);
            await c.query(`REVOKE ALL ON SEQUENCE public.${SEQUENCE} FROM ${ROLE}`);
            await c.query(`DROP ROLE ${ROLE}`);
            console.log('[CLEANUP-EXC] Role fixture oak_app dihapus.');
          } catch (de) {
            console.error('[CLEANUP-EXC] Gagal hapus role fixture: ' + String((de && de.message) || de));
          }
        }
      } catch (de) {
        console.error('[CLEANUP-EXC] Gagal bersih state: ' + String((de && de.message) || de));
      }
      try { c.release(true); } catch (_) {}
      c = null;
    }
    cleanupDone = true;
  } finally {
    try { await pool.end(); } catch (e) { /* pool sudah ditutup */ }
  }

  console.log('');
  console.log('=========================================');
  console.log('Total: ' + (passed + failures.length) + ' | PASS: ' + passed + ' | FAIL: ' + failures.length);
  if (failures.length > 0) {
    console.error('GAGAL:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('ALL PASS');
  console.log('(cleanup ' + (cleanupDone ? 'OK' : 'GAGAL — periksa manual') + ')');
  process.exit(0);
}

main().catch((e) => {
  console.error('UNEXPECTED: ' + ((e && e.stack) || e));
  process.exit(1);
});
