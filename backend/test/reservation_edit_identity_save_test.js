/**
 * Reservation edit: save without mandatory payment + mandatory staying-guest
 * identity (PRIMARY_GUEST / KTP document), on an isolated reservation DB.
 *
 * Run from backend/ with DB_* pointing at the reservation database:
 *   DB_PORT=55459 DB_NAME=oak_hims_edit_reservasi \
 *   node test/reservation_edit_identity_save_test.js
 */
const assert = require('assert');
const { Pool } = require('pg');

// ── RE-E01: Runner guard ─────────────────────────────────────────────────
// Reject execution before any DB query when the target is empty, default,
// or a known protected port. This prevents accidental writes to production
// or unrelated databases in case the environment is misconfigured.
const PROTECTED_PORTS = new Set([5432, 55457, 55451, 55449, 55458]);
const PROTECTED_DBS   = new Set(['oak_hotel_db', 'oak_hims_qb_payment_uat_20261111']);
const EXPECTED_DBS    = new Set(['oak_hims_edit_reservasi', 'oak_hotfix_04ee417_isolated_test']);
const EXPECTED_PORT   = 55459;

const targetPort = Number(process.env.DB_PORT);
const targetDb   = process.env.DB_NAME;
const targetHost = process.env.DB_HOST || '127.0.0.1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function assertSafeTarget() {
  const portOk   = targetPort === EXPECTED_PORT;
  const dbOk     = EXPECTED_DBS.has(targetDb);
  if (!LOOPBACK_HOSTS.has(targetHost)) {
    const msg = `DB_HOST '${targetHost}' is not a loopback address. This suite must run on 127.0.0.1 or localhost.`;
    console.error(`GUARD: ${msg}`);
    process.exit(1);
  }
  if (!dbOk) {
    const msg = `DB_NAME is '${targetDb || '(empty)'}' but this suite requires one of [${Array.from(EXPECTED_DBS).join(', ')}].`;
    console.error(`GUARD: ${msg}`);
    process.exit(1);
  }
  if (!portOk) {
    const msg = `DB_PORT is '${targetPort || '(empty)'}' but this suite requires ${EXPECTED_PORT} (the isolated reservation container). Set DB_PORT=${EXPECTED_PORT}.`;
    console.error(`GUARD: ${msg}`);
    process.exit(1);
  }
  if (PROTECTED_PORTS.has(targetPort)) {
    const msg = `DB_PORT ${targetPort} is a protected port. This suite must run on ${EXPECTED_PORT}.`;
    console.error(`GUARD: ${msg}`);
    process.exit(1);
  }
  if (PROTECTED_DBS.has(targetDb)) {
    const msg = `DB_NAME '${targetDb}' is a protected database. This suite must run on '${EXPECTED_DB}'.`;
    console.error(`GUARD: ${msg}`);
    process.exit(1);
  }
}
assertSafeTarget();

const { initializeDatabase } = require('../dist/db/schema_v3');
const {
  previewReservationEdit,
  executeReservationEditWithPayment
} = require('../dist/domains/reservations/reservationEditService');
const {
  assertPrimaryGuestIdentityForEdit
} = require('../dist/domains/reservations/reservationEditIdentityGuard');

const pool = new Pool({
  host: targetHost,
  port: targetPort,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  database: targetDb
});

const runId = `IDE${String(Date.now()).slice(-8)}`;
let planBaseId;
let roomIds = [];
const tracked = {
  propertyId: null,
  reservationIds: [],
  bookingIds: [],
  guestIds: [],
  reservationRoom: {}
};
let failures = 0;
const results = [];

function check(name, fn) {
  try {
    fn();
    results.push({ name, status: 'PASS' });
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures += 1;
    results.push({ name, status: 'FAIL', error: err.message });
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

async function createGuest(client, propertyId, name, { valid }) {
  const res = await client.query(
    `INSERT INTO guests (
       full_name, normalized_name, phone, normalized_phone, created_property_id,
       identity_type, identity_number, normalized_identity_number,
       identity_path, identity_storage_key, has_valid_identity, is_active
     ) VALUES ($1, $2, $3, $4, $5, 'KTP', $6, $6, $7, $8, $9, TRUE)
     RETURNING id`,
    [
      name,
      name.toLowerCase(),
      `0812${String(Date.now()).slice(-7)}`,
      `0812${String(Date.now()).slice(-7)}`,
      propertyId,
      valid ? `3171${String(Date.now()).slice(-12)}` : null,
      valid ? `test-docs/${runId}.jpg` : null,
      valid ? `test-docs/${runId}.jpg` : null,
      valid
    ]
  );
  tracked.guestIds.push(res.rows[0].id);
  return Number(res.rows[0].id);
}

async function createReservation(client, opts) {
  const {
    propertyId, roomId, roomTypeId, guestId, total, subtotal, discount,
    amountPaid = 0, appliedDeposit = 0, paymentStatus = 'UNPAID',
    linkPrimary = true, bookerGuestId = null
  } = opts;  const booking = await client.query(
    `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
     VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [propertyId, `${runId}-${tracked.reservationIds.length + 1}`, `${runId}-GUEST`]
  );
  const bookingId = booking.rows[0].id;
  tracked.bookingIds.push(bookingId);
  const remaining = Math.max(0, total - amountPaid - appliedDeposit);
  const reservation = await client.query(
    `INSERT INTO reservations (
       booking_id, room_id, booked_room_type_id_snapshot, rate_plan_id, guest_name, guest_phone,
       check_in, check_out, subtotal_amount, discount_amount, service_amount,
       tax_amount, total_price, amount_paid, applied_deposit, remaining_balance,
       status, payment_status, stay_type, stay_sequence, special_requests
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, 0, $11, $12, $13, $14,
       'BOOKED', $15, 'OVERNIGHT', 1, 'catatan awal')
     RETURNING id`,
    [
      bookingId, roomId, roomTypeId, planBaseId, `${runId}-GUEST`, '081200000000',
      '2036-02-01', '2036-02-02', subtotal, discount, total, amountPaid,
      appliedDeposit, remaining, paymentStatus
    ]
  );
  const reservationId = Number(reservation.rows[0].id);
  tracked.reservationIds.push(reservationId);
  await client.query(
    `INSERT INTO folio_entries (
       reservation_id, property_id, entry_type, description, amount, direction
     ) VALUES ($1, $2, 'ROOM_CHARGE', 'Initial room charge', $3, 'DEBIT')`,
    [reservationId, propertyId, total]
  );
  if (linkPrimary) {
    await client.query(
      `INSERT INTO reservation_guests (reservation_id, guest_id, role, relationship, is_staying)
       VALUES ($1, $2, 'PRIMARY_GUEST', 'STAYING', TRUE)`,
      [reservationId, guestId]
    );
  }
  if (bookerGuestId) {
    await client.query(
      `INSERT INTO reservation_guests (reservation_id, guest_id, role, relationship, is_staying)
       VALUES ($1, $2, 'BOOKER', 'BOOKER', FALSE)`,
      [reservationId, bookerGuestId]
    );
  }
  return reservationId;
}

async function reservationRow(client, id) {
  const res = await client.query('SELECT * FROM reservations WHERE id = $1', [id]);
  return res.rows[0];
}

async function paymentCount(client, id) {
  const res = await client.query(
    'SELECT COUNT(*)::int AS c FROM payment_transactions WHERE reservation_id = $1',
    [id]
  );
  return res.rows[0].c;
}

async function cleanup() {
  const client = await pool.connect();
  try {
    if (tracked.reservationIds.length) {
      await client.query('DELETE FROM payment_evidences WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query('DELETE FROM reservation_guests WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [tracked.reservationIds]);
    }
    if (tracked.bookingIds.length) {
      await client.query('DELETE FROM bookings WHERE id = ANY($1::int[])', [tracked.bookingIds]);
    }
    if (tracked.guestIds.length) {
      await client.query('DELETE FROM guests WHERE id = ANY($1::int[])', [tracked.guestIds]);
    }
    if (tracked.propertyId) {
      await client.query('DELETE FROM audit_logs WHERE property_id = $1', [tracked.propertyId]);
      await client.query(
        `DELETE FROM availability_dates
         WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id = $1)`,
        [tracked.propertyId]
      );
      await client.query('DELETE FROM rate_overrides WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM rate_plans WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM rooms WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM room_types WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM room_categories WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM property_pricing_settings WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM properties WHERE id = $1', [tracked.propertyId]);
    }
  } finally {
    client.release();
  }
}

async function run() {
  await initializeDatabase(pool);
  const client = await pool.connect();
  let roomTypeId;
  let roomId;
  let planHigherId;
  let planLowerId;
  let guestValidId;
  let guestMissingId;
  let guestSameNameId;
  let guestValid2Id;
  const dates = { check_in: '2036-02-01', check_out: '2036-02-02', stay_type: 'OVERNIGHT' };

  try {
    await client.query('BEGIN');
    const property = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ($1, $2, 'Asia/Jakarta', 'IDR', 'Test', TRUE) RETURNING id`,
      [runId, `I${String(Date.now()).slice(-5)}`]
    );
    tracked.propertyId = Number(property.rows[0].id);
    await client.query(
      `INSERT INTO property_pricing_settings (
         property_id, tax_percent, service_charge_percent, prices_include_tax, prices_include_service
       ) VALUES ($1, 0, 0, FALSE, FALSE)`,
      [tracked.propertyId]
    );
    const category = await client.query(
      `INSERT INTO room_categories (property_id, code, name, is_active)
       VALUES ($1, 'IDE-CAT', 'Identity Edit', TRUE) RETURNING id`,
      [tracked.propertyId]
    );
    const roomType = await client.query(
      `INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity)
       VALUES ($1, $2, 'IDE-TYPE', 'Identity Edit Type', 510000, 2) RETURNING id`,
      [tracked.propertyId, category.rows[0].id]
    );
    roomTypeId = Number(roomType.rows[0].id);
    const room = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES ($1, $2, 'IDE-01', 'Identity Room', 'Ready', TRUE) RETURNING id`,
      [tracked.propertyId, roomTypeId]
    );
    roomId = Number(room.rows[0].id);
    // Create separate physical rooms so each case has its own room on the same
    // date range and the per-room overlap check in applyReservationEdit does not
    // reject later cases as conflicting with earlier ones.
    const extraRooms = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES ($1, $2, 'IDE-02', 'Identity Room 2', 'Ready', TRUE),
              ($1, $2, 'IDE-03', 'Identity Room 3', 'Ready', TRUE),
              ($1, $2, 'IDE-04', 'Identity Room 4', 'Ready', TRUE),
              ($1, $2, 'IDE-05', 'Identity Room 5', 'Ready', TRUE),
              ($1, $2, 'IDE-06', 'Identity Room 6', 'Ready', TRUE),
              ($1, $2, 'IDE-07', 'Identity Room 7', 'Ready', TRUE),
              ($1, $2, 'IDE-08', 'Identity Room 8', 'Ready', TRUE),
              ($1, $2, 'IDE-09', 'Identity Room 9', 'Ready', TRUE),
              ($1, $2, 'IDE-10', 'Identity Room 10', 'Ready', TRUE)
       RETURNING id`,
      [tracked.propertyId, roomTypeId]
    );
    roomIds = [roomId, ...extraRooms.rows.map((r) => Number(r.id))];
    const plans = await client.query(
      `INSERT INTO rate_plans (property_id, room_type_id, code, name, base_rate, rate_type, is_active)
       VALUES ($1, $2, 'IDE-BASE',  'Base Plan',   510000, 'OVERNIGHT', TRUE),
              ($1, $2, 'IDE-HIGH',  'Higher Plan', 610000, 'OVERNIGHT', TRUE),
              ($1, $2, 'IDE-LOW',   'Lower Plan',  410000, 'OVERNIGHT', TRUE)
       RETURNING id, code`,
      [tracked.propertyId, roomTypeId]
    );
    planBaseId = Number(plans.rows.find((r) => r.code === 'IDE-BASE').id);
    planHigherId = Number(plans.rows.find((r) => r.code === 'IDE-HIGH').id);
    planLowerId = Number(plans.rows.find((r) => r.code === 'IDE-LOW').id);

    guestValidId = await createGuest(client, tracked.propertyId, 'Tamu Valid KTP', { valid: true });
    guestMissingId = await createGuest(client, tracked.propertyId, 'Tamu Tanpa KTP', { valid: false });
    guestSameNameId = await createGuest(client, tracked.propertyId, 'Tamu Valid KTP', { valid: false });
    guestValid2Id = await createGuest(client, tracked.propertyId, 'Tamu Valid Kedua', { valid: true });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    client.release();
    throw error;
  }
  client.release();

  // -----------------------------------------------------------------------
  // A. Metadata-only save: name/phone/notes, no payment, no price change.
  // -----------------------------------------------------------------------
  const metaId = await createReservation(pool, {
    propertyId: tracked.propertyId, roomId: roomIds[0], roomTypeId, guestId: guestValidId,
    subtotal: 510000, discount: 102000, total: 408000
  });
  const metaBefore = await reservationRow(pool, metaId);
  const metaResult = await executeReservationEditWithPayment(pool, metaId, {
    property_id: tracked.propertyId,
    room_type_id: roomTypeId,
    room_id: roomIds[0],
    rate_plan_id: planBaseId,
    ...dates,
    guest_id: guestValidId,
    guest_name: 'Tamu Valid KTP',
    guest_phone: '081299988877',
    notes: 'catatan diperbarui',
    idempotency_key: `${runId}-META`
  }, null, 'TEST');
  const metaAfter = await reservationRow(pool, metaId);
  const metaPayments = await paymentCount(pool, metaId);
  check('A1 metadata-only save posts no payment row', () => {
    assert.strictEqual(metaResult.payment, null);
    assert.strictEqual(metaPayments, 0, 'expected 0 payment_transactions');
  });
  check('A2 metadata-only keeps total, subtotal, discount exactly', () => {
    assert.strictEqual(Number(metaBefore.total_price), 408000);
    assert.strictEqual(Number(metaAfter.total_price), 408000);
    assert.strictEqual(Number(metaAfter.subtotal_amount), 510000);
    assert.strictEqual(Number(metaAfter.discount_amount), 102000);
    assert.strictEqual(Number(metaResult.price_difference), 0);
  });
  check('A3 metadata-only keeps settlement and remaining balance', () => {
    assert.strictEqual(Number(metaAfter.amount_paid), 0);
    assert.strictEqual(Number(metaAfter.applied_deposit), 0);
    assert.strictEqual(Number(metaAfter.remaining_balance), 408000);
    assert.strictEqual(metaAfter.payment_status, 'UNPAID');
  });
  check('A4 name/phone/notes are persisted on the same guest target', () => {
    assert.strictEqual(metaAfter.guest_name, 'Tamu Valid KTP');
    assert.strictEqual(metaAfter.guest_phone, '081299988877');
    assert.strictEqual(metaAfter.special_requests, 'catatan diperbarui');
  });

  // -----------------------------------------------------------------------
  // B. Identity guard: missing document, no relation, same-name impostor,
  //    booker KTP does not cover the staying guest.
  // -----------------------------------------------------------------------
  const missingId = await createReservation(pool, {
    propertyId: tracked.propertyId, roomId: roomIds[1], roomTypeId, guestId: guestMissingId,
    subtotal: 510000, discount: 102000, total: 408000
  });
  const guestsBefore = (await pool.query('SELECT COUNT(*)::int c FROM guests')).rows[0].c;
  let missingErr = null;
  try {
    await executeReservationEditWithPayment(pool, missingId, {
      property_id: tracked.propertyId, room_type_id: roomTypeId, room_id: roomIds[1],
      rate_plan_id: planBaseId, ...dates, guest_id: guestMissingId,
      guest_name: 'Harusnya Ditolak', idempotency_key: `${runId}-MISSING`
    }, null, 'TEST');
  } catch (err) {
    missingErr = err;
  }
  const missingAfter = await reservationRow(pool, missingId);
  check('B1 staying guest without KTP document is rejected', () => {
    assert.ok(missingErr, 'expected an error');
    assert.strictEqual(missingErr.statusCode, 409);
    assert.strictEqual(missingErr.code, 'IDENTITY_DOCUMENT_MISSING');
  });
  check('B2 rejected save leaves reservation and guest rows untouched', () => {
    assert.strictEqual(missingAfter.guest_name, `${runId}-GUEST`);
    assert.strictEqual(Number(missingAfter.total_price), 408000);
  });
  const guestsAfter = (await pool.query('SELECT COUNT(*)::int c FROM guests')).rows[0].c;
  check('B3 rejected save creates no duplicate guest', () => {
    assert.strictEqual(guestsAfter, guestsBefore);
  });

  const noLinkId = await createReservation(pool, {
    propertyId: tracked.propertyId, roomId: roomIds[2], roomTypeId, guestId: guestValidId,
    subtotal: 510000, discount: 102000, total: 408000, linkPrimary: false
  });
  let noLinkErr = null;
  try {
    await executeReservationEditWithPayment(pool, noLinkId, {
      property_id: tracked.propertyId, room_type_id: roomTypeId, room_id: roomIds[2],
      rate_plan_id: planBaseId, ...dates,
      guest_name: `${runId}-GUEST`, idempotency_key: `${runId}-NOLINK`
    }, null, 'TEST');
  } catch (err) {
    noLinkErr = err;
  }
  check('B4 missing PRIMARY_GUEST relation fails closed', () => {
    assert.ok(noLinkErr, 'expected an error');
    assert.strictEqual(noLinkErr.code, 'PRIMARY_GUEST_NOT_LINKED');
  });

  const impostorId = await createReservation(pool, {
    propertyId: tracked.propertyId, roomId: roomIds[3], roomTypeId, guestId: guestValidId,
    subtotal: 510000, discount: 102000, total: 408000
  });
  const impostorBefore = await reservationRow(pool, impostorId);
  let impostorErr = null;
  try {
    // Same full name as the valid guest but a different record without KTP.
    await executeReservationEditWithPayment(pool, impostorId, {
      property_id: tracked.propertyId, room_type_id: roomTypeId, room_id: roomIds[3],
      rate_plan_id: planBaseId, ...dates,
      guest_id: guestSameNameId, guest_name: 'Tamu Valid KTP',
      idempotency_key: `${runId}-IMPOSTOR`
    }, null, 'TEST');
  } catch (err) {
    impostorErr = err;
  }
  const impostorAfter = await reservationRow(pool, impostorId);
  const impostorLink = await pool.query(
    `SELECT guest_id FROM reservation_guests WHERE reservation_id = $1 AND role = 'PRIMARY_GUEST'`,
    [impostorId]
  );
  check('B5 same name does not borrow another record identity', () => {
    assert.ok(impostorErr, 'expected an error');
    assert.strictEqual(impostorErr.code, 'IDENTITY_DOCUMENT_MISSING');
    assert.strictEqual(Number(impostorLink.rows[0].guest_id), guestValidId, 'link must roll back');
    assert.strictEqual(impostorAfter.guest_name, impostorBefore.guest_name);
  });

  const bookerId = await createReservation(pool, {
    propertyId: tracked.propertyId, roomId: roomIds[4], roomTypeId, guestId: guestMissingId,
    subtotal: 510000, discount: 102000, total: 408000, bookerGuestId: guestValidId
  });
  let bookerErr = null;
  try {
    await executeReservationEditWithPayment(pool, bookerId, {
      property_id: tracked.propertyId, room_type_id: roomTypeId, room_id: roomIds[4],
      rate_plan_id: planBaseId, ...dates, guest_name: 'Pemesan BerKTP',
      idempotency_key: `${runId}-BOOKER`
    }, null, 'TEST');
  } catch (err) {
    bookerErr = err;
  }
  check('B6 booker KTP does not satisfy the staying guest check', () => {
    assert.ok(bookerErr, 'expected an error');
    assert.strictEqual(bookerErr.code, 'IDENTITY_DOCUMENT_MISSING');
  });

  const mismatch = await assertPrimaryGuestIdentityForEdit(pool, impostorId, tracked.propertyId, guestSameNameId);
  check('B7 final target must match the linked PRIMARY_GUEST', () => {
    assert.strictEqual(mismatch.ok, false);
    assert.strictEqual(mismatch.code, 'IDENTITY_TARGET_MISMATCH');
  });

  // KTP completed through the existing flow → same reservation can now save.
  await pool.query(
    `UPDATE guests SET identity_storage_key = $1, identity_path = $1, has_valid_identity = TRUE WHERE id = $2`,
    [`test-docs/${runId}-completed.jpg`, guestMissingId]
  );
  const completedResult = await executeReservationEditWithPayment(pool, missingId, {
    property_id: tracked.propertyId, room_type_id: roomTypeId, room_id: roomIds[1],
    rate_plan_id: planBaseId, ...dates, guest_id: guestMissingId,
    guest_name: 'Tamu Tanpa KTP', idempotency_key: `${runId}-COMPLETED`
  }, null, 'TEST');
  check('B8 save succeeds after KTP is completed, still unpaid', () => {
    assert.strictEqual(completedResult.payment, null);
    assert.strictEqual(Number(completedResult.reservation.total_price), 408000);
    assert.strictEqual(Number(completedResult.reservation.remaining_balance), 408000);
  });
  // Guest swap to another valid guest must re-check the NEW target.
  const swapId = await createReservation(pool, {
    propertyId: tracked.propertyId, roomId: roomIds[5], roomTypeId, guestId: guestMissingId,
    subtotal: 510000, discount: 102000, total: 408000
  });
  const swapResult = await executeReservationEditWithPayment(pool, swapId, {
    property_id: tracked.propertyId, room_type_id: roomTypeId, room_id: roomIds[5],
    rate_plan_id: planBaseId, ...dates, guest_id: guestValid2Id,
    guest_name: 'Tamu Valid Kedua', idempotency_key: `${runId}-SWAP`
  }, null, 'TEST');
  const swapAfter = await reservationRow(pool, swapId);
  const swapLink = await pool.query(
    `SELECT guest_id FROM reservation_guests WHERE reservation_id = $1 AND role = 'PRIMARY_GUEST'`,
    [swapId]
  );
  check('B9 swapping to a different valid-KTP guest is accepted', () => {
    assert.strictEqual(Number(swapAfter.total_price), 408000);
    assert.strictEqual(Number(swapResult.reservation.total_price), 408000);
    assert.strictEqual(Number(swapLink.rows[0].guest_id), guestValid2Id);
  });

  // -----------------------------------------------------------------------
  // C. Price increase: remaining updated, no auto payment.
  // -----------------------------------------------------------------------
  const increaseId = await createReservation(pool, {
    propertyId: tracked.propertyId, roomId: roomIds[6], roomTypeId, guestId: guestValidId,
    subtotal: 510000, discount: 102000, total: 408000
  });
  const increasePreview = await previewReservationEdit(pool, increaseId, {
    property_id: tracked.propertyId, room_type_id: roomTypeId, room_id: roomIds[6],
    rate_plan_id: planHigherId, ...dates
  });
  const increaseResult = await executeReservationEditWithPayment(pool, increaseId, {
    property_id: tracked.propertyId, room_type_id: roomTypeId, room_id: roomIds[6],
    rate_plan_id: planHigherId, ...dates, guest_id: guestValidId,
    expected_new_total: Number(increasePreview.quote.grand_total),
    idempotency_key: `${runId}-INCREASE`
  }, null, 'TEST');
  const increaseAfter = await reservationRow(pool, increaseId);
  const increasePayments = await paymentCount(pool, increaseId);
  check('C1 price increase updates total after existing discount', () => {
    assert.strictEqual(Number(increaseAfter.subtotal_amount), 610000);
    assert.strictEqual(Number(increaseAfter.discount_amount), 102000);
    assert.strictEqual(Number(increaseAfter.total_price), 508000);
  });
  check('C2 price increase updates remaining balance without payment', () => {
    assert.strictEqual(increaseResult.payment, null);
    assert.strictEqual(increasePayments, 0, 'expected 0 payment_transactions');
    assert.strictEqual(Number(increaseAfter.amount_paid), 0);
    assert.strictEqual(Number(increaseAfter.remaining_balance), 508000);
    assert.strictEqual(increaseAfter.payment_status, 'UNPAID');
  });
  check('C3 payment_required is reported but not charged', () => {
    assert.strictEqual(Number(increaseResult.payment_required), 100000);
    assert.strictEqual(Number(increaseResult.price_difference), 100000);
  });

  // -----------------------------------------------------------------------
  // D. Price decrease after full payment: no automatic refund.
  // -----------------------------------------------------------------------
  const decreaseId = await createReservation(pool, {
    propertyId: tracked.propertyId, roomId: roomIds[7], roomTypeId, guestId: guestValidId,
    subtotal: 510000, discount: 102000, total: 408000,
    amountPaid: 408000, paymentStatus: 'PAID'
  });
  const decreaseResult = await executeReservationEditWithPayment(pool, decreaseId, {
    property_id: tracked.propertyId, room_type_id: roomTypeId, room_id: roomIds[7],
    rate_plan_id: planLowerId, ...dates, guest_id: guestValidId,
    idempotency_key: `${runId}-DECREASE`
  }, null, 'TEST');
  const decreaseAfter = await reservationRow(pool, decreaseId);
  const decreaseTx = await pool.query(
    `SELECT COUNT(*)::int c FROM payment_transactions WHERE reservation_id = $1`,
    [decreaseId]
  );
  check('D1 price decrease updates total; remaining clamps to 0, status stays PAID', () => {
    assert.strictEqual(Number(decreaseAfter.subtotal_amount), 410000);
    assert.strictEqual(Number(decreaseAfter.discount_amount), 102000);
    assert.strictEqual(Number(decreaseAfter.total_price), 308000);
    // calculateEditSettlement clamps remaining_balance at 0; it never writes a
    // negative balance or an automatic refund row.
    assert.strictEqual(Number(decreaseAfter.remaining_balance), 0);
    assert.strictEqual(decreaseAfter.payment_status, 'PAID');
  });
  check('D2 price decrease posts no refund or payment row', () => {
    assert.strictEqual(decreaseResult.payment, null);
    assert.strictEqual(decreaseTx.rows[0].c, 0);
    // amount_paid is historical settlement — it must not be auto-reduced.
    assert.strictEqual(Number(decreaseAfter.amount_paid), 408000);
  });
  check('D3 price decrease reports payment_required 0 and no negative balance', () => {
    assert.strictEqual(Number(decreaseResult.payment_required), 0);
    assert.strictEqual(Number(decreaseResult.price_difference), -100000);
    assert.strictEqual(Number(decreaseResult.new_remaining_before_payment), 0);
  });

  // -----------------------------------------------------------------------
  // E. RE-F01 preserve_rate_plan: metadata-only edits keep stored price,
  //    preview returns preserve_price_context, stale quote still guards.
  // -----------------------------------------------------------------------

  // E1: metadata-only save with preserve_rate_plan=true keeps total unchanged.
  // The reservation has planBaseId; the payload echoes planBaseId (same value),
  // and preserve_rate_plan=true ensures the server resolves it to current
  // plan even if a catalog reprice would differ.
  const metaPreserveId = await createReservation(pool, {
    propertyId: tracked.propertyId, roomId: roomIds[8], roomTypeId, guestId: guestValidId,
    subtotal: 510000, discount: 102000, total: 408000
  });
  const metaPreserveResult = await executeReservationEditWithPayment(pool, metaPreserveId, {
    property_id: tracked.propertyId, room_type_id: roomTypeId, room_id: roomIds[8],
    rate_plan_id: planBaseId, ...dates, guest_id: guestValidId,
    guest_name: 'Tamu Valid KTP', notes: 'preserve test',
    preserve_rate_plan: true,
    idempotency_key: `${runId}-PRESERVE`
  }, null, 'TEST');
  const metaPreserveAfter = await reservationRow(pool, metaPreserveId);
  check('E1 preserve_rate_plan=true keeps total at 408000 (no hidden reprice)', () => {
    assert.strictEqual(Number(metaPreserveResult.new_total_price), 408000);
    assert.strictEqual(Number(metaPreserveResult.price_difference), 0);
    assert.strictEqual(Number(metaPreserveAfter.total_price), 408000);
    // The rate plan id stored must remain planBaseId (not wiped or changed)
    assert.strictEqual(Number(metaPreserveAfter.rate_plan_id), planBaseId);
  });
  // RE-F01: metadata-only save must NOT set is_manual_override to TRUE.
  check('E4 metadata-only save leaves is_manual_override=false', () => {
    assert.strictEqual(
      metaPreserveAfter.is_manual_override, false,
      `expected is_manual_override=false, got ${metaPreserveAfter.is_manual_override}`
    );
  });

  // E2: stale expected_new_total triggers STALE_PRICE_QUOTE when a genuine
  // price change is made (rate plan bumped to planHigherId, no preserve flag).
  const staleId = await createReservation(pool, {
    propertyId: tracked.propertyId, roomId: roomIds[9], roomTypeId, guestId: guestValidId,
    subtotal: 510000, discount: 102000, total: 408000
  });
  const stalePreview = await previewReservationEdit(pool, staleId, {
    property_id: tracked.propertyId, room_type_id: roomTypeId, room_id: roomIds[9],
    rate_plan_id: planHigherId, ...dates
  });
  let staleErr = null;
  try {
    await executeReservationEditWithPayment(pool, staleId, {
      property_id: tracked.propertyId, room_type_id: roomTypeId, room_id: roomIds[9],
      rate_plan_id: planHigherId, ...dates, guest_id: guestValidId,
      expected_new_total: 408000, // stale — the real quote is higher
      idempotency_key: `${runId}-STALE`
    }, null, 'TEST');
  } catch (e) { staleErr = e; }
  check('E2 stale expected_new_total triggers STALE_PRICE_QUOTE', () => {
    assert.ok(staleErr, 'expected STALE_PRICE_QUOTE error');
    assert.strictEqual(staleErr.code, 'STALE_PRICE_QUOTE');
    // The preview should have returned a non-zero difference
    assert.strictEqual(Number(stalePreview.price_difference) > 0, true, 'preview diff must be positive for higher plan');
  });

  // E3: preview with preserve_rate_plan=true returns preserve_price_context
  // and zero difference for a metadata-only edit.
  const ppResult = await previewReservationEdit(pool, metaPreserveId, {
    property_id: tracked.propertyId, room_type_id: roomTypeId, room_id: roomIds[8],
    rate_plan_id: planBaseId, ...dates,
    preserve_rate_plan: true
  });
  check('E3 metadata-only preview has preserve_price_context=true and zero diff', () => {
    assert.strictEqual(ppResult.preserve_price_context, true);
    assert.strictEqual(Number(ppResult.price_difference), 0);
    assert.strictEqual(Number(ppResult.quote.grand_total), Number(ppResult.old_total));
  });

  // F. Explicit old/shared guest_id with a different guest_name must NOT overwrite master guest
  let crossNameErr = null;
  try {
    await executeReservationEditWithPayment(pool, metaId, {
      property_id: tracked.propertyId,
      room_type_id: roomTypeId,
      room_id: roomIds[0],
      rate_plan_id: planBaseId,
      ...dates,
      guest_id: guestValidId,
      guest_name: 'Orang Lain Berbeda',
      idempotency_key: `${runId}-CROSS-NAME`
    }, null, 'TEST');
  } catch (e) {
    crossNameErr = e;
  }
  const masterGuestAfterCrossName = (
    await pool.query('SELECT full_name FROM guests WHERE id = $1', [guestValidId])
  ).rows[0];
  check('F1 explicit old/shared guest_id with different guest_name is rejected', () => {
    assert.ok(crossNameErr, 'expected conflict when passing old guest_id with different name');
    assert.strictEqual(crossNameErr.statusCode, 409);
    assert.ok(
      crossNameErr.code === 'SHARED_PRIMARY_GUEST_CONFLICT' ||
        crossNameErr.code === 'GUEST_IDENTITY_TARGET_MISMATCH',
      `unexpected code: ${crossNameErr.code}`
    );
  });
  check('F2 master guest full_name remains untouched after rejected cross-name save', () => {
    assert.strictEqual(masterGuestAfterCrossName.full_name, 'Tamu Valid KTP');
  });

}

run()
  .catch((err) => {
    failures += 1;
    console.error('SUITE ERROR:', err.message);
    results.push({ name: 'SUITE', status: 'FAIL', error: err.message });
  })
  .finally(async () => {
    try {
      await cleanup();
    } catch (cleanupErr) {
      failures += 1;
      console.error('CLEANUP ERROR:', cleanupErr.message);
    }
    await pool.end();
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({ runId, failures, results }, null, 2));
    process.exit(failures === 0 ? 0 : 1);
  });
