/**
 * OAK HIMS — MP-04B POS Inventory Workspace
 * Tampilan Utama Manajemen Persediaan POS: Saldo, Valuasi, Kartu Stok, Opname, dan Transfer
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  fetchInventoryValuation,
  fetchStockLocations,
  removeZeroStockBalanceFromLocation,
  updateStockBalanceSublocation,
} from './posInventoryApi';
import type {
  StockLocation,
  InventoryValuationItem,
  InventoryValuationSummary,
} from './posInventoryTypes';
import StockLedgerDrawer from './StockLedgerDrawer';
import StockAdjustmentModal from './StockAdjustmentModal';
import StockOpnameModal from './StockOpnameModal';
import StockTransferModal from './StockTransferModal';
import StockOpeningBalanceModal from './StockOpeningBalanceModal';
import StockMovementHistorySection from './StockMovementHistorySection';

interface Props {
  propertyId: number | null;
  onRefreshParent?: () => void;
  onNavigateToProcurement?: () => void;
}

type StockStatusFilter = 'ALL' | 'SAFE' | 'LOW' | 'OUT';
type InventorySubTab = 'VALUATION' | 'MOVEMENTS';

function formatIDR(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'Rp 0';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (!Number.isFinite(num)) return 'Rp 0';
  return 'Rp ' + Math.round(num).toLocaleString('id-ID');
}

function formatQty(value: number | string): string {
  const num = typeof value === 'string' ? parseFloat(value) || 0 : value || 0;
  return num.toLocaleString('id-ID', { maximumFractionDigits: 3 });
}

export default function PosInventoryWorkspace({ propertyId, onRefreshParent }: Props) {
  const activePropertyId = propertyId || 1;

  // Data state
  const [locations, setLocations] = useState<StockLocation[]>([]);
  const [items, setItems] = useState<InventoryValuationItem[]>([]);
  const [summary, setSummary] = useState<InventoryValuationSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);

  // Filters
  const [activeSubTab, setActiveSubTab] = useState<InventorySubTab>('VALUATION');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedLocationId, setSelectedLocationId] = useState<number | 'ALL'>('ALL');
  const [selectedSublocation, setSelectedSublocation] = useState<string>('ALL');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [stockStatusFilter, setStockStatusFilter] = useState<StockStatusFilter>('ALL');

  // Modal / Drawer States
  const [ledgerItem, setLedgerItem] = useState<InventoryValuationItem | null>(null);
  const [adjustmentItem, setAdjustmentItem] = useState<InventoryValuationItem | null>(null);
  const [opnameItem, setOpnameItem] = useState<InventoryValuationItem | null>(null);
  const [transferItem, setTransferItem] = useState<InventoryValuationItem | null>(null);
  const [showOpeningBalanceModal, setShowOpeningBalanceModal] = useState<boolean>(false);
  const [removeLocationItem, setRemoveLocationItem] = useState<InventoryValuationItem | null>(null);
  const [removingLocationItem, setRemovingLocationItem] = useState<boolean>(false);
  const [removeLocationError, setRemoveLocationError] = useState<string | null>(null);
  const [editSublocationItem, setEditSublocationItem] = useState<InventoryValuationItem | null>(null);
  const [editSublocationValue, setEditSublocationValue] = useState<string>('');
  const [savingSublocation, setSavingSublocation] = useState<boolean>(false);
  const [editSublocationError, setEditSublocationError] = useState<string | null>(null);

  // Row Overflow Menu (⋮) state keyed by `${product_id}-${location_id}`
  const [openRowMenuKey, setOpenRowMenuKey] = useState<string | null>(null);
  const [rowMenuCoords, setRowMenuCoords] = useState<{ top: number; left: number } | null>(null);
  const rowMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const rowMenuPopupRef = useRef<HTMLDivElement | null>(null);

  const updateRowMenuPosition = useCallback(() => {
    const btn = rowMenuTriggerRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const menuWidth = 208;
    const menuHeight = 140;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = rect.right - menuWidth;
    if (left < 8) left = 8;
    if (left + menuWidth > viewportWidth - 8) {
      left = Math.max(8, viewportWidth - menuWidth - 8);
    }

    let top = rect.bottom + 6;
    if (top + menuHeight > viewportHeight - 8 && rect.top - menuHeight - 6 >= 8) {
      top = rect.top - menuHeight - 6;
    }

    setRowMenuCoords({ top, left });
  }, []);

  useEffect(() => {
    if (!openRowMenuKey) return;

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (rowMenuPopupRef.current?.contains(target)) return;
      if (rowMenuTriggerRef.current?.contains(target)) return;
      setOpenRowMenuKey(null);
      setRowMenuCoords(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenRowMenuKey(null);
        setRowMenuCoords(null);
      }
    };

    const handleScrollOrResize = () => {
      updateRowMenuPosition();
    };

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('resize', handleScrollOrResize);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
    };
  }, [openRowMenuKey, updateRowMenuPosition]);

  // Close row overflow menu when filters or property change
  useEffect(() => {
    setOpenRowMenuKey(null);
    setRowMenuCoords(null);
  }, [activePropertyId, selectedLocationId, selectedCategory, stockStatusFilter, searchQuery]);

  // Reset active row modals/drawers when property context changes
  useEffect(() => {
    setLedgerItem(null);
    setAdjustmentItem(null);
    setOpnameItem(null);
    setTransferItem(null);
    setShowOpeningBalanceModal(false);
    setRemoveLocationItem(null);
    setRemoveLocationError(null);
  }, [activePropertyId]);

  // Auto-dismiss toast
  useEffect(() => {
    if (successToast) {
      const timer = setTimeout(() => setSuccessToast(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [successToast]);

  // Load locations and valuation
  const loadData = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const [locsRes, valRes] = await Promise.all([
        fetchStockLocations(activePropertyId),
        fetchInventoryValuation(activePropertyId, {
          location_id: selectedLocationId === 'ALL' ? null : selectedLocationId,
          search: searchQuery.trim() || null,
        }),
      ]);

      setLocations(locsRes.filter((l) => l.is_active));
      setItems(valRes.items || []);
      setSummary(valRes.summary || null);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Gagal memuat data persediaan');
    } finally {
      setLoading(false);
    }
  }, [activePropertyId, selectedLocationId, searchQuery]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Distinct categories for filter
  const categories = useMemo(() => {
    const set = new Set<string>();
    items.forEach((it) => {
      if (it.category_name) set.add(it.category_name);
    });
    return Array.from(set).sort();
  }, [items]);

  // Distinct storage sublocations for filter
  const sublocations = useMemo(() => {
    const set = new Set<string>();
    items.forEach((it) => {
      if (it.storage_sublocation && it.storage_sublocation.trim()) {
        set.add(it.storage_sublocation.trim());
      }
    });
    return Array.from(set).sort();
  }, [items]);

  // Filtered items
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      // Sublocation filter
      if (selectedSublocation !== 'ALL') {
        const sub = (item.storage_sublocation || '').trim();
        if (sub.toLowerCase() !== selectedSublocation.toLowerCase()) {
          return false;
        }
      }

      // Category filter
      if (selectedCategory !== 'ALL' && item.category_name !== selectedCategory) {
        return false;
      }

      // Stock status filter
      const qty = parseFloat(item.quantity);
      if (stockStatusFilter === 'SAFE' && qty < 10) return false;
      if (stockStatusFilter === 'LOW' && (qty <= 0 || qty >= 10)) return false;
      if (stockStatusFilter === 'OUT' && qty > 0) return false;

      return true;
    });
  }, [items, selectedSublocation, selectedCategory, stockStatusFilter]);

  // Aggregated status counts
  const statusCounts = useMemo(() => {
    let safe = 0;
    let low = 0;
    let out = 0;
    items.forEach((it) => {
      const q = parseFloat(it.quantity);
      if (q >= 10) safe++;
      else if (q > 0) low++;
      else out++;
    });
    return { safe, low, out, total: items.length };
  }, [items]);

  const handleActionSuccess = (message: string) => {
    setSuccessToast(message);
    void loadData();
    if (onRefreshParent) onRefreshParent();
  };

  return (
    <div className="space-y-6">
      {/* Toast Notification */}
      {successToast && (
        <div className="fixed top-5 right-5 z-50 p-4 bg-[#1b4332] text-white rounded-2xl shadow-2xl border border-[#d4af37]/40 flex items-center gap-3 animate-in slide-in-from-top duration-200">
          <span className="p-1.5 bg-emerald-500/30 rounded-full text-emerald-200 text-sm">✓</span>
          <span className="text-xs font-semibold">{successToast}</span>
          <button
            onClick={() => setSuccessToast(null)}
            className="text-white/70 hover:text-white font-bold ml-2 text-xs"
          >
            ✕
          </button>
        </div>
      )}

      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-6 rounded-2xl border border-gray-200/80 shadow-2xs">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold tracking-wider bg-emerald-50 text-[#1b4332] border border-emerald-200/60 uppercase">
              Manajemen Persediaan • Stok &amp; Mutasi
            </span>
            <span className="text-xs text-gray-400">•</span>
            <span className="text-xs text-gray-500">Property #{activePropertyId}</span>
          </div>
          <h1 className="text-2xl font-black text-gray-900 tracking-tight">
            {activeSubTab === 'VALUATION'
              ? 'Stok & Mutasi — Saldo & Valuasi Persediaan'
              : 'Stok & Mutasi — Riwayat Mutasi & Laporan Mutasi Barang'}
          </h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">
            {activeSubTab === 'VALUATION'
              ? 'Pemantauan stok tercatat per lokasi gudang/outlet, kartu stok kronologis, penyesuaian barang rusak/hilang, serta stock opname fisik.'
              : 'Histori mutasi persediaan lintas gudang/item beserta pratinjau dan cetak Laporan Mutasi Barang (8 kolom).'}
          </p>
          {/* Sub-Tab Switcher: Saldo & Valuasi vs Riwayat Mutasi */}
          <div className="inline-flex items-center gap-1 p-1 mt-3 rounded-xl bg-stone-100 border border-stone-200">
            <button
              type="button"
              data-testid="inventory-tab-valuation"
              onClick={() => setActiveSubTab('VALUATION')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-extrabold transition-colors cursor-pointer ${
                activeSubTab === 'VALUATION'
                  ? 'bg-[#1b4332] text-white shadow-2xs'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              Saldo &amp; Valuasi
            </button>
            <button
              type="button"
              data-testid="inventory-tab-movements"
              onClick={() => setActiveSubTab('MOVEMENTS')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-extrabold transition-colors cursor-pointer ${
                activeSubTab === 'MOVEMENTS'
                  ? 'bg-[#1b4332] text-white shadow-2xs'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              Riwayat Mutasi
            </button>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="open-opening-balance-modal-btn"
            onClick={() => setShowOpeningBalanceModal(true)}
            className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-[#1b4332] hover:bg-[#2d6a4f] text-white text-xs font-bold shadow-xs transition-colors cursor-pointer"
          >
            <svg className="w-4 h-4 text-[#d4af37]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
            </svg>
            Catat Saldo Awal
          </button>

          <button
            type="button"
            onClick={() => void loadData()}
            disabled={loading}
            className="p-2.5 rounded-xl border border-gray-200 hover:bg-gray-50 text-gray-600 transition-colors cursor-pointer"
            title="Refresh Data"
          >
            <svg className={`w-4 h-4 ${loading ? 'animate-spin text-emerald-700' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {activeSubTab === 'MOVEMENTS' ? (
        <StockMovementHistorySection
          propertyId={activePropertyId}
          locations={locations}
          onOpenLedger={(target) =>
            setLedgerItem({
              balance_id: 0,
              property_id: activePropertyId,
              product_id: target.product_id,
              product_name: target.product_name,
              product_item_code: null,
              category_id: null,
              category_name: null,
              base_unit_code: target.base_unit_code,
              location_id: target.location_id,
              location_code: '',
              location_name: target.location_name,
              location_type: '',
              quantity: '0',
              unit_cost: null,
              total_value: null,
              updated_at: new Date().toISOString(),
            })
          }
        />
      ) : (
        <>
      {/* KPI Overview Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        {/* Total Item SKU */}
        <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-2xs">
          <div className="text-xs text-gray-500 font-semibold">Total Item Persediaan</div>
          <div className="text-2xl font-black text-gray-900 mt-1">
            {summary ? summary.total_items : items.length}
          </div>
          <div className="text-[11px] text-gray-400 mt-0.5">
            Daftar saldo aktif di seluruh lokasi properti
          </div>
        </div>

        {/* Total Kuantitas Tercatat */}
        <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-2xs">
          <div className="text-xs text-gray-500 font-semibold">Total Stok Tercatat</div>
          <div className="text-2xl font-black text-[#1b4332] mt-1">
            {summary ? formatQty(summary.total_quantity) : '0'}
          </div>
          <div className="text-[11px] text-gray-400 mt-0.5">
            Akumulasi unit stok tercatat di semua lokasi
          </div>
        </div>

        {/* Total Valuasi Persediaan */}
        <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-2xs">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-gray-500 font-semibold">Total Valuasi Persediaan</div>
            {(summary?.unknown_cost_items ?? 0) > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-200">
                Valuasi Parsial
              </span>
            )}
          </div>
          <div className="text-2xl font-black text-[#bfa15f] mt-1">
            {!summary
              ? 'Rp 0'
              : (summary.unknown_cost_items ?? 0) > 0 && summary.total_items > 0 && summary.unknown_cost_items === summary.total_items
                ? 'Belum diketahui'
                : formatIDR(summary.total_valuation_value)}
          </div>
          {(summary?.unknown_cost_items ?? 0) > 0 ? (
            <div className="text-[11px] text-amber-700 font-medium mt-0.5">
              {summary && summary.total_items > 0 && summary.unknown_cost_items === summary.total_items
                ? `${summary.unknown_cost_items} item belum memiliki biaya rata-rata terverifikasi`
                : `Hanya mencakup item dengan biaya terverifikasi (${summary?.unknown_cost_items} item belum diketahui)`}
            </div>
          ) : (
            <div className="text-[11px] text-gray-400 mt-0.5">
              Nilai aset berdasarkan biaya rata-rata persediaan
            </div>
          )}
        </div>

        {/* Status Kesehatan Stok */}
        <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-2xs">
          <div className="text-xs text-gray-500 font-semibold">Kondisi Stok</div>
          <div className="flex items-center gap-2 mt-2">
            <span className="px-2 py-1 rounded-lg text-xs font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
              Aman: {statusCounts.safe}
            </span>
            <span className="px-2 py-1 rounded-lg text-xs font-bold bg-amber-50 text-amber-800 border border-amber-200">
              Menipis: {statusCounts.low}
            </span>
            <span className="px-2 py-1 rounded-lg text-xs font-bold bg-rose-50 text-rose-800 border border-rose-200">
              Habis: {statusCounts.out}
            </span>
          </div>
          <div className="text-[11px] text-gray-400 mt-1.5">
            Berdasarkan batas minimum stok produk
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-2xs flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
        {/* Search Input */}
        <div className="relative flex-1">
          <svg className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Cari nama produk atau kode SKU..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2 text-xs border border-gray-300 rounded-xl bg-gray-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700 transition-all"
          />
        </div>

        {/* Filter Dropdowns */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Location Filter */}
          <select
            value={selectedLocationId}
            onChange={(e) => setSelectedLocationId(e.target.value === 'ALL' ? 'ALL' : Number(e.target.value))}
            className="px-3 py-2 text-xs border border-gray-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700 cursor-pointer"
          >
            <option value="ALL">Semua Lokasi Penyimpanan</option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name} ({loc.code})
              </option>
            ))}
          </select>

          {/* Storage Sublocation Filter */}
          {sublocations.length > 0 && (
            <select
              value={selectedSublocation}
              onChange={(e) => setSelectedSublocation(e.target.value)}
              className="px-3 py-2 text-xs border border-gray-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700 cursor-pointer"
            >
              <option value="ALL">Semua Tempat Penyimpanan</option>
              {sublocations.map((sub) => (
                <option key={sub} value={sub}>
                  📍 {sub}
                </option>
              ))}
            </select>
          )}

          {/* Category Filter */}
          {categories.length > 0 && (
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="px-3 py-2 text-xs border border-gray-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700 cursor-pointer"
            >
              <option value="ALL">Semua Kategori</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          )}

          {/* Status Filter */}
          <select
            value={stockStatusFilter}
            onChange={(e) => setStockStatusFilter(e.target.value as StockStatusFilter)}
            className="px-3 py-2 text-xs border border-gray-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700 cursor-pointer"
          >
            <option value="ALL">Semua Status Stok</option>
            <option value="SAFE">Stok Aman (≥ 10)</option>
            <option value="LOW">Stok Menipis (&lt; 10)</option>
            <option value="OUT">Stok Habis (0)</option>
          </select>
        </div>
      </div>

      {/* Error Message */}
      {errorMsg && (
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-xl text-rose-800 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span>⚠</span>
            <span>{errorMsg}</span>
          </div>
          <button onClick={() => setErrorMsg(null)} className="text-rose-600 hover:text-rose-900 font-bold ml-2">✕</button>
        </div>
      )}

      {/* Persediaan & Valuasi Table */}
      <div className="bg-white border border-gray-200 rounded-2xl shadow-2xs overflow-hidden">
        {loading ? (
          <div className="py-20 text-center text-gray-400">
            <svg className="w-8 h-8 animate-spin mx-auto text-emerald-700 mb-2" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            <div className="text-xs">Memuat saldo persediaan...</div>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="py-20 text-center text-gray-400">
            <svg className="w-12 h-12 mx-auto text-gray-300 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
            </svg>
            <div className="text-sm font-bold text-gray-700">Tidak ada saldo persediaan ditemukan</div>
            <div className="text-xs text-gray-400 mt-1">
              {searchQuery || selectedLocationId !== 'ALL' || stockStatusFilter !== 'ALL'
                ? 'Coba sesuaikan kata kunci pencarian atau filter lokasi/status.'
                : 'Belum ada saldo stok tercatat. Lakukan penerimaan barang pembelian (PO) atau catat saldo awal.'}
            </div>
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                onClick={() => setShowOpeningBalanceModal(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#1b4332] hover:bg-[#2d6a4f] text-white text-xs font-bold shadow-xs transition-colors cursor-pointer"
              >
                <span>+ Catat Saldo Awal</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#faf9f5] border-b border-gray-200 text-gray-600 font-bold uppercase text-[10px] tracking-wider">
                <tr>
                  <th className="px-4 py-3">Produk &amp; SKU</th>
                  <th className="px-4 py-3">Kategori</th>
                  <th className="px-4 py-3">Lokasi</th>
                  <th className="px-4 py-3">Tempat Penyimpanan</th>
                  <th className="px-4 py-3 text-right">Stok Tercatat</th>
                  <th className="px-4 py-3 text-center">Status</th>
                  <th className="px-4 py-3 text-right">Biaya Satuan (Rata-Rata)</th>
                  <th className="px-4 py-3 text-right">Total Valuasi</th>
                  <th className="px-4 py-3 text-center">Aksi Cepat</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredItems.map((item) => {
                  const qty = parseFloat(item.quantity);
                  const isSafe = qty >= 10;
                  const isLow = qty > 0 && qty < 10;
                  const rowKey = `${item.product_id}-${item.location_id}`;
                  const isMenuOpen = openRowMenuKey === rowKey;

                  return (
                    <tr key={rowKey} className="hover:bg-gray-50/80 transition-colors">
                      {/* Product Name & SKU */}
                      <td className="px-4 py-3">
                        <div className="font-extrabold text-gray-900">{item.product_name}</div>
                        <div className="text-[11px] text-gray-400">
                          {item.product_item_code ? `SKU: ${item.product_item_code}` : `ID: #${item.product_id}`}
                        </div>
                      </td>

                      {/* Category */}
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                        {item.category_name || '-'}
                      </td>

                      {/* Location */}
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold bg-gray-100 text-gray-700 border border-gray-200">
                          {item.location_name}
                        </span>
                      </td>

                      {/* Storage Sublocation */}
                      <td className="px-4 py-3 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => {
                            setEditSublocationError(null);
                            setEditSublocationValue(item.storage_sublocation || '');
                            setEditSublocationItem(item);
                          }}
                          title="Klik untuk mengatur atau mengubah Tempat Penyimpanan (Contoh: Showcase, Chiller, Rak)"
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border transition-colors cursor-pointer ${
                            item.storage_sublocation
                              ? 'bg-emerald-50 text-[#1b4332] border-emerald-200 hover:bg-emerald-100'
                              : 'bg-stone-50 text-stone-400 border-dashed border-stone-300 hover:border-emerald-500 hover:text-emerald-700'
                          }`}
                        >
                          {item.storage_sublocation ? (
                            <>
                              <span>📍 {item.storage_sublocation}</span>
                            </>
                          ) : (
                            <span>+ Atur Tempat</span>
                          )}
                        </button>
                      </td>

                      {/* Recorded Stock Balance */}
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <span className="font-black text-sm text-gray-900">
                          {formatQty(qty)}
                        </span>{' '}
                        <span className="text-[11px] text-gray-500 font-medium">{item.base_unit_code}</span>
                      </td>

                      {/* Status Badge */}
                      <td className="px-4 py-3 text-center whitespace-nowrap">
                        {isSafe ? (
                          <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#e8f5e9] text-[#1b4332] border border-emerald-300">
                            Aman
                          </span>
                        ) : isLow ? (
                          <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#fef9e7] text-[#8f6d14] border border-amber-300">
                            Menipis
                          </span>
                        ) : (
                          <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#fbebee] text-[#842029] border border-rose-300">
                            Habis
                          </span>
                        )}
                      </td>

                      {/* Unit Cost */}
                      <td className="px-4 py-3 text-right text-gray-700 whitespace-nowrap">
                        {item.unit_cost !== null && item.unit_cost !== undefined && item.cost_status !== 'UNKNOWN' ? (
                          <div>
                            <div className="font-semibold text-gray-900">{formatIDR(item.unit_cost)}</div>
                            {item.last_unit_cost && (
                              <div className="text-[10px] text-gray-500 mt-0.5 flex items-center justify-end gap-1">
                                <span>Terakhir: {formatIDR(item.last_unit_cost)}</span>
                                {item.cost_delta !== null && item.cost_delta !== undefined && Math.abs(parseFloat(item.cost_delta)) >= 1 && (
                                  parseFloat(item.cost_delta) > 0 ? (
                                    <span
                                      className="inline-flex items-center px-1 py-0.2 rounded text-[9px] font-bold bg-rose-50 text-rose-700 border border-rose-200"
                                      title={`Naik ${formatIDR(item.cost_delta)} dibanding pembelian sebelumnya (${formatIDR(item.prev_unit_cost)})`}
                                    >
                                      ▲ +{formatIDR(item.cost_delta)}
                                    </span>
                                  ) : (
                                    <span
                                      className="inline-flex items-center px-1 py-0.2 rounded text-[9px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200"
                                      title={`Turun ${formatIDR(Math.abs(parseFloat(item.cost_delta)))} dibanding pembelian sebelumnya (${formatIDR(item.prev_unit_cost)})`}
                                    >
                                      ▼ -{formatIDR(Math.abs(parseFloat(item.cost_delta)))}
                                    </span>
                                  )
                                )}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-[11px] italic text-amber-700" title="Belum ada biaya perolehan terverifikasi">
                            Belum diketahui
                          </span>
                        )}
                      </td>

                      {/* Total Value */}
                      <td className="px-4 py-3 text-right font-black text-gray-900 whitespace-nowrap">
                        {item.total_value !== null && item.total_value !== undefined && item.cost_status !== 'UNKNOWN' ? (
                          formatIDR(item.total_value)
                        ) : (
                          <span className="text-[11px] font-semibold italic text-amber-700" title="Valuasi menunggu biaya perolehan terverifikasi">
                            Belum diketahui
                          </span>
                        )}
                      </td>

                      {/* Actions: Kartu Stok + ⋮ */}
                      <td className="px-4 py-3 text-center whitespace-nowrap">
                        <div className="flex items-center justify-center gap-1.5">
                          {/* Kartu Stok */}
                          <button
                            type="button"
                            onClick={() => setLedgerItem(item)}
                            className="px-2.5 py-1 rounded-lg border border-gray-200 hover:border-emerald-500 hover:text-emerald-800 text-gray-600 text-[11px] font-bold transition-colors cursor-pointer bg-white"
                            title="Buka Kartu Stok Kronologis"
                          >
                            Kartu Stok
                          </button>

                          {/* Overflow Menu Trigger (⋮) */}
                          <button
                            type="button"
                            data-testid={`stock-row-overflow-btn-${rowKey}`}
                            aria-haspopup="menu"
                            aria-expanded={isMenuOpen}
                            aria-label={`Aksi ${item.product_name} di ${item.location_name}`}
                            onClick={(e) => {
                              if (isMenuOpen) {
                                setOpenRowMenuKey(null);
                                setRowMenuCoords(null);
                              } else {
                                rowMenuTriggerRef.current = e.currentTarget;
                                setOpenRowMenuKey(rowKey);
                                const rect = e.currentTarget.getBoundingClientRect();
                                const menuWidth = 208;
                                const menuHeight = 140;
                                const viewportWidth = window.innerWidth;
                                const viewportHeight = window.innerHeight;
                                let left = rect.right - menuWidth;
                                if (left < 8) left = 8;
                                if (left + menuWidth > viewportWidth - 8) {
                                  left = Math.max(8, viewportWidth - menuWidth - 8);
                                }
                                let top = rect.bottom + 6;
                                if (top + menuHeight > viewportHeight - 8 && rect.top - menuHeight - 6 >= 8) {
                                  top = rect.top - menuHeight - 6;
                                }
                                setRowMenuCoords({ top, left });
                              }
                            }}
                            className={`px-2 py-1 rounded-lg border text-xs font-extrabold transition-colors cursor-pointer ${
                              isMenuOpen
                                ? 'bg-[#1b4332] text-white border-[#1b4332]'
                                : 'bg-white border-gray-200 hover:border-emerald-500 hover:text-emerald-800 text-gray-600'
                            }`}
                            title={`Aksi ${item.product_name} di ${item.location_name}`}
                          >
                            ⋮
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Portal Overflow Menu for Active Row */}
      {openRowMenuKey && rowMenuCoords && (() => {
        const activeRowItem = filteredItems.find(
          (it) => `${it.product_id}-${it.location_id}` === openRowMenuKey
        );
        if (!activeRowItem) return null;

        return createPortal(
          <div
            ref={rowMenuPopupRef}
            role="menu"
            data-testid={`stock-row-overflow-menu-${openRowMenuKey}`}
            aria-label={`Menu aksi ${activeRowItem.product_name} di ${activeRowItem.location_name}`}
            style={{
              position: 'fixed',
              top: `${rowMenuCoords.top}px`,
              left: `${rowMenuCoords.left}px`,
              width: '208px',
              zIndex: 9999,
            }}
            className="bg-white rounded-xl border border-stone-200 shadow-xl py-1.5 text-xs animate-in fade-in duration-100"
          >
            <div className="px-3 py-1.5 border-b border-stone-100 text-[10px] font-bold text-stone-400 uppercase tracking-wider truncate">
              {activeRowItem.product_name} • {activeRowItem.location_name}
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpenRowMenuKey(null);
                setRowMenuCoords(null);
                setEditSublocationError(null);
                setEditSublocationValue(activeRowItem.storage_sublocation || '');
                setEditSublocationItem(activeRowItem);
              }}
              className="w-full text-left px-3 py-2 font-semibold text-stone-700 hover:bg-emerald-50 hover:text-emerald-900 flex items-center gap-2 transition-colors cursor-pointer"
            >
              <span>Atur Tempat Penyimpanan</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpenRowMenuKey(null);
                setRowMenuCoords(null);
                setAdjustmentItem(activeRowItem);
              }}
              className="w-full text-left px-3 py-2 font-semibold text-stone-700 hover:bg-amber-50 hover:text-amber-900 flex items-center gap-2 transition-colors cursor-pointer"
            >
              <span>Penyesuaian Stok</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpenRowMenuKey(null);
                setRowMenuCoords(null);
                setOpnameItem(activeRowItem);
              }}
              className="w-full text-left px-3 py-2 font-semibold text-stone-700 hover:bg-purple-50 hover:text-purple-900 flex items-center gap-2 transition-colors cursor-pointer"
            >
              <span>Opname Fisik</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpenRowMenuKey(null);
                setRowMenuCoords(null);
                setTransferItem(activeRowItem);
              }}
              className="w-full text-left px-3 py-2 font-semibold text-stone-700 hover:bg-emerald-50 hover:text-emerald-900 flex items-center gap-2 transition-colors cursor-pointer"
            >
              <span>Transfer Stok</span>
            </button>
            <div className="my-1 border-t border-stone-100" />
            {Math.abs(parseFloat(activeRowItem.quantity || '0')) <= 0.0001 ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpenRowMenuKey(null);
                  setRowMenuCoords(null);
                  setRemoveLocationError(null);
                  setRemoveLocationItem(activeRowItem);
                }}
                className="w-full text-left px-3 py-2 font-semibold text-red-700 hover:bg-red-50 hover:text-red-900 flex items-center gap-2 transition-colors cursor-pointer"
              >
                <span>Hapus dari Lokasi Ini</span>
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                disabled
                title="Kosongkan stok terlebih dahulu lewat Transfer Stok atau Penyesuaian Stok sebelum menghapus produk dari lokasi ini."
                className="w-full text-left px-3 py-2 font-medium text-stone-400 flex items-center justify-between gap-2 cursor-not-allowed"
              >
                <span>Hapus dari Lokasi Ini</span>
                <span className="text-[10px] bg-stone-100 text-stone-500 px-1.5 py-0.5 rounded">Stok &gt; 0</span>
              </button>
            )}
          </div>,
          document.body
        );
      })()}
        </>
      )}

      {/* Stock Ledger Drawer */}
      <StockLedgerDrawer
        isOpen={ledgerItem !== null}
        onClose={() => setLedgerItem(null)}
        propertyId={activePropertyId}
        productId={ledgerItem?.product_id ?? null}
        productName={ledgerItem?.product_name ?? ''}
        locationId={ledgerItem?.location_id ?? null}
        locationName={ledgerItem?.location_name ?? ''}
        baseUnitCode={ledgerItem?.base_unit_code}
      />

      {/* Stock Opening Balance Modal */}
      <StockOpeningBalanceModal
        isOpen={showOpeningBalanceModal}
        onClose={() => setShowOpeningBalanceModal(false)}
        propertyId={activePropertyId}
        locations={locations}
        valuationItems={items}
        onSuccess={(msg) => handleActionSuccess(msg)}
        onOpenOpnameForItem={(it) => setOpnameItem(it)}
      />

      {/* Stock Adjustment Modal */}
      <StockAdjustmentModal
        isOpen={adjustmentItem !== null}
        onClose={() => setAdjustmentItem(null)}
        propertyId={activePropertyId}
        locations={locations}
        initialItem={
          adjustmentItem
            ? {
                product_id: adjustmentItem.product_id,
                product_name: adjustmentItem.product_name,
                location_id: adjustmentItem.location_id,
                location_name: adjustmentItem.location_name,
                current_quantity: adjustmentItem.quantity,
                base_unit_code: adjustmentItem.base_unit_code,
              }
            : null
        }
        onSuccess={() => handleActionSuccess('Penyesuaian stok berhasil disimpan!')}
      />

      {/* Stock Opname Modal */}
      <StockOpnameModal
        isOpen={opnameItem !== null}
        onClose={() => setOpnameItem(null)}
        propertyId={activePropertyId}
        locations={locations}
        initialItem={
          opnameItem
            ? {
                product_id: opnameItem.product_id,
                product_name: opnameItem.product_name,
                location_id: opnameItem.location_id,
                location_name: opnameItem.location_name,
                current_quantity: opnameItem.quantity,
                base_unit_code: opnameItem.base_unit_code,
              }
            : null
        }
        onSuccess={() => handleActionSuccess('Stock opname fisik berhasil disimpan!')}
      />

      {/* Stock Transfer Modal */}
      <StockTransferModal
        isOpen={transferItem !== null}
        onClose={() => setTransferItem(null)}
        propertyId={activePropertyId}
        locations={locations}
        initialItem={
          transferItem
            ? {
                product_id: transferItem.product_id,
                product_name: transferItem.product_name,
                location_id: transferItem.location_id,
                location_name: transferItem.location_name,
                current_quantity: transferItem.quantity,
                base_unit_code: transferItem.base_unit_code,
              }
            : null
        }
        onSuccess={() => handleActionSuccess('Transfer stok antar lokasi berhasil dikirim!')}
      />

      {/* Edit Storage Sublocation Modal */}
      {editSublocationItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-sublocation-title"
            className="bg-white rounded-2xl shadow-xl border border-gray-200 w-full max-w-md overflow-hidden"
          >
            <div className="px-6 py-4 bg-[#1b4332] text-white flex items-center justify-between">
              <div>
                <div className="text-[10px] uppercase font-bold tracking-wider text-[#d4af37]">
                  Lokasi Gudang: {editSublocationItem.location_name}
                </div>
                <h3 id="edit-sublocation-title" className="text-sm font-extrabold text-white mt-0.5">
                  Atur Tempat Penyimpanan — {editSublocationItem.product_name}
                </h3>
              </div>
              <button
                type="button"
                disabled={savingSublocation}
                onClick={() => {
                  setEditSublocationItem(null);
                  setEditSublocationError(null);
                }}
                className="text-white/70 hover:text-white text-sm font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>
            <div className="p-6 space-y-3 text-xs text-gray-600">
              {editSublocationError && (
                <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 font-medium">
                  {editSublocationError}
                </div>
              )}
              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1">
                  Tempat Penyimpanan di {editSublocationItem.location_name}
                </label>
                <input
                  type="text"
                  list="workspace-sublocation-suggestions"
                  placeholder="Contoh: Showcase, Chiller, Freezer, Rak Kering, Lemari Linen..."
                  value={editSublocationValue}
                  onChange={(e) => setEditSublocationValue(e.target.value)}
                  disabled={savingSublocation}
                  autoFocus
                  className="w-full px-3 py-2 text-xs border border-gray-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700"
                />
                <datalist id="workspace-sublocation-suggestions">
                  <option value="Showcase" />
                  <option value="Chiller" />
                  <option value="Freezer" />
                  <option value="Rak Kering" />
                  <option value="Lemari Linen" />
                  <option value="Rak Amenities" />
                  <option value="Gudang Kering" />
                </datalist>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {['Showcase', 'Chiller', 'Freezer', 'Rak Kering', 'Lemari Linen', 'Rak Amenities'].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setEditSublocationValue(preset)}
                      className={`px-2 py-1 rounded-lg text-[10px] font-bold border transition-colors cursor-pointer ${
                        editSublocationValue === preset
                          ? 'bg-[#1b4332] text-white border-[#1b4332]'
                          : 'bg-gray-50 text-gray-700 border-gray-200 hover:bg-emerald-50 hover:border-emerald-300'
                      }`}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-[11px] text-gray-500 bg-[#faf9f5] p-3 rounded-xl border border-gray-200/80">
                Tempat penyimpanan ini akan tampil di sebelah kolom <strong>Lokasi</strong> pada tabel{' '}
                <strong>Saldo &amp; Valuasi</strong>, <strong>Riwayat Mutasi</strong>, serta ikut tercetak pada{' '}
                <strong>Laporan Mutasi Barang</strong>.
              </p>
            </div>
            <div className="px-6 py-3.5 bg-gray-50 border-t border-gray-100 flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={savingSublocation}
                onClick={() => {
                  setEditSublocationItem(null);
                  setEditSublocationError(null);
                }}
                className="px-4 py-2 rounded-xl border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 text-xs font-semibold cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={savingSublocation}
                onClick={async () => {
                  setSavingSublocation(true);
                  setEditSublocationError(null);
                  try {
                    await updateStockBalanceSublocation({
                      property_id: activePropertyId,
                      product_id: editSublocationItem.product_id,
                      location_id: editSublocationItem.location_id,
                      storage_sublocation: editSublocationValue.trim() || null,
                    });
                    const prodName = editSublocationItem.product_name;
                    const locName = editSublocationItem.location_name;
                    const subVal = editSublocationValue.trim();
                    setEditSublocationItem(null);
                    handleActionSuccess(
                      subVal
                        ? `Tempat penyimpanan "${prodName}" di ${locName} diatur ke "${subVal}".`
                        : `Tempat penyimpanan "${prodName}" di ${locName} dikosongkan.`
                    );
                  } catch (err: any) {
                    setEditSublocationError(err?.message || 'Gagal menyimpan tempat penyimpanan');
                  } finally {
                    setSavingSublocation(false);
                  }
                }}
                className="px-4 py-2 rounded-xl bg-[#1b4332] hover:bg-[#2d6a4f] text-white text-xs font-bold shadow-xs transition-colors cursor-pointer disabled:opacity-50"
              >
                {savingSublocation ? 'Menyimpan...' : 'Simpan Tempat Penyimpanan'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Remove Zero-Stock Product from Location Confirmation Modal */}
      {removeLocationItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="remove-stock-location-title"
            className="bg-white rounded-2xl shadow-xl border border-gray-200 w-full max-w-md overflow-hidden"
          >
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <h3 id="remove-stock-location-title" className="text-sm font-bold text-gray-900">
                Hapus Produk dari Lokasi Ini?
              </h3>
              <button
                type="button"
                disabled={removingLocationItem}
                onClick={() => {
                  setRemoveLocationItem(null);
                  setRemoveLocationError(null);
                }}
                className="text-gray-400 hover:text-gray-600 text-sm font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>
            <div className="p-6 space-y-3 text-xs text-gray-600">
              {removeLocationError && (
                <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 font-medium">
                  {removeLocationError}
                </div>
              )}
              <p>
                Anda akan menghapus baris saldo{' '}
                <strong className="text-gray-900">{removeLocationItem.product_name}</strong> dari lokasi{' '}
                <strong className="text-gray-900">{removeLocationItem.location_name}</strong> (Stok tercatat:{' '}
                <strong className="text-gray-900">
                  {formatQty(removeLocationItem.quantity)} {removeLocationItem.base_unit_code}
                </strong>
                ).
              </p>
              <p className="text-[11px] text-gray-500 bg-gray-50 p-3 rounded-xl border border-gray-200/80">
                Catatan: Produk di Master Barang &amp; Produk maupun histori di Riwayat Mutasi tetap tersimpan aman untuk audit, namun produk ini tidak lagi muncul di daftar lokasi{' '}
                <strong>{removeLocationItem.location_name}</strong>.
              </p>
            </div>
            <div className="px-6 py-3.5 bg-gray-50 border-t border-gray-100 flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={removingLocationItem}
                onClick={() => {
                  setRemoveLocationItem(null);
                  setRemoveLocationError(null);
                }}
                className="px-4 py-2 rounded-xl border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 text-xs font-semibold cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={removingLocationItem}
                onClick={async () => {
                  setRemovingLocationItem(true);
                  setRemoveLocationError(null);
                  try {
                    await removeZeroStockBalanceFromLocation({
                      property_id: activePropertyId,
                      product_id: removeLocationItem.product_id,
                      location_id: removeLocationItem.location_id,
                    });
                    const prodName = removeLocationItem.product_name;
                    const locName = removeLocationItem.location_name;
                    setRemoveLocationItem(null);
                    handleActionSuccess(`Produk "${prodName}" berhasil dihapus dari lokasi ${locName}.`);
                  } catch (err: any) {
                    setRemoveLocationError(err?.message || 'Gagal menghapus produk dari lokasi ini');
                  } finally {
                    setRemovingLocationItem(false);
                  }
                }}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-bold shadow-xs transition-colors cursor-pointer disabled:opacity-50"
              >
                {removingLocationItem ? 'Menghapus...' : 'Ya, Hapus dari Lokasi Ini'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
