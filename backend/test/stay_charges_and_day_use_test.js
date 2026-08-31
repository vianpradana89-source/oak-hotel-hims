const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const http = require('http');
const { Pool } = require('pg');
const assert = require('assert');

// Database connection
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

async function runTest() {
  console.log('--- STARTING STAY CHARGES & DAY USE FOUNDATION TEST (STAY-CHARGE-1) ---');
  const client = await pool.connect();

  const cleanupIds = {
    propertyId: 1,
    roomTypeId: null,
    roomId: null,
    ratePlanIds: [],
    ruleIds: [],
    bookingIds: [],
    reservationIds: []
  };

  try {
    // 0. Ensure schema is migrated
    const { initializeDatabase } = require('../dist/db/schema_v3');
    await initializeDatabase(pool);

    console.log('1. Setting up test fixtures...');
    // Pre-cleanup in case previous run aborted
    await client.query(`
      DELETE FROM payment_evidences WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id IN (SELECT id FROM rooms WHERE room_number = '888-STAY'));
      DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id IN (SELECT id FROM rooms WHERE room_number = '888-STAY'));
      DELETE FROM reservation_guests WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id IN (SELECT id FROM rooms WHERE room_number = '888-STAY'));
      DELETE FROM reservation_nightly_rates WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id IN (SELECT id FROM rooms WHERE room_number = '888-STAY'));
      DELETE FROM folio_entries WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id IN (SELECT id FROM rooms WHERE room_number = '888-STAY'));
      DELETE FROM housekeeping_tasks WHERE room_id IN (SELECT id FROM rooms WHERE room_number = '888-STAY');
      DELETE FROM reservations WHERE room_id IN (SELECT id FROM rooms WHERE room_number = '888-STAY');
      DELETE FROM bookings WHERE guest_name_snapshot LIKE 'Transit Guest%';
      DELETE FROM stay_charge_rules WHERE code LIKE 'TST_%';
      DELETE FROM rate_overrides WHERE rate_plan_id IN (SELECT id FROM rate_plans WHERE room_type_id IN (SELECT id FROM room_types WHERE code = 'TST-STAY-DELUXE'));
      DELETE FROM rate_plans WHERE code LIKE 'TST-%';
      DELETE FROM rooms WHERE room_number = '888-STAY';
      DELETE FROM availability_dates WHERE room_type_id IN (SELECT id FROM room_types WHERE code = 'TST-STAY-DELUXE');
      DELETE FROM room_types WHERE code = 'TST-STAY-DELUXE';
    `);

    // Create dedicated room type
    const rtRes = await client.query(
      `INSERT INTO room_types (property_id, code, name, base_rate, is_active)
       VALUES (1, 'TST-STAY-DELUXE', 'Test Stay Deluxe Room', 500000, true)
       RETURNING id`
    );
    cleanupIds.roomTypeId = rtRes.rows[0].id;

    // Create physical room
    const rmRes = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES (1, $1, '888-STAY', 'Test Stay Room 888', 'Tersedia', true)
       RETURNING id`,
      [cleanupIds.roomTypeId]
    );
    cleanupIds.roomId = rmRes.rows[0].id;

    const {
      listStayChargeRules,
      createStayChargeRule,
      updateStayChargeRule,
      deleteStayChargeRule,
      postStayChargeToFolio,
      voidFolioEntry
    } = require('../dist/domains/stayCharges/stayChargesService');

    const {
      createRatePlan,
      listRatePlans
    } = require('../dist/domains/pricing/pricingService');

    // 2. Test Default Seed Rules
    console.log('2. Verifying seeded stay charge rules...');
    const defaultRules = await listStayChargeRules(pool, 1);
    assert(defaultRules.length >= 7, 'Expected at least 7 default stay charge rules');
    const extraBedRule = defaultRules.find(r => r.code === 'EXTRA_BED_STD');
    assert(extraBedRule, 'Default EXTRA_BED_STD rule must exist');
    assert.strictEqual(extraBedRule.charge_type, 'EXTRA_BED');
    assert.strictEqual(Number(extraBedRule.default_amount), 150000);
    console.log('   ✓ Default seed rules verified (EXTRA_BED, EXTRA_PERSON, EARLY_CHECKIN, LATE_CHECKOUT, PENALTY)');

    // 3. Test Rule CRUD & Constraints
    console.log('3. Testing Stay Charge Rule CRUD...');
    const createdRule = await createStayChargeRule(pool, 1, {
      charge_type: 'PENALTY',
      code: 'TST_PENALTY_GLASS',
      name: 'Pecah Gelas / Piring',
      description: 'Denda kerusakan alat makan/minum',
      charge_method: 'FIXED_AMOUNT',
      default_amount: 50000,
      taxable: false,
      service_chargeable: false
    });
    cleanupIds.ruleIds.push(createdRule.id);
    assert.strictEqual(createdRule.code, 'TST_PENALTY_GLASS');
    assert.strictEqual(Number(createdRule.default_amount), 50000);

    // Duplicate code prevention
    await assert.rejects(
      async () => {
        await createStayChargeRule(pool, 1, {
          charge_type: 'PENALTY',
          code: 'TST_PENALTY_GLASS',
          name: 'Duplicate Code',
          charge_method: 'FIXED_AMOUNT',
          default_amount: 60000
        });
      },
      /sudah digunakan/i,
      'Duplicate rule code should be rejected'
    );

    // Update rule
    const updatedRule = await updateStayChargeRule(pool, 1, createdRule.id, {
      default_amount: 75000,
      name: 'Pecah Gelas Kristal'
    });
    assert.strictEqual(Number(updatedRule.default_amount), 75000);
    assert.strictEqual(updatedRule.name, 'Pecah Gelas Kristal');
    console.log('   ✓ Rule CRUD and uniqueness constraints verified');

    // 4. Test Day Use Rate Plan Creation
    console.log('4. Testing Day Use Rate Plan configuration...');
    const dayUsePlan = await createRatePlan(pool, 1, {
      room_type_id: cleanupIds.roomTypeId,
      code: 'TST-DAY-6H',
      name: 'Day Use 6 Jam Transit',
      description: 'Paket transit maksimal 6 jam antara 08:00 - 18:00',
      rate_type: 'DAY_USE',
      duration_minutes: 360,
      earliest_start_time: '08:00',
      latest_start_time: '18:00',
      turnaround_buffer_minutes: 60,
      base_rate: 250000,
      meal_plan: 'RO',
      min_stay: 1,
      max_stay: 1,
      refundable: false
    });
    cleanupIds.ratePlanIds.push(dayUsePlan.id);
    assert.strictEqual(dayUsePlan.rate_type, 'DAY_USE');
    assert.strictEqual(dayUsePlan.duration_minutes, 360);
    assert.strictEqual(dayUsePlan.turnaround_buffer_minutes, 60);
    console.log('   ✓ Day Use Rate Plan created and validated');

    // 5. Test Express API Integration & Booking Invariants
    console.log('5. Bootstrapping Express app for integration & overlap tests...');
    const { app } = require('../dist/index');
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // Create Day Use Booking A: 2026-11-20 09:00 - 13:00 on Room 888
      console.log('6. Testing Day Use booking creation & overlap detection...');
      const bookingResA = await fetch(`${baseUrl}/api/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: 1,
          guest_name: 'Transit Guest A',
          guest_phone: '081234567890',
          reservations: [{
            room_id: cleanupIds.roomId,
            guest_name: 'Transit Guest A',
            guest_phone: '081234567890',
            check_in: '2026-11-20',
            check_out: '2026-11-20',
            stay_type: 'DAY_USE',
            start_at: '2026-11-20T09:00:00+07:00',
            end_at: '2026-11-20T13:00:00+07:00',
            subtotal_amount: 250000,
            total_price: 250000,
            payment_status: 'PAID',
            amount_paid: 250000
          }]
        })
      });

      if (bookingResA.status !== 201) {
        console.error('Booking A failed with status:', bookingResA.status, 'body:', await bookingResA.text());
      }
      assert.strictEqual(bookingResA.status, 201, 'Booking A creation should succeed');
      const bookingDataA = await bookingResA.json();
      const bookingIdA = bookingDataA.data.booking_id || bookingDataA.data.booking?.id;
      cleanupIds.bookingIds.push(bookingIdA);
      const resIdA = bookingDataA.data.reservations[0].id;
      cleanupIds.reservationIds.push(resIdA);

      // Verify reservation row attributes
      const resRowA = await client.query('SELECT stay_type, start_at, end_at FROM reservations WHERE id = $1', [resIdA]);
      assert.strictEqual(resRowA.rows[0].stay_type, 'DAY_USE');
      assert(resRowA.rows[0].start_at, 'start_at must be populated');
      assert(resRowA.rows[0].end_at, 'end_at must be populated');

      // Invariant check: availability_dates.reserved_qty must NOT be incremented for DAY_USE
      const availRow = await client.query(
        `SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = '2026-11-20'`,
        [cleanupIds.roomTypeId]
      );
      const reservedQty = availRow.rows.length > 0 ? availRow.rows[0].reserved_qty : 0;
      assert.strictEqual(reservedQty, 0, 'DAY_USE must not alter overnight reserved_qty ledger');
      console.log('   ✓ Day Use booking created with zero 24h inventory drift');

      // Test Collision: Overlapping Booking B (11:00 - 15:00) on same Room 888 -> Must FAIL
      const bookingResB = await fetch(`${baseUrl}/api/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: 1,
          guest_name: 'Transit Guest B (Overlapping)',
          guest_phone: '081234567891',
          reservations: [{
            room_id: cleanupIds.roomId,
            guest_name: 'Transit Guest B',
            check_in: '2026-11-20',
            check_out: '2026-11-20',
            stay_type: 'DAY_USE',
            start_at: '2026-11-20T11:00:00+07:00',
            end_at: '2026-11-20T15:00:00+07:00',
            subtotal_amount: 250000,
            total_price: 250000
          }]
        })
      });
      assert.strictEqual(bookingResB.status, 409, 'Overlapping Day Use booking must be rejected with 409');
      console.log('   ✓ Direct time window collision rejected with 409 Conflict');

      // Test Collision: Turnaround buffer check (13:30 - 17:30 is within 60 min of 13:00) -> Must FAIL
      const bookingResC = await fetch(`${baseUrl}/api/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: 1,
          guest_name: 'Transit Guest C (Within Buffer)',
          guest_phone: '081234567892',
          reservations: [{
            room_id: cleanupIds.roomId,
            guest_name: 'Transit Guest C',
            check_in: '2026-11-20',
            check_out: '2026-11-20',
            stay_type: 'DAY_USE',
            start_at: '2026-11-20T13:30:00+07:00',
            end_at: '2026-11-20T17:30:00+07:00',
            subtotal_amount: 250000,
            total_price: 250000
          }]
        })
      });
      assert.strictEqual(bookingResC.status, 409, 'Day Use within turnaround buffer must be rejected with 409');
      console.log('   ✓ Housekeeping turnaround buffer collision rejected with 409 Conflict');

      // Test Valid Non-colliding Booking D: 14:30 - 18:30 on same Room 888 (13:00 + 60m buffer = 14:00 clean) -> Must SUCCEED
      const bookingResD = await fetch(`${baseUrl}/api/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: 1,
          guest_name: 'Transit Guest D (After Buffer)',
          guest_phone: '081234567893',
          reservations: [{
            room_id: cleanupIds.roomId,
            guest_name: 'Transit Guest D',
            check_in: '2026-11-20',
            check_out: '2026-11-20',
            stay_type: 'DAY_USE',
            start_at: '2026-11-20T14:30:00+07:00',
            end_at: '2026-11-20T18:30:00+07:00',
            subtotal_amount: 250000,
            total_price: 250000,
            payment_status: 'PAID',
            amount_paid: 250000
          }]
        })
      });
      assert.strictEqual(bookingResD.status, 201, 'Non-colliding Day Use after buffer should succeed');
      const bookingDataD = await bookingResD.json();
      const bookingIdD = bookingDataD.data.booking_id || bookingDataD.data.booking?.id;
      cleanupIds.bookingIds.push(bookingIdD);
      const resIdD = bookingDataD.data.reservations[0].id;
      cleanupIds.reservationIds.push(resIdD);
      console.log('   ✓ Non-colliding Day Use booking after buffer accepted');

      // 7. Test Posting Stay Charges & Penalties to Folio
      console.log('7. Testing Stay Charge posting to Folio...');
      const postChargeRes = await fetch(`${baseUrl}/api/stay-charges/post-charge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: 1,
          reservation_id: resIdA,
          charge_type: 'EXTRA_BED',
          custom_description: 'Extra Bed Deluxe 1 Set',
          quantity: 1,
          unit_price_override: 150000,
          notes: 'Permintaan tamu di front desk'
        })
      });
      const postChargeData = await postChargeRes.json();
      if (postChargeRes.status !== 201) {
        console.error('postChargeRes error body:', postChargeData);
      }
      assert.strictEqual(postChargeRes.status, 201, 'Posting stay charge to folio should return 201');
      const postedEntry = postChargeData.data.folio_entry;
      assert.strictEqual(postedEntry.source_type, 'EXTRA_BED');
      assert(Number(postedEntry.amount) >= 150000);

      // Verify reservation balance updated
      const updatedResA = await client.query('SELECT total_price, remaining_balance FROM reservations WHERE id = $1', [resIdA]);
      assert(Number(updatedResA.rows[0].total_price) > 250000, 'Reservation total price must increase');
      assert(Number(updatedResA.rows[0].remaining_balance) > 0, 'Remaining balance must reflect unpaid charge');
      console.log('   ✓ Extra Bed charge posted atomically, folio and reservation balances synchronized');

      // Post Penalty charge
      const postPenaltyRes = await fetch(`${baseUrl}/api/stay-charges/post-charge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: 1,
          reservation_id: resIdA,
          charge_type: 'PENALTY',
          rule_id: createdRule.id,
          custom_description: 'Denda Pecah Gelas Kristal',
          quantity: 1
        })
      });
      assert.strictEqual(postPenaltyRes.status, 201);
      const penaltyData = await postPenaltyRes.json();
      const penaltyEntry = penaltyData.data.folio_entry;
      assert.strictEqual(penaltyEntry.source_type, 'PENALTY');
      console.log('   ✓ Penalty charge posted to Folio');

      // 8. Test Voiding Folio Entry
      console.log('8. Testing Folio Entry Void with Audit Trail...');
      const totalBeforeVoid = Number(updatedResA.rows[0].total_price);
      const voidRes = await fetch(`${baseUrl}/api/stay-charges/void-entry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: 1,
          folio_entry_id: postedEntry.id,
          reason: 'Salah input kamar oleh receptionist'
        })
      });
      assert.strictEqual(voidRes.status, 200, 'Voiding folio entry should return 200');
      const voidData = await voidRes.json();
      assert.strictEqual(voidData.data.folio_entry.is_voided, true);
      assert.strictEqual(voidData.data.folio_entry.void_reason, 'Salah input kamar oleh receptionist');

      // Verify reservation balance adjusted back down
      const afterVoidResA = await client.query('SELECT total_price, remaining_balance FROM reservations WHERE id = $1', [resIdA]);
      assert(Number(afterVoidResA.rows[0].total_price) < totalBeforeVoid + Number(penaltyEntry.amount), 'Reservation total price must decrease after void');

      // Verify double-void is rejected
      const doubleVoidRes = await fetch(`${baseUrl}/api/stay-charges/void-entry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: 1,
          folio_entry_id: postedEntry.id,
          reason: 'Second void attempt'
        })
      });
      assert([400, 409].includes(doubleVoidRes.status), 'Double-voiding must be rejected');
      console.log('   ✓ Voiding folio entry updates balances and prevents double-void');

      // 9. Test Day Use Checkout & Housekeeping Task Trigger
      console.log('9. Testing Day Use checkout & housekeeping turnover...');
      // Check in reservation D first
      await client.query(`UPDATE reservations SET status = 'CHECKED_IN' WHERE id = $1`, [resIdD]);
      await client.query(`UPDATE rooms SET status = 'Terisi' WHERE id = $1`, [cleanupIds.roomId]);

      // Perform checkout
      const checkoutRes = await fetch(`${baseUrl}/api/reservations/${resIdD}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: 1, skip_inspection: true })
      });
      assert.strictEqual(checkoutRes.status, 200, 'Day Use checkout should succeed');

      // Verify room status changed to VACANT_DIRTY
      const checkedRoom = await client.query('SELECT status FROM rooms WHERE id = $1', [cleanupIds.roomId]);
      assert(['VACANT_DIRTY', 'Kotor'].includes(checkedRoom.rows[0].status), 'Room must transition to VACANT_DIRTY on Day Use checkout');

      // Verify Housekeeping room cleaning task created
      const hkTask = await client.query(
        `SELECT id, task_type, status FROM housekeeping_tasks WHERE room_id = $1 AND task_type = 'ROOM_CLEANING' ORDER BY id DESC LIMIT 1`,
        [cleanupIds.roomId]
      );
      assert(hkTask.rows.length > 0, 'Housekeeping room cleaning task must be created for Day Use');
      console.log('   ✓ Day Use checkout transitions room to VACANT_DIRTY and creates cleaning task');

    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    console.log('\n>>> ALL STAY CHARGES & DAY USE FOUNDATION TESTS PASSED (9/9) <<<');
  } finally {
    console.log('\n--- CLEANING UP TEST FIXTURES ---');
    try {
      if (cleanupIds.roomId) {
        await client.query('DELETE FROM payment_evidences WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id = $1)', [cleanupIds.roomId]);
        await client.query('DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id = $1)', [cleanupIds.roomId]);
        await client.query('DELETE FROM reservation_guests WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id = $1)', [cleanupIds.roomId]);
        await client.query('DELETE FROM reservation_nightly_rates WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id = $1)', [cleanupIds.roomId]);
        await client.query('DELETE FROM folio_entries WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id = $1)', [cleanupIds.roomId]);
        await client.query('DELETE FROM housekeeping_tasks WHERE room_id = $1', [cleanupIds.roomId]);
        await client.query('DELETE FROM reservations WHERE room_id = $1', [cleanupIds.roomId]);
      }
      if (cleanupIds.reservationIds.length > 0) {
        await client.query('DELETE FROM payment_evidences WHERE reservation_id = ANY($1::int[])', [cleanupIds.reservationIds]);
        await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [cleanupIds.reservationIds]);
        await client.query('DELETE FROM reservation_guests WHERE reservation_id = ANY($1::int[])', [cleanupIds.reservationIds]);
        await client.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1::int[])', [cleanupIds.reservationIds]);
        await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [cleanupIds.reservationIds]);
        await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [cleanupIds.reservationIds]);
      }
      if (cleanupIds.bookingIds.length > 0) {
        await client.query('DELETE FROM bookings WHERE id = ANY($1::int[])', [cleanupIds.bookingIds]);
      }
      if (cleanupIds.ruleIds.length > 0) {
        await client.query('DELETE FROM stay_charge_rules WHERE id = ANY($1::int[])', [cleanupIds.ruleIds]);
      }
      if (cleanupIds.ratePlanIds.length > 0) {
        await client.query('DELETE FROM rate_overrides WHERE rate_plan_id = ANY($1::int[])', [cleanupIds.ratePlanIds]);
        await client.query('DELETE FROM rate_plans WHERE id = ANY($1::int[])', [cleanupIds.ratePlanIds]);
      }
      if (cleanupIds.roomId) {
        await client.query('DELETE FROM rooms WHERE id = $1', [cleanupIds.roomId]);
      }
      if (cleanupIds.roomTypeId) {
        await client.query('DELETE FROM availability_dates WHERE room_type_id = $1', [cleanupIds.roomTypeId]);
        await client.query('DELETE FROM room_types WHERE id = $1', [cleanupIds.roomTypeId]);
      }
      console.log('Cleaned up all test fixtures.');
    } catch (cleanErr) {
      console.error('Error during cleanup:', cleanErr);
    } finally {
      client.release();
    }
  }
}

runTest()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('TEST FAILED:', err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
