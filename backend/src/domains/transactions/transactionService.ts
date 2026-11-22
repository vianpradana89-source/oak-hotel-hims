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
  UpdatePurchaseTransactionDto,
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
  loadBookingReservationLifecycle,
  type BookingReservationLifecycleRow,
  applyAuditOverlay,
  isPiutangPresentedRow
} from './bookingBidGrouping';
import { presentedListKey, queryPresentedPage } from './transactionListQuery';
import { explicitPosOrderIdFromFolioEntry, shouldSkipFolioKeyedPosSale } from './saleSourceIdentity';
import {
  restoreAllReservationEffectsOnCancelOrVoid,
  restoreMinibarStockAndDeposit,
} from '../reservations/reservationCancellationRestoreService';
import { restoreStockForPosOrderVoid } from '../pos/stockInventoryService';
import { generatePurchaseDescription } from './purchaseSummary';
export { generatePurchaseDescription } from './purchaseSummary';
import {
  resolvePurchaseCategoryBinding,
  resolvePurchaseDepartmentBinding,
} from './purchaseSettingsService';
import { preparePurchaseCreateDto } from './purchaseFieldRulesService';
import { calculateHotelCollectibleBalance } from '../reservations/reservationFinancialCalculator';

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
  approval_status?: string | null;
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
    if (String((row as any).verification_status || '').toUpperCase() === 'VERIFIED') {
      return 'SELESAI';
    }
    return resolvePurchaseWorkflowStatus(row.purchase_workflow_status) === 'SELESAI'
      ? 'SELESAI'
      : 'PROSES';
  }
  // EXPENSE-1B: Expense workflow status & approval status for EXPENSE type.
  if (type === 'EXPENSE') {
    if (String(row.approval_status || '').toUpperCase() === 'REJECTED') {
      return 'BATAL';
    }
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
  'DITERIMA_LENGKAP',
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
  options: { propertyId?: number; actorName?: string; actorUserId?: string; paymentMethod?: string; discountAmount?: number } = {}
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
    await client.query(
      `UPDATE pos_complimentary_usages
       SET status = 'CANCELLED'
       WHERE pos_order_id = $1
         AND property_id = $2
         AND status = 'ACTIVE'`,
      [orderId, propertyId]
    );

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
          -Math.abs(Number(origTx.discount_amount || 0)),
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

  // ── Computation from DB snapshot (pos_order_items + pos_orders) ──────
  // itemDiscount = SUM(discount_amount) dari snapshot item
  // orderDiscount = pos_orders.discount_amount
  // Jika ada item:
  //   gross = SUM(quantity * unit_price) dari snapshot
  //   totalDiscount = itemDiscount + orderDiscount
  //   net = gross - totalDiscount
  // Jika tanpa item & tanpa diskon:
  //   gross = net = pos_orders.total_amount (kompatibilitas fixture)
  // Jika tanpa item tetapi berdiskon:
  //   throw — tidak bisa menebak gross
  // SALE amounts use whole rupiah. Validate raw snapshots before any rounding.
  const snapshotMoney = (value: unknown, field: string): number => {
    const amount = Number(value);
    if (value == null || (typeof value === 'string' && value.trim() === '') ||
        !Number.isSafeInteger(amount) || amount < 0) {
      const err: any = new Error(
        `POS Order #${orderId}: snapshot ${field} harus rupiah bulat non-negatif (${String(value)})`
      );
      err.statusCode = 422;
      err.code = 'POS_ITEM_SNAPSHOT_INVALID';
      throw err;
    }
    return amount;
  };
  const storedTotal = snapshotMoney(order.total_amount, 'total_amount');
  const storedOrderDiscount = snapshotMoney(order.discount_amount ?? 0, 'discount_amount');
  // PHASE B3: baca service_amount & tax_amount dari snapshot pos_orders.
  // Kolom ada sejak PHASE A (DDL pos_service_tax_v1). NULL / missing → 0.
  const storedService = snapshotMoney(order.service_amount ?? 0, 'service_amount');
  const storedTax = snapshotMoney(order.tax_amount ?? 0, 'tax_amount');

  let gross: number;
  let totalDiscount: number;
  let net: number;

  const itemsRes = await client.query(
    `SELECT
       COALESCE(SUM(quantity * unit_price), 0)::numeric AS items_gross,
       COALESCE(SUM(COALESCE(discount_amount, 0)), 0)::numeric AS items_discount,
       COUNT(*)::int AS items_count
     FROM pos_order_items
     WHERE order_id = $1`,
    [orderId]
  );
  const itemsRow = itemsRes.rows[0];
  const itemsCount = Number(itemsRow.items_count ?? 0);
  const itemsGross = snapshotMoney(itemsRow.items_gross, 'items_gross');
  const itemsDiscount = snapshotMoney(itemsRow.items_discount, 'items_discount');

  if (itemsCount > 0) {
    // Order dengan item: hitung dari snapshot
    gross = itemsGross;
    totalDiscount = itemsDiscount + storedOrderDiscount;
    // PHASE B3: net_amount = pos_orders.total_amount (canonical snapshot,
    // sudah memuat service + tax). Tidak dihitung ulang dari gross-discount.
    net = storedTotal;

    // Validasi konsistensi dengan total tersimpan
    if (!Number.isSafeInteger(gross) || gross < 0) {
      const err: any = new Error(
        `POS Order #${orderId}: gross dari item snapshot tidak valid (${gross})`
      );
      err.statusCode = 422;
      err.code = 'POS_ITEM_SNAPSHOT_INVALID';
      throw err;
    }
    if (!Number.isSafeInteger(totalDiscount) || totalDiscount < 0) {
      const err: any = new Error(
        `POS Order #${orderId}: total diskon dari snapshot negatif (${totalDiscount})`
      );
      err.statusCode = 422;
      err.code = 'POS_ITEM_SNAPSHOT_INVALID';
      throw err;
    }
    // PHASE B3 invariant: net = gross - discount + service + tax
    const invariantLhs = gross - totalDiscount + storedService + storedTax;
    if (invariantLhs !== storedTotal) {
      const err: any = new Error(
        `POS Order #${orderId}: invariant POS snapshot rusak ` +
        `(gross=${gross}, discount=${totalDiscount}, svc=${storedService}, tax=${storedTax} ` +
        `=> ${invariantLhs}) != pos_orders.total_amount (${storedTotal})`
      );
      err.statusCode = 422;
      err.code = 'POS_SNAPSHOT_MISMATCH';
      throw err;
    }
    if (!Number.isSafeInteger(net) || net < 0) {
      const err: any = new Error(
        `POS Order #${orderId}: net dari snapshot negatif (${net})`
      );
      err.statusCode = 422;
      err.code = 'POS_ITEM_SNAPSHOT_INVALID';
      throw err;
    }
  } else {
    // Tanpa item: kompatibilitas fixture
    if (storedOrderDiscount !== 0) {
      // Tanpa item tetapi berdiskon — jangan menebak gross
      const err: any = new Error(
        `POS Order #${orderId}: order tanpa item tetapi memiliki diskon ` +
        `order (${storedOrderDiscount}); tidak bisa menentukan gross`
      );
      err.statusCode = 422;
      err.code = 'POS_NO_ITEM_BUT_DISCOUNT';
      throw err;
    }
    // Tanpa item & tanpa diskon: total_amount tersimpan = gross = net
    gross = storedTotal;
    totalDiscount = 0;
    net = gross;
  }

  const paymentMethod = options.paymentMethod || 'CASH';
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
         discount_amount = $2,
         service_amount = $3,
         tax_amount = $4,
         net_amount = $5,
         description = $6,
         payment_status = $7,
         payment_method = $8,
         party_name = COALESCE($9, party_name),
         guest_name_snapshot = COALESCE($9, guest_name_snapshot),
         room_number_snapshot = COALESCE($10, room_number_snapshot),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $11
       RETURNING *`,
      [
        gross,
        totalDiscount,
        storedService,
        storedTax,
        net,
        description,
        'PAID',
        paymentMethod,
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
      $7, $8, $9, $10, $11,
      'PAID', $12, 'POSTED',
      $13, $14, $15,
      $16, $17, null, null, $18,
      $19, $20
    )
    ON CONFLICT (property_id, source_type, source_id)
    WHERE source_id IS NOT NULL AND reversal_of_transaction_id IS NULL
    DO UPDATE SET
      amount = EXCLUDED.amount,
      discount_amount = EXCLUDED.discount_amount,
      service_amount = EXCLUDED.service_amount,
      tax_amount = EXCLUDED.tax_amount,
      net_amount = EXCLUDED.net_amount,
      description = EXCLUDED.description,
      payment_status = EXCLUDED.payment_status,
      payment_method = EXCLUDED.payment_method,
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
      gross,
      totalDiscount,
      storedService,
      storedTax,
      net,
      paymentMethod,
      order.canonical_guest_id || null,
      guestName,
      order.room_number ? String(order.room_number) : null,
      order.reservation_id || null,
      order.booking_id || null,
      JSON.stringify({
        pos_order_id: orderId,
        order_number: order.order_number,
        table_number: order.table_number,
        items_count: itemsCount
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

  if (String(dto.transaction_type || '').toUpperCase() === 'PURCHASE') {
    const err: any = new Error(
      'Pengadaan dan pencatatan tagihan pembelian baru wajib melalui alur Purchase Order (PO) yang sudah disetujui.'
    );
    err.statusCode = 400;
    err.code = 'PO_REQUIRED_FOR_PURCHASE';
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
 * Helper: Detect whether a purchase line input represents a canonical STOCK line.
 */
function isStockPurchaseLineInput(line: { product_id?: number | string | null; line_type?: string | null }): boolean {
  const rawLineType = String(line?.line_type || '').trim().toUpperCase();
  const isNonStockLine = ['NON_STOCK', 'NON_STOCK_EXPENSE', 'NON_STOCK_PHYSICAL', 'SERVICE'].includes(rawLineType);
  if (isNonStockLine) return false;
  if (['STOCK', 'STOCK_PRODUCT'].includes(rawLineType)) return true;
  const prodId = line?.product_id ? Number(line.product_id) : 0;
  return Number.isFinite(prodId) && prodId > 0;
}

/**
 * Helper: Compute canonical receiving status for a purchase transaction that contains STOCK lines,
 * derived strictly from POSTED GRN quantities / stock_purchase_line_bindings.
 */
async function computeCanonicalStockReceivingStatus(
  client: Pool | PoolClient,
  propertyId: number,
  transactionId: number | string,
  prevReceivedAt?: string | null
): Promise<{ hasStockLines: boolean; receivingStatus: ReceivingStatus; receivedAt: string | null }> {
  const res = await client.query(
    `SELECT
       tl.id AS transaction_line_id,
       COALESCE(b.ordered_quantity, tl.quantity, 0)::numeric AS ordered_qty,
       GREATEST(
         COALESCE(b.received_quantity, 0)::numeric,
         COALESCE((
           SELECT SUM(
             CASE
               WHEN tl.packaging_id IS NOT NULL AND gri.packaging_id = tl.packaging_id THEN gri.received_qty
               WHEN tl.packaging_id IS NOT NULL AND COALESCE(
                 NULLIF(b.conversion_factor_snapshot, 0),
                 NULLIF(tl.conversion_factor_snapshot, 0),
                 CASE WHEN poi.packaging_id = tl.packaging_id THEN NULLIF(poi.conversion_factor_snapshot, 0) ELSE NULL END,
                 (SELECT CASE
                           WHEN MIN(NULLIF(gri_s.conversion_factor_snapshot, 0)) = MAX(NULLIF(gri_s.conversion_factor_snapshot, 0))
                           THEN MIN(NULLIF(gri_s.conversion_factor_snapshot, 0))
                           ELSE NULL
                         END
                    FROM pos_goods_receipt_items gri_s
                    JOIN pos_goods_receipts gr_s ON gr_s.id = gri_s.receipt_id
                   WHERE gr_s.property_id = tl.property_id
                     AND UPPER(COALESCE(gr_s.status, '')) IN ('POSTED', 'COMPLETED')
                     AND gri_s.packaging_id = tl.packaging_id
                     AND NULLIF(gri_s.conversion_factor_snapshot, 0) IS NOT NULL
                     AND (
                       gri_s.transaction_line_id = tl.id
                       OR (COALESCE(b.po_item_id, tl.po_item_id) IS NOT NULL AND gri_s.po_item_id = COALESCE(b.po_item_id, tl.po_item_id))
                     )),
                 0
               ) > 0 THEN
                 COALESCE(
                   NULLIF(gri.base_quantity, 0),
                   CASE WHEN gri.packaging_id IS NULL THEN gri.received_qty ELSE gri.received_qty * NULLIF(gri.conversion_factor_snapshot, 0) END,
                   0
                 ) / COALESCE(
                   NULLIF(b.conversion_factor_snapshot, 0),
                   NULLIF(tl.conversion_factor_snapshot, 0),
                   CASE WHEN poi.packaging_id = tl.packaging_id THEN NULLIF(poi.conversion_factor_snapshot, 0) ELSE NULL END,
                   (SELECT CASE
                             WHEN MIN(NULLIF(gri_s.conversion_factor_snapshot, 0)) = MAX(NULLIF(gri_s.conversion_factor_snapshot, 0))
                             THEN MIN(NULLIF(gri_s.conversion_factor_snapshot, 0))
                             ELSE NULL
                           END
                      FROM pos_goods_receipt_items gri_s
                      JOIN pos_goods_receipts gr_s ON gr_s.id = gri_s.receipt_id
                     WHERE gr_s.property_id = tl.property_id
                       AND UPPER(COALESCE(gr_s.status, '')) IN ('POSTED', 'COMPLETED')
                       AND gri_s.packaging_id = tl.packaging_id
                       AND NULLIF(gri_s.conversion_factor_snapshot, 0) IS NOT NULL
                       AND (
                         gri_s.transaction_line_id = tl.id
                         OR (COALESCE(b.po_item_id, tl.po_item_id) IS NOT NULL AND gri_s.po_item_id = COALESCE(b.po_item_id, tl.po_item_id))
                       ))
                 )
               WHEN tl.packaging_id IS NOT NULL THEN 0
               ELSE COALESCE(
                 NULLIF(gri.base_quantity, 0),
                 CASE WHEN gri.packaging_id IS NULL THEN gri.received_qty ELSE gri.received_qty * NULLIF(gri.conversion_factor_snapshot, 0) END,
                 0
               )
             END
           )
             FROM pos_goods_receipt_items gri
             JOIN pos_goods_receipts gr ON gr.id = gri.receipt_id
            WHERE gr.property_id = tl.property_id
              AND UPPER(COALESCE(gr.status, '')) IN ('POSTED', 'COMPLETED')
              AND (
                (gr.transaction_id = tl.transaction_id AND (gri.transaction_line_id = tl.id OR (gri.transaction_line_id IS NULL AND gri.product_id = tl.product_id)))
                OR (COALESCE(b.po_item_id, tl.po_item_id) IS NOT NULL AND gri.po_item_id = COALESCE(b.po_item_id, tl.po_item_id))
              )
         ), 0)::numeric
       ) AS received_qty,
       COALESCE((
         SELECT SUM(
           COALESCE(
             NULLIF(gri.base_quantity, 0),
             CASE WHEN gri.packaging_id IS NULL THEN gri.received_qty ELSE gri.received_qty * NULLIF(gri.conversion_factor_snapshot, 0) END,
             gri.received_qty,
             0
           )
         )
           FROM pos_goods_receipt_items gri
           JOIN pos_goods_receipts gr ON gr.id = gri.receipt_id
          WHERE gr.property_id = tl.property_id
            AND UPPER(COALESCE(gr.status, '')) IN ('POSTED', 'COMPLETED')
            AND (
              (gr.transaction_id = tl.transaction_id AND (gri.transaction_line_id = tl.id OR (gri.transaction_line_id IS NULL AND gri.product_id = tl.product_id)))
              OR (COALESCE(b.po_item_id, tl.po_item_id) IS NOT NULL AND gri.po_item_id = COALESCE(b.po_item_id, tl.po_item_id))
            )
       ), 0)::numeric AS raw_grn_base_qty,
       CASE
         WHEN tl.packaging_id IS NOT NULL AND COALESCE(
           NULLIF(b.conversion_factor_snapshot, 0),
           NULLIF(tl.conversion_factor_snapshot, 0),
           CASE WHEN poi.packaging_id = tl.packaging_id THEN NULLIF(poi.conversion_factor_snapshot, 0) ELSE NULL END,
           (SELECT CASE
                     WHEN MIN(NULLIF(gri_s.conversion_factor_snapshot, 0)) = MAX(NULLIF(gri_s.conversion_factor_snapshot, 0))
                     THEN MIN(NULLIF(gri_s.conversion_factor_snapshot, 0))
                     ELSE NULL
                   END
              FROM pos_goods_receipt_items gri_s
              JOIN pos_goods_receipts gr_s ON gr_s.id = gri_s.receipt_id
             WHERE gr_s.property_id = tl.property_id
               AND UPPER(COALESCE(gr_s.status, '')) IN ('POSTED', 'COMPLETED')
               AND gri_s.packaging_id = tl.packaging_id
               AND NULLIF(gri_s.conversion_factor_snapshot, 0) IS NOT NULL
               AND (
                 gri_s.transaction_line_id = tl.id
                 OR (COALESCE(b.po_item_id, tl.po_item_id) IS NOT NULL AND gri_s.po_item_id = COALESCE(b.po_item_id, tl.po_item_id))
               ))
         ) IS NULL THEN 1
         ELSE 0
       END AS has_unresolved_packaging_factor
     FROM transaction_lines tl
     LEFT JOIN stock_purchase_line_bindings b
       ON b.transaction_id = tl.transaction_id
      AND b.transaction_line_id = tl.id
      AND b.property_id = tl.property_id
     LEFT JOIN pos_purchase_order_items poi
       ON poi.id = COALESCE(b.po_item_id, tl.po_item_id)
      AND poi.property_id = tl.property_id
     WHERE tl.transaction_id = $1
       AND tl.property_id = $2
       AND (
         UPPER(COALESCE(tl.line_type, '')) IN ('STOCK', 'STOCK_PRODUCT')
         OR (tl.product_id IS NOT NULL AND UPPER(COALESCE(tl.line_type, 'STOCK')) NOT IN ('NON_STOCK', 'NON_STOCK_EXPENSE', 'NON_STOCK_PHYSICAL', 'SERVICE'))
       )`,
    [transactionId, propertyId]
  );

  if ((res.rowCount ?? 0) === 0) {
    return {
      hasStockLines: false,
      receivingStatus: 'BELUM_DITERIMA',
      receivedAt: prevReceivedAt || null
    };
  }

  const rows = res.rows;
  const isAllReceived = rows.every(
    (r: any) =>
      !Number(r.has_unresolved_packaging_factor) &&
      parseFloat(r.received_qty) >= parseFloat(r.ordered_qty) - 0.0001 &&
      parseFloat(r.ordered_qty) > 0
  );
  const anyReceived = rows.some(
    (r: any) => parseFloat(r.received_qty || '0') > 0.0001 || parseFloat(r.raw_grn_base_qty || '0') > 0.0001
  );

  if (isAllReceived) {
    return {
      hasStockLines: true,
      receivingStatus: 'DITERIMA_LENGKAP',
      receivedAt: prevReceivedAt ? new Date(prevReceivedAt).toISOString() : new Date().toISOString()
    };
  }
  if (anyReceived) {
    return {
      hasStockLines: true,
      receivingStatus: 'DITERIMA_SEBAGIAN',
      receivedAt: null
    };
  }
  return {
    hasStockLines: true,
    receivingStatus: 'BELUM_DITERIMA',
    receivedAt: null
  };
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

  const poId = dto.po_id !== undefined && dto.po_id !== null && String(dto.po_id).trim() !== ''
    ? Number(dto.po_id)
    : 0;
  if (!Number.isInteger(poId) || poId <= 0) {
    const err: any = new Error(
      'Pencatatan tagihan/pembelian baru wajib terhubung ke Purchase Order (PO) yang sudah disetujui.'
    );
    err.statusCode = 400;
    err.code = 'PO_REQUIRED_FOR_PURCHASE';
    throw err;
  }

  const rawCallerReceivingStatus = (dto as any).receiving_status;
  const rawCallerReceivedAt = (dto as any).received_at;
  const hasStockInputLines = dto.lines.some((l) => isStockPurchaseLineInput(l));
  if (hasStockInputLines) {
    const normalizedCallerStatus = rawCallerReceivingStatus !== undefined && rawCallerReceivingStatus !== null
      ? String(rawCallerReceivingStatus).trim().toUpperCase()
      : '';
    const hasExplicitReceivedAt = rawCallerReceivedAt !== undefined && rawCallerReceivedAt !== null && String(rawCallerReceivedAt).trim() !== '';
    if ((normalizedCallerStatus !== '' && normalizedCallerStatus !== 'BELUM_DITERIMA') || hasExplicitReceivedAt) {
      const err: any = new Error(
        'Status penerimaan untuk pembelian barang stok dikendalikan secara otomatis melalui dokumen Penerimaan Barang (GRN) yang di-Post dan tidak dapat diatur manual.'
      );
      err.statusCode = 400;
      err.code = 'STOCK_RECEIVING_MANAGED_BY_GRN';
      throw err;
    }
  }

  dto = await preparePurchaseCreateDto(pool, dto);

  for (let i = 0; i < dto.lines.length; i++) {
    const line = dto.lines[i];
    const desc = (line.description_snapshot || line.description || '').trim();
    if (!desc) {
      throw new Error('Baris item ke-' + (i + 1) + ': Nama/Deskripsi produk wajib diisi');
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

  const receivingStatus = hasStockInputLines
    ? 'BELUM_DITERIMA'
    : resolvePurchaseReceivingStatus(dto.receiving_status);
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

    // Tahap 1A: Validate and lock the authoritative Purchase Order (PO)
    const poRes = await client.query(
      `SELECT po.*,
              COALESCE(s_can.id, m.canonical_supplier_id) AS resolved_canonical_supplier_id,
              COALESCE(s_can.name, ps.name) AS resolved_supplier_name
         FROM pos_purchase_orders po
         LEFT JOIN suppliers s_can
           ON s_can.id = COALESCE(po.canonical_supplier_id, po.supplier_id)
          AND s_can.property_id = po.property_id
          AND s_can.deleted_at IS NULL
         LEFT JOIN pos_supplier_canonical_mappings m
           ON m.property_id = po.property_id
          AND m.pos_supplier_id = po.supplier_id
          AND m.mapping_status IN ('MAPPED_EXACT', 'MAPPED_MANUAL', 'AUTO_PROMOTED')
         LEFT JOIN pos_suppliers ps
           ON ps.id = po.supplier_id
          AND ps.property_id = po.property_id
        WHERE po.id = $1 AND po.property_id = $2
        FOR UPDATE OF po`,
      [poId, propertyId]
    );
    if ((poRes.rowCount ?? 0) === 0) {
      const err: any = new Error(`Purchase Order #${poId} tidak ditemukan untuk properti #${propertyId}`);
      err.statusCode = 404;
      err.code = 'PO_NOT_FOUND';
      throw err;
    }
    const po = poRes.rows[0];
    const poStatusUpper = String(po.status || '').toUpperCase();
    const poApprovalUpper = String(po.approval_status || '').toUpperCase();
    const isPoApproved =
      ['APPROVED', 'ORDERED', 'PARTIAL', 'PARTIALLY_RECEIVED', 'RECEIVED', 'COMPLETED'].includes(poStatusUpper) &&
      !['CANCELLED', 'REJECTED', 'DRAFT', 'PENDING_APPROVAL'].includes(poStatusUpper) &&
      (poApprovalUpper === 'APPROVED' || (!poApprovalUpper && ['APPROVED', 'ORDERED', 'PARTIAL', 'PARTIALLY_RECEIVED', 'RECEIVED', 'COMPLETED'].includes(poStatusUpper)));

    if (!isPoApproved) {
      const err: any = new Error(
        `Purchase Order ${po.po_number} belum disetujui (status: ${po.status}, approval_status: ${po.approval_status || 'N/A'}). Tagihan pembelian hanya dapat dicatat untuk PO yang sudah disetujui.`
      );
      err.statusCode = 400;
      err.code = 'PO_NOT_APPROVED_FOR_INVOICE';
      throw err;
    }

    const poItemsRes = await client.query(
      `SELECT poi.id, poi.po_id, poi.product_id, poi.packaging_id, poi.ordered_unit, poi.conversion_factor_snapshot,
              COALESCE(NULLIF(poi.conversion_factor_snapshot, 0), ppc.to_base_factor, 1) AS effective_po_factor,
              poi.ordered_qty, poi.received_qty, poi.unit_cost, COALESCE(poi.subtotal, poi.line_total, 0) AS subtotal_cost
         FROM pos_purchase_order_items poi
         LEFT JOIN product_packaging_conversions ppc ON ppc.id = poi.packaging_id
        WHERE poi.po_id = $1 AND poi.property_id = $2
        ORDER BY poi.id ASC
        FOR UPDATE OF poi`,
      [poId, propertyId]
    );
    const poItems = poItemsRes.rows;
    const poItemsById = new Map<number, any>();
    for (const item of poItems) {
      poItemsById.set(Number(item.id), item);
    }

    // Handle or Bind Supplier (defaulting to PO canonical supplier)
    const poCanonicalSupplierId = po.resolved_canonical_supplier_id
      ? Number(po.resolved_canonical_supplier_id)
      : (po.canonical_supplier_id ? Number(po.canonical_supplier_id) : null);
    let supplierId = dto.supplier_id ? Number(dto.supplier_id) : poCanonicalSupplierId;
    let supplierName = dto.supplier_name?.trim() || po.resolved_supplier_name || null;

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

    // Track variances between PO and actual Invoice
    const poVariances: Array<Record<string, any>> = [];
    if (poCanonicalSupplierId && supplierId && Number(supplierId) !== Number(poCanonicalSupplierId)) {
      poVariances.push({
        type: 'SUPPLIER_MISMATCH',
        po_supplier_id: poCanonicalSupplierId,
        invoice_supplier_id: supplierId,
        message: `Supplier tagihan (#${supplierId}) berbeda dari supplier PO (#${poCanonicalSupplierId})`
      });
    }

    const usedPoItemIds = new Set<number>();
    const resolvedLinePoItems: Array<any | null> = [];
    for (let i = 0; i < dto.lines.length; i++) {
      const line = dto.lines[i];
      const explicitPoItemId = line.po_item_id ? Number(line.po_item_id) : 0;
      const prodId = line.product_id ? Number(line.product_id) : null;
      const packId = line.packaging_id ? Number(line.packaging_id) : null;
      let matchedPoItem: any | null = null;

      if (explicitPoItemId > 0) {
        matchedPoItem = poItemsById.get(explicitPoItemId) || null;
        if (!matchedPoItem) {
          const err: any = new Error(
            `Baris item ke-${i + 1}: po_item_id #${explicitPoItemId} tidak ditemukan pada PO ${po.po_number}`
          );
          err.statusCode = 400;
          err.code = 'INVALID_PO_ITEM_ID';
          throw err;
        }
      } else if (prodId) {
        const candidates = poItems.filter((pi: any) => {
          if (usedPoItemIds.has(Number(pi.id))) return false;
          if (Number(pi.product_id) !== prodId) return false;
          const piPack = pi.packaging_id ? Number(pi.packaging_id) : null;
          return piPack === packId;
        });
        if (candidates.length === 1) {
          matchedPoItem = candidates[0];
        } else if (candidates.length === 0) {
          const prodOnlyCandidates = poItems.filter(
            (pi: any) => !usedPoItemIds.has(Number(pi.id)) && Number(pi.product_id) === prodId
          );
          if (prodOnlyCandidates.length === 1) {
            matchedPoItem = prodOnlyCandidates[0];
          }
        }
      }

      if (matchedPoItem) {
        usedPoItemIds.add(Number(matchedPoItem.id));
        const poQty = Number(matchedPoItem.ordered_qty || 0);
        const invQty = Number(line.quantity || 0);
        const poPrice = Math.round(Number(matchedPoItem.unit_cost || 0));
        const invPrice = Math.round(Number(line.unit_price || 0));
        if (Math.abs(invQty - poQty) > 0.0001 || invPrice !== poPrice) {
          poVariances.push({
            type: 'LINE_VARIANCE',
            line_index: i + 1,
            po_item_id: Number(matchedPoItem.id),
            product_id: prodId,
            description: line.description_snapshot || line.description || '',
            po_qty: poQty,
            invoice_qty: invQty,
            po_unit_price: poPrice,
            invoice_unit_price: invPrice,
          });
        }
      } else if (prodId) {
        poVariances.push({
          type: 'UNMATCHED_INVOICE_LINE',
          line_index: i + 1,
          product_id: prodId,
          description: line.description_snapshot || line.description || '',
          invoice_qty: Number(line.quantity || 0),
          invoice_unit_price: Math.round(Number(line.unit_price || 0)),
        });
      }
      resolvedLinePoItems.push(matchedPoItem);
    }

    const hasPoVariance = poVariances.length > 0;
    const poVarianceSummary = {
      has_variance: hasPoVariance,
      po_id: poId,
      po_number: po.po_number,
      checked_at: new Date().toISOString(),
      variances: poVariances,
    };

    const lineDescriptions = dto.lines.map((line) => line.description_snapshot || line.description || '');
    const description = String(dto.description || '').trim()
      || generatePurchaseDescription({
        lineDescriptions,
        supplierName,
      });

    const txDate = dto.transaction_date || getHotelDateToday();
    const txNumber = await generateTransactionNumber(client, propertyId, txDate);
    const receivedAt = hasStockInputLines
      ? null
      : (dto.received_at
          ? new Date(dto.received_at).toISOString()
          : (['DITERIMA', 'DITERIMA_LENGKAP'].includes(receivingStatus) ? new Date().toISOString() : null));

    // PURCHASE-2A1: respect explicit workflow/verification on creation; fall back to safe defaults.
    const purchaseWorkflowStatus = dto.purchase_workflow_status
      ? (['PROSES', 'SELESAI'].includes(dto.purchase_workflow_status) ? dto.purchase_workflow_status : 'PROSES')
      : 'PROSES';
    const verificationStatus = dto.verification_status && ['UNVERIFIED', 'VERIFIED', 'REJECTED'].includes(dto.verification_status)
      ? dto.verification_status
      : 'UNVERIFIED';

    const transactionDiscount = Math.max(0, Math.round(Number(dto.transaction_discount || dto.discount_amount || 0)));
    const roundingAmount = Math.round(Number(dto.rounding_amount || 0));

    // Inherit procurement approval from the approved PO (no second procurement approval required)
    const inheritedApprovedByUserId = po.approved_by_user_id ? String(po.approved_by_user_id) : (dto.actor_user_id || null);
    const inheritedApprovedByName = po.approved_by_name_snapshot || dto.actor_name || `Sesuai PO ${po.po_number}`;
    const inheritedApprovedAt = po.approved_at ? new Date(po.approved_at).toISOString() : new Date().toISOString();

    // 1. Initial Insert for transaction header
    const insertTx = await client.query(
      `INSERT INTO transactions (
        property_id, transaction_no, transaction_date, transaction_time,
        transaction_type, source_type, source_reference, party_name,
        category_code, category_name, department_code, description,
        amount, discount_amount, service_amount, tax_amount, rounding_amount, net_amount,
        payment_status, payment_method, transaction_status,
        supplier_id, receiving_status, received_at, verification_status,
        purchase_workflow_status, approval_status,
        approved_by_user_id, approved_by_name_snapshot, approved_at,
        source_revision, po_id, is_legacy_without_po, has_po_variance, po_variance_summary,
        notes, metadata, created_by,
        purchase_category_id, department_id, department_name_snapshot
      ) VALUES (
        $1, $2, $3, CURRENT_TIMESTAMP,
        'PURCHASE', 'MANUAL_PURCHASE', $4, $5,
        $6, $7, $8, $9,
        0, $10, 0, 0, $11, 0,
        'UNPAID', $12, 'POSTED',
        $13, $14, $15, $16,
        $17, 'APPROVED',
        $18, $19, $20,
        1, $21, FALSE, $22, $23::jsonb,
        $24, $25, $26,
        $27, $28, $29
      ) RETURNING *`,
      [
        propertyId,
        txNumber,
        txDate,
        dto.source_reference?.trim() || po.po_number || null,
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
        inheritedApprovedByUserId,
        inheritedApprovedByName,
        inheritedApprovedAt,
        poId,
        hasPoVariance,
        JSON.stringify(poVarianceSummary),
        dto.notes?.trim() || null,
        JSON.stringify({ workflow: 'PURCHASE_2D_PO', po_id: poId, po_number: po.po_number, actor: dto.actor_name || 'Staff' }),
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
      const matchedPoItem = resolvedLinePoItems[i];
      const poItemId = matchedPoItem ? Number(matchedPoItem.id) : (line.po_item_id ? Number(line.po_item_id) : null);
      const desc = (line.description_snapshot || line.description || '').trim();
      const prodId = line.product_id ? Number(line.product_id) : (matchedPoItem?.product_id ? Number(matchedPoItem.product_id) : null);
      const packId = line.packaging_id !== undefined
        ? (line.packaging_id ? Number(line.packaging_id) : null)
        : (matchedPoItem?.packaging_id ? Number(matchedPoItem.packaging_id) : null);
      const rawLineType = String(line.line_type || '').trim().toUpperCase();
      const isNonStockLine = ['NON_STOCK', 'NON_STOCK_EXPENSE', 'NON_STOCK_PHYSICAL'].includes(rawLineType);
      const isServiceLine = rawLineType === 'SERVICE';
      const lineType = isServiceLine
        ? 'SERVICE'
        : (isNonStockLine ? 'NON_STOCK_PHYSICAL' : (prodId ? 'STOCK' : 'NON_STOCK_PHYSICAL'));
      const unitStr = String(line.unit || matchedPoItem?.ordered_unit || '').trim();
      const qtyNum = Number(line.quantity);
      const poPackId = matchedPoItem?.packaging_id ? Number(matchedPoItem.packaging_id) : null;
      const poFactor = Number(matchedPoItem?.effective_po_factor || matchedPoItem?.conversion_factor_snapshot || 1) > 0
        ? Number(matchedPoItem?.effective_po_factor || matchedPoItem?.conversion_factor_snapshot || 1)
        : 1;

      let lineFactorSnapshot = 1;
      let linePkgLabelSnapshot: string | null = unitStr || null;
      if (packId) {
        if (poPackId === packId && poFactor > 0) {
          lineFactorSnapshot = poFactor;
          linePkgLabelSnapshot = String(matchedPoItem?.packaging_label_snapshot || unitStr || '').trim() || null;
        } else {
          const pkgFactorRes = await client.query(
            `SELECT to_base_factor, packaging_label FROM product_packaging_conversions WHERE id = $1 AND property_id = $2`,
            [packId, propertyId]
          );
          if ((pkgFactorRes.rowCount ?? 0) > 0) {
            const fetchedFactor = Number(pkgFactorRes.rows[0].to_base_factor || 1);
            lineFactorSnapshot = fetchedFactor > 0 ? fetchedFactor : 1;
            linePkgLabelSnapshot = String(pkgFactorRes.rows[0].packaging_label || unitStr || '').trim() || null;
          }
        }
        const clientLineSnapRaw = (line as any).conversion_factor_snapshot;
        if (clientLineSnapRaw !== undefined && clientLineSnapRaw !== null && String(clientLineSnapRaw).trim() !== '') {
          const clientLineSnapVal = Number(clientLineSnapRaw);
          if (isNaN(clientLineSnapVal) || clientLineSnapVal <= 0 || Math.abs(clientLineSnapVal - lineFactorSnapshot) > 1e-6) {
            const err: any = new Error(
              `conversion_factor_snapshot (${clientLineSnapRaw}) pada baris ke-${i + 1} tidak sesuai dengan faktor konversi otoritatif server (${lineFactorSnapshot})`
            );
            err.statusCode = 400;
            err.code = 'INVALID_CONVERSION_FACTOR_SNAPSHOT';
            throw err;
          }
        }
      }

      let alreadyReceivedOnPoItem = 0;
      if (matchedPoItem) {
        const poRecRaw = Math.max(0, Number(matchedPoItem.received_qty || 0));
        if (poRecRaw > 0) {
          if ((packId || null) === poPackId && Math.abs(lineFactorSnapshot - poFactor) <= 1e-6) {
            alreadyReceivedOnPoItem = Math.min(qtyNum, poRecRaw);
          } else {
            const poRecBase = poRecRaw * (poPackId ? poFactor : 1);
            const poRecInLineUnit = lineFactorSnapshot > 0 ? Number((poRecBase / lineFactorSnapshot).toFixed(4)) : poRecBase;
            alreadyReceivedOnPoItem = Math.min(qtyNum, Math.max(0, poRecInLineUnit));
          }
        }
      }

      const insLineRes = await client.query(
        `INSERT INTO transaction_lines (
          property_id, transaction_id, product_id, packaging_id, po_item_id, line_type, description_snapshot,
          quantity, unit, unit_price, discount_amount, line_total, sort_order,
          packaging_label_snapshot, conversion_factor_snapshot, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11,
          GREATEST(0, ROUND($8::numeric * $10::bigint)::bigint - $11::bigint),
          $12, $13, $14, NOW()
        ) RETURNING id`,
        [
          propertyId,
          txId,
          prodId,
          packId,
          poItemId,
          lineType,
          desc,
          qtyNum,
          unitStr,
          Math.round(Number(line.unit_price)),
          Math.max(0, Math.round(Number(line.discount_amount || 0))),
          i + 1,
          linePkgLabelSnapshot,
          lineFactorSnapshot
        ]
      );

      const createdLineId = insLineRes.rows[0]?.id ? Number(insLineRes.rows[0].id) : null;
      if (createdLineId && prodId && lineType === 'STOCK') {
        const bindingLineType = 'STOCK';
        await client.query(
          `INSERT INTO stock_purchase_line_bindings (
            property_id, transaction_id, transaction_line_id, po_item_id, line_type,
            product_id, packaging_id, ordered_quantity, received_quantity, base_unit_code,
            packaging_label_snapshot, conversion_factor_snapshot, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
          ON CONFLICT (property_id, transaction_id, transaction_line_id) DO UPDATE SET
            po_item_id = COALESCE(EXCLUDED.po_item_id, stock_purchase_line_bindings.po_item_id),
            product_id = EXCLUDED.product_id,
            packaging_id = EXCLUDED.packaging_id,
            line_type = EXCLUDED.line_type,
            ordered_quantity = EXCLUDED.ordered_quantity,
            received_quantity = GREATEST(stock_purchase_line_bindings.received_quantity, EXCLUDED.received_quantity),
            base_unit_code = EXCLUDED.base_unit_code,
            packaging_label_snapshot = COALESCE(stock_purchase_line_bindings.packaging_label_snapshot, EXCLUDED.packaging_label_snapshot),
            conversion_factor_snapshot = COALESCE(NULLIF(stock_purchase_line_bindings.conversion_factor_snapshot, 0), EXCLUDED.conversion_factor_snapshot),
            updated_at = NOW()`,
          [
            propertyId,
            txId,
            createdLineId,
            poItemId,
            bindingLineType,
            prodId,
            packId,
            qtyNum,
            alreadyReceivedOnPoItem,
            unitStr || 'PCS',
            linePkgLabelSnapshot,
            lineFactorSnapshot
          ]
        );

        // If any GRN items were previously posted directly against this po_item_id without a transaction_line_id, link them
        if (poItemId) {
          await client.query(
            `UPDATE pos_goods_receipt_items gri
                SET transaction_line_id = $1
               FROM pos_goods_receipts gr
              WHERE gri.receipt_id = gr.id
                AND gr.property_id = $2
                AND gri.po_item_id = $3
                AND gri.transaction_line_id IS NULL
                AND gr.status IN ('POSTED', 'COMPLETED')`,
            [createdLineId, propertyId, poItemId]
          );
        }
      }
    }

    // Also link any existing posted PO GRN headers that had transaction_id IS NULL to this purchase transaction if no other purchase tx claimed them
    await client.query(
      `UPDATE pos_goods_receipts
          SET transaction_id = $1,
              updated_at = NOW()
        WHERE property_id = $2
          AND po_id = $3
          AND transaction_id IS NULL
          AND status IN ('POSTED', 'COMPLETED')`,
      [txId, propertyId, poId]
    );

    // Recompute canonical receiving status on the new Purchase Transaction in case the PO was already received before invoice recording
    if (hasStockInputLines) {
      const canonicalAfterBind = await computeCanonicalStockReceivingStatus(client, propertyId, txId, null);
      if (canonicalAfterBind.hasStockLines && canonicalAfterBind.receivingStatus !== 'BELUM_DITERIMA') {
        await client.query(
          `UPDATE transactions
              SET receiving_status = $1,
                  received_at = $2
            WHERE id = $3 AND property_id = $4`,
          [canonicalAfterBind.receivingStatus, canonicalAfterBind.receivedAt, txId, propertyId]
        );
      }
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
 * Update an existing Purchase transaction (PROSES only).
 * Maintains transaction and line identities.
 * Enforces ceiling check: cannot delete lines that already have received goods,
 * and cannot reduce line quantity below already received quantity.
 */
export async function updatePurchaseTransaction(
  pool: Pool,
  id: number | string,
  dto: UpdatePurchaseTransactionDto
): Promise<TransactionRow> {
  const propertyId = Number(dto.property_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    const err: any = new Error('property_id wajib diisi dan harus valid');
    err.statusCode = 400;
    throw err;
  }

  if (dto.lines !== undefined) {
    if (!Array.isArray(dto.lines) || dto.lines.length === 0) {
      const err: any = new Error('Minimal harus ada 1 item produk pesanan pada pembelian');
      err.statusCode = 400;
      throw err;
    }

    for (let i = 0; i < dto.lines.length; i++) {
      const line = dto.lines[i];
      const hasId = line.id !== undefined && line.id !== null && String(line.id).trim() !== '';
      const desc = (line.description_snapshot || line.description || '').trim();
      if (!hasId && !desc) {
        throw new Error('Baris item ke-' + (i + 1) + ': Nama/Deskripsi produk wajib diisi');
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
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Row-lock transaction header
    const prevRes = await client.query(
      `SELECT * FROM transactions WHERE id = $1 AND property_id = $2 FOR UPDATE`,
      [id, propertyId]
    );

    if ((prevRes.rowCount ?? 0) === 0) {
      const err: any = new Error(`Transaksi #${id} tidak ditemukan`);
      err.statusCode = 404;
      throw err;
    }

    const prev = prevRes.rows[0];

    if (String(prev.transaction_type || '').toUpperCase() !== 'PURCHASE') {
      const err: any = new Error(`Transaksi #${id} bukan tipe PURCHASE`);
      err.statusCode = 400;
      throw err;
    }

    const currentTxStatus = String(prev.transaction_status || '').toUpperCase();
    if (['VOIDED', 'REVERSED', 'CANCELLED', 'COMPLETED'].includes(currentTxStatus)) {
      const err: any = new Error(`Transaksi dengan status ${currentTxStatus} bersifat terminal dan tidak dapat diubah.`);
      err.statusCode = 409;
      err.code = 'TRANSACTION_NOT_EDITABLE';
      throw err;
    }
    assertNonTerminal(prev.transaction_status);

    if (prev.deleted_at) {
      const err: any = new Error(`Transaksi #${id} telah dihapus dan tidak dapat diubah.`);
      err.statusCode = 409;
      throw err;
    }

    // PROSES-only enforcement
    const workflowStatus = String(prev.purchase_workflow_status || 'PROSES').toUpperCase();
    if (workflowStatus === 'SELESAI') {
      const err: any = new Error('Transaksi pembelian ini sudah SELESAI. Ubah workflow kembali ke PROSES terlebih dahulu.');
      err.statusCode = 409;
      throw err;
    }

    // 2. Fetch existing transaction lines FOR UPDATE
    const existingLinesRes = await client.query(
      `SELECT * FROM transaction_lines WHERE transaction_id = $1 AND property_id = $2 FOR UPDATE`,
      [id, propertyId]
    );
    const existingLines = existingLinesRes.rows;
    const existingLinesMap = new Map<number, any>();
    for (const el of existingLines) {
      existingLinesMap.set(Number(el.id), el);
    }

    // 3. Fetch any existing receipts (stock_purchase_line_bindings or pos_goods_receipt_items)
    const bindingsRes = await client.query(
      `SELECT transaction_line_id, received_quantity, packaging_id, conversion_factor_snapshot, packaging_label_snapshot
         FROM stock_purchase_line_bindings
        WHERE transaction_id = $1 AND property_id = $2`,
      [id, propertyId]
    );
    const grnItemsRes = await client.query(
      `SELECT gri.transaction_line_id,
              COALESCE(
                SUM(
                  CASE
                    WHEN tl.packaging_id IS NOT NULL AND gri.packaging_id = tl.packaging_id THEN gri.received_qty
                    WHEN tl.packaging_id IS NOT NULL AND COALESCE(
                      NULLIF(b_tl.conversion_factor_snapshot, 0),
                      NULLIF(tl.conversion_factor_snapshot, 0),
                      CASE WHEN poi_tl.packaging_id = tl.packaging_id THEN NULLIF(poi_tl.conversion_factor_snapshot, 0) ELSE NULL END,
                      (SELECT CASE WHEN MIN(NULLIF(gri_s.conversion_factor_snapshot, 0)) = MAX(NULLIF(gri_s.conversion_factor_snapshot, 0)) THEN MIN(NULLIF(gri_s.conversion_factor_snapshot, 0)) ELSE NULL END
                         FROM pos_goods_receipt_items gri_s
                         JOIN pos_goods_receipts gr_s ON gr_s.id = gri_s.receipt_id
                        WHERE gr_s.property_id = gr.property_id
                          AND gr_s.status IN ('POSTED', 'COMPLETED')
                          AND gri_s.packaging_id = tl.packaging_id
                          AND NULLIF(gri_s.conversion_factor_snapshot, 0) IS NOT NULL
                          AND (
                            gri_s.transaction_line_id = tl.id
                            OR (COALESCE(b_tl.po_item_id, tl.po_item_id) IS NOT NULL AND gri_s.po_item_id = COALESCE(b_tl.po_item_id, tl.po_item_id))
                          )),
                      0
                    ) > 0 THEN
                      COALESCE(
                        NULLIF(gri.base_quantity, 0),
                        CASE WHEN gri.packaging_id IS NULL THEN gri.received_qty ELSE gri.received_qty * NULLIF(gri.conversion_factor_snapshot, 0) END,
                        0
                      ) / COALESCE(
                        NULLIF(b_tl.conversion_factor_snapshot, 0),
                        NULLIF(tl.conversion_factor_snapshot, 0),
                        CASE WHEN poi_tl.packaging_id = tl.packaging_id THEN NULLIF(poi_tl.conversion_factor_snapshot, 0) ELSE NULL END,
                        (SELECT CASE WHEN MIN(NULLIF(gri_s.conversion_factor_snapshot, 0)) = MAX(NULLIF(gri_s.conversion_factor_snapshot, 0)) THEN MIN(NULLIF(gri_s.conversion_factor_snapshot, 0)) ELSE NULL END
                           FROM pos_goods_receipt_items gri_s
                           JOIN pos_goods_receipts gr_s ON gr_s.id = gri_s.receipt_id
                          WHERE gr_s.property_id = gr.property_id
                            AND gr_s.status IN ('POSTED', 'COMPLETED')
                            AND gri_s.packaging_id = tl.packaging_id
                            AND NULLIF(gri_s.conversion_factor_snapshot, 0) IS NOT NULL
                            AND (
                              gri_s.transaction_line_id = tl.id
                              OR (COALESCE(b_tl.po_item_id, tl.po_item_id) IS NOT NULL AND gri_s.po_item_id = COALESCE(b_tl.po_item_id, tl.po_item_id))
                            ))
                      )
                    WHEN tl.packaging_id IS NOT NULL THEN 0
                    ELSE COALESCE(
                      NULLIF(gri.base_quantity, 0),
                      CASE WHEN gri.packaging_id IS NULL THEN gri.received_qty ELSE gri.received_qty * NULLIF(gri.conversion_factor_snapshot, 0) END,
                      0
                    )
                  END
                ),
                0
              ) AS grn_received
       FROM pos_goods_receipt_items gri
       JOIN pos_goods_receipts gr ON gr.id = gri.receipt_id
       LEFT JOIN transaction_lines tl ON tl.id = gri.transaction_line_id AND tl.transaction_id = gr.transaction_id
       LEFT JOIN stock_purchase_line_bindings b_tl ON b_tl.transaction_id = gr.transaction_id AND b_tl.transaction_line_id = tl.id AND b_tl.property_id = gr.property_id
       LEFT JOIN pos_purchase_order_items poi_tl ON poi_tl.id = COALESCE(b_tl.po_item_id, tl.po_item_id) AND poi_tl.property_id = gr.property_id
       WHERE gr.transaction_id = $1 AND gr.property_id = $2 AND gr.status IN ('POSTED', 'COMPLETED')
       GROUP BY gri.transaction_line_id`,
      [id, propertyId]
    );

    const receivedMap = new Map<number, number>();
    const existingBindingByLineId = new Map<number, any>();
    for (const b of bindingsRes.rows) {
      const lid = Number(b.transaction_line_id);
      const rQty = Number(b.received_quantity || 0);
      receivedMap.set(lid, Math.max(receivedMap.get(lid) || 0, rQty));
      existingBindingByLineId.set(lid, b);
    }
    for (const g of grnItemsRes.rows) {
      const lid = Number(g.transaction_line_id);
      const rQty = Number(g.grn_received || 0);
      receivedMap.set(lid, Math.max(receivedMap.get(lid) || 0, rQty));
    }

    // 4. Update / Insert / Delete lines if dto.lines provided
    let materialChanged = false;
    const existingBindingLines = new Set<number>(
      bindingsRes.rows.map((b: any) => Number(b.transaction_line_id))
    );

    if (dto.lines) {
      const incomingLineIds = new Set<number>();

      for (const line of dto.lines) {
        if (line.id !== undefined && line.id !== null && String(line.id).trim() !== '') {
          const lid = Number(line.id);
          if (isNaN(lid) || lid <= 0 || !existingLinesMap.has(lid)) {
            const err: any = new Error(
              `Baris item #${line.id} tidak ditemukan pada transaksi pembelian #${id}.`
            );
            err.statusCode = 400;
            err.code = 'INVALID_TRANSACTION_LINE_ID';
            throw err;
          }
          if (incomingLineIds.has(lid)) {
            const err: any = new Error(
              `Terdapat duplikasi ID baris item #${lid} pada permintaan perubahan pembelian.`
            );
            err.statusCode = 400;
            err.code = 'DUPLICATE_TRANSACTION_LINE_ID';
            throw err;
          }
          incomingLineIds.add(lid);
        }
      }

      // Check for removed lines: if an existing line is not in incomingLineIds, ensure received_quantity == 0
      for (const [existingLid, el] of existingLinesMap.entries()) {
        if (!incomingLineIds.has(existingLid)) {
          const rQty = receivedMap.get(existingLid) || 0;
          if (rQty > 0) {
            const desc = el.description_snapshot || `Line #${existingLid}`;
            const err: any = new Error(
              `Dilarang menghapus baris "${desc}" karena sudah diterima sebagian/penuh (${rQty} unit).`
            );
            err.statusCode = 409;
            err.code = 'CANNOT_DELETE_RECEIVED_LINE';
            throw err;
          }
          materialChanged = true;
        }
      }

      // Now process each line in dto.lines
      let sortOrder = 1;
      for (const line of dto.lines) {
        const qty = Number(line.quantity);
        const price = Math.round(Number(line.unit_price));
        const disc = Math.max(0, Math.round(Number(line.discount_amount || 0)));

        let existingId: number | null = null;
        if (line.id !== undefined && line.id !== null && String(line.id).trim() !== '') {
          const parsed = Number(line.id);
          if (!isNaN(parsed) && existingLinesMap.has(parsed)) {
            existingId = parsed;
          }
        }

        if (existingId !== null) {
          const existingLine = existingLinesMap.get(existingId);
          const existingBinding = existingBindingByLineId.get(existingId);
          const rQty = receivedMap.get(existingId) || 0;

          const prevProdId = existingLine.product_id !== undefined && existingLine.product_id !== null
            ? Number(existingLine.product_id)
            : null;
          const prevPackId = existingLine.packaging_id !== undefined && existingLine.packaging_id !== null
            ? Number(existingLine.packaging_id)
            : null;
          const prevUnit = String(existingLine.unit || '').trim();
          const prevDesc = String(existingLine.description_snapshot || '').trim();

          // Preserve existing product_id / packaging_id / unit if omitted (undefined) in payload
          const prodId = line.product_id !== undefined
            ? (line.product_id ? Number(line.product_id) : null)
            : prevProdId;
          const packId = line.packaging_id !== undefined
            ? (line.packaging_id ? Number(line.packaging_id) : null)
            : prevPackId;
          const unit = line.unit !== undefined && String(line.unit).trim() !== ''
            ? String(line.unit).trim()
            : prevUnit;
          const desc = (line.description_snapshot || line.description || prevDesc || '').trim();
          const rawLineType = line.line_type !== undefined && line.line_type !== null
            ? String(line.line_type).trim().toUpperCase()
            : (existingLine.line_type ? String(existingLine.line_type).trim().toUpperCase() : (prodId ? 'STOCK' : 'NON_STOCK_PHYSICAL'));
          const isNonStockLine = ['NON_STOCK', 'NON_STOCK_EXPENSE', 'NON_STOCK_PHYSICAL'].includes(rawLineType);
          const lineType = rawLineType === 'SERVICE'
            ? 'SERVICE'
            : (isNonStockLine ? 'NON_STOCK_PHYSICAL' : (prodId ? 'STOCK' : 'NON_STOCK_PHYSICAL'));

          // When line already has received quantity > 0, forbid changing product, packaging, or unit
          if (rQty > 0) {
            if (prodId !== prevProdId) {
              const err: any = new Error(
                `Dilarang mengubah produk pada baris "${desc}" karena sudah diterima sebagian/penuh (${rQty} unit).`
              );
              err.statusCode = 409;
              err.code = 'CANNOT_CHANGE_RECEIVED_LINE_PRODUCT';
              throw err;
            }
            if (line.packaging_id !== undefined && packId !== prevPackId) {
              const err: any = new Error(
                `Dilarang mengubah kemasan pada baris "${desc}" karena sudah diterima sebagian/penuh (${rQty} unit).`
              );
              err.statusCode = 409;
              err.code = 'CANNOT_CHANGE_RECEIVED_LINE_PACKAGING';
              throw err;
            }
            if (prevUnit && unit && prevUnit.toUpperCase() !== unit.toUpperCase()) {
              const err: any = new Error(
                `Dilarang mengubah satuan (${prevUnit} -> ${unit}) pada baris "${desc}" karena sudah diterima sebagian/penuh (${rQty} unit).`
              );
              err.statusCode = 409;
              err.code = 'CANNOT_CHANGE_RECEIVED_LINE_UNIT';
              throw err;
            }
          }

          // Verify quantity not below received
          if (qty < rQty) {
            const err: any = new Error(
              `Jumlah pembelian untuk "${desc}" tidak boleh lebih kecil dari jumlah yang sudah diterima (${rQty} unit).`
            );
            err.statusCode = 409;
            err.code = 'CANNOT_REDUCE_BELOW_RECEIVED_QTY';
            throw err;
          }

          if (
            prodId !== prevProdId ||
            packId !== prevPackId ||
            prevUnit.toUpperCase() !== unit.toUpperCase() ||
            Math.abs(qty - Number(existingLine.quantity || 0)) > 0.0001 ||
            price !== Math.round(Number(existingLine.unit_price || 0)) ||
            disc !== Math.round(Number(existingLine.discount_amount || 0))
          ) {
            materialChanged = true;
          }

          // Preserve existing conversion_factor_snapshot if packaging_id did not change
          const prevLineSnap = Number(
            existingBinding?.conversion_factor_snapshot ||
            existingLine.conversion_factor_snapshot ||
            0
          );
          let lineFactorSnapshot: number | null = 1;
          let linePkgLabelSnapshot: string | null = unit || null;
          if (packId === null) {
            lineFactorSnapshot = 1;
            linePkgLabelSnapshot = unit || null;
          } else if (packId === prevPackId && prevLineSnap > 0) {
            lineFactorSnapshot = prevLineSnap;
            linePkgLabelSnapshot =
              existingBinding?.packaging_label_snapshot ||
              existingLine.packaging_label_snapshot ||
              unit ||
              null;
          } else if (packId === prevPackId) {
            lineFactorSnapshot = null;
            linePkgLabelSnapshot =
              existingBinding?.packaging_label_snapshot ||
              existingLine.packaging_label_snapshot ||
              null;
          } else {
            const pkgFactorRes = await client.query(
              `SELECT to_base_factor, packaging_label FROM product_packaging_conversions WHERE id = $1 AND property_id = $2`,
              [packId, propertyId]
            );
            if ((pkgFactorRes.rowCount ?? 0) > 0) {
              const fetched = Number(pkgFactorRes.rows[0].to_base_factor || 1);
              lineFactorSnapshot = fetched > 0 ? fetched : 1;
              linePkgLabelSnapshot = String(pkgFactorRes.rows[0].packaging_label || unit || '').trim() || null;
            }
          }
          if (
            (line as any).conversion_factor_snapshot !== undefined &&
            (line as any).conversion_factor_snapshot !== null &&
            String((line as any).conversion_factor_snapshot).trim() !== ''
          ) {
            const reqSnap = Number((line as any).conversion_factor_snapshot);
            if (
              !Number.isFinite(reqSnap) ||
              reqSnap <= 0 ||
              lineFactorSnapshot === null ||
              Math.abs(reqSnap - lineFactorSnapshot) > 1e-6
            ) {
              const err: any = new Error(
                `Faktor konversi kemasan (${(line as any).conversion_factor_snapshot}) pada item "${desc}" tidak sesuai dengan faktor konversi otoritatif sistem (${lineFactorSnapshot}).`
              );
              err.statusCode = 400;
              err.code = 'INVALID_CONVERSION_FACTOR_SNAPSHOT';
              throw err;
            }
          }

          // Update existing line maintaining stable identity and snapshot
          await client.query(
            `UPDATE transaction_lines
             SET product_id = $1,
                 description_snapshot = $2,
                 quantity = $3,
                 unit = $4,
                 unit_price = $5,
                 discount_amount = $6,
                 line_total = GREATEST(0, ROUND($3::numeric * $5::bigint)::bigint - $6::bigint),
                 sort_order = $7,
                 packaging_id = $10,
                 line_type = $11,
                 packaging_label_snapshot = COALESCE($12, packaging_label_snapshot),
                 conversion_factor_snapshot = $13
             WHERE id = $8 AND property_id = $9`,
            [
              prodId,
              desc,
              qty,
              unit,
              price,
              disc,
              sortOrder++,
              existingId,
              propertyId,
              packId,
              lineType,
              linePkgLabelSnapshot,
              lineFactorSnapshot
            ]
          );

          // Synchronize stock_purchase_line_bindings
          if ((prodId === null || lineType !== 'STOCK') && rQty === 0) {
            await client.query(
              `DELETE FROM stock_purchase_line_bindings WHERE transaction_id = $1 AND transaction_line_id = $2 AND property_id = $3`,
              [id, existingId, propertyId]
            );
          } else {
            const bindingLineType = lineType === 'SERVICE' ? 'SERVICE' : (lineType === 'STOCK' && prodId ? 'STOCK' : 'NON_STOCK_PHYSICAL');
            await client.query(
              `UPDATE stock_purchase_line_bindings
               SET ordered_quantity = $1,
                   received_quantity = GREATEST(received_quantity, $9),
                   product_id = COALESCE($5, product_id),
                   packaging_id = $6,
                   line_type = $7,
                   base_unit_code = COALESCE(NULLIF($8, ''), base_unit_code),
                   packaging_label_snapshot = COALESCE($10, packaging_label_snapshot),
                   conversion_factor_snapshot = $11,
                   updated_at = NOW()
               WHERE transaction_id = $2 AND transaction_line_id = $3 AND property_id = $4`,
              [
                qty,
                id,
                existingId,
                propertyId,
                prodId,
                packId,
                bindingLineType,
                unit,
                rQty,
                linePkgLabelSnapshot,
                lineFactorSnapshot
              ]
            );
            if (prodId !== null && lineType === 'STOCK' && !existingBindingLines.has(existingId)) {
              await client.query(
                `INSERT INTO stock_purchase_line_bindings (
                   property_id, transaction_id, transaction_line_id, line_type,
                   product_id, packaging_id, ordered_quantity, received_quantity, base_unit_code,
                   packaging_label_snapshot, conversion_factor_snapshot, created_at, updated_at
                 ) VALUES (
                   $1, $2, $3, $4,
                   $5, $6, $7, $8, $9,
                   $10, $11, NOW(), NOW()
                 ) ON CONFLICT (property_id, transaction_id, transaction_line_id)
                 DO UPDATE SET
                   ordered_quantity = EXCLUDED.ordered_quantity,
                   received_quantity = GREATEST(stock_purchase_line_bindings.received_quantity, EXCLUDED.received_quantity),
                   packaging_label_snapshot = COALESCE(stock_purchase_line_bindings.packaging_label_snapshot, EXCLUDED.packaging_label_snapshot),
                   conversion_factor_snapshot = COALESCE(NULLIF(stock_purchase_line_bindings.conversion_factor_snapshot, 0), EXCLUDED.conversion_factor_snapshot),
                   updated_at = NOW()`,
                [
                  propertyId,
                  id,
                  existingId,
                  bindingLineType,
                  prodId,
                  packId,
                  qty,
                  rQty,
                  unit || 'PCS',
                  linePkgLabelSnapshot,
                  lineFactorSnapshot
                ]
              );
            }
          }
        } else {
          materialChanged = true;
          const desc = (line.description_snapshot || line.description || '').trim();
          const unit = String(line.unit || '').trim();
          const prodId = line.product_id ? Number(line.product_id) : null;
          const packId = line.packaging_id ? Number(line.packaging_id) : null;
          const rawLineType = line.line_type !== undefined && line.line_type !== null
            ? String(line.line_type).trim().toUpperCase()
            : (prodId ? 'STOCK' : 'NON_STOCK_PHYSICAL');
          const isNonStockLine = ['NON_STOCK', 'NON_STOCK_EXPENSE', 'NON_STOCK_PHYSICAL'].includes(rawLineType);
          const lineType = rawLineType === 'SERVICE'
            ? 'SERVICE'
            : (isNonStockLine ? 'NON_STOCK_PHYSICAL' : (prodId ? 'STOCK' : 'NON_STOCK_PHYSICAL'));
          const bindingLineType = lineType === 'SERVICE' ? 'SERVICE' : (lineType === 'STOCK' && prodId ? 'STOCK' : 'NON_STOCK_PHYSICAL');

          let lineFactorSnapshot = 1;
          let linePkgLabelSnapshot: string | null = unit || null;
          if (packId) {
            const pkgFactorRes = await client.query(
              `SELECT to_base_factor, packaging_label FROM product_packaging_conversions WHERE id = $1 AND property_id = $2`,
              [packId, propertyId]
            );
            if ((pkgFactorRes.rowCount ?? 0) > 0) {
              const fetched = Number(pkgFactorRes.rows[0].to_base_factor || 1);
              lineFactorSnapshot = fetched > 0 ? fetched : 1;
              linePkgLabelSnapshot = String(pkgFactorRes.rows[0].packaging_label || unit || '').trim() || null;
            }
          }
          if (
            (line as any).conversion_factor_snapshot !== undefined &&
            (line as any).conversion_factor_snapshot !== null &&
            String((line as any).conversion_factor_snapshot).trim() !== ''
          ) {
            const reqSnap = Number((line as any).conversion_factor_snapshot);
            if (!Number.isFinite(reqSnap) || reqSnap <= 0 || Math.abs(reqSnap - lineFactorSnapshot) > 1e-6) {
              const err: any = new Error(
                `Faktor konversi kemasan (${(line as any).conversion_factor_snapshot}) pada item "${desc}" tidak sesuai dengan faktor konversi otoritatif sistem (${lineFactorSnapshot}).`
              );
              err.statusCode = 400;
              err.code = 'INVALID_CONVERSION_FACTOR_SNAPSHOT';
              throw err;
            }
          }

          // Insert new line
          const insLine = await client.query(
            `INSERT INTO transaction_lines (
               property_id, transaction_id, product_id, packaging_id, line_type, description_snapshot,
               quantity, unit, unit_price, discount_amount, line_total, sort_order,
               packaging_label_snapshot, conversion_factor_snapshot, created_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6,
               $7, $8, $9, $10,
               GREATEST(0, ROUND($7::numeric * $9::bigint)::bigint - $10::bigint),
               $11, $12, $13, NOW()
             ) RETURNING id`,
            [
              propertyId,
              id,
              prodId,
              packId,
              lineType,
              desc,
              qty,
              unit,
              price,
              disc,
              sortOrder++,
              linePkgLabelSnapshot,
              lineFactorSnapshot
            ]
          );

          if (prodId !== null && lineType === 'STOCK') {
            const newLineId = insLine.rows[0]?.id ? Number(insLine.rows[0].id) : null;
            if (newLineId) {
              await client.query(
                `INSERT INTO stock_purchase_line_bindings (
                   property_id, transaction_id, transaction_line_id, line_type,
                   product_id, packaging_id, ordered_quantity, received_quantity, base_unit_code,
                   packaging_label_snapshot, conversion_factor_snapshot, created_at, updated_at
                 ) VALUES (
                   $1, $2, $3, $4,
                   $5, $6, $7, 0, $8,
                   $9, $10, NOW(), NOW()
                 ) ON CONFLICT (property_id, transaction_id, transaction_line_id) DO NOTHING`,
                [
                  propertyId,
                  id,
                  newLineId,
                  bindingLineType,
                  prodId,
                  packId,
                  qty,
                  unit || 'PCS',
                  linePkgLabelSnapshot,
                  lineFactorSnapshot
                ]
              );
            }
          }
        }
      }

      // Delete removed lines (which were verified to have rQty === 0)
      for (const [existingLid] of existingLinesMap.entries()) {
        if (!incomingLineIds.has(existingLid)) {
          await client.query(
            `DELETE FROM stock_purchase_line_bindings WHERE transaction_id = $1 AND transaction_line_id = $2 AND property_id = $3`,
            [id, existingLid, propertyId]
          );
          await client.query(
            `DELETE FROM transaction_lines WHERE id = $1 AND transaction_id = $2 AND property_id = $3`,
            [existingLid, id, propertyId]
          );
        }
      }
    }

    // 5. Category & Department resolution if provided
    let categoryCode = prev.category_code;
    let categoryName = prev.category_name;
    let purchaseCategoryId = prev.purchase_category_id;
    let departmentCode = prev.department_code;
    let departmentId = prev.department_id;
    let departmentNameSnapshot = prev.department_name_snapshot;

    if (dto.category_code || dto.purchase_category_id) {
      const cat = await resolvePurchaseCategoryBinding(pool, propertyId, dto);
      categoryCode = cat.code;
      categoryName = cat.name;
      purchaseCategoryId = cat.id;
    }

    if (dto.department_code || dto.department_id) {
      const dept = await resolvePurchaseDepartmentBinding(pool, propertyId, dto);
      departmentCode = dept.code;
      departmentId = dept.id;
      departmentNameSnapshot = dept.name;
    }

    let supplierId = dto.supplier_id !== undefined ? (dto.supplier_id ? Number(dto.supplier_id) : null) : prev.supplier_id;
    let supplierName = dto.supplier_name !== undefined ? (dto.supplier_name?.trim() || null) : prev.party_name;

    if (dto.supplier_id !== undefined && supplierId) {
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

    let hasPoVariance = Boolean(prev.has_po_variance);
    let poVarianceSummary: any = prev.po_variance_summary || {};
    if (prev.po_id) {
      const poRes = await client.query(
        `SELECT po.*, s.name AS canonical_supplier_name
           FROM pos_purchase_orders po
           LEFT JOIN suppliers s ON s.id = po.canonical_supplier_id AND s.property_id = po.property_id
          WHERE po.id = $1 AND po.property_id = $2`,
        [prev.po_id, propertyId]
      );
      const po = poRes.rows[0];
      if (po) {
        const poSupplierId = po.canonical_supplier_id ? Number(po.canonical_supplier_id) : null;
        if (poSupplierId && supplierId && Number(supplierId) !== poSupplierId) {
          const err: any = new Error(
            `Rekanan pada tagihan harus sesuai dengan PO (${po.canonical_supplier_name || po.supplier_name}). Perubahan rekanan wajib melalui revisi PO.`
          );
          err.statusCode = 409;
          err.code = 'PO_SUPPLIER_MISMATCH';
          throw err;
        }
        const poItemsRes = await client.query(
          `SELECT * FROM pos_purchase_order_items WHERE po_id = $1 ORDER BY id ASC`,
          [prev.po_id]
        );
        const poItemsMap = new Map<number, any>();
        for (const pi of poItemsRes.rows) {
          poItemsMap.set(Number(pi.id), pi);
        }
        const currentLinesRes = await client.query(
          `SELECT * FROM transaction_lines WHERE transaction_id = $1 AND property_id = $2 ORDER BY sort_order ASC, id ASC`,
          [id, propertyId]
        );
        const variances: any[] = [];
        for (const cl of currentLinesRes.rows) {
          let matchedPi = cl.po_item_id ? poItemsMap.get(Number(cl.po_item_id)) : null;
          if (!matchedPi && cl.product_id) {
            const cands = poItemsRes.rows.filter(
              (pi: any) =>
                Number(pi.product_id) === Number(cl.product_id) &&
                Number(pi.packaging_id || 0) === Number(cl.packaging_id || 0)
            );
            if (cands.length === 1) matchedPi = cands[0];
          }
          if (matchedPi) {
            const poQty = Number(matchedPi.ordered_qty || 0);
            const poPrice = Math.round(Number(matchedPi.unit_cost || 0));
            const invQty = Number(cl.quantity || 0);
            const invPrice = Math.round(Number(cl.unit_price || 0));
            const qtyDiff = Math.round((invQty - poQty) * 10000) / 10000;
            const priceDiff = invPrice - poPrice;
            if (Math.abs(qtyDiff) > 0.0001 || Math.abs(priceDiff) > 0) {
              variances.push({
                transaction_line_id: Number(cl.id),
                po_item_id: Number(matchedPi.id),
                product_id: cl.product_id ? Number(cl.product_id) : null,
                description: cl.description_snapshot,
                po_ordered_qty: poQty,
                invoice_qty: invQty,
                qty_diff: qtyDiff,
                po_unit_cost: poPrice,
                invoice_unit_price: invPrice,
                unit_price_diff: priceDiff,
              });
            }
          } else {
            variances.push({
              transaction_line_id: Number(cl.id),
              po_item_id: null,
              product_id: cl.product_id ? Number(cl.product_id) : null,
              description: cl.description_snapshot,
              reason: 'UNMATCHED_PO_LINE',
            });
          }
        }
        hasPoVariance = variances.length > 0;
        poVarianceSummary = {
          has_variance: hasPoVariance,
          po_id: Number(prev.po_id),
          po_number: po.po_number,
          checked_at: new Date().toISOString(),
          variances,
        };
      }
    }

    let txDate = prev.transaction_date;
    if (dto.transaction_date) {
      const dateStr = String(dto.transaction_date).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const err: any = new Error('Format tanggal transaksi harus YYYY-MM-DD');
        err.statusCode = 400;
        throw err;
      }
      txDate = dateStr;
    }

    const txDiscount = dto.transaction_discount !== undefined
      ? Math.max(0, Math.round(Number(dto.transaction_discount || dto.discount_amount || 0)))
      : Number(prev.discount_amount || 0);
    const roundingAmount = dto.rounding_amount !== undefined
      ? Math.round(Number(dto.rounding_amount || 0))
      : Number(prev.rounding_amount || 0);

    const description = dto.description !== undefined ? (dto.description?.trim() || null) : prev.description;
    const sourceRef = dto.source_reference !== undefined ? (dto.source_reference?.trim() || null) : prev.source_reference;
    const notes = dto.notes !== undefined ? (dto.notes?.trim() || null) : prev.notes;
    const paymentMethod = dto.payment_method !== undefined ? (dto.payment_method?.trim() || null) : prev.payment_method;

    if (
      Number(supplierId || 0) !== Number(prev.supplier_id || 0) ||
      String(supplierName || '') !== String(prev.party_name || '') ||
      txDiscount !== Number(prev.discount_amount || 0) ||
      roundingAmount !== Number(prev.rounding_amount || 0)
    ) {
      materialChanged = true;
    }

    const prevApprovalStatus = String(prev.approval_status || 'PENDING_APPROVAL').toUpperCase();
    const keepPoInheritedApproval = Boolean(prev.po_id) && !hasPoVariance && prevApprovalStatus === 'APPROVED';
    const nextApprovalStatus = keepPoInheritedApproval ? 'APPROVED' : (materialChanged ? 'PENDING_APPROVAL' : prevApprovalStatus);
    const nextApprovedByUserId = keepPoInheritedApproval ? (prev.approved_by_user_id || null) : (materialChanged ? null : (prev.approved_by_user_id || null));
    const nextApprovedByName = keepPoInheritedApproval ? (prev.approved_by_name_snapshot || null) : (materialChanged ? null : (prev.approved_by_name_snapshot || null));
    const nextApprovedAt = keepPoInheritedApproval ? (prev.approved_at || null) : (materialChanged ? null : (prev.approved_at || null));
    const nextRejectionReason = keepPoInheritedApproval ? null : (materialChanged ? null : (prev.rejection_reason || null));
    const revisionDelta = materialChanged ? 1 : 0;

    // 5b. Canonical Stock Receiving Control (v0.2 section 0.4)
    const canonicalRecv =
      typeof computeCanonicalStockReceivingStatus === 'function'
        ? await computeCanonicalStockReceivingStatus(client, propertyId, id, prev.received_at)
        : { hasStockLines: false, receivingStatus: (prev.receiving_status || 'BELUM_DITERIMA') as ReceivingStatus, receivedAt: prev.received_at || null };
    let nextReceivingStatus: string = prev.receiving_status || 'BELUM_DITERIMA';
    let nextReceivedAt: string | null = prev.received_at || null;
    if (canonicalRecv.hasStockLines) {
      const callerRecvStatus = dto.receiving_status !== undefined && dto.receiving_status !== null
        ? String(dto.receiving_status).trim().toUpperCase()
        : '';
      const hasCallerReceivedAt = dto.received_at !== undefined && dto.received_at !== null && String(dto.received_at).trim() !== '';
      if ((callerRecvStatus !== '' && callerRecvStatus !== canonicalRecv.receivingStatus) || hasCallerReceivedAt) {
        const err: any = new Error(
          'Status penerimaan untuk pembelian barang stok dikendalikan secara otomatis melalui dokumen Penerimaan Barang (GRN) yang di-Post dan tidak dapat diubah manual.'
        );
        err.statusCode = 400;
        err.code = 'STOCK_RECEIVING_MANAGED_BY_GRN';
        throw err;
      }
      nextReceivingStatus = canonicalRecv.receivingStatus;
      nextReceivedAt = canonicalRecv.receivedAt;
    } else if (dto.receiving_status !== undefined && dto.receiving_status !== null && String(dto.receiving_status).trim() !== '') {
      nextReceivingStatus = resolvePurchaseReceivingStatus(dto.receiving_status);
      nextReceivedAt = nextReceivingStatus === 'BELUM_DITERIMA'
        ? null
        : (dto.received_at ? new Date(dto.received_at).toISOString() : (prev.received_at || new Date().toISOString()));
    }

    // 6. Update header & recompute line sums atomically
    const recomputeRes = await client.query(
      `WITH line_sums AS (
         SELECT COALESCE(SUM(line_total), 0) AS subtotal
         FROM transaction_lines
         WHERE transaction_id = $1
       )
       UPDATE transactions
       SET category_code = $2,
           category_name = $3,
           purchase_category_id = $4,
           department_code = $5,
           department_id = $6,
           department_name_snapshot = $7,
           supplier_id = $8,
           party_name = $9,
           transaction_date = $10,
           source_reference = $11,
           description = $12,
           notes = $13,
           payment_method = $14,
           amount = line_sums.subtotal::bigint,
           discount_amount = $15::bigint,
           rounding_amount = $16::bigint,
           net_amount = GREATEST(0, (line_sums.subtotal::bigint - $15::bigint + $16::bigint)),
           updated_by = $17,
           approval_status = $19,
           approved_by_user_id = $20,
           approved_by_name_snapshot = $21,
           approved_at = $22,
           rejection_reason = $23,
           source_revision = COALESCE(source_revision, 1) + $24,
           receiving_status = $25,
           received_at = $26,
           has_po_variance = $27,
           po_variance_summary = $28::jsonb,
           updated_at = NOW()
       FROM line_sums
       WHERE id = $1 AND property_id = $18
       RETURNING *`,
      [
        id,
        categoryCode,
        categoryName,
        purchaseCategoryId,
        departmentCode,
        departmentId,
        departmentNameSnapshot,
        supplierId,
        supplierName,
        txDate,
        sourceRef,
        description,
        notes,
        paymentMethod,
        txDiscount,
        roundingAmount,
        dto.actor_name || dto.actor_user_id || 'Staff',
        propertyId,
        nextApprovalStatus,
        nextApprovedByUserId,
        nextApprovedByName,
        nextApprovedAt,
        nextRejectionReason,
        revisionDelta,
        nextReceivingStatus,
        nextReceivedAt,
        hasPoVariance,
        JSON.stringify(poVarianceSummary || {})
      ]
    );

    const updatedTx = recomputeRes.rows[0] || prev;
    if (materialChanged) {
      prev.approval_status = nextApprovalStatus;
      prev.approved_by_user_id = nextApprovedByUserId;
      prev.approved_by_name_snapshot = nextApprovedByName;
      prev.approved_at = nextApprovedAt;
      prev.rejection_reason = nextRejectionReason;
      prev.source_revision = Number(prev.source_revision || 1) + revisionDelta;
    }

    // 7. Audit log
    const actor = dto.actor_name || dto.actor_user_id || 'Staff';
    await client.query(
      `INSERT INTO audit_logs (
        module, action, entity, record_id, new_value, property_id, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        'TRANSACTIONS',
        'PURCHASE_UPDATED',
        'transactions',
        String(id),
        JSON.stringify({
          transaction_no: prev.transaction_no,
          previous: {
            amount: prev.amount,
            net_amount: prev.net_amount,
            lines_count: existingLines.length
          },
          updated: {
            amount: updatedTx.amount,
            net_amount: updatedTx.net_amount
          },
          actor
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
    await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recipient_email VARCHAR(160) DEFAULT NULL`);

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
    const isPaid = dto.is_paid === true; // Default: false (Pengajuan dulu -> Menunggu Persetujuan & Belum Bayar)
    const paymentStatus = isPaid ? 'PAID' : 'UNPAID';
    const initialApprovalStatus = isPaid ? 'APPROVED' : 'PENDING_APPROVAL';

    const insertTx = await client.query(
      `INSERT INTO transactions (
        property_id, transaction_no, transaction_date, transaction_time,
        transaction_type, source_type, source_reference, party_name,
        category_code, category_name, department_code, description,
        amount, discount_amount, service_amount, tax_amount, rounding_amount, net_amount,
        payment_status, payment_method, transaction_status,
        supplier_id, receiving_status, received_at, verification_status,
        notes, metadata, created_by,
        recipient_bank_name, recipient_bank_account, recipient_bank_holder, recipient_email,
        expense_workflow_status, approval_status
      ) VALUES (
        $1, $2, $3, CURRENT_TIMESTAMP,
        'EXPENSE', 'MANUAL_EXPENSE', $4, $5,
        $6, $7, $8, $9,
        $10, 0, 0, 0, 0, $10,
        $11, $12, 'POSTED',
        $13, NULL, NULL, 'UNVERIFIED',
        $14, $15, $16,
        $17, $18, $19, $20,
        'PROSES', $21
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
        dto.recipient_email?.trim() || null,
        initialApprovalStatus,
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
    await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recipient_email VARCHAR(160) DEFAULT NULL`);

    // 1. Row-lock and validate
    const prevRes = await client.query(
      `SELECT id, transaction_no, transaction_type, transaction_status,
              payment_status, approval_status,
              verification_status, expense_workflow_status,
              verified_by_user_id, verified_by_name_snapshot, verified_at, deleted_at,
              party_name, description, amount, payment_method,
              category_code, department_code, source_reference, notes,
              recipient_bank_name, recipient_bank_account, recipient_bank_holder, recipient_email
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
      recipient_email: prev.recipient_email,
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
          recipient_email = $14,
          transaction_date = $15,
          verification_status = 'UNVERIFIED',
          verified_by_user_id = NULL,
          verified_by_name_snapshot = NULL,
          verified_at = NULL,
          updated_at = NOW()
        WHERE id = $16 AND property_id = $17
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
        dto.recipient_email?.trim() || null,
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

    // Purchase-specific workflow auto-transition: VERIFIED => SELESAI, UNVERIFIED/REJECTED => PROSES
    if (prevRow.transaction_type.toUpperCase() === 'PURCHASE') {
      const newWorkflow = status === 'VERIFIED' ? 'SELESAI' : 'PROSES';
      await client.query(
        `UPDATE transactions SET purchase_workflow_status = $1, updated_at = NOW() WHERE id = $2 AND property_id = $3`,
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

  const canonicalRecv = await computeCanonicalStockReceivingStatus(pool, propertyId, id, currentTx.received_at);
  if (canonicalRecv.hasStockLines) {
    const err: any = new Error(
      'Status penerimaan untuk pembelian barang stok dikendalikan secara otomatis melalui dokumen Penerimaan Barang (GRN) yang di-Post dan tidak dapat diubah manual.'
    );
    err.statusCode = 400;
    err.code = 'STOCK_RECEIVING_MANAGED_BY_GRN';
    throw err;
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
              t.source_type, t.approval_status,
              t.reservation_id, t.booking_id,
              COALESCE(pmt.total_paid, 0)::bigint AS paid_amount,
              COALESCE(b.payment_responsibility, 'HOTEL_COLLECT') AS payment_responsibility
       FROM transactions t
       LEFT JOIN bookings b ON b.id = COALESCE(t.booking_id, (SELECT booking_id FROM reservations WHERE id = t.reservation_id LIMIT 1))
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

    // Guard for EXPENSE & PURCHASE: must be APPROVED before payment can be settled.
    const txTypeUpper = String(tx.transaction_type || '').trim().toUpperCase();
    if (txTypeUpper === 'EXPENSE' || txTypeUpper === 'PURCHASE') {
      const appUpper = String(tx.approval_status || 'APPROVED').trim().toUpperCase();
      if (appUpper !== 'APPROVED') {
        const err: any = new Error(
          `Transaksi ${tx.transaction_no} belum disetujui (status: ${appUpper === 'REJECTED' ? 'Ditolak' : 'Menunggu Persetujuan'}). Silakan setujui (Approve) terlebih dahulu sebelum mencatat pembayaran.`
        );
        err.statusCode = 409;
        err.code = 'APPROVAL_REQUIRED_BEFORE_PAYMENT';
        throw err;
      }
    }

    // A. Guard: POS_ORDER/POS tidak boleh dilunasi manual — harus melalui pembayaran POS.
    const txSourceType = String(tx.source_type || '').trim().toUpperCase();
    if (txSourceType === 'POS_ORDER' || txSourceType === 'POS') {
      const err: any = new Error(
        'Pembayaran POS tidak dapat dilakukan melalui pelunasan manual. Gunakan pembayaran POS.'
      );
      err.statusCode = 409;
      err.code = 'POS_PAYMENT_ROUTE_REQUIRED';
      throw err;
    }

    const netAmount = Number(tx.net_amount) || 0;
    const currentPaid = Number(tx.paid_amount) || 0;
    const outstanding = Math.max(0, netAmount - currentPaid);

    // UI-3: For reservation-linked transactions, gate settlement on canonical
    // hotel collectible balance. This avoids accepting payment for OTA room
    // charges that are settled outside the hotel.
    // Fail-closed: if calculator throws, reject the settlement (no legacy fallback).
    let canonicalCollectible: Awaited<ReturnType<typeof calculateHotelCollectibleBalance>> | null = null;
    if (tx.reservation_id != null && Number(tx.reservation_id) > 0) {
      canonicalCollectible = await calculateHotelCollectibleBalance(
        client,
        Number(tx.reservation_id),
        propertyId,
        String(tx.payment_responsibility || 'HOTEL_COLLECT')
      );
    }

    if (canonicalCollectible) {
      const { hotel_collectible_remaining_balance } = canonicalCollectible;
      if (hotel_collectible_remaining_balance <= 0) {
        const isOtaCollect = String(tx.payment_responsibility || '').toUpperCase() === 'OTA_COLLECT';
        throw new Error(
          isOtaCollect
            ? 'Tidak dapat menyetor ke reservasi ini — tidak ada sisa tagihan hotel (hotel_collectible_remaining_balance = 0). Tagihan kamar OTA sudah diselesaikan di luar hotel.'
            : 'Tidak dapat menyetor ke reservasi ini — seluruh tagihan folio reservasi sudah lunas (hotel_collectible_remaining_balance = 0).'
        );
      }
      if (amount > hotel_collectible_remaining_balance) {
        throw new Error(`Nominal pelunasan (Rp ${amount.toLocaleString('id-ID')}) melebihi sisa tagihan hotel (Rp ${hotel_collectible_remaining_balance.toLocaleString('id-ID')}). Sisa tagihan hotel yang dapat disetor: Rp ${hotel_collectible_remaining_balance.toLocaleString('id-ID')}.`);
      }
    } else {
      // Non-reservation: use legacy outstanding check
      if (amount > outstanding && outstanding > 0) {
        throw new Error(`Nominal pelunasan (Rp ${amount.toLocaleString('id-ID')}) melebihi sisa tagihan (Rp ${outstanding.toLocaleString('id-ID')})`);
      }
    }

    // Insert payment_transactions.
    // Non-reservation: legacy transaction-level INSERT (no scope/booking linkage).
    // Reservation-linked: canonical direct ROOM_RESERVATION payment row with
    // transaction_id + reservation_id + booking_id so it is visible to both
    // transaction-scoped readers AND getEffectivePaymentStateForReservation
    // as a single row (OR-condition matches once per row).
    if (tx.reservation_id != null && Number(tx.reservation_id) > 0) {
      await client.query(
        `INSERT INTO payment_transactions (
          property_id, transaction_id, reservation_id, booking_id, scope,
          transaction_type, amount, payment_method,
          reference_code, status, created_by, created_at
        ) VALUES (
          $1, $2, $3, $4, 'ROOM_RESERVATION', 'PAYMENT', $5, $6, $7, 'SUCCESS', $8, NOW()
        )`,
        [
          propertyId,
          id,
          tx.reservation_id,
          tx.booking_id || null,
          amount,
          dto.payment_method || 'TRANSFER',
          dto.notes || `PELUNASAN-${tx.transaction_no}`,
          dto.actor_name || 'Staff'
        ]
      );
    } else {
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
    }

    // Derive payment_status from canonical state for reservation-linked,
    // legacy derived from raw paid_amount for non-reservation.
    // CRITICAL: use remaining_balance - amount (state AFTER this payment),
    // not canonical_amount_paid + canonical_applied_deposit (state BEFORE).
    let newPaymentStatus: string;
    let newPaid: number;
    if (canonicalCollectible) {
      const { hotel_collectible_remaining_balance, canonical_amount_paid, canonical_applied_deposit } = canonicalCollectible;
      // remaining_balance at settlement time = what is left AFTER this payment applies
      const postInsertRemaining = Math.max(0, hotel_collectible_remaining_balance - amount);
      newPaid = canonical_amount_paid + canonical_applied_deposit + amount;
      if (postInsertRemaining <= 0) {
        newPaymentStatus = 'PAID';
      } else if (newPaid > 0) {
        newPaymentStatus = 'PARTIALLY_PAID';
      } else {
        newPaymentStatus = 'UNPAID';
      }
    } else {
      newPaid = currentPaid + amount;
      newPaymentStatus = newPaid >= netAmount ? 'PAID' : (newPaid > 0 ? 'PARTIALLY_PAID' : 'UNPAID');
    }

    if (txTypeUpper === 'EXPENSE' && newPaymentStatus === 'PAID') {
      await client.query(
        `UPDATE transactions
         SET payment_status = $1,
             approval_status = 'APPROVED',
             approved_by_name_snapshot = COALESCE(approved_by_name_snapshot, $4),
             approved_at = COALESCE(approved_at, NOW()),
             verification_status = 'VERIFIED',
             verified_by_name_snapshot = COALESCE(verified_by_name_snapshot, $4),
             verified_at = COALESCE(verified_at, NOW()),
             purchase_workflow_status = 'SELESAI',
             expense_workflow_status = 'SELESAI',
             updated_at = NOW()
         WHERE id = $2 AND property_id = $3`,
        [newPaymentStatus, id, propertyId, dto.actor_name || 'Akuntansi']
      );
    } else if (txTypeUpper === 'PURCHASE' && newPaymentStatus === 'PAID') {
      await client.query(
        `UPDATE transactions
         SET payment_status = $1,
             approval_status = 'APPROVED',
             updated_at = NOW()
         WHERE id = $2 AND property_id = $3`,
        [newPaymentStatus, id, propertyId]
      );
    } else {
      await client.query(
        `UPDATE transactions
         SET payment_status = $1,
             updated_at = NOW()
         WHERE id = $2 AND property_id = $3`,
        [newPaymentStatus, id, propertyId]
      );
    }

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

    let tx = txRes.rows[0];

    if (tx.transaction_status === 'VOIDED' || tx.transaction_status === 'REVERSED') {
      if (tx.booking_id && String(tx.transaction_type || '').toUpperCase() === 'SALE') {
        const activeSibRes = await client.query(
          `SELECT * FROM transactions
            WHERE property_id = $1
              AND booking_id = $2
              AND transaction_type = 'SALE'
              AND deleted_at IS NULL
              AND COALESCE(transaction_status, 'POSTED') NOT IN ('VOIDED', 'REVERSED', 'CANCELLED')
            ORDER BY id ASC
            LIMIT 1
            FOR UPDATE`,
          [propertyId, tx.booking_id]
        );
        if ((activeSibRes.rowCount ?? 0) > 0) {
          tx = activeSibRes.rows[0];
        } else {
          const err: any = new Error(`Transaksi #${tx.transaction_no} sudah dalam status ${tx.transaction_status} dan tidak dapat dibatalkan lagi.`);
          err.statusCode = 400;
          throw err;
        }
      } else {
        const err: any = new Error(`Transaksi #${tx.transaction_no} sudah dalam status ${tx.transaction_status} dan tidak dapat dibatalkan lagi.`);
        err.statusCode = 400;
        throw err;
      }
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

    // If voiding a booking-grouped room SALE transaction, also void any remaining POSTED SALE members
    // of that same booking_id so the entire BID group moves cleanly to Sheet BATAL.
    if (
      String(tx.transaction_type || '').toUpperCase() === 'SALE' &&
      tx.booking_id &&
      !['POS_ORDER', 'POS'].includes(String(tx.source_type || '').toUpperCase())
    ) {
      const siblingSalesRes = await client.query(
        `SELECT * FROM transactions
         WHERE property_id = $1
           AND booking_id = $2
           AND id <> $3
           AND transaction_type = 'SALE'
           AND deleted_at IS NULL
           AND COALESCE(transaction_status, 'POSTED') NOT IN ('VOIDED', 'REVERSED', 'CANCELLED')
         FOR UPDATE`,
        [propertyId, tx.booking_id, tx.id]
      );
      for (const sib of siblingSalesRes.rows) {
        const sibTxNo = await generateTransactionNumber(client, propertyId, txDate);
        await client.query(
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
            $12, 0, $13, $14, $15,
            $16, $17, 'REVERSED',
            $18, $19, $20,
            $21, $22, $23,
            $24, $25, $26
          )`,
          [
            propertyId,
            sibTxNo,
            txDate,
            sib.transaction_type,
            sib.source_type,
            sib.source_id ? `REV-${sib.source_id}` : null,
            sib.source_reference,
            sib.category_code,
            sib.category_name,
            sib.department_code,
            `Pembatalan: ${sib.description}`,
            -Math.abs(Number(sib.amount || 0)),
            -Math.abs(Number(sib.service_amount || 0)),
            -Math.abs(Number(sib.tax_amount || 0)),
            -Math.abs(Number(sib.net_amount || 0)),
            sib.payment_status,
            sib.payment_method,
            sib.guest_id,
            sib.guest_name_snapshot,
            sib.room_number_snapshot,
            sib.reservation_id,
            sib.booking_id,
            sib.id,
            options.reason.trim(),
            JSON.stringify({ voided_transaction_no: sib.transaction_no, void_reason: options.reason.trim() }),
            options.actorName || options.actorUserId || 'Staff'
          ]
        );
        await client.query(
          `UPDATE transactions SET
             transaction_status = 'VOIDED',
             notes = COALESCE(notes || ' | ', '') || 'Dibatalkan: ' || $1,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [options.reason.trim(), sib.id]
        );
      }
    }

    if (tx.source_type === 'POS_ORDER' || tx.source_type === 'POS') {
      const posOrderId = Number(tx.source_id);
      if (Number.isInteger(posOrderId) && posOrderId > 0) {
        await restoreStockForPosOrderVoid({
          client,
          propertyId,
          orderId: posOrderId,
          actorUserId: options.actorUserId || null,
          actorName: options.actorName || 'Staff',
        });
        await client.query(
          `UPDATE pos_orders
              SET status = 'CANCELLED',
                  updated_at = NOW()
            WHERE id = $1 AND property_id = $2`,
          [posOrderId, propertyId]
        );
        await client.query(
          `UPDATE folio_entries
              SET is_voided = TRUE,
                  status = 'VOIDED',
                  voided_at = NOW(),
                  voided_by = $3,
                  void_reason = 'POS Order dibatalkan dari Pusat Transaksi'
            WHERE property_id = $1
              AND source_type = 'POS_ORDER'
              AND source_id = $2
              AND COALESCE(is_voided, FALSE) = FALSE`,
          [propertyId, String(posOrderId), options.actorName || 'Staff']
        );
        await client.query(
          `UPDATE pos_complimentary_usages
              SET status = 'CANCELLED'
            WHERE pos_order_id = $1
              AND property_id = $2
              AND status = 'ACTIVE'`,
          [posOrderId, propertyId]
        );
      }
    } else if (
      String(tx.transaction_type || '').toUpperCase() === 'SALE' &&
      (tx.booking_id || tx.reservation_id)
    ) {
      const targetResIds = new Set<number>();
      if (Number.isInteger(Number(tx.reservation_id)) && Number(tx.reservation_id) > 0) {
        targetResIds.add(Number(tx.reservation_id));
      }
      if (tx.booking_id) {
        const resChildren = await client.query(
          `SELECT id FROM reservations WHERE booking_id = $1`,
          [tx.booking_id]
        );
        for (const r of resChildren.rows) {
          if (Number.isInteger(Number(r.id)) && Number(r.id) > 0) {
            targetResIds.add(Number(r.id));
          }
        }
      }
      for (const resId of targetResIds) {
        await restoreAllReservationEffectsOnCancelOrVoid({
          client,
          propertyId,
          reservationId: resId,
          actorUserId: options.actorUserId || null,
          actorName: options.actorName || 'Staff',
        });
      }
    }

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

/**
 * Build Scope-B conditions for HAPUS table queries.
 * Uses explicit sequential parameter building (NO regex placeholder renumbering).
 * Includes: property_id, transaction_type (when active), all advanced filters, period, search, party_name, and deleted_at IS NOT NULL.
 * The SAME builder powers hapusCount, HAPUS total_count, and HAPUS table rows.
 */
function buildHapusConditionsAndValues(
  params: TransactionFilterParams,
  propertyId: number
): { conditions: string[]; values: any[] } {
  const conditions: string[] = ['t.property_id = $1'];
  const values: any[] = [propertyId];
  let idx = 2;

  if (params.transaction_type) {
    conditions.push(`UPPER(t.transaction_type) = $${idx++}`);
    values.push(params.transaction_type.toUpperCase());
  }
  if (params.source_type) {
    conditions.push(`t.source_type = $${idx++}`);
    values.push(params.source_type);
  }
  if (params.category_code) {
    conditions.push(`t.category_code = $${idx++}`);
    values.push(params.category_code);
  }
  if (params.department_code) {
    conditions.push(`t.department_code = $${idx++}`);
    values.push(params.department_code);
  }
  if (params.payment_status) {
    conditions.push(`t.payment_status = $${idx++}`);
    values.push(params.payment_status);
  }
  if (params.payment_method) {
    conditions.push(`t.payment_method = $${idx++}`);
    values.push(params.payment_method);
  }
  if (params.verification_status) {
    conditions.push(`t.verification_status = $${idx++}`);
    values.push(params.verification_status);
  }
  if (params.receiving_status) {
    if (['DITERIMA', 'DITERIMA_LENGKAP'].includes(String(params.receiving_status).toUpperCase())) {
      conditions.push(`t.receiving_status IN ('DITERIMA', 'DITERIMA_LENGKAP')`);
    } else {
      conditions.push(`t.receiving_status = $${idx++}`);
      values.push(params.receiving_status);
    }
  }
  if (params.transaction_status) {
    conditions.push(`UPPER(t.transaction_status) = $${idx++}`);
    values.push(String(params.transaction_status).toUpperCase());
  }
  if (params.supplier_id) {
    conditions.push(`t.supplier_id = $${idx++}`);
    values.push(params.supplier_id);
  }
  if (params.reservation_id) {
    conditions.push(`t.reservation_id = $${idx++}`);
    values.push(params.reservation_id);
  }
  if (params.booking_id) {
    conditions.push(`(t.booking_id::text = $${idx} OR b.bid = $${idx})`);
    values.push(String(params.booking_id));
    idx++;
  }
  if (params.start_date) {
    conditions.push(`t.transaction_date >= $${idx++}`);
    values.push(params.start_date);
  }
  if (params.end_date) {
    conditions.push(`t.transaction_date <= $${idx++}`);
    values.push(params.end_date);
  }
  if (params.party_name && params.party_name.trim()) {
    conditions.push(`(t.party_name ILIKE $${idx} OR s.name ILIKE $${idx})`);
    values.push(`%${params.party_name.trim()}%`);
    idx++;
  }
  if (params.search && params.search.trim()) {
    const searchTerm = `%${params.search.trim()}%`;
    conditions.push(`(
      t.transaction_no ILIKE $${idx} OR
      t.description ILIKE $${idx} OR
      t.source_reference ILIKE $${idx} OR
      t.party_name ILIKE $${idx} OR
      s.name ILIKE $${idx} OR
      t.guest_name_snapshot ILIKE $${idx} OR
      t.room_number_snapshot ILIKE $${idx} OR
      t.notes ILIKE $${idx} OR
      b.bid ILIKE $${idx} OR
      r.booking_number ILIKE $${idx} OR
      r.guest_name ILIKE $${idx} OR
      ('POS-' || LPAD(COALESCE(t.source_id, ''), 6, '0')) ILIKE $${idx}
    )`);
    values.push(searchTerm);
    idx++;
  }
  conditions.push('t.deleted_at IS NOT NULL');

  return { conditions, values };
}


const _healedPartialVoidProps = new Set<number>();

async function healPartiallyVoidedBookingsFromAudit(pool: Pool, propertyId: number): Promise<void> {
  if (_healedPartialVoidProps.has(propertyId)) return;
  _healedPartialVoidProps.add(propertyId);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Find any booking_id where a non-POS SALE transaction was manually voided via voidTransaction (recorded in audit_logs)
      // while other SALE transactions of the same booking_id remained POSTED.
      const stuckRes = await client.query(
        `SELECT s.*
         FROM transactions s
         WHERE s.property_id = $1
           AND s.booking_id IS NOT NULL
           AND s.transaction_type = 'SALE'
           AND s.deleted_at IS NULL
           AND COALESCE(s.transaction_status, 'POSTED') NOT IN ('VOIDED', 'REVERSED', 'CANCELLED')
           AND EXISTS (
             SELECT 1
             FROM transactions v
             JOIN audit_logs al
               ON al.property_id = v.property_id
              AND al.module = 'TRANSACTIONS'
              AND al.action = 'TRANSACTION_VOIDED'
              AND al.record_id = v.id::text
             WHERE v.property_id = s.property_id
               AND v.booking_id = s.booking_id
               AND v.transaction_type = 'SALE'
               AND COALESCE(v.source_type, '') NOT IN ('POS_ORDER', 'POS')
               AND v.transaction_status = 'VOIDED'
           )
         FOR UPDATE`,
        [propertyId]
      );
      if ((stuckRes.rowCount ?? 0) > 0) {
        const txDate = getHotelDateToday();
        for (const sib of stuckRes.rows) {
          const sibTxNo = await generateTransactionNumber(client, propertyId, txDate);
          await client.query(
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
              $12, 0, $13, $14, $15,
              $16, $17, 'REVERSED',
              $18, $19, $20,
              $21, $22, $23,
              $24, $25, 'System'
            )`,
            [
              propertyId,
              sibTxNo,
              txDate,
              sib.transaction_type,
              sib.source_type,
              sib.source_id ? `REV-${sib.source_id}` : null,
              sib.source_reference,
              sib.category_code,
              sib.category_name,
              sib.department_code,
              `Pembatalan: ${sib.description}`,
              -Math.abs(Number(sib.amount || 0)),
              -Math.abs(Number(sib.service_amount || 0)),
              -Math.abs(Number(sib.tax_amount || 0)),
              -Math.abs(Number(sib.net_amount || 0)),
              sib.payment_status,
              sib.payment_method,
              sib.guest_id,
              sib.guest_name_snapshot,
              sib.room_number_snapshot,
              sib.reservation_id,
              sib.booking_id,
              sib.id,
              'Sinkronisasi pembatalan grup transaksi booking',
              JSON.stringify({ voided_transaction_no: sib.transaction_no, void_reason: 'Sinkronisasi pembatalan grup transaksi booking' }),
            ]
          );
          await client.query(
            `UPDATE transactions SET
               transaction_status = 'VOIDED',
               notes = COALESCE(notes || ' | ', '') || 'Dibatalkan: Sinkronisasi pembatalan grup booking',
               updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [sib.id]
          );
        }
      }
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK').catch(() => {});
    } finally {
      client.release();
    }
  } catch {
    // non-fatal
  }
}

let expenseRecipientSchemaReady = false;
async function ensureExpenseRecipientSchema(pool: Pool): Promise<void> {
  if (expenseRecipientSchemaReady) return;
  try {
    await pool.query(`
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recipient_email VARCHAR(160) DEFAULT NULL;
      UPDATE transactions
      SET approval_status = 'APPROVED'
      WHERE transaction_type IN ('EXPENSE', 'PURCHASE')
        AND UPPER(COALESCE(payment_status, '')) = 'PAID'
        AND COALESCE(UPPER(approval_status), 'PENDING_APPROVAL') = 'PENDING_APPROVAL';
      UPDATE transactions
      SET purchase_workflow_status = 'SELESAI'
      WHERE transaction_type = 'PURCHASE'
        AND verification_status = 'VERIFIED'
        AND COALESCE(purchase_workflow_status, 'PROSES') != 'SELESAI';
      UPDATE transaction_attachments ta
      SET attachment_purpose = 'INVOICE'
      FROM transactions t
      WHERE ta.transaction_id = t.id
        AND t.transaction_type = 'EXPENSE'
        AND COALESCE(ta.uploaded_by, '') != 'Akuntansi'
        AND ta.attachment_purpose = 'RECEIPT';
    `);
    expenseRecipientSchemaReady = true;
  } catch {
    // non-fatal
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
  if (!Number.isInteger(propertyId) || !propertyId || propertyId <= 0) {
    const err: any = new Error('property_id is required');
    err.statusCode = 400;
    throw err;
  }

  await ensureExpenseRecipientSchema(pool);
  await healPartiallyVoidedBookingsFromAudit(pool, propertyId);

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
    if (['DITERIMA', 'DITERIMA_LENGKAP'].includes(String(params.receiving_status).toUpperCase())) {
      baseConditions.push(`t.receiving_status IN ('DITERIMA', 'DITERIMA_LENGKAP')`);
    } else {
      baseConditions.push(`t.receiving_status = $${valIdx++}`);
      baseValues.push(params.receiving_status);
    }
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
      r.guest_name ILIKE $${valIdx} OR
      ('POS-' || LPAD(COALESCE(t.source_id, ''), 6, '0')) ILIKE $${valIdx} OR
      EXISTS (
        SELECT 1 FROM pos_orders po_s
        WHERE po_s.property_id = t.property_id
          AND (
            (UPPER(COALESCE(t.source_type, '')) IN ('POS_ORDER', 'POS') AND po_s.id::text = t.source_id)
            OR (t.reservation_id IS NOT NULL AND po_s.reservation_id = t.reservation_id)
          )
          AND (
            po_s.order_number ILIKE $${valIdx}
            OR ('POS-' || LPAD(po_s.id::text, 6, '0')) ILIKE $${valIdx}
          )
      )
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
            s.email AS supplier_email,
            COALESCE(NULLIF(BTRIM(t.recipient_email), ''), s.email) AS recipient_email,
           r.booking_number,
           r.stay_type,
           r.stay_sequence,
            r.status AS reservation_status,
            r.stay_status AS reservation_stay_status,
            r.cancelled_at AS reservation_cancelled_at,
           r.check_in::text AS check_in,
           r.check_out::text AS check_out,
           r.amount_paid AS reservation_amount_paid,
           r.remaining_balance AS reservation_remaining_balance,
           r.booked_room_type_name_snapshot,
           COALESCE(rt_current.name, rt_booked.name, r.booked_room_type_name_snapshot) AS room_type_name,
             b.bid AS booking_bid,
             b.payment_responsibility AS payment_responsibility,
             b.booking_status,
            b.booking_source,
            b.channel AS booking_channel,
            b.ota_source_id,
            ota.name AS ota_source_name,
            po_ref.po_number AS po_number,
            po_ref.status AS po_status,
            pos_ord.pos_table_number AS pos_table_number,
            pos_ord.pos_order_items AS pos_order_items,
            COALESCE(pmt.total_paid, 0) AS paid_amount,
            GREATEST(0, t.net_amount - COALESCE(pmt.total_paid, 0)) AS outstanding_amount,
            (
              SELECT json_build_object(
                'id', ta.id,
                'original_name', ta.original_name,
                'file_name', ta.file_name,
                'mime_type', ta.mime_type
              )
              FROM transaction_attachments ta
              WHERE ta.transaction_id = t.id AND ta.property_id = t.property_id
                AND (
                  ta.attachment_purpose = 'INVOICE'
                  OR (
                    t.transaction_type = 'EXPENSE'
                    AND COALESCE(ta.uploaded_by, '') != 'Akuntansi'
                    AND ta.attachment_purpose != 'PAYMENT_PROOF'
                  )
                )
              ORDER BY CASE WHEN ta.attachment_purpose = 'INVOICE' THEN 0 ELSE 1 END, ta.id DESC
              LIMIT 1
            ) AS invoice_attachment,
            (
              SELECT json_build_object(
                'id', ta.id,
                'original_name', ta.original_name,
                'file_name', ta.file_name,
                'mime_type', ta.mime_type
              )
              FROM transaction_attachments ta
              WHERE ta.transaction_id = t.id AND ta.property_id = t.property_id
                AND (
                  (t.transaction_type = 'EXPENSE' AND (ta.attachment_purpose = 'PAYMENT_PROOF' OR COALESCE(ta.uploaded_by, '') = 'Akuntansi'))
                  OR (t.transaction_type != 'EXPENSE' AND ta.attachment_purpose IN ('PAYMENT_PROOF', 'RECEIPT'))
                )
              ORDER BY CASE WHEN ta.attachment_purpose = 'PAYMENT_PROOF' THEN 0 ELSE 1 END, ta.id DESC
              LIMIT 1
            ) AS payment_proof_attachment
     FROM transactions t
     LEFT JOIN suppliers s ON s.id = t.supplier_id
     LEFT JOIN pos_purchase_orders po_ref ON po_ref.id = t.po_id AND po_ref.property_id = t.property_id
     LEFT JOIN reservations r ON r.id = t.reservation_id
     LEFT JOIN bookings b ON b.id = COALESCE(t.booking_id, r.booking_id)
     LEFT JOIN ota_sources ota ON ota.id = b.ota_source_id AND ota.property_id = b.property_id
    LEFT JOIN rooms rm ON rm.id = r.room_id AND rm.property_id = t.property_id
    LEFT JOIN room_types rt_current ON rt_current.id = rm.room_type_id AND rt_current.property_id = t.property_id
    LEFT JOIN room_types rt_booked ON rt_booked.id = r.booked_room_type_id_snapshot AND rt_booked.property_id = t.property_id
    LEFT JOIN LATERAL (
      SELECT
        po.table_number AS pos_table_number,
        COALESCE(
          (
            SELECT JSON_AGG(
              JSON_BUILD_OBJECT(
                'id', poi.id,
                'menu_item_id', poi.menu_item_id,
                'item_name', COALESCE(pmi.name, 'Item POS'),
                'item_code', COALESCE(pmi.item_code, ''),
                'quantity', poi.quantity,
                'unit_price', poi.unit_price,
                'discount_amount', 0,
                'notes', poi.notes
              ) ORDER BY poi.id ASC
            )
            FROM pos_order_items poi
            LEFT JOIN pos_menu_items pmi ON pmi.id = poi.menu_item_id AND pmi.property_id = t.property_id
            WHERE poi.order_id = po.id
          ),
          '[]'::json
        ) AS pos_order_items
      FROM pos_orders po
      WHERE UPPER(COALESCE(t.source_type, '')) IN ('POS_ORDER', 'POS')
        AND po.property_id = t.property_id
        AND po.id::text = t.source_id
      LIMIT 1
    ) pos_ord ON TRUE
    LEFT JOIN LATERAL (
      SELECT CASE
        WHEN UPPER(COALESCE(t.source_type, '')) IN ('POS_ORDER', 'POS') THEN
          COALESCE(
            (SELECT SUM(a.amount)::numeric
             FROM payment_transactions a
             WHERE a.transaction_id = t.id
               AND a.status = 'SUCCESS'
               AND a.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')), 0
          ) + COALESCE(
            (SELECT SUM(b2.amount)::numeric
             FROM pos_settlements b2
             WHERE b2.transaction_id = t.id
               AND b2.property_id = t.property_id
               AND b2.pos_order_id::text = t.source_id
               AND b2.status = 'SUCCESS'), 0
          )
        ELSE
          COALESCE(
            (SELECT SUM(a.amount)::numeric
             FROM payment_transactions a
             WHERE (a.transaction_id = t.id OR (t.reservation_id IS NOT NULL AND a.reservation_id = t.reservation_id))
               AND a.status = 'SUCCESS'
               AND a.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')), 0
          )
      END AS total_paid
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
  const usePresentedSqlPaging =
    targetSheet !== 'HAPUS' &&
    targetSheet !== 'PIUTANG' &&
    !(params.includePiutangCount && targetSheet === 'SELESAI');

  const buildDomainPresentedList = async (): Promise<{ listSource: any[]; groups: any[]; scopedRowCount: number }> => {
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
      const primary = group.primary as any;
      const effectiveDate = (primary.reservation_cancelled_at
        && (primary.reservation_status === 'CANCELLED'
            || primary.reservation_stay_status === 'CANCELLED'))
        ? primary.reservation_cancelled_at?.toISOString?.().slice(0, 10) || primary.reservation_cancelled_at?.slice?.(0, 10)
        : undefined;
      if (!isLifecyclePrimaryInPeriod(effectiveDate || group.primary.transaction_date, params.start_date, params.end_date)) {
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
          lifecycleReservations: await loadBookingReservationLifecycle(pool, propertyId, presentedAll.map(p => p.reservation_id).filter(Boolean)),
          includePosStats: params.includePosStats ?? false,
        })
      : null;
    return {
      listSource: saleBidGrouped || presentedAll,
      groups,
      scopedRowCount: scopedRows.length,
    };
  };

  if (usePresentedSqlPaging) {
    const pagePlan = await queryPresentedPage(pool, params, hapusCount);
    // Fix: always use SQL-provided bids for hydration when present.
    // Without this, JS would only get partial member rows from transactionIds,
    // causing groupSaleLifecycles() to fail to reconstruct the BID properly.
    // Safety: still gated by pageKeySet (from SQL) and period filter.
    const pageBids = pagePlan.bids.length > 0 ? pagePlan.bids : [];
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
    const sqlEffectiveDateMap = pagePlan.effective_date_map || {};
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
      const primary = group.primary as any;
      const presentedKey = presentedListKey(group.primary, propertyId);
      const effectiveDate = (primary.reservation_cancelled_at
        && (primary.reservation_status === 'CANCELLED'
            || primary.reservation_stay_status === 'CANCELLED'))
        ? primary.reservation_cancelled_at?.toISOString?.().slice(0, 10) || primary.reservation_cancelled_at?.slice?.(0, 10)
        : undefined;
      const inPeriod = isLifecyclePrimaryInPeriod(effectiveDate || sqlEffectiveDateMap[presentedKey] || group.primary.transaction_date, params.start_date, params.end_date);
      const memberMatch = group.members.some((member) => candidateIds.has(Number(member.id)));
      if (!inPeriod) return false;
      if (params.transaction_status) {
        const wanted = String(params.transaction_status).toUpperCase();
        if (String(group.primary.transaction_status || '').toUpperCase() !== wanted) return false;
      }
      return memberMatch;
    });
    const presentedAll = groups.map((group) => presentLifecyclePrimary(group)).sort(comparePresentedListRows);
    const listType = String(params.transaction_type || '').toUpperCase();
    const saleBidGrouped = listType === 'SALE' || listType === ''
      ? presentListWithSaleBidGrouping(presentedAll, {
           lifecycleReservations: await loadBookingReservationLifecycle(pool, propertyId, presentedAll.map(p => p.reservation_id).filter(Boolean)),
           includePosStats: params.includePosStats ?? false,
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

    if (params.includePiutangCount) {
      if (
        listType === 'PURCHASE' ||
        listType === 'EXPENSE'
      ) {
        pagePlan.sheet_counts.piutang = 0;
      } else {
        const domainPresented = await buildDomainPresentedList();
        pagePlan.sheet_counts.proses = domainPresented.listSource.filter(
          (row: any) => (row.operational_sheet || row.sheet) === 'PROSES'
        ).length;
        pagePlan.sheet_counts.piutang = domainPresented.listSource.filter(isPiutangPresentedRow).length;
        pagePlan.sheet_counts.selesai = domainPresented.listSource.filter(
          (row: any) => (row.operational_sheet || row.sheet) === 'SELESAI' && !isPiutangPresentedRow(row)
        ).length;
        pagePlan.sheet_counts.batal = domainPresented.listSource.filter(
          (row: any) => (row.operational_sheet || row.sheet) === 'BATAL'
        ).length;
      }
    }

    return {
      transactions: presented,
      total_count: pagePlan.total_count,
      summary: pagePlan.summary,
      global_summary: pagePlan.global_summary,
      active_summary: pagePlan.active_summary,
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

  const { listSource, groups, scopedRowCount } = await buildDomainPresentedList();
  const sheetSource = listSource || groups.map((group) => ({ operational_sheet: group.sheet }));
  const piutangCount = listSource.filter(isPiutangPresentedRow).length;
  const sheet_counts: TransactionSheetCounts = {
    proses: sheetSource.filter((row: any) => (row.operational_sheet || row.sheet) === 'PROSES').length,
    selesai: sheetSource.filter((row: any) => (row.operational_sheet || row.sheet) === 'SELESAI' && !isPiutangPresentedRow(row)).length,
    batal: sheetSource.filter((row: any) => (row.operational_sheet || row.sheet) === 'BATAL').length,
    hapus: hapusCount,
    ...(params.includePiutangCount || targetSheet === 'PIUTANG' ? { piutang: piutangCount } : {}),
  };

  // SCOPE A: Pure property + date period snapshot.
  // Must NOT inherit domain filters (transaction_type, category_code, etc.)
  // from baseConditions, because globalSummary represents the full period.
  //
  // Canonical lifecycle ordering: build lifecycle groups from FULL non-deleted
  // property rows FIRST, then filter the canonical groups by effective-period
  // date. Filtering raw members before groupSaleLifecycles() would change
  // effective_net_amount, lifecycle primary selection, and global_summary when
  // a correction/reversal member falls outside the selected period.
  //
  // Effective-period semantics: for reservation-linked SALE cancelled stays,
  // the cancellation date is the effective period date (same rule as SQL).
  // Partial bounds (start-only / end-only / both / neither) are all supported.
  const scopeACleanupDates = !params.start_date && !params.end_date;
  const scopeACleanConditions = ['t.property_id = $1', 't.deleted_at IS NULL'];
  const scopeACleanValues = [propertyId];

  const scopeARawRes = await pool.query(
    `${listSelectSql}
     WHERE ${scopeACleanConditions.join(' AND ')}
     ORDER BY t.transaction_date DESC, t.transaction_time DESC, t.id DESC`,
    scopeACleanValues
  );
  const scopeARawRows = scopeARawRes.rows;

  // Build canonical lifecycle groups from FULL rows (no period pre-filter on members).
  const scopeAGroupedAll = groupSaleLifecycles(scopeARawRows);

  // Filter canonical lifecycle groups by effective period date.
  const scopeAEffectivePeriodGroup = (group: { primary: any }): boolean => {
    if (scopeACleanupDates) return true;
    const sd = params.start_date ? String(params.start_date) : null;
    const ed = params.end_date ? String(params.end_date) : null;
    const primary = group.primary;
    const effectiveDate = (primary.reservation_cancelled_at
      && (primary.reservation_status === 'CANCELLED' || primary.reservation_stay_status === 'CANCELLED'))
      ? primary.reservation_cancelled_at?.toISOString?.().slice(0, 10) || primary.reservation_cancelled_at?.slice?.(0, 10)
      : undefined;
    return isLifecyclePrimaryInPeriod(effectiveDate || primary.transaction_date, sd, ed);
  };
  const scopeAFilteredGroups = scopeAGroupedAll.filter(scopeAEffectivePeriodGroup);

  // Present canonical primary, then BID grouping.
  const scopeAPresentedAll = scopeAFilteredGroups.map((group) => presentLifecyclePrimary(group)).sort(comparePresentedListRows);
  const scopeASaleBidGrouped = presentListWithSaleBidGrouping(scopeAPresentedAll, {
    lifecycleReservations: await loadBookingReservationLifecycle(pool, propertyId, scopeAPresentedAll.map(p => p.reservation_id).filter(Boolean)),
  });
  const scopeAListSource = scopeASaleBidGrouped || scopeAPresentedAll;

  const globalSummary: TransactionSummary = {
    total_sale: scopeAListSource
      .filter((row: any) => String(row.transaction_type).toUpperCase() === 'SALE')
      .reduce((sum, row: any) => sum + (row.booking_bid_group?.net != null ? Number(row.booking_bid_group.net || 0) : Number(row.effective_net_amount || 0)), 0),
    total_purchase: scopeAListSource
      .filter((row: any) => String(row.transaction_type).toUpperCase() === 'PURCHASE' && String(row.operational_sheet || row.sheet || '').toUpperCase() === 'SELESAI')
      .reduce((sum, row: any) => sum + Number(row.effective_net_amount || 0), 0),
    total_expense: scopeAListSource
      .filter((row: any) => String(row.transaction_type).toUpperCase() === 'EXPENSE' && String(row.operational_sheet || row.sheet || '').toUpperCase() === 'SELESAI')
      .reduce((sum, row: any) => sum + Number(row.effective_net_amount || 0), 0),
    total_income: scopeAListSource
      .filter((row: any) => String(row.transaction_type).toUpperCase() === 'INCOME' && String(row.operational_sheet || row.sheet || '').toUpperCase() === 'SELESAI')
      .reduce((sum, row: any) => sum + Number(row.effective_net_amount || 0), 0),
    count_sale: scopeAListSource.filter((row: any) => String(row.transaction_type).toUpperCase() === 'SALE').length,
    count_purchase: scopeAListSource.filter((row: any) => String(row.transaction_type).toUpperCase() === 'PURCHASE' && String(row.operational_sheet || row.sheet || '').toUpperCase() === 'SELESAI').length,
    count_expense: scopeAListSource.filter((row: any) => String(row.transaction_type).toUpperCase() === 'EXPENSE' && String(row.operational_sheet || row.sheet || '').toUpperCase() === 'SELESAI').length,
    count_income: scopeAListSource.filter((row: any) => String(row.transaction_type).toUpperCase() === 'INCOME' && String(row.operational_sheet || row.sheet || '').toUpperCase() === 'SELESAI').length,
  };

  const scopeAActiveListSource = scopeAListSource.filter(
    (row: any) => String(row.operational_sheet || row.sheet || '').toUpperCase() !== 'BATAL'
  );
  const activeSummary: TransactionSummary = {
    total_sale: scopeAActiveListSource
      .filter((row: any) => String(row.transaction_type).toUpperCase() === 'SALE')
      .reduce((sum, row: any) => sum + (row.booking_bid_group?.net != null ? Number(row.booking_bid_group.net || 0) : Number(row.effective_net_amount || 0)), 0),
    total_purchase: scopeAActiveListSource
      .filter((row: any) => String(row.transaction_type).toUpperCase() === 'PURCHASE' && String(row.operational_sheet || row.sheet || '').toUpperCase() === 'SELESAI')
      .reduce((sum, row: any) => sum + Number(row.effective_net_amount || 0), 0),
    total_expense: scopeAActiveListSource
      .filter((row: any) => String(row.transaction_type).toUpperCase() === 'EXPENSE' && String(row.operational_sheet || row.sheet || '').toUpperCase() === 'SELESAI')
      .reduce((sum, row: any) => sum + Number(row.effective_net_amount || 0), 0),
    total_income: scopeAActiveListSource
      .filter((row: any) => String(row.transaction_type).toUpperCase() === 'INCOME' && String(row.operational_sheet || row.sheet || '').toUpperCase() === 'SELESAI')
      .reduce((sum, row: any) => sum + Number(row.effective_net_amount || 0), 0),
    count_sale: scopeAActiveListSource.filter((row: any) => String(row.transaction_type).toUpperCase() === 'SALE').length,
    count_purchase: scopeAActiveListSource.filter((row: any) => String(row.transaction_type).toUpperCase() === 'PURCHASE' && String(row.operational_sheet || row.sheet || '').toUpperCase() === 'SELESAI').length,
    count_expense: scopeAActiveListSource.filter((row: any) => String(row.transaction_type).toUpperCase() === 'EXPENSE' && String(row.operational_sheet || row.sheet || '').toUpperCase() === 'SELESAI').length,
    count_income: scopeAActiveListSource.filter((row: any) => String(row.transaction_type).toUpperCase() === 'INCOME' && String(row.operational_sheet || row.sheet || '').toUpperCase() === 'SELESAI').length,
  };

  // HAPUS path: explicit condition builder (NO regex placeholder renumbering).
  // Same Scope B definition powers count, total_count, and table rows.
  if (targetSheet === 'HAPUS') {
    const { conditions: hapusConds, values: hapusVals } = buildHapusConditionsAndValues(params, propertyId);
    const hIdx = hapusVals.length + 1;
    const hapusList = await pool.query(
      `${listSelectSql}
       WHERE ${hapusConds.join(' AND ')}
       ORDER BY t.transaction_date DESC, t.transaction_time DESC, t.id DESC
       LIMIT $${hIdx} OFFSET $${hIdx + 1}`,
      [...hapusVals, limit, offset]
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
      global_summary: globalSummary,
      active_summary: activeSummary,
      sheet_counts: {
        proses: sheet_counts.proses,
        selesai: sheet_counts.selesai,
        batal: sheet_counts.batal,
        hapus: hapusCount,
        ...(params.includePiutangCount ? { piutang: piutangCount } : {}),
      },
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

  const presented = [...(targetSheet === 'PIUTANG'
    ? listSource.filter(isPiutangPresentedRow)
    : targetSheet === 'SELESAI'
      ? listSource.filter((row: any) => row.operational_sheet === 'SELESAI' && !isPiutangPresentedRow(row))
      : targetSheet === 'PROSES' || targetSheet === 'BATAL'
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
    transactions: transactions,
    total_count: presented.length,
    summary,
    global_summary: globalSummary,
    active_summary: activeSummary,
    sheet_counts,
    limit,
    offset,
    list_fetch_stats: {
      mode: unboundedAllTime ? 'ALL_TIME' : 'PERIOD',
      fetched_transaction_rows: scopedRowCount,
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
  await ensureExpenseRecipientSchema(pool);
  const txRes = await pool.query(
    `SELECT t.*,
            s.name AS supplier_name,
            s.phone AS supplier_phone,
            s.bank_name AS supplier_bank_name,
            s.bank_account AS supplier_bank_account,
            s.bank_holder AS supplier_bank_holder,
            s.email AS supplier_email,
            COALESCE(NULLIF(BTRIM(t.recipient_email), ''), s.email) AS recipient_email,
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
              b.payment_responsibility as payment_responsibility,
              b.booking_source,
             b.channel as booking_channel,
             b.ota_source_id,
             ota.name AS ota_source_name,
             po_ref.po_number AS po_number,
             po_ref.status AS po_status,
             po_ref.order_date AS po_order_date,
             po_ref.total_amount AS po_total_amount,
             rev_orig.transaction_no as original_transaction_no,
            rev_repl.transaction_no as reversal_transaction_no,
    COALESCE(pmt.total_paid, 0) AS paid_amount,
              GREATEST(0, t.net_amount - COALESCE(pmt.total_paid, 0)) AS outstanding_amount
      FROM transactions t
       LEFT JOIN suppliers s ON s.id = t.supplier_id
       LEFT JOIN pos_purchase_orders po_ref ON po_ref.id = t.po_id AND po_ref.property_id = t.property_id
       LEFT JOIN reservations r ON r.id = t.reservation_id
       LEFT JOIN bookings b ON b.id = COALESCE(t.booking_id, r.booking_id)
       LEFT JOIN ota_sources ota ON ota.id = b.ota_source_id AND ota.property_id = b.property_id
       LEFT JOIN transactions rev_orig ON rev_orig.id = t.reversal_of_transaction_id
      LEFT JOIN transactions rev_repl ON rev_repl.reversal_of_transaction_id = t.id
      LEFT JOIN LATERAL (
        SELECT CASE
          WHEN UPPER(COALESCE(t.source_type, '')) IN ('POS_ORDER', 'POS') THEN
            COALESCE(
              (SELECT SUM(a.amount)::numeric
               FROM payment_transactions a
               WHERE a.transaction_id = t.id
                 AND a.status = 'SUCCESS'
                 AND a.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')), 0
            ) + COALESCE(
              (SELECT SUM(b2.amount)::numeric
               FROM pos_settlements b2
               WHERE b2.transaction_id = t.id
                 AND b2.property_id = t.property_id
                 AND b2.pos_order_id::text = t.source_id
                 AND b2.status = 'SUCCESS'), 0
            )
          ELSE
            COALESCE(
              (SELECT SUM(a.amount)::numeric
               FROM payment_transactions a
               WHERE (a.transaction_id = t.id OR (t.reservation_id IS NOT NULL AND a.reservation_id = t.reservation_id))
                 AND a.status = 'SUCCESS'
                 AND a.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')), 0
            )
        END AS total_paid
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
     `SELECT id::text, property_id, transaction_id::text, product_id::text,
             packaging_id::text, po_item_id::text, line_type, description_snapshot,
             quantity, unit, unit_price, discount_amount, line_total, sort_order,
             conversion_factor_snapshot, packaging_label_snapshot, created_at
      FROM transaction_lines
      WHERE transaction_id = $1 AND property_id = $2
      ORDER BY sort_order ASC, id ASC`,
     [id, propertyId]
   );

   let linkedGoodsReceipts: any[] = [];
   if (String(tx.transaction_type || '').toUpperCase() === 'PURCHASE' && linesRes.rows.length > 0) {
     try {
       const bindRes = await pool.query(
         `SELECT b.transaction_line_id, b.po_item_id, b.received_quantity, b.packaging_id, b.line_type,
                 b.conversion_factor_snapshot AS binding_conversion_factor_snapshot,
                 b.packaging_label_snapshot AS binding_packaging_label_snapshot,
                 tl_s.conversion_factor_snapshot AS line_conversion_factor_snapshot,
                 tl_s.packaging_label_snapshot AS line_packaging_label_snapshot,
                 poi.received_qty AS po_item_received_qty, poi.ordered_qty AS po_item_ordered_qty, poi.unit_cost AS po_item_unit_cost,
                 poi.packaging_id AS po_item_packaging_id, poi.conversion_factor_snapshot AS po_item_conversion_factor_snapshot,
                 ppc_b.to_base_factor AS binding_to_base_factor,
                 ppc_poi.to_base_factor AS po_item_to_base_factor
          FROM stock_purchase_line_bindings b
          LEFT JOIN transaction_lines tl_s
            ON tl_s.id = b.transaction_line_id
           AND tl_s.property_id = b.property_id
          LEFT JOIN pos_purchase_order_items poi
            ON poi.id = b.po_item_id
           AND poi.property_id = b.property_id
          LEFT JOIN product_packaging_conversions ppc_b
            ON ppc_b.id = b.packaging_id
           AND ppc_b.property_id = b.property_id
          LEFT JOIN product_packaging_conversions ppc_poi
            ON ppc_poi.id = poi.packaging_id
           AND ppc_poi.property_id = b.property_id
          WHERE b.transaction_id = $1 AND b.property_id = $2`,
         [id, propertyId]
       );
       const grnRes = await pool.query(
         `SELECT gri.transaction_line_id, gri.po_item_id, gri.packaging_id,
                 gri.received_qty, gri.base_quantity, gri.conversion_factor_snapshot,
                 ppc_gri.to_base_factor AS gri_to_base_factor
          FROM pos_goods_receipt_items gri
          JOIN pos_goods_receipts gr ON gr.id = gri.receipt_id
          LEFT JOIN product_packaging_conversions ppc_gri
            ON ppc_gri.id = gri.packaging_id
           AND ppc_gri.property_id = gr.property_id
          WHERE gr.property_id = $2
            AND gr.status IN ('POSTED', 'COMPLETED')
            AND (gr.transaction_id = $1 OR ($3::bigint IS NOT NULL AND gr.po_id = $3::bigint))`,
         [id, propertyId, tx.po_id ? Number(tx.po_id) : null]
       );
       const pMap = new Map<number, any>();
       for (const b of bindRes.rows) {
         pMap.set(Number(b.transaction_line_id), b);
       }
       for (const row of linesRes.rows) {
         const lid = Number(row.id);
         const b = pMap.get(lid);
         const pid = row.po_item_id ? Number(row.po_item_id) : (b?.po_item_id ? Number(b.po_item_id) : 0);
         const linePkgId = row.packaging_id != null ? Number(row.packaging_id) : (b?.packaging_id != null ? Number(b.packaging_id) : null);
         const poPkgId = b?.po_item_packaging_id != null ? Number(b.po_item_packaging_id) : null;
         const poSnapFactor = Number(b?.po_item_conversion_factor_snapshot || 0);
         const poFactor: number | null = poPkgId != null
           ? (poSnapFactor > 0 ? poSnapFactor : null)
           : 1;
         const snapLineFactor = Number(
           b?.binding_conversion_factor_snapshot ||
           b?.line_conversion_factor_snapshot ||
           row.conversion_factor_snapshot ||
           0
         );

         // Consensus snapshot from posted GRNs using the exact same packaging as this line
         let grnConsensusFactor: number | null = null;
         if (linePkgId != null) {
           const matchingFactors: number[] = [];
           for (const g of grnRes.rows) {
             const gLid = g.transaction_line_id ? Number(g.transaction_line_id) : 0;
             const gPid = g.po_item_id ? Number(g.po_item_id) : 0;
             const gPkgId = g.packaging_id != null ? Number(g.packaging_id) : null;
             const gSnap = Number(g.conversion_factor_snapshot || 0);
             if (
               gPkgId === linePkgId &&
               gSnap > 0 &&
               (gLid === lid || (pid > 0 && gPid === pid))
             ) {
               matchingFactors.push(gSnap);
             }
           }
           if (matchingFactors.length > 0) {
             const minF = Math.min(...matchingFactors);
             const maxF = Math.max(...matchingFactors);
             if (Math.abs(minF - maxF) <= 1e-6) {
               grnConsensusFactor = minF;
             }
           }
         }

         const verifiedLineFactor: number | null = linePkgId != null
           ? (snapLineFactor > 0
               ? snapLineFactor
               : (linePkgId === poPkgId && poSnapFactor > 0
                   ? poSnapFactor
                   : grnConsensusFactor))
           : 1;

         let poRecvInLineUnit = 0;
         let unverifiedReceivedBaseQty = 0;
         if (b && b.po_item_received_qty != null) {
           const rawPoRecv = Number(b.po_item_received_qty || 0);
           if (linePkgId === poPkgId) {
             poRecvInLineUnit = rawPoRecv;
           } else if (poFactor != null && poFactor > 0) {
             const poRecvBase = rawPoRecv * (poPkgId != null ? poFactor : 1);
             if (linePkgId == null) {
               poRecvInLineUnit = poRecvBase;
             } else if (verifiedLineFactor != null && verifiedLineFactor > 0) {
               poRecvInLineUnit = poRecvBase / verifiedLineFactor;
             } else {
               unverifiedReceivedBaseQty = Math.max(unverifiedReceivedBaseQty, poRecvBase);
             }
           }
         }

         let grnRecvInLineUnit = 0;
         let grnRawBaseTotal = 0;
         for (const g of grnRes.rows) {
           const gLid = g.transaction_line_id ? Number(g.transaction_line_id) : 0;
           const gPid = g.po_item_id ? Number(g.po_item_id) : 0;
           if (gLid === lid || (gLid === 0 && pid > 0 && gPid === pid) || (pid > 0 && gPid === pid)) {
             const gPkgId = g.packaging_id != null ? Number(g.packaging_id) : null;
             const gSnapFactor = Number(g.conversion_factor_snapshot || 0);
             const gVerifiedFactor: number | null = gPkgId != null
               ? (gSnapFactor > 0 ? gSnapFactor : null)
               : 1;
             const gBase = Number(g.base_quantity || 0) > 0
               ? Number(g.base_quantity)
               : (gVerifiedFactor != null && gVerifiedFactor > 0
                   ? Number(g.received_qty || 0) * gVerifiedFactor
                   : 0);
             grnRawBaseTotal += gBase;
             if (linePkgId != null && gPkgId === linePkgId) {
               grnRecvInLineUnit += Number(g.received_qty || 0);
             } else if (linePkgId == null) {
               grnRecvInLineUnit += gBase;
             } else if (verifiedLineFactor != null && verifiedLineFactor > 0) {
               grnRecvInLineUnit += gBase / verifiedLineFactor;
             }
           }
         }
         if (linePkgId != null && verifiedLineFactor == null) {
           unverifiedReceivedBaseQty = Math.max(unverifiedReceivedBaseQty, grnRawBaseTotal);
         }

         row.received_quantity = Math.max(
           Number(b?.received_quantity || 0),
           poRecvInLineUnit,
           grnRecvInLineUnit
         );
         row.remaining_quantity = Math.max(
           0,
           Number(row.quantity || b?.ordered_quantity || 0) - Number(row.received_quantity || 0)
         );
         row.conversion_factor_snapshot = verifiedLineFactor;
         row.conversion_factor_unresolved = linePkgId != null && verifiedLineFactor == null;
         row.unverified_received_base_qty = unverifiedReceivedBaseQty;
         if (b?.binding_packaging_label_snapshot || b?.line_packaging_label_snapshot) {
           row.packaging_label_snapshot = b?.binding_packaging_label_snapshot || b?.line_packaging_label_snapshot;
         }
         if (!row.po_item_id && b?.po_item_id) {
           row.po_item_id = String(b.po_item_id);
         }
         if (!row.packaging_id && b?.packaging_id) {
           row.packaging_id = String(b.packaging_id);
         }
         if (!row.line_type) {
           row.line_type = b?.line_type || (row.product_id ? 'STOCK' : 'NON_STOCK');
         }
         if (b?.po_item_ordered_qty !== undefined && b?.po_item_ordered_qty !== null) {
           row.po_ordered_quantity = Number(b.po_item_ordered_qty);
         }
         if (b?.po_item_unit_cost !== undefined && b?.po_item_unit_cost !== null) {
           row.po_unit_cost = Number(b.po_item_unit_cost);
         }
       }

       const grnListRes = await pool.query(
         `SELECT gr.id, gr.grn_number, gr.po_id, gr.transaction_id, gr.receipt_date, gr.status,
                 gr.total_amount, gr.invoice_no, gr.invoice_no AS invoice_reference, gr.received_by, gr.posted_at, gr.created_at,
                 sl.name AS location_name
            FROM pos_goods_receipts gr
            LEFT JOIN stock_locations sl ON sl.id = gr.location_id AND sl.property_id = gr.property_id
           WHERE gr.property_id = $2
             AND (gr.transaction_id = $1 OR ($3::bigint IS NOT NULL AND gr.po_id = $3::bigint))
           ORDER BY gr.receipt_date DESC, gr.id DESC`,
         [id, propertyId, tx.po_id ? Number(tx.po_id) : null]
       );
       linkedGoodsReceipts = grnListRes.rows;
     } catch {
       // Ignore if tables are missing in unit test mocks
     }
   }

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
    //
    // For POS_ORDER / POS source types:
    //   - linked_payments = pos_settlements (via transaction_id) +
    //                       payment_transactions that directly reference this SALE.
    //   - Do NOT use reservation-based payment history (kamar).
    //
    // For all other source types with reservation_id > 0:
    //   - Canonical reservation payment history (kamar + booking_group allocations).
    //
    // For non-reservation, non-POS:
    //   - payment_transactions WHERE transaction_id = t.id (non-folio linked).
    const srcType = String(tx.source_type || '').toUpperCase();
    const isPosSource = srcType === 'POS_ORDER' || srcType === 'POS';
    const isResLinked = tx.reservation_id != null && Number(tx.reservation_id) > 0;

    let pmtRes: any;
    let posSettlements: any[] = [];
    let posOrderItems: any[] = [];
    if (isPosSource) {
      if (tx.source_id && /^\d+$/.test(String(tx.source_id).trim())) {
        const poiRes = await pool.query(
          `SELECT poi.id,
                  poi.menu_item_id,
                  COALESCE(pmi.name, 'Item POS') AS item_name,
                  COALESCE(pmi.item_code, '') AS item_code,
                  poi.quantity,
                  poi.unit_price,
                  0 AS discount_amount,
                  poi.notes
           FROM pos_order_items poi
           JOIN pos_orders po ON po.id = poi.order_id
           LEFT JOIN pos_menu_items pmi ON pmi.id = poi.menu_item_id AND pmi.property_id = $1
           WHERE po.property_id = $1 AND po.id = $2
           ORDER BY poi.id ASC`,
          [propertyId, Number(String(tx.source_id).trim())]
        );
        posOrderItems = poiRes.rows;
      }
      // ── POS: settlement + legacy payment yang langsung menunjuk SALE ──
      // pos_settlements: pembayaran POS yang tercatat di tabel terpisah.
      const psRes = await pool.query(
        `SELECT id::text AS settlement_id,
                property_id,
                pos_order_id::text AS pos_order_id,
                transaction_id::text AS sale_id,
                amount,
                payment_method,
                status AS settlement_status,
                created_by,
                created_at
         FROM pos_settlements
         WHERE property_id = $1
           AND transaction_id::text = $2
           AND pos_order_id::text = $3
           AND status = 'SUCCESS'
         ORDER BY id ASC`,
        [propertyId, String(id), String(tx.source_id)]
      );
      posSettlements = psRes.rows;

      // Legacy payment_transactions yang LANGSUNG menunjuk SALE POS
      // (bukan berdasarkan reservation_id).
      const legacyPmtRes = await pool.query(
        `SELECT id::text AS payment_id,
                transaction_id::text AS linked_tx_id,
                reservation_id::text AS res_id,
                booking_id::text AS booking_id,
                scope,
                transaction_type,
                amount,
                payment_method,
                reference_code,
                status AS pt_status,
                property_id,
                created_by,
                created_at
         FROM payment_transactions
         WHERE property_id = $1
           AND transaction_id::text = $2
         ORDER BY id ASC`,
        [propertyId, String(id)]
      );
      // Merge: prefix ID agar settlement_id dan payment_id tidak bertabrakan.
      // Settlement: key = 'ps:<id>', Payment: key = 'pt:<id>'
      const mergedPayments = [
        ...posSettlements.map((s: any) => ({
          id: `ps:${s.settlement_id}`,
          source: 'POS_SETTLEMENT' as const,
          settlement_id: Number(s.settlement_id),
          pos_order_id: s.pos_order_id ? Number(s.pos_order_id) : null,
          amount: s.amount,
          payment_method: s.payment_method,
          reference_code: null as string | null,
          status: s.settlement_status,
          created_by: s.created_by,
          created_at: s.created_at,
        })),
        ...legacyPmtRes.rows.map((p: any) => ({
          id: `pt:${p.payment_id}`,
          source: 'PAYMENT_TRANSACTION' as const,
          payment_id: Number(p.payment_id),
          scope: p.scope,
          transaction_type: p.transaction_type,
          amount: p.amount,
          payment_method: p.payment_method,
          reference_code: p.reference_code,
          status: p.pt_status,
          created_by: p.created_by,
          created_at: p.created_at,
        })),
      ];
      pmtRes = { rows: mergedPayments };
    } else if (isResLinked) {
      // ── Non-POS reservation-linked: kamar payment history (existing) ──
      const resId = Number(tx.reservation_id);
      pmtRes = await pool.query(
        `SELECT id, reservation_id, transaction_type, amount, payment_method, reference_code, status,
                reference_payment_id, correction_group_id, reason_code, reason_text,
                created_by, created_at, booking_id, scope, property_id
         FROM payment_transactions
         WHERE reservation_id = $1
           AND scope = 'ROOM_RESERVATION'
           AND (property_id = $2 OR property_id IS NULL)
           AND transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
         UNION ALL
         SELECT pt.id, pt.reservation_id, pt.transaction_type, pa.allocated_amount AS amount,
                pt.payment_method, pt.reference_code, pt.status,
                pt.reference_payment_id, pt.correction_group_id, pt.reason_code, pt.reason_text,
                pt.created_by, pt.created_at, pt.booking_id, pt.scope, pt.property_id
         FROM payment_transactions pt
         JOIN payment_allocations pa ON pa.payment_transaction_id = pt.id
         WHERE pt.scope = 'BOOKING_GROUP'
           AND pt.property_id = $2
           AND pa.reservation_id = $1
           AND pa.property_id = $2
           AND pa.status = 'ACTIVE'
           AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
         ORDER BY id DESC`,
        [resId, propertyId]
      );
    } else {
      // ── Non-POS, non-reservation: transaction-linked payment ──
      pmtRes = await pool.query(
        `SELECT id, transaction_type, amount, payment_method, reference_code, status, created_by, created_at
         FROM payment_transactions
         WHERE transaction_id = $1 AND property_id = $2
         ORDER BY created_at DESC`,
        [id, propertyId]
      );
    }

    // UI-3: Canonical hotel collectible balance for reservation-linked transactions.
    // Delegates to the neutral reservationFinancialCalculator.
    // Fail-closed: if the calculator throws, the error propagates — no legacy fallback.
    // For POS_ORDER/POS: NOT populated — pos_settlements is a separate payment
    // domain, not a component of the room collectible balance.
    let canonicalHotelCollectible: any = null;
    if (isResLinked && !isPosSource) {
      const resId = Number(tx.reservation_id);
      const paymentResponsibility = String(tx.payment_responsibility || 'HOTEL_COLLECT');
      canonicalHotelCollectible = await calculateHotelCollectibleBalance(
        pool, resId, propertyId, paymentResponsibility
      );
    }

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
    operational_sheet: applyAuditOverlay(tx, deriveOperationalSheet(tx)),
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
    linked_goods_receipts: linkedGoodsReceipts,
    // POS settlements as a separate field — frontend can display them
    // distinctly from legacy payment_transactions.
    pos_settlements: posSettlements,
    pos_order_items: posOrderItems,
    audit_logs: auditRes.rows,
    // UI-3: Canonical hotel collectible balance fields (top-level for frontend convenience)
    // For POS_ORDER/POS: canonicalHotelCollectible is NOT populated —
    // it is a room-balance concept, not a POS concept.
    ...(canonicalHotelCollectible || {}),
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
    fileData?: Buffer | null;
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

  if (purpose === 'PAYMENT_PROOF' && attachment.fileData) {
    await pool.query(
      `UPDATE transaction_attachments
       SET file_name = $3,
           original_name = $4,
           mime_type = $5,
           file_size = $6,
           storage_path = $7,
           file_data = $8
       WHERE property_id = $1
         AND transaction_id = $2
         AND attachment_purpose = 'PAYMENT_PROOF'
         AND file_data IS NULL`,
      [
        propertyId,
        transactionId,
        attachment.fileName,
        attachment.originalName,
        attachment.mimeType,
        attachment.fileSize,
        attachment.storagePath,
        attachment.fileData,
      ]
    );
  }

  const insertRes = await pool.query(
    `INSERT INTO transaction_attachments (
      property_id, transaction_id, file_name, original_name,
      mime_type, file_size, storage_path, uploaded_by, attachment_purpose, file_data
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6, $7, $8, $9, $10
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
      purpose,
      attachment.fileData || null
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

/**
 * Permanently deletes (hard-deletes) a transaction and all underlying booking/reservation/POS/folio records,
 * while first restoring any Minibar stock, POS stock, Loyalty points, and room availability.
 * Ensures the deleted record completely disappears from Pusat Transaksi, Kalender, and Laporan.
 */
export async function hardDeleteTransaction(
  pool: Pool,
  propertyId: number,
  id: number | string,
  options?: { actorName?: string; actorUserId?: string | number | null }
): Promise<{ deleted_transaction_id: number; deleted_booking_id: number | null; deleted_reservation_ids: number[]; deleted_pos_order_ids: number[] }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const txRes = await client.query(
      `SELECT * FROM transactions WHERE id = $1 AND property_id = $2 FOR UPDATE`,
      [id, propertyId]
    );
    if ((txRes.rowCount ?? 0) === 0) {
      await client.query('COMMIT');
      return {
        deleted_transaction_id: Number(id) || 0,
        deleted_booking_id: null,
        deleted_reservation_ids: [],
        deleted_pos_order_ids: [],
      };
    }

    const tx = txRes.rows[0];
    const actorName = options?.actorName || 'Staff';
    const actorUserId = options?.actorUserId ? String(options.actorUserId) : null;

    const safeExec = async (sql: string, params: any[] = []) => {
      await client.query('SAVEPOINT sp_hard_del');
      try {
        await client.query(sql, params);
        await client.query('RELEASE SAVEPOINT sp_hard_del');
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_hard_del');
      }
    };

    const safeCall = async (fn: () => Promise<any>) => {
      await client.query('SAVEPOINT sp_hard_call');
      try {
        await fn();
        await client.query('RELEASE SAVEPOINT sp_hard_call');
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_hard_call');
      }
    };

    const deletedReservationIds: number[] = [];
    const deletedPosOrderIds: number[] = [];
    let targetBookingId: number | null = tx.booking_id ? Number(tx.booking_id) : null;

    if (!targetBookingId && tx.reservation_id) {
      const rLookup = await client.query(
        `SELECT booking_id FROM reservations WHERE id = $1`,
        [Number(tx.reservation_id)]
      );
      if ((rLookup.rowCount ?? 0) > 0 && rLookup.rows[0].booking_id) {
        targetBookingId = Number(rLookup.rows[0].booking_id);
      }
    }

    if (targetBookingId || tx.reservation_id) {
      // Collect all reservations belonging to this booking (or single reservation)
      const resRowsResult = targetBookingId
        ? await client.query(
            `SELECT r.id, r.status, r.stay_type, r.room_id, r.booked_room_type_id_snapshot,
                    rm.room_type_id AS current_room_type_id,
                    to_char(r.check_in::date, 'YYYY-MM-DD') AS check_in_key,
                    to_char(r.check_out::date, 'YYYY-MM-DD') AS check_out_key
               FROM reservations r
               LEFT JOIN rooms rm ON rm.id = r.room_id
              WHERE r.booking_id = $1
              FOR UPDATE OF r`,
            [targetBookingId]
          )
        : await client.query(
            `SELECT r.id, r.status, r.stay_type, r.room_id, r.booked_room_type_id_snapshot,
                    rm.room_type_id AS current_room_type_id,
                    to_char(r.check_in::date, 'YYYY-MM-DD') AS check_in_key,
                    to_char(r.check_out::date, 'YYYY-MM-DD') AS check_out_key
               FROM reservations r
               LEFT JOIN rooms rm ON rm.id = r.room_id
              WHERE r.id = $1
              FOR UPDATE OF r`,
            [Number(tx.reservation_id)]
          );

      const affectedRoomIds = new Set<number>();
      const affectedRoomTypeRanges: Array<{ roomTypeId: number; checkIn: string; checkOut: string }> = [];

      for (const r of resRowsResult.rows) {
        const resId = Number(r.id);
        deletedReservationIds.push(resId);
        if (r.room_id) affectedRoomIds.add(Number(r.room_id));
        const rtId = Number(r.current_room_type_id || r.booked_room_type_id_snapshot || 0);
        if (rtId > 0 && r.check_in_key && r.check_out_key && r.check_in_key < r.check_out_key) {
          affectedRoomTypeRanges.push({
            roomTypeId: rtId,
            checkIn: String(r.check_in_key),
            checkOut: String(r.check_out_key),
          });
        }
        if (
          r.booked_room_type_id_snapshot &&
          Number(r.booked_room_type_id_snapshot) !== rtId &&
          r.check_in_key &&
          r.check_out_key &&
          r.check_in_key < r.check_out_key
        ) {
          affectedRoomTypeRanges.push({
            roomTypeId: Number(r.booked_room_type_id_snapshot),
            checkIn: String(r.check_in_key),
            checkOut: String(r.check_out_key),
          });
        }
      }

      if (tx.reservation_id && !deletedReservationIds.includes(Number(tx.reservation_id))) {
        deletedReservationIds.push(Number(tx.reservation_id));
      }

      // 1. Restore Minibar stock, POS stock, and Loyalty points for every reservation
      for (const resId of deletedReservationIds) {
        await safeCall(() =>
          restoreAllReservationEffectsOnCancelOrVoid({
            client,
            propertyId,
            reservationId: resId,
            actorUserId,
            actorName,
          })
        );
      }

      // 2. Find and hard-delete any POS orders linked to these reservations
      if (deletedReservationIds.length > 0) {
        const posRes = await client.query(
          `SELECT id, status FROM pos_orders WHERE reservation_id = ANY($1::int[])`,
          [deletedReservationIds]
        );
        for (const po of posRes.rows) {
          const poId = Number(po.id);
          deletedPosOrderIds.push(poId);
          if (!['VOIDED', 'CANCELLED'].includes(String(po.status || '').toUpperCase())) {
            await safeCall(() =>
              restoreStockForPosOrderVoid({
                client,
                propertyId,
                orderId: poId,
                actorUserId,
                actorName,
              })
            );
          }
        }
      }

      if (deletedPosOrderIds.length > 0) {
        const posIdStrings = [
          ...deletedPosOrderIds.map(String),
          ...deletedPosOrderIds.map((idNum) => `REV-${idNum}`),
        ];
        await safeExec(`DELETE FROM pos_complimentary_usages WHERE pos_order_id = ANY($1::int[])`, [deletedPosOrderIds]);
        await safeExec(`DELETE FROM pos_order_edit_requests WHERE order_id = ANY($1::int[])`, [deletedPosOrderIds]);
        await safeExec(`DELETE FROM pos_settlements WHERE order_id = ANY($1::int[])`, [deletedPosOrderIds]);
        await safeExec(`DELETE FROM pos_order_items WHERE order_id = ANY($1::int[])`, [deletedPosOrderIds]);
        await safeExec(
          `UPDATE transactions SET reversal_of_transaction_id = NULL
            WHERE property_id = $1 AND source_type IN ('POS', 'POS_ORDER') AND source_id = ANY($2::text[])`,
          [propertyId, posIdStrings]
        );
        await safeExec(
          `DELETE FROM transactions WHERE property_id = $1 AND source_type IN ('POS', 'POS_ORDER') AND source_id = ANY($2::text[])`,
          [propertyId, posIdStrings]
        );
        await safeExec(`DELETE FROM pos_orders WHERE id = ANY($1::int[])`, [deletedPosOrderIds]);
      }

      // 3. Delete all child records of reservations & booking in FK order
      if (deletedReservationIds.length > 0 || targetBookingId !== null) {
        await safeExec(
          `UPDATE deposit_events SET reversal_of_event_id = NULL
            WHERE reservation_id = ANY($1::int[])
               OR deposit_id IN (SELECT id FROM deposits WHERE reservation_id = ANY($1::int[]) OR ($2::bigint IS NOT NULL AND booking_id = $2))
               OR payment_transaction_id IN (SELECT id FROM payment_transactions WHERE reservation_id = ANY($1::int[]) OR ($2::bigint IS NOT NULL AND booking_id = $2))
               OR folio_entry_id IN (SELECT id FROM folio_entries WHERE reservation_id = ANY($1::int[]))`,
          [deletedReservationIds, targetBookingId]
        );
        await safeExec(
          `DELETE FROM deposit_events
            WHERE reservation_id = ANY($1::int[])
               OR deposit_id IN (SELECT id FROM deposits WHERE reservation_id = ANY($1::int[]) OR ($2::bigint IS NOT NULL AND booking_id = $2))
               OR payment_transaction_id IN (SELECT id FROM payment_transactions WHERE reservation_id = ANY($1::int[]) OR ($2::bigint IS NOT NULL AND booking_id = $2))
               OR folio_entry_id IN (SELECT id FROM folio_entries WHERE reservation_id = ANY($1::int[]))`,
          [deletedReservationIds, targetBookingId]
        );
        await safeExec(
          `DELETE FROM deposits WHERE reservation_id = ANY($1::int[]) OR ($2::bigint IS NOT NULL AND booking_id = $2)`,
          [deletedReservationIds, targetBookingId]
        );
        await safeExec(
          `DELETE FROM identity_custody WHERE reservation_id = ANY($1::int[]) OR ($2::bigint IS NOT NULL AND booking_id = $2)`,
          [deletedReservationIds, targetBookingId]
        );
        await safeExec(
          `DELETE FROM payment_evidences
            WHERE reservation_id = ANY($1::int[])
               OR payment_transaction_id IN (
                 SELECT id FROM payment_transactions
                  WHERE reservation_id = ANY($1::int[])
                     OR ($2::bigint IS NOT NULL AND booking_id = $2)
               )`,
          [deletedReservationIds, targetBookingId]
        );
        await safeExec(
          `DELETE FROM payment_allocations WHERE reservation_id = ANY($1::int[]) OR ($2::bigint IS NOT NULL AND booking_id = $2)`,
          [deletedReservationIds, targetBookingId]
        );
        await safeExec(`DELETE FROM guest_receivables WHERE reservation_id = ANY($1::int[])`, [deletedReservationIds]);
        await safeExec(`DELETE FROM reservation_complimentary_requests WHERE reservation_id = ANY($1::int[])`, [deletedReservationIds]);
        await safeExec(`DELETE FROM reservation_special_requests WHERE reservation_id = ANY($1::int[])`, [deletedReservationIds]);
        await safeExec(`DELETE FROM reservation_room_moves WHERE reservation_id = ANY($1::int[])`, [deletedReservationIds]);
        await safeExec(`DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1::int[])`, [deletedReservationIds]);
        await safeExec(`DELETE FROM reservation_guests WHERE reservation_id = ANY($1::int[])`, [deletedReservationIds]);
        await safeExec(`DELETE FROM availability_locks WHERE reservation_id = ANY($1::int[])`, [deletedReservationIds]);
        await safeExec(`DELETE FROM housekeeping_findings WHERE reservation_id = ANY($1::int[])`, [deletedReservationIds]);
        await safeExec(`DELETE FROM housekeeping_tasks WHERE reservation_id = ANY($1::int[])`, [deletedReservationIds]);
        await safeExec(
          `UPDATE payment_transactions SET reference_payment_id = NULL
            WHERE reservation_id = ANY($1::int[])
               OR ($2::bigint IS NOT NULL AND booking_id = $2)
               OR reference_payment_id IN (
                 SELECT id FROM payment_transactions
                  WHERE reservation_id = ANY($1::int[]) OR ($2::bigint IS NOT NULL AND booking_id = $2)
               )`,
          [deletedReservationIds, targetBookingId]
        );
        await safeExec(
          `DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[]) OR ($2::bigint IS NOT NULL AND booking_id = $2)`,
          [deletedReservationIds, targetBookingId]
        );
        await safeExec(
          `UPDATE folio_entries SET reversal_of_entry_id = NULL
            WHERE reservation_id = ANY($1::int[])
               OR reversal_of_entry_id IN (SELECT id FROM folio_entries WHERE reservation_id = ANY($1::int[]))`,
          [deletedReservationIds]
        );
        await safeExec(
          `DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])`,
          [deletedReservationIds]
        );
        await safeExec(
          `UPDATE pos_orders SET reservation_id = NULL WHERE reservation_id = ANY($1::int[])`,
          [deletedReservationIds]
        );
      }

      if (targetBookingId) {
        await safeExec(`DELETE FROM booking_change_requests WHERE booking_id = $1`, [targetBookingId]);
        await safeExec(`DELETE FROM booking_create_idempotency WHERE booking_id = $1`, [targetBookingId]);
        await safeExec(`DELETE FROM booking_create_requests WHERE booking_id = $1`, [targetBookingId]);
      }

      // 4. Delete all transactions linked to this booking, reservations, or target tx
      await safeExec(
        `UPDATE transactions
            SET reversal_of_transaction_id = NULL
          WHERE property_id = $1
            AND (
              id = $2
              OR reversal_of_transaction_id = $2
              OR ($3::bigint IS NOT NULL AND booking_id = $3)
              OR (Cardinality($4::int[]) > 0 AND reservation_id = ANY($4::int[]))
              OR reversal_of_transaction_id IN (
                SELECT id FROM transactions
                 WHERE property_id = $1
                   AND (
                     id = $2
                     OR ($3::bigint IS NOT NULL AND booking_id = $3)
                     OR (Cardinality($4::int[]) > 0 AND reservation_id = ANY($4::int[]))
                   )
              )
            )`,
        [propertyId, Number(tx.id), targetBookingId, deletedReservationIds]
      );
      await client.query(
        `DELETE FROM transactions
          WHERE property_id = $1
            AND (
              id = $2
              OR reversal_of_transaction_id = $2
              OR ($3::bigint IS NOT NULL AND booking_id = $3)
              OR (Cardinality($4::int[]) > 0 AND reservation_id = ANY($4::int[]))
            )`,
        [propertyId, Number(tx.id), targetBookingId, deletedReservationIds]
      );

      // 5. Delete reservations and booking
      if (deletedReservationIds.length > 0) {
        await safeExec(`DELETE FROM reservations WHERE id = ANY($1::int[])`, [deletedReservationIds]);
      }
      if (targetBookingId) {
        await safeExec(`DELETE FROM bookings WHERE id = $1 AND property_id = $2`, [targetBookingId, propertyId]);
      }

      // 6. Reconcile availability_dates for affected room types & date ranges
      for (const rng of affectedRoomTypeRanges) {
        await client.query(
          `UPDATE availability_dates ad
              SET reserved_qty = LEAST(
                ad.total_rooms,
                GREATEST(
                  0,
                  (
                    SELECT COUNT(*)::int
                      FROM reservations r
                      LEFT JOIN rooms rm ON rm.id = r.room_id
                     WHERE r.status IN ('BOOKED', 'CHECKED_IN')
                       AND COALESCE(r.stay_type, 'OVERNIGHT') <> 'DAY_USE'
                       AND COALESCE(rm.room_type_id, r.booked_room_type_id_snapshot) = ad.room_type_id
                       AND r.check_in::date <= ad.date::date
                       AND r.check_out::date > ad.date::date
                  )
                )
              )
            WHERE ad.room_type_id = $1
              AND ad.date >= $2::date
              AND ad.date < $3::date`,
          [rng.roomTypeId, rng.checkIn, rng.checkOut]
        );
      }

      // 7. Reset any vacated OCCUPIED_* room to VACANT_DIRTY if no active CHECKED_IN reservation remains
      for (const roomId of affectedRoomIds) {
        await client.query(
          `UPDATE rooms rm
              SET status = 'VACANT_DIRTY'
            WHERE rm.id = $1
              AND rm.property_id = $2
              AND rm.status IN ('OCCUPIED_CLEAN', 'OCCUPIED_DIRTY')
              AND NOT EXISTS (
                SELECT 1 FROM reservations r
                 WHERE r.room_id = rm.id
                   AND r.status = 'CHECKED_IN'
              )`,
          [roomId, propertyId]
        );
      }
    } else if (tx.source_type === 'POS_ORDER' || tx.source_type === 'POS') {
      const cleanPosSourceId = String(tx.source_id || '').replace(/^REV-/i, '').trim();
      const posOrderId = Number(cleanPosSourceId);
      if (Number.isInteger(posOrderId) && posOrderId > 0) {
        deletedPosOrderIds.push(posOrderId);
        await safeCall(() =>
          restoreStockForPosOrderVoid({
            client,
            propertyId,
            orderId: posOrderId,
            actorUserId,
            actorName,
          })
        );
        await safeExec(`DELETE FROM pos_complimentary_usages WHERE pos_order_id = $1`, [posOrderId]);
        await safeExec(`DELETE FROM pos_order_edit_requests WHERE order_id = $1`, [posOrderId]);
        await safeExec(`DELETE FROM pos_settlements WHERE order_id = $1`, [posOrderId]);
        await safeExec(`DELETE FROM pos_order_items WHERE order_id = $1`, [posOrderId]);
        await safeExec(`DELETE FROM folio_entries WHERE property_id = $1 AND source_type = 'POS_ORDER' AND source_id = $2`, [
          propertyId,
          String(posOrderId),
        ]);
        await safeExec(`DELETE FROM pos_orders WHERE id = $1 AND property_id = $2`, [posOrderId, propertyId]);
      }

      const posSourceIds = cleanPosSourceId ? [cleanPosSourceId, `REV-${cleanPosSourceId}`] : [String(tx.source_id || '')];
      await safeExec(
        `UPDATE transactions
            SET reversal_of_transaction_id = NULL
          WHERE property_id = $1
            AND (
              id = $2
              OR reversal_of_transaction_id = $2
              OR ($3::bigint IS NOT NULL AND id = $3)
              OR (source_type IN ('POS', 'POS_ORDER') AND source_id = ANY($4::text[]))
            )`,
        [propertyId, Number(tx.id), tx.reversal_of_transaction_id ? Number(tx.reversal_of_transaction_id) : null, posSourceIds]
      );
      await client.query(
        `DELETE FROM transactions
          WHERE property_id = $1
            AND (
              id = $2
              OR reversal_of_transaction_id = $2
              OR ($3::bigint IS NOT NULL AND id = $3)
              OR (source_type IN ('POS', 'POS_ORDER') AND source_id = ANY($4::text[]))
            )`,
        [propertyId, Number(tx.id), tx.reversal_of_transaction_id ? Number(tx.reversal_of_transaction_id) : null, posSourceIds]
      );
    } else {
      // Standalone PURCHASE, EXPENSE, INCOME, or manual SALE
      await safeExec(`DELETE FROM payment_transactions WHERE transaction_id = $1`, [Number(tx.id)]);
      await safeExec(`DELETE FROM transaction_attachments WHERE transaction_id = $1`, [Number(tx.id)]);
      await safeExec(`DELETE FROM transaction_lines WHERE transaction_id = $1`, [Number(tx.id)]);
      await safeExec(`UPDATE pos_goods_receipts SET transaction_id = NULL WHERE transaction_id = $1`, [Number(tx.id)]);
      await safeExec(
        `UPDATE transactions
            SET reversal_of_transaction_id = NULL
          WHERE property_id = $1
            AND (
              id = $2
              OR reversal_of_transaction_id = $2
              OR ($3::bigint IS NOT NULL AND id = $3)
              OR ($4::text IS NOT NULL AND correction_group_id = $4)
            )`,
        [
          propertyId,
          Number(tx.id),
          tx.reversal_of_transaction_id ? Number(tx.reversal_of_transaction_id) : null,
          tx.correction_group_id || null,
        ]
      );
      await client.query(
        `DELETE FROM transactions
          WHERE property_id = $1
            AND (
              id = $2
              OR reversal_of_transaction_id = $2
              OR ($3::bigint IS NOT NULL AND id = $3)
              OR ($4::text IS NOT NULL AND correction_group_id = $4)
            )`,
        [
          propertyId,
          Number(tx.id),
          tx.reversal_of_transaction_id ? Number(tx.reversal_of_transaction_id) : null,
          tx.correction_group_id || null,
        ]
      );
      if (tx.po_id) {
        const linkedPoId = Number(tx.po_id);
        await safeExec(
          `DELETE FROM pos_purchase_order_items
            WHERE po_id = $1
              AND NOT EXISTS (
                SELECT 1 FROM pos_goods_receipts gr
                 WHERE gr.po_id = $1 AND gr.status = 'POSTED'
              )`,
          [linkedPoId]
        );
        await safeExec(
          `DELETE FROM pos_purchase_orders
            WHERE id = $1 AND property_id = $2
              AND NOT EXISTS (
                SELECT 1 FROM pos_goods_receipts gr
                 WHERE gr.po_id = $1 AND gr.status = 'POSTED'
              )`,
          [linkedPoId, propertyId]
        );
      }
    }

    await client.query(
      `INSERT INTO audit_logs (
         module, action, entity, record_id, new_value, property_id
       ) VALUES (
         'TRANSACTIONS', 'TRANSACTION_HARD_DELETED', 'transactions', $1, $2, $3
       )`,
      [
        String(tx.id),
        JSON.stringify({
          transaction_no: tx.transaction_no,
          transaction_type: tx.transaction_type,
          booking_id: targetBookingId,
          deleted_reservation_ids: deletedReservationIds,
          deleted_pos_order_ids: deletedPosOrderIds,
          deleted_by: actorName,
          deleted_by_user_id: actorUserId,
        }),
        propertyId,
      ]
    );

    await client.query('COMMIT');
    return {
      deleted_transaction_id: Number(tx.id),
      deleted_booking_id: targetBookingId,
      deleted_reservation_ids: deletedReservationIds,
      deleted_pos_order_ids: deletedPosOrderIds,
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
  payment_status: string | null;
  po_id: number | string | null;
  deleted_at: string | null;
  receiving_status: string | null;
  verification_status: string | null;
  purchase_workflow_status: string | null;
  verified_by_user_id: string | null;
  verified_by_name_snapshot: string | null;
  verified_at: string | null;
  received_at: string | null;
  approval_status: string | null;
  approved_by_user_id: string | null;
  approved_by_name_snapshot: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
}

async function fetchLockedPurchase(
  client: any,
  propertyId: number,
  id: number | string
): Promise<LockedPurchaseRow> {
  const res = await client.query(
    `SELECT id, transaction_no, transaction_type, transaction_status,
            payment_status, po_id, deleted_at,
            receiving_status, verification_status, purchase_workflow_status,
            verified_by_user_id, verified_by_name_snapshot, verified_at, received_at,
            approval_status, approved_by_user_id, approved_by_name_snapshot, approved_at, rejection_reason
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
    approval_status?: string | null;
    approved_by_user_id?: string | null;
    approved_by_name_snapshot?: string | null;
    approved_at?: string | null;
    rejection_reason?: string | null;
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
    actionUpper !== 'SET_WORKFLOW' &&
    actionUpper !== 'SET_APPROVAL' &&
    actionUpper !== 'ARCHIVE' &&
    actionUpper !== 'UNARCHIVE'
  ) {
    const err: any = new Error(`Action '${action}' tidak valid untuk PURCHASE lifecycle`);
    err.statusCode = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const prev = await fetchLockedPurchase(client, propertyId, id);
    if (actionUpper !== 'SET_APPROVAL') {
      assertNonTerminal(prev.transaction_status);
    }

    if (prev.deleted_at) {
      const err: any = new Error(`Transaksi #${id} telah dihapus dan tidak dapat diubah.`);
      err.statusCode = 409;
      throw err;
    }

    let newReceiving: string | null = prev.receiving_status;
    let newVerification: string | null = prev.verification_status;
    let newWorkflow: string | null = prev.purchase_workflow_status;
    let newVerifiedByUserId: string | null = prev.verified_by_user_id;
    let newVerifiedByName: string | null = prev.verified_by_name_snapshot;
    let newVerifiedAt: string | null = prev.verified_at;
    let newReceivedAt: string | null = prev.received_at;
    let newApprovalStatus: string | null = prev.approval_status || 'PENDING_APPROVAL';
    let newApprovedByUserId: string | null = prev.approved_by_user_id;
    let newApprovedByName: string | null = prev.approved_by_name_snapshot;
    let newApprovedAt: string | null = prev.approved_at;
    let newRejectionReason: string | null = prev.rejection_reason;
    let newTransactionStatus: string = prev.transaction_status || 'POSTED';

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
      const canonicalRecv = await computeCanonicalStockReceivingStatus(client, propertyId, id, prev.received_at);
      if (canonicalRecv.hasStockLines) {
        const err: any = new Error(
          'Status penerimaan untuk pembelian barang stok dikendalikan secara otomatis melalui dokumen Penerimaan Barang (GRN) yang di-Post dan tidak dapat diubah manual.'
        );
        err.statusCode = 400;
        err.code = 'STOCK_RECEIVING_MANAGED_BY_GRN';
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
        newWorkflow = 'PROSES';
      } else if (v === 'REJECTED') {
        newWorkflow = 'PROSES';
      }
    } else if (actionUpper === 'SET_WORKFLOW') {
      const w = dto.workflow_status;
      if (!w || !['PROSES', 'SELESAI'].includes(w)) {
        const err: any = new Error(`workflow_status '${w}' tidak valid`);
        err.statusCode = 400;
        throw err;
      }
      newWorkflow = w;
    } else if (actionUpper === 'SET_APPROVAL') {
      const app = String(dto.approval_status || '').toUpperCase();
      if (!app || !['PENDING_APPROVAL', 'APPROVED', 'REJECTED'].includes(app)) {
        const err: any = new Error(`approval_status '${dto.approval_status}' tidak valid`);
        err.statusCode = 400;
        throw err;
      }
      if (app === 'REJECTED' && String(prev.payment_status || '').toUpperCase() === 'PAID') {
        const err: any = new Error('Pembelian yang sudah dibayar (PAID) tidak dapat ditolak. Gunakan Void jika ingin membatalkan.');
        err.statusCode = 409;
        throw err;
      }
      newApprovalStatus = app;
      const linkedPoId = prev.po_id ? Number(prev.po_id) : null;
      if (app === 'APPROVED') {
        newApprovedByUserId = actorUserId;
        newApprovedByName = actor;
        newApprovedAt = new Date().toISOString();
        newRejectionReason = null;
        if (newTransactionStatus === 'CANCELLED' || newTransactionStatus === 'VOIDED') {
          newTransactionStatus = 'POSTED';
        }
        if (linkedPoId && linkedPoId > 0) {
          await client.query(
            `UPDATE pos_purchase_orders
                SET status = CASE WHEN status IN ('DRAFT', 'PENDING_APPROVAL', 'REJECTED') THEN 'APPROVED' ELSE status END,
                    approval_status = 'APPROVED',
                    approved_by_user_id = $1,
                    approved_by_name_snapshot = $2,
                    approved_at = NOW(),
                    rejection_reason = NULL,
                    updated_at = NOW()
              WHERE id = $3 AND property_id = $4`,
            [actorUserId, actor, linkedPoId, propertyId]
          );
        }
      } else if (app === 'REJECTED') {
        const rejReason = reason || 'Pengajuan pembelian / PO ditolak oleh Akuntansi';
        newApprovedByUserId = actorUserId;
        newApprovedByName = actor;
        newApprovedAt = new Date().toISOString();
        newRejectionReason = rejReason;
        newTransactionStatus = 'CANCELLED';
        newVerification = 'UNVERIFIED';
        newVerifiedByUserId = null;
        newVerifiedByName = null;
        newVerifiedAt = null;
        if (linkedPoId && linkedPoId > 0) {
          await client.query(
            `UPDATE pos_purchase_orders
                SET status = 'REJECTED',
                    approval_status = 'REJECTED',
                    approved_by_user_id = $1,
                    approved_by_name_snapshot = $2,
                    approved_at = NOW(),
                    rejection_reason = $3,
                    updated_at = NOW()
              WHERE id = $4 AND property_id = $5`,
            [actorUserId, actor, rejReason, linkedPoId, propertyId]
          );
        }
      } else if (app === 'PENDING_APPROVAL') {
        newApprovedByUserId = null;
        newApprovedByName = null;
        newApprovedAt = null;
        newRejectionReason = null;
        if (newTransactionStatus === 'CANCELLED' || newTransactionStatus === 'VOIDED') {
          newTransactionStatus = 'POSTED';
        }
        if (linkedPoId && linkedPoId > 0) {
          await client.query(
            `UPDATE pos_purchase_orders
                SET status = CASE WHEN status IN ('DRAFT', 'APPROVED', 'REJECTED') THEN 'PENDING_APPROVAL' ELSE status END,
                    approval_status = 'PENDING_APPROVAL',
                    approved_by_user_id = NULL,
                    approved_by_name_snapshot = NULL,
                    approved_at = NULL,
                    rejection_reason = NULL,
                    updated_at = NOW()
              WHERE id = $1 AND property_id = $2`,
            [linkedPoId, propertyId]
          );
        }
      }
    } else if (actionUpper === 'ARCHIVE') {
      newWorkflow = 'SELESAI';
      await client.query(
        `UPDATE transactions
            SET archived_at = NOW(),
                archived_by_user_id = $1,
                archived_by_name_snapshot = $2,
                archive_reason = $3
          WHERE id = $4 AND property_id = $5`,
        [actorUserId, actor, reason, id, propertyId]
      );
    } else if (actionUpper === 'UNARCHIVE') {
      newWorkflow = 'PROSES';
      await client.query(
        `UPDATE transactions
            SET archived_at = NULL,
                archived_by_user_id = NULL,
                archived_by_name_snapshot = NULL,
                archive_reason = NULL
          WHERE id = $1 AND property_id = $2`,
        [id, propertyId]
      );
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
           approval_status = $8,
           approved_by_user_id = $9,
           approved_by_name_snapshot = $10,
           approved_at = $11,
           rejection_reason = $12,
           transaction_status = $13,
           updated_at = NOW()
       WHERE id = $14 AND property_id = $15`,
      [
        newReceiving,
        newReceivedAt,
        newVerification,
        newVerifiedByUserId,
        newVerifiedByName,
        newVerifiedAt,
        newWorkflow,
        newApprovalStatus,
        newApprovedByUserId,
        newApprovedByName,
        newApprovedAt,
        newRejectionReason,
        newTransactionStatus,
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
        approval_status: newApprovalStatus,
        approved_by_user_id: newApprovedByUserId,
        approved_by_name_snapshot: newApprovedByName,
        approved_at: newApprovedAt,
        rejection_reason: newRejectionReason,
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
  payment_status: string | null;
  approval_status: string | null;
  approved_by_user_id: string | null;
  approved_by_name_snapshot: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
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
            payment_status, approval_status, approved_by_user_id, approved_by_name_snapshot, approved_at, rejection_reason,
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
    purchase_workflow_status?: string | null;
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
  if (actionUpper !== 'SET_VERIFICATION' && actionUpper !== 'SET_WORKFLOW' && actionUpper !== 'SET_APPROVAL') {
    const err: any = new Error(`Action '${action}' tidak valid untuk EXPENSE lifecycle`);
    err.statusCode = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const prev = await fetchLockedExpense(client, propertyId, id);
    if (actionUpper !== 'SET_APPROVAL') {
      assertNonTerminal(prev.transaction_status);
    }

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
    let newApprovalStatus: string | null = prev.approval_status || 'PENDING_APPROVAL';
    let newApprovedByUserId: string | null = prev.approved_by_user_id;
    let newApprovedByName: string | null = prev.approved_by_name_snapshot;
    let newApprovedAt: string | null = prev.approved_at;
    let newRejectionReason: string | null = prev.rejection_reason;
    let newTransactionStatus: string = prev.transaction_status || 'POSTED';
    const autoRules = {
      verified_forced_workflow_complete: false,
      workflow_process_forced_unverify: false,
    };

    if (actionUpper === 'SET_APPROVAL') {
      const app = String(dto.approval_status || '').toUpperCase();
      if (!app || !['PENDING_APPROVAL', 'APPROVED', 'REJECTED'].includes(app)) {
        const err: any = new Error(`approval_status '${dto.approval_status}' tidak valid`);
        err.statusCode = 400;
        throw err;
      }
      if (app === 'REJECTED' && String(prev.payment_status || '').toUpperCase() === 'PAID') {
        const err: any = new Error('Pengeluaran yang sudah dibayar (PAID) tidak dapat ditolak. Gunakan Void jika ingin membatalkan.');
        err.statusCode = 409;
        throw err;
      }
      newApprovalStatus = app;
      if (app === 'APPROVED') {
        newApprovedByUserId = actorUserId;
        newApprovedByName = actor;
        newApprovedAt = new Date().toISOString();
        newRejectionReason = null;
        if (newTransactionStatus === 'CANCELLED' || newTransactionStatus === 'VOIDED') {
          newTransactionStatus = 'POSTED';
        }
        newWorkflow = 'PROSES';
      } else if (app === 'REJECTED') {
        newApprovedByUserId = actorUserId;
        newApprovedByName = actor;
        newApprovedAt = new Date().toISOString();
        newRejectionReason = reason || 'Pengajuan pengeluaran ditolak';
        newTransactionStatus = 'CANCELLED';
        newVerification = 'UNVERIFIED';
        newVerifiedByUserId = null;
        newVerifiedByName = null;
        newVerifiedAt = null;
      } else if (app === 'PENDING_APPROVAL') {
        newApprovedByUserId = null;
        newApprovedByName = null;
        newApprovedAt = null;
        newRejectionReason = null;
        if (newTransactionStatus === 'CANCELLED' || newTransactionStatus === 'VOIDED') {
          newTransactionStatus = 'POSTED';
        }
        newWorkflow = 'PROSES';
      }

      await client.query(
        `UPDATE transactions
            SET approval_status = $1::varchar,
                approved_by_user_id = $2,
                approved_by_name_snapshot = $3,
                approved_at = $4,
                rejection_reason = $5::text,
                transaction_status = $6::varchar,
                verification_status = $7::varchar,
                verified_by_user_id = $8,
                verified_by_name_snapshot = $9,
                verified_at = $10,
                purchase_workflow_status = $11::varchar,
                expense_workflow_status = $11::varchar,
                notes = CASE
                  WHEN $1::text = 'REJECTED' AND $5::text IS NOT NULL
                    THEN COALESCE(notes || ' | ', '') || 'Ditolak: ' || $5::text
                  ELSE notes
                END,
                updated_at = NOW()
          WHERE id = $12 AND property_id = $13`,
        [
          newApprovalStatus,
          newApprovedByUserId,
          newApprovedByName,
          newApprovedAt,
          newRejectionReason,
          newTransactionStatus,
          newVerification,
          newVerifiedByUserId,
          newVerifiedByName,
          newVerifiedAt,
          newWorkflow,
          id,
          propertyId,
        ]
      );
    } else if (actionUpper === 'SET_VERIFICATION') {
       const v = dto.verification_status;
       if (!v || !['UNVERIFIED', 'VERIFIED', 'REJECTED'].includes(v)) {
         const err: any = new Error(`verification_status '${v}' tidak valid`);
         err.statusCode = 400;
         throw err;
       }
       if (v === 'VERIFIED') {
         if (String(prev.approval_status || 'APPROVED').toUpperCase() !== 'APPROVED') {
           const err: any = new Error('Pengeluaran harus disetujui (APPROVED) terlebih dahulu sebelum dapat diverifikasi.');
           err.statusCode = 409;
           throw err;
         }
         if (String(prev.payment_status || 'UNPAID').toUpperCase() !== 'PAID') {
           const err: any = new Error('Pengeluaran harus dibayar (Sudah Bayar) terlebih dahulu sebelum dapat diverifikasi sebagai Selesai.');
           err.statusCode = 409;
           throw err;
         }
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
       if (w === 'SELESAI') {
         if (String(prev.approval_status || 'APPROVED').toUpperCase() !== 'APPROVED') {
           const err: any = new Error('Pengeluaran harus disetujui (APPROVED) terlebih dahulu sebelum diubah menjadi Selesai.');
           err.statusCode = 409;
           throw err;
         }
         if (String(prev.payment_status || 'UNPAID').toUpperCase() !== 'PAID') {
           const err: any = new Error('Pengeluaran harus dibayar (Sudah Bayar) terlebih dahulu sebelum diubah menjadi Selesai.');
           err.statusCode = 409;
           throw err;
         }
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

     // Single UPDATE: only touch purchase_workflow_status for SET_VERIFICATION,
     // or both verification + workflow for SET_WORKFLOW.  The canonical helper
     // already wrote verification_status / verified_*/ verified_at for
     // SET_VERIFICATION so we do NOT overwrite those fields here.
     if (actionUpper === 'SET_VERIFICATION') {
       await client.query(
         `UPDATE transactions
          SET purchase_workflow_status = $1,
              expense_workflow_status = $1,
              updated_at = NOW()
          WHERE id = $2 AND property_id = $3`,
         [newWorkflow, id, propertyId]
       );
     } else if (actionUpper === 'SET_WORKFLOW') {
       // SET_WORKFLOW: also reset verification_status/verified fields when switching to PROSES
       await client.query(
         `UPDATE transactions
          SET verification_status = $1,
              verified_by_user_id = $2,
              verified_by_name_snapshot = $3,
              verified_at = $4,
              purchase_workflow_status = $5,
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
         purchase_workflow_status: newWorkflow,
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

