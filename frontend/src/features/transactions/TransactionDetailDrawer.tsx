import React, { useState, useEffect, useRef } from 'react';
import {
  formatReservationStayType,
  formatTransactionBusinessDate,
  stayTypeBadgeClass,
  getPurchaseReceivingClass,
  isTransactionEditable,
  isTransactionVerificationEditable
} from './transactionDomainTypes';
import type {
  TransactionRecord,
  TransactionAttachment,
  VerificationStatus,
  AttachmentPurpose
} from './transactionDomainTypes';
import {
  fetchTransactionDetailApi,
  uploadTransactionAttachmentApi,
  deleteTransactionAttachmentApi,
  settleTransactionPaymentApi,
  updatePurchaseLifecycleApi,
  updateExpenseLifecycleApi,
  verifyTransactionApi,
} from './transactionClient';
import { useSecureDocumentBlob } from '../common/useSecureDocumentBlob';
import { buildTransactionAttachmentFilePath } from '../common/securePrivateMedia';
import { formatPosOrderDisplayRef } from '../pos/posFormatUtils';

function TransactionAttachmentPreview({
  transactionId,
  propertyId,
  attachment
}: {
  transactionId: number | string;
  propertyId: number;
  attachment: TransactionAttachment;
}) {
  const filePath = buildTransactionAttachmentFilePath(transactionId, attachment.id, propertyId);
  const isImage = attachment.mime_type?.startsWith('image/');
  const { blobUrl, loading, error } = useSecureDocumentBlob(filePath, true);

  const openBlob = () => {
    if (!blobUrl) return;
    window.open(blobUrl, '_blank', 'noopener,noreferrer');
  };

  if (isImage) {
    return (
      <button
        type="button"
        onClick={openBlob}
        disabled={!blobUrl}
        className="block w-full aspect-video bg-slate-100 rounded-lg overflow-hidden relative group cursor-pointer disabled:cursor-default"
      >
        {loading ? (
          <span className="flex items-center justify-center w-full h-full text-[10px] text-slate-400">Memuat...</span>
        ) : error || !blobUrl ? (
          <span className="flex items-center justify-center w-full h-full text-[10px] text-slate-500 text-center px-2">
            Pratinjau tidak tersedia
          </span>
        ) : (
          <img
            src={blobUrl}
            alt={attachment.original_name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform"
          />
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={openBlob}
      disabled={!blobUrl}
      className="w-full p-3 bg-slate-50 hover:bg-slate-100 rounded-lg flex items-center gap-2 text-slate-700 transition-colors cursor-pointer disabled:cursor-default"
    >
      <svg className="w-5 h-5 text-rose-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
      <span className="truncate font-medium">
        {loading ? 'Memuat...' : error || !blobUrl ? 'Berkas tidak tersedia' : attachment.original_name}
      </span>
    </button>
  );
}

interface TransactionDetailDrawerProps {
  isOpen: boolean;
  transactionId: number | string | null;
  propertyId: number;
  currentStaffName?: string;
  currentUserId?: string | null;
  onClose: () => void;
  onOpenVoidModal?: (tx: TransactionRecord) => void;
  onOpenSoftDeleteModal?: (tx: TransactionRecord) => void;
  /** EDIT-1B: Open expense editor in edit mode */
  onEditExpense?: (tx: TransactionRecord) => void;
  /** Open purchase editor in edit mode */
  onEditPurchase?: (tx: TransactionRecord) => void;
  onNavigateToReservation?: (reservationId: number) => void;
  onNavigateToFolio?: (reservationId: number) => void;
  onTransactionUpdated?: () => void;
  onNavigateToInventory?: () => void;
  initialOpenSettle?: boolean;
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
  onEditExpense,
  onEditPurchase,
  onNavigateToReservation,
  onNavigateToFolio,
  onTransactionUpdated,
  onNavigateToInventory,
  initialOpenSettle = false,
}) => {
  const [data, setData] = useState<TransactionRecord | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Settlement Form State
  const [showSettleForm, setShowSettleForm] = useState(false);
  const [settleAmount, setSettleAmount] = useState<number | string>('');
  const [settleMethod, setSettleMethod] = useState<string>('TRANSFER');
  const [settleNotes, setSettleNotes] = useState<string>('');
  const [settleProofFile, setSettleProofFile] = useState<File | null>(null);
  const [isSettling, setIsSettling] = useState(false);

  // Verification Form State
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [verifyStatusChoice, setVerifyStatusChoice] = useState<VerificationStatus>('VERIFIED');
  const [verifyNote, setVerifyNote] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);

  // Workflow Status Form State
  const [isUpdatingWorkflow, setIsUpdatingWorkflow] = useState(false);

  // Approval Status Form State
  const [isUpdatingApproval, setIsUpdatingApproval] = useState(false);

  // Attachment Upload
  const [uploadingPurpose, setUploadingPurpose] = useState<AttachmentPurpose>('RECEIPT');
  const [isUploading, setIsUploading] = useState(false);

  // PURCHASE-2C3: Copy toast for bank account
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const copyToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // PURCHASE-2C3: Cleanup copy toast timer on unmount or drawer close
  useEffect(() => {
    if (!isOpen) {
      if (copyToastTimerRef.current) {
        clearTimeout(copyToastTimerRef.current);
        copyToastTimerRef.current = null;
      }
      setCopyToast(null);
    }

    return () => {
      if (copyToastTimerRef.current) {
        clearTimeout(copyToastTimerRef.current);
        copyToastTimerRef.current = null;
      }
    };
  }, [isOpen]);

  const loadDetail = async () => {
    if (!transactionId) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetchTransactionDetailApi(transactionId, propertyId);
      setData(res);
      if (initialOpenSettle && res.payment_status !== 'PAID') {
        const rem = Number(res.outstanding_amount ?? res.net_amount ?? 0);
        if (rem > 0) {
          setSettleAmount(String(rem));
          setSettleMethod(res.payment_method || 'TRANSFER');
          setShowSettleForm(true);
        }
      }
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
  type LinkedPayment = NonNullable<TransactionRecord['linked_payments']>[number];
  // Detect POS transaction
  const txSourceType = String(tx?.source_type || '').toUpperCase();
  const isPosTx = txSourceType === 'POS_ORDER' || txSourceType === 'POS';

  const formatIdr = (val: number | undefined | string) => {
    if (val === undefined || val === null) return 'Rp 0';
    const num = Number(val) || 0;
    const isNeg = num < 0;
    return (isNeg ? '- Rp ' : 'Rp ') + Math.abs(num).toLocaleString('id-ID');
  };

  // PURCHASE-2C3: Attachment purpose display label
  const formatAttachmentPurpose = (purpose: string | undefined | null): string => {
    const map: Record<string, string> = {
      RECEIPT: 'Bukti Nota / Struk',
      PAYMENT_PROOF: 'Bukti Bayar / Transfer',
      INVOICE: 'Faktur Tagihan',
      OTHER: 'Dokumen Lain',
    };
    return map[purpose ?? ''] || purpose || 'Dokumen Lain';
  };

  // PURCHASE-2C3: Copy bank account with toast
  const handleCopyBankAccount = async (account: string) => {
    try {
      await navigator.clipboard.writeText(account);
      setCopyToast('No. rekening disalin');
      if (copyToastTimerRef.current) clearTimeout(copyToastTimerRef.current);
      copyToastTimerRef.current = setTimeout(() => setCopyToast(null), 2000);
    } catch { /* ignore clipboard failure */ }
  };

  const handleSettleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tx) return;
    if (!canSettle || settleCeiling <= 0) {
      setShowSettleForm(false);
      return;
    }
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
      if (settleProofFile) {
        try {
          await uploadTransactionAttachmentApi(
            tx.id,
            propertyId,
            settleProofFile,
            'PAYMENT_PROOF',
            currentStaffName
          );
        } catch (_e) {
          console.error('Gagal mengunggah bukti pembayaran saat pelunasan:', _e);
        }
      }
      setShowSettleForm(false);
      setSettleAmount('');
      setSettleNotes('');
      setSettleProofFile(null);
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
      // BLOCKER 3 FIX: route through canonical verifyTransaction API for all types.
      // EXPENSE and PURCHASE also accept the expense/lifecycle endpoint, but VERIFIED
      // status must obey the same verification contract (verified_at / verified_by
      // / audit semantics).
      await verifyTransactionApi(tx.id, {
        property_id: propertyId,
        verification_status: verifyStatusChoice,
        verification_note: verifyNote.trim() || undefined,
        actor_user_id: currentUserId || undefined,
        actor_name: currentStaffName,
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

  const handleArchiveToggle = async () => {
    if (!tx || isUpdatingWorkflow || tx.transaction_type !== 'PURCHASE') return;
    const isArchived = Boolean(tx.archived_at) || String(tx.workflow_status || '').toUpperCase() === 'ARCHIVED';
    setIsUpdatingWorkflow(true);
    try {
      await updatePurchaseLifecycleApi(tx.id, {
        property_id: propertyId,
        action: isArchived ? 'UNARCHIVE' : 'ARCHIVE',
        actor_name: currentStaffName,
        actor_user_id: currentUserId || undefined,
      });
      await loadDetail();
      if (onTransactionUpdated) onTransactionUpdated();
    } catch (err: any) {
      alert(err.message || 'Gagal memperbarui status arsip pembelian');
    } finally {
      setIsUpdatingWorkflow(false);
    }
  };

  const handleApprovalChange = async (newApproval: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED') => {
    if (!tx || isUpdatingApproval || (tx.transaction_type !== 'PURCHASE' && tx.transaction_type !== 'EXPENSE')) return;
    let reason: string | null = null;
    if (newApproval === 'REJECTED') {
      const input = window.prompt(
        tx.transaction_type === 'EXPENSE'
          ? 'Masukkan alasan penolakan pengajuan pengeluaran:'
          : 'Masukkan alasan penolakan persetujuan pembelian:'
      );
      if (input === null) return;
      reason = input.trim() || 'Ditolak oleh manajemen';
    }
    setIsUpdatingApproval(true);
    try {
      if (tx.transaction_type === 'EXPENSE') {
        await updateExpenseLifecycleApi(tx.id, {
          property_id: propertyId,
          action: 'SET_APPROVAL',
          approval_status: newApproval,
          reason,
          actor_name: currentStaffName,
          actor_user_id: currentUserId || undefined
        });
      } else {
        await updatePurchaseLifecycleApi(tx.id, {
          property_id: propertyId,
          action: 'SET_APPROVAL',
          approval_status: newApproval,
          reason,
          actor_name: currentStaffName,
          actor_user_id: currentUserId || undefined
        });
      }
      await loadDetail();
      if (onTransactionUpdated) onTransactionUpdated();
    } catch (err: any) {
      alert(err.message || 'Gagal memperbarui status persetujuan');
    } finally {
      setIsUpdatingApproval(false);
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
  // UI-3: Canonical OTA collectible balance
  const hotelCollectibleTotal = Number(tx?.hotel_collectible_total || 0);
  const hotelCollectibleRemaining = Number(tx?.hotel_collectible_remaining_balance || 0);
  const canonicalAmountPaid = Number(tx?.canonical_amount_paid || 0);
  const canonicalAppliedDeposit = Number(tx?.canonical_applied_deposit || 0);
  const isReservationLinked = tx?.reservation_id != null && Number(tx.reservation_id) > 0;
  // UI-3: Derive display status from canonical fields for reservation-linked transactions.
  // Non-reservation falls back to legacy tx.payment_status.
  const displayPaymentStatus = isReservationLinked
    ? hotelCollectibleRemaining > 0
      ? (canonicalAmountPaid > 0 ? 'PARTIALLY_PAID' : 'UNPAID')
      : 'PAID'
    : (tx?.payment_status || 'UNPAID');
  // Can settle when reservation-linked with remaining collectible, or non-reservation with outstanding.
  // Use canonical displayPaymentStatus (not legacy tx.payment_status) so OTA_COLLECT rooms
  // with hotelCollectibleRemaining=0 don't get blocked from UI by an old UNPAID status.
  const isApprovedForSettlement =
    tx?.transaction_type === 'EXPENSE' || tx?.transaction_type === 'PURCHASE'
      ? String(tx?.approval_status || 'APPROVED').toUpperCase() === 'APPROVED'
      : true;
  const canSettle = displayPaymentStatus !== 'PAID' && !isSettling && isApprovedForSettlement
    ? (isReservationLinked ? hotelCollectibleRemaining > 0 : outstanding > 0)
    : false;
  // For OTA_COLLECT and HOTEL_COLLECT reservations, settlement ceiling is canonical remaining.
  const settleCeiling = isReservationLinked
    ? hotelCollectibleRemaining > 0 ? hotelCollectibleRemaining : 0
    : outstanding;

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
                  {tx ? (isPosTx ? (formatPosOrderDisplayRef(tx.source_id) || tx.transaction_no) : tx.transaction_no) : 'Detail Transaksi'}
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
                {tx ? `${formatTransactionBusinessDate(tx.transaction_date)} • Dibuat oleh: ${tx.created_by || 'Staff'}` : 'Memuat data transaksi...'}
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
                    displayPaymentStatus === 'PAID' ? 'text-emerald-700' : 'text-amber-700'
                  }`}>
                    {displayPaymentStatus}
                  </span>
                </div>

                <div>
                  <span className="text-[10px] text-slate-400 font-bold uppercase block">Pemeriksaan</span>
                  <div className="flex items-center gap-1.5 mt-1">
                  <span className={`text-xs font-bold ${
                    tx.verification_status === 'VERIFIED' ? 'text-emerald-700' :
                    tx.verification_status === 'REJECTED' ? 'text-rose-700' : 'text-amber-700'
                  }`}>
                    {tx.verification_status === 'VERIFIED' ? 'Terverifikasi' :
                     tx.verification_status === 'REJECTED' ? 'Perlu Koreksi' : 'Belum Diperiksa'}
                  </span>
                    <button
                      type="button"
                      onClick={() => setShowVerifyModal(true)}
                      disabled={!isTransactionVerificationEditable(tx)}
                      className="text-[10px] text-slate-600 underline hover:text-emerald-800 font-semibold cursor-pointer ml-1 disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"
                    >
                      Ubah
                    </button>
                  </div>
                </div>

                {tx.transaction_type === 'EXPENSE' && (
                  <div>
                    <span className="text-[10px] text-slate-400 font-bold uppercase block">Persetujuan Pengajuan</span>
                    {(() => {
                      const appStatus = tx.approval_status || (tx.payment_status === 'PAID' ? 'APPROVED' : 'PENDING_APPROVAL');
                      const appClass =
                        appStatus === 'APPROVED'
                          ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                          : appStatus === 'REJECTED'
                          ? 'bg-rose-50 border-rose-200 text-rose-800'
                          : 'bg-amber-50 border-amber-200 text-amber-800';
                      return (
                        <div className="flex items-center gap-1.5 mt-1">
                          <select
                            value={appStatus}
                            onChange={(e) => handleApprovalChange(e.target.value as 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED')}
                            disabled={isUpdatingApproval || tx.payment_status === 'PAID'}
                            className={`text-xs font-bold rounded-lg px-2 py-0.5 outline-none cursor-pointer border ${appClass} disabled:opacity-60`}
                          >
                            <option value="PENDING_APPROVAL">Menunggu</option>
                            <option value="APPROVED">Disetujui</option>
                            <option value="REJECTED">Ditolak</option>
                          </select>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {tx.transaction_type === 'PURCHASE' && (
                  <>
                    <div>
                      <span className="text-[10px] text-slate-400 font-bold uppercase block">Otorisasi PO</span>
                      {tx.po_id ? (
                        <div className="mt-1 flex flex-col gap-0.5">
                          <span className="inline-flex items-center text-xs font-bold px-2 py-0.5 rounded-lg border bg-emerald-50 border-emerald-200 text-emerald-800 w-fit">
                            Disetujui via PO
                          </span>
                          <span className="text-[10px] font-mono font-bold text-slate-600">
                            {tx.po_number || `PO #${tx.po_id}`}
                          </span>
                        </div>
                      ) : (() => {
                        const appStatus = tx.approval_status || 'PENDING_APPROVAL';
                        const appClass =
                          appStatus === 'APPROVED'
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                            : appStatus === 'REJECTED'
                            ? 'bg-rose-50 border-rose-200 text-rose-800'
                            : 'bg-amber-50 border-amber-200 text-amber-800';
                        return (
                          <div className="flex items-center gap-1.5 mt-1">
                            <select
                              value={appStatus}
                              onChange={(e) => handleApprovalChange(e.target.value as 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED')}
                              disabled={isUpdatingApproval || tx.transaction_status !== 'POSTED'}
                              className={`text-xs font-bold rounded-lg px-2 py-0.5 outline-none cursor-pointer border ${appClass} disabled:opacity-60`}
                            >
                              <option value="PENDING_APPROVAL">Menunggu</option>
                              <option value="APPROVED">Disetujui</option>
                              <option value="REJECTED">Ditolak</option>
                            </select>
                          </div>
                        );
                      })()}
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-400 font-bold uppercase block">Penerimaan Barang</span>
                      {(() => {
                        const recvStatus = tx.receiving_status || 'BELUM_DITERIMA';
                        const isFullReceived = recvStatus === 'DITERIMA' || recvStatus === 'DITERIMA_LENGKAP';
                        const rc = getPurchaseReceivingClass(recvStatus);
                        const label = isFullReceived
                          ? 'Diterima Lengkap'
                          : recvStatus === 'DITERIMA_SEBAGIAN'
                          ? 'Diterima Sebagian'
                          : 'Belum Diterima';
                        return (
                          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                            <span
                              className={`inline-flex items-center text-xs font-bold rounded-lg px-2.5 py-0.5 border ${rc.bg} ${rc.border} ${rc.text}`}
                              title="Status penerimaan barang stok mengikuti dokumen Penerimaan Barang (GRN) yang di-Post"
                            >
                              {label}
                            </span>
                            {tx.approval_status === 'APPROVED' && !isFullReceived && (
                              <button
                                type="button"
                                onClick={() => {
                                  try {
                                    sessionStorage.setItem('oak_hims_pending_grn_purchase_tx_id', String(tx.id));
                                  } catch { /* ignore */ }
                                  onClose();
                                  if (onNavigateToInventory) onNavigateToInventory();
                                }}
                                className="px-2 py-0.5 text-[10px] font-bold bg-emerald-700 hover:bg-emerald-800 text-white rounded-md transition-colors cursor-pointer"
                              >
                                Terima Barang
                              </button>
                            )}
                            {isFullReceived && (
                              <button
                                type="button"
                                onClick={() => {
                                  try {
                                    sessionStorage.setItem(
                                      'oak_hims_pending_grn_search',
                                      String(tx.po_number || tx.transaction_no || '')
                                    );
                                  } catch { /* ignore */ }
                                  onClose();
                                  if (onNavigateToInventory) onNavigateToInventory();
                                }}
                                className="px-2 py-0.5 text-[10px] font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded-md transition-colors cursor-pointer"
                              >
                                Lihat Penerimaan
                              </button>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-400 font-bold uppercase block">Arsip Dokumen</span>
                      {(() => {
                        const isArchived = Boolean(tx.archived_at) || String(tx.workflow_status || '').toUpperCase() === 'ARCHIVED';
                        return (
                          <div className="flex items-center gap-1.5 mt-1">
                            <span className={`inline-flex items-center text-[11px] font-bold px-2 py-0.5 rounded-md border ${
                              isArchived ? 'bg-slate-200 text-slate-700 border-slate-300' : 'bg-white text-slate-700 border-slate-200'
                            }`}>
                              {isArchived ? 'Diarsipkan' : 'Aktif'}
                            </span>
                            {tx.transaction_status === 'POSTED' && (
                              <button
                                type="button"
                                disabled={isUpdatingWorkflow}
                                onClick={() => void handleArchiveToggle()}
                                className="text-[10px] font-bold text-slate-600 hover:text-emerald-800 underline cursor-pointer disabled:opacity-50"
                                title="Tindakan administratif penyimpanan arsip (bukan pembatalan, pelunasan, atau penerimaan)"
                              >
                                {isArchived ? 'Buka Arsip' : 'Arsipkan'}
                              </button>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </>
                )}
              </div>

              {/* Verification Details if verified */}
              {tx.verification_status && tx.verification_status !== 'UNVERIFIED' && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-1">
                  <div className="text-[11px] font-bold text-slate-800 flex items-center justify-between">
                    <span>Pemeriksaan Tagihan oleh: {tx.verified_by_name_snapshot || 'Auditor'}</span>
                    <span className="text-slate-400 font-normal">
                      {tx.verified_at ? new Date(tx.verified_at).toLocaleString('id-ID') : ''}
                    </span>
                  </div>
                  {tx.verification_note && (
                    <div className="text-[11px] text-slate-600 italic">"{tx.verification_note}"</div>
                  )}
                </div>
              )}

              {/* Tahap 1A: PO Variance Alert & Linked Goods Receipts */}
              {tx.transaction_type === 'PURCHASE' && tx.has_po_variance && (
                <div className="p-3.5 bg-amber-50 border border-amber-300 rounded-xl space-y-1.5 text-amber-900">
                  <div className="text-xs font-bold flex items-center gap-1.5">
                    <span>⚠</span>
                    <span>Selisih terhadap PO Terdeteksi ({tx.po_number || `PO #${tx.po_id}`})</span>
                  </div>
                  {typeof tx.po_variance_summary === 'string' && tx.po_variance_summary.trim() !== '' ? (
                    <div className="text-[11px] text-amber-800">{tx.po_variance_summary}</div>
                  ) : tx.po_variance_summary &&
                    typeof tx.po_variance_summary === 'object' &&
                    Array.isArray((tx.po_variance_summary as any).variances) &&
                    (tx.po_variance_summary as any).variances.length > 0 ? (
                    <ul className="text-[11px] text-amber-800 list-disc pl-4 space-y-0.5">
                      {(tx.po_variance_summary as any).variances.map((v: any, idx: number) => (
                        <li key={idx}>
                          {v.type === 'LINE_VARIANCE' ? (
                            <>
                              <strong>{v.description || `Baris #${v.line_index}`}</strong>:{' '}
                              {Number(v.po_unit_price) !== Number(v.invoice_unit_price) && (
                                <span>
                                  Harga PO {formatIdr(Number(v.po_unit_price || 0))} &rarr; Nota{' '}
                                  {formatIdr(Number(v.invoice_unit_price || 0))}
                                  {Number(v.po_qty) !== Number(v.invoice_qty) ? ' • ' : ''}
                                </span>
                              )}
                              {Number(v.po_qty) !== Number(v.invoice_qty) && (
                                <span>
                                  Qty PO {v.po_qty} &rarr; Nota {v.invoice_qty}
                                </span>
                              )}
                            </>
                          ) : (
                            <span>{v.message || v.description || 'Selisih baris tagihan terhadap PO'}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="text-[11px] text-amber-800">
                      Terdapat perbedaan harga satuan atau kuantitas antara PO dan Nota tagihan aktual.
                    </div>
                  )}
                </div>
              )}

              {tx.transaction_type === 'PURCHASE' && tx.linked_goods_receipts && tx.linked_goods_receipts.length > 0 && (
                <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                      Dokumen Penerimaan Barang (GRN Terkait: {tx.linked_goods_receipts.length})
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        try {
                          sessionStorage.setItem(
                            'oak_hims_pending_grn_search',
                            String(tx.po_number || tx.transaction_no || '')
                          );
                        } catch { /* ignore */ }
                        onClose();
                        if (onNavigateToInventory) onNavigateToInventory();
                      }}
                      className="text-[11px] font-bold text-emerald-700 hover:underline cursor-pointer"
                    >
                      Lihat Penerimaan di Inventori &rarr;
                    </button>
                  </div>
                  <div className="border border-slate-200 rounded-lg overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-bold uppercase text-[10px]">
                        <tr>
                          <th className="py-2 px-3">No. GRN</th>
                          <th className="py-2 px-2">Tanggal</th>
                          <th className="py-2 px-2">Status</th>
                          <th className="py-2 px-3 text-right">Petugas</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {tx.linked_goods_receipts.map((grn) => (
                          <tr key={grn.id} className="hover:bg-slate-50/60">
                            <td className="py-2 px-3 font-mono font-bold text-[#1b4332]">{grn.grn_number}</td>
                            <td className="py-2 px-2 text-slate-600">{formatTransactionBusinessDate(grn.receipt_date)}</td>
                            <td className="py-2 px-2">
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                                grn.status === 'POSTED' || grn.status === 'COMPLETED'
                                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                  : grn.status === 'DRAFT'
                                  ? 'bg-amber-50 text-amber-800 border-amber-200'
                                  : 'bg-rose-50 text-rose-700 border-rose-200'
                              }`}>
                                {grn.status === 'POSTED' || grn.status === 'COMPLETED' ? 'Diposting' : grn.status}
                              </span>
                            </td>
                            <td className="py-2 px-3 text-right text-slate-600">{grn.received_by || grn.posted_by || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
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
                {(tx.source_reference || (isPosTx && tx.source_id)) && (
                  <div className="text-slate-600">
                    {isPosTx ? 'Nomor Order POS:' : 'Referensi / Faktur:'}{' '}
                    <span className="font-mono font-bold">
                      {isPosTx ? (formatPosOrderDisplayRef(tx.source_id) || tx.source_reference) : tx.source_reference}
                    </span>
                  </div>
                )}
                {/* PURCHASE-2C3: Supplier Bank Information */}
                {(tx.supplier_bank_name || tx.supplier_bank_account || tx.supplier_bank_holder) && (
                  <div className="pt-2 border-t border-slate-100 space-y-1">
                    {tx.supplier_bank_name && (
                      <div>
                        <span className="text-slate-500 text-[11px]">Bank: </span>
                        <span className="text-slate-800 font-semibold text-xs">{tx.supplier_bank_name}</span>
                      </div>
                    )}
                    {tx.supplier_bank_account && (
                      <div className="flex items-center gap-2">
                        <span className="text-slate-500 text-[11px]">No. Rekening: </span>
                        <span className="font-mono font-bold text-xs text-slate-900">{tx.supplier_bank_account}</span>
                        <button
                          type="button"
                          onClick={() => handleCopyBankAccount(tx.supplier_bank_account!)}
                          className="ml-auto text-[10px] text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 rounded px-1.5 py-0.5 transition-colors cursor-pointer font-medium"
                          title="Salin no. rekening"
                        >
                          Salin
                        </button>
                      </div>
                    )}
                    {tx.supplier_bank_holder && (
                      <div>
                        <span className="text-slate-500 text-[11px]">Atas Nama: </span>
                        <span className="text-slate-700 text-xs">{tx.supplier_bank_holder}</span>
                      </div>
                    )}
                  </div>
                )}
                {/* EXPENSE-1D: Recipient Bank Snapshot (manual, not from Supplier Master) */}
                {tx.transaction_type === 'EXPENSE' && (tx.recipient_bank_name || tx.recipient_bank_account || tx.recipient_bank_holder) && (
                  <div className="pt-2 border-t border-slate-100 space-y-1">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">Data Rekening Penerima Dana</span>
                    {tx.recipient_bank_name && (
                      <div>
                        <span className="text-slate-500 text-[11px]">Bank: </span>
                        <span className="text-slate-800 font-semibold text-xs">{tx.recipient_bank_name}</span>
                      </div>
                    )}
                    {tx.recipient_bank_account && (
                      <div className="flex items-center gap-2">
                        <span className="text-slate-500 text-[11px]">No. Rekening: </span>
                        <span className="font-mono font-bold text-xs text-slate-900">{tx.recipient_bank_account}</span>
                        <button
                          type="button"
                          onClick={() => handleCopyBankAccount(tx.recipient_bank_account!)}
                          className="ml-auto text-[10px] text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 rounded px-1.5 py-0.5 transition-colors cursor-pointer font-medium"
                          title="Salin no. rekening"
                        >
                          Salin
                        </button>
                      </div>
                    )}
                    {tx.recipient_bank_holder && (
                      <div>
                        <span className="text-slate-500 text-[11px]">Atas Nama: </span>
                        <span className="text-slate-700 text-xs">{tx.recipient_bank_holder}</span>
                      </div>
                    )}
                  </div>
                )}
                {tx.booking_bid && (
                  <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                    <span className="text-slate-500">Terkait Reservasi BID:</span>
                    <span className="font-mono font-bold text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                      {tx.booking_bid}
                    </span>
                    {tx.ota_source_name && (
                      <span className="text-xs font-semibold bg-sky-100 text-sky-800 px-2 py-0.5 rounded-md border border-sky-200">
                        OTA — {tx.ota_source_name}
                      </span>
                    )}
                    {tx.booking_channel && tx.booking_channel !== 'WALK_IN' && (
                      <span className="text-xs text-slate-500">Channel: {tx.booking_channel}</span>
                    )}
                    {formatReservationStayType(tx.stay_type) !== '-' && (
                      <span className="inline-flex items-center gap-1 text-slate-500">
                        <span>Tipe Stay:</span>
                        <span className={`inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded border ${stayTypeBadgeClass(tx.stay_type)}`}>
                          {formatReservationStayType(tx.stay_type)}
                        </span>
                      </span>
                    )}
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

              {tx.lifecycle && tx.lifecycle.member_count > 1 && (
                <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                      Riwayat Siklus Transaksi
                    </span>
                    <span className="text-[10px] font-semibold text-slate-500">
                      {tx.lifecycle.member_count} baris audit
                    </span>
                  </div>
                  <div className="border border-slate-200 rounded-lg overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-bold uppercase text-[10px]">
                        <tr>
                          <th className="py-2 px-3">Peran</th>
                          <th className="py-2 px-3">Nomor</th>
                          <th className="py-2 px-3 text-right">Nominal</th>
                          <th className="py-2 px-3 text-right">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {tx.lifecycle.members.map((member) => (
                          <tr key={member.id} className="hover:bg-slate-50/60">
                            <td className="py-2 px-3 font-semibold text-slate-800">{member.role}</td>
                            <td className="py-2 px-3 font-mono text-slate-600">{member.transaction_no || `#${member.id}`}</td>
                            <td className="py-2 px-3 text-right font-mono font-bold text-slate-800">
                              {formatIdr(member.net_amount)}
                            </td>
                            <td className="py-2 px-3 text-right font-bold text-slate-600">
                              {member.transaction_status}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex justify-between items-center pt-1 text-sm font-bold text-slate-900">
                    <span>Effective Net</span>
                    <span className="font-mono text-emerald-800">{formatIdr(tx.lifecycle.effective_net_amount)}</span>
                  </div>
                </div>
              )}

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
                            <td className="py-2 px-3 font-semibold text-slate-800">
                              <div>{l.description_snapshot}</div>
                              {l.product_id && (
                                <div className="flex items-center gap-1.5 mt-0.5">
                                  <span className="text-[10px] font-mono bg-emerald-50 text-emerald-800 border border-emerald-200 px-1.5 py-0.2 rounded">
                                    Produk #{l.product_id}
                                  </span>
                                  {Number(l.received_quantity || 0) > 0 && (
                                    <span className="text-[10px] font-mono bg-sky-50 text-sky-800 border border-sky-200 px-1.5 py-0.2 rounded">
                                      Diterima: {Number(l.received_quantity)}
                                    </span>
                                  )}
                                </div>
                              )}
                            </td>
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

              {isPosTx && Array.isArray(tx.pos_order_items) && tx.pos_order_items.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                      Informasi Pembelian Produk POS ({tx.pos_order_items.length})
                    </span>
                  </div>
                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-bold uppercase text-[10px]">
                        <tr>
                          <th className="py-2.5 px-3">Kode</th>
                          <th className="py-2.5 px-3">Nama Produk / Menu</th>
                          <th className="py-2.5 px-2 text-center">Qty</th>
                          <th className="py-2.5 px-2 text-right">Harga Satuan</th>
                          <th className="py-2.5 px-2 text-right">Diskon</th>
                          <th className="py-2.5 px-3 text-right">Subtotal</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-medium">
                        {tx.pos_order_items.map((pi) => {
                          const qty = Number(pi.quantity || 0);
                          const unitPrice = Number(pi.unit_price || 0);
                          const disc = Number(pi.discount_amount || 0);
                          const lineTotal = Math.max(0, qty * unitPrice - disc);
                          return (
                            <tr key={pi.id} className="hover:bg-slate-50/60">
                              <td className="py-2 px-3 font-mono text-slate-500">{pi.item_code || '-'}</td>
                              <td className="py-2 px-3 font-semibold text-slate-800">
                                <div>{pi.item_name}</div>
                                {pi.notes && <div className="text-[10px] font-normal text-slate-400">Catatan: {pi.notes}</div>}
                              </td>
                              <td className="py-2 px-2 text-center font-mono font-bold">{qty}</td>
                              <td className="py-2 px-2 text-right font-mono">{formatIdr(unitPrice)}</td>
                              <td className="py-2 px-2 text-right font-mono text-rose-600">
                                {disc > 0 ? formatIdr(disc) : '-'}
                              </td>
                              <td className="py-2 px-3 text-right font-mono font-bold text-slate-900">
                                {formatIdr(lineTotal)}
                              </td>
                            </tr>
                          );
                        })}
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
                  <span>{isReservationLinked ? 'Nilai Penjualan / Net:' : 'Total Tagihan / Nilai Net:'}</span>
                  <span className="text-base text-emerald-800 font-mono">{formatIdr(tx.net_amount)}</span>
                </div>

                 <div className="pt-2 border-t border-slate-200/80 grid grid-cols-2 gap-2 text-xs">
                   {isPosTx ? (
                     <>
                       <div className="p-2 bg-white rounded-xl border border-slate-200">
                         <span className="text-[10px] text-slate-400 font-bold block">Telah Dibayar (POS)</span>
                         <span className="font-mono font-bold text-emerald-700">{formatIdr(tx.paid_amount)}</span>
                       </div>
                       <div className={`p-2 rounded-xl border ${outstanding > 0 ? 'bg-rose-50 border-rose-200' : 'bg-emerald-50 border-emerald-200'}`}>
                         <span className="text-[10px] font-bold block">Sisa Tagihan (POS)</span>
                         <span className={`font-mono font-bold ${outstanding > 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                           {formatIdr(outstanding)}
                         </span>
                       </div>
                     </>
                   ) : !isReservationLinked ? (
                     <>
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
                     </>
                   ) : (
                     <>
                       <div className="p-2 bg-amber-50 rounded-xl border border-amber-200">
                         <span className="text-[10px] text-amber-600 font-bold block">Ditagih Hotel</span>
                         <span className="font-mono font-bold text-amber-700">{formatIdr(hotelCollectibleTotal)}</span>
                       </div>
                       <div className="p-2 bg-amber-50 rounded-xl border border-amber-200">
                         <span className="text-[10px] text-amber-600 font-bold block">Dibayar ke Hotel</span>
                         <span className="font-mono font-bold text-amber-700">{formatIdr(canonicalAmountPaid)}</span>
                       </div>
                       <div className="p-2 bg-amber-50 rounded-xl border border-amber-200">
                         <span className="text-[10px] text-amber-600 font-bold block">Deposit Digunakan</span>
                         <span className="font-mono font-bold text-amber-700">{formatIdr(canonicalAppliedDeposit)}</span>
                       </div>
                       <div className={`p-2 rounded-xl border ${hotelCollectibleRemaining > 0 ? 'bg-rose-50 border-rose-200' : 'bg-emerald-50 border-emerald-200'}`}>
                         <span className="text-[10px] font-bold block">Sisa Tagihan Hotel</span>
                         <span className={`font-mono font-bold ${hotelCollectibleRemaining > 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                           {formatIdr(hotelCollectibleRemaining)}
                         </span>
                       </div>
                     </>
                   )}
                 </div>
              </div>

              {/* Settlement History & Actions */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                    {isPosTx
                      ? `Pembayaran POS (${payments.length})`
                      : `Pembayaran Sebelumnya (${payments.length})`}
                  </span>
                  {!showSettleForm && canSettle && !isPosTx && (
                    <button
                      type="button"
                      onClick={() => {
                        setSettleAmount(canSettle ? String(settleCeiling) : '0');
                        setShowSettleForm(true);
                      }}
                      className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white font-bold rounded-xl shadow-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      disabled={!canSettle}
                    >
                      + Catat Pelunasan
                    </button>
                  )}
                </div>

                {/* Settle Form */}
                {showSettleForm && canSettle && !isPosTx && (
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
                          max={settleCeiling}
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

                    <div>
                      <label className="block text-[11px] font-bold text-slate-700 mb-1">Upload Bukti Pembayaran / Transfer (Opsional)</label>
                      <input
                        type="file"
                        accept="image/jpeg,image/png,application/pdf"
                        onChange={(e) => setSettleProofFile(e.target.files?.[0] || null)}
                        className="w-full text-xs text-slate-600 file:mr-2.5 file:py-1 file:px-2.5 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-emerald-100 file:text-emerald-800 hover:file:bg-emerald-200 cursor-pointer"
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
                    {isPosTx ? 'Belum ada pembayaran POS yang tercatat' : 'Belum ada riwayat pembayaran yang tercatat'}
                  </div>
                ) : (
                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-400 uppercase text-[10px]">
                        <tr>
                          <th className="py-2 px-3">Waktu</th>
                          {isPosTx ? (
                            <>
                              <th className="py-2 px-2">Referensi</th>
                              <th className="py-2 px-2">Sumber</th>
                            </>
                          ) : (
                            <th className="py-2 px-2">No. Bayar</th>
                          )}
                          <th className="py-2 px-2">Metode</th>
                          <th className="py-2 px-3 text-right">Nominal</th>
                          <th className="py-2 px-2 text-center">Status</th>
                          <th className="py-2 px-2 text-right">Pencatat</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-medium">
                        {payments.map((p: LinkedPayment) => (
                          <tr key={p.id} className="hover:bg-slate-50/60">
                            <td className="py-2 px-3 text-slate-500 whitespace-nowrap">
                              {p.created_at ? new Date(p.created_at).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' }) : '-'}
                            </td>
                            {isPosTx ? (
                              <>
                                <td className="py-2 px-2 font-mono text-slate-600">
                                  {p.source === 'POS_SETTLEMENT'
                                    ? `PS-${p.settlement_id ?? p.id}`
                                    : p.source === 'PAYMENT_TRANSACTION'
                                      ? `PT-${p.payment_id ?? p.id}`
                                      : String(p.id)}
                                </td>
                                <td className="py-2 px-2">
                                  {p.source === 'POS_SETTLEMENT' ? (
                                    <span className="text-[10px] font-bold text-indigo-700 bg-indigo-50 px-1.5 py-0.5 rounded border border-indigo-200">
                                      Pembayaran POS
                                    </span>
                                  ) : p.source === 'PAYMENT_TRANSACTION' ? (
                                    <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200">
                                      Pembayaran Sebelumnya
                                    </span>
                                  ) : (
                                    <span className="text-[10px] text-slate-500">-</span>
                                  )}
                                </td>
                              </>
                            ) : (
                              <td className="py-2 px-2 font-mono text-slate-600">
                                {p.reference_code || p.payment_no || '-'}
                              </td>
                            )}
                            <td className="py-2 px-2 text-slate-700">{p.payment_method}</td>
                            <td className="py-2 px-3 text-right font-mono font-bold text-emerald-800">
                              {formatIdr(p.amount)}
                            </td>
                            <td className="py-2 px-2 text-center">
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                                {p.status}
                              </span>
                            </td>
                            <td className="py-2 px-2 text-right text-slate-500">
                              {p.created_by || '-'}
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
                    {attachments.map((att) => (
                        <div key={att.id} className="p-3 bg-white border border-slate-200 rounded-xl space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-700">
                              {formatAttachmentPurpose(att.attachment_purpose)}
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

                          <TransactionAttachmentPreview
                            transactionId={tx.id}
                            propertyId={propertyId}
                            attachment={att}
                          />

                          <div className="text-[10px] text-slate-400 truncate">
                            {att.original_name} • {(att.file_size / 1024).toFixed(1)} KB
                          </div>
                        </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>

        {/* PURCHASE-2C3: Copy success toast */}
        {copyToast && (
          <div
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg shadow-lg animate-in fade-in zoom-in-95 duration-150"
            role="status"
            aria-live="polite"
          >
            {copyToast}
          </div>
        )}

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

            {/* EDIT-1B: Edit/Revisi button for EXPENSE when editable */}
            {tx &&
              tx.transaction_type === 'EXPENSE' &&
              isTransactionEditable(tx) &&
              onEditExpense && (
                <button
                  type="button"
                  onClick={() => onEditExpense(tx)}
                  className="px-3.5 py-2 text-xs font-bold text-emerald-700 hover:bg-emerald-100 bg-emerald-50 border border-emerald-200 rounded-xl transition-colors cursor-pointer"
                >
                  Edit/Revisi
                </button>
              )}

            {/* Edit/Revisi button for PURCHASE when editable */}
            {tx &&
              tx.transaction_type === 'PURCHASE' &&
              isTransactionEditable(tx) &&
              onEditPurchase && (
                <button
                  type="button"
                  onClick={() => onEditPurchase(tx)}
                  className="px-3.5 py-2 text-xs font-bold text-emerald-700 hover:bg-emerald-100 bg-emerald-50 border border-emerald-200 rounded-xl transition-colors cursor-pointer"
                >
                  Edit/Revisi
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
            <h4 className="text-sm font-bold text-slate-900">Ubah Status Pemeriksaan</h4>
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
                  Terverifikasi
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
                  Perlu Koreksi
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
                  Belum Diperiksa
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
