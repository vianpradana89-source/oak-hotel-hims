import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Modal } from '../../design-system/Modal';
import { useAuth } from '../auth/AuthContext';
import { safeFetchJson } from '../calendar/calendarApi';
import type { Deposit, IdentityCustodyRecord } from './depositApi';
import {
  deriveCheckoutGateDecision,
  formatGroupGuaranteeSummary,
  type CheckoutGateDecision,
  type GuaranteeLoadStatus,
} from './guaranteeScopePolicy';

export interface CheckoutGuaranteeConfirmationModalProps {
  isOpen: boolean;
  reservationId: number | null;
  propertyId: number | null;
  reservationData?: any;
  onClose: () => void;
  onConfirmCheckout: (reservationId: number) => Promise<any> | any;
  onOpenGuaranteeSection?: (reservationId: number) => void;
}

export const CheckoutGuaranteeConfirmationModal: React.FC<CheckoutGuaranteeConfirmationModalProps> = ({
  isOpen,
  reservationId,
  propertyId,
  reservationData,
  onClose,
  onConfirmCheckout,
  onOpenGuaranteeSection,
}) => {
  const { authFetch } = useAuth();
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [hydratedRes, setHydratedRes] = useState<any>(null);
  const [decision, setDecision] = useState<CheckoutGateDecision | null>(null);

  const targetReservationMatch =
    reservationData &&
    Number(reservationData?.id ?? reservationData?.reservation_id) === Number(reservationId)
      ? reservationData
      : null;

  const effectivePropId = propertyId ?? targetReservationMatch?.property_id ?? null;
  const requestIdRef = useRef<number>(0);

  const evaluateData = useCallback(
    async (targetId: number, propId: number | null) => {
      const currentReq = ++requestIdRef.current;
      setLoading(true);
      setDecision(null);

      try {
        const queryProp = propId ? `?property_id=${propId}` : '';
        const [resResp, depResp, custResp] = await Promise.all([
          safeFetchJson<{ data?: any }>(`/api/reservations/${targetId}${queryProp}`, undefined, undefined, authFetch),
          safeFetchJson<{ data?: Deposit[] }>(`/api/reservations/${targetId}/deposits${queryProp}`, undefined, undefined, authFetch),
          safeFetchJson<{ data?: IdentityCustodyRecord[] }>(`/api/reservations/${targetId}/identity-custody${queryProp}`, undefined, undefined, authFetch),
        ]);

        if (currentReq !== requestIdRef.current) return;

        const currentResMatch =
          reservationData &&
          Number(reservationData?.id ?? reservationData?.reservation_id) === targetId
            ? reservationData
            : null;

        const currentRes = resResp.ok && resResp.data?.data ? resResp.data.data : currentResMatch;
        setHydratedRes(currentRes);

        const siblingReservations =
          resResp.ok && resResp.data?.data && Array.isArray(resResp.data.data.sibling_reservations)
            ? resResp.data.data.sibling_reservations
            : null;

        const deposits = depResp.ok && Array.isArray(depResp.data?.data) ? depResp.data.data : null;
        const custody = custResp.ok && Array.isArray(custResp.data?.data) ? custResp.data.data : null;

        // Authoritative load status requires ALL:
        // - resResp.ok
        // - depResp.ok
        // - custResp.ok
        // - valid deposits payload
        // - valid custody payload
        // - valid siblingReservations from authoritative reservation detail fetch
        const loadStatus: GuaranteeLoadStatus =
          resResp.ok &&
          depResp.ok &&
          custResp.ok &&
          deposits !== null &&
          custody !== null &&
          siblingReservations !== null
            ? 'ready'
            : 'error';

        const dec = deriveCheckoutGateDecision({
          currentReservation: currentRes || { id: targetId, status: 'CHECKED_IN' },
          siblingReservations,
          deposits,
          custody,
          loadStatus,
        });

        setDecision(dec);
      } catch (err) {
        if (currentReq !== requestIdRef.current) return;
        console.error('[CheckoutGuaranteeModal] Failed to evaluate guarantee state:', err);
        const fallbackRes =
          reservationData &&
          Number(reservationData?.id ?? reservationData?.reservation_id) === targetId
            ? reservationData
            : { id: targetId, status: 'CHECKED_IN' };
        setDecision(
          deriveCheckoutGateDecision({
            currentReservation: fallbackRes,
            siblingReservations: null,
            deposits: null,
            custody: null,
            loadStatus: 'error',
          })
        );
      } finally {
        if (currentReq === requestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [authFetch, reservationData]
  );

  useEffect(() => {
    if (isOpen && reservationId) {
      setSubmitting(false);
      evaluateData(reservationId, effectivePropId);
    } else {
      setDecision(null);
      setHydratedRes(null);
      setSubmitting(false);
    }
  }, [isOpen, reservationId, effectivePropId, evaluateData]);

  if (!isOpen || !reservationId) return null;

  const handleConfirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onConfirmCheckout(reservationId);
      onClose();
    } catch (err) {
      console.error('[CheckoutGuaranteeModal] Checkout confirmation failed:', err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleOpenGuarantee = () => {
    onClose();
    if (onOpenGuaranteeSection) {
      onOpenGuaranteeSection(reservationId);
    }
  };

  const activeRes = hydratedRes || targetReservationMatch || {};
  const roomNumber = activeRes.room_number || '-';
  const guestName = activeRes.guest_name || activeRes.booker_name || 'Tamu';
  const bidText = activeRes.bid ? `#${activeRes.bid}` : 'Grup';

  const formatAmount = (val: number) => {
    return new Intl.NumberFormat('id-ID').format(Math.max(0, Math.round(val)));
  };

  // 1. Loading state
  if (loading || !decision) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title="Memeriksa Status Jaminan..." size="sm" closeOnOverlayClick={false}>
        <div className="py-6 flex flex-col items-center justify-center text-center space-y-3">
          <div className="w-8 h-8 border-3 border-amber-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-xs text-stone-500 font-medium">
            Sedang memeriksa jaminan kamar dan grup sebelum proses check-out...
          </p>
        </div>
      </Modal>
    );
  }

  // 2. HARD BLOCK: ROOM_RESERVATION physical identity custody is HELD
  if (decision.action === 'HARD_BLOCK_ROOM_IDENTITY') {
    const holderName = decision.heldRoomCustodyHolderName || guestName;
    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Tidak Dapat Memproses Check-out"
        size="sm"
        closeOnOverlayClick={false}
        footer={
          <div className="flex items-center justify-end gap-2 w-full">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 font-semibold text-xs rounded-xl border border-stone-200 transition-colors cursor-pointer"
            >
              Tutup
            </button>
            {onOpenGuaranteeSection && (
              <button
                type="button"
                onClick={handleOpenGuarantee}
                className="px-3.5 py-2 bg-emerald-800 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl shadow-xs transition-colors cursor-pointer"
              >
                Buka Bagian Jaminan
              </button>
            )}
          </div>
        }
      >
        <div className="space-y-3">
          <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-900 flex items-start gap-2.5">
            <span className="text-lg">🚫</span>
            <div className="text-xs leading-relaxed">
              <p className="font-semibold text-rose-950 mb-1">Dokumen Identitas Fisik Masih Ditahan</p>
              <p>
                KTP/SIM fisik atas nama <strong className="font-semibold">{holderName}</strong> masih ditahan untuk kamar ini. Kembalikan identitas tamu terlebih dahulu pada bagian Jaminan sebelum memproses check-out.
              </p>
            </div>
          </div>
        </div>
      </Modal>
    );
  }

  // 3. SOFT WARNING: ROOM DEPOSIT ONLY
  if (decision.action === 'WARN_ROOM_DEPOSIT') {
    const formattedAmount = formatAmount(decision.roomDepositRemaining);
    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Peringatan: Jaminan Kamar Belum Selesai"
        size="sm"
        closeOnOverlayClick={false}
        footer={
          <div className="flex items-center justify-end gap-2 w-full">
            <button
              type="button"
              disabled={submitting}
              onClick={onClose}
              className="px-3.5 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 font-semibold text-xs rounded-xl border border-stone-200 transition-colors cursor-pointer"
            >
              Batal / Periksa Jaminan
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={handleConfirm}
              className="px-3.5 py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white font-bold text-xs rounded-xl shadow-xs transition-colors cursor-pointer"
            >
              {submitting ? 'Memproses...' : 'Tetap Check-out'}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-900 flex items-start gap-2.5">
            <span className="text-lg">⚠️</span>
            <div className="text-xs leading-relaxed">
              <p>
                Kamar ini masih memiliki saldo Deposit Kamar sebesar <strong className="font-semibold">Rp {formattedAmount}</strong>. Deposit tidak dikembalikan otomatis saat check-out dan tetap tersimpan di antrean jaminan untuk pengembalian manual. Lanjutkan check-out?
              </p>
            </div>
          </div>
        </div>
      </Modal>
    );
  }

  // 4. SOFT WARNING: FINAL GROUP GUARANTEE
  if (decision.action === 'WARN_FINAL_GROUP_GUARANTEE') {
    const summaryText = formatGroupGuaranteeSummary(
      decision.groupGuaranteeSummary,
      decision.groupDepositRemaining > 0 ? formatAmount(decision.groupDepositRemaining) : undefined
    );
    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Check-out Kamar Terakhir — Jaminan Grup Siap Diselesaikan"
        size="sm"
        closeOnOverlayClick={false}
        footer={
          <div className="flex items-center justify-end gap-2 w-full">
            <button
              type="button"
              disabled={submitting}
              onClick={onClose}
              className="px-3.5 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 font-semibold text-xs rounded-xl border border-stone-200 transition-colors cursor-pointer"
            >
              Batal
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={handleConfirm}
              className="px-3.5 py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white font-bold text-xs rounded-xl shadow-xs transition-colors cursor-pointer"
            >
              {submitting ? 'Memproses...' : 'Lanjutkan Check-out'}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-900 flex items-start gap-2.5">
            <span className="text-lg">👥</span>
            <div className="text-xs leading-relaxed">
              <p>
                Ini adalah kamar terakhir yang aktif untuk pemesanan grup <strong className="font-semibold">{bidText}</strong>. Jaminan grup (<strong className="font-semibold">{summaryText}</strong>) akan tetap tercatat dan siap diselesaikan secara manual setelah check-out. Lanjutkan?
              </p>
            </div>
          </div>
        </div>
      </Modal>
    );
  }

  // 5. COMBINED WARNING: ROOM DEPOSIT + FINAL GROUP GUARANTEE
  if (decision.action === 'WARN_ROOM_AND_FINAL_GROUP') {
    const formattedRoomAmount = formatAmount(decision.roomDepositRemaining);
    const summaryText = formatGroupGuaranteeSummary(
      decision.groupGuaranteeSummary,
      decision.groupDepositRemaining > 0 ? formatAmount(decision.groupDepositRemaining) : undefined
    );
    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Check-out Kamar Terakhir — Jaminan Kamar & Grup Belum Selesai"
        size="sm"
        closeOnOverlayClick={false}
        footer={
          <div className="flex items-center justify-end gap-2 w-full">
            <button
              type="button"
              disabled={submitting}
              onClick={onClose}
              className="px-3.5 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 font-semibold text-xs rounded-xl border border-stone-200 transition-colors cursor-pointer"
            >
              Batal
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={handleConfirm}
              className="px-3.5 py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white font-bold text-xs rounded-xl shadow-xs transition-colors cursor-pointer"
            >
              {submitting ? 'Memproses...' : 'Lanjutkan Check-out'}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-900 flex items-start gap-2.5">
            <span className="text-lg">⚠️</span>
            <div className="text-xs leading-relaxed">
              <p>
                Kamar ini masih memiliki saldo Deposit Kamar sebesar <strong className="font-semibold">Rp {formattedRoomAmount}</strong>, dan merupakan kamar terakhir yang aktif untuk pemesanan grup <strong className="font-semibold">{bidText}</strong> dengan jaminan grup (<strong className="font-semibold">{summaryText}</strong>) yang belum diselesaikan. Seluruh jaminan akan tetap tercatat dan siap diselesaikan secara manual setelah check-out. Lanjutkan?
              </p>
            </div>
          </div>
        </div>
      </Modal>
    );
  }

  // 6. FAIL SAFE: UNVERIFIED GUARANTEE STATUS
  if (decision.action === 'WARN_UNVERIFIED') {
    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Status Jaminan Belum Dapat Diverifikasi"
        size="sm"
        closeOnOverlayClick={false}
        footer={
          <div className="flex items-center justify-end gap-2 w-full">
            <button
              type="button"
              disabled={submitting}
              onClick={onClose}
              className="px-3.5 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 font-semibold text-xs rounded-xl border border-stone-200 transition-colors cursor-pointer"
            >
              Batal
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={handleConfirm}
              className="px-3.5 py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white font-bold text-xs rounded-xl shadow-xs transition-colors cursor-pointer"
            >
              {submitting ? 'Memproses...' : 'Tetap Check-out'}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-900 flex items-start gap-2.5">
            <span className="text-lg">⚠️</span>
            <div className="text-xs leading-relaxed">
              <p>
                Data jaminan untuk kamar ini belum dapat diverifikasi dengan aman. Periksa status jaminan terlebih dahulu sebelum check-out untuk menghindari jaminan yang belum terselesaikan.
              </p>
            </div>
          </div>
        </div>
      </Modal>
    );
  }

  // 7. CLEAN CONFIRMATION: ALLOW
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Konfirmasi Check-out"
      size="sm"
      closeOnOverlayClick={false}
      footer={
        <div className="flex items-center justify-end gap-2 w-full">
          <button
            type="button"
            disabled={submitting}
            onClick={onClose}
            className="px-3.5 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 font-semibold text-xs rounded-xl border border-stone-200 transition-colors cursor-pointer"
          >
            Batal
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={handleConfirm}
            className="px-3.5 py-2 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white font-bold text-xs rounded-xl shadow-xs transition-colors cursor-pointer"
          >
            {submitting ? 'Memproses...' : 'Check-out'}
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-xs text-stone-700 leading-relaxed">
        <p>
          Apakah Anda yakin ingin memproses check-out untuk Kamar <strong className="font-semibold text-stone-900">{roomNumber}</strong> ({guestName})?
        </p>
      </div>
    </Modal>
  );
};
