import { Pool } from 'pg';
import type {
  TransactionFilterParams,
  TransactionQueryResult,
  TransactionSheetCounts,
  TransactionSummary,
} from './transactionTypes';
import { PURCHASE_WORKFLOW_SHEET_SQL, EXPENSE_WORKFLOW_SHEET_SQL } from './transactionTypes';

export interface TransactionListFetchStats {
  mode: 'PERIOD' | 'ALL_TIME' | 'HAPUS';
  fetched_transaction_rows: number;
  presented_total: number;
  presented_page: number;
}

export interface PresentedPagePlan {
  keys: string[];
  bids: string[];
  transactionIds: number[];
  total_count: number;
  summary: TransactionSummary;
  sheet_counts: TransactionSheetCounts;
  effective_date_map: Record<string, string>;
}

const LIFECYCLE_KEY_SQL = `COALESCE(
  NULLIF(BTRIM(t.correction_group_id), ''),
  'rev:' || COALESCE(
    t.reversal_of_transaction_id,
    NULLIF(t.metadata->>'restored_from_transaction_id', '')::bigint,
    NULLIF(t.metadata->>'reversal_transaction_id', '')::bigint,
    t.id
  )::text
)`;

const PRIMARY_STATUS_RANK_SQL = `CASE
  WHEN UPPER(t.transaction_status) = 'POSTED' THEN 0
  WHEN UPPER(t.transaction_status) NOT IN ('VOIDED', 'CANCELLED', 'REVERSED') THEN 1
  WHEN UPPER(t.transaction_status) = 'REVERSED' THEN 2
  ELSE 3
END`;

const STANDALONE_SHEET_SQL = `CASE
  WHEN UPPER(t.transaction_status) IN ('VOIDED', 'CANCELLED', 'REVERSED') THEN 'BATAL'
  WHEN UPPER(t.transaction_type) = 'SALE'
    AND UPPER(COALESCE(t.source_type, '')) NOT IN ('POS', 'POS_ORDER')
    AND (
      UPPER(COALESCE(r.status, '')) = 'CANCELLED'
      OR UPPER(COALESCE(r.stay_status, '')) = 'CANCELLED'
    ) THEN 'BATAL'
  WHEN UPPER(t.transaction_type) = 'SALE'
    AND UPPER(COALESCE(t.source_type, '')) NOT IN ('POS', 'POS_ORDER')
    AND (
      UPPER(COALESCE(r.status, '')) = 'CHECKED_OUT'
      OR UPPER(COALESCE(r.stay_status, '')) = 'CHECKED_OUT'
    ) THEN 'SELESAI'
  WHEN UPPER(t.transaction_type) = 'SALE'
    AND UPPER(COALESCE(t.source_type, '')) NOT IN ('POS', 'POS_ORDER')
    AND (
      UPPER(COALESCE(r.status, '')) IN ('BOOKED', 'CHECKED_IN')
      OR UPPER(COALESCE(r.stay_status, '')) IN ('RESERVED', 'BOOKED', 'CHECKED_IN')
    ) THEN 'PROSES'
  ${PURCHASE_WORKFLOW_SHEET_SQL}
  ${EXPENSE_WORKFLOW_SHEET_SQL}
  WHEN UPPER(t.transaction_status) = 'POSTED' THEN 'SELESAI'
  ELSE 'PROSES'
END`;

function emptySummary(): TransactionSummary {
  return {
    total_sale: 0,
    total_purchase: 0,
    total_expense: 0,
    total_income: 0,
    count_sale: 0,
    count_purchase: 0,
    count_expense: 0,
    count_income: 0,
  };
}

/**
 * All Time / unbounded list: page at PRESENTED item keys in SQL.
 * Node only fetches rows for the current page keys (+ later sibling expansion).
 */
export async function queryPresentedPage(
  pool: Pool,
  params: TransactionFilterParams,
  hapusCount: number
): Promise<PresentedPagePlan> {
  const propertyId = Number(params.property_id);
  const listType = String(params.transaction_type || '').toUpperCase();
  const targetSheet = String(params.operational_sheet || params.operational_status || '').toUpperCase();
  const limit = Math.min(100, Math.max(1, Number(params.limit || 50)));
  const offset = Math.max(0, Number(params.offset || 0));
  const search = params.search && params.search.trim() ? `%${params.search.trim()}%` : null;
  const startDate = params.start_date || null;
  const endDate = params.end_date || null;

  const values: any[] = [propertyId];
  let idx = 2;
  const extra: string[] = [];

  if (listType) {
    extra.push(`t.transaction_type = $${idx++}`);
    values.push(listType);
  }
  if (params.source_type) {
    extra.push(`t.source_type = $${idx++}`);
    values.push(params.source_type);
  }
  if (params.category_code) {
    extra.push(`t.category_code = $${idx++}`);
    values.push(params.category_code);
  }
  if (params.department_code) {
    extra.push(`t.department_code = $${idx++}`);
    values.push(params.department_code);
  }
  if (params.payment_status) {
    extra.push(`t.payment_status = $${idx++}`);
    values.push(params.payment_status);
  }
  if (params.payment_method) {
    extra.push(`t.payment_method = $${idx++}`);
    values.push(params.payment_method);
  }
  if (params.verification_status) {
    extra.push(`t.verification_status = $${idx++}`);
    values.push(params.verification_status);
  }
  if (params.receiving_status) {
    extra.push(`t.receiving_status = $${idx++}`);
    values.push(params.receiving_status);
  }
  if (params.transaction_status) {
    extra.push(`UPPER(t.transaction_status) = $${idx++}`);
    values.push(String(params.transaction_status).toUpperCase());
  }
  if (params.supplier_id) {
    extra.push(`t.supplier_id = $${idx++}`);
    values.push(params.supplier_id);
  }
  if (params.reservation_id) {
    extra.push(`t.reservation_id = $${idx++}`);
    values.push(params.reservation_id);
  }
  if (params.booking_id) {
    extra.push(`(t.booking_id::text = $${idx} OR b.bid = $${idx})`);
    values.push(String(params.booking_id));
    idx += 1;
  }
  if (params.party_name && params.party_name.trim()) {
    extra.push(`(t.party_name ILIKE $${idx} OR s.name ILIKE $${idx})`);
    values.push(`%${params.party_name.trim()}%`);
    idx += 1;
  }

  const extraSql = extra.length > 0 ? `AND ${extra.join(' AND ')}` : '';
  const searchIdx = idx++;
  values.push(search);
  const startIdx = idx++;
  values.push(startDate);
  const endIdx = idx++;
  values.push(endDate);
  const sheetIdx = idx++;
  values.push(targetSheet === 'PROSES' || targetSheet === 'SELESAI' || targetSheet === 'BATAL' ? targetSheet : '');
  const limitIdx = idx++;
  values.push(limit);
  const offsetIdx = idx++;
  values.push(offset);

  const sql = `
    WITH live AS (
      SELECT
        t.id,
        t.property_id,
        t.transaction_type,
        t.transaction_date,
        t.transaction_time,
        t.transaction_status,
        t.receiving_status,
        t.purchase_workflow_status,
        t.source_type,
        t.net_amount,
        t.correction_group_id,
        t.reversal_of_transaction_id,
         t.metadata,
         b.bid AS booking_bid,
         r.status AS reservation_status,
         r.stay_status AS reservation_stay_status,
         r.cancelled_at AS reservation_cancelled_at,
        ${LIFECYCLE_KEY_SQL} AS lifecycle_key,
        ${STANDALONE_SHEET_SQL} AS standalone_sheet
      FROM transactions t
      LEFT JOIN suppliers s ON s.id = t.supplier_id
      LEFT JOIN reservations r ON r.id = t.reservation_id
      LEFT JOIN bookings b ON b.id = COALESCE(t.booking_id, r.booking_id)
      WHERE t.property_id = $1
        AND t.deleted_at IS NULL
        ${extraSql}
    ),
    search_keys AS (
      SELECT DISTINCT l.lifecycle_key
      FROM live l
      JOIN transactions t ON t.id = l.id
      LEFT JOIN suppliers s ON s.id = t.supplier_id
      LEFT JOIN reservations r ON r.id = t.reservation_id
      LEFT JOIN bookings b ON b.id = COALESCE(t.booking_id, r.booking_id)
      WHERE $${searchIdx}::text IS NULL
         OR t.transaction_no ILIKE $${searchIdx}
         OR t.description ILIKE $${searchIdx}
         OR t.source_reference ILIKE $${searchIdx}
         OR t.party_name ILIKE $${searchIdx}
         OR s.name ILIKE $${searchIdx}
         OR t.guest_name_snapshot ILIKE $${searchIdx}
         OR t.room_number_snapshot ILIKE $${searchIdx}
         OR t.notes ILIKE $${searchIdx}
         OR b.bid ILIKE $${searchIdx}
         OR r.booking_number ILIKE $${searchIdx}
         OR r.guest_name ILIKE $${searchIdx}
    ),
    lifecycle_nets AS (
      SELECT l.lifecycle_key, SUM(l.net_amount)::bigint AS effective_net
      FROM live l
      GROUP BY l.lifecycle_key
    ),
    primaries AS (
      SELECT DISTINCT ON (l.lifecycle_key)
        l.*,
        n.effective_net
      FROM live l
      JOIN lifecycle_nets n ON n.lifecycle_key = l.lifecycle_key
      WHERE l.lifecycle_key IN (SELECT lifecycle_key FROM search_keys)
      ORDER BY l.lifecycle_key, ${PRIMARY_STATUS_RANK_SQL.replace(/t\./g, 'l.')}, l.id DESC
    ),
    primaries_with_effective_date AS (
      SELECT p.*,
        CASE
          WHEN UPPER(p.transaction_type) = 'SALE'
               AND (UPPER(p.reservation_status) = 'CANCELLED'
                    OR UPPER(p.reservation_stay_status) = 'CANCELLED')
               AND p.reservation_cancelled_at IS NOT NULL
          THEN p.reservation_cancelled_at::date
          ELSE p.transaction_date
        END AS effective_period_date
      FROM primaries p
    ),
    dated AS (
      SELECT ped.*
      FROM primaries_with_effective_date ped
      WHERE ($${startIdx}::date IS NULL OR ped.effective_period_date >= $${startIdx}::date)
        AND ($${endIdx}::date IS NULL OR ped.effective_period_date <= $${endIdx}::date)
    ),
    booking_sheets AS (
      SELECT b.property_id, b.bid,
        CASE
          WHEN COUNT(r.id) > 0
            AND COUNT(r.id) FILTER (
              WHERE
                UPPER(COALESCE(r.status, '')) = 'CANCELLED'
                OR UPPER(COALESCE(r.stay_status, '')) = 'CANCELLED'
            ) = COUNT(r.id)
          THEN 'BATAL'
          WHEN COUNT(r.id) > 0
            AND COUNT(r.id) FILTER (WHERE UPPER(r.status) = 'CHECKED_OUT') = COUNT(r.id)
          THEN 'SELESAI'
          ELSE 'PROSES'
        END AS booking_sheet
      FROM bookings b
      JOIN reservations r ON r.booking_id = b.id
      WHERE b.property_id = $1
      GROUP BY b.property_id, b.bid
    ),
    presented AS (
      SELECT
        CASE
          WHEN UPPER(d.transaction_type) = 'SALE'
           AND BTRIM(COALESCE(d.booking_bid, '')) <> ''
          THEN 'bid:' || d.property_id::text || ':' || BTRIM(d.booking_bid)
          ELSE 'tx:' || d.id::text
        END AS presented_key,
        MAX(COALESCE(d.effective_period_date, d.transaction_date)) AS sort_date,
        MAX(d.transaction_time) AS sort_time,
        MAX(d.id) AS sort_id,
        BOOL_OR(UPPER(d.transaction_type) = 'SALE') AS has_sale,
        BOOL_OR(UPPER(d.transaction_type) = 'PURCHASE') AS has_purchase,
        BOOL_OR(UPPER(d.transaction_type) = 'EXPENSE') AS has_expense,
        BOOL_OR(UPPER(d.transaction_type) = 'INCOME') AS has_income,
        SUM(CASE WHEN UPPER(d.transaction_type) = 'SALE' THEN d.effective_net ELSE 0 END) AS sale_net,
        SUM(CASE WHEN UPPER(d.transaction_type) = 'PURCHASE' THEN d.effective_net ELSE 0 END) AS purchase_net,
        SUM(CASE WHEN UPPER(d.transaction_type) = 'EXPENSE' THEN d.effective_net ELSE 0 END) AS expense_net,
        SUM(CASE WHEN UPPER(d.transaction_type) = 'INCOME' THEN d.effective_net ELSE 0 END) AS income_net,
        MAX(d.booking_bid) AS booking_bid,
        CASE
          WHEN BOOL_OR(
            UPPER(COALESCE(d.transaction_status, ''))
              IN ('VOIDED', 'CANCELLED', 'REVERSED')
          )
          THEN 'BATAL'
          ELSE MAX(COALESCE(bs.booking_sheet, d.standalone_sheet))
        END AS operational_sheet,
        ARRAY_AGG(d.id) AS member_ids
      FROM dated d
      LEFT JOIN booking_sheets bs
        ON bs.property_id = d.property_id
       AND bs.bid = d.booking_bid
       AND UPPER(d.transaction_type) = 'SALE'
       AND BTRIM(COALESCE(d.booking_bid, '')) <> ''
      GROUP BY 1
    ),
    filtered AS (
      SELECT *
      FROM presented
      WHERE $${sheetIdx}::text = '' OR operational_sheet = $${sheetIdx}
    )
    SELECT
      (SELECT COUNT(*)::int FROM filtered) AS total_count,
      (SELECT COALESCE(SUM(sale_net), 0) FROM filtered WHERE has_sale) AS total_sale,
      (SELECT COALESCE(SUM(purchase_net), 0) FROM filtered WHERE has_purchase) AS total_purchase,
      (SELECT COALESCE(SUM(expense_net), 0) FROM filtered WHERE has_expense) AS total_expense,
      (SELECT COALESCE(SUM(income_net), 0) FROM filtered WHERE has_income) AS total_income,
      (SELECT COUNT(*)::int FROM filtered WHERE has_sale) AS count_sale,
      (SELECT COUNT(*)::int FROM filtered WHERE has_purchase) AS count_purchase,
      (SELECT COUNT(*)::int FROM filtered WHERE has_expense) AS count_expense,
      (SELECT COUNT(*)::int FROM filtered WHERE has_income) AS count_income,
      (SELECT COUNT(*)::int FROM filtered WHERE operational_sheet = 'PROSES') AS sheet_proses,
      (SELECT COUNT(*)::int FROM filtered WHERE operational_sheet = 'SELESAI') AS sheet_selesai,
      (SELECT COUNT(*)::int FROM filtered WHERE operational_sheet = 'BATAL') AS sheet_batal,
      COALESCE(
        (
          SELECT JSON_AGG(page_row)
          FROM (
             SELECT JSON_BUILD_OBJECT(
               'presented_key', presented_key,
               'booking_bid', booking_bid,
               'member_ids', member_ids,
               'effective_period_date', sort_date
             ) AS page_row
            FROM filtered
            ORDER BY sort_date DESC, sort_time DESC, sort_id DESC
            LIMIT $${limitIdx} OFFSET $${offsetIdx}
          ) paged
        ),
        '[]'::json
      ) AS page_keys
  `;

  const res = await pool.query(sql, values);
  const row = res.rows[0] || {};
  const pageKeys = Array.isArray(row.page_keys) ? row.page_keys : [];
  const keys: string[] = [];
  const bids: string[] = [];
  const transactionIds: number[] = [];
  for (const item of pageKeys) {
    const key = String(item.presented_key || '');
    if (key) keys.push(key);
    const bid = String(item.booking_bid || '').trim();
    if (key.startsWith('bid:') && bid) bids.push(bid);
    const ids = Array.isArray(item.member_ids) ? item.member_ids : [];
    for (const id of ids) {
      const numeric = Number(id);
      if (Number.isInteger(numeric) && numeric > 0) transactionIds.push(numeric);
    }
  }

  const effectiveDateMap = new Map<string, string>();
  for (const item of pageKeys) {
    const ed = String(item.effective_period_date || '');
    if (ed) effectiveDateMap.set(String(item.presented_key), ed);
  }

  return {
    keys,
    bids: [...new Set(bids)],
    transactionIds: [...new Set(transactionIds)],
    total_count: Number(row.total_count || 0),
    summary: {
      total_sale: Number(row.total_sale || 0),
      total_purchase: Number(row.total_purchase || 0),
      total_expense: Number(row.total_expense || 0),
      total_income: Number(row.total_income || 0),
      count_sale: Number(row.count_sale || 0),
      count_purchase: Number(row.count_purchase || 0),
      count_expense: Number(row.count_expense || 0),
      count_income: Number(row.count_income || 0),
    },
    sheet_counts: {
      proses: Number(row.sheet_proses || 0),
      selesai: Number(row.sheet_selesai || 0),
      batal: Number(row.sheet_batal || 0),
      hapus: hapusCount,
    },
    effective_date_map: Object.fromEntries(effectiveDateMap.entries()),
  };
}

/** Presented list item key: one BID group or one standalone row. */
export function presentedListKey(row: {
  id?: unknown;
  property_id?: unknown;
  transaction_type?: unknown;
  booking_bid?: unknown;
  booking_bid_group?: { bid?: unknown };
}, propertyId: number): string {
  const type = String(row.transaction_type || '').toUpperCase();
  const bid = String(row.booking_bid_group?.bid || row.booking_bid || '').trim();
  if (type === 'SALE' && bid) return `bid:${propertyId}:${bid}`;
  return `tx:${Number(row.id)}`;
}

export function emptyPresentedPlan(hapusCount: number): PresentedPagePlan {
  return {
    keys: [],
    bids: [],
    transactionIds: [],
    total_count: 0,
    summary: emptySummary(),
    sheet_counts: { proses: 0, selesai: 0, batal: 0, hapus: hapusCount },
    effective_date_map: {},
  };
}

export function attachFetchStats(
  result: TransactionQueryResult,
  stats: TransactionListFetchStats
): TransactionQueryResult & { list_fetch_stats: TransactionListFetchStats } {
  return { ...result, list_fetch_stats: stats };
}
