import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Guest, GuestLoyaltyLedgerEntry } from './guestTypes';
import { formatDateIndonesian, getVipBadgeClass } from './guestCrmHelpers';
import { authenticatedFetch } from '../../lib/authenticatedFetch';

interface GuestLoyaltyPanelProps {
  propertyId: number;
  guests: Guest[];
  onRefreshGuests: () => void;
  onSelectGuest: (guestId: number) => void;
}

const REWARD_PRESETS = [
  { label: 'Free Late Check-Out (2 Jam)', points: 50 },
  { label: 'Voucher F&B / Breakfast Gratis', points: 75 },
  { label: 'Potongan Kamar Rp 50.000', points: 100 },
  { label: 'Free Upgrade Tipe Kamar', points: 200 },
  { label: 'Voucher Menginap 1 Malam Standard', points: 500 },
];

function formatIdr(val: number): string {
  return 'Rp ' + Math.round(Number(val || 0)).toLocaleString('id-ID');
}

function getTierBadge(tier?: string) {
  switch (tier) {
    case 'PLATINUM':
      return {
        label: '💎 Platinum',
        cls: 'bg-purple-100 text-purple-900 border-purple-300 font-bold'
      };
    case 'GOLD':
      return {
        label: '🥇 Gold',
        cls: 'bg-amber-100 text-amber-900 border-amber-300 font-bold'
      };
    default:
      return {
        label: '🥈 Silver',
        cls: 'bg-stone-100 text-stone-700 border-stone-300 font-medium'
      };
  }
}

export const GuestLoyaltyPanel: React.FC<GuestLoyaltyPanelProps> = ({
  propertyId,
  guests,
  onRefreshGuests,
  onSelectGuest
}) => {
  const [subView, setSubView] = useState<'members' | 'ledger'>('members');
  const [tierFilter, setTierFilter] = useState<'ALL' | 'PLATINUM' | 'GOLD' | 'SILVER'>('ALL');
  const [search, setSearch] = useState<string>('');
  const [ledger, setLedger] = useState<GuestLoyaltyLedgerEntry[]>([]);
  const [loadingLedger, setLoadingLedger] = useState<boolean>(false);
  const [syncingVip, setSyncingVip] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Modal state for Redeem / Bonus
  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [modalGuest, setModalGuest] = useState<Guest | null>(null);
  const [modalType, setModalType] = useState<'REDEEM' | 'BONUS'>('REDEEM');
  const [pointsInput, setPointsInput] = useState<string>('50');
  const [descInput, setDescInput] = useState<string>('');
  const [refInput, setRefInput] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);

  const loadLedger = useCallback(async () => {
    if (!propertyId) return;
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

  const activeGuests = useMemo(
    () => guests.filter((g) => !g.is_archived),
    [guests]
  );

  const stats = useMemo(() => {
    let membersWithPoints = 0;
    let platinumCount = 0;
    let goldCount = 0;
    let silverCount = 0;
    let totalActivePoints = 0;
    let totalRedeemedPoints = 0;

    for (const g of activeGuests) {
      const pts = Number(g.loyalty_points || 0);
      const red = Number(g.redeemed_points || 0);
      if (pts > 0 || red > 0) membersWithPoints++;
      totalActivePoints += pts;
      totalRedeemedPoints += red;
      if (g.loyalty_tier === 'PLATINUM') platinumCount++;
      else if (g.loyalty_tier === 'GOLD') goldCount++;
      else silverCount++;
    }

    return {
      membersWithPoints,
      platinumCount,
      goldCount,
      silverCount,
      totalActivePoints,
      totalRedeemedPoints
    };
  }, [activeGuests]);

  const filteredMembers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...activeGuests]
      .filter((g) => {
        if (tierFilter !== 'ALL' && (g.loyalty_tier || 'SILVER') !== tierFilter) return false;
        if (!q) return true;
        return (
          (g.full_name || '').toLowerCase().includes(q) ||
          (g.phone || '').toLowerCase().includes(q) ||
          (g.guest_code || '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const diffPts = Number(b.loyalty_points || 0) - Number(a.loyalty_points || 0);
        if (diffPts !== 0) return diffPts;
        return Number(b.total_spend || 0) - Number(a.total_spend || 0);
      });
  }, [activeGuests, tierFilter, search]);

  const handleOpenModal = (guest: Guest, type: 'REDEEM' | 'BONUS') => {
    setModalGuest(guest);
    setModalType(type);
    if (type === 'REDEEM') {
      setPointsInput('50');
      setDescInput('Free Late Check-Out (2 Jam)');
    } else {
      setPointsInput('50');
      setDescInput('Bonus Poin Apresiasi Tamu');
    }
    setRefInput('');
    setModalOpen(true);
  };

  const handleSubmitLedger = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modalGuest) return;
    const pts = Math.round(Number(pointsInput || 0));
    if (!pts || pts <= 0) {
      setFeedback({ type: 'error', message: 'Masukkan jumlah poin lebih dari 0.' });
      return;
    }
    if (!descInput.trim()) {
      setFeedback({ type: 'error', message: 'Keterangan wajib diisi.' });
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
          guest_id: modalGuest.id,
          entry_type: modalType,
          points: pts,
          description: descInput.trim(),
          reference_no: refInput.trim() || null
        })
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.message || 'Gagal menyimpan transaksi poin.');
      }
      setModalOpen(false);
      setFeedback({
        type: 'success',
        message:
          modalType === 'REDEEM'
            ? `Berhasil menukarkan ${pts} poin untuk ${modalGuest.full_name} (${descInput.trim()}).`
            : `Berhasil menambahkan ${pts} poin bonus untuk ${modalGuest.full_name}.`
      });
      onRefreshGuests();
      loadLedger();
    } catch (err: any) {
      setFeedback({
        type: 'error',
        message: err?.message || 'Gagal menyimpan poin loyalitas.'
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSyncVip = async () => {
    setSyncingVip(true);
    setFeedback(null);
    try {
      const res = await authenticatedFetch('/api/guests/loyalty-sync-vip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId })
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.message || 'Gagal menyinkronkan status VIP.');
      }
      const updated = json.data?.updated_count || 0;
      setFeedback({
        type: 'success',
        message:
          updated > 0
            ? `Berhasil menaikkan status VIP/VVIP untuk ${updated} tamu sesuai Tier Loyalitas (Gold -> VIP, Platinum -> VVIP).`
            : 'Seluruh status VIP/VVIP tamu sudah sesuai dengan Tier Loyalitas masing-masing.'
      });
      onRefreshGuests();
    } catch (err: any) {
      setFeedback({
        type: 'error',
        message: err?.message || 'Gagal menyinkronkan status VIP.'
      });
    } finally {
      setSyncingVip(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Loyalty Rule Banner */}
      <div className="bg-[#1E392A] text-white rounded-lg p-4 shadow-xs flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center space-x-2">
            <span className="text-lg">🎁</span>
            <h3 className="text-sm font-bold tracking-wide">
              Program Poin Loyalitas & Membership OAK HIMS
            </h3>
          </div>
          <p className="text-xs text-emerald-100/90">
            Poin otomatis dihitung hanya dari transaksi <strong>Kamar & POS yang sudah LUNAS (PAID)</strong>, tidak Batal, dan tidak Complimentary:
            <strong> 1 Poin / Rp 10.000</strong> belanja lunas + <strong>10 Poin / malam menginap</strong>.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-1 text-[11px] text-emerald-200">
            <span>🥈 <strong>Silver:</strong> &lt; 5 malam / &lt; 500 poin</span>
            <span>•</span>
            <span>🥇 <strong>Gold (VIP):</strong> &ge; 5 malam atau &ge; 500 poin</span>
            <span>•</span>
            <span>💎 <strong>Platinum (VVIP):</strong> &ge; 15 malam atau &ge; 1.500 poin</span>
          </div>
        </div>
        <button
          onClick={handleSyncVip}
          disabled={syncingVip}
          className="px-3.5 py-2 bg-amber-400 hover:bg-amber-300 text-stone-900 text-xs font-bold rounded-md shadow-xs transition-colors whitespace-nowrap"
        >
          {syncingVip ? 'Menyinkronkan...' : '⚡ Sinkronkan Tier ke Status VIP'}
        </button>
      </div>

      {feedback && (
        <div
          className={`p-3 rounded-lg text-xs font-medium flex items-center justify-between border ${
            feedback.type === 'success'
              ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
              : 'bg-red-50 text-red-800 border-red-200'
          }`}
        >
          <span>{feedback.message}</span>
          <button onClick={() => setFeedback(null)} className="underline ml-4">
            Tutup
          </button>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-stone-200 rounded-lg p-4 shadow-xs">
          <div className="text-xs font-medium text-stone-500 uppercase">Member Berpoin</div>
          <div className="mt-2 text-2xl font-bold text-stone-900">
            {stats.membersWithPoints.toLocaleString('id-ID')}
          </div>
          <div className="mt-1 text-xs text-stone-500">
            Dari {activeGuests.length} total profil aktif
          </div>
        </div>

        <div className="bg-white border border-stone-200 rounded-lg p-4 shadow-xs">
          <div className="text-xs font-medium text-stone-500 uppercase">Total Poin Aktif</div>
          <div className="mt-2 text-2xl font-bold text-[#1E392A]">
            {stats.totalActivePoints.toLocaleString('id-ID')} <span className="text-sm font-medium">Poin</span>
          </div>
          <div className="mt-1 text-xs text-emerald-700 font-medium">
            Siap ditukarkan reward / voucher
          </div>
        </div>

        <div className="bg-white border border-stone-200 rounded-lg p-4 shadow-xs">
          <div className="text-xs font-medium text-stone-500 uppercase">Poin Ditukarkan (Redeem)</div>
          <div className="mt-2 text-2xl font-bold text-amber-800">
            {stats.totalRedeemedPoints.toLocaleString('id-ID')} <span className="text-sm font-medium">Poin</span>
          </div>
          <div className="mt-1 text-xs text-stone-500">
            {ledger.filter((l) => l.points < 0).length} transaksi penukaran
          </div>
        </div>

        <div className="bg-white border border-stone-200 rounded-lg p-4 shadow-xs">
          <div className="text-xs font-medium text-stone-500 uppercase">Distribusi Tier</div>
          <div className="mt-2 flex items-center space-x-3 text-xs font-bold">
            <span className="px-2 py-1 rounded bg-purple-100 text-purple-900">
              💎 {stats.platinumCount}
            </span>
            <span className="px-2 py-1 rounded bg-amber-100 text-amber-900">
              🥇 {stats.goldCount}
            </span>
            <span className="px-2 py-1 rounded bg-stone-100 text-stone-700">
              🥈 {stats.silverCount}
            </span>
          </div>
          <div className="mt-1.5 text-xs text-stone-500">
            Platinum • Gold • Silver
          </div>
        </div>
      </div>

      {/* Main Content Card */}
      <div className="bg-white border border-stone-200 rounded-lg shadow-xs overflow-hidden">
        {/* Top Bar */}
        <div className="p-4 border-b border-stone-200 bg-stone-50/60 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex items-center space-x-2">
            <button
              onClick={() => setSubView('members')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                subView === 'members'
                  ? 'bg-[#1E392A] text-white'
                  : 'bg-white text-stone-700 border border-stone-200 hover:bg-stone-100'
              }`}
            >
              🏆 Leaderboard & Saldo Poin ({filteredMembers.length})
            </button>
            <button
              onClick={() => setSubView('ledger')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                subView === 'ledger'
                  ? 'bg-[#1E392A] text-white'
                  : 'bg-white text-stone-700 border border-stone-200 hover:bg-stone-100'
              }`}
            >
              📜 Riwayat Redeem & Bonus Poin ({ledger.length})
            </button>
          </div>

          {subView === 'members' && (
            <div className="flex flex-wrap items-center gap-2">
              {(['ALL', 'PLATINUM', 'GOLD', 'SILVER'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTierFilter(t)}
                  className={`px-2.5 py-1 text-xs rounded-full border font-medium transition-colors ${
                    tierFilter === t
                      ? 'bg-[#1E392A] text-white border-[#1E392A]'
                      : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-100'
                  }`}
                >
                  {t === 'ALL' ? 'Semua Tier' : t}
                </button>
              ))}
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cari nama atau telepon..."
                className="text-xs px-3 py-1.5 bg-white border border-stone-300 rounded-md outline-none focus:border-[#1E392A] w-56"
              />
            </div>
          )}
        </div>

        {/* Members Leaderboard Table */}
        {subView === 'members' ? (
          <div className="overflow-x-auto max-h-[540px]">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="sticky top-0 z-10 bg-stone-100 text-stone-700 font-semibold uppercase tracking-wider border-b border-stone-200">
                <tr>
                  <th className="py-3 px-4 bg-stone-100">Tamu</th>
                  <th className="py-3 px-3 bg-stone-100">Tier Loyalitas</th>
                  <th className="py-3 px-3 bg-stone-100">Status VIP</th>
                  <th className="py-3 px-3 text-center bg-stone-100">Stay (Lunas)</th>
                  <th className="py-3 px-3 text-right bg-stone-100">Total Transaksi (Lunas)</th>
                  <th className="py-3 px-3 text-right bg-stone-100">Poin Perolehan</th>
                  <th className="py-3 px-3 text-right bg-stone-100">Bonus / Redeem</th>
                  <th className="py-3 px-3 text-right bg-stone-100">Saldo Poin Aktif</th>
                  <th className="py-3 px-4 text-right bg-stone-100">Aksi Loyalitas</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 text-stone-800">
                {filteredMembers.slice(0, 150).map((g) => {
                  const tierBadge = getTierBadge(g.loyalty_tier);
                  const vipBadge = getVipBadgeClass(g.vip_status);
                  const activePts = Number(g.loyalty_points || 0);
                  const earnedPts = Number(g.earned_points || 0);
                  const bonusPts = Number(g.bonus_points || 0);
                  const redeemedPts = Number(g.redeemed_points || 0);

                  return (
                    <tr key={g.id} className="hover:bg-stone-50/80 transition-colors">
                      <td className="py-3 px-4">
                        <button
                          onClick={() => onSelectGuest(g.id)}
                          className="font-bold text-stone-900 hover:text-[#1E392A] text-left"
                        >
                          {g.full_name}
                        </button>
                        <div className="text-[11px] text-stone-500">
                          {g.phone || '—'} {g.guest_code ? `• ${g.guest_code}` : ''}
                        </div>
                      </td>
                      <td className="py-3 px-3">
                        <span className={`text-[11px] px-2 py-0.5 rounded border ${tierBadge.cls}`}>
                          {tierBadge.label}
                        </span>
                      </td>
                      <td className="py-3 px-3">
                        <span
                          className={`text-[11px] px-2 py-0.5 rounded-full border ${vipBadge.bg} ${vipBadge.border} ${vipBadge.text}`}
                        >
                          {vipBadge.label}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-center">
                        <div className="font-semibold text-stone-900">{g.visit_count ?? 0}x</div>
                        <div className="text-[11px] text-stone-500">{g.room_nights ?? 0} malam</div>
                      </td>
                      <td className="py-3 px-3 text-right font-semibold text-stone-900 tabular-nums">
                        {formatIdr(Number(g.total_spend || 0))}
                      </td>
                      <td className="py-3 px-3 text-right font-medium text-emerald-800 tabular-nums">
                        +{earnedPts.toLocaleString('id-ID')}
                      </td>
                      <td className="py-3 px-3 text-right tabular-nums text-[11px]">
                        {bonusPts > 0 && (
                          <span className="text-sky-700 font-medium mr-1">+{bonusPts}</span>
                        )}
                        {redeemedPts > 0 && (
                          <span className="text-amber-800 font-medium">-{redeemedPts}</span>
                        )}
                        {bonusPts === 0 && redeemedPts === 0 && <span className="text-stone-400">0</span>}
                      </td>
                      <td className="py-3 px-3 text-right">
                        <span className="text-sm font-bold text-[#1E392A] tabular-nums">
                          {activePts.toLocaleString('id-ID')}
                        </span>
                        <span className="text-[10px] text-stone-500 ml-1">poin</span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end space-x-1.5">
                          <button
                            onClick={() => handleOpenModal(g, 'REDEEM')}
                            disabled={activePts <= 0}
                            className="px-2.5 py-1 text-xs bg-amber-700 hover:bg-amber-800 disabled:opacity-40 text-white font-semibold rounded transition-colors"
                            title="Tukar Poin dengan Reward / Diskon"
                          >
                            🎁 Tukar Poin
                          </button>
                          <button
                            onClick={() => handleOpenModal(g, 'BONUS')}
                            className="px-2 py-1 text-xs bg-stone-100 hover:bg-stone-200 text-stone-700 font-semibold rounded border border-stone-300 transition-colors"
                            title="Tambah Poin Bonus Manual"
                          >
                            + Bonus
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          /* Point Ledger History Table */
          <div className="overflow-x-auto max-h-[540px]">
            {loadingLedger ? (
              <div className="p-12 text-center text-stone-500 text-xs">Memuat riwayat buku besar poin...</div>
            ) : ledger.length === 0 ? (
              <div className="p-12 text-center text-stone-400 text-xs">
                Belum ada riwayat penukaran (redeem) atau penambahan poin bonus manual.
              </div>
            ) : (
              <table className="w-full text-left text-xs border-collapse">
                <thead className="sticky top-0 z-10 bg-stone-100 text-stone-700 font-semibold uppercase tracking-wider border-b border-stone-200">
                  <tr>
                    <th className="py-3 px-4 bg-stone-100">Tanggal</th>
                    <th className="py-3 px-3 bg-stone-100">Tamu</th>
                    <th className="py-3 px-3 bg-stone-100">Tipe</th>
                    <th className="py-3 px-3 bg-stone-100">Keterangan Reward / Bonus</th>
                    <th className="py-3 px-3 bg-stone-100">No. Referensi</th>
                    <th className="py-3 px-3 text-right bg-stone-100">Mutasi Poin</th>
                    <th className="py-3 px-4 bg-stone-100">Petugas</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100 text-stone-800">
                  {ledger.map((item) => (
                    <tr key={item.id} className="hover:bg-stone-50">
                      <td className="py-3 px-4 text-stone-600">
                        {formatDateIndonesian(item.created_at)}
                      </td>
                      <td className="py-3 px-3 font-bold text-stone-900">
                        {item.guest_name || `Tamu #${item.guest_id}`}
                      </td>
                      <td className="py-3 px-3">
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded font-bold ${
                            item.points < 0
                              ? 'bg-amber-100 text-amber-900'
                              : 'bg-emerald-100 text-emerald-900'
                          }`}
                        >
                          {item.entry_type}
                        </span>
                      </td>
                      <td className="py-3 px-3">{item.description}</td>
                      <td className="py-3 px-3 font-mono text-stone-500">
                        {item.reference_no || '—'}
                      </td>
                      <td
                        className={`py-3 px-3 text-right font-bold tabular-nums ${
                          item.points < 0 ? 'text-amber-800' : 'text-emerald-700'
                        }`}
                      >
                        {item.points > 0 ? `+${item.points}` : item.points} Poin
                      </td>
                      <td className="py-3 px-4 text-stone-500">{item.created_by || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* Modal Tukar Poin / Tambah Bonus */}
      {modalOpen && modalGuest && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div className="bg-white rounded-xl shadow-2xl border border-stone-200 w-full max-w-md overflow-hidden">
            <div className="px-5 py-4 border-b border-stone-200 bg-stone-50 flex items-center justify-between">
              <div>
                <h4 className="text-sm font-bold text-stone-900">
                  {modalType === 'REDEEM'
                    ? '🎁 Tukar Poin Loyalitas (Redeem Reward)'
                    : '✨ Tambah Poin Bonus Tamu'}
                </h4>
                <p className="text-xs text-stone-500">
                  {modalGuest.full_name} • Saldo Aktif:{' '}
                  <strong className="text-[#1E392A]">
                    {Number(modalGuest.loyalty_points || 0).toLocaleString('id-ID')} Poin
                  </strong>
                </p>
              </div>
              <button
                onClick={() => setModalOpen(false)}
                className="text-stone-400 hover:text-stone-700"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmitLedger} className="p-5 space-y-4 text-xs">
              {modalType === 'REDEEM' && (
                <div>
                  <label className="block font-semibold text-stone-700 mb-1.5">
                    Pilih Katalog Reward Cepat:
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {REWARD_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => {
                          setPointsInput(String(preset.points));
                          setDescInput(preset.label);
                        }}
                        className="px-2 py-1 rounded border border-stone-200 bg-stone-50 hover:bg-emerald-50 hover:border-[#1E392A] text-stone-700 text-[11px] transition-colors"
                      >
                        {preset.label} (<strong>{preset.points}p</strong>)
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="block font-semibold text-stone-700 mb-1">
                  Jumlah Poin {modalType === 'REDEEM' ? 'yang Ditukarkan' : 'Bonus'}
                </label>
                <input
                  type="number"
                  min={1}
                  max={modalType === 'REDEEM' ? Number(modalGuest.loyalty_points || 1) : 100000}
                  value={pointsInput}
                  onChange={(e) => setPointsInput(e.target.value)}
                  className="w-full px-3 py-2 border border-stone-300 rounded-md text-sm font-bold outline-none focus:border-[#1E392A]"
                  required
                />
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">
                  Keterangan {modalType === 'REDEEM' ? 'Reward / Voucher' : 'Bonus'}
                </label>
                <input
                  type="text"
                  value={descInput}
                  onChange={(e) => setDescInput(e.target.value)}
                  placeholder="Contoh: Voucher Diskon Kamar / Free Late Check-Out"
                  className="w-full px-3 py-2 border border-stone-300 rounded-md outline-none focus:border-[#1E392A]"
                  required
                />
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">
                  Nomor Referensi / BID (Opsional)
                </label>
                <input
                  type="text"
                  value={refInput}
                  onChange={(e) => setRefInput(e.target.value)}
                  placeholder="Contoh: LWG-261118-..."
                  className="w-full px-3 py-2 border border-stone-300 rounded-md outline-none focus:border-[#1E392A]"
                />
              </div>

              <div className="pt-2 flex justify-end space-x-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="px-4 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 font-semibold rounded-md"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 bg-[#1E392A] hover:bg-[#162a1f] text-white font-semibold rounded-md"
                >
                  {submitting
                    ? 'Menyimpan...'
                    : modalType === 'REDEEM'
                    ? 'Konfirmasi Tukar Poin'
                    : 'Simpan Poin Bonus'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
