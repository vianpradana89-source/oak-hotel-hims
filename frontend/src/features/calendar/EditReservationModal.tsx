import React, { useState, useEffect, useCallback } from 'react';
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
  const [roomTypes, setRoomTypes] = useState<any[]>([]);
  const [rooms, setRooms] = useState<any[]>([]);
  const [ratePlans, setRatePlans] = useState<any[]>([]);

  // Preview State
  const [previewData, setPreviewData] = useState<any>(null);

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
  }, [reservation, isOpen]);

  // Load Room Types, Rooms, and Rate Plans
  useEffect(() => {
    if (!isOpen) return;
    const loadMasters = async () => {
      try {
        const [rtRes, rRes, rpRes] = await Promise.all([
          safeFetchJson<{ data?: any[] }>(`/api/room-types?property_id=${propertyId}`, undefined, undefined, authFetch),
          safeFetchJson<{ data?: any[] }>(`/api/rooms?property_id=${propertyId}`, undefined, undefined, authFetch),
          safeFetchJson<{ data?: any[] }>(`/api/pricing/rate-plans?property_id=${propertyId}`, undefined, undefined, authFetch)
        ]);
        if (rtRes.ok && rtRes.data?.data) {
          setRoomTypes(rtRes.data.data);
        }
        if (rRes.ok && rRes.data?.data) {
          setRooms(rRes.data.data);
        }
        if (rpRes.ok && rpRes.data?.data) {
          setRatePlans(rpRes.data.data);
        }
      } catch (err) {
        console.warn('Failed to load master data for edit modal', err);
      }
    };
    loadMasters();
  }, [isOpen, propertyId, authFetch]);

  // Fetch Pricing Preview
  const fetchPreview = useCallback(async () => {
    if (!reservation?.id || !roomTypeId || !checkIn || (!checkOut && stayType !== 'DAY_USE')) return;
    try {
      setPreviewLoading(true);
      setError(null);
      const result = await safeFetchJson<{ data?: any }>(
        `/api/reservations/${reservation.id}/edit-preview`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            guest_name: guestName,
            guest_phone: guestPhone,
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
      if (result.ok && result.data?.data) {
        setPreviewData(result.data.data);
      } else {
        setError(result.errorMessage || 'Gagal menghitung pratinjau harga');
      }
    } catch (err: any) {
      console.warn('Preview error', err);
    } finally {
      setPreviewLoading(false);
    }
  }, [reservation, roomTypeId, roomId, ratePlanId, checkIn, checkOut, stayType, adults, children, guestName, guestPhone, authFetch]);

  useEffect(() => {
    if (isOpen && checkIn && roomTypeId) {
      fetchPreview();
    }
  }, [isOpen, checkIn, checkOut, stayType, roomTypeId, roomId, ratePlanId, adults, children, fetchPreview]);

  // Submit Edit
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reservation?.id) return;
    try {
      setLoading(true);
      setError(null);

      const payload = {
        guest_name: guestName.trim(),
        guest_phone: guestPhone.trim(),
        guest_segment: guestSegment,
        booker_name: bookerName.trim() || guestName.trim(),
        booker_phone: bookerPhone.trim() || guestPhone.trim(),
        referral: referral.trim(),
        notes: notes.trim(),
        adults: Number(adults),
        children: Number(children),
        room_type_id: roomTypeId ? Number(roomTypeId) : undefined,
        room_id: roomId ? Number(roomId) : undefined,
        rate_plan_id: ratePlanId ? Number(ratePlanId) : undefined,
        check_in: checkIn,
        check_out: stayType === 'DAY_USE' ? checkIn : checkOut,
        stay_type: stayType,
        check_in_time: checkInTime,
        check_out_time: checkOutTime,
        property_id: propertyId
      };

      const result = await safeFetchJson(
        `/api/reservations/${reservation.id}/edit`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        },
        undefined,
        authFetch
      );

      if (!result.ok) {
        throw new Error(result.errorMessage || 'Gagal menyimpan perubahan reservasi');
      }

      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Terjadi kesalahan saat menyimpan reservasi');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const filteredRooms = rooms.filter((r) => !roomTypeId || r.room_type_id === roomTypeId);
  const filteredRatePlans = ratePlans.filter((rp) => !roomTypeId || !rp.room_type_id || rp.room_type_id === roomTypeId);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 overflow-y-auto">
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
                    setRoomId(null);
                  }}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg"
                >
                  <option value="">Pilih Tipe Kamar</option>
                  {roomTypes.map((rt) => (
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
                  value={roomId || ''}
                  onChange={(e) => setRoomId(Number(e.target.value) || null)}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg"
                >
                  <option value="">Unassigned (Pilih Nanti)</option>
                  {filteredRooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      Kamar {r.room_number} (Lt. {r.floor || 1})
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
                  <option value="">Standard Rate</option>
                  {filteredRatePlans.map((rp) => (
                    <option key={rp.id} value={rp.id}>
                      {rp.name} ({rp.meal_plan_name || rp.meal_plan || 'RO'})
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
                  <div className="text-stone-500 text-[10px]">Selisih Tagihan</div>
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
              disabled={loading || (previewData && previewData.room_overlap_conflict)}
              className="px-5 py-2 bg-emerald-800 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold rounded-xl shadow-xs transition-colors cursor-pointer"
            >
              {loading ? 'Menyimpan...' : 'Simpan Perubahan'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
