import { useEffect, useRef, useCallback, useState } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PosPayCashOrderContext {
  orderId: number;
  propertyId: number;
  orderNumber: string;
  totalAmount: number | string;
  guestName?: string | null;
  roomNumber?: string | null;
  reservationId?: number | null;
}

import {
  POS_PAYMENT_METHODS, createPaySnapshot, isMethodAvailable, parseCashInput,
  readPosPaymentConfig, validatePayResponse,
  type PosPaymentMethod, type PosPaymentConfig, type PaySnapshot,
  type PayResponseShape, type SettlementRecord, type SaleRecord,
} from './posPaymentContract';
import PosThermalReceiptModal from '../thermalReceipt/PosThermalReceiptModal';
export { validatePayResponse } from './posPaymentContract';
export type { SettlementRecord, SaleRecord } from './posPaymentContract';

interface Props {
  /** Konteks order yang akan dibayar. */
  order: PosPayCashOrderContext;
  /** Authenticated fetch dari useAuth(). */
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Gate izin edit POS — bila false, tombol Konfirmasi disabled. */
  canEditPos: boolean;
  /** Parent memutuskan apakah boleh ditutup (pending/unresolved → tolak). */
  onRequestClose: () => void;
  /** Notifikasi request in-flight (sinkron, ref di parent). */
  onRequestPending?: (pending: boolean) => void;
  /** Notifikasi status unresolved (snapshot ambigu dipertahankan). */
  onUnresolvedChange?: (unresolved: boolean) => void;
  /** Callback sukses: settlement + sale terverifikasi dari respons. */
  onPaid?: (result: {
    settlement: SettlementRecord;
    sale: SaleRecord;
    created: boolean;
    replayed: boolean;
  }) => void;
  /** Refresh daftar order terkait (dipanggil setelah sukses terverifikasi). */
  onRefresh?: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatIDR(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Short display order reference untuk header modal.
 * Canonical: POS-YYYYMMDD-...
 * Display: POS-YYMMDD-<orderId padded 4>
 * Fallback ke orderNumber asli bila pattern/orderId invalid.
 */
function shortOrderDisplay(orderNumber: string, orderId: number): string {
  const m = /^POS-(\d{8})-(.+)$/.exec(orderNumber);
  if (!m || !Number.isInteger(orderId) || orderId <= 0) return orderNumber;
  const date = m[1];
  const yy = date.slice(2, 4);
  const mm = date.slice(4, 6);
  const dd = date.slice(6, 8);
  return `POS-${yy}${mm}${dd}-${String(orderId).padStart(4, '0')}`;
}

const GUEST_PLACEHOLDERS = new Set(['guest', 'walk-in guest', 'walk in guest']);
const ROOM_PLACEHOLDERS = new Set(['walk in', 'walk-in', 'walk in guest', 'walk-in guest']);

function isMeaningfulGuest(g: string | null | undefined): g is string {
  if (!g || !g.trim()) return false;
  return !GUEST_PLACEHOLDERS.has(g.trim().toLowerCase());
}

function isMeaningfulRoom(r: string | null | undefined): r is string {
  if (!r || !r.trim()) return false;
  return !ROOM_PLACEHOLDERS.has(r.trim().toLowerCase());
}

const METHOD_LABELS: Record<PosPaymentMethod, string> = {
  CASH: 'Tunai',
  QRIS: 'QRIS',
  TRANSFER: 'Transfer',
  DEBIT: 'Debit',
};

/**
 * Generate UUID v4 untuk Idempotency-Key pembayaran.
 * Terpisah dari key create-order — setiap pengajuan pembayaran punya key sendiri.
 */
function generateKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Validasi konteks order untuk pengajuan pembayaran. */
function isOrderContextValid(ctx: PosPayCashOrderContext): boolean {
  return (
    Number.isInteger(ctx.orderId) && ctx.orderId > 0 &&
    Number.isInteger(ctx.propertyId) && ctx.propertyId > 0 &&
    Number.isFinite(Number(ctx.totalAmount)) && Number(ctx.totalAmount) > 0 &&
    typeof ctx.orderNumber === 'string' && ctx.orderNumber.trim() !== ''
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

type Phase = 'confirming' | 'pending' | 'success' | 'ambiguous' | 'failed';

export default function PosPayCashModal({
  order,
  authFetch,
  canEditPos,
  onRequestClose,
  onRequestPending,
  onUnresolvedChange,
  onPaid,
  onRefresh,
}: Props) {
  // ── State (render) ────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>('confirming');
  const [result, setResult] = useState<{
    settlement: SettlementRecord;
    sale: SaleRecord;
    created: boolean;
    replayed: boolean;
  } | null>(null);
  const [failMessage, setFailMessage] = useState<string | null>(null);
  const [alreadyPaid, setAlreadyPaid] = useState(false);
  const [method, setMethod] = useState<PosPaymentMethod>('CASH');
  const [cashInput, setCashInput] = useState(String(order.totalAmount));
  const [reference, setReference] = useState('');
  const [verified, setVerified] = useState(false);
  const [config, setConfig] = useState<PosPaymentConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [reloadConfig, setReloadConfig] = useState(0);
  const [qrisImage, setQrisImage] = useState<{propertyId: number; url: string} | null>(null);
  const [qrisLoadedUrl, setQrisLoadedUrl] = useState<string | null>(null);
  const [qrisError, setQrisError] = useState<string | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const activeConfig = config?.property_id === order.propertyId ? config : null;
  const activeQrisUrl = qrisImage?.propertyId === order.propertyId ? qrisImage.url : null;
  const qrisImageLoaded = !!activeQrisUrl && qrisLoadedUrl === activeQrisUrl;


  // ── Refs sinkron (tidak menunggu render) ─────────────────────────────────
  /** Cegah double-submit: true saat request in-flight. */
  const submittingRef = useRef(false);
  /** Snapshot immutable — dibuat sebelum await pertama. */
  const snapshotRef = useRef<PaySnapshot | null>(null);
  /** True bila hasil pengajuan terakhir belum diketahui (5xx / network / malformed). */
  const unresolvedRef = useRef(false);
  /** Ref untuk guard close dari sisi lokal. */
  const pendingRef = useRef(false);
  /**
   * orderId yang sedang menampilkan receipt sukses.
   * Mencegah pembayaran baru untuk order yang sama selama modal masih
   * menampilkan bukti pembayaran (fase sukses).
   */
  const receiptOrderIdRef = useRef<number | null>(null);

  // ── Context valid ─────────────────────────────────────────────────────────
  const contextValid = isOrderContextValid(order);

  // ── Focus management ──────────────────────────────────────────────────────
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => {
      panelRef.current?.focus();
    }, 0);
    return () => {
      window.clearTimeout(t);
      previouslyFocused.current?.focus?.();
      previouslyFocused.current = null;
    };
  }, []);

  // Authenticated config/QR reads; cancel obsolete results and revoke every blob URL.
  useEffect(() => {
    let cancelled = false;
    let blobUrl: string | null = null;
    const controller = new AbortController();
    const propertyId = order.propertyId;
    setConfig(null); setConfigError(null); setConfigLoading(true);
    setQrisImage(null); setQrisLoadedUrl(null); setQrisError(null); setVerified(false);
    void (async () => {
      try {
        const res = await authFetch(`/api/pos/payment-config?property_id=${propertyId}`, {signal: controller.signal});
        const json = await res.json().catch(() => null);
        if (cancelled) return;
        const cfg = res.ok && json?.status === 'OK' ? readPosPaymentConfig(json.data, propertyId) : null;
        if (!cfg) throw new Error(json?.message || 'Pengaturan pembayaran belum dapat dimuat.');
        setConfig(cfg); setConfigLoading(false);
        if (!isMethodAvailable('QRIS', cfg)) return;
        try {
          const image = await authFetch(`/api/pos/payment-config/qris-image?property_id=${propertyId}`, {signal: controller.signal});
          if (!image.ok) throw new Error('Gambar QRIS resmi belum dapat dimuat.');
          const blob = await image.blob();
          if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type) || blob.size === 0 || blob.size > 2 * 1024 * 1024)
            throw new Error('Gambar QRIS resmi tidak valid.');
          if (cancelled) return;
          blobUrl = URL.createObjectURL(blob);
          setQrisImage({propertyId, url: blobUrl});
        } catch (err) {
          if (!cancelled) setQrisError(err instanceof Error ? err.message : 'Gambar QRIS belum dapat dimuat.');
        }
      } catch (err) {
        if (!cancelled) {setConfigError(err instanceof Error ? err.message : 'Pengaturan belum dapat dimuat.'); setConfigLoading(false);}
      }
    })();
    return () => {cancelled = true; controller.abort(); if (blobUrl) URL.revokeObjectURL(blobUrl);};
  }, [authFetch, order.propertyId, reloadConfig]);

  // ── Payment flow ──────────────────────────────────────────────────────────

  /**
   * Jalankan request pembayaran.
   * - Pengajuan baru: buat snapshot (UUID key + body), lalu POST.
   * - Retry unresolved: pakai snapshot key/path/body yang SAMA PERSIS.
   * - Jangan buat key baru selama unresolved.
   */
  const executePayment = useCallback(async (): Promise<void> => {
    // ── Guard: gate + context + double-submit + receipt ────────────────────
    if (!canEditPos || !contextValid) return;
    if (submittingRef.current) return;

    const orderId = order.orderId;
    const propertyId = order.propertyId;

    // Guard: cegah pembayaran baru untuk order yang sama selama modal
    // masih menampilkan receipt sukses (fase "success" dengan data).
    if (receiptOrderIdRef.current === orderId) return;

    // ── Blok pemilihan snapshot ───────────────────────────────────────────
    // Guard context: bila unresolved, snapshot wajib ada. Context order prop
    // tidak boleh berbeda dari snapshot — kalau berbeda, TOLAK tindakan
    // dengan pesan (bukan jalur pengajuan baru).
    const snap = snapshotRef.current;

    let key: string;
    let bodyJson: string;

    if (unresolvedRef.current) {
      if (!snap) {
        // Anomali: unresolved tanpa snapshot — tolak, jangan buat key baru.
        setFailMessage('Konteks pembayaran berubah — hasil sebelumnya belum diketahui.');
        setPhase('ambiguous');
        return;
      }
      if (snap.orderId !== orderId || snap.propertyId !== propertyId) {
        // Context order prop BERBEDA dari snapshot — TOLAK.
        // Jangan buat key, jangan ganti snapshot, jangan lepas unresolved.
        setFailMessage(
          'Konteks pembayaran berubah. Order sebelumnya belum selesai — ' +
          'selesaikan dulu sebelum melanjutkan.',
        );
        setPhase('ambiguous');
        return;
      }
      // Context cocok → retry memakai snapshot persis.
      key = snap.key;
      bodyJson = snap.bodyJson;
    } else if (snap !== null && (snap.orderId === orderId && snap.propertyId === propertyId)) {
      // Snapshot ada, tidak unresolved, context cocok → reuse.
      key = snap.key;
      bodyJson = snap.bodyJson;
    } else {
      // Pengajuan baru (atau context berubah tanpa unresolved): buat key baru.
      key = generateKey();
      try {
        const created = createPaySnapshot({orderId, propertyId, key, amount: order.totalAmount,
          method, cashInput, reference, config: activeConfig, qrisImageLoaded, verified});
        snapshotRef.current = created;
        bodyJson = created.bodyJson;
      } catch (err) {
        setFailMessage(err instanceof Error ? err.message : 'Periksa data pembayaran.');
        setPhase('failed');
        return;
      }
      // Pengajuan baru: unresolved di-reset.
      unresolvedRef.current = false;
      onUnresolvedChange?.(false);
    }

    // ── Mark pending sinkron (sebelum await) ───────────────────────────────
    submittingRef.current = true;
    pendingRef.current = true;
    setPhase('pending');
    setFailMessage(null);
    setAlreadyPaid(false);
    onRequestPending?.(true);

    // ── Build path dari snapshot (bukan dari order prop yang bisa berubah) ─
    const payPath = `/api/pos/orders/${snapshotRef.current!.orderId}/pay`;

    try {
      const res = await authFetch(payPath, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: bodyJson,
      });

      // ── Sukses: 200 (REPLAY) / 201 (SUCCESS) ────────────────────────────
      if (res.status === 200 || res.status === 201) {
        const json: PayResponseShape | null = await res.json().catch(() => null);
        const snapNow = snapshotRef.current;
        if (json && snapNow && validatePayResponse(res.status, json, snapNow)) {
          // Sukses terverifikasi — simpan settlement/SALE untuk tampilan.
          const r = {
            settlement: json.data!.settlement!,
            sale: json.data!.sale!,
            created: json.data!.created!,
            replayed: json.data!.replayed!,
          };
          setResult(r);
          setPhase('success');
          // Lepaskan unresolved hanya setelah sukses terverifikasi.
          unresolvedRef.current = false;
          onUnresolvedChange?.(false);
          // Bersihkan snapshot (siklus selesai).
          snapshotRef.current = null;
           // Simpan orderId yang sedang menampilkan receipt (untuk guard
          // pembayaran ulang pada order yang sama).
          receiptOrderIdRef.current = orderId;
          // Callback onPaid & onRefresh TERPISAH — kegagalan satu tidak
           // melompat ke yang lain. Kegagalan callback TIDAK mengubah
           // pembayaran sukses menjadi ambigu.
           if (onPaid) {
             try {
               onPaid(r);
             } catch (cbErr) {
               console.error('[PosPayCashModal] onPaid failed (pembayaran tetap valid):', cbErr);
             }
           }
           if (onRefresh) {
             try {
               onRefresh();
             } catch (cbErr) {
               console.error('[PosPayCashModal] onRefresh failed (pembayaran tetap valid):', cbErr);
             }
           }
        } else {
          // Respons sukses tapi MALFORMED → hasil belum diketahui.
          // Tandai unresolved sinkron SEBELUM pending dilepas.
          unresolvedRef.current = true;
          onUnresolvedChange?.(true);
          setPhase('ambiguous');
          setFailMessage(
            'Server membalas sukses tetapi data pembayaran tidak lengkap. ' +
            'Hasil belum diketahui — gunakan "Coba Lagi".',
          );
        }
      }
      // ── 409 ──────────────────────────────────────────────────────────────
      else if (res.status === 409) {
        const errJson: any = await res.json().catch(() => null);
        const code = errJson?.code ?? '';
        const wasUnresolved = unresolvedRef.current;

        if (code === 'ALREADY_PAID') {
          // ALREADY_PAID → pesan + refresh, BUKAN bukti pembayaran sukses.
          setAlreadyPaid(true);
          setFailMessage(
            errJson?.message || 'Order ini sudah memiliki pembayaran sebelumnya.',
          );
          if (wasUnresolved) {
            // Retry yang sudah ambigu: pertahankan phase ambiguous,
            // snapshot, unresolved, dan guard parent. Banner hasil belum
            // diketahui TETAP tampil. ALREADY_PAID tidak menghapus retry.
            setPhase('ambiguous');
          } else {
            // Pengajuan baru (belum pernah ambigu): penolakan definitif.
            setPhase('failed');
            snapshotRef.current = null;
            receiptOrderIdRef.current = null;
            unresolvedRef.current = false;
            onUnresolvedChange?.(false);
          }
          try {
            onRefresh?.();
          } catch (cbErr) {
            console.error('[PosPayCashModal] refresh after ALREADY_PAID failed:', cbErr);
          }
        } else {
          // 409 lain (IDEMPOTENCY_CONFLICT, ORDER_NOT_PAYABLE).
          setFailMessage(errJson?.message || 'Permintaan ditolak (HTTP 409).');
          if (wasUnresolved) {
            // Retry unresolved → pertahankan ambiguous, snapshot, unresolved.
            setPhase('ambiguous');
          } else {
            // Pengajuan baru → penolakan definitif.
            setPhase('failed');
            snapshotRef.current = null;
            receiptOrderIdRef.current = null;
            unresolvedRef.current = false;
            onUnresolvedChange?.(false);
          }
        }
      }
      // ── 4xx lain ─────────────────────────────────────────────────────────
      else if (res.status >= 400 && res.status < 500) {
        const errJson: any = await res.json().catch(() => null);
        const wasUnresolved = unresolvedRef.current;
        setFailMessage(
          errJson?.message ||
          (wasUnresolved
            ? 'Permintaan ditolak, tetapi pengajuan sebelumnya masih belum terselesaikan — hasil belum diketahui.'
            : `Permintaan ditolak (HTTP ${res.status}).`),
        );
        if (wasUnresolved) {
          // Retry unresolved mendapat 4xx → pertahankan phase ambiguous,
          // snapshot, unresolved, dan guard parent. Tombol "Coba Lagi"
          // tetap tersedia (digate izin & pending).
          setPhase('ambiguous');
        } else {
          // Pengajuan baru (belum pernah ambigu): 4xx = penolakan definitif.
          setPhase('failed');
          snapshotRef.current = null;
          receiptOrderIdRef.current = null;
          unresolvedRef.current = false;
          onUnresolvedChange?.(false);
        }
      }
      // ── 5xx / server error ───────────────────────────────────────────────
      else {
        const errJson: any = await res.json().catch(() => null);
        // 5xx → hasil tak pasti. Tandai unresolved sinkron SEBELUM pending dilepas.
        unresolvedRef.current = true;
        onUnresolvedChange?.(true);
        setPhase('ambiguous');
        setFailMessage(
          `${errJson?.message || `Server error (HTTP ${res.status}).`} ` +
          'Hasil pembayaran belum diketahui — gunakan "Coba Lagi".',
        );
      }
    } catch (networkErr) {
      // Network error / timeout → hasil tak diketahui.
      // Tandai unresolved sinkron SEBELUM pending dilepas.
      unresolvedRef.current = true;
      onUnresolvedChange?.(true);
      setPhase('ambiguous');
      setFailMessage(
        'Hasil pembayaran belum diketahui. Gunakan "Coba Lagi".',
      );
      console.error('[PosPayCashModal] network/timeout on pay:', networkErr);
    } finally {
      // Lepas pending sinkron di finally (satu-satunya tempat pending di-release).
      submittingRef.current = false;
      pendingRef.current = false;
      onRequestPending?.(false);
    }
  }, [
    canEditPos,
    contextValid,
    order,
    authFetch,
    onPaid,
    onRefresh,
    onRequestPending,
    onUnresolvedChange,
    method, cashInput, reference, activeConfig, qrisImageLoaded, verified,
  ]);

  // Konfirmasi (tombol): sinkron sebelum await.
  const handleConfirm = useCallback(() => {
    void executePayment();
  }, [executePayment]);

  // Retry (tombol "Coba Lagi" saat ambiguous): jalan ke executePayment,
  // yang otomatis mendeteksi snapshot unresolved dan memakainya.
  const handleRetry = useCallback(() => {
    void executePayment();
  }, [executePayment]);

  // ── Close guard ───────────────────────────────────────────────────────────
  // Guard lokal: pending/unresolved menolak SEMUA jalur close (tombol/Escape/backdrop).
  // Refs dipakai agar tidak menunggu render.
  const handleRequestClose = useCallback(() => {
    if (pendingRef.current || unresolvedRef.current) return;
    setReceiptOpen(false);
    onRequestClose();
  }, [onRequestClose]);

  // ── Keyboard: Escape + focus trap ────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleRequestClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const active = document.activeElement as HTMLElement | null;
      const panel = panelRef.current;
      if (!panel) return;
      if (!active || !panel.contains(active)) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const selector =
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(selector)).filter(
        (el) => el.offsetParent !== null,
      );
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
    },
    [handleRequestClose],
  );

  // ── Render ────────────────────────────────────────────────────────────────
  const totalValue = Number(order.totalAmount || 0);
  const isPending = phase === 'pending';
  const isAmbiguous = phase === 'ambiguous';
  const editable = (phase === 'confirming' || phase === 'failed') && !alreadyPaid;
  const cashReceived = parseCashInput(cashInput);
  const ready = method === 'CASH' ? cashReceived !== null && cashReceived >= totalValue
    : isMethodAvailable(method, activeConfig) && verified && reference.trim().length <= 100
      && (method !== 'QRIS' || qrisImageLoaded);
  const canConfirm = canEditPos && contextValid && editable && ready;
  const canRetry = canEditPos && isAmbiguous && !isPending;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 sm:bg-slate-900/50 p-4"
      data-pos-cash-payment-overlay="true"
      role="presentation"
      onMouseDown={(e) => {
        // Guard: tolak backdrop saat pending/unresolved
        if (e.target === e.currentTarget && !pendingRef.current && !unresolvedRef.current) {
          handleRequestClose();
        }
      }}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Bayar pesanan POS"
        className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto focus:outline-none"
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-4 py-3 bg-stone-50 border-b border-stone-200">
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="text-sm font-black text-stone-900 truncate">
              Detail Pembayaran
            </h3>
            <span className="font-mono text-xs font-semibold text-stone-600 truncate">
              {shortOrderDisplay(order.orderNumber, order.orderId)}
            </span>
          </div>
          <button
            type="button"
            onClick={handleRequestClose}
            disabled={isPending || isAmbiguous}
            aria-label="Tutup"
            title={isPending || isAmbiguous ? 'Menunggu proses selesai…' : 'Tutup'}
            className="p-1.5 rounded-lg text-stone-500 hover:bg-stone-100 hover:text-stone-800 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Body — detail konfirmasi */}
        <div className="p-4 space-y-3">
          <div className="rounded-lg bg-stone-50 border border-stone-200 p-3 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold tracking-wider text-stone-500 uppercase">
                Total Tagihan
              </span>
              <span className="text-lg font-black text-stone-900">
                {formatIDR(totalValue)}
              </span>
            </div>
            {(() => {
              const g = isMeaningfulGuest(order.guestName);
              const r = isMeaningfulRoom(order.roomNumber);
              if (!g && !r) return null;
              return (
                <p className="text-[11px] text-stone-500">
                  {[g, r ? `Kamar ${r}` : null].filter(Boolean).join(' · ')}
                </p>
              );
            })()}
          </div>

          {phase !== 'success' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" role="group" aria-label="Metode pembayaran">
                {POS_PAYMENT_METHODS.map((choice) => (
                  <button key={choice} type="button" aria-pressed={method === choice}
                    disabled={!editable || !canEditPos || !isMethodAvailable(choice, activeConfig)}
                    onClick={() => {if (pendingRef.current || unresolvedRef.current) return; setMethod(choice); setVerified(false); setFailMessage(null);}}
                    className={`px-2 py-2 text-xs font-bold rounded-lg border disabled:opacity-40 disabled:cursor-not-allowed ${method === choice ? 'bg-emerald-100 border-emerald-500 text-emerald-900' : 'border-stone-200 text-stone-700'}`}>
                    {METHOD_LABELS[choice]}
                  </button>
                ))}
              </div>
              {configLoading && <p className="text-xs text-stone-500">Memuat metode pembayaran…</p>}
              {configError && <p role="alert" className="text-xs text-amber-800">{configError} Tunai tetap tersedia.</p>}
              {editable && <button type="button" disabled={configLoading} onClick={() => {if (pendingRef.current || unresolvedRef.current) return; setVerified(false); setReloadConfig(v => v + 1);}}
                className="text-xs font-semibold text-emerald-800 underline disabled:opacity-40">Muat ulang metode</button>}
              {method === 'CASH' ? (
                <div className="space-y-2">
                  <label className="block text-xs font-semibold text-stone-700">Jumlah Uang Diterima (Rp)
                    <input type="text" inputMode="decimal" value={cashInput} disabled={!editable || !canEditPos}
                      onChange={e => {if (!pendingRef.current && !unresolvedRef.current) setCashInput(e.target.value);}}
                      className="mt-1 block w-full border border-stone-300 rounded-lg px-3 py-2 text-sm disabled:bg-stone-100" />
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={!editable || !canEditPos}
                      onClick={() => { if (!pendingRef.current && !unresolvedRef.current) setCashInput(String(totalValue)); }}
                      className="text-xs font-semibold text-emerald-800 underline disabled:opacity-40"
                    >
                      Uang Pas
                    </button>
                    <div className="flex items-center gap-1 text-xs">
                      <span>Kembalian</span>
                      <strong>{cashReceived !== null && cashReceived >= totalValue ? formatIDR(cashReceived - totalValue) : '—'}</strong>
                    </div>
                  </div>
                  {cashReceived === null || cashReceived < totalValue ? <p className="text-xs text-red-700">Uang diterima harus sama atau lebih besar dari tagihan.</p> : null}
                </div>
              ) : (
                <div className="space-y-3 rounded-xl border border-stone-200 p-3">
                  {method === 'QRIS' && <div className="space-y-2 text-xs text-center">
                    {activeConfig?.qris_terminal_name && <p className="font-semibold">{activeConfig.qris_terminal_name}</p>}
                    {activeConfig?.qris_merchant_id && <p>Merchant ID: {activeConfig.qris_merchant_id}</p>}
                    {activeQrisUrl && <img key={activeQrisUrl} src={activeQrisUrl} alt="QRIS resmi properti"
                      onLoad={() => setQrisLoadedUrl(activeQrisUrl)}
                      onError={() => {setQrisLoadedUrl(null); setQrisError('Gambar QRIS gagal ditampilkan. Muat ulang metode.');}}
                      className="mx-auto max-w-full max-h-64 object-contain" />}
                    {!qrisImageLoaded && <p className="text-amber-800">{qrisError || 'Menunggu gambar QRIS resmi…'}</p>}
                  </div>}
                  {method === 'TRANSFER' && <div className="space-y-1 text-xs">
                    {activeConfig?.bank_name && <p className="font-semibold">{activeConfig.bank_name}</p>}
                    <p className="font-mono text-lg font-bold">{activeConfig?.bank_account_number || 'Rekening belum tersedia'}</p>
                    {activeConfig?.bank_account_name && <p>Atas nama: {activeConfig.bank_account_name}</p>}
                    {activeConfig?.transfer_ref_note && <p className="whitespace-pre-wrap">{activeConfig.transfer_ref_note}</p>}
                  </div>}
                  {method === 'DEBIT' && <div className="text-xs"><p>Terminal EDC</p>
                    <p className="font-semibold">{activeConfig?.debit_edc_terminal || 'Terminal belum tersedia'}</p></div>}
                  <label className="block text-xs font-semibold text-stone-700">Referensi pembayaran (opsional)
                    <input type="text" maxLength={100} value={reference} disabled={!editable || !canEditPos}
                      onChange={e => {if (!pendingRef.current && !unresolvedRef.current) {setReference(e.target.value); setVerified(false);}}}
                      className="mt-1 block w-full border border-stone-300 rounded-lg px-3 py-2 disabled:bg-stone-100" />
                  </label>
                  <label className="flex items-start gap-2 text-xs text-stone-700">
                    <input type="checkbox" checked={verified} disabled={!editable || !canEditPos || (method === 'QRIS' && !qrisImageLoaded)}
                      onChange={e => {if (!pendingRef.current && !unresolvedRef.current) setVerified(e.target.checked);}} />
                    <span>Saya sudah memeriksa bahwa pembayaran {formatIDR(totalValue)} berhasil diterima pada
                      {method === 'QRIS' ? ' merchant QRIS resmi.' : method === 'TRANSFER' ? ' rekening resmi.' : ' terminal EDC.'}</span>
                  </label>
                </div>
              )}
              {!contextValid && <p className="text-xs text-red-700">Pesanan belum dapat dibayar. Nominal harus lebih dari nol.</p>}
            </div>
          )}

          {/* Success state */}
          {phase === 'success' && result && (() => {
            const sm = result.settlement.payment_method as PosPaymentMethod;
            const methodLabel = METHOD_LABELS[sm] ?? sm;
            const validTs = (v: string | null) => (v !== null && v !== '' && Number.isFinite(Date.parse(v)) ? v : null);
            const verifiedAt = validTs(result.settlement.verified_at);
            const createdAt = validTs(result.settlement.created_at);
            const paymentTimeSource = verifiedAt ?? createdAt;
            const payTime = paymentTimeSource
              ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Jakarta' }).format(new Date(paymentTimeSource))
              : '—';
            return (
              <div className="rounded-lg p-3 bg-emerald-50 border border-emerald-300 space-y-2">
                <div className="flex items-center gap-2">
                  <svg className="w-5 h-5 text-emerald-700 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                  </svg>
                  <span className="text-sm font-bold text-emerald-900">
                    {result.replayed ? 'Pembayaran terkonfirmasi' : 'Pembayaran Lunas'}
                  </span>
                </div>
                <div className="text-[11px] text-emerald-800 space-y-0.5">
                  <div>No. Transaksi <span className="font-mono">{result.sale.transaction_no}</span></div>
                  <div>Metode {methodLabel}</div>
                  <div>Nominal {formatIDR(Number(result.settlement.amount))}</div>
                  {result.settlement.payment_method === 'CASH' ? (
                    <>
                      {result.settlement.cash_received !== null && (
                        <div>
                          Uang Diterima {formatIDR(Number(result.settlement.cash_received))}
                          {' · '}Kembalian {formatIDR(Number(result.settlement.change_due))}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      {result.settlement.payment_reference && (
                        <div>Referensi {result.settlement.payment_reference}</div>
                      )}
                      {result.settlement.verified_by && (
                        <div>Diverifikasi oleh {result.settlement.verified_by}</div>
                      )}
                    </>
                  )}
                  <div>Waktu Pembayaran {payTime}</div>
                </div>
              </div>
            );
          })()}

          {/* Ambiguous state */}
          {isAmbiguous && failMessage && (
            <div className="rounded-lg p-3 bg-amber-50 border border-amber-300 space-y-2">
              <p className="text-xs font-semibold text-amber-900">{failMessage}</p>
              {alreadyPaid && (
                <p className="text-[11px] text-amber-800">
                  Catatan: order ini sudah memiliki pembayaran sebelumnya.
                </p>
              )}
            </div>
          )}

          {/* Failed state */}
          {phase === 'failed' && failMessage && (
            <div className="rounded-lg p-3 bg-red-50 border border-red-200 space-y-2">
              <p className="text-xs text-red-800">
                {alreadyPaid
                  ? 'Order ini sudah memiliki pembayaran sebelumnya. Daftar pesanan telah diperbarui.'
                  : failMessage}
              </p>
            </div>
          )}
        </div>

        {/* Footer — tombol aksi */}
        <div className="shrink-0 px-4 py-3 bg-stone-50 border-t border-stone-200 flex items-center justify-end gap-2">
          {phase === 'success' && result !== null && contextValid && receiptOrderIdRef.current === order.orderId && (
            <button
              type="button"
              onClick={() => setReceiptOpen(true)}
              className="px-4 py-2 rounded-lg text-xs font-bold text-emerald-800 bg-emerald-100 hover:bg-emerald-200 border border-emerald-300 transition-colors cursor-pointer"
            >
              Cetak Struk
            </button>
          )}
          <button
            type="button"
            onClick={handleRequestClose}
            disabled={isPending || isAmbiguous}
            className="px-4 py-2 rounded-lg text-xs font-bold text-stone-600 hover:bg-stone-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            {phase === 'success' || alreadyPaid ? 'Tutup' : 'Batal'}
          </button>
          {phase !== 'success' && (
            <>
              <button
                type="button"
                onClick={isAmbiguous ? handleRetry : handleConfirm}
                disabled={!canConfirm && !canRetry}
                className="px-4 py-2 rounded-lg text-xs font-bold text-emerald-800 bg-emerald-100 hover:bg-emerald-200 border border-emerald-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                {isAmbiguous ? 'Coba Lagi' : 'Bayar Sekarang'}
              </button>
              {isPending && (
                <button
                  type="button"
                  disabled
                  className="px-4 py-2 rounded-lg text-xs font-bold text-white bg-emerald-700 opacity-70 cursor-not-allowed"
                >
                  Memproses…
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Thermal receipt modal — read-only, fetches authoritative receipt sendiri */}
      <PosThermalReceiptModal
        isOpen={receiptOpen}
        onClose={() => setReceiptOpen(false)}
        orderId={order.orderId}
        propertyId={order.propertyId}
        authFetch={authFetch}
      />
    </div>
  );
}
