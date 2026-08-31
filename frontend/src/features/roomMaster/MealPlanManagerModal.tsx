import React, { useState, useEffect } from 'react';
import { pricingApi } from './pricingApi';
import type {
  MealPlanMaster,
  CreateMealPlanDto,
  UpdateMealPlanDto
} from './pricingApi';

interface MealPlanManagerModalProps {
  propertyId: number;
  isOpen: boolean;
  onClose: () => void;
  onSelectMealPlan?: (mealPlan: MealPlanMaster) => void;
}

export const MealPlanManagerModal: React.FC<MealPlanManagerModalProps> = ({
  propertyId,
  isOpen,
  onClose,
  onSelectMealPlan
}) => {
  const [mealPlans, setMealPlans] = useState<MealPlanMaster[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  // Form state
  const [editingPlan, setEditingPlan] = useState<MealPlanMaster | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [formCode, setFormCode] = useState('');
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formBreakfast, setFormBreakfast] = useState(false);
  const [formLunch, setFormLunch] = useState(false);
  const [formDinner, setFormDinner] = useState(false);
  const [formActive, setFormActive] = useState(true);
  const [formSortOrder, setFormSortOrder] = useState(0);
  const [formSubmitting, setFormSubmitting] = useState(false);

  // Delete modal confirmation
  const [deletePlanTarget, setDeletePlanTarget] = useState<MealPlanMaster | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  const fetchPlans = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await pricingApi.listMealPlans(propertyId, {
        include_archived: showArchived
      });
      setMealPlans(data);
    } catch (err: any) {
      setError(err.message || 'Gagal memuat data Meal Plan.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchPlans();
      resetForm();
    }
  }, [isOpen, propertyId, showArchived]);

  const resetForm = () => {
    setEditingPlan(null);
    setIsCreating(false);
    setFormCode('');
    setFormName('');
    setFormDescription('');
    setFormBreakfast(false);
    setFormLunch(false);
    setFormDinner(false);
    setFormActive(true);
    setFormSortOrder(0);
    setError(null);
    setSuccessNotice(null);
  };

  const startCreate = () => {
    resetForm();
    setIsCreating(true);
  };

  const startEdit = (plan: MealPlanMaster) => {
    setEditingPlan(plan);
    setIsCreating(false);
    setFormCode(plan.code);
    setFormName(plan.name);
    setFormDescription(plan.description || '');
    setFormBreakfast(plan.breakfast_included);
    setFormLunch(plan.lunch_included);
    setFormDinner(plan.dinner_included);
    setFormActive(plan.is_active);
    setFormSortOrder(plan.sort_order || 0);
    setError(null);
    setSuccessNotice(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formCode.trim() || !formName.trim()) {
      setError('Kode dan Nama Meal Plan wajib diisi.');
      return;
    }

    setFormSubmitting(true);
    setError(null);
    setSuccessNotice(null);

    try {
      if (isCreating) {
        const dto: CreateMealPlanDto = {
          code: formCode.trim().toUpperCase(),
          name: formName.trim(),
          description: formDescription.trim() || null,
          breakfast_included: formBreakfast,
          lunch_included: formLunch,
          dinner_included: formDinner,
          is_active: formActive,
          sort_order: formSortOrder
        };
        const created = await pricingApi.createMealPlan(propertyId, dto);
        setSuccessNotice(`Meal Plan ${created.code} berhasil ditambahkan.`);
        await fetchPlans();
        resetForm();
        if (onSelectMealPlan) {
          onSelectMealPlan(created);
        }
      } else if (editingPlan) {
        const dto: UpdateMealPlanDto = {
          code: formCode.trim().toUpperCase(),
          name: formName.trim(),
          description: formDescription.trim() || null,
          breakfast_included: formBreakfast,
          lunch_included: formLunch,
          dinner_included: formDinner,
          is_active: formActive,
          sort_order: formSortOrder
        };
        const updated = await pricingApi.updateMealPlan(propertyId, editingPlan.id, dto);
        setSuccessNotice(`Meal Plan ${updated.code} berhasil diperbarui.`);
        await fetchPlans();
        resetForm();
        if (onSelectMealPlan) {
          onSelectMealPlan(updated);
        }
      }
    } catch (err: any) {
      setError(err.message || 'Gagal menyimpan Meal Plan.');
    } finally {
      setFormSubmitting(false);
    }
  };

  const handleToggleStatus = async (plan: MealPlanMaster) => {
    try {
      const updated = await pricingApi.setMealPlanActive(propertyId, plan.id, !plan.is_active);
      setMealPlans((prev) => prev.map((p) => (p.id === plan.id ? updated : p)));
      setSuccessNotice(`Status ${updated.code} diubah menjadi ${updated.is_active ? 'Aktif' : 'Nonaktif'}.`);
    } catch (err: any) {
      setError(err.message || 'Gagal mengubah status Meal Plan.');
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deletePlanTarget) return;
    setDeleteSubmitting(true);
    setError(null);
    setSuccessNotice(null);
    try {
      const res = await pricingApi.deleteMealPlan(propertyId, deletePlanTarget.id);
      setSuccessNotice(res.message);
      setDeletePlanTarget(null);
      await fetchPlans();
    } catch (err: any) {
      setError(err.message || 'Gagal menghapus Meal Plan.');
    } finally {
      setDeleteSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col border border-stone-200 overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 bg-stone-900 text-white flex items-center justify-between border-b border-stone-800">
          <div>
            <h2 className="text-xl font-bold font-serif tracking-wide text-amber-100 flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
              Kelola Meal Plan Master
            </h2>
            <p className="text-xs text-stone-300 mt-0.5">
              Kelola paket makanan (Room Only, Breakfast, Full Board, dll) untuk Rate Plan
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-stone-400 hover:text-white text-2xl leading-none p-1 rounded-lg hover:bg-stone-800 transition-colors"
          >
            &times;
          </button>
        </div>

        {/* Notice & Error */}
        {error && (
          <div className="mx-6 mt-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-500 font-bold">&times;</button>
          </div>
        )}

        {successNotice && (
          <div className="mx-6 mt-4 p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-xl flex items-center justify-between">
            <span>{successNotice}</span>
            <button onClick={() => setSuccessNotice(null)} className="text-emerald-600 font-bold">&times;</button>
          </div>
        )}

        {/* Content Body */}
        <div className="p-6 overflow-y-auto flex-1 flex flex-col gap-6">
          {/* Top action row */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-xs font-medium text-stone-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(e) => setShowArchived(e.target.checked)}
                  className="rounded border-stone-300 text-emerald-700 focus:ring-emerald-600"
                />
                Tampilkan Arsip
              </label>
            </div>

            {!isCreating && !editingPlan && (
              <button
                onClick={startCreate}
                className="px-4 py-2 bg-emerald-800 hover:bg-emerald-900 text-white text-xs font-semibold rounded-xl shadow-sm hover:shadow transition-all flex items-center gap-1.5"
              >
                <span className="text-base leading-none">+</span> Tambah Meal Plan
              </button>
            )}
          </div>

          {/* Form when creating or editing */}
          {(isCreating || editingPlan) && (
            <form onSubmit={handleSubmit} className="bg-stone-50 border border-stone-200 rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between border-b border-stone-200 pb-3">
                <h3 className="font-semibold text-sm text-stone-800">
                  {isCreating ? 'Tambah Meal Plan Baru' : `Edit Meal Plan: ${editingPlan?.code}`}
                </h3>
                <button
                  type="button"
                  onClick={resetForm}
                  className="text-xs text-stone-500 hover:text-stone-800"
                >
                  Batal
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider mb-1">
                    Kode Meal Plan *
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={10}
                    value={formCode}
                    onChange={(e) => setFormCode(e.target.value.toUpperCase())}
                    placeholder="Contoh: BB, HB, FB"
                    className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg text-sm font-semibold tracking-wider uppercase focus:outline-none focus:ring-2 focus:ring-emerald-700"
                  />
                  <span className="text-[10px] text-stone-500">Maks. 10 karakter huruf/angka</span>
                </div>

                <div>
                  <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider mb-1">
                    Nama Meal Plan *
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={100}
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="Contoh: Bed & Breakfast"
                    className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
                  />
                </div>
              </div>

              {/* Inclusions checkboxes */}
              <div>
                <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider mb-1.5">
                  Termasuk Makan:
                </label>
                <div className="flex flex-wrap gap-4">
                  <label className="flex items-center gap-2 text-xs text-stone-700 font-medium cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formBreakfast}
                      onChange={(e) => setFormBreakfast(e.target.checked)}
                      className="rounded border-stone-300 text-emerald-700 focus:ring-emerald-600"
                    />
                    Sarapan (Breakfast)
                  </label>
                  <label className="flex items-center gap-2 text-xs text-stone-700 font-medium cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formLunch}
                      onChange={(e) => setFormLunch(e.target.checked)}
                      className="rounded border-stone-300 text-emerald-700 focus:ring-emerald-600"
                    />
                    Makan Siang (Lunch)
                  </label>
                  <label className="flex items-center gap-2 text-xs text-stone-700 font-medium cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formDinner}
                      onChange={(e) => setFormDinner(e.target.checked)}
                      className="rounded border-stone-300 text-emerald-700 focus:ring-emerald-600"
                    />
                    Makan Malam (Dinner)
                  </label>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider mb-1">
                  Deskripsi / Keterangan
                </label>
                <textarea
                  rows={2}
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder="Catatan tambahan paket makanan..."
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-emerald-700"
                />
              </div>

              <div className="flex items-center justify-between pt-2">
                <label className="flex items-center gap-2 text-xs font-medium text-stone-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formActive}
                    onChange={(e) => setFormActive(e.target.checked)}
                    className="rounded border-stone-300 text-emerald-700 focus:ring-emerald-600"
                  />
                  Status Aktif (dapat dipilih di Rate Plan)
                </label>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={resetForm}
                    className="px-3 py-1.5 text-xs text-stone-600 hover:text-stone-900 border border-stone-300 rounded-lg"
                  >
                    Batal
                  </button>
                  <button
                    type="submit"
                    disabled={formSubmitting}
                    className="px-4 py-1.5 bg-emerald-800 hover:bg-emerald-900 text-white text-xs font-bold rounded-lg shadow disabled:opacity-50"
                  >
                    {formSubmitting ? 'Menyimpan...' : isCreating ? 'Tambah Meal Plan' : 'Simpan Perubahan'}
                  </button>
                </div>
              </div>
            </form>
          )}

          {/* Table of Meal Plans */}
          <div className="border border-stone-200 rounded-2xl overflow-hidden shadow-sm">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-stone-100 text-[11px] font-bold text-stone-600 uppercase tracking-wider border-b border-stone-200">
                  <th className="py-3 px-4">Kode</th>
                  <th className="py-3 px-4">Nama Meal Plan</th>
                  <th className="py-3 px-4">Cakupan Makan</th>
                  <th className="py-3 px-4">Penggunaan</th>
                  <th className="py-3 px-4 text-center">Status</th>
                  <th className="py-3 px-4 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 text-xs text-stone-700">
                {loading ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-stone-400">
                      Memuat data Meal Plan...
                    </td>
                  </tr>
                ) : mealPlans.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-stone-400">
                      Belum ada Meal Plan yang terdaftar.
                    </td>
                  </tr>
                ) : (
                  mealPlans.map((plan) => (
                    <tr
                      key={plan.id}
                      className={`hover:bg-stone-50 transition-colors ${
                        plan.is_archived ? 'bg-stone-50/70 text-stone-400' : ''
                      }`}
                    >
                      <td className="py-3 px-4 font-mono font-bold text-stone-900">
                        {plan.code}
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-semibold text-stone-900">{plan.name}</div>
                        {plan.description && (
                          <div className="text-[10px] text-stone-500 mt-0.5">{plan.description}</div>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex flex-wrap gap-1">
                          {plan.breakfast_included && (
                            <span className="px-1.5 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 rounded text-[10px] font-medium">
                              Sarapan
                            </span>
                          )}
                          {plan.lunch_included && (
                            <span className="px-1.5 py-0.5 bg-orange-50 text-orange-700 border border-orange-200 rounded text-[10px] font-medium">
                              Siang
                            </span>
                          )}
                          {plan.dinner_included && (
                            <span className="px-1.5 py-0.5 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded text-[10px] font-medium">
                              Malam
                            </span>
                          )}
                          {!plan.breakfast_included && !plan.lunch_included && !plan.dinner_included && (
                            <span className="text-[10px] text-stone-400 italic">Tanpa makan</span>
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-stone-500">
                        {plan.rate_plans_count !== undefined ? (
                          <span className="text-xs">
                            {plan.rate_plans_count} Rate Plan
                          </span>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td className="py-3 px-4 text-center">
                        {plan.is_archived ? (
                          <span className="px-2 py-0.5 bg-stone-200 text-stone-600 rounded-full text-[10px] font-semibold">
                            Diarsipkan
                          </span>
                        ) : plan.is_active ? (
                          <button
                            type="button"
                            onClick={() => handleToggleStatus(plan)}
                            className="px-2 py-0.5 bg-emerald-100 hover:bg-emerald-200 text-emerald-800 rounded-full text-[10px] font-semibold transition-colors"
                            title="Klik untuk nonaktifkan"
                          >
                            Aktif
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleToggleStatus(plan)}
                            className="px-2 py-0.5 bg-stone-100 hover:bg-stone-200 text-stone-500 rounded-full text-[10px] font-semibold transition-colors"
                            title="Klik untuk aktifkan"
                          >
                            Nonaktif
                          </button>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {!plan.is_archived && (
                            <button
                              type="button"
                              onClick={() => startEdit(plan)}
                              className="text-stone-600 hover:text-emerald-800 text-xs font-semibold px-2 py-1 rounded hover:bg-stone-100"
                            >
                              Edit
                            </button>
                          )}
                          {!plan.is_archived && (
                            <button
                              type="button"
                              onClick={() => setDeletePlanTarget(plan)}
                              className="text-stone-400 hover:text-red-600 text-xs px-2 py-1 rounded hover:bg-red-50"
                              title="Hapus / Arsipkan"
                            >
                              Hapus
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-stone-50 border-t border-stone-200 flex justify-between items-center">
          <span className="text-xs text-stone-500">
            Total {mealPlans.length} Meal Plan
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 bg-stone-200 hover:bg-stone-300 text-stone-800 text-xs font-bold rounded-xl transition-colors"
          >
            Selesai
          </button>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {deletePlanTarget && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 border border-stone-200 space-y-4">
            <h3 className="text-base font-bold text-stone-900">
              Konfirmasi Hapus / Arsip Meal Plan
            </h3>
            <p className="text-xs text-stone-600 leading-relaxed">
              Apakah Anda yakin ingin menghapus Meal Plan <span className="font-bold text-stone-900">{deletePlanTarget.code} — {deletePlanTarget.name}</span>?
            </p>
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-[11px] leading-relaxed">
              Jika Meal Plan ini sudah pernah digunakan oleh Rate Plan atau reservasi, sistem akan mengarsipkannya secara aman agar data histori tetap terlindungi.
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={deleteSubmitting}
                onClick={() => setDeletePlanTarget(null)}
                className="px-4 py-2 border border-stone-300 rounded-xl text-xs font-semibold text-stone-600 hover:bg-stone-50"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={deleteSubmitting}
                onClick={handleDeleteConfirm}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-bold shadow disabled:opacity-50"
              >
                {deleteSubmitting ? 'Memproses...' : 'Ya, Lanjutkan'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
