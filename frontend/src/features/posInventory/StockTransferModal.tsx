/**
 * OAK HIMS — MP-04B Stock Transfer Modal
 * Form Transfer Stok Antar Lokasi (Gudang ke Dapur / Outlet / Minibar)
 */

import { useState, useEffect, type FormEvent } from 'react';
import { submitStockTransfer } from './posInventoryApi';
import type { StockLocation } from './posInventoryTypes';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  propertyId: number;
  locations: StockLocation[];
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

export default function StockTransferModal({
  isOpen,
  onClose,
  propertyId,
  locations,
  initialItem,
  onSuccess,
}: Props) {
  const [toLocationId, setToLocationId] = useState<number | ''>('');
  const [quantityStr, setQuantityStr] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && initialItem) {
      // Cari lokasi tujuan default yang bukan lokasi asal
      const otherLoc = locations.find((l) => l.id !== initialItem.location_id);
      setToLocationId(otherLoc ? otherLoc.id : '');
      setQuantityStr('');
      setNotes('');
      setErrorMsg(null);
    }
  }, [isOpen, initialItem, locations]);

  if (!isOpen || !initialItem) return null;

  const currentBalance = parseFloat(initialItem.current_quantity || '0');
  const transferQty = parseFloat(quantityStr) || 0;

  const isInvalidQty = transferQty <= 0 || isNaN(transferQty);
  const isInsufficient = transferQty > currentBalance;
  const isSameLocation = toLocationId === initialItem.location_id;
  const isNoDestination = !toLocationId;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (isNoDestination) {
      setErrorMsg('Pilih lokasi tujuan transfer');
      return;
    }
    if (isSameLocation) {
      setErrorMsg('Lokasi asal dan lokasi tujuan tidak boleh sama');
      return;
    }
    if (isInvalidQty) {
      setErrorMsg('Kuantitas transfer harus lebih besar dari 0');
      return;
    }
    if (isInsufficient) {
      setErrorMsg(`Saldo di lokasi asal tidak mencukupi (Tersedia: ${currentBalance.toFixed(3)} ${initialItem.base_unit_code})`);
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);

    const operationKey = `trf-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    try {
      await submitStockTransfer({
        property_id: propertyId,
        from_location_id: initialItem.location_id,
        to_location_id: Number(toLocationId),
        items: [
          {
            product_id: initialItem.product_id,
            quantity: transferQty,
            notes: notes.trim() || undefined,
          },
        ],
        operation_key: operationKey,
        notes: notes.trim() || `Transfer ${initialItem.product_name}`,
      });

      onSuccess();
      onClose();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Gagal menyimpan transfer stok');
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
              Transfer Stok Antar Lokasi
            </div>
            <h3 className="text-base font-extrabold text-white mt-0.5">
              {initialItem.product_name}
            </h3>
            <div className="text-xs text-white/70">
              Lokasi Asal: {initialItem.location_name}
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

          {/* Source Location & Current Stock */}
          <div className="p-3 bg-[#faf9f5] rounded-xl border border-gray-200 flex items-center justify-between">
            <div>
              <div className="text-[10px] font-bold text-gray-500 uppercase">Lokasi Asal</div>
              <div className="text-xs font-bold text-gray-800 mt-0.5">
                {initialItem.location_name}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] font-bold text-gray-500 uppercase">Saldo Tersedia</div>
              <div className="text-sm font-black text-emerald-800 mt-0.5">
                {currentBalance.toFixed(3)} {initialItem.base_unit_code}
              </div>
            </div>
          </div>

          {/* Destination Location Selector */}
          <div>
            <label className="block text-xs font-bold text-gray-700 mb-1">
              Lokasi Tujuan Transfer
            </label>
            <select
              value={toLocationId}
              onChange={(e) => setToLocationId(e.target.value ? Number(e.target.value) : '')}
              className="w-full px-3 py-2 text-xs border border-gray-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700"
              required
            >
              <option value="" disabled>-- Pilih Lokasi Tujuan --</option>
              {locations.map((loc) => {
                const isOrigin = loc.id === initialItem.location_id;
                return (
                  <option key={loc.id} value={loc.id} disabled={isOrigin}>
                    {loc.name} ({loc.code}) {isOrigin ? '— [Lokasi Asal]' : ''}
                  </option>
                );
              })}
            </select>
          </div>

          {/* Quantity Input */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-bold text-gray-700">
                Kuantitas Transfer ({initialItem.base_unit_code})
              </label>
              <span className="text-[11px] text-gray-400">
                Maks: {currentBalance.toFixed(3)}
              </span>
            </div>
            <input
              type="number"
              step="any"
              min="0.001"
              placeholder="0.000"
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
                ⚠ Kuantitas transfer melebihi saldo tersedia ({currentBalance.toFixed(3)} {initialItem.base_unit_code}).
              </p>
            )}
          </div>

          {/* Notes */}
          <div>
            <label className="block text-xs font-bold text-gray-700 mb-1">
              Catatan / Permintaan (Opsional)
            </label>
            <textarea
              rows={2}
              placeholder="Permintaan dari dapur, restock bar, nomor slip pengiriman..."
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
              disabled={submitting || isInsufficient || isInvalidQty || isSameLocation || isNoDestination}
              className="px-5 py-2 bg-[#1b4332] hover:bg-[#2d6a4f] text-white text-xs font-bold rounded-xl shadow-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {submitting ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  <span>Mentransfer...</span>
                </>
              ) : (
                <span>Kirim Transfer Stok</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
