import React, { useState } from 'react';
import {
  KpiCard,
  SectionTitle,
  LoadingState,
  ErrorState,
  EmptyState,
  formatIdr,
  formatNumber,
  BarList,
} from './laporanUi';
import type { FinancialsData } from './laporanTypes';
import type { LaporanError } from './useLaporanWorkspace';

export interface LaporanTabPemasukanProps {
  data: FinancialsData | null;
  loading: boolean;
  error: LaporanError | null;
  onRetry: () => void;
}

type BreakdownMode = 'category' | 'method';

export const LaporanTabPemasukan: React.FC<LaporanTabPemasukanProps> = ({
  data,
  loading,
  error,
  onRetry,
}) => {
  const [mode, setMode] = useState<BreakdownMode>('category');

  if (loading && !data) return <LoadingState label="Memuat data pemasukan..." />;
  if (error && !data) return <ErrorState message={error.message} onRetry={onRetry} />;
  if (!data) return <EmptyState title="Belum ada data" message="Pilih periode untuk memuat laporan." />;

  const income = data.income;
  const byCategory = income?.by_category || [];
  const byMethod = income?.by_payment_method || [];
  const rows = mode === 'category' ? byCategory : byMethod;

  const breakdownBars =
    mode === 'category'
      ? byCategory.map((c) => ({ label: c.category_name, value: c.total, sublabel: `${c.count} transaksi` }))
      : byMethod.map((m) => ({ label: m.method, value: m.total, sublabel: `${m.count} transaksi` }));

  const topCategory = byCategory[0];
  const topMethod = byMethod[0];
  const avgPerTx = income.count > 0 ? income.total / income.count : 0;

  return (
    <div className="space-y-6">
      {/* KPI */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          accent="emerald"
          label="Total Pemasukan"
          value={formatIdr(income.total)}
          sublabel={`${formatNumber(income.count)} transaksi`}
          emphasis
        />
        <KpiCard
          label="Rata-rata / Transaksi"
          value={formatIdr(avgPerTx)}
          accent="blue"
          sublabel="Nilai rata-rata"
        />
        <KpiCard
          label="Kategori Terbesar"
          value={topCategory ? formatIdr(topCategory.total) : formatIdr(0)}
          accent="teal"
          sublabel={topCategory?.category_name || '—'}
        />
        <KpiCard
          label="Metode Terbesar"
          value={topMethod ? formatIdr(topMethod.total) : formatIdr(0)}
          accent="amber"
          sublabel={topMethod?.method || '—'}
        />
      </div>

      {/* Breakdown with toggle */}
      <div>
        <SectionTitle
          title="Rincian Pemasukan"
          hint="SALE + INCOME yang sudah posted (batal/void dikecualikan)"
          right={
            <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
              <button
                type="button"
                onClick={() => setMode('category')}
                className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                  mode === 'category'
                    ? 'bg-white text-emerald-800 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Per Kategori
              </button>
              <button
                type="button"
                onClick={() => setMode('method')}
                className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                  mode === 'method'
                    ? 'bg-white text-emerald-800 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Per Metode
              </button>
            </div>
          }
        />
        <div className="mt-2 bg-white border border-slate-200 rounded-xl shadow-sm p-4">
          <BarList
            data={breakdownBars}
            emptyMessage="Belum ada pemasukan di periode ini"
            valueFormatter={(v) => formatIdr(v)}
            maxBars={10}
          />
        </div>
      </div>

      {/* Detail table */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-700">
          Detail {mode === 'category' ? 'per Kategori' : 'per Metode Pembayaran'} ({rows.length} baris)
        </div>
        <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
          <table className="min-w-full text-xs divide-y divide-slate-200">
            <thead className="sticky top-0 z-10 bg-slate-100 text-slate-700 font-semibold uppercase tracking-wider text-[11px] border-b border-slate-200">
              <tr>
                <th className="py-2.5 px-3 text-left">
                  {mode === 'category' ? 'Kategori' : 'Metode Pembayaran'}
                </th>
                {mode === 'category' ? (
                  <th className="py-2.5 px-3 text-left">Kode</th>
                ) : null}
                <th className="py-2.5 px-3 text-right">Jumlah Transaksi</th>
                <th className="py-2.5 px-3 text-right">Total</th>
                <th className="py-2.5 px-3 text-right">% dari Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-slate-400">
                    Tidak ada data pemasukan pada periode ini
                  </td>
                </tr>
              ) : mode === 'category' ? (
                byCategory.map((c) => {
                  const pct = income.total > 0 ? (c.total / income.total) * 100 : 0;
                  return (
                    <tr key={c.category_code} className="hover:bg-slate-50/80 transition-colors">
                      <td className="py-2 px-3 font-semibold text-slate-900">{c.category_name}</td>
                      <td className="py-2 px-3 font-mono text-[10px] text-slate-500">{c.category_code}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{formatNumber(c.count)}</td>
                      <td className="py-2 px-3 text-right font-semibold tabular-nums">{formatIdr(c.total)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-slate-500">
                        {pct.toFixed(2)}%
                      </td>
                    </tr>
                  );
                })
              ) : (
                byMethod.map((m) => {
                  const pct = income.total > 0 ? (m.total / income.total) * 100 : 0;
                  return (
                    <tr key={m.method} className="hover:bg-slate-50/80 transition-colors">
                      <td className="py-2 px-3 font-semibold text-slate-900">{m.method}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{formatNumber(m.count)}</td>
                      <td className="py-2 px-3 text-right font-semibold tabular-nums">{formatIdr(m.total)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-slate-500">
                        {pct.toFixed(2)}%
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
