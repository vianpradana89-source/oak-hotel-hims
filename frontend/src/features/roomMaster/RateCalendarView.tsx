import { useState, useEffect, useCallback, useMemo } from 'react';
import { pricingApi } from './pricingApi';
import type {
  RatePlan,
  RateCalendarMatrix,
  RateCalendarDay,
  BulkRateOverridePreviewResult
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

const MONTH_NAMES = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
];

const DOW_LABELS = [
  { dow: 1, name: 'Senin', short: 'Sen' },
  { dow: 2, name: 'Selasa', short: 'Sel' },
  { dow: 3, name: 'Rabu', short: 'Rab' },
  { dow: 4, name: 'Kamis', short: 'Kam' },
  { dow: 5, name: 'Jumat', short: 'Jum' },
  { dow: 6, name: 'Sabtu', short: 'Sab' },
  { dow: 7, name: 'Minggu', short: 'Min' }
];

export default function RateCalendarView({
  propertyId,
  roomTypes = [],
  initialRatePlanId,
  onChanged,
  onOpenRatePlans
}: Props) {
  const [ratePlans, setRatePlans] = useState<RatePlan[]>([]);
  const [selectedRoomTypeId, setSelectedRoomTypeId] = useState<number | 'ALL'>('ALL');
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(initialRatePlanId || null);
  const [loadingPlans, setLoadingPlans] = useState(true);

  // Month navigation (Defaults to current month)
  const today = useMemo(() => new Date(), []);
  const [currentYear, setCurrentYear] = useState<number>(() => today.getFullYear());
  const [currentMonth, setCurrentMonth] = useState<number>(() => today.getMonth()); // 0-indexed

  // Matrix State
  const [matrix, setMatrix] = useState<RateCalendarMatrix | null>(null);
  const [loadingMatrix, setLoadingMatrix] = useState(false);
  const [matrixError, setMatrixError] = useState<string | null>(null);

  // Single Date Override Modal
  const [selectedDay, setSelectedDay] = useState<RateCalendarDay | null>(null);
  const [singleRateInput, setSingleRateInput] = useState<number>(0);
  const [singleReasonInput, setSingleReasonInput] = useState<string>('');
  const [submittingSingle, setSubmittingSingle] = useState(false);
  const [singleError, setSingleError] = useState<string | null>(null);

  // Bulk Update Modal State (Step 1 = Form, Step 2 = Preview)
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkStep, setBulkStep] = useState<1 | 2>(1);
  const [bulkStartDate, setBulkStartDate] = useState<string>(() => toLocalDateString(new Date()));
  const [bulkEndDate, setBulkEndDate] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return toLocalDateString(d);
  });
  const [bulkSelectedDows, setBulkSelectedDows] = useState<number[]>([1, 2, 3, 4, 5, 6, 7]);
  const [bulkSelectedPlanIds, setBulkSelectedPlanIds] = useState<number[]>([]);
  const [bulkOverrideRate, setBulkOverrideRate] = useState<number>(0);
  const [bulkReason, setBulkReason] = useState<string>('');
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewResult, setPreviewResult] = useState<BulkRateOverridePreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applyingBulk, setApplyingBulk] = useState(false);

  // Load Rate Plans
  const loadRatePlans = useCallback(async () => {
    if (!propertyId) return;
    setLoadingPlans(true);
    try {
      const data = await pricingApi.listRatePlans(propertyId);
      const activeOnly = data.filter((p) => p.is_active);
      setRatePlans(activeOnly);

      if (activeOnly.length > 0) {
        if (!selectedPlanId || !activeOnly.some((p) => p.id === selectedPlanId)) {
          setSelectedPlanId(activeOnly[0].id);
        }
      } else {
        setSelectedPlanId(null);
      }
    } catch (err: any) {
      console.error('Failed to load rate plans:', err);
    } finally {
      setLoadingPlans(false);
    }
  }, [propertyId, selectedPlanId]);

  useEffect(() => {
    void loadRatePlans();
  }, [loadRatePlans]);

  // Filtered Rate Plans by selectedRoomTypeId
  const filteredRatePlans = useMemo(() => {
    if (selectedRoomTypeId === 'ALL') return ratePlans;
    return ratePlans.filter((p) => p.room_type_id === selectedRoomTypeId);
  }, [ratePlans, selectedRoomTypeId]);

  // Keep selectedPlanId valid when room type changes
  useEffect(() => {
    if (filteredRatePlans.length > 0) {
      if (!selectedPlanId || !filteredRatePlans.some((p) => p.id === selectedPlanId)) {
        setSelectedPlanId(filteredRatePlans[0].id);
      }
    }
  }, [filteredRatePlans, selectedPlanId]);

  // Calculate start_date and end_date for the entire current month
  const monthDateRange = useMemo(() => {
    const start = new Date(currentYear, currentMonth, 1);
    const end = new Date(currentYear, currentMonth + 1, 1); // 1st of next month
    return {
      startDate: toLocalDateString(start),
      endDate: toLocalDateString(end)
    };
  }, [currentYear, currentMonth]);

  // Load Rate Calendar Matrix for current month
  const loadMatrix = useCallback(async () => {
    if (!propertyId || !selectedPlanId) {
      setMatrix(null);
      return;
    }
    setLoadingMatrix(true);
    setMatrixError(null);
    try {
      const data = await pricingApi.getRateCalendar(
        propertyId,
        selectedPlanId,
        monthDateRange.startDate,
        monthDateRange.endDate
      );
      setMatrix(data);
    } catch (err: any) {
      console.error('Failed to load rate calendar matrix:', err);
      setMatrixError(err.message || 'Gagal memuat kalender tarif.');
    } finally {
      setLoadingMatrix(false);
    }
  }, [propertyId, selectedPlanId, monthDateRange.startDate, monthDateRange.endDate]);

  useEffect(() => {
    void loadMatrix();
  }, [loadMatrix]);

  // Navigation handlers
  function handlePrevMonth() {
    if (currentMonth === 0) {
      setCurrentMonth(11);
      setCurrentYear((y) => y - 1);
    } else {
      setCurrentMonth((m) => m - 1);
    }
  }

  function handleNextMonth() {
    if (currentMonth === 11) {
      setCurrentMonth(0);
      setCurrentYear((y) => y + 1);
    } else {
      setCurrentMonth((m) => m + 1);
    }
  }

  function handleToday() {
    const now = new Date();
    setCurrentYear(now.getFullYear());
    setCurrentMonth(now.getMonth());
  }

  // Single Date Override Modal Handlers
  function handleCellClick(day: RateCalendarDay) {
    setSelectedDay(day);
    setSingleRateInput(day.effective_rate);
    setSingleReasonInput(day.reason || '');
    setSingleError(null);
  }

  async function handleSaveSingleOverride() {
    if (!propertyId || !selectedPlanId || !selectedDay) return;
    if (singleRateInput <= 0) {
      setSingleError('Harga override harus lebih besar dari 0.');
      return;
    }

    setSubmittingSingle(true);
    setSingleError(null);
    try {
      // End date is day + 1 day
      const start = new Date(selectedDay.date);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);

      await pricingApi.upsertRateOverride(propertyId, selectedPlanId, {
        start_date: selectedDay.date,
        end_date: toLocalDateString(end),
        override_rate: singleRateInput,
        days_of_week: null,
        reason: singleReasonInput.trim() || undefined,
        replace_existing: true
      });

      onChanged(`Tarif override untuk ${selectedDay.date} berhasil disimpan.`);
      setSelectedDay(null);
      void loadMatrix();
    } catch (err: any) {
      setSingleError(err.message || 'Gagal menyimpan override tarif.');
    } finally {
      setSubmittingSingle(false);
    }
  }

  async function handleResetSingleOverride() {
    if (!propertyId || !selectedDay || !selectedDay.override_id) return;
    setSubmittingSingle(true);
    setSingleError(null);
    try {
      await pricingApi.deleteRateOverride(propertyId, selectedDay.override_id, selectedDay.date);
      onChanged(`Tarif untuk tanggal ${selectedDay.date} telah dikembalikan ke tarif dasar.`);
      setSelectedDay(null);
      void loadMatrix();
    } catch (err: any) {
      setSingleError(err.message || 'Gagal mereset override.');
    } finally {
      setSubmittingSingle(false);
    }
  }

  // Bulk Modal Actions
  function handleOpenBulkModal() {
    setShowBulkModal(true);
    setBulkStep(1);
    setPreviewResult(null);
    setPreviewError(null);
    setBulkStartDate(toLocalDateString(new Date()));
    const end = new Date();
    end.setDate(end.getDate() + 7);
    setBulkEndDate(toLocalDateString(end));
    setBulkSelectedDows([1, 2, 3, 4, 5, 6, 7]);
    setBulkSelectedPlanIds(selectedPlanId ? [selectedPlanId] : ratePlans.slice(0, 1).map((p) => p.id));
    setBulkOverrideRate(matrix?.rate_plan.base_rate || 500000);
    setBulkReason('');
  }

  function handleToggleDow(dow: number) {
    if (bulkSelectedDows.includes(dow)) {
      if (bulkSelectedDows.length === 1) return; // Must keep at least 1
      setBulkSelectedDows(bulkSelectedDows.filter((d) => d !== dow));
    } else {
      setBulkSelectedDows([...bulkSelectedDows, dow].sort((a, b) => a - b));
    }
  }

  function handleTogglePlan(planId: number) {
    if (bulkSelectedPlanIds.includes(planId)) {
      if (bulkSelectedPlanIds.length === 1) return;
      setBulkSelectedPlanIds(bulkSelectedPlanIds.filter((id) => id !== planId));
    } else {
      setBulkSelectedPlanIds([...bulkSelectedPlanIds, planId]);
    }
  }

  async function handleFetchPreview() {
    if (!propertyId) return;
    if (bulkSelectedPlanIds.length === 0) {
      setPreviewError('Pilih setidaknya satu Paket Tarif.');
      return;
    }
    if (bulkStartDate >= bulkEndDate) {
      setPreviewError('Tanggal mulai harus sebelum tanggal selesai.');
      return;
    }
    if (bulkOverrideRate <= 0) {
      setPreviewError('Harga override harus lebih besar dari 0.');
      return;
    }

    setLoadingPreview(true);
    setPreviewError(null);
    try {
      const res = await pricingApi.previewBulkRateOverrides(propertyId, {
        rate_plan_ids: bulkSelectedPlanIds,
        start_date: bulkStartDate,
        end_date: bulkEndDate,
        days_of_week: bulkSelectedDows.length === 7 ? null : bulkSelectedDows,
        override_rate: bulkOverrideRate,
        reason: bulkReason.trim() || undefined
      });
      setPreviewResult(res);
      setBulkStep(2);
    } catch (err: any) {
      setPreviewError(err.message || 'Gagal memuat pratinjau bulk update.');
    } finally {
      setLoadingPreview(false);
    }
  }

  async function handleApplyBulk() {
    if (!propertyId || !previewResult) return;

    setApplyingBulk(true);
    setPreviewError(null);
    try {
      await pricingApi.applyBulkRateOverrides(propertyId, {
        rate_plan_ids: bulkSelectedPlanIds,
        start_date: bulkStartDate,
        end_date: bulkEndDate,
        days_of_week: bulkSelectedDows.length === 7 ? null : bulkSelectedDows,
        override_rate: bulkOverrideRate,
        reason: bulkReason.trim() || undefined,
        preview_token: previewResult.preview_token
      });

      onChanged('Perubahan kalender tarif berhasil diterapkan secara massal.');
      setShowBulkModal(false);
      void loadMatrix();
    } catch (err: any) {
      if (err.code === 'RATE_CALENDAR_CHANGED' || err.status === 409) {
        setPreviewError(
          'Rate Calendar berubah sejak pratinjau dibuat. Silakan perbarui pratinjau sebelum menerapkan perubahan.'
        );
      } else {
        setPreviewError(err.message || 'Gagal menerapkan perubahan kalender tarif.');
      }
    } finally {
      setApplyingBulk(false);
    }
  }

  // Monthly Calendar Grid Helper
  const calendarGrid = useMemo(() => {
    if (!matrix || !matrix.days) return [];

    // First day of current month
    const firstOfMonth = new Date(currentYear, currentMonth, 1);
    // getDay(): 0=Sun, 1=Mon, ..., 6=Sat
    // Convert to ISO dow (1=Mon, ..., 7=Sun)
    let firstDowIso = firstOfMonth.getDay();
    if (firstDowIso === 0) firstDowIso = 7;

    // Leading padding cells
    const paddingCells: Array<{ isPadding: true; key: string }> = [];
    for (let i = 1; i < firstDowIso; i++) {
      paddingCells.push({ isPadding: true, key: `pad-lead-${i}` });
    }

    // Days map
    const dayCells = matrix.days.map((day) => ({
      isPadding: false,
      key: day.date,
      data: day
    }));

    // Trailing padding cells (7 modulo)
    const totalCells = paddingCells.length + dayCells.length;
    const trailingPadding = (7 - (totalCells % 7)) % 7;
    const trailingCells: Array<{ isPadding: true; key: string }> = [];
    for (let i = 0; i < trailingPadding; i++) {
      trailingCells.push({ isPadding: true, key: `pad-trail-${i}` });
    }

    return [...paddingCells, ...dayCells, ...trailingCells];
  }, [matrix, currentYear, currentMonth]);

  const activePlan = useMemo(() => {
    return ratePlans.find((p) => p.id === selectedPlanId);
  }, [ratePlans, selectedPlanId]);

  return (
    <div className="space-y-6">
      {/* HEADER CONTROLS */}
      <div className="bg-white rounded-xl shadow-sm border border-stone-200 p-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          {/* Filters: Room Type & Rate Plan */}
          <div className="flex flex-wrap items-center gap-3">
            {roomTypes.length > 0 && (
              <div>
                <label className="block text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">
                  Tipe Kamar
                </label>
                <select
                  value={selectedRoomTypeId}
                  onChange={(e) => {
                    const val = e.target.value === 'ALL' ? 'ALL' : Number(e.target.value);
                    setSelectedRoomTypeId(val);
                    if (val !== 'ALL') {
                      const matchPlans = ratePlans.filter((p) => p.room_type_id === val);
                      if (matchPlans.length > 0 && (!selectedPlanId || !matchPlans.some((p) => p.id === selectedPlanId))) {
                        setSelectedPlanId(matchPlans[0].id);
                      }
                    }
                  }}
                  className="px-3 py-2 text-sm bg-stone-50 border border-stone-300 rounded-lg text-stone-800 font-medium focus:ring-2 focus:ring-emerald-600 focus:outline-none"
                >
                  <option value="ALL">Semua Tipe Kamar</option>
                  {roomTypes.map((rt) => (
                    <option key={rt.id} value={rt.id}>
                      {rt.name} ({rt.code})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">
                Paket Tarif / Rate Plan
              </label>
              <select
                value={selectedPlanId || ''}
                onChange={(e) => setSelectedPlanId(Number(e.target.value))}
                disabled={loadingPlans || filteredRatePlans.length === 0}
                className="px-3 py-2 text-sm bg-stone-50 border border-stone-300 rounded-lg text-stone-800 font-medium focus:ring-2 focus:ring-emerald-600 focus:outline-none min-w-[220px]"
              >
                {filteredRatePlans.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name} ({formatIDR(plan.base_rate)})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Month / Year Navigator & Bulk Update CTA */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center bg-stone-100 rounded-lg p-1 border border-stone-200">
              <button
                type="button"
                onClick={handlePrevMonth}
                title="Bulan Sebelumnya"
                className="p-1.5 text-stone-600 hover:text-stone-900 hover:bg-white rounded transition"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <div className="px-3 py-1 text-sm font-bold text-stone-800 min-w-[140px] text-center">
                {MONTH_NAMES[currentMonth]} {currentYear}
              </div>
              <button
                type="button"
                onClick={handleNextMonth}
                title="Bulan Berikutnya"
                className="p-1.5 text-stone-600 hover:text-stone-900 hover:bg-white rounded transition"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>

            <button
              type="button"
              onClick={handleToday}
              className="px-3 py-2 text-sm font-semibold text-stone-700 bg-stone-100 hover:bg-stone-200 rounded-lg border border-stone-300 transition"
            >
              Hari Ini
            </button>

            <button
              type="button"
              onClick={handleOpenBulkModal}
              className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-emerald-800 hover:bg-emerald-900 rounded-lg shadow-sm transition"
            >
              <svg className="w-4 h-4 text-amber-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
              </svg>
              Bulk Update Tarif
            </button>
          </div>
        </div>

        {/* Plan Info Subheader */}
        {activePlan && (
          <div className="mt-4 pt-3 border-t border-stone-100 flex flex-wrap items-center justify-between gap-2 text-xs text-stone-600">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-stone-800">{activePlan.name}</span>
              <span className="text-stone-400">•</span>
              <span>Tarif Rutin Dasar (BAR): <strong className="text-stone-900">{formatIDR(activePlan.base_rate)}</strong></span>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-600"></span>
                <span>Tarif Standar</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-500"></span>
                <span>Override / Pengecualian</span>
              </div>
              {onOpenRatePlans && (
                <button
                  type="button"
                  onClick={onOpenRatePlans}
                  className="text-emerald-800 hover:text-emerald-900 font-semibold underline"
                >
                  Kelola Paket Tarif
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* MONTHLY CALENDAR GRID */}
      <div className="bg-white rounded-xl shadow-sm border border-stone-200 overflow-hidden">
        {/* Day of Week Headers (Mon - Sun) */}
        <div className="grid grid-cols-7 bg-stone-50 border-b border-stone-200 text-center text-xs font-bold text-stone-600 uppercase py-3">
          {DOW_LABELS.map((d) => (
            <div key={d.dow} className={d.dow >= 6 ? 'text-amber-800' : ''}>
              <span className="hidden sm:inline">{d.name}</span>
              <span className="sm:hidden">{d.short}</span>
            </div>
          ))}
        </div>

        {/* Calendar Body */}
        {loadingMatrix ? (
          <div className="py-24 text-center text-stone-400">
            <svg className="w-8 h-8 animate-spin mx-auto mb-2 text-emerald-800" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <p className="text-sm font-medium">Memuat data kalender tarif...</p>
          </div>
        ) : matrixError ? (
          <div className="p-8 text-center text-rose-600">
            <svg className="w-8 h-8 mx-auto mb-2 text-rose-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <p className="text-sm font-medium">{matrixError}</p>
            <button
              type="button"
              onClick={() => void loadMatrix()}
              className="mt-3 px-4 py-1.5 text-xs font-semibold bg-stone-100 hover:bg-stone-200 text-stone-800 rounded-lg"
            >
              Coba Lagi
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-7 divide-x divide-y divide-stone-100 min-h-[480px]">
            {calendarGrid.map((cell) => {
              if (cell.isPadding || !cell.data) {
                return (
                  <div
                    key={cell.key}
                    className="bg-stone-50/50 min-h-[90px] sm:min-h-[110px] p-2 select-none"
                  />
                );
              }

              const day = cell.data;
              const dateObj = new Date(day.date);
              const dayNumber = dateObj.getDate();
              const isWeekend = day.day_of_week >= 6;
              const isTodayDate = day.date === toLocalDateString(new Date());

              return (
                <div
                  key={cell.key}
                  onClick={() => handleCellClick(day)}
                  className={`min-h-[90px] sm:min-h-[110px] p-2.5 transition cursor-pointer group relative flex flex-col justify-between ${
                    isWeekend ? 'bg-amber-50/20' : 'bg-white'
                  } hover:bg-emerald-50/60`}
                >
                  {/* Top Bar: Date Number & Badge */}
                  <div className="flex items-center justify-between">
                    <span
                      className={`text-xs sm:text-sm font-bold w-6 h-6 flex items-center justify-center rounded-full ${
                        isTodayDate
                          ? 'bg-emerald-800 text-white font-black'
                          : isWeekend
                          ? 'text-amber-800'
                          : 'text-stone-700'
                      }`}
                    >
                      {dayNumber}
                    </span>

                    {day.is_overridden && (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 border border-amber-300">
                        Override
                      </span>
                    )}
                  </div>

                  {/* Price Info */}
                  <div className="mt-2 text-right">
                    {day.is_overridden ? (
                      <div>
                        <div className="text-[11px] text-stone-400 line-through">
                          {formatIDR(day.base_rate)}
                        </div>
                        <div className="text-xs sm:text-sm font-black text-amber-700">
                          {formatIDR(day.effective_rate)}
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs sm:text-sm font-bold text-stone-800 group-hover:text-emerald-800">
                        {formatIDR(day.effective_rate)}
                      </div>
                    )}
                  </div>

                  {/* Reason tooltip / snippet */}
                  {day.reason && (
                    <div
                      className="text-[10px] text-stone-500 truncate mt-1 bg-stone-100 px-1 py-0.5 rounded"
                      title={day.reason}
                    >
                      {day.reason}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* MODAL: SINGLE DATE OVERRIDE */}
      {selectedDay && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-xl border border-stone-200 max-w-md w-full overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Header */}
            <div className="px-6 py-4 bg-stone-50 border-b border-stone-200 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-stone-900">Edit Tarif Harian</h3>
                <p className="text-xs text-stone-500">
                  {selectedDay.day_name}, {selectedDay.date}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedDay(null)}
                className="p-1.5 text-stone-400 hover:text-stone-700 rounded-lg"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Content */}
            <div className="p-6 space-y-4">
              {singleError && (
                <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 text-xs rounded-lg flex items-start gap-2">
                  <svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <span>{singleError}</span>
                </div>
              )}

              <div className="bg-stone-50 rounded-xl p-3 border border-stone-200 space-y-1.5 text-xs text-stone-600">
                <div className="flex justify-between">
                  <span>Paket Tarif:</span>
                  <strong className="text-stone-900">{matrix?.rate_plan.name}</strong>
                </div>
                <div className="flex justify-between">
                  <span>Tarif Rutin Dasar (BAR):</span>
                  <strong className="text-stone-900">{formatIDR(selectedDay.base_rate)}</strong>
                </div>
                <div className="flex justify-between">
                  <span>Tarif Berlaku Saat Ini:</span>
                  <strong className={selectedDay.is_overridden ? 'text-amber-700 font-bold' : 'text-emerald-800 font-bold'}>
                    {formatIDR(selectedDay.effective_rate)}
                  </strong>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider mb-1.5">
                  Tarif Baru (Rp)
                </label>
                <input
                  type="number"
                  min="0"
                  step="10000"
                  value={singleRateInput || ''}
                  onChange={(e) => setSingleRateInput(Math.max(0, parseInt(e.target.value, 10) || 0))}
                  placeholder="Contoh: 650000"
                  className="w-full px-3 py-2 text-base font-bold text-stone-900 bg-white border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider mb-1.5">
                  Alasan / Catatan Override
                </label>
                <input
                  type="text"
                  value={singleReasonInput}
                  onChange={(e) => setSingleReasonInput(e.target.value)}
                  placeholder="Contoh: High Season, Libur Nasional"
                  className="w-full px-3 py-2 text-sm text-stone-800 bg-white border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:outline-none"
                />
              </div>
            </div>

            {/* Actions */}
            <div className="px-6 py-4 bg-stone-50 border-t border-stone-200 flex items-center justify-between gap-3">
              {selectedDay.is_overridden ? (
                <button
                  type="button"
                  onClick={() => void handleResetSingleOverride()}
                  disabled={submittingSingle}
                  className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-rose-700 hover:text-rose-800 hover:bg-rose-50 border border-rose-300 rounded-lg transition"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Reset ke Tarif Dasar
                </button>
              ) : (
                <div></div>
              )}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedDay(null)}
                  className="px-3 py-2 text-xs font-semibold text-stone-600 hover:bg-stone-200 rounded-lg transition"
                >
                  Batal
                </button>
                <button
                  type="button"
                  onClick={() => void handleSaveSingleOverride()}
                  disabled={submittingSingle}
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-emerald-800 hover:bg-emerald-900 rounded-lg shadow-sm transition"
                >
                  {submittingSingle ? 'Menyimpan...' : 'Simpan Override'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: BULK UPDATE (2 STEPS: INPUT -> PREVIEW -> APPLY) */}
      {showBulkModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-xl border border-stone-200 max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="px-6 py-4 bg-stone-50 border-b border-stone-200 flex items-center justify-between flex-shrink-0">
              <div>
                <h3 className="text-base font-bold text-stone-900 flex items-center gap-2">
                  <svg className="w-5 h-5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                  </svg>
                  Bulk Update Tarif Kalender
                </h3>
                <p className="text-xs text-stone-500">
                  {bulkStep === 1
                    ? 'Langkah 1 dari 2: Tentukan rentang tanggal, hari, dan tarif baru'
                    : 'Langkah 2 dari 2: Pratinjau dampak perubahan sebelum diterapkan'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowBulkModal(false)}
                className="p-1.5 text-stone-400 hover:text-stone-700 rounded-lg"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Modal Scrollable Body */}
            <div className="p-6 overflow-y-auto space-y-5 flex-1">
              {previewError && (
                <div className="p-3.5 bg-rose-50 border border-rose-200 text-rose-800 text-xs rounded-xl flex items-start gap-2.5">
                  <svg className="w-4 h-4 flex-shrink-0 mt-0.5 text-rose-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <span className="leading-relaxed">{previewError}</span>
                </div>
              )}

              {bulkStep === 1 ? (
                /* STEP 1: FORM INPUTS */
                <div className="space-y-4">
                  {/* Date Range */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider mb-1">
                        Tanggal Mulai Menginap
                      </label>
                      <input
                        type="date"
                        value={bulkStartDate}
                        onChange={(e) => setBulkStartDate(e.target.value)}
                        className="w-full px-3 py-2 text-sm bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider mb-1">
                        Tanggal Selesai (Checkout)
                      </label>
                      <input
                        type="date"
                        value={bulkEndDate}
                        onChange={(e) => setBulkEndDate(e.target.value)}
                        className="w-full px-3 py-2 text-sm bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:outline-none"
                      />
                    </div>
                  </div>

                  {/* Day of Week Selector */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider">
                        Hari Berlaku
                      </label>
                      <div className="flex gap-2 text-[11px] font-semibold text-emerald-800">
                        <button
                          type="button"
                          onClick={() => setBulkSelectedDows([1, 2, 3, 4, 5, 6, 7])}
                          className="hover:underline"
                        >
                          Semua Hari
                        </button>
                        <span>•</span>
                        <button
                          type="button"
                          onClick={() => setBulkSelectedDows([1, 2, 3, 4, 5])}
                          className="hover:underline"
                        >
                          Hari Kerja
                        </button>
                        <span>•</span>
                        <button
                          type="button"
                          onClick={() => setBulkSelectedDows([6, 7])}
                          className="hover:underline"
                        >
                          Akhir Pekan
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-7 gap-1.5">
                      {DOW_LABELS.map((d) => {
                        const isSelected = bulkSelectedDows.includes(d.dow);
                        return (
                          <button
                            key={d.dow}
                            type="button"
                            onClick={() => handleToggleDow(d.dow)}
                            className={`py-2 text-xs font-bold rounded-lg border transition text-center ${
                              isSelected
                                ? 'bg-emerald-800 text-white border-emerald-900 shadow-sm'
                                : 'bg-stone-50 text-stone-600 border-stone-200 hover:bg-stone-100'
                            }`}
                          >
                            {d.short}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Rate Plans Multi-Selection */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider">
                        Pilih Paket Tarif
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          if (bulkSelectedPlanIds.length === ratePlans.length) {
                            setBulkSelectedPlanIds(ratePlans.slice(0, 1).map((p) => p.id));
                          } else {
                            setBulkSelectedPlanIds(ratePlans.map((p) => p.id));
                          }
                        }}
                        className="text-[11px] font-semibold text-emerald-800 hover:underline"
                      >
                        {bulkSelectedPlanIds.length === ratePlans.length ? 'Pilih Satu' : 'Pilih Semua Paket'}
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-36 overflow-y-auto p-1 bg-stone-50 rounded-xl border border-stone-200">
                      {ratePlans.map((plan) => {
                        const isSelected = bulkSelectedPlanIds.includes(plan.id);
                        return (
                          <div
                            key={plan.id}
                            onClick={() => handleTogglePlan(plan.id)}
                            className={`flex items-center gap-2 p-2 rounded-lg border text-xs cursor-pointer transition select-none ${
                              isSelected
                                ? 'bg-emerald-50/80 border-emerald-300 text-stone-900 font-semibold'
                                : 'bg-white border-stone-200 text-stone-600 hover:bg-stone-100'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => {}}
                              className="rounded text-emerald-800 focus:ring-emerald-600 w-4 h-4"
                            />
                            <div className="truncate flex-1">
                              <div>{plan.name}</div>
                              <div className="text-[10px] text-stone-400">{formatIDR(plan.base_rate)}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Override Rate & Reason */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                    <div>
                      <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider mb-1">
                        Tarif Baru (Rp)
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="10000"
                        value={bulkOverrideRate || ''}
                        onChange={(e) => setBulkOverrideRate(Math.max(0, parseInt(e.target.value, 10) || 0))}
                        placeholder="Contoh: 650000"
                        className="w-full px-3 py-2 text-base font-black text-stone-900 bg-white border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider mb-1">
                        Alasan / Catatan Override
                      </label>
                      <input
                        type="text"
                        value={bulkReason}
                        onChange={(e) => setBulkReason(e.target.value)}
                        placeholder="Contoh: Lebaran Peak Period"
                        className="w-full px-3 py-2 text-sm text-stone-800 bg-white border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:outline-none"
                      />
                    </div>
                  </div>
                </div>
              ) : (
                /* STEP 2: PREVIEW TABLE & SUMMARY */
                <div className="space-y-4">
                  {previewResult && (
                    <>
                      {/* Summary Cards */}
                      <div className="grid grid-cols-3 gap-3">
                        <div className="p-3 bg-stone-50 border border-stone-200 rounded-xl text-center">
                          <div className="text-xl font-black text-stone-900">
                            {previewResult.affected_dates_count}
                          </div>
                          <div className="text-[11px] font-semibold text-stone-500 uppercase tracking-wider">
                            Total Perubahan
                          </div>
                        </div>
                        <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-center">
                          <div className="text-xl font-black text-amber-800">
                            {previewResult.replacements_count}
                          </div>
                          <div className="text-[11px] font-semibold text-amber-700 uppercase tracking-wider">
                            Ganti Override Lama
                          </div>
                        </div>
                        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-center">
                          <div className="text-xl font-black text-emerald-800">
                            {previewResult.affected_dates_count - previewResult.replacements_count}
                          </div>
                          <div className="text-[11px] font-semibold text-emerald-700 uppercase tracking-wider">
                            Override Baru
                          </div>
                        </div>
                      </div>

                      {/* Detailed Preview Table */}
                      <div className="border border-stone-200 rounded-xl overflow-hidden max-h-64 overflow-y-auto">
                        <table className="w-full text-left text-xs border-collapse">
                          <thead className="bg-stone-100 text-stone-700 font-bold sticky top-0 border-b border-stone-200">
                            <tr>
                              <th className="p-2.5">Tanggal</th>
                              <th className="p-2.5">Paket Tarif</th>
                              <th className="p-2.5 text-right">Tarif Saat Ini</th>
                              <th className="p-2.5 text-right">Tarif Baru</th>
                              <th className="p-2.5 text-center">Status</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-stone-100">
                            {previewResult.breakdown.map((item, idx) => (
                              <tr
                                key={idx}
                                className={
                                  item.status === 'REPLACE'
                                    ? 'bg-amber-50/40'
                                    : item.status === 'NEW'
                                    ? 'bg-emerald-50/30'
                                    : 'bg-white'
                                }
                              >
                                <td className="p-2.5 whitespace-nowrap font-medium text-stone-800">
                                  {item.stay_date} <span className="text-stone-400">({item.day_name})</span>
                                </td>
                                <td className="p-2.5 font-medium text-stone-700 truncate max-w-[140px]">
                                  {item.rate_plan_name}
                                </td>
                                <td className="p-2.5 text-right text-stone-500 line-through">
                                  {formatIDR(item.current_effective_rate)}
                                </td>
                                <td className="p-2.5 text-right font-bold text-stone-900">
                                  {formatIDR(item.proposed_rate)}
                                </td>
                                <td className="p-2.5 text-center">
                                  {item.status === 'REPLACE' ? (
                                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800">
                                      GANTI
                                    </span>
                                  ) : item.status === 'NEW' ? (
                                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">
                                      BARU
                                    </span>
                                  ) : (
                                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-stone-100 text-stone-500">
                                      TIDAK BERUBAH
                                    </span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Modal Footer Actions */}
            <div className="px-6 py-4 bg-stone-50 border-t border-stone-200 flex items-center justify-between flex-shrink-0">
              {bulkStep === 2 ? (
                <button
                  type="button"
                  onClick={() => setBulkStep(1)}
                  disabled={applyingBulk}
                  className="px-4 py-2 text-xs font-semibold text-stone-700 hover:bg-stone-200 rounded-lg transition"
                >
                  Kembali ke Formulir
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowBulkModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-stone-600 hover:bg-stone-200 rounded-lg transition"
                >
                  Batal
                </button>
              )}

              {bulkStep === 1 ? (
                <button
                  type="button"
                  onClick={() => void handleFetchPreview()}
                  disabled={loadingPreview}
                  className="flex items-center gap-2 px-5 py-2.5 text-xs font-bold text-white bg-emerald-800 hover:bg-emerald-900 rounded-lg shadow-sm transition"
                >
                  {loadingPreview ? (
                    'Memuat Pratinjau...'
                  ) : (
                    <>
                      Pratinjau Perubahan
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                      </svg>
                    </>
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleApplyBulk()}
                  disabled={applyingBulk}
                  className="flex items-center gap-2 px-5 py-2.5 text-xs font-bold text-white bg-emerald-800 hover:bg-emerald-900 rounded-lg shadow-sm transition"
                >
                  {applyingBulk ? (
                    'Menerapkan Perubahan...'
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                      </svg>
                      Terapkan Perubahan Massal
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
