/**
 * group_identity_checkout_deadlock_test.js
 *
 * GROUP-IDENTITY-CHECKOUT-DEADLOCK — Regression tests
 *
 * Root cause: getHeldIdentityCustodyForCheckout() did NOT filter by scope,
 * so a BOOKING_GROUP custody row (anchored to a reservation_id) incorrectly
 * blocked child checkout while the group lifecycle simultaneously forbade
 * returning that custody until all children are terminal — a deadlock.
 *
 * Fix: checkout guard now filters scope = 'ROOM_RESERVATION'.
 *
 * Domain invariants verified:
 *   A. ROOM_RESERVATION HELD custody blocks checkout of its own reservation.
 *   B. BOOKING_GROUP HELD custody does NOT block non-final child checkout.
 *   C. BOOKING_GROUP HELD custody does NOT block final child checkout.
 *   D. BOOKING_GROUP custody return blocked while any child active.
 *   E. After final child terminal, BOOKING_GROUP custody return succeeds.
 *   F. Group deposit refund blocked while group custody HELD (even when release-eligible).
 *   G. After group custody returned, group deposit refund succeeds.
 *
 * Run: cd backend && npm run build && node test/group_identity_checkout_deadlock_test.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const {
  getHeldIdentityCustodyForCheckout,
  returnIdentity,
} = require('../dist/domains/identity/identityCustodyService');
const { refundDeposit } = require('../dist/domains/deposits/depositService');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db',
});

const runId = `GCD${String(Date.now()).slice(-8)}`;
let passed = 0;
let failed = 0;

function check(condition, message) {
  if (condition) {
    passed++;
    console.log(`PASS | ${message}`);
  } else {
    failed++;
    console.error(`FAIL | ${message}`);
  }
}

// ─── Fixture helpers (mirror group_guarantee_release_1b_test.js patterns) ────

const _DATE_BASE = new Date(Date.UTC(2081, 0, 1)); // 2081-01-01 UTC — unique window
let _slot = 0;

async function createBooking(client, propertyId, status = 'ACTIVE') {
  const bid = `BID-GCD-${runId}-${_slot}`;
  const res = await client.query(
    `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [propertyId, bid, `GCD Guest ${runId}`, status]
  );
  return Number(res.rows[0].id);
}

async function createReservation(client, bookingId, roomId, roomTypeId, status, seq) {
  const slot = _slot++;
  const checkIn = new Date(_DATE_BASE.getTime() + slot * 3 * 86400000);
  const checkOut = new Date(checkIn.getTime() + 86400000);
  const res = await client.query(
    `INSERT INTO reservations (
       booking_id, room_id, booked_room_type_id_snapshot, guest_name,
       check_in, check_out, subtotal_amount, total_price, amount_paid, remaining_balance,
       status, payment_status, stay_sequence
     ) VALUES ($1, $2, $3, $4, $5, $6, 1000000, 1000000, 0, 1000000, $7, 'UNPAID', $8)
     RETURNING id`,
    [bookingId, roomId, roomTypeId, `GCD Guest ${runId}`,
     checkIn.toISOString().slice(0, 10), checkOut.toISOString().slice(0, 10), status, seq]
  );
  return Number(res.rows[0].id);
}

async function createCustody(client, propertyId, reservationId, bookingId, scope) {
  const res = await client.query(
    `INSERT INTO identity_custody (
       property_id, reservation_id, booking_id, document_type,
       document_holder_name, document_number_masked, status, received_by, scope
     ) VALUES ($1, $2, $3, 'KTP', $4, '****9999', 'HELD', 'Tester', $5)
     RETURNING id`,
    [propertyId, reservationId, bookingId, `GCD Guest ${runId}`, scope]
  );
  return Number(res.rows[0].id);
}

async function createGroupDeposit(client, propertyId, reservationId, bookingId) {
  const depositNumber = `DEP-GCD-${runId}-${_slot}`;
  const txRes = await client.query(
    `INSERT INTO payment_transactions (
       reservation_id, property_id, transaction_type, amount, payment_method,
       reference_code, status, created_by, booking_id, scope
     ) VALUES ($1, $2, 'DEPOSIT_RECEIVED', $3, 'CASH', $4, 'SUCCESS', 'Tester', $5, 'BOOKING_GROUP')
     RETURNING id`,
    [reservationId, propertyId, 10000, depositNumber, bookingId]
  );
  const paymentId = Number(txRes.rows[0].id);
  const res = await client.query(
    `INSERT INTO deposits (
       property_id, reservation_id, booking_id, deposit_number, original_amount,
       payment_method, status, received_by, scope
     ) VALUES ($1, $2, $3, $4, $5, 'CASH', 'RECEIVED', 'Tester', 'BOOKING_GROUP')
     RETURNING id`,
    [propertyId, reservationId, bookingId, depositNumber, 10000]
  );
  const depositId = Number(res.rows[0].id);
  await client.query(
    `INSERT INTO deposit_events (deposit_id, property_id, reservation_id, event_type, amount, payment_transaction_id, idempotency_key, performed_by)
     VALUES ($1, $2, $3, 'RECEIVED', $4, $5, $6, 'Tester')`,
    [depositId, propertyId, reservationId, 10000, paymentId, `EVT-GCD-${runId}-${depositId}`]
  );
  return depositId;
}

async function cleanup(client, bookingId, reservationIds) {
  for (const rid of reservationIds) {
    await client.query('DELETE FROM identity_custody WHERE reservation_id = $1', [rid]);
    await client.query('DELETE FROM deposit_events WHERE reservation_id = $1', [rid]);
    await client.query('DELETE FROM deposits WHERE reservation_id = $1', [rid]);
    await client.query('DELETE FROM payment_transactions WHERE reservation_id = $1', [rid]);
  }
  await client.query('DELETE FROM reservations WHERE booking_id = $1', [bookingId]);
  await client.query('DELETE FROM bookings WHERE id = $1', [bookingId]);
}

const ACTOR = { userId: '1', name: 'Tester', role: 'RECEPTIONIST' };

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  const client = await pool.connect();

  try {
    console.log(`\n=== GROUP-IDENTITY-CHECKOUT-DEADLOCK TESTS [runId=${runId}] ===\n`);

    const propRes = await client.query('SELECT id FROM properties ORDER BY id LIMIT 1');
    if (propRes.rowCount === 0) {
      throw new Error('Test prerequisite failed: no property found in database');
    }
    const propertyId = Number(propRes.rows[0].id);

    // Property-safe room fixtures: rooms must belong to the SAME selected property,
    // and each reservation must use its room's OWN room_type_id.
    const roomRes = await client.query(
      'SELECT id, room_type_id FROM rooms WHERE property_id = $1 ORDER BY id LIMIT 5',
      [propertyId]
    );
    if (roomRes.rowCount < 2) {
      throw new Error(`Test prerequisite failed: property ${propertyId} needs at least 2 rooms (found ${roomRes.rowCount})`);
    }
    const rooms = roomRes.rows.map(r => ({ id: Number(r.id), typeId: Number(r.room_type_id) }));

    // ═══ Scenario A: ROOM_RESERVATION HELD custody blocks own checkout ═══
    {
      const bookingId = await createBooking(client, propertyId, 'ACTIVE');
      const rA = await createReservation(client, bookingId, rooms[0].id, rooms[0].typeId, 'CHECKED_IN', 1);
      await createCustody(client, propertyId, rA, bookingId, 'ROOM_RESERVATION');

      const held = await getHeldIdentityCustodyForCheckout(client, propertyId, rA);
      check(held.length > 0, 'A1: ROOM_RESERVATION HELD custody blocks own reservation checkout guard');

      await cleanup(client, bookingId, [rA]);
    }

    // ═══ Scenario B: BOOKING_GROUP HELD does NOT block non-final child ═══
    {
      const bookingId = await createBooking(client, propertyId, 'ACTIVE');
      const rB1 = await createReservation(client, bookingId, rooms[0].id, rooms[0].typeId, 'CHECKED_IN', 1);
      const rB2 = await createReservation(client, bookingId, rooms[1].id, rooms[1].typeId, 'CHECKED_IN', 2);
      // Group custody anchored on rB1 (the anchor reservation)
      await createCustody(client, propertyId, rB1, bookingId, 'BOOKING_GROUP');

      // Non-final child (rB2) checkout guard must NOT see group custody as blocking
      const heldB2 = await getHeldIdentityCustodyForCheckout(client, propertyId, rB2);
      check(heldB2.length === 0, 'B1: BOOKING_GROUP HELD does NOT block non-final sibling (rB2) checkout guard');

      // Also verify the anchor child itself (rB1) is not blocked by its own group custody
      const heldB1 = await getHeldIdentityCustodyForCheckout(client, propertyId, rB1);
      check(heldB1.length === 0, 'B2: BOOKING_GROUP HELD does NOT block anchor child (rB1) checkout guard');

      await cleanup(client, bookingId, [rB1, rB2]);
    }

    // ═══ Scenario C: BOOKING_GROUP HELD does NOT block FINAL child ═══
    {
      const bookingId = await createBooking(client, propertyId, 'ACTIVE');
      const rC1 = await createReservation(client, bookingId, rooms[0].id, rooms[0].typeId, 'CHECKED_OUT', 1);
      const rC2 = await createReservation(client, bookingId, rooms[1].id, rooms[1].typeId, 'CHECKED_IN', 2);
      await createCustody(client, propertyId, rC1, bookingId, 'BOOKING_GROUP');

      const heldC2 = await getHeldIdentityCustodyForCheckout(client, propertyId, rC2);
      check(heldC2.length === 0, 'C1: BOOKING_GROUP HELD does NOT block final active child checkout guard');

      await cleanup(client, bookingId, [rC1, rC2]);
    }

    // ═══ Scenario D: Group custody return blocked while children active ═══
    {
      const bookingId = await createBooking(client, propertyId, 'ACTIVE');
      const rD1 = await createReservation(client, bookingId, rooms[0].id, rooms[0].typeId, 'CHECKED_IN', 1);
      const rD2 = await createReservation(client, bookingId, rooms[1].id, rooms[1].typeId, 'CHECKED_IN', 2);
      const custD = await createCustody(client, propertyId, rD1, bookingId, 'BOOKING_GROUP');

      let blockedCode = null;
      try {
        await returnIdentity(pool, {
          propertyId, custodyId: custD, actor: ACTOR,
        });
      } catch (err) {
        blockedCode = err.code;
      }
      check(blockedCode === 'BOOKING_GROUP_GUARANTEE_NOT_RELEASE_ELIGIBLE',
        `D1: group custody return blocked while children active (got ${blockedCode})`);

      await cleanup(client, bookingId, [rD1, rD2]);
    }

    // ═══ Scenario E: After final child terminal, group custody return succeeds ═══
    {
      const bookingId = await createBooking(client, propertyId, 'ACTIVE');
      const rE1 = await createReservation(client, bookingId, rooms[0].id, rooms[0].typeId, 'CHECKED_OUT', 1);
      const rE2 = await createReservation(client, bookingId, rooms[1].id, rooms[1].typeId, 'CHECKED_OUT', 2);
      const custE = await createCustody(client, propertyId, rE1, bookingId, 'BOOKING_GROUP');

      const returned = await returnIdentity(pool, {
        propertyId, custodyId: custE, actor: ACTOR,
      });
      check(returned.status === 'RETURNED', 'E1: after final child terminal, group custody return succeeds');
      check(returned.returned_by === 'Tester', 'E2: returned_by recorded');

      await cleanup(client, bookingId, [rE1, rE2]);
    }

    // ═══ Scenarios F+G: Deposit refund chain gated by group custody ═══
    {
      const bookingId = await createBooking(client, propertyId, 'ACTIVE');
      const rF1 = await createReservation(client, bookingId, rooms[0].id, rooms[0].typeId, 'CHECKED_OUT', 1);
      const rF2 = await createReservation(client, bookingId, rooms[1].id, rooms[1].typeId, 'CHECKED_OUT', 2);
      const custF = await createCustody(client, propertyId, rF1, bookingId, 'BOOKING_GROUP');
      const depF = await createGroupDeposit(client, propertyId, rF1, bookingId);

      // F: lifecycle is release-eligible (all children terminal) but custody still HELD
      //    → refund must be blocked with BOOKING_GROUP_CUSTODY_STILL_HELD
      let refundBlockedCode = null;
      try {
        await refundDeposit(pool, {
          propertyId, reservationId: rF1, depositId: depF,
          amount: 10000, paymentMethod: 'CASH',
          idempotencyKey: `RFD-GCD-F-${runId}`,
          actor: ACTOR,
        });
      } catch (err) {
        refundBlockedCode = err.code;
      }
      check(refundBlockedCode === 'BOOKING_GROUP_CUSTODY_STILL_HELD',
        `F1: group deposit refund blocked while custody HELD even when release-eligible (got ${refundBlockedCode})`);

      // G: return custody, then refund succeeds
      await returnIdentity(pool, { propertyId, custodyId: custF, actor: ACTOR });
      const refundResult = await refundDeposit(pool, {
        propertyId, reservationId: rF1, depositId: depF,
        amount: 10000, paymentMethod: 'CASH',
        idempotencyKey: `RFD-GCD-G-${runId}`,
        actor: ACTOR,
      });
      check(refundResult.event?.event_type === 'REFUND', 'G1: after custody returned, group deposit refund succeeds');

      await cleanup(client, bookingId, [rF1, rF2]);
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total.\n`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (err) {
    console.error('Fatal test error:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
