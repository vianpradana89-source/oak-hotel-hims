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

/**
 * Shape respons `data.settlement` dari POST /api/pos/orders/:id/pay
 * (kontrak backend: posSettlementService.PayPosOrderCashResult.settlement).
 * BIGINT (transaction_id) tetap string; jangan konversi ke Number.
 */
export interface SettlementRecord {
  /** INTEGER (4-byte) → number di pg (bukan BIGINT). */
  id: number;
  /** INTEGER → number. */
  property_id: number;
  /** INTEGER → number. */
  pos_order_id: number;
  /** BIGINT → string. Tidak dikonversi ke Number. */
  transaction_id: string;
  /** Decimal → string dari pg. Valid: bentuk decimal numerik, finite, positif. */
  amount: string;
  /** Selalu 'CASH' di tahap ini. */
  payment_method: string;
  /** Selalu 'SUCCESS' bila settlement valid. */
  status: string;
  idempotency_key: string;
  request_fingerprint: string;
  /** Aktor pencatat (operator POS), bukan "dibayar oleh". */
  created_by: string | null;
}

/** Shape `data.sale` dari respons yang sama (baris transactions). */
export interface SaleRecord {
  /** BIGINT → string. Valid: digit positif, tolak "000". */
  id: string;
  transaction_no: string;
  /** Selalu 'PAID' untuk SALE POS_ORDER. */
  payment_status: string;
  /** Selalu 'CASH' di tahap ini. */
  payment_method: string;
  /** Selalu 'POS_ORDER'. */
  source_type: string;
  /** String(orderId) — BIGINT sebagai string. Wajib non-null (source_id dari sale POS_ORDER selalu diisi). */
  source_id: string;
}

/**
 * Snapshot immutable — dibuat SEBELUM request pertama.
 * Retry wajib memakai key, path, dan bodyJson yang sama persis.
 * TIDAK diubah setelah dibuat; state unresolved dipisahkan ke ref tersendiri.
 */
interface PaySnapshot {
  readonly orderId: number;
  readonly propertyId: number;
  /** UUID baru untuk pembayaran ini — terpisah dari key create-order. */
  readonly key: string;
  /** JSON.stringify({property_id, payment_method:'CASH'}). */
  readonly bodyJson: string;
}

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
    Number.isFinite(Number(ctx.totalAmount)) && Number(ctx.totalAmount) >= 0 &&
    typeof ctx.orderNumber === 'string' && ctx.orderNumber.trim() !== ''
  );
}

// ─── Validator Respons ───────────────────────────────────────────────────────

/**
 * Struktur respons POST /api/pos/orders/:id/pay (hanya field yang benar-benar
 * dikembalikan endpoint — jangan menambah field yang tidak ada).
 */
interface PayResponseShape {
  status?: string;
  data?: {
    settlement?: SettlementRecord;
    sale?: SaleRecord;
    created?: boolean;
    replayed?: boolean;
  };
}

/**
 * Validasi respons 200/201 sesuai kontrak aktual.
 *
 * @param httpStatus  200 (REPLAY) atau 201 (SUCCESS/created)
 * @param json        Parsed JSON dari body respons (bisa null/undefined)
 * @param snap        Snapshot immutable — orderId & propertyId dari sini
 *
 * @returns `true` bila seluruh invariant terpenuhi; `false` bila ada
 *          field yang tidak valid atau tidak konsisten.
 *
 * Aturan ketat (sesuai kontrak source):
 *  - amount: typeof === 'string', bentuk decimal valid, finite, positif
 *  - transaction_id & sale.id: typeof === 'string', digit positif
 *  - digit positif: tolak semua bentuk zero seperti "000", "0", "0.0"
 *  - JANGAN konversi BIGINT ke Number; JANGAN terima number lewat String()
 *  - 201 → json.status === 'SUCCESS'; 200 → json.status === 'REPLAY'
 *  - property_id & pos_order_id: number integer positif sesuai snapshot
 */

/** Cek bentuk decimal string: /^[+-]?\d+(\.\d+)?$/ — finite, bukan NaN. */
function isValidDecimalString(v: unknown): v is string {
  return typeof v === 'string' && /^[+-]?\d+(\.\d+)?$/.test(v);
}

/** Cek digit positif: tidak kosong, semua char digit, nilai > 0 (tolak "000", "0"). */
function isPositiveDigitString(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0) return false;
  if (!/^\d+$/.test(v)) return false;
  // Hapus leading zeros untuk cek nilai; "000" → "0" → tolak
  const trimmed = v.replace(/^0+/, '') || '0';
  return trimmed !== '0';
}

export function validatePayResponse(
  httpStatus: number,
  json: PayResponseShape | null,
  snap: Pick<PaySnapshot, 'orderId' | 'propertyId'>,
): boolean {
  if (!json || typeof json !== 'object') return false;
  const data = json.data;
  if (!data || typeof data !== 'object') return false;

  const s = data.settlement;
  const sale = data.sale;
  if (!s || typeof s !== 'object') return false;
  if (!sale || typeof sale !== 'object') return false;

  // ── settlement ────────────────────────────────────────────────────────────
  // id: INTEGER positif (pg 4-byte → number)
  if (typeof s.id !== 'number' || !Number.isInteger(s.id) || s.id <= 0) return false;
  // property_id: INTEGER positif, cocok snapshot
  if (typeof s.property_id !== 'number' || !Number.isInteger(s.property_id)
      || s.property_id <= 0 || s.property_id !== snap.propertyId) return false;
  // pos_order_id: INTEGER positif, cocok snapshot
  if (typeof s.pos_order_id !== 'number' || !Number.isInteger(s.pos_order_id)
      || s.pos_order_id <= 0 || s.pos_order_id !== snap.orderId) return false;
  // amount: string decimal valid, finite, positif
  if (!isValidDecimalString(s.amount)) return false;
  const amt = Number(s.amount);
  if (!Number.isFinite(amt) || amt <= 0) return false;
  // payment_method & status
  if (typeof s.payment_method !== 'string' || s.payment_method !== 'CASH') return false;
  if (typeof s.status !== 'string' || s.status !== 'SUCCESS') return false;
  // transaction_id: BIGINT → string, digit positif (tolak "000")
  if (!isPositiveDigitString(s.transaction_id)) return false;
  const txId = s.transaction_id;

  // ── sale ──────────────────────────────────────────────────────────────────
  // sale.id: BIGINT → string, digit positif, HARMONIS dengan settlement.transaction_id
  if (!isPositiveDigitString(sale.id)) return false;
  if (sale.id !== txId) return false;
  // source_type & source_id
  if (typeof sale.source_type !== 'string' || sale.source_type !== 'POS_ORDER') return false;
  // source_id: WAJIB string (bukan null/undefined), equals String(snap.orderId).
  // Jangan konversi lewat Number — bandingkan sebagai string langsung.
  if (typeof sale.source_id !== 'string' || sale.source_id !== String(snap.orderId)) return false;
  // payment_status & payment_method
  if (typeof sale.payment_status !== 'string' || sale.payment_status !== 'PAID') return false;
  if (typeof sale.payment_method !== 'string' || sale.payment_method !== 'CASH') return false;
  // transaction_no: string tidak kosong
  if (typeof sale.transaction_no !== 'string' || sale.transaction_no.trim() === '') return false;

  // ── status top-level vs HTTP status ───────────────────────────────────────
  if (httpStatus === 201) {
    // SUCCESS: status top-level 'SUCCESS', created=true, replayed=false
    if (typeof json.status !== 'string' || json.status !== 'SUCCESS') return false;
    if (data.created !== true) return false;
    if (data.replayed !== false) return false;
  } else if (httpStatus === 200) {
    // REPLAY: status top-level 'REPLAY', created=false, replayed=true
    if (typeof json.status !== 'string' || json.status !== 'REPLAY') return false;
    if (data.created !== false) return false;
    if (data.replayed !== true) return false;
  } else {
    return false; // HTTP status lain tidak valid untuk success path
  }

  // created dan replayed tidak boleh keduanya true
  if (data.created === true && data.replayed === true) return false;

  return true;
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
      bodyJson = JSON.stringify({ property_id: propertyId, payment_method: 'CASH' });
      // Snapshot DIAMANKAN sebelum request pertama (immutable).
      snapshotRef.current = {
        orderId,
        propertyId,
        key,
        bodyJson,
      };
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
  const canConfirm = canEditPos && contextValid && !isPending && !isAmbiguous && phase === 'confirming';
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
        aria-label="Pembayaran CASH"
        className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden focus:outline-none"
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-4 py-3 bg-stone-50 border-b border-stone-200">
          <div className="flex items-center gap-2 min-w-0">
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider bg-emerald-100 text-emerald-800 border border-emerald-200 uppercase">
              Pembayaran CASH
            </span>
            <h3 className="text-sm font-black text-stone-900 truncate">
              {order.orderNumber}
            </h3>
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
          <div className="space-y-1.5 text-xs">
            {/* Nomor order */}
            <div className="flex items-center justify-between">
              <span className="text-stone-500">Nomor Order</span>
              <span className="font-mono font-semibold text-stone-900">
                {order.orderNumber}
              </span>
            </div>

            {/* Tamu / Kamar (bila ada) */}
            {(order.guestName || order.roomNumber) && (
              <div className="flex items-center justify-between">
                <span className="text-stone-500">Tamu / Kamar</span>
                <span className="font-medium text-stone-900">
                  {order.guestName || '—'}
                  {order.roomNumber ? ` · Kamar ${order.roomNumber}` : ''}
                </span>
              </div>
            )}

            {/* Metode */}
            <div className="flex items-center justify-between">
              <span className="text-stone-500">Metode</span>
              <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                CASH
              </span>
            </div>

            {/* Nominal — readonly */}
            <div className="flex items-center justify-between border-t border-stone-100 pt-2">
              <span className="text-stone-500 font-medium">Nominal</span>
              <span className="text-sm font-black text-stone-900">
                {formatIDR(totalValue)}
              </span>
            </div>
          </div>

          {/* Success state */}
          {phase === 'success' && result && (
            <div className="rounded-lg p-3 bg-emerald-50 border border-emerald-300 space-y-2">
              <div className="flex items-center gap-2">
                <svg className="w-5 h-5 text-emerald-700 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-sm font-bold text-emerald-900">
                  {result.replayed ? 'Pembayaran terkonfirmasi (replay)' : 'Pembayaran Lunas'}
                </span>
              </div>
              {/* Bukti Pembayaran dari settlement respons */}
              <div>
                <h4 className="text-xs font-bold text-emerald-900 mb-1.5">Bukti Pembayaran</h4>
                <div className="text-[11px] text-emerald-800 space-y-0.5">
                  <div>
                    Settlement <span className="font-mono font-semibold">#{result.settlement.id}</span>
                    {' · '}
                    SALE <span className="font-mono font-semibold">#{result.sale.id}</span>
                  </div>
                  <div>
                    No. Transaksi <span className="font-mono">{result.sale.transaction_no}</span>
                  </div>
                  <div>
                    Nominal {formatIDR(Number(result.settlement.amount))}
                    {' · '}
                    {result.settlement.payment_method}
                  </div>
                  {result.settlement.created_by && (
                    <div>Dicatat oleh: {result.settlement.created_by}</div>
                  )}
                </div>
              </div>
            </div>
          )}

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
          <button
            type="button"
            onClick={handleRequestClose}
            disabled={isPending || isAmbiguous}
            className="px-4 py-2 rounded-lg text-xs font-bold text-stone-600 hover:bg-stone-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            {phase === 'success' || alreadyPaid ? 'Tutup' : 'Batal'}
          </button>
          {/*
            Tahap 2B: Konfirmasi aktif hanya bila gate terpenuhi & phase confirming.
            Retry ("Coba Lagi") aktif saat ambiguous.
          */}
          <button
            type="button"
            onClick={isAmbiguous ? handleRetry : handleConfirm}
            disabled={!canConfirm && !canRetry}
            className="px-4 py-2 rounded-lg text-xs font-bold text-emerald-800 bg-emerald-100 hover:bg-emerald-200 border border-emerald-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            {isAmbiguous ? 'Coba Lagi' : 'Konfirmasi Pembayaran'}
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
        </div>
      </div>
    </div>
  );
}
