import React from 'react';
import { KpiCard, SectionTitle, LoadingState, ErrorState, EmptyState, formatIdr, formatNumber } from './laporanUi';
import type { FinancialsData } from './laporanTypes';
import type { LaporanError } from './useLaporanWorkspace';

export interface LaporanTabPengeluaranProps {
  data: FinancialsData | null;
  loading: boolean;
  error: LaporanError | null;
  onRetry: () => void;
}

export const LaporanTabPengeluaran: React.FC<LaporanTabPengeluaranProps> = ({
  data,
  loading,
  error,
  onRetry,
}) => {
  if (loading && !data) return <LoadingState label="Memuat data pengeluaran..." />;
  if (error && !data) return <ErrorState message={error.message} onRetry={onRetry} />;
  if (!data) return <EmptyState title="Belum ada data" message="Pilih periode untuk memuat laporan." />;

  const expense = data.expense;
  const byCategory = expense?.by_category || [];
  const byDepartment = expense?.by_department || [];

  const topCat = byCategory[0];
  const topDept = byDepartment[0];
  const avgPerTx = expense.count > 0 ? expense.total / expense.count : 0;

  const catRows = byCategory.map((c) => ({
    key: c.category_code,
    label: c.category_name,
    code: c.category_code,
    total: c.total,
    count: c.count,
    pct: expense.total > 0 ? (c.total / expense.total) * 100 : 0,
  }));
  const deptRows = byDepartment.map((d) => ({
    key: d.department_code,
    label: d.department_code,
    total: d.total,
    count: d.count,
    pct: expense.total > 0 ? (d.total / expense.total) * 100 : 0,
  }));

  const maxCat = catRows.length > 0 ? Math.max(...catRows.map((r) => r.total)) : 0;
  const maxDept = deptRows.length > 0 ? Math.max(...deptRows.map((r) => r.total)) : 0;

  return (
    <div className="space-y-6">
      {/* KPI */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          accent="rose"
          label="Total Pengeluaran"
          value={formatIdr(expense.total)}
          sublabel={`${formatNumber(expense.count)} transaksi`}
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
          value={topCat ? formatIdr(topCat.total) : formatIdr(0)}
          accent="teal"
          sublabel={topCat?.category_name || '—'}
        />
        <KpiCard
          label="Departemen Terbesar"
          value={topDept ? formatIdr(topDept.total) : formatIdr(0)}
          accent="amber"
          sublabel={topDept?.department_code || '—'}
        />
      </div>

      {/* By category */}
      <div>
        <SectionTitle
          title="Pengeluaran per Kategori"
          hint="EXPENSE yang sudah posted (batal/void dikecualikan)"
        />
        <div className="mt-2 bg-white border border-slate-200 rounded-xl shadow-sm p-4">
          {catRows.length === 0 ? (
            <div className="text-xs text-slate-400">Belum ada pengeluaran di periode ini</div>
          ) : (
            <div className="space-y-2">
              {catRows.map((r) => {
                const pct = maxCat > 0 ? Math.round((r.total / maxCat) * 100) : 0;
                return (
                  <div key={r.key} className="flex items-center gap-3">
                    <div className="w-40 shrink-0 text-xs">
                      <div className="font-semibold text-slate-800 truncate">{r.label}</div>
                      <div className="text-[10px] text-slate-400">{r.code} • {r.count} tx</div>
                    </div>
                    <div className="flex-1 bg-slate-100 rounded-full h-2.5 overflow-hidden">
                      <div className="bg-rose-500 h-full rounded-full" style={{ width: `${Math.max(2, pct)}%` }} />
                    </div>
                    <div className="w-24 shrink-0 text-right text-xs font-bold text-slate-700 tabular-nums">
                      {formatIdr(r.total)}
                    </div>
                    <div className="w-14 shrink-0 text-right text-xs text-slate-400 tabular-nums">
                      {r.pct.toFixed(1)}%
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* By department */}
      <div>
        <SectionTitle title="Pengeluaran per Departemen" />
        <div className="mt-2 bg-white border border-slate-200 rounded-xl shadow-sm p-4">
          {deptRows.length === 0 ? (
            <div className="text-xs text-slate-400">Belum ada data departemen</div>
          ) : (
            <div className="space-y-2">
              {deptRows.map((r) => {
                const pct = maxDept > 0 ? Math.round((r.total / maxDept) * 100) : 0;
                return (
                  <div key={r.key} className="flex items-center gap-3">
                    <div className="w-40 shrink-0 text-xs">
                      <div className="font-semibold text-slate-800">{r.label}</div>
                      <div className="text-[10px] text-slate-400">{r.count} transaksi</div>
                    </div>
                    <div className="flex-1 bg-slate-100 rounded-full h-2.5 overflow-hidden">
                      <div className="bg-amber-500 h-full rounded-full" style={{ width: `${Math.max(2, pct)}%` }} />
                    </div>
                    <div className="w-24 shrink-0 text-right text-xs font-bold text-slate-700 tabular-nums">
                      {formatIdr(r.total)}
                    </div>
                    <div className="w-14 shrink-0 text-right text-xs text-slate-400 tabular-nums">
                      {r.pct.toFixed(1)}%
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
