import React from 'react';
import { KpiCard, SectionTitle, LoadingState, ErrorState, EmptyState, formatIdr, BarList } from './laporanUi';
import type { DailyOperationsData } from './useDailyOperations';
import type { FinancialsData } from './laporanTypes';

export interface LaporanTabKeseluruhanProps {
  dailyOps: DailyOperationsData | null;
  dailyOpsError: { endpoint: string; message: string } | null;
  financials: FinancialsData | null;
  financialsError: { endpoint: string; message: string } | null;
  loading: boolean;
  onRetry: () => void;
}

export const LaporanTabKeseluruhan: React.FC<LaporanTabKeseluruhanProps> = ({
  dailyOps,
  dailyOpsError,
  financials,
  financialsError,
  loading,
  onRetry,
}) => {
  const noData = !dailyOps && !financials && !loading;
  const anyError = (dailyOpsError || financialsError) && noData;
  if (loading && noData) return <LoadingState label="Memuat ringkasan laporan..." />;
  if (anyError) {
    return (
      <ErrorState
        message={(dailyOpsError || financialsError)!.message}
        onRetry={onRetry}
      />
    );
  }
  if (!dailyOps && !financials) {
    return <EmptyState title="Belum ada data" message="Pilih periode untuk memuat laporan." />;
  }

  const live = dailyOps?.live_snapshot;
  const biz = dailyOps?.business_date_metrics;
  const incomeTotal = financials?.income?.total ?? 0;
  const expenseTotal = financials?.expense?.total ?? 0;
  const purchaseTotal = financials?.purchase?.total ?? 0;
  const net = incomeTotal - expenseTotal;
  const topExpenseCat = financials?.expense?.by_category?.[0];

  const summaryBars = [
    { label: 'Pemasukan', value: incomeTotal, sublabel: `${financials?.income?.count ?? 0} transaksi` },
    { label: 'Pengeluaran', value: expenseTotal, sublabel: `${financials?.expense?.count ?? 0} transaksi` },
    { label: 'Pembelian', value: purchaseTotal, sublabel: `${financials?.purchase?.count ?? 0} transaksi` },
  ];

  return (
    <div className="space-y-6">
      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          accent="emerald"
          label="Pemasukan"
          value={formatIdr(incomeTotal)}
          sublabel={financials ? `${financials.income.count} transaksi` : '—'}
          emphasis
        />
        <KpiCard label="Pengeluaran" value={formatIdr(expenseTotal)} accent="rose" sublabel={financials ? `${financials.expense.count} transaksi` : '—'} />
        <KpiCard label="Pembelian" value={formatIdr(purchaseTotal)} accent="amber" sublabel={financials ? `${financials.purchase.count} transaksi` : '—'} />
        <KpiCard
          label="Net (Pemasukan − Pengeluaran)"
          value={formatIdr(net)}
          accent={net >= 0 ? 'teal' : 'rose'}
          sublabel={net >= 0 ? 'Positif' : 'Negatif'}
        />
      </div>

      {/* Operational snapshot */}
      {live ? (
        <div>
          <SectionTitle
            title="Operasional Harian"
            hint={`Tanggal hotel: ${dailyOps!.business_date} (Asia/Jakarta)`}
          />
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-white border border-slate-200 rounded-xl p-3">
              <div className="text-[11px] uppercase font-bold text-slate-500">Kedatangan</div>
              <div className="text-xl font-bold text-blue-800 mt-0.5">{biz?.arrivals ?? dailyOps!.lifecycle.arrivals_today}</div>
              <div className="text-[10px] text-slate-400 mt-0.5">Check-in</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-3">
              <div className="text-[11px] uppercase font-bold text-slate-500">Keberangkatan</div>
              <div className="text-xl font-bold text-amber-800 mt-0.5">{biz?.departures ?? dailyOps!.lifecycle.departures_today}</div>
              <div className="text-[10px] text-slate-400 mt-0.5">Check-out</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-3">
              <div className="text-[11px] uppercase font-bold text-slate-500">In-House</div>
              <div className="text-xl font-bold text-emerald-800 mt-0.5">{live.in_house_current}</div>
              <div className="text-[10px] text-slate-400 mt-0.5">Tamu menginap</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-3">
              <div className="text-[11px] uppercase font-bold text-slate-500">Kas Masuk</div>
              <div className="text-xl font-bold text-teal-800 mt-0.5">{formatIdr(biz?.cash_collected ?? dailyOps!.financials.cash_collected_today)}</div>
              <div className="text-[10px] text-slate-400 mt-0.5">Pembayaran sukses</div>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
              <div className="text-[11px] uppercase font-bold text-slate-500">Kamar Aktif</div>
              <div className="text-lg font-bold text-slate-800 mt-0.5">{live.total_active_rooms}</div>
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
              <div className="text-[11px] uppercase font-bold text-amber-700">Piutang Tamu</div>
              <div className="text-lg font-bold text-amber-900 mt-0.5">{formatIdr(live.outstanding_guest_balance_current)}</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-3">
              <div className="text-[11px] uppercase font-bold text-slate-500">Siap Huni</div>
              <div className="text-lg font-bold text-emerald-800 mt-0.5">{live.vacant_ready}</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-3">
              <div className="text-[11px] uppercase font-bold text-slate-500">Kamar Kotor</div>
              <div className="text-lg font-bold text-amber-800 mt-0.5">{live.vacant_dirty}</div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Financial snapshot */}
      {financials ? (
        <div>
          <SectionTitle title="Ringkasan Finansial" hint={`${financials.start_date} s/d ${financials.end_date}`} />
          <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs font-bold text-slate-600 mb-2">Rekap Arus Kas</div>
              <BarList data={summaryBars} valueFormatter={(v) => formatIdr(v)} maxBars={3} emptyMessage="Belum ada transaksi" />
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs font-bold text-slate-600 mb-2">Kategori Pengeluaran Teratas</div>
              {topExpenseCat ? (
                <div>
                  <div className="text-sm font-bold text-slate-900">{topExpenseCat.category_name}</div>
                  <div className="text-xs text-slate-500">{topExpenseCat.category_code} • {topExpenseCat.count} transaksi</div>
                  <div className="text-lg font-bold text-rose-800 mt-1">{formatIdr(topExpenseCat.total)}</div>
                </div>
              ) : (
                <div className="text-xs text-slate-400">Belum ada pengeluaran</div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};
