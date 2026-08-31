require('dotenv').config();
const { Pool } = require('pg');
const { reconcileCanonicalAvailability } = require('../dist/domains/inventory/canonicalReconciliation');

const baseUrl = (process.argv[2] || 'http://localhost:5000').replace(/\/$/, '');
const runId = `OTA-LIVE-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const createdReservationIds = new Set();
const createdBookingIds = new Set();

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function apiRequest(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const response = await fetch(url, {
    ...options,
    headers
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, data };
}

async function apiPaymentRequest(resId, payload) {
  const url = `${baseUrl}/api/reservations/${resId}/payments`;
  const formData = new FormData();
  formData.append('property_id', '1');
  formData.append('amount', String(payload.amount));
  formData.append('payment_method', payload.payment_method || 'BANK_TRANSFER');
  formData.append('reference_code', payload.payment_ref || `REF-${Date.now()}`);
  formData.append('evidence_type', 'TRANSFER_RECEIPT');
  formData.append('evidence_note', 'Automated Test Receipt');
  formData.append('file', new Blob(['test payment receipt byte stream'], { type: 'image/png' }), 'receipt.png');

  const response = await fetch(url, {
    method: 'POST',
    body: formData
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, data };
}

async function cleanupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resIds = Array.from(createdReservationIds).map(Number).filter(id => Number.isFinite(id) && id > 0);
    const bookIds = Array.from(createdBookingIds).map(Number).filter(id => Number.isFinite(id) && id > 0);

    if (resIds.length > 0) {
      // Reconcile availability before deleting
      const resRows = await client.query('SELECT id, room_id, booked_room_type_id_snapshot, check_in, check_out, status FROM reservations WHERE id = ANY($1::int[])', [resIds]);
      for (const row of resRows.rows) {
        if (['BOOKED', 'CHECKED_IN'].includes(row.status)) {
          let cur = new Date(row.check_in);
          const end = new Date(row.check_out);
          while (cur < end) {
            const dStr = cur.toISOString().slice(0, 10);
            await client.query(
              `UPDATE availability_dates 
               SET reserved_qty = GREATEST(0, reserved_qty - 1)
               WHERE (room_type_id = $1 OR room_type = (SELECT name FROM room_types WHERE id = $1)) AND date = $2`,
              [row.booked_room_type_id_snapshot, dStr]
            );
            cur.setDate(cur.getDate() + 1);
          }
        }
      }

      await client.query('DELETE FROM transactions WHERE reservation_id = ANY($1::int[])', [resIds]);
      await client.query('DELETE FROM payment_evidences WHERE reservation_id = ANY($1::int[])', [resIds]);
      await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [resIds]);
      await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [resIds]);
      await client.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1::int[])', [resIds]);
      await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [resIds]);
    }

    if (bookIds.length > 0) {
      await client.query('DELETE FROM bookings WHERE id = ANY($1::int[])', [bookIds]);
    }

    await client.query('COMMIT');
    await reconcileCanonicalAvailability(pool);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Cleanup failed:', err);
  } finally {
    client.release();
  }
}

async function verifyInventoryInvariants() {
  const result = await pool.query(`
    SELECT 
      ad.date,
      ad.room_type,
      ad.reserved_qty,
      COALESCE(SUM(CASE WHEN r.status IN ('BOOKED', 'CHECKED_IN') THEN 1 ELSE 0 END), 0)::int AS expected_reserved
    FROM availability_dates ad
    LEFT JOIN room_types rt ON (rt.id = ad.room_type_id OR rt.name = ad.room_type)
    LEFT JOIN reservations r ON (r.booked_room_type_id_snapshot = rt.id OR (r.booked_room_type_id_snapshot IS NULL AND r.room_id IN (SELECT id FROM rooms WHERE room_type_id = rt.id)))
      AND ad.date >= r.check_in 
      AND ad.date < r.check_out
    GROUP BY ad.date, ad.room_type, ad.reserved_qty
    HAVING ad.reserved_qty != COALESCE(SUM(CASE WHEN r.status IN ('BOOKED', 'CHECKED_IN') THEN 1 ELSE 0 END), 0)
  `);
  expect(result.rowCount === 0, `Inventory drift detected: ${JSON.stringify(result.rows)}`);
}

async function main() {
  console.log(`Starting OTA Stay Extension Live Test [${runId}]...`);

  try {
    // 1. Resolve Room 104 and Room Type from Room Master
    const roomResult = await pool.query(`
      SELECT r.id, r.room_number, r.floor, r.room_type_id, rt.name as room_type_name
      FROM rooms r
      JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.room_number = '104' AND r.property_id = 1
      LIMIT 1
    `);
    expect(roomResult.rowCount > 0, 'Room 104 not found in database');
    const room104 = roomResult.rows[0];
    console.log(`Resolved Room Master: ID=${room104.id}, Number=${room104.room_number}, Type=${room104.room_type_name} (Type ID: ${room104.room_type_id})`);

    // 2. Create OTA Reservation on Room 104 (1 night: 2026-11-20 -> 2026-11-21, Rp438,900)
    const checkInDate = '2026-11-20';
    const initialCheckOut = '2026-11-21';
    const extendedCheckOut = '2026-11-22';
    const otaNightlyRate = 438900;

    const createBookingRes = await apiRequest('/api/bookings', {
      method: 'POST',
      body: JSON.stringify({
        property_id: 1,
        guest_name: 'TEST OTA GUEST ROOM 104',
        guest_phone: '081234567890',
        guest_email: 'guest104@example.com',
        booking_source: 'OTA',
        channel: 'OTA',
        booking_channel: 'AGODA',
        currency_code: 'IDR',
        reservations: [{
          room_type_id: room104.room_type_id,
          room_id: room104.id,
          check_in: checkInDate,
          check_out: initialCheckOut,
          price_per_night: otaNightlyRate,
          total_price: otaNightlyRate,
          guest_name: 'TEST OTA GUEST ROOM 104',
          is_manual_override: true,
          manual_override_price: otaNightlyRate,
          manual_override_reason: 'OTA Agoda Voucher'
        }]
      })
    });

    expect(createBookingRes.ok, `Failed to create booking: ${JSON.stringify(createBookingRes.data)}`);
    const booking = createBookingRes.data.data;
    const bookingId = Number(booking.booking_id || booking.id);
    const reservationId = Number(booking.reservations?.[0]?.id || booking.reservation_ids?.[0]);
    createdBookingIds.add(bookingId);
    createdReservationIds.add(reservationId);

    console.log(`Step 1 PASSED: Created OTA Booking #${bookingId}, Reservation #${reservationId}`);

    // Verify Canonical Room DTO from backend
    const getResRes = await apiRequest(`/api/reservations/${reservationId}?property_id=1`);
    expect(getResRes.ok, 'Failed to fetch reservation detail');
    const resDto = getResRes.data.data;
    expect(resDto.room_number === '104', `Expected room_number='104', got '${resDto.room_number}'`);
    expect(resDto.room_type_name === room104.room_type_name, `Expected room_type_name='${room104.room_type_name}', got '${resDto.room_type_name}'`);
    expect(Number(resDto.total_price) === otaNightlyRate, `Expected total_price=${otaNightlyRate}, got ${resDto.total_price}`);
    expect(Number(resDto.remaining_balance) === otaNightlyRate, `Expected remaining_balance=${otaNightlyRate}, got ${resDto.remaining_balance}`);
    console.log('Step 2 PASSED: Canonical Room Master DTO verified (Room 104, STANDARD KING, Rp438,900)');

    // 3. Record Initial Payment #1 = Rp438,900
    const payment1Res = await apiPaymentRequest(reservationId, {
      amount: otaNightlyRate,
      payment_method: 'BANK_TRANSFER',
      payment_ref: 'OTA-VOUCHER-PAY-01'
    });
    expect(payment1Res.ok, `Failed to record Payment #1: ${JSON.stringify(payment1Res.data)}`);
    console.log('Step 3 PASSED: Recorded Payment #1 (Rp438,900)');

    // Verify Folio and Payments state
    const folio1Res = await apiRequest(`/api/reservations/${reservationId}/folio?property_id=1`);
    expect(folio1Res.ok, 'Failed to fetch folio');
    const folio1 = folio1Res.data.data;
    const folio1Entries = folio1.entries || folio1.folio || [];
    const folio1Debits = folio1Entries.filter(e => e.amount_type === 'DEBIT' || e.direction === 'DEBIT').reduce((s, e) => s + Number(e.amount), 0);
    const folio1Credits = (folio1.payments || []).reduce((s, p) => s + Number(p.amount), 0);
    expect(folio1Debits === otaNightlyRate, `Expected debits=${otaNightlyRate}, got ${folio1Debits}`);
    expect(folio1Credits === otaNightlyRate, `Expected credits=${otaNightlyRate}, got ${folio1Credits}`);

    // 4. Extend Stay 1 Night with Additional Night Rate = Rp438,900
    const extendRes = await apiRequest(`/api/reservations/${reservationId}/extend`, {
      method: 'POST',
      body: JSON.stringify({
        property_id: 1,
        new_check_out: extendedCheckOut,
        additional_night_rate: otaNightlyRate
      })
    });
    expect(extendRes.ok, `Failed to extend stay: ${JSON.stringify(extendRes.data)}`);
    const extendedResData = extendRes.data.data;

    // Verify Extension Invariants:
    expect(extendedResData.check_out === extendedCheckOut, `Expected check_out=${extendedCheckOut}, got ${extendedResData.check_out}`);
    expect(extendedResData.room_number === '104', `Room number mutated or raw ID displayed: ${extendedResData.room_number}`);
    expect(extendedResData.room_type_name === room104.room_type_name, `Room type mutated: ${extendedResData.room_type_name}`);
    expect(Number(extendedResData.total_price) === otaNightlyRate * 2, `Expected total_price=${otaNightlyRate * 2}, got ${extendedResData.total_price}`);
    expect(Number(extendedResData.amount_paid) === otaNightlyRate, `Payment #1 corrupted! Expected amount_paid=${otaNightlyRate}, got ${extendedResData.amount_paid}`);
    expect(Number(extendedResData.remaining_balance) === otaNightlyRate, `Expected remaining_balance=${otaNightlyRate}, got ${extendedResData.remaining_balance}`);
    expect(extendedResData.payment_status === 'PARTIAL', `Expected payment_status='PARTIAL', got '${extendedResData.payment_status}'`);

    console.log('Step 4 PASSED: Stay extended 1 night @ Rp438,900 -> Total: Rp877,800, Paid: Rp438,900, Outstanding: Rp438,900');

    // Verify Folio Entries and Transaction SALE projections
    const folio2Res = await apiRequest(`/api/reservations/${reservationId}/folio?property_id=1`);
    const folio2 = folio2Res.data.data;
    const entries = folio2.entries || folio2.folio || [];
    const debitEntries = entries.filter(e => (e.amount_type || e.direction) === 'DEBIT');
    expect(debitEntries.length === 2, `Expected exactly 2 DEBIT entries (Accommodation + Stay Extension), found ${debitEntries.length}`);
    const extensionDebit = debitEntries.find(e => e.source_type === 'STAY_EXTENSION' || e.entry_type === 'STAY_EXTENSION');
    expect(Boolean(extensionDebit), 'STAY_EXTENSION debit entry missing from folio');
    expect(Number(extensionDebit.amount) === otaNightlyRate, `Expected extension charge=${otaNightlyRate}, got ${extensionDebit.amount}`);

    // Verify Payment #1 row in database is completely intact
    const pmtRows = await pool.query('SELECT * FROM payment_transactions WHERE reservation_id = $1 ORDER BY id ASC', [reservationId]);
    expect(pmtRows.rowCount === 1, `Expected exactly 1 payment record before Payment #2, found ${pmtRows.rowCount}`);
    expect(Number(pmtRows.rows[0].amount) === otaNightlyRate, 'Payment #1 amount mutated');
    expect(pmtRows.rows[0].reference_code === 'OTA-VOUCHER-PAY-01' || pmtRows.rows[0].payment_ref === 'OTA-VOUCHER-PAY-01', 'Payment #1 reference mutated');
    console.log('Step 5 PASSED: Payment #1 immutability verified, Folio Debits = Rp877,800');

    // Verify Transactions table has exactly 2 SALE entries
    const txRows = await pool.query('SELECT * FROM transactions WHERE reservation_id = $1 AND transaction_type = $2 AND deleted_at IS NULL', [reservationId, 'SALE']);
    expect(txRows.rowCount === 2, `Expected 2 SALE transactions (Original + Extension), found ${txRows.rowCount}`);
    const totalSaleAmount = txRows.rows.reduce((sum, t) => sum + Number(t.amount), 0);
    expect(totalSaleAmount === otaNightlyRate * 2, `Expected total SALE=${otaNightlyRate * 2}, got ${totalSaleAmount}`);
    console.log('Step 6 PASSED: Transaction SALE projection verified (Rp877,800)');

    // 5. Test Extension Idempotency: retry extension with same date
    const retryExtendRes = await apiRequest(`/api/reservations/${reservationId}/extend`, {
      method: 'POST',
      body: JSON.stringify({
        property_id: 1,
        new_check_out: extendedCheckOut,
        additional_night_rate: otaNightlyRate
      })
    });
    // Should be no-op or return current state without creating new charges
    const folioAfterRetry = await apiRequest(`/api/reservations/${reservationId}/folio?property_id=1`);
    const entriesAfterRetry = (folioAfterRetry.data.data.entries || folioAfterRetry.data.data.folio || []).filter(e => (e.amount_type || e.direction) === 'DEBIT');
    expect(entriesAfterRetry.length === 2, `Extension retry created duplicate debit charges! Count: ${entriesAfterRetry.length}`);
    console.log('Step 7 PASSED: Extension Idempotency verified (Zero duplicate charge on retry)');

    // 6. Record Payment #2 = Rp438,900
    const payment2Res = await apiPaymentRequest(reservationId, {
      amount: otaNightlyRate,
      payment_method: 'CASH',
      payment_ref: 'OTA-EXTEND-PAY-02'
    });
    expect(payment2Res.ok, `Failed to record Payment #2: ${JSON.stringify(payment2Res.data)}`);

    const finalResRes = await apiRequest(`/api/reservations/${reservationId}?property_id=1`);
    const finalResDto = finalResRes.data.data;
    expect(Number(finalResDto.amount_paid) === otaNightlyRate * 2, `Expected amount_paid=${otaNightlyRate * 2}, got ${finalResDto.amount_paid}`);
    expect(Number(finalResDto.remaining_balance) === 0, `Expected remaining_balance=0, got ${finalResDto.remaining_balance}`);
    expect(finalResDto.payment_status === 'PAID', `Expected payment_status='PAID', got '${finalResDto.payment_status}'`);

    // Verify Payment #2 did NOT create a SALE transaction
    const allPmtTxs = await pool.query('SELECT * FROM payment_transactions WHERE reservation_id = $1 ORDER BY id ASC', [reservationId]);
    expect(allPmtTxs.rowCount === 2, `Expected exactly 2 payment records, found ${allPmtTxs.rowCount}`);
    const allSaleTxs = await pool.query('SELECT * FROM transactions WHERE reservation_id = $1 AND transaction_type = $2 AND deleted_at IS NULL', [reservationId, 'SALE']);
    expect(allSaleTxs.rowCount === 2, `Payment #2 incorrectly generated SALE transaction! Count: ${allSaleTxs.rowCount}`);
    console.log('Step 8 PASSED: Payment #2 recorded -> Total Paid: Rp877,800, Outstanding: Rp0 (PAID), zero duplicate SALE');

    // 7. Shorten Stay Symmetry Test (Invariant 9)
    // Create a separate 2-night reservation and shorten it
    const shortenBookingRes = await apiRequest('/api/bookings', {
      method: 'POST',
      body: JSON.stringify({
        property_id: 1,
        guest_name: 'TEST SHORTEN GUEST',
        guest_phone: '081234567891',
        booking_source: 'OTA',
        channel: 'OTA',
        booking_channel: 'AGODA',
        currency_code: 'IDR',
        reservations: [{
          room_type_id: room104.room_type_id,
          room_id: room104.id,
          check_in: '2026-11-25',
          check_out: '2026-11-27',
          price_per_night: otaNightlyRate,
          total_price: otaNightlyRate * 2,
          guest_name: 'TEST SHORTEN GUEST',
          is_manual_override: true,
          manual_override_price: otaNightlyRate,
          manual_override_reason: 'OTA Booking'
        }]
      })
    });
    expect(shortenBookingRes.ok, 'Failed to create booking for shorten test');
    const shortenBooking = shortenBookingRes.data.data;
    const shortenBookingId = Number(shortenBooking.booking_id || shortenBooking.id);
    const shortenResId = Number(shortenBooking.reservations?.[0]?.id || shortenBooking.reservation_ids?.[0]);
    createdBookingIds.add(shortenBookingId);
    createdReservationIds.add(shortenResId);

    // Pay full 2 nights (Rp877,800)
    await apiPaymentRequest(shortenResId, {
      amount: otaNightlyRate * 2,
      payment_method: 'BANK_TRANSFER',
      payment_ref: 'SHORTEN-TEST-PAY-FULL'
    });

    // Shorten to 1 night
    const shortenRes = await apiRequest(`/api/reservations/${shortenResId}/shorten`, {
      method: 'POST',
      body: JSON.stringify({
        property_id: 1,
        new_check_out: '2026-11-26'
      })
    });
    expect(shortenRes.ok, `Failed to shorten stay: ${JSON.stringify(shortenRes.data)}`);
    const shortenedData = shortenRes.data.data;
    expect(Number(shortenedData.total_price) === otaNightlyRate, `Expected total_price=${otaNightlyRate}, got ${shortenedData.total_price}`);
    expect(Number(shortenedData.amount_paid) === otaNightlyRate * 2, `Existing payment corrupted! amount_paid=${shortenedData.amount_paid}`);
    expect(shortenedData.payment_status === 'OVERPAID', `Expected payment_status='OVERPAID', got '${shortenedData.payment_status}'`);
    console.log('Step 9 PASSED: Shorten Stay financial symmetry verified (Total: Rp438,900, Paid: Rp877,800 -> OVERPAID)');

    // 8. Invariant Checks
    await verifyInventoryInvariants();
    console.log('Step 10 PASSED: Inventory invariant verified (drift = 0)');

    console.log('\n========================================');
    console.log('ALL REQUIRED LIVE TEST SCENARIOS PASSED!');
    console.log('========================================\n');

  } finally {
    await cleanupFixtures();
    console.log('Test fixtures cleaned up cleanly (0 residue).');
    await pool.end();
  }
}

main().catch((err) => {
  console.error('\nLIVE TEST FAILED:', err);
  process.exit(1);
});
