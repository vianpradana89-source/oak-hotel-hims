import React from 'react';
import { SectionTitle, LoadingState, ErrorState, EmptyState, formatIdr, formatNumber } from './laporanUi';
import type { FinancialsData } from './laporanTypes';
import type { LaporanError } from './useLaporanWorkspace';

export interface LaporanTabMetodeBayarProps {
  data: FinancialsData | null;
  loading: boolean;
  error: LaporanError | null;
  onRetry: () => void;
}

export const LaporanTabMetodeBayar: React.FC<LaporanTabMetodeBayarProps> = ({
  data,
  loading,
  error,
  onRetry,
}) => {
  if (loading && !data) return <LoadingState label="Memuat rekap metode bayar..." />;
  if (error && !data) return <ErrorState message={error.message} onRetry={onRetry} />;
  if (!data) return <EmptyState title="Belum ada data" message="Pilih periode untuk memuat laporan." />;

  const summary = data.payment_method_summary || [];
  const grandTotal = summary.reduce((s, m) => s + Number(m.grand_total || 0), 0);
  const grandCount = summary.reduce((s, m) => s + Number(m.grand_count || 0), 0);

  const maxGrand = summary.length > 0 ? Math.max(...summary.map((m) => Number(m.grand_total) || 0)) : 0;

  return (
    <div className="space-y-6">
      {/* Banner */}
      <div className="bg-emerald-900 text-white border border-emerald-950 rounded-xl p-4 shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase font-bold text-emerald-200 tracking-wide">
              Total Nilai Transaksi (Semua Metode)
            </div>
            <div className="text-3xl font-extrabold mt-1 text-emerald-50">{formatIdr(grandTotal)}</div>
            <div className="text-[10px] text-emerald-300 mt-1">{grandCount} transaksi tercatat</div>
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase font-bold text-emerald-200">Metode Terdeteksi</div>
            <div className="text-2xl font-bold text-emerald-50 mt-1">{summary.length}</div>
          </div>
        </div>
      </div>

      {/* Per-method breakdown table */}
      <div>
        <SectionTitle
          title="Rekap per Metode Pembayaran"
          hint="Agregat lintas tipe transaksi: booking, POS, income, purchase, expense"
        />
        <div className="mt-2 bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs divide-y divide-slate-200">
              <thead className="bg-slate-50 text-slate-600 font-semibold uppercase tracking-wider text-[11px] border-b border-slate-200">
                <tr>
                  <th className="py-2.5 px-3 text-left">Metode</th>
                  <th className="py-2.5 px-3 text-right">Booking</th>
                  <th className="py-2.5 px-3 text-right">POS</th>
                  <th className="py-2.5 px-3 text-right">Income</th>
                  <th className="py-2.5 px-3 text-right">Purchase</th>
                  <th className="py-2.5 px-3 text-right">Expense</th>
                  <th className="py-2.5 px-3 text-right">Grand Total</th>
                  <th className="py-2.5 px-3 text-right">Jml</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                {summary.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-6 text-center text-slate-400">
                      Belum ada data metode pembayaran di periode ini
                    </td>
                  </tr>
                ) : (
                  summary.map((m) => {
                    const pct = maxGrand > 0 ? Math.round((Number(m.grand_total) / maxGrand) * 100) : 0;
                    return (
                      <tr key={m.method} className="hover:bg-slate-50/80 transition-colors">
                        <td className="py-2.5 px-3">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-slate-900 w-28 shrink-0">{m.method}</span>
                            <div className="flex-1 bg-slate-100 rounded-full h-1.5 overflow-hidden min-w-[80px]">
                              <div className="bg-emerald-600 h-full rounded-full" style={{ width: `${Math.max(2, pct)}%` }} />
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-slate-600">{formatNumber(m.booking_total)}</td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-slate-600">{formatNumber(m.pos_total)}</td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-slate-600">{formatNumber(m.income_total)}</td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-slate-600">{formatNumber(m.purchase_total)}</td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-slate-600">{formatNumber(m.expense_total)}</td>
                        <td className="py-2.5 px-3 text-right font-bold text-slate-900 tabular-nums">{formatIdr(m.grand_total)}</td>
                        <td className="py-2.5 px-3 text-right text-slate-500 tabular-nums">{m.grand_count}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
