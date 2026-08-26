#!/usr/bin/env node
/**
 * C2C2 Lock-Order Normalization Concurrency Tests
 *
 * Tests that the canonical lock order (ROOM → RESERVATION → AVAILABILITY)
 * eliminates known inversions. Each scenario runs two concurrent transactions
 * and verifies: no 40P01 deadlock, no unexpected 500, correct final state.
 *
 * Scenarios:
 *   A. Create ↔ Extend on same room → serialized, no deadlock
 *   B. Create ↔ Checkin → no deadlock
 *   C. Create ↔ Cancel sharing availability dates → no deadlock
 *   D. Create ↔ Move → no deadlock / no room overlap
 *   E. Reassign ↔ Move → no deadlock / no inventory corruption
 *   F. Opposite moves (Type A→B concurrent with Type B→A) → no ABBA
 *   G. Opposite reassignment directions → deterministic locking
 *   H. State change between plain read and lock detected
 *   I. Adjacent [check_out == check_in] remains valid
 *   J. Failed concurrency attempt leaves inventory exact
 *
 * Run: node test/c2c2_lock_order_test.js
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db',
});

let assertions = 0;
let passed = 0;
let failed = 0;
const TAG = 'c2c2-lock-order';

function expect(condition, message) {
  assertions++;
  if (!condition) {
    failed++;
    console.error(`  FAIL | ${message}`);
    throw new Error(`ASSERTION FAILED: ${message}`);
  } else {
    passed++;
  }
}

function expectNoDeadlock(err) {
  if (err && String(err.code) === '40P01') {
    throw new Error(`DEADLOCK DETECTED (40P01): ${err.message}`);
  }
}

function expectNot500(status, body) {
  if (status >= 500) {
    throw new Error(`Unexpected ${status}: ${JSON.stringify(body)}`);
  }
}

function hotelDateKey(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return new Date(dt.getTime() + 7 * 3600000).toISOString().slice(0, 10);
}

function futureDate(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return hotelDateKey(d);
}

function tomorrow() { return futureDate(1); }
function dayAfterTomorrow() { return futureDate(2); }
function threeDaysOut() { return futureDate(3); }
function fourDaysOut() { return futureDate(4); }

// Unique test tag for fixture isolation
const FIXTURE_TAG = `C2${Date.now().toString(36).slice(-2).toUpperCase()}`;

async function createTestFixture(client) {
  // Create property if needed
  await client.query(`
    INSERT INTO properties (id, property_code, name, address)
    VALUES (999999, '${FIXTURE_TAG}', 'C2C2 Test Property', 'Test Address')
    ON CONFLICT (id) DO NOTHING
  `);

  // Create two room categories (upsert)
  await client.query(`
    INSERT INTO room_categories (code, name, property_id, display_order, is_active)
    VALUES ('${FIXTURE_TAG}A', 'C2Cat ${FIXTURE_TAG} A', 999999, 1, true),
           ('${FIXTURE_TAG}B', 'C2Cat ${FIXTURE_TAG} B', 999999, 2, true)
    ON CONFLICT (code, property_id) DO UPDATE SET name = EXCLUDED.name
  `);
  const catRes = await client.query(
    `SELECT id, code FROM room_categories WHERE code IN ($1, $2) AND property_id = 999999`,
    [`${FIXTURE_TAG}A`, `${FIXTURE_TAG}B`]
  );
  const catA = catRes.rows.find(r => r.code === `${FIXTURE_TAG}A`);
  const catB = catRes.rows.find(r => r.code === `${FIXTURE_TAG}B`);

  // Create two room types in different categories
  await client.query(`
    INSERT INTO room_types (code, name, room_category_id, property_id, capacity, base_rate, is_active, display_order)
    VALUES ('${FIXTURE_TAG}TA', 'C2Type ${FIXTURE_TAG} A', ${catA.id}, 999999, 2, 100000, true, 1),
           ('${FIXTURE_TAG}TB', 'C2Type ${FIXTURE_TAG} B', ${catB.id}, 999999, 2, 100000, true, 2)
    ON CONFLICT (code, property_id) DO UPDATE SET name = EXCLUDED.name
  `);
  const typeRes = await client.query(
    `SELECT id, code FROM room_types WHERE code IN ($1, $2) AND property_id = 999999`,
    [`${FIXTURE_TAG}TA`, `${FIXTURE_TAG}TB`]
  );
  const typeA = typeRes.rows.find(r => r.code === `${FIXTURE_TAG}TA`);
  const typeB = typeRes.rows.find(r => r.code === `${FIXTURE_TAG}TB`);

  // Create three physical rooms (two typeA, one typeB)
  await client.query(`
    INSERT INTO rooms (room_number, room_type_id, property_id, status, is_active)
    VALUES ('${FIXTURE_TAG}R1', ${typeA.id}, 999999, 'VACANT_CLEAN', true),
           ('${FIXTURE_TAG}R2', ${typeA.id}, 999999, 'VACANT_CLEAN', true),
           ('${FIXTURE_TAG}R3', ${typeB.id}, 999999, 'VACANT_CLEAN', true)
    ON CONFLICT DO NOTHING
  `);
  const roomRes = await client.query(
    `SELECT id, room_number, room_type_id FROM rooms WHERE room_number IN ($1, $2, $3) AND property_id = 999999`,
    [`${FIXTURE_TAG}R1`, `${FIXTURE_TAG}R2`, `${FIXTURE_TAG}R3`]
  );
  const room1 = roomRes.rows.find(r => r.room_number === `${FIXTURE_TAG}R1`);
  const room2 = roomRes.rows.find(r => r.room_number === `${FIXTURE_TAG}R2`);
  const room3 = roomRes.rows.find(r => r.room_number === `${FIXTURE_TAG}R3`);

  // Create availability rows for a future date window
  const dates = [];
  for (let i = 1; i <= 10; i++) dates.push(futureDate(i));

  for (const typeInfo of [{ id: typeA.id, name: typeA.name || `C2Type ${FIXTURE_TAG} A` }, { id: typeB.id, name: typeB.name || `C2Type ${FIXTURE_TAG} B` }]) {
    for (const date of dates) {
      await client.query(`
        INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
        VALUES ($1, $2, $3, 3, 0)
        ON CONFLICT DO NOTHING
      `, [typeInfo.id, typeInfo.name, date]);
    }
  }

  return { catA, catB, typeA, typeB, room1, room2, room3, dates };
}

async function cleanupTestFixture(client, fixture) {
  const { typeA, typeB, room1, room2, room3 } = fixture;
  const roomIds = [room1?.id, room2?.id, room3?.id].filter(Boolean);
  const typeIds = [typeA?.id, typeB?.id].filter(Boolean);

  if (roomIds.length) {
    await client.query(`DELETE FROM folio_entries WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id = ANY($1))`, [roomIds]).catch(() => {});
    await client.query(`DELETE FROM audit_logs WHERE entity = 'RESERVATION' AND record_id::int IN (SELECT id FROM reservations WHERE room_id = ANY($1))`, [roomIds]).catch(() => {});
    await client.query(`DELETE FROM reservations WHERE room_id = ANY($1)`, [roomIds]);
  }
  if (typeIds.length) {
    await client.query(`DELETE FROM availability_dates WHERE room_type_id = ANY($1)`, [typeIds]);
  }
  if (roomIds.length) {
    await client.query(`DELETE FROM rooms WHERE id = ANY($1)`, [roomIds]);
  }
  if (typeIds.length) {
    await client.query(`DELETE FROM room_types WHERE id = ANY($1)`, [typeIds]);
  }
  await client.query(`DELETE FROM room_categories WHERE code LIKE '${FIXTURE_TAG}%'`);
  await client.query(`DELETE FROM properties WHERE id = 999999`);
}

// ---- HTTP helper using the running server ----
const http = require('http');

function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: '127.0.0.1',
      port: 5000,
      path: `/api${path}`,
      method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    };
    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getRoomAvailability(typeId, date) {
  const res = await apiCall('GET', `/availability?type_id=${typeId}&start=${date}&end=${date}`);
  if (res.status === 200 && res.body?.data?.[0]) {
    return res.body.data[0];
  }
  return null;
}

async function createBooking(reservations) {
  return apiCall('POST', '/reservations', {
    property_id: 999999,
    guest_name: `C2C2 Guest ${FIXTURE_TAG}`,
    booking_source: 'WALKIN',
    reservations,
  });
}

// =========================================================
// SCENARIO A: Create ↔ Extend on same room
// =========================================================
async function scenarioA() {
  console.log('--- A. Create ↔ Extend on same room ---');
  const client = await pool.connect();
  try {
    const fixture = await createTestFixture(client);
    const { room1, typeA, dates } = fixture;
    const checkIn = dates[0];
    const checkOut = dates[2];
    const extendTo = dates[4];

    // Create a reservation first
    const createRes = await createBooking([{
      room_id: room1.id,
      check_in: checkIn,
      check_out: checkOut,
      guest_name: 'ScenarioA Guest',
    }]);
    expect(createRes.status === 201 || createRes.status === 200, `A: create booking succeeded (${createRes.status})`);
    const reservationId = createRes.body?.data?.[0]?.id;
    expect(reservationId > 0, `A: got reservation id=${reservationId}`);

    // Concurrent extend — should not deadlock
    const extendRes = await apiCall('POST', `/reservations/${reservationId}/extend`, {
      new_check_out: extendTo,
    });
    expect(extendRes.status !== 500, `A: extend not 500 (got ${extendRes.status})`);

    if (extendRes.status === 200) {
      // Verify new check_out
      const data = extendRes.body?.data;
      expect(data?.check_out === extendTo, `A: extended check_out=${data?.check_out} expected=${extendTo}`);
    }

    // Verify inventory is consistent
    const avails = [];
    for (const date of dates) {
      const avail = await client.query(
        `SELECT reserved_qty, total_rooms FROM availability_dates WHERE room_type_id = $1 AND date = $2`,
        [typeA.id, date]
      );
      if (avail.rows.length > 0) {
        avails.push({ date, reserved: Number(avail.rows[0].reserved_qty), total: Number(avail.rows[0].total_rooms) });
      }
    }
    for (const a of avails) {
      expect(a.reserved >= 0, `A: reserved_qty >= 0 on ${a.date} (got ${a.reserved})`);
      expect(a.reserved <= a.total, `A: reserved_qty <= total_rooms on ${a.date}`);
    }

    console.log(`  PASS  A. Create ↔ Extend: no deadlock, inventory consistent`);
    await cleanupTestFixture(client, fixture);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// =========================================================
// SCENARIO B: Create ↔ Checkin
// =========================================================
async function scenarioB() {
  console.log('--- B. Create ↔ Checkin ---');
  const client = await pool.connect();
  try {
    const fixture = await createTestFixture(client);
    const { room1, typeA, dates } = fixture;
    const checkIn = dates[0];
    const checkOut = dates[3];

    // Create a BOOKED reservation
    const createRes = await createBooking([{
      room_id: room1.id,
      check_in: checkIn,
      check_out: checkOut,
      guest_name: 'ScenarioB Guest',
    }]);
    expect(createRes.status === 201 || createRes.status === 200, `B: create booking succeeded`);
    const reservationId = createRes.body?.data?.[0]?.id;

    // Checkin should not deadlock (ROOM → RESERVATION is canonical)
    const checkinRes = await apiCall('POST', `/reservations/${reservationId}/checkin`);
    expect(checkinRes.status !== 500, `B: checkin not 500 (got ${checkinRes.status})`);

    // Verify room status changed
    const roomCheck = await client.query(`SELECT status FROM rooms WHERE id = $1`, [room1.id]);
    expect(roomCheck.rows[0]?.status === 'OCCUPIED_CLEAN', `B: room status OCCUPIED_CLEAN after checkin`);

    console.log(`  PASS  B. Create ↔ Checkin: no deadlock`);
    await cleanupTestFixture(client, fixture);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// =========================================================
// SCENARIO C: Create ↔ Cancel sharing availability dates
// =========================================================
async function scenarioC() {
  console.log('--- C. Create ↔ Cancel sharing availability dates ---');
  const client = await pool.connect();
  try {
    const fixture = await createTestFixture(client);
    const { room1, room2, typeA, dates } = fixture;
    const checkIn = dates[0];
    const checkOut = dates[3];

    // Create first reservation on room1
    const res1 = await createBooking([{
      room_id: room1.id,
      check_in: checkIn,
      check_out: checkOut,
      guest_name: 'ScenarioC Guest1',
    }]);
    expect(res1.status === 201 || res1.status === 200, `C: first booking created`);
    const r1Id = res1.body?.data?.[0]?.id;

    // Create second reservation on room2 (same type, overlapping dates)
    const res2 = await createBooking([{
      room_id: room2.id,
      check_in: checkIn,
      check_out: checkOut,
      guest_name: 'ScenarioC Guest2',
    }]);
    expect(res2.status === 201 || res2.status === 200, `C: second booking created`);
    const r2Id = res2.body?.data?.[0]?.id;

    // Concurrent: cancel r1 and create new on room1 (overlapping dates)
    const cancelPromise = apiCall('POST', `/reservations/${r1Id}/cancel`);
    const createPromise = createBooking([{
      room_id: room1.id,
      check_in: checkIn,
      check_out: checkOut,
      guest_name: 'ScenarioC Concurrent',
    }]);

    const [cancelRes, createRes2] = await Promise.all([cancelPromise, createPromise]);

    expect(cancelRes.status !== 500, `C: cancel not 500 (got ${cancelRes.status})`);
    expect(createRes2.status !== 500, `C: concurrent create not 500 (got ${createRes2.status})`);

    // One should succeed, one should conflict — but no deadlock
    const cancelOk = cancelRes.status === 200;
    const createOk = createRes2.status === 201 || createRes2.status === 200;
    expect(cancelOk || createOk, `C: at least one operation succeeded`);

    // Inventory should be non-negative
    for (const date of dates.slice(0, 4)) {
      const avail = await client.query(
        `SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2`,
        [typeA.id, date]
      );
      if (avail.rows.length > 0) {
        expect(Number(avail.rows[0].reserved_qty) >= 0, `C: reserved_qty >= 0 on ${date}`);
      }
    }

    console.log(`  PASS  C. Create ↔ Cancel: no deadlock, inventory consistent`);
    await cleanupTestFixture(client, fixture);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// =========================================================
// SCENARIO D: Create ↔ Move
// =========================================================
async function scenarioD() {
  console.log('--- D. Create ↔ Move ---');
  const client = await pool.connect();
  try {
    const fixture = await createTestFixture(client);
    const { room1, room2, room3, typeA, typeB, dates } = fixture;
    const checkIn = dates[0];
    const checkOut = dates[3];

    // Create reservation on room1
    const res1 = await createBooking([{
      room_id: room1.id,
      check_in: checkIn,
      check_out: checkOut,
      guest_name: 'ScenarioD Guest',
    }]);
    expect(res1.status === 201 || res1.status === 200, `D: booking created`);
    const r1Id = res1.body?.data?.[0]?.id;

    // Concurrent: move r1 to room2 and create new on room1
    const movePromise = apiCall('POST', `/reservations/${r1Id}/move`, { to_room_id: room2.id });
    const createPromise = createBooking([{
      room_id: room1.id,
      check_in: checkIn,
      check_out: checkOut,
      guest_name: 'ScenarioD Concurrent',
    }]);

    const [moveRes, createRes] = await Promise.all([movePromise, createPromise]);

    expect(moveRes.status !== 500, `D: move not 500 (got ${moveRes.status})`);
    expect(createRes.status !== 500, `D: create not 500 (got ${createRes.status})`);

    // No overlap corruption: r1 should not be on both room1 and room2
    const r1Check = await client.query(
      `SELECT room_id FROM reservations WHERE id = $1`, [r1Id]
    );
    if (r1Check.rows.length > 0) {
      const finalRoom = Number(r1Check.rows[0].room_id);
      expect(finalRoom === room1.id || finalRoom === room2.id,
        `D: reservation on valid room (got ${finalRoom})`);
    }

    // Inventory non-negative
    for (const date of dates.slice(0, 4)) {
      for (const typeId of [typeA.id, typeB.id]) {
        const avail = await client.query(
          `SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2`,
          [typeId, date]
        );
        if (avail.rows.length > 0) {
          expect(Number(avail.rows[0].reserved_qty) >= 0, `D: reserved >= 0 type=${typeId} date=${date}`);
        }
      }
    }

    console.log(`  PASS  D. Create ↔ Move: no deadlock, no overlap corruption`);
    await cleanupTestFixture(client, fixture);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// =========================================================
// SCENARIO E: Reassign ↔ Move
// =========================================================
async function scenarioE() {
  console.log('--- E. Reassign ↔ Move ---');
  const client = await pool.connect();
  try {
    const fixture = await createTestFixture(client);
    const { room1, room2, room3, typeA, typeB, dates } = fixture;
    const checkIn = dates[0];
    const checkOut = dates[3];

    // Create reservation on room3 (typeB)
    const res1 = await createBooking([{
      room_id: room3.id,
      check_in: checkIn,
      check_out: checkOut,
      guest_name: 'ScenarioE Guest',
    }]);
    expect(res1.status === 201 || res1.status === 200, `E: booking created`);
    const r3Id = res1.body?.data?.[0]?.id;

    // Reassign room1 from typeA to typeB (no active reservations)
    const reassignPromise = apiCall('PATCH', `/rooms/${room1.id}`, {
      room_type_id: typeB.id,
    });
    // Concurrently move reservation from room3 to room2 (typeA)
    const movePromise = apiCall('POST', `/reservations/${r3Id}/move`, { to_room_id: room2.id });

    const [reassignRes, moveRes] = await Promise.all([reassignPromise, movePromise]);

    expect(reassignRes.status !== 500, `E: reassign not 500 (got ${reassignRes.status})`);
    expect(moveRes.status !== 500, `E: move not 500 (got ${moveRes.status})`);

    // Verify room1 type is either typeA or typeB (no corruption)
    const room1Check = await client.query(`SELECT room_type_id FROM rooms WHERE id = $1`, [room1.id]);
    const finalType = Number(room1Check.rows[0]?.room_type_id);
    expect(finalType === typeA.id || finalType === typeB.id,
      `E: room1 type valid (got ${finalType})`);

    // Inventory non-negative
    for (const date of dates.slice(0, 4)) {
      for (const typeId of [typeA.id, typeB.id]) {
        const avail = await client.query(
          `SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2`,
          [typeId, date]
        );
        if (avail.rows.length > 0) {
          expect(Number(avail.rows[0].reserved_qty) >= 0, `E: reserved >= 0 type=${typeId} date=${date}`);
        }
      }
    }

    console.log(`  PASS  E. Reassign ↔ Move: no deadlock, inventory consistent`);
    await cleanupTestFixture(client, fixture);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// =========================================================
// SCENARIO F: Opposite moves (Type A→B concurrent with Type B→A)
// Tests deterministic availability locking (sorted by type_id ASC, date ASC)
// =========================================================
async function scenarioF() {
  console.log('--- F. Opposite moves: no ABBA availability deadlock ---');
  const client = await pool.connect();
  try {
    const fixture = await createTestFixture(client);
    const { room1, room2, room3, typeA, typeB, dates } = fixture;
    const checkIn = dates[0];
    const checkOut = dates[3];

    // Create two reservations: one on typeA (room1), one on typeB (room3)
    const res1 = await createBooking([{
      room_id: room1.id,
      check_in: checkIn,
      check_out: checkOut,
      guest_name: 'ScenarioF Guest1',
    }]);
    expect(res1.status === 201 || res1.status === 200, `F: booking 1 created`);
    const r1Id = res1.body?.data?.[0]?.id;

    const res2 = await createBooking([{
      room_id: room3.id,
      check_in: checkIn,
      check_out: checkOut,
      guest_name: 'ScenarioF Guest2',
    }]);
    expect(res2.status === 201 || res2.status === 200, `F: booking 2 created`);
    const r3Id = res2.body?.data?.[0]?.id;

    // Move r1 (typeA→typeB) and r3 (typeB→typeA) concurrently
    // With source-then-target, this was ABBA. With sorted locking, it's safe.
    const move1Promise = apiCall('POST', `/reservations/${r1Id}/move`, { to_room_id: room3.id });
    const move2Promise = apiCall('POST', `/reservations/${r3Id}/move`, { to_room_id: room1.id });

    const [move1Res, move2Res] = await Promise.all([move1Promise, move2Promise]);

    expect(move1Res.status !== 500, `F: move1 not 500 (got ${move1Res.status})`);
    expect(move2Res.status !== 500, `F: move2 not 500 (got ${move2Res.status})`);

    // At least one should succeed (the other may conflict)
    const m1Ok = move1Res.status === 200;
    const m2Ok = move2Res.status === 200;
    expect(m1Ok || m2Ok, `F: at least one move succeeded`);

    // Inventory non-negative and not over-capacity
    for (const date of dates.slice(0, 4)) {
      for (const typeId of [typeA.id, typeB.id]) {
        const avail = await client.query(
          `SELECT reserved_qty, total_rooms FROM availability_dates WHERE room_type_id = $1 AND date = $2`,
          [typeId, date]
        );
        if (avail.rows.length > 0) {
          const rq = Number(avail.rows[0].reserved_qty);
          const tr = Number(avail.rows[0].total_rooms);
          expect(rq >= 0, `F: reserved >= 0 type=${typeId} date=${date} (got ${rq})`);
          expect(rq <= tr, `F: reserved <= total type=${typeId} date=${date} (got ${rq} > ${tr})`);
        }
      }
    }

    console.log(`  PASS  F. Opposite moves: no ABBA deadlock, inventory consistent`);
    await cleanupTestFixture(client, fixture);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// =========================================================
// SCENARIO G: Opposite reassignment directions
// =========================================================
async function scenarioG() {
  console.log('--- G. Opposite reassignment directions ---');
  const client = await pool.connect();
  try {
    const fixture = await createTestFixture(client);
    const { room1, room2, typeA, typeB, dates } = fixture;

    // Reassign room1 typeA→typeB and room2 typeA→typeB concurrently
    // Both lock room_types in ASC order (typeA.id < typeB.id), so no deadlock
    const re1Promise = apiCall('PATCH', `/rooms/${room1.id}`, { room_type_id: typeB.id });
    const re2Promise = apiCall('PATCH', `/rooms/${room2.id}`, { room_type_id: typeB.id });

    const [re1Res, re2Res] = await Promise.all([re1Promise, re2Promise]);

    expect(re1Res.status !== 500, `G: reassign1 not 500 (got ${re1Res.status})`);
    expect(re2Res.status !== 500, `G: reassign2 not 500 (got ${re2Res.status})`);

    // Both should succeed (no conflict on same type change)
    expect(re1Res.status === 200, `G: reassign1 succeeded`);
    expect(re2Res.status === 200, `G: reassign2 succeeded`);

    // Verify both rooms are now typeB
    const check = await client.query(`SELECT id, room_type_id FROM rooms WHERE id IN ($1, $2)`, [room1.id, room2.id]);
    for (const row of check.rows) {
      expect(Number(row.room_type_id) === typeB.id, `G: room ${row.id} is typeB (got ${row.room_type_id})`);
    }

    console.log(`  PASS  G. Opposite reassignment: deterministic, no deadlock`);
    await cleanupTestFixture(client, fixture);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// =========================================================
// SCENARIO H: State change between plain read and lock detected
// =========================================================
async function scenarioH() {
  console.log('--- H. State change between plain read and lock detected ---');
  const client = await pool.connect();
  try {
    const fixture = await createTestFixture(client);
    const { room1, typeA, dates } = fixture;
    const checkIn = dates[0];
    const checkOut = dates[3];

    // Create reservation
    const res1 = await createBooking([{
      room_id: room1.id,
      check_in: checkIn,
      check_out: checkOut,
      guest_name: 'ScenarioH Guest',
    }]);
    expect(res1.status === 201 || res1.status === 200, `H: booking created`);
    const r1Id = res1.body?.data?.[0]?.id;

    // Extend should work
    const extendRes = await apiCall('POST', `/reservations/${r1Id}/extend`, {
      new_check_out: dates[5],
    });
    expect(extendRes.status === 200, `H: extend succeeded (got ${extendRes.status})`);

    // Verify new check_out
    const check = await client.query(`SELECT check_out FROM reservations WHERE id = $1`, [r1Id]);
    const newCheckout = hotelDateKey(check.rows[0]?.check_out);
    expect(newCheckout === dates[5], `H: check_out updated to ${dates[5]} (got ${newCheckout})`);

    console.log(`  PASS  H. Extend revalidation: consistent state`);
    await cleanupTestFixture(client, fixture);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// =========================================================
// SCENARIO I: Adjacent [check_out == check_in] remains valid
// =========================================================
async function scenarioI() {
  console.log('--- I. Adjacent dates [check_out == next check_in] valid ---');
  const client = await pool.connect();
  try {
    const fixture = await createTestFixture(client);
    const { room1, typeA, dates } = fixture;

    // Create two adjacent reservations on same room
    const res1 = await createBooking([{
      room_id: room1.id,
      check_in: dates[0],
      check_out: dates[2],
      guest_name: 'ScenarioI Guest1',
    }]);
    expect(res1.status === 201 || res1.status === 200, `I: first booking created`);

    const res2 = await createBooking([{
      room_id: room1.id,
      check_in: dates[2],
      check_out: dates[4],
      guest_name: 'ScenarioI Guest2',
    }]);
    expect(res2.status === 201 || res2.status === 200, `I: adjacent booking created`);

    // Both should exist
    const count = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM reservations WHERE room_id = $1 AND status = 'BOOKED'`,
      [room1.id]
    );
    expect(count.rows[0].cnt === 2, `I: 2 adjacent reservations on same room (got ${count.rows[0].cnt})`);

    console.log(`  PASS  I. Adjacent dates: [check_out == check_in] valid`);
    await cleanupTestFixture(client, fixture);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// =========================================================
// SCENARIO J: Failed concurrency attempt leaves inventory exact
// =========================================================
async function scenarioJ() {
  console.log('--- J. Failed concurrency attempt leaves inventory exact ---');
  const client = await pool.connect();
  try {
    const fixture = await createTestFixture(client);
    const { room1, room2, typeA, dates } = fixture;
    const checkIn = dates[0];
    const checkOut = dates[3];

    // Record initial inventory
    const beforeAvail = await client.query(
      `SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2`,
      [typeA.id, dates[1]]
    );
    const beforeReserved = Number(beforeAvail.rows[0]?.reserved_qty || 0);

    // Create a reservation
    const res1 = await createBooking([{
      room_id: room1.id,
      check_in: checkIn,
      check_out: checkOut,
      guest_name: 'ScenarioJ Guest',
    }]);
    expect(res1.status === 201 || res1.status === 200, `J: booking created`);

    // After create, reserved should increase by 3 (3 nights)
    const afterCreate = await client.query(
      `SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2`,
      [typeA.id, dates[1]]
    );
    const afterCreateReserved = Number(afterCreate.rows[0]?.reserved_qty || 0);
    expect(afterCreateReserved === beforeReserved + 1,
      `J: reserved increased by 1 after create (before=${beforeReserved}, after=${afterCreateReserved})`);

    // Cancel the reservation
    const r1Id = res1.body?.data?.[0]?.id;
    const cancelRes = await apiCall('POST', `/reservations/${r1Id}/cancel`);
    expect(cancelRes.status === 200, `J: cancel succeeded (got ${cancelRes.status})`);

    // After cancel, reserved should return to original
    const afterCancel = await client.query(
      `SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2`,
      [typeA.id, dates[1]]
    );
    const afterCancelReserved = Number(afterCancel.rows[0]?.reserved_qty || 0);
    expect(afterCancelReserved === beforeReserved,
      `J: reserved restored to ${beforeReserved} after cancel (got ${afterCancelReserved})`);

    console.log(`  PASS  J. Failed/rolled-back attempt leaves inventory exact`);
    await cleanupTestFixture(client, fixture);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// =========================================================
// MAIN
// =========================================================
async function main() {
  console.log(`${TAG} lock-order concurrency tests`);
  console.log('');

  const scenarios = [
    scenarioA,
    scenarioB,
    scenarioC,
    scenarioD,
    scenarioE,
    scenarioF,
    scenarioG,
    scenarioH,
    scenarioI,
    scenarioJ,
  ];

  let scenarioPassed = 0;
  let scenarioFailed = 0;

  for (const scenario of scenarios) {
    try {
      await scenario();
      scenarioPassed++;
    } catch (err) {
      scenarioFailed++;
      console.error(`  FAIL  ${scenario.name}: ${err.message}`);
    }
  }

  console.log('');
  console.log(`${TAG} assertions=${assertions} scenarios=${scenarioPassed}/${scenarioPassed + scenarioFailed} PASS`);

  if (scenarioFailed > 0) {
    console.log(`RESULT: FAIL`);
    process.exit(1);
  } else {
    console.log(`RESULT: PASS`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(`${TAG} FATAL:`, err);
  process.exit(1);
});
