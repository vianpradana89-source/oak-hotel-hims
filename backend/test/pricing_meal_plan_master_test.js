const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Pool } = require('pg');
const assert = require('assert');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

async function runTest() {
  console.log('=== STARTING MEAL PLAN MASTER CRUD & RATE PLAN LINKAGE TEST (RATE-1C) ===');
  const client = await pool.connect();

  const cleanup = {
    propertyId: 1,
    testMealPlanIds: [],
    testRatePlanIds: [],
    testRoomTypeId: null,
    testRoomId: null,
    testBookingIds: [],
    testReservationIds: []
  };

  try {
    const { initializeDatabase } = require('../dist/db/schema_v3');
    await initializeDatabase(pool);

    const {
      listMealPlans,
      getMealPlanById,
      createMealPlan,
      updateMealPlan,
      setMealPlanActive,
      deleteMealPlan,
      createRatePlan,
      listRatePlans,
      getRatePlanById,
      calculatePriceQuote,
      createReservationRateSnapshots,
      getReservationRateSnapshots
    } = require('../dist/domains/pricing/pricingService');

    // 1. Seed Check
    console.log('1. Verifying baseline seeded meal plans for Property 1...');
    const seededPlans = await listMealPlans(client, 1, { include_archived: true });
    const seededCodes = seededPlans.map((p) => p.code);
    assert(seededCodes.includes('RO'), 'Must contain RO');
    assert(seededPlans.length >= 1, 'Must have active meal plans');
    console.log(`   ✓ Baseline meal plans verified (${seededCodes.join(', ')})`);

    // 2. Meal Plan CRUD Operations
    console.log('2. Testing Meal Plan Master CRUD...');
    const customMp = await createMealPlan(client, 1, {
      code: 'TST-MP1',
      name: 'Test Custom Meal Plan 1',
      description: 'Breakfast and Dinner included for test',
      breakfast_included: true,
      lunch_included: false,
      dinner_included: true,
      is_active: true,
      sort_order: 10
    });
    cleanup.testMealPlanIds.push(customMp.id);
    assert.strictEqual(customMp.code, 'TST-MP1');
    assert.strictEqual(customMp.breakfast_included, true);
    assert.strictEqual(customMp.lunch_included, false);
    assert.strictEqual(customMp.dinner_included, true);
    assert.strictEqual(customMp.is_active, true);
    assert.strictEqual(customMp.is_archived, false);
    console.log('   ✓ Meal Plan created successfully');

    // Test get by ID
    const fetchedMp = await getMealPlanById(client, 1, customMp.id);
    assert.strictEqual(fetchedMp.id, customMp.id);
    assert.strictEqual(fetchedMp.name, 'Test Custom Meal Plan 1');
    console.log('   ✓ Meal Plan fetched by ID successfully');

    // Test update
    const updatedMp = await updateMealPlan(client, 1, customMp.id, {
      name: 'Test Custom Meal Plan 1 Updated',
      lunch_included: true
    });
    assert.strictEqual(updatedMp.name, 'Test Custom Meal Plan 1 Updated');
    assert.strictEqual(updatedMp.lunch_included, true);
    console.log('   ✓ Meal Plan updated successfully');

    // Test status toggle (deactivate / activate)
    const deactivatedMp = await setMealPlanActive(client, 1, customMp.id, false);
    assert.strictEqual(deactivatedMp.is_active, false);
    const reactivatedMp = await setMealPlanActive(client, 1, customMp.id, true);
    assert.strictEqual(reactivatedMp.is_active, true);
    console.log('   ✓ Meal Plan status toggle (active/inactive) verified');

    // 3. Validation: Duplicate code in same property must fail
    console.log('3. Testing uniqueness constraint within property...');
    let duplicateFailed = false;
    try {
      await createMealPlan(client, 1, {
        code: 'tst-mp1', // lowercase variant should collide
        name: 'Duplicate Test Plan'
      });
    } catch (err) {
      duplicateFailed = true;
      assert(err.message.includes('sudah ada') || err.message.includes('sudah digunakan'), 'Should mention code already exists');
    }
    assert.strictEqual(duplicateFailed, true, 'Duplicate code in same property must be rejected');
    console.log('   ✓ Duplicate code rejection verified');

    // 4. Safe Delete: Unused meal plan should be hard deleted
    console.log('4. Testing Safe Delete on unused meal plan...');
    const unusedMp = await createMealPlan(client, 1, {
      code: 'TST-UNUSED',
      name: 'Unused Test Meal Plan'
    });
    const deleteRes = await deleteMealPlan(client, 1, unusedMp.id);
    assert.strictEqual(deleteRes.deleted, true, 'Unused meal plan should be hard deleted');
    assert.strictEqual(deleteRes.archived, false);
    const afterDelete = await getMealPlanById(client, 1, unusedMp.id);
    assert.strictEqual(afterDelete, null, 'Deleted meal plan must not exist');
    console.log('   ✓ Unused meal plan hard-deleted successfully');

    // 5. Rate Plan Relational Link & Safe Archive
    console.log('5. Testing Rate Plan relational link & Safe Archive protection...');
    // Create test room type and room
    const rtRes = await client.query(
      `INSERT INTO room_types (property_id, code, name, base_rate, is_active)
       VALUES (1, 'TST-RT-MP', 'Test Room Type for MP', 450000, true)
       RETURNING id`
    );
    cleanup.testRoomTypeId = rtRes.rows[0].id;

    const rmRes = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES (1, $1, '998-MP', 'Test Room 998 MP', 'Tersedia', true)
       RETURNING id`,
      [cleanup.testRoomTypeId]
    );
    cleanup.testRoomId = rmRes.rows[0].id;

    // Create rate plan linked to customMp.id
    const ratePlanWithMp = await createRatePlan(client, 1, {
      room_type_id: cleanup.testRoomTypeId,
      code: 'TST-RP-MP',
      name: 'Rate Plan with Custom Meal Plan',
      base_rate: 600000,
      meal_plan_id: customMp.id,
      is_active: true
    });
    cleanup.testRatePlanIds.push(ratePlanWithMp.id);
    assert.strictEqual(ratePlanWithMp.meal_plan_id, customMp.id);
    assert.strictEqual(ratePlanWithMp.meal_plan, 'TST-MP1');
    assert.strictEqual(ratePlanWithMp.meal_plan_name, 'Test Custom Meal Plan 1 Updated');
    console.log('   ✓ Rate Plan linked to Meal Plan ID and populated snapshots');

    // Attempting to delete customMp should archive instead of hard delete
    const archiveRes = await deleteMealPlan(client, 1, customMp.id);
    assert.strictEqual(archiveRes.deleted, false, 'Referenced meal plan must NOT be hard deleted');
    assert.strictEqual(archiveRes.archived, true, 'Referenced meal plan must be archived');
    assert(
      archiveRes.message.includes('Meal Plan sudah digunakan oleh Rate Plan atau histori reservasi'),
      'Must return informative Indonesian archive message'
    );
    console.log('   ✓ Safe Archive triggered with proper user message');

    const archivedMp = await getMealPlanById(client, 1, customMp.id);
    assert.strictEqual(archivedMp.is_archived, true);
    assert.strictEqual(archivedMp.is_active, false);
    console.log('   ✓ Meal Plan state updated to is_archived=true, is_active=false');

    // 6. Test Price Quote & Snapshot generation with Meal Plan
    console.log('6. Testing Quote & Reservation Snapshot Meal Plan propagation...');
    const quote = await calculatePriceQuote(client, {
      property_id: 1,
      room_type_id: cleanup.testRoomTypeId,
      rate_plan_id: ratePlanWithMp.id,
      check_in: '2026-10-01',
      check_out: '2026-10-03'
    });
    assert.strictEqual(quote.nights, 2);
    assert.strictEqual(quote.rate_plan.meal_plan, 'TST-MP1');
    assert.strictEqual(quote.rate_plan.meal_plan_id, customMp.id);
    assert.strictEqual(quote.rate_plan.meal_plan_code, 'TST-MP1');
    assert.strictEqual(quote.rate_plan.meal_plan_name, 'Test Custom Meal Plan 1 Updated');
    console.log('   ✓ Quote breakdown contains meal_plan_id and snapshots');

    // Create a real test booking and reservation
    const bRes = await client.query(
      `INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_source, channel)
       VALUES ('BID-TST-MP-001', 1, 'Test MP Guest', 'WALKIN', 'DIRECT')
       RETURNING id`
    );
    cleanup.testBookingIds.push(bRes.rows[0].id);

    const rRes = await client.query(
      `INSERT INTO reservations (
        booking_id, room_id, guest_name, check_in, check_out, total_price, status, stay_status, stay_sequence,
        booked_room_type_id_snapshot, booked_room_type_code_snapshot, booked_room_type_name_snapshot,
        classification_snapshot_source
      ) VALUES (
        $1, $2, 'Test MP Guest', '2026-10-01', '2026-10-03', $3, 'BOOKED', 'RESERVED', 1,
        $4, 'TST-RT-MP', 'Test Room Type for MP', 'CANONICAL_ROOM_MASTER'
      ) RETURNING id`,
      [bRes.rows[0].id, cleanup.testRoomId, quote.grand_total, cleanup.testRoomTypeId]
    );
    const testReservationId = rRes.rows[0].id;
    cleanup.testReservationIds.push(testReservationId);

    // Create reservation rate snapshot
    const snapRes = await createReservationRateSnapshots(
      client,
      testReservationId,
      1,
      quote
    );
    assert.strictEqual(snapRes.length, 2);
    assert.strictEqual(snapRes[0].meal_plan_id, customMp.id);
    assert.strictEqual(snapRes[0].meal_plan_code_snapshot, 'TST-MP1');
    assert.strictEqual(snapRes[0].meal_plan_name_snapshot, 'Test Custom Meal Plan 1 Updated');
    console.log('   ✓ Reservation rate snapshots preserve meal_plan_id and code/name snapshots');

    // 7. Audit Log Verification
    console.log('7. Verifying Audit Logs for Meal Plan events...');
    const auditRes = await client.query(
      `SELECT action, record_id FROM audit_logs
       WHERE entity = 'meal_plans' AND property_id = 1
       ORDER BY audit_id DESC LIMIT 10`
    );
    const actions = auditRes.rows.map((r) => r.action);
    assert(actions.includes('MEAL_PLAN_CREATED'), 'Must log MEAL_PLAN_CREATED');
    assert(actions.includes('MEAL_PLAN_UPDATED'), 'Must log MEAL_PLAN_UPDATED');
    assert(actions.includes('MEAL_PLAN_ARCHIVED'), 'Must log MEAL_PLAN_ARCHIVED');
    console.log('   ✓ Audit trails recorded correctly for Meal Plan events');

    console.log('=== ALL MEAL PLAN MASTER CRUD & LINKAGE TESTS PASSED! ===');
  } finally {
    console.log('Cleaning up test fixtures...');
    try {
      for (const resId of cleanup.testReservationIds) {
        await client.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = $1', [resId]);
        await client.query('DELETE FROM reservations WHERE id = $1', [resId]);
      }
      for (const bId of cleanup.testBookingIds) {
        await client.query('DELETE FROM bookings WHERE id = $1', [bId]);
      }
      for (const rpid of cleanup.testRatePlanIds) {
        await client.query('DELETE FROM rate_overrides WHERE rate_plan_id = $1', [rpid]);
        await client.query('DELETE FROM rate_plans WHERE id = $1', [rpid]);
      }
      for (const mpid of cleanup.testMealPlanIds) {
        await client.query('DELETE FROM meal_plans WHERE id = $1', [mpid]);
      }
      if (cleanup.testRoomId) {
        await client.query('DELETE FROM rooms WHERE id = $1', [cleanup.testRoomId]);
      }
      if (cleanup.testRoomTypeId) {
        await client.query('DELETE FROM room_types WHERE id = $1', [cleanup.testRoomTypeId]);
      }
    } catch (cleanErr) {
      console.error('Cleanup error:', cleanErr);
    }
    client.release();
  }
}

runTest()
  .then(() => {
    pool.end();
    process.exit(0);
  })
  .catch((err) => {
    console.error('TEST FAILED:', err);
    pool.end();
    process.exit(1);
  });
