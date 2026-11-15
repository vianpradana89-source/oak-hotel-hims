import React, { useState, useEffect, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom';
import { safeFetchJson } from './calendarApi';
import { useAuth } from '../auth/AuthContext';
import { tryBuildDayUseInterval } from '../booking/dayUseInterval';
import { pricingApi } from '../roomMaster/pricingApi';
import type { RatePlan } from '../roomMaster/pricingApi';
import type { BookingCreateAvailability, CreateAvailabilityRoomType } from '../booking/quickBookingAvailability';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AddRoomToBookingModalProps {
  open: boolean;
  bid: string;
  propertyId: number;
  defaultGuestName?: string | null;
  defaultGuestPhone?: string | null;
  defaultGuestSegment?: string | null;
  defaultCheckIn?: string | null;
  defaultCheckOut?: string | null;
  onClose: () => void;
  onSuccess: (result: AddRoomSuccessResult) => void | Promise<void>;
}

export interface AddRoomSuccessResult {
  reservation: {
    id: number;
    booking_number: string;
    room_id: number;
    guest_name: string;
    check_in: string;
    check_out: string;
    total_price: number;
    [key: string]: unknown;
  };
  bid: string;
  booking_id: number;
  stay_sequence: number;
  correlation_id: string;
  effective_payment_state: unknown;
  new_booking_status: 'ACTIVE' | 'CANCELLED' | 'COMPLETED';
  group_financials: {
    existing_children_count: number;
    existing_group_total: number;
    existing_group_paid: number;
    existing_group_remaining: number;
    new_room_price: number;
    projected_group_total: number;
    projected_group_remaining: number;
  };
}

interface FormErrors {
  checkIn?: string;
  checkOut?: string;
  dayUse?: string;
  roomType?: string;
  room?: string;
  ratePlan?: string;
  guestName?: string;
}

// ─── Modal ───────────────────────────────────────────────────────────────────

export const AddRoomToBookingModal: React.FC<AddRoomToBookingModalProps> = ({
  open,
  bid,
  propertyId,
  defaultGuestName,
  defaultGuestPhone,
  defaultGuestSegment,
  defaultCheckIn,
  defaultCheckOut,
  onClose,
  onSuccess,
}) => {
  const { authFetch } = useAuth();

  // ── Form state ──────────────────────────────────────────────────────────
  const [stayType, setStayType] = useState<'OVERNIGHT' | 'DAY_USE'>('OVERNIGHT');
  const [checkIn, setCheckIn] = useState<string>('');
  const [checkOut, setCheckOut] = useState<string>('');

  const [dayUseStartTime, setDayUseStartTime] = useState<string>('10:00');
  const [dayUseHours, setDayUseHours] = useState<number>(6);

  const [guestName, setGuestName] = useState<string>('');
  const [guestPhone, setGuestPhone] = useState<string>('');
  const [guestSegment, setGuestSegment] = useState<string>('Reguler');
  const [specialRequests, setSpecialRequests] = useState<string>('');

  // ── Master data state ───────────────────────────────────────────────────
  const [availableRoomTypes, setAvailableRoomTypes] = useState<CreateAvailabilityRoomType[] | null>(null);
  const [availabilityLoading, setAvailabilityLoading] = useState<boolean>(false);
  const [ratePlans, setRatePlans] = useState<RatePlan[]>([]);

  // ── Selected values ─────────────────────────────────────────────────────
  const [selectedRoomTypeId, setSelectedRoomTypeId] = useState<number | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<number | null>(null);
  const [selectedRatePlanId, setSelectedRatePlanId] = useState<number | null>(null);

   // ── UI state ────────────────────────────────────────────────────────────
   const [error, setError] = useState<string | null>(null);
   const [backendError, setBackendError] = useState<string | null>(null);
   const [submitting, setSubmitting] = useState<boolean>(false);
   // Tracks whether the backend has definitely committed the mutation.
   // Once true, the user may NOT submit again (defends against duplicate POST).
   const [mutationSucceeded, setMutationSucceeded] = useState(false);

  // Ref to keep a single idempotency key per submit attempt
  const submitKeyRef = useRef<string | null>(null);
  const availabilityRequestRef = useRef(0);

  // ── Reset on open ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;

     submitKeyRef.current = null;
     setError(null);
     setBackendError(null);
     setSubmitting(false);
     setMutationSucceeded(false);
     setSelectedRoomTypeId(null);
    setSelectedRoomId(null);
    setSelectedRatePlanId(null);
    setAvailableRoomTypes(null);
    setRatePlans([]);
    availabilityRequestRef.current += 1;

    setStayType('OVERNIGHT');
    setCheckIn(defaultCheckIn ? String(defaultCheckIn).slice(0, 10) : '');
    setCheckOut(defaultCheckOut ? String(defaultCheckOut).slice(0, 10) : '');
    setDayUseStartTime('10:00');
    setDayUseHours(6);
    setGuestName(defaultGuestName || '');
    setGuestPhone(defaultGuestPhone || '');
    setGuestSegment(defaultGuestSegment || 'Reguler');
    setSpecialRequests('');
  }, [open, defaultCheckIn, defaultCheckOut, defaultGuestName, defaultGuestPhone, defaultGuestSegment]);

  // ── Load rate plans (server-authoritative) ──────────────────────────────
  useEffect(() => {
    if (!open || !propertyId) return;
    let cancelled = false;

    pricingApi
      .listRatePlans(propertyId, { is_active: true })
      .then((plans) => {
        if (cancelled) return;
        const filtered = plans.filter(
          (rp) => rp.is_active !== false && rp.is_archived !== true
        );
        setRatePlans(filtered);
      })
      .catch(() => {
        if (!cancelled) setRatePlans([]);
      });

    return () => { cancelled = true; };
  }, [open, propertyId]);

  // ── Load availability when dates are ready ──────────────────────────────
  useEffect(() => {
    if (!open || !checkIn) {
      availabilityRequestRef.current += 1;
      setAvailableRoomTypes(null);
      setAvailabilityLoading(false);
      return;
    }

    const requestId = ++availabilityRequestRef.current;
    const controller = new AbortController();
    const effectiveCheckOut = stayType === 'DAY_USE' ? checkIn : checkOut;

    if (stayType === 'OVERNIGHT' && !effectiveCheckOut) {
      setAvailableRoomTypes(null);
      setAvailabilityLoading(false);
      return;
    }

    const params = new URLSearchParams({
      property_id: String(propertyId),
      check_in: checkIn,
      stay_type: stayType,
    });
    if (stayType === 'OVERNIGHT' && effectiveCheckOut) {
      params.set('check_out', effectiveCheckOut);
    }
    if (stayType === 'DAY_USE') {
      const interval = tryBuildDayUseInterval(checkIn, dayUseStartTime, dayUseHours);
      if (interval.ok) {
        params.set('start_at', interval.start_at);
        params.set('end_at', interval.end_at);
      }
    }

    setAvailabilityLoading(true);
    setAvailableRoomTypes(null);

    safeFetchJson<{ data?: BookingCreateAvailability }>(
      `/api/bookings/create-availability?${params.toString()}`,
      { signal: controller.signal },
      'Gagal memuat ketersediaan kamar.',
      authFetch
    ).then((result) => {
      if (requestId !== availabilityRequestRef.current) return;
      if (!result.ok || !result.data?.data) {
        setAvailableRoomTypes([]);
        setError(result.errorMessage || 'Gagal memuat ketersediaan kamar.');
        return;
      }
      setAvailableRoomTypes(result.data.data.room_types || []);
    }).catch((err: any) => {
      if (requestId === availabilityRequestRef.current && err?.name !== 'AbortError') {
        setAvailableRoomTypes([]);
        setError('Gagal memuat ketersediaan kamar.');
      }
    }).finally(() => {
      if (requestId === availabilityRequestRef.current) setAvailabilityLoading(false);
    });

    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, propertyId, checkIn, checkOut, stayType, dayUseStartTime, dayUseHours, authFetch]);

  // ── Reconcile selections after availability loads ───────────────────────
  useEffect(() => {
    if (availabilityLoading || availableRoomTypes === null) return;
    setSelectedRoomTypeId((prev) => {
      if (!prev) return null;
      return availableRoomTypes.some((t) => Number(t.id) === Number(prev)) ? prev : null;
    });
  }, [availableRoomTypes, availabilityLoading]);

  useEffect(() => {
    if (availabilityLoading || availableRoomTypes === null) return;
    if (!selectedRoomTypeId) {
      setSelectedRoomId(null);
      return;
    }
    const rooms = availableRoomTypes.find((t) => Number(t.id) === Number(selectedRoomTypeId))?.rooms || [];
    setSelectedRoomId((prev) => {
      if (rooms.some((r) => Number(r.id) === Number(prev))) return prev;
      return rooms.length === 1 ? Number(rooms[0].id) : null;
    });
  }, [availableRoomTypes, availabilityLoading, selectedRoomTypeId]);

  // ── Auto-select compatible rate plan when room type changes ─────────────
  // ── Derived: rate plans compatible with current stayType + roomType ────
  const compatibleRatePlans = ratePlans.filter(
    (rp) =>
      Number(rp.room_type_id) === Number(selectedRoomTypeId) &&
      (stayType === 'DAY_USE'
        ? rp.rate_type === 'DAY_USE'
        : rp.rate_type !== 'DAY_USE')
  );

  useEffect(() => {
    if (!selectedRoomTypeId) {
      setSelectedRatePlanId(null);
      return;
    }
    if (compatibleRatePlans.length === 0) {
      setSelectedRatePlanId(null);
      return;
    }
    if (compatibleRatePlans.some((rp) => Number(rp.id) === Number(selectedRatePlanId))) return;
    setSelectedRatePlanId(compatibleRatePlans[0]?.id ?? null);
  }, [compatibleRatePlans, selectedRoomTypeId, stayType, selectedRatePlanId]);

  // ── Validation ──────────────────────────────────────────────────────────
  const validate = useCallback((): FormErrors => {
    const errors: FormErrors = {};

    if (!checkIn) {
      errors.checkIn = 'Tanggal check-in wajib diisi';
    }

    if (stayType === 'OVERNIGHT') {
      if (!checkOut) {
        errors.checkOut = 'Tanggal check-out wajib diisi';
      } else if (checkIn && checkOut <= checkIn) {
        errors.checkOut = 'Check-out harus setelah check-in';
      }
    } else {
      // DAY_USE
      const interval = tryBuildDayUseInterval(checkIn, dayUseStartTime, dayUseHours);
      if (!interval.ok) {
        errors.dayUse = interval.error;
      }
    }

    if (!selectedRoomTypeId) {
      errors.roomType = 'Tipe kamar wajib dipilih';
    }
    if (!selectedRoomId) {
      errors.room = 'Kamar fisik wajib dipilih';
    }
    if (
      !selectedRatePlanId ||
      !compatibleRatePlans.some((rp) => Number(rp.id) === Number(selectedRatePlanId))
    ) {
      errors.ratePlan = 'Rate plan wajib dipilih';
    }
    if (!guestName.trim()) {
      errors.guestName = 'Nama tamu wajib diisi';
    }

    return errors;
  }, [checkIn, checkOut, stayType, dayUseStartTime, dayUseHours, selectedRoomTypeId, selectedRoomId, selectedRatePlanId, guestName]);

  // ── Submit ──────────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Defense-in-depth: prevent double-submit even if React batches events.
    if (submitting || mutationSucceeded) return;

    const errors = validate();
    const errorMessages = Object.values(errors).filter(Boolean);
    if (errorMessages.length > 0) {
      setError(errorMessages.join('\n'));
      return;
    }

    setError(null);
    setBackendError(null);

    // Generate idempotency key ONCE per submit attempt
    if (!submitKeyRef.current) {
      submitKeyRef.current = crypto.randomUUID();
    }
    const idempotencyKey = submitKeyRef.current;

    try {
      setSubmitting(true);

      const body: Record<string, unknown> = {
        property_id: propertyId,
        room_id: Number(selectedRoomId),
        rate_plan_id: Number(selectedRatePlanId),
        guest_name: guestName.trim(),
        guest_phone: guestPhone.trim() || null,
        guest_segment: guestSegment || null,
        check_in: checkIn,
        check_out: stayType === 'DAY_USE' ? checkIn : checkOut,
        stay_type: stayType,
        special_requests: specialRequests.trim() || null,
      };

      if (stayType === 'DAY_USE') {
        const interval = tryBuildDayUseInterval(checkIn, dayUseStartTime, dayUseHours);
        if (interval.ok) {
          body.start_at = interval.start_at;
          body.end_at = interval.end_at;
        }
      }

      const result = await safeFetchJson<{ data?: AddRoomSuccessResult }>(
        `/api/bookings/${bid.toUpperCase()}/reservations`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(body),
        },
        'Gagal menambahkan kamar.',
        authFetch
      );

      if (!result.ok) {
        // Map backend error codes to user-friendly messages
        const code = (result.data as any)?.code;
        const rawMessage = result.errorMessage || (result.data as any)?.message || 'Gagal menambahkan kamar.';

        let userMessage: string;
        switch (code) {
          case 'ROOM_OVERLAP':
            userMessage = `Kamar ini bertabrakan dengan reservasi lain pada periode yang diminta. ${rawMessage}`;
            break;
          case 'ROOM_OPERATIONAL_BLOCK':
            userMessage = `Kamar ini sedang diblokir untuk operasi pada tanggal yang diminta.`;
            break;
          case 'INSUFFICIENT_INVENTORY':
            userMessage = 'Stok kamar untuk tipe yang dipilih tidak mencukupi pada periode tersebut.';
            break;
          case 'RATE_PLAN_ROOM_TYPE_MISMATCH':
            userMessage = 'Rate plan tidak cocok dengan tipe kamar yang dipilih.';
            break;
          case 'ROOM_NOT_SELLABLE':
            userMessage = 'Kamar yang dipilih tidak dapat dijual (bukan status VACANT_CLEAN).';
            break;
          case 'BOOKING_EFFECTIVELY_TERMINAL':
            userMessage = 'Booking sudah berakhir (semua kamar sudah check-out atau dibatalkan).';
            break;
          case 'CHILD_CHECKED_IN_OR_OUT':
            userMessage = 'Tidak dapat menambahkan kamar karena ada anak booking lain yang sudah check-in atau check-out.';
            break;
           case 'PROPERTY_MISMATCH':
             userMessage = 'Booking tidak termasuk properti yang dipilih.';
             break;
          default:
            userMessage = rawMessage;
        }

        setBackendError(userMessage);
        submitKeyRef.current = null; // non-2xx: mutation not performed, allow new attempt
        return;
      }

       // ── Definite SUCCESS: mutation committed server-side ────────────────
       // Reset idempotency key now — the server has already applied the change.
       // A later failure is a UI refresh issue, NOT an ambiguous mutation.
       submitKeyRef.current = null;
       // Lock out further submits: the mutation is done.
       setMutationSucceeded(true);

      if (!result.data?.data) {
        setBackendError('Respons backend tidak memuat data reservasi.');
        return;
      }

      try {
        await onSuccess(result.data.data);
        // onSuccess succeeded — safe to close the modal.
        onClose();
      } catch (callbackErr: any) {
        // Mutation succeeded but UI refresh failed. Do NOT retry the POST.
        // Keep the modal open so the user can see the result and optionally
        // trigger a manual reload from their side.
        setSubmitting(false);
        setBackendError(
          'Kamar berhasil ditambahkan, tetapi tampilan gagal diperbarui. ' +
          'Silakan coba muat ulang data.'
        );
        // eslint-disable-next-line no-console
        console.error('[AddRoomToBookingModal] onSuccess callback failed:', callbackErr);
      }
    } catch (err: any) {
      // Network exception: ambiguous outcome.
      // Server may have committed but response was lost; preserve the key
      // so idempotency middleware can replay the previous result instead of
      // creating a duplicate reservation.
      const message = err?.message || 'Terjadi kesalahan jaringan. Coba lagi.';
      setBackendError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const selectedRoomType = availableRoomTypes?.find(
    (t) => Number(t.id) === Number(selectedRoomTypeId)
  );
  const selectedRooms = selectedRoomType?.rooms || [];
  const selectedRatePlan = ratePlans.find((rp) => Number(rp.id) === Number(selectedRatePlanId));

  if (!open) return null;

  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-[70] bg-black/65 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label="Tambah Kamar ke Booking"
    >
      <div className="bg-white rounded-2xl max-w-2xl w-full p-6 shadow-2xl space-y-4 my-8 max-h-[90vh] flex flex-col border border-emerald-900/15">
        {/* Header */}
        <div className="px-6 py-4 bg-gradient-to-r from-emerald-950 via-emerald-900 to-teal-950 text-white flex items-center justify-between border-b border-emerald-800/40">
          <div>
            <h3 className="text-base font-bold tracking-tight flex items-center gap-2">
              <span>🛏️ Tambah Kamar ke Booking</span>
              <span className="px-2 py-0.5 text-xs font-bold bg-emerald-700/80 text-emerald-100 rounded-full border border-emerald-600/50 font-mono">
                {bid.toUpperCase()}
              </span>
            </h3>
            <p className="text-xs text-emerald-300/80 mt-0.5">
              Menambahkan reservasi anak baru ke booking yang sudah ada.
            </p>
          </div>
           <button
             type="button"
             onClick={onClose}
             disabled={submitting}
             className="text-emerald-300 hover:text-white p-2 rounded-lg hover:bg-emerald-800/40 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
             aria-label="Tutup"
           >
            ✕
          </button>
        </div>

        {/* Error display */}
        {error && (
          <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-xs font-semibold whitespace-pre-line">
            {error}
          </div>
        )}
        {backendError && (
          <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-xs font-semibold">
            {backendError}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4 overflow-y-auto pr-1 flex-1 text-xs">
          {/* Section 1: Stay Dates */}
          <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 space-y-3">
            <h4 className="font-bold text-stone-800 uppercase tracking-wider text-[11px]">
              1. Tanggal Menginap
            </h4>

            {/* Stay type toggle */}
            <div className="flex items-center gap-2">
              <span className="text-stone-600 font-semibold">Tipe Menginap:</span>
              <button
                type="button"
                onClick={() => setStayType('OVERNIGHT')}
                className={`px-3 py-1.5 rounded-lg font-bold transition-colors cursor-pointer ${
                  stayType === 'OVERNIGHT'
                    ? 'bg-emerald-800 text-white'
                    : 'bg-white border border-stone-300 text-stone-700 hover:bg-stone-100'
                }`}
              >
                OVERNIGHT
              </button>
              <button
                type="button"
                onClick={() => setStayType('DAY_USE')}
                className={`px-3 py-1.5 rounded-lg font-bold transition-colors cursor-pointer ${
                  stayType === 'DAY_USE'
                    ? 'bg-emerald-800 text-white'
                    : 'bg-white border border-stone-300 text-stone-700 hover:bg-stone-100'
                }`}
              >
                DAY USE
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-stone-700 mb-1">
                  Check-in <span className="text-rose-500">*</span>
                </label>
                <input
                  type="date"
                  value={checkIn}
                  onChange={(e) => setCheckIn(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg text-xs font-mono focus:border-emerald-600 focus:outline-hidden"
                  required
                />
                {error?.includes('checkIn') && (
                  <p className="text-rose-600 mt-0.5">{error.split('\n').find((l) => l.includes('check-in'))}</p>
                )}
              </div>

              {stayType === 'OVERNIGHT' ? (
                <div>
                  <label className="block font-semibold text-stone-700 mb-1">
                    Check-out <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="date"
                    value={checkOut}
                    onChange={(e) => setCheckOut(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg text-xs font-mono focus:border-emerald-600 focus:outline-hidden"
                    required
                  />
                  {(() => { const v = validate(); return v.checkOut; })() && (
                    <p className="text-rose-600 mt-0.5">{(() => { const v = validate(); return v.checkOut; })()}</p>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">Jam Mulai</label>
                    <input
                      type="time"
                      value={dayUseStartTime}
                      onChange={(e) => setDayUseStartTime(e.target.value)}
                      className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg text-xs font-mono focus:border-emerald-600 focus:outline-hidden"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">Durasi (jam)</label>
                    <input
                      type="number"
                      min={1}
                      max={24}
                      value={dayUseHours}
                      onChange={(e) => setDayUseHours(Number(e.target.value))}
                      className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg text-xs font-mono focus:border-emerald-600 focus:outline-hidden"
                    />
                  </div>
                </div>
              )}
            </div>

            {stayType === 'DAY_USE' && error?.includes('dayUse') && (
              <p className="text-rose-600">{error.split('\n').find((l) => l.includes('Day Use') || l.includes('durasi') || l.includes('Jam'))}</p>
            )}

            {availabilityLoading && (
              <p className="text-emerald-700 font-semibold animate-pulse">Memuat ketersediaan kamar...</p>
            )}
          </div>

          {/* Section 2: Room Selection */}
          <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 space-y-3">
            <h4 className="font-bold text-stone-800 uppercase tracking-wider text-[11px]">
              2. Kamar
            </h4>

            <div>
              <label className="block font-semibold text-stone-700 mb-1">
                Tipe Kamar <span className="text-rose-500">*</span>
              </label>
              <select
                value={selectedRoomTypeId ?? ''}
                onChange={(e) => setSelectedRoomTypeId(e.target.value ? Number(e.target.value) : null)}
                disabled={availabilityLoading || (availableRoomTypes?.length ?? 0) === 0}
                className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg text-xs focus:border-emerald-600 focus:outline-hidden disabled:bg-stone-100 disabled:cursor-not-allowed"
              >
                <option value="">— Pilih tipe kamar —</option>
                {availableRoomTypes?.map((rt) => (
                  <option key={rt.id} value={rt.id}>
                    {rt.name} ({rt.code}) — {rt.rooms?.length ?? 0} kamar
                  </option>
                ))}
              </select>
              {(error || '').includes('Tipe kamar') && (
                <p className="text-rose-600 mt-0.5">Tipe kamar wajib dipilih</p>
              )}
            </div>

            {selectedRoomTypeId && (
              <div>
                <label className="block font-semibold text-stone-700 mb-1">
                  Kamar Fisik <span className="text-rose-500">*</span>
                </label>
                <select
                  value={selectedRoomId ?? ''}
                  onChange={(e) => setSelectedRoomId(e.target.value ? Number(e.target.value) : null)}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg text-xs focus:border-emerald-600 focus:outline-hidden"
                >
                  <option value="">— Pilih kamar fisik —</option>
                  {selectedRooms.map((room) => (
                    <option key={room.id} value={room.id}>
                      {room.room_number || `Kamar ${room.id}`}
                    </option>
                  ))}
                </select>
                {selectedRooms.length === 0 && !availabilityLoading && (
                  <p className="text-rose-600 mt-0.5">Tidak ada kamar fisik tersedia untuk periode ini.</p>
                )}
              </div>
            )}
          </div>

          {/* Section 3: Rate Plan */}
          <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 space-y-3">
            <h4 className="font-bold text-stone-800 uppercase tracking-wider text-[11px]">
              3. Rate Plan
            </h4>
            <div>
              <label className="block font-semibold text-stone-700 mb-1">
                Rate Plan <span className="text-rose-500">*</span>
              </label>
               <select
                 value={selectedRatePlanId ?? ''}
                 onChange={(e) => setSelectedRatePlanId(e.target.value ? Number(e.target.value) : null)}
                 disabled={!selectedRoomTypeId || compatibleRatePlans.length === 0}
                 className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg text-xs focus:border-emerald-600 focus:outline-hidden disabled:bg-stone-100 disabled:cursor-not-allowed"
               >
                 <option value="">— Pilih rate plan —</option>
                 {compatibleRatePlans.map((rp) => (
                   <option key={rp.id} value={rp.id}>
                     {rp.name} ({rp.code})
                   </option>
                 ))}
               </select>
               {selectedRoomTypeId && compatibleRatePlans.length === 0 && (
                 <p className="text-rose-600 mt-0.5">Tidak ada rate plan aktif untuk tipe kamar ini.</p>
               )}
            </div>
            {selectedRatePlan && (
              <p className="text-stone-500 text-[11px]">
                Rate plan: <span className="font-semibold text-stone-700">{selectedRatePlan.name}</span>{' '}
                ({selectedRatePlan.code})
              </p>
            )}
          </div>

          {/* Section 4: Guest Information */}
          <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 space-y-3">
            <h4 className="font-bold text-stone-800 uppercase tracking-wider text-[11px]">
              4. Data Tamu
            </h4>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-stone-700 mb-1">
                  Nama Tamu <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  placeholder="Nama lengkap tamu"
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg text-xs focus:border-emerald-600 focus:outline-hidden"
                />
              </div>
              <div>
                <label className="block font-semibold text-stone-700 mb-1">No. Telepon</label>
                <input
                  type="tel"
                  value={guestPhone}
                  onChange={(e) => setGuestPhone(e.target.value)}
                  placeholder="08xxxxxxxxxx"
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg text-xs font-mono focus:border-emerald-600 focus:outline-hidden"
                />
              </div>
            </div>

            <div>
              <label className="block font-semibold text-stone-700 mb-1">Segment Tamu</label>
              <select
                value={guestSegment}
                onChange={(e) => setGuestSegment(e.target.value)}
                className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg text-xs focus:border-emerald-600 focus:outline-hidden"
              >
                <option value="Reguler">Reguler</option>
                <option value="Corporate">Corporate</option>
                <option value="Group">Group</option>
                <option value="VIP">VIP</option>
              </select>
            </div>
          </div>

          {/* Section 5: Special Requests */}
          <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 space-y-3">
            <h4 className="font-bold text-stone-800 uppercase tracking-wider text-[11px]">
              5. Permintaan Khusus
            </h4>
            <div>
              <label className="block font-semibold text-stone-700 mb-1">Catatan</label>
              <textarea
                value={specialRequests}
                onChange={(e) => setSpecialRequests(e.target.value)}
                placeholder="Permintaan khusus tamu (opsional)"
                rows={3}
                className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg text-xs focus:border-emerald-600 focus:outline-hidden resize-y"
              />
            </div>
          </div>

           {/* Footer Actions */}
           <div className="flex items-center justify-end gap-2 pt-3 border-t border-stone-200">
             <button
               type="button"
               onClick={onClose}
               disabled={submitting}
               className="px-4 py-2 border border-stone-300 text-stone-700 font-bold rounded-xl hover:bg-stone-100 transition-colors cursor-pointer disabled:opacity-50"
             >
               Batal
             </button>
             <button
               type="submit"
               disabled={submitting || availabilityLoading || mutationSucceeded}
               className="px-5 py-2 bg-emerald-800 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold rounded-xl shadow-xs transition-colors cursor-pointer"
             >
               {mutationSucceeded ? 'Kamar Sudah Ditambahkan' : submitting ? 'Menambahkan...' : 'Tambah Kamar'}
             </button>
           </div>
        </form>
      </div>
    </div>,
    document.body
  );
};
