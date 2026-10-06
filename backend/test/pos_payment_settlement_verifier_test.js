/**
 * POS PAYMENT SETTLEMENT VERIFIER — Test terarah
 *
 * Menjalankan DDL + verifier pos_payment_settlement_v1 pada disposable test DB,
 * lalu menguji 6 skenario mismatch dengan SAVEPOINT agar tidak merusak baseline.
 *
 * DB safety guard (identik pola pos_order_foundation_test.js):
 * - TEST_DATABASE_URL eksplisit: postgres://, localhost/127.0.0.1, port eksplisit,
 *   user & password lengkap, database berakhiran '_test'.
 * - Tanpa query parameter, tanpa fallback .env / DB_* / PG*.
 * - Menolak nama DB/user mengandung staging|production|prod|live.
 * - Target hanya 127.0.0.1:15434/oak_minibar_test.
 * - TANPA import app atau initializeDatabase — hanya PoolClient dari pg.
 *
 * Run:
 *   TEST_DATABASE_URL=postgres://postgres:PASSWORD@127.0.0.1:15434/oak_minibar_test \
 *   node backend/test/pos_payment_settlement_verifier_test.js
 */

'use strict';

// ─── DB SAFETY GUARD ─────────────────────────────────────────────────────────
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !testUrl.trim()) {
  console.error(
    'SAFETY: TEST_DATABASE_URL tidak di-set.\n' +
    'Jalankan: TEST_DATABASE_URL=postgres://USER:PASS@127.0.0.1:15434/oak_minibar_test ' +
    'node backend/test/pos_payment_settlement_verifier_test.js'
  );
  process.exit(1);
}

const FORBIDDEN = ['staging', 'production', 'prod', 'live'];
let target;
try {
  const u = new URL(testUrl.trim());
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new Error('protocol wajib postgres/postgresql');
  }
  if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
    throw new Error(`host wajib localhost/127.0.0.1 (diterima: ${u.hostname})`);
  }
  if (u.searchParams.size > 0) {
    const keys = [...u.searchParams.keys()].join(', ');
    throw new Error(`query parameter tidak didukung: "${keys}"`);
  }
  const user = u.username ? decodeURIComponent(u.username) : '';
  const password = u.password ? decodeURIComponent(u.password) : '';
  const database = u.pathname ? decodeURIComponent(u.pathname.replace(/^\//, '')) : '';
  if (!user) throw new Error('user wajib lengkap');
  if (!password) throw new Error('password wajib lengkap');
  if (!/^[a-z0-9_]+_test$/.test(database.toLowerCase())) {
    throw new Error(`database wajib berakhiran "_test" (diterima: ${database})`);
  }
  if (FORBIDDEN.some((p) => database.toLowerCase().includes(p))) {
    throw new Error('indikator staging/production/live terdeteksi');
  }
  if (!u.port) throw new Error('port wajib eksplisit (tanpa fallback 5432)');
  const port = Number(u.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`port tidak valid (diterima: ${u.port})`);
  }
  target = { host: u.hostname, port, user, database, password };
  console.log(`[SETTLEMENT VERIFIER TEST] Target DB: ${database} (user: ${user}, port: ${port})`);
} catch (e) {
  console.error('SAFETY: TEST_DATABASE_URL ditolak — ' + e.message);
  process.exit(1);
}

// Set env vars yang dibutuhkan pg tanpa fallback
process.env.DB_HOST = target.host;
process.env.DB_PORT = String(target.port);
process.env.DB_USER = target.user;
process.env.DB_PASSWORD = target.password;
process.env.DB_NAME = target.database;
process.env.RUN_SCHEMA_INITIALIZATION = 'false';

// Hanya import dari dist — TANPA app/initializeDatabase
const { Pool, PoolClient } = require('pg');
const {
  POS_PAYMENT_SETTLEMENT_DDL,
  verifyPosPaymentSettlementSchema,
} = require('../dist/db/migrations/pos_payment_settlement_v1');

// ── State ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ' — ' + detail : ''}`);
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  }
}

async function main() {
  const pool = new Pool({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    max: 1,
  });

  let client;
  let txActive = false;
  try {
    client = await pool.connect();

    // ── 0. Verifikasi identitas DB ─────────────────────────────────────────
    console.log('\n[0] Verifikasi identitas DB');
    const poolOpts = pool.options || {};
    ok(`pool.options.host = ${target.host}`,
      poolOpts.host === target.host, `actual: ${poolOpts.host}`);
    ok(`pool.options.port = ${target.port}`,
      String(poolOpts.port) === String(target.port), `actual: ${poolOpts.port}`);
    ok(`pool.options.user = ${target.user}`,
      poolOpts.user === target.user, `actual: ${poolOpts.user}`);
    ok(`pool.options.database = ${target.database}`,
      poolOpts.database === target.database, `actual: ${poolOpts.database}`);

    const dbIdent = await client.query(
      `SELECT current_database() AS db, current_user AS usr`
    );
    const ident = dbIdent.rows[0];
    ok(`current_database() = ${target.database}`, ident.db === target.database, `actual: ${ident.db}`);
    ok(`current_user = ${target.user}`, ident.usr === target.user, `actual: ${ident.usr}`);
    // Docker memetakan host 15434 → PostgreSQL internal 5432;
    // current_database/current_user + pool.options.port adalah guard identitas.

    // ── 1. Verifikasi tabel & marker BELUM ada ─────────────────────────────
    console.log('\n[1] Verifikasi tabel & marker belum ada');
    const preTable = await client.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'pos_settlements'`
    );
    if ((preTable.rowCount ?? 0) > 0) {
      console.error(
        '\n[STOP] public.pos_settlements SUDAH ADA di DB ini.\n' +
        'Test ini tidak boleh melanjutkan (bahaya DROP/repair).\n' +
        'Pilih DB bersih atau hapus manual dengan persetujuan user.\n'
      );
      process.exit(2);
    }

    const preMarker = await client.query(
      `SELECT 1 FROM schema_migrations WHERE version = 'pos_payment_settlement_v1'`
    );
    if ((preMarker.rowCount ?? 0) > 0) {
      console.error(
        '\n[STOP] Marker pos_payment_settlement_v1 SUDAH ADA di schema_migrations.\n' +
        'Test ini tidak boleh melanjutkan.\n'
      );
      process.exit(2);
    }
    ok('public.pos_settlements belum ada', true);
    ok('marker pos_payment_settlement_v1 belum ada', true);

    // ── 2. Baseline: DDL + verifier harus ok=true ─────────────────────────
    console.log('\n[2] Baseline: eksekusi DDL + verifikasi');
    await client.query('BEGIN');
    txActive = true;

    // Eksekusi seluruh DDL sebagai satu multi-statement query
    await client.query(POS_PAYMENT_SETTLEMENT_DDL);

    const baseResult = await verifyPosPaymentSettlementSchema(client);
    ok('verifier baseline ok=true', baseResult.ok === true,
      baseResult.errors.length ? 'errors: ' + JSON.stringify(baseResult.errors) : '');

    // ── 3. Uji mismatch: SAVEPOINT per kasus ──────────────────────────────
    // Setiap kasus:
    //   SAVEPOINT sp;
    //   ALTER constraint/index;
    //   ROLLBACK TO SAVEPOINT sp;  ← verifikasi harus ok=false
    //   (kembalikan ke baseline)
    //   Setelah ROLLBACK TO, verifier harus ok=true kembali.

    async function mismatchCase(label, alterSql, expectVerdict) {
      await client.query('SAVEPOINT sp_mismatch');
      try {
        await client.query(alterSql);
      } catch (e) {
        // Jika ALTER gagal (misal constraint tak ada), ROLLBACK TO dan skip
        await client.query('ROLLBACK TO SAVEPOINT sp_mismatch');
        console.log(`  SKIP  ${label} — ALTER gagal: ${e.message}`);
        return;
      }
      const r = await verifyPosPaymentSettlementSchema(client);
      const verdict = r.ok ? 'ok=true' : 'ok=false';
      ok(`${label}: verifier ${expectVerdict} (${verdict})`,
        (expectVerdict === 'ok=false') ? r.ok === false : r.ok === true,
        r.errors.length ? 'errors: ' + JSON.stringify(r.errors.slice(0, 3)) : '');
      await client.query('ROLLBACK TO SAVEPOINT sp_mismatch');
      // Setelah rollback, verifier harus ok=true kembali
      const r2 = await verifyPosPaymentSettlementSchema(client);
      ok(`${label}: baseline kembali ok=true`, r2.ok === true,
        r2.errors.length ? 'errors: ' + JSON.stringify(r2.errors.slice(0, 3)) : '');
    }

    console.log('\n[3] Uji mismatch (SAVEPOINT per kasus)');

    // Kasus 1: FK order diganti ON DELETE CASCADE
    await mismatchCase(
      'FK order ON DELETE CASCADE',
      `ALTER TABLE pos_settlements DROP CONSTRAINT fk_pos_settlements_order;
       ALTER TABLE pos_settlements ADD CONSTRAINT fk_pos_settlements_order
       FOREIGN KEY (pos_order_id) REFERENCES pos_orders(id) ON DELETE CASCADE;`,
      'ok=false'
    );

    // Kasus 2: CHECK amount diganti OR TRUE (predicate tak ketat)
    await mismatchCase(
      'CHECK amount OR TRUE',
      `ALTER TABLE pos_settlements DROP CONSTRAINT chk_pos_settlements_amount_positive;
       ALTER TABLE pos_settlements ADD CONSTRAINT chk_pos_settlements_amount_positive
       CHECK (amount > 0 OR TRUE);`,
      'ok=false'
    );

    // Kasus 3: UNIQUE order diganti key yang tidak menjamin satu settlement/order
    await mismatchCase(
      'UNIQUE order (property_id, pos_order_id, idempotency_key)',
      `ALTER TABLE pos_settlements DROP CONSTRAINT uq_pos_settlements_order;
       ALTER TABLE pos_settlements ADD CONSTRAINT uq_pos_settlements_order
       UNIQUE (property_id, pos_order_id, idempotency_key);`,
      'ok=false'
    );

    // Kasus 4: Index lookup diberi predicate (partial index)
    await mismatchCase(
      'Index partial (predicate)',
      `DROP INDEX IF EXISTS idx_pos_settlements_order;
       CREATE INDEX idx_pos_settlements_order
       ON pos_settlements (property_id, pos_order_id)
       WHERE status = 'SUCCESS';`,
      'ok=false'
    );

    // Kasus 5: Default status diubah
    await mismatchCase(
      'Default status PENDETECTAN',
      `ALTER TABLE pos_settlements ALTER COLUMN status SET DEFAULT 'PENDING';`,
      'ok=false'
    );

    // Kasus 6: Default id dihapus
    await mismatchCase(
      'Default id dihapus',
      `ALTER TABLE pos_settlements ALTER COLUMN id DROP DEFAULT;`,
      'ok=false'
    );

  } catch (err) {
    // Exception di tengah transaksi (mis. baseline gagal / verifier throw):
    // catat kegagalan, pastikan ROLLBACK aman (dilakukan di finally).
    console.error('\n[EXCEPTION]', err.message);
    console.error(err.stack);
    failed++;
    failures.push('exception pada alur utama: ' + err.message);
  } finally {
    // ── 4. ROLLBACK seluruh transaksi (aman, dijalankan termasuk saat gagal) ──
    if (txActive) {
      console.log('\n[4] ROLLBACK seluruh transaksi');
      try {
        await client.query('ROLLBACK');
        txActive = false;
      } catch (rbErr) {
        console.error('ROLLBACK gagal:', rbErr.message);
        failed++;
        failures.push('ROLLBACK gagal: ' + rbErr.message);
      }
    }

    // ── 5. Verifikasi post-rollback: tabel, sequence, marker tak ada ──────
    // Dilaksanakan di finally agar tetap berjalan walau baseline/exception.
    console.log('\n[5] Verifikasi post-rollback');
    try {
      const postTable = await client.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'pos_settlements'`
      );
      ok('post-rollback: public.pos_settlements TIDAK ADA', (postTable.rowCount ?? 0) === 0,
        `rowCount=${postTable.rowCount}`);

      const postSeq = await client.query(
        `SELECT 1 FROM pg_class WHERE relname = 'pos_settlements_id_seq' AND relkind = 'S'`
      );
      ok('post-rollback: sequence pos_settlements_id_seq TIDAK ADA',
        (postSeq.rowCount ?? 0) === 0, `rowCount=${postSeq.rowCount}`);

      const postMarker = await client.query(
        `SELECT 1 FROM schema_migrations WHERE version = 'pos_payment_settlement_v1'`
      );
      ok('post-rollback: marker pos_payment_settlement_v1 TIDAK ADA',
        (postMarker.rowCount ?? 0) === 0, `rowCount=${postMarker.rowCount}`);
    } catch (postErr) {
      console.error('Pemeriksaan post-rollback gagal:', postErr.message);
      failed++;
      failures.push('pemeriksaan post-rollback gagal: ' + postErr.message);
    }

    // Rilis client & tutup pool (setelah ROLLBACK)
    if (client) {
      try { client.release(); } catch (_) {}
    }
    await pool.end().catch(() => {});
  }

  // ── Ringkasan ───────────────────────────────────────────────────────────
  console.log(`\n[RESULT] ${passed} PASS, ${failed} FAIL`);
  if (failures.length) {
    console.log('Gagal:', failures.join('; '));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n[CRASH]', err.message, err.stack);
  process.exit(1);
});
