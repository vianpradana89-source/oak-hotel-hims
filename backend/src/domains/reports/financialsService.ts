import type { Pool, PoolClient } from 'pg';
import { normalizeHotelDate, hotelDateFromInstant, addHotelDays } from '../../utils/hotelDate';
import { httpError } from './occupancyService';

export interface FinancialsQueryOptions {
  property_id: number;
  start_date?: string | null;
  end_date?: string | null;
  date?: string | null;
}

export interface PaymentMethodSummary {
  method: string;
  booking_total: number;
  booking_count: number;
  pos_total: number;
  pos_count: number;
  income_total: number;
  income_count: number;
  purchase_total: number;
  purchase_count: number;
  expense_total: number;
  expense_count: number;
  grand_total: number;
  grand_count: number;
}

export interface IncomeTransactionItem {
  id: number | string;
  transaction_no: string;
  transaction_date: string;
  party_name: string;
  description: string;
  category_code: string;
  category_name: string;
  department_code: string;
  net_amount: number;
  payment_method: string;
  payment_status: string;
  transaction_status: string;
  operational_status: string;
  created_by: string;
  nota_attachment_id: number | null;
  bayar_attachment_id: number | null;
}

export interface ExpenseTransactionItem {
  id: number | string;
  transaction_no: string;
  transaction_date: string;
  party_name: string;
  description: string;
  category_code: string;
  category_name: string;
  department_code: string;
  net_amount: number;
  payment_method: string;
  payment_status: string;
  transaction_status: string;
  operational_status: string;
  created_by: string;
  nota_attachment_id: number | null;
  bayar_attachment_id: number | null;
}

export interface FinancialsReportResult {
  property_id: number;
  start_date: string;
  end_date: string;
  sales_breakdown: {
    total: number;
    count: number;
    room_total: number;
    room_count: number;
    pos_total: number;
    pos_count: number;
    minibar_total: number;
    minibar_count: number;
    paid_total: number;
    unpaid_total: number;
  };
  other_income: {
    total: number;
    count: number;
    by_category: Array<{ category_code: string; category_name: string; total: number; count: number }>;
    by_payment_method: Array<{ method: string; total: number; count: number }>;
    items: IncomeTransactionItem[];
  };
  income: {
    total: number;
    count: number;
    by_category: Array<{ category_code: string; category_name: string; total: number; count: number }>;
    by_payment_method: Array<{ method: string; total: number; count: number }>;
  };
  expense: {
    total: number;
    count: number;
    by_category: Array<{ category_code: string; category_name: string; total: number; count: number }>;
    by_department: Array<{ department_code: string; total: number; count: number }>;
    items: ExpenseTransactionItem[];
  };
  purchase: {
    total: number;
    count: number;
    unpaid_total: number;
    unpaid_count: number;
    by_payment_status: Array<{ status: string; total: number; count: number }>;
    by_department: Array<{ department_code: string; total: number; count: number }>;
  };
  payment_method_summary: PaymentMethodSummary[];
}

export async function calculateFinancials(
  pool: Pool | PoolClient,
  options: FinancialsQueryOptions
): Promise<FinancialsReportResult> {
  const propertyId = Number(options.property_id ?? (options as any).propertyId);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw httpError(400, 'VALIDATION_ERROR', 'property_id is required and must be a positive integer');
  }

  // Verify property exists
  const propCheck = await pool.query('SELECT id FROM properties WHERE id = $1', [propertyId]);
  if ((propCheck.rowCount ?? 0) === 0) {
    throw httpError(404, 'PROPERTY_NOT_FOUND', `property ${propertyId} not found`);
  }

  // Date range normalization [startDate, endDate]
  let startDate: string;
  let endDate: string;

  const rawDate = options.date;
  const rawStartDate = options.start_date ?? (options as any).startDate;
  const rawEndDate = options.end_date ?? (options as any).endDate;

  if (rawDate) {
    startDate = normalizeHotelDate(rawDate) || hotelDateFromInstant(new Date(), 'Asia/Jakarta');
    endDate = startDate;
  } else if (rawStartDate && rawEndDate) {
    startDate = normalizeHotelDate(rawStartDate) || hotelDateFromInstant(new Date(), 'Asia/Jakarta');
    endDate = normalizeHotelDate(rawEndDate) || startDate;
  } else {
    // Default: last 30 days
    const today = hotelDateFromInstant(new Date(), 'Asia/Jakarta');
    startDate = addHotelDays(today, -29);
    endDate = today;
  }

  if (endDate < startDate) {
    throw httpError(400, 'VALIDATION_ERROR', 'end_date must be >= start_date');
  }

  const nonCancelledTxFilter = `
      AND t.deleted_at IS NULL
      AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
      AND NOT EXISTS (
        SELECT 1 FROM reservations r_chk
        WHERE r_chk.id = t.reservation_id
          AND (
            UPPER(COALESCE(r_chk.status, '')) IN ('CANCELLED', 'NO_SHOW')
            OR UPPER(COALESCE(r_chk.stay_status, '')) IN ('CANCELLED', 'NO_SHOW')
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM bookings b_chk
        WHERE b_chk.id = t.booking_id
          AND (
            UPPER(COALESCE(b_chk.booking_status, '')) = 'CANCELLED'
            OR (
              EXISTS (SELECT 1 FROM reservations r_b WHERE r_b.booking_id = b_chk.id)
              AND NOT EXISTS (
                SELECT 1 FROM reservations r_b2
                WHERE r_b2.booking_id = b_chk.id
                  AND UPPER(COALESCE(r_b2.status, '')) NOT IN ('CANCELLED', 'NO_SHOW')
                  AND UPPER(COALESCE(r_b2.stay_status, '')) NOT IN ('CANCELLED', 'NO_SHOW')
              )
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM pos_orders po_chk
        LEFT JOIN reservations r_po ON r_po.id = po_chk.reservation_id
        WHERE po_chk.property_id = t.property_id
          AND UPPER(COALESCE(t.source_type, '')) IN ('POS', 'POS_ORDER')
          AND po_chk.id::text = COALESCE(t.source_id, '')
          AND (
            UPPER(COALESCE(po_chk.status, '')) IN ('CANCELLED', 'VOIDED')
            OR UPPER(COALESCE(r_po.status, '')) IN ('CANCELLED', 'NO_SHOW')
            OR UPPER(COALESCE(r_po.stay_status, '')) IN ('CANCELLED', 'NO_SHOW')
          )
      )
  `;

  const isMinibarSql = `(
    UPPER(COALESCE(t.category_code, '')) = 'MINIBAR_SALES'
    OR UPPER(COALESCE(t.source_type, '')) = 'MINIBAR'
    OR (
      UPPER(COALESCE(t.source_type, '')) = 'FOLIO_ENTRY'
      AND EXISTS (
        SELECT 1 FROM folio_entries fe_mb
        WHERE fe_mb.id::text = COALESCE(t.source_id, '')
          AND fe_mb.property_id = t.property_id
          AND (
            UPPER(COALESCE(fe_mb.entry_type, '')) = 'MINIBAR'
            OR UPPER(COALESCE(fe_mb.source_type, '')) = 'MINIBAR'
            OR UPPER(COALESCE(fe_mb.revenue_category, '')) = 'MINIBAR_SALES'
          )
      )
    )
  )`;
  const isPosSql = `(
    NOT ${isMinibarSql}
    AND (
      UPPER(COALESCE(t.source_type, '')) IN ('POS', 'POS_ORDER')
      OR UPPER(COALESCE(t.category_code, '')) LIKE '%POS%'
      OR UPPER(COALESCE(t.category_code, '')) LIKE '%FNB%'
    )
  )`;
  const isRoomSql = `(NOT ${isMinibarSql} AND NOT ${isPosSql})`;

  // 0. Sales Breakdown (Room vs POS vs Minibar vs Total SALE — strictly excluding cancelled reservations/bookings/POS orders)
  const salesBreakdownQuery = `
    SELECT
      COALESCE(SUM(t.net_amount), 0)::numeric(14,2) AS total,
      COUNT(*)::int AS count,
      COALESCE(SUM(CASE WHEN ${isPosSql} THEN t.net_amount ELSE 0 END), 0)::numeric(14,2) AS pos_total,
      COUNT(*) FILTER (WHERE ${isPosSql})::int AS pos_count,
      COALESCE(SUM(CASE WHEN ${isMinibarSql} THEN t.net_amount ELSE 0 END), 0)::numeric(14,2) AS minibar_total,
      COUNT(*) FILTER (WHERE ${isMinibarSql})::int AS minibar_count,
      COALESCE(SUM(CASE WHEN ${isRoomSql} THEN t.net_amount ELSE 0 END), 0)::numeric(14,2) AS room_total,
      COUNT(*) FILTER (WHERE ${isRoomSql})::int AS room_count,
      COALESCE(SUM(CASE WHEN UPPER(COALESCE(t.payment_status, '')) = 'PAID' THEN t.net_amount ELSE 0 END), 0)::numeric(14,2) AS paid_total,
      COALESCE(SUM(CASE WHEN UPPER(COALESCE(t.payment_status, '')) != 'PAID' THEN t.net_amount ELSE 0 END), 0)::numeric(14,2) AS unpaid_total
    FROM transactions t
    WHERE t.property_id = $1
      AND t.transaction_type = 'SALE'
      ${nonCancelledTxFilter}
      AND t.transaction_date >= $2::date
      AND t.transaction_date <= $3::date
  `;
  const salesBreakdownRes = await pool.query(salesBreakdownQuery, [propertyId, startDate, endDate]);
  const sbRow = salesBreakdownRes.rows[0] || {};

  // 0b. Other Income (specifically t.transaction_type = 'INCOME')
  const otherIncomeTotalRes = await pool.query(
    `
    SELECT
      COALESCE(SUM(t.net_amount), 0)::numeric(14,2) AS total,
      COUNT(*)::int AS count
    FROM transactions t
    WHERE t.property_id = $1
      AND t.transaction_type = 'INCOME'
      ${nonCancelledTxFilter}
      AND t.transaction_date >= $2::date
      AND t.transaction_date <= $3::date
    `,
    [propertyId, startDate, endDate]
  );
  const otherIncomeTotal = Number(otherIncomeTotalRes.rows[0]?.total || 0);
  const otherIncomeCount = Number(otherIncomeTotalRes.rows[0]?.count || 0);

  const otherIncomeByCatRes = await pool.query(
    `
    SELECT
      t.category_code,
      COALESCE(t.category_name, t.category_code) AS category_name,
      COALESCE(SUM(t.net_amount), 0)::numeric(14,2) AS total,
      COUNT(*)::int AS count
    FROM transactions t
    WHERE t.property_id = $1
      AND t.transaction_type = 'INCOME'
      ${nonCancelledTxFilter}
      AND t.transaction_date >= $2::date
      AND t.transaction_date <= $3::date
    GROUP BY t.category_code, COALESCE(t.category_name, t.category_code)
    ORDER BY total DESC
    `,
    [propertyId, startDate, endDate]
  );

  const otherIncomeByMethodRes = await pool.query(
    `
    SELECT
      COALESCE(NULLIF(BTRIM(t.payment_method), ''), 'Belum Diisi') AS method,
      COALESCE(SUM(t.net_amount), 0)::numeric(14,2) AS total,
      COUNT(*)::int AS count
    FROM transactions t
    WHERE t.property_id = $1
      AND t.transaction_type = 'INCOME'
      ${nonCancelledTxFilter}
      AND t.transaction_date >= $2::date
      AND t.transaction_date <= $3::date
    GROUP BY COALESCE(NULLIF(BTRIM(t.payment_method), ''), 'Belum Diisi')
    ORDER BY total DESC
    `,
    [propertyId, startDate, endDate]
  );

  const otherIncomeItemsRes = await pool.query(
    `
    SELECT
      t.id,
      t.transaction_no,
      to_char(t.transaction_date, 'YYYY-MM-DD') AS transaction_date,
      COALESCE(NULLIF(BTRIM(t.party_name), ''), NULLIF(BTRIM(t.guest_name_snapshot), ''), '-') AS party_name,
      COALESCE(NULLIF(BTRIM(t.description), ''), '-') AS description,
      COALESCE(t.category_code, 'OTHER_INCOME') AS category_code,
      COALESCE(t.category_name, t.category_code, 'Pemasukan Lain') AS category_name,
      COALESCE(t.department_code, 'GENERAL') AS department_code,
      COALESCE(t.net_amount, 0)::numeric(14,2) AS net_amount,
      COALESCE(NULLIF(BTRIM(t.payment_method), ''), '-') AS payment_method,
      COALESCE(t.payment_status, 'UNPAID') AS payment_status,
      COALESCE(t.transaction_status, 'POSTED') AS transaction_status,
      CASE
        WHEN UPPER(COALESCE(t.transaction_status, 'POSTED')) = 'DRAFT' THEN 'Proses'
        WHEN UPPER(COALESCE(t.payment_status, '')) = 'PAID' THEN 'Selesai'
        ELSE 'Proses'
      END AS operational_status,
      COALESCE(NULLIF(BTRIM(t.created_by), ''), '-') AS created_by,
      (
        SELECT ta.id::int
        FROM transaction_attachments ta
        WHERE ta.transaction_id = t.id AND ta.property_id = t.property_id
          AND UPPER(COALESCE(ta.attachment_purpose, '')) IN ('RECEIPT', 'INVOICE', 'OTHER')
        ORDER BY ta.uploaded_at DESC LIMIT 1
      ) AS nota_attachment_id,
      (
        SELECT ta.id::int
        FROM transaction_attachments ta
        WHERE ta.transaction_id = t.id AND ta.property_id = t.property_id
          AND UPPER(COALESCE(ta.attachment_purpose, '')) IN ('PAYMENT_PROOF', 'RECEIPT', 'INVOICE', 'OTHER')
        ORDER BY CASE WHEN UPPER(COALESCE(ta.attachment_purpose, '')) = 'PAYMENT_PROOF' THEN 0 ELSE 1 END, ta.uploaded_at DESC LIMIT 1
      ) AS bayar_attachment_id
    FROM transactions t
    WHERE t.property_id = $1
      AND t.transaction_type = 'INCOME'
      ${nonCancelledTxFilter}
      AND t.transaction_date >= $2::date
      AND t.transaction_date <= $3::date
    ORDER BY t.transaction_date DESC, t.id DESC
    LIMIT 500
    `,
    [propertyId, startDate, endDate]
  );

  // 1. Income (SALE + INCOME transaction types, reporting-eligible)
  const incomeQuery = `
    SELECT
      COALESCE(SUM(t.net_amount), 0)::numeric(14,2) AS total,
      COUNT(*)::int AS count
    FROM transactions t
    WHERE t.property_id = $1
      AND t.transaction_type IN ('SALE', 'INCOME')
      ${nonCancelledTxFilter}
      AND t.transaction_date >= $2::date
      AND t.transaction_date <= $3::date
  `;
  const incomeTotalRes = await pool.query(incomeQuery, [propertyId, startDate, endDate]);
  const incomeTotal = Number(incomeTotalRes.rows[0]?.total || 0);
  const incomeCount = Number(incomeTotalRes.rows[0]?.count || 0);

  const incomeByCatQuery = `
    SELECT
      t.category_code,
      COALESCE(t.category_name, t.category_code) AS category_name,
      COALESCE(SUM(t.net_amount), 0)::numeric(14,2) AS total,
      COUNT(*)::int AS count
    FROM transactions t
    WHERE t.property_id = $1
      AND t.transaction_type IN ('SALE', 'INCOME')
      ${nonCancelledTxFilter}
      AND t.transaction_date >= $2::date
      AND t.transaction_date <= $3::date
    GROUP BY t.category_code, COALESCE(t.category_name, t.category_code)
    ORDER BY total DESC
  `;
  const incomeByCatRes = await pool.query(incomeByCatQuery, [propertyId, startDate, endDate]);

  const incomeByMethodQuery = `
    SELECT
      COALESCE(NULLIF(BTRIM(t.payment_method), ''), 'Belum Diisi') AS method,
      COALESCE(SUM(t.net_amount), 0)::numeric(14,2) AS total,
      COUNT(*)::int AS count
    FROM transactions t
    WHERE t.property_id = $1
      AND t.transaction_type IN ('SALE', 'INCOME')
      ${nonCancelledTxFilter}
      AND t.transaction_date >= $2::date
      AND t.transaction_date <= $3::date
    GROUP BY COALESCE(NULLIF(BTRIM(t.payment_method), ''), 'Belum Diisi')
    ORDER BY total DESC
  `;
  const incomeByMethodRes = await pool.query(incomeByMethodQuery, [propertyId, startDate, endDate]);

  // 2. Expense (EXPENSE transaction type, reporting-eligible: APPROVED and not REJECTED/PENDING_APPROVAL)
  const expenseQuery = `
    SELECT
      COALESCE(SUM(t.net_amount), 0)::numeric(14,2) AS total,
      COUNT(*)::int AS count
    FROM transactions t
    WHERE t.property_id = $1
      AND t.transaction_type = 'EXPENSE'
      AND t.deleted_at IS NULL
      AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
      AND COALESCE(UPPER(t.approval_status), 'APPROVED') = 'APPROVED'
      AND UPPER(COALESCE(t.payment_status, 'PAID')) = 'PAID'
      AND t.transaction_date >= $2::date
      AND t.transaction_date <= $3::date
  `;
  const expenseTotalRes = await pool.query(expenseQuery, [propertyId, startDate, endDate]);
  const expenseTotal = Number(expenseTotalRes.rows[0]?.total || 0);
  const expenseCount = Number(expenseTotalRes.rows[0]?.count || 0);

  const expenseByCatQuery = `
    SELECT
      t.category_code,
      COALESCE(t.category_name, t.category_code) AS category_name,
      COALESCE(SUM(t.net_amount), 0)::numeric(14,2) AS total,
      COUNT(*)::int AS count
    FROM transactions t
    WHERE t.property_id = $1
      AND t.transaction_type = 'EXPENSE'
      AND t.deleted_at IS NULL
      AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
      AND COALESCE(UPPER(t.approval_status), 'APPROVED') = 'APPROVED'
      AND UPPER(COALESCE(t.payment_status, 'PAID')) = 'PAID'
      AND t.transaction_date >= $2::date
      AND t.transaction_date <= $3::date
    GROUP BY t.category_code, COALESCE(t.category_name, t.category_code)
    ORDER BY total DESC
  `;
  const expenseByCatRes = await pool.query(expenseByCatQuery, [propertyId, startDate, endDate]);

  const expenseByDeptQuery = `
    SELECT
      t.department_code,
      COALESCE(SUM(t.net_amount), 0)::numeric(14,2) AS total,
      COUNT(*)::int AS count
    FROM transactions t
    WHERE t.property_id = $1
      AND t.transaction_type = 'EXPENSE'
      AND t.deleted_at IS NULL
      AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
      AND COALESCE(UPPER(t.approval_status), 'APPROVED') = 'APPROVED'
      AND UPPER(COALESCE(t.payment_status, 'PAID')) = 'PAID'
      AND t.transaction_date >= $2::date
      AND t.transaction_date <= $3::date
    GROUP BY t.department_code
    ORDER BY total DESC
  `;
  const expenseByDeptRes = await pool.query(expenseByDeptQuery, [propertyId, startDate, endDate]);

  const expenseItemsRes = await pool.query(
    `
    SELECT
      t.id,
      t.transaction_no,
      to_char(t.transaction_date, 'YYYY-MM-DD') AS transaction_date,
      COALESCE(NULLIF(BTRIM(t.party_name), ''), '-') AS party_name,
      COALESCE(NULLIF(BTRIM(t.description), ''), '-') AS description,
      COALESCE(t.category_code, 'OTHER_EXPENSE') AS category_code,
      COALESCE(t.category_name, t.category_code, 'Pengeluaran') AS category_name,
      COALESCE(t.department_code, 'GENERAL') AS department_code,
      COALESCE(t.net_amount, 0)::numeric(14,2) AS net_amount,
      COALESCE(NULLIF(BTRIM(t.payment_method), ''), '-') AS payment_method,
      COALESCE(t.payment_status, 'UNPAID') AS payment_status,
      COALESCE(t.transaction_status, 'POSTED') AS transaction_status,
      CASE
        WHEN UPPER(COALESCE(t.expense_workflow_status, 'PROSES')) = 'SELESAI' THEN 'Selesai'
        ELSE 'Proses'
      END AS operational_status,
      COALESCE(NULLIF(BTRIM(t.created_by), ''), '-') AS created_by,
      (
        SELECT ta.id::int
        FROM transaction_attachments ta
        WHERE ta.transaction_id = t.id AND ta.property_id = t.property_id
          AND UPPER(COALESCE(ta.attachment_purpose, '')) IN ('RECEIPT', 'INVOICE', 'OTHER')
        ORDER BY ta.uploaded_at DESC LIMIT 1
      ) AS nota_attachment_id,
      (
        SELECT ta.id::int
        FROM transaction_attachments ta
        WHERE ta.transaction_id = t.id AND ta.property_id = t.property_id
          AND UPPER(COALESCE(ta.attachment_purpose, '')) = 'PAYMENT_PROOF'
        ORDER BY ta.uploaded_at DESC LIMIT 1
      ) AS bayar_attachment_id
    FROM transactions t
    WHERE t.property_id = $1
      AND t.transaction_type = 'EXPENSE'
      AND t.deleted_at IS NULL
      AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
      AND COALESCE(UPPER(t.approval_status), 'APPROVED') = 'APPROVED'
      AND t.transaction_date >= $2::date
      AND t.transaction_date <= $3::date
    ORDER BY t.transaction_date DESC, t.id DESC
    LIMIT 500
    `,
    [propertyId, startDate, endDate]
  );

  // 3. Purchase (PURCHASE transaction type + POS Purchase Orders not yet mirrored to transactions)
  const purchaseQuery = `
    WITH combined_purchase_headers AS (
      SELECT
        t.net_amount::numeric(14,2) AS net_amount,
        UPPER(COALESCE(t.payment_status, 'UNPAID')) AS payment_status
      FROM transactions t
      WHERE t.property_id = $1
        AND t.transaction_type = 'PURCHASE'
        AND t.deleted_at IS NULL
        AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
        AND COALESCE(UPPER(t.approval_status), 'APPROVED') != 'REJECTED'
        AND t.transaction_date >= $2::date
        AND t.transaction_date <= $3::date
      UNION ALL
      SELECT
        COALESCE(ppo.total_estimated_amount, 0)::numeric(14,2) AS net_amount,
        CASE WHEN ppo.status = 'COMPLETED' THEN 'PAID' ELSE 'UNPAID' END AS payment_status
      FROM pos_purchase_orders ppo
      WHERE ppo.property_id = $1
        AND COALESCE(UPPER(ppo.status), 'DRAFT') = 'COMPLETED'
        AND COALESCE(UPPER(ppo.approval_status), 'APPROVED') = 'APPROVED'
        AND ppo.order_date >= $2::date
        AND ppo.order_date <= $3::date
        AND NOT EXISTS (
          SELECT 1
          FROM transactions t
          WHERE t.property_id = ppo.property_id
            AND t.transaction_type = 'PURCHASE'
            AND t.deleted_at IS NULL
            AND t.source_reference = ppo.po_number
        )
    )
    SELECT
      COALESCE(SUM(net_amount), 0)::numeric(14,2) AS total,
      COUNT(*)::int AS count,
      COALESCE(SUM(CASE WHEN payment_status != 'PAID' THEN net_amount ELSE 0 END), 0)::numeric(14,2) AS unpaid_total,
      COUNT(*) FILTER (WHERE payment_status != 'PAID')::int AS unpaid_count
    FROM combined_purchase_headers
  `;
  const purchaseTotalRes = await pool.query(purchaseQuery, [propertyId, startDate, endDate]);
  const purchaseTotal = Number(purchaseTotalRes.rows[0]?.total || 0);
  const purchaseCount = Number(purchaseTotalRes.rows[0]?.count || 0);
  const purchaseUnpaidTotal = Number(purchaseTotalRes.rows[0]?.unpaid_total || 0);
  const purchaseUnpaidCount = Number(purchaseTotalRes.rows[0]?.unpaid_count || 0);

  const purchaseByStatusQuery = `
    SELECT
      COALESCE(t.payment_status, 'UNPAID') AS status,
      COALESCE(SUM(t.net_amount), 0)::numeric(14,2) AS total,
      COUNT(*)::int AS count
    FROM transactions t
    WHERE t.property_id = $1
      AND t.transaction_type = 'PURCHASE'
      AND t.deleted_at IS NULL
      AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
      AND t.transaction_date >= $2::date
      AND t.transaction_date <= $3::date
    GROUP BY COALESCE(t.payment_status, 'UNPAID')
    ORDER BY total DESC
  `;
  const purchaseByStatusRes = await pool.query(purchaseByStatusQuery, [propertyId, startDate, endDate]);

  const purchaseByDeptQuery = `
    SELECT
      t.department_code,
      COALESCE(SUM(t.net_amount), 0)::numeric(14,2) AS total,
      COUNT(*)::int AS count
    FROM transactions t
    WHERE t.property_id = $1
      AND t.transaction_type = 'PURCHASE'
      AND t.deleted_at IS NULL
      AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
      AND t.transaction_date >= $2::date
      AND t.transaction_date <= $3::date
    GROUP BY t.department_code
    ORDER BY total DESC
  `;
  const purchaseByDeptRes = await pool.query(purchaseByDeptQuery, [propertyId, startDate, endDate]);

  // 4. Payment Method Summary (aggregate across all transaction types + folio payment_transactions, including OTA COLLECT & BELUM BAYAR / PIUTANG)
  const paymentMethodQuery = `
    WITH tx_with_resolved_method AS (
      SELECT
        t.id,
        t.transaction_type,
        t.source_type,
        t.net_amount,
        CASE
          WHEN t.transaction_type = 'SALE'
            AND UPPER(COALESCE(t.source_type, '')) NOT IN ('POS', 'POS_ORDER')
            AND (
              UPPER(COALESCE(b_pm.payment_responsibility, '')) = 'OTA_COLLECT'
              OR UPPER(COALESCE(t.payment_method, '')) IN ('OTA_COLLECT', 'OTA COLLECT', 'OTA')
            )
          THEN 'OTA COLLECT'
          ELSE COALESCE(
            NULLIF(BTRIM(t.payment_method), ''),
            (
              SELECT NULLIF(BTRIM(pt.payment_method), '')
              FROM payment_transactions pt
              WHERE (pt.transaction_id = t.id OR (t.reservation_id IS NOT NULL AND pt.reservation_id = t.reservation_id))
                AND pt.status = 'SUCCESS'
                AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
              ORDER BY pt.created_at DESC NULLS LAST, pt.id DESC
              LIMIT 1
            ),
            (
              SELECT NULLIF(BTRIM(pt.payment_method), '')
              FROM payment_allocations pa
              JOIN payment_transactions pt ON pt.id = pa.payment_transaction_id
              WHERE (t.booking_id IS NOT NULL OR r_pm.booking_id IS NOT NULL)
                AND pa.booking_id = COALESCE(t.booking_id, r_pm.booking_id)
                AND pa.status = 'ACTIVE'
                AND pt.status = 'SUCCESS'
              ORDER BY pt.created_at DESC NULLS LAST, pt.id DESC
              LIMIT 1
            ),
            'BELUM BAYAR / PIUTANG'
          )
        END AS resolved_method
      FROM transactions t
      LEFT JOIN reservations r_pm ON r_pm.id = t.reservation_id
      LEFT JOIN bookings b_pm ON b_pm.id = COALESCE(t.booking_id, r_pm.booking_id)
      WHERE t.property_id = $1
        ${nonCancelledTxFilter}
        AND t.transaction_date >= $2::date
        AND t.transaction_date <= $3::date
    )
    SELECT
      resolved_method AS method,
      COALESCE(SUM(CASE WHEN transaction_type = 'SALE' AND UPPER(COALESCE(source_type, '')) NOT IN ('POS', 'POS_ORDER') THEN net_amount ELSE 0 END), 0)::numeric(14,2) AS booking_total,
      COUNT(*) FILTER (WHERE transaction_type = 'SALE' AND UPPER(COALESCE(source_type, '')) NOT IN ('POS', 'POS_ORDER'))::int AS booking_count,
      COALESCE(SUM(CASE WHEN UPPER(COALESCE(source_type, '')) IN ('POS', 'POS_ORDER') THEN net_amount ELSE 0 END), 0)::numeric(14,2) AS pos_total,
      COUNT(*) FILTER (WHERE UPPER(COALESCE(source_type, '')) IN ('POS', 'POS_ORDER'))::int AS pos_count,
      COALESCE(SUM(CASE WHEN transaction_type = 'INCOME' THEN net_amount ELSE 0 END), 0)::numeric(14,2) AS income_total,
      COUNT(*) FILTER (WHERE transaction_type = 'INCOME')::int AS income_count,
      COALESCE(SUM(CASE WHEN transaction_type = 'PURCHASE' THEN net_amount ELSE 0 END), 0)::numeric(14,2) AS purchase_total,
      COUNT(*) FILTER (WHERE transaction_type = 'PURCHASE')::int AS purchase_count,
      COALESCE(SUM(CASE WHEN transaction_type = 'EXPENSE' THEN net_amount ELSE 0 END), 0)::numeric(14,2) AS expense_total,
      COUNT(*) FILTER (WHERE transaction_type = 'EXPENSE')::int AS expense_count,
      COALESCE(SUM(net_amount), 0)::numeric(14,2) AS grand_total,
      COUNT(*)::int AS grand_count
    FROM tx_with_resolved_method
    GROUP BY resolved_method
    ORDER BY grand_total DESC, grand_count DESC
  `;
  const paymentMethodRes = await pool.query(paymentMethodQuery, [propertyId, startDate, endDate]);

  const paymentMethodSummary: PaymentMethodSummary[] = paymentMethodRes.rows.map((row: any) => ({
    method: row.method,
    booking_total: Number(row.booking_total || 0),
    booking_count: Number(row.booking_count || 0),
    pos_total: Number(row.pos_total || 0),
    pos_count: Number(row.pos_count || 0),
    income_total: Number(row.income_total || 0),
    income_count: Number(row.income_count || 0),
    purchase_total: Number(row.purchase_total || 0),
    purchase_count: Number(row.purchase_count || 0),
    expense_total: Number(row.expense_total || 0),
    expense_count: Number(row.expense_count || 0),
    grand_total: Number(row.grand_total || 0),
    grand_count: Number(row.grand_count || 0),
  }));

  if (!paymentMethodSummary.some((m) => String(m.method || '').toUpperCase() === 'OTA COLLECT')) {
    paymentMethodSummary.push({
      method: 'OTA COLLECT',
      booking_total: 0,
      booking_count: 0,
      pos_total: 0,
      pos_count: 0,
      income_total: 0,
      income_count: 0,
      purchase_total: 0,
      purchase_count: 0,
      expense_total: 0,
      expense_count: 0,
      grand_total: 0,
      grand_count: 0,
    });
  }

  const mapTxItems = (rows: any[]) =>
    rows.map((r: any) => ({
      id: r.id,
      transaction_no: r.transaction_no,
      transaction_date: r.transaction_date,
      party_name: r.party_name,
      description: r.description,
      category_code: r.category_code,
      category_name: r.category_name,
      department_code: r.department_code,
      net_amount: Number(r.net_amount || 0),
      payment_method: r.payment_method,
      payment_status: r.payment_status,
      transaction_status: r.transaction_status,
      operational_status: r.operational_status,
      created_by: r.created_by,
      nota_attachment_id: r.nota_attachment_id ? Number(r.nota_attachment_id) : null,
      bayar_attachment_id: r.bayar_attachment_id ? Number(r.bayar_attachment_id) : null,
    }));

  return {
    property_id: propertyId,
    start_date: startDate,
    end_date: endDate,
    sales_breakdown: {
      total: Number(sbRow.total || 0),
      count: Number(sbRow.count || 0),
      room_total: Number(sbRow.room_total || 0),
      room_count: Number(sbRow.room_count || 0),
      pos_total: Number(sbRow.pos_total || 0),
      pos_count: Number(sbRow.pos_count || 0),
      minibar_total: Number(sbRow.minibar_total || 0),
      minibar_count: Number(sbRow.minibar_count || 0),
      paid_total: Number(sbRow.paid_total || 0),
      unpaid_total: Number(sbRow.unpaid_total || 0),
    },
    other_income: {
      total: otherIncomeTotal,
      count: otherIncomeCount,
      by_category: otherIncomeByCatRes.rows.map((r: any) => ({
        category_code: r.category_code,
        category_name: r.category_name,
        total: Number(r.total || 0),
        count: Number(r.count || 0),
      })),
      by_payment_method: otherIncomeByMethodRes.rows.map((r: any) => ({
        method: r.method,
        total: Number(r.total || 0),
        count: Number(r.count || 0),
      })),
      items: mapTxItems(otherIncomeItemsRes.rows),
    },
    income: {
      total: incomeTotal,
      count: incomeCount,
      by_category: incomeByCatRes.rows.map((r: any) => ({
        category_code: r.category_code,
        category_name: r.category_name,
        total: Number(r.total || 0),
        count: Number(r.count || 0)
      })),
      by_payment_method: incomeByMethodRes.rows.map((r: any) => ({
        method: r.method,
        total: Number(r.total || 0),
        count: Number(r.count || 0)
      }))
    },
    expense: {
      total: expenseTotal,
      count: expenseCount,
      by_category: expenseByCatRes.rows.map((r: any) => ({
        category_code: r.category_code,
        category_name: r.category_name,
        total: Number(r.total || 0),
        count: Number(r.count || 0)
      })),
      by_department: expenseByDeptRes.rows.map((r: any) => ({
        department_code: r.department_code,
        total: Number(r.total || 0),
        count: Number(r.count || 0)
      })),
      items: mapTxItems(expenseItemsRes.rows),
    },
    purchase: {
      total: purchaseTotal,
      count: purchaseCount,
      unpaid_total: purchaseUnpaidTotal,
      unpaid_count: purchaseUnpaidCount,
      by_payment_status: purchaseByStatusRes.rows.map((r: any) => ({
        status: r.status,
        total: Number(r.total || 0),
        count: Number(r.count || 0)
      })),
      by_department: purchaseByDeptRes.rows.map((r: any) => ({
        department_code: r.department_code,
        total: Number(r.total || 0),
        count: Number(r.count || 0)
      }))
    },
    payment_method_summary: paymentMethodSummary
  };
}
