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

interface GuestDatabaseTableProps {
  guests: Guest[];
  loading: boolean;
  hotelDate: string;
  onSelectGuest: (guestId: number) => void;
  onEditGuest: (guest: Guest) => void;
  onCreateGuest: () => void;
}

export const GuestDatabaseTable: React.FC<GuestDatabaseTableProps> = ({
  guests,
  loading,
  hotelDate,
  onSelectGuest,
  onEditGuest,
  onCreateGuest
}) => {
  const [search, setSearch] = useState<string>('');
  const [selectedSegment, setSelectedSegment] = useState<BehavioralSegment>('SEMUA');
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(25);

  // Filter pipeline
  const filteredGuests = useMemo(() => {
    const bySegment = filterGuestsBySegment(guests, selectedSegment, hotelDate);
    return filterGuestsBySearch(bySegment, search);
  }, [guests, selectedSegment, search, hotelDate]);

  // Pagination calculation
  const pagination = useMemo(() => {
    return paginateGuests(filteredGuests, page, pageSize);
  }, [filteredGuests, page, pageSize]);

  // Reset page to 1 when search or filter changes
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

  const segmentChips: { id: BehavioralSegment; label: string }[] = [
    { id: 'SEMUA', label: 'Semua Tamu' },
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
          {/* Search Input */}
          <div className="relative flex-1 max-w-md">
            <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-stone-400">
              🔍
            </span>
            <input
              type="text"
              value={search}
              onChange={handleSearchChange}
              placeholder="Cari nama tamu, nomor telepon, atau email..."
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
        </div>

        <button
          onClick={onCreateGuest}
          className="px-3.5 py-2 bg-[#1E392A] hover:bg-[#162a1f] text-white text-xs font-semibold rounded-md shadow-xs transition-colors flex items-center justify-center space-x-1.5"
        >
          <span>+</span>
          <span>Tambah Tamu Baru</span>
        </button>
      </div>

      {/* Filter Chips Bar */}
      <div className="px-4 py-2.5 border-b border-stone-200 bg-white flex items-center space-x-2 overflow-x-auto">
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

      {/* Table Content */}
      <div className="flex-1 overflow-x-auto min-h-[300px]">
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
                <th className="py-3 px-4 bg-stone-100">Tamu</th>
                <th className="py-3 px-3 bg-stone-100">Kontak & Kota</th>
                <th className="py-3 px-3 bg-stone-100">Status VIP</th>
                <th className="py-3 px-3 bg-stone-100">Segmentasi</th>
                <th className="py-3 px-3 text-center bg-stone-100">Kunjungan</th>
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

                return (
                  <tr key={guest.id} className="hover:bg-stone-50/80 transition-colors">
                    {/* Tamu */}
                    <td className="py-3 px-4">
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

                    {/* Status VIP */}
                    <td className="py-3 px-3">
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded-full border ${vipBadge.bg} ${vipBadge.border} ${vipBadge.text}`}
                      >
                        {vipBadge.label}
                      </span>
                    </td>

                    {/* Segmentasi CRM */}
                    <td className="py-3 px-3">
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded border ${segmentBadge.bg} ${segmentBadge.border} ${segmentBadge.text}`}
                      >
                        {segmentBadge.label}
                      </span>
                    </td>

                    {/* Kunjungan & Malam */}
                    <td className="py-3 px-3 text-center">
                      <div className="font-bold text-stone-900">{guest.visit_count ?? 0} kali</div>
                      <div className="text-[11px] text-stone-500">{guest.room_nights ?? 0} malam</div>
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
                    <td className="py-3 px-3 max-w-[200px]">
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
          </select>
          <span className="text-stone-400">|</span>
          <span>
            Menampilkan {pagination.startRecord}–{pagination.endRecord} dari {pagination.total} tamu
          </span>
        </div>

        <div className="flex items-center space-x-1">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="px-2.5 py-1 bg-white border border-stone-200 rounded hover:bg-stone-100 disabled:opacity-40 disabled:cursor-not-allowed font-medium transition-colors"
          >
            &larr; Sebelumnya
          </button>
          <span className="px-2 font-medium">
            Hal {page} dari {pagination.totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
            disabled={page >= pagination.totalPages}
            className="px-2.5 py-1 bg-white border border-stone-200 rounded hover:bg-stone-100 disabled:opacity-40 disabled:cursor-not-allowed font-medium transition-colors"
          >
            Berikutnya &rarr;
          </button>
        </div>
      </div>
    </div>
  );
};
