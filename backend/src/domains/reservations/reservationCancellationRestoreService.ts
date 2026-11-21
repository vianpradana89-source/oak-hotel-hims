import type { PoolClient } from 'pg';
import { restoreStockForPosOrderVoid } from '../pos/stockInventoryService';

function computeDepositStatusFromEvents(events: Array<{ event_type: string; amount: string | number }>): string {
  let received = 0;
  let reversed = 0;
  let applied = 0;
  let unapplied = 0;
  let refunded = 0;
  for (const ev of events) {
    const amt = Number(ev.amount) || 0;
    switch (ev.event_type) {
      case 'RECEIVED': received += amt; break;
      case 'REVERSAL': reversed += amt; break;
      case 'APPLY': applied += amt; break;
      case 'UNAPPLY': unapplied += amt; break;
      case 'REFUND': refunded += amt; break;
    }
  }
  const effectiveReceived = Math.max(0, received - reversed);
  const netApplied = Math.max(0, applied - unapplied);
  const remaining = Math.max(0, effectiveReceived - netApplied - refunded);
  if (reversed > 0 && effectiveReceived === 0 && netApplied === 0 && refunded === 0) {
    return 'CANCELLED';
  }
  if (remaining === 0 && (netApplied > 0 || refunded > 0)) {
    return 'CLOSED';
  }
  if (remaining > 0 && remaining < effectiveReceived) {
    return 'PARTIALLY_USED';
  }
  return 'RECEIVED';
}

/**
 * Restores minibar stock (+qty to stock_balances & stock_movements) and
 * reverses any minibar deposit deductions (deposit_events APPLY) for a reservation/task.
 */
export async function restoreMinibarStockAndDeposit(params: {
  client: PoolClient;
  propertyId: number;
  reservationId: number;
  taskId?: number | null;
  actorUserId?: string | number | null;
  actorName?: string | null;
}): Promise<{ restoredItemsCount: number; depositRestoredAmount: number }> {
  const { client, propertyId, reservationId, taskId } = params;
  let restoredItemsCount = 0;
  let depositRestoredAmount = 0;

  // 1. Find ROOM_MINIBAR_POSTING stock_operations for this reservation (and optional taskId)
  const opsRes = await client.query(
    `SELECT id, operation_key, metadata
       FROM stock_operations
      WHERE property_id = $1
        AND operation_type = 'ROOM_MINIBAR_POSTING'
        AND (
          (metadata->>'reservation_id') = $2
          OR ($3::int IS NOT NULL AND (
            (metadata->>'task_id') = $3::text
            OR operation_key = ('HK_MB_FO_CONFIRM_TASK_' || $3::text)
          ))
        )
      ORDER BY id ASC`,
    [propertyId, String(reservationId), taskId ?? null]
  );

  const createdByNum =
    params.actorUserId && Number.isInteger(Number(params.actorUserId)) && Number(params.actorUserId) > 0
      ? Number(params.actorUserId)
      : null;

  for (const op of opsRes.rows) {
    const saleOpId = Number(op.id);
    const voidOpKey = `HK_MB_VOID_OP_${saleOpId}`;

    const existingVoid = await client.query(
      `SELECT id FROM stock_operations WHERE property_id = $1 AND operation_key = $2 LIMIT 1`,
      [propertyId, voidOpKey]
    );
    if ((existingVoid.rowCount ?? 0) > 0) continue;

    const movsRes = await client.query(
      `SELECT product_id, location_id, quantity_delta, base_unit_code, unit_cost
         FROM stock_movements
        WHERE operation_id = $1
          AND property_id = $2
          AND quantity_delta < 0
        ORDER BY id ASC`,
      [saleOpId, propertyId]
    );
    if ((movsRes.rowCount ?? 0) === 0) continue;

    const voidOpIns = await client.query(
      `INSERT INTO stock_operations (
         property_id, operation_type, operation_key, payload_fingerprint,
         notes, metadata, created_by, created_at
       ) VALUES ($1, 'STOCK_ADJUSTMENT', $2, $3, $4, $5, $6, NOW())
       RETURNING id`,
      [
        propertyId,
        voidOpKey,
        voidOpKey,
        `Pengembalian stok pembatalan Minibar Reservasi #${reservationId}`,
        JSON.stringify({
          reservation_id: reservationId,
          reversed_operation_id: saleOpId,
          reason: 'MINIBAR_VOID_OR_DELETE',
          actor_name: params.actorName || 'System',
        }),
        createdByNum,
      ]
    );
    const voidOpId = Number(voidOpIns.rows[0].id);

    for (const m of movsRes.rows) {
      const productId = Number(m.product_id);
      const locationId = Number(m.location_id);
      const restoreQty = Math.abs(parseFloat(String(m.quantity_delta || '0')));
      if (!Number.isFinite(restoreQty) || restoreQty <= 0) continue;

      const balRes = await client.query(
        `SELECT id, quantity FROM stock_balances
          WHERE property_id = $1 AND product_id = $2 AND location_id = $3
          FOR UPDATE`,
        [propertyId, productId, locationId]
      );
      const prevBal = (balRes.rowCount ?? 0) > 0 ? parseFloat(String(balRes.rows[0].quantity || '0')) : 0;
      const nextBal = prevBal + restoreQty;

      await client.query(
        `INSERT INTO stock_movements (
           operation_id, property_id, product_id, location_id,
           packaging_id, packaging_code, packaging_label,
           quantity_delta, base_unit_code, unit_cost, created_at
         ) VALUES ($1, $2, $3, $4, NULL, NULL, NULL, $5, $6, $7, NOW())`,
        [
          voidOpId,
          propertyId,
          productId,
          locationId,
          restoreQty.toFixed(3),
          m.base_unit_code || 'PCS',
          m.unit_cost !== null && m.unit_cost !== undefined ? parseFloat(String(m.unit_cost)) : 0,
        ]
      );

      if ((balRes.rowCount ?? 0) > 0) {
        await client.query(
          `UPDATE stock_balances
              SET quantity = $1, updated_at = NOW()
            WHERE property_id = $2 AND product_id = $3 AND location_id = $4`,
          [nextBal.toFixed(3), propertyId, productId, locationId]
        );
      } else {
        await client.query(
          `INSERT INTO stock_balances (property_id, product_id, location_id, quantity, updated_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [propertyId, productId, locationId, nextBal.toFixed(3)]
        );
      }
      restoredItemsCount += 1;
    }
  }

  // 2. Restore any minibar DEPOSIT_APPLY entries & deposit_events for this reservation/task
  const depFolioRes = await client.query(
    `SELECT id, source_id, amount
       FROM folio_entries
      WHERE property_id = $1
        AND reservation_id = $2
        AND entry_type = 'DEPOSIT_APPLY'
        AND COALESCE(is_voided, FALSE) = FALSE
        AND (
          $3::int IS NULL
          OR notes ILIKE ('%Task #' || $3::text || '%')
          OR description ILIKE '%Minibar%'
        )`,
    [propertyId, reservationId, taskId ?? null]
  );

  const affectedDepositIds = new Set<number>();
  const depFolioIdsToDelete: number[] = [];

  for (const df of depFolioRes.rows) {
    const dfId = Number(df.id);
    const depId = Number(df.source_id);
    depFolioIdsToDelete.push(dfId);
    if (Number.isInteger(depId) && depId > 0) {
      affectedDepositIds.add(depId);
    }
    depositRestoredAmount += Number(df.amount || 0);

    await client.query(
      `DELETE FROM deposit_events
        WHERE property_id = $1
          AND reversal_of_event_id IN (
            SELECT id FROM deposit_events
             WHERE property_id = $1
               AND folio_entry_id = $2
          )`,
      [propertyId, dfId]
    );

    await client.query(
      `DELETE FROM deposit_events
        WHERE property_id = $1
          AND folio_entry_id = $2`,
      [propertyId, dfId]
    );
  }

  if (depFolioIdsToDelete.length > 0) {
    await client.query(
      `UPDATE folio_entries SET reversal_of_entry_id = NULL WHERE reversal_of_entry_id = ANY($1::int[])`,
      [depFolioIdsToDelete]
    );
    await client.query(
      `DELETE FROM folio_entries WHERE id = ANY($1::int[])`,
      [depFolioIdsToDelete]
    );
  }

  for (const depId of affectedDepositIds) {
    const nextEvRes = await client.query(
      `SELECT * FROM deposit_events WHERE deposit_id = $1 ORDER BY id ASC`,
      [depId]
    );
    const nextStatus = computeDepositStatusFromEvents(nextEvRes.rows);
    await client.query(
      `UPDATE deposits SET status = $1, updated_at = NOW() WHERE id = $2`,
      [nextStatus, depId]
    );
  }

  // 3. Reset housekeeping_tasks minibar_billing_status if applicable
  if (taskId) {
    await client.query(
      `UPDATE housekeeping_tasks
          SET minibar_billing_status = 'PENDING_CONFIRMATION',
              updated_at = NOW()
        WHERE id = $1 AND property_id = $2 AND minibar_billing_status = 'CONFIRMED_BILLED'`,
      [taskId, propertyId]
    );
  } else {
    await client.query(
      `UPDATE housekeeping_tasks
          SET minibar_billing_status = 'PENDING_CONFIRMATION',
              updated_at = NOW()
        WHERE reservation_id = $1 AND property_id = $2 AND minibar_billing_status = 'CONFIRMED_BILLED'`,
      [reservationId, propertyId]
    );
  }

  return { restoredItemsCount, depositRestoredAmount };
}

/**
 * Restores all auxiliary effects (Minibar stock, POS stock, Loyalty points, Deposit apply)
 * when an entire reservation or booking is cancelled/voided.
 */
export async function restoreAllReservationEffectsOnCancelOrVoid(params: {
  client: PoolClient;
  propertyId: number;
  reservationId: number;
  actorUserId?: string | number | null;
  actorName?: string | null;
}): Promise<void> {
  const { client, propertyId, reservationId, actorUserId, actorName } = params;
  if (!Number.isInteger(reservationId) || reservationId <= 0) return;

  // 1. Restore Minibar stock & minibar deposit apply
  await restoreMinibarStockAndDeposit({
    client,
    propertyId,
    reservationId,
    actorUserId,
    actorName,
  });

  // 2. Void any remaining MINIBAR / LOYALTY_REDEEM_REVERSAL / POS_ORDER folio entries on this reservation
  const loyaltyFolioRes = await client.query(
    `SELECT id, source_id, amount, description
       FROM folio_entries
      WHERE property_id = $1
        AND reservation_id = $2
        AND (entry_type = 'LOYALTY_REDEEM_REVERSAL' OR source_type = 'LOYALTY_REDEEM')
        AND COALESCE(is_voided, FALSE) = FALSE`,
    [propertyId, reservationId]
  );

  for (const lf of loyaltyFolioRes.rows) {
    const ledgerId = Number(lf.source_id);
    if (Number.isInteger(ledgerId) && ledgerId > 0) {
      await client.query(
        `DELETE FROM guest_loyalty_ledger WHERE id = $1 AND property_id = $2`,
        [ledgerId, propertyId]
      );
    }
    await client.query(
      `UPDATE folio_entries
          SET is_voided = TRUE,
              status = 'VOIDED',
              voided_at = NOW(),
              voided_by = $3,
              void_reason = 'Transaksi / Reservasi dibatalkan'
        WHERE id = $1 AND property_id = $2`,
      [lf.id, propertyId, actorName || 'System']
    );
  }

  // Also restore any REDEEM or EARN loyalty ledger entries tied directly to this reservation's BID or RESV-id
  const resMeta = await client.query(
    `SELECT r.id, b.bid
       FROM reservations r
       LEFT JOIN bookings b ON b.id = r.booking_id
      WHERE r.id = $1`,
    [reservationId]
  );
  const bid = resMeta.rows[0]?.bid ? String(resMeta.rows[0].bid).trim() : null;
  const refCandidates = [`RESV-${reservationId}`, ...(bid ? [bid] : [])];
  if (refCandidates.length > 0) {
    await client.query(
      `DELETE FROM guest_loyalty_ledger
        WHERE property_id = $1
          AND reference_no = ANY($2::text[])
          AND entry_type IN ('REDEEM', 'EARN')`,
      [propertyId, refCandidates]
    );
  }

  // 3. Restore POS stock for any POS orders linked to this reservation
  const posOrdersRes = await client.query(
    `SELECT id, status
       FROM pos_orders
      WHERE property_id = $1
        AND reservation_id = $2
        AND COALESCE(status, '') NOT IN ('CANCELLED', 'VOIDED')`,
    [propertyId, reservationId]
  );
  for (const po of posOrdersRes.rows) {
    const orderId = Number(po.id);
    if (Number.isInteger(orderId) && orderId > 0) {
      await restoreStockForPosOrderVoid({
        client,
        propertyId,
        orderId,
        actorUserId,
        actorName,
      });
      await client.query(
        `UPDATE pos_orders
            SET status = 'CANCELLED',
                updated_at = NOW()
          WHERE id = $1 AND property_id = $2`,
        [orderId, propertyId]
      );
    }
  }

  // 4. Mark any remaining active MINIBAR or POS_ORDER folio entries on this reservation as voided
  await client.query(
    `UPDATE folio_entries
        SET is_voided = TRUE,
            status = 'VOIDED',
            voided_at = NOW(),
            voided_by = $3,
            void_reason = 'Transaksi / Reservasi dibatalkan'
      WHERE property_id = $1
        AND reservation_id = $2
        AND COALESCE(is_voided, FALSE) = FALSE
        AND (
          UPPER(COALESCE(entry_type, '')) IN ('MINIBAR', 'POS_ORDER', 'POS')
          OR UPPER(COALESCE(source_type, '')) IN ('MINIBAR', 'POS_ORDER', 'POS')
        )`,
    [propertyId, reservationId, actorName || 'System']
  );
}
