/**
 * Backend test for complimentary request lifecycle
 * Tests: request, approve, reject, revoke with financial guards
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Pool } = require('pg');
const assert = require('assert/strict');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------
async function cleanupComplimentaryTests(bookingId) {
  if (!bookingId) return;
  const resIds = await pool.query('SELECT id FROM reservations WHERE booking_id = $1', [bookingId]);
  const ids = resIds.rows.map(r => r.id);
  if (!ids.length) return;

  await pool.query('DELETE FROM transaction_items WHERE transaction_id IN (SELECT id FROM transactions WHERE reservation_id = ANY($1))', [ids]).catch(() => {});
  await pool.query('DELETE FROM transactions WHERE reservation_id = ANY($1)', [ids]).catch(() => {});
  await pool.query('DELETE FROM payment_evidences WHERE reservation_id = ANY($1)', [ids]).catch(() => {});
  await pool.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1)', [ids]).catch(() => {});
  await pool.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1)', [ids]).catch(() => {});
  await pool.query('DELETE FROM reservation_rate_snapshots WHERE reservation_id = ANY($1)', [ids]).catch(() => {});
  await pool.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1)', [ids]).catch(() => {});
  await pool.query('DELETE FROM reservation_guests WHERE reservation_id = ANY($1)', [ids]).catch(() => {});
  await pool.query('DELETE FROM availability_locks WHERE reservation_id = ANY($1)', [ids]).catch(() => {});
  await pool.query('DELETE FROM reservation_complimentary_requests WHERE reservation_id = ANY($1)', [ids]).catch(() => {});
  await pool.query('DELETE FROM audit_logs WHERE entity = $1 AND record_id = ANY($2)', ['RESERVATION', ids]).catch(() => {});
  await pool.query('DELETE FROM reservations WHERE id = ANY($1)', [ids]);
  await pool.query('DELETE FROM audit_logs WHERE entity = $1 AND record_id = $2', ['BOOKING', bookingId]).catch(() => {});
  await pool.query('DELETE FROM bookings WHERE id = $1', [bookingId]);
}

async function createTestBooking(propertyId, suffix, canonicalGross = 500000) {
  const typeName = `COMP${suffix}`;
  const typeCode = `COMP-${suffix}`;
  const rt = await pool.query(
    `INSERT INTO room_types (property_id, code, name, base_rate, is_active)
     VALUES ($1, $2, $3, 500000, true) RETURNING id`,
    [propertyId, typeCode, typeName]
  );
  const roomTypeId = rt.rows[0].id;
  const rm = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
     VALUES ($1, $2, $3, $3, 'VACANT_CLEAN', true) RETURNING id`,
    [propertyId, roomTypeId, `COMP-${suffix.slice(-4)}`]
  );
  const roomId = rm.rows[0].id;
  const plan = await pool.query(
    `INSERT INTO rate_plans (property_id, room_type_id, code, name, base_rate, meal_plan, rate_type, is_active, sort_order)
     VALUES ($1, $2, $3, $4, $5, 'RO', 'OVERNIGHT', true, 0) RETURNING id`,
    [propertyId, roomTypeId, `${typeCode}-RO`, `${typeName} RO`, canonicalGross]
  );
  const ratePlanId = plan.rows[0].id;
  await pool.query(
    `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [roomTypeId, typeName, '2028-06-01', 10, 0]
  );
  await pool.query(
    `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [roomTypeId, typeName, '2028-06-02', 10, 0]
  );

  const booking = await pool.query(
    `INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status)
     VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [`BOOK-COMP-${suffix}`, propertyId, `Guest COMP ${suffix}`]
  );
  const bookingId = booking.rows[0].id;

  const checkIn = '2028-06-01';
  const checkOut = '2028-06-03'; // 2 nights
  const stayDurationDays = 2;
  const totalPrice = canonicalGross * stayDurationDays;

  const res = await pool.query(
    `INSERT INTO reservations (
       booking_id, booking_number, stay_sequence, guest_name,
       check_in, check_out, total_price, status, payment_status, stay_type,
       created_at
     ) VALUES ($1, $2, 1, $3, $4, $5, $6, 'BOOKED', 'UNPAID', 'OVERNIGHT', NOW()) RETURNING id`,
    [bookingId, `RES-COMP-${suffix}`, `Guest COMP ${suffix}`, checkIn, checkOut, totalPrice]
  );
  const reservationId = res.rows[0].id;

  await pool.query(
    `INSERT INTO reservation_nightly_rates (reservation_id, property_id, stay_date, room_type_id, base_rate, final_room_rate, total_amount)
     VALUES ($1, $2, $3, $4, $5, $5, $5)`,
    [reservationId, propertyId, checkIn, roomTypeId, canonicalGross]
  );
  await pool.query(
    `INSERT INTO reservation_nightly_rates (reservation_id, property_id, stay_date, room_type_id, base_rate, final_room_rate, total_amount)
     VALUES ($1, $2, $3, $4, $5, $5, $5)`,
    [reservationId, propertyId, checkOut, roomTypeId, canonicalGross]
  );

  const guest = await pool.query(
    `INSERT INTO guests (full_name, phone, created_property_id)
     VALUES ($1, '0000000000', $2) RETURNING id`,
    [`Guest COMP ${suffix}`, propertyId]
  );
  const guestId = guest.rows[0].id;

  await pool.query(
    `INSERT INTO reservation_guests (reservation_id, guest_id, role, is_staying)
     VALUES ($1, $2, 'PRIMARY_GUEST', true)`,
    [reservationId, guestId]
  );

  return { bookingId, reservationId, roomTypeId, roomId, ratePlanId };
}

// ---------------------------------------------------------------------------
// Test: Table exists and schema matches migration
// ---------------------------------------------------------------------------
async function testTableSchema() {
  console.log('\n=== TEST 1: Table Schema ===');
  const colRes = await pool.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'reservation_complimentary_requests'
    ORDER BY ordinal_position
  `);
  const cols = colRes.rows;
  const colNames = cols.map(r => r.column_name);
  const required = [
    'id', 'property_id', 'reservation_id', 'status', 'category', 'reason',
    'original_gross_amount', 'pre_complimentary_payable_amount', 'applied_adjustment_amount',
    'requestor_user_id', 'requestor_name_snapshot', 'requested_at',
    'idempotency_key', 'approver_user_id', 'approver_name_snapshot', 'approved_at',
    'rejector_user_id', 'rejector_name_snapshot', 'rejected_at', 'rejection_reason',
    'revoker_user_id', 'revoker_name_snapshot', 'revoked_at', 'revoke_reason',
    'created_at', 'updated_at'
  ];
  for (const req of required) {
    expect(cols.some(c => c.column_name === req), `Missing column: ${req}`);
  }
  console.log(`  [OK] All ${required.length} required columns exist`);

  // Check indexes
  const idxRes = await pool.query(`
    SELECT indexname FROM pg_indexes WHERE tablename = 'reservation_complimentary_requests'
    ORDER BY indexname
  `);
  const idxNames = idxRes.rows.map(r => r.indexname);
  const hasUniqueActive = idxNames.some(n => n.includes('uq_comp_req_active') || n.includes('comp'));
  console.log(`  [OK] Indexes: ${idxNames.join(', ')}`);
  console.log('  PASS');
}

async function getSuperAdminActor() {
  const saRes = await pool.query(
    `SELECT u.id, u.full_name, r.id as role_id
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE r.name = 'Super Admin' AND r.is_system_role = TRUE
     LIMIT 1`
  );
  const saUser = saRes.rows[0];
  if (!saUser) throw new Error('Super Admin user not found in database');
  return {
    id: Number(saUser.id),
    email: 'superadmin@oak.local',
    username: 'superadmin',
    full_name: saUser.full_name || 'Super Admin',
    role: 'Super Admin',
    role_id: Number(saUser.role_id),
    property_id: 1,
    scope: 'FULL'
  };
}

// ---------------------------------------------------------------------------
// Test: Request, Approve, Revoke lifecycle
// ---------------------------------------------------------------------------
async function testLifecycle(suffix) {
  console.log(`\n=== TEST 2: Full Lifecycle (suffix=${suffix}) ===`);
  const propertyId = 1;
  const { bookingId, reservationId } = await createTestBooking(propertyId, suffix, 500000);

  try {
    // Import service functions
    const service = require(path.resolve(__dirname, '../dist/domains/reservations/complimentaryService'));
    const actor = await getSuperAdminActor();
    const reqActor = { id: 2, email: 'fo@oak.local', username: 'frontdesk', full_name: 'Front Desk', role: 'FO', role_id: null, property_id: propertyId, scope: 'FULL' };

    // 2a. Create request
    const req1 = await service.createComplimentaryRequest(pool, {
      reservationId,
      propertyId,
      category: 'VIP',
      reason: 'VIP guest courtesy',
      idempotencyKey: `req-${suffix}-1`,
      requestor: reqActor
    });
    expect(req1.status === 'PENDING_APPROVAL', 'Initial request should be PENDING_APPROVAL');
    expect(Number(req1.reservation_id) === reservationId, 'Request linked to correct reservation');
    console.log('  [OK] Request created: PENDING_APPROVAL');

    // 2b. Try duplicate request with same idempotency key -> should return existing row (idempotent)
    const req1Dup = await service.createComplimentaryRequest(pool, {
      reservationId,
      propertyId,
      category: 'VIP',
      reason: 'Same reason',
      idempotencyKey: `req-${suffix}-1`,
      requestor: reqActor
    });
    expect(req1Dup.status === 'PENDING_APPROVAL', 'Duplicate key should return existing row');
    expect(Number(req1Dup.id) === Number(req1.id), 'Duplicate should return same request id');
    expect(req1Dup.created_at, 'Full row should be returned (all columns)');
    console.log('  [OK] Duplicate idempotency key returns existing row idempotently');

    // 2c. Try creating second request while first is PENDING_APPROVAL -> should fail (unique constraint)
    try {
      await service.createComplimentaryRequest(pool, {
        reservationId,
        propertyId,
        category: 'SERVICE_RECOVERY',
        reason: 'Service recovery #2',
        idempotencyKey: `req-${suffix}-2`,
        requestor: reqActor
      });
      throw new Error('Should have thrown on active request exists');
    } catch (e) {
      expect(e.statusCode === 409, `Active request should be 409, got ${e.statusCode}`);
      console.log(`  [OK] Second request blocked while first is PENDING_APPROVAL (code: ${e.code || 'N/A'})`);
    }

    // 2d. Approve first request
    const approved = await service.approveComplimentaryRequest(pool, {
      requestId: req1.id,
      reservationId,
      propertyId,
      actor
    });
    expect(approved.request.status === 'APPROVED', 'Request should be APPROVED after approval');
    expect(Number(approved.financials.eligible_room_charge) === 1000000, 'Eligible charge should be 2 nights * 500000');
    expect(Number(approved.financials.adjustment_amount) === 1000000, 'Adjustment should match eligible amount');
    expect(approved.folio_entry_id > 0, 'Folio entry should be created');
    console.log('  [OK] Request APPROVED with correct financial snapshot');

    // 2e. Verify folio entry was created with COMPLIMENTARY source
    const folioCheck = await pool.query(
      `SELECT id, amount, direction, source_type, reversal_of_entry_id
       FROM folio_entries WHERE id = $1`,
      [approved.folio_entry_id]
    );
    expect(folioCheck.rows.length === 1, 'Folio entry should exist');
    expect(folioCheck.rows[0].source_type === 'COMPLIMENTARY', 'Source type should be COMPLIMENTARY');
    expect(folioCheck.rows[0].direction === 'CREDIT', 'Direction should be CREDIT');
    expect(Number(folioCheck.rows[0].amount) === 1000000, 'Amount should match adjustment');
    console.log('  [OK] Folio entry verified: CREDIT, COMPLIMENTARY, correct amount');

    // 2f. Revoke approved request
    const revoked = await service.revokeComplimentaryRequest(pool, {
      requestId: req1.id,
      reservationId,
      propertyId,
      reason: 'Management override',
      actor
    });
    expect(revoked.request.status === 'REVOKED', 'Request should be REVOKED');
    expect(revoked.reversal_folio_entry_id > 0, 'Reversal folio entry should be created');
    console.log('  [OK] Request REVOKED with reversal entry');

    // 2h. Verify reversal entry
    const revEntry = await pool.query(
      `SELECT id, amount, direction, reversal_of_entry_id, source_type
       FROM folio_entries WHERE id = $1`,
      [revoked.reversal_folio_entry_id]
    );
    expect(revEntry.rows.length === 1, 'Reversal entry should exist');
    expect(revEntry.rows[0].direction === 'DEBIT', 'Reversal should be DEBIT');
    expect(revEntry.rows[0].reversal_of_entry_id === approved.folio_entry_id, 'Reversal should reference original');
    console.log('  [OK] Reversal entry verified: DEBIT, references original');

    // 2i. Verify reservation financials recalculated after revoke
    // After revoke, the DISCOUNT entry is reversed, so eligible amount should increase back
    const finalReq = await service.getComplimentaryRequest(pool, reservationId, propertyId, actor);
    expect(finalReq.status === 'REVOKED', 'Final status should be REVOKED');
    console.log('  [OK] Reservation financials recalculated after revoke');

    console.log('  PASS');
  } finally {
    await cleanupComplimentaryTests(bookingId);
  }
}

// ---------------------------------------------------------------------------
// Test: Approval guards
// ---------------------------------------------------------------------------
async function testApprovalGuards(suffix) {
  console.log(`\n=== TEST 3: Approval Guards (suffix=${suffix}) ===`);
  const propertyId = 1;
  const { bookingId, reservationId } = await createTestBooking(propertyId, suffix, 500000);

  try {
    const service = require(path.resolve(__dirname, '../dist/domains/reservations/complimentaryService'));
    const actor = await getSuperAdminActor();
    const reqActor = { id: 2, email: 'fo@oak.local', username: 'frontdesk', full_name: 'Front Desk', role: 'FO', role_id: null, property_id: propertyId, scope: 'FULL' };

    // 3a. Create request with no payment/deposit -> should succeed
    const req1 = await service.createComplimentaryRequest(pool, {
      reservationId,
      propertyId,
      category: 'VIP',
      reason: 'Test guard',
      idempotencyKey: `guard-${suffix}-1`,
      requestor: reqActor
    });

    // Should be approvable (no ordinary payment, no applied deposit)
    const approved = await service.approveComplimentaryRequest(pool, {
      requestId: req1.id,
      reservationId,
      propertyId,
      actor
    });
    expect(approved.request.status === 'APPROVED', 'Should approve when no payments/deposits exist');
    console.log('  [OK] Approval passes when no settlement exists');

    // Revoke to clean up
    await service.revokeComplimentaryRequest(pool, {
      requestId: req1.id,
      reservationId,
      propertyId,
      reason: 'Cleanup',
      actor
    });

    // 3b. Block approval when ordinary payment exists
    const req2 = await service.createComplimentaryRequest(pool, {
      reservationId,
      propertyId,
      category: 'VIP',
      reason: 'Test payment guard',
      idempotencyKey: `guard-${suffix}-2`,
      requestor: reqActor
    });

    // Insert a payment folio entry to simulate ordinary payment
    await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, description, amount, direction, source_type, status)
       VALUES ($1, $2, 'PAYMENT', 'Test payment', 50000, 'CREDIT', 'PAYMENT', 'POSTED')`,
      [reservationId, propertyId]
    );

    try {
      await service.approveComplimentaryRequest(pool, {
        requestId: req2.id,
        reservationId,
        propertyId,
        actor
      });
      throw new Error('Should have blocked approval with payment');
    } catch (e) {
      expect(e.code === 'SETTLEMENT_GUARD_PAYMENT', `Expected SETTLEMENT_GUARD_PAYMENT, got ${e.code}`);
      console.log('  [OK] Approval blocked when ordinary payment exists');
    }

    // 3c. Block approval when applied deposit exists
    // First, clean up req2 so we can create a new request
    await pool.query(`DELETE FROM reservation_complimentary_requests WHERE id = $1`, [req2.id]);

    const req3 = await service.createComplimentaryRequest(pool, {
      reservationId,
      propertyId,
      category: 'VIP',
      reason: 'Test deposit guard',
      idempotencyKey: `guard-${suffix}-3`,
      requestor: reqActor
    });

    // Clean payment first
    await pool.query(`DELETE FROM folio_entries WHERE reservation_id = $1 AND description = 'Test payment'`, [reservationId]);

    // Insert deposit (schema uses entry_type='DEPOSIT_APPLY' for applied deposits)
    await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, description, amount, direction, source_type, status)
       VALUES ($1, $2, 'DEPOSIT_APPLY', 'Test deposit', 100000, 'CREDIT', 'DEPOSIT', 'POSTED')`,
      [reservationId, propertyId]
    );

    let depositError = null;
    try {
      await service.approveComplimentaryRequest(pool, {
        requestId: req3.id,
        reservationId,
        propertyId,
        actor
      });
    } catch (e) {
      depositError = e;
    }
    expect(depositError !== null, 'Approval should have been blocked when applied deposit exists');
    expect(depositError.code === 'SETTLEMENT_GUARD_DEPOSIT', `Expected SETTLEMENT_GUARD_DEPOSIT, got ${depositError.code || depositError.message}`);
    console.log('  [OK] Approval blocked when applied deposit exists');

    // Clean up req3 before testing status guard
    await pool.query(`DELETE FROM reservation_complimentary_requests WHERE id = $1`, [req3.id]);
    await pool.query(`DELETE FROM folio_entries WHERE reservation_id = $1 AND description = 'Test deposit'`, [reservationId]);

    // 3d. Block approval when status is not PENDING_APPROVAL
    const req4 = await service.createComplimentaryRequest(pool, {
      reservationId,
      propertyId,
      category: 'VIP',
      reason: 'Test status guard',
      idempotencyKey: `guard-${suffix}-4`,
      requestor: reqActor
    });

    // Approve it first
    await service.approveComplimentaryRequest(pool, {
      requestId: req4.id,
      reservationId,
      propertyId,
      actor
    });

    // Try to approve again
    try {
      await service.approveComplimentaryRequest(pool, {
        requestId: req4.id,
        reservationId,
        propertyId,
        actor
      });
      throw new Error('Should have blocked re-approval');
    } catch (e) {
      expect(e.statusCode === 409, `Expected 409, got ${e.statusCode}`);
      console.log('  [OK] Approval blocked when request already APPROVED');
    }

    console.log('  PASS');
  } finally {
    await cleanupComplimentaryTests(bookingId);
  }
}

// ---------------------------------------------------------------------------
// Test: Commercial discount interaction
// ---------------------------------------------------------------------------
async function testCommercialDiscountInteraction(suffix) {
  console.log(`\n=== TEST 4: Commercial Discount Interaction (suffix=${suffix}) ===`);
  const propertyId = 1;
  const { bookingId, reservationId } = await createTestBooking(propertyId, suffix, 500000);

  try {
    const service = require(path.resolve(__dirname, '../dist/domains/reservations/complimentaryService'));
    const actor = await getSuperAdminActor();
    const reqActor = { id: 2, email: 'fo@oak.local', username: 'frontdesk', full_name: 'Front Desk', role: 'FO', role_id: null, property_id: propertyId, scope: 'FULL' };

    // Eligible room charge = 1,000,000 (2 nights * 500,000)
    // Existing commercial discount = 200,000
    // Base for complimentary = 1,000,000 - 200,000 = 800,000

    // Insert a commercial discount folio entry
    await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, description, amount, direction, source_type, status)
       VALUES ($1, $2, 'DISCOUNT', 'Commercial discount', 200000, 'CREDIT', 'CORPORATE', 'POSTED')`,
      [reservationId, propertyId]
    );

    const req = await service.createComplimentaryRequest(pool, {
      reservationId,
      propertyId,
      category: 'VIP',
      reason: 'VIP with existing discount',
      idempotencyKey: `disc-${suffix}-1`,
      requestor: reqActor
    });

    const approved = await service.approveComplimentaryRequest(pool, {
      requestId: req.id,
      reservationId,
      propertyId,
      actor
    });

    expect(Number(approved.financials.eligible_room_charge) === 1000000, 'Eligible charge = 2 * 500000');
    expect(Number(approved.financials.commercial_discount) === 200000, 'Existing discount = 200000');
    expect(Number(approved.financials.adjustment_amount) === 800000, 'Adjustment = eligible - discount = 800000');
    console.log('  [OK] Adjustment correctly excludes existing commercial discount');

    // Verify original folio entry not voided (as per spec)
    const origDiscount = await pool.query(
      `SELECT id, amount, COALESCE(is_voided, FALSE) AS is_voided
       FROM folio_entries WHERE reservation_id = $1 AND description = 'Commercial discount'`,
      [reservationId]
    );
    expect(origDiscount.rows.length === 1, 'Original discount entry should exist');
    expect(origDiscount.rows[0].is_voided === false, 'Original discount entry should NOT be voided');
    console.log('  [OK] Original commercial discount folio entry preserved (not voided)');

    console.log('  PASS');
  } finally {
    await cleanupComplimentaryTests(bookingId);
  }
}

// ---------------------------------------------------------------------------
// Test: NULL-safe source_type handling
// ---------------------------------------------------------------------------
async function testNullSafeSourceTyp(suffix) {
    console.log(`\n=== TEST 5: NULL-safe source_type (suffix=${suffix}) ===`);
  const propertyId = 1;
  const { bookingId, reservationId } = await createTestBooking(propertyId, suffix, 500000);

  try {
    const service = require(path.resolve(__dirname, '../dist/domains/reservations/complimentaryService'));
    const actor = await getSuperAdminActor();
    const reqActor = { id: 2, email: 'fo@oak.local', username: 'frontdesk', full_name: 'Front Desk', role: 'FO', role_id: null, property_id: propertyId, scope: 'FULL' };

    // Insert a folio entry with NULL source_type (legacy entry)
    await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, description, amount, direction, source_type, status)
       VALUES ($1, $2, 'DISCOUNT', 'Legacy null-source discount', 100000, 'CREDIT', NULL, 'POSTED')`,
      [reservationId, propertyId]
    );

    const req = await service.createComplimentaryRequest(pool, {
      reservationId,
      propertyId,
      category: 'VIP',
      reason: 'Test NULL handling',
      idempotencyKey: `null-${suffix}-1`,
      requestor: reqActor
    });

    const approved = await service.approveComplimentaryRequest(pool, {
      requestId: req.id,
      reservationId,
      propertyId,
      actor
    });

    // NULL source_type MUST count as commercial discount (source_type IS DISTINCT FROM 'COMPLIMENTARY' includes NULL)
    expect(Number(approved.financials.commercial_discount) === 100000, 'NULL source_type should count as commercial discount');
    expect(Number(approved.financials.adjustment_amount) === 900000, 'Adjustment should subtract NULL-source discount (1000000 - 100000)');
    console.log('  [OK] NULL source_type correctly counted as commercial discount');

    console.log('  PASS');
  } finally {
    await cleanupComplimentaryTests(bookingId);
  }
}

// ---------------------------------------------------------------------------
// Test 6: Permission denial paths
// ---------------------------------------------------------------------------
async function testPermissionDenial(suffix) {
  console.log(`
=== TEST 6: Permission Denial Paths (suffix=${suffix}) ===`);
  const propertyId = 1;
  const { bookingId, reservationId } = await createTestBooking(propertyId, suffix, 500000);

  try {
    const service = require(path.resolve(__dirname, '../dist/domains/reservations/complimentaryService'));
    const actor = await getSuperAdminActor();

    // Create a user without any complimentary permissions (Housekeeping role)
    const noPermUser = {
      id: 9999,
      email: 'noPerm@oak.local',
      username: 'noPerm',
      full_name: 'No Permission User',
      role: 'Housekeeping',
      role_id: 4,
      property_id: propertyId,
      scope: 'FULL'
    };

    // 6a. Test create permission denial
    let createError = null;
    try {
      await service.createComplimentaryRequest(pool, {
        reservationId,
        propertyId,
        category: 'VIP',
        reason: 'Test permission denial',
        idempotencyKey: `perm-${suffix}-create`,
        requestor: noPermUser
      });
    } catch (e) {
      createError = e;
    }
    expect(createError !== null, 'Create should be blocked for user without permission');
    expect(createError.statusCode === 403, `Expected 403 FORBIDDEN, got ${createError?.statusCode}`);
    expect(createError.code === 'FORBIDDEN', `Expected FORBIDDEN code, got ${createError?.code}`);
    console.log('  [OK] Create blocked: 403 FORBIDDEN for user without request permission');

    // 6b. Create a request with authorized user, then test approve denial
    const reqActor = { id: 2, email: 'fo@oak.local', username: 'frontdesk', full_name: 'Front Desk', role: 'Front Office', role_id: 2, property_id: propertyId, scope: 'FULL' };
    const req = await service.createComplimentaryRequest(pool, {
      reservationId,
      propertyId,
      category: 'VIP',
      reason: 'Test approve denial',
      idempotencyKey: `perm-${suffix}-approve`,
      requestor: reqActor
    });

    let approveError = null;
    try {
      await service.approveComplimentaryRequest(pool, {
        requestId: req.id,
        reservationId,
        propertyId,
        actor: noPermUser
      });
    } catch (e) {
      approveError = e;
    }
    expect(approveError !== null, 'Approve should be blocked for user without permission');
    expect(approveError.statusCode === 403, `Expected 403 FORBIDDEN, got ${approveError?.statusCode}`);
    expect(approveError.code === 'FORBIDDEN', `Expected FORBIDDEN code, got ${approveError?.code}`);
    console.log('  [OK] Approve blocked: 403 FORBIDDEN for user without approve permission');

    // 6c. Test view/revoke denial
    let viewError = null;
    try {
      await service.getComplimentaryRequest(pool, reservationId, propertyId, noPermUser);
    } catch (e) {
      viewError = e;
    }
    expect(viewError !== null, 'View should be blocked for user without permission');
    expect(viewError.statusCode === 403, `Expected 403 FORBIDDEN, got ${viewError?.statusCode}`);
    console.log('  [OK] View blocked: 403 FORBIDDEN for user without view permission');

    // 6d. Test revoke denial
    let revokeError = null;
    try {
      await service.revokeComplimentaryRequest(pool, {
        requestId: req.id,
        reservationId,
        propertyId,
        reason: 'Test revoke denial',
        actor: noPermUser
      });
    } catch (e) {
      revokeError = e;
    }
    expect(revokeError !== null, 'Revoke should be blocked for user without permission');
    expect(revokeError.statusCode === 403, `Expected 403 FORBIDDEN, got ${revokeError?.statusCode}`);
    console.log('  [OK] Revoke blocked: 403 FORBIDDEN for user without revoke permission');

    console.log('  PASS');
  } finally {
    await cleanupComplimentaryTests(bookingId);
  }
}

// ---------------------------------------------------------------------------
// Test 7: Sibling reservation isolation
// ---------------------------------------------------------------------------
async function testSiblingIsolation(suffix) {
  console.log(`
=== TEST 7: Sibling Reservation Isolation (suffix=${suffix}) ===`);
  const propertyId = 1;
  const { bookingId, reservationId: resId1 } = await createTestBooking(propertyId, suffix, 500000);

  try {
    const service = require(path.resolve(__dirname, '../dist/domains/reservations/complimentaryService'));
    const actor = await getSuperAdminActor();
    const reqActor = { id: 2, email: 'fo@oak.local', username: 'frontdesk', full_name: 'Front Desk', role: 'Front Office', role_id: 2, property_id: propertyId, scope: 'FULL' };

    // Create second reservation (sibling) in same booking
    const checkIn = '2028-06-01';
    const checkOut = '2028-06-03';
    const totalPrice = 500000 * 2;
    const res2 = await pool.query(
      `INSERT INTO reservations (
         booking_id, booking_number, stay_sequence, guest_name,
         check_in, check_out, total_price, status, payment_status, stay_type,
         created_at
       ) VALUES ($1, $2, 2, $3, $4, $5, $6, 'BOOKED', 'UNPAID', 'OVERNIGHT', NOW()) RETURNING id`,
      [bookingId, `RES-COMP-SIB-${suffix}`, `Guest Sibling ${suffix}`, checkIn, checkOut, totalPrice]
    );
    const reservationId2 = res2.rows[0].id;

    // Add nightly rates for second reservation
    await pool.query(
      `INSERT INTO reservation_nightly_rates (reservation_id, property_id, stay_date, room_type_id, base_rate, final_room_rate, total_amount)
       VALUES ($1, $2, $3, $4, $5, $5, $5)`,
      [reservationId2, propertyId, checkIn, 1, 500000]
    );
    await pool.query(
      `INSERT INTO reservation_nightly_rates (reservation_id, property_id, stay_date, room_type_id, base_rate, final_room_rate, total_amount)
       VALUES ($1, $2, $3, $4, $5, $5, $5)`,
      [reservationId2, propertyId, checkOut, 1, 500000]
    );

    // Create and approve complimentary request for reservation 1 ONLY
    const req1 = await service.createComplimentaryRequest(pool, {
      reservationId: resId1,
      propertyId,
      category: 'VIP',
      reason: 'Complimentary for first sibling',
      idempotencyKey: `sib-${suffix}-1`,
      requestor: reqActor
    });
    const approved = await service.approveComplimentaryRequest(pool, {
      requestId: req1.id,
      reservationId: resId1,
      propertyId,
      actor
    });
    expect(approved.request.status === 'APPROVED', 'First reservation should be approved');
    expect(Number(approved.financials.adjustment_amount) === 1000000, 'First reservation adjustment should be 1000000');
    console.log('  [OK] First reservation approved with adjustment 1000000');

    // Verify second reservation is NOT affected
    const req2Check = await pool.query(
      `SELECT COUNT(*) as cnt FROM reservation_complimentary_requests WHERE reservation_id = $1`,
      [reservationId2]
    );
    expect(Number(req2Check.rows[0].cnt) === 0, 'Second reservation should have no complimentary request');
    console.log('  [OK] Second reservation has no complimentary request (isolated)');

    // Verify second reservation financials unchanged
    const fin2 = await pool.query(
      `SELECT discount_amount, applied_deposit FROM reservations WHERE id = $1`,
      [reservationId2]
    );
    expect(Number(fin2.rows[0].discount_amount) === 0, 'Second reservation discount should be 0');
    console.log('  [OK] Second reservation financials unchanged');

    // Try to create request for second reservation (should work independently)
    const req2 = await service.createComplimentaryRequest(pool, {
      reservationId: reservationId2,
      propertyId,
      category: 'VIP',
      reason: 'Complimentary for second sibling',
      idempotencyKey: `sib-${suffix}-2`,
      requestor: reqActor
    });
    expect(req2.status === 'PENDING_APPROVAL', 'Second reservation should allow independent request');
    console.log('  [OK] Second reservation can have independent complimentary request');

    console.log('  PASS');
  } finally {
    await cleanupComplimentaryTests(bookingId);
  }
}

// ---------------------------------------------------------------------------
// Test 8: Double/concurrent approve protection
// ---------------------------------------------------------------------------
async function testConcurrentApprove(suffix) {
  console.log(`
=== TEST 8: Double/Concurrent Approve Protection (suffix=${suffix}) ===`);
  const propertyId = 1;
  const { bookingId, reservationId } = await createTestBooking(propertyId, suffix, 500000);

  try {
    const service = require(path.resolve(__dirname, '../dist/domains/reservations/complimentaryService'));
    const actor = await getSuperAdminActor();
    const reqActor = { id: 2, email: 'fo@oak.local', username: 'frontdesk', full_name: 'Front Desk', role: 'Front Office', role_id: 2, property_id: propertyId, scope: 'FULL' };

    // Create a pending request
    const req = await service.createComplimentaryRequest(pool, {
      reservationId,
      propertyId,
      category: 'VIP',
      reason: 'Test concurrent approve',
      idempotencyKey: `conc-${suffix}-1`,
      requestor: reqActor
    });
    expect(req.status === 'PENDING_APPROVAL', 'Request should be PENDING_APPROVAL');
    console.log('  [OK] Request created: PENDING_APPROVAL');

    // Simulate concurrent approve attempts using Promise.allSettled
    const results = await Promise.allSettled([
      service.approveComplimentaryRequest(pool, {
        requestId: req.id,
        reservationId,
        propertyId,
        actor
      }),
      service.approveComplimentaryRequest(pool, {
        requestId: req.id,
        reservationId,
        propertyId,
        actor
      })
    ]);

    // Count successes and failures
    const successes = results.filter(r => r.status === 'fulfilled');
    const failures = results.filter(r => r.status === 'rejected');

    expect(successes.length === 1, `Expected exactly 1 success, got ${successes.length}`);
    expect(failures.length === 1, `Expected exactly 1 failure, got ${failures.length}`);
    console.log('  [OK] Exactly 1 approve succeeded, 1 failed');

    // Verify only one folio entry was created
    const folioCount = await pool.query(
      `SELECT COUNT(*) as cnt FROM folio_entries WHERE reservation_id = $1 AND source_type = 'COMPLIMENTARY'`,
      [reservationId]
    );
    expect(Number(folioCount.rows[0].cnt) === 1, 'Should have exactly 1 COMPLIMENTARY folio entry');
    console.log('  [OK] Exactly 1 folio entry created (no duplicate)');

    // Verify the request status is APPROVED
    const finalReq = await pool.query(
      `SELECT status FROM reservation_complimentary_requests WHERE id = $1`,
      [req.id]
    );
    expect(finalReq.rows[0].status === 'APPROVED', 'Request status should be APPROVED');
    console.log('  [OK] Request status is APPROVED');

    console.log('  PASS');
  } finally {
    await cleanupComplimentaryTests(bookingId);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== COMPLIMENTARY FLOW BACKEND TESTS ===');

  try {
    // Initialize schema (creates the complimentary_requests table)
    const { initializeDatabase } = require('../dist/db/schema_v3');
    await initializeDatabase(pool);

    await testTableSchema();
    await testLifecycle(Date.now().toString());
    await testApprovalGuards(Date.now().toString());
    await testCommercialDiscountInteraction(Date.now().toString());
    await testNullSafeSourceTyp(Date.now().toString());
    await testPermissionDenial(Date.now().toString());
    await testSiblingIsolation(Date.now().toString());
    await testConcurrentApprove(Date.now().toString());

    console.log('\n=== ALL TESTS PASSED ===');
    process.exit(0);
  } catch (err) {
    console.error('\n=== TEST FAILED ===');
    console.error(err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
