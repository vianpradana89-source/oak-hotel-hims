import React, { useState } from 'react';
import type {
  GuestCrmSummary,
  GuestCrmBirthdayItem,
  GuestCrmFollowUpItem
} from './guestTypes';
import { formatDateIndonesian, getVipBadgeClass } from './guestCrmHelpers';

interface GuestCrmSummaryPanelProps {
  summary: GuestCrmSummary | null;
  loading: boolean;
  onSelectGuest: (guestId: number) => void;
  onOpenDuplicateReview: () => void;
  duplicateCount: number;
}

function formatWaLink(phoneRaw: string | null | undefined, message: string): string | null {
  if (!phoneRaw) return null;
  let digits = String(phoneRaw).replace(/\D/g, '');
  if (!digits || digits.length < 7) return null;
  if (digits.startsWith('0')) {
    digits = '62' + digits.slice(1);
  }
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

function formatIdr(val: number): string {
  return 'Rp ' + Math.round(Number(val || 0)).toLocaleString('id-ID');
}

export const GuestCrmSummaryPanel: React.FC<GuestCrmSummaryPanelProps> = ({
  summary,
  loading,
  onSelectGuest,
  onOpenDuplicateReview,
  duplicateCount
}) => {
  const [reactivationDays, setReactivationDays] = useState<30 | 60 | 90>(30);

  if (loading && !summary) {
    return (
      <div className="flex items-center justify-center p-12 text-stone-500">
        <div className="flex items-center space-x-3">
          <div className="w-5 h-5 border-2 border-[#1E392A] border-t-transparent rounded-full animate-spin" />
          <span>Memuat ringkasan CRM...</span>
        </div>
      </div>
    );
  }

  const s = summary || {
    property_id: 0,
    hotel_date: '',
    total_guests: 0,
    guests_with_qualifying_stay: 0,
    repeat_guests: 0,
    repeat_rate: 0,
    new_guests_last_30d: 0,
    dormant_guests_30d: 0,
    dormant_guests_60d: 0,
    dormant_guests_90d: 0,
    total_customer_revenue: 0,
    avg_customer_ltv: 0,
    birthdays_this_month: [],
    follow_up_candidates: []
  };

  const filteredFollowUps = (s.follow_up_candidates || []).filter(
    (item) => Number(item.days_since_last_stay || 0) >= reactivationDays
  );

  const activeDormantCount =
    reactivationDays === 30
      ? s.dormant_guests_30d ?? filteredFollowUps.length
      : reactivationDays === 60
      ? s.dormant_guests_60d ?? filteredFollowUps.length
      : s.dormant_guests_90d ?? filteredFollowUps.length;

  return (
    <div className="space-y-6">
      {/* Top Notification / Action Banner for Duplicates */}
      {duplicateCount > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-center justify-between shadow-xs">
          <div className="flex items-center space-x-3">
            <span className="flex items-center justify-center w-8 h-8 rounded-full bg-amber-100 text-amber-800 font-bold text-sm">
              !
            </span>
            <div>
              <h4 className="text-sm font-semibold text-amber-900">
                Terdeteksi {duplicateCount} Kluster Duplikat Potensial
              </h4>
              <p className="text-xs text-amber-700">
                Terdapat profil tamu dengan kesamaan nomor telepon, email, atau nama & tanggal lahir. Klik Review Duplikat untuk menggabungkan ke Profil Utama (Master).
              </p>
            </div>
          </div>
          <button
            onClick={onOpenDuplicateReview}
            className="px-3.5 py-1.5 bg-amber-800 hover:bg-amber-900 text-white text-xs font-semibold rounded shadow-xs transition-colors"
          >
            Review & Merge Duplikat
          </button>
        </div>
      )}

      {/* CRM Metric Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        {/* Card 1: Total Pelanggan */}
        <div className="bg-white border border-stone-200 rounded-lg p-4 shadow-xs">
          <div className="text-xs font-medium text-stone-500 uppercase tracking-wider">
            Total Pelanggan
          </div>
          <div className="mt-2 text-2xl font-bold text-stone-900">
            {s.total_guests.toLocaleString('id-ID')}
          </div>
          <div className="mt-1 text-xs text-stone-500">
            Terhubung dengan properti ini
          </div>
        </div>

        {/* Card 2: Pelanggan Repeat */}
        <div className="bg-white border border-stone-200 rounded-lg p-4 shadow-xs">
          <div className="text-xs font-medium text-stone-500 uppercase tracking-wider">
            Pelanggan Repeat
          </div>
          <div className="mt-2 text-2xl font-bold text-emerald-800">
            {s.repeat_guests.toLocaleString('id-ID')}
          </div>
          <div className="mt-1 text-xs text-emerald-600 font-medium">
            {s.repeat_rate}% repeat rate ({s.guests_with_qualifying_stay} tamu menginap)
          </div>
        </div>

        {/* Card 3: Pelanggan Baru 30 Hari */}
        <div className="bg-white border border-stone-200 rounded-lg p-4 shadow-xs">
          <div className="text-xs font-medium text-stone-500 uppercase tracking-wider">
            Pelanggan Baru (30 Hari)
          </div>
          <div className="mt-2 text-2xl font-bold text-sky-800">
            {s.new_guests_last_30d.toLocaleString('id-ID')}
          </div>
          <div className="mt-1 text-xs text-stone-500">
            Stay perdana dalam 30 hari
          </div>
        </div>

        {/* Card 4: Perlu Reaktivasi (Synchronized with Filter) */}
        <div className="bg-white border border-stone-200 rounded-lg p-4 shadow-xs">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-stone-500 uppercase tracking-wider">
              Perlu Reaktivasi
            </div>
            <div className="flex items-center space-x-1">
              {([30, 60, 90] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setReactivationDays(d)}
                  className={`text-[10px] px-1.5 py-0.5 rounded font-semibold transition-colors ${
                    reactivationDays === d
                      ? 'bg-amber-800 text-white'
                      : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                  }`}
                >
                  {d}h
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2 text-2xl font-bold text-amber-800">
            {activeDormantCount.toLocaleString('id-ID')}
          </div>
          <div className="mt-1 text-xs text-stone-500">
            Tidak menginap &ge; {reactivationDays} hari
          </div>
        </div>

        {/* Card 5: Nilai Pelanggan (Customer Lifetime Value) */}
        <div className="bg-white border border-stone-200 rounded-lg p-4 shadow-xs">
          <div className="text-xs font-medium text-stone-500 uppercase tracking-wider">
            Nilai Pelanggan (LTV)
          </div>
          <div className="mt-2 text-lg font-bold text-[#1E392A] truncate" title={formatIdr(s.total_customer_revenue || 0)}>
            {formatIdr(s.total_customer_revenue || 0)}
          </div>
          <div className="mt-1 text-xs text-stone-500">
            Rata-rata {formatIdr(s.avg_customer_ltv || 0)} / tamu
          </div>
        </div>
      </div>

      {/* Operational Split Panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Panel: Ulang Tahun Bulan Ini */}
        <div className="bg-white border border-stone-200 rounded-lg shadow-xs flex flex-col">
          <div className="p-4 border-b border-stone-100 flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <span className="w-2.5 h-2.5 rounded-full bg-pink-500"></span>
              <h3 className="text-sm font-bold text-stone-800">
                Ulang Tahun Bulan Ini ({s.birthdays_this_month?.length || 0})
              </h3>
            </div>
            <span className="text-xs text-stone-500 font-medium">
              Sorted by Day
            </span>
          </div>

          <div className="p-4 flex-1 max-h-96 overflow-y-auto">
            {s.birthdays_this_month && s.birthdays_this_month.length > 0 ? (
              <div className="divide-y divide-stone-100">
                {s.birthdays_this_month.map((item: GuestCrmBirthdayItem) => {
                  const vipBadge = getVipBadgeClass(item.vip_status);
                  const waUrl = formatWaLink(
                    item.phone,
                    `Halo Bapak/Ibu ${item.full_name}, Keluarga Besar OAK Hotel mengucapkan Selamat Ulang Tahun! Semoga sehat, bahagia, dan sukses selalu. Kami menantikan kunjungan Anda kembali di OAK Hotel.`
                  );
                  return (
                    <div
                      key={item.id}
                      className="py-3 flex items-center justify-between hover:bg-stone-50 px-2 rounded transition-colors"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center space-x-2">
                          <span className="font-semibold text-sm text-stone-900">
                            {item.full_name}
                          </span>
                          {item.vip_status !== 'STANDARD' && (
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded border ${vipBadge.bg} ${vipBadge.border} ${vipBadge.text}`}
                            >
                              {vipBadge.label}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-stone-500 flex items-center space-x-3">
                          <span>🎂 Tgl {item.birth_day}</span>
                          {item.phone && <span>📞 {item.phone}</span>}
                          {item.email && <span>✉️ {item.email}</span>}
                        </div>
                      </div>
                      <div className="flex items-center space-x-1.5">
                        {waUrl && (
                          <a
                            href={waUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-2 py-1 text-xs bg-emerald-50 text-emerald-700 hover:bg-emerald-100 font-medium rounded border border-emerald-200 transition-colors"
                            title="Kirim Ucapan Ulang Tahun via WhatsApp"
                          >
                            💬 WA
                          </a>
                        )}
                        <button
                          onClick={() => onSelectGuest(item.id)}
                          className="px-2.5 py-1 text-xs text-[#1E392A] hover:bg-[#1E392A]/10 font-medium rounded border border-[#1E392A]/20 transition-colors"
                        >
                          Profil
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-10 text-xs text-stone-400">
                Tidak ada data ulang tahun tamu di bulan ini
              </div>
            )}
          </div>
        </div>

        {/* Right Panel: Rekomendasi Follow Up / Reaktivasi */}
        <div className="bg-white border border-stone-200 rounded-lg shadow-xs flex flex-col">
          <div className="p-4 border-b border-stone-100 flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-500"></span>
              <h3 className="text-sm font-bold text-stone-800">
                Kandidat Follow Up & Reaktivasi ({filteredFollowUps.length})
              </h3>
            </div>
            <div className="flex items-center space-x-1">
              {([30, 60, 90] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setReactivationDays(d)}
                  className={`text-[11px] px-2 py-0.5 rounded font-medium transition-colors ${
                    reactivationDays === d
                      ? 'bg-[#1E392A] text-white'
                      : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                  }`}
                >
                  &ge; {d} Hari
                </button>
              ))}
            </div>
          </div>

          <div className="p-4 flex-1 max-h-96 overflow-y-auto">
            {filteredFollowUps.length > 0 ? (
              <div className="divide-y divide-stone-100">
                {filteredFollowUps.map((item: GuestCrmFollowUpItem) => {
                  const vipBadge = getVipBadgeClass(item.vip_status);
                  const waUrl = formatWaLink(
                    item.phone,
                    `Halo Bapak/Ibu ${item.full_name}, semoga sehat selalu! Kami merindukan kehadiran Anda kembali di OAK Hotel. Dapatkan penawaran spesial untuk reservasi Anda berikutnya bersama kami.`
                  );
                  return (
                    <div
                      key={item.id}
                      className="py-3 flex items-center justify-between hover:bg-stone-50 px-2 rounded transition-colors"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center space-x-2 flex-wrap gap-y-1">
                          <span className="font-semibold text-sm text-stone-900">
                            {item.full_name}
                          </span>
                          {item.vip_status !== 'STANDARD' && (
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded border ${vipBadge.bg} ${vipBadge.border} ${vipBadge.text}`}
                            >
                              {vipBadge.label}
                            </span>
                          )}
                          <span className="text-[10px] bg-stone-100 text-stone-600 px-1.5 py-0.5 rounded">
                            {item.visit_count} kunjungan
                          </span>
                          {Number(item.total_spend || 0) > 0 && (
                            <span className="text-[10px] bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded font-medium">
                              {formatIdr(Number(item.total_spend || 0))}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-stone-500 flex items-center space-x-3">
                          <span className="text-amber-800 font-medium">
                            ⏱️ {item.days_since_last_stay} hari lalu ({formatDateIndonesian(item.last_stay)})
                          </span>
                          {item.phone && <span>📞 {item.phone}</span>}
                        </div>
                      </div>
                      <div className="flex items-center space-x-1.5">
                        {waUrl && (
                          <a
                            href={waUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-2 py-1 text-xs bg-emerald-50 text-emerald-700 hover:bg-emerald-100 font-medium rounded border border-emerald-200 transition-colors"
                            title="Follow Up Reaktivasi via WhatsApp"
                          >
                            💬 WA
                          </a>
                        )}
                        <button
                          onClick={() => onSelectGuest(item.id)}
                          className="px-2.5 py-1 text-xs text-[#1E392A] hover:bg-[#1E392A]/10 font-medium rounded border border-[#1E392A]/20 transition-colors"
                        >
                          Profil
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-10 text-xs text-stone-400">
                Tidak ada kandidat follow-up (&ge; {reactivationDays} hari tidak menginap)
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
