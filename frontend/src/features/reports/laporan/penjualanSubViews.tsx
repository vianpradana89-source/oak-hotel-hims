import React, { useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState, formatIdr, formatNumber, LaporanDropdown } from './laporanUi';
import { downloadExportXml } from './exportLaporan';
import {
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconEye,
  IconFileSpreadsheet,
  IconFileText,
  IconFilter,
  IconSearch,
  IconX,
} from './LaporanIcons';
import type {
  AnalyticsHubData,
  CancelledBookingRow,
  FinancialsData,
  PosItemSaleRow,
  RoomSaleRow,
} from './laporanTypes';

// ============================================================================
// 1. Excel-Style Column Header Filter & Sort Popover (Gambar 5)
// ============================================================================

export type SortDirection = 'asc' | 'desc' | null;

export interface ColumnFilterState {
  selectedValues?: Set<string>; // undefined means all selected
  sortDir?: SortDirection;
}

interface ColumnFilterPopoverProps {
  columnKey: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  allValues: string[];
  activeSelected?: Set<string>;
  activeSort?: SortDirection;
  onApply: (columnKey: string, selected: Set<string> | undefined, sortDir: SortDirection) => void;
}

export const ColumnFilterHeader: React.FC<ColumnFilterPopoverProps> = ({
  columnKey,
  label,
  align = 'left',
  allValues,
  activeSelected,
  activeSort,
  onApply,
}) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [tempSelected, setTempSelected] = useState<Set<string>>(new Set(allValues));
  const [tempSort, setTempSort] = useState<SortDirection>(null);
  const ref = useRef<HTMLTableHeaderCellElement>(null);

  const uniqueOptions = useMemo(() => {
    const set = new Set<string>();
    for (const v of allValues) {
      set.add(v && v.trim() !== '' ? v : '-');
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'id-ID'));
  }, [allValues]);

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setTempSelected(activeSelected ? new Set(activeSelected) : new Set(uniqueOptions));
    setTempSort(activeSort ?? null);

    const onOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [open, activeSelected, activeSort, uniqueOptions]);

  const filteredOptions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return uniqueOptions;
    return uniqueOptions.filter((o) => o.toLowerCase().includes(q));
  }, [uniqueOptions, search]);

  const isFiltered =
    (activeSelected !== undefined && activeSelected.size < uniqueOptions.length) ||
    Boolean(activeSort);

  const handleToggleOption = (opt: string) => {
    setTempSelected((prev) => {
      const next = new Set(prev);
      if (next.has(opt)) next.delete(opt);
      else next.add(opt);
      return next;
    });
  };

  const handleConfirm = () => {
    const nextSelected =
      tempSelected.size >= uniqueOptions.length ? undefined : new Set(tempSelected);
    onApply(columnKey, nextSelected, tempSort);
    setOpen(false);
  };

  const alignClass =
    align === 'right'
      ? 'justify-end text-right'
      : align === 'center'
      ? 'justify-center text-center'
      : 'justify-start text-left';

  return (
    <th
      ref={ref}
      className="py-3 px-3 text-[11px] font-semibold text-slate-600 relative select-none whitespace-nowrap"
    >
      <div className={`flex items-center gap-1 ${alignClass}`}>
        <span>{label}</span>
        {activeSort === 'asc' && <span className="text-[10px] text-emerald-700 font-bold">↑</span>}
        {activeSort === 'desc' && <span className="text-[10px] text-emerald-700 font-bold">↓</span>}
        <button
          type="button"
          onClick={() => setOpen((p) => !p)}
          title={`Filter & urutkan ${label}`}
          className={`p-1 rounded hover:bg-slate-200/70 transition-colors cursor-pointer ${
            isFiltered ? 'text-emerald-700 bg-emerald-50' : 'text-slate-400 hover:text-slate-600'
          }`}
        >
          <IconFilter className="w-3 h-3" />
        </button>
      </div>

      {open && (
        <div
          className={`absolute top-full mt-1 z-50 w-64 bg-white border border-slate-200 rounded-xl shadow-xl p-3 text-left font-normal text-slate-700 ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {/* Pilih semua & Kosongkan */}
          <div className="flex items-center justify-between text-[11px] pb-2 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setTempSelected(new Set(uniqueOptions))}
                className="text-blue-600 hover:underline font-semibold cursor-pointer"
              >
                Pilih semua ({uniqueOptions.length} opsi)
              </button>
              <button
                type="button"
                onClick={() => setTempSelected(new Set())}
                className="text-blue-600 hover:underline font-semibold cursor-pointer"
              >
                Kosongkan
              </button>
            </div>
          </div>

          {/* Search box */}
          <div className="relative my-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari..."
              className="w-full border border-slate-300 rounded-lg pl-2.5 pr-7 py-1.5 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-hidden focus:ring-1 focus:ring-emerald-600"
            />
            <IconSearch className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>

          {/* Checkbox list */}
          <div className="max-h-40 overflow-y-auto space-y-1 pr-1 my-1 border-b border-slate-100 pb-2">
            {filteredOptions.length === 0 ? (
              <div className="text-[11px] text-slate-400 py-2 text-center">Tidak ditemukan</div>
            ) : (
              filteredOptions.map((opt) => {
                const checked = tempSelected.has(opt);
                return (
                  <label
                    key={opt}
                    className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-slate-50 text-xs cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => handleToggleOption(opt)}
                      className="rounded border-slate-300 text-emerald-700 focus:ring-emerald-600"
                    />
                    <span className="truncate text-slate-700">{opt}</span>
                  </label>
                );
              })
            )}
          </div>

          {/* Sort A-Z / Z-A */}
          <div className="flex items-center gap-1.5 py-1.5 border-b border-slate-100 text-[11px]">
            <span className="text-slate-400">Urutkan:</span>
            <button
              type="button"
              onClick={() => setTempSort((s) => (s === 'asc' ? null : 'asc'))}
              className={`px-2 py-1 rounded border text-[11px] font-semibold cursor-pointer ${
                tempSort === 'asc'
                  ? 'bg-emerald-50 border-emerald-600 text-emerald-800'
                  : 'border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              ↑ A-Z
            </button>
            <button
              type="button"
              onClick={() => setTempSort((s) => (s === 'desc' ? null : 'desc'))}
              className={`px-2 py-1 rounded border text-[11px] font-semibold cursor-pointer ${
                tempSort === 'desc'
                  ? 'bg-emerald-50 border-emerald-600 text-emerald-800'
                  : 'border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              ↓ Z-A
            </button>
          </div>

          {/* Batal & Oke */}
          <div className="flex items-center justify-end gap-2 pt-2.5">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50 cursor-pointer"
            >
              Batal
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              className="px-3.5 py-1.5 rounded-lg bg-emerald-800 hover:bg-emerald-700 text-white text-xs font-semibold cursor-pointer"
            >
              Oke
            </button>
          </div>
        </div>
      )}
    </th>
  );
};

// ============================================================================
// 2. Bukti Bayar Modal ("Lihat")
// ============================================================================

export interface BuktiBayarModalInfo {
  bookingOrOrderNo: string;
  txDate: string;
  customerName: string;
  roomLabel: string;
  itemLabel: string;
  totalAmount: number;
  amountPaid: number;
  paymentMethod: string;
  statusLabel: string;
  attachmentId?: number | null;
  paymentEvidenceId?: number | null;
}

export const BuktiBayarModal: React.FC<{
  info: BuktiBayarModalInfo | null;
  onClose: () => void;
}> = ({ info, onClose }) => {
  if (!info) return null;
  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-md w-full overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-emerald-800">
              Rincian & Bukti Pembayaran
            </div>
            <div className="text-sm font-extrabold text-slate-900 mt-0.5 font-mono">
              {info.bookingOrOrderNo}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 cursor-pointer"
          >
            <IconX className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-3 text-xs">
          <div className="grid grid-cols-2 gap-2.5 bg-slate-50 p-3.5 rounded-xl border border-slate-200/80">
            <div>
              <div className="text-slate-400">Pelanggan</div>
              <div className="font-bold text-slate-800 mt-0.5">{info.customerName}</div>
            </div>
            <div>
              <div className="text-slate-400">Tanggal</div>
              <div className="font-semibold text-slate-700 mt-0.5">{info.txDate}</div>
            </div>
            <div>
              <div className="text-slate-400">Kamar / Unit</div>
              <div className="font-semibold text-slate-700 mt-0.5">{info.roomLabel}</div>
            </div>
            <div>
              <div className="text-slate-400">Metode Bayar</div>
              <div className="font-bold text-emerald-800 mt-0.5">{info.paymentMethod}</div>
            </div>
            <div>
              <div className="text-slate-400">Total Tagihan</div>
              <div className="font-bold text-slate-800 mt-0.5">{formatIdr(info.totalAmount)}</div>
            </div>
            <div>
              <div className="text-slate-400">Jumlah Dibayar</div>
              <div className="font-extrabold text-emerald-700 mt-0.5">
                {formatIdr(info.amountPaid)}
              </div>
            </div>
          </div>

          {info.attachmentId ? (
            <div className="border border-slate-200 rounded-xl p-3 text-center space-y-2">
              <div className="text-[11px] font-semibold text-slate-600">
                Lampiran Bukti Transaksi Tersedia
              </div>
              <a
                href={`/api/transactions/attachments/${info.attachmentId}/download`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-800 text-white font-semibold text-xs hover:bg-emerald-700"
              >
                <IconEye className="w-3.5 h-3.5" /> Buka File Lampiran Bukti Bayar
              </a>
            </div>
          ) : (
            <div className="border border-emerald-200 bg-emerald-50/50 rounded-xl p-3.5 flex items-center gap-2.5 text-emerald-900">
              <IconCheck className="w-4 h-4 text-emerald-700 shrink-0" />
              <div>
                <div className="font-bold text-xs">Pembayaran Tercatat di Sistem HIMS</div>
                <div className="text-[11px] text-emerald-700 mt-0.5">
                  Metode: {info.paymentMethod} • Status: {info.statusLabel}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 3. Sub-View #4: Laporan Sumber Penjualan (Walk-in vs OTA - Gambar 13)
// ============================================================================

export const SubViewSumberPenjualan: React.FC<{ roomSales: RoomSaleRow[] }> = ({ roomSales }) => {
  const isOtaRow = (r: RoomSaleRow) => {
    const ch = `${r.ota_source_name || ''} ${r.booking_channel || ''}`.toUpperCase();
    return (
      Boolean(r.ota_source_name && r.ota_source_name.trim() !== '') ||
      ch.includes('OTA') ||
      ch.includes('TRAVELOKA') ||
      ch.includes('TIKET') ||
      ch.includes('BOOKING') ||
      ch.includes('AGODA') ||
      ch.includes('EXPEDIA')
    );
  };

  const walkInRows = roomSales.filter((r) => !isOtaRow(r));
  const otaRows = roomSales.filter((r) => isOtaRow(r));

  const walkInTotal = walkInRows.reduce((s, r) => s + (Number(r.total_price) || 0), 0);
  const otaTotal = otaRows.reduce((s, r) => s + (Number(r.total_price) || 0), 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-slate-500 font-semibold">Walk-in</div>
          <div className="text-2xl font-extrabold text-emerald-700 mt-1">
            {walkInRows.length} booking
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Total pendapatan: <strong className="text-slate-800">{formatIdr(walkInTotal)}</strong>
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-slate-500 font-semibold">OTA (Online Travel Agent)</div>
          <div className="text-2xl font-extrabold text-blue-700 mt-1">{otaRows.length} booking</div>
          <div className="text-xs text-slate-500 mt-1">
            Total pendapatan: <strong className="text-slate-800">{formatIdr(otaTotal)}</strong>
          </div>
        </div>
      </div>

      {/* Rincian Walk-in */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-2.5">
        <div className="text-xs font-bold text-slate-800">Rincian Walk-in</div>
        {walkInRows.length === 0 ? (
          <div className="text-xs text-slate-400 py-4 text-center">Belum ada transaksi Walk-in</div>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {walkInRows.map((r) => (
              <div
                key={r.reservation_id}
                className="flex items-center justify-between px-3.5 py-2.5 rounded-lg bg-slate-50 border border-slate-200/70 text-xs"
              >
                <div>
                  <div className="font-bold text-slate-800">{r.guest_name}</div>
                  <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                    {r.booking_code} • {r.room_number} {r.room_type_name} ({r.room_number}) •{' '}
                    {r.nights} malam
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] text-slate-400">{r.tx_date}</div>
                  <div className="font-extrabold text-emerald-700 mt-0.5 tabular-nums">
                    {formatIdr(r.total_price)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Rincian OTA */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-2.5">
        <div className="text-xs font-bold text-slate-800">Rincian OTA</div>
        {otaRows.length === 0 ? (
          <div className="text-xs text-slate-400 py-4 text-center">Belum ada transaksi OTA</div>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {otaRows.map((r) => (
              <div
                key={r.reservation_id}
                className="flex items-center justify-between px-3.5 py-2.5 rounded-lg bg-slate-50 border border-slate-200/70 text-xs"
              >
                <div>
                  <div className="font-bold text-slate-800">{r.guest_name}</div>
                  <div className="text-[11px] text-slate-500 font-mono mt-0.5 flex items-center gap-1.5 flex-wrap">
                    <span>
                      {r.booking_code} • {r.room_number} {r.room_type_name} ({r.room_number}) •{' '}
                      {r.nights} malam
                    </span>
                    <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-800 font-sans font-bold text-[10px]">
                      {r.ota_source_name || r.booking_channel || 'OTA'}
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] text-slate-400">{r.tx_date}</div>
                  <div className="font-extrabold text-blue-700 mt-0.5 tabular-nums">
                    {formatIdr(r.total_price)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// 4. Sub-View #5: Laporan Sumber Transaksi (Dashboard / POS / Website - Gambar 6 & 12)
// ============================================================================

type TxOriginFilter = 'ALL' | 'DASHBOARD' | 'POS' | 'WEBSITE';

export const SubViewSumberTransaksi: React.FC<{
  roomSales: RoomSaleRow[];
  posItems: PosItemSaleRow[];
}> = ({ roomSales, posItems }) => {
  const [originFilter, setOriginFilter] = useState<TxOriginFilter>('ALL');
  const [page, setPage] = useState(1);
  const pageSize = 10;

  const allItems = useMemo(() => {
    const roomMapped = roomSales.map((r) => {
      const ch = String(r.booking_channel || '').toUpperCase();
      const isWeb = ch.includes('WEB') || ch.includes('ONLINE');
      return {
        key: `r-${r.reservation_id}`,
        bid: r.booking_code,
        date: r.tx_datetime || r.tx_date,
        origin: (isWeb ? 'WEBSITE' : 'DASHBOARD') as 'DASHBOARD' | 'POS' | 'WEBSITE',
        customer: r.guest_name || 'Tamu Hotel',
        payment: r.payment_method || '-',
        status:
          r.reservation_status === 'CHECKED_OUT'
            ? 'CO'
            : r.reservation_status === 'CHECKED_IN'
            ? 'CI'
            : 'BO',
        total: Number(r.total_price) || 0,
      };
    });

    const posMapped = posItems.map((p) => ({
      key: `p-${p.order_item_id}`,
      bid: p.booking_or_order_no,
      date: p.tx_datetime || p.tx_date,
      origin: 'POS' as const,
      customer: p.customer_name || 'Walk-in',
      payment: p.payment_method || 'Cash',
      status: 'Selesai',
      total: Number(p.line_total) || 0,
    }));

    return [...roomMapped, ...posMapped].sort((a, b) => b.date.localeCompare(a.date));
  }, [roomSales, posItems]);

  const dashItems = allItems.filter((i) => i.origin === 'DASHBOARD');
  const posOnlyItems = allItems.filter((i) => i.origin === 'POS');
  const webItems = allItems.filter((i) => i.origin === 'WEBSITE');

  const filtered =
    originFilter === 'ALL' ? allItems : allItems.filter((i) => i.origin === originFilter);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageSlice = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-bold text-slate-700">
          Laporan Sumber Transaksi (POS / Website / Dashboard)
        </div>
        <LaporanDropdown<TxOriginFilter>
          value={originFilter}
          onChange={(v) => {
            setOriginFilter(v);
            setPage(1);
          }}
          variant="outline"
          align="right"
          options={[
            { value: 'ALL', label: 'Semua Sumber' },
            { value: 'DASHBOARD', label: 'Dashboard' },
            { value: 'POS', label: 'Point of Sale' },
            { value: 'WEBSITE', label: 'Website' },
          ]}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-slate-500 font-semibold">Dashboard</div>
          <div className="text-2xl font-extrabold text-blue-700 mt-1">
            {dashItems.length} transaksi
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Total nilai:{' '}
            <strong className="text-slate-800">
              {formatIdr(dashItems.reduce((s, i) => s + i.total, 0))}
            </strong>
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-slate-500 font-semibold">Point of Sale</div>
          <div className="text-2xl font-extrabold text-amber-600 mt-1">
            {posOnlyItems.length} transaksi
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Total nilai:{' '}
            <strong className="text-slate-800">
              {formatIdr(posOnlyItems.reduce((s, i) => s + i.total, 0))}
            </strong>
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-slate-500 font-semibold">Website</div>
          <div className="text-2xl font-extrabold text-emerald-700 mt-1">
            {webItems.length} transaksi
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Total nilai:{' '}
            <strong className="text-slate-800">
              {formatIdr(webItems.reduce((s, i) => s + i.total, 0))}
            </strong>
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 text-xs font-bold text-slate-800">
          Detail Transaksi
        </div>
        <div className="overflow-auto max-h-[calc(100vh-280px)]">
          <table className="min-w-full text-xs divide-y divide-slate-200">
            <thead className="sticky top-0 z-20 bg-slate-50 text-slate-600 font-semibold text-[11px] shadow-2xs">
              <tr>
                <th className="py-2.5 px-3.5 text-left">BID</th>
                <th className="py-2.5 px-3.5 text-left">Tanggal</th>
                <th className="py-2.5 px-3.5 text-left">Sumber</th>
                <th className="py-2.5 px-3.5 text-left">Pelanggan</th>
                <th className="py-2.5 px-3.5 text-left">Pembayaran</th>
                <th className="py-2.5 px-3.5 text-left">Status</th>
                <th className="py-2.5 px-3.5 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pageSlice.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-400">
                    Tidak ada transaksi pada sumber ini
                  </td>
                </tr>
              ) : (
                pageSlice.map((row) => (
                  <tr key={row.key} className="hover:bg-slate-50/80">
                    <td className="py-2.5 px-3.5 font-mono text-[11px] font-semibold text-slate-800">
                      {row.bid}
                    </td>
                    <td className="py-2.5 px-3.5 text-slate-600">{row.date}</td>
                    <td className="py-2.5 px-3.5">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          row.origin === 'POS'
                            ? 'bg-amber-100 text-amber-800'
                            : row.origin === 'WEBSITE'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-blue-100 text-blue-800'
                        }`}
                      >
                        {row.origin === 'POS'
                          ? 'Point of Sale'
                          : row.origin === 'WEBSITE'
                          ? 'Website'
                          : 'Dashboard'}
                      </span>
                    </td>
                    <td className="py-2.5 px-3.5 font-medium text-slate-800">{row.customer}</td>
                    <td className="py-2.5 px-3.5 text-slate-600">{row.payment}</td>
                    <td className="py-2.5 px-3.5">
                      <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[10px] font-bold">
                        {row.status}
                      </span>
                    </td>
                    <td className="py-2.5 px-3.5 text-right font-bold text-slate-800 tabular-nums">
                      {formatIdr(row.total)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between text-xs text-slate-500">
          <span>
            Menampilkan {filtered.length === 0 ? 0 : (safePage - 1) * pageSize + 1}–
            {Math.min(safePage * pageSize, filtered.length)} dari {filtered.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="p-1.5 rounded border border-slate-200 bg-white disabled:opacity-40 cursor-pointer"
            >
              <IconChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="px-2.5 py-1 rounded bg-emerald-800 text-white font-bold text-xs">
              {safePage}
            </span>
            <button
              type="button"
              disabled={safePage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="p-1.5 rounded border border-slate-200 bg-white disabled:opacity-40 cursor-pointer"
            >
              <IconChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 5. Sub-View #6: Laporan Laba/Rugi Ringkasan di Tab Penjualan (Gambar 11)
// ============================================================================

export const SubViewPenjualanLabaRugi: React.FC<{
  roomSales: RoomSaleRow[];
  posItems: PosItemSaleRow[];
  financials?: FinancialsData | null;
}> = ({ roomSales, posItems, financials }) => {
  const roomRevenue = roomSales
    .filter((r) => !r.is_complimentary)
    .reduce((s, r) => s + (Number(r.total_price) || 0), 0);
  const posRevenue = posItems
    .filter((p) => !p.is_complimentary)
    .reduce((s, p) => s + (Number(p.line_total) || 0), 0);
  const totalRevenue = roomRevenue + posRevenue;

  const expenseItems = financials?.expense?.items || [];
  const totalExpenses =
    Number(financials?.expense?.total) ||
    expenseItems.reduce((s, e) => s + (Number(e.net_amount) || 0), 0);
  const netProfit = totalRevenue - totalExpenses;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-emerald-50/70 border border-emerald-200 rounded-xl p-4">
          <div className="text-xs text-slate-600 font-semibold">Total Pendapatan</div>
          <div className="text-2xl font-extrabold text-emerald-700 mt-1 tabular-nums">
            {formatIdr(totalRevenue)}
          </div>
        </div>
        <div className="bg-rose-50/70 border border-rose-200 rounded-xl p-4">
          <div className="text-xs text-slate-600 font-semibold">Total Pengeluaran</div>
          <div className="text-2xl font-extrabold text-rose-600 mt-1 tabular-nums">
            {formatIdr(totalExpenses)}
          </div>
        </div>
        <div className="bg-blue-50/70 border border-blue-200 rounded-xl p-4">
          <div className="text-xs text-slate-600 font-semibold">Laba Bersih</div>
          <div className="text-2xl font-extrabold text-blue-700 mt-1 tabular-nums">
            {formatIdr(netProfit)}
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-2.5">
        <div className="text-xs font-bold text-slate-800">Rincian Pendapatan</div>
        <div className="flex items-center justify-between px-3.5 py-2.5 rounded-lg bg-slate-50 text-xs">
          <span className="text-slate-700 font-medium">Penjualan Kamar</span>
          <span className="font-bold text-emerald-700 tabular-nums">{formatIdr(roomRevenue)}</span>
        </div>
        <div className="flex items-center justify-between px-3.5 py-2.5 rounded-lg bg-slate-50 text-xs">
          <span className="text-slate-700 font-medium">Penjualan Produk</span>
          <span className="font-bold text-emerald-700 tabular-nums">{formatIdr(posRevenue)}</span>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-2.5">
        <div className="text-xs font-bold text-slate-800">Rincian Pengeluaran</div>
        {expenseItems.length === 0 ? (
          <div className="text-xs text-slate-400 py-4 text-center">
            Belum ada rincian pengeluaran pada periode ini
          </div>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {expenseItems.map((exp) => (
              <div
                key={exp.id}
                className="flex items-center justify-between px-3.5 py-2.5 rounded-lg bg-slate-50 border border-slate-200/60 text-xs"
              >
                <div>
                  <div className="font-bold text-slate-800">
                    {exp.description || exp.category_name}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {exp.transaction_date} • {exp.category_name || exp.department_code}
                  </div>
                </div>
                <div className="font-extrabold text-rose-600 tabular-nums">
                  -{formatIdr(exp.net_amount)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// 6. Sub-View #7: Laporan Dibatalkan (Gambar 10)
// ============================================================================

export const SubViewDibatalkan: React.FC<{ cancelled: CancelledBookingRow[] }> = ({
  cancelled,
}) => {
  const totalLost = cancelled.reduce((s, c) => s + (Number(c.lost_revenue) || 0), 0);

  return (
    <div className="space-y-4">
      <div className="bg-rose-50/70 border border-rose-200 rounded-xl p-4">
        <div className="text-xs text-slate-600 font-semibold">Total Dibatalkan</div>
        <div className="text-2xl font-extrabold text-rose-600 mt-1">{cancelled.length} booking</div>
        <div className="text-xs text-slate-500 mt-1">
          Potensi pendapatan hilang:{' '}
          <strong className="text-slate-800">{formatIdr(totalLost)}</strong>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-2.5">
        <div className="text-xs font-bold text-slate-800">Daftar Booking Dibatalkan</div>
        {cancelled.length === 0 ? (
          <EmptyState
            title="Tidak ada booking dibatalkan"
            message="Tidak ditemukan reservasi berstatus BATAL pada periode ini."
          />
        ) : (
          <div className="space-y-2">
            {cancelled.map((c) => (
              <div
                key={c.reservation_id}
                className="flex items-center justify-between px-4 py-3 rounded-xl bg-rose-50/40 border border-rose-200/70 text-xs"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded bg-rose-200/80 text-rose-800 font-extrabold text-[10px]">
                      BATAL
                    </span>
                    <span className="font-bold text-slate-900">{c.guest_name}</span>
                  </div>
                  <div className="text-[11px] text-slate-500 font-mono">
                    {c.booking_code} • {c.room_number} {c.room_type_name} ({c.room_number}) •{' '}
                    {c.nights} malam
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] text-slate-500">{c.cancelled_date || c.check_in}</div>
                  <div className="font-extrabold text-rose-600 mt-0.5 tabular-nums">
                    {formatIdr(c.lost_revenue)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// 7. Sub-View #8: Laporan Rekap Item (Gambar 8)
// ============================================================================

export const SubViewRekapItem: React.FC<{
  roomSales: RoomSaleRow[];
  posItems: PosItemSaleRow[];
}> = ({ roomSales, posItems }) => {
  const roomRecap = useMemo(() => {
    const map = new Map<
      string,
      { label: string; count: number; nights: number; revenue: number }
    >();
    for (const r of roomSales) {
      const label = `${r.room_number} ${r.room_type_name} (${r.room_number})`;
      const cur = map.get(label) || { label, count: 0, nights: 0, revenue: 0 };
      cur.count += 1;
      cur.nights += Number(r.nights) || 1;
      cur.revenue += r.is_complimentary ? 0 : Number(r.total_price) || 0;
      map.set(label, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue);
  }, [roomSales]);

  const productRecap = useMemo(() => {
    const map = new Map<string, { name: string; qty: number; subtotal: number }>();
    for (const p of posItems) {
      const name = p.item_name || 'Item POS';
      const cur = map.get(name) || { name, qty: 0, subtotal: 0 };
      cur.qty += Number(p.quantity) || 1;
      cur.subtotal += p.is_complimentary ? 0 : Number(p.line_total) || 0;
      map.set(name, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.subtotal - a.subtotal);
  }, [posItems]);

  const totalRoomRev = roomRecap.reduce((s, r) => s + r.revenue, 0);
  const totalProdRev = productRecap.reduce((s, p) => s + p.subtotal, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-blue-50/60 border border-blue-200 rounded-xl p-4">
          <div className="text-xs text-slate-600 font-semibold">Penjualan Kamar</div>
          <div className="text-2xl font-extrabold text-blue-700 mt-1">
            {roomRecap.length} kamar
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Total pendapatan: <strong className="text-slate-800">{formatIdr(totalRoomRev)}</strong>
          </div>
        </div>
        <div className="bg-emerald-50/60 border border-emerald-200 rounded-xl p-4">
          <div className="text-xs text-slate-600 font-semibold">Penjualan Produk</div>
          <div className="text-2xl font-extrabold text-emerald-700 mt-1">
            {productRecap.length} item
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Total pendapatan: <strong className="text-slate-800">{formatIdr(totalProdRev)}</strong>
          </div>
        </div>
      </div>

      {/* Rincian Penjualan Kamar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-2.5">
        <div className="text-xs font-bold text-slate-800">Rincian Penjualan Kamar</div>
        <div className="overflow-auto max-h-[calc(100vh-280px)]">
          <table className="min-w-full text-xs divide-y divide-slate-200">
            <thead className="sticky top-0 z-20 bg-slate-50 text-slate-600 font-semibold text-[11px] shadow-2xs">
              <tr>
                <th className="py-2.5 px-3.5 text-left">Kamar</th>
                <th className="py-2.5 px-3.5 text-center">Jumlah</th>
                <th className="py-2.5 px-3.5 text-center">Total Durasi</th>
                <th className="py-2.5 px-3.5 text-right">Pendapatan</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {roomRecap.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-slate-400">
                    Belum ada penjualan kamar
                  </td>
                </tr>
              ) : (
                roomRecap.map((r) => (
                  <tr key={r.label} className="hover:bg-slate-50/80">
                    <td className="py-2.5 px-3.5 font-medium text-slate-800">{r.label}</td>
                    <td className="py-2.5 px-3.5 text-center font-semibold">{r.count}x</td>
                    <td className="py-2.5 px-3.5 text-center text-slate-600">{r.nights} malam</td>
                    <td className="py-2.5 px-3.5 text-right font-bold text-emerald-700 tabular-nums">
                      {formatIdr(r.revenue)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Rincian Penjualan Produk */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-2.5">
        <div className="text-xs font-bold text-slate-800">Rincian Penjualan Produk</div>
        <div className="overflow-auto max-h-[calc(100vh-280px)]">
          <table className="min-w-full text-xs divide-y divide-slate-200">
            <thead className="sticky top-0 z-20 bg-slate-50 text-slate-600 font-semibold text-[11px] shadow-2xs">
              <tr>
                <th className="py-2.5 px-3.5 text-left">Produk</th>
                <th className="py-2.5 px-3.5 text-center">Qty</th>
                <th className="py-2.5 px-3.5 text-right">Subtotal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {productRecap.length === 0 ? (
                <tr>
                  <td colSpan={3} className="py-6 text-center text-slate-400">
                    Belum ada penjualan produk
                  </td>
                </tr>
              ) : (
                productRecap.map((p) => (
                  <tr key={p.name} className="hover:bg-slate-50/80">
                    <td className="py-2.5 px-3.5 font-medium text-slate-800">{p.name}</td>
                    <td className="py-2.5 px-3.5 text-center font-semibold">{formatNumber(p.qty)}</td>
                    <td className="py-2.5 px-3.5 text-right font-bold text-emerald-700 tabular-nums">
                      {formatIdr(p.subtotal)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 8. Sub-View #9: Laporan Penjualan per Tipe Pelanggan (Gambar 9)
// ============================================================================

export const SubViewTipePelanggan: React.FC<{
  roomSales: RoomSaleRow[];
  posItems: PosItemSaleRow[];
}> = ({ roomSales, posItems }) => {
  const [selectedSegment, setSelectedSegment] = useState<string>('ALL');
  const [innerTab, setInnerTab] = useState<'ringkasan' | 'grafik' | 'detail'>('grafik');

  const records = useMemo(() => {
    const rList = roomSales.map((r) => ({
      id: `r-${r.reservation_id}`,
      bid: r.booking_code,
      date: r.tx_date,
      customer: r.guest_name || 'Tamu Hotel',
      segment: r.guest_segment || 'Reguler',
      item: `Kamar ${r.room_number} (${r.room_type_name})`,
      amount: r.is_complimentary ? 0 : Number(r.total_price) || 0,
    }));
    const pList = posItems.map((p) => ({
      id: `p-${p.order_item_id}`,
      bid: p.booking_or_order_no,
      date: p.tx_date,
      customer: p.customer_name || 'Walk-In POS',
      segment: p.guest_segment || 'Walk-In POS',
      item: `${p.item_name} (x${p.quantity})`,
      amount: p.is_complimentary ? 0 : Number(p.line_total) || 0,
    }));
    return [...rList, ...pList];
  }, [roomSales, posItems]);

  const segments = useMemo(() => {
    const s = new Set<string>();
    for (const r of records) s.add(r.segment);
    return Array.from(s);
  }, [records]);

  const filtered =
    selectedSegment === 'ALL'
      ? records
      : records.filter((r) => r.segment === selectedSegment);

  const totalRevenue = filtered.reduce((s, r) => s + r.amount, 0);
  const activeCustomers = new Set(filtered.map((r) => r.customer.toLowerCase())).size;
  const avgPerTx = filtered.length > 0 ? Math.round(totalRevenue / filtered.length) : 0;

  const bySegment = useMemo(() => {
    const map = new Map<
      string,
      { segment: string; revenue: number; txCount: number; customers: Set<string> }
    >();
    for (const r of filtered) {
      const cur = map.get(r.segment) || {
        segment: r.segment,
        revenue: 0,
        txCount: 0,
        customers: new Set<string>(),
      };
      cur.revenue += r.amount;
      cur.txCount += 1;
      cur.customers.add(r.customer.toLowerCase());
      map.set(r.segment, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue);
  }, [filtered]);

  const largestSegment = bySegment[0];

  const byDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of filtered) {
      map.set(r.date, (map.get(r.date) || 0) + r.amount);
    }
    return Array.from(map.entries())
      .map(([date, amount]) => ({ date, amount }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [filtered]);

  const maxSegRev = Math.max(1, ...bySegment.map((s) => s.revenue));
  const maxSegTx = Math.max(1, ...bySegment.map((s) => s.txCount));
  const maxDateRev = Math.max(1, ...byDate.map((d) => d.amount));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <LaporanDropdown<string>
          value={selectedSegment}
          onChange={setSelectedSegment}
          variant="outline"
          options={[
            { value: 'ALL', label: 'Semua Tipe Pelanggan' },
            ...segments.map((seg) => ({ value: seg, label: seg })),
          ]}
        />
      </div>

      {/* 4 KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
          <div className="text-[11px] text-slate-500 font-medium">Total Pendapatan</div>
          <div className="text-xl font-extrabold text-emerald-700 mt-1 tabular-nums">
            {formatIdr(totalRevenue)}
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5">{filtered.length} transaksi</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
          <div className="text-[11px] text-slate-500 font-medium">Pelanggan Aktif</div>
          <div className="text-xl font-extrabold text-blue-700 mt-1 tabular-nums">
            {activeCustomers}
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5">dari {bySegment.length} tipe</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
          <div className="text-[11px] text-slate-500 font-medium">Rata-rata / Transaksi</div>
          <div className="text-xl font-extrabold text-purple-700 mt-1 tabular-nums">
            {formatIdr(avgPerTx)}
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5">semua tipe</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
          <div className="text-[11px] text-slate-500 font-medium">Tipe Terbesar</div>
          <div className="text-xl font-extrabold text-amber-600 mt-1 truncate">
            {largestSegment?.segment || '-'}
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5">
            {largestSegment ? formatIdr(largestSegment.revenue) : 'Rp 0'}
          </div>
        </div>
      </div>

      {/* Switch [ Ringkasan | Grafik | Detail Transaksi ] */}
      <div className="inline-flex items-center gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200">
        {(['ringkasan', 'grafik', 'detail'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setInnerTab(tab)}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
              innerTab === tab
                ? 'bg-emerald-900 text-white shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {tab === 'ringkasan'
              ? 'Ringkasan'
              : tab === 'grafik'
              ? 'Grafik'
              : 'Detail Transaksi'}
          </button>
        ))}
      </div>

      {innerTab === 'grafik' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* 1. Pendapatan per Tipe Pelanggan */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-3">
            <div className="text-xs font-bold text-slate-800">Pendapatan per Tipe Pelanggan</div>
            {bySegment.map((s) => {
              const pct = Math.max(4, Math.round((s.revenue / maxSegRev) * 100));
              return (
                <div key={s.segment} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="font-semibold text-slate-700">{s.segment}</span>
                    <span className="font-bold text-slate-900 tabular-nums">
                      {formatIdr(s.revenue)}
                    </span>
                  </div>
                  <div className="h-3 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-indigo-500 rounded-full"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* 2. Kontribusi Pendapatan */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-3">
            <div className="text-xs font-bold text-slate-800">Kontribusi Pendapatan</div>
            <div className="flex items-center gap-6 py-2">
              <div className="w-28 h-28 rounded-full border-[14px] border-indigo-500 flex items-center justify-center shrink-0">
                <div className="text-center">
                  <div className="text-xs font-extrabold text-slate-800">100%</div>
                  <div className="text-[10px] text-slate-400">{bySegment.length} tipe</div>
                </div>
              </div>
              <div className="space-y-2 flex-1 text-xs">
                {bySegment.map((s) => {
                  const share =
                    totalRevenue > 0 ? ((s.revenue / totalRevenue) * 100).toFixed(1) : '0.0';
                  return (
                    <div key={s.segment} className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 font-medium text-slate-700">
                        <span className="w-2.5 h-2.5 rounded-full bg-indigo-500 inline-block" />
                        {s.segment}
                      </span>
                      <span className="font-bold text-slate-800 tabular-nums">{share}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* 3. Jumlah Transaksi per Tipe */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-3">
            <div className="text-xs font-bold text-slate-800">Jumlah Transaksi per Tipe</div>
            {bySegment.map((s) => {
              const pct = Math.max(4, Math.round((s.txCount / maxSegTx) * 100));
              return (
                <div key={s.segment} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="font-semibold text-slate-700">{s.segment}</span>
                    <span className="font-bold text-slate-900 tabular-nums">
                      {s.txCount} transaksi ({s.customers.size} plg)
                    </span>
                  </div>
                  <div className="h-3 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-emerald-600 rounded-full"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* 4. Tren Harian per Tipe */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-3">
            <div className="text-xs font-bold text-slate-800">Tren Harian per Tipe</div>
            {byDate.length === 0 ? (
              <div className="text-xs text-slate-400 py-6 text-center">Belum ada data harian</div>
            ) : (
              <div className="h-36 flex items-end gap-1.5 pt-4 overflow-x-auto">
                {byDate.map((d) => {
                  const hPct = Math.max(6, Math.round((d.amount / maxDateRev) * 100));
                  return (
                    <div
                      key={d.date}
                      className="flex-1 min-w-[24px] flex flex-col items-center gap-1 group"
                      title={`${d.date}: ${formatIdr(d.amount)}`}
                    >
                      <div className="w-full h-24 flex items-end justify-center">
                        <div
                          className="w-full max-w-[22px] bg-indigo-500 group-hover:bg-indigo-600 rounded-t transition-all"
                          style={{ height: `${hPct}%` }}
                        />
                      </div>
                      <span className="text-[9px] text-slate-400 truncate">
                        {d.date.slice(8, 10)}/{d.date.slice(5, 7)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {innerTab === 'ringkasan' && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-auto max-h-[480px]">
          <table className="min-w-full text-xs divide-y divide-slate-200">
            <thead className="sticky top-0 z-20 bg-slate-50 text-slate-600 font-semibold text-[11px] shadow-2xs">
              <tr>
                <th className="py-2.5 px-3.5 text-left">Tipe Pelanggan</th>
                <th className="py-2.5 px-3.5 text-center">Pelanggan Aktif</th>
                <th className="py-2.5 px-3.5 text-center">Jumlah Transaksi</th>
                <th className="py-2.5 px-3.5 text-right">Total Pendapatan</th>
                <th className="py-2.5 px-3.5 text-right">Kontribusi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {bySegment.map((s) => (
                <tr key={s.segment} className="hover:bg-slate-50/80">
                  <td className="py-2.5 px-3.5 font-bold text-slate-800">{s.segment}</td>
                  <td className="py-2.5 px-3.5 text-center">{s.customers.size}</td>
                  <td className="py-2.5 px-3.5 text-center font-semibold">{s.txCount}</td>
                  <td className="py-2.5 px-3.5 text-right font-bold text-emerald-700 tabular-nums">
                    {formatIdr(s.revenue)}
                  </td>
                  <td className="py-2.5 px-3.5 text-right font-semibold text-slate-600">
                    {totalRevenue > 0 ? ((s.revenue / totalRevenue) * 100).toFixed(1) : '0.0'}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {innerTab === 'detail' && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
          <div className="max-h-96 overflow-y-auto">
            <table className="min-w-full text-xs divide-y divide-slate-200">
              <thead className="bg-slate-50 text-slate-600 font-semibold text-[11px] sticky top-0">
                <tr>
                  <th className="py-2.5 px-3.5 text-left">No. Booking</th>
                  <th className="py-2.5 px-3.5 text-left">Tanggal</th>
                  <th className="py-2.5 px-3.5 text-left">Pelanggan</th>
                  <th className="py-2.5 px-3.5 text-left">Tipe Pelanggan</th>
                  <th className="py-2.5 px-3.5 text-left">Item / Kamar</th>
                  <th className="py-2.5 px-3.5 text-right">Nominal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50/80">
                    <td className="py-2.5 px-3.5 font-mono text-[11px] font-semibold text-blue-700">
                      {r.bid}
                    </td>
                    <td className="py-2.5 px-3.5 text-slate-600">{r.date}</td>
                    <td className="py-2.5 px-3.5 font-semibold text-slate-800">{r.customer}</td>
                    <td className="py-2.5 px-3.5">
                      <span className="px-2 py-0.5 rounded bg-indigo-50 text-indigo-800 text-[10px] font-bold">
                        {r.segment}
                      </span>
                    </td>
                    <td className="py-2.5 px-3.5 text-slate-700">{r.item}</td>
                    <td className="py-2.5 px-3.5 text-right font-bold text-emerald-700 tabular-nums">
                      {formatIdr(r.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 9. Sub-View #10: Laporan PPN / Pajak Keluaran (Gambar 7)
// ============================================================================

export const SubViewLaporanPpn: React.FC<{ data: AnalyticsHubData }> = ({ data }) => {
  const [ppnMode, setPpnMode] = useState<'ALL' | 'INCLUDE' | 'EXCLUDE'>('ALL');
  const includeTaxByDefault = Boolean(data.pricing_settings?.prices_include_tax);

  const taxRows = useMemo(() => {
    const rows: {
      key: string;
      bid: string;
      date: string;
      customer: string;
      label: string;
      kind: 'INCLUDE' | 'EXCLUDE';
      dpp: number;
      ppn: number;
      total: number;
    }[] = [];

    for (const r of data.room_sales || []) {
      const tax = Number(r.tax_amount) || 0;
      if (tax <= 0) continue;
      const total = Number(r.total_price) || 0;
      const kind = includeTaxByDefault ? 'INCLUDE' : 'EXCLUDE';
      const dpp = Math.max(0, total - tax);
      rows.push({
        key: `r-${r.reservation_id}`,
        bid: r.booking_code,
        date: r.tx_date,
        customer: r.guest_name,
        label: `Kamar ${r.room_number} (${r.room_type_name})`,
        kind,
        dpp,
        ppn: tax,
        total,
      });
    }

    for (const p of data.pos_item_sales || []) {
      const tax = Number(p.tax_amount) || 0;
      if (tax <= 0) continue;
      const total = Number(p.line_total) || 0;
      const kind = includeTaxByDefault ? 'INCLUDE' : 'EXCLUDE';
      const dpp = Math.max(0, total - tax);
      rows.push({
        key: `p-${p.order_item_id}`,
        bid: p.booking_or_order_no,
        date: p.tx_date,
        customer: p.customer_name,
        label: p.item_name,
        kind,
        dpp,
        ppn: tax,
        total,
      });
    }

    return rows;
  }, [data, includeTaxByDefault]);

  const incRows = taxRows.filter((r) => r.kind === 'INCLUDE');
  const excRows = taxRows.filter((r) => r.kind === 'EXCLUDE');

  const dppInc = incRows.reduce((s, r) => s + r.dpp, 0);
  const dppExc = excRows.reduce((s, r) => s + r.dpp, 0);
  const ppnInc = incRows.reduce((s, r) => s + r.ppn, 0);
  const ppnExc = excRows.reduce((s, r) => s + r.ppn, 0);

  const visibleRows =
    ppnMode === 'ALL' ? taxRows : taxRows.filter((r) => r.kind === ppnMode);

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-4">
        <div className="text-sm font-bold text-slate-800">Laporan PPN (Pajak Keluaran)</div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-4">
            <div className="text-xs text-slate-500 font-medium">Total DPP (Include & Exclude)</div>
            <div className="text-xl font-extrabold text-slate-900 mt-1 tabular-nums">
              {formatIdr(dppInc + dppExc)}
            </div>
            <div className="text-[11px] text-slate-400 mt-1">
              Include: {formatIdr(dppInc)} • Exclude: {formatIdr(dppExc)}
            </div>
          </div>

          <div className="bg-amber-50/60 border border-amber-200 rounded-xl p-4">
            <div className="text-xs text-amber-800 font-medium">Total PPN (Include & Exclude)</div>
            <div className="text-xl font-extrabold text-amber-700 mt-1 tabular-nums">
              {formatIdr(ppnInc + ppnExc)}
            </div>
            <div className="text-[11px] text-amber-700 mt-1">
              Include: {formatIdr(ppnInc)} • Exclude: {formatIdr(ppnExc)}
            </div>
          </div>

          <div className="bg-blue-50/60 border border-blue-200 rounded-xl p-4">
            <div className="text-xs text-blue-700 font-medium">Jumlah Transaksi</div>
            <div className="text-xl font-extrabold text-blue-700 mt-1 tabular-nums">
              {taxRows.length}
            </div>
            <div className="text-[11px] text-blue-600 mt-1">
              Include: {incRows.length} • Exclude: {excRows.length}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {(
            [
              { key: 'ALL', label: 'Semua' },
              { key: 'INCLUDE', label: 'PPN Include' },
              { key: 'EXCLUDE', label: 'PPN Exclude' },
            ] as const
          ).map((btn) => (
            <button
              key={btn.key}
              type="button"
              onClick={() => setPpnMode(btn.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                ppnMode === btn.key
                  ? 'bg-emerald-900 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70'
              }`}
            >
              {btn.label}
            </button>
          ))}
        </div>

        {visibleRows.length === 0 ? (
          <div className="py-10 text-center text-xs text-slate-400">
            Tidak ada transaksi dengan PPN pada periode ini.
          </div>
        ) : (
          <div className="overflow-auto max-h-[calc(100vh-280px)]">
            <table className="min-w-full text-xs divide-y divide-slate-200">
              <thead className="sticky top-0 z-20 bg-slate-50 text-slate-600 font-semibold text-[11px] shadow-2xs">
                <tr>
                  <th className="py-2.5 px-3.5 text-left">No. Booking</th>
                  <th className="py-2.5 px-3.5 text-left">Tanggal</th>
                  <th className="py-2.5 px-3.5 text-left">Pelanggan</th>
                  <th className="py-2.5 px-3.5 text-left">Item / Kamar</th>
                  <th className="py-2.5 px-3.5 text-center">Jenis PPN</th>
                  <th className="py-2.5 px-3.5 text-right">DPP</th>
                  <th className="py-2.5 px-3.5 text-right">PPN</th>
                  <th className="py-2.5 px-3.5 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibleRows.map((r) => (
                  <tr key={r.key} className="hover:bg-slate-50/80">
                    <td className="py-2.5 px-3.5 font-mono text-[11px] font-semibold text-blue-700">
                      {r.bid}
                    </td>
                    <td className="py-2.5 px-3.5 text-slate-600">{r.date}</td>
                    <td className="py-2.5 px-3.5 font-medium text-slate-800">{r.customer}</td>
                    <td className="py-2.5 px-3.5 text-slate-700">{r.label}</td>
                    <td className="py-2.5 px-3.5 text-center">
                      <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-bold">
                        PPN {r.kind}
                      </span>
                    </td>
                    <td className="py-2.5 px-3.5 text-right tabular-nums">{formatIdr(r.dpp)}</td>
                    <td className="py-2.5 px-3.5 text-right font-semibold text-amber-700 tabular-nums">
                      {formatIdr(r.ppn)}
                    </td>
                    <td className="py-2.5 px-3.5 text-right font-bold text-emerald-700 tabular-nums">
                      {formatIdr(r.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// 11. SUB-VIEW: LAPORAN OVERNIGHT VS DAY USE (Gambar 4 Request)
// ============================================================================
export const SubViewOvernightVsDayUse: React.FC<{
  roomSales: RoomSaleRow[];
  showRoomRateCol?: boolean;
}> = ({ roomSales, showRoomRateCol = false }) => {
  const [stayFilter, setStayFilter] = useState<'ALL' | 'OVERNIGHT' | 'DAY_USE'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  const isDayUseStay = (r: RoomSaleRow): boolean => {
    const st = String(r.stay_type || '').toUpperCase();
    if (st.includes('DAY') || st.includes('SHORT') || st.includes('TRANSIT')) return true;
    const ci = String(r.check_in || '').slice(0, 10);
    const co = String(r.check_out || '').slice(0, 10);
    return Boolean(ci && co && ci === co);
  };

  const overnightRows = roomSales.filter((r) => !isDayUseStay(r));
  const dayUseRows = roomSales.filter((r) => isDayUseStay(r));

  const calcMetrics = (rows: RoomSaleRow[]) => {
    const paidRows = rows.filter((r) => !r.is_complimentary);
    const compRows = rows.filter((r) => Boolean(r.is_complimentary));
    const count = rows.length;
    const nightsOrSessions = rows.reduce((s, r) => s + Math.max(1, Number(r.nights) || 1), 0);
    const netRev = paidRows.reduce((s, r) => s + (Number(r.total_price) || 0), 0);
    const disc = paidRows.reduce((s, r) => s + (Number(r.discount_amount) || 0), 0);
    const grossRev = netRev + disc;
    const paidAmount = paidRows.reduce(
      (s, r) => s + (Number(r.amount_paid) > 0 ? Number(r.amount_paid) : Number(r.total_price) || 0),
      0
    );
    const adr = nightsOrSessions > 0 ? Math.round(netRev / nightsOrSessions) : 0;
    return {
      count,
      paidCount: paidRows.length,
      compCount: compRows.length,
      nightsOrSessions,
      grossRev,
      disc,
      netRev,
      paidAmount,
      adr,
    };
  };

  const ov = calcMetrics(overnightRows);
  const du = calcMetrics(dayUseRows);
  const totalNetRev = ov.netRev + du.netRev;
  const totalCount = ov.count + du.count;
  const ovRevPct = totalNetRev > 0 ? Math.round((ov.netRev / totalNetRev) * 1000) / 10 : 0;
  const duRevPct = totalNetRev > 0 ? Math.round((du.netRev / totalNetRev) * 1000) / 10 : 0;
  const ovCountPct = totalCount > 0 ? Math.round((ov.count / totalCount) * 1000) / 10 : 0;
  const duCountPct = totalCount > 0 ? Math.round((du.count / totalCount) * 1000) / 10 : 0;

  // Per room-type comparison
  const roomTypeMap = new Map<
    string,
    {
      roomTypeName: string;
      ovCount: number;
      ovNights: number;
      ovRev: number;
      duCount: number;
      duSessions: number;
      duRev: number;
    }
  >();
  for (const r of roomSales) {
    const rtName = r.room_type_name || 'Lainnya';
    const cur = roomTypeMap.get(rtName) || {
      roomTypeName: rtName,
      ovCount: 0,
      ovNights: 0,
      ovRev: 0,
      duCount: 0,
      duSessions: 0,
      duRev: 0,
    };
    const rev = r.is_complimentary ? 0 : Number(r.total_price) || 0;
    const dur = Math.max(1, Number(r.nights) || 1);
    if (isDayUseStay(r)) {
      cur.duCount += 1;
      cur.duSessions += dur;
      cur.duRev += rev;
    } else {
      cur.ovCount += 1;
      cur.ovNights += dur;
      cur.ovRev += rev;
    }
    roomTypeMap.set(rtName, cur);
  }
  const roomTypeBreakdown = Array.from(roomTypeMap.values()).sort(
    (a, b) => b.ovRev + b.duRev - (a.ovRev + a.duRev)
  );

  const q = searchQuery.trim().toLowerCase();
  const filteredDetailRows = roomSales.filter((r) => {
    const dayUse = isDayUseStay(r);
    if (stayFilter === 'OVERNIGHT' && dayUse) return false;
    if (stayFilter === 'DAY_USE' && !dayUse) return false;
    if (q) {
      const hit =
        String(r.booking_code || '').toLowerCase().includes(q) ||
        String(r.guest_name || '').toLowerCase().includes(q) ||
        String(r.room_number || '').toLowerCase().includes(q) ||
        String(r.room_type_name || '').toLowerCase().includes(q);
      if (!hit) return false;
    }
    return true;
  });

  const handleExportExcel = () => {
    downloadExportXml('Laporan_Overnight_vs_DayUse.xls', [
      {
        name: 'Ringkasan Overnight vs DayUse',
        rows: [
          [
            'Kategori Menginap',
            'Jumlah Reservasi',
            'Malam / Sesi',
            'Gross Revenue (Rp)',
            'Diskon (Rp)',
            'Net Revenue (Rp)',
            'Rata-rata Tarif / ADR (Rp)',
            'Porsi Pendapatan (%)',
          ],
          [
            'Overnight (Menginap)',
            ov.count,
            ov.nightsOrSessions,
            ov.grossRev,
            ov.disc,
            ov.netRev,
            ov.adr,
            ovRevPct,
          ],
          [
            'Day Use / Short Time',
            du.count,
            du.nightsOrSessions,
            du.grossRev,
            du.disc,
            du.netRev,
            du.adr,
            duRevPct,
          ],
          [
            'TOTAL',
            totalCount,
            ov.nightsOrSessions + du.nightsOrSessions,
            ov.grossRev + du.grossRev,
            ov.disc + du.disc,
            totalNetRev,
            '',
            100,
          ],
        ],
      },
      {
        name: 'Rincian Reservasi',
        rows: [
          [
            'No. Booking',
            'Tipe Menginap',
            'Tamu',
            'Kamar',
            'Tipe Kamar',
            'Check-In',
            'Check-Out',
            'Durasi',
            'Diskon (Rp)',
            'Total Tagihan (Rp)',
            'Dibayar (Rp)',
            'Metode Bayar',
            'Status',
          ],
          ...filteredDetailRows.map((r) => {
            const dayUse = isDayUseStay(r);
            return [
              r.booking_code,
              dayUse ? 'Day Use' : 'Overnight',
              r.guest_name,
              r.room_number,
              r.room_type_name,
              r.check_in,
              r.check_out,
              dayUse ? '1 sesi (Day Use)' : `${r.nights} malam`,
              Number(r.discount_amount) || 0,
              r.is_complimentary ? 0 : Number(r.total_price) || 0,
              r.is_complimentary ? 0 : Number(r.amount_paid) || 0,
              r.payment_method || '-',
              r.reservation_status,
            ];
          }),
        ],
      },
    ]);
  };

  return (
    <div className="space-y-4 min-w-0">
      {/* Header Card & Export Buttons */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 shadow-xs space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-bold text-slate-900">
              Laporan Penjualan Kamar: Overnight vs Day Use
            </h4>
            <p className="text-xs text-slate-500 mt-0.5">
              Perbandingan reservasi menginap (Overnight) dan penggunaan harian (Day Use / Short Time) — tidak termasuk reservasi batal
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.print()}
              className="px-3 py-1.5 rounded-lg border border-rose-200 bg-rose-50/60 hover:bg-rose-100/70 text-rose-700 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
            >
              <IconFileText className="w-3.5 h-3.5" />
              <span>PDF</span>
            </button>
            <button
              type="button"
              onClick={handleExportExcel}
              className="px-3 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50/60 hover:bg-emerald-100/70 text-emerald-800 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
            >
              <IconFileSpreadsheet className="w-3.5 h-3.5" />
              <span>EXCEL</span>
            </button>
          </div>
        </div>

        {/* 3 Comparison Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
          {/* Card 1: Overnight */}
          <div className="bg-emerald-50/60 border border-emerald-200 rounded-xl p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-extrabold uppercase tracking-wider text-emerald-900">
                Overnight (Menginap)
              </span>
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                {ovRevPct}% Revenue
              </span>
            </div>
            <div className="text-xl font-extrabold text-emerald-800 tabular-nums">
              {formatIdr(ov.netRev)}
            </div>
            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-emerald-200/70 text-[11px]">
              <div>
                <div className="text-slate-500">Reservasi</div>
                <div className="font-bold text-slate-900 tabular-nums">
                  {formatNumber(ov.count)} ({ovCountPct}%)
                </div>
              </div>
              <div>
                <div className="text-slate-500">Total Malam</div>
                <div className="font-bold text-slate-900 tabular-nums">
                  {formatNumber(ov.nightsOrSessions)} mlm
                </div>
              </div>
              <div>
                <div className="text-slate-500">ADR / Malam</div>
                <div className="font-bold text-emerald-800 tabular-nums">{formatIdr(ov.adr)}</div>
              </div>
            </div>
          </div>

          {/* Card 2: Day Use */}
          <div className="bg-sky-50/70 border border-sky-200 rounded-xl p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-extrabold uppercase tracking-wider text-sky-900">
                Day Use / Short Time
              </span>
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-sky-100 text-sky-800">
                {duRevPct}% Revenue
              </span>
            </div>
            <div className="text-xl font-extrabold text-sky-800 tabular-nums">
              {formatIdr(du.netRev)}
            </div>
            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-sky-200/70 text-[11px]">
              <div>
                <div className="text-slate-500">Reservasi</div>
                <div className="font-bold text-slate-900 tabular-nums">
                  {formatNumber(du.count)} ({duCountPct}%)
                </div>
              </div>
              <div>
                <div className="text-slate-500">Total Sesi</div>
                <div className="font-bold text-slate-900 tabular-nums">
                  {formatNumber(du.nightsOrSessions)} sesi
                </div>
              </div>
              <div>
                <div className="text-slate-500">Rata-rata / Sesi</div>
                <div className="font-bold text-sky-800 tabular-nums">{formatIdr(du.adr)}</div>
              </div>
            </div>
          </div>

          {/* Card 3: Total Combined */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-extrabold uppercase tracking-wider text-slate-700">
                Total Penjualan Kamar
              </span>
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-200 text-slate-700">
                {formatNumber(totalCount)} Reservasi
              </span>
            </div>
            <div className="text-xl font-extrabold text-slate-900 tabular-nums">
              {formatIdr(totalNetRev)}
            </div>
            <div className="space-y-1.5 pt-2 border-t border-slate-200 text-[11px]">
              <div className="w-full h-2.5 rounded-full bg-slate-200 overflow-hidden flex">
                <div
                  className="bg-emerald-600 h-full transition-all"
                  style={{ width: `${ovRevPct}%` }}
                  title={`Overnight: ${ovRevPct}%`}
                />
                <div
                  className="bg-sky-500 h-full transition-all"
                  style={{ width: `${duRevPct}%` }}
                  title={`Day Use: ${duRevPct}%`}
                />
              </div>
              <div className="flex items-center justify-between text-[10px] text-slate-600 font-semibold">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-emerald-600 inline-block" />
                  Overnight {ovRevPct}%
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-sky-500 inline-block" />
                  Day Use {duRevPct}%
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Rekap Per Tipe Kamar Table */}
        {roomTypeBreakdown.length > 0 && (
          <div className="pt-2">
            <div className="text-xs font-bold text-slate-800 mb-2">
              Rekapitulasi Overnight vs Day Use per Tipe Kamar
            </div>
            <div className="overflow-auto max-h-[480px] border border-slate-200 rounded-xl">
              <table className="min-w-full text-xs divide-y divide-slate-200">
                <thead className="sticky top-0 z-20 bg-slate-50 text-slate-600 font-semibold text-[11px] shadow-2xs">
                  <tr>
                    <th className="py-2.5 px-3.5 text-left">Tipe Kamar</th>
                    <th className="py-2.5 px-3.5 text-right">Resv Overnight</th>
                    <th className="py-2.5 px-3.5 text-right">Malam Overnight</th>
                    <th className="py-2.5 px-3.5 text-right">Pendapatan Overnight</th>
                    <th className="py-2.5 px-3.5 text-right">Resv Day Use</th>
                    <th className="py-2.5 px-3.5 text-right">Sesi Day Use</th>
                    <th className="py-2.5 px-3.5 text-right">Pendapatan Day Use</th>
                    <th className="py-2.5 px-3.5 text-right">Total Pendapatan</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {roomTypeBreakdown.map((rt) => (
                    <tr key={rt.roomTypeName} className="hover:bg-slate-50/80">
                      <td className="py-2 px-3.5 font-bold text-slate-900 whitespace-nowrap">
                        {rt.roomTypeName}
                      </td>
                      <td className="py-2 px-3.5 text-right tabular-nums text-slate-700">
                        {formatNumber(rt.ovCount)}
                      </td>
                      <td className="py-2 px-3.5 text-right tabular-nums text-slate-700">
                        {formatNumber(rt.ovNights)} mlm
                      </td>
                      <td className="py-2 px-3.5 text-right font-semibold tabular-nums text-emerald-700 whitespace-nowrap">
                        {formatIdr(rt.ovRev)}
                      </td>
                      <td className="py-2 px-3.5 text-right tabular-nums text-slate-700">
                        {formatNumber(rt.duCount)}
                      </td>
                      <td className="py-2 px-3.5 text-right tabular-nums text-slate-700">
                        {formatNumber(rt.duSessions)} sesi
                      </td>
                      <td className="py-2 px-3.5 text-right font-semibold tabular-nums text-sky-700 whitespace-nowrap">
                        {formatIdr(rt.duRev)}
                      </td>
                      <td className="py-2 px-3.5 text-right font-extrabold tabular-nums text-slate-900 whitespace-nowrap">
                        {formatIdr(rt.ovRev + rt.duRev)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Detail Table Card */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 shadow-xs space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {(
              [
                { key: 'ALL', label: `Semua (${roomSales.length})` },
                { key: 'OVERNIGHT', label: `Overnight (${overnightRows.length})` },
                { key: 'DAY_USE', label: `Day Use (${dayUseRows.length})` },
              ] as const
            ).map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setStayFilter(tab.key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                  stayFilter === tab.key
                    ? 'bg-emerald-900 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="relative w-full sm:w-72">
            <IconSearch className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari booking, tamu, kamar..."
              className="w-full border border-slate-300 bg-white rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-hidden focus:ring-1 focus:ring-emerald-600"
            />
          </div>
        </div>

        <div className="overflow-x-auto max-h-[480px] overflow-y-auto border border-slate-200 rounded-xl">
          <table className="min-w-full text-xs divide-y divide-slate-200">
            <thead className="sticky top-0 z-10 bg-slate-50 text-slate-600 font-semibold text-[11px]">
              <tr>
                <th className="py-2.5 px-3 text-left">No. Booking</th>
                <th className="py-2.5 px-3 text-center">Kategori</th>
                <th className="py-2.5 px-3 text-left">Tamu</th>
                <th className="py-2.5 px-3 text-left">Kamar</th>
                <th className="py-2.5 px-3 text-left">Check-In</th>
                <th className="py-2.5 px-3 text-left">Check-Out</th>
                <th className="py-2.5 px-3 text-center">Durasi</th>
                <th className="py-2.5 px-3 text-right">Diskon</th>
                <th className="py-2.5 px-3 text-right">Total Biaya</th>
                {showRoomRateCol && <th className="py-2.5 px-3 text-right">Room Rate</th>}
                <th className="py-2.5 px-3 text-left">Metode Bayar</th>
                <th className="py-2.5 px-3 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredDetailRows.length === 0 ? (
                <tr>
                  <td colSpan={showRoomRateCol ? 12 : 11} className="py-10 text-center text-slate-400">
                    Tidak ada data reservasi untuk filter ini.
                  </td>
                </tr>
              ) : (
                filteredDetailRows.map((r) => {
                  const dayUse = isDayUseStay(r);
                  const totalBiaya = Number(r.total_price) || 0;
                  const nights = Math.max(1, Number(r.period_nights ?? r.nights) || 1);
                  const roomRate = dayUse
                    ? totalBiaya
                    : Number(r.room_rate) > 0
                    ? Number(r.room_rate)
                    : Math.round(totalBiaya / nights);
                  return (
                    <tr key={r.reservation_id} className="hover:bg-slate-50/80">
                      <td className="py-2.5 px-3 font-mono text-[11px] font-semibold text-blue-700 whitespace-nowrap">
                        {r.booking_code}
                      </td>
                      <td className="py-2.5 px-3 text-center whitespace-nowrap">
                        <span
                          className={`inline-block text-[10px] px-2 py-0.5 rounded-full font-bold ${
                            dayUse
                              ? 'bg-sky-100 text-sky-800'
                              : 'bg-emerald-100 text-emerald-800'
                          }`}
                        >
                          {dayUse ? 'Day Use' : 'Overnight'}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 font-semibold text-slate-900 whitespace-nowrap">
                        {r.guest_name}
                      </td>
                      <td className="py-2.5 px-3 text-slate-700 whitespace-nowrap">
                        {r.room_number} {r.room_type_name}
                      </td>
                      <td className="py-2.5 px-3 text-slate-600 whitespace-nowrap">
                        {String(r.check_in || '').slice(0, 10)}
                      </td>
                      <td className="py-2.5 px-3 text-slate-600 whitespace-nowrap">
                        {String(r.check_out || '').slice(0, 10)}
                      </td>
                      <td className="py-2.5 px-3 text-center text-slate-700 whitespace-nowrap">
                        {dayUse ? '1 sesi' : `${r.nights} malam`}
                      </td>
                      <td className="py-2.5 px-3 text-right tabular-nums text-purple-700 whitespace-nowrap">
                        {Number(r.discount_amount) > 0 ? formatIdr(r.discount_amount) : '-'}
                      </td>
                      <td className="py-2.5 px-3 text-right font-bold tabular-nums text-emerald-700 whitespace-nowrap">
                        {r.is_complimentary ? 'Complimentary' : formatIdr(totalBiaya)}
                      </td>
                      {showRoomRateCol && (
                        <td className="py-2.5 px-3 text-right font-semibold tabular-nums text-slate-700 whitespace-nowrap">
                          {r.is_complimentary ? '-' : formatIdr(roomRate)}
                        </td>
                      )}
                      <td className="py-2.5 px-3 text-slate-700 whitespace-nowrap">
                        {r.payment_method || '-'}
                      </td>
                      <td className="py-2.5 px-3 text-center whitespace-nowrap">
                        <span className="text-[10px] px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-bold">
                          {r.reservation_status}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
