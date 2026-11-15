/**
 * AUDIT-LOG HOOK LIFECYCLE TESTS (v5) — StrictMode + context change
 *
 * Exercises the ACTUAL useAuditLog hook (not a hand-rolled simulation) by
 * mounting it in a minimal React DOM harness. The hook is the production
 * state machine; the harness renders a probe component that records the live
 * hook result, so assertions run against the real values the UI would show.
 *
 * Coverage:
 *  L1  Mount with Riwayat active (shouldAutoLoad=true): exactly ONE initial
 *      request per effect setup (no double setContext/auto-load).
 *  L2  StrictMode: the first controller is disposed and inert after the
 *      simulated unmount; the re-created controller is the one serving.
 *  L3  Rerender A→B (context switch): entries from A are NOT shown for B;
 *      the stale A response that settles late is discarded.
 *  L4  A→B→A while the first A request is still pending: returning to A
 *      triggers a fresh A fetch; the original stale A response is a no-op.
 *  L5  Initial-load failure does not auto-retry; explicit retry succeeds,
 *      and a load-more failure keeps entries+cursor so retry can succeed.
 *
 * No new dependencies: the harness uses react + react-dom (already installed)
 * plus a minimal DOM stub and a load-time TS-resolve hook (loader_register_ts.mjs).
 * Run:
 *   cd frontend && node --experimental-strip-types test/audit_log_hook_lifecycle_test.ts
 */
// Register the extensionless-→-.ts resolve hook BEFORE importing app modules.
// (side-effect import; no logic here)
await import('./loader_register_ts.mjs');

import assert from 'node:assert/strict';
// useAuditLog is loaded DYNAMICALLY (after the resolve hook above is
// registered) so its extensionless relative imports (./calendarApi, ...)
// resolve under --experimental-strip-types.
type UseAuditLogFn = typeof import('../src/features/calendar/useAuditLog.ts').useAuditLog;
type AuditLogEntryT = import('../src/features/calendar/auditLogController.ts').AuditLogEntry;
type AuditLogResponseT = import('../src/features/calendar/auditLogController.ts').AuditLogResponse;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { useAuditLog } = await import('../src/features/calendar/useAuditLog.ts');

// ── Minimal DOM stub (react-dom probes these globals on use) ───────────────
function makeNode(nodeType: number, tag: string) {
  return {
    nodeType,
    tagName: tag ? tag.toUpperCase() : '',
    childNodes: [] as any[],
    style: {} as Record<string, unknown>,
    dataset: {} as Record<string, string>,
    setAttribute() {},
    getAttribute() { return null; },
    setAttributeNS() {},
    appendChild(c: any) { this.childNodes.push(c); c.parentNode = this; return c; },
    removeChild(c: any) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); return c; },
    insertBefore(a: any, _b: any) { this.childNodes.push(a); return a; },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    contains(n: any) { return this.childNodes.includes(n); },
    parentNode: null as unknown,
    ownerDocument: null as unknown,
    textContent: '',
  };
}

function installDomStub() {
  const doc: any = {
    createElement: (t: string) => { const n = makeNode(1, t); n.ownerDocument = doc; return n; },
    createElementNS: (_ns: string, t: string) => { const n = makeNode(1, t); n.ownerDocument = doc; return n; },
    createTextNode: (t: string) => ({ nodeType: 3, nodeValue: t, textContent: t, ownerDocument: doc, appendChild() {}, removeChild() {}, childNodes: [] }),
    createComment: (t: string) => ({ nodeType: 8, nodeValue: t, childNodes: [] }),
    documentElement: makeNode(1, 'HTML'),
    body: makeNode(1, 'BODY'),
    head: makeNode(1, 'HEAD'),
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    activeElement: null,
    defaultView: globalThis,
    HTMLIFrameElement: class HTMLIFrameElement {},
  };
  doc.documentElement.ownerDocument = doc;
  doc.body.ownerDocument = doc;
  doc.head.ownerDocument = doc;

  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.document = doc;
  globalThis.window = globalThis;
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });
  globalThis.HTMLIFrameElement = doc.HTMLIFrameElement;
  globalThis.Element = class Element {};
  globalThis.Node = class Node {};
  globalThis.HTMLElement = class HTMLElement {};
  globalThis.Text = class Text {};
}
installDomStub();

// React is required AFTER the DOM stub is in place (react-dom probes globals).
// Use dynamic import() (not require) because the file uses top-level await.
const React = (await import('react')).default ?? (await import('react'));
const { createRoot } = await import('react-dom/client');
const act = React.act;

// ── Test fetch transport (records calls; responses are controllable) ─────────
function makeTransport() {
  const calls: { url: string; init?: RequestInit }[] = [];
  let responder: (url: string, init?: RequestInit) => Promise<Response> = async () =>
    jsonResponse({ status: 'OK', data: [], has_more: false, next_cursor: null });
  const authFetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  return {
    authFetch,
    calls,
    setResponder(fn: typeof responder) { responder = fn; },
    okResponder(entries: AuditLogEntryT[], has_more = false, next_cursor: string | null = null) {
      responder = async () => jsonResponse({ status: 'OK', data: entries, has_more, next_cursor } as unknown as AuditLogResponseT);
    },
    failResponder(message = 'Server error') {
      responder = async () => jsonResponse({ status: 'ERR', error: message } as unknown as AuditLogResponseT);
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function entry(audit_id: number, summary = `E${audit_id}`): AuditLogEntryT {
  return { audit_id, module: 'PMS', action: 'CREATE', summary, actor: 'A', formatted_time: '2026-01-01 00:00:00' };
}

// ── Probe component: renders useAuditLog and records its live result ─────────
type HookResult = ReturnType<UseAuditLogFn>;
function makeProbe(recorder: { result: HookResult | null }) {
  function Probe(props: {
    propertyId: number | null;
    reservationId: number | null;
    authFetch: (url: string, init?: RequestInit) => Promise<Response>;
    shouldAutoLoad: boolean;
  }) {
    const r = useAuditLog({
      propertyId: props.propertyId,
      reservationId: props.reservationId,
      authFetch: props.authFetch,
      shouldAutoLoad: props.shouldAutoLoad,
    });
    recorder.result = r;
    return null;
  }
  return Probe;
}

interface Props {
  propertyId: number | null;
  reservationId: number | null;
  shouldAutoLoad: boolean;
}
interface Mount {
  set: (props: Props) => Promise<void>;
  unmount: () => Promise<void>;
}

async function mountHarness(opts: {
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  recorder: { result: HookResult | null };
  initial: Props;
  strict?: boolean;
}): Promise<Mount> {
  const Probe = makeProbe(opts.recorder);
  const container = (globalThis.document as any).createElement('div');
  (globalThis.document as any).body.appendChild(container);
  const root = createRoot(container);

  let props: Props = { ...opts.initial };

  const render = () =>
    React.createElement(
      opts.strict ? React.StrictMode : React.Fragment,
      null,
      React.createElement(Probe, { ...props, authFetch: opts.authFetch })
    );

  await act(async () => {
    root.render(render());
  });

  const set = async (next: Props) => {
    props = next;
    await act(async () => {
      root.render(render());
    });
  };
  const unmount = async () => {
    await act(async () => {
      root.unmount();
    });
  };

  return { set, unmount };
}

// Settle pending microtasks so deferred fetch promises settle.
const settle = () => new Promise<void>(r => setTimeout(r, 0));

let passed = 0, failed = 0;
function ok(msg: string) { passed++; console.log(`  PASS: ${msg}`); }
function fail(msg: string, err?: unknown) {
  failed++;
  console.error(`  FAIL: ${msg}`);
  if (err) console.error(`    ${err instanceof Error ? err.stack : err}`);
}

async function main() {
  console.log('\n=== Audit-Log Hook Lifecycle Tests (v5, ACTUAL useAuditLog) ===\n');

  // ── L1: Mount with Riwayat active → exactly ONE initial request. ──
  {
    const t = makeTransport();
    t.okResponder([entry(1), entry(2)]);
    const rec: { result: HookResult | null } = { result: null };
    const m = await mountHarness({
      authFetch: t.authFetch,
      recorder: rec,
      initial: { propertyId: 1, reservationId: 100, shouldAutoLoad: true },
    });

    await settle();
    assert.strictEqual(t.calls.length, 1, `L1: exactly one fetch on mount with Riwayat active, got ${t.calls.length}`);
    const r = rec.result!;
    assert.strictEqual(r.entries.length, 2, `L1: two entries loaded, got ${r.entries.length}`);
    assert.strictEqual(r.loading, false, 'L1: loading cleared after settle');
    assert.strictEqual(r.error, null, 'L1: no error');

    // De-activate then re-activate: still no new fetch (one-shot per context).
    await m.set({ propertyId: 1, reservationId: 100, shouldAutoLoad: false });
    await m.set({ propertyId: 1, reservationId: 100, shouldAutoLoad: true });
    await settle();
    assert.strictEqual(t.calls.length, 1, `L1: re-activation does not re-fetch, got ${t.calls.length}`);

    await m.unmount();
    ok('L1: mount with Riwayat active fires one request; re-activation is one-shot');
  }

  // ── L2: StrictMode → old controller disposed, new controller functional. ──
  {
    const t = makeTransport();
    t.okResponder([entry(1), entry(2)]);
    const rec: { result: HookResult | null } = { result: null };
    const m = await mountHarness({
      authFetch: t.authFetch,
      recorder: rec,
      initial: { propertyId: 1, reservationId: 100, shouldAutoLoad: true },
      strict: true,
    });

    await settle();
    // StrictMode setup→cleanup→setup creates two controllers; only the SECOND
    // (active) one is functional. Both fire auto-load on setup, so ≥2 calls.
    assert.ok(t.calls.length >= 1, `L2: at least one fetch under StrictMode, got ${t.calls.length}`);
    // The ACTIVE controller's result is what's displayed.
    assert.strictEqual(rec.result!.entries.length, 2, `L2: active controller entries visible, got ${rec.result!.entries.length}`);

    // retry() on the live controller fires a NEW fetch.
    const before = t.calls.length;
    await act(async () => { rec.result!.retry(); });
    await settle();
    assert.ok(t.calls.length > before, `L2: retry fired a new fetch (calls ${before}->${t.calls.length})`);

    await m.unmount();
    ok('L2: StrictMode — old controller inert, re-created controller serves');
  }

  // ── L3: Rerender A→B does not display A's entries; stale A discarded. ──
  {
    const t = makeTransport();
    let aResolve: ((e: AuditLogEntryT[]) => void) | null = null;
    let first = true;
    t.setResponder(async (_url, _init) => {
      if (first) {
        first = false;
        // First (A) fetch: hold it under our control.
        return new Promise<Response>(res => {
          const p = new Promise<AuditLogEntryT[]>(r => { aResolve = r; });
          p.then(e => res(jsonResponse({ status: 'OK', data: e, has_more: false, next_cursor: null } as unknown as AuditLogResponseT)));
        });
      }
      // B context
      return jsonResponse({ status: 'OK', data: [entry(2, 'B-entry')], has_more: false, next_cursor: null } as unknown as AuditLogResponseT);
    });

    const rec: { result: HookResult | null } = { result: null };
    const m = await mountHarness({
      authFetch: t.authFetch,
      recorder: rec,
      initial: { propertyId: 1, reservationId: 100, shouldAutoLoad: true },
    });
    // A's fetch is PENDING. Switch to B.
    await m.set({ propertyId: 1, reservationId: 200, shouldAutoLoad: true });
    await settle();
    // B's entries are shown; A's entries (still pending) are NOT.
    const ids = rec.result!.entries.map(e => e.audit_id);
    assert.deepStrictEqual(ids, [2], `L3: B shows only B entries, got ${JSON.stringify(ids)}`);

    // Now let the stale A response settle — must not appear.
    if (aResolve) aResolve([entry(1, 'STALE-A')]);
    await settle();
    const ids2 = rec.result!.entries.map(e => e.audit_id);
    assert.deepStrictEqual(ids2, [2], `L3: stale A response discarded, got ${JSON.stringify(ids2)}`);

    await m.unmount();
    ok('L3: rerender A→B hides A entries; stale late A response is discarded');
  }

  // ── L4: A→B→A with the first A request still pending. ──
  {
    const t = makeTransport();
    let firstA: ((e: AuditLogEntryT[]) => void) | null = null;
    let fetchSeq = 0;
    t.setResponder(async (_url, _init) => {
      fetchSeq++;
      if (fetchSeq === 1) {
        // Original A — keep it pending under our control.
        return new Promise<Response>(res => {
          const p = new Promise<AuditLogEntryT[]>(x => { firstA = x; });
          p.then(e => res(jsonResponse({ status: 'OK', data: e, has_more: false, next_cursor: null } as unknown as AuditLogResponseT)));
        });
      }
      if (fetchSeq === 2) {
        // B
        return jsonResponse({ status: 'OK', data: [entry(2, 'B')], has_more: false, next_cursor: null } as unknown as AuditLogResponseT);
      }
      // Fresh A on return
      return jsonResponse({ status: 'OK', data: [entry(1, 'A-fresh')], has_more: false, next_cursor: null } as unknown as AuditLogResponseT);
    });

    const rec: { result: HookResult | null } = { result: null };
    const m = await mountHarness({
      authFetch: t.authFetch,
      recorder: rec,
      initial: { propertyId: 1, reservationId: 100, shouldAutoLoad: true },
    });

    // Switch to B (its fetch settles immediately).
    await m.set({ propertyId: 1, reservationId: 200, shouldAutoLoad: true });
    await settle();
    assert.deepStrictEqual(rec.result!.entries.map(e => e.audit_id), [2], 'L4: B entries visible');

    // Switch back to A (fresh A fetch settles immediately).
    await m.set({ propertyId: 1, reservationId: 100, shouldAutoLoad: true });
    await settle();
    assert.deepStrictEqual(rec.result!.entries.map(e => e.audit_id), [1], 'L4: fresh A entries visible, B wiped');

    // Now the ORIGINAL stale A (fetch #1) settles — must be a no-op.
    if (firstA) firstA([entry(99, 'STALE-ORIGINAL-A')]);
    await settle();
    assert.deepStrictEqual(rec.result!.entries.map(e => e.audit_id), [1], 'L4: original stale A response discarded');

    await m.unmount();
    ok('L4: A→B→A with first A pending — fresh A wins, stale original discarded');
  }

  // ── L5: Failure does not auto-retry; retry + load-more retry work. ──
  {
    const t = makeTransport();
    t.failResponder('initial failed');
    const rec: { result: HookResult | null } = { result: null };
    const m = await mountHarness({
      authFetch: t.authFetch,
      recorder: rec,
      initial: { propertyId: 1, reservationId: 100, shouldAutoLoad: true },
    });
    await settle();

    assert.strictEqual(rec.result!.error, 'Gagal memuat log aktivitas.', 'L5: initial-load failure recorded');
    assert.strictEqual(t.calls.length, 1, `L5: no auto-retry after failure, got ${t.calls.length} calls`);

    // De-activate + re-activate must NOT auto-retry (loadAttempted stays true).
    await m.set({ propertyId: 1, reservationId: 100, shouldAutoLoad: false });
    await m.set({ propertyId: 1, reservationId: 100, shouldAutoLoad: true });
    await settle();
    assert.strictEqual(t.calls.length, 1, `L5: re-activation after failure does not re-fetch, got ${t.calls.length} calls`);

    // Explicit retry succeeds.
    t.okResponder([entry(1), entry(2)], true, 'cursor-1');
    await act(async () => { rec.result!.retry(); });
    await settle();
    assert.strictEqual(rec.result!.entries.length, 2, 'L5: retry loaded entries');
    assert.strictEqual(rec.result!.error, null, 'L5: error cleared after retry');
    assert.strictEqual(t.calls.length, 2, 'L5: retry fired exactly one new fetch');

    // Load-more fails: entries + cursor are preserved.
    t.setResponder(async () => jsonResponse({ status: 'ERR', error: 'load-more failed' } as unknown as AuditLogResponseT));
    await act(async () => { rec.result!.loadMore(); });
    await settle();
    assert.strictEqual(rec.result!.entries.length, 2, 'L5: entries kept after load-more failure');
    assert.strictEqual(rec.result!.loadMoreError, 'Gagal memuat lebih banyak log.', 'L5: load-more error recorded');
    assert.strictEqual(rec.result!.cursor, 'cursor-1', 'L5: cursor kept for retry');

    // load-more retry with the SAME cursor succeeds.
    t.okResponder([entry(3)], false, null);
    await act(async () => { rec.result!.loadMore(); });
    await settle();
    assert.strictEqual(rec.result!.entries.length, 3, 'L5: load-more retry appended entry 3');

    await m.unmount();
    ok('L5: failure no auto-retry; retry succeeds; load-more failure keeps cursor; load-more retry works');
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
