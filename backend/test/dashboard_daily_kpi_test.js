'use strict';

require('dotenv').config({ path: 'e:/oak-hotel-hims/backend/.env' });
const http = require('http');
const { once } = require('events');
const { app, pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');

let server;
let baseUrl;
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`PASS | ${message}`);
    passed++;
  } else {
    console.error(`FAIL | ${message}`);
    failed++;
  }
}

let authToken = '';

async function api(method, path) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch(baseUrl + path, { method, headers });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function kpis(propertyId, date) {
  const qs = date
    ? `/api/reports/daily-kpis?property_id=${propertyId}&date=${date}`
    : `/api/reports/daily-kpis?property_id=${propertyId}`;
  return api('GET', qs);
}

async function insertBooking(propertyId, bid, guest, createdAt) {
  const res = await pool.query(
    `INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status, created_at)
     VALUES ($1, $2, $3, 'ACTIVE', $4::timestamptz)
     RETURNING id`,
    [bid, propertyId, guest, createdAt]
  );
  return res.rows[0].id;
}

async function insertReservation(params) {
  const {
    bookingId, staySequence, roomId, guest, checkIn, checkOut, status,
    stayType, checkedInAt, checkedOutAt, roomTypeId, bookingNumber
  } = params;
  const res = await pool.query(
    `INSERT INTO reservations (
      booking_id, stay_sequence, room_id, guest_name, check_in, check_out,
      total_price, amount_paid, remaining_balance, status, payment_status,
      booked_room_type_id_snapshot, booked_room_type_name_snapshot,
      stay_type, checked_in_at, checked_out_at, booking_number
    ) VALUES (
      $1, $2, $3, $4, $5::date, $6::date,
      500000, 0, 500000, $7, 'UNPAID',
      $8, 'KPI Type',
      $9, $10, $11, $12
    ) RETURNING id`,
    [
      bookingId,
      staySequence || 1,
      roomId || null,
      guest,
      checkIn,
      checkOut,
      status,
      roomTypeId,
      stayType || 'OVERNIGHT',
      checkedInAt || null,
      checkedOutAt || null,
      bookingNumber
    ]
  );
  return res.rows[0].id;
}

async function main() {
  console.log('=== DASHBOARD-DAILY-KPI-1 Tests ===\n');

  server = http.createServer(app);
  server.listen(0);
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const rand = String(1000 + Math.floor(Math.random() * 8999));
  const stamp = `${rand}${String(Date.now()).slice(-4)}`;
  const D = '2026-09-07';
  const codeA = `KA${rand}`;
  const codeB = `KB${rand}`;
  const createdToday = '2026-09-06T17:30:00.000Z';
  const createdOld = '2026-09-01T03:00:00.000Z';
  const ciToday = '2026-09-06T17:00:00.000Z';
  const ciYesterday = '2026-09-06T16:59:59.000Z';
  const coToday = '2026-09-07T05:00:00.000Z';

  let propA = null;
  let propB = null;
  let rtA = null;
  let rtB = null;
  const roomsA = [];
  const roomsB = [];
  const bookingIds = [];
  const reservationIds = [];
  const blockIds = [];
  const taskIds = [];
  const moveIds = [];

  try {
    const propARes = await pool.query(
      "INSERT INTO properties (property_code, name, address, is_active, timezone) VALUES ($1, 'KPI Prop A', 'A', TRUE, 'Asia/Jakarta') RETURNING id",
      [codeA]
    );
    propA = propARes.rows[0].id;
    const propBRes = await pool.query(
      "INSERT INTO properties (property_code, name, address, is_active, timezone) VALUES ($1, 'KPI Prop B', 'B', TRUE, 'Asia/Jakarta') RETURNING id",
      [codeB]
    );
    propB = propBRes.rows[0].id;

    const saRes = await pool.query(`
      SELECT u.id, u.username, u.email, u.full_name, u.role_id
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE r.name = 'Super Admin' AND COALESCE(u.is_active, TRUE) = TRUE
      LIMIT 1
    `);
    if (!saRes.rows[0]) {
      throw new Error('KPI tests require an active Super Admin user');
    }
    const sa = saRes.rows[0];
    authToken = generateToken({
      id: Number(sa.id),
      email: sa.email || 'kpi@test.local',
      username: sa.username || 'kpi-sa',
      full_name: sa.full_name || 'KPI Super Admin',
      role: 'Super Admin',
      role_id: sa.role_id,
      property_id: propA,
      scope: 'FULL'
    });

    const unauth = await fetch(`${baseUrl}/api/reports/daily-kpis?property_id=${propA}`);
    assert(unauth.status === 401, 'unauthenticated daily-kpis returns 401');

    const rtARes = await pool.query(
      "INSERT INTO room_types (property_id, code, name, base_rate, capacity) VALUES ($1, 'KTA', 'KPI Type A', 500000, 2) RETURNING id",
      [propA]
    );
    rtA = rtARes.rows[0].id;
    const rtBRes = await pool.query(
      "INSERT INTO room_types (property_id, code, name, base_rate, capacity) VALUES ($1, 'KTB', 'KPI Type B', 500000, 2) RETURNING id",
      [propB]
    );
    rtB = rtBRes.rows[0].id;

    const statusesA = [
      'VACANT_CLEAN',
      'VACANT_DIRTY',
      'OCCUPIED_DIRTY',
      'INSPECTED',
      'Ready',
      'OCCUPIED_CLEAN',
      'OUT_OF_ORDER',
      'VACANT_CLEAN'
    ];
    for (let i = 0; i < statusesA.length; i++) {
      const row = await pool.query(
        "INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active) VALUES ($1, $2, $3, 'KPI Room', $4, true) RETURNING id",
        [propA, rtA, `KA-${stamp}-${i + 1}`, statusesA[i]]
      );
      roomsA.push(row.rows[0].id);
    }
    await pool.query(
      "INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active) VALUES ($1, $2, $3, 'Inactive', 'VACANT_CLEAN', false)",
      [propA, rtA, `KA-${stamp}-INACT`]
    );
    const rB = await pool.query(
      "INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active) VALUES ($1, $2, $3, 'KPI B', 'VACANT_CLEAN', true) RETURNING id",
      [propB, rtB, `KB-${stamp}-1`]
    );
    roomsB.push(rB.rows[0].id);

    console.log('--- Validation ---');
    const noProp = await kpis();
    assert(noProp.status === 400, 'missing property_id returns 400');
    const badDate = await api('GET', `/api/reports/daily-kpis?property_id=${propA}&date=not-a-date`);
    assert(badDate.status === 400, 'invalid date returns 400');
    const missing = await api('GET', '/api/reports/daily-kpis?property_id=888888');
    assert(missing.status === 404, 'unknown property returns 404');

    console.log('--- R/S room status cards (empty occupancy) ---');
    const base = await kpis(propA, D);
    assert(base.status === 200, 'daily-kpis 200');
    const data0 = base.body.data;
    assert(data0.business_date === D, 'business_date is requested hotel date');
    assert(data0.timezone === 'Asia/Jakarta', 'timezone from property');
    assert(data0.rooms.vacant_clean === 2, 'R. vacant_clean counts exact VACANT_CLEAN only (excludes INSPECTED/Ready)');
    assert(data0.rooms.dirty === 2, 'S. dirty includes VACANT_DIRTY + OCCUPIED_DIRTY');
    assert(data0.occupancy.ooo_oos_rooms === 1, 'initial OOO status room counted once');
    assert(data0.occupancy.sellable_rooms === 7, 'sellable = 8 active - 1 OOO');
    assert(data0.occupancy.occupied_rooms === 0, 'no occupying stays yet');
    assert(data0.rooms.maintenance_ooo_oos === 1, 'maintenance card uses OOO/OOS set');

    console.log('--- A. single CHECKED_IN occupancy ---');
    const bA = await insertBooking(propA, `KPI-A-${stamp}`, 'Single CI', createdOld);
    bookingIds.push(bA);
    const rA = await insertReservation({
      bookingId: bA, staySequence: 1, roomId: roomsA[5], guest: 'Single CI',
      checkIn: '2026-09-06', checkOut: '2026-09-08', status: 'CHECKED_IN',
      stayType: 'OVERNIGHT', checkedInAt: ciYesterday, roomTypeId: rtA,
      bookingNumber: `KPI-RA-${stamp}`
    });
    reservationIds.push(rA);
    const aRes = await kpis(propA, D);
    assert(aRes.body.data.occupancy.occupied_rooms === 1, 'A. CHECKED_IN occupying D => occupancy +1');

    console.log('--- B. one BID three children ---');
    const bMulti = await insertBooking(propA, `KPI-M-${stamp}`, 'Multi', createdOld);
    bookingIds.push(bMulti);
    for (let i = 0; i < 3; i++) {
      const id = await insertReservation({
        bookingId: bMulti, staySequence: i + 1, roomId: null, guest: `Multi ${i + 1}`,
        checkIn: '2026-09-07', checkOut: '2026-09-09', status: 'BOOKED',
        stayType: 'OVERNIGHT', roomTypeId: rtA,
        bookingNumber: `KPI-RM-${stamp}-${i}`
      });
      reservationIds.push(id);
    }
    const bRes = await kpis(propA, D);
    assert(bRes.body.data.occupancy.occupied_rooms === 4, 'B. 1 existing + 3 children => occupancy 4');

    console.log('--- C. cancelled excluded ---');
    const bCan = await insertBooking(propA, `KPI-C-${stamp}`, 'Cancelled', createdToday);
    await pool.query("UPDATE bookings SET booking_status = 'CANCELLED' WHERE id = $1", [bCan]);
    bookingIds.push(bCan);
    const rCan = await insertReservation({
      bookingId: bCan, staySequence: 1, roomId: roomsA[0], guest: 'Cancelled',
      checkIn: '2026-09-07', checkOut: '2026-09-08', status: 'CANCELLED',
      stayType: 'OVERNIGHT', roomTypeId: rtA, bookingNumber: `KPI-RC-${stamp}`
    });
    reservationIds.push(rCan);
    const cRes = await kpis(propA, D);
    assert(cRes.body.data.occupancy.occupied_rooms === 4, 'C. cancelled booking/child excluded from occupancy');
    assert(cRes.body.data.booked_today.bookings === 0, 'C. cancelled booking excluded from booked-today');

    console.log('--- D. checked-out excluded from occupancy ---');
    const bOut = await insertBooking(propA, `KPI-D-${stamp}`, 'Checked Out', createdOld);
    bookingIds.push(bOut);
    const rOut = await insertReservation({
      bookingId: bOut, staySequence: 1, roomId: roomsA[0], guest: 'Checked Out',
      checkIn: '2026-09-06', checkOut: '2026-09-10', status: 'CHECKED_OUT',
      stayType: 'OVERNIGHT', checkedInAt: ciToday, checkedOutAt: coToday,
      roomTypeId: rtA, bookingNumber: `KPI-RD-${stamp}`
    });
    reservationIds.push(rOut);
    const dRes = await kpis(propA, D);
    assert(dRes.body.data.occupancy.occupied_rooms === 4, 'D. CHECKED_OUT excluded from occupancy even if dates still overlap');

    console.log('--- E/P. OOO block sellable ---');
    const blockDup = await pool.query(
      `INSERT INTO room_operational_blocks (
        property_id, room_id, room_type_id, block_type, start_date, end_date, reason, status
      ) VALUES ($1, $2, $3, 'OUT_OF_ORDER', $4::date, $5::date, 'KPI overlap', 'ACTIVE')
      RETURNING id`,
      [propA, roomsA[6], rtA, D, '2026-09-09']
    );
    blockIds.push(blockDup.rows[0].id);
    const pRes = await kpis(propA, D);
    assert(pRes.body.data.occupancy.ooo_oos_rooms === 1, 'P. OOO status + block on same room subtracts once');
    assert(pRes.body.data.occupancy.sellable_rooms === 7, 'P. sellable unchanged when same room blocked twice');

    const blockNew = await pool.query(
      `INSERT INTO room_operational_blocks (
        property_id, room_id, room_type_id, block_type, start_date, end_date, reason, status
      ) VALUES ($1, $2, $3, 'OUT_OF_SERVICE', $4::date, $5::date, 'KPI extra', 'ACTIVE')
      RETURNING id`,
      [propA, roomsA[7], rtA, D, '2026-09-08']
    );
    blockIds.push(blockNew.rows[0].id);
    const eRes = await kpis(propA, D);
    assert(eRes.body.data.occupancy.ooo_oos_rooms === 2, 'E. additional OOS block reduces sellable');
    assert(eRes.body.data.occupancy.sellable_rooms === 6, 'E. sellable 8-2=6');
    assert(eRes.body.data.rooms.maintenance_ooo_oos === 2, 'E. maintenance matches blocked set');

    console.log('--- F/G check-in today vs planned ---');
    await pool.query(
      'UPDATE reservations SET checked_in_at = $1::timestamptz WHERE id = $2',
      [ciToday, rA]
    );
    const fRes = await kpis(propA, D);
    assert(fRes.body.data.check_in_today.rooms === 2, 'F. actual checked_in_at today counted (single CI + checked-out same-day CI)');

    const bPlan = await insertBooking(propA, `KPI-G-${stamp}`, 'Planned only', createdOld);
    bookingIds.push(bPlan);
    const rPlan = await insertReservation({
      bookingId: bPlan, staySequence: 1, roomId: null, guest: 'Planned only',
      checkIn: D, checkOut: '2026-09-08', status: 'BOOKED',
      stayType: 'OVERNIGHT', roomTypeId: rtA, bookingNumber: `KPI-RG-${stamp}`
    });
    reservationIds.push(rPlan);
    const gRes = await kpis(propA, D);
    assert(gRes.body.data.check_in_today.rooms === 2, 'G. planned arrival without checked_in_at not counted');
    assert(gRes.body.data.occupancy.occupied_rooms === 5, 'G. planned BOOKED occupying D still in occupancy');

    console.log('--- H/I check-out today vs planned ---');
    const hRes = await kpis(propA, D);
    assert(hRes.body.data.check_out_today.rooms === 1, 'H. actual checked_out_at today counted');

    const bStay = await insertBooking(propA, `KPI-I-${stamp}`, 'Stayover', createdOld);
    bookingIds.push(bStay);
    const rStay = await insertReservation({
      bookingId: bStay, staySequence: 1, roomId: null, guest: 'Stayover',
      checkIn: '2026-09-05', checkOut: D, status: 'CHECKED_IN',
      stayType: 'OVERNIGHT', checkedInAt: createdOld, roomTypeId: rtA,
      bookingNumber: `KPI-RI-${stamp}`
    });
    reservationIds.push(rStay);
    const iRes = await kpis(propA, D);
    assert(iRes.body.data.check_out_today.rooms === 1, 'I. planned departure without checkout timestamp not counted');
    assert(iRes.body.data.occupancy.occupied_rooms === 5, 'I. stayover with check_out=D does not occupy D (half-open)');

    console.log('--- J/K booked today vs old BOOKED ---');
    const bNew = await insertBooking(propA, `KPI-J-${stamp}`, 'New sale', createdToday);
    bookingIds.push(bNew);
    for (let i = 0; i < 2; i++) {
      const id = await insertReservation({
        bookingId: bNew, staySequence: i + 1, roomId: null, guest: `New ${i + 1}`,
        checkIn: '2026-09-10', checkOut: '2026-09-12', status: 'BOOKED',
        stayType: 'OVERNIGHT', roomTypeId: rtA, bookingNumber: `KPI-RJ-${stamp}-${i}`
      });
      reservationIds.push(id);
    }
    const jRes = await kpis(propA, D);
    assert(jRes.body.data.booked_today.rooms === 2, 'J. booking created today 2 children => 2 rooms');
    assert(jRes.body.data.booked_today.bookings === 1, 'J. booking created today => 1 booking');
    assert(jRes.body.data.occupancy.occupied_rooms === 5, 'K. old BOOKED occupying D is occupancy not booked-today');
    assert(jRes.body.data.booked_today.bookings === 1, 'K. old BOOKED stock not in booked-today');

    console.log('--- L. DAY_USE ---');
    const bDu = await insertBooking(propA, `KPI-L-${stamp}`, 'Day use', createdToday);
    bookingIds.push(bDu);
    const rDu = await insertReservation({
      bookingId: bDu, staySequence: 1, roomId: null, guest: 'Day use',
      checkIn: D, checkOut: D, status: 'CHECKED_IN',
      stayType: 'DAY_USE', checkedInAt: ciToday, roomTypeId: rtA,
      bookingNumber: `KPI-RL-${stamp}`
    });
    reservationIds.push(rDu);
    const lRes = await kpis(propA, D);
    assert(lRes.body.data.occupancy.occupied_rooms === 6, 'L. DAY_USE CHECKED_IN occupying D included');
    assert(lRes.body.data.check_in_today.rooms === 3, 'L. DAY_USE checked_in_at today counted');
    assert(lRes.body.data.booked_today.rooms === 3, 'L. DAY_USE booking created today included');

    await pool.query(
      `UPDATE reservations
       SET status = 'CHECKED_OUT', checked_out_at = $1::timestamptz
       WHERE id = $2`,
      [coToday, rDu]
    );
    const lOut = await kpis(propA, D);
    assert(lOut.body.data.occupancy.occupied_rooms === 5, 'L. DAY_USE after checkout excluded from occupancy');
    assert(lOut.body.data.check_in_today.rooms === 3, 'L. same-day CI remains after checkout');
    assert(lOut.body.data.check_out_today.rooms === 2, 'L. DAY_USE checkout today counted');

    console.log('--- M. room move no double count ---');
    const move = await pool.query(
      `INSERT INTO reservation_room_moves (
        reservation_id, property_id, from_room_id, to_room_id,
        from_room_type_id, to_room_type_id, effective_from_date,
        moved_by, reason_category, reason_detail, pricing_treatment,
        old_rate_context, new_rate_context, idempotency_key
      ) VALUES (
        $1, $2, $3, $4, $5, $5, $6::date,
        'kpi-test', 'OPERATIONAL', 'KPI room move fixture', 'KEEP_CURRENT_RATE',
        '{}'::jsonb, '{}'::jsonb, $7
      ) RETURNING id`,
      [rA, propA, roomsA[5], roomsA[0], rtA, D, `kpi-move-${stamp}`]
    );
    moveIds.push(move.rows[0].id);
    const mRes = await kpis(propA, D);
    assert(mRes.body.data.occupancy.occupied_rooms === 5, 'M. room move history does not double-count occupancy');

    console.log('--- N. property isolation ---');
    const bB = await insertBooking(propB, `KPI-B-${stamp}`, 'Prop B', createdToday);
    bookingIds.push(bB);
    const rBstay = await insertReservation({
      bookingId: bB, staySequence: 1, roomId: roomsB[0], guest: 'Prop B',
      checkIn: '2026-09-06', checkOut: '2026-09-09', status: 'CHECKED_IN',
      stayType: 'OVERNIGHT', checkedInAt: ciToday, roomTypeId: rtB,
      bookingNumber: `KPI-RB-${stamp}`
    });
    reservationIds.push(rBstay);
    const nA = await kpis(propA, D);
    const nB = await kpis(propB, D);
    assert(nB.body.data.occupancy.occupied_rooms === 1, 'N. property B occupancy isolated');
    assert(nB.body.data.booked_today.bookings === 1, 'N. property B booked-today isolated');
    assert(nA.body.data.occupancy.occupied_rooms === 5, 'N. property A occupancy unchanged by B');
    assert(nB.body.data.rooms.vacant_clean === 1, 'N. property B room cards isolated');

    console.log('--- O. timezone midnight boundary ---');
    const bTz = await insertBooking(propA, `KPI-O-${stamp}`, 'TZ boundary', createdOld);
    bookingIds.push(bTz);
    const rTz = await insertReservation({
      bookingId: bTz, staySequence: 1, roomId: null, guest: 'TZ boundary',
      checkIn: '2026-09-05', checkOut: '2026-09-06', status: 'CHECKED_IN',
      stayType: 'OVERNIGHT', checkedInAt: ciYesterday, roomTypeId: rtA,
      bookingNumber: `KPI-RO-${stamp}`
    });
    reservationIds.push(rTz);
    const oRes = await kpis(propA, D);
    const oY = await kpis(propA, '2026-09-06');
    assert(oRes.body.data.check_in_today.rooms === 3, 'O. 17:00Z Sep 6 is Sep 7 Jakarta check-in');
    assert(oY.body.data.check_in_today.rooms >= 1, 'O. 16:59:59Z Sep 6 stays on Sep 6 Jakarta');

    console.log('--- Q. checkout-check pending > 20 ---');
    for (let i = 0; i < 25; i++) {
      const task = await pool.query(
        `INSERT INTO housekeeping_tasks (
          property_id, task_type, task_category, title, room_id, status, source_type, notes
        ) VALUES (
          $1, 'CHECKOUT_ROOM_CHECK', 'CHECKOUT_INSPECTION', $2, $3, 'ASSIGNED', 'FRONT_OFFICE', 'KPI_CHK'
        ) RETURNING id`,
        [propA, `KPI_CHK_${stamp}_${i}`, roomsA[0]]
      );
      taskIds.push(task.rows[0].id);
    }
    await pool.query(
      `INSERT INTO housekeeping_tasks (
        property_id, task_type, task_category, title, room_id, status, source_type, notes
      ) VALUES (
        $1, 'CHECKOUT_ROOM_CHECK', 'CHECKOUT_INSPECTION', $2, $3, 'DONE', 'FRONT_OFFICE', 'KPI_CHK_DONE'
      )`,
      [propA, `KPI_CHK_DONE_${stamp}`, roomsA[0]]
    );
    const qRes = await kpis(propA, D);
    assert(qRes.body.data.checkout_check.pending === 25, 'Q. pending checkout-check is exact 25, not capped at 20');

    console.log('--- T. sellable 0 => pct null ---');
    const codeZ = `KZ${stamp.slice(0, 4)}`;
    const propZRes = await pool.query(
      "INSERT INTO properties (property_code, name, is_active, timezone) VALUES ($1, 'KPI Zero', TRUE, 'Asia/Jakarta') RETURNING id",
      [codeZ]
    );
    const propZ = propZRes.rows[0].id;
    const rtZ = (await pool.query(
      "INSERT INTO room_types (property_id, code, name, base_rate) VALUES ($1, 'KTZ', 'Zero Type', 1) RETURNING id",
      [propZ]
    )).rows[0].id;
    await pool.query(
      "INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active) VALUES ($1, $2, $3, 'OOO', 'OUT_OF_ORDER', true)",
      [propZ, rtZ, `KZ-${stamp}`]
    );
    const bZ = await insertBooking(propZ, `KPI-Z-${stamp}`, 'Unassigned', createdOld);
    bookingIds.push(bZ);
    const rZ = await insertReservation({
      bookingId: bZ, staySequence: 1, roomId: null, guest: 'Unassigned',
      checkIn: D, checkOut: '2026-09-08', status: 'BOOKED',
      stayType: 'OVERNIGHT', roomTypeId: rtZ, bookingNumber: `KPI-RZ-${stamp}`
    });
    reservationIds.push(rZ);
    const tRes = await kpis(propZ, D);
    assert(tRes.body.data.occupancy.occupied_rooms === 1, 'T. unassigned occupying child still counts');
    assert(tRes.body.data.occupancy.sellable_rooms === 0, 'T. sellable 0 when only OOO room');
    assert(tRes.body.data.occupancy.occupancy_pct === null, 'T. occupancy_pct is null when sellable is 0');

    await pool.query('DELETE FROM reservations WHERE id = $1', [rZ]);
    reservationIds.pop();
    await pool.query('DELETE FROM bookings WHERE id = $1', [bZ]);
    bookingIds.pop();
    await pool.query('DELETE FROM rooms WHERE property_id = $1', [propZ]);
    await pool.query('DELETE FROM room_types WHERE id = $1', [rtZ]);
    await pool.query('DELETE FROM properties WHERE id = $1', [propZ]);

    console.log('--- Occupancy percent rounding ---');
    const pct = eRes.body.data.occupancy.occupancy_pct;
    assert(typeof pct === 'number', 'occupancy_pct is a number when sellable > 0');
  } catch (err) {
    console.error('\n[FATAL]', err);
    failed++;
  } finally {
    try {
      if (moveIds.length) await pool.query('DELETE FROM reservation_room_moves WHERE id = ANY($1::int[])', [moveIds]);
      if (taskIds.length) await pool.query('DELETE FROM housekeeping_tasks WHERE id = ANY($1::int[])', [taskIds]);
      await pool.query("DELETE FROM housekeeping_tasks WHERE notes IN ('KPI_CHK', 'KPI_CHK_DONE') OR title LIKE 'KPI_CHK_%'");
      if (reservationIds.length) await pool.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [reservationIds]);
      if (bookingIds.length) await pool.query('DELETE FROM bookings WHERE id = ANY($1::int[])', [bookingIds]);
      if (blockIds.length) await pool.query('DELETE FROM room_operational_blocks WHERE id = ANY($1::int[])', [blockIds]);
      if (propA) {
        await pool.query('DELETE FROM rooms WHERE property_id = $1', [propA]);
        await pool.query('DELETE FROM room_types WHERE property_id = $1', [propA]);
        await pool.query('DELETE FROM properties WHERE id = $1', [propA]);
      }
      if (propB) {
        await pool.query('DELETE FROM rooms WHERE property_id = $1', [propB]);
        await pool.query('DELETE FROM room_types WHERE property_id = $1', [propB]);
        await pool.query('DELETE FROM properties WHERE id = $1', [propB]);
      }
    } catch (cleanupErr) {
      console.error('cleanup error', cleanupErr);
    }
    server.close();
    await pool.end();
  }

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
