/**
 * OAK HIMS — Tahap A: Tab Riwayat Mutasi Global & Laporan Mutasi Barang (8 Kolom)
 * Menampilkan histori mutasi persediaan lintas produk/gudang dengan perhitungan
 * Saldo Awal (balance_before) dan Saldo Akhir (balance_after) per partisi
 * (property_id + product_id + location_id), pemisahan total per satuan dasar,
 * serta Pratinjau & Cetak Laporan Mutasi Barang sesuai format standar Owner.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  fetchGlobalStockMovements,
  fetchStockTrackedProducts,
} from './posInventoryApi';
import type {
  StockLocation,
  StockTrackedProductOption,
  GlobalStockMovementsReport,
  GlobalStockMovementItem,
  GlobalMovementOperationFilter,
} from './posInventoryTypes';

interface Props {
  propertyId: number;
  locations: StockLocation[];
  onOpenLedger?: (params: {
    product_id: number;
    product_name: string;
    location_id: number;
    location_name: string;
    base_unit_code: string;
  }) => void;
}

const OPERATION_FILTER_OPTIONS: { value: GlobalMovementOperationFilter; label: string }[] = [
  { value: 'ALL', label: 'Semua Jenis Mutasi' },
  { value: 'OPENING_BALANCE', label: 'Saldo Awal (OPENING_BALANCE)' },
  { value: 'PURCHASE_RECEIPT', label: 'Penerimaan Pembelian / GRN (PURCHASE_RECEIPT)' },
  { value: 'STOCK_TRANSFER', label: 'Semua Transfer Gudang (STOCK_TRANSFER)' },
  { value: 'STOCK_TRANSFER_IN', label: 'Transfer Masuk (STOCK_TRANSFER_IN)' },
  { value: 'STOCK_TRANSFER_OUT', label: 'Transfer Keluar (STOCK_TRANSFER_OUT)' },
  { value: 'STOCK_OPNAME', label: 'Opname Fisik (STOCK_OPNAME)' },
  { value: 'STOCK_ADJUSTMENT', label: 'Penyesuaian Stok (STOCK_ADJUSTMENT)' },
  { value: 'POS_SALE', label: 'Penjualan POS (POS_SALE)' },
  { value: 'ROOM_MINIBAR_POSTING', label: 'Minibar Kamar (ROOM_MINIBAR_POSTING)' },
];

function formatQty(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '0';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
    if (match) {
      const sign = match[1] === '-' ? '-' : '';
      const intClean = match[2].replace(/^0+(?=\d)/, '') || '0';
      const fracClean = (match[3] || '').slice(0, 3).replace(/0+$/, '');
      if (intClean === '0' && !fracClean) return '0';
      const intFormatted = intClean.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
      return fracClean ? `${sign}${intFormatted},${fracClean}` : `${sign}${intFormatted}`;
    }
  }
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('id-ID', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}

function getTodayJakartaDateString(): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jakarta',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === 'year')?.value || '2026';
    const m = parts.find((p) => p.type === 'month')?.value || '01';
    const d = parts.find((p) => p.type === 'day')?.value || '01';
    return `${y}-${m}-${d}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function getMonthStartJakartaDateString(): string {
  const today = getTodayJakartaDateString();
  return `${today.slice(0, 8)}01`;
}

export default function StockMovementHistorySection({
  propertyId,
  locations,
  onOpenLedger,
}: Props) {
  // Filter state
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<number | 'ALL'>('ALL');
  const [selectedSublocation, setSelectedSublocation] = useState<string>('ALL');
  const [selectedProductId, setSelectedProductId] = useState<number | 'ALL'>('ALL');
  const [operationType, setOperationType] = useState<GlobalMovementOperationFilter>('ALL');
  const [direction, setDirection] = useState<'ALL' | 'IN' | 'OUT'>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortOrder, setSortOrder] = useState<'DESC' | 'ASC'>('DESC');
  const [page, setPage] = useState<number>(1);
  const [limit, setLimit] = useState<number>(50);

  // Master product options for Item filter
  const [productOptions, setProductOptions] = useState<StockTrackedProductOption[]>([]);

  // Report state (table + summary)
  const [report, setReport] = useState<GlobalStockMovementsReport | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showPartitionSummary, setShowPartitionSummary] = useState<boolean>(false);
  const [selectedAdjustmentDetail, setSelectedAdjustmentDetail] = useState<GlobalStockMovementItem | null>(null);

  // Print Preview Modal state (holds single consistent export_all=true snapshot)
  const [previewOpen, setPreviewOpenState] = useState<boolean>(false);
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewReport, setPreviewReport] = useState<GlobalStockMovementsReport | null>(null);
  const [previewContextKey, setPreviewContextKey] = useState<string | null>(null);

  // Guard state object (persists across renders without extra re-render cycles; protects against stale async responses)
  const [asyncGuard, setAsyncGuard] = useState({
    mounted: true,
    movementsReqSeq: 0,
    previewReqSeq: 0,
    lastTableContextKey: '',
    lastFilterContextKey: '',
    activeReportContextKey: '',
    activePreviewContextKey: '',
    previewOpenNow: false,
    previewWasOpened: false,
    previewLoadingNow: false,
    previewErrorNow: null as string | null,
    previewReportNow: null as GlobalStockMovementsReport | null,
  });
  void setAsyncGuard;

  const filterContextKey = [
    propertyId,
    selectedWarehouseId,
    selectedSublocation,
    selectedProductId,
    startDate,
    endDate,
    operationType,
    direction,
    searchQuery.trim(),
  ].join('|');
  const tableContextKey = `${filterContextKey}|${sortOrder}|${limit}`;

  const isTableContextChanged =
    asyncGuard.lastTableContextKey !== '' && asyncGuard.lastTableContextKey !== tableContextKey;
  const effectivePage = isTableContextChanged ? 1 : page;

  if (isTableContextChanged) {
    asyncGuard.movementsReqSeq += 1;
    if (page !== 1) {
      setPage(1);
    }
  }
  asyncGuard.lastTableContextKey = tableContextKey;

  const isFilterContextChanged =
    asyncGuard.lastFilterContextKey !== '' && asyncGuard.lastFilterContextKey !== filterContextKey;
  if (isFilterContextChanged) {
    asyncGuard.previewReqSeq += 1;
    asyncGuard.activePreviewContextKey = '';
    asyncGuard.previewLoadingNow = false;
    asyncGuard.previewErrorNow = null;
    asyncGuard.previewReportNow = null;
    if (previewReport !== null) setPreviewReport(null);
    if (previewError !== null) setPreviewError(null);
    if (previewLoading) setPreviewLoading(false);
    if (previewContextKey !== null) setPreviewContextKey(null);
  }
  asyncGuard.lastFilterContextKey = filterContextKey;

  const setPreviewOpen = useCallback(
    (nextOpen: boolean | ((prev: boolean) => boolean)) => {
      setPreviewOpenState((prev) => {
        const resolved = typeof nextOpen === 'function' ? nextOpen(prev) : nextOpen;
        if (!resolved) {
          asyncGuard.previewReqSeq += 1;
          asyncGuard.previewOpenNow = false;
          asyncGuard.activePreviewContextKey = '';
          asyncGuard.previewLoadingNow = false;
          asyncGuard.previewErrorNow = null;
          asyncGuard.previewReportNow = null;
          setPreviewLoading(false);
          setPreviewError(null);
          setPreviewReport(null);
          setPreviewContextKey(null);
        } else {
          asyncGuard.previewOpenNow = true;
          asyncGuard.previewWasOpened = true;
        }
        return resolved;
      });
    },
    [asyncGuard]
  );

  // Unmount cleanup guard
  useEffect(() => {
    asyncGuard.mounted = true;
    return () => {
      asyncGuard.mounted = false;
      asyncGuard.movementsReqSeq += 1;
      asyncGuard.previewReqSeq += 1;
    };
  }, [asyncGuard]);

  // Load tracked products for dropdown filter
  useEffect(() => {
    let active = true;
    fetchStockTrackedProducts(propertyId)
      .then((list) => {
        if (active && asyncGuard.mounted) setProductOptions(list);
      })
      .catch(() => {
        if (active && asyncGuard.mounted) setProductOptions([]);
      });
    return () => {
      active = false;
    };
  }, [propertyId, asyncGuard]);

  const sublocationOptions = useMemo(() => {
    const map = new Map<string, string>();
    const addSub = (val: string | null | undefined) => {
      if (!val || !val.trim()) return;
      const trimmed = val.trim();
      const key = trimmed.toLowerCase();
      if (!map.has(key)) map.set(key, trimmed);
    };
    (report?.available_sublocations || []).forEach(addSub);
    productOptions.forEach((p) => addSub(p.storage_sublocation));
    ['Showcase', 'Chiller', 'Freezer', 'Rak Kering', 'Lemari Linen', 'Rak Amenities', 'Gudang Kering'].forEach(addSub);
    if (selectedSublocation !== 'ALL') addSub(selectedSublocation);
    return Array.from(map.values()).sort((a, b) => a.localeCompare(b, 'id-ID'));
  }, [report?.available_sublocations, productOptions, selectedSublocation]);

  const loadMovements = useCallback(async () => {
    const reqId = ++asyncGuard.movementsReqSeq;
    const reqContextKey = `${tableContextKey}|page:${effectivePage}`;
    asyncGuard.activeReportContextKey = reqContextKey;
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetchGlobalStockMovements(propertyId, {
        warehouse_id: selectedWarehouseId === 'ALL' ? null : selectedWarehouseId,
        storage_sublocation: selectedSublocation === 'ALL' ? null : selectedSublocation,
        product_id: selectedProductId === 'ALL' ? null : selectedProductId,
        start_date: startDate || null,
        end_date: endDate || null,
        operation_type: operationType,
        direction,
        search: searchQuery.trim() || null,
        sort_order: sortOrder,
        export_all: false,
        page: effectivePage,
        limit,
      });
      if (
        !asyncGuard.mounted ||
        reqId !== asyncGuard.movementsReqSeq ||
        reqContextKey !== asyncGuard.activeReportContextKey
      ) {
        return;
      }
      setReport(res);
      setErrorMsg(null);
      setLoading(false);
    } catch (err: any) {
      if (
        !asyncGuard.mounted ||
        reqId !== asyncGuard.movementsReqSeq ||
        reqContextKey !== asyncGuard.activeReportContextKey
      ) {
        return;
      }
      setReport(null);
      setErrorMsg(err?.message || 'Gagal memuat riwayat mutasi persediaan');
      setLoading(false);
    }
  }, [
    asyncGuard,
    tableContextKey,
    effectivePage,
    propertyId,
    selectedWarehouseId,
    selectedSublocation,
    selectedProductId,
    startDate,
    endDate,
    operationType,
    direction,
    searchQuery,
    sortOrder,
    limit,
  ]);

  useEffect(() => {
    void loadMovements();
  }, [loadMovements]);

  // Load consistent export snapshot for Print Preview & Cetak
  const loadPreviewSnapshot = useCallback(async () => {
    const reqId = ++asyncGuard.previewReqSeq;
    const reqFilterContext = filterContextKey;
    asyncGuard.activePreviewContextKey = reqFilterContext;
    asyncGuard.previewLoadingNow = true;
    asyncGuard.previewErrorNow = null;
    asyncGuard.previewReportNow = null;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewReport(null);
    setPreviewContextKey(null);
    try {
      const exportData = await fetchGlobalStockMovements(propertyId, {
        warehouse_id: selectedWarehouseId === 'ALL' ? null : selectedWarehouseId,
        storage_sublocation: selectedSublocation === 'ALL' ? null : selectedSublocation,
        product_id: selectedProductId === 'ALL' ? null : selectedProductId,
        start_date: startDate || null,
        end_date: endDate || null,
        operation_type: operationType,
        direction,
        search: searchQuery.trim() || null,
        sort_order: 'ASC',
        export_all: true,
      });
      if (
        !asyncGuard.mounted ||
        reqId !== asyncGuard.previewReqSeq ||
        reqFilterContext !== asyncGuard.activePreviewContextKey ||
        (asyncGuard.previewWasOpened && !asyncGuard.previewOpenNow)
      ) {
        return;
      }
      asyncGuard.previewLoadingNow = false;
      asyncGuard.previewErrorNow = null;
      asyncGuard.previewReportNow = exportData;
      setPreviewReport(exportData);
      setPreviewContextKey(reqFilterContext);
      setPreviewError(null);
      setPreviewLoading(false);
    } catch (err: any) {
      if (
        !asyncGuard.mounted ||
        reqId !== asyncGuard.previewReqSeq ||
        reqFilterContext !== asyncGuard.activePreviewContextKey ||
        (asyncGuard.previewWasOpened && !asyncGuard.previewOpenNow)
      ) {
        return;
      }
      const errMsg = err?.message || 'Gagal memuat dataset pratinjau Laporan Mutasi Barang';
      asyncGuard.previewLoadingNow = false;
      asyncGuard.previewErrorNow = errMsg;
      asyncGuard.previewReportNow = null;
      setPreviewReport(null);
      setPreviewContextKey(null);
      setPreviewError(errMsg);
      setPreviewLoading(false);
    }
  }, [
    asyncGuard,
    filterContextKey,
    propertyId,
    selectedWarehouseId,
    selectedSublocation,
    selectedProductId,
    startDate,
    endDate,
    operationType,
    direction,
    searchQuery,
  ]);

  const handleOpenPreview = () => {
    setPreviewOpen(true);
    void loadPreviewSnapshot();
  };

  const canPrintPreview =
    !previewLoading &&
    !previewError &&
    previewReport !== null &&
    previewContextKey === filterContextKey &&
    !asyncGuard.previewLoadingNow &&
    !asyncGuard.previewErrorNow &&
    asyncGuard.previewReportNow !== null &&
    asyncGuard.activePreviewContextKey === filterContextKey;

  // Trigger print using the exact in-memory previewReport snapshot without re-fetching
  const handlePrintFromPreview = () => {
    if (!asyncGuard.mounted || !canPrintPreview) return;
    if (asyncGuard.previewWasOpened && (!previewOpen || !asyncGuard.previewOpenNow)) return;
    window.print();
  };

  const handleResetFilters = () => {
    setStartDate('');
    setEndDate('');
    setSelectedWarehouseId('ALL');
    setSelectedSublocation('ALL');
    setSelectedProductId('ALL');
    setOperationType('ALL');
    setDirection('ALL');
    setSearchQuery('');
    setSortOrder('DESC');
    setPage(1);
  };

  const applyQuickPeriod = (mode: 'TODAY' | 'MONTH' | 'ALL') => {
    if (mode === 'ALL') {
      setStartDate('');
      setEndDate('');
    } else if (mode === 'TODAY') {
      const today = getTodayJakartaDateString();
      setStartDate(today);
      setEndDate(today);
    } else if (mode === 'MONTH') {
      setStartDate(getMonthStartJakartaDateString());
      setEndDate(getTodayJakartaDateString());
    }
  };

  const formatWarehouseHeaderLine = (rep: GlobalStockMovementsReport) => {
    if (rep.filters.warehouse_code && rep.filters.warehouse_name) {
      return `Warehouse: ${rep.filters.warehouse_code} (${rep.filters.warehouse_name})`;
    }
    return 'Warehouse: Semua Warehouse (Saldo per Lokasi Tercatat)';
  };

  const formatPeriodHeaderLine = (rep: GlobalStockMovementsReport) => {
    const s = rep.filters.start_date || 'Awal Histori';
    const e = rep.filters.end_date || 'Sekarang';
    return `Periode: ${s} s/d ${e}`;
  };

  return (
    <div className="space-y-5" data-testid="stock-movement-history-section">
      {/* Print-only stylesheet so window.print() prints the exact preview modal cleanly in A4 Landscape across multiple pages */}
      <style>{`
        @page {
          size: A4 landscape;
          margin: 10mm 12mm;
        }
        @media print {
          html,
          body {
            width: auto !important;
            height: auto !important;
            min-height: 0 !important;
            max-height: none !important;
            overflow: visible !important;
            margin: 0 !important;
            padding: 0 !important;
            background: #ffffff !important;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          body *:not(:has(#oak-mutation-report-printable)):not(#oak-mutation-report-printable):not(#oak-mutation-report-printable *) {
            display: none !important;
          }
          body *:has(#oak-mutation-report-printable),
          .oak-mutation-modal-backdrop,
          .oak-mutation-modal-dialog,
          .oak-mutation-modal-body {
            position: static !important;
            display: block !important;
            width: 100% !important;
            max-width: none !important;
            height: auto !important;
            min-height: 0 !important;
            max-height: none !important;
            overflow: visible !important;
            margin: 0 !important;
            padding: 0 !important;
            border: none !important;
            box-shadow: none !important;
            background: transparent !important;
            transform: none !important;
          }
          .oak-mutation-modal-toolbar {
            display: none !important;
          }
          #oak-mutation-report-printable,
          #oak-mutation-report-printable * {
            visibility: visible !important;
          }
          #oak-mutation-report-printable {
            position: static !important;
            display: block !important;
            width: 100% !important;
            max-width: none !important;
            height: auto !important;
            max-height: none !important;
            overflow: visible !important;
            margin: 0 !important;
            padding: 0 !important;
            background: #ffffff !important;
            color: #000000 !important;
            box-shadow: none !important;
            border: none !important;
          }
          .oak-mutation-print-table {
            width: 100% !important;
            border-collapse: collapse !important;
            page-break-inside: auto !important;
            break-inside: auto !important;
          }
          .oak-mutation-print-table thead {
            display: table-header-group !important;
          }
          .oak-mutation-print-table tbody {
            display: table-row-group !important;
          }
          .oak-mutation-print-table tr {
            break-inside: avoid !important;
            page-break-inside: avoid !important;
          }
          .oak-mutation-print-table th,
          .oak-mutation-print-table td {
            padding-top: 4px !important;
            padding-bottom: 4px !important;
          }
          .oak-mutation-signature-block {
            break-inside: avoid !important;
            page-break-inside: avoid !important;
            margin-top: 14px !important;
            padding-top: 6px !important;
          }
          .oak-mutation-signature-spacer {
            height: 44px !important;
          }
        }
      `}</style>

      {/* Filter Card */}
      <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-2xs space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b border-gray-100 pb-3">
          <div>
            <h2 className="text-base font-extrabold text-gray-900">
              Filter Riwayat Mutasi &amp; Laporan Mutasi Barang
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Filter tanggal (WIB half-open), lokasi gudang/outlet, produk, dan jenis operasi dapat digabung.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => applyQuickPeriod('TODAY')}
              className="px-2.5 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-[11px] font-bold text-gray-700 cursor-pointer"
            >
              Hari Ini (WIB)
            </button>
            <button
              type="button"
              onClick={() => applyQuickPeriod('MONTH')}
              className="px-2.5 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-[11px] font-bold text-gray-700 cursor-pointer"
            >
              Bulan Ini
            </button>
            <button
              type="button"
              onClick={handleResetFilters}
              data-testid="mutation-reset-filters-btn"
              className="px-2.5 py-1.5 rounded-lg border border-gray-200 hover:bg-rose-50 hover:text-rose-800 hover:border-rose-200 text-[11px] font-bold text-gray-600 cursor-pointer"
            >
              Reset Filter
            </button>
            <button
              type="button"
              onClick={() => void loadMovements()}
              disabled={loading}
              className="px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-xs font-bold text-gray-700 cursor-pointer"
            >
              {loading ? 'Memuat...' : 'Segarkan'}
            </button>
            <button
              type="button"
              data-testid="open-mutation-report-preview-btn"
              onClick={handleOpenPreview}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#1b4332] hover:bg-[#2d6a4f] text-white text-xs font-bold shadow-xs transition-colors cursor-pointer"
            >
              <svg className="w-4 h-4 text-[#d4af37]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"
                />
              </svg>
              Pratinjau &amp; Cetak Laporan Mutasi Barang
            </button>
          </div>
        </div>

        {/* Grid Filter Controls */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Start Date */}
          <div>
            <label className="block text-[11px] font-bold text-gray-600 mb-1">
              Dari Tanggal (WIB)
            </label>
            <input
              type="date"
              data-testid="mutation-filter-start-date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-gray-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700"
            />
          </div>

          {/* End Date */}
          <div>
            <label className="block text-[11px] font-bold text-gray-600 mb-1">
              Sampai Tanggal (WIB)
            </label>
            <input
              type="date"
              data-testid="mutation-filter-end-date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-gray-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700"
            />
          </div>

          {/* Warehouse / Location */}
          <div>
            <label className="block text-[11px] font-bold text-gray-600 mb-1">
              Lokasi / Warehouse
            </label>
            <select
              data-testid="mutation-filter-warehouse"
              value={selectedWarehouseId}
              onChange={(e) =>
                setSelectedWarehouseId(e.target.value === 'ALL' ? 'ALL' : Number(e.target.value))
              }
              className="w-full px-3 py-2 text-xs border border-gray-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700 cursor-pointer"
            >
              <option value="ALL">Semua Lokasi Penyimpanan</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.code} ({loc.name})
                </option>
              ))}
            </select>
          </div>

          {/* Tempat Penyimpanan (Sub-Location) */}
          <div>
            <label className="block text-[11px] font-bold text-gray-600 mb-1">
              Tempat Penyimpanan
            </label>
            <select
              data-testid="mutation-filter-sublocation"
              value={selectedSublocation}
              onChange={(e) => setSelectedSublocation(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-gray-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700 cursor-pointer"
            >
              <option value="ALL">Semua Tempat Penyimpanan</option>
              {sublocationOptions.map((sub) => (
                <option key={sub} value={sub}>
                  📍 {sub}
                </option>
              ))}
            </select>
          </div>

          {/* Item / Product */}
          <div>
            <label className="block text-[11px] font-bold text-gray-600 mb-1">
              Item / Barang
            </label>
            <select
              data-testid="mutation-filter-product"
              value={selectedProductId}
              onChange={(e) =>
                setSelectedProductId(e.target.value === 'ALL' ? 'ALL' : Number(e.target.value))
              }
              className="w-full px-3 py-2 text-xs border border-gray-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700 cursor-pointer"
            >
              <option value="ALL">Semua Item Persediaan</option>
              {productOptions.map((prod) => (
                <option key={prod.id} value={prod.id}>
                  {prod.item_code ? `${prod.item_code} — ` : ''}
                  {prod.name} ({prod.base_unit_code})
                </option>
              ))}
            </select>
          </div>

          {/* Operation Type / Keterangan */}
          <div>
            <label className="block text-[11px] font-bold text-gray-600 mb-1">
              Jenis Mutasi / Keterangan
            </label>
            <select
              data-testid="mutation-filter-operation-type"
              value={operationType}
              onChange={(e) => setOperationType(e.target.value as GlobalMovementOperationFilter)}
              className="w-full px-3 py-2 text-xs border border-gray-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700 cursor-pointer"
            >
              {OPERATION_FILTER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Direction */}
          <div>
            <label className="block text-[11px] font-bold text-gray-600 mb-1">
              Arah Mutasi
            </label>
            <select
              data-testid="mutation-filter-direction"
              value={direction}
              onChange={(e) => setDirection(e.target.value as 'ALL' | 'IN' | 'OUT')}
              className="w-full px-3 py-2 text-xs border border-gray-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700 cursor-pointer"
            >
              <option value="ALL">Semua Arah (Masuk &amp; Keluar)</option>
              <option value="IN">Hanya Barang Masuk (+)</option>
              <option value="OUT">Hanya Barang Keluar (-)</option>
            </select>
          </div>

          {/* Search Query */}
          <div>
            <label className="block text-[11px] font-bold text-gray-600 mb-1">
              Cari Kode / Nama / Referensi / Catatan
            </label>
            <input
              type="text"
              data-testid="mutation-filter-search"
              placeholder="Cth: GRN-, SKU, nama barang, catatan..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-gray-300 rounded-xl bg-gray-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700"
            />
          </div>

          {/* Sort Order & Page Size */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] font-bold text-gray-600 mb-1">
                Urutan Waktu
              </label>
              <select
                data-testid="mutation-filter-sort-order"
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value as 'DESC' | 'ASC')}
                className="w-full px-2.5 py-2 text-xs border border-gray-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700 cursor-pointer"
              >
                <option value="DESC">Terbaru ↓</option>
                <option value="ASC">Kronologis ↑</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-bold text-gray-600 mb-1">
                Baris / Hal
              </label>
              <select
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                className="w-full px-2.5 py-2 text-xs border border-gray-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700 cursor-pointer"
              >
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Scope Notice Banner */}
      {report && (
        <div
          data-testid="mutation-scope-notice"
          className="px-4 py-3 rounded-xl bg-[#faf9f5] border border-[#d4af37]/40 text-xs text-stone-700 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
        >
          <div className="flex items-center gap-2">
            <span className="font-extrabold text-[#1b4332]">Aturan Saldo Partisi:</span>
            <span>{report.scope_notice}</span>
          </div>
          <div className="text-[11px] text-stone-500 whitespace-nowrap">
            Snapshot WIB: <span className="font-bold text-stone-700">{report.snapshot.as_of_wib}</span>
          </div>
        </div>
      )}

      {/* Error Message */}
      {errorMsg && (
        <div
          data-testid="mutation-error-banner"
          className="p-4 bg-rose-50 border border-rose-200 rounded-xl text-rose-800 text-xs flex items-center justify-between"
        >
          <div className="flex items-center gap-2">
            <span>⚠</span>
            <span>{errorMsg}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="text-rose-600 hover:text-rose-900 font-bold ml-2"
          >
            ✕
          </button>
        </div>
      )}

      {/* Totals By Base Unit (Separated per Unit, never mixed across units) */}
      {report && report.totals_by_unit.length > 0 && (
        <div className="space-y-2" data-testid="mutation-totals-by-unit">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-extrabold uppercase tracking-wider text-gray-600">
              Ringkasan Kuantitas Mutasi per Satuan Dasar ({report.pagination.total_rows} Baris Mutasi)
            </h3>
            {report.partition_summaries.length > 0 && (
              <button
                type="button"
                onClick={() => setShowPartitionSummary((prev) => !prev)}
                className="text-xs font-bold text-[#1b4332] hover:underline cursor-pointer"
              >
                {showPartitionSummary
                  ? 'Sembunyikan Ringkasan Saldo per Barang & Lokasi'
                  : `Lihat Ringkasan Saldo per Barang & Lokasi (${report.partition_summaries.length} partisi)`}
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {report.totals_by_unit.map((u) => (
              <div
                key={u.base_unit_code}
                data-testid={`mutation-unit-card-${u.base_unit_code}`}
                className="bg-white border border-gray-200 rounded-2xl p-4 shadow-2xs"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="px-2.5 py-0.5 rounded-full text-xs font-black bg-emerald-50 text-[#1b4332] border border-emerald-200">
                    Satuan: {u.base_unit_code}
                  </span>
                  <span className="text-[11px] text-gray-500 font-semibold">
                    {u.movement_count} mutasi • {u.distinct_product_count} item
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs border-t border-gray-100 pt-2">
                  <div>
                    <div className="text-[10px] text-gray-400 uppercase font-bold">Total Masuk</div>
                    <div className="font-extrabold text-emerald-700">
                      +{formatQty(u.total_in)} {u.base_unit_code}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-gray-400 uppercase font-bold">Total Keluar</div>
                    <div className="font-extrabold text-rose-700">
                      -{formatQty(u.total_out)} {u.base_unit_code}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-gray-400 uppercase font-bold">Selisih Bersih</div>
                    <div className="font-extrabold text-gray-900">
                      {parseFloat(u.net_delta) > 0 ? '+' : ''}
                      {formatQty(u.net_delta)} {u.base_unit_code}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Collapsible Partition Summaries Table */}
      {report && showPartitionSummary && report.partition_summaries.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-2xl shadow-2xs overflow-hidden">
          <div className="px-4 py-3 bg-[#faf9f5] border-b border-gray-200 flex items-center justify-between">
            <span className="text-xs font-extrabold text-gray-800">
              Ringkasan Saldo Partisi (Produk + Lokasi) pada Filter Aktif
            </span>
            <span className="text-[11px] text-gray-500">
              {report.partition_summaries.length} partisi aktif
            </span>
          </div>
          <div className="overflow-x-auto max-h-72">
            <table className="w-full text-left text-xs">
              <thead className="bg-gray-50 border-b border-gray-200 text-[10px] font-bold uppercase text-gray-600">
                <tr>
                  <th className="px-3 py-2">Lokasi</th>
                  <th className="px-3 py-2">Tempat Penyimpanan</th>
                  <th className="px-3 py-2">Kode</th>
                  <th className="px-3 py-2">Nama Barang</th>
                  <th className="px-3 py-2 text-right">Saldo Awal</th>
                  <th className="px-3 py-2 text-right">Total Masuk</th>
                  <th className="px-3 py-2 text-right">Total Keluar</th>
                  <th className="px-3 py-2 text-right">Saldo Akhir</th>
                  <th className="px-3 py-2 text-center">Satuan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {report.partition_summaries.map((ps) => (
                  <tr key={`${ps.product_id}-${ps.location_id}`} className="hover:bg-gray-50/70">
                    <td className="px-3 py-2 font-semibold text-gray-700">
                      {ps.location_code} ({ps.location_name})
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {ps.storage_sublocation ? (
                        <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-[#1b4332] border border-emerald-200">
                          📍 {ps.storage_sublocation}
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-gray-600">{ps.product_code}</td>
                    <td className="px-3 py-2 font-bold text-gray-900">{ps.product_name}</td>
                    <td className="px-3 py-2 text-right font-semibold text-gray-700">
                      {formatQty(ps.opening_balance)}
                    </td>
                    <td className="px-3 py-2 text-right font-bold text-emerald-700">
                      {parseFloat(ps.total_in) > 0 ? `+${formatQty(ps.total_in)}` : '0'}
                    </td>
                    <td className="px-3 py-2 text-right font-bold text-rose-700">
                      {parseFloat(ps.total_out) > 0 ? `-${formatQty(ps.total_out)}` : '0'}
                    </td>
                    <td className="px-3 py-2 text-right font-black text-gray-900">
                      {formatQty(ps.closing_balance)}
                    </td>
                    <td className="px-3 py-2 text-center text-[11px] font-bold text-gray-500">
                      {ps.base_unit_code}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Main Movement History Table */}
      <div className="bg-white border border-gray-200 rounded-2xl shadow-2xs overflow-hidden">
        {loading ? (
          <div className="py-20 text-center text-gray-400">
            <svg className="w-8 h-8 animate-spin mx-auto text-emerald-700 mb-2" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            <div className="text-xs">Memuat riwayat mutasi persediaan...</div>
          </div>
        ) : !report || report.movements.length === 0 ? (
          <div className="py-16 text-center text-gray-400" data-testid="mutation-empty-state">
            <div className="text-sm font-bold text-gray-700">
              Tidak ada riwayat mutasi pada filter yang dipilih
            </div>
            <div className="text-xs text-gray-400 mt-1">
              Silakan sesuaikan rentang tanggal, lokasi gudang, item, atau jenis operasi.
            </div>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs" data-testid="mutation-history-table">
                <thead className="bg-[#faf9f5] border-b border-gray-200 text-gray-600 font-bold uppercase text-[10px] tracking-wider">
                  <tr>
                    <th className="px-3.5 py-3">Tgl (WIB)</th>
                    <th className="px-3.5 py-3">Lokasi</th>
                    <th className="px-3.5 py-3">Tempat Penyimpanan</th>
                    <th className="px-3.5 py-3">Kode</th>
                    <th className="px-3.5 py-3">Nama Barang</th>
                    <th className="px-3.5 py-3 text-right">Saldo Awal</th>
                    <th className="px-3.5 py-3 text-right">Masuk</th>
                    <th className="px-3.5 py-3 text-right">Keluar</th>
                    <th className="px-3.5 py-3 text-right">Saldo Akhir</th>
                    <th className="px-3.5 py-3 text-center">Satuan</th>
                    <th className="px-3.5 py-3">Keterangan</th>
                    {onOpenLedger && <th className="px-3.5 py-3 text-center">Kartu Stok</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {report.movements.map((mov: GlobalStockMovementItem) => {
                    const qtyIn = parseFloat(mov.quantity_in);
                    const qtyOut = parseFloat(mov.quantity_out);

                    return (
                      <tr
                        key={mov.movement_id}
                        data-testid={`mutation-row-${mov.movement_id}`}
                        className="hover:bg-gray-50/80 transition-colors"
                      >
                        {/* Tgl (WIB) */}
                        <td className="px-3.5 py-3 whitespace-nowrap">
                          <div className="font-bold text-gray-900">{mov.movement_date_wib}</div>
                          <div className="text-[10px] text-gray-400">
                            {mov.movement_time_wib.slice(11)} WIB
                          </div>
                        </td>

                        {/* Lokasi */}
                        <td className="px-3.5 py-3 whitespace-nowrap">
                          <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold bg-gray-100 text-gray-700 border border-gray-200">
                            {mov.location_code} ({mov.location_name})
                          </span>
                        </td>

                        {/* Tempat Penyimpanan */}
                        <td className="px-3.5 py-3 whitespace-nowrap">
                          {mov.storage_sublocation ? (
                            <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-[#1b4332] border border-emerald-200">
                              📍 {mov.storage_sublocation}
                            </span>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </td>

                        {/* Kode */}
                        <td className="px-3.5 py-3 font-mono text-[11px] font-bold text-gray-700 whitespace-nowrap">
                          {mov.product_code}
                        </td>

                        {/* Nama Barang */}
                        <td className="px-3.5 py-3">
                          <div className="font-extrabold text-gray-900">{mov.product_name}</div>
                        </td>

                        {/* Saldo Awal */}
                        <td className="px-3.5 py-3 text-right font-semibold text-gray-700 whitespace-nowrap">
                          {formatQty(mov.balance_before)}
                        </td>

                        {/* Masuk */}
                        <td className="px-3.5 py-3 text-right font-extrabold text-emerald-700 whitespace-nowrap">
                          {qtyIn > 0 ? `+${formatQty(mov.quantity_in)}` : '0'}
                        </td>

                        {/* Keluar */}
                        <td className="px-3.5 py-3 text-right font-extrabold text-rose-700 whitespace-nowrap">
                          {qtyOut > 0 ? `-${formatQty(mov.quantity_out)}` : '0'}
                        </td>

                        {/* Saldo Akhir */}
                        <td className="px-3.5 py-3 text-right font-black text-gray-900 whitespace-nowrap">
                          {formatQty(mov.balance_after)}
                        </td>

                        {/* Satuan */}
                        <td className="px-3.5 py-3 text-center whitespace-nowrap">
                          <span className="text-[11px] font-bold text-gray-600">
                            {mov.base_unit_code}
                          </span>
                        </td>

                        {/* Keterangan */}
                        <td className="px-3.5 py-3 max-w-xs">
                          <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
                            {mov.operation_type === 'STOCK_ADJUSTMENT' ? (
                              <button
                                type="button"
                                data-testid={`mutation-adjustment-detail-btn-${mov.movement_id}`}
                                onClick={() => setSelectedAdjustmentDetail(mov)}
                                title="Klik untuk melihat Alasan Penyesuaian & Catatan"
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border transition-colors cursor-pointer ${
                                  mov.direction === 'IN'
                                    ? 'bg-emerald-50 text-emerald-800 border-emerald-300 hover:bg-emerald-100'
                                    : 'bg-rose-50 text-rose-800 border-rose-300 hover:bg-rose-100'
                                }`}
                              >
                                <span>{mov.operation_label}</span>
                                <span className="text-[10px] opacity-80">ⓘ</span>
                              </button>
                            ) : (
                              <span
                                className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                                  mov.direction === 'IN'
                                    ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                    : 'bg-rose-50 text-rose-800 border-rose-200'
                                }`}
                              >
                                {mov.operation_label}
                              </span>
                            )}
                            {mov.reference_no && (
                              <span className="text-[10px] font-mono text-gray-500">
                                {mov.reference_no}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-gray-600 line-clamp-2">
                            {mov.display_keterangan}
                          </div>
                        </td>

                        {/* Aksi Kartu Stok */}
                        {onOpenLedger && (
                          <td className="px-3.5 py-3 text-center whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() =>
                                onOpenLedger({
                                  product_id: mov.product_id,
                                  product_name: mov.product_name,
                                  location_id: mov.location_id,
                                  location_name: mov.location_name,
                                  base_unit_code: mov.base_unit_code,
                                })
                              }
                              className="px-2.5 py-1 rounded-lg border border-gray-200 hover:border-emerald-500 hover:text-emerald-800 text-gray-600 text-[11px] font-bold transition-colors cursor-pointer bg-white"
                            >
                              Kartu Stok
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination Footer */}
            <div className="px-4 py-3 bg-[#faf9f5] border-t border-gray-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
              <div className="text-gray-600">
                Menampilkan <span className="font-bold text-gray-900">{report.movements.length}</span> dari{' '}
                <span className="font-bold text-gray-900">{report.pagination.total_rows}</span> baris mutasi
                (Halaman {report.pagination.page} dari {report.pagination.total_pages})
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={report.pagination.page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="px-3 py-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-40 font-bold text-gray-700 cursor-pointer"
                >
                  ← Sebelumnya
                </button>
                <button
                  type="button"
                  disabled={report.pagination.page >= report.pagination.total_pages}
                  onClick={() => setPage((p) => p + 1)}
                  className="px-3 py-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-40 font-bold text-gray-700 cursor-pointer"
                >
                  Berikutnya →
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Modal Ringkasan Simpel Penyesuaian Stok (Hanya Alasan Penyesuaian & Catatan) */}
      {selectedAdjustmentDetail && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs"
          onClick={() => setSelectedAdjustmentDetail(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            data-testid="adjustment-reason-notes-modal"
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-2xl shadow-xl border border-gray-200 w-full max-w-sm overflow-hidden animate-in fade-in zoom-in-95 duration-150"
          >
            <div className="px-5 py-3.5 bg-[#1b4332] text-white flex items-center justify-between">
              <h3 className="text-xs font-extrabold tracking-wide uppercase">
                Detail Penyesuaian Stok
              </h3>
              <button
                type="button"
                onClick={() => setSelectedAdjustmentDetail(null)}
                className="text-white/70 hover:text-white text-sm font-bold cursor-pointer"
                aria-label="Tutup"
              >
                ✕
              </button>
            </div>
            <div className="p-5 space-y-3.5 text-xs">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1">
                  Alasan Penyesuaian
                </div>
                <div className="p-2.5 rounded-xl bg-[#faf9f5] border border-gray-200 font-bold text-gray-900">
                  {selectedAdjustmentDetail.reason_label ||
                    selectedAdjustmentDetail.reason_code ||
                    'Tidak tercatat'}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1">
                  Catatan
                </div>
                <div className="p-2.5 rounded-xl bg-[#faf9f5] border border-gray-200 text-gray-700 whitespace-pre-wrap">
                  {selectedAdjustmentDetail.notes && selectedAdjustmentDetail.notes.trim()
                    ? selectedAdjustmentDetail.notes.trim()
                    : '-'}
                </div>
              </div>
            </div>
            <div className="px-5 py-3 bg-gray-50 border-t border-gray-100 flex justify-end">
              <button
                type="button"
                onClick={() => setSelectedAdjustmentDetail(null)}
                className="px-4 py-1.5 rounded-xl bg-[#1b4332] hover:bg-[#2d6a4f] text-white text-xs font-bold cursor-pointer"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Pratinjau & Cetak Laporan Mutasi Barang (8 Kolom) */}
      {previewOpen && (
        <div
          data-testid="mutation-report-preview-modal"
          className="oak-mutation-modal-backdrop fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 overflow-y-auto"
        >
          <div className="oak-mutation-modal-dialog bg-white rounded-2xl shadow-2xl border border-gray-200 w-full max-w-6xl max-h-[92vh] flex flex-col overflow-hidden">
            {/* Modal Toolbar (Hidden when printing) */}
            <div className="oak-mutation-modal-toolbar px-6 py-4 bg-[#1b4332] text-white flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-extrabold tracking-wide">
                  Pratinjau Cetak — Laporan Mutasi Barang (8 Kolom)
                </h3>
                {previewReport && previewContextKey === filterContextKey && !previewError && (
                  <p className="text-[11px] text-emerald-100/90 mt-0.5">
                    Dataset konsisten ({previewReport.pagination.total_rows} baris) • Snapshot WIB:{' '}
                    {previewReport.snapshot.as_of_wib}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void loadPreviewSnapshot()}
                  disabled={previewLoading}
                  data-testid="refresh-mutation-preview-btn"
                  className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-bold transition-colors cursor-pointer"
                >
                  {previewLoading ? 'Memuat...' : 'Muat Ulang Pratinjau'}
                </button>
                <button
                  type="button"
                  onClick={handlePrintFromPreview}
                  disabled={!canPrintPreview}
                  data-testid="print-mutation-report-btn"
                  className="px-4 py-1.5 rounded-xl bg-[#d4af37] hover:bg-[#c59f2d] text-gray-950 text-xs font-extrabold shadow-xs transition-colors cursor-pointer disabled:opacity-40"
                >
                  Cetak / Simpan PDF
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewOpen(false)}
                  data-testid="close-mutation-preview-btn"
                  className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-bold cursor-pointer"
                >
                  Tutup ✕
                </button>
              </div>
            </div>

            {/* Modal Body / Printable Report Sheet */}
            <div className="oak-mutation-modal-body p-6 overflow-y-auto flex-1 bg-stone-100">
              {previewLoading ? (
                <div
                  data-testid="mutation-report-preview-loading"
                  className="py-20 text-center text-gray-500 bg-white rounded-xl border border-gray-200"
                >
                  <div className="text-xs font-bold">
                    Menyiapkan dataset lengkap Laporan Mutasi Barang...
                  </div>
                </div>
              ) : previewError ? (
                <div
                  data-testid="mutation-report-preview-error"
                  className="p-6 bg-rose-50 border border-rose-200 rounded-xl text-rose-800 text-xs"
                >
                  <div className="font-bold mb-1">Gagal memuat pratinjau laporan:</div>
                  <div>{previewError}</div>
                </div>
              ) : previewReport && previewContextKey === filterContextKey ? (
                <div
                  id="oak-mutation-report-printable"
                  data-testid="mutation-report-printable-sheet"
                  className="bg-white p-8 rounded-xl border border-gray-300 shadow-xs text-gray-900 max-w-5xl mx-auto"
                >
                  {/* Centered Report Header per Owner Format */}
                  <div className="text-center border-b-2 border-gray-800 pb-4 mb-3">
                    <div
                      data-testid="mutation-report-header-hotel"
                      className="text-lg font-black tracking-wide text-gray-900"
                    >
                      {previewReport.report_header_title || 'OAK Lawang'}
                    </div>
                    <div
                      data-testid="mutation-report-header-title"
                      className="text-base font-extrabold text-gray-900 mt-0.5"
                    >
                      Laporan Mutasi Barang
                    </div>
                    <div
                      data-testid="mutation-report-header-warehouse"
                      className="text-xs font-bold text-gray-800 mt-1"
                    >
                      {formatWarehouseHeaderLine(previewReport)}
                    </div>
                    <div
                      data-testid="mutation-report-header-period"
                      className="text-xs font-semibold text-gray-700 mt-0.5"
                    >
                      {formatPeriodHeaderLine(previewReport)}
                    </div>
                  </div>

                  {/* Sub-header Left Aligned above Table */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3 text-xs">
                    <div
                      data-testid="mutation-report-sublocation-label"
                      className="font-bold text-gray-800"
                    >
                      {previewReport.storage_sublocation_label || 'Tempat penyimpanan: Belum dirinci'}
                    </div>
                    <div className="text-[11px] text-gray-500">
                      Dicetak dari snapshot WIB: {previewReport.snapshot.as_of_wib}
                    </div>
                  </div>

                  {/* Scope Notice if All Warehouses */}
                  {!previewReport.filters.warehouse_id && (
                    <div className="mb-3 px-3 py-1.5 rounded border border-gray-300 bg-gray-50 text-[11px] text-gray-700">
                      Catatan: {previewReport.scope_notice}
                    </div>
                  )}

                  {/* 8-Column Canonical Table */}
                  <table
                    data-testid="mutation-report-8col-table"
                    className="oak-mutation-print-table w-full text-left text-xs border border-gray-800"
                  >
                    <thead>
                      <tr className="bg-gray-100 border-b border-gray-800 text-[11px] font-extrabold text-gray-900">
                        <th className="border-r border-gray-800 px-2.5 py-2 whitespace-nowrap w-[9%]">Tgl</th>
                        <th className="border-r border-gray-800 px-2.5 py-2 whitespace-nowrap w-[10%]">Kode</th>
                        <th className="border-r border-gray-800 px-2.5 py-2 w-[21%]">Nama Barang</th>
                        <th className="border-r border-gray-800 px-2.5 py-2 text-right whitespace-nowrap w-[8%]">
                          Saldo Awal
                        </th>
                        <th className="border-r border-gray-800 px-2.5 py-2 text-right whitespace-nowrap w-[7%]">
                          Masuk
                        </th>
                        <th className="border-r border-gray-800 px-2.5 py-2 text-right whitespace-nowrap w-[7%]">
                          Keluar
                        </th>
                        <th className="border-r border-gray-800 px-2.5 py-2 text-right whitespace-nowrap w-[8%]">
                          Saldo Akhir
                        </th>
                        <th className="px-2.5 py-2 w-[30%]">Keterangan</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-300">
                      {previewReport.movements.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                            Tidak ada data mutasi barang pada periode dan filter ini.
                          </td>
                        </tr>
                      ) : (
                        previewReport.movements.map((mov) => {
                          const qIn = parseFloat(mov.quantity_in);
                          const qOut = parseFloat(mov.quantity_out);
                          const ketWithLoc = previewReport.filters.warehouse_id
                            ? mov.display_keterangan
                            : `[${mov.location_code}] ${mov.display_keterangan}`;

                          return (
                            <tr key={mov.movement_id} className="border-b border-gray-300">
                              <td className="border-r border-gray-300 px-2.5 py-1.5 whitespace-nowrap font-medium">
                                {mov.movement_date_wib}
                              </td>
                              <td className="border-r border-gray-300 px-2.5 py-1.5 whitespace-nowrap font-mono text-[11px]">
                                {mov.product_code}
                              </td>
                              <td className="border-r border-gray-300 px-2.5 py-1.5 font-semibold">
                                {mov.product_name}{' '}
                                <span className="text-[10px] font-normal text-gray-500">
                                  ({mov.base_unit_code})
                                </span>
                              </td>
                              <td className="border-r border-gray-300 px-2.5 py-1.5 text-right whitespace-nowrap">
                                {formatQty(mov.balance_before)}
                              </td>
                              <td className="border-r border-gray-300 px-2.5 py-1.5 text-right whitespace-nowrap font-semibold">
                                {qIn > 0 ? formatQty(mov.quantity_in) : '0'}
                              </td>
                              <td className="border-r border-gray-300 px-2.5 py-1.5 text-right whitespace-nowrap font-semibold">
                                {qOut > 0 ? formatQty(mov.quantity_out) : '0'}
                              </td>
                              <td className="border-r border-gray-300 px-2.5 py-1.5 text-right whitespace-nowrap font-bold">
                                {formatQty(mov.balance_after)}
                              </td>
                              <td className="px-2.5 py-1.5 text-[11px]">{ketWithLoc}</td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>

                  {/* Summary Per Base Unit */}
                  {previewReport.totals_by_unit.length > 0 && (
                    <div className="mt-4 border border-gray-400 rounded p-3 bg-gray-50/60">
                      <div className="text-[11px] font-extrabold text-gray-800 mb-1.5">
                        Ringkasan Kuantitas Mutasi per Satuan Dasar (Tidak Digabung Lintas Satuan):
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
                        {previewReport.totals_by_unit.map((u) => (
                          <div
                            key={u.base_unit_code}
                            className="border border-gray-300 bg-white px-2.5 py-1.5 rounded flex items-center justify-between"
                          >
                            <span className="font-extrabold text-gray-900">{u.base_unit_code}:</span>
                            <span>
                              Masuk <strong>{formatQty(u.total_in)}</strong> • Keluar{' '}
                              <strong>{formatQty(u.total_out)}</strong> ({u.movement_count} baris)
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Signature Footer Block (break-inside: avoid) */}
                  <div
                    data-testid="mutation-report-signature-block"
                    className="oak-mutation-signature-block mt-10 pt-4 grid grid-cols-2 gap-8 text-center text-xs"
                  >
                    <div>
                      <div className="font-bold text-gray-900">Dibuat Oleh</div>
                      <div className="oak-mutation-signature-spacer h-20" />
                      <div className="font-semibold text-gray-800">(Nama jelas)</div>
                    </div>
                    <div>
                      <div className="font-bold text-gray-900">Mengetahui</div>
                      <div className="oak-mutation-signature-spacer h-20" />
                      <div className="font-semibold text-gray-800">(Nama jelas)</div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
