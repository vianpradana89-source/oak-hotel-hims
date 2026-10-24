import React, { useState, useEffect, useCallback } from 'react';
import type {
  PosRecipeIngredient,
  PosProductUom,
  RawMaterialCandidate,
} from './posProductRecipeApi';
import {
  fetchProductRecipe,
  fetchPosProductUoms,
  fetchRawMaterialCandidates,
  saveRecipeIngredient,
  deleteRecipeIngredient,
} from './posProductRecipeApi';
import type { ProductItem } from './ProductMasterPage';

interface ProductRecipeModalProps {
  product: ProductItem | null;
  propertyId: number | null;
  isOpen: boolean;
  onClose: () => void;
  canEdit?: boolean;
}

export const ProductRecipeModal: React.FC<ProductRecipeModalProps> = ({
  product,
  propertyId,
  isOpen,
  onClose,
  canEdit = true,
}) => {
  const [ingredients, setIngredients] = useState<PosRecipeIngredient[]>([]);
  const [uoms, setUoms] = useState<PosProductUom[]>([]);
  const [candidates, setCandidates] = useState<RawMaterialCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Form input state
  const [selectedIngredientId, setSelectedIngredientId] = useState<string>('');
  const [quantityInput, setQuantityInput] = useState<string>('');
  const [selectedUomId, setSelectedUomId] = useState<string>('');
  const [notesInput, setNotesInput] = useState<string>('');

  const loadData = useCallback(async () => {
    if (!product) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      const propId = propertyId || undefined;
      const [recipeRes, uomList, rawList] = await Promise.all([
        fetchProductRecipe(product.id, propId),
        fetchPosProductUoms(),
        fetchRawMaterialCandidates(propId),
      ]);
      setIngredients(recipeRes.ingredients || []);
      setUoms(uomList);
      setCandidates(rawList);
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal memuat formula resep');
    } finally {
      setLoading(false);
    }
  }, [product, propertyId]);

  useEffect(() => {
    if (isOpen && product) {
      loadData();
      setSelectedIngredientId('');
      setQuantityInput('');
      setSelectedUomId('');
      setNotesInput('');
      setSuccessMsg(null);
    }
  }, [isOpen, product, loadData]);

  // Handle ESC key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !product) return null;

  // Filter raw material candidates: exclude self
  const availableCandidates = candidates.filter((c) => c.id !== product.id);

  // When ingredient selection changes, auto-match UOM if applicable
  const handleIngredientChange = (rawIdStr: string) => {
    setSelectedIngredientId(rawIdStr);
    const chosen = candidates.find((c) => c.id === Number(rawIdStr));
    if (chosen && chosen.canonical_base_unit_code) {
      const matchedUom = uoms.find((u) => u.code === chosen.canonical_base_unit_code);
      if (matchedUom) {
        setSelectedUomId(String(matchedUom.id));
      }
    }
  };

  const handleAddIngredient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedIngredientId || !quantityInput) {
      setErrorMsg('Pilih bahan baku dan tentukan kuantitas per porsi');
      return;
    }

    const qty = parseFloat(quantityInput);
    if (isNaN(qty) || qty <= 0) {
      setErrorMsg('Kuantitas harus berupa angka positif lebih besar dari 0');
      return;
    }

    setSaving(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      await saveRecipeIngredient(
        product.id,
        {
          ingredient_product_id: Number(selectedIngredientId),
          quantity: qty,
          uom_id: selectedUomId ? Number(selectedUomId) : undefined,
          notes: notesInput.trim() || undefined,
        },
        propertyId || undefined
      );

      setSuccessMsg('Komponen bahan baku berhasil disimpan ke dalam resep');
      setSelectedIngredientId('');
      setQuantityInput('');
      setSelectedUomId('');
      setNotesInput('');
      await loadData();
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal menyimpan komponen resep');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (recipeId: number, ingredientName: string) => {
    if (!window.confirm(`Hapus bahan baku "${ingredientName}" dari resep ini?`)) return;

    setSaving(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      await deleteRecipeIngredient(recipeId, propertyId || undefined);
      setSuccessMsg(`Bahan baku "${ingredientName}" berhasil dihapus dari resep`);
      await loadData();
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal menghapus komponen resep');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-3 sm:p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full border border-stone-200 max-h-[92vh] flex flex-col overflow-hidden animate-in fade-in duration-200">
        {/* Header Modal - Forest Green / Warm Ivory */}
        <div className="shrink-0 px-6 py-4 bg-[#1b4332] text-white flex items-center justify-between border-b border-[#2d6a4f]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#2d6a4f] flex items-center justify-center text-amber-300 font-bold text-lg shadow-inner">
              🥗
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base sm:text-lg font-bold text-white tracking-wide">
                  Formula Resep &amp; Bill of Materials (BOM)
                </h3>
                <span className="text-[11px] px-2 py-0.5 rounded-full font-semibold bg-emerald-900/60 text-emerald-200 border border-emerald-500/30">
                  MP-04C
                </span>
              </div>
              <p className="text-xs text-emerald-100/80 mt-0.5">
                Konfigurasi komposisi bahan baku untuk menu <strong className="text-amber-200">{product.name}</strong> ({product.item_code || `PRD-${product.id}`})
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-emerald-200 hover:text-white p-1.5 rounded-lg hover:bg-emerald-800/60 transition-colors cursor-pointer"
            aria-label="Tutup modal resep"
          >
            ✕
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6 bg-[#fbfbf8]">
          {/* Alerts */}
          {errorMsg && (
            <div className="px-4 py-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center justify-between shadow-xs">
              <div className="flex items-center gap-2">
                <span className="text-base">⚠️</span>
                <span>{errorMsg}</span>
              </div>
              <button
                type="button"
                onClick={() => setErrorMsg(null)}
                className="font-bold text-rose-700 hover:text-rose-900 ml-3"
              >
                ✕
              </button>
            </div>
          )}

          {successMsg && (
            <div className="px-4 py-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center justify-between shadow-xs">
              <div className="flex items-center gap-2">
                <span className="text-base">✅</span>
                <span>{successMsg}</span>
              </div>
              <button
                type="button"
                onClick={() => setSuccessMsg(null)}
                className="font-bold text-emerald-700 hover:text-emerald-900 ml-3"
              >
                ✕
              </button>
            </div>
          )}

          {/* Info Banner */}
          <div className="p-3.5 rounded-xl bg-amber-50/70 border border-amber-200/80 text-amber-900 text-xs flex items-start gap-2.5">
            <span className="text-base shrink-0 mt-0.5">ℹ️</span>
            <div>
              <p className="font-semibold text-amber-950">Aturan Pengurangan Stok Otomatis</p>
              <p className="text-amber-800/90 mt-0.5">
                Setiap kali menu <strong>{product.name}</strong> terjual di kasir POS, sistem secara otomatis
                memotong stok seluruh bahan baku terdaftar di bawah ini dari lokasi kasir/outlet sesuai takaran per porsi.
              </p>
            </div>
          </div>

          {/* Form Tambah Bahan Baku */}
          {canEdit && (
            <div className="bg-white p-4 sm:p-5 rounded-xl border border-stone-200 shadow-xs">
              <h4 className="text-xs font-bold uppercase tracking-wider text-emerald-900 mb-3 flex items-center gap-1.5">
                <span>➕</span> Tambah / Perbarui Bahan Baku Formula
              </h4>
              <form onSubmit={handleAddIngredient} className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                  {/* Pilihan Bahan Baku */}
                  <div className="sm:col-span-5">
                    <label className="block text-[11px] font-semibold text-gray-700 mb-1">
                      Bahan Baku *
                    </label>
                    <select
                      value={selectedIngredientId}
                      onChange={(e) => handleIngredientChange(e.target.value)}
                      required
                      disabled={saving || loading}
                      className="w-full text-xs bg-stone-50 border border-stone-300 rounded-lg px-3 py-2 text-gray-800 focus:ring-2 focus:ring-emerald-600 focus:bg-white"
                    >
                      <option value="">— Pilih Bahan Baku —</option>
                      {availableCandidates.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.item_code ? `[${c.item_code}] ` : ''}{c.name} ({c.canonical_base_unit_code || c.base_unit || 'UNIT'})
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Kuantitas */}
                  <div className="sm:col-span-3">
                    <label className="block text-[11px] font-semibold text-gray-700 mb-1">
                      Kuantitas per Porsi *
                    </label>
                    <input
                      type="number"
                      step="0.0001"
                      min="0.0001"
                      placeholder="Contoh: 18 atau 150"
                      value={quantityInput}
                      onChange={(e) => setQuantityInput(e.target.value)}
                      required
                      disabled={saving || loading}
                      className="w-full text-xs bg-stone-50 border border-stone-300 rounded-lg px-3 py-2 text-gray-800 focus:ring-2 focus:ring-emerald-600 focus:bg-white"
                    />
                  </div>

                  {/* Satuan Ukur (UOM) */}
                  <div className="sm:col-span-4">
                    <label className="block text-[11px] font-semibold text-gray-700 mb-1">
                      Satuan Ukur (UOM)
                    </label>
                    <select
                      value={selectedUomId}
                      onChange={(e) => setSelectedUomId(e.target.value)}
                      disabled={saving || loading}
                      className="w-full text-xs bg-stone-50 border border-stone-300 rounded-lg px-3 py-2 text-gray-800 focus:ring-2 focus:ring-emerald-600 focus:bg-white"
                    >
                      <option value="">— Gunakan Satuan Baku —</option>
                      {uoms.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name} ({u.code})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
                  {/* Catatan */}
                  <div className="sm:col-span-9">
                    <label className="block text-[11px] font-semibold text-gray-700 mb-1">
                      Catatan / Petunjuk Racikan (Opsional)
                    </label>
                    <input
                      type="text"
                      placeholder="Contoh: Biji kopi giling halus (fine grind), seduh espresso 30ml"
                      value={notesInput}
                      onChange={(e) => setNotesInput(e.target.value)}
                      disabled={saving || loading}
                      maxLength={255}
                      className="w-full text-xs bg-stone-50 border border-stone-300 rounded-lg px-3 py-2 text-gray-800 focus:ring-2 focus:ring-emerald-600 focus:bg-white"
                    />
                  </div>

                  {/* Tombol Simpan */}
                  <div className="sm:col-span-3">
                    <button
                      type="submit"
                      disabled={saving || loading || !selectedIngredientId || !quantityInput}
                      className="w-full py-2 px-3 rounded-lg text-xs font-semibold text-white bg-[#1b4332] hover:bg-[#2d6a4f] active:scale-[0.98] transition-all cursor-pointer shadow-xs disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                    >
                      {saving ? (
                        <span>Menyimpan...</span>
                      ) : (
                        <>
                          <span>💾</span> Simpan Bahan
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          )}

          {/* Daftar Komposisi Resep */}
          <div className="bg-white rounded-xl border border-stone-200 overflow-hidden shadow-xs">
            <div className="px-4 py-3 bg-stone-100/70 border-b border-stone-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-bold text-xs uppercase tracking-wider text-gray-700">
                  Daftar Bahan Baku Formula ({ingredients.length})
                </span>
              </div>
              <button
                type="button"
                onClick={loadData}
                disabled={loading}
                className="text-xs text-emerald-800 hover:text-emerald-950 font-medium cursor-pointer"
              >
                🔄 Refresh
              </button>
            </div>

            {loading ? (
              <div className="py-12 text-center text-xs text-gray-500 flex flex-col items-center justify-center gap-2">
                <div className="w-5 h-5 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
                <span>Memuat data resep produk...</span>
              </div>
            ) : ingredients.length === 0 ? (
              <div className="py-12 px-4 text-center">
                <div className="w-12 h-12 rounded-full bg-stone-100 text-stone-400 flex items-center justify-center mx-auto text-xl mb-2">
                  🥣
                </div>
                <p className="text-xs font-semibold text-gray-700">Belum Ada Formula Resep</p>
                <p className="text-[11px] text-gray-400 mt-1 max-w-sm mx-auto">
                  Menu ini saat ini tidak memiliki formula bahan baku (BOM). Jika menu ini terjual, stok produk jadi atau ritel akan dipotong langsung jika pelacakan stok diaktifkan.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-stone-50 border-b border-stone-200 text-stone-600 font-semibold uppercase text-[10px] tracking-wider">
                    <tr>
                      <th className="py-2.5 px-3">#</th>
                      <th className="py-2.5 px-3">Kode / SKU</th>
                      <th className="py-2.5 px-3">Nama Bahan Baku</th>
                      <th className="py-2.5 px-3 text-right">Kebutuhan / Porsi</th>
                      <th className="py-2.5 px-3">Satuan (UOM)</th>
                      <th className="py-2.5 px-3">Catatan Racikan</th>
                      {canEdit && <th className="py-2.5 px-3 text-right">Aksi</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {ingredients.map((ing, idx) => (
                      <tr key={ing.id} className="hover:bg-emerald-50/30 transition-colors">
                        <td className="py-2.5 px-3 text-gray-400 font-mono text-[11px]">
                          {idx + 1}
                        </td>
                        <td className="py-2.5 px-3 font-mono font-medium text-gray-600 text-[11px]">
                          {ing.ingredient_item_code || `RAW-${ing.ingredient_product_id}`}
                        </td>
                        <td className="py-2.5 px-3 font-semibold text-gray-900">
                          {ing.ingredient_name}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono font-bold text-emerald-800">
                          {parseFloat(ing.quantity).toLocaleString('id-ID', {
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 4,
                          })}
                        </td>
                        <td className="py-2.5 px-3">
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
                            {ing.uom_code || ing.ingredient_base_unit || 'UNIT'}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-gray-500 italic text-[11px]">
                          {ing.notes || '—'}
                        </td>
                        {canEdit && (
                          <td className="py-2.5 px-3 text-right whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => handleDelete(ing.id, ing.ingredient_name)}
                              disabled={saving}
                              className="text-xs text-rose-600 hover:text-rose-800 font-semibold px-2 py-1 rounded hover:bg-rose-50 transition-colors cursor-pointer"
                              title="Hapus bahan baku dari resep"
                            >
                              🗑️ Hapus
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 px-6 py-3.5 bg-stone-100/90 border-t border-stone-200 flex items-center justify-between">
          <div className="text-[11px] text-stone-500">
            Total Bahan: <strong className="text-gray-800">{ingredients.length} item</strong>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-stone-700 bg-white border border-stone-300 rounded-lg hover:bg-stone-50 transition-colors cursor-pointer"
          >
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
};

export default ProductRecipeModal;
