/**
 * Regression test for room move inventory boundary fix (Reservation #1200).
 *
 * Tests:
 * A. 1-night cross-type move + checkout (effectiveFrom == checkOut → no-op move)
 * B. Multi-night mid-stay move with checkout
 *
 * SAFETY: Fails closed — never runs against staging/production databases.
 *         Requires TEST_DATABASE_URL env var pointing to a disposable test DB.
 */
const assert = require('assert');
const { Pool } = require('pg');
const { initializeDatabase } = require('../dist/db/schema_v3');
const { executeRoomMove } = require('../dist/domains/reservations/roomMoveService');
const { releaseReservationInventoryForCheckout } = require('../dist/domains/reservations/roomMoveService');

// ─── DB SAFETY GUARD — FAIL CLOSED ──────────────────────────────────────────
// Never run against staging/production. Require explicit TEST_DATABASE_URL.
const rawUrl = process.env.TEST_DATABASE_URL;
if (!rawUrl) {
  console.error('\n=== CHECKOUT MOVE BOUNDARY TEST: DATABASE NOT CONFIGURED ===');
  console.error('This test MUST run against a disposable test database only.');
  console.error('Set TEST_DATABASE_URL before running:');
  console.error('  PowerShell: $env:TEST_DATABASE_URL="postgresql://user:pass@localhost:5432/oak_checkout_move_boundary_test"');
  console.error('  CMD:        SET TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/oak_checkout_move_boundary_test');
  console.error('DO NOT point this at staging or production.\n');
  process.exit(2);
}
const suspiciousPatterns = ['staging', 'production', 'cloudsql', 'prod-db', 'live-db'];
const urlLower = rawUrl.toLowerCase();
if (suspiciousPatterns.some(p => urlLower.includes(p))) {
  console.error('SAFETY VIOLATION: TEST_DATABASE_URL appears to target a staging/production database.');
  console.error('Rejecting URL containing suspicious pattern.');
  process.exit(2);
}
console.log(`Using disposable test DB via TEST_DATABASE_URL`);

const pool = new Pool({ connectionString: rawUrl });
const tag = `CMB${String(Date.now()).slice(-8)}`;
const tracked = { propertyId: null, reservationIds: [], bookingIds: [] };

async function cleanup() {
  const client = await pool.connect();
  try {
    if (tracked.reservationIds.length) {
      await client.query('DELETE FROM reservation_room_moves WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [tracked.reservationIds]);
    }
    if (tracked.bookingIds.length) await client.query('DELETE FROM bookings WHERE id = ANY($1::int[])', [tracked.bookingIds]);
    if (tracked.propertyId) {
      await client.query('DELETE FROM housekeeping_tasks WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM audit_logs WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM availability_dates WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id = $1)', [tracked.propertyId]);
      await client.query('DELETE FROM room_operational_blocks WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM ota_sources WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM rate_plans WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM rooms WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM room_types WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM room_categories WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM property_housekeeping_settings WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM property_pricing_settings WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM properties WHERE id = $1', [tracked.propertyId]);
    }
  } finally { client.release(); }
}

async function setup() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const property = await client.query(`INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ($1,$2,'Asia/Jakarta','IDR','Test',TRUE) RETURNING id`, [tag, tag.slice(-6)]);
    tracked.propertyId = Number(property.rows[0].id);
    await client.query(`INSERT INTO property_pricing_settings (property_id,tax_percent,service_charge_percent,prices_include_tax,prices_include_service) VALUES ($1,0,0,FALSE,FALSE)`, [tracked.propertyId]);
    const category = await client.query(`INSERT INTO room_categories (property_id,code,name,is_active) VALUES ($1,'RMV','Room Move',TRUE) RETURNING id`, [tracked.propertyId]);
    // Type A = source (DELUXE KING), Type B = target (DELUXE TWIN)
    const types = await client.query(`INSERT INTO room_types (property_id,room_category_id,code,name,base_rate,capacity) VALUES ($1,$2,'A','Type A',100000,2),($1,$2,'B','Type B',150000,2) RETURNING id,code`, [tracked.propertyId, category.rows[0].id]);
    const typeA = Number(types.rows.find(row => row.code === 'A').id);
    const typeB = Number(types.rows.find(row => row.code === 'B').id);
    // 4 rooms for type A, 2 rooms for type B
    const rooms = await client.query(`INSERT INTO rooms (property_id,room_type_id,room_number,name,status,is_active) VALUES
      ($1,$2,'A1','A1','OCCUPIED_CLEAN',TRUE),($1,$2,'A2','A2','VACANT_CLEAN',TRUE),
      ($1,$2,'A3','A3','VACANT_CLEAN',TRUE),($1,$2,'A4','A4','VACANT_CLEAN',TRUE),
      ($1,$3,'B1','B1','VACANT_CLEAN',TRUE),($1,$3,'B2','B2','VACANT_CLEAN',TRUE)
      RETURNING id,room_number`, [tracked.propertyId, typeA, typeB]);
    const room = n => Number(rooms.rows.find(row => row.room_number === n).id);
    // 3 hotel dates: today, tomorrow, day after
    const hotelDates = await client.query(`SELECT
      to_char((NOW() AT TIME ZONE 'Asia/Jakarta')::date, 'YYYY-MM-DD') AS today,
      to_char(((NOW() AT TIME ZONE 'Asia/Jakarta')::date + 1), 'YYYY-MM-DD') AS tomorrow,
      to_char(((NOW() AT TIME ZONE 'Asia/Jakarta')::date + 2), 'YYYY-MM-DD') AS day_after`);
    const { today, tomorrow, day_after: dayAfter } = hotelDates.rows[0];
    // Setup availability for all 3 dates
    for (const [type, total] of [[typeA, 4], [typeB, 2]]) {
      for (const date of [today, tomorrow, dayAfter]) {
        await client.query(`INSERT INTO availability_dates (room_type_id,room_type,date,total_rooms,reserved_qty) VALUES ($1,$2,$3,$4,0)`, [type, type === typeA ? 'Type A' : 'Type B', date, total]);
      }
    }
    await client.query('COMMIT');
    return { typeA, typeB, roomA1: room('A1'), roomA2: room('A2'), roomA3: room('A3'), roomB1: room('B1'), roomB2: room('B2'), today, tomorrow, dayAfter };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

/**
 * Create a 1-night reservation (today → tomorrow) with CHECKED_IN status.
 * Increments reserved_qty for the single occupied night.
 */
async function createOneNightReservation(fixture, suffix, roomId, typeId) {
  const booking = await pool.query(`INSERT INTO bookings (property_id,bid,guest_name_snapshot,booking_status) VALUES ($1,$2,$3,'ACTIVE') RETURNING id`,
    [tracked.propertyId, `${tag}-${suffix}`, suffix]);
  tracked.bookingIds.push(Number(booking.rows[0].id));
  const reservation = await pool.query(
    `INSERT INTO reservations (booking_id,room_id,booked_room_type_id_snapshot,rate_plan_id,guest_name,
      check_in,check_out,subtotal_amount,total_price,remaining_balance,status,stay_status,stay_sequence)
     VALUES ($1,$2,$3,NULL,$4,$5::date,$6::date,100000,100000,100000,$7,$8,1) RETURNING id`,
    [booking.rows[0].id, roomId, typeId, suffix, fixture.today, fixture.tomorrow, 'CHECKED_IN', 'IN_HOUSE']
  );
  const id = Number(reservation.rows[0].id);
  tracked.reservationIds.push(id);
  // Increment inventory for the single occupied night
  await pool.query(`UPDATE availability_dates SET reserved_qty=reserved_qty+1 WHERE room_type_id=$1 AND date=$2::date`,
    [typeId, fixture.today]);
  // Add folio entry for financial gate
  await pool.query(`INSERT INTO folio_entries (reservation_id,property_id,entry_type,amount,direction) VALUES ($1,$2,'ROOM_CHARGE',100000,'DEBIT')`,
    [id, tracked.propertyId]);
  // Add nightly rate
  await pool.query(`INSERT INTO reservation_nightly_rates (reservation_id,property_id,stay_date,room_type_id,base_rate,final_room_rate,total_amount) VALUES ($1,$2,$3,$4,$5,$5,$5)`,
    [id, tracked.propertyId, fixture.today, typeId, 100000]);
  return id;
}

/**
 * Create a 3-night reservation (today → dayAfter+1) with CHECKED_IN status.
 * Increments reserved_qty for all 3 occupied nights.
 */
async function createThreeNightReservation(fixture, suffix, roomId, typeId) {
  const booking = await pool.query(`INSERT INTO bookings (property_id,bid,guest_name_snapshot,booking_status) VALUES ($1,$2,$3,'ACTIVE') RETURNING id`,
    [tracked.propertyId, `${tag}-${suffix}`, suffix]);
  tracked.bookingIds.push(Number(booking.rows[0].id));
  // Use dayAfter+1 as checkOut to ensure 3 full nights
  const checkOutDate = await pool.query(`SELECT to_char((NOW() AT TIME ZONE 'Asia/Jakarta')::date + 3, 'YYYY-MM-DD') AS check_out`);
  const checkout = checkOutDate.rows[0].check_out;
  const reservation = await pool.query(
    `INSERT INTO reservations (booking_id,room_id,booked_room_type_id_snapshot,rate_plan_id,guest_name,
      check_in,check_out,subtotal_amount,total_price,remaining_balance,status,stay_status,stay_sequence)
     VALUES ($1,$2,$3,NULL,$4,$5::date,$6::date,300000,300000,300000,$7,$8,1) RETURNING id`,
    [booking.rows[0].id, roomId, typeId, suffix, fixture.today, checkout, 'CHECKED_IN', 'IN_HOUSE']
  );
  const id = Number(reservation.rows[0].id);
  tracked.reservationIds.push(id);
  // Increment inventory for all 3 occupied nights
  for (const date of [fixture.today, fixture.tomorrow, fixture.dayAfter]) {
    await pool.query(`UPDATE availability_dates SET reserved_qty=reserved_qty+1 WHERE room_type_id=$1 AND date=$2::date`,
      [typeId, date]);
  }
  // Add folio entries
  await pool.query(`INSERT INTO folio_entries (reservation_id,property_id,entry_type,amount,direction) VALUES ($1,$2,'ROOM_CHARGE',300000,'DEBIT')`,
    [id, tracked.propertyId]);
  // Add nightly rates for all 3 nights
  for (const date of [fixture.today, fixture.tomorrow, fixture.dayAfter]) {
    await pool.query(`INSERT INTO reservation_nightly_rates (reservation_id,property_id,stay_date,room_type_id,base_rate,final_room_rate,total_amount) VALUES ($1,$2,$3,$4,$5,$5,$5)`,
      [id, tracked.propertyId, date, typeId, 100000]);
  }
  return id;
}

async function getInventory(pool, type, date) {
  const r = await pool.query('SELECT reserved_qty FROM availability_dates WHERE room_type_id=$1 AND date=$2', [type, date]);
  return Number(r.rows[0]?.reserved_qty ?? 0);
}

const actor = { id: 99, full_name: 'Test Actor', role: 'Front Office' };

async function run() {
  await initializeDatabase(pool);
  const f = await setup();
  console.log(`Fixture: today=${f.today}, tomorrow=${f.tomorrow}, dayAfter=${f.dayAfter}`);
  console.log(`Type A=${f.typeA}, Type B=${f.typeB}`);
  try {
    // ── Test A: 1-night cross-type move + checkout ─────────────────────────
    console.log('\n--- Test A: 1-night cross-type move + checkout ---');
    const resA = await createOneNightReservation(f, 'ONE', f.roomA1, f.typeA);
    console.log(`Created 1-night reservation ${resA} (type=${f.typeA}, ${f.today}→${f.tomorrow})`);

    // Verify initial inventory
    let qtyA = await getInventory(pool, f.typeA, f.today);
    let qtyB = await getInventory(pool, f.typeB, f.today);
    console.log(`Initial inventory: typeA=${qtyA}, typeB=${qtyB} (expect 1,0)`);
    assert.equal(qtyA, 1, 'Test A initial: typeA reserved_qty should be 1');
    assert.equal(qtyB, 0, 'Test A initial: typeB reserved_qty should be 0');

    // Execute cross-type room move (A→B)
    await executeRoomMove(pool, resA, {
      property_id: tracked.propertyId, to_room_id: f.roomB1,
      reason_category: 'GUEST_REQUEST', reason_detail: '1-night move test',
      pricing_treatment: 'KEEP_CURRENT_RATE'
    }, actor);
    console.log('Room move executed');

    // Verify move record
    const move = await pool.query(
      'SELECT to_room_type_id, effective_from_date FROM reservation_room_moves WHERE reservation_id=$1',
      [resA]
    );
    assert.equal(move.rowCount, 1, 'Test A: one move record created');
    assert.equal(Number(move.rows[0].to_room_type_id), f.typeB, 'Test A: move targets type B');
    // effectiveFrom should be tomorrow (= checkOut) since move was done on today
    console.log(`Move effective_from_date: ${move.rows[0].effective_from_date}`);

    // Verify inventory unchanged (reassignMoveInventory is no-op for 1-night)
    qtyA = await getInventory(pool, f.typeA, f.today);
    qtyB = await getInventory(pool, f.typeB, f.today);
    console.log(`After move inventory: typeA=${qtyA}, typeB=${qtyB} (expect 1,0 - no change)`);
    assert.equal(qtyA, 1, 'Test A: typeA reserved_qty still 1 after move');
    assert.equal(qtyB, 0, 'Test A: typeB reserved_qty still 0 after move');

    // Checkout via releaseReservationInventoryForCheckout
    // Note: this simulates what the checkout endpoint does internally
    const updated = await pool.query(
      `UPDATE reservations SET status='CHECKED_OUT', stay_status='DEPARTED', checked_out_at=NOW()
       WHERE id=$1 RETURNING *`, [resA]
    );
    const checkoutRes = updated.rows[0];
    await releaseReservationInventoryForCheckout(pool, {
      ...checkoutRes,
      current_room_type_id: f.typeB  // current physical room type after move
    });
    console.log('Checkout completed successfully');

    // Verify inventory released from source type (typeA), NOT target type
    qtyA = await getInventory(pool, f.typeA, f.today);
    qtyB = await getInventory(pool, f.typeB, f.today);
    console.log(`After checkout inventory: typeA=${qtyA}, typeB=${qtyB} (expect 0,0)`);
    assert.equal(qtyA, 0, 'Test A: typeA reserved_qty should be 0 after checkout');
    assert.equal(qtyB, 0, 'Test A: typeB reserved_qty should be 0 after checkout');
    console.log('PASS Test A');

    // ── Test B: 3-night mid-stay move + checkout ───────────────────────────
    console.log('\n--- Test B: 3-night mid-stay move + checkout ---');
    const resB = await createThreeNightReservation(f, 'THREE', f.roomA1, f.typeA);
    console.log(`Created 3-night reservation ${resB} (type=${f.typeA}, ${f.today}→${f.dayAfter})`);

    // Verify initial inventory
    let qtyA0 = await getInventory(pool, f.typeA, f.today);
    let qtyA1 = await getInventory(pool, f.typeA, f.tomorrow);
    let qtyA2 = await getInventory(pool, f.typeA, f.dayAfter);
    let qtyB0 = await getInventory(pool, f.typeB, f.today);
    let qtyB1 = await getInventory(pool, f.typeB, f.tomorrow);
    let qtyB2 = await getInventory(pool, f.typeB, f.dayAfter);
    console.log(`Initial: A[${f.today}]=${qtyA0}, A[${f.tomorrow}]=${qtyA1}, A[${f.dayAfter}]=${qtyA2}, B[0]=${qtyB0}, B[1]=${qtyB1}, B[2]=${qtyB2}`);
    assert.equal(qtyA0, 1, 'Test B initial: typeA night0 = 1');
    assert.equal(qtyA1, 1, 'Test B initial: typeA night1 = 1');
    assert.equal(qtyA2, 1, 'Test B initial: typeA night2 = 1');
    assert.equal(qtyB0, 0, 'Test B initial: typeB night0 = 0');
    assert.equal(qtyB1, 0, 'Test B initial: typeB night1 = 0');
    assert.equal(qtyB2, 0, 'Test B initial: typeB night2 = 0');

    // Execute cross-type room move (A→B) — use roomB2 to avoid conflict with Test A's roomB1
    await executeRoomMove(pool, resB, {
      property_id: tracked.propertyId, to_room_id: f.roomB2,
      reason_category: 'UPGRADE', reason_detail: '3-night move test',
      pricing_treatment: 'KEEP_CURRENT_RATE'
    }, actor);
    console.log('Room move executed');

    // Verify inventory changed: typeA night0 stays 1, typeA nights 1-2 decrease, typeB nights 1-2 increase
    qtyA0 = await getInventory(pool, f.typeA, f.today);
    qtyA1 = await getInventory(pool, f.typeA, f.tomorrow);
    qtyA2 = await getInventory(pool, f.typeA, f.dayAfter);
    qtyB0 = await getInventory(pool, f.typeB, f.today);
    qtyB1 = await getInventory(pool, f.typeB, f.tomorrow);
    qtyB2 = await getInventory(pool, f.typeB, f.dayAfter);
    console.log(`After move: A[${f.today}]=${qtyA0}, A[${f.tomorrow}]=${qtyA1}, A[${f.dayAfter}]=${qtyA2}`);
    console.log(`After move: B[${f.today}]=${qtyB0}, B[${f.tomorrow}]=${qtyB1}, B[${f.dayAfter}]=${qtyB2}`);
    assert.equal(qtyA0, 1, 'Test B: typeA night0 still 1 (before effectiveFrom)');
    assert.equal(qtyA1, 0, 'Test B: typeA night1 released (moved to B)');
    assert.equal(qtyA2, 0, 'Test B: typeA night2 released (moved to B)');
    assert.equal(qtyB0, 0, 'Test B: typeB night0 still 0 (not yet effective)');
    assert.equal(qtyB1, 1, 'Test B: typeB night1 now occupied');
    assert.equal(qtyB2, 1, 'Test B: typeB night2 now occupied');

    // Checkout
    const updatedB = await pool.query(
      `UPDATE reservations SET status='CHECKED_OUT', stay_status='DEPARTED', checked_out_at=NOW()
       WHERE id=$1 RETURNING *`, [resB]
    );
    const checkoutResB = updatedB.rows[0];
    await releaseReservationInventoryForCheckout(pool, {
      ...checkoutResB,
      current_room_type_id: f.typeB
    });
    console.log('Checkout completed successfully');

    // Verify all inventory released
    qtyA0 = await getInventory(pool, f.typeA, f.today);
    qtyA1 = await getInventory(pool, f.typeA, f.tomorrow);
    qtyA2 = await getInventory(pool, f.typeA, f.dayAfter);
    qtyB0 = await getInventory(pool, f.typeB, f.today);
    qtyB1 = await getInventory(pool, f.typeB, f.tomorrow);
    qtyB2 = await getInventory(pool, f.typeB, f.dayAfter);
    console.log(`After checkout: A=[${qtyA0},${qtyA1},${qtyA2}], B=[${qtyB0},${qtyB1},${qtyB2}]`);
    assert.equal(qtyA0, 0, 'Test B: typeA night0 released');
    assert.equal(qtyA1, 0, 'Test B: typeA night1 released');
    assert.equal(qtyA2, 0, 'Test B: typeA night2 released');
    assert.equal(qtyB0, 0, 'Test B: typeB night0 = 0');
    assert.equal(qtyB1, 0, 'Test B: typeB night1 released');
    assert.equal(qtyB2, 0, 'Test B: typeB night2 released');
    console.log('PASS Test B');

    console.log('\n=== ALL TESTS PASSED ===');
  } finally { await cleanup(); }
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => pool.end());
