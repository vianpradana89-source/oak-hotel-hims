/**
 * reservationCheckoutHandler.ts
 *
 * Extracted from index.ts lines 7865–8126.
 *
 * POST /api/reservations/:id/checkout
 *
 * Mechanical extraction: SQL, lock order, gates, responses, transaction
 * boundaries, inventory, housekeeping, audit, broadcast, and canonical DTO
 * are preserved exactly as in the original handler.
 *
 * The factory receives every external dependency explicitly so that tests
 * can substitute a disposable pool and no-op broadcast without importing
 * index.ts, dotenv, or starting a server.
 */

import type { Pool, PoolClient } from 'pg';
import type { Request, Response } from 'express';

// ── Simple helper (no external dependency) ─────────────────────────────────

const hasRows = (result: { rowCount?: number | null } | null | undefined): boolean =>
  Number(result?.rowCount ?? 0) > 0;

// ── Type for booking child status summary (used by deps signatures) ───────

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

// ── Dependency interface ────────────────────────────────────────────────────

/**
 * Explicit dependency bag for the checkout handler factory.
 *
 * Every helper the handler needs is listed here so that:
 *   - index.ts passes its own production instances (pool, services, etc.)
 *   - tests pass a disposable pool and no-op broadcast
 *   - the module does NOT import index.ts, read dotenv, create a pool,
 *     or run schema initialization
 */
export interface ReservationCheckoutDeps {
  /** The Pool used for pre-transaction checks and final canonical DTO read. */
  pool: Pool;

  /**
   * Connect a dedicated client for the transaction.
   * In production: `pool.connect()`.
   * In tests: may return a wrapped client that signals after lock
   * acquisition so the test can hold execution deterministically.
   */
  connect: () => Promise<PoolClient>;

  /**
   * Release a dedicated client back to the pool.
   * In production: `client.release()`.
   */
  release: (client: PoolClient) => void;

  /** Parse property_id from request body; throws on missing/invalid. */
  assertPropertyId: (body: any) => number;

  /** Verify property exists in DB; throws on missing. */
  assertPropertyExists: (pool: Pool, propertyId: number) => Promise<void>;

  /** Verify reservation belongs to the given property; throws on mismatch. */
  assertReservationBelongsToProperty: (pool: Pool, reservationId: number, propertyId: number) => Promise<void>;

  /**
   * Feature-flag gate.
   * Production: isFeatureEnabled(client, propertyId, key).
   */
  isFeatureEnabled: (client: PoolClient, propertyId: number, key: string) => Promise<boolean>;

  /** Housekeeping settings lookup. */
  getPropertyHousekeepingSettings: (client: PoolClient, propertyId: number) => Promise<any>;

  /** Create checkout room-cleaning task (no-op when housekeeping disabled). */
  ensureCheckoutRoomCleaningTask: (client: PoolClient, propertyId: number, roomId: number, reservationId: number) => Promise<any>;

  /**
   * Return HELD identity custody rows for the reservation.
   * Empty array = no blocking custody.
   */
  getHeldIdentityCustodyForCheckout: (client: PoolClient, propertyId: number, reservationId: number) => Promise<any[]>;

  /**
   * Authoritative folio recalculation.
   * Returns the canonical financial snapshot or null on unverifiable data.
   */
  recalculateReservationFinancials: (client: PoolClient, reservationId: number, propertyId: number) => Promise<any>;

  /**
   * Hotel-collectible balance with payment-responsibility filtering.
   */
  calculateHotelCollectibleBalance: (
    client: PoolClient,
    reservationId: number,
    propertyId: number,
    paymentResponsibility: any
  ) => Promise<any>;

  /**
   * Release type-night inventory consumed by the stay (RM-1B).
   */
  releaseReservationInventoryForCheckout: (client: PoolClient, payload: any) => Promise<void>;

  /**
   * Broadcast a realtime event (SSE / pg-notify fan-out).
   * No-op in tests. Never blocks the caller.
   */
  broadcastEvent: (eventType: string, payload: any, propertyId?: number) => void;

  /**
   * Read the canonical reservation DTO after COMMIT.
   * In production: calls getCanonicalReservationDto(pool, id).
   */
  getCanonicalReservationDto: (pool: Pool, reservationId: number) => Promise<any>;

  /**
   * Build a summary of reservation child statuses for a booking.
   * Production: buildBookingChildStatusSummary from index.ts.
   */
  buildBookingChildStatusSummary: (children: any[]) => BookingChildStatusSummary;

  /**
   * Derive the booking-level lifecycle status from child summary.
   * Production: deriveBookingLifecycleStatus from index.ts.
   */
  deriveBookingLifecycleStatus: (currentBookingStatus: any, summary: BookingChildStatusSummary) => 'ACTIVE' | 'CANCELLED' | 'COMPLETED';

  /**
   * Build the audit payload when a booking transitions to COMPLETED.
   * Production: buildBookingCompletionAuditPayload from index.ts.
   */
  buildBookingCompletionAuditPayload: (
    booking: any,
    previousStatus: string,
    newStatus: string,
    summary: BookingChildStatusSummary,
    triggerReservationId: number
  ) => any;

  /**
   * Normalize reservation row dates to hotel-date keys.
   * Production: withReservationHotelDates from index.ts.
   */
  withReservationHotelDates: <T extends Record<string, any>>(row: T) => T;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Creates the Express handler for POST /api/reservations/:id/checkout.
 *
 * The handler body is a mechanical copy of the original index.ts:7865–8126.
 * All external dependencies are injected through `deps`, so this module
 * has zero import-time side effects (no dotenv, no pool creation, no
 * schema initialization, no server startup).
 */
export function createReservationCheckoutHandler(deps: ReservationCheckoutDeps) {
  return async (req: Request, res: Response) => {
    const reservationId = Number(req.params.id);
    const client = await deps.connect();

    try {
      const propertyId = deps.assertPropertyId(req.body);
      await deps.assertPropertyExists(deps.pool, propertyId);
      await deps.assertReservationBelongsToProperty(deps.pool, reservationId, propertyId);

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
        if (!targetReservation.room_id) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            status: 'ERROR',
            code: 'ROOM_NOT_ASSIGNED',
            message: 'Kamar belum ditentukan untuk reservasi ini.'
          });
        }

        if (!targetReservation.booked_room_type_id_snapshot) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            status: 'ERROR',
            code: 'ROOM_TYPE_SNAPSHOT_MISSING',
            message: 'Data tipe kamar reservasi tidak lengkap. Silakan edit reservasi untuk menetapkan tipe kamar.'
          });
        }

        // Check mandatory checkout inspection policy
        const isHkEnabled = await deps.isFeatureEnabled(client, propertyId, 'housekeeping.enabled');
        const isCheckoutCheckFeature = isHkEnabled && (await deps.isFeatureEnabled(client, propertyId, 'housekeeping.checkout_inspection'));
        if (isCheckoutCheckFeature && !req.body?.skip_inspection && !req.body?.force) {
          const hkSettings = await deps.getPropertyHousekeepingSettings(client, propertyId);
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
        const heldIdentity = await deps.getHeldIdentityCustodyForCheckout(client, propertyId, reservationId);
        if (heldIdentity.length > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            status: 'ERROR',
            code: 'IDENTITY_CUSTODY_NOT_RETURNED',
            message: 'Dokumen identitas fisik masih ditahan hotel dan harus dikembalikan sebelum checkout.'
          });
        }

        // CHECKOUT-FOLIO-GATE-1B: Authoritative folio balance verification.
        // Must pass before any status mutation. Fail-closed on unverifiable data.
        const folioFinancial = await deps.recalculateReservationFinancials(client, reservationId, propertyId);
        const hotelCollectible = await deps.calculateHotelCollectibleBalance(
          client,
          reservationId,
          propertyId,
          booking.payment_responsibility
        );
        const validatedBalance = Number(hotelCollectible?.hotel_collectible_remaining_balance);
        if (!folioFinancial || !hotelCollectible || !Number.isFinite(validatedBalance)) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            status: 'ERROR',
            code: 'FOLIO_BALANCE_UNVERIFIED',
            message: 'Data keuangan reservasi tidak dapat diverifikasi. Silakan periksa folio terlebih dahulu sebelum check-out.'
          });
        }
        if (validatedBalance > 0.01) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            status: 'ERROR',
            code: 'FOLIO_BALANCE_OUTSTANDING',
            message: 'Tagihan reservasi belum lunas. Selesaikan sisa tagihan pada folio sebelum check-out.',
            remaining_balance: validatedBalance,
          });
        }

        // POS OPEN ORDERS GUARD:
        // Block checkout while any OPEN pos_orders exist for this reservation.
        // Plain EXISTS read (no FOR UPDATE on pos_orders) — the checkout
        // transaction already holds the bookings + reservations row locks,
        // which is the authoritative coordination point with POS create
        // (once POS create takes the same locks).
        const openPosCheck = await client.query(
          `SELECT EXISTS (
             SELECT 1 FROM pos_orders
             WHERE property_id = $1
               AND reservation_id = $2
               AND UPPER(status) = 'OPEN'
           ) AS has_open`,
          [propertyId, targetReservationId]
        );
        if (openPosCheck.rows[0]?.has_open) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            status: 'ERROR',
            code: 'POS_OPEN_ORDERS_BLOCK_CHECKOUT',
            message: 'Masih ada pesanan POS yang belum diselesaikan pada reservasi ini. Hubungi petugas POS untuk menyelesaikan pesanan sebelum check-out.'
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
          await deps.releaseReservationInventoryForCheckout(client, {
            ...checkoutReservation,
            current_room_type_id: roomTypeResult.rows[0].room_type_id
          });
        }

        await client.query(
          'UPDATE rooms SET status = $1 WHERE id = $2',
          ['VACANT_DIRTY', currentRoomId]
        );

        await deps.ensureCheckoutRoomCleaningTask(client, propertyId, currentRoomId, reservationId);

        await client.query(
          `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          ['PMS', 'CHECK_OUT', 'RESERVATION', reservationId, JSON.stringify(deps.withReservationHotelDates(checkoutReservation)), req.headers['x-correlation-id'] || null, propertyId]
        );
        lockedChildren[lockedChildren.findIndex((row: any) => Number(row.id) === targetReservationId)] = checkoutReservation;
      }

      const childSummary = deps.buildBookingChildStatusSummary(lockedChildren);
      const derivedBookingStatus = deps.deriveBookingLifecycleStatus(bookingStatusBefore, childSummary);
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
          bookingCompletionAuditPayload = deps.buildBookingCompletionAuditPayload(
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
        deps.broadcastEvent('ReservationCheckedOut', {
          reservation_id: reservationId,
          room_id: checkoutReservation.room_id,
          guest_name: checkoutReservation.guest_name,
          checked_out_at: new Date().toISOString(),
          timestamp: new Date().toISOString()
        }, propertyId);
      }

      if (bookingCompletionAuditPayload) {
        deps.broadcastEvent('BookingCompleted', {
          booking_id: bookingRecord.id,
          bid: bookingRecord.bid,
          trigger_reservation_id: reservationId,
          timestamp: new Date().toISOString()
        }, propertyId);
      }

      const canonicalDto = await deps.getCanonicalReservationDto(deps.pool, reservationId);
      return res.json({ status: 'SUCCESS', data: canonicalDto || deps.withReservationHotelDates(checkoutReservation) });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      if (err?.statusCode) {
        return res.status(err.statusCode).json({ status: 'ERROR', code: err.code, message: err.message });
      }
      const message = String(err?.message || err);
      res.status(message.includes('INVENTORY_INTEGRITY_ERROR') ? 409 : 500).json({ status: 'ERROR', message });
    } finally {
      deps.release(client);
    }
  };
}
