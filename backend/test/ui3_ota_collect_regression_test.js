import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import schemaPkg from '../dist/db/schema_v3.js';
import pkg from '../dist/index.js';
import {
  settleTransactionPayment,
  getTransactionById,
  projectFolioEntryToTransaction,
  createManualTransaction
} from '../dist/domains/transactions/transactionService.js';

const require = createRequire(import.meta.url);
const { getPlatformSuperAdminToken } = require('./helpers/transactionReadAuth.js');
const { getEffectivePaymentStateForReservation } = require('../dist/domains/payments/paymentAllocationService.js');

const { pool } = pkg;
const { initializeDatabase } = schemaPkg;

/**
 * UI-3 OTA_COLLECT Regression Tests (T1–T6)
 *
 * Tests the canonical transaction detail corrective patch:
 * T1  Pure OTA room charge — hotel_collectible=0, settlement rejected, zero fake payments
 * T2  OTA + hotel extra — collectible ceiling works, over-payment rejected
 * T3  OTA + applied deposit — deposit reduces remaining, no double-counting
 * T4  HOTEL_COLLECT reservation — canonical settlement creates ROOM_RESERVATION payment
 * T5  Non-reservation transaction — legacy transaction-level INSERT preserved
 * T6  Single row invariant — one settlement action creates exactly ONE payment row
 */

async function runTests() {
  console.log('=== RUNNING UI-3 OTA COLLECT REGRESSION SUITE ===');
  await initializeDatabase(pool);
  const saToken = await getPlatformSuperAdminToken(pool, 1);
  const propRes = await pool.query('SELECT id FROM properties ORDER BY id ASC LIMIT 1');
  const propertyId = Number(propRes.rows[0]?.id || 1);

  const cleanupTx = [];
  const cleanupFe = [];
  const cleanupRes = [];
  const cleanupBooking = [];
  const cleanupPt = [];

  try {

    // =====================================================================
    // T1: PURE OTA ROOM
    // =====================================================================
    console.log('\nTest T1: PURE OTA ROOM');
    const suffix1 = Date.now() + '-T1';
    const b1 = await pool.query(
      `INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status)
       VALUES ($1,$2,$3,'ACTIVE') RETURNING id`,
      [`BID-T1-${suffix1}`, propertyId, `Guest T1 ${suffix1}`]
    );
    const bookingId1 = Number(b1.rows[0].id);
    cleanupBooking.push(bookingId1);

    const r1 = await pool.query(
      `INSERT INTO reservations (booking_id, booking_number, stay_sequence, guest_name,
        total_price, amount_paid, remaining_balance, payment_status, status,
        check_in, check_out, stay_type)
       VALUES ($1,$2,1,$3,1000000,0,1000000,'UNPAID','BOOKED',
        '2026-10-01','2026-10-03','OVERNIGHT') RETURNING id`,
      [bookingId1, `RES-T1-${suffix1}`, `Guest T1 ${suffix1}`]
    );
    const resId1 = Number(r1.rows[0].id);
    cleanupRes.push(resId1);

    // Set payment_responsibility on the BOOKING
    await pool.query(
      `UPDATE bookings SET payment_responsibility = 'OTA_COLLECT' WHERE id = $1`,
      [bookingId1]
    );

    // Create ROOM_CHARGE folio entry -> SALE transaction
    const fe1 = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type,
        description, amount, direction, status)
       VALUES ($1,$2,'ROOM_CHARGE','ROOM_CHARGE','Kamar OTA',1000000,'DEBIT','POSTED') RETURNING id`,
      [resId1, propertyId]
    );
    cleanupFe.push(Number(fe1.rows[0].id));

    const tx1 = await projectFolioEntryToTransaction(pool, Number(fe1.rows[0].id), { propertyId });
    cleanupTx.push(tx1.id);
    assert.equal(tx1.transaction_type, 'SALE', 'ROOM_CHARGE must be SALE');
    assert.equal(Number(tx1.net_amount), 1000000, 'Net amount must be 1,000,000');
    assert.equal(String(tx1.reservation_id), String(resId1), 'Transaction must link to reservation');
    // payment_responsibility lives on booking, surfaced via getTransactionById
    const txDetail1Check = await getTransactionById(pool, propertyId, tx1.id);
    assert.equal(txDetail1Check.payment_responsibility, 'OTA_COLLECT',
      'Must inherit OTA_COLLECT from booking');

    // Verify canonical collectible fields in getTransactionById
    const txDetail1 = await getTransactionById(pool, propertyId, tx1.id);
    assert.equal(Number(txDetail1.hotel_collectible_total), 0,
      'Pure OTA room: hotel_collectible_total must be 0');
    assert.equal(Number(txDetail1.hotel_collectible_remaining_balance), 0,
      'Pure OTA room: hotel_collectible_remaining_balance must be 0');
    assert.equal(Number(txDetail1.canonical_amount_paid), 0,
      'Pure OTA room: canonical_amount_paid must be 0');

    // Settlement attempt must be REJECTED
    let settleErr = null;
    try {
      await settleTransactionPayment(pool, tx1.id, {
        property_id: propertyId,
        amount: 50000,
        payment_method: 'CASH',
        actor_name: 'Receptionist'
      });
    } catch (e) {
      settleErr = e;
    }
    assert.ok(settleErr, 'Settlement for pure OTA room must be rejected');
    assert.ok(settleErr.message.includes('sisa tagihan hotel'),
      'Error must mention hotel collectible balance');

    // Zero payment rows must exist
    const payCount1 = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM payment_transactions
       WHERE reservation_id = $1 AND scope = 'ROOM_RESERVATION'`,
      [resId1]
    );
    assert.equal(payCount1.rows[0].cnt, 0,
      'Pure OTA room must have zero canonical payment rows');

    console.log('  PASSED');

    // =====================================================================
    // T2: OTA + HOTEL EXTRA
    // =====================================================================
    console.log('\nTest T2: OTA + HOTEL EXTRA');
    const suffix2 = Date.now() + '-T2';
    const b2 = await pool.query(
      `INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status)
       VALUES ($1,$2,$3,'ACTIVE') RETURNING id`,
      [`BID-T2-${suffix2}`, propertyId, `Guest T2 ${suffix2}`]
    );
    const bookingId2 = Number(b2.rows[0].id);
    cleanupBooking.push(bookingId2);

    const r2 = await pool.query(
      `INSERT INTO reservations (booking_id, booking_number, stay_sequence, guest_name,
        total_price, amount_paid, remaining_balance, payment_status, status,
        check_in, check_out, stay_type)
       VALUES ($1,$2,1,$3,1329728,0,1329728,'UNPAID','BOOKED',
        '2026-10-05','2026-10-07','OVERNIGHT') RETURNING id`,
      [bookingId2, `RES-T2-${suffix2}`, `Guest T2 ${suffix2}`]
    );
    const resId2 = Number(r2.rows[0].id);
    cleanupRes.push(resId2);

    // Set payment_responsibility on the BOOKING
    await pool.query(
      `UPDATE bookings SET payment_responsibility = 'OTA_COLLECT' WHERE id = $1`,
      [bookingId2]
    );

    // ROOM_CHARGE 329728 (OTA settled outside hotel)
    const fe2a = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type,
        description, amount, direction, status)
       VALUES ($1,$2,'ROOM_CHARGE','ROOM_CHARGE','Kamar Deluxe 2M',329728,'DEBIT','POSTED') RETURNING id`,
      [resId2, propertyId]
    );
    cleanupFe.push(Number(fe2a.rows[0].id));

    // Hotel extra 50000
    const fe2b = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type,
        description, amount, direction, status)
       VALUES ($1,$2,'EXTRA_BED','EXTRA_BED','Extra Bed',50000,'DEBIT','POSTED') RETURNING id`,
      [resId2, propertyId]
    );
    cleanupFe.push(Number(fe2b.rows[0].id));

    const tx2 = await projectFolioEntryToTransaction(pool, Number(fe2b.rows[0].id), { propertyId });
    cleanupTx.push(tx2.id);

    // Verify canonical fields
    const txDetail2 = await getTransactionById(pool, propertyId, tx2.id);
    assert.equal(Number(txDetail2.hotel_collectible_total), 50000,
      'OTA+extra: hotel_collectible_total must equal extra charge (50,000)');
    assert.equal(Number(txDetail2.hotel_collectible_remaining_balance), 50000,
      'OTA+extra: remaining must equal total before any payment');

    // Settlement within ceiling -> must succeed
    const settled = await settleTransactionPayment(pool, tx2.id, {
      property_id: propertyId,
      amount: 30000,
      payment_method: 'TRANSFER',
      actor_name: 'Receptionist Ani'
    });
    assert.equal(settled.payment_status, 'PARTIALLY_PAID',
      'After 30k payment on 50k collectible, must be PARTIALLY_PAID');

    // Re-read: remaining should be 20000
    const txDetail2b = await getTransactionById(pool, propertyId, tx2.id);
    assert.equal(Number(txDetail2b.hotel_collectible_remaining_balance), 20000,
      'Remaining must be 20,000 after 30k payment');
    assert.equal(Number(txDetail2b.canonical_amount_paid), 30000,
      'canonical_amount_paid must be 30,000');

    // Over-amount settlement must be rejected
    let overErr = null;
    try {
      await settleTransactionPayment(pool, tx2.id, {
        property_id: propertyId,
        amount: 25000,
        payment_method: 'CASH',
        actor_name: 'Receptionist'
      });
    } catch (e) {
      overErr = e;
    }
    assert.ok(overErr, 'Over-amount settlement must be rejected');
    assert.ok(overErr.message.includes('melebihi'), 'Error must mention exceeding ceiling');

    // Canonical remaining unchanged after rejected attempt
    const txDetail2c = await getTransactionById(pool, propertyId, tx2.id);
    assert.equal(Number(txDetail2c.hotel_collectible_remaining_balance), 20000,
      'Rejected settlement must not change remaining balance');

    console.log('  PASSED');

    // =====================================================================
    // T3: OTA + APPLIED DEPOSIT
    // =====================================================================
    console.log('\nTest T3: OTA + APPLIED DEPOSIT');
    const suffix3 = Date.now() + '-T3';
    const b3 = await pool.query(
      `INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status)
       VALUES ($1,$2,$3,'ACTIVE') RETURNING id`,
      [`BID-T3-${suffix3}`, propertyId, `Guest T3 ${suffix3}`]
    );
    const bookingId3 = Number(b3.rows[0].id);
    cleanupBooking.push(bookingId3);

    const r3 = await pool.query(
      `INSERT INTO reservations (booking_id, booking_number, stay_sequence, guest_name,
        total_price, amount_paid, remaining_balance, payment_status, status,
        check_in, check_out, stay_type)
       VALUES ($1,$2,1,$3,80000,0,80000,'UNPAID','BOOKED',
        '2026-11-01','2026-11-02','OVERNIGHT') RETURNING id`,
      [bookingId3, `RES-T3-${suffix3}`, `Guest T3 ${suffix3}`]
    );
    const resId3 = Number(r3.rows[0].id);
    cleanupRes.push(resId3);

    // Set payment_responsibility on the BOOKING
    await pool.query(
      `UPDATE bookings SET payment_responsibility = 'OTA_COLLECT' WHERE id = $1`,
      [bookingId3]
    );

    // HOTEL EXTRA 80000
    const fe3a = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type,
        description, amount, direction, status)
       VALUES ($1,$2,'EXTRA_BED','EXTRA_BED','Extra Bed',80000,'DEBIT','POSTED') RETURNING id`,
      [resId3, propertyId]
    );
    cleanupFe.push(Number(fe3a.rows[0].id));

    // DEPOSIT_APPLY 30000
    const fe3b = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type,
        description, amount, direction, status)
       VALUES ($1,$2,'DEPOSIT_APPLY','DEPOSIT_APPLY','Deposit Applied',30000,'CREDIT','POSTED') RETURNING id`,
      [resId3, propertyId]
    );
    cleanupFe.push(Number(fe3b.rows[0].id));

    // Create SALE transaction linked to this reservation (for the deposit)
    const tx3a = await createManualTransaction(pool, {
      property_id: propertyId,
      transaction_type: 'INCOME',
      category_code: 'DEPOSIT_INCOME',
      description: 'Deposit collected',
      amount: 30000,
      payment_method: 'CASH',
      reservation_id: resId3,
      actor_name: 'Receptionist'
    });
    cleanupTx.push(tx3a.id);

    const txDetail3 = await getTransactionById(pool, propertyId, tx3a.id);
    assert.equal(Number(txDetail3.hotel_collectible_total), 80000,
      'Hotel collectible total must be 80,000');
    assert.equal(Number(txDetail3.canonical_applied_deposit), 30000,
      'Applied deposit must be 30,000');
    assert.equal(Number(txDetail3.canonical_amount_paid), 0,
      'No ordinary payment yet, canonical_amount_paid = 0');
    assert.equal(Number(txDetail3.hotel_collectible_remaining_balance), 50000,
      'Remaining = 80k - 30k deposit = 50,000');

    // Settle remaining 50,000
    const settled3 = await settleTransactionPayment(pool, tx3a.id, {
      property_id: propertyId,
      amount: 50000,
      payment_method: 'TRANSFER',
      actor_name: 'Receptionist'
    });
    assert.equal(settled3.payment_status, 'PAID',
      'After deposit+payment covers full collectible, must be PAID');

    // Verify single payment row
    const payRows3 = await pool.query(
      `SELECT id, amount FROM payment_transactions
        WHERE reservation_id = $1 AND scope = 'ROOM_RESERVATION'
        ORDER BY id`,
      [resId3]
    );
    assert.equal(payRows3.rows.length, 1,
      'Must have exactly one ROOM_RESERVATION payment row');
    assert.equal(Number(payRows3.rows[0].amount), 50000,
      'Single payment row amount must be 50,000');
    cleanupPt.push(Number(payRows3.rows[0].id));

    console.log('  PASSED');

    // =====================================================================
    // T4: HOTEL_COLLECT RESERVATION
    // =====================================================================
    console.log('\nTest T4: HOTEL_COLLECT RESERVATION');
    const suffix4 = Date.now() + '-T4';
    const b4 = await pool.query(
      `INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status)
       VALUES ($1,$2,$3,'ACTIVE') RETURNING id`,
      [`BID-T4-${suffix4}`, propertyId, `Guest T4 ${suffix4}`]
    );
    const bookingId4 = Number(b4.rows[0].id);
    cleanupBooking.push(bookingId4);

    const r4 = await pool.query(
      `INSERT INTO reservations (booking_id, booking_number, stay_sequence, guest_name,
        total_price, amount_paid, remaining_balance, payment_status, status,
        check_in, check_out, stay_type)
       VALUES ($1,$2,1,$3,200000,0,200000,'UNPAID','BOOKED',
        '2026-12-01','2026-12-02','OVERNIGHT') RETURNING id`,
      [bookingId4, `RES-T4-${suffix4}`, `Guest T4 ${suffix4}`]
    );
    const resId4 = Number(r4.rows[0].id);
    cleanupRes.push(resId4);

    // Set payment_responsibility on the BOOKING (HOTEL_COLLECT is default)

    // HOTEL CHARGE
    const fe4 = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type,
        description, amount, direction, status)
       VALUES ($1,$2,'EXTRA_BED','EXTRA_BED','Laundry',200000,'DEBIT','POSTED') RETURNING id`,
      [resId4, propertyId]
    );
    cleanupFe.push(Number(fe4.rows[0].id));

    const tx4 = await projectFolioEntryToTransaction(pool, Number(fe4.rows[0].id), { propertyId });
    cleanupTx.push(tx4.id);

    const txDetail4 = await getTransactionById(pool, propertyId, tx4.id);
    assert.equal(Number(txDetail4.hotel_collectible_total), 200000,
      'HOTEL_COLLECT: total must equal full net amount');
    assert.equal(txDetail4.payment_responsibility, 'HOTEL_COLLECT',
      'Responsibility must be HOTEL_COLLECT');

    // Settle partial
    const settled4 = await settleTransactionPayment(pool, tx4.id, {
      property_id: propertyId,
      amount: 80000,
      payment_method: 'CASH',
      actor_name: 'Receptionist'
    });
    assert.equal(settled4.payment_status, 'PARTIALLY_PAID',
      'Partial payment must result in PARTIALLY_PAID');

    // Verify canonical state updated
    const txDetail4b = await getTransactionById(pool, propertyId, tx4.id);
    assert.equal(Number(txDetail4b.canonical_amount_paid), 80000,
      'canonical_amount_paid must be 80,000');
    assert.equal(Number(txDetail4b.hotel_collectible_remaining_balance), 120000,
      'Remaining must be 120,000');

    // Verify getEffectivePaymentStateForReservation sees the payment
    const payState4 = await getEffectivePaymentStateForReservation(pool, resId4, propertyId);
    assert.ok(payState4.directPaid >= 80000,
      'getEffectivePaymentStateForReservation must see the 80k payment');
    assert.ok(payState4.canonicalSourceExists,
      'Must have at least one direct payment source');

    // Track the single canonical payment row for cleanup
    const payRow4 = await pool.query(
      `SELECT id FROM payment_transactions
        WHERE reservation_id = $1 AND scope = 'ROOM_RESERVATION'
        ORDER BY id LIMIT 1`,
      [resId4]
    );
    if (payRow4.rows.length > 0) {
      cleanupPt.push(Number(payRow4.rows[0].id));
    }

    console.log('  PASSED');

    // =====================================================================
    // T5: NON-RESERVATION TRANSACTION
    // =====================================================================
    console.log('\nTest T5: NON-RESERVATION TRANSACTION');
    const suffix5 = Date.now() + '-T5';
    const tx5 = await createManualTransaction(pool, {
      property_id: propertyId,
      transaction_type: 'EXPENSE',
      category_code: 'PETTY_CASH',
      description: `Beli tinta printer ${suffix5}`,
      amount: 150000,
      payment_method: 'CASH',
      actor_name: 'Staff Backend'
    });
    cleanupTx.push(tx5.id);
    assert.ok(!tx5.reservation_id || Number(tx5.reservation_id) === 0,
      'Expense must not have reservation_id');

    const txDetail5 = await getTransactionById(pool, propertyId, tx5.id);
    assert.equal(txDetail5.hotel_collectible_total, undefined,
      'Non-reservation must not have hotel_collectible_total');
    assert.equal(txDetail5.hotel_collectible_remaining_balance, undefined,
      'Non-reservation must not have hotel_collectible_remaining_balance');

    // Settle must use legacy outstanding path
    const settled5 = await settleTransactionPayment(pool, tx5.id, {
      property_id: propertyId,
      amount: 150000,
      payment_method: 'TRANSFER',
      actor_name: 'Staff Backend'
    });
    assert.equal(settled5.payment_status, 'PAID',
      'Full settlement of expense must be PAID');

    // Verify non-reservation payment row shape
    const payRows5 = await pool.query(
      `SELECT id, transaction_id, reservation_id, booking_id, scope
         FROM payment_transactions
         WHERE transaction_id = $1 AND property_id = $2
           AND reference_code LIKE 'PELUNASAN-%'
           AND created_at > NOW() - INTERVAL '10 seconds'`,
      [tx5.id, propertyId]
    );
    assert.equal(payRows5.rows.length, 1,
      'Non-reservation settlement must create exactly one payment row');
    const pt5 = payRows5.rows[0];
    assert.equal(pt5.transaction_id, String(tx5.id),
      'Payment row must link to transaction_id');
    assert.equal(pt5.scope, 'ROOM_RESERVATION',
      'Non-reservation legacy payment gets default scope=ROOM_RESERVATION');
    assert.equal(pt5.reservation_id, null,
      'Non-reservation payment must not have reservation_id');
    assert.equal(pt5.booking_id, null,
      'Non-reservation payment must not have booking_id');
    cleanupPt.push(Number(pt5.id));

    console.log('  PASSED');

    // =====================================================================
    // T6: SINGLE ROW INVARIANT
    // =====================================================================
    console.log('\nTest T6: SINGLE ROW INVARIANT');
    const suffix6 = Date.now() + '-T6';
    const b6 = await pool.query(
      `INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status)
       VALUES ($1,$2,$3,'ACTIVE') RETURNING id`,
      [`BID-T6-${suffix6}`, propertyId, `Guest T6 ${suffix6}`]
    );
    const bookingId6 = Number(b6.rows[0].id);
    cleanupBooking.push(bookingId6);

    const r6 = await pool.query(
      `INSERT INTO reservations (booking_id, booking_number, stay_sequence, guest_name,
        total_price, amount_paid, remaining_balance, payment_status, status,
        check_in, check_out, stay_type)
       VALUES ($1,$2,1,$3,75000,0,75000,'UNPAID','BOOKED',
        '2027-01-15','2027-01-16','OVERNIGHT') RETURNING id`,
      [bookingId6, `RES-T6-${suffix6}`, `Guest T6 ${suffix6}`]
    );
    const resId6 = Number(r6.rows[0].id);
    cleanupRes.push(resId6);

    // Set payment_responsibility on the BOOKING (HOTEL_COLLECT is default)

    const fe6 = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type,
        description, amount, direction, status)
       VALUES ($1,$2,'EARLY_CHECKIN','EARLY_CHECKIN','Early Check-in Fee',75000,'DEBIT','POSTED') RETURNING id`,
      [resId6, propertyId]
    );
    cleanupFe.push(Number(fe6.rows[0].id));

    const tx6 = await projectFolioEntryToTransaction(pool, Number(fe6.rows[0].id), { propertyId });
    cleanupTx.push(tx6.id);

    // Three separate settlement actions
    await settleTransactionPayment(pool, tx6.id, {
      property_id: propertyId, amount: 25000,
      payment_method: 'CASH', actor_name: 'Staff A'
    });
    await settleTransactionPayment(pool, tx6.id, {
      property_id: propertyId, amount: 25000,
      payment_method: 'TRANSFER', actor_name: 'Staff B'
    });
    await settleTransactionPayment(pool, tx6.id, {
      property_id: propertyId, amount: 25000,
      payment_method: 'QRIS', actor_name: 'Staff C'
    });

    // Each action creates exactly ONE canonical payment row
    const payRows6 = await pool.query(
      `SELECT id, transaction_id, reservation_id, booking_id, scope, amount
       FROM payment_transactions
       WHERE reservation_id = $1 AND scope = 'ROOM_RESERVATION'
       ORDER BY id`,
      [resId6]
    );
    assert.equal(payRows6.rows.length, 3,
      'Three settlement actions must create exactly three ROOM_RESERVATION payment rows');

    for (const row of payRows6.rows) {
      assert.ok(row.transaction_id, 'Each row must have transaction_id');
      assert.equal(Number(row.reservation_id), resId6,
        'Each row must have correct reservation_id');
      assert.equal(row.scope, 'ROOM_RESERVATION',
        'Each row must have scope=ROOM_RESERVATION');
      cleanupPt.push(Number(row.id));
    }

    // Transaction payment_status must be PAID
    const txDetail6 = await getTransactionById(pool, propertyId, tx6.id);
    assert.equal(txDetail6.payment_status, 'PAID',
      'After 3x25k payments, transaction must be PAID');
    assert.equal(Number(txDetail6.canonical_amount_paid), 75000,
      'canonical_amount_paid must reflect sum of all payments');
    assert.equal(Number(txDetail6.hotel_collectible_remaining_balance), 0,
      'Remaining must be 0 after full settlement');

    // No legacy duplicate rows
    const legacyCount = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM payment_transactions
       WHERE transaction_id = $1 AND (reservation_id IS NULL OR scope IS NULL)`,
      [tx6.id]
    );
    assert.equal(legacyCount.rows[0].cnt, 0,
      'No legacy duplicate payment rows must exist for reservation-linked transactions');

    console.log('  PASSED');

    console.log('\n=== ALL UI-3 OTA COLLECT REGRESSION TESTS PASSED ===');
  } catch (err) {
    console.error('REGRESSION TEST FAILED:', err);
    throw err;
  } finally {
    console.log('Cleaning up fixtures...');
    for (const ptId of cleanupPt) {
      await pool.query('DELETE FROM payment_transactions WHERE id = $1', [ptId]).catch(() => {});
    }
    for (const txId of cleanupTx) {
      await pool.query('DELETE FROM transactions WHERE id = $1', [txId]).catch(() => {});
    }
    for (const feId of cleanupFe) {
      await pool.query('DELETE FROM folio_entries WHERE id = $1', [feId]).catch(() => {});
    }
    for (const resId of cleanupRes) {
      await pool.query('DELETE FROM reservations WHERE id = $1', [resId]).catch(() => {});
    }
    for (const bId of cleanupBooking) {
      await pool.query('DELETE FROM bookings WHERE id = $1', [bId]).catch(() => {});
    }
  }
}

runTests().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
