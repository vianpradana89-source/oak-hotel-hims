import React, { useState, useEffect, useCallback } from 'react';
import { safeFetchJson } from './calendarApi';
import { EditReservationModal } from './EditReservationModal';
import { AddStayChargeModal } from './AddStayChargeModal';
import { MaintenanceIssuesModal } from '../housekeeping/MaintenanceIssuesModal';
import IdentityExtractionModal, { type ExtractedIdentityData } from '../booking/IdentityExtractionModal';
import { useSecureDocumentBlob } from '../common/useSecureDocumentBlob';
import { useAuth } from '../auth/AuthContext';
import DepositGuaranteeSection from '../deposits/DepositGuaranteeSection';

interface Props {
  reservation: any;
  propertyId?: number | null;
  onClose: () => void;
  onRefresh: () => void;
  onCheckin: (reservationId: number) => void;
  onCheckout: (reservationId: number) => void;
  onCancel: (reservationId: number) => void;
  onRequestCheckoutInspection?: (reservationId: number) => void;
  onToggleRoomStatus?: (roomId: string) => void;
  onOpenStayChange?: (reservation: any, mode?: 'extend' | 'shorten') => void;
  roomStatuses?: Record<string, string>;
  propertyFeatures?: Record<string, any>;
}

export default function ReservationDetailDrawer({
  reservation,
  propertyId,
  onClose,
  onRefresh,
  onCheckin,
  onCheckout,
  onCancel,
  onOpenStayChange,
}: Props) {
  const [detailData, setDetailData] = useState<any>(reservation);
  const [loading, setLoading] = useState<boolean>(false);
  const [folioData, setFolioData] = useState<any>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState<boolean>(false);
  const [isAddChargeModalOpen, setIsAddChargeModalOpen] = useState<boolean>(false);
  const [activeRoomFindings, setActiveRoomFindings] = useState<any[]>([]);
  const [isResolveModalOpen, setIsResolveModalOpen] = useState<boolean>(false);
  const [paymentDraft, setPaymentDraft] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'TRANSFER' | 'QRIS' | 'DEBIT_CARD' | 'CREDIT_CARD'>('CASH');
  const [paymentEvidenceFile, setPaymentEvidenceFile] = useState<File | null>(null);
  const [paymentSubmitting, setPaymentSubmitting] = useState<boolean>(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [bidCopied, setBidCopied] = useState(false);
  const [requestingInspection, setRequestingInspection] = useState<boolean>(false);
  const [inspectionMsg, setInspectionMsg] = useState<string | null>(null);

  // Guest Phone & Identity/KTP Management States
  const [isIdentityModalOpen, setIsIdentityModalOpen] = useState<boolean>(false);
  const [isEditingPhone, setIsEditingPhone] = useState<boolean>(false);
  const [phoneDraft, setPhoneDraft] = useState<string>('');
  const [savingPhone, setSavingPhone] = useState<boolean>(false);
  const [isKtpPreviewOpen, setIsKtpPreviewOpen] = useState<boolean>(false);
  const [isPaymentEvidencePreviewOpen, setIsPaymentEvidencePreviewOpen] = useState<boolean>(false);
  const { authFetch } = useAuth();

  // Secure temporary Blob Object URLs for in-app preview (Zero credentials in query string/history)
  const currentRes = detailData || reservation;
  const { blobUrl: ktpBlobUrl, loading: ktpLoading, error: ktpError } = useSecureDocumentBlob(currentRes?.ktp_path, isKtpPreviewOpen);
  const { blobUrl: paymentEvidenceBlobUrl, loading: paymentEvidenceLoading, error: paymentEvidenceError } = useSecureDocumentBlob(currentRes?.bukti_bayar_path, isPaymentEvidencePreviewOpen);

  // Keyboard Escape listener for document preview modals
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isKtpPreviewOpen) setIsKtpPreviewOpen(false);
        if (isPaymentEvidencePreviewOpen) setIsPaymentEvidencePreviewOpen(false);
      }
    };
    if (isKtpPreviewOpen || isPaymentEvidencePreviewOpen) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isKtpPreviewOpen, isPaymentEvidencePreviewOpen]);

  // Strict property resolution: active property context OR canonical reservation.property_id
  const activePropId: number | null = (propertyId ?? detailData?.property_id ?? reservation?.property_id)
    ? Number(propertyId || detailData?.property_id || reservation?.property_id)
    : null;

  // Load room active findings
  const loadRoomFindings = useCallback(async (roomId?: number, propId?: number) => {
    const targetRoomId = roomId || detailData?.room_id || reservation?.room_id;
    const effectivePropId = propId || activePropId;
    if (!targetRoomId || !effectivePropId) {
      setActiveRoomFindings([]);
      return;
    }
    try {
      const result = await safeFetchJson<{ data?: any[] }>(
        `/api/housekeeping/findings?property_id=${effectivePropId}&room_id=${targetRoomId}`,
        undefined,
        undefined,
        authFetch
      );
      if (result.ok && result.data?.data) {
        setActiveRoomFindings(result.data.data);
      }
    } catch (err) {
      console.warn('Failed to load room findings', err);
    }
  }, [detailData?.room_id, activePropId, reservation?.room_id, authFetch]);

  // Load complete reservation details
  const loadFullReservation = async (customId?: number) => {
    const targetId = customId || reservation?.id;
    if (!targetId || !activePropId) return;
    try {
      setLoading(true);
      const result = await safeFetchJson<{ data?: any }>(
        `/api/reservations/${targetId}?property_id=${activePropId}`,
        undefined,
        undefined,
        authFetch
      );
      if (result.ok && result.data?.data) {
        setDetailData(result.data.data);
        if (result.data.data.room_id) {
          loadRoomFindings(result.data.data.room_id, result.data.data.property_id || activePropId);
        }
      }
    } catch (err) {
      console.warn('Failed to load full reservation data', err);
    } finally {
      setLoading(false);
    }
  };

  // Load folio entries & balance
  const loadFolio = async (customId?: number) => {
    const targetId = customId || reservation?.id;
    if (!targetId || !activePropId) return;
    try {
      const result = await safeFetchJson<{ data?: any }>(
        `/api/reservations/${targetId}/folio?property_id=${activePropId}`,
        undefined,
        undefined,
        authFetch
      );
      if (result.ok && result.data?.data) {
        setFolioData(result.data.data);
      }
    } catch (err) {
      console.warn('Failed to load folio', err);
    }
  };

  const handleSelectSiblingReservation = (siblingId: number) => {
    loadFullReservation(siblingId);
    loadFolio(siblingId);
  };

  const handleRequestCheckoutInspection = async () => {
    if (!detailData?.id || !activePropId) return;
    try {
      setRequestingInspection(true);
      setInspectionMsg(null);
      const result = await safeFetchJson(
        '/api/housekeeping/checkout-room-check',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            property_id: activePropId,
            reservation_id: detailData.id,
            room_id: detailData.room_id,
            requested_by_name: 'Front Office',
            requested_by_role: 'Receptionist'
          })
        },
        'Gagal meminta pemeriksaan kamar. Coba lagi.',
        authFetch
      );
      if (!result.ok) {
        throw new Error(result.errorMessage || 'Gagal meminta pemeriksaan kamar');
      }
      setInspectionMsg('Permintaan pemeriksaan kamar berhasil dikirim ke Housekeeping.');
      await loadFullReservation(detailData.id);
      onRefresh();
    } catch (err: any) {
      setInspectionMsg(`Status pemeriksaan: ${err.message || 'Gagal meminta pemeriksaan'}`);
    } finally {
      setRequestingInspection(false);
    }
  };

  const handleSavePhone = async () => {
    if (!detailData?.id || !activePropId) return;
    if (!phoneDraft.trim()) {
      alert('Nomor telepon tidak boleh kosong');
      return;
    }
    try {
      setSavingPhone(true);
      const result = await safeFetchJson(
        `/api/reservations/${detailData.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            property_id: activePropId,
            guest_phone: phoneDraft.trim()
          })
        },
        'Gagal memperbarui nomor telepon',
        authFetch
      );
      if (result.ok) {
        setIsEditingPhone(false);
        await loadFullReservation(detailData.id);
        onRefresh();
      } else {
        alert(result.errorMessage || 'Gagal memperbarui nomor telepon');
      }
    } catch (err: any) {
      alert('Terjadi kesalahan: ' + err.message);
    } finally {
      setSavingPhone(false);
    }
  };

  const handleIdentityConfirmed = async (extracted: ExtractedIdentityData) => {
    if (!detailData?.id || !activePropId) return;
    try {
      const result = await safeFetchJson(
        `/api/reservations/${detailData.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            property_id: activePropId,
            ktp_path: extracted.file_path,
            identity_number: extracted.identity_number,
            has_valid_identity: true,
            guest_name: extracted.full_name || undefined
          })
        },
        'Gagal menyimpan data KTP ke reservasi',
        authFetch
      );
      if (result.ok) {
        setIsIdentityModalOpen(false);
        await loadFullReservation(detailData.id);
        onRefresh();
      } else {
        alert(result.errorMessage || 'Gagal menyimpan data KTP ke reservasi');
      }
    } catch (err: any) {
      alert('Terjadi kesalahan saat menyimpan KTP: ' + err.message);
    }
  };

  useEffect(() => {
    if (reservation?.id) {
      setDetailData(reservation);
      loadFullReservation();
      loadFolio();
      if (reservation.room_id) {
        loadRoomFindings(reservation.room_id, reservation.property_id || activePropId);
      }
    }
  }, [reservation?.id, reservation?.room_id, activePropId]);

  if (!reservation) return null;

  const data = detailData || reservation;
  const bid = data.bid || data.legacy_booking_number || `#${data.id}`;
  const isCheckedIn = data.status === 'CHECKED_IN';
  const isBooked = data.status === 'BOOKED';
  const isCheckedOut = data.status === 'CHECKED_OUT';
  const isCancelled = data.status === 'CANCELLED';

  const hasPhone = Boolean(data.guest_phone && String(data.guest_phone).trim().length > 0);
  const hasIdentity = Boolean(
    data.has_valid_identity ||
    (data.ktp_path && String(data.ktp_path).trim().length > 0) ||
    (data.identity_number && String(data.identity_number).trim().length > 0)
  );
  const isCheckinReady = hasPhone && hasIdentity;
  const isOtaReservation = Boolean(
    data.ota_source_name ||
    String(data.booking_channel || '').toUpperCase() === 'OTA' ||
    String(data.booking_type || '').toUpperCase() === 'OTA' ||
    String(data.booking_source || '').toUpperCase() === 'OTA' ||
    (data.is_manual_override && String(data.manual_override_reason || '').toLowerCase().includes('ota'))
  );

  useEffect(() => {
    if (data?.guest_phone && !isEditingPhone) {
      setPhoneDraft(data.guest_phone);
    }
  }, [data?.guest_phone, isEditingPhone]);

  const totalPrice = Number(data.total_price || 0);
  const amountPaid = Number(data.amount_paid || 0);
  const remainingBalance = Math.max(0, Number(data.remaining_balance ?? Math.max(0, totalPrice - amountPaid)));

  const handleCopyBid = async () => {
    try {
      await navigator.clipboard.writeText(bid);
      setBidCopied(true);
      setTimeout(() => setBidCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleAddPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activePropId) {
      setPaymentError('Properti aktif tidak tersedia');
      return;
    }
    const amountNum = Number(paymentDraft.replace(/\D/g, ''));
    if (!amountNum || amountNum <= 0) {
      setPaymentError('Masukkan nominal pembayaran yang valid');
      return;
    }

    try {
      setPaymentSubmitting(true);
      setPaymentError(null);

      const formData = new FormData();
      formData.append('amount', String(amountNum));
      formData.append('payment_method', paymentMethod);
      formData.append('property_id', String(activePropId));
      if (paymentEvidenceFile) {
        formData.append('evidence', paymentEvidenceFile);
      }

      const res = await authFetch(`/api/reservations/${data.id}/payments`, {
        method: 'POST',
        body: formData
      });

      const contentType = res.headers.get('content-type') || '';
      let json: any = null;
      if (contentType.includes('application/json')) {
        json = await res.json().catch(() => null);
      }

      if (!res.ok) {
        throw new Error(json?.message || json?.error || `Gagal mencatat pembayaran (${res.status})`);
      }

      setPaymentDraft('');
      setPaymentEvidenceFile(null);
      loadFullReservation();
      loadFolio();
      onRefresh();
    } catch (err: any) {
      setPaymentError(err.message || 'Gagal mencatat pembayaran');
    } finally {
      setPaymentSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-black/60 backdrop-blur-xs flex justify-end">
      <div className="relative w-full max-w-2xl bg-white h-full shadow-2xl flex flex-col border-l border-stone-200 overflow-hidden animate-in slide-in-from-right duration-200">
        {/* Top Header — Clean Identity + Status + Navigation (No Duplicate Edit Action) */}
        <div className="p-5 bg-gradient-to-r from-emerald-950 via-emerald-900 to-teal-950 text-white flex items-center justify-between border-b border-emerald-800/50">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-bold tracking-wider text-emerald-300 bg-emerald-900/80 px-2.5 py-0.5 rounded border border-emerald-700/50">
                {bid}
              </span>
              <button
                type="button"
                onClick={handleCopyBid}
                className="text-xs text-emerald-300 hover:text-white underline font-semibold cursor-pointer"
              >
                {bidCopied ? 'Tersalin ✓' : 'Salin'}
              </button>
            </div>
            <h2 className="text-base font-bold text-white mt-1">
              Detail Reservasi #{data.id}
            </h2>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={`text-xs px-2.5 py-1 rounded-full font-bold uppercase tracking-wider ${
                isCheckedIn
                  ? 'bg-blue-600 text-white'
                  : isBooked
                  ? 'bg-emerald-600 text-white'
                  : isCheckedOut
                  ? 'bg-stone-500 text-white'
                  : 'bg-rose-600 text-white'
              }`}
            >
              {data.status}
            </span>
            <span
              className={`text-xs px-2.5 py-1 rounded-full font-semibold ${
                remainingBalance === 0
                  ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-400/40'
                  : amountPaid > 0
                  ? 'bg-amber-500/20 text-amber-200 border border-amber-400/40'
                  : 'bg-rose-500/20 text-rose-200 border border-rose-400/40'
              }`}
            >
              {remainingBalance === 0 ? 'Lunas' : amountPaid > 0 ? 'Sebagian' : 'Belum Bayar'}
            </span>
            <button
              onClick={onClose}
              className="text-emerald-300 hover:text-white p-1.5 rounded-lg hover:bg-emerald-800/40 cursor-pointer ml-1"
              aria-label="Tutup"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5 bg-stone-50/50">
          {loading && (
            <div className="p-2.5 bg-emerald-50 text-emerald-800 text-xs rounded-lg border border-emerald-200 text-center animate-pulse">
              Memuat pembaruan data reservasi...
            </div>
          )}

          {/* Active Room Findings & Maintenance Blocker Alert */}
          {activeRoomFindings.length > 0 && (
            <div className="p-4 bg-rose-50 border border-rose-300 rounded-xl space-y-3 text-xs text-rose-950 shadow-xs">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 font-bold text-rose-800">
                  <span className="text-lg">🚨</span>
                  <div>
                    <span className="text-sm">Kendala Kamar Aktif ({activeRoomFindings.length})</span>
                    <span className="text-xs block font-normal text-rose-700">
                      Kamar memiliki laporan kendala / maintenance yang perlu diselesaikan.
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setIsResolveModalOpen(true)}
                  className="px-3 py-1.5 bg-emerald-800 hover:bg-emerald-700 text-white font-bold rounded-lg shadow-xs transition-colors cursor-pointer text-xs flex items-center gap-1.5"
                >
                  <span>🔧</span>
                  <span>Selesaikan &amp; Readykan Kamar</span>
                </button>
              </div>

              <div className="space-y-1.5 pt-2 border-t border-rose-200/80">
                {activeRoomFindings.map((f: any) => (
                  <div key={f.id} className="bg-white/90 p-2.5 rounded-lg border border-rose-200 flex items-center justify-between gap-2">
                    <div>
                      <div className="font-bold text-rose-900 text-xs">
                        {f.finding_type_label}: <span className="text-stone-800 font-medium">"{f.notes || '-'}"</span>
                      </div>
                      <span className="text-xs text-stone-500 block mt-0.5">
                        Dilaporkan oleh: <strong>{f.reported_by_name || 'Housekeeping'}</strong> ({f.reported_by_role || 'Staff'})
                      </span>
                    </div>
                    {f.block_room_ready && (
                      <span className="text-xs bg-rose-100 text-rose-800 font-bold px-2 py-0.5 rounded-full border border-rose-300 whitespace-nowrap">
                        Memblokir Check-in
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Multi-Room Booking Sibling Overview */}
          {data.sibling_reservations && data.sibling_reservations.length > 1 && (
            <div className="p-4 bg-emerald-950 text-white rounded-xl border border-emerald-800/80 shadow-xs space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm">🏨</span>
                  <span className="font-bold text-xs text-emerald-200">
                    Booking Multi-Kamar ({data.sibling_reservations.length} Kamar)
                  </span>
                </div>
                <span className="text-xs text-emerald-400 font-mono">
                  BID: {bid}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {data.sibling_reservations.map((sib: any) => {
                  const isCurrent = Number(sib.id) === Number(data.id);
                  return (
                    <button
                      key={sib.id}
                      type="button"
                      onClick={() => handleSelectSiblingReservation(sib.id)}
                      className={`p-2.5 rounded-lg text-left transition flex items-center justify-between cursor-pointer ${
                        isCurrent
                          ? 'bg-emerald-800 text-white border border-emerald-400 ring-1 ring-emerald-400 shadow-xs'
                          : 'bg-emerald-900/60 hover:bg-emerald-800/80 text-emerald-100 border border-emerald-700/50'
                      }`}
                    >
                      <div>
                        <div className="text-xs font-bold flex items-center gap-1.5">
                          <span>{sib.room_number ? `Kamar ${sib.room_number}` : 'Kamar Belum Ditentukan'}</span>
                          {isCurrent && (
                            <span className="text-xs bg-emerald-600 text-white px-1.5 py-0.5 rounded font-semibold">Aktif</span>
                          )}
                        </div>
                        <div className="text-xs text-emerald-300">
                          {sib.room_type_name || 'Standar'}
                        </div>
                      </div>
                      <span
                        className={`text-xs font-bold px-1.5 py-0.5 rounded uppercase tracking-wider ${
                          sib.status === 'CHECKED_IN'
                            ? 'bg-blue-600 text-white'
                            : sib.status === 'BOOKED'
                            ? 'bg-emerald-700 text-white'
                            : sib.status === 'CHECKED_OUT'
                            ? 'bg-stone-600 text-white'
                            : 'bg-rose-700 text-white'
                        }`}
                      >
                        {sib.status}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Pre-Checkout Housekeeping Inspection Section */}
          {isCheckedIn && (
            <div className="p-4 bg-white rounded-xl border border-stone-200 shadow-xs space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-stone-500">
                  Pemeriksaan Kamar Pre-Checkout (FO → HK)
                </span>
                {data.require_checkout_inspection && (
                  <span className="text-xs bg-amber-100 text-amber-800 font-semibold px-2 py-0.5 rounded-full border border-amber-300">
                    Wajib Diperiksa
                  </span>
                )}
              </div>

              {inspectionMsg && (
                <div className="p-2.5 bg-blue-50 text-blue-800 text-xs rounded-lg border border-blue-200">
                  {inspectionMsg}
                </div>
              )}

              {data.checkout_inspection ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between p-3 rounded-lg border text-xs bg-stone-50 border-stone-200">
                    <div className="space-y-0.5">
                      <span className="text-xs text-stone-500 font-medium block">Status Pemeriksaan:</span>
                      <div className="font-bold flex items-center gap-1.5 text-xs">
                        {data.checkout_inspection.clearance_state === 'CLEAR' ? (
                          <span className="text-emerald-700 flex items-center gap-1">
                            ✓ Kamar Aman (Clear)
                          </span>
                        ) : data.checkout_inspection.clearance_state === 'ISSUE_FOUND' ? (
                          <span className="text-rose-700 flex items-center gap-1">
                            ⚠️ Ada Temuan ({data.checkout_inspection.issue_type || 'Kendala'})
                          </span>
                        ) : data.checkout_inspection.clearance_state === 'INSPECTING' ? (
                          <span className="text-amber-700 flex items-center gap-1">
                            🔍 Sedang Diperiksa Housekeeping
                          </span>
                        ) : (
                          <span className="text-blue-700 flex items-center gap-1">
                            ⏳ Menunggu Housekeeping
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="text-right text-xs text-stone-500 font-mono">
                      Task #{data.checkout_inspection.task_id}
                    </div>
                  </div>

                  {data.checkout_inspection.clearance_state === 'ISSUE_FOUND' && (
                    <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs space-y-1 text-rose-900">
                      <div className="font-bold flex items-center gap-1">
                        <span>⚠️ Catatan Temuan:</span>
                      </div>
                      <p className="text-stone-700 text-xs">
                        {data.checkout_inspection.issue_note || 'Tidak ada catatan tambahan dari Housekeeping.'}
                      </p>
                      {data.checkout_inspection.estimated_charge && data.checkout_inspection.estimated_charge > 0 && (
                        <p className="font-semibold text-rose-800 font-mono mt-1 text-xs">
                          Estimasi Biaya / Denda: Rp {Number(data.checkout_inspection.estimated_charge).toLocaleString('id-ID')}
                        </p>
                      )}
                    </div>
                  )}

                  {data.checkout_inspection.clearance_state === 'CLEAR' && (
                    <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800 font-semibold flex items-center gap-1.5">
                      <span>✓ Kamar telah diperiksa dan dinyatakan aman. Checkout dapat dilanjutkan.</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-3 bg-stone-50 rounded-lg border border-stone-200 flex items-center justify-between flex-wrap gap-2">
                  <span className="text-xs text-stone-600">
                    Belum ada permintaan pemeriksaan untuk kamar ini.
                  </span>
                  <button
                    type="button"
                    disabled={requestingInspection}
                    onClick={handleRequestCheckoutInspection}
                    className="px-3 py-1.5 bg-emerald-800 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold text-xs rounded-lg shadow-2xs transition flex items-center gap-1 cursor-pointer"
                  >
                    {requestingInspection ? 'Mengirim...' : 'Minta Pemeriksaan Kamar'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Section 2: Data Pemesan vs Data Tamu Menginap */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Booker */}
            <div className="p-4 bg-white rounded-xl border border-stone-200 shadow-xs space-y-1.5">
              <span className="text-xs font-bold uppercase tracking-wider text-stone-400">
                Data Pemesan (Booker)
              </span>
              <div className="font-bold text-sm text-stone-900">
                {data.booker_name || data.guest_name}
              </div>
              <div className="text-xs text-stone-600 font-mono">
                📞 {data.booker_phone || data.guest_phone || '—'}
              </div>
            </div>

            {/* Staying Guest */}
            <div className="p-4 bg-white rounded-xl border border-stone-200 shadow-xs space-y-2">
              <span className="text-xs font-bold uppercase tracking-wider text-stone-400">
                Tamu Menginap (Staying Guest)
              </span>
              <div className="font-bold text-sm text-stone-900 flex items-center justify-between">
                <span>{data.guest_name}</span>
                {data.guest_segment && (
                  <span className="text-xs px-2 py-0.5 bg-stone-100 text-stone-700 rounded font-medium">
                    {data.guest_segment}
                  </span>
                )}
              </div>

              {isEditingPhone ? (
                <div className="space-y-1.5 pt-1 border-t border-stone-100">
                  <label className="block text-xs font-bold text-stone-600">
                    Nomor Telepon Tamu <span className="text-rose-500">*</span>
                  </label>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="tel"
                      value={phoneDraft}
                      onChange={e => setPhoneDraft(e.target.value)}
                      placeholder="08xxxxxxxxxx"
                      className="flex-1 text-xs px-2.5 py-1.5 bg-stone-50 border border-stone-300 rounded-lg font-mono focus:bg-white focus:border-emerald-600 focus:outline-hidden"
                      autoFocus
                    />
                    <button
                      type="button"
                      disabled={savingPhone}
                      onClick={handleSavePhone}
                      className="px-3 py-1.5 bg-emerald-800 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold text-xs rounded-lg transition-colors cursor-pointer"
                    >
                      {savingPhone ? '...' : 'Simpan'}
                    </button>
                    <button
                      type="button"
                      disabled={savingPhone}
                      onClick={() => {
                        setIsEditingPhone(false);
                        setPhoneDraft(data.guest_phone || '');
                      }}
                      className="px-2.5 py-1.5 bg-stone-200 hover:bg-stone-300 text-stone-700 text-xs rounded-lg transition-colors cursor-pointer font-medium"
                    >
                      Batal
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between pt-1 border-t border-stone-100">
                  <div className="text-xs text-stone-600 font-mono flex items-center gap-1">
                    <span>📞</span>
                    {data.guest_phone ? (
                      <span className="font-bold text-stone-900">{data.guest_phone}</span>
                    ) : (
                      <span className="text-rose-600 font-semibold bg-rose-50 px-2 py-0.5 rounded text-xs">
                        ⚠️ Belum ada No. Telepon
                      </span>
                    )}
                  </div>
                  {!isCancelled && !isCheckedOut && (
                    <button
                      type="button"
                      onClick={() => {
                        setPhoneDraft(data.guest_phone || '');
                        setIsEditingPhone(true);
                      }}
                      className="text-xs font-bold text-emerald-800 hover:text-emerald-950 hover:underline cursor-pointer"
                    >
                      {data.guest_phone ? 'Ubah No. Telp' : '+ Isi No. Telp'}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Section 3: Sumber Reservasi & Dokumen KTP */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Source */}
            <div className="p-4 bg-white rounded-xl border border-stone-200 shadow-xs space-y-1.5">
              <span className="text-xs font-bold uppercase tracking-wider text-stone-400">
                Sumber &amp; Saluran
              </span>
              <div className="text-xs font-bold text-stone-900">
                {data.ota_source_name ? `🌐 OTA: ${data.ota_source_name}` : `🚶 ${data.booking_source || data.channel || 'Walk-in'}`}
              </div>
              {data.referral && (
                <div className="text-xs text-stone-500 font-mono">
                  Ref/No. Booking: <strong className="text-stone-800">{data.referral}</strong>
                </div>
              )}
            </div>

            {/* KTP Document */}
            <div className="p-4 bg-white rounded-xl border border-stone-200 shadow-xs space-y-2">
              <span className="text-xs font-bold uppercase tracking-wider text-stone-400">
                Dokumen Identitas (KTP)
              </span>

              {data.ktp_path || data.identity_number ? (
                <div className="flex items-center justify-between text-xs pt-1 border-t border-stone-100">
                  <div>
                    <span className="font-bold text-emerald-800 flex items-center gap-1">
                      <span>✓</span> KTP / Identitas Terlampir
                    </span>
                    {data.identity_number && (
                      <p className="text-xs text-stone-600 font-mono mt-0.5">NIK: <strong className="text-stone-900">{data.identity_number}</strong></p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {data.ktp_path && (
                      <button
                        type="button"
                        onClick={() => setIsKtpPreviewOpen(true)}
                        className="px-2.5 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-900 rounded-lg font-semibold text-xs border border-emerald-200 cursor-pointer transition-colors"
                      >
                        Lihat KTP
                      </button>
                    )}
                    {!isCancelled && !isCheckedOut && (
                      <button
                        type="button"
                        onClick={() => setIsIdentityModalOpen(true)}
                        className="text-xs font-bold text-emerald-800 hover:text-emerald-950 hover:underline cursor-pointer"
                      >
                        Ganti KTP
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="pt-1 border-t border-stone-100 flex items-center justify-between">
                  <span className="text-xs text-rose-600 font-semibold bg-rose-50 px-2 py-0.5 rounded">
                    ⚠️ Belum ada KTP (Wajib Check-in)
                  </span>
                  {!isCancelled && !isCheckedOut && (
                    <button
                      type="button"
                      onClick={() => setIsIdentityModalOpen(true)}
                      className="px-2.5 py-1 bg-emerald-800 hover:bg-emerald-700 text-white font-bold text-xs rounded-lg transition-colors cursor-pointer flex items-center gap-1"
                    >
                      <span>📷</span> + Unggah KTP
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Check-in Readiness Banner for Booked reservation */}
          {isBooked && (
            <div className={`p-3.5 rounded-xl border transition-all ${
              isCheckinReady
                ? 'bg-emerald-50/70 border-emerald-200 text-emerald-900'
                : 'bg-amber-50 border-amber-300 text-amber-950 shadow-xs'
            }`}>
              <div className="flex items-start gap-2.5">
                <span className="text-base leading-none mt-0.5">{isCheckinReady ? '✅' : '⚠️'}</span>
                <div className="flex-1 space-y-0.5">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold">
                      {isCheckinReady ? 'Persyaratan Check-in Lengkap' : 'Syarat Wajib Check-in Belum Lengkap'}
                    </h4>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-semibold border ${
                      isCheckinReady ? 'bg-emerald-100 text-emerald-900 border-emerald-300' : 'bg-amber-100 text-amber-900 border-amber-300'
                    }`}>
                      {isCheckinReady ? 'Siap Check-in' : 'Wajib Dilengkapi'}
                    </span>
                  </div>
                  <p className="text-xs opacity-90">
                    {isCheckinReady
                      ? 'Nomor telepon tamu dan dokumen identitas (KTP/NIK) telah terverifikasi.'
                      : 'Nomor telepon tamu dan dokumen identitas (KTP/NIK) wajib diisi sebelum proses check-in dapat dilakukan.'}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Section 4: Detail Menginap & Kamar */}
          <div className="p-4 bg-white rounded-xl border border-stone-200 shadow-xs space-y-3">
            <span className="text-xs font-bold uppercase tracking-wider text-stone-400">
              Detail Menginap &amp; Kamar
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div className="p-2.5 bg-stone-50 rounded-lg">
                <span className="text-stone-500 text-xs block mb-0.5">Nomor Kamar</span>
                <strong className="text-stone-800 font-bold text-sm">
                  {data.room_number ? `Kamar ${data.room_number}` : 'Belum Ditentukan'}
                </strong>
              </div>
              <div className="p-2.5 bg-stone-50 rounded-lg">
                <span className="text-stone-500 text-xs block mb-0.5">Tipe Kamar</span>
                <strong className="text-stone-800 font-semibold text-xs">
                  {data.room_type_name || data.room_type || data.room_variant || '—'}
                </strong>
              </div>
              <div className="p-2.5 bg-stone-50 rounded-lg">
                <span className="text-stone-500 text-xs block mb-0.5">Check-in</span>
                <strong className="text-stone-800 font-mono text-xs">{data.check_in || '—'}</strong>
              </div>
              <div className="p-2.5 bg-stone-50 rounded-lg">
                <span className="text-stone-500 text-xs block mb-0.5">Check-out</span>
                <strong className="text-stone-800 font-mono text-xs">{data.check_out || '—'}</strong>
              </div>
            </div>
          </div>

          {/* Section 5: Rate Plan & Snapshot Tarif Malam */}
          <div className="p-4 bg-white rounded-xl border border-stone-200 shadow-xs space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-stone-400">
                Rate Plan &amp; Tarif Menginap
              </span>
              <span className="text-xs font-semibold text-emerald-900 bg-emerald-50 px-2.5 py-0.5 rounded border border-emerald-200">
                {isOtaReservation ? (data.ota_source_name || data.ota_name || 'OTA Voucher Rate') : (data.rate_plan_name_snapshot || 'Standard Rate')}
              </span>
            </div>

            {data.is_manual_override && (
              <div className="p-2.5 bg-amber-50 rounded-lg border border-amber-200 text-xs text-amber-900 flex items-start gap-2">
                <span>⚠️</span>
                <div>
                  <strong>Tarif Manual Override:</strong> {data.manual_override_reason || 'Tidak ada alasan tercatat'}
                </div>
              </div>
            )}

            {/* Nightly breakdown if rate_snapshot or nightly_rates is available */}
            {data.rate_snapshot?.nightly_rates && data.rate_snapshot.nightly_rates.length > 0 && (
              <div className="border border-stone-200 rounded-lg overflow-hidden text-xs">
                <table className="w-full text-left">
                  <thead className="bg-stone-100 text-stone-600 font-semibold text-xs">
                    <tr>
                      <th className="p-2.5">Tanggal</th>
                      <th className="p-2.5">Base Rate</th>
                      <th className="p-2.5">Penyesuaian</th>
                      <th className="p-2.5 text-right">Tarif Malam</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {data.rate_snapshot.nightly_rates.map((nr: any, idx: number) => (
                      <tr key={idx} className="hover:bg-stone-50">
                        <td className="p-2.5 font-mono">{nr.stay_date || nr.hotel_date}</td>
                        <td className="p-2.5 font-mono">Rp {Number(nr.base_rate || nr.final_room_rate || nr.final_rate || 0).toLocaleString('id-ID')}</td>
                        <td className="p-2.5 text-stone-500">
                          {nr.dow_multiplier && nr.dow_multiplier !== 1 ? `DOW x${nr.dow_multiplier} ` : ''}
                          {nr.seasonal_multiplier && nr.seasonal_multiplier !== 1 ? `Musim x${nr.seasonal_multiplier}` : ''}
                          {nr.is_manual_override ? 'Manual' : ''}
                        </td>
                        <td className="p-2.5 font-mono font-bold text-right text-stone-900">
                          Rp {Number(nr.final_room_rate || nr.final_rate || nr.total_amount || 0).toLocaleString('id-ID')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Section 6: Folio & Ringkasan Pembayaran (Authoritative Derived Output, No Direct Edit) */}
          <div className="p-4 bg-white rounded-xl border border-stone-200 shadow-xs space-y-3">
            <div className="flex items-center justify-between border-b border-stone-100 pb-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-stone-500">
                  Folio &amp; Ringkasan Pembayaran
                </span>
                {!isCancelled && !isCheckedOut && (
                  <button
                    type="button"
                    onClick={() => setIsAddChargeModalOpen(true)}
                    className="px-2.5 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-300 rounded-lg text-xs font-bold transition-colors cursor-pointer"
                  >
                    + Tambah Biaya
                  </button>
                )}
              </div>
              <span className={`text-xs font-bold ${remainingBalance > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
                {remainingBalance > 0 ? `Sisa: Rp ${remainingBalance.toLocaleString('id-ID')}` : 'Lunas (PAID)'}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="p-3 bg-stone-50 rounded-lg">
                <span className="text-stone-500 text-xs block mb-1">Total Tagihan</span>
                <strong className="text-stone-900 font-bold font-mono text-sm">
                  Rp {totalPrice.toLocaleString('id-ID')}
                </strong>
              </div>
              <div className="p-3 bg-stone-50 rounded-lg">
                <span className="text-stone-500 text-xs block mb-1">Sudah Dibayar</span>
                <strong className="text-emerald-800 font-bold font-mono text-sm">
                  Rp {amountPaid.toLocaleString('id-ID')}
                </strong>
              </div>
              <div className="p-3 bg-stone-50 rounded-lg">
                <span className="text-stone-500 text-xs block mb-1">Sisa Tagihan</span>
                <strong className={`font-bold font-mono text-sm ${remainingBalance > 0 ? 'text-amber-800' : 'text-emerald-800'}`}>
                  Rp {remainingBalance.toLocaleString('id-ID')}
                </strong>
              </div>
            </div>

            {/* Folio Entries Table */}
            {(() => {
              const entries = folioData?.entries || folioData?.folio || [];
              if (entries.length === 0) return null;
              return (
                <div className="mt-3 border border-stone-200 rounded-lg overflow-hidden text-xs">
                  <div className="bg-stone-100 px-3 py-2 font-bold text-stone-700 text-xs">
                    Rincian Folio Transaksi
                  </div>
                  <div className="divide-y divide-stone-100 max-h-48 overflow-y-auto">
                    {entries.map((ent: any) => {
                      const isDebit = (ent.direction || ent.amount_type) === 'DEBIT';
                      return (
                        <div key={ent.id} className="p-2.5 flex items-center justify-between text-xs">
                          <div>
                            <span className="font-semibold text-stone-800 text-xs">{ent.description || ent.entry_type}</span>
                            <span className="text-xs text-stone-400 block font-mono mt-0.5">
                              {ent.entry_type || ent.source_type} • {ent.hotel_date || ent.created_at?.slice(0, 10) || ''}
                            </span>
                          </div>
                          <div className="font-mono font-bold text-right text-xs">
                            {isDebit ? (
                              <span className="text-stone-900">+Rp {Number(ent.amount || 0).toLocaleString('id-ID')}</span>
                            ) : (
                              <span className="text-emerald-800">-Rp {Number(ent.amount || 0).toLocaleString('id-ID')}</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Recorded Payments History */}
            {(() => {
              const payments = folioData?.payments || [];
              if (payments.length === 0) return null;
              return (
                <div className="mt-3 border border-stone-200 rounded-lg overflow-hidden text-xs">
                  <div className="bg-emerald-50 px-3 py-2 font-bold text-emerald-950 text-xs flex items-center justify-between">
                    <span>Riwayat Pembayaran ({payments.length})</span>
                    <span className="font-mono text-emerald-800">
                      Total: Rp {payments.filter((p: any) => p.status === 'SUCCESS').reduce((acc: number, p: any) => acc + Number(p.amount || 0), 0).toLocaleString('id-ID')}
                    </span>
                  </div>
                  <div className="divide-y divide-stone-100 max-h-48 overflow-y-auto">
                    {payments.map((pmt: any, idx: number) => (
                      <div key={pmt.id} className="p-2.5 flex items-center justify-between text-xs hover:bg-stone-50">
                        <div>
                          <div className="font-semibold text-stone-800 flex items-center gap-1.5 text-xs">
                            <span>Pembayaran #{payments.length - idx}</span>
                            <span className="text-xs bg-stone-100 text-stone-700 px-1.5 py-0.5 rounded font-mono">
                              {pmt.payment_method || pmt.method || 'CASH'}
                            </span>
                            <span className={`text-xs px-1.5 py-0.5 rounded font-bold uppercase ${pmt.status === 'SUCCESS' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}>
                              {pmt.status}
                            </span>
                          </div>
                          <span className="text-xs text-stone-400 block font-mono mt-0.5">
                            {pmt.payment_ref ? `Ref: ${pmt.payment_ref} • ` : ''}{pmt.created_at ? new Date(pmt.created_at).toLocaleString('id-ID') : ''}
                          </span>
                        </div>
                        <div className="font-mono font-bold text-emerald-900 text-right text-xs">
                          Rp {Number(pmt.amount || 0).toLocaleString('id-ID')}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Bukti Bayar Preview if available */}
            {data.bukti_bayar_path && (
              <div className="pt-2 border-t border-stone-100 flex items-center justify-between text-xs">
                <span className="text-stone-500 font-medium">Bukti Pembayaran Utama:</span>
                <button
                  type="button"
                  onClick={() => setIsPaymentEvidencePreviewOpen(true)}
                  className="px-2.5 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-900 rounded-lg font-semibold text-xs border border-emerald-200 cursor-pointer transition-colors"
                >
                  Buka Bukti Bayar
                </button>
              </div>
            )}
          </div>

          {/* Section 7: Tambah Pembayaran Baru (Single Canonical Payment Logging Form) */}
          {remainingBalance > 0 && !isCancelled && (
            <form onSubmit={handleAddPayment} className="p-4 bg-white rounded-xl border border-stone-200 shadow-xs space-y-3">
              <span className="text-xs font-bold uppercase tracking-wider text-stone-500">
                + Catat Pembayaran Baru
              </span>

              {paymentError && (
                <div className="p-2.5 bg-rose-50 text-rose-800 text-xs rounded-lg border border-rose-200">
                  {paymentError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">Metode Pembayaran</label>
                  <select
                    value={paymentMethod}
                    onChange={e => setPaymentMethod(e.target.value as any)}
                    className="w-full p-2 bg-stone-50 border border-stone-300 rounded-lg outline-none text-xs"
                  >
                    <option value="CASH">Tunai (Cash)</option>
                    <option value="TRANSFER">Transfer Bank</option>
                    <option value="QRIS">QRIS / E-Wallet</option>
                    <option value="DEBIT_CARD">Kartu Debit</option>
                    <option value="CREDIT_CARD">Kartu Kredit</option>
                  </select>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-semibold text-stone-700">Nominal (Rp)</label>
                    <button
                      type="button"
                      onClick={() => setPaymentDraft(String(remainingBalance))}
                      className="text-xs font-semibold text-emerald-800 hover:text-emerald-950 bg-emerald-50 hover:bg-emerald-100 px-2 py-0.5 rounded border border-emerald-200 cursor-pointer transition-colors"
                    >
                      Isi Sisa Tagihan (Rp {remainingBalance.toLocaleString('id-ID')})
                    </button>
                  </div>
                  <input
                    type="number"
                    step="1000"
                    placeholder={`Contoh: ${remainingBalance}`}
                    value={paymentDraft}
                    onChange={e => setPaymentDraft(e.target.value)}
                    className="w-full p-2 bg-stone-50 border border-stone-300 rounded-lg outline-none font-mono font-bold text-xs"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Upload Bukti Transaksi
                  </label>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,application/pdf"
                    onChange={e => setPaymentEvidenceFile(e.target.files ? e.target.files[0] : null)}
                    className="w-full text-xs p-1.5 bg-stone-50 border border-stone-300 rounded-lg"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={paymentSubmitting}
                className="w-full py-2.5 bg-emerald-800 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg font-bold text-xs shadow-xs transition-colors cursor-pointer"
              >
                {paymentSubmitting ? 'Menyimpan...' : 'Catat Pembayaran'}
              </button>
            </form>
          )}

          {/* Section: Deposit & Jaminan */}
          {data.id && activePropId && (
            <DepositGuaranteeSection
              reservationId={data.id}
              propertyId={activePropId}
              reservationStatus={data.status}
              remainingBalance={remainingBalance}
              onRefresh={() => { loadFullReservation(data.id); loadFolio(data.id); onRefresh(); }}
            />
          )}

          {/* Section 8: Catatan / Special Requests */}
          {data.special_requests && (
            <div className="p-4 bg-white rounded-xl border border-stone-200 shadow-xs space-y-1">
              <span className="text-xs font-bold uppercase tracking-wider text-stone-400">
                Catatan Khusus / Special Requests
              </span>
              <p className="text-xs text-stone-800 italic">"{data.special_requests}"</p>
            </div>
          )}
        </div>

        {/* Action Bar Footer — Lifecycle-Aware Single Action Area */}
        <div className="p-4 bg-white border-t border-stone-200 flex items-center justify-between gap-3 flex-wrap">
          {/* Left: Destructive or Informational State */}
          <div className="flex items-center gap-2">
            {isBooked && (
              <button
                type="button"
                onClick={() => onCancel(data.id)}
                className="px-3 py-2 bg-rose-50 hover:bg-rose-100 text-rose-800 font-semibold text-xs rounded-xl border border-rose-200 transition-colors cursor-pointer"
              >
                Batalkan Reservasi
              </button>
            )}
            {isCheckedOut && (
              <div className="text-xs text-stone-500 font-medium flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-stone-400"></span>
                <span>Reservasi telah selesai (Checked-Out)</span>
              </div>
            )}
            {isCancelled && (
              <div className="text-xs text-rose-600 font-medium flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-rose-500"></span>
                <span>Reservasi telah dibatalkan (Cancelled)</span>
              </div>
            )}
          </div>

          {/* Right: Operational Actions per Lifecycle State */}
          <div className="flex items-center gap-2">
            {/* BOOKED State Actions */}
            {isBooked && (
              <>
                <button
                  type="button"
                  onClick={() => setIsEditModalOpen(true)}
                  className="px-3 py-2 bg-white hover:bg-stone-50 text-stone-700 font-semibold text-xs rounded-xl border border-stone-300 transition-colors cursor-pointer"
                >
                  Edit Reservasi
                </button>

                {onOpenStayChange && (
                  <>
                    <button
                      type="button"
                      onClick={() => onOpenStayChange(data, 'extend')}
                      className="px-3 py-2 bg-white hover:bg-stone-50 text-stone-700 font-semibold text-xs rounded-xl border border-stone-300 transition-colors cursor-pointer"
                    >
                      Perpanjang Menginap
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenStayChange(data, 'shorten')}
                      className="px-3 py-2 bg-white hover:bg-stone-50 text-stone-700 font-semibold text-xs rounded-xl border border-stone-300 transition-colors cursor-pointer"
                    >
                      Ubah Tanggal Check-out
                    </button>
                  </>
                )}

                <button
                  type="button"
                  disabled={!isCheckinReady}
                  onClick={() => {
                    if (!isCheckinReady) {
                      alert('Check-in tidak dapat dilakukan: Nomor Telepon dan Dokumen Identitas (KTP) wajib dilengkapi terlebih dahulu.');
                      return;
                    }
                    onCheckin(data.id);
                  }}
                  className={`px-4 py-2 font-bold text-xs rounded-xl shadow-xs transition-colors flex items-center gap-1.5 ${
                    isCheckinReady
                      ? 'bg-emerald-800 hover:bg-emerald-700 text-white cursor-pointer'
                      : 'bg-stone-200 text-stone-400 border border-stone-300 cursor-not-allowed'
                  }`}
                  title={isCheckinReady ? 'Check-in Tamu' : 'Lengkapi No. Telepon & KTP Tamu terlebih dahulu'}
                >
                  <span>{isCheckinReady ? '✓' : '🔒'}</span>
                  <span>Check-in Tamu</span>
                </button>
              </>
            )}

            {/* CHECKED_IN State Actions */}
            {isCheckedIn && (
              <>
                {onOpenStayChange && (
                  <>
                    <button
                      type="button"
                      onClick={() => onOpenStayChange(data, 'extend')}
                      className="px-3 py-2 bg-white hover:bg-stone-50 text-stone-700 font-semibold text-xs rounded-xl border border-stone-300 transition-colors cursor-pointer"
                    >
                      Perpanjang Menginap
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenStayChange(data, 'shorten')}
                      className="px-3 py-2 bg-white hover:bg-stone-50 text-stone-700 font-semibold text-xs rounded-xl border border-stone-300 transition-colors cursor-pointer"
                    >
                      Ubah Tanggal Check-out
                    </button>
                  </>
                )}

                {data.require_checkout_inspection && (!data.checkout_inspection || data.checkout_inspection.clearance_state === 'REQUESTED' || data.checkout_inspection.clearance_state === 'INSPECTING') ? (
                  !data.checkout_inspection ? (
                    <button
                      type="button"
                      disabled={requestingInspection}
                      onClick={handleRequestCheckoutInspection}
                      className="px-4 py-2 bg-emerald-800 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold text-xs rounded-xl shadow-xs transition-colors cursor-pointer"
                    >
                      {requestingInspection ? 'Mengirim...' : 'Minta Pemeriksaan Kamar'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled
                      className="px-4 py-2 bg-stone-300 text-stone-500 font-bold text-xs rounded-xl cursor-not-allowed shadow-none"
                      title="Pemeriksaan Housekeeping harus diselesaikan terlebih dahulu"
                    >
                      ⏳ Menunggu Housekeeping
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    onClick={() => onCheckout(data.id)}
                    className="px-4 py-2 bg-amber-700 hover:bg-amber-600 text-white font-bold text-xs rounded-xl shadow-xs transition-colors cursor-pointer"
                  >
                    Check-out Tamu
                  </button>
                )}
              </>
            )}

            {/* General Close Button */}
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 font-semibold text-xs rounded-xl border border-stone-200 transition-colors cursor-pointer"
            >
              Tutup
            </button>
          </div>
        </div>

        {/* Modals */}
        {isIdentityModalOpen && activePropId && (
          <IdentityExtractionModal
            isOpen={isIdentityModalOpen}
            onClose={() => setIsIdentityModalOpen(false)}
            guestName={data.guest_name || data.booker_name || ''}
            guestPhone={data.guest_phone || data.booker_phone || ''}
            propertyId={activePropId}
            onScanSuccess={handleIdentityConfirmed}
            onIdentityConfirmed={handleIdentityConfirmed}
          />
        )}

        {isEditModalOpen && activePropId && (
          <EditReservationModal
            isOpen={isEditModalOpen}
            onClose={() => setIsEditModalOpen(false)}
            reservation={data}
            propertyId={activePropId}
            onSuccess={() => {
              loadFullReservation(data.id);
              loadFolio(data.id);
              onRefresh();
            }}
          />
        )}

        {isAddChargeModalOpen && activePropId && (
          <AddStayChargeModal
            isOpen={isAddChargeModalOpen}
            onClose={() => setIsAddChargeModalOpen(false)}
            reservationId={data.id}
            propertyId={activePropId}
            roomNightlyRate={data.room_rate || (data.subtotal_amount ? (data.subtotal_amount / (data.nights || 1)) : data.total_price)}
            existingCharges={folioData?.entries || []}
            onSuccess={() => {
              loadFullReservation(data.id);
              loadFolio(data.id);
              onRefresh();
            }}
          />
        )}

        {isResolveModalOpen && activePropId && (
          <MaintenanceIssuesModal
            isOpen={isResolveModalOpen}
            onClose={() => setIsResolveModalOpen(false)}
            propertyId={activePropId}
            initialRoomId={data.room_id || data.room?.id}
            onRefreshParent={() => {
              loadFullReservation(data.id);
              loadFolio(data.id);
              loadRoomFindings(data.room_id, activePropId);
              onRefresh();
            }}
          />
        )}

        {/* KTP Document Preview Modal */}
        {isKtpPreviewOpen && data.ktp_path && (
          <div
            className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs animate-in fade-in duration-150"
            onClick={() => setIsKtpPreviewOpen(false)}
          >
            <div
              className="bg-stone-900 border border-stone-700 rounded-2xl max-w-2xl w-full p-4 space-y-3 shadow-2xl overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-stone-800 pb-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-stone-100">
                    Foto Identitas (KTP) — {data.guest_name || 'Tamu'}
                  </span>
                  {data.identity_number && (
                    <span className="text-[11px] font-mono bg-stone-800 text-emerald-400 px-2 py-0.5 rounded border border-stone-700">
                      NIK: {data.identity_number}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {ktpBlobUrl && (
                    <button
                      type="button"
                      onClick={() => window.open(ktpBlobUrl, '_blank')}
                      className="px-2.5 py-1 bg-stone-800 hover:bg-stone-700 text-stone-200 text-xs font-semibold rounded-lg border border-stone-600 transition-colors cursor-pointer"
                    >
                      Buka di Tab Baru ↗
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setIsKtpPreviewOpen(false)}
                    className="text-stone-400 hover:text-white p-1 rounded-lg text-lg leading-none cursor-pointer"
                  >
                    ✕
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-center bg-stone-950/60 rounded-xl p-2 min-h-[300px] max-h-[70vh] overflow-auto">
                {ktpLoading ? (
                  <div className="flex flex-col items-center justify-center py-12 text-stone-400 text-xs gap-2">
                    <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                    <span>Mengunduh dokumen aman...</span>
                  </div>
                ) : ktpError ? (
                  <div className="text-center p-8 text-rose-400 text-xs space-y-1">
                    <div className="text-2xl">⚠️</div>
                    <p className="font-bold">{ktpError}</p>
                    <p className="text-stone-500 text-[11px]">Pastikan Anda memiliki izin akses ke dokumen properti ini.</p>
                  </div>
                ) : ktpBlobUrl ? (
                  data.ktp_path.toLowerCase().endsWith('.pdf') ? (
                    <iframe
                      src={ktpBlobUrl}
                      title="Dokumen KTP"
                      className="w-full h-[60vh] rounded-lg border-0"
                    />
                  ) : (
                    <img
                      src={ktpBlobUrl}
                      alt={`KTP ${data.guest_name || ''}`}
                      className="max-h-[65vh] max-w-full object-contain rounded-lg shadow-md"
                    />
                  )
                ) : null}
              </div>
            </div>
          </div>
        )}

        {/* Bukti Bayar Preview Modal */}
        {isPaymentEvidencePreviewOpen && data.bukti_bayar_path && (
          <div
            className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs animate-in fade-in duration-150"
            onClick={() => setIsPaymentEvidencePreviewOpen(false)}
          >
            <div
              className="bg-stone-900 border border-stone-700 rounded-2xl max-w-2xl w-full p-4 space-y-3 shadow-2xl overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-stone-800 pb-3">
                <span className="text-sm font-bold text-stone-100">
                  Bukti Pembayaran — {data.guest_name || 'Tamu'}
                </span>
                <div className="flex items-center gap-2">
                  {paymentEvidenceBlobUrl && (
                    <button
                      type="button"
                      onClick={() => window.open(paymentEvidenceBlobUrl, '_blank')}
                      className="px-2.5 py-1 bg-stone-800 hover:bg-stone-700 text-stone-200 text-xs font-semibold rounded-lg border border-stone-600 transition-colors cursor-pointer"
                    >
                      Buka di Tab Baru ↗
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setIsPaymentEvidencePreviewOpen(false)}
                    className="text-stone-400 hover:text-white p-1 rounded-lg text-lg leading-none cursor-pointer"
                  >
                    ✕
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-center bg-stone-950/60 rounded-xl p-2 min-h-[300px] max-h-[70vh] overflow-auto">
                {paymentEvidenceLoading ? (
                  <div className="flex flex-col items-center justify-center py-12 text-stone-400 text-xs gap-2">
                    <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                    <span>Mengunduh bukti pembayaran...</span>
                  </div>
                ) : paymentEvidenceError ? (
                  <div className="text-center p-8 text-rose-400 text-xs space-y-1">
                    <div className="text-2xl">⚠️</div>
                    <p className="font-bold">{paymentEvidenceError}</p>
                    <p className="text-stone-500 text-[11px]">Pastikan file bukti pembayaran masih tersedia.</p>
                  </div>
                ) : paymentEvidenceBlobUrl ? (
                  data.bukti_bayar_path.toLowerCase().endsWith('.pdf') ? (
                    <iframe
                      src={paymentEvidenceBlobUrl}
                      title="Bukti Pembayaran"
                      className="w-full h-[60vh] rounded-lg border-0"
                    />
                  ) : (
                    <img
                      src={paymentEvidenceBlobUrl}
                      alt="Bukti Pembayaran"
                      className="max-h-[65vh] max-w-full object-contain rounded-lg shadow-md"
                    />
                  )
                ) : null}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

