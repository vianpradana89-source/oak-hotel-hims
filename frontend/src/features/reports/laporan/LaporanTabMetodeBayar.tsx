import React, { useState } from 'react';
import {
  SectionTitle,
  LoadingState,
  ErrorState,
  EmptyState,
  LaporanDropdown,
  formatIdr,
  formatNumber,
} from './laporanUi';
import { IconCreditCard } from './LaporanIcons';
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
  const [methodFilter, setMethodFilter] = useState<string>('all');

  if (loading && !data) return <LoadingState label="Memuat rekap metode pembayaran..." />;
  if (error && !data) return <ErrorState message={error.message} onRetry={onRetry} />;
  if (!data) return <EmptyState title="Belum ada data" message="Pilih periode untuk memuat laporan." />;

  const allSummary = data.payment_method_summary || [];
  const methodOptions = [
    {
      value: 'all',
      label: 'Laporan Metode Pembayaran (Semua Metode)',
      icon: <IconCreditCard className="w-3.5 h-3.5" />,
    },
    ...allSummary.map((m) => ({
      value: m.method,
      label: m.method,
      icon: <IconCreditCard className="w-3.5 h-3.5" />,
    })),
  ];

  const summary =
    methodFilter === 'all'
      ? allSummary
      : allSummary.filter((m) => m.method === methodFilter);

  const grandTotal = summary.reduce((s, m) => s + Number(m.grand_total || 0), 0);
  const grandCount = summary.reduce((s, m) => s + Number(m.grand_count || 0), 0);
  const maxGrand = summary.length > 0 ? Math.max(...summary.map((m) => Number(m.grand_total) || 0)) : 0;

  return (
    <div className="space-y-5">
      {/* Header & Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <LaporanDropdown<string>
          value={methodFilter}
          options={methodOptions}
          onChange={setMethodFilter}
          variant="primary"
        />
        <div className="text-xs text-slate-500">
          Periode: {data.start_date} s/d {data.end_date}
        </div>
      </div>

      {/* Grand Total Banner (Gaya Anka Management) */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex items-center justify-between">
        <div>
          <div className="text-xs font-medium text-slate-500">Grand Total Semua Metode</div>
          <div className="text-3xl font-extrabold text-blue-700 mt-1 tabular-nums">
            {formatIdr(grandTotal)}
          </div>
          <div className="text-xs text-slate-400 mt-1">
            {summary.length} metode pembayaran • {formatNumber(grandCount)} transaksi
          </div>
        </div>
        <span className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-slate-500">
          <IconCreditCard className="w-6 h-6" />
        </span>
      </div>

      {/* Cards Grid per Metode Pembayaran */}
      {summary.length === 0 ? (
        <EmptyState
          title="Belum ada transaksi metode pembayaran"
          message="Tidak ditemukan transaksi pada periode yang dipilih."
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {summary.map((m) => {
            const sharePct = grandTotal > 0 ? ((Number(m.grand_total) / grandTotal) * 100).toFixed(1) : '0.0';
            const bookingCount = m.booking_count ?? 0;
            const posCount = m.pos_count ?? 0;
            const incomeCount = m.income_count ?? 0;
            const purchaseCount = m.purchase_count ?? 0;
            const expenseCount = m.expense_count ?? 0;

            return (
              <div
                key={m.method}
                className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col justify-between hover:border-emerald-300 transition-colors"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <span className="text-sm font-bold text-slate-900">{m.method}</span>
                      {m.method === 'OTA COLLECT' && (
                        <div className="text-[11px] font-medium text-indigo-700 mt-0.5">
                          Pembayaran ditanggung penuh oleh OTA
                        </div>
                      )}
                      {m.method === 'BELUM BAYAR / PIUTANG' && (
                        <div className="text-[11px] font-medium text-amber-700 mt-0.5">
                          Transaksi belum lunas / metode bayar belum tercatat
                        </div>
                      )}
                    </div>
                    <span className="p-2 rounded-lg bg-slate-50 border border-slate-200/80 text-slate-500 shrink-0">
                      <IconCreditCard className="w-4 h-4" />
                    </span>
                  </div>
                  <div className="text-2xl font-extrabold text-slate-900 mt-2 tabular-nums">
                    {formatIdr(m.grand_total)}
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-[11px] bg-slate-100 text-slate-700 px-2.5 py-0.5 rounded-full font-semibold">
                      {formatNumber(m.grand_count)} transaksi
                    </span>
                    <span className="text-[11px] bg-blue-50 text-blue-700 px-2.5 py-0.5 rounded-full font-semibold">
                      {sharePct}%
                    </span>
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-slate-100 space-y-1.5 text-xs">
                  <div className="flex items-center justify-between text-slate-500">
                    <span>Booking Kamar:</span>
                    <span className="font-semibold text-slate-700 tabular-nums">
                      {bookingCount} ({formatIdr(m.booking_total)})
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-slate-500">
                    <span>POS & F&B:</span>
                    <span className="font-semibold text-slate-700 tabular-nums">
                      {posCount} ({formatIdr(m.pos_total)})
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-slate-500">
                    <span>Pemasukan Lain:</span>
                    <span className="font-semibold text-slate-700 tabular-nums">
                      {incomeCount} ({formatIdr(m.income_total)})
                    </span>
                  </div>
                  {(m.purchase_total > 0 || m.expense_total > 0) && (
                    <div className="flex items-center justify-between text-slate-500">
                      <span>Pengeluaran & Pembelian:</span>
                      <span className="font-semibold text-rose-700 tabular-nums">
                        {purchaseCount + expenseCount} ({formatIdr(m.purchase_total + m.expense_total)})
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Per-method breakdown table */}
      <div>
        <SectionTitle
          title="Tabel Rekapitulasi Metode Pembayaran"
          hint="Agregat lintas tipe transaksi: Booking Kamar, POS, Pemasukan, Pembelian, Pengeluaran"
        />
        <div className="mt-2 bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
          <div className="overflow-auto max-h-[calc(100vh-270px)]">
            <table className="min-w-full text-xs divide-y divide-slate-200">
              <thead className="sticky top-0 z-20 bg-slate-50 text-slate-600 font-semibold uppercase tracking-wider text-[11px] border-b border-slate-200 shadow-2xs">
                <tr>
                  <th className="py-2.5 px-3.5 text-left">Metode Bayar</th>
                  <th className="py-2.5 px-3.5 text-right">Booking Kamar</th>
                  <th className="py-2.5 px-3.5 text-right">POS F&B</th>
                  <th className="py-2.5 px-3.5 text-right">Pemasukan</th>
                  <th className="py-2.5 px-3.5 text-right">Pembelian</th>
                  <th className="py-2.5 px-3.5 text-right">Pengeluaran</th>
                  <th className="py-2.5 px-3.5 text-right">Grand Total</th>
                  <th className="py-2.5 px-3.5 text-right">Transaksi</th>
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
                        <td className="py-2.5 px-3.5">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-slate-900 w-32 shrink-0">{m.method}</span>
                            <div className="flex-1 bg-slate-100 rounded-full h-1.5 overflow-hidden min-w-[70px]">
                              <div
                                className="bg-emerald-600 h-full rounded-full"
                                style={{ width: `${Math.max(2, pct)}%` }}
                              />
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 px-3.5 text-right tabular-nums text-slate-600">
                          {formatIdr(m.booking_total)}
                        </td>
                        <td className="py-2.5 px-3.5 text-right tabular-nums text-slate-600">
                          {formatIdr(m.pos_total)}
                        </td>
                        <td className="py-2.5 px-3.5 text-right tabular-nums text-slate-600">
                          {formatIdr(m.income_total)}
                        </td>
                        <td className="py-2.5 px-3.5 text-right tabular-nums text-slate-600">
                          {formatIdr(m.purchase_total)}
                        </td>
                        <td className="py-2.5 px-3.5 text-right tabular-nums text-slate-600">
                          {formatIdr(m.expense_total)}
                        </td>
                        <td className="py-2.5 px-3.5 text-right font-bold text-slate-900 tabular-nums">
                          {formatIdr(m.grand_total)}
                        </td>
                        <td className="py-2.5 px-3.5 text-right text-slate-500 tabular-nums">
                          {m.grand_count}
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
    </div>
  );
};
