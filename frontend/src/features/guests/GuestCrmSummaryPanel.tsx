import React, { useState, useEffect } from 'react';
import {
  AlertTriangle,
  Cake,
  Clock,
  MessageCircle,
  SlidersHorizontal,
  Users,
  Repeat,
  UserPlus,
  UserCheck,
  Wallet,
} from 'lucide-react';
import type {
  GuestCrmSummary,
  GuestCrmBirthdayItem,
  GuestCrmFollowUpItem,
  PropertyLoyaltySettings,
} from './guestTypes';

interface GuestCrmSummaryPanelProps {
  summary: GuestCrmSummary | null;
  loading: boolean;
  loyaltySettings: PropertyLoyaltySettings | null;
  propertyName?: string;
  onSelectGuest: (guestId: number) => void;
  onOpenDuplicateReview: () => void;
  duplicateCount: number;
  onOpenWaTemplateModal: (target: 'birthday' | 'followup' | 'database') => void;
}

function normalizeWaPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length < 8) return null;
  if (digits.startsWith('0')) {
    digits = '62' + digits.slice(1);
  } else if (!digits.startsWith('62') && digits.startsWith('8')) {
    digits = '62' + digits;
  }
  return digits;
}

function formatRupiah(val: number | undefined | null): string {
  const num = Number(val || 0);
  return `Rp ${Math.round(num).toLocaleString('id-ID')}`;
}

function formatIndoShortDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '-';
  const clean = String(dateStr).slice(0, 10);
  const parts = clean.split('-');
  if (parts.length !== 3) return clean;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const mIdx = Number(parts[1]) - 1;
  return `${parts[2]} ${months[mIdx] || parts[1]} ${parts[0]}`;
}

export function renderWaTemplate(
  template: string,
  vars: {
    nama: string;
    toko: string;
    terakhir?: string;
    total?: string;
    ulangtahun?: string;
  }
): string {
  return String(template || '')
    .replace(/\{nama\}/gi, vars.nama || 'Pelanggan')
    .replace(/\{toko\}/gi, vars.toko || 'OAK Hotel Lawang')
    .replace(/\{terakhir\}/gi, vars.terakhir || '-')
    .replace(/\{total\}/gi, vars.total || 'Rp 0')
    .replace(/\{ulangtahun\}/gi, vars.ulangtahun || '-');
}

export const GuestCrmSummaryPanel: React.FC<GuestCrmSummaryPanelProps> = ({
  summary,
  loading,
  loyaltySettings,
  propertyName = 'OAK Hotel Lawang',
  onSelectGuest,
  onOpenDuplicateReview,
  duplicateCount,
  onOpenWaTemplateModal,
}) => {
  const [followUpDays, setFollowUpDays] = useState<number>(
    loyaltySettings?.followup_threshold_days || 90
  );

  useEffect(() => {
    if (loyaltySettings?.followup_threshold_days) {
      setFollowUpDays(loyaltySettings.followup_threshold_days);
    }
  }, [loyaltySettings?.followup_threshold_days]);

  if (loading && !summary) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="bg-white border border-stone-200 rounded-xl p-4 h-24 animate-pulse">
              <div className="h-3 bg-stone-200 rounded w-1/2 mb-3"></div>
              <div className="h-6 bg-stone-200 rounded w-1/3"></div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!summary) return null;

  const allFollowUpCandidates = summary.follow_up_candidates || [];
  const filteredFollowUpList = allFollowUpCandidates.filter(
    (item) => Number(item.days_since_last_stay || 0) >= Math.max(1, followUpDays)
  );

  const dormantCountForSelectedWindow = filteredFollowUpList.length;
  const totalRevenue = Number(summary.total_customer_revenue || 0);
  const avgLtv = Number(summary.avg_customer_ltv || 0);

  const handleSendBirthdayWa = (item: GuestCrmBirthdayItem) => {
    const wa = normalizeWaPhone(item.phone);
    if (!wa) return;
    const tpl =
      loyaltySettings?.wa_birthday_message ||
      'Selamat ulang tahun {nama}! 🎉 Ada hadiah spesial dari {toko} untuk Anda.';
    const text = renderWaTemplate(tpl, {
      nama: item.full_name,
      toko: propertyName,
      ulangtahun: formatIndoShortDate(item.birth_date),
    });
    window.open(`https://wa.me/${wa}?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
  };

  const handleSendFollowUpWa = (item: GuestCrmFollowUpItem) => {
    const wa = normalizeWaPhone(item.phone);
    if (!wa) return;
    const tpl =
      loyaltySettings?.wa_followup_message ||
      'Halo {nama}, apa kabar? Kami dari {toko} merindukan kunjungan Anda sejak {terakhir}. Dapatkan promo spesial untuk kunjungan berikutnya!';
    const text = renderWaTemplate(tpl, {
      nama: item.full_name,
      toko: propertyName,
      terakhir: formatIndoShortDate(item.last_stay),
      total: formatRupiah(item.total_spend),
    });
    window.open(`https://wa.me/${wa}?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="space-y-5">
      {/* Duplicate Warning Banner */}
      {duplicateCount > 0 && (
        <div className="bg-amber-50/90 border border-amber-200 rounded-xl p-3.5 flex items-center justify-between shadow-xs">
          <div className="flex items-center space-x-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-100 text-amber-800">
              <AlertTriangle className="w-4 h-4" />
            </span>
            <div>
              <h4 className="text-xs font-bold text-amber-900">
                Terdeteksi {duplicateCount} Kluster Duplikat Potensial
              </h4>
              <p className="text-[11px] text-amber-700">
                Terdapat profil tamu dengan kesamaan nomor telepon, email, atau nama & tanggal lahir. Gabungkan ke profil Master secara aman.
              </p>
            </div>
          </div>
          <button
            onClick={onOpenDuplicateReview}
            className="px-3.5 py-1.5 bg-amber-800 hover:bg-amber-900 text-white text-xs font-semibold rounded-lg transition-colors shadow-xs cursor-pointer"
          >
            Review & Merger Duplikat
          </button>
        </div>
      )}

      {/* 5 Summary KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {/* Card 1: Total Pelanggan */}
        <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
              Total Pelanggan
            </p>
            <Users className="w-4 h-4 text-stone-400" />
          </div>
          <p className="text-2xl font-bold text-stone-900 mt-1">
            {summary.total_guests.toLocaleString('id-ID')}
          </p>
          <p className="text-[11px] text-stone-500 mt-1">
            Terhubung dengan properti ini
          </p>
        </div>

        {/* Card 2: Pelanggan Repeat */}
        <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
              Pelanggan Repeat
            </p>
            <Repeat className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="flex items-baseline space-x-2 mt-1">
            <p className="text-2xl font-bold text-[#1E392A]">
              {summary.repeat_guests.toLocaleString('id-ID')}
            </p>
          </div>
          <p className="text-[11px] text-emerald-700 font-medium mt-1">
            {summary.repeat_rate}% repeat rate ({summary.guests_with_qualifying_stay} tamu menginap)
          </p>
        </div>

        {/* Card 3: Pelanggan Baru (30 Hari) */}
        <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
              Pelanggan Baru (30 Hari)
            </p>
            <UserPlus className="w-4 h-4 text-sky-600" />
          </div>
          <p className="text-2xl font-bold text-sky-800 mt-1">
            {summary.new_guests_last_30d.toLocaleString('id-ID')}
          </p>
          <p className="text-[11px] text-stone-500 mt-1">
            Profil baru dalam 30 hari terakhir
          </p>
        </div>

        {/* Card 4: Perlu Reaktivasi */}
        <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
              Perlu Reaktivasi
            </p>
            <UserCheck className="w-4 h-4 text-amber-600" />
          </div>
          <p className="text-2xl font-bold text-amber-700 mt-1">
            {dormantCountForSelectedWindow.toLocaleString('id-ID')}
          </p>
          <p className="text-[11px] text-stone-500 mt-1">
            Tidak menginap &ge; {followUpDays} hari
          </p>
        </div>

        {/* Card 5: Nilai Pelanggan (LTV) */}
        <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
              Nilai Pelanggan (LTV)
            </p>
            <Wallet className="w-4 h-4 text-[#1E392A]" />
          </div>
          <p className="text-lg font-bold text-[#1E392A] mt-1.5 truncate" title={formatRupiah(totalRevenue)}>
            {formatRupiah(totalRevenue)}
          </p>
          <p className="text-[11px] text-stone-500 mt-1">
            Rata-rata {formatRupiah(avgLtv)} / tamu menginap
          </p>
        </div>
      </div>

      {/* Actionable Two-Column Grid: Birthdays & Follow-Up Candidates (Ref. Gambar 2 & 4) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Birthdays This Month */}
        <div className="bg-white border border-stone-200 rounded-2xl shadow-xs flex flex-col">
          <div className="px-5 py-4 border-b border-stone-100 flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Cake className="w-4 h-4 text-blue-600" />
              <h3 className="text-sm font-bold text-stone-900">
                Ulang Tahun Bulan Ini ({summary.birthdays_this_month.length})
              </h3>
            </div>
            <button
              type="button"
              onClick={() => onOpenWaTemplateModal('birthday')}
              className="p-1.5 text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded-lg transition-colors cursor-pointer"
              title="Atur Template Pesan Ucapan Ulang Tahun"
            >
              <SlidersHorizontal className="w-4 h-4" />
            </button>
          </div>

          <div className="divide-y divide-stone-100 max-h-80 overflow-y-auto px-2">
            {summary.birthdays_this_month.length === 0 ? (
              <div className="p-8 text-center text-stone-400 text-xs">
                Tidak ada tamu yang tercatat berulang tahun pada bulan ini.
              </div>
            ) : (
              summary.birthdays_this_month.map((item) => {
                const hasWa = Boolean(normalizeWaPhone(item.phone));
                return (
                  <div
                    key={item.id}
                    className="px-3 py-3 hover:bg-stone-50/80 flex items-center justify-between gap-3 transition-colors rounded-lg"
                  >
                    <button
                      type="button"
                      onClick={() => onSelectGuest(item.id)}
                      className="min-w-0 text-left flex-1 cursor-pointer group"
                    >
                      <div className="flex items-center space-x-1.5">
                        <p className="text-xs font-semibold text-stone-900 group-hover:text-[#1E392A] truncate">
                          {item.full_name}
                        </p>
                        {item.vip_status !== 'STANDARD' && (
                          <span className="px-1.5 py-0.2 text-[9px] font-bold rounded bg-amber-100 text-amber-800">
                            {item.vip_status}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-stone-400 mt-0.5">
                        {formatIndoShortDate(item.birth_date)}
                        {item.phone ? ` · ${item.phone}` : ''}
                      </p>
                    </button>

                    <button
                      type="button"
                      disabled={!hasWa}
                      onClick={() => handleSendBirthdayWa(item)}
                      className={`px-3.5 py-1.5 text-xs font-semibold rounded-xl border flex items-center gap-2 transition-all shrink-0 ${
                        hasWa
                          ? 'bg-[#FAF8F3] hover:bg-[#F1EDE2] text-stone-800 border-[#E6DFC8] shadow-2xs cursor-pointer'
                          : 'bg-stone-100 text-stone-400 border-stone-200 cursor-not-allowed opacity-60'
                      }`}
                      title={hasWa ? `Kirim ucapan ulang tahun ke ${item.full_name}` : 'Nomor telepon tidak tersedia'}
                    >
                      <MessageCircle className="w-3.5 h-3.5 text-stone-700" />
                      <span>Ucapkan</span>
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Follow-up & Reactivation Candidates */}
        <div className="bg-white border border-stone-200 rounded-2xl shadow-xs flex flex-col">
          <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between gap-2">
            <div className="flex items-center space-x-2">
              <Clock className="w-4 h-4 text-blue-600" />
              <h3 className="text-sm font-bold text-stone-900">
                Perlu Follow Up (&gt; {followUpDays} hari) &middot; {filteredFollowUpList.length}
              </h3>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={followUpDays}
                  onChange={(e) => setFollowUpDays(Math.max(1, Number(e.target.value || 1)))}
                  className="w-16 px-2.5 py-1 text-xs font-semibold text-stone-800 bg-[#FAF8F3] border border-[#E6DFC8] rounded-lg text-center focus:outline-hidden focus:ring-2 focus:ring-[#1E392A]/20"
                />
                <span className="text-xs text-stone-400">hari</span>
              </div>
              <button
                type="button"
                onClick={() => onOpenWaTemplateModal('followup')}
                className="p-1.5 text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded-lg transition-colors cursor-pointer"
                title="Atur Template Pesan Follow Up"
              >
                <SlidersHorizontal className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="divide-y divide-stone-100 max-h-80 overflow-y-auto px-2">
            {filteredFollowUpList.length === 0 ? (
              <div className="p-8 text-center text-stone-400 text-xs">
                Tidak ada kandidat follow-up (&gt; {followUpDays} hari sejak checkout terakhir).
              </div>
            ) : (
              filteredFollowUpList.map((item) => {
                const hasWa = Boolean(normalizeWaPhone(item.phone));
                return (
                  <div
                    key={item.id}
                    className="px-3 py-3 hover:bg-stone-50/80 flex items-center justify-between gap-3 transition-colors rounded-lg"
                  >
                    <button
                      type="button"
                      onClick={() => onSelectGuest(item.id)}
                      className="min-w-0 text-left flex-1 cursor-pointer group"
                    >
                      <div className="flex items-center space-x-1.5">
                        <p className="text-xs font-semibold text-stone-900 group-hover:text-[#1E392A] truncate">
                          {item.full_name}
                        </p>
                        {item.vip_status !== 'STANDARD' && (
                          <span className="px-1.5 py-0.2 text-[9px] font-bold rounded bg-amber-100 text-amber-800">
                            {item.vip_status}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-stone-400 mt-0.5">
                        Terakhir: {formatIndoShortDate(item.last_stay)} &middot; {item.days_since_last_stay} hari &middot; {formatRupiah(item.total_spend)}
                      </p>
                    </button>

                    <button
                      type="button"
                      disabled={!hasWa}
                      onClick={() => handleSendFollowUpWa(item)}
                      className={`px-3.5 py-1.5 text-xs font-semibold rounded-xl border flex items-center gap-2 transition-all shrink-0 ${
                        hasWa
                          ? 'bg-[#FAF8F3] hover:bg-[#F1EDE2] text-stone-800 border-[#E6DFC8] shadow-2xs cursor-pointer'
                          : 'bg-stone-100 text-stone-400 border-stone-200 cursor-not-allowed opacity-60'
                      }`}
                      title={hasWa ? `Hubungi ${item.full_name} via WhatsApp` : 'Nomor telepon tidak tersedia'}
                    >
                      <MessageCircle className="w-3.5 h-3.5 text-stone-700" />
                      <span>Hubungi</span>
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
