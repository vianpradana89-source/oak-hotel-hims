import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { pricingApi } from './pricingApi';
import type {
  RatePlan,
  CreateRatePlanDto,
  DuplicateRatePlanDto,
  PropertyPricingSettings,
  MealPlanMaster
} from './pricingApi';
import type { RoomType } from './roomMasterTypes';
import { MealPlanManagerModal } from './MealPlanManagerModal';

interface Props {
  propertyId: number | null;
  roomTypes: RoomType[];
  onChanged: (message: string) => void;
  onOpenCalendar?: (ratePlanId: number) => void;
}

const MEAL_PLAN_LABELS: Record<string, string> = {
  RO: 'Room Only (RO)',
  BB: 'Bed & Breakfast (BB)',
  HB: 'Half Board (HB)',
  FB: 'Full Board (FB)',
  AI: 'All Inclusive (AI)'
};

function formatIDR(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0
  }).format(amount);
}

type SortColumn = 'code_name' | 'room_type' | 'base_rate' | 'status';
type SortDirection = 'asc' | 'desc';

export default function RatePlansView({ propertyId, roomTypes, onChanged, onOpenCalendar }: Props) {
  const [ratePlans, setRatePlans] = useState<RatePlan[]>([]);
  const [mealPlans, setMealPlans] = useState<MealPlanMaster[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [selectedRoomTypeId, setSelectedRoomTypeId] = useState<number | 'ALL'>('ALL');
  const [showArchived, setShowArchived] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Table Sorting State (Part A)
  const [sortKey, setSortKey] = useState<SortColumn | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection | null>(null);

  // Modals
  const [modalMode, setModalMode] = useState<'create' | 'edit' | 'duplicate' | 'delete' | 'settings' | null>(null);
  const [showMealPlanModal, setShowMealPlanModal] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<RatePlan | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // Form State
  const [formData, setFormData] = useState<CreateRatePlanDto>({
    room_type_id: roomTypes[0]?.id || 0,
    code: '',
    name: '',
    description: '',
    base_rate: 500000,
    meal_plan: 'RO',
    meal_plan_id: null,
    refundable: true,
    cancellation_policy: '',
    payment_policy: '',
    min_stay: 1,
    max_stay: null,
    min_advance_days: 0,
    extra_bed_rate: 0,
    extra_person_rate: 0,
    is_active: true,
    rate_type: 'OVERNIGHT',
    duration_minutes: null,
    earliest_start_time: '08:00',
    latest_start_time: '18:00',
    turnaround_buffer_minutes: 60
  });
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Duplicate Form
  const [dupCode, setDupCode] = useState('');
  const [dupName, setDupName] = useState('');

  // Pricing Settings
  const [pricingSettings, setPricingSettings] = useState<PropertyPricingSettings | null>(null);
  const [taxPercent, setTaxPercent] = useState<number>(10);
  const [servicePercent, setServicePercent] = useState<number>(0);

  const loadRatePlans = useCallback(async () => {
    if (!propertyId) return;
    setLoading(true);
    setError(null);
    try {
      const [plans, settings, mPlans] = await Promise.all([
        pricingApi.listRatePlans(propertyId, {
          room_type_id: selectedRoomTypeId === 'ALL' ? undefined : selectedRoomTypeId,
          include_archived: showArchived
        }),
        pricingApi.getSettings(propertyId),
        pricingApi.listMealPlans(propertyId, { is_active: true, include_archived: false })
      ]);
      setRatePlans(plans);
      setPricingSettings(settings);
      setMealPlans(mPlans);
      setTaxPercent(settings.tax_percent);
      setServicePercent(settings.service_charge_percent);
    } catch (err: any) {
      console.error('RatePlansView load error:', err);
      setError('Data Rate Plan belum dapat dimuat. Coba muat ulang.');
    } finally {
      setLoading(false);
    }
  }, [propertyId, selectedRoomTypeId, showArchived]);

  useEffect(() => {
    void loadRatePlans();
  }, [loadRatePlans]);

  // Handle 3-state cycling sort (Part A)
  const handleSort = (column: SortColumn) => {
    if (sortKey !== column) {
      setSortKey(column);
      setSortDirection('asc');
    } else if (sortDirection === 'asc') {
      setSortDirection('desc');
    } else if (sortDirection === 'desc') {
      setSortKey(null);
      setSortDirection(null);
    }
  };

  // Open Create Modal
  function handleOpenCreate() {
    const defaultRtId = selectedRoomTypeId !== 'ALL' ? selectedRoomTypeId : (roomTypes[0]?.id || 0);
    const rt = roomTypes.find((r) => r.id === defaultRtId);
    const defaultMealPlan = mealPlans[0];
    setFormData({
      room_type_id: defaultRtId,
      code: '',
      name: '',
      description: '',
      base_rate: rt ? Number(rt.base_rate || 500000) : 500000,
      meal_plan: defaultMealPlan?.code || 'RO',
      meal_plan_id: defaultMealPlan?.id || null,
      refundable: true,
      cancellation_policy: '',
      payment_policy: '',
      min_stay: 1,
      max_stay: null,
      min_advance_days: 0,
      extra_bed_rate: 0,
      extra_person_rate: 0,
      is_active: true,
      rate_type: 'OVERNIGHT',
      duration_minutes: null,
      earliest_start_time: '08:00',
      latest_start_time: '18:00',
      turnaround_buffer_minutes: 60
    });
    setShowAdvanced(false);
    setModalError(null);
    setModalMode('create');
  }

  // Open Edit Modal
  function handleOpenEdit(plan: RatePlan) {
    setSelectedPlan(plan);
    setFormData({
      room_type_id: plan.room_type_id,
      code: plan.code,
      name: plan.name,
      description: plan.description || '',
      base_rate: plan.base_rate,
      meal_plan: plan.meal_plan_code || plan.meal_plan || 'RO',
      meal_plan_id: plan.meal_plan_id || null,
      refundable: plan.refundable,
      cancellation_policy: plan.cancellation_policy || '',
      payment_policy: plan.payment_policy || '',
      min_stay: plan.min_stay,
      max_stay: plan.max_stay,
      min_advance_days: plan.min_advance_days,
      extra_bed_rate: plan.extra_bed_rate,
      extra_person_rate: plan.extra_person_rate,
      is_active: plan.is_active,
      rate_type: plan.rate_type || 'OVERNIGHT',
      duration_minutes: plan.duration_minutes || null,
      earliest_start_time: plan.earliest_start_time || '08:00',
      latest_start_time: plan.latest_start_time || '18:00',
      turnaround_buffer_minutes: plan.turnaround_buffer_minutes || 60
    });
    setShowAdvanced(false);
    setModalError(null);
    setModalMode('edit');
  }

  // Open Duplicate Modal
  function handleOpenDuplicate(plan: RatePlan) {
    setSelectedPlan(plan);
    setDupCode(`${plan.code}-COPY`);
    setDupName(`${plan.name} (Salinan)`);
    setModalError(null);
    setModalMode('duplicate');
  }

  // Open Delete Modal
  function handleOpenDelete(plan: RatePlan) {
    setSelectedPlan(plan);
    setModalError(null);
    setModalMode('delete');
  }

  // Toggle Active State
  async function handleToggleStatus(plan: RatePlan) {
    if (!propertyId) return;
    try {
      const nextState = !plan.is_active;
      await pricingApi.setRatePlanActive(propertyId, plan.id, nextState);
      onChanged(`Rate Plan ${plan.code} berhasil ${nextState ? 'diaktifkan' : 'dinonaktifkan'}.`);
      void loadRatePlans();
    } catch (err: any) {
      alert(`Gagal mengubah status: ${err.message}`);
    }
  }

  // Submit Create / Edit
  async function handleSubmitPlan(e: React.FormEvent) {
    e.preventDefault();
    if (!propertyId) return;
    setSubmitting(true);
    setModalError(null);

    try {
      if (modalMode === 'create') {
        await pricingApi.createRatePlan(propertyId, formData);
        onChanged(`Rate Plan '${formData.code.toUpperCase()}' berhasil ditambahkan.`);
      } else if (modalMode === 'edit' && selectedPlan) {
        await pricingApi.updateRatePlan(propertyId, selectedPlan.id, formData);
        onChanged(`Rate Plan '${formData.code.toUpperCase()}' berhasil diperbarui.`);
      }
      setModalMode(null);
      void loadRatePlans();
    } catch (err: any) {
      setModalError(err.message || 'Gagal menyimpan Rate Plan.');
    } finally {
      setSubmitting(false);
    }
  }

  // Submit Duplicate
  async function handleSubmitDuplicate(e: React.FormEvent) {
    e.preventDefault();
    if (!propertyId || !selectedPlan) return;
    setSubmitting(true);
    setModalError(null);

    try {
      const dto: DuplicateRatePlanDto = {
        code: dupCode.trim().toUpperCase(),
        name: dupName.trim()
      };
      await pricingApi.duplicateRatePlan(propertyId, selectedPlan.id, dto);
      onChanged(`Rate Plan '${dto.code}' berhasil diduplikasi dari ${selectedPlan.code}.`);
      setModalMode(null);
      void loadRatePlans();
    } catch (err: any) {
      setModalError(err.message || 'Gagal menduplikasi Rate Plan.');
    } finally {
      setSubmitting(false);
    }
  }

  // Submit Safe Delete
  async function handleSubmitDelete() {
    if (!propertyId || !selectedPlan) return;
    setSubmitting(true);
    setModalError(null);

    try {
      const res = await pricingApi.deleteRatePlan(propertyId, selectedPlan.id);
      onChanged(res.message);
      setModalMode(null);
      void loadRatePlans();
    } catch (err: any) {
      setModalError(err.message || 'Gagal menghapus Rate Plan.');
    } finally {
      setSubmitting(false);
    }
  }

  // Submit Settings
  async function handleSubmitSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!propertyId) return;
    setSubmitting(true);
    setModalError(null);

    try {
      await pricingApi.updateSettings(propertyId, {
        tax_percent: Number(taxPercent),
        service_charge_percent: Number(servicePercent)
      });
      onChanged('Pengaturan Pajak & Servis berhasil diperbarui.');
      setModalMode(null);
      void loadRatePlans();
    } catch (err: any) {
      setModalError(err.message || 'Gagal menyimpan pengaturan.');
    } finally {
      setSubmitting(false);
    }
  }

  // Filter & Sort Rate Plans (Part A)
  const sortedAndFilteredPlans = useMemo(() => {
    let result = ratePlans.filter((p) => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchCode = p.code.toLowerCase().includes(q);
        const matchName = p.name.toLowerCase().includes(q);
        const matchType = (p.room_type_name || '').toLowerCase().includes(q);
        if (!matchCode && !matchName && !matchType) return false;
      }
      return true;
    });

    if (sortKey && sortDirection) {
      result = [...result].sort((a, b) => {
        let cmp = 0;
        if (sortKey === 'code_name') {
          const aStr = `${a.code} ${a.name}`.toLowerCase();
          const bStr = `${b.code} ${b.name}`.toLowerCase();
          cmp = aStr.localeCompare(bStr);
        } else if (sortKey === 'room_type') {
          const aStr = (a.room_type_name || '').toLowerCase();
          const bStr = (b.room_type_name || '').toLowerCase();
          cmp = aStr.localeCompare(bStr);
        } else if (sortKey === 'base_rate') {
          cmp = Number(a.base_rate) - Number(b.base_rate);
        } else if (sortKey === 'status') {
          // Aktif first in asc, Nonaktif first in desc
          const aVal = a.is_active ? 1 : 0;
          const bVal = b.is_active ? 1 : 0;
          cmp = bVal - aVal;
        }
        return sortDirection === 'asc' ? cmp : -cmp;
      });
    }

    return result;
  }, [ratePlans, searchQuery, sortKey, sortDirection]);

  const renderSortIndicator = (col: SortColumn) => {
    if (sortKey === col) {
      return (
        <span className="text-emerald-700 font-bold ml-1 inline-block transition-transform">
          {sortDirection === 'asc' ? '↑' : '↓'}
        </span>
      );
    }
    return <span className="text-gray-300 font-normal ml-1">⇅</span>;
  };

  return (
    <div className="space-y-4">
      {/* Top Filter & Action Bar */}
      <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-xs flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* Room Type Filter */}
          <div className="flex items-center gap-2">
            <label className="text-xs font-semibold text-gray-600 uppercase tracking-wider">Tipe Kamar:</label>
            <select
              value={selectedRoomTypeId}
              onChange={(e) => setSelectedRoomTypeId(e.target.value === 'ALL' ? 'ALL' : Number(e.target.value))}
              className="text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-hidden focus:ring-2 focus:ring-emerald-500 font-medium"
            >
              <option value="ALL">Semua Tipe Kamar</option>
              {roomTypes.map((rt) => (
                <option key={rt.id} value={rt.id}>
                  {rt.code} — {rt.name}
                </option>
              ))}
            </select>
          </div>

          {/* Search */}
          <div className="relative">
            <input
              type="text"
              placeholder="Cari kode atau nama..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="text-sm bg-gray-50 border border-gray-300 rounded-lg pl-8 pr-3 py-1.5 w-48 sm:w-64 focus:outline-hidden focus:ring-2 focus:ring-emerald-500"
            />
            <svg
              className="w-4 h-4 text-gray-400 absolute left-2.5 top-2.5 pointer-events-none"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>

          {/* Archived Toggle */}
          <label className="flex items-center gap-2 text-xs font-medium text-gray-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="rounded text-emerald-600 focus:ring-emerald-500 w-4 h-4"
            />
            Tampilkan Arsip
          </label>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowMealPlanModal(true)}
            className="px-3 py-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 rounded-lg transition-colors flex items-center gap-1.5 border border-emerald-300"
          >
            <span className="text-sm">🍽️</span>
            Kelola Meal Plan
          </button>

          <button
            type="button"
            onClick={() => setModalMode('settings')}
            className="px-3 py-1.5 text-xs font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors flex items-center gap-1.5 border border-gray-300"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Pajak &amp; Servis
          </button>

          <button
            type="button"
            onClick={handleOpenCreate}
            className="px-4 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg shadow-xs transition-colors flex items-center gap-1.5"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
            </svg>
            Tambah Rate Plan
          </button>
        </div>
      </div>

      {/* Pricing Settings Summary Banner */}
      {pricingSettings && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2 text-xs text-emerald-800 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <span><strong>PPN (Pajak):</strong> {pricingSettings.tax_percent}%</span>
            <span><strong>Service Charge:</strong> {pricingSettings.service_charge_percent}%</span>
          </div>
          <span className="text-emerald-700">Otoritatif: Dihitung saat reservasi / quote booking</span>
        </div>
      )}

      {/* Main Table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-xs overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-gray-500 text-sm">Memuat data Rate Plan...</div>
        ) : error ? (
          <div className="p-8 text-center space-y-3">
            <div className="text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-4 max-w-md mx-auto">
              <p className="font-semibold text-sm">Data Rate Plan belum dapat dimuat.</p>
              <p className="text-xs text-amber-700 mt-1">Silakan periksa koneksi atau coba muat ulang data.</p>
              <button
                type="button"
                onClick={() => void loadRatePlans()}
                className="mt-3 px-4 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg shadow-xs transition-colors cursor-pointer"
              >
                Coba Muat Ulang
              </button>
            </div>
          </div>
        ) : sortedAndFilteredPlans.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <svg className="w-12 h-12 text-gray-300 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="text-sm font-semibold text-gray-700">Belum ada Rate Plan.</div>
            <div className="text-xs text-gray-500">Tambahkan Rate Plan untuk mulai mengatur harga kamar.</div>
            <button
              type="button"
              onClick={handleOpenCreate}
              className="mt-2 inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg shadow-xs transition-colors cursor-pointer"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
              </svg>
              Tambah Rate Plan Baru
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-gray-700">
              <thead className="bg-gray-50/80 text-gray-500 uppercase tracking-wider font-semibold border-b border-gray-200 select-none">
                <tr>
                  <th
                    className="py-3 px-4 cursor-pointer hover:bg-gray-100 hover:text-gray-900 transition-colors"
                    onClick={() => handleSort('code_name')}
                  >
                    <div className="flex items-center">
                      <span>Kode &amp; Nama</span>
                      {renderSortIndicator('code_name')}
                    </div>
                  </th>
                  <th
                    className="py-3 px-4 cursor-pointer hover:bg-gray-100 hover:text-gray-900 transition-colors"
                    onClick={() => handleSort('room_type')}
                  >
                    <div className="flex items-center">
                      <span>Tipe Kamar</span>
                      {renderSortIndicator('room_type')}
                    </div>
                  </th>
                  <th className="py-3 px-4">Meal Plan</th>
                  <th
                    className="py-3 px-4 cursor-pointer hover:bg-gray-100 hover:text-gray-900 transition-colors"
                    onClick={() => handleSort('base_rate')}
                  >
                    <div className="flex items-center">
                      <span>Harga Dasar</span>
                      {renderSortIndicator('base_rate')}
                    </div>
                  </th>
                  <th className="py-3 px-4">Ketentuan</th>
                  <th
                    className="py-3 px-4 cursor-pointer hover:bg-gray-100 hover:text-gray-900 transition-colors"
                    onClick={() => handleSort('status')}
                  >
                    <div className="flex items-center">
                      <span>Status</span>
                      {renderSortIndicator('status')}
                    </div>
                  </th>
                  <th className="py-3 px-4 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {sortedAndFilteredPlans.map((plan) => {
                  return (
                    <tr
                      key={plan.id}
                      className={`hover:bg-gray-50/60 transition-colors ${plan.is_archived ? 'bg-gray-50/70 opacity-75' : ''}`}
                    >
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-emerald-800 bg-emerald-100/70 px-2 py-0.5 rounded text-xs">
                            {plan.code}
                          </span>
                          <span className="font-semibold text-gray-900">{plan.name}</span>
                          {plan.rate_type === 'DAY_USE' && (
                            <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-100 text-purple-800 border border-purple-300">
                              ⚡ Day Use ({plan.duration_minutes ? plan.duration_minutes / 60 : 6}j)
                            </span>
                          )}
                        </div>
                        {plan.description && (
                          <div className="text-gray-500 text-xs mt-0.5 line-clamp-1">{plan.description}</div>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <span className="font-medium text-gray-800">
                          {plan.room_type_name || `ID: ${plan.room_type_id}`}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-50 text-amber-800 border border-amber-200">
                          {plan.meal_plan_name
                            ? `${plan.meal_plan_code || plan.meal_plan} — ${plan.meal_plan_name}`
                            : (MEAL_PLAN_LABELS[plan.meal_plan] || plan.meal_plan)}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <span className="font-bold text-gray-900 text-sm">
                          {formatIDR(plan.base_rate)}
                        </span>
                        <span className="text-gray-500 text-xs block">
                          {plan.rate_type === 'DAY_USE' ? '/ paket' : '/ malam'}
                        </span>
                      </td>
                      <td className="py-3 px-4 space-y-0.5">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`inline-block w-2 h-2 rounded-full ${plan.refundable ? 'bg-emerald-500' : 'bg-rose-500'}`}
                          />
                          <span className="text-xs">{plan.refundable ? 'Refundable' : 'Non-Refundable'}</span>
                        </div>
                        <div className="text-gray-500 text-xs">
                          {plan.rate_type === 'DAY_USE'
                            ? `Jam: ${plan.earliest_start_time || '08:00'}–${plan.latest_start_time || '18:00'}`
                            : `Min. ${plan.min_stay} malam`}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        {plan.is_archived ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-gray-200 text-gray-700">
                            Diarsipkan
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleToggleStatus(plan)}
                            className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold transition-colors cursor-pointer ${
                              plan.is_active
                                ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
                                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                            }`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${plan.is_active ? 'bg-emerald-600' : 'bg-gray-400'}`} />
                            {plan.is_active ? 'Aktif' : 'Non-aktif'}
                          </button>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {/* Calendar Matrix View */}
                          {onOpenCalendar && !plan.is_archived && (
                            <button
                              type="button"
                              onClick={() => onOpenCalendar(plan.id)}
                              title="Buka Rate Calendar"
                              className="p-1.5 text-gray-500 hover:text-emerald-700 hover:bg-emerald-50 rounded-md transition-colors"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                              </svg>
                            </button>
                          )}


                          {/* Duplicate */}
                          {!plan.is_archived && (
                            <button
                              type="button"
                              onClick={() => handleOpenDuplicate(plan)}
                              title="Duplikasi Rate Plan"
                              className="p-1.5 text-gray-500 hover:text-blue-700 hover:bg-blue-50 rounded-md transition-colors"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                              </svg>
                            </button>
                          )}

                          {/* Edit */}
                          {!plan.is_archived && (
                            <button
                              type="button"
                              onClick={() => handleOpenEdit(plan)}
                              title="Edit Rate Plan"
                              className="p-1.5 text-gray-500 hover:text-amber-700 hover:bg-amber-50 rounded-md transition-colors"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                              </svg>
                            </button>
                          )}

                          {/* Delete */}
                          <button
                            type="button"
                            onClick={() => handleOpenDelete(plan)}
                            title={plan.is_archived ? 'Hapus' : 'Hapus / Arsipkan'}
                            className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ==================================================================== */}
      {/* MODAL: CREATE / EDIT RATE PLAN */}
      {/* ==================================================================== */}
      {(modalMode === 'create' || modalMode === 'edit') && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="bg-emerald-900 text-white px-6 py-4 flex items-center justify-between">
              <h3 className="font-bold text-base">
                {modalMode === 'create' ? 'Tambah Rate Plan Baru' : `Edit Rate Plan: ${selectedPlan?.code}`}
              </h3>
              <button
                type="button"
                onClick={() => setModalMode(null)}
                className="text-white/80 hover:text-white text-xl leading-none"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleSubmitPlan} className="p-6 space-y-4 max-h-[80vh] overflow-y-auto">
              {modalError && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-xs p-3 rounded-lg">
                  {modalError}
                </div>
              )}

              {/* Stay / Rate Type Selector */}
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  Jenis Paket / Stay Type <span className="text-red-500">*</span>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, rate_type: 'OVERNIGHT' })}
                    className={`py-2 px-3 rounded-lg border text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
                      (formData.rate_type || 'OVERNIGHT') === 'OVERNIGHT'
                        ? 'bg-emerald-800 text-white border-emerald-900 shadow-xs'
                        : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    <span>🌙 Menginap (Overnight)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, rate_type: 'DAY_USE', duration_minutes: formData.duration_minutes || 360 })}
                    className={`py-2 px-3 rounded-lg border text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
                      formData.rate_type === 'DAY_USE'
                        ? 'bg-purple-800 text-white border-purple-900 shadow-xs'
                        : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    <span>⚡ Day Use / Transit</span>
                  </button>
                </div>
              </div>

              {formData.rate_type === 'DAY_USE' && (
                <div className="p-3 bg-purple-50/70 border border-purple-200 rounded-xl space-y-3">
                  <div className="text-xs font-bold text-purple-900 flex items-center gap-1">
                    <span>⚡ Pengaturan Khusus Day Use / Transit</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                    <div>
                      <label className="block font-medium text-purple-900 mb-1">Durasi Paket (Jam)</label>
                      <select
                        value={formData.duration_minutes ? String(formData.duration_minutes / 60) : '6'}
                        onChange={(e) => setFormData({ ...formData, duration_minutes: Number(e.target.value) * 60 })}
                        className="w-full bg-white border border-purple-300 rounded-lg px-2.5 py-1.5 font-bold text-purple-950 focus:ring-2 focus:ring-purple-500"
                      >
                        <option value="3">3 Jam</option>
                        <option value="4">4 Jam</option>
                        <option value="6">6 Jam</option>
                        <option value="8">8 Jam</option>
                        <option value="12">12 Jam</option>
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium text-purple-900 mb-1">Jam Mulai Paling Awal</label>
                      <input
                        type="time"
                        value={formData.earliest_start_time || '08:00'}
                        onChange={(e) => setFormData({ ...formData, earliest_start_time: e.target.value })}
                        className="w-full bg-white border border-purple-300 rounded-lg px-2.5 py-1.5 font-mono text-purple-950 focus:ring-2 focus:ring-purple-500"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-purple-900 mb-1">Jam Selesai Paling Akhir</label>
                      <input
                        type="time"
                        value={formData.latest_start_time || '18:00'}
                        onChange={(e) => setFormData({ ...formData, latest_start_time: e.target.value })}
                        className="w-full bg-white border border-purple-300 rounded-lg px-2.5 py-1.5 font-mono text-purple-950 focus:ring-2 focus:ring-purple-500"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Basic Section */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    Tipe Kamar <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={formData.room_type_id}
                    onChange={(e) => setFormData({ ...formData, room_type_id: Number(e.target.value) })}
                    required
                    className="w-full text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                  >
                    {roomTypes.map((rt) => (
                      <option key={rt.id} value={rt.id}>
                        {rt.code} — {rt.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    Kode Rate Plan <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="Contoh: BAR, PROMO-WKND"
                    value={formData.code}
                    onChange={(e) => setFormData({ ...formData, code: e.target.value.toUpperCase() })}
                    className="w-full text-sm font-mono uppercase bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  Nama Rate Plan <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="Contoh: Best Available Rate with Breakfast"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    Harga Dasar (IDR / Malam) <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="1000"
                    required
                    value={formData.base_rate}
                    onChange={(e) => setFormData({ ...formData, base_rate: Number(e.target.value) })}
                    className="w-full text-sm font-semibold bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                  />
                  <span className="text-xs text-gray-500 mt-1 block">{formatIDR(formData.base_rate)}</span>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-semibold text-gray-700">
                      Meal Plan <span className="text-red-500">*</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => setShowMealPlanModal(true)}
                      className="text-[11px] text-emerald-800 hover:text-emerald-950 font-bold underline px-1 py-0.5 rounded hover:bg-emerald-50 transition-colors flex items-center gap-1 cursor-pointer"
                      title="Kelola Master Meal Plan"
                    >
                      <span>🍽️</span> [Kelola]
                    </button>
                  </div>
                  <select
                    value={
                      formData.meal_plan_id
                        ? String(formData.meal_plan_id)
                        : (mealPlans.find((m) => m.code === formData.meal_plan)?.id
                          ? String(mealPlans.find((m) => m.code === formData.meal_plan)?.id)
                          : '')
                    }
                    onChange={(e) => {
                      const idNum = Number(e.target.value);
                      const mp = mealPlans.find((m) => m.id === idNum);
                      setFormData({
                        ...formData,
                        meal_plan_id: idNum || null,
                        meal_plan: mp ? mp.code : formData.meal_plan
                      });
                    }}
                    className="w-full text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                  >
                    {mealPlans.map((mp) => (
                      <option key={mp.id} value={mp.id}>
                        {mp.code} — {mp.name}
                      </option>
                    ))}
                    {formData.meal_plan &&
                      !mealPlans.some((m) => m.id === formData.meal_plan_id || m.code === formData.meal_plan) && (
                        <option value="">{formData.meal_plan} (Legacy / Tak Aktif)</option>
                      )}
                  </select>
                </div>
              </div>

              <div className="flex items-center gap-6 pt-1">
                <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.refundable}
                    onChange={(e) => setFormData({ ...formData, refundable: e.target.checked })}
                    className="rounded text-emerald-600 focus:ring-emerald-500 w-4 h-4"
                  />
                  Refundable (Bisa Dibatalkan)
                </label>

                <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.is_active}
                    onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })}
                    className="rounded text-emerald-600 focus:ring-emerald-500 w-4 h-4"
                  />
                  Status Aktif
                </label>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Deskripsi / Keterangan</label>
                <textarea
                  rows={2}
                  placeholder="Keterangan mengenai fasilitas atau ketentuan rate plan ini..."
                  value={formData.description || ''}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="w-full text-xs bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                />
              </div>

              {/* Advanced Collapsible Accordion */}
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="w-full px-4 py-2.5 bg-gray-50 hover:bg-gray-100 text-left text-xs font-semibold text-gray-700 flex items-center justify-between transition-colors"
                >
                  <span>Pengaturan Tambahan (Kebijakan, Min Stay, Extra Bed)</span>
                  <svg
                    className={`w-4 h-4 text-gray-500 transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {showAdvanced && (
                  <div className="p-4 bg-white space-y-3 border-t border-gray-200">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Min Stay (Malam)</label>
                        <input
                          type="number"
                          min="1"
                          value={formData.min_stay || 1}
                          onChange={(e) => setFormData({ ...formData, min_stay: Number(e.target.value) })}
                          className="w-full text-xs bg-gray-50 border border-gray-300 rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Max Stay (Malam, Opsional)</label>
                        <input
                          type="number"
                          min="1"
                          placeholder="Kosong = Tak terbatas"
                          value={formData.max_stay || ''}
                          onChange={(e) => setFormData({ ...formData, max_stay: e.target.value ? Number(e.target.value) : null })}
                          className="w-full text-xs bg-gray-50 border border-gray-300 rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Tarif Extra Bed (IDR)</label>
                        <input
                          type="number"
                          min="0"
                          step="1000"
                          value={formData.extra_bed_rate || 0}
                          onChange={(e) => setFormData({ ...formData, extra_bed_rate: Number(e.target.value) })}
                          className="w-full text-xs bg-gray-50 border border-gray-300 rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Tarif Extra Orang (IDR)</label>
                        <input
                          type="number"
                          min="0"
                          step="1000"
                          value={formData.extra_person_rate || 0}
                          onChange={(e) => setFormData({ ...formData, extra_person_rate: Number(e.target.value) })}
                          className="w-full text-xs bg-gray-50 border border-gray-300 rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Kebijakan Pembatalan (Teks)</label>
                      <input
                        type="text"
                        placeholder="Contoh: Pembatalan gratis s/d H-1 jam 14:00"
                        value={formData.cancellation_policy || ''}
                        onChange={(e) => setFormData({ ...formData, cancellation_policy: e.target.value })}
                        className="w-full text-xs bg-gray-50 border border-gray-300 rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Modal Buttons */}
              <div className="flex items-center justify-end gap-3 pt-3 border-t border-gray-200">
                <button
                  type="button"
                  onClick={() => setModalMode(null)}
                  className="px-4 py-2 text-xs font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg shadow-xs transition-colors disabled:opacity-50"
                >
                  {submitting ? 'Menyimpan...' : 'Simpan Rate Plan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* MODAL: DUPLICATE RATE PLAN */}
      {/* ==================================================================== */}
      {modalMode === 'duplicate' && selectedPlan && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="bg-blue-900 text-white px-6 py-4 flex items-center justify-between">
              <h3 className="font-bold text-base">Duplikasi Rate Plan</h3>
              <button
                type="button"
                onClick={() => setModalMode(null)}
                className="text-white/80 hover:text-white text-xl leading-none"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleSubmitDuplicate} className="p-6 space-y-4">
              {modalError && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-xs p-3 rounded-lg">
                  {modalError}
                </div>
              )}

              <p className="text-xs text-gray-600">
                Menduplikasi master tarif dari <strong>{selectedPlan.code} — {selectedPlan.name}</strong> ({formatIDR(selectedPlan.base_rate)}).
              </p>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  Kode Rate Plan Baru <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={dupCode}
                  onChange={(e) => setDupCode(e.target.value.toUpperCase())}
                  className="w-full text-sm font-mono uppercase bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-hidden"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  Nama Rate Plan Baru <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={dupName}
                  onChange={(e) => setDupName(e.target.value)}
                  className="w-full text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-hidden"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-gray-200">
                <button
                  type="button"
                  onClick={() => setModalMode(null)}
                  className="px-4 py-2 text-xs font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg shadow-xs transition-colors disabled:opacity-50"
                >
                  {submitting ? 'Menduplikasi...' : 'Duplikasi Sekarang'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* MODAL: SAFE DELETE / ARCHIVE CONFIRMATION */}
      {/* ==================================================================== */}
      {modalMode === 'delete' && selectedPlan && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="bg-red-900 text-white px-6 py-4 flex items-center justify-between">
              <h3 className="font-bold text-base">Hapus / Arsipkan Rate Plan</h3>
              <button
                type="button"
                onClick={() => setModalMode(null)}
                className="text-white/80 hover:text-white text-xl leading-none"
              >
                &times;
              </button>
            </div>

            <div className="p-6 space-y-4">
              {modalError && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-xs p-3 rounded-lg">
                  {modalError}
                </div>
              )}

              <p className="text-sm text-gray-800 font-medium">
                Apakah Anda yakin ingin menghapus Rate Plan <strong>{selectedPlan.code} — {selectedPlan.name}</strong>?
              </p>

              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900 space-y-1">
                <strong>Ketentuan Keamanan Finansial:</strong>
                <p>
                  Jika Rate Plan ini pernah digunakan oleh transaksi reservasi terdahulu, sistem akan <strong>mengarsipkannya secara aman</strong> agar histori finansial reservasi tetap terlindungi.
                </p>
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-gray-200">
                <button
                  type="button"
                  onClick={() => setModalMode(null)}
                  className="px-4 py-2 text-xs font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                >
                  Batal
                </button>
                <button
                  type="button"
                  onClick={handleSubmitDelete}
                  disabled={submitting}
                  className="px-5 py-2 text-xs font-semibold text-white bg-red-700 hover:bg-red-800 rounded-lg shadow-xs transition-colors disabled:opacity-50"
                >
                  {submitting ? 'Memproses...' : 'Ya, Lanjutkan'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* MODAL: PROPERTY PRICING SETTINGS (TAX & SERVICE) */}
      {/* ==================================================================== */}
      {modalMode === 'settings' && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="bg-gray-900 text-white px-6 py-4 flex items-center justify-between">
              <h3 className="font-bold text-base">Pengaturan Pajak &amp; Servis Hotel</h3>
              <button
                type="button"
                onClick={() => setModalMode(null)}
                className="text-white/80 hover:text-white text-xl leading-none"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleSubmitSettings} className="p-6 space-y-4">
              {modalError && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-xs p-3 rounded-lg">
                  {modalError}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  Persentase Pajak PPN (%) <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  required
                  value={taxPercent}
                  onChange={(e) => setTaxPercent(Number(e.target.value))}
                  className="w-full text-sm font-semibold bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                />
                <span className="text-xs text-gray-500 mt-1 block">Default reguler: 10% atau 11%</span>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  Persentase Service Charge (%) <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  required
                  value={servicePercent}
                  onChange={(e) => setServicePercent(Number(e.target.value))}
                  className="w-full text-sm font-semibold bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                />
                <span className="text-xs text-gray-500 mt-1 block">Biaya layanan hotel (jika ada)</span>
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-gray-200">
                <button
                  type="button"
                  onClick={() => setModalMode(null)}
                  className="px-4 py-2 text-xs font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg shadow-xs transition-colors disabled:opacity-50"
                >
                  {submitting ? 'Menyimpan...' : 'Simpan Pengaturan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* MODAL: MEAL PLAN MANAGER (MASTER CRUD) */}
      {/* ==================================================================== */}
      {propertyId && (
        <MealPlanManagerModal
          propertyId={propertyId}
          isOpen={showMealPlanModal}
          onClose={() => {
            setShowMealPlanModal(false);
            void loadRatePlans();
          }}
          onSelectMealPlan={(newMp) => {
            setMealPlans((prev) => {
              const exists = prev.some((p) => p.id === newMp.id);
              return exists ? prev.map((p) => (p.id === newMp.id ? newMp : p)) : [newMp, ...prev];
            });
            setFormData((prev) => ({
              ...prev,
              meal_plan_id: newMp.id,
              meal_plan: newMp.code
            }));
          }}
        />
      )}
    </div>
  );
}
