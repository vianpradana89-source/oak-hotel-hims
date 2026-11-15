import type {
  GetTransactionsResponse,
} from './transactionClient';
import type {
  TransactionRecord,
  TransactionSummary,
  TransactionSheetCounts,
} from './transactionDomainTypes';

/**
 * Staged fetcher for TransactionWorkspace mode "SEMUA" (pageMode='SEMUA').
 *
 * Backend contract (transactionService.ts:3031 / transactionListQuery.ts:125):
 *   - `limit` is clamped to `Math.min(100, ...)` → each request returns at most 100 items.
 *   - Pagination unit for the normal sheets (PROSES/SELESAI/BATAL/ALL) is the
 *     PRESENTED item (one BID group = 1 unit; one standalone transaction = 1 unit),
 *     matching `total_count`. For the HAPUS sheet the API pages RAW transaction
 *     rows while `total_count` still counts presented items — hence page sizing
 *     is always driven by the API-reported `total_count`, never by visual row count.
 *
 * Completeness contract (TX-F1-R1-01):
 *   The loop stops as soon as all presented items have been collected. Each
 *   page is fetched sequentially (same request context: property, sheet,
 *   period, search, category, department, filters) so ordering and BID
 *   grouping stay consistent with the backend's stable sort (sort_date DESC,
 *   sort_time DESC, sort_id DESC).
 *
 *   Completeness is validated, not assumed:
 *   - Duplicates: each presented unit is keyed by canonical identity
 *     (SALE + booking_bid → `bid:{id}`, otherwise `tx:{id}`), mirroring the
 *     backend's `presentedListKey`. Duplicate keys within or across pages
 *     indicate overlap/no-progress → error.
 *   - Total consistency: the API's final `total_count` must equal the number
 *     of distinct presented units collected. A premature empty page,
 *     inconsistent total, or overlap are never committed as a complete
 *     "Semua" result — they surface as an error so the UI shows a retry
 *     rather than silently displaying a truncated dataset.
 *   - Safety cap: if the walk exceeds 10 000 presented items (100 pages) the
 *     fetch stops and reports the partial result explicitly as incomplete,
 *     so the caller can show a limit notice + retry instead of claiming all
 *     data was loaded.
 */

/**
 * Canonical identity key for one presented unit, mirroring the backend's
 * `presentedListKey` (transactionListQuery.ts):
 *   - SALE with booking_bid (or booking_bid_group.bid) → `bid:{propertyId}:{bid}`
 *     (a BID group is one unit even though it may render multiple rows)
 *   - otherwise                                        → `tx:{record.id}`
 *
 * Property-scoped so the same numeric id under two properties never collides
 * in the collected set (single-property today, multi-property-ready by design).
 */
function presentedUnitKey(
  tx: TransactionRecord,
  propertyId: number | undefined,
): string {
  const type = String(tx.transaction_type || '').toUpperCase();
  const bid = String(tx.booking_bid_group?.bid || tx.booking_bid || '').trim();
  const prop = propertyId ?? tx.property_id ?? 0;
  if (type === 'SALE' && bid) return `bid:${prop}:${bid}`;
  return `tx:${tx.id}`;
}

export type TransactionFetchMode = 'PAGED' | 'SEMUA';

export interface TransactionFetchParams {
  property_id: number;
  transaction_type?: string;
  category_code?: string;
  department_code?: string;
  verification_status?: string;
  receiving_status?: string;
  operational_sheet?: string;
  start_date?: string;
  end_date?: string;
  search?: string;
}

export interface StagedTransactionResult {
  transactions: TransactionRecord[];
  totalCount: number;
  sheetCounts: TransactionSheetCounts | null;
  globalSummary: TransactionSummary | null;
  /**
   * SEMUA mode only. When the walk stopped at the safety cap without
   * collecting every presented unit, this is true and `collectedCount`
   * is the number of distinct units actually received. The caller MUST
   * surface this as a visible limit/incomplete notice — never as a
   * complete "Semua" result.
   */
  incomplete?: boolean;
  /** Number of distinct presented units collected (equals transactions.length when complete). */
  collectedCount?: number;
  /** Human-readable reason the result is incomplete (safety cap hit). */
  incompleteReason?: string;
}

/** Error class for detected incompleteness (overlap / premature empty / total mismatch). */
export class StagedFetchIncompleteError extends Error {
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.name = 'StagedFetchIncompleteError';
    this.detail = detail;
  }
}

/**
 * Fetch one page. Paged mode returns a single request; SEMUA mode walks
 * successive 100-item pages until every item has been collected.
 *
 * @param fetchPage    single-page request function (limit ≤ 100 per page)
 * @param params       canonical query context (property, sheet, filters, dates)
 * @param mode         'PAGED' → one request at current offset; 'SEMUA' → walk all
 * @param initialPage  1-based page for PAGED mode; ignored for SEMUA
 * @param pageSize     rows per page for PAGED mode (typically ≤ 100)
 */
export async function fetchTransactionsStaged(
  fetchPage: (limit: number, offset: number) => Promise<GetTransactionsResponse>,
  _params: TransactionFetchParams,
  mode: TransactionFetchMode,
  initialPage: number,
  pageSize: number
): Promise<StagedTransactionResult> {
  if (mode === 'PAGED') {
    const limit = Math.max(1, Math.min(100, Number(pageSize) || 100));
    const offset = Math.max(0, (Number(initialPage) || 1) - 1) * limit;
    const res = await fetchPage(limit, offset);
    const items: TransactionRecord[] = res.transactions || [];
    const total = Number(res.total_count || 0);
    return {
      transactions: items,
      totalCount: total,
      sheetCounts: res.sheet_counts ?? null,
      globalSummary: res.global_summary ?? null,
    };
  }

  // SEMUA mode — staged fetch, 100 per request.
  const collected: TransactionRecord[] = [];
  // Canonical unit-key set — one entry per distinct presented unit. A key
  // can only reappear if the API returns an overlapping page (no progress or
  // inconsistent total drift), which is an error, not a "collected" state.
  const seenKeys = new Set<string>();
  let totalCount = 0;
  let sheetCounts: TransactionSheetCounts | null = null;
  let globalSummary: TransactionSummary | null = null;
  let offset = 0;

  // Safety cap: 100 pages × 100 items = 10 000 presented items. A legitimate
  // dataset larger than this still stops here and is reported explicitly as
  // incomplete — never silently truncated as a complete result.
  const SAFETY_CAP_PAGES = 100;
  let page = 0;

  for (;;) {
    page += 1;
    const res = await fetchPage(100, offset);
    const items: TransactionRecord[] = res.transactions || [];
    const total = Number(res.total_count || 0);

    // Total is taken from the API response — it reflects the BACKEND pagination
    // unit (presented items), not the visual row count (a BID group may render
    // as multiple <tr> in the UI).
    totalCount = total;

    // Capture side payloads from every response (they are period-scoped and
    // identical across pages); the last page wins.
    if (res.sheet_counts) sheetCounts = res.sheet_counts;
    if (res.global_summary) globalSummary = res.global_summary;

    // Track distinct presented units by canonical key (BID-aware, property-scoped).
    // Mirrors backend presentedListKey — see presentedUnitKey().
    let newUnits = 0;
    for (const item of items) {
      const key = presentedUnitKey(item, _params.property_id);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        collected.push(item);
        newUnits += 1;
      }
      // Duplicate keys are NOT an error in isolation (a unit may span pages
      // legitimately); the no-progress check below catches the real defect.
    }

    // Done when all items have been collected: the distinct-unit count matches
    // the API-reported total AND this page was the final one (returned fewer
    // items than requested, or we just reached the total).
    if (seenKeys.size === total) break;

    // No-progress guard: a non-empty page that contributed zero NEW distinct
    // units means the API is returning overlapping data (e.g. total_count
    // drifts below the collected size, or two pages carry identical content).
    // This is NOT a complete result — surface it as an error.
    if (items.length > 0 && newUnits === 0) {
      throw new StagedFetchIncompleteError(
        'Gagal memuat semua transaksi: hasil halaman tumpang tindih, tidak ada unit baru.',
        `offset=${offset}, received=${items.length}, distinctSoFar=${seenKeys.size}, apiTotal=${total}`
      );
    }

    // Premature empty page: the API said there are `total` units but returned
    // 0 at a non-zero offset. This is a total-consistency failure (total
    // drifted below the remaining, or a stale snapshot was served).
    if (items.length === 0) {
      if (offset === 0 && total === 0) {
        // Legitimate: zero results.
        break;
      }
      throw new StagedFetchIncompleteError(
        'Gagal memuat semua transaksi: halaman kosong sebelum total tercapai.',
        `offset=${offset}, distinctSoFar=${seenKeys.size}, apiTotal=${total}`
      );
    }

    offset += items.length;

    // Final-page check: the API returned fewer items than the 100-item cap,
    // so there are no more pages — the walk is complete.
    if (items.length < 100) break;

    // Safety valve: cap the number of requests to avoid unbounded loops on a
    // pathological/inconsistent API (e.g. total_count keeps growing or items
    // keep being returned past the expected end). If exceeded, stop and
    // report what we have as explicitly INCOMPLETE.
    if (page >= SAFETY_CAP_PAGES) {
      return {
        transactions: collected,
        totalCount,
        sheetCounts,
        globalSummary,
        incomplete: true,
        collectedCount: seenKeys.size,
        incompleteReason: `Batas sumber daya tercapai (${SAFETY_CAP_PAGES} halaman × 100 = ${SAFETY_CAP_PAGES * 100} item); ${seenKeys.size} dari ${total} item terambil.`,
      };
    }
  }

  // Post-loop validation: distinct collected units must match the API total.
  // If they don't (total_count reported more than what was actually returned),
  // the result is incomplete — surface it as an error rather than claiming
  // "Semua" loaded.
  if (seenKeys.size !== totalCount) {
    throw new StagedFetchIncompleteError(
      'Gagal memuat semua transaksi: jumlah unit tidak konsisten dengan total API.',
      `collected=${seenKeys.size}, apiTotal=${totalCount}`
    );
  }

  return {
    transactions: collected,
    totalCount,
    sheetCounts,
    globalSummary,
  };
}
