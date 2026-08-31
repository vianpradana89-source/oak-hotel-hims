#!/usr/bin/env node
'use strict';

const http = require('http');
const { Pool } = require('pg');

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

function makeRequest(server, options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (_) {
          json = data;
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function main() {
  const adminUrl = process.env.TEST_DATABASE_URL
    || ('postgresql://' + (process.env.DB_USER || 'postgres') + ':' + (process.env.DB_PASSWORD || 'secretpassword') + '@' + (process.env.DB_HOST || '127.0.0.1') + ':' + (process.env.DB_PORT || 5432) + '/oak_hotel_db');

  const pool = new Pool({ connectionString: adminUrl });
  const { app } = require('../dist/index');
  const { initializeDatabase } = require('../dist/db/schema_v3');

  await initializeDatabase(pool);

  let server;
  let port;

  const fixtures = {
    property1: null,
    property2: null,
    roomType1: null,
    roomType2: null,
    room1: null,
    room2: null,
    room3: null,
    bookings: [],
    reservations: [],
    guests: []
  };

  try {
    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });

    console.log(`Test server listening on port ${port}`);

    // 1. Setup isolated fixtures
    const suffix = Date.now().toString().slice(-6);
    const rnd = Math.floor(Math.random() * 900) + 100;
    const p1Res = await pool.query(
      `INSERT INTO properties (property_code, name, address, is_active) VALUES ($1, $2, 'Jl. Test 1', true) RETURNING id`,
      [`P1${rnd}`, `CRM Property 1 ${suffix}`]
    );
    fixtures.property1 = p1Res.rows[0].id;

    const p2Res = await pool.query(
      `INSERT INTO properties (property_code, name, address, is_active) VALUES ($1, $2, 'Jl. Test 2', true) RETURNING id`,
      [`P2${rnd}`, `CRM Property 2 ${suffix}`]
    );
    fixtures.property2 = p2Res.rows[0].id;

    const rt1Res = await pool.query(
      `INSERT INTO room_types (property_id, code, name, base_rate, capacity) VALUES ($1, 'DLX1', $2, 500000, 2) RETURNING id`,
      [fixtures.property1, `CRM Deluxe ${suffix}`]
    );
    fixtures.roomType1 = rt1Res.rows[0].id;

    const rt2Res = await pool.query(
      `INSERT INTO room_types (property_id, code, name, base_rate, capacity) VALUES ($1, 'STE1', $2, 500000, 2) RETURNING id`,
      [fixtures.property2, `CRM Suite ${suffix}`]
    );
    fixtures.roomType2 = rt2Res.rows[0].id;

    const r1 = await pool.query(
      `INSERT INTO rooms (room_number, room_type_id, status, property_id) VALUES ($1, $2, 'VACANT_CLEAN', $3) RETURNING id`,
      [`R1_${suffix}`, fixtures.roomType1, fixtures.property1]
    );
    fixtures.room1 = r1.rows[0].id;

    const r2 = await pool.query(
      `INSERT INTO rooms (room_number, room_type_id, status, property_id) VALUES ($1, $2, 'VACANT_CLEAN', $3) RETURNING id`,
      [`R2_${suffix}`, fixtures.roomType1, fixtures.property1]
    );
    fixtures.room2 = r2.rows[0].id;

    const r3 = await pool.query(
      `INSERT INTO rooms (room_number, room_type_id, status, property_id) VALUES ($1, $2, 'VACANT_CLEAN', $3) RETURNING id`,
      [`R3_${suffix}`, fixtures.roomType2, fixtures.property2]
    );
    fixtures.room3 = r3.rows[0].id;

    // Current hotel date for test
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
    const currentMonth = new Date().getMonth() + 1;
    const birthdayDate = `1990-${String(currentMonth).padStart(2, '0')}-15`;

    // Guest A (Property 1: Repeat guest with 2 completed stays)
    const gA = await pool.query(
      `INSERT INTO guests (full_name, phone, email, vip_status, created_property_id)
       VALUES ($1, $2, $3, 'VIP', $4) RETURNING id`,
      [`Guest Repeat Alpha ${suffix}`, `+62811111${suffix}`, `alpha_${suffix}@test.com`, fixtures.property1]
    );
    fixtures.guests.push(gA.rows[0].id);

    // Guest B (Property 1: Dormant guest stayed 120 days ago, birthday this month)
    const gB = await pool.query(
      `INSERT INTO guests (full_name, phone, email, birth_date, vip_status, created_property_id)
       VALUES ($1, $2, $3, $4, 'STANDARD', $5) RETURNING id`,
      [`Guest Dormant Beta ${suffix}`, `+62822222${suffix}`, `beta_${suffix}@test.com`, birthdayDate, fixtures.property1]
    );
    fixtures.guests.push(gB.rows[0].id);

    // Guest C (Property 1: New guest stayed 5 days ago)
    const gC = await pool.query(
      `INSERT INTO guests (full_name, phone, email, vip_status, created_property_id)
       VALUES ($1, $2, $3, 'VVIP', $4) RETURNING id`,
      [`Guest New Charlie ${suffix}`, `+62833333${suffix}`, `charlie_${suffix}@test.com`, fixtures.property1]
    );
    fixtures.guests.push(gC.rows[0].id);

    // Guest D (Property 1: Only Cancelled and future Booked stays -> 0 completed visits)
    const gD = await pool.query(
      `INSERT INTO guests (full_name, phone, email, vip_status, created_property_id)
       VALUES ($1, $2, $3, 'STANDARD', $4) RETURNING id`,
      [`Guest Pending Delta ${suffix}`, `+62844444${suffix}`, `delta_${suffix}@test.com`, fixtures.property1]
    );
    fixtures.guests.push(gD.rows[0].id);

    // Guest E (Property 2: Belonging exclusively to Property 2)
    const gE = await pool.query(
      `INSERT INTO guests (full_name, phone, email, vip_status, created_property_id)
       VALUES ($1, $2, $3, 'VIP', $4) RETURNING id`,
      [`Guest Property2 Echo ${suffix}`, `+62855555${suffix}`, `echo_${suffix}@test.com`, fixtures.property2]
    );
    fixtures.guests.push(gE.rows[0].id);

    // Guest F1 and F2 (Property 1: Duplicate phone match candidates)
    const sharedPhone = `+62899999${suffix}`;
    const gF1 = await pool.query(
      `INSERT INTO guests (full_name, phone, email, created_property_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [`Guest Dup FoxOne ${suffix}`, sharedPhone, `fox1_${suffix}@test.com`, fixtures.property1]
    );
    fixtures.guests.push(gF1.rows[0].id);

    const gF2 = await pool.query(
      `INSERT INTO guests (full_name, phone, email, created_property_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [`Guest Dup FoxTwo ${suffix}`, sharedPhone, `fox2_${suffix}@test.com`, fixtures.property1]
    );
    fixtures.guests.push(gF2.rows[0].id);

    // Create Bookings & Reservations for Stays
    // Stay 1 for Guest A: 2 nights CHECKED_OUT (60 days ago)
    const b1 = await pool.query(`INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ($1, $2, 'Booking A1') RETURNING id`, [`BID-A1-${suffix}`, fixtures.property1]);
    fixtures.bookings.push(b1.rows[0].id);
    const rA1 = await pool.query(
      `INSERT INTO reservations (booking_id, stay_sequence, room_id, booked_room_type_id_snapshot, guest_name, check_in, check_out, status, total_price)
       VALUES ($1, 1, $2, $3, 'Guest A Snapshot', '2026-06-01', '2026-06-03', 'CHECKED_OUT', 1000000) RETURNING id`,
      [b1.rows[0].id, fixtures.room1, fixtures.roomType1]
    );
    fixtures.reservations.push(rA1.rows[0].id);
    await pool.query(`INSERT INTO reservation_guests (reservation_id, guest_id, role) VALUES ($1, $2, 'PRIMARY_GUEST')`, [rA1.rows[0].id, gA.rows[0].id]);

    // Stay 2 for Guest A: 3 nights CHECKED_OUT (15 days ago) -> Makes Guest A a Repeat Guest (visit_count = 2, room_nights = 5)
    const b2 = await pool.query(`INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ($1, $2, 'Booking A2') RETURNING id`, [`BID-A2-${suffix}`, fixtures.property1]);
    fixtures.bookings.push(b2.rows[0].id);
    const rA2 = await pool.query(
      `INSERT INTO reservations (booking_id, stay_sequence, room_id, booked_room_type_id_snapshot, guest_name, check_in, check_out, status, total_price)
       VALUES ($1, 1, $2, $3, 'Guest A Snapshot', '2026-08-10', '2026-08-13', 'CHECKED_OUT', 1500000) RETURNING id`,
      [b2.rows[0].id, fixtures.room2, fixtures.roomType1]
    );
    fixtures.reservations.push(rA2.rows[0].id);
    await pool.query(`INSERT INTO reservation_guests (reservation_id, guest_id, role) VALUES ($1, $2, 'PRIMARY_GUEST')`, [rA2.rows[0].id, gA.rows[0].id]);

    // Stay for Guest B: 1 night CHECKED_OUT (120 days ago) -> Dormant > 90 days
    const b3 = await pool.query(`INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ($1, $2, 'Booking B') RETURNING id`, [`BID-B-${suffix}`, fixtures.property1]);
    fixtures.bookings.push(b3.rows[0].id);
    const rB = await pool.query(
      `INSERT INTO reservations (booking_id, stay_sequence, room_id, booked_room_type_id_snapshot, guest_name, check_in, check_out, status, total_price)
       VALUES ($1, 1, $2, $3, 'Guest B Snapshot', '2026-04-01', '2026-04-02', 'CHECKED_OUT', 500000) RETURNING id`,
      [b3.rows[0].id, fixtures.room1, fixtures.roomType1]
    );
    fixtures.reservations.push(rB.rows[0].id);
    await pool.query(`INSERT INTO reservation_guests (reservation_id, guest_id, role) VALUES ($1, $2, 'PRIMARY_GUEST')`, [rB.rows[0].id, gB.rows[0].id]);

    // Stay for Guest C: 2 nights CHECKED_IN (5 days ago) -> New Guest in 30d (visit_count = 1, room_nights = 2)
    const b4 = await pool.query(`INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ($1, $2, 'Booking C') RETURNING id`, [`BID-C-${suffix}`, fixtures.property1]);
    fixtures.bookings.push(b4.rows[0].id);
    const rC = await pool.query(
      `INSERT INTO reservations (booking_id, stay_sequence, room_id, booked_room_type_id_snapshot, guest_name, check_in, check_out, status, total_price)
       VALUES ($1, 1, $2, $3, 'Guest C Snapshot', '2026-08-22', '2026-08-24', 'CHECKED_IN', 1000000) RETURNING id`,
      [b4.rows[0].id, fixtures.room2, fixtures.roomType1]
    );
    fixtures.reservations.push(rC.rows[0].id);
    await pool.query(`INSERT INTO reservation_guests (reservation_id, guest_id, role) VALUES ($1, $2, 'PRIMARY_GUEST')`, [rC.rows[0].id, gC.rows[0].id]);

    // Reservations for Guest D: 1 CANCELLED and 1 future BOOKED -> Neither should count as completed visit!
    const b5 = await pool.query(`INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ($1, $2, 'Booking D1') RETURNING id`, [`BID-D1-${suffix}`, fixtures.property1]);
    fixtures.bookings.push(b5.rows[0].id);
    const rD1 = await pool.query(
      `INSERT INTO reservations (booking_id, stay_sequence, room_id, booked_room_type_id_snapshot, guest_name, check_in, check_out, status, total_price)
       VALUES ($1, 1, $2, $3, 'Guest D Snapshot', '2026-08-01', '2026-08-03', 'CANCELLED', 1000000) RETURNING id`,
      [b5.rows[0].id, fixtures.room1, fixtures.roomType1]
    );
    fixtures.reservations.push(rD1.rows[0].id);
    await pool.query(`INSERT INTO reservation_guests (reservation_id, guest_id, role) VALUES ($1, $2, 'PRIMARY_GUEST')`, [rD1.rows[0].id, gD.rows[0].id]);

    const b6 = await pool.query(`INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ($1, $2, 'Booking D2') RETURNING id`, [`BID-D2-${suffix}`, fixtures.property1]);
    fixtures.bookings.push(b6.rows[0].id);
    const rD2 = await pool.query(
      `INSERT INTO reservations (booking_id, stay_sequence, room_id, booked_room_type_id_snapshot, guest_name, check_in, check_out, status, total_price)
       VALUES ($1, 1, $2, $3, 'Guest D Snapshot', '2026-09-01', '2026-09-03', 'BOOKED', 1000000) RETURNING id`,
      [b6.rows[0].id, fixtures.room2, fixtures.roomType1]
    );
    fixtures.reservations.push(rD2.rows[0].id);
    await pool.query(`INSERT INTO reservation_guests (reservation_id, guest_id, role) VALUES ($1, $2, 'PRIMARY_GUEST')`, [rD2.rows[0].id, gD.rows[0].id]);

    // Stay for Guest E on Property 2
    const b7 = await pool.query(`INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ($1, $2, 'Booking E') RETURNING id`, [`BID-E-${suffix}`, fixtures.property2]);
    fixtures.bookings.push(b7.rows[0].id);
    const rE = await pool.query(
      `INSERT INTO reservations (booking_id, stay_sequence, room_id, booked_room_type_id_snapshot, guest_name, check_in, check_out, status, total_price)
       VALUES ($1, 1, $2, $3, 'Guest E Snapshot', '2026-08-01', '2026-08-03', 'CHECKED_OUT', 1000000) RETURNING id`,
      [b7.rows[0].id, fixtures.room3, fixtures.roomType2]
    );
    fixtures.reservations.push(rE.rows[0].id);
    await pool.query(`INSERT INTO reservation_guests (reservation_id, guest_id, role) VALUES ($1, $2, 'PRIMARY_GUEST')`, [rE.rows[0].id, gE.rows[0].id]);

    console.log('\n--- Test 1: Property Scoped Guest Search & Aggregate Statistics ---');
    const p1ListRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests?property_id=${fixtures.property1}&limit=50`,
      method: 'GET'
    });
    assert(p1ListRes.statusCode === 200, '1.1 GET /api/guests for P1 returns 200');
    const p1Guests = p1ListRes.body?.data || [];
    const p1GuestIds = p1Guests.map(g => g.id);
    assert(p1GuestIds.includes(gA.rows[0].id), '1.2 P1 includes Guest A');
    assert(p1GuestIds.includes(gB.rows[0].id), '1.3 P1 includes Guest B');
    assert(p1GuestIds.includes(gC.rows[0].id), '1.4 P1 includes Guest C');
    assert(p1GuestIds.includes(gD.rows[0].id), '1.5 P1 includes Guest D');
    assert(!p1GuestIds.includes(gE.rows[0].id), '1.6 P1 strictly excludes Guest E (Property 2 isolation)');

    // Check stats for Guest A
    const foundGA = p1Guests.find(g => g.id === gA.rows[0].id);
    assert(foundGA?.visit_count === 2, '1.7 Guest A has visit_count = 2');
    assert(foundGA?.room_nights === 5, '1.8 Guest A has room_nights = 5 (2 nights + 3 nights)');
    assert(foundGA?.first_stay === '2026-06-01', '1.9 Guest A first_stay is 2026-06-01');
    assert(foundGA?.last_stay === '2026-08-13', '1.10 Guest A last_stay is 2026-08-13');

    // Check stats for Guest D (cancelled + future booked -> 0 completed visits)
    const foundGD = p1Guests.find(g => g.id === gD.rows[0].id);
    assert(foundGD?.visit_count === 0, '1.11 Guest D visit_count = 0 (cancelled and future booked are excluded)');
    assert(foundGD?.room_nights === 0, '1.12 Guest D room_nights = 0');

    console.log('\n--- Test 2: Property Scoped CRM Summary Metrics ---');
    const crmSummaryRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/crm-summary?property_id=${fixtures.property1}&hotel_date=${today}`,
      method: 'GET'
    });
    assert(crmSummaryRes.statusCode === 200, '2.1 GET /api/guests/crm-summary returns 200');
    const summary = crmSummaryRes.body?.data || {};

    assert(summary.property_id === fixtures.property1, '2.2 Summary is scoped to Property 1');
    assert(summary.total_guests >= 6, '2.3 Total guests visible to P1 >= 6 (A, B, C, D, F1, F2)');
    assert(summary.guests_with_qualifying_stay >= 3, '2.4 Qualifying stay guests >= 3 (A, B, C)');
    assert(summary.repeat_guests >= 1, '2.5 Repeat guests >= 1 (Guest A has 2 stays)');
    assert(typeof summary.repeat_rate === 'number' && summary.repeat_rate > 0, '2.6 Repeat rate is calculated percentage');
    assert(summary.new_guests_last_30d >= 1, '2.7 New guests in 30d >= 1 (Guest C first stayed 5 days ago)');
    assert(summary.dormant_guests_90d >= 1, '2.8 Dormant guests >= 1 (Guest B stayed 120 days ago)');

    // Birthdays check
    const birthdays = summary.birthdays_this_month || [];
    const bB = birthdays.find(b => b.id === gB.rows[0].id);
    assert(bB !== undefined, '2.9 Guest B appears in birthdays_this_month');
    assert(bB?.birth_day === 15, '2.10 Guest B birthday day is 15');

    // Follow up check
    const followUps = summary.follow_up_candidates || [];
    const fU = followUps.find(f => f.id === gB.rows[0].id);
    assert(fU !== undefined, '2.11 Guest B appears in follow_up_candidates (>90 days)');
    assert(fU?.days_since_last_stay >= 90, '2.12 Guest B days_since_last_stay >= 90');

    console.log('\n--- Test 3: Duplicate Candidate Detection ---');
    const dupRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/duplicate-candidates?property_id=${fixtures.property1}`,
      method: 'GET'
    });
    assert(dupRes.statusCode === 200, '3.1 GET /api/guests/duplicate-candidates returns 200');
    const clusters = dupRes.body?.data || [];
    const phoneCluster = clusters.find(c => c.match_reason === 'PHONE' && c.match_key === sharedPhone);
    assert(phoneCluster !== undefined, '3.2 Identified duplicate cluster matching shared phone');
    assert(phoneCluster?.guests?.length === 2, '3.3 Cluster contains exactly 2 guests (F1 & F2)');
    const clusterIds = phoneCluster?.guests?.map(g => g.id) || [];
    assert(clusterIds.includes(gF1.rows[0].id) && clusterIds.includes(gF2.rows[0].id), '3.4 Cluster includes both F1 and F2');

    console.log('\n--- Test 4: Property 2 Pre-Shared Isolation Check ---');
    const p2CrmRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/crm-summary?property_id=${fixtures.property2}&hotel_date=${today}`,
      method: 'GET'
    });
    assert(p2CrmRes.statusCode === 200, '4.1 GET /api/guests/crm-summary for P2 returns 200');
    const p2Summary = p2CrmRes.body?.data || {};
    assert(p2Summary.total_guests === 1, '4.2 Property 2 sees only 1 guest (Guest E) before shared guest');
    assert(p2Summary.repeat_guests === 0, '4.3 Property 2 has 0 repeat guests');

    console.log('\n--- Test 5: Shared Guest (Created at P1, Stays at P2) Visibility & Isolation ---');
    // Guest G: created at Property 1, has 1 stay at P1 (100 days ago) and 1 stay at P2 (2 days ago)
    const gG = await pool.query(
      `INSERT INTO guests (full_name, phone, email, birth_date, vip_status, created_property_id)
       VALUES ($1, $2, $3, $4, 'VIP', $5) RETURNING id`,
      [`Guest Shared Golf ${suffix}`, `+62877777${suffix}`, `golf_${suffix}@test.com`, birthdayDate, fixtures.property1]
    );
    fixtures.guests.push(gG.rows[0].id);

    // Stay 1 for Guest G on Property 1: 2 nights CHECKED_OUT (100 days ago)
    const bG1 = await pool.query(`INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ($1, $2, 'Booking G1') RETURNING id`, [`BID-G1-${suffix}`, fixtures.property1]);
    fixtures.bookings.push(bG1.rows[0].id);
    const rG1 = await pool.query(
      `INSERT INTO reservations (booking_id, stay_sequence, room_id, booked_room_type_id_snapshot, guest_name, check_in, check_out, status, total_price)
       VALUES ($1, 1, $2, $3, 'Guest G Snapshot', '2026-05-10', '2026-05-12', 'CHECKED_OUT', 1000000) RETURNING id`,
      [bG1.rows[0].id, fixtures.room1, fixtures.roomType1]
    );
    fixtures.reservations.push(rG1.rows[0].id);
    await pool.query(`INSERT INTO reservation_guests (reservation_id, guest_id, role, is_legacy_inferred, identity_verified) VALUES ($1, $2, 'PRIMARY_GUEST', false, false)`, [rG1.rows[0].id, gG.rows[0].id]);

    // Stay 2 for Guest G on Property 2: 1 night CHECKED_OUT (2 days ago)
    const bG2 = await pool.query(`INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ($1, $2, 'Booking G2') RETURNING id`, [`BID-G2-${suffix}`, fixtures.property2]);
    fixtures.bookings.push(bG2.rows[0].id);
    const rG2 = await pool.query(
      `INSERT INTO reservations (booking_id, stay_sequence, room_id, booked_room_type_id_snapshot, guest_name, check_in, check_out, status, total_price)
       VALUES ($1, 1, $2, $3, 'Guest G Snapshot', '2026-08-25', '2026-08-26', 'CHECKED_OUT', 500000) RETURNING id`,
      [bG2.rows[0].id, fixtures.room3, fixtures.roomType2]
    );
    fixtures.reservations.push(rG2.rows[0].id);
    await pool.query(`INSERT INTO reservation_guests (reservation_id, guest_id, role, is_legacy_inferred, identity_verified) VALUES ($1, $2, 'PRIMARY_GUEST', false, false)`, [rG2.rows[0].id, gG.rows[0].id]);

    // 5.1 Shared Guest is visible in Property 2 guest search
    const p2ListWithShared = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests?property_id=${fixtures.property2}&limit=50`,
      method: 'GET'
    });
    assert(p2ListWithShared.statusCode === 200, '5.1 GET /api/guests for P2 returns 200');
    const p2Guests = p2ListWithShared.body?.data || [];
    const foundGGinP2 = p2Guests.find(g => g.id === gG.rows[0].id);
    assert(foundGGinP2 !== undefined, '5.2 Shared Guest G (created at P1) is visible from P2 due to P2 reservation');

    // 5.2 Property 2 statistics use Property 2 activity only
    assert(foundGGinP2?.visit_count === 1, '5.3 P2 stats for Guest G shows visit_count = 1 (P2 stay only)');
    assert(foundGGinP2?.room_nights === 1, '5.4 P2 stats for Guest G shows room_nights = 1 (P2 stay only)');
    assert(foundGGinP2?.first_stay === '2026-08-25', '5.5 P2 first_stay is 2026-08-25 (excludes P1 stay in May)');
    assert(foundGGinP2?.last_stay === '2026-08-26', '5.6 P2 last_stay is 2026-08-26');

    // 5.3 Direct lookup of Shared Guest from Property 2
    const p2DetailRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/${gG.rows[0].id}?property_id=${fixtures.property2}`,
      method: 'GET'
    });
    assert(p2DetailRes.statusCode === 200, '5.7 GET /api/guests/:id?property_id=P2 allowed for shared guest');
    const p2Detail = p2DetailRes.body?.data || {};
    assert(p2Detail.stays?.length === 1, '5.8 P2 receives only 1 stay in stay history (Property 1 stay is NOT leaked)');
    assert(p2Detail.stays?.[0]?.bid === `BID-G2-${suffix}`, '5.9 Stay in P2 history is BID-G2');
    assert(p2Detail.stays?.[0]?.is_legacy_inferred === false, '5.10 Stay is_legacy_inferred = false');
    assert(p2Detail.stays?.[0]?.identity_verified === false, '5.11 Stay identity_verified = false');

    // 5.4 CRM Summary for Property 2 includes Shared Guest
    const p2CrmAfter = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/crm-summary?property_id=${fixtures.property2}&hotel_date=${today}`,
      method: 'GET'
    });
    assert(p2CrmAfter.statusCode === 200, '5.12 GET /api/guests/crm-summary for P2 returns 200');
    const p2SummaryAfter = p2CrmAfter.body?.data || {};
    assert(p2SummaryAfter.total_guests === 2, '5.13 P2 total_guests is exactly 2 (Guest E + Guest G, counted once)');
    assert(p2SummaryAfter.new_guests_last_30d === 2, '5.14 P2 new_guests_last_30d = 2 (Guest E + Guest G both first stayed <=30d)');

    // 5.5 Shared Guest birthday appears in Property 2 CRM birthday panel
    const p2Birthdays = p2SummaryAfter.birthdays_this_month || [];
    const bGGinP2 = p2Birthdays.find(b => b.id === gG.rows[0].id);
    assert(bGGinP2 !== undefined, '5.15 Shared Guest G appears in Property 2 birthdays_this_month');

    // 5.6 Follow-up calculation in Property 1 vs Property 2
    // On Property 1: Guest G stayed 100 days ago -> appears in P1 follow_up_candidates (>90 days)!
    const p1CrmAfter = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/crm-summary?property_id=${fixtures.property1}&hotel_date=${today}`,
      method: 'GET'
    });
    const p1SummaryAfter = p1CrmAfter.body?.data || {};
    const p1FollowUps = p1SummaryAfter.follow_up_candidates || [];
    const fGGinP1 = p1FollowUps.find(f => f.id === gG.rows[0].id);
    assert(fGGinP1 !== undefined, '5.16 Guest G appears in Property 1 follow_up_candidates based on P1 last stay (May 2026)');
    assert(fGGinP1?.days_since_last_stay >= 90, '5.17 P1 follow-up uses P1 last stay (>90 days), not P2 recent stay');

    // On Property 2: Guest G stayed 2 days ago -> does NOT appear in P2 follow_up_candidates
    const p2FollowUps = p2SummaryAfter.follow_up_candidates || [];
    const fGGinP2 = p2FollowUps.find(f => f.id === gG.rows[0].id);
    assert(fGGinP2 === undefined, '5.18 Guest G does NOT appear in Property 2 follow_up_candidates (stayed 2 days ago at P2)');

    // 5.7 Strict Qualifying Stays: Future BOOKED and CANCELLED cannot create Tamu Baru
    // In summary, Guest D has only CANCELLED + BOOKED stays.
    const p1ListAfter = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests?property_id=${fixtures.property1}&limit=50`,
      method: 'GET'
    });
    const p1GuestsAfter = p1ListAfter.body?.data || [];
    const foundGuestD = p1GuestsAfter.find(g => g.id === gD.rows[0].id);
    assert(foundGuestD !== undefined, '5.19 Guest D is visible on P1');
    assert(foundGuestD?.first_stay === null, '5.20 Guest D first_stay is null (neither CANCELLED nor BOOKED counts)');
    assert(foundGuestD?.last_stay === null, '5.21 Guest D last_stay is null');

  } finally {
    // Teardown Fixtures
    console.log('\n--- Cleaning up test fixtures ---');
    try {
      if (fixtures.reservations.length > 0) {
        await pool.query('DELETE FROM reservation_guests WHERE reservation_id = ANY($1::int[])', [fixtures.reservations]);
        await pool.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [fixtures.reservations]);
      }
      if (fixtures.bookings.length > 0) {
        await pool.query('DELETE FROM bookings WHERE id = ANY($1::int[])', [fixtures.bookings]);
      }
      if (fixtures.guests.length > 0) {
        await pool.query('DELETE FROM guests WHERE id = ANY($1::int[])', [fixtures.guests]);
      }
      if (fixtures.room1 || fixtures.room2 || fixtures.room3) {
        await pool.query('DELETE FROM rooms WHERE id = ANY($1::int[])', [[fixtures.room1, fixtures.room2, fixtures.room3].filter(Boolean)]);
      }
      if (fixtures.roomType1 || fixtures.roomType2) {
        await pool.query('DELETE FROM room_types WHERE id = ANY($1::int[])', [[fixtures.roomType1, fixtures.roomType2].filter(Boolean)]);
      }
      if (fixtures.property1 || fixtures.property2) {
        const propIds = [fixtures.property1, fixtures.property2].filter(Boolean);
        await pool.query('DELETE FROM meal_plans WHERE property_id = ANY($1::int[])', [propIds]);
        await pool.query('DELETE FROM ota_sources WHERE property_id = ANY($1::int[])', [propIds]);
        await pool.query('DELETE FROM property_day_use_durations WHERE property_id = ANY($1::int[])', [propIds]);
        await pool.query('DELETE FROM property_quick_booking_rules WHERE property_id = ANY($1::int[])', [propIds]);
        await pool.query('DELETE FROM property_pricing_settings WHERE property_id = ANY($1::int[])', [propIds]);
        await pool.query('DELETE FROM property_brandings WHERE property_id = ANY($1::int[])', [propIds]);
        await pool.query('DELETE FROM stay_charge_rules WHERE property_id = ANY($1::int[])', [propIds]);
        await pool.query('DELETE FROM property_housekeeping_settings WHERE property_id = ANY($1::int[])', [propIds]);
        await pool.query('DELETE FROM property_attendance_settings WHERE property_id = ANY($1::int[])', [propIds]);
        await pool.query('DELETE FROM property_features WHERE property_id = ANY($1::int[])', [propIds]);
        await pool.query('DELETE FROM housekeeping_finding_types WHERE property_id = ANY($1::int[])', [propIds]);
        await pool.query('DELETE FROM audit_logs WHERE property_id = ANY($1::int[])', [propIds]);
        await pool.query('DELETE FROM properties WHERE id = ANY($1::int[])', [propIds]);
      }
    } catch (cleanErr) {
      console.error('Fixture cleanup error:', cleanErr);
    }

    if (server) {
      server.close();
    }
    await pool.end();
  }

  console.log(`\n================================`);
  console.log(`Summary: ${passed} PASSED, ${failed} FAILED`);
  console.log(`================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
