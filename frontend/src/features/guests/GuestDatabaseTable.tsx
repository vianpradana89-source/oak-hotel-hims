import React, { useMemo, useState } from 'react';
import type { BehavioralSegment, Guest } from './guestTypes';
import {
  deriveBehavioralSegment,
  filterGuestsBySearch,
  filterGuestsBySegment,
  formatDateIndonesian,
  getSegmentBadgeClass,
  getVipBadgeClass,
  paginateGuests,
  calculateDaysBetween
} from './guestCrmHelpers';
import { authenticatedFetch } from '../../lib/authenticatedFetch';

interface GuestDatabaseTableProps {
  propertyId: number;
  guests: Guest[];
  loading: boolean;
  hotelDate: string;
  onSelectGuest: (guestId: number) => void;
  onEditGuest: (guest: Guest) => void;
  onCreateGuest: () => void;
  onMerged?: () => void;
}

function formatIdr(val: number): string {
  return 'Rp ' + Math.round(Number(val || 0)).toLocaleString('id-ID');
}

export const GuestDatabaseTable: React.FC<GuestDatabaseTableProps> = ({
  propertyId,
  guests,
  loading,
  hotelDate,
  onSelectGuest,
  onEditGuest,
  onCreateGuest,
  onMerged
}) => {
  const [search, setSearch] = useState<string>('');
  const [selectedSegment, setSelectedSegment] = useState<BehavioralSegment>('SEMUA');
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(25);

  // Manual merge state
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [manualMasterId, setManualMasterId] = useState<number | null>(null);
  const [isManualMergeOpen, setIsManualMergeOpen] = useState<boolean>(false);
  const [merging, setMerging] = useState<boolean>(false);
  const [mergeFeedback, setMergeFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const filteredGuests = useMemo(() => {
    const bySegment = filterGuestsBySegment(guests, selectedSegment, hotelDate);
    return filterGuestsBySearch(bySegment, search);
  }, [guests, selectedSegment, search, hotelDate]);

  const pagination = useMemo(() => {
    return paginateGuests(filteredGuests, page, pageSize);
  }, [filteredGuests, page, pageSize]);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value);
    setPage(1);
  };

  const handleSegmentChange = (segment: BehavioralSegment) => {
    setSelectedSegment(segment);
    setPage(1);
  };

  const handlePageSizeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setPageSize(Number(e.target.value));
    setPage(1);
  };

  const toggleSelectGuest = (id: number) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const selectedGuestObjects = useMemo(
    () => guests.filter((g) => selectedIds.includes(Number(g.id))),
    [guests, selectedIds]
  );

  const handleOpenManualMerge = () => {
    if (selectedGuestObjects.length < 2) return;
    const sorted = [...selectedGuestObjects].sort(
      (a, b) => Number(b.visit_count || 0) - Number(a.visit_count || 0)
    );
    setManualMasterId(Number(sorted[0].id));
    setIsManualMergeOpen(true);
  };

  const handleConfirmManualMerge = async () => {
    if (!manualMasterId || selectedIds.length < 2) return;
    const duplicateIds = selectedIds.filter((id) => id !== manualMasterId);
    setMerging(true);
    setMergeFeedback(null);
    try {
      const res = await authenticatedFetch('/api/guests/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          primary_guest_id: manualMasterId,
          duplicate_guest_ids: duplicateIds
        })
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.message || 'Gagal menggabungkan profil tamu.');
      }
      setIsManualMergeOpen(false);
      setSelectedIds([]);
      setMergeFeedback({
        type: 'success',
        message: `Berhasil menggabungkan ${duplicateIds.length} profil ke Profil Utama #${manualMasterId}.`
      });
      if (onMerged) onMerged();
    } catch (err: any) {
      setMergeFeedback({
        type: 'error',
        message: err?.message || 'Gagal menggabungkan profil tamu.'
      });
    } finally {
      setMerging(false);
    }
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
      'Kunjungan',
      'Total Malam',
      'Total Transaksi Lunas (Rp)',
      'Poin Loyalitas Aktif',
      'Stay Terakhir',
      'Catatan'
    ];
    const rows = filteredGuests.map((g) => [
      g.guest_code || `GST-${g.id}`,
      g.full_name || '',
      g.phone || '',
      g.email || '',
      g.identity_number || '',
      g.city || '',
      g.vip_status || 'STANDARD',
      g.loyalty_tier || 'SILVER',
      String(g.visit_count ?? 0),
      String(g.room_nights ?? 0),
      String(Math.round(Number(g.total_spend || 0))),
      String(g.loyalty_points ?? 0),
      g.last_stay || '',
      (g.notes || '').replace(/\r?\n/g, ' ')
    ]);
    const csvContent =
      '\uFEFF' +
      [headers, ...rows]
        .map((row) =>
          row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')
        )
        .join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `database-pelanggan-crm-${hotelDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const segmentChips: { id: BehavioralSegment; label: string }[] = [
    { id: 'SEMUA', label: `Semua Tamu (${guests.length})` },
    { id: 'VIP', label: 'VIP' },
    { id: 'VVIP', label: 'VVIP' },
    { id: 'REPEAT', label: 'Repeat Guest' },
    { id: 'BARU', label: 'Tamu Baru (30 Hari)' },
    { id: 'TIDAK_AKTIF', label: 'Tidak Aktif (>90 Hari)' }
  ];

  return (
    <div className="bg-white border border-stone-200 rounded-lg shadow-xs overflow-hidden flex flex-col">
      {/* Search & Actions Bar */}
      <div className="p-4 border-b border-stone-200 flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-stone-50/50">
        <div className="flex flex-1 items-center space-x-3">
          <div className="relative flex-1 max-w-md">
            <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-stone-400">
              🔍
            </span>
            <input
              type="text"
              value={search}
              onChange={handleSearchChange}
              placeholder="Cari nama tamu, nomor telepon, kode, atau email..."
              className="w-full text-xs pl-9 pr-3 py-2 bg-white border border-stone-300 rounded-md focus:ring-1 focus:ring-[#1E392A] focus:border-[#1E392A] outline-none"
            />
            {search && (
              <button
                onClick={() => {
                  setSearch('');
                  setPage(1);
                }}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-xs text-stone-400 hover:text-stone-600"
              >
                ✕
              </button>
            )}
          </div>

          {selectedIds.length >= 2 && (
            <button
              onClick={handleOpenManualMerge}
              className="px-3 py-2 bg-amber-800 hover:bg-amber-900 text-white text-xs font-semibold rounded-md shadow-xs transition-colors flex items-center space-x-1.5"
            >
              <span>🔗</span>
              <span>Gabungkan {selectedIds.length} Tamu Terpilih</span>
            </button>
          )}
          {selectedIds.length > 0 && (
            <button
              onClick={() => setSelectedIds([])}
              className="text-xs text-stone-500 hover:text-stone-800 underline"
            >
              Reset Pilihan ({selectedIds.length})
            </button>
          )}
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={handleExportCsv}
            className="px-3 py-2 bg-white hover:bg-stone-100 text-stone-700 border border-stone-300 text-xs font-semibold rounded-md shadow-xs transition-colors flex items-center space-x-1.5"
          >
            <span>⬇</span>
            <span>Export CSV/Excel</span>
          </button>
          <button
            onClick={onCreateGuest}
            className="px-3.5 py-2 bg-[#1E392A] hover:bg-[#162a1f] text-white text-xs font-semibold rounded-md shadow-xs transition-colors flex items-center justify-center space-x-1.5"
          >
            <span>+</span>
            <span>Tambah Tamu Baru</span>
          </button>
        </div>
      </div>

      {mergeFeedback && (
        <div
          className={`px-4 py-2 text-xs font-medium flex items-center justify-between border-b ${
            mergeFeedback.type === 'success'
              ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
              : 'bg-red-50 text-red-800 border-red-200'
          }`}
        >
          <span>{mergeFeedback.message}</span>
          <button onClick={() => setMergeFeedback(null)} className="underline ml-4">
            Tutup
          </button>
        </div>
      )}

      {/* Filter Chips Bar */}
      <div className="px-4 py-2.5 border-b border-stone-200 bg-white flex items-center justify-between gap-2 overflow-x-auto">
        <div className="flex items-center space-x-2">
          <span className="text-xs font-semibold text-stone-500 mr-1 whitespace-nowrap">
            Filter:
          </span>
          {segmentChips.map((chip) => {
            const isActive = selectedSegment === chip.id;
            return (
              <button
                key={chip.id}
                onClick={() => handleSegmentChange(chip.id)}
                className={`text-xs px-3 py-1 rounded-full whitespace-nowrap transition-colors font-medium border ${
                  isActive
                    ? 'bg-[#1E392A] text-white border-[#1E392A]'
                    : 'bg-stone-50 text-stone-700 border-stone-200 hover:bg-stone-100'
                }`}
              >
                {chip.label}
              </button>
            );
          })}
        </div>
        <span className="text-[11px] text-stone-400 whitespace-nowrap">
          Centang 2+ baris untuk menggabungkan (Merge) profil tamu manual
        </span>
      </div>

      {/* Table Content */}
      <div className="flex-1 overflow-x-auto min-h-[300px] max-h-[560px]">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-stone-500">
            <div className="w-6 h-6 border-2 border-[#1E392A] border-t-transparent rounded-full animate-spin mr-3" />
            <span>Memuat database pelanggan...</span>
          </div>
        ) : pagination.items.length === 0 ? (
          <div className="text-center py-16 text-stone-400">
            <span className="text-2xl block mb-1">📋</span>
            <p className="text-sm font-semibold text-stone-600">Tidak ada data tamu ditemukan</p>
            <p className="text-xs text-stone-400 mt-0.5">
              {search
                ? `Tidak ada tamu yang cocok dengan kata kunci "${search}"`
                : 'Belum ada data tamu pada kategori ini'}
            </p>
          </div>
        ) : (
          <table className="w-full text-left text-xs border-collapse">
            <thead className="sticky top-0 z-10 bg-stone-100 text-stone-700 font-semibold uppercase tracking-wider border-b border-stone-200">
              <tr>
                <th className="py-3 px-3 bg-stone-100 w-8 text-center">✓</th>
                <th className="py-3 px-3 bg-stone-100">Tamu</th>
                <th className="py-3 px-3 bg-stone-100">Kontak & Kota</th>
                <th className="py-3 px-3 bg-stone-100">VIP & Segmentasi</th>
                <th className="py-3 px-3 text-center bg-stone-100">Kunjungan</th>
                <th className="py-3 px-3 text-right bg-stone-100">Total Spend & Poin</th>
                <th className="py-3 px-3 bg-stone-100">Stay Terakhir</th>
                <th className="py-3 px-3 bg-stone-100">Catatan</th>
                <th className="py-3 px-4 text-right bg-stone-100">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100 text-stone-800">
              {pagination.items.map((guest) => {
                const vipBadge = getVipBadgeClass(guest.vip_status);
                const segment = deriveBehavioralSegment(guest, hotelDate);
                const segmentBadge = getSegmentBadgeClass(segment);
                const daysSinceStay = guest.last_stay
                  ? calculateDaysBetween(guest.last_stay, hotelDate)
                  : null;
                const isSelected = selectedIds.includes(Number(guest.id));

                return (
                  <tr
                    key={guest.id}
                    className={`hover:bg-stone-50/80 transition-colors ${
                      isSelected ? 'bg-amber-50/50' : ''
                    }`}
                  >
                    <td className="py-3 px-3 text-center">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelectGuest(Number(guest.id))}
                        className="accent-[#1E392A] cursor-pointer"
                        title="Pilih untuk digabungkan (Merge)"
                      />
                    </td>

                    {/* Tamu */}
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-bold text-stone-900">{guest.full_name}</span>
                        {guest.guest_code && (
                          <span className="text-[10px] px-1.5 py-0.2 rounded bg-stone-100 text-stone-700 font-mono font-medium border border-stone-200">
                            {guest.guest_code}
                          </span>
                        )}
                        {guest.has_valid_identity && (
                          <span
                            className="text-[9px] px-1 py-0.2 rounded bg-emerald-50 text-emerald-700 font-semibold border border-emerald-200"
                            title="Identitas KTP Terverifikasi"
                          >
                            KTP ✓
                          </span>
                        )}
                        {guest.is_archived && (
                          <span className="text-[9px] px-1 py-0.2 rounded bg-stone-200 text-stone-600 font-semibold">
                            Arsip
                          </span>
                        )}
                      </div>
                      {guest.preferred_name && (
                        <div className="text-[11px] text-stone-500">
                          Panggilan: &ldquo;{guest.preferred_name}&rdquo;
                        </div>
                      )}
                    </td>

                    {/* Kontak & Kota */}
                    <td className="py-3 px-3">
                      <div className="font-medium text-stone-800">{guest.phone || '—'}</div>
                      <div className="text-[11px] text-stone-500">
                        {[guest.email, guest.city].filter(Boolean).join(' • ') || '—'}
                      </div>
                    </td>

                    {/* Status VIP & Segmentasi */}
                    <td className="py-3 px-3">
                      <div className="flex flex-wrap items-center gap-1">
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded-full border ${vipBadge.bg} ${vipBadge.border} ${vipBadge.text}`}
                        >
                          {vipBadge.label}
                        </span>
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded border ${segmentBadge.bg} ${segmentBadge.border} ${segmentBadge.text}`}
                        >
                          {segmentBadge.label}
                        </span>
                      </div>
                    </td>

                    {/* Kunjungan & Malam */}
                    <td className="py-3 px-3 text-center">
                      <div className="font-bold text-stone-900">{guest.visit_count ?? 0} kali</div>
                      <div className="text-[11px] text-stone-500">{guest.room_nights ?? 0} malam</div>
                    </td>

                    {/* Total Spend & Poin */}
                    <td className="py-3 px-3 text-right tabular-nums">
                      <div className="font-bold text-stone-900">
                        {formatIdr(Number(guest.total_spend || 0))}
                      </div>
                      <div className="text-[11px] text-emerald-700 font-semibold">
                        🎁 {(guest.loyalty_points ?? 0).toLocaleString('id-ID')} poin
                      </div>
                    </td>

                    {/* Stay Terakhir */}
                    <td className="py-3 px-3">
                      <div className="font-medium text-stone-800">
                        {formatDateIndonesian(guest.last_stay)}
                      </div>
                      {daysSinceStay !== null && (
                        <div className="text-[11px] text-stone-500">
                          {daysSinceStay === 0 ? 'Hari ini' : `${daysSinceStay} hari lalu`}
                        </div>
                      )}
                    </td>

                    {/* Catatan */}
                    <td className="py-3 px-3 max-w-[180px]">
                      <p className="text-[11px] text-stone-600 truncate" title={guest.notes || ''}>
                        {guest.notes || '—'}
                      </p>
                    </td>

                    {/* Aksi */}
                    <td className="py-3 px-4 text-right">
                      <div className="flex items-center justify-end space-x-1.5">
                        <button
                          onClick={() => onSelectGuest(guest.id)}
                          className="px-2.5 py-1 text-xs bg-[#1E392A] hover:bg-[#162a1f] text-white font-medium rounded transition-colors"
                        >
                          Profil
                        </button>
                        <button
                          onClick={() => onEditGuest(guest)}
                          className="px-2 py-1 text-xs text-stone-600 hover:text-stone-900 hover:bg-stone-100 border border-stone-200 rounded transition-colors"
                          title="Edit Profil"
                        >
                          ✏️
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination Footer */}
      <div className="p-3 border-t border-stone-200 bg-stone-50 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-stone-600">
        <div className="flex items-center space-x-2">
          <span>Baris per halaman:</span>
          <select
            value={pageSize}
            onChange={handlePageSizeChange}
            className="text-xs px-2 py-1 bg-white border border-stone-300 rounded outline-none"
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={500}>500</option>
          </select>
          <span className="text-stone-400">|</span>
          <span>
            Menampilkan {pagination.startRecord}–{pagination.endRecord} dari {pagination.total} tamu
          </span>
        </div>

        <div className="flex items-center space-x-1">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="px-2.5 py-1 border border-stone-300 rounded bg-white hover:bg-stone-50 disabled:opacity-40 disabled:cursor-not-allowed font-medium"
          >
            &larr; Prev
          </button>
          <span className="px-3 py-1 font-semibold text-stone-800">
            Hal {page} / {pagination.totalPages}
          </span>
          <button
            disabled={page >= pagination.totalPages}
            onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
            className="px-2.5 py-1 border border-stone-300 rounded bg-white hover:bg-stone-50 disabled:opacity-40 disabled:cursor-not-allowed font-medium"
          >
            Next &rarr;
          </button>
        </div>
      </div>

      {/* Manual Merge Modal */}
      {isManualMergeOpen && selectedGuestObjects.length >= 2 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div className="bg-white rounded-xl shadow-2xl border border-stone-200 w-full max-w-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-stone-200 bg-stone-50 flex items-center justify-between">
              <div>
                <h4 className="text-sm font-bold text-stone-900">
                  🔗 Gabungkan {selectedGuestObjects.length} Profil Tamu
                </h4>
                <p className="text-xs text-stone-500">
                  Pilih 1 profil yang akan dijadikan <strong>Profil Utama (Master)</strong>:
                </p>
              </div>
              <button
                onClick={() => setIsManualMergeOpen(false)}
                className="text-stone-400 hover:text-stone-700"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-2.5 max-h-80 overflow-y-auto">
              {selectedGuestObjects.map((g) => {
                const isMaster = Number(g.id) === Number(manualMasterId);
                return (
                  <div
                    key={g.id}
                    onClick={() => setManualMasterId(Number(g.id))}
                    className={`p-3 rounded-lg border cursor-pointer flex items-center justify-between ${
                      isMaster
                        ? 'border-[#1E392A] bg-emerald-50/40 ring-1 ring-[#1E392A]'
                        : 'border-stone-200 bg-stone-50/50 hover:border-stone-300'
                    }`}
                  >
                    <div className="flex items-center space-x-2.5">
                      <input
                        type="radio"
                        checked={isMaster}
                        onChange={() => setManualMasterId(Number(g.id))}
                        className="accent-[#1E392A]"
                      />
                      <div>
                        <div className="font-bold text-xs text-stone-900">
                          {g.full_name}{' '}
                          <span className="font-mono text-[10px] text-stone-400">#{g.id}</span>
                        </div>
                        <div className="text-[11px] text-stone-500">
                          {g.phone || 'Tanpa HP'} • {g.visit_count ?? 0}x menginap ({g.room_nights ?? 0} malam)
                        </div>
                      </div>
                    </div>
                    {isMaster && (
                      <span className="text-[10px] px-2 py-0.5 rounded bg-[#1E392A] text-white font-semibold">
                        ★ Master
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="px-5 py-3 border-t border-stone-200 bg-stone-50 flex justify-end space-x-2 text-xs">
              <button
                type="button"
                onClick={() => setIsManualMergeOpen(false)}
                className="px-4 py-2 bg-stone-200 hover:bg-stone-300 text-stone-700 font-semibold rounded"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={merging}
                onClick={handleConfirmManualMerge}
                className="px-4 py-2 bg-[#1E392A] hover:bg-[#162a1f] text-white font-semibold rounded"
              >
                {merging ? 'Menggabungkan...' : `Gabungkan ke Master #${manualMasterId}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
