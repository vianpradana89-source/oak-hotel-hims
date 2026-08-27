// idempotency_test.js
// Sends two concurrent identical requests with same Idempotency-Key and checks response equality

const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

const url = process.argv[2] || 'http://localhost:5000/api/reservations';
const key = 'idem-test-' + Date.now();

let fetchFn = globalThis.fetch || require('node-fetch');

async function send(payload) {
  const resp = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(payload)
  });
  const text = await resp.text();
  return { status: resp.status, body: text };
}

(async () => {
  try {
    const propRes = await pool.query('SELECT id FROM properties ORDER BY id LIMIT 1');
    const propertyId = Number(propRes.rows[0].id);

    const roomRes = await pool.query('SELECT id FROM rooms WHERE property_id = $1 AND is_active = TRUE ORDER BY id LIMIT 1', [propertyId]);
    const roomId = Number(roomRes.rows[0].id);

    const checkIn = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    const checkOut = new Date(Date.now() + 41 * 86400000).toISOString().slice(0, 10);

    const payload = {
      property_id: propertyId,
      room_id: roomId,
      guest_name: 'Idem Tester',
      guest_phone: '081900000000',
      check_in: checkIn,
      check_out: checkOut,
      total_price: 100000,
      qty: 1
    };

    console.log('Sending 2 concurrent requests with same idempotency key:', key);
    const [r1, r2] = await Promise.all([send(payload), send(payload)]);
    console.log('Response 1:', r1.status, r1.body);
    console.log('Response 2:', r2.status, r2.body);

    const isMatch = r1.status === r2.status && r1.body === r2.body;
    if (isMatch) {
      console.log('OK: responses identical');
    } else {
      console.log('FAIL: responses differ');
      process.exitCode = 1;
    }

    // Cleanup created reservation/booking
    let parsed = null;
    try { parsed = JSON.parse(r1.body); } catch (_) {}
    if (parsed && parsed.data && parsed.data.id) {
      const resId = parsed.data.id;
      const bId = parsed.data.booking_id;
      await pool.query('DELETE FROM folio_entries WHERE reservation_id = $1', [resId]);
      await pool.query('DELETE FROM payment_transactions WHERE reservation_id = $1', [resId]);
      await pool.query('DELETE FROM availability_locks WHERE reservation_id = $1', [resId]);
      await pool.query("DELETE FROM audit_logs WHERE entity = 'RESERVATION' AND record_id = $1::text", [String(resId)]);
      await pool.query('DELETE FROM reservations WHERE id = $1', [resId]);
      if (bId) {
        await pool.query("DELETE FROM audit_logs WHERE entity = 'BOOKING' AND record_id = $1::text", [String(bId)]);
        await pool.query('DELETE FROM bookings WHERE id = $1', [bId]);
      }
      await pool.query('UPDATE availability_dates SET reserved_qty = GREATEST(0, reserved_qty - 1) WHERE room_type_id = 1 AND date = $1::date', [checkIn]);
    }
    await pool.query('DELETE FROM idempotency_keys WHERE key = $1', [key]);
  } catch (err) {
    console.error('Idempotency test execution error:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
