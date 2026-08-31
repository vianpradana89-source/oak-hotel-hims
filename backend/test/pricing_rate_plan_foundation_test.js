const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const http = require('http');
const { Pool } = require('pg');
const assert = require('assert');

// Use database connection from environment or default local database
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

async function runTest() {
  console.log('--- STARTING PRICING & RATE PLAN FOUNDATION TEST (RATE-1) ---');
  const client = await pool.connect();

  const cleanupIds = {
    propertyId: 1,
    roomTypeId: null,
    roomId: null,
    ratePlanIds: [],
    overrideIds: [],
    bookingIds: [],
    reservationIds: []
  };

  try {
    // 0. Ensure schema is migrated
    const { initializeDatabase } = require('../dist/db/schema_v3');
    await initializeDatabase(pool);

    console.log('1. Setting up test fixtures...');
    // Create a dedicated test room type
    const rtRes = await client.query(
      `INSERT INTO room_types (property_id, code, name, base_rate, is_active)
       VALUES (1, 'TST-PRC-DELUXE', 'Test Deluxe Room', 500000, true)
       RETURNING id`
    );
    cleanupIds.roomTypeId = rtRes.rows[0].id;

    // Create a dedicated physical room
    const rmRes = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES (1, $1, '999-PRC', 'Test Pricing Room 999', 'Tersedia', true)
       RETURNING id`,
      [cleanupIds.roomTypeId]
    );
    cleanupIds.roomId = rmRes.rows[0].id;

    // 2. Test Property Pricing Settings
    console.log('2. Testing Property Pricing Settings...');
    const {
      getPropertyPricingSettings,
      updatePropertyPricingSettings,
      createRatePlan,
      listRatePlans,
      getRatePlanById,
      updateRatePlan,
      duplicateRatePlan,
      setRatePlanActive,
      deleteRatePlan,
      upsertRateOverride,
      listRateOverrides,
      getRateCalendarMatrix,
      deleteRateOverride,
      calculatePriceQuote,
      createReservationRateSnapshots,
      getReservationRateSnapshots
    } = require('../dist/domains/pricing/pricingService');

    const settings = await getPropertyPricingSettings(client, 1);
    assert(typeof settings.tax_percent === 'number', 'tax_percent must be a number');
    assert(typeof settings.service_charge_percent === 'number', 'service_charge_percent must be a number');

    const updatedSettings = await updatePropertyPricingSettings(client, 1, {
      tax_percent: 10,
      service_charge_percent: 5
    });
    assert.strictEqual(updatedSettings.tax_percent, 10, 'tax_percent should be updated to 10');
    assert.strictEqual(updatedSettings.service_charge_percent, 5, 'service_charge_percent should be updated to 5');
    console.log('   ✓ Property pricing settings verified (10% tax, 5% service)');

    // 3. Test Rate Plan Creation
    console.log('3. Testing Rate Plan CRUD...');
    const barPlan = await createRatePlan(client, 1, {
      room_type_id: cleanupIds.roomTypeId,
      code: 'TST-BAR',
      name: 'Best Available Rate (Test)',
      description: 'Standard flexible rate with breakfast',
      base_rate: 550000,
      meal_plan: 'BB',
      refundable: true,
      min_stay: 1,
      is_active: true
    });
    cleanupIds.ratePlanIds.push(barPlan.id);
    assert.strictEqual(barPlan.code, 'TST-BAR');
    assert.strictEqual(barPlan.base_rate, 550000);
    assert.strictEqual(barPlan.meal_plan, 'BB');
    assert.strictEqual(barPlan.refundable, true);
    console.log('   ✓ Rate Plan created: TST-BAR (ID:', barPlan.id, ')');

    // Duplicate code prevention test
    let dupFailed = false;
    try {
      await createRatePlan(client, 1, {
        room_type_id: cleanupIds.roomTypeId,
        code: 'TST-BAR',
        name: 'Duplicate BAR',
        base_rate: 600000
      });
    } catch (e) {
      dupFailed = true;
    }
    assert(dupFailed, 'Creating rate plan with duplicate active code must throw error');
    console.log('   ✓ Unique rate plan code validation enforced');

    // 4. Test Rate Plan Duplication
    console.log('4. Testing Rate Plan Duplication...');
    const promoPlan = await duplicateRatePlan(client, 1, barPlan.id, {
      code: 'TST-PROMO',
      name: 'Weekend Special Promo (Test)',
      base_rate: 450000
    });
    cleanupIds.ratePlanIds.push(promoPlan.id);
    assert.strictEqual(promoPlan.code, 'TST-PROMO');
    assert.strictEqual(promoPlan.base_rate, 450000);
    assert.strictEqual(promoPlan.meal_plan, 'BB'); // inherited from barPlan
    console.log('   ✓ Rate Plan duplicated: TST-PROMO (ID:', promoPlan.id, ')');

    // 5. Test Rate Plan Status Toggle
    console.log('5. Testing Rate Plan Status Toggle...');
    const deactivated = await setRatePlanActive(client, 1, promoPlan.id, false);
    assert.strictEqual(deactivated.is_active, false, 'Rate plan should be deactivated');
    const reactivated = await setRatePlanActive(client, 1, promoPlan.id, true);
    assert.strictEqual(reactivated.is_active, true, 'Rate plan should be reactivated');
    console.log('   ✓ Rate plan active state toggled successfully');

    // 6. Test Rate Overrides & Calendar Matrix
    console.log('6. Testing Rate Overrides and Calendar Matrix...');
    // Override 2 nights: 2026-10-02 to 2026-10-04 (nights of Oct 2 and Oct 3)
    const override1 = await upsertRateOverride(client, 1, barPlan.id, {
      start_date: '2026-10-02',
      end_date: '2026-10-04',
      override_rate: 750000,
      reason: 'Peak Season Weekend Test'
    });
    cleanupIds.overrideIds.push(override1.id);
    assert.strictEqual(override1.override_rate, 750000);
    assert.strictEqual(override1.start_date, '2026-10-02');
    assert.strictEqual(override1.end_date, '2026-10-04');

    // Test collision detection
    let collisionError = false;
    try {
      await upsertRateOverride(client, 1, barPlan.id, {
        start_date: '2026-10-03',
        end_date: '2026-10-05',
        override_rate: 800000
      });
    } catch (e) {
      collisionError = true;
    }
    assert(collisionError, 'Colliding override without replace_existing should throw error');
    console.log('   ✓ Rate override collision guard enforced');

    // Fetch calendar matrix for 5 nights: 2026-10-01 to 2026-10-06
    const matrix = await getRateCalendarMatrix(client, 1, barPlan.id, '2026-10-01', '2026-10-06');
    assert.strictEqual(matrix.days.length, 5, 'Matrix should contain 5 days [2026-10-01, 2026-10-06)');
    assert.strictEqual(matrix.days[0].date, '2026-10-01');
    assert.strictEqual(matrix.days[0].effective_rate, 550000, 'Oct 1 should be base rate 550,000');
    assert.strictEqual(matrix.days[0].is_overridden, false);
    assert.strictEqual(matrix.days[1].date, '2026-10-02');
    assert.strictEqual(matrix.days[1].effective_rate, 750000, 'Oct 2 should be override rate 750,000');
    assert.strictEqual(matrix.days[1].is_overridden, true);
    assert.strictEqual(matrix.days[2].date, '2026-10-03');
    assert.strictEqual(matrix.days[2].effective_rate, 750000, 'Oct 3 should be override rate 750,000');
    assert.strictEqual(matrix.days[2].is_overridden, true);
    assert.strictEqual(matrix.days[3].date, '2026-10-04');
    assert.strictEqual(matrix.days[3].effective_rate, 550000, 'Oct 4 should be base rate 550,000');
    console.log('   ✓ Calendar matrix calculations verified');

    // 7. Test Authoritative Price Quote
    console.log('7. Testing Authoritative Price Quote Calculation...');
    // Stay: 2026-10-01 to 2026-10-04 (3 nights: Oct 1 @ 550k, Oct 2 @ 750k, Oct 3 @ 750k)
    // Subtotal: 550,000 + 750,000 + 750,000 = 2,050,000
    // Service (5%): 2,050,000 * 0.05 = 102,500
    // Tax Base: 2,050,000 + 102,500 = 2,152,500
    // Tax (10%): 2,152,500 * 0.10 = 215,250
    // Grand Total: 2,050,000 + 102,500 + 215,250 = 2,367,750
    const quote = await calculatePriceQuote(client, {
      property_id: 1,
      room_type_id: cleanupIds.roomTypeId,
      rate_plan_id: barPlan.id,
      check_in: '2026-10-01',
      check_out: '2026-10-04'
    });

    assert.strictEqual(quote.nights, 3);
    assert.strictEqual(quote.room_subtotal, 2050000);
    assert.strictEqual(quote.service_amount, 102500);
    assert.strictEqual(quote.tax_amount, 215250);
    assert.strictEqual(quote.grand_total, 2367750);
    console.log('   ✓ Authoritative quote verified: subtotal = 2,050,000, service = 102,500, tax = 215,250, grand_total = 2,367,750');

    // 8. Test Immutable Nightly Snapshot & Booking Integration
    console.log('8. Testing Immutable Nightly Snapshot & Booking Integration...');
    // Create a reservation with quote
    const bRes = await client.query(
      `INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_source, channel)
       VALUES ('BID-TST-PRC-001', 1, 'Test Pricing Guest', 'WALKIN', 'DIRECT')
       RETURNING id`
    );
    const bookingId = bRes.rows[0].id;
    cleanupIds.bookingIds.push(bookingId);

    const rRes = await client.query(
      `INSERT INTO reservations (
        booking_id, room_id, guest_name, check_in, check_out, total_price, status, stay_status, stay_sequence,
        booked_room_type_id_snapshot, booked_room_type_code_snapshot, booked_room_type_name_snapshot,
        classification_snapshot_source
      ) VALUES (
        $1, $2, 'Test Pricing Guest', '2026-10-01', '2026-10-04', $3, 'BOOKED', 'RESERVED', 1,
        $4, 'TST-PRC-DELUXE', 'Test Deluxe Room', 'CANONICAL_ROOM_MASTER'
      ) RETURNING id`,
      [bookingId, cleanupIds.roomId, quote.grand_total, cleanupIds.roomTypeId]
    );
    const reservationId = rRes.rows[0].id;
    cleanupIds.reservationIds.push(reservationId);

    // Save snapshots
    const snapshots = await createReservationRateSnapshots(client, reservationId, 1, quote);
    assert.strictEqual(snapshots.length, 3);
    assert.strictEqual(snapshots[0].stay_date, '2026-10-01');
    assert.strictEqual(snapshots[0].final_room_rate, 550000);
    assert.strictEqual(snapshots[1].stay_date, '2026-10-02');
    assert.strictEqual(snapshots[1].final_room_rate, 750000);
    assert.strictEqual(snapshots[2].stay_date, '2026-10-03');
    assert.strictEqual(snapshots[2].final_room_rate, 750000);
    console.log('   ✓ Reservation nightly snapshots persisted (3 nights)');

    // 9. FINANCIAL IMMUTABILITY VERIFICATION
    console.log('9. Testing Financial Immutability (Master update must NEVER mutate past snapshots)...');
    // Mutate base rate on Master Rate Plan
    await updateRatePlan(client, 1, barPlan.id, {
      base_rate: 999999
    });

    // Verify reservation snapshots and reservation total_price remain 100% untouched
    const retrievedSnapshots = await getReservationRateSnapshots(client, reservationId);
    assert.strictEqual(retrievedSnapshots[0].base_rate, 550000, 'Historical snapshot base_rate must remain 550,000');
    assert.strictEqual(retrievedSnapshots[0].final_room_rate, 550000);
    assert.strictEqual(retrievedSnapshots[1].final_room_rate, 750000);

    const checkRes = await client.query('SELECT total_price, subtotal_amount FROM reservations WHERE id = $1', [reservationId]);
    assert.strictEqual(Number(checkRes.rows[0].total_price), 2367750, 'Historical reservation total_price must remain 2,367,750');
    console.log('   ✓ Financial Immutability verified: Master rate changes did NOT alter historical snapshot rates!');

    // 10. Test Safe Delete / Archive
    console.log('10. Testing Safe Delete / Archive...');
    // Deleting barPlan (which is referenced by reservationId) -> MUST ARCHIVE, NOT HARD DELETE
    const deleteReferencedResult = await deleteRatePlan(client, 1, barPlan.id);
    assert.strictEqual(deleteReferencedResult.deleted, false);
    assert.strictEqual(deleteReferencedResult.archived, true);
    assert(deleteReferencedResult.message.includes('diarsipkan'), 'Message should indicate archiving');

    const archivedPlan = await getRatePlanById(client, 1, barPlan.id);
    assert.strictEqual(archivedPlan.is_archived, true);
    assert.strictEqual(archivedPlan.is_active, false);
    console.log('   ✓ Referenced Rate Plan safely archived, historical reservation intact');

    // Deleting promoPlan (never referenced by any reservation) -> MUST HARD DELETE
    const deleteUnreferencedResult = await deleteRatePlan(client, 1, promoPlan.id);
    assert.strictEqual(deleteUnreferencedResult.deleted, true);
    assert.strictEqual(deleteUnreferencedResult.archived, false);
    const unreferencedPlan = await getRatePlanById(client, 1, promoPlan.id);
    assert.strictEqual(unreferencedPlan, null, 'Unreferenced rate plan should be completely deleted');
    console.log('   ✓ Unreferenced Rate Plan hard-deleted cleanly');

    // 11. Test Express HTTP Endpoints
    console.log('11. Testing Express HTTP API Endpoints...');
    const express = require('express');
    const { createPricingRouter } = require('../dist/domains/pricing/pricingRouter');
    const app = express();
    app.use(express.json());
    app.use('/api/pricing', createPricingRouter(pool));

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}/api/pricing`;

    try {
      // Test GET /settings
      const fetchFn = globalThis.fetch || require('node-fetch');
      const sRes = await fetchFn(`${baseUrl}/settings?property_id=1`);
      assert.strictEqual(sRes.status, 200);
      const sJson = await sRes.json();
      assert.strictEqual(sJson.property_id, 1);

      // Test POST /rate-plans
      const planRes = await fetchFn(`${baseUrl}/rate-plans?property_id=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room_type_id: cleanupIds.roomTypeId,
          code: 'TST-HTTP-PLAN',
          name: 'HTTP Test Plan',
          base_rate: 600000,
          meal_plan: 'RO'
        })
      });
      assert.strictEqual(planRes.status, 201);
      const planJson = await planRes.json();
      cleanupIds.ratePlanIds.push(planJson.id);
      assert.strictEqual(planJson.code, 'TST-HTTP-PLAN');

      // Test POST /quote
      const quoteRes = await fetchFn(`${baseUrl}/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: 1,
          room_type_id: cleanupIds.roomTypeId,
          rate_plan_id: planJson.id,
          check_in: '2026-11-01',
          check_out: '2026-11-03'
        })
      });
      assert.strictEqual(quoteRes.status, 200);
      const quoteJson = await quoteRes.json();
      assert.strictEqual(quoteJson.nights, 2);
      assert.strictEqual(quoteJson.room_subtotal, 1200000);
      console.log('   ✓ Express HTTP REST endpoints verified (GET /settings, POST /rate-plans, POST /quote)');
    } finally {
      if (server.closeAllConnections) server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }

    console.log('\n>>> ALL PRICING & RATE PLAN FOUNDATION TESTS PASSED (11/11) <<<');
  } finally {
    console.log('\n--- CLEANING UP TEST FIXTURES ---');
    try {
      if (cleanupIds.reservationIds.length > 0) {
        await client.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1::int[])', [cleanupIds.reservationIds]);
        await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [cleanupIds.reservationIds]);
        await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [cleanupIds.reservationIds]);
      }
      if (cleanupIds.bookingIds.length > 0) {
        await client.query('DELETE FROM bookings WHERE id = ANY($1::int[])', [cleanupIds.bookingIds]);
      }
      if (cleanupIds.overrideIds.length > 0) {
        await client.query('DELETE FROM rate_overrides WHERE id = ANY($1::int[])', [cleanupIds.overrideIds]);
      }
      if (cleanupIds.ratePlanIds.length > 0) {
        await client.query('DELETE FROM rate_overrides WHERE rate_plan_id = ANY($1::int[])', [cleanupIds.ratePlanIds]);
        await client.query('DELETE FROM rate_plans WHERE id = ANY($1::int[])', [cleanupIds.ratePlanIds]);
      }
      if (cleanupIds.roomId) {
        await client.query('DELETE FROM rooms WHERE id = $1', [cleanupIds.roomId]);
      }
      if (cleanupIds.roomTypeId) {
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
    setTimeout(() => process.exit(0), 50);
  })
  .catch(async (err) => {
    console.error('TEST FAILED:', err);
    await pool.end().catch(() => {});
    setTimeout(() => process.exit(1), 50);
  });
