'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ─── DB SAFETY GUARD (MUST RUN BEFORE ANY dist/index IMPORT) ────────────────
const currentDb = process.env.DB_NAME || '';
if (!currentDb || !currentDb.toLowerCase().includes('test')) {
  console.error(
    `SAFETY VIOLATION: DB_NAME="${currentDb || '(unset)'}" does not contain 'test'. ` +
    'Set DB_NAME to an isolated test database before running this regression test.'
  );
  process.exit(1);
}
console.log(`Using isolated test DB: ${currentDb} on ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '5432'}`);

const http = require('http');
const fs = require('fs');
const { once } = require('events');
const { app, pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');
const { createPaymentCore } = require('../dist/domains/payments/paymentDomainService');
const { recalculateReservationFinancials } = require('../dist/domains/stayCharges/stayChargesService');

let server;
let baseUrl;
let authToken;
let passed = 0;
let failed = 0;
const resultsLog = [];

function expect(condition, msg, details = null) {
  if (condition) {
    passed += 1;
    console.log('PASS | ' + msg);
    resultsLog.push({ status: 'PASS', assertion: msg, details });
  } else {
    failed += 1;
    console.error('FAIL | ' + msg + (details ? ' | ' + JSON.stringify(details) : ''));
    resultsLog.push({ status: 'FAIL', assertion: msg, details });
  }
}

async function api(method, routePath, body, customHeaders = {}) {
  const opts = {
    method,
    headers: {
      Authorization: authToken || '',
      ...customHeaders,
    },
  };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body && method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(baseUrl + routePath, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function buildMultipartPayment({ propertyId, amount, paymentMethod = 'CASH', referenceCode, filename = 'receipt.jpg' }) {
  const fd = new FormData();
  fd.append('property_id', String(propertyId));
  fd.append('amount', String(amount));
  fd.append('payment_method', paymentMethod);
  if (referenceCode) fd.append('reference_code', referenceCode);
  fd.append(
    'file',
    new Blob([Buffer.from(`FAKE_JPEG_EVIDENCE_${Date.now()}_${Math.random()}`)], { type: 'image/jpeg' }),
    filename
  );
  return fd;
}

function buildMultipartEvidence({ propertyId, evidenceType = 'CASH_RECEIPT', filename = 'uploaded_proof.jpg' }) {
  const fd = new FormData();
  fd.append('property_id', String(propertyId));
  fd.append('evidence_type', evidenceType);
  fd.append(
    'file',
    new Blob([Buffer.from(`FAKE_JPEG_PROOF_${Date.now()}_${Math.random()}`)], { type: 'image/jpeg' }),
    filename
  );
  return fd;
}

// Mirror of frontend precheckinGateUi helpers to verify UI contract against real API responses
function resolveAuthoritativeReservationFinancials(reservationData, folioData, options = {}) {
  const data = reservationData || {};
  const isCancelled = options.isCancelled ?? String(data.status || '').toUpperCase() === 'CANCELLED';
  const activePropId =
    options.activePropertyId !== undefined
      ? options.activePropertyId
      : data.property_id != null
      ? Number(data.property_id)
      : null;

  const authoritativeFinancials =
    folioData?.authoritative_financials ?? data?.authoritative_financials ?? null;

  const hasAuthoritativeTotal =
    authoritativeFinancials?.total_price !== null &&
    authoritativeFinancials?.total_price !== undefined &&
    Number.isFinite(Number(authoritativeFinancials.total_price));
  const hasAuthoritativePaid =
    authoritativeFinancials?.amount_paid !== null &&
    authoritativeFinancials?.amount_paid !== undefined &&
    Number.isFinite(Number(authoritativeFinancials.amount_paid));
  const hasAuthoritativeDeposit =
    authoritativeFinancials?.applied_deposit !== null &&
    authoritativeFinancials?.applied_deposit !== undefined &&
    Number.isFinite(Number(authoritativeFinancials.applied_deposit));
  const hasAuthoritativeRemaining =
    authoritativeFinancials?.remaining_balance !== null &&
    authoritativeFinancials?.remaining_balance !== undefined &&
    Number.isFinite(Number(authoritativeFinancials.remaining_balance));

  const totalPrice = hasAuthoritativeTotal
    ? Number(authoritativeFinancials.total_price)
    : Number(data.total_price || 0);
  const amountPaid = hasAuthoritativePaid
    ? Number(authoritativeFinancials.amount_paid)
    : Number(data.amount_paid || 0);
  const appliedDeposit = hasAuthoritativeDeposit
    ? Number(authoritativeFinancials.applied_deposit)
    : Number(data.applied_deposit || 0);
  const remainingBalance = hasAuthoritativeRemaining
    ? Math.max(0, Number(authoritativeFinancials.remaining_balance))
    : Math.max(0, Number(data.remaining_balance ?? Math.max(0, totalPrice - amountPaid - appliedDeposit)));

  const effectiveSettlement = amountPaid + appliedDeposit;
  const rawStatus = String(
    authoritativeFinancials?.payment_status || data.payment_status || ''
  ).trim().toUpperCase();
  const paymentStatus =
    remainingBalance <= 0.01 && (effectiveSettlement > 0 || rawStatus === 'PAID' || rawStatus === 'LUNAS')
      ? 'PAID'
      : effectiveSettlement > 0 || rawStatus === 'PARTIAL' || rawStatus === 'SEBAGIAN'
      ? 'PARTIAL'
      : 'UNPAID';

  const canShowPaymentForm = !isCancelled && remainingBalance > 0;
  const canManagePaymentEvidence = !isCancelled && Boolean(data.id && activePropId);

  return {
    totalPrice,
    amountPaid,
    appliedDeposit,
    remainingBalance,
    paymentStatus,
    canShowPaymentForm,
    canManagePaymentEvidence,
  };
}

function isChecklistRequirementActionable(code, gates) {
  switch (code) {
    case 'PRIMARY_GUEST_NAME_MISSING':
    case 'PRIMARY_GUEST_PHONE_MISSING':
      return gates.canEditGuestData;
    case 'ROOM_NOT_READY':
    case 'IDENTITY_DOCUMENT_MISSING':
      return true;
    case 'PAYMENT_MISSING':
      return gates.canShowPaymentForm;
    case 'PAYMENT_EVIDENCE_MISSING':
      return gates.canManagePaymentEvidence;
    case 'GUARANTEE_MISSING':
      return gates.hasGuaranteeSection;
    default:
      return false;
  }
}

// ─── FIXTURE STATE ──────────────────────────────────────────────────────────
let testPropId;
let testCatId;
let testRoomTypeId;
let testRoomReadyId;
let testRoomDirtyId;
const createdBookingIds = [];
const createdReservationIds = [];
const createdGuestIds = [];

async function setupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rand = Math.floor(1000 + Math.random() * 9000);
    const propRes = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ($1, $2, 'Asia/Jakarta', 'IDR', 'Jl. Test Precheckin 1503', TRUE) RETURNING id`,
      [`Test Prop 1503 ${rand}`, `TP${rand}`]
    );
    testPropId = propRes.rows[0].id;

    const catRes = await client.query(
      `INSERT INTO room_categories (property_id, code, name, is_active)
       VALUES ($1, 'CAT-1503', 'Deluxe Category', TRUE) RETURNING id`,
      [testPropId]
    );
    testCatId = catRes.rows[0].id;

    const rtRes = await client.query(
      `INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity)
       VALUES ($1, $2, 'DLX-3', 'DELUXE TRIPLE', 610000, 3) RETURNING id`,
      [testPropId, testCatId]
    );
    testRoomTypeId = rtRes.rows[0].id;

    const rReady = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES ($1, $2, '204A', 'Room 204A', 'VACANT_CLEAN', TRUE) RETURNING id`,
      [testPropId, testRoomTypeId]
    );
    testRoomReadyId = rReady.rows[0].id;

    const rDirty = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES ($1, $2, '204B', 'Room 204B', 'VACANT_DIRTY', TRUE) RETURNING id`,
      [testPropId, testRoomTypeId]
    );
    testRoomDirtyId = rDirty.rows[0].id;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function createSeededReservation({
  guestName,
  guestPhone,
  hasIdentity = true,
  hasCustodyGuarantee = true,
  roomId = testRoomReadyId,
  subtotalAmount = 500000,
  discountAmount = 0,
  discountPercent = 0,
  checkIn = '2026-11-20',
  checkOut = '2026-11-21',
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const netRoom = Math.max(0, subtotalAmount - discountAmount);
    const bRes = await client.query(
      `INSERT INTO bookings (
         property_id, bid, guest_name_snapshot, booker_name, booker_phone,
         booking_status, booking_source, booking_channel, payment_responsibility
       ) VALUES ($1, $2, $3, $3, $4, 'ACTIVE', 'WALKIN', 'WALKIN_REGULER', 'HOTEL_COLLECT')
       RETURNING id`,
      [
        testPropId,
        `BID-1503-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        guestName,
        guestPhone,
      ]
    );
    const bookingId = bRes.rows[0].id;
    createdBookingIds.push(bookingId);

    const gRes = await client.query(
      `INSERT INTO guests (
         full_name, normalized_name, phone, normalized_phone,
         identity_type, identity_number, identity_storage_key, identity_path,
         has_valid_identity, created_property_id
       ) VALUES ($1, $2, $3, $4, 'KTP', $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        guestName,
        guestName.toLowerCase(),
        guestPhone,
        guestPhone ? guestPhone.replace(/\D/g, '') : null,
        hasIdentity ? '3507000000001503' : null,
        hasIdentity ? `id-docs/${testPropId}/test_ktp_1503.jpg` : null,
        hasIdentity ? `/api/guests/documents/test_ktp_1503.jpg` : null,
        Boolean(hasIdentity),
        testPropId,
      ]
    );
    const guestId = gRes.rows[0].id;
    createdGuestIds.push(guestId);

    const rRes = await client.query(
      `INSERT INTO reservations (
         booking_id, room_id, guest_name, guest_phone, check_in, check_out,
         subtotal_amount, discount_amount, discount_percent,
         total_price, amount_paid, applied_deposit, remaining_balance,
         status, stay_status, payment_status, stay_sequence,
         booked_room_type_id_snapshot, booked_room_type_name_snapshot,
         has_valid_identity
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9,
         $10, 0, 0, $10,
         'BOOKED', 'BOOKED', 'UNPAID', 1,
         $11, 'DELUXE TRIPLE',
         $12
       ) RETURNING id`,
      [
        bookingId,
        roomId,
        guestName,
        guestPhone,
        checkIn,
        checkOut,
        subtotalAmount,
        discountAmount,
        discountPercent,
        netRoom,
        testRoomTypeId,
        Boolean(hasIdentity),
      ]
    );
    const reservationId = rRes.rows[0].id;
    createdReservationIds.push(reservationId);

    await client.query(
      `INSERT INTO reservation_guests (reservation_id, guest_id, role, relation_source)
       VALUES ($1, $2, 'PRIMARY_GUEST', 'CANONICAL_DIRECT')`,
      [reservationId, guestId]
    );

    // Canonical ROOM_CHARGE folio entry
    await client.query(
      `INSERT INTO folio_entries (
         reservation_id, property_id, entry_type, source_type, description,
         amount, direction, status, is_voided
       ) VALUES ($1, $2, 'ROOM_CHARGE', 'ROOM_CHARGE', 'Harga Kamar DELUXE TRIPLE (1 malam)', $3, 'DEBIT', 'POSTED', FALSE)`,
      [reservationId, testPropId, subtotalAmount]
    );

    if (discountAmount > 0) {
      await client.query(
        `INSERT INTO folio_entries (
           reservation_id, property_id, entry_type, source_type, description,
           amount, direction, status, is_voided
         ) VALUES ($1, $2, 'DISCOUNT', 'DISCOUNT', 'Diskon Keseluruhan: Corp 10%', $3, 'CREDIT', 'POSTED', FALSE)`,
        [reservationId, testPropId, discountAmount]
      );
    }

    if (hasCustodyGuarantee) {
      await client.query(
        `INSERT INTO identity_custody (
           property_id, reservation_id, booking_id, scope,
           document_holder_name, document_type, status, received_by
         ) VALUES ($1, $2, $3, 'ROOM_RESERVATION', $4, 'KTP', 'HELD', 'FO Test')`,
        [testPropId, reservationId, bookingId, guestName]
      );
    }

    await client.query('COMMIT');
    return { bookingId, reservationId, guestId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function cleanupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (createdReservationIds.length > 0) {
      await client.query('DELETE FROM identity_custody WHERE reservation_id = ANY($1::int[])', [createdReservationIds]);
      await client.query('DELETE FROM payment_evidences WHERE reservation_id = ANY($1::int[])', [createdReservationIds]);
      await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [createdReservationIds]);
      await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [createdReservationIds]);
      await client.query('DELETE FROM reservation_guests WHERE reservation_id = ANY($1::int[])', [createdReservationIds]);
      await client.query('DELETE FROM audit_logs WHERE property_id = $1', [testPropId]);
      await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [createdReservationIds]);
    }
    if (createdGuestIds.length > 0) {
      await client.query('DELETE FROM guests WHERE id = ANY($1::int[])', [createdGuestIds]);
    }
    if (createdBookingIds.length > 0) {
      await client.query('DELETE FROM bookings WHERE id = ANY($1::int[])', [createdBookingIds]);
    }
    const staleProps = await client.query(
      `SELECT id FROM properties WHERE id = $1 OR name LIKE 'Test Prop 1503%' OR name LIKE 'Folio Prop %'`,
      [testPropId || 0]
    );
    const propIds = staleProps.rows.map((r) => Number(r.id));
    if (propIds.length > 0) {
      const subResSql = `SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = ANY($1::int[]))`;
      await client.query(`DELETE FROM identity_custody WHERE property_id = ANY($1::int[]) OR reservation_id IN (${subResSql})`, [propIds]);
      await client.query(`DELETE FROM payment_evidences WHERE property_id = ANY($1::int[]) OR reservation_id IN (${subResSql})`, [propIds]);
      await client.query(`DELETE FROM payment_transactions WHERE property_id = ANY($1::int[]) OR reservation_id IN (${subResSql})`, [propIds]);
      await client.query(`DELETE FROM folio_entries WHERE property_id = ANY($1::int[]) OR reservation_id IN (${subResSql})`, [propIds]);
      await client.query(`DELETE FROM reservation_guests WHERE reservation_id IN (${subResSql})`, [propIds]);
      await client.query('DELETE FROM audit_logs WHERE property_id = ANY($1::int[])', [propIds]);
      await client.query(`DELETE FROM reservations WHERE id IN (${subResSql})`, [propIds]);
      await client.query('DELETE FROM bookings WHERE property_id = ANY($1::int[])', [propIds]);
      await client.query('DELETE FROM property_housekeeping_settings WHERE property_id = ANY($1::int[])', [propIds]);
      await client.query('DELETE FROM rooms WHERE property_id = ANY($1::int[])', [propIds]);
      await client.query('DELETE FROM room_types WHERE property_id = ANY($1::int[])', [propIds]);
      await client.query('DELETE FROM room_categories WHERE property_id = ANY($1::int[])', [propIds]);
      await client.query('DELETE FROM properties WHERE id = ANY($1::int[])', [propIds]);
    }
    await client.query('COMMIT');

    const storageDir = path.resolve(__dirname, '..', 'storage', 'payment-evidence', String(testPropId));
    if (testPropId && fs.existsSync(storageDir)) {
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Cleanup error:', err);
  } finally {
    client.release();
  }
}

async function runTests() {
  await setupFixtures();

  server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = 'http://127.0.0.1:' + server.address().port;

  const userRes = await pool.query(
    `SELECT u.id, u.username, u.full_name, u.role_id
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.is_active = TRUE AND (r.name = 'Super Admin' OR u.role_id = 1)
     ORDER BY u.id LIMIT 1`
  );
  const user = userRes.rows[0];
  authToken =
    'Bearer ' +
    generateToken({
      id: user.id,
      email: '',
      username: user.username,
      full_name: user.full_name,
      role: 'Super Admin',
      role_id: user.role_id,
      property_id: testPropId,
      scope: 'FULL',
    });

  try {
    // =========================================================================
    // SCENARIO 1: Full payment + valid evidence satisfies payment & evidence
    // =========================================================================
    console.log('\n--- Scenario 1: Full payment + valid evidence satisfies payment & evidence ---');
    const s1 = await createSeededReservation({
      guestName: 'S1 Full Paid Guest',
      guestPhone: '081111111101',
      subtotalAmount: 500000,
    });

    const payS1 = await api(
      'POST',
      `/api/reservations/${s1.reservationId}/payments`,
      buildMultipartPayment({ propertyId: testPropId, amount: 500000, paymentMethod: 'CASH' })
    );
    expect(payS1.status === 200, 'S1.1: Full payment with evidence returns 200');

    const [detailS1, folioS1] = await Promise.all([
      api('GET', `/api/reservations/${s1.reservationId}?property_id=${testPropId}`),
      api('GET', `/api/reservations/${s1.reservationId}/folio?property_id=${testPropId}`),
    ]);
    const peS1 = detailS1.json?.data?.precheckin_eligibility;
    const uiFinS1 = resolveAuthoritativeReservationFinancials(detailS1.json?.data, folioS1.json?.data, {
      activePropertyId: testPropId,
    });

    expect(peS1?.payment_ok === true, 'S1.2: precheckin_eligibility.payment_ok is true');
    expect(peS1?.payment_evidence_ok === true, 'S1.3: precheckin_eligibility.payment_evidence_ok is true');
    expect(peS1?.eligible === true, 'S1.4: precheckin_eligibility.eligible is true when all gates met');
    expect(
      !peS1?.missing?.some((m) => m.code === 'PAYMENT_MISSING' || m.code === 'PAYMENT_EVIDENCE_MISSING'),
      'S1.5: Neither PAYMENT_MISSING nor PAYMENT_EVIDENCE_MISSING is present'
    );
    expect(
      uiFinS1.totalPrice === 500000 && uiFinS1.amountPaid === 500000 && uiFinS1.remainingBalance === 0 && uiFinS1.paymentStatus === 'PAID',
      'S1.6: UI financial summary matches canonical PAID state (500,000 / 500,000 / 0)'
    );

    // =========================================================================
    // SCENARIO 2: Full payment without evidence still requires evidence, and
    //             upload action remains available even when remaining_balance == 0
    // =========================================================================
    console.log('\n--- Scenario 2: Full payment without evidence requires evidence; upload action available when balance == 0 ---');
    const s2 = await createSeededReservation({
      guestName: 'S2 Full Paid No Proof',
      guestPhone: '081111111102',
      subtotalAmount: 450000,
    });

    const corePayS2 = await createPaymentCore(pool, {
      propertyId: testPropId,
      reservationId: s2.reservationId,
      amount: 450000,
      paymentMethod: 'TRANSFER',
      transactionType: 'PAYMENT',
      requireEvidence: false,
    });
    expect(corePayS2.payment?.id > 0, 'S2.1: Full payment recorded without evidence');

    const [detailS2, folioS2] = await Promise.all([
      api('GET', `/api/reservations/${s2.reservationId}?property_id=${testPropId}`),
      api('GET', `/api/reservations/${s2.reservationId}/folio?property_id=${testPropId}`),
    ]);
    const peS2 = detailS2.json?.data?.precheckin_eligibility;
    const uiFinS2 = resolveAuthoritativeReservationFinancials(detailS2.json?.data, folioS2.json?.data, {
      activePropertyId: testPropId,
    });

    expect(peS2?.payment_ok === true, 'S2.2: payment_ok is true for full payment without evidence');
    expect(peS2?.payment_evidence_ok === false, 'S2.3: payment_evidence_ok is false when evidence is missing');
    expect(peS2?.eligible === false, 'S2.4: eligible is false (blocked by missing evidence)');
    expect(
      peS2?.missing?.some((m) => m.code === 'PAYMENT_EVIDENCE_MISSING') &&
        !peS2?.missing?.some((m) => m.code === 'PAYMENT_MISSING'),
      'S2.5: Only PAYMENT_EVIDENCE_MISSING is reported (not PAYMENT_MISSING)'
    );
    expect(uiFinS2.remainingBalance === 0, 'S2.6: remainingBalance is 0');
    expect(uiFinS2.canShowPaymentForm === false, 'S2.7: canShowPaymentForm is false when remainingBalance == 0');
    expect(uiFinS2.canManagePaymentEvidence === true, 'S2.8: canManagePaymentEvidence is true even when remainingBalance == 0');
    expect(
      isChecklistRequirementActionable('PAYMENT_EVIDENCE_MISSING', {
        canShowPaymentForm: uiFinS2.canShowPaymentForm,
        canManagePaymentEvidence: uiFinS2.canManagePaymentEvidence,
        hasGuaranteeSection: true,
        canEditGuestData: true,
      }) === true,
      'S2.9: PAYMENT_EVIDENCE_MISSING "Upload Bukti" action button is ENABLED when remainingBalance == 0'
    );

    // =========================================================================
    // SCENARIO 3: Partial payment & exact #1503 reproduction (Room 610k - Disc 61k
    //             + POS 150k = 699k, phone PATCH, 638k paid with evidence)
    // =========================================================================
    console.log('\n--- Scenario 3: Partial payment & #1503 reproduction shows exact remaining balance and preserves evidence ---');
    const s3 = await createSeededReservation({
      guestName: 'ELLI ROH ITA TEST',
      guestPhone: '081111111103',
      subtotalAmount: 610000,
      discountAmount: 61000,
      discountPercent: 10,
    });

    // Post POS order charge of 150,000 to folio and recalculate financials (total becomes 699,000)
    await pool.query(
      `INSERT INTO folio_entries (
         reservation_id, property_id, entry_type, source_type, description,
         amount, direction, status, is_voided
       ) VALUES ($1, $2, 'FNB_POS', 'POS_ORDER', 'POS-000127 - Paket DINNER (3)', 150000, 'DEBIT', 'POSTED', FALSE)`,
      [s3.reservationId, testPropId]
    );
    await recalculateReservationFinancials(pool, s3.reservationId, testPropId);

    // Patch guest_phone via PATCH /api/reservations/:id (previously triggered double-discount 699k -> 638k)
    const patchPhoneRes = await api('PATCH', `/api/reservations/${s3.reservationId}`, {
      property_id: testPropId,
      guest_phone: '081111119999',
    });
    expect(patchPhoneRes.status === 200, 'S3.1: Metadata phone PATCH returns 200');

    const afterPatchRow = await pool.query('SELECT total_price, discount_amount, remaining_balance FROM reservations WHERE id = $1', [
      s3.reservationId,
    ]);
    expect(
      Number(afterPatchRow.rows[0].total_price) === 699000,
      'S3.2: Metadata phone PATCH preserves canonical total_price = 699,000 (no double-discount to 638,000)',
      afterPatchRow.rows[0]
    );

    // Also verify metadata guest_segment PATCH preserves canonical total_price = 699,000
    const patchSegRes = await api('PATCH', `/api/reservations/${s3.reservationId}`, {
      property_id: testPropId,
      guest_segment: 'Corporate',
    });
    expect(patchSegRes.status === 200, 'S3.2b: Metadata guest_segment PATCH returns 200', patchSegRes.json);
    const afterNamePatchRow = await pool.query('SELECT total_price, discount_amount, remaining_balance FROM reservations WHERE id = $1', [
      s3.reservationId,
    ]);
    expect(
      Number(afterNamePatchRow.rows[0].total_price) === 699000 && Number(afterNamePatchRow.rows[0].remaining_balance) === 699000,
      'S3.2c: Metadata guest_segment PATCH preserves canonical total_price = 699,000 and remaining_balance = 699,000'
    );

    // Record partial payment of 638,000 WITH valid evidence
    const payS3Partial = await api(
      'POST',
      `/api/reservations/${s3.reservationId}/payments`,
      buildMultipartPayment({ propertyId: testPropId, amount: 638000, paymentMethod: 'CASH' })
    );
    expect(payS3Partial.status === 200, 'S3.3: Partial payment of 638,000 with evidence returns 200');

    // Also test that even if reservations.total_price was historically corrupted to 638,000 in DB (like #1503 in prod),
    // GET /api/reservations/:id and GET /api/reservations/:id/folio return canonical 699,000 / remaining 61,000 / PARTIAL
    await pool.query(
      `UPDATE reservations SET total_price = 638000, remaining_balance = 0, payment_status = 'PAID' WHERE id = $1`,
      [s3.reservationId]
    );

    const [detailS3, folioS3] = await Promise.all([
      api('GET', `/api/reservations/${s3.reservationId}?property_id=${testPropId}`),
      api('GET', `/api/reservations/${s3.reservationId}/folio?property_id=${testPropId}`),
    ]);
    const peS3 = detailS3.json?.data?.precheckin_eligibility;
    const uiFinS3 = resolveAuthoritativeReservationFinancials(detailS3.json?.data, folioS3.json?.data, {
      activePropertyId: testPropId,
    });

    expect(
      uiFinS3.totalPrice === 699000 && uiFinS3.amountPaid === 638000 && uiFinS3.remainingBalance === 61000 && uiFinS3.paymentStatus === 'PARTIAL',
      'S3.4: UI authoritative financials show Total 699,000 / Paid 638,000 / Remaining 61,000 / PARTIAL',
      uiFinS3
    );
    expect(uiFinS3.canShowPaymentForm === true, 'S3.5: canShowPaymentForm is true so FO can pay remaining Rp 61,000');
    expect(peS3?.payment_ok === false, 'S3.6: precheckin_eligibility.payment_ok is false (Rp 61,000 still unpaid)');
    expect(
      peS3?.payment_evidence_ok === true,
      'S3.7: precheckin_eligibility.payment_evidence_ok is TRUE (existing Rp 638,000 payment already has valid active evidence)'
    );
    expect(
      peS3?.missing?.some((m) => m.code === 'PAYMENT_MISSING') &&
        !peS3?.missing?.some((m) => m.code === 'PAYMENT_EVIDENCE_MISSING'),
      'S3.8: Checklist reports PAYMENT_MISSING only, NOT false PAYMENT_EVIDENCE_MISSING'
    );
    expect(
      isChecklistRequirementActionable('PAYMENT_MISSING', {
        canShowPaymentForm: uiFinS3.canShowPaymentForm,
        canManagePaymentEvidence: uiFinS3.canManagePaymentEvidence,
        hasGuaranteeSection: true,
        canEditGuestData: true,
      }) === true,
      'S3.9: PAYMENT_MISSING "Catat Pembayaran" button is actionable'
    );

    // =========================================================================
    // SCENARIO 4: Immediate checklist update after uploading/replacing evidence
    //             or recording remaining payment (without manual refresh)
    // =========================================================================
    console.log('\n--- Scenario 4: Immediate checklist update after upload/replace evidence and remaining payment ---');
    // 4A: Upload evidence on S2 (where full payment had no evidence)
    const uploadS2 = await api(
      'POST',
      `/api/reservations/${s2.reservationId}/payments/${corePayS2.payment.id}/evidences`,
      buildMultipartEvidence({ propertyId: testPropId, evidenceType: 'BANK_TRANSFER', filename: 's2_proof_1.jpg' })
    );
    expect(uploadS2.status === 200 || uploadS2.status === 201, 'S4.1: Uploading evidence to existing full payment succeeds');
    const uploadedEvId = uploadS2.json?.data?.evidence?.id;

    // Immediate refetch (same sequence as handleUploadEvidence in ReservationDetailDrawer)
    const [folioS2AfterUpload, detailS2AfterUpload] = await Promise.all([
      api('GET', `/api/reservations/${s2.reservationId}/folio?property_id=${testPropId}`),
      api('GET', `/api/reservations/${s2.reservationId}?property_id=${testPropId}`),
    ]);
    const peS2AfterUpload = detailS2AfterUpload.json?.data?.precheckin_eligibility;
    expect(peS2AfterUpload?.payment_evidence_ok === true, 'S4.2: payment_evidence_ok immediately updates to true after upload');
    expect(peS2AfterUpload?.eligible === true, 'S4.3: S2 immediately becomes eligible === true without manual refresh');
    expect(
      (peS2AfterUpload?.missing?.length ?? -1) === 0,
      'S4.4: S2 missing requirements list is immediately empty'
    );

    // 4B: Replace evidence on S2
    const replaceS2 = await api(
      'POST',
      `/api/reservations/${s2.reservationId}/payments/${corePayS2.payment.id}/evidences/${uploadedEvId}/replace`,
      buildMultipartEvidence({ propertyId: testPropId, evidenceType: 'BANK_TRANSFER', filename: 's2_proof_replaced.jpg' })
    );
    expect(replaceS2.status === 200, 'S4.5: Replacing evidence succeeds');
    const detailS2AfterReplace = await api('GET', `/api/reservations/${s2.reservationId}?property_id=${testPropId}`);
    expect(
      detailS2AfterReplace.json?.data?.precheckin_eligibility?.payment_evidence_ok === true &&
        detailS2AfterReplace.json?.data?.precheckin_eligibility?.eligible === true,
      'S4.6: Checklist remains eligible === true immediately after evidence replacement'
    );

    // 4C: Record remaining Rp 61,000 payment on S3 (#1503 reproduction, even when DB row had stale 638,000)
    const payS3Remaining = await api(
      'POST',
      `/api/reservations/${s3.reservationId}/payments`,
      buildMultipartPayment({ propertyId: testPropId, amount: 61000, paymentMethod: 'CASH', filename: 's3_remaining_61k.jpg' })
    );
    expect(
      payS3Remaining.status === 200,
      'S4.7: Recording remaining Rp 61,000 payment succeeds (not blocked by stale persisted total_price)'
    );

    const [detailS3AfterPay, folioS3AfterPay] = await Promise.all([
      api('GET', `/api/reservations/${s3.reservationId}?property_id=${testPropId}`),
      api('GET', `/api/reservations/${s3.reservationId}/folio?property_id=${testPropId}`),
    ]);
    const peS3AfterPay = detailS3AfterPay.json?.data?.precheckin_eligibility;
    const uiFinS3AfterPay = resolveAuthoritativeReservationFinancials(
      detailS3AfterPay.json?.data,
      folioS3AfterPay.json?.data,
      { activePropertyId: testPropId }
    );
    expect(
      uiFinS3AfterPay.totalPrice === 699000 &&
        uiFinS3AfterPay.amountPaid === 699000 &&
        uiFinS3AfterPay.remainingBalance === 0 &&
        uiFinS3AfterPay.paymentStatus === 'PAID',
      'S4.8: S3 financials immediately update to 699,000 / 699,000 / 0 / PAID',
      uiFinS3AfterPay
    );
    expect(
      peS3AfterPay?.payment_ok === true && peS3AfterPay?.payment_evidence_ok === true && peS3AfterPay?.eligible === true,
      'S4.9: S3 checklist immediately updates to payment_ok=true, payment_evidence_ok=true, eligible=true'
    );

    // =========================================================================
    // SCENARIO 5: Other check-in requirements remain strictly enforced
    // =========================================================================
    console.log('\n--- Scenario 5: Other check-in requirements remain strictly enforced ---');
    const s5 = await createSeededReservation({
      guestName: 'S5 Missing Other Gates',
      guestPhone: '',
      hasIdentity: false,
      hasCustodyGuarantee: false,
      roomId: testRoomDirtyId,
      subtotalAmount: 400000,
    });

    // Pay S5 in full with valid evidence
    const payS5 = await api(
      'POST',
      `/api/reservations/${s5.reservationId}/payments`,
      buildMultipartPayment({ propertyId: testPropId, amount: 400000, paymentMethod: 'QRIS' })
    );
    expect(payS5.status === 200, 'S5.1: S5 full payment with evidence succeeds');

    const detailS5 = await api('GET', `/api/reservations/${s5.reservationId}?property_id=${testPropId}`);
    const peS5 = detailS5.json?.data?.precheckin_eligibility;
    expect(peS5?.payment_ok === true && peS5?.payment_evidence_ok === true, 'S5.2: Payment & evidence gates pass on S5');
    expect(peS5?.eligible === false, 'S5.3: eligible is strictly false when non-payment gates are unmet');
    expect(peS5?.guest_phone_ok === false, 'S5.4: guest_phone_ok is false');
    expect(peS5?.identity_ok === false, 'S5.5: identity_ok is false');
    expect(peS5?.guarantee_ok === false, 'S5.6: guarantee_ok is false');
    expect(peS5?.room_ready_ok === false, 'S5.7: room_ready_ok is false (VACANT_DIRTY)');
    const missingCodesS5 = (peS5?.missing || []).map((m) => m.code);
    expect(
      missingCodesS5.includes('PRIMARY_GUEST_PHONE_MISSING') &&
        missingCodesS5.includes('IDENTITY_DOCUMENT_MISSING') &&
        missingCodesS5.includes('GUARANTEE_MISSING') &&
        missingCodesS5.includes('ROOM_NOT_READY'),
      'S5.8: All 4 non-payment missing codes are enforced in precheckin_eligibility.missing',
      missingCodesS5
    );

    // Attempt backend check-in on S5 -> must be rejected by backend check-in gate
    const checkinAttemptS5 = await api('POST', `/api/reservations/${s5.reservationId}/checkin`, {
      property_id: testPropId,
    });
    expect(
      checkinAttemptS5.status === 400 && checkinAttemptS5.json?.code === 'CHECKIN_REQUIREMENTS_NOT_MET',
      'S5.9: Backend POST /api/reservations/:id/checkin rejects ineligible reservation with 400 CHECKIN_REQUIREMENTS_NOT_MET',
      { status: checkinAttemptS5.status, code: checkinAttemptS5.json?.code }
    );

    // =========================================================================
    // SCENARIO 6: Consistent Financial Authority Matrix
    //   6A: Canonical total > snapshot total_price (overpayment guard + 3-way sync)
    //   6B: Canonical total == snapshot total_price, amount_paid stored TOO HIGH
    //   6C: Canonical total == snapshot total_price, amount_paid stored TOO LOW
    //   6D: Canonical total < snapshot total_price
    //   6E: Payment Void (POST /api/reservations/:id/payments/:paymentId/void)
    //   6F: Applied Deposit (DEPOSIT_APPLY / applied_deposit)
    // =========================================================================
    console.log('\n--- Scenario 6: Consistent Financial Authority Matrix (>, == with stale paid high/low, <, void, applied deposit) ---');

    async function assertThreeWayFinancialSync(resId, expected, label) {
      const [detRes, folRes] = await Promise.all([
        api('GET', `/api/reservations/${resId}?property_id=${testPropId}`),
        api('GET', `/api/reservations/${resId}/folio?property_id=${testPropId}`),
      ]);
      const d = detRes.json?.data || {};
      const f = folRes.json?.data || {};
      const fRes = f.reservation || {};
      const dAuth = d.authoritative_financials || {};
      const fAuth = f.authoritative_financials || {};
      const pe = d.precheckin_eligibility || {};
      const uiFin = resolveAuthoritativeReservationFinancials(d, f, { activePropertyId: testPropId });

      const expDep = expected.appliedDeposit ?? 0;
      const detailMatch =
        Number(d.total_price) === expected.totalPrice &&
        Number(d.amount_paid) === expected.amountPaid &&
        Number(d.applied_deposit) === expDep &&
        Number(d.remaining_balance) === expected.remainingBalance &&
        String(d.payment_status) === expected.paymentStatus &&
        Number(dAuth.total_price) === expected.totalPrice &&
        Number(dAuth.amount_paid) === expected.amountPaid &&
        Number(dAuth.applied_deposit) === expDep &&
        Number(dAuth.remaining_balance) === expected.remainingBalance &&
        String(dAuth.payment_status) === expected.paymentStatus;

      const folioMatch =
        Number(fRes.total_price) === expected.totalPrice &&
        Number(fRes.amount_paid) === expected.amountPaid &&
        Number(fRes.applied_deposit) === expDep &&
        Number(fRes.remaining_balance) === expected.remainingBalance &&
        String(fRes.payment_status) === expected.paymentStatus &&
        Number(fAuth.total_price) === expected.totalPrice &&
        Number(fAuth.amount_paid) === expected.amountPaid &&
        Number(fAuth.applied_deposit) === expDep &&
        Number(fAuth.remaining_balance) === expected.remainingBalance &&
        String(fAuth.payment_status) === expected.paymentStatus;

      const uiMatch =
        uiFin.totalPrice === expected.totalPrice &&
        uiFin.amountPaid === expected.amountPaid &&
        uiFin.appliedDeposit === expDep &&
        uiFin.remainingBalance === expected.remainingBalance &&
        uiFin.paymentStatus === expected.paymentStatus;

      const gateMatch =
        pe.payment_ok === expected.paymentOk &&
        pe.payment_evidence_ok === expected.paymentEvidenceOk &&
        (expected.eligible === undefined || pe.eligible === expected.eligible);

      expect(
        detailMatch && folioMatch && uiMatch && gateMatch,
        `${label}: Detail, Folio, UI resolver, and Pre-Checkin Checklist all match (${expected.totalPrice} / paid=${expected.amountPaid} / dep=${expDep} / rem=${expected.remainingBalance} / ${expected.paymentStatus} / payOk=${expected.paymentOk} / evOk=${expected.paymentEvidenceOk})`,
        {
          detailTop: {
            total: Number(d.total_price),
            paid: Number(d.amount_paid),
            dep: Number(d.applied_deposit),
            rem: Number(d.remaining_balance),
            status: d.payment_status,
          },
          folioTop: {
            total: Number(fRes.total_price),
            paid: Number(fRes.amount_paid),
            dep: Number(fRes.applied_deposit),
            rem: Number(fRes.remaining_balance),
            status: fRes.payment_status,
          },
          uiFin,
          gates: {
            payment_ok: pe.payment_ok,
            payment_evidence_ok: pe.payment_evidence_ok,
            eligible: pe.eligible,
            missing: (pe.missing || []).map((m) => m.code),
          },
        }
      );
      return { detRes, folRes, pe, uiFin };
    }

    // --- 6A: Canonical total (700,000) > snapshot total_price (550,000) ---
    const s6a = await createSeededReservation({
      guestName: 'S6A Canonical Greater',
      guestPhone: '081111111601',
      subtotalAmount: 550000,
    });
    await pool.query(
      `INSERT INTO folio_entries (
         reservation_id, property_id, entry_type, source_type, description,
         amount, direction, status, is_voided
       ) VALUES ($1, $2, 'FNB_POS', 'POS_ORDER', 'POS Extra Dinner', 150000, 'DEBIT', 'POSTED', FALSE)`,
      [s6a.reservationId, testPropId]
    );
    // Keep reservations.total_price stale at 550,000 while canonical is 700,000
    await assertThreeWayFinancialSync(
      s6a.reservationId,
      {
        totalPrice: 700000,
        amountPaid: 0,
        appliedDeposit: 0,
        remainingBalance: 700000,
        paymentStatus: 'UNPAID',
        paymentOk: false,
        paymentEvidenceOk: false,
        eligible: false,
      },
      'S6A.1 (canonical 700k > snapshot 550k)'
    );
    const overpay6a = await api(
      'POST',
      `/api/reservations/${s6a.reservationId}/payments`,
      buildMultipartPayment({ propertyId: testPropId, amount: 750000, paymentMethod: 'CASH' })
    );
    expect(
      overpay6a.status === 400 && overpay6a.json?.code === 'OVERPAYMENT_NOT_ALLOWED',
      'S6A.2: Overpayment above canonical 700,000 is rejected with 400 OVERPAYMENT_NOT_ALLOWED',
      overpay6a.json
    );
    const validPay6a = await api(
      'POST',
      `/api/reservations/${s6a.reservationId}/payments`,
      buildMultipartPayment({ propertyId: testPropId, amount: 700000, paymentMethod: 'CASH' })
    );
    expect(validPay6a.status === 200, 'S6A.3: Valid full payment of canonical 700,000 succeeds');
    await assertThreeWayFinancialSync(
      s6a.reservationId,
      {
        totalPrice: 700000,
        amountPaid: 700000,
        appliedDeposit: 0,
        remainingBalance: 0,
        paymentStatus: 'PAID',
        paymentOk: true,
        paymentEvidenceOk: true,
        eligible: true,
      },
      'S6A.4 (after 700k payment)'
    );

    // --- 6B: Canonical total == snapshot total_price (600,000), amount_paid stored TOO HIGH ---
    const s6b = await createSeededReservation({
      guestName: 'S6B Equal Total Paid Too High',
      guestPhone: '081111111602',
      subtotalAmount: 600000,
    });
    // Subcase 6B-0: No canonical payment exists yet, but snapshot amount_paid is corrupted to 600,000 (PAID)
    await pool.query(
      `UPDATE reservations SET amount_paid = 600000, remaining_balance = 0, payment_status = 'PAID' WHERE id = $1`,
      [s6b.reservationId]
    );
    await assertThreeWayFinancialSync(
      s6b.reservationId,
      {
        totalPrice: 600000,
        amountPaid: 0,
        appliedDeposit: 0,
        remainingBalance: 600000,
        paymentStatus: 'UNPAID',
        paymentOk: false,
        paymentEvidenceOk: false,
        eligible: false,
      },
      'S6B.1 (canonical == snapshot 600k, 0 canonical payments, snapshot amount_paid corrupted to 600k)'
    );

    // Record valid partial payment of 200,000 with evidence
    const pay6bPart = await api(
      'POST',
      `/api/reservations/${s6b.reservationId}/payments`,
      buildMultipartPayment({ propertyId: testPropId, amount: 200000, paymentMethod: 'CASH' })
    );
    expect(pay6bPart.status === 200, 'S6B.2: Partial payment of 200,000 with evidence succeeds');

    // Corrupt snapshot amount_paid to 500,000 (too high) while total_price == 600,000
    await pool.query(
      `UPDATE reservations SET total_price = 600000, amount_paid = 500000, remaining_balance = 100000, payment_status = 'PARTIAL' WHERE id = $1`,
      [s6b.reservationId]
    );
    await assertThreeWayFinancialSync(
      s6b.reservationId,
      {
        totalPrice: 600000,
        amountPaid: 200000,
        appliedDeposit: 0,
        remainingBalance: 400000,
        paymentStatus: 'PARTIAL',
        paymentOk: false,
        paymentEvidenceOk: true,
        eligible: false,
      },
      'S6B.3 (canonical == snapshot 600k, snapshot amount_paid stored too high at 500k vs canonical 200k)'
    );

    // Overpayment of 450,000 (above canonical remaining 400,000) must be rejected with zero DB writes
    const pmtCountBefore6b = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM payment_transactions WHERE reservation_id = $1',
      [s6b.reservationId]
    );
    const overpay6b = await api(
      'POST',
      `/api/reservations/${s6b.reservationId}/payments`,
      buildMultipartPayment({ propertyId: testPropId, amount: 450000, paymentMethod: 'CASH' })
    );
    const pmtCountAfter6b = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM payment_transactions WHERE reservation_id = $1',
      [s6b.reservationId]
    );
    expect(
      overpay6b.status === 400 &&
        overpay6b.json?.code === 'OVERPAYMENT_NOT_ALLOWED' &&
        Number(overpay6b.json?.details?.remaining_balance) === 400000 &&
        pmtCountAfter6b.rows[0].cnt === pmtCountBefore6b.rows[0].cnt,
      'S6B.4: Overpayment of 450,000 rejected with 400 OVERPAYMENT_NOT_ALLOWED (canonical remaining 400,000) and zero DB writes',
      overpay6b.json
    );

    // Valid payment of 400,000 (which would have been rejected as > 100,000 if stale snapshot were used!) must succeed
    const validPay6bRem = await api(
      'POST',
      `/api/reservations/${s6b.reservationId}/payments`,
      buildMultipartPayment({ propertyId: testPropId, amount: 400000, paymentMethod: 'CASH' })
    );
    expect(
      validPay6bRem.status === 200,
      'S6B.5: Valid remaining payment of 400,000 succeeds despite snapshot amount_paid having been stored too high at 500,000'
    );
    await assertThreeWayFinancialSync(
      s6b.reservationId,
      {
        totalPrice: 600000,
        amountPaid: 600000,
        appliedDeposit: 0,
        remainingBalance: 0,
        paymentStatus: 'PAID',
        paymentOk: true,
        paymentEvidenceOk: true,
        eligible: true,
      },
      'S6B.6 (settled 600k / 600k / 0 / PAID)'
    );

    // --- 6C: Canonical total == snapshot total_price (600,000), amount_paid stored TOO LOW ---
    const s6c = await createSeededReservation({
      guestName: 'S6C Equal Total Paid Too Low',
      guestPhone: '081111111603',
      subtotalAmount: 600000,
    });
    const pay6cPart1 = await api(
      'POST',
      `/api/reservations/${s6c.reservationId}/payments`,
      buildMultipartPayment({ propertyId: testPropId, amount: 400000, paymentMethod: 'TRANSFER' })
    );
    expect(pay6cPart1.status === 200, 'S6C.1: Initial payment of 400,000 with evidence succeeds');
    const pay6cPart1Id = pay6cPart1.json?.data?.payment?.id;

    // Corrupt snapshot amount_paid to 100,000 (too low, remaining_balance = 500,000) while total_price == 600,000
    await pool.query(
      `UPDATE reservations SET total_price = 600000, amount_paid = 100000, remaining_balance = 500000, payment_status = 'PARTIAL' WHERE id = $1`,
      [s6c.reservationId]
    );
    await assertThreeWayFinancialSync(
      s6c.reservationId,
      {
        totalPrice: 600000,
        amountPaid: 400000,
        appliedDeposit: 0,
        remainingBalance: 200000,
        paymentStatus: 'PARTIAL',
        paymentOk: false,
        paymentEvidenceOk: true,
        eligible: false,
      },
      'S6C.2 (canonical == snapshot 600k, snapshot amount_paid stored too low at 100k vs canonical 400k)'
    );

    // Attempt payment of 250,000 (which would have been accepted if stale remaining_balance=500,000 were used!)
    const pmtCountBefore6c = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM payment_transactions WHERE reservation_id = $1',
      [s6c.reservationId]
    );
    const overpay6c = await api(
      'POST',
      `/api/reservations/${s6c.reservationId}/payments`,
      buildMultipartPayment({ propertyId: testPropId, amount: 250000, paymentMethod: 'CASH' })
    );
    const pmtCountAfter6c = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM payment_transactions WHERE reservation_id = $1',
      [s6c.reservationId]
    );
    expect(
      overpay6c.status === 400 &&
        overpay6c.json?.code === 'OVERPAYMENT_NOT_ALLOWED' &&
        Number(overpay6c.json?.details?.remaining_balance) === 200000 &&
        Number(overpay6c.json?.details?.amount_paid) === 400000 &&
        pmtCountAfter6c.rows[0].cnt === pmtCountBefore6c.rows[0].cnt,
      'S6C.3: Overpayment of 250,000 rejected with 400 OVERPAYMENT_NOT_ALLOWED (canonical remaining 200,000) and zero DB writes',
      overpay6c.json
    );

    // Valid remaining payment of 200,000 succeeds
    const pay6cPart2 = await api(
      'POST',
      `/api/reservations/${s6c.reservationId}/payments`,
      buildMultipartPayment({ propertyId: testPropId, amount: 200000, paymentMethod: 'CASH' })
    );
    expect(pay6cPart2.status === 200, 'S6C.4: Valid remaining payment of 200,000 succeeds');
    const pay6cPart2Id = pay6cPart2.json?.data?.payment?.id;
    await assertThreeWayFinancialSync(
      s6c.reservationId,
      {
        totalPrice: 600000,
        amountPaid: 600000,
        appliedDeposit: 0,
        remainingBalance: 0,
        paymentStatus: 'PAID',
        paymentOk: true,
        paymentEvidenceOk: true,
        eligible: true,
      },
      'S6C.5 (settled 600k / 600k / 0 / PAID)'
    );

    // --- 6D: Canonical total (450,000) < snapshot total_price (600,000) ---
    const s6d = await createSeededReservation({
      guestName: 'S6D Canonical Less Than Snapshot',
      guestPhone: '081111111604',
      subtotalAmount: 600000,
      discountAmount: 150000,
      discountPercent: 25,
    });
    // Force snapshot reservations.total_price to be higher (600,000) than canonical (450,000)
    await pool.query(
      `UPDATE reservations SET total_price = 600000, remaining_balance = 600000, payment_status = 'UNPAID' WHERE id = $1`,
      [s6d.reservationId]
    );
    await assertThreeWayFinancialSync(
      s6d.reservationId,
      {
        totalPrice: 450000,
        amountPaid: 0,
        appliedDeposit: 0,
        remainingBalance: 450000,
        paymentStatus: 'UNPAID',
        paymentOk: false,
        paymentEvidenceOk: false,
        eligible: false,
      },
      'S6D.1 (canonical 450k < snapshot 600k)'
    );

    // Metadata PATCH when canonical < snapshot must synchronize persisted reservations.total_price to 450,000
    const patch6d = await api('PATCH', `/api/reservations/${s6d.reservationId}`, {
      property_id: testPropId,
      guest_phone: '081111119604',
    });
    expect(patch6d.status === 200, 'S6D.2: Metadata PATCH on canonical < snapshot reservation returns 200');
    const row6dAfterPatch = await pool.query(
      'SELECT total_price, remaining_balance, payment_status FROM reservations WHERE id = $1',
      [s6d.reservationId]
    );
    expect(
      Number(row6dAfterPatch.rows[0].total_price) === 450000 &&
        Number(row6dAfterPatch.rows[0].remaining_balance) === 450000,
      'S6D.3: Metadata PATCH synchronizes persisted total_price & remaining_balance to canonical 450,000',
      row6dAfterPatch.rows[0]
    );

    // Force snapshot total_price back to 600,000 and verify payment endpoint rejects 500,000 (> canonical 450,000)
    await pool.query(
      `UPDATE reservations SET total_price = 600000, remaining_balance = 600000 WHERE id = $1`,
      [s6d.reservationId]
    );
    const pmtCountBefore6d = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM payment_transactions WHERE reservation_id = $1',
      [s6d.reservationId]
    );
    const overpay6d = await api(
      'POST',
      `/api/reservations/${s6d.reservationId}/payments`,
      buildMultipartPayment({ propertyId: testPropId, amount: 500000, paymentMethod: 'CASH' })
    );
    const pmtCountAfter6d = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM payment_transactions WHERE reservation_id = $1',
      [s6d.reservationId]
    );
    expect(
      overpay6d.status === 400 &&
        overpay6d.json?.code === 'OVERPAYMENT_NOT_ALLOWED' &&
        Number(overpay6d.json?.details?.total_price) === 450000 &&
        Number(overpay6d.json?.details?.remaining_balance) === 450000 &&
        pmtCountAfter6d.rows[0].cnt === pmtCountBefore6d.rows[0].cnt,
      'S6D.4: Payment of 500,000 rejected with 400 OVERPAYMENT_NOT_ALLOWED (canonical total 450,000 < snapshot 600,000) and zero DB writes',
      overpay6d.json
    );

    const validPay6d = await api(
      'POST',
      `/api/reservations/${s6d.reservationId}/payments`,
      buildMultipartPayment({ propertyId: testPropId, amount: 450000, paymentMethod: 'CASH' })
    );
    expect(validPay6d.status === 200, 'S6D.5: Valid payment of canonical 450,000 succeeds');
    await assertThreeWayFinancialSync(
      s6d.reservationId,
      {
        totalPrice: 450000,
        amountPaid: 450000,
        appliedDeposit: 0,
        remainingBalance: 0,
        paymentStatus: 'PAID',
        paymentOk: true,
        paymentEvidenceOk: true,
        eligible: true,
      },
      'S6D.6 (settled 450k / 450k / 0 / PAID)'
    );

    // --- 6E: Payment Void (POST /api/reservations/:id/payments/:paymentId/void) ---
    // Void second payment (200,000) on S6C (leaving first payment 400,000 with active evidence)
    const void6cPart2 = await api(
      'POST',
      `/api/reservations/${s6c.reservationId}/payments/${pay6cPart2Id}/void`,
      {
        property_id: testPropId,
        reason_code: 'WRONG_AMOUNT',
        reason_text: 'Void partial 200k test',
      }
    );
    expect(void6cPart2.status === 200, 'S6E.1: Voiding 200,000 second payment on S6C returns 200');
    const sync6e1 = await assertThreeWayFinancialSync(
      s6c.reservationId,
      {
        totalPrice: 600000,
        amountPaid: 400000,
        appliedDeposit: 0,
        remainingBalance: 200000,
        paymentStatus: 'PARTIAL',
        paymentOk: false,
        paymentEvidenceOk: true,
        eligible: false,
      },
      'S6E.2 (after voiding 200k payment, 400k payment with evidence remains active)'
    );
    expect(
      sync6e1.pe.missing?.some((m) => m.code === 'PAYMENT_MISSING') &&
        !sync6e1.pe.missing?.some((m) => m.code === 'PAYMENT_EVIDENCE_MISSING'),
      'S6E.3: After voiding 1 of 2 payments, checklist reports PAYMENT_MISSING only (remaining 400k payment still has evidence)'
    );

    // Void first payment (400,000) on S6C (now 0 active payments remain)
    const void6cPart1 = await api(
      'POST',
      `/api/reservations/${s6c.reservationId}/payments/${pay6cPart1Id}/void`,
      {
        property_id: testPropId,
        reason_code: 'PAYMENT_CANCELLED',
        reason_text: 'Void first 400k test',
      }
    );
    expect(void6cPart1.status === 200, 'S6E.4: Voiding remaining 400,000 payment on S6C returns 200');
    const sync6e2 = await assertThreeWayFinancialSync(
      s6c.reservationId,
      {
        totalPrice: 600000,
        amountPaid: 0,
        appliedDeposit: 0,
        remainingBalance: 600000,
        paymentStatus: 'UNPAID',
        paymentOk: false,
        paymentEvidenceOk: false,
        eligible: false,
      },
      'S6E.5 (after voiding all payments, 600k / 0 / 600k / UNPAID)'
    );
    expect(
      sync6e2.pe.missing?.some((m) => m.code === 'PAYMENT_MISSING') &&
        sync6e2.pe.missing?.some((m) => m.code === 'PAYMENT_EVIDENCE_MISSING'),
      'S6E.6: After voiding all payments, checklist reports both PAYMENT_MISSING and PAYMENT_EVIDENCE_MISSING'
    );

    // --- 6F: Applied Deposit (DEPOSIT_APPLY / applied_deposit) ---
    const s6f = await createSeededReservation({
      guestName: 'S6F Applied Deposit Guest',
      guestPhone: '081111111606',
      subtotalAmount: 600000,
    });
    // Post canonical DEPOSIT_APPLY of 150,000 to folio_entries while leaving reservations.applied_deposit stale at 0
    await pool.query(
      `INSERT INTO folio_entries (
         reservation_id, property_id, entry_type, source_type, description,
         amount, direction, status, is_voided
       ) VALUES ($1, $2, 'DEPOSIT_APPLY', 'DEPOSIT', 'Applied Deposit Rp 150.000', 150000, 'CREDIT', 'POSTED', FALSE)`,
      [s6f.reservationId, testPropId]
    );
    await assertThreeWayFinancialSync(
      s6f.reservationId,
      {
        totalPrice: 600000,
        amountPaid: 0,
        appliedDeposit: 150000,
        remainingBalance: 450000,
        paymentStatus: 'PARTIAL',
        paymentOk: false,
        paymentEvidenceOk: false,
        eligible: false,
      },
      'S6F.1 (600k total with 150k DEPOSIT_APPLY -> remaining 450k PARTIAL)'
    );

    // Overpayment of 500,000 (exceeding 450,000 remaining after applied deposit) must be rejected
    const pmtCountBefore6f = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM payment_transactions WHERE reservation_id = $1',
      [s6f.reservationId]
    );
    const overpay6f = await api(
      'POST',
      `/api/reservations/${s6f.reservationId}/payments`,
      buildMultipartPayment({ propertyId: testPropId, amount: 500000, paymentMethod: 'CASH' })
    );
    const pmtCountAfter6f = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM payment_transactions WHERE reservation_id = $1',
      [s6f.reservationId]
    );
    expect(
      overpay6f.status === 400 &&
        overpay6f.json?.code === 'OVERPAYMENT_NOT_ALLOWED' &&
        Number(overpay6f.json?.details?.remaining_balance) === 450000 &&
        pmtCountAfter6f.rows[0].cnt === pmtCountBefore6f.rows[0].cnt,
      'S6F.2: Overpayment of 500,000 rejected when 150,000 deposit is applied (remaining 450,000) with zero DB writes',
      overpay6f.json
    );

    // Valid payment of 450,000 with evidence settles the reservation alongside the 150,000 applied deposit
    const validPay6f = await api(
      'POST',
      `/api/reservations/${s6f.reservationId}/payments`,
      buildMultipartPayment({ propertyId: testPropId, amount: 450000, paymentMethod: 'CASH' })
    );
    expect(validPay6f.status === 200, 'S6F.3: Valid payment of 450,000 alongside 150,000 applied deposit succeeds');
    await assertThreeWayFinancialSync(
      s6f.reservationId,
      {
        totalPrice: 600000,
        amountPaid: 450000,
        appliedDeposit: 150000,
        remainingBalance: 0,
        paymentStatus: 'PAID',
        paymentOk: true,
        paymentEvidenceOk: true,
        eligible: true,
      },
      'S6F.4 (settled 600k total = 450k paid + 150k applied_deposit, remaining 0, PAID, eligible=true)'
    );

    // =========================================================================
    // SCENARIO 7: Legacy/Fallback Payment Transition & Reconciliation Guard
    //   7A: Legacy Source 1 — Snapshot amount_paid (Rp 200,000) without ledger
    //   7B: Legacy Source 2 — Legacy folio PAYMENT (Rp 200,000) without payment_transactions
    //   7C: Modern reservation with corrupted snapshot amount_paid (Rp 200,000)
    //       still rejected as payment source and allowed to record canonical payment
    // =========================================================================
    console.log('\n--- Scenario 7: Legacy/Fallback Payment Transition & Pre-Write Reconciliation Guard ---');

    // --- 7A: Legacy Source 1 (Snapshot amount_paid = 200,000 on legacy reservation without ledger, chargeCount === 0) ---
    const s7a = await createSeededReservation({
      guestName: 'S7A Legacy Snapshot Payment Guest',
      guestPhone: '081111111701',
      subtotalAmount: 600000,
    });
    // Convert s7a into a true pre-folio legacy reservation (no folio_entries, no nightly_rates, snapshot total=600k, paid=200k)
    await pool.query('DELETE FROM folio_entries WHERE reservation_id = $1', [s7a.reservationId]);
    await pool.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = $1', [s7a.reservationId]);
    await pool.query(
      `UPDATE reservations
       SET total_price = 600000, amount_paid = 200000, applied_deposit = 0,
           remaining_balance = 400000, payment_status = 'PARTIAL'
       WHERE id = $1`,
      [s7a.reservationId]
    );

    // Initial read recognizes the Rp 200,000 legacy snapshot payment via fallback
    await assertThreeWayFinancialSync(
      s7a.reservationId,
      {
        totalPrice: 600000,
        amountPaid: 200000,
        appliedDeposit: 0,
        remainingBalance: 400000,
        paymentStatus: 'PARTIAL',
        paymentOk: false,
        paymentEvidenceOk: false,
        eligible: false,
      },
      'S7A.1 (initial read of legacy snapshot reservation: total 600k, paid 200k via LEGACY_SNAPSHOT_FALLBACK, remaining 400k)'
    );

    // Attempt to record new canonical payment of Rp 100,000 on un-reconciled legacy snapshot state
    const attempt7a = await api(
      'POST',
      `/api/reservations/${s7a.reservationId}/payments`,
      buildMultipartPayment({ propertyId: testPropId, amount: 100000, paymentMethod: 'CASH', filename: 's7a_new_100k.jpg' })
    );
    const countsAfter7aAttempt = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM payment_transactions WHERE reservation_id = $1) AS pt_cnt,
         (SELECT COUNT(*)::int FROM folio_entries WHERE reservation_id = $1) AS fe_cnt,
         (SELECT COUNT(*)::int FROM payment_evidences WHERE reservation_id = $1) AS pe_cnt`,
      [s7a.reservationId]
    );
    expect(
      attempt7a.status === 409 &&
        attempt7a.json?.code === 'LEGACY_PAYMENT_RECONCILIATION_REQUIRED' &&
        attempt7a.json?.details?.legacy_payment_source === 'LEGACY_SNAPSHOT_FALLBACK' &&
        Number(attempt7a.json?.details?.legacy_amount_paid) === 200000 &&
        Number(attempt7a.json?.details?.attempted_payment_amount) === 100000 &&
        countsAfter7aAttempt.rows[0].pt_cnt === 0 &&
        countsAfter7aAttempt.rows[0].fe_cnt === 0 &&
        countsAfter7aAttempt.rows[0].pe_cnt === 0,
      'S7A.2: Recording Rp 100,000 on un-reconciled legacy snapshot payment is rejected pre-write with 409 LEGACY_PAYMENT_RECONCILIATION_REQUIRED and zero DB writes',
      { status: attempt7a.status, body: attempt7a.json, dbCounts: countsAfter7aAttempt.rows[0] }
    );

    // Re-read after rejected transition: legacy Rp 200,000 payment is NOT lost
    await assertThreeWayFinancialSync(
      s7a.reservationId,
      {
        totalPrice: 600000,
        amountPaid: 200000,
        appliedDeposit: 0,
        remainingBalance: 400000,
        paymentStatus: 'PARTIAL',
        paymentOk: false,
        paymentEvidenceOk: false,
        eligible: false,
      },
      'S7A.3 (re-read after 409 rejection: legacy Rp 200,000 snapshot payment remains intact at paid 200k, remaining 400k)'
    );

    // Retry recording Rp 100,000 -> deterministically rejected again without state loss
    const retry7a = await api(
      'POST',
      `/api/reservations/${s7a.reservationId}/payments`,
      buildMultipartPayment({ propertyId: testPropId, amount: 100000, paymentMethod: 'QRIS', filename: 's7a_retry_100k.jpg' })
    );
    expect(
      retry7a.status === 409 && retry7a.json?.code === 'LEGACY_PAYMENT_RECONCILIATION_REQUIRED',
      'S7A.4: Retry on un-reconciled legacy snapshot reservation deterministically returns 409 LEGACY_PAYMENT_RECONCILIATION_REQUIRED'
    );

    // Explicit reconciliation of S7A legacy charge + Rp 200,000 payment into canonical ledger, followed by +Rp 100,000 payment
    await pool.query(
      `INSERT INTO folio_entries (
         reservation_id, property_id, entry_type, source_type, description,
         amount, direction, status, is_voided
       ) VALUES
         ($1, $2, 'ROOM_CHARGE', 'RESERVATION', 'Reconciled Room Charge', 600000, 'DEBIT', 'POSTED', FALSE),
         ($1, $2, 'PAYMENT', 'RECONCILIATION', 'Reconciled Legacy Payment', 200000, 'CREDIT', 'POSTED', FALSE)`,
      [s7a.reservationId, testPropId]
    );
    const recPt7a = await pool.query(
      `INSERT INTO payment_transactions (
         property_id, booking_id, reservation_id, transaction_type, amount,
         payment_method, reference_code, status, created_by, scope
       ) VALUES ($1, $2, $3, 'PAYMENT', 200000, 'CASH', 'RECON-7A-200K', 'SUCCESS', 'Reconciliation', 'ROOM_RESERVATION')
       RETURNING id`,
      [testPropId, s7a.bookingId, s7a.reservationId]
    );
    await pool.query(
      `INSERT INTO payment_evidences (
         property_id, reservation_id, payment_transaction_id, evidence_type,
         storage_key, original_filename, mime_type, file_size_bytes, is_active
       ) VALUES ($1, $2, $3, 'CASH_RECEIPT', 'reconciled_7a_200k.jpg', 'reconciled_7a_200k.jpg', 'image/jpeg', 128, TRUE)`,
      [testPropId, s7a.reservationId, recPt7a.rows[0].id]
    );

    const postReconcile7a = await api(
      'POST',
      `/api/reservations/${s7a.reservationId}/payments`,
      buildMultipartPayment({ propertyId: testPropId, amount: 100000, paymentMethod: 'CASH', filename: 's7a_post_reconcile_100k.jpg' })
    );
    expect(
      postReconcile7a.status === 200,
      'S7A.5: After explicit reconciliation of legacy Rp 200,000 payment, recording new Rp 100,000 payment succeeds (200)'
    );
    await assertThreeWayFinancialSync(
      s7a.reservationId,
      {
        totalPrice: 600000,
        amountPaid: 300000,
        appliedDeposit: 0,
        remainingBalance: 300000,
        paymentStatus: 'PARTIAL',
        paymentOk: false,
        paymentEvidenceOk: true,
        eligible: false,
      },
      'S7A.6 (after reconciliation + Rp 100k payment: total 600k, paid 300k, remaining 300k, PARTIAL)'
    );

    // --- 7B: Legacy Source 2 (Legacy folio PAYMENT = 200,000 without canonical payment_transactions) ---
    const s7b = await createSeededReservation({
      guestName: 'S7B Legacy Folio Payment Guest',
      guestPhone: '081111111702',
      subtotalAmount: 600000,
    });
    // Insert legacy PAYMENT credit of Rp 200,000 in folio_entries only (0 rows in payment_transactions)
    await pool.query(
      `INSERT INTO folio_entries (
         reservation_id, property_id, entry_type, source_type, description,
         amount, direction, status, is_voided
       ) VALUES ($1, $2, 'PAYMENT', 'LEGACY_FOLIO', 'Pembayaran Folio Lama Rp 200.000', 200000, 'CREDIT', 'POSTED', FALSE)`,
      [s7b.reservationId, testPropId]
    );

    // Initial read recognizes the Rp 200,000 legacy folio payment via fallback
    await assertThreeWayFinancialSync(
      s7b.reservationId,
      {
        totalPrice: 600000,
        amountPaid: 200000,
        appliedDeposit: 0,
        remainingBalance: 400000,
        paymentStatus: 'PARTIAL',
        paymentOk: false,
        paymentEvidenceOk: false,
        eligible: false,
      },
      'S7B.1 (initial read of legacy folio payment reservation: total 600k, paid 200k via LEGACY_FOLIO_FALLBACK, remaining 400k)'
    );

    // Attempt to record new canonical payment of Rp 100,000 on un-reconciled legacy folio payment state
    const attempt7b = await api(
      'POST',
      `/api/reservations/${s7b.reservationId}/payments`,
      buildMultipartPayment({ propertyId: testPropId, amount: 100000, paymentMethod: 'CASH', filename: 's7b_new_100k.jpg' })
    );
    const countsAfter7bAttempt = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM payment_transactions WHERE reservation_id = $1) AS pt_cnt,
         (SELECT COUNT(*)::int FROM folio_entries WHERE reservation_id = $1) AS fe_cnt,
         (SELECT COUNT(*)::int FROM payment_evidences WHERE reservation_id = $1) AS pe_cnt`,
      [s7b.reservationId]
    );
    expect(
      attempt7b.status === 409 &&
        attempt7b.json?.code === 'LEGACY_PAYMENT_RECONCILIATION_REQUIRED' &&
        attempt7b.json?.details?.legacy_payment_source === 'LEGACY_FOLIO_FALLBACK' &&
        Number(attempt7b.json?.details?.legacy_amount_paid) === 200000 &&
        Number(attempt7b.json?.details?.attempted_payment_amount) === 100000 &&
        countsAfter7bAttempt.rows[0].pt_cnt === 0 &&
        countsAfter7bAttempt.rows[0].fe_cnt === 2 &&
        countsAfter7bAttempt.rows[0].pe_cnt === 0,
      'S7B.2: Recording Rp 100,000 on un-reconciled legacy folio payment is rejected pre-write with 409 LEGACY_PAYMENT_RECONCILIATION_REQUIRED and zero new DB writes',
      { status: attempt7b.status, body: attempt7b.json, dbCounts: countsAfter7bAttempt.rows[0] }
    );

    // Re-read after rejected transition: legacy Rp 200,000 folio payment is NOT lost
    await assertThreeWayFinancialSync(
      s7b.reservationId,
      {
        totalPrice: 600000,
        amountPaid: 200000,
        appliedDeposit: 0,
        remainingBalance: 400000,
        paymentStatus: 'PARTIAL',
        paymentOk: false,
        paymentEvidenceOk: false,
        eligible: false,
      },
      'S7B.3 (re-read after 409 rejection: legacy Rp 200,000 folio payment remains intact at paid 200k, remaining 400k)'
    );

    // Retry recording Rp 100,000 -> deterministically rejected again
    const retry7b = await api(
      'POST',
      `/api/reservations/${s7b.reservationId}/payments`,
      buildMultipartPayment({ propertyId: testPropId, amount: 100000, paymentMethod: 'TRANSFER', filename: 's7b_retry_100k.jpg' })
    );
    expect(
      retry7b.status === 409 && retry7b.json?.code === 'LEGACY_PAYMENT_RECONCILIATION_REQUIRED',
      'S7B.4: Retry on un-reconciled legacy folio reservation deterministically returns 409 LEGACY_PAYMENT_RECONCILIATION_REQUIRED'
    );

    // Explicit reconciliation of S7B legacy Rp 200,000 folio payment into payment_transactions, followed by +Rp 100,000 payment, correction, and void
    const recPt7b = await pool.query(
      `INSERT INTO payment_transactions (
         property_id, booking_id, reservation_id, transaction_type, amount,
         payment_method, reference_code, status, created_by, scope
       ) VALUES ($1, $2, $3, 'PAYMENT', 200000, 'CASH', 'RECON-7B-200K', 'SUCCESS', 'Reconciliation', 'ROOM_RESERVATION')
       RETURNING id`,
      [testPropId, s7b.bookingId, s7b.reservationId]
    );
    await pool.query(
      `INSERT INTO payment_evidences (
         property_id, reservation_id, payment_transaction_id, evidence_type,
         storage_key, original_filename, mime_type, file_size_bytes, is_active
       ) VALUES ($1, $2, $3, 'CASH_RECEIPT', 'reconciled_7b_200k.jpg', 'reconciled_7b_200k.jpg', 'image/jpeg', 128, TRUE)`,
      [testPropId, s7b.reservationId, recPt7b.rows[0].id]
    );

    const postReconcile7b = await api(
      'POST',
      `/api/reservations/${s7b.reservationId}/payments`,
      buildMultipartPayment({ propertyId: testPropId, amount: 100000, paymentMethod: 'CASH', filename: 's7b_post_reconcile_100k.jpg' })
    );
    expect(
      postReconcile7b.status === 200,
      'S7B.5: After explicit reconciliation of legacy Rp 200,000 folio payment, recording new Rp 100,000 payment succeeds (200)'
    );
    const newPayment7bId = Number(postReconcile7b.json?.data?.payment?.id);
    await assertThreeWayFinancialSync(
      s7b.reservationId,
      {
        totalPrice: 600000,
        amountPaid: 300000,
        appliedDeposit: 0,
        remainingBalance: 300000,
        paymentStatus: 'PARTIAL',
        paymentOk: false,
        paymentEvidenceOk: true,
        eligible: false,
      },
      'S7B.6 (after reconciliation + Rp 100k payment: total 600k, paid 300k, remaining 300k, PARTIAL)'
    );

    // Correct the new Rp 100,000 payment to Rp 150,000 -> total paid becomes Rp 350,000, remaining Rp 250,000
    const corrFd7b = new FormData();
    corrFd7b.append('property_id', String(testPropId));
    corrFd7b.append('amount', '150000');
    corrFd7b.append('payment_method', 'CASH');
    corrFd7b.append('reason_code', 'WRONG_AMOUNT');
    corrFd7b.append('reason_text', 'Correct 100k to 150k alongside reconciled 200k');
    corrFd7b.append(
      'file',
      new Blob([Buffer.from(`FAKE_JPEG_EVIDENCE_CORR7B_${Date.now()}`)], { type: 'image/jpeg' }),
      's7b_corrected_150k.jpg'
    );
    const corr7b = await api(
      'POST',
      `/api/reservations/${s7b.reservationId}/payments/${newPayment7bId}/correct`,
      corrFd7b
    );
    expect(corr7b.status === 200, 'S7B.7: Correcting second payment from Rp 100,000 to Rp 150,000 returns 200');
    const replacement7bId = Number(corr7b.json?.data?.replacement?.id);
    await assertThreeWayFinancialSync(
      s7b.reservationId,
      {
        totalPrice: 600000,
        amountPaid: 350000,
        appliedDeposit: 0,
        remainingBalance: 250000,
        paymentStatus: 'PARTIAL',
        paymentOk: false,
        paymentEvidenceOk: true,
        eligible: false,
      },
      'S7B.8 (after correcting 100k -> 150k: total 600k, paid 350k, remaining 250k, PARTIAL)'
    );

    // Void the Rp 150,000 replacement payment -> reconciled Rp 200,000 payment remains intact (paid 200k, remaining 400k)
    const void7b = await api(
      'POST',
      `/api/reservations/${s7b.reservationId}/payments/${replacement7bId}/void`,
      {
        property_id: testPropId,
        reason_code: 'PAYMENT_CANCELLED',
        reason_text: 'Void second payment, keep reconciled 200k',
      }
    );
    expect(void7b.status === 200, 'S7B.9: Voiding Rp 150,000 replacement payment returns 200');
    await assertThreeWayFinancialSync(
      s7b.reservationId,
      {
        totalPrice: 600000,
        amountPaid: 200000,
        appliedDeposit: 0,
        remainingBalance: 400000,
        paymentStatus: 'PARTIAL',
        paymentOk: false,
        paymentEvidenceOk: true,
        eligible: false,
      },
      'S7B.10 (after voiding second payment: reconciled Rp 200,000 remains intact at paid 200k, remaining 400k)'
    );

    // --- 7C: Corrupted snapshot amount_paid on modern folio-backed reservation is rejected as payment source & allowed to pay ---
    const s7c = await createSeededReservation({
      guestName: 'S7C Modern Corrupted Snapshot Guest',
      guestPhone: '081111111703',
      subtotalAmount: 600000,
      persistedAmountPaid: 200000,
      persistedRemainingBalance: 400000,
      persistedPaymentStatus: 'PARTIAL',
    });
    // s7c has ROOM_CHARGE = 600,000 in folio_entries (chargeCount = 1 > 0), 0 payment_transactions, 0 folio PAYMENT rows,
    // and corrupted reservations.amount_paid = 200,000.
    await assertThreeWayFinancialSync(
      s7c.reservationId,
      {
        totalPrice: 600000,
        amountPaid: 0,
        appliedDeposit: 0,
        remainingBalance: 600000,
        paymentStatus: 'UNPAID',
        paymentOk: false,
        paymentEvidenceOk: false,
        eligible: false,
      },
      'S7C.1 (modern folio-backed reservation with corrupted snapshot amount_paid=200k is rejected as payment source -> paid=0, remaining=600k, UNPAID)'
    );

    const pay7c = await api(
      'POST',
      `/api/reservations/${s7c.reservationId}/payments`,
      buildMultipartPayment({ propertyId: testPropId, amount: 100000, paymentMethod: 'CASH', filename: 's7c_valid_100k.jpg' })
    );
    expect(
      pay7c.status === 200,
      'S7C.2: Recording Rp 100,000 canonical payment on modern reservation with corrupted snapshot succeeds (not blocked by legacy guard and never sums corrupted snapshot)'
    );
    await assertThreeWayFinancialSync(
      s7c.reservationId,
      {
        totalPrice: 600000,
        amountPaid: 100000,
        appliedDeposit: 0,
        remainingBalance: 500000,
        paymentStatus: 'PARTIAL',
        paymentOk: false,
        paymentEvidenceOk: true,
        eligible: false,
      },
      'S7C.3 (after Rp 100k canonical payment on S7C: total 600k, paid 100k, remaining 500k, PARTIAL — corrupted 200k snapshot not double-counted)'
    );
  } finally {
    if (server) {
      server.close();
      await once(server, 'close');
    }
    await cleanupFixtures();
  }

  // Verify zero residue
  const residueRes = await pool.query('SELECT COUNT(*)::int AS cnt FROM properties WHERE id = $1', [testPropId]);
  expect(residueRes.rows[0].cnt === 0, 'CLEANUP: Zero test property residue in isolated database');

  const summary = {
    suite: 'precheckin_payment_evidence_1503_regression_test',
    timestamp: new Date().toISOString(),
    database: currentDb,
    passed,
    failed,
    results: resultsLog,
  };
  const outPath = process.env.TEST_REPORT_PATH;
  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
  }

  console.log(`\n========================================`);
  console.log(`1503 Pre-Checkin Payment & Evidence Regression: ${passed} passed, ${failed} failed`);
  console.log(`========================================`);
  await pool.end();
  if (failed > 0) process.exit(1);
}

runTests().catch(async (err) => {
  console.error('Fatal test error:', err);
  try {
    await cleanupFixtures();
    await pool.end();
  } catch (_e) {}
  process.exit(1);
});
