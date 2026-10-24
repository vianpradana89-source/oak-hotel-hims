/**
 * OAK HIMS — MP-04B Stock Opname Modal
 * Form Opname Fisik Persediaan dengan kalkulasi variansi otomatis (Surplus / Defisit / Match)
 */

import { useState, useEffect, type FormEvent } from 'react';
import { submitStockOpname } from './posInventoryApi';
import type { StockLocation } from './posInventoryTypes';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  propertyId: number;
  locations?: StockLocation[];
  initialItem?: {
    product_id: number;
    product_name: string;
    location_id: number;
    location_name: string;
    current_quantity: string;
    base_unit_code: string;
  } | null;
  onSuccess: () => void;
}

export default function StockOpnameModal({
  isOpen,
  onClose,
  propertyId,
  initialItem,
  onSuccess,
}: Props) {
  const [physicalQtyStr, setPhysicalQtyStr] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && initialItem) {
      setPhysicalQtyStr(parseFloat(initialItem.current_quantity || '0').toFixed(3));
      setNotes('');
      setErrorMsg(null);
    }
  }, [isOpen, initialItem]);

  if (!isOpen || !initialItem) return null;

  const systemQty = parseFloat(initialItem.current_quantity || '0');
  const physicalQty = parseFloat(physicalQtyStr);
  const isValidCount = !isNaN(physicalQty) && physicalQty >= 0;

  const variance = isValidCount ? Math.round((physicalQty - systemQty) * 1000) / 1000 : 0;
  const isSurplus = variance > 0.00001;
  const isDeficit = variance < -0.00001;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isValidCount) {
      setErrorMsg('Hasil hitung fisik harus berupa bilangan desimal >= 0');
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);

    const operationKey = `opn-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    try {
      await submitStockOpname({
        property_id: propertyId,
        location_id: initialItem.location_id,
        items: [
          {
            product_id: initialItem.product_id,
            physical_quantity: physicalQty,
            notes: notes.trim() || undefined,
          },
        ],
        operation_key: operationKey,
        notes: notes.trim() || `Stock opname ${initialItem.product_name}`,
      });

      onSuccess();
      onClose();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Gagal menyimpan opname fisik');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full border border-gray-200 overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 bg-[#1b4332] text-white flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase font-bold tracking-wider text-[#d4af37]">
              Stock Opname Fisik
            </div>
            <h3 className="text-base font-extrabold text-white mt-0.5">
              {initialItem.product_name}
            </h3>
            <div className="text-xs text-white/70">
              Lokasi: {initialItem.location_name}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-white/70 hover:text-white p-1 rounded-lg hover:bg-white/10 transition-colors cursor-pointer"
            aria-label="Tutup"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {errorMsg && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-800 text-xs flex items-center justify-between">
              <span>{errorMsg}</span>
              <button
                type="button"
                onClick={() => setErrorMsg(null)}
                className="font-bold hover:text-rose-900 ml-2"
              >
                ✕
              </button>
            </div>
          )}

          {/* System Quantity Comparison */}
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 bg-gray-50 rounded-xl border border-gray-200">
              <div className="text-[11px] font-bold text-gray-500 uppercase">
                Saldo Sistem (Buku)
              </div>
              <div className="text-lg font-black text-gray-800 mt-1">
                {systemQty.toFixed(3)}
              </div>
              <div className="text-[10px] text-gray-400">{initialItem.base_unit_code}</div>
            </div>

            <div className="p-3 bg-[#faf9f5] rounded-xl border border-[#bfa15f]/40">
              <div className="text-[11px] font-bold text-[#8f6d14] uppercase">
                Hasil Hitung Fisik
              </div>
              <div className="mt-1">
                <input
                  type="number"
                  step="any"
                  min="0"
                  placeholder="0.000"
                  value={physicalQtyStr}
                  onChange={(e) => setPhysicalQtyStr(e.target.value)}
                  className="w-full px-2.5 py-1 text-base font-black border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700"
                  required
                  autoFocus
                />
              </div>
              <div className="text-[10px] text-gray-400 mt-0.5">{initialItem.base_unit_code}</div>
            </div>
          </div>

          {/* Live Variance Calculation Card */}
          {isValidCount && (
            <div
              className={`p-3.5 rounded-xl border flex items-center justify-between ${
                isSurplus
                  ? 'bg-emerald-50/80 border-emerald-300 text-emerald-900'
                  : isDeficit
                  ? 'bg-rose-50/80 border-rose-300 text-rose-900'
                  : 'bg-blue-50/80 border-blue-300 text-blue-900'
              }`}
            >
              <div>
                <div className="text-xs font-bold uppercase tracking-wider">
                  Status Variansi:
                  <span className="ml-1.5 font-extrabold">
                    {isSurplus ? 'SURPLUS (+)' : isDeficit ? 'DEFISIT (-)' : 'SESUAI (MATCH)'}
                  </span>
                </div>
                <div className="text-[11px] opacity-80 mt-0.5">
                  {isSurplus
                    ? 'Stok fisik lebih banyak daripada catatan sistem'
                    : isDeficit
                    ? 'Stok fisik lebih sedikit daripada catatan sistem'
                    : 'Stok fisik tepat sesuai dengan catatan sistem'}
                </div>
              </div>

              <div className="text-right">
                <div className="text-base font-black">
                  {isSurplus ? `+${variance.toFixed(3)}` : variance.toFixed(3)}
                </div>
                <div className="text-[10px] font-medium opacity-70">
                  {initialItem.base_unit_code}
                </div>
              </div>
            </div>
          )}

          {/* Notes */}
          <div>
            <label className="block text-xs font-bold text-gray-700 mb-1">
              Catatan Opname (Opsional)
            </label>
            <textarea
              rows={2}
              placeholder="Keterangan hasil hitung, nama petugas pemeriksa, dll..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-gray-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700 resize-none"
            />
          </div>

          {/* Actions */}
          <div className="pt-2 flex items-center justify-end gap-2 border-t border-gray-100">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-semibold rounded-xl transition-colors cursor-pointer disabled:opacity-50"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={submitting || !isValidCount}
              className="px-5 py-2 bg-[#1b4332] hover:bg-[#2d6a4f] text-white text-xs font-bold rounded-xl shadow-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {submitting ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  <span>Menyimpan...</span>
                </>
              ) : (
                <span>Simpan Hasil Opname</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
