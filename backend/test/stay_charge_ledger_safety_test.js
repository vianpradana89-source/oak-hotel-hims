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
  console.log('--- STARTING STAY CHARGE FINANCIAL LEDGER SAFETY AUDIT & VOID/REVERSAL TEST (STAY-CHARGE-1A) ---');
  const client = await pool.connect();

  const cleanupIds = {
    propertyId: 1,
    otherPropertyId: 2,
    roomTypeId: null,
    roomId: null,
    ruleIds: [],
    bookingIds: [],
    reservationIds: []
  };

  try {
    // 0. Ensure schema is migrated
    const { initializeDatabase } = require('../dist/db/schema_v3');
    await initializeDatabase(pool);

    console.log('1. Setting up test fixtures & isolating room...');
    // Pre-cleanup in case previous run aborted
    await client.query(`
      DELETE FROM reservation_nightly_rates WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id IN (SELECT id FROM rooms WHERE room_number = '889-SAFETY'));
      DELETE FROM folio_entries WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id IN (SELECT id FROM rooms WHERE room_number = '889-SAFETY'));
      DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id IN (SELECT id FROM rooms WHERE room_number = '889-SAFETY'));
      DELETE FROM housekeeping_tasks WHERE room_id IN (SELECT id FROM rooms WHERE room_number = '889-SAFETY');
      DELETE FROM reservations WHERE room_id IN (SELECT id FROM rooms WHERE room_number = '889-SAFETY');
      DELETE FROM bookings WHERE guest_name_snapshot LIKE 'Safety Audit Guest%';
      DELETE FROM stay_charge_rules WHERE code LIKE 'SAFETY_%';
      DELETE FROM rooms WHERE room_number = '889-SAFETY';
      DELETE FROM availability_dates WHERE room_type_id IN (SELECT id FROM room_types WHERE code = 'TST-SAFETY-DLX');
      DELETE FROM room_types WHERE code = 'TST-SAFETY-DLX';
    `);

    // Create dedicated room type
    const rtRes = await client.query(
      `INSERT INTO room_types (property_id, code, name, base_rate, is_active)
       VALUES (1, 'TST-SAFETY-DLX', 'Test Safety Deluxe Room', 600000, true)
       RETURNING id`
    );
    cleanupIds.roomTypeId = rtRes.rows[0].id;

    // Create physical room
    const rmRes = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES (1, $1, '889-SAFETY', 'Test Safety Room 889', 'Tersedia', true)
       RETURNING id`,
      [cleanupIds.roomTypeId]
    );
    cleanupIds.roomId = rmRes.rows[0].id;

    // Seed availability dates
    await client.query(
      `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
       VALUES 
         ($1, 'TST-SAFETY-DLX', '2026-11-25', 1, 0),
         ($1, 'TST-SAFETY-DLX', '2026-11-26', 1, 0)`,
      [cleanupIds.roomTypeId]
    );

    // Create a custom stay charge rule
    const {
      createStayChargeRule,
      postStayChargeToFolio,
      voidFolioEntry,
      correctFolioEntry,
      recalculateReservationFinancials
    } = require('../dist/domains/stayCharges/stayChargesService');

    const createdRule = await createStayChargeRule(pool, 1, {
      charge_type: 'EXTRA_BED',
      code: 'SAFETY_EXTRA_BED',
      name: 'Safety Extra Bed Set',
      description: 'Extra bed set for safety ledger audit',
      charge_method: 'FIXED_AMOUNT',
      default_amount: 200000,
      taxable: true,
      service_chargeable: true,
      requires_note: false,
      requires_photo: false,
      requires_supervisor_approval: false,
      approval_threshold: 0,
      is_active: true,
      sort_order: 1
    });
    cleanupIds.ruleIds.push(createdRule.id);

    // Bootstrap Express App
    const { app } = require('../dist/index');
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 2. Create standard booking fixture
      console.log('2. Creating base reservation fixture...');
      const bookingRes = await fetch(`${baseUrl}/api/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: 1,
          guest_name: 'Safety Audit Guest 1',
          guest_phone: '081299990001',
          reservations: [{
            room_id: cleanupIds.roomId,
            guest_name: 'Safety Audit Guest 1',
            guest_phone: '081299990001',
            check_in: '2026-11-25',
            check_out: '2026-11-27',
            stay_type: 'OVERNIGHT',
            subtotal_amount: 1200000,
            total_price: 1200000,
            payment_status: 'UNPAID',
            amount_paid: 0
          }]
        })
      });

      assert.strictEqual(bookingRes.status, 201, 'Booking creation should return 201');
      const bookingData = await bookingRes.json();
      const bookingId = bookingData.data.booking_id || bookingData.data.booking?.id;
      cleanupIds.bookingIds.push(bookingId);
      const resId = bookingData.data.reservations[0].id;
      cleanupIds.reservationIds.push(resId);
      console.log(`   ✓ Reservation #${resId} created with total_price = 1,200,000`);

      // 3. Test Stay Charge Posting & Financial Recalculation
      console.log('3. Testing Folio Charge Posting & Base/Tax/Service Snapshots...');
      const postChargeRes = await fetch(`${baseUrl}/api/stay-charges/post-charge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: 1,
          reservation_id: resId,
          charge_type: 'EXTRA_BED',
          rule_id: createdRule.id,
          quantity: 2,
          note: 'Extra bed requested for children'
        })
      });

      assert.strictEqual(postChargeRes.status, 201, 'Charge posting should return 201');
      const postChargeData = await postChargeRes.json();
      const postedEntry = postChargeData.data.folio_entry;

      // Base: 200,000 * 2 = 400,000. Tax: 10% = 40,000. Service: 5% = 20,000. Total = 460,000
      assert.strictEqual(postedEntry.entry_type, 'EXTRA_BED');
      assert.strictEqual(postedEntry.direction, 'DEBIT');
      assert.strictEqual(postedEntry.status, 'POSTED');
      assert.strictEqual(Number(postedEntry.base_amount), 400000);
      assert.strictEqual(Number(postedEntry.tax_amount), 40000);
      assert.strictEqual(Number(postedEntry.service_amount), 20000);
      assert.strictEqual(Number(postedEntry.amount), 460000);
      assert.strictEqual(postedEntry.is_voided, false);

      // Verify reservation total price updated
      const resAfterCharge = await client.query('SELECT total_price, remaining_balance, payment_status FROM reservations WHERE id = $1', [resId]);
      assert.strictEqual(Number(resAfterCharge.rows[0].total_price), 1660000, 'Total price must reflect room rate (1.2M) + extra bed debit (460k)');
      assert.strictEqual(Number(resAfterCharge.rows[0].remaining_balance), 1660000);
      assert.strictEqual(resAfterCharge.rows[0].payment_status, 'UNPAID');
      console.log('   ✓ Folio entry posted with exact base, tax, service snapshots and reservation recalculated');

      // 4. Test Immutable Voiding (Part B: Reversal Entry + Net Zero)
      console.log('4. Testing Immutable Voiding (Net Zero Reversal Entry & Original Row Preservation)...');
      const voidRes = await fetch(`${baseUrl}/api/stay-charges/void-entry/${postedEntry.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: 1,
          reservation_id: resId,
          reason: 'Guest cancelled extra bed before setup',
          actor_name: 'Supervisor Sarah',
          actor_role: 'SUPERVISOR'
        })
      });

      assert.strictEqual(voidRes.status, 200, 'Voiding should return 200');
      const voidData = await voidRes.json();
      assert.strictEqual(voidData.status, 'SUCCESS');
      const voidResult = voidData.data;

      // Check original entry in database: must NOT be deleted or set to amount 0
      const origInDb = await client.query('SELECT * FROM folio_entries WHERE id = $1', [postedEntry.id]);
      assert.strictEqual(origInDb.rowCount, 1, 'Original entry must remain in DB');
      assert.strictEqual(origInDb.rows[0].is_voided, true);
      assert.strictEqual(origInDb.rows[0].status, 'VOIDED');
      assert.strictEqual(Number(origInDb.rows[0].amount), 460000, 'Original amount must NEVER be mutated to 0');
      assert.strictEqual(origInDb.rows[0].void_reason, 'Guest cancelled extra bed before setup');

      // Check compensating reversal entry in database
      const revInDb = await client.query('SELECT * FROM folio_entries WHERE reversal_of_entry_id = $1', [postedEntry.id]);
      assert.strictEqual(revInDb.rowCount, 1, 'Reversal entry must exist and link to original');
      const revEntry = revInDb.rows[0];
      assert.strictEqual(revEntry.entry_type, 'REVERSAL');
      assert.strictEqual(revEntry.direction, 'CREDIT', 'Reversal of DEBIT must be CREDIT');
      assert.strictEqual(Number(revEntry.amount), 460000, 'Reversal amount must match original');
      assert.strictEqual(Number(revEntry.tax_amount), 40000, 'Reversal tax must snapshot original');
      assert.strictEqual(Number(revEntry.service_amount), 20000, 'Reversal service charge must snapshot original');
      assert.strictEqual(revEntry.status, 'REVERSED');
      assert.strictEqual(Number(revEntry.reversal_of_entry_id), postedEntry.id);

      // Verify net zero calculation on reservation
      const resAfterVoid = await client.query('SELECT total_price, remaining_balance, payment_status FROM reservations WHERE id = $1', [resId]);
      assert.strictEqual(Number(resAfterVoid.rows[0].total_price), 1200000, 'Net charges must revert to room stay total (1.2M) after extra bed reversal');
      assert.strictEqual(Number(resAfterVoid.rows[0].remaining_balance), 1200000);
      assert.strictEqual(resAfterVoid.rows[0].payment_status, 'UNPAID');
      console.log('   ✓ Immutable void verified: Original DEBIT (460k) + Reversal CREDIT (460k) = Net Zero effect on stay charges');

      // 5. Test Double-Void Rejection (409 Conflict)
      console.log('5. Testing Double-Void rejection (409 Conflict)...');
      const doubleVoidRes = await fetch(`${baseUrl}/api/stay-charges/void-entry/${postedEntry.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: 1,
          reservation_id: resId,
          reason: 'Double void attempt'
        })
      });
      assert.strictEqual(doubleVoidRes.status, 409, 'Double-voiding must return 409 Conflict');
      console.log('   ✓ Double-void attempt rejected with 409 Conflict');

      // 6. Test Folio Entry Correction (Part C: Original + Reversal + Replacement)
      console.log('6. Testing Folio Entry Correction Lifecycle (Original + Reversal + Replacement)...');
      // Post a damage charge: 500,000 base + 50,000 tax + 25,000 service = 575,000 total
      const postDamageRes = await fetch(`${baseUrl}/api/stay-charges/post-charge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: 1,
          reservation_id: resId,
          charge_type: 'PENALTY',
          custom_description: 'Kerusakan Lampu Tidur',
          unit_price: 500000,
          quantity: 1,
          note: 'Lampu tidur pecah'
        })
      });
      assert.strictEqual(postDamageRes.status, 201);
      const damageData = await postDamageRes.json();
      const damageEntry = damageData.data.folio_entry;
      assert.strictEqual(Number(damageEntry.amount), 575000);

      // Perform correction: adjust price down to 300,000 (Subtotal: 300k, Tax: 30k, Service: 15k, Total: 345k)
      const correctRes = await fetch(`${baseUrl}/api/stay-charges/correct-entry/${damageEntry.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: 1,
          reservation_id: resId,
          reason: 'Koreksi harga penggantian lampu setelah negosiasi',
          unit_price: 300000,
          quantity: 1,
          custom_description: 'Kerusakan Lampu Tidur (Harga Negosiasi)',
          actor_name: 'Manager Hendra',
          actor_role: 'MANAGER'
        })
      });

      assert.strictEqual(correctRes.status, 200, 'Correction endpoint must return 200');
      const correctData = await correctRes.json();
      assert.strictEqual(correctData.status, 'SUCCESS');

      // Inspect DB for the correction triad
      const origDamage = await client.query('SELECT * FROM folio_entries WHERE id = $1', [damageEntry.id]);
      assert.strictEqual(origDamage.rows[0].status, 'CORRECTED');
      assert.strictEqual(origDamage.rows[0].is_voided, true);

      const correctionEntries = await client.query(
        'SELECT * FROM folio_entries WHERE reversal_of_entry_id = $1 ORDER BY id ASC',
        [damageEntry.id]
      );
      assert.strictEqual(correctionEntries.rowCount, 2, 'Correction must create Reversal + Replacement entries');

      const corrReversal = correctionEntries.rows.find(e => e.entry_type === 'REVERSAL');
      const corrReplacement = correctionEntries.rows.find(e => e.entry_type !== 'REVERSAL');

      assert(corrReversal, 'Reversal entry must exist in correction triad');
      assert.strictEqual(corrReversal.direction, 'CREDIT');
      assert.strictEqual(Number(corrReversal.amount), 575000);
      assert.strictEqual(corrReversal.status, 'REVERSED');
      assert(corrReversal.correction_group_id, 'Reversal must have correction_group_id');

      assert(corrReplacement, 'Replacement entry must exist in correction triad');
      assert.strictEqual(corrReplacement.direction, 'DEBIT');
      assert.strictEqual(Number(corrReplacement.amount), 345000);
      assert.strictEqual(corrReplacement.status, 'POSTED');
      assert.strictEqual(corrReplacement.correction_group_id, corrReversal.correction_group_id, 'Group ID must match');

      // Verify reservation net total equals room rate (1.2M) + replacement amount (345k) = 1,545,000
      const resAfterCorr = await client.query('SELECT total_price, remaining_balance FROM reservations WHERE id = $1', [resId]);
      assert.strictEqual(Number(resAfterCorr.rows[0].total_price), 1545000, 'Reservation total must equal room rate + corrected replacement amount');
      console.log('   ✓ Correction lifecycle verified: Room (1.2M) + Original (575k) + Reversal Credit (575k) + Replacement Debit (345k) = Net 1.545M');

      // 7. Test Cross-Property Access Prevention (403 Forbidden)
      console.log('7. Testing Cross-Property Security Guardrail (403 Forbidden)...');
      const crossPropVoidRes = await fetch(`${baseUrl}/api/stay-charges/void-entry/${corrReplacement.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: 999, // Mismatched property
          reservation_id: resId,
          reason: 'Cross property attempt'
        })
      });
      assert.strictEqual(crossPropVoidRes.status, 403, 'Cross-property void must return 403 Forbidden');
      console.log('   ✓ Cross-property access prevented with 403 Forbidden');

      // 8. Test Validation Guardrails
      console.log('8. Testing Input Validation Guardrails (Negative Price, Missing Reason, Void Reversal)...');
      // Empty reason
      const emptyReasonRes = await fetch(`${baseUrl}/api/stay-charges/void-entry/${corrReplacement.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: 1,
          reservation_id: resId,
          reason: '   '
        })
      });
      assert.strictEqual(emptyReasonRes.status, 400, 'Empty reason must return 400 Bad Request');

      // Attempt to void a REVERSAL row
      const voidRevRes = await fetch(`${baseUrl}/api/stay-charges/void-entry/${corrReversal.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: 1,
          reservation_id: resId,
          reason: 'Attempting to void reversal'
        })
      });
      assert([400, 409].includes(voidRevRes.status), 'Voiding a reversal row must return 400 or 409');

      // Negative unit price
      const negPriceRes = await fetch(`${baseUrl}/api/stay-charges/correct-entry/${corrReplacement.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: 1,
          reservation_id: resId,
          reason: 'Negative price test',
          unit_price: -50000
        })
      });
      assert.strictEqual(negPriceRes.status, 400, 'Negative unit price must return 400 Bad Request');
      console.log('   ✓ All input validation guardrails enforced');

      // 9. Test Audit Trail Integrity
      console.log('9. Verifying Audit Log Trail...');
      const auditLogs = await client.query(
        `SELECT action, entity, record_id FROM audit_logs
         WHERE property_id = 1 AND module = 'STAY_CHARGE' AND record_id = $1
         ORDER BY timestamp DESC`,
        [String(resId)]
      );
      assert(auditLogs.rows.length >= 3, 'Audit logs must capture post, void, and correction events');
      const actions = auditLogs.rows.map(r => r.action);
      assert(actions.includes('FOLIO_ENTRY_VOIDED'), 'FOLIO_ENTRY_VOIDED audit log must exist');
      assert(actions.includes('FOLIO_ENTRY_CORRECTED'), 'FOLIO_ENTRY_CORRECTED audit log must exist');
      console.log('   ✓ Audit logs verified for all financial mutations');

    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    console.log('\n>>> ALL FINANCIAL LEDGER SAFETY & VOID/REVERSAL AUDIT TESTS PASSED (9/9) <<<');
  } finally {
    console.log('\n--- CLEANING UP TEST FIXTURES & ISOLATING ROOM ---');
    try {
      if (cleanupIds.roomId) {
        await client.query('DELETE FROM reservation_nightly_rates WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id = $1)', [cleanupIds.roomId]);
        await client.query('DELETE FROM folio_entries WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id = $1)', [cleanupIds.roomId]);
        await client.query('DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id = $1)', [cleanupIds.roomId]);
        await client.query('DELETE FROM housekeeping_tasks WHERE room_id = $1', [cleanupIds.roomId]);
        await client.query('DELETE FROM reservations WHERE room_id = $1', [cleanupIds.roomId]);
      }
      if (cleanupIds.reservationIds.length > 0) {
        await client.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1::int[])', [cleanupIds.reservationIds]);
        await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [cleanupIds.reservationIds]);
        await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [cleanupIds.reservationIds]);
        await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [cleanupIds.reservationIds]);
      }
      if (cleanupIds.bookingIds.length > 0) {
        await client.query('DELETE FROM bookings WHERE id = ANY($1::int[])', [cleanupIds.bookingIds]);
      }
      if (cleanupIds.ruleIds.length > 0) {
        await client.query('DELETE FROM stay_charge_rules WHERE id = ANY($1::int[])', [cleanupIds.ruleIds]);
      }
      if (cleanupIds.roomId) {
        await client.query('DELETE FROM rooms WHERE id = $1', [cleanupIds.roomId]);
      }
      if (cleanupIds.roomTypeId) {
        await client.query('DELETE FROM availability_dates WHERE room_type_id = $1', [cleanupIds.roomTypeId]);
        await client.query('DELETE FROM room_types WHERE id = $1', [cleanupIds.roomTypeId]);
      }
      console.log('Cleaned up all test fixtures. Zero session residue.');
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
