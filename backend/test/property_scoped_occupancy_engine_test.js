'use strict';

require('dotenv').config({ path: 'e:/oak-hotel-hims/backend/.env' });
const http = require('http');
const { once } = require('events');
const { app, pool } = require('../dist/index');
const { computeOccupancyMetrics } = require('../dist/domains/reports/occupancyService');

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

async function api(method, path, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body && method !== 'GET') {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(baseUrl + path, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function main() {
  console.log('=== Starting Property-Scoped Occupancy Engine Tests ===\n');

  server = http.createServer(app);
  server.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  let propAId = null;
  let propBId = null;
  let propCId = null;

  let roomTypeIdA1 = null;
  let roomTypeIdA2 = null;
  let roomTypeIdB1 = null;
  let roomTypeIdC1 = null;

  let roomA101Id = null;
  let roomA102Id = null;
  let roomA103Id = null;
  let roomB201Id = null;

  const codeA = 'PA' + Math.floor(1000 + Math.random() * 8999);
  const codeB = 'PB' + Math.floor(1000 + Math.random() * 8999);
  const codeC = 'PC' + Math.floor(1000 + Math.random() * 8999);

  try {
    // 1. Fixture Setup: Property A, Property B, Property C
    const propARes = await pool.query(
      "INSERT INTO properties (property_code, name, address, is_active) VALUES ($1, 'Test Occupancy Prop A', 'Address A', TRUE) RETURNING id",
      [codeA]
    );
    propAId = propARes.rows[0].id;

    const propBRes = await pool.query(
      "INSERT INTO properties (property_code, name, address, is_active) VALUES ($1, 'Test Occupancy Prop B', 'Address B', TRUE) RETURNING id",
      [codeB]
    );
    propBId = propBRes.rows[0].id;

    const propCRes = await pool.query(
      "INSERT INTO properties (property_code, name, address, is_active) VALUES ($1, 'Test Occupancy Prop C', 'Address C', TRUE) RETURNING id",
      [codeC]
    );
    propCId = propCRes.rows[0].id;

    // Room Types for Prop A: DLX (2 rooms), STE (1 room)
    const rtA1 = await pool.query(
      "INSERT INTO room_types (property_id, code, name, base_rate, capacity, is_active) VALUES ($1, 'DLX', 'Deluxe King', 500000, 2, TRUE) RETURNING id",
      [propAId]
    );
    roomTypeIdA1 = rtA1.rows[0].id;

    const rtA2 = await pool.query(
      "INSERT INTO room_types (property_id, code, name, base_rate, capacity, is_active) VALUES ($1, 'STE', 'Suite', 900000, 2, TRUE) RETURNING id",
      [propAId]
    );
    roomTypeIdA2 = rtA2.rows[0].id;

    // Room Type for Prop B: DLX (1 room)
    const rtB1 = await pool.query(
      "INSERT INTO room_types (property_id, code, name, base_rate, capacity, is_active) VALUES ($1, 'DLX-B', 'Deluxe King B', 500000, 2, TRUE) RETURNING id",
      [propBId]
    );
    roomTypeIdB1 = rtB1.rows[0].id;

    // Room Type for Prop C: STD (for unequal capacity test)
    const rtC1 = await pool.query(
      "INSERT INTO room_types (property_id, code, name, base_rate, capacity, is_active) VALUES ($1, 'STD-C', 'Standard C', 300000, 2, TRUE) RETURNING id",
      [propCId]
    );
    roomTypeIdC1 = rtC1.rows[0].id;

    // Rooms for Prop A (Room 101, 102 under DLX; Room 103 under STE)
    const r101 = await pool.query(
      "INSERT INTO rooms (property_id, room_number, name, room_type_id, status, is_active) VALUES ($1, '101', 'Deluxe King', $2, 'VACANT_CLEAN', TRUE) RETURNING id",
      [propAId, roomTypeIdA1]
    );
    roomA101Id = r101.rows[0].id;

    const r102 = await pool.query(
      "INSERT INTO rooms (property_id, room_number, name, room_type_id, status, is_active) VALUES ($1, '102', 'Deluxe King', $2, 'VACANT_CLEAN', TRUE) RETURNING id",
      [propAId, roomTypeIdA1]
    );
    roomA102Id = r102.rows[0].id;

    const r103 = await pool.query(
      "INSERT INTO rooms (property_id, room_number, name, room_type_id, status, is_active) VALUES ($1, '103', 'Suite', $2, 'VACANT_CLEAN', TRUE) RETURNING id",
      [propAId, roomTypeIdA2]
    );
    roomA103Id = r103.rows[0].id;

    // Rooms for Prop B
    const r201 = await pool.query(
      "INSERT INTO rooms (property_id, room_number, name, room_type_id, status, is_active) VALUES ($1, '201', 'Deluxe King B', $2, 'VACANT_CLEAN', TRUE) RETURNING id",
      [propBId, roomTypeIdB1]
    );
    roomB201Id = r201.rows[0].id;

    // Seed availability_dates for Prop A (2026-08-01 to 2026-08-10): DLX = 2, STE = 1
    const testDates = [
      '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05',
      '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10'
    ];

    for (const d of testDates) {
      await pool.query(
        "INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty) VALUES ($1, 'Deluxe King', $2, 2, 0)",
        [roomTypeIdA1, d]
      );
      await pool.query(
        "INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty) VALUES ($1, 'Suite', $2, 1, 0)",
        [roomTypeIdA2, d]
      );
      await pool.query(
        "INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty) VALUES ($1, 'Deluxe King B', $2, 1, 0)",
        [roomTypeIdB1, d]
      );
    }

    console.log('--- Initial Baseline Setup Done ---\n');

    // A. One-day gross capacity (2026-08-01: DLX 2 + STE 1 = 3 gross rooms)
    {
      const res = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-01`);
      assert(res.status === 200, 'A1. single date query returns 200');
      assert(res.body.data.totals.gross_room_nights === 3, 'A2. single date gross_room_nights is 3');
      assert(res.body.data.totals.sellable_room_nights === 3, 'A3. single date sellable_room_nights is 3');
      assert(res.body.data.totals.sold_room_nights === 0, 'A4. single date sold_room_nights is 0');
      assert(res.body.data.totals.available_room_nights === 3, 'A5. single date available_room_nights is 3');
      assert(res.body.data.totals.occupancy_pct === 0, 'A6. single date occupancy_pct is 0%');
    }

    // B. Two-day range (2026-08-01 to 2026-08-03 -> 2 nights * 3 = 6 gross room nights)
    {
      const res = await api('GET', `/api/reports/occupancy?property_id=${propAId}&start_date=2026-08-01&end_date=2026-08-03`);
      assert(res.status === 200, 'B1. date range query returns 200');
      assert(res.body.data.nights === 2, 'B2. range nights count is 2');
      assert(res.body.data.totals.gross_room_nights === 6, 'B3. two-day range gross_room_nights is 6');
      assert(res.body.data.totals.sellable_room_nights === 6, 'B4. two-day range sellable_room_nights is 6');
    }

    // C. [start,end) date behavior: 2026-08-01 to 2026-08-03 contains only 2026-08-01 and 2026-08-02
    {
      const res = await api('GET', `/api/reports/occupancy?property_id=${propAId}&start_date=2026-08-01&end_date=2026-08-03`);
      assert(res.body.data.daily.length === 2, 'C1. daily array contains exactly 2 days');
      assert(res.body.data.daily[0].date === '2026-08-01', 'C2. first day is 2026-08-01');
      assert(res.body.data.daily[1].date === '2026-08-02', 'C3. second day is 2026-08-02');
    }

    // D. BOOKED counts (create reservation with BOOKED status on 2026-08-01 to 2026-08-03)
    let booking1Id = null;
    let res1Id = null;
    {
      const bRes = await pool.query(
        "INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status) VALUES ($1, 'BID-TEST-1', 'Guest 1', 'ACTIVE') RETURNING id",
        [propAId]
      );
      booking1Id = bRes.rows[0].id;
      const rRes = await pool.query(
        `INSERT INTO reservations (booking_id, stay_sequence, room_id, booked_room_type_id_snapshot, guest_name, check_in, check_out, status, total_price)
         VALUES ($1, 1, $2, $3, 'Guest 1', '2026-08-01 14:00:00', '2026-08-03 12:00:00', 'BOOKED', 1000000) RETURNING id`,
        [booking1Id, roomA101Id, roomTypeIdA1]
      );
      res1Id = rRes.rows[0].id;

      const res = await api('GET', `/api/reports/occupancy?property_id=${propAId}&start_date=2026-08-01&end_date=2026-08-04`);
      // Day 1 (Aug 1): 1 sold / 3 sellable = 33.33%
      // Day 2 (Aug 2): 1 sold / 3 sellable = 33.33%
      // Day 3 (Aug 3): 0 sold / 3 sellable = 0.00%
      assert(res.body.data.daily[0].sold_room_nights === 1, 'D1. BOOKED reservation counts 1 sold on check-in night');
      assert(res.body.data.daily[1].sold_room_nights === 1, 'D2. BOOKED reservation counts 1 sold on second stay night');
      assert(res.body.data.daily[2].sold_room_nights === 0, 'D3. BOOKED reservation counts 0 on checkout date');
      assert(res.body.data.totals.sold_room_nights === 2, 'D4. total sold_room_nights across 3 days is 2');
    }

    // E. CHECKED_IN counts
    let booking2Id = null;
    let res2Id = null;
    {
      const bRes = await pool.query(
        "INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status) VALUES ($1, 'BID-TEST-2', 'Guest 2', 'ACTIVE') RETURNING id",
        [propAId]
      );
      booking2Id = bRes.rows[0].id;
      const rRes = await pool.query(
        `INSERT INTO reservations (booking_id, stay_sequence, room_id, booked_room_type_id_snapshot, guest_name, check_in, check_out, status, total_price)
         VALUES ($1, 1, $2, $3, 'Guest 2', '2026-08-02 14:00:00', '2026-08-04 12:00:00', 'CHECKED_IN', 1800000) RETURNING id`,
        [booking2Id, roomA103Id, roomTypeIdA2]
      );
      res2Id = rRes.rows[0].id;

      const res = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-02`);
      // On Aug 2: Res1 (DLX) + Res2 (STE) = 2 sold out of 3 sellable = 66.67%
      assert(res.body.data.totals.sold_room_nights === 2, 'E1. CHECKED_IN reservation correctly counts in sold_room_nights');
      assert(res.body.data.totals.occupancy_pct === 66.67, 'E2. 2 sold / 3 sellable = 66.67%');
    }

    // F. CHECKED_OUT historical nights count
    let booking3Id = null;
    let res3Id = null;
    {
      const bRes = await pool.query(
        "INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status) VALUES ($1, 'BID-TEST-3', 'Guest 3', 'ACTIVE') RETURNING id",
        [propAId]
      );
      booking3Id = bRes.rows[0].id;
      const rRes = await pool.query(
        `INSERT INTO reservations (booking_id, stay_sequence, room_id, booked_room_type_id_snapshot, guest_name, check_in, check_out, status, total_price)
         VALUES ($1, 1, $2, $3, 'Guest 3', '2026-08-01 14:00:00', '2026-08-02 12:00:00', 'CHECKED_OUT', 500000) RETURNING id`,
        [booking3Id, roomA102Id, roomTypeIdA1]
      );
      res3Id = rRes.rows[0].id;

      const res = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-01`);
      // On Aug 1: Res1 (Room 101) + Res3 (Room 102) = 2 sold out of 3 sellable = 66.67%
      assert(res.body.data.totals.sold_room_nights === 2, 'F1. CHECKED_OUT reservation counts in historical sold_room_nights');
      assert(res.body.data.totals.occupancy_pct === 66.67, 'F2. CHECKED_OUT contributes to correct occupancy percentage');
    }

    // G. CANCELLED counts zero
    let booking4Id = null;
    let res4Id = null;
    {
      const bRes = await pool.query(
        "INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status) VALUES ($1, 'BID-TEST-4', 'Guest 4', 'CANCELLED') RETURNING id",
        [propAId]
      );
      booking4Id = bRes.rows[0].id;
      const rRes = await pool.query(
        `INSERT INTO reservations (booking_id, stay_sequence, room_id, booked_room_type_id_snapshot, guest_name, check_in, check_out, status, total_price)
         VALUES ($1, 1, $2, $3, 'Guest 4', '2026-08-01 14:00:00', '2026-08-02 12:00:00', 'CANCELLED', 500000) RETURNING id`,
        [booking4Id, roomA102Id, roomTypeIdA1]
      );
      res4Id = rRes.rows[0].id;

      const res = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-01`);
      // Should remain 2 sold (Res1 + Res3), Res4 cancelled contributes 0
      assert(res.body.data.totals.sold_room_nights === 2, 'G1. CANCELLED reservation contributes exactly 0 sold room nights');
    }

    // H. Checkout date excluded
    {
      const res = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-04`);
      // On Aug 4: Res2 check_out was 2026-08-04 -> 0 sold nights on Aug 4
      assert(res.body.data.totals.sold_room_nights === 0, 'H1. checkout date is strictly excluded from occupied nights');
      assert(res.body.data.totals.occupancy_pct === 0, 'H2. occupancy is 0% on checkout day with no other stays');
    }

    // I. OOO deducted (Room 101 OUT_OF_ORDER on 2026-08-05 to 2026-08-07)
    let block1Id = null;
    {
      const bRes = await pool.query(
        `INSERT INTO room_operational_blocks (property_id, room_id, room_type_id, block_type, start_date, end_date, status)
         VALUES ($1, $2, $3, 'OUT_OF_ORDER', '2026-08-05', '2026-08-07', 'ACTIVE') RETURNING id`,
        [propAId, roomA101Id, roomTypeIdA1]
      );
      block1Id = bRes.rows[0].id;

      const res = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-05`);
      // On Aug 5: Gross 3, OOO 1, OOS 0, Blocked 1, Sellable 2, Sold 0, Available 2
      assert(res.body.data.totals.gross_room_nights === 3, 'I1. gross remains 3');
      assert(res.body.data.totals.ooo_room_nights === 1, 'I2. ooo_room_nights is 1');
      assert(res.body.data.totals.blocked_room_nights === 1, 'I3. blocked_room_nights is 1');
      assert(res.body.data.totals.sellable_room_nights === 2, 'I4. sellable_room_nights is 2 (3 - 1)');
      assert(res.body.data.totals.available_room_nights === 2, 'I5. available_room_nights is 2');
    }

    // J. OOS deducted (Room 102 OUT_OF_SERVICE on 2026-08-05 to 2026-08-06)
    let block2Id = null;
    {
      const bRes = await pool.query(
        `INSERT INTO room_operational_blocks (property_id, room_id, room_type_id, block_type, start_date, end_date, status)
         VALUES ($1, $2, $3, 'OUT_OF_SERVICE', '2026-08-05', '2026-08-06', 'ACTIVE') RETURNING id`,
        [propAId, roomA102Id, roomTypeIdA1]
      );
      block2Id = bRes.rows[0].id;

      const res = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-05`);
      // On Aug 5: Gross 3, OOO 1 (101), OOS 1 (102) -> Blocked 2, Sellable 1, Sold 0
      assert(res.body.data.totals.ooo_room_nights === 1, 'J1. ooo_room_nights is 1');
      assert(res.body.data.totals.oos_room_nights === 1, 'J2. oos_room_nights is 1');
      assert(res.body.data.totals.blocked_room_nights === 2, 'J3. blocked_room_nights is 2');
      assert(res.body.data.totals.sellable_room_nights === 1, 'J4. sellable_room_nights is 1');
    }

    // K & L. Housekeeping status (DIRTY / CLEANING) does NOT reduce sellable denominator
    {
      await pool.query("UPDATE rooms SET status = 'VACANT_DIRTY' WHERE id = $1", [roomA103Id]);
      const resDirty = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-05`);
      assert(resDirty.body.data.totals.gross_room_nights === 3, 'K1. VACANT_DIRTY does not reduce gross capacity');
      assert(resDirty.body.data.totals.sellable_room_nights === 1, 'K2. VACANT_DIRTY does not reduce sellable capacity');

      await pool.query("UPDATE rooms SET status = 'CLEANING' WHERE id = $1", [roomA103Id]);
      const resClean = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-05`);
      assert(resClean.body.data.totals.gross_room_nights === 3, 'L1. CLEANING does not reduce gross capacity');
      assert(resClean.body.data.totals.sellable_room_nights === 1, 'L2. CLEANING does not reduce sellable capacity');

      // Restore room status
      await pool.query("UPDATE rooms SET status = 'VACANT_CLEAN' WHERE id = $1", [roomA103Id]);
    }

    // M. RELEASED historical block still counts its effective prior nights
    // N. Early release stops deduction from final end_date onward
    let block3Id = null;
    {
      // Created for 2026-08-06 to 2026-08-10, but released early on 2026-08-07 (end_date updated to 2026-08-07)
      const bRes = await pool.query(
        `INSERT INTO room_operational_blocks (property_id, room_id, room_type_id, block_type, start_date, end_date, status, released_at)
         VALUES ($1, $2, $3, 'OUT_OF_ORDER', '2026-08-06', '2026-08-07', 'RELEASED', NOW()) RETURNING id`,
        [propAId, roomA103Id, roomTypeIdA2]
      );
      block3Id = bRes.rows[0].id;

      // On Aug 6: Room 101 OOO (block1) + Room 103 OOO (block3) = 2 OOO blocks
      const resAug6 = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-06`);
      assert(resAug6.body.data.totals.ooo_room_nights === 2, 'M1. RELEASED block counts on effective prior stay night (Aug 6)');
      assert(resAug6.body.data.totals.sellable_room_nights === 1, 'M2. sellable_room_nights is 1 (3 - 2)');

      // On Aug 8: block3 ended at 2026-08-07 -> block3 contributes 0 on Aug 8
      const resAug8 = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-08`);
      assert(resAug8.body.data.totals.blocked_room_nights === 0, 'N1. early released block stops deduction from release date onward');
      assert(resAug8.body.data.totals.sellable_room_nights === 3, 'N2. sellable_room_nights restored to 3 on Aug 8');
    }

    // O. CANCELLED future block contributes zero
    let block4Id = null;
    {
      const bRes = await pool.query(
        `INSERT INTO room_operational_blocks (property_id, room_id, room_type_id, block_type, start_date, end_date, status)
         VALUES ($1, $2, $3, 'OUT_OF_ORDER', '2026-08-08', '2026-08-10', 'CANCELLED') RETURNING id`,
        [propAId, roomA101Id, roomTypeIdA1]
      );
      block4Id = bRes.rows[0].id;

      const res = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-08`);
      assert(res.body.data.totals.blocked_room_nights === 0, 'O1. CANCELLED block contributes zero blocked nights');
    }

    // P. Adjacent reservation and block boundary
    let booking5Id = null;
    {
      // Reservation on Aug 7 to Aug 9 on Room 101 (block1 ended on Aug 7)
      const bRes = await pool.query(
        "INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status) VALUES ($1, 'BID-TEST-5', 'Guest 5', 'ACTIVE') RETURNING id",
        [propAId]
      );
      booking5Id = bRes.rows[0].id;
      await pool.query(
        `INSERT INTO reservations (booking_id, stay_sequence, room_id, booked_room_type_id_snapshot, guest_name, check_in, check_out, status, total_price)
         VALUES ($1, 1, $2, $3, 'Guest 5', '2026-08-07 14:00:00', '2026-08-09 12:00:00', 'BOOKED', 1000000)`,
        [booking5Id, roomA101Id, roomTypeIdA1]
      );

      const resAug7 = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-07`);
      // On Aug 7: block1 ended on Aug 7 (so blocked = 0). Res5 checks in on Aug 7 (so sold = 1).
      assert(resAug7.body.data.totals.blocked_room_nights === 0, 'P1. block ending on Aug 7 does not block Aug 7');
      assert(resAug7.body.data.totals.sold_room_nights === 1, 'P2. reservation starting on Aug 7 occupies Aug 7');
      assert(resAug7.body.data.totals.occupancy_pct === 33.33, 'P3. 1 sold / 3 sellable = 33.33%');
    }

    // Q, R, S. Core Formula Invariants Verification across a full 10-day range
    {
      const res = await api('GET', `/api/reports/occupancy?property_id=${propAId}&start_date=2026-08-01&end_date=2026-08-11`);
      assert(res.status === 200, 'Q1. full range query succeeds');
      const data = res.body.data;
      const t = data.totals;

      assert(t.sellable_room_nights === t.gross_room_nights - t.blocked_room_nights, 'Q2. Range Sellable = Gross - Blocked');
      assert(t.available_room_nights === t.sellable_room_nights - t.sold_room_nights, 'R1. Range Available = Sellable - Sold');
      assert(t.blocked_room_nights === t.ooo_room_nights + t.oos_room_nights, 'S1. Blocked = OOO + OOS');

      for (const d of data.daily) {
        assert(d.sellable_room_nights === d.gross_room_nights - d.blocked_room_nights, `Q3. Daily Sellable formula on ${d.date}`);
        assert(d.available_room_nights === d.sellable_room_nights - d.sold_room_nights, `R2. Daily Available formula on ${d.date}`);
        assert(d.blocked_room_nights === d.ooo_room_nights + d.oos_room_nights, `S2. Daily Blocked formula on ${d.date}`);
      }
    }

    // U. Zero Sellable Denominator (all 3 rooms blocked on a date)
    let blockZ1 = null;
    let blockZ2 = null;
    let blockZ3 = null;
    {
      const b1 = await pool.query(
        "INSERT INTO room_operational_blocks (property_id, room_id, room_type_id, block_type, start_date, end_date, status) VALUES ($1, $2, $3, 'OUT_OF_ORDER', '2026-08-09', '2026-08-10', 'ACTIVE') RETURNING id",
        [propAId, roomA101Id, roomTypeIdA1]
      );
      blockZ1 = b1.rows[0].id;
      const b2 = await pool.query(
        "INSERT INTO room_operational_blocks (property_id, room_id, room_type_id, block_type, start_date, end_date, status) VALUES ($1, $2, $3, 'OUT_OF_ORDER', '2026-08-09', '2026-08-10', 'ACTIVE') RETURNING id",
        [propAId, roomA102Id, roomTypeIdA1]
      );
      blockZ2 = b2.rows[0].id;
      const b3 = await pool.query(
        "INSERT INTO room_operational_blocks (property_id, room_id, room_type_id, block_type, start_date, end_date, status) VALUES ($1, $2, $3, 'OUT_OF_SERVICE', '2026-08-09', '2026-08-10', 'ACTIVE') RETURNING id",
        [propAId, roomA103Id, roomTypeIdA2]
      );
      blockZ3 = b3.rows[0].id;

      // Also clean up any reservations on Aug 9 so sold = 0
      await pool.query("UPDATE reservations SET status = 'CANCELLED' WHERE booking_id = $1", [booking5Id]);

      const resZero = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-09`);
      assert(resZero.body.data.totals.gross_room_nights === 3, 'U1. gross capacity is 3');
      assert(resZero.body.data.totals.blocked_room_nights === 3, 'U2. blocked rooms is 3');
      assert(resZero.body.data.totals.sellable_room_nights === 0, 'U3. sellable rooms is 0');
      assert(resZero.body.data.totals.sold_room_nights === 0, 'U4. sold rooms is 0');
      assert(resZero.body.data.totals.occupancy_pct === 0, 'U5. zero sellable denominator yields occupancy_pct = 0.00% without error');
      assert(resZero.body.data.totals.is_zero_sellable === true, 'U6. zero sellable flag is set');
    }

    // V. Impossible Sold > Sellable raises integrity failure
    {
      let caught = false;
      try {
        computeOccupancyMetrics(10, 2, 0, 9, 'integrity test');
      } catch (err) {
        caught = true;
        assert(err.code === 'OCCUPANCY_INTEGRITY_VIOLATION', 'V1. Sold (9) > Sellable (8) throws OCCUPANCY_INTEGRITY_VIOLATION');
      }
      assert(caught, 'V2. computeOccupancyMetrics rejects sold > sellable');
    }

    // W. Property Isolation (Property B data does not leak into Property A)
    {
      // Create a reservation for Prop B
      const bBRes = await pool.query(
        "INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status) VALUES ($1, 'BID-TEST-B1', 'Guest B', 'ACTIVE') RETURNING id",
        [propBId]
      );
      const bBId = bBRes.rows[0].id;
      await pool.query(
        `INSERT INTO reservations (booking_id, stay_sequence, room_id, booked_room_type_id_snapshot, guest_name, check_in, check_out, status, total_price)
         VALUES ($1, 1, $2, $3, 'Guest B', '2026-08-01 14:00:00', '2026-08-03 12:00:00', 'BOOKED', 1000000)`,
        [bBId, roomB201Id, roomTypeIdB1]
      );

      const resA = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-01`);
      const resB = await api('GET', `/api/reports/occupancy?property_id=${propBId}&date=2026-08-01`);

      assert(resB.body.data.totals.gross_room_nights === 1, 'W1. Property B gross is 1');
      assert(resB.body.data.totals.sold_room_nights === 1, 'W2. Property B sold is 1');
      assert(resB.body.data.totals.occupancy_pct === 100, 'W3. Property B occupancy is 100%');

      // Prop A has 3 gross rooms, independent sold
      assert(resA.body.data.totals.gross_room_nights === 3, 'W4. Property A gross remains 3');
      assert(resA.body.data.totals.sold_room_nights === 2, 'W5. Property A sold remains 2 (isolated from Property B)');
    }

    // X. Room-Type Isolation
    {
      const res = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-01`);
      assert(Array.isArray(res.body.data.room_types), 'X1. room_types breakdown is an array');
      assert(res.body.data.room_types.length === 2, 'X2. contains exactly 2 active room types for Prop A');

      const dlx = res.body.data.room_types.find(r => r.room_type_id === roomTypeIdA1);
      const ste = res.body.data.room_types.find(r => r.room_type_id === roomTypeIdA2);

      assert(dlx.gross_room_nights === 2, 'X3. DLX gross is 2');
      assert(dlx.sold_room_nights === 2, 'X4. DLX sold is 2');
      assert(dlx.occupancy_pct === 100, 'X5. DLX occupancy is 100%');

      assert(ste.gross_room_nights === 1, 'X6. STE gross is 1');
      assert(ste.sold_room_nights === 0, 'X7. STE sold is 0');
      assert(ste.occupancy_pct === 0, 'X8. STE occupancy is 0%');
    }

    // Y. Missing Historical Capacity Coverage (before ledger: 2026-07-20)
    {
      const res = await api('GET', `/api/reports/occupancy?property_id=${propAId}&start_date=2026-07-20&end_date=2026-07-25`);
      assert(res.status === 409, 'Y1. before-ledger query returns 409 Conflict');
      assert(res.body.code === 'CAPACITY_HISTORY_UNAVAILABLE', 'Y2. code is CAPACITY_HISTORY_UNAVAILABLE');
      assert(res.body.details && Array.isArray(res.body.details.missing_dates), 'Y3. details.missing_dates is returned');
      assert(res.body.details.missing_dates.includes('2026-07-20'), 'Y4. missing_dates lists 2026-07-20');
    }

    // Z. Future Coverage Gap (beyond ledger: 2026-08-15)
    {
      const res = await api('GET', `/api/reports/occupancy?property_id=${propAId}&start_date=2026-08-15&end_date=2026-08-20`);
      assert(res.status === 409, 'Z1. beyond-ledger query returns 409 Conflict');
      assert(res.body.code === 'CAPACITY_HISTORY_UNAVAILABLE', 'Z2. code is CAPACITY_HISTORY_UNAVAILABLE');
    }

    // AA. Hotel-Date Correctness (Asia/Jakarta boundaries)
    {
      const res = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-01`);
      assert(res.body.data.start_date === '2026-08-01', 'AA1. normalized start_date is 2026-08-01');
      assert(res.body.data.end_date === '2026-08-02', 'AA2. normalized end_date is 2026-08-02');
    }

    // AB. No dependence on PostgreSQL session timezone
    {
      await pool.query("SET TIME ZONE 'America/New_York'");
      const resNY = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-01`);
      await pool.query("SET TIME ZONE 'UTC'");
      const resUTC = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-01`);
      await pool.query("SET TIME ZONE 'Asia/Jakarta'");
      const resJKT = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-01`);

      assert(resNY.body.data.totals.sold_room_nights === resUTC.body.data.totals.sold_room_nights, 'AB1. NY and UTC return identical sold count');
      assert(resUTC.body.data.totals.sold_room_nights === resJKT.body.data.totals.sold_room_nights, 'AB2. UTC and JKT return identical sold count');
      assert(resNY.body.data.totals.gross_room_nights === resJKT.body.data.totals.gross_room_nights, 'AB3. Session timezone does not shift gross capacity');
    }

    // AD. Current-Inactive / Historically-Active Room Type (Requirement 5)
    // Deactivating a room type today must NEVER alter its historical capacity or occupancy.
    {
      // 1. Query baseline before deactivation on 2026-08-01
      const resBefore = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-01`);
      assert(resBefore.status === 200, 'AD1. Baseline query succeeds');
      const baseTotals = resBefore.body.data.totals;
      const baseDlx = resBefore.body.data.room_types.find(r => r.room_type_id === roomTypeIdA1);
      assert(baseTotals.gross_room_nights === 3, 'AD2. Baseline property gross is 3');
      assert(baseTotals.sold_room_nights === 2, 'AD3. Baseline property sold is 2');
      assert(baseDlx.gross_room_nights === 2, 'AD4. Baseline DLX gross is 2');
      assert(baseDlx.sold_room_nights === 2, 'AD5. Baseline DLX sold is 2');
      assert(baseDlx.is_active_current === true, 'AD6. Baseline DLX is_active_current is true');

      // 2. Deactivate room type in Room Master (current state is inactive)
      await pool.query('UPDATE room_types SET is_active = FALSE WHERE id = $1', [roomTypeIdA1]);

      // 3. Query historical date 2026-08-01 after deactivation
      const resAfter = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-01`);
      assert(resAfter.status === 200, 'AD7. Query after deactivation succeeds');
      const afterTotals = resAfter.body.data.totals;
      const afterDlx = resAfter.body.data.room_types.find(r => r.room_type_id === roomTypeIdA1);

      // 4. Assert property totals are 100% IDENTICAL before vs after deactivation
      assert(afterTotals.gross_room_nights === baseTotals.gross_room_nights, 'AD8. Property gross is unchanged after deactivation (3)');
      assert(afterTotals.sold_room_nights === baseTotals.sold_room_nights, 'AD9. Property sold is unchanged after deactivation (2)');
      assert(afterTotals.sellable_room_nights === baseTotals.sellable_room_nights, 'AD10. Property sellable is unchanged after deactivation (3)');
      assert(afterTotals.occupancy_pct === baseTotals.occupancy_pct, 'AD11. Property occupancy is unchanged after deactivation (66.67%)');

      // 5. Assert room-type breakdown still includes DLX with full historical metrics
      assert(afterDlx !== undefined, 'AD12. DLX room type is still included in breakdown');
      assert(afterDlx.gross_room_nights === 2, 'AD13. DLX gross is still 2');
      assert(afterDlx.sold_room_nights === 2, 'AD14. DLX sold is still 2');
      assert(afterDlx.sellable_room_nights === 2, 'AD15. DLX sellable is still 2');
      assert(afterDlx.occupancy_pct === 100, 'AD16. DLX occupancy is still 100.00%');
      assert(afterDlx.is_active_current === false, 'AD17. DLX reflects is_active_current = false');

      // Restore active state
      await pool.query('UPDATE room_types SET is_active = TRUE WHERE id = $1', [roomTypeIdA1]);
    }

    // AE. Current Inactive Room Type with Zero Historical Capacity (Requirement 6)
    // An unrelated inactive room type with no activity must not appear or distort totals.
    {
      const inertRt = await pool.query(
        "INSERT INTO room_types (property_id, name, code, base_rate, capacity, display_order, is_active) VALUES ($1, 'Inert Type', 'INERT', 300000, 2, 99, FALSE) RETURNING id",
        [propAId]
      );
      const inertRtId = inertRt.rows[0].id;

      const res = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-01`);
      assert(res.status === 200, 'AE1. Query with unrelated inactive room type succeeds');
      const inertFound = res.body.data.room_types.find(r => r.room_type_id === inertRtId);
      assert(inertFound === undefined, 'AE2. Unrelated inactive room type with 0 capacity is not in breakdown');
      assert(res.body.data.totals.gross_room_nights === 3, 'AE3. Property gross is not distorted');

      await pool.query('DELETE FROM room_types WHERE id = $1', [inertRtId]);
    }

    // AF. Ledger Coverage Metadata & Boundary Semantics (Requirement 7)
    // Availability dates for Prop A span 2026-08-01 to 2026-08-10 (inclusive).
    // first_covered_date = '2026-08-01', last_covered_date = '2026-08-10', coverage_end_exclusive = '2026-08-11'.
    {
      // AF1: Query single last_covered_date (2026-08-10) succeeds
      const resLastDate = await api('GET', `/api/reports/occupancy?property_id=${propAId}&date=2026-08-10`);
      assert(resLastDate.status === 200, 'AF1. Query on single last_covered_date succeeds');
      assert(resLastDate.body.data.nights === 1, 'AF2. Nights count is 1');

      // AF2: Range ending at coverage_end_exclusive (2026-08-11) succeeds
      const resExclusiveEnd = await api('GET', `/api/reports/occupancy?property_id=${propAId}&start_date=2026-08-01&end_date=2026-08-11`);
      assert(resExclusiveEnd.status === 200, 'AF3. Range ending at coverage_end_exclusive succeeds');
      assert(resExclusiveEnd.body.data.nights === 10, 'AF4. Nights count is 10');

      // AF3: Query beginning after last_covered_date (2026-08-11) fails closed with 409
      const resAfterLast = await api('GET', `/api/reports/occupancy?property_id=${propAId}&start_date=2026-08-11&end_date=2026-08-12`);
      assert(resAfterLast.status === 409, 'AF5. Query starting after last_covered_date returns 409');
      assert(resAfterLast.body.code === 'CAPACITY_HISTORY_UNAVAILABLE', 'AF6. Error code is CAPACITY_HISTORY_UNAVAILABLE');
      assert(resAfterLast.body.details.first_covered_date === '2026-08-01', 'AF7. first_covered_date is 2026-08-01');
      assert(resAfterLast.body.details.last_covered_date === '2026-08-10', 'AF8. last_covered_date is 2026-08-10');
      assert(resAfterLast.body.details.coverage_end_exclusive === '2026-08-11', 'AF9. coverage_end_exclusive is 2026-08-11');
      assert(resAfterLast.body.details.missing_dates.includes('2026-08-11'), 'AF10. missing_dates contains 2026-08-11');
    }

    // SECTION 23: UNEQUAL DAILY CAPACITY TEST (MANDATORY TEST)
    // Day 1: sellable = 10, sold = 10 -> 100%
    // Day 2: sellable = 20, sold = 10 -> 50%
    // Range occupancy MUST be: 20 / 30 = 66.67% (NOT (100 + 50) / 2 = 75%)
    {
      console.log('\n--- Running Section 23 Unequal Daily Capacity Test ---');

      // Seed availability_dates for Prop C: Day 1 (10 rooms), Day 2 (20 rooms)
      await pool.query(
        "INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty) VALUES ($1, 'Standard C', '2026-08-01', 10, 0)",
        [roomTypeIdC1]
      );
      await pool.query(
        "INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty) VALUES ($1, 'Standard C', '2026-08-02', 20, 0)",
        [roomTypeIdC1]
      );

      // Create 10 room fixtures under Prop C for Day 1 stays
      const cRoomIds = [];
      for (let i = 1; i <= 20; i++) {
        const cr = await pool.query(
          "INSERT INTO rooms (property_id, room_number, name, room_type_id, status, is_active) VALUES ($1, $2, 'Standard C', $3, 'VACANT_CLEAN', TRUE) RETURNING id",
          [propCId, `C${i}`, roomTypeIdC1]
        );
        cRoomIds.push(cr.rows[0].id);
      }

      // Create 10 bookings on Day 1 (2026-08-01 to 2026-08-02) -> 10 sold on Day 1
      for (let i = 0; i < 10; i++) {
        const cb = await pool.query(
          "INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status) VALUES ($1, $2, 'Guest C1', 'ACTIVE') RETURNING id",
          [propCId, `BID-C-D1-${i}`]
        );
        await pool.query(
          `INSERT INTO reservations (booking_id, stay_sequence, room_id, booked_room_type_id_snapshot, guest_name, check_in, check_out, status, total_price)
           VALUES ($1, 1, $2, $3, 'Guest C1', '2026-08-01 14:00:00', '2026-08-02 12:00:00', 'BOOKED', 300000)`,
          [cb.rows[0].id, cRoomIds[i], roomTypeIdC1]
        );
      }

      // Create 10 bookings on Day 2 (2026-08-02 to 2026-08-03) -> 10 sold on Day 2
      for (let i = 0; i < 10; i++) {
        const cb = await pool.query(
          "INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status) VALUES ($1, $2, 'Guest C2', 'ACTIVE') RETURNING id",
          [propCId, `BID-C-D2-${i}`]
        );
        await pool.query(
          `INSERT INTO reservations (booking_id, stay_sequence, room_id, booked_room_type_id_snapshot, guest_name, check_in, check_out, status, total_price)
           VALUES ($1, 1, $2, $3, 'Guest C2', '2026-08-02 14:00:00', '2026-08-03 12:00:00', 'BOOKED', 300000)`,
          [cb.rows[0].id, cRoomIds[i], roomTypeIdC1]
        );
      }

      const resC = await api('GET', `/api/reports/occupancy?property_id=${propCId}&start_date=2026-08-01&end_date=2026-08-03`);
      assert(resC.status === 200, 'T1. Unequal capacity query returns 200');

      const d1 = resC.body.data.daily[0];
      const d2 = resC.body.data.daily[1];
      const totalsC = resC.body.data.totals;

      assert(d1.sellable_room_nights === 10, 'T2. Day 1 sellable is 10');
      assert(d1.sold_room_nights === 10, 'T3. Day 1 sold is 10');
      assert(d1.occupancy_pct === 100, 'T4. Day 1 occupancy is 100.00%');

      assert(d2.sellable_room_nights === 20, 'T5. Day 2 sellable is 20');
      assert(d2.sold_room_nights === 10, 'T6. Day 2 sold is 10');
      assert(d2.occupancy_pct === 50, 'T7. Day 2 occupancy is 50.00%');

      assert(totalsC.sellable_room_nights === 30, 'T8. Total sellable is 30 (10 + 20)');
      assert(totalsC.sold_room_nights === 20, 'T9. Total sold is 20 (10 + 10)');

      // Range occupancy MUST be 20 / 30 * 100 = 66.67%, NOT (100 + 50) / 2 = 75%
      assert(totalsC.occupancy_pct === 66.67, 'T10. Range occupancy is 66.67% (weighted 20/30), NOT 75% arithmetic average');
    }

  } finally {
    // AC. Strict Zero-Residue Cleanup
    console.log('\n--- Cleaning up test fixtures ---');
    try {
      if (propAId) {
        await pool.query('DELETE FROM room_operational_blocks WHERE property_id = $1', [propAId]);
        await pool.query('DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1)', [propAId]);
        await pool.query('DELETE FROM bookings WHERE property_id = $1', [propAId]);
        await pool.query('DELETE FROM availability_dates WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id = $1)', [propAId]);
        await pool.query('DELETE FROM rooms WHERE property_id = $1', [propAId]);
        await pool.query('DELETE FROM room_types WHERE property_id = $1', [propAId]);
        await pool.query('DELETE FROM properties WHERE id = $1', [propAId]);
      }
      if (propBId) {
        await pool.query('DELETE FROM room_operational_blocks WHERE property_id = $1', [propBId]);
        await pool.query('DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1)', [propBId]);
        await pool.query('DELETE FROM bookings WHERE property_id = $1', [propBId]);
        await pool.query('DELETE FROM availability_dates WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id = $1)', [propBId]);
        await pool.query('DELETE FROM rooms WHERE property_id = $1', [propBId]);
        await pool.query('DELETE FROM room_types WHERE property_id = $1', [propBId]);
        await pool.query('DELETE FROM properties WHERE id = $1', [propBId]);
      }
      if (propCId) {
        await pool.query('DELETE FROM room_operational_blocks WHERE property_id = $1', [propCId]);
        await pool.query('DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1)', [propCId]);
        await pool.query('DELETE FROM bookings WHERE property_id = $1', [propCId]);
        await pool.query('DELETE FROM availability_dates WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id = $1)', [propCId]);
        await pool.query('DELETE FROM rooms WHERE property_id = $1', [propCId]);
        await pool.query('DELETE FROM room_types WHERE property_id = $1', [propCId]);
        await pool.query('DELETE FROM properties WHERE id = $1', [propCId]);
      }
      console.log('PASS | AC. test fixtures completely cleaned up');
      passed++;
    } catch (cleanupErr) {
      console.error('FAIL | AC. test cleanup error:', cleanupErr);
      failed++;
    }

    if (server) {
      server.close();
    }
  }

  console.log(`\n=== Test Summary: ${passed} PASSED, ${failed} FAILED ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
