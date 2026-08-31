import React, { useState } from 'react';
import { voidFolioEntry } from './stayChargesApi';

interface Props {
  propertyId: number;
  entry: any;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (data: any) => void;
}

export default function VoidFolioEntryModal({
  propertyId,
  entry,
  isOpen,
  onClose,
  onSuccess
}: Props) {
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen || !entry) return null;

  const handleVoid = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) {
      setErrorMsg('Alasan pembatalan (void reason) wajib diisi');
      return;
    }

    try {
      setLoading(true);
      setErrorMsg(null);
      const result = await voidFolioEntry(entry.id, {
        property_id: propertyId,
        void_reason: reason.trim(),
        voided_by: 'Staff Front Office'
      });
      onSuccess(result);
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal membatalkan entry folio');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-2xl border border-stone-200 w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <div className="px-6 py-4 bg-rose-800 text-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">⚠️</span>
            <div>
              <h2 className="text-base font-bold text-white">Batalkan Item Tagihan (Void)</h2>
              <p className="text-xs text-rose-200">Koreksi folio tanpa menghapus riwayat audit</p>
            </div>
          </div>
          <button onClick={onClose} className="text-rose-200 hover:text-white p-1 rounded-lg text-xs">
            ✕
          </button>
        </div>

        {errorMsg && (
          <div className="mx-6 mt-4 p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-800 text-xs">
            ⚠ {errorMsg}
          </div>
        )}

        <form onSubmit={handleVoid} className="p-6 space-y-4 text-xs">
          <div className="bg-stone-50 border border-stone-200 rounded-lg p-3 space-y-1">
            <div className="text-stone-500 font-semibold">Item yang akan dibatalkan:</div>
            <div className="font-bold text-stone-900 text-sm">{entry.description}</div>
            <div className="font-mono text-stone-700">
              Nominal: <span className="font-bold text-rose-700">Rp {Number(entry.amount).toLocaleString('id-ID')}</span>
            </div>
          </div>

          <div>
            <label className="block font-semibold text-stone-700 mb-1">
              Alasan Pembatalan (Wajib untuk Audit Trail) *
            </label>
            <textarea
              required
              rows={3}
              placeholder="Contoh: Salah input kamar, tamu membatalkan extra bed, denda dihapuskan oleh Manager, dll."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full border border-stone-300 rounded-lg px-3 py-2 bg-white focus:ring-2 focus:ring-rose-600 focus:outline-hidden"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-stone-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-stone-300 text-stone-700 font-semibold rounded-lg hover:bg-stone-100"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-5 py-2 bg-rose-700 hover:bg-rose-800 text-white font-bold rounded-lg shadow-sm flex items-center gap-1.5"
            >
              {loading ? 'Memproses...' : '✓ Konfirmasi Void'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
