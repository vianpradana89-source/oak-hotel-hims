// backend/src/index.ts
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { Pool } from 'pg';
import { initializeDatabase } from './db/schema_v3';

const app: any = express();
app.use(cors());
app.use(express.json());

const uploadDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req: any, _file: any, cb: (error: Error | null, destination: string) => void) => cb(null, uploadDir),
    filename: (_req: any, file: any, cb: (error: Error | null, filename: string) => void) => {
      const ext = path.extname(file.originalname || 'upload');
      const safeName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
      cb(null, safeName);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req: any, file: any, cb: any) => {
    const allowed = ['image/jpeg', 'image/png', 'application/pdf'];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Unsupported file type'));
  }
});

const hasRows = (result: { rowCount?: number | null } | null | undefined): boolean => Number(result?.rowCount ?? 0) > 0;

const parseDecimal = (value: any, fallback = 0) => {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? number : Number(fallback);
};

const computeBillingSummary = (baseSubtotal: any, discountAmountInput: any, discountPercentInput: any, amountPaidInput: any) => {
  const subtotal = Math.max(parseDecimal(baseSubtotal, 0), 0);
  const discountPercent = Math.max(parseDecimal(discountPercentInput, 0), 0);
  const fixedDiscount = Math.max(parseDecimal(discountAmountInput, 0), 0);
  const computedDiscount = discountPercent > 0 ? subtotal * (discountPercent / 100) : fixedDiscount;
  const discount = Math.min(Math.max(computedDiscount, 0), subtotal);
  const totalAfterDiscount = Math.max(subtotal - discount, 0);
  const amountPaid = Math.max(parseDecimal(amountPaidInput, 0), 0);
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
};

// Idempotency middleware
import { computeRequestHash } from './utils/hash';
app.use(async (req, res, next) => {
  // Only for mutating methods
  if (!['POST','PUT','PATCH','DELETE'].includes(req.method)) return next();
  const key = req.headers['idempotency-key'] || req.headers['Idempotency-Key'] || req.headers['Idempotency-Key'.toLowerCase()];
  if (!key) return next();

  const idKey = String(key);
  try {
    const reqHash = computeRequestHash(req.method, req.path, req.body);
    const row = await pool.query('SELECT request_hash, response_body, status_code, expires_at FROM idempotency_keys WHERE key = $1', [idKey]);
    if (hasRows(row)) {
      const r = row.rows[0];
      // expired
      if (r.expires_at && new Date(r.expires_at) < new Date()) {
        // delete expired and allow processing
        await pool.query('DELETE FROM idempotency_keys WHERE key = $1', [idKey]);
        return next();
      }
      if (r.request_hash !== reqHash) {
        return res.status(409).json({ status: 'FAILED', message: 'Idempotency key conflict: different request payload' });
      }
      if (r.response_body) {
        res.setHeader('X-Idempotency', 'HIT');
        return res.status(r.status_code || 200).send(r.response_body);
      }
        // in-progress: wait for completion up to a configured wait time
        const waitSeconds = Number(process.env.IDEMPOTENCY_WAIT_SECONDS || 10);
        const intervalMs = 500;
        const maxIter = Math.ceil((waitSeconds * 1000) / intervalMs);
        for (let i = 0; i < maxIter; i++) {
          await new Promise((r) => setTimeout(r, intervalMs));
          const check = await pool.query('SELECT response_body, status_code, expires_at FROM idempotency_keys WHERE key = $1', [idKey]);
          if (hasRows(check) && check.rows[0].response_body) {
            const cr = check.rows[0];
            res.setHeader('X-Idempotency', 'HIT');
            return res.status(cr.status_code || 200).send(cr.response_body);
          }
        }
        // still in-progress
        return res.status(202).json({ status: 'IN_PROGRESS' });
      }

    // Insert a placeholder to mark in-progress
    const expiresAt = new Date(Date.now() + (Number(process.env.IDEMPOTENCY_TTL_MINUTES || 1440) * 60 * 1000));
    await pool.query('INSERT INTO idempotency_keys (key, request_hash, expires_at) VALUES ($1, $2, $3)', [idKey, reqHash, expiresAt.toISOString()]);
    // Attach idempotency key to request for later saving
    (req as any)._idempotency_key = idKey;
    (req as any)._request_hash = reqHash;

    return next();
  } catch (err) {
    console.error('Idempotency middleware error', err);
    return res.status(500).json({ status: 'ERROR', message: 'Idempotency middleware error' });
  }
});


const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db',
});

// Simple SSE clients registry
const sseClients: Array<import('express').Response> = [];
function broadcastEvent(eventType: string, payload: any) {
  const data = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch (e) {
      console.error('Error writing to SSE client', e);
    }
  }
}

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders && res.flushHeaders();
  res.write('retry: 10000\n\n');
  sseClients.push(res);
  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

async function startServer() {
  try {
    await initializeDatabase(pool);
    await reconcileAvailabilityDates(pool);
    console.log('Database connected & initialized successfully.');
  } catch (err: any) {
    console.error('WARNING: Database connection failed:', err.message);
  }

  app.listen(5000, () => {
    console.log('Backend running on port 5000');
  });
}

startServer();

// Helper generate booking identifier with source-based prefix.
// Example: WALKIN-20260821-0001 or OTA-20260821-0001.
async function generateBookingId(client: any, source: string = 'WALKIN'): Promise<string> {
  const normalizedSource = String(source || 'WALKIN').toUpperCase() === 'OTA' ? 'OTA' : 'WALKIN';
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `${normalizedSource}-${dateStr}-`;

  const res = await client.query(
    `SELECT COALESCE(MAX(CAST(SPLIT_PART(booking_number, '-', 3) AS INTEGER)), 0) + 1 AS next_seq
     FROM reservations WHERE booking_number LIKE $1`,
    [`${prefix}%`]
  );

  const nextSeq = Number(res.rows[0]?.next_seq ?? 1);
  return `${prefix}${String(nextSeq).padStart(4, '0')}`;
}

async function generateBookingNumber(client: any): Promise<string> {
  return generateBookingId(client, 'WALKIN');
}

function toDateKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function normalizeRoomPhysicalStatus(value: any): string | null {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) return null;
  if (normalized === 'READY' || normalized === 'VACANT' || normalized === 'VACANT_CLEAN') return 'VACANT_CLEAN';
  if (normalized === 'KOTOR' || normalized === 'DIRTY' || normalized === 'VACANT_DIRTY') return 'VACANT_DIRTY';
  if (normalized === 'OCCUPIED' || normalized === 'BOOKED' || normalized === 'OCCUPIED_CLEAN') return 'OCCUPIED_CLEAN';
  if (normalized === 'OCCUPIED_DIRTY') return 'OCCUPIED_DIRTY';
  if (normalized === 'CLEANING') return 'CLEANING';
  if (normalized === 'INSPECTED') return 'INSPECTED';
  if (normalized === 'MAINT' || normalized === 'MAINTENANCE' || normalized === 'OUT_OF_ORDER') return 'OUT_OF_ORDER';
  if (normalized === 'OUT_OF_SERVICE') return 'OUT_OF_SERVICE';
  return null;
}

// Utility: enumerate dates between two dates using nightly stay semantics
// [check_in, check_out) means checkout date is excluded from room blocking.
function enumerateDates(startStr: string, endStr: string): string[] {
  const start = new Date(startStr);
  const end = new Date(endStr);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || startStr === endStr) {
    return [];
  }

  const dates: string[] = [];
  const current = new Date(start);
  while (current < end) {
    dates.push(toDateKey(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

async function reconcileAvailabilityDates(client: any = pool) {
  try {
    const roomTypesResult = await client.query(`
      SELECT DISTINCT COALESCE(rt.name, r.name) AS room_type
      FROM rooms r
      LEFT JOIN room_types rt ON rt.id = r.room_type_id
      WHERE COALESCE(rt.name, r.name) IS NOT NULL
    `);

    for (const row of roomTypesResult.rows) {
      const roomType = row.room_type;
      await client.query('UPDATE availability_dates SET reserved_qty = 0 WHERE room_type = $1', [roomType]);
    }

    const activeReservations = await client.query(`
      SELECT res.id, res.check_in, res.check_out, COALESCE(rt.name, r.name) AS room_type
      FROM reservations res
      JOIN rooms r ON r.id = res.room_id
      LEFT JOIN room_types rt ON rt.id = r.room_type_id
      WHERE res.status NOT IN ('CANCELLED', 'CHECKED_OUT')
        AND res.check_in IS NOT NULL
        AND res.check_out IS NOT NULL
        AND res.check_out > res.check_in
    `);

    for (const reservation of activeReservations.rows) {
      const roomType = reservation.room_type;
      if (!roomType) continue;
      const dates = enumerateDates(reservation.check_in, reservation.check_out);
      for (const date of dates) {
        await client.query(
          'UPDATE availability_dates SET reserved_qty = reserved_qty + 1 WHERE room_type = $1 AND date = $2',
          [roomType, date]
        );
      }
    }

    return true;
  } catch (error) {
    console.error('Availability reconciliation failed', error);
    return false;
  }
}

async function createReservationRecord(req: any, res: express.Response, payload: any) {
  const {
    room_id,
    guest_name,
    guest_phone,
    guest_segment,
    booking_type,
    bookingType,
    source,
    check_in,
    check_out,
    total_price,
    subtotal_amount,
    discount_amount,
    discount_percent,
    amount_paid,
    payment_status,
    qty,
    ktp_path,
    bukti_bayar_path
  } = payload;

  const quantity = Number(qty || 1);
  const validGuestSegment = ['Reguler', 'Group', 'Corporate'].includes(String(guest_segment || 'Reguler')) ? String(guest_segment || 'Reguler') : 'Reguler';
  const bookingSource = String(booking_type ?? bookingType ?? source ?? 'walkin').toLowerCase() === 'ota' ? 'OTA' : 'WALKIN';
  const billingSummary = computeBillingSummary(total_price ?? subtotal_amount ?? 0, discount_amount, discount_percent, amount_paid);
  const finalTotal = billingSummary.totalAfterDiscount;
  const finalPaymentStatus = payment_status || billingSummary.paymentStatus;
  const correlationId = req.headers['x-correlation-id'] || 'CORR-' + Date.now();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const roomRow = await client.query(`
      SELECT COALESCE(rt.name, r.name) AS room_type
      FROM rooms r
      LEFT JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.id = $1
    `, [room_id]);
    if (!hasRows(roomRow)) throw new Error('Invalid room_id');
    const room_type = roomRow.rows[0].room_type;

    const bookingNumber = await generateBookingId(client, bookingSource);
    const insertQuery = `
      INSERT INTO reservations (
        room_id, guest_name, guest_phone, guest_segment, check_in, check_out,
        total_price, payment_status, discount_amount, discount_percent, amount_paid, remaining_balance,
        booking_number, booking_type, correlation_id, ktp_path, bukti_bayar_path
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING *;
    `;

    const newRes = await client.query(insertQuery, [
      room_id,
      guest_name,
      guest_phone,
      validGuestSegment,
      check_in,
      check_out,
      finalTotal,
      finalPaymentStatus,
      billingSummary.discount,
      billingSummary.discountPercent,
      billingSummary.amountPaid,
      billingSummary.remainingBalance,
      bookingNumber,
      bookingSource,
      correlationId,
      ktp_path || null,
      bukti_bayar_path || null
    ]);
    const reservationId = newRes.rows[0].id;

    const dates = enumerateDates(check_in, check_out);
    const now = new Date();
    const ttl = 30;
    const expiresAt = new Date(now.getTime() + ttl * 60 * 1000);

    for (const date of dates) {
      const sel = await client.query('SELECT reserved_qty, total_rooms FROM availability_dates WHERE room_type = $1 AND date = $2 FOR UPDATE', [room_type, date]);
      if (!hasRows(sel)) {
        throw new Error(`No availability record for ${room_type} on ${date}`);
      }
      const row = sel.rows[0];
      const available = Number(row.total_rooms) - Number(row.reserved_qty);
      if (available < quantity) {
        throw new Error(`Not enough availability for ${room_type} on ${date} (available=${available}, requested=${quantity})`);
      }
      await client.query('UPDATE availability_dates SET reserved_qty = reserved_qty + $1 WHERE room_type = $2 AND date = $3', [quantity, room_type, date]);
      await client.query('INSERT INTO availability_locks (reservation_id, room_type, date, qty_locked, lock_expires_at) VALUES ($1, $2, $3, $4, $5)', [reservationId, room_type, date, quantity, expiresAt.toISOString()]);
    }

    const roomCharge = Number(newRes.rows[0].total_price || 0);
    if (roomCharge > 0) {
      await client.query(
        `INSERT INTO folio_entries (reservation_id, entry_type, description, amount, direction)
         VALUES ($1, $2, $3, $4, 'DEBIT')`,
        [reservationId, 'ROOM_CHARGE', 'Reservasi kamar', roomCharge]
      );
    }

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      ['PMS', 'CREATE', 'RESERVATION', reservationId, JSON.stringify(newRes.rows[0]), correlationId]
    );

    await client.query('COMMIT');
    const idKey = (req as any)._idempotency_key;
    if (idKey) {
      const responseObj = { status: 'SUCCESS', data: newRes.rows[0], lock_expires_at: expiresAt.toISOString() };
      const respBody = JSON.stringify(responseObj);
      let headersObj: any = {};
      try { headersObj = (res as any).getHeaders ? (res as any).getHeaders() : { 'content-type': 'application/json' }; } catch (e) { headersObj = { 'content-type': 'application/json' }; }
      const respHeaders = JSON.stringify(headersObj);
      await pool.query('UPDATE idempotency_keys SET response_body = $1, response_headers = $2, status_code = $3 WHERE key = $4', [respBody, respHeaders, 201, idKey]);
    }

    try {
      broadcastEvent('ReservationCreated', {
        reservation_id: newRes.rows[0].id,
        reservation_number: newRes.rows[0].booking_number,
        status: newRes.rows[0].status || 'TENTATIVE',
        guest: { name: newRes.rows[0].guest_name, phone: newRes.rows[0].guest_phone },
        room_id: newRes.rows[0].room_id,
        check_in: newRes.rows[0].check_in,
        check_out: newRes.rows[0].check_out,
        correlation_id: correlationId,
        timestamp: new Date().toISOString()
      });
    } catch (e) {
      console.error('Failed to broadcast ReservationCreated', e);
    }

    res.status(201).json({ status: 'SUCCESS', data: newRes.rows[0], lock_expires_at: expiresAt.toISOString() });
  } catch (err: any) {
    await client.query('ROLLBACK');
    if (err.message && (err.message.startsWith('Not enough availability') || err.message.startsWith('No availability record'))) {
      const idKey = (req as any)._idempotency_key;
      if (idKey) {
        const responseObj = { status: 'FAILED', message: err.message };
        const respBody = JSON.stringify(responseObj);
        let headersObj: any = {};
        try { headersObj = (res as any).getHeaders ? (res as any).getHeaders() : { 'content-type': 'application/json' }; } catch (e) { headersObj = { 'content-type': 'application/json' }; }
        const respHeaders = JSON.stringify(headersObj);
        await pool.query('UPDATE idempotency_keys SET response_body = $1, response_headers = $2, status_code = $3 WHERE key = $4', [respBody, respHeaders, 409, idKey]);
      }
      return res.status(409).json({ status: 'FAILED', message: err.message });
    }
    res.status(500).json({ status: 'ERROR', message: err.message });
  } finally {
    client.release();
  }
}

app.get('/api/reservations/:id', async (req, res) => {
  const reservationId = Number(req.params.id);
  try {
    const result = await pool.query('SELECT * FROM reservations WHERE id = $1', [reservationId]);
    if (!hasRows(result)) {
      return res.status(404).json({ status: 'ERROR', message: 'reservation not found' });
    }
    res.json({ status: 'OK', data: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.get('/api/reservations/:id/audit', async (req, res) => {
  const reservationId = Number(req.params.id);
  try {
    const result = await pool.query(
      `SELECT * FROM audit_logs
       WHERE entity = 'RESERVATION' AND record_id = $1
       ORDER BY timestamp DESC, audit_id DESC
       LIMIT 20`,
      [String(reservationId)]
    );
    res.json({ status: 'OK', data: result.rows });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.get('/api/rooms/:id/audit', async (req, res) => {
  const roomId = Number(req.params.id);
  try {
    const result = await pool.query(
      `SELECT * FROM audit_logs
       WHERE entity = 'ROOM' AND record_id = $1
       ORDER BY timestamp DESC, audit_id DESC
       LIMIT 20`,
      [String(roomId)]
    );
    res.json({ status: 'OK', data: result.rows });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.patch('/api/reservations/:id', async (req, res) => {
  const reservationId = Number(req.params.id);
  const payload = req.body || {};

  if (!Number.isFinite(reservationId)) {
    return res.status(400).json({ status: 'ERROR', message: 'invalid reservation id' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [reservationId]);
    if (!hasRows(current)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', message: 'reservation not found' });
    }

    const existing = current.rows[0];
    const roomId = payload.room_id ?? existing.room_id;
    const guestName = payload.guest_name ?? existing.guest_name;
    const guestPhone = payload.guest_phone ?? existing.guest_phone;
    const guestSegment = ['Reguler', 'Group', 'Corporate'].includes(String(payload.guest_segment || existing.guest_segment || 'Reguler'))
      ? String(payload.guest_segment || existing.guest_segment || 'Reguler')
      : String(existing.guest_segment || 'Reguler');
    const checkIn = payload.check_in ?? existing.check_in;
    const checkOut = payload.check_out ?? existing.check_out;
    const baseSubtotal = Number(payload.subtotal_amount ?? payload.total_price ?? existing.total_price ?? existing.subtotal_amount ?? 0);
    const discountAmount = Number(payload.discount_amount ?? existing.discount_amount ?? 0);
    const discountPercent = Number(payload.discount_percent ?? existing.discount_percent ?? 0);
    const amountPaid = Number(payload.amount_paid ?? existing.amount_paid ?? 0);
    const totalPrice = Number(payload.total_price ?? baseSubtotal);
    const billingSummary = computeBillingSummary(totalPrice, discountAmount, discountPercent, amountPaid);
    const incomingStatus = payload.status ?? existing.status ?? 'CONFIRMED';
    const paymentStatus = payload.payment_status ?? billingSummary.paymentStatus;
    const ktpPath = payload.ktp_path ?? existing.ktp_path;
    const buktiBayarPath = payload.bukti_bayar_path ?? existing.bukti_bayar_path;
    const bookingSource = String(payload.booking_type ?? payload.bookingType ?? payload.source ?? existing.booking_type ?? 'walkin').toLowerCase() === 'ota' ? 'OTA' : 'WALKIN';

    const updated = await client.query(
      `UPDATE reservations
       SET room_id = $1,
           guest_name = $2,
           guest_phone = $3,
           guest_segment = $4,
           check_in = $5,
           check_out = $6,
           total_price = $7,
           payment_status = $8,
           discount_amount = $9,
           discount_percent = $10,
           amount_paid = $11,
           remaining_balance = $12,
           ktp_path = $13,
           bukti_bayar_path = $14,
           booking_type = $15,
           status = $16,
           stay_status = COALESCE($17, stay_status),
           updated_at = NOW()
       WHERE id = $18
       RETURNING *`,
      [
       roomId,
       guestName,
       guestPhone,
       guestSegment,
       checkIn,
       checkOut,
       billingSummary.totalAfterDiscount,
       paymentStatus,
       billingSummary.discount,
       billingSummary.discountPercent,
       billingSummary.amountPaid,
       billingSummary.remainingBalance,
       ktpPath,
       buktiBayarPath,
       bookingSource,
       incomingStatus,
       payload.stay_status ?? existing.stay_status,
       reservationId
      ]
    );

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['PMS', 'UPDATE', 'RESERVATION', reservationId, JSON.stringify(updated.rows[0]), req.headers['x-correlation-id'] || null]
    );

    await client.query('COMMIT');
    broadcastEvent('ReservationUpdated', {
      reservation_id: reservationId,
      room_id: roomId,
      guest_name: guestName,
      timestamp: new Date().toISOString()
    });

    res.json({ status: 'SUCCESS', data: updated.rows[0] });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ status: 'ERROR', message: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/reservations/:id/cancel', async (req, res) => {
  const reservationId = Number(req.params.id);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const reservation = await client.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [reservationId]);
    if (!hasRows(reservation)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', message: 'reservation not found' });
    }

    const current = reservation.rows[0];
    const updated = await client.query(
      `UPDATE reservations
       SET status = 'CANCELLED', stay_status = 'CANCELLED', updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [reservationId]
    );

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['PMS', 'CANCEL', 'RESERVATION', reservationId, JSON.stringify(updated.rows[0]), req.headers['x-correlation-id'] || null]
    );

    await client.query('COMMIT');
    broadcastEvent('ReservationCancelled', {
      reservation_id: reservationId,
      room_id: current.room_id,
      guest_name: current.guest_name,
      timestamp: new Date().toISOString()
    });

    res.json({ status: 'SUCCESS', data: updated.rows[0] });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ status: 'ERROR', message: err.message });
  } finally {
    client.release();
  }
});

// POST Reservation (integrated with availability lock)
app.post('/api/reservations', async (req, res) => {
  return createReservationRecord(req, res, req.body || {});
});

app.post('/api/reservations/upload', upload.fields([
  { name: 'ktp_file', maxCount: 1 },
  { name: 'bukti_bayar_file', maxCount: 1 }
]), async (req, res) => {
  const files = (req as any).files || {};
  const payload = {
    ...(req.body || {}),
    guest_segment: req.body?.guest_segment || 'Reguler',
    ktp_path: files.ktp_file?.[0]?.filename ? `/uploads/${files.ktp_file[0].filename}` : req.body?.ktp_path || null,
    bukti_bayar_path: files.bukti_bayar_file?.[0]?.filename ? `/uploads/${files.bukti_bayar_file[0].filename}` : req.body?.bukti_bayar_path || null
  };

  return createReservationRecord(req, res, payload);
});

// GET availability per room_type between date range
app.get('/api/availability', async (req, res) => {
  const room_type = String(req.query.room_type || 'Standard Room');
  const start = String(req.query.start || new Date().toISOString().slice(0, 10));
  const end = String(req.query.end || new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10));

  try {
    const result = await pool.query(
      `SELECT date, total_rooms, reserved_qty, (total_rooms - reserved_qty) as sellable FROM availability_dates
       WHERE room_type = $1 AND date >= $2::date AND date < $3::date
       ORDER BY date`,
      [room_type, start, end]
    );

    res.json({ status: 'OK', data: result.rows });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.get('/api/rooms', async (req, res) => {
  try {
    const rooms = await pool.query(`
      SELECT r.id, r.room_number, COALESCE(rt.name, r.name, 'Standard Room') AS name, r.status
      FROM rooms r
      LEFT JOIN room_types rt ON rt.id = r.room_type_id
      ORDER BY r.room_number
    `);
    res.json({ status: 'OK', data: rooms.rows });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.get('/api/housekeeping/tasks', async (req, res) => {
  try {
    const tasks = await pool.query(
      'SELECT * FROM housekeeping_tasks ORDER BY due_at ASC NULLS LAST, created_at DESC'
    );
    res.json({ status: 'OK', data: tasks.rows });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.post('/api/housekeeping/tasks', async (req, res) => {
  const { room_number, task_type, priority, status, assignee, notes, due_at } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO housekeeping_tasks (room_number, task_type, priority, status, assignee, notes, due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [room_number || null, task_type || 'ROOM_SERVICE', priority || 'MEDIUM', status || 'PENDING', assignee || null, notes || null, due_at || null]
    );

    res.status(201).json({ status: 'SUCCESS', data: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.patch('/api/housekeeping/tasks/:id/status', async (req, res) => {
  const taskId = Number(req.params.id);
  const nextTaskStatus = String(req.body?.status || 'PENDING').toUpperCase();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const existingTask = await client.query(
      'SELECT * FROM housekeeping_tasks WHERE id = $1 FOR UPDATE',
      [taskId]
    );
    if (!hasRows(existingTask)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', message: 'task not found' });
    }

    const result = await client.query(
      'UPDATE housekeeping_tasks SET status = $1 WHERE id = $2 RETURNING *',
      [nextTaskStatus, taskId]
    );
    const task = result.rows[0];

    let roomUpdatePayload: { roomId: number; status: string } | null = null;
    const taskType = String(task.task_type || '').toUpperCase();
    const roomNumber = String(task.room_number || '').trim();
    if (taskType === 'ROOM_CLEANING' && (nextTaskStatus === 'DONE' || nextTaskStatus === 'IN_PROGRESS')) {
      if (!roomNumber) {
        throw new Error('room_number is required for ROOM_CLEANING task status updates');
      }
      const roomResult = await client.query(
        'SELECT id FROM rooms WHERE room_number = $1 OR CAST(id AS TEXT) = $1 FOR UPDATE',
        [roomNumber]
      );
      if (!hasRows(roomResult)) {
        throw new Error(`Unable to resolve room for housekeeping task ${taskId} with room_number "${roomNumber}"`);
      }

      const roomId = Number(roomResult.rows[0].id);
      let targetStatus: string | null = null;

      if (nextTaskStatus === 'IN_PROGRESS') {
        targetStatus = 'CLEANING';
      } else if (nextTaskStatus === 'DONE') {
        const inHouse = await client.query(
          `SELECT 1
           FROM reservations
           WHERE room_id = $1
             AND status = 'CHECKED_IN'
             AND stay_status = 'IN_HOUSE'
             AND checked_in_at IS NOT NULL
             AND checked_out_at IS NULL
             AND (check_out IS NULL OR check_out >= CURRENT_DATE)
           LIMIT 1`,
          [roomId]
        );
        targetStatus = hasRows(inHouse) ? 'OCCUPIED_CLEAN' : 'VACANT_CLEAN';
      }

      if (targetStatus) {
        await client.query(
          'UPDATE rooms SET status = $1 WHERE id = $2',
          [targetStatus, roomId]
        );
        roomUpdatePayload = { roomId, status: targetStatus };
      }
    }

    await client.query('COMMIT');
    if (roomUpdatePayload) {
      broadcastEvent('RoomStatusUpdated', {
        room_id: roomUpdatePayload.roomId,
        status: roomUpdatePayload.status,
        timestamp: new Date().toISOString()
      });
    }
    res.json({ status: 'SUCCESS', data: result.rows[0] });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ status: 'ERROR', message: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/maintenance/tasks', async (req, res) => {
  try {
    const tasks = await pool.query(
      'SELECT * FROM maintenance_tasks ORDER BY due_at ASC NULLS LAST, created_at DESC'
    );
    res.json({ status: 'OK', data: tasks.rows });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.post('/api/maintenance/tasks', async (req, res) => {
  const { room_number, issue_type, priority, status, assignee, notes, due_at } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO maintenance_tasks (room_number, issue_type, priority, status, assignee, notes, due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [room_number || null, issue_type || 'GENERAL', priority || 'MEDIUM', status || 'OPEN', assignee || null, notes || null, due_at || null]
    );

    res.status(201).json({ status: 'SUCCESS', data: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.patch('/api/maintenance/tasks/:id/status', async (req, res) => {
  const taskId = Number(req.params.id);
  const { status } = req.body;

  try {
    const result = await pool.query(
      'UPDATE maintenance_tasks SET status = $1 WHERE id = $2 RETURNING *',
      [status || 'OPEN', taskId]
    );

    if (!hasRows(result)) {
      return res.status(404).json({ status: 'ERROR', message: 'task not found' });
    }

    res.json({ status: 'SUCCESS', data: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.get('/api/pos/menu', async (req, res) => {
  try {
    const categories = await pool.query('SELECT * FROM pos_menu_categories ORDER BY id');
    const items = await pool.query(`
      SELECT mi.*, pmc.name AS category_name
      FROM pos_menu_items mi
      LEFT JOIN pos_menu_categories pmc ON pmc.id = mi.category_id
      WHERE mi.is_active = TRUE
      ORDER BY mi.id
    `);

    res.json({ status: 'OK', data: { categories: categories.rows, items: items.rows } });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.get('/api/pos/orders', async (req, res) => {
  try {
    const orders = await pool.query(`
      SELECT po.*, COUNT(poi.id) AS item_count, COALESCE(SUM(poi.quantity), 0) AS total_qty
      FROM pos_orders po
      LEFT JOIN pos_order_items poi ON poi.order_id = po.id
      GROUP BY po.id
      ORDER BY po.created_at DESC
    `);

    for (const order of orders.rows) {
      const items = await pool.query(
        `SELECT poi.*, pmi.name, pmi.item_code
         FROM pos_order_items poi
         LEFT JOIN pos_menu_items pmi ON pmi.id = poi.menu_item_id
         WHERE poi.order_id = $1`,
        [order.id]
      );
      order.items = items.rows;
    }

    res.json({ status: 'OK', data: orders.rows });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.post('/api/pos/orders', async (req, res) => {
  const { reservation_id, table_number, guest_name, items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ status: 'ERROR', message: 'items must not be empty' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderNumber = `POS-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Date.now().toString().slice(-6)}`;
    const orderInsert = await client.query(
      `INSERT INTO pos_orders (reservation_id, order_number, table_number, guest_name, total_amount, status)
       VALUES ($1, $2, $3, $4, 0, 'OPEN')
       RETURNING *`,
      [reservation_id || null, orderNumber, table_number || 'Walk In', guest_name || 'Guest', 0]
    );

    const orderId = orderInsert.rows[0].id;
    let totalAmount = 0;

    for (const item of items) {
      const menuItem = await client.query('SELECT id, price, name FROM pos_menu_items WHERE id = $1 AND is_active = TRUE', [item.menu_item_id]);
      if (!hasRows(menuItem)) {
        throw new Error(`Menu item ${item.menu_item_id} not found`);
      }

      const menu = menuItem.rows[0];
      const qty = Number(item.quantity || 1);
      const unitPrice = Number(menu.price);
      totalAmount += qty * unitPrice;

      await client.query(
        `INSERT INTO pos_order_items (order_id, menu_item_id, quantity, unit_price, notes)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, menu.id, qty, unitPrice, item.notes || null]
      );
    }

    const updatedOrder = await client.query(
      'UPDATE pos_orders SET total_amount = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [totalAmount, orderId]
    );

    await client.query('COMMIT');
    broadcastEvent('PosOrderCreated', {
      order_id: orderId,
      order_number: orderNumber,
      guest_name: guest_name || 'Guest',
      total_amount: totalAmount,
      timestamp: new Date().toISOString()
    });

    res.status(201).json({ status: 'SUCCESS', data: updatedOrder.rows[0] });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ status: 'ERROR', message: err.message });
  } finally {
    client.release();
  }
});

app.patch('/api/pos/orders/:id/status', async (req, res) => {
  const orderId = Number(req.params.id);
  const { status } = req.body;

  try {
    const result = await pool.query(
      'UPDATE pos_orders SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [status || 'OPEN', orderId]
    );

    if (!hasRows(result)) {
      return res.status(404).json({ status: 'ERROR', message: 'order not found' });
    }

    res.json({ status: 'SUCCESS', data: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.get('/api/accounting/summary', async (req, res) => {
  try {
    const accounts = await pool.query('SELECT * FROM accounting_gl_accounts ORDER BY code');
    const entries = await pool.query(`
      SELECT j.id, j.entry_number, j.description, j.entry_date, j.source_module,
             COALESCE(SUM(CASE WHEN jl.debit > 0 THEN jl.debit ELSE 0 END), 0) AS total_debit,
             COALESCE(SUM(CASE WHEN jl.credit > 0 THEN jl.credit ELSE 0 END), 0) AS total_credit
      FROM accounting_journal_entries j
      LEFT JOIN accounting_journal_lines jl ON jl.journal_entry_id = j.id
      GROUP BY j.id, j.entry_number, j.description, j.entry_date, j.source_module
      ORDER BY j.entry_date DESC
    `);

    const payable = await pool.query('SELECT SUM(amount) AS total FROM vendor_payables WHERE status != $1', ['PAID']);
    const receivable = await pool.query('SELECT SUM(total_amount - paid_amount) AS total FROM guest_receivables WHERE status != $1', ['PAID']);

    res.json({
      status: 'OK',
      data: {
        accounts: accounts.rows,
        entries: entries.rows,
        total_payable: Number(payable.rows[0]?.total || 0),
        total_receivable: Number(receivable.rows[0]?.total || 0)
      }
    });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.get('/api/guest-profiles', async (req, res) => {
  try {
    const profiles = await pool.query('SELECT * FROM guest_profiles ORDER BY updated_at DESC, full_name');
    res.json({ status: 'OK', data: profiles.rows });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.post('/api/guest-profiles', async (req, res) => {
  const { full_name, email, phone, id_number, nationality, birth_date, preferences, loyalty_tier, notes, privacy_flags, is_blacklisted } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO guest_profiles (full_name, email, phone, id_number, nationality, birth_date, preferences, loyalty_tier, notes, privacy_flags, is_blacklisted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [full_name || null, email || null, phone || null, id_number || null, nationality || null, birth_date || null, preferences ? JSON.stringify(preferences) : null, loyalty_tier || 'REGULAR', notes || null, privacy_flags ? JSON.stringify(privacy_flags) : '{}', Boolean(is_blacklisted)]
    );

    res.status(201).json({ status: 'SUCCESS', data: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.get('/api/hr/employees', async (req, res) => {
  try {
    const employees = await pool.query('SELECT * FROM hr_employees ORDER BY full_name');
    res.json({ status: 'OK', data: employees.rows });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.get('/api/hr/payroll', async (req, res) => {
  try {
    const payroll = await pool.query(`
      SELECT pr.*, he.full_name, he.position, he.department
      FROM payroll_records pr
      LEFT JOIN hr_employees he ON he.id = pr.employee_id
      ORDER BY pr.created_at DESC
    `);
    res.json({ status: 'OK', data: payroll.rows });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.post('/api/hr/payroll', async (req, res) => {
  const { employee_id, period, base_salary, bonus, deductions } = req.body;

  try {
    const base = Number(base_salary || 0);
    const bonusAmount = Number(bonus || 0);
    const deductionAmount = Number(deductions || 0);
    const net = base + bonusAmount - deductionAmount;

    const result = await pool.query(
      `INSERT INTO payroll_records (employee_id, period, base_salary, bonus, deductions, net_salary, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'READY')
       RETURNING *`,
      [employee_id, period || '2026-08', base, bonusAmount, deductionAmount, net]
    );

    res.status(201).json({ status: 'SUCCESS', data: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.post('/api/accounting/journal', async (req, res) => {
  const { description, source_module, source_ref, lines } = req.body;

  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ status: 'ERROR', message: 'journal lines required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const entryNumber = `JRN-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Date.now().toString().slice(-6)}`;
    const entry = await client.query(
      `INSERT INTO accounting_journal_entries (entry_number, description, source_module, source_ref)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [entryNumber, description || 'Manual journal', source_module || 'PMS', source_ref || null]
    );

    for (const line of lines) {
      const account = await client.query('SELECT id FROM accounting_gl_accounts WHERE id = $1', [line.account_id]);
      if (!hasRows(account)) {
        throw new Error(`GL account ${line.account_id} not found`);
      }

      await client.query(
        `INSERT INTO accounting_journal_lines (journal_entry_id, account_id, debit, credit, description)
         VALUES ($1, $2, $3, $4, $5)`,
        [entry.rows[0].id, line.account_id, Number(line.debit || 0), Number(line.credit || 0), line.description || null]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ status: 'SUCCESS', data: entry.rows[0] });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ status: 'ERROR', message: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/accounting/receivables', async (req, res) => {
  const { reservation_id, guest_name, total_amount, paid_amount, status } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO guest_receivables (reservation_id, guest_name, total_amount, paid_amount, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [reservation_id || null, guest_name || 'Guest', Number(total_amount || 0), Number(paid_amount || 0), status || 'OPEN']
    );

    res.status(201).json({ status: 'SUCCESS', data: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.post('/api/accounting/payables', async (req, res) => {
  const { vendor_name, invoice_number, due_date, amount, status } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO vendor_payables (vendor_name, invoice_number, due_date, amount, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [vendor_name || 'Vendor', invoice_number || null, due_date || null, Number(amount || 0), status || 'OPEN']
    );

    res.status(201).json({ status: 'SUCCESS', data: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.patch('/api/rooms/:id/status', async (req, res) => {
  const roomId = Number(req.params.id);
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ status: 'ERROR', message: 'missing status' });
  }

  const mappedStatus = normalizeRoomPhysicalStatus(status);
  if (!mappedStatus) {
    return res.status(400).json({ status: 'ERROR', message: 'invalid status' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'UPDATE rooms SET status = $1 WHERE id = $2 RETURNING *',
      [mappedStatus, roomId]
    );
    if (!hasRows(result)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', message: 'room not found' });
    }

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['PMS', 'UPDATE_STATUS', 'ROOM', roomId, JSON.stringify({ input_status: status, status: mappedStatus }), req.headers['x-correlation-id'] || null]
    );

    await client.query('COMMIT');
    broadcastEvent('RoomStatusUpdated', { room_id: roomId, status: mappedStatus, timestamp: new Date().toISOString() });
    res.json({ status: 'SUCCESS', data: result.rows[0] });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ status: 'ERROR', message: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/reservations/:id/checkin', async (req, res) => {
  const reservationId = Number(req.params.id);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const reservation = await client.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [reservationId]);
    if (!hasRows(reservation)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', message: 'reservation not found' });
    }

    const current = reservation.rows[0];
    const nextStatus = current.status === 'CHECKED_IN' ? 'CHECKED_IN' : 'CHECKED_IN';
    const updated = await client.query(
      `UPDATE reservations
       SET status = $1, stay_status = 'IN_HOUSE', checked_in_at = COALESCE(checked_in_at, NOW())
       WHERE id = $2
       RETURNING *`,
      [nextStatus, reservationId]
    );

    await client.query(
      'UPDATE rooms SET status = $1 WHERE id = $2',
      ['OCCUPIED_CLEAN', current.room_id]
    );

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['PMS', 'CHECK_IN', 'RESERVATION', reservationId, JSON.stringify(updated.rows[0]), req.headers['x-correlation-id'] || null]
    );

    await client.query('COMMIT');
    broadcastEvent('ReservationCheckedIn', {
      reservation_id: reservationId,
      room_id: current.room_id,
      guest_name: current.guest_name,
      checked_in_at: new Date().toISOString(),
      timestamp: new Date().toISOString()
    });

    res.json({ status: 'SUCCESS', data: updated.rows[0] });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ status: 'ERROR', message: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/reservations/:id/checkout', async (req, res) => {
  const reservationId = Number(req.params.id);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const reservation = await client.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [reservationId]);
    if (!hasRows(reservation)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', message: 'reservation not found' });
    }

    const current = reservation.rows[0];
    const updated = await client.query(
      `UPDATE reservations
       SET status = 'CHECKED_OUT', stay_status = 'DEPARTED', checked_out_at = COALESCE(checked_out_at, NOW())
       WHERE id = $1
       RETURNING *`,
      [reservationId]
    );

    await client.query(
      'UPDATE rooms SET status = $1 WHERE id = $2',
      ['VACANT_DIRTY', current.room_id]
    );

    const roomTypeCheck = await client.query(
      `SELECT COALESCE(rt.name, r.name) AS room_type
       FROM rooms r
       LEFT JOIN room_types rt ON rt.id = r.room_type_id
       WHERE r.id = $1`,
      [current.room_id]
    );
    const roomType = roomTypeCheck.rows[0]?.room_type || null;
    if (roomType && current.check_out) {
      const checkoutDate = toDateKey(current.check_out);
      if (checkoutDate) {
       await client.query(
         `UPDATE availability_dates
          SET reserved_qty = GREATEST(0, reserved_qty - 1)
          WHERE room_type = $1 AND date = $2 AND reserved_qty > 0`,
         [roomType, checkoutDate]
       );
      }
    }

    // Do not force a room-wide dirty status here; dirty should be tracked per checkout date/cell
    // so the room remains available for other dates unless explicitly marked dirty for the checkout day.

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['PMS', 'CHECK_OUT', 'RESERVATION', reservationId, JSON.stringify(updated.rows[0]), req.headers['x-correlation-id'] || null]
    );

    await client.query('COMMIT');
    broadcastEvent('ReservationCheckedOut', {
      reservation_id: reservationId,
      room_id: current.room_id,
      guest_name: current.guest_name,
      checked_out_at: new Date().toISOString(),
      timestamp: new Date().toISOString()
    });

    res.json({ status: 'SUCCESS', data: updated.rows[0] });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ status: 'ERROR', message: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/reservations/:id/payments', async (req, res) => {
  const reservationId = Number(req.params.id);
  const { amount, payment_method, reference_code, transaction_type } = req.body;

  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ status: 'ERROR', message: 'amount must be greater than zero' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reservation = await client.query('SELECT id, total_price, amount_paid, payment_status FROM reservations WHERE id = $1 FOR UPDATE', [reservationId]);
    if (!hasRows(reservation)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', message: 'reservation not found' });
    }

    const paymentAmount = Number(amount);
    const currentPaid = Number(reservation.rows[0].amount_paid || 0);
    const totalPrice = Number(reservation.rows[0].total_price || 0);
    const updatedAmountPaid = currentPaid + paymentAmount;
    const updatedRemaining = Math.max(totalPrice - updatedAmountPaid, 0);
    const updatedPaymentStatus = updatedAmountPaid <= 0 ? 'UNPAID' : updatedRemaining <= 0.01 ? 'PAID' : 'PARTIAL';

    const payment = await client.query(
      `INSERT INTO payment_transactions (reservation_id, transaction_type, amount, payment_method, reference_code, status)
       VALUES ($1, $2, $3, $4, $5, 'SUCCESS')
       RETURNING *`,
      [reservationId, transaction_type || 'PAYMENT', paymentAmount, payment_method || 'CASH', reference_code || `TXN-${Date.now()}`]
    );

    await client.query(
      `INSERT INTO folio_entries (reservation_id, entry_type, description, amount, direction)
       VALUES ($1, $2, $3, $4, 'CREDIT')`,
      [reservationId, transaction_type || 'PAYMENT', 'Pembayaran tamu', paymentAmount]
    );

    const updated = await client.query(
      `UPDATE reservations SET amount_paid = $1, remaining_balance = $2, payment_status = $3 WHERE id = $4 RETURNING *`,
      [updatedAmountPaid, updatedRemaining, updatedPaymentStatus, reservationId]
    );

    await client.query('COMMIT');
    res.json({ status: 'SUCCESS', data: { payment: payment.rows[0], reservation: updated.rows[0] } });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ status: 'ERROR', message: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/reservations/:id/folio', async (req, res) => {
  const reservationId = Number(req.params.id);
  try {
    const reservation = await pool.query('SELECT * FROM reservations WHERE id = $1', [reservationId]);
    if (!hasRows(reservation)) {
      return res.status(404).json({ status: 'ERROR', message: 'reservation not found' });
    }

    const payments = await pool.query('SELECT * FROM payment_transactions WHERE reservation_id = $1 ORDER BY created_at DESC', [reservationId]);
    const folio = await pool.query('SELECT * FROM folio_entries WHERE reservation_id = $1 ORDER BY created_at DESC', [reservationId]);

    res.json({
      status: 'OK',
      data: {
        reservation: reservation.rows[0],
        payments: payments.rows,
        folio: folio.rows
      }
    });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

// POST availability lock (internal endpoint used by booking flow)
app.post('/api/availability/lock', async (req, res) => {
  const { reservation_id, room_type, start, end, qty, ttl_minutes } = req.body;
  if (!room_type || !start || !end || !qty) return res.status(400).json({ status: 'ERROR', message: 'missing parameters' });
  const dates = enumerateDates(start, end);
  const client = await pool.connect();
  const now = new Date();
  const ttl = Number(ttl_minutes || 30);
  const expiresAt = new Date(now.getTime() + ttl * 60 * 1000);

  try {
    await client.query('BEGIN');

    // For each date, lock the availability row and increment reserved_qty if possible
    for (const date of dates) {
      const sel = await client.query('SELECT reserved_qty, total_rooms FROM availability_dates WHERE room_type = $1 AND date = $2 FOR UPDATE', [room_type, date]);
      if (!hasRows(sel)) {
        throw new Error(`No availability record for ${room_type} on ${date}`);
      }
      const row = sel.rows[0];
      const available = Number(row.total_rooms) - Number(row.reserved_qty);
      if (available < qty) {
        throw new Error(`Not enough availability for ${room_type} on ${date} (available=${available}, requested=${qty})`);
      }
      await client.query('UPDATE availability_dates SET reserved_qty = reserved_qty + $1 WHERE room_type = $2 AND date = $3', [qty, room_type, date]);

      await client.query('INSERT INTO availability_locks (reservation_id, room_type, date, qty_locked, lock_expires_at) VALUES ($1, $2, $3, $4, $5)', [reservation_id || null, room_type, date, qty, expiresAt.toISOString()]);
    }

    await client.query('COMMIT');
    res.json({ status: 'OK', message: 'locked', expires_at: expiresAt.toISOString() });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(409).json({ status: 'FAILED', message: err.message });
  } finally {
    client.release();
  }
});

// GET tapechart: rooms × dates with reservations per cell
app.get('/api/tapechart', async (req, res) => {
  const start = String(req.query.start || new Date().toISOString().slice(0,10));
  const end = String(req.query.end || new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0,10));

  try {
    // fetch rooms
    const roomsRes = await pool.query(`
      SELECT r.id, r.room_number, COALESCE(rt.name, r.name, 'Standard Room') AS name, r.status
      FROM rooms r
      LEFT JOIN room_types rt ON rt.id = r.room_type_id
      ORDER BY r.room_number
    `);
    const rooms = roomsRes.rows;

    // fetch reservations overlapping range
    const reservationsRes = await pool.query(
      `SELECT * FROM reservations WHERE NOT (check_out <= $1::timestamp OR check_in >= $2::timestamp)`,
      [start, end]
    );
    const reservations = reservationsRes.rows;

    // fetch availability for range (per room type & date)
    const availabilityRes = await pool.query(
      `SELECT room_type, date, total_rooms, reserved_qty, (total_rooms - reserved_qty) as sellable FROM availability_dates WHERE date >= $1::date AND date < $2::date`,
      [start, end]
    );
    const availability = availabilityRes.rows;

    const dates = enumerateDates(start, end);

    // Build map for quick lookup
    const reservationsByRoom: Record<string, any[]> = {};
    for (const r of reservations) {
      const rid = String(r.room_id);
      if (!reservationsByRoom[rid]) reservationsByRoom[rid] = [];
      reservationsByRoom[rid].push(r);
    }

    const availabilityMap: Record<string, any> = {};
    for (const a of availability) {
      const dateKey = (a.date && a.date.toISOString) ? a.date.toISOString().slice(0,10) : String(a.date);
      const key = `${a.room_type}::${dateKey}`;
      availabilityMap[key] = a;
    }

    const resultRooms = rooms.map((room: any) => {
      const cells = dates.map((d) => {
        const dateStr = d;
        // reservations for this room that cover this date
        const resForRoom = (reservationsByRoom[String(room.id)] || []).filter((r: any) => {
          const ci = (new Date(r.check_in)).toISOString().slice(0,10);
          const co = (new Date(r.check_out)).toISOString().slice(0,10);
          // Nightly stay is inclusive on check-in and exclusive on check-out.
          // Example: 2026-08-20 -> 2026-08-21 blocks only 20; 2026-08-20 -> 2026-08-28 blocks 20..27.
          return dateStr >= ci && dateStr < co;
        }).map((r: any) => ({ id: r.id, guest_name: r.guest_name, payment_status: r.payment_status, check_in: r.check_in, check_out: r.check_out, status: r.status || 'CONFIRMED' }));

        // availability by room_type (supports both legacy rooms.name and normalized room_types table)
        const availKey = `${room.name}::${dateStr}`;
        const avail = availabilityMap[availKey] || null;
        return { date: dateStr, reservations: resForRoom, availability: avail };
      });
      return { id: room.id, room_number: room.room_number, name: room.name, status: room.status, cells };
    });

    return res.json({ status: 'OK', start, end, rooms: resultRooms });
  } catch (err: any) {
    console.error('Error /api/tapechart', err);
    return res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

// Move reservation (room move)
app.post('/api/reservations/:id/move', async (req, res) => {
  const reservationId = Number(req.params.id);
  const { to_room_id } = req.body;
  if (!to_room_id) return res.status(400).json({ status: 'ERROR', message: 'missing to_room_id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rRes = await client.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [reservationId]);
    if (!hasRows(rRes)) return res.status(404).json({ status: 'ERROR', message: 'reservation not found' });
    const reservation = rRes.rows[0];

    const fromRoomRes = await client.query(`
      SELECT r.id, COALESCE(rt.name, r.name) AS room_type
      FROM rooms r
      LEFT JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.id = $1
    `, [reservation.room_id]);
    const toRoomRes = await client.query(`
      SELECT r.id, COALESCE(rt.name, r.name) AS room_type
      FROM rooms r
      LEFT JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.id = $1
    `, [to_room_id]);
    if (!hasRows(toRoomRes)) throw new Error('target room not found');
    const fromRoomType = hasRows(fromRoomRes) ? fromRoomRes.rows[0].room_type : null;
    const toRoomType = toRoomRes.rows[0].room_type;

    // If room_type changes, adjust availability per date
    const dates = enumerateDates(reservation.check_in, reservation.check_out);
    if (fromRoomType !== toRoomType) {
      // check availability on toRoomType for each date
      for (const date of dates) {
        const sel = await client.query('SELECT reserved_qty, total_rooms FROM availability_dates WHERE room_type = $1 AND date = $2 FOR UPDATE', [toRoomType, date]);
        if (!hasRows(sel)) throw new Error(`No availability record for ${toRoomType} on ${date}`);
        const row = sel.rows[0];
        const available = Number(row.total_rooms) - Number(row.reserved_qty);
        if (available < 1) throw new Error(`Not enough availability for ${toRoomType} on ${date}`);
      }
      // decrement old and increment new
      for (const date of dates) {
        if (fromRoomType) await client.query('UPDATE availability_dates SET reserved_qty = GREATEST(0, reserved_qty - 1) WHERE room_type = $1 AND date = $2', [fromRoomType, date]);
        await client.query('UPDATE availability_dates SET reserved_qty = reserved_qty + 1 WHERE room_type = $1 AND date = $2', [toRoomType, date]);
      }
    }

    // update reservation room assignment
    await client.query('UPDATE reservations SET room_id = $1 WHERE id = $2', [to_room_id, reservationId]);

    // Audit
    await client.query('INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id) VALUES ($1,$2,$3,$4,$5,$6)', [
      'PMS','MOVE','RESERVATION', reservationId, JSON.stringify({ from_room: reservation.room_id, to_room: to_room_id }), req.headers['x-correlation-id'] || null
    ]);

    await client.query('COMMIT');
    // broadcast move event
    try {
      broadcastEvent('ReservationMoved', {
        reservation_id: reservationId,
        from_room: reservation.room_id,
        to_room: to_room_id,
        check_in: reservation.check_in,
        check_out: reservation.check_out,
        timestamp: new Date().toISOString()
      });
    } catch (e) {
      console.error('Failed to broadcast ReservationMoved', e);
    }

    return res.json({ status: 'OK', message: 'moved', reservation_id: reservationId });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('Move error', err);
    return res.status(400).json({ status: 'FAILED', message: err.message });
  } finally {
    client.release();
  }
});

// Background sweeper job: release expired locks and adjust reserved_qty
async function sweepExpiredLocks() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const now = new Date().toISOString();
    const expired = await client.query('SELECT * FROM availability_locks WHERE lock_expires_at <= $1 FOR UPDATE', [now]);
    for (const row of expired.rows) {
      // decrement reserved_qty
      await client.query('UPDATE availability_dates SET reserved_qty = GREATEST(0, reserved_qty - $1) WHERE room_type = $2 AND date = $3', [row.qty_locked, row.room_type, row.date]);
      // remove lock
      await client.query('DELETE FROM availability_locks WHERE id = $1', [row.id]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error sweeping locks:', err);
  } finally {
    client.release();
  }
}

// run sweeper every minute
setInterval(() => {
  sweepExpiredLocks().catch((e) => console.error(e));
}, 60 * 1000);

// Sweeper for expired idempotency keys (cleanup)
async function sweepExpiredIdempotency() {
  const client = await pool.connect();
  try {
    const res = await client.query("DELETE FROM idempotency_keys WHERE expires_at <= NOW() RETURNING key, created_at");
    if (hasRows(res)) {
      console.log(`Sweeper: removed ${Number(res.rowCount ?? 0)} expired idempotency keys`);
    }
  } catch (err) {
    console.error('Error sweeping idempotency keys:', err);
  } finally {
    client.release();
  }
}

// run idempotency sweeper every hour
setInterval(() => {
  sweepExpiredIdempotency().catch((e) => console.error(e));
}, 60 * 60 * 1000);
