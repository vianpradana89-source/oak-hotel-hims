import React, { useMemo, useState } from 'react';
import {
  Crown,
  Download,
  GitMerge,
  MessageCircle,
  Pencil,
  Search,
  SlidersHorizontal,
  UserPlus,
  X,
} from 'lucide-react';
import type {
  BehavioralSegment,
  Guest,
  PropertyLoyaltySettings,
} from './guestTypes';
import {
  filterGuestsBySegment,
  filterGuestsBySearch,
  deriveBehavioralSegment,
} from './guestCrmHelpers';
import { renderWaTemplate } from './GuestCrmSummaryPanel';
import { authenticatedFetch } from '../../lib/authenticatedFetch';

interface GuestDatabaseTableProps {
  propertyId?: number | null;
  propertyName?: string;
  guests: Guest[];
  loading: boolean;
  hotelDate: string;
  loyaltySettings?: PropertyLoyaltySettings | null;
  onSelectGuest: (guestId: number) => void;
  onEditGuest: (guest: Guest) => void;
  onCreateGuest: () => void;
  onMerged?: () => void;
  onOpenWaTemplateModal?: (target: 'birthday' | 'followup' | 'database') => void;
}

type SortOption = 'SPEND_DESC' | 'VISITS_DESC' | 'POINTS_DESC' | 'RECENT_STAY';

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

export const GuestDatabaseTable: React.FC<GuestDatabaseTableProps> = ({
  propertyId,
  propertyName = 'OAK Hotel Lawang',
  guests,
  loading,
  hotelDate,
  loyaltySettings,
  onSelectGuest,
  onEditGuest,
  onCreateGuest,
  onMerged,
  onOpenWaTemplateModal,
}) => {
  const [search, setSearch] = useState<string>('');
  const [segment, setSegment] = useState<BehavioralSegment>('SEMUA');
  const [sortBy, setSortBy] = useState<SortOption>('SPEND_DESC');
  const [page, setPage] = useState<number>(1);
  const pageSize = 25;

  // Manual merge state
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [isMergeModalOpen, setIsMergeModalOpen] = useState<boolean>(false);
  const [primaryGuestId, setPrimaryGuestId] = useState<number | null>(null);
  const [merging, setMerging] = useState<boolean>(false);
  const [mergeFeedback, setMergeFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const filteredGuests = useMemo(() => {
    const bySeg = filterGuestsBySegment(guests, segment, hotelDate);
    const list = filterGuestsBySearch(bySeg, search);
    return [...list].sort((a, b) => {
      if (sortBy === 'SPEND_DESC') {
        return Number(b.total_spend || 0) - Number(a.total_spend || 0) || Number(b.visit_count || 0) - Number(a.visit_count || 0);
      }
      if (sortBy === 'VISITS_DESC') {
        return Number(b.visit_count || 0) - Number(a.visit_count || 0) || Number(b.total_spend || 0) - Number(a.total_spend || 0);
      }
      if (sortBy === 'POINTS_DESC') {
        return Number(b.loyalty_points || 0) - Number(a.loyalty_points || 0) || Number(b.total_spend || 0) - Number(a.total_spend || 0);
      }
      const aDate = a.last_stay || a.updated_at || '';
      const bDate = b.last_stay || b.updated_at || '';
      return String(bDate).localeCompare(String(aDate));
    });
  }, [guests, search, segment, hotelDate, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filteredGuests.length / pageSize));
  const currentPage = Math.min(page, totalPages);

  const paginatedGuests = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredGuests.slice(start, start + pageSize);
  }, [filteredGuests, currentPage, pageSize]);

  const selectedGuests = useMemo(
    () => guests.filter((g) => selectedIds.includes(g.id)),
    [guests, selectedIds]
  );

  const toggleSelectGuest = (id: number) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const openManualMergeModal = () => {
    if (selectedGuests.length < 2) return;
    const sorted = [...selectedGuests].sort(
      (a, b) => Number(b.visit_count || 0) - Number(a.visit_count || 0) || a.id - b.id
    );
    setPrimaryGuestId(sorted[0].id);
    setMergeFeedback(null);
    setIsMergeModalOpen(true);
  };

  const handleExecuteManualMerge = async () => {
    if (!propertyId || !primaryGuestId || selectedIds.length < 2) return;
    const duplicateIds = selectedIds.filter((id) => id !== primaryGuestId);
    setMerging(true);
    setMergeFeedback(null);
    try {
      const res = await authenticatedFetch('/api/guests/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          primary_guest_id: primaryGuestId,
          duplicate_guest_ids: duplicateIds,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.message || 'Gagal menggabungkan data pelanggan.');
      }
      setIsMergeModalOpen(false);
      setSelectedIds([]);
      setMergeFeedback({
        type: 'success',
        text: `Berhasil menggabungkan ${duplicateIds.length} profil duplikat ke Master #${primaryGuestId} (${json.data?.primary_guest?.full_name || ''}).`,
      });
      if (onMerged) onMerged();
    } catch (err: unknown) {
      setMergeFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal menggabungkan data pelanggan.',
      });
    } finally {
      setMerging(false);
    }
  };

  const handleSendDatabaseWa = (guest: Guest) => {
    const wa = normalizeWaPhone(guest.phone);
    if (!wa) return;
    const tpl =
      loyaltySettings?.wa_database_message ||
      'Halo {nama}, terima kasih telah menjadi pelanggan setia {toko}. Hubungi kami untuk reservasi kamar atau promo terbaru!';
    const text = renderWaTemplate(tpl, {
      nama: guest.full_name,
      toko: propertyName,
      terakhir: formatIndoShortDate(guest.last_stay),
      total: formatRupiah(guest.total_spend),
      ulangtahun: formatIndoShortDate(guest.birth_date),
    });
    window.open(`https://wa.me/${wa}?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
  };

  const handleExportCsv = () => {
    const headers = [
      'Kode Tamu',
      'Nama Lengkap',
      'Telepon',
      'Email',
      'NIK / Identitas',
      'Kota',
      'Status VIP',
      'Tier Loyalitas',
      'Total Kunjungan',
      'Total Malam',
      'Total Spend (Rp)',
      'Poin Loyalitas Aktif',
      'Stay Terakhir',
    ];
    const rows = filteredGuests.map((g) => [
      g.guest_code || `GST-${String(g.id).padStart(5, '0')}`,
      `"${String(g.full_name || '').replace(/"/g, '""')}"`,
      `"${String(g.phone || '').replace(/"/g, '""')}"`,
      `"${String(g.email || '').replace(/"/g, '""')}"`,
      `"${String(g.identity_number || '').replace(/"/g, '""')}"`,
      `"${String(g.city || '').replace(/"/g, '""')}"`,
      g.vip_status || 'STANDARD',
      g.loyalty_tier_name || g.loyalty_tier || 'Bronze',
      Number(g.visit_count || 0),
      Number(g.room_nights || 0),
      Math.round(Number(g.total_spend || 0)),
      Number(g.loyalty_points || 0),
      g.last_stay || '',
    ]);
    const csvContent =
      '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Database-Pelanggan-CRM-${hotelDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="bg-white border border-stone-200 rounded-2xl shadow-xs flex flex-col">
      {/* Card Header (Ref. Gambar 4) */}
      <div className="px-5 py-4 border-b border-stone-100 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center space-x-2">
          <Crown className="w-4 h-4 text-blue-600" />
          <h3 className="text-sm font-bold text-stone-900">
            Database Pelanggan ({filteredGuests.length})
          </h3>
        </div>

        <div className="flex items-center flex-wrap gap-2">
          {selectedIds.length >= 2 && (
            <button
              type="button"
              onClick={openManualMergeModal}
              className="px-3 py-1.5 bg-amber-800 hover:bg-amber-900 text-white text-xs font-semibold rounded-lg transition-colors shadow-xs flex items-center gap-1.5 cursor-pointer"
            >
              <GitMerge className="w-3.5 h-3.5" />
              <span>Gabungkan ({selectedIds.length}) Customer</span>
            </button>
          )}
          {selectedIds.length > 0 && (
            <button
              type="button"
              onClick={() => setSelectedIds([])}
              className="px-2.5 py-1.5 bg-stone-100 hover:bg-stone-200 text-stone-600 text-xs font-medium rounded-lg transition-colors cursor-pointer"
            >
              Reset Pilihan
            </button>
          )}
          <button
            type="button"
            onClick={handleExportCsv}
            className="px-3 py-1.5 bg-stone-100 hover:bg-stone-200 text-stone-700 text-xs font-semibold rounded-lg transition-colors border border-stone-200 flex items-center gap-1.5 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export CSV</span>
          </button>
          <button
            type="button"
            onClick={onCreateGuest}
            className="px-3 py-1.5 bg-[#1E392A] hover:bg-[#162a1f] text-white text-xs font-semibold rounded-lg transition-colors shadow-xs flex items-center gap-1.5 cursor-pointer"
          >
            <UserPlus className="w-3.5 h-3.5" />
            <span>Tamu Baru</span>
          </button>
          {onOpenWaTemplateModal && (
            <button
              type="button"
              onClick={() => onOpenWaTemplateModal('database')}
              className="p-1.5 text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded-lg transition-colors cursor-pointer"
              title="Atur Template Pesan WhatsApp Pelanggan"
            >
              <SlidersHorizontal className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Search & Dropdown Filters (Ref. Gambar 4) */}
      <div className="px-5 py-3.5 border-b border-stone-100 flex flex-col md:flex-row items-stretch md:items-center gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-stone-400 absolute left-3.5 top-2.5" />
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Cari nama, telepon, email, atau NIK..."
            className="w-full pl-9 pr-8 py-2 text-xs bg-[#FAF8F3] border border-[#E6DFC8] rounded-xl focus:outline-hidden focus:ring-2 focus:ring-[#1E392A]/20 focus:border-[#1E392A]"
          />
          {search && (
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setPage(1);
              }}
              className="absolute right-2.5 top-2.5 text-stone-400 hover:text-stone-600 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2.5">
          <select
            value={segment}
            onChange={(e) => {
              setSegment(e.target.value as BehavioralSegment);
              setPage(1);
            }}
            className="px-3.5 py-2 text-xs font-medium text-stone-700 bg-[#FAF8F3] border border-[#E6DFC8] rounded-xl focus:outline-hidden focus:ring-2 focus:ring-[#1E392A]/20 cursor-pointer"
          >
            <option value="SEMUA">Semua Segmen ({guests.length})</option>
            <option value="VIP">VIP</option>
            <option value="VVIP">VVIP</option>
            <option value="REPEAT">Repeat Guest</option>
            <option value="BARU">Pelanggan Baru</option>
            <option value="TIDAK_AKTIF">Tidak Aktif (&gt;90h)</option>
          </select>

          <select
            value={sortBy}
            onChange={(e) => {
              setSortBy(e.target.value as SortOption);
              setPage(1);
            }}
            className="px-3.5 py-2 text-xs font-medium text-stone-700 bg-[#FAF8F3] border border-[#E6DFC8] rounded-xl focus:outline-hidden focus:ring-2 focus:ring-[#1E392A]/20 cursor-pointer"
          >
            <option value="SPEND_DESC">Belanja Tertinggi</option>
            <option value="VISITS_DESC">Kunjungan Terbanyak</option>
            <option value="POINTS_DESC">Poin Tertinggi</option>
            <option value="RECENT_STAY">Terbaru Menginap</option>
          </select>
        </div>
      </div>

      {mergeFeedback && (
        <div
          className={`mx-5 mt-3 p-3 rounded-lg border text-xs font-medium flex items-center justify-between ${
            mergeFeedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          <span>{mergeFeedback.text}</span>
          <button
            type="button"
            onClick={() => setMergeFeedback(null)}
            className="text-[11px] underline ml-3 cursor-pointer"
          >
            Tutup
          </button>
        </div>
      )}

      {/* Table Content (Ref. Gambar 4) */}
      <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
        <table className="w-full text-left border-collapse">
          <thead className="sticky top-0 z-10 bg-white border-b border-stone-100">
            <tr className="text-[11px] font-semibold text-stone-400">
              <th className="py-3 px-4 w-10 text-center">
                <input
                  type="checkbox"
                  checked={
                    paginatedGuests.length > 0 &&
                    paginatedGuests.every((g) => selectedIds.includes(g.id))
                  }
                  onChange={(e) => {
                    if (e.target.checked) {
                      const pageIds = paginatedGuests.map((g) => g.id);
                      setSelectedIds((prev) => Array.from(new Set([...prev, ...pageIds])));
                    } else {
                      const pageIds = new Set(paginatedGuests.map((g) => g.id));
                      setSelectedIds((prev) => prev.filter((id) => !pageIds.has(id)));
                    }
                  }}
                  className="rounded border-stone-300 text-[#1E392A] focus:ring-[#1E392A] cursor-pointer"
                  title="Pilih semua di halaman ini untuk digabungkan"
                />
              </th>
              <th className="py-3 px-4">Pelanggan</th>
              <th className="py-3 px-4">Segmen</th>
              <th className="py-3 px-4 text-center">Kunjungan</th>
              <th className="py-3 px-4 text-right">Total Belanja</th>
              <th className="py-3 px-4 text-right">Terakhir</th>
              <th className="py-3 px-4 text-center">Aksi</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100 text-xs">
            {loading ? (
              [1, 2, 3, 4, 5].map((i) => (
                <tr key={i} className="animate-pulse">
                  <td className="py-3.5 px-4"><div className="h-3 bg-stone-200 rounded w-4 mx-auto"></div></td>
                  <td className="py-3.5 px-4"><div className="h-3.5 bg-stone-200 rounded w-36"></div></td>
                  <td className="py-3.5 px-4"><div className="h-3.5 bg-stone-200 rounded w-20"></div></td>
                  <td className="py-3.5 px-4"><div className="h-3.5 bg-stone-200 rounded w-10 mx-auto"></div></td>
                  <td className="py-3.5 px-4"><div className="h-3.5 bg-stone-200 rounded w-24 ml-auto"></div></td>
                  <td className="py-3.5 px-4"><div className="h-3.5 bg-stone-200 rounded w-20 ml-auto"></div></td>
                  <td className="py-3.5 px-4"><div className="h-3.5 bg-stone-200 rounded w-12 mx-auto"></div></td>
                </tr>
              ))
            ) : paginatedGuests.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-12 text-center text-stone-400">
                  <p className="font-medium text-stone-600">Tidak ada pelanggan ditemukan</p>
                  <p className="text-[11px] mt-0.5">
                    Coba sesuaikan kata kunci pencarian atau filter segmen di atas.
                  </p>
                </td>
              </tr>
            ) : (
              paginatedGuests.map((guest) => {
                const behavior = deriveBehavioralSegment(guest, hotelDate);
                const isChecked = selectedIds.includes(guest.id);
                const hasWa = Boolean(normalizeWaPhone(guest.phone));
                const points = Number(guest.loyalty_points || 0);

                return (
                  <tr
                    key={guest.id}
                    onClick={() => onSelectGuest(guest.id)}
                    className={`hover:bg-stone-50/90 transition-colors cursor-pointer group ${
                      isChecked ? 'bg-amber-50/40' : ''
                    }`}
                  >
                    {/* Checkbox for Merge */}
                    <td
                      className="py-3.5 px-4 text-center"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleSelectGuest(guest.id)}
                        className="rounded border-stone-300 text-[#1E392A] focus:ring-[#1E392A] cursor-pointer"
                      />
                    </td>

                    {/* Pelanggan (Name + Phone below, matching Gambar 4) */}
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-stone-900 group-hover:text-[#1E392A] transition-colors">
                        {guest.full_name}
                      </div>
                      <div className="text-[11px] text-stone-400 mt-0.5">
                        {guest.phone || guest.email || guest.guest_code || `#${guest.id}`}
                      </div>
                    </td>

                    {/* Segmen / Tier Badges */}
                    <td className="py-3.5 px-4">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {guest.vip_status && guest.vip_status !== 'STANDARD' && (
                          <span className="px-2.5 py-0.5 text-[10px] font-bold rounded-full bg-amber-50 text-amber-700 border border-amber-200/80">
                            {guest.vip_status}
                          </span>
                        )}
                        {guest.loyalty_tier && guest.loyalty_tier !== 'BRONZE' && (
                          <span
                            className={`px-2 py-0.5 text-[10px] font-semibold rounded-full ${
                              guest.loyalty_tier === 'PLATINUM'
                                ? 'bg-sky-50 text-sky-700 border border-sky-200'
                                : guest.loyalty_tier === 'GOLD'
                                ? 'bg-amber-50 text-amber-800 border border-amber-200'
                                : 'bg-stone-100 text-stone-700 border border-stone-200'
                            }`}
                          >
                            {guest.loyalty_tier_name || guest.loyalty_tier}
                          </span>
                        )}
                        {behavior === 'TIDAK_AKTIF' ? (
                          <span className="px-2.5 py-0.5 text-[10px] font-medium rounded-full bg-stone-100 text-stone-600">
                            Tidak Aktif
                          </span>
                        ) : behavior === 'REPEAT' ? (
                          <span className="px-2.5 py-0.5 text-[10px] font-medium rounded-full bg-emerald-50 text-emerald-700">
                            Repeat
                          </span>
                        ) : behavior === 'BARU' ? (
                          <span className="px-2.5 py-0.5 text-[10px] font-medium rounded-full bg-sky-50 text-sky-700">
                            Baru
                          </span>
                        ) : (
                          guest.vip_status === 'STANDARD' && (
                            <span className="px-2.5 py-0.5 text-[10px] font-medium rounded-full bg-stone-100 text-stone-600">
                              Reguler
                            </span>
                          )
                        )}
                      </div>
                    </td>

                    {/* Kunjungan */}
                    <td className="py-3.5 px-4 text-center font-medium text-stone-700">
                      {guest.visit_count ?? 0}
                    </td>

                    {/* Total Belanja + Poin */}
                    <td className="py-3.5 px-4 text-right">
                      <span className="font-semibold text-stone-800">
                        {formatRupiah(guest.total_spend)}
                      </span>
                      {points > 0 && (
                        <span className="block text-[10px] font-semibold text-emerald-700 mt-0.5">
                          {points.toLocaleString('id-ID')} Poin
                        </span>
                      )}
                    </td>

                    {/* Terakhir */}
                    <td className="py-3.5 px-4 text-right text-stone-500">
                      {formatIndoShortDate(guest.last_stay)}
                    </td>

                    {/* Aksi (Lucide MessageCircle & Pencil Icons) */}
                    <td
                      className="py-3.5 px-4 text-center"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="inline-flex items-center justify-center gap-1.5">
                        <button
                          type="button"
                          disabled={!hasWa}
                          onClick={() => handleSendDatabaseWa(guest)}
                          className={`p-1.5 rounded-lg transition-colors ${
                            hasWa
                              ? 'text-stone-600 hover:text-[#1E392A] hover:bg-stone-100 cursor-pointer'
                              : 'text-stone-300 cursor-not-allowed'
                          }`}
                          title={hasWa ? `Hubungi ${guest.full_name} via WhatsApp` : 'Nomor telepon tidak tersedia'}
                        >
                          <MessageCircle className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onEditGuest(guest)}
                          className="p-1.5 rounded-lg text-stone-500 hover:text-stone-900 hover:bg-stone-100 transition-colors cursor-pointer"
                          title="Edit Profil Pelanggan"
                        >
                          <Pencil className="w-3.5 h-3.5" />
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

      {/* Pagination Footer */}
      {filteredGuests.length > 0 && (
        <div className="px-5 py-3 border-t border-stone-100 bg-stone-50/40 flex items-center justify-between text-xs text-stone-600 rounded-b-2xl">
          <div>
            Menampilkan{' '}
            <span className="font-semibold text-stone-800">
              {(currentPage - 1) * pageSize + 1}
            </span>{' '}
            –{' '}
            <span className="font-semibold text-stone-800">
              {Math.min(currentPage * pageSize, filteredGuests.length)}
            </span>{' '}
            dari{' '}
            <span className="font-semibold text-stone-800">
              {filteredGuests.length}
            </span>{' '}
            pelanggan
          </div>

          <div className="flex items-center space-x-1.5">
            <button
              disabled={currentPage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="px-2.5 py-1 rounded border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-40 disabled:cursor-not-allowed text-stone-700 font-medium transition-colors cursor-pointer"
            >
              Sebelumnya
            </button>
            <span className="px-2 font-medium text-stone-700">
              Hal {currentPage} / {totalPages}
            </span>
            <button
              disabled={currentPage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="px-2.5 py-1 rounded border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-40 disabled:cursor-not-allowed text-stone-700 font-medium transition-colors cursor-pointer"
            >
               Berikutnya
            </button>
          </div>
        </div>
      )}

      {/* Manual Merge Modal */}
      {isMergeModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4">
          <div className="bg-white rounded-2xl shadow-xl border border-stone-200 w-full max-w-lg overflow-hidden">
            <div className="px-5 py-4 bg-[#1E392A] text-white flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold flex items-center gap-2">
                  <GitMerge className="w-4 h-4" />
                  <span>Gabungkan Data Customer ({selectedGuests.length} Profil)</span>
                </h3>
                <p className="text-[11px] text-stone-300 mt-0.5">
                  Pilih 1 profil sebagai Master. Seluruh reservasi, transaksi, dan poin akan digabungkan ke Master.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsMergeModalOpen(false)}
                className="text-stone-300 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-3 max-h-96 overflow-y-auto">
              {selectedGuests.map((g) => {
                const isPrimary = primaryGuestId === g.id;
                return (
                  <label
                    key={g.id}
                    onClick={() => setPrimaryGuestId(g.id)}
                    className={`flex items-start justify-between p-3 rounded-xl border cursor-pointer transition-all ${
                      isPrimary
                        ? 'border-[#1E392A] bg-emerald-50/50 ring-1 ring-[#1E392A]'
                        : 'border-stone-200 hover:bg-stone-50'
                    }`}
                  >
                    <div className="flex items-start space-x-2.5">
                      <input
                        type="radio"
                        checked={isPrimary}
                        onChange={() => setPrimaryGuestId(g.id)}
                        className="mt-0.5 text-[#1E392A] focus:ring-[#1E392A]"
                      />
                      <div>
                        <div className="flex items-center space-x-2">
                          <span className="text-xs font-bold text-stone-900">{g.full_name}</span>
                          <span className="text-[10px] font-mono text-stone-500">#{g.id}</span>
                          {isPrimary && (
                            <span className="px-1.5 py-0.5 text-[9px] font-bold bg-[#1E392A] text-white rounded">
                              PROFIL MASTER
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-stone-600 mt-0.5">
                          HP: {g.phone || '-'} &middot; Email: {g.email || '-'} &middot; NIK: {g.identity_number || '-'}
                        </p>
                        <p className="text-[10px] text-stone-500 mt-0.5">
                          {g.visit_count || 0} stay &middot; Spend: {formatRupiah(g.total_spend)} &middot; {g.loyalty_points || 0} Poin
                        </p>
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>

            <div className="px-5 py-3 bg-stone-50 border-t border-stone-200 flex items-center justify-end space-x-2">
              <button
                type="button"
                onClick={() => setIsMergeModalOpen(false)}
                className="px-3.5 py-1.5 rounded-lg border border-stone-300 bg-white text-stone-700 text-xs font-semibold hover:bg-stone-100 cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={merging || !primaryGuestId}
                onClick={handleExecuteManualMerge}
                className="px-4 py-1.5 rounded-lg bg-[#1E392A] hover:bg-[#162a1f] text-white text-xs font-semibold disabled:opacity-50 cursor-pointer"
              >
                {merging ? 'Menggabungkan...' : `Konfirmasi Merger ke Master #${primaryGuestId}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
