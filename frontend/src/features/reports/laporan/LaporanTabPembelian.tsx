import React, { useState } from 'react';
import {
  LoadingState,
  ErrorState,
  EmptyState,
  LaporanDropdown,
  formatIdr,
  formatNumber,
} from './laporanUi';
import {
  IconBarChart3,
  IconClock,
  IconFileText,
  IconSearch,
  IconShoppingCart,
} from './LaporanIcons';
import type { AnalyticsHubData, FinancialsData } from './laporanTypes';
import type { LaporanError } from './useLaporanWorkspace';

export interface LaporanTabPembelianProps {
  data: AnalyticsHubData | null;
  financials?: FinancialsData | null;
  loading: boolean;
  error: LaporanError | null;
  onRetry: () => void;
}

export const LaporanTabPembelian: React.FC<LaporanTabPembelianProps> = ({
  data,
  financials,
  loading,
  error,
  onRetry,
}) => {
  const [supplierFilter, setSupplierFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  if (loading && !data) return <LoadingState label="Memuat data pembelian..." />;
  if (error && !data) return <ErrorState message={error.message} onRetry={onRetry} />;
  if (!data) return <EmptyState title="Belum ada data" message="Pilih periode untuk memuat laporan." />;

  const allLines = data.purchase_lines || [];
  const suppliers = Array.from(new Set(allLines.map((l) => l.supplier_name || '-'))).sort();

  const supplierOptions = [
    {
      value: 'all',
      label: 'Laporan Pembelian (Semua Supplier)',
      icon: <IconShoppingCart className="w-3.5 h-3.5" />,
    },
    ...suppliers.map((s) => ({
      value: s,
      label: `Supplier: ${s}`,
      icon: <IconShoppingCart className="w-3.5 h-3.5" />,
    })),
  ];

  const supplierFiltered =
    supplierFilter === 'all'
      ? allLines
      : allLines.filter((l) => (l.supplier_name || '-') === supplierFilter);

  const q = searchQuery.trim().toLowerCase();
  const lines = q
    ? supplierFiltered.filter(
        (l) =>
          String(l.transaction_no || '').toLowerCase().includes(q) ||
          String(l.supplier_name || '').toLowerCase().includes(q) ||
          String(l.item_name || '').toLowerCase().includes(q) ||
          String(l.item_code || '').toLowerCase().includes(q) ||
          String(l.reference_no || '').toLowerCase().includes(q)
      )
    : supplierFiltered;

  const totalValue = lines.reduce((s, l) => s + (Number(l.line_total) || 0), 0);
  const uniqueTxCount = new Set(lines.map((l) => String(l.transaction_id))).size;
  const avgPerTx = uniqueTxCount > 0 ? Math.round(totalValue / uniqueTxCount) : 0;
  const unpaidTotal = financials?.purchase?.unpaid_total ?? 0;

  return (
    <div className="space-y-4">
      {/* Top Filter & Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <LaporanDropdown<string>
            value={supplierFilter}
            options={supplierOptions}
            onChange={setSupplierFilter}
            variant="primary"
          />
        </div>

        <div className="flex-1 max-w-md relative">
          <IconSearch className="w-3.5 h-3.5 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Cari BID, supplier, produk..."
            className="w-full border border-slate-300 bg-white rounded-lg pl-9 pr-3.5 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-hidden focus:ring-1 focus:ring-emerald-600"
          />
        </div>
      </div>

      {/* 4 KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs flex items-center justify-between">
          <div>
            <div className="text-xs text-slate-500 font-medium">Total Transaksi</div>
            <div className="text-2xl font-extrabold text-slate-900 mt-1 tabular-nums">
              {formatNumber(uniqueTxCount || lines.length)}
            </div>
          </div>
          <span className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80 text-slate-500">
            <IconShoppingCart className="w-4 h-4" />
          </span>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs flex items-center justify-between">
          <div>
            <div className="text-xs text-slate-500 font-medium">Total Pembelian</div>
            <div className="text-2xl font-extrabold text-orange-600 mt-1 tabular-nums">
              {formatIdr(totalValue)}
            </div>
          </div>
          <span className="p-2.5 rounded-xl bg-orange-50 border border-orange-200/80 text-orange-600">
            <IconShoppingCart className="w-4 h-4" />
          </span>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs flex items-center justify-between">
          <div>
            <div className="text-xs text-slate-500 font-medium">Rata-rata per Transaksi</div>
            <div className="text-2xl font-extrabold text-slate-900 mt-1 tabular-nums">
              {formatIdr(avgPerTx)}
            </div>
          </div>
          <span className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80 text-slate-500">
            <IconBarChart3 className="w-4 h-4" />
          </span>
        </div>

        <div className="bg-rose-50/50 border border-rose-200 rounded-xl p-4 shadow-xs flex items-center justify-between">
          <div>
            <div className="text-xs text-rose-700 font-semibold">Hutang Belum Lunas (AP)</div>
            <div className="text-2xl font-extrabold text-rose-900 mt-1 tabular-nums">
              {formatIdr(unpaidTotal)}
            </div>
          </div>
          <span className="p-2.5 rounded-xl bg-rose-100/70 border border-rose-200 text-rose-600">
            <IconClock className="w-4 h-4" />
          </span>
        </div>
      </div>

      {/* Detail Table */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
          <table className="min-w-full text-xs divide-y divide-slate-200">
            <thead className="sticky top-0 z-10 bg-slate-50 text-slate-600 font-semibold text-[11px] border-b border-slate-200">
              <tr>
                <th className="py-3 px-3.5 text-left">BID</th>
                <th className="py-3 px-3.5 text-left">Tanggal</th>
                <th className="py-3 px-3.5 text-left">Supplier</th>
                <th className="py-3 px-3.5 text-left">Item</th>
                <th className="py-3 px-3.5 text-right">Jumlah</th>
                <th className="py-3 px-3.5 text-right">Total</th>
                <th className="py-3 px-3.5 text-left">Metode Bayar</th>
                <th className="py-3 px-3.5 text-left">Nota</th>
                <th className="py-3 px-3.5 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
              {lines.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-slate-400">
                    Tidak ada data pembelian pada periode ini
                  </td>
                </tr>
              ) : (
                lines.map((l, idx) => {
                  const isSelesai = String(l.workflow_status || '').toUpperCase() === 'SELESAI';
                  return (
                    <tr
                      key={`${l.transaction_id}-${idx}`}
                      className="hover:bg-slate-50/80 transition-colors"
                    >
                      <td className="py-2.5 px-3.5 font-mono text-[11px] text-blue-700 font-semibold">
                        {l.transaction_no}
                      </td>
                      <td className="py-2.5 px-3.5 text-slate-600 whitespace-nowrap">
                        {l.transaction_date}
                      </td>
                      <td className="py-2.5 px-3.5 text-slate-700">{l.supplier_name || '-'}</td>
                      <td className="py-2.5 px-3.5">
                        <div className="font-semibold text-slate-900">
                          {l.item_name}
                          {l.unit ? ` (${l.unit.toLowerCase()})` : ''}
                        </div>
                        {l.item_code ? (
                          <div className="text-[10px] text-slate-400 font-mono">{l.item_code}</div>
                        ) : null}
                      </td>
                      <td className="py-2.5 px-3.5 text-right tabular-nums">{Number(l.quantity) || 0}</td>
                      <td className="py-2.5 px-3.5 text-right font-semibold tabular-nums text-slate-900">
                        {formatIdr(l.line_total)}
                      </td>
                      <td className="py-2.5 px-3.5">{l.payment_method || '-'}</td>
                      <td className="py-2.5 px-3.5">
                        {Number(l.attachment_count) > 0 ? (
                          <span className="text-blue-600 font-semibold text-[11px] inline-flex items-center gap-1">
                            <IconFileText className="w-3.5 h-3.5" /> Ada ({l.attachment_count})
                          </span>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3.5">
                        <span
                          className={`text-[10px] px-2.5 py-0.5 rounded-full font-semibold ${
                            isSelesai
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {isSelesai ? 'Selesai' : 'Proses'}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-200 text-xs text-slate-500 flex items-center justify-between">
          <span>Menampilkan {lines.length} dari {allLines.length} data</span>
        </div>
      </div>
    </div>
  );
};
