import React, { useState, useEffect, useRef, useMemo } from 'react';
import type {
  TransactionPeriodPreset,
  TransactionStatusFilter,
} from './transactionTypes.ts';
import {
  getTransactionPeriodRange,
  calculatePeriodCounters,
  filterTransactionsByStatus,
  filterTransactionsBySearch,
  paginateTransactions,
  getTransactionActionMatrix,
  formatStayPeriodDisplay,
  formatDateIndonesian,
  normalizeStatus,
} from './transactionPeriodHelpers.ts';

interface TransactionReservationListProps {
  propertyId: number | null;
  todayHotelDate: string;
  reservations: any[];
  isLoading: boolean;
  error: string | null;
  onRefresh: (startDate: string, endDateExclusive: string) => void;
  onCheckIn: (res: any) => void;
  onCheckout: (res: any) => void;
  onOpenDetail: (res: any) => void;
  onEdit: (res: any) => void;
  onMove: (res: any) => void;
  onExtend: (res: any) => void;
  onCancel: (res: any) => void;
  onViewFolio: (res: any) => void;
  onViewAudit: (res: any) => void;
  formatCurrency: (amount: number) => string;
  getPaymentStatusLabel: (status: any) => string;
  getPaymentBadgeClass: (status: any) => string;
}

export const TransactionReservationList: React.FC<TransactionReservationListProps> = ({
  propertyId,
  todayHotelDate,
  reservations,
  isLoading,
  error,
  onRefresh,
  onCheckIn,
  onCheckout,
  onOpenDetail,
  onEdit,
  onMove,
  onExtend,
  onCancel,
  onViewFolio,
  onViewAudit,
  formatCurrency,
  getPaymentStatusLabel,
  getPaymentBadgeClass,
}) => {
  // Period Preset State (default: 'today')
  const [selectedPreset, setSelectedPreset] = useState<TransactionPeriodPreset>('today');
  const [customStart, setCustomStart] = useState<string>(todayHotelDate);
  const [customEnd, setCustomEnd] = useState<string>(todayHotelDate);
  const [customError, setCustomError] = useState<string | null>(null);

  // Filter & Search State
  const [statusFilter, setStatusFilter] = useState<TransactionStatusFilter>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Pagination State
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(25);

  // Overflow Menu State
  const [openOverflowId, setOpenOverflowId] = useState<number | null>(null);
  const overflowRef = useRef<HTMLDivElement | null>(null);

  // Derive current period range
  const currentPeriodRange = useMemo(() => {
    return getTransactionPeriodRange(selectedPreset, todayHotelDate, customStart, customEnd);
  }, [selectedPreset, todayHotelDate, customStart, customEnd]);

  // Initial and on-preset-change data fetch trigger
  useEffect(() => {
    if (currentPeriodRange && propertyId !== null) {
      onRefresh(currentPeriodRange.startDate, currentPeriodRange.endDateExclusive);
    }
  }, [selectedPreset, propertyId]);

  // Reset page to 1 whenever period, status, search, or property changes
  useEffect(() => {
    setCurrentPage(1);
    setOpenOverflowId(null);
  }, [selectedPreset, statusFilter, searchQuery, propertyId]);

  // Close overflow menu on outside click or Escape key
  useEffect(() => {
    const handleDocumentClick = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOpenOverflowId(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenOverflowId(null);
      }
    };
    document.addEventListener('mousedown', handleDocumentClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleDocumentClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // Compute period counters over all reservations loaded for this period
  const counters = useMemo(() => {
    return calculatePeriodCounters(reservations);
  }, [reservations]);

  // Apply status filter
  const statusFiltered = useMemo(() => {
    return filterTransactionsByStatus(reservations, statusFilter);
  }, [reservations, statusFilter]);

  // Apply search query
  const searchFiltered = useMemo(() => {
    return filterTransactionsBySearch(statusFiltered, searchQuery);
  }, [statusFiltered, searchQuery]);

  // Apply pagination
  const { items: pageItems, pagination } = useMemo(() => {
    return paginateTransactions(searchFiltered, currentPage, pageSize);
  }, [searchFiltered, currentPage, pageSize]);

  // Handle custom range submission
  const handleApplyCustomRange = (e: React.FormEvent) => {
    e.preventDefault();
    setCustomError(null);
    if (!customStart || !customEnd) {
      setCustomError('Tanggal mulai dan selesai wajib diisi');
      return;
    }
    if (customStart > customEnd) {
      setCustomError('Tanggal mulai tidak boleh melebihi tanggal selesai');
      return;
    }
    const range = getTransactionPeriodRange('custom', todayHotelDate, customStart, customEnd);
    if (range && propertyId !== null) {
      onRefresh(range.startDate, range.endDateExclusive);
    }
  };

  const periodPresets: Array<{ key: TransactionPeriodPreset; label: string }> = [
    { key: 'today', label: 'Hari Ini' },
    { key: 'yesterday', label: 'Kemarin' },
    { key: '7days', label: '7 Hari' },
    { key: 'this_month', label: 'Bulan Ini' },
    { key: 'last_month', label: 'Bulan Lalu' },
    { key: 'custom', label: 'Kustom' },
  ];

  const statusChips: Array<{ key: TransactionStatusFilter; label: string; count: number; badgeColor: string }> = [
    { key: 'all', label: 'Semua', count: counters.all, badgeColor: 'bg-slate-200 text-slate-800' },
    { key: 'booked', label: 'Booked', count: counters.booked, badgeColor: 'bg-amber-100 text-amber-800' },
    { key: 'checked_in', label: 'Check-in', count: counters.checkedIn, badgeColor: 'bg-emerald-100 text-emerald-800' },
    { key: 'checked_out', label: 'Check-out', count: counters.checkedOut, badgeColor: 'bg-slate-200 text-slate-700' },
    { key: 'cancelled', label: 'Cancelled', count: counters.cancelled, badgeColor: 'bg-rose-100 text-rose-800' },
  ];

  const actionHandlers = {
    onCheckIn,
    onCheckout,
    onOpenDetail,
    onEdit,
    onMove,
    onExtend,
    onCancel,
    onViewFolio,
    onViewAudit,
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200/90 shadow-sm p-4 space-y-4">
      {/* Top Header & Period Presets */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-slate-100 pb-3">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-emerald-900 font-bold">Operasional Reservasi</div>
          <h2 className="text-lg font-bold text-slate-900">Transaksi & Riwayat Reservasi</h2>
          <div className="text-xs text-slate-500 mt-0.5">
            Periode: <span className="font-semibold text-slate-700">{currentPeriodRange?.displayLabel || '—'}</span>
          </div>
        </div>

        {/* Period Preset Buttons */}
        <div className="flex flex-wrap items-center gap-1.5">
          {periodPresets.map((preset) => (
            <button
              key={preset.key}
              type="button"
              onClick={() => setSelectedPreset(preset.key)}
              className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all ${
                selectedPreset === preset.key
                  ? 'bg-emerald-900 text-white shadow-sm font-semibold'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900'
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Custom Date Range Picker (collapsible when 'custom' is active) */}
      {selectedPreset === 'custom' && (
        <form onSubmit={handleApplyCustomRange} className="flex flex-wrap items-center gap-3 p-3 bg-emerald-50/50 border border-emerald-200/60 rounded-xl">
          <div className="flex items-center gap-2 text-xs">
            <label className="font-semibold text-slate-700">Dari:</label>
            <input
              type="date"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              className="border border-slate-300 rounded-lg px-2.5 py-1 text-xs bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-emerald-700"
            />
          </div>
          <div className="flex items-center gap-2 text-xs">
            <label className="font-semibold text-slate-700">Sampai:</label>
            <input
              type="date"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="border border-slate-300 rounded-lg px-2.5 py-1 text-xs bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-emerald-700"
            />
          </div>
          <button
            type="submit"
            className="bg-emerald-800 hover:bg-emerald-900 text-white text-xs font-semibold px-3.5 py-1.5 rounded-lg shadow-sm transition-colors"
          >
            Terapkan
          </button>
          {customError && <span className="text-xs text-rose-600 font-medium">{customError}</span>}
        </form>
      )}

      {/* Toolbar: Search and Status Filter Chips */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        {/* Search Input */}
        <div className="relative w-full md:w-80">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs">⌕</span>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Cari nama / BID / kamar / HP..."
            className="w-full text-xs pl-7 pr-7 py-1.5 border border-slate-200 rounded-xl bg-slate-50/50 text-slate-800 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-emerald-700 focus:border-emerald-700"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs"
            >
              ✕
            </button>
          )}
        </div>

        {/* Status Filter Chips */}
        <div className="flex flex-wrap items-center gap-1.5">
          {statusChips.map((chip) => {
            const isActive = statusFilter === chip.key;
            return (
              <button
                key={chip.key}
                type="button"
                onClick={() => setStatusFilter(chip.key)}
                className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border transition-all ${
                  isActive
                    ? 'border-emerald-800 bg-emerald-50 text-emerald-900 font-bold'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900'
                }`}
              >
                <span>{chip.label}</span>
                <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-semibold ${chip.badgeColor}`}>
                  {chip.count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected-Period Reservation Counters */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-1">
        {[
          { label: 'Semua', count: counters.all, cls: 'border-slate-200 bg-slate-50 text-slate-800' },
          { label: 'Booked', count: counters.booked, cls: 'border-amber-200 bg-amber-50/60 text-amber-900' },
          { label: 'Check-in', count: counters.checkedIn, cls: 'border-emerald-200 bg-emerald-50/60 text-emerald-900' },
          { label: 'Check-out', count: counters.checkedOut, cls: 'border-blue-200 bg-blue-50/60 text-blue-900' },
          { label: 'Cancelled', count: counters.cancelled, cls: 'border-rose-200 bg-rose-50/60 text-rose-900' },
        ].map((stat) => (
          <div key={stat.label} className={`p-2.5 rounded-xl border ${stat.cls} transition-colors`}>
            <div className="text-[10px] uppercase font-bold tracking-wider opacity-75">{stat.label}</div>
            <div className="text-xl font-extrabold mt-0.5">{stat.count}</div>
          </div>
        ))}
      </div>

      {/* Main Content Area: Loading / Error / Empty / Table */}
      {isLoading ? (
        <div className="p-12 text-center text-slate-500">
          <div className="inline-block animate-spin text-lg mb-2">⟳</div>
          <div className="text-sm font-semibold">Memuat data reservasi...</div>
          <div className="text-xs text-slate-400 mt-1">Mengambil data periode {currentPeriodRange?.displayLabel}</div>
        </div>
      ) : error ? (
        <div className="p-6 text-center text-rose-700 bg-rose-50 border border-rose-200 rounded-xl">
          <div className="text-sm font-bold mb-1">⚠️ Gagal Memuat Data Reservasi</div>
          <div className="text-xs text-rose-600 mb-3">{error}</div>
          <button
            type="button"
            onClick={() => currentPeriodRange && onRefresh(currentPeriodRange.startDate, currentPeriodRange.endDateExclusive)}
            className="bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold px-3 py-1.5 rounded-lg shadow-sm"
          >
            Coba Lagi
          </button>
        </div>
      ) : reservations.length === 0 ? (
        <div className="p-10 text-center text-slate-400 bg-slate-50/50 rounded-xl border border-dashed border-slate-200">
          <div className="text-sm font-semibold text-slate-600">Tidak ada reservasi pada periode ini.</div>
          <div className="text-xs text-slate-400 mt-1">Pilih preset periode lain atau tentukan rentang tanggal kustom.</div>
        </div>
      ) : searchFiltered.length === 0 ? (
        <div className="p-10 text-center text-slate-400 bg-slate-50/50 rounded-xl border border-dashed border-slate-200">
          <div className="text-sm font-semibold text-slate-600">Tidak ada reservasi yang sesuai filter.</div>
          <div className="text-xs text-slate-400 mt-1">Coba sesuaikan kata kunci pencarian atau ubah filter status.</div>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Compact Reservation Table */}
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full text-xs text-left">
              <thead>
                <tr className="bg-slate-50 text-slate-600 border-b border-slate-200 text-[11px] uppercase tracking-wider font-semibold">
                  <th className="px-3 py-2.5">Tamu</th>
                  <th className="px-3 py-2.5">Kamar</th>
                  <th className="px-3 py-2.5">Periode Menginap</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Pembayaran</th>
                  <th className="px-3 py-2.5">Tagihan</th>
                  <th className="px-3 py-2.5 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pageItems.map((res: any) => {
                  const paymentStatus = getPaymentStatusLabel(res.payment_status);
                  const statusClass = getPaymentBadgeClass(res.payment_status);
                  const status = normalizeStatus(res.status);
                  const actionMatrix = getTransactionActionMatrix(res, actionHandlers);
                  const isOverflowOpen = openOverflowId === Number(res.id);

                  let statusBadgeClass = 'bg-amber-100 text-amber-800 border-amber-200';
                  let statusLabel = 'BOOKED';
                  if (status === 'CHECKED_IN') {
                    statusBadgeClass = 'bg-emerald-100 text-emerald-800 border-emerald-200';
                    statusLabel = 'CHECK-IN';
                  } else if (status === 'CHECKED_OUT') {
                    statusBadgeClass = 'bg-slate-100 text-slate-700 border-slate-300';
                    statusLabel = 'CHECK-OUT';
                  } else if (status === 'CANCELLED') {
                    statusBadgeClass = 'bg-rose-100 text-rose-800 border-rose-200';
                    statusLabel = 'CANCELLED';
                  }

                  return (
                    <tr
                      key={res.id}
                      onClick={() => onOpenDetail(res)}
                      className="hover:bg-slate-50/80 cursor-pointer transition-colors"
                    >
                      {/* Tamu */}
                      <td className="px-3 py-2.5">
                        <div className="font-semibold text-slate-800">{res.guest_name || 'Tanpa Nama'}</div>
                        <div className="text-[11px] text-slate-500">{res.guest_phone || '—'}</div>
                        <div className="flex items-center gap-1 mt-0.5">
                          {res.bid && (
                            <span className="text-[9px] bg-slate-100 text-slate-600 px-1.5 py-0.2 rounded font-mono font-medium">
                              {res.bid}
                            </span>
                          )}
                          {res.guest_segment && (
                            <span className="text-[9px] bg-emerald-50 text-emerald-800 px-1.5 py-0.2 rounded font-medium">
                              {res.guest_segment}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Kamar */}
                      <td className="px-3 py-2.5">
                        <div className="font-semibold text-slate-800">
                          {res.room_number ? `Kamar ${res.room_number}` : res.room_id ? `Room #${res.room_id}` : 'TBA'}
                        </div>
                        <div className="text-[11px] text-slate-500">{res.room_type || 'Standard'}</div>
                      </td>

                      {/* Periode Menginap */}
                      <td className="px-3 py-2.5">
                        <div className="font-medium text-slate-700">
                          {formatStayPeriodDisplay(res.check_in, res.check_out)}
                        </div>
                        <div className="text-[11px] text-slate-400">
                          {formatDateIndonesian(res.check_in)} → {formatDateIndonesian(res.check_out)}
                        </div>
                      </td>

                      {/* Status */}
                      <td className="px-3 py-2.5">
                        <span className={`inline-block text-[10px] uppercase font-bold px-2 py-0.5 rounded-full border ${statusBadgeClass}`}>
                          {statusLabel}
                        </span>
                      </td>

                      {/* Pembayaran */}
                      <td className="px-3 py-2.5">
                        <span className={`segment-badge text-[10px] ${statusClass}`}>
                          {paymentStatus}
                        </span>
                      </td>

                      {/* Tagihan */}
                      <td className="px-3 py-2.5">
                        <div className="font-semibold text-slate-800">
                          {formatCurrency(Number(res.total_price || res.subtotal_amount || 0))}
                        </div>
                        {Number(res.remaining_balance || 0) > 0 && (
                          <div className="text-[10px] text-rose-600 font-medium">
                            Sisa: {formatCurrency(Number(res.remaining_balance))}
                          </div>
                        )}
                      </td>

                      {/* Aksi */}
                      <td className="px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1.5 relative">
                          {/* Primary Action Button */}
                          {actionMatrix.primaryAction && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                actionMatrix.primaryAction?.onClick();
                              }}
                              className={`text-xs font-semibold px-2.5 py-1 rounded-lg transition-all ${
                                actionMatrix.primaryAction.key === 'checkin'
                                  ? 'bg-emerald-700 hover:bg-emerald-800 text-white shadow-sm'
                                  : actionMatrix.primaryAction.key === 'checkout'
                                  ? 'bg-amber-600 hover:bg-amber-700 text-white shadow-sm'
                                  : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                              }`}
                            >
                              {actionMatrix.primaryAction.label}
                            </button>
                          )}

                          {/* Overflow Menu Button */}
                          {actionMatrix.overflowActions.length > 0 && (
                            <div className="relative">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setOpenOverflowId(isOverflowOpen ? null : Number(res.id));
                                }}
                                className={`w-7 h-7 flex items-center justify-center rounded-lg border text-slate-600 hover:text-slate-900 transition-colors ${
                                  isOverflowOpen ? 'bg-slate-200 border-slate-300' : 'bg-slate-50 border-slate-200 hover:bg-slate-100'
                                }`}
                                title="Menu Aksi Tambahan"
                              >
                                ⋯
                              </button>

                              {/* Dropdown Menu */}
                              {isOverflowOpen && (
                                <div
                                  ref={overflowRef}
                                  className="absolute right-0 top-full mt-1 z-50 w-44 bg-white border border-slate-200 rounded-xl shadow-lg py-1 text-xs text-left divide-y divide-slate-100"
                                >
                                  <div className="py-0.5">
                                    {actionMatrix.overflowActions
                                      .filter((act) => !act.isDestructive)
                                      .map((act) => (
                                        <button
                                          key={act.key}
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setOpenOverflowId(null);
                                            act.onClick();
                                          }}
                                          className="w-full px-3 py-1.5 text-left text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition-colors flex items-center justify-between"
                                        >
                                          <span>{act.label}</span>
                                        </button>
                                      ))}
                                  </div>

                                  {actionMatrix.overflowActions.some((act) => act.isDestructive) && (
                                    <div className="py-0.5">
                                      {actionMatrix.overflowActions
                                        .filter((act) => act.isDestructive)
                                        .map((act) => (
                                          <button
                                            key={act.key}
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setOpenOverflowId(null);
                                              act.onClick();
                                            }}
                                            className="w-full px-3 py-1.5 text-left text-rose-600 hover:bg-rose-50 hover:text-rose-700 font-medium transition-colors flex items-center justify-between"
                                          >
                                            <span>{act.label}</span>
                                          </button>
                                        ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination Footer */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 text-xs text-slate-500">
            {/* Page Size & Count Indicator */}
            <div className="flex items-center gap-3">
              <span>
                Menampilkan <strong className="text-slate-700">{pagination.startItemIndex}–{pagination.endItemIndex}</strong> dari <strong className="text-slate-700">{pagination.totalItems}</strong> reservasi
              </span>
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-slate-400">Baris/hal:</span>
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setCurrentPage(1);
                  }}
                  className="border border-slate-200 rounded px-1.5 py-0.5 text-xs bg-white text-slate-700 focus:outline-none focus:ring-1 focus:ring-emerald-700"
                >
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
              </div>
            </div>

            {/* Previous / Next Page Controls */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={pagination.currentPage <= 1}
                onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                className={`px-2.5 py-1 rounded-lg border text-xs font-medium transition-colors ${
                  pagination.currentPage <= 1
                    ? 'border-slate-100 text-slate-300 bg-slate-50 cursor-not-allowed'
                    : 'border-slate-200 text-slate-700 bg-white hover:bg-slate-50'
                }`}
              >
                ‹ Sebelumnya
              </button>

              <span className="font-semibold text-slate-700 px-1">
                Halaman {pagination.currentPage} dari {pagination.totalPages}
              </span>

              <button
                type="button"
                disabled={pagination.currentPage >= pagination.totalPages}
                onClick={() => setCurrentPage((prev) => Math.min(pagination.totalPages, prev + 1))}
                className={`px-2.5 py-1 rounded-lg border text-xs font-medium transition-colors ${
                  pagination.currentPage >= pagination.totalPages
                    ? 'border-slate-100 text-slate-300 bg-slate-50 cursor-not-allowed'
                    : 'border-slate-200 text-slate-700 bg-white hover:bg-slate-50'
                }`}
              >
                Berikutnya ›
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
