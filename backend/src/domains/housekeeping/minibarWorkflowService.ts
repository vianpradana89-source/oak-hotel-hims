import crypto from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { projectFolioEntryToTransaction } from '../transactions/transactionService';
import { recalculateReservationFinancials } from '../stayCharges/stayChargesService';
import { deriveDepositBalance } from '../deposits/depositService';

export interface MinibarConsumedItemInput {
  menu_item_id: number;
  quantity: number;
  unit_price?: number;
  name?: string;
  sku?: string;
  notes?: string | null;
}

export interface MinibarConsumedItemSnapshot {
  menu_item_id: number;
  name: string;
  sku: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
  base_unit_code: string;
  item_role?: 'PAID_MINIBAR' | 'COMPLIMENTARY';
  notes?: string | null;
}

export interface ConfirmCheckoutMinibarInput {
  propertyId: number;
  taskId: number;
  reservationId?: number | null;
  settlementMode: 'FOLIO' | 'DEPOSIT' | 'DIRECT_PAY' | 'WAIVE';
  paymentMethod?: string | null;
  items?: MinibarConsumedItemInput[] | null;
  notes?: string | null;
  actorUserId?: string | null;
  actorName?: string | null;
  actorRole?: string | null;
}

/**
 * Resolves the authoritative HKP (Housekeeping Pantry) stock location for a property.
 * Auto-creates HKP if no HKP / HK_PANTRY location exists yet for the property.
 */
export async function resolveHkpLocation(
  client: PoolClient | Pool,
  propertyId: number
): Promise<{ id: number; code: string; name: string; location_type: string }> {
  const res = await client.query(
    `SELECT id, code, name, location_type
       FROM stock_locations
      WHERE property_id = $1
        AND is_active = TRUE
        AND (
          UPPER(BTRIM(COALESCE(code, ''))) = 'HKP'
          OR location_type = 'HK_PANTRY'
          OR UPPER(BTRIM(COALESCE(name, ''))) LIKE '%HOUSEKEEPING%'
          OR UPPER(BTRIM(COALESCE(name, ''))) LIKE '%HUSEKEEPING%'
        )
      ORDER BY
        CASE
          WHEN UPPER(BTRIM(COALESCE(code, ''))) = 'HKP' THEN 0
          WHEN location_type = 'HK_PANTRY' THEN 1
          ELSE 2
        END,
        id ASC
      LIMIT 1`,
    [propertyId]
  );

  if ((res.rowCount ?? 0) > 0 && res.rows[0]) {
    return {
      id: Number(res.rows[0].id),
      code: String(res.rows[0].code || 'HKP'),
      name: String(res.rows[0].name || 'Housekeeping Pantry'),
      location_type: String(res.rows[0].location_type || 'HK_PANTRY'),
    };
  }

  // Auto-create HKP if not found
  const ins = await client.query(
    `INSERT INTO stock_locations (property_id, code, name, location_type, room_id, is_active, notes)
     VALUES ($1, 'HKP', 'Housekeeping Pantry', 'HK_PANTRY', NULL, TRUE, 'Gudang Pantry Housekeeping (Minibar & Complimentary Kamar)')
     ON CONFLICT (property_id, UPPER(BTRIM(code)))
     DO UPDATE SET is_active = TRUE, updated_at = NOW()
     RETURNING id, code, name, location_type`,
    [propertyId]
  );
  return {
    id: Number(ins.rows[0].id),
    code: String(ins.rows[0].code || 'HKP'),
    name: String(ins.rows[0].name || 'Housekeeping Pantry'),
    location_type: String(ins.rows[0].location_type || 'HK_PANTRY'),
  };
}

/**
 * Fetches the Minibar & Complimentary catalog, room standards, recent checkout consumption,
 * and active reservation deposit balance for Housekeeping & Front Office modals.
 */
export async function getMinibarCatalogAndRoomContext(
  client: PoolClient | Pool,
  propertyId: number,
  options: { roomId?: number | null; reservationId?: number | null; taskId?: number | null } = {}
) {
  const hkpLocation = await resolveHkpLocation(client, propertyId);

  let roomId = options.roomId ? Number(options.roomId) : null;
  let reservationId = options.reservationId ? Number(options.reservationId) : null;

  if (options.taskId && (!roomId || !reservationId)) {
    const tRes = await client.query(
      `SELECT room_id, reservation_id FROM housekeeping_tasks WHERE id = $1 AND property_id = $2 LIMIT 1`,
      [options.taskId, propertyId]
    );
    if ((tRes.rowCount ?? 0) > 0) {
      if (!roomId && tRes.rows[0].room_id) roomId = Number(tRes.rows[0].room_id);
      if (!reservationId && tRes.rows[0].reservation_id) reservationId = Number(tRes.rows[0].reservation_id);
    }
  }

  let roomInfo: { id: number; room_number: string; room_type_id: number; room_type_name: string } | null = null;
  if (roomId) {
    const rRes = await client.query(
      `SELECT r.id, r.room_number, r.room_type_id, rt.name AS room_type_name
         FROM rooms r
         LEFT JOIN room_types rt ON rt.id = r.room_type_id
        WHERE r.id = $1 AND r.property_id = $2
        LIMIT 1`,
      [roomId, propertyId]
    );
    if ((rRes.rowCount ?? 0) > 0) {
      roomInfo = {
        id: Number(rRes.rows[0].id),
        room_number: String(rRes.rows[0].room_number || ''),
        room_type_id: Number(rRes.rows[0].room_type_id || 0),
        room_type_name: String(rRes.rows[0].room_type_name || 'Standard'),
      };
    }
  }

  // Resolve active reservation on this room if reservationId not explicitly provided
  if (!reservationId && roomId) {
    const activeRes = await client.query(
      `SELECT r.id
         FROM reservations r
         JOIN bookings b ON b.id = r.booking_id
        WHERE b.property_id = $1
          AND r.room_id = $2
          AND r.status IN ('CHECKED_IN', 'CHECKED_OUT')
        ORDER BY
          CASE WHEN r.status = 'CHECKED_IN' THEN 0 ELSE 1 END,
          r.id DESC
        LIMIT 1`,
      [propertyId, roomId]
    );
    if ((activeRes.rowCount ?? 0) > 0) {
      reservationId = Number(activeRes.rows[0].id);
    }
  }

  // Load room_type_minibar_standard rows for this property
  const stdRes = await client.query(
    `SELECT std.id,
            std.property_id,
            std.room_type_id,
            rt.name AS room_type_name,
            std.menu_item_id,
            std.standard_qty,
            COALESCE(std.item_role, 'PAID_MINIBAR') AS item_role,
            std.notes,
            std.is_active,
            pmi.name AS item_name,
            pmi.item_code AS sku,
            COALESCE(pmi.price, 0) AS unit_price,
            COALESCE(NULLIF(BTRIM(pmi.canonical_base_unit_code), ''), NULLIF(BTRIM(pmi.base_unit), ''), 'PCS') AS base_unit_code,
            COALESCE(sb.quantity, 0) AS hkp_stock_balance
       FROM room_type_minibar_standard std
       JOIN pos_menu_items pmi ON pmi.id = std.menu_item_id
       LEFT JOIN room_types rt ON rt.id = std.room_type_id
       LEFT JOIN stock_balances sb
         ON sb.property_id = std.property_id
        AND sb.product_id = std.menu_item_id
        AND sb.location_id = $2
      WHERE std.property_id = $1
        AND std.is_active = TRUE
        AND COALESCE(pmi.is_deleted, FALSE) = FALSE
      ORDER BY
        CASE WHEN COALESCE(std.item_role, 'PAID_MINIBAR') = 'COMPLIMENTARY' THEN 0 ELSE 1 END,
        pmi.name ASC`,
    [propertyId, hkpLocation.id]
  );

  const allPropertyStandards = stdRes.rows.map((r: any) => ({
    id: Number(r.id),
    property_id: Number(r.property_id),
    room_type_id: Number(r.room_type_id),
    room_type_name: String(r.room_type_name || ''),
    menu_item_id: Number(r.menu_item_id),
    item_name: String(r.item_name || ''),
    sku: String(r.sku || ''),
    standard_qty: Number(r.standard_qty || 0),
    item_role: (String(r.item_role || 'PAID_MINIBAR').toUpperCase() === 'COMPLIMENTARY'
      ? 'COMPLIMENTARY'
      : 'PAID_MINIBAR') as 'PAID_MINIBAR' | 'COMPLIMENTARY',
    unit_price: Number(r.unit_price || 0),
    base_unit_code: String(r.base_unit_code || 'PCS').toUpperCase(),
    hkp_stock_balance: Number(r.hkp_stock_balance || 0),
    notes: r.notes || null,
  }));

  // Deduplicated standards for the target room's room_type_id (or property-wide deduplicated if no roomId)
  const roomStandardsMap = new Map<number, (typeof allPropertyStandards)[number]>();
  for (const s of allPropertyStandards) {
    if (roomInfo && roomInfo.room_type_id > 0) {
      if (s.room_type_id === roomInfo.room_type_id) {
        roomStandardsMap.set(s.menu_item_id, s);
      }
    } else if (!roomStandardsMap.has(s.menu_item_id)) {
      roomStandardsMap.set(s.menu_item_id, s);
    }
  }
  // Per-role fallback: if roomInfo's specific room_type_id has no standards for a given role
  // (e.g. admin added PAID_MINIBAR to only one room type), fall back to property-wide standards for that role.
  for (const role of ['COMPLIMENTARY', 'PAID_MINIBAR'] as const) {
    const hasRoleForRoom = Array.from(roomStandardsMap.values()).some((s) => s.item_role === role);
    if (!hasRoleForRoom) {
      for (const s of allPropertyStandards) {
        if (s.item_role === role && !roomStandardsMap.has(s.menu_item_id)) {
          roomStandardsMap.set(s.menu_item_id, s);
        }
      }
    }
  }
  const activeRoomStandards = Array.from(roomStandardsMap.values());

  // Ensure any product with HKP. or HK. SKU prefix is linked to hkpLocation.id if default_location_id is unset
  await client
    .query(
      `UPDATE pos_menu_items
          SET default_location_id = $2
        WHERE property_id = $1
          AND default_location_id IS NULL
          AND UPPER(BTRIM(COALESCE(item_code, ''))) ~ '^(HKP|HK)[.\\-_]'`,
      [propertyId, hkpLocation.id]
    )
    .catch(() => {});

  // Load ONLY catalog items that belong to or are stored in Gudang HKP
  const catRes = await client.query(
    `SELECT pmi.id AS menu_item_id,
            pmi.name,
            COALESCE(pmi.item_code, '') AS sku,
            COALESCE(pmi.price, 0) AS unit_price,
            COALESCE(NULLIF(BTRIM(pmi.canonical_base_unit_code), ''), NULLIF(BTRIM(pmi.base_unit), ''), 'PCS') AS base_unit_code,
            COALESCE(pmi.track_inventory, FALSE) AS track_inventory,
            pmi.default_location_id,
            COALESCE(pmc.name, '') AS category_name,
            COALESCE(sb.quantity, 0) AS hkp_stock_balance
       FROM pos_menu_items pmi
       LEFT JOIN pos_menu_categories pmc ON pmc.id = pmi.category_id
       LEFT JOIN stock_balances sb
         ON sb.property_id = pmi.property_id
        AND sb.product_id = pmi.id
        AND sb.location_id = $2
      WHERE pmi.property_id = $1
        AND COALESCE(pmi.is_deleted, FALSE) = FALSE
        AND COALESCE(pmi.is_active, TRUE) = TRUE
        AND COALESCE(UPPER(BTRIM(pmi.product_type)), 'FINISHED_GOOD') <> 'RAW_MATERIAL'
        AND UPPER(BTRIM(COALESCE(pmi.name, ''))) NOT IN ('AYAM', 'TELUR')
        AND (
          pmi.default_location_id = $2
          OR UPPER(BTRIM(COALESCE(pmi.item_code, ''))) ~ '^(HKP|HK)[.\\-_]'
          OR UPPER(BTRIM(COALESCE(pmi.storage_sublocation, ''))) ~ '(^HKP$|^HK$|HOUSEKEEPING)'
          OR (
            COALESCE(sb.quantity, 0) > 0
            AND (pmi.default_location_id IS NULL OR pmi.default_location_id = $2)
            AND UPPER(BTRIM(COALESCE(pmi.item_code, ''))) !~ '^(RCP|CCR|KCH|GAR)[.\\-_]'
          )
        )
      ORDER BY
        CASE
          WHEN pmi.default_location_id = $2 OR UPPER(BTRIM(COALESCE(pmi.item_code, ''))) ~ '^(HKP|HK)[.\\-_]' THEN 0
          WHEN COALESCE(sb.quantity, 0) > 0 THEN 1
          ELSE 2
        END,
        pmi.name ASC`,
    [propertyId, hkpLocation.id]
  );

  const catalogItems = catRes.rows.map((r: any) => {
    const std = roomStandardsMap.get(Number(r.menu_item_id));
    return {
      menu_item_id: Number(r.menu_item_id),
      name: String(r.name || ''),
      sku: String(r.sku || ''),
      unit_price: Number(r.unit_price || 0),
      base_unit_code: String(r.base_unit_code || 'PCS').toUpperCase(),
      category_name: String(r.category_name || ''),
      track_inventory: Boolean(r.track_inventory),
      hkp_stock_balance: Number(r.hkp_stock_balance || 0),
      standard_qty: std ? std.standard_qty : 0,
      item_role: std ? std.item_role : null,
    };
  });

  // Complimentary defaults for ROOM_CLEANING
  let complimentaryDefaults = activeRoomStandards.filter((s) => s.item_role === 'COMPLIMENTARY' && s.standard_qty > 0);
  if (complimentaryDefaults.length === 0) {
    // Fallback: look for Air Mineral in catalog
    const mineralItem = catalogItems.find((c) =>
      /AIR MINERAL|MINERAL WATER|AQUA|CLEO/i.test(c.name)
    );
    if (mineralItem) {
      complimentaryDefaults = [
        {
          id: 0,
          property_id: propertyId,
          room_type_id: roomInfo?.room_type_id || 0,
          room_type_name: roomInfo?.room_type_name || 'Semua Kamar',
          menu_item_id: mineralItem.menu_item_id,
          item_name: mineralItem.name,
          sku: mineralItem.sku,
          standard_qty: 2,
          item_role: 'COMPLIMENTARY',
          unit_price: 0,
          base_unit_code: mineralItem.base_unit_code,
          hkp_stock_balance: mineralItem.hkp_stock_balance,
          notes: 'Default Complimentary Air Mineral Kamar',
        },
      ];
    }
  }

  let minibarDefaults = activeRoomStandards
    .filter((s) => s.item_role === 'PAID_MINIBAR' && s.standard_qty > 0)
    .map((s) => ({
      ...s,
      stocked_qty: s.standard_qty,
    }));

  // Look up the most recent cleaning task on this room to see the exact minibar items & quantities stocked by the Room Attendant
  let lastCleaningStockedMinibar: {
    task_id: number;
    completed_at: string | null;
    processed_by: string | null;
    items: MinibarConsumedItemSnapshot[];
  } | null = null;

  if (roomId) {
    const lastCleanRes = await client.query(
      `SELECT id, completed_at, complimentary_restock_meta
         FROM housekeeping_tasks
        WHERE property_id = $1
          AND room_id = $2
          AND task_type IN ('ROOM_CLEANING', 'STAYOVER_CLEANING', 'DEEP_CLEAN', 'VIP_ROOM_PREPARATION')
          AND status IN ('DONE', 'VERIFIED')
          AND complimentary_restock_meta IS NOT NULL
        ORDER BY completed_at DESC NULLS LAST, id DESC
        LIMIT 1`,
      [propertyId, roomId]
    );
    if ((lastCleanRes.rowCount ?? 0) > 0) {
      const cRow = lastCleanRes.rows[0];
      const meta = cRow.complimentary_restock_meta || {};
      const stockedArr: MinibarConsumedItemSnapshot[] = Array.isArray(meta.stocked_minibar_items)
        ? meta.stocked_minibar_items
        : [];
      if (stockedArr.length > 0) {
        lastCleaningStockedMinibar = {
          task_id: Number(cRow.id),
          completed_at: cRow.completed_at,
          processed_by: meta.processed_by || null,
          items: stockedArr,
        };

        // Override / enrich minibarDefaults with the exact items and quantities stocked into this room during cleaning
        const catalogById = new Map<number, (typeof catalogItems)[number]>(
          catalogItems.map((c) => [c.menu_item_id, c])
        );
        const mergedMap = new Map<number, (typeof minibarDefaults)[number]>();

        for (const stocked of stockedArr) {
          const pid = Number(stocked.menu_item_id);
          const qty = Math.max(0, Number(stocked.quantity || 0));
          if (!pid || qty <= 0) continue;
          const cat = catalogById.get(pid);
          const existingStd = minibarDefaults.find((m) => m.menu_item_id === pid);
          mergedMap.set(pid, {
            id: existingStd?.id || 0,
            property_id: propertyId,
            room_type_id: roomInfo?.room_type_id || existingStd?.room_type_id || 0,
            room_type_name: roomInfo?.room_type_name || existingStd?.room_type_name || '',
            menu_item_id: pid,
            item_name: cat?.name || stocked.name || existingStd?.item_name || `Produk #${pid}`,
            sku: cat?.sku || stocked.sku || existingStd?.sku || '',
            standard_qty: qty,
            stocked_qty: qty,
            item_role: 'PAID_MINIBAR',
            unit_price: cat ? cat.unit_price : Number(stocked.unit_price || existingStd?.unit_price || 0),
            base_unit_code: cat?.base_unit_code || stocked.base_unit_code || existingStd?.base_unit_code || 'PCS',
            hkp_stock_balance: cat ? cat.hkp_stock_balance : Number(existingStd?.hkp_stock_balance || 0),
            notes: existingStd?.notes || 'Isi Minibar Kamar Saat Pembersihan',
          });
        }

        // Also keep any newly added standard items that weren't in the snapshot yet
        for (const std of minibarDefaults) {
          if (!mergedMap.has(std.menu_item_id)) {
            mergedMap.set(std.menu_item_id, std);
          }
        }

        minibarDefaults = Array.from(mergedMap.values());
      }
    }
  }

  // Recent checkout consumption on this room (for Room Attendant restock visibility during ROOM_CLEANING)
  let lastCheckoutConsumption: {
    task_id: number;
    completed_at: string | null;
    minibar_billing_status: string;
    items: MinibarConsumedItemSnapshot[];
  } | null = null;

  if (roomId) {
    const lastChkRes = await client.query(
      `SELECT id, completed_at, minibar_billing_status, minibar_items_json
         FROM housekeeping_tasks
        WHERE property_id = $1
          AND room_id = $2
          AND task_type = 'CHECKOUT_ROOM_CHECK'
          AND status IN ('DONE', 'VERIFIED')
          AND completed_at >= NOW() - INTERVAL '48 hours'
        ORDER BY completed_at DESC NULLS LAST, id DESC
        LIMIT 1`,
      [propertyId, roomId]
    );
    if ((lastChkRes.rowCount ?? 0) > 0) {
      const row = lastChkRes.rows[0];
      const rawItems = Array.isArray(row.minibar_items_json) ? row.minibar_items_json : [];
      if (rawItems.length > 0) {
        lastCheckoutConsumption = {
          task_id: Number(row.id),
          completed_at: row.completed_at,
          minibar_billing_status: String(row.minibar_billing_status || 'NONE'),
          items: rawItems,
        };
      }
    }
  }

  // Reservation deposit & financial context (for Front Office confirmation popup)
  let reservationContext: {
    reservation_id: number;
    guest_name: string;
    status: string;
    total_price: number;
    amount_paid: number;
    applied_deposit: number;
    remaining_balance: number;
    available_deposit_balance: number;
    open_deposits: Array<{
      id: number;
      deposit_number: string;
      purpose: string | null;
      remaining: number;
      status: string;
    }>;
  } | null = null;

  if (reservationId) {
    const rRes = await client.query(
      `SELECT r.id, r.guest_name, r.status, r.total_price, r.amount_paid, r.applied_deposit, r.remaining_balance, r.booking_id
         FROM reservations r
         JOIN bookings b ON b.id = r.booking_id
        WHERE r.id = $1 AND b.property_id = $2
        LIMIT 1`,
      [reservationId, propertyId]
    );
    if ((rRes.rowCount ?? 0) > 0) {
      const rRow = rRes.rows[0];
      const depsRes = await client.query(
        `SELECT d.id, d.deposit_number, d.purpose, d.status, d.scope
           FROM deposits d
          WHERE d.property_id = $1
            AND (
              d.reservation_id = $2
              OR (d.scope = 'BOOKING_GROUP' AND d.booking_id = $3)
            )
          ORDER BY CASE WHEN d.reservation_id = $2 THEN 0 ELSE 1 END, d.id ASC`,
        [propertyId, reservationId, rRow.booking_id || 0]
      );

      const openDeposits: Array<{
        id: number;
        deposit_number: string;
        purpose: string | null;
        remaining: number;
        status: string;
      }> = [];
      let totalDepositRemaining = 0;

      for (const d of depsRes.rows) {
        const evRes = await client.query(
          `SELECT * FROM deposit_events WHERE deposit_id = $1 ORDER BY id ASC`,
          [d.id]
        );
        try {
          const bal = deriveDepositBalance(evRes.rows);
          if (bal.remaining > 0 && bal.status !== 'CANCELLED' && bal.status !== 'CLOSED') {
            openDeposits.push({
              id: Number(d.id),
              deposit_number: String(d.deposit_number || `#${d.id}`),
              purpose: d.purpose ? String(d.purpose) : null,
              remaining: bal.remaining,
              status: bal.status,
            });
            totalDepositRemaining += bal.remaining;
          }
        } catch {
          // ignore malformed deposit events
        }
      }

      reservationContext = {
        reservation_id: Number(rRow.id),
        guest_name: String(rRow.guest_name || 'Tamu'),
        status: String(rRow.status || ''),
        total_price: Number(rRow.total_price || 0),
        amount_paid: Number(rRow.amount_paid || 0),
        applied_deposit: Number(rRow.applied_deposit || 0),
        remaining_balance: Number(rRow.remaining_balance || 0),
        available_deposit_balance: totalDepositRemaining,
        open_deposits: openDeposits,
      };
    }
  }

  // Also load room_types and ready_rooms for Settings management
  const rtRes = await client.query(
    `SELECT id, name FROM room_types WHERE property_id = $1 ORDER BY id ASC`,
    [propertyId]
  );

  const readyRoomsRes = await client.query(
    `SELECT r.id, r.room_number, r.status, r.room_type_id, COALESCE(rt.name, 'Standard') AS room_type_name
       FROM rooms r
       LEFT JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.property_id = $1
        AND UPPER(COALESCE(r.status, '')) IN ('VACANT_CLEAN', 'INSPECTED', 'OCCUPIED_CLEAN')
      ORDER BY r.room_number ASC`,
    [propertyId]
  );

  return {
    hkp_location: hkpLocation,
    room: roomInfo,
    room_types: rtRes.rows.map((rt: any) => ({ id: Number(rt.id), name: String(rt.name || '') })),
    ready_rooms: readyRoomsRes.rows.map((rr: any) => ({
      id: Number(rr.id),
      room_number: String(rr.room_number || ''),
      status: String(rr.status || 'VACANT_CLEAN'),
      room_type_id: Number(rr.room_type_id || 0),
      room_type_name: String(rr.room_type_name || ''),
    })),
    standards: allPropertyStandards,
    active_room_standards: activeRoomStandards,
    complimentary_defaults: complimentaryDefaults,
    minibar_defaults: minibarDefaults,
    catalog_items: catalogItems,
    last_cleaning_stocked_minibar: lastCleaningStockedMinibar,
    last_checkout_consumption: lastCheckoutConsumption,
    reservation_context: reservationContext,
  };
}

/**
 * Upserts a standard item (COMPLIMENTARY or PAID_MINIBAR) for a specific room_type_id or all room types.
 */
export async function upsertRoomMinibarStandard(
  client: PoolClient,
  propertyId: number,
  input: {
    room_type_id?: number | null;
    apply_all_room_types?: boolean;
    menu_item_id: number;
    standard_qty: number;
    item_role: 'PAID_MINIBAR' | 'COMPLIMENTARY';
    notes?: string | null;
  }
) {
  const menuItemId = Number(input.menu_item_id);
  const standardQty = Math.max(0, Math.round(Number(input.standard_qty || 0)));
  const itemRole = String(input.item_role || 'PAID_MINIBAR').toUpperCase() === 'COMPLIMENTARY'
    ? 'COMPLIMENTARY'
    : 'PAID_MINIBAR';

  if (!Number.isInteger(menuItemId) || menuItemId <= 0) {
    throw Object.assign(new Error('Produk wajib dipilih'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  }
  if (standardQty <= 0) {
    throw Object.assign(new Error('Jumlah standar harus minimal 1'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  }

  let targetRoomTypeIds: number[] = [];
  if (input.apply_all_room_types || !input.room_type_id || Number(input.room_type_id) <= 0) {
    const rtRes = await client.query(`SELECT id FROM room_types WHERE property_id = $1 ORDER BY id ASC`, [propertyId]);
    targetRoomTypeIds = rtRes.rows.map((r: any) => Number(r.id));
  } else {
    targetRoomTypeIds = [Number(input.room_type_id)];
  }

  const upserted: any[] = [];
  for (const rtId of targetRoomTypeIds) {
    const res = await client.query(
      `INSERT INTO room_type_minibar_standard (
         property_id, room_type_id, menu_item_id, standard_qty, item_role, notes, is_active, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW())
       ON CONFLICT (property_id, room_type_id, menu_item_id)
       DO UPDATE SET
         standard_qty = EXCLUDED.standard_qty,
         item_role = EXCLUDED.item_role,
         notes = COALESCE(EXCLUDED.notes, room_type_minibar_standard.notes),
         is_active = TRUE,
         updated_at = NOW()
       RETURNING *`,
      [propertyId, rtId, menuItemId, standardQty, itemRole, input.notes || null]
    );
    if (res.rows[0]) upserted.push(res.rows[0]);
  }

  // Also link the product's default_location_id to HKP if unset
  const hkp = await resolveHkpLocation(client, propertyId);
  await client.query(
    `UPDATE pos_menu_items
        SET default_location_id = COALESCE(default_location_id, $1),
            track_inventory = TRUE
      WHERE id = $2 AND property_id = $3`,
    [hkp.id, menuItemId, propertyId]
  );

  return upserted;
}

/**
 * Deletes/deactivates a standard item from room_type_minibar_standard.
 */
export async function deleteRoomMinibarStandard(
  client: PoolClient,
  propertyId: number,
  standardId: number,
  deleteAcrossAllRoomTypes = true
) {
  const rowRes = await client.query(
    `SELECT id, menu_item_id, item_role FROM room_type_minibar_standard WHERE id = $1 AND property_id = $2 LIMIT 1`,
    [standardId, propertyId]
  );
  if ((rowRes.rowCount ?? 0) === 0) {
    throw Object.assign(new Error('Data standar kamar tidak ditemukan'), { statusCode: 404, code: 'NOT_FOUND' });
  }
  const { menu_item_id, item_role } = rowRes.rows[0];
  if (deleteAcrossAllRoomTypes) {
    await client.query(
      `DELETE FROM room_type_minibar_standard WHERE property_id = $1 AND menu_item_id = $2 AND item_role = $3`,
      [propertyId, menu_item_id, item_role]
    );
  } else {
    await client.query(
      `DELETE FROM room_type_minibar_standard WHERE id = $1 AND property_id = $2`,
      [standardId, propertyId]
    );
  }
  return { deleted: true };
}

/**
 * Normalizes and enriches raw minibar items array with authoritative product names, SKUs, and prices.
 */
export async function normalizeMinibarItemsList(
  client: PoolClient | Pool,
  propertyId: number,
  rawItems: MinibarConsumedItemInput[],
  defaultRole: 'PAID_MINIBAR' | 'COMPLIMENTARY' = 'PAID_MINIBAR'
): Promise<MinibarConsumedItemSnapshot[]> {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return [];

  const mergedByProductId = new Map<number, { quantity: number; customUnitPrice?: number; notes?: string | null }>();
  for (const item of rawItems) {
    const prodId = Number(item?.menu_item_id);
    const qty = Math.round(Number(item?.quantity || 0));
    if (!Number.isInteger(prodId) || prodId <= 0 || qty <= 0) continue;
    const prev = mergedByProductId.get(prodId);
    if (prev) {
      prev.quantity += qty;
    } else {
      mergedByProductId.set(prodId, {
        quantity: qty,
        customUnitPrice: item.unit_price !== undefined ? Number(item.unit_price) : undefined,
        notes: item.notes || null,
      });
    }
  }

  const productIds = Array.from(mergedByProductId.keys());
  if (productIds.length === 0) return [];

  const prodRes = await client.query(
    `SELECT id, name, COALESCE(item_code, '') AS sku, COALESCE(price, 0) AS price,
            COALESCE(NULLIF(BTRIM(canonical_base_unit_code), ''), NULLIF(BTRIM(base_unit), ''), 'PCS') AS base_unit_code
       FROM pos_menu_items
      WHERE property_id = $1 AND id = ANY($2::int[])`,
    [propertyId, productIds]
  );

  const result: MinibarConsumedItemSnapshot[] = [];
  for (const row of prodRes.rows) {
    const pid = Number(row.id);
    const entry = mergedByProductId.get(pid);
    if (!entry) continue;
    const unitPrice = defaultRole === 'COMPLIMENTARY'
      ? 0
      : entry.customUnitPrice !== undefined && Number.isFinite(entry.customUnitPrice) && entry.customUnitPrice >= 0
      ? Math.round(entry.customUnitPrice)
      : Math.round(Number(row.price || 0));
    result.push({
      menu_item_id: pid,
      name: String(row.name || `Produk #${pid}`),
      sku: String(row.sku || ''),
      quantity: entry.quantity,
      unit_price: unitPrice,
      subtotal: unitPrice * entry.quantity,
      base_unit_code: String(row.base_unit_code || 'PCS').toUpperCase(),
      item_role: defaultRole,
      notes: entry.notes || null,
    });
  }

  return result;
}

/**
 * Internal helper: deducts stock from HKP for a list of items (either COMPLIMENTARY during cleaning
 * or PAID_MINIBAR during FO checkout confirmation).
 * Uses ROOM_MINIBAR_POSTING operation_type and clamps stock_balances at >= 0 so operations never crash.
 */
async function deductItemsFromHkpStock(
  client: PoolClient,
  params: {
    propertyId: number;
    operationKey: string;
    items: MinibarConsumedItemSnapshot[];
    isComplimentary: boolean;
    taskId: number;
    roomId?: number | null;
    roomNumber?: string | null;
    reservationId?: number | null;
    actorUserId?: string | null;
    actorName?: string | null;
    notes: string;
  }
) {
  const { propertyId, operationKey, items } = params;
  if (!items || items.length === 0) {
    return { deducted: false, operation_id: null, movements: [] };
  }

  // Idempotency check on stock_operations
  const existingOp = await client.query(
    `SELECT id FROM stock_operations WHERE property_id = $1 AND operation_key = $2 LIMIT 1`,
    [propertyId, operationKey]
  );
  if ((existingOp.rowCount ?? 0) > 0) {
    return {
      deducted: true,
      replayed: true,
      operation_id: Number(existingOp.rows[0].id),
      movements: [],
    };
  }

  const hkpLocation = await resolveHkpLocation(client, propertyId);

  const metadata = {
    source: params.isComplimentary ? 'HK_CLEANING_COMPLIMENTARY' : 'FO_CHECKOUT_MINIBAR_CONFIRM',
    is_complimentary: params.isComplimentary,
    task_id: params.taskId,
    room_id: params.roomId || null,
    room_number: params.roomNumber || null,
    reservation_id: params.reservationId || null,
    location_id: hkpLocation.id,
    location_code: hkpLocation.code,
    actor_name: params.actorName || 'Staff',
  };

  const opRes = await client.query(
    `INSERT INTO stock_operations (
       property_id, operation_type, operation_key, payload_fingerprint,
       notes, metadata, created_by, created_at
     ) VALUES ($1, 'ROOM_MINIBAR_POSTING', $2, $3, $4, $5, $6, NOW())
     RETURNING id`,
    [
      propertyId,
      operationKey,
      operationKey,
      params.notes,
      JSON.stringify(metadata),
      params.actorUserId && Number.isInteger(Number(params.actorUserId)) ? Number(params.actorUserId) : null,
    ]
  );
  const opId = Number(opRes.rows[0].id);

  const sortedItems = [...items].sort((a, b) => a.menu_item_id - b.menu_item_id);
  const movements: Array<{
    product_id: number;
    product_name: string;
    quantity: number;
    previous_balance: number;
    new_balance: number;
    location_code: string;
  }> = [];

  for (const item of sortedItems) {
    const balRes = await client.query(
      `SELECT id, quantity
         FROM stock_balances
        WHERE property_id = $1 AND product_id = $2 AND location_id = $3
        FOR UPDATE`,
      [propertyId, item.menu_item_id, hkpLocation.id]
    );

    const currentBalance = (balRes.rowCount ?? 0) > 0 ? Number(balRes.rows[0].quantity || 0) : 0;
    const deltaQty = -Math.abs(item.quantity);
    const nextBalance = Math.max(0, currentBalance + deltaQty);

    await client.query(
      `INSERT INTO stock_movements (
         operation_id, property_id, product_id, location_id,
         packaging_id, packaging_code, packaging_label,
         quantity_delta, base_unit_code, unit_cost, created_at
       ) VALUES ($1, $2, $3, $4, NULL, NULL, NULL, $5, $6, $7, NOW())`,
      [
        opId,
        propertyId,
        item.menu_item_id,
        hkpLocation.id,
        deltaQty.toFixed(3),
        item.base_unit_code || 'PCS',
        item.unit_price || 0,
      ]
    );

    if ((balRes.rowCount ?? 0) > 0) {
      await client.query(
        `UPDATE stock_balances
            SET quantity = $1, updated_at = NOW()
          WHERE property_id = $2 AND product_id = $3 AND location_id = $4`,
        [nextBalance.toFixed(3), propertyId, item.menu_item_id, hkpLocation.id]
      );
    } else {
      await client.query(
        `INSERT INTO stock_balances (property_id, product_id, location_id, quantity, updated_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [propertyId, item.menu_item_id, hkpLocation.id, nextBalance.toFixed(3)]
      );
    }

    movements.push({
      product_id: item.menu_item_id,
      product_name: item.name,
      quantity: item.quantity,
      previous_balance: currentBalance,
      new_balance: nextBalance,
      location_code: hkpLocation.code,
    });
  }

  return {
    deducted: true,
    replayed: false,
    operation_id: opId,
    location: hkpLocation,
    movements,
  };
}

/**
 * Executed when a Room Attendant completes ROOM_CLEANING / STAYOVER_CLEANING / DEEP_CLEAN.
 * Automatically deducts Complimentary items (e.g. Mineral Water) from HKP warehouse.
 */
export async function processCleaningComplimentaryAndRestock(
  client: PoolClient,
  params: {
    propertyId: number;
    taskId: number;
    roomId: number;
    roomNumber?: string | null;
    explicitComplimentaryItems?: MinibarConsumedItemInput[] | null;
    explicitStockedMinibarItems?: MinibarConsumedItemInput[] | null;
    actorUserId?: string | null;
    actorName?: string | null;
  }
) {
  const { propertyId, taskId, roomId } = params;
  let itemsToDeduct: MinibarConsumedItemSnapshot[] = [];
  let stockedMinibarItems: MinibarConsumedItemSnapshot[] = [];

  const ctx = await getMinibarCatalogAndRoomContext(client, propertyId, { roomId });

  if (Array.isArray(params.explicitComplimentaryItems)) {
    itemsToDeduct = await normalizeMinibarItemsList(
      client,
      propertyId,
      params.explicitComplimentaryItems,
      'COMPLIMENTARY'
    );
  } else {
    const rawDefaults = ctx.complimentary_defaults.map((d) => ({
      menu_item_id: d.menu_item_id,
      quantity: d.standard_qty,
      unit_price: 0,
    }));
    itemsToDeduct = await normalizeMinibarItemsList(client, propertyId, rawDefaults, 'COMPLIMENTARY');
  }

  if (Array.isArray(params.explicitStockedMinibarItems)) {
    stockedMinibarItems = await normalizeMinibarItemsList(
      client,
      propertyId,
      params.explicitStockedMinibarItems,
      'PAID_MINIBAR'
    );
  } else {
    const rawMinibarDefaults = ctx.minibar_defaults.map((d) => ({
      menu_item_id: d.menu_item_id,
      quantity: d.standard_qty,
      unit_price: d.unit_price,
    }));
    stockedMinibarItems = await normalizeMinibarItemsList(client, propertyId, rawMinibarDefaults, 'PAID_MINIBAR');
  }

  if (itemsToDeduct.length === 0 && stockedMinibarItems.length === 0) {
    return null;
  }

  const summaryLabel = itemsToDeduct.map((i) => `${i.quantity}x ${i.name}`).join(', ');
  const deduction =
    itemsToDeduct.length > 0
      ? await deductItemsFromHkpStock(client, {
          propertyId,
          operationKey: `HK_CLEANING_COMP_TASK_${taskId}`,
          items: itemsToDeduct,
          isComplimentary: true,
          taskId,
          roomId,
          roomNumber: params.roomNumber || null,
          actorUserId: params.actorUserId || null,
          actorName: params.actorName || 'Room Attendant',
          notes: `Complimentary Kamar ${params.roomNumber || `#${roomId}`} (Task #${taskId}): ${summaryLabel}`,
        })
      : { deducted: false, operation_id: null, location: ctx.hkp_location, movements: [] };

  const meta = {
    processed_at: new Date().toISOString(),
    processed_by: params.actorName || 'Room Attendant',
    location_code: deduction.location?.code || 'HKP',
    operation_id: deduction.operation_id,
    complimentary_items: itemsToDeduct,
    stocked_minibar_items: stockedMinibarItems,
    movements: deduction.movements,
  };

  await client.query(
    `UPDATE housekeeping_tasks
        SET complimentary_restock_meta = $1::jsonb,
            updated_at = NOW()
      WHERE id = $2 AND property_id = $3`,
    [JSON.stringify(meta), taskId, propertyId]
  );

  return meta;
}

/**
 * Stocks Complimentary & Paid Minibar into rooms that are ALREADY in READY state (VACANT_CLEAN / INSPECTED / OCCUPIED_CLEAN)
 * without changing their room status or requiring a full re-clean.
 */
export async function stockReadyRoomsMinibarAndComplimentary(
  client: PoolClient,
  params: {
    propertyId: number;
    roomIds?: number[] | null;
    applyAllReadyRooms?: boolean;
    deductComplimentary?: boolean;
    explicitComplimentaryItems?: MinibarConsumedItemInput[] | null;
    explicitStockedMinibarItems?: MinibarConsumedItemInput[] | null;
    actorUserId?: string | null;
    actorName?: string | null;
  }
) {
  const { propertyId } = params;
  const deductComp = params.deductComplimentary !== false;
  const actorName = params.actorName || 'Housekeeping';
  const todayKey = new Date().toISOString().slice(0, 10);

  let targetRooms: Array<{ id: number; room_number: string; status: string }> = [];
  if (!params.applyAllReadyRooms && Array.isArray(params.roomIds) && params.roomIds.length > 0) {
    const cleanIds = params.roomIds.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const rRes = await client.query(
      `SELECT id, room_number, status FROM rooms WHERE property_id = $1 AND id = ANY($2::int[]) ORDER BY room_number ASC`,
      [propertyId, cleanIds]
    );
    targetRooms = rRes.rows.map((r: any) => ({
      id: Number(r.id),
      room_number: String(r.room_number || ''),
      status: String(r.status || 'VACANT_CLEAN'),
    }));
  } else {
    const rRes = await client.query(
      `SELECT id, room_number, status
         FROM rooms
        WHERE property_id = $1
          AND UPPER(COALESCE(status, '')) IN ('VACANT_CLEAN', 'INSPECTED', 'OCCUPIED_CLEAN')
        ORDER BY room_number ASC`,
      [propertyId]
    );
    targetRooms = rRes.rows.map((r: any) => ({
      id: Number(r.id),
      room_number: String(r.room_number || ''),
      status: String(r.status || 'VACANT_CLEAN'),
    }));
  }

  if (targetRooms.length === 0) {
    throw Object.assign(new Error('Tidak ada kamar berstatus Siap Huni (Ready) yang dipilih.'), {
      statusCode: 400,
      code: 'NO_READY_ROOMS',
    });
  }

  const processedRooms: Array<{
    room_id: number;
    room_number: string;
    complimentary_count: number;
    minibar_count: number;
    deducted_hkp: boolean;
  }> = [];

  for (const rm of targetRooms) {
    const ctx = await getMinibarCatalogAndRoomContext(client, propertyId, { roomId: rm.id });
    const rawComp = Array.isArray(params.explicitComplimentaryItems)
      ? params.explicitComplimentaryItems
      : ctx.complimentary_defaults.map((d) => ({
          menu_item_id: d.menu_item_id,
          quantity: d.standard_qty,
          unit_price: 0,
        }));
    const rawMb = Array.isArray(params.explicitStockedMinibarItems)
      ? params.explicitStockedMinibarItems
      : ctx.minibar_defaults.map((d) => ({
          menu_item_id: d.menu_item_id,
          quantity: d.standard_qty,
          unit_price: d.unit_price,
        }));

    const compSnapshot = await normalizeMinibarItemsList(client, propertyId, rawComp, 'COMPLIMENTARY');
    const mbSnapshot = await normalizeMinibarItemsList(client, propertyId, rawMb, 'PAID_MINIBAR');

    // Find most recent completed cleaning task for this room, or create a completed restock record
    let targetTaskId: number | null = null;
    const lastTaskRes = await client.query(
      `SELECT id
         FROM housekeeping_tasks
        WHERE property_id = $1
          AND room_id = $2
          AND task_type IN ('ROOM_CLEANING', 'STAYOVER_CLEANING', 'DEEP_CLEAN', 'VIP_ROOM_PREPARATION')
          AND status IN ('DONE', 'VERIFIED')
        ORDER BY completed_at DESC NULLS LAST, id DESC
        LIMIT 1`,
      [propertyId, rm.id]
    );

    if ((lastTaskRes.rowCount ?? 0) > 0) {
      targetTaskId = Number(lastTaskRes.rows[0].id);
    } else {
      const taskNo = `HK-MB-INIT-${rm.room_number}-${Date.now().toString().slice(-5)}`;
      const insTask = await client.query(
        `INSERT INTO housekeeping_tasks (
           property_id, task_number, room_id, room_number,
           task_category, task_type, title, description,
           priority, status, assigned_department, assigned_user_name_snapshot,
           cleaned_by_name, completed_at, completion_note, source_type, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4,
           'ROOM_OPERATIONS', 'ROOM_CLEANING', $5, 'Pengisian Standar Minibar & Complimentary Kamar Siap Huni',
           'NORMAL', 'DONE', 'Housekeeping', $6,
           $6, NOW(), 'Pengisian Minibar & Complimentary pada kamar yang sudah Ready', 'READY_ROOM_RESTOCK', NOW(), NOW()
         ) RETURNING id`,
        [propertyId, taskNo, rm.id, rm.room_number, `Restock Minibar & Complimentary Kamar ${rm.room_number}`, actorName]
      );
      targetTaskId = Number(insTask.rows[0].id);
    }

    let deductionResult: any = { deducted: false, operation_id: null, movements: [] };
    if (deductComp && compSnapshot.length > 0) {
      const summaryLabel = compSnapshot.map((i) => `${i.quantity}x ${i.name}`).join(', ');
      deductionResult = await deductItemsFromHkpStock(client, {
        propertyId,
        operationKey: `HK_READY_COMP_ROOM_${rm.id}_${todayKey}`,
        items: compSnapshot,
        isComplimentary: true,
        taskId: targetTaskId,
        roomId: rm.id,
        roomNumber: rm.room_number,
        actorUserId: params.actorUserId || null,
        actorName,
        notes: `Complimentary Kamar Ready ${rm.room_number}: ${summaryLabel}`,
      });
    }

    const meta = {
      processed_at: new Date().toISOString(),
      processed_by: actorName,
      source: 'READY_ROOM_RESTOCK',
      location_code: ctx.hkp_location.code,
      operation_id: deductionResult.operation_id || null,
      complimentary_items: compSnapshot,
      stocked_minibar_items: mbSnapshot,
      movements: deductionResult.movements || [],
    };

    await client.query(
      `UPDATE housekeeping_tasks
          SET complimentary_restock_meta = $1::jsonb,
              updated_at = NOW()
        WHERE id = $2 AND property_id = $3`,
      [JSON.stringify(meta), targetTaskId, propertyId]
    );

    processedRooms.push({
      room_id: rm.id,
      room_number: rm.room_number,
      complimentary_count: compSnapshot.reduce((s, i) => s + i.quantity, 0),
      minibar_count: mbSnapshot.reduce((s, i) => s + i.quantity, 0),
      deducted_hkp: Boolean(deductionResult.deducted && !deductionResult.replayed),
    });
  }

  return {
    rooms_count: processedRooms.length,
    processed_rooms: processedRooms,
  };
}

/**
 * Front Office confirmation of Checkout Minibar consumption:
 * 1. Deducts consumed Minibar items from HKP stock location.
 * 2. Posts Minibar charge to Reservation Folio (and projects to Transactions).
 * 3. Handles settlement mode:
 *    - 'FOLIO': Charge added to reservation balance (paid at checkout).
 *    - 'DEPOSIT': Charge added to reservation folio AND automatically deducted from guest's active room deposit.
 *    - 'DIRECT_PAY': Charge added to reservation folio AND immediately settled as PAID with the chosen payment method (CASH/QRIS/TRANSFER/CARD).
 *    - 'WAIVE': Marks minibar charge as WAIVED without billing or deducting stock.
 */
export async function confirmCheckoutMinibarBilling(
  client: PoolClient,
  input: ConfirmCheckoutMinibarInput
) {
  const { propertyId, taskId, settlementMode } = input;
  const actorName = input.actorName || 'Front Office';
  const actorRole = input.actorRole || 'Receptionist';

  // 1. Lock housekeeping_tasks row
  const taskRes = await client.query(
    `SELECT t.*, r.room_number
       FROM housekeeping_tasks t
       LEFT JOIN rooms r ON r.id = t.room_id
      WHERE t.id = $1 AND t.property_id = $2
      FOR UPDATE OF t`,
    [taskId, propertyId]
  );
  if ((taskRes.rowCount ?? 0) === 0) {
    throw Object.assign(new Error(`Tugas pemeriksaan #${taskId} tidak ditemukan`), {
      statusCode: 404,
      code: 'TASK_NOT_FOUND',
    });
  }
  const task = taskRes.rows[0];

  // Idempotent replay check
  if (task.minibar_billing_status === 'CONFIRMED_BILLED' && task.minibar_billing_meta) {
    return {
      replayed: true,
      task_id: taskId,
      minibar_billing_status: task.minibar_billing_status,
      minibar_billing_meta: task.minibar_billing_meta,
    };
  }

  // 2. Resolve items to confirm
  const rawItemsInput: MinibarConsumedItemInput[] = Array.isArray(input.items)
    ? input.items
    : Array.isArray(task.minibar_items_json)
    ? task.minibar_items_json
    : [];

  const confirmedItems = await normalizeMinibarItemsList(client, propertyId, rawItemsInput, 'PAID_MINIBAR');
  const totalAmount = confirmedItems.reduce((acc, it) => acc + it.subtotal, 0);

  if (settlementMode === 'WAIVE' || confirmedItems.length === 0 || totalAmount <= 0) {
    const waiveMeta = {
      confirmed_at: new Date().toISOString(),
      confirmed_by: actorName,
      settlement_mode: 'WAIVE',
      total_amount: 0,
      notes: input.notes || 'Tagihan minibar dibebaskan / tidak ditagihkan',
      confirmed_items: [],
    };
    await client.query(
      `UPDATE housekeeping_tasks
          SET minibar_billing_status = 'WAIVED',
              minibar_billing_meta = $1::jsonb,
              updated_at = NOW()
        WHERE id = $2 AND property_id = $3`,
      [JSON.stringify(waiveMeta), taskId, propertyId]
    );
    return {
      replayed: false,
      task_id: taskId,
      minibar_billing_status: 'WAIVED',
      minibar_billing_meta: waiveMeta,
    };
  }

  // 3. Resolve reservationId
  let reservationId = input.reservationId
    ? Number(input.reservationId)
    : task.reservation_id
    ? Number(task.reservation_id)
    : null;

  if (!reservationId && task.room_id) {
    const latestRes = await client.query(
      `SELECT r.id
         FROM reservations r
         JOIN bookings b ON b.id = r.booking_id
        WHERE b.property_id = $1
          AND r.room_id = $2
          AND r.status IN ('CHECKED_IN', 'CHECKED_OUT')
        ORDER BY
          CASE WHEN r.status = 'CHECKED_IN' THEN 0 ELSE 1 END,
          r.id DESC
        LIMIT 1`,
      [propertyId, task.room_id]
    );
    if ((latestRes.rowCount ?? 0) > 0) {
      reservationId = Number(latestRes.rows[0].id);
    }
  }

  const roomNumber = task.room_number ? String(task.room_number) : null;
  const itemsSummary = confirmedItems
    .map((it) => `${it.quantity}x ${it.name} (@Rp ${it.unit_price.toLocaleString('id-ID')})`)
    .join(', ');
  const folioDesc = `Minibar Kamar ${roomNumber || ''}: ${itemsSummary}`.slice(0, 250);

  // 4. Deduct consumed minibar stock from HKP
  const stockDeduction = await deductItemsFromHkpStock(client, {
    propertyId,
    operationKey: `HK_MINIBAR_CHECKOUT_TASK_${taskId}`,
    items: confirmedItems,
    isComplimentary: false,
    taskId,
    roomId: task.room_id ? Number(task.room_id) : null,
    roomNumber,
    reservationId,
    actorUserId: input.actorUserId || null,
    actorName,
    notes: `${folioDesc}`,
  });

  let folioEntryId: number | null = null;
  let depositAppliedAmount = 0;
  let directPaidAmount = 0;
  let updatedFinancials: any = null;
  const effectivePaymentMethod = String(input.paymentMethod || 'CASH').trim().toUpperCase();

  // 5. Post to Reservation Folio & Process Settlement
  if (reservationId) {
    const resLock = await client.query(
      `SELECT r.*, b.property_id AS booking_property_id
         FROM reservations r
         JOIN bookings b ON b.id = r.booking_id
        WHERE r.id = $1 AND b.property_id = $2
        FOR UPDATE OF r`,
      [reservationId, propertyId]
    );

    if ((resLock.rowCount ?? 0) > 0) {
      const resRow = resLock.rows[0];

      // Safeguard: ensure baseline ROOM_CHARGE folio entry exists if legacy reservation had 0 debit entries
      const existingChargeCheck = await client.query(
        `SELECT COUNT(*)::int AS cnt
           FROM folio_entries
          WHERE reservation_id = $1 AND direction = 'DEBIT' AND COALESCE(is_voided, FALSE) = FALSE`,
        [reservationId]
      );
      if (Number(existingChargeCheck.rows[0]?.cnt || 0) === 0 && Number(resRow.total_price || 0) > 0) {
        const basePrice = Math.round(Number(resRow.total_price || 0));
        await client.query(
          `INSERT INTO folio_entries (
             reservation_id, property_id, entry_type, source_type, description,
             amount, direction, base_amount, unit_price, quantity, status
           ) VALUES ($1, $2, 'ROOM_CHARGE', 'ROOM_CHARGE', 'Reservasi kamar', $3, 'DEBIT', $3, $3, 1, 'POSTED')`,
          [reservationId, propertyId, basePrice]
        );
      }

      // Insert Minibar DEBIT folio entry
      const folioIns = await client.query(
        `INSERT INTO folio_entries (
           reservation_id, property_id, entry_type, source_type, source_id,
           description, amount, direction, base_amount, unit_price, quantity,
           tax_amount, service_amount, status, notes, revenue_category,
           actor_user_id, actor_name_snapshot, actor_role_snapshot
         ) VALUES (
           $1, $2, 'MINIBAR', 'MINIBAR', $3,
           $4, $5, 'DEBIT', $5, $5, 1,
           0, 0, 'POSTED', $6, 'MINIBAR_SALES',
           $7, $8, $9
         ) RETURNING id`,
        [
          reservationId,
          propertyId,
          String(taskId),
          folioDesc,
          totalAmount,
          input.notes || null,
          input.actorUserId || null,
          actorName,
          actorRole,
        ]
      );
      folioEntryId = Number(folioIns.rows[0].id);

      // Project to Transaction domain (Pusat Transaksi -> Penjualan Minibar)
      const projectedTx = await projectFolioEntryToTransaction(client, folioEntryId, {
        propertyId,
        actorName,
        actorUserId: input.actorUserId || undefined,
      });

      if (settlementMode === 'DEPOSIT') {
        // Find open deposits for this reservation / group booking
        const depsRes = await client.query(
          `SELECT d.*
             FROM deposits d
            WHERE d.property_id = $1
              AND (
                d.reservation_id = $2
                OR (d.scope = 'BOOKING_GROUP' AND d.booking_id = $3)
              )
            ORDER BY CASE WHEN d.reservation_id = $2 THEN 0 ELSE 1 END, d.id ASC
            FOR UPDATE`,
          [propertyId, reservationId, resRow.booking_id || 0]
        );

        let remainingToCover = totalAmount;
        for (const dep of depsRes.rows) {
          if (remainingToCover <= 0) break;
          const evRes = await client.query(
            `SELECT * FROM deposit_events WHERE deposit_id = $1 ORDER BY id ASC`,
            [dep.id]
          );
          const bal = deriveDepositBalance(evRes.rows);
          if (bal.remaining <= 0 || bal.status === 'CANCELLED' || bal.status === 'CLOSED') {
            continue;
          }

          const applyAmt = Math.min(remainingToCover, bal.remaining);
          if (applyAmt <= 0) continue;

          const depFolioRes = await client.query(
            `INSERT INTO folio_entries (
               reservation_id, property_id, entry_type, description, amount, direction,
               source_type, source_id, status, actor_user_id, actor_name_snapshot,
               actor_role_snapshot, base_amount, unit_price, quantity, notes
             ) VALUES (
               $1, $2, 'DEPOSIT_APPLY', $3, $4, 'CREDIT',
               'DEPOSIT', $5, 'POSTED', $6, $7, $8, $4, $4, 1, $9
             ) RETURNING id`,
            [
              reservationId,
              propertyId,
              `Potong Deposit Kamar (${dep.deposit_number}) — Minibar Kamar ${roomNumber || ''}`,
              applyAmt,
              String(dep.id),
              input.actorUserId || null,
              actorName,
              actorRole,
              `Potong deposit untuk Minibar Task #${taskId}`,
            ]
          );

          const depIdemKey = `mb_dep_apply_task_${taskId}_dep_${dep.id}`;
          await client.query(
            `INSERT INTO deposit_events (
               deposit_id, property_id, reservation_id, event_type, amount,
               folio_entry_id, idempotency_key, performed_by, notes
             ) VALUES ($1, $2, $3, 'APPLY', $4, $5, $6, $7, $8)`,
            [
              dep.id,
              propertyId,
              reservationId,
              applyAmt,
              depFolioRes.rows[0].id,
              depIdemKey,
              actorName,
              `Pemotongan otomatis tagihan Minibar Kamar ${roomNumber || ''}`,
            ]
          );

          const nextEventsRes = await client.query(
            `SELECT * FROM deposit_events WHERE deposit_id = $1 ORDER BY id ASC`,
            [dep.id]
          );
          const nextBal = deriveDepositBalance(nextEventsRes.rows);
          await client.query(
            `UPDATE deposits SET status = $1, updated_at = NOW() WHERE id = $2`,
            [nextBal.status, dep.id]
          );

          depositAppliedAmount += applyAmt;
          remainingToCover -= applyAmt;
        }

        if (depositAppliedAmount <= 0) {
          throw Object.assign(
            new Error('Tamu tidak memiliki saldo deposit aktif yang cukup untuk dipotong. Pilih pembayaran langsung atau masukkan ke tagihan kamar.'),
            { statusCode: 409, code: 'INSUFFICIENT_DEPOSIT_BALANCE' }
          );
        }

        if (projectedTx && depositAppliedAmount >= totalAmount) {
          await client.query(
            `UPDATE transactions
                SET payment_status = 'PAID',
                    payment_method = 'DEPOSIT',
                    updated_at = NOW()
              WHERE id = $1`,
            [projectedTx.id]
          );
        }
      } else if (settlementMode === 'DIRECT_PAY') {
        const refCode = `MB-PAY-${taskId}-${Date.now()}`;
        const corrId = `corr_mb_pay_${taskId}_${crypto.randomUUID().slice(0, 8)}`;

        await client.query(
          `INSERT INTO payment_transactions (
             reservation_id, property_id, transaction_type, amount, payment_method,
             reference_code, status, created_by, correction_group_id, booking_id, scope
           ) VALUES ($1, $2, 'PAYMENT', $3, $4, $5, 'SUCCESS', $6, $7, $8, 'ROOM_RESERVATION')`,
          [
            reservationId,
            propertyId,
            totalAmount,
            effectivePaymentMethod,
            refCode,
            actorName,
            corrId,
            resRow.booking_id || null,
          ]
        );

        await client.query(
          `INSERT INTO folio_entries (
             reservation_id, property_id, entry_type, description, amount, direction, status
           ) VALUES ($1, $2, 'PAYMENT', $3, $4, 'CREDIT', 'POSTED')`,
          [
            reservationId,
            propertyId,
            `Pembayaran Lunas Minibar Kamar ${roomNumber || ''} (${effectivePaymentMethod})`,
            totalAmount,
          ]
        );

        directPaidAmount = totalAmount;

        if (projectedTx) {
          await client.query(
            `UPDATE transactions
                SET payment_status = 'PAID',
                    payment_method = $2,
                    updated_at = NOW()
              WHERE id = $1`,
            [projectedTx.id, effectivePaymentMethod]
          );
        }
      }

      updatedFinancials = await recalculateReservationFinancials(client, reservationId, propertyId);
    }
  }

  const billingMeta = {
    confirmed_at: new Date().toISOString(),
    confirmed_by: actorName,
    confirmed_role: actorRole,
    settlement_mode: settlementMode,
    payment_method:
      settlementMode === 'DIRECT_PAY'
        ? effectivePaymentMethod
        : settlementMode === 'DEPOSIT'
        ? 'DEPOSIT'
        : 'FOLIO',
    total_amount: totalAmount,
    deposit_applied_amount: depositAppliedAmount,
    direct_paid_amount: directPaidAmount,
    folio_entry_id: folioEntryId,
    reservation_id: reservationId,
    stock_operation_id: stockDeduction.operation_id,
    stock_location_code: stockDeduction.location?.code || 'HKP',
    confirmed_items: confirmedItems,
    notes: input.notes || null,
  };

  await client.query(
    `UPDATE housekeeping_tasks
        SET minibar_items_json = $1::jsonb,
            minibar_billing_status = 'CONFIRMED_BILLED',
            minibar_billing_meta = $2::jsonb,
            estimated_charge = $3,
            issue_note = COALESCE(NULLIF(issue_note, ''), $4),
            updated_at = NOW()
      WHERE id = $5 AND property_id = $6`,
    [
      JSON.stringify(confirmedItems),
      JSON.stringify(billingMeta),
      totalAmount,
      folioDesc,
      taskId,
      propertyId,
    ]
  );

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ('HOUSEKEEPING', 'MINIBAR_CHECKOUT_CONFIRMED_BILLED', 'HOUSEKEEPING_TASK', $1, $2, $3, $4)`,
    [String(taskId), JSON.stringify(billingMeta), actorName, propertyId]
  );

  return {
    replayed: false,
    task_id: taskId,
    reservation_id: reservationId,
    minibar_billing_status: 'CONFIRMED_BILLED',
    minibar_billing_meta: billingMeta,
    reservation_financials: updatedFinancials
      ? {
          total_price: updatedFinancials.total_price,
          amount_paid: updatedFinancials.amount_paid,
          applied_deposit: updatedFinancials.applied_deposit,
          remaining_balance: updatedFinancials.remaining_balance,
          payment_status: updatedFinancials.payment_status,
        }
      : null,
  };
}
