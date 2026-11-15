/**
 * AUDIT-LOG CONTROLLER TESTS (v3)
 *
 * Tests the ACTUAL state machine used by the drawer:
 *   ReservationDetailDrawer.tsx
 *     → useAuditLog (hook binding)
 *       → auditLogController (pure controller — under test here)
 *
 * This is NOT a standalone copy: it imports the real controller module.
 * Coverage:
 *  T1  Initial failure does not auto-retry (ensureLoaded is one-shot)
 *  T2  A→B→A with first A request still pending — stale A discarded
 *  T3  Stale finally does not mutate the new request's entries/loading/in-flight
 *  T4  In-flight guard prevents double fetch
 *  T5  Load-more failure keeps entries + cursor; retry succeeds
 *  T6  Unmount (dispose) invalidates in-flight requests
 *  T7  Context change resets all state
 *  T8  Hook wiring: useAuditLog actually uses the controller + drawer consumes the hook
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createAuditLogController,
  createAuditLogInitialState,
  type AuditLogUiState,
  type FetchPageResult,
} from '../src/features/calendar/auditLogController.ts';

let passed = 0, failed = 0;
function ok(msg: string) { passed++; console.log(`  PASS: ${msg}`); }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Deferred promise helper for manual settlement control ────────────────────
interface DeferredFetch {
  resolve: (r: FetchPageResult) => void;
  reject: (e: unknown) => void;
  args: { contextKey: string; cursor: string | null; append: boolean };
}

/** fetchPage mock: records every call, returns per-call deferreds. */
function createDeferredFetch() {
  const calls: DeferredFetch[] = [];
  const fetchPage = (args: { contextKey: string; cursor: string | null; append: boolean }) =>
    new Promise<FetchPageResult>((resolve, reject) => {
      calls.push({ resolve, reject, args });
    });
  return {
    fetchPage,
    calls,
    /** index of the Nth call (0-based) */
    at: (n: number) => calls[n],
    get count() { return calls.length; },
    /** Convenience: settle call n with a success body. */
    resolveOk: (n: number, data: any[], has_more = false, next_cursor: string | null = null) =>
      calls[n].resolve({ ok: true, data: { status: 'OK', data, has_more, next_cursor } }),
    /** Convenience: settle call n with a failure. */
    resolveErr: (n: number, errorMessage = 'Server error') =>
      calls[n].resolve({ ok: false, data: null, errorMessage }),
    /** Convenience: reject call n (transport failure). */
    reject: (n: number, e: unknown = new Error('network')) =>
      calls[n].reject(e),
  };
}

/** Snapshot helper: extract observable fields. */
function snap(s: AuditLogUiState) {
  return {
    entries: s.entries.map(e => e.audit_id),
    hasMore: s.hasMore,
    cursor: s.cursor,
    loading: s.loading,
    error: s.error,
    loadMoreError: s.loadMoreError,
    inFlight: s.inFlight,
    loadAttempted: s.loadAttempted,
    gen: s.gen,
  };
}

function entry(id: number, summary = `E${id}`) {
  return { audit_id: id, module: 'PMS', action: 'CREATE', summary, actor: 'A', formatted_time: '2026-01-01 00:00:00' };
}

async function main() {
  console.log('\n=== Audit-Log Controller Tests (actual drawer state machine) ===\n');

  // ── T1: initial failure does not auto-retry ────────────────────────────────
  {
    const f = createDeferredFetch();
    const c = createAuditLogController({ contextKey: '1:100', autoLoad: true, fetchPage: f.fetchPage });
    assert.strictEqual(f.count, 1, 'T1: autoLoad fired initial fetch');

    f.resolveErr(0);
    await sleep(0);
    assert.strictEqual(c.state.error !== null, true, 'T1: error set');
    assert.strictEqual(c.state.entries.length, 0, 'T1: entries empty');

    // Tab re-activation must NOT auto-retry after failure
    c.ensureLoaded();
    assert.strictEqual(f.count, 1, 'T1: ensureLoaded after failure does not refetch');

    // Explicit retry DOES refetch and succeeds
    c.retry();
    assert.strictEqual(f.count, 2, 'T1: retry fired second fetch');
    f.resolveOk(1, [entry(1)]);
    await sleep(0);
    assert.strictEqual(c.state.entries.length, 1, 'T1: retry loaded entries');
    assert.strictEqual(c.state.error, null, 'T1: error cleared');

    ok('T1: initial failure does not auto-retry; explicit retry succeeds');
    c.dispose();
  }

  // ── T2: A→B→A with first A request still pending ───────────────────────────
  {
    const f = createDeferredFetch();
    const c = createAuditLogController({ contextKey: '1:100', autoLoad: true, fetchPage: f.fetchPage });
    // Call 0 = first A request — leave PENDING.
    assert.strictEqual(f.count, 1);

    // Switch to B (tab active → auto-load)
    c.setContext('1:200', { autoLoad: true });
    assert.strictEqual(f.count, 2, 'T2: B context fired fetch');
    f.resolveOk(1, [entry(2, 'B-1')]);
    await sleep(0);
    assert.deepStrictEqual(snap(c.state).entries, [2], 'T2: B loaded');
    assert.strictEqual(c.state.inFlight, false, 'T2: B not in flight');

    // Switch back to A — first A (call 0) is STILL PENDING
    c.setContext('1:100', { autoLoad: true });
    assert.strictEqual(f.count, 3, 'T2: fresh A fetch fired');

    // Now settle the STALE first-A request (call 0) — must be discarded
    f.resolveOk(0, [entry(99, 'STALE-A')]);
    await sleep(0);
    // Then settle the fresh A request (call 2)
    f.resolveOk(2, [entry(3, 'A-2')]);
    await sleep(0);

    const s = snap(c.state);
    assert.deepStrictEqual(s.entries, [3], `T2: stale A discarded, fresh A wins — got ${JSON.stringify(s.entries)}`);
    assert.strictEqual(c.state.inFlight, false, 'T2: in-flight cleared by fresh A');

    ok('T2: A→B→A — stale A response discarded, fresh A fetch wins');
    c.dispose();
  }

  // ── T3: stale finally does not mutate the new request's state ──────────────
  {
    const f = createDeferredFetch();
    const c = createAuditLogController({ contextKey: '1:100', autoLoad: true, fetchPage: f.fetchPage });
    // Call 0 = A, PENDING (slow).

    // Switch to B; B fetch (call 1) resolves fast.
    c.setContext('1:200', { autoLoad: true });
    f.resolveOk(1, [entry(2, 'B')]);
    await sleep(0);
    assert.strictEqual(c.state.loading, false, 'T3: B finished loading');
    assert.strictEqual(c.state.inFlight, false, 'T3: B not in flight');

    // A's slow response settles now — its success+finally paths are stale.
    f.resolveOk(0, [entry(1, 'STALE-A')]);
    await sleep(0);

    const s = snap(c.state);
    assert.deepStrictEqual(s.entries, [2], 'T3: B entries preserved');
    assert.strictEqual(s.loading, false, 'T3: B loading untouched by stale finally');
    assert.strictEqual(s.inFlight, false, 'T3: B in-flight untouched by stale finally');
    assert.strictEqual(c.state.error, null, 'T3: no error leaked');

    ok('T3: stale success/finally does not affect new request state');
    c.dispose();
  }

  // ── T3b: stale ERROR path is also discarded ────────────────────────────────
  {
    const f = createDeferredFetch();
    const c = createAuditLogController({ contextKey: '1:100', autoLoad: true, fetchPage: f.fetchPage });
    c.setContext('1:200', { autoLoad: true });
    f.resolveOk(1, [entry(2, 'B')]);
    await sleep(0);

    // Stale A request REJECTS (transport failure) — must not set B's error
    f.reject(0, new Error('network down'));
    await sleep(0);
    assert.strictEqual(c.state.error, null, 'T3b: stale error discarded');
    assert.strictEqual(c.state.loadMoreError, null, 'T3b: stale loadMoreError discarded');

    ok('T3b: stale error/catch path discarded');
    c.dispose();
  }

  // ── T4: in-flight guard prevents double fetch ──────────────────────────────
  {
    const f = createDeferredFetch();
    const c = createAuditLogController({ contextKey: '1:100', autoLoad: true, fetchPage: f.fetchPage });
    // Initial fetch in flight (call 0 pending).
    // ensureLoaded / loadMore while in flight: no-ops (guard).
    c.ensureLoaded();
    c.loadMore();
    assert.strictEqual(f.count, 1, `T4: ensureLoaded/loadMore no-op while in flight (calls=${f.count})`);
    assert.strictEqual(c.state.inFlight, true, 'T4: still in flight');

    // Explicit retry replaces the in-flight request with exactly one new fetch.
    c.retry();
    assert.strictEqual(f.count, 2, `T4: retry replaces in-flight with one fetch (calls=${f.count})`);
    f.resolveOk(1, []);
    await sleep(0);
    f.resolveOk(0, [entry(99)]); // stale first fetch settles — must be discarded
    await sleep(0);
    assert.strictEqual(c.state.entries.length, 0, 'T4: stale pre-retry fetch discarded');
    assert.strictEqual(f.count, 2, 'T4: no extra calls');

    ok('T4: in-flight guard: ensureLoaded/loadMore no-op; retry replaces with one fetch');
    c.dispose();
  }

  // ── T5: load-more failure keeps entries + cursor; retry succeeds ───────────
  {
    const f = createDeferredFetch();
    const c = createAuditLogController({ contextKey: '1:100', autoLoad: true, fetchPage: f.fetchPage });
    f.resolveOk(0, [entry(1), entry(2)], true, '2030-09-01 10:00:00.123456|2');
    await sleep(0);
    assert.deepStrictEqual(snap(c.state).entries, [1, 2]);
    assert.strictEqual(c.state.hasMore, true);
    assert.strictEqual(c.state.cursor, '2030-09-01 10:00:00.123456|2');

    // Load-more fails
    c.loadMore();
    assert.strictEqual(f.count, 2);
    f.resolveErr(1, 'Server error');
    await sleep(0);
    let s = snap(c.state);
    assert.deepStrictEqual(s.entries, [1, 2], 'T5: entries preserved on load-more failure');
    assert.strictEqual(s.cursor, '2030-09-01 10:00:00.123456|2', 'T5: cursor preserved');
    assert.notStrictEqual(s.loadMoreError, null, 'T5: loadMoreError visible');

    // Retry load-more with the SAME cursor → succeeds
    c.loadMore();
    assert.strictEqual(f.count, 3);
    assert.strictEqual(f.at(2).args.cursor, '2030-09-01 10:00:00.123456|2', 'T5: retry used preserved cursor');
    assert.strictEqual(f.at(2).args.append, true, 'T5: retry is append mode');
    f.resolveOk(2, [entry(3)], false, null);
    await sleep(0);
    s = snap(c.state);
    assert.deepStrictEqual(s.entries, [1, 2, 3], 'T5: entries appended');
    assert.strictEqual(s.hasMore, false, 'T5: last page');
    assert.strictEqual(s.cursor, null, 'T5: cursor null on last page');
    assert.strictEqual(s.loadMoreError, null, 'T5: loadMoreError cleared');

    ok('T5: load-more failure keeps entries + cursor; retry succeeds');
    c.dispose();
  }

  // ── T6: dispose (unmount) invalidates in-flight requests ───────────────────
  {
    const f = createDeferredFetch();
    const c = createAuditLogController({ contextKey: '1:100', autoLoad: true, fetchPage: f.fetchPage });
    let observed = 0;
    c.subscribe(() => { observed++; });
    c.dispose();
    const observedAtDispose = observed;

    // Pending request settles after dispose — must be a complete no-op
    f.resolveOk(0, [entry(1)]);
    await sleep(0);
    assert.strictEqual(c.state.entries.length, 0, 'T6: no entries after dispose');
    assert.strictEqual(c.state.loading, false, 'T6: loading stays false');
    assert.strictEqual(observed, observedAtDispose, 'T6: no state notifications after dispose');

    // Post-dispose API calls are also no-ops
    c.retry(); c.loadMore(); c.ensureLoaded();
    assert.strictEqual(f.count, 1, 'T6: no fetches after dispose');

    ok('T6: dispose/unmount invalidates in-flight and blocks further fetches');
  }

  // ── T7: context change resets all state ────────────────────────────────────
  {
    const f = createDeferredFetch();
    const c = createAuditLogController({ contextKey: '1:100', autoLoad: true, fetchPage: f.fetchPage });
    // Make context A "dirty": entries + loadMoreError
    f.resolveOk(0, [entry(1), entry(2)], true, 'x|2');
    await sleep(0);
    c.loadMore();
    f.resolveErr(1);
    await sleep(0);
    assert.notStrictEqual(c.state.loadMoreError, null);

    // Switch to B (autoLoad=false → pure reset, no fetch)
    c.setContext('1:200');
    const s = snap(c.state);
    assert.deepStrictEqual(s.entries, [], 'T7: entries reset');
    assert.strictEqual(s.hasMore, false, 'T7: hasMore reset');
    assert.strictEqual(s.cursor, null, 'T7: cursor reset');
    assert.strictEqual(s.loading, false, 'T7: loading reset');
    assert.strictEqual(s.error, null, 'T7: error reset');
    assert.strictEqual(s.loadMoreError, null, 'T7: loadMoreError reset');
    assert.strictEqual(s.loadAttempted, false, 'T7: loadAttempted reset (B may lazy-load)');
    assert.strictEqual(f.count, 2, 'T7: no auto fetch when autoLoad=false');

    ok('T7: context change resets all observable state');
    c.dispose();
  }

  // ── T8: wiring — hook and drawer use this controller (source checks) ───────
  {
    const hookPath = path.resolve(process.cwd(), 'src/features/calendar/useAuditLog.ts');
    const drawerPath = path.resolve(process.cwd(), 'src/features/calendar/ReservationDetailDrawer.tsx');

    const hookSrc = fs.readFileSync(hookPath, 'utf8');
    assert.ok(
      hookSrc.includes('createAuditLogController'),
      'T8: useAuditLog must use createAuditLogController (actual code under test)'
    );
    assert.ok(
      hookSrc.includes('setContext') && hookSrc.includes('ensureLoaded') && hookSrc.includes('dispose'),
      'T8: hook wires setContext/ensureLoaded/dispose lifecycle'
    );

    const drawerSrc = fs.readFileSync(drawerPath, 'utf8');
    assert.ok(
      drawerSrc.includes('useAuditLog('),
      'T8: ReservationDetailDrawer consumes useAuditLog'
    );
    assert.ok(
      !drawerSrc.includes('createAuditStateMachine'),
      'T8: drawer has no standalone audit state machine copy'
    );

    // initial state sanity
    const init = createAuditLogInitialState(null);
    assert.strictEqual(init.disposed, false);
    assert.strictEqual(init.gen, 0);

    ok('T8: hook + drawer wiring verified (no standalone state machine)');
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
