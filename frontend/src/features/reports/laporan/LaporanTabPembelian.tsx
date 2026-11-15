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
import type { AnalyticsHubData } from './laporanTypes';
import type { LaporanError } from './useLaporanWorkspace';

export interface LaporanTabPembelianProps {
  data: AnalyticsHubData | null;
  loading: boolean;
  error: LaporanError | null;
  onRetry: () => void;
}

export const LaporanTabPembelian: React.FC<LaporanTabPembelianProps> = ({
  data,
  loading,
  error,
  onRetry,
}) => {
  const [supplierFilter, setSupplierFilter] = useState<string>('all');

  if (loading && !data) return <LoadingState label="Memuat data pembelian..." />;
  if (error && !data) return <ErrorState message={error.message} onRetry={onRetry} />;
  if (!data) return <EmptyState title="Belum ada data" message="Pilih periode untuk memuat laporan." />;

  const allLines = data.purchase_lines || [];
  const suppliers = Array.from(new Set(allLines.map((l) => l.supplier_name || '-'))).sort();

  const lines = supplierFilter === 'all'
    ? allLines
    : allLines.filter((l) => (l.supplier_name || '-') === supplierFilter);

  const totalValue = lines.reduce((s, l) => s + (Number(l.line_total) || 0), 0);
  const uniqueTx = new Set(lines.map((l) => String(l.transaction_id))).size;
  const uniqueSuppliers = new Set(lines.map((l) => l.supplier_name || '-')).size;
  const withAttachment = lines.filter((l) => Number(l.attachment_count) > 0).length;

  const bySupplierMap = new Map<string, number>();
  for (const l of lines) {
    const key = l.supplier_name || '-';
    bySupplierMap.set(key, (bySupplierMap.get(key) || 0) + (Number(l.line_total) || 0));
  }
  const bySupplier = Array.from(bySupplierMap.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);

  return (
    <div className="space-y-6">
      {/* KPI */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          accent="emerald"
          label="Total Nilai Pembelian"
          value={formatIdr(totalValue)}
          sublabel={`${lines.length} baris item`}
          emphasis
        />
        <KpiCard label="Transaksi" value={formatNumber(uniqueTx)} accent="blue" sublabel="Dokumen pembelian" />
        <KpiCard label="Supplier" value={formatNumber(uniqueSuppliers)} accent="slate" sublabel="Vendor terlibat" />
        <KpiCard
          label="Berlampiran"
          value={formatNumber(withAttachment)}
          accent="teal"
          sublabel="Baris dengan bukti"
        />
      </div>

      {/* Supplier breakdown */}
      <div>
        <SectionTitle
          title="Pembelian per Supplier"
          right={
            <select
              value={supplierFilter}
              onChange={(e) => setSupplierFilter(e.target.value)}
              className="border border-slate-300 rounded-lg px-3 py-1.5 text-xs bg-white font-medium focus:outline-hidden focus:ring-1 focus:ring-emerald-600"
            >
              <option value="all">Semua Supplier</option>
              {suppliers.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          }
        />
        <div className="mt-2 bg-white border border-slate-200 rounded-xl shadow-sm p-4">
          <BarList
            data={bySupplier}
            emptyMessage="Belum ada pembelian di periode ini"
            valueFormatter={(v) => formatIdr(v)}
            maxBars={8}
          />
        </div>
      </div>

      {/* Detail table */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-700">
          Detail Pembelian ({lines.length} baris)
        </div>
        <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
          <table className="min-w-full text-xs divide-y divide-slate-200">
            <thead className="sticky top-0 z-10 bg-slate-100 text-slate-700 font-semibold uppercase tracking-wider text-[11px] border-b border-slate-200">
              <tr>
                <th className="py-2.5 px-3 text-left">Tanggal</th>
                <th className="py-2.5 px-3 text-left">No. Transaksi</th>
                <th className="py-2.5 px-3 text-left">Supplier</th>
                <th className="py-2.5 px-3 text-left">Item</th>
                <th className="py-2.5 px-3 text-right">Qty</th>
                <th className="py-2.5 px-3 text-left">Satuan</th>
                <th className="py-2.5 px-3 text-right">Harga</th>
                <th className="py-2.5 px-3 text-right">Total</th>
                <th className="py-2.5 px-3 text-left">Bayar</th>
                <th className="py-2.5 px-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
              {lines.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-6 text-center text-slate-400">
                    Tidak ada data pembelian pada periode ini
                  </td>
                </tr>
              ) : (
                lines.map((l, idx) => (
                  <tr
                    key={`${l.transaction_id}-${idx}`}
                    className="hover:bg-slate-50/80 transition-colors"
                  >
                    <td className="py-2 px-3">{l.transaction_date}</td>
                    <td className="py-2 px-3 font-mono text-[11px]">{l.transaction_no}</td>
                    <td className="py-2 px-3">{l.supplier_name}</td>
                    <td className="py-2 px-3">
                      <div className="font-semibold text-slate-900">{l.item_name}</div>
                      {l.item_code ? (
                        <div className="text-[10px] text-slate-400 font-mono">{l.item_code}</div>
                      ) : null}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">{l.quantity}</td>
                    <td className="py-2 px-3">{l.unit}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{formatNumber(l.unit_price)}</td>
                    <td className="py-2 px-3 text-right font-semibold tabular-nums text-slate-900">
                      {formatNumber(l.line_total)}
                    </td>
                    <td className="py-2 px-3">{l.payment_method}</td>
                    <td className="py-2 px-3">
                      <span className="text-[10px] bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded font-semibold">
                        {l.workflow_status}
                      </span>
                      <span className="ml-1 text-[10px] text-slate-500">{l.payment_status}</span>
                    </td>
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
