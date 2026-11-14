/**
 * OAK HIMS — MP-04E Food Cost & Menu Engineering Section
 * Dashboard Analisis Margin HPP F&B dan Matriks Menu Engineering 4 Kuadran
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  fetchFoodCostOverview,
  fetchMenuEngineeringReport,
} from './posFoodCostApi';
import type {
  FoodCostOverviewResponse,
  FoodCostClassification,
  MenuEngineeringReportResponse,
  MenuEngineeringQuadrant,
} from './posFoodCostApi';
import ProductFoodCostModal from './ProductFoodCostModal';

interface Props {
  propertyId: number;
}

type SubTab = 'FOOD_COST' | 'MENU_ENGINEERING';

function formatIDR(val: number | string): string {
  const num = typeof val === 'string' ? parseFloat(val) || 0 : val || 0;
  return 'Rp ' + Math.round(num).toLocaleString('id-ID');
}

export default function FoodCostOverviewSection({ propertyId }: Props) {
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('FOOD_COST');

  // Food Cost Overview State
  const [fcData, setFcData] = useState<FoodCostOverviewResponse | null>(null);
  const [fcLoading, setFcLoading] = useState<boolean>(true);
  const [fcError, setFcError] = useState<string | null>(null);
  const [fcSearch, setFcSearch] = useState<string>('');
  const [fcStatusFilter, setFcStatusFilter] = useState<FoodCostClassification | 'ALL'>('ALL');

  // Menu Engineering State
  const [meData, setMeData] = useState<MenuEngineeringReportResponse | null>(null);
  const [meLoading, setMeLoading] = useState<boolean>(true);
  const [meError, setMeError] = useState<string | null>(null);
  const [meStartDate, setMeStartDate] = useState<string>(() => {
    const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  });
  const [meEndDate, setMeEndDate] = useState<string>(() => {
    return new Date().toISOString().slice(0, 10);
  });
  const [selectedQuadrantFilter, setSelectedQuadrantFilter] = useState<
    MenuEngineeringQuadrant | 'ALL'
  >('ALL');

  // Detail Modal State
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null);

  // Load Food Cost Overview
  const loadFoodCostOverview = useCallback(async () => {
    try {
      setFcLoading(true);
      setFcError(null);
      const res = await fetchFoodCostOverview(propertyId, {
        status: fcStatusFilter,
        search: fcSearch.trim() || undefined,
      });
      setFcData(res);
    } catch (err: any) {
      setFcError(err.message || 'Gagal memuat overview food cost');
    } finally {
      setFcLoading(false);
    }
  }, [propertyId, fcStatusFilter, fcSearch]);

  // Load Menu Engineering Report
  const loadMenuEngineering = useCallback(async () => {
    try {
      setMeLoading(true);
      setMeError(null);
      const res = await fetchMenuEngineeringReport(propertyId, {
        startDate: meStartDate,
        endDate: meEndDate,
      });
      setMeData(res);
    } catch (err: any) {
      setMeError(err.message || 'Gagal memuat laporan menu engineering');
    } finally {
      setMeLoading(false);
    }
  }, [propertyId, meStartDate, meEndDate]);

  useEffect(() => {
    if (activeSubTab === 'FOOD_COST') {
      void loadFoodCostOverview();
    } else {
      void loadMenuEngineering();
    }
  }, [activeSubTab, loadFoodCostOverview, loadMenuEngineering]);

  // Filtered Menu Engineering Items
  const filteredMeItems = useMemo(() => {
    if (!meData) return [];
    if (selectedQuadrantFilter === 'ALL') return meData.items;
    return meData.items.filter((i) => i.quadrant === selectedQuadrantFilter);
  }, [meData, selectedQuadrantFilter]);

  return (
    <div className="space-y-6">
      {/* Context Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-6 rounded-2xl border border-gray-200/80 shadow-xs">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold tracking-wider bg-emerald-50 text-emerald-800 border border-emerald-200/60 uppercase">
              Manajemen Persediaan
            </span>
            <span className="text-xs text-gray-400">•</span>
            <span className="text-xs text-gray-500">Property #{propertyId || 1}</span>
          </div>
          <h1 className="text-2xl font-black text-gray-900 tracking-tight">Analisis Food Cost</h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">
            Evaluasi Harga Pokok Penjualan (HPP) berbasis resep/BOM dan biaya rata-rata bahan baku (Moving Average Cost), beserta matriks Menu Engineering F&amp;B.
          </p>
        </div>
      </div>

      {/* Sub-tab Navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-stone-100/80 p-1.5 rounded-2xl border border-stone-200">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setActiveSubTab('FOOD_COST')}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer ${
              activeSubTab === 'FOOD_COST'
                ? 'bg-[#1b4332] text-white shadow-xs'
                : 'text-stone-600 hover:text-stone-900 hover:bg-white/60'
            }`}
          >
            <span>📊</span>
            <span>Analisis Food Cost &amp; Margin HPP</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveSubTab('MENU_ENGINEERING')}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer ${
              activeSubTab === 'MENU_ENGINEERING'
                ? 'bg-[#1b4332] text-white shadow-xs'
                : 'text-stone-600 hover:text-stone-900 hover:bg-white/60'
            }`}
          >
            <span>🎯</span>
            <span>Matriks Menu Engineering F&amp;B</span>
          </button>
        </div>

        <button
          type="button"
          onClick={() => {
            if (activeSubTab === 'FOOD_COST') void loadFoodCostOverview();
            else void loadMenuEngineering();
          }}
          disabled={fcLoading || meLoading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-stone-600 bg-white hover:bg-stone-50 border border-stone-200 rounded-xl transition-colors cursor-pointer"
        >
          <svg
            className={`w-3.5 h-3.5 ${fcLoading || meLoading ? 'animate-spin' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          <span>Refresh</span>
        </button>
      </div>

      {/* ──────────────────────────────────────────────────────────────────────── */}
      {/* VIEW 1: FOOD COST & MARGIN HPP                                           */}
      {/* ──────────────────────────────────────────────────────────────────────── */}
      {activeSubTab === 'FOOD_COST' && (
        <div className="space-y-6">
          {/* Summary Metric Cards */}
          {fcData?.summary && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <div className="p-3.5 bg-white rounded-xl border border-stone-200 shadow-2xs">
                <span className="text-[10px] font-bold text-stone-500 uppercase block tracking-wider">
                  Total Menu F&amp;B
                </span>
                <span className="text-xl font-black text-stone-800 mt-1 block">
                  {fcData.summary.total_items}
                </span>
                <span className="text-[10px] text-stone-400 mt-0.5 block">
                  {fcData.summary.items_with_recipe} berformula resep
                </span>
              </div>

              <div className="p-3.5 bg-emerald-50/50 rounded-xl border border-emerald-200 shadow-2xs">
                <span className="text-[10px] font-bold text-emerald-700 uppercase block tracking-wider">
                  Rata-rata Food Cost
                </span>
                <span className="text-xl font-black text-emerald-900 mt-1 block">
                  {fcData.summary.average_food_cost_percentage}%
                </span>
                <span className="text-[10px] text-emerald-600 mt-0.5 block">Target hotel: 28-35%</span>
              </div>

              <div className="p-3.5 bg-teal-50/50 rounded-xl border border-teal-200 shadow-2xs">
                <span className="text-[10px] font-bold text-teal-700 uppercase block tracking-wider">
                  Low Cost (&lt;30%)
                </span>
                <span className="text-xl font-black text-teal-900 mt-1 block">
                  {fcData.summary.count_low_cost}
                </span>
                <span className="text-[10px] text-teal-600 mt-0.5 block">Margin profit tebal</span>
              </div>

              <div className="p-3.5 bg-blue-50/50 rounded-xl border border-blue-200 shadow-2xs">
                <span className="text-[10px] font-bold text-blue-700 uppercase block tracking-wider">
                  Healthy (30-35%)
                </span>
                <span className="text-xl font-black text-blue-900 mt-1 block">
                  {fcData.summary.count_healthy}
                </span>
                <span className="text-[10px] text-blue-600 mt-0.5 block">Rentang ideal F&amp;B</span>
              </div>

              <div className="p-3.5 bg-rose-50/50 rounded-xl border border-rose-200 shadow-2xs">
                <span className="text-[10px] font-bold text-rose-700 uppercase block tracking-wider">
                  Over Cost (&gt;35%)
                </span>
                <span className="text-xl font-black text-rose-900 mt-1 block">
                  {fcData.summary.count_over_cost}
                </span>
                <span className="text-[10px] text-rose-600 mt-0.5 block">Perlu efisiensi harga</span>
              </div>

              <div className="p-3.5 bg-amber-50/50 rounded-xl border border-amber-200 shadow-2xs">
                <span className="text-[10px] font-bold text-amber-700 uppercase block tracking-wider">
                  Tanpa Resep
                </span>
                <span className="text-xl font-black text-amber-900 mt-1 block">
                  {fcData.summary.count_no_recipe}
                </span>
                <span className="text-[10px] text-amber-600 mt-0.5 block">Perlu input BOM</span>
              </div>
            </div>
          )}

          {/* Filter Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-4 rounded-xl border border-stone-200 shadow-2xs">
            <div className="flex flex-wrap items-center gap-3 flex-1">
              <div className="relative min-w-[220px]">
                <input
                  type="text"
                  placeholder="Cari nama atau kode menu..."
                  value={fcSearch}
                  onChange={(e) => setFcSearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 text-xs rounded-xl border border-stone-300 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
                <svg
                  className="w-4 h-4 text-stone-400 absolute left-3 top-2.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>

              <select
                value={fcStatusFilter}
                onChange={(e) => setFcStatusFilter(e.target.value as any)}
                className="px-3 py-2 text-xs rounded-xl border border-stone-300 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 font-medium text-stone-700"
              >
                <option value="ALL">Semua Status Food Cost</option>
                <option value="LOW_COST">Low Cost (&lt; 30%)</option>
                <option value="HEALTHY">Healthy (30% - 35%)</option>
                <option value="OVER_COST">Over Cost (&gt; 35%)</option>
                <option value="NO_RECIPE">Belum Ada Resep (BOM)</option>
              </select>
            </div>
          </div>

          {/* Data Table */}
          <div className="bg-white rounded-xl border border-stone-200 shadow-2xs overflow-hidden">
            {fcLoading ? (
              <div className="py-16 text-center text-stone-500">
                <div className="animate-spin inline-block w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full mb-2"></div>
                <p className="text-xs">Memuat kalkulasi HPP dan margin menu...</p>
              </div>
            ) : fcError ? (
              <div className="p-6 text-center text-red-600 text-xs">
                <p className="font-bold mb-1">Gagal Memuat Data</p>
                <p>{fcError}</p>
              </div>
            ) : !fcData || fcData.items.length === 0 ? (
              <div className="py-16 text-center text-stone-400 text-xs">
                Tidak ada menu F&amp;B yang cocok dengan kriteria pencarian.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-stone-50 text-stone-600 font-bold border-b border-stone-200">
                    <tr>
                      <th className="py-3 px-4">Menu F&amp;B</th>
                      <th className="py-3 px-4">Kategori</th>
                      <th className="py-3 px-4 text-right">Harga Jual</th>
                      <th className="py-3 px-4 text-right">HPP (COGS)</th>
                      <th className="py-3 px-4 text-right">Gross Profit</th>
                      <th className="py-3 px-4 text-right">Food Cost %</th>
                      <th className="py-3 px-4 text-center">Status</th>
                      <th className="py-3 px-4 text-center">Resep BOM</th>
                      <th className="py-3 px-4 text-center">Aksi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {fcData.items.map((item) => (
                      <tr key={item.product_id} className="hover:bg-stone-50/80 transition-colors">
                        <td className="py-3 px-4">
                          <span className="font-bold text-stone-900 block">{item.product_name}</span>
                          <span className="text-[10px] text-stone-400 font-mono">
                            {item.item_code || '-'}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-stone-600">
                          {item.category_name || '-'}
                        </td>
                        <td className="py-3 px-4 text-right font-semibold text-stone-800">
                          {formatIDR(item.selling_price)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-semibold text-emerald-800">
                          {formatIDR(item.hpp)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-semibold text-blue-800">
                          {formatIDR(item.gross_profit)}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span
                            className={`font-black ${
                              item.food_cost_percentage > 35
                                ? 'text-rose-600'
                                : item.food_cost_percentage >= 30
                                ? 'text-blue-600'
                                : 'text-emerald-600'
                            }`}
                          >
                            {item.food_cost_percentage}%
                          </span>
                        </td>
                        <td className="py-3 px-4 text-center">
                          <span
                            className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold ${
                              item.classification === 'LOW_COST'
                                ? 'bg-emerald-100 text-emerald-800'
                                : item.classification === 'HEALTHY'
                                ? 'bg-blue-100 text-blue-800'
                                : item.classification === 'OVER_COST'
                                ? 'bg-rose-100 text-rose-800'
                                : 'bg-stone-100 text-stone-600'
                            }`}
                          >
                            {item.classification_label}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-center">
                          {item.has_recipe ? (
                            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 font-semibold">
                              <span>✓</span> {item.ingredient_count} Bahan
                            </span>
                          ) : (
                            <span className="text-[11px] text-stone-400">Langsung</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-center">
                          <button
                            type="button"
                            onClick={() => setSelectedProductId(item.product_id)}
                            className="px-2.5 py-1 text-[11px] font-bold rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 transition-colors cursor-pointer"
                          >
                            Rincian HPP
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ──────────────────────────────────────────────────────────────────────── */}
      {/* VIEW 2: MENU ENGINEERING MATRIX (KASAVANA & SMITH)                      */}
      {/* ──────────────────────────────────────────────────────────────────────── */}
      {activeSubTab === 'MENU_ENGINEERING' && (
        <div className="space-y-6">
          {/* Header & Date Filters */}
          <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-4 rounded-xl border border-stone-200 shadow-2xs">
            <div>
              <h3 className="text-sm font-bold text-stone-800">
                Matriks Analisis Menu Engineering (Kasavana &amp; Smith 1982)
              </h3>
              <p className="text-xs text-stone-500">
                Mengkombinasikan volume penjualan aktual (Popularitas) dengan Margin Kontribusi ($P - C$).
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 text-xs">
                <span className="text-stone-500">Dari:</span>
                <input
                  type="date"
                  value={meStartDate}
                  onChange={(e) => setMeStartDate(e.target.value)}
                  className="px-2.5 py-1.5 rounded-lg border border-stone-300 text-xs text-stone-700 font-medium"
                />
              </div>
              <div className="flex items-center gap-1 text-xs">
                <span className="text-stone-500">Sampai:</span>
                <input
                  type="date"
                  value={meEndDate}
                  onChange={(e) => setMeEndDate(e.target.value)}
                  className="px-2.5 py-1.5 rounded-lg border border-stone-300 text-xs text-stone-700 font-medium"
                />
              </div>
            </div>
          </div>

          {/* Benchmarks Bar */}
          {meData?.benchmarks && (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div className="p-3.5 bg-white rounded-xl border border-stone-200">
                <span className="text-[10px] font-bold text-stone-500 uppercase block">Total Porsi Terjual</span>
                <span className="text-lg font-black text-stone-900 mt-1 block">
                  {meData.benchmarks.total_volume_sold} Porsi
                </span>
                <span className="text-[10px] text-stone-400">
                  {meData.benchmarks.distinct_item_count} Variasi Menu
                </span>
              </div>

              <div className="p-3.5 bg-emerald-50 rounded-xl border border-emerald-200">
                <span className="text-[10px] font-bold text-emerald-700 uppercase block">Total Omzet Penjualan</span>
                <span className="text-lg font-black text-emerald-950 mt-1 block">
                  {formatIDR(meData.benchmarks.total_revenue)}
                </span>
                <span className="text-[10px] text-emerald-700">Status pesanan PAID</span>
              </div>

              <div className="p-3.5 bg-blue-50 rounded-xl border border-blue-200">
                <span className="text-[10px] font-bold text-blue-700 uppercase block">Total Margin Kontribusi</span>
                <span className="text-lg font-black text-blue-950 mt-1 block">
                  {formatIDR(meData.benchmarks.total_contribution_margin)}
                </span>
                <span className="text-[10px] text-blue-700">Gross Margin Aktual</span>
              </div>

              <div className="p-3.5 bg-amber-50 rounded-xl border border-amber-200">
                <span className="text-[10px] font-bold text-amber-700 uppercase block">Benchmark Margin (CM)</span>
                <span className="text-lg font-black text-amber-950 mt-1 block">
                  {formatIDR(meData.benchmarks.average_contribution_margin)}
                </span>
                <span className="text-[10px] text-amber-700">Ambang Batas Profit</span>
              </div>

              <div className="p-3.5 bg-purple-50 rounded-xl border border-purple-200">
                <span className="text-[10px] font-bold text-purple-700 uppercase block">Hurdle Rate Popularitas</span>
                <span className="text-lg font-black text-purple-950 mt-1 block">
                  {meData.benchmarks.popularity_hurdle_rate_percentage}%
                </span>
                <span className="text-[10px] text-purple-700">70% x Rata-rata Mix</span>
              </div>
            </div>
          )}

          {/* 4 Quadrants Interactive Cards */}
          {meData && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* STARS */}
              <div
                onClick={() => setSelectedQuadrantFilter(selectedQuadrantFilter === 'STARS' ? 'ALL' : 'STARS')}
                className={`p-4 rounded-2xl border-2 transition-all cursor-pointer ${
                  selectedQuadrantFilter === 'STARS'
                    ? 'border-emerald-600 bg-emerald-50/70 shadow-md ring-2 ring-emerald-400'
                    : 'border-emerald-300 bg-emerald-50/30 hover:bg-emerald-50/50'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">🌟</span>
                    <h4 className="text-sm font-black text-emerald-900">STARS</h4>
                  </div>
                  <span className="px-2 py-0.5 rounded-full bg-emerald-200 text-emerald-900 text-xs font-black">
                    {meData.quadrants.stars.length} Menu
                  </span>
                </div>
                <p className="text-[11px] text-emerald-800 font-medium">Popularitas Tinggi • Margin Tinggi</p>
                <p className="text-[10px] text-emerald-600 mt-2">
                  Rekomendasi: Pertahankan kualitas resep &amp; konsistensi, posisikan mencolok di menu.
                </p>
              </div>

              {/* PLOWHORSES */}
              <div
                onClick={() =>
                  setSelectedQuadrantFilter(selectedQuadrantFilter === 'PLOWHORSES' ? 'ALL' : 'PLOWHORSES')
                }
                className={`p-4 rounded-2xl border-2 transition-all cursor-pointer ${
                  selectedQuadrantFilter === 'PLOWHORSES'
                    ? 'border-blue-600 bg-blue-50/70 shadow-md ring-2 ring-blue-400'
                    : 'border-blue-300 bg-blue-50/30 hover:bg-blue-50/50'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">🐴</span>
                    <h4 className="text-sm font-black text-blue-900">PLOWHORSES</h4>
                  </div>
                  <span className="px-2 py-0.5 rounded-full bg-blue-200 text-blue-900 text-xs font-black">
                    {meData.quadrants.plowhorses.length} Menu
                  </span>
                </div>
                <p className="text-[11px] text-blue-800 font-medium">Popularitas Tinggi • Margin Rendah</p>
                <p className="text-[10px] text-blue-600 mt-2">
                  Rekomendasi: Naikkan harga secara bertahap atau kurangi porsi/cost bahan baku penyusun.
                </p>
              </div>

              {/* PUZZLES */}
              <div
                onClick={() =>
                  setSelectedQuadrantFilter(selectedQuadrantFilter === 'PUZZLES' ? 'ALL' : 'PUZZLES')
                }
                className={`p-4 rounded-2xl border-2 transition-all cursor-pointer ${
                  selectedQuadrantFilter === 'PUZZLES'
                    ? 'border-amber-600 bg-amber-50/70 shadow-md ring-2 ring-amber-400'
                    : 'border-amber-300 bg-amber-50/30 hover:bg-amber-50/50'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">🧩</span>
                    <h4 className="text-sm font-black text-amber-900">PUZZLES</h4>
                  </div>
                  <span className="px-2 py-0.5 rounded-full bg-amber-200 text-amber-900 text-xs font-black">
                    {meData.quadrants.puzzles.length} Menu
                  </span>
                </div>
                <p className="text-[11px] text-amber-800 font-medium">Popularitas Rendah • Margin Tinggi</p>
                <p className="text-[10px] text-amber-600 mt-2">
                  Rekomendasi: Tingkatkan promosi, upselling pelayan kasir, perbaiki foto/deskripsi menu.
                </p>
              </div>

              {/* DOGS */}
              <div
                onClick={() => setSelectedQuadrantFilter(selectedQuadrantFilter === 'DOGS' ? 'ALL' : 'DOGS')}
                className={`p-4 rounded-2xl border-2 transition-all cursor-pointer ${
                  selectedQuadrantFilter === 'DOGS'
                    ? 'border-rose-600 bg-rose-50/70 shadow-md ring-2 ring-rose-400'
                    : 'border-rose-300 bg-rose-50/30 hover:bg-rose-50/50'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">🐕</span>
                    <h4 className="text-sm font-black text-rose-900">DOGS</h4>
                  </div>
                  <span className="px-2 py-0.5 rounded-full bg-rose-200 text-rose-900 text-xs font-black">
                    {meData.quadrants.dogs.length} Menu
                  </span>
                </div>
                <p className="text-[11px] text-rose-800 font-medium">Popularitas Rendah • Margin Rendah</p>
                <p className="text-[10px] text-rose-600 mt-2">
                  Rekomendasi: Evaluasi untuk dieliminasi dari menu cetak atau ganti varian baru.
                </p>
              </div>
            </div>
          )}

          {/* Matrix Detail Table */}
          <div className="bg-white rounded-xl border border-stone-200 shadow-2xs overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 bg-stone-50 border-b border-stone-200">
              <span className="text-xs font-bold text-stone-700">
                Daftar Menu F&amp;B ({filteredMeItems.length} Item)
                {selectedQuadrantFilter !== 'ALL' && ` — Filter Kuadran: ${selectedQuadrantFilter}`}
              </span>
              {selectedQuadrantFilter !== 'ALL' && (
                <button
                  type="button"
                  onClick={() => setSelectedQuadrantFilter('ALL')}
                  className="text-xs text-stone-500 hover:text-stone-800 underline font-medium cursor-pointer"
                >
                  Tampilkan Semua Kuadran
                </button>
              )}
            </div>

            {meLoading ? (
              <div className="py-16 text-center text-stone-500">
                <div className="animate-spin inline-block w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full mb-2"></div>
                <p className="text-xs">Menyusun matriks evaluasi menu...</p>
              </div>
            ) : meError ? (
              <div className="p-6 text-center text-red-600 text-xs">
                <p className="font-bold mb-1">Gagal Memuat Laporan</p>
                <p>{meError}</p>
              </div>
            ) : filteredMeItems.length === 0 ? (
              <div className="py-16 text-center text-stone-400 text-xs">
                Tidak ada data transaksi menu berstatus PAID pada rentang tanggal ini.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-stone-50 text-stone-600 font-bold border-b border-stone-200">
                    <tr>
                      <th className="py-3 px-4">Menu</th>
                      <th className="py-3 px-4 text-center">Kuadran</th>
                      <th className="py-3 px-4 text-right">Porsi Terjual</th>
                      <th className="py-3 px-4 text-right">Menu Mix %</th>
                      <th className="py-3 px-4 text-right">Harga Jual</th>
                      <th className="py-3 px-4 text-right">HPP</th>
                      <th className="py-3 px-4 text-right">Margin / Porsi</th>
                      <th className="py-3 px-4 text-right">Total Margin</th>
                      <th className="py-3 px-4">Rekomendasi Taktis Bisnis</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {filteredMeItems.map((item) => (
                      <tr key={item.product_id} className="hover:bg-stone-50/80 transition-colors">
                        <td className="py-3 px-4">
                          <span className="font-bold text-stone-900 block">{item.product_name}</span>
                          <span className="text-[10px] text-stone-400 font-mono">
                            {item.item_code || '-'} {item.category_name ? `• ${item.category_name}` : ''}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-center">
                          <span
                            className={`inline-block px-2.5 py-1 rounded-full text-[10px] font-black tracking-wide ${
                              item.quadrant === 'STARS'
                                ? 'bg-emerald-100 text-emerald-900'
                                : item.quadrant === 'PLOWHORSES'
                                ? 'bg-blue-100 text-blue-900'
                                : item.quadrant === 'PUZZLES'
                                ? 'bg-amber-100 text-amber-900'
                                : 'bg-rose-100 text-rose-900'
                            }`}
                          >
                            {item.quadrant === 'STARS'
                              ? '🌟 STARS'
                              : item.quadrant === 'PLOWHORSES'
                              ? '🐴 PLOWHORSES'
                              : item.quadrant === 'PUZZLES'
                              ? '🧩 PUZZLES'
                              : '🐕 DOGS'}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right font-black text-stone-900">
                          {item.quantity_sold}
                        </td>
                        <td className="py-3 px-4 text-right font-semibold text-stone-700">
                          {item.menu_mix_percentage}%
                        </td>
                        <td className="py-3 px-4 text-right text-stone-700 font-medium">
                          {formatIDR(item.selling_price)}
                        </td>
                        <td className="py-3 px-4 text-right text-emerald-800 font-mono font-medium">
                          {formatIDR(item.hpp)}
                        </td>
                        <td className="py-3 px-4 text-right text-blue-800 font-mono font-bold">
                          {formatIDR(item.unit_margin)}
                        </td>
                        <td className="py-3 px-4 text-right text-stone-900 font-mono font-bold">
                          {formatIDR(item.total_margin)}
                        </td>
                        <td className="py-3 px-4 text-stone-600 text-[11px] leading-relaxed max-w-xs">
                          {item.recommendation}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Product Food Cost Breakdown Modal */}
      {selectedProductId !== null && (
        <ProductFoodCostModal
          productId={selectedProductId}
          propertyId={propertyId}
          onClose={() => setSelectedProductId(null)}
        />
      )}
    </div>
  );
}
