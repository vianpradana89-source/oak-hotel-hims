import React, { useState } from 'react';
import {
  LoadingState,
  ErrorState,
  EmptyState,
  formatIdr,
  formatDecimalIdr,
  formatNumber,
} from './laporanUi';
import {
  IconBadgePercent,
  IconBedDouble,
  IconBuilding2,
  IconChevronDown,
  IconChevronUp,
  IconChevronRight,
  IconColumns2,
  IconDownload,
  IconFileSpreadsheet,
  IconFileText,
  IconGift,
  IconRows2,
  IconSearch,
  IconShoppingCart,
  IconTrendingDown,
  IconTrendingUp,
  IconWallet,
  IconX,
} from './LaporanIcons';
import { formatIndonesianLongDate } from './laporanPeriods';
import { downloadExportXml } from './exportLaporan';
import { printArusKasPdf, printLabaRugiPdf, printNeracaPdf } from './printAccountingPdf';
import type { DailyOperationsData } from './useDailyOperations';
import type {
  AnalyticsHubData,
  DailyOccupancyBarRow,
  ExpenseByCategory,
  FinancialsData,
  RoomRankingRow,
  RoomSaleRow,
} from './laporanTypes';

export type KeseluruhanSubView = 'ringkasan' | 'laba_rugi' | 'arus_kas' | 'neraca';

export interface LaporanTabKeseluruhanProps {
  dailyOps: DailyOperationsData | null;
  dailyOpsError: { endpoint: string; message: string } | null;
  financials: FinancialsData | null;
  financialsError: { endpoint: string; message: string } | null;
  analytics?: AnalyticsHubData | null;
  loading: boolean;
  onRetry: () => void;
  subView?: KeseluruhanSubView;
}

const MONTH_SHORT_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

function formatShortHotelDate(ymd: string): string {
  const parts = String(ymd || '').split('-');
  if (parts.length !== 3) return ymd;
  const day = parseInt(parts[2], 10);
  const monthIdx = parseInt(parts[1], 10) - 1;
  return `${day} ${MONTH_SHORT_ID[monthIdx] || parts[1]}`;
}

function formatMediumDateId(ymd: string): string {
  const parts = String(ymd || '').slice(0, 10).split('-');
  if (parts.length !== 3) return ymd;
  const day = parseInt(parts[2], 10);
  const monthIdx = parseInt(parts[1], 10) - 1;
  return `${day} ${MONTH_SHORT_ID[monthIdx] || parts[1]} ${parts[0]}`;
}

function formatReservationStatusBadge(status: string): { label: string; className: string } {
  const s = String(status || '').toUpperCase();
  if (s === 'CHECKED_IN') {
    return { label: 'Check In', className: 'bg-emerald-100 text-emerald-800 border border-emerald-200' };
  }
  if (s === 'CHECKED_OUT') {
    return { label: 'Check Out', className: 'bg-slate-100 text-slate-600 border border-slate-200' };
  }
  return { label: 'Booked', className: 'bg-blue-50 text-blue-700 border border-blue-200' };
}

function formatTimeRangeLabel(r: RoomSaleRow): string {
  const isShortTime = String(r.stay_type || '').toUpperCase().includes('SHORT');
  if (r.start_time && r.end_time) {
    const st = String(r.start_time).slice(11, 19) || '14:00:00';
    const et = String(r.end_time).slice(11, 19) || '12:00:00';
    return isShortTime ? `${st} - ${et} (Short Time)` : `${st} - ${et} (${r.nights} malam)`;
  }
  return `14:00:00 - 12:00:00 (${r.nights || 1} malam)`;
}

const ROOM_DOT_COLORS = [
  'bg-blue-600',
  'bg-rose-600',
  'bg-purple-600',
  'bg-sky-500',
  'bg-emerald-600',
  'bg-amber-600',
  'bg-teal-600',
];

export const LaporanTabKeseluruhan: React.FC<LaporanTabKeseluruhanProps> = ({
  dailyOps,
  dailyOpsError,
  financials,
  financialsError,
  analytics,
  loading,
  onRetry,
  subView = 'ringkasan',
}) => {
  const [roomSearch, setRoomSearch] = useState('');
  const [hoveredBarDate, setHoveredBarDate] = useState<string | null>(null);
  const [selectedDayModal, setSelectedDayModal] = useState<DailyOccupancyBarRow | null>(null);
  const [selectedRoomModal, setSelectedRoomModal] = useState<RoomRankingRow | null>(null);
  const [showArModal, setShowArModal] = useState(false);

  // Laba Rugi accordion state
  const [openPlSections, setOpenPlSections] = useState<Record<string, boolean>>({
    A: true,
    B: true,
    D: true,
    E: true,
    F: true,
  });

  // Neraca column layout toggle ('2col' | '1col')
  const [neracaLayout, setNeracaLayout] = useState<'2col' | '1col'>('2col');

  const togglePlSection = (key: string) => {
    setOpenPlSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const noData = !dailyOps && !financials && !analytics && !loading;
  const anyError = (dailyOpsError || financialsError) && noData;
  if (loading && noData) return <LoadingState label="Memuat ringkasan eksekutif..." />;
  if (anyError) {
    return (
      <ErrorState
        message={(dailyOpsError || financialsError)!.message}
        onRetry={onRetry}
      />
    );
  }
  if (!dailyOps && !financials && !analytics) {
    return <EmptyState title="Belum ada data" message="Pilih periode untuk memuat laporan." />;
  }

  // 1. Financial metrics (non-cancelled active reservations, POS orders & Minibar)
  const sb = financials?.sales_breakdown;
  const activeRoomSalesRows = (analytics?.room_sales || []).filter((r) => !r.is_complimentary);
  const activePosSalesRows = (analytics?.pos_item_sales || []).filter((p) => !p.is_complimentary);
  const activePosOnlySalesRows = activePosSalesRows.filter(
    (p) =>
      String(p.sale_source || '').toUpperCase() !== 'MINIBAR' &&
      !String(p.category_name || '').toLowerCase().includes('minibar')
  );
  const activeMinibarSalesRows = activePosSalesRows.filter(
    (p) =>
      String(p.sale_source || '').toUpperCase() === 'MINIBAR' ||
      String(p.category_name || '').toLowerCase().includes('minibar')
  );
  const roomSalesFromAnalytics =
    activeRoomSalesRows.length > 0
      ? activeRoomSalesRows.reduce((s, r) => s + (Number(r.total_price) || 0), 0)
      : (analytics?.room_ranking || []).reduce((s, r) => s + (Number(r.room_revenue) || 0), 0);
  const posSalesFromAnalytics = activePosOnlySalesRows.reduce(
    (s, p) => s + (Number(p.line_total) || 0),
    0
  );
  const minibarSalesFromAnalytics = activeMinibarSalesRows.reduce(
    (s, p) => s + (Number(p.line_total) || 0),
    0
  );

  const hasAnalyticsSales = Boolean(analytics?.room_sales || analytics?.pos_item_sales);
  const roomSalesTotal = hasAnalyticsSales
    ? roomSalesFromAnalytics
    : sb && sb.room_total > 0
    ? sb.room_total
    : roomSalesFromAnalytics;
  const posSalesTotal = hasAnalyticsSales
    ? posSalesFromAnalytics
    : sb && sb.pos_total > 0
    ? sb.pos_total
    : posSalesFromAnalytics;
  const minibarSalesTotal = hasAnalyticsSales
    ? minibarSalesFromAnalytics
    : sb && (sb.minibar_total ?? 0) > 0
    ? Number(sb.minibar_total)
    : minibarSalesFromAnalytics;
  const totalSales = roomSalesTotal + posSalesTotal + minibarSalesTotal;
  const roomPaidTotal = activeRoomSalesRows.reduce((s, r) => {
    const net = Number(r.total_price) || 0;
    const paidRaw = Number(r.amount_paid) || 0;
    const remRaw = Number(r.remaining_balance) || 0;
    const isOtaCollect = String(r.payment_method || '').toUpperCase().includes('OTA COLLECT');
    const paid = paidRaw > 0 ? Math.min(net, paidRaw) : remRaw <= 0 || isOtaCollect ? net : 0;
    return s + paid;
  }, 0);
  const posPaidTotal = activePosSalesRows.reduce((s, p) => {
    const st = String(p.payment_status || 'PAID').toUpperCase();
    const isUnpaid = st === 'UNPAID' || st === 'OPEN';
    return s + (isUnpaid ? 0 : Number(p.line_total) || 0);
  }, 0);
  const paidSalesTotal = hasAnalyticsSales ? roomPaidTotal + posPaidTotal : totalSales;
  const unpaidSalesTotal = Math.max(0, totalSales - paidSalesTotal);
  const activePosOrderCount = new Set(activePosSalesRows.map((i) => i.order_id)).size;
  const salesTxCount = hasAnalyticsSales
    ? activeRoomSalesRows.length + activePosOrderCount
    : (sb?.count ?? 0) ||
      (analytics?.room_ranking || []).reduce((s, r) => s + (Number(r.booking_count) || 0), 0) +
        activePosOrderCount;

  const otherIncomeTotal = financials?.other_income?.total ?? 0;
  const otherIncomeCount = financials?.other_income?.count ?? 0;

  const expenseTotal = financials?.expense?.total ?? 0;
  const expenseCount = financials?.expense?.count ?? 0;
  const purchaseTotal = financials?.purchase?.total ?? 0;
  const purchaseCount = financials?.purchase?.count ?? 0;
  const totalOutflow = expenseTotal + purchaseTotal;
  const totalOutflowCount = expenseCount + purchaseCount;

  // Complimentary metrics
  const compStays = analytics?.complimentary_stays || [];
  const compRoomCount = compStays.length;
  const compRoomNights = compStays.reduce((s, c) => s + (Number(c.nights) || 0), 0);
  const compRoomEstValue = compStays.reduce((s, c) => s + (Number(c.estimated_comp_value) || 0), 0);
  const compPosItems = (analytics?.pos_item_sales || []).filter((i) => i.is_complimentary);
  const compPosCount = compPosItems.length;
  const compPosEstValue = compPosItems.reduce(
    (s, i) => s + (Number(i.quantity) || 1) * (Number(i.unit_price) || 0),
    0
  );
  const totalCompEstValue = compRoomEstValue + compPosEstValue;

  // Discount metrics
  const discountSummary = analytics?.discount_summary;
  const roomDiscountFromRows = (analytics?.room_sales || []).filter(
    (r) => Number(r.discount_amount) > 0
  );
  const roomDiscountTotal =
    discountSummary?.room_discount_total ??
    roomDiscountFromRows.reduce((s, r) => s + (Number(r.discount_amount) || 0), 0);
  const roomDiscountCount = discountSummary?.room_discount_count ?? roomDiscountFromRows.length;
  const posDiscountTotal = discountSummary?.pos_discount_total ?? 0;
  const posDiscountCount = discountSummary?.pos_discount_count ?? 0;
  const totalDiscountAmount =
    discountSummary?.total_discount_amount ?? roomDiscountTotal + posDiscountTotal;

  const netIncome = totalSales + otherIncomeTotal - totalOutflow;

  // 2. Daily Occupancy Chart Data
  const dailyOcc = analytics?.daily_occupancy || [];
  const activeRoomsCount =
    dailyOcc[0]?.gross_rooms ?? dailyOps?.live_snapshot?.total_active_rooms ?? 0;
  const occPcts = dailyOcc.map((d) => Number(d.occupancy_pct) || 0);
  const avgOccPct =
    occPcts.length > 0 ? Math.round(occPcts.reduce((a, b) => a + b, 0) / occPcts.length) : 0;
  const maxOccPct = occPcts.length > 0 ? Math.round(Math.max(...occPcts)) : 0;
  const minOccPct = occPcts.length > 0 ? Math.round(Math.min(...occPcts)) : 0;

  // 3. Per-Room Ranking
  const roomRanking = analytics?.room_ranking || [];
  const totalRoomRankingRevenue = roomRanking.reduce((s, r) => s + (Number(r.room_revenue) || 0), 0);
  const q = roomSearch.trim().toLowerCase();
  const filteredRooms = q
    ? roomRanking.filter(
        (r) =>
          String(r.room_number || '').toLowerCase().includes(q) ||
          String(r.room_type_name || '').toLowerCase().includes(q) ||
          String(r.room_type_code || '').toLowerCase().includes(q)
      )
    : roomRanking;

  // 4. Live Snapshot Hari Ini
  const live = dailyOps?.live_snapshot;
  const biz = dailyOps?.business_date_metrics;
  const unpaidPurchaseAp = financials?.purchase?.unpaid_total ?? 0;

  // Room sales list for drilldown modals
  const allRoomSales: RoomSaleRow[] = analytics?.room_sales || [];

  // Reservations active on a specific hotel date [check_in, check_out) or check_in === date
  const getReservationsForDate = (ymd: string): RoomSaleRow[] => {
    return allRoomSales.filter((r) => {
      const ci = String(r.check_in || '').slice(0, 10);
      const co = String(r.check_out || '').slice(0, 10);
      return ci <= ymd && (co > ymd || ci === ymd);
    });
  };

  // Reservations for a specific physical room
  const getReservationsForRoom = (room: RoomRankingRow): RoomSaleRow[] => {
    return allRoomSales.filter(
      (r) =>
        (room.room_id && Number(r.room_id) === Number(room.room_id)) ||
        String(r.room_number || '') === String(room.room_number || '')
    );
  };

  const handleExportDayModal = (day: DailyOccupancyBarRow, rows: RoomSaleRow[]) => {
    downloadExportXml(`Okupansi_Harian_${day.date}.xls`, [
      {
        name: `Okupansi ${day.date}`,
        rows: [
          [
            'Tanggal',
            'No. Booking',
            'Tamu',
            'Kamar',
            'Tipe Kamar',
            'Check-In',
            'Check-Out',
            'Malam',
            'Diskon (Rp)',
            'Total Harga (Rp)',
            'Status',
          ],
          ...rows.map((r) => [
            day.date,
            r.booking_code,
            r.guest_name,
            r.room_number,
            r.room_type_name,
            r.check_in,
            r.check_out,
            r.nights,
            Number(r.discount_amount) || 0,
            Number(r.total_price) || 0,
            r.reservation_status,
          ]),
        ],
      },
    ]);
  };

  const handleExportRoomModal = (room: RoomRankingRow, rows: RoomSaleRow[]) => {
    downloadExportXml(`Okupansi_Kamar_${room.room_number}.xls`, [
      {
        name: `Kamar ${room.room_number}`,
        rows: [
          [
            'Kamar',
            'Tipe Kamar',
            'No. Booking',
            'Tamu',
            'Check-In',
            'Check-Out',
            'Malam',
            'Diskon (Rp)',
            'Total Harga (Rp)',
            'Status',
          ],
          ...rows.map((r) => [
            room.room_number,
            room.room_type_name,
            r.booking_code,
            r.guest_name,
            r.check_in,
            r.check_out,
            r.nights,
            Number(r.discount_amount) || 0,
            Number(r.total_price) || 0,
            r.reservation_status,
          ]),
        ],
      },
    ]);
  };

  // =========================================================================
  // SUB-VIEW 2: LAPORAN LABA / RUGI
  // =========================================================================
  if (subView === 'laba_rugi') {
    const pl = analytics?.accounting_statements?.profit_loss;
    const pendapatanKamar = pl?.revenue.room_sales ?? roomSalesTotal;
    const pendapatanPos = pl?.revenue.product_sales ?? posSalesTotal;
    const pendapatanMinibar = pl?.revenue.minibar_sales ?? minibarSalesTotal;
    const pendapatanLain = pl?.revenue.other_income ?? otherIncomeTotal;
    const potonganDiskon = pl?.revenue.returns_and_discounts ?? totalDiscountAmount;
    const subTotalPendapatan =
      pl?.revenue.total_revenue ?? pendapatanKamar + pendapatanPos + pendapatanMinibar + pendapatanLain;

    const hppProduk = pl?.cogs.sales_cogs ?? 0;
    const hppMinibar = pl?.cogs.minibar_cogs ?? 0;
    const subTotalHpp = pl?.cogs.total_cogs ?? hppProduk + hppMinibar;
    const labaKotor = pl?.gross_profit ?? subTotalPendapatan - subTotalHpp;

    const expCategories: ExpenseByCategory[] =
      pl?.expenses.by_category ?? financials?.expense?.by_category ?? [];
    const subTotalPengeluaran = pl?.expenses.total_expenses ?? expenseTotal;

    const stokKeluarVal = pl?.stock_adjustments.stock_out_cost ?? 0;
    const opnameStokVal = pl?.stock_adjustments.stock_opname_cost ?? 0;
    const totalStokVal = pl?.stock_adjustments.total_stock_cost ?? opnameStokVal - stokKeluarVal;

    const poDiskon = pl?.purchases_summary.purchase_discount ?? 0;
    const poPengiriman = pl?.purchases_summary.purchase_shipping ?? 0;
    const poPajak = pl?.purchases_summary.purchase_tax ?? 0;
    const totalPembelianAdj =
      pl?.purchases_summary.total_purchases ?? poDiskon - poPengiriman - poPajak;

    const labaBersih =
      pl?.net_profit ?? labaKotor - subTotalPengeluaran + totalStokVal + totalPembelianAdj;

    const handleExportPlExcel = () => {
      downloadExportXml(
        `Laporan_Laba_Rugi_${analytics?.start_date || 'HIMS'}_sd_${analytics?.end_date || 'HIMS'}.xls`,
        [
          {
            name: 'Laba Rugi',
            rows: [
              ['Bagian', 'Keterangan', 'Nilai (Rp)'],
              ['A. Pendapatan', 'Penjualan Kamar', pendapatanKamar],
              ['A. Pendapatan', 'Penjualan Produk & POS', pendapatanPos],
              ['A. Pendapatan', 'Penjualan Minibar', pendapatanMinibar],
              ['A. Pendapatan', 'Pemasukan Lain', pendapatanLain],
              ['A. Pendapatan', 'Info Diskon Kamar & POS', potonganDiskon],
              ['A. Pendapatan', 'Sub Total Pendapatan', subTotalPendapatan],
              ['B. Harga Pokok Penjualan', 'HPP Produk & F&B', hppProduk],
              ['B. Harga Pokok Penjualan', 'HPP Minibar', hppMinibar],
              ['B. Harga Pokok Penjualan', 'Sub Total HPP', subTotalHpp],
              ['C. Laba Kotor', 'Pendapatan - HPP', labaKotor],
              ...expCategories.map((c: ExpenseByCategory) => [
                'D. Pengeluaran',
                c.category_name,
                c.total,
              ]),
              ['D. Pengeluaran', 'Sub Total Pengeluaran', subTotalPengeluaran],
              ['E. Stok', 'Stok Keluar', stokKeluarVal],
              ['E. Stok', 'Opname Stok', opnameStokVal],
              ['E. Stok', 'Total Stok', totalStokVal],
              ['F. Pembelian', 'Diskon Pembelian', poDiskon],
              ['F. Pembelian', 'Biaya Pengiriman', poPengiriman],
              ['F. Pembelian', 'Pajak Pembelian', poPajak],
              ['F. Pembelian', 'Total Pembelian (Diskon - Pengiriman - Pajak)', totalPembelianAdj],
              ['G. Laba Bersih', 'Laba Bersih Periode Ini', labaBersih],
            ],
          },
        ]
      );
    };

    return (
      <div className="space-y-4">
        {/* Toolbar */}
        <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 shadow-xs flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-bold text-slate-900">Laporan Laba / Rugi</div>
            <div className="text-xs text-slate-500">
              Periode: {analytics?.start_date || financials?.start_date} s/d{' '}
              {analytics?.end_date || financials?.end_date}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                void printLabaRugiPdf({
                  startDate: String(analytics?.start_date || financials?.start_date || ''),
                  endDate: String(analytics?.end_date || financials?.end_date || ''),
                  pendapatanKamar,
                  pendapatanPos,
                  pendapatanMinibar,
                  pendapatanLain,
                  potonganDiskon,
                  subTotalPendapatan,
                  hppProduk,
                  hppMinibar,
                  subTotalHpp,
                  labaKotor,
                  expCategories,
                  subTotalPengeluaran,
                  stokKeluarVal,
                  opnameStokVal,
                  totalStokVal,
                  poDiskon,
                  poPengiriman,
                  poPajak,
                  totalPembelianAdj,
                  labaBersih,
                })
              }
              className="px-3 py-1.5 rounded-lg border border-rose-200 bg-rose-50/60 hover:bg-rose-100/70 text-rose-700 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
            >
              <IconFileText className="w-3.5 h-3.5" />
              <span>PDF</span>
            </button>
            <button
              type="button"
              onClick={handleExportPlExcel}
              className="px-3 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50/60 hover:bg-emerald-100/70 text-emerald-800 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
            >
              <IconFileSpreadsheet className="w-3.5 h-3.5" />
              <span>EXCEL</span>
            </button>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs space-y-4">
          {/* A. Pendapatan */}
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => togglePlSection('A')}
              className="w-full flex items-center justify-between px-4 py-3 bg-emerald-50/70 hover:bg-emerald-50 text-left transition-colors cursor-pointer"
            >
              <span className="text-xs font-bold text-emerald-900">A. Pendapatan</span>
              <span className="flex items-center gap-2 text-xs font-extrabold text-emerald-800 tabular-nums">
                <span>{formatIdr(subTotalPendapatan)}</span>
                {openPlSections.A ? (
                  <IconChevronUp className="w-4 h-4 text-slate-500" />
                ) : (
                  <IconChevronDown className="w-4 h-4 text-slate-500" />
                )}
              </span>
            </button>
            {openPlSections.A && (
              <div className="p-4 space-y-2 text-xs divide-y divide-slate-100">
                <div className="flex items-center justify-between py-1.5">
                  <span className="text-slate-600">Penjualan Kamar (Room Revenue)</span>
                  <span className="font-semibold text-slate-900 tabular-nums">
                    {formatIdr(pendapatanKamar)}
                  </span>
                </div>
                <div className="flex items-center justify-between py-1.5">
                  <span className="text-slate-600">Penjualan Produk & POS (F&B)</span>
                  <span className="font-semibold text-slate-900 tabular-nums">
                    {formatIdr(pendapatanPos)}
                  </span>
                </div>
                <div className="flex items-center justify-between py-1.5">
                  <span className="text-slate-600">Penjualan Minibar (Housekeeping)</span>
                  <span className="font-semibold text-slate-900 tabular-nums">
                    {formatIdr(pendapatanMinibar)}
                  </span>
                </div>
                <div className="flex items-center justify-between py-1.5">
                  <span className="text-slate-600">Pemasukan Lain (Non-Kamar / Non-POS)</span>
                  <span className="font-semibold text-slate-900 tabular-nums">
                    {formatIdr(pendapatanLain)}
                  </span>
                </div>
                {potonganDiskon > 0 && (
                  <div className="flex items-center justify-between py-1.5 text-purple-700">
                    <span>Informasi Potongan Diskon (Kamar & POS)</span>
                    <span className="font-semibold tabular-nums">({formatIdr(potonganDiskon)})</span>
                  </div>
                )}
                <div className="flex items-center justify-between pt-2.5 font-bold text-slate-900">
                  <span>Sub Total Pendapatan</span>
                  <span className="text-emerald-700 tabular-nums">{formatIdr(subTotalPendapatan)}</span>
                </div>
              </div>
            )}
          </div>

          {/* B. Harga Pokok Penjualan */}
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => togglePlSection('B')}
              className="w-full flex items-center justify-between px-4 py-3 bg-orange-50/70 hover:bg-orange-50 text-left transition-colors cursor-pointer"
            >
              <span className="text-xs font-bold text-orange-900">B. Harga Pokok Penjualan</span>
              <span className="flex items-center gap-2 text-xs font-extrabold text-orange-700 tabular-nums">
                <span>{formatIdr(subTotalHpp)}</span>
                {openPlSections.B ? (
                  <IconChevronUp className="w-4 h-4 text-slate-500" />
                ) : (
                  <IconChevronDown className="w-4 h-4 text-slate-500" />
                )}
              </span>
            </button>
            {openPlSections.B && (
              <div className="p-4 space-y-2 text-xs divide-y divide-slate-100">
                <div className="flex items-center justify-between py-1.5">
                  <span className="text-slate-600">HPP Produk & F&B Terjual</span>
                  <span className="font-semibold text-slate-900 tabular-nums">{formatIdr(hppProduk)}</span>
                </div>
                <div className="flex items-center justify-between py-1.5">
                  <span className="text-slate-600">HPP Minibar Terjual</span>
                  <span className="font-semibold text-slate-900 tabular-nums">{formatIdr(hppMinibar)}</span>
                </div>
                <div className="flex items-center justify-between pt-2.5 font-bold text-slate-900">
                  <span>Sub Total HPP</span>
                  <span className="text-orange-700 tabular-nums">{formatIdr(subTotalHpp)}</span>
                </div>
              </div>
            )}
          </div>

          {/* C. Laba Kotor */}
          <div className="border border-blue-200 bg-blue-50/50 rounded-xl px-4 py-3.5 flex items-center justify-between">
            <div>
              <div className="text-xs font-bold text-blue-950">C. Laba Kotor</div>
              <div className="text-[11px] text-slate-500 mt-0.5">Pendapatan - HPP</div>
            </div>
            <div className="text-base font-extrabold text-blue-700 tabular-nums">
              {formatIdr(labaKotor)}
            </div>
          </div>

          {/* D. Pengeluaran */}
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => togglePlSection('D')}
              className="w-full flex items-center justify-between px-4 py-3 bg-rose-50/70 hover:bg-rose-50 text-left transition-colors cursor-pointer"
            >
              <span className="text-xs font-bold text-rose-900">D. Pengeluaran</span>
              <span className="flex items-center gap-2 text-xs font-extrabold text-rose-700 tabular-nums">
                <span>{formatIdr(subTotalPengeluaran)}</span>
                {openPlSections.D ? (
                  <IconChevronUp className="w-4 h-4 text-slate-500" />
                ) : (
                  <IconChevronDown className="w-4 h-4 text-slate-500" />
                )}
              </span>
            </button>
            {openPlSections.D && (
              <div className="p-4 space-y-2 text-xs divide-y divide-slate-100">
                {expCategories.length === 0 ? (
                  <div className="py-1.5 text-slate-400">Tidak ada pengeluaran pada periode ini</div>
                ) : (
                  expCategories.map((cat) => (
                    <div key={cat.category_code} className="flex items-center justify-between py-1.5">
                      <span className="text-slate-600">{cat.category_name}</span>
                      <span className="font-semibold text-slate-900 tabular-nums">
                        {formatIdr(cat.total)}
                      </span>
                    </div>
                  ))
                )}
                <div className="flex items-center justify-between pt-2.5 font-bold text-slate-900">
                  <span>Sub Total Pengeluaran</span>
                  <span className="text-rose-700 tabular-nums">{formatIdr(subTotalPengeluaran)}</span>
                </div>
              </div>
            )}
          </div>

          {/* E. Stok */}
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => togglePlSection('E')}
              className="w-full flex items-center justify-between px-4 py-3 bg-purple-50/60 hover:bg-purple-50 text-left transition-colors cursor-pointer"
            >
              <span className="text-xs font-bold text-purple-950">E. Stok</span>
              <span className="flex items-center gap-2 text-xs font-extrabold text-purple-800 tabular-nums">
                <span>{formatIdr(totalStokVal)}</span>
                {openPlSections.E ? (
                  <IconChevronUp className="w-4 h-4 text-slate-500" />
                ) : (
                  <IconChevronDown className="w-4 h-4 text-slate-500" />
                )}
              </span>
            </button>
            {openPlSections.E && (
              <div className="p-4 space-y-3 text-xs">
                <div>
                  <div className="font-bold text-slate-700 mb-1">Stok Keluar</div>
                  <div className="flex items-center justify-between py-1 pl-3 text-slate-600">
                    <span>Nilai Barang</span>
                    <span className="tabular-nums">{formatIdr(stokKeluarVal)}</span>
                  </div>
                  <div className="flex items-center justify-between py-1 pl-3 font-semibold text-slate-700 border-t border-slate-100">
                    <span>Sub Total</span>
                    <span className="tabular-nums">{formatIdr(stokKeluarVal)}</span>
                  </div>
                </div>
                <div>
                  <div className="font-bold text-slate-700 mb-1">Opname Stok</div>
                  <div className="flex items-center justify-between py-1 pl-3 text-slate-600">
                    <span>Nilai Opname</span>
                    <span className="tabular-nums">{formatIdr(opnameStokVal)}</span>
                  </div>
                  <div className="flex items-center justify-between py-1 pl-3 font-semibold text-slate-700 border-t border-slate-100">
                    <span>Sub Total</span>
                    <span className="tabular-nums">{formatIdr(opnameStokVal)}</span>
                  </div>
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-slate-200 font-bold text-slate-900">
                  <span>Total Stok</span>
                  <span className="text-purple-800 tabular-nums">{formatIdr(totalStokVal)}</span>
                </div>
              </div>
            )}
          </div>

          {/* F. Pembelian */}
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => togglePlSection('F')}
              className="w-full flex items-center justify-between px-4 py-3 bg-indigo-50/60 hover:bg-indigo-50 text-left transition-colors cursor-pointer"
            >
              <span className="text-xs font-bold text-indigo-950">F. Pembelian</span>
              <span className="flex items-center gap-2 text-xs font-extrabold text-indigo-800 tabular-nums">
                <span>{formatIdr(totalPembelianAdj)}</span>
                {openPlSections.F ? (
                  <IconChevronUp className="w-4 h-4 text-slate-500" />
                ) : (
                  <IconChevronDown className="w-4 h-4 text-slate-500" />
                )}
              </span>
            </button>
            {openPlSections.F && (
              <div className="p-4 space-y-3 text-xs">
                <div>
                  <div className="font-bold text-slate-700 mb-1">Diskon</div>
                  <div className="flex items-center justify-between py-1 pl-3 text-slate-600">
                    <span>Nilai Diskon</span>
                    <span className="tabular-nums">{formatIdr(poDiskon)}</span>
                  </div>
                  <div className="flex items-center justify-between py-1 pl-3 font-semibold text-slate-700 border-t border-slate-100">
                    <span>Sub Total</span>
                    <span className="tabular-nums">{formatIdr(poDiskon)}</span>
                  </div>
                </div>
                <div>
                  <div className="font-bold text-slate-700 mb-1">Pengiriman</div>
                  <div className="flex items-center justify-between py-1 pl-3 text-slate-600">
                    <span>Biaya Pengiriman</span>
                    <span className="tabular-nums">{formatIdr(poPengiriman)}</span>
                  </div>
                  <div className="flex items-center justify-between py-1 pl-3 font-semibold text-slate-700 border-t border-slate-100">
                    <span>Sub Total</span>
                    <span className="tabular-nums">{formatIdr(poPengiriman)}</span>
                  </div>
                </div>
                <div>
                  <div className="font-bold text-slate-700 mb-1">Pajak</div>
                  <div className="flex items-center justify-between py-1 pl-3 text-slate-600">
                    <span>Nilai Pajak</span>
                    <span className="tabular-nums">{formatIdr(poPajak)}</span>
                  </div>
                  <div className="flex items-center justify-between py-1 pl-3 font-semibold text-slate-700 border-t border-slate-100">
                    <span>Sub Total</span>
                    <span className="tabular-nums">{formatIdr(poPajak)}</span>
                  </div>
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-slate-200 font-bold text-slate-900">
                  <span>Total Pembelian (Diskon - Pengiriman - Pajak)</span>
                  <span className="text-indigo-800 tabular-nums">{formatIdr(totalPembelianAdj)}</span>
                </div>
              </div>
            )}
          </div>

          {/* G. Laba Bersih */}
          <div className="border border-emerald-300 bg-emerald-50/80 rounded-xl px-4 py-4 flex items-center justify-between">
            <div>
              <div className="text-sm font-extrabold text-emerald-950">G. Laba Bersih</div>
              <div className="text-[11px] text-emerald-800/80 mt-0.5">
                Laba Kotor - Pengeluaran + Stok + Pembelian
              </div>
            </div>
            <div
              className={`text-lg font-extrabold tabular-nums ${
                labaBersih >= 0 ? 'text-emerald-700' : 'text-rose-700'
              }`}
            >
              {formatIdr(labaBersih)}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // SUB-VIEW 3: LAPORAN ARUS KAS
  // =========================================================================
  if (subView === 'arus_kas') {
    const cf = analytics?.accounting_statements?.cash_flow;
    const saldoAwal = cf?.opening_cash_balance ?? 0;
    const op = cf?.operating_activities ?? {
      customer_receipts: totalSales,
      supplier_payments: -purchaseTotal,
      operating_expenses: -expenseTotal,
      maintenance_expenses: 0,
      other_income_receipts: otherIncomeTotal,
      other_expenses: 0,
      stock_opname_adjustment: 0,
      stock_out_adjustment: 0,
      subtotal_operating: totalSales + otherIncomeTotal - purchaseTotal - expenseTotal,
    };
    const invSubtotal = cf?.investing_activities?.subtotal_investing ?? 0;
    const totalPendapatanCf =
      cf?.total_income_after_investing ?? op.subtotal_operating + invSubtotal;
    const finSubtotal = cf?.financing_activities?.subtotal_financing ?? 0;
    const kenaikanKas = cf?.net_cash_change ?? totalPendapatanCf + finSubtotal;
    const saldoAkhir = cf?.closing_cash_balance ?? saldoAwal + kenaikanKas;

    const handleExportCfExcel = () => {
      downloadExportXml(
        `Laporan_Arus_Kas_${analytics?.start_date || 'HIMS'}_sd_${analytics?.end_date || 'HIMS'}.xls`,
        [
          {
            name: 'Arus Kas',
            rows: [
              ['Kategori', 'Komponen Arus Kas', 'Nilai (Rp)'],
              ['Saldo Awal', 'Saldo kas awal', saldoAwal],
              ['Aktivitas Operasional', 'Penerimaan dari pelanggan', op.customer_receipts],
              ['Aktivitas Operasional', 'Pembayaran ke pemasok', op.supplier_payments],
              ['Aktivitas Operasional', 'Biaya operasional', op.operating_expenses],
              ['Aktivitas Operasional', 'Biaya perawatan', op.maintenance_expenses],
              ['Aktivitas Operasional', 'Pendapatan lain', op.other_income_receipts],
              ['Aktivitas Operasional', 'Pengeluaran lain', op.other_expenses],
              ['Aktivitas Operasional', 'Opname stok (penyesuaian)', op.stock_opname_adjustment],
              ['Aktivitas Operasional', 'Stok keluar (penyesuaian)', op.stock_out_adjustment],
              ['Aktivitas Operasional', 'SubTotal Aktivitas operasional', op.subtotal_operating],
              ['Aktivitas Investasi', 'SubTotal Aktivitas Investasi', invSubtotal],
              ['Total', 'Total Pendapatan', totalPendapatanCf],
              ['Aktivitas Pendanaan', 'SubTotal Aktivitas Pendanaan', finSubtotal],
              ['Total', 'Total Kenaikan/penurunan kas', kenaikanKas],
              ['Saldo Akhir', 'Saldo kas akhir', saldoAkhir],
            ],
          },
        ]
      );
    };

    return (
      <div className="space-y-4">
        {/* Toolbar */}
        <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 shadow-xs flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-bold text-slate-900">Laporan Arus Kas</div>
            <div className="text-xs text-slate-500">
              Periode: {analytics?.start_date || financials?.start_date} s/d{' '}
              {analytics?.end_date || financials?.end_date}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                void printArusKasPdf({
                  startDate: String(analytics?.start_date || financials?.start_date || ''),
                  endDate: String(analytics?.end_date || financials?.end_date || ''),
                  saldoAwal,
                  op,
                  invSubtotal,
                  totalPendapatanCf,
                  finSubtotal,
                  kenaikanKas,
                  saldoAkhir,
                })
              }
              className="px-3 py-1.5 rounded-lg border border-rose-200 bg-rose-50/60 hover:bg-rose-100/70 text-rose-700 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
            >
              <IconFileText className="w-3.5 h-3.5" />
              <span>PDF</span>
            </button>
            <button
              type="button"
              onClick={handleExportCfExcel}
              className="px-3 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50/60 hover:bg-emerald-100/70 text-emerald-800 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
            >
              <IconFileSpreadsheet className="w-3.5 h-3.5" />
              <span>EXCEL</span>
            </button>
          </div>
        </div>

        {/* Arus Kas Statement Box */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden text-xs">
          {/* Saldo kas awal */}
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between font-bold text-slate-800">
            <span>Saldo kas awal</span>
            <span className="tabular-nums">{formatDecimalIdr(saldoAwal)}</span>
          </div>

          {/* Blue section bar: Arus Kas */}
          <div className="bg-sky-500 text-white font-bold text-center py-2.5 px-4 text-xs">
            Arus Kas
          </div>

          <div className="p-5 space-y-4">
            {/* Aktivitas Operasional */}
            <div className="space-y-2">
              <div className="font-bold text-slate-700">Aktivitas operasional</div>
              <div className="pl-3 space-y-2 text-slate-600">
                <div className="flex items-center justify-between">
                  <span>Penerimaan dari pelanggan</span>
                  <span className="font-medium text-slate-800 tabular-nums">
                    {formatDecimalIdr(op.customer_receipts)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Pembayaran ke pemasok</span>
                  <span className="font-medium text-slate-800 tabular-nums">
                    {formatDecimalIdr(op.supplier_payments)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Biaya operasional</span>
                  <span className="font-medium text-slate-800 tabular-nums">
                    {formatDecimalIdr(op.operating_expenses)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Biaya perawatan</span>
                  <span className="font-medium text-slate-800 tabular-nums">
                    {formatDecimalIdr(op.maintenance_expenses)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Pendapatan lain</span>
                  <span className="font-medium text-slate-800 tabular-nums">
                    {formatDecimalIdr(op.other_income_receipts)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Pengeluaran lain</span>
                  <span className="font-medium text-slate-800 tabular-nums">
                    {formatDecimalIdr(op.other_expenses)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Opname stok (penyesuaian)</span>
                  <span className="font-medium text-slate-800 tabular-nums">
                    {formatDecimalIdr(op.stock_opname_adjustment)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Stok keluar (penyesuaian)</span>
                  <span className="font-medium text-slate-800 tabular-nums">
                    {formatDecimalIdr(op.stock_out_adjustment)}
                  </span>
                </div>
              </div>
              <div className="bg-slate-50 px-3 py-2 rounded-lg flex items-center justify-between font-bold text-slate-700">
                <span>SubTotal Aktivitas operasional</span>
                <span className="tabular-nums">{formatDecimalIdr(op.subtotal_operating)}</span>
              </div>
            </div>

            {/* Aktivitas Investasi */}
            <div className="space-y-2">
              <div className="font-bold text-slate-700">Aktivitas Investasi</div>
              <div className="bg-slate-50 px-3 py-2 rounded-lg flex items-center justify-between font-bold text-slate-700">
                <span>SubTotal Aktivitas Investasi</span>
                <span className="tabular-nums">{formatDecimalIdr(invSubtotal)}</span>
              </div>
            </div>

            {/* Total Pendapatan */}
            <div className="pt-2 border-t border-dashed border-sky-400 flex items-center justify-between font-extrabold text-slate-900">
              <span>Total Pendapatan</span>
              <span className="tabular-nums">{formatDecimalIdr(totalPendapatanCf)}</span>
            </div>

            {/* Aktivitas Pendanaan */}
            <div className="space-y-2 pt-1">
              <div className="font-bold text-slate-700">Aktivitas Pendanaan</div>
              <div className="bg-slate-50 px-3 py-2 rounded-lg flex items-center justify-between font-bold text-slate-700">
                <span>SubTotal Aktivitas Pendanaan</span>
                <span className="tabular-nums">{formatDecimalIdr(finSubtotal)}</span>
              </div>
            </div>

            {/* Total Kenaikan/penurunan kas */}
            <div className="pt-2 border-t border-dashed border-sky-400 flex items-center justify-between font-extrabold text-slate-900">
              <span>Total Kenaikan/penurunan kas</span>
              <span className="tabular-nums">{formatDecimalIdr(kenaikanKas)}</span>
            </div>
          </div>

          {/* Saldo kas akhir */}
          <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between font-extrabold text-slate-900">
            <span>Saldo kas akhir</span>
            <span className="tabular-nums">{formatDecimalIdr(saldoAkhir)}</span>
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // SUB-VIEW 4: LAPORAN NERACA
  // =========================================================================
  if (subView === 'neraca') {
    const bs = analytics?.accounting_statements?.balance_sheet;
    const ca = bs?.assets?.current_assets ?? {
      cash_on_hand: 0,
      bank_account: 0,
      transfer_bank: 0,
      qris_balance: 0,
      card_edc: 0,
      short_term_investment: 0,
      accounts_receivable: live?.outstanding_guest_balance_current ?? 0,
      inventory_value: 0,
      subtotal_current_assets: live?.outstanding_guest_balance_current ?? 0,
    };
    const nca = bs?.assets?.non_current_assets ?? {
      fixed_assets: 0,
      subtotal_non_current_assets: 0,
    };
    const totalAset =
      bs?.assets?.total_assets ?? ca.subtotal_current_assets + nca.subtotal_non_current_assets;

    const kew = bs?.liabilities_and_equity?.liabilities ?? {
      accounts_payable: unpaidPurchaseAp,
      guest_deposits: 0,
      subtotal_liabilities: unpaidPurchaseAp,
    };
    const mod = bs?.liabilities_and_equity?.equity ?? {
      retained_earnings: 0,
      current_period_income: netIncome,
      subtotal_equity: netIncome,
    };
    const totalKewajibanModal =
      bs?.liabilities_and_equity?.total_liabilities_and_equity ??
      kew.subtotal_liabilities + mod.subtotal_equity;

    const handleExportBsExcel = () => {
      downloadExportXml(
        `Laporan_Neraca_${analytics?.start_date || 'HIMS'}_sd_${analytics?.end_date || 'HIMS'}.xls`,
        [
          {
            name: 'Neraca',
            rows: [
              ['Sisi', 'Kelompok', 'Akun', 'Nilai (Rp)'],
              ['Aset', 'Aset Lancar', '11101 - Kas', ca.cash_on_hand],
              ['Aset', 'Aset Lancar', '11102 - Bank', ca.bank_account],
              ['Aset', 'Aset Lancar', '11105 - Transfer BCA / Bank', ca.transfer_bank],
              ['Aset', 'Aset Lancar', '11106 - Qris', ca.qris_balance],
              ['Aset', 'Aset Lancar', '11107 - Kartu Debit / Kredit', ca.card_edc],
              [
                'Aset',
                'Aset Lancar',
                '11200 - Investasi jangka pendek dan surat berharga',
                ca.short_term_investment,
              ],
              ['Aset', 'Aset Lancar', '11300 - Piutang', ca.accounts_receivable],
              ['Aset', 'Aset Lancar', '11400 - Persediaan Barang Dagang', ca.inventory_value],
              ['Aset', 'Aset Lancar', 'SubTotal Aset Lancar', ca.subtotal_current_assets],
              ['Aset', 'Aset Tidak Lancar', '12000 - Aset Tetap', nca.fixed_assets],
              [
                'Aset',
                'Aset Tidak Lancar',
                'SubTotal Aset Tidak Lancar',
                nca.subtotal_non_current_assets,
              ],
              ['Aset', 'Total', 'Total Aset', totalAset],
              ['Kewajiban & Modal', 'Kewajiban', '21000 - Hutang Usaha', kew.accounts_payable],
              ['Kewajiban & Modal', 'Kewajiban', '21100 - Deposit Tamu', kew.guest_deposits],
              ['Kewajiban & Modal', 'Kewajiban', 'SubTotal Kewajiban', kew.subtotal_liabilities],
              ['Kewajiban & Modal', 'Modal', 'Modal / Laba Ditahan', mod.retained_earnings],
              ['Kewajiban & Modal', 'Modal', 'Pendapatan periode ini', mod.current_period_income],
              ['Kewajiban & Modal', 'Modal', 'SubTotal Modal', mod.subtotal_equity],
              ['Kewajiban & Modal', 'Total', 'Total Kewajiban dan Modal', totalKewajibanModal],
            ],
          },
        ]
      );
    };

    return (
      <div className="space-y-4">
        {/* Toolbar matching Gambar 2 */}
        <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 shadow-xs flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setNeracaLayout('2col')}
              title="Tampilan 2 Kolom"
              className={`p-2 rounded-lg border text-xs transition-colors cursor-pointer ${
                neracaLayout === '2col'
                  ? 'bg-sky-500 text-white border-sky-600'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              <IconColumns2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setNeracaLayout('1col')}
              title="Tampilan 1 Kolom"
              className={`p-2 rounded-lg border text-xs transition-colors cursor-pointer ${
                neracaLayout === '1col'
                  ? 'bg-sky-500 text-white border-sky-600'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              <IconRows2 className="w-4 h-4" />
            </button>
          </div>

          <div className="text-center">
            <div className="text-sm font-bold text-slate-900">Laporan Neraca</div>
            <div className="text-xs text-slate-500">
              Periode s/d {analytics?.end_date || financials?.end_date}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                void printNeracaPdf({
                  startDate: String(analytics?.start_date || financials?.start_date || ''),
                  endDate: String(analytics?.end_date || financials?.end_date || ''),
                  ca,
                  nca,
                  totalAset,
                  kew,
                  mod,
                  totalKewajibanModal,
                })
              }
              className="px-3 py-1.5 rounded-lg border border-rose-200 bg-rose-50/60 hover:bg-rose-100/70 text-rose-700 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
            >
              <IconFileText className="w-3.5 h-3.5" />
              <span>PDF</span>
            </button>
            <button
              type="button"
              onClick={handleExportBsExcel}
              className="px-3 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50/60 hover:bg-emerald-100/70 text-emerald-800 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
            >
              <IconFileSpreadsheet className="w-3.5 h-3.5" />
              <span>EXCEL</span>
            </button>
          </div>
        </div>

        {/* Balance Sheet Grid */}
        <div
          className={`bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden text-xs grid ${
            neracaLayout === '2col'
              ? 'grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-slate-200'
              : 'grid-cols-1 divide-y divide-slate-200'
          }`}
        >
          {/* Left Column: Aset */}
          <div>
            <div className="bg-sky-500 text-white font-bold text-center py-2.5 px-4">Aset</div>
            <div className="p-5 space-y-4">
              {/* Aset Lancar */}
              <div className="space-y-2">
                <div className="font-bold text-slate-700">Aset Lancar</div>
                <div className="pl-3 space-y-2 text-slate-600">
                  <div className="flex items-center justify-between">
                    <span>11101 - Kas</span>
                    <span className="font-medium text-slate-800 tabular-nums">
                      {formatDecimalIdr(ca.cash_on_hand)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>11102 - Bank</span>
                    <span className="font-medium text-slate-800 tabular-nums">
                      {formatDecimalIdr(ca.bank_account)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>11105 - Transfer BCA / Bank</span>
                    <span className="font-medium text-slate-800 tabular-nums">
                      {formatDecimalIdr(ca.transfer_bank)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>11106 - Qris</span>
                    <span className="font-medium text-slate-800 tabular-nums">
                      {formatDecimalIdr(ca.qris_balance)}
                    </span>
                  </div>
                  {ca.card_edc > 0 && (
                    <div className="flex items-center justify-between">
                      <span>11107 - Kartu Debit / Kredit</span>
                      <span className="font-medium text-slate-800 tabular-nums">
                        {formatDecimalIdr(ca.card_edc)}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span>11200 - Investasi jangka pendek dan surat berharga</span>
                    <span className="font-medium text-slate-800 tabular-nums">
                      {formatDecimalIdr(ca.short_term_investment)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>11300 - Piutang</span>
                    <span className="font-medium text-slate-800 tabular-nums">
                      {formatDecimalIdr(ca.accounts_receivable)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>11400 - Persediaan Barang Dagang</span>
                    <span className="font-medium text-slate-800 tabular-nums">
                      {formatDecimalIdr(ca.inventory_value)}
                    </span>
                  </div>
                </div>
                <div className="bg-slate-50 px-3 py-2 rounded-lg flex items-center justify-between font-bold text-slate-700">
                  <span>SubTotal Aset Lancar</span>
                  <span className="tabular-nums">{formatDecimalIdr(ca.subtotal_current_assets)}</span>
                </div>
              </div>

              {/* Aset Tidak Lancar */}
              <div className="space-y-2">
                <div className="font-bold text-slate-700">Aset Tidak Lancar</div>
                <div className="pl-3 space-y-2 text-slate-600">
                  <div className="flex items-center justify-between">
                    <span>12000 - Aset Tetap</span>
                    <span className="font-medium text-slate-800 tabular-nums">
                      {formatDecimalIdr(nca.fixed_assets)}
                    </span>
                  </div>
                </div>
                <div className="bg-slate-50 px-3 py-2 rounded-lg flex items-center justify-between font-bold text-slate-700">
                  <span>SubTotal Aset Tidak Lancar</span>
                  <span className="tabular-nums">{formatDecimalIdr(nca.subtotal_non_current_assets)}</span>
                </div>
              </div>

              {/* Total Aset */}
              <div className="pt-2.5 border-t border-dashed border-sky-400 flex items-center justify-between font-extrabold text-slate-900">
                <span>Total Aset</span>
                <span className="tabular-nums">{formatDecimalIdr(totalAset)}</span>
              </div>
            </div>
          </div>

          {/* Right Column: Kewajiban dan Modal */}
          <div>
            <div className="bg-sky-500 text-white font-bold text-center py-2.5 px-4">
              Kewajiban dan Modal
            </div>
            <div className="p-5 space-y-4">
              {/* Kewajiban */}
              <div className="space-y-2">
                <div className="font-bold text-slate-700">Kewajiban</div>
                <div className="pl-3 space-y-2 text-slate-600">
                  <div className="flex items-center justify-between">
                    <span>21000 - Hutang Usaha</span>
                    <span className="font-medium text-slate-800 tabular-nums">
                      {formatDecimalIdr(kew.accounts_payable)}
                    </span>
                  </div>
                  {kew.guest_deposits > 0 && (
                    <div className="flex items-center justify-between">
                      <span>21100 - Deposit Tamu Berjalan</span>
                      <span className="font-medium text-slate-800 tabular-nums">
                        {formatDecimalIdr(kew.guest_deposits)}
                      </span>
                    </div>
                  )}
                </div>
                <div className="bg-slate-50 px-3 py-2 rounded-lg flex items-center justify-between font-bold text-slate-700">
                  <span>SubTotal Kewajiban</span>
                  <span className="tabular-nums">{formatDecimalIdr(kew.subtotal_liabilities)}</span>
                </div>
              </div>

              {/* Modal */}
              <div className="space-y-2">
                <div className="font-bold text-slate-700">Modal</div>
                <div className="pl-3 space-y-2 text-slate-600">
                  {mod.retained_earnings > 0 && (
                    <div className="flex items-center justify-between">
                      <span>Modal & Laba Ditahan</span>
                      <span className="font-medium text-slate-800 tabular-nums">
                        {formatDecimalIdr(mod.retained_earnings)}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span>Pendapatan periode ini</span>
                    <span className="font-medium text-slate-800 tabular-nums">
                      {formatDecimalIdr(mod.current_period_income)}
                    </span>
                  </div>
                </div>
                <div className="bg-slate-50 px-3 py-2 rounded-lg flex items-center justify-between font-bold text-slate-700">
                  <span>SubTotal Modal</span>
                  <span className="tabular-nums">{formatDecimalIdr(mod.subtotal_equity)}</span>
                </div>
              </div>

              {/* Total Kewajiban dan Modal */}
              <div className="pt-2.5 border-t border-dashed border-sky-400 flex items-center justify-between font-extrabold text-slate-900">
                <span>Total Kewajiban dan Modal</span>
                <span className="tabular-nums">{formatDecimalIdr(totalKewajibanModal)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // SUB-VIEW 1 (DEFAULT): RINGKASAN KESELURUHAN
  // =========================================================================
  const dayModalReservations = selectedDayModal
    ? getReservationsForDate(selectedDayModal.date)
    : [];
  const roomModalReservations = selectedRoomModal
    ? getReservationsForRoom(selectedRoomModal)
    : [];
  const piutangSheet = analytics?.piutang_sheet_summary;
  const arPeriodItems = piutangSheet?.items ?? [];
  const arPeriodTotal = piutangSheet?.period_total ?? 0;
  const arAllTimeTotal = piutangSheet?.all_time_total ?? arPeriodTotal;
  const arAllTimeCount = piutangSheet?.all_time_count ?? arPeriodItems.length;

  return (
    <div className="space-y-5 min-w-0">
      {/* ROW 1: 6 Kartu Ringkasan Keuangan, Complimentary & Diskon */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6 gap-3.5">
        {/* Card 1: Penjualan */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs flex flex-col justify-between min-w-0">
          <div>
            <div className="flex items-center gap-1.5 text-xs font-bold text-blue-700">
              <IconShoppingCart className="w-4 h-4 shrink-0" />
              <span>Penjualan</span>
            </div>
            <div className="mt-3 space-y-1 text-xs">
              <div className="flex items-center justify-between text-slate-600">
                <span>Kamar:</span>
                <span className="font-semibold text-slate-900 tabular-nums">{formatIdr(roomSalesTotal)}</span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>Produk / POS:</span>
                <span className="font-semibold text-slate-900 tabular-nums">{formatIdr(posSalesTotal)}</span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>Minibar:</span>
                <span className="font-semibold text-slate-900 tabular-nums">{formatIdr(minibarSalesTotal)}</span>
              </div>
            </div>
          </div>
          <div className="mt-3 pt-2.5 border-t border-slate-100">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-700">Total:</span>
              <span className="text-sm font-extrabold text-slate-900 tabular-nums">{formatIdr(totalSales)}</span>
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500 mt-1">
              <span>{formatNumber(salesTxCount)} transaksi</span>
              <span className="text-emerald-700 font-semibold tabular-nums">
                Bayar: {formatIdr(paidSalesTotal)}
              </span>
            </div>
            {unpaidSalesTotal > 0 && (
              <div className="flex items-center justify-between text-[10px] text-amber-700 font-medium mt-0.5">
                <span>Belum Lunas / Sisa:</span>
                <span className="tabular-nums font-semibold">{formatIdr(unpaidSalesTotal)}</span>
              </div>
            )}
          </div>
        </div>

        {/* Card 2: Pemasukan */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-700">
              <IconTrendingUp className="w-4 h-4 shrink-0" />
              <span>Pemasukan</span>
            </div>
            <div className="text-xl font-extrabold text-slate-900 mt-3 tabular-nums">
              {formatIdr(otherIncomeTotal)}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              {formatNumber(otherIncomeCount)} transaksi pemasukan lain
            </div>
          </div>
          <div className="mt-3 pt-2 border-t border-slate-100 text-[11px] text-slate-400">
            Non-kamar / Non-POS
          </div>
        </div>

        {/* Card 3: Pengeluaran & Pembelian */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-1.5 text-xs font-bold text-rose-700">
              <IconTrendingDown className="w-4 h-4 shrink-0" />
              <span>Pengeluaran & Pembelian</span>
            </div>
            <div className="mt-3 space-y-1 text-xs">
              <div className="flex items-center justify-between text-slate-600">
                <span>Pengeluaran:</span>
                <span className="font-semibold text-rose-700 tabular-nums">{formatIdr(expenseTotal)}</span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>Pembelian:</span>
                <span className="font-semibold text-rose-700 tabular-nums">{formatIdr(purchaseTotal)}</span>
              </div>
            </div>
          </div>
          <div className="mt-3 pt-2.5 border-t border-slate-100">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-700">Total:</span>
              <span className="text-sm font-extrabold text-rose-700 tabular-nums">{formatIdr(totalOutflow)}</span>
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5">{formatNumber(totalOutflowCount)} transaksi</div>
          </div>
        </div>

        {/* Card 4: Complimentary & House Use */}
        <div className="bg-amber-50/50 border border-amber-200 rounded-xl p-4 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-bold text-amber-800">
                <IconGift className="w-4 h-4 shrink-0" />
                <span>Complimentary</span>
              </div>
              <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                Free / VIP
              </span>
            </div>
            <div className="mt-3 space-y-1 text-xs">
              <div className="flex items-center justify-between text-slate-600">
                <span>Kamar (Comp):</span>
                <span className="font-bold text-amber-900 tabular-nums">
                  {compRoomCount} resv ({compRoomNights} mlm)
                </span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>Produk POS (Free):</span>
                <span className="font-bold text-amber-900 tabular-nums">{compPosCount} item</span>
              </div>
            </div>
          </div>
          <div className="mt-3 pt-2.5 border-t border-amber-200/70">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-amber-800">Est. Nilai:</span>
              <span className="text-xs font-extrabold text-amber-900 tabular-nums">
                {formatIdr(totalCompEstValue)}
              </span>
            </div>
            <div className="text-[10px] text-amber-700/80 mt-0.5">Nilai manfaat complimentary</div>
          </div>
        </div>

        {/* Card 5: Diskon & Potongan (BARU - Sebelah Complimentary) */}
        <div className="bg-purple-50/50 border border-purple-200 rounded-xl p-4 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-bold text-purple-800">
                <IconBadgePercent className="w-4 h-4 shrink-0" />
                <span>Diskon</span>
              </div>
              <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-purple-100 text-purple-800">
                Potongan
              </span>
            </div>
            <div className="mt-3 space-y-1 text-xs">
              <div className="flex items-center justify-between text-slate-600">
                <span>Diskon Kamar:</span>
                <span className="font-bold text-purple-900 tabular-nums">
                  {formatIdr(roomDiscountTotal)} ({roomDiscountCount})
                </span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>Diskon POS:</span>
                <span className="font-bold text-purple-900 tabular-nums">
                  {formatIdr(posDiscountTotal)} ({posDiscountCount})
                </span>
              </div>
            </div>
          </div>
          <div className="mt-3 pt-2.5 border-t border-purple-200/70">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-purple-800">Total Diskon:</span>
              <span className="text-xs font-extrabold text-purple-900 tabular-nums">
                {formatIdr(totalDiscountAmount)}
              </span>
            </div>
            <div className="text-[10px] text-purple-700/80 mt-0.5">Potongan kamar & POS</div>
          </div>
        </div>

        {/* Card 6: Total Pendapatan Bersih */}
        <div className="bg-emerald-50/70 border border-emerald-200 rounded-xl p-4 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-800">
              <IconWallet className="w-4 h-4 shrink-0" />
              <span>Total Pendapatan</span>
            </div>
            <div className="mt-2.5 space-y-1 text-[11px]">
              <div className="flex items-center justify-between text-slate-600">
                <span>Penjualan:</span>
                <span className="font-semibold text-slate-900 tabular-nums">{formatIdr(totalSales)}</span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>Pemasukan:</span>
                <span className="font-semibold text-slate-900 tabular-nums">{formatIdr(otherIncomeTotal)}</span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>Pengeluaran:</span>
                <span className="font-semibold text-rose-700 tabular-nums">{formatIdr(expenseTotal)}</span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>Pembelian:</span>
                <span className="font-semibold text-rose-700 tabular-nums">{formatIdr(purchaseTotal)}</span>
              </div>
            </div>
          </div>
          <div className="mt-2.5 pt-2 border-t border-emerald-200 flex items-center justify-between">
            <span className="text-xs font-bold text-emerald-900">Total:</span>
            <span
              className={`text-sm font-extrabold tabular-nums ${
                netIncome >= 0 ? 'text-emerald-900' : 'text-rose-700'
              }`}
            >
              {formatIdr(netIncome)}
            </span>
          </div>
        </div>
      </div>

      {/* ROW 2: Grafik Okupansi Kamar (Kiri) + Okupansi Per Kamar (Kanan) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 min-w-0">
        {/* Left Panel: Grafik Okupansi Kamar */}
        <div className="lg:col-span-6 min-w-0 overflow-hidden bg-white border border-slate-200 rounded-xl p-4 sm:p-5 shadow-xs flex flex-col justify-between">
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h4 className="text-sm font-bold text-slate-900 truncate">Grafik Okupansi Kamar</h4>
                <p className="text-xs text-slate-500 mt-0.5 truncate">
                  {activeRoomsCount} kamar aktif • Rata-rata {avgOccPct}%
                </p>
              </div>
              <span className="p-2 rounded-lg bg-slate-50 border border-slate-200/80 text-slate-500 shrink-0">
                <IconBuilding2 className="w-4 h-4" />
              </span>
            </div>

            {/* 3 KPI boxes: Rata-rata, Tertinggi, Terendah */}
            <div className="grid grid-cols-3 gap-2.5 sm:gap-3 mt-4">
              <div className="bg-slate-50 border border-slate-200/70 rounded-xl p-2.5 sm:p-3 text-center min-w-0">
                <div className="text-base sm:text-lg font-extrabold text-blue-600 tabular-nums">{avgOccPct}%</div>
                <div className="text-[11px] text-slate-500 mt-0.5 truncate">Rata-rata</div>
              </div>
              <div className="bg-slate-50 border border-slate-200/70 rounded-xl p-2.5 sm:p-3 text-center min-w-0">
                <div className="text-base sm:text-lg font-extrabold text-emerald-600 tabular-nums">{maxOccPct}%</div>
                <div className="text-[11px] text-slate-500 mt-0.5 truncate">Tertinggi</div>
              </div>
              <div className="bg-slate-50 border border-slate-200/70 rounded-xl p-2.5 sm:p-3 text-center min-w-0">
                <div className="text-base sm:text-lg font-extrabold text-orange-600 tabular-nums">{minOccPct}%</div>
                <div className="text-[11px] text-slate-500 mt-0.5 truncate">Terendah</div>
              </div>
            </div>

            {/* Vertical Bar Chart with Interactive Hover Tooltip & Click Drilldown */}
            <div className="mt-5 relative pt-4 pb-2 min-w-0">
              {dailyOcc.length === 0 ? (
                <div className="h-44 flex items-center justify-center text-xs text-slate-400">
                  Belum ada data grafik okupansi
                </div>
              ) : (
                <div className="flex gap-1.5 min-w-0">
                  {/* Y-axis labels */}
                  <div className="flex flex-col justify-between h-44 text-[10px] text-slate-400 pr-1 select-none shrink-0">
                    <span>100%</span>
                    <span>75%</span>
                    <span>50%</span>
                    <span>25%</span>
                    <span>0%</span>
                  </div>

                  {/* Chart Plot Area */}
                  <div
                    className={`flex-1 min-w-0 relative h-44 border-b border-slate-200 flex items-end pb-0.5 ${
                      dailyOcc.length > 20 ? 'gap-0.5 sm:gap-1' : 'gap-1 sm:gap-1.5'
                    }`}
                  >
                    {/* Horizontal grid lines */}
                    <div className="absolute inset-x-0 top-0 border-t border-dashed border-slate-100 pointer-events-none" />
                    <div className="absolute inset-x-0 top-1/4 border-t border-dashed border-slate-100 pointer-events-none" />
                    <div className="absolute inset-x-0 top-2/4 border-t border-dashed border-slate-100 pointer-events-none" />
                    <div className="absolute inset-x-0 top-3/4 border-t border-dashed border-slate-100 pointer-events-none" />

                    {/* Average dashed line */}
                    {avgOccPct > 0 && (
                      <div
                        className="absolute inset-x-0 border-t-2 border-dashed border-blue-500/70 pointer-events-none z-10"
                        style={{ bottom: `${Math.min(100, Math.max(2, avgOccPct))}%` }}
                      />
                    )}

                    {dailyOcc.map((d, idx) => {
                      const pct = Math.min(100, Math.max(0, Math.round(Number(d.occupancy_pct) || 0)));
                      let barColor = 'bg-slate-200 hover:bg-slate-300';
                      let pctTextColor = 'text-slate-600';
                      if (pct >= 80) {
                        barColor = 'bg-emerald-500 hover:bg-emerald-600';
                        pctTextColor = 'text-emerald-600';
                      } else if (pct >= 50) {
                        barColor = 'bg-amber-400 hover:bg-amber-500';
                        pctTextColor = 'text-amber-600';
                      } else if (pct >= 1) {
                        barColor = 'bg-orange-500 hover:bg-orange-600';
                        pctTextColor = 'text-orange-600';
                      }

                      const isHovered = hoveredBarDate === d.date;
                      // Position tooltip so it doesn't clip off left or right edge
                      const tooltipPosClass =
                        idx < 4
                          ? 'left-0'
                          : idx > dailyOcc.length - 5
                          ? 'right-0'
                          : 'left-1/2 -translate-x-1/2';

                      const showPctLabel =
                        dailyOcc.length <= 16 || isHovered || (pct > 0 && idx % 2 === 0);

                      return (
                        <div
                          key={d.date}
                          onMouseEnter={() => setHoveredBarDate(d.date)}
                          onMouseLeave={() => setHoveredBarDate(null)}
                          onClick={() => setSelectedDayModal(d)}
                          className="flex-1 min-w-0 h-full flex flex-col justify-end items-center relative cursor-pointer select-none"
                        >
                          {/* Floating Hover Tooltip */}
                          {isHovered && (
                            <div
                              className={`absolute bottom-14 ${tooltipPosClass} z-30 w-48 bg-white border border-slate-200 rounded-xl shadow-lg p-3 pointer-events-none text-left`}
                            >
                              <div className="text-xs font-bold text-slate-900">
                                {formatIndonesianLongDate(d.date)}
                              </div>
                              <div className="mt-1.5 space-y-0.5 text-[11px]">
                                <div className="flex items-center justify-between text-slate-500">
                                  <span>Terisi:</span>
                                  <span className="font-bold text-slate-900 tabular-nums">
                                    {d.sold_rooms} / {d.sellable_rooms} kamar
                                  </span>
                                </div>
                                <div className="flex items-center justify-between text-slate-500">
                                  <span>Okupansi:</span>
                                  <span className={`font-extrabold tabular-nums ${pctTextColor}`}>
                                    {pct}%
                                  </span>
                                </div>
                              </div>
                              <div className="mt-1.5 pt-1.5 border-t border-slate-100 text-[10px] text-slate-400">
                                Klik untuk lihat detail
                              </div>
                            </div>
                          )}

                          <div
                            className={`text-[8px] sm:text-[9px] font-bold text-slate-600 mb-0.5 tabular-nums leading-none ${
                              showPctLabel ? 'opacity-100' : 'opacity-0'
                            }`}
                          >
                            {pct}%
                          </div>
                          <div
                            className={`w-full max-w-[34px] rounded-t-sm sm:rounded-t-md transition-all ${barColor} ${
                              isHovered ? 'ring-2 ring-slate-900/15 scale-y-[1.02]' : ''
                            }`}
                            style={{ height: `${Math.max(pct > 0 ? 6 : 2, pct)}%` }}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* X-axis dates */}
              {dailyOcc.length > 0 && (
                <div
                  className={`flex pl-8 mt-1.5 min-w-0 ${
                    dailyOcc.length > 20 ? 'gap-0.5 sm:gap-1' : 'gap-1 sm:gap-1.5'
                  }`}
                >
                  {dailyOcc.map((d, idx) => {
                    const showLabel =
                      dailyOcc.length <= 10 ||
                      idx === 0 ||
                      idx === dailyOcc.length - 1 ||
                      idx % Math.ceil(dailyOcc.length / 7) === 0;
                    return (
                      <div
                        key={d.date}
                        className="flex-1 min-w-0 text-center text-[9px] text-slate-400 whitespace-nowrap overflow-visible"
                      >
                        {showLabel ? formatShortHotelDate(d.date) : ''}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Legend */}
          <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-4 pt-3 border-t border-slate-100 text-[11px] text-slate-500">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" /> ≥80%
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" /> 50–79%
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-orange-500 inline-block" /> 1–49%
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-slate-300 inline-block" /> 0%
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-4 border-t-2 border-dashed border-blue-500 inline-block" /> Rata-rata
            </span>
          </div>
        </div>

        {/* Right Panel: Okupansi Per Kamar */}
        <div className="lg:col-span-6 min-w-0 overflow-hidden bg-white border border-slate-200 rounded-xl p-4 sm:p-5 shadow-xs flex flex-col">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-sm font-bold text-slate-900">Okupansi Per Kamar</h4>
              <p className="text-xs text-slate-500 mt-0.5">
                Total: {formatIdr(totalRoomRankingRevenue)}
              </p>
            </div>
            <span className="p-2 rounded-lg bg-slate-50 border border-slate-200/80 text-slate-500">
              <IconBedDouble className="w-4 h-4" />
            </span>
          </div>

          {/* Search box */}
          <div className="mt-3 relative">
            <IconSearch className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={roomSearch}
              onChange={(e) => setRoomSearch(e.target.value)}
              placeholder="Cari kamar (nomor atau tipe kamar)..."
              className="w-full border border-slate-200 bg-slate-50/70 rounded-lg pl-8 pr-3 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-hidden focus:ring-1 focus:ring-emerald-600 focus:bg-white"
            />
          </div>

          {/* Room list (Clickable rows -> Modal Gambar 4) */}
          <div className="mt-3 space-y-2 max-h-[310px] overflow-y-auto pr-1">
            {filteredRooms.length === 0 ? (
              <div className="py-10 text-center text-xs text-slate-400">
                Tidak ada kamar yang cocok dengan pencarian
              </div>
            ) : (
              filteredRooms.map((rm, idx) => {
                const dotColor = ROOM_DOT_COLORS[idx % ROOM_DOT_COLORS.length];
                return (
                  <button
                    key={rm.room_id}
                    type="button"
                    onClick={() => setSelectedRoomModal(rm)}
                    className="w-full text-left flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-slate-50/80 hover:bg-emerald-50/50 border border-slate-200/60 hover:border-emerald-300 transition-colors cursor-pointer group"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dotColor}`} />
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-slate-900 truncate group-hover:text-emerald-950">
                          {rm.room_number} {rm.room_type_name}
                        </div>
                        <div className="text-[11px] text-slate-500 flex items-center gap-2">
                          <span>{rm.booking_count} booking</span>
                          {rm.occupied_nights > 0 && <span>• {rm.occupied_nights} malam</span>}
                          {rm.complimentary_nights > 0 && (
                            <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.2 rounded font-semibold">
                              {rm.complimentary_nights} mlm Comp
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-3">
                      <span className="text-xs font-extrabold text-slate-900 tabular-nums">
                        {formatIdr(rm.room_revenue)}
                      </span>
                      <IconChevronRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-emerald-700" />
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* ROW 3: Strip Ringkas "Live Snapshot Hari Ini" */}
      {live ? (
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Live Snapshot Operasional Hari Ini ({dailyOps?.business_date})
            </div>
            <div className="text-[11px] text-slate-400">Status Real-Time Front Office & Piutang</div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
            <div className="bg-slate-50 border border-slate-200/80 rounded-lg p-2.5">
              <div className="text-[10px] uppercase font-bold text-slate-500">Arrivals Hari Ini</div>
              <div className="text-lg font-extrabold text-blue-800 mt-0.5 tabular-nums">
                {biz?.arrivals ?? dailyOps?.lifecycle.arrivals_today ?? 0}
              </div>
            </div>
            <div className="bg-slate-50 border border-slate-200/80 rounded-lg p-2.5">
              <div className="text-[10px] uppercase font-bold text-slate-500">Departures</div>
              <div className="text-lg font-extrabold text-amber-800 mt-0.5 tabular-nums">
                {biz?.departures ?? dailyOps?.lifecycle.departures_today ?? 0}
              </div>
            </div>
            <div className="bg-slate-50 border border-slate-200/80 rounded-lg p-2.5">
              <div className="text-[10px] uppercase font-bold text-slate-500">Tamu In-House</div>
              <div className="text-lg font-extrabold text-emerald-800 mt-0.5 tabular-nums">
                {live.in_house_current}
              </div>
            </div>
            <div className="bg-slate-50 border border-slate-200/80 rounded-lg p-2.5">
              <div className="text-[10px] uppercase font-bold text-slate-500">Kamar Ready / Dirty</div>
              <div className="text-lg font-extrabold text-slate-800 mt-0.5 tabular-nums">
                <span className="text-emerald-700">{live.vacant_ready}</span>
                <span className="text-slate-400 mx-1">/</span>
                <span className="text-amber-700">{live.vacant_dirty}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowArModal(true)}
              className="bg-amber-50/70 hover:bg-amber-100/70 border border-amber-200 hover:border-amber-300 rounded-lg p-2.5 text-left transition-colors cursor-pointer group"
              title="Klik untuk melihat sumber data & rincian Piutang Tamu (AR) dari Sheet Piutang"
            >
              <div className="flex items-center justify-between gap-1">
                <div className="text-[10px] uppercase font-bold text-amber-800">Piutang Tamu (AR)</div>
                <span className="text-[10px] font-semibold text-amber-700 group-hover:underline">
                  Rincian →
                </span>
              </div>
              <div className="text-sm font-extrabold text-amber-900 mt-1 tabular-nums">
                {formatIdr(arPeriodTotal)}
              </div>
            </button>
            <div className="bg-rose-50/70 border border-rose-200 rounded-lg p-2.5">
              <div className="text-[10px] uppercase font-bold text-rose-800">Hutang Pembelian (AP)</div>
              <div className="text-sm font-extrabold text-rose-900 mt-1 tabular-nums">
                {formatIdr(unpaidPurchaseAp)}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* =====================================================================
          MODAL 1: CLICK ON GRAFIK OKUPANSI BAR (Gambar 3 Reference)
         ===================================================================== */}
      {selectedDayModal && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-[1px] flex items-center justify-center p-4"
          onClick={() => setSelectedDayModal(null)}
        >
          <div
            className="bg-white border border-slate-200 rounded-2xl shadow-2xl w-full max-w-md max-h-[82vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3">
              <div>
                <h4 className="text-base font-extrabold text-slate-900">
                  {formatIndonesianLongDate(selectedDayModal.date)}
                </h4>
                <p className="text-xs text-slate-500 mt-0.5">
                  {selectedDayModal.sold_rooms} / {selectedDayModal.sellable_rooms} kamar terisi •{' '}
                  {Math.round(Number(selectedDayModal.occupancy_pct) || 0)}%
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleExportDayModal(selectedDayModal, dayModalReservations)}
                  className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold flex items-center gap-1.5 shadow-2xs cursor-pointer"
                >
                  <IconDownload className="w-3.5 h-3.5 text-slate-600" />
                  <span>Export</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedDayModal(null)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 cursor-pointer"
                  title="Tutup"
                >
                  <IconX className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Modal Scrollable List */}
            <div className="p-4 space-y-2.5 overflow-y-auto flex-1">
              {dayModalReservations.length === 0 ? (
                <div className="py-10 text-center text-xs text-slate-400">
                  Tidak ada reservasi kamar terisi pada tanggal ini
                </div>
              ) : (
                dayModalReservations.map((r) => {
                  const badge = formatReservationStatusBadge(r.reservation_status);
                  return (
                    <div
                      key={`${r.reservation_id}-${r.room_number}`}
                      className="bg-slate-50/80 border border-slate-200/70 rounded-xl p-3.5 space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs font-extrabold text-blue-600">
                          {r.booking_code}
                        </span>
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md ${badge.className}`}>
                          {badge.label}
                        </span>
                      </div>
                      <div className="flex items-baseline justify-between gap-3">
                        <div className="text-xs text-slate-800 min-w-0">
                          <span className="font-bold text-slate-900">{r.guest_name}</span>{' '}
                          <span className="text-slate-500">
                            • {r.room_number} {r.room_type_name}
                          </span>
                        </div>
                        <div className="text-sm font-extrabold text-slate-900 tabular-nums shrink-0 text-right">
                          <div>{formatIdr(r.room_rate ?? r.total_price)}</div>
                          {Number(r.total_stay_nights || r.nights) > 1 && (
                            <div className="text-[10px] font-medium text-slate-400">
                              Total {r.total_stay_nights || r.nights} mlm: {formatIdr(r.full_total_price ?? r.total_price)}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-slate-400">
                        <span>{formatTimeRangeLabel(r)}</span>
                        <div className="flex items-center gap-1.5">
                          {r.is_complimentary && (
                            <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.2 rounded font-bold">
                              Complimentary
                            </span>
                          )}
                          {Number(r.discount_amount) > 0 && (
                            <span className="text-[10px] bg-purple-100 text-purple-800 px-1.5 py-0.2 rounded font-bold">
                              Diskon {formatIdr(r.discount_amount)}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL 2: CLICK ON OKUPANSI PER KAMAR ROW (Gambar 4 Reference)
         ===================================================================== */}
      {selectedRoomModal && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-[1px] flex items-center justify-center p-4"
          onClick={() => setSelectedRoomModal(null)}
        >
          <div
            className="bg-white border border-slate-200 rounded-2xl shadow-2xl w-full max-w-md max-h-[82vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3">
              <div>
                <h4 className="text-base font-extrabold text-slate-900">
                  {selectedRoomModal.room_number} {selectedRoomModal.room_type_name}
                </h4>
                <p className="text-xs text-slate-500 mt-0.5">
                  {selectedRoomModal.booking_count} booking • {formatIdr(selectedRoomModal.room_revenue)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleExportRoomModal(selectedRoomModal, roomModalReservations)}
                  className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold flex items-center gap-1.5 shadow-2xs cursor-pointer"
                >
                  <IconDownload className="w-3.5 h-3.5 text-slate-600" />
                  <span>Export</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedRoomModal(null)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 cursor-pointer"
                  title="Tutup"
                >
                  <IconX className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Modal Scrollable List */}
            <div className="p-4 space-y-2.5 overflow-y-auto flex-1">
              {roomModalReservations.length === 0 ? (
                <div className="py-10 text-center text-xs text-slate-400">
                  Belum ada reservasi pada kamar ini di periode yang dipilih
                </div>
              ) : (
                roomModalReservations.map((r) => {
                  const badge = formatReservationStatusBadge(r.reservation_status);
                  return (
                    <div
                      key={r.reservation_id}
                      className="bg-slate-50/80 border border-slate-200/70 rounded-xl p-3.5 space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs font-extrabold text-blue-600">
                          {r.booking_code}
                        </span>
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md ${badge.className}`}>
                          {badge.label}
                        </span>
                      </div>
                      <div className="flex items-baseline justify-between gap-3">
                        <div className="text-xs font-bold text-slate-900 min-w-0 truncate">
                          {r.guest_name}
                        </div>
                        <div className="text-sm font-extrabold text-slate-900 tabular-nums shrink-0 text-right">
                          <div>{formatIdr(r.total_price)}</div>
                          {Number(r.room_rate) > 0 && Number(r.nights) > 1 && (
                            <div className="text-[10px] font-medium text-slate-400">
                              Rate: {formatIdr(r.room_rate)} / mlm
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-slate-400">
                        <span>
                          {formatMediumDateId(r.check_in)} - {formatMediumDateId(r.check_out)} ({r.nights} malam)
                        </span>
                        <div className="flex items-center gap-1.5">
                          {r.is_complimentary && (
                            <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.2 rounded font-bold">
                              Comp
                            </span>
                          )}
                          {Number(r.discount_amount) > 0 && (
                            <span className="text-[10px] bg-purple-100 text-purple-800 px-1.5 py-0.2 rounded font-bold">
                              Diskon {formatIdr(r.discount_amount)}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL 3: CLICK ON PIUTANG TAMU (AR) (Sheet Piutang Penjualan)
         ===================================================================== */}
      {showArModal && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-[1px] flex items-center justify-center p-4"
          onClick={() => setShowArModal(false)}
        >
          <div
            className="bg-white border border-slate-200 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3">
              <div>
                <h4 className="text-base font-extrabold text-slate-900">
                  Rincian Piutang Tamu (Accounts Receivable / AR)
                </h4>
                <p className="text-xs text-slate-500 mt-0.5">
                  Sheet Piutang Periode Dipilih ({arPeriodItems.length} transaksi):{' '}
                  <span className="font-bold text-amber-800">{formatIdr(arPeriodTotal)}</span>
                  {' '}• Semua Waktu ({arAllTimeCount} transaksi):{' '}
                  <span className="font-bold text-slate-800">{formatIdr(arAllTimeTotal)}</span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowArModal(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 cursor-pointer"
                title="Tutup"
              >
                <IconX className="w-4 h-4" />
              </button>
            </div>

            <div className="px-5 py-3 bg-amber-50/70 border-b border-amber-200/80 text-xs text-amber-950 space-y-1">
              <div className="font-bold">Sumber Data Piutang Tamu (AR):</div>
              <p className="text-[11px] text-amber-900 leading-relaxed">
                Angka <strong>Piutang Tamu (AR)</strong> dihitung langsung dari{' '}
                <strong>Transaksi &amp; Folio → Penjualan → Sheet Piutang</strong>, yaitu reservasi
                yang sudah <strong>Check-out (CHECKED_OUT)</strong> dan masih memiliki sisa tagihan (
                <code className="px-1 py-0.5 rounded bg-amber-100/80 font-mono">remaining &gt; 0</code>
                ), di luar reservasi yang ditanggung OTA (<strong>OTA Collect</strong>). Begitu tagihan
                dilunasi, transaksi otomatis berpindah ke <strong>Sheet Selesai</strong>.
              </p>
            </div>

            <div className="p-4 space-y-2.5 overflow-y-auto flex-1">
              {arPeriodItems.length === 0 ? (
                <div className="py-10 text-center text-xs text-slate-400">
                  Tidak ada transaksi pada Sheet Piutang (reservasi Check-out dengan sisa tagihan) di periode ini.
                </div>
              ) : (
                arPeriodItems.map((it, idx) => (
                  <div
                    key={`${it.bid}-${idx}`}
                    className="bg-slate-50/80 border border-slate-200/70 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-extrabold text-blue-600">
                          {it.bid}
                        </span>
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-orange-100 text-orange-800 border border-orange-300">
                          Piutang
                        </span>
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-slate-100 text-slate-700">
                          {it.room_count} Kamar
                        </span>
                      </div>
                      <div className="text-xs font-bold text-slate-900 truncate">
                        {it.guest_name} • {it.room_summary}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {it.check_in && it.check_out
                          ? `Stay: ${formatMediumDateId(it.check_in)} s/d ${formatMediumDateId(it.check_out)}`
                          : `Tanggal Transaksi: ${formatMediumDateId(it.tx_date)}`}
                      </div>
                    </div>
                    <div className="text-right shrink-0 space-y-0.5">
                      <div className="text-[11px] text-slate-500">
                        Net: <span className="font-semibold text-slate-700">{formatIdr(it.net)}</span> • Dibayar:{' '}
                        <span className="font-semibold text-emerald-700">{formatIdr(it.paid)}</span>
                      </div>
                      <div className="text-sm font-extrabold text-amber-800 tabular-nums">
                        Sisa Piutang: {formatIdr(it.remaining)}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
