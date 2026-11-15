/**
 * TX-F1-R1-03: Pure helpers for the transaction list pagination footer.
 * Extracted for testability without a React mount.
 *
 * All calculations use the API-reported `totalCount` (presented items),
 * NOT the expanded BID row count.
 */

/**
 * Builds a compact page-number list for the footer.
 *
 * Rules:
 *   - totalPages ≤ 7  → every page number (no ellipsis)
 *   - totalPages > 7  → [1, …, lo, cur, hi, …, totalPages]
 *     where lo = max(2, cur-1), hi = min(total-1, cur+1)
 *     "…" marks a gap; the current page is always shown.
 *
 * @param current  1-based active page
 * @param total    total number of pages (≥ 1)
 */
export function buildPageNumbers(
  current: number,
  total: number
): Array<number | 'ellipsis'> {
  const safeTotal = Math.max(1, total);
  const safeCurrent = Math.max(1, Math.min(current, safeTotal));

  if (safeTotal <= 7) {
    return Array.from({ length: safeTotal }, (_, i) => i + 1);
  }

  const result: Array<number | 'ellipsis'> = [1];
  const lo = Math.max(2, safeCurrent - 1);
  const hi = Math.min(safeTotal - 1, safeCurrent + 1);

  if (lo > 2) result.push('ellipsis');
  for (let p = lo; p <= hi; p++) result.push(p);
  if (hi < safeTotal - 1) result.push('ellipsis');
  result.push(safeTotal);

  return result;
}

/**
 * Returns the 1-based range of presented items shown on a given page.
 *
 * @param page     1-based active page
 * @param pageSize items per page (API cap 100)
 * @param total    API-reported total presented items (0 allowed)
 * @returns [start, end] — both 0 when total === 0
 */
export function rangeForPage(
  page: number,
  pageSize: number,
  total: number
): [number, number] {
  const safeTotal = Math.max(0, total);
  if (safeTotal === 0) return [0, 0];
  const safePage = Math.max(1, Math.min(page, Math.ceil(safeTotal / pageSize)));
  const start = (safePage - 1) * pageSize + 1;
  const end = Math.min(safePage * pageSize, safeTotal);
  return [start, end];
}

// ---------------------------------------------------------------------------
// TX-F1-R2-01: Footer status-gate
//
// Pure helper that the component's footer IIFE calls to decide what to render
// based on the current query lifecycle state.
//
// The critical invariant (reviewer repro):
//   - While a query is LOADING or has FAILED (ERROR), the previous totalCount
//     must NOT be presented as a valid result of the current query.
//   - The Baris dropdown remains fully functional in every state so the user
//     can switch to 30/50/100 or exit "Semua" at any time.
// ---------------------------------------------------------------------------

export type QueryStatus = 'IDLE' | 'LOADING' | 'ERROR' | 'SUCCESS';

export interface FooterDisplayState {
  /** Whether the "Baris per halaman" dropdown is rendered (always true). */
  showDropdown: true;
  /** Which option is selected in the dropdown ('semua' or the page size). */
  dropdownValue: string;
  /** Loading spinner (query in flight). */
  showLoadingSpinner: boolean;
  /** Retry hint text shown when queryStatus === 'ERROR'. */
  showErrorHint: boolean;
  /** Whether the count/range label (e.g. "Menampilkan 245 transaksi (Semua)")
   *  or the PAGED range (e.g. "31–60 dari 245") is shown.
   *  Only true when queryStatus === 'SUCCESS'. */
  showCountLabel: boolean;
  /** Page-navigation buttons (‹, numbers, ›) — only when SUCCESS + PAGED
   *  + totalPages > 1. */
  showPageNav: boolean;
  /** "Kembali ke halaman" button (SEMUA mode, when queryStatus !== 'LOADING'). */
  showReturnToPageButton: boolean;
  /** Pre-computed compact page-number list (null when not shown). */
  pageNumbers: Array<number | 'ellipsis'> | null;
  /** Human-readable right-side content string (for test assertions). */
  rightContent: string;
}

/**
 * Computes the footer display state for the given query lifecycle.
 *
 * @param queryStatus  current query lifecycle state
 * @param pageMode     'PAGED' | 'SEMUA'
 * @param pageSize     configured rows-per-page (30/50/100)
 * @param page         1-based active page
 * @param totalCount   API-reported total from the most recent *successful* query
 */
export function getFooterDisplay(
  queryStatus: QueryStatus,
  pageMode: 'PAGED' | 'SEMUA',
  pageSize: number,
  page: number,
  totalCount: number,
): FooterDisplayState {
  const safeTotal = Math.max(0, totalCount);
  const totalPages = Math.max(1, Math.ceil(safeTotal / pageSize));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const isSemua = pageMode === 'SEMUA';
  const queryValid = queryStatus === 'SUCCESS';

  const dropdownValue = isSemua ? 'semua' : String(pageSize);
  const showLoadingSpinner = queryStatus === 'LOADING';
  const showErrorHint = queryStatus === 'ERROR';
  const showCountLabel = queryValid;
  const showPageNav = queryValid && !isSemua && totalPages > 1;
  const showReturnToPageButton = !isSemua ? false : !showLoadingSpinner;

  let pageNumbers: Array<number | 'ellipsis'> | null = null;
  let rightContent = '';

  if (queryStatus === 'LOADING') {
    rightContent = 'Memuat transaksi…';
  } else if (queryStatus === 'ERROR') {
    rightContent = 'Gagal memuat data — klik "Coba Lagi" di atas untuk mengulang.';
    if (isSemua) rightContent += ' [Kembali ke halaman]';
  } else if (queryStatus === 'SUCCESS') {
    if (isSemua) {
      rightContent = `Menampilkan ${safeTotal} transaksi (Semua)`;
    } else if (safeTotal === 0) {
      rightContent = '0 dari 0';
    } else {
      const [rangeStart, rangeEnd] = rangeForPage(safePage, pageSize, safeTotal);
      rightContent = `${rangeStart}–${rangeEnd} dari ${safeTotal}`;
      if (totalPages > 1) {
        pageNumbers = buildPageNumbers(safePage, totalPages);
      }
    }
  }
  // IDLE (initial mount, no successful query yet): no right-side content.
  // totalCount is 0 by init; we must not present it as a query result.

  return {
    showDropdown: true,
    dropdownValue,
    showLoadingSpinner,
    showErrorHint,
    showCountLabel,
    showPageNav,
    showReturnToPageButton,
    pageNumbers,
    rightContent,
  };
}
