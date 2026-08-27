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

  // Ensure DB initialized
  await initializeDatabase(pool);

  let server;
  let port;

  const fixtures = {
    propertyId1: null,
    propertyId2: null,
    bookingId1: null,
    bookingId2: null,
    reservationId1: null,
    reservationId2: null,
    guestIds: [],
    relationIds: []
  };

  try {
    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });

    console.log(`Server listening on port ${port}`);

    // =========================================================================
    // A. Schema Exists & Partial Index Exists
    // =========================================================================
    console.log('\n--- Test A: Schema Verification ---');
    const tableGuests = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'guests'"
    );
    assert(tableGuests.rowCount === 1, 'A1. guests table exists');

    const tableResGuests = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'reservation_guests'"
    );
    assert(tableResGuests.rowCount === 1, 'A2. reservation_guests table exists');

    const indexPrimary = await pool.query(
      "SELECT 1 FROM pg_indexes WHERE tablename = 'reservation_guests' AND indexname = 'idx_reservation_single_primary_guest'"
    );
    assert(indexPrimary.rowCount === 1, 'A3. idx_reservation_single_primary_guest partial unique index exists');

    const indexRole = await pool.query(
      "SELECT 1 FROM pg_indexes WHERE tablename = 'reservation_guests' AND indexname = 'idx_reservation_guest_role'"
    );
    assert(indexRole.rowCount === 1, 'A4. idx_reservation_guest_role composite unique index exists');

    const colCreatedProp = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'guests' AND column_name = 'created_property_id'"
    );
    assert(colCreatedProp.rowCount === 1, 'A5. created_property_id column exists on guests table');

    // =========================================================================
    // Setup Test Fixtures (Property 1 & Property 2)
    // =========================================================================
    console.log('\n--- Setup Test Fixtures ---');
    const pCode1 = 'G' + Math.floor(1000 + Math.random() * 8999);
    const pCode2 = 'H' + Math.floor(1000 + Math.random() * 8999);

    const prop1Res = await pool.query(
      "INSERT INTO properties (property_code, name, address) VALUES ($1, 'Guest Test Prop 1', 'Jl. Test 1') RETURNING id",
      [pCode1]
    );
    fixtures.propertyId1 = prop1Res.rows[0].id;

    const prop2Res = await pool.query(
      "INSERT INTO properties (property_code, name, address) VALUES ($1, 'Guest Test Prop 2', 'Jl. Test 2') RETURNING id",
      [pCode2]
    );
    fixtures.propertyId2 = prop2Res.rows[0].id;

    const rtRes = await pool.query(
      "INSERT INTO room_types (property_id, code, name, base_rate, capacity) VALUES ($1, 'DLX', 'Deluxe', 500000, 2) RETURNING id",
      [fixtures.propertyId1]
    );
    const rtId = rtRes.rows[0].id;

    const rmRes = await pool.query(
      "INSERT INTO rooms (property_id, room_number, name, room_type_id, status) VALUES ($1, 'G-101', 'Deluxe 101', $2, 'VACANT_CLEAN') RETURNING id",
      [fixtures.propertyId1, rtId]
    );
    const rmId = rmRes.rows[0].id;

    // Booking 1 on Property 1
    const b1Res = await pool.query(
      "INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ('BID-GST-1', $1, 'Siti Booker') RETURNING id",
      [fixtures.propertyId1]
    );
    fixtures.bookingId1 = b1Res.rows[0].id;

    const r1Res = await pool.query(
      "INSERT INTO reservations (booking_id, stay_sequence, guest_name, guest_phone, status, room_id, check_in, check_out) VALUES ($1, 1, 'Budi Primary', '081122334455', 'BOOKED', $2, '2026-09-01 14:00:00', '2026-09-03 12:00:00') RETURNING id",
      [fixtures.bookingId1, rmId]
    );
    fixtures.reservationId1 = r1Res.rows[0].id;

    // Booking 2 on Property 2
    const b2Res = await pool.query(
      "INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ('BID-GST-2', $1, 'Other Booker') RETURNING id",
      [fixtures.propertyId2]
    );
    fixtures.bookingId2 = b2Res.rows[0].id;

    const r2Res = await pool.query(
      "INSERT INTO reservations (booking_id, stay_sequence, guest_name, guest_phone, status, check_in, check_out) VALUES ($1, 1, 'Prop2 Guest', '089988776655', 'BOOKED', '2026-09-01 14:00:00', '2026-09-03 12:00:00') RETURNING id",
      [fixtures.bookingId2]
    );
    fixtures.reservationId2 = r2Res.rows[0].id;

    // =========================================================================
    // C & G. Guest Create & Audit Log (and Property Context Validation)
    // =========================================================================
    console.log('\n--- Test C & G: Guest Create & Property Context Validation ---');
    // Missing property_id
    const missingPropRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: '/api/guests',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      full_name: 'No Prop Guest'
    });
    assert(missingPropRes.statusCode === 400, 'G1. Create guest without property_id returns 400');
    assert(missingPropRes.body.code === 'VALIDATION_ERROR', 'G2. Missing property_id error code is VALIDATION_ERROR');

    // Unknown property_id
    const unknownPropRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: '/api/guests',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: 999999,
      full_name: 'Unknown Prop Guest'
    });
    assert(unknownPropRes.statusCode === 404, 'G3. Create guest with unknown property_id returns 404');
    assert(unknownPropRes.body.code === 'PROPERTY_NOT_FOUND', 'G4. Unknown property_id error code is PROPERTY_NOT_FOUND');

    // Valid create on Property 1
    const createRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: '/api/guests',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: fixtures.propertyId1,
      full_name: 'Budi Santoso',
      phone: '081234567890',
      email: 'budi.santoso@example.com',
      gender: 'MALE',
      vip_status: 'VIP',
      nationality: 'ID',
      notes: 'VIP Guest preferred floor'
    });

    assert(createRes.statusCode === 201, 'C1. POST /api/guests returns 201 Created');
    assert(createRes.body.status === 'SUCCESS', 'C2. Response envelope is SUCCESS');
    assert(createRes.body.data.full_name === 'Budi Santoso', 'C3. Full name matches');
    assert(createRes.body.data.vip_status === 'VIP', 'C4. VIP status matches');
    assert(Number(createRes.body.data.created_property_id) === fixtures.propertyId1, 'C5. created_property_id matches Property 1');
    const guest1Id = createRes.body.data.id;
    fixtures.guestIds.push(guest1Id);

    // Verify audit log
    const auditRes = await pool.query(
      "SELECT * FROM audit_logs WHERE entity = 'GUEST' AND record_id = $1 AND action = 'GUEST_CREATE'",
      [String(guest1Id)]
    );
    assert(auditRes.rowCount === 1, 'C6. GUEST_CREATE audit log recorded');
    assert(Number(auditRes.rows[0].property_id) === fixtures.propertyId1, 'C7. Audit log has correct property_id');

    // =========================================================================
    // D. Guest Edit & Audit Log
    // =========================================================================
    console.log('\n--- Test D: Guest Edit ---');
    const patchRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/${guest1Id}`,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: fixtures.propertyId1,
      vip_status: 'VVIP',
      notes: 'Upgraded to VVIP'
    });

    assert(patchRes.statusCode === 200, 'D1. PATCH /api/guests/:id returns 200 OK');
    assert(patchRes.body.data.vip_status === 'VVIP', 'D2. VIP status updated to VVIP');
    assert(patchRes.body.data.notes === 'Upgraded to VVIP', 'D3. Notes updated');

    const editAuditRes = await pool.query(
      "SELECT * FROM audit_logs WHERE entity = 'GUEST' AND record_id = $1 AND action = 'GUEST_UPDATE'",
      [String(guest1Id)]
    );
    assert(editAuditRes.rowCount === 1, 'D4. GUEST_UPDATE audit log recorded');

    // Create a 2nd guest (Siti Booker) on Property 1
    const createRes2 = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: '/api/guests',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: fixtures.propertyId1,
      full_name: 'Siti Aminah',
      phone: '081298765432',
      email: 'siti@example.com',
      gender: 'FEMALE',
      vip_status: 'STANDARD'
    });
    const guest2Id = createRes2.body.data.id;
    fixtures.guestIds.push(guest2Id);

    // Create a 3rd guest (Anak Additional) on Property 1
    const createRes3 = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: '/api/guests',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: fixtures.propertyId1,
      full_name: 'Anak Budi',
      gender: 'MALE',
      vip_status: 'STANDARD'
    });
    const guest3Id = createRes3.body.data.id;
    fixtures.guestIds.push(guest3Id);

    // Create a Property 2-Only Guest (Guest X) on Property 2
    const createResProp2Only = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: '/api/guests',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: fixtures.propertyId2,
      full_name: 'Rudi Property2Only',
      phone: '089911122233',
      email: 'rudi.p2@example.com',
      gender: 'MALE',
      vip_status: 'STANDARD'
    });
    const guestProp2OnlyId = createResProp2Only.body.data.id;
    fixtures.guestIds.push(guestProp2OnlyId);

    // =========================================================================
    // Security Gate Tests: Property A vs Property B-Only Guest
    // =========================================================================
    console.log('\n--- Security Gate: Property A vs Property B-Only Guest ---');
    // A. Property A search cannot enumerate Property B-only guest
    const searchP1ForP2Guest = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests?property_id=${fixtures.propertyId1}&search=Rudi`,
      method: 'GET'
    });
    assert(searchP1ForP2Guest.statusCode === 200, 'Sec-A1. Search from Property 1 returns 200');
    assert(
      !searchP1ForP2Guest.body.data.some(g => g.id === guestProp2OnlyId),
      'Sec-A2. Property 1 search CANNOT enumerate Property 2-only guest (zero disclosure)'
    );

    // B. Property A direct lookup of Property B-only guest rejected with 403
    const directLookupP1ForP2Guest = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/${guestProp2OnlyId}?property_id=${fixtures.propertyId1}`,
      method: 'GET'
    });
    assert(directLookupP1ForP2Guest.statusCode === 403, 'Sec-B1. Property 1 direct lookup of Property 2-only guest returns 403 Forbidden');
    assert(directLookupP1ForP2Guest.body.code === 'PROPERTY_MISMATCH', 'Sec-B2. Error code is PROPERTY_MISMATCH');

    // C. Property A cannot PATCH Property B-only guest
    const patchP1ForP2Guest = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/${guestProp2OnlyId}`,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: fixtures.propertyId1,
      vip_status: 'VIP'
    });
    assert(patchP1ForP2Guest.statusCode === 403, 'Sec-C1. Property 1 cannot PATCH Property 2-only guest (403 Forbidden)');
    assert(patchP1ForP2Guest.body.code === 'PROPERTY_MISMATCH', 'Sec-C2. Error code is PROPERTY_MISMATCH');

    // =========================================================================
    // E. Reservation Guest Relation & H. Booker ≠ Primary Guest
    // =========================================================================
    console.log('\n--- Test E & H: Reservation Guest Relations (Booker ≠ Primary) ---');
    // Add Booker (Siti)
    const bookerRelRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/reservations/${fixtures.reservationId1}/guests`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: fixtures.propertyId1,
      guest_id: guest2Id,
      role: 'BOOKER',
      relationship: 'COMPANY_ASSISTANT',
      is_staying: false
    });
    assert(bookerRelRes.statusCode === 201, 'E1. Added BOOKER relation to reservation 1');
    assert(bookerRelRes.body.data.role === 'BOOKER', 'E2. Role is BOOKER');
    fixtures.relationIds.push(bookerRelRes.body.data.id);

    // Add Primary Guest (Budi)
    const primaryRelRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/reservations/${fixtures.reservationId1}/guests`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: fixtures.propertyId1,
      guest_id: guest1Id,
      role: 'PRIMARY_GUEST',
      relationship: 'SELF',
      is_staying: true,
      identity_verified: true
    });
    assert(primaryRelRes.statusCode === 201, 'E3. Added PRIMARY_GUEST relation to reservation 1');
    assert(primaryRelRes.body.data.role === 'PRIMARY_GUEST', 'E4. Role is PRIMARY_GUEST');
    fixtures.relationIds.push(primaryRelRes.body.data.id);

    // =========================================================================
    // F. One-Primary Invariant
    // =========================================================================
    console.log('\n--- Test F: One-Primary Invariant ---');
    const conflictRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/reservations/${fixtures.reservationId1}/guests`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: fixtures.propertyId1,
      guest_id: guest3Id,
      role: 'PRIMARY_GUEST',
      relationship: 'SPOUSE'
    });
    assert(conflictRes.statusCode === 409, 'F1. Attempting 2nd PRIMARY_GUEST returns 409 Conflict');
    assert(conflictRes.body.code === 'PRIMARY_GUEST_CONFLICT', 'F2. Error code is PRIMARY_GUEST_CONFLICT');

    // =========================================================================
    // G. Multiple Additional Guests
    // =========================================================================
    console.log('\n--- Test G: Multiple Additional Guests ---');
    const addl1Res = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/reservations/${fixtures.reservationId1}/guests`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: fixtures.propertyId1,
      guest_id: guest3Id,
      role: 'ADDITIONAL_GUEST',
      relationship: 'CHILD',
      is_staying: true
    });
    assert(addl1Res.statusCode === 201, 'G1. Added ADDITIONAL_GUEST successfully');
    fixtures.relationIds.push(addl1Res.body.data.id);

    // Verify list endpoint
    const listRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/reservations/${fixtures.reservationId1}/guests?property_id=${fixtures.propertyId1}`,
      method: 'GET'
    });
    assert(listRes.statusCode === 200, 'G2. GET /api/reservations/:id/guests returns 200 OK');
    assert(listRes.body.data.length === 3, 'G3. Exactly 3 linked guests (BOOKER, PRIMARY_GUEST, ADDITIONAL_GUEST)');

    // =========================================================================
    // Shared Guest A + B and Stay History Privacy (Tests D, E, F)
    // =========================================================================
    console.log('\n--- Test D, E, F: Shared Guest A+B & Stay History Privacy ---');
    // Link Guest 1 (Budi) to Property 2 Reservation 2
    const prop2RelRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/reservations/${fixtures.reservationId2}/guests`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: fixtures.propertyId2,
      guest_id: guest1Id,
      role: 'PRIMARY_GUEST',
      relationship: 'SELF'
    });
    assert(prop2RelRes.statusCode === 201, 'D1. Guest 1 linked as PRIMARY_GUEST on Property 2');
    fixtures.relationIds.push(prop2RelRes.body.data.id);

    // D. Shared guest A+B is accessible from Property 1
    const p1GetShared = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/${guest1Id}?property_id=${fixtures.propertyId1}`,
      method: 'GET'
    });
    assert(p1GetShared.statusCode === 200, 'D2. Shared guest is accessible from Property 1');

    // E. Shared guest's Property 2 stay history is HIDDEN when requesting as Property 1
    assert(Array.isArray(p1GetShared.body.data.stays), 'E1. Response includes stays array');
    assert(p1GetShared.body.data.stays.length === 1, 'E2. Property 1 response includes exactly 1 stay');
    assert(
      p1GetShared.body.data.stays[0].reservation_id === fixtures.reservationId1,
      'E3. Stay belongs to Reservation 1 (Property 1)'
    );
    assert(
      !p1GetShared.body.data.stays.some(s => s.reservation_id === fixtures.reservationId2),
      'E4. Property 2 Reservation 2 is NOT disclosed to Property 1 (strict privacy)'
    );

    // F. Property 2 gets ONLY Property 2 stay history
    const p2GetShared = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/${guest1Id}?property_id=${fixtures.propertyId2}`,
      method: 'GET'
    });
    assert(p2GetShared.statusCode === 200, 'F1. Shared guest is accessible from Property 2');
    assert(p2GetShared.body.data.stays.length === 1, 'F2. Property 2 response includes exactly 1 stay');
    assert(
      p2GetShared.body.data.stays[0].reservation_id === fixtures.reservationId2,
      'F3. Stay belongs to Reservation 2 (Property 2)'
    );
    assert(
      !p2GetShared.body.data.stays.some(s => s.reservation_id === fixtures.reservationId1),
      'F4. Property 1 Reservation 1 is NOT disclosed to Property 2 (strict privacy)'
    );

    // =========================================================================
    // H. New / Orphan Guest Isolation
    // =========================================================================
    console.log('\n--- Test H: New / Orphan Guest Isolation ---');
    // Create orphan guest on Property 1
    const createOrphanP1 = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: '/api/guests',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: fixtures.propertyId1,
      full_name: 'Orphan P1 Guest',
      phone: '081100099988',
      vip_status: 'STANDARD'
    });
    assert(createOrphanP1.statusCode === 201, 'H1. Created orphan guest on Property 1');
    const orphanP1Id = createOrphanP1.body.data.id;
    fixtures.guestIds.push(orphanP1Id);

    // Search from Property 1 -> Present
    const searchOrphanFromP1 = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests?property_id=${fixtures.propertyId1}&search=Orphan`,
      method: 'GET'
    });
    assert(searchOrphanFromP1.body.data.some(g => g.id === orphanP1Id), 'H2. Orphan guest visible to creator Property 1');

    // Search from Property 2 -> Hidden
    const searchOrphanFromP2 = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests?property_id=${fixtures.propertyId2}&search=Orphan`,
      method: 'GET'
    });
    assert(!searchOrphanFromP2.body.data.some(g => g.id === orphanP1Id), 'H3. Orphan guest NOT visible to Property 2');

    // Direct lookup from Property 2 -> 403 Forbidden
    const getOrphanFromP2 = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/${orphanP1Id}?property_id=${fixtures.propertyId2}`,
      method: 'GET'
    });
    assert(getOrphanFromP2.statusCode === 403, 'H4. Property 2 lookup of Property 1 orphan returns 403 Forbidden');

    // =========================================================================
    // J. Wrong-Property Reservation Rejected
    // =========================================================================
    console.log('\n--- Test J: Wrong-Property Validation ---');
    const wrongPropRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/reservations/${fixtures.reservationId2}/guests`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: fixtures.propertyId1, // Mismatch with reservation 2's property 2
      guest_id: guest1Id,
      role: 'ADDITIONAL_GUEST'
    });
    assert(wrongPropRes.statusCode === 403, 'J1. Adding guest to wrong-property reservation returns 403 Forbidden');
    assert(wrongPropRes.body.code === 'PROPERTY_MISMATCH', 'J2. Error code is PROPERTY_MISMATCH');

    // =========================================================================
    // K. Cross-Property Isolation in Reservation Guests
    // =========================================================================
    console.log('\n--- Test K: Cross-Property Isolation in Reservation Guests ---');
    const prop2ListRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/reservations/${fixtures.reservationId2}/guests?property_id=${fixtures.propertyId2}`,
      method: 'GET'
    });
    assert(prop2ListRes.statusCode === 200, 'K1. Listed guests for property 2 reservation');
    assert(
      !prop2ListRes.body.data.some(g => g.guest_id === guest3Id),
      'K2. Reservation 2 does not contain reservation 1 additional guest (zero leakage)'
    );

    // =========================================================================
    // L & M. Guest Search by Name and Phone
    // =========================================================================
    console.log('\n--- Test L & M: Guest Search ---');
    const searchNameRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests?property_id=${fixtures.propertyId1}&search=Santoso`,
      method: 'GET'
    });
    assert(searchNameRes.statusCode === 200, 'L1. Search by name returns 200');
    assert(searchNameRes.body.data.some(g => g.full_name === 'Budi Santoso'), 'L2. Found Budi Santoso');

    const searchPhoneRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests?property_id=${fixtures.propertyId1}&search=081298765432`,
      method: 'GET'
    });
    assert(searchPhoneRes.statusCode === 200, 'M1. Search by phone returns 200');
    assert(searchPhoneRes.body.data.some(g => g.full_name === 'Siti Aminah'), 'M2. Found Siti Aminah by phone');

    // =========================================================================
    // N & O. Non-Auto-Merge Invariants
    // =========================================================================
    console.log('\n--- Test N & O: Non-Auto-Merge Invariants ---');
    // Name-only duplicate created as distinct guest
    const dupNameRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: '/api/guests',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: fixtures.propertyId1,
      full_name: 'Budi Santoso',
      phone: '087711223344',
      vip_status: 'STANDARD'
    });
    assert(dupNameRes.statusCode === 201, 'N1. Created separate Budi Santoso with different phone');
    const guest4Id = dupNameRes.body.data.id;
    fixtures.guestIds.push(guest4Id);
    assert(guest4Id !== guest1Id, 'N2. Distinct ID generated, not merged');

    // Shared phone, different name
    const sharedPhoneRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: '/api/guests',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: fixtures.propertyId1,
      full_name: 'Agus Santoso',
      phone: '087711223344',
      vip_status: 'STANDARD'
    });
    assert(sharedPhoneRes.statusCode === 201, 'O1. Created separate Agus Santoso with shared phone');
    const guest5Id = sharedPhoneRes.body.data.id;
    fixtures.guestIds.push(guest5Id);
    assert(guest5Id !== guest4Id, 'O2. Distinct ID generated, not merged');

    // =========================================================================
    // P & Q. Legacy Inferred Links & Identity Verified Marker
    // =========================================================================
    console.log('\n--- Test P & Q: Legacy Inferred Verification ---');
    const legacyLinks = await pool.query(
      "SELECT * FROM reservation_guests WHERE relation_source = 'LEGACY_RESERVATION_SNAPSHOT' LIMIT 5"
    );
    if (legacyLinks.rowCount > 0) {
      assert(legacyLinks.rows[0].is_legacy_inferred === true, 'P1. Legacy relation has is_legacy_inferred = true');
      assert(legacyLinks.rows[0].identity_verified === false, 'Q1. Legacy relation has identity_verified = false');
      assert(legacyLinks.rows[0].role === 'PRIMARY_GUEST', 'P2. Legacy relation has role = PRIMARY_GUEST');
    }

    // =========================================================================
    // U. Existing Reservation Snapshots Preserved
    // =========================================================================
    console.log('\n--- Test U: Reservation Snapshot Preservation ---');
    const resSnapCheck = await pool.query('SELECT guest_name, guest_phone FROM reservations WHERE id = $1', [fixtures.reservationId1]);
    assert(resSnapCheck.rows[0].guest_name === 'Budi Primary', 'U1. reservations.guest_name preserved');
    assert(resSnapCheck.rows[0].guest_phone === '081122334455', 'U2. reservations.guest_phone preserved');

    const bookingSnapCheck = await pool.query('SELECT guest_name_snapshot FROM bookings WHERE id = $1', [fixtures.bookingId1]);
    assert(bookingSnapCheck.rows[0].guest_name_snapshot === 'Siti Booker', 'U3. bookings.guest_name_snapshot preserved');

  } catch (err) {
    console.error('Test error:', err);
    failed += 1;
  } finally {
    // =========================================================================
    // V. Fixture Cleanup (Zero Residue)
    // =========================================================================
    console.log('\n--- Test V: Fixture Cleanup ---');
    try {
      if (fixtures.relationIds.length > 0) {
        await pool.query('DELETE FROM reservation_guests WHERE id = ANY($1::int[])', [fixtures.relationIds]);
      }
      if (fixtures.guestIds.length > 0) {
        await pool.query('DELETE FROM audit_logs WHERE entity = \'GUEST\' AND record_id = ANY($1::text[])', [fixtures.guestIds.map(String)]);
        await pool.query('DELETE FROM guests WHERE id = ANY($1::int[])', [fixtures.guestIds]);
      }
      if (fixtures.reservationId1 || fixtures.reservationId2) {
        await pool.query('DELETE FROM reservations WHERE id IN ($1, $2)', [fixtures.reservationId1, fixtures.reservationId2]);
      }
      if (fixtures.bookingId1 || fixtures.bookingId2) {
        await pool.query('DELETE FROM bookings WHERE id IN ($1, $2)', [fixtures.bookingId1, fixtures.bookingId2]);
      }
      if (fixtures.propertyId1 || fixtures.propertyId2) {
        await pool.query('DELETE FROM audit_logs WHERE property_id IN ($1, $2)', [fixtures.propertyId1, fixtures.propertyId2]);
        await pool.query('DELETE FROM rooms WHERE property_id IN ($1, $2)', [fixtures.propertyId1, fixtures.propertyId2]);
        await pool.query('DELETE FROM room_types WHERE property_id IN ($1, $2)', [fixtures.propertyId1, fixtures.propertyId2]);
        await pool.query('DELETE FROM properties WHERE id IN ($1, $2)', [fixtures.propertyId1, fixtures.propertyId2]);
      }
      console.log('PASS | V1. All test fixtures cleaned up with zero residue');
      passed += 1;
    } catch (cleanErr) {
      console.error('Fixture cleanup error:', cleanErr);
      failed += 1;
    }

    if (server) {
      await new Promise((res) => server.close(res));
    }
    await pool.end();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
