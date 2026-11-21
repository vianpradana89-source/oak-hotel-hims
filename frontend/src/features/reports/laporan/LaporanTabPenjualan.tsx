import React, { useState } from 'react';
import {
  LoadingState,
  ErrorState,
  EmptyState,
  LaporanDropdown,
  formatIdr,
  formatNumber,
} from './laporanUi';
import {
  IconBadgePercent,
  IconBarChart3,
  IconBedDouble,
  IconCheck,
  IconCopy,
  IconFileText,
  IconGift,
  IconGlobe,
  IconLayers,
  IconPackage,
  IconReceipt,
  IconSearch,
  IconUsers,
  IconXCircle,
} from './LaporanIcons';
import {
  BuktiBayarModal,
  type BuktiBayarModalInfo,
  ColumnFilterHeader,
  type ColumnFilterState,
  type SortDirection,
  SubViewDibatalkan,
  SubViewLaporanPpn,
  SubViewOvernightVsDayUse,
  SubViewPenjualanLabaRugi,
  SubViewRekapItem,
  SubViewSumberPenjualan,
  SubViewSumberTransaksi,
  SubViewTipePelanggan,
} from './penjualanSubViews';
import type {
  AnalyticsHubData,
  FinancialsData,
  PosItemSaleRow,
  RoomSaleRow,
} from './laporanTypes';
import type { LaporanError } from './useLaporanWorkspace';

export type SalesReportMode =
  | 'rincian_penjualan'
  | 'penjualan_kamar'
  | 'overnight_vs_dayuse'
  | 'penjualan_item'
  | 'sumber_penjualan'
  | 'sumber_transaksi'
  | 'laba_rugi'
  | 'dibatalkan'
  | 'rekap_item'
  | 'tipe_pelanggan'
  | 'ppn'
  | 'complimentary_only'
  | 'discounted_only';

export const SALES_MODE_OPTIONS: {
  value: SalesReportMode;
  label: string;
  icon: React.ReactNode;
}[] = [
  {
    value: 'rincian_penjualan',
    label: 'Laporan Rincian Penjualan',
    icon: <IconFileText className="w-3.5 h-3.5" />,
  },
  {
    value: 'penjualan_kamar',
    label: 'Laporan Penjualan Kamar',
    icon: <IconBedDouble className="w-3.5 h-3.5" />,
  },
  {
    value: 'overnight_vs_dayuse',
    label: 'Laporan Overnight vs Day Use',
    icon: <IconBedDouble className="w-3.5 h-3.5" />,
  },
  {
    value: 'penjualan_item',
    label: 'Laporan Penjualan Item',
    icon: <IconPackage className="w-3.5 h-3.5" />,
  },
  {
    value: 'sumber_penjualan',
    label: 'Laporan Sumber Penjualan',
    icon: <IconGlobe className="w-3.5 h-3.5" />,
  },
  {
    value: 'sumber_transaksi',
    label: 'Laporan Sumber Transaksi',
    icon: <IconLayers className="w-3.5 h-3.5" />,
  },
  {
    value: 'laba_rugi',
    label: 'Laporan Laba/Rugi',
    icon: <IconBarChart3 className="w-3.5 h-3.5" />,
  },
  {
    value: 'dibatalkan',
    label: 'Laporan Dibatalkan',
    icon: <IconXCircle className="w-3.5 h-3.5" />,
  },
  {
    value: 'rekap_item',
    label: 'Laporan Rekap Item',
    icon: <IconPackage className="w-3.5 h-3.5" />,
  },
  {
    value: 'tipe_pelanggan',
    label: 'Laporan Penjualan per Tipe Pelanggan',
    icon: <IconUsers className="w-3.5 h-3.5" />,
  },
  {
    value: 'ppn',
    label: 'Laporan PPN',
    icon: <IconReceipt className="w-3.5 h-3.5" />,
  },
  {
    value: 'complimentary_only',
    label: 'Khusus Complimentary / Free',
    icon: <IconGift className="w-3.5 h-3.5" />,
  },
  {
    value: 'discounted_only',
    label: 'Khusus Transaksi Diskon',
    icon: <IconBadgePercent className="w-3.5 h-3.5" />,
  },
];

export interface LaporanTabPenjualanProps {
  data: AnalyticsHubData | null;
  financials?: FinancialsData | null;
  loading: boolean;
  error: LaporanError | null;
  onRetry: () => void;
  subView?: SalesReportMode;
  onSubViewChange?: (mode: SalesReportMode) => void;
}

interface UnifiedSaleRow {
  key: string;
  source: 'POS' | 'KAMAR';
  bookingOrOrderNo: string;
  txDate: string;
  txDisplayDate: string;
  customerName: string;
  itemName: string;
  roomLabel: string;
  durationOrQty: string;
  grossTotal: number;
  roomRate: number;
  discountAmount: number;
  amountPaid: number;
  statusBadge: string;
  paymentMethod: string;
  attachmentId: number | null;
  paymentEvidenceId: number | null;
  hpp: number;
  unitPrice: number;
  profit: number;
  isComplimentary: boolean;
  estimatedCompValue: number;
}

function formatShortStatusBadge(source: 'POS' | 'KAMAR', rawStatus: string, isComp: boolean): string {
  if (isComp) return 'COMP';
  const u = String(rawStatus || '').toUpperCase();
  if (source === 'KAMAR') {
    if (u === 'CHECKED_OUT' || u === 'CO') return 'CO';
    if (u === 'CHECKED_IN' || u === 'CI') return 'CI';
    return 'BO';
  }
  if (u === 'PAID' || u === 'COMPLETED' || u === 'CLOSED' || u === 'SELESAI') return 'Selesai';
  return rawStatus || 'Selesai';
}

function formatCompactOrderNo(raw: string): string {
  const s = String(raw || '').trim();
  const m = /^POS-(\d{4})(\d{4})-([0-9a-fA-F]{4,8})/i.exec(s);
  if (m) {
    return `POS-${m[1].slice(2)}${m[2]}-${m[3].slice(0, 4).toUpperCase()}`;
  }
  if (s.length > 22) {
    return `${s.slice(0, 14)}…${s.slice(-4)}`;
  }
  return s || '-';
}

export const LaporanTabPenjualan: React.FC<LaporanTabPenjualanProps> = ({
  data,
  financials,
  loading,
  error,
  onRetry,
  subView,
  onSubViewChange,
}) => {
  const [internalMode, setInternalMode] = useState<SalesReportMode>('rincian_penjualan');
  const reportMode = subView ?? internalMode;
  const setReportMode = onSubViewChange ?? setInternalMode;

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [copiedBid, setCopiedBid] = useState<string | null>(null);
  const [columnFilters, setColumnFilters] = useState<Record<string, ColumnFilterState>>({});
  const [activeSortCol, setActiveSortCol] = useState<{ col: string; dir: SortDirection } | null>(
    null
  );
  const [buktiModal, setBuktiModal] = useState<BuktiBayarModalInfo | null>(null);

  if (loading && !data) return <LoadingState label="Memuat data penjualan..." />;
  if (error && !data) return <ErrorState message={error.message} onRetry={onRetry} />;
  if (!data) return <EmptyState title="Belum ada data" message="Pilih periode untuk memuat laporan." />;

  const posItems: PosItemSaleRow[] = data.pos_item_sales || [];
  const roomSales: RoomSaleRow[] = data.room_sales || [];
  const cancelledBookings = data.cancelled_bookings || [];

  const unifiedPosRows: UnifiedSaleRow[] = posItems.map((i) => {
    const qty = Number(i.quantity) || 1;
    const unitPrice = Number(i.unit_price) || 0;
    const disc = Number(i.discount_amount) || 0;
    const netTotal = Number(i.line_total) || 0;
    const grossTotal = netTotal + disc;
    const hpp = Number(i.total_hpp) || 0;
    const isComp = Boolean(i.is_complimentary);
    const amountPaid = isComp ? 0 : netTotal;
    const profit = amountPaid - hpp;
    const statusBadge = formatShortStatusBadge('POS', i.payment_status, isComp);

    return {
      key: `pos-${i.order_item_id}`,
      source: 'POS',
      bookingOrOrderNo: i.booking_or_order_no,
      txDate: i.tx_date,
      txDisplayDate: i.tx_datetime || i.tx_date,
      customerName: i.customer_name || 'Walk-In POS',
      itemName: `${i.item_name} (x${qty})`,
      roomLabel: i.room_or_table && i.room_or_table !== '-' ? i.room_or_table : '-',
      durationOrQty: `${qty} item`,
      grossTotal,
      roomRate: unitPrice,
      discountAmount: disc,
      amountPaid,
      statusBadge,
      paymentMethod: i.payment_method || 'Cash',
      attachmentId: i.attachment_id ?? null,
      paymentEvidenceId: null,
      hpp,
      unitPrice,
      profit,
      isComplimentary: isComp,
      estimatedCompValue: isComp ? qty * unitPrice : 0,
    };
  });

  const unifiedRoomRows: UnifiedSaleRow[] = roomSales.map((r) => {
    const netTotal = Number(r.total_price) || 0;
    const disc = Number(r.discount_amount) || 0;
    const isComp = Boolean(r.is_complimentary);
    const grossTotal = isComp ? netTotal : netTotal + disc;
    const paidRaw = Number(r.amount_paid) || 0;
    const remRaw = Number(r.remaining_balance) || 0;
    const isOtaCollect = String(r.payment_method || '').toUpperCase().includes('OTA COLLECT');
    const amountPaid = isComp
      ? 0
      : paidRaw > 0
      ? Math.min(netTotal, paidRaw)
      : remRaw <= 0 || isOtaCollect
      ? netTotal
      : 0;
    const nights = Number(r.period_nights ?? r.nights) || 1;
    const totalStayNights = Number(r.total_stay_nights ?? r.nights) || nights;
    const stayUpper = String(r.stay_type || '').toUpperCase();
    const isDayUse = stayUpper.includes('DAY') || stayUpper.includes('SHORT');
    const roomRate = isDayUse
      ? grossTotal
      : Number(r.room_rate) > 0
      ? Number(r.room_rate)
      : nights > 0
      ? Math.round(grossTotal / nights)
      : grossTotal;
    const durationLabel = isDayUse
      ? 'Day Use'
      : nights < totalStayNights
      ? `${nights} malam (dari ${totalStayNights} mlm)`
      : `${nights} malam`;
    const roomLabel =
      r.room_number && r.room_number !== '-'
        ? `${r.room_number} ${r.room_type_name} (${r.room_number})`
        : r.room_type_name || '-';
    const statusBadge = formatShortStatusBadge('KAMAR', r.reservation_status, isComp);

    return {
      key: `room-${r.reservation_id}`,
      source: 'KAMAR',
      bookingOrOrderNo: r.booking_code,
      txDate: r.tx_date,
      txDisplayDate: r.tx_datetime || r.tx_date,
      customerName: r.guest_name || 'Tamu Hotel',
      itemName: '-',
      roomLabel,
      durationOrQty: durationLabel,
      grossTotal,
      roomRate,
      discountAmount: disc,
      amountPaid,
      statusBadge,
      paymentMethod: r.payment_method || 'Cash',
      attachmentId: r.attachment_id ?? null,
      paymentEvidenceId: r.payment_evidence_id ?? null,
      hpp: 0,
      unitPrice: roomRate,
      profit: isComp ? 0 : netTotal,
      isComplimentary: isComp,
      estimatedCompValue: Number(r.estimated_comp_value) || 0,
    };
  });

  // Period-wide Complimentary & Discount KPI numbers (always consistent across Kamar & POS)
  const allCompRoomCount = unifiedRoomRows.filter((r) => r.isComplimentary).length;
  const allCompPosCount = unifiedPosRows.filter((r) => r.isComplimentary).length;
  const allCompTotalCount = allCompRoomCount + allCompPosCount;
  const allCompEstValue =
    unifiedRoomRows
      .filter((r) => r.isComplimentary)
      .reduce((s, r) => s + r.estimatedCompValue, 0) +
    unifiedPosRows
      .filter((r) => r.isComplimentary)
      .reduce((s, r) => s + r.estimatedCompValue, 0);

  const discSummary = data.discount_summary;
  const roomDiscountTotal =
    discSummary?.room_discount_total ??
    unifiedRoomRows.reduce((s, r) => s + r.discountAmount, 0);
  const posDiscountTotal =
    discSummary?.pos_discount_total ??
    unifiedPosRows.reduce((s, r) => s + r.discountAmount, 0);
  const totalDiscountAmount =
    discSummary?.total_discount_amount ?? roomDiscountTotal + posDiscountTotal;

  const showRoomRateCol = false;

  // Delegate specialized sub-views (4 through 11)
  if (reportMode === 'overnight_vs_dayuse') {
    return <SubViewOvernightVsDayUse roomSales={roomSales} showRoomRateCol={false} />;
  }
  if (reportMode === 'sumber_penjualan') {
    return <SubViewSumberPenjualan roomSales={roomSales} />;
  }
  if (reportMode === 'sumber_transaksi') {
    return <SubViewSumberTransaksi roomSales={roomSales} posItems={posItems} />;
  }
  if (reportMode === 'laba_rugi') {
    return (
      <SubViewPenjualanLabaRugi
        roomSales={roomSales}
        posItems={posItems}
        financials={financials}
      />
    );
  }
  if (reportMode === 'dibatalkan') {
    return <SubViewDibatalkan cancelled={cancelledBookings} />;
  }
  if (reportMode === 'rekap_item') {
    return <SubViewRekapItem roomSales={roomSales} posItems={posItems} />;
  }
  if (reportMode === 'tipe_pelanggan') {
    return <SubViewTipePelanggan roomSales={roomSales} posItems={posItems} />;
  }
  if (reportMode === 'ppn') {
    return <SubViewLaporanPpn data={data} />;
  }

  // Table-based views: rincian_penjualan, penjualan_kamar, penjualan_item, complimentary_only, discounted_only
  let modeRows: UnifiedSaleRow[] = [];
  if (reportMode === 'penjualan_item') {
    modeRows = unifiedPosRows;
  } else if (reportMode === 'penjualan_kamar') {
    modeRows = unifiedRoomRows;
  } else if (reportMode === 'complimentary_only') {
    modeRows = [...unifiedRoomRows, ...unifiedPosRows].filter((r) => r.isComplimentary);
  } else if (reportMode === 'discounted_only') {
    modeRows = [...unifiedRoomRows, ...unifiedPosRows].filter((r) => r.discountAmount > 0);
  } else {
    modeRows = [...unifiedRoomRows, ...unifiedPosRows];
  }

  const getColumnDisplayValue = (r: UnifiedSaleRow, colKey: string): string => {
    switch (colKey) {
      case 'bookingOrOrderNo':
        return r.bookingOrOrderNo || '-';
      case 'txDate':
        return r.txDisplayDate || r.txDate || '-';
      case 'customerName':
        return r.customerName || '-';
      case 'itemName':
        return r.itemName || '-';
      case 'roomLabel':
        return r.roomLabel || '-';
      case 'durationOrQty':
        return r.durationOrQty || '-';
      case 'grossTotal':
        return formatIdr(r.grossTotal);
      case 'roomRate':
        return r.source === 'KAMAR' ? formatIdr(r.roomRate) : '-';
      case 'discountAmount':
        return r.discountAmount > 0 ? formatIdr(r.discountAmount) : '-';
      case 'amountPaid':
        return formatIdr(r.amountPaid);
      case 'statusBadge':
        return r.statusBadge || '-';
      case 'paymentMethod':
        return r.paymentMethod || '-';
      case 'buktiBayar':
        return 'Lihat';
      case 'hpp':
        return r.hpp > 0 ? formatIdr(r.hpp) : 'Rp 0';
      case 'unitPrice':
        return formatIdr(r.unitPrice);
      case 'profit':
        return formatIdr(r.profit);
      default:
        return '-';
    }
  };

  const handleApplyColFilter = (
    colKey: string,
    selected: Set<string> | undefined,
    sortDir: SortDirection
  ) => {
    setColumnFilters((prev) => ({
      ...prev,
      [colKey]: { selectedValues: selected, sortDir },
    }));
    if (sortDir) {
      setActiveSortCol({ col: colKey, dir: sortDir });
    } else if (activeSortCol?.col === colKey) {
      setActiveSortCol(null);
    }
  };

  const q = searchQuery.trim().toLowerCase();
  const filteredRows = modeRows
    .filter((r) => {
      if (q) {
        const hit =
          r.bookingOrOrderNo.toLowerCase().includes(q) ||
          r.customerName.toLowerCase().includes(q) ||
          r.itemName.toLowerCase().includes(q) ||
          r.roomLabel.toLowerCase().includes(q) ||
          r.paymentMethod.toLowerCase().includes(q);
        if (!hit) return false;
      }
      for (const [colKey, state] of Object.entries(columnFilters)) {
        if (state.selectedValues !== undefined) {
          const val = getColumnDisplayValue(r, colKey);
          if (!state.selectedValues.has(val)) return false;
        }
      }
      return true;
    })
    .sort((a, b) => {
      if (!activeSortCol || !activeSortCol.dir) {
        return b.txDisplayDate.localeCompare(a.txDisplayDate);
      }
      const { col, dir } = activeSortCol;
      const numericCols = new Set([
        'grossTotal',
        'roomRate',
        'discountAmount',
        'amountPaid',
        'hpp',
        'unitPrice',
        'profit',
      ]);
      if (numericCols.has(col)) {
        const na = Number((a as any)[col]) || 0;
        const nb = Number((b as any)[col]) || 0;
        return dir === 'asc' ? na - nb : nb - na;
      }
      const va = getColumnDisplayValue(a, col);
      const vb = getColumnDisplayValue(b, col);
      return dir === 'asc' ? va.localeCompare(vb, 'id-ID') : vb.localeCompare(va, 'id-ID');
    });

  const totalTxCount = filteredRows.length;
  const totalGrossAmount = filteredRows.reduce((s, r) => s + r.grossTotal, 0);
  const totalPaidAmount = filteredRows.reduce((s, r) => s + r.amountPaid, 0);
  const totalHppAmount = filteredRows.reduce((s, r) => s + r.hpp, 0);
  const totalProfitAmount = filteredRows.reduce((s, r) => s + r.profit, 0);

  const handleCopyBid = (bid: string) => {
    if (navigator?.clipboard) {
      void navigator.clipboard.writeText(bid);
    }
    setCopiedBid(bid);
    setTimeout(() => setCopiedBid((prev) => (prev === bid ? null : prev)), 1500);
  };

  const isPosItemOnlyView = reportMode === 'penjualan_item';
  const isRoomOnlyView = reportMode === 'penjualan_kamar';

  const colVals = (colKey: string) => modeRows.map((r) => getColumnDisplayValue(r, colKey));

  return (
    <div className="space-y-4 min-w-0">
      {/* Top Search & Optional Mode Switcher (if not rendered in parent leftSlot) */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {!subView && (
          <LaporanDropdown<SalesReportMode>
            value={reportMode}
            options={SALES_MODE_OPTIONS}
            onChange={setReportMode}
            variant="primary"
          />
        )}

        <div className="flex-1 min-w-[220px] max-w-md relative">
          <IconSearch className="w-3.5 h-3.5 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Cari No. Booking, pelanggan, item, kamar..."
            className="w-full border border-slate-300 bg-white rounded-lg pl-9 pr-3.5 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-hidden focus:ring-1 focus:ring-emerald-600"
          />
        </div>

        {Object.keys(columnFilters).some(
          (k) => columnFilters[k]?.selectedValues !== undefined || columnFilters[k]?.sortDir
        ) && (
          <button
            type="button"
            onClick={() => {
              setColumnFilters({});
              setActiveSortCol(null);
            }}
            className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-rose-700 hover:bg-rose-50 cursor-pointer"
          >
            Reset Filter Kolom
          </button>
        )}
      </div>

      {/* 7 KPI Cards (Total Transaksi, Total Biaya, Total Diskon, Jumlah Bayar, Total HPP, Total Laba, Complimentary) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-7 gap-3">
        <div className="bg-white border border-slate-200 rounded-xl p-3.5 shadow-xs min-w-0">
          <div className="text-[11px] text-slate-500 font-medium truncate">Total Transaksi</div>
          <div className="text-lg font-extrabold text-slate-900 mt-1 tabular-nums truncate">
            {formatNumber(totalTxCount)}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3.5 shadow-xs min-w-0">
          <div className="text-[11px] text-slate-500 font-medium truncate">Total Biaya</div>
          <div className="text-lg font-extrabold text-emerald-700 mt-1 tabular-nums truncate">
            {formatIdr(totalGrossAmount)}
          </div>
        </div>
        <div className="bg-purple-50/60 border border-purple-200 rounded-xl p-3.5 shadow-xs min-w-0">
          <div className="flex items-center gap-1 text-[11px] text-purple-800 font-semibold">
            <IconBadgePercent className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">Total Diskon</span>
          </div>
          <div className="text-base font-extrabold text-purple-900 mt-1 tabular-nums truncate">
            {formatIdr(totalDiscountAmount)}
          </div>
          <div className="text-[10px] text-purple-700 mt-0.5 truncate">
            Kmr: {formatIdr(roomDiscountTotal)} • POS: {formatIdr(posDiscountTotal)}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3.5 shadow-xs min-w-0">
          <div className="text-[11px] text-slate-500 font-medium truncate">Jumlah Bayar</div>
          <div className="text-lg font-extrabold text-emerald-700 mt-1 tabular-nums truncate">
            {formatIdr(totalPaidAmount)}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3.5 shadow-xs min-w-0">
          <div className="text-[11px] text-slate-500 font-medium truncate">Total HPP</div>
          <div className="text-lg font-extrabold text-orange-600 mt-1 tabular-nums truncate">
            {formatIdr(totalHppAmount)}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3.5 shadow-xs min-w-0">
          <div className="text-[11px] text-slate-500 font-medium truncate">Total Laba</div>
          <div className="text-lg font-extrabold text-blue-700 mt-1 tabular-nums truncate">
            {formatIdr(totalProfitAmount)}
          </div>
        </div>
        <div className="bg-amber-50/60 border border-amber-200 rounded-xl p-3.5 shadow-xs min-w-0">
          <div className="flex items-center gap-1 text-[11px] text-amber-800 font-semibold">
            <IconGift className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">Complimentary</span>
          </div>
          <div className="text-base font-extrabold text-amber-900 mt-1 tabular-nums truncate">
            {allCompTotalCount} transaksi
          </div>
          <div className="text-[10px] text-amber-700 mt-0.5 truncate">
            Kmr: {allCompRoomCount} • POS: {allCompPosCount} (Est. {formatIdr(allCompEstValue)})
          </div>
        </div>
      </div>

      {/* Main Table */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto max-h-[560px] overflow-y-auto min-h-[280px]">
          {isPosItemOnlyView ? (
            /* Gambar 14: Laporan Penjualan Item Table */
            <table className="min-w-full text-xs divide-y divide-slate-200">
              <thead className="sticky top-0 z-20 bg-slate-50 border-b border-slate-200">
                <tr>
                  <ColumnFilterHeader
                    columnKey="bookingOrOrderNo"
                    label="No. Booking"
                    allValues={colVals('bookingOrOrderNo')}
                    activeSelected={columnFilters.bookingOrOrderNo?.selectedValues}
                    activeSort={
                      activeSortCol?.col === 'bookingOrOrderNo' ? activeSortCol.dir : null
                    }
                    onApply={handleApplyColFilter}
                  />
                  <ColumnFilterHeader
                    columnKey="txDate"
                    label="Tanggal"
                    allValues={colVals('txDate')}
                    activeSelected={columnFilters.txDate?.selectedValues}
                    activeSort={activeSortCol?.col === 'txDate' ? activeSortCol.dir : null}
                    onApply={handleApplyColFilter}
                  />
                  <ColumnFilterHeader
                    columnKey="customerName"
                    label="Pelanggan"
                    allValues={colVals('customerName')}
                    activeSelected={columnFilters.customerName?.selectedValues}
                    activeSort={activeSortCol?.col === 'customerName' ? activeSortCol.dir : null}
                    onApply={handleApplyColFilter}
                  />
                  <ColumnFilterHeader
                    columnKey="itemName"
                    label="Item"
                    allValues={colVals('itemName')}
                    activeSelected={columnFilters.itemName?.selectedValues}
                    activeSort={activeSortCol?.col === 'itemName' ? activeSortCol.dir : null}
                    onApply={handleApplyColFilter}
                  />
                  <ColumnFilterHeader
                    columnKey="hpp"
                    label="HPP"
                    align="right"
                    allValues={colVals('hpp')}
                    activeSelected={columnFilters.hpp?.selectedValues}
                    activeSort={activeSortCol?.col === 'hpp' ? activeSortCol.dir : null}
                    onApply={handleApplyColFilter}
                  />
                  <ColumnFilterHeader
                    columnKey="unitPrice"
                    label="Harga Jual"
                    align="right"
                    allValues={colVals('unitPrice')}
                    activeSelected={columnFilters.unitPrice?.selectedValues}
                    activeSort={activeSortCol?.col === 'unitPrice' ? activeSortCol.dir : null}
                    onApply={handleApplyColFilter}
                  />
                  <ColumnFilterHeader
                    columnKey="profit"
                    label="Profit"
                    align="right"
                    allValues={colVals('profit')}
                    activeSelected={columnFilters.profit?.selectedValues}
                    activeSort={activeSortCol?.col === 'profit' ? activeSortCol.dir : null}
                    onApply={handleApplyColFilter}
                  />
                  <ColumnFilterHeader
                    columnKey="amountPaid"
                    label="Total"
                    align="right"
                    allValues={colVals('amountPaid')}
                    activeSelected={columnFilters.amountPaid?.selectedValues}
                    activeSort={activeSortCol?.col === 'amountPaid' ? activeSortCol.dir : null}
                    onApply={handleApplyColFilter}
                  />
                  <ColumnFilterHeader
                    columnKey="paymentMethod"
                    label="Metode Bayar"
                    allValues={colVals('paymentMethod')}
                    activeSelected={columnFilters.paymentMethod?.selectedValues}
                    activeSort={
                      activeSortCol?.col === 'paymentMethod' ? activeSortCol.dir : null
                    }
                    onApply={handleApplyColFilter}
                  />
                  <ColumnFilterHeader
                    columnKey="buktiBayar"
                    label="Bukti Bayar"
                    allValues={colVals('buktiBayar')}
                    activeSelected={columnFilters.buktiBayar?.selectedValues}
                    activeSort={activeSortCol?.col === 'buktiBayar' ? activeSortCol.dir : null}
                    onApply={handleApplyColFilter}
                  />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                {filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="py-10 text-center text-slate-400">
                      Tidak ada data penjualan item pada filter ini
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((row) => (
                    <tr key={row.key} className="hover:bg-slate-50/80 transition-colors">
                      <td className="py-2.5 px-3 font-mono text-[11px] text-blue-700 font-semibold whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleCopyBid(row.bookingOrOrderNo)}
                            title="Salin No. Booking"
                            className="text-slate-400 hover:text-slate-700 cursor-pointer"
                          >
                            {copiedBid === row.bookingOrOrderNo ? (
                              <IconCheck className="w-3.5 h-3.5 text-emerald-600" />
                            ) : (
                              <IconCopy className="w-3.5 h-3.5" />
                            )}
                          </button>
                          <span title={row.bookingOrOrderNo}>
                            {formatCompactOrderNo(row.bookingOrOrderNo)}
                          </span>
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-slate-600 whitespace-nowrap">
                        {row.txDisplayDate}
                      </td>
                      <td className="py-2.5 px-3 font-semibold text-blue-700">
                        {row.customerName}
                      </td>
                      <td className="py-2.5 px-3 text-slate-800">{row.itemName}</td>
                      <td className="py-2.5 px-3 text-right tabular-nums text-orange-600">
                        {row.hpp > 0 ? formatIdr(row.hpp) : '-'}
                      </td>
                      <td className="py-2.5 px-3 text-right tabular-nums text-slate-700">
                        {formatIdr(row.unitPrice)}
                      </td>
                      <td className="py-2.5 px-3 text-right tabular-nums text-blue-600 font-semibold">
                        {formatIdr(row.profit)}
                      </td>
                      <td className="py-2.5 px-3 text-right font-bold tabular-nums text-emerald-700">
                        {formatIdr(row.amountPaid)}
                      </td>
                      <td className="py-2.5 px-3 text-slate-700">{row.paymentMethod}</td>
                      <td className="py-2.5 px-3">
                        <button
                          type="button"
                          onClick={() =>
                            setBuktiModal({
                              bookingOrOrderNo: row.bookingOrOrderNo,
                              txDate: row.txDisplayDate,
                              customerName: row.customerName,
                              roomLabel: row.roomLabel,
                              itemLabel: row.itemName,
                              totalAmount: row.grossTotal,
                              amountPaid: row.amountPaid,
                              paymentMethod: row.paymentMethod,
                              statusLabel: row.statusBadge,
                              attachmentId: row.attachmentId,
                              paymentEvidenceId: row.paymentEvidenceId,
                            })
                          }
                          className="text-blue-600 hover:underline font-semibold text-xs cursor-pointer"
                        >
                          Lihat
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          ) : (
            /* Gambar 4 & Gambar 15: Exact 14-Column Order (or 13-Column when Room-only) */
            <table className="min-w-full text-xs divide-y divide-slate-200">
              <thead className="sticky top-0 z-20 bg-slate-50 border-b border-slate-200">
                <tr>
                  <ColumnFilterHeader
                    columnKey="bookingOrOrderNo"
                    label="No. Booking"
                    allValues={colVals('bookingOrOrderNo')}
                    activeSelected={columnFilters.bookingOrOrderNo?.selectedValues}
                    activeSort={
                      activeSortCol?.col === 'bookingOrOrderNo' ? activeSortCol.dir : null
                    }
                    onApply={handleApplyColFilter}
                  />
                  <ColumnFilterHeader
                    columnKey="txDate"
                    label="Tanggal"
                    allValues={colVals('txDate')}
                    activeSelected={columnFilters.txDate?.selectedValues}
                    activeSort={activeSortCol?.col === 'txDate' ? activeSortCol.dir : null}
                    onApply={handleApplyColFilter}
                  />
                  <ColumnFilterHeader
                    columnKey="customerName"
                    label="Pelanggan"
                    allValues={colVals('customerName')}
                    activeSelected={columnFilters.customerName?.selectedValues}
                    activeSort={activeSortCol?.col === 'customerName' ? activeSortCol.dir : null}
                    onApply={handleApplyColFilter}
                  />
                  {!isRoomOnlyView && (
                    <ColumnFilterHeader
                      columnKey="itemName"
                      label="Item"
                      allValues={colVals('itemName')}
                      activeSelected={columnFilters.itemName?.selectedValues}
                      activeSort={activeSortCol?.col === 'itemName' ? activeSortCol.dir : null}
                      onApply={handleApplyColFilter}
                    />
                  )}
                  <ColumnFilterHeader
                    columnKey="roomLabel"
                    label="Room"
                    allValues={colVals('roomLabel')}
                    activeSelected={columnFilters.roomLabel?.selectedValues}
                    activeSort={activeSortCol?.col === 'roomLabel' ? activeSortCol.dir : null}
                    onApply={handleApplyColFilter}
                  />
                  <ColumnFilterHeader
                    columnKey="durationOrQty"
                    label="Durasi/Qty"
                    allValues={colVals('durationOrQty')}
                    activeSelected={columnFilters.durationOrQty?.selectedValues}
                    activeSort={
                      activeSortCol?.col === 'durationOrQty' ? activeSortCol.dir : null
                    }
                    onApply={handleApplyColFilter}
                  />
                  <ColumnFilterHeader
                    columnKey="grossTotal"
                    label="Total Biaya"
                    align="right"
                    allValues={colVals('grossTotal')}
                    activeSelected={columnFilters.grossTotal?.selectedValues}
                    activeSort={activeSortCol?.col === 'grossTotal' ? activeSortCol.dir : null}
                    onApply={handleApplyColFilter}
                  />
                  {showRoomRateCol && (
                    <ColumnFilterHeader
                      columnKey="roomRate"
                      label="Room Rate"
                      align="right"
                      allValues={colVals('roomRate')}
                      activeSelected={columnFilters.roomRate?.selectedValues}
                      activeSort={activeSortCol?.col === 'roomRate' ? activeSortCol.dir : null}
                      onApply={handleApplyColFilter}
                    />
                  )}
                  <ColumnFilterHeader
                    columnKey="discountAmount"
                    label="Diskon"
                    align="right"
                    allValues={colVals('discountAmount')}
                    activeSelected={columnFilters.discountAmount?.selectedValues}
                    activeSort={
                      activeSortCol?.col === 'discountAmount' ? activeSortCol.dir : null
                    }
                    onApply={handleApplyColFilter}
                  />
                  <ColumnFilterHeader
                    columnKey="amountPaid"
                    label="Jumlah Bayar"
                    align="right"
                    allValues={colVals('amountPaid')}
                    activeSelected={columnFilters.amountPaid?.selectedValues}
                    activeSort={activeSortCol?.col === 'amountPaid' ? activeSortCol.dir : null}
                    onApply={handleApplyColFilter}
                  />
                  <ColumnFilterHeader
                    columnKey="statusBadge"
                    label="Status"
                    align="center"
                    allValues={colVals('statusBadge')}
                    activeSelected={columnFilters.statusBadge?.selectedValues}
                    activeSort={activeSortCol?.col === 'statusBadge' ? activeSortCol.dir : null}
                    onApply={handleApplyColFilter}
                  />
                  <ColumnFilterHeader
                    columnKey="paymentMethod"
                    label="Metode Bayar"
                    allValues={colVals('paymentMethod')}
                    activeSelected={columnFilters.paymentMethod?.selectedValues}
                    activeSort={
                      activeSortCol?.col === 'paymentMethod' ? activeSortCol.dir : null
                    }
                    onApply={handleApplyColFilter}
                  />
                  <ColumnFilterHeader
                    columnKey="buktiBayar"
                    label="Bukti Bayar"
                    allValues={colVals('buktiBayar')}
                    activeSelected={columnFilters.buktiBayar?.selectedValues}
                    activeSort={activeSortCol?.col === 'buktiBayar' ? activeSortCol.dir : null}
                    onApply={handleApplyColFilter}
                  />
                  <ColumnFilterHeader
                    columnKey="hpp"
                    label="HPP"
                    align="right"
                    allValues={colVals('hpp')}
                    activeSelected={columnFilters.hpp?.selectedValues}
                    activeSort={activeSortCol?.col === 'hpp' ? activeSortCol.dir : null}
                    onApply={handleApplyColFilter}
                  />
                  <ColumnFilterHeader
                    columnKey="profit"
                    label="Laba"
                    align="right"
                    allValues={colVals('profit')}
                    activeSelected={columnFilters.profit?.selectedValues}
                    activeSort={activeSortCol?.col === 'profit' ? activeSortCol.dir : null}
                    onApply={handleApplyColFilter}
                  />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                {filteredRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={(isRoomOnlyView ? 13 : 14) + (showRoomRateCol ? 1 : 0)}
                      className="py-10 text-center text-slate-400"
                    >
                      Tidak ada data penjualan pada filter ini
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((row) => (
                    <tr key={row.key} className="hover:bg-slate-50/80 transition-colors">
                      {/* 1. No. Booking */}
                      <td className="py-2.5 px-3 font-mono text-[11px] text-blue-700 font-semibold whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleCopyBid(row.bookingOrOrderNo)}
                            title="Salin No. Booking"
                            className="text-slate-400 hover:text-slate-700 cursor-pointer"
                          >
                            {copiedBid === row.bookingOrOrderNo ? (
                              <IconCheck className="w-3.5 h-3.5 text-emerald-600" />
                            ) : (
                              <IconCopy className="w-3.5 h-3.5" />
                            )}
                          </button>
                          <span title={row.bookingOrOrderNo}>
                            {formatCompactOrderNo(row.bookingOrOrderNo)}
                          </span>
                        </div>
                      </td>

                      {/* 2. Tanggal */}
                      <td className="py-2.5 px-3 text-slate-600 whitespace-nowrap">
                        {row.txDisplayDate}
                      </td>

                      {/* 3. Pelanggan */}
                      <td className="py-2.5 px-3 font-semibold text-blue-700 whitespace-nowrap">
                        {row.customerName}
                      </td>

                      {/* 4. Item (hidden in Room-only view per Gambar 15) */}
                      {!isRoomOnlyView && (
                        <td className="py-2.5 px-3 text-slate-800 whitespace-nowrap">
                          {row.itemName}
                        </td>
                      )}

                      {/* 5. Room */}
                      <td className="py-2.5 px-3 text-slate-700 whitespace-nowrap">
                        {row.roomLabel}
                      </td>

                      {/* 6. Durasi/Qty */}
                      <td className="py-2.5 px-3 text-slate-600 whitespace-nowrap">
                        {row.durationOrQty}
                      </td>

                      {/* 7. Total Biaya */}
                      <td className="py-2.5 px-3 text-right font-semibold tabular-nums text-emerald-700 whitespace-nowrap">
                        {formatIdr(row.grossTotal)}
                      </td>

                      {/* 7b. Room Rate (Total Biaya / Malam, hanya ditampilkan jika periode > 1 hari) */}
                      {showRoomRateCol && (
                        <td className="py-2.5 px-3 text-right font-semibold tabular-nums text-slate-700 whitespace-nowrap">
                          {row.source === 'KAMAR' ? formatIdr(row.roomRate) : '-'}
                        </td>
                      )}

                      {/* 8. Diskon */}
                      <td className="py-2.5 px-3 text-right tabular-nums text-purple-700 whitespace-nowrap">
                        {row.discountAmount > 0 ? formatIdr(row.discountAmount) : '-'}
                      </td>

                      {/* 9. Jumlah Bayar */}
                      <td className="py-2.5 px-3 text-right font-bold tabular-nums text-emerald-700 whitespace-nowrap">
                        {formatIdr(row.amountPaid)}
                      </td>

                      {/* 10. Status (BO / CI / CO / Selesai / COMP) */}
                      <td className="py-2.5 px-3 text-center whitespace-nowrap">
                        <span
                          className={`inline-block text-[10px] px-2.5 py-0.5 rounded font-bold ${
                            row.statusBadge === 'COMP'
                              ? 'bg-amber-100 text-amber-800'
                              : row.statusBadge === 'CO' || row.statusBadge === 'Selesai'
                              ? 'bg-emerald-100 text-emerald-800'
                              : row.statusBadge === 'CI'
                              ? 'bg-blue-100 text-blue-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {row.statusBadge}
                        </span>
                      </td>

                      {/* 11. Metode Bayar */}
                      <td className="py-2.5 px-3 text-slate-700 whitespace-nowrap">
                        {row.paymentMethod}
                      </td>

                      {/* 12. Bukti Bayar */}
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() =>
                            setBuktiModal({
                              bookingOrOrderNo: row.bookingOrOrderNo,
                              txDate: row.txDisplayDate,
                              customerName: row.customerName,
                              roomLabel: row.roomLabel,
                              itemLabel: row.itemName,
                              totalAmount: row.grossTotal,
                              amountPaid: row.amountPaid,
                              paymentMethod: row.paymentMethod,
                              statusLabel: row.statusBadge,
                              attachmentId: row.attachmentId,
                              paymentEvidenceId: row.paymentEvidenceId,
                            })
                          }
                          className="text-blue-600 hover:underline font-semibold text-xs cursor-pointer"
                        >
                          Lihat
                        </button>
                      </td>

                      {/* 13. HPP */}
                      <td className="py-2.5 px-3 text-right tabular-nums text-orange-600 whitespace-nowrap">
                        {formatIdr(row.hpp)}
                      </td>

                      {/* 14. Laba */}
                      <td className="py-2.5 px-3 text-right font-bold tabular-nums text-blue-600 whitespace-nowrap">
                        {formatIdr(row.profit)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
        <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-200 text-xs text-slate-500 flex items-center justify-between">
          <span>
            Menampilkan {filteredRows.length} dari {modeRows.length} data
          </span>
        </div>
      </div>

      {/* Modal Bukti Bayar */}
      <BuktiBayarModal info={buktiModal} onClose={() => setBuktiModal(null)} />
    </div>
  );
};
