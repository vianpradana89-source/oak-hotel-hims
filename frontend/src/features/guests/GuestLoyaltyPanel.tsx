import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Award,
  Calendar,
  Crown,
  Gift,
  History,
  Info,
  PlusCircle,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  Guest,
  GuestLoyaltyLedgerEntry,
  LoyaltyCalculationPeriod,
  LoyaltyTierCode,
  PropertyLoyaltySettings,
  PropertyLoyaltyTierConfig,
} from './guestTypes';
import { authenticatedFetch } from '../../lib/authenticatedFetch';

interface GuestLoyaltyPanelProps {
  propertyId: number;
  guests: Guest[];
  loyaltySettings: PropertyLoyaltySettings | null;
  onRefreshGuests: () => void;
  onSelectGuest: (guestId: number) => void;
}

function formatRupiah(val: number | undefined | null): string {
  const num = Number(val || 0);
  return `Rp ${Math.round(num).toLocaleString('id-ID')}`;
}

const DEFAULT_TIERS: PropertyLoyaltyTierConfig[] = [
  { code: 'BRONZE', name: 'Bronze', min_spend: 0, discount_pct: 0 },
  { code: 'SILVER', name: 'Silver', min_spend: 500000, discount_pct: 2 },
  { code: 'GOLD', name: 'Gold', min_spend: 2500000, discount_pct: 5 },
  { code: 'PLATINUM', name: 'Platinum', min_spend: 5000000, discount_pct: 25 },
];

const REWARD_CATALOG = [
  { label: 'Potongan Tagihan Kamar Rp 50.000', points: 150 },
  { label: 'Free Welcome Drink / Snack POS Resto', points: 50 },
  { label: 'Free Late Check-Out (s/d 14:00 WIB)', points: 100 },
  { label: 'Free Upgrade Tipe Kamar (1 Malam)', points: 300 },
];

export const GuestLoyaltyPanel: React.FC<GuestLoyaltyPanelProps> = ({
  propertyId,
  guests,
  loyaltySettings,
  onRefreshGuests,
  onSelectGuest,
}) => {
  const [subTab, setSubTab] = useState<'members' | 'ledger' | 'settings'>('members');
  const [tierFilter, setTierFilter] = useState<'ALL' | LoyaltyTierCode>('ALL');
  const [search, setSearch] = useState<string>('');
  const [ledger, setLedger] = useState<GuestLoyaltyLedgerEntry[]>([]);
  const [loadingLedger, setLoadingLedger] = useState<boolean>(false);
  const [syncingVip, setSyncingVip] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Redeem / Bonus modal state
  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [selectedGuest, setSelectedGuest] = useState<Guest | null>(null);
  const [entryType, setEntryType] = useState<'REDEEM' | 'BONUS'>('REDEEM');
  const [pointsInput, setPointsInput] = useState<string>('50');
  const [descriptionInput, setDescriptionInput] = useState<string>(REWARD_CATALOG[0].label);
  const [referenceInput, setReferenceInput] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);

  // Loyalty Program Settings form state (Ref. Gambar 5)
  const [pointsEnabled, setPointsEnabled] = useState<boolean>(true);
  const [spendPerPoint, setSpendPerPoint] = useState<number>(10000);
  const [pointsEarnedPerUnit, setPointsEarnedPerUnit] = useState<number>(1);
  const [pointsPerVisit, setPointsPerVisit] = useState<number>(1);
  const [pointValueIdr, setPointValueIdr] = useState<number>(350);
  const [minRedeemPoints, setMinRedeemPoints] = useState<number>(50);
  const [pointExpiryMonths, setPointExpiryMonths] = useState<number>(12);
  const [silverThreshold, setSilverThreshold] = useState<number>(1000);
  const [goldThreshold, setGoldThreshold] = useState<number>(2000);
  const [platinumThreshold, setPlatinumThreshold] = useState<number>(5000);
  const [savingSettings, setSavingSettings] = useState<boolean>(false);

  // Loyalty Tier Settings Modal state (Ref. Gambar 6)
  const [isTierModalOpen, setIsTierModalOpen] = useState<boolean>(false);
  const [tierPeriod, setTierPeriod] = useState<LoyaltyCalculationPeriod>('CUMULATIVE');
  const [tiersConfig, setTiersConfig] = useState<PropertyLoyaltyTierConfig[]>(DEFAULT_TIERS);
  const [savingTierModal, setSavingTierModal] = useState<boolean>(false);

  useEffect(() => {
    if (!loyaltySettings) return;
    setPointsEnabled(Boolean(loyaltySettings.points_enabled));
    setSpendPerPoint(Number(loyaltySettings.spend_per_point || 10000));
    setPointsEarnedPerUnit(Number(loyaltySettings.points_earned_per_unit ?? 1));
    setPointsPerVisit(Number(loyaltySettings.points_per_visit ?? 1));
    setPointValueIdr(Number(loyaltySettings.point_value_idr || 350));
    setMinRedeemPoints(Number(loyaltySettings.min_redeem_points || 50));
    setPointExpiryMonths(Number(loyaltySettings.point_expiry_months || 12));
    setSilverThreshold(Number(loyaltySettings.silver_point_threshold ?? 1000));
    setGoldThreshold(Number(loyaltySettings.gold_point_threshold ?? 2000));
    setPlatinumThreshold(Number(loyaltySettings.platinum_point_threshold ?? 5000));
    setTierPeriod(loyaltySettings.tier_calculation_period || 'CUMULATIVE');
    setTiersConfig(
      Array.isArray(loyaltySettings.tiers_config) && loyaltySettings.tiers_config.length > 0
        ? loyaltySettings.tiers_config
        : DEFAULT_TIERS
    );
  }, [loyaltySettings]);

  const loadLedger = useCallback(async () => {
    setLoadingLedger(true);
    try {
      const res = await authenticatedFetch(`/api/guests/loyalty-ledger?property_id=${propertyId}`);
      if (res.ok) {
        const json = await res.json();
        setLedger(json.data || []);
      }
    } catch {
      // ignore
    } finally {
      setLoadingLedger(false);
    }
  }, [propertyId]);

  useEffect(() => {
    loadLedger();
  }, [loadLedger]);

  const summaryStats = useMemo(() => {
    let bronzeCount = 0;
    let silverCount = 0;
    let goldCount = 0;
    let platinumCount = 0;
    let totalActivePoints = 0;
    let totalRedeemedPoints = 0;

    for (const g of guests) {
      const tier = g.loyalty_tier || 'BRONZE';
      if (tier === 'PLATINUM') platinumCount++;
      else if (tier === 'GOLD') goldCount++;
      else if (tier === 'SILVER') silverCount++;
      else bronzeCount++;

      totalActivePoints += Number(g.loyalty_points || 0);
      totalRedeemedPoints += Number(g.redeemed_points || 0);
    }

    return {
      bronzeCount,
      silverCount,
      goldCount,
      platinumCount,
      totalActivePoints,
      totalRedeemedPoints,
    };
  }, [guests]);

  const filteredGuests = useMemo(() => {
    const q = search.trim().toLowerCase();
    return guests
      .filter((g) => {
        const tier = g.loyalty_tier || 'BRONZE';
        if (tierFilter !== 'ALL' && tier !== tierFilter) return false;
        if (!q) return true;
        return (
          g.full_name?.toLowerCase().includes(q) ||
          g.phone?.toLowerCase().includes(q) ||
          g.guest_code?.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const pDiff = Number(b.loyalty_points || 0) - Number(a.loyalty_points || 0);
        if (pDiff !== 0) return pDiff;
        return Number(b.total_spend || 0) - Number(a.total_spend || 0);
      });
  }, [guests, tierFilter, search]);

  const openLoyaltyModal = (guest: Guest, mode: 'REDEEM' | 'BONUS') => {
    setSelectedGuest(guest);
    setEntryType(mode);
    if (mode === 'REDEEM') {
      setPointsInput(String(minRedeemPoints || 50));
      setDescriptionInput(REWARD_CATALOG[0].label);
    } else {
      setPointsInput('50');
      setDescriptionInput('Bonus Poin Apresiasi Tamu Loyal');
    }
    setReferenceInput('');
    setModalOpen(true);
  };

  const handleSaveEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedGuest) return;
    const pts = Math.round(Number(pointsInput || 0));
    if (!pts || pts <= 0) {
      setFeedback({ type: 'error', text: 'Jumlah poin harus lebih dari 0.' });
      return;
    }
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await authenticatedFetch('/api/guests/loyalty-ledger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          guest_id: selectedGuest.id,
          entry_type: entryType,
          points: pts,
          description: descriptionInput.trim(),
          reference_no: referenceInput.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.message || 'Gagal menyimpan mutasi poin.');
      }
      setModalOpen(false);
      setFeedback({
        type: 'success',
        text:
          entryType === 'REDEEM'
            ? `Berhasil menukar ${pts} poin untuk ${selectedGuest.full_name}.`
            : `Berhasil menambahkan +${pts} poin bonus untuk ${selectedGuest.full_name}.`,
      });
      onRefreshGuests();
      loadLedger();
    } catch (err: unknown) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal menyimpan mutasi poin.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSyncVipTiers = async () => {
    setSyncingVip(true);
    setFeedback(null);
    try {
      const res = await authenticatedFetch('/api/guests/loyalty-sync-vip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.message || 'Gagal menyinkronkan tier VIP.');
      }
      const count = json?.data?.updated_count || 0;
      setFeedback({
        type: 'success',
        text: `Sinkronisasi selesai: ${count} profil tamu otomatis diperbarui status VIP/VVIP-nya sesuai Tier Loyalitas.`,
      });
      onRefreshGuests();
    } catch (err: unknown) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal menyinkronkan tier VIP.',
      });
    } finally {
      setSyncingVip(false);
    }
  };

  const handleSavePointSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSettings(true);
    setFeedback(null);
    try {
      const res = await authenticatedFetch('/api/guests/loyalty-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          points_enabled: pointsEnabled,
          spend_per_point: spendPerPoint,
          points_earned_per_unit: pointsEarnedPerUnit,
          points_per_visit: pointsPerVisit,
          point_value_idr: pointValueIdr,
          min_redeem_points: minRedeemPoints,
          point_expiry_months: pointExpiryMonths,
          silver_point_threshold: silverThreshold,
          gold_point_threshold: goldThreshold,
          platinum_point_threshold: platinumThreshold,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.message || 'Gagal menyimpan pengaturan poin.');
      }
      setFeedback({
        type: 'success',
        text: 'Pengaturan Program Poin berhasil disimpan dan langsung diterapkan ke seluruh pelanggan.',
      });
      onRefreshGuests();
    } catch (err: unknown) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal menyimpan pengaturan poin.',
      });
    } finally {
      setSavingSettings(false);
    }
  };

  const handleSaveTierModal = async () => {
    setSavingTierModal(true);
    setFeedback(null);
    try {
      const res = await authenticatedFetch('/api/guests/loyalty-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          tier_calculation_period: tierPeriod,
          tiers_config: tiersConfig,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.message || 'Gagal menyimpan pengaturan Loyalty Tier.');
      }
      setIsTierModalOpen(false);
      setFeedback({
        type: 'success',
        text: 'Pengaturan Loyalty Tier & Diskon Member berhasil disimpan.',
      });
      onRefreshGuests();
    } catch (err: unknown) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal menyimpan pengaturan Loyalty Tier.',
      });
    } finally {
      setSavingTierModal(false);
    }
  };

  const updateTierRow = (
    code: LoyaltyTierCode,
    field: 'name' | 'min_spend' | 'discount_pct',
    value: string | number
  ) => {
    setTiersConfig((prev) =>
      prev.map((item) => {
        if (item.code !== code) return item;
        if (field === 'name') return { ...item, name: String(value) };
        if (field === 'min_spend') return { ...item, min_spend: Math.max(0, Number(value || 0)) };
        return { ...item, discount_pct: Math.max(0, Math.min(100, Number(value || 0))) };
      })
    );
  };

  return (
    <div className="space-y-5">
      {/* Top Sub-Tab Navigation + Tier Configuration Button (Ref. Gambar 5 & 6) */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center bg-stone-100 p-1 rounded-xl border border-stone-200 gap-1">
          <button
            type="button"
            onClick={() => setSubTab('members')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-all cursor-pointer ${
              subTab === 'members'
                ? 'bg-[#1E392A] text-white shadow-xs'
                : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            <Award className="w-3.5 h-3.5" />
            <span>Member Poin ({guests.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setSubTab('ledger')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-all cursor-pointer ${
              subTab === 'ledger'
                ? 'bg-[#1E392A] text-white shadow-xs'
                : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            <History className="w-3.5 h-3.5" />
            <span>Riwayat Poin ({ledger.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setSubTab('settings')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-all cursor-pointer ${
              subTab === 'settings'
                ? 'bg-[#1E392A] text-white shadow-xs'
                : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>Pengaturan</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsTierModalOpen(true)}
            className="px-3.5 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-200 text-xs font-semibold rounded-xl flex items-center gap-1.5 transition-colors shadow-2xs cursor-pointer"
          >
            <Crown className="w-3.5 h-3.5 text-amber-600" />
            <span>Pengaturan Loyalty Tier</span>
          </button>
          <button
            type="button"
            disabled={syncingVip}
            onClick={handleSyncVipTiers}
            className="px-3.5 py-1.5 bg-[#1E392A] hover:bg-[#162a1f] text-white text-xs font-semibold rounded-xl flex items-center gap-1.5 transition-colors shadow-xs disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncingVip ? 'animate-spin' : ''}`} />
            <span>{syncingVip ? 'Menyinkronkan...' : 'Sinkronkan Tier ke VIP'}</span>
          </button>
        </div>
      </div>

      {feedback && (
        <div
          className={`p-3 rounded-xl border text-xs font-medium flex items-center justify-between ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          <span>{feedback.text}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-[11px] underline ml-3 cursor-pointer"
          >
            Tutup
          </button>
        </div>
      )}

      {/* SUB-TAB 3: PENGATURAN PROGRAM POIN (Ref. Gambar 5) */}
      {subTab === 'settings' && (
        <form
          onSubmit={handleSavePointSettings}
          className="bg-white border border-stone-200 rounded-2xl p-6 shadow-xs space-y-6"
        >
          <div>
            <h3 className="text-sm font-bold text-stone-900">Aturan Program Poin</h3>
            <p className="text-xs text-stone-500 mt-0.5">
              Konfigurasi perolehan poin dari transaksi kamar & POS yang sudah lunas serta nilai tukar potongan Rupiah.
            </p>
          </div>

          {/* Toggle Aktifkan Program Poin */}
          <div className="p-4 rounded-xl border border-stone-200 bg-stone-50/50 flex items-center justify-between">
            <div>
              <p className="text-xs font-bold text-stone-900">Aktifkan Program Poin</p>
              <p className="text-[11px] text-stone-500 mt-0.5">
                Poin dihitung otomatis dari transaksi kamar dan POS yang berstatus Lunas (PAID).
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={pointsEnabled}
              onClick={() => setPointsEnabled((v) => !v)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                pointsEnabled ? 'bg-blue-600' : 'bg-stone-300'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                  pointsEnabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {/* Row 1: Poin per Belanja, Jumlah Poin Didapat, Poin per Kunjungan */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1.5">
                Poin per Belanja (Rp)
              </label>
              <input
                type="number"
                min={1}
                value={spendPerPoint}
                onChange={(e) => setSpendPerPoint(Math.max(1, Number(e.target.value || 1)))}
                className="w-full px-3.5 py-2.5 text-sm bg-[#FAF8F3] border border-[#E6DFC8] rounded-xl focus:outline-hidden focus:ring-2 focus:ring-[#1E392A]/20"
              />
              <p className="text-[11px] text-stone-400 mt-1">
                Setiap belanja sejumlah ini menghasilkan poin.
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1.5">
                Jumlah Poin Didapat
              </label>
              <input
                type="number"
                min={0}
                value={pointsEarnedPerUnit}
                onChange={(e) => setPointsEarnedPerUnit(Math.max(0, Number(e.target.value || 0)))}
                className="w-full px-3.5 py-2.5 text-sm bg-[#FAF8F3] border border-[#E6DFC8] rounded-xl focus:outline-hidden focus:ring-2 focus:ring-[#1E392A]/20"
              />
              <p className="text-[11px] text-stone-400 mt-1">
                Poin per kelipatan belanja di atas.
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1.5">
                Poin per Kunjungan
              </label>
              <input
                type="number"
                min={0}
                value={pointsPerVisit}
                onChange={(e) => setPointsPerVisit(Math.max(0, Number(e.target.value || 0)))}
                className="w-full px-3.5 py-2.5 text-sm bg-[#FAF8F3] border border-[#E6DFC8] rounded-xl focus:outline-hidden focus:ring-2 focus:ring-[#1E392A]/20"
              />
              <p className="text-[11px] text-stone-400 mt-1">
                Bonus poin setiap satu transaksi/kedatangan selesai.
              </p>
            </div>
          </div>

          {/* Row 2: Nilai 1 Poin (Rp), Minimal Penukaran (poin), Masa Berlaku Poin (bulan) */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1.5">
                Nilai 1 Poin (Rp)
              </label>
              <input
                type="number"
                min={1}
                value={pointValueIdr}
                onChange={(e) => setPointValueIdr(Math.max(1, Number(e.target.value || 1)))}
                className="w-full px-3.5 py-2.5 text-sm bg-[#FAF8F3] border border-[#E6DFC8] rounded-xl focus:outline-hidden focus:ring-2 focus:ring-[#1E392A]/20"
              />
              <p className="text-[11px] text-stone-400 mt-1">
                Nilai potongan Rupiah untuk setiap 1 poin yang ditukarkan.
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1.5">
                Minimal Penukaran (poin)
              </label>
              <input
                type="number"
                min={1}
                value={minRedeemPoints}
                onChange={(e) => setMinRedeemPoints(Math.max(1, Number(e.target.value || 1)))}
                className="w-full px-3.5 py-2.5 text-sm bg-[#FAF8F3] border border-[#E6DFC8] rounded-xl focus:outline-hidden focus:ring-2 focus:ring-[#1E392A]/20"
              />
              <p className="text-[11px] text-stone-400 mt-1">
                Batas minimal saldo poin agar bisa memotong transaksi.
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1.5">
                Masa Berlaku Poin (bulan)
              </label>
              <input
                type="number"
                min={1}
                value={pointExpiryMonths}
                onChange={(e) => setPointExpiryMonths(Math.max(1, Number(e.target.value || 1)))}
                className="w-full px-3.5 py-2.5 text-sm bg-[#FAF8F3] border border-[#E6DFC8] rounded-xl focus:outline-hidden focus:ring-2 focus:ring-[#1E392A]/20"
              />
              <p className="text-[11px] text-stone-400 mt-1">
                Durasi aktif poin sejak diperoleh pelanggan.
              </p>
            </div>
          </div>

          {/* Row 3: Ambang Tingkatan Member (Silver, Gold, Platinum) */}
          <div className="pt-2 border-t border-stone-100">
            <h4 className="text-xs font-bold text-stone-900 mb-3">
              Ambang Tingkatan Member (Berdasarkan Poin)
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1.5">
                  Silver (poin)
                </label>
                <input
                  type="number"
                  min={0}
                  value={silverThreshold}
                  onChange={(e) => setSilverThreshold(Math.max(0, Number(e.target.value || 0)))}
                  className="w-full px-3.5 py-2.5 text-sm bg-[#FAF8F3] border border-[#E6DFC8] rounded-xl focus:outline-hidden focus:ring-2 focus:ring-[#1E392A]/20"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1.5">
                  Gold (poin)
                </label>
                <input
                  type="number"
                  min={0}
                  value={goldThreshold}
                  onChange={(e) => setGoldThreshold(Math.max(0, Number(e.target.value || 0)))}
                  className="w-full px-3.5 py-2.5 text-sm bg-[#FAF8F3] border border-[#E6DFC8] rounded-xl focus:outline-hidden focus:ring-2 focus:ring-[#1E392A]/20"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1.5">
                  Platinum (poin)
                </label>
                <input
                  type="number"
                  min={0}
                  value={platinumThreshold}
                  onChange={(e) => setPlatinumThreshold(Math.max(0, Number(e.target.value || 0)))}
                  className="w-full px-3.5 py-2.5 text-sm bg-[#FAF8F3] border border-[#E6DFC8] rounded-xl focus:outline-hidden focus:ring-2 focus:ring-[#1E392A]/20"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={savingSettings}
              className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl shadow-xs flex items-center gap-2 transition-colors disabled:opacity-50 cursor-pointer"
            >
              <Save className="w-4 h-4" />
              <span>{savingSettings ? 'Menyimpan...' : 'Simpan Pengaturan'}</span>
            </button>
          </div>
        </form>
      )}

      {/* SUB-TAB 1: MEMBER POIN */}
      {subTab === 'members' && (
        <>
          {/* Tier Overview Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            <div
              onClick={() => setTierFilter(tierFilter === 'PLATINUM' ? 'ALL' : 'PLATINUM')}
              className={`bg-white border rounded-xl p-4 shadow-xs cursor-pointer transition-all ${
                tierFilter === 'PLATINUM' ? 'border-sky-600 ring-2 ring-sky-500/20' : 'border-stone-200 hover:border-stone-300'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-sky-800">
                  Platinum Tier
                </span>
                <Sparkles className="w-4 h-4 text-sky-600" />
              </div>
              <p className="text-2xl font-bold text-stone-900 mt-1">
                {summaryStats.platinumCount.toLocaleString('id-ID')}
              </p>
              <p className="text-[11px] text-stone-500 mt-1">
                &ge; {platinumThreshold.toLocaleString('id-ID')} poin / spend tier
              </p>
            </div>

            <div
              onClick={() => setTierFilter(tierFilter === 'GOLD' ? 'ALL' : 'GOLD')}
              className={`bg-white border rounded-xl p-4 shadow-xs cursor-pointer transition-all ${
                tierFilter === 'GOLD' ? 'border-amber-600 ring-2 ring-amber-500/20' : 'border-stone-200 hover:border-stone-300'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-amber-800">
                  Gold Tier
                </span>
                <Crown className="w-4 h-4 text-amber-600" />
              </div>
              <p className="text-2xl font-bold text-stone-900 mt-1">
                {summaryStats.goldCount.toLocaleString('id-ID')}
              </p>
              <p className="text-[11px] text-stone-500 mt-1">
                &ge; {goldThreshold.toLocaleString('id-ID')} poin / spend tier
              </p>
            </div>

            <div
              onClick={() => setTierFilter(tierFilter === 'SILVER' ? 'ALL' : 'SILVER')}
              className={`bg-white border rounded-xl p-4 shadow-xs cursor-pointer transition-all ${
                tierFilter === 'SILVER' ? 'border-stone-600 ring-2 ring-stone-500/20' : 'border-stone-200 hover:border-stone-300'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-stone-600">
                  Silver Tier
                </span>
                <Award className="w-4 h-4 text-stone-500" />
              </div>
              <p className="text-2xl font-bold text-stone-900 mt-1">
                {summaryStats.silverCount.toLocaleString('id-ID')}
              </p>
              <p className="text-[11px] text-stone-500 mt-1">
                &ge; {silverThreshold.toLocaleString('id-ID')} poin / spend tier
              </p>
            </div>

            <div
              onClick={() => setTierFilter(tierFilter === 'BRONZE' ? 'ALL' : 'BRONZE')}
              className={`bg-white border rounded-xl p-4 shadow-xs cursor-pointer transition-all ${
                tierFilter === 'BRONZE' ? 'border-amber-700 ring-2 ring-amber-700/20' : 'border-stone-200 hover:border-stone-300'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-amber-900/70">
                  Bronze Member
                </span>
                <Award className="w-4 h-4 text-amber-700" />
              </div>
              <p className="text-2xl font-bold text-stone-900 mt-1">
                {summaryStats.bronzeCount.toLocaleString('id-ID')}
              </p>
              <p className="text-[11px] text-stone-500 mt-1">
                Member reguler terdaftar
              </p>
            </div>

            <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-[#1E392A]">
                  Saldo Poin Aktif
                </span>
                <Gift className="w-4 h-4 text-[#1E392A]" />
              </div>
              <p className="text-2xl font-bold text-[#1E392A] mt-1">
                {summaryStats.totalActivePoints.toLocaleString('id-ID')} <span className="text-xs font-medium">Poin</span>
              </p>
              <p className="text-[11px] text-stone-500 mt-1">
                Senilai {formatRupiah(summaryStats.totalActivePoints * pointValueIdr)} (1 Poin = {formatRupiah(pointValueIdr)})
              </p>
            </div>
          </div>

          {/* Members Leaderboard Table */}
          <div className="bg-white border border-stone-200 rounded-2xl shadow-xs overflow-hidden">
            <div className="p-4 border-b border-stone-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="relative flex-1 max-w-md">
                <Search className="w-4 h-4 text-stone-400 absolute left-3.5 top-2.5" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Cari nama tamu, telepon, atau kode tamu..."
                  className="w-full pl-9 pr-3 py-2 text-xs bg-[#FAF8F3] border border-[#E6DFC8] rounded-xl focus:outline-hidden focus:ring-2 focus:ring-[#1E392A]/20"
                />
              </div>
              <div className="flex items-center space-x-1">
                {(['ALL', 'PLATINUM', 'GOLD', 'SILVER', 'BRONZE'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTierFilter(t)}
                    className={`px-2.5 py-1 text-[11px] font-semibold rounded-lg transition-colors cursor-pointer ${
                      tierFilter === t
                        ? 'bg-[#1E392A] text-white'
                        : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                    }`}
                  >
                    {t === 'ALL' ? 'Semua Tier' : t}
                  </button>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto max-h-[540px] overflow-y-auto">
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 z-10 bg-stone-50 border-b border-stone-200">
                  <tr className="text-[10px] font-bold uppercase tracking-wider text-stone-500">
                    <th className="py-3 px-4">Tamu / Pelanggan</th>
                    <th className="py-3 px-4 text-center">Tier & Diskon</th>
                    <th className="py-3 px-4 text-center">Stay & Malam</th>
                    <th className="py-3 px-4 text-right">Total Spend (Lunas)</th>
                    <th className="py-3 px-4 text-right">Saldo Poin & Nilai</th>
                    <th className="py-3 px-4 text-right">Aksi Poin</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100 text-xs">
                  {filteredGuests.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-10 text-center text-stone-400">
                        Tidak ada data member yang sesuai filter.
                      </td>
                    </tr>
                  ) : (
                    filteredGuests.slice(0, 150).map((g) => {
                      const tier = g.loyalty_tier || 'BRONZE';
                      const pts = Number(g.loyalty_points || 0);
                      const ptsIdr = Math.round(pts * pointValueIdr);
                      const discPct = Number(g.tier_discount_pct || 0);
                      return (
                        <tr key={g.id} className="hover:bg-stone-50/80 transition-colors">
                          <td className="py-3 px-4">
                            <button
                              type="button"
                              onClick={() => onSelectGuest(g.id)}
                              className="text-left group cursor-pointer"
                            >
                              <p className="font-bold text-stone-900 group-hover:text-[#1E392A]">
                                {g.full_name}
                              </p>
                              <p className="text-[10px] text-stone-400">
                                {g.guest_code || `#${g.id}`} {g.phone ? `· ${g.phone}` : ''}
                              </p>
                            </button>
                          </td>
                          <td className="py-3 px-4 text-center">
                            <span
                              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${
                                tier === 'PLATINUM'
                                  ? 'bg-sky-50 text-sky-800 border-sky-200'
                                  : tier === 'GOLD'
                                  ? 'bg-amber-50 text-amber-800 border-amber-200'
                                  : tier === 'SILVER'
                                  ? 'bg-stone-100 text-stone-700 border-stone-200'
                                  : 'bg-orange-50/70 text-amber-900 border-amber-200/60'
                              }`}
                            >
                              {g.loyalty_tier_name || tier}
                            </span>
                            {discPct > 0 && (
                              <span className="block text-[10px] text-emerald-700 font-semibold mt-0.5">
                                Diskon Member {discPct}%
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-center">
                            <span className="font-semibold text-stone-800">{g.visit_count || 0}</span> stay &middot;{' '}
                            <span className="text-stone-600">{g.room_nights || 0} malam</span>
                          </td>
                          <td className="py-3 px-4 text-right font-semibold text-stone-800">
                            {formatRupiah(g.total_spend)}
                          </td>
                          <td className="py-3 px-4 text-right">
                            <span className="px-2.5 py-1 rounded-lg bg-emerald-50 text-[#1E392A] font-bold border border-emerald-200">
                              {pts.toLocaleString('id-ID')} Poin
                            </span>
                            <span className="block text-[10px] text-stone-500 mt-1">
                              Nilai tukar: {formatRupiah(ptsIdr)}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right">
                            <div className="inline-flex items-center space-x-1.5">
                              <button
                                type="button"
                                disabled={pts < minRedeemPoints}
                                onClick={() => openLoyaltyModal(g, 'REDEEM')}
                                className="px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1 cursor-pointer"
                                title={
                                  pts < minRedeemPoints
                                    ? `Minimal penukaran ${minRedeemPoints} poin`
                                    : 'Tukar poin dengan reward/potongan'
                                }
                              >
                                <Gift className="w-3 h-3" />
                                <span>Tukar Poin</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => openLoyaltyModal(g, 'BONUS')}
                                className="px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-700 transition-colors inline-flex items-center gap-1 cursor-pointer"
                              >
                                <PlusCircle className="w-3 h-3" />
                                <span>Bonus</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* SUB-TAB 2: RIWAYAT POIN */}
      {subTab === 'ledger' && (
        <div className="bg-white border border-stone-200 rounded-2xl shadow-xs overflow-hidden">
          <div className="overflow-x-auto max-h-[540px] overflow-y-auto">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 z-10 bg-stone-50 border-b border-stone-200">
                <tr className="text-[10px] font-bold uppercase tracking-wider text-stone-500">
                  <th className="py-3 px-4">Waktu</th>
                  <th className="py-3 px-4">Tamu</th>
                  <th className="py-3 px-4">Tipe</th>
                  <th className="py-3 px-4">Keterangan Reward / Penyesuaian</th>
                  <th className="py-3 px-4">Referensi</th>
                  <th className="py-3 px-4 text-right">Mutasi Poin</th>
                  <th className="py-3 px-4">Petugas</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 text-xs">
                {loadingLedger ? (
                  <tr>
                    <td colSpan={7} className="py-10 text-center text-stone-400">
                      Memuat riwayat mutasi poin...
                    </td>
                  </tr>
                ) : ledger.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-10 text-center text-stone-400">
                      Belum ada riwayat penukaran poin (redeem) atau penambahan poin bonus manual.
                    </td>
                  </tr>
                ) : (
                  ledger.map((row) => (
                    <tr key={row.id} className="hover:bg-stone-50">
                      <td className="py-3 px-4 text-stone-500 font-mono text-[11px]">
                        {String(row.created_at || '').slice(0, 16).replace('T', ' ')}
                      </td>
                      <td className="py-3 px-4 font-semibold text-stone-900">
                        {row.guest_name || `Guest #${row.guest_id}`}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            row.entry_type === 'REDEEM'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-emerald-100 text-emerald-800'
                          }`}
                        >
                          {row.entry_type}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-stone-700">{row.description}</td>
                      <td className="py-3 px-4 font-mono text-[11px] text-stone-500">
                        {row.reference_no || '-'}
                      </td>
                      <td
                        className={`py-3 px-4 text-right font-bold ${
                          row.points < 0 ? 'text-red-600' : 'text-emerald-700'
                        }`}
                      >
                        {row.points > 0 ? `+${row.points}` : row.points} Poin
                      </td>
                      <td className="py-3 px-4 text-stone-500">{row.created_by || '-'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal Redeem / Bonus Poin */}
      {modalOpen && selectedGuest && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4">
          <div className="bg-white rounded-2xl shadow-xl border border-stone-200 w-full max-w-md overflow-hidden">
            <div className="px-5 py-4 bg-[#1E392A] text-white flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold flex items-center gap-2">
                  <Gift className="w-4 h-4" />
                  <span>{entryType === 'REDEEM' ? 'Tukar Poin Loyalitas (Redeem)' : 'Tambah Poin Bonus'}</span>
                </h3>
                <p className="text-[11px] text-stone-300 mt-0.5">
                  {selectedGuest.full_name} &middot; Saldo: <strong>{selectedGuest.loyalty_points || 0} Poin</strong> ({formatRupiah((selectedGuest.loyalty_points || 0) * pointValueIdr)})
                </p>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="text-stone-300 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveEntry} className="p-5 space-y-4 text-xs">
              {entryType === 'REDEEM' && (
                <div>
                  <label className="block font-semibold text-stone-700 mb-1.5">
                    Pilih Katalog Reward Cepat
                  </label>
                  <div className="grid grid-cols-1 gap-1.5">
                    {REWARD_CATALOG.map((item) => (
                      <button
                        key={item.label}
                        type="button"
                        onClick={() => {
                          setDescriptionInput(item.label);
                          setPointsInput(String(item.points));
                        }}
                        className={`p-2.5 rounded-xl border text-left flex items-center justify-between transition-colors cursor-pointer ${
                          descriptionInput === item.label
                            ? 'border-[#1E392A] bg-emerald-50/60 text-stone-900 font-semibold'
                            : 'border-stone-200 hover:bg-stone-50 text-stone-700'
                        }`}
                      >
                        <span>{item.label}</span>
                        <span className="font-bold text-[#1E392A]">{item.points} Poin</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="block font-semibold text-stone-700 mb-1">
                  Jumlah Poin {entryType === 'REDEEM' ? 'Ditukar' : 'Bonus'}
                </label>
                <input
                  type="number"
                  min={1}
                  max={entryType === 'REDEEM' ? Number(selectedGuest.loyalty_points || 0) : 100000}
                  value={pointsInput}
                  onChange={(e) => setPointsInput(e.target.value)}
                  required
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 focus:outline-hidden focus:ring-2 focus:ring-[#1E392A]/20"
                />
                <p className="text-[11px] text-stone-500 mt-1">
                  Setara nilai: <strong>{formatRupiah(Number(pointsInput || 0) * pointValueIdr)}</strong>
                </p>
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">
                  Keterangan / Deskripsi
                </label>
                <input
                  type="text"
                  value={descriptionInput}
                  onChange={(e) => setDescriptionInput(e.target.value)}
                  required
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 focus:outline-hidden focus:ring-2 focus:ring-[#1E392A]/20"
                />
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">
                  No. Referensi BID / POS (Opsional)
                </label>
                <input
                  type="text"
                  value={referenceInput}
                  onChange={(e) => setReferenceInput(e.target.value)}
                  placeholder="Contoh: LWG-261118-... atau TRX-..."
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 focus:outline-hidden focus:ring-2 focus:ring-[#1E392A]/20"
                />
              </div>

              <div className="flex items-center justify-end space-x-2 pt-2 border-t border-stone-200">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="px-3.5 py-1.5 rounded-lg border border-stone-300 text-stone-700 hover:bg-stone-50 font-semibold cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-1.5 rounded-lg bg-[#1E392A] hover:bg-[#162a1f] text-white font-semibold disabled:opacity-50 cursor-pointer"
                >
                  {submitting ? 'Menyimpan...' : entryType === 'REDEEM' ? 'Konfirmasi Tukar Poin' : 'Simpan Poin Bonus'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Pengaturan Loyalty Tier (Ref. Gambar 6) */}
      {isTierModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4">
          <div className="bg-white rounded-3xl shadow-2xl border border-stone-200 w-full max-w-xl max-h-[90vh] flex flex-col overflow-hidden">
            {/* Modal Header */}
            <div className="px-6 py-5 bg-gradient-to-b from-emerald-50/70 to-white border-b border-stone-100 flex items-start justify-between">
              <div>
                <span className="inline-block px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-emerald-100/80 text-emerald-800 rounded-full border border-emerald-200 mb-2">
                  LOYALTY PROGRAM
                </span>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-amber-100/80 border border-amber-200 flex items-center justify-center text-amber-700 shrink-0">
                    <Crown className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-stone-900">
                      Pengaturan Loyalty Tier
                    </h3>
                    <p className="text-xs text-stone-500 mt-0.5">
                      Atur periode loyalty, ambang belanja, dan diskon otomatis agar program member konsisten saat dipakai tim resepsionis & kasir.
                    </p>
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsTierModalOpen(false)}
                className="w-8 h-8 rounded-full border border-stone-200 flex items-center justify-center text-stone-400 hover:text-stone-700 hover:bg-stone-50 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto space-y-4 flex-1">
              {/* Period Selection + Active Mode Info */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 rounded-2xl border border-stone-200 bg-stone-50/50">
                  <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-stone-500 mb-3">
                    <Calendar className="w-3.5 h-3.5" />
                    <span>Periode Perhitungan</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {(
                      [
                        { id: 'CUMULATIVE', label: 'Kumulatif Selamanya' },
                        { id: 'MONTHLY', label: 'Bulanan' },
                        { id: 'QUARTERLY', label: 'Per 3 Bulan' },
                        { id: 'YEARLY', label: 'Tahunan' },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setTierPeriod(opt.id)}
                        className={`p-2.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                          tierPeriod === opt.id
                            ? 'bg-emerald-700 text-white border-emerald-700 shadow-xs'
                            : 'bg-white text-stone-700 border-stone-200 hover:bg-stone-50'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="p-4 rounded-2xl border border-emerald-200 bg-emerald-50/50">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-700">
                    Mode Aktif
                  </p>
                  <p className="text-sm font-bold text-stone-900 mt-1">
                    {tierPeriod === 'CUMULATIVE'
                      ? 'Kumulatif Selamanya'
                      : tierPeriod === 'MONTHLY'
                      ? 'Perhitungan Bulanan'
                      : tierPeriod === 'QUARTERLY'
                      ? 'Perhitungan Per 3 Bulan'
                      : 'Perhitungan Tahunan'}
                  </p>
                  <p className="text-xs text-stone-600 mt-1.5 leading-relaxed">
                    Diskon otomatis mengikuti total belanja pelanggan di periode ini saat dipilih di Reservasi maupun POS.
                  </p>
                </div>
              </div>

              {/* 4 Tier Configuration Cards */}
              {tiersConfig.map((tier, idx) => {
                const cardStyles: Record<LoyaltyTierCode, string> = {
                  BRONZE: 'border-amber-200/80 bg-amber-50/20',
                  SILVER: 'border-stone-200 bg-stone-50/30',
                  GOLD: 'border-amber-300 bg-amber-50/30',
                  PLATINUM: 'border-sky-200 bg-sky-50/20',
                };
                const badgeStyles: Record<LoyaltyTierCode, string> = {
                  BRONZE: 'bg-orange-100 text-amber-900',
                  SILVER: 'bg-stone-200 text-stone-700',
                  GOLD: 'bg-amber-100 text-amber-800',
                  PLATINUM: 'bg-sky-100 text-sky-800',
                };
                return (
                  <div
                    key={tier.code}
                    className={`p-4 rounded-2xl border ${cardStyles[tier.code]} space-y-3`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Award className="w-4 h-4 text-amber-600" />
                        <span className="text-xs font-bold text-stone-900">
                          Tier {idx + 1}
                        </span>
                      </div>
                      <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase ${badgeStyles[tier.code]}`}>
                        {tier.code}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-[10px] font-bold uppercase tracking-wider text-stone-500 mb-1">
                          Nama Tier
                        </label>
                        <input
                          type="text"
                          value={tier.name}
                          onChange={(e) => updateTierRow(tier.code, 'name', e.target.value)}
                          className="w-full px-3 py-2 text-xs font-semibold bg-white border border-stone-200 rounded-xl focus:outline-hidden focus:ring-2 focus:ring-emerald-600/20"
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] font-bold uppercase tracking-wider text-stone-500 mb-1">
                          Min Belanja (Rp)
                        </label>
                        <input
                          type="number"
                          min={0}
                          disabled={tier.code === 'BRONZE'}
                          value={tier.min_spend}
                          onChange={(e) => updateTierRow(tier.code, 'min_spend', e.target.value)}
                          className="w-full px-3 py-2 text-xs font-semibold bg-white disabled:bg-stone-100 border border-stone-200 rounded-xl focus:outline-hidden focus:ring-2 focus:ring-emerald-600/20"
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] font-bold uppercase tracking-wider text-stone-500 mb-1">
                          Diskon (%)
                        </label>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={tier.discount_pct}
                          onChange={(e) => updateTierRow(tier.code, 'discount_pct', e.target.value)}
                          className="w-full px-3 py-2 text-xs font-semibold bg-white border border-stone-200 rounded-xl focus:outline-hidden focus:ring-2 focus:ring-emerald-600/20"
                        />
                      </div>
                    </div>
                  </div>
                );
              })}

              <div className="p-3.5 rounded-2xl border border-blue-200 bg-blue-50/50 flex items-start gap-2.5 text-xs text-stone-700">
                <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
                <span>
                  Tier pelanggan dihitung dari periode yang dipilih, lalu diskon member dapat diterapkan langsung di Reservasi maupun POS.
                </span>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 bg-stone-50 border-t border-stone-200 flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  setTierPeriod('CUMULATIVE');
                  setTiersConfig(DEFAULT_TIERS);
                }}
                className="px-3.5 py-2 rounded-xl border border-stone-300 bg-white hover:bg-stone-100 text-xs font-semibold text-stone-700 flex items-center gap-1.5 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset Default</span>
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsTierModalOpen(false)}
                  className="px-4 py-2 rounded-xl border border-stone-200 bg-stone-100 hover:bg-stone-200 text-xs font-semibold text-stone-700 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="button"
                  disabled={savingTierModal}
                  onClick={handleSaveTierModal}
                  className="px-5 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold shadow-xs disabled:opacity-50 cursor-pointer"
                >
                  {savingTierModal ? 'Menyimpan...' : 'Simpan'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
