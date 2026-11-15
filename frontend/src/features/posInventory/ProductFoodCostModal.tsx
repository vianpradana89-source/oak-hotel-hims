/**
 * OAK HIMS — MP-04E Product Food Cost Breakdown Modal
 * Menampilkan rincian kalkulasi HPP dan porsi biaya bahan baku per menu
 */

import { useState, useEffect } from 'react';
import { fetchProductFoodCostAnalysis } from './posFoodCostApi';
import type { ProductFoodCostAnalysis } from './posFoodCostApi';

interface Props {
  productId: number;
  propertyId: number;
  onClose: () => void;
}

function formatIDR(val: number): string {
  return 'Rp ' + Math.round(val).toLocaleString('id-ID');
}

export default function ProductFoodCostModal({ productId, propertyId, onClose }: Props) {
  const [data, setData] = useState<ProductFoodCostAnalysis | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    async function load() {
      try {
        setLoading(true);
        setError(null);
        const result = await fetchProductFoodCostAnalysis(productId, propertyId);
        if (isMounted) setData(result);
      } catch (err: any) {
        if (isMounted) setError(err.message || 'Gagal memuat rincian food cost');
      } finally {
        if (isMounted) setLoading(false);
      }
    }
    load();
    return () => {
      isMounted = false;
    };
  }, [productId, propertyId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs">
      <div className="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl border border-stone-200 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-100 bg-[#1b4332] text-white">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🍳</span>
            <div>
              <h2 className="text-base font-bold text-amber-300">Rincian Food Cost &amp; HPP Menu</h2>
              <p className="text-xs text-stone-200">
                {data ? `${data.product_name} (${data.item_code || 'No SKU'})` : 'Memuat data...'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-white/10 text-stone-300 hover:text-white transition-colors cursor-pointer"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto space-y-6">
          {loading && (
            <div className="py-12 text-center text-stone-500">
              <div className="animate-spin inline-block w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full mb-2"></div>
              <p className="text-xs">Menghitung HPP &amp; porsi bahan baku...</p>
            </div>
          )}

          {error && (
            <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs">
              <p className="font-bold mb-1">Gagal Menghitung Food Cost</p>
              <p>{error}</p>
            </div>
          )}

          {!loading && !error && data && (
            <>
              {/* Metric Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3 bg-stone-50 rounded-xl border border-stone-200">
                  <span className="text-[11px] font-semibold text-stone-500 uppercase block">Harga Jual</span>
                  <span className="text-base font-bold text-stone-800">{formatIDR(data.selling_price)}</span>
                </div>
                <div className="p-3 bg-emerald-50 rounded-xl border border-emerald-200">
                  <span className="text-[11px] font-semibold text-emerald-700 uppercase block">Total HPP (COGS)</span>
                  <span className="text-base font-bold text-emerald-900">{formatIDR(data.hpp)}</span>
                </div>
                <div className="p-3 bg-blue-50 rounded-xl border border-blue-200">
                  <span className="text-[11px] font-semibold text-blue-700 uppercase block">Gross Profit</span>
                  <span className="text-base font-bold text-blue-900">{formatIDR(data.gross_profit)}</span>
                </div>
                <div
                  className={`p-3 rounded-xl border ${
                    data.classification === 'LOW_COST'
                      ? 'bg-emerald-50 border-emerald-300'
                      : data.classification === 'HEALTHY'
                      ? 'bg-blue-50 border-blue-300'
                      : data.classification === 'OVER_COST'
                      ? 'bg-rose-50 border-rose-300'
                      : 'bg-stone-50 border-stone-300'
                  }`}
                >
                  <span className="text-[11px] font-semibold text-stone-600 uppercase block">Food Cost %</span>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-base font-bold text-stone-900">{data.food_cost_percentage}%</span>
                    <span
                      className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                        data.classification === 'LOW_COST'
                          ? 'bg-emerald-200 text-emerald-900'
                          : data.classification === 'HEALTHY'
                          ? 'bg-blue-200 text-blue-900'
                          : data.classification === 'OVER_COST'
                          ? 'bg-rose-200 text-rose-900'
                          : 'bg-stone-200 text-stone-700'
                      }`}
                    >
                      {data.classification_label}
                    </span>
                  </div>
                </div>
              </div>

              {/* Recipe Breakdown Table */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-bold text-stone-800 uppercase tracking-wider flex items-center gap-1.5">
                    <span>🥗 Komposisi Bahan Baku (BOM)</span>
                    <span className="px-2 py-0.5 rounded-full bg-stone-200 text-stone-700 text-[10px]">
                      {data.ingredient_count} Bahan
                    </span>
                  </h3>
                  {!data.has_recipe && (
                    <span className="text-[11px] text-amber-700 font-medium">
                      (Menu tidak memiliki BOM, menggunakan biaya langsung)
                    </span>
                  )}
                </div>

                {data.ingredients.length === 0 ? (
                  <div className="p-6 text-center rounded-xl bg-stone-50 border border-dashed border-stone-300 text-xs text-stone-500">
                    Menu ini belum memiliki formula resep bahan baku (BOM).
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-stone-200">
                    <table className="w-full text-xs text-left">
                      <thead className="bg-stone-100 text-stone-600 font-bold border-b border-stone-200">
                        <tr>
                          <th className="py-2.5 px-3">Bahan Baku</th>
                          <th className="py-2.5 px-3 text-right">Qty Resep</th>
                          <th className="py-2.5 px-3 text-right">Biaya Satuan</th>
                          <th className="py-2.5 px-3 text-right">Subtotal Biaya</th>
                          <th className="py-2.5 px-3 text-right">Porsi HPP</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-stone-100">
                        {data.ingredients.map((ing) => (
                          <tr key={ing.recipe_id} className="hover:bg-stone-50">
                            <td className="py-2.5 px-3">
                              <span className="font-bold text-stone-900 block">{ing.ingredient_name}</span>
                              <span className="text-[10px] text-stone-400 font-mono">
                                {ing.ingredient_code || '-'} {ing.notes ? `• ${ing.notes}` : ''}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 text-right font-medium">
                              {ing.quantity} {ing.uom_code || ing.uom_name || ''}
                            </td>
                            <td className="py-2.5 px-3 text-right text-stone-600 font-mono">
                              {formatIDR(ing.unit_cost)}
                            </td>
                            <td className="py-2.5 px-3 text-right font-bold text-stone-900 font-mono">
                              {formatIDR(ing.subtotal_cost)}
                            </td>
                            <td className="py-2.5 px-3 text-right">
                              <span className="inline-block px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[10px] font-bold">
                                {ing.cost_share_percentage}%
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="bg-stone-100 font-bold text-stone-900 border-t border-stone-200">
                        <tr>
                          <td colSpan={3} className="py-2.5 px-3 text-right">
                            Total HPP Per Porsi:
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono text-emerald-800">
                            {formatIDR(data.hpp)}
                          </td>
                          <td className="py-2.5 px-3 text-right">100%</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-6 py-3 border-t border-stone-100 bg-stone-50">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl border border-stone-300 hover:bg-stone-100 text-stone-700 text-xs font-bold transition-colors cursor-pointer"
          >
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
}
