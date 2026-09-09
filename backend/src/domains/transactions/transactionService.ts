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
  UpdateExpenseTransactionDto,
  CreateIncomeTransactionDto,
  VerifyTransactionDto,
  CreateCustomCategoryDto,
  CustomCategoryRow,
  UpdateReceivingStatusDto,
  SettleTransactionPaymentDto,
  SoftDeleteTransactionDto,
  OperationalSheet,
  PurchaseWorkflowStatus,
  PurchaseLifecycleAction,
  PurchaseLifecycleDto,
  PurchaseLifecycleAuditPayload,
  TransactionSheetCounts,
  TransactionQueryResult,
  TransactionFilterParams,
  TransactionSummary
} from './transactionTypes';
import { generateTransactionNumber, getHotelDateToday } from './transactionNumberService';
import { generateSupplierCode } from '../suppliers/supplierService';
import {
  buildLifecycleHistory,
  deriveReservationLinkedSaleSheet,
  groupSaleLifecycles,
  isLifecyclePrimaryInPeriod,
  presentLifecyclePrimary,
  siblingExpansionIds,
  comparePresentedListRows,
} from './saleLifecycleGrouping';
import {
  collectSaleBookingRefs,
  presentListWithSaleBidGrouping,
  type BookingReservationLifecycleRow,
} from './bookingBidGrouping';
import { presentedListKey, queryPresentedPage } from './transactionListQuery';
import { explicitPosOrderIdFromFolioEntry, shouldSkipFolioKeyedPosSale } from './saleSourceIdentity';
import { generatePurchaseDescription } from './purchaseSummary';
export { generatePurchaseDescription } from './purchaseSummary';
import {
  resolvePurchaseCategoryBinding,
  resolvePurchaseDepartmentBinding,
} from './purchaseSettingsService';
import { preparePurchaseCreateDto } from './purchaseFieldRulesService';

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
 * Authoritative Operational Lifecycle Sheet Derivation (TRANSACTION-2E + PURCHASE-2A1).
 * Priority Rule:
 * 1. deleted_at -> HAPUS
 * 2. transaction_status in (CANCELLED, VOIDED, REVERSED) -> BATAL
 * 3. PURCHASE: purchase_workflow_status SELESAI -> SELESAI (NULL fail-safe = PROSES)
 *    Receiving / verification do NOT directly determine the purchase sheet after 2A1.
 * 4. Fully completed non-purchase -> SELESAI (transaction_status=POSTED)
 * 5. In-progress / Draft / Pending -> PROSES
 */
const TERMINAL_TX_STATUSES = ['VOIDED', 'CANCELLED', 'REVERSED'] as const;

export function isTerminalTransactionStatus(status: unknown): boolean {
  return (TERMINAL_TX_STATUSES as readonly string[]).includes(String(status || '').toUpperCase());
}

/**
 * Resolve the original folio charge for a reversal row.
 * Prefer reversal_of_entry_id. Never treat stay-charge source_id (rule id) as a folio id.
 */
export function resolveOriginalFolioEntryId(entry: {
  reversal_of_entry_id?: unknown;
  reference_folio_entry_id?: unknown;
  related_folio_id?: unknown;
  source_id?: unknown;
}): string | null {
  const raw = entry.reversal_of_entry_id ?? entry.reference_folio_entry_id ?? entry.related_folio_id;
  const id = Number(raw);
  if (Number.isInteger(id) && id > 0) return String(id);
  return null;
}

export function resolvePurchaseWorkflowStatus(
  value: unknown
): PurchaseWorkflowStatus {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === 'SELESAI') return 'SELESAI';
  return 'PROSES';
}

export function deriveOperationalSheet(row: {
  transaction_type: string;
  transaction_status: string;
  receiving_status?: string | null;
  purchase_workflow_status?: string | null;
  expense_workflow_status?: string | null;
  deleted_at?: string | null;
  source_type?: string | null;
  reservation_id?: unknown;
  reservation_status?: string | null;
  reservation_stay_status?: string | null;
  stay_status?: string | null;
}): OperationalSheet {
  if (row.deleted_at) {
    return 'HAPUS';
  }
  const reservationSheet = deriveReservationLinkedSaleSheet(row);
  if (reservationSheet) {
    return reservationSheet;
  }
  const status = String(row.transaction_status || '').toUpperCase();
  if (isTerminalTransactionStatus(status)) {
    return 'BATAL';
  }
  const type = String(row.transaction_type || '').toUpperCase();
  if (type === 'PURCHASE') {
    return resolvePurchaseWorkflowStatus(row.purchase_workflow_status) === 'SELESAI'
      ? 'SELESAI'
      : 'PROSES';
  }
  // EXPENSE-1B: Expense workflow status takes precedence for EXPENSE type.
  if (type === 'EXPENSE') {
    if (row.expense_workflow_status === 'SELESAI') {
      return 'SELESAI';
    }
    return 'PROSES';
  }
  // For INCOME, SALE:
  if (status === 'POSTED') {
    return 'SELESAI';
  }
  return 'PROSES';
}

const PURCHASE_RECEIVING_STATUSES: ReceivingStatus[] = [
  'BELUM_DITERIMA',
  'DITERIMA_SEBAGIAN',
  'DITERIMA',
];

function purchaseValidationError(message: string): Error {
  const err: any = new Error(message);
  err.statusCode = 400;
  err.code = 'VALIDATION_ERROR';
  return err;
}

export function resolvePurchaseReceivingStatus(raw: unknown): ReceivingStatus {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return 'BELUM_DITERIMA';
  }
  const status = String(raw).trim();
  if (!PURCHASE_RECEIVING_STATUSES.includes(status as ReceivingStatus)) {
    throw purchaseValidationError(`Status penerimaan '${status}' tidak valid`);
  }
  return status as ReceivingStatus;
}

export async function resolvePurchaseCategoryForCreate(
  poolOrClient: Pool | PoolClient,
  propertyId: number,
  dto: { category_code?: string | null; category_name?: string | null }
): Promise<{ categoryCode: string; categoryName: string }> {
  const categoryCode = String(dto.category_code || '').trim() || 'SUPPLIES_PURCHASE';

  const system = TRANSACTION_CATEGORIES[categoryCode];
  if (system) {
    if (system.type !== 'PURCHASE') {
      throw purchaseValidationError(`Kategori '${categoryCode}' bukan kategori pembelian`);
    }
    return {
      categoryCode,
      categoryName: String(dto.category_name || '').trim() || system.name,
    };
  }

  const custom = await poolOrClient.query(
    `SELECT name, transaction_type, is_active
     FROM transaction_custom_categories
     WHERE property_id = $1 AND code = $2`,
    [propertyId, categoryCode]
  );
  if ((custom.rowCount ?? 0) > 0) {
    const row = custom.rows[0];
    if (String(row.transaction_type || '').toUpperCase() !== 'PURCHASE') {
      throw purchaseValidationError(`Kategori '${categoryCode}' bukan kategori pembelian`);
    }
    if (row.is_active === false) {
      throw purchaseValidationError(`Kategori pembelian '${categoryCode}' tidak valid`);
    }
    return {
      categoryCode,
      categoryName: String(dto.category_name || '').trim() || String(row.name || categoryCode),
    };
  }

  throw purchaseValidationError(`Kategori pembelian '${categoryCode}' tidak valid`);
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
  options: { propertyId?: number; actorName?: string; actorUserId?: string; discountAmount?: number } = {}
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
    const originalFolioEntryId = resolveOriginalFolioEntryId(entry);
    if (!originalFolioEntryId) {
      return null;
    }

    const origTxRes = await client.query(
      `SELECT * FROM transactions
       WHERE property_id = $1
         AND source_id = $2
         AND reversal_of_transaction_id IS NULL
         AND ($3::int IS NULL OR reservation_id = $3)
       ORDER BY id DESC
       LIMIT 1`,
      [propertyId, originalFolioEntryId, entry.reservation_id ? Number(entry.reservation_id) : null]
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
      const origDiscount = Math.round(Number(origTx.discount_amount || 0));
      const origNet = Math.round(Number(origTx.net_amount || 0));

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
          origDiscount !== 0 ? -Math.abs(origDiscount) : 0,
          -Math.abs(servAmt),
          -Math.abs(taxAmt),
          -Math.abs(origNet > 0 ? origNet : netAmt),
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
  const discountAmt = Math.max(0, Math.round(Number(options.discountAmount || 0)));
  const grossNet = Math.round(rawNetAmt > 0 ? rawNetAmt : (baseAmt + taxAmt + servAmt));
  const netAmt = Math.max(0, grossNet - discountAmt);
  const txDate = getHotelDateToday(entry.created_at);

  const posOrderId = explicitPosOrderIdFromFolioEntry(entry);
  if (posOrderId) {
    const existingPos = await client.query(
      `SELECT * FROM transactions
       WHERE property_id = $1
         AND source_type IN ('POS', 'POS_ORDER')
         AND source_id = $2
         AND reversal_of_transaction_id IS NULL
       LIMIT 1`,
      [propertyId, posOrderId]
    );
    const skip = shouldSkipFolioKeyedPosSale({
      propertyId,
      chargeSourceType: chargeType,
      folioEntryId,
      posOrderId,
      existingSales: existingPos.rows,
    });
    if (skip.skip && existingPos.rows[0]) {
      return existingPos.rows[0];
    }
  }

  const existingTx = await client.query(
    `SELECT * FROM transactions 
     WHERE property_id = $1 AND source_type = $2 AND source_id = $3 AND reversal_of_transaction_id IS NULL
     LIMIT 1`,
    [propertyId, chargeType, String(folioEntryId)]
  );

  if ((existingTx.rowCount ?? 0) > 0) {
    if (isTerminalTransactionStatus(existingTx.rows[0].transaction_status)) {
      return existingTx.rows[0];
    }
    const updated = await client.query(
      `UPDATE transactions SET
         amount = $1,
         tax_amount = $2,
         service_amount = $3,
         discount_amount = $4,
         net_amount = $5,
         description = $6,
         payment_status = $7,
         room_number_snapshot = COALESCE($8, room_number_snapshot),
         guest_name_snapshot = COALESCE($9, guest_name_snapshot),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $10
       RETURNING *`,
      [
        baseAmt,
        taxAmt,
        servAmt,
        discountAmt,
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
      discount_amount = EXCLUDED.discount_amount,
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
      discountAmt,
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
  const canonicalPropertyId = Number(order.property_id);
  if (!Number.isInteger(canonicalPropertyId) || canonicalPropertyId <= 0) {
    const err: any = new Error(`POS Order #${orderId} tidak memiliki property_id yang valid`);
    err.statusCode = 422;
    err.code = 'POS_ORDER_PROPERTY_REQUIRED';
    throw err;
  }

  if (options.propertyId !== undefined && options.propertyId !== null && String(options.propertyId).trim() !== '') {
    const requestedPropertyId = Number(options.propertyId);
    if (!Number.isInteger(requestedPropertyId) || requestedPropertyId <= 0) {
      const err: any = new Error('property_id is required');
      err.statusCode = 400;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }
    if (requestedPropertyId !== canonicalPropertyId) {
      const err: any = new Error(`POS Order #${orderId} bukan milik properti #${requestedPropertyId}`);
      err.statusCode = 403;
      err.code = 'CROSS_PROPERTY_ORDER';
      throw err;
    }
  }

  const propertyId = canonicalPropertyId;
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
        purchase_workflow_status,
        notes, metadata, created_by
      ) VALUES (
        $1, $2, $3, CURRENT_TIMESTAMP,
        $4, $5, NULL, $6, $7,
        $8, $9, $10, $11,
        $12, 0, 0, 0, $12,
        'PAID', $13, 'POSTED',
        $14, $15, $16, $17,
        $18,
        $19, $20, $21
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
        String(dto.transaction_type).toUpperCase() === 'PURCHASE' ? 'PROSES' : null,
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

  if (!Array.isArray(dto.lines) || dto.lines.length === 0) {
    const err: any = new Error('Minimal harus ada 1 item produk pesanan pada pembelian');
    err.statusCode = 400;
    throw err;
  }

  dto = await preparePurchaseCreateDto(pool, dto);

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

  const receivingStatus = resolvePurchaseReceivingStatus(dto.receiving_status);
  const category = await resolvePurchaseCategoryBinding(pool, propertyId, dto);
  const department = await resolvePurchaseDepartmentBinding(pool, propertyId, dto);
  const categoryCode = category.code;
  const categoryName = category.name;
  const purchaseCategoryId = category.id;
  const departmentId = department.id;
  const departmentNameSnapshot = department.name;
  const departmentCode = department.code;

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
      if ((supCheck.rowCount ?? 0) === 0) {
        const err: any = new Error(`Supplier #${supplierId} bukan milik properti #${propertyId}`);
        err.statusCode = 403;
        err.code = 'CROSS_PROPERTY_SUPPLIER';
        throw err;
      }
      supplierName = supCheck.rows[0].name;
    }

    const lineDescriptions = dto.lines.map((line) => line.description_snapshot || line.description || '');
    const description = String(dto.description || '').trim()
      || generatePurchaseDescription({
        lineDescriptions,
        supplierName,
      });

    const txDate = dto.transaction_date || getHotelDateToday();
    const txNumber = await generateTransactionNumber(client, propertyId, txDate);
    const receivedAt = dto.received_at ? new Date(dto.received_at).toISOString() : (receivingStatus === 'DITERIMA' ? new Date().toISOString() : null);

    // PURCHASE-2A1: respect explicit workflow/verification on creation; fall back to safe defaults.
    const purchaseWorkflowStatus = dto.purchase_workflow_status
      ? (['PROSES', 'SELESAI'].includes(dto.purchase_workflow_status) ? dto.purchase_workflow_status : 'PROSES')
      : 'PROSES';
    const verificationStatus = dto.verification_status && ['UNVERIFIED', 'VERIFIED', 'REJECTED'].includes(dto.verification_status)
      ? dto.verification_status
      : 'UNVERIFIED';

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
        purchase_workflow_status,
        notes, metadata, created_by,
        purchase_category_id, department_id, department_name_snapshot
      ) VALUES (
        $1, $2, $3, CURRENT_TIMESTAMP,
        'PURCHASE', 'MANUAL_PURCHASE', $4, $5,
        $6, $7, $8, $9,
        0, $10, 0, 0, $11, 0,
        'UNPAID', $12, 'POSTED',
        $13, $14, $15, $16,
        $17,
        $18, $19, $20,
        $21, $22, $23
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
        description,
        transactionDiscount,
        roundingAmount,
        dto.payment_method || null,
        supplierId,
        receivingStatus,
        receivedAt,
        verificationStatus,
        purchaseWorkflowStatus,
        dto.notes?.trim() || null,
        JSON.stringify({ workflow: 'PURCHASE_2D', actor: dto.actor_name || 'Staff' }),
        dto.actor_name || dto.actor_user_id || 'Staff',
        purchaseCategoryId,
        departmentId,
        departmentNameSnapshot
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
          String(line.unit || '').trim(),
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

    // 4. Settlement only — never a second PURCHASE/EXPENSE.
    const paidAmountRaw = dto.paid_amount;
    const hasPaidAmount = paidAmountRaw !== undefined && paidAmountRaw !== null && String(paidAmountRaw) !== '';
    let paidAmount = hasPaidAmount ? Math.max(0, Math.round(Number(paidAmountRaw) || 0)) : 0;
    if (dto.is_immediately_paid === false && !hasPaidAmount) {
      paidAmount = 0;
    } else if (dto.is_immediately_paid === true && !hasPaidAmount) {
      paidAmount = Math.max(0, finalNetAmount);
    }
    let paymentStatus = 'UNPAID';

    if (paidAmount > 0) {
      const settleMethod = String(dto.payment_method || '').trim();
      if (!settleMethod) {
        throw purchaseValidationError('Metode pembayaran wajib dipilih');
      }
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
          settleMethod,
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
        notes, metadata, created_by,
        recipient_bank_name, recipient_bank_account, recipient_bank_holder,
        expense_workflow_status
      ) VALUES (
        $1, $2, $3, CURRENT_TIMESTAMP,
        'EXPENSE', 'MANUAL_EXPENSE', $4, $5,
        $6, $7, $8, $9,
        $10, 0, 0, 0, 0, $10,
        $11, $12, 'POSTED',
        $13, NULL, NULL, 'UNVERIFIED',
        $14, $15, $16,
        $17, $18, $19,
        'PROSES'
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
        dto.actor_name || dto.actor_user_id || 'Staff',
        dto.recipient_bank_name?.trim() || null,
        dto.recipient_bank_account?.trim() || null,
        dto.recipient_bank_holder?.trim() || null,
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
 * EDIT-1B: Update an existing Expense transaction.
 *
 * Business rules:
 * - Transaction must be EXPENSE type, property-scoped
 * - Operational workflow must be 'PROSES' (derived from expense_workflow_status)
 * - Rejects SELESAI/VOIDED/CANCELLED/REVERSED/HAPUS with 409
 * - Preserves: id, transaction_no, transaction_type, source_type, created_at, created_by
 * - Updates mutable fields only
 * - Synchronizes payment_transactions amount+method atomically (no duplicate rows)
 * - Resets verification to UNVERIFIED and clears verifier metadata
 * - Writes EXPENSE_UPDATED audit event
 */
export async function updateExpenseTransaction(
  pool: Pool,
  id: number | string,
  dto: UpdateExpenseTransactionDto
): Promise<TransactionRow> {
  const propertyId = Number(dto.property_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    const err: any = new Error('property_id wajib diisi dan harus valid');
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Row-lock and validate
    const prevRes = await client.query(
      `SELECT id, transaction_no, transaction_type, transaction_status,
              verification_status, expense_workflow_status,
              verified_by_user_id, verified_by_name_snapshot, verified_at, deleted_at,
              party_name, description, amount, payment_method,
              category_code, department_code, source_reference, notes,
              recipient_bank_name, recipient_bank_account, recipient_bank_holder
       FROM transactions
       WHERE id = $1 AND property_id = $2 FOR UPDATE`,
      [id, propertyId]
    );

    if ((prevRes.rowCount ?? 0) === 0) {
      const err: any = new Error(`Transaksi #${id} tidak ditemukan`);
      err.statusCode = 404;
      throw err;
    }

    const prev = prevRes.rows[0];

    if (String(prev.transaction_type || '').toUpperCase() !== 'EXPENSE') {
      const err: any = new Error(`Transaksi #${id} bukan tipe EXPENSE`);
      err.statusCode = 400;
      throw err;
    }

    assertNonTerminal(prev.transaction_status);

    if (prev.deleted_at) {
      const err: any = new Error(`Transaksi #${id} telah dihapus dan tidak dapat diubah.`);
      err.statusCode = 409;
      throw err;
    }

    // 2. PROSES-only enforcement
    const workflowStatus = String(prev.expense_workflow_status || 'PROSES').toUpperCase();
    if (workflowStatus === 'SELESAI') {
      const err: any = new Error('Transaksi pengeluaran ini sudah SELESAI. Ubah workflow kembali ke PROSES terlebih dahulu.');
      err.statusCode = 409;
      throw err;
    }
    if (workflowStatus === 'BATAL') {
      const err: any = new Error('Transaksi pengeluaran ini telah dibatalkan dan tidak dapat diedit.');
      err.statusCode = 409;
      throw err;
    }
    if (workflowStatus === 'HAPUS') {
      const err: any = new Error('Transaksi pengeluaran ini telah dihapus dan tidak dapat diedit.');
      err.statusCode = 409;
      throw err;
    }

    // 3. Resolve category meta (for name fallback, same as create)
    const catMeta = await getCategoryMeta(pool, propertyId, dto.category_code, 'EXPENSE');
    const categoryName = dto.category_name || catMeta.name;
    const departmentCode = dto.department_code || catMeta.defaultDept;
    const paymentMethod = dto.payment_method || prev.payment_method || 'CASH';

    // 3.5. Validate supplier_id if provided (must belong to same property)
    let supplierId = dto.supplier_id ?? null;
    if (supplierId !== null && supplierId !== undefined) {
      const supCheck = await client.query(
        `SELECT id FROM suppliers WHERE id = $1 AND property_id = $2 AND deleted_at IS NULL`,
        [supplierId, propertyId]
      );
      if ((supCheck.rowCount ?? 0) === 0) {
        const err: any = new Error(`Supplier #${supplierId} bukan milik properti #${propertyId}`);
        err.statusCode = 403;
        err.code = 'CROSS_PROPERTY_SUPPLIER';
        throw err;
      }
    }

    // 3.6. Validate transaction_date if provided (YYYY-MM-DD format)
    let newTransactionDate = prev.transaction_date;
    if (dto.transaction_date) {
      const dateStr = String(dto.transaction_date).trim();
      // Validate YYYY-MM-DD format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const err: any = new Error('Format tanggal transaksi harus YYYY-MM-DD');
        err.statusCode = 400;
        throw err;
      }
      // Validate it's a real date
      const parsed = new Date(dateStr + 'T00:00:00Z');
      if (isNaN(parsed.getTime())) {
        const err: any = new Error('Tanggal transaksi tidak valid');
        err.statusCode = 400;
        throw err;
      }
      newTransactionDate = dateStr;
    }

    // 4. Snapshot old mutable values for audit
    const oldSnapshot = {
      transaction_date: prev.transaction_date,
      supplier_id: prev.supplier_id,
      party_name: prev.party_name,
      description: prev.description,
      amount: prev.amount,
      payment_method: prev.payment_method,
      category_code: prev.category_code,
      department_code: prev.department_code,
      source_reference: prev.source_reference,
      notes: prev.notes,
      recipient_bank_name: prev.recipient_bank_name,
      recipient_bank_account: prev.recipient_bank_account,
      recipient_bank_holder: prev.recipient_bank_holder,
    };

    // 5. Update transaction header
    const updateRes = await client.query(
      `UPDATE transactions SET
          category_code = $1,
          category_name = $2,
          department_code = $3,
          supplier_id = $4,
          party_name = $5,
          description = $6,
          amount = $7,
          net_amount = $7,
          payment_method = $8,
          source_reference = $9,
          notes = $10,
          recipient_bank_name = $11,
          recipient_bank_account = $12,
          recipient_bank_holder = $13,
          transaction_date = $14,
          verification_status = 'UNVERIFIED',
          verified_by_user_id = NULL,
          verified_by_name_snapshot = NULL,
          verified_at = NULL,
          updated_at = NOW()
        WHERE id = $15 AND property_id = $16
        RETURNING *`,
      [
        dto.category_code,
        categoryName,
        departmentCode,
        supplierId,
        dto.party_name?.trim() || null,
        dto.description.trim(),
        amount,
        paymentMethod,
        dto.source_reference?.trim() || null,
        dto.notes?.trim() || null,
        dto.recipient_bank_name?.trim() || null,
        dto.recipient_bank_account?.trim() || null,
        dto.recipient_bank_holder?.trim() || null,
        newTransactionDate,
        id,
        propertyId,
      ]
    );

    if ((updateRes.rowCount ?? 0) === 0) {
      const err: any = new Error(`Transaksi #${id} tidak ditemukan setelah validasi`);
      err.statusCode = 404;
      throw err;
    }

    // 6. Check authoritative payment rows (SUCCESS only, locked for update)
    const payRes = await client.query(
      `SELECT id, amount, payment_method, reference_code, status
       FROM payment_transactions
       WHERE property_id = $1 AND transaction_id = $2 AND transaction_type = 'PAYMENT'
           AND status = 'SUCCESS'
       ORDER BY created_at ASC
       FOR UPDATE`,
      [propertyId, id]
    );

    const successfulPayments = payRes.rows;
    const paymentCount = successfulPayments.length;
    const existingPaymentStatus = String(prev.payment_status || 'UNPAID').toUpperCase();

    if (existingPaymentStatus === 'PAID') {
      if (paymentCount === 0) {
        // CASE B: PAID but zero authoritative SUCCESS payments -> integrity error
        const err: any = new Error(
          'EXPENSE_PAYMENT_INTEGRITY_ERROR: Transaksi berstatus PAID tetapi pembayaran authoritative tidak ditemukan.'
        );
        err.statusCode = 409;
        throw err;
      }
      if (paymentCount > 1) {
        // CASE C: Multiple successful payments -> not safe to edit directly
        const err: any = new Error(
          'EXPENSE_PAYMENT_INTEGRITY_ERROR: Transaksi memiliki lebih dari satu pembayaran dan tidak aman diedit langsung.'
        );
        err.statusCode = 409;
        throw err;
      }
      // CASE A: Exactly one authoritative SUCCESS payment -> update it in place
      const payRow = successfulPayments[0];
      await client.query(
        `UPDATE payment_transactions SET
           amount = $1,
           payment_method = $2,
           updated_at = NOW()
         WHERE id = $3 AND property_id = $4`,
        [amount, paymentMethod, payRow.id, propertyId]
      );
    } else {
      // CASE D: UNPAID or other non-PAID status
      // Do NOT create payment during edit — preserve payment history as-is
      if (paymentCount > 0) {
        // Edge case: UNPAID but has SUCCESS payments -> integrity issue
        const err: any = new Error(
          'EXPENSE_PAYMENT_INTEGRITY_ERROR: Transaksi berstatus UNPAID namun memiliki pembayaran SUCCESS. Periksa integritas data.'
        );
        err.statusCode = 409;
        throw err;
      }
    }

    // 7. Audit log
    const actor = dto.actor_name || dto.actor_user_id || 'Staff';
    await client.query(
      `INSERT INTO audit_logs (
        module, action, entity, record_id, new_value, property_id, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        'TRANSACTIONS',
        'EXPENSE_UPDATED',
        'transactions',
        String(id),
        JSON.stringify({
          transaction_no: prev.transaction_no,
          old: oldSnapshot,
          new: {
            party_name: dto.party_name?.trim() || null,
            description: dto.description.trim(),
            amount,
            payment_method: paymentMethod,
            category_code: dto.category_code,
            department_code: departmentCode,
            source_reference: dto.source_reference?.trim() || null,
            notes: dto.notes?.trim() || null,
            recipient_bank_name: dto.recipient_bank_name?.trim() || null,
            recipient_bank_account: dto.recipient_bank_account?.trim() || null,
            recipient_bank_holder: dto.recipient_bank_holder?.trim() || null,
          },
          actor,
          payment_rows_updated: paymentCount,
          payment_case: existingPaymentStatus === 'PAID'
            ? (paymentCount === 1 ? 'A_SINGLE_PAYMENT_UPDATED' : 'B_OR_C_REJECTED')
            : (paymentCount === 0 ? 'D_UNPAID_NO_PAYMENT_TOUCHED' : 'INTEGRITY_ERROR'),
          transaction_date_changed: oldSnapshot.transaction_date !== newTransactionDate,
          supplier_id_changed: oldSnapshot.supplier_id !== supplierId,
        }),
        propertyId,
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
 * INTERNAL: Canonical verification mutation — SINGLE source of truth for all verification writes.
 * Used by both verifyTransaction() and executeExpenseLifecycle(... SET_VERIFICATION ...).
 * Ensures a single verification contract: verified_at, verified_by, verification_note.
 * Accepts either a PoolClient (within a transaction) or a Pool (standalone query).
 * Does NOT write audit logs or modify expense_workflow_status — callers handle those.
 * Returns the actual updated row via RETURNING * for canonical state verification.
 *
 * CRITICAL CONTRACT (from baseline commit 18d7856):
 *   verified_by_user_id = actorUserId  (ALWAYS, not just VERIFIED)
 *   verified_by_name_snapshot = actorName  (ALWAYS, not just VERIFIED)
 *   verified_at = NOW()  (ALWAYS, for all statuses)
 * Do NOT clear verified_by fields on UNVERIFIED/REJECTED in generic path.
 */
async function applyCanonicalVerificationMutation(
  db: PoolClient | Pool,
  id: number | string,
  propertyId: number,
  newStatus: VerificationStatus,
  actorUserId: string | null,
  actorName: string | null,
  verificationNote: string | null,
  prevRow: { verification_status: string | null; transaction_type: string }
): Promise<any> {
  if (!['UNVERIFIED', 'VERIFIED', 'REJECTED'].includes(newStatus)) {
    throw new Error(`Status verifikasi '${newStatus}' tidak valid`);
  }

  const prevStatus = prevRow.verification_status;

  // Baseline contract: actor fields are ALWAYS written, regardless of target status.
  // This matches the committed EXPENSE-1B generic behavior exactly.
  const verifiedByUserId = actorUserId;
  const verifiedByName = actorName;

  // Use PostgreSQL NOW() directly in SQL — never reconstruct timestamps client-side.
  const updateRes = await db.query(
    `UPDATE transactions
     SET verification_status = $1::varchar,
         verified_by_user_id = $2,
         verified_by_name_snapshot = $3,
         verified_at = NOW(),
         verification_note = $4,
         updated_at = NOW()
     WHERE id = $5 AND property_id = $6
     RETURNING *`,
    [
      newStatus,
      verifiedByUserId,
      verifiedByName,
      verificationNote,
      id,
      propertyId,
    ]
  );

  if ((updateRes.rowCount ?? 0) === 0) {
    throw new Error(`Transaksi #${id} tidak ditemukan atau tidak dapat diubah`);
  }

  return updateRes.rows[0];
}

/**
 * TRANSACTION-2D: Verification Workflow.
 * Uses applyCanonicalVerificationMutation as the single canonical verification write path.
 * Preserves the committed EXPENSE-1B audit contract (TRANSACTION_VERIFIED action).
 * ATOMIC: All operations run within a single BEGIN/COMMIT transaction.
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Row-level lock for atomicity
    const txCheck = await client.query(
      `SELECT id, transaction_no, verification_status, transaction_type FROM transactions WHERE id = $1 AND property_id = $2 FOR UPDATE`,
      [id, propertyId]
    );
    if ((txCheck.rowCount ?? 0) === 0) {
      const err: any = new Error(`Transaksi #${id} tidak ditemukan`);
      err.statusCode = 404;
      throw err;
    }

    const prevRow = txCheck.rows[0];
    const prevStatus = prevRow.verification_status;

    // Delegate canonical verification mutation to the shared helper (same client).
    const canonicalRow = await applyCanonicalVerificationMutation(
      client,
      id,
      propertyId,
      status as VerificationStatus,
      dto.actor_user_id || null,
      dto.actor_name || 'Supervisor',
      dto.verification_note?.trim() || null,
      prevRow
    );

    // Expense-specific workflow auto-transition: VERIFIED => SELESAI, UNVERIFIED/REJECTED => PROSES
    if (prevRow.transaction_type.toUpperCase() === 'EXPENSE') {
      const newWorkflow = status === 'VERIFIED' ? 'SELESAI' : 'PROSES';
      await client.query(
        `UPDATE transactions SET expense_workflow_status = $1, updated_at = NOW() WHERE id = $2 AND property_id = $3`,
        [newWorkflow, id, propertyId]
      );
    }

    // Audit log — TRANSACTION_VERIFIED action (preserved from committed contract)
    await client.query(
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
    await client.query('COMMIT');

    return canonicalRow;
  } catch (err: any) {
    // Always roll back on ANY error to maintain atomicity
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback errors if connection is already dead
    }
    throw err;
  } finally {
    client.release();
  }
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
  if (!PURCHASE_RECEIVING_STATUSES.includes(status)) {
    const err: any = new Error(`Status penerimaan '${status}' tidak valid`);
    err.statusCode = 400;
    throw err;
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
 * One property-scoped lookup of all reservation children for SALE bookings
 * represented in the current list page candidates. Used for grouped BID
 * operational status (full booking lifecycle), not period financial totals.
 */
async function loadBookingReservationLifecycle(
  pool: Pool,
  propertyId: number,
  presented: any[]
): Promise<BookingReservationLifecycleRow[]> {
  const { bookingIds, bids } = collectSaleBookingRefs(presented);
  if (bookingIds.length === 0 && bids.length === 0) return [];
  const res = await pool.query(
    `SELECT b.property_id,
            b.id AS booking_id,
            b.bid AS booking_bid,
            r.id AS reservation_id,
            r.status AS reservation_status,
            r.stay_status AS reservation_stay_status
     FROM bookings b
     INNER JOIN reservations r ON r.booking_id = b.id
     WHERE b.property_id = $1
       AND (
         ($2::bigint[] <> '{}' AND b.id = ANY($2::bigint[]))
         OR ($3::text[] <> '{}' AND b.bid = ANY($3::text[]))
       )`,
    [propertyId, bookingIds, bids]
  );
  return res.rows;
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

  const targetSheet = String(params.operational_sheet || params.operational_status || '').toUpperCase();
  const limit = Math.min(100, Math.max(1, Number(params.limit || 50)));
  const offset = Math.max(0, Number(params.offset || 0));

  const listSelectSql = `
    SELECT t.*,
            s.name AS supplier_name,
            s.phone AS supplier_phone,
            s.bank_name AS supplier_bank_name,
            s.bank_account AS supplier_bank_account,
            s.bank_holder AS supplier_bank_holder,
           r.booking_number,
           r.stay_type,
           r.stay_sequence,
           r.status AS reservation_status,
           r.stay_status AS reservation_stay_status,
           r.check_in::text AS check_in,
           r.check_out::text AS check_out,
           r.amount_paid AS reservation_amount_paid,
           r.remaining_balance AS reservation_remaining_balance,
           r.booked_room_type_name_snapshot,
           COALESCE(rt_current.name, rt_booked.name, r.booked_room_type_name_snapshot) AS room_type_name,
           b.bid AS booking_bid,
           b.booking_status,
           b.booking_source,
           COALESCE(pmt.total_paid, 0) AS paid_amount,
           GREATEST(0, t.net_amount - COALESCE(pmt.total_paid, 0)) AS outstanding_amount
    FROM transactions t
    LEFT JOIN suppliers s ON s.id = t.supplier_id
    LEFT JOIN reservations r ON r.id = t.reservation_id
    LEFT JOIN bookings b ON b.id = COALESCE(t.booking_id, r.booking_id)
    LEFT JOIN rooms rm ON rm.id = r.room_id AND rm.property_id = t.property_id
    LEFT JOIN room_types rt_current ON rt_current.id = rm.room_type_id AND rt_current.property_id = t.property_id
    LEFT JOIN room_types rt_booked ON rt_booked.id = r.booked_room_type_id_snapshot AND rt_booked.property_id = t.property_id
    LEFT JOIN LATERAL (
      SELECT SUM(pt.amount)::bigint AS total_paid
      FROM payment_transactions pt
      WHERE (pt.transaction_id = t.id OR (t.reservation_id IS NOT NULL AND pt.reservation_id = t.reservation_id))
        AND pt.status = 'SUCCESS'
        AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
    ) pmt ON TRUE
  `;

  const hapusCountRes = await pool.query(
    `SELECT COUNT(*)::int AS count_hapus
     FROM transactions t
     LEFT JOIN suppliers s ON s.id = t.supplier_id
     LEFT JOIN reservations r ON r.id = t.reservation_id
     LEFT JOIN bookings b ON b.id = COALESCE(t.booking_id, r.booking_id)
     WHERE ${baseConditions.join(' AND ')}
       AND t.deleted_at IS NOT NULL`,
    baseValues
  );
  const hapusCount = Number(hapusCountRes.rows[0]?.count_hapus || 0);
  const unboundedAllTime = !params.start_date && !params.end_date && targetSheet !== 'HAPUS';
  const hasSearch = Boolean(params.search && params.search.trim());
  const usePresentedSqlPaging = targetSheet !== 'HAPUS' && (unboundedAllTime || hasSearch);

  if (usePresentedSqlPaging) {
    const pagePlan = await queryPresentedPage(pool, params, hapusCount);
    const expandBidSales = unboundedAllTime && !hasSearch;
    const pageBids = expandBidSales ? pagePlan.bids : [];
    const allTimeCandidates = pagePlan.transactionIds.length === 0 && pageBids.length === 0
      ? { rows: [] as any[] }
      : await pool.query(
        `${listSelectSql}
         WHERE t.property_id = $1
           AND t.deleted_at IS NULL
           AND (
             t.id = ANY($2::bigint[])
             OR (
               $3::text[] <> '{}'
               AND t.transaction_type = 'SALE'
               AND b.bid = ANY($3::text[])
             )
           )
         ORDER BY t.transaction_date DESC, t.transaction_time DESC, t.id DESC`,
        [propertyId, pagePlan.transactionIds.length > 0 ? pagePlan.transactionIds : [0], pageBids]
      );
    const candidates = allTimeCandidates.rows;
    const candidateIds = new Set(candidates.map((row: any) => Number(row.id)));
    let scopedRows = candidates;
    const expansion = siblingExpansionIds(candidates);
    if (candidates.length > 0) {
      const siblingRes = await pool.query(
        `${listSelectSql}
         WHERE t.property_id = $1
           AND t.deleted_at IS NULL
           AND (
             t.id = ANY($2::bigint[])
             OR t.reversal_of_transaction_id = ANY($2::bigint[])
             OR t.id = ANY($3::bigint[])
             OR t.reversal_of_transaction_id = ANY($3::bigint[])
             OR ($4::text[] <> '{}' AND t.correction_group_id = ANY($4::text[]))
             OR t.metadata->>'restored_from_transaction_id' = ANY($5::text[])
             OR t.metadata->>'reversal_transaction_id' = ANY($5::text[])
           )`,
        [
          propertyId,
          expansion.ids,
          expansion.parentIds.length > 0 ? expansion.parentIds : [0],
          expansion.groupIds,
          expansion.ids.map(String),
        ]
      );
      const byId = new Map<number, any>();
      for (const row of [...candidates, ...siblingRes.rows]) {
        byId.set(Number(row.id), row);
      }
      scopedRows = [...byId.values()];
    }
    const groups = groupSaleLifecycles(scopedRows).filter((group) => {
      if (!isLifecyclePrimaryInPeriod(group.primary.transaction_date, params.start_date, params.end_date)) {
        return false;
      }
      if (params.transaction_status) {
        const wanted = String(params.transaction_status).toUpperCase();
        if (String(group.primary.transaction_status || '').toUpperCase() !== wanted) return false;
      }
      return group.members.some((member) => candidateIds.has(Number(member.id)));
    });
    const presentedAll = groups.map((group) => presentLifecyclePrimary(group)).sort(comparePresentedListRows);
    const listType = String(params.transaction_type || '').toUpperCase();
    const saleBidGrouped = listType === 'SALE' || listType === ''
      ? presentListWithSaleBidGrouping(presentedAll, {
          lifecycleReservations: await loadBookingReservationLifecycle(pool, propertyId, presentedAll),
        })
      : null;
    const listSource = saleBidGrouped || presentedAll;
    const pageKeySet = new Set(pagePlan.keys);
    const sheetFiltered = targetSheet === 'PROSES' || targetSheet === 'SELESAI' || targetSheet === 'BATAL'
      ? listSource.filter((row: any) => row.operational_sheet === targetSheet)
      : listSource;
    const presented = sheetFiltered
      .filter((row: any) => pageKeySet.has(presentedListKey(row, propertyId)))
      .sort(comparePresentedListRows);
    return {
      transactions: presented,
      total_count: pagePlan.total_count,
      summary: pagePlan.summary,
      sheet_counts: pagePlan.sheet_counts,
      limit,
      offset,
      list_fetch_stats: {
        mode: unboundedAllTime ? 'ALL_TIME' : 'PERIOD',
        fetched_transaction_rows: scopedRows.length,
        presented_total: pagePlan.total_count,
        presented_page: presented.length,
      },
    };
  }

  const candidateRes = await pool.query(
    `${listSelectSql}
     WHERE ${baseConditions.join(' AND ')}
       AND t.deleted_at IS NULL
     ORDER BY t.transaction_date DESC, t.transaction_time DESC, t.id DESC`,
    baseValues
  );
  const candidates = candidateRes.rows;
  const candidateIds = new Set(candidates.map((row: any) => Number(row.id)));

  let scopedRows = candidates;
  const expansion = siblingExpansionIds(candidates);
  if (candidates.length > 0) {
    const siblingRes = await pool.query(
      `${listSelectSql}
       WHERE t.property_id = $1
         AND t.deleted_at IS NULL
         AND (
           t.id = ANY($2::bigint[])
           OR t.reversal_of_transaction_id = ANY($2::bigint[])
           OR t.id = ANY($3::bigint[])
           OR t.reversal_of_transaction_id = ANY($3::bigint[])
           OR ($4::text[] <> '{}' AND t.correction_group_id = ANY($4::text[]))
           OR t.metadata->>'restored_from_transaction_id' = ANY($5::text[])
           OR t.metadata->>'reversal_transaction_id' = ANY($5::text[])
         )`,
      [
        propertyId,
        expansion.ids,
        expansion.parentIds.length > 0 ? expansion.parentIds : [0],
        expansion.groupIds,
        expansion.ids.map(String),
      ]
    );
    const byId = new Map<number, any>();
    for (const row of [...candidates, ...siblingRes.rows]) {
      byId.set(Number(row.id), row);
    }
    scopedRows = [...byId.values()];
  }

  const groups = groupSaleLifecycles(scopedRows).filter((group) => {
    if (!isLifecyclePrimaryInPeriod(group.primary.transaction_date, params.start_date, params.end_date)) {
      return false;
    }
    if (unboundedAllTime) return true;
    return group.members.some((member) => candidateIds.has(Number(member.id)));
  });

  if (params.transaction_status) {
    const wanted = String(params.transaction_status).toUpperCase();
    for (let i = groups.length - 1; i >= 0; i -= 1) {
      if (String(groups[i].primary.transaction_status || '').toUpperCase() !== wanted) {
        groups.splice(i, 1);
      }
    }
  }

  const presentedAll = groups.map((group) => presentLifecyclePrimary(group)).sort(comparePresentedListRows);
  const listType = String(params.transaction_type || '').toUpperCase();
  const saleBidGrouped = listType === 'SALE' || listType === ''
    ? presentListWithSaleBidGrouping(presentedAll, {
        lifecycleReservations: await loadBookingReservationLifecycle(pool, propertyId, presentedAll),
      })
    : null;
  const sheetSource = saleBidGrouped || groups.map((group) => ({ operational_sheet: group.sheet }));
  const sheet_counts: TransactionSheetCounts = {
    proses: sheetSource.filter((row: any) => (row.operational_sheet || row.sheet) === 'PROSES').length,
    selesai: sheetSource.filter((row: any) => (row.operational_sheet || row.sheet) === 'SELESAI').length,
    batal: sheetSource.filter((row: any) => (row.operational_sheet || row.sheet) === 'BATAL').length,
    hapus: hapusCount,
  };

  if (targetSheet === 'HAPUS') {
    const hapusWhere = `WHERE ${baseConditions.join(' AND ')} AND t.deleted_at IS NOT NULL`;
    const hapusList = await pool.query(
      `${listSelectSql}
       ${hapusWhere}
       ORDER BY t.transaction_date DESC, t.transaction_time DESC, t.id DESC
       LIMIT $${valIdx} OFFSET $${valIdx + 1}`,
      [...baseValues, limit, offset]
    );
    const transactions = hapusList.rows.map((row: any) => ({
      ...row,
      operational_sheet: deriveOperationalSheet(row),
    }));
    return {
      transactions,
      total_count: hapusCount,
      summary: {
        total_sale: 0,
        total_purchase: 0,
        total_expense: 0,
        total_income: 0,
        count_sale: 0,
        count_purchase: 0,
        count_expense: 0,
        count_income: 0,
      },
      sheet_counts,
      limit,
      offset,
      list_fetch_stats: {
        mode: 'HAPUS',
        fetched_transaction_rows: transactions.length,
        presented_total: hapusCount,
        presented_page: transactions.length,
      },
    };
  }

  const listSource = saleBidGrouped || presentedAll;
  const presented = [...(targetSheet === 'PROSES' || targetSheet === 'SELESAI' || targetSheet === 'BATAL'
    ? listSource.filter((row: any) => row.operational_sheet === targetSheet)
    : listSource)].sort(comparePresentedListRows);
  const transactions = presented.slice(offset, offset + limit);

  const saleNetOf = (row: any) => {
    if (row.booking_bid_group && row.booking_bid_group.net != null) return Number(row.booking_bid_group.net || 0);
    return Number(row.effective_net_amount || 0);
  };

  const summary: TransactionSummary = {
    total_sale: presented
      .filter((row) => String(row.transaction_type).toUpperCase() === 'SALE')
      .reduce((sum, row) => sum + saleNetOf(row), 0),
    total_purchase: presented
      .filter((row) => String(row.transaction_type).toUpperCase() === 'PURCHASE')
      .reduce((sum, row) => sum + Number(row.effective_net_amount || 0), 0),
    total_expense: presented
      .filter((row) => String(row.transaction_type).toUpperCase() === 'EXPENSE')
      .reduce((sum, row) => sum + Number(row.effective_net_amount || 0), 0),
    total_income: presented
      .filter((row) => String(row.transaction_type).toUpperCase() === 'INCOME')
      .reduce((sum, row) => sum + Number(row.effective_net_amount || 0), 0),
    count_sale: presented.filter((row) => String(row.transaction_type).toUpperCase() === 'SALE').length,
    count_purchase: presented.filter((row) => String(row.transaction_type).toUpperCase() === 'PURCHASE').length,
    count_expense: presented.filter((row) => String(row.transaction_type).toUpperCase() === 'EXPENSE').length,
    count_income: presented.filter((row) => String(row.transaction_type).toUpperCase() === 'INCOME').length,
  };

  return {
    transactions,
    total_count: presented.length,
    summary,
    sheet_counts,
    limit,
    offset,
    list_fetch_stats: {
      mode: 'PERIOD',
      fetched_transaction_rows: scopedRows.length,
      presented_total: presented.length,
      presented_page: transactions.length,
    },
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
            r.stay_type,
            r.status as reservation_status,
            r.stay_status as reservation_stay_status,
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

  const expansion = siblingExpansionIds([tx]);
  const siblingRes = await pool.query(
    `SELECT t.*
     FROM transactions t
     WHERE t.property_id = $1
       AND t.deleted_at IS NULL
       AND (
         t.id = ANY($2::bigint[])
         OR t.reversal_of_transaction_id = ANY($2::bigint[])
         OR t.id = ANY($3::bigint[])
         OR t.reversal_of_transaction_id = ANY($3::bigint[])
         OR ($4::text[] <> '{}' AND t.correction_group_id = ANY($4::text[]))
         OR t.metadata->>'restored_from_transaction_id' = ANY($5::text[])
         OR t.metadata->>'reversal_transaction_id' = ANY($5::text[])
       )`,
    [
      propertyId,
      expansion.ids,
      expansion.parentIds.length > 0 ? expansion.parentIds : [0],
      expansion.groupIds,
      [...new Set([...expansion.ids, ...expansion.parentIds])].map(String),
    ]
  );
  const siblingsWithStay = siblingRes.rows.map((row: any) => ({
    ...row,
    reservation_status: row.reservation_status || tx.reservation_status,
    reservation_stay_status: row.reservation_stay_status || tx.reservation_stay_status,
  }));
  const lifecycleGroup = groupSaleLifecycles([tx, ...siblingsWithStay]).find((group) =>
    group.members.some((member) => Number(member.id) === Number(tx.id))
  );
  const lifecycle = lifecycleGroup ? buildLifecycleHistory(lifecycleGroup) : null;

  return {
    ...tx,
    operational_sheet: deriveOperationalSheet(tx),
    effective_net_amount: lifecycleGroup ? lifecycleGroup.effectiveNet : Number(tx.net_amount || 0),
    is_lifecycle_primary: lifecycleGroup
      ? Number(lifecycleGroup.primary.id) === Number(tx.id)
      : true,
    lifecycle_group_key: lifecycleGroup?.key,
    lifecycle_member_count: lifecycleGroup?.members.length || 1,
    lifecycle,
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


// ===========================================================================
// PURCHASE-2A2: Atomic Purchase Lifecycle Service
// ===========================================================================

/** Rows locked by FOR UPDATE; used as input to the lifecycle executor. */
interface LockedPurchaseRow {
  id: number;
  transaction_no: string;
  transaction_type: string;
  transaction_status: string;
  receiving_status: string | null;
  verification_status: string | null;
  purchase_workflow_status: string | null;
  verified_by_user_id: string | null;
  verified_by_name_snapshot: string | null;
  verified_at: string | null;
  received_at: string | null;
}

async function fetchLockedPurchase(
  client: any,
  propertyId: number,
  id: number | string
): Promise<LockedPurchaseRow> {
  const res = await client.query(
    `SELECT id, transaction_no, transaction_type, transaction_status,
            receiving_status, verification_status, purchase_workflow_status,
            verified_by_user_id, verified_by_name_snapshot, verified_at, received_at
     FROM transactions
     WHERE id = $1 AND property_id = $2 FOR UPDATE`,
    [id, propertyId]
  );
  if ((res.rowCount ?? 0) === 0) {
    const err: any = new Error(`Transaksi #${id} tidak ditemukan`);
    err.statusCode = 404;
    throw err;
  }
  const row = res.rows[0];
  if (String(row.transaction_type || '').toUpperCase() !== 'PURCHASE') {
    const err: any = new Error(`Transaksi #${id} bukan tipe PURCHASE`);
    err.statusCode = 400;
    throw err;
  }
  return row;
}

function assertNonTerminal(transactionStatus: string): void {
  const status = String(transactionStatus || '').toUpperCase();
  if (['VOIDED', 'REVERSED', 'CANCELLED'].includes(status)) {
    const err: any = new Error(`Transaksi dengan status ${status} bersifat terminal dan tidak dapat diubah melalui lifecycle.`);
    err.statusCode = 409;
    throw err;
  }
}

function buildAuditPayload(
  txId: number,
  propertyId: number,
  action: PurchaseLifecycleAction,
  previous: LockedPurchaseRow,
  next: {
    receiving_status: string | null;
    verification_status: string | null;
    purchase_workflow_status: string | null;
    verified_by_user_id: string | null;
    verified_by_name_snapshot: string | null;
    verified_at: string | null;
  },
  autoRules: { verified_forced_workflow_complete: boolean; workflow_process_forced_unverify: boolean },
  reason: string | null,
  actor: string | null
): PurchaseLifecycleAuditPayload {
  return {
    transaction_id: Number(txId),
    property_id: Number(propertyId),
    action,
    previous: {
      receiving_status: previous.receiving_status,
      verification_status: previous.verification_status,
      purchase_workflow_status: previous.purchase_workflow_status,
      verified_by_user_id: previous.verified_by_user_id,
      verified_by_name_snapshot: previous.verified_by_name_snapshot,
      verified_at: previous.verified_at,
    },
    next,
    auto_rules: autoRules,
    reason,
    actor,
    timestamp: new Date().toISOString(),
  };
}

/**
 * executePurchaseLifecycle - atomic, row-locked, single DB transaction per action.
 * Drives SET_RECEIVING, SET_VERIFICATION, SET_WORKFLOW with required auto-rules:
 *   - VERIFIED => purchase_workflow_status = SELESAI
 *   - PROSES   => verification_status = UNVERIFIED (verifier fields cleared)
 */
export async function executePurchaseLifecycle(
  pool: Pool,
  id: number | string,
  dto: PurchaseLifecycleDto
): Promise<any> {
  const propertyId = Number(dto.property_id);
  const action = dto.action;
  const reason = dto.reason ? String(dto.reason).trim() : null;
  const actor = String(dto.actor_name || '').trim() || null;
  const actorUserId = dto.actor_user_id || null;

  if (!propertyId || Number.isNaN(propertyId) || propertyId <= 0) {
    const err: any = new Error('property_id wajib diisi dan harus valid');
    err.statusCode = 400;
    throw err;
  }

  if (!action) {
    const err: any = new Error('action wajib diisi');
    err.statusCode = 400;
    throw err;
  }

  const actionUpper = String(action).toUpperCase();
  if (
    actionUpper !== 'SET_RECEIVING' &&
    actionUpper !== 'SET_VERIFICATION' &&
    actionUpper !== 'SET_WORKFLOW'
  ) {
    const err: any = new Error(`Action '${action}' tidak valid untuk PURCHASE lifecycle`);
    err.statusCode = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const prev = await fetchLockedPurchase(client, propertyId, id);
    assertNonTerminal(prev.transaction_status);

    let newReceiving: string | null = prev.receiving_status;
    let newVerification: string | null = prev.verification_status;
    let newWorkflow: string | null = prev.purchase_workflow_status;
    let newVerifiedByUserId: string | null = prev.verified_by_user_id;
    let newVerifiedByName: string | null = prev.verified_by_name_snapshot;
    let newVerifiedAt: string | null = prev.verified_at;
    let newReceivedAt: string | null = prev.received_at;

    const autoRules = {
      verified_forced_workflow_complete: false,
      workflow_process_forced_unverify: false,
    };

    if (actionUpper === 'SET_RECEIVING') {
      const status = dto.receiving_status;
      if (!status || !PURCHASE_RECEIVING_STATUSES.includes(status as ReceivingStatus)) {
        const err: any = new Error(`receiving_status '${status}' tidak valid`);
        err.statusCode = 400;
        throw err;
      }
      newReceiving = status;
      if (status === 'BELUM_DITERIMA') {
        newReceivedAt = null;
      } else {
        newReceivedAt = dto.received_at
          ? new Date(dto.received_at).toISOString()
          : (prev.received_at || new Date().toISOString());
      }
    } else if (actionUpper === 'SET_VERIFICATION') {
      const v = dto.verification_status;
      if (!v || !['UNVERIFIED', 'VERIFIED', 'REJECTED'].includes(v)) {
        const err: any = new Error(`verification_status '${v}' tidak valid`);
        err.statusCode = 400;
        throw err;
      }
      newVerification = v;
      if (v === 'VERIFIED') {
        newVerifiedByUserId = actorUserId;
        newVerifiedByName = actor;
        newVerifiedAt = new Date().toISOString();
        newWorkflow = 'SELESAI';
        autoRules.verified_forced_workflow_complete = true;
      } else if (v === 'UNVERIFIED') {
        newVerifiedByUserId = null;
        newVerifiedByName = null;
        newVerifiedAt = null;
      }
    } else if (actionUpper === 'SET_WORKFLOW') {
      const w = dto.workflow_status;
      if (!w || !['PROSES', 'SELESAI'].includes(w)) {
        const err: any = new Error(`workflow_status '${w}' tidak valid`);
        err.statusCode = 400;
        throw err;
      }
      newWorkflow = w;
      if (w === 'PROSES') {
        newVerification = 'UNVERIFIED';
        newVerifiedByUserId = null;
        newVerifiedByName = null;
        newVerifiedAt = null;
        autoRules.workflow_process_forced_unverify = true;
      }
    }

    await client.query(
      `UPDATE transactions
       SET receiving_status = $1,
           received_at = $2,
           verification_status = $3,
           verified_by_user_id = $4,
           verified_by_name_snapshot = $5,
           verified_at = $6,
           purchase_workflow_status = $7,
           updated_at = NOW()
       WHERE id = $8 AND property_id = $9`,
      [
        newReceiving,
        newReceivedAt,
        newVerification,
        newVerifiedByUserId,
        newVerifiedByName,
        newVerifiedAt,
        newWorkflow,
        id,
        propertyId,
      ]
    );

    const payload = buildAuditPayload(
      Number(id),
      propertyId,
      actionUpper as PurchaseLifecycleAction,
      prev,
      {
        receiving_status: newReceiving,
        verification_status: newVerification,
        purchase_workflow_status: newWorkflow,
        verified_by_user_id: newVerifiedByUserId,
        verified_by_name_snapshot: newVerifiedByName,
        verified_at: newVerifiedAt,
      },
      autoRules,
      reason,
      actor
    );

    await client.query(
      `INSERT INTO audit_logs (
         module, action, entity, record_id, new_value, property_id, timestamp
       ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        'TRANSACTIONS',
        'PURCHASE_LIFECYCLE_UPDATED',
        'transactions',
        String(id),
        JSON.stringify(payload),
        propertyId,
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

// ===========================================================================
// EXPENSE-1C: Expense lifecycle (SET_VERIFICATION / SET_WORKFLOW)
// ===========================================================================

interface LockedExpenseRow {
  id: number;
  transaction_no: string;
  transaction_type: string;
  transaction_status: string;
  verification_status: string | null;
  expense_workflow_status: string | null;
  verified_by_user_id: string | null;
  verified_by_name_snapshot: string | null;
  verified_at: string | null;
  deleted_at: string | null;
}

async function fetchLockedExpense(
  client: any,
  propertyId: number,
  id: number | string
): Promise<LockedExpenseRow> {
  const res = await client.query(
    `SELECT id, transaction_no, transaction_type, transaction_status,
            verification_status, expense_workflow_status,
            verified_by_user_id, verified_by_name_snapshot, verified_at, deleted_at
     FROM transactions
     WHERE id = $1 AND property_id = $2 FOR UPDATE`,
    [id, propertyId]
  );
  if ((res.rowCount ?? 0) === 0) {
    const err: any = new Error(`Transaksi #${id} tidak ditemukan`);
    err.statusCode = 404;
    throw err;
  }
  const row = res.rows[0];
  if (String(row.transaction_type || '').toUpperCase() !== 'EXPENSE') {
    const err: any = new Error(`Transaksi #${id} bukan tipe EXPENSE`);
    err.statusCode = 400;
    throw err;
  }
  return row;
}

function buildExpenseAuditPayload(
  txId: number,
  propertyId: number,
  action: string,
  previous: LockedExpenseRow,
  next: {
    verification_status: string | null;
    expense_workflow_status: string | null;
    verified_by_user_id: string | null;
    verified_by_name_snapshot: string | null;
    verified_at: string | null;
  },
  autoRules: { verified_forced_workflow_complete: boolean; workflow_process_forced_unverify: boolean },
  reason: string | null,
  actor: string | null
): any {
  return {
    transaction_id: Number(txId),
    property_id: Number(propertyId),
    action,
    previous: {
      verification_status: previous.verification_status,
      expense_workflow_status: previous.expense_workflow_status,
      verified_by_user_id: previous.verified_by_user_id,
      verified_by_name_snapshot: previous.verified_by_name_snapshot,
      verified_at: previous.verified_at,
    },
    next,
    auto_rules: autoRules,
    reason,
    actor,
    timestamp: new Date().toISOString(),
  };
}

/**
 * executeExpenseLifecycle - atomic, row-locked mutation for EXPENSE transactions.
 * Actions:
 *   SET_VERIFICATION: UNVERIFIED/VERIFIED/REJECTED
 *     VERIFIED => expense_workflow_status = SELESAI, stamps verifier fields
 *     UNVERIFIED => clears verifier fields
 *     REJECTED => clears verifier fields, workflow stays PROSES
 *   SET_WORKFLOW: PROSES/SELESAI
 *     PROSES => forces verification_status = UNVERIFIED, clears verifier fields
 *     SELESAI => no change to verification_status
 */
export async function executeExpenseLifecycle(
  pool: Pool,
  id: number | string,
  dto: any
): Promise<any> {
  const propertyId = Number(dto.property_id);
  const action = dto.action;
  const reason = dto.reason ? String(dto.reason).trim() : null;
  const actor = String(dto.actor_name || '').trim() || null;
  const actorUserId = dto.actor_user_id || null;

  if (!propertyId || Number.isNaN(propertyId) || propertyId <= 0) {
    const err: any = new Error('property_id wajib diisi dan harus valid');
    err.statusCode = 400;
    throw err;
  }

  if (!action) {
    const err: any = new Error('action wajib diisi');
    err.statusCode = 400;
    throw err;
  }

  const actionUpper = String(action).toUpperCase();
  if (actionUpper !== 'SET_VERIFICATION' && actionUpper !== 'SET_WORKFLOW') {
    const err: any = new Error(`Action '${action}' tidak valid untuk EXPENSE lifecycle`);
    err.statusCode = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const prev = await fetchLockedExpense(client, propertyId, id);
    assertNonTerminal(prev.transaction_status);

    if (prev.deleted_at) {
      const err: any = new Error(`Transaksi #${id} telah dihapus dan tidak dapat diubah.`);
      err.statusCode = 409;
      throw err;
    }

    let newVerification: string | null = prev.verification_status;
    let newVerifiedByUserId: string | null = prev.verified_by_user_id;
    let newVerifiedByName: string | null = prev.verified_by_name_snapshot;
    let newVerifiedAt: string | null = prev.verified_at;
    let newWorkflow: string | null = prev.expense_workflow_status;
    const autoRules = {
      verified_forced_workflow_complete: false,
      workflow_process_forced_unverify: false,
    };

    if (actionUpper === 'SET_VERIFICATION') {
       const v = dto.verification_status;
       if (!v || !['UNVERIFIED', 'VERIFIED', 'REJECTED'].includes(v)) {
         const err: any = new Error(`verification_status '${v}' tidak valid`);
         err.statusCode = 400;
         throw err;
       }
       // Capture canonical row from the shared helper — audit payload must use
       // actual DB state (RETURNING *), not stale local variables.
       const canonicalRow = await applyCanonicalVerificationMutation(
         client,
         id,
         propertyId,
         v as VerificationStatus,
         actorUserId,
         actor,
         reason,
         prev
       );
       // Workflow auto-transition follows canonical expense rules:
       // VERIFIED => SELESAI; UNVERIFIED/REJECTED => PROSES
       newWorkflow = v === 'VERIFIED' ? 'SELESAI' : 'PROSES';
       // Pull audit fields from the canonical RETURNING row so payload.next is authoritative.
       newVerification = canonicalRow.verification_status;
       newVerifiedByUserId = canonicalRow.verified_by_user_id;
       newVerifiedByName = canonicalRow.verified_by_name_snapshot;
       newVerifiedAt = canonicalRow.verified_at;
       autoRules.verified_forced_workflow_complete = v === 'VERIFIED';
     } else if (actionUpper === 'SET_WORKFLOW') {
       const w = dto.workflow_status;
       if (!w || !['PROSES', 'SELESAI'].includes(w)) {
         const err: any = new Error(`workflow_status '${w}' tidak valid`);
         err.statusCode = 400;
         throw err;
       }
       newWorkflow = w;
       if (w === 'PROSES') {
         newVerification = 'UNVERIFIED';
         newVerifiedByUserId = null;
         newVerifiedByName = null;
         newVerifiedAt = null;
         autoRules.workflow_process_forced_unverify = true;
       }
     }

     // Single UPDATE: only touch expense_workflow_status for SET_VERIFICATION,
     // or both verification + workflow for SET_WORKFLOW.  The canonical helper
     // already wrote verification_status / verified_*/ verified_at for
     // SET_VERIFICATION so we do NOT overwrite those fields here.
     if (actionUpper === 'SET_VERIFICATION') {
       await client.query(
         `UPDATE transactions
          SET expense_workflow_status = $1,
              updated_at = NOW()
          WHERE id = $2 AND property_id = $3`,
         [newWorkflow, id, propertyId]
       );
     } else {
       // SET_WORKFLOW: also reset verification_status/verified fields when switching to PROSES
       await client.query(
         `UPDATE transactions
          SET verification_status = $1,
              verified_by_user_id = $2,
              verified_by_name_snapshot = $3,
              verified_at = $4,
              expense_workflow_status = $5,
              updated_at = NOW()
          WHERE id = $6 AND property_id = $7`,
         [newVerification, newVerifiedByUserId, newVerifiedByName, newVerifiedAt, newWorkflow, id, propertyId]
       );
     }

     const payload = buildExpenseAuditPayload(
       Number(id), propertyId, actionUpper,
       prev,
       {
         verification_status: newVerification,
         expense_workflow_status: newWorkflow,
         verified_by_user_id: newVerifiedByUserId,
         verified_by_name_snapshot: newVerifiedByName,
         verified_at: newVerifiedAt,
       },
       autoRules,
       reason,
       actor
     );

    await client.query(
      `INSERT INTO audit_logs (
        module, action, entity, record_id, new_value, property_id, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        'TRANSACTIONS',
        'EXPENSE_LIFECYCLE_UPDATED',
        'transactions',
        String(id),
        JSON.stringify(payload),
        propertyId,
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
