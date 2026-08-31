import React, { useState, useEffect } from 'react';
import type {
  TransactionRecord,
  VerificationStatus,
  ReceivingStatus,
  AttachmentPurpose
} from './transactionDomainTypes';
import {
  fetchTransactionDetailApi,
  verifyTransactionApi,
  updatePurchaseReceivingStatusApi,
  uploadTransactionAttachmentApi,
  deleteTransactionAttachmentApi,
  settleTransactionPaymentApi
} from './transactionClient';

interface TransactionDetailDrawerProps {
  isOpen: boolean;
  transactionId: number | string | null;
  propertyId: number;
  currentStaffName?: string;
  currentUserId?: string | null;
  onClose: () => void;
  onOpenVoidModal?: (tx: TransactionRecord) => void;
  onOpenSoftDeleteModal?: (tx: TransactionRecord) => void;
  onNavigateToReservation?: (reservationId: number) => void;
  onNavigateToFolio?: (reservationId: number) => void;
  onTransactionUpdated?: () => void;
}

export const TransactionDetailDrawer: React.FC<TransactionDetailDrawerProps> = ({
  isOpen,
  transactionId,
  propertyId,
  currentStaffName = 'Staff Front Desk',
  currentUserId = null,
  onClose,
  onOpenVoidModal,
  onOpenSoftDeleteModal,
  onNavigateToReservation,
  onNavigateToFolio,
  onTransactionUpdated
}) => {
  const [data, setData] = useState<TransactionRecord | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Settlement Form State
  const [showSettleForm, setShowSettleForm] = useState(false);
  const [settleAmount, setSettleAmount] = useState<number | string>('');
  const [settleMethod, setSettleMethod] = useState<string>('TRANSFER');
  const [settleNotes, setSettleNotes] = useState<string>('');
  const [isSettling, setIsSettling] = useState(false);

  // Verification Form State
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [verifyStatusChoice, setVerifyStatusChoice] = useState<VerificationStatus>('VERIFIED');
  const [verifyNote, setVerifyNote] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);

  // Receiving Status Form State
  const [isUpdatingReceiving, setIsUpdatingReceiving] = useState(false);

  // Attachment Upload
  const [uploadingPurpose, setUploadingPurpose] = useState<AttachmentPurpose>('RECEIPT');
  const [isUploading, setIsUploading] = useState(false);

  useEffect(() => {
    if (isOpen && transactionId) {
      loadDetail();
      setShowSettleForm(false);
      setShowVerifyModal(false);
    } else {
      setData(null);
      setError(null);
    }
  }, [isOpen, transactionId, propertyId]);

  const loadDetail = async () => {
    if (!transactionId) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetchTransactionDetailApi(transactionId, propertyId);
      setData(res);
    } catch (err: any) {
      setError(err.message || 'Gagal memuat detail transaksi');
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  const tx = data;
  const lines = data?.lines || [];
  const attachments = data?.attachments || [];
  const payments = data?.linked_payments || [];

  const formatIdr = (val: number | undefined | string) => {
    if (val === undefined || val === null) return 'Rp 0';
    const num = Number(val) || 0;
    const isNeg = num < 0;
    return (isNeg ? '- Rp ' : 'Rp ') + Math.abs(num).toLocaleString('id-ID');
  };

  const handleSettleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tx) return;
    const numAmt = Math.round(Number(settleAmount) || 0);
    if (numAmt <= 0) {
      alert('Nominal pelunasan harus lebih dari Rp 0');
      return;
    }

    setIsSettling(true);
    try {
      await settleTransactionPaymentApi(tx.id, propertyId, {
        amount: numAmt,
        payment_method: settleMethod,
        notes: settleNotes.trim() || undefined,
        actor_name: currentStaffName
      });
      setShowSettleForm(false);
      setSettleAmount('');
      setSettleNotes('');
      await loadDetail();
      if (onTransactionUpdated) onTransactionUpdated();
    } catch (err: any) {
      alert(err.message || 'Gagal memproses pelunasan');
    } finally {
      setIsSettling(false);
    }
  };

  const handleVerifySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tx) return;
    setIsVerifying(true);
    try {
      await verifyTransactionApi(tx.id, {
        property_id: propertyId,
        verification_status: verifyStatusChoice,
        verification_note: verifyNote.trim() || undefined,
        actor_user_id: currentUserId || undefined,
        actor_name: currentStaffName
      });
      setShowVerifyModal(false);
      setVerifyNote('');
      await loadDetail();
      if (onTransactionUpdated) onTransactionUpdated();
    } catch (err: any) {
      alert(err.message || 'Gagal mengubah status verifikasi');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleReceivingChange = async (newStatus: ReceivingStatus) => {
    if (!tx || isUpdatingReceiving) return;
    setIsUpdatingReceiving(true);
    try {
      await updatePurchaseReceivingStatusApi(tx.id, propertyId, {
        receiving_status: newStatus,
        actor_name: currentStaffName
      });
      await loadDetail();
      if (onTransactionUpdated) onTransactionUpdated();
    } catch (err: any) {
      alert(err.message || 'Gagal memperbarui status penerimaan');
    } finally {
      setIsUpdatingReceiving(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !tx) return;

    setIsUploading(true);
    try {
      await uploadTransactionAttachmentApi(
        tx.id,
        propertyId,
        file,
        uploadingPurpose,
        currentStaffName
      );
      await loadDetail();
      if (onTransactionUpdated) onTransactionUpdated();
    } catch (err: any) {
      alert(err.message || 'Gagal mengunggah berkas');
    } finally {
      setIsUploading(false);
      e.target.value = '';
    }
  };

  const handleDeleteAttachment = async (attachmentId: number | string) => {
    if (!tx) return;
    if (tx.verification_status === 'VERIFIED') {
      alert('Lampiran pada transaksi terverifikasi dikunci dari penghapusan.');
      return;
    }
    if (!confirm('Hapus lampiran ini?')) return;

    try {
      await deleteTransactionAttachmentApi(tx.id, attachmentId, propertyId, currentStaffName);
      await loadDetail();
      if (onTransactionUpdated) onTransactionUpdated();
    } catch (err: any) {
      alert(err.message || 'Gagal menghapus lampiran');
    }
  };

  const isVerified = tx?.verification_status === 'VERIFIED';
  const outstanding = Number(tx?.outstanding_amount) || 0;
  const isPaid = tx?.payment_status === 'PAID';

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/50 backdrop-blur-xs transition-opacity animate-in fade-in">
      <div className="w-full max-w-2xl bg-white h-full shadow-2xl flex flex-col justify-between border-l border-slate-200 overflow-hidden">
        {/* Header */}
        <div className="p-5 border-b border-slate-200/80 bg-slate-50/90 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-slate-900">
                  {tx ? tx.transaction_no : 'Detail Transaksi'}
                </h3>
                {tx && (
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${
                    tx.transaction_type === 'SALE' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                    tx.transaction_type === 'PURCHASE' ? 'bg-blue-50 text-blue-700 border-blue-200' :
                    tx.transaction_type === 'EXPENSE' ? 'bg-rose-50 text-rose-700 border-rose-200' :
                    'bg-teal-50 text-teal-700 border-teal-200'
                  }`}>
                    {tx.transaction_type}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                {tx ? `${tx.transaction_date} • Dibuat oleh: ${tx.created_by || 'Staff'}` : 'Memuat data transaksi...'}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-600 rounded-xl hover:bg-slate-200/60 transition-colors cursor-pointer"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 text-xs text-slate-700">
          {isLoading ? (
            <div className="py-20 text-center text-slate-400 space-y-2">
              <div className="w-8 h-8 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin mx-auto" />
              <p className="font-medium">Memuat rincian transaksi...</p>
            </div>
          ) : error ? (
            <div className="p-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-center">
              <p className="font-bold">Gagal memuat transaksi</p>
              <p className="mt-1">{error}</p>
            </div>
          ) : tx ? (
            <>
              {/* Soft Delete Notice Banner if deleted */}
              {tx.deleted_at && (
                <div className="p-4 bg-slate-100 border border-slate-300 rounded-2xl space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 text-[10px] font-bold uppercase rounded bg-slate-700 text-white">
                      Status: Hapus
                    </span>
                    <span className="text-xs font-bold text-slate-800">
                      Draft Transaksi Ini Telah Dihapus
                    </span>
                  </div>
                  <div className="text-xs text-slate-600 space-y-0.5">
                    <div>
                      <strong className="text-slate-700">Dihapus Oleh:</strong> {tx.deleted_by_name_snapshot || 'Staff'}
                    </div>
                    <div>
                      <strong className="text-slate-700">Tanggal Hapus:</strong>{' '}
                      {new Date(tx.deleted_at).toLocaleString('id-ID')}
                    </div>
                    <div>
                      <strong className="text-slate-700">Alasan Hapus:</strong>{' '}
                      <span className="italic text-slate-900 font-medium">"{tx.delete_reason || '-'}"</span>
                    </div>
                  </div>
                  <p className="text-[10px] text-slate-500 pt-1 border-t border-slate-200">
                    Transkrip ini diarsipkan untuk kebutuhan audit dan tidak dihitung ke ringkasan keuangan operasional.
                  </p>
                </div>
              )}

              {/* Status Banner */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-4 bg-slate-50/80 border border-slate-200/80 rounded-2xl">
                <div>
                  <span className="text-[10px] text-slate-400 font-bold uppercase block">Status Transaksi</span>
                  <span className={`inline-flex items-center text-xs font-bold mt-1 ${
                    tx.transaction_status === 'POSTED' ? 'text-emerald-700' : 'text-rose-700'
                  }`}>
                    {tx.transaction_status}
                  </span>
                </div>

                <div>
                  <span className="text-[10px] text-slate-400 font-bold uppercase block">Status Pelunasan</span>
                  <span className={`inline-flex items-center text-xs font-bold mt-1 ${
                    tx.payment_status === 'PAID' ? 'text-emerald-700' : 'text-amber-700'
                  }`}>
                    {tx.payment_status}
                  </span>
                </div>

                <div>
                  <span className="text-[10px] text-slate-400 font-bold uppercase block">Verifikasi Audit</span>
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className={`text-xs font-bold ${
                      tx.verification_status === 'VERIFIED' ? 'text-emerald-700' :
                      tx.verification_status === 'REJECTED' ? 'text-rose-700' : 'text-amber-700'
                    }`}>
                      {tx.verification_status || 'UNVERIFIED'}
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowVerifyModal(true)}
                      className="text-[10px] text-slate-600 underline hover:text-emerald-800 font-semibold cursor-pointer ml-1"
                    >
                      Ubah
                    </button>
                  </div>
                </div>

                {tx.transaction_type === 'PURCHASE' && (
                  <div>
                    <span className="text-[10px] text-slate-400 font-bold uppercase block">Penerimaan Fisik</span>
                    <select
                      value={tx.receiving_status || 'BELUM_DITERIMA'}
                      onChange={(e) => handleReceivingChange(e.target.value as ReceivingStatus)}
                      disabled={isUpdatingReceiving}
                      className="mt-1 text-xs font-bold bg-white border border-slate-200 rounded-lg px-2 py-0.5 text-slate-800 outline-none"
                    >
                      <option value="BELUM_DITERIMA">Belum Diterima</option>
                      <option value="DITERIMA_SEBAGIAN">Diterima Sebagian</option>
                      <option value="DITERIMA">Diterima Lengkap</option>
                    </select>
                  </div>
                )}
              </div>

              {/* Verification Details if verified */}
              {tx.verification_status && tx.verification_status !== 'UNVERIFIED' && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-1">
                  <div className="text-[11px] font-bold text-slate-800 flex items-center justify-between">
                    <span>Diverifikasi oleh: {tx.verified_by_name_snapshot || 'Auditor'}</span>
                    <span className="text-slate-400 font-normal">
                      {tx.verified_at ? new Date(tx.verified_at).toLocaleString('id-ID') : ''}
                    </span>
                  </div>
                  {tx.verification_note && (
                    <div className="text-[11px] text-slate-600 italic">"{tx.verification_note}"</div>
                  )}
                </div>
              )}

              {/* Supplier / Party Card */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
                <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block">
                  {tx.transaction_type === 'PURCHASE' ? 'Data Supplier Vendor' :
                   tx.transaction_type === 'SALE' ? 'Data Tamu / Pelanggan' :
                   tx.transaction_type === 'EXPENSE' ? 'Data Penerima Dana' : 'Pihak Pembayar'}
                </span>
                <div className="flex items-center justify-between">
                  <div className="font-bold text-sm text-slate-900">
                    {tx.party_name || tx.guest_name_snapshot || tx.supplier_name || '-'}
                  </div>
                  {tx.phone && <div className="text-slate-500 font-medium">{tx.phone}</div>}
                </div>
                {tx.supplier_phone && (
                  <div className="text-slate-500">Telepon: {tx.supplier_phone}</div>
                )}
                {tx.source_reference && (
                  <div className="text-slate-600">
                    Referensi / Faktur: <span className="font-mono font-bold">{tx.source_reference}</span>
                  </div>
                )}
                {tx.booking_bid && (
                  <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                    <span className="text-slate-500">Terkait Reservasi BID:</span>
                    <span className="font-mono font-bold text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                      {tx.booking_bid}
                    </span>
                    {tx.reservation_id && onNavigateToReservation && (
                      <button
                        type="button"
                        onClick={() => onNavigateToReservation(Number(tx.reservation_id))}
                        className="text-emerald-700 font-bold hover:underline ml-auto"
                      >
                        Buka Reservasi &rarr;
                      </button>
                    )}
                    {tx.reservation_id && onNavigateToFolio && (
                      <button
                        type="button"
                        onClick={() => onNavigateToFolio(Number(tx.reservation_id))}
                        className="text-slate-700 font-bold hover:underline"
                      >
                        Buka Folio
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Multi-line Items Table if available */}
              {lines.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                      Rincian Item ({lines.length})
                    </span>
                  </div>
                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-bold uppercase text-[10px]">
                        <tr>
                          <th className="py-2.5 px-3">Item / Deskripsi</th>
                          <th className="py-2.5 px-2 text-right">Qty</th>
                          <th className="py-2.5 px-2">Satuan</th>
                          <th className="py-2.5 px-2 text-right">Harga Satuan</th>
                          <th className="py-2.5 px-2 text-right">Diskon</th>
                          <th className="py-2.5 px-3 text-right">Total</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-medium">
                        {lines.map((l) => (
                          <tr key={l.id} className="hover:bg-slate-50/60">
                            <td className="py-2 px-3 font-semibold text-slate-800">{l.description_snapshot}</td>
                            <td className="py-2 px-2 text-right font-mono font-bold">{l.quantity}</td>
                            <td className="py-2 px-2 text-slate-500">{l.unit}</td>
                            <td className="py-2 px-2 text-right font-mono">{formatIdr(l.unit_price)}</td>
                            <td className="py-2 px-2 text-right font-mono text-rose-600">
                              {Number(l.discount_amount) > 0 ? formatIdr(l.discount_amount) : '-'}
                            </td>
                            <td className="py-2 px-3 text-right font-mono font-bold text-slate-900">
                              {formatIdr(l.line_total)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Financial Calculation Summary */}
              <div className="bg-slate-50/80 rounded-2xl p-4 border border-slate-200 space-y-2">
                <div className="flex justify-between text-slate-600">
                  <span>Subtotal / Nilai Bruto:</span>
                  <span className="font-mono font-bold">{formatIdr(tx.amount)}</span>
                </div>
                {Number(tx.discount_amount) > 0 && (
                  <div className="flex justify-between text-rose-600">
                    <span>Diskon Keseluruhan:</span>
                    <span className="font-mono font-bold">- {formatIdr(tx.discount_amount)}</span>
                  </div>
                )}
                {Number(tx.rounding_amount) !== 0 && (
                  <div className="flex justify-between text-slate-600">
                    <span>Pembulatan:</span>
                    <span className="font-mono font-bold">{formatIdr(tx.rounding_amount)}</span>
                  </div>
                )}
                <div className="pt-2 border-t border-slate-200 flex justify-between items-center text-sm font-bold text-slate-900">
                  <span>Total Tagihan / Nilai Net:</span>
                  <span className="text-base text-emerald-800 font-mono">{formatIdr(tx.net_amount)}</span>
                </div>

                <div className="pt-2 border-t border-slate-200/80 grid grid-cols-2 gap-2 text-xs">
                  <div className="p-2 bg-white rounded-xl border border-slate-200">
                    <span className="text-[10px] text-slate-400 font-bold block">Telah Dibayar</span>
                    <span className="font-mono font-bold text-emerald-700">{formatIdr(tx.paid_amount)}</span>
                  </div>
                  <div className="p-2 bg-white rounded-xl border border-slate-200">
                    <span className="text-[10px] text-slate-400 font-bold block">Sisa Tagihan / Hutang</span>
                    <span className={`font-mono font-bold ${outstanding > 0 ? 'text-rose-700' : 'text-slate-700'}`}>
                      {formatIdr(outstanding)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Settlement History & Actions */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                    Riwayat Pembayaran & Pelunasan ({payments.length})
                  </span>
                  {!isPaid && !showSettleForm && (
                    <button
                      type="button"
                      onClick={() => {
                        setSettleAmount(outstanding);
                        setShowSettleForm(true);
                      }}
                      className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white font-bold rounded-xl shadow-xs transition-colors"
                    >
                      + Catat Pelunasan
                    </button>
                  )}
                </div>

                {/* Settle Form */}
                {showSettleForm && (
                  <form onSubmit={handleSettleSubmit} className="p-4 bg-emerald-50/50 border border-emerald-200 rounded-2xl space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-emerald-900 text-xs">Form Pelunasan Pembayaran</span>
                      <button
                        type="button"
                        onClick={() => setShowSettleForm(false)}
                        className="text-xs text-slate-500 hover:text-slate-800"
                      >
                        Tutup
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] font-bold text-slate-700 mb-1">Nominal (Rp)</label>
                        <input
                          type="number"
                          min="1"
                          max={outstanding}
                          step="1"
                          required
                          value={settleAmount}
                          onChange={(e) => setSettleAmount(e.target.value)}
                          className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-lg font-mono font-bold text-xs"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-slate-700 mb-1">Metode Bayar</label>
                        <select
                          value={settleMethod}
                          onChange={(e) => setSettleMethod(e.target.value)}
                          className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-xs"
                        >
                          <option value="CASH">Tunai (Cash)</option>
                          <option value="TRANSFER">Transfer Bank</option>
                          <option value="QRIS">QRIS</option>
                          <option value="EDC">Debit / Kartu Kredit</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] font-bold text-slate-700 mb-1">Catatan / Ref Bank</label>
                      <input
                        type="text"
                        placeholder="Contoh: Transfer via BCA ref #998812"
                        value={settleNotes}
                        onChange={(e) => setSettleNotes(e.target.value)}
                        className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs"
                      />
                    </div>

                    <div className="flex justify-end gap-2 pt-2">
                      <button
                        type="button"
                        onClick={() => setShowSettleForm(false)}
                        className="px-3 py-1 bg-white border border-slate-200 rounded-lg font-semibold text-slate-600"
                      >
                        Batal
                      </button>
                      <button
                        type="submit"
                        disabled={isSettling}
                        className="px-4 py-1 bg-emerald-800 text-white rounded-lg font-bold shadow-xs hover:bg-emerald-900 disabled:opacity-50"
                      >
                        {isSettling ? 'Memproses...' : 'Simpan Pembayaran'}
                      </button>
                    </div>
                  </form>
                )}

                {/* Payments Table */}
                {payments.length === 0 ? (
                  <div className="p-3 text-center text-slate-400 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                    Belum ada riwayat pembayaran yang tercatat
                  </div>
                ) : (
                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-400 uppercase text-[10px]">
                        <tr>
                          <th className="py-2 px-3">Waktu</th>
                          <th className="py-2 px-2">No. Bayar</th>
                          <th className="py-2 px-2">Metode</th>
                          <th className="py-2 px-3 text-right">Nominal</th>
                          <th className="py-2 px-2 text-center">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-medium">
                        {payments.map((p) => (
                          <tr key={p.id} className="hover:bg-slate-50/60">
                            <td className="py-2 px-3 text-slate-500 whitespace-nowrap">
                              {new Date(p.created_at).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })}
                            </td>
                            <td className="py-2 px-2 font-mono font-semibold text-slate-800">{p.reference_code || (p as any).payment_no || '-'}</td>
                            <td className="py-2 px-2 text-slate-700">{p.payment_method}</td>
                            <td className="py-2 px-3 text-right font-mono font-bold text-emerald-800">
                              {formatIdr(p.amount)}
                            </td>
                            <td className="py-2 px-2 text-center">
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                                {p.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Attachments & Upload Section */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                    Lampiran Bukti ({attachments.length})
                  </span>
                  <div className="flex items-center gap-2">
                    <select
                      value={uploadingPurpose}
                      onChange={(e) => setUploadingPurpose(e.target.value as AttachmentPurpose)}
                      className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 text-slate-700"
                    >
                      <option value="RECEIPT">Bukti Nota / Struk</option>
                      <option value="PAYMENT_PROOF">Bukti Bayar / Transfer</option>
                      <option value="INVOICE">Faktur Tagihan</option>
                      <option value="OTHER">Dokumen Lain</option>
                    </select>

                    <label className="px-3 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl cursor-pointer transition-colors border border-slate-200 flex items-center gap-1">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                      </svg>
                      <span>Unggah</span>
                      <input
                        type="file"
                        accept="image/jpeg,image/png,application/pdf"
                        onChange={handleFileUpload}
                        disabled={isUploading}
                        className="hidden"
                      />
                    </label>
                  </div>
                </div>

                {isUploading && (
                  <div className="p-2 text-center text-xs text-slate-500 bg-slate-50 rounded-xl">
                    Sedang mengunggah berkas...
                  </div>
                )}

                {attachments.length === 0 ? (
                  <div className="p-4 text-center text-slate-400 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                    Belum ada bukti lampiran yang diunggah
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {attachments.map((att) => {
                      const isImage = att.mime_type?.startsWith('image/');

                      return (
                        <div key={att.id} className="p-3 bg-white border border-slate-200 rounded-xl space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-700">
                              {att.attachment_purpose || 'BUKTI'}
                            </span>
                            {!isVerified && (
                              <button
                                type="button"
                                onClick={() => handleDeleteAttachment(att.id)}
                                className="text-slate-400 hover:text-rose-600 transition-colors"
                                title="Hapus Bukti"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            )}
                          </div>

                          {isImage ? (
                            <a
                              href={`/api/transactions/${tx.id}/attachments/${att.id}/file`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block aspect-video bg-slate-100 rounded-lg overflow-hidden relative group cursor-pointer"
                            >
                              <img
                                src={`/api/transactions/${tx.id}/attachments/${att.id}/file`}
                                alt={att.original_name}
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                              />
                            </a>
                          ) : (
                            <a
                              href={`/api/transactions/${tx.id}/attachments/${att.id}/file`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="p-3 bg-slate-50 hover:bg-slate-100 rounded-lg flex items-center gap-2 text-slate-700 transition-colors cursor-pointer"
                            >
                              <svg className="w-5 h-5 text-rose-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                              </svg>
                              <span className="truncate font-medium">{att.original_name}</span>
                            </a>
                          )}

                          <div className="text-[10px] text-slate-400 truncate">
                            {att.original_name} • {(att.file_size / 1024).toFixed(1)} KB
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-slate-200 bg-slate-50 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            {tx && tx.transaction_status === 'POSTED' && onOpenVoidModal && (
              <button
                type="button"
                onClick={() => onOpenVoidModal(tx)}
                className="px-3.5 py-2 text-xs font-bold text-rose-700 hover:bg-rose-100 bg-rose-50 border border-rose-200 rounded-xl transition-colors cursor-pointer"
              >
                Batalkan (Void)
              </button>
            )}

            {tx &&
              !tx.deleted_at &&
              ['PURCHASE', 'EXPENSE'].includes(tx.transaction_type) &&
              (!tx.paid_amount || Number(tx.paid_amount) === 0) &&
              tx.verification_status !== 'VERIFIED' &&
              tx.receiving_status !== 'DITERIMA' &&
              tx.receiving_status !== 'DITERIMA_LENGKAP' &&
              !tx.reservation_id &&
              !tx.booking_id &&
              !tx.reversal_of_transaction_id &&
              onOpenSoftDeleteModal && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenSoftDeleteModal(tx);
                  }}
                  className="px-3.5 py-2 text-xs font-bold text-slate-700 hover:bg-slate-200 bg-slate-100 border border-slate-300 rounded-xl transition-colors cursor-pointer"
                >
                  Hapus Draft
                </button>
              )}
          </div>

          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-xl transition-colors cursor-pointer"
          >
            Tutup
          </button>
        </div>
      </div>

      {/* Verify Modal Dialog */}
      {showVerifyModal && (
        <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-sm w-full p-5 shadow-2xl border border-slate-200 space-y-4">
            <h4 className="text-sm font-bold text-slate-900">Ubah Status Verifikasi Audit</h4>
            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-700">Status</label>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setVerifyStatusChoice('VERIFIED')}
                  className={`py-2 text-xs font-bold rounded-xl border ${
                    verifyStatusChoice === 'VERIFIED'
                      ? 'bg-emerald-50 border-emerald-500 text-emerald-800'
                      : 'bg-white border-slate-200 text-slate-600'
                  }`}
                >
                  ✓ Sah
                </button>
                <button
                  type="button"
                  onClick={() => setVerifyStatusChoice('REJECTED')}
                  className={`py-2 text-xs font-bold rounded-xl border ${
                    verifyStatusChoice === 'REJECTED'
                      ? 'bg-rose-50 border-rose-500 text-rose-800'
                      : 'bg-white border-slate-200 text-slate-600'
                  }`}
                >
                  ✕ Tolak
                </button>
                <button
                  type="button"
                  onClick={() => setVerifyStatusChoice('UNVERIFIED')}
                  className={`py-2 text-xs font-bold rounded-xl border ${
                    verifyStatusChoice === 'UNVERIFIED'
                      ? 'bg-amber-50 border-amber-500 text-amber-800'
                      : 'bg-white border-slate-200 text-slate-600'
                  }`}
                >
                  ○ Belum
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Catatan Audit</label>
              <textarea
                rows={2}
                placeholder="Catatan hasil verifikasi bukti..."
                value={verifyNote}
                onChange={(e) => setVerifyNote(e.target.value)}
                className="w-full px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-xl outline-none"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowVerifyModal(false)}
                className="px-3 py-1.5 text-xs font-semibold text-slate-600"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={isVerifying}
                onClick={handleVerifySubmit}
                className="px-4 py-1.5 bg-emerald-800 text-white text-xs font-bold rounded-xl shadow-xs hover:bg-emerald-900 disabled:opacity-50"
              >
                {isVerifying ? 'Menyimpan...' : 'Simpan Status'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
