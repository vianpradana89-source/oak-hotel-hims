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
  /** Per-tab summary — follows active domain/tab + selected sheet. Kept for existing contracts. */
  summary: TransactionSummary;
  /** Sheet counts — domain-filtered but independent of selected operational_sheet (SCOPE B). */
  sheet_counts: TransactionSheetCounts;
  /** Global period summary — independent of activeTab/operational_sheet (SCOPE A). */
  global_summary: TransactionSummary;
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
 * Compute scopeBFilterActive: true when ANY Scope-B filter param is supplied.
 * Scope B = active transaction_type + search + advanced filters.
 * NOT included: operational_sheet (Scope C), start_date/end_date (Scope A), limit/offset.
 */
function computeScopeBFilterActive(params: TransactionFilterParams): boolean {
  return Boolean(
    params.transaction_type ||
    (params.search && params.search.trim()) ||
    params.source_type ||
    params.category_code ||
    params.department_code ||
    params.payment_status ||
    params.payment_method ||
    params.verification_status ||
    params.receiving_status ||
    params.transaction_status ||
    params.supplier_id ||
    params.reservation_id ||
    params.booking_id ||
    (params.party_name && params.party_name.trim())
  );
}

/**
 * All Time / unbounded list: page at PRESENTED item keys in SQL.
 * Scope A = property + date period only.
 * Scope B = canonical presented rows intersected with eligible lifecycle keys.
 * Scope C = Scope B filtered by active operational_sheet.
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
  const scopeBFilterActive = computeScopeBFilterActive(params);

  // --- Parameter building ---
  // SCOPE A base: property_id only ($1)
  const values: any[] = [propertyId];
  let idx = 2;

  // SCOPE B filter params (NULL-wildcard pattern — empty string/NULL means no filter)
  if (listType) { values.push(listType); } else { values.push(null); }
  const txTypeIdx = idx++;
  if (params.source_type) { values.push(params.source_type); } else { values.push(null); }
  const sourceTypeIdx = idx++;
  if (params.category_code) { values.push(params.category_code); } else { values.push(null); }
  const categoryIdx = idx++;
  if (params.department_code) { values.push(params.department_code); } else { values.push(null); }
  const deptIdx = idx++;
  if (params.payment_status) { values.push(params.payment_status); } else { values.push(null); }
  const payStatusIdx = idx++;
  if (params.payment_method) { values.push(params.payment_method); } else { values.push(null); }
  const payMethodIdx = idx++;
  if (params.verification_status) { values.push(params.verification_status); } else { values.push(null); }
  const verifIdx = idx++;
  if (params.receiving_status) { values.push(params.receiving_status); } else { values.push(null); }
  const recvIdx = idx++;
  if (params.transaction_status) { values.push(String(params.transaction_status).toUpperCase()); } else { values.push(null); }
  const txStatusIdx = idx++;
  if (params.supplier_id) { values.push(params.supplier_id); } else { values.push(null); }
  const supplierIdx = idx++;
  if (params.reservation_id) { values.push(params.reservation_id); } else { values.push(null); }
  const resvIdx = idx++;
  if (params.booking_id) {
    values.push(String(params.booking_id));
  } else {
    values.push(null);
  }
  const bookingIdx = idx++;
  if (params.party_name && params.party_name.trim()) {
    values.push(`%${params.party_name.trim()}%`);
  } else {
    values.push(null);
  }
  const partyIdx = idx++;
  if (search !== null) { values.push(search); } else { values.push(null); }
  const searchIdx = idx++;
  // SCOPE A period (start/end)
  if (startDate) { values.push(startDate); } else { values.push(null); }
  const startIdx = idx++;
  if (endDate) { values.push(endDate); } else { values.push(null); }
  const endIdx = idx++;
  // SCOPE C: operational_sheet
  values.push(targetSheet === 'PROSES' || targetSheet === 'SELESAI' || targetSheet === 'BATAL' ? targetSheet : '');
  const sheetIdx = idx++;
  // Pagination
  values.push(limit);
  const limitIdx = idx++;
  values.push(offset);
  const offsetIdx = idx++;
  // Scope B filter active gate
  values.push(scopeBFilterActive);
  const gateIdx = idx++;

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
        t.category_code,
        t.department_code,
        t.payment_status,
        t.payment_method,
        t.party_name,
        t.guest_name_snapshot,
        t.room_number_snapshot,
        t.notes,
        t.transaction_no,
        t.source_reference,
        t.description,
        t.net_amount,
        t.correction_group_id,
        t.reversal_of_transaction_id,
        t.metadata,
        t.verification_status,
        t.reservation_id,
        t.supplier_id,
        t.booking_id,
        b.bid AS booking_bid,
        b.payment_responsibility AS payment_responsibility,
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
      -- NOTE: NO Scope-B filters here. live is pure SCOPE A base.
    ),

    -- =========================================================
    -- LIFECYCLE CANONICAL (computed ONCE on full Scope A base)
    -- =========================================================
    lifecycle_nets AS (
      SELECT l.lifecycle_key, SUM(l.net_amount)::bigint AS effective_net
      FROM live l
      GROUP BY l.lifecycle_key
    ),
    lifecycle_audit AS (
      SELECT
        l.lifecycle_key,
        BOOL_OR(
          UPPER(l.transaction_type) = 'SALE'
          AND UPPER(COALESCE(l.source_type, '')) NOT IN ('POS', 'POS_ORDER')
          AND (l.reservation_id > 0
               OR l.reservation_status <> ''
               OR l.reservation_stay_status <> '')
          AND l.verification_status = 'REJECTED'
        ) AS lifecycle_reservation_rejected
      FROM live l
      GROUP BY l.lifecycle_key
    ),
    primaries AS (
      SELECT DISTINCT ON (l.lifecycle_key)
        l.*,
        n.effective_net,
        la.lifecycle_reservation_rejected
      FROM live l
      JOIN lifecycle_nets n ON n.lifecycle_key = l.lifecycle_key
      LEFT JOIN lifecycle_audit la ON la.lifecycle_key = l.lifecycle_key
      ORDER BY l.lifecycle_key, ${PRIMARY_STATUS_RANK_SQL.replace(/t\./g, 'l.')}, l.id DESC
    ),
    primaries_effective AS (
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
    period_primed AS (
      SELECT pe.*
      FROM primaries_effective pe
      WHERE ($${startIdx}::date IS NULL OR pe.effective_period_date >= $${startIdx}::date)
        AND ($${endIdx}::date IS NULL OR pe.effective_period_date <= $${endIdx}::date)
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
            AND COUNT(r.id) FILTER(WHERE UPPER(r.status) = 'CHECKED_OUT') = COUNT(r.id)
          THEN 'SELESAI'
          ELSE 'PROSES'
        END AS booking_sheet
      FROM bookings b
      JOIN reservations r ON r.booking_id = b.id
      WHERE b.property_id = $1
      GROUP BY b.property_id, b.bid
    ),

    -- =========================================================
    -- SCOPE A: canonical presented (full, unfiltered by domain/search)
    -- Each row retains lifecycle_keys for Scope-B overlap matching.
    -- =========================================================
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
          -- Rule A: transaction-level terminal status always wins.
          WHEN NOT (
            BOOL_OR(UPPER(d.transaction_type) = 'SALE')
            AND BOOL_OR(BTRIM(COALESCE(d.booking_bid, '')) <> '')
          )
          AND BOOL_OR(
            UPPER(COALESCE(d.transaction_status, ''))
              IN ('VOIDED', 'CANCELLED', 'REVERSED')
          ) THEN 'BATAL'
          -- Rule B: booking_sheet BATAL (cancelled reservation/lifecycle) wins
          -- over the audit overlay — prevents REJECTED from overriding a
          -- cancelled stay.
          WHEN BOOL_OR(bs.booking_sheet = 'BATAL') THEN 'BATAL'
          -- Rule C: audit overlay — reservation-linked non-POS SALE with
          -- effective REJECTED becomes PROSES.
          WHEN BOOL_OR(UPPER(d.transaction_type) = 'SALE')
            AND BOOL_OR(d.lifecycle_reservation_rejected)
          THEN 'PROSES'
          -- Rule D: default to canonical sheet (booking_sheet or standalone).
          ELSE MAX(COALESCE(bs.booking_sheet, d.standalone_sheet))
        END AS operational_sheet,
        ARRAY_AGG(DISTINCT d.lifecycle_key) AS lifecycle_keys,
        ARRAY_AGG(d.id) AS member_ids
      FROM period_primed d
      LEFT JOIN booking_sheets bs
        ON bs.property_id = d.property_id
       AND bs.bid = d.booking_bid
       AND UPPER(d.transaction_type) = 'SALE'
       AND BTRIM(COALESCE(d.booking_bid, '')) <> ''
      GROUP BY 1
    ),

    -- =========================================================
    -- SCOPE B ELIGIBLE KEYS: derived from raw/live members,
    -- applying all Scope-B filters (transaction_type, search,
    -- category, etc.) WITHOUT recomputing lifecycle aggregation.
    -- Produces one row with eligible_keys text[] (empty if zero match).
    -- =========================================================
    scope_b_eligible_lk AS (
      SELECT COALESCE(
        ARRAY_AGG(DISTINCT l.lifecycle_key),
        '{}'::text[]
      ) AS eligible_keys
      FROM live l
      LEFT JOIN suppliers s ON s.id = l.supplier_id
      LEFT JOIN reservations r ON r.id = l.reservation_id
      LEFT JOIN bookings b ON b.id = COALESCE(l.booking_id, r.booking_id)
      WHERE ($${txTypeIdx}::text IS NULL
             OR UPPER(l.transaction_type) = $${txTypeIdx})
        AND ($${sourceTypeIdx}::text IS NULL OR l.source_type = $${sourceTypeIdx})
        AND ($${categoryIdx}::text IS NULL OR l.category_code = $${categoryIdx})
        AND ($${deptIdx}::text IS NULL OR l.department_code = $${deptIdx})
        AND ($${payStatusIdx}::text IS NULL OR l.payment_status = $${payStatusIdx})
        AND ($${payMethodIdx}::text IS NULL OR l.payment_method = $${payMethodIdx})
        AND ($${verifIdx}::text IS NULL OR l.verification_status = $${verifIdx})
        AND ($${recvIdx}::text IS NULL OR l.receiving_status = $${recvIdx})
        AND ($${txStatusIdx}::text IS NULL
             OR UPPER(l.transaction_status) = $${txStatusIdx})
        AND ($${supplierIdx}::bigint IS NULL OR l.supplier_id = $${supplierIdx})
        AND ($${resvIdx}::bigint IS NULL OR l.reservation_id = $${resvIdx})
        AND ($${bookingIdx}::text IS NULL
             OR (l.booking_id::text = $${bookingIdx} OR b.bid = $${bookingIdx}))
        AND ($${partyIdx}::text IS NULL
             OR l.party_name ILIKE $${partyIdx}
             OR s.name ILIKE $${partyIdx})
        AND ($${searchIdx}::text IS NULL
             OR l.transaction_no ILIKE $${searchIdx}
             OR l.description ILIKE $${searchIdx}
             OR l.source_reference ILIKE $${searchIdx}
             OR l.party_name ILIKE $${searchIdx}
             OR s.name ILIKE $${searchIdx}
             OR l.guest_name_snapshot ILIKE $${searchIdx}
             OR l.room_number_snapshot ILIKE $${searchIdx}
             OR l.notes ILIKE $${searchIdx}
             OR b.bid ILIKE $${searchIdx}
             OR r.booking_number ILIKE $${searchIdx}
             OR r.guest_name ILIKE $${searchIdx})
    ),

    -- =========================================================
    -- SCOPE B: domain-scoped = presented ∩ eligible lifecycle keys
    -- Gate: when scopeBFilterActive=false, ALL presented rows pass.
    -- When scopeBFilterActive=true AND eligible_keys empty → ZERO rows.
    -- =========================================================
    domain_scoped AS (
      SELECT p.*
      FROM presented p
      CROSS JOIN scope_b_eligible_lk e
      WHERE NOT $${gateIdx}::bool
         OR p.lifecycle_keys && e.eligible_keys
    ),

    -- =========================================================
    -- SCOPE C: table rows filtered by active operational_sheet
    -- =========================================================
    filtered AS (
      SELECT *
      FROM domain_scoped
      WHERE $${sheetIdx}::text = '' OR operational_sheet = $${sheetIdx}
    )
    SELECT
      /* SCOPE C — table-scoped values */
      (SELECT COUNT(*)::int FROM filtered) AS total_count,
      (SELECT COALESCE(SUM(sale_net), 0) FROM filtered WHERE has_sale) AS total_sale,
      (SELECT COALESCE(SUM(purchase_net), 0) FROM filtered WHERE has_purchase) AS total_purchase,
      (SELECT COALESCE(SUM(expense_net), 0) FROM filtered WHERE has_expense) AS total_expense,
      (SELECT COALESCE(SUM(income_net), 0) FROM filtered WHERE has_income) AS total_income,
      (SELECT COUNT(*)::int FROM filtered WHERE has_sale) AS count_sale,
      (SELECT COUNT(*)::int FROM filtered WHERE has_purchase) AS count_purchase,
      (SELECT COUNT(*)::int FROM filtered WHERE has_expense) AS count_expense,
      (SELECT COUNT(*)::int FROM filtered WHERE has_income) AS count_income,
      /* SCOPE B — sheet counters, independent of selected sheet */
      (SELECT COUNT(*)::int FROM domain_scoped WHERE operational_sheet = 'PROSES') AS sheet_proses,
      (SELECT COUNT(*)::int FROM domain_scoped WHERE operational_sheet = 'SELESAI') AS sheet_selesai,
      (SELECT COUNT(*)::int FROM domain_scoped WHERE operational_sheet = 'BATAL') AS sheet_batal,
      /* SCOPE A — global summary, from FULL presented (no Scope-B filter) */
      (SELECT COALESCE(SUM(sale_net), 0) FROM presented WHERE has_sale) AS global_total_sale,
      (SELECT COALESCE(SUM(purchase_net), 0) FROM presented WHERE has_purchase) AS global_total_purchase,
      (SELECT COALESCE(SUM(expense_net), 0) FROM presented WHERE has_expense) AS global_total_expense,
      (SELECT COALESCE(SUM(income_net), 0) FROM presented WHERE has_income) AS global_total_income,
      (SELECT COUNT(*)::int FROM presented WHERE has_sale) AS global_count_sale,
      (SELECT COUNT(*)::int FROM presented WHERE has_purchase) AS global_count_purchase,
      (SELECT COUNT(*)::int FROM presented WHERE has_expense) AS global_count_expense,
      (SELECT COUNT(*)::int FROM presented WHERE has_income) AS global_count_income,
      /* SCOPE C — pagination keys */
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
    global_summary: {
      total_sale: Number(row.global_total_sale || 0),
      total_purchase: Number(row.global_total_purchase || 0),
      total_expense: Number(row.global_total_expense || 0),
      total_income: Number(row.global_total_income || 0),
      count_sale: Number(row.global_count_sale || 0),
      count_purchase: Number(row.global_count_purchase || 0),
      count_expense: Number(row.global_count_expense || 0),
      count_income: Number(row.global_count_income || 0),
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
    global_summary: emptySummary(),
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
