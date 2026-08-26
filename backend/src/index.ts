// backend/src/index.ts
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { Pool } from 'pg';
import { generateBid } from './utils/bid';
import { initializeDatabase } from './db/schema_v3';
import { createRoomCategoriesRouter } from './domains/roomMaster/roomCategoriesRouter';
import { createRoomTypesRouter } from './domains/roomMaster/roomTypesRouter';
import { createRoomsRouter } from './domains/roomMaster/roomsRouter';
import { parsePropertyId, assertRoomBelongsToProperty } from './domains/roomMaster/roomMasterService';
import {
  applyCancellationInventoryPlan,
  buildLegacyPreLedgerCancellationAudit,
  planReservationCancellationInventory
} from './domains/reservations/cancellationInventoryPolicy';
import {
  CanonicalAvailabilityKey,
  CanonicalAvailabilityRow,
  canonicalAvailabilityKey,
  lockCanonicalAvailabilityRows,
  mutateCanonicalAvailabilityRow
} from './domains/inventory/canonicalAvailability';
import { reconcileCanonicalAvailability } from './domains/inventory/canonicalReconciliation';
import { addHotelDays, enumerateHotelDates, hotelDateFromInstant, hotelDateKey, normalizeHotelDate } from './utils/hotelDate';

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

function parsePositiveInt(value: any): number | null {
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : null;
}

function assertPropertyId(bodyOrQuery: any): number {
  const raw = bodyOrQuery?.property_id;
  const propertyId = parsePositiveInt(raw);
  if (propertyId === null) {
    throw { statusCode: 400, code: 'VALIDATION_ERROR', message: 'property_id is required and must be a positive integer' };
  }
  return propertyId;
}

async function assertPropertyExists(pool: any, propertyId: number): Promise<void> {
  const result = await pool.query('SELECT id FROM properties WHERE id = $1', [propertyId]);
  if ((result.rowCount ?? 0) === 0) {
    throw { statusCode: 404, code: 'PROPERTY_NOT_FOUND', message: `property ${propertyId} not found` };
  }
}

async function assertReservationBelongsToProperty(pool: any, reservationId: number, propertyId: number): Promise<void> {
  const result = await pool.query(
    `SELECT res.id, r.property_id AS room_property_id
     FROM reservations res
     JOIN rooms r ON r.id = res.room_id
     WHERE res.id = $1`,
    [reservationId]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw { statusCode: 404, code: 'NOT_FOUND', message: `reservation ${reservationId} not found` };
  }
  const roomPropertyId = result.rows[0].room_property_id;
  if (roomPropertyId != null && Number(roomPropertyId) !== propertyId) {
    throw { statusCode: 403, code: 'PROPERTY_MISMATCH', message: `reservation ${reservationId} does not belong to property ${propertyId}` };
  }
}

const ROOM_OVERLAP_SQLSTATE = '23P01';
const ROOM_OVERLAP_RESPONSE = {
  status: 'CONFLICT',
  code: 'ROOM_OVERLAP',
  message: 'Room is already occupied or reserved for the requested dates.'
};

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
  host: process.env.DB_HOST || '127.0.0.1',
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
  await initializeDatabase(pool);
  const sweepSummary = await sweepExpiredLocks();
  const reconciliation = await reconcileCanonicalAvailability(pool);
  console.log('Database connected, expired holds swept, and canonical availability reconciled.', {
    sweepSummary,
    reconciliation
  });
  app.listen(5000, () => {
    console.log('Backend running on port 5000');
  });
}

if (require.main === module) {
  startServer().catch((err: any) => {
    console.error('Backend startup failed:', err.message);
    process.exitCode = 1;
  });
}

export { app, pool };

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

function getPropertyLocalDateSegment(dateValue: Date | string = new Date()): string {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const year = formatted.find((part) => part.type === 'year')?.value ?? '00';
  const month = formatted.find((part) => part.type === 'month')?.value ?? '01';
  const day = formatted.find((part) => part.type === 'day')?.value ?? '01';
  return `${year}${month}${day}`;
}

async function createBookingRecordForReservation(
  client: any,
  reservationPayload: {
    roomId: number;
    guestName: string;
    guestPhone?: string | null;
    bookingSource: string;
    legacyBookingNumber: string;
    correlationId: string;
    propertyId: number;
    propertyCode: string;
  }
) {
  const propertyCode = String(reservationPayload.propertyCode || 'LWG').trim().toUpperCase();
  const localDateSegment = getPropertyLocalDateSegment(new Date());
  let bid = '';
  let attempt = 0;

  while (attempt < 5) {
    bid = generateBid(propertyCode, localDateSegment);
    const exists = await client.query('SELECT 1 FROM bookings WHERE bid = $1', [bid]);
    if (!hasRows(exists)) {
      break;
    }
    attempt += 1;
  }

  if (!bid) {
    throw new Error('Failed to generate unique booking BID');
  }

  const bookingInsert = await client.query(
    `INSERT INTO bookings (
      bid,
      property_id,
      guest_name_snapshot,
      guest_phone_snapshot,
      booking_source,
      channel,
      booking_status,
      currency_code,
      legacy_booking_number,
      created_by,
      correlation_id,
      created_at,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
    RETURNING *;`,
    [
      bid,
      reservationPayload.propertyId,
      String(reservationPayload.guestName || '').trim() || 'Guest',
      reservationPayload.guestPhone || null,
      String(reservationPayload.bookingSource || 'WALKIN').toUpperCase(),
      null,
      'ACTIVE',
      'IDR',
      reservationPayload.legacyBookingNumber,
      'PMS',
      reservationPayload.correlationId || null,
    ]
  );

  return bookingInsert.rows[0];
}

function withReservationHotelDates<T extends Record<string, any>>(row: T): T {
  if (!row) return row;
  return {
    ...row,
    check_in: row.check_in == null ? row.check_in : hotelDateKey(row.check_in),
    check_out: row.check_out == null ? row.check_out : hotelDateKey(row.check_out)
  };
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

function isRoomStatusSellable(statusValue: any): boolean {
  const normalizedStatus = normalizeRoomPhysicalStatus(statusValue);
  if (normalizedStatus === null) {
    return true;
  }
  return ['VACANT_CLEAN', 'INSPECTED'].includes(normalizedStatus);
}

function isRoomOverlapViolation(err: any): boolean {
  return String(err?.code || '') === ROOM_OVERLAP_SQLSTATE;
}

function sendRoomOverlapConflict(res: express.Response) {
  return res.status(409).json(ROOM_OVERLAP_RESPONSE);
}

const RESERVATION_PATCH_CRITICAL_KEYS = new Set([
  'status',
  'stay_status',
  'room_id',
  'check_in',
  'check_out',
  'booking_id',
  'stay_sequence'
]);

const RESERVATION_PATCH_ALLOWLIST = new Set([
  'guest_name',
  'guest_phone',
  'guest_segment',
  'subtotal_amount',
  'total_price',
  'discount_amount',
  'discount_percent',
  'amount_paid',
  'remaining_balance',
  'payment_status',
  'ktp_path',
  'bukti_bayar_path',
  'booking_type'
]);

type RoomTypeIdentity = {
  roomTypeId: number | null;
  roomTypeName: string;
};

async function resolveReservationRoomType(client: any, roomId: number): Promise<RoomTypeIdentity> {
  const roomRow = await client.query(
    `SELECT r.room_type_id, COALESCE(rt.name, r.name) AS room_type
     FROM rooms r
     LEFT JOIN room_types rt ON rt.id = r.room_type_id
     WHERE r.id = $1`,
    [roomId]
  );

  if (!hasRows(roomRow) || !roomRow.rows[0].room_type) {
    throw new Error(`room not found for reservation room_id ${roomId}`);
  }

  const rawId = roomRow.rows[0].room_type_id;
  return {
    roomTypeId: rawId === null || rawId === undefined ? null : Number(rawId),
    roomTypeName: String(roomRow.rows[0].room_type)
  };
}

function toRoomTypeIdentity(rawTypeId: any, rawTypeName: any): RoomTypeIdentity {
  return {
    roomTypeId: rawTypeId === null || rawTypeId === undefined ? null : Number(rawTypeId),
    roomTypeName: String(rawTypeName || '')
  };
}

async function lockAndValidateAvailabilityDates(
  client: any,
  roomType: RoomTypeIdentity,
  dates: string[],
  mode: 'EXTEND' | 'SHORTEN'
) : Promise<Map<string, CanonicalAvailabilityRow>> {
  const roomTypeId = requireCanonicalRoomTypeId(roomType, 'reservation inventory change');
  const rows = await lockCanonicalAvailabilityRows(
    client,
    dates.map(date => ({ roomTypeId, roomTypeName: roomType.roomTypeName, date }))
  );
  for (const date of dates) {
    const availability = rows.get(canonicalAvailabilityKey(roomTypeId, date))!;
    const reservedQty = availability.reservedQty;
    const totalRooms = availability.totalRooms;
    if (mode === 'EXTEND') {
      if (reservedQty >= totalRooms) {
        throw new Error(`capacity exhausted for ${roomType.roomTypeName} on ${date}`);
      }
    } else if (reservedQty < 1) {
      throw new Error(`reserved_qty underflow for ${roomType.roomTypeName} on ${date}`);
    }
  }
  return rows;
}

// C2C2: Deterministic multi-row availability locking helper.
// Accepts canonical identities, deduplicates, sorts by (room_type_id ASC, date ASC),
// locks all rows with FOR UPDATE, and returns them keyed by canonical identity string.
type AvailabilityLockKey = CanonicalAvailabilityKey & { roomTypeName: string };

function requireCanonicalRoomTypeId(ident: RoomTypeIdentity, context: string): number {
  if (!Number.isInteger(ident.roomTypeId) || Number(ident.roomTypeId) <= 0) {
    throw new Error(`INVENTORY_INTEGRITY_ERROR: canonical room_type_id is required for ${context}`);
  }
  return Number(ident.roomTypeId);
}

async function lockAvailabilityRows(
  client: any,
  keys: AvailabilityLockKey[]
): Promise<Map<string, CanonicalAvailabilityRow>> {
  return lockCanonicalAvailabilityRows(client, keys);
}

function availabilityMapKey(ident: RoomTypeIdentity, date: string): string {
  return canonicalAvailabilityKey(requireCanonicalRoomTypeId(ident, `availability on ${date}`), date);
}

type BookingChildStatusSummary = {
  total: number;
  booked: number;
  checkedIn: number;
  checkedOut: number;
  cancelled: number;
  unsupported: number;
  statuses: Array<{ reservation_id: number; status: string }>;
  hasTerminalCheckedOut: boolean;
  hasActiveChild: boolean;
  allCancelled: boolean;
};

function buildBookingChildStatusSummary(children: any[]): BookingChildStatusSummary {
  const summary: BookingChildStatusSummary = {
    total: children.length,
    booked: 0,
    checkedIn: 0,
    checkedOut: 0,
    cancelled: 0,
    unsupported: 0,
    statuses: [],
    hasTerminalCheckedOut: false,
    hasActiveChild: false,
    allCancelled: children.length > 0
  };

  for (const child of children) {
    const status = String(child.status || '').toUpperCase();
    summary.statuses.push({ reservation_id: Number(child.id), status });

    if (status === 'BOOKED') {
      summary.booked += 1;
      summary.hasActiveChild = true;
      summary.allCancelled = false;
      continue;
    }

    if (status === 'CHECKED_IN') {
      summary.checkedIn += 1;
      summary.hasActiveChild = true;
      summary.allCancelled = false;
      continue;
    }

    if (status === 'CHECKED_OUT') {
      summary.checkedOut += 1;
      summary.hasTerminalCheckedOut = true;
      summary.allCancelled = false;
      continue;
    }

    if (status === 'CANCELLED') {
      summary.cancelled += 1;
      continue;
    }

    summary.unsupported += 1;
    summary.hasActiveChild = true;
    summary.allCancelled = false;
  }

  if (summary.booked > 0 || summary.checkedIn > 0 || summary.unsupported > 0) {
    summary.hasActiveChild = true;
  }

  summary.allCancelled = summary.total > 0 && summary.cancelled === summary.total;
  return summary;
}

function deriveBookingLifecycleStatus(currentBookingStatus: any, summary: BookingChildStatusSummary): 'ACTIVE' | 'CANCELLED' | 'COMPLETED' {
  const normalizedCurrent = String(currentBookingStatus || '').toUpperCase();
  if (normalizedCurrent === 'CANCELLED') {
    return 'CANCELLED';
  }

  if (normalizedCurrent === 'COMPLETED') {
    return 'COMPLETED';
  }

  if (summary.allCancelled) {
    return 'CANCELLED';
  }

  if (summary.hasActiveChild) {
    return 'ACTIVE';
  }

  if (summary.hasTerminalCheckedOut) {
    return 'COMPLETED';
  }

  return 'ACTIVE';
}

function buildBookingCompletionAuditPayload(
  booking: any,
  previousStatus: string,
  newStatus: string,
  summary: BookingChildStatusSummary,
  triggerReservationId: number
) {
  return {
    booking_id: Number(booking.id),
    bid: booking.bid,
    previous_status: previousStatus,
    new_status: newStatus,
    child_status_summary: summary,
    trigger_reservation_id: triggerReservationId
  };
}

// RM-1B drift fix: checkout must release reserved_qty for each occupied night.
// Reconciliation semantics treat CHECKED_OUT stays as non-consuming; releasing here
// keeps runtime ledger consistent with canonical startup reconciliation.
async function releaseReservationStayInventory(
  client: any,
  ident: RoomTypeIdentity,
  checkIn: string | Date,
  checkOut: string | Date
) {
  const dates = enumerateHotelDates(hotelDateKey(checkIn), hotelDateKey(checkOut));
  if (dates.length === 0) {
    return;
  }

  const roomTypeId = requireCanonicalRoomTypeId(ident, 'checkout inventory release');
  const rows = await lockCanonicalAvailabilityRows(
    client,
    dates.map(date => ({ roomTypeId, roomTypeName: ident.roomTypeName, date }))
  );
  for (const date of dates) {
    const row = rows.get(canonicalAvailabilityKey(roomTypeId, date))!;
    if (row.reservedQty < 1) {
      throw new Error(`INVENTORY_INTEGRITY_ERROR: reserved_qty underflow for ${ident.roomTypeName} on ${date} (reserved_qty=${row.reservedQty}, release=1)`);
    }
  }
  for (const date of dates) {
    await mutateCanonicalAvailabilityRow(client, rows.get(canonicalAvailabilityKey(roomTypeId, date))!, -1);
  }
}

async function findActiveRoomOverlap(
  client: any,
  targetRoomId: number,
  requestedCheckIn: string | Date,
  requestedCheckOut: string | Date,
  excludeReservationId: number | null = null
) {
  return client.query(
    `SELECT id
     FROM reservations existing
     WHERE existing.room_id = $1
       AND existing.status IN ('BOOKED','CHECKED_IN')
       AND existing.check_in < $2::date
       AND existing.check_out > $3::date
       AND ($4::int IS NULL OR existing.id <> $4)
     LIMIT 1
     FOR UPDATE OF existing`,
    [targetRoomId, requestedCheckOut, requestedCheckIn, excludeReservationId]
  );
}

function normalizeBookingSourceValue(value: any): 'OTA' | 'WALKIN' {
  return String(value || 'WALKIN').toLowerCase() === 'ota' ? 'OTA' : 'WALKIN';
}

function normalizeGuestSegmentValue(value: any): string {
  const normalized = String(value || 'Reguler');
  return ['Reguler', 'Group', 'Corporate'].includes(normalized) ? normalized : 'Reguler';
}

function normalizeCurrencyCodeValue(value: any): string {
  return String(value || 'IDR').trim().toUpperCase() || 'IDR';
}

function toPositiveInteger(value: any, fallback = 1): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createHttpError(statusCode: number, message: string, code?: string) {
  const error: any = new Error(message);
  error.statusCode = statusCode;
  if (code) {
    error.code = code;
  }
  return error;
}

function isUniqueViolation(err: any): boolean {
  return String(err?.code || '') === '23505';
}

function responseStatusTextForCode(statusCode: number): 'SUCCESS' | 'FAILED' | 'ERROR' {
  if (statusCode >= 500 || statusCode === 400) {
    return 'ERROR';
  }
  return 'FAILED';
}

async function persistIdempotencyResult(req: any, res: express.Response, statusCode: number, responseObj: any) {
  const idKey = (req as any)._idempotency_key;
  if (!idKey) {
    return;
  }

  const respBody = JSON.stringify(responseObj);
  let headersObj: any = {};
  try {
    headersObj = (res as any).getHeaders ? (res as any).getHeaders() : { 'content-type': 'application/json' };
  } catch (_e) {
    headersObj = { 'content-type': 'application/json' };
  }
  const respHeaders = JSON.stringify(headersObj);
  await pool.query(
    'UPDATE idempotency_keys SET response_body = $1, response_headers = $2, status_code = $3 WHERE key = $4',
    [respBody, respHeaders, statusCode, idKey]
  );
}

async function createBookingParentRecord(
  client: any,
  bookingPayload: {
    propertyId: number;
    propertyCode: string;
    guestName: string;
    guestPhone: string | null;
    bookingSource: string;
    channel: string | null;
    currencyCode: string;
    correlationId: string | null;
  }
) {
  const propertyCode = String(bookingPayload.propertyCode || 'LWG').trim().toUpperCase();
  const localDateSegment = getPropertyLocalDateSegment(new Date());
  const guestName = String(bookingPayload.guestName || '').trim() || 'Guest';
  const bookingSource = normalizeBookingSourceValue(bookingPayload.bookingSource);
  let attempt = 0;

  while (attempt < 5) {
    const bid = generateBid(propertyCode, localDateSegment);
    try {
      const bookingInsert = await client.query(
        `INSERT INTO bookings (
          bid,
          property_id,
          guest_name_snapshot,
          guest_phone_snapshot,
          booking_source,
          channel,
          booking_status,
          currency_code,
          legacy_booking_number,
          created_by,
          correlation_id,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
        RETURNING *;`,
        [
          bid,
          bookingPayload.propertyId,
          guestName,
          bookingPayload.guestPhone || null,
          bookingSource,
          bookingPayload.channel || null,
          'ACTIVE',
          bookingPayload.currencyCode || 'IDR',
          null,
          'PMS',
          bookingPayload.correlationId || null
        ]
      );

      return bookingInsert.rows[0];
    } catch (err: any) {
      if (isUniqueViolation(err)) {
        attempt += 1;
        continue;
      }
      throw err;
    }
  }

  throw new Error('Failed to generate unique booking BID');
}

async function createChildReservationRecord(
  client: any,
  params: {
    bookingId: number;
    bid: string;
    bookingSource: string;
    child: any;
    staySequence: number;
    correlationId: string | null;
    bookingLegacyNumber?: string | null;
  }
) {
  const child = params.child;
  const billingSummary = computeBillingSummary(child.totalPrice, child.discountAmount, child.discountPercent, child.amountPaid);
  const reservationBookingType = normalizeBookingSourceValue(child.bookingType || params.bookingSource);
  const reservationPaymentStatus = child.paymentStatus || billingSummary.paymentStatus;
  let attempt = 0;

  while (attempt < 5) {
    const bookingNumber = await generateBookingId(client, params.bookingSource);

    try {
      const inserted = await client.query(
        `INSERT INTO reservations (
          room_id, guest_name, guest_phone, guest_segment, check_in, check_out,
          total_price, payment_status, discount_amount, discount_percent, amount_paid, remaining_balance,
          booking_number, booking_type, booking_id, stay_sequence, status, stay_status, correlation_id, ktp_path, bukti_bayar_path,
          booked_room_type_id_snapshot, booked_room_type_code_snapshot, booked_room_type_name_snapshot,
          booked_room_category_id_snapshot, booked_room_category_code_snapshot, booked_room_category_name_snapshot,
          classification_snapshot_source, classification_snapshotted_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
          'BOOKED', 'RESERVED', $17, $18, $19,
          $20, $21, $22, $23, $24, $25, $26, CURRENT_TIMESTAMP
        )
        RETURNING *;`,
        [
          child.roomId,
          child.guestName,
          child.guestPhone,
          child.guestSegment,
          child.checkIn,
          child.checkOut,
          billingSummary.totalAfterDiscount,
          reservationPaymentStatus,
          billingSummary.discount,
          billingSummary.discountPercent,
          billingSummary.amountPaid,
          billingSummary.remainingBalance,
          bookingNumber,
          reservationBookingType,
          params.bookingId,
          params.staySequence,
          params.correlationId || null,
          child.ktpPath || null,
          child.buktiBayarPath || null,
          child.roomTypeIdSnapshot,
          child.roomTypeCodeSnapshot,
          child.roomTypeNameSnapshot,
          child.roomCategoryIdSnapshot,
          child.roomCategoryCodeSnapshot,
          child.roomCategoryNameSnapshot,
          child.classificationSnapshotSource
        ]
      );

      return { reservation: inserted.rows[0], bookingNumber };
    } catch (err: any) {
      if (isUniqueViolation(err) && String(err?.constraint || '').includes('reservations_booking_number')) {
        attempt += 1;
        continue;
      }
      throw err;
    }
  }

  throw new Error('Failed to generate unique reservation booking number');
}

async function createCanonicalBooking(
  req: any,
  bookingPayload: {
    property_id: any;
    guest_name: any;
    guest_phone?: any;
    guest_segment?: any;
    booking_source?: any;
    channel?: any;
    currency_code?: any;
  },
  reservationPayloads: any[],
  options: { requirePropertyId?: boolean } = {}
) {
  const rawReservationPayloads = Array.isArray(reservationPayloads) ? reservationPayloads : [];
  if (rawReservationPayloads.length < 1) {
    throw createHttpError(400, 'reservations must be a non-empty array');
  }

  const bookingPropertyId = Number(bookingPayload.property_id);
  if (!Number.isFinite(bookingPropertyId) || bookingPropertyId <= 0) {
    if (options.requirePropertyId === false) {
      throw createHttpError(400, 'property_id is required');
    }
    throw createHttpError(400, 'property_id is required');
  }

  const guestName = String(bookingPayload.guest_name || '').trim();
  if (!guestName) {
    throw createHttpError(400, 'guest_name is required');
  }

  const guestPhone = Object.prototype.hasOwnProperty.call(bookingPayload, 'guest_phone')
    ? String(bookingPayload.guest_phone || '').trim() || null
    : null;
  const guestSegment = normalizeGuestSegmentValue(bookingPayload.guest_segment);
  const bookingSource = normalizeBookingSourceValue(bookingPayload.booking_source);
  const channel = Object.prototype.hasOwnProperty.call(bookingPayload, 'channel')
    ? String(bookingPayload.channel || '').trim() || null
    : null;
  const currencyCode = normalizeCurrencyCodeValue(bookingPayload.currency_code);
  const correlationId = String((req.headers && req.headers['x-correlation-id']) || req.headers?.['X-Correlation-Id'] || `CORR-${Date.now()}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const propertyResult = await client.query(
      'SELECT id, property_code FROM properties WHERE id = $1',
      [bookingPropertyId]
    );
    if (!hasRows(propertyResult)) {
      throw createHttpError(400, 'invalid property_id');
    }
    const propertyCode = String(propertyResult.rows[0].property_code || 'LWG');

    const bookingRecord = await createBookingParentRecord(client, {
      propertyId: bookingPropertyId,
      propertyCode,
      guestName,
      guestPhone,
      bookingSource,
      channel,
      currencyCode,
      correlationId
    });

    const normalizedChildren: any[] = [];
    for (let index = 0; index < rawReservationPayloads.length; index += 1) {
      const child = rawReservationPayloads[index] || {};
      const roomId = Number(child.room_id);
      if (!Number.isFinite(roomId) || roomId <= 0) {
        throw createHttpError(400, `reservations[${index}].room_id is required`);
      }

      const checkIn = normalizeHotelDate(child.check_in);
      if (!checkIn) {
        throw createHttpError(400, `reservations[${index}].check_in is invalid`);
      }

      const checkOut = normalizeHotelDate(child.check_out);
      if (!checkOut) {
        throw createHttpError(400, `reservations[${index}].check_out is invalid`);
      }

      if (checkOut <= checkIn) {
        throw createHttpError(400, `reservations[${index}].check_out must be after check_in`);
      }

      normalizedChildren.push({
        index,
        roomId,
        checkIn,
        checkOut,
        guestName: String(child.guest_name || guestName).trim() || guestName,
        guestPhone: Object.prototype.hasOwnProperty.call(child, 'guest_phone')
          ? String(child.guest_phone || '').trim() || guestPhone
          : guestPhone,
        guestSegment: normalizeGuestSegmentValue(child.guest_segment || guestSegment),
        bookingType: normalizeBookingSourceValue(child.booking_type || child.bookingType || bookingSource),
        totalPrice: Number(child.total_price ?? child.subtotal_amount ?? 0),
        discountAmount: Number(child.discount_amount ?? 0),
        discountPercent: Number(child.discount_percent ?? 0),
        amountPaid: Number(child.amount_paid ?? 0),
        paymentStatus: child.payment_status || null,
        quantity: (() => {
          const q = toPositiveInteger(child.qty ?? child.quantity ?? 1, 1);
          if (q > 1) {
            throw createHttpError(400,
              'Satu reservasi kamar hanya dapat menggunakan 1 kamar fisik. Gunakan Tambah Kamar untuk reservasi beberapa kamar.',
              'RESERVATION_QUANTITY_UNSUPPORTED');
          }
          return q;
        })(),
        ktpPath: child.ktp_path || null,
        buktiBayarPath: child.bukti_bayar_path || null,
        roomType: null,
        roomTypeId: null,
        roomPropertyId: null,
        roomTypeIdSnapshot: null,
        roomTypeCodeSnapshot: null,
        roomTypeNameSnapshot: null,
        roomCategoryIdSnapshot: null,
        roomCategoryCodeSnapshot: null,
        roomCategoryNameSnapshot: null,
        classificationSnapshotSource: 'CANONICAL_ROOM_MASTER'
      });
    }

    const roomKeyMap = new Map<string, { ident: RoomTypeIdentity; date: string; delta: number }>();
    const duplicatePairs: Array<[number, number]> = [];
    const roomWindows = new Map<number, Array<{ start: string; end: string; index: number }>>();

    normalizedChildren.sort((a, b) => a.roomId - b.roomId);

    for (const child of normalizedChildren) {
      const roomRow = await client.query(
        `SELECT r.id AS room_id, r.room_number, r.status AS room_status,
                r.room_type_id AS canonical_room_type_id,
                rt.code AS room_type_code,
                COALESCE(rt.name, r.name) AS room_type,
                rc.id AS room_category_id,
                rc.code AS room_category_code,
                rc.name AS room_category_name,
                p.id AS property_id, p.property_code,
                r.is_active AS room_is_active,
                rt.is_active AS room_type_is_active
         FROM rooms r
          JOIN room_types rt ON rt.id = r.room_type_id
         LEFT JOIN room_categories rc
           ON rc.id = rt.room_category_id AND rc.property_id = rt.property_id
         JOIN properties p ON p.id = r.property_id
          WHERE r.id = $1
          FOR UPDATE OF r`,
        [child.roomId]
      );

      if (!hasRows(roomRow)) {
        throw createHttpError(409, `room ${child.roomId} not found`);
      }

      const roomInfo = roomRow.rows[0];
      const roomPropertyId = Number(roomInfo.property_id);
      if (bookingPropertyId !== roomPropertyId) {
        throw createHttpError(409, `room ${child.roomId} does not belong to property ${bookingPropertyId}`);
      }

      const roomStatus = roomInfo.room_status;
      if (!isRoomStatusSellable(roomStatus)) {
        throw createHttpError(409, `room ${child.roomId} is not sellable: status=${String(roomStatus || 'UNKNOWN')}`);
      }

      if (roomInfo.room_is_active === false || roomInfo.room_type_is_active === false) {
        throw createHttpError(409, `room ${child.roomId} or its room type is inactive in Room Master and cannot accept new bookings`);
      }

      child.roomType = String(roomInfo.room_type || '');
      if (!child.roomType) {
        throw createHttpError(409, `room type missing for room ${child.roomId}`);
      }
      child.roomTypeId = roomInfo.canonical_room_type_id === null || roomInfo.canonical_room_type_id === undefined
        ? null
        : Number(roomInfo.canonical_room_type_id);
      if (child.roomTypeId === null || !roomInfo.room_type_code) {
        throw createHttpError(409, `room ${child.roomId} is not attached to a canonical room type`);
      }
      child.roomPropertyId = roomPropertyId;
      child.roomTypeIdSnapshot = child.roomTypeId;
      child.roomTypeCodeSnapshot = roomInfo.room_type_code === null || roomInfo.room_type_code === undefined
        ? null
        : String(roomInfo.room_type_code);
      child.roomTypeNameSnapshot = child.roomType;
      child.roomCategoryIdSnapshot = roomInfo.room_category_id === null || roomInfo.room_category_id === undefined
        ? null
        : Number(roomInfo.room_category_id);
      child.roomCategoryCodeSnapshot = roomInfo.room_category_code === null || roomInfo.room_category_code === undefined
        ? null
        : String(roomInfo.room_category_code);
      child.roomCategoryNameSnapshot = roomInfo.room_category_name === null || roomInfo.room_category_name === undefined
        ? null
        : String(roomInfo.room_category_name);

      const windows = roomWindows.get(child.roomId) || [];
      for (const previous of windows) {
        if (previous.start < child.checkOut && previous.end > child.checkIn) {
          duplicatePairs.push([previous.index, child.index]);
        }
      }
      windows.push({ start: child.checkIn, end: child.checkOut, index: child.index });
      roomWindows.set(child.roomId, windows);

      const dates = enumerateHotelDates(child.checkIn, child.checkOut);
      for (const date of dates) {
        const key = canonicalAvailabilityKey(child.roomTypeId, date);
        const current = roomKeyMap.get(key);
        if (current) {
          current.delta += child.quantity;
        } else {
          roomKeyMap.set(key, { ident: toRoomTypeIdentity(child.roomTypeId, child.roomType), date, delta: child.quantity });
        }
      }
    }

    if (duplicatePairs.length > 0) {
      const [firstA, firstB] = duplicatePairs[0];
      throw createHttpError(
        409,
        `duplicate room usage inside the same request overlaps between reservations[${firstA}] and reservations[${firstB}]`
      );
    }

    const lockKeys = Array.from(roomKeyMap.values()).sort((a, b) => {
      const aId = requireCanonicalRoomTypeId(a.ident, `booking availability on ${a.date}`);
      const bId = requireCanonicalRoomTypeId(b.ident, `booking availability on ${b.date}`);
      if (aId !== bId) {
        return aId - bId;
      }
      if (a.ident.roomTypeName !== b.ident.roomTypeName) {
        return a.ident.roomTypeName.localeCompare(b.ident.roomTypeName);
      }
      return a.date.localeCompare(b.date);
    });

    // C2C2: LOCK RESERVATIONS (overlap) BEFORE AVAILABILITY.
    // Canonical lock order: ROOM → RESERVATION → AVAILABILITY
    for (const child of normalizedChildren) {
      const overlap = await findActiveRoomOverlap(client, child.roomId, child.checkIn, child.checkOut);
      if (hasRows(overlap)) {
        throw Object.assign(new Error(ROOM_OVERLAP_RESPONSE.message), {
          statusCode: 409,
          code: ROOM_OVERLAP_SQLSTATE
        });
      }
    }

    // C2C2: LOCK AVAILABILITY after RESERVATION, using deterministic helper.
    const availabilityRows = await lockAvailabilityRows(
      client,
      lockKeys.map(k => ({
        roomTypeId: requireCanonicalRoomTypeId(k.ident, `booking availability on ${k.date}`),
        roomTypeName: k.ident.roomTypeName,
        date: k.date
      }))
    );

    for (const key of lockKeys) {
      const availability = availabilityRows.get(availabilityMapKey(key.ident, key.date));
      if (!availability) {
        throw createHttpError(409, `availability row missing for ${key.ident.roomTypeName} on ${key.date}`);
      }

      if (availability.reservedQty + key.delta > availability.totalRooms) {
        throw createHttpError(
          409,
          `Not enough availability for ${key.ident.roomTypeName} on ${key.date} (available=${availability.totalRooms - availability.reservedQty}, requested=${key.delta})`
        );
      }
    }

    for (const key of lockKeys) {
      await mutateCanonicalAvailabilityRow(
        client,
        availabilityRows.get(availabilityMapKey(key.ident, key.date))!,
        key.delta
      );
    }

    const insertedChildren: any[] = [];
    let bookingLegacyNumber: string | null = null;
    for (const child of normalizedChildren) {
      const inserted = await createChildReservationRecord(client, {
        bookingId: Number(bookingRecord.id),
        bid: String(bookingRecord.bid),
        bookingSource,
        child,
        staySequence: child.index + 1,
        correlationId,
        bookingLegacyNumber
      });

      if (!bookingLegacyNumber) {
        bookingLegacyNumber = inserted.bookingNumber;
        await client.query(
          `UPDATE bookings
           SET legacy_booking_number = $1,
               updated_at = NOW()
           WHERE id = $2`,
          [bookingLegacyNumber, Number(bookingRecord.id)]
        );
      }

      if (Number(inserted.reservation.total_price || 0) > 0) {
        await client.query(
          `INSERT INTO folio_entries (reservation_id, entry_type, description, amount, direction)
           VALUES ($1, $2, $3, $4, 'DEBIT')`,
          [inserted.reservation.id, 'ROOM_CHARGE', 'Reservasi kamar', Number(inserted.reservation.total_price || 0)]
        );
      }

      insertedChildren.push({
        ...inserted.reservation,
        bid: String(bookingRecord.bid),
        booking_id: Number(bookingRecord.id),
        stay_sequence: child.index + 1
      });
    }

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        'PMS',
        'CREATE',
        'BOOKING',
        Number(bookingRecord.id),
        JSON.stringify({
          booking_id: Number(bookingRecord.id),
          bid: String(bookingRecord.bid),
          property_id: bookingPropertyId,
          booking_source: bookingSource,
          channel,
          booking_status: 'ACTIVE',
          reservation_count: insertedChildren.length,
          correlation_id: correlationId
        }),
        correlationId
      ]
    );

    for (const reservation of insertedChildren) {
      await client.query(
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          'PMS',
          'CREATE',
          'RESERVATION',
          Number(reservation.id),
          JSON.stringify({
            booking_id: Number(bookingRecord.id),
            bid: String(bookingRecord.bid),
            reservation_id: Number(reservation.id),
            stay_sequence: Number(reservation.stay_sequence),
            room_id: Number(reservation.room_id),
            check_in: hotelDateKey(reservation.check_in),
            check_out: hotelDateKey(reservation.check_out),
            status: reservation.status,
            correlation_id: correlationId
          }),
          correlationId
        ]
      );
    }

    await client.query('COMMIT');

    return {
      booking: {
        id: Number(bookingRecord.id),
        bid: String(bookingRecord.bid),
        property_id: bookingPropertyId,
        guest_name_snapshot: guestName,
        guest_phone_snapshot: guestPhone,
        booking_source: bookingSource,
        channel,
        booking_status: 'ACTIVE',
        currency_code: currencyCode,
        legacy_booking_number: bookingLegacyNumber,
        correlation_id: correlationId
      },
      reservations: insertedChildren.map(withReservationHotelDates),
      correlationId,
      bookingLegacyNumber
    };
  } catch (err: any) {
    try { require('fs').writeFileSync('debug_create_error.txt', JSON.stringify({ message: err?.message, code: err?.code, detail: err?.detail, stack: err?.stack?.split('\n').slice(0, 8) }, null, 2)); } catch(_e) {}
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function createReservationRecord(req: any, payload: any) {
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

  const roomRow = await pool.query(
    `SELECT r.id AS room_id, p.id AS property_id
     FROM rooms r
     JOIN properties p ON p.id = r.property_id
     WHERE r.id = $1`,
    [Number(room_id)]
  );
  if (!hasRows(roomRow)) {
    throw createHttpError(409, 'Invalid room_id');
  }

  const bookingSource = normalizeBookingSourceValue(booking_type ?? bookingType ?? source ?? 'walkin');
  const canonicalResult = await createCanonicalBooking(
    req,
    {
      property_id: roomRow.rows[0].property_id,
      guest_name,
      guest_phone,
      guest_segment,
      booking_source: bookingSource,
      channel: null,
      currency_code: 'IDR'
    },
    [
      {
        room_id,
        check_in,
        check_out,
        subtotal_amount,
        total_price,
        discount_amount,
        discount_percent,
        amount_paid,
        payment_status,
        booking_type: bookingSource,
        qty,
        ktp_path,
        bukti_bayar_path,
        guest_name,
        guest_phone,
        guest_segment
      }
    ],
    { requirePropertyId: true }
  );

  const reservationResponse = canonicalResult.reservations[0];
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

  return {
    status: 'SUCCESS',
    data: reservationResponse,
    lock_expires_at: expiresAt.toISOString(),
    canonical: canonicalResult
  };
}

app.get('/api/reservations/:id', async (req, res) => {
  const reservationId = Number(req.params.id);
  try {
    const propertyId = assertPropertyId(req.query);
    await assertPropertyExists(pool, propertyId);
    await assertReservationBelongsToProperty(pool, reservationId, propertyId);

    const result = await pool.query(`
      SELECT 
        r.*,
        r.id as reservation_id,
        r.booking_number as legacy_booking_number,
        b.bid,
        b.id as booking_id_value
      FROM reservations r
      LEFT JOIN bookings b ON b.id = r.booking_id
      WHERE r.id = $1
    `, [reservationId]);
    if (!hasRows(result)) {
      return res.status(404).json({ status: 'ERROR', message: 'reservation not found' });
    }
    res.json({ status: 'OK', data: withReservationHotelDates(result.rows[0]) });
  } catch (err: any) {
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ status: 'ERROR', code: err.code, message: err.message });
    }
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

// GET booking by BID (new read-only endpoint)
app.get('/api/bookings/:bid', async (req, res) => {
  const bidParam = String(req.params.bid || '').toUpperCase().trim();
  if (!bidParam) {
    return res.status(400).json({ status: 'ERROR', message: 'BID is required' });
  }
  
  try {
    const propertyId = parsePropertyId(req.query.property_id, 'property_id');
    await assertPropertyExists(pool, propertyId);

    const result = await pool.query(
      `SELECT 
        id as booking_id,
        bid,
        property_id,
        guest_name_snapshot,
        guest_phone_snapshot,
        booking_source,
        channel,
        booking_status,
        currency_code,
        legacy_booking_number,
        created_at,
        updated_at
      FROM bookings
      WHERE UPPER(bid) = $1`,
      [bidParam]
    );
    
    if (!hasRows(result)) {
      return res.status(404).json({ status: 'ERROR', message: 'booking not found' });
    }

    const booking = result.rows[0];
    if (booking.property_id != null && Number(booking.property_id) !== propertyId) {
      return res.status(403).json({ status: 'ERROR', code: 'PROPERTY_MISMATCH', message: 'booking does not belong to this property' });
    }
    
    res.json({ status: 'OK', data: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

// GET child reservations for a booking (new read-only endpoint)
app.get('/api/bookings/:bid/reservations', async (req, res) => {
  const bidParam = String(req.params.bid || '').toUpperCase().trim();
  if (!bidParam) {
    return res.status(400).json({ status: 'ERROR', message: 'BID is required' });
  }
  
  try {
    const propertyId = parsePropertyId(req.query.property_id, 'property_id');
    await assertPropertyExists(pool, propertyId);

    // First get the booking
    const bookingResult = await pool.query(
      `SELECT id, property_id FROM bookings WHERE UPPER(bid) = $1`,
      [bidParam]
    );
    
    if (!hasRows(bookingResult)) {
      return res.status(404).json({ status: 'ERROR', message: 'booking not found' });
    }

    const booking = bookingResult.rows[0];
    if (booking.property_id != null && Number(booking.property_id) !== propertyId) {
      return res.status(403).json({ status: 'ERROR', code: 'PROPERTY_MISMATCH', message: 'booking does not belong to this property' });
    }
    
    const bookingId = booking.id;
    
    // Then get all reservations for this booking
    const reservationsResult = await pool.query(
      `SELECT 
        r.*,
        r.id as reservation_id,
        r.booking_number as legacy_booking_number,
        b.bid,
        b.id as booking_id_value
      FROM reservations r
      JOIN bookings b ON b.id = r.booking_id
      WHERE r.booking_id = $1
      ORDER BY r.stay_sequence ASC`,
      [bookingId]
    );
    
    res.json({ status: 'OK', data: reservationsResult.rows.map(withReservationHotelDates) });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.patch('/api/bookings/:bid', async (req, res) => {
  const bidParam = String(req.params.bid || '').toUpperCase().trim();
  if (!bidParam) {
    return res.status(400).json({ status: 'ERROR', message: 'BID is required' });
  }

  const payload = req.body || {};
  const allowedStatuses = ['ACTIVE', 'CANCELLED', 'COMPLETED'];
  const bookingStatus = typeof payload.booking_status === 'string' ? payload.booking_status.toUpperCase() : null;

  if (bookingStatus && !allowedStatuses.includes(bookingStatus)) {
    return res.status(400).json({ status: 'ERROR', message: 'invalid booking_status' });
  }

  if (bookingStatus === 'CANCELLED') {
    return res.status(409).json({
      status: 'ERROR',
      message: 'booking_status=CANCELLED is not allowed through PATCH; use POST /api/bookings/:bid/cancel'
    });
  }

  if (bookingStatus === 'COMPLETED') {
    return res.status(409).json({
      status: 'ERROR',
      message: 'booking_status=COMPLETED is not allowed through PATCH; use the authoritative checkout/completion flow'
    });
  }

  try {
    const propertyId = parsePropertyId(req.body.property_id, 'property_id');
    await assertPropertyExists(pool, propertyId);

    const result = await pool.query(
      `SELECT * FROM bookings WHERE UPPER(bid) = $1`,
      [bidParam]
    );

    if (!hasRows(result)) {
      return res.status(404).json({ status: 'ERROR', message: 'booking not found' });
    }

    const booking = result.rows[0];
    if (booking.property_id != null && Number(booking.property_id) !== propertyId) {
      return res.status(403).json({ status: 'ERROR', code: 'PROPERTY_MISMATCH', message: 'booking does not belong to this property' });
    }

    const updatedBooking = await pool.query(
      `UPDATE bookings
       SET guest_name_snapshot = COALESCE($1, guest_name_snapshot),
           guest_phone_snapshot = COALESCE($2, guest_phone_snapshot),
           channel = COALESCE($3, channel),
           booking_status = COALESCE($4, booking_status),
           currency_code = COALESCE($5, currency_code),
           legacy_booking_number = COALESCE($6, legacy_booking_number),
           updated_at = NOW()
       WHERE id = $7
       RETURNING *;`,
      [
        payload.guest_name_snapshot ?? null,
        payload.guest_phone_snapshot ?? null,
        payload.channel ?? null,
        bookingStatus,
        payload.currency_code ?? null,
        payload.legacy_booking_number ?? null,
        booking.id,
      ]
    );

    res.json({ status: 'OK', data: updatedBooking.rows[0] });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.post('/api/bookings/:bid/cancel', async (req, res) => {
  const bidParam = String(req.params.bid || '').toUpperCase().trim();
  if (!bidParam) {
    return res.status(400).json({ status: 'ERROR', message: 'BID is required' });
  }

  const correlationId = req.headers['x-correlation-id'] || null;
  const client = await pool.connect();

  try {
    const propertyId = parsePropertyId(req.body.property_id, 'property_id');
    await assertPropertyExists(pool, propertyId);

    await client.query('BEGIN');

    const bookingResult = await client.query(
      `SELECT *
       FROM bookings
       WHERE UPPER(bid) = $1
       FOR UPDATE`,
      [bidParam]
    );

    if (!hasRows(bookingResult)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', message: 'booking not found' });
    }

    const booking = bookingResult.rows[0];

    if (booking.property_id != null && Number(booking.property_id) !== propertyId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ status: 'ERROR', code: 'PROPERTY_MISMATCH', message: 'booking does not belong to this property' });
    }

    const reservationsResult = await client.query(
      `SELECT *
       FROM reservations
       WHERE booking_id = $1
       ORDER BY stay_sequence, id
       FOR UPDATE`,
      [booking.id]
    );

    if (!hasRows(reservationsResult)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        status: 'ERROR',
        message: 'booking has no linked reservations and cannot be cancelled through this flow'
      });
    }

    const childReservations = reservationsResult.rows;

    // Validate all children before any inventory or lifecycle mutation.
    for (const reservation of childReservations) {
      const childStatus = String(reservation.status || '').toUpperCase();

      if (childStatus === 'BOOKED' || childStatus === 'CANCELLED') {
        continue;
      }

      if (childStatus === 'CHECKED_IN') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          status: 'ERROR',
          message: `booking cannot be cancelled because reservation ${reservation.id} is CHECKED_IN`
        });
      }

      if (childStatus === 'CHECKED_OUT') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          status: 'ERROR',
          message: `booking cannot be cancelled because reservation ${reservation.id} is CHECKED_OUT`
        });
      }

      await client.query('ROLLBACK');
      return res.status(409).json({
        status: 'ERROR',
        message: `booking cannot be cancelled because reservation ${reservation.id} has unsupported status ${childStatus || 'UNKNOWN'}`
      });
    }

    const bookingAlreadyCancelled = String(booking.booking_status || '').toUpperCase() === 'CANCELLED';
    const allChildrenCancelled = childReservations.every(
      (reservation: any) => String(reservation.status || '').toUpperCase() === 'CANCELLED'
    );

    if (bookingAlreadyCancelled && allChildrenCancelled) {
      await client.query('COMMIT');
      return res.json({
        status: 'SUCCESS',
        data: booking,
        message: 'booking already cancelled'
      });
    }

    const releaseByKey = new Map<string, { roomTypeId: number; roomTypeName: string; date: string; delta: number }>();
    for (const reservation of childReservations) {
      const childStatus = String(reservation.status || '').toUpperCase();
      if (childStatus === 'CANCELLED') continue;

      const roomTypeResult = await client.query(
        `SELECT r.room_type_id, rt.name AS room_type
         FROM rooms r
         JOIN room_types rt ON rt.id = r.room_type_id
         WHERE r.id = $1`,
        [reservation.room_id]
      );

      if (!hasRows(roomTypeResult)) {
        throw new Error(`INVENTORY_INTEGRITY_ERROR: room not found for reservation ${reservation.id}`);
      }

      const roomTypeIdent = toRoomTypeIdentity(roomTypeResult.rows[0].room_type_id, roomTypeResult.rows[0].room_type);
      const roomTypeId = requireCanonicalRoomTypeId(roomTypeIdent, `booking cancellation reservation ${reservation.id}`);

      const occupiedDates = enumerateHotelDates(reservation.check_in, reservation.check_out).sort();

      if (occupiedDates.length === 0) {
        throw new Error(`INVENTORY_INTEGRITY_ERROR: invalid stay range for reservation ${reservation.id}`);
      }

      for (const date of occupiedDates) {
        const key = canonicalAvailabilityKey(roomTypeId, date);
        const current = releaseByKey.get(key);
        if (current) current.delta += 1;
        else releaseByKey.set(key, { roomTypeId, roomTypeName: roomTypeIdent.roomTypeName, date, delta: 1 });
      }
    }

    const releaseEntries = Array.from(releaseByKey.values()).sort((a, b) =>
      a.roomTypeId - b.roomTypeId || a.date.localeCompare(b.date)
    );
    const availabilityRows = await lockCanonicalAvailabilityRows(client, releaseEntries);
    for (const entry of releaseEntries) {
      const row = availabilityRows.get(canonicalAvailabilityKey(entry.roomTypeId, entry.date))!;
      if (row.reservedQty < entry.delta) {
        throw new Error(
          `INVENTORY_INTEGRITY_ERROR: reserved_qty underflow for ${entry.roomTypeName} on ${entry.date} (reserved_qty=${row.reservedQty}, release=${entry.delta})`
        );
      }
    }
    for (const entry of releaseEntries) {
      await mutateCanonicalAvailabilityRow(
        client,
        availabilityRows.get(canonicalAvailabilityKey(entry.roomTypeId, entry.date))!,
        -entry.delta
      );
    }

    for (const reservation of childReservations) {
      const childStatus = String(reservation.status || '').toUpperCase();
      if (childStatus === 'CANCELLED') continue;

      const updatedReservation = await client.query(
        `UPDATE reservations
         SET status = 'CANCELLED',
             stay_status = 'CANCELLED'
         WHERE id = $1
           AND status = 'BOOKED'
         RETURNING *`,
        [reservation.id]
      );

      if (!hasRows(updatedReservation)) {
        throw new Error(`CANCELLATION_INTEGRITY_ERROR: reservation ${reservation.id} was not updated`);
      }

      await client.query(
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['PMS', 'CANCEL', 'RESERVATION', reservation.id, JSON.stringify(updatedReservation.rows[0]), correlationId]
      );
    }

    const updatedBookingResult = await client.query(
      `UPDATE bookings
       SET booking_status = 'CANCELLED',
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [booking.id]
    );

    const updatedBooking = updatedBookingResult.rows[0];

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['PMS', 'CANCEL', 'BOOKING', booking.id, JSON.stringify(updatedBooking), correlationId]
    );

    await client.query('COMMIT');

    res.json({ status: 'SUCCESS', data: updatedBooking });
  } catch (err: any) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Booking cancellation rollback failed', rollbackErr);
    }

    const message = String(err?.message || err);
    const status = message.includes('INVENTORY_INTEGRITY_ERROR') || message.includes('CANCELLATION_INTEGRITY_ERROR') ? 409 : 500;
    res.status(status).json({ status: 'ERROR', message });
  } finally {
    client.release();
  }
});

app.get('/api/reservations/:id/audit', async (req, res) => {
  const reservationId = Number(req.params.id);
  try {
    const propertyId = assertPropertyId(req.query);
    await assertPropertyExists(pool, propertyId);
    await assertReservationBelongsToProperty(pool, reservationId, propertyId);

    const result = await pool.query(
      `SELECT * FROM audit_logs
       WHERE entity = 'RESERVATION' AND record_id = $1
       ORDER BY timestamp DESC, audit_id DESC
       LIMIT 20`,
      [String(reservationId)]
    );
    res.json({ status: 'OK', data: result.rows });
  } catch (err: any) {
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ status: 'ERROR', code: err.code, message: err.message });
    }
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.get('/api/rooms/:id/audit', async (req, res) => {
  const roomId = Number(req.params.id);
  try {
    const propertyId = parsePropertyId(req.query.property_id, 'property_id');
    await assertPropertyExists(pool, propertyId);
    await assertRoomBelongsToProperty(pool, roomId, propertyId);

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

  const incomingKeys = Object.keys(payload).filter((key) => payload[key] !== undefined);
  const criticalKeys = incomingKeys.filter((key) => RESERVATION_PATCH_CRITICAL_KEYS.has(key));
  if (criticalKeys.length > 0) {
    return res.status(409).json({
      status: 'ERROR',
      message: `reservation lifecycle fields must be changed through authoritative workflows: ${criticalKeys.join(', ')}`
    });
  }

  const unknownKeys = incomingKeys.filter((key) => !RESERVATION_PATCH_ALLOWLIST.has(key));
  if (unknownKeys.length > 0) {
    return res.status(400).json({
      status: 'ERROR',
      message: `unsupported reservation patch fields: ${unknownKeys.join(', ')}`
    });
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
    const guestName = Object.prototype.hasOwnProperty.call(payload, 'guest_name') ? payload.guest_name : existing.guest_name;
    const guestPhone = Object.prototype.hasOwnProperty.call(payload, 'guest_phone') ? payload.guest_phone : existing.guest_phone;
    const guestSegmentValue = Object.prototype.hasOwnProperty.call(payload, 'guest_segment') ? payload.guest_segment : existing.guest_segment;
    const guestSegment = ['Reguler', 'Group', 'Corporate'].includes(String(guestSegmentValue || 'Reguler'))
      ? String(guestSegmentValue || 'Reguler')
      : String(existing.guest_segment || 'Reguler');
    const baseSubtotal = Number(
      Object.prototype.hasOwnProperty.call(payload, 'subtotal_amount')
       ? payload.subtotal_amount
       : Object.prototype.hasOwnProperty.call(payload, 'total_price')
         ? payload.total_price
         : existing.total_price ?? existing.subtotal_amount ?? 0
    );
    const discountAmount = Number(
      Object.prototype.hasOwnProperty.call(payload, 'discount_amount') ? payload.discount_amount : existing.discount_amount ?? 0
    );
    const discountPercent = Number(
      Object.prototype.hasOwnProperty.call(payload, 'discount_percent') ? payload.discount_percent : existing.discount_percent ?? 0
    );
    const amountPaid = Number(
      Object.prototype.hasOwnProperty.call(payload, 'amount_paid') ? payload.amount_paid : existing.amount_paid ?? 0
    );
    const totalPrice = Number(
      Object.prototype.hasOwnProperty.call(payload, 'total_price') ? payload.total_price : baseSubtotal
    );
    const billingSummary = computeBillingSummary(totalPrice, discountAmount, discountPercent, amountPaid);
    const paymentStatus = Object.prototype.hasOwnProperty.call(payload, 'payment_status')
      ? payload.payment_status
      : billingSummary.paymentStatus;
    const ktpPath = Object.prototype.hasOwnProperty.call(payload, 'ktp_path') ? payload.ktp_path : existing.ktp_path;
    const buktiBayarPath = Object.prototype.hasOwnProperty.call(payload, 'bukti_bayar_path')
      ? payload.bukti_bayar_path
      : existing.bukti_bayar_path;
    const bookingTypeValue = Object.prototype.hasOwnProperty.call(payload, 'booking_type')
      ? payload.booking_type
      : existing.booking_type;
    const bookingSource = String(bookingTypeValue || 'walkin').toLowerCase() === 'ota' ? 'OTA' : 'WALKIN';

    const updated = await client.query(
      `UPDATE reservations
      SET guest_name = $1,
          guest_phone = $2,
          guest_segment = $3,
          total_price = $4,
          payment_status = $5,
          discount_amount = $6,
          discount_percent = $7,
          amount_paid = $8,
          remaining_balance = $9,
          ktp_path = $10,
          bukti_bayar_path = $11,
          booking_type = $12
      WHERE id = $13
      RETURNING *`,
      [
       guestName,
       guestPhone,
       guestSegment,
       billingSummary.totalAfterDiscount,
       paymentStatus,
       billingSummary.discount,
       billingSummary.discountPercent,
       billingSummary.amountPaid,
       billingSummary.remainingBalance,
       ktpPath,
       buktiBayarPath,
       bookingSource,
       reservationId
      ]
    );

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['PMS', 'UPDATE', 'RESERVATION', reservationId, JSON.stringify(withReservationHotelDates(updated.rows[0])), req.headers['x-correlation-id'] || null]
    );

    await client.query('COMMIT');
    broadcastEvent('ReservationUpdated', {
      reservation_id: reservationId,
      room_id: updated.rows[0].room_id,
      guest_name: guestName,
      timestamp: new Date().toISOString()
    });

    res.json({ status: 'SUCCESS', data: withReservationHotelDates(updated.rows[0]) });
  } catch (err: any) {
    await client.query('ROLLBACK');
    if (isRoomOverlapViolation(err)) {
      return sendRoomOverlapConflict(res);
    }
    const message = String(err?.message || err);
    if (
      message.includes('availability row missing') ||
      message.includes('capacity exhausted') ||
      message.includes('reserved_qty underflow') ||
      message.includes('room not found')
    ) {
      return res.status(409).json({ status: 'ERROR', message });
    }
    res.status(500).json({ status: 'ERROR', message });
  } finally {
    client.release();
  }
});

app.post('/api/reservations/:id/cancel', async (req, res) => {
  const reservationId = Number(req.params.id);
  if (!Number.isInteger(reservationId) || reservationId <= 0) {
    return res.status(400).json({ status: 'ERROR', message: 'invalid reservation id' });
  }
  const client = await pool.connect();

  try {
    const propertyId = assertPropertyId(req.body);
    await assertPropertyExists(pool, propertyId);
    await assertReservationBelongsToProperty(pool, reservationId, propertyId);

    await client.query('BEGIN');
    const reservationLookup = await client.query(
      'SELECT id, booking_id FROM reservations WHERE id = $1',
      [reservationId]
    );
    if (!hasRows(reservationLookup)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', message: 'reservation not found' });
    }

    const bookingId = Number(reservationLookup.rows[0].booking_id || 0);
    if (!Number.isInteger(bookingId) || bookingId <= 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ status: 'ERROR', message: 'reservation is not linked to a booking' });
    }

    const bookingResult = await client.query(
      'SELECT * FROM bookings WHERE id = $1 FOR UPDATE',
      [bookingId]
    );
    if (!hasRows(bookingResult)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', message: 'booking not found' });
    }

    const childrenResult = await client.query(
      `SELECT *
       FROM reservations
       WHERE booking_id = $1
       ORDER BY stay_sequence, id
       FOR UPDATE`,
      [bookingId]
    );
    const lockedChildren = childrenResult.rows;
    const targetIndex = lockedChildren.findIndex((row: any) => Number(row.id) === reservationId);
    if (targetIndex < 0) {
      throw new Error(`CANCELLATION_INTEGRITY_ERROR: reservation ${reservationId} does not belong to booking ${bookingId}`);
    }

    const booking = bookingResult.rows[0];
    const current = lockedChildren[targetIndex];
    const currentStatus = String(current.status || '').toUpperCase();
    if (currentStatus === 'CHECKED_IN') {
      await client.query('ROLLBACK');
      return res.status(409).json({ status: 'ERROR', message: 'checked-in reservation cannot be cancelled; use checkout flow' });
    }
    if (currentStatus === 'CHECKED_OUT') {
      await client.query('ROLLBACK');
      return res.status(409).json({ status: 'ERROR', message: 'checked-out reservation cannot be cancelled' });
    }
    if (currentStatus !== 'BOOKED' && currentStatus !== 'CANCELLED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ status: 'ERROR', message: `reservation status ${currentStatus || 'UNKNOWN'} is not cancellable in this phase` });
    }

    const alreadyCancelled = currentStatus === 'CANCELLED';
    let cancelledReservation = current;
    let inventoryPlan: Awaited<ReturnType<typeof planReservationCancellationInventory>> | null = null;
    if (!alreadyCancelled) {
      inventoryPlan = await planReservationCancellationInventory(client, current, booking, { lockRows: true });
      if (!inventoryPlan.eligible) {
        throw new Error(`INVENTORY_INTEGRITY_ERROR: ${inventoryPlan.reason}`);
      }
      await applyCancellationInventoryPlan(client, inventoryPlan);

      const updated = await client.query(
        `UPDATE reservations
         SET status = 'CANCELLED', stay_status = 'CANCELLED'
         WHERE id = $1 AND status = 'BOOKED'
         RETURNING *`,
        [reservationId]
      );
      if (updated.rowCount !== 1) {
        throw new Error(`CANCELLATION_INTEGRITY_ERROR: reservation ${reservationId} was not updated`);
      }
      cancelledReservation = updated.rows[0];
      lockedChildren[targetIndex] = cancelledReservation;

      await client.query(
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['PMS', 'CANCEL', 'RESERVATION', reservationId, JSON.stringify(withReservationHotelDates(cancelledReservation)), req.headers['x-correlation-id'] || null]
      );

      const legacyAudit = buildLegacyPreLedgerCancellationAudit(inventoryPlan, currentStatus, 'CANCELLED');
      if (legacyAudit) {
        await client.query(
          `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            'PMS',
            'LEGACY_PRE_LEDGER_CANCELLATION',
            'RESERVATION',
            reservationId,
            JSON.stringify(legacyAudit),
            req.headers['x-correlation-id'] || null
          ]
        );
      }
    }

    const bookingStatusBefore = String(booking.booking_status || '').toUpperCase();
    const childSummary = buildBookingChildStatusSummary(lockedChildren);
    const derivedBookingStatus = deriveBookingLifecycleStatus(bookingStatusBefore, childSummary);
    let bookingTransition: { status: string; booking: any; payload: any } | null = null;
    if (derivedBookingStatus !== bookingStatusBefore) {
      const updatedBooking = await client.query(
        `UPDATE bookings
         SET booking_status = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [derivedBookingStatus, bookingId]
      );
      if (updatedBooking.rowCount !== 1) {
        throw new Error(`CANCELLATION_INTEGRITY_ERROR: booking ${bookingId} was not reconciled`);
      }

      const bookingAuditPayload = derivedBookingStatus === 'COMPLETED'
        ? buildBookingCompletionAuditPayload(
            updatedBooking.rows[0],
            bookingStatusBefore || 'ACTIVE',
            derivedBookingStatus,
            childSummary,
            reservationId
          )
        : {
            booking_id: bookingId,
            bid: booking.bid,
            previous_status: bookingStatusBefore,
            new_status: derivedBookingStatus,
            child_status_summary: childSummary,
            trigger_reservation_id: reservationId
          };

      bookingTransition = {
        status: derivedBookingStatus,
        booking: updatedBooking.rows[0],
        payload: bookingAuditPayload
      };
      await client.query(
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          'PMS',
          derivedBookingStatus === 'CANCELLED' ? 'CANCEL' : 'COMPLETE',
          'BOOKING',
          bookingId,
          JSON.stringify(bookingAuditPayload),
          req.headers['x-correlation-id'] || null
        ]
      );
    }

    await client.query('COMMIT');
    if (!alreadyCancelled) {
      broadcastEvent('ReservationCancelled', {
        reservation_id: reservationId,
        room_id: current.room_id,
        guest_name: current.guest_name,
        timestamp: new Date().toISOString()
      });
    }
    if (bookingTransition?.status === 'COMPLETED') {
      broadcastEvent('BookingCompleted', {
        booking_id: bookingTransition.booking.id,
        bid: bookingTransition.booking.bid,
        trigger_reservation_id: reservationId,
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      status: 'SUCCESS',
      data: withReservationHotelDates(cancelledReservation),
      ...(alreadyCancelled ? { message: 'reservation already cancelled' } : {}),
      meta: {
        inventory_release_mode: inventoryPlan?.mode || 'NONE_ALREADY_CANCELLED',
        legacy_no_ledger_dates: inventoryPlan?.legacyNoLedgerDates || []
      }
    });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ status: 'ERROR', code: err.code, message: err.message });
    }
    const message = String(err?.message || err);
    if (
      message.includes('INVENTORY_INTEGRITY_ERROR') ||
      message.includes('CANCELLATION_INTEGRITY_ERROR')
    ) {
      return res.status(409).json({ status: 'ERROR', message });
    }
    res.status(500).json({ status: 'ERROR', message });
  } finally {
    client.release();
  }
});

app.post('/api/bookings', async (req, res) => {
  try {
    const payload = req.body || {};
    const reservations = payload.reservations;
    if (!Array.isArray(reservations) || reservations.length < 1) {
      const responseObj = { status: 'ERROR', message: 'reservations must be a non-empty array' };
      await persistIdempotencyResult(req, res, 400, responseObj);
      return res.status(400).json(responseObj);
    }

    const result = await createCanonicalBooking(req, payload, reservations, { requirePropertyId: true });
    const responseObj = {
      status: 'SUCCESS',
      data: {
        booking_id: result.booking.id,
        bid: result.booking.bid,
        booking_status: result.booking.booking_status,
        property_id: result.booking.property_id,
        guest_name: result.booking.guest_name_snapshot,
        guest_phone: result.booking.guest_phone_snapshot,
        booking_source: result.booking.booking_source,
        channel: result.booking.channel,
        currency_code: result.booking.currency_code,
        reservations: result.reservations
      },
      correlation_id: result.correlationId
    };

    try {
      broadcastEvent('BookingCreated', {
        booking_id: result.booking.id,
        bid: result.booking.bid,
        booking_status: result.booking.booking_status,
        reservation_count: result.reservations.length,
        correlation_id: result.correlationId,
        timestamp: new Date().toISOString()
      });
      for (const reservation of result.reservations) {
        broadcastEvent('ReservationCreated', {
          reservation_id: reservation.id,
          reservation_number: reservation.booking_number,
          bid: reservation.bid,
          booking_id: reservation.booking_id,
          status: reservation.status || 'TENTATIVE',
          guest: { name: reservation.guest_name, phone: reservation.guest_phone },
          room_id: reservation.room_id,
          check_in: reservation.check_in,
          check_out: reservation.check_out,
          correlation_id: result.correlationId,
          timestamp: new Date().toISOString()
        });
      }
    } catch (broadcastError) {
      console.error('Failed to broadcast booking create events', broadcastError);
    }

    await persistIdempotencyResult(req, res, 201, responseObj);
    return res.status(201).json(responseObj);
  } catch (err: any) {
    if (isRoomOverlapViolation(err)) {
      await persistIdempotencyResult(req, res, 409, ROOM_OVERLAP_RESPONSE);
      return sendRoomOverlapConflict(res);
    }

    const message = String(err?.message || err);
    const statusCode = Number(err?.statusCode || (message.includes('INVENTORY_INTEGRITY_ERROR') || message.includes('availability row missing') || message.includes('capacity exhausted') || message.includes('duplicate room usage') ? 409 : 500));
    const responseObj: any = { status: responseStatusTextForCode(statusCode), message };
    if (err?.code) responseObj.code = err.code;
    await persistIdempotencyResult(req, res, statusCode, responseObj);
    return res.status(statusCode).json(responseObj);
  }
});

// POST Reservation (integrated with availability lock)
app.post('/api/reservations', async (req, res) => {
  try {
    const result = await createReservationRecord(req, req.body || {});
    const responseObj = {
      status: result.status,
      data: result.data,
      lock_expires_at: result.lock_expires_at
    };
    try {
      broadcastEvent('ReservationCreated', {
        reservation_id: result.data.id,
        reservation_number: result.data.booking_number,
        bid: result.data.bid,
        booking_id: result.data.booking_id,
        status: result.data.status || 'TENTATIVE',
        guest: { name: result.data.guest_name, phone: result.data.guest_phone },
        room_id: result.data.room_id,
        check_in: result.data.check_in,
        check_out: result.data.check_out,
        correlation_id: result.canonical.correlationId,
        timestamp: new Date().toISOString()
      });
    } catch (broadcastError) {
      console.error('Failed to broadcast ReservationCreated', broadcastError);
    }

    await persistIdempotencyResult(req, res, 201, responseObj);
    return res.status(201).json(responseObj);
  } catch (err: any) {
    if (isRoomOverlapViolation(err)) {
      await persistIdempotencyResult(req, res, 409, ROOM_OVERLAP_RESPONSE);
      return sendRoomOverlapConflict(res);
    }

    const message = String(err?.message || err);
    const statusCode = Number(err?.statusCode || (message.includes('INVENTORY_INTEGRITY_ERROR') || message.includes('availability row missing') || message.includes('capacity exhausted') || message.includes('duplicate room usage') || message.includes('room not found') ? 409 : 500));
    const responseObj = { status: responseStatusTextForCode(statusCode), message };
    await persistIdempotencyResult(req, res, statusCode, responseObj);
    return res.status(statusCode).json(responseObj);
  }
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

  try {
    const result = await createReservationRecord(req, payload);
    const responseObj = {
      status: result.status,
      data: result.data,
      lock_expires_at: result.lock_expires_at
    };
    try {
      broadcastEvent('ReservationCreated', {
        reservation_id: result.data.id,
        reservation_number: result.data.booking_number,
        bid: result.data.bid,
        booking_id: result.data.booking_id,
        status: result.data.status || 'TENTATIVE',
        guest: { name: result.data.guest_name, phone: result.data.guest_phone },
        room_id: result.data.room_id,
        check_in: result.data.check_in,
        check_out: result.data.check_out,
        correlation_id: result.canonical.correlationId,
        timestamp: new Date().toISOString()
      });
    } catch (broadcastError) {
      console.error('Failed to broadcast ReservationCreated', broadcastError);
    }

    await persistIdempotencyResult(req, res, 201, responseObj);
    return res.status(201).json(responseObj);
  } catch (err: any) {
    if (isRoomOverlapViolation(err)) {
      await persistIdempotencyResult(req, res, 409, ROOM_OVERLAP_RESPONSE);
      return sendRoomOverlapConflict(res);
    }

    const message = String(err?.message || err);
    const statusCode = Number(err?.statusCode || (message.includes('INVENTORY_INTEGRITY_ERROR') || message.includes('availability row missing') || message.includes('capacity exhausted') || message.includes('duplicate room usage') || message.includes('room not found') ? 409 : 500));
    const responseObj = { status: statusCode >= 500 ? 'ERROR' : 'FAILED', message };
    await persistIdempotencyResult(req, res, statusCode, responseObj);
    return res.status(statusCode).json(responseObj);
  }
});

// GET availability by canonical room type, with explicit NULL-ID legacy mode.
app.get('/api/availability', async (req, res) => {
  const propertyIdRaw = req.query.property_id;
  if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
  }
  const propertyId = Number(propertyIdRaw);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
  }
  const propCheck = await pool.query('SELECT id FROM properties WHERE id = $1', [propertyId]);
  if ((propCheck.rowCount ?? 0) === 0) {
    return res.status(404).json({ status: 'ERROR', code: 'PROPERTY_NOT_FOUND', message: `property ${propertyId} not found` });
  }

  const roomTypeIdRaw = req.query.room_type_id;
  const roomTypeName = String(req.query.room_type || '').trim();
  const legacyCompatible = String(req.query.legacy_compatible || '').toLowerCase() === 'true';
  const defaultStart = hotelDateFromInstant(new Date());
  const start = normalizeHotelDate(req.query.start || defaultStart);
  const end = normalizeHotelDate(req.query.end || addHotelDays(defaultStart, 7));
  if (!start || !end || start >= end) {
    return res.status(400).json({ status: 'ERROR', message: 'invalid hotel date range' });
  }

  try {
    if (roomTypeIdRaw !== undefined && String(roomTypeIdRaw).trim() !== '') {
      const roomTypeId = Number(roomTypeIdRaw);
      if (!Number.isInteger(roomTypeId) || roomTypeId <= 0) {
        return res.status(400).json({ status: 'ERROR', message: 'invalid room_type_id' });
      }
      const typeRow = await pool.query('SELECT id, property_id FROM room_types WHERE id = $1', [roomTypeId]);
      if (typeRow.rowCount !== 1) {
        return res.status(409).json({ status: 'ERROR', code: 'ROOM_TYPE_NOT_FOUND', message: `room_type_id ${roomTypeId} not found` });
      }
      if (Number(typeRow.rows[0].property_id) !== propertyId) {
        return res.status(403).json({ status: 'ERROR', code: 'PROPERTY_MISMATCH', message: `room_type_id ${roomTypeId} does not belong to property ${propertyId}` });
      }
      const result = await pool.query(
        `SELECT ad.date, ad.total_rooms, ad.reserved_qty,
                (ad.total_rooms - ad.reserved_qty) AS sellable,
                ad.room_type_id, ad.room_type
         FROM availability_dates ad
         WHERE ad.room_type_id = $1
           AND ad.date >= $2::date AND ad.date < $3::date
         ORDER BY ad.date`,
        [roomTypeId, start, end]
      );
      const rows = result.rows.map((row: any) => ({ ...row, date: hotelDateKey(row.date) }));
      const returnedDates = new Set(rows.map((row: any) => row.date));
      const missingDates = enumerateHotelDates(start, end).filter(date => !returnedDates.has(date));
      if (missingDates.length > 0) {
        return res.status(409).json({
          status: 'ERROR',
          code: 'CANONICAL_AVAILABILITY_MISSING',
          message: `canonical availability is missing for room_type_id ${roomTypeId}`,
          missing_dates: missingDates,
          data: rows
        });
      }
      return res.json({ status: 'OK', identity_mode: 'CANONICAL', data: rows });
    }

    if (!legacyCompatible) {
      return res.status(400).json({
        status: 'ERROR',
        code: 'CANONICAL_ROOM_TYPE_REQUIRED',
        message: 'room_type_id is required unless legacy_compatible=true'
      });
    }
    if (!roomTypeName) {
      return res.status(400).json({ status: 'ERROR', message: 'room_type is required in legacy-compatible mode' });
    }
    const typeRow = await pool.query('SELECT id FROM room_types WHERE name = $1 AND property_id = $2', [roomTypeName, propertyId]);
    if (typeRow.rowCount === 0) {
      return res.status(403).json({ status: 'ERROR', code: 'PROPERTY_MISMATCH', message: `room_type "${roomTypeName}" does not belong to property ${propertyId}` });
    }
    const result = await pool.query(
      `SELECT ad.date, ad.total_rooms, ad.reserved_qty,
              (ad.total_rooms - ad.reserved_qty) AS sellable,
              ad.room_type_id, ad.room_type
       FROM availability_dates ad
       WHERE ad.room_type_id IS NULL AND ad.room_type = $1
         AND ad.date >= $2::date AND ad.date < $3::date
       ORDER BY ad.date`,
      [roomTypeName, start, end]
    );
    return res.json({
      status: 'OK',
      identity_mode: 'LEGACY_NULL_ID',
      data: result.rows.map((row: any) => ({ ...row, date: hotelDateKey(row.date) }))
    });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.get('/api/rooms', async (req, res) => {
  try {
    const propertyIdRaw = req.query.property_id;
    if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
    }
    const propertyId = Number(propertyIdRaw);
    if (!Number.isInteger(propertyId) || propertyId <= 0) {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
    }
    const propCheck = await pool.query('SELECT id FROM properties WHERE id = $1', [propertyId]);
    if ((propCheck.rowCount ?? 0) === 0) {
      return res.status(404).json({ status: 'ERROR', code: 'PROPERTY_NOT_FOUND', message: `property ${propertyId} not found` });
    }

    const conditions: string[] = [`r.property_id = $1`];
    const params: any[] = [propertyId];
    if (req.query.room_type_id !== undefined) {
      const typeId = Number(req.query.room_type_id);
      if (!Number.isInteger(typeId) || typeId <= 0) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid room_type_id filter' });
      }
      params.push(typeId);
      conditions.push(`r.room_type_id = $${params.length}`);
    }
    if (req.query.is_active !== undefined) {
      params.push(String(req.query.is_active).toLowerCase() === 'true');
      conditions.push(`COALESCE(r.is_active, TRUE) = $${params.length}`);
    }
    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    // RM-1D: additive operational detail for the Room Master UI (floor,
    // notes, canonical type label, active reservation load). Existing
    // columns and aliases are unchanged; legacy consumers keep working.
    const rooms = await pool.query(`
      SELECT r.id, r.room_number, COALESCE(rt.name, r.name, 'Standard Room') AS name,
             r.room_type_id, rt.code AS room_type_code,
             rt.name AS room_type_name,
             COALESCE(r.name, rt.name) AS legacy_name, r.status,
             COALESCE(r.is_active, TRUE) AS is_active,
             r.floor, r.notes,
             COALESCE(ar.active_reservations, 0) AS active_reservation_count
      FROM rooms r
      LEFT JOIN room_types rt ON rt.id = r.room_type_id
      LEFT JOIN (
        SELECT res.room_id, COUNT(*)::int AS active_reservations
        FROM reservations res
        WHERE res.status IN ('BOOKED', 'CHECKED_IN')
        GROUP BY res.room_id
      ) ar ON ar.room_id = r.id
      ${whereClause}
      ORDER BY r.room_number
    `, params);
    res.json({ status: 'OK', data: rooms.rows });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.get('/api/housekeeping/tasks', async (req, res) => {
  try {
    const propertyId = parsePropertyId(req.query.property_id, 'property_id');
    await assertPropertyExists(pool, propertyId);
    const tasks = await pool.query(
      'SELECT * FROM housekeeping_tasks WHERE property_id = $1 ORDER BY due_at ASC NULLS LAST, created_at DESC',
      [propertyId]
    );
    res.json({ status: 'OK', data: tasks.rows });
  } catch (err: any) {
    const sc = err.statusCode || 500;
    res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
  }
});

app.post('/api/housekeeping/tasks', async (req, res) => {
  const propertyId = parsePropertyId(req.body.property_id, 'property_id');
  const { room_number, task_type, priority, status, assignee, notes, due_at } = req.body;

  try {
    await assertPropertyExists(pool, propertyId);

    if (room_number) {
      const roomCheck = await pool.query(
        'SELECT id FROM rooms WHERE room_number = $1 AND property_id = $2',
        [room_number, propertyId]
      );
      if (!hasRows(roomCheck)) {
        return res.status(400).json({ status: 'ERROR', code: 'ROOM_NOT_IN_PROPERTY', message: `room_number "${room_number}" not found in property ${propertyId}` });
      }
    }

    const result = await pool.query(
      `INSERT INTO housekeeping_tasks (property_id, room_number, task_type, priority, status, assignee, notes, due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [propertyId, room_number || null, task_type || 'ROOM_SERVICE', priority || 'MEDIUM', status || 'PENDING', assignee || null, notes || null, due_at || null]
    );

    res.status(201).json({ status: 'SUCCESS', data: result.rows[0] });
  } catch (err: any) {
    const sc = err.statusCode || 500;
    res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
  }
});

app.patch('/api/housekeeping/tasks/:id/status', async (req, res) => {
  const taskId = Number(req.params.id);
  const propertyId = parsePropertyId(req.body.property_id, 'property_id');
  const nextTaskStatus = String(req.body?.status || 'PENDING').toUpperCase();
  const client = await pool.connect();

  try {
    await assertPropertyExists(pool, propertyId);
    await client.query('BEGIN');
    const existingTask = await client.query(
      'SELECT * FROM housekeeping_tasks WHERE id = $1 FOR UPDATE',
      [taskId]
    );
    if (!hasRows(existingTask)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', code: 'NOT_FOUND', message: 'task not found' });
    }
    if (existingTask.rows[0].property_id !== propertyId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ status: 'ERROR', code: 'PROPERTY_MISMATCH', message: 'task does not belong to this property' });
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
        'SELECT id FROM rooms WHERE room_number = $1 AND property_id = $2 FOR UPDATE',
        [roomNumber, propertyId]
      );
      if (!hasRows(roomResult)) {
        throw new Error(`Unable to resolve room for housekeeping task ${taskId} with room_number "${roomNumber}" in property ${propertyId}`);
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
    const sc = err.statusCode || 500;
    res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/maintenance/tasks', async (req, res) => {
  try {
    const propertyId = parsePropertyId(req.query.property_id, 'property_id');
    await assertPropertyExists(pool, propertyId);
    const tasks = await pool.query(
      'SELECT * FROM maintenance_tasks WHERE property_id = $1 ORDER BY due_at ASC NULLS LAST, created_at DESC',
      [propertyId]
    );
    res.json({ status: 'OK', data: tasks.rows });
  } catch (err: any) {
    const sc = err.statusCode || 500;
    res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
  }
});

app.post('/api/maintenance/tasks', async (req, res) => {
  const propertyId = parsePropertyId(req.body.property_id, 'property_id');
  const { room_number, issue_type, priority, status, assignee, notes, due_at } = req.body;

  try {
    await assertPropertyExists(pool, propertyId);

    if (room_number) {
      const roomCheck = await pool.query(
        'SELECT id FROM rooms WHERE room_number = $1 AND property_id = $2',
        [room_number, propertyId]
      );
      if (!hasRows(roomCheck)) {
        return res.status(400).json({ status: 'ERROR', code: 'ROOM_NOT_IN_PROPERTY', message: `room_number "${room_number}" not found in property ${propertyId}` });
      }
    }

    const result = await pool.query(
      `INSERT INTO maintenance_tasks (property_id, room_number, issue_type, priority, status, assignee, notes, due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [propertyId, room_number || null, issue_type || 'GENERAL', priority || 'MEDIUM', status || 'OPEN', assignee || null, notes || null, due_at || null]
    );

    res.status(201).json({ status: 'SUCCESS', data: result.rows[0] });
  } catch (err: any) {
    const sc = err.statusCode || 500;
    res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
  }
});

app.patch('/api/maintenance/tasks/:id/status', async (req, res) => {
  const taskId = Number(req.params.id);
  const propertyId = parsePropertyId(req.body.property_id, 'property_id');
  const { status } = req.body;

  try {
    await assertPropertyExists(pool, propertyId);

    const existing = await pool.query('SELECT * FROM maintenance_tasks WHERE id = $1', [taskId]);
    if (!hasRows(existing)) {
      return res.status(404).json({ status: 'ERROR', code: 'NOT_FOUND', message: 'task not found' });
    }
    if (existing.rows[0].property_id !== propertyId) {
      return res.status(403).json({ status: 'ERROR', code: 'PROPERTY_MISMATCH', message: 'task does not belong to this property' });
    }

    const result = await pool.query(
      'UPDATE maintenance_tasks SET status = $1 WHERE id = $2 RETURNING *',
      [status || 'OPEN', taskId]
    );

    res.json({ status: 'SUCCESS', data: result.rows[0] });
  } catch (err: any) {
    const sc = err.statusCode || 500;
    res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
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
    const propertyId = parsePropertyId(req.body.property_id, 'property_id');
    await assertPropertyExists(pool, propertyId);

    await client.query('BEGIN');
    await assertRoomBelongsToProperty(client, roomId, propertyId);
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

app.post('/api/reservations/:id/extend', async (req, res) => {
  const reservationId = Number(req.params.id);
  const requestedCheckOut = normalizeHotelDate(req.body?.new_check_out);

  if (!Number.isFinite(reservationId)) {
    return res.status(400).json({ status: 'ERROR', message: 'invalid reservation id' });
  }

  if (!requestedCheckOut) {
    return res.status(400).json({ status: 'ERROR', message: 'invalid new_check_out' });
  }

  const client = await pool.connect();

  try {
    const propertyId = assertPropertyId(req.body);
    await assertPropertyExists(pool, propertyId);
    await assertReservationBelongsToProperty(pool, reservationId, propertyId);

    await client.query('BEGIN');

    // C2C2: Initial plain read to discover room_id (NOT authoritative).
    const initialRead = await client.query('SELECT * FROM reservations WHERE id = $1', [reservationId]);
    if (!hasRows(initialRead)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', message: 'reservation not found' });
    }

    const initialState = initialRead.rows[0];
    const roomId = Number(initialState.room_id);
    const initialRoomTypeId = initialState.room_type_id != null ? Number(initialState.room_type_id) : null;
    const initialRoomTypeSnapshot = initialState.booked_room_type_id_snapshot != null ? Number(initialState.booked_room_type_id_snapshot) : initialRoomTypeId;

    // C2C2: Canonical lock order — ROOM FOR UPDATE first.
    await client.query('SELECT id FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);

    // C2C2: RESERVATION FOR UPDATE second, then revalidate.
    const reservationResult = await client.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [reservationId]);
    if (!hasRows(reservationResult)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', message: 'reservation not found' });
    }

    const reservation = reservationResult.rows[0];

    // C2C2: Revalidate that authoritative state has not changed since initial plain read.
    if (Number(reservation.room_id) !== roomId) {
      await client.query('ROLLBACK');
      return res.status(409).json({ status: 'ERROR', message: 'reservation room changed during extend; retry' });
    }
    if (reservation.room_type_id != null && initialRoomTypeId !== null && Number(reservation.room_type_id) !== initialRoomTypeId) {
      await client.query('ROLLBACK');
      return res.status(409).json({ status: 'ERROR', message: 'reservation room type changed during extend; retry' });
    }
    if (reservation.booked_room_type_id_snapshot != null && initialRoomTypeSnapshot !== null && Number(reservation.booked_room_type_id_snapshot) !== initialRoomTypeSnapshot) {
      await client.query('ROLLBACK');
      return res.status(409).json({ status: 'ERROR', message: 'reservation type snapshot changed during extend; retry' });
    }
    if (hotelDateKey(reservation.check_in) !== hotelDateKey(initialState.check_in) || hotelDateKey(reservation.check_out) !== hotelDateKey(initialState.check_out)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ status: 'ERROR', message: 'reservation dates changed during extend; retry' });
    }

    const currentStatus = String(reservation.status || '').toUpperCase();
    if (currentStatus !== 'BOOKED' && currentStatus !== 'CHECKED_IN') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        status: 'ERROR',
        message: `reservation status ${currentStatus || 'UNKNOWN'} cannot be extended`
      });
    }

    const oldCheckOut = hotelDateKey(reservation.check_out);
    const checkIn = hotelDateKey(reservation.check_in);
    if (!oldCheckOut || !checkIn) {
      await client.query('ROLLBACK');
      return res.status(409).json({ status: 'ERROR', message: 'reservation dates are invalid' });
    }

    if (requestedCheckOut === oldCheckOut) {
      await client.query('COMMIT');
      return res.json({
        status: 'SUCCESS',
        data: withReservationHotelDates(reservation),
        meta: {
          operation: 'EXTEND',
          no_op: true,
          reservation_id: reservationId,
          old_check_out: oldCheckOut,
          new_check_out: requestedCheckOut,
          delta_dates: [],
          inventory_delta: 0
        }
      });
    }

    if (requestedCheckOut <= checkIn) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        status: 'ERROR',
        message: 'new_check_out must be after check_in'
      });
    }

    if (requestedCheckOut < oldCheckOut) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        status: 'ERROR',
        message: 'use POST /api/reservations/:id/shorten for earlier check_out'
      });
    }

    const roomType = await resolveReservationRoomType(client, roomId);
    const deltaDates = enumerateHotelDates(oldCheckOut, requestedCheckOut);

    const overlap = await findActiveRoomOverlap(client, roomId, oldCheckOut, requestedCheckOut, reservationId);
    if (hasRows(overlap)) {
      await client.query('ROLLBACK');
      return sendRoomOverlapConflict(res);
    }

    const availabilityRows = await lockAndValidateAvailabilityDates(client, roomType, deltaDates, 'EXTEND');
    const roomTypeId = requireCanonicalRoomTypeId(roomType, 'reservation extend');

    for (const date of deltaDates) {
      await mutateCanonicalAvailabilityRow(
        client,
        availabilityRows.get(canonicalAvailabilityKey(roomTypeId, date))!,
        1
      );
    }

    const updatedReservation = await client.query(
      `UPDATE reservations
       SET check_out = $1
       WHERE id = $2
       RETURNING *`,
      [requestedCheckOut, reservationId]
    );

    const bookingId = Number(reservation.booking_id || 0);
    let bid: string | null = null;
    if (Number.isFinite(bookingId) && bookingId > 0) {
      const bookingResult = await client.query('SELECT bid FROM bookings WHERE id = $1', [bookingId]);
      if (hasRows(bookingResult)) {
        bid = String(bookingResult.rows[0].bid || null);
      }
    }

    const auditPayload = {
      operation: 'EXTEND',
      reservation_id: reservationId,
      booking_id: bookingId || null,
      bid,
      old_check_out: oldCheckOut,
      new_check_out: requestedCheckOut,
      delta_dates: deltaDates,
      inventory_delta: deltaDates.length,
      room_type: roomType.roomTypeName,
      room_type_id: roomType.roomTypeId
    };

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['PMS', 'EXTEND', 'RESERVATION', reservationId, JSON.stringify(auditPayload), req.headers['x-correlation-id'] || null]
    );

    await client.query('COMMIT');
    return res.json({
      status: 'SUCCESS',
      data: withReservationHotelDates(updatedReservation.rows[0]),
      meta: auditPayload
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ status: 'ERROR', code: err.code, message: err.message });
    }
    if (isRoomOverlapViolation(err)) {
      return sendRoomOverlapConflict(res);
    }
    const message = String(err?.message || err);
    if (
      message.includes('availability row missing') ||
      message.includes('INVENTORY_INTEGRITY_ERROR') ||
      message.includes('capacity exhausted') ||
      message.includes('reserved_qty underflow') ||
      message.includes('room not found')
    ) {
      return res.status(409).json({ status: 'ERROR', message });
    }
    res.status(500).json({ status: 'ERROR', message });
  } finally {
    client.release();
  }
});

app.post('/api/reservations/:id/shorten', async (req, res) => {
  const reservationId = Number(req.params.id);
  const requestedCheckOut = normalizeHotelDate(req.body?.new_check_out);

  if (!Number.isFinite(reservationId)) {
    return res.status(400).json({ status: 'ERROR', message: 'invalid reservation id' });
  }

  if (!requestedCheckOut) {
    return res.status(400).json({ status: 'ERROR', message: 'invalid new_check_out' });
  }

  const client = await pool.connect();

  try {
    const propertyId = assertPropertyId(req.body);
    await assertPropertyExists(pool, propertyId);
    await assertReservationBelongsToProperty(pool, reservationId, propertyId);

    await client.query('BEGIN');

    const reservationResult = await client.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [reservationId]);
    if (!hasRows(reservationResult)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', message: 'reservation not found' });
    }

    const reservation = reservationResult.rows[0];
    const currentStatus = String(reservation.status || '').toUpperCase();
    if (currentStatus !== 'BOOKED') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        status: 'ERROR',
        message: `reservation status ${currentStatus || 'UNKNOWN'} cannot be shortened`
      });
    }

    const oldCheckOut = hotelDateKey(reservation.check_out);
    const checkIn = hotelDateKey(reservation.check_in);
    if (!oldCheckOut || !checkIn) {
      await client.query('ROLLBACK');
      return res.status(409).json({ status: 'ERROR', message: 'reservation dates are invalid' });
    }

    if (requestedCheckOut === oldCheckOut) {
      await client.query('COMMIT');
      return res.json({
        status: 'SUCCESS',
        data: withReservationHotelDates(reservation),
        meta: {
          operation: 'SHORTEN',
          no_op: true,
          reservation_id: reservationId,
          old_check_out: oldCheckOut,
          new_check_out: requestedCheckOut,
          delta_dates: [],
          inventory_delta: 0
        }
      });
    }

    if (requestedCheckOut <= checkIn) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        status: 'ERROR',
        message: 'new_check_out must be after check_in'
      });
    }

    if (requestedCheckOut > oldCheckOut) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        status: 'ERROR',
        message: 'use POST /api/reservations/:id/extend for later check_out'
      });
    }

    const roomType = await resolveReservationRoomType(client, Number(reservation.room_id));
    const deltaDates = enumerateHotelDates(requestedCheckOut, oldCheckOut);

    const availabilityRows = await lockAndValidateAvailabilityDates(client, roomType, deltaDates, 'SHORTEN');
    const roomTypeId = requireCanonicalRoomTypeId(roomType, 'reservation shorten');

    for (const date of deltaDates) {
      await mutateCanonicalAvailabilityRow(
        client,
        availabilityRows.get(canonicalAvailabilityKey(roomTypeId, date))!,
        -1
      );
    }

    const updatedReservation = await client.query(
      `UPDATE reservations
       SET check_out = $1
       WHERE id = $2
       RETURNING *`,
      [requestedCheckOut, reservationId]
    );

    const bookingId = Number(reservation.booking_id || 0);
    let bid: string | null = null;
    if (Number.isFinite(bookingId) && bookingId > 0) {
      const bookingResult = await client.query('SELECT bid FROM bookings WHERE id = $1', [bookingId]);
      if (hasRows(bookingResult)) {
        bid = String(bookingResult.rows[0].bid || null);
      }
    }

    const auditPayload = {
      operation: 'SHORTEN',
      reservation_id: reservationId,
      booking_id: bookingId || null,
      bid,
      old_check_out: oldCheckOut,
      new_check_out: requestedCheckOut,
      delta_dates: deltaDates,
      inventory_delta: -deltaDates.length,
      room_type: roomType.roomTypeName,
      room_type_id: roomType.roomTypeId
    };

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['PMS', 'SHORTEN', 'RESERVATION', reservationId, JSON.stringify(auditPayload), req.headers['x-correlation-id'] || null]
    );

    await client.query('COMMIT');
    return res.json({
      status: 'SUCCESS',
      data: withReservationHotelDates(updatedReservation.rows[0]),
      meta: auditPayload
    });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ status: 'ERROR', code: err.code, message: err.message });
    }
    const message = String(err?.message || err);
    if (
      message.includes('availability row missing') ||
      message.includes('INVENTORY_INTEGRITY_ERROR') ||
      message.includes('capacity exhausted') ||
      message.includes('reserved_qty underflow') ||
      message.includes('room not found')
    ) {
      return res.status(409).json({ status: 'ERROR', message });
    }
    res.status(500).json({ status: 'ERROR', message });
  } finally {
    client.release();
  }
});

app.post('/api/reservations/:id/checkin', async (req, res) => {
  const reservationId = Number(req.params.id);
  const client = await pool.connect();

  try {
    const propertyId = assertPropertyId(req.body);
    await assertPropertyExists(pool, propertyId);
    await assertReservationBelongsToProperty(pool, reservationId, propertyId);

    await client.query('BEGIN');

    // C2C2: Initial plain read to discover room_id (NOT authoritative).
    const initialRead = await client.query('SELECT * FROM reservations WHERE id = $1', [reservationId]);
    if (!hasRows(initialRead)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', message: 'reservation not found' });
    }
    const initialState = initialRead.rows[0];
    const roomId = Number(initialState.room_id);

    // C2C2: Canonical lock order — ROOM FOR UPDATE first.
    await client.query('SELECT id FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);

    // C2C2: RESERVATION FOR UPDATE second, then revalidate.
    const reservation = await client.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [reservationId]);
    if (!hasRows(reservation)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', message: 'reservation not found' });
    }

    const current = reservation.rows[0];

    // C2C2: Revalidate that room_id has not changed since initial plain read.
    if (Number(current.room_id) !== roomId) {
      await client.query('ROLLBACK');
      return res.status(409).json({ status: 'ERROR', message: 'reservation room changed during checkin; retry' });
    }

    const currentStatus = String(current.status || '').toUpperCase();
    if (currentStatus === 'CANCELLED' || currentStatus === 'CHECKED_OUT') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        status: 'ERROR',
        message: `reservation status ${currentStatus} cannot be checked in`
      });
    }

    // C2C2: Overlap check after ROOM + RESERVATION locks.
    const overlap = await findActiveRoomOverlap(client, roomId, current.check_in, current.check_out, reservationId);
    if (hasRows(overlap)) {
      await client.query('ROLLBACK');
      return sendRoomOverlapConflict(res);
    }
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
      ['OCCUPIED_CLEAN', roomId]
    );

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['PMS', 'CHECK_IN', 'RESERVATION', reservationId, JSON.stringify(withReservationHotelDates(updated.rows[0])), req.headers['x-correlation-id'] || null]
    );

    await client.query('COMMIT');
    broadcastEvent('ReservationCheckedIn', {
      reservation_id: reservationId,
      room_id: roomId,
      guest_name: current.guest_name,
      checked_in_at: new Date().toISOString(),
      timestamp: new Date().toISOString()
    });

    res.json({ status: 'SUCCESS', data: withReservationHotelDates(updated.rows[0]) });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ status: 'ERROR', code: err.code, message: err.message });
    }
    if (isRoomOverlapViolation(err)) {
      return sendRoomOverlapConflict(res);
    }
    res.status(500).json({ status: 'ERROR', message: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/reservations/:id/checkout', async (req, res) => {
  const reservationId = Number(req.params.id);
  const client = await pool.connect();

  try {
    const propertyId = assertPropertyId(req.body);
    await assertPropertyExists(pool, propertyId);
    await assertReservationBelongsToProperty(pool, reservationId, propertyId);

    await client.query('BEGIN');
    const reservationLookup = await client.query('SELECT id, booking_id FROM reservations WHERE id = $1', [reservationId]);
    if (!hasRows(reservationLookup)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', message: 'reservation not found' });
    }

    const targetReservationId = Number(reservationLookup.rows[0].id);
    const bookingId = Number(reservationLookup.rows[0].booking_id || 0);
    if (!Number.isFinite(bookingId) || bookingId <= 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ status: 'ERROR', message: 'reservation is not linked to a booking' });
    }

    const bookingResult = await client.query(
      `SELECT *
       FROM bookings
       WHERE id = $1
       FOR UPDATE`,
      [bookingId]
    );
    if (!hasRows(bookingResult)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', message: 'booking not found' });
    }

    const booking = bookingResult.rows[0];
    const lockedChildrenResult = await client.query(
      `SELECT *
       FROM reservations
       WHERE booking_id = $1
       ORDER BY stay_sequence, id
       FOR UPDATE`,
      [bookingId]
    );
    if (!hasRows(lockedChildrenResult)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ status: 'ERROR', message: 'booking has no linked reservations' });
    }

    const lockedChildren = lockedChildrenResult.rows;
    const targetReservation = lockedChildren.find((row: any) => Number(row.id) === targetReservationId);
    if (!targetReservation) {
      await client.query('ROLLBACK');
      return res.status(409).json({ status: 'ERROR', message: 'target reservation does not belong to the booking' });
    }

    const targetStatus = String(targetReservation.status || '').toUpperCase();
    const bookingStatusBefore = String(booking.booking_status || '').toUpperCase();
    if (targetStatus === 'CANCELLED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ status: 'ERROR', message: 'cancelled reservation cannot be checked out' });
    }
    if (targetStatus !== 'BOOKED' && targetStatus !== 'CHECKED_IN' && targetStatus !== 'CHECKED_OUT') {
      await client.query('ROLLBACK');
      return res.status(409).json({ status: 'ERROR', message: `unsupported reservation status ${targetStatus || 'UNKNOWN'} for checkout` });
    }

    let checkoutReservation = targetReservation;
    if (targetStatus !== 'CHECKED_OUT') {
      const updated = await client.query(
        `UPDATE reservations
         SET status = 'CHECKED_OUT', stay_status = 'DEPARTED', checked_out_at = COALESCE(checked_out_at, NOW())
         WHERE id = $1
         RETURNING *`,
        [reservationId]
      );

      checkoutReservation = updated.rows[0];
      const currentRoomId = Number(checkoutReservation.room_id || targetReservation.room_id);

      // RM-1B drift fix: release type-night inventory consumed by this stay.
      // Root cause of Deluxe King 2026-08-23 drift: checkout previously left reserved_qty orphaned.
      const roomTypeResult = await client.query(
        `SELECT r.room_type_id, COALESCE(rt.name, r.name) AS room_type
         FROM rooms r
         LEFT JOIN room_types rt ON rt.id = r.room_type_id
         WHERE r.id = $1`,
        [currentRoomId]
      );
      if (!hasRows(roomTypeResult)) {
        throw new Error(`INVENTORY_INTEGRITY_ERROR: room not found for reservation ${reservationId}`);
      }
      const checkoutIdent = toRoomTypeIdentity(roomTypeResult.rows[0].room_type_id, roomTypeResult.rows[0].room_type);
      await releaseReservationStayInventory(client, checkoutIdent, checkoutReservation.check_in, checkoutReservation.check_out);

      await client.query(
        'UPDATE rooms SET status = $1 WHERE id = $2',
        ['VACANT_DIRTY', currentRoomId]
      );

      await client.query(
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['PMS', 'CHECK_OUT', 'RESERVATION', reservationId, JSON.stringify(withReservationHotelDates(checkoutReservation)), req.headers['x-correlation-id'] || null]
      );
      lockedChildren[lockedChildren.findIndex((row: any) => Number(row.id) === targetReservationId)] = checkoutReservation;
    }

    const childSummary = buildBookingChildStatusSummary(lockedChildren);
    const derivedBookingStatus = deriveBookingLifecycleStatus(bookingStatusBefore, childSummary);
    let bookingRecord = booking;
    let bookingCompletionAuditPayload: any = null;

    if (derivedBookingStatus !== bookingStatusBefore) {
      const updatedBooking = await client.query(
        `UPDATE bookings
         SET booking_status = $1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [derivedBookingStatus, booking.id]
      );
      bookingRecord = updatedBooking.rows[0];

      if (derivedBookingStatus === 'COMPLETED' && bookingStatusBefore !== 'COMPLETED') {
        bookingCompletionAuditPayload = buildBookingCompletionAuditPayload(
          bookingRecord,
          bookingStatusBefore || 'ACTIVE',
          derivedBookingStatus,
          childSummary,
          reservationId
        );
        await client.query(
          `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          ['PMS', 'COMPLETE', 'BOOKING', bookingRecord.id, JSON.stringify(bookingCompletionAuditPayload), req.headers['x-correlation-id'] || null]
        );
      }
    }

    await client.query('COMMIT');

    if (targetStatus !== 'CHECKED_OUT') {
      broadcastEvent('ReservationCheckedOut', {
        reservation_id: reservationId,
        room_id: checkoutReservation.room_id,
        guest_name: checkoutReservation.guest_name,
        checked_out_at: new Date().toISOString(),
        timestamp: new Date().toISOString()
      });
    }

    if (bookingCompletionAuditPayload) {
      broadcastEvent('BookingCompleted', {
        booking_id: bookingRecord.id,
        bid: bookingRecord.bid,
        trigger_reservation_id: reservationId,
        timestamp: new Date().toISOString()
      });
    }

    return res.json({ status: 'SUCCESS', data: withReservationHotelDates(checkoutReservation) });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ status: 'ERROR', code: err.code, message: err.message });
    }
    const message = String(err?.message || err);
    res.status(message.includes('INVENTORY_INTEGRITY_ERROR') ? 409 : 500).json({ status: 'ERROR', message });
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
    res.json({ status: 'SUCCESS', data: { payment: payment.rows[0], reservation: withReservationHotelDates(updated.rows[0]) } });
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
    const reservation = await pool.query(`
      SELECT 
        r.*,
        r.id as reservation_id,
        r.booking_number as legacy_booking_number,
        b.bid,
        b.id as booking_id_value
      FROM reservations r
      LEFT JOIN bookings b ON b.id = r.booking_id
      WHERE r.id = $1
    `, [reservationId]);
    if (!hasRows(reservation)) {
      return res.status(404).json({ status: 'ERROR', message: 'reservation not found' });
    }

    const payments = await pool.query('SELECT * FROM payment_transactions WHERE reservation_id = $1 ORDER BY created_at DESC', [reservationId]);
    const folio = await pool.query('SELECT * FROM folio_entries WHERE reservation_id = $1 ORDER BY created_at DESC', [reservationId]);

    res.json({
      status: 'OK',
      data: {
        reservation: withReservationHotelDates(reservation.rows[0]),
        payments: payments.rows,
        folio: folio.rows
      }
    });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

// POST canonical temporary availability hold.
app.post('/api/availability/lock', async (req, res) => {
  const { reservation_id, room_type, room_type_id, start, end, qty, ttl_minutes, legacy_compatible } = req.body;
  if (!start || !end || !qty) return res.status(400).json({ status: 'ERROR', message: 'missing parameters' });
  if (reservation_id !== null && reservation_id !== undefined && String(reservation_id).trim() !== '') {
    return res.status(400).json({ status: 'ERROR', message: 'reservation_id is not allowed for temporary hold endpoint' });
  }
  const holdQty = Number(qty);
  if (!Number.isInteger(holdQty) || holdQty <= 0) {
    return res.status(400).json({ status: 'ERROR', message: 'qty must be a positive integer' });
  }
  const normalizedStart = normalizeHotelDate(start);
  const normalizedEnd = normalizeHotelDate(end);
  if (!normalizedStart || !normalizedEnd || normalizedStart >= normalizedEnd) {
    return res.status(400).json({ status: 'ERROR', message: 'invalid hotel date range' });
  }

  let canonicalId: number;
  let canonicalName: string;
  if (room_type_id !== null && room_type_id !== undefined && String(room_type_id).trim() !== '') {
    canonicalId = Number(room_type_id);
    if (!Number.isInteger(canonicalId) || canonicalId <= 0) {
      return res.status(400).json({ status: 'ERROR', message: 'invalid room_type_id' });
    }
    const typeRow = await pool.query('SELECT name FROM room_types WHERE id = $1', [canonicalId]);
    if (!hasRows(typeRow)) {
      return res.status(409).json({ status: 'ERROR', message: `room_type_id ${canonicalId} not found` });
    }
    canonicalName = String(typeRow.rows[0].name);
  } else {
    if (legacy_compatible !== true) {
      return res.status(400).json({
        status: 'ERROR',
        code: 'CANONICAL_ROOM_TYPE_REQUIRED',
        message: 'room_type_id is required for temporary availability holds'
      });
    }
    canonicalName = String(room_type || '').trim();
    if (!canonicalName) {
      return res.status(400).json({ status: 'ERROR', message: 'room_type is required in legacy-compatible mode' });
    }
    const typeRows = await pool.query('SELECT id, name FROM room_types WHERE name = $1 ORDER BY id', [canonicalName]);
    if (typeRows.rowCount !== 1) {
      const code = typeRows.rowCount === 0 ? 'ROOM_TYPE_NAME_NOT_FOUND' : 'ROOM_TYPE_NAME_AMBIGUOUS';
      return res.status(409).json({
        status: 'ERROR',
        code,
        message: typeRows.rowCount === 0
          ? `room_type ${canonicalName} not found`
          : `room_type ${canonicalName} is ambiguous`
      });
    }
    canonicalId = Number(typeRows.rows[0].id);
    canonicalName = String(typeRows.rows[0].name);
  }

  const dates = enumerateHotelDates(normalizedStart, normalizedEnd);
  const client = await pool.connect();
  const now = new Date();
  const ttl = ttl_minutes === undefined || ttl_minutes === null || ttl_minutes === '' ? 30 : Number(ttl_minutes);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    client.release();
    return res.status(400).json({ status: 'ERROR', message: 'ttl_minutes must be greater than zero' });
  }
  const expiresAt = new Date(now.getTime() + ttl * 60 * 1000);

  try {
    await client.query('BEGIN');
    const availabilityRows = await lockCanonicalAvailabilityRows(
      client,
      dates.map(date => ({ roomTypeId: canonicalId, roomTypeName: canonicalName, date }))
    );
    for (const date of dates) {
      const row = availabilityRows.get(canonicalAvailabilityKey(canonicalId, date))!;
      const available = row.totalRooms - row.reservedQty;
      if (available < holdQty) {
        throw new Error(`INVENTORY_INTEGRITY_ERROR: capacity exhausted for ${canonicalName} on ${date} (available=${available}, requested=${holdQty})`);
      }
    }
    for (const date of dates) {
      await mutateCanonicalAvailabilityRow(
        client,
        availabilityRows.get(canonicalAvailabilityKey(canonicalId, date))!,
        holdQty
      );
      await client.query(
        'INSERT INTO availability_locks (reservation_id, room_type_id, room_type, date, qty_locked, lock_expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [null, canonicalId, canonicalName, date, holdQty, expiresAt.toISOString()]
      );
    }

    await client.query('COMMIT');
    res.json({ status: 'OK', message: 'locked', expires_at: expiresAt.toISOString(), room_type_id: canonicalId });
  } catch (err: any) {
    await client.query('ROLLBACK');
    const message = String(err?.message || err);
    res.status(message.includes('INVENTORY_INTEGRITY_ERROR') ? 409 : 500).json({ status: 'ERROR', message });
  } finally {
    client.release();
  }
});

// Property list endpoint (used by frontend to resolve current property context)
app.get('/api/properties', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, property_code, timezone, currency, is_active FROM properties ORDER BY id'
    );
    res.json({ status: 'OK', data: result.rows });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

// RM-1C Room Master domain routes (mounted after all legacy /api/rooms registrations)
app.use('/api/room-categories', createRoomCategoriesRouter(pool));
app.use('/api/room-types', createRoomTypesRouter(pool));
app.use('/api/rooms', createRoomsRouter(pool));


// GET tapechart: rooms × dates with reservations per cell
app.get('/api/tapechart', async (req, res) => {
  const propertyIdRaw = req.query.property_id;
  if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
  }
  const propertyId = Number(propertyIdRaw);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
  }
  const propCheck = await pool.query('SELECT id FROM properties WHERE id = $1', [propertyId]);
  if ((propCheck.rowCount ?? 0) === 0) {
    return res.status(404).json({ status: 'ERROR', code: 'PROPERTY_NOT_FOUND', message: `property ${propertyId} not found` });
  }

  const defaultStart = hotelDateFromInstant(new Date());
  const start = normalizeHotelDate(req.query.start || defaultStart);
  const end = normalizeHotelDate(req.query.end || addHotelDays(defaultStart, 7));
  if (!start || !end || start >= end) {
    return res.status(400).json({ status: 'ERROR', message: 'invalid hotel date range' });
  }
  // RM-2B.1: inactive Room Master entities are hidden from the operational
  // grid by default; explicit opt-in keeps them reachable for future filters.
  const includeInactive = ['1', 'true', 'yes'].includes(String(req.query.include_inactive || '').toLowerCase());

  try {
    // fetch rooms (RM-2B.1: canonical Room Master fields + future commitment aggregate)
    const includeClause = includeInactive ? '' : 'AND COALESCE(r.is_active, TRUE) AND COALESCE(rt.is_active, TRUE)';
    const roomsRes = await pool.query(`
      SELECT r.id, r.room_number,
             r.room_type_id, rt.code AS room_type_code,
             COALESCE(rt.name, r.name, 'Standard Room') AS name,
             rt.name AS canonical_room_type,
             rt.display_order AS room_type_display_order,
             rc.id AS room_category_id,
             rc.code AS room_category_code,
             rc.name AS room_category_name,
             rc.display_order AS room_category_display_order,
             rc.is_active AS room_category_is_active,
             COALESCE(r.is_active, TRUE) AS room_is_active,
             COALESCE(rt.is_active, TRUE) AS room_type_is_active,
             r.floor,
             r.status,
             r.status AS operational_status,
             f.future_count,
             f.next_check_in
      FROM rooms r
      LEFT JOIN room_types rt ON rt.id = r.room_type_id
      LEFT JOIN room_categories rc
        ON rc.id = rt.room_category_id AND rc.property_id = rt.property_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS future_count, MIN(r2.check_in) AS next_check_in
        FROM reservations r2
        WHERE r2.room_id = r.id
          AND r2.status = 'BOOKED'
          AND r2.check_in > (now() AT TIME ZONE 'Asia/Jakarta')::date
      ) f ON TRUE
      WHERE r.property_id = $1 ${includeClause}
      ORDER BY r.room_number
    `, [propertyId]);
    const rooms = roomsRes.rows;

    // fetch reservations overlapping range (only for property-owned rooms)
    const roomIds = rooms.map((r: any) => Number(r.id));
    const reservationsRes = roomIds.length > 0
      ? await pool.query(
          `SELECT r.*, r.id as reservation_id, r.booking_number as legacy_booking_number, b.bid, b.id as booking_id_value
           FROM reservations r
           LEFT JOIN bookings b ON b.id = r.booking_id
           WHERE r.room_id = ANY($1::int[])
             AND NOT (check_out <= $2::timestamp OR check_in >= $3::timestamp)`,
          [roomIds, start, end]
        )
      : { rows: [] as any[] };
    const reservations = reservationsRes.rows;

    // fetch availability for range (per room type & date) - scoped to property's room types
    const propertyTypeRes = await pool.query('SELECT id FROM room_types WHERE property_id = $1', [propertyId]);
    const propertyTypeIds = propertyTypeRes.rows.map((r: any) => Number(r.id));
    const availabilityRes = propertyTypeIds.length > 0
      ? await pool.query(
          `SELECT ad.room_type_id, ad.room_type, ad.date, ad.total_rooms, ad.reserved_qty, (ad.total_rooms - ad.reserved_qty) as sellable
           FROM availability_dates ad
           WHERE ad.room_type_id = ANY($1::int[])
             AND (ad.date AT TIME ZONE 'Asia/Jakarta')::date >= $2::date
             AND (ad.date AT TIME ZONE 'Asia/Jakarta')::date < $3::date`,
          [propertyTypeIds, start, end]
        )
      : { rows: [] as any[] };
    const availability = availabilityRes.rows;

    const dates = enumerateHotelDates(start, end);

    // Build map for quick lookup
    const reservationsByRoom: Record<string, any[]> = {};
    for (const r of reservations) {
      const rid = String(r.room_id);
      if (!reservationsByRoom[rid]) reservationsByRoom[rid] = [];
      reservationsByRoom[rid].push(r);
    }

    const availabilityMap: Record<string, any> = {};
    for (const a of availability) {
      const dateKey = hotelDateKey(a.date);
      // RM-1B: canonical id key preferred; legacy name key kept as fallback identity
      const idKey = a.room_type_id == null ? null : `id:${a.room_type_id}|${dateKey}`;
      const nameKey = `name:${a.room_type}|${dateKey}`;
      const normalizedAvailability = { ...a, date: dateKey };
      if (idKey) availabilityMap[idKey] = normalizedAvailability;
      if (!(nameKey in availabilityMap)) {
        availabilityMap[nameKey] = normalizedAvailability;
      }
    }

    const resultRooms = rooms.map((room: any) => {
      const cells = dates.map((d) => {
        const dateStr = d;
        // reservations for this room that cover this date
        const resForRoom = (reservationsByRoom[String(room.id)] || []).filter((r: any) => {
          const ci = hotelDateKey(r.check_in);
          const co = hotelDateKey(r.check_out);
          // Nightly stay is inclusive on check-in and exclusive on check-out.
          // Example: 2026-08-20 -> 2026-08-21 blocks only 20; 2026-08-20 -> 2026-08-28 blocks 20..27.
          return dateStr >= ci && dateStr < co;
        }).map((r: any) => ({
          id: r.id,
          reservation_id: r.reservation_id,
          booking_id: r.booking_id,
          bid: r.bid,
          stay_sequence: r.stay_sequence,
          guest_name: r.guest_name,
          guest_phone: r.guest_phone,
          guest_segment: r.guest_segment,
          booking_number: r.booking_number,
          legacy_booking_number: r.legacy_booking_number,
          booking_type: r.booking_type,
          payment_status: r.payment_status,
          check_in: hotelDateKey(r.check_in),
          check_out: hotelDateKey(r.check_out),
          booked_room_type_id_snapshot: r.booked_room_type_id_snapshot,
          booked_room_type_code_snapshot: r.booked_room_type_code_snapshot,
          booked_room_type_name_snapshot: r.booked_room_type_name_snapshot,
          booked_room_category_id_snapshot: r.booked_room_category_id_snapshot,
          booked_room_category_code_snapshot: r.booked_room_category_code_snapshot,
          booked_room_category_name_snapshot: r.booked_room_category_name_snapshot,
          classification_snapshot_source: r.classification_snapshot_source,
          classification_snapshotted_at: r.classification_snapshotted_at,
          // RM-2B.1: pass the raw lifecycle status through. Legacy rows with a
          // NULL status are surfaced as null + legacy_status flag instead of a
          // misleading 'CONFIRMED' label; the frontend owns compatibility mapping.
          status: r.status ?? null,
          legacy_status: r.status == null
        }));

        // Canonical rooms never fall through to a duplicate display name.
        // Name lookup is compatibility-only for rooms without room_type_id.
        const availIdKey = room.room_type_id == null ? null : `id:${room.room_type_id}|${dateStr}`;
        const availNameKey = `name:${room.name}|${dateStr}`;
        const avail = availIdKey
          ? availabilityMap[availIdKey] || null
          : availabilityMap[availNameKey] || null;
        return { date: dateStr, reservations: resForRoom, availability: avail };
      });
      return {
        id: room.id,
        room_id: room.id,
        room_number: room.room_number,
        name: room.name,
        room_type_id: room.room_type_id,
        room_type_code: room.room_type_code ?? null,
        room_type_name: room.canonical_room_type || room.name,
        room_type_display_order: Number(room.room_type_display_order ?? 0),
        room_category_id: room.room_category_id == null ? null : Number(room.room_category_id),
        room_category_code: room.room_category_code ?? null,
        room_category_name: room.room_category_name ?? null,
        room_category_display_order: Number(room.room_category_display_order ?? 0),
        room_category_is_active: room.room_category_is_active ?? null,
        room_is_active: room.room_is_active,
        room_type_is_active: room.room_type_is_active,
        floor: room.floor ?? null,
        status: room.status,
        operational_status: room.operational_status ?? room.status,
        future_reservation_count: Number(room.future_count || 0),
        next_future_check_in: room.next_check_in ? hotelDateKey(room.next_check_in) : null,
        cells
      };
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
    const propertyId = assertPropertyId(req.body);
    await assertPropertyExists(pool, propertyId);
    await assertReservationBelongsToProperty(pool, reservationId, propertyId);

    await client.query('BEGIN');

    // C2C2: Initial plain read to discover source room_id (NOT authoritative).
    const initialRead = await client.query('SELECT * FROM reservations WHERE id = $1', [reservationId]);
    if (!hasRows(initialRead)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', message: 'reservation not found' });
    }
    const initialState = initialRead.rows[0];
    const sourceRoomId = Number(initialState.room_id);
    const targetRoomId = Number(to_room_id);

    // C2C2: Lock ALL ROOM rows in deterministic room_id ASC order.
    const roomIds = Array.from(new Set([sourceRoomId, targetRoomId])).sort((a, b) => a - b);
    for (const rid of roomIds) {
      await client.query('SELECT id FROM rooms WHERE id = $1 FOR UPDATE', [rid]);
    }

    // C2C2: RESERVATION FOR UPDATE, then revalidate.
    const rRes = await client.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [reservationId]);
    if (!hasRows(rRes)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', message: 'reservation not found' });
    }
    const reservation = rRes.rows[0];

    // C2C2: Revalidate source room has not changed.
    if (Number(reservation.room_id) !== sourceRoomId) {
      await client.query('ROLLBACK');
      return res.status(409).json({ status: 'ERROR', message: 'reservation room changed during move; retry' });
    }

    const fromRoomRes = await client.query(`
      SELECT r.id, r.room_type_id, COALESCE(rt.name, r.name) AS room_type
      FROM rooms r
      LEFT JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.id = $1
    `, [sourceRoomId]);
    const toRoomRes = await client.query(`
      SELECT r.id, r.room_type_id, COALESCE(rt.name, r.name) AS room_type,
             r.is_active AS room_is_active,
             rt.is_active AS room_type_is_active
      FROM rooms r
      LEFT JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.id = $1
    `, [targetRoomId]);
    if (!hasRows(toRoomRes)) throw new Error('target room not found');
    const moveTargetRow = toRoomRes.rows[0];
    if (moveTargetRow.room_is_active === false || moveTargetRow.room_type_is_active === false) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        status: 'CONFLICT',
        code: 'ROOM_MASTER_INACTIVE',
        message: 'target room or its room type is inactive in Room Master; choose another room'
      });
    }
    const fromIdent: RoomTypeIdentity | null = hasRows(fromRoomRes)
      ? toRoomTypeIdentity(fromRoomRes.rows[0].room_type_id, fromRoomRes.rows[0].room_type)
      : null;
    const toIdent = toRoomTypeIdentity(toRoomRes.rows[0].room_type_id, toRoomRes.rows[0].room_type);
    if (!fromIdent) {
      throw new Error(`INVENTORY_INTEGRITY_ERROR: source room missing for reservation ${reservationId}`);
    }
    const fromRoomTypeId = requireCanonicalRoomTypeId(fromIdent, 'reservation move source');
    const toRoomTypeId = requireCanonicalRoomTypeId(toIdent, 'reservation move target');
    const currentStatus = String(reservation.status || '').toUpperCase();
    if (currentStatus === 'BOOKED' || currentStatus === 'CHECKED_IN') {
      const overlap = await findActiveRoomOverlap(client, targetRoomId, reservation.check_in, reservation.check_out, reservationId);
      if (hasRows(overlap)) {
        await client.query('ROLLBACK');
        return sendRoomOverlapConflict(res);
      }
    }

    // C2C2: Determine identity change and collect ALL availability identities.
    const dates = enumerateHotelDates(reservation.check_in, reservation.check_out);
    const identityChanged = fromRoomTypeId !== toRoomTypeId;

    if (identityChanged && toIdent.roomTypeName) {
      // C2C2: COLLECT all availability identities (source + target), then LOCK ALL deterministically.
      const availKeys: AvailabilityLockKey[] = [];
      for (const date of dates) {
        availKeys.push({ roomTypeId: toRoomTypeId, roomTypeName: toIdent.roomTypeName, date });
        availKeys.push({ roomTypeId: fromRoomTypeId, roomTypeName: fromIdent.roomTypeName, date });
      }
      const availMap = await lockAvailabilityRows(client, availKeys);

      // C2C2: VALIDATE ALL locked rows BEFORE any mutation.
      for (const date of dates) {
        const toKey = availabilityMapKey(toIdent, date);
        const toAvail = availMap.get(toKey);
        if (!toAvail) throw new Error(`No availability record for ${toIdent.roomTypeName} on ${date}`);
        const available = toAvail.totalRooms - toAvail.reservedQty;
        if (available < 1) throw new Error(`Not enough availability for ${toIdent.roomTypeName} on ${date}`);

        const srcKey = availabilityMapKey(fromIdent, date);
        const srcAvail = availMap.get(srcKey);
        if (!srcAvail) {
          throw new Error(`INVENTORY_INTEGRITY_ERROR: source availability row missing for ${fromIdent.roomTypeName} on ${date}`);
        }
        if (srcAvail.reservedQty < 1) {
          throw new Error(`INVENTORY_INTEGRITY_ERROR: source reserved_qty underflow for ${fromIdent.roomTypeName} on ${date} (reserved_qty=${srcAvail.reservedQty}, release=1)`);
        }
      }

      // C2C2: MUTATE ALL — decrement source, increment target, same date order.
      for (const date of dates) {
        await mutateCanonicalAvailabilityRow(client, availMap.get(availabilityMapKey(fromIdent, date))!, -1);
        await mutateCanonicalAvailabilityRow(client, availMap.get(availabilityMapKey(toIdent, date))!, 1);
      }
    }

    // update reservation room assignment
    await client.query('UPDATE reservations SET room_id = $1 WHERE id = $2', [targetRoomId, reservationId]);

    // Audit
    await client.query('INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id) VALUES ($1,$2,$3,$4,$5,$6)', [
      'PMS','MOVE','RESERVATION', reservationId, JSON.stringify({ from_room: sourceRoomId, to_room: targetRoomId }), req.headers['x-correlation-id'] || null
    ]);

    await client.query('COMMIT');
    // broadcast move event
    try {
      broadcastEvent('ReservationMoved', {
        reservation_id: reservationId,
        from_room: sourceRoomId,
        to_room: targetRoomId,
        check_in: hotelDateKey(reservation.check_in),
        check_out: hotelDateKey(reservation.check_out),
        timestamp: new Date().toISOString()
      });
    } catch (e) {
      console.error('Failed to broadcast ReservationMoved', e);
    }

    return res.json({ status: 'OK', message: 'moved', reservation_id: reservationId });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ status: 'ERROR', code: err.code, message: err.message });
    }
    if (isRoomOverlapViolation(err)) {
      return sendRoomOverlapConflict(res);
    }
    console.error('Move error', err);
    return res.status(400).json({ status: 'FAILED', message: err.message });
  } finally {
    client.release();
  }
});

// Release expired canonical temporary holds. NULL-ID holds remain classified
// and untouched for explicit historical handling.
export async function sweepExpiredLocks(now: Date = new Date()) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const expired = await client.query(
      `SELECT *
       FROM availability_locks
       WHERE lock_expires_at <= $1
       ORDER BY room_type_id ASC NULLS LAST, date ASC, id ASC
       FOR UPDATE`,
      [now.toISOString()]
    );
    const canonicalReleases = new Map<string, { roomTypeId: number; roomTypeName: string; date: string; quantity: number; lockIds: number[] }>();
    const reservationLocks: any[] = [];
    let legacyLocksSkipped = 0;

    for (const row of expired.rows) {
      const lockId = Number(row.id);
      const lockQty = Number(row.qty_locked || 0);
      if (!Number.isInteger(lockQty) || lockQty <= 0) {
        throw new Error(`INVENTORY_INTEGRITY_ERROR: invalid qty_locked on lock ${lockId} (qty_locked=${row.qty_locked})`);
      }

      if (row.reservation_id === null || row.reservation_id === undefined) {
        if (row.room_type_id === null || row.room_type_id === undefined) {
          legacyLocksSkipped += 1;
          continue;
        }
        const roomTypeId = Number(row.room_type_id);
        if (!Number.isInteger(roomTypeId) || roomTypeId <= 0) {
          throw new Error(`INVENTORY_INTEGRITY_ERROR: invalid room_type_id on lock ${lockId}`);
        }
        const date = hotelDateKey(row.date);
        const key = canonicalAvailabilityKey(roomTypeId, date);
        const current = canonicalReleases.get(key);
        if (current) {
          current.quantity += lockQty;
          current.lockIds.push(lockId);
        } else {
          canonicalReleases.set(key, {
            roomTypeId,
            roomTypeName: String(row.room_type || ''),
            date,
            quantity: lockQty,
            lockIds: [lockId]
          });
        }
        continue;
      }
      reservationLocks.push(row);
    }

    const releaseEntries = Array.from(canonicalReleases.values()).sort((a, b) =>
      a.roomTypeId - b.roomTypeId || a.date.localeCompare(b.date)
    );
    const availabilityRows = await lockCanonicalAvailabilityRows(client, releaseEntries);
    for (const release of releaseEntries) {
      const availability = availabilityRows.get(canonicalAvailabilityKey(release.roomTypeId, release.date))!;
      if (availability.reservedQty < release.quantity) {
        throw new Error(
          `INVENTORY_INTEGRITY_ERROR: sweeper underflow for room_type_id ${release.roomTypeId} on ${release.date} ` +
          `(reserved_qty=${availability.reservedQty}, release=${release.quantity})`
        );
      }
    }
    for (const release of releaseEntries) {
      await mutateCanonicalAvailabilityRow(
        client,
        availabilityRows.get(canonicalAvailabilityKey(release.roomTypeId, release.date))!,
        -release.quantity
      );
      for (const lockId of release.lockIds) {
        const deleted = await client.query('DELETE FROM availability_locks WHERE id = $1 RETURNING id', [lockId]);
        if (deleted.rowCount !== 1) {
          throw new Error(`INVENTORY_INTEGRITY_ERROR: exact expired hold deletion failed for lock ${lockId}`);
        }
      }
    }

    const reservationIds = Array.from(new Set(reservationLocks.map(row => Number(row.reservation_id)))).sort((a, b) => a - b);
    const reservations = reservationIds.length === 0
      ? { rows: [] }
      : await client.query(
          'SELECT id, status FROM reservations WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE',
          [reservationIds]
        );
    const reservationById = new Map<number, any>(
      reservations.rows.map((row: any): [number, any] => [Number(row.id), row])
    );
    let orphanReservationLocksDeleted = 0;
    for (const row of reservationLocks) {
      const reservationId = Number(row.reservation_id);
      if (!reservationById.has(reservationId)) orphanReservationLocksDeleted += 1;
      const deleted = await client.query('DELETE FROM availability_locks WHERE id = $1 RETURNING id', [Number(row.id)]);
      if (deleted.rowCount !== 1) {
        throw new Error(`INVENTORY_INTEGRITY_ERROR: exact reservation lock deletion failed for lock ${row.id}`);
      }
    }
    await client.query('COMMIT');
    return {
      releasedCanonicalLocks: releaseEntries.reduce((sum, release) => sum + release.lockIds.length, 0),
      releasedQuantity: releaseEntries.reduce((sum, release) => sum + release.quantity, 0),
      legacyLocksSkipped,
      reservationLocksDeleted: reservationLocks.length,
      orphanReservationLocksDeleted
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// run sweeper every minute
if (require.main === module) {
  setInterval(() => {
    sweepExpiredLocks().catch((e) => console.error(e));
  }, 60 * 1000);
}

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
if (require.main === module) {
  setInterval(() => {
    sweepExpiredIdempotency().catch((e) => console.error(e));
  }, 60 * 60 * 1000);
}
