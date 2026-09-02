import React, { useState, useEffect, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom';
import { safeFetchJson } from './calendarApi';
import { useAuth } from '../auth/AuthContext';

interface EditReservationModalProps {
  isOpen: boolean;
  onClose: () => void;
  reservation: any;
  propertyId: number;
  onSuccess: () => void;
}

export const EditReservationModal: React.FC<EditReservationModalProps> = ({
  isOpen,
  onClose,
  reservation,
  propertyId,
  onSuccess
}) => {
  const [loading, setLoading] = useState<boolean>(false);
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const { authFetch } = useAuth();

  // Form Fields
  const [guestName, setGuestName] = useState<string>('');
  const [guestPhone, setGuestPhone] = useState<string>('');
  const [guestSegment, setGuestSegment] = useState<string>('Reguler');
  const [bookerName, setBookerName] = useState<string>('');
  const [bookerPhone, setBookerPhone] = useState<string>('');
  const [referral, setReferral] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [adults, setAdults] = useState<number>(1);
  const [children, setChildren] = useState<number>(0);

  const [checkIn, setCheckIn] = useState<string>('');
  const [checkOut, setCheckOut] = useState<string>('');
  const [stayType, setStayType] = useState<'OVERNIGHT' | 'DAY_USE' | 'TRANSIT'>('OVERNIGHT');
  const [checkInTime, setCheckInTime] = useState<string>('14:00');
  const [checkOutTime, setCheckOutTime] = useState<string>('12:00');

  const [roomTypeId, setRoomTypeId] = useState<number | null>(null);
  const [roomId, setRoomId] = useState<number | null>(null);
  const [ratePlanId, setRatePlanId] = useState<number | null>(null);

  // Master Data
  const [ratePlans, setRatePlans] = useState<any[]>([]);
  const [availableRoomTypes, setAvailableRoomTypes] = useState<any[] | null>(null);
  const [availabilityLoading, setAvailabilityLoading] = useState<boolean>(false);

  // Preview State
  const [previewData, setPreviewData] = useState<any>(null);

  // Difference Payment Modal State
  const [showPaymentModal, setShowPaymentModal] = useState<boolean>(false);
  const [paymentMethod, setPaymentMethod] = useState<string>('CASH');
  const [paymentFile, setPaymentFile] = useState<File | null>(null);
  const [paymentNote, setPaymentNote] = useState<string>('');
  const [paymentSubmitting, setPaymentSubmitting] = useState<boolean>(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [showDecreaseModal, setShowDecreaseModal] = useState<boolean>(false);
  const previewRequestRef = useRef(0);
  const availabilityRequestRef = useRef(0);
  const saveRequestKeyRef = useRef<string | null>(null);

  const isOta = reservation?.ota_source_id != null;
  const selectedAvailableType = availableRoomTypes?.find((type) => Number(type.id) === Number(roomTypeId));
  const availableRooms = selectedAvailableType?.rooms || [];
  const hasAssignableRoom = availableRooms.some((room: any) => Number(room.id) === Number(roomId));
  const selectedRatePlan = ratePlans.find((plan) => Number(plan.id) === Number(ratePlanId));
  const hasCompatibleRatePlan = Boolean(
    selectedRatePlan
    && Number(selectedRatePlan.room_type_id) === Number(roomTypeId)
    && selectedRatePlan.is_active !== false
    && selectedRatePlan.is_archived !== true
    && (stayType === 'DAY_USE' ? selectedRatePlan.rate_type === 'DAY_USE' : selectedRatePlan.rate_type !== 'DAY_USE')
  );

  // Initialize form
  useEffect(() => {
    if (!reservation || !isOpen) return;
    setGuestName(reservation.guest_name || '');
    setGuestPhone(reservation.guest_phone || '');
    setGuestSegment(reservation.guest_segment || 'Reguler');
    setBookerName(reservation.booker_name || reservation.guest_name || '');
    setBookerPhone(reservation.booker_phone || reservation.guest_phone || '');
    setReferral(reservation.referral || '');
    setNotes(reservation.notes || reservation.special_requests || '');
    setAdults(reservation.adults || 1);
    setChildren(reservation.children || 0);

    setCheckIn(reservation.check_in ? String(reservation.check_in).slice(0, 10) : '');
    setCheckOut(reservation.check_out ? String(reservation.check_out).slice(0, 10) : '');
    setStayType(reservation.stay_type || 'OVERNIGHT');
    setCheckInTime(reservation.check_in_time || '14:00');
    setCheckOutTime(reservation.check_out_time || '12:00');

    setRoomTypeId(reservation.room_type_id || reservation.booked_room_type_id_snapshot || null);
    setRoomId(reservation.room_id || null);
    setRatePlanId(reservation.rate_plan_id || null);
    setError(null);
    setPreviewData(null);
    setShowPaymentModal(false);
    setShowDecreaseModal(false);
    setPaymentFile(null);
    setPaymentNote('');
    setPaymentError(null);
    saveRequestKeyRef.current = null;
  }, [reservation, isOpen]);

  // Load canonical Rate Plans from Master Kamar.
  useEffect(() => {
    if (!isOpen) return;
    const loadMasters = async () => {
      try {
        const [rpRes] = await Promise.all([
          safeFetchJson<{ data?: any[] }>(`/api/pricing/rate-plans?property_id=${propertyId}&is_active=true`, undefined, undefined, authFetch)
        ]);
        if (rpRes.ok) {
          const plans = Array.isArray(rpRes.data)
            ? rpRes.data
            : (Array.isArray((rpRes.data as any)?.data) ? (rpRes.data as any).data : []);
          setRatePlans(plans.filter((rp: any) => rp.is_active !== false && rp.is_archived !== true));
        }
      } catch (err) {
        console.warn('Failed to load master data for edit modal', err);
      }
    };
    loadMasters();
  }, [isOpen, propertyId, authFetch]);

  // The server owns date-aware selector availability. Sequence protection
  // prevents slow responses from replacing a newer proposed stay interval.
  useEffect(() => {
    if (!isOpen || !reservation?.id || !checkIn || (!checkOut && stayType !== 'DAY_USE')) {
      availabilityRequestRef.current += 1;
      setAvailableRoomTypes(null);
      setAvailabilityLoading(false);
      return;
    }
    const requestId = ++availabilityRequestRef.current;
    const controller = new AbortController();
    const effectiveCheckOut = stayType === 'DAY_USE' ? checkIn : checkOut;
    const params = new URLSearchParams({
      property_id: String(propertyId),
      check_in: checkIn,
      check_out: effectiveCheckOut,
      stay_type: stayType
    });
    const loadAvailability = async () => {
      try {
        setAvailabilityLoading(true);
        setAvailableRoomTypes(null);
        previewRequestRef.current += 1;
        setPreviewData(null);
        const result = await safeFetchJson<{ data?: { room_types?: any[] } }>(
          `/api/reservations/${reservation.id}/edit-availability?${params.toString()}`,
          { signal: controller.signal },
          'Gagal memuat kamar yang tersedia untuk tanggal menginap.',
          authFetch
        );
        if (requestId !== availabilityRequestRef.current) return;
        if (!result.ok || !result.data?.data) {
          setAvailableRoomTypes([]);
          setError(result.errorMessage || 'Gagal memuat kamar yang tersedia untuk tanggal menginap.');
          return;
        }
        setAvailableRoomTypes(result.data.data.room_types || []);
      } catch (err: any) {
        if (requestId === availabilityRequestRef.current && err?.name !== 'AbortError') {
          setAvailableRoomTypes([]);
          setError('Gagal memuat kamar yang tersedia untuk tanggal menginap.');
        }
      } finally {
        if (requestId === availabilityRequestRef.current) setAvailabilityLoading(false);
      }
    };
    loadAvailability();
    return () => controller.abort();
  }, [isOpen, reservation?.id, propertyId, checkIn, checkOut, stayType, authFetch]);

  // Reconcile selections after the server refreshes availability. A type or
  // room that is no longer sellable is never retained in the draft.
  useEffect(() => {
    if (availabilityLoading || availableRoomTypes === null) return;
    setRoomTypeId((currentTypeId) => {
      if (!currentTypeId) return null;
      return availableRoomTypes.some((type) => Number(type.id) === Number(currentTypeId))
        ? currentTypeId
        : null;
    });
  }, [availableRoomTypes, availabilityLoading]);

  useEffect(() => {
    if (availabilityLoading || availableRoomTypes === null) return;
    if (!roomTypeId) {
      setRoomId(null);
      return;
    }
    const currentType = availableRoomTypes.find((type) => Number(type.id) === Number(roomTypeId));
    const roomsForType = currentType?.rooms || [];
    setRoomId((currentRoomId) => {
      if (roomsForType.some((room: any) => Number(room.id) === Number(currentRoomId))) return currentRoomId;
      return roomsForType.length === 1 ? Number(roomsForType[0].id) : null;
    });
  }, [availableRoomTypes, availabilityLoading, roomTypeId]);

  // Fetch Pricing Preview
  const fetchPreview = useCallback(async () => {
    if (!reservation?.id || availabilityLoading || !roomTypeId || !roomId || !hasAssignableRoom || !checkIn || (!checkOut && stayType !== 'DAY_USE') || (!isOta && !hasCompatibleRatePlan)) {
      previewRequestRef.current += 1;
      setPreviewData(null);
      setPreviewLoading(false);
      return;
    }
    const requestId = ++previewRequestRef.current;
    try {
      setPreviewLoading(true);
      setError(null);
      const result = await safeFetchJson<{ data?: any }>(
        `/api/reservations/${reservation.id}/edit-preview`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            room_type_id: roomTypeId,
            room_id: roomId,
            rate_plan_id: ratePlanId,
            check_in: checkIn,
            check_out: stayType === 'DAY_USE' ? checkIn : checkOut,
            stay_type: stayType,
            adults,
            children
          })
        },
        'Gagal menghitung pratinjau harga',
        authFetch
      );
      if (requestId !== previewRequestRef.current) return;
      if (result.ok && result.data?.data) {
        setPreviewData(result.data.data);
      } else {
        setError(result.errorMessage || 'Gagal menghitung pratinjau harga');
      }
    } catch (err: any) {
      console.warn('Preview error', err);
    } finally {
      if (requestId === previewRequestRef.current) setPreviewLoading(false);
    }
  }, [reservation, roomTypeId, roomId, ratePlanId, checkIn, checkOut, stayType, adults, children, availabilityLoading, hasAssignableRoom, isOta, hasCompatibleRatePlan, authFetch]);

  useEffect(() => {
    if (isOpen && checkIn && roomTypeId && roomId && hasAssignableRoom && !availabilityLoading && (isOta || hasCompatibleRatePlan)) {
      fetchPreview();
    }
  }, [isOpen, checkIn, checkOut, stayType, roomTypeId, roomId, ratePlanId, adults, children, availabilityLoading, hasAssignableRoom, isOta, hasCompatibleRatePlan, fetchPreview]);

  useEffect(() => {
    saveRequestKeyRef.current = null;
  }, [roomTypeId, roomId, ratePlanId, checkIn, checkOut, stayType, adults, children]);

  useEffect(() => {
    if (!roomTypeId || ratePlans.length === 0) return;
    const compatible = ratePlans.filter((rp) =>
      Number(rp.room_type_id) === Number(roomTypeId)
      && rp.is_active !== false
      && rp.is_archived !== true
      && (stayType === 'DAY_USE' ? rp.rate_type === 'DAY_USE' : rp.rate_type !== 'DAY_USE')
    );
    if (compatible.some((rp) => Number(rp.id) === Number(ratePlanId))) return;
    const preferred = compatible.find((rp) => stayType === 'DAY_USE' ? rp.rate_type === 'DAY_USE' : rp.rate_type !== 'DAY_USE');
    setRatePlanId(preferred?.id || compatible[0]?.id || null);
  }, [ratePlans, ratePlanId, roomTypeId, stayType]);

  const buildEditPayload = () => ({
    guest_name: guestName.trim(),
    guest_phone: guestPhone.trim(),
    guest_segment: guestSegment,
    booker_name: bookerName.trim() || guestName.trim(),
    booker_phone: bookerPhone.trim() || guestPhone.trim(),
    referral: referral.trim(),
    notes: notes.trim(),
    adults: Number(adults),
    children: Number(children),
    room_type_id: roomTypeId,
    room_id: roomId,
    rate_plan_id: ratePlanId,
    check_in: checkIn,
    check_out: stayType === 'DAY_USE' ? checkIn : checkOut,
    stay_type: stayType,
    check_in_time: checkInTime,
    check_out_time: checkOutTime,
    property_id: propertyId
  });

  const getSaveRequestKey = () => {
    if (!saveRequestKeyRef.current) {
      saveRequestKeyRef.current = globalThis.crypto?.randomUUID?.()
        || `edit-${reservation.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    return saveRequestKeyRef.current;
  };

  // Submit Edit
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reservation?.id) return;

    if (previewLoading || !previewData) {
      setError('Harga terbaru masih dihitung. Tunggu sebentar lalu simpan kembali.');
      return;
    }

    if (previewData && previewData.price_difference > 0) {
      getSaveRequestKey();
      setShowPaymentModal(true);
      return;
    }
    if (previewData && previewData.price_difference < 0) {
      getSaveRequestKey();
      setShowDecreaseModal(true);
      return;
    }

    await submitEditDecision(false);
  };

  async function submitEditDecision(keepCurrentPrice: boolean) {
    if (!reservation?.id || loading) return;
    try {
      setLoading(true);
      setError(null);
      const response = await authFetch(`/api/reservations/${reservation.id}/edit-with-payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': getSaveRequestKey()
        },
        body: JSON.stringify({
          ...buildEditPayload(),
          keep_current_price: keepCurrentPrice,
          expected_new_total: Number(previewData?.quote?.grand_total || 0)
        })
      });
      const data = await response.json();
      if (!response.ok || data.status === 'ERROR') {
        saveRequestKeyRef.current = null;
        throw new Error(data.message || 'Gagal menyimpan perubahan reservasi');
      }
      setShowDecreaseModal(false);
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Terjadi kesalahan saat menyimpan reservasi');
    } finally {
      setLoading(false);
    }
  }

  // Submit Edit + Difference Payment (atomic)
  const handleSubmitWithPayment = async () => {
    if (!reservation?.id || paymentSubmitting) return;
    if (!paymentFile) {
      setPaymentError('Bukti pembayaran selisih wajib dilampirkan.');
      return;
    }
    try {
      setPaymentSubmitting(true);
      setPaymentError(null);

      const formData = new FormData();
      formData.append('file', paymentFile);
      const payload = buildEditPayload();
      formData.append('property_id', String(payload.property_id));
      formData.append('payment_method', paymentMethod);
      formData.append('evidence_note', paymentNote.trim());
      formData.append('guest_name', payload.guest_name);
      formData.append('guest_phone', payload.guest_phone);
      formData.append('guest_segment', payload.guest_segment);
      formData.append('booker_name', payload.booker_name);
      formData.append('booker_phone', payload.booker_phone);
      formData.append('referral', payload.referral);
      formData.append('notes', payload.notes);
      formData.append('adults', String(payload.adults));
      formData.append('children', String(payload.children));
      formData.append('room_type_id', payload.room_type_id ? String(payload.room_type_id) : '');
      formData.append('room_id', payload.room_id ? String(payload.room_id) : '');
      formData.append('rate_plan_id', payload.rate_plan_id ? String(payload.rate_plan_id) : '');
      formData.append('check_in', payload.check_in);
      formData.append('check_out', payload.check_out);
      formData.append('stay_type', payload.stay_type);
      formData.append('check_in_time', payload.check_in_time);
      formData.append('check_out_time', payload.check_out_time);
      formData.append('keep_current_price', 'false');
      formData.append('expected_new_total', String(Number(previewData?.quote?.grand_total || 0)));

      const response = await authFetch(`/api/reservations/${reservation.id}/edit-with-payment`, {
        method: 'POST',
        headers: { 'Idempotency-Key': getSaveRequestKey() },
        body: formData
      });

      const data = await response.json();
      if (!response.ok || data.status === 'ERROR') {
        saveRequestKeyRef.current = null;
        throw new Error(data.message || 'Gagal menyimpan perubahan dan pembayaran');
      }

      setShowPaymentModal(false);
      onSuccess();
      onClose();
    } catch (err: any) {
      setPaymentError(err.message || 'Terjadi kesalahan saat menyimpan');
    } finally {
      setPaymentSubmitting(false);
    }
  };

  if (!isOpen) return null;

  const filteredRatePlans = ratePlans.filter((rp) => {
    if (!roomTypeId || Number(rp.room_type_id) !== Number(roomTypeId)) return false;
    if (rp.is_active === false || rp.is_archived === true) return false;
    return stayType === 'DAY_USE' ? rp.rate_type === 'DAY_USE' : rp.rate_type !== 'DAY_USE';
  });

  return ReactDOM.createPortal(
    <div data-portal-overlay="reservation-edit" className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl max-w-2xl w-full p-6 shadow-2xl space-y-4 my-8 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-stone-200">
          <div>
            <h3 className="text-base font-bold text-stone-900 flex items-center gap-2">
              <span>✏️ Edit Reservasi #{reservation?.booking_number || reservation?.id}</span>
              <span className="px-2 py-0.5 text-xs font-bold bg-emerald-100 text-emerald-800 rounded-full">
                {reservation?.status}
              </span>
            </h3>
            <p className="text-xs text-stone-500 mt-0.5">
              Ubah data tamu, tanggal menginap, tipe kamar, rate plan, dan kamar fisik.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-stone-400 hover:text-stone-600 text-lg font-bold cursor-pointer"
          >
            ✕
          </button>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-xs font-semibold flex items-center justify-between">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} className="text-stone-400 hover:text-stone-600">✕</button>
          </div>
        )}

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="space-y-4 overflow-y-auto pr-1 flex-1 text-xs">
          {/* Section: Guest & Booker Information */}
          <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 space-y-3">
            <h4 className="font-bold text-stone-800 uppercase tracking-wider text-[11px]">
              1. Data Tamu & Pemesan
            </h4>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-stone-700 mb-1">
                  Nama Tamu Menginap <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">
                  No. HP Tamu <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={guestPhone}
                  onChange={(e) => setGuestPhone(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:outline-none font-mono"
                />
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">
                  Nama Pemesan (Booker)
                </label>
                <input
                  type="text"
                  value={bookerName}
                  onChange={(e) => setBookerName(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">
                  No. HP Pemesan
                </label>
                <input
                  type="text"
                  value={bookerPhone}
                  onChange={(e) => setBookerPhone(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:outline-none font-mono"
                />
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">Segmen Tamu</label>
                <select
                  value={guestSegment}
                  onChange={(e) => setGuestSegment(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                >
                  <option value="Reguler">Reguler</option>
                  <option value="Corporate">Corporate</option>
                  <option value="Group">Group</option>
                  <option value="VIP">VIP</option>
                  <option value="Walk-in">Walk-in</option>
                </select>
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">Referral / Sumber</label>
                <input
                  type="text"
                  value={referral}
                  onChange={(e) => setReferral(e.target.value)}
                  placeholder="Contoh: Instagram, Teman, Agen..."
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Section: Dates & Stay Type */}
          <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-stone-800 uppercase tracking-wider text-[11px]">
                2. Waktu & Tipe Menginap
              </h4>
              <div className="flex items-center gap-1 p-0.5 bg-stone-200 rounded-lg">
                <button
                  type="button"
                  onClick={() => setStayType('OVERNIGHT')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition-all cursor-pointer ${
                    stayType === 'OVERNIGHT' ? 'bg-white text-emerald-900 shadow-xs' : 'text-stone-600'
                  }`}
                >
                  Overnight
                </button>
                <button
                  type="button"
                  onClick={() => setStayType('DAY_USE')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition-all cursor-pointer ${
                    stayType === 'DAY_USE' ? 'bg-white text-emerald-900 shadow-xs' : 'text-stone-600'
                  }`}
                >
                  Day Use
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-stone-700 mb-1">
                  Tanggal Check-in <span className="text-rose-500">*</span>
                </label>
                <input
                  type="date"
                  required
                  value={checkIn}
                  onChange={(e) => setCheckIn(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg font-mono"
                />
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">
                  Tanggal Check-out <span className="text-rose-500">*</span>
                </label>
                <input
                  type="date"
                  required
                  min={checkIn}
                  value={stayType === 'DAY_USE' ? checkIn : checkOut}
                  onChange={(e) => setCheckOut(e.target.value)}
                  disabled={stayType === 'DAY_USE'}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg font-mono disabled:bg-stone-100"
                />
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">Jam Check-in</label>
                <input
                  type="time"
                  value={checkInTime}
                  onChange={(e) => setCheckInTime(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg font-mono"
                />
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">Jam Check-out</label>
                <input
                  type="time"
                  value={checkOutTime}
                  onChange={(e) => setCheckOutTime(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg font-mono"
                />
              </div>
            </div>
          </div>

          {/* Section: Room & Rate Plan */}
          <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 space-y-3">
            <h4 className="font-bold text-stone-800 uppercase tracking-wider text-[11px]">
              3. Tipe Kamar, Kamar Fisik & Paket Tarif
            </h4>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block font-semibold text-stone-700 mb-1">
                  Tipe Kamar <span className="text-rose-500">*</span>
                </label>
                <select
                  required
                  value={roomTypeId || ''}
                  onChange={(e) => {
                    const newTypeId = Number(e.target.value) || null;
                    setRoomTypeId(newTypeId);
                    const nextType = availableRoomTypes?.find((type) => Number(type.id) === Number(newTypeId));
                    setRoomId(nextType?.rooms?.length === 1 ? Number(nextType.rooms[0].id) : null);
                    // Clear incompatible rate plan and auto-select first compatible
                    const compatible = ratePlans.filter((rp) =>
                      newTypeId
                      && Number(rp.room_type_id) === newTypeId
                      && rp.is_active !== false
                      && rp.is_archived !== true
                    );
                    const preferred = compatible.find((rp) => stayType === 'DAY_USE' ? rp.rate_type === 'DAY_USE' : rp.rate_type !== 'DAY_USE');
                    setRatePlanId(preferred?.id || compatible[0]?.id || null);
                  }}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg"
                >
                  <option value="">Pilih Tipe Kamar</option>
                  {(availableRoomTypes || []).map((rt) => (
                    <option key={rt.id} value={rt.id}>
                      {rt.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">
                  Kamar Fisik
                </label>
                <select
                  required
                  value={roomId || ''}
                  onChange={(e) => setRoomId(Number(e.target.value) || null)}
                  disabled={availabilityLoading || !roomTypeId || availableRooms.length === 0}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg disabled:bg-stone-100"
                >
                  <option value="">
                    {availabilityLoading
                      ? 'Memuat kamar tersedia...'
                      : availableRooms.length === 0
                        ? 'Tidak ada kamar tersedia'
                        : 'Pilih Kamar Fisik'}
                  </option>
                  {availableRooms.map((r: any) => (
                    <option key={r.id} value={r.id}>
                      Kamar {r.room_number}{r.floor ? ` (Lt. ${r.floor})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">
                  Rate Plan / Paket Tarif
                </label>
                <select
                  value={ratePlanId || ''}
                  onChange={(e) => setRatePlanId(Number(e.target.value) || null)}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg"
                >
                  {filteredRatePlans.length === 0 && (
                    <option value="">
                      {stayType === 'DAY_USE'
                        ? 'Tidak ada Paket Day Use untuk Tipe Kamar ini'
                        : 'Tidak ada Paket Tarif aktif untuk Tipe Kamar ini'}
                    </option>
                  )}
                  {filteredRatePlans.map((rp) => (
                    <option key={rp.id} value={rp.id}>
                      {rp.name} ({rp.code}) {rp.meal_plan_name ? `• ${rp.meal_plan_name}` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">Jumlah Dewasa</label>
                <input
                  type="number"
                  min={1}
                  value={adults}
                  onChange={(e) => setAdults(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg"
                />
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">Jumlah Anak</label>
                <input
                  type="number"
                  min={0}
                  value={children}
                  onChange={(e) => setChildren(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg"
                />
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">Catatan</label>
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Catatan tambahan..."
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg"
                />
              </div>
            </div>
          </div>

          {/* Section: Live Repricing Comparison */}
          {previewData && (
            <div className="p-4 bg-emerald-50/70 rounded-xl border border-emerald-200 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-bold text-emerald-950 uppercase tracking-wider text-[11px]">
                  📊 Perbandingan Harga & Tagihan
                </span>
                {previewLoading && (
                  <span className="text-[10px] text-emerald-700 font-semibold animate-pulse">
                    Menghitung ulang...
                  </span>
                )}
              </div>

              {previewData.room_overlap_conflict && (
                <div className="p-2.5 bg-rose-100 border border-rose-300 text-rose-900 rounded-lg font-bold">
                  ⚠️ {previewData.overlap_message}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="p-2.5 bg-white rounded-lg border border-stone-200">
                  <div className="text-stone-500 text-[10px]">Harga Reservasi Lama</div>
                  <div className="text-sm font-bold font-mono text-stone-800">
                    Rp {Number(previewData.current?.total_price || 0).toLocaleString('id-ID')}
                  </div>
                </div>

                <div className="p-2.5 bg-white rounded-lg border border-emerald-300">
                  <div className="text-emerald-700 text-[10px] font-bold">Harga Baru (Quote)</div>
                  <div className="text-sm font-bold font-mono text-emerald-900">
                    Rp {Number(previewData.quote?.grand_total || 0).toLocaleString('id-ID')}
                  </div>
                  <div className="text-[10px] text-stone-400">
                    Paket: {previewData.quote?.rate_plan_name}
                  </div>
                </div>

                <div className="p-2.5 bg-white rounded-lg border border-stone-200">
                  <div className="text-stone-500 text-[10px]">
                    {previewData.price_difference < 0 ? 'Harga Turun' : 'Selisih'}
                  </div>
                  <div
                    className={`text-sm font-bold font-mono ${
                      previewData.price_difference > 0
                        ? 'text-rose-700'
                        : previewData.price_difference < 0
                        ? 'text-emerald-700'
                        : 'text-stone-800'
                    }`}
                  >
                    {previewData.price_difference > 0 ? '+' : ''}
                    Rp {Number(previewData.price_difference || 0).toLocaleString('id-ID')}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-stone-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-stone-300 text-stone-700 font-bold rounded-xl hover:bg-stone-100 transition-colors cursor-pointer"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={loading || previewLoading || !previewData || (previewData && previewData.room_overlap_conflict)}
              className={`px-5 py-2 font-bold rounded-xl shadow-xs transition-colors cursor-pointer ${
                previewData && previewData.price_difference > 0
                  ? 'bg-amber-600 hover:bg-amber-500 text-white'
                  : 'bg-emerald-800 hover:bg-emerald-700 text-white'
              } disabled:opacity-50`}
            >
              {loading ? 'Menyimpan...' : previewData && previewData.price_difference > 0 ? 'Bayar Selisih & Simpan' : 'Simpan Perubahan'}
            </button>
          </div>
        </form>
      </div>

      {/* Lower Price Decision */}
      {showDecreaseModal && previewData && (
        <div className="fixed inset-0 z-[80] bg-black/60 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-stone-200">
              <h3 className="text-base font-bold text-stone-900">Konfirmasi Harga Baru</h3>
              <button
                type="button"
                onClick={() => setShowDecreaseModal(false)}
                disabled={loading}
                className="text-stone-400 hover:text-stone-600 text-lg font-bold cursor-pointer disabled:opacity-50"
              >
                ✕
              </button>
            </div>

            <p className="text-sm text-stone-700">
              Harga baru lebih rendah{' '}
              <strong className="text-emerald-800">
                Rp {Math.abs(Number(previewData.price_difference || 0)).toLocaleString('id-ID')}
              </strong>
            </p>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
                <div className="text-stone-500">Harga Lama</div>
                <div className="mt-1 font-mono font-bold text-stone-900">
                  Rp {Number(previewData.current?.total_price || 0).toLocaleString('id-ID')}
                </div>
              </div>
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                <div className="text-emerald-700">Harga Baru</div>
                <div className="mt-1 font-mono font-bold text-emerald-900">
                  Rp {Number(previewData.quote?.grand_total || 0).toLocaleString('id-ID')}
                </div>
              </div>
            </div>

            {Number(previewData.current?.amount_paid || 0) + Number(previewData.current?.applied_deposit || 0) > Number(previewData.quote?.grand_total || 0) && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                Kelebihan pembayaran Rp {(
                  Number(previewData.current?.amount_paid || 0)
                  + Number(previewData.current?.applied_deposit || 0)
                  - Number(previewData.quote?.grand_total || 0)
                ).toLocaleString('id-ID')} - refund tidak dilakukan otomatis.
              </p>
            )}

            {error && (
              <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-xs font-semibold">
                {error}
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-2 pt-2">
              <button
                type="button"
                onClick={() => submitEditDecision(true)}
                disabled={loading}
                className="flex-1 px-4 py-2.5 border border-stone-300 text-stone-800 font-bold rounded-xl hover:bg-stone-100 disabled:opacity-50"
              >
                Pertahankan Harga Lama
              </button>
              <button
                type="button"
                onClick={() => submitEditDecision(false)}
                disabled={loading}
                className="flex-1 px-4 py-2.5 bg-emerald-800 hover:bg-emerald-700 text-white font-bold rounded-xl disabled:opacity-50"
              >
                {loading ? 'Menyimpan...' : 'Terapkan Harga Baru'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Payment Difference Modal */}
      {showPaymentModal && previewData && (
        <div className="fixed inset-0 z-[80] bg-black/60 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between pb-3 border-b border-stone-200">
              <h3 className="text-base font-bold text-stone-900">Konfirmasi Pembayaran Selisih</h3>
              <button
                type="button"
                onClick={() => { setShowPaymentModal(false); setPaymentError(null); }}
                className="text-stone-400 hover:text-stone-600 text-lg font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            {paymentError && (
              <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-xs font-semibold">
                {paymentError}
              </div>
            )}

            {/* Price Summary */}
            <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-stone-600">Kamar / Paket Baru</span>
                <span className="font-semibold text-stone-800">{previewData.quote?.rate_plan_name}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-stone-600">Harga Lama</span>
                <span className="font-mono font-semibold text-stone-800">
                  Rp {Number(previewData.current?.total_price || 0).toLocaleString('id-ID')}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-stone-600">Harga Baru</span>
                <span className="font-mono font-semibold text-emerald-800">
                  Rp {Number(previewData.quote?.grand_total || 0).toLocaleString('id-ID')}
                </span>
              </div>
              <div className="border-t border-stone-200 pt-2 flex justify-between text-sm">
                <span className="font-bold text-stone-800">Wajib Dibayar</span>
                <span className="font-mono font-bold text-rose-700">
                  Rp {Number(previewData.price_difference || 0).toLocaleString('id-ID')}
                </span>
              </div>
            </div>

            {/* Payment Form */}
            <div className="space-y-3">
              <div>
                <label className="block font-semibold text-stone-700 mb-1 text-xs">
                  Metode Pembayaran <span className="text-rose-500">*</span>
                </label>
                <select
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg text-xs"
                >
                  <option value="CASH">CASH</option>
                  <option value="TRANSFER">TRANSFER</option>
                  <option value="QRIS">QRIS</option>
                  <option value="DEBIT_CARD">DEBIT CARD</option>
                  <option value="CREDIT_CARD">CREDIT CARD</option>
                </select>
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1 text-xs">
                  Bukti Pembayaran <span className="text-rose-500">*</span>
                </label>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  onChange={(e) => setPaymentFile(e.target.files?.[0] || null)}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg text-xs file:mr-2 file:py-1 file:px-2 file:rounded-lg file:border-0 file:bg-emerald-50 file:text-emerald-700 file:font-semibold file:text-[11px] cursor-pointer"
                />
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1 text-xs">Catatan (Opsional)</label>
                <input
                  type="text"
                  value={paymentNote}
                  onChange={(e) => setPaymentNote(e.target.value)}
                  placeholder="Catatan pembayaran..."
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg text-xs"
                />
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 pt-3 border-t border-stone-200">
              <button
                type="button"
                onClick={() => { setShowPaymentModal(false); setPaymentError(null); }}
                className="px-4 py-2 border border-stone-300 text-stone-700 font-bold rounded-xl hover:bg-stone-100 transition-colors cursor-pointer text-xs"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleSubmitWithPayment}
                disabled={paymentSubmitting || !paymentFile}
                className="px-5 py-2 bg-emerald-800 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold rounded-xl shadow-xs transition-colors cursor-pointer text-xs"
              >
                {paymentSubmitting ? 'Menyimpan...' : 'Konfirmasi Pembayaran & Simpan'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
};
