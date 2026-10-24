/**
 * OAK HIMS — MP-04B Stock Adjustment Modal
 * Form Penyesuaian Stok (IN / OUT) dengan proteksi saldo non-negatif
 */

import { useState, useEffect, useMemo, type FormEvent } from 'react';
import { submitStockAdjustment } from './posInventoryApi';
import {
  STOCK_ADJUSTMENT_REASONS,
  type StockLocation,
  type StockAdjustmentReasonCode,
} from './posInventoryTypes';

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

export default function StockAdjustmentModal({
  isOpen,
  onClose,
  propertyId,
  initialItem,
  onSuccess,
}: Props) {
  const [adjustmentType, setAdjustmentType] = useState<'OUT' | 'IN'>('OUT');
  const [reasonCode, setReasonCode] = useState<StockAdjustmentReasonCode>('RUSAK');
  const [quantityStr, setQuantityStr] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setAdjustmentType('OUT');
      setReasonCode('RUSAK');
      setQuantityStr('');
      setNotes('');
      setErrorMsg(null);
    }
  }, [isOpen]);

  const currentBalance = initialItem ? parseFloat(initialItem.current_quantity || '0') : 0;
  const inputQuantity = parseFloat(quantityStr) || 0;

  const nextBalance = useMemo(() => {
    if (adjustmentType === 'IN') {
      return currentBalance + inputQuantity;
    } else {
      return currentBalance - inputQuantity;
    }
  }, [adjustmentType, currentBalance, inputQuantity]);

  const isInsufficient = adjustmentType === 'OUT' && inputQuantity > currentBalance;
  const isInvalidQuantity = inputQuantity <= 0 || isNaN(inputQuantity);

  if (!isOpen || !initialItem) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (isInvalidQuantity) {
      setErrorMsg('Kuantitas penyesuaian harus lebih besar dari 0');
      return;
    }
    if (isInsufficient) {
      setErrorMsg(`Saldo tidak mencukupi untuk penyesuaian keluar. Maksimal saldo tersedia: ${currentBalance.toFixed(3)} ${initialItem.base_unit_code}`);
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);

    const operationKey = `adj-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    try {
      await submitStockAdjustment({
        property_id: propertyId,
        product_id: initialItem.product_id,
        location_id: initialItem.location_id,
        adjustment_type: adjustmentType,
        reason_code: reasonCode,
        quantity: inputQuantity,
        operation_key: operationKey,
        notes: notes.trim() || undefined,
      });

      onSuccess();
      onClose();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Gagal menyimpan penyesuaian stok');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full border border-gray-200 overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150">
        {/* Modal Header */}
        <div className="px-6 py-4 bg-[#1b4332] text-white flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase font-bold tracking-wider text-[#d4af37]">
              Penyesuaian Stok Persediaan
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

        {/* Modal Body */}
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

          {/* Current Balance Display */}
          <div className="p-3 bg-[#faf9f5] rounded-xl border border-gray-200 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-600">Saldo Fisik Saat Ini:</span>
            <span className="text-sm font-black text-gray-900">
              {currentBalance.toFixed(3)} {initialItem.base_unit_code}
            </span>
          </div>

          {/* Adjustment Direction Toggle */}
          <div>
            <label className="block text-xs font-bold text-gray-700 mb-1">
              Arah Penyesuaian
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setAdjustmentType('OUT')}
                className={`py-2 px-3 rounded-xl text-xs font-bold border transition-colors cursor-pointer ${
                  adjustmentType === 'OUT'
                    ? 'bg-rose-50 border-rose-400 text-rose-800 shadow-2xs'
                    : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                Stok Keluar (Pengurangan)
              </button>
              <button
                type="button"
                onClick={() => setAdjustmentType('IN')}
                className={`py-2 px-3 rounded-xl text-xs font-bold border transition-colors cursor-pointer ${
                  adjustmentType === 'IN'
                    ? 'bg-emerald-50 border-emerald-400 text-emerald-800 shadow-2xs'
                    : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                Stok Masuk (Penambahan)
              </button>
            </div>
          </div>

          {/* Reason Code Selection */}
          <div>
            <label className="block text-xs font-bold text-gray-700 mb-1">
              Alasan Penyesuaian
            </label>
            <select
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value as StockAdjustmentReasonCode)}
              className="w-full px-3 py-2 text-xs border border-gray-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700"
            >
              {STOCK_ADJUSTMENT_REASONS.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.code} — {r.label}
                </option>
              ))}
            </select>
          </div>

          {/* Quantity Input */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-bold text-gray-700">
                Kuantitas ({initialItem.base_unit_code})
              </label>
              {adjustmentType === 'OUT' && (
                <span className="text-[11px] text-gray-400">
                  Maks: {currentBalance.toFixed(3)}
                </span>
              )}
            </div>
            <input
              type="number"
              step="any"
              min="0.001"
              placeholder="Contoh: 1.000"
              value={quantityStr}
              onChange={(e) => setQuantityStr(e.target.value)}
              className={`w-full px-3 py-2 text-sm border rounded-xl bg-white focus:outline-none focus:ring-2 ${
                isInsufficient
                  ? 'border-rose-400 focus:ring-rose-500'
                  : 'border-gray-300 focus:ring-emerald-700'
              }`}
              required
            />
            {isInsufficient && (
              <p className="text-[11px] text-rose-600 mt-1 font-semibold">
                ⚠ Saldo tidak mencukupi! Penyesuaian keluar tidak boleh melebihi saldo saat ini ({currentBalance.toFixed(3)}).
              </p>
            )}
          </div>

          {/* Live Projected Balance Preview */}
          {!isInvalidQuantity && (
            <div className="p-3 bg-gray-50 rounded-xl border border-gray-200 flex items-center justify-between text-xs">
              <span className="text-gray-500 font-medium">Estimasi Saldo Setelahnya:</span>
              <span
                className={`font-black text-sm ${
                  nextBalance < 0 ? 'text-rose-600' : 'text-emerald-800'
                }`}
              >
                {nextBalance.toFixed(3)} {initialItem.base_unit_code}
              </span>
            </div>
          )}

          {/* Notes Input */}
          <div>
            <label className="block text-xs font-bold text-gray-700 mb-1">
              Catatan / Keterangan (Opsional)
            </label>
            <textarea
              rows={2}
              placeholder="Tuliskan nomor berita acara, kondisi barang, dll..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-gray-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700 resize-none"
            />
          </div>

          {/* Modal Actions */}
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
              disabled={submitting || isInsufficient || isInvalidQuantity}
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
                <span>Simpan Penyesuaian</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
