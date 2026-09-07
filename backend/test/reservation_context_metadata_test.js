const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const http = require('http');
const { Pool } = require('pg');
const assert = require('assert/strict');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  console.log('=== RESERVATION-CONTEXT-METADATA-1 backend ===\n');

  const { initializeDatabase } = require('../dist/db/schema_v3');
  await initializeDatabase(pool);

  const colRes = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'reservations' AND column_name = 'special_requests'
  `);
  expect(colRes.rowCount === 1, 'migration added reservations.special_requests');
  console.log('  ✓ additive reservations.special_requests exists');

  const {
    normalizeSpecialRequests,
    canEditReservationSpecialRequests,
    SPECIAL_REQUESTS_AUDIT_ACTION,
    SPECIAL_REQUESTS_STATUS_LOCKED,
  } = require('../dist/domains/reservations/reservationSpecialRequests');

  expect(normalizeSpecialRequests('  late arrival  ') === 'late arrival', 'trim surrounding whitespace');
  expect(normalizeSpecialRequests('   ') === null, 'empty string normalizes to NULL');
  expect(normalizeSpecialRequests(null) === null, 'null stays null');
  expect(canEditReservationSpecialRequests('BOOKED'), 'BOOKED editable');
  expect(canEditReservationSpecialRequests('CHECKED_IN'), 'CHECKED_IN editable');
  expect(!canEditReservationSpecialRequests('CHECKED_OUT'), 'CHECKED_OUT locked');
  expect(!canEditReservationSpecialRequests('CANCELLED'), 'CANCELLED locked');

  const { app, createCanonicalBooking } = require('../dist/index');
  const { generateToken } = require('../dist/domains/auth/authService');
  const {
    ACCESS_RESOURCES,
    setRoleAccess,
  } = require('../dist/domains/settings/accessControlService');

  const server = http.createServer(app);
  const serverPort = await new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port));
  });

  const httpRequest = (method, reqPath, body = null, token = null) => new Promise((resolve, reject) => {
    const payloadStr = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (payloadStr) headers['Content-Length'] = Buffer.byteLength(payloadStr);
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request(
      { hostname: '127.0.0.1', port: serverPort, path: reqPath, method, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch (_e) { json = data; }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    if (payloadStr) req.write(payloadStr);
    req.end();
  });

  const suffix = Date.now();
  const propertyRes = await pool.query('SELECT id FROM properties ORDER BY id ASC LIMIT 2');
  const propertyId = Number(propertyRes.rows[0].id);
  const otherPropertyId = propertyRes.rows[1] ? Number(propertyRes.rows[1].id) : null;
  const checkIn = '2028-11-10';
  const checkOut = '2028-11-11';
  const roomTypeIds = [];
  const roomIds = [];
  const ratePlanIds = [];
  const bookingIds = [];
  const otaIds = [];
  const cleanupUserIds = [];
  const cleanupRoleIds = [];

  const fakeReq = (payload) => ({
    user: { username: 'FO.TEST', name: 'Front Office Test' },
    body: payload,
    headers: { 'x-correlation-id': `RCM-${suffix}` }
  });

  const createBooking = async (payload) => {
    try {
      const result = await createCanonicalBooking(fakeReq(payload), payload, payload.reservations, { requirePropertyId: true });
      return { ok: true, status: 201, result, error: null };
    } catch (err) {
      return { ok: false, status: Number(err.statusCode || 500), result: null, error: err };
    }
  };

  const cleanupBooking = async (bookingId) => {
    if (!bookingId) return;
    const resIds = await pool.query('SELECT id FROM reservations WHERE booking_id = $1', [bookingId]);
    const ids = resIds.rows.map((row) => row.id);
    if (ids.length) {
      await pool.query('DELETE FROM transaction_items WHERE transaction_id IN (SELECT id FROM transactions WHERE reservation_id = ANY($1::int[]))', [ids]).catch(() => {});
      await pool.query('DELETE FROM transactions WHERE reservation_id = ANY($1::int[])', [ids]).catch(() => {});
      await pool.query('DELETE FROM payment_evidences WHERE reservation_id = ANY($1::int[])', [ids]).catch(() => {});
      await pool.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [ids]).catch(() => {});
      await pool.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [ids]).catch(() => {});
      await pool.query('DELETE FROM reservation_rate_snapshots WHERE reservation_id = ANY($1::int[])', [ids]).catch(() => {});
      await pool.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1::int[])', [ids]).catch(() => {});
      await pool.query('DELETE FROM reservation_guests WHERE reservation_id = ANY($1::int[])', [ids]).catch(() => {});
      await pool.query('DELETE FROM availability_locks WHERE reservation_id = ANY($1::int[])', [ids]).catch(() => {});
      await pool.query('DELETE FROM audit_logs WHERE entity = $1 AND record_id = ANY($2::int[])', ['RESERVATION', ids]).catch(() => {});
      await pool.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [ids]);
    }
    await pool.query('DELETE FROM audit_logs WHERE entity = $1 AND record_id = $2', ['BOOKING', bookingId]).catch(() => {});
    await pool.query('DELETE FROM bookings WHERE id = $1', [bookingId]);
  };

  const snapshotFinancials = async (reservationId, roomTypeId) => {
    const reservation = await pool.query(
      `SELECT total_price, discount_amount, amount_paid, remaining_balance, rate_plan_id,
              check_in, check_out, room_id, status, subtotal_amount
       FROM reservations WHERE id = $1`,
      [reservationId]
    );
    const payments = await pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::numeric AS sum
       FROM payment_transactions WHERE reservation_id = $1`,
      [reservationId]
    ).catch(() => ({ rows: [{ count: 0, sum: 0 }] }));
    const folio = await pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::numeric AS sum
       FROM folio_entries WHERE reservation_id = $1`,
      [reservationId]
    ).catch(() => ({ rows: [{ count: 0, sum: 0 }] }));
    const inventory = await pool.query(
      `SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date`,
      [roomTypeId, checkIn]
    );
    return {
      reservation: reservation.rows[0],
      payments: payments.rows[0],
      folio: folio.rows[0],
      inventory: inventory.rows[0] ? Number(inventory.rows[0].reserved_qty) : null,
    };
  };

  const insertPricedRoom = async (canonicalGross) => {
    const index = roomIds.length;
    const typeName = `RCM Type ${suffix}-${index}`;
    const typeCode = `RCM-${suffix}-${index}`;
    const rt = await pool.query(
      `INSERT INTO room_types (property_id, code, name, base_rate, is_active)
       VALUES ($1, $2, $3, 500000, true) RETURNING id`,
      [propertyId, typeCode, typeName]
    );
    const roomTypeId = rt.rows[0].id;
    roomTypeIds.push(roomTypeId);
    const rm = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES ($1, $2, $3, $3, 'VACANT_CLEAN', true) RETURNING id`,
      [propertyId, roomTypeId, `RCM${index}-${String(suffix).slice(-4)}`]
    );
    const roomId = rm.rows[0].id;
    roomIds.push(roomId);
    const plan = await pool.query(
      `INSERT INTO rate_plans (property_id, room_type_id, code, name, base_rate, meal_plan, rate_type, is_active, sort_order)
       VALUES ($1, $2, $3, $4, $5, 'RO', 'OVERNIGHT', true, 0) RETURNING id`,
      [propertyId, roomTypeId, `${typeCode}-RO`, `DELUXE KING - RO`, canonicalGross]
    );
    const ratePlanId = plan.rows[0].id;
    ratePlanIds.push(ratePlanId);
    await pool.query(
      `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
       VALUES ($1, $2, $3::date, 5, 0)
       ON CONFLICT (room_type, date) DO UPDATE SET total_rooms = 5, reserved_qty = 0`,
      [roomTypeId, typeName, checkIn]
    );
    return { roomId, roomTypeId, ratePlanId, canonicalGross, typeName };
  };

  const childPayload = (priced, extras = {}) => ({
    room_id: priced.roomId,
    room_type_id: priced.roomTypeId,
    rate_plan_id: extras.rate_plan_id === undefined ? priced.ratePlanId : extras.rate_plan_id,
    check_in: checkIn,
    check_out: checkOut,
    stay_type: 'OVERNIGHT',
    guest_name: extras.guest_name || `RCM Guest ${suffix}`,
    guest_phone: '081200000088',
    guest_segment: 'Reguler',
    subtotal_amount: extras.subtotal_amount ?? priced.canonicalGross,
    total_price: extras.total_price ?? priced.canonicalGross,
    is_manual_override: Boolean(extras.is_manual_override),
    qty: 1,
    ...extras,
  });

  const bookingPayload = (overrides) => ({
    property_id: propertyId,
    guest_name: `RCM Guest ${suffix}`,
    guest_phone: '081200000088',
    guest_segment: 'Reguler',
    booking_source: 'WALKIN',
    booking_channel: 'WALK_IN',
    has_valid_identity: true,
    identity_number: '3171010101990088',
    ktp_path: '/uploads/ktp-rcm.jpg',
    payment_method: 'CASH',
    amount_paid: 0,
    ...overrides,
  });

  let saUser = null;
  let allowToken = null;
  let denyToken = null;

  try {
    const saRes = await pool.query(`
      SELECT u.id, u.username, u.full_name, u.email, r.id AS role_id, r.name AS role
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE r.name = 'Super Admin' AND r.property_id IS NULL AND r.is_system_role = TRUE
      LIMIT 1
    `);
    expect(saRes.rows.length > 0, 'Platform Super Admin exists for HTTP tests');
    saUser = saRes.rows[0];
    allowToken = generateToken({
      id: saUser.id,
      email: saUser.email || 'sa@test.local',
      username: saUser.username,
      full_name: saUser.full_name || saUser.username,
      role: saUser.role,
      role_id: saUser.role_id,
      property_id: propertyId,
      scope: 'FULL',
      access_type: 'PMS_STAFF',
    });

    const denyRole = await pool.query(
      `INSERT INTO roles (property_id, name, description, is_active, is_system_role, is_test_data)
       VALUES ($1, $2, $3, TRUE, FALSE, TRUE) RETURNING id`,
      [propertyId, `RCM_DENY_${suffix}`, 'RCM deny Kalender edit']
    );
    cleanupRoleIds.push(denyRole.rows[0].id);
    const grid = {};
    for (const resource of ACCESS_RESOURCES) {
      grid[resource.key] = { view: false, edit: false, delete: false };
    }
    const actor = {
      id: saUser.id,
      name: saUser.full_name || saUser.username,
      property_id: propertyId,
      is_platform_super_admin: true,
    };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await setRoleAccess(client, propertyId, denyRole.rows[0].id, grid, actor);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    const denyUser = await pool.query(
      `INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active, is_test_data)
       VALUES ($1, $2, $3, $4, 'x', $5, TRUE, TRUE) RETURNING id, username, full_name, email`,
      [propertyId, denyRole.rows[0].id, `rcm_deny_${suffix}`, `rcm_deny_${suffix}@test.local`, 'RCM Deny']
    );
    cleanupUserIds.push(denyUser.rows[0].id);
    denyToken = generateToken({
      id: denyUser.rows[0].id,
      email: denyUser.rows[0].email,
      username: denyUser.rows[0].username,
      full_name: denyUser.rows[0].full_name,
      role: 'RCM Deny',
      role_id: denyRole.rows[0].id,
      property_id: propertyId,
      scope: 'FULL',
      access_type: 'PMS_STAFF',
    });

    const walkinRoom = await insertPricedRoom(385000);
    const walkinCreated = await createBooking(bookingPayload({
      special_requests: '  Late arrival, high floor  ',
      reservations: [childPayload(walkinRoom, { special_requests: '  Late arrival, high floor  ' })],
    }));
    expect(walkinCreated.ok, `F. walk-in create succeeded: ${walkinCreated.error?.message || ''}`);
    const walkinBookingId = walkinCreated.result.booking.id;
    bookingIds.push(walkinBookingId);
    const walkinRes = walkinCreated.result.reservations[0];
    const walkinPersisted = await pool.query(
      'SELECT special_requests, rate_plan_name_snapshot, rate_plan_id FROM reservations WHERE id = $1',
      [walkinRes.id]
    );
    expect(walkinPersisted.rows[0].special_requests === 'Late arrival, high floor', 'F. Quick Booking special_requests persisted trimmed');
    console.log('  ✓ F. special_requests persisted on create');

    const walkinGet = await httpRequest(
      'GET',
      `/api/reservations/${walkinRes.id}?property_id=${propertyId}`,
      null,
      allowToken
    );
    expect(walkinGet.status === 200, `GET walk-in detail ${walkinGet.status}`);
    expect(String(walkinGet.body?.data?.booking_source || '').toUpperCase() === 'WALKIN', 'A. GET booking_source is WALKIN');
    expect(!walkinGet.body?.data?.ota_source_name, 'A. walk-in has no ota_source_name');
    expect(
      String(walkinGet.body?.data?.rate_plan_name_snapshot || '') === 'DELUXE KING - RO' ||
        Number(walkinGet.body?.data?.rate_plan_id) === Number(walkinRoom.ratePlanId),
      'C. GET includes canonical rate plan snapshot/id'
    );
    expect(walkinGet.body?.data?.special_requests === 'Late arrival, high floor', 'GET returns special_requests');
    expect(Object.prototype.hasOwnProperty.call(walkinGet.body?.data || {}, 'is_manual_override'), 'GET includes manual override indicator');
    console.log('  ✓ A/C. walk-in GET enrichment');

    const ota = await pool.query(
      `INSERT INTO ota_sources (property_id, code, name, is_active)
       VALUES ($1, $2, 'TRIP.COM', TRUE) RETURNING id`,
      [propertyId, `RCM-TRIP-${suffix}`]
    );
    otaIds.push(ota.rows[0].id);
    const otaRoom = await insertPricedRoom(450000);
    const otaCreated = await createBooking(bookingPayload({
      booking_source: 'OTA',
      booking_channel: 'OTA',
      ota_source_id: ota.rows[0].id,
      special_requests: 'Airport pickup',
      reservations: [childPayload(otaRoom, {
        rate_plan_id: null,
        is_manual_override: true,
        manual_override_reason: 'OTA: TRIP.COM',
        ota_source_id: ota.rows[0].id,
        booking_type: 'OTA',
        special_requests: 'Airport pickup',
      })],
    }));
    expect(otaCreated.ok, `OTA create succeeded: ${otaCreated.error?.message || ''}`);
    bookingIds.push(otaCreated.result.booking.id);
    const otaRes = otaCreated.result.reservations[0];
    await pool.query(
      `UPDATE reservations
       SET rate_plan_id = NULL, rate_plan_code_snapshot = NULL, rate_plan_name_snapshot = NULL, is_manual_override = TRUE
       WHERE id = $1`,
      [otaRes.id]
    );
    const otaGet = await httpRequest(
      'GET',
      `/api/reservations/${otaRes.id}?property_id=${propertyId}`,
      null,
      allowToken
    );
    expect(otaGet.status === 200, `GET OTA detail ${otaGet.status}`);
    expect(otaGet.body?.data?.ota_source_name === 'TRIP.COM', 'B. GET ota_source_name comes from ota_sources.name');
    expect(otaGet.body?.data?.rate_plan_name_snapshot == null, 'E. OTA name is not stored as rate plan snapshot');
    expect(String(otaGet.body?.data?.rate_plan_name_snapshot || '') !== 'TRIP.COM', 'E. Rate Plan is not TRIP.COM');
    expect(otaGet.body?.data?.rate_plan_id == null, 'D. OTA/manual has null rate_plan_id');
    console.log('  ✓ B/D/E. OTA GET enrichment keeps source and rate plan separate');

    const multiA = await insertPricedRoom(300000);
    const multiB = await insertPricedRoom(320000);
    const multiCreated = await createBooking(bookingPayload({
      special_requests: 'Connecting rooms please',
      reservations: [
        childPayload(multiA),
        childPayload(multiB, { guest_name: `RCM Guest B ${suffix}` }),
      ],
    }));
    expect(multiCreated.ok, `G. multi-room create succeeded: ${multiCreated.error?.message || ''}`);
    bookingIds.push(multiCreated.result.booking.id);
    expect(multiCreated.result.reservations.length === 2, 'G. two child reservations created');
    const multiNotes = await pool.query(
      'SELECT special_requests FROM reservations WHERE booking_id = $1 ORDER BY id',
      [multiCreated.result.booking.id]
    );
    expect(multiNotes.rows.length === 2, 'G. two child rows');
    expect(multiNotes.rows.every((row) => row.special_requests === 'Connecting rooms please'), 'G. initial note copied to every child');
    console.log('  ✓ G. multi-room special_requests copied to each child');

    const unauth = await httpRequest(
      'PATCH',
      `/api/reservations/${walkinRes.id}/special-requests`,
      { property_id: propertyId, special_requests: 'no auth' }
    );
    expect(unauth.status === 401, `no auth => ${unauth.status}`);
    console.log('  ✓ no auth rejected');

    const denied = await httpRequest(
      'PATCH',
      `/api/reservations/${walkinRes.id}/special-requests`,
      { property_id: propertyId, special_requests: 'denied' },
      denyToken
    );
    expect(denied.status === 403, `P. missing edit permission => ${denied.status}`);
    console.log('  ✓ P. missing reservations.edit / Kalender edit rejected');

    const wrongProp = await httpRequest(
      'PATCH',
      `/api/reservations/${walkinRes.id}/special-requests`,
      { property_id: otherPropertyId || propertyId + 99, special_requests: 'wrong property' },
      allowToken
    );
    expect(wrongProp.status === 403, `O. wrong property => ${wrongProp.status}`);
    expect(wrongProp.body?.code === 'PROPERTY_MISMATCH', 'O. PROPERTY_MISMATCH');
    console.log('  ✓ O. wrong property rejected');

    const beforeFin = await snapshotFinancials(walkinRes.id, walkinRoom.roomTypeId);
    const bookedEdit = await httpRequest(
      'PATCH',
      `/api/reservations/${walkinRes.id}/special-requests`,
      { property_id: propertyId, special_requests: 'Late arrival, high floor, extra pillows' },
      allowToken
    );
    expect(bookedEdit.status === 200, `K. BOOKED edit => ${bookedEdit.status} ${JSON.stringify(bookedEdit.body)}`);
    expect(bookedEdit.body?.data?.special_requests === 'Late arrival, high floor, extra pillows', 'K. updated note returned');
    const afterFin = await snapshotFinancials(walkinRes.id, walkinRoom.roomTypeId);
    expect(Number(afterFin.reservation.total_price) === Number(beforeFin.reservation.total_price), 'S. pricing unchanged');
    expect(Number(afterFin.reservation.discount_amount) === Number(beforeFin.reservation.discount_amount), 'S. discount unchanged');
    expect(Number(afterFin.reservation.amount_paid) === Number(beforeFin.reservation.amount_paid), 'T. payments unchanged');
    expect(Number(afterFin.payments.count) === Number(beforeFin.payments.count), 'T. payment rows unchanged');
    expect(Number(afterFin.folio.count) === Number(beforeFin.folio.count), 'U. folio unchanged');
    expect(afterFin.inventory === beforeFin.inventory, 'V. inventory unchanged');
    expect(String(afterFin.reservation.rate_plan_id) === String(beforeFin.reservation.rate_plan_id), 'rate_plan_id unchanged');
    console.log('  ✓ K/S/T/U/V. BOOKED edit does not touch money, folio, or inventory');

    const auditRows = await pool.query(
      `SELECT action, new_value FROM audit_logs
       WHERE entity = 'RESERVATION' AND record_id = $1 AND action = $2
       ORDER BY timestamp DESC, audit_id DESC`,
      [String(walkinRes.id), SPECIAL_REQUESTS_AUDIT_ACTION]
    );
    expect(auditRows.rowCount >= 1, 'Q. audit row created');
    const auditPayload = typeof auditRows.rows[0].new_value === 'string'
      ? JSON.parse(auditRows.rows[0].new_value)
      : auditRows.rows[0].new_value;
    expect(Number(auditPayload.reservation_id) === Number(walkinRes.id), 'Q. audit has reservation_id');
    expect(Number(auditPayload.property_id) === Number(propertyId), 'Q. audit has property_id');
    expect(auditPayload.before === 'Late arrival, high floor', 'Q. audit before');
    expect(auditPayload.after === 'Late arrival, high floor, extra pillows', 'Q. audit after');
    expect(Boolean(auditPayload.actor), 'Q. audit actor');
    console.log('  ✓ Q. before/after audit created');

    const auditCountBeforeNoop = auditRows.rowCount;
    const noop = await httpRequest(
      'PATCH',
      `/api/reservations/${walkinRes.id}/special-requests`,
      { property_id: propertyId, special_requests: 'Late arrival, high floor, extra pillows' },
      allowToken
    );
    expect(noop.status === 200, `R. same-value update status ${noop.status}`);
    expect(noop.body?.unchanged === true, 'R. same-value is unchanged');
    const auditAfterNoop = await pool.query(
      `SELECT COUNT(*)::int AS count FROM audit_logs
       WHERE entity = 'RESERVATION' AND record_id = $1 AND action = $2`,
      [String(walkinRes.id), SPECIAL_REQUESTS_AUDIT_ACTION]
    );
    expect(Number(auditAfterNoop.rows[0].count) === Number(auditCountBeforeNoop), 'R. no extra audit on no-op');
    console.log('  ✓ R. same-value update skips mutation/audit');

    await pool.query(`UPDATE reservations SET status = 'CHECKED_IN' WHERE id = $1`, [walkinRes.id]);
    const checkedInEdit = await httpRequest(
      'PATCH',
      `/api/reservations/${walkinRes.id}/special-requests`,
      { property_id: propertyId, special_requests: 'Checked-in note' },
      allowToken
    );
    expect(checkedInEdit.status === 200, `L. CHECKED_IN edit => ${checkedInEdit.status}`);
    expect(checkedInEdit.body?.data?.special_requests === 'Checked-in note', 'L. CHECKED_IN note saved');
    console.log('  ✓ L. CHECKED_IN edit succeeds');

    await pool.query(`UPDATE reservations SET status = 'CHECKED_OUT' WHERE id = $1`, [walkinRes.id]);
    const checkedOutEdit = await httpRequest(
      'PATCH',
      `/api/reservations/${walkinRes.id}/special-requests`,
      { property_id: propertyId, special_requests: 'should fail checkout' },
      allowToken
    );
    expect(checkedOutEdit.status === 409, `M. CHECKED_OUT edit => ${checkedOutEdit.status}`);
    expect(checkedOutEdit.body?.code === SPECIAL_REQUESTS_STATUS_LOCKED, 'M. status locked code');
    console.log('  ✓ M. CHECKED_OUT edit blocked');

    await pool.query(`UPDATE reservations SET status = 'CANCELLED' WHERE id = $1`, [walkinRes.id]);
    const cancelledEdit = await httpRequest(
      'PATCH',
      `/api/reservations/${walkinRes.id}/special-requests`,
      { property_id: propertyId, special_requests: 'should fail cancel' },
      allowToken
    );
    expect(cancelledEdit.status === 409, `N. CANCELLED edit => ${cancelledEdit.status}`);
    expect(cancelledEdit.body?.code === SPECIAL_REQUESTS_STATUS_LOCKED, 'N. status locked code');
    console.log('  ✓ N. CANCELLED edit blocked');

    console.log('\nRESERVATION-CONTEXT-METADATA-1 backend passed');
  } finally {
    for (const bookingId of bookingIds.reverse()) {
      await cleanupBooking(bookingId);
    }
    if (otaIds.length) {
      await pool.query('DELETE FROM ota_sources WHERE id = ANY($1::int[])', [otaIds]).catch(() => {});
    }
    if (roomIds.length) {
      await pool.query('DELETE FROM rooms WHERE id = ANY($1::int[])', [roomIds]).catch(() => {});
    }
    if (ratePlanIds.length) {
      await pool.query('DELETE FROM rate_plans WHERE id = ANY($1::int[])', [ratePlanIds]).catch(() => {});
    }
    if (roomTypeIds.length) {
      await pool.query('DELETE FROM availability_locks WHERE room_type_id = ANY($1::int[])', [roomTypeIds]).catch(() => {});
      await pool.query('DELETE FROM availability_dates WHERE room_type_id = ANY($1::int[])', [roomTypeIds]).catch(() => {});
      await pool.query('DELETE FROM room_types WHERE id = ANY($1::int[])', [roomTypeIds]).catch(() => {});
    }
    if (cleanupUserIds.length) {
      await pool.query('DELETE FROM user_permission_overrides WHERE user_id = ANY($1::int[])', [cleanupUserIds]).catch(() => {});
      await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanupUserIds]).catch(() => {});
    }
    if (cleanupRoleIds.length) {
      await pool.query('DELETE FROM role_permissions WHERE role_id = ANY($1::int[])', [cleanupRoleIds]).catch(() => {});
      await pool.query('DELETE FROM roles WHERE id = ANY($1::int[])', [cleanupRoleIds]).catch(() => {});
    }
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
}

run().catch((err) => {
  console.error('\nTEST FAILURE:', err);
  process.exitCode = 1;
});
