import React, { useState } from 'react';
import type { TransactionRecord } from './transactionDomainTypes';
import { voidTransactionApi } from './transactionClient';

interface VoidTransactionModalProps {
  isOpen: boolean;
  propertyId: number;
  transaction: TransactionRecord | null;
  currentStaffName?: string;
  onClose: () => void;
  onSuccess: () => void;
}

export const VoidTransactionModal: React.FC<VoidTransactionModalProps> = ({
  isOpen,
  propertyId,
  transaction,
  currentStaffName = 'Supervisor',
  onClose,
  onSuccess
}) => {
  const [reason, setReason] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen || !transaction) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) {
      setErrorMsg('Alasan pembatalan transaksi wajib diisi');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      await voidTransactionApi(transaction.id, propertyId, reason.trim(), currentStaffName);
      onSuccess();
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal membatalkan transaksi');
    } finally {
      setIsSubmitting(false);
    }
  };

  const formatIdr = (val: number) => {
    return 'Rp ' + Math.abs(Number(val || 0)).toLocaleString('id-ID');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-rose-100 flex items-center justify-between bg-rose-50/60">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-rose-100 text-rose-600 flex items-center justify-center font-bold">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <div>
              <h3 className="text-base font-bold text-rose-900">Batalkan Transaksi (Void)</h3>
              <p className="text-xs text-rose-600">Tindakan ini akan membuat transaksi pembalik otomatis</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-200/60 transition-colors cursor-pointer"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content & Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {errorMsg && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl">
              {errorMsg}
            </div>
          )}

          {/* Transaction Summary Card */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-slate-500">No. Transaksi:</span>
              <span className="font-mono font-bold text-slate-800">{transaction.transaction_no}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Kategori / Tipe:</span>
              <span className="font-semibold text-slate-700">
                {transaction.category_name} ({transaction.transaction_type})
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Keterangan:</span>
              <span className="text-slate-700 max-w-[240px] truncate text-right">{transaction.description}</span>
            </div>
            <div className="flex justify-between pt-1 border-t border-slate-200 font-bold text-sm">
              <span className="text-slate-700">Nominal:</span>
              <span className="text-slate-900">{formatIdr(transaction.net_amount)}</span>
            </div>
          </div>

          <div className="p-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl text-xs space-y-1">
            <p className="font-semibold flex items-center gap-1.5">
              <span>ℹ️</span> Standar Audit Transaksi Perhotelan:
            </p>
            <p className="text-amber-700 leading-relaxed">
              Sesuai kaidah audit operasional, baris transaksi asli tidak dihapus fisik melainkan ditandai <strong>VOIDED</strong> dan sistem akan menerbitkan entri pembalik (reversal) senilai <strong>-{formatIdr(transaction.net_amount)}</strong> agar rekapitulasi transaksi tetap seimbang.
            </p>
          </div>

          {/* Void Reason */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Alasan Pembatalan <span className="text-rose-500">*</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Contoh: Salah entri nominal transaksi, pembatalan pesanan tamu, atau koreksi kas..."
              rows={3}
              className="w-full text-xs bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2.5 text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500 resize-none"
              required
            />
          </div>

          <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 text-xs font-medium text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-xl transition-colors cursor-pointer"
            >
              Kembali
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-5 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-xl shadow-xs transition-all cursor-pointer disabled:opacity-50"
            >
              {isSubmitting ? 'Membatalkan...' : 'Konfirmasi Batalkan Transaksi'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
