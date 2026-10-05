import { useEffect, useRef, useCallback } from 'react';
import PosWorkspace from './PosWorkspace';
import type { PosMenuItem, PosOrderItem } from './PosWorkspace';

interface PosModalProps {
  open: boolean;
  propertyId: number | null;
  posMenu: PosMenuItem[];
  posOrders: PosOrderItem[];
  onRefresh?: () => void;
  /** App memutuskan apakah boleh ditutup (konfirmasi draft, request berjalan, dsb.) */
  onRequestClose: () => void;
  /** Cart berisi — dipakai UI untuk menampilkan hint guard close. */
  cartHasItems: boolean;
  /** Request sedang berjalan — cegah close/submit ganda. */
  busy: boolean;
  /** Notifikasi perubahan isi cart (true/false) ke parent. */
  onCartChange?: (hasItems: boolean) => void;
  /** Notifikasi request in-flight dari PosWorkspace (sinkron, ref di App). */
  onRequestPending?: (pending: boolean) => void;
  /** Notifikasi status unresolved dari PosWorkspace (snapshot ambigu). */
  onUnresolvedChange?: (unresolved: boolean) => void;
  /**
   * Authenticated fetch dari useAuth() — diteruskan ke PosWorkspace agar
   * "Simpan Pesanan" melakukan POST /api/pos/orders nyata.
   * Jika undefined, tombol tetap menunjukkan mode demo (backward-compatible).
   */
  authFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** reservation_id untuk scope order ke reservasi tertentu */
  reservationId?: number | null;
  /** Identitas reservasi/tamu untuk header modal. */
  reservationLabel?: string;
  /** Gate "Simpan Pesanan" — dari getPosAccess. */
  canEditPos?: boolean;
  /** Callback setelah order berhasil dibuat */
  onOrderCreated?: (order: PosOrderItem) => void;
}

/**
 * PosModal — membungkus PosWorkspace yang sudah ada di dalam overlay.
 * - Desktop: panel terpusat, tinggi terbatas, scroll internal.
 * - Mobile: sheet fullscreen.
 * - Cegah scroll halaman belakang saat open, fokus pindah ke panel, kembalikan fokus saat tutup.
 * - Semua jalur close (X, Escape, backdrop) memanggil onRequestClose — parent
 *   yang memutuskan konfirmasi draft / busy.
 */
export default function PosModal({
  open,
  propertyId,
  posMenu,
  posOrders,
  onRefresh,
  onRequestClose,
  cartHasItems,
  busy,
  onCartChange,
  onRequestPending,
  onUnresolvedChange,
  authFetch,
  reservationId,
  reservationLabel,
  canEditPos = true,
  onOrderCreated
}: PosModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const onRequestCloseRef = useRef(onRequestClose);
  onRequestCloseRef.current = onRequestClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // Fokus masuk ke panel saat buka; kembalikan fokus saat tutup.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => {
      panelRef.current?.focus();
    }, 0);
    return () => {
      window.clearTimeout(t);
      previouslyFocused.current?.focus?.();
      previouslyFocused.current = null;
    };
  }, [open]);

  // Cegah scroll halaman belakang saat open (body lock).
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  // Keyboard: Escape → satu jalur guard close; Tab/Shift+Tab → focus trap;
  // semua handler memakai ref agar tidak menutup halaman belakang dari focus lama.
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const key = e.key;
    if (key === 'Escape') {
      if (!busyRef.current) {
        e.preventDefault();
        e.stopPropagation();
        onRequestCloseRef.current();
      }
      return;
    }
    if (key !== 'Tab') return;

    // Fokus tetap berada di dalam panel
    const active = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (!panel) return;
    if (!active || !panel.contains(active)) {
      e.preventDefault();
      panel.focus();
      return;
    }

    // Kumpulkan semua elemen fokusable di dalam panel
    const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusables = Array.from(panel.querySelectorAll<HTMLElement>(selector))
      .filter((el) => el.offsetParent !== null);
    if (focusables.length === 0) {
      e.preventDefault();
      panel.focus();
      return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const isShiftTab = e.shiftKey;

    if (isShiftTab && (active === first || active === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!isShiftTab && active === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-stretch sm:items-center sm:justify-center bg-black/50 sm:bg-slate-900/60 sm:p-6"
      data-pos-modal-overlay="true"
      onMouseDown={(e) => {
        // Tutup hanya saat klik backdrop (bukan panel).
        if (e.target === e.currentTarget && !busy) onRequestClose();
      }}
      onKeyDown={handleKeyDown}
      role="presentation"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Point of Sale"
        className="relative bg-slate-100 w-full h-full sm:h-[92vh] sm:max-w-6xl sm:rounded-2xl flex flex-col overflow-hidden focus:outline-none shadow-2xl"
      >
        {/* Header modal: judul + tombol tutup eksplisit */}
        <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-3 bg-white border-b border-gray-200">
          <div className="flex items-center gap-2 min-w-0">
            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold tracking-wider bg-purple-50 text-purple-800 border border-purple-200/60 uppercase">
              POS
            </span>
            <h2 className="text-base font-black text-gray-900 tracking-tight truncate">
              Point of Sale &amp; F&amp;B
            </h2>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {cartHasItems && !busy && (
              <span className="hidden sm:inline text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5 font-medium">
                Draft belum disimpan
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                if (!busy) onRequestClose();
              }}
              disabled={busy}
              aria-label="Tutup POS"
              title={busy ? 'Menunggu proses selesai…' : 'Tutup POS'}
              className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-800 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Konten: scroll internal desktop; fullscreen mobile */}
        <div className="flex-1 overflow-y-auto p-3 sm:p-4">
          {/* onCreateDemoOrder sengaja TIDAK diteruskan ke PosWorkspace di dalam modal
              agar tombol "Buat Order Contoh" tidak muncul dan tidak ada transaksi demo. */}
          <PosWorkspace
            propertyId={propertyId}
            posMenu={posMenu}
            posOrders={posOrders}
            onRefresh={onRefresh}
            onCartChange={onCartChange}
            onRequestPending={onRequestPending}
            onUnresolvedChange={onUnresolvedChange}
            busy={busy}
            authFetch={authFetch}
            reservationId={reservationId}
            reservationLabel={reservationLabel}
            canEditPos={canEditPos}
            onOrderCreated={onOrderCreated}
          />
        </div>
      </div>
    </div>
  );
}
