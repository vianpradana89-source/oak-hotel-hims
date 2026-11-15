/**
 * auditLogController — pure, framework-free controller for the Reservation
 * Detail Drawer's "Riwayat" (activity log) state machine.
 *
 * Extracted so the actual logic used by `useAuditLog` (and therefore the
 * drawer) can be tested directly without a DOM, React, or a browser:
 *
 *  - generation-based request identity (not just the "prop:res" string)
 *  - stale-response discard on success AND error paths (incl. finally)
 *  - in-flight guard (no double fetch)
 *  - no auto-retry after initial failure
 *  - A→B→A protection when the first A request is still pending
 *  - load-more failure preserves entries + cursor for retry
 *  - context-change reset + unmount invalidation
 *
 * The React hook binds this controller to React state via `subscribe`.
 * The drawer consumes the hook; this file contains the authoritative
 * transition logic, so tests that import this module exercise real code,
 * not a standalone copy.
 */

/** One row of the reservation activity log timeline (backend redacted DTO). */
export interface AuditLogEntry {
  audit_id: number;
  module: string | null;
  action: string | null;
  summary: string;
  actor: string;
  formatted_time: string;
}

/** GET /api/reservations/:id/audit response envelope. */
export interface AuditLogResponse {
  status: 'OK';
  data: AuditLogEntry[];
  has_more: boolean;
  next_cursor: string | null;
}

/** Observable UI state of the activity log. */
export interface AuditLogUiState {
  /** "propertyId:reservationId" identity of the current context. */
  contextKey: string | null;
  /**
   * Monotonic generation counter. Bumped on context change, explicit retry,
   * and dispose. Every in-flight request captures the generation at start;
   * when it settles, any state change is discarded if the generation no
   * longer matches. This is the request-identity mechanism that protects
   * A→B→A when the first A request is still pending.
   */
  gen: number;
  /** True while a fetch (initial or load-more) is in flight. */
  inFlight: boolean;
  /** True once the initial load was attempted for the current context. */
  loadAttempted: boolean;
  entries: AuditLogEntry[];
  hasMore: boolean;
  cursor: string | null;
  loading: boolean;
  /** Initial-load failure message. */
  error: string | null;
  /** Load-more failure message (entries + cursor are preserved). */
  loadMoreError: string | null;
  /** Set on dispose; no further transitions are applied. */
  disposed: boolean;
}

/** Result of one fetchPage call (already mapped from SafeFetchResult). */
export interface FetchPageResult {
  ok: boolean;
  data: AuditLogResponse | null;
  errorMessage?: string;
}

export interface CreateControllerOptions {
  /** Initial context identity ("propId:resId") or null. */
  contextKey: string | null;
  /** Fire the initial fetch on creation (when the tab is already active). */
  autoLoad: boolean;
  /**
   * Fetch one page for the given context key. MUST resolve (never reject
   * into the controller); transport failures are mapped to
   * `{ ok: false, errorMessage }`.
   */
  fetchPage: (args: {
    contextKey: string;
    cursor: string | null;
    append: boolean;
  }) => Promise<FetchPageResult>;
}

export interface AuditLogController {
  /** Current observable state (getter-backed). */
  readonly state: AuditLogUiState;
  /** Subscribe to state transitions; returns unsubscribe. */
  subscribe(fn: (s: AuditLogUiState) => void): () => void;
  /**
   * Explicit "Coba lagi" for the initial load: invalidates any in-flight
   * request, resets entries/cursor/errors, and fires a fresh page-1 fetch.
   */
  retry(): void;
  /**
   * Load the next page (appends). Keeps entries + cursor on failure so the
   * user can retry with the same cursor.
   */
  loadMore(): void;
  /**
   * Switch context identity: invalidates in-flight requests (generation
   * bump), resets state. Fires the initial fetch only when `autoLoad` is
   * true for the new context.
   */
  setContext(key: string | null, opts?: { autoLoad?: boolean }): void;
  /**
   * Fire the initial fetch for the current context if it has not been
   * attempted yet and nothing is in flight. No-op otherwise (this is what
   * enforces "fire once per context, no auto-retry after failure").
   */
  ensureLoaded(): void;
  /** Invalidate all pending work; no further transitions are applied. */
  dispose(): void;
}

export function createAuditLogInitialState(contextKey: string | null = null): AuditLogUiState {
  return {
    contextKey,
    gen: 0,
    inFlight: false,
    loadAttempted: false,
    entries: [],
    hasMore: false,
    cursor: null,
    loading: false,
    error: null,
    loadMoreError: null,
    disposed: false,
  };
}

export function createAuditLogController(opts: CreateControllerOptions): AuditLogController {
  let state = createAuditLogInitialState(opts.contextKey);
  const listeners = new Set<(s: AuditLogUiState) => void>();

  const emit = (next: AuditLogUiState) => {
    if (state.disposed && next.gen === state.gen) return; // frozen after dispose
    state = next;
    for (const fn of [...listeners]) fn(state);
  };

  /**
   * Start a fetch for the current context.
   * Guards: disposed / null context / in-flight (double-fetch protection).
   * The request captures `gen` at start; settlement (success, error, or
   * finally) is a no-op when the generation moved on (context change,
   * retry, or dispose).
   */
  const startFetch = (cursor: string | null, append: boolean) => {
    if (state.disposed || state.inFlight || !state.contextKey) return;
    emit({
      ...state,
      inFlight: true,
      loading: true,
      ...(append
        ? { loadMoreError: null }
        : { error: null, loadMoreError: null, loadAttempted: true }),
    });

    const capturedGen = state.gen;
    const capturedKey = state.contextKey;

    opts.fetchPage({ contextKey: capturedKey, cursor, append }).then(
      result => {
        // Stale-response guard: context changed, retry fired, or unmount.
        // The finally-equivalent transitions below therefore also never run
        // for a stale request — a new request's inFlight/loading is intact.
        if (state.disposed || state.gen !== capturedGen) return;
        if (result.ok && result.data) {
          const incoming = result.data.data ?? [];
          emit({
            ...state,
            inFlight: false,
            loading: false,
            entries: append ? [...state.entries, ...incoming] : incoming,
            hasMore: Boolean(result.data.has_more),
            cursor: result.data.next_cursor ?? null,
          });
        } else {
          emit({
            ...state,
            inFlight: false,
            loading: false,
            ...(append
              ? { loadMoreError: result.errorMessage || 'Gagal memuat lebih banyak log.' }
              : { error: result.errorMessage || 'Gagal memuat log aktivitas.' }),
          });
        }
      },
      (err: unknown) => {
        console.warn('audit-log fetchPage rejected', err);
        if (state.disposed || state.gen !== capturedGen) return;
        emit({
          ...state,
          inFlight: false,
          loading: false,
          ...(append
            ? { loadMoreError: 'Gagal memuat lebih banyak log.' }
            : { error: 'Gagal memuat log aktivitas.' }),
        });
      }
    );
  };

  const controller: AuditLogController = {
    get state() {
      return state;
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    retry() {
      if (state.disposed || !state.contextKey) return;
      // Generation bump invalidates any in-flight request for this context.
      emit({
        ...createAuditLogInitialState(state.contextKey),
        gen: state.gen + 1,
      });
      startFetch(null, false);
    },

    loadMore() {
      if (!state.cursor || !state.hasMore || state.disposed) return;
      startFetch(state.cursor, true);
    },

    setContext(key, sopts) {
      if (state.disposed) return;
      const autoLoad = sopts?.autoLoad ?? false;
      // Generation bump invalidates in-flight requests for the old context.
      emit({
        ...createAuditLogInitialState(key),
        gen: state.gen + 1,
      });
      if (autoLoad && key) startFetch(null, false);
    },

    ensureLoaded() {
      // Fires once per context; after a failure loadAttempted stays true,
      // so tab re-activation never auto-retries — only retry() does.
      if (state.disposed || state.loadAttempted || state.inFlight) return;
      if (!state.contextKey) return;
      startFetch(null, false);
    },

    dispose() {
      // Generation bump + disposed flag: pending settlements become no-ops.
      // loading/inFlight are cleared so the frozen state is clean.
      emit({
        ...state,
        disposed: true,
        gen: state.gen + 1,
        loading: false,
        inFlight: false,
      });
      listeners.clear();
    },
  };

  if (opts.autoLoad && opts.contextKey) startFetch(null, false);

  return controller;
}
