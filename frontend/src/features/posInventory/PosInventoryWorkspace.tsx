/**
 * OAK HIMS — MP-04B POS Inventory Workspace
 * Tampilan Utama Manajemen Persediaan POS: Saldo, Valuasi, Kartu Stok, Opname, dan Transfer
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  fetchInventoryValuation,
  fetchStockLocations,
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

interface Props {
  propertyId: number | null;
  onRefreshParent?: () => void;
}

type StockStatusFilter = 'ALL' | 'SAFE' | 'LOW' | 'OUT';

function formatIDR(value: number | string): string {
  const num = typeof value === 'string' ? parseFloat(value) || 0 : value || 0;
  return 'Rp ' + Math.round(num).toLocaleString('id-ID');
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
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedLocationId, setSelectedLocationId] = useState<number | 'ALL'>('ALL');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [stockStatusFilter, setStockStatusFilter] = useState<StockStatusFilter>('ALL');

  // Modal / Drawer States
  const [ledgerItem, setLedgerItem] = useState<InventoryValuationItem | null>(null);
  const [adjustmentItem, setAdjustmentItem] = useState<InventoryValuationItem | null>(null);
  const [opnameItem, setOpnameItem] = useState<InventoryValuationItem | null>(null);
  const [transferItem, setTransferItem] = useState<InventoryValuationItem | null>(null);

  // General action modal states (when clicking top action buttons)
  const [showGeneralAdjustmentModal, setShowGeneralAdjustmentModal] = useState<boolean>(false);
  const [showGeneralOpnameModal, setShowGeneralOpnameModal] = useState<boolean>(false);
  const [showGeneralTransferModal, setShowGeneralTransferModal] = useState<boolean>(false);

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

  // Filtered items
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
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
  }, [items, selectedCategory, stockStatusFilter]);

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
              Persediaan POS &amp; HIMS
            </span>
            <span className="text-xs text-gray-400">•</span>
            <span className="text-xs text-gray-500">Property #{activePropertyId}</span>
          </div>
          <h1 className="text-2xl font-black text-gray-900 tracking-tight">
            Manajemen Persediaan &amp; Valuasi Stok
          </h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">
            Pemantauan saldo fisik per lokasi gudang/outlet, kartu stok kronologis, penyesuaian barang rusak/hilang, serta stock opname fisik.
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (items.length > 0) setAdjustmentItem(items[0]);
              else setShowGeneralAdjustmentModal(true);
            }}
            className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl border border-amber-300 bg-amber-50/80 hover:bg-amber-100 text-amber-900 text-xs font-bold shadow-2xs transition-colors cursor-pointer"
          >
            <svg className="w-4 h-4 text-amber-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            Penyesuaian Stok
          </button>

          <button
            type="button"
            onClick={() => {
              if (items.length > 0) setOpnameItem(items[0]);
              else setShowGeneralOpnameModal(true);
            }}
            className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl border border-purple-300 bg-purple-50/80 hover:bg-purple-100 text-purple-900 text-xs font-bold shadow-2xs transition-colors cursor-pointer"
          >
            <svg className="w-4 h-4 text-purple-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
            Opname Fisik
          </button>

          <button
            type="button"
            onClick={() => {
              if (items.length > 0) setTransferItem(items[0]);
              else setShowGeneralTransferModal(true);
            }}
            className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl border border-emerald-300 bg-emerald-50/80 hover:bg-emerald-100 text-emerald-900 text-xs font-bold shadow-2xs transition-colors cursor-pointer"
          >
            <svg className="w-4 h-4 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
            Transfer Stok
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

        {/* Total Kuantitas Fisik */}
        <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-2xs">
          <div className="text-xs text-gray-500 font-semibold">Total Kuantitas Fisik</div>
          <div className="text-2xl font-black text-[#1b4332] mt-1">
            {summary ? parseFloat(summary.total_quantity).toLocaleString('id-ID') : '0'}
          </div>
          <div className="text-[11px] text-gray-400 mt-0.5">
            Akumulasi unit stok fisik di semua lokasi
          </div>
        </div>

        {/* Total Valuasi Persediaan */}
        <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-2xs">
          <div className="text-xs text-gray-500 font-semibold">Total Valuasi Persediaan</div>
          <div className="text-2xl font-black text-[#bfa15f] mt-1">
            {summary ? formatIDR(summary.total_valuation_value) : 'Rp 0'}
          </div>
          <div className="text-[11px] text-gray-400 mt-0.5">
            Nilai aset berdasarkan unit cost terbaru
          </div>
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
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#faf9f5] border-b border-gray-200 text-gray-600 font-bold uppercase text-[10px] tracking-wider">
                <tr>
                  <th className="px-4 py-3">Produk &amp; SKU</th>
                  <th className="px-4 py-3">Kategori</th>
                  <th className="px-4 py-3">Lokasi</th>
                  <th className="px-4 py-3 text-right">Saldo Fisik</th>
                  <th className="px-4 py-3 text-center">Status</th>
                  <th className="px-4 py-3 text-right">Biaya Satuan</th>
                  <th className="px-4 py-3 text-right">Total Valuasi</th>
                  <th className="px-4 py-3 text-center">Aksi Cepat</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredItems.map((item) => {
                  const qty = parseFloat(item.quantity);
                  const isSafe = qty >= 10;
                  const isLow = qty > 0 && qty < 10;

                  return (
                    <tr key={`${item.product_id}-${item.location_id}`} className="hover:bg-gray-50/80 transition-colors">
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

                      {/* Physical Balance */}
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <span className="font-black text-sm text-gray-900">
                          {qty.toFixed(3)}
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
                        {formatIDR(item.unit_cost)}
                      </td>

                      {/* Total Value */}
                      <td className="px-4 py-3 text-right font-black text-gray-900 whitespace-nowrap">
                        {formatIDR(item.total_value)}
                      </td>

                      {/* Actions */}
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

                          {/* Sesuaikan */}
                          <button
                            type="button"
                            onClick={() => setAdjustmentItem(item)}
                            className="p-1 rounded-lg border border-gray-200 hover:border-amber-500 hover:text-amber-800 text-gray-600 text-xs transition-colors cursor-pointer bg-white"
                            title="Sesuaikan Stok (Rusak / Hilang)"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </button>

                          {/* Transfer */}
                          <button
                            type="button"
                            onClick={() => setTransferItem(item)}
                            className="p-1 rounded-lg border border-gray-200 hover:border-emerald-500 hover:text-emerald-800 text-gray-600 text-xs transition-colors cursor-pointer bg-white"
                            title="Transfer ke Lokasi Lain"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                            </svg>
                          </button>

                          {/* Opname */}
                          <button
                            type="button"
                            onClick={() => setOpnameItem(item)}
                            className="p-1 rounded-lg border border-gray-200 hover:border-purple-500 hover:text-purple-800 text-gray-600 text-xs transition-colors cursor-pointer bg-white"
                            title="Hitung Fisik / Opname"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                            </svg>
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

      {/* Stock Adjustment Modal */}
      <StockAdjustmentModal
        isOpen={adjustmentItem !== null || showGeneralAdjustmentModal}
        onClose={() => {
          setAdjustmentItem(null);
          setShowGeneralAdjustmentModal(false);
        }}
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
        isOpen={opnameItem !== null || showGeneralOpnameModal}
        onClose={() => {
          setOpnameItem(null);
          setShowGeneralOpnameModal(false);
        }}
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
        isOpen={transferItem !== null || showGeneralTransferModal}
        onClose={() => {
          setTransferItem(null);
          setShowGeneralTransferModal(false);
        }}
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
    </div>
  );
}
