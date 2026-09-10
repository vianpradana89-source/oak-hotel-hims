/**
 * Concurrent replacement regression test for replaceEvidence().
 *
 * Verifies that two simultaneous replacement requests targeting the same
 * active evidence never produce two active replacement evidences per payment.
 * Exactly one replacement must win; the loser must fail safely with
 * EVIDENCE_CONFLICT and its newly-saved file must be compensated (deleted).
 */
'use strict';

require('dotenv').config({ path: 'E:/oak-hotel-hims/backend/.env' });
const http = require('http');
const { app, pool } = require('../dist/index');
const { initializeDatabase } = require('../dist/db/schema_v3');
const { generateToken } = require('../dist/domains/auth/authService');
const { deleteEvidenceFile } = require('../dist/domains/payments/evidenceStorageService');

let server;
let baseUrl;
let authToken;
let passed = 0;
let failed = 0;

function expect(condition, msg) {
  if (condition) { passed++; console.log('PASS | ' + msg); }
  else { failed++; console.error('FAIL | ' + msg); }
}

async function api(method, routePath, body, isJson = true) {
  const opts = { method, headers: { Authorization: authToken || '' } };
  if (isJson) {
    opts.headers['Content-Type'] = 'application/json';
    if (body && method !== 'GET') opts.body = JSON.stringify(body);
  } else if (body) {
    opts.body = body;
  }
  const res = await fetch(baseUrl + routePath, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

(async () => {
  try {
    await initializeDatabase(pool);
    server = http.createServer(app);
    server.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    const userRes = await pool.query("SELECT id, username, full_name, role_id FROM users WHERE username = 'vian'");
    if (userRes.rows.length > 0) {
      authToken = 'Bearer ' + generateToken({
        id: userRes.rows[0].id,
        email: '',
        username: userRes.rows[0].username,
        full_name: userRes.rows[0].full_name,
        role: 'Super Admin',
        role_id: userRes.rows[0].role_id,
        property_id: 1,
        scope: 'FULL'
      });
    }

    console.log('\n=== CONCURRENCY: Concurrent Replacement Test ===\n');

    // ── Build isolated fixture ──────────────────────────────────────────────
    const rand = Math.floor(100 + Math.random() * 900);
    let propId, catId, roomTypeId, roomId, bookingId, resId, paymentId;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const propRes = await client.query(
        `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
         VALUES ('Concurrent Test', 'EC${rand}', 'Asia/Jakarta', 'IDR', 'Test St', TRUE)
         RETURNING id`,
      );
       propId = propRes.rows[0].id;

       const catRes = await client.query(
         `INSERT INTO room_categories (property_id, code, name, is_active)
          VALUES ($1, 'CAT-EVT', 'Cat', TRUE) RETURNING id`, [propId]
       );
       catId = catRes.rows[0].id;

       const rtRes = await client.query(
         `INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity)
          VALUES ($1, $2, 'RTEVT', 'Test', 500000, 2) RETURNING id`, [propId, catId]
       );
       roomTypeId = rtRes.rows[0].id;

       const roomRes = await client.query(
         `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
          VALUES ($1, $2, '901', 'Room 901', 'Ready', TRUE) RETURNING id`, [propId, roomTypeId]
       );
       roomId = roomRes.rows[0].id;

       const bRes = await client.query(
         `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
          VALUES ($1, $2, 'Guest EVT', 'ACTIVE') RETURNING id`,
         [propId, `BID-EVT-${Date.now()}`]
       );
       bookingId = bRes.rows[0].id;

       const rRes = await client.query(
         `INSERT INTO reservations (
            booking_id, room_id, guest_name, check_in, check_out,
            total_price, amount_paid, remaining_balance, status, payment_status, stay_sequence
          ) VALUES ($1, $2, 'Guest EVT', '2026-09-01', '2026-09-03',
                   500000, 0, 500000, 'BOOKED', 'UNPAID', 1)
          RETURNING id`,
         [bookingId, roomId]
       );
       resId = rRes.rows[0].id;

       const pRes = await client.query(
         `INSERT INTO payment_transactions (
            reservation_id, transaction_type, amount, payment_method, status
          ) VALUES ($1, 'PAYMENT', 500000, 'TRANSFER', 'SUCCESS')
          RETURNING id`,
         [resId]
       );
       paymentId = pRes.rows[0].id;

      await client.query(`UPDATE reservations SET amount_paid = 500000, remaining_balance = 0 WHERE id = $1`, [resId]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    console.log(`Fixture: propId=${propId}, resId=${resId}, paymentId=${paymentId}`);

    try {
      // ── Upload Evidence A (initial active evidence) ─────────────────────────
    const formA = new FormData();
    formA.append('property_id', String(propId));
    formA.append('evidence_type', 'BANK_TRANSFER');
    formA.append('file', new Blob(['EVIDENCE_A_CONTENT'], { type: 'image/jpeg' }), 'evidence_a.jpg');

    const uploadRes = await api('POST', `/api/reservations/${resId}/payments/${paymentId}/evidences`, formA, false);
    expect(uploadRes.status === 201, 'Initial upload returns 201');
    const evidA = uploadRes.json.data?.evidence;
    expect(evidA && evidA.id > 0, 'Evidence A ID created');
    expect(evidA.is_active === true, 'Evidence A is active');
    console.log(`Evidence A ID: ${evidA.id}`);

    // Verify invariant before concurrency test
    const beforeCount = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM payment_evidences
       WHERE payment_transaction_id = $1 AND is_active = TRUE`, [paymentId]
    );
    expect(beforeCount.rows[0].cnt === 1, 'Before: exactly 1 active evidence');

    // ── Launch TWO concurrent replacements targeting Evidence A ─────────────
    console.log('\nLaunching concurrent replacements...');

    const formB = new FormData();
    formB.append('property_id', String(propId));
    formB.append('evidence_type', 'BANK_TRANSFER');
    formB.append('file', new Blob(['EVIDENCE_B_CONTENT'], { type: 'image/jpeg' }), 'evidence_b.jpg');

    const formC = new FormData();
    formC.append('property_id', String(propId));
    formC.append('evidence_type', 'BANK_TRANSFER');
    formC.append('file', new Blob(['EVIDENCE_C_CONTENT'], { type: 'image/jpeg' }), 'evidence_c.jpg');

    const [replaceResB, replaceResC] = await Promise.all([
      api('POST', `/api/reservations/${resId}/payments/${paymentId}/evidences/${evidA.id}/replace`, formB, false),
      api('POST', `/api/reservations/${resId}/payments/${paymentId}/evidences/${evidA.id}/replace`, formC, false)
    ]);

    console.log(`Replace B status: ${replaceResB.status}, code: ${replaceResB.json?.code}`);
    console.log(`Replace C status: ${replaceResC.status}, code: ${replaceResC.json?.code}`);

    const isBSuccess = replaceResB.status === 200 && replaceResB.json?.status === 'SUCCESS';
    const isCSuccess = replaceResC.status === 200 && replaceResC.json?.status === 'SUCCESS';
    const isBConflict = replaceResB.status === 409 && replaceResB.json?.code === 'EVIDENCE_CONFLICT';
    const isCConflict = replaceResC.status === 409 && replaceResC.json?.code === 'EVIDENCE_CONFLICT';

    expect(
      (isBSuccess && isCConflict) || (isCSuccess && isBConflict),
      'Exactly one replacement succeeds, other gets EVIDENCE_CONFLICT'
    );

    const winner = isBSuccess ? replaceResB : replaceResC;
    const loser = isBSuccess ? replaceResC : replaceResB;
    const winnerEvidenceId = winner.json.data?.new_evidence?.id;

    console.log(`Winner: status=${winner.status}, newEvidenceId=${winnerEvidenceId}`);
    console.log(`Loser: status=${loser.status}, code=${loser.json?.code}`);

    // ── Invariant: exactly ONE active evidence ──────────────────────────────
    const afterCount = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM payment_evidences
       WHERE payment_transaction_id = $1 AND is_active = TRUE`, [paymentId]
    );
    expect(afterCount.rows[0].cnt === 1, 'After: exactly 1 active evidence (invariant preserved)');

    // ── Winner evidence is active with correct content ──────────────────────
    const winnerCheck = await pool.query(
      `SELECT id, is_active, original_filename FROM payment_evidences
       WHERE id = $1`, [winnerEvidenceId]
    );
    expect(winnerCheck.rows.length === 1, 'Winner evidence exists');
    expect(winnerCheck.rows[0].is_active === true, 'Winner evidence is active');

    // ── Old evidence A is deactivated ───────────────────────────────────────
    const oldCheck = await pool.query(
      `SELECT id, is_active, deactivated_at, deactivation_reason FROM payment_evidences
       WHERE id = $1`, [evidA.id]
    );
    expect(oldCheck.rows.length === 1, 'Old evidence A still in DB');
    expect(oldCheck.rows[0].is_active === false, 'Old evidence A is deactivated');
    expect(oldCheck.rows[0].deactivation_reason === 'Diperbarui via Ganti Bukti', 'Deactivation reason recorded');

    // ── Verify all evidences state ──────────────────────────────────────────
    const allEvids = await pool.query(
      `SELECT id, is_active, original_filename FROM payment_evidences
       WHERE payment_transaction_id = $1 ORDER BY id`, [paymentId]
    );
    console.log(`\nAll evidences for payment (${allEvids.rows.length} rows):`);
    allEvids.rows.forEach((r, i) => {
      console.log(`  [${i+1}] id=${r.id}, active=${r.is_active}, file=${r.original_filename}`);
    });

    const activeCount = allEvids.rows.filter(r => r.is_active).length;
    expect(activeCount === 1, `Only 1 active evidence among ${allEvids.rows.length} total`);

    // ── Audit: exactly 1 PAYMENT_EVIDENCE_REPLACED ──────────────────────────
    const auditCount = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM audit_logs
       WHERE action = 'PAYMENT_EVIDENCE_REPLACED' AND record_id = $1 AND property_id = $2`,
      [String(resId), propId]
    );
    expect(auditCount.rows[0].cnt === 1, 'Exactly 1 PAYMENT_EVIDENCE_REPLACED audit log');

    } finally {
      // ── Cleanup ─────────────────────────────────────────────────────────────
      const cleanupClient = await pool.connect();
      try {
        await cleanupClient.query('BEGIN');

        if (paymentId) {
          const keysRes = await cleanupClient.query(
            'SELECT storage_key FROM payment_evidences WHERE payment_transaction_id = $1',
            [paymentId]
          );
          for (const row of keysRes.rows) {
            if (row.storage_key) {
              await deleteEvidenceFile(row.storage_key).catch(() => {});
            }
          }
        }

        if (propId) await cleanupClient.query('DELETE FROM audit_logs WHERE property_id = $1', [propId]);
        if (paymentId) await cleanupClient.query('DELETE FROM payment_evidences WHERE payment_transaction_id = $1', [paymentId]);
        if (resId) await cleanupClient.query('DELETE FROM payment_transactions WHERE reservation_id = $1', [resId]);
        if (resId) await cleanupClient.query('DELETE FROM reservations WHERE id = $1', [resId]);
        if (bookingId) await cleanupClient.query('DELETE FROM bookings WHERE id = $1', [bookingId]);
        if (roomId) await cleanupClient.query('DELETE FROM rooms WHERE id = $1', [roomId]);
        if (roomTypeId) await cleanupClient.query('DELETE FROM room_types WHERE id = $1', [roomTypeId]);
        if (catId) await cleanupClient.query('DELETE FROM room_categories WHERE id = $1', [catId]);
        if (propId) await cleanupClient.query('DELETE FROM properties WHERE id = $1', [propId]);

        await cleanupClient.query('COMMIT');
      } catch (e) {
        await cleanupClient.query('ROLLBACK').catch(() => {});
        console.error('Cleanup error:', e.message);
      } finally {
        cleanupClient.release();
      }
      console.log('\nCleanup done.');
    }

    console.log(`\n=== CONCURRENCY TEST: ${passed} PASSED, ${failed} FAILED ===`);
    server.close();
  } catch (err) {
    console.error('Test run error:', err);
    process.exitCode = 1;
  }
})();
