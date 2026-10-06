import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from '../auth/AuthContext';
import { safeFetchJson } from '../calendar/calendarApi';
import type { SafeFetchResult } from '../calendar/calendarApi';
import type { PosPayCashOrderContext } from './PosPayCashModal';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PosOrderLineItem {
  id: number;
  menu_item_id: number;
  name: string;
  quantity: number;
  unit_price: number | string;
  line_total: number | string;
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
   */
  onOpenPosModal: (
    propertyId: number,
    reservationId: number,
    context?: { guestName?: string | null; roomNumber?: string | null },
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
}: POSOrderPanelProps) {
  const { authFetch } = useAuth();

  const [orders, setOrders] = useState<PosOrderRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<PosOrderRecord | null>(null);

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

  // Satu effect: reset konteks + fetch. Cleanup menginvalidasi respons
  // in-flight SAAT CONTEXT BERUBAH ATAU UNMOUNT (refresh manual di-handle
  // fetchOrders yang menaikkan version-nya sendiri).
  useEffect(() => {
    // Reset state konteks lama SEBELUM memuat — fetch baru memakai counter yang sama.
    setOrders([]);
    setSelectedOrder(null);
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
              {orders.length > 0
                ? `${orders.length} order tercatat`
                : 'Belum ada order'}
            </span>
          )}
        </div>
        {canEditPos && (
          <button
            type="button"
            onClick={() => onOpenPosModal(propertyId, reservationId, { guestName, roomNumber })}
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
      {!loading && !error && orders.length === 0 && (
        <div className="py-6 text-center text-xs text-stone-400">
          Belum ada pesanan POS untuk reservasi ini.
        </div>
      )}

      {/* Order List */}
      {!loading && !error && orders.length > 0 && (
        <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
          {orders.map((order) => (
            <div
              key={order.id}
              className={`p-3 rounded-lg border text-xs transition-colors cursor-pointer ${
                selectedOrder?.id === order.id
                  ? 'border-emerald-300 bg-emerald-50'
                  : 'border-stone-200 bg-stone-50 hover:bg-stone-100'
              }`}
              onClick={() => setSelectedOrder(order)}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-mono font-semibold text-stone-800">
                  {order.order_number}
                </span>
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                    order.status === 'OPEN'
                      ? 'bg-amber-100 text-amber-800 border border-amber-300'
                      : 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                  }`}
                >
                  {order.status === 'OPEN' ? 'Belum Dibayar' : order.status}
                </span>
              </div>
              <div className="text-stone-500">
                {order.table_number ? `Meja ${order.table_number}` : 'Takeaway'}
                {order.guest_name ? ` · ${order.guest_name}` : ''}
                {order.created_at ? ` · ${formatDate(order.created_at)}` : ''}
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="font-bold text-stone-900">
                  {formatIDR(Number(order.total_amount || 0))}
                </span>
                {/* Bayar CASH hanya untuk order OPEN + izin edit POS.
                    Hilang saat status berubah (PAID/CANCELLED/CLOSED). */}
                {canEditPos && order.status === 'OPEN' && onOpenCashPayment && (
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
                    className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 hover:bg-emerald-200 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    Bayar CASH
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Bukti Pemesanan — snapshot of selected order */}
      {!loading && selectedOrder && (
        <div className="border-t border-stone-100 pt-3">
          <h4 className="text-xs font-bold text-stone-700 mb-2 flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Bukti Pemesanan — {selectedOrder.order_number}
          </h4>

          <div className="bg-stone-50 border border-stone-200 rounded-lg p-3 space-y-1.5">
            {/* Order metadata */}
            <div className="flex items-center justify-between text-[11px] text-stone-500">
              <span>
                {selectedOrder.table_number ? `Meja ${selectedOrder.table_number}` : 'Takeaway'}
                {selectedOrder.guest_name ? ` — ${selectedOrder.guest_name}` : ''}
              </span>
              <span>
                {selectedOrder.status === 'OPEN' ? (
                  <span className="px-1.5 py-0.5 bg-amber-100 text-amber-800 border border-amber-300 rounded-full font-bold text-[10px]">
                    Belum Dibayar
                  </span>
                ) : (
                  <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-800 border border-emerald-300 rounded-full font-bold text-[10px]">
                    {selectedOrder.status}
                  </span>
                )}
              </span>
            </div>

            {/* Items */}
            {Array.isArray(selectedOrder.items) && selectedOrder.items.length > 0 ? (
              <div className="space-y-1">
                {selectedOrder.items.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between text-[11px] py-0.5"
                  >
                    <span className="text-stone-700 truncate pr-2">
                      {item.quantity}× {item.name}
                    </span>
                    <span className="text-stone-900 font-medium whitespace-nowrap">
                      {formatIDR(Number(item.line_total ?? Number(item.unit_price) * item.quantity))}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-stone-400">Detail item tidak tersedia.</p>
            )}

            {/* Total */}
            <div className="border-t border-stone-200 pt-2 mt-2 flex items-center justify-between">
              <span className="text-xs font-bold text-stone-700">Total</span>
              <span className="text-sm font-black text-emerald-800">
                {formatIDR(Number(selectedOrder.total_amount || 0))}
              </span>
            </div>

            {/* Timestamp */}
            {selectedOrder.created_at && (
              <div className="text-[10px] text-stone-400 text-right">
                {formatDate(selectedOrder.created_at)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
