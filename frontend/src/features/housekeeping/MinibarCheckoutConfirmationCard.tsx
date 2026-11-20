import React, { useState, useEffect } from 'react';
import { CupSoda, CheckCircle2 } from 'lucide-react';
import { authenticatedFetch as authFetch } from '../../lib/authenticatedFetch';

export interface MinibarItemEntry {
  menu_item_id: number;
  name: string;
  sku?: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
  base_unit_code?: string;
}

interface CatalogProduct {
  menu_item_id: number;
  name: string;
  sku: string;
  unit_price: number;
  base_unit_code: string;
  hkp_stock_balance: number;
  standard_qty: number;
  item_role: 'PAID_MINIBAR' | 'COMPLIMENTARY' | null;
}

interface ReservationContextInfo {
  reservation_id: number;
  guest_name: string;
  status: string;
  total_price: number;
  amount_paid: number;
  applied_deposit: number;
  remaining_balance: number;
  available_deposit_balance: number;
  open_deposits: Array<{
    id: number;
    deposit_number: string;
    purpose: string | null;
    remaining: number;
    status: string;
  }>;
}

interface MinibarCheckoutConfirmationCardProps {
  propertyId: number;
  taskId: number;
  roomId?: number | null;
  roomNumber?: string | null;
  reservationId?: number | null;
  initialItems?: MinibarItemEntry[] | null;
  initialBillingStatus?: string | null;
  initialBillingMeta?: any | null;
  billingStatus?: string | null;
  billingMeta?: any | null;
  estimatedCharge?: number | null;
  issueNote?: string | null;
  actorName?: string;
  onConfirmed?: (result?: any) => void;
}

export const MinibarCheckoutConfirmationCard: React.FC<MinibarCheckoutConfirmationCardProps> = ({
  propertyId,
  taskId,
  roomId,
  roomNumber,
  reservationId,
  initialItems,
  initialBillingStatus,
  initialBillingMeta,
  billingStatus: propBillingStatus,
  billingMeta: propBillingMeta,
  estimatedCharge,
  actorName = 'Front Office',
  onConfirmed,
}) => {
  const effectiveInitialBillingStatus = initialBillingStatus ?? propBillingStatus ?? null;
  const effectiveInitialBillingMeta = initialBillingMeta ?? propBillingMeta ?? null;
  const [items, setItems] = useState<MinibarItemEntry[]>(
    Array.isArray(initialItems) ? initialItems : []
  );
  const [billingStatus, setBillingStatus] = useState<string>(effectiveInitialBillingStatus || 'NONE');
  const [billingMeta, setBillingMeta] = useState<any>(effectiveInitialBillingMeta || null);
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [resContext, setResContext] = useState<ReservationContextInfo | null>(null);
  const [selectedAddProductId, setSelectedAddProductId] = useState<string>('');
  const [settlementMode, setSettlementMode] = useState<'FOLIO' | 'DEPOSIT' | 'DIRECT_PAY'>('FOLIO');
  const [paymentMethod, setPaymentMethod] = useState<string>('CASH');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    if (Array.isArray(initialItems) && initialItems.length > 0) {
      setItems(initialItems);
    }
    if (effectiveInitialBillingStatus) {
      setBillingStatus(effectiveInitialBillingStatus);
    }
    if (effectiveInitialBillingMeta) {
      setBillingMeta(effectiveInitialBillingMeta);
    }
  }, [initialItems, effectiveInitialBillingStatus, effectiveInitialBillingMeta]);

  useEffect(() => {
    if (!propertyId || !taskId) return;
    let cancelled = false;
    const loadCtx = async () => {
      try {
        const params = new URLSearchParams({
          property_id: String(propertyId),
          task_id: String(taskId),
        });
        if (roomId) params.set('room_id', String(roomId));
        if (reservationId) params.set('reservation_id', String(reservationId));
        const res = await authFetch(`/api/housekeeping/minibar-catalog?${params.toString()}`);
        const json = await res.json();
        if (!cancelled && res.ok && json?.data) {
          const paidDefaults: CatalogProduct[] = Array.isArray(json.data.minibar_defaults)
            ? json.data.minibar_defaults.map((std: any) => ({
                menu_item_id: Number(std.menu_item_id),
                name: String(std.item_name || std.name || ''),
                sku: String(std.sku || ''),
                unit_price: Number(std.unit_price || 0),
                base_unit_code: String(std.base_unit_code || 'PCS'),
                hkp_stock_balance: Number(std.hkp_stock_balance || 0),
                standard_qty: Number(std.standard_qty || 0),
                item_role: 'PAID_MINIBAR',
              }))
            : [];
          setCatalog(paidDefaults);
          if (json.data.reservation_context) {
            setResContext(json.data.reservation_context);
            // If guest has an active deposit balance > 0, default to DEPOSIT or keep FOLIO
            if (Number(json.data.reservation_context.available_deposit_balance || 0) > 0) {
              setSettlementMode('DEPOSIT');
            }
          }
        }
      } catch {
        // non-fatal
      }
    };
    loadCtx();
    return () => {
      cancelled = true;
    };
  }, [propertyId, taskId, roomId, reservationId]);

  const totalAmount = items.reduce((sum, it) => sum + Number(it.quantity || 0) * Number(it.unit_price || 0), 0);
  const availableDeposit = Number(resContext?.available_deposit_balance || 0);
  const isConfirmed = billingStatus === 'CONFIRMED_BILLED';
  const isWaived = billingStatus === 'WAIVED';

  const handleQtyChange = (menuItemId: number, delta: number) => {
    setItems((prev) =>
      prev
        .map((it) => {
          if (it.menu_item_id !== menuItemId) return it;
          const nextQty = Math.max(0, Number(it.quantity || 0) + delta);
          return {
            ...it,
            quantity: nextQty,
            subtotal: nextQty * Number(it.unit_price || 0),
          };
        })
        .filter((it) => it.quantity > 0)
    );
  };

  const handleAddProduct = (menuItemIdStr: string) => {
    const pid = Number(menuItemIdStr);
    if (!pid) return;
    const prod = catalog.find((c) => c.menu_item_id === pid);
    if (!prod) return;
    setItems((prev) => {
      const existing = prev.find((it) => it.menu_item_id === pid);
      if (existing) {
        return prev.map((it) =>
          it.menu_item_id === pid
            ? { ...it, quantity: it.quantity + 1, subtotal: (it.quantity + 1) * it.unit_price }
            : it
        );
      }
      return [
        ...prev,
        {
          menu_item_id: prod.menu_item_id,
          name: prod.name,
          sku: prod.sku,
          quantity: 1,
          unit_price: prod.unit_price,
          subtotal: prod.unit_price,
          base_unit_code: prod.base_unit_code,
        },
      ];
    });
    setSelectedAddProductId('');
  };

  const handleConfirmBilling = async (modeOverride?: 'FOLIO' | 'DEPOSIT' | 'DIRECT_PAY' | 'WAIVE') => {
    const targetMode = modeOverride || settlementMode;
    if (targetMode !== 'WAIVE' && (items.length === 0 || totalAmount <= 0)) {
      setErrorMsg('Pilih minimal 1 produk minibar yang dikonsumsi tamu sebelum mengonfirmasi tagihan.');
      return;
    }

    try {
      setSubmitting(true);
      setErrorMsg(null);
      setSuccessMsg(null);
      const res = await authFetch(`/api/housekeeping/checkout-inspections/${taskId}/confirm-minibar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          reservation_id: reservationId || resContext?.reservation_id || null,
          settlement_mode: targetMode,
          payment_method: targetMode === 'DIRECT_PAY' ? paymentMethod : targetMode,
          items: items.map((it) => ({
            menu_item_id: it.menu_item_id,
            quantity: it.quantity,
            unit_price: it.unit_price,
          })),
          actor_name: actorName,
          actor_role: 'Front Office',
        }),
      });
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        throw new Error(json.message || 'Gagal mengonfirmasi tagihan minibar.');
      }

      const data = json.data;
      setBillingStatus(data.minibar_billing_status || 'CONFIRMED_BILLED');
      setBillingMeta(data.minibar_billing_meta || null);
      setSuccessMsg(
        targetMode === 'WAIVE'
          ? 'Tagihan minibar dibebaskan (Waived).'
          : targetMode === 'DEPOSIT'
          ? `Tagihan Minibar Rp ${totalAmount.toLocaleString('id-ID')} berhasil dipotong dari Deposit Kamar & stok HKP telah dikurangi.`
          : targetMode === 'DIRECT_PAY'
          ? `Tagihan Minibar Rp ${totalAmount.toLocaleString('id-ID')} berhasil dibayar lunas (${paymentMethod}) & stok HKP telah dikurangi.`
          : `Tagihan Minibar Rp ${totalAmount.toLocaleString('id-ID')} berhasil dimasukkan ke Tagihan Reservasi (Folio) & stok HKP telah dikurangi.`
      );
      if (onConfirmed) {
        onConfirmed(data);
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Terjadi kesalahan saat mengonfirmasi tagihan minibar.');
    } finally {
      setSubmitting(false);
    }
  };

  if (isConfirmed && billingMeta) {
    const confirmedList: MinibarItemEntry[] = Array.isArray(billingMeta.confirmed_items)
      ? billingMeta.confirmed_items
      : items;
    const modeLabel =
      billingMeta.settlement_mode === 'DEPOSIT'
        ? `Dipotong dari Deposit Kamar (Rp ${Number(billingMeta.deposit_applied_amount || billingMeta.total_amount || 0).toLocaleString('id-ID')})`
        : billingMeta.settlement_mode === 'DIRECT_PAY'
        ? `Dibayar Lunas (${billingMeta.payment_method || 'CASH'})`
        : 'Masuk Tagihan Reservasi (Folio Kamar)';

    return (
      <div className="p-3.5 rounded-xl bg-emerald-50/90 border border-emerald-300 text-xs space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-bold text-emerald-900 flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-700" />
            <span>Tagihan Minibar Terkonfirmasi &amp; Stok HKP Terpotong</span>
          </span>
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-200/80 text-emerald-950">
            Rp {Number(billingMeta.total_amount || totalAmount || 0).toLocaleString('id-ID')}
          </span>
        </div>

        {confirmedList.length > 0 && (
          <div className="bg-white/90 rounded-lg border border-emerald-200 divide-y divide-emerald-100">
            {confirmedList.map((it, idx) => (
              <div key={idx} className="px-2.5 py-1.5 flex items-center justify-between text-[11px]">
                <span className="font-medium text-slate-800">
                  {it.quantity}x {it.name}
                </span>
                <span className="font-mono font-semibold text-slate-900">
                  Rp {Number(it.subtotal || it.quantity * it.unit_price).toLocaleString('id-ID')}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-emerald-800 pt-0.5">
          <span>
            Metode Penyelesaian: <strong>{modeLabel}</strong>
          </span>
          <span>
            Gudang Stok: <strong>{billingMeta.stock_location_code || 'HKP'}</strong>
          </span>
        </div>
      </div>
    );
  }

  if (isWaived) {
    return (
      <div className="p-3 rounded-xl bg-stone-100 border border-stone-300 text-xs text-stone-700">
        <strong>Tagihan Minibar Dibebaskan (Waived)</strong> — Tidak ditagihkan ke tamu dan tidak memotong stok HKP.
      </div>
    );
  }

  return (
    <div className="p-3.5 rounded-xl bg-amber-50/80 border border-amber-300 text-xs space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-bold text-amber-950 flex items-center gap-1.5">
            <CupSoda className="w-4 h-4 text-amber-700" />
            <span>Konfirmasi Konsumsi Minibar Kamar {roomNumber || ''} (Gudang HKP)</span>
          </div>
          <p className="text-[11px] text-amber-800 mt-0.5">
            Periksa rincian minibar yang berkurang, pilih metode penagihan/pembayaran, lalu klik Konfirmasi agar otomatis masuk tagihan & memotong stok HKP.
          </p>
        </div>
        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-200 text-amber-950 shrink-0">
          Menunggu Konfirmasi FO
        </span>
      </div>

      {errorMsg && (
        <div className="p-2.5 rounded-lg bg-rose-100 border border-rose-300 text-rose-900 font-medium text-[11px]">
          {errorMsg}
        </div>
      )}
      {successMsg && (
        <div className="p-2.5 rounded-lg bg-emerald-100 border border-emerald-300 text-emerald-900 font-medium text-[11px]">
          {successMsg}
        </div>
      )}

      {/* List of consumed minibar items */}
      <div className="bg-white rounded-xl border border-amber-200 overflow-hidden">
        {items.length === 0 ? (
          <div className="p-3 text-center text-slate-500 text-[11px]">
            Belum ada rincian produk minibar yang dipilih. Pilih produk minibar di bawah untuk menagih & memotong stok HKP.
            {estimatedCharge && Number(estimatedCharge) > 0 ? (
              <div className="mt-1 font-semibold text-amber-800">
                (Catatan Estimasi HK: Rp {Number(estimatedCharge).toLocaleString('id-ID')})
              </div>
            ) : null}
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {items.map((it) => (
              <div key={it.menu_item_id} className="px-3 py-2 flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-slate-800 truncate">{it.name}</div>
                  <div className="text-[10px] text-slate-500 font-mono">
                    @ Rp {Number(it.unit_price || 0).toLocaleString('id-ID')}
                    {it.sku ? ` • ${it.sku}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleQtyChange(it.menu_item_id, -1)}
                    className="w-6 h-6 rounded-md border border-slate-300 bg-slate-50 hover:bg-slate-100 font-bold text-slate-700 flex items-center justify-center cursor-pointer"
                  >
                    -
                  </button>
                  <span className="w-6 text-center font-bold text-slate-900">{it.quantity}</span>
                  <button
                    type="button"
                    onClick={() => handleQtyChange(it.menu_item_id, 1)}
                    className="w-6 h-6 rounded-md border border-emerald-300 bg-emerald-50 hover:bg-emerald-100 font-bold text-emerald-800 flex items-center justify-center cursor-pointer"
                  >
                    +
                  </button>
                </div>
                <div className="w-24 text-right font-mono font-bold text-slate-900">
                  Rp {(Number(it.quantity || 0) * Number(it.unit_price || 0)).toLocaleString('id-ID')}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add / Adjust Minibar Item from Catalog */}
        <div className="p-2 bg-slate-50 border-t border-slate-200 flex items-center gap-2">
          <select
            value={selectedAddProductId}
            onChange={(e) => handleAddProduct(e.target.value)}
            className="flex-1 text-[11px] bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-800 focus:outline-none focus:ring-1 focus:ring-emerald-600 cursor-pointer"
          >
            <option value="">+ Tambah / Pilih Produk Minibar (Gudang HKP)...</option>
            {catalog.map((c) => (
              <option key={c.menu_item_id} value={c.menu_item_id}>
                {c.name} — Rp {Number(c.unit_price || 0).toLocaleString('id-ID')} (Stok HKP: {c.hkp_stock_balance} {c.base_unit_code})
              </option>
            ))}
          </select>
        </div>

        {/* Subtotal footer */}
        <div className="px-3 py-2 bg-amber-100/70 border-t border-amber-200 flex items-center justify-between font-bold text-amber-950">
          <span>Total Tagihan Minibar</span>
          <span className="font-mono text-sm">Rp {totalAmount.toLocaleString('id-ID')}</span>
        </div>
      </div>

      {/* Settlement Mode Options */}
      <div className="space-y-2">
        <div className="font-bold text-slate-800 text-[11px]">Metode Penagihan & Pembayaran Tamu:</div>
        <div className="grid grid-cols-1 gap-1.5">
          {/* Option 1: Potong dari Deposit Kamar */}
          <label
            className={`p-2.5 rounded-xl border flex items-start gap-2.5 cursor-pointer transition ${
              settlementMode === 'DEPOSIT'
                ? 'bg-emerald-50 border-emerald-500 text-emerald-950 shadow-2xs'
                : availableDeposit <= 0
                ? 'bg-slate-100 border-slate-200 text-slate-400 opacity-70'
                : 'bg-white border-slate-200 text-slate-800 hover:bg-slate-50'
            }`}
          >
            <input
              type="radio"
              name={`mb_settlement_${taskId}`}
              checked={settlementMode === 'DEPOSIT'}
              disabled={availableDeposit <= 0}
              onChange={() => setSettlementMode('DEPOSIT')}
              className="mt-0.5 text-emerald-700 focus:ring-emerald-600"
            />
            <div className="flex-1">
              <div className="font-bold flex items-center justify-between">
                <span>Potong dari Deposit Kamar</span>
                <span
                  className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${
                    availableDeposit > 0
                      ? 'bg-emerald-100 text-emerald-800 font-bold'
                      : 'bg-slate-200 text-slate-600'
                  }`}
                >
                  Saldo Deposit: Rp {availableDeposit.toLocaleString('id-ID')}
                </span>
              </div>
              <p className="text-[10px] text-slate-600 mt-0.5">
                Masuk ke Tagihan Reservasi (Folio) dan langsung memotong saldo deposit kamar tamu.
              </p>
            </div>
          </label>

          {/* Option 2: Bayar Langsung Lunas (Cash / QRIS / Transfer) */}
          <label
            className={`p-2.5 rounded-xl border flex items-start gap-2.5 cursor-pointer transition ${
              settlementMode === 'DIRECT_PAY'
                ? 'bg-emerald-50 border-emerald-500 text-emerald-950 shadow-2xs'
                : 'bg-white border-slate-200 text-slate-800 hover:bg-slate-50'
            }`}
          >
            <input
              type="radio"
              name={`mb_settlement_${taskId}`}
              checked={settlementMode === 'DIRECT_PAY'}
              onChange={() => setSettlementMode('DIRECT_PAY')}
              className="mt-0.5 text-emerald-700 focus:ring-emerald-600"
            />
            <div className="flex-1 space-y-1.5">
              <div className="font-bold">Bayar Langsung Lunas di Kasir FO (Cash / QRIS / Transfer)</div>
              <p className="text-[10px] text-slate-600">
                Masuk ke Tagihan Reservasi, otomatis tercatat Lunas, dan langsung mengurangi stok HKP.
              </p>
              {settlementMode === 'DIRECT_PAY' && (
                <div className="pt-1 flex items-center gap-2">
                  <span className="text-[11px] font-semibold text-slate-700">Metode Bayar:</span>
                  <select
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                    className="text-xs bg-white border border-emerald-400 rounded-lg px-2.5 py-1 font-semibold text-slate-900 focus:outline-none focus:ring-1 focus:ring-emerald-600 cursor-pointer"
                  >
                    <option value="CASH">Cash / Tunai</option>
                    <option value="QRIS">QRIS</option>
                    <option value="BANK_TRANSFER">Transfer Bank</option>
                    <option value="DEBIT_CARD">Kartu Debit (EDC)</option>
                    <option value="CREDIT_CARD">Kartu Kredit (EDC)</option>
                  </select>
                </div>
              )}
            </div>
          </label>

          {/* Option 3: Masukkan ke Tagihan Reservasi (Bayar Saat Pelunasan Checkout) */}
          <label
            className={`p-2.5 rounded-xl border flex items-start gap-2.5 cursor-pointer transition ${
              settlementMode === 'FOLIO'
                ? 'bg-emerald-50 border-emerald-500 text-emerald-950 shadow-2xs'
                : 'bg-white border-slate-200 text-slate-800 hover:bg-slate-50'
            }`}
          >
            <input
              type="radio"
              name={`mb_settlement_${taskId}`}
              checked={settlementMode === 'FOLIO'}
              onChange={() => setSettlementMode('FOLIO')}
              className="mt-0.5 text-emerald-700 focus:ring-emerald-600"
            />
            <div className="flex-1">
              <div className="font-bold">Masukkan ke Tagihan Reservasi (Folio Kamar)</div>
              <p className="text-[10px] text-slate-600 mt-0.5">
                Menambah sisa tagihan reservasi untuk dilunasi bersama tagihan kamar & langsung memotong stok HKP.
              </p>
            </div>
          </label>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="pt-1 flex items-center justify-between gap-2">
        <button
          type="button"
          disabled={submitting}
          onClick={() => handleConfirmBilling('WAIVE')}
          className="px-3 py-2 rounded-xl border border-stone-300 bg-white hover:bg-stone-100 text-stone-600 font-semibold text-[11px] cursor-pointer disabled:opacity-50"
        >
          Bebaskan (Waive)
        </button>

        <button
          type="button"
          disabled={submitting || items.length === 0 || totalAmount <= 0}
          onClick={() => handleConfirmBilling()}
          className="flex-1 py-2.5 px-4 rounded-xl bg-[#1b4332] hover:bg-[#143326] text-white font-bold text-xs shadow-xs transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting
            ? 'Memproses Tagihan & Stok HKP...'
            : settlementMode === 'DEPOSIT'
            ? `✓ Konfirmasi & Potong Deposit (Rp ${totalAmount.toLocaleString('id-ID')})`
            : settlementMode === 'DIRECT_PAY'
            ? `✓ Konfirmasi Lunas ${paymentMethod} & Potong Stok HKP (Rp ${totalAmount.toLocaleString('id-ID')})`
            : `✓ Konfirmasi Tagih ke Reservasi & Potong Stok HKP (Rp ${totalAmount.toLocaleString('id-ID')})`}
        </button>
      </div>
    </div>
  );
};
