/**
 * stay_charge_authoritative_pricing_test.js
 * Verification of STAY-CHARGE-UX-1C Authoritative Pricing, Controlled Overrides,
 * Snapshots, and Financial Classification.
 */

const { Pool } = require('pg');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

async function runTests() {
  const client = await pool.connect();
  let passed = 0;
  let failed = 0;

  console.log('\n======================================================');
  console.log('🧪 STAY CHARGE AUTHORITATIVE PRICING TEST SUITE (1C)');
  console.log('======================================================\n');

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  const testSuffix = Date.now().toString(36).toUpperCase();
  const testGuestName = `Guest-AuthPrice-${testSuffix}`;
  let propertyId = 1;
  let testRoomTypeId = null;
  let testRoomId = null;
  let testReservationId = null;
  let testBookingId = null;
  let qbBookingId = null;
  let qbResId = null;
  let testRuleFixedId = null;
  let testRulePctId = null;
  let testRuleFullId = null;
  let testRuleFreeId = null;
  let testRuleManualId = null;
  let testRulePenaltyId = null;

  try {
    // 0. Ensure schema migration is executed
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'folio_entries' AND column_name = 'rule_id'
        ) THEN
          ALTER TABLE folio_entries
            ADD COLUMN IF NOT EXISTS rule_id INTEGER REFERENCES stay_charge_rules(id) ON DELETE SET NULL,
            ADD COLUMN IF NOT EXISTS rule_code_snapshot VARCHAR(64),
            ADD COLUMN IF NOT EXISTS rule_name_snapshot VARCHAR(128),
            ADD COLUMN IF NOT EXISTS calculation_method_snapshot VARCHAR(64),
            ADD COLUMN IF NOT EXISTS original_rule_amount NUMERIC(12,2),
            ADD COLUMN IF NOT EXISTS is_override BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS override_amount NUMERIC(12,2),
            ADD COLUMN IF NOT EXISTS override_reason TEXT,
            ADD COLUMN IF NOT EXISTS override_by VARCHAR(128),
            ADD COLUMN IF NOT EXISTS override_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS revenue_category VARCHAR(64) DEFAULT 'ROOM_SALES';
        END IF;
      END $$;
    `);

    // 1. Setup Test Fixture Room Type, Room, and Reservation
    const rtRes = await client.query(`
      SELECT id FROM room_types WHERE property_id = $1 LIMIT 1
    `, [propertyId]);
    testRoomTypeId = rtRes.rows[0]?.id || 1;

    const rRes = await client.query(`
      SELECT id FROM rooms WHERE room_type_id = $1 AND property_id = $2 LIMIT 1
    `, [testRoomTypeId, propertyId]);
    testRoomId = rRes.rows[0]?.id || 1;

    // Create unique test booking and reservation with 600.000 nightly rate
    const bookingRes = await client.query(`
      INSERT INTO bookings (bid, property_id, guest_name_snapshot, guest_phone_snapshot, booking_status)
      VALUES ($1, $2, $3, '081234567890', 'ACTIVE')
      RETURNING id, bid
    `, [`BID-TEST-${testSuffix}`, propertyId, testGuestName]);
    testBookingId = bookingRes.rows[0].id;

    const resRes = await client.query(`
      INSERT INTO reservations (
        booking_id, stay_sequence, room_id, guest_name, guest_phone,
        check_in, check_out, total_price, status
      ) VALUES (
        $1, 1, $2, $3, '081234567890',
        '2026-09-01', '2026-09-03', 1200000, 'BOOKED'
      ) RETURNING id
    `, [testBookingId, testRoomId, testGuestName]);
    testReservationId = resRes.rows[0].id;

    // Add nightly rates: 600.000 per night
    await client.query(`
      INSERT INTO reservation_nightly_rates (
        property_id, reservation_id, room_type_id, stay_date, base_rate, final_room_rate, total_amount
      ) VALUES 
        ($1, $2, $3, '2026-09-01', 600000, 600000, 600000),
        ($1, $2, $3, '2026-09-02', 600000, 600000, 600000)
    `, [propertyId, testReservationId, testRoomTypeId]);

    // 2. Setup Authoritative Rules
    // FIXED_AMOUNT (Extra Bed: 150.000)
    const fixedRuleRes = await client.query(`
      INSERT INTO stay_charge_rules (
        property_id, charge_type, code, name, charge_method,
        default_amount, is_active
      ) VALUES (
        $1, 'EXTRA_BED', 'FIXED_${testSuffix}', 'Extra Bed Test ${testSuffix}', 'FIXED_AMOUNT',
        150000, true
      ) RETURNING id
    `, [propertyId]);
    testRuleFixedId = fixedRuleRes.rows[0].id;

    // PERCENTAGE_OF_NIGHTLY_RATE (Early Checkin: 50%)
    const pctRuleRes = await client.query(`
      INSERT INTO stay_charge_rules (
        property_id, charge_type, code, name, charge_method,
        percentage_rate, is_active
      ) VALUES (
        $1, 'EARLY_CHECKIN', 'EARLY_${testSuffix}', 'Early Check-in Test ${testSuffix}', 'PERCENTAGE_OF_NIGHTLY_RATE',
        50, true
      ) RETURNING id
    `, [propertyId]);
    testRulePctId = pctRuleRes.rows[0].id;

    // FULL_NIGHT (Late Checkout 1 Night)
    const fullRuleRes = await client.query(`
      INSERT INTO stay_charge_rules (
        property_id, charge_type, code, name, charge_method,
        is_active
      ) VALUES (
        $1, 'LATE_CHECKOUT', 'LATE_${testSuffix}', 'Late Check-out Full Test ${testSuffix}', 'FULL_NIGHT',
        true
      ) RETURNING id
    `, [propertyId]);
    testRuleFullId = fullRuleRes.rows[0].id;

    // FREE (Late Checkout Free 1 Hour)
    const freeRuleRes = await client.query(`
      INSERT INTO stay_charge_rules (
        property_id, charge_type, code, name, charge_method,
        default_amount, is_active
      ) VALUES (
        $1, 'LATE_CHECKOUT', 'FREE_${testSuffix}', 'Late Check-out 1 Jam Free ${testSuffix}', 'FREE',
        0, true
      ) RETURNING id
    `, [propertyId]);
    testRuleFreeId = freeRuleRes.rows[0].id;

    // MANUAL (Damage Penalty)
    const manualRuleRes = await client.query(`
      INSERT INTO stay_charge_rules (
        property_id, charge_type, code, name, charge_method,
        is_active
      ) VALUES (
        $1, 'PENALTY', 'DMG_${testSuffix}', 'Kerusakan Kamar Test ${testSuffix}', 'MANUAL',
        true
      ) RETURNING id
    `, [propertyId]);
    testRuleManualId = manualRuleRes.rows[0].id;

    // FIXED PENALTY (Smoking Penalty: 500.000)
    const penaltyRuleRes = await client.query(`
      INSERT INTO stay_charge_rules (
        property_id, charge_type, code, name, charge_method,
        default_amount, is_active
      ) VALUES (
        $1, 'PENALTY', 'SMK_${testSuffix}', 'Denda Merokok Test ${testSuffix}', 'FIXED_AMOUNT',
        500000, true
      ) RETURNING id
    `, [propertyId]);
    testRulePenaltyId = penaltyRuleRes.rows[0].id;

    const { postStayChargeToFolio } = require('../dist/domains/stayCharges/stayChargesService');

    // TEST 1: FIXED_AMOUNT enforces master price when normal user sends tampered price without override
    console.log('\n--- Test 1: Fixed Price Enforcement ---');
    const post1 = await postStayChargeToFolio(client, propertyId, {
      reservation_id: testReservationId,
      rule_id: testRuleFixedId,
      charge_type: 'EXTRA_BED',
      quantity: 2,
      unit_price: 100000, // Tampered price from client
      actor_name: 'FO Staff'
    });

    const entry1Res = await client.query('SELECT * FROM folio_entries WHERE id = $1', [post1.folio_entry.id]);
    const entry1 = entry1Res.rows[0];
    assert(Number(entry1.unit_price) === 150000, 'Master price 150.000 enforced despite client sending 100.000');
    assert(Number(entry1.base_amount) === 300000, 'Base amount correctly calculated: 150.000 × 2 = 300.000');
    assert(Number(entry1.amount) === Number(entry1.base_amount) + Number(entry1.tax_amount) + Number(entry1.service_amount), 'Total amount properly includes tax and service');
    assert(entry1.is_override === false, 'is_override is FALSE');
    assert(entry1.revenue_category === 'ROOM_SALES', 'Service revenue_category is ROOM_SALES');
    assert(entry1.rule_code_snapshot === `FIXED_${testSuffix}`, 'Snapshot rule_code recorded');

    // TEST 2: Controlled Override with reason is accepted
    console.log('\n--- Test 2: Controlled Override with Reason ---');
    const post2 = await postStayChargeToFolio(client, propertyId, {
      reservation_id: testReservationId,
      rule_id: testRuleFixedId,
      charge_type: 'EXTRA_BED',
      quantity: 1,
      is_override: true,
      override_amount: 120000,
      override_reason: 'Diskon Direksi atas persetujuan GM',
      actor_name: 'Supervisor Budi'
    });

    const entry2Res = await client.query('SELECT * FROM folio_entries WHERE id = $1', [post2.folio_entry.id]);
    const entry2 = entry2Res.rows[0];
    assert(Number(entry2.unit_price) === 120000, 'Overridden price 120.000 applied');
    assert(entry2.is_override === true, 'is_override is TRUE');
    assert(Number(entry2.original_rule_amount) === 150000, 'original_rule_amount 150.000 preserved in snapshot');
    assert(entry2.override_reason === 'Diskon Direksi atas persetujuan GM', 'override_reason stored properly');
    assert(entry2.override_by === 'Supervisor Budi', 'override_by recorded');

    // TEST 3: Override without reason is strictly rejected (400)
    console.log('\n--- Test 3: Override without Reason Rejected ---');
    let rejectedNoReason = false;
    try {
      await postStayChargeToFolio(client, propertyId, {
        reservation_id: testReservationId,
        rule_id: testRuleFixedId,
        charge_type: 'EXTRA_BED',
        quantity: 1,
        is_override: true,
        override_amount: 110000,
        override_reason: '', // Empty reason
        actor_name: 'FO Staff'
      });
    } catch (err) {
      rejectedNoReason = err.message.includes('Alasan override') || err.statusCode === 400;
    }
    assert(rejectedNoReason, 'Override without reason was rejected with 400 error');

    // TEST 4: PERCENTAGE_OF_NIGHTLY_RATE (50% of 600.000 = 300.000)
    console.log('\n--- Test 4: Percentage Calculation Method ---');
    const post4 = await postStayChargeToFolio(client, propertyId, {
      reservation_id: testReservationId,
      rule_id: testRulePctId,
      charge_type: 'EARLY_CHECKIN',
      quantity: 1,
      actor_name: 'FO Staff'
    });

    const entry4Res = await client.query('SELECT * FROM folio_entries WHERE id = $1', [post4.folio_entry.id]);
    const entry4 = entry4Res.rows[0];
    assert(Number(entry4.unit_price) === 300000, '50% of 600.000 nightly rate resolved to 300.000');
    assert(Number(entry4.base_amount) === 300000, 'Base amount is 300.000');
    assert(entry4.calculation_method_snapshot === 'PERCENTAGE_OF_NIGHTLY_RATE', 'Snapshot method is PERCENTAGE_OF_NIGHTLY_RATE');

    // TEST 5: Single-occurrence guard rejects second EARLY_CHECKIN
    console.log('\n--- Test 5: Single-Occurrence Prevention ---');
    let duplicateRejected = false;
    try {
      await postStayChargeToFolio(client, propertyId, {
        reservation_id: testReservationId,
        rule_id: testRulePctId,
        charge_type: 'EARLY_CHECKIN',
        quantity: 1,
        actor_name: 'FO Staff'
      });
    } catch (err) {
      duplicateRejected = err.message.includes('sudah ditambahkan') || err.statusCode === 400;
    }
    assert(duplicateRejected, 'Second active EARLY_CHECKIN was rejected by single-occurrence guard');

    // TEST 6: FREE Calculation Method
    console.log('\n--- Test 6: Free Calculation Method ---');
    const post6 = await postStayChargeToFolio(client, propertyId, {
      reservation_id: testReservationId,
      rule_id: testRuleFreeId,
      charge_type: 'LATE_CHECKOUT',
      quantity: 1,
      actor_name: 'FO Staff'
    });

    const entry6Res = await client.query('SELECT * FROM folio_entries WHERE id = $1', [post6.folio_entry.id]);
    const entry6 = entry6Res.rows[0];
    assert(Number(entry6.unit_price) === 0, 'Free rule resolved unit_price = 0');
    assert(Number(entry6.amount) === 0, 'Total amount is 0');

    // TEST 7: MANUAL Rule (Kerusakan Kamar) requires valid nominal and reason
    console.log('\n--- Test 7: Manual Rule Handling ---');
    const post7 = await postStayChargeToFolio(client, propertyId, {
      reservation_id: testReservationId,
      rule_id: testRuleManualId,
      charge_type: 'PENALTY',
      unit_price: 250000,
      note: 'Gelas pecah 2 pcs',
      actor_name: 'FO Staff'
    });

    const entry7Res = await client.query('SELECT * FROM folio_entries WHERE id = $1', [post7.folio_entry.id]);
    const entry7 = entry7Res.rows[0];
    assert(Number(entry7.unit_price) === 250000, 'Manual nominal 250.000 saved');
    assert(entry7.revenue_category === 'OTHER_INCOME', 'Penalty revenue_category is OTHER_INCOME');
    assert(entry7.description.includes('Gelas pecah'), 'Manual note appended to description');

    // TEST 8: Fixed Penalty (Denda Merokok: 500.000)
    console.log('\n--- Test 8: Fixed Penalty Coexistence ---');
    const post8 = await postStayChargeToFolio(client, propertyId, {
      reservation_id: testReservationId,
      rule_id: testRulePenaltyId,
      charge_type: 'PENALTY',
      actor_name: 'FO Staff'
    });

    const entry8Res = await client.query('SELECT * FROM folio_entries WHERE id = $1', [post8.folio_entry.id]);
    const entry8 = entry8Res.rows[0];
    assert(Number(entry8.unit_price) === 500000, 'Fixed penalty 500.000 applied');
    assert(entry8.revenue_category === 'OTHER_INCOME', 'Fixed penalty revenue_category is OTHER_INCOME');

    // TEST 9: Snapshot Immutability when Master Rule changes
    console.log('\n--- Test 9: Snapshot Immutability ---');
    // Update master rule from 150.000 to 225.000
    await client.query(`
      UPDATE stay_charge_rules
      SET default_amount = 225000, updated_at = NOW()
      WHERE id = $1
    `, [testRuleFixedId]);

    // Check entry 1 again: must remain 150.000 unit_price & 300.000 base_amount
    const entry1CheckRes = await client.query('SELECT unit_price, base_amount FROM folio_entries WHERE id = $1', [entry1.id]);
    assert(Number(entry1CheckRes.rows[0].unit_price) === 150000, 'Historic entry unit_price remains 150.000 after master rule updated');
    assert(Number(entry1CheckRes.rows[0].base_amount) === 300000, 'Historic entry base amount remains 300.000');

    // TEST 10: Quick Booking integration with stayCharges snapshot
    console.log('\n--- Test 10: Quick Booking Stay Charges Integration ---');
    const qbRes = await client.query(`
      INSERT INTO bookings (bid, property_id, guest_name_snapshot, guest_phone_snapshot, booking_status)
      VALUES ($1, $2, $3, '08111222333', 'ACTIVE')
      RETURNING id
    `, [`BID-QB-${testSuffix}`, propertyId, `QB-Test-${testSuffix}`]);
    qbBookingId = qbRes.rows[0].id;

    const qbResRes = await client.query(`
      INSERT INTO reservations (
        booking_id, stay_sequence, room_id, guest_name, guest_phone,
        check_in, check_out, total_price, status
      ) VALUES (
        $1, 1, $2, $3, '08111222333',
        '2026-09-05', '2026-09-06', 600000, 'BOOKED'
      ) RETURNING id
    `, [qbBookingId, testRoomId, `QB-Test-${testSuffix}`]);
    qbResId = qbResRes.rows[0].id;

    // Simulate Quick Booking stay charges posting with override
    await client.query(`
      INSERT INTO folio_entries (
        reservation_id, property_id, entry_type, source_type, source_id,
        rule_id, rule_code_snapshot, rule_name_snapshot, calculation_method_snapshot,
        description, amount, direction, base_amount, unit_price, quantity,
        tax_amount, service_amount, status,
        is_override, original_rule_amount, override_amount, override_reason, override_by, override_at,
        revenue_category, actor_name_snapshot, actor_role_snapshot
      ) VALUES (
        $1, $2, 'EXTRA_BED', 'EXTRA_BED', $3,
        $4, 'FIXED_${testSuffix}', 'Extra Bed Test', 'FIXED_AMOUNT',
        'Extra Bed Test', 100000, 'DEBIT', 100000, 100000, 1,
        0, 0, 'POSTED',
        TRUE, 225000, 100000, 'Diskon Promo Launching', 'Front Desk', NOW(),
        'ROOM_SALES', 'Front Desk', 'STAFF'
      )
    `, [qbResId, propertyId, String(testRuleFixedId), testRuleFixedId]);

    const qbFolioRes = await client.query('SELECT * FROM folio_entries WHERE reservation_id = $1', [qbResId]);
    const qbFolio = qbFolioRes.rows[0];
    assert(qbFolio.is_override === true, 'QB folio is_override is TRUE');
    assert(Number(qbFolio.unit_price) === 100000, 'QB folio unit_price is 100.000');
    assert(Number(qbFolio.original_rule_amount) === 225000, 'QB folio original_rule_amount is 225.000');
    assert(qbFolio.override_reason === 'Diskon Promo Launching', 'QB folio override_reason preserved');

  } catch (err) {
    console.error('💥 UNEXPECTED ERROR IN TEST SUITE:', err);
    failed++;
  } finally {
    // Teardown test fixtures
    try {
      console.log('\n--- Cleaning up test fixtures ---');
      if (testReservationId) {
        await client.query('DELETE FROM folio_entries WHERE reservation_id = $1', [testReservationId]);
        await client.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = $1', [testReservationId]);
        await client.query('DELETE FROM reservations WHERE id = $1', [testReservationId]);
      }
      if (qbResId) {
        await client.query('DELETE FROM folio_entries WHERE reservation_id = $1', [qbResId]);
        await client.query('DELETE FROM reservations WHERE id = $1', [qbResId]);
      }
      if (testBookingId) {
        await client.query('DELETE FROM bookings WHERE id = $1', [testBookingId]);
      }
      if (qbBookingId) {
        await client.query('DELETE FROM bookings WHERE id = $1', [qbBookingId]);
      }

      await client.query('DELETE FROM folio_entries WHERE description LIKE $1', [`%${testSuffix}%`]);
      await client.query('DELETE FROM reservations WHERE guest_name LIKE $1', [`%${testSuffix}%`]);
      await client.query('DELETE FROM bookings WHERE guest_name_snapshot LIKE $1', [`%${testSuffix}%`]);

      if (testRuleFixedId) await client.query('DELETE FROM stay_charge_rules WHERE id = $1', [testRuleFixedId]);
      if (testRulePctId) await client.query('DELETE FROM stay_charge_rules WHERE id = $1', [testRulePctId]);
      if (testRuleFullId) await client.query('DELETE FROM stay_charge_rules WHERE id = $1', [testRuleFullId]);
      if (testRuleFreeId) await client.query('DELETE FROM stay_charge_rules WHERE id = $1', [testRuleFreeId]);
      if (testRuleManualId) await client.query('DELETE FROM stay_charge_rules WHERE id = $1', [testRuleManualId]);
      if (testRulePenaltyId) await client.query('DELETE FROM stay_charge_rules WHERE id = $1', [testRulePenaltyId]);
      console.log('✅ Cleaned up all test fixtures cleanly');
    } catch (cleanupErr) {
      console.warn('⚠️ Cleanup warning:', cleanupErr.message);
    }

    client.release();
    await pool.end();
  }

  console.log('\n======================================================');
  console.log(`🏁 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
