import React, { useState, useEffect, useCallback } from 'react';
import { pricingApi } from './pricingApi';
import type {
  RatePlan,
  RateCalendarMatrix,
  RateCalendarDay,
  CreateRateOverrideDto
} from './pricingApi';
import type { RoomType } from './roomMasterTypes';

interface Props {
  propertyId: number | null;
  roomTypes?: RoomType[];
  initialRatePlanId?: number | null;
  onChanged: (message: string) => void;
  onOpenRatePlans?: () => void;
}

function formatIDR(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0
  }).format(amount);
}

function toLocalDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const DAY_NAMES = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

export default function RateCalendarView({ propertyId, initialRatePlanId, onChanged, onOpenRatePlans }: Props) {
  const [ratePlans, setRatePlans] = useState<RatePlan[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(initialRatePlanId || null);
  const [loadingPlans, setLoadingPlans] = useState(true);

  // Date Range (default 14 days from today)
  const [startDate, setStartDate] = useState<string>(() => toLocalDateString(new Date()));
  const [daysCount, setDaysCount] = useState<14 | 30>(14);

  // Matrix State
  const [matrix, setMatrix] = useState<RateCalendarMatrix | null>(null);
  const [loadingMatrix, setLoadingMatrix] = useState(false);
  const [matrixError, setMatrixError] = useState<string | null>(null);

  // Override Modal
  const [showOverrideModal, setShowOverrideModal] = useState(false);
  const [overrideForm, setOverrideForm] = useState<CreateRateOverrideDto & { specificDays: number[] }>({
    start_date: toLocalDateString(new Date()),
    end_date: toLocalDateString(new Date(Date.now() + 86400000)),
    override_rate: 600000,
    reason: '',
    replace_existing: false,
    specificDays: [0, 1, 2, 3, 4, 5, 6]
  });
  const [submittingOverride, setSubmittingOverride] = useState(false);
  const [overrideModalError, setOverrideModalError] = useState<string | null>(null);
  const [collisionWarning, setCollisionWarning] = useState<boolean>(false);

  // Load Rate Plans for property
  useEffect(() => {
    if (!propertyId) return;
    setLoadingPlans(true);
    pricingApi
      .listRatePlans(propertyId, { is_active: true })
      .then((plans) => {
        setRatePlans(plans);
        if (!selectedPlanId && plans.length > 0) {
          setSelectedPlanId(plans[0].id);
        } else if (initialRatePlanId && plans.some((p) => p.id === initialRatePlanId)) {
          setSelectedPlanId(initialRatePlanId);
        }
      })
      .catch((err) => {
        console.error('Failed to load rate plans:', err);
      })
      .finally(() => {
        setLoadingPlans(false);
      });
  }, [propertyId, initialRatePlanId]);

  // Compute calculated end date for matrix
  const computeEndDate = useCallback(
    (start: string, count: number) => {
      const parts = start.split('-').map(Number);
      const d = new Date(parts[0], parts[1] - 1, parts[2]);
      d.setDate(d.getDate() + count);
      return toLocalDateString(d);
    },
    []
  );

  // Load Matrix
  const loadMatrix = useCallback(async () => {
    if (!propertyId || !selectedPlanId) {
      setMatrix(null);
      return;
    }
    setLoadingMatrix(true);
    setMatrixError(null);
    const end = computeEndDate(startDate, daysCount);
    try {
      const data = await pricingApi.getRateCalendar(propertyId, selectedPlanId, startDate, end);
      setMatrix(data);
    } catch (err: any) {
      console.error('Failed to load rate calendar matrix:', err);
      setMatrixError('Data Rate Calendar belum dapat dimuat. Coba muat ulang.');
    } finally {
      setLoadingMatrix(false);
    }
  }, [propertyId, selectedPlanId, startDate, daysCount, computeEndDate]);

  useEffect(() => {
    void loadMatrix();
  }, [loadMatrix]);

  // Date Navigation
  function handleShiftDays(delta: number) {
    const parts = startDate.split('-').map(Number);
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    d.setDate(d.getDate() + delta);
    setStartDate(toLocalDateString(d));
  }

  function handleResetToday() {
    setStartDate(toLocalDateString(new Date()));
  }

  // Open Override Modal
  function handleOpenOverride(targetDay?: RateCalendarDay) {
    const start = targetDay ? targetDay.date : startDate;
    const parts = start.split('-').map(Number);
    const nextD = new Date(parts[0], parts[1] - 1, parts[2]);
    nextD.setDate(nextD.getDate() + 1);
    const end = toLocalDateString(nextD);

    const baseRate = matrix?.rate_plan.base_rate || 500000;
    setOverrideForm({
      start_date: start,
      end_date: end,
      override_rate: targetDay?.effective_rate || baseRate,
      reason: targetDay?.reason || '',
      replace_existing: false,
      specificDays: [0, 1, 2, 3, 4, 5, 6]
    });
    setCollisionWarning(false);
    setOverrideModalError(null);
    setShowOverrideModal(true);
  }

  // Toggle Day of Week in Override Form
  function handleToggleDay(dayIndex: number) {
    const current = [...overrideForm.specificDays];
    const idx = current.indexOf(dayIndex);
    if (idx >= 0) {
      if (current.length === 1) return; // Keep at least one day
      current.splice(idx, 1);
    } else {
      current.push(dayIndex);
    }
    setOverrideForm({ ...overrideForm, specificDays: current.sort() });
  }

  // Submit Override
  async function handleSubmitOverride(e: React.FormEvent) {
    e.preventDefault();
    if (!propertyId || !selectedPlanId) return;
    setSubmittingOverride(true);
    setOverrideModalError(null);

    const isAllDays = overrideForm.specificDays.length === 7;
    const dto: CreateRateOverrideDto = {
      start_date: overrideForm.start_date,
      end_date: overrideForm.end_date,
      override_rate: Number(overrideForm.override_rate),
      days_of_week: isAllDays ? null : overrideForm.specificDays,
      reason: overrideForm.reason?.trim() || null,
      replace_existing: overrideForm.replace_existing
    };

    try {
      await pricingApi.upsertRateOverride(propertyId, selectedPlanId, dto);
      onChanged(`Tarif override sebesar ${formatIDR(dto.override_rate)} berhasil disimpan.`);
      setShowOverrideModal(false);
      void loadMatrix();
    } catch (err: any) {
      if (err.collision || err.message?.includes('collision') || err.message?.includes('tabrakan')) {
        setCollisionWarning(true);
        setOverrideModalError('Terdapat override lain pada tanggal tersebut. Centang pilihan di bawah untuk mengganti override lama.');
      } else {
        setOverrideModalError(err.message || 'Gagal menyimpan override.');
      }
    } finally {
      setSubmittingOverride(false);
    }
  }

  // Reset Day to Base Rate
  async function handleResetDay(day: RateCalendarDay) {
    if (!propertyId || !day.override_id) return;
    if (!confirm(`Kembalikan tarif tanggal ${day.date} ke harga dasar (${formatIDR(day.base_rate)})?`)) {
      return;
    }

    try {
      await pricingApi.deleteRateOverride(propertyId, day.override_id);
      onChanged(`Tarif tanggal ${day.date} berhasil dikembalikan ke harga dasar.`);
      void loadMatrix();
    } catch (err: any) {
      alert(`Gagal mereset tarif: ${err.message}`);
    }
  }

  const selectedPlan = ratePlans.find((p) => p.id === selectedPlanId);

  return (
    <div className="space-y-4">
      {/* Top Filter & Navigation Bar */}
      <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-xs flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* Rate Plan Selector */}
          <div className="flex items-center gap-2">
            <label className="text-xs font-semibold text-gray-600 uppercase tracking-wider">Rate Plan:</label>
            {loadingPlans ? (
              <span className="text-xs text-gray-400">Memuat rate plan...</span>
            ) : ratePlans.length === 0 ? (
              <span className="text-xs text-amber-600 font-medium">Belum ada Rate Plan aktif</span>
            ) : (
              <select
                value={selectedPlanId || ''}
                onChange={(e) => setSelectedPlanId(Number(e.target.value))}
                className="text-sm font-semibold bg-gray-50 border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-hidden focus:ring-2 focus:ring-emerald-500 text-emerald-950"
              >
                {ratePlans.map((p) => (
                  <option key={p.id} value={p.id}>
                    [{p.code}] {p.name} ({p.room_type_name || `Tipe ${p.room_type_id}`})
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Days Count Selector */}
          <div className="flex items-center bg-gray-100 p-0.5 rounded-lg border border-gray-300 text-xs font-semibold">
            <button
              type="button"
              onClick={() => setDaysCount(14)}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                daysCount === 14 ? 'bg-white shadow-xs text-emerald-800' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              14 Hari
            </button>
            <button
              type="button"
              onClick={() => setDaysCount(30)}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                daysCount === 30 ? 'bg-white shadow-xs text-emerald-800' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              30 Hari
            </button>
          </div>
        </div>

        {/* Date Navigation & Actions */}
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-gray-100 rounded-lg border border-gray-300 overflow-hidden">
            <button
              type="button"
              onClick={() => handleShiftDays(-7)}
              title="Mundur 7 hari"
              className="px-2.5 py-1.5 text-xs text-gray-700 hover:bg-gray-200 transition-colors"
            >
              &larr; 7 Hari
            </button>
            <button
              type="button"
              onClick={handleResetToday}
              className="px-3 py-1.5 text-xs font-bold text-gray-800 hover:bg-gray-200 border-x border-gray-300 transition-colors"
            >
              Hari Ini
            </button>
            <button
              type="button"
              onClick={() => handleShiftDays(7)}
              title="Maju 7 hari"
              className="px-2.5 py-1.5 text-xs text-gray-700 hover:bg-gray-200 transition-colors"
            >
              7 Hari &rarr;
            </button>
          </div>

          <button
            type="button"
            onClick={() => handleOpenOverride()}
            disabled={!selectedPlanId}
            className="px-4 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg shadow-xs transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
            </svg>
            Set Override Tarif / Promo
          </button>
        </div>
      </div>

      {/* Plan Info Strip */}
      {selectedPlan && (
        <div className="bg-emerald-50/70 border border-emerald-200 rounded-xl px-4 py-3 text-xs text-emerald-950 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <span className="font-mono font-bold bg-emerald-700 text-white px-2 py-0.5 rounded">
              {selectedPlan.code}
            </span>
            <span className="font-semibold text-sm">{selectedPlan.name}</span>
            <span className="text-emerald-700">| Tipe Kamar: <strong>{selectedPlan.room_type_name}</strong></span>
          </div>
          <div className="flex items-center gap-4 text-xs font-medium">
            <span>Harga Dasar: <strong>{formatIDR(selectedPlan.base_rate)}</strong> / malam</span>
            <span>Meal Plan: <strong>{selectedPlan.meal_plan}</strong></span>
            <span>{selectedPlan.refundable ? 'Refundable' : 'Non-Refundable'}</span>
          </div>
        </div>
      )}

      {/* Calendar Matrix Grid */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-xs p-4">
        {loadingMatrix ? (
          <div className="p-12 text-center text-gray-500 text-sm">Memuat Rate Calendar harian...</div>
        ) : matrixError ? (
          <div className="p-8 text-center space-y-3">
            <div className="text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-4 max-w-md mx-auto">
              <p className="font-semibold text-sm">Data Rate Calendar belum dapat dimuat.</p>
              <p className="text-xs text-amber-700 mt-1">Silakan periksa koneksi atau coba muat ulang data.</p>
              <button
                type="button"
                onClick={() => void loadMatrix()}
                className="mt-3 px-4 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg shadow-xs transition-colors cursor-pointer"
              >
                Coba Muat Ulang
              </button>
            </div>
          </div>
        ) : ratePlans.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <svg className="w-12 h-12 text-gray-300 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <div className="text-sm font-semibold text-gray-700">Belum ada Rate Plan aktif.</div>
            <div className="text-xs text-gray-500">Tambahkan Rate Plan terlebih dahulu untuk mulai mengatur harga kalender harian.</div>
            {onOpenRatePlans && (
              <button
                type="button"
                onClick={onOpenRatePlans}
                className="mt-2 inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg shadow-xs transition-colors cursor-pointer"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                </svg>
                Buat Rate Plan
              </button>
            )}
          </div>
        ) : !matrix || matrix.days.length === 0 ? (
          <div className="p-12 text-center text-gray-500 text-sm">Pilih Rate Plan untuk menampilkan matriks tarif kalender.</div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2.5">
              {matrix.days.map((day) => {
                const isWeekend = day.day_of_week === 5 || day.day_of_week === 6; // Friday / Saturday nights
                const isSunday = day.day_of_week === 0;
                return (
                  <div
                    key={day.date}
                    className={`rounded-xl border p-3 flex flex-col justify-between transition-all relative ${
                      day.is_overridden
                        ? 'bg-amber-50/80 border-amber-300 ring-1 ring-amber-400/50 shadow-xs'
                        : isWeekend || isSunday
                        ? 'bg-emerald-50/40 border-emerald-200'
                        : 'bg-gray-50/60 border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    {/* Day Header */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1">
                        <span
                          className={`text-xs font-bold uppercase ${
                            isWeekend || isSunday ? 'text-emerald-800' : 'text-gray-600'
                          }`}
                        >
                          {day.day_name}
                        </span>
                        <span className="text-xs text-gray-500 font-mono">
                          {day.date.substring(5)}
                        </span>
                      </div>
                      {day.is_overridden && (
                        <span className="inline-flex items-center px-1.5 py-0.2 rounded text-[10px] font-bold bg-amber-200 text-amber-900 border border-amber-300">
                          OVERRIDE
                        </span>
                      )}
                    </div>

                    {/* Price Display */}
                    <div className="my-3">
                      <div className="text-base font-extrabold text-gray-900 tracking-tight">
                        {formatIDR(day.effective_rate)}
                      </div>
                      {day.is_overridden && (
                        <div className="text-[11px] text-gray-400 line-through">
                          {formatIDR(day.base_rate)}
                        </div>
                      )}
                      {day.reason && (
                        <div className="text-[11px] text-amber-800 font-medium truncate mt-0.5" title={day.reason}>
                          {day.reason}
                        </div>
                      )}
                    </div>

                    {/* Card Actions */}
                    <div className="pt-2 border-t border-gray-200/70 flex items-center justify-between text-[11px]">
                      <button
                        type="button"
                        onClick={() => handleOpenOverride(day)}
                        className="text-emerald-700 hover:text-emerald-900 font-semibold hover:underline"
                      >
                        {day.is_overridden ? 'Ubah' : 'Override'}
                      </button>

                      {day.is_overridden && (
                        <button
                          type="button"
                          onClick={() => handleResetDay(day)}
                          className="text-gray-500 hover:text-red-600 font-medium hover:underline"
                          title="Kembalikan ke harga dasar"
                        >
                          Reset
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Legend */}
            <div className="pt-3 border-t border-gray-100 flex flex-wrap items-center gap-5 text-xs text-gray-600">
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded bg-gray-50 border border-gray-300" />
                <span>Harga Dasar Reguler</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded bg-emerald-50 border border-emerald-300" />
                <span>Akhir Pekan (Jumat / Sabtu / Minggu)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded bg-amber-100 border border-amber-400" />
                <span>Tarif Override Khusus (Promo / Musim Padat)</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ==================================================================== */}
      {/* MODAL: SET RATE OVERRIDE */}
      {/* ==================================================================== */}
      {showOverrideModal && selectedPlan && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="bg-emerald-900 text-white px-6 py-4 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-base">Set Override Tarif Kalender</h3>
                <p className="text-xs text-emerald-200 mt-0.5">
                  Rate Plan: <strong>{selectedPlan.code}</strong> (Harga Dasar: {formatIDR(selectedPlan.base_rate)})
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowOverrideModal(false)}
                className="text-white/80 hover:text-white text-xl leading-none"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleSubmitOverride} className="p-6 space-y-4">
              {overrideModalError && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-xs p-3 rounded-lg">
                  {overrideModalError}
                </div>
              )}

              {/* Date Range [start_date, end_date) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    Tanggal Mulai Menginap <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={overrideForm.start_date}
                    onChange={(e) => setOverrideForm({ ...overrideForm, start_date: e.target.value })}
                    className="w-full text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-emerald-500 focus:outline-hidden font-medium"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    Tanggal Selesai (Checkout) <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    min={overrideForm.start_date}
                    value={overrideForm.end_date}
                    onChange={(e) => setOverrideForm({ ...overrideForm, end_date: e.target.value })}
                    className="w-full text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-emerald-500 focus:outline-hidden font-medium"
                  />
                </div>
              </div>

              {/* Override Price */}
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  Tarif Override (IDR / Malam) <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  min="0"
                  step="1000"
                  required
                  value={overrideForm.override_rate}
                  onChange={(e) => setOverrideForm({ ...overrideForm, override_rate: Number(e.target.value) })}
                  className="w-full text-base font-bold bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-emerald-500 focus:outline-hidden text-gray-900"
                />
                <span className="text-xs text-gray-500 mt-1 block">{formatIDR(overrideForm.override_rate)} / malam</span>
              </div>

              {/* Days of week selector */}
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                  Berlaku Pada Hari (Opsional)
                </label>
                <div className="grid grid-cols-7 gap-1">
                  {DAY_NAMES.map((dayLabel, dIdx) => {
                    const isSelected = overrideForm.specificDays.includes(dIdx);
                    return (
                      <button
                        key={dIdx}
                        type="button"
                        onClick={() => handleToggleDay(dIdx)}
                        className={`py-1.5 text-xs font-bold rounded-lg border transition-colors ${
                          isSelected
                            ? 'bg-emerald-700 text-white border-emerald-700'
                            : 'bg-gray-100 text-gray-600 border-gray-300 hover:bg-gray-200'
                        }`}
                      >
                        {dayLabel}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between text-[11px] text-gray-500 mt-1">
                  <span>Klik hari untuk mengaktifkan / menonaktifkan hari tertentu</span>
                  <button
                    type="button"
                    onClick={() => setOverrideForm({ ...overrideForm, specificDays: [0, 1, 2, 3, 4, 5, 6] })}
                    className="text-emerald-700 font-semibold hover:underline"
                  >
                    Pilih Semua Hari
                  </button>
                </div>
              </div>

              {/* Reason / Notes */}
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  Keterangan / Alasan Override
                </label>
                <input
                  type="text"
                  placeholder="Contoh: Weekend Surcharge, Libur Idul Fitri, Flash Sale"
                  value={overrideForm.reason || ''}
                  onChange={(e) => setOverrideForm({ ...overrideForm, reason: e.target.value })}
                  className="w-full text-xs bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                />
              </div>

              {/* Collision Replace Checkbox */}
              {collisionWarning && (
                <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-xs text-amber-900">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={overrideForm.replace_existing}
                      onChange={(e) => setOverrideForm({ ...overrideForm, replace_existing: e.target.checked })}
                      className="rounded text-amber-600 focus:ring-amber-500 w-4 h-4 mt-0.5"
                    />
                    <span>
                      <strong>Ganti jadwal override yang bertabrakan:</strong> Timpa override lama yang tumpang tindih dengan periode ini.
                    </span>
                  </label>
                </div>
              )}

              {/* Modal Actions */}
              <div className="flex items-center justify-end gap-3 pt-3 border-t border-gray-200">
                <button
                  type="button"
                  onClick={() => setShowOverrideModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={submittingOverride}
                  className="px-5 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg shadow-xs transition-colors disabled:opacity-50"
                >
                  {submittingOverride ? 'Menyimpan...' : 'Simpan Override'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
