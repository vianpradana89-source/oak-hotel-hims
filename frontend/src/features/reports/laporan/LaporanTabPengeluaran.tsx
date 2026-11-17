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
  IconFileText,
  IconSearch,
  IconTrendingDown,
} from './LaporanIcons';
import type { FinancialsData, TransactionReportItemRow } from './laporanTypes';
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
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  if (loading && !data) return <LoadingState label="Memuat data pengeluaran..." />;
  if (error && !data) return <ErrorState message={error.message} onRetry={onRetry} />;
  if (!data) return <EmptyState title="Belum ada data" message="Pilih periode untuk memuat laporan." />;

  const expense = data.expense;
  const allItems: TransactionReportItemRow[] = expense?.items || [];
  const byCategory = expense?.by_category || [];
  const categories = Array.from(new Set(allItems.map((i) => i.category_name || 'Lainnya')));

  const categoryOptions = [
    {
      value: 'all',
      label: 'Laporan Pengeluaran (Semua Kategori)',
      icon: <IconTrendingDown className="w-3.5 h-3.5" />,
    },
    ...categories.map((c) => ({
      value: c,
      label: c,
      icon: <IconTrendingDown className="w-3.5 h-3.5" />,
    })),
  ];

  const catFiltered =
    categoryFilter === 'all'
      ? allItems
      : allItems.filter((i) => (i.category_name || 'Lainnya') === categoryFilter);

  const q = searchQuery.trim().toLowerCase();
  const filteredItems = q
    ? catFiltered.filter(
        (i) =>
          String(i.transaction_no || '').toLowerCase().includes(q) ||
          String(i.description || '').toLowerCase().includes(q) ||
          String(i.category_name || '').toLowerCase().includes(q) ||
          String(i.department_code || '').toLowerCase().includes(q) ||
          String(i.payment_method || '').toLowerCase().includes(q) ||
          String(i.created_by || '').toLowerCase().includes(q)
      )
    : catFiltered;

  const totalTx = filteredItems.length;
  const totalAmount = filteredItems.reduce((s, i) => s + (Number(i.net_amount) || 0), 0);

  return (
    <div className="space-y-4">
      {/* Filter & Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <LaporanDropdown<string>
            value={categoryFilter}
            options={categoryOptions}
            onChange={setCategoryFilter}
            variant="primary"
          />
        </div>

        <div className="flex-1 max-w-md relative">
          <IconSearch className="w-3.5 h-3.5 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Cari ID, deskripsi, kategori..."
            className="w-full border border-slate-300 bg-white rounded-lg pl-9 pr-3.5 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-hidden focus:ring-1 focus:ring-emerald-600"
          />
        </div>
      </div>

      {/* 3 Top Cards (Total Transaksi, Total Pengeluaran, Per Kategori) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-slate-500 font-medium">Total Transaksi</div>
          <div className="text-2xl font-extrabold text-slate-900 mt-1 tabular-nums">
            {formatNumber(totalTx)}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-slate-500 font-medium">Total Pengeluaran</div>
          <div className="text-2xl font-extrabold text-rose-600 mt-1 tabular-nums">
            {formatIdr(totalAmount)}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-slate-500 font-medium mb-2">Per Kategori</div>
          {byCategory.length === 0 ? (
            <div className="text-xs text-slate-400">Belum ada pengeluaran di periode ini</div>
          ) : (
            <div className="flex flex-wrap gap-1.5 max-h-16 overflow-y-auto">
              {byCategory.map((c) => (
                <button
                  key={c.category_code}
                  type="button"
                  onClick={() =>
                    setCategoryFilter((prev) =>
                      prev === c.category_name ? 'all' : c.category_name
                    )
                  }
                  className={`text-[11px] px-2.5 py-1 rounded-full font-medium transition-colors cursor-pointer ${
                    categoryFilter === c.category_name
                      ? 'bg-emerald-900 text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  {c.category_name}: <span className="font-bold">{formatIdr(c.total)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Detailed Pengeluaran Table */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
          <table className="min-w-full text-xs divide-y divide-slate-200">
            <thead className="sticky top-0 z-10 bg-slate-50 text-slate-600 font-semibold text-[11px] border-b border-slate-200">
              <tr>
                <th className="py-3 px-3.5 text-left">No. ID</th>
                <th className="py-3 px-3.5 text-left">Tanggal</th>
                <th className="py-3 px-3.5 text-left">Deskripsi</th>
                <th className="py-3 px-3.5 text-left">Kategori</th>
                <th className="py-3 px-3.5 text-right">Jumlah</th>
                <th className="py-3 px-3.5 text-left">Metode Bayar</th>
                <th className="py-3 px-3.5 text-left">Bukti Nota</th>
                <th className="py-3 px-3.5 text-left">Bukti Bayar</th>
                <th className="py-3 px-3.5 text-left">Status</th>
                <th className="py-3 px-3.5 text-left">Dibuat Oleh</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
              {filteredItems.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-8 text-center text-slate-400">
                    Tidak ada data pengeluaran pada periode ini
                  </td>
                </tr>
              ) : (
                filteredItems.map((item) => {
                  const isSelesai = String(item.operational_status).toLowerCase() === 'selesai';
                  return (
                    <tr key={item.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="py-2.5 px-3.5 font-mono text-[11px] text-blue-700 font-semibold">
                        {item.transaction_no}
                      </td>
                      <td className="py-2.5 px-3.5 text-slate-600 whitespace-nowrap">
                        {item.transaction_date}
                      </td>
                      <td className="py-2.5 px-3.5 text-slate-800 max-w-xs truncate" title={item.description}>
                        {item.description}
                      </td>
                      <td className="py-2.5 px-3.5 text-slate-600">{item.category_name}</td>
                      <td className="py-2.5 px-3.5 text-right font-bold tabular-nums text-rose-600">
                        {formatIdr(item.net_amount)}
                      </td>
                      <td className="py-2.5 px-3.5">{item.payment_method || '-'}</td>
                      <td className="py-2.5 px-3.5">
                        {item.nota_attachment_id ? (
                          <a
                            href={`/api/transactions/${item.id}/attachments/${item.nota_attachment_id}/file?property_id=${data.property_id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-600 hover:underline font-semibold inline-flex items-center gap-1"
                          >
                            <IconFileText className="w-3.5 h-3.5" /> Lihat
                          </a>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3.5">
                        {item.bayar_attachment_id ? (
                          <a
                            href={`/api/transactions/${item.id}/attachments/${item.bayar_attachment_id}/file?property_id=${data.property_id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-600 hover:underline font-semibold inline-flex items-center gap-1"
                          >
                            <IconFileText className="w-3.5 h-3.5" /> Lihat
                          </a>
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
                          {item.operational_status}
                        </span>
                      </td>
                      <td className="py-2.5 px-3.5 text-slate-600">{item.created_by || '-'}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-200 text-xs text-slate-500 flex items-center justify-between">
          <span>Menampilkan {filteredItems.length} dari {allItems.length} data</span>
        </div>
      </div>
    </div>
  );
};
