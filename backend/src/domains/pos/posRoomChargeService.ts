/**
 * posRoomChargeService.ts
 *
 * OAK HIMS — Domain Service: Posting Beban Pesanan POS ke Folio Kamar
 *
 * Kontrak:
 * - Mengikat order POS ke reservation_id dan property_id yang valid.
 * - Status reservasi harus aktif: BOOKED atau CHECKED_IN (menolak CANCELLED / CHECKED_OUT).
 * - Status order harus OPEN, belum memiliki settlement pembayaran langsung, dan belum pernah ditagihkan.
 * - Idempotensi: jika order sudah ditagihkan ke reservasi yang sama, kembalikan 200 REPLAY
 *   tanpa mutasi ganda dan tanpa mengubah saldo.
 * - Total akhir order (termasuk pajak/servis/diskon yang dibentuk POS) diposting sebagai
 *   satu baris DEBIT kanonikal di folio_entries (entry_type: 'FNB_POS', source_type: 'POS_ORDER').
 * - TIDAK menghasilkan mutasi kas/penerimaan uang fiktif (CASH/QRIS/DEBIT/TRANSFER).
 * - Memproyeksikan folio entry ke Transaction Domain (SALE FNB_SALES).
 * - Merekalkulasi finansial reservasi secara kanonikal via recalculateReservationFinancials.
 * - Mencatat audit trail POS_ORDER_BILLED_TO_ROOM.
 */

import { PoolClient } from 'pg';
import { projectFolioEntryToTransaction } from '../transactions/transactionService';
import { recalculateReservationFinancials } from '../stayCharges/stayChargesService';
import { formatPosOrderDisplayRef } from './posFormatUtils';

export class PosRoomChargeError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'PosRoomChargeError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface PostPosRoomChargeParams {
  propertyId: number;
  orderId: number;
  reservationId: number;
  notes?: string | null;
  actorUserId?: string | null;
  actorName?: string | null;
  actorRole?: string | null;
  correlationId?: string | null;
}

export interface PostPosRoomChargeResult {
  created: boolean;
  replayed: boolean;
  order_id: number;
  reservation_id: number;
  status: 'BILLED_TO_ROOM';
  order_status: 'BILLED_TO_ROOM';
  folio_entry_id: number;
  amount: number;
  guest_name: string;
  room_number: string | null;
  summary: {
    total_price: number;
    amount_paid: number;
    applied_deposit: number;
    remaining_balance: number;
    payment_status: 'UNPAID' | 'PARTIAL' | 'PAID';
  };
}

export async function postPosOrderToRoomFolio(
  client: PoolClient,
  params: PostPosRoomChargeParams
): Promise<PostPosRoomChargeResult> {
  const { propertyId, orderId, reservationId } = params;

  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw new PosRoomChargeError(400, 'VALIDATION_ERROR', 'property_id wajib integer positif');
  }
  if (!Number.isInteger(orderId) || orderId <= 0) {
    throw new PosRoomChargeError(400, 'VALIDATION_ERROR', 'order_id wajib integer positif');
  }
  if (!Number.isInteger(reservationId) || reservationId <= 0) {
    throw new PosRoomChargeError(400, 'VALIDATION_ERROR', 'reservation_id wajib integer positif');
  }

  await client.query('BEGIN');
  try {
    // 1. Lock Reservation (Parent Lock)
    const resQ = await client.query(
      `SELECT r.id, r.status, r.guest_name, r.room_id, r.booking_id,
              b.property_id,
              rm.room_number
       FROM reservations r
       LEFT JOIN bookings b ON b.id = r.booking_id
       LEFT JOIN rooms rm ON rm.id = r.room_id
       WHERE r.id = $1
       FOR UPDATE OF r`,
      [reservationId]
    );

    if ((resQ.rowCount ?? 0) === 0 || !resQ.rows[0]) {
      throw new PosRoomChargeError(404, 'RESERVATION_NOT_FOUND', `Reservasi #${reservationId} tidak ditemukan`);
    }

    const resRow = resQ.rows[0];
    const resPropertyId = Number(resRow.property_id);
    if (resPropertyId !== propertyId) {
      throw new PosRoomChargeError(
        403,
        'CROSS_PROPERTY_RESERVATION',
        `Reservasi #${reservationId} bukan milik properti #${propertyId}`
      );
    }

    const resStatus = String(resRow.status || '').toUpperCase();
    if (resStatus === 'CANCELLED' || resStatus === 'CHECKED_OUT') {
      throw new PosRoomChargeError(
        409,
        'RESERVATION_NOT_ACTIVE',
        `Reservasi #${reservationId} berstatus ${resStatus}; hanya reservasi aktif BOOKED atau CHECKED_IN yang dapat menerima tagihan kamar`
      );
    }

    // 2. Lock POS Order
    const orderQ = await client.query(
      `SELECT id, property_id, order_number, status, total_amount, guest_name, table_number
       FROM pos_orders
       WHERE id = $1
       FOR UPDATE`,
      [orderId]
    );

    if ((orderQ.rowCount ?? 0) === 0 || !orderQ.rows[0]) {
      throw new PosRoomChargeError(404, 'ORDER_NOT_FOUND', `POS order #${orderId} tidak ditemukan`);
    }

    const orderRow = orderQ.rows[0];
    const orderPropertyId = Number(orderRow.property_id);
    if (orderPropertyId !== propertyId) {
      throw new PosRoomChargeError(
        403,
        'CROSS_PROPERTY_ORDER',
        `POS order #${orderId} bukan milik properti #${propertyId}`
      );
    }

    const orderAmount = Number(orderRow.total_amount || 0);
    if (!Number.isFinite(orderAmount) || orderAmount <= 0) {
      throw new PosRoomChargeError(
        422,
        'INVALID_ORDER_AMOUNT',
        `POS order #${orderId} memiliki nominal tidak valid (${orderAmount})`
      );
    }

    // 3. Idempotency Check: apakah order ini sudah memiliki entry di folio_entries?
    const existingFolioQ = await client.query(
      `SELECT id, reservation_id, amount, status
       FROM folio_entries
       WHERE property_id = $1 AND source_type = 'POS_ORDER' AND source_id = $2 AND is_voided = FALSE
       LIMIT 1`,
      [propertyId, String(orderId)]
    );

    if ((existingFolioQ.rowCount ?? 0) > 0 && existingFolioQ.rows[0]) {
      const existingFolio = existingFolioQ.rows[0];
      const existingResId = Number(existingFolio.reservation_id);
      if (existingResId === reservationId) {
        // Replay idempoten: sudah diposting ke reservasi yang sama
        const fin = await recalculateReservationFinancials(client, reservationId, propertyId);
        await client.query('COMMIT');
        return {
          created: false,
          replayed: true,
          order_id: orderId,
          reservation_id: reservationId,
          status: 'BILLED_TO_ROOM',
          order_status: 'BILLED_TO_ROOM',
          folio_entry_id: Number(existingFolio.id),
          amount: Number(existingFolio.amount),
          guest_name: String(resRow.guest_name || ''),
          room_number: resRow.room_number ? String(resRow.room_number) : null,
          summary: {
            total_price: fin.total_price,
            amount_paid: fin.amount_paid,
            applied_deposit: fin.applied_deposit,
            remaining_balance: fin.remaining_balance,
            payment_status: fin.payment_status,
          },
        };
      } else {
        throw new PosRoomChargeError(
          409,
          'ALREADY_BILLED_TO_ROOM',
          `POS order #${orderId} sudah ditagihkan ke reservasi #${existingResId}`
        );
      }
    }

    // 4. Validasi Status Order
    const orderStatus = String(orderRow.status || '').toUpperCase();
    if (orderStatus === 'PAID') {
      throw new PosRoomChargeError(409, 'ALREADY_PAID', `POS order #${orderId} sudah lunas dibayar langsung`);
    }
    if (orderStatus === 'VOIDED') {
      throw new PosRoomChargeError(409, 'ORDER_VOIDED', `POS order #${orderId} berstatus VOIDED`);
    }
    if (orderStatus === 'BILLED_TO_ROOM') {
      throw new PosRoomChargeError(409, 'ALREADY_BILLED_TO_ROOM', `POS order #${orderId} sudah ditagihkan ke kamar`);
    }
    if (orderStatus !== 'OPEN') {
      throw new PosRoomChargeError(
        409,
        'ORDER_NOT_BILLABLE',
        `POS order #${orderId} berstatus ${orderStatus}; hanya status OPEN yang dapat ditagihkan ke kamar`
      );
    }

    // Cek apakah ada settlement pembayaran
    const settleTableCheck = await client.query(
      `SELECT to_regclass('pos_settlements') AS tbl`
    );
    if (settleTableCheck.rows[0]?.tbl) {
      const settleQ = await client.query(
        `SELECT 1 FROM pos_settlements WHERE property_id = $1 AND pos_order_id = $2 LIMIT 1`,
        [propertyId, orderId]
      );
      if ((settleQ.rowCount ?? 0) > 0) {
        throw new PosRoomChargeError(409, 'ALREADY_PAID', `POS order #${orderId} sudah memiliki settlement pembayaran`);
      }
    }

    // 5. Ambil item untuk deskripsi folio yang informatif
    const itemsQ = await client.query(
      `SELECT poi.id, poi.quantity, poi.unit_price, COALESCE(pmi.name, 'Item POS') AS item_name
       FROM pos_order_items poi
       LEFT JOIN pos_menu_items pmi ON pmi.id = poi.menu_item_id
       WHERE poi.order_id = $1
       ORDER BY poi.id ASC`,
      [orderId]
    );
    const items = itemsQ.rows;

    const displayRef = formatPosOrderDisplayRef(orderId);
    let itemsSummary = '';
    if (items.length > 0) {
      itemsSummary = items.map((it: any) => `${it.item_name} (${it.quantity})`).join(', ');
    }
    let folioDesc = itemsSummary ? `${displayRef} - ${itemsSummary}` : `Tagihan ${displayRef}`;
    if (folioDesc.length > 250) {
      folioDesc = folioDesc.slice(0, 247) + '...';
    }

    // 6. Insert Folio Entry (DEBIT FNB_POS)
    const folioIns = await client.query(
      `INSERT INTO folio_entries (
         reservation_id, property_id, entry_type, source_type, source_id,
         description, amount, direction, base_amount, unit_price, quantity,
         tax_amount, service_amount, status, notes, revenue_category,
         actor_user_id, actor_name_snapshot, actor_role_snapshot
       ) VALUES (
         $1, $2, 'FNB_POS', 'POS_ORDER', $3,
         $4, $5, 'DEBIT', $6, $7, 1,
         $8, $9, 'POSTED', $10, 'FNB_SALES',
         $11, $12, $13
       ) RETURNING id, amount`,
      [
        reservationId,
        propertyId,
        String(orderId),
        folioDesc,
        orderAmount,
        orderAmount,
        orderAmount,
        0,
        0,
        params.notes || null,
        params.actorUserId || null,
        params.actorName || 'Staff POS',
        params.actorRole || 'STAFF',
      ]
    );

    const insertedFolio = folioIns.rows[0];
    const folioEntryId = Number(insertedFolio.id);

    // 7. Update POS Order status -> BILLED_TO_ROOM
    await client.query(
      `UPDATE pos_orders
       SET status = 'BILLED_TO_ROOM',
           reservation_id = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [orderId, reservationId]
    );

    // 8. Proyeksikan ke Transaction Domain
    await projectFolioEntryToTransaction(client, folioEntryId, {
      propertyId,
      actorName: params.actorName ?? undefined,
      actorUserId: params.actorUserId ?? undefined,
    });

    // 9. Rekalkulasi Finansial Reservasi
    const fin = await recalculateReservationFinancials(client, reservationId, propertyId);

    // 10. Catat Audit Log
    await client.query(
      `INSERT INTO audit_logs (
         module, action, entity, record_id, new_value,
         property_id, actor_user_id, correlation_id
       ) VALUES ('POS', 'POS_ORDER_BILLED_TO_ROOM', 'pos_orders', $1, $2, $3, $4, $5)`,
      [
        String(orderId),
        JSON.stringify({
          order_id: orderId,
          reservation_id: reservationId,
          folio_entry_id: folioEntryId,
          amount: orderAmount,
          notes: params.notes || null,
        }),
        propertyId,
        params.actorUserId || null,
        params.correlationId || null,
      ]
    );

    await client.query('COMMIT');

    return {
      created: true,
      replayed: false,
      order_id: orderId,
      reservation_id: reservationId,
      status: 'BILLED_TO_ROOM',
      order_status: 'BILLED_TO_ROOM',
      folio_entry_id: folioEntryId,
      amount: orderAmount,
      guest_name: String(resRow.guest_name || ''),
      room_number: resRow.room_number ? String(resRow.room_number) : null,
      summary: {
        total_price: fin.total_price,
        amount_paid: fin.amount_paid,
        applied_deposit: fin.applied_deposit,
        remaining_balance: fin.remaining_balance,
        payment_status: fin.payment_status,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}
