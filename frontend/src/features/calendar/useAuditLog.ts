/**
 * useAuditLog — React binding for the audit-log activity tab in the
 * Reservation Detail Drawer.
 *
 * The authoritative state machine lives in `auditLogController.ts`
 * (pure, framework-free, covered by the controller test suite). This hook
 * wires that controller to React state:
 *
 *  - one ACTIVE controller per effect setup; the controller is created
 *    inside the mount effect, never lazily during render
 *  - effect cleanup disposes that controller (generation bump invalidates
 *    any in-flight request), so pending responses can never become valid
 *    again — the old controller is never revived
 *  - React StrictMode's setup→cleanup→setup cycle therefore produces a
 *    fresh controller with a correct subscription and context on re-setup
 *  - context changes (propertyId / reservationId) drive `setContext` on the
 *    ACTIVE controller, which bumps the generation, resets entries (old
 *    context can never display in a new context), and invalidates in-flight
 *    requests
 *  - tab activation drives `ensureLoaded` (fires once per context — lazy load)
 *  - unmount disposes so no setState runs after the drawer closes
 *
 * Generation-based request identity (in the controller) is what makes
 * stale responses — including their error and finally paths — no-ops, and
 * what protects A→B→A when the first A request is still pending.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { safeFetchJson } from './calendarApi';
import {
  createAuditLogController,
  createAuditLogInitialState,
  type AuditLogController,
  type AuditLogEntry,
  type AuditLogResponse,
  type AuditLogUiState,
} from './auditLogController';

export { type AuditLogEntry, type AuditLogResponse, type AuditLogUiState };

export interface UseAuditLogOptions {
  /** Property ID for the current context. */
  propertyId: number | null;
  /** Reservation ID for the current context. */
  reservationId: number | null;
  /** Authenticated fetch (from useAuth). */
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** True while the Riwayat tab is active; drives the one-shot initial load. */
  shouldAutoLoad: boolean;
}

export interface UseAuditLogResult {
  entries: AuditLogEntry[];
  hasMore: boolean;
  cursor: string | null;
  loading: boolean;
  error: string | null;
  loadMoreError: string | null;
  /** Explicit "Coba lagi": invalidates in-flight, resets, re-fetches page 1. */
  retry: () => void;
  /** Load the next page (appends). Keeps entries + cursor on failure. */
  loadMore: () => void;
}

export function useAuditLog({
  propertyId,
  reservationId,
  authFetch,
  shouldAutoLoad,
}: UseAuditLogOptions): UseAuditLogResult {
  const contextKey =
    propertyId != null && reservationId != null
      ? `${propertyId}:${reservationId}`
      : null;

  // Always-current references so the mount effect's fetchPage closure never
  // reads stale props. The context/tab effects capture the current-render
  // value directly (they re-run on that value), so no ref is needed there.
  const authFetchRef = useRef(authFetch);
  authFetchRef.current = authFetch;
  const shouldAutoLoadRef = useRef(shouldAutoLoad);
  shouldAutoLoadRef.current = shouldAutoLoad;

  const [ui, setUi] = useState<AuditLogUiState>(() => createAuditLogInitialState(contextKey));

  // Stale-context guard: when ui.contextKey differs from the current render
  // contextKey, entries, cursor, error, and status from the old context must
  // not be shown. This covers the transient window between the mount effect's
  // `setUi(controller.state)` (fresh controller, contextKey: null) and the
  // context effect's setContext (which emits the real context).
  const stale = ui.contextKey !== contextKey;
  const entries = stale ? [] : ui.entries;
  const hasMore = stale ? false : ui.hasMore;
  const cursor = stale ? null : ui.cursor;
  const loading = stale ? false : ui.loading;
  const error = stale ? null : ui.error;
  const loadMoreError = stale ? null : ui.loadMoreError;

  // The ACTIVE controller. Created inside the mount effect (not during
  // render) so that every effect setup — including React StrictMode's
  // second setup after the simulated unmount — starts from a FRESH
  // controller. Cleanup disposes exactly the controller it created; the
  // disposed instance is never revived, so its pending responses stay
  // invalid forever (generation guard inside the controller).
  const controllerRef = useRef<AuditLogController | null>(null);

  useEffect(() => {
    // ── Setup: create a NEW active controller ──
    const controller = createAuditLogController({
      contextKey: null,
      autoLoad: false,
      fetchPage: async ({ contextKey: key, cursor, append }) => {
        // The captured key is authoritative for THIS request (A→B→A safe):
        // parse it rather than reading current props.
        const sepIdx = key.indexOf(':');
        const p = key.substring(0, sepIdx);
        const r = key.substring(sepIdx + 1);
        const params = new URLSearchParams({ property_id: p, limit: '30' });
        if (cursor) params.set('cursor', cursor);
        try {
          const result = await safeFetchJson<AuditLogResponse>(
            `/api/reservations/${r}/audit?${params.toString()}`,
            undefined,
            undefined,
            authFetchRef.current,
          );
          if (result.ok && result.data?.status === 'OK') {
            return { ok: true, data: result.data };
          }
          return {
            ok: false,
            data: null,
            errorMessage:
              result.errorMessage ||
              (append ? 'Gagal memuat lebih banyak log.' : 'Gagal memuat log aktivitas.'),
          };
        } catch {
          return {
            ok: false,
            data: null,
            errorMessage:
              append ? 'Gagal memuat lebih banyak log.' : 'Gagal memuat log aktivitas.',
          };
        }
      },
    });
    controllerRef.current = controller;

    // Subscribe React state to the ACTIVE controller, then sync React state
    // to its (fresh) initial state so entries from a previous controller /
    // context can never linger on screen after a re-setup.
    const unsub = controller.subscribe(setUi);
    setUi(controller.state);

    return () => {
      // ── Cleanup: cancel the OLD controller ──
      // Unsubscribe first, then dispose. dispose() bumps the generation, so
      // any in-flight request of THIS controller becomes a permanent no-op —
      // its pending response can never become valid again. The next setup
      // creates a brand-new controller; this one is never revived.
      unsub();
      controller.dispose();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
    // The fetchPage closure reads live refs; the effect intentionally runs
    // once per mount lifecycle (setup→cleanup→setup in StrictMode included).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Context change (property / reservation): delegate to the ACTIVE
  // controller. setContext bumps the generation (invalidating in-flight
  // requests), resets entries/cursor/errors (old context cannot display in
  // a new context), and auto-loads only when the tab is already active.
  useEffect(() => {
    controllerRef.current?.setContext(contextKey, {
      autoLoad: shouldAutoLoadRef.current,
    });
  }, [contextKey]);

  // Tab activation: fire the one-shot initial load for the current context
  // (lazy load — nothing fetches until the Riwayat tab is active).
  useEffect(() => {
    if (shouldAutoLoad) controllerRef.current?.ensureLoaded();
  }, [shouldAutoLoad]);

  const retry = useCallback(() => controllerRef.current?.retry(), []);
  const loadMore = useCallback(() => controllerRef.current?.loadMore(), []);

  return {
    entries,
    hasMore,
    cursor,
    loading,
    error,
    loadMoreError,
    retry,
    loadMore,
  };
}
