import React, { useState } from 'react';
import { KpiCard, SectionTitle, LoadingState, ErrorState, EmptyState, formatIdr, formatNumber, BarList } from './laporanUi';
import type { AnalyticsHubData, PosItemSaleRow } from './laporanTypes';
import type { LaporanError } from './useLaporanWorkspace';

export interface LaporanTabPenjualanProps {
  data: AnalyticsHubData | null;
  loading: boolean;
  error: LaporanError | null;
  onRetry: () => void;
}

export const LaporanTabPenjualan: React.FC<LaporanTabPenjualanProps> = ({
  data,
  loading,
  error,
  onRetry,
}) => {
  const [itemFilter, setItemFilter] = useState<string>('all');

  if (loading && !data) return <LoadingState label="Memuat data penjualan..." />;
  if (error && !data) return <ErrorState message={error.message} onRetry={onRetry} />;
  if (!data) return <EmptyState title="Belum ada data" message="Pilih periode untuk memuat laporan." />;

  const allItems: PosItemSaleRow[] = data.pos_item_sales || [];
  const categories = Array.from(new Set(allItems.map((i) => i.category_name || 'Lainnya')));

  const filtered = itemFilter === 'all'
    ? allItems
    : allItems.filter((i) => (i.category_name || 'Lainnya') === itemFilter);

  const grossSales = filtered.reduce((s, i) => s + (Number(i.line_total) || 0), 0);
  const totalDiscount = filtered.reduce((s, i) => s + (Number(i.discount_amount) || 0), 0);
  const totalHpp = filtered.reduce((s, i) => s + (Number(i.total_hpp) || 0), 0);
  const grossProfit = filtered.reduce(
    (s, i) => s + (Number(i.line_total) || 0) - (Number(i.total_hpp) || 0),
    0
  );
  const compCount = filtered.filter((i) => i.is_complimentary).length;
  const categoryMap = new Map<string, number>();
  for (const i of filtered) {
    const key = i.category_name || 'Lainnya';
    categoryMap.set(key, (categoryMap.get(key) || 0) + (Number(i.line_total) || 0));
  }
  const topCategories = Array.from(categoryMap.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);

  return (
    <div className="space-y-6">
      {/* KPI */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <KpiCard accent="emerald" label="Omzet (Line Total)" value={formatIdr(grossSales)} sublabel={`${filtered.length} baris`} emphasis />
        <KpiCard label="Diskon" value={formatIdr(totalDiscount)} accent="rose" sublabel="Total potongan" />
        <KpiCard label="HPP" value={formatIdr(totalHpp)} accent="amber" sublabel="Biaya pokok" />
        <KpiCard label="Laba Kotor" value={formatIdr(grossProfit)} accent="teal" sublabel="Omzet − HPP" />
        <KpiCard label="Item Komplementer" value={formatNumber(compCount)} accent="slate" sublabel="Comp / diskon penuh" />
        <KpiCard label="Kategori" value={formatNumber(categories.length)} accent="blue" sublabel="Jumlah kategori" />
      </div>

      {/* Category dropdown + breakdown */}
      <div>
        <SectionTitle
          title="Jenis / Kategori Item"
          right={
            <select
              value={itemFilter}
              onChange={(e) => setItemFilter(e.target.value)}
              className="border border-slate-300 rounded-lg px-3 py-1.5 text-xs bg-white font-medium focus:outline-hidden focus:ring-1 focus:ring-emerald-600"
            >
              <option value="all">Semua Kategori</option>
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          }
        />
        <div className="mt-2 bg-white border border-slate-200 rounded-xl shadow-sm p-4">
          <BarList
            data={topCategories}
            emptyMessage="Belum ada penjualan POS"
            valueFormatter={(v) => formatIdr(v)}
            maxBars={8}
          />
        </div>
      </div>

      {/* Detail table */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-700">
          Detail Item POS ({filtered.length} baris)
        </div>
        <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
          <table className="min-w-full text-xs divide-y divide-slate-200">
            <thead className="sticky top-0 z-10 bg-slate-100 text-slate-700 font-semibold uppercase tracking-wider text-[11px] border-b border-slate-200">
              <tr>
                <th className="py-2.5 px-3 text-left">Tanggal</th>
                <th className="py-2.5 px-3 text-left">No. Pesanan</th>
                <th className="py-2.5 px-3 text-left">Item</th>
                <th className="py-2.5 px-3 text-left">Kategori</th>
                <th className="py-2.5 px-3 text-right">Qty</th>
                <th className="py-2.5 px-3 text-right">Harga</th>
                <th className="py-2.5 px-3 text-right">Total</th>
                <th className="py-2.5 px-3 text-right">HPP</th>
                <th className="py-2.5 px-3 text-left">Metode</th>
                <th className="py-2.5 px-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-6 text-center text-slate-400">
                    Tidak ada data penjualan untuk kategori ini
                  </td>
                </tr>
              ) : (
                filtered.map((i) => (
                  <tr key={i.order_item_id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-2 px-3">{i.tx_date}</td>
                    <td className="py-2 px-3 font-mono text-[11px]">{i.booking_or_order_no}</td>
                    <td className="py-2 px-3">
                      <div className="font-semibold text-slate-900">{i.item_name}</div>
                      <div className="text-[10px] text-slate-400">{i.customer_name}</div>
                    </td>
                    <td className="py-2 px-3">{i.category_name}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{i.quantity}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{formatNumber(i.unit_price)}</td>
                    <td className="py-2 px-3 text-right font-semibold tabular-nums text-slate-900">
                      {formatNumber(i.line_total)}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums text-amber-700">
                      {formatNumber(i.total_hpp)}
                    </td>
                    <td className="py-2 px-3">
                      {i.is_complimentary ? (
                        <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-semibold">
                          COMP
                        </span>
                      ) : null}
                      <span className="ml-1">{i.payment_method}</span>
                    </td>
                    <td className="py-2 px-3">{i.payment_status}</td>
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
