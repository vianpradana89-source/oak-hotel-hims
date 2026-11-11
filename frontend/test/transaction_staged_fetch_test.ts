import assert from 'node:assert/strict';
import {
  fetchTransactionsStaged,
  type TransactionFetchParams,
} from '../src/features/transactions/transactionStagedFetch.ts';
import type { GetTransactionsResponse } from '../src/features/transactions/transactionClient.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

/** Build a fake GetTransactionsResponse with deterministic transaction IDs. */
function makeResponse(
  items: Array<{ id: number }>,
  totalCount: number,
  sheetCounts?: GetTransactionsResponse['sheet_counts'],
): GetTransactionsResponse {
  return {
    transactions: items as any[],
    total_count: totalCount,
    summary: {
      total_sale: 0, total_purchase: 0, total_expense: 0, total_income: 0,
      count_sale: 0, count_purchase: 0, count_expense: 0, count_income: 0,
    },
    global_summary: {
      total_sale: 0, total_purchase: 0, total_expense: 0, total_income: 0,
      count_sale: 0, count_purchase: 0, count_expense: 0, count_income: 0,
    },
    sheet_counts: sheetCounts,
    limit: 100,
    offset: 0,
  };
}

/** Deterministic fake fetchPage that simulates the backend's 100-item cap. */
function makeFakeFetchPage(
  allItems: Array<{ id: number }>,
  totalCountOverride?: number,
): { fetchPage: (limit: number, offset: number) => Promise<GetTransactionsResponse>; callLog: Array<{ limit: number; offset: number }> } {
  const callLog: Array<{ limit: number; offset: number }> = [];
  const fetchPage = async (limit: number, offset: number): Promise<GetTransactionsResponse> => {
    callLog.push({ limit, offset });
    const totalCount = totalCountOverride ?? allItems.length;
    const clampedLimit = Math.min(100, limit);
    const items = allItems.slice(offset, offset + clampedLimit);
    return makeResponse(items, totalCount, { proses: totalCount, selesai: 0, batal: 0, hapus: 0 });
  };
  return { fetchPage, callLog };
}

const BASE_PARAMS: TransactionFetchParams = {
  property_id: 1,
  transaction_type: 'SALE',
  start_date: '2026-11-01',
  end_date: '2026-11-30',
  operational_sheet: 'PROSES',
};

async function run() {
  console.log('=== OAK HIMS — TransactionStagedFetch Tests ===\n');

  // ------------------------------------------------------------------
  // 1. Zero results: SEMUA mode with 0 items → single call, empty array
  // ------------------------------------------------------------------
  console.log('--- 1. Zero results (0 items) ---');
  {
    const { fetchPage, callLog } = makeFakeFetchPage([], 0);
    const result = await fetchTransactionsStaged(fetchPage, BASE_PARAMS, 'SEMUA', 1, 30);
    check(result.transactions.length === 0, '0 items → empty transactions array');
    check(result.totalCount === 0, '0 items → totalCount is 0');
    check(callLog.length === 1, '0 items → exactly one fetch call (offset=0)');
    check(callLog[0].limit === 100, 'limit is always 100 for SEMUA mode');
    check(callLog[0].offset === 0, 'first call starts at offset 0');
  }

  // ------------------------------------------------------------------
  // 2. Exactly 100 results: SEMUA → one call, all items received
  // ------------------------------------------------------------------
  console.log('--- 2. Exactly 100 items ---');
  {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
    const { fetchPage, callLog } = makeFakeFetchPage(items, 100);
    const result = await fetchTransactionsStaged(fetchPage, BASE_PARAMS, 'SEMUA', 1, 30);
    check(result.transactions.length === 100, '100 items → all collected');
    check(result.totalCount === 100, 'totalCount is 100');
    check(callLog.length === 1, 'exactly one fetch call (offset=0, returns full 100)');
    check(callLog[0].offset === 0 && callLog[0].limit === 100, 'first call is limit=100 offset=0');
  }

  // ------------------------------------------------------------------
  // 3. 101 results: SEMUA → two calls (offset 0 and 100)
  // ------------------------------------------------------------------
  console.log('--- 3. 101 items (boundary crossing) ---');
  {
    const items = Array.from({ length: 101 }, (_, i) => ({ id: i + 1 }));
    const { fetchPage, callLog } = makeFakeFetchPage(items, 101);
    const result = await fetchTransactionsStaged(fetchPage, BASE_PARAMS, 'SEMUA', 1, 30);
    check(result.transactions.length === 101, '101 items → all collected');
    check(callLog.length === 2, 'two fetch calls needed (100 + 1)');
    check(callLog[0].offset === 0, 'first call offset=0');
    check(callLog[1].offset === 100, 'second call offset=100');
  }

  // ------------------------------------------------------------------
  // 4. 205 results: SEMUA → three calls (100, 100, 5)
  // ------------------------------------------------------------------
  console.log('--- 4. 205 items (multi-page) ---');
  {
    const items = Array.from({ length: 205 }, (_, i) => ({ id: i + 1 }));
    const { fetchPage, callLog } = makeFakeFetchPage(items, 205);
    const result = await fetchTransactionsStaged(fetchPage, BASE_PARAMS, 'SEMUA', 1, 30);
    check(result.transactions.length === 205, '205 items → all collected');
    check(callLog.length === 3, 'three fetch calls (100 + 100 + 5)');
    check(callLog[0].offset === 0, 'page 1: offset=0');
    check(callLog[1].offset === 100, 'page 2: offset=100');
    check(callLog[2].offset === 200, 'page 3: offset=200');
  }

  // ------------------------------------------------------------------
  // 5. Ordering & grouping: BID groups are NOT split across pages
  //    The fake fetcher simulates the backend's presented-item unit:
  //    one BID group = one item in the flat list. Since items are
  //    already flat (one unit per item), the order is preserved
  //    end-to-end. We verify the full collected array equals the
  //    source array exactly (order + identity).
  // ------------------------------------------------------------------
  console.log('--- 5. Ordering & grouping integrity ---');
  {
    const items = Array.from({ length: 250 }, (_, i) => ({ id: i + 1 }));
    const { fetchPage } = makeFakeFetchPage(items, 250);
    const result = await fetchTransactionsStaged(fetchPage, BASE_PARAMS, 'SEMUA', 1, 30);
    check(result.transactions.length === items.length, 'all items present');
    const ids = result.transactions.map((t: any) => t.id);
    check(JSON.stringify(ids) === JSON.stringify(items.map((i) => i.id)), 'order preserved exactly');
    // No duplicates
    const uniqueIds = new Set(ids);
    check(uniqueIds.size === ids.length, 'no duplicate transaction IDs in collected result');
  }

  // ------------------------------------------------------------------
  // 6. Premature empty page: total_count says 200, page 2 returns 0
  //    items at offset=100. The helper now throws StagedFetchIncompleteError
  //    (total-consistency failure — total drifted below remaining, or a
  //    stale snapshot was served). Partial results are NEVER committed.
  // ------------------------------------------------------------------
  console.log('--- 6. Premature empty page (total=200, page 2 empty → error) ---');
  {
    let callCount = 0;
    const fetchPage = async (limit: number, offset: number): Promise<GetTransactionsResponse> => {
      callCount += 1;
      if (offset === 0) {
        return makeResponse(Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })), 200);
      }
      // Second page returns nothing despite total_count=200 — simulates
      // total_count shifting under us or a stale snapshot being served.
      return makeResponse([], 200);
    };
    let caught: Error | null = null;
    try {
      await fetchTransactionsStaged(fetchPage, BASE_PARAMS, 'SEMUA', 1, 30);
    } catch (e: any) {
      caught = e;
    }
    check(caught !== null, 'StagedFetchIncompleteError is thrown (not a partial success)');
    check(
      caught instanceof Error && caught.name === 'StagedFetchIncompleteError',
      'error is StagedFetchIncompleteError'
    );
    check(callCount === 2, 'stops after the empty page (2 total calls, not infinite loop)');
  }

  // ------------------------------------------------------------------
  // 7. Error on later page: first page OK, second page throws
  //    → partial result is NOT presented as a successful "Semua"
  // ------------------------------------------------------------------
  console.log('--- 7. Error on second page ---');
  {
    const callLog: number[] = [];
    const fetchPage = async (limit: number, offset: number): Promise<GetTransactionsResponse> => {
      callLog.push(offset);
      if (offset === 0) {
        return makeResponse(Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })), 250);
      }
      throw new Error('Network error on page 2');
    };
    let caught: Error | null = null;
    let partial: Awaited<ReturnType<typeof fetchTransactionsStaged>> | null = null;
    try {
      const result = await fetchTransactionsStaged(fetchPage, BASE_PARAMS, 'SEMUA', 1, 30);
      partial = result;
    } catch (e: any) {
      caught = e;
    }
    check(caught !== null, 'error propagates (does not silently succeed with partial data)');
    check(caught!.message === 'Network error on page 2', 'error message is preserved');
    check(callLog.length === 2, 'two calls attempted (page 1 + failed page 2)');
  }

  // ------------------------------------------------------------------
  // 8. PAGED mode: single request at current offset
  // ------------------------------------------------------------------
  console.log('--- 8. PAGED mode (single request) ---');
  {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
    const { fetchPage, callLog } = makeFakeFetchPage(items, 100);
    const result = await fetchTransactionsStaged(fetchPage, BASE_PARAMS, 'PAGED', 2, 30);
    check(callLog.length === 1, 'PAGED mode makes exactly one call');
    check(callLog[0].limit === 30, 'PAGED limit is pageSize (30)');
    check(callLog[0].offset === 30, 'PAGED offset = (page-1)*pageSize = 30');
    check(result.transactions.length === 30, 'returns the page slice (items 31-60)');
  }

  // ------------------------------------------------------------------
  // 9. PAGED mode: pageSize > 100 is clamped to 100
  // ------------------------------------------------------------------
  console.log('--- 9. PAGED mode clamps limit to 100 ---');
  {
    const items = Array.from({ length: 150 }, (_, i) => ({ id: i + 1 }));
    const { fetchPage, callLog } = makeFakeFetchPage(items, 150);
    const result = await fetchTransactionsStaged(fetchPage, BASE_PARAMS, 'PAGED', 1, 200);
    check(callLog[0].limit === 100, 'pageSize=200 → clamped to 100');
    check(result.transactions.length === 100, 'only 100 items returned');
  }

  // ------------------------------------------------------------------
  // 10. Safety valve: API keeps returning items despite total_count=0
  //      (inconsistent backend — overlap/no-progress → StagedFetchIncompleteError).
  //      Page 1: 100 new items, total=0 → no break, no overlap yet.
  //      Page 2: same 100 items, total=0 → newUnits=0, items.length=100>0
  //      → overlap guard fires → throws StagedFetchIncompleteError.
  // ------------------------------------------------------------------
  console.log('--- 10. Inconsistent total (items=100, total_count=0 → overlap error) ---');
  {
    let callCount = 0;
    const fetchPage = async (limit: number, _offset: number): Promise<GetTransactionsResponse> => {
      callCount += 1;
      // Always returns the same 100 items with total_count=0,
      // simulating an API that ignores offset (overlap / no-progress).
      return makeResponse(Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })), 0);
    };
    let caught: Error | null = null;
    try {
      await fetchTransactionsStaged(fetchPage, BASE_PARAMS, 'SEMUA', 1, 30);
    } catch (e: any) {
      caught = e;
    }
    check(
      caught !== null && caught.name === 'StagedFetchIncompleteError',
      'overlap/no-progress detected → StagedFetchIncompleteError (not silent partial result)'
    );
    check(callCount === 2, 'exactly 2 calls: page 1 (new units) + page 2 (overlap detected)');
  }

  // ------------------------------------------------------------------
  // 11. Safety cap: 15 000-item dataset.
  //      The helper stops at 100 pages × 100 = 10 000 items and reports
  //      the result explicitly as incomplete (incomplete=true,
  //      collectedCount=10000, totalCount=15000). The caller must show
  //      a limit notice — never a complete "Semua" result.
  //      Proves the helper no longer silently stops at 10 100.
  // ------------------------------------------------------------------
  console.log('--- 11. Safety cap (15 000 items → incomplete, 10 000 collected) ---');
  {
    const allItems = Array.from({ length: 15000 }, (_, i) => ({ id: i + 1 }));
    const { fetchPage, callLog } = makeFakeFetchPage(allItems, 15000);
    const result = await fetchTransactionsStaged(fetchPage, BASE_PARAMS, 'SEMUA', 1, 30);
    check(result.incomplete === true, 'incomplete flag is set (safety cap hit)');
    check(result.collectedCount === 10000, 'collectedCount is exactly 10 000 (100 pages × 100)');
    check(result.totalCount === 15000, 'totalCount reflects the API-reported total (15 000)');
    check(result.transactions.length === 10000, 'transactions array holds only the 10 000 collected items');
    check(callLog.length === 100, 'exactly 100 fetch calls (safety cap)');
    check(
      result.incompleteReason !== undefined && result.incompleteReason.includes('10'),
      'incompleteReason is present and mentions the cap'
    );
  }

  // ------------------------------------------------------------------
  // 12. Overlap / repeated page with canonical identity (SALE + booking_bid).
  //      Simulates an API that returns the same BID group on two consecutive
  //      pages: page 1 has 100 SALE items with booking_bid, page 2 returns
  //      the same 100 BID items again (offset didn't advance or total_count
  //      drifted). The canonical key (bid:1:{bid}) prevents silent
  //      duplication, and the no-progress guard fires on page 2.
  // ------------------------------------------------------------------
  console.log('--- 12. Overlap via canonical BID identity (repeated BID group) ---');
  {
    // 100 SALE transactions, each with a unique booking_bid.
    const saleItems: any[] = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      transaction_type: 'SALE',
      booking_bid: String(1000 + i),
      property_id: 1,
    }));

    let callCount = 0;
    const fetchPage = async (limit: number, offset: number): Promise<GetTransactionsResponse> => {
      callCount += 1;
      if (offset === 0) {
        // Page 1: 100 SALE items, total_count=150 (expect 50 more on page 2).
        return makeResponse(saleItems, 150);
      }
      // Page 2: the SAME 100 SALE items again (overlap — offset=100 but
      // backend returned the same BID group, simulating a no-progress overlap).
      return makeResponse(saleItems, 150);
    };

    let caught: Error | null = null;
    try {
      await fetchTransactionsStaged(fetchPage, BASE_PARAMS, 'SEMUA', 1, 30);
    } catch (e: any) {
      caught = e;
    }
    check(
      caught !== null && caught.name === 'StagedFetchIncompleteError',
      'overlap detected via canonical BID key → StagedFetchIncompleteError'
    );
    check(callCount === 2, '2 calls: page 1 (new units) + page 2 (overlap → error)');
  }

  console.log(`\n=== ALL STAGED FETCH TESTS PASSED (${assertions} assertions) ===`);
}

run().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
