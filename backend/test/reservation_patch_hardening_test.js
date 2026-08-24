const { Pool } = require('pg');

const baseUrl = (process.argv[2] || 'http://localhost:5000').replace(/\/$/, '');
const runId = `PATCH-HARDEN-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

let fetchFn = globalThis.fetch;
if (!fetchFn) {
  try {
    fetchFn = require('node-fetch');
  } catch (_e) {
    console.error('Global fetch is not available. Use Node 18+ or install node-fetch.');
    process.exit(1);
  }
}

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function toDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return toDateKey(date);
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function computeBillingSummary(baseSubtotal, discountAmountInput, discountPercentInput, amountPaidInput) {
  const subtotal = Math.max(Number(baseSubtotal || 0), 0);
  const discountPercent = Math.max(Number(discountPercentInput || 0), 0);
  const fixedDiscount = Math.max(Number(discountAmountInput || 0), 0);
  const computedDiscount = discountPercent > 0 ? subtotal * (discountPercent / 100) : fixedDiscount;
  const discount = Math.min(Math.max(computedDiscount, 0), subtotal);
  const totalAfterDiscount = Math.max(subtotal - discount, 0);
  const amountPaid = Math.max(Number(amountPaidInput || 0), 0);
  const remainingBalance = Math.max(totalAfterDiscount - amountPaid, 0);
  const paymentStatus = amountPaid <= 0 ? 'UNPAID' : remainingBalance <= 0.01 ? 'PAID' : 'PARTIAL';

  return {
    subtotal,
    discount,
    discountPercent,
    totalAfterDiscount,
    amountPaid,
    remainingBalance,
    paymentStatus
  };
}

async function request(method, path, body, correlationSuffix = '') {
  const correlationId = `${runId}${correlationSuffix ? `-${correlationSuffix}` : ''}`;
  const response = await fetchFn(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Correlation-Id': correlationId
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_e) {
    json = null;
  }
  return { status: response.status, text, json, correlationId };
}

async function getRooms() {
  const result = await pool.query(`
    SELECT r.id, COALESCE(rt.name, r.name) AS room_type
    FROM rooms r
    LEFT JOIN room_types rt ON rt.id = r.room_type_id
    ORDER BY r.id ASC
  `);
  assert(result.rows.length > 0, 'No rooms available for hardening test');
  return result.rows.map((row) => ({
    id: Number(row.id),
    roomType: String(row.room_type || '')
  }));
}

async function findReservationCandidate() {
  const rooms = await getRooms();
  const offsets = [45, 52, 59, 66, 73, 80, 87, 94, 101, 108, 115, 122, 129, 136];

  for (const room of rooms.slice(0, 8)) {
    for (const offset of offsets) {
      const checkIn = addDays(new Date().toISOString().slice(0, 10), offset);
      const checkOut = addDays(checkIn, 1);
      const payload = {
        room_id: room.id,
        guest_name: `${runId} guest`,
        guest_phone: `0819${String(room.id).padStart(8, '0')}`,
        check_in: checkIn,
        check_out: checkOut,
        total_price: 200000,
        qty: 1
      };
      const result = await request('POST', '/api/reservations', payload, `create-${room.id}-${offset}`);
      if (result.status === 201 && result.json?.data?.id) {
        return {
          room,
          checkIn,
          checkOut,
          response: result.json.data
        };
      }
    }
  }

  throw new Error('Unable to create a stable reservation candidate for patch hardening test');
}

async function fetchReservation(reservationId) {
  const result = await pool.query('SELECT * FROM reservations WHERE id = $1', [reservationId]);
  assert(result.rows.length === 1, `Reservation ${reservationId} not found`);
  return result.rows[0];
}

async function fetchAvailabilitySnapshot(roomType, checkIn, checkOut) {
  const dates = [];
  const current = new Date(`${checkIn}T00:00:00Z`);
  const end = new Date(`${checkOut}T00:00:00Z`);
  while (current < end) {
    dates.push(toDateKey(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  const result = await pool.query(
    `SELECT to_char(date::date, 'YYYY-MM-DD') AS date_key, reserved_qty
     FROM availability_dates
     WHERE room_type = $1
       AND date = ANY($2::date[])
     ORDER BY date`,
    [roomType, dates]
  );
  return result.rows.map((row) => ({
    date: String(row.date_key),
    reserved_qty: Number(row.reserved_qty)
  }));
}

async function countReservationAudits(reservationId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM audit_logs
     WHERE entity = 'RESERVATION'
       AND record_id = $1::text`,
    [String(reservationId)]
  );
  return Number(result.rows[0]?.count || 0);
}

async function countInventoryDrift() {
  const result = await pool.query(`
    WITH active_nights AS (
      SELECT
        COALESCE(rt.name, r.name) AS room_type,
        gs::date AS date_key,
        COUNT(*)::int AS expected_qty
      FROM reservations res
      JOIN rooms r ON r.id = res.room_id
      LEFT JOIN room_types rt ON rt.id = r.room_type_id
      JOIN LATERAL generate_series(
        res.check_in::date,
        (res.check_out::date - INTERVAL '1 day')::date,
        INTERVAL '1 day'
      ) AS gs ON TRUE
      WHERE res.status IN ('BOOKED', 'CHECKED_IN')
        AND res.check_in IS NOT NULL
        AND res.check_out IS NOT NULL
        AND res.check_out > res.check_in
      GROUP BY 1, 2
    )
    SELECT COUNT(*)::int AS drift_count
    FROM availability_dates ad
    LEFT JOIN active_nights an
      ON an.room_type = ad.room_type
     AND an.date_key = ad.date
    WHERE ad.reserved_qty IS DISTINCT FROM COALESCE(an.expected_qty, 0)
  `);
  return Number(result.rows[0]?.drift_count || 0);
}

async function cleanup(context) {
  if (!context?.reservationId) {
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reservation = await client.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [context.reservationId]);
    if (reservation.rows.length === 1) {
      const roomType = String(context.room.roomType || '');
      const dates = [];
      const current = new Date(`${context.checkIn}T00:00:00Z`);
      const end = new Date(`${context.checkOut}T00:00:00Z`);
      while (current < end) {
        dates.push(toDateKey(current));
        current.setUTCDate(current.getUTCDate() + 1);
      }

      for (const dateKey of dates) {
        await client.query(
          `UPDATE availability_dates
           SET reserved_qty = reserved_qty - 1
           WHERE room_type = $1 AND date = $2`,
          [roomType, dateKey]
        );
      }

      await client.query('DELETE FROM audit_logs WHERE entity = $1 AND record_id = $2::text', ['RESERVATION', String(context.reservationId)]);
      await client.query('DELETE FROM audit_logs WHERE entity = $1 AND record_id = $2::text', ['BOOKING', String(context.bookingId)]);
      await client.query('DELETE FROM folio_entries WHERE reservation_id = $1', [context.reservationId]);
      await client.query('DELETE FROM payment_transactions WHERE reservation_id = $1', [context.reservationId]);
      await client.query('DELETE FROM reservations WHERE id = $1', [context.reservationId]);
      await client.query('DELETE FROM bookings WHERE id = $1', [context.bookingId]);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  let context = null;
  let baselineReservation = null;
  let baselineAuditCount = null;

  try {
    context = await findReservationCandidate();
    const reservationId = Number(context.response.id);
    assert(Number.isFinite(reservationId), 'Reservation creation did not return a valid id');
    const bookingId = Number(context.response.booking_id);
    assert(Number.isFinite(bookingId), 'Reservation creation did not return a valid booking_id');
    context.reservationId = reservationId;
    context.bookingId = bookingId;
    baselineReservation = await fetchReservation(reservationId);
    baselineReservation = await fetchReservation(reservationId);
    baselineAuditCount = await countReservationAudits(reservationId);

    const safePatch = {
      guest_name: `${runId} updated guest`,
      guest_phone: '081234567890',
      guest_segment: 'Corporate',
      subtotal_amount: 250000,
      total_price: 220000,
      discount_amount: 20000,
      discount_percent: 8,
      amount_paid: 50000,
      payment_status: 'PARTIAL',
      ktp_path: `/tmp/${runId}/ktp.png`,
      bukti_bayar_path: `/tmp/${runId}/bukti.png`,
      booking_type: 'ota'
    };

    const patchResult = await request('PATCH', `/api/reservations/${reservationId}`, safePatch, 'metadata');
    assert(patchResult.status === 200, `Metadata PATCH failed: ${patchResult.status} ${patchResult.text}`);

    const updatedReservation = await fetchReservation(reservationId);
    const expectedBilling = computeBillingSummary(
      safePatch.total_price,
      safePatch.discount_amount,
      safePatch.discount_percent,
      safePatch.amount_paid
    );
    assert(updatedReservation.guest_name === safePatch.guest_name, 'guest_name was not updated');
    assert(updatedReservation.guest_phone === safePatch.guest_phone, 'guest_phone was not updated');
    assert(updatedReservation.guest_segment === safePatch.guest_segment, 'guest_segment was not updated');
    assert(Number(updatedReservation.total_price) === Number(expectedBilling.totalAfterDiscount), 'total_price was not updated');
    assert(String(updatedReservation.payment_status) === safePatch.payment_status, 'payment_status was not updated');
    assert(Number(updatedReservation.discount_amount) === Number(expectedBilling.discount), 'discount_amount was not updated');
    assert(Number(updatedReservation.discount_percent) === Number(expectedBilling.discountPercent), 'discount_percent was not updated');
    assert(Number(updatedReservation.amount_paid) === Number(expectedBilling.amountPaid), 'amount_paid was not updated');
    assert(Number(updatedReservation.remaining_balance) === Number(expectedBilling.remainingBalance), 'remaining_balance was not updated');
    assert(String(updatedReservation.booking_type).toUpperCase() === 'OTA', 'booking_type was not normalized to OTA');
    assert(updatedReservation.room_id === baselineReservation.room_id, 'room_id changed during metadata PATCH');
    assert(String(updatedReservation.check_in) === String(baselineReservation.check_in), 'check_in changed during metadata PATCH');
    assert(String(updatedReservation.check_out) === String(baselineReservation.check_out), 'check_out changed during metadata PATCH');
    assert(String(updatedReservation.status) === String(baselineReservation.status), 'status changed during metadata PATCH');
    assert(String(updatedReservation.stay_status) === String(baselineReservation.stay_status), 'stay_status changed during metadata PATCH');

    const auditCountAfterPatch = await countReservationAudits(reservationId);
    assert(auditCountAfterPatch === baselineAuditCount + 1, 'Reservation update audit was not written');

    const criticalCases = [
      ['status', 'CANCELLED'],
      ['stay_status', 'CANCELLED'],
      ['room_id', context.room.id + 999],
      ['check_in', addDays(context.checkIn, 1)],
      ['check_out', addDays(context.checkOut, 1)],
      ['booking_id', bookingId + 999],
      ['stay_sequence', Number(baselineReservation.stay_sequence || 1) + 1]
    ];

    for (const [field, value] of criticalCases) {
      const beforeReservation = await fetchReservation(reservationId);
      const beforeAvailability = await fetchAvailabilitySnapshot(context.room.roomType, context.checkIn, context.checkOut);
      const response = await request('PATCH', `/api/reservations/${reservationId}`, { [field]: value }, `critical-${field}`);
      assert(response.status === 409, `Critical PATCH for ${field} was not rejected with 409: ${response.status} ${response.text}`);
      const afterReservation = await fetchReservation(reservationId);
      const afterAvailability = await fetchAvailabilitySnapshot(context.room.roomType, context.checkIn, context.checkOut);
      assert(sameJson(beforeReservation, afterReservation), `Reservation changed after rejected PATCH for ${field}`);
      assert(sameJson(beforeAvailability, afterAvailability), `Availability changed after rejected PATCH for ${field}`);
    }

  } finally {
    if (context?.reservationId) {
      await cleanup(context);
    }
  }

  const driftCount = await countInventoryDrift();

  console.log('Reservation PATCH hardening');
  console.log('PASS | metadata-safe PATCH succeeds');
  console.log('PASS | critical lifecycle fields rejected with 409 and zero mutation');
  console.log('PASS | reservation update audit written');
  console.log(`PASS | authoritative inventory drift after cleanup: ${driftCount}`);

  if (driftCount !== 0) {
    throw new Error(`Expected authoritative inventory drift to be 0, got ${driftCount}`);
  }

  await pool.end();
}

main().catch(async (error) => {
  console.error('FAIL | reservation PATCH hardening test failed:', error.message);
  try {
    await pool.end();
  } catch (_e) {
    // ignore pool shutdown errors on failure
  }
  process.exit(1);
});
