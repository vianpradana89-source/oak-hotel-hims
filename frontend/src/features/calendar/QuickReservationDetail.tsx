import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { normalizeHotelDate } from './calendarDates';
import { safeFetchJson } from './calendarApi';
import { EditReservationModal } from './EditReservationModal';

export interface QuickReservationDetailProps {
  reservation: any;
  anchorRect?: DOMRect | null;
  anchorPoint?: { x: number; y: number } | null;
  propertyId?: number | null;
  onClose: () => void;
  onOpenFullDetail: (reservation: any) => void;
  onCheckin?: (reservationId: number) => void;
  onCheckout?: (reservationId: number) => void;
  onCancel?: (reservationId: number) => void;
  onOpenStayChange?: (reservation: any, mode: 'extend' | 'shorten') => void;
  onRefresh?: () => void;
}

export default function QuickReservationDetail({
  reservation,
  anchorRect,
  anchorPoint,
  propertyId,
  onClose,
  onOpenFullDetail,
  onCheckin,
  onCheckout,
  onCancel,
  onOpenStayChange,
  onRefresh
}: QuickReservationDetailProps) {
  const [fullData, setFullData] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [isMoreActionsOpen, setIsMoreActionsOpen] = useState<boolean>(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState<boolean>(false);
  const [bidCopied, setBidCopied] = useState<boolean>(false);
  const [requestingInspection, setRequestingInspection] = useState<boolean>(false);
  const [inspectionFeedback, setInspectionFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number }>({ top: 100, left: 100 });
  const popoverRef = useRef<HTMLDivElement>(null);
  const moreActionsRef = useRef<HTMLDivElement>(null);

  // Strict property resolution: active property context OR canonical reservation.property_id
  // NEVER silently default to Property 1.
  const activePropId: number | null = (propertyId ?? reservation?.property_id) ? Number(propertyId || reservation?.property_id) : null;
  const isPropertyMissing = !activePropId;

  // Hydrate canonical reservation detail
  useEffect(() => {
    let isMounted = true;

    if (!activePropId) {
      setLoading(false);
      return;
    }

    setLoading(true);

    const loadData = async () => {
      try {
        const result = await safeFetchJson<{ data?: any }>(
          `/api/reservations/${reservation.id}?property_id=${activePropId}`,
          undefined,
          'Data operasional reservasi belum dapat dimuat.'
        );
        if (result.ok && result.data?.data && isMounted) {
          setFullData(result.data.data);
        }
      } catch (err) {
        console.warn('[QuickDetail] Failed to hydrate canonical reservation detail:', err);
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    loadData();
    return () => {
      isMounted = false;
    };
  }, [reservation.id, activePropId]);

  // Viewport-aware positioning & flip calculation
  const updatePosition = useCallback(() => {
    if (typeof window === 'undefined') return;
    const isMobile = window.innerWidth < 640;
    if (isMobile) return;

    const cardWidth = 360;
    const padding = 16;
    const measuredHeight = popoverRef.current?.offsetHeight || 440;

    let left = (window.innerWidth - cardWidth) / 2;
    let top = (window.innerHeight - measuredHeight) / 2;

    if (anchorRect) {
      // Horizontal positioning centered on clicked block
      left = anchorRect.left + anchorRect.width / 2 - cardWidth / 2;

      const spaceBelow = window.innerHeight - anchorRect.bottom - padding;
      const spaceAbove = anchorRect.top - padding;

      if (spaceBelow >= measuredHeight + 8) {
        // Enough space below -> open below
        top = anchorRect.bottom + 8;
      } else if (spaceAbove >= measuredHeight + 8) {
        // Not enough space below, but enough above -> flip above
        top = anchorRect.top - measuredHeight - 8;
      } else {
        // Neither fits without clipping -> clamp vertically within safe viewport
        if (spaceBelow >= spaceAbove) {
          top = Math.max(padding, anchorRect.bottom + 8);
        } else {
          top = Math.max(padding, anchorRect.top - measuredHeight - 8);
        }
        top = Math.min(top, window.innerHeight - measuredHeight - padding);
        top = Math.max(padding, top);
      }

      // Clamp horizontally within viewport margins
      left = Math.max(padding, Math.min(left, window.innerWidth - cardWidth - padding));
    } else if (anchorPoint) {
      left = Math.max(padding, Math.min(anchorPoint.x - cardWidth / 2, window.innerWidth - cardWidth - padding));
      top = Math.max(padding, Math.min(anchorPoint.y + 12, window.innerHeight - measuredHeight - padding));
    }

    setPopoverPos({ top, left });
  }, [anchorRect, anchorPoint]);

  // Position recalculation when content, loading, or viewport size changes
  useLayoutEffect(() => {
    updatePosition();
  }, [updatePosition, loading, fullData, inspectionFeedback, isMoreActionsOpen]);

  useEffect(() => {
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [updatePosition]);

  // Close on Escape or outside click
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isMoreActionsOpen) {
          setIsMoreActionsOpen(false);
        } else {
          onClose();
        }
      }
    };

    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
      if (moreActionsRef.current && !moreActionsRef.current.contains(e.target as Node)) {
        setIsMoreActionsOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [onClose, isMoreActionsOpen]);

  const data = fullData || reservation;

  const status = String(data.status || 'BOOKED').toUpperCase();
  const isBooked = status === 'BOOKED';
  const isCheckedIn = status === 'CHECKED_IN';
  const isCheckedOut = status === 'CHECKED_OUT';
  const isCancelled = status === 'CANCELLED';

  const guestName = data.guest_name || data.booker_name || 'Tamu';
  const guestPhone = data.guest_phone || data.booker_phone || data.phone || '';
  const roomNumber = data.room_number ? `Kamar ${data.room_number}` : 'Belum Ditentukan';
  const roomTypeName = data.room_type_name || data.room_type || data.room_variant || 'Standard Room';
  const bid = String(data.bid || data.booking_bid || data.booking_number || `#${data.id}`);

  const checkIn = normalizeHotelDate(data.check_in) || String(data.check_in || '').slice(0, 10);
  const checkOut = normalizeHotelDate(data.check_out) || String(data.check_out || '').slice(0, 10);
  const nights = Number(data.nights || data.num_nights || 1);
  const isDayUse = data.stay_type === 'DAY_USE';

  // Booking Source Formatting
  const formatBookingSource = () => {
    if (data.ota_source_name) {
      return `OTA — ${data.ota_source_name}`;
    }
    const channel = String(data.channel || '').toUpperCase();
    const source = String(data.booking_source || '').toUpperCase();
    if (source.includes('OTA') || channel.includes('OTA')) {
      return `OTA — ${data.booking_source || 'Online Agent'}`;
    }
    if (source === 'WALKIN' || channel === 'FRONT_DESK' || source === 'FRONT_DESK') {
      return 'Direct / Walk-in';
    }
    if (source === 'ONLINE_DIRECT' || source === 'WEBSITE') {
      return 'Direct / Website';
    }
    if (source === 'PHONE' || source === 'WHATSAPP') {
      return 'Direct / WhatsApp';
    }
    return data.booking_source || data.channel || 'Direct / Front Office';
  };

  // Financial status & values
  const totalPrice = Number(data.total_price || 0);
  const amountPaid = Number(data.amount_paid || 0);
  const remainingBalance = Math.max(0, Number(data.remaining_balance ?? Math.max(0, totalPrice - amountPaid)));

  const getPaymentStatus = () => {
    const pStatus = String(data.payment_status || '').toUpperCase();
    if (pStatus === 'PAID' || pStatus === 'LUNAS' || (totalPrice > 0 && amountPaid >= totalPrice)) {
      return { label: 'Lunas', badgeClass: 'bg-emerald-50 text-emerald-800 border-emerald-200' };
    }
    if (pStatus === 'PARTIAL' || pStatus === 'SEBAGIAN' || (amountPaid > 0 && amountPaid < totalPrice)) {
      return { label: 'Sebagian', badgeClass: 'bg-amber-50 text-amber-800 border-amber-200' };
    }
    return { label: 'Belum Bayar', badgeClass: 'bg-rose-50 text-rose-800 border-rose-200' };
  };

  const paymentStatus = getPaymentStatus();

  // Check-in readiness check
  const hasPhone = Boolean(guestPhone && String(guestPhone).trim().length >= 6);
  const hasIdentity = Boolean(data.ktp_image_url || data.identity_number || data.identity_type);
  const isCheckinReady = hasPhone && hasIdentity;

  const handleCopyBid = async () => {
    try {
      await navigator.clipboard.writeText(bid);
      setBidCopied(true);
      setTimeout(() => setBidCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleRequestInspection = async () => {
    if (!activePropId) return;
    try {
      setRequestingInspection(true);
      setInspectionFeedback(null);
      const url = '/api/housekeeping/checkout-room-check';
      const result = await safeFetchJson(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            property_id: activePropId,
            reservation_id: data.id,
            room_id: data.room_id || data.room?.id,
            requested_by_name: 'Front Office',
            requested_by_role: 'Receptionist'
          })
        },
        'Status pemeriksaan belum dapat dimuat. Coba lagi.'
      );

      if (result.ok && (result.data?.status === 'OK' || result.data?.success)) {
        setInspectionFeedback({ type: 'success', text: 'Permintaan pemeriksaan kamar berhasil dikirim ke Housekeeping.' });
        onRefresh?.();
        const fresh = await safeFetchJson<{ data?: any }>(`/api/reservations/${data.id}?property_id=${activePropId}`);
        if (fresh.ok && fresh.data?.data) {
          setFullData(fresh.data.data);
        }
      } else {
        const errorMsg = result.errorMessage || 'Status pemeriksaan belum dapat dimuat. Coba lagi.';
        setInspectionFeedback({ type: 'error', text: errorMsg });
      }
    } catch (err: any) {
      console.warn('[QuickDetail] Unexpected error during inspection request:', err);
      setInspectionFeedback({ type: 'error', text: 'Status pemeriksaan belum dapat dimuat. Coba lagi.' });
    } finally {
      setRequestingInspection(false);
    }
  };

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;

  return (
    <>
      {/* Context Backdrop: transparent/subtle click-catcher to preserve calendar visibility */}
      <div
        className="fixed inset-0 z-50 bg-black/20 backdrop-blur-[0.5px] transition-opacity"
        aria-hidden="true"
        onClick={onClose}
      />

      {/* Quick Detail Card / Popover Container */}
      <div
        ref={popoverRef}
        style={
          isMobile
            ? undefined
            : {
                position: 'fixed',
                top: `${popoverPos.top}px`,
                left: `${popoverPos.left}px`,
                width: '360px',
                maxHeight: 'calc(100vh - 32px)',
                zIndex: 60
              }
        }
        role="dialog"
        aria-label="Ringkasan Cepat Reservasi"
        className={`z-60 bg-white rounded-2xl shadow-2xl border border-stone-200 overflow-hidden flex flex-col ${
          isMobile
            ? 'fixed bottom-0 inset-x-0 rounded-b-none max-h-[85vh] animate-in slide-in-from-bottom duration-200'
            : 'animate-in fade-in zoom-in-95 duration-150'
        }`}
      >
        {/* Header (flex-shrink-0) */}
        <div className="flex-shrink-0 px-4 py-3 bg-stone-50 border-b border-stone-200 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`text-xs px-2 py-0.5 rounded-full font-bold uppercase tracking-wider border shrink-0 ${
                isBooked
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                  : isCheckedIn
                  ? 'bg-sky-50 text-sky-800 border-sky-300'
                  : isCheckedOut
                  ? 'bg-stone-100 text-stone-700 border-stone-300'
                  : 'bg-rose-50 text-rose-800 border-rose-300'
              }`}
            >
              {status}
            </span>
            <h3 className="text-base font-bold text-stone-900 truncate" title={guestName}>
              {guestName}
            </h3>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-200 text-base font-bold transition-colors cursor-pointer shrink-0"
            aria-label="Tutup Ringkasan"
          >
            ✕
          </button>
        </div>

        {/* Scrollable Content Body (flex-1 min-h-0 overflow-y-auto) */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3.5 text-xs text-stone-700">
          {/* Missing property safety alert */}
          {isPropertyMissing && (
            <div className="p-3 bg-amber-50 border border-amber-200 text-amber-900 rounded-xl text-xs font-medium space-y-1">
              <div className="font-bold flex items-center gap-1.5">
                <span>⚠️</span>
                <span>Properti aktif tidak tersedia.</span>
              </div>
              <p className="text-amber-800 text-[11px]">
                Aksi operasional dinonaktifkan sampai konteks properti valid.
              </p>
            </div>
          )}

          {/* Identity & Room Block */}
          <div className="p-3 bg-stone-50/80 rounded-xl border border-stone-200 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-1.5 font-mono text-stone-600 font-medium">
                <span>{bid}</span>
                <button
                  type="button"
                  onClick={handleCopyBid}
                  className="px-1.5 py-0.5 rounded bg-white hover:bg-stone-100 text-stone-600 border border-stone-200 text-[11px] font-sans font-medium transition-colors cursor-pointer"
                  title="Salin Nomor BID"
                >
                  {bidCopied ? 'Tersalin ✓' : 'Salin'}
                </button>
              </div>
              <span className="text-[11px] font-semibold text-stone-500 bg-white px-2 py-0.5 rounded border border-stone-200">
                {formatBookingSource()}
              </span>
            </div>

            <div className="flex items-baseline justify-between pt-1 border-t border-stone-200/80">
              <span className="text-sm font-bold text-stone-900">{roomNumber}</span>
              <span className="text-xs text-stone-600 font-medium">{roomTypeName}</span>
            </div>
          </div>

          {/* Stay Dates & Duration */}
          <div className="grid grid-cols-2 gap-2 p-2.5 bg-white rounded-xl border border-stone-200">
            <div>
              <span className="text-[11px] text-stone-500 block font-medium">Check-in</span>
              <strong className="text-xs font-mono font-bold text-stone-800">{checkIn}</strong>
            </div>
            <div>
              <span className="text-[11px] text-stone-500 block font-medium">Check-out</span>
              <strong className="text-xs font-mono font-bold text-stone-800">{checkOut}</strong>
            </div>
            <div className="col-span-2 pt-1 border-t border-stone-100 flex items-center justify-between text-[11px]">
              <span className="text-stone-500">Durasi Menginap:</span>
              <strong className="text-stone-800 font-semibold">{isDayUse ? '⚡ Day Use Transit' : `${nights} malam`}</strong>
            </div>
          </div>

          {/* Contact */}
          <div className="flex items-center justify-between px-3 py-2 bg-stone-50/80 rounded-xl border border-stone-200 text-xs">
            <span className="text-stone-500 font-medium">No. Telepon:</span>
            {guestPhone ? (
              <a
                href={`tel:${guestPhone}`}
                className="font-mono font-bold text-emerald-800 hover:text-emerald-700 hover:underline"
              >
                {guestPhone}
              </a>
            ) : (
              <span className="text-stone-400 italic font-medium">Belum terisi</span>
            )}
          </div>

          {/* Financial Summary */}
          <div className="p-3 bg-stone-50 rounded-xl border border-stone-200 space-y-2">
            <div className="flex items-center justify-between pb-1.5 border-b border-stone-200">
              <span className="text-xs font-bold text-stone-800">Status Pembayaran</span>
              <span className={`text-[11px] px-2 py-0.5 rounded-full font-bold border ${paymentStatus.badgeClass}`}>
                {paymentStatus.label}
              </span>
            </div>

            <div className="space-y-1 text-xs">
              <div className="flex justify-between items-center text-stone-600">
                <span>Total Tagihan:</span>
                <strong className="font-mono font-bold text-stone-900">
                  {loading ? (
                    <span className="text-stone-400 font-normal italic animate-pulse">Memuat...</span>
                  ) : (
                    `Rp ${totalPrice.toLocaleString('id-ID')}`
                  )}
                </strong>
              </div>
              <div className="flex justify-between items-center text-stone-600">
                <span>Sudah Dibayar:</span>
                <strong className="font-mono font-semibold text-emerald-700">
                  {loading ? (
                    <span className="text-stone-400 font-normal italic animate-pulse">Memuat...</span>
                  ) : (
                    `Rp ${amountPaid.toLocaleString('id-ID')}`
                  )}
                </strong>
              </div>
              <div className="flex justify-between items-center text-stone-800 pt-1 border-t border-stone-200 font-bold">
                <span>Sisa Tagihan:</span>
                <strong className="font-mono text-amber-700">
                  {loading ? (
                    <span className="text-stone-400 font-normal italic animate-pulse">Memuat...</span>
                  ) : (
                    `Rp ${remainingBalance.toLocaleString('id-ID')}`
                  )}
                </strong>
              </div>
            </div>
          </div>

          {/* Inspection feedback message if any */}
          {inspectionFeedback && (
            <div
              className={`p-2.5 text-xs rounded-xl border font-medium flex items-center justify-between gap-2 ${
                inspectionFeedback.type === 'error'
                  ? 'bg-rose-50 border-rose-200 text-rose-800'
                  : 'bg-emerald-50 border-emerald-200 text-emerald-800'
              }`}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="shrink-0">{inspectionFeedback.type === 'error' ? '⚠️' : '✓'}</span>
                <span className="truncate">{inspectionFeedback.text}</span>
              </div>
              {inspectionFeedback.type === 'error' && (
                <button
                  type="button"
                  onClick={handleRequestInspection}
                  disabled={requestingInspection || isPropertyMissing}
                  className="px-2 py-0.5 rounded bg-white hover:bg-rose-100 text-rose-800 border border-rose-300 text-[11px] font-bold cursor-pointer shrink-0"
                >
                  {requestingInspection ? '...' : 'Coba Lagi'}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Action Footer (flex-shrink-0) */}
        <div className="flex-shrink-0 p-3 bg-stone-50 border-t border-stone-200 space-y-2">
          {/* Lifecycle Action Buttons */}
          <div className="flex items-center gap-2">
            {isBooked && (
              <>
                {onCheckin && (
                  <button
                    type="button"
                    disabled={isPropertyMissing}
                    onClick={() => {
                      if (isPropertyMissing) return;
                      if (!isCheckinReady) {
                        onOpenFullDetail(data);
                        return;
                      }
                      onCheckin(data.id);
                      onClose();
                    }}
                    className={`flex-1 py-2 px-3 font-bold text-xs rounded-xl shadow-xs transition-colors flex items-center justify-center gap-1.5 ${
                      isPropertyMissing
                        ? 'bg-stone-200 text-stone-400 border border-stone-300 cursor-not-allowed'
                        : isCheckinReady
                        ? 'bg-emerald-800 hover:bg-emerald-700 text-white cursor-pointer'
                        : 'bg-stone-200 text-stone-500 border border-stone-300 cursor-pointer'
                    }`}
                    title={
                      isPropertyMissing
                        ? 'Properti aktif tidak tersedia'
                        : isCheckinReady
                        ? 'Check-in Tamu'
                        : 'Buka Detail untuk melengkapi Telepon / KTP'
                    }
                  >
                    <span>{isCheckinReady ? '✓' : '🔒'}</span>
                    <span>Check-in Tamu</span>
                  </button>
                )}

                <button
                  type="button"
                  disabled={isPropertyMissing}
                  onClick={() => {
                    if (isPropertyMissing) return;
                    setIsEditModalOpen(true);
                  }}
                  className={`px-3 py-2 font-semibold text-xs rounded-xl border transition-colors ${
                    isPropertyMissing
                      ? 'bg-stone-100 text-stone-400 border-stone-200 cursor-not-allowed'
                      : 'bg-white hover:bg-stone-100 text-stone-700 border-stone-300 cursor-pointer'
                  }`}
                >
                  Edit
                </button>
              </>
            )}

            {isCheckedIn && (
              <>
                {data.require_checkout_inspection && (!data.checkout_inspection || data.checkout_inspection.clearance_state === 'REQUESTED' || data.checkout_inspection.clearance_state === 'INSPECTING') ? (
                  !data.checkout_inspection ? (
                    <button
                      type="button"
                      disabled={requestingInspection || isPropertyMissing}
                      onClick={handleRequestInspection}
                      className="flex-1 py-2 px-3 bg-emerald-800 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold text-xs rounded-xl shadow-xs transition-colors cursor-pointer"
                    >
                      {requestingInspection ? 'Meminta...' : 'Minta Pemeriksaan'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled
                      className="flex-1 py-2 px-3 bg-stone-200 text-stone-500 font-bold text-xs rounded-xl cursor-not-allowed"
                      title="Pemeriksaan Housekeeping sedang berjalan"
                    >
                      ⏳ Cek Housekeeping
                    </button>
                  )
                ) : (
                  onCheckout && (
                    <button
                      type="button"
                      disabled={isPropertyMissing}
                      onClick={() => {
                        if (isPropertyMissing) return;
                        onCheckout(data.id);
                        onClose();
                      }}
                      className={`flex-1 py-2 px-3 font-bold text-xs rounded-xl shadow-xs transition-colors ${
                        isPropertyMissing
                          ? 'bg-stone-200 text-stone-400 border border-stone-300 cursor-not-allowed'
                          : 'bg-amber-700 hover:bg-amber-600 text-white cursor-pointer'
                      }`}
                    >
                      Check-out Tamu
                    </button>
                  )
                )}

                {onOpenStayChange && (
                  <button
                    type="button"
                    disabled={isPropertyMissing}
                    onClick={() => {
                      if (isPropertyMissing) return;
                      onOpenStayChange(data, 'extend');
                      onClose();
                    }}
                    className={`px-3 py-2 font-semibold text-xs rounded-xl border transition-colors ${
                      isPropertyMissing
                        ? 'bg-stone-100 text-stone-400 border-stone-200 cursor-not-allowed'
                        : 'bg-white hover:bg-stone-100 text-stone-700 border-stone-300 cursor-pointer'
                    }`}
                  >
                    Perpanjang
                  </button>
                )}
              </>
            )}

            {(isCheckedOut || isCancelled) && (
              <div className="flex-1 py-1.5 px-3 bg-stone-100 text-stone-600 rounded-xl text-xs font-semibold text-center border border-stone-200">
                {isCheckedOut ? '● Reservasi telah selesai' : '● Reservasi telah dibatalkan'}
              </div>
            )}

            {/* More Actions Dropdown (⋯ Lainnya) */}
            {(isBooked || isCheckedIn) && (
              <div className="relative" ref={moreActionsRef}>
                <button
                  type="button"
                  disabled={isPropertyMissing}
                  onClick={() => {
                    if (isPropertyMissing) return;
                    setIsMoreActionsOpen((prev) => !prev);
                  }}
                  className={`px-2.5 py-2 font-bold text-xs rounded-xl border transition-colors ${
                    isPropertyMissing
                      ? 'bg-stone-100 text-stone-400 border-stone-200 cursor-not-allowed'
                      : 'bg-white hover:bg-stone-100 text-stone-700 border-stone-300 cursor-pointer'
                  }`}
                  title="Menu Lainnya"
                >
                  ⋯
                </button>

                {isMoreActionsOpen && (
                  <div className="absolute right-0 bottom-full mb-1 w-48 bg-white rounded-xl shadow-xl border border-stone-200 py-1.5 z-70 text-xs font-medium text-stone-700 animate-in fade-in zoom-in-95 duration-100">
                    {onOpenStayChange && (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setIsMoreActionsOpen(false);
                            onOpenStayChange(data, 'extend');
                            onClose();
                          }}
                          className="w-full text-left px-3.5 py-2 hover:bg-stone-50 text-stone-700 cursor-pointer flex items-center gap-2"
                        >
                          <span>↗</span>
                          <span>Perpanjang Menginap</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setIsMoreActionsOpen(false);
                            onOpenStayChange(data, 'shorten');
                            onClose();
                          }}
                          className="w-full text-left px-3.5 py-2 hover:bg-stone-50 text-stone-700 cursor-pointer flex items-center gap-2"
                        >
                          <span>↘</span>
                          <span>Ubah Tanggal Check-out</span>
                        </button>
                      </>
                    )}

                    {isBooked && onCancel && (
                      <button
                        type="button"
                        onClick={() => {
                          setIsMoreActionsOpen(false);
                          onCancel(data.id);
                          onClose();
                        }}
                        className="w-full text-left px-3.5 py-2 hover:bg-rose-50 text-rose-700 cursor-pointer flex items-center gap-2 border-t border-stone-100 mt-1"
                      >
                        <span>✕</span>
                        <span>Batalkan Reservasi</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Primary "Buka Detail Lengkap" link */}
          <button
            type="button"
            onClick={() => onOpenFullDetail(data)}
            className="w-full py-1.5 text-center text-emerald-800 hover:text-emerald-900 hover:bg-emerald-50 text-xs font-bold rounded-lg transition-colors cursor-pointer flex items-center justify-center gap-1"
          >
            <span>Buka Detail Lengkap</span>
            <span>→</span>
          </button>
        </div>
      </div>

      {/* Embedded Edit Modal when triggered from Quick Detail */}
      {isEditModalOpen && activePropId && (
        <EditReservationModal
          isOpen={isEditModalOpen}
          onClose={() => setIsEditModalOpen(false)}
          reservation={data}
          propertyId={activePropId}
          onSuccess={() => {
            setIsEditModalOpen(false);
            onRefresh?.();
            onClose();
          }}
        />
      )}
    </>
  );
}
