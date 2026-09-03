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
import { createReportsRouter } from './domains/reports/reportsRouter';
import { createRoomOperationalBlocksRouter } from './domains/roomBlocks/roomOperationalBlocksRouter';
import { createGuestsRouter, createReservationGuestsRouter } from './domains/guests/guestsRouter';
import { createPropertiesRouter } from './domains/properties/propertiesRouter';
import { createPropertyBrandingRouter } from './domains/propertyBranding/propertyBrandingRouter';
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
import {
  PaymentEvidenceType,
  PaymentEvidenceMetadata,
  toEvidenceMetadata
} from './domains/payments/paymentEvidenceTypes';
import {
  createEvidenceReadStream,
  saveEvidenceFile,
  deleteEvidenceFile,
  validateEvidenceUpload
} from './domains/payments/evidenceStorageService';
import {
  uploadPaymentEvidence,
  getPaymentEvidences,
  getEvidenceRowById,
  deactivateEvidence,
  recordEvidenceAccessAudit
} from './domains/payments/paymentEvidenceService';
import {
  evaluateRoomReadiness,
  assertCheckInEligible,
  normalizePhysicalRoomStatus,
  isReadyPhysicalStatus
} from './domains/turnover/turnoverService';
import type {
  TurnoverState,
  ReadinessReasonCode,
  RoomReadinessInfo,
  CellTurnoverInfo
} from './domains/turnover/turnoverTypes';
import { createHousekeepingRouter } from './domains/housekeeping/housekeepingRouter';
import { ensureDirtyRoomCleaningTask, ensureCheckoutRoomCleaningTask, getPropertyHousekeepingSettings } from './domains/housekeeping/housekeepingService';
import { createAttendanceRouter } from './domains/attendance/attendanceRouter';
import { createHrdRouter } from './domains/hrd/hrdRouter';
import { createFeatureRouter } from './domains/features/featureRouter';
import { isFeatureEnabled } from './domains/features/featureService';
import { createPaymentCore } from './domains/payments/paymentDomainService';
import { createPricingRouter } from './domains/pricing/pricingRouter';
import { calculatePriceQuote, createReservationRateSnapshots } from './domains/pricing/pricingService';
import { createStayChargesRouter } from './domains/stayCharges/stayChargesRouter';
import { createTransactionsRouter } from './domains/transactions/transactionsRouter';
import { projectFolioEntryToTransaction, projectPosOrderToTransaction } from './domains/transactions/transactionService';
import { createOtaRouter } from './domains/ota/otaRouter';
import { createIdentityExtractionRouter } from './domains/identity/identityExtractionRouter';
import { createIdentityCustodyRouter } from './domains/identity/identityCustodyRouter';
import { getHeldIdentityCustodyForCheckout } from './domains/identity/identityCustodyService';
import { createDepositRouter } from './domains/deposits/depositRouter';
import { createFrontOfficeSettingsRouter } from './domains/frontOffice/frontOfficeSettingsRouter';
import { getQuickBookingRules } from './domains/frontOffice/frontOfficeSettingsService';
import { getReservationEditAvailability, previewReservationEdit, executeReservationEdit, executeReservationEditWithPayment } from './domains/reservations/reservationEditService';
import { createRoomMoveRouter } from './domains/reservations/roomMoveRouter';
import { releaseReservationInventoryForCheckout } from './domains/reservations/roomMoveService';
import { createSuppliersRouter } from './domains/suppliers/suppliersRouter';
import { createAuthRouter } from './domains/auth/authRouter';
import { requireAuth, requireRole } from './domains/auth/authMiddleware';
import { seedSuperAdmin } from './domains/auth/authService';
import { createUsersRouter } from './domains/users/usersRouter';
import { createRolePermissionsRouter } from './domains/settings/rolePermissionsRouter';

const app: any = express();
app.use(cors());
app.use(express.json());

const uploadDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

const frontendDist = process.env.FRONTEND_DIST_DIR
  ? path.resolve(process.env.FRONTEND_DIST_DIR)
  : fs.existsSync(path.resolve(__dirname, '../../frontend/dist'))
    ? path.resolve(__dirname, '../../frontend/dist')
    : path.resolve(__dirname, '../frontend/dist');

if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
}

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const handlePaymentUpload = (req: any, res: any, next: any) => {
  memoryUpload.single('file')(req, res, (err: any) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          status: 'ERROR',
          code: 'FILE_TOO_LARGE',
          message: 'Ukuran file melebihi batas maksimum 10 MB'
        });
      }
      return res.status(400).json({
        status: 'ERROR',
        code: 'UPLOAD_ERROR',
        message: err.message || 'Error saat memproses file unggahan'
      });
    }
    next();
  });
};

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
    `SELECT res.id, b.property_id AS booking_property_id, r.property_id AS room_property_id
     FROM reservations res
     LEFT JOIN bookings b ON b.id = res.booking_id
     LEFT JOIN rooms r ON r.id = res.room_id
     WHERE res.id = $1`,
    [reservationId]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw { statusCode: 404, code: 'NOT_FOUND', message: `reservation ${reservationId} not found` };
  }
  const row = result.rows[0];
  const effectivePropertyId = row.booking_property_id ?? row.room_property_id;
  if (effectivePropertyId != null && Number(effectivePropertyId) !== propertyId) {
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
    try {
      await pool.query('INSERT INTO idempotency_keys (key, request_hash, expires_at) VALUES ($1, $2, $3)', [idKey, reqHash, expiresAt.toISOString()]);
    } catch (insertErr: any) {
      if (insertErr.code === '23505') {
        const waitSeconds = Number(process.env.IDEMPOTENCY_WAIT_SECONDS || 10);
        const intervalMs = 500;
        const maxIter = Math.ceil((waitSeconds * 1000) / intervalMs);
        for (let i = 0; i < maxIter; i++) {
          await new Promise((r) => setTimeout(r, intervalMs));
          const check = await pool.query('SELECT response_body, status_code, expires_at, request_hash FROM idempotency_keys WHERE key = $1', [idKey]);
          if (hasRows(check)) {
            const cr = check.rows[0];
            if (cr.request_hash !== reqHash) {
              return res.status(409).json({ status: 'FAILED', message: 'Idempotency key conflict: different request payload' });
            }
            if (cr.response_body) {
              res.setHeader('X-Idempotency', 'HIT');
              return res.status(cr.status_code || 200).send(cr.response_body);
            }
          }
        }
        return res.status(202).json({ status: 'IN_PROGRESS' });
      }
      throw insertErr;
    }
    // Attach idempotency key to request for later saving
    (req as any)._idempotency_key = idKey;
    (req as any)._request_hash = reqHash;

    const originalSend = res.send.bind(res);
    res.send = (body: any) => {
      if (idKey) {
        const statusCode = res.statusCode || 200;
        const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
        let headersStr = '{}';
        try {
          headersStr = JSON.stringify(res.getHeaders ? res.getHeaders() : {});
        } catch (_e) {}
        pool.query(
          'UPDATE idempotency_keys SET response_body = $1, response_headers = $2, status_code = $3 WHERE key = $4',
          [bodyStr, headersStr, statusCode, idKey]
        ).catch((err: any) => console.error('Error persisting idempotency key', err));
      }
      return originalSend(body);
    };

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
  await seedSuperAdmin(pool);
  const sweepSummary = await sweepExpiredLocks();
  const reconciliation = await reconcileCanonicalAvailability(pool);
  console.log('Database connected, expired holds swept, and canonical availability reconciled.', {
    sweepSummary,
    reconciliation
  });
  const port = Number(process.env.PORT) || 5000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`Backend running on port ${port}`);
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
  return normalizedStatus !== 'OUT_OF_ORDER' && normalizedStatus !== 'OUT_OF_SERVICE';
}

function isRoomOverlapViolation(err: any): boolean {
  const code = String(err?.code || '');
  return code === ROOM_OVERLAP_SQLSTATE || code === 'ROOM_OVERLAP';
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
  'property_id',
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
  'identity_number',
  'has_valid_identity',
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
      const blockedCount = await getBlockedRoomsCountForTypeAndDate(client, roomTypeId, date);
      const sellableCapacity = totalRooms - blockedCount;
      if (reservedQty >= sellableCapacity) {
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
  excludeReservationId: number | null = null,
  options?: {
    stayType?: string;
    startAt?: string | Date | null;
    endAt?: string | Date | null;
    bufferMinutes?: number;
  }
) {
  const stayType = options?.stayType || 'OVERNIGHT';
  if (stayType === 'DAY_USE' && options?.startAt && options?.endAt) {
    const startTs = new Date(options.startAt).toISOString();
    const endTs = new Date(options.endAt).toISOString();
    const bufferMins = options.bufferMinutes || 60;
    return client.query(
      `SELECT existing.id, existing.booking_number, existing.check_in, existing.check_out, existing.status
       FROM reservations existing
       WHERE existing.room_id = $1
         AND existing.status IN ('BOOKED','CHECKED_IN')
         AND ($4::int IS NULL OR existing.id <> $4)
         AND (
           -- 1. Collision with another DAY_USE on same room with buffer
           (existing.stay_type = 'DAY_USE' AND existing.start_at < ($3::timestamptz + ($5 || ' minutes')::interval) AND (existing.end_at + ($5 || ' minutes')::interval) > $2::timestamptz)
           OR
           -- 2. Collision with OVERNIGHT stay on same room
           (existing.stay_type = 'OVERNIGHT' AND (
             (existing.check_in < $2::date AND existing.check_out > $2::date)
             OR (existing.check_in::date = $2::date AND $3::timestamptz > (existing.check_in::date + TIME '14:00:00' - ($5 || ' minutes')::interval))
             OR (existing.check_out::date = $2::date AND $2::timestamptz < (existing.check_out::date + TIME '12:00:00' + ($5 || ' minutes')::interval))
           ))
         )
       LIMIT 1
       FOR UPDATE OF existing`,
      [targetRoomId, startTs, endTs, excludeReservationId, bufferMins]
    );
  }

  return client.query(
    `SELECT existing.id, existing.booking_number, existing.check_in, existing.check_out, existing.status
     FROM reservations existing
     WHERE existing.room_id = $1
       AND existing.status IN ('BOOKED','CHECKED_IN')
       AND ($4::int IS NULL OR existing.id <> $4)
       AND (
         (existing.stay_type = 'OVERNIGHT' AND existing.check_in < $2::date AND existing.check_out > $3::date)
         OR
         (existing.stay_type = 'DAY_USE' AND existing.start_at::date >= $3::date AND existing.start_at::date < $2::date)
       )
     LIMIT 1
     FOR UPDATE OF existing`,
    [targetRoomId, requestedCheckOut, requestedCheckIn, excludeReservationId]
  );
}

async function findActiveOperationalBlockOverlap(
  client: any,
  targetRoomId: number,
  requestedCheckIn: string | Date,
  requestedCheckOut: string | Date,
  excludeBlockId: number | null = null
) {
  return client.query(
    `SELECT id, block_type, start_date, end_date
     FROM room_operational_blocks
     WHERE room_id = $1
       AND status IN ('ACTIVE', 'RELEASED')
       AND start_date < $2::date
       AND end_date > $3::date
       AND ($4::int IS NULL OR id <> $4)
     LIMIT 1
     FOR UPDATE`,
    [targetRoomId, requestedCheckOut, requestedCheckIn, excludeBlockId]
  );
}

async function getBlockedRoomsCountForTypeAndDate(
  client: any,
  roomTypeId: number,
  date: string
): Promise<number> {
  const res = await client.query(
    `SELECT COUNT(*)::int AS blocked_count
     FROM room_operational_blocks
     WHERE room_type_id = $1
       AND status IN ('ACTIVE', 'RELEASED')
       AND start_date <= $2::date
       AND end_date > $2::date`,
    [roomTypeId, date]
  );
  return Number(res.rows[0]?.blocked_count || 0);
}

const VALID_EXTENDED_BOOKING_SOURCES = [
  'WALKIN',
  'WALK_IN',
  'DIRECT',
  'WEBSITE',
  'BOOKING_COM',
  'AGODA',
  'TRAVELOKA',
  'TIKET_COM',
  'OTA',
  'OTHER'
];

function normalizeBookingSourceValue(value: any): string {
  if (!value) return 'WALKIN';
  const upper = String(value).trim().toUpperCase();
  if (upper === 'WALK_IN') return 'WALKIN';
  if (VALID_EXTENDED_BOOKING_SOURCES.includes(upper)) {
    return upper;
  }
  return upper.includes('OTA') ? 'OTA' : 'WALKIN';
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
    bookerName?: string | null;
    bookerPhone?: string | null;
    bookingChannel?: string | null;
    bookingSource: string;
    otaSourceId?: number | null;
    referral?: string | null;
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
          booker_name,
          booker_phone,
          booking_channel,
          booking_source,
          ota_source_id,
          referral,
          channel,
          booking_status,
          currency_code,
          legacy_booking_number,
          created_by,
          correlation_id,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW())
        RETURNING *;`,
        [
          bid,
          bookingPayload.propertyId,
          guestName,
          bookingPayload.guestPhone || null,
          bookingPayload.bookerName || guestName,
          bookingPayload.bookerPhone || bookingPayload.guestPhone || null,
          bookingPayload.bookingChannel || (['TIKET_COM', 'BOOKING_COM', 'AGODA', 'TRAVELOKA'].includes(bookingSource.toUpperCase()) ? 'OTA' : 'WALK_IN'),
          bookingSource,
          bookingPayload.otaSourceId || null,
          bookingPayload.referral || null,
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
          booker_name, booker_phone, ota_source_id, referral,
          booked_room_type_id_snapshot, booked_room_type_code_snapshot, booked_room_type_name_snapshot,
          booked_room_category_id_snapshot, booked_room_category_code_snapshot, booked_room_category_name_snapshot,
          classification_snapshot_source, classification_snapshotted_at,
          stay_type, start_at, end_at,
          rate_plan_id, subtotal_amount, tax_amount, service_amount,
          is_manual_override, manual_override_reason
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
          'BOOKED', 'RESERVED', $17, $18, $19,
          $20, $21, $22, $23,
          $24, $25, $26, $27, $28, $29, $30, CURRENT_TIMESTAMP,
          $31, $32, $33,
          $34, $35, $36, $37,
          $38, $39
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
          child.bookerName || null,
          child.bookerPhone || null,
          child.otaSourceId || null,
          child.referral || null,
          child.roomTypeIdSnapshot,
          child.roomTypeCodeSnapshot,
          child.roomTypeNameSnapshot,
          child.roomCategoryIdSnapshot,
          child.roomCategoryCodeSnapshot,
          child.roomCategoryNameSnapshot,
          child.classificationSnapshotSource,
          child.stayType || 'OVERNIGHT',
          child.startAt || null,
          child.endAt || null,
          child.ratePlanId || null,
          child.subtotalAmount || billingSummary.totalAfterDiscount,
          child.taxAmount || 0,
          child.serviceAmount || 0,
          Boolean(child.isManualOverride),
          child.manualOverrideReason || null
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
    booker_name?: any;
    booker_phone?: any;
    booker_same_as_guest?: any;
    booking_channel?: any;
    booking_source?: any;
    ota_source_id?: any;
    referral?: any;
    guest_id?: any;
    identity_number?: any;
    ktp_path?: any;
    has_valid_identity?: any;
    payment_method?: any;
    amount_paid?: any;
    bukti_bayar_path?: any;
    discount_reason?: any;
    stay_charges?: any[];
    require_strict_gates?: boolean;
    strict_gates?: boolean;
    same_as_booker?: any;
    initial_payment?: any;
    channel?: any;
    currency_code?: any;
    [key: string]: any;
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

  const guestName = String(bookingPayload.guest_name || rawReservationPayloads[0]?.guest_name || '').trim();
  const guestPhone = Object.prototype.hasOwnProperty.call(bookingPayload, 'guest_phone')
    ? String(bookingPayload.guest_phone || '').trim() || null
    : (rawReservationPayloads[0]?.guest_phone ? String(rawReservationPayloads[0]?.guest_phone).trim() : null);
  const guestSegment = normalizeGuestSegmentValue(bookingPayload.guest_segment || rawReservationPayloads[0]?.guest_segment);
  const bookingSource = normalizeBookingSourceValue(bookingPayload.booking_source);
  const bookingChannel = bookingPayload.booking_channel || (['TIKET_COM', 'BOOKING_COM', 'AGODA', 'TRAVELOKA'].includes(bookingSource.toUpperCase()) ? 'OTA' : 'WALK_IN');
  const bookerName = bookingPayload.booker_name ? String(bookingPayload.booker_name).trim() : guestName;
  const bookerPhone = bookingPayload.booker_phone ? String(bookingPayload.booker_phone).trim() : guestPhone;
  const otaSourceId = bookingPayload.ota_source_id ? Number(bookingPayload.ota_source_id) : null;
  const referral = bookingPayload.referral ? String(bookingPayload.referral).trim() : null;
  const channel = Object.prototype.hasOwnProperty.call(bookingPayload, 'channel')
    ? String(bookingPayload.channel || '').trim() || null
    : null;
  const currencyCode = normalizeCurrencyCodeValue(bookingPayload.currency_code);
  const correlationId = String((req.headers && req.headers['x-correlation-id']) || req.headers?.['X-Correlation-Id'] || `CORR-${Date.now()}`);

  const channelType: 'WALK_IN' | 'OTA' = (bookingChannel === 'OTA' || ['TIKET_COM', 'BOOKING_COM', 'AGODA', 'TRAVELOKA'].includes(String(bookingSource).toUpperCase()) || otaSourceId) ? 'OTA' : 'WALK_IN';

  let rulesMap: Record<string, string> = {};
  try {
    const rulesData = await getQuickBookingRules(pool, bookingPropertyId);
    rulesMap = rulesData.rules[channelType] || {};
  } catch (_err) {
    rulesMap = channelType === 'OTA'
      ? { booker_name: 'REQUIRED', guest_name: 'REQUIRED', rate_plan: 'REQUIRED' }
      : { booker_name: 'REQUIRED', booker_phone: 'REQUIRED', guest_name: 'REQUIRED', guest_phone: 'REQUIRED', identity: 'REQUIRED', payment_method: 'REQUIRED', payment_evidence: 'REQUIRED', rate_plan: 'REQUIRED' };
  }

  // Dynamic validation against configured rules for this property and channel
  const missingFields: string[] = [];

  if (rulesMap['guest_name'] === 'REQUIRED' && !guestName && !rawReservationPayloads.some((r: any) => r.guest_name)) {
    missingFields.push('guest_name');
  }
  if (rulesMap['guest_phone'] === 'REQUIRED' && !guestPhone && !rawReservationPayloads.some((r: any) => r.guest_phone)) {
    missingFields.push('guest_phone');
  }
  if (rulesMap['booker_name'] === 'REQUIRED' && !bookerName) {
    missingFields.push('booker_name');
  }
  if (rulesMap['booker_phone'] === 'REQUIRED' && !bookerPhone) {
    missingFields.push('booker_phone');
  }
  if (rulesMap['guest_segment'] === 'REQUIRED' && !guestSegment) {
    missingFields.push('guest_segment');
  }
  if (rulesMap['referral'] === 'REQUIRED' && !referral) {
    missingFields.push('referral');
  }
  if (rulesMap['identity'] === 'REQUIRED') {
    const hasIdentity = Boolean(
      bookingPayload.ktp_path ||
      bookingPayload.identity_number ||
      bookingPayload.has_valid_identity ||
      rawReservationPayloads.some((r: any) => r.ktp_path || r.identity_number || r.has_valid_identity)
    );
    if (!hasIdentity && !bookingPayload.guest_id) {
      missingFields.push('identity');
    }
  }
  if (rulesMap['payment_method'] === 'REQUIRED') {
    const paymentMethod = bookingPayload.payment_method || bookingPayload.initial_payment?.payment_method || rawReservationPayloads[0]?.payment_method;
    if (!paymentMethod) {
      missingFields.push('payment_method');
    }
  }
  if (rulesMap['payment_amount'] === 'REQUIRED') {
    const totalAmountPaid = rawReservationPayloads.reduce((sum: number, r: any) => sum + Number(r.amount_paid || 0), 0) || Number(bookingPayload.amount_paid || bookingPayload.initial_payment?.amount || 0);
    if (totalAmountPaid <= 0) {
      missingFields.push('payment_amount');
    }
  }
  if (rulesMap['payment_evidence'] === 'REQUIRED') {
    const paymentMethod = bookingPayload.payment_method || bookingPayload.initial_payment?.payment_method || rawReservationPayloads[0]?.payment_method;
    const totalAmountPaid = rawReservationPayloads.reduce((sum: number, r: any) => sum + Number(r.amount_paid || 0), 0) || Number(bookingPayload.amount_paid || bookingPayload.initial_payment?.amount || 0);
    const paymentEvidence = bookingPayload.bukti_bayar_path || bookingPayload.initial_payment?.payment_evidence_path || rawReservationPayloads[0]?.bukti_bayar_path;
    if (totalAmountPaid > 0 && String(paymentMethod).toUpperCase() !== 'CASH' && !paymentEvidence) {
      missingFields.push('payment_evidence');
    }
  }
  if (rulesMap['rate_plan'] === 'REQUIRED') {
    const missingRatePlan = rawReservationPayloads.some((r: any) => !r.rate_plan_id && !bookingPayload.rate_plan_id);
    if (missingRatePlan) {
      missingFields.push('rate_plan');
    }
  }

  // If missing fields exist according to configured rules
  if (missingFields.length > 0) {
    const err: any = new Error(`Data pemesanan belum lengkap untuk channel ${channelType}: ${missingFields.join(', ')}`);
    err.statusCode = 400;
    err.code = 'BOOKING_REQUIRED_FIELDS_MISSING';
    err.channel = channelType;
    err.missing = missingFields;
    err.missing_fields = missingFields;
    throw err;
  } else if (!guestName) {
    throw createHttpError(400, 'guest_name is required');
  }

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
      bookerName,
      bookerPhone,
      bookingChannel,
      bookingSource,
      otaSourceId,
      referral,
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

      const stayType = child.stay_type || child.stayType || 'OVERNIGHT';
      if (stayType === 'DAY_USE') {
        if (checkOut < checkIn) {
          throw createHttpError(400, `reservations[${index}].check_out must be on or after check_in for day use`);
        }
      } else {
        if (checkOut <= checkIn) {
          throw createHttpError(400, `reservations[${index}].check_out must be after check_in`);
        }
      }

      normalizedChildren.push({
        index,
        roomId,
        checkIn,
        checkOut,
        stayType,
        startAt: child.start_at || child.startAt || null,
        endAt: child.end_at || child.endAt || null,
        guestId: child.guest_id || child.guestId || bookingPayload.guest_id || null,
        guestName: String(child.guest_name || guestName).trim() || guestName,
        guestPhone: Object.prototype.hasOwnProperty.call(child, 'guest_phone')
          ? String(child.guest_phone || '').trim() || guestPhone
          : guestPhone,
        guestSegment: normalizeGuestSegmentValue(child.guest_segment || guestSegment),
        bookerName: child.booker_name || child.bookerName || bookerName,
        bookerPhone: child.booker_phone || child.bookerPhone || bookerPhone,
        otaSourceId: child.ota_source_id || child.otaSourceId || otaSourceId,
        referral: child.referral || referral,
        bookingType: normalizeBookingSourceValue(child.booking_type || child.bookingType || bookingSource),
        totalPrice: Number(child.total_price ?? child.subtotal_amount ?? 0),
        subtotalAmount: Number(child.subtotal_amount ?? child.subtotalAmount ?? child.total_price ?? 0),
        taxAmount: Number(child.tax_amount ?? child.taxAmount ?? 0),
        serviceAmount: Number(child.service_amount ?? child.serviceAmount ?? 0),
        isManualOverride: Boolean(child.is_manual_override || child.isManualOverride),
        manualOverrideReason: child.manual_override_reason ? String(child.manual_override_reason).trim() : null,
        discountAmount: Number(child.discount_amount ?? 0),
        discountPercent: Number(child.discount_percent ?? 0),
        discountReason: child.discount_reason || child.discountReason || bookingPayload.discount_reason || null,
        amountPaid: Number(child.amount_paid ?? (index === 0 ? (bookingPayload.amount_paid || bookingPayload.initial_payment?.amount || 0) : 0)),
        paymentMethod: child.payment_method || child.paymentMethod || (index === 0 ? (bookingPayload.payment_method || bookingPayload.initial_payment?.payment_method) : null) || 'CASH',
        paymentStatus: child.payment_status || null,
        stayCharges: child.stay_charges || child.stayCharges || (index === 0 ? bookingPayload.stay_charges : []) || [],
        quantity: (() => {
          const q = toPositiveInteger(child.qty ?? child.quantity ?? 1, 1);
          if (q > 1) {
            throw createHttpError(400,
              'Satu reservasi kamar hanya dapat menggunakan 1 kamar fisik. Gunakan Tambah Kamar untuk reservasi beberapa kamar.',
              'RESERVATION_QUANTITY_UNSUPPORTED');
          }
          return q;
        })(),
        ktpPath: child.ktp_path || bookingPayload.ktp_path || null,
        identityNumber: child.identity_number || bookingPayload.identity_number || null,
        hasValidIdentity: Boolean(child.has_valid_identity || child.hasValidIdentity || bookingPayload.has_valid_identity || child.ktp_path || bookingPayload.ktp_path || child.identity_number || bookingPayload.identity_number),
        buktiBayarPath: child.bukti_bayar_path || (index === 0 ? (bookingPayload.bukti_bayar_path || bookingPayload.initial_payment?.payment_evidence_path) : null) || null,
        roomType: null,
        roomTypeId: null,
        roomPropertyId: null,
        roomTypeIdSnapshot: null,
        roomTypeCodeSnapshot: null,
        roomTypeNameSnapshot: null,
        roomCategoryIdSnapshot: null,
        roomCategoryCodeSnapshot: null,
        roomCategoryNameSnapshot: null,
        classificationSnapshotSource: 'CANONICAL_ROOM_MASTER',
        ratePlanId: (child.rate_plan_id || child.ratePlanId) ? Number(child.rate_plan_id || child.ratePlanId) : null
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

      if (roomInfo.room_is_active === false || roomInfo.room_type_is_active === false) {
        throw createHttpError(409, `room ${child.roomId} or its room type is inactive in Room Master and cannot accept new bookings`);
      }

      if (!isRoomStatusSellable(roomInfo.room_status)) {
        throw createHttpError(409, `room ${child.roomId} is not sellable: status=${roomInfo.room_status}`);
      }

      child.roomType = String(roomInfo.room_type || '');
      if (!child.roomType) {
        throw createHttpError(409, `room type missing for room ${child.roomId}`);
      }
      const canonicalRoomTypeId = Number(roomInfo.canonical_room_type_id);
      if (!Number.isFinite(canonicalRoomTypeId) || canonicalRoomTypeId <= 0) {
        throw createHttpError(409, `room ${child.roomId} is missing canonical room_type_id link`);
      }
      child.roomTypeId = canonicalRoomTypeId;
      child.roomPropertyId = roomPropertyId;
      child.roomTypeIdSnapshot = canonicalRoomTypeId;
      child.roomTypeCodeSnapshot = String(roomInfo.room_type_code || '').trim() || null;
      child.roomTypeNameSnapshot = String(roomInfo.room_type || '').trim() || null;
      child.roomCategoryIdSnapshot = roomInfo.room_category_id ? Number(roomInfo.room_category_id) : null;
      child.roomCategoryCodeSnapshot = roomInfo.room_category_code ? String(roomInfo.room_category_code).trim() : null;
      child.roomCategoryNameSnapshot = roomInfo.room_category_name ? String(roomInfo.room_category_name).trim() : null;

      const windowList = roomWindows.get(child.roomId) || [];
      for (const existingWindow of windowList) {
        if (existingWindow.start < child.checkOut && existingWindow.end > child.checkIn) {
          duplicatePairs.push([existingWindow.index, child.index]);
        }
      }
      windowList.push({ start: child.checkIn, end: child.checkOut, index: child.index });
      roomWindows.set(child.roomId, windowList);

      const overlapResult = await findActiveRoomOverlap(
        client,
        child.roomId,
        child.checkIn,
        child.checkOut,
        null,
        {
          stayType: child.stayType,
          startAt: child.startAt,
          endAt: child.endAt,
          bufferMinutes: 60
        }
      );
      if (hasRows(overlapResult)) {
        const conflict = overlapResult.rows[0];
        const conflictDetails = overlapResult.rows.map((r: any) => ({
          reservation_id: r.id,
          booking_number: r.booking_number || r.id,
          check_in: r.check_in ? hotelDateKey(r.check_in) : child.checkIn,
          check_out: r.check_out ? hotelDateKey(r.check_out) : child.checkOut,
          status: r.status
        }));
        const err = createHttpError(
          409,
          `Kamar ${roomInfo.room_number || child.roomId} sudah terisi untuk tanggal ${child.checkIn} s/d ${child.checkOut} (Konflik dengan reservasi ${conflict.booking_number || conflict.id})`,
          'ROOM_OVERLAP'
        );
        (err as any).conflictDetails = conflictDetails;
        throw err;
      }

      const ident: RoomTypeIdentity = {
        roomTypeId: canonicalRoomTypeId,
        roomTypeName: child.roomType
      };

      const dates = child.stayType === 'DAY_USE' ? [] : enumerateHotelDates(child.checkIn, child.checkOut);
      for (const stayDate of dates) {
        const key = availabilityMapKey(ident, stayDate);
        const current = roomKeyMap.get(key);
        if (current) {
          current.delta += 1;
        } else {
          roomKeyMap.set(key, { ident, date: stayDate, delta: 1 });
        }
      }
    }

    if (duplicatePairs.length > 0) {
      throw createHttpError(409, `duplicate room assignment within same booking for room ${duplicatePairs[0][0] + 1} and ${duplicatePairs[0][1] + 1}`);
    }

    const lockKeys = Array.from(roomKeyMap.values()).sort((a, b) => {
      const typeComparison = requireCanonicalRoomTypeId(a.ident, 'booking lock sort') - requireCanonicalRoomTypeId(b.ident, 'booking lock sort');
      if (typeComparison !== 0) {
        return typeComparison;
      }
      return a.date.localeCompare(b.date);
    });

    const availabilityRows = await lockCanonicalAvailabilityRows(
      client,
      lockKeys.map(k => ({
        roomTypeId: requireCanonicalRoomTypeId(k.ident, `booking availability row for ${k.date}`),
        roomTypeName: k.ident.roomTypeName,
        date: k.date
      }))
    );

    for (const key of lockKeys) {
      const availability = availabilityRows.get(availabilityMapKey(key.ident, key.date));
      if (!availability) {
        throw createHttpError(409, `availability row missing for ${key.ident.roomTypeName} on ${key.date}`);
      }

      const blockedCount = await getBlockedRoomsCountForTypeAndDate(
        client,
        requireCanonicalRoomTypeId(key.ident, `booking availability on ${key.date}`),
        key.date
      );
      const sellableCapacity = availability.totalRooms - blockedCount;

      if (availability.reservedQty + key.delta > sellableCapacity) {
        throw createHttpError(
          409,
          `Not enough availability for ${key.ident.roomTypeName} on ${key.date} (available=${Math.max(0, sellableCapacity - availability.reservedQty)}, requested=${key.delta})`
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

      const bookingPropertyId = Number(bookingRecord.property_id || 1);

      const roomTotalPrice = Number(inserted.reservation.total_price || 0);
      if (roomTotalPrice > 0) {
        const rcRes = await client.query(
          `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, description, amount, base_amount, unit_price, quantity, direction)
           VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 1, 'DEBIT') RETURNING id`,
          [inserted.reservation.id, bookingPropertyId, 'ROOM_CHARGE', 'ROOM_CHARGE', 'Reservasi kamar', roomTotalPrice]
        );
        if ((rcRes.rowCount ?? 0) > 0) {
          try {
            await projectFolioEntryToTransaction(client, rcRes.rows[0].id, { propertyId: bookingPropertyId });
          } catch (e: any) {
            console.warn('[Transactions] Room charge projection warning:', e.message);
          }
        }
      }

      const stayChargesList = Array.isArray(child.stayCharges) ? child.stayCharges : [];
      const stayDurationNights = child.stayType === 'DAY_USE' ? 1 : Math.max(1, enumerateHotelDates(child.checkIn, child.checkOut).length);
      const roomSubtotal = Number(inserted.reservation.total_price || 0);

      for (const sc of stayChargesList) {
        const scType = sc.charge_type || sc.chargeType || 'EXTRA_BED';
        const scQuantity = Math.max(1, Number(sc.quantity || 1));
        let scDesc = sc.description || sc.name || `Biaya tambahan: ${scType}`;
        let ruleId: number | null = sc.rule_id ? Number(sc.rule_id) : null;
        let ruleCodeSnapshot: string | null = sc.rule_code_snapshot || sc.code || null;
        let ruleNameSnapshot: string | null = sc.rule_name_snapshot || sc.name || null;
        let calcMethodSnapshot: string | null = sc.calculation_method_snapshot || null;
        let isOverride = Boolean(sc.is_override);
        let originalRuleAmount: number | null = null;
        let overrideAmount: number | null = null;
        let overrideReason: string | null = sc.override_reason ? String(sc.override_reason).trim() : null;
        let baseUnitPrice = 0;

        // Resolve rule if rule_id or code provided
        let rule: any = null;
        if (ruleId) {
          const rRes = await client.query('SELECT * FROM stay_charge_rules WHERE id = $1', [ruleId]);
          if ((rRes.rowCount ?? 0) > 0) rule = rRes.rows[0];
        }

        if (rule) {
          ruleCodeSnapshot = rule.code;
          ruleNameSnapshot = rule.name;
          calcMethodSnapshot = rule.charge_method;
          if (!sc.description && !sc.name) scDesc = rule.name;

          let ruleAuthoritativeAmount = 0;
          if (rule.charge_method === 'FIXED_AMOUNT') {
            ruleAuthoritativeAmount = Number(rule.default_amount || 0);
          } else if (rule.charge_method === 'FREE') {
            ruleAuthoritativeAmount = 0;
          } else if (rule.charge_method === 'MANUAL') {
            ruleAuthoritativeAmount = Number(sc.unit_price || sc.amount || 0);
          } else if (rule.charge_method === 'FULL_NIGHT') {
            const applicableRate = (stayDurationNights > 0) ? (roomSubtotal / stayDurationNights) : roomSubtotal;
            ruleAuthoritativeAmount = applicableRate;
          } else if (rule.charge_method === 'PERCENTAGE_OF_NIGHTLY_RATE') {
            const applicableRate = (stayDurationNights > 0) ? (roomSubtotal / stayDurationNights) : roomSubtotal;
            ruleAuthoritativeAmount = Math.round((applicableRate * Number(rule.percentage_rate || 0)) / 100);
          }

          if (rule.charge_method !== 'MANUAL') {
            const requestedPrice = sc.override_amount !== undefined
              ? Number(sc.override_amount)
              : (sc.is_override && sc.unit_price !== undefined ? Number(sc.unit_price) : undefined);

            if (sc.is_override || (requestedPrice !== undefined && requestedPrice !== ruleAuthoritativeAmount)) {
              if (!overrideReason) {
                throw new Error('Alasan override harga wajib diisi');
              }
              isOverride = true;
              originalRuleAmount = ruleAuthoritativeAmount;
              overrideAmount = requestedPrice!;
              baseUnitPrice = requestedPrice!;
            } else {
              baseUnitPrice = ruleAuthoritativeAmount;
            }
          } else {
            baseUnitPrice = ruleAuthoritativeAmount;
          }
        } else {
          baseUnitPrice = Number(sc.unit_price || sc.amount || 0);
        }

        const scAmount = baseUnitPrice * scQuantity;
        if (scAmount >= 0) {
          const revCategory = scType === 'PENALTY' ? 'OTHER_INCOME' : 'ROOM_SALES';
          const folioScRes = await client.query(
            `INSERT INTO folio_entries (
              reservation_id, property_id, entry_type, source_type, source_id,
              rule_id, rule_code_snapshot, rule_name_snapshot, calculation_method_snapshot,
              description, amount, direction, base_amount, unit_price, quantity,
              tax_amount, service_amount, status, notes,
              is_override, original_rule_amount, override_amount, override_reason, override_by, override_at,
              revenue_category, actor_name_snapshot, actor_role_snapshot
            ) VALUES (
              $1, $2, $3, $4, $5,
              $6, $7, $8, $9,
              $10, $11, 'DEBIT', $12, $13, $14,
              0, 0, 'POSTED', $15,
              $16, $17, $18, $19, $20, $21,
              $22, $23, $24
            ) RETURNING id`,
            [
              inserted.reservation.id,
              bookingPropertyId,
              scType,
              scType,
              ruleId ? String(ruleId) : null,
              ruleId,
              ruleCodeSnapshot,
              ruleNameSnapshot,
              calcMethodSnapshot,
              scDesc,
              scAmount,
              scAmount,
              baseUnitPrice,
              scQuantity,
              sc.notes || sc.note || null,
              isOverride,
              originalRuleAmount,
              overrideAmount,
              overrideReason,
              isOverride ? 'Front Desk' : null,
              isOverride ? new Date() : null,
              revCategory,
              'Front Desk',
              'STAFF'
            ]
          );
          if ((folioScRes.rowCount ?? 0) > 0) {
            try {
              await projectFolioEntryToTransaction(client, folioScRes.rows[0].id, { propertyId: bookingPropertyId });
            } catch (e: any) {
              console.warn('[Transactions] Stay charge projection warning:', e.message);
            }
          }
        }
      }

      if (Number(child.discountAmount || 0) > 0) {
        const discountDesc = child.discountReason ? `Diskon: ${child.discountReason}` : 'Diskon Reservasi';
        await client.query(
          `INSERT INTO folio_entries (reservation_id, property_id, entry_type, description, amount, direction)
           VALUES ($1, $2, $3, $4, $5, 'CREDIT')`,
          [inserted.reservation.id, bookingPropertyId, 'DISCOUNT', discountDesc, Number(child.discountAmount || 0)]
        );
      }

      if (Number(child.amountPaid || 0) > 0) {
        const pMethod = child.paymentMethod || 'CASH';
        const pTxRes = await client.query(
          `INSERT INTO payment_transactions (
             reservation_id, transaction_type, amount, payment_method, status, created_by, created_at
           ) VALUES ($1, 'PAYMENT', $2, $3, 'SUCCESS', 'PMS', CURRENT_TIMESTAMP)
           RETURNING id`,
          [inserted.reservation.id, Number(child.amountPaid || 0), pMethod]
        );
        const pTxId = pTxRes.rows[0].id;

        if (child.buktiBayarPath) {
          await client.query(
            `INSERT INTO payment_evidences (
               property_id, reservation_id, payment_transaction_id, evidence_type, storage_key, original_filename,
               mime_type, file_size_bytes, note, is_active, uploaded_by_name_snapshot, created_at, updated_at
             ) VALUES ($1, $2, $3, 'RECEIPT', $4, $5, 'image/jpeg', 0, 'Bukti bayar saat reservasi', TRUE, 'Front Office', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
              bookingPropertyId,
              inserted.reservation.id,
              pTxId,
              child.buktiBayarPath,
              path.basename(child.buktiBayarPath)
            ]
          );
        }

        await client.query(
          `INSERT INTO folio_entries (reservation_id, property_id, entry_type, description, amount, direction)
           VALUES ($1, $2, $3, $4, $5, 'CREDIT')`,
          [inserted.reservation.id, bookingPropertyId, 'PAYMENT', `Pembayaran awal (${pMethod})`, Number(child.amountPaid || 0)]
        );
      }

      try {
        let stayingGuestId: number | null = child.guestId
          ? Number(child.guestId)
          : (child.guest_id
            ? Number(child.guest_id)
            : (req.body.guest_id
              ? Number(req.body.guest_id)
              : (req.body.guestId ? Number(req.body.guestId) : null)));

        const guestSegmentVal = child.guestSegment || req.body.guest_segment || 'Reguler';
        const bPlace = child.birthPlace || child.birth_place || req.body.birth_place || null;
        const bDate = child.birthDate || child.birth_date || req.body.birth_date || null;
        const gGender = (child.gender === 'MALE' || child.gender === 'FEMALE' || req.body.gender === 'MALE' || req.body.gender === 'FEMALE')
          ? (child.gender || req.body.gender) : null;
        const gAddress = child.address || req.body.address || null;
        const gRtRw = child.rtRw || child.rt_rw || req.body.rt_rw || null;
        const gKelurahan = child.villageKelurahan || child.village_kelurahan || req.body.village_kelurahan || null;
        const gKecamatan = child.districtKecamatan || child.district_kecamatan || req.body.district_kecamatan || null;
        const gReligion = child.religion || req.body.religion || null;
        const gMarital = child.maritalStatus || child.marital_status || req.body.marital_status || null;
        const gOccupation = child.occupation || req.body.occupation || null;
        const gCitizenship = child.citizenship || req.body.citizenship || null;
        const gValidUntil = child.validUntil || child.valid_until || req.body.valid_until || null;
        const gKtpConf = child.ktpConfidence || child.ktp_ocr_confidence || req.body.ktp_ocr_confidence || null;
        const gKtpProv = child.ktpOcrProvider || child.ktp_ocr_provider || req.body.ktp_ocr_provider || null;

        if (stayingGuestId) {
          // Check that the guest actually exists
          const existingCheck = await client.query('SELECT id, has_valid_identity, identity_number, identity_path FROM guests WHERE id = $1', [stayingGuestId]);
          if ((existingCheck.rowCount ?? 0) === 0) {
            stayingGuestId = null;
          } else {
            const cleanNik = (child.identityNumber || '').trim();
            const normNik = cleanNik ? cleanNik.replace(/[^0-9A-Za-z]/g, '').toUpperCase() : null;
            const hasValidId = Boolean(child.ktpPath || child.identityNumber || child.hasValidIdentity || existingCheck.rows[0].has_valid_identity);
            await client.query(
              `UPDATE guests
               SET identity_path = COALESCE($1::TEXT, identity_path),
                   identity_number = COALESCE(NULLIF($2, '')::VARCHAR, identity_number),
                   normalized_identity_number = COALESCE(NULLIF($3, '')::VARCHAR, normalized_identity_number),
                   has_valid_identity = $4::BOOLEAN,
                   birth_place = COALESCE(NULLIF($5, '')::VARCHAR, birth_place),
                   birth_date = COALESCE(NULLIF($6, '')::DATE, birth_date),
                   gender = COALESCE($7::VARCHAR, gender),
                   address = COALESCE(NULLIF($8, '')::TEXT, address),
                   rt_rw = COALESCE(NULLIF($9, '')::VARCHAR, rt_rw),
                   village_kelurahan = COALESCE(NULLIF($10, '')::VARCHAR, village_kelurahan),
                   district_kecamatan = COALESCE(NULLIF($11, '')::VARCHAR, district_kecamatan),
                   religion = COALESCE(NULLIF($12, '')::VARCHAR, religion),
                   marital_status = COALESCE(NULLIF($13, '')::VARCHAR, marital_status),
                   occupation = COALESCE(NULLIF($14, '')::VARCHAR, occupation),
                   citizenship = COALESCE(NULLIF($15, '')::VARCHAR, citizenship),
                   valid_until = COALESCE(NULLIF($16, '')::VARCHAR, valid_until),
                   ktp_ocr_confidence = COALESCE($17::NUMERIC, ktp_ocr_confidence),
                   ktp_ocr_provider = COALESCE(NULLIF($18, '')::VARCHAR, ktp_ocr_provider),
                   ktp_extracted_at = CASE WHEN $1::TEXT IS NOT NULL OR $2::VARCHAR IS NOT NULL THEN NOW() ELSE ktp_extracted_at END,
                   updated_at = NOW()
               WHERE id = $19::INT`,
              [
                child.ktpPath || null, cleanNik || null, normNik || null, hasValidId,
                bPlace, bDate, gGender, gAddress, gRtRw, gKelurahan, gKecamatan,
                gReligion, gMarital, gOccupation, gCitizenship, gValidUntil,
                gKtpConf, gKtpProv, stayingGuestId
              ]
            );
          }
        }

        if (!stayingGuestId && child.guestPhone) {
          const normPhone = child.guestPhone.replace(/\D/g, '');
          const existingGuestRes = await client.query(
            `SELECT id, has_valid_identity, identity_number, identity_path FROM guests WHERE phone = $1 OR normalized_phone = $2 LIMIT 1`,
            [child.guestPhone, normPhone || null]
          );
          if (existingGuestRes.rowCount && existingGuestRes.rowCount > 0) {
            stayingGuestId = existingGuestRes.rows[0].id;
            const cleanNik = (child.identityNumber || '').trim();
            const normNik = cleanNik ? cleanNik.replace(/[^0-9A-Za-z]/g, '').toUpperCase() : null;
            const hasValidId = Boolean(child.ktpPath || child.identityNumber || child.hasValidIdentity || existingGuestRes.rows[0].has_valid_identity);
            await client.query(
              `UPDATE guests
               SET identity_path = COALESCE($1::TEXT, identity_path),
                   identity_number = COALESCE(NULLIF($2, '')::VARCHAR, identity_number),
                   normalized_identity_number = COALESCE(NULLIF($3, '')::VARCHAR, normalized_identity_number),
                   has_valid_identity = $4::BOOLEAN,
                   birth_place = COALESCE(NULLIF($5, '')::VARCHAR, birth_place),
                   birth_date = COALESCE(NULLIF($6, '')::DATE, birth_date),
                   gender = COALESCE($7::VARCHAR, gender),
                   address = COALESCE(NULLIF($8, '')::TEXT, address),
                   rt_rw = COALESCE(NULLIF($9, '')::VARCHAR, rt_rw),
                   village_kelurahan = COALESCE(NULLIF($10, '')::VARCHAR, village_kelurahan),
                   district_kecamatan = COALESCE(NULLIF($11, '')::VARCHAR, district_kecamatan),
                   religion = COALESCE(NULLIF($12, '')::VARCHAR, religion),
                   marital_status = COALESCE(NULLIF($13, '')::VARCHAR, marital_status),
                   occupation = COALESCE(NULLIF($14, '')::VARCHAR, occupation),
                   citizenship = COALESCE(NULLIF($15, '')::VARCHAR, citizenship),
                   valid_until = COALESCE(NULLIF($16, '')::VARCHAR, valid_until),
                   ktp_ocr_confidence = COALESCE($17::NUMERIC, ktp_ocr_confidence),
                   ktp_ocr_provider = COALESCE(NULLIF($18, '')::VARCHAR, ktp_ocr_provider),
                   ktp_extracted_at = CASE WHEN $1::TEXT IS NOT NULL OR $2::VARCHAR IS NOT NULL THEN NOW() ELSE ktp_extracted_at END,
                   updated_at = NOW()
               WHERE id = $19::INT`,
              [
                child.ktpPath || null, cleanNik || null, normNik || null, hasValidId,
                bPlace, bDate, gGender, gAddress, gRtRw, gKelurahan, gKecamatan,
                gReligion, gMarital, gOccupation, gCitizenship, gValidUntil,
                gKtpConf, gKtpProv, stayingGuestId
              ]
            );
          }
        }

        if (!stayingGuestId) {
          const normPhone = child.guestPhone ? child.guestPhone.replace(/\D/g, '') : null;
          const cleanNik = child.identityNumber ? child.identityNumber.trim() : null;
          const normNik = cleanNik ? cleanNik.replace(/[^0-9A-Za-z]/g, '').toUpperCase() : null;
          const normName = (child.guestName || '').toLowerCase().trim();
          const hasValidId = Boolean(child.ktpPath || child.identityNumber || child.hasValidIdentity);
          const newGuestRes = await client.query(
            `INSERT INTO guests (
               full_name, normalized_name, phone, normalized_phone, identity_type, identity_number,
               normalized_identity_number, identity_path, has_valid_identity, guest_segment, created_property_id,
               birth_place, birth_date, gender, address, rt_rw, village_kelurahan, district_kecamatan,
               religion, marital_status, occupation, citizenship, valid_until, ktp_ocr_confidence, ktp_ocr_provider,
               ktp_extracted_at, created_at, updated_at
             ) VALUES (
               $1::VARCHAR, $2::VARCHAR, $3::VARCHAR, $4::VARCHAR, 'KTP', $5::VARCHAR,
               $6::VARCHAR, $7::TEXT, $8::BOOLEAN, $9::VARCHAR, $10::INT,
               $11::VARCHAR, NULLIF($12, '')::DATE, $13::VARCHAR, $14::TEXT, $15::VARCHAR, $16::VARCHAR, $17::VARCHAR,
               $18::VARCHAR, $19::VARCHAR, $20::VARCHAR, $21::VARCHAR, $22::VARCHAR, $23::NUMERIC, $24::VARCHAR,
               CASE WHEN $7::TEXT IS NOT NULL OR $5::VARCHAR IS NOT NULL THEN NOW() ELSE NULL END, NOW(), NOW()
             )
             RETURNING id`,
            [
              child.guestName,
              normName,
              child.guestPhone || null,
              normPhone,
              cleanNik,
              normNik,
              child.ktpPath || null,
              hasValidId,
              guestSegmentVal,
              bookingPropertyId,
              bPlace,
              bDate,
              gGender,
              gAddress,
              gRtRw,
              gKelurahan,
              gKecamatan,
              gReligion,
              gMarital,
              gOccupation,
              gCitizenship,
              gValidUntil,
              gKtpConf,
              gKtpProv
            ]
          );
          stayingGuestId = newGuestRes.rows[0].id;
          const guestCode = `GST-${String(stayingGuestId).padStart(5, '0')}`;
          await client.query(`UPDATE guests SET guest_code = $1 WHERE id = $2`, [guestCode, stayingGuestId]);
        }

        if (stayingGuestId) {
          await client.query(
            `INSERT INTO reservation_guests (
               reservation_id, guest_id, role, relationship, is_staying, identity_verified, relation_source
             ) VALUES ($1, $2, 'PRIMARY_GUEST', 'SELF', TRUE, $3, 'CANONICAL_BOOKING')
             ON CONFLICT (reservation_id) WHERE role = 'PRIMARY_GUEST' DO UPDATE
             SET guest_id = EXCLUDED.guest_id, identity_verified = EXCLUDED.identity_verified`,
            [
              inserted.reservation.id,
              stayingGuestId,
              Boolean(child.ktpPath || child.identityNumber || child.hasValidIdentity)
            ]
          ).catch((e: any) => console.warn('[createCanonicalBooking] Note: reservation_guests PRIMARY_GUEST fallback', e?.message));
        }

        const bName = child.bookerName || bookerName;
        const bPhone = child.bookerPhone || bookerPhone;
        if (bName && bName.trim().toLowerCase() !== child.guestName.trim().toLowerCase()) {
          let bookerGuestId: number | null = null;
          if (bPhone) {
            const normBPhone = bPhone.replace(/\D/g, '');
            const existingBookerRes = await client.query(
              `SELECT id FROM guests WHERE phone = $1 OR normalized_phone = $2 LIMIT 1`,
              [bPhone, normBPhone || null]
            );
            if (existingBookerRes.rowCount && existingBookerRes.rowCount > 0) {
              bookerGuestId = existingBookerRes.rows[0].id;
            }
          }
          if (!bookerGuestId) {
            const normBPhone = bPhone ? bPhone.replace(/\D/g, '') : null;
            const normBName = (bName || '').toLowerCase().trim();
            const newBookerRes = await client.query(
              `INSERT INTO guests (
                 full_name, normalized_name, phone, normalized_phone, created_property_id, created_at, updated_at
               ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
               RETURNING id`,
              [bName, normBName, bPhone || null, normBPhone, bookingPropertyId]
            );
            bookerGuestId = newBookerRes.rows[0].id;
            const guestCode = `GST-${String(bookerGuestId).padStart(5, '0')}`;
            await client.query(`UPDATE guests SET guest_code = $1 WHERE id = $2`, [guestCode, bookerGuestId]);
          }
          if (bookerGuestId) {
            await client.query(
              `INSERT INTO reservation_guests (
                 reservation_id, guest_id, role, relationship, is_staying, identity_verified, relation_source
               ) VALUES ($1, $2, 'BOOKER', 'BOOKER', FALSE, FALSE, 'CANONICAL_BOOKING')
               ON CONFLICT DO NOTHING`,
              [inserted.reservation.id, bookerGuestId]
            ).catch(() => {});
          }
        }
      } catch (crmErr) {
        console.warn('[createCanonicalBooking] Note: CRM guest auto-link fallback', crmErr);
      }

      try {
        const quote = await calculatePriceQuote(client, {
          property_id: bookingPropertyId,
          room_type_id: child.roomTypeId!,
          rate_plan_id: child.ratePlanId || undefined,
          check_in: child.checkIn,
          check_out: child.checkOut,
          stay_type: child.stayType
        });
        if ((child.isManualOverride || (!child.ratePlanId && child.totalPrice > 0)) && child.totalPrice > 0) {
          quote.room_subtotal = child.subtotalAmount || child.totalPrice;
          quote.tax_amount = child.taxAmount || 0;
          quote.service_amount = child.serviceAmount || 0;
          quote.grand_total = child.totalPrice;
          const nightlyShare = Math.round((child.subtotalAmount || child.totalPrice) / (quote.nightly_breakdown.length || 1));
          quote.nightly_breakdown.forEach((n, idx) => {
            n.final_room_rate = idx === quote.nightly_breakdown.length - 1
              ? (child.subtotalAmount || child.totalPrice) - nightlyShare * (quote.nightly_breakdown.length - 1)
              : nightlyShare;
            n.total_amount = n.final_room_rate;
          });
        }
        await createReservationRateSnapshots(client, inserted.reservation.id, bookingPropertyId, quote, {
          isManualOverride: child.isManualOverride,
          manualOverrideReason: child.manualOverrideReason
        });
      } catch (quoteErr) {
        console.warn('[createCanonicalBooking] Note: price quote snapshot fallback', quoteErr);
      }

      insertedChildren.push({
        ...inserted.reservation,
        bid: String(bookingRecord.bid),
        booking_id: Number(bookingRecord.id),
        stay_sequence: child.index + 1
      });
    }

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
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
        correlationId,
        bookingPropertyId
      ]
    );

    for (const reservation of insertedChildren) {
      await client.query(
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
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
          correlationId,
          bookingPropertyId
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
        booker_name: bookerName,
        booker_phone: bookerPhone,
        booking_channel: bookingChannel,
        booking_source: bookingSource,
        ota_source_id: otaSourceId,
        referral: referral,
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

// Canonical joined reservation DTO helper
async function getCanonicalReservationDto(clientOrPool: any, reservationId: number) {
  const result = await clientOrPool.query(`
    SELECT
      r.*,
      r.id AS reservation_id,
      r.booking_number AS legacy_booking_number,
      b.bid,
      b.id AS booking_id_value,
      b.property_id AS booking_property_id,
      COALESCE(r.booker_name, b.booker_name) AS booker_name,
      COALESCE(r.booker_phone, b.booker_phone) AS booker_phone,
      ota.name AS ota_source_name,
      ro.room_number,
      ro.floor,
      COALESCE(r.booked_room_type_id_snapshot, ro.room_type_id) AS room_type_id,
      COALESCE(r.booked_room_type_name_snapshot, rt.name, ro.name, 'Standard Room') AS room_type,
      COALESCE(r.booked_room_type_name_snapshot, rt.name, ro.name, 'Standard Room') AS room_type_name,
      COALESCE(r.booked_room_type_code_snapshot, rt.code) AS room_type_code
    FROM reservations r
    LEFT JOIN bookings b ON b.id = r.booking_id
    LEFT JOIN ota_sources ota ON ota.id = r.ota_source_id
    LEFT JOIN rooms ro ON ro.id = r.room_id
    LEFT JOIN room_types rt ON rt.id = COALESCE(r.booked_room_type_id_snapshot, ro.room_type_id)
    WHERE r.id = $1
  `, [reservationId]);

  if (!hasRows(result)) return null;
  return withReservationHotelDates(result.rows[0]);
}

// Authoritative property-scoped reservation listing
app.get('/api/reservations', async (req, res) => {
  try {
    const propertyId = assertPropertyId(req.query);
    await assertPropertyExists(pool, propertyId);

    const conditions: string[] = ['b.property_id = $1'];
    const params: any[] = [propertyId];
    let paramIndex = 2;

    // Date range filter: stay-overlap [check_in, check_out)
    const startDateRaw = req.query.start_date || req.query.start;
    const endDateRaw = req.query.end_date || req.query.end;
    const dateRaw = req.query.date;

    if (startDateRaw && endDateRaw) {
      const startDate = normalizeHotelDate(startDateRaw);
      const endDate = normalizeHotelDate(endDateRaw);
      if (!startDate || !endDate || startDate >= endDate) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'invalid hotel date range: start_date must be before end_date'
        });
      }
      // Stay overlap query: r.check_in < end_date AND r.check_out > start_date
      conditions.push(`r.check_in::date < $${paramIndex}::date AND r.check_out::date > $${paramIndex + 1}::date`);
      params.push(endDate, startDate);
      paramIndex += 2;
    } else if (startDateRaw) {
      const startDate = normalizeHotelDate(startDateRaw);
      if (!startDate) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid start_date format' });
      }
      conditions.push(`r.check_out::date > $${paramIndex}::date`);
      params.push(startDate);
      paramIndex++;
    } else if (endDateRaw) {
      const endDate = normalizeHotelDate(endDateRaw);
      if (!endDate) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid end_date format' });
      }
      conditions.push(`r.check_in::date < $${paramIndex}::date`);
      params.push(endDate);
      paramIndex++;
    } else if (dateRaw) {
      const date = normalizeHotelDate(dateRaw);
      if (!date) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid date format' });
      }
      // Single date occupied: r.check_in <= date AND r.check_out > date
      conditions.push(`r.check_in::date <= $${paramIndex}::date AND r.check_out::date > $${paramIndex}::date`);
      params.push(date);
      paramIndex++;
    }

    // Status filter
    if (req.query.status) {
      const statusParam = String(req.query.status).trim().toUpperCase();
      conditions.push(`UPPER(r.status) = $${paramIndex}`);
      params.push(statusParam);
      paramIndex++;
    }

    // Search filter
    if (req.query.search) {
      const searchPattern = `%${String(req.query.search).trim()}%`;
      conditions.push(`(
        r.guest_name ILIKE $${paramIndex} OR
        r.guest_phone ILIKE $${paramIndex} OR
        b.bid ILIKE $${paramIndex} OR
        ro.room_number ILIKE $${paramIndex} OR
        r.id::text ILIKE $${paramIndex}
      )`);
      params.push(searchPattern);
      paramIndex++;
    }

    const whereClause = conditions.join(' AND ');

    const result = await pool.query(`
      SELECT
        r.id AS reservation_id,
        r.id,
        r.booking_id,
        b.bid,
        r.guest_name,
        r.guest_phone,
        r.guest_segment,
        COALESCE(r.booker_name, b.booker_name) AS booker_name,
        COALESCE(r.booker_phone, b.booker_phone) AS booker_phone,
        r.ota_source_id,
        ota.name AS ota_source_name,
        r.referral,
        r.ktp_path,
        r.bukti_bayar_path,
        r.discount_amount,
        r.discount_percent,
        r.discount_reason,
        r.is_manual_override,
        r.manual_override_reason,
        r.room_id,
        ro.room_number,
        ro.floor,
        COALESCE(r.booked_room_type_id_snapshot, ro.room_type_id) AS room_type_id,
        COALESCE(r.booked_room_type_name_snapshot, rt.name, ro.name, 'Standard Room') AS room_type,
        COALESCE(r.booked_room_type_name_snapshot, rt.name, ro.name, 'Standard Room') AS room_type_name,
        COALESCE(r.booked_room_type_code_snapshot, rt.code) AS room_type_code,
        r.check_in,
        r.check_out,
        r.status,
        r.status AS reservation_status,
        COALESCE(b.booking_source, 'WALKIN') AS booking_source,
        COALESCE(b.channel, 'FRONT_DESK') AS channel,
        r.total_price,
        r.amount_paid,
        r.remaining_balance,
        r.payment_status,
        r.stay_sequence,
        r.created_at
      FROM reservations r
      JOIN bookings b ON b.id = r.booking_id
      LEFT JOIN rooms ro ON ro.id = r.room_id
      LEFT JOIN room_types rt ON rt.id = COALESCE(r.booked_room_type_id_snapshot, ro.room_type_id)
      LEFT JOIN ota_sources ota ON ota.id = r.ota_source_id
      WHERE ${whereClause}
      ORDER BY r.check_in DESC, r.id DESC
    `, params);

    const formattedRows = result.rows.map((row: any) => ({
      ...row,
      check_in: hotelDateKey(row.check_in),
      check_out: hotelDateKey(row.check_out),
      total_price: Number(row.total_price || 0),
      amount_paid: Number(row.amount_paid || 0),
      applied_deposit: Number(row.applied_deposit || 0),
      remaining_balance: Number(row.remaining_balance || 0),
    }));

    return res.json({
      status: 'SUCCESS',
      data: formattedRows
    });
  } catch (err: any) {
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ status: 'ERROR', code: err.code, message: err.message });
    }
    console.error('Error in GET /api/reservations:', err);
    return res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

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
        b.id as booking_id_value,
        COALESCE(r.booker_name, b.booker_name) AS booker_name,
        COALESCE(r.booker_phone, b.booker_phone) AS booker_phone,
        ota.name as ota_source_name,
        ro.room_number,
        ro.floor,
        COALESCE(r.booked_room_type_id_snapshot, ro.room_type_id) AS room_type_id,
        COALESCE(r.booked_room_type_name_snapshot, rt.name, ro.name, 'Standard Room') AS room_type,
        COALESCE(r.booked_room_type_name_snapshot, rt.name, ro.name, 'Standard Room') AS room_type_name,
        COALESCE(r.booked_room_type_code_snapshot, rt.code) AS room_type_code
      FROM reservations r
      LEFT JOIN bookings b ON b.id = r.booking_id
      LEFT JOIN ota_sources ota ON ota.id = r.ota_source_id
      LEFT JOIN rooms ro ON ro.id = r.room_id
      LEFT JOIN room_types rt ON rt.id = COALESCE(r.booked_room_type_id_snapshot, ro.room_type_id)
      WHERE r.id = $1
    `, [reservationId]);
    if (!hasRows(result)) {
      return res.status(404).json({ status: 'ERROR', message: 'reservation not found' });
    }
    const row = result.rows[0];
    const data = withReservationHotelDates(row);

    let rate_snapshot: any = null;
    try {
      const nightlyRes = await pool.query(
        `SELECT * FROM reservation_nightly_rates WHERE reservation_id = $1 ORDER BY stay_date ASC`,
        [reservationId]
      );
      if (nightlyRes.rows.length > 0) {
        rate_snapshot = {
          reservation_id: reservationId,
          nightly_rates: nightlyRes.rows
        };
      }
    } catch (_snapErr) {}
    let readiness: RoomReadinessInfo | null = null;
    if (row.room_id) {
      readiness = await evaluateRoomReadiness(pool, Number(row.room_id), reservationId);
    }

    let checkout_inspection: any = null;
    const chkRes = await pool.query(
      `SELECT id, status, inspection_result, issue_type, issue_note, estimated_charge, created_at, completed_at
       FROM housekeeping_tasks
       WHERE reservation_id = $1 AND task_type = 'CHECKOUT_ROOM_CHECK'
       ORDER BY id DESC LIMIT 1`,
      [reservationId]
    );
    if (hasRows(chkRes)) {
      const task = chkRes.rows[0];
      let clearanceState = 'REQUESTED';
      if (task.status === 'IN_PROGRESS') clearanceState = 'INSPECTING';
      else if (task.status === 'DONE') {
        clearanceState = task.inspection_result === 'ISSUE_FOUND' ? 'ISSUE_FOUND' : 'CLEAR';
      }
      checkout_inspection = {
        task_id: task.id,
        status: task.status,
        clearance_state: clearanceState,
        inspection_result: task.inspection_result,
        issue_type: task.issue_type,
        issue_note: task.issue_note,
        estimated_charge: task.estimated_charge !== null && task.estimated_charge !== undefined ? Number(task.estimated_charge) : null,
        created_at: task.created_at,
        completed_at: task.completed_at
      };
    }

    let requireCheckoutInspection = false;
    try {
      const isHkEnabled = await isFeatureEnabled(pool, propertyId, 'housekeeping.enabled');
      const isCheckoutCheckFeature = isHkEnabled && (await isFeatureEnabled(pool, propertyId, 'housekeeping.checkout_inspection'));
      if (isCheckoutCheckFeature) {
        const hkSettings = await getPropertyHousekeepingSettings(pool, propertyId);
        requireCheckoutInspection = Boolean(hkSettings.require_checkout_room_check);
      }
    } catch (_e) {}

    let sibling_reservations: any[] = [];
    if (row.booking_id) {
      try {
        const sibRes = await pool.query(
          `SELECT r.id, r.booking_id, r.room_id, rm.room_number,
                  r.check_in, r.check_out, r.status, r.stay_status, r.total_price,
                  COALESCE(rt.name, rm.name, r.booked_room_type_name_snapshot) as room_type_name
           FROM reservations r
           LEFT JOIN rooms rm ON rm.id = r.room_id
           LEFT JOIN room_types rt ON rt.id = COALESCE(rm.room_type_id, r.booked_room_type_id_snapshot)
           WHERE r.booking_id = $1
           ORDER BY r.stay_sequence ASC, r.id ASC`,
          [row.booking_id]
        );
        sibling_reservations = sibRes.rows.map(withReservationHotelDates);
      } catch (sibErr) {
        console.warn('[GET /api/reservations/:id] Sibling query error:', sibErr);
      }
    }

    res.json({
      status: 'OK',
      data: {
        ...data,
        readiness,
        checkout_inspection,
        require_checkout_inspection: requireCheckoutInspection,
        sibling_reservations,
        rate_snapshot
      }
    });
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
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['PMS', 'CANCEL', 'RESERVATION', reservation.id, JSON.stringify(updatedReservation.rows[0]), correlationId, booking.property_id]
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
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['PMS', 'CANCEL', 'BOOKING', booking.id, JSON.stringify(updatedBooking), correlationId, booking.property_id]
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
       WHERE property_id = $2 AND record_id = $1 AND (entity = 'RESERVATION' OR module = 'PAYMENT')
       ORDER BY timestamp DESC, audit_id DESC
       LIMIT 30`,
      [String(reservationId), propertyId]
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
       WHERE entity = 'ROOM' AND record_id = $1 AND property_id = $2
       ORDER BY timestamp DESC, audit_id DESC
       LIMIT 20`,
      [String(roomId), propertyId]
    );
    res.json({ status: 'OK', data: result.rows });
  } catch (err: any) {
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ status: 'ERROR', code: err.code, message: err.message });
    }
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
    const bookingRes = await client.query('SELECT property_id FROM bookings WHERE id = $1', [existing.booking_id]);
    const reservationPropertyId = bookingRes.rows[0]?.property_id ?? null;

    const callerPropIdRaw = req.body?.property_id ?? req.query?.property_id;
    if (callerPropIdRaw !== undefined && callerPropIdRaw !== null && String(callerPropIdRaw).trim() !== '') {
      const callerPropertyId = Number(callerPropIdRaw);
      if (reservationPropertyId != null && callerPropertyId !== Number(reservationPropertyId)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ status: 'ERROR', code: 'PROPERTY_MISMATCH', message: `reservation does not belong to property ${callerPropertyId}` });
      }
    }
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
    const identityNumber = Object.prototype.hasOwnProperty.call(payload, 'identity_number')
      ? payload.identity_number
      : existing.identity_number;
    const hasValidIdentity = Object.prototype.hasOwnProperty.call(payload, 'has_valid_identity')
      ? Boolean(payload.has_valid_identity)
      : (Boolean(ktpPath || identityNumber) || Boolean(existing.has_valid_identity));

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
          booking_type = $12,
          identity_number = $13,
          has_valid_identity = $14
      WHERE id = $15
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
       identityNumber,
       hasValidIdentity,
       reservationId
      ]
    );

    // Sync guest details to linked guests table if exists
    await client.query(
      `UPDATE guests
       SET phone = COALESCE($1, phone),
           identity_number = COALESCE($2, identity_number),
           full_name = COALESCE($3, full_name)
       WHERE id IN (
         SELECT guest_id FROM reservation_guests WHERE reservation_id = $4
       )`,
      [guestPhone || null, identityNumber || null, guestName || null, reservationId]
    ).catch(() => {});

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['PMS', 'UPDATE', 'RESERVATION', reservationId, JSON.stringify(withReservationHotelDates(updated.rows[0])), req.headers['x-correlation-id'] || null, reservationPropertyId]
    );

    await client.query('COMMIT');
    broadcastEvent('ReservationUpdated', {
      reservation_id: reservationId,
      room_id: updated.rows[0].room_id,
      guest_name: guestName,
      timestamp: new Date().toISOString()
    });

    const canonicalDto = await getCanonicalReservationDto(pool, reservationId);
    res.json({ status: 'SUCCESS', data: canonicalDto || withReservationHotelDates(updated.rows[0]) });
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

// GET /api/reservations/:id/edit-availability - server-authoritative selector projection
app.get('/api/reservations/:id/edit-availability', requireAuth, requireRole(['Front Office']), async (req: any, res: any) => {
  try {
    const reservationId = Number(req.params.id);
    const propertyId = Number(req.query.property_id);
    const checkIn = String(req.query.check_in || '');
    const checkOut = String(req.query.check_out || '');
    const stayType = String(req.query.stay_type || 'OVERNIGHT').toUpperCase() as 'OVERNIGHT' | 'DAY_USE' | 'TRANSIT';
    const availability = await getReservationEditAvailability(pool, reservationId, propertyId, checkIn, checkOut, stayType);
    return res.json({ status: 'OK', data: availability });
  } catch (err: any) {
    return res.status(err?.statusCode || 400).json({
      status: 'ERROR', code: err?.code, message: err?.message || 'Gagal memuat ketersediaan kamar untuk edit reservasi.'
    });
  }
});

// POST /api/reservations/:id/edit-preview
app.post('/api/reservations/:id/edit-preview', async (req: any, res: any) => {
  try {
    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId) || reservationId <= 0) {
      return res.status(400).json({ status: 'ERROR', message: 'ID reservasi tidak valid' });
    }

    const preview = await previewReservationEdit(pool, reservationId, req.body || {});
    res.json({ status: 'SUCCESS', data: preview });
  } catch (err: any) {
    const statusCode = err?.statusCode || 400;
    res.status(statusCode).json({ status: 'ERROR', code: err.code, message: err.message || 'Gagal menghitung pratinjau edit reservasi' });
  }
});

// POST & PUT /api/reservations/:id/edit
const handleReservationEdit = async (req: any, res: any) => {
  try {
    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId) || reservationId <= 0) {
      return res.status(400).json({ status: 'ERROR', message: 'ID reservasi tidak valid' });
    }

    const actor = req.body?.actor || req.user?.username || 'USER';
    const updated = await executeReservationEdit(pool, reservationId, req.body || {}, actor);

    broadcastEvent('ReservationUpdated', {
      reservation_id: reservationId,
      room_id: updated.room_id,
      guest_name: updated.guest_name,
      timestamp: new Date().toISOString()
    });

    res.json({ status: 'SUCCESS', data: withReservationHotelDates(updated) });
  } catch (err: any) {
    if (isRoomOverlapViolation(err)) {
      return sendRoomOverlapConflict(res);
    }
    const statusCode = err?.statusCode || 400;
    const message = String(err?.message || err);
    res.status(statusCode).json({ status: 'ERROR', code: err.code, message });
  }
};

app.post('/api/reservations/:id/edit', requireAuth, requireRole(['Front Office']), handleReservationEdit);
app.put('/api/reservations/:id/edit', requireAuth, requireRole(['Front Office']), handleReservationEdit);

// POST /api/reservations/:id/edit-with-payment — atomic edit + difference payment
app.post('/api/reservations/:id/edit-with-payment', requireAuth, requireRole(['Front Office']), handlePaymentUpload, async (req: any, res: any) => {
  try {
    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId) || reservationId <= 0) {
      return res.status(400).json({ status: 'ERROR', message: 'ID reservasi tidak valid' });
    }

    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    if (!idempotencyKey) {
      return res.status(400).json({
        status: 'ERROR', code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key wajib dikirim untuk menyimpan edit reservasi.'
      });
    }

    const nullableId = (value: unknown): number | null | undefined => {
      if (value === undefined) return undefined;
      if (value === null || String(value).trim() === '') return null;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        const err: any = new Error('ID referensi tidak valid');
        err.statusCode = 400;
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
      return parsed;
    };
    const body = req.body || {};
    const requestedPropertyId = Number(body.property_id);
    if (!Number.isInteger(requestedPropertyId) || requestedPropertyId <= 0) {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id tidak valid' });
    }
    const payload = {
      ...body,
      property_id: requestedPropertyId,
      room_type_id: nullableId(body.room_type_id) ?? undefined,
      room_id: nullableId(body.room_id),
      rate_plan_id: nullableId(body.rate_plan_id),
      adults: body.adults === undefined ? undefined : Number(body.adults),
      children: body.children === undefined ? undefined : Number(body.children),
      payment_amount: body.payment_amount === undefined || String(body.payment_amount).trim() === '' ? undefined : Number(body.payment_amount),
      amount_tendered: body.amount_tendered === undefined || String(body.amount_tendered).trim() === '' ? undefined : Number(body.amount_tendered),
      keep_current_price: body.keep_current_price === true || body.keep_current_price === 'true',
      expected_new_total: body.expected_new_total === undefined ? undefined : Number(body.expected_new_total),
      idempotency_key: idempotencyKey
    };
    const actor = body.actor || req.user?.username || 'USER';
    const file = req.file ? {
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      originalname: req.file.originalname,
      size: req.file.size
    } : null;

    const result = await executeReservationEditWithPayment(pool, reservationId, payload, file, actor);

    broadcastEvent('ReservationUpdated', {
      reservation_id: reservationId,
      room_id: result.reservation.room_id,
      guest_name: result.reservation.guest_name,
      timestamp: new Date().toISOString()
    });

    res.json({
      status: 'SUCCESS',
      data: {
        reservation: withReservationHotelDates(result.reservation),
        payment: result.payment,
        evidence: result.evidence,
        price_difference: result.price_difference,
        old_total_price: result.old_total_price,
        new_total_price: result.new_total_price,
        effective_settlement: result.effective_settlement,
        new_remaining_before_payment: result.new_remaining_before_payment,
        payment_required: result.payment_required
      }
    });
  } catch (err: any) {
    if (isRoomOverlapViolation(err)) {
      return sendRoomOverlapConflict(res);
    }
    const statusCode = err?.statusCode || 400;
    const message = String(err?.message || err);
    const resp: any = { status: 'ERROR', code: err.code, message };
    if (err.details) resp.details = err.details;
    res.status(statusCode).json(resp);
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
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['PMS', 'CANCEL', 'RESERVATION', reservationId, JSON.stringify(withReservationHotelDates(cancelledReservation)), req.headers['x-correlation-id'] || null, propertyId]
      );

      const legacyAudit = buildLegacyPreLedgerCancellationAudit(inventoryPlan, currentStatus, 'CANCELLED');
      if (legacyAudit) {
        await client.query(
          `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            'PMS',
            'LEGACY_PRE_LEDGER_CANCELLATION',
            'RESERVATION',
            reservationId,
            JSON.stringify(legacyAudit),
            req.headers['x-correlation-id'] || null,
            propertyId
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
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          'PMS',
          derivedBookingStatus === 'CANCELLED' ? 'CANCEL' : 'COMPLETE',
          'BOOKING',
          bookingId,
          JSON.stringify(bookingAuditPayload),
          req.headers['x-correlation-id'] || null,
          propertyId
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
    if (err?.missing_fields || err?.missing) {
      responseObj.missing_fields = err.missing_fields || err.missing;
      responseObj.missing = err.missing || err.missing_fields;
    }
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
             COALESCE(ar.active_reservations, 0) AS active_reservation_count,
             cur_block.block_type AS operational_block_type,
             cur_block.active_block_id AS operational_block_id,
             cur_block.reason AS operational_block_reason
      FROM rooms r
      LEFT JOIN room_types rt ON rt.id = r.room_type_id
      LEFT JOIN (
        SELECT res.room_id, COUNT(*)::int AS active_reservations
        FROM reservations res
        WHERE res.status IN ('BOOKED', 'CHECKED_IN')
        GROUP BY res.room_id
      ) ar ON ar.room_id = r.id
      LEFT JOIN (
        SELECT room_id, block_type, reason, id AS active_block_id
        FROM room_operational_blocks
        WHERE property_id = $1
          AND status = 'ACTIVE'
          AND start_date <= ((NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jakarta')::date
          AND end_date > ((NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jakarta')::date
      ) cur_block ON cur_block.room_id = r.id
      ${whereClause}
      ORDER BY r.room_number
    `, params);
    res.json({ status: 'OK', data: rooms.rows });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

// Housekeeping domain routes are mounted via createHousekeepingRouter (HK-OPS-1)


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

    const categories = await pool.query('SELECT * FROM pos_menu_categories WHERE property_id = $1 ORDER BY id', [propertyId]);
    const items = await pool.query(`
      SELECT mi.*, pmc.name AS category_name
      FROM pos_menu_items mi
      LEFT JOIN pos_menu_categories pmc ON pmc.id = mi.category_id
      WHERE mi.is_active = TRUE AND mi.property_id = $1
      ORDER BY mi.id
    `, [propertyId]);

    res.json({ status: 'OK', data: { categories: categories.rows, items: items.rows } });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.post('/api/pos/menu/items', async (req, res) => {
  try {
    const { property_id, name, item_code, category_name, price, description } = req.body || {};
    if (!property_id || !name || price === undefined) {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id, name, and price are required' });
    }
    const propId = Number(property_id);
    let categoryId = null;
    if (category_name && String(category_name).trim()) {
      const catCheck = await pool.query(
        'SELECT id FROM pos_menu_categories WHERE property_id = $1 AND LOWER(name) = LOWER($2)',
        [propId, String(category_name).trim()]
      );
      if ((catCheck.rowCount ?? 0) > 0) {
        categoryId = catCheck.rows[0].id;
      } else {
        const newCat = await pool.query(
          'INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, $2) RETURNING id',
          [propId, String(category_name).trim()]
        );
        categoryId = newCat.rows[0].id;
      }
    }
    const code = item_code && String(item_code).trim()
      ? String(item_code).trim().toUpperCase()
      : `PRD-${Date.now().toString().slice(-4)}`;

    const result = await pool.query(
      `INSERT INTO pos_menu_items (property_id, category_id, item_code, name, description, price, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       RETURNING *`,
      [propId, categoryId, code, String(name).trim(), description ? String(description).trim() : null, Number(price)]
    );
    res.status(201).json({ status: 'OK', data: { ...result.rows[0], category_name: category_name || 'Food & Beverage' } });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.delete('/api/pos/menu/items/:id', async (req, res) => {
  try {
    const itemId = Number(req.params.id);
    const propertyIdRaw = req.query.property_id || req.body?.property_id;
    if (!itemId) {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid item id' });
    }
    if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
    }
    const propertyId = Number(propertyIdRaw);
    if (!Number.isInteger(propertyId) || propertyId <= 0) {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
    }
    const updateResult = await pool.query(
      'UPDATE pos_menu_items SET is_active = FALSE WHERE id = $1 AND property_id = $2 RETURNING id',
      [itemId, propertyId]
    );
    if ((updateResult.rowCount ?? 0) === 0) {
      return res.status(404).json({ status: 'ERROR', code: 'NOT_FOUND', message: `menu item ${itemId} not found for property ${propertyId}` });
    }
    res.json({ status: 'OK', message: 'Item nonaktif' });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.get('/api/pos/orders', async (req, res) => {
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

    const orders = await pool.query(`
      SELECT po.*, COUNT(poi.id) AS item_count, COALESCE(SUM(poi.quantity), 0) AS total_qty
      FROM pos_orders po
      LEFT JOIN pos_order_items poi ON poi.order_id = po.id
      WHERE po.property_id = $1
      GROUP BY po.id
      ORDER BY po.created_at DESC
    `, [propertyId]);

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
  const { property_id: propertyIdRaw, reservation_id, table_number, guest_name, items } = req.body;

  if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
  }
  const propertyId = Number(propertyIdRaw);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ status: 'ERROR', message: 'items must not be empty' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Validate property exists
    const propCheck = await client.query('SELECT id FROM properties WHERE id = $1', [propertyId]);
    if ((propCheck.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', code: 'PROPERTY_NOT_FOUND', message: `property ${propertyId} not found` });
    }

    // Validate reservation linkage: reservation must belong to same property
    if (reservation_id != null) {
      const resCheck = await client.query(
        'SELECT b.property_id FROM reservations r JOIN bookings b ON b.id = r.booking_id WHERE r.id = $1',
        [reservation_id]
      );
      if ((resCheck.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ status: 'ERROR', code: 'RESERVATION_NOT_FOUND', message: `reservation ${reservation_id} not found` });
      }
      if (Number(resCheck.rows[0].property_id) !== propertyId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ status: 'ERROR', code: 'CROSS_PROPERTY_RESERVATION', message: 'reservation belongs to a different property' });
      }
    }

    // Validate all menu items belong to the same property
    for (const item of items) {
      const menuItem = await client.query(
        'SELECT id, price, name, property_id FROM pos_menu_items WHERE id = $1 AND is_active = TRUE',
        [item.menu_item_id]
      );
      if (!hasRows(menuItem)) {
        await client.query('ROLLBACK');
        return res.status(404).json({ status: 'ERROR', message: `Menu item ${item.menu_item_id} not found` });
      }
      if (Number(menuItem.rows[0].property_id) !== propertyId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ status: 'ERROR', code: 'CROSS_PROPERTY_MENU_ITEM', message: `Menu item ${item.menu_item_id} belongs to a different property` });
      }
    }

    const initialStatus = (req.body.status || 'OPEN').toUpperCase();
    const orderNumber = `POS-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Date.now().toString().slice(-6)}`;
    const orderInsert = await client.query(
      `INSERT INTO pos_orders (property_id, reservation_id, order_number, table_number, guest_name, total_amount, status)
       VALUES ($1, $2, $3, $4, $5, 0, $6)
       RETURNING *`,
      [propertyId, reservation_id || null, orderNumber, table_number || 'Walk In', guest_name || 'Guest', initialStatus]
    );

    const orderId = orderInsert.rows[0].id;
    let totalAmount = 0;

    for (const item of items) {
      const menuItem = await client.query(
        'SELECT id, price, name FROM pos_menu_items WHERE id = $1 AND is_active = TRUE',
        [item.menu_item_id]
      );
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

    // Auto-project to canonical SALE transaction if order is in posted/paid state
    if (['PAID', 'COMPLETED', 'POSTED', 'CLOSED'].includes(initialStatus)) {
      try {
        await projectPosOrderToTransaction(client, orderId, {
          propertyId,
          actorName: req.body.actor_name || 'Staff POS'
        });
      } catch (pErr: any) {
        console.warn('[Transactions] POS order creation projection warning:', pErr.message);
      }
    }

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
  const { status, property_id: propertyIdRaw } = req.body;

  if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
  }
  const propertyId = Number(propertyIdRaw);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
  }

  try {
    const propCheck = await pool.query('SELECT id FROM properties WHERE id = $1', [propertyId]);
    if ((propCheck.rowCount ?? 0) === 0) {
      return res.status(404).json({ status: 'ERROR', code: 'PROPERTY_NOT_FOUND', message: `property ${propertyId} not found` });
    }

    const orderCheck = await pool.query('SELECT id, property_id FROM pos_orders WHERE id = $1', [orderId]);
    if (!hasRows(orderCheck)) {
      return res.status(404).json({ status: 'ERROR', message: 'order not found' });
    }
    if (Number(orderCheck.rows[0].property_id) !== propertyId) {
      return res.status(403).json({ status: 'ERROR', code: 'CROSS_PROPERTY_ORDER', message: 'order belongs to a different property' });
    }

    const targetStatus = (status || 'OPEN').toUpperCase();
    const result = await pool.query(
      'UPDATE pos_orders SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [targetStatus, orderId]
    );

    // Auto-project or reverse canonical transaction based on updated status
    try {
      await projectPosOrderToTransaction(pool, orderId, {
        propertyId,
        actorName: req.body.actor_name || 'Staff POS'
      });
    } catch (pErr: any) {
      console.warn('[Transactions] POS order status change projection warning:', pErr.message);
    }

    res.json({ status: 'SUCCESS', data: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.get('/api/accounting/summary', async (req, res) => {
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

    const accounts = await pool.query(
      'SELECT * FROM accounting_gl_accounts WHERE property_id = $1 ORDER BY code',
      [propertyId]
    );

    const entries = await pool.query(`
      SELECT j.id, j.entry_number, j.description, j.entry_date, j.source_module,
             COALESCE(SUM(CASE WHEN jl.debit > 0 THEN jl.debit ELSE 0 END), 0) AS total_debit,
             COALESCE(SUM(CASE WHEN jl.credit > 0 THEN jl.credit ELSE 0 END), 0) AS total_credit
      FROM accounting_journal_entries j
      LEFT JOIN accounting_journal_lines jl ON jl.journal_entry_id = j.id
      WHERE j.property_id = $1
      GROUP BY j.id, j.entry_number, j.description, j.entry_date, j.source_module
      ORDER BY j.entry_date DESC
    `, [propertyId]);

    const payable = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM vendor_payables WHERE property_id = $1 AND status != $2',
      [propertyId, 'PAID']
    );
    const receivable = await pool.query(
      'SELECT COALESCE(SUM(total_amount - paid_amount), 0) AS total FROM guest_receivables WHERE property_id = $1 AND status != $2',
      [propertyId, 'PAID']
    );

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
  const { property_id: propertyIdRaw, description, source_module, source_ref, lines } = req.body;

  if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
  }
  const propertyId = Number(propertyIdRaw);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
  }

  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ status: 'ERROR', message: 'journal lines required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Validate property exists
    const propCheck = await client.query('SELECT id FROM properties WHERE id = $1', [propertyId]);
    if ((propCheck.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', code: 'PROPERTY_NOT_FOUND', message: `property ${propertyId} not found` });
    }

    // Validate all GL accounts belong to this property
    for (const line of lines) {
      const account = await client.query('SELECT id, property_id FROM accounting_gl_accounts WHERE id = $1', [line.account_id]);
      if (!hasRows(account)) {
        await client.query('ROLLBACK');
        return res.status(404).json({ status: 'ERROR', message: `GL account ${line.account_id} not found` });
      }
      if (Number(account.rows[0].property_id) !== propertyId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ status: 'ERROR', code: 'CROSS_PROPERTY_ACCOUNT', message: `GL account ${line.account_id} belongs to a different property` });
      }
    }

    const entryNumber = `JRN-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Date.now().toString().slice(-6)}`;
    const entry = await client.query(
      `INSERT INTO accounting_journal_entries (property_id, entry_number, description, source_module, source_ref)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [propertyId, entryNumber, description || 'Manual journal', source_module || 'PMS', source_ref || null]
    );

    for (const line of lines) {
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
  const { property_id: propertyIdRaw, reservation_id, guest_name, total_amount, paid_amount, status } = req.body;

  if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
  }
  const propertyId = Number(propertyIdRaw);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
  }

  try {
    const propCheck = await pool.query('SELECT id FROM properties WHERE id = $1', [propertyId]);
    if ((propCheck.rowCount ?? 0) === 0) {
      return res.status(404).json({ status: 'ERROR', code: 'PROPERTY_NOT_FOUND', message: `property ${propertyId} not found` });
    }

    let effectiveReservationId: number | null = null;
    if (reservation_id !== undefined && reservation_id !== null && String(reservation_id).trim() !== '') {
      effectiveReservationId = Number(reservation_id);
      if (!Number.isInteger(effectiveReservationId) || effectiveReservationId <= 0) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid reservation_id' });
      }

      const resCheck = await pool.query(`
        SELECT r.id, r.booking_id, b.property_id AS booking_property_id
        FROM reservations r
        LEFT JOIN bookings b ON b.id = r.booking_id
        WHERE r.id = $1
      `, [effectiveReservationId]);

      if ((resCheck.rowCount ?? 0) === 0) {
        return res.status(404).json({ status: 'ERROR', code: 'RESERVATION_NOT_FOUND', message: `reservation ${effectiveReservationId} not found` });
      }

      const bookingPropertyId = resCheck.rows[0].booking_property_id;
      if (bookingPropertyId === null || bookingPropertyId === undefined) {
        return res.status(422).json({ status: 'ERROR', code: 'RESERVATION_INTEGRITY_ERROR', message: 'Reservation lacks authoritative booking property ownership' });
      }

      if (Number(bookingPropertyId) !== propertyId) {
        return res.status(403).json({ status: 'ERROR', code: 'CROSS_PROPERTY_RESERVATION', message: 'Reservation belongs to a different property' });
      }
    }

    const result = await pool.query(
      `INSERT INTO guest_receivables (property_id, reservation_id, guest_name, total_amount, paid_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [propertyId, effectiveReservationId, guest_name || 'Guest', Number(total_amount || 0), Number(paid_amount || 0), status || 'OPEN']
    );

    res.status(201).json({ status: 'SUCCESS', data: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.post('/api/accounting/payables', async (req, res) => {
  const { property_id: propertyIdRaw, vendor_name, invoice_number, due_date, amount, status } = req.body;

  if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
  }
  const propertyId = Number(propertyIdRaw);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
  }

  try {
    const propCheck = await pool.query('SELECT id FROM properties WHERE id = $1', [propertyId]);
    if ((propCheck.rowCount ?? 0) === 0) {
      return res.status(404).json({ status: 'ERROR', code: 'PROPERTY_NOT_FOUND', message: `property ${propertyId} not found` });
    }

    const result = await pool.query(
      `INSERT INTO vendor_payables (property_id, vendor_name, invoice_number, due_date, amount, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [propertyId, vendor_name || 'Vendor', invoice_number || null, due_date || null, Number(amount || 0), status || 'OPEN']
    );

    res.status(201).json({ status: 'SUCCESS', data: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.patch('/api/rooms/:id/status', async (req, res) => {
  const roomId = Number(req.params.id);
  const { status, force_hk_override } = req.body;

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

    const currentRoom = await client.query('SELECT status FROM rooms WHERE id = $1', [roomId]);
    const currentPhysicalStatus = currentRoom.rows[0]?.status;

    // Check allow_calendar_room_status_override setting if attempting Dirty -> Ready transition
    const isTransitionToReady = (mappedStatus === 'VACANT_CLEAN' || mappedStatus === 'INSPECTED') &&
      (currentPhysicalStatus === 'VACANT_DIRTY' || currentPhysicalStatus === 'CLEANING' || currentPhysicalStatus === 'DIRTY');

    if (isTransitionToReady && !force_hk_override) {
      const hkSet = await client.query(
        'SELECT allow_calendar_room_status_override FROM property_housekeeping_settings WHERE property_id = $1',
        [propertyId]
      );
      const allowOverride = hkSet.rows.length > 0 ? Boolean(hkSet.rows[0].allow_calendar_room_status_override) : false;
      if (!allowOverride) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          status: 'ERROR',
          code: 'OVERRIDE_DISABLED',
          message: 'Perubahan status kesiapan kamar dari kalender dinonaktifkan oleh pengaturan housekeeping properti. Kesiapan kamar harus diselesaikan melalui alur kerja Housekeeping.'
        });
      }
    }

    const result = await client.query(
      'UPDATE rooms SET status = $1 WHERE id = $2 RETURNING *',
      [mappedStatus, roomId]
    );
    if (!hasRows(result)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', message: 'room not found' });
    }

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['PMS', 'UPDATE_STATUS', 'ROOM', roomId, JSON.stringify({ input_status: status, status: mappedStatus, force_hk_override: Boolean(force_hk_override) }), req.headers['x-correlation-id'] || null, propertyId]
    );

    if (mappedStatus === 'VACANT_DIRTY' || mappedStatus === 'DIRTY') {
      await ensureDirtyRoomCleaningTask(client, propertyId, roomId, { sourceType: 'ROOM_STATUS_MUTATION' });
    }

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
    const blockOverlap = await findActiveOperationalBlockOverlap(client, roomId, oldCheckOut, requestedCheckOut);
    if (hasRows(blockOverlap)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        status: 'CONFLICT',
        code: 'ROOM_OUT_OF_SERVICE',
        message: 'room is out of order or out of service during requested extension'
      });
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

    // Determine nightly pricing for extension
    let nightlyRate = 0;
    const requestedNightlyRate = req.body?.additional_night_rate !== undefined
      ? Number(req.body.additional_night_rate)
      : (req.body?.nightly_rate !== undefined ? Number(req.body.nightly_rate) : undefined);

    const isManual = Boolean(reservation.is_manual_override || req.body?.is_manual_override || reservation.ota_source_id || reservation.booking_type === 'OTA');
    const manualReason = req.body?.manual_override_reason || reservation.manual_override_reason || (reservation.ota_source_id ? 'OTA Extension' : (isManual ? 'Manual Override' : null));

    if (requestedNightlyRate !== undefined && !isNaN(requestedNightlyRate) && requestedNightlyRate >= 0) {
      nightlyRate = Math.round(requestedNightlyRate);
    } else {
      // Lookup latest nightly rate snapshot
      const prevRateRes = await client.query(
        `SELECT final_room_rate, base_rate FROM reservation_nightly_rates
         WHERE reservation_id = $1
         ORDER BY stay_date DESC LIMIT 1`,
        [reservationId]
      );
      if (prevRateRes.rows.length > 0) {
        nightlyRate = Math.round(Number(prevRateRes.rows[0].final_room_rate || prevRateRes.rows[0].base_rate || 0));
      } else {
        const existingNights = enumerateHotelDates(checkIn, oldCheckOut).length || 1;
        nightlyRate = Math.round(Number(reservation.total_price || 0) / existingNights);
      }
    }

    const deltaCharge = nightlyRate * deltaDates.length;

    // Idempotent Folio Charge Posting
    const sourceId = `EXTEND-${reservationId}-${oldCheckOut}-${requestedCheckOut}`;
    const existingFolioRes = await client.query(
      `SELECT id FROM folio_entries
       WHERE reservation_id = $1 AND source_type = 'STAY_EXTENSION' AND source_id = $2 AND is_voided = FALSE`,
      [reservationId, sourceId]
    );

    let folioEntryId: number;
    if (existingFolioRes.rows.length > 0) {
      folioEntryId = Number(existingFolioRes.rows[0].id);
      await client.query(
        `UPDATE folio_entries
         SET amount = $1, base_amount = $1, unit_price = $2, quantity = $3
         WHERE id = $4`,
        [deltaCharge, nightlyRate, deltaDates.length, folioEntryId]
      );
    } else {
      const folioInsert = await client.query(
        `INSERT INTO folio_entries (
          reservation_id, property_id, entry_type, source_type, source_id,
          description, amount, direction, base_amount, unit_price, quantity,
          status, revenue_category, actor_name_snapshot, actor_role_snapshot
        ) VALUES (
          $1, $2, 'ROOM_CHARGE', 'STAY_EXTENSION', $3,
          $4, $5, 'DEBIT', $5, $6, $7,
          'POSTED', 'ROOM_SALES', $8, $9
        ) RETURNING id`,
        [
          reservationId,
          propertyId,
          sourceId,
          `Perpanjangan Menginap (${deltaDates.length} malam: ${oldCheckOut} s/d ${requestedCheckOut})`,
          deltaCharge,
          nightlyRate,
          deltaDates.length,
          req.body?.actor_name || 'Front Desk',
          req.body?.actor_role || 'STAFF'
        ]
      );
      folioEntryId = Number(folioInsert.rows[0].id);
    }

    // Canonical Transaction Projection (SALE)
    try {
      await projectFolioEntryToTransaction(client, folioEntryId, { propertyId });
    } catch (projErr: any) {
      console.warn('[Transactions] Stay extension projection warning:', projErr.message);
    }

    // Upsert nightly rates snapshots
    for (const stayDate of deltaDates) {
      await client.query(
        `INSERT INTO reservation_nightly_rates (
          reservation_id, property_id, stay_date,
          room_type_id, room_type_code_snapshot, room_type_name_snapshot,
          base_rate, applied_override_rate, final_room_rate,
          service_amount, tax_amount, total_amount,
          is_manual_override, manual_override_reason, created_at
        ) VALUES (
          $1, $2, $3,
          $4, $5, $6,
          $7, $8, $9,
          0, 0, $10,
          $11, $12, NOW()
        )
        ON CONFLICT (reservation_id, stay_date) DO UPDATE SET
          room_type_id = EXCLUDED.room_type_id,
          room_type_code_snapshot = EXCLUDED.room_type_code_snapshot,
          room_type_name_snapshot = EXCLUDED.room_type_name_snapshot,
          base_rate = EXCLUDED.base_rate,
          applied_override_rate = EXCLUDED.applied_override_rate,
          final_room_rate = EXCLUDED.final_room_rate,
          total_amount = EXCLUDED.total_amount,
          is_manual_override = EXCLUDED.is_manual_override,
          manual_override_reason = EXCLUDED.manual_override_reason`,
        [
          reservationId,
          propertyId,
          stayDate,
          roomType.roomTypeId,
          null,
          roomType.roomTypeName,
          nightlyRate,
          isManual ? nightlyRate : null,
          nightlyRate,
          nightlyRate,
          isManual,
          manualReason
        ]
      );
    }

    // Reconcile total price from nightly rates + stay charges
    const sumRatesRes = await client.query(
      `SELECT COALESCE(SUM(total_amount), 0) AS total_stay_charge
       FROM reservation_nightly_rates WHERE reservation_id = $1`,
      [reservationId]
    );
    const newStaySubtotal = Number(sumRatesRes.rows[0].total_stay_charge) || (Number(reservation.total_price || 0) + deltaCharge);

    // Sum other non-room charges if any
    const otherChargesRes = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS other_charges
       FROM folio_entries
       WHERE reservation_id = $1 AND direction = 'DEBIT' AND is_voided = FALSE AND source_type NOT IN ('ROOM_CHARGE', 'STAY_EXTENSION') AND entry_type NOT IN ('ROOM_CHARGE', 'STAY_EXTENSION')`,
      [reservationId]
    );
    const otherCharges = Number(otherChargesRes.rows[0].other_charges || 0);
    const discountAmount = Number(reservation.discount_amount || 0);

    const finalTotalPrice = Math.max(0, newStaySubtotal + otherCharges - discountAmount);

    // Reconcile payments strictly from payment_transactions
    const paymentsRes = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS total_paid
       FROM payment_transactions
       WHERE reservation_id = $1 AND status = 'SUCCESS' AND transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')`,
      [reservationId]
    );
    const totalPaid = Number(paymentsRes.rows[0].total_paid || 0);
    const appliedDepositRes = await client.query(
      `SELECT COALESCE(applied_deposit, 0) AS applied_deposit FROM reservations WHERE id = $1`,
      [reservationId]
    );
    const appliedDeposit = Number(appliedDepositRes.rows[0].applied_deposit || 0);
    const effectiveSettlement = totalPaid + appliedDeposit;
    const newRemainingBalance = Math.max(0, finalTotalPrice - effectiveSettlement);
    const newPaymentStatus = effectiveSettlement >= finalTotalPrice && finalTotalPrice > 0
      ? 'PAID'
      : (effectiveSettlement > 0 ? 'PARTIAL' : 'UNPAID');

    // Update reservation
    await client.query(
      `UPDATE reservations
       SET check_out = $1,
           subtotal_amount = $2,
           total_price = $3,
           amount_paid = $4,
           applied_deposit = $5,
           remaining_balance = $6,
           payment_status = $7
       WHERE id = $8`,
      [
        requestedCheckOut,
        newStaySubtotal + otherCharges,
        finalTotalPrice,
        totalPaid,
        appliedDeposit,
        newRemainingBalance,
        newPaymentStatus,
        reservationId
      ]
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
      nightly_rate: nightlyRate,
      delta_charge: deltaCharge,
      new_total_price: finalTotalPrice,
      amount_paid: totalPaid,
      remaining_balance: newRemainingBalance,
      room_type: roomType.roomTypeName,
      room_type_id: roomType.roomTypeId
    };

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['PMS', 'EXTEND', 'RESERVATION', reservationId, JSON.stringify(auditPayload), req.headers['x-correlation-id'] || null, propertyId]
    );

    await client.query('COMMIT');
    const canonicalDto = await getCanonicalReservationDto(pool, reservationId);

    return res.json({
      status: 'SUCCESS',
      data: canonicalDto,
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
      const canonicalDto = await getCanonicalReservationDto(pool, reservationId);
      return res.json({
        status: 'SUCCESS',
        data: canonicalDto,
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

    // Shortening logic
    const removedRatesRes = await client.query(
      `SELECT COALESCE(SUM(total_amount), 0) AS removed_amount
       FROM reservation_nightly_rates
       WHERE reservation_id = $1 AND stay_date >= $2 AND stay_date < $3`,
      [reservationId, requestedCheckOut, oldCheckOut]
    );
    let shortenAmount = Number(removedRatesRes.rows[0].removed_amount || 0);
    if (shortenAmount === 0) {
      const oldNights = enumerateHotelDates(checkIn, oldCheckOut).length || 1;
      const avgRate = Math.round(Number(reservation.total_price || 0) / oldNights);
      shortenAmount = avgRate * deltaDates.length;
    }

    // Delete shortened nights from reservation_nightly_rates
    await client.query(
      `DELETE FROM reservation_nightly_rates
       WHERE reservation_id = $1 AND stay_date >= $2 AND stay_date < $3`,
      [reservationId, requestedCheckOut, oldCheckOut]
    );

    // Post Folio Adjustment / Credit Entry
    const sourceId = `SHORTEN-${reservationId}-${requestedCheckOut}-${oldCheckOut}`;
    const existingAdjRes = await client.query(
      `SELECT id FROM folio_entries
       WHERE reservation_id = $1 AND source_type = 'STAY_SHORTEN' AND source_id = $2 AND is_voided = FALSE`,
      [reservationId, sourceId]
    );

    if (existingAdjRes.rows.length === 0) {
      await client.query(
        `INSERT INTO folio_entries (
          reservation_id, property_id, entry_type, source_type, source_id,
          description, amount, direction, base_amount, unit_price, quantity,
          status, revenue_category, actor_name_snapshot, actor_role_snapshot
        ) VALUES (
          $1, $2, 'STAY_SHORTEN_ADJUSTMENT', 'STAY_SHORTEN', $3,
          $4, $5, 'CREDIT', $5, $6, $7,
          'POSTED', 'ROOM_SALES', $8, $9
        )`,
        [
          reservationId,
          propertyId,
          sourceId,
          `Pengurangan Masa Menginap (${deltaDates.length} malam: ${requestedCheckOut} s/d ${oldCheckOut})`,
          shortenAmount,
          Math.round(shortenAmount / (deltaDates.length || 1)),
          deltaDates.length,
          req.body?.actor_name || 'Front Desk',
          req.body?.actor_role || 'STAFF'
        ]
      );
    }

    // Reconcile total price from remaining nightly rates
    const sumRatesRes = await client.query(
      `SELECT COALESCE(SUM(total_amount), 0) AS total_stay_charge
       FROM reservation_nightly_rates WHERE reservation_id = $1`,
      [reservationId]
    );
    const newStaySubtotal = Number(sumRatesRes.rows[0].total_stay_charge) || Math.max(0, Number(reservation.total_price || 0) - shortenAmount);

    const otherChargesRes = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS other_charges
       FROM folio_entries
       WHERE reservation_id = $1 AND direction = 'DEBIT' AND is_voided = FALSE AND source_type NOT IN ('ROOM_CHARGE', 'STAY_EXTENSION') AND entry_type NOT IN ('ROOM_CHARGE', 'STAY_EXTENSION')`,
      [reservationId]
    );
    const otherCharges = Number(otherChargesRes.rows[0].other_charges || 0);
    const discountAmount = Number(reservation.discount_amount || 0);

    const finalTotalPrice = Math.max(0, newStaySubtotal + otherCharges - discountAmount);

    // Reconcile payments strictly from payment_transactions
    const paymentsRes = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS total_paid
       FROM payment_transactions
       WHERE reservation_id = $1 AND status = 'SUCCESS' AND transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')`,
      [reservationId]
    );
    const totalPaid = Number(paymentsRes.rows[0].total_paid || 0);
    const appliedDepositRes = await client.query(
      `SELECT COALESCE(applied_deposit, 0) AS applied_deposit FROM reservations WHERE id = $1`,
      [reservationId]
    );
    const appliedDeposit = Number(appliedDepositRes.rows[0].applied_deposit || 0);
    const effectiveSettlement = totalPaid + appliedDeposit;
    const newRemainingBalance = Math.max(0, finalTotalPrice - effectiveSettlement);
    const newPaymentStatus = effectiveSettlement > finalTotalPrice
      ? 'OVERPAID'
      : (effectiveSettlement === finalTotalPrice && finalTotalPrice > 0 ? 'PAID' : (effectiveSettlement > 0 ? 'PARTIAL' : 'UNPAID'));

    // Update reservation
    await client.query(
      `UPDATE reservations
       SET check_out = $1,
           subtotal_amount = $2,
           total_price = $3,
           amount_paid = $4,
           applied_deposit = $5,
           remaining_balance = $6,
           payment_status = $7
       WHERE id = $8`,
      [
        requestedCheckOut,
        newStaySubtotal + otherCharges,
        finalTotalPrice,
        totalPaid,
        appliedDeposit,
        newRemainingBalance,
        newPaymentStatus,
        reservationId
      ]
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
      shorten_amount: shortenAmount,
      new_total_price: finalTotalPrice,
      amount_paid: totalPaid,
      remaining_balance: newRemainingBalance,
      overpayment: totalPaid > finalTotalPrice ? totalPaid - finalTotalPrice : 0,
      room_type: roomType.roomTypeName,
      room_type_id: roomType.roomTypeId
    };

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['PMS', 'SHORTEN', 'RESERVATION', reservationId, JSON.stringify(auditPayload), req.headers['x-correlation-id'] || null, propertyId]
    );

    await client.query('COMMIT');
    const canonicalDto = await getCanonicalReservationDto(pool, reservationId);

    return res.json({
      status: 'SUCCESS',
      data: canonicalDto,
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
    const blockOverlap = await findActiveOperationalBlockOverlap(client, roomId, current.check_in, current.check_out);
    if (hasRows(blockOverlap)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        status: 'CONFLICT',
        code: 'ROOM_OUT_OF_SERVICE',
        message: 'room is out of order or out of service during requested stay'
      });
    }

    // PRE-CHECKIN MANDATORY GATE: Guest Phone and Guest Identity (KTP)
    if (!req.body?.force && !req.body?.override_guest_identity) {
      let hasPhone = Boolean(current.guest_phone && String(current.guest_phone).trim().length > 0);
      let hasIdentity = Boolean(
        current.has_valid_identity ||
        (current.ktp_path && String(current.ktp_path).trim().length > 0) ||
        (current.identity_number && String(current.identity_number).trim().length > 0)
      );

      if (!hasPhone || !hasIdentity) {
        const linkedGuestRes = await client.query(
          `SELECT g.phone, g.identity_number, g.identity_path, g.has_valid_identity
           FROM reservation_guests rg
           JOIN guests g ON rg.guest_id = g.id
           WHERE rg.reservation_id = $1
           LIMIT 1`,
          [reservationId]
        ).catch(() => ({ rowCount: 0, rows: [] as any[] }));

        if (hasRows(linkedGuestRes)) {
          const g = linkedGuestRes.rows[0];
          if (!hasPhone && g.phone && String(g.phone).trim().length > 0) {
            hasPhone = true;
          }
          if (!hasIdentity && (g.has_valid_identity || (g.identity_path && g.identity_path.trim().length > 0) || (g.identity_number && g.identity_number.trim().length > 0))) {
            hasIdentity = true;
          }
        }
      }

      if (!hasPhone || !hasIdentity) {
        await client.query('ROLLBACK');
        const missingItems: string[] = [];
        if (!hasPhone) missingItems.push('Nomor Telepon Tamu');
        if (!hasIdentity) missingItems.push('Dokumen Identitas (KTP / NIK)');

        return res.status(400).json({
          status: 'ERROR',
          code: 'CHECKIN_REQUIREMENTS_NOT_MET',
          message: `Check-in gagal: ${missingItems.join(' dan ')} wajib dilengkapi sebelum melakukan check-in.`,
          missing_fields: {
            phone: !hasPhone,
            identity: !hasIdentity
          }
        });
      }
    }

    // TURNOVER-1: Check-in safety gate (outgoing checked-in guest & room physical readiness)
    if (!req.body?.override_housekeeping && !req.body?.force) {
      await assertCheckInEligible(client, roomId, reservationId);
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
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['PMS', 'CHECK_IN', 'RESERVATION', reservationId, JSON.stringify(withReservationHotelDates(updated.rows[0])), req.headers['x-correlation-id'] || null, propertyId]
    );

    await client.query('COMMIT');
    broadcastEvent('ReservationCheckedIn', {
      reservation_id: reservationId,
      room_id: roomId,
      guest_name: current.guest_name,
      checked_in_at: new Date().toISOString(),
      timestamp: new Date().toISOString()
    });

    const canonicalDto = await getCanonicalReservationDto(pool, reservationId);
    res.json({ status: 'SUCCESS', data: canonicalDto || withReservationHotelDates(updated.rows[0]) });
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
      // Check mandatory checkout inspection policy
      const isHkEnabled = await isFeatureEnabled(client, propertyId, 'housekeeping.enabled');
      const isCheckoutCheckFeature = isHkEnabled && (await isFeatureEnabled(client, propertyId, 'housekeeping.checkout_inspection'));
      if (isCheckoutCheckFeature && !req.body?.skip_inspection && !req.body?.force) {
        const hkSettings = await getPropertyHousekeepingSettings(client, propertyId);
        if (hkSettings.require_checkout_room_check) {
          const chkTaskRes = await client.query(
            `SELECT status, inspection_result FROM housekeeping_tasks
             WHERE reservation_id = $1 AND task_type = 'CHECKOUT_ROOM_CHECK'
             ORDER BY id DESC LIMIT 1`,
            [reservationId]
          );
          if (!hasRows(chkTaskRes) || chkTaskRes.rows[0].status !== 'DONE') {
            await client.query('ROLLBACK');
            return res.status(400).json({
              status: 'ERROR',
              code: 'CHECKOUT_INSPECTION_REQUIRED',
              message: 'Pemeriksaan kamar oleh Housekeeping wajib diselesaikan sebelum proses checkout.'
            });
          }
        }
      }

      // No property guarantee policy exists yet. Fail closed only when an
      // explicit physical custody record is still HELD; uploaded KTP/OCR data
      // is intentionally unrelated to this gate.
      const heldIdentity = await getHeldIdentityCustodyForCheckout(client, propertyId, reservationId);
      if (heldIdentity.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          status: 'ERROR',
          code: 'IDENTITY_CUSTODY_NOT_RETURNED',
          message: 'Dokumen identitas fisik masih ditahan hotel dan harus dikembalikan sebelum checkout.'
        });
      }

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
      if (checkoutReservation.stay_type !== 'DAY_USE') {
        await releaseReservationInventoryForCheckout(client, {
          ...checkoutReservation,
          current_room_type_id: roomTypeResult.rows[0].room_type_id
        });
      }

      await client.query(
        'UPDATE rooms SET status = $1 WHERE id = $2',
        ['VACANT_DIRTY', currentRoomId]
      );

      await ensureCheckoutRoomCleaningTask(client, propertyId, currentRoomId, reservationId);

      await client.query(
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['PMS', 'CHECK_OUT', 'RESERVATION', reservationId, JSON.stringify(withReservationHotelDates(checkoutReservation)), req.headers['x-correlation-id'] || null, propertyId]
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
          `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          ['PMS', 'COMPLETE', 'BOOKING', bookingRecord.id, JSON.stringify(bookingCompletionAuditPayload), req.headers['x-correlation-id'] || null, propertyId]
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

    const canonicalDto = await getCanonicalReservationDto(pool, reservationId);
    return res.json({ status: 'SUCCESS', data: canonicalDto || withReservationHotelDates(checkoutReservation) });
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

app.post('/api/reservations/:id/payments', handlePaymentUpload, async (req: any, res: any) => {
  const reservationId = Number(req.params.id);
  if (!Number.isInteger(reservationId) || reservationId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid reservation id' });
  }

  const { property_id: propertyIdRaw, amount, payment_method, reference_code, transaction_type, evidence_type, evidence_note } = req.body;

  if (['DEPOSIT', 'DEPOSIT_REFUND'].includes(String(transaction_type || '').toUpperCase())) {
    return res.status(400).json({
      status: 'ERROR',
      code: 'DEPOSIT_ENDPOINT_REQUIRED',
      message: 'Deposit cash movements must use the canonical deposit endpoints.'
    });
  }

  if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
  }
  const propertyId = Number(propertyIdRaw);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
  }

  const paymentAmount = Number(amount);
  if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'amount must be greater than zero' });
  }
  if (!Number.isInteger(paymentAmount)) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'amount must be an integer (IDR currency does not support decimal amounts)' });
  }

  // Front Office HTTP endpoint unconditionally requires evidence:
  // External callers cannot bypass this via any body parameter, header, or query parameter.
  if (!req.file) {
    return res.status(400).json({
      status: 'ERROR',
      code: 'PAYMENT_EVIDENCE_REQUIRED',
      message: 'Bukti pembayaran wajib dilampirkan untuk penerimaan pembayaran Front Office'
    });
  }

  try {
    const result = await createPaymentCore(pool, {
      propertyId,
      reservationId,
      amount: paymentAmount,
      paymentMethod: payment_method || 'CASH',
      referenceCode: reference_code || `TXN-${Date.now()}`,
      transactionType: transaction_type || 'PAYMENT',
      requireEvidence: true,
      file: req.file ? {
        buffer: req.file.buffer,
        mimetype: req.file.mimetype,
        originalname: req.file.originalname,
        size: req.file.size
      } : null,
      evidenceType: evidence_type,
      evidenceNote: evidence_note || req.body.note || null,
      actorUserId: req.body.actor_user_id || req.body.actor_id || null,
      actorNameSnapshot: req.body.actor_name_snapshot || req.body.actor_name || req.body.created_by || null,
      actorRoleSnapshot: req.body.actor_role_snapshot || req.body.actor_role || null,
      correlationId: req.body.correlation_id || req.headers['x-correlation-id'] || null
    });

    return res.status(200).json({
      status: 'SUCCESS',
      data: {
        payment: result.payment,
        reservation: withReservationHotelDates(result.reservation),
        evidence: result.evidence
      }
    });
  } catch (err: any) {
    if (err?.statusCode) {
      const resp: any = { status: 'ERROR', code: err.code, message: err.message };
      if (err.details) resp.details = err.details;
      return res.status(err.statusCode).json(resp);
    }
    const message = String(err?.message || err);
    return res.status(500).json({ status: 'ERROR', message });
  }
});

app.post('/api/reservations/:id/payments/:paymentId/correct', handlePaymentUpload, async (req: any, res: any) => {
  const reservationId = Number(req.params.id);
  const paymentId = Number(req.params.paymentId);
  if (!Number.isInteger(reservationId) || reservationId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid reservation id' });
  }
  if (!Number.isInteger(paymentId) || paymentId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid payment id' });
  }

  const { property_id: propertyIdRaw, amount, payment_method, reason_code, reason_text, evidence_type, evidence_note } = req.body;

  if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
  }
  const propertyId = Number(propertyIdRaw);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
  }

  const correctedAmount = Number(amount);
  if (!Number.isFinite(correctedAmount) || correctedAmount <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'amount must be greater than zero' });
  }
  if (!Number.isInteger(correctedAmount)) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'amount must be an integer (IDR currency does not support decimal amounts)' });
  }

  const allowedReasons = ['WRONG_AMOUNT', 'WRONG_PAYMENT_METHOD', 'DUPLICATE_ENTRY', 'PAYMENT_CANCELLED', 'OTHER'];
  if (!reason_code || !allowedReasons.includes(String(reason_code))) {
    return res.status(400).json({
      status: 'ERROR',
      code: 'VALIDATION_ERROR',
      message: 'reason_code is required and must be one of: WRONG_AMOUNT, WRONG_PAYMENT_METHOD, DUPLICATE_ENTRY, PAYMENT_CANCELLED, OTHER'
    });
  }

  if (reason_code === 'OTHER' && (!reason_text || String(reason_text).trim() === '')) {
    return res.status(400).json({
      status: 'ERROR',
      code: 'VALIDATION_ERROR',
      message: 'reason_text is required when reason_code is OTHER'
    });
  }

  // Mandatory replacement evidence gate on Front Office correction:
  // A replacement money-in transaction MUST be accompanied by a fresh evidence file.
  // External clients cannot bypass this via any body parameter, header, or query parameter.
  if (!req.file) {
    return res.status(400).json({
      status: 'ERROR',
      code: 'PAYMENT_EVIDENCE_REQUIRED',
      message: 'Bukti pembayaran baru wajib dilampirkan untuk koreksi pembayaran Front Office'
    });
  }

  const fileValidation = validateEvidenceUpload(req.file);
  if (!fileValidation.valid) {
    return res.status(400).json({
      status: 'ERROR',
      code: fileValidation.code || 'INVALID_FILE',
      message: fileValidation.error || 'File bukti pembayaran tidak valid'
    });
  }

  const actor = req.body.actor_name_snapshot || req.body.actor_name || req.body.created_by || null;
  const actorId = req.body.actor_user_id || req.body.actor_id || null;
  const role = req.body.actor_role_snapshot || req.body.actor_role || null;
  const correlationId = req.body.correlation_id || req.headers['x-correlation-id'] || `corr_pay_corr_${paymentId}_${Date.now()}`;

  let savedStorageKey: string | null = null;
  const client = await pool.connect();
  try {
    const propCheck = await client.query('SELECT id FROM properties WHERE id = $1', [propertyId]);
    if ((propCheck.rowCount ?? 0) === 0) {
      return res.status(404).json({ status: 'ERROR', code: 'PROPERTY_NOT_FOUND', message: `property ${propertyId} not found` });
    }

    await client.query('BEGIN');

    const reservation = await client.query(`
      SELECT
        r.id,
        r.total_price,
        r.amount_paid,
        r.payment_status,
        r.booking_id,
        b.property_id AS booking_property_id
      FROM reservations r
      LEFT JOIN bookings b ON b.id = r.booking_id
      WHERE r.id = $1
      FOR UPDATE OF r
    `, [reservationId]);

    if (!hasRows(reservation)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', code: 'RESERVATION_NOT_FOUND', message: 'reservation not found' });
    }

    const bookingPropertyId = reservation.rows[0].booking_property_id;
    if (bookingPropertyId === null || bookingPropertyId === undefined) {
      await client.query('ROLLBACK');
      return res.status(422).json({ status: 'ERROR', code: 'RESERVATION_INTEGRITY_ERROR', message: 'Reservation lacks authoritative booking property ownership' });
    }

    if (Number(bookingPropertyId) !== propertyId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ status: 'ERROR', code: 'CROSS_PROPERTY_RESERVATION', message: 'Reservation belongs to a different property' });
    }

    const paymentRes = await client.query(
      `SELECT * FROM payment_transactions WHERE id = $1 AND reservation_id = $2 FOR UPDATE`,
      [paymentId, reservationId]
    );

    if (!hasRows(paymentRes)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', code: 'PAYMENT_NOT_FOUND', message: 'payment transaction not found' });
    }

    const originalPayment = paymentRes.rows[0];
    if (['DEPOSIT', 'DEPOSIT_REFUND'].includes(String(originalPayment.transaction_type || '').toUpperCase())) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        status: 'ERROR',
        code: 'DEPOSIT_CANONICAL_OPERATION_REQUIRED',
        message: 'Deposit cash movements must be corrected through the canonical deposit lifecycle.'
      });
    }
    if (originalPayment.status === 'CORRECTED' || originalPayment.status === 'VOIDED' || originalPayment.transaction_type === 'REVERSAL') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        status: 'ERROR',
        code: 'PAYMENT_ALREADY_REVERSED',
        message: 'Payment has already been corrected or voided, or is a reversal transaction'
      });
    }

    const oldAmount = Math.round(Number(originalPayment.amount || 0));
    const totalPrice = Math.round(Number(reservation.rows[0].total_price || 0));
    const currentPaid = Math.round(Number(reservation.rows[0].amount_paid || 0));
    const currentAppliedDeposit = Math.round(Number(reservation.rows[0].applied_deposit || 0));

    const resultingPaid = (currentPaid - oldAmount) + correctedAmount;
    const resultingEffectiveSettlement = resultingPaid + currentAppliedDeposit;
    if (resultingEffectiveSettlement > totalPrice) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        status: 'ERROR',
        code: 'OVERPAYMENT_NOT_ALLOWED',
        message: 'Nominal koreksi melebihi total tagihan reservasi',
        details: {
          corrected_amount: correctedAmount,
          resulting_paid: resultingPaid,
          applied_deposit: currentAppliedDeposit,
          total_price: totalPrice,
          maximum_allowed_payment: totalPrice - currentAppliedDeposit - (currentPaid - oldAmount)
        }
      });
    }

    const resultingRemaining = Math.max(0, totalPrice - resultingEffectiveSettlement);
    const resultingPaymentStatus = resultingEffectiveSettlement <= 0 ? 'UNPAID' : resultingRemaining === 0 ? 'PAID' : 'PARTIAL';

    // 1. Mark original payment as CORRECTED
    await client.query(
      `UPDATE payment_transactions SET status = 'CORRECTED' WHERE id = $1`,
      [paymentId]
    );

    // 2. Insert compensating REVERSAL
    const reversal = await client.query(
      `INSERT INTO payment_transactions (
        reservation_id, transaction_type, amount, payment_method, reference_code,
        status, reference_payment_id, correction_group_id, reason_code, reason_text, created_by
      ) VALUES (
        $1, 'REVERSAL', $2, $3, $4,
        'SUCCESS', $5, $6, $7, $8, $9
      ) RETURNING *`,
      [
        reservationId,
        oldAmount,
        originalPayment.payment_method || 'CASH',
        `REV-${paymentId}-${Date.now()}`,
        paymentId,
        correlationId,
        reason_code,
        reason_text || null,
        actor
      ]
    );

    // 3. Insert replacement CORRECTION_REPLACEMENT
    const chosenMethod = payment_method || originalPayment.payment_method || 'CASH';
    const replacement = await client.query(
      `INSERT INTO payment_transactions (
        reservation_id, transaction_type, amount, payment_method, reference_code,
        status, reference_payment_id, correction_group_id, reason_code, reason_text, created_by
      ) VALUES (
        $1, 'CORRECTION_REPLACEMENT', $2, $3, $4,
        'SUCCESS', $5, $6, $7, $8, $9
      ) RETURNING *`,
      [
        reservationId,
        correctedAmount,
        chosenMethod,
        `REPL-${paymentId}-${Date.now()}`,
        paymentId,
        correlationId,
        reason_code,
        reason_text || null,
        actor
      ]
    );
    const replacementRow = replacement.rows[0];

    // 4. Save replacement evidence file to private storage and insert evidence record
    const savedEvidence = await saveEvidenceFile(propertyId, req.file);
    savedStorageKey = savedEvidence.storageKey;

    const defaultEvType = chosenMethod === 'BANK_TRANSFER' ? 'BANK_TRANSFER' : chosenMethod === 'QRIS' ? 'QRIS_RECEIPT' : chosenMethod === 'CARD' ? 'EDC_SLIP' : 'CASH_RECEIPT';
    const evType = evidence_type || defaultEvType;
    const evInsert = await client.query(
      `INSERT INTO payment_evidences (
         property_id, reservation_id, payment_transaction_id,
         evidence_type, storage_key, original_filename,
         mime_type, file_size_bytes, note, is_active,
         uploaded_by_user_id, uploaded_by_name_snapshot, uploaded_by_role_snapshot, uploaded_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10, $11, $12, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        propertyId,
        reservationId,
        replacementRow.id,
        evType,
        savedEvidence.storageKey,
        req.file.originalname,
        req.file.mimetype,
        savedEvidence.fileSizeBytes,
        evidence_note || req.body.note || `Bukti pembayaran koreksi #${paymentId}`,
        actorId,
        actor,
        role
      ]
    );
    const replacementEvidenceRow = evInsert.rows[0];

    const evidenceAuditPayload = {
      event: 'PAYMENT_EVIDENCE_UPLOADED',
      evidence_id: replacementEvidenceRow.id,
      payment_transaction_id: replacementRow.id,
      reservation_id: reservationId,
      property_id: propertyId,
      evidence_type: evType,
      original_filename: req.file.originalname,
      mime_type: req.file.mimetype,
      file_size_bytes: savedEvidence.fileSizeBytes,
      actor_user_id: actorId,
      actor_name_snapshot: actor,
      actor_role_snapshot: role,
      correlation_id: correlationId,
      timestamp: new Date().toISOString()
    };
    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ('PAYMENT', 'PAYMENT_EVIDENCE_UPLOADED', 'RESERVATION', $1, $2, $3, $4)`,
      [String(reservationId), JSON.stringify(evidenceAuditPayload), correlationId, propertyId]
    );

    // 5. Folio entries (reversal DEBIT + replacement CREDIT)
    await client.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, description, amount, direction)
       VALUES ($1, $2, 'PAYMENT_REVERSAL', $3, $4, 'DEBIT')`,
      [reservationId, propertyId, `Pembatalan pembayaran #${paymentId} (koreksi)`, oldAmount]
    );

    await client.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, description, amount, direction)
       VALUES ($1, $2, 'PAYMENT', $3, $4, 'CREDIT')`,
      [reservationId, propertyId, `Pembayaran pengganti (koreksi #${paymentId})`, correctedAmount]
    );

    // 6. Update reservation
    const updated = await client.query(
      `UPDATE reservations SET amount_paid = $1, applied_deposit = $2, remaining_balance = $3, payment_status = $4 WHERE id = $5 RETURNING *`,
      [resultingPaid, currentAppliedDeposit, resultingRemaining, resultingPaymentStatus, reservationId]
    );

    // 7. Audit log
    const auditPayload = {
      event: 'PAYMENT_CORRECTED',
      property_id: propertyId,
      reservation_id: reservationId,
      payment_id: paymentId,
      original_payment_id: paymentId,
      reversal_payment_id: reversal.rows[0].id,
      replacement_payment_id: replacementRow.id,
      old_amount: oldAmount,
      new_amount: correctedAmount,
      old_payment_method: originalPayment.payment_method,
      new_payment_method: chosenMethod,
      reason_code: reason_code,
      reason_text: reason_text || null,
      actor_user_id: actorId,
      actor_id: actorId,
      actor_name_snapshot: actor,
      actor_name: actor,
      actor_role_snapshot: role,
      actor_role: role,
      correlation_id: correlationId,
      has_replacement_evidence: !!replacementEvidenceRow,
      replacement_evidence_id: replacementEvidenceRow ? replacementEvidenceRow.id : null,
      created_at: new Date().toISOString(),
      timestamp: new Date().toISOString()
    };
    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ('PAYMENT', 'PAYMENT_CORRECTED', 'RESERVATION', $1, $2, $3, $4)`,
      [String(reservationId), JSON.stringify(auditPayload), correlationId, propertyId]
    );

    await client.query('COMMIT');
    res.json({
      status: 'SUCCESS',
      data: {
        original_payment_id: paymentId,
        reversal: reversal.rows[0],
        replacement: replacementRow,
        reservation: withReservationHotelDates(updated.rows[0]),
        replacement_evidence: replacementEvidenceRow ? toEvidenceMetadata(replacementEvidenceRow) : null
      }
    });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    if (savedStorageKey) {
      await deleteEvidenceFile(savedStorageKey).catch(() => {});
    }
    res.status(500).json({ status: 'ERROR', message: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/reservations/:id/payments/:paymentId/void', async (req, res) => {
  const reservationId = Number(req.params.id);
  const paymentId = Number(req.params.paymentId);
  if (!Number.isInteger(reservationId) || reservationId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid reservation id' });
  }
  if (!Number.isInteger(paymentId) || paymentId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid payment id' });
  }

  const { property_id: propertyIdRaw, reason_code, reason_text, actor_name, actor_id, actor_role } = req.body;

  if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
  }
  const propertyId = Number(propertyIdRaw);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
  }

  const allowedReasons = ['WRONG_AMOUNT', 'WRONG_PAYMENT_METHOD', 'DUPLICATE_ENTRY', 'PAYMENT_CANCELLED', 'OTHER'];
  if (!reason_code || !allowedReasons.includes(String(reason_code))) {
    return res.status(400).json({
      status: 'ERROR',
      code: 'VALIDATION_ERROR',
      message: 'reason_code is required and must be one of: WRONG_AMOUNT, WRONG_PAYMENT_METHOD, DUPLICATE_ENTRY, PAYMENT_CANCELLED, OTHER'
    });
  }

  if (reason_code === 'OTHER' && (!reason_text || String(reason_text).trim() === '')) {
    return res.status(400).json({
      status: 'ERROR',
      code: 'VALIDATION_ERROR',
      message: 'reason_text is required when reason_code is OTHER'
    });
  }

  const actor = req.body.actor_name_snapshot || req.body.actor_name || req.body.created_by || null;
  const actorId = req.body.actor_user_id || req.body.actor_id || null;
  const role = req.body.actor_role_snapshot || req.body.actor_role || null;
  const correlationId = req.body.correlation_id || req.headers['x-correlation-id'] || `corr_pay_void_${paymentId}_${Date.now()}`;

  const client = await pool.connect();
  try {
    const propCheck = await client.query('SELECT id FROM properties WHERE id = $1', [propertyId]);
    if ((propCheck.rowCount ?? 0) === 0) {
      return res.status(404).json({ status: 'ERROR', code: 'PROPERTY_NOT_FOUND', message: `property ${propertyId} not found` });
    }

    await client.query('BEGIN');

    const reservation = await client.query(`
      SELECT
        r.id,
        r.total_price,
        r.amount_paid,
        r.payment_status,
        r.booking_id,
        b.property_id AS booking_property_id
      FROM reservations r
      LEFT JOIN bookings b ON b.id = r.booking_id
      WHERE r.id = $1
      FOR UPDATE OF r
    `, [reservationId]);

    if (!hasRows(reservation)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', code: 'RESERVATION_NOT_FOUND', message: 'reservation not found' });
    }

    const bookingPropertyId = reservation.rows[0].booking_property_id;
    if (bookingPropertyId === null || bookingPropertyId === undefined) {
      await client.query('ROLLBACK');
      return res.status(422).json({ status: 'ERROR', code: 'RESERVATION_INTEGRITY_ERROR', message: 'Reservation lacks authoritative booking property ownership' });
    }

    if (Number(bookingPropertyId) !== propertyId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ status: 'ERROR', code: 'CROSS_PROPERTY_RESERVATION', message: 'Reservation belongs to a different property' });
    }

    const paymentRes = await client.query(
      `SELECT * FROM payment_transactions WHERE id = $1 AND reservation_id = $2 FOR UPDATE`,
      [paymentId, reservationId]
    );

    if (!hasRows(paymentRes)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'ERROR', code: 'PAYMENT_NOT_FOUND', message: 'payment transaction not found' });
    }

    const originalPayment = paymentRes.rows[0];
    if (['DEPOSIT', 'DEPOSIT_REFUND'].includes(String(originalPayment.transaction_type || '').toUpperCase())) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        status: 'ERROR',
        code: 'DEPOSIT_CANONICAL_OPERATION_REQUIRED',
        message: 'Deposit cash movements must be voided through the canonical deposit lifecycle.'
      });
    }
    if (originalPayment.status === 'CORRECTED' || originalPayment.status === 'VOIDED' || originalPayment.transaction_type === 'REVERSAL') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        status: 'ERROR',
        code: 'PAYMENT_ALREADY_REVERSED',
        message: 'Payment has already been corrected or voided, or is a reversal transaction'
      });
    }

    const oldAmount = Math.round(Number(originalPayment.amount || 0));
    const totalPrice = Math.round(Number(reservation.rows[0].total_price || 0));
    const currentPaid = Math.round(Number(reservation.rows[0].amount_paid || 0));
    const currentAppliedDeposit = Math.round(Number(reservation.rows[0].applied_deposit || 0));

    const resultingPaid = Math.max(0, currentPaid - oldAmount);
    const resultingEffectiveSettlement = resultingPaid + currentAppliedDeposit;
    const resultingRemaining = Math.max(0, totalPrice - resultingEffectiveSettlement);
    const resultingPaymentStatus = resultingEffectiveSettlement <= 0 ? 'UNPAID' : resultingRemaining === 0 ? 'PAID' : 'PARTIAL';

    // 1. Mark original payment as VOIDED
    await client.query(
      `UPDATE payment_transactions SET status = 'VOIDED' WHERE id = $1`,
      [paymentId]
    );

    // 2. Insert compensating REVERSAL
    const reversal = await client.query(
      `INSERT INTO payment_transactions (
        reservation_id, transaction_type, amount, payment_method, reference_code,
        status, reference_payment_id, correction_group_id, reason_code, reason_text, created_by
      ) VALUES (
        $1, 'REVERSAL', $2, $3, $4,
        'SUCCESS', $5, $6, $7, $8, $9
      ) RETURNING *`,
      [
        reservationId,
        oldAmount,
        originalPayment.payment_method || 'CASH',
        `REV-${paymentId}-${Date.now()}`,
        paymentId,
        correlationId,
        reason_code,
        reason_text || null,
        actor
      ]
    );

    // 3. Folio entry (reversal DEBIT)
    await client.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, description, amount, direction)
       VALUES ($1, $2, 'PAYMENT_VOID', $3, $4, 'DEBIT')`,
      [reservationId, propertyId, `Pembatalan pembayaran #${paymentId}`, oldAmount]
    );

    // 4. Update reservation
    const updated = await client.query(
      `UPDATE reservations SET amount_paid = $1, applied_deposit = $2, remaining_balance = $3, payment_status = $4 WHERE id = $5 RETURNING *`,
      [resultingPaid, currentAppliedDeposit, resultingRemaining, resultingPaymentStatus, reservationId]
    );

    // 5. Audit log
    const auditPayload = {
      event: 'PAYMENT_VOIDED',
      property_id: propertyId,
      reservation_id: reservationId,
      payment_id: paymentId,
      original_payment_id: paymentId,
      reversal_payment_id: reversal.rows[0].id,
      amount: oldAmount,
      payment_method: originalPayment.payment_method,
      reason_code: reason_code,
      reason_text: reason_text || null,
      actor_user_id: actorId,
      actor_id: actorId,
      actor_name_snapshot: actor,
      actor_name: actor,
      actor_role_snapshot: role,
      actor_role: role,
      correlation_id: correlationId,
      created_at: new Date().toISOString(),
      timestamp: new Date().toISOString()
    };
    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ('PAYMENT', 'PAYMENT_VOIDED', 'RESERVATION', $1, $2, $3, $4)`,
      [String(reservationId), JSON.stringify(auditPayload), correlationId, propertyId]
    );

    await client.query('COMMIT');
    res.json({
      status: 'SUCCESS',
      data: {
        original_payment_id: paymentId,
        reversal: reversal.rows[0],
        reservation: withReservationHotelDates(updated.rows[0])
      }
    });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ status: 'ERROR', message: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/reservations/:id/folio', async (req, res) => {
  const reservationId = Number(req.params.id);
  if (!Number.isInteger(reservationId) || reservationId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid reservation id' });
  }

  const propertyIdRaw = req.query.property_id;
  if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
  }
  const propertyId = Number(propertyIdRaw);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
  }

  try {
    const propCheck = await pool.query('SELECT id FROM properties WHERE id = $1', [propertyId]);
    if ((propCheck.rowCount ?? 0) === 0) {
      return res.status(404).json({ status: 'ERROR', code: 'PROPERTY_NOT_FOUND', message: `property ${propertyId} not found` });
    }

    const reservation = await pool.query(`
      SELECT
        r.*,
        r.id as reservation_id,
        r.booking_number as legacy_booking_number,
        b.bid,
        b.id as booking_id_value,
        b.property_id as booking_property_id
      FROM reservations r
      LEFT JOIN bookings b ON b.id = r.booking_id
      WHERE r.id = $1
    `, [reservationId]);

    if (!hasRows(reservation)) {
      return res.status(404).json({ status: 'ERROR', code: 'RESERVATION_NOT_FOUND', message: 'reservation not found' });
    }

    const bookingPropertyId = reservation.rows[0].booking_property_id;
    if (bookingPropertyId === null || bookingPropertyId === undefined) {
      return res.status(422).json({ status: 'ERROR', code: 'RESERVATION_INTEGRITY_ERROR', message: 'Reservation lacks authoritative booking property ownership' });
    }

    if (Number(bookingPropertyId) !== propertyId) {
      return res.status(403).json({ status: 'ERROR', code: 'CROSS_PROPERTY_RESERVATION', message: 'Reservation belongs to a different property' });
    }

    const payments = await pool.query('SELECT * FROM payment_transactions WHERE reservation_id = $1 ORDER BY id DESC', [reservationId]);
    const folio = await pool.query('SELECT * FROM folio_entries WHERE reservation_id = $1 ORDER BY id DESC', [reservationId]);
    const evidences = await pool.query(
      'SELECT * FROM payment_evidences WHERE reservation_id = $1 AND property_id = $2 ORDER BY id DESC',
      [reservationId, propertyId]
    );

    res.json({
      status: 'OK',
      data: {
        reservation: withReservationHotelDates(reservation.rows[0]),
        payments: payments.rows,
        folio: folio.rows,
        entries: folio.rows,
        evidences: evidences.rows.map(toEvidenceMetadata)
      }
    });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

// ─── PAYMENT EVIDENCE ENDPOINTS ───────────────────────────────────────────────

app.post(
  '/api/reservations/:id/payments/:paymentId/evidences',
  (req: any, res: any, next: any) => {
    memoryUpload.single('file')(req, res, (err: any) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            status: 'ERROR',
            code: 'FILE_TOO_LARGE',
            message: 'Ukuran file melebihi batas maksimum 10 MB'
          });
        }
        return res.status(400).json({
          status: 'ERROR',
          code: 'UPLOAD_ERROR',
          message: err.message || 'Error saat memproses file unggahan'
        });
      }
      next();
    });
  },
  async (req: any, res: any) => {
    const reservationId = Number(req.params.id);
    const paymentId = Number(req.params.paymentId);
    if (!Number.isInteger(reservationId) || reservationId <= 0) {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid reservation id' });
    }
    if (!Number.isInteger(paymentId) || paymentId <= 0) {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid payment id' });
    }

    const propertyIdRaw = req.body?.property_id ?? req.query?.property_id;
    if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
    }
    const propertyId = Number(propertyIdRaw);
    if (!Number.isInteger(propertyId) || propertyId <= 0) {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ status: 'ERROR', code: 'FILE_REQUIRED', message: 'File bukti pembayaran wajib diunggah' });
    }

    const evidenceType = (req.body?.evidence_type || 'BANK_TRANSFER') as PaymentEvidenceType;
    const note = req.body?.note || null;
    const actorName = req.body?.actor_name_snapshot || req.body?.actor_name || req.body?.created_by || null;
    const actorId = req.body?.actor_user_id || req.body?.actor_id || null;
    const actorRole = req.body?.actor_role_snapshot || req.body?.actor_role || null;
    const corrId = req.body?.correlation_id || req.headers['x-correlation-id'] || `corr_evid_${Date.now()}`;

    try {
      const evidence = await uploadPaymentEvidence(pool, {
        propertyId,
        reservationId,
        paymentId,
        evidenceType,
        note,
        file: {
          mimetype: file.mimetype,
          size: file.size,
          originalname: file.originalname || 'evidence',
          buffer: file.buffer
        },
        actorUserId: actorId,
        actorNameSnapshot: actorName,
        actorRoleSnapshot: actorRole,
        correlationId: corrId
      });

      return res.status(201).json({
        status: 'SUCCESS',
        data: { evidence }
      });
    } catch (err: any) {
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err.code || 'INTERNAL_ERROR',
        message: err.message
      });
    }
  }
);

app.get('/api/reservations/:id/payments/:paymentId/evidences', async (req: any, res: any) => {
  const reservationId = Number(req.params.id);
  const paymentId = Number(req.params.paymentId);
  if (!Number.isInteger(reservationId) || reservationId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid reservation id' });
  }
  if (!Number.isInteger(paymentId) || paymentId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid payment id' });
  }

  const propertyIdRaw = req.query.property_id;
  if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
  }
  const propertyId = Number(propertyIdRaw);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
  }

  const includeInactive = req.query.include_inactive !== 'false';

  try {
    const evidences = await getPaymentEvidences(pool, propertyId, reservationId, paymentId, includeInactive);
    return res.json({
      status: 'OK',
      data: evidences
    });
  } catch (err: any) {
    const statusCode = err.statusCode || 500;
    return res.status(statusCode).json({
      status: 'ERROR',
      code: err.code || 'INTERNAL_ERROR',
      message: err.message
    });
  }
});

app.get('/api/reservations/:id/payments/:paymentId/evidences/:evidenceId', async (req: any, res: any) => {
  const reservationId = Number(req.params.id);
  const paymentId = Number(req.params.paymentId);
  const evidenceId = Number(req.params.evidenceId);
  if (!Number.isInteger(reservationId) || reservationId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid reservation id' });
  }
  if (!Number.isInteger(paymentId) || paymentId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid payment id' });
  }
  if (!Number.isInteger(evidenceId) || evidenceId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid evidence id' });
  }

  const propertyIdRaw = req.query.property_id;
  if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
  }
  const propertyId = Number(propertyIdRaw);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
  }

  try {
    const row = await getEvidenceRowById(pool, propertyId, reservationId, paymentId, evidenceId);
    return res.json({
      status: 'OK',
      data: toEvidenceMetadata(row)
    });
  } catch (err: any) {
    const statusCode = err.statusCode || 500;
    return res.status(statusCode).json({
      status: 'ERROR',
      code: err.code || 'INTERNAL_ERROR',
      message: err.message
    });
  }
});

app.get('/api/reservations/:id/payments/:paymentId/evidences/:evidenceId/content', async (req: any, res: any) => {
  const reservationId = Number(req.params.id);
  const paymentId = Number(req.params.paymentId);
  const evidenceId = Number(req.params.evidenceId);
  if (!Number.isInteger(reservationId) || reservationId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid reservation id' });
  }
  if (!Number.isInteger(paymentId) || paymentId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid payment id' });
  }
  if (!Number.isInteger(evidenceId) || evidenceId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid evidence id' });
  }

  const propertyIdRaw = req.query.property_id;
  if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
  }
  const propertyId = Number(propertyIdRaw);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
  }

  const isDownload = req.query.download === '1' || req.query.download === 'true';
  const actorName = req.query.actor_name_snapshot || req.query.actor_name || null;
  const actorId = req.query.actor_user_id || req.query.actor_id || null;
  const actorRole = req.query.actor_role_snapshot || req.query.actor_role || null;
  const corrId = req.query.correlation_id || req.headers['x-correlation-id'] || `corr_view_${Date.now()}`;

  try {
    const row = await getEvidenceRowById(pool, propertyId, reservationId, paymentId, evidenceId);

    // Audit log
    await recordEvidenceAccessAudit(pool, {
      propertyId,
      reservationId,
      paymentId,
      evidenceId,
      action: isDownload ? 'PAYMENT_EVIDENCE_DOWNLOADED' : 'PAYMENT_EVIDENCE_VIEWED',
      actorUserId: actorId,
      actorNameSnapshot: actorName,
      actorRoleSnapshot: actorRole,
      correlationId: corrId
    });

    const disposition = isDownload
      ? `attachment; filename="${encodeURIComponent(row.original_filename)}"`
      : `inline; filename="${encodeURIComponent(row.original_filename)}"`;

    res.setHeader('Content-Type', row.mime_type);
    res.setHeader('Content-Disposition', disposition);
    res.setHeader('Content-Length', row.file_size_bytes);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');

    const stream = createEvidenceReadStream(row.storage_key);
    stream.pipe(res);
  } catch (err: any) {
    const statusCode = err.statusCode || 500;
    return res.status(statusCode).json({
      status: 'ERROR',
      code: err.code || 'INTERNAL_ERROR',
      message: err.message
    });
  }
});

app.post('/api/reservations/:id/payments/:paymentId/evidences/:evidenceId/deactivate', async (req: any, res: any) => {
  const reservationId = Number(req.params.id);
  const paymentId = Number(req.params.paymentId);
  const evidenceId = Number(req.params.evidenceId);
  if (!Number.isInteger(reservationId) || reservationId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid reservation id' });
  }
  if (!Number.isInteger(paymentId) || paymentId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid payment id' });
  }
  if (!Number.isInteger(evidenceId) || evidenceId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid evidence id' });
  }

  const propertyIdRaw = req.body?.property_id ?? req.query?.property_id;
  if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
  }
  const propertyId = Number(propertyIdRaw);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
  }

  const { reason, actor_name, actor_id, actor_role, correlation_id } = req.body || {};
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ status: 'ERROR', code: 'DEACTIVATION_REASON_REQUIRED', message: 'Alasan penonaktifan bukti pembayaran wajib diisi' });
  }

  const actorName = req.body?.actor_name_snapshot || actor_name || req.body?.created_by || null;
  const actorUserId = req.body?.actor_user_id || actor_id || null;
  const actorRole = req.body?.actor_role_snapshot || actor_role || null;
  const corrId = correlation_id || req.headers['x-correlation-id'] || `corr_deact_${Date.now()}`;

  try {
    const updated = await deactivateEvidence(pool, {
      propertyId,
      reservationId,
      paymentId,
      evidenceId,
      reason: String(reason).trim(),
      actorUserId,
      actorNameSnapshot: actorName,
      actorRoleSnapshot: actorRole,
      correlationId: corrId
    });

    return res.status(200).json({
      status: 'SUCCESS',
      data: { evidence: updated }
    });
  } catch (err: any) {
    const statusCode = err.statusCode || 500;
    return res.status(statusCode).json({
      status: 'ERROR',
      code: err.code || 'INTERNAL_ERROR',
      message: err.message
    });
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

// Property management routes (CRUD + list)
app.use('/api/properties', createPropertiesRouter(pool));

// Property branding, features & front office settings routes
app.use('/api/properties', createPropertyBrandingRouter(pool));
app.use('/api/properties', createFeatureRouter(pool));
app.use('/api/properties', createFrontOfficeSettingsRouter(pool));
app.use('/api/front-office', createFrontOfficeSettingsRouter(pool));

// RM-1C Room Master domain routes (mounted after all legacy /api/rooms registrations)
app.use('/api/room-categories', createRoomCategoriesRouter(pool));
app.use('/api/room-types', createRoomTypesRouter(pool));
app.use('/api/rooms', createRoomsRouter(pool));
app.use('/api/reports', createReportsRouter(pool));
app.use('/api/room-operational-blocks', createRoomOperationalBlocksRouter(pool));
app.use('/api/guests', createGuestsRouter(pool));
app.use('/api/reservations', createReservationGuestsRouter(pool));
app.use('/api', createRoomMoveRouter(pool));
app.use('/api/housekeeping', createHousekeepingRouter(pool));
app.use('/api/attendance', createAttendanceRouter(pool));
app.use('/api/hrd', createHrdRouter(pool));
app.use('/api/pricing', createPricingRouter(pool));
app.use('/api/stay-charges', createStayChargesRouter(pool));
app.use('/api/transactions', createTransactionsRouter(pool));
app.use('/api/suppliers', createSuppliersRouter(pool));
app.use('/api/ota-sources', createOtaRouter(pool));
app.use('/api/identity', createIdentityExtractionRouter(pool, uploadDir));
app.use('/api/ocr', createIdentityExtractionRouter(pool, uploadDir));
app.use('/api', createDepositRouter(pool));
app.use('/api', createIdentityCustodyRouter(pool));
app.use('/api/auth', createAuthRouter(pool));
app.use('/api/users', createUsersRouter(pool));
app.use('/api/settings/role-permissions', createRolePermissionsRouter(pool));
app.use('/api/hrd/role-permissions', createRolePermissionsRouter(pool));



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
             AND NOT (check_out < $2::timestamp OR check_in >= $3::timestamp)`,
          [roomIds, start, end]
        )
      : { rows: [] as any[] };
    const reservations = reservationsRes.rows;

    // fetch room operational blocks overlapping range (CALENDAR-UX-1)
    const blocksRes = roomIds.length > 0
      ? await pool.query(
          `SELECT b.id, b.property_id, b.room_id, b.room_type_id,
                  b.block_type, to_char(b.start_date, 'YYYY-MM-DD') AS start_date,
                  to_char(b.end_date, 'YYYY-MM-DD') AS end_date,
                  b.reason, b.maintenance_task_id, b.status,
                  b.created_by, b.created_at, b.released_by, b.released_at
           FROM room_operational_blocks b
           WHERE b.room_id = ANY($1::int[])
             AND b.status = 'ACTIVE'
             AND NOT (b.end_date <= $2::date OR b.start_date >= $3::date)
           ORDER BY b.start_date ASC, b.id ASC`,
          [roomIds, start, end]
        )
      : { rows: [] as any[] };
    const operationalBlocks = blocksRes.rows;

    const operationalBlocksByRoom: Record<string, any[]> = {};
    for (const b of operationalBlocks) {
      const rid = String(b.room_id);
      if (!operationalBlocksByRoom[rid]) operationalBlocksByRoom[rid] = [];
      operationalBlocksByRoom[rid].push(b);
    }

    // fetch active blocking findings for rooms (CALENDAR-UX-1)
    const blockingFindingsRes = roomIds.length > 0
      ? await pool.query(
          `SELECT f.id, f.room_id, f.finding_type_code, f.finding_type_label,
                  f.severity, f.notes, f.created_at, ft.block_room_ready
           FROM housekeeping_task_findings f
           JOIN housekeeping_finding_types ft ON ft.id = f.finding_type_id
           WHERE f.room_id = ANY($1::int[])
             AND f.status = 'ACTIVE'
             AND ft.block_room_ready = TRUE
           ORDER BY f.id DESC`,
          [roomIds]
        )
      : { rows: [] as any[] };
    const blockingFindings = blockingFindingsRes.rows;

    const blockingFindingsByRoom: Record<string, any[]> = {};
    for (const f of blockingFindings) {
      const rid = String(f.room_id);
      if (!blockingFindingsByRoom[rid]) blockingFindingsByRoom[rid] = [];
      blockingFindingsByRoom[rid].push(f);
    }

    // fetch checkout inspections for turnover context
    const resIds = reservations.map((r: any) => Number(r.id)).filter(Boolean);
    const checkoutInspectionsRes = resIds.length > 0
      ? await pool.query(
          `SELECT id, reservation_id, status, inspection_result, issue_type, issue_note, estimated_charge
           FROM housekeeping_tasks
           WHERE property_id = $1 AND task_type = 'CHECKOUT_ROOM_CHECK' AND reservation_id = ANY($2::int[])
           ORDER BY id DESC`,
          [propertyId, resIds]
        )
      : { rows: [] as any[] };

    const checkoutInspectionByRes = new Map<number, any>();
    for (const row of checkoutInspectionsRes.rows) {
      const rid = Number(row.reservation_id);
      if (!checkoutInspectionByRes.has(rid)) {
        let clearanceState = 'REQUESTED';
        if (row.status === 'IN_PROGRESS') clearanceState = 'INSPECTING';
        else if (row.status === 'DONE' || row.status === 'VERIFIED') {
          clearanceState = row.inspection_result === 'ISSUE_FOUND' ? 'ISSUE_FOUND' : 'CLEAR';
        }
        checkoutInspectionByRes.set(rid, {
          task_id: row.id,
          status: row.status,
          clearance_state: clearanceState,
          inspection_result: row.inspection_result,
          issue_type: row.issue_type,
          issue_note: row.issue_note,
          estimated_charge: row.estimated_charge !== null ? Number(row.estimated_charge) : null
        });
      }
    }

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
        const allRoomRes = reservationsByRoom[String(room.id)] || [];
        // reservations for this room that cover this date (night stay)
        const resForRoom = allRoomRes.filter((r: any) => {
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

        // TURNOVER-1: departures and arrivals on this cell date
        const departures = allRoomRes.filter((r: any) => hotelDateKey(r.check_out) === dateStr);
        const arrivals = allRoomRes.filter((r: any) => hotelDateKey(r.check_in) === dateStr);

        let turnover: any = null;
        if (departures.length > 0 || arrivals.length > 0) {
          const outgoingRes = departures[0] || null;
          const incomingRes = arrivals[0] || null;

          const outgoingChk = outgoingRes ? checkoutInspectionByRes.get(Number(outgoingRes.id)) || null : null;
          const outgoing = outgoingRes ? {
            id: outgoingRes.id,
            guest_name: outgoingRes.guest_name,
            check_out: hotelDateKey(outgoingRes.check_out),
            checked_out_at: outgoingRes.checked_out_at ? new Date(outgoingRes.checked_out_at).toISOString() : null,
            status: outgoingRes.status,
            checkout_inspection: outgoingChk
          } : null;

          let incoming: any = null;
          if (incomingRes) {
            const isOutgoingInHouse = departures.some((dep: any) => String(dep.status).toUpperCase() === 'CHECKED_IN');
            const roomPhysical = normalizePhysicalRoomStatus(room.status);
            let isReady = false;
            let reasonCode: string | null = null;
            let reasonMessage: string | null = null;
            let state: TurnoverState = 'NONE';

            if (isOutgoingInHouse) {
              state = 'OUTGOING_OCCUPIED';
              reasonCode = 'OUTGOING_NOT_CHECKED_OUT';
              reasonMessage = 'Tamu sebelumnya belum check-out.';
            } else if (roomPhysical === 'VACANT_DIRTY' || roomPhysical === 'CLEANING') {
              state = 'CLEANING';
              reasonCode = 'HOUSEKEEPING_IN_PROGRESS';
              reasonMessage = 'Kamar sedang dipersiapkan Housekeeping.';
            } else if (roomPhysical === 'OUT_OF_ORDER' || roomPhysical === 'OUT_OF_SERVICE') {
              state = 'OUT_OF_SERVICE';
              reasonCode = 'ROOM_OUT_OF_SERVICE';
              reasonMessage = 'Kamar sedang dalam pemeliharaan (Out of Order / Out of Service).';
            } else if (isReadyPhysicalStatus(roomPhysical)) {
              state = 'READY';
              isReady = true;
            } else {
              state = 'NONE';
              reasonCode = 'ROOM_NOT_READY';
              reasonMessage = 'Kamar belum siap untuk check-in.';
            }

            incoming = {
              reservation_id: incomingRes.id,
              guest_name: incomingRes.guest_name,
              check_in: hotelDateKey(incomingRes.check_in),
              status: incomingRes.status,
              is_ready: isReady,
              reason_code: reasonCode,
              reason_message: reasonMessage
            };
          }

          let turnoverState: TurnoverState = 'NONE';
          if (incoming) {
            turnoverState = incoming.is_ready ? 'READY' : (outgoing?.status === 'CHECKED_IN' ? 'OUTGOING_OCCUPIED' : 'CLEANING');
          } else if (outgoing) {
            turnoverState = outgoing.status === 'CHECKED_IN' ? 'OUTGOING_OCCUPIED' : 'READY';
          }

          turnover = {
            has_turnover: departures.length > 0 && arrivals.length > 0,
            turnover_state: turnoverState,
            outgoing,
            incoming
          };
        }

        const allRoomBlocks = operationalBlocksByRoom[String(room.id)] || [];
        const blocksForCell = allRoomBlocks.filter((b: any) => {
          return dateStr >= b.start_date && dateStr < b.end_date;
        });

        // Canonical rooms never fall through to a duplicate display name.
        // Name lookup is compatibility-only for rooms without room_type_id.
        const availIdKey = room.room_type_id == null ? null : `id:${room.room_type_id}|${dateStr}`;
        const availNameKey = `name:${room.name}|${dateStr}`;
        const avail = availIdKey
          ? availabilityMap[availIdKey] || null
          : availabilityMap[availNameKey] || null;
        return {
          date: dateStr,
          reservations: resForRoom,
          operational_blocks: blocksForCell,
          departures: departures.map((r: any) => ({
            id: r.id,
            guest_name: r.guest_name,
            check_out: hotelDateKey(r.check_out),
            status: r.status
          })),
          arrivals: arrivals.map((r: any) => ({
            id: r.id,
            guest_name: r.guest_name,
            check_in: hotelDateKey(r.check_in),
            status: r.status
          })),
          turnover,
          availability: avail
        };
      });

      const roomBlocks = operationalBlocksByRoom[String(room.id)] || [];
      const roomBlockingFindings = blockingFindingsByRoom[String(room.id)] || [];

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
        operational_blocks: roomBlocks,
        blocking_findings: roomBlockingFindings,
        has_blocking_finding: roomBlockingFindings.length > 0,
        cells
      };
    });

    return res.json({ status: 'OK', start, end, rooms: resultRooms });
  } catch (err: any) {
    console.error('Error /api/tapechart', err);
    return res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

// SPA fallback for non-API client routes
if (fs.existsSync(frontendDist)) {
  app.get('*', (req: any, res: any, next: any) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) {
      return next();
    }
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

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
