#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');

const p = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db',
});

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log('PASS | ' + label);
  } else {
    failed += 1;
    console.log('FAIL | ' + label);
  }
}

let server;
let baseUrl;

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${path}`, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

let propAId, propBId;
let catAId;
let typeAId;
let roomA1Id, roomA2Id;
let bookingAId, reservationAId;
const cleanupErrors = [];

async function cleanup(client) {
  const safe = async (label, sql, params) => {
    try { await client.query(sql, params); }
    catch (e) { cleanupErrors.push(`${label}: ${e.message}`); console.error(`  CLEANUP WARN: ${label}: ${e.message}`); }
  };
  // FK-safe order: reservations first (they reference bookings AND rooms)
  if (reservationAId) await safe('delete reservation', 'DELETE FROM reservations WHERE id = $1', [reservationAId]);
  if (bookingAId) await safe('delete booking', 'DELETE FROM bookings WHERE id = $1', [bookingAId]);
  if (roomA2Id) await safe('delete room A2', 'DELETE FROM rooms WHERE id = $1', [roomA2Id]);
  if (roomA1Id) await safe('delete room A1', 'DELETE FROM rooms WHERE id = $1', [roomA1Id]);
  if (typeAId) {
    await safe('delete locks', 'DELETE FROM availability_locks WHERE room_type_id = $1', [typeAId]);
    await safe('delete avail dates', 'DELETE FROM availability_dates WHERE room_type_id = $1', [typeAId]);
    await safe('delete room type', 'DELETE FROM room_types WHERE id = $1', [typeAId]);
  }
  if (catAId) await safe('delete category', 'DELETE FROM room_categories WHERE id = $1', [catAId]);
  if (propAId) await safe('delete property A', 'DELETE FROM properties WHERE id = $1', [propAId]);
  if (propBId) await safe('delete property B', 'DELETE FROM properties WHERE id = $1', [propBId]);
}

async function verifyResidue(absent_client) {
  const ids = [
    reservationAId && { tbl: 'reservations', id: reservationAId },
    bookingAId && { tbl: 'bookings', id: bookingAId },
    roomA1Id && { tbl: 'rooms', id: roomA1Id },
    roomA2Id && { tbl: 'rooms', id: roomA2Id },
    typeAId && { tbl: 'room_types', id: typeAId },
    catAId && { tbl: 'room_categories', id: catAId },
    propAId && { tbl: 'properties', id: propAId },
    propBId && { tbl: 'properties', id: propBId },
  ].filter(Boolean);
  const residue = [];
  for (const { tbl, id } of ids) {
    const r = await absent_client.query(`SELECT 1 FROM ${tbl} WHERE id = $1`, [id]);
    if (r.rowCount > 0) residue.push(`${tbl}#${id}`);
  }
  return residue;
}

async function main() {
  const { initializeDatabase } = require('../dist/db/schema_v3');
  const { app, pool } = require('../dist/index');

  await initializeDatabase(pool);

  // Ensure is_active column exists on properties (added in BOOTSTRAP-1B)
  await p.query("ALTER TABLE properties ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE");

  // Clean up any residue from prior runs
  await p.query("DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id IN (SELECT id FROM properties WHERE property_code IN ('RVXA','RVXB')))");
  await p.query("DELETE FROM bookings WHERE property_id IN (SELECT id FROM properties WHERE property_code IN ('RVXA','RVXB'))");
  await p.query("DELETE FROM availability_locks WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id IN (SELECT id FROM properties WHERE property_code IN ('RVXA','RVXB')))");
  await p.query("DELETE FROM availability_dates WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id IN (SELECT id FROM properties WHERE property_code IN ('RVXA','RVXB')))");
  await p.query("DELETE FROM rooms WHERE property_id IN (SELECT id FROM properties WHERE property_code IN ('RVXA','RVXB'))");
  await p.query("DELETE FROM room_types WHERE property_id IN (SELECT id FROM properties WHERE property_code IN ('RVXA','RVXB'))");
  await p.query("DELETE FROM room_categories WHERE property_id IN (SELECT id FROM properties WHERE property_code IN ('RVXA','RVXB'))");
  await p.query("DELETE FROM properties WHERE property_code IN ('RVXA','RVXB')");

  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  console.log(`Disposable server on port ${address.port}`);

  const client = await p.connect();
  try {
    // ---- SETUP ----
    const propA = await client.query(
      `INSERT INTO properties (name, property_code, address, is_active) VALUES ('Resv Test A', 'RVXA', 'Resv Address A', TRUE) RETURNING id`
    );
    propAId = Number(propA.rows[0].id);

    const propB = await client.query(
      `INSERT INTO properties (name, property_code, address, is_active) VALUES ('Resv Test B', 'RVXB', 'Resv Address B', TRUE) RETURNING id`
    );
    propBId = Number(propB.rows[0].id);

    const catA = await client.query(
      `INSERT INTO room_categories (property_id, code, name, is_active, display_order)
       VALUES ($1, 'RSCA', 'Resv Cat A', TRUE, 10) RETURNING id`,
      [propAId]
    );
    catAId = Number(catA.rows[0].id);

    const typeA = await client.query(
      `INSERT INTO room_types (property_id, code, name, room_category_id, capacity, max_adults, max_children, is_active, display_order, base_rate)
       VALUES ($1, 'RTA', 'Resv Type A', $2, 2, 2, 0, TRUE, 10, 500000) RETURNING id`,
      [propAId, catAId]
    );
    typeAId = Number(typeA.rows[0].id);

    const roomA = await client.query(
      `INSERT INTO rooms (property_id, room_number, room_type_id, is_active)
       VALUES ($1, 'R101', $2, TRUE) RETURNING id`,
      [propAId, typeAId]
    );
    roomA1Id = Number(roomA.rows[0].id);

    // Create a booking + reservation under property A
    const bookingBid = `RVXB-${Date.now()}`;
    const booking = await client.query(
      `INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status, currency_code)
       VALUES ($1, $2, 'Reservation Test Guest', 'ACTIVE', 'IDR') RETURNING id`,
      [bookingBid, propAId]
    );
    bookingAId = Number(booking.rows[0].id);

    const todayResult = await client.query(
      "SELECT to_char((NOW() AT TIME ZONE 'Asia/Jakarta')::date, 'YYYY-MM-DD') AS d"
    );
    const today = String(todayResult.rows[0].d);
    const tomorrowResult = await client.query(
      "SELECT to_char(((NOW() AT TIME ZONE 'Asia/Jakarta')::date + INTERVAL '1 day'), 'YYYY-MM-DD') AS d"
    );
    const tomorrow = String(tomorrowResult.rows[0].d);

    const reservation = await client.query(
      `INSERT INTO reservations (booking_id, room_id, status, stay_status, check_in, check_out, booked_room_type_id_snapshot, guest_name, stay_sequence)
       VALUES ($1, $2, 'BOOKED', 'RESERVED', $3, $4, $5, 'Reservation Test Guest', 1) RETURNING id`,
      [bookingAId, roomA1Id, today, tomorrow, typeAId]
    );
    reservationAId = Number(reservation.rows[0].id);

    // ---- A. Reservation in Property A accessible with A ----
    const getResA = await api('GET', `/api/reservations/${reservationAId}?property_id=${propAId}`);
    assert(getResA.status === 200, `A1: GET reservation with property A returns 200 (got ${getResA.status})`);

    // ---- B. Same reservation rejected with B ----
    const getResB = await api('GET', `/api/reservations/${reservationAId}?property_id=${propBId}`);
    assert(getResB.status === 403, `B: GET reservation with property B is rejected (got ${getResB.status})`);

    // ---- C. Extend rejected cross-property ----
    const extendCross = await api('POST', `/api/reservations/${reservationAId}/extend`, {
      property_id: propBId,
      new_check_out: '2027-12-31'
    });
    assert(extendCross.status === 403, `C: Extend cross-property is rejected (got ${extendCross.status})`);

    // ---- D. Shorten rejected cross-property ----
    const shortenCross = await api('POST', `/api/reservations/${reservationAId}/shorten`, {
      property_id: propBId,
      new_check_out: today
    });
    assert(shortenCross.status === 403, `D: Shorten cross-property is rejected (got ${shortenCross.status})`);

    // ---- E. Cancel rejected cross-property ----
    const cancelCross = await api('POST', `/api/reservations/${reservationAId}/cancel`, {
      property_id: propBId
    });
    assert(cancelCross.status === 403, `E: Cancel cross-property is rejected (got ${cancelCross.status})`);

    // ---- F. Check-in rejected cross-property ----
    const checkinCross = await api('POST', `/api/reservations/${reservationAId}/checkin`, {
      property_id: propBId
    });
    assert(checkinCross.status === 403, `F: Check-in cross-property is rejected (got ${checkinCross.status})`);

    // ---- G. Checkout rejected cross-property ----
    const checkoutCross = await api('POST', `/api/reservations/${reservationAId}/checkout`, {
      property_id: propBId
    });
    assert(checkoutCross.status === 403, `G: Checkout cross-property is rejected (got ${checkoutCross.status})`);

    // ---- H. Move-room rejected cross-property ----
    const roomA2 = await client.query(
      `INSERT INTO rooms (property_id, room_number, room_type_id, is_active)
       VALUES ($1, 'R102', $2, TRUE) RETURNING id`,
      [propAId, typeAId]
    );
    roomA2Id = Number(roomA2.rows[0].id);

    const moveCross = await api('POST', `/api/reservations/${reservationAId}/move`, {
      property_id: propBId,
      to_room_id: roomA2Id
    });
    assert(moveCross.status === 403, `H: Move cross-property is rejected (got ${moveCross.status})`);

    // ---- I. Rejected probes did not mutate reservation ----
    const afterProbe = await client.query(
      'SELECT status, check_in, check_out FROM reservations WHERE id = $1',
      [reservationAId]
    );
    assert(afterProbe.rows[0].status === 'BOOKED', `I: Reservation status is still BOOKED (got ${afterProbe.rows[0].status})`);

    // ---- J. Audit endpoint rejected cross-property ----
    const auditCross = await api('GET', `/api/reservations/${reservationAId}/audit?property_id=${propBId}`);
    assert(auditCross.status === 403, `J: Audit cross-property is rejected (got ${auditCross.status})`);

    // ---- K. Verify A-specific operations still work ----
    const extendA = await api('POST', `/api/reservations/${reservationAId}/extend`, {
      property_id: propAId,
      new_check_out: tomorrow
    });
    assert(extendA.status === 200, `K: Extend same-property succeeds (got ${extendA.status})`);

    // ---- L. No fixture residue ----
    const residueReservation = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM reservations WHERE id = $1 AND status = 'CANCELLED'`,
      [reservationAId]
    );
    assert(Number(residueReservation.rows[0].cnt) === 0, 'L: No cancelled residue from cross-property probes');

    console.log(`\n--- property_scoped_reservation_test: ${passed} passed, ${failed} failed ---`);
  } catch (err) {
    console.error('FATAL:', err.message);
  } finally {
    await cleanup(client);
    if (cleanupErrors.length > 0) {
      console.error(`\n  CLEANUP ERRORS (${cleanupErrors.length}):`);
      for (const e of cleanupErrors) console.error(`    ${e}`);
    }
    const residue = await verifyResidue(client);
    if (residue.length > 0) {
      console.error(`\n  FIXTURE RESIDUE DETECTED: ${residue.join(', ')}`);
      failed += 1;
    }
    client.release();
    if (server) server.close();
    await p.end();
    if (failed > 0 || residue.length > 0 || cleanupErrors.length > 0) process.exit(1);
  }
}

main();
