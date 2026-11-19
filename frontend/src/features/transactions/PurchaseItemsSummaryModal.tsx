import React, { useEffect, useState } from 'react';
import { authenticatedFetch } from '../../lib/authenticatedFetch';

interface PurchaseItemLine {
  id: number | string;
  item_name: string;
  quantity: number;
  unit: string;
  unit_price: number;
  line_total: number;
}

interface PurchaseItemsSummaryData {
  transaction_no: string;
  supplier_name: string;
  tx_date: string;
  total_amount: number;
  warehouse_code: string;
  notes?: string;
  items: PurchaseItemLine[];
}

export interface PurchaseItemsSummaryModalProps {
  payableId: string | null;
  transactionNo?: string;
  supplierName?: string;
  onClose: () => void;
}

function formatIdr(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(amount);
}

export const PurchaseItemsSummaryModal: React.FC<PurchaseItemsSummaryModalProps> = ({
  payableId,
  onClose,
}) => {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<PurchaseItemsSummaryData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!payableId) return;
    let isCancelled = false;
    setLoading(true);
    setError(null);
    setData(null);

    authenticatedFetch(`/api/reports/accounting/payables/${encodeURIComponent(payableId)}/items`)
      .then((res) => res.json())
      .then((json) => {
        if (isCancelled) return;
        if (json.status === 'SUCCESS' && json.data) {
          setData(json.data);
        } else {
          setError(json.message || 'Gagal memuat rincian pembelian');
        }
      })
      .catch((err) => {
        if (isCancelled) return;
        setError(err.message || 'Gagal memuat rincian pembelian');
      })
      .finally(() => {
        if (!isCancelled) setLoading(false);
      });

    return () => {
      isCancelled = true;
    };
  }, [payableId]);

  if (!payableId) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-2xl w-full overflow-hidden flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-[#FDFBF7]">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-600" />
              <h3 className="text-sm font-extrabold text-slate-900">
                Ringkasan Pembelian {data?.transaction_no || payableId}
              </h3>
            </div>
            {data && (
              <p className="text-xs text-slate-500">
                Supplier: <span className="font-semibold text-slate-700">{data.supplier_name}</span> • Tgl: {data.tx_date} • Gudang: <span className="font-mono font-bold text-emerald-800 bg-emerald-50 px-1.5 py-0.5 rounded">{data.warehouse_code}</span>
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 transition cursor-pointer"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-auto flex-1">
          {loading ? (
            <div className="py-12 text-center text-slate-400 text-xs flex flex-col items-center gap-2">
              <div className="w-6 h-6 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
              <span>Memuat rincian item pembelian...</span>
            </div>
          ) : error ? (
            <div className="py-12 text-center text-rose-500 text-xs font-semibold">{error}</div>
          ) : data ? (
            <div className="space-y-4">
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 text-slate-700 border-b border-slate-200 text-left">
                      <th className="py-2.5 px-3 font-bold w-10 text-center">#</th>
                      <th className="py-2.5 px-3 font-bold">Nama Barang / Deskripsi</th>
                      <th className="py-2.5 px-3 font-bold text-right w-20">Qty</th>
                      <th className="py-2.5 px-3 font-bold text-center w-20">Satuan</th>
                      <th className="py-2.5 px-3 font-bold text-right w-28">Harga Satuan</th>
                      <th className="py-2.5 px-3 font-bold text-right w-32">Subtotal</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.items.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-6 text-center text-slate-400">
                          Tidak ada rincian item.
                        </td>
                      </tr>
                    ) : (
                      data.items.map((it, idx) => (
                        <tr key={it.id} className="hover:bg-slate-50/50">
                          <td className="py-2.5 px-3 text-center text-slate-400 font-mono">{idx + 1}</td>
                          <td className="py-2.5 px-3 font-medium text-slate-800">{it.item_name}</td>
                          <td className="py-2.5 px-3 text-right font-mono font-semibold text-slate-700">
                            {it.quantity}
                          </td>
                          <td className="py-2.5 px-3 text-center text-slate-500 font-mono uppercase text-[11px]">
                            {it.unit}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono text-slate-600">
                            {formatIdr(it.unit_price)}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-900">
                            {formatIdr(it.line_total)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                  <tfoot>
                    <tr className="bg-emerald-50/60 border-t border-emerald-200 font-bold text-slate-900">
                      <td colSpan={5} className="py-3 px-3 text-right text-emerald-900">
                        Total Tagihan Pembelian:
                      </td>
                      <td className="py-3 px-3 text-right font-mono text-sm text-emerald-900">
                        {formatIdr(data.total_amount)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {data.notes && (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs text-slate-600">
                  <span className="font-semibold text-slate-700">Keterangan / Catatan: </span>
                  {data.notes}
                </div>
              )}
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-100 bg-slate-50 flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-bold text-slate-700 bg-white hover:bg-slate-100 border border-slate-300 transition cursor-pointer"
          >
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
};
