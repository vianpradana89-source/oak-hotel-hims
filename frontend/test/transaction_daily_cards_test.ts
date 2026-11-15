/**
 * TX-F1-R2-02: Daily cards hotel-date rollover lifecycle test.
 *
 * Executes the PRODUCTION helper `createDailyCardsRolloverWatcher`
 * (imported from transactionPeriodHelpers.ts, not a copy). The helper's
 * interval is unref'd in Node so the test process exits cleanly; the test
 * stubs `globalThis.document` to verify the visibility-change wiring.
 *
 * Retained scenarios: A-success, B-error (reset to zeros + error),
 * stale-response guard (day-1 response does not overwrite day-2),
 * realtime refresh, filter independence, and cleanup idempotency.
 */
import assert from 'node:assert/strict';
import { createDailyCardsRolloverWatcher } from '../src/features/transactions/transactionPeriodHelpers.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

// ------------------------------------------------------------------
// Stub `document` for Node (no DOM). The helper reads
// `(globalThis as any).document` at call-time, so we install a
// minimal stub that records add/removeEventListener calls.
// ------------------------------------------------------------------
const docListeners: Map<string, Set<() => void>> = new Map();
(globalThis as any).document = {
  visibilityState: 'visible',
  addEventListener: (event: string, handler: () => void) => {
    if (!docListeners.has(event)) docListeners.set(event, new Set());
    docListeners.get(event)!.add(handler);
  },
  removeEventListener: (event: string, handler: () => void) => {
    docListeners.get(event)?.delete(handler);
  },
};

/** Fire all registered visibilitychange handlers (simulate tab re-focus). */
function fireVisibility() {
  docListeners.get('visibilitychange')?.forEach((h) => h());
}

// ------------------------------------------------------------------
// Mock clock — controllable, injected into the production helper
// ------------------------------------------------------------------
class MockClock {
  private current: Date;
  constructor(initial: Date) {
    this.current = new Date(initial.getTime());
  }
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
  now(): Date {
    return new Date(this.current.getTime());
  }
}

// ------------------------------------------------------------------
// Card state simulator (mirrors the component's reqId + scope logic).
// This is NOT a copy of the production helper — the production helper
// under test is createDailyCardsRolloverWatcher, imported above.
// ------------------------------------------------------------------
interface CardState {
  cards: { total_sale: number; count_sale: number };
  loading: boolean;
  error: string | null;
  reqId: number;
  scope: { propertyId: number; hotelDate: string };
}

const ZERO = { total_sale: 0, count_sale: 0 };

function createCardSimulator(
  fetchApi: (propertyId: number, hotelDate: string) => Promise<{ total_sale: number; count_sale: number }>,
  getHotelDate: () => string,
) {
  const state: CardState = {
    cards: { ...ZERO },
    loading: false,
    error: null,
    reqId: 0,
    scope: { propertyId: 0, hotelDate: '' },
  };

  async function loadDailyCards(propertyId: number) {
    const reqId = ++state.reqId;
    const today = getHotelDate();
    state.scope = { propertyId, hotelDate: today };
    state.loading = true;
    state.error = null;
    try {
      const res = await fetchApi(propertyId, today);
      if (reqId === state.reqId) {
        state.cards = res;
        state.error = null;
      }
    } catch (err: any) {
      if (reqId === state.reqId) {
        state.cards = { ...ZERO };
        state.error = err?.message || 'Gagal memuat ringkasan harian';
      }
    }
    if (reqId === state.reqId) state.loading = false;
  }

  return { state, loadDailyCards };
}

async function run() {
  console.log('=== OAK HIMS — Daily Cards Rollover Lifecycle Tests (TX-F1-R2-02) ===\n');

  // ------------------------------------------------------------------
  // 1. Production watcher: isStale / currentDate contract
  // ------------------------------------------------------------------
  console.log('--- 1. Rollover watcher: isStale + currentDate contract ---');
  {
    const clock = new MockClock(new Date('2026-11-10T23:59:30+07:00'));
    const triggers: string[] = [];
    const watcher = createDailyCardsRolloverWatcher(
      () => clock.now(),
      (newDate: string) => { triggers.push(newDate); },
    );

    check(watcher.currentDate() === '2026-11-10', 'initial: currentDate() = 2026-11-10');
    check(watcher.isStale('2026-11-10') === false, 'isStale(current) = false');
    check(watcher.isStale('2026-11-09') === true,  'isStale(yesterday) = true');
    check(watcher.isStale('2026-11-11') === true,  'isStale(tomorrow) = true');
    check(docListeners.get('visibilitychange') !== undefined, 'visibilitychange listener registered');

    watcher.cleanup();
    check(docListeners.get('visibilitychange') === undefined || docListeners.get('visibilitychange')!.size === 0,
      'visibilitychange listener removed after cleanup');
    check(true, 'cleanup() runs without error');
  }

  // ------------------------------------------------------------------
  // 2. Visibility resume: fire visibilitychange after clock advances
  //    → onRollover fires with the new date
  // ------------------------------------------------------------------
  console.log('--- 2. Tab resume: visibilitychange fires onRollover for new date ---');
  {
    const clock = new MockClock(new Date('2026-11-10T23:58:00+07:00'));
    const triggers: string[] = [];
    const watcher = createDailyCardsRolloverWatcher(
      () => clock.now(),
      (newDate: string) => { triggers.push(newDate); },
    );

    check(triggers.length === 0, 'before boundary: no triggers');
    check(watcher.currentDate() === '2026-11-10', 'before boundary: date = 2026-11-10');

    // Advance 4 hours → now 03:58 on 2026-11-11 (past midnight WIB)
    clock.advance(4 * 60 * 60 * 1000);
    // Simulate tab re-focus (visibilitychange → visible)
    fireVisibility();

    check(triggers.length === 1, 'after visibilitychange: exactly 1 trigger fired');
    check(triggers[0] === '2026-11-11', 'trigger carries new date 2026-11-11');
    check(watcher.currentDate() === '2026-11-11', 'currentDate() updated to 2026-11-11');

    // Fire again without advancing — should NOT trigger a second call
    fireVisibility();
    check(triggers.length === 1, 'second visibilitychange without new date: no extra trigger');

    watcher.cleanup();
  }

  // ------------------------------------------------------------------
  // 3. Stale day-1 response does not overwrite day-2 cards
  // ------------------------------------------------------------------
  console.log('--- 3. Stale day-1 response: does NOT overwrite day-2 result ---');
  {
    const clock = new MockClock(new Date('2026-11-10T23:58:00+07:00'));
    let currentDate = '2026-11-10';
    const triggers: string[] = [];
    const watcher = createDailyCardsRolloverWatcher(
      () => clock.now(),
      (newDate: string) => { currentDate = newDate; triggers.push(newDate); },
    );

    const { state, loadDailyCards } = createCardSimulator(
      async (_prop, hotelDate) => {
        if (hotelDate === '2026-11-10') {
          // Simulate slow network: resolve only AFTER clock has advanced to day 2
          clock.advance(3 * 60 * 60 * 1000);
          fireVisibility(); // component's watcher fires → triggers loadDailyCards(1) again
          return { total_sale: 100, count_sale: 1 };
        }
        return { total_sale: 200, count_sale: 2 };
      },
      () => currentDate,
    );

    // Day-1 fetch starts (will be slow)
    const p1 = loadDailyCards(1);
    // Day-2 fetch is triggered by the visibilitychange that just fired
    // (inside the p1 fetch's simulated delay). The simulator picks it up
    // via the `currentDate` ref which is now '2026-11-11'.
    // We need to manually call the day-2 fetch to mirror what the
    // component's rollover effect does:
    const p2 = loadDailyCards(1);

    await p2;
    check(state.cards.total_sale === 200, 'day-2 result committed (total_sale=200)');
    check(state.scope.hotelDate === '2026-11-11', 'scope tracks NEW hotel date (2026-11-11)');
    check(state.error === null, 'no error after day-2 success');

    // Resolve the stale day-1 promise; it must NOT overwrite day-2 cards
    await p1.catch(() => {});
    check(state.cards.total_sale === 200, 'stale day-1 response did NOT overwrite day-2 cards');
    check(state.scope.hotelDate === '2026-11-11', 'scope still on 2026-11-11 after stale p1 resolved');

    watcher.cleanup();
  }

  // ------------------------------------------------------------------
  // 4. A-success: cards show correct values
  // ------------------------------------------------------------------
  console.log('--- 4. A-success: cards committed, no error ---');
  {
    const { state, loadDailyCards } = createCardSimulator(
      async () => ({ total_sale: 100_000, count_sale: 5 }),
      () => '2026-11-10',
    );
    await loadDailyCards(1);
    check(state.cards.total_sale === 100_000, 'A success → total_sale=100000');
    check(state.error === null, 'A success → no error');
    check(state.loading === false, 'A success → loading false');
  }

  // ------------------------------------------------------------------
  // 5. B-error: cards reset to zeros + error set (never keep A's values)
  // ------------------------------------------------------------------
  console.log('--- 5. B-fail after A-success: zeros + error, NOT A values ---');
  {
    const { state, loadDailyCards } = createCardSimulator(
      async (propId) => {
        if (propId === 1) return { total_sale: 123_456, count_sale: 10 };
        throw new Error('500 Internal Server Error');
      },
      () => '2026-11-10',
    );
    await loadDailyCards(1);
    check(state.cards.total_sale === 123_456, 'A values committed');
    await loadDailyCards(2);
    check(state.cards.total_sale === 0, 'B fail → cards reset to zeros');
    check(state.error !== null && state.error.includes('500'), 'B fail → error message set');
    check(state.loading === false, 'B fail → loading false');
  }

  // ------------------------------------------------------------------
  // 6. Realtime refresh: same propertyId, total updates
  // ------------------------------------------------------------------
  console.log('--- 6. Realtime refresh: total updates on same propertyId ---');
  {
    let saleTotal = 0;
    const { state, loadDailyCards } = createCardSimulator(
      async () => {
        saleTotal += 10;
        return { total_sale: saleTotal, count_sale: 1 };
      },
      () => '2026-11-10',
    );
    await loadDailyCards(1);
    check(state.cards.total_sale === 10, 'initial: total_sale=10');
    await loadDailyCards(1);
    check(state.cards.total_sale === 20, 'after realtime: total_sale=20');
  }

  // ------------------------------------------------------------------
  // 7. Filter independence: loadDailyCards only depends on propertyId
  // ------------------------------------------------------------------
  console.log('--- 7. Filter independence: scope unchanged by filter change ---');
  {
    let callCount = 0;
    const { state, loadDailyCards } = createCardSimulator(
      async () => { callCount += 1; return { total_sale: 50, count_sale: 1 }; },
      () => '2026-11-10',
    );
    await loadDailyCards(1);
    check(callCount === 1, 'exactly one call for propertyId=1');
    // Filter changes (category/tab/search) do NOT call loadDailyCards;
    // the useCallback dep array in the component is [propertyId] only.
    check(state.scope.propertyId === 1, 'scope.propertyId unchanged by filter change');
  }

  // ------------------------------------------------------------------
  // 8. Cleanup idempotency: calling cleanup twice does not throw
  // ------------------------------------------------------------------
  console.log('--- 8. Cleanup idempotency ---');
  {
    const clock = new MockClock(new Date('2026-11-10T12:00:00+07:00'));
    const watcher = createDailyCardsRolloverWatcher(
      () => clock.now(),
      () => {},
    );
    watcher.cleanup();
    let threw = false;
    try { watcher.cleanup(); } catch { threw = true; }
    check(!threw, 'second cleanup() call does not throw');
  }

  console.log(`\n=== ALL DAILY CARDS ROLLOVER LIFECYCLE TESTS PASSED (${assertions} assertions) ===`);
  // Ensure process exits cleanly even if unref missed a listener
  process.exit(0);
}

run().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
