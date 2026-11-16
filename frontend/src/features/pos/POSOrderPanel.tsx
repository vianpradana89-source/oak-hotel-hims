import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useAuth } from '../auth/AuthContext';
import { safeFetchJson } from '../calendar/calendarApi';
import type { SafeFetchResult } from '../calendar/calendarApi';
import type { PosPayCashOrderContext } from './PosPayCashModal';
import PosThermalReceiptModal from '../thermalReceipt/PosThermalReceiptModal';
import { formatPosOrderDisplayRef } from './posFormatUtils';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PosOrderLineItem {
  id: number;
  menu_item_id: number;
  name?: string;
  item_name_snapshot?: string;
  quantity: number;
  unit_price: number | string;
  line_total?: number | string;
}

export interface PosOrderRecord {
  id: number;
  order_number: string;
  status: string;
  total_amount: number | string;
  table_number?: string | null;
  guest_name?: string | null;
  reservation_id?: number | null;
  created_at?: string | null;
  payment_method?: string | null;
  items: PosOrderLineItem[];
}

export interface POSOrderPanelProps {
  /** property_id untuk GET /api/pos/orders */
  propertyId: number;
  /** reservation_id untuk filter order per reservasi */
  reservationId: number;
  /**
   * Callback untuk membuka PosModal dengan property_id + reservation_id terikat.
   * `context` berisi identitas reservasi untuk menginisialisasi field POS
   * (nama tamu, nomor kamar) hanya saat draft baru; tidak menyentuh snapshot.
   * `reservationStatus` ditransfer dari view terkini — App validasi status
   * sebelum membuka modal (status harus BOOKED atau CHECKED_IN).
   */
  onOpenPosModal: (
    propertyId: number,
    reservationId: number,
    context?: {
      guestName?: string | null;
      roomNumber?: string | null;
      reservationStatus?: string | null;
      editOrderId?: number | null;
    },
  ) => void;
  /** true saat user boleh melihat panel POS (di-resolve di parent: atomic key + platform super admin) */
  canViewPos?: boolean;
  /** true saat user boleh menambah order — gate "Tambah Order" DI PANEL */
  canEditPos: boolean;
  /** Nama tamu dari reservasi — identifikasi panel + default "Nama Tamu" */
  guestName?: string | null;
  /**
   * Nomor kamar dari reservasi — teruskan ke PosModal sebagai inisialisasi
   * default "Nomor Kamar" (bukan "Nomor Meja"). Hanya dipakai saat draft baru.
   */
  roomNumber?: string | null;
  /**
   * Status reservasi terkini (BOOKED, CHECKED_IN, CHECKED_OUT, CANCELLED, …).
   * Digunakan untuk mengaktifkan/menonaktifkan tombol "Tambah Order":
   * hanya tersedia saat status === 'BOOKED' atau 'CHECKED_IN' AND pengguna
   * punya izin edit. Status null/undefined/kosong/tidak dikenal = TOLAK
   * (tombol disembunyikan).
   */
  reservationStatus?: string | null;
  /** Bilah kecil identitas reservasi yang sedang dipesan */
  reservationLabel?: string;
  /**
   * Signal refresh scoped dari App: version bump + reservation_id target.
   * Panel refetch HANYA bila refresh scope cocok dengan panel ini.
   */
  posOrdersRefreshVersion?: number;
  posOrdersRefreshReservationId?: number | null;
  /** Buka modal pembayaran CASH untuk order terpilih (forward ke App). */
  onOpenCashPayment?: (ctx: PosPayCashOrderContext) => void;
  /** Callback saat pesanan berhasil ditagihkan ke kamar */
  onOrderBilledToRoom?: (info: { orderId: number; reservationId: number }) => void;
  /** Sisa tagihan folio kamar otoritatif untuk menampilkan status lunas pendamping pada order BILLED_TO_ROOM */
  folioRemainingBalance?: number | null;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function formatIDR(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('id-ID', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Jakarta',
    });
  } catch {
    return '—';
  }
}

/** Validasi shape order dari backend: id, order_number, status, total wajib ada & konsisten. */
export function validatePosOrderRecord(raw: unknown): PosOrderRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = Number(r.id);
  const orderNumber = typeof r.order_number === 'string' ? r.order_number : '';
  const status = typeof r.status === 'string' ? r.status : '';
  const totalAmount = Number(r.total_amount ?? 0);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (!orderNumber) return null;
  if (!status) return null;
  if (!Number.isFinite(totalAmount)) return null;
  return {
    id,
    order_number: orderNumber,
    status,
    total_amount: totalAmount,
    table_number: typeof r.table_number === 'string' ? r.table_number : null,
    guest_name: typeof r.guest_name === 'string' ? r.guest_name : null,
    reservation_id: r.reservation_id == null ? null : Number(r.reservation_id),
    created_at: typeof r.created_at === 'string' ? r.created_at : null,
    items: Array.isArray(r.items) ? (r.items as PosOrderLineItem[]) : [],
  };
}

/**
 * Ekstrak order dari respons POST /api/pos/orders.
 * Handler backend membalas:
 *  - create  → 201 { status:'SUCCESS', data: <pos_order row> }
 *  - replay  → 200 { status:'REPLAY',  data: { ...row, items: [...] } }
 * Order selalu LANGSUNG di json.data — bukan json.data.order.
 * Return null jika respons sukses tetapi shape malformed (tidak pernah
 * membebani sebagai sukses — pemanggil memperlakukannya sebagai ambigu).
 */
export function extractCreatedPosOrder(json: any): PosOrderRecord | null {
  const raw = json && json.data;
  if (!raw) return null;
  const record = validatePosOrderRecord(raw);
  if (!record) return null;
  // Replay menyertakan items di data.items; create hanya baris order.
  if (Array.isArray(raw.items)) {
    record.items = raw.items as PosOrderLineItem[];
  }
  return record;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function POSOrderPanel({
  propertyId,
  reservationId,
  onOpenPosModal,
  canEditPos,
  canViewPos = true,
  guestName,
  roomNumber,
  reservationLabel,
  posOrdersRefreshVersion,
  posOrdersRefreshReservationId,
  onOpenCashPayment,
  reservationStatus,
  onOrderBilledToRoom,
  folioRemainingBalance,
}: POSOrderPanelProps) {
  const [roomChargeOrder, setRoomChargeOrder] = useState<PosOrderRecord | null>(null);
  const [chargeNotes, setChargeNotes] = useState('');
  const [submittingCharge, setSubmittingCharge] = useState(false);
  const [chargeError, setChargeError] = useState<string | null>(null);
  const { authFetch } = useAuth();

  const [orders, setOrders] = useState<PosOrderRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  // Simpan ID order yang dipilih, bukan snapshot objek.
  // selectedOrder diturunkan langsung dari array orders terbaru, sehingga
  // badge status (OPEN/PAID/DISCOUNTED/VOIDED) di kartu detail selalu
  // mencerminkan data terkini setelah refetch pasca-pembayaran.
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [copiedOrderId, setCopiedOrderId] = useState<number | null>(null);
  const [deletingOrderId, setDeletingOrderId] = useState<number | null>(null);
  const [selectedReceiptOrder, setSelectedReceiptOrder] = useState<{
    orderId: number;
    propertyId: number;
    orderNumber: string;
  } | null>(null);

  const activeOrders = useMemo(
    () => orders.filter((o) => String(o.status || '').toUpperCase() !== 'VOIDED'),
    [orders]
  );

  const totalAllOrdersAmount = useMemo(
    () => activeOrders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0),
    [activeOrders]
  );

  // ── Gate "Tambah Order": status reservasi aktif + izin edit POS ─────────
  // Hanya reservasi yang masih aktif (BOOKED / CHECKED_IN) yang boleh
  // menambah order baru. CHECKED_OUT, CANCELLED, status null/undefined/
  // kosong/tidak dikenal — tombol disembunyikan.
  const canAddOrder = canEditPos && (
    reservationStatus === 'BOOKED' ||
    reservationStatus === 'CHECKED_IN'
  );

  // ─── Fetch: satu effect gabungan reset konteks + load ─────────────────────
  // Setiap fetch — initial load, pergantian konteks (propertyId/reservationId),
  // ATAU refresh manual ("Coba Lagi") — menaikkan request version, sehingga
  // respons fetch lama tidak bisa menimpa respons yang lebih baru.
  // Cleanup effect (context berubah / unmount) juga menaikkan version untuk
  // menginvalidasi respons in-flight dari konteks lama.
  const requestVersionRef = useRef(0);

  const fetchOrders = useCallback(async () => {
    // Fetch baru → version baru; respons in-flight versi sebelumnya diabaikan.
    requestVersionRef.current += 1;
    const version = requestVersionRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        property_id: String(propertyId),
        reservation_id: String(reservationId),
      });
      const url = `/api/pos/orders?${params.toString()}`;
      const result: SafeFetchResult<{ status: string; data: PosOrderRecord[] }> =
        await safeFetchJson(url, { expectJson: true }, 'Gagal memuat daftar pesanan POS.', authFetch);

      // Stale guard: fetch versi baru sudah berjalan / unmount → abaikan respons.
      if (version !== requestVersionRef.current) return;

      if (!result.ok) {
        const msg =
          result.status === 403
            ? 'Anda tidak memiliki akses POS untuk reservasi ini.'
            : result.errorMessage || 'Gagal memuat daftar pesanan.';
        setError(msg);
        setOrders([]);
      } else {
        const data = result.data?.data;
        if (Array.isArray(data)) {
          setOrders(data);
        } else {
          setError('Respon server tidak valid. Coba lagi.');
          setOrders([]);
        }
      }
    } catch {
      if (version !== requestVersionRef.current) return;
      setError('Gagal terhubung ke server. Periksa koneksi jaringan.');
      setOrders([]);
    } finally {
      // Set loading=false hanya bila masih konteks aktif.
      if (version === requestVersionRef.current) {
        setLoading(false);
      }
    }
  }, [propertyId, reservationId, authFetch]);

const handleConfirmRoomCharge = useCallback(async () => {
    if (!roomChargeOrder) return;
    setSubmittingCharge(true);
    setChargeError(null);
    try {
      const res = await authFetch(`/api/pos/orders/${roomChargeOrder.id}/room-charge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          reservation_id: reservationId,
          notes: chargeNotes.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && (res.status === 200 || res.status === 201)) {
        const billedOrderId = roomChargeOrder.id;
        setRoomChargeOrder(null);
        setChargeNotes('');
        await fetchOrders();
        if (onOrderBilledToRoom) {
          onOrderBilledToRoom({ orderId: billedOrderId, reservationId });
        }
      } else {
        setChargeError(data.message || 'Gagal menagihkan pesanan ke kamar.');
      }
    } catch (err: any) {
      setChargeError(err.message || 'Terjadi kesalahan jaringan.');
    } finally {
      setSubmittingCharge(false);
    }
  }, [roomChargeOrder, chargeNotes, propertyId, reservationId, authFetch, fetchOrders, onOrderBilledToRoom]);

  // Satu effect: reset konteks + fetch. Cleanup menginvalidasi respons
  // in-flight SAAT CONTEXT BERUBAH ATAU UNMOUNT (refresh manual di-handle
  // fetchOrders yang menaikkan version-nya sendiri).
  useEffect(() => {
    // Reset state konteks lama SEBELUM memuat — fetch baru memakai counter yang sama.
    setOrders([]);
    setSelectedOrderId(null);
    setError(null);
    setLoading(true);
    void fetchOrders();

    return () => {
      requestVersionRef.current += 1; // invalidasi respons in-flight konteks ini
    };
  }, [fetchOrders]);

  // Scoped refresh dari App: panel refetch HANYA bila refresh version berubah
  // DAN refresh scope (reservation_id) cocok dengan panel ini. Panel untuk
  // reservasi lain tidak terpengaruh.
  const lastRefreshVersionRef = useRef(posOrdersRefreshVersion ?? 0);
  useEffect(() => {
    if (posOrdersRefreshVersion === undefined) return;
    if (posOrdersRefreshVersion === lastRefreshVersionRef.current) return;
    // Hanya refetch bila scope cocok: refresh diarahkan ke reservation_id ini
    // (atau null = semua, yang juga berarti scope ini).
    if (
      posOrdersRefreshReservationId !== undefined &&
      posOrdersRefreshReservationId !== null &&
      posOrdersRefreshReservationId !== reservationId
    ) {
      lastRefreshVersionRef.current = posOrdersRefreshVersion;
      return;
    }
    lastRefreshVersionRef.current = posOrdersRefreshVersion;
    void fetchOrders();
  }, [posOrdersRefreshVersion, posOrdersRefreshReservationId, reservationId, fetchOrders]);

  const handleCopyOrderRef = useCallback((orderId: number, textToCopy: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(textToCopy);
    }
    setCopiedOrderId(orderId);
    if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
      window.setTimeout(() => {
        setCopiedOrderId((prev) => (prev === orderId ? null : prev));
      }, 1500);
    }
  }, []);

  const handleDeleteOrder = useCallback(async (order: PosOrderRecord) => {
    if (!canEditPos || deletingOrderId !== null) return;
    const displayRef = formatPosOrderDisplayRef(order.id) || order.order_number;
    const statusUpper = String(order.status || 'OPEN').toUpperCase();
    const confirmMsg =
      statusUpper === 'PAID' || statusUpper === 'BILLED_TO_ROOM'
        ? `Hapus order ${displayRef} (${statusUpper})?\nData penjualan/tagihan kamar terkait akan dibatalkan dan stok produk otomatis dikembalikan ke gudang.`
        : `Hapus order ${displayRef} (${statusUpper})?\nOrder ini akan dihapus dari daftar pesanan reservasi.`;
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      if (!window.confirm(confirmMsg)) return;
    }
    setDeletingOrderId(order.id);
    try {
      const res = await authFetch(`/api/pos/orders/${order.id}?property_id=${propertyId}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (selectedOrderId === order.id) setSelectedOrderId(null);
        await fetchOrders();
        if (onOrderBilledToRoom) {
          onOrderBilledToRoom({ orderId: order.id, reservationId });
        }
      } else {
        window.alert(data?.message || `Gagal menghapus order ${displayRef}.`);
      }
    } catch (err: any) {
      window.alert(err?.message || `Gagal menghapus order ${displayRef}.`);
    } finally {
      setDeletingOrderId(null);
    }
  }, [canEditPos, deletingOrderId, authFetch, propertyId, selectedOrderId, fetchOrders, onOrderBilledToRoom, reservationId]);

  // ─── Render ─────────────────────────────────────────────────────────────────
  // Panel hanya render bila parent mengizinkan (canViewPos di-resolve di
  // detail view: atomic 'pos.view' ATAU platform super admin effective).
  if (!canViewPos) return null;

  const reservationIdentity =
    reservationLabel ||
    (guestName
      ? `Reservasi ${reservationId} — ${guestName}`
      : `Reservasi #${reservationId}`);

  return (
    <div className="p-4 bg-white rounded-xl border border-stone-200 shadow-xs space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-stone-100 pb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-bold uppercase tracking-wider text-stone-500 whitespace-nowrap">
              POS — Pesanan
            </span>
            <span className="text-[11px] text-stone-400 truncate" title={reservationIdentity}>
              {reservationIdentity}
            </span>
          </div>
          {canEditPos && (
            <span className="ml-2 block text-[11px] text-stone-400">
              {activeOrders.length > 0
                ? `${activeOrders.length} order tercatat`
                : 'Belum ada order'}
            </span>
          )}
        </div>
        {canAddOrder && (
          <button
            type="button"
            onClick={() => onOpenPosModal(propertyId, reservationId, { guestName, roomNumber, reservationStatus })}
            className="px-2.5 py-1 bg-emerald-800 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors cursor-pointer"
          >
            + Tambah Order
          </button>
        )}
      </div>

      {/* Loading */}
      {loading && (
        <div className="py-6 text-center text-xs text-stone-400">
          Memuat daftar pesanan…
        </div>
      )}

      {/* Error + retry */}
      {!loading && error && (
        <div className="py-4">
          <p className="text-xs text-red-600 mb-2">{error}</p>
          <button
            type="button"
            onClick={() => void fetchOrders()}
            className="px-3 py-1 bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-lg text-xs font-medium transition-colors cursor-pointer"
          >
            Coba Lagi
          </button>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && activeOrders.length === 0 && (
        <div className="py-6 text-center text-xs text-stone-400">
          Belum ada pesanan POS untuk reservasi ini.
        </div>
      )}

      {/* Unified Order Cards (Gambar 5 style) */}
      {!loading && !error && activeOrders.length > 0 && (
        <div className="space-y-2.5 max-h-96 overflow-y-auto pr-1">
          {activeOrders.map((order) => {
            const displayRef = formatPosOrderDisplayRef(order.id) || order.order_number;
            const statusUpper = String(order.status || 'OPEN').toUpperCase();
            const isDeletingThis = deletingOrderId === order.id;
            const isBuktiExpanded = selectedOrderId === order.id;
            const itemsSummary =
              Array.isArray(order.items) && order.items.length > 0
                ? order.items
                    .map((it) => `${it.name || it.item_name_snapshot || 'Menu'} x${it.quantity}`)
                    .join(', ')
                : 'Detail item tidak tersedia';
            const methodLabel =
              statusUpper === 'PAID'
                ? (order.payment_method
                    ? String(order.payment_method).charAt(0).toUpperCase() + String(order.payment_method).slice(1).toLowerCase()
                    : 'Cash')
                : statusUpper === 'BILLED_TO_ROOM'
                  ? 'Tagihan Kamar'
                  : 'Belum Dibayar';

            return (
              <div
                key={order.id}
                className="p-3 rounded-xl border border-stone-200 bg-white shadow-2xs text-xs space-y-2 transition-colors hover:border-stone-300"
              >
                {/* Baris 1: Nomor Order + Copy Icon | Badge Status */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-mono font-bold text-blue-700 text-xs sm:text-[13px] truncate" title={order.order_number}>
                      {displayRef}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCopyOrderRef(order.id, displayRef);
                      }}
                      title={copiedOrderId === order.id ? 'Tersalin!' : `Salin ${displayRef}`}
                      aria-label={`Salin nomor order ${displayRef}`}
                      className="inline-flex items-center justify-center w-5 h-5 rounded text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer shrink-0"
                    >
                      {copiedOrderId === order.id ? (
                        <svg className="w-3.5 h-3.5 text-emerald-600" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                          <rect x="9" y="9" width="11" height="11" rx="2" ry="2" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                        </svg>
                      )}
                    </button>
                  </div>

                  <span
                    className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide shrink-0 ${
                      statusUpper === 'OPEN'
                        ? 'bg-rose-50 text-rose-700 border border-rose-200'
                        : statusUpper === 'BILLED_TO_ROOM'
                        ? 'bg-sky-50 text-sky-800 border border-sky-200'
                        : 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                    }`}
                  >
                    {statusUpper === 'OPEN'
                      ? 'BELUM LUNAS'
                      : statusUpper === 'BILLED_TO_ROOM'
                      ? 'TAGIH KAMAR'
                      : 'LUNAS'}
                  </span>
                </div>

                {/* Baris 2: Tanggal & Informasi Meja / Tamu */}
                <div className="text-[11px] text-stone-500">
                  {order.created_at ? formatDate(order.created_at) : '—'}
                  {' · '}
                  {order.table_number ? `Meja ${order.table_number}` : 'Takeaway'}
                  {order.guest_name ? ` · ${order.guest_name}` : ''}
                </div>

                {/* Baris 3: Ringkasan Item dalam 1 Blok (Gambar 5) */}
                <div className="text-xs text-stone-700 leading-relaxed font-medium">
                  {itemsSummary}
                </div>

                {/* Rincian per-baris bila tombol Bukti diklik pada order non-PAID */}
                {isBuktiExpanded && Array.isArray(order.items) && order.items.length > 0 && (
                  <div className="bg-stone-50 border border-stone-200 rounded-lg p-2 space-y-1">
                    {order.items.map((item) => (
                      <div key={item.id} className="flex items-center justify-between text-[11px]">
                        <span className="text-stone-700 truncate pr-2">
                          {item.quantity}× {item.name || item.item_name_snapshot || 'Menu'}
                        </span>
                        <span className="text-stone-900 font-semibold whitespace-nowrap">
                          {formatIDR(Number(item.line_total ?? Number(item.unit_price) * item.quantity))}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Baris 4: Metode / Status Folio di Kiri & Total Nominal di Kanan */}
                <div className="flex items-center justify-between pt-0.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs text-stone-500 font-medium">{methodLabel}</span>
                    {statusUpper === 'BILLED_TO_ROOM' && folioRemainingBalance != null && (
                      <span
                        className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                          folioRemainingBalance <= 0
                            ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                            : 'bg-amber-100 text-amber-800 border border-amber-300'
                        }`}
                      >
                        {folioRemainingBalance <= 0 ? '✓ Lunas di Folio Kamar' : 'Mengikuti Tagihan Kamar'}
                      </span>
                    )}
                  </div>
                  <span className="text-sm font-black text-stone-900 tabular-nums">
                    {formatIDR(Number(order.total_amount || 0))}
                  </span>
                </div>

                {/* Baris Aksi Cepat untuk Order OPEN (Tagihkan ke Kamar & Bayar) */}
                {canEditPos && statusUpper === 'OPEN' && (
                  <div className="flex items-center justify-end gap-1.5 pt-0.5">
                    {(reservationStatus === 'BOOKED' || reservationStatus === 'CHECKED_IN') && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRoomChargeOrder(order);
                          setChargeNotes('');
                          setChargeError(null);
                        }}
                        className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-blue-50 text-blue-800 border border-blue-200 hover:bg-blue-100 transition-colors cursor-pointer"
                      >
                        Tagihkan ke Kamar
                      </button>
                    )}
                    {onOpenCashPayment && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenCashPayment({
                            orderId: order.id,
                            propertyId,
                            orderNumber: order.order_number,
                            totalAmount: order.total_amount,
                            guestName: order.guest_name ?? guestName ?? null,
                            roomNumber: roomNumber ?? null,
                            reservationId: order.reservation_id ?? reservationId,
                          });
                        }}
                        className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-emerald-600 text-white hover:bg-emerald-700 transition-colors cursor-pointer"
                      >
                        Bayar
                      </button>
                    )}
                  </div>
                )}

                {/* Baris 5: Tombol Aksi Terpadu — Bukti | Ubah | Hapus (Gambar 5) */}
                <div className="grid grid-cols-3 gap-1.5 pt-1.5 border-t border-stone-100">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (
                        statusUpper === 'PAID' &&
                        Number.isInteger(order.id) &&
                        order.id > 0 &&
                        Number.isInteger(propertyId) &&
                        propertyId > 0
                      ) {
                        setSelectedReceiptOrder({
                          orderId: order.id,
                          propertyId,
                          orderNumber: order.order_number,
                        });
                      } else {
                        setSelectedOrderId((prev) => (prev === order.id ? null : order.id));
                      }
                    }}
                    className="inline-flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-[11px] font-semibold text-stone-600 hover:text-stone-900 hover:bg-stone-100 transition-colors cursor-pointer"
                  >
                    <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                    <span>Bukti</span>
                  </button>

                  {canEditPos ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenPosModal(propertyId, reservationId, {
                          guestName,
                          roomNumber,
                          reservationStatus,
                          editOrderId: order.id,
                        });
                      }}
                      disabled={isDeletingThis}
                      className="inline-flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-[11px] font-semibold bg-emerald-50 text-emerald-800 hover:bg-emerald-100 border border-emerald-200/70 transition-colors disabled:opacity-40 cursor-pointer"
                    >
                      <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                      <span>Ubah</span>
                    </button>
                  ) : (
                    <div />
                  )}

                  {canEditPos ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDeleteOrder(order);
                      }}
                      disabled={isDeletingThis || deletingOrderId !== null}
                      className="inline-flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-[11px] font-semibold text-red-600 hover:text-red-700 hover:bg-red-50 transition-colors disabled:opacity-40 cursor-pointer"
                    >
                      <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                      <span>{isDeletingThis ? 'Menghapus…' : 'Hapus'}</span>
                    </button>
                  ) : (
                    <div />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Footer Total Semua Order (Gambar 5) */}
      {!loading && !error && activeOrders.length > 0 && (
        <div className="border-t border-stone-200 pt-2.5 flex items-center justify-between text-xs">
          <span className="font-bold text-stone-700">Total Semua Order</span>
          <span className="font-black text-sm text-stone-900 tabular-nums">
            {formatIDR(totalAllOrdersAmount)}
          </span>
        </div>
      )}

      {/* Modal Tagihkan ke Kamar */}
      {roomChargeOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-stone-200 pb-2">
              <h3 className="text-sm font-bold text-stone-900">
                Tagihkan Pesanan ke Kamar
              </h3>
              <button
                type="button"
                onClick={() => {
                  if (!submittingCharge) {
                    setRoomChargeOrder(null);
                    setChargeError(null);
                  }
                }}
                disabled={submittingCharge}
                className="text-stone-400 hover:text-stone-600 text-lg leading-none cursor-pointer"
              >
                &times;
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="bg-stone-50 p-3 rounded-lg border border-stone-200 space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-stone-500">Nomor Order:</span>
                  <span className="font-mono font-semibold text-stone-800" title={roomChargeOrder.order_number}>{formatPosOrderDisplayRef(roomChargeOrder.id) || roomChargeOrder.order_number}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-stone-500">Total Pesanan:</span>
                  <span className="font-bold text-emerald-800">{formatIDR(Number(roomChargeOrder.total_amount || 0))}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-stone-500">Kamar:</span>
                  <span className="font-semibold text-stone-800">{roomNumber ? `Kamar ${roomNumber}` : '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-stone-500">Tamu:</span>
                  <span className="font-semibold text-stone-800">{roomChargeOrder.guest_name || guestName || '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-stone-500">Reservasi:</span>
                  <span className="font-semibold text-stone-800">#{reservationId}</span>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-stone-600 mb-1">
                  Catatan (Opsional)
                </label>
                <input
                  type="text"
                  value={chargeNotes}
                  onChange={(e) => setChargeNotes(e.target.value)}
                  placeholder="Catatan room charge..."
                  disabled={submittingCharge}
                  className="w-full px-2.5 py-1.5 border border-stone-300 rounded-lg text-xs focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              <p className="text-[11px] text-stone-500 italic">
                Pesanan akan ditagihkan sebagai debit F&amp;B ke folio reservasi ini. Setelah ditagihkan, pesanan tidak dapat dibayar terpisah melalui kasir POS.
              </p>

              {chargeError && (
                <div className="p-2 bg-red-50 border border-red-200 rounded text-red-700 text-[11px]">
                  {chargeError}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-stone-200">
              <button
                type="button"
                disabled={submittingCharge}
                onClick={() => {
                  setRoomChargeOrder(null);
                  setChargeError(null);
                }}
                className="px-3 py-1.5 rounded-lg border border-stone-300 text-stone-700 text-xs font-semibold hover:bg-stone-50 transition-colors cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={submittingCharge}
                onClick={handleConfirmRoomCharge}
                className="px-3 py-1.5 rounded-lg bg-blue-800 hover:bg-blue-700 text-white text-xs font-semibold transition-colors disabled:opacity-50 cursor-pointer"
              >
                {submittingCharge ? 'Memproses…' : 'Konfirmasi Tagihkan ke Kamar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Cetak Ulang — receipt di-fetch sendiri oleh PosThermalReceiptModal */}
      {selectedReceiptOrder !== null && (
        <PosThermalReceiptModal
          isOpen={selectedReceiptOrder !== null}
          onClose={() => setSelectedReceiptOrder(null)}
          orderId={selectedReceiptOrder.orderId}
          propertyId={selectedReceiptOrder.propertyId}
          authFetch={authFetch}
        />
      )}
    </div>
  );
}
