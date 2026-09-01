import { Pool, PoolClient } from 'pg';
import {
  TransactionType,
  TransactionStatus,
  VerificationStatus,
  ReceivingStatus,
  AttachmentPurpose,
  DepartmentCode,
  TransactionRow,
  TransactionLine,
  TransactionLineInput,
  TransactionAttachment,
  CreateTransactionInput,
  CreateManualTransactionDto,
  CreatePurchaseTransactionDto,
  CreateExpenseTransactionDto,
  CreateIncomeTransactionDto,
  VerifyTransactionDto,
  CreateCustomCategoryDto,
  CustomCategoryRow,
  UpdateReceivingStatusDto,
  SettleTransactionPaymentDto,
  SoftDeleteTransactionDto,
  OperationalSheet,
  TransactionSheetCounts,
  TransactionQueryResult,
  TransactionFilterParams,
  TransactionSummary
} from './transactionTypes';
import { generateTransactionNumber, getHotelDateToday } from './transactionNumberService';
import { generateSupplierCode } from '../suppliers/supplierService';

export const TRANSACTION_CATEGORIES: Record<
  string,
  { name: string; type: TransactionType; defaultDept: DepartmentCode; allowManual: boolean }
> = {
  ROOM_SALES: { name: 'Penjualan Kamar', type: 'SALE', defaultDept: 'FRONT_OFFICE', allowManual: false },
  DAY_USE_SALES: { name: 'Penjualan Kamar (Day Use)', type: 'SALE', defaultDept: 'FRONT_OFFICE', allowManual: false },
  EXTRA_BED_SALES: { name: 'Extra Bed', type: 'SALE', defaultDept: 'HOUSEKEEPING', allowManual: false },
  EXTRA_PERSON_SALES: { name: 'Extra Person', type: 'SALE', defaultDept: 'FRONT_OFFICE', allowManual: false },
  EARLY_CHECKIN_SALES: { name: 'Early Check-in', type: 'SALE', defaultDept: 'FRONT_OFFICE', allowManual: false },
  LATE_CHECKOUT_SALES: { name: 'Late Check-out', type: 'SALE', defaultDept: 'FRONT_OFFICE', allowManual: false },
  FNB_SALES: { name: 'Restoran / F&B / POS', type: 'SALE', defaultDept: 'FNB', allowManual: false },
  MINIBAR_SALES: { name: 'Minibar', type: 'SALE', defaultDept: 'HOUSEKEEPING', allowManual: true },
  LAUNDRY_SALES: { name: 'Laundry Tamu', type: 'SALE', defaultDept: 'HOUSEKEEPING', allowManual: true },
  BANQUET_SALES: { name: 'Banquet & Event', type: 'SALE', defaultDept: 'FNB', allowManual: true },
  OTHER_SALES: { name: 'Penjualan Lainnya', type: 'SALE', defaultDept: 'GENERAL', allowManual: true },

  PENALTY_INCOME: { name: 'Denda & Penggantian Fasilitas', type: 'INCOME', defaultDept: 'FRONT_OFFICE', allowManual: false },
  CAPITAL_INJECTION: { name: 'Setoran Modal / Kas Masuk', type: 'INCOME', defaultDept: 'ADMIN', allowManual: true },
  REFUND_RECEIVED: { name: 'Penerimaan Pengembalian Dana', type: 'INCOME', defaultDept: 'ADMIN', allowManual: true },
  OTHER_INCOME: { name: 'Pemasukan Lain-lain', type: 'INCOME', defaultDept: 'GENERAL', allowManual: true },

  SUPPLIES_PURCHASE: { name: 'Pembelian Perlengkapan Kantor / FO', type: 'PURCHASE', defaultDept: 'FRONT_OFFICE', allowManual: true },
  AMENITIES_PURCHASE: { name: 'Pembelian Amenities & Perlengkapan Kamar', type: 'PURCHASE', defaultDept: 'HOUSEKEEPING', allowManual: true },
  LINEN_PURCHASE: { name: 'Pembelian Linen & Bedding', type: 'PURCHASE', defaultDept: 'HOUSEKEEPING', allowManual: true },
  FNB_INGREDIENTS_PURCHASE: { name: 'Pembelian Bahan Baku Makanan & Minuman', type: 'PURCHASE', defaultDept: 'FNB', allowManual: true },
  MAINTENANCE_PARTS_PURCHASE: { name: 'Pembelian Suku Cadang & Alat Perbaikan', type: 'PURCHASE', defaultDept: 'MAINTENANCE', allowManual: true },
  OUTSOURCED_SERVICES: { name: 'Jasa Pihak Ketiga / Outsourcing', type: 'PURCHASE', defaultDept: 'ADMIN', allowManual: true },
  OTHER_PURCHASE: { name: 'Pembelian Barang Lainnya', type: 'PURCHASE', defaultDept: 'GENERAL', allowManual: true },

  PETTY_CASH: { name: 'Kas Kecil / Operasional Harian', type: 'EXPENSE', defaultDept: 'FRONT_OFFICE', allowManual: true },
  TRANSPORT_EXPENSE: { name: 'Transportasi & Kurir', type: 'EXPENSE', defaultDept: 'FRONT_OFFICE', allowManual: true },
  UTILITIES_EXPENSE: { name: 'Listrik, Air & Internet', type: 'EXPENSE', defaultDept: 'MAINTENANCE', allowManual: true },
  MAINTENANCE_EXPENSE: { name: 'Biaya Pemeliharaan & Perbaikan', type: 'EXPENSE', defaultDept: 'MAINTENANCE', allowManual: true },
  CLEANING_SUPPLIES: { name: 'Bahan Pembersih & Kebersihan', type: 'EXPENSE', defaultDept: 'HOUSEKEEPING', allowManual: true },
  MARKETING_EXPENSE: { name: 'Pemasaran & Komisi OTA', type: 'EXPENSE', defaultDept: 'ADMIN', allowManual: true },
  ADMIN_BANK_FEE: { name: 'Biaya Administrasi Bank / QRIS / EDC', type: 'EXPENSE', defaultDept: 'ADMIN', allowManual: true },
  SALARY_EXPENSE: { name: 'Gaji & Upah Karyawan', type: 'EXPENSE', defaultDept: 'HRD', allowManual: true },
  REIMBURSEMENT: { name: 'Reimbursement Staf', type: 'EXPENSE', defaultDept: 'ADMIN', allowManual: true },
  OTHER_EXPENSE: { name: 'Pengeluaran Lainnya', type: 'EXPENSE', defaultDept: 'GENERAL', allowManual: true },
};

export const DEPARTMENTS: { code: DepartmentCode; name: string }[] = [
  { code: 'FRONT_OFFICE', name: 'Front Office' },
  { code: 'HOUSEKEEPING', name: 'Housekeeping' },
  { code: 'FNB', name: 'F&B / Restoran' },
  { code: 'MAINTENANCE', name: 'Engineering & Maintenance' },
  { code: 'ADMIN', name: 'Keuangan & Administrasi' },
  { code: 'HRD', name: 'HRD' },
  { code: 'GENERAL', name: 'Umum' },
];

/**
 * Authoritative Operational Lifecycle Sheet Derivation (TRANSACTION-2E).
 * Priority Rule:
 * 1. deleted_at -> HAPUS
 * 2. transaction_status in (CANCELLED, VOIDED, REVERSED) -> BATAL
 * 3. Fully completed -> SELESAI (PURCHASE: receiving_status=DITERIMA, others: transaction_status=POSTED)
 * 4. In-progress / Draft / Pending -> PROSES
 */
export function deriveOperationalSheet(row: {
  transaction_type: string;
  transaction_status: string;
  receiving_status?: string | null;
  deleted_at?: string | null;
}): OperationalSheet {
  if (row.deleted_at) {
    return 'HAPUS';
  }
  const status = String(row.transaction_status || '').toUpperCase();
  if (['VOIDED', 'CANCELLED', 'REVERSED'].includes(status)) {
    return 'BATAL';
  }
  const type = String(row.transaction_type || '').toUpperCase();
  if (type === 'PURCHASE') {
    const recStatus = String(row.receiving_status || '').toUpperCase();
    if (['DITERIMA', 'DITERIMA_LENGKAP'].includes(recStatus)) {
      return 'SELESAI';
    }
    return 'PROSES';
  }
  // For EXPENSE, INCOME, SALE:
  if (status === 'POSTED') {
    return 'SELESAI';
  }
  return 'PROSES';
}

export async function getCategoryMeta(
  poolOrClient: Pool | PoolClient,
  propertyId: number,
  categoryCode: string,
  fallbackType: TransactionType = 'EXPENSE'
): Promise<{ name: string; type: TransactionType; defaultDept: DepartmentCode; allowManual: boolean }> {
  const cat = TRANSACTION_CATEGORIES[categoryCode];
  if (cat) return cat;

  // Check custom categories table
  try {
    const res = await poolOrClient.query(
      `SELECT name, transaction_type, department_code, is_active
       FROM transaction_custom_categories
       WHERE property_id = $1 AND code = $2`,
      [propertyId, categoryCode]
    );
    if ((res.rowCount ?? 0) > 0) {
      const row = res.rows[0];
      return {
        name: row.name,
        type: row.transaction_type as TransactionType,
        defaultDept: (row.department_code || 'GENERAL') as DepartmentCode,
        allowManual: true
      };
    }
  } catch (_e) {
    // Ignore error and use fallback
  }

  return {
    name: categoryCode.replace(/_/g, ' '),
    type: fallbackType,
    defaultDept: 'GENERAL' as DepartmentCode,
    allowManual: true
  };
}

/**
 * Maps a folio entry into its canonical transaction representation.
 */
export async function projectFolioEntryToTransaction(
  client: PoolClient | Pool,
  folioEntryId: number,
  options: { propertyId?: number; actorName?: string; actorUserId?: string } = {}
): Promise<TransactionRow | null> {
  const entryRes = await client.query(
    `SELECT 
       fe.*,
       r.booking_id,
       r.room_id,
       r.guest_name,
       r.payment_status as reservation_payment_status,
       r.check_in,
       r.check_out,
       r.stay_type,
       ro.room_number,
       b.property_id as booking_prop_id,
       b.bid,
       b.guest_name_snapshot as booking_guest_name,
       g.id as canonical_guest_id
     FROM folio_entries fe
     LEFT JOIN reservations r ON r.id = fe.reservation_id
     LEFT JOIN rooms ro ON ro.id = r.room_id
     LEFT JOIN bookings b ON b.id = r.booking_id
     LEFT JOIN guests g ON LOWER(TRIM(g.full_name)) = LOWER(TRIM(COALESCE(r.guest_name, b.guest_name_snapshot)))
     WHERE fe.id = $1`,
    [folioEntryId]
  );

  if ((entryRes.rowCount ?? 0) === 0) {
    const err: any = new Error(`Folio entry #${folioEntryId} tidak ditemukan`);
    err.statusCode = 404;
    throw err;
  }

  const entry = entryRes.rows[0];
  const propertyId = options.propertyId || entry.property_id || entry.booking_prop_id || 1;

  if (entry.direction === 'CREDIT' && entry.entry_type !== 'REVERSAL') {
    return null;
  }

  if (entry.entry_type === 'REVERSAL' || entry.direction === 'CREDIT') {
    const originalFolioEntryId = entry.reference_folio_entry_id || entry.related_folio_id || entry.source_id;
    if (!originalFolioEntryId) {
      return null;
    }

    const origTxRes = await client.query(
      `SELECT * FROM transactions 
       WHERE property_id = $1 AND source_id = $2 AND reversal_of_transaction_id IS NULL
       LIMIT 1`,
      [propertyId, String(originalFolioEntryId)]
    );

    if ((origTxRes.rowCount ?? 0) > 0) {
      const origTx = origTxRes.rows[0];

      const existingRevTx = await client.query(
        `SELECT * FROM transactions 
         WHERE property_id = $1 AND source_id = $2 AND reversal_of_transaction_id = $3
         LIMIT 1`,
        [propertyId, String(folioEntryId), origTx.id]
      );

      if ((existingRevTx.rowCount ?? 0) > 0) {
        return existingRevTx.rows[0];
      }

      const txDate = getHotelDateToday(entry.created_at);
      const txNumber = await generateTransactionNumber(client, propertyId, txDate);
      const rawEntryBase = Number(entry.base_amount || 0);
      const baseAmt = Math.round(rawEntryBase > 0 ? rawEntryBase : Number(origTx.amount || 0));
      const rawEntryTax = Number(entry.tax_amount || 0);
      const taxAmt = Math.round(rawEntryTax > 0 ? rawEntryTax : Number(origTx.tax_amount || 0));
      const rawEntryServ = Number(entry.service_amount || 0);
      const servAmt = Math.round(rawEntryServ > 0 ? rawEntryServ : Number(origTx.service_amount || 0));
      const rawEntryNet = Number(entry.amount || 0);
      const netAmt = Math.round(rawEntryNet > 0 ? rawEntryNet : Number(origTx.net_amount || 0));

      const revInsert = await client.query(
        `INSERT INTO transactions (
          property_id, transaction_no, transaction_date, transaction_time,
          transaction_type, source_type, source_id, source_reference,
          category_code, category_name, department_code, description,
          amount, discount_amount, service_amount, tax_amount, net_amount,
          payment_status, payment_method, transaction_status,
          guest_id, guest_name_snapshot, room_number_snapshot,
          reservation_id, booking_id, reversal_of_transaction_id,
          correction_group_id, notes, metadata,
          created_by
        ) VALUES (
          $1, $2, $3, CURRENT_TIMESTAMP,
          $4, $5, $6, $7,
          $8, $9, $10, $11,
          $12, $13, $14, $15, $16,
          $17, $18, 'REVERSED',
          $19, $20, $21,
          $22, $23, $24,
          $25, $26, $27,
          $28
        ) RETURNING *`,
        [
          propertyId,
          txNumber,
          txDate,
          origTx.transaction_type,
          entry.source_type || origTx.source_type || 'REVERSAL',
          String(folioEntryId),
          origTx.source_reference,
          origTx.category_code,
          origTx.category_name,
          origTx.department_code,
          `Pembalik: ${entry.description || origTx.description}`,
          -Math.abs(baseAmt),
          0,
          -Math.abs(servAmt),
          -Math.abs(taxAmt),
          -Math.abs(netAmt),
          origTx.payment_status,
          origTx.payment_method,
          origTx.guest_id,
          origTx.guest_name_snapshot,
          origTx.room_number_snapshot,
          origTx.reservation_id,
          origTx.booking_id,
          origTx.id,
          entry.correction_group_id || origTx.correction_group_id,
          entry.notes || 'Reversal of posted folio charge',
          JSON.stringify({ reversed_folio_entry_id: originalFolioEntryId, original_transaction_no: origTx.transaction_no }),
          options.actorName || options.actorUserId || entry.actor_name_snapshot || 'SYSTEM'
        ]
      );

      await client.query(
        `UPDATE transactions SET transaction_status = 'REVERSED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [origTx.id]
      );

      return revInsert.rows[0];
    }
  }

  const chargeType = entry.source_type || entry.entry_type || 'ROOM_CHARGE';
  let txType: TransactionType = 'SALE';
  let categoryCode = 'ROOM_SALES';
  let categoryName = 'Penjualan Kamar';
  let departmentCode: DepartmentCode = 'FRONT_OFFICE';

  if (chargeType === 'PENALTY' || entry.revenue_category === 'OTHER_INCOME') {
    txType = 'INCOME';
    categoryCode = 'PENALTY_INCOME';
    categoryName = 'Denda & Penggantian Fasilitas';
    departmentCode = 'FRONT_OFFICE';
  } else if (chargeType === 'ROOM_CHARGE' || chargeType === 'STAY_EXTENSION') {
    txType = 'SALE';
    categoryCode = entry.stay_type === 'DAY_USE' ? 'DAY_USE_SALES' : 'ROOM_SALES';
    categoryName = chargeType === 'STAY_EXTENSION' ? 'Penjualan Kamar (Perpanjangan)' : (entry.stay_type === 'DAY_USE' ? 'Penjualan Kamar (Day Use)' : 'Penjualan Kamar');
    departmentCode = 'FRONT_OFFICE';
  } else if (chargeType === 'DAY_USE_ROOM') {
    txType = 'SALE';
    categoryCode = 'DAY_USE_SALES';
    categoryName = 'Penjualan Kamar (Day Use)';
    departmentCode = 'FRONT_OFFICE';
  } else if (chargeType === 'EXTRA_BED') {
    txType = 'SALE';
    categoryCode = 'EXTRA_BED_SALES';
    categoryName = 'Extra Bed';
    departmentCode = 'HOUSEKEEPING';
  } else if (chargeType === 'EXTRA_PERSON') {
    txType = 'SALE';
    categoryCode = 'EXTRA_PERSON_SALES';
    categoryName = 'Extra Person';
    departmentCode = 'FRONT_OFFICE';
  } else if (chargeType === 'EARLY_CHECKIN') {
    txType = 'SALE';
    categoryCode = 'EARLY_CHECKIN_SALES';
    categoryName = 'Early Check-in';
    departmentCode = 'FRONT_OFFICE';
  } else if (chargeType === 'LATE_CHECKOUT') {
    txType = 'SALE';
    categoryCode = 'LATE_CHECKOUT_SALES';
    categoryName = 'Late Check-out';
    departmentCode = 'FRONT_OFFICE';
  } else if (chargeType === 'POS' || chargeType === 'POS_ROOM_CHARGE' || chargeType === 'POS_ORDER' || chargeType === 'ROOM_SERVICE') {
    txType = 'SALE';
    categoryCode = 'FNB_SALES';
    categoryName = 'Restoran / F&B / POS';
    departmentCode = 'FNB';
  } else if (chargeType === 'MINIBAR') {
    txType = 'SALE';
    categoryCode = 'MINIBAR_SALES';
    categoryName = 'Minibar';
    departmentCode = 'HOUSEKEEPING';
  } else if (chargeType === 'LAUNDRY') {
    txType = 'SALE';
    categoryCode = 'LAUNDRY_SALES';
    categoryName = 'Laundry Tamu';
    departmentCode = 'HOUSEKEEPING';
  } else if (chargeType === 'BANQUET') {
    txType = 'SALE';
    categoryCode = 'BANQUET_SALES';
    categoryName = 'Banquet & Event';
    departmentCode = 'FNB';
  } else {
    txType = 'SALE';
    categoryCode = 'OTHER_SALES';
    categoryName = 'Penjualan Lainnya';
    departmentCode = 'GENERAL';
  }

  const rawBaseAmt = Number(entry.base_amount || 0);
  const rawUnitPrice = Number(entry.unit_price || 0);
  const rawQty = Number(entry.quantity || 1);
  const rawNetAmt = Number(entry.amount || 0);

  const baseAmt = Math.round(
    rawBaseAmt > 0
      ? rawBaseAmt
      : (rawUnitPrice > 0
          ? rawUnitPrice * rawQty
          : (rawNetAmt > 0 ? rawNetAmt : 0))
  );
  const taxAmt = Math.round(Number(entry.tax_amount || 0));
  const servAmt = Math.round(Number(entry.service_amount || 0));
  const netAmt = Math.round(rawNetAmt > 0 ? rawNetAmt : (baseAmt + taxAmt + servAmt));
  const txDate = getHotelDateToday(entry.created_at);

  const existingTx = await client.query(
    `SELECT * FROM transactions 
     WHERE property_id = $1 AND source_type = $2 AND source_id = $3 AND reversal_of_transaction_id IS NULL
     LIMIT 1`,
    [propertyId, chargeType, String(folioEntryId)]
  );

  if ((existingTx.rowCount ?? 0) > 0) {
    const updated = await client.query(
      `UPDATE transactions SET
         amount = $1,
         tax_amount = $2,
         service_amount = $3,
         net_amount = $4,
         description = $5,
         payment_status = $6,
         room_number_snapshot = COALESCE($7, room_number_snapshot),
         guest_name_snapshot = COALESCE($8, guest_name_snapshot),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $9
       RETURNING *`,
      [
        baseAmt,
        taxAmt,
        servAmt,
        netAmt,
        entry.description || categoryName,
        entry.reservation_payment_status || 'UNPAID',
        entry.room_number ? String(entry.room_number) : null,
        entry.guest_name || entry.booking_guest_name || null,
        existingTx.rows[0].id
      ]
    );
    return updated.rows[0];
  }

  const txNumber = await generateTransactionNumber(client, propertyId, txDate);

  const insertRes = await client.query(
    `INSERT INTO transactions (
      property_id, transaction_no, transaction_date, transaction_time,
      transaction_type, source_type, source_id, source_reference,
      category_code, category_name, department_code, description,
      amount, discount_amount, service_amount, tax_amount, net_amount,
      payment_status, payment_method, transaction_status,
      guest_id, guest_name_snapshot, room_number_snapshot,
      reservation_id, booking_id, correction_group_id, notes, metadata,
      created_by
    ) VALUES (
      $1, $2, $3, CURRENT_TIMESTAMP,
      $4, $5, $6, $7,
      $8, $9, $10, $11,
      $12, $13, $14, $15, $16,
      $17, $18, 'POSTED',
      $19, $20, $21,
      $22, $23, $24, $25, $26,
      $27
    )
    ON CONFLICT (property_id, source_type, source_id) 
    WHERE source_id IS NOT NULL AND reversal_of_transaction_id IS NULL
    DO UPDATE SET
      amount = EXCLUDED.amount,
      tax_amount = EXCLUDED.tax_amount,
      service_amount = EXCLUDED.service_amount,
      net_amount = EXCLUDED.net_amount,
      description = EXCLUDED.description,
      payment_status = EXCLUDED.payment_status,
      updated_at = CURRENT_TIMESTAMP
    RETURNING *`,
    [
      propertyId,
      txNumber,
      txDate,
      txType,
      chargeType,
      String(folioEntryId),
      entry.bid || `RES-${entry.reservation_id}`,
      categoryCode,
      categoryName,
      departmentCode,
      entry.description || categoryName,
      baseAmt,
      0,
      servAmt,
      taxAmt,
      netAmt,
      entry.reservation_payment_status || 'UNPAID',
      null,
      entry.canonical_guest_id || null,
      entry.guest_name || entry.booking_guest_name || null,
      entry.room_number ? String(entry.room_number) : null,
      entry.reservation_id,
      entry.booking_id || null,
      entry.correction_group_id || null,
      entry.notes || null,
      JSON.stringify({
        folio_entry_id: folioEntryId,
        rule_code: entry.rule_code_snapshot,
        rule_name: entry.rule_name_snapshot,
        unit_price: entry.unit_price,
        quantity: entry.quantity
      }),
      options.actorName || options.actorUserId || entry.actor_name_snapshot || 'SYSTEM'
    ]
  );

  return insertRes.rows[0];
}

/**
 * Projects a completed/posted POS order to its canonical SALE transaction.
 */
export async function projectPosOrderToTransaction(
  client: PoolClient | Pool,
  orderId: number,
  options: { propertyId?: number; actorName?: string; actorUserId?: string } = {}
): Promise<TransactionRow | null> {
  const orderRes = await client.query(
    `SELECT po.*,
            r.booking_id,
            r.guest_name as res_guest_name,
            r.payment_status as reservation_payment_status,
            ro.room_number,
            b.bid,
            b.guest_name_snapshot as booking_guest_name,
            g.id as canonical_guest_id
     FROM pos_orders po
     LEFT JOIN reservations r ON r.id = po.reservation_id
     LEFT JOIN rooms ro ON ro.id = r.room_id
     LEFT JOIN bookings b ON b.id = r.booking_id
     LEFT JOIN guests g ON LOWER(TRIM(g.full_name)) = LOWER(TRIM(COALESCE(po.guest_name, r.guest_name, b.guest_name_snapshot)))
     WHERE po.id = $1`,
    [orderId]
  );

  if ((orderRes.rowCount ?? 0) === 0) {
    const err: any = new Error(`POS Order #${orderId} tidak ditemukan`);
    err.statusCode = 404;
    throw err;
  }

  const order = orderRes.rows[0];
  const propertyId = options.propertyId || order.property_id || 1;
  const status = String(order.status || '').toUpperCase();

  if (['VOIDED', 'CANCELLED', 'REFUNDED'].includes(status)) {
    const origTxRes = await client.query(
      `SELECT * FROM transactions 
       WHERE property_id = $1 AND source_type IN ('POS_ORDER', 'POS') AND source_id = $2 AND reversal_of_transaction_id IS NULL
       LIMIT 1`,
      [propertyId, String(orderId)]
    );

    if ((origTxRes.rowCount ?? 0) > 0) {
      const origTx = origTxRes.rows[0];

      const existingRevTx = await client.query(
        `SELECT * FROM transactions 
         WHERE property_id = $1 AND source_type IN ('POS_ORDER', 'POS') AND source_id = $2 AND reversal_of_transaction_id = $3
         LIMIT 1`,
        [propertyId, String(orderId), origTx.id]
      );

      if ((existingRevTx.rowCount ?? 0) > 0) {
        return existingRevTx.rows[0];
      }

      const txDate = getHotelDateToday(order.created_at);
      const txNumber = await generateTransactionNumber(client, propertyId, txDate);

      const revInsert = await client.query(
        `INSERT INTO transactions (
          property_id, transaction_no, transaction_date, transaction_time,
          transaction_type, source_type, source_id, source_reference,
          category_code, category_name, department_code, description,
          amount, discount_amount, service_amount, tax_amount, net_amount,
          payment_status, payment_method, transaction_status,
          guest_id, guest_name_snapshot, room_number_snapshot,
          reservation_id, booking_id, reversal_of_transaction_id,
          correction_group_id, notes, metadata,
          created_by, party_name
        ) VALUES (
          $1, $2, $3, CURRENT_TIMESTAMP,
          $4, $5, $6, $7,
          $8, $9, $10, $11,
          $12, $13, $14, $15, $16,
          $17, $18, 'REVERSED',
          $19, $20, $21,
          $22, $23, $24,
          $25, $26, $27, $28, $29
        ) RETURNING *`,
        [
          propertyId,
          txNumber,
          txDate,
          origTx.transaction_type,
          origTx.source_type,
          origTx.source_id,
          origTx.source_reference,
          origTx.category_code,
          origTx.category_name,
          origTx.department_code,
          `Pembalik: ${origTx.description} (Void POS #${order.order_number})`,
          -Math.abs(Number(origTx.amount || 0)),
          0,
          -Math.abs(Number(origTx.service_amount || 0)),
          -Math.abs(Number(origTx.tax_amount || 0)),
          -Math.abs(Number(origTx.net_amount || 0)),
          origTx.payment_status,
          origTx.payment_method,
          origTx.guest_id,
          origTx.guest_name_snapshot,
          origTx.room_number_snapshot,
          origTx.reservation_id,
          origTx.booking_id,
          origTx.id,
          origTx.correction_group_id,
          `Void of POS order #${order.order_number}`,
          JSON.stringify({ reversed_pos_order_id: orderId, original_transaction_no: origTx.transaction_no }),
          options.actorName || options.actorUserId || 'SYSTEM',
          origTx.party_name
        ]
      );

      await client.query(
        `UPDATE transactions SET transaction_status = 'VOIDED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [origTx.id]
      );

      return revInsert.rows[0];
    }
    return null;
  }

  const isPostedStatus = ['PAID', 'COMPLETED', 'POSTED', 'CLOSED'].includes(status);
  if (!isPostedStatus) {
    return null;
  }

  const netAmount = Math.round(Number(order.total_amount || 0));
  const txDate = getHotelDateToday(order.created_at);
  const guestName = order.guest_name || order.res_guest_name || order.booking_guest_name || 'Walk-in Guest';
  const tableLabel = order.table_number ? ` (Meja ${order.table_number})` : '';
  const description = `Pesanan Restoran / POS #${order.order_number}${tableLabel}`;

  const existingTx = await client.query(
    `SELECT * FROM transactions 
     WHERE property_id = $1 
       AND source_type IN ('POS_ORDER', 'POS') 
       AND source_id = $2 
       AND reversal_of_transaction_id IS NULL
     LIMIT 1`,
    [propertyId, String(orderId)]
  );

  if ((existingTx.rowCount ?? 0) > 0) {
    const updated = await client.query(
      `UPDATE transactions SET
         amount = $1,
         net_amount = $2,
         description = $3,
         payment_status = $4,
         party_name = COALESCE($5, party_name),
         guest_name_snapshot = COALESCE($5, guest_name_snapshot),
         room_number_snapshot = COALESCE($6, room_number_snapshot),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $7
       RETURNING *`,
      [
        netAmount,
        netAmount,
        description,
        'PAID',
        guestName,
        order.room_number ? String(order.room_number) : null,
        existingTx.rows[0].id
      ]
    );
    return updated.rows[0];
  }

  const txNumber = await generateTransactionNumber(client, propertyId, txDate);

  const insertRes = await client.query(
    `INSERT INTO transactions (
      property_id, transaction_no, transaction_date, transaction_time,
      transaction_type, source_type, source_id, source_reference,
      category_code, category_name, department_code, description,
      amount, discount_amount, service_amount, tax_amount, net_amount,
      payment_status, payment_method, transaction_status,
      guest_id, guest_name_snapshot, room_number_snapshot,
      reservation_id, booking_id, correction_group_id, notes, metadata,
      created_by, party_name
    ) VALUES (
      $1, $2, $3, CURRENT_TIMESTAMP,
      'SALE', 'POS_ORDER', $4, $5,
      'FNB_SALES', 'Restoran / F&B / POS', 'FNB', $6,
      $7, 0, 0, 0, $8,
      'PAID', $9, 'POSTED',
      $10, $11, $12,
      $13, $14, null, null, $15,
      $16, $17
    )
    ON CONFLICT (property_id, source_type, source_id) 
    WHERE source_id IS NOT NULL AND reversal_of_transaction_id IS NULL
    DO UPDATE SET
      amount = EXCLUDED.amount,
      net_amount = EXCLUDED.net_amount,
      description = EXCLUDED.description,
      payment_status = EXCLUDED.payment_status,
      party_name = EXCLUDED.party_name,
      updated_at = CURRENT_TIMESTAMP
    RETURNING *`,
    [
      propertyId,
      txNumber,
      txDate,
      String(orderId),
      order.order_number,
      description,
      netAmount,
      netAmount,
      'CASH',
      order.canonical_guest_id || null,
      guestName,
      order.room_number ? String(order.room_number) : null,
      order.reservation_id || null,
      order.booking_id || null,
      JSON.stringify({
        pos_order_id: orderId,
        order_number: order.order_number,
        table_number: order.table_number,
        items_count: order.total_qty || undefined
      }),
      options.actorName || options.actorUserId || 'Staff POS',
      guestName
    ]
  );

  return insertRes.rows[0];
}

/**
 * Creates a generic manual transaction.
 */
export async function createManualTransaction(
  pool: Pool,
  dto: CreateManualTransactionDto
): Promise<TransactionRow> {
  const propertyId = Number(dto.property_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    const err: any = new Error('property_id is required');
    err.statusCode = 400;
    throw err;
  }

  const validTypes: TransactionType[] = ['SALE', 'PURCHASE', 'EXPENSE', 'INCOME'];
  if (!validTypes.includes(dto.transaction_type)) {
    const err: any = new Error(`Tipe transaksi '${dto.transaction_type}' tidak valid. Harus salah satu dari: ${validTypes.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }

  const amount = Number(dto.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    const err: any = new Error('Nominal transaksi harus lebih besar dari 0');
    err.statusCode = 400;
    throw err;
  }
  if (!Number.isInteger(amount)) {
    const err: any = new Error('Nominal transaksi harus berupa bilangan bulat integer IDR tanpa desimal');
    err.statusCode = 400;
    throw err;
  }

  if (!dto.category_code || !dto.category_code.trim()) {
    const err: any = new Error('Kategori transaksi wajib dipilih');
    err.statusCode = 400;
    throw err;
  }

  if (!dto.description || !dto.description.trim()) {
    const err: any = new Error('Keterangan transaksi wajib diisi');
    err.statusCode = 400;
    throw err;
  }

  const catMeta = await getCategoryMeta(pool, propertyId, dto.category_code, dto.transaction_type);
  if (catMeta.allowManual === false) {
    const err: any = new Error(
      `Kategori '${catMeta.name}' merupakan transaksi operasional otomatis dan tidak dapat dicatat manual. Gunakan modul operasional Front Desk / Folio / POS terkait.`
    );
    err.statusCode = 400;
    throw err;
  }
  const categoryName = dto.category_name || catMeta.name;
  const departmentCode = dto.department_code || catMeta.defaultDept;
  const sourceType = `MANUAL_${dto.transaction_type}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const txDate = getHotelDateToday();
    const txNumber = await generateTransactionNumber(client, propertyId, txDate);
    const paymentMethod = dto.payment_method || 'CASH';
    const sourceRef = dto.source_reference ? dto.source_reference.trim() : `MANUAL-${Date.now()}`;
    const partyName = dto.party_name ? dto.party_name.trim() : null;

    const insertRes = await client.query(
      `INSERT INTO transactions (
        property_id, transaction_no, transaction_date, transaction_time,
        transaction_type, source_type, source_id, source_reference, party_name,
        category_code, category_name, department_code, description,
        amount, discount_amount, service_amount, tax_amount, net_amount,
        payment_status, payment_method, transaction_status,
        booking_id, reservation_id, supplier_id, phone,
        notes, metadata, created_by
      ) VALUES (
        $1, $2, $3, CURRENT_TIMESTAMP,
        $4, $5, NULL, $6, $7,
        $8, $9, $10, $11,
        $12, 0, 0, 0, $12,
        'PAID', $13, 'POSTED',
        $14, $15, $16, $17,
        $18, $19, $20
      ) RETURNING *`,
      [
        propertyId,
        txNumber,
        txDate,
        dto.transaction_type,
        sourceType,
        sourceRef,
        partyName,
        dto.category_code,
        categoryName,
        departmentCode,
        dto.description.trim(),
        amount,
        paymentMethod,
        dto.booking_id || null,
        dto.reservation_id || null,
        dto.supplier_id || null,
        dto.phone || null,
        dto.notes ? dto.notes.trim() : null,
        JSON.stringify({ manual_entry: true, actor_name: dto.actor_name || 'Staff' }),
        dto.actor_name || dto.actor_user_id || 'Staff'
      ]
    );

    const createdTx = insertRes.rows[0];

    // Authoritative Settlement Record in payment_transactions
    await client.query(
      `INSERT INTO payment_transactions (
        property_id, transaction_id, transaction_type, amount, payment_method,
        reference_code, status, created_by, created_at
      ) VALUES (
        $1, $2, 'PAYMENT', $3, $4, $5, 'SUCCESS', $6, NOW()
      )`,
      [
        propertyId,
        createdTx.id,
        amount,
        paymentMethod,
        sourceRef,
        dto.actor_name || 'Staff'
      ]
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (
        module, action, entity, record_id, new_value, property_id
      ) VALUES (
        'TRANSACTIONS', 'MANUAL_TRANSACTION_CREATED', 'transactions', $1, $2, $3
      )`,
      [
        String(createdTx.id),
        JSON.stringify({
          transaction_no: txNumber,
          type: dto.transaction_type,
          amount,
          category: categoryName,
          actor: dto.actor_name || 'Staff'
        }),
        propertyId
      ]
    );

    await client.query('COMMIT');
    return createdTx;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * TRANSACTION-2D: Dedicated Pembelian (Purchase) Creation Workflow.
 * Recomputes all line totals and transaction total authoritatively in PostgreSQL.
 */
export async function createPurchaseTransaction(
  pool: Pool,
  dto: CreatePurchaseTransactionDto
): Promise<TransactionRow> {
  const propertyId = Number(dto.property_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    const err: any = new Error('property_id is required');
    err.statusCode = 400;
    throw err;
  }

  if (!dto.description || !dto.description.trim()) {
    const err: any = new Error('Keterangan / Judul pembelian wajib diisi');
    err.statusCode = 400;
    throw err;
  }

  if (!Array.isArray(dto.lines) || dto.lines.length === 0) {
    const err: any = new Error('Minimal harus ada 1 item produk pesanan pada pembelian');
    err.statusCode = 400;
    throw err;
  }

  for (let i = 0; i < dto.lines.length; i++) {
    const line = dto.lines[i];
    const desc = (line.description_snapshot || line.description || '').trim();
    if (!desc) {
      throw new Error(`Baris item ke-${i + 1}: Nama/Deskripsi produk wajib diisi`);
    }
    const q = Number(line.quantity);
    if (isNaN(q) || q <= 0) {
      throw new Error(`Baris item ke-${i + 1}: Qty harus lebih besar dari 0`);
    }
    const p = Number(line.unit_price);
    if (isNaN(p) || p < 0 || !Number.isInteger(p)) {
      throw new Error(`Baris item ke-${i + 1}: Harga satuan harus berupa integer IDR >= 0`);
    }
    const d = Number(line.discount_amount || 0);
    if (isNaN(d) || d < 0 || !Number.isInteger(d)) {
      throw new Error(`Baris item ke-${i + 1}: Diskon item harus berupa integer IDR >= 0`);
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Handle or Bind Supplier
    let supplierId = dto.supplier_id ? Number(dto.supplier_id) : null;
    let supplierName = dto.supplier_name?.trim() || null;

    if (!supplierId && supplierName) {
      // Check duplicate supplier
      const dupSupplier = await client.query(
        `SELECT id, name FROM suppliers WHERE property_id = $1 AND LOWER(TRIM(name)) = LOWER(TRIM($2)) AND deleted_at IS NULL`,
        [propertyId, supplierName]
      );
      if ((dupSupplier.rowCount ?? 0) > 0) {
        supplierId = Number(dupSupplier.rows[0].id);
      } else {
        const supCode = await generateSupplierCode(client, propertyId, 'SUPPLIER');
        const newSup = await client.query(
          `INSERT INTO suppliers (
            property_id, code, name, entity_type, status, phone, bank_name, bank_account, address, is_active, created_at, updated_at
          ) VALUES ($1, $2, $3, 'SUPPLIER', 'ACTIVE', $4, $5, $6, $7, TRUE, NOW(), NOW())
          RETURNING id`,
          [
            propertyId,
            supCode,
            supplierName,
            dto.supplier_phone?.trim() || null,
            dto.supplier_bank_name?.trim() || null,
            dto.supplier_bank_account?.trim() || null,
            dto.supplier_address?.trim() || null
          ]
        );
        supplierId = Number(newSup.rows[0].id);
      }
    } else if (supplierId) {
      const supCheck = await client.query(
        `SELECT name FROM suppliers WHERE id = $1 AND property_id = $2 AND deleted_at IS NULL`,
        [supplierId, propertyId]
      );
      if ((supCheck.rowCount ?? 0) > 0) {
        supplierName = supCheck.rows[0].name;
      }
    }

    const txDate = dto.transaction_date || getHotelDateToday();
    const txNumber = await generateTransactionNumber(client, propertyId, txDate);
    const categoryCode = dto.category_code || 'SUPPLIES_PURCHASE';
    const categoryName = dto.category_name || 'Pembelian Barang / Stok';
    const departmentCode = dto.department_code || 'GENERAL';
    const receivingStatus: ReceivingStatus = dto.receiving_status || 'BELUM_DITERIMA';
    const receivedAt = dto.received_at ? new Date(dto.received_at).toISOString() : (receivingStatus === 'DITERIMA' ? new Date().toISOString() : null);

    const transactionDiscount = Math.max(0, Math.round(Number(dto.transaction_discount || dto.discount_amount || 0)));
    const roundingAmount = Math.round(Number(dto.rounding_amount || 0));

    // 1. Initial Insert for transaction header
    const insertTx = await client.query(
      `INSERT INTO transactions (
        property_id, transaction_no, transaction_date, transaction_time,
        transaction_type, source_type, source_reference, party_name,
        category_code, category_name, department_code, description,
        amount, discount_amount, service_amount, tax_amount, rounding_amount, net_amount,
        payment_status, payment_method, transaction_status,
        supplier_id, receiving_status, received_at, verification_status,
        notes, metadata, created_by
      ) VALUES (
        $1, $2, $3, CURRENT_TIMESTAMP,
        'PURCHASE', 'MANUAL_PURCHASE', $4, $5,
        $6, $7, $8, $9,
        0, $10, 0, 0, $11, 0,
        'UNPAID', $12, 'POSTED',
        $13, $14, $15, 'UNVERIFIED',
        $16, $17, $18
      ) RETURNING *`,
      [
        propertyId,
        txNumber,
        txDate,
        dto.source_reference?.trim() || null,
        supplierName,
        categoryCode,
        categoryName,
        departmentCode,
        dto.description.trim(),
        transactionDiscount,
        roundingAmount,
        dto.payment_method || null,
        supplierId,
        receivingStatus,
        receivedAt,
        dto.notes?.trim() || null,
        JSON.stringify({ workflow: 'PURCHASE_2D', actor: dto.actor_name || 'Staff' }),
        dto.actor_name || dto.actor_user_id || 'Staff'
      ]
    );

    const txId = insertTx.rows[0].id;

    // 2. Insert Lines with Server-side PostgreSQL Deterministic Math:
    // line_total = GREATEST(0, ROUND(quantity * unit_price)::BIGINT - discount_amount)
    for (let i = 0; i < dto.lines.length; i++) {
      const line = dto.lines[i];
      const desc = (line.description_snapshot || line.description || '').trim();
      await client.query(
        `INSERT INTO transaction_lines (
          property_id, transaction_id, product_id, description_snapshot,
          quantity, unit, unit_price, discount_amount, line_total, sort_order, created_at
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          GREATEST(0, ROUND($5::numeric * $7::bigint)::bigint - $8::bigint),
          $9, NOW()
        )`,
        [
          propertyId,
          txId,
          line.product_id || null,
          desc,
          Number(line.quantity),
          line.unit?.trim() || 'pcs',
          Math.round(Number(line.unit_price)),
          Math.max(0, Math.round(Number(line.discount_amount || 0))),
          i + 1
        ]
      );
    }

    // 3. Recompute Header Subtotal and Authoritative Net Amount in PostgreSQL
    const recomputeRes = await client.query(
      `WITH line_sums AS (
         SELECT COALESCE(SUM(line_total), 0) AS subtotal
         FROM transaction_lines
         WHERE transaction_id = $1
       )
       UPDATE transactions
       SET amount = line_sums.subtotal,
           net_amount = GREATEST(0, (line_sums.subtotal - discount_amount + rounding_amount))
       FROM line_sums
       WHERE id = $1
       RETURNING *`,
      [txId]
    );

    const finalTx = recomputeRes.rows[0];
    const finalNetAmount = Number(finalTx.net_amount || 0);

    // 4. Handle Settlement Payment if paid_amount was specified
    const paidAmount = Math.max(0, Math.round(Number(dto.paid_amount || 0)));
    let paymentStatus = 'UNPAID';

    if (paidAmount > 0) {
      await client.query(
        `INSERT INTO payment_transactions (
          property_id, transaction_id, transaction_type, amount, payment_method,
          reference_code, status, created_by, created_at
        ) VALUES (
          $1, $2, 'PAYMENT', $3, $4, $5, 'SUCCESS', $6, NOW()
        )`,
        [
          propertyId,
          txId,
          paidAmount,
          dto.payment_method || 'CASH',
          dto.source_reference || `PURCHASE-SETTLE-${txNumber}`,
          dto.actor_name || 'Staff'
        ]
      );

      if (paidAmount >= finalNetAmount && finalNetAmount > 0) {
        paymentStatus = 'PAID';
      } else {
        paymentStatus = 'PARTIALLY_PAID';
      }

      await client.query(
        `UPDATE transactions SET payment_status = $1 WHERE id = $2`,
        [paymentStatus, txId]
      );
    }

    // 5. Audit log
    await client.query(
      `INSERT INTO audit_logs (
        module, action, entity, record_id, new_value, property_id
      ) VALUES (
        'TRANSACTIONS', 'PURCHASE_CREATED', 'transactions', $1, $2, $3
      )`,
      [
        String(txId),
        JSON.stringify({
          transaction_no: txNumber,
          supplier: supplierName,
          lines_count: dto.lines.length,
          net_amount: finalNetAmount,
          paid_amount: paidAmount,
          receiving_status: receivingStatus,
          actor: dto.actor_name || 'Staff'
        }),
        propertyId
      ]
    );

    await client.query('COMMIT');

    return await getTransactionById(pool, propertyId, txId);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * TRANSACTION-2D: Dedicated Pengeluaran (Expense) Creation Workflow.
 */
export async function createExpenseTransaction(
  pool: Pool,
  dto: CreateExpenseTransactionDto
): Promise<TransactionRow> {
  const propertyId = Number(dto.property_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    const err: any = new Error('property_id is required');
    err.statusCode = 400;
    throw err;
  }

  const amount = Number(dto.amount);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
    const err: any = new Error('Nominal pengeluaran harus berupa bilangan bulat integer IDR > 0');
    err.statusCode = 400;
    throw err;
  }

  if (!dto.category_code || !dto.category_code.trim()) {
    const err: any = new Error('Kategori pengeluaran wajib dipilih');
    err.statusCode = 400;
    throw err;
  }

  if (!dto.description || !dto.description.trim()) {
    const err: any = new Error('Keterangan pengeluaran wajib diisi');
    err.statusCode = 400;
    throw err;
  }

  const catMeta = await getCategoryMeta(pool, propertyId, dto.category_code, 'EXPENSE');
  const categoryName = dto.category_name || catMeta.name;
  const departmentCode = dto.department_code || catMeta.defaultDept;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let partyName = dto.party_name?.trim() || null;
    let supplierId = dto.supplier_id ? Number(dto.supplier_id) : null;

    if (supplierId && !partyName) {
      const supRes = await client.query(
        `SELECT name FROM suppliers WHERE id = $1 AND property_id = $2 AND deleted_at IS NULL`,
        [supplierId, propertyId]
      );
      if ((supRes.rowCount ?? 0) > 0) {
        partyName = supRes.rows[0].name;
      }
    }

    const txDate = dto.transaction_date || getHotelDateToday();
    const txNumber = await generateTransactionNumber(client, propertyId, txDate);
    const paymentMethod = dto.payment_method || 'CASH';
    const isPaid = dto.is_paid !== false; // Default: true (immediate payment)
    const paymentStatus = isPaid ? 'PAID' : 'UNPAID';

    const insertTx = await client.query(
      `INSERT INTO transactions (
        property_id, transaction_no, transaction_date, transaction_time,
        transaction_type, source_type, source_reference, party_name,
        category_code, category_name, department_code, description,
        amount, discount_amount, service_amount, tax_amount, rounding_amount, net_amount,
        payment_status, payment_method, transaction_status,
        supplier_id, receiving_status, received_at, verification_status,
        notes, metadata, created_by
      ) VALUES (
        $1, $2, $3, CURRENT_TIMESTAMP,
        'EXPENSE', 'MANUAL_EXPENSE', $4, $5,
        $6, $7, $8, $9,
        $10, 0, 0, 0, 0, $10,
        $11, $12, 'POSTED',
        $13, NULL, NULL, 'UNVERIFIED',
        $14, $15, $16
      ) RETURNING *`,
      [
        propertyId,
        txNumber,
        txDate,
        dto.source_reference?.trim() || null,
        partyName,
        dto.category_code,
        categoryName,
        departmentCode,
        dto.description.trim(),
        amount,
        paymentStatus,
        paymentMethod,
        supplierId,
        dto.notes?.trim() || null,
        JSON.stringify({ workflow: 'EXPENSE_2D', actor: dto.actor_name || 'Staff' }),
        dto.actor_name || dto.actor_user_id || 'Staff'
      ]
    );

    const txId = insertTx.rows[0].id;

    if (isPaid) {
      await client.query(
        `INSERT INTO payment_transactions (
          property_id, transaction_id, transaction_type, amount, payment_method,
          reference_code, status, created_by, created_at
        ) VALUES (
          $1, $2, 'PAYMENT', $3, $4, $5, 'SUCCESS', $6, NOW()
        )`,
        [
          propertyId,
          txId,
          amount,
          paymentMethod,
          dto.source_reference || `EXPENSE-SETTLE-${txNumber}`,
          dto.actor_name || 'Staff'
        ]
      );
    }

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (
        module, action, entity, record_id, new_value, property_id
      ) VALUES (
        'TRANSACTIONS', 'EXPENSE_CREATED', 'transactions', $1, $2, $3
      )`,
      [
        String(txId),
        JSON.stringify({
          transaction_no: txNumber,
          category: categoryName,
          amount,
          is_paid: isPaid,
          actor: dto.actor_name || 'Staff'
        }),
        propertyId
      ]
    );

    await client.query('COMMIT');

    return await getTransactionById(pool, propertyId, txId);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * TRANSACTION-2D: Dedicated Pemasukan Manual (Income) Creation Workflow.
 */
export async function createIncomeTransaction(
  pool: Pool,
  dto: CreateIncomeTransactionDto
): Promise<TransactionRow> {
  const propertyId = Number(dto.property_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    const err: any = new Error('property_id is required');
    err.statusCode = 400;
    throw err;
  }

  if (!dto.customer_name || !dto.customer_name.trim()) {
    const err: any = new Error('Nama pelanggan / pembayar wajib diisi');
    err.statusCode = 400;
    throw err;
  }

  if (!dto.description || !dto.description.trim()) {
    const err: any = new Error('Keterangan pemasukan wajib diisi');
    err.statusCode = 400;
    throw err;
  }

  if (!dto.payment_method || !dto.payment_method.trim()) {
    const err: any = new Error('Metode pembayaran wajib dipilih untuk pemasukan manual');
    err.statusCode = 400;
    throw err;
  }

  const amount = Number(dto.amount);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
    const err: any = new Error('Nominal pemasukan harus berupa bilangan bulat integer IDR > 0');
    err.statusCode = 400;
    throw err;
  }

  const categoryCode = dto.category_code || 'OTHER_INCOME';
  const catMeta = await getCategoryMeta(pool, propertyId, categoryCode, 'INCOME');
  const categoryName = dto.category_name || catMeta.name;
  const departmentCode = dto.department_code || catMeta.defaultDept;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const txDate = dto.transaction_date || getHotelDateToday();
    const txNumber = await generateTransactionNumber(client, propertyId, txDate);

    const insertTx = await client.query(
      `INSERT INTO transactions (
        property_id, transaction_no, transaction_date, transaction_time,
        transaction_type, source_type, source_reference, party_name, phone,
        category_code, category_name, department_code, description,
        amount, discount_amount, service_amount, tax_amount, rounding_amount, net_amount,
        payment_status, payment_method, transaction_status,
        receiving_status, received_at, verification_status,
        notes, metadata, created_by
      ) VALUES (
        $1, $2, $3, CURRENT_TIMESTAMP,
        'INCOME', 'MANUAL_INCOME', $4, $5, $6,
        $7, $8, $9, $10,
        $11, 0, 0, 0, 0, $11,
        'PAID', $12, 'POSTED',
        NULL, NULL, 'UNVERIFIED',
        $13, $14, $15
      ) RETURNING *`,
      [
        propertyId,
        txNumber,
        txDate,
        dto.source_reference?.trim() || null,
        dto.customer_name.trim(),
        dto.phone?.trim() || null,
        categoryCode,
        categoryName,
        departmentCode,
        dto.description.trim(),
        amount,
        dto.payment_method.trim(),
        dto.notes?.trim() || null,
        JSON.stringify({ workflow: 'INCOME_2D', actor: dto.actor_name || 'Staff' }),
        dto.actor_name || dto.actor_user_id || 'Staff'
      ]
    );

    const txId = insertTx.rows[0].id;

    // Insert line items if provided
    if (Array.isArray(dto.lines) && dto.lines.length > 0) {
      for (let i = 0; i < dto.lines.length; i++) {
        const line = dto.lines[i];
        if (line.description && line.description.trim()) {
          await client.query(
            `INSERT INTO transaction_lines (
              property_id, transaction_id, product_id, description_snapshot,
              quantity, unit, unit_price, discount_amount, line_total, sort_order, created_at
            ) VALUES (
              $1, $2, $3, $4,
              $5, $6, $7, $8,
              GREATEST(0, ROUND($5::numeric * $7::bigint)::bigint - $8::bigint),
              $9, NOW()
            )`,
            [
              propertyId,
              txId,
              line.product_id || null,
              line.description.trim(),
              Number(line.quantity || 1),
              line.unit?.trim() || 'pcs',
              Math.round(Number(line.unit_price || 0)),
              Math.max(0, Math.round(Number(line.discount_amount || 0))),
              i + 1
            ]
          );
        }
      }
    }

    // Authoritative Settlement Record in payment_transactions
    await client.query(
      `INSERT INTO payment_transactions (
        property_id, transaction_id, transaction_type, amount, payment_method,
        reference_code, status, created_by, created_at
      ) VALUES (
        $1, $2, 'PAYMENT', $3, $4, $5, 'SUCCESS', $6, NOW()
      )`,
      [
        propertyId,
        txId,
        amount,
        dto.payment_method.trim(),
        dto.source_reference || `INCOME-SETTLE-${txNumber}`,
        dto.actor_name || 'Staff'
      ]
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (
        module, action, entity, record_id, new_value, property_id
      ) VALUES (
        'TRANSACTIONS', 'INCOME_CREATED', 'transactions', $1, $2, $3
      )`,
      [
        String(txId),
        JSON.stringify({
          transaction_no: txNumber,
          customer: dto.customer_name.trim(),
          amount,
          payment_method: dto.payment_method.trim(),
          actor: dto.actor_name || 'Staff'
        }),
        propertyId
      ]
    );

    await client.query('COMMIT');

    return await getTransactionById(pool, propertyId, txId);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * TRANSACTION-2D: Verification Workflow.
 */
export async function verifyTransaction(
  pool: Pool,
  id: number | string,
  dto: VerifyTransactionDto
): Promise<TransactionRow> {
  const propertyId = Number(dto.property_id);
  const status = dto.verification_status;
  if (!['UNVERIFIED', 'VERIFIED', 'REJECTED'].includes(status)) {
    throw new Error(`Status verifikasi '${status}' tidak valid`);
  }

  const txCheck = await pool.query(
    `SELECT id, transaction_no, verification_status FROM transactions WHERE id = $1 AND property_id = $2`,
    [id, propertyId]
  );
  if ((txCheck.rowCount ?? 0) === 0) {
    throw new Error(`Transaksi #${id} tidak ditemukan`);
  }

  const prevStatus = txCheck.rows[0].verification_status;

  const updateRes = await pool.query(
    `UPDATE transactions
     SET verification_status = $1,
         verified_by_user_id = $2,
         verified_by_name_snapshot = $3,
         verified_at = NOW(),
         verification_note = $4,
         updated_at = NOW()
     WHERE id = $5 AND property_id = $6
     RETURNING *`,
    [
      status,
      dto.actor_user_id || null,
      dto.actor_name || 'Supervisor',
      dto.verification_note?.trim() || null,
      id,
      propertyId
    ]
  );

  // Audit log
  await pool.query(
    `INSERT INTO audit_logs (
      module, action, entity, record_id, new_value, property_id
    ) VALUES (
      'TRANSACTIONS', 'TRANSACTION_VERIFIED', 'transactions', $1, $2, $3
    )`,
    [
      String(id),
      JSON.stringify({
        previous_status: prevStatus,
        new_status: status,
        verified_by: dto.actor_name || 'Supervisor',
        note: dto.verification_note
      }),
      propertyId
    ]
  );

  return await getTransactionById(pool, propertyId, id);
}

/**
 * TRANSACTION-2D: Update Purchase Physical Receiving Status.
 */
export async function updatePurchaseReceivingStatus(
  pool: Pool,
  id: number | string,
  dto: UpdateReceivingStatusDto
): Promise<TransactionRow> {
  const propertyId = Number(dto.property_id);
  const status = dto.receiving_status;
  if (!['BELUM_DITERIMA', 'DITERIMA_SEBAGIAN', 'DITERIMA'].includes(status)) {
    throw new Error(`Status penerimaan '${status}' tidak valid`);
  }

  const txCheck = await pool.query(
    `SELECT id, transaction_no, transaction_type, receiving_status FROM transactions WHERE id = $1 AND property_id = $2`,
    [id, propertyId]
  );
  if ((txCheck.rowCount ?? 0) === 0) {
    throw new Error(`Transaksi #${id} tidak ditemukan`);
  }

  const currentTx = txCheck.rows[0];
  if (currentTx.transaction_type !== 'PURCHASE') {
    throw new Error(`Status penerimaan barang hanya berlaku untuk transaksi Pembelian (PURCHASE)`);
  }

  const prevStatus = currentTx.receiving_status;
  const receivedAtVal = status === 'BELUM_DITERIMA' 
    ? null 
    : (dto.received_at ? new Date(dto.received_at).toISOString() : (currentTx.received_at || new Date().toISOString()));

  await pool.query(
    `UPDATE transactions
     SET receiving_status = $1,
         received_at = $2,
         updated_at = NOW()
     WHERE id = $3 AND property_id = $4`,
    [status, receivedAtVal, id, propertyId]
  );

  // Audit log
  await pool.query(
    `INSERT INTO audit_logs (
      module, action, entity, record_id, new_value, property_id
    ) VALUES (
      'TRANSACTIONS', 'PURCHASE_RECEIVING_UPDATED', 'transactions', $1, $2, $3
    )`,
    [
      String(id),
      JSON.stringify({
        previous_status: prevStatus,
        new_status: status,
        updated_by: dto.actor_name || 'Staff'
      }),
      propertyId
    ]
  );

  return await getTransactionById(pool, propertyId, id);
}

/**
 * TRANSACTION-2D: Settle / Record Payment for Transaction.
 */
export async function settleTransactionPayment(
  pool: Pool,
  id: number | string,
  dto: SettleTransactionPaymentDto
): Promise<TransactionRow> {
  const propertyId = Number(dto.property_id);
  const amount = Math.round(Number(dto.amount) || 0);
  if (amount <= 0) {
    throw new Error('Nominal pelunasan harus lebih besar dari Rp 0');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const txRes = await client.query(
      `SELECT t.id, t.transaction_no, t.transaction_type, t.net_amount, t.payment_status,
              COALESCE(pmt.total_paid, 0)::bigint AS paid_amount
       FROM transactions t
       LEFT JOIN LATERAL (
         SELECT SUM(pt.amount)::bigint AS total_paid
         FROM payment_transactions pt
         WHERE (pt.transaction_id = t.id OR (t.reservation_id IS NOT NULL AND pt.reservation_id = t.reservation_id))
           AND pt.status = 'SUCCESS'
           AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
       ) pmt ON TRUE
       WHERE t.id = $1 AND t.property_id = $2
       FOR UPDATE OF t`,
      [id, propertyId]
    );

    if ((txRes.rowCount ?? 0) === 0) {
      throw new Error(`Transaksi #${id} tidak ditemukan`);
    }

    const tx = txRes.rows[0];
    const netAmount = Number(tx.net_amount) || 0;
    const currentPaid = Number(tx.paid_amount) || 0;
    const outstanding = Math.max(0, netAmount - currentPaid);

    if (amount > outstanding && outstanding > 0) {
      throw new Error(`Nominal pelunasan (Rp ${amount.toLocaleString('id-ID')}) melebihi sisa tagihan (Rp ${outstanding.toLocaleString('id-ID')})`);
    }

    // Insert payment_transactions
    await client.query(
      `INSERT INTO payment_transactions (
        property_id, transaction_id, transaction_type, amount, payment_method,
        reference_code, status, created_by, created_at
      ) VALUES (
        $1, $2, 'PAYMENT', $3, $4, $5, 'SUCCESS', $6, NOW()
      )`,
      [
        propertyId,
        id,
        amount,
        dto.payment_method || 'TRANSFER',
        dto.notes || `PELUNASAN-${tx.transaction_no}`,
        dto.actor_name || 'Staff'
      ]
    );

    const newPaid = currentPaid + amount;
    const newPaymentStatus = newPaid >= netAmount ? 'PAID' : (newPaid > 0 ? 'PARTIALLY_PAID' : 'UNPAID');

    await client.query(
      `UPDATE transactions
       SET payment_status = $1,
           updated_at = NOW()
       WHERE id = $2 AND property_id = $3`,
      [newPaymentStatus, id, propertyId]
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (
        module, action, entity, record_id, new_value, property_id
      ) VALUES (
        'TRANSACTIONS', 'TRANSACTION_PAYMENT_SETTLED', 'transactions', $1, $2, $3
      )`,
      [
        String(id),
        JSON.stringify({
          amount,
          payment_method: dto.payment_method,
          previous_paid: currentPaid,
          new_paid: newPaid,
          new_payment_status: newPaymentStatus,
          settled_by: dto.actor_name || 'Staff'
        }),
        propertyId
      ]
    );

    await client.query('COMMIT');

    return await getTransactionById(pool, propertyId, id);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * TRANSACTION-2D: Custom Operational Categories Management.
 */
export async function getCustomCategories(
  pool: Pool,
  propertyId: number,
  transactionType?: TransactionType
): Promise<CustomCategoryRow[]> {
  const conditions: string[] = ['property_id = $1'];
  const values: any[] = [propertyId];
  if (transactionType) {
    conditions.push('transaction_type = $2');
    values.push(transactionType);
  }

  const query = `
    SELECT id::text, property_id, code, name, transaction_type, department_code, is_active, created_at
    FROM transaction_custom_categories
    WHERE ${conditions.join(' AND ')}
    ORDER BY is_active DESC, name ASC
  `;
  const res = await pool.query(query, values);
  return res.rows;
}

export async function createCustomCategory(
  pool: Pool,
  dto: CreateCustomCategoryDto
): Promise<CustomCategoryRow> {
  if (!dto.name || !dto.name.trim()) {
    throw new Error('Nama kategori wajib diisi');
  }

  const code = (dto.code || dto.name.toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '')).trim();
  if (!code) {
    throw new Error('Kode kategori tidak valid');
  }

  const res = await pool.query(
    `INSERT INTO transaction_custom_categories (
      property_id, code, name, transaction_type, department_code, is_active, created_at
    ) VALUES ($1, $2, $3, $4, $5, TRUE, NOW())
    ON CONFLICT (property_id, code) DO UPDATE
    SET is_active = TRUE, name = EXCLUDED.name, department_code = EXCLUDED.department_code
    RETURNING id::text, property_id, code, name, transaction_type, department_code, is_active, created_at`,
    [
      dto.property_id,
      code,
      dto.name.trim(),
      dto.transaction_type,
      dto.department_code || 'GENERAL'
    ]
  );

  return res.rows[0];
}

export async function toggleCustomCategory(
  pool: Pool,
  propertyId: number,
  code: string,
  actorName?: string
): Promise<CustomCategoryRow> {
  const cat = await pool.query(
    `SELECT id, is_active, name FROM transaction_custom_categories WHERE property_id = $1 AND code = $2`,
    [propertyId, code]
  );
  if ((cat.rowCount ?? 0) === 0) {
    throw new Error(`Kategori '${code}' tidak ditemukan`);
  }

  const newActive = !cat.rows[0].is_active;
  const updateRes = await pool.query(
    `UPDATE transaction_custom_categories
     SET is_active = $1
     WHERE property_id = $2 AND code = $3
     RETURNING id::text, property_id, code, name, transaction_type, department_code, is_active, created_at`,
    [newActive, propertyId, code]
  );

  await pool.query(
    `INSERT INTO audit_logs (
      module, action, entity, record_id, new_value, property_id
    ) VALUES (
      'TRANSACTIONS', 'CATEGORY_STATUS_TOGGLED', 'transaction_custom_categories', $1, $2, $3
    )`,
    [
      String(cat.rows[0].id),
      JSON.stringify({ code, name: cat.rows[0].name, is_active: newActive, actor: actorName || 'Staff' }),
      propertyId
    ]
  );

  return updateRes.rows[0];
}

/**
 * Void/Reversal of a transaction (Immutable Reversal).
 */
export async function voidTransaction(
  pool: Pool,
  propertyId: number,
  id: number | string,
  options: { reason: string; actorName?: string; actorUserId?: string }
): Promise<{ original: TransactionRow; reversal: TransactionRow }> {
  if (!options.reason || !options.reason.trim()) {
    const err: any = new Error('Alasan pembatalan (void reason) wajib diisi');
    err.statusCode = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const txRes = await client.query(
      `SELECT * FROM transactions WHERE id = $1 AND property_id = $2 FOR UPDATE`,
      [id, propertyId]
    );

    if ((txRes.rowCount ?? 0) === 0) {
      const err: any = new Error(`Transaksi #${id} tidak ditemukan`);
      err.statusCode = 404;
      throw err;
    }

    const tx = txRes.rows[0];

    if (tx.transaction_status === 'VOIDED' || tx.transaction_status === 'REVERSED') {
      const err: any = new Error(`Transaksi #${tx.transaction_no} sudah dalam status ${tx.transaction_status} dan tidak dapat dibatalkan lagi.`);
      err.statusCode = 400;
      throw err;
    }

    const txDate = getHotelDateToday();
    const txNumber = await generateTransactionNumber(client, propertyId, txDate);
    const amount = Number(tx.amount || 0);
    const serviceAmount = Number(tx.service_amount || 0);
    const taxAmount = Number(tx.tax_amount || 0);
    const netAmount = Number(tx.net_amount || 0);

    const revInsert = await client.query(
      `INSERT INTO transactions (
        property_id, transaction_no, transaction_date, transaction_time,
        transaction_type, source_type, source_id, source_reference,
        category_code, category_name, department_code, description,
        amount, discount_amount, service_amount, tax_amount, net_amount,
        payment_status, payment_method, transaction_status,
        guest_id, guest_name_snapshot, room_number_snapshot,
        reservation_id, booking_id, reversal_of_transaction_id,
        notes, metadata, created_by
      ) VALUES (
        $1, $2, $3, CURRENT_TIMESTAMP,
        $4, $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13, $14, $15, $16,
        $17, $18, 'REVERSED',
        $19, $20, $21,
        $22, $23, $24,
        $25, $26, $27
      ) RETURNING *`,
      [
        propertyId,
        txNumber,
        txDate,
        tx.transaction_type,
        tx.source_type,
        tx.source_id ? `REV-${tx.source_id}` : null,
        tx.source_reference,
        tx.category_code,
        tx.category_name,
        tx.department_code,
        `Pembatalan: ${tx.description}`,
        -Math.abs(amount),
        0,
        -Math.abs(serviceAmount),
        -Math.abs(taxAmount),
        -Math.abs(netAmount),
        tx.payment_status,
        tx.payment_method,
        tx.guest_id,
        tx.guest_name_snapshot,
        tx.room_number_snapshot,
        tx.reservation_id,
        tx.booking_id,
        tx.id,
        options.reason.trim(),
        JSON.stringify({ voided_transaction_no: tx.transaction_no, void_reason: options.reason.trim() }),
        options.actorName || options.actorUserId || 'Staff'
      ]
    );

    const origUpdate = await client.query(
      `UPDATE transactions SET
         transaction_status = 'VOIDED',
         notes = COALESCE(notes || ' | ', '') || 'Dibatalkan: ' || $1,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [options.reason.trim(), tx.id]
    );

    await client.query(
      `INSERT INTO audit_logs (
        module, action, entity, record_id, new_value, property_id
      ) VALUES (
        'TRANSACTIONS', 'TRANSACTION_VOIDED', 'transactions', $1, $2, $3
      )`,
      [
        String(tx.id),
        JSON.stringify({
          original_no: tx.transaction_no,
          reversal_no: txNumber,
          reason: options.reason
        }),
        propertyId
      ]
    );

    await client.query('COMMIT');
    return {
      original: origUpdate.rows[0],
      reversal: revInsert.rows[0]
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Queries transactions with dynamic payment settlement derivation from payment_transactions.
 */
export async function getTransactions(
  pool: Pool,
  params: TransactionFilterParams
): Promise<TransactionQueryResult> {
  const propertyId = Number(params.property_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    const err: any = new Error('property_id is required');
    err.statusCode = 400;
    throw err;
  }

  const baseConditions: string[] = ['t.property_id = $1'];
  const baseValues: any[] = [propertyId];
  let valIdx = 2;

  if (params.transaction_type) {
    baseConditions.push(`t.transaction_type = $${valIdx++}`);
    baseValues.push(params.transaction_type);
  }

  if (params.source_type) {
    baseConditions.push(`t.source_type = $${valIdx++}`);
    baseValues.push(params.source_type);
  }

  if (params.category_code) {
    baseConditions.push(`t.category_code = $${valIdx++}`);
    baseValues.push(params.category_code);
  }

  if (params.department_code) {
    baseConditions.push(`t.department_code = $${valIdx++}`);
    baseValues.push(params.department_code);
  }

  if (params.payment_status) {
    baseConditions.push(`t.payment_status = $${valIdx++}`);
    baseValues.push(params.payment_status);
  }

  if (params.payment_method) {
    baseConditions.push(`t.payment_method = $${valIdx++}`);
    baseValues.push(params.payment_method);
  }

  if (params.verification_status) {
    baseConditions.push(`t.verification_status = $${valIdx++}`);
    baseValues.push(params.verification_status);
  }

  if (params.receiving_status) {
    baseConditions.push(`t.receiving_status = $${valIdx++}`);
    baseValues.push(params.receiving_status);
  }

  if (params.supplier_id) {
    baseConditions.push(`t.supplier_id = $${valIdx++}`);
    baseValues.push(params.supplier_id);
  }

  if (params.reservation_id) {
    baseConditions.push(`t.reservation_id = $${valIdx++}`);
    baseValues.push(params.reservation_id);
  }

  if (params.booking_id) {
    baseConditions.push(`(t.booking_id = $${valIdx} OR b.bid = $${valIdx})`);
    baseValues.push(String(params.booking_id));
    valIdx++;
  }

  if (params.start_date) {
    baseConditions.push(`t.transaction_date >= $${valIdx++}`);
    baseValues.push(params.start_date);
  }

  if (params.end_date) {
    baseConditions.push(`t.transaction_date <= $${valIdx++}`);
    baseValues.push(params.end_date);
  }

  if (params.party_name && params.party_name.trim()) {
    baseConditions.push(`(t.party_name ILIKE $${valIdx} OR s.name ILIKE $${valIdx})`);
    baseValues.push(`%${params.party_name.trim()}%`);
    valIdx++;
  }

  if (params.search && params.search.trim()) {
    const searchTerm = `%${params.search.trim()}%`;
    baseConditions.push(`(
      t.transaction_no ILIKE $${valIdx} OR
      t.description ILIKE $${valIdx} OR
      t.source_reference ILIKE $${valIdx} OR
      t.party_name ILIKE $${valIdx} OR
      s.name ILIKE $${valIdx} OR
      t.guest_name_snapshot ILIKE $${valIdx} OR
      t.room_number_snapshot ILIKE $${valIdx} OR
      t.notes ILIKE $${valIdx} OR
      b.bid ILIKE $${valIdx} OR
      r.booking_number ILIKE $${valIdx} OR
      r.guest_name ILIKE $${valIdx}
    )`);
    baseValues.push(searchTerm);
    valIdx++;
  }

  // Calculate full server-side sheet counts for current filtered domain
  const sheetCountsQuery = `
    SELECT
      COUNT(CASE WHEN t.deleted_at IS NULL AND t.transaction_status NOT IN ('VOIDED', 'CANCELLED', 'REVERSED') AND (
        (t.transaction_type = 'PURCHASE' AND (t.receiving_status IS NULL OR t.receiving_status NOT IN ('DITERIMA', 'DITERIMA_LENGKAP')))
        OR (t.transaction_type != 'PURCHASE' AND t.transaction_status NOT IN ('POSTED', 'VOIDED', 'CANCELLED', 'REVERSED'))
      ) THEN 1 END) AS count_proses,
      COUNT(CASE WHEN t.deleted_at IS NULL AND t.transaction_status NOT IN ('VOIDED', 'CANCELLED', 'REVERSED') AND (
        (t.transaction_type = 'PURCHASE' AND t.receiving_status IN ('DITERIMA', 'DITERIMA_LENGKAP'))
        OR (t.transaction_type != 'PURCHASE' AND t.transaction_status = 'POSTED')
      ) THEN 1 END) AS count_selesai,
      COUNT(CASE WHEN t.deleted_at IS NULL AND t.transaction_status IN ('VOIDED', 'CANCELLED', 'REVERSED') AND NOT EXISTS (
        SELECT 1 FROM transactions rev WHERE rev.reversal_of_transaction_id = t.id AND rev.transaction_status = 'REVERSED' AND rev.deleted_at IS NULL
      ) THEN 1 END) AS count_batal,
      COUNT(CASE WHEN t.deleted_at IS NOT NULL THEN 1 END) AS count_hapus
    FROM transactions t
    LEFT JOIN suppliers s ON s.id = t.supplier_id
    LEFT JOIN reservations r ON r.id = t.reservation_id
    LEFT JOIN bookings b ON b.id = COALESCE(t.booking_id, r.booking_id)
    WHERE ${baseConditions.join(' AND ')}
  `;

  const countsRes = await pool.query(sheetCountsQuery, baseValues);
  const cRow = countsRes.rows[0] || {};
  const sheet_counts: TransactionSheetCounts = {
    proses: Number(cRow.count_proses || 0),
    selesai: Number(cRow.count_selesai || 0),
    batal: Number(cRow.count_batal || 0),
    hapus: Number(cRow.count_hapus || 0)
  };

  const conditions = [...baseConditions];
  const values = [...baseValues];

  const targetSheet = String(params.operational_sheet || params.operational_status || '').toUpperCase();

  if (targetSheet === 'HAPUS') {
    conditions.push(`t.deleted_at IS NOT NULL`);
  } else {
    // Exclude soft-deleted records from normal active sheets
    conditions.push(`t.deleted_at IS NULL`);

    if (targetSheet === 'PROSES') {
      conditions.push(`(
        t.transaction_status NOT IN ('VOIDED', 'CANCELLED', 'REVERSED') AND (
          (t.transaction_type = 'PURCHASE' AND (t.receiving_status IS NULL OR t.receiving_status NOT IN ('DITERIMA', 'DITERIMA_LENGKAP')))
          OR (t.transaction_type != 'PURCHASE' AND t.transaction_status NOT IN ('POSTED', 'VOIDED', 'CANCELLED', 'REVERSED'))
        )
      )`);
    } else if (targetSheet === 'SELESAI') {
      conditions.push(`(
        t.transaction_status NOT IN ('VOIDED', 'CANCELLED', 'REVERSED') AND (
          (t.transaction_type = 'PURCHASE' AND t.receiving_status IN ('DITERIMA', 'DITERIMA_LENGKAP'))
          OR (t.transaction_type != 'PURCHASE' AND t.transaction_status = 'POSTED')
        )
      )`);
    } else if (targetSheet === 'BATAL') {
      conditions.push(`t.transaction_status IN ('VOIDED', 'CANCELLED', 'REVERSED')`);
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM transactions rev WHERE rev.reversal_of_transaction_id = t.id AND rev.transaction_status = 'REVERSED' AND rev.deleted_at IS NULL
      )`);
    } else if (params.transaction_status) {
      conditions.push(`t.transaction_status = $${valIdx++}`);
      values.push(params.transaction_status);
    }
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const summaryQuery = `
    SELECT
      COALESCE(SUM(CASE WHEN t.deleted_at IS NULL AND t.transaction_type = 'SALE' THEN t.net_amount ELSE 0 END), 0) AS total_sale,
      COALESCE(SUM(CASE WHEN t.deleted_at IS NULL AND t.transaction_type = 'PURCHASE' THEN t.net_amount ELSE 0 END), 0) AS total_purchase,
      COALESCE(SUM(CASE WHEN t.deleted_at IS NULL AND t.transaction_type = 'EXPENSE' THEN t.net_amount ELSE 0 END), 0) AS total_expense,
      COALESCE(SUM(CASE WHEN t.deleted_at IS NULL AND t.transaction_type = 'INCOME' THEN t.net_amount ELSE 0 END), 0) AS total_income,
      COUNT(CASE WHEN t.transaction_type = 'SALE' THEN 1 END) AS count_sale,
      COUNT(CASE WHEN t.transaction_type = 'PURCHASE' THEN 1 END) AS count_purchase,
      COUNT(CASE WHEN t.transaction_type = 'EXPENSE' THEN 1 END) AS count_expense,
      COUNT(CASE WHEN t.transaction_type = 'INCOME' THEN 1 END) AS count_income,
      COUNT(*) AS total_count
    FROM transactions t
    LEFT JOIN suppliers s ON s.id = t.supplier_id
    LEFT JOIN reservations r ON r.id = t.reservation_id
    LEFT JOIN bookings b ON b.id = COALESCE(t.booking_id, r.booking_id)
    ${whereClause}
  `;

  const summaryRes = await pool.query(summaryQuery, values);
  const sRow = summaryRes.rows[0];

  const summary: TransactionSummary = {
    total_sale: Number(sRow.total_sale || 0),
    total_purchase: Number(sRow.total_purchase || 0),
    total_expense: Number(sRow.total_expense || 0),
    total_income: Number(sRow.total_income || 0),
    count_sale: Number(sRow.count_sale || 0),
    count_purchase: Number(sRow.count_purchase || 0),
    count_expense: Number(sRow.count_expense || 0),
    count_income: Number(sRow.count_income || 0),
  };

  const totalCount = Number(sRow.total_count || 0);
  const limit = Math.min(100, Math.max(1, Number(params.limit || 50)));
  const offset = Math.max(0, Number(params.offset || 0));

  // Authoritatively derive paid_amount and outstanding from payment_transactions
  const listQuery = `
    SELECT t.*,
           s.name AS supplier_name,
           s.phone AS supplier_phone,
           r.booking_number,
           r.stay_type,
           b.bid AS booking_bid,
           b.booking_source,
           COALESCE(pmt.total_paid, 0) AS paid_amount,
           GREATEST(0, t.net_amount - COALESCE(pmt.total_paid, 0)) AS outstanding_amount
    FROM transactions t
    LEFT JOIN suppliers s ON s.id = t.supplier_id
    LEFT JOIN reservations r ON r.id = t.reservation_id
    LEFT JOIN bookings b ON b.id = COALESCE(t.booking_id, r.booking_id)
    LEFT JOIN LATERAL (
      SELECT SUM(pt.amount)::bigint AS total_paid
      FROM payment_transactions pt
      WHERE (pt.transaction_id = t.id OR (t.reservation_id IS NOT NULL AND pt.reservation_id = t.reservation_id))
        AND pt.status = 'SUCCESS'
        AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
    ) pmt ON TRUE
    ${whereClause}
    ORDER BY t.transaction_date DESC, t.transaction_time DESC, t.id DESC
    LIMIT $${valIdx++} OFFSET $${valIdx++}
  `;

  const listRes = await pool.query(listQuery, [...values, limit, offset]);

  const transactions = listRes.rows.map((row: any) => ({
    ...row,
    operational_sheet: deriveOperationalSheet(row)
  }));

  return {
    transactions,
    total_count: totalCount,
    summary,
    sheet_counts,
    limit,
    offset
  };
}

/**
 * Fetches single transaction with lines, supplier, purpose-aware attachments, and authoritative settlements.
 */
export async function getTransactionById(
  pool: Pool,
  propertyId: number,
  id: number | string
): Promise<any> {
  const txRes = await pool.query(
    `SELECT t.*,
            s.name AS supplier_name,
            s.phone AS supplier_phone,
            s.bank_name AS supplier_bank_name,
            s.bank_account AS supplier_bank_account,
            s.address AS supplier_address,
            r.check_in,
            r.check_out,
            r.total_price as reservation_total_price,
            r.amount_paid as reservation_amount_paid,
            r.remaining_balance as reservation_remaining_balance,
            r.booking_number,
            r.status as reservation_status,
            b.bid as booking_bid,
            b.booking_source,
            b.channel as booking_channel,
            rev_orig.transaction_no as original_transaction_no,
            rev_repl.transaction_no as reversal_transaction_no,
            COALESCE(pmt.total_paid, 0) AS paid_amount,
            GREATEST(0, t.net_amount - COALESCE(pmt.total_paid, 0)) AS outstanding_amount
     FROM transactions t
     LEFT JOIN suppliers s ON s.id = t.supplier_id
     LEFT JOIN reservations r ON r.id = t.reservation_id
     LEFT JOIN bookings b ON b.id = t.booking_id
     LEFT JOIN transactions rev_orig ON rev_orig.id = t.reversal_of_transaction_id
     LEFT JOIN transactions rev_repl ON rev_repl.reversal_of_transaction_id = t.id
     LEFT JOIN LATERAL (
       SELECT SUM(pt.amount)::bigint AS total_paid
       FROM payment_transactions pt
       WHERE (pt.transaction_id = t.id OR (t.reservation_id IS NOT NULL AND pt.reservation_id = t.reservation_id))
         AND pt.status = 'SUCCESS'
         AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
     ) pmt ON TRUE
     WHERE t.id = $1 AND t.property_id = $2`,
    [id, propertyId]
  );

  if ((txRes.rowCount ?? 0) === 0) {
    const err: any = new Error(`Transaksi #${id} tidak ditemukan`);
    err.statusCode = 404;
    throw err;
  }

  const tx = txRes.rows[0];

  // Fetch transaction lines
  const linesRes = await pool.query(
    `SELECT id::text, property_id, transaction_id::text, product_id::text, description_snapshot,
            quantity, unit, unit_price, discount_amount, line_total, sort_order, created_at
     FROM transaction_lines
     WHERE transaction_id = $1 AND property_id = $2
     ORDER BY sort_order ASC, id ASC`,
    [id, propertyId]
  );

  // Fetch purpose-aware attachments
  const attRes = await pool.query(
    `SELECT id::text, property_id, transaction_id::text, file_name, original_name,
            mime_type, file_size, storage_path, uploaded_by, uploaded_at, attachment_purpose
     FROM transaction_attachments
     WHERE transaction_id = $1 AND property_id = $2
     ORDER BY uploaded_at ASC`,
    [id, propertyId]
  );

  // Fetch authoritative payment settlements
  const pmtRes = await pool.query(
    `SELECT id, transaction_type, amount, payment_method, reference_code, status, created_by, created_at
     FROM payment_transactions
     WHERE (transaction_id = $1 OR (reservation_id IS NOT NULL AND reservation_id = $2))
     ORDER BY created_at DESC`,
    [id, tx.reservation_id || -1]
  );

  // Fetch audit logs
  const auditRes = await pool.query(
    `SELECT audit_id as id, action, new_value as details, timestamp as created_at
     FROM audit_logs
     WHERE entity = 'transactions' AND record_id = $1
     ORDER BY audit_id DESC`,
    [String(id)]
  );

  return {
    ...tx,
    operational_sheet: deriveOperationalSheet(tx),
    lines: linesRes.rows,
    attachments: attRes.rows,
    linked_payments: pmtRes.rows,
    audit_logs: auditRes.rows
  };
}

/**
 * Adds purpose-aware attachment to a transaction.
 */
export async function addTransactionAttachment(
  pool: Pool,
  propertyId: number,
  transactionId: number | string,
  attachment: {
    fileName: string;
    originalName: string;
    mimeType: string;
    fileSize: number;
    storagePath: string;
    uploadedBy?: string | null;
    attachmentPurpose?: AttachmentPurpose;
  }
): Promise<any> {
  const txCheck = await pool.query(
    'SELECT id, transaction_no, verification_status FROM transactions WHERE id = $1 AND property_id = $2',
    [transactionId, propertyId]
  );
  if ((txCheck.rowCount ?? 0) === 0) {
    const err: any = new Error(`Transaksi #${transactionId} tidak ditemukan`);
    err.statusCode = 404;
    throw err;
  }

  const purpose: AttachmentPurpose = attachment.attachmentPurpose || 'RECEIPT';

  const insertRes = await pool.query(
    `INSERT INTO transaction_attachments (
      property_id, transaction_id, file_name, original_name,
      mime_type, file_size, storage_path, uploaded_by, attachment_purpose
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6, $7, $8, $9
    ) RETURNING *`,
    [
      propertyId,
      transactionId,
      attachment.fileName,
      attachment.originalName,
      attachment.mimeType,
      attachment.fileSize,
      attachment.storagePath,
      attachment.uploadedBy || 'Staff',
      purpose
    ]
  );

  await pool.query(
    `INSERT INTO audit_logs (
      module, action, entity, record_id, new_value, property_id
    ) VALUES (
      'TRANSACTIONS', 'ATTACHMENT_ADDED', 'transactions', $1, $2, $3
    )`,
    [
      String(transactionId),
      JSON.stringify({
        attachment_id: insertRes.rows[0].id,
        file_name: attachment.fileName,
        original_name: attachment.originalName,
        attachment_purpose: purpose
      }),
      propertyId
    ]
  );

  return insertRes.rows[0];
}

/**
 * Deletes an attachment from a transaction with verification safety.
 */
export async function deleteTransactionAttachment(
  pool: Pool,
  propertyId: number,
  transactionId: number | string,
  attachmentId: number | string,
  actorName?: string | null
): Promise<{ success: boolean }> {
  const attCheck = await pool.query(
    `SELECT ta.id, ta.file_name, ta.original_name, t.verification_status
     FROM transaction_attachments ta
     JOIN transactions t ON t.id = ta.transaction_id
     WHERE ta.id = $1 AND ta.transaction_id = $2 AND ta.property_id = $3`,
    [attachmentId, transactionId, propertyId]
  );
  if ((attCheck.rowCount ?? 0) === 0) {
    const err: any = new Error(`Bukti transaksi #${attachmentId} tidak ditemukan`);
    err.statusCode = 404;
    throw err;
  }

  const att = attCheck.rows[0];
  if (att.verification_status === 'VERIFIED') {
    throw new Error('Bukti transaksi tidak dapat dihapus karena transaksi sudah dalam status TERVERIFIKASI.');
  }

  await pool.query(
    'DELETE FROM transaction_attachments WHERE id = $1 AND property_id = $2',
    [attachmentId, propertyId]
  );

  await pool.query(
    `INSERT INTO audit_logs (
      module, action, entity, record_id, new_value, property_id
    ) VALUES (
      'TRANSACTIONS', 'ATTACHMENT_DELETED', 'transactions', $1, $2, $3
    )`,
    [
      String(transactionId),
      JSON.stringify({
        attachment_id: attachmentId,
        original_name: att.original_name,
        deleted_by: actorName || 'Staff'
      }),
      propertyId
    ]
  );

  return { success: true };
}

/**
 * Historical Reconciliation Utility.
 */
export async function reconcileHistoricalTransactions(
  pool: Pool,
  propertyId: number,
  dryRun: boolean = true
): Promise<{
  total_folio_charges: number;
  already_projected: number;
  projected_count: number;
  skipped_count: number;
  results: Array<{ folio_entry_id: number; description: string; amount: number; type: string; status: string }>;
}> {
  const chargesRes = await pool.query(
    `SELECT fe.id, fe.entry_type, fe.source_type, fe.description, fe.amount, fe.direction, fe.reservation_id
     FROM folio_entries fe
     WHERE (fe.property_id = $1 OR fe.property_id IS NULL)
       AND (fe.direction = 'DEBIT' OR fe.entry_type = 'REVERSAL')
     ORDER BY fe.id ASC`,
    [propertyId]
  );

  let alreadyProjected = 0;
  let projectedCount = 0;
  let skippedCount = 0;
  const results: any[] = [];

  for (const row of chargesRes.rows) {
    const existing = await pool.query(
      `SELECT id, transaction_no, net_amount FROM transactions 
       WHERE property_id = $1 AND source_id = $2 AND reversal_of_transaction_id IS NULL
       LIMIT 1`,
      [propertyId, String(row.id)]
    );

    if ((existing.rowCount ?? 0) > 0) {
      alreadyProjected++;
      results.push({
        folio_entry_id: row.id,
        description: row.description,
        amount: Number(row.amount),
        type: row.entry_type,
        status: `ALREADY_EXISTS (${existing.rows[0].transaction_no})`
      });
    } else {
      if (!dryRun) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const tx = await projectFolioEntryToTransaction(client, row.id, { propertyId });
          await client.query('COMMIT');
          if (tx) {
            projectedCount++;
            results.push({
              folio_entry_id: row.id,
              description: row.description,
              amount: Number(row.amount),
              type: tx.transaction_type,
              status: `PROJECTED (${tx.transaction_no})`
            });
          } else {
            skippedCount++;
            results.push({
              folio_entry_id: row.id,
              description: row.description,
              amount: Number(row.amount),
              type: row.entry_type,
              status: 'SKIPPED (non-charge entry)'
            });
          }
        } catch (e: any) {
          await client.query('ROLLBACK').catch(() => {});
          results.push({
            folio_entry_id: row.id,
            description: row.description,
            amount: Number(row.amount),
            type: row.entry_type,
            status: `ERROR (${e.message})`
          });
        } finally {
          client.release();
        }
      } else {
        projectedCount++;
        results.push({
          folio_entry_id: row.id,
          description: row.description,
          amount: Number(row.amount),
          type: row.entry_type === 'PENALTY' ? 'INCOME' : 'SALE',
          status: 'WOULD_PROJECT'
        });
      }
    }
  }

  const posOrdersRes = await pool.query(
    `SELECT po.id, po.order_number, po.total_amount, po.status, po.guest_name
     FROM pos_orders po
     WHERE (po.property_id = $1 OR po.property_id IS NULL)
       AND UPPER(po.status) IN ('PAID', 'COMPLETED', 'POSTED', 'CLOSED')
     ORDER BY po.id ASC`,
    [propertyId]
  );

  for (const pOrder of posOrdersRes.rows) {
    const existingPosTx = await pool.query(
      `SELECT id, transaction_no, net_amount FROM transactions 
       WHERE property_id = $1 AND source_type IN ('POS_ORDER', 'POS') AND source_id = $2 AND reversal_of_transaction_id IS NULL
       LIMIT 1`,
      [propertyId, String(pOrder.id)]
    );

    if ((existingPosTx.rowCount ?? 0) > 0) {
      alreadyProjected++;
      results.push({
        folio_entry_id: pOrder.id,
        description: `Pesanan POS #${pOrder.order_number}`,
        amount: Number(pOrder.total_amount),
        type: 'SALE',
        status: `ALREADY_EXISTS (${existingPosTx.rows[0].transaction_no})`
      });
    } else {
      if (!dryRun) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const tx = await projectPosOrderToTransaction(client, pOrder.id, { propertyId });
          await client.query('COMMIT');
          if (tx) {
            projectedCount++;
            results.push({
              folio_entry_id: pOrder.id,
              description: `Pesanan POS #${pOrder.order_number}`,
              amount: Number(pOrder.total_amount),
              type: tx.transaction_type,
              status: `PROJECTED (${tx.transaction_no})`
            });
          }
        } catch (e: any) {
          await client.query('ROLLBACK').catch(() => {});
          results.push({
            folio_entry_id: pOrder.id,
            description: `Pesanan POS #${pOrder.order_number}`,
            amount: Number(pOrder.total_amount),
            type: 'SALE',
            status: `ERROR (${e.message})`
          });
        } finally {
          client.release();
        }
      } else {
        projectedCount++;
        results.push({
          folio_entry_id: pOrder.id,
          description: `Pesanan POS #${pOrder.order_number}`,
          amount: Number(pOrder.total_amount),
          type: 'SALE',
          status: 'WOULD_PROJECT'
        });
      }
    }
  }

  return {
    total_folio_charges: chargesRes.rows.length + posOrdersRes.rows.length,
    already_projected: alreadyProjected,
    projected_count: projectedCount,
    skipped_count: skippedCount,
    results
  };
}

/**
 * Safely soft-deletes an eligible draft transaction (PURCHASE or EXPENSE).
 * Guarantees zero hard deletion and preserves full audit visibility in the HAPUS sheet.
 */
export async function softDeleteTransaction(
  pool: Pool,
  propertyId: number,
  id: number | string,
  dto: SoftDeleteTransactionDto
): Promise<TransactionRow> {
  if (!dto.delete_reason || !dto.delete_reason.trim()) {
    const err: any = new Error('Alasan hapus (delete reason) wajib diisi');
    err.statusCode = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const txRes = await client.query(
      `SELECT t.*,
              COALESCE(pmt.total_paid, 0) AS paid_amount,
              COALESCE(pmt.payment_count, 0) AS payment_count
       FROM transactions t
       LEFT JOIN LATERAL (
         SELECT SUM(pt.amount)::bigint AS total_paid,
                COUNT(*)::int AS payment_count
         FROM payment_transactions pt
         WHERE (pt.transaction_id = t.id OR (t.reservation_id IS NOT NULL AND pt.reservation_id = t.reservation_id))
           AND pt.status = 'SUCCESS'
           AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
       ) pmt ON TRUE
       WHERE t.id = $1 AND t.property_id = $2
       FOR UPDATE OF t`,
      [id, propertyId]
    );

    if ((txRes.rowCount ?? 0) === 0) {
      const err: any = new Error(`Transaksi #${id} tidak ditemukan`);
      err.statusCode = 404;
      throw err;
    }

    const tx = txRes.rows[0];

    if (tx.deleted_at) {
      const err: any = new Error(`Transaksi #${tx.transaction_no} sudah dalam status HAPUS.`);
      err.statusCode = 400;
      throw err;
    }

    // Only PURCHASE and EXPENSE can be soft-deleted
    if (!['PURCHASE', 'EXPENSE'].includes(tx.transaction_type)) {
      const err: any = new Error(`Transaksi tipe ${tx.transaction_type} tidak mendukung penghapusan draft. Gunakan Batal / Void.`);
      err.statusCode = 400;
      throw err;
    }

    // Guard: cannot delete if payments exist
    if (Number(tx.payment_count) > 0 || Number(tx.paid_amount) > 0) {
      const err: any = new Error(`Transaksi #${tx.transaction_no} tidak dapat dihapus karena sudah memiliki pembayaran. Gunakan Batal / Void.`);
      err.statusCode = 400;
      throw err;
    }

    // Guard: cannot delete if fully received
    if (tx.receiving_status === 'DITERIMA' || tx.receiving_status === 'DITERIMA_LENGKAP') {
      const err: any = new Error(`Transaksi pembelian #${tx.transaction_no} tidak dapat dihapus karena barang sudah diterima lengkap. Gunakan Batal / Void.`);
      err.statusCode = 400;
      throw err;
    }

    // Guard: cannot delete if verified
    if (tx.verification_status === 'VERIFIED') {
      const err: any = new Error(`Transaksi #${tx.transaction_no} tidak dapat dihapus karena sudah terverifikasi. Batalkan verifikasi terlebih dahulu.`);
      err.statusCode = 400;
      throw err;
    }

    // Guard: cannot delete if reversal or folio/pos projection
    if (tx.reversal_of_transaction_id || tx.reservation_id || tx.booking_id) {
      const err: any = new Error(`Transaksi terkait reservasi/reversal tidak dapat dihapus.`);
      err.statusCode = 400;
      throw err;
    }

    const deleteReason = dto.delete_reason.trim();
    const actorName = dto.actor_name || 'Staff';
    const actorUserId = dto.actor_user_id || null;

    const updateRes = await client.query(
      `UPDATE transactions
       SET deleted_at = NOW(),
           deleted_by_user_id = $1,
           deleted_by_name_snapshot = $2,
           delete_reason = $3,
           updated_at = NOW()
       WHERE id = $4 AND property_id = $5
       RETURNING *`,
      [actorUserId, actorName, deleteReason, id, propertyId]
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (
        module, action, entity, record_id, new_value, property_id
      ) VALUES (
        'TRANSACTIONS', 'TRANSACTION_SOFT_DELETED', 'transactions', $1, $2, $3
      )`,
      [
        String(id),
        JSON.stringify({
          transaction_no: tx.transaction_no,
          transaction_type: tx.transaction_type,
          delete_reason: deleteReason,
          deleted_by: actorName,
          deleted_by_user_id: actorUserId
        }),
        propertyId
      ]
    );

    await client.query('COMMIT');

    const updatedRow = updateRes.rows[0];
    return {
      ...updatedRow,
      operational_sheet: 'HAPUS'
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
