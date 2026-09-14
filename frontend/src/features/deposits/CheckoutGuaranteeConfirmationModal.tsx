import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Modal } from '../../design-system/Modal';
import { useAuth } from '../auth/AuthContext';
import { safeFetchJson } from '../calendar/calendarApi';
import type { Deposit, IdentityCustodyRecord } from './depositApi';
import {
  deriveCheckoutGateDecision,
  formatGroupGuaranteeSummary,
  type GuaranteeLoadStatus,
} from './guaranteeScopePolicy';

export interface CheckoutGateState {
  action:
    | 'ALLOW'
    | 'HARD_BLOCK_ROOM_IDENTITY'
    | 'HARD_BLOCK_FOLIO_OUTSTANDING'
    | 'HARD_BLOCK_FOLIO_UNVERIFIED'
    | 'WARN_ROOM_DEPOSIT'
    | 'WARN_FINAL_GROUP_GUARANTEE'
    | 'WARN_ROOM_AND_FINAL_GROUP'
    | 'WARN_UNVERIFIED';
  reasonCode?: string;
  // room identity
  heldRoomCustodyHolderName?: string;
  // folio
  remainingBalance?: number;
  appliedDeposit?: number;
  totalCharges?: number;
  // room deposit
  roomDepositRemaining?: number;
  // group guarantee
  groupGuaranteeSummary?: any;
  groupDepositRemaining?: number;
}

export interface CheckoutGuaranteeConfirmationModalProps {
  isOpen: boolean;
  reservationId: number | null;
  propertyId: number | null;
  reservationData?: any;
  onClose: () => void;
  onConfirmCheckout: (reservationId: number) => Promise<any> | any;
  onOpenGuaranteeSection?: (reservationId: number) => void;
  onOpenFolioSection?: (reservationId: number) => void;
}

export const CheckoutGuaranteeConfirmationModal: React.FC<CheckoutGuaranteeConfirmationModalProps> = ({
  isOpen,
  reservationId,
  propertyId,
  reservationData,
  onClose,
  onConfirmCheckout,
  onOpenGuaranteeSection,
  onOpenFolioSection,
}) => {
  const { authFetch } = useAuth();
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [hydratedRes, setHydratedRes] = useState<any>(null);
  const [decision, setDecision] = useState<CheckoutGateState | null>(null);

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

        // FOLIO GATE: authoritative financial verification via backend endpoint.
        // Hard fail on any fetch error — no fallback to reservationData.
        let folioBalance = 0;
        let appliedDeposit = 0;
        let totalCharges = 0;
        let folioError = false;

        try {
          const folioResp = await safeFetchJson<{ data?: any }>(
            `/api/reservations/${targetId}/folio${queryProp}`,
            undefined,
            undefined,
            authFetch
          );
          if (!folioResp.ok || !folioResp.data?.data?.reservation) {
            folioError = true;
          } else {
            const fr = folioResp.data.data.reservation;
            totalCharges = Number(fr.total_price || 0);
            appliedDeposit = Number(fr.applied_deposit || 0);
            const ordinaryPaid = Number(fr.amount_paid || 0);
            // Compute from authoritative fields to match backend recalculateReservationFinancials:
            // remainingBalance = max(0, netTotalCharges - (ordinaryAmountPaid + appliedDeposit))
            folioBalance = Math.max(0, totalCharges - ordinaryPaid - appliedDeposit);
          }
        } catch (e) {
          console.warn('[CheckoutGuaranteeModal] Folio fetch failed:', e);
          folioError = true;
        }

        // Set guarantee state first when possible; folio override below may replace it.
        const loadStatus: GuaranteeLoadStatus =
          currentRes !== null &&
          siblingReservations !== null &&
          deposits !== null &&
          custody !== null
            ? 'ready'
            : 'error';

        const guaranteeDecision = deriveCheckoutGateDecision({
          currentReservation: currentRes || { id: targetId, status: 'CHECKED_IN' },
          siblingReservations,
          deposits,
          custody,
          loadStatus,
        });

        // FOLIO GATE takes precedence over GUARANTEE GATE:
        // HARD_BLOCK_FOLIO and HARD_BLOCK_FOLIO_UNVERIFIED prevent proceeding entirely.
        if (folioError) {
          setDecision({
            action: 'HARD_BLOCK_FOLIO_UNVERIFIED',
            reasonCode: 'FOLIO_BALANCE_UNVERIFIED',
            remainingBalance: NaN,
            appliedDeposit,
            totalCharges,
          });
          return;
        }

        if (folioBalance > 0.01) {
          setDecision({
            action: 'HARD_BLOCK_FOLIO_OUTSTANDING',
            reasonCode: 'FOLIO_BALANCE_OUTSTANDING',
            remainingBalance: folioBalance,
            appliedDeposit,
            totalCharges,
          });
          return;
        }

        // Fall through to guarantee decisions when folio is clear.
        // Preserve original action strings from guaranteeScopePolicy (ALLOW, WARN_*, etc.).
        setDecision({
          ...guaranteeDecision,
          appliedDeposit,
          totalCharges,
        });
      } catch (err) {
        if (currentReq !== requestIdRef.current) return;
        console.error('[CheckoutGuaranteeModal] Failed to evaluate state:', err);
        setDecision({
          action: 'HARD_BLOCK_FOLIO_UNVERIFIED',
          reasonCode: 'FOLIO_BALANCE_UNVERIFIED',
          remainingBalance: NaN,
        });
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
      setLoading(false);
      setHydratedRes(null);
    }
  }, [isOpen, reservationId, evaluateData, effectivePropId]);

  const handleCheckout = useCallback(async () => {
    if (!reservationId || submitting) return;
    setSubmitting(true);
    try {
      await onConfirmCheckout(reservationId);
    } finally {
      setSubmitting(false);
    }
  }, [reservationId, submitting, onConfirmCheckout]);

  const currentRes = hydratedRes;
  const roomNumber = currentRes?.room_number ?? '—';
  const guestName = currentRes?.guest_name ?? '—';

  if (!isOpen || reservationId === null) return null;

  if (loading) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title="Verifikasi Check-out" size="sm">
        <div className="py-6 flex flex-col items-center gap-3 text-stone-600">
          <svg className="w-8 h-8 animate-spin text-forest-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          <span className="text-xs">Memverifikasi folio dan jaminan…</span>
        </div>
      </Modal>
    );
  }

  if (!decision) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title="Check-out Reservasi" size="sm">
        <div className="space-y-4 text-xs text-stone-700 leading-relaxed">
          <p>
            <strong>Kamar:</strong> {roomNumber}
          </p>
          <p>
            <strong>Tamu:</strong> {guestName}
          </p>
          <p>
            <strong>Masa inap:</strong> {currentRes?.check_in ?? '—'} → {currentRes?.check_out ?? '—'}
          </p>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="btn btn-ghost text-xs"
            onClick={onClose}
            disabled={submitting}
          >
            Batal
          </button>
          <button
            type="button"
            className="btn btn-primary text-xs"
            onClick={handleCheckout}
            disabled={submitting}
          >
            {submitting ? 'Memproses…' : 'Proses Check-out'}
          </button>
        </div>
      </Modal>
    );
  }

  // 1. HARD BLOCK: Identity custody not returned
  if (decision.action === 'HARD_BLOCK_ROOM_IDENTITY') {
    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Check-out Diblokir: Identitas Fisik Belum Dikembalikan"
        size="sm"
        closeOnOverlayClick={false}
        footer={
          <button
            type="button"
            className="btn btn-primary text-xs"
            onClick={onClose}
            disabled={submitting}
          >
            Tutup
          </button>
        }
      >
        <div className="space-y-3 text-xs text-stone-700 leading-relaxed">
          <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-900 flex items-start gap-2.5">
            <span className="text-lg">🚫</span>
            <div className="text-xs leading-relaxed">
              <p className="font-semibold text-rose-950 mb-1">Dokumen Identitas Fisik Masih Ditahan</p>
              <p>
                Checkout untuk Kamar <strong className="font-semibold">{roomNumber}</strong> ({guestName}) tidak dapat diproses karena dokumen identitas fisik belum dikembalikan ke hotel.
              </p>
            </div>
          </div>
          <p className="text-stone-600">
            Hubungi Front Office untuk menyelesaikan pengembalian dokumen sebelum melanjutkan check-out.
          </p>
        </div>
      </Modal>
    );
  }

  // 2. HARD BLOCK: Folio balance outstanding
  if (decision.action === 'HARD_BLOCK_FOLIO_OUTSTANDING') {
    const balance = Number(decision.remainingBalance ?? 0);
    const formattedBalance = new Intl.NumberFormat('id-ID').format(balance);
    const formattedApplied = decision.appliedDeposit
      ? new Intl.NumberFormat('id-ID').format(Number(decision.appliedDeposit))
      : null;

    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Check-out Diblokir: Saldo Folio Belum Lunas"
        size="sm"
        closeOnOverlayClick={false}
        footer={
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-ghost text-xs"
              onClick={onClose}
              disabled={submitting}
            >
              Tutup
            </button>
            {onOpenFolioSection && reservationId && (
              <button
                type="button"
                className="btn btn-primary text-xs"
                onClick={() => onOpenFolioSection(reservationId)}
                disabled={submitting}
              >
                Buka Folio
              </button>
            )}
          </div>
        }
      >
        <div className="space-y-3">
          <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-900 flex items-start gap-2.5">
            <span className="text-lg">🚫</span>
            <div className="text-xs leading-relaxed">
              <p className="font-semibold text-rose-950 mb-1">Folio Reservasi Belum Seimbang</p>
              <p>
                Checkout untuk Kamar <strong className="font-semibold">{roomNumber}</strong> tidak dapat diproses karena masih ada sisa pembayaran sebesar{' '}
                <strong className="font-semibold text-rose-950">Rp {formattedBalance}</strong>.
                {Number(decision.appliedDeposit ?? 0) > 0 ? (
                  <span className="mt-1 block">
                    (Sudah terdapat deposit yang diterapkan: Rp {formattedApplied})
                  </span>
                ) : (
                  <span className="mt-1 block">
                    (Belum terdapat pembayaran atau deposit yang diterapkan.)
                  </span>
                )}
              </p>
              <p className="mt-2 text-rose-800">
                Selesaikan pembayaran atau terapkan deposit yang tersedia di bagian Folio sebelum melakukan check-out.
              </p>
            </div>
          </div>
        </div>
      </Modal>
    );
  }

  // 3. HARD BLOCK: Folio unverified
  if (decision.action === 'HARD_BLOCK_FOLIO_UNVERIFIED') {
    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Check-out Diblokir: Data Folio Tidak Dapat Diverifikasi"
        size="sm"
        closeOnOverlayClick={false}
        footer={
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-ghost text-xs"
              onClick={onClose}
              disabled={submitting}
            >
              Tutup
            </button>
            {onOpenFolioSection && reservationId && (
              <button
                type="button"
                className="btn btn-primary text-xs"
                onClick={() => onOpenFolioSection(reservationId)}
                disabled={submitting}
              >
                Buka Folio
              </button>
            )}
          </div>
        }
      >
        <div className="space-y-3">
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-900 flex items-start gap-2.5">
            <span className="text-lg">⚠️</span>
            <div className="text-xs leading-relaxed">
              <p className="font-semibold text-amber-950 mb-1">Data Keuangan Reservasi Tidak Lengkap</p>
              <p>
                Checkout untuk Kamar <strong className="font-semibold">{roomNumber}</strong> ({guestName}) tidak dapat diproses karena data keuangan reservasi tidak dapat diverifikasi.
              </p>
              <p className="mt-2 text-amber-800">
                Silakan periksa folio terlebih dahulu sebelum melakukan check-out.
              </p>
            </div>
          </div>
        </div>
      </Modal>
    );
  }

  // 4. CLEAN ALLOW: No issues
  if (decision.action === 'ALLOW') {
    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Konfirmasi Check-out"
        size="sm"
        footer={
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-ghost text-xs"
              onClick={onClose}
              disabled={submitting}
            >
              Batal
            </button>
            <button
              type="button"
              className="btn btn-primary text-xs"
              onClick={handleCheckout}
              disabled={submitting}
            >
              {submitting ? 'Memproses…' : 'Proses Check-out'}
            </button>
          </div>
        }
      >
        <div className="space-y-3 text-xs text-stone-700 leading-relaxed">
          <p>
            Apakah Anda yakin ingin memproses check-out untuk Kamar <strong className="font-semibold text-stone-900">{roomNumber}</strong> ({guestName})?
          </p>
          {Number(decision.totalCharges ?? 0) > 0 && (
            <div className="p-2.5 bg-stone-50 rounded-lg border border-stone-200 space-y-1">
              <div className="flex justify-between">
                <span className="text-stone-500">Total Tagihan:</span>
                <strong className="text-stone-800">Rp {new Intl.NumberFormat('id-ID').format(Number(decision.totalCharges ?? 0))}</strong>
              </div>
              {Number(decision.appliedDeposit ?? 0) > 0 && (
                <div className="flex justify-between">
                  <span className="text-stone-500">Deposit Diterapkan:</span>
                  <span className="text-emerald-700 font-semibold">- Rp {new Intl.NumberFormat('id-ID').format(Number(decision.appliedDeposit ?? 0))}</span>
                </div>
              )}
              <div className="flex justify-between border-t border-stone-200 pt-1 mt-1">
                <span className="text-stone-500">Sisa Pembayaran:</span>
                <strong className="text-emerald-700 font-semibold">Rp 0</strong>
              </div>
            </div>
          )}
        </div>
      </Modal>
    );
  }

  // 5. SOFT WARNING: ROOM DEPOSIT ONLY
  if (decision.action === 'WARN_ROOM_DEPOSIT') {
    const formattedAmount = new Intl.NumberFormat('id-ID').format(Number(decision.roomDepositRemaining ?? 0));
    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Peringatan: Jaminan Kamar Belum Selesai"
        size="sm"
        closeOnOverlayClick={false}
        footer={
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-ghost text-xs"
              onClick={onClose}
              disabled={submitting}
            >
              Batal
            </button>
            <button
              type="button"
              className="btn btn-warning text-xs"
              onClick={() => onOpenGuaranteeSection?.(reservationId ?? 0)}
              disabled={submitting}
            >
              Selesaikan Jaminan
            </button>
            <button
              type="button"
              className="btn btn-primary text-xs"
              onClick={handleCheckout}
              disabled={submitting}
            >
              Tetap Lanjutkan
            </button>
          </div>
        }
      >
        <div className="space-y-3 text-xs text-stone-700 leading-relaxed">
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-900">
            <p className="font-semibold mb-1">Jaminan Kamar: Belum Selesai</p>
            <p>Sisa jaminan kamar sebesar <strong>Rp {formattedAmount}</strong> belum diselesaikan.</p>
          </div>
          <p className="text-stone-600">
            Anda dapat menyelesaikan jaminan terlebih dahulu atau melanjutkan check-out.
          </p>
        </div>
      </Modal>
    );
  }

  // 6. SOFT WARNING: FINAL GROUP GUARANTEE
  if (decision.action === 'WARN_FINAL_GROUP_GUARANTEE') {
    const summaryText = formatGroupGuaranteeSummary(
      decision.groupGuaranteeSummary,
      Number(decision.groupDepositRemaining ?? 0) > 0
        ? new Intl.NumberFormat('id-ID').format(Number(decision.groupDepositRemaining ?? 0))
        : undefined
    );
    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Check-out Kamar Terakhir — Jaminan Grup Siap Diselesaikan"
        size="sm"
        closeOnOverlayClick={false}
        footer={
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-ghost text-xs"
              onClick={onClose}
              disabled={submitting}
            >
              Batal
            </button>
            <button
              type="button"
              className="btn btn-warning text-xs"
              onClick={() => onOpenGuaranteeSection?.(reservationId ?? 0)}
              disabled={submitting}
            >
              Selesaikan Jaminan
            </button>
            <button
              type="button"
              className="btn btn-primary text-xs"
              onClick={handleCheckout}
              disabled={submitting}
            >
              Tetap Lanjutkan
            </button>
          </div>
        }
      >
        <div className="space-y-3 text-xs text-stone-700 leading-relaxed">
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-900">
            <p className="font-semibold mb-1">Jaminan Grup: Belum Selesai</p>
            <p dangerouslySetInnerHTML={{ __html: summaryText }} />
          </div>
        </div>
      </Modal>
    );
  }

  // 7. COMBINED WARNING: ROOM DEPOSIT + FINAL GROUP GUARANTEE
  if (decision.action === 'WARN_ROOM_AND_FINAL_GROUP') {
    const formattedRoomAmount = new Intl.NumberFormat('id-ID').format(Number(decision.roomDepositRemaining ?? 0));
    const summaryText = formatGroupGuaranteeSummary(
      decision.groupGuaranteeSummary,
      Number(decision.groupDepositRemaining ?? 0) > 0
        ? new Intl.NumberFormat('id-ID').format(Number(decision.groupDepositRemaining ?? 0))
        : undefined
    );
    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Check-out Kamar Terakhir — Jaminan Kamar & Grup Belum Selesai"
        size="sm"
        closeOnOverlayClick={false}
        footer={
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-ghost text-xs"
              onClick={onClose}
              disabled={submitting}
            >
              Batal
            </button>
            <button
              type="button"
              className="btn btn-warning text-xs"
              onClick={() => onOpenGuaranteeSection?.(reservationId ?? 0)}
              disabled={submitting}
            >
              Selesaikan Jaminan
            </button>
            <button
              type="button"
              className="btn btn-primary text-xs"
              onClick={handleCheckout}
              disabled={submitting}
            >
              Tetap Lanjutkan
            </button>
          </div>
        }
      >
        <div className="space-y-3 text-xs text-stone-700 leading-relaxed">
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-900">
            <p className="font-semibold mb-1">Jaminan Kamar: {formattedRoomAmount} Belum Selesai</p>
          </div>
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-900">
            <p className="font-semibold mb-1">Jaminan Grup: Belum Selesai</p>
            <p dangerouslySetInnerHTML={{ __html: summaryText }} />
          </div>
        </div>
      </Modal>
    );
  }

  // 8. WARN_UNVERIFIED: Fallback for unknown state
  if (decision.action === 'WARN_UNVERIFIED') {
    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Peringatan: Verifikasi Jaminan Gagal"
        size="sm"
        closeOnOverlayClick={false}
        footer={
          <button
            type="button"
            className="btn btn-primary text-xs"
            onClick={onClose}
            disabled={submitting}
          >
            Tutup
          </button>
        }
      >
        <div className="space-y-3 text-xs text-stone-700 leading-relaxed">
          <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-900">
            <p className="font-semibold mb-1">Verifikasi Jaminan Gagal</p>
            <p>
              {decision.reasonCode === 'NO_GUARANTEE_CONFIGURED'
                ? 'Tidak ada konfigurasi jaminan untuk properti ini.'
                : 'Tidak dapat memverifikasi status jaminan. Silakan periksa pengaturan jaminan properti.'}
            </p>
          </div>
        </div>
      </Modal>
    );
  }

  return null;
};
