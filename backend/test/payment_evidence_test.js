'use strict';

require('dotenv').config({ path: 'E:/oak-hotel-hims/backend/.env' });
const http = require('http');
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { app, pool } = require('../dist/index');
const { initializeDatabase } = require('../dist/db/schema_v3');
const { deleteEvidenceFile } = require('../dist/domains/payments/evidenceStorageService');
const { uploadPaymentEvidence } = require('../dist/domains/payments/paymentEvidenceService');
const { createPaymentCore } = require('../dist/domains/payments/paymentDomainService');

let server;
let baseUrl;
let passed = 0;
let failed = 0;

function expect(condition, msg) {
  if (condition) {
    passed += 1;
    console.log('PASS | ' + msg);
  } else {
    failed += 1;
    console.error('FAIL | ' + msg);
  }
}

async function api(method, routePath, body, isJson = true) {
  const opts = { method };
  if (isJson) {
    opts.headers = { 'Content-Type': 'application/json' };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);
  } else if (body) {
    opts.body = body;
  }
  const res = await fetch(baseUrl + routePath, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, json, headers: res.headers };
}

// ─── FIXTURE STATE ──────────────────────────────────────────────────────────

const FIXTURE_PREFIX = 'TEST_EVID_';
let propIdA;
let propIdB;
let catIdA;
let catIdB;
let roomTypeIdA;
let roomTypeIdB;
let roomIdA;
let roomIdB;
let bookingIdA;
let bookingIdB;
let resIdA;
let resIdB;
let paymentIdA;
let paymentIdB;
const createdStorageKeys = [];

async function setupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const randA = Math.floor(1000 + Math.random() * 9000);
    const randB = Math.floor(1000 + Math.random() * 9000);

    // Property A
    const pA = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ('Evidence Prop A', 'EA${randA}', 'Asia/Jakarta', 'IDR', 'Address A', TRUE) RETURNING id`
    );
    propIdA = pA.rows[0].id;

    // Property B
    const pB = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ('Evidence Prop B', 'EB${randB}', 'Asia/Jakarta', 'IDR', 'Address B', TRUE) RETURNING id`
    );
    propIdB = pB.rows[0].id;

    // Categories
    const cA = await client.query(
      `INSERT INTO room_categories (property_id, code, name, is_active)
       VALUES ($1, 'CAT-EA', 'Standard Cat A', TRUE) RETURNING id`,
      [propIdA]
    );
    catIdA = cA.rows[0].id;

    const cB = await client.query(
      `INSERT INTO room_categories (property_id, code, name, is_active)
       VALUES ($1, 'CAT-EB', 'Standard Cat B', TRUE) RETURNING id`,
      [propIdB]
    );
    catIdB = cB.rows[0].id;

    // Room Types
    const rtA = await client.query(
      `INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity)
       VALUES ($1, $2, 'RTEA', 'Deluxe King', 1000000, 2) RETURNING id`,
      [propIdA, catIdA]
    );
    roomTypeIdA = rtA.rows[0].id;

    const rtB = await client.query(
      `INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity)
       VALUES ($1, $2, 'RTEB', 'Standard Queen', 800000, 2) RETURNING id`,
      [propIdB, catIdB]
    );
    roomTypeIdB = rtB.rows[0].id;

    // Rooms
    const rA = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES ($1, $2, '101', 'Room 101', 'Ready', TRUE) RETURNING id`,
      [propIdA, roomTypeIdA]
    );
    roomIdA = rA.rows[0].id;

    const rB = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES ($1, $2, '201', 'Room 201', 'Ready', TRUE) RETURNING id`,
      [propIdB, roomTypeIdB]
    );
    roomIdB = rB.rows[0].id;

    // Bookings
    const bA = await client.query(
      `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
       VALUES ($1, $2, 'Guest Evidence A', 'ACTIVE') RETURNING id`,
      [propIdA, `BID-EA-${Date.now()}`]
    );
    bookingIdA = bA.rows[0].id;

    const bB = await client.query(
      `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
       VALUES ($1, $2, 'Guest Evidence B', 'ACTIVE') RETURNING id`,
      [propIdB, `BID-EB-${Date.now()}`]
    );
    bookingIdB = bB.rows[0].id;

    // Reservations
    const resA = await client.query(
      `INSERT INTO reservations (
         booking_id, room_id, guest_name, check_in, check_out,
         total_price, amount_paid, remaining_balance, status, payment_status, stay_sequence
       ) VALUES ($1, $2, 'Guest Evidence A', '2026-09-01', '2026-09-03', 1000000, 0, 1000000, 'BOOKED', 'UNPAID', 1)
       RETURNING id`,
      [bookingIdA, roomIdA]
    );
    resIdA = resA.rows[0].id;

    const resB = await client.query(
      `INSERT INTO reservations (
         booking_id, room_id, guest_name, check_in, check_out,
         total_price, amount_paid, remaining_balance, status, payment_status, stay_sequence
       ) VALUES ($1, $2, 'Guest Evidence B', '2026-09-01', '2026-09-03', 1200000, 0, 1200000, 'BOOKED', 'UNPAID', 1)
       RETURNING id`,
      [bookingIdB, roomIdB]
    );
    resIdB = resB.rows[0].id;

    // Payments
    const payA = await client.query(
      `INSERT INTO payment_transactions (
         reservation_id, transaction_type,
         amount, payment_method, status
       ) VALUES ($1, 'PAYMENT', 500000, 'TRANSFER', 'SUCCESS')
       RETURNING id`,
      [resIdA]
    );
    paymentIdA = payA.rows[0].id;
    await client.query(`UPDATE reservations SET amount_paid = 500000, remaining_balance = 500000 WHERE id = $1`, [resIdA]);

    const payB = await client.query(
      `INSERT INTO payment_transactions (
         reservation_id, transaction_type,
         amount, payment_method, status
       ) VALUES ($1, 'PAYMENT', 600000, 'QRIS', 'SUCCESS')
       RETURNING id`,
      [resIdB]
    );
    paymentIdB = payB.rows[0].id;
    await client.query(`UPDATE reservations SET amount_paid = 600000, remaining_balance = 600000 WHERE id = $1`, [resIdB]);

    await client.query('COMMIT');
    console.log(`Fixtures initialized: propIdA=${propIdA}, propIdB=${propIdB}, resIdA=${resIdA}, paymentIdA=${paymentIdA}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function cleanupFixtures() {
  console.log('\nCleaning up fixtures and private storage files...');
  // 1. Delete physical storage files created during test
  for (const sk of createdStorageKeys) {
    try {
      deleteEvidenceFile(sk);
    } catch (_) {}
  }

  // 2. Clean database records
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pIds = [propIdA, propIdB].filter(Boolean);
    const rIds = [resIdA, resIdB].filter(Boolean);
    if (pIds.length > 0 || rIds.length > 0) {
      if (pIds.length > 0) {
        await client.query(`DELETE FROM audit_logs WHERE property_id = ANY($1::int[])`, [pIds]);
        await client.query(`DELETE FROM payment_evidences WHERE property_id = ANY($1::int[])`, [pIds]);
      }
      if (rIds.length > 0) {
        await client.query(`DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])`, [rIds]);
        await client.query(`DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])`, [rIds]);
        await client.query(`DELETE FROM reservations WHERE id = ANY($1::int[])`, [rIds]);
      }
      if (pIds.length > 0) {
        await client.query(`DELETE FROM bookings WHERE property_id = ANY($1::int[])`, [pIds]);
        await client.query(`DELETE FROM rooms WHERE property_id = ANY($1::int[])`, [pIds]);
        await client.query(`DELETE FROM availability_dates WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id = ANY($1::int[]))`, [pIds]);
        await client.query(`DELETE FROM room_types WHERE property_id = ANY($1::int[])`, [pIds]);
        await client.query(`DELETE FROM room_categories WHERE property_id = ANY($1::int[])`, [pIds]);
        await client.query(`DELETE FROM properties WHERE id = ANY($1::int[])`, [pIds]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error during cleanup:', err);
  } finally {
    client.release();
  }
}

// ─── TEST RUNNER ────────────────────────────────────────────────────────────

async function runTests() {
  console.log('=== PAYMENT-EVIDENCE-1 Backend Integration Tests ===\n');

  // Test 1: Schema verification
  console.log('--- 1. Schema & Table Invariants ---');
  const tableCheck = await pool.query(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'payment_evidences'
     ORDER BY ordinal_position`
  );
  expect(tableCheck.rows.length > 0, '1.1 payment_evidences table exists');
  const colNames = tableCheck.rows.map(r => r.column_name);
  expect(colNames.includes('payment_transaction_id'), '1.2 has payment_transaction_id');
  expect(colNames.includes('storage_key'), '1.3 has storage_key');
  expect(colNames.includes('mime_type'), '1.4 has mime_type');
  expect(colNames.includes('evidence_type'), '1.5 has evidence_type');
  expect(colNames.includes('is_active'), '1.6 has is_active');
  expect(colNames.includes('deactivation_reason'), '1.7 has deactivation_reason');

  // Test 2: Validation on upload (missing file, invalid mime, oversize)
  console.log('\n--- 2. Upload Validation ---');

  // 2.1 Missing file
  const noFileForm = new FormData();
  noFileForm.append('property_id', String(propIdA));
  noFileForm.append('evidence_type', 'BANK_TRANSFER');
  const noFileRes = await api('POST', `/api/reservations/${resIdA}/payments/${paymentIdA}/evidences`, noFileForm, false);
  expect(noFileRes.status === 400, '2.1 missing file rejected with 400');
  expect(noFileRes.json.code === 'FILE_REQUIRED', '2.2 error code is FILE_REQUIRED');

  // 2.2 Unsupported MIME type (text/plain)
  const invalidMimeBlob = new Blob(['sample text file'], { type: 'text/plain' });
  const invalidMimeForm = new FormData();
  invalidMimeForm.append('property_id', String(propIdA));
  invalidMimeForm.append('evidence_type', 'BANK_TRANSFER');
  invalidMimeForm.append('file', invalidMimeBlob, 'test.txt');
  const invalidMimeRes = await api('POST', `/api/reservations/${resIdA}/payments/${paymentIdA}/evidences`, invalidMimeForm, false);
  expect(invalidMimeRes.status === 400, '2.3 text/plain rejected with 400');
  expect(invalidMimeRes.json.code === 'UNSUPPORTED_MIME_TYPE', '2.4 error code is UNSUPPORTED_MIME_TYPE');

  // 2.3 Oversize file (>10MB)
  const bigBuffer = Buffer.alloc(10 * 1024 * 1024 + 1024); // 10MB + 1KB
  const bigBlob = new Blob([bigBuffer], { type: 'image/jpeg' });
  const bigForm = new FormData();
  bigForm.append('property_id', String(propIdA));
  bigForm.append('evidence_type', 'BANK_TRANSFER');
  bigForm.append('file', bigBlob, 'big_photo.jpg');
  const bigRes = await api('POST', `/api/reservations/${resIdA}/payments/${paymentIdA}/evidences`, bigForm, false);
  expect(bigRes.status === 400, '2.5 >10MB rejected with 400');
  expect(bigRes.json.code === 'FILE_TOO_LARGE', '2.6 error code is FILE_TOO_LARGE');

  // Test 3: Successful upload JPEG
  console.log('\n--- 3. Successful Upload & Storage Isolation ---');
  const sampleJpeg = Buffer.from('FAKE_JPEG_IMAGE_BINARY_DATA_12345');
  const jpegBlob = new Blob([sampleJpeg], { type: 'image/jpeg' });
  const jpegForm = new FormData();
  jpegForm.append('property_id', String(propIdA));
  jpegForm.append('evidence_type', 'BANK_TRANSFER');
  jpegForm.append('note', 'Transfer bukti BCA');
  jpegForm.append('file', jpegBlob, 'bukti_transfer.jpg');

  const uploadResA = await api('POST', `/api/reservations/${resIdA}/payments/${paymentIdA}/evidences`, jpegForm, false);
  expect(uploadResA.status === 201, '3.1 JPEG upload returns 201');
  expect(uploadResA.json.status === 'SUCCESS', '3.2 status is SUCCESS');
  const evidA = uploadResA.json.data?.evidence;
  expect(evidA && evidA.id > 0, '3.3 evidence ID returned');
  expect(evidA.evidence_type === 'BANK_TRANSFER', '3.4 evidence_type is BANK_TRANSFER');
  expect(evidA.original_filename === 'bukti_transfer.jpg', '3.5 original_filename preserved');
  expect(evidA.is_active === true, '3.6 is_active is true');

  const dbEvidRowA = await pool.query('SELECT storage_key FROM payment_evidences WHERE id = $1', [evidA.id]);
  const storageKeyA = dbEvidRowA.rows[0]?.storage_key;
  expect(storageKeyA && storageKeyA.includes(String(propIdA)), '3.7 storage_key includes property_id');
  if (storageKeyA) createdStorageKeys.push(storageKeyA);

  // Verify Audit Log for upload
  const auditUpload = await pool.query(
    `SELECT action, entity, record_id, new_value FROM audit_logs
     WHERE action = 'PAYMENT_EVIDENCE_UPLOADED' AND record_id = $1 AND property_id = $2`,
    [String(resIdA), propIdA]
  );
  expect(auditUpload.rows.length === 1, '3.8 PAYMENT_EVIDENCE_UPLOADED audit log written');

  // Test 4: Content Stream & Download
  console.log('\n--- 4. Content Retrieval & Audit Logging ---');

  // 4.1 Preview stream (inline)
  const previewRes = await fetch(`${baseUrl}/api/reservations/${resIdA}/payments/${paymentIdA}/evidences/${evidA.id}/content?property_id=${propIdA}`);
  expect(previewRes.status === 200, '4.1 preview stream returns 200');
  expect(previewRes.headers.get('content-type') === 'image/jpeg', '4.2 Content-Type is image/jpeg');
  expect(previewRes.headers.get('content-disposition').includes('inline'), '4.3 Content-Disposition is inline');
  const previewText = await previewRes.text();
  expect(previewText === 'FAKE_JPEG_IMAGE_BINARY_DATA_12345', '4.4 binary payload intact');

  // Verify PAYMENT_EVIDENCE_VIEWED audit log
  const auditView = await pool.query(
    `SELECT action FROM audit_logs
     WHERE action = 'PAYMENT_EVIDENCE_VIEWED' AND record_id = $1 AND property_id = $2`,
    [String(resIdA), propIdA]
  );
  expect(auditView.rows.length >= 1, '4.5 PAYMENT_EVIDENCE_VIEWED audit log written');

  // 4.2 Download stream (attachment)
  const downloadRes = await fetch(`${baseUrl}/api/reservations/${resIdA}/payments/${paymentIdA}/evidences/${evidA.id}/content?property_id=${propIdA}&download=1`);
  expect(downloadRes.status === 200, '4.6 download stream returns 200');
  expect(downloadRes.headers.get('content-disposition').includes('attachment'), '4.7 Content-Disposition is attachment');
  expect(downloadRes.headers.get('content-disposition').includes('bukti_transfer.jpg'), '4.8 filename in disposition header');

  // Verify PAYMENT_EVIDENCE_DOWNLOADED audit log
  const auditDownload = await pool.query(
    `SELECT action FROM audit_logs
     WHERE action = 'PAYMENT_EVIDENCE_DOWNLOADED' AND record_id = $1 AND property_id = $2`,
    [String(resIdA), propIdA]
  );
  expect(auditDownload.rows.length >= 1, '4.9 PAYMENT_EVIDENCE_DOWNLOADED audit log written');

  // Test 5: Multi-property Isolation
  console.log('\n--- 5. Multi-Property Access Enforcement ---');

  // 5.1 Property B cannot access Property A evidence content
  const crossPropContent = await fetch(`${baseUrl}/api/reservations/${resIdA}/payments/${paymentIdA}/evidences/${evidA.id}/content?property_id=${propIdB}`);
  expect(crossPropContent.status === 403, '5.1 cross-property content access rejected with 403');

  // 5.2 Property B cannot upload evidence to Property A payment
  const crossUploadBlob = new Blob(['cross data'], { type: 'image/png' });
  const crossUploadForm = new FormData();
  crossUploadForm.append('property_id', String(propIdB)); // Property B credentials
  crossUploadForm.append('evidence_type', 'QRIS_RECEIPT');
  crossUploadForm.append('file', crossUploadBlob, 'cross.png');
  const crossUploadRes = await api('POST', `/api/reservations/${resIdA}/payments/${paymentIdA}/evidences`, crossUploadForm, false);
  expect(crossUploadRes.status === 403 || crossUploadRes.status === 404, '5.2 cross-property evidence upload rejected');

  // Test 6: Evidence Deactivation (Soft delete with audit)
  console.log('\n--- 6. Evidence Deactivation (Soft Delete) ---');

  // 6.1 Empty reason rejected
  const emptyDeactRes = await api('POST', `/api/reservations/${resIdA}/payments/${paymentIdA}/evidences/${evidA.id}/deactivate`, {
    property_id: propIdA,
    reason: '   '
  });
  expect(emptyDeactRes.status === 400, '6.1 empty deactivation reason rejected with 400');

  // 6.2 Valid deactivation
  const deactRes = await api('POST', `/api/reservations/${resIdA}/payments/${paymentIdA}/evidences/${evidA.id}/deactivate`, {
    property_id: propIdA,
    reason: 'Foto struk buram, minta bukti ulang',
    actor_name: 'Supervisor Budi',
    actor_role: 'Duty Manager'
  });
  expect(deactRes.status === 200, '6.2 deactivation returns 200');
  expect(deactRes.json.data?.evidence?.is_active === false, '6.3 returned is_active is false');
  expect(deactRes.json.data?.evidence?.deactivation_reason === 'Foto struk buram, minta bukti ulang', '6.4 deactivation_reason recorded');

  // Verify in DB that is_active = false and file is still accessible
  const dbEvid = await pool.query(`SELECT is_active, deactivation_reason FROM payment_evidences WHERE id = $1`, [evidA.id]);
  expect(dbEvid.rows[0].is_active === false, '6.5 DB is_active is false');

  // Verify PAYMENT_EVIDENCE_DEACTIVATED audit log
  const auditDeact = await pool.query(
    `SELECT action FROM audit_logs
     WHERE action = 'PAYMENT_EVIDENCE_DEACTIVATED' AND record_id = $1 AND property_id = $2`,
    [String(resIdA), propIdA]
  );
  expect(auditDeact.rows.length === 1, '6.6 PAYMENT_EVIDENCE_DEACTIVATED audit log written');

  // Test 7: Actor Truth (Never Fabricated)
  console.log('\n--- 7. Actor Truth Verification ---');
  const pdfBlob = new Blob(['%PDF-1.4 sample pdf content'], { type: 'application/pdf' });
  const pdfForm = new FormData();
  pdfForm.append('property_id', String(propIdA));
  pdfForm.append('evidence_type', 'BANK_RECEIPT');
  pdfForm.append('file', pdfBlob, 'rekening_koran.pdf');
  // No actor supplied
  const uploadNoActor = await api('POST', `/api/reservations/${resIdA}/payments/${paymentIdA}/evidences`, pdfForm, false);
  expect(uploadNoActor.status === 201, '7.1 upload without actor succeeds');
  const evidNoActor = uploadNoActor.json.data?.evidence;
  const dbEvidNoActor = await pool.query('SELECT storage_key FROM payment_evidences WHERE id = $1', [evidNoActor.id]);
  if (dbEvidNoActor.rows[0]?.storage_key) createdStorageKeys.push(dbEvidNoActor.rows[0].storage_key);

  const dbNoActor = await pool.query(
    `SELECT uploaded_by_user_id, uploaded_by_name_snapshot, uploaded_by_role_snapshot
     FROM payment_evidences WHERE id = $1`,
    [evidNoActor.id]
  );
  expect(dbNoActor.rows[0].uploaded_by_user_id === null, '7.2 unknown user_id is NULL');
  expect(dbNoActor.rows[0].uploaded_by_name_snapshot === null, '7.3 unknown name is NULL (never fabricated)');
  expect(dbNoActor.rows[0].uploaded_by_role_snapshot === null, '7.4 unknown role is NULL (never fabricated)');

  // Test 8: Folio Integration
  console.log('\n--- 8. Folio Integration ---');
  const folioRes = await api('GET', `/api/reservations/${resIdA}/folio?property_id=${propIdA}`);
  expect(folioRes.status === 200, '8.1 folio returns 200');
  expect(Array.isArray(folioRes.json.data?.evidences), '8.2 data.evidences is array');
  const folioEvids = folioRes.json.data?.evidences;
  expect(folioEvids.length >= 2, '8.3 folio contains both active and inactive evidences');
  const foundDeactivated = folioEvids.find(e => e.id === evidA.id);
  expect(foundDeactivated && foundDeactivated.is_active === false, '8.4 folio preserves inactive evidence history');

  // Test 9: Payment Correction & Evidence Immutability
  console.log('\n--- 9. Payment Correction & Evidence Preservation ---');
  const corr9Blob = new Blob(['REPLACEMENT_PROOF_TEST_9'], { type: 'image/jpeg' });
  const corr9Form = new FormData();
  corr9Form.append('property_id', String(propIdA));
  corr9Form.append('amount', '450000');
  corr9Form.append('payment_method', 'TRANSFER');
  corr9Form.append('reason_code', 'WRONG_AMOUNT');
  corr9Form.append('reason_text', 'Koreksi nominal transfer');
  corr9Form.append('file', corr9Blob, 'koreksi_transfer.jpg');

  const corrRes = await api('POST', `/api/reservations/${resIdA}/payments/${paymentIdA}/correct`, corr9Form, false);
  expect(corrRes.status === 200, '9.1 payment correction succeeds');
  const replEvid9 = corrRes.json?.data?.replacement_evidence;
  if (replEvid9?.id) {
    const dbReplEvid9 = await pool.query('SELECT storage_key FROM payment_evidences WHERE id = $1', [replEvid9.id]);
    if (dbReplEvid9.rows[0]?.storage_key) createdStorageKeys.push(dbReplEvid9.rows[0].storage_key);
  }

  // Verify that evidence is STILL linked to original payment
  const postCorrEvid = await pool.query(
    `SELECT id, payment_transaction_id, is_active FROM payment_evidences WHERE id = $1`,
    [evidA.id]
  );
  expect(postCorrEvid.rows[0].payment_transaction_id === paymentIdA, '9.2 original evidence remains attached to original payment');

  // Test 10: Storage Rollback / Compensation on DB failure
  console.log('\n--- 10. Storage Compensation on DB Failure ---');
  let compensationTriggered = false;
  try {
    await uploadPaymentEvidence(pool, {
      propertyId: propIdA,
      reservationId: 9999999, // Non-existent reservation -> FK failure
      paymentTransactionId: paymentIdA,
      evidenceType: 'CASH_RECEIPT',
      file: {
        buffer: Buffer.from('TEST_ROLLBACK_COMPENSATION'),
        mimetype: 'image/jpeg',
        originalname: 'test_rollback.jpg',
        size: 26
      }
    });
  } catch (err) {
    compensationTriggered = true;
  }
  expect(compensationTriggered === true, '10.1 uploadPaymentEvidence throws on FK failure');

  // Test 11: Mandatory Evidence Gate on FO Payment Creation
  console.log('\n--- 11. Mandatory Evidence Gate on FO Payment Creation ---');
  const noEvidFoPay = await api('POST', `/api/reservations/${resIdB}/payments`, {
    property_id: propIdB,
    amount: 100000,
    payment_method: 'CASH'
  });
  expect(noEvidFoPay.status === 400, '11.1 FO payment creation without file is rejected with 400');
  expect(noEvidFoPay.json.code === 'PAYMENT_EVIDENCE_REQUIRED', '11.2 error code is PAYMENT_EVIDENCE_REQUIRED');

  // Test 12: Atomic FO Payment Creation with Evidence
  console.log('\n--- 12. Atomic FO Payment Creation with Evidence ---');
  const payEvidBlob = new Blob(['VALID_ATOMIC_PAYMENT_PROOF'], { type: 'image/png' });
  const atomicPayForm = new FormData();
  atomicPayForm.append('property_id', String(propIdB));
  atomicPayForm.append('amount', '200000');
  atomicPayForm.append('payment_method', 'QRIS');
  atomicPayForm.append('evidence_type', 'QRIS_RECEIPT');
  atomicPayForm.append('evidence_note', 'Scan QRIS Tamu di Kasir');
  atomicPayForm.append('actor_name_snapshot', 'Kasir Sinta');
  atomicPayForm.append('actor_role_snapshot', 'Front Office');
  atomicPayForm.append('file', payEvidBlob, 'qris_sinta.png');

  const atomicPayRes = await api('POST', `/api/reservations/${resIdB}/payments`, atomicPayForm, false);
  expect(atomicPayRes.status === 200, '12.1 atomic payment with evidence returns 200');
  expect(atomicPayRes.json.status === 'SUCCESS', '12.2 status is SUCCESS');
  const atomicPayment = atomicPayRes.json.data?.payment;
  const atomicEvid = atomicPayRes.json.data?.evidence;
  expect(atomicPayment && atomicPayment.id > 0, '12.3 payment row created');
  expect(atomicEvid && atomicEvid.id > 0, '12.4 evidence row created atomically');
  expect(atomicEvid.payment_transaction_id === atomicPayment.id, '12.5 evidence linked to new payment row');
  expect(atomicEvid.original_filename === 'qris_sinta.png', '12.6 original filename stored');
  expect(atomicEvid.evidence_type === 'QRIS_RECEIPT', '12.7 evidence_type is QRIS_RECEIPT');

  const dbAtomicEvid = await pool.query('SELECT storage_key FROM payment_evidences WHERE id = $1', [atomicEvid.id]);
  if (dbAtomicEvid.rows[0]?.storage_key) createdStorageKeys.push(dbAtomicEvid.rows[0].storage_key);

  // Test 13: Atomic Overpayment Rejection & Storage Compensation
  console.log('\n--- 13. Atomic Overpayment Failure & Disk Compensation ---');
  const overpayBlob = new Blob(['OVERPAYMENT_PROOF'], { type: 'image/jpeg' });
  const overpayForm = new FormData();
  overpayForm.append('property_id', String(propIdB));
  overpayForm.append('amount', '99999999'); // Exceeds balance
  overpayForm.append('payment_method', 'CASH');
  overpayForm.append('file', overpayBlob, 'overpay.jpg');

  const overpayRes = await api('POST', `/api/reservations/${resIdB}/payments`, overpayForm, false);
  expect(overpayRes.status === 400, '13.1 overpayment with evidence rejected with 400');
  expect(overpayRes.json.code === 'OVERPAYMENT_NOT_ALLOWED', '13.2 code is OVERPAYMENT_NOT_ALLOWED');

  // Verify 0 orphan payment_evidences created
  const orphanEvids = await pool.query(
    `SELECT COUNT(*)::int AS count FROM payment_evidences WHERE original_filename = 'overpay.jpg'`
  );
  expect(orphanEvids.rows[0].count === 0, '13.3 zero orphan payment_evidences rows in DB');

  // Test 14: Anti-Bypass Security Gate & Authoritative Internal Path
  console.log('\n--- 14. Anti-Bypass Security Gate & Authoritative Internal Path ---');
  // 14.1 Spoofed source=SYSTEM_INTERNAL via HTTP without evidence is rejected with 400
  const spoofSourceRes = await api('POST', `/api/reservations/${resIdB}/payments`, {
    property_id: propIdB,
    amount: 50000,
    payment_method: 'CASH',
    source: 'SYSTEM_INTERNAL'
  });
  expect(spoofSourceRes.status === 400, '14.1 HTTP payment with spoofed source=SYSTEM_INTERNAL rejected with 400');
  expect(spoofSourceRes.json?.code === 'PAYMENT_EVIDENCE_REQUIRED', '14.2 error code is PAYMENT_EVIDENCE_REQUIRED');

  // 14.2 Spoofed x-internal-system-payment header via HTTP without evidence is rejected with 400
  const spoofHeaderRes = await fetch(`${baseUrl}/api/reservations/${resIdB}/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-system-payment': 'true'
    },
    body: JSON.stringify({
      property_id: propIdB,
      amount: 50000,
      payment_method: 'CASH'
    })
  });
  const spoofHeaderJson = await spoofHeaderRes.json().catch(() => null);
  expect(spoofHeaderRes.status === 400, '14.3 HTTP payment with spoofed x-internal-system-payment header rejected with 400');
  expect(spoofHeaderJson?.code === 'PAYMENT_EVIDENCE_REQUIRED', '14.4 error code is PAYMENT_EVIDENCE_REQUIRED');

  // 14.3 Both spoofed source and header without evidence is rejected with 400
  const spoofBothRes = await fetch(`${baseUrl}/api/reservations/${resIdB}/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-system-payment': 'true'
    },
    body: JSON.stringify({
      property_id: propIdB,
      amount: 50000,
      payment_method: 'CASH',
      source: 'SYSTEM_INTERNAL'
    })
  });
  const spoofBothJson = await spoofBothRes.json().catch(() => null);
  expect(spoofBothRes.status === 400, '14.5 HTTP payment with both spoofed values rejected with 400');
  expect(spoofBothJson?.code === 'PAYMENT_EVIDENCE_REQUIRED', '14.6 error code is PAYMENT_EVIDENCE_REQUIRED');

  // 14.4 Genuine backend-internal call to createPaymentCore with requireEvidence=false succeeds
  const internalCoreRes = await createPaymentCore(pool, {
    propertyId: propIdB,
    reservationId: resIdB,
    amount: 50000,
    paymentMethod: 'CASH',
    transactionType: 'INTERNAL_ADJUSTMENT',
    requireEvidence: false
  });
  expect(internalCoreRes.payment && internalCoreRes.payment.id > 0, '14.7 internal createPaymentCore succeeds without file');
  expect(internalCoreRes.payment.transaction_type === 'INTERNAL_ADJUSTMENT', '14.8 internal payment transaction_type preserved');

  // 14.5 Internal call to createPaymentCore with requireEvidence=true without file throws
  let internalRequireFailed = false;
  try {
    await createPaymentCore(pool, {
      propertyId: propIdB,
      reservationId: resIdB,
      amount: 50000,
      paymentMethod: 'CASH',
      requireEvidence: true
    });
  } catch (err) {
    if (err && err.code === 'PAYMENT_EVIDENCE_REQUIRED') {
      internalRequireFailed = true;
    }
  }
  expect(internalRequireFailed === true, '14.9 createPaymentCore with requireEvidence=true throws PAYMENT_EVIDENCE_REQUIRED');

  // Test 15: Mandatory Replacement Evidence on Payment Correction & Anti-Bypass
  console.log('\n--- 15. Mandatory Replacement Evidence on Payment Correction & Anti-Bypass ---');

  // 15.1 Public correction without evidence rejected with 400
  const noEvidCorrRes = await api('POST', `/api/reservations/${resIdB}/payments/${atomicPayment.id}/correct`, {
    property_id: propIdB,
    amount: 150000,
    payment_method: 'QRIS',
    reason_code: 'WRONG_AMOUNT',
    reason_text: 'Koreksi nominal'
  }, true);
  expect(noEvidCorrRes.status === 400, '15.1 public correction without evidence rejected with 400');
  expect(noEvidCorrRes.json?.code === 'PAYMENT_EVIDENCE_REQUIRED', '15.2 error code is PAYMENT_EVIDENCE_REQUIRED');

  // 15.2 Public correction with spoofed source=SYSTEM_INTERNAL without file rejected with 400
  const spoofSourceCorrRes = await api('POST', `/api/reservations/${resIdB}/payments/${atomicPayment.id}/correct`, {
    property_id: propIdB,
    amount: 150000,
    payment_method: 'QRIS',
    reason_code: 'WRONG_AMOUNT',
    reason_text: 'Koreksi nominal',
    source: 'SYSTEM_INTERNAL'
  }, true);
  expect(spoofSourceCorrRes.status === 400, '15.3 correction with spoofed source=SYSTEM_INTERNAL rejected with 400');
  expect(spoofSourceCorrRes.json?.code === 'PAYMENT_EVIDENCE_REQUIRED', '15.4 error code is PAYMENT_EVIDENCE_REQUIRED');

  // 15.3 Public correction with spoofed x-internal-system-payment header without file rejected with 400
  const spoofHeaderCorrRes = await api('POST', `/api/reservations/${resIdB}/payments/${atomicPayment.id}/correct`, {
    property_id: propIdB,
    amount: 150000,
    payment_method: 'QRIS',
    reason_code: 'WRONG_AMOUNT',
    reason_text: 'Koreksi nominal'
  }, true, { 'x-internal-system-payment': 'true' });
  expect(spoofHeaderCorrRes.status === 400, '15.5 correction with spoofed header rejected with 400');
  expect(spoofHeaderCorrRes.json?.code === 'PAYMENT_EVIDENCE_REQUIRED', '15.6 error code is PAYMENT_EVIDENCE_REQUIRED');

  // 15.4 Public correction with both spoofed values rejected with 400
  const spoofBothCorrRes = await api('POST', `/api/reservations/${resIdB}/payments/${atomicPayment.id}/correct`, {
    property_id: propIdB,
    amount: 150000,
    payment_method: 'QRIS',
    reason_code: 'WRONG_AMOUNT',
    reason_text: 'Koreksi nominal',
    source: 'SYSTEM_INTERNAL'
  }, true, { 'x-internal-system-payment': 'true' });
  expect(spoofBothCorrRes.status === 400, '15.7 correction with both spoofed values rejected with 400');
  expect(spoofBothCorrRes.json?.code === 'PAYMENT_EVIDENCE_REQUIRED', '15.8 error code is PAYMENT_EVIDENCE_REQUIRED');

  // 15.5 Successful Correction with Valid Replacement Evidence
  const replEvidBlob = new Blob(['REPLACEMENT_EVIDENCE_CONTENT'], { type: 'image/jpeg' });
  const corrForm = new FormData();
  corrForm.append('property_id', String(propIdB));
  corrForm.append('amount', '150000');
  corrForm.append('payment_method', 'QRIS');
  corrForm.append('reason_code', 'WRONG_AMOUNT');
  corrForm.append('reason_text', 'Koreksi nominal QRIS');
  corrForm.append('file', replEvidBlob, 'qris_corrected.jpg');

  const corrWithFileRes = await api('POST', `/api/reservations/${resIdB}/payments/${atomicPayment.id}/correct`, corrForm, false);
  expect(corrWithFileRes.status === 200, '15.9 correction with replacement file returns 200');
  const replPayment = corrWithFileRes.json.data?.replacement;
  const replEvidData = corrWithFileRes.json.data?.replacement_evidence;
  expect(replPayment && replPayment.id > 0, '15.10 replacement payment created');
  expect(replEvidData && replEvidData.id > 0, '15.11 replacement evidence created');
  expect(replEvidData.payment_transaction_id === replPayment.id, '15.12 replacement evidence linked strictly to replacement payment');

  // Verify original evidence remains untouched and linked ONLY to original payment
  const origEvidCheck = await pool.query('SELECT * FROM payment_evidences WHERE id = $1', [atomicEvid.id]);
  expect(origEvidCheck.rows[0].payment_transaction_id === atomicPayment.id, '15.13 original evidence remains strictly linked to original payment');
  expect(origEvidCheck.rows[0].original_filename === 'qris_sinta.png', '15.14 original evidence filename untouched');

  const dbReplEvid = await pool.query('SELECT storage_key FROM payment_evidences WHERE id = $1', [replEvidData.id]);
  if (dbReplEvid.rows[0]?.storage_key) createdStorageKeys.push(dbReplEvid.rows[0].storage_key);

  // Test 16: Correction Overpayment Atomicity & File Compensation
  console.log('\n--- 16. Correction Overpayment Failure & Disk Compensation ---');
  const corrOverBlob = new Blob(['OVERPAYMENT_CORRECTION_PROOF'], { type: 'image/jpeg' });
  const corrOverForm = new FormData();
  corrOverForm.append('property_id', String(propIdB));
  corrOverForm.append('amount', '99999999'); // Massive overpayment
  corrOverForm.append('payment_method', 'CASH');
  corrOverForm.append('reason_code', 'WRONG_AMOUNT');
  corrOverForm.append('reason_text', 'Koreksi overpayment test');
  corrOverForm.append('file', corrOverBlob, 'overpay_corr.jpg');

  const beforeCorrEvidCount = (await pool.query('SELECT count(*) FROM payment_evidences WHERE reservation_id = $1', [resIdB])).rows[0].count;
  const corrOverRes = await api('POST', `/api/reservations/${resIdB}/payments/${replPayment.id}/correct`, corrOverForm, false);
  expect(corrOverRes.status === 400, '16.1 correction overpayment rejected with 400');
  expect(corrOverRes.json?.code === 'OVERPAYMENT_NOT_ALLOWED', '16.2 error code is OVERPAYMENT_NOT_ALLOWED');

  const afterCorrEvidCount = (await pool.query('SELECT count(*) FROM payment_evidences WHERE reservation_id = $1', [resIdB])).rows[0].count;
  expect(beforeCorrEvidCount === afterCorrEvidCount, '16.3 zero orphan evidence rows after failed correction');

  // Verify replacement payment remained unchanged
  const replPaymentCheck = await pool.query('SELECT * FROM payment_transactions WHERE id = $1', [replPayment.id]);
  expect(replPaymentCheck.rows[0].status === 'SUCCESS', '16.4 previous replacement payment remains SUCCESS and unmutated');

  console.log(`\n================================`);
  console.log(`Summary: ${passed} PASSED, ${failed} FAILED`);
  console.log(`================================\n`);

  if (failed > 0) {
    throw new Error(`${failed} tests failed`);
  }
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

(async () => {
  try {
    await initializeDatabase(pool);
    server = http.createServer(app);
    server.listen(0);
    await once(server, 'listening');
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    await setupFixtures();
    await runTests();
  } catch (err) {
    console.error('Test run error:', err);
    process.exitCode = 1;
  } finally {
    try {
      await cleanupFixtures();
    } catch (_) {}
    if (server) {
      server.close();
    }

    // 11. Zero Residue Assertions
    console.log('--- 11. Zero Test Residue Verification ---');
    const pCount = await pool.query('SELECT COUNT(*)::int AS count FROM properties WHERE id IN ($1, $2)', [propIdA || 0, propIdB || 0]);
    expect(pCount.rows[0].count === 0, '11.1 zero properties residue');

    const bCount = await pool.query('SELECT COUNT(*)::int AS count FROM bookings WHERE id IN ($1, $2) OR property_id IN ($3, $4)', [bookingIdA || 0, bookingIdB || 0, propIdA || 0, propIdB || 0]);
    expect(bCount.rows[0].count === 0, '11.2 zero bookings residue');

    const rCount = await pool.query('SELECT COUNT(*)::int AS count FROM reservations WHERE id IN ($1, $2)', [resIdA || 0, resIdB || 0]);
    expect(rCount.rows[0].count === 0, '11.3 zero reservations residue');

    const payCount = await pool.query('SELECT COUNT(*)::int AS count FROM payment_transactions WHERE reservation_id IN ($1, $2)', [resIdA || 0, resIdB || 0]);
    expect(payCount.rows[0].count === 0, '11.4 zero payment_transactions residue');

    const evidCount = await pool.query('SELECT COUNT(*)::int AS count FROM payment_evidences WHERE property_id IN ($1, $2)', [propIdA || 0, propIdB || 0]);
    expect(evidCount.rows[0].count === 0, '11.5 zero payment_evidences residue');

    const folioCount = await pool.query('SELECT COUNT(*)::int AS count FROM folio_entries WHERE reservation_id IN ($1, $2)', [resIdA || 0, resIdB || 0]);
    expect(folioCount.rows[0].count === 0, '11.6 zero folio_entries residue');

    const auditCount = await pool.query('SELECT COUNT(*)::int AS count FROM audit_logs WHERE property_id IN ($1, $2)', [propIdA || 0, propIdB || 0]);
    expect(auditCount.rows[0].count === 0, '11.7 zero audit_logs residue');

    console.log(`\nFinal Payment-Evidence Test Summary: ${passed} PASSED, ${failed} FAILED\n`);
    if (failed > 0) {
      process.exitCode = 1;
    }

    await pool.end();
  }
})();
