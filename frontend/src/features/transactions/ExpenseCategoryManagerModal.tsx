import React, { useState, useEffect } from 'react';
import type { CustomCategory, TransactionType } from './transactionDomainTypes';
import {
  fetchCustomCategoriesApi,
  createCustomCategoryApi,
  toggleCustomCategoryApi
} from './transactionClient';

interface ExpenseCategoryManagerModalProps {
  isOpen: boolean;
  propertyId: number;
  transactionType?: TransactionType;
  actorName?: string;
  onClose: () => void;
  onCategoriesUpdated: () => void;
}

export const ExpenseCategoryManagerModal: React.FC<ExpenseCategoryManagerModalProps> = ({
  isOpen,
  propertyId,
  transactionType = 'EXPENSE',
  actorName = 'Staff',
  onClose,
  onCategoriesUpdated
}) => {
  const [categories, setCategories] = useState<CustomCategory[]>([]);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDept, setNewDept] = useState('GENERAL');
  const [creating, setCreating] = useState(false);
  const [togglingId, setTogglingId] = useState<string | number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadCategories();
      setError(null);
    }
  }, [isOpen, propertyId, transactionType]);

  const loadCategories = async () => {
    setLoading(true);
    try {
      const data = await fetchCustomCategoriesApi(propertyId, transactionType);
      setCategories(data);
    } catch (err: any) {
      setError(err.message || 'Gagal memuat daftar kategori kustom');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;

    setCreating(true);
    setError(null);
    try {
      await createCustomCategoryApi({
        property_id: propertyId,
        name: newName.trim(),
        transaction_type: transactionType,
        department_code: newDept
      });
      setNewName('');
      loadCategories();
      onCategoriesUpdated();
    } catch (err: any) {
      setError(err.message || 'Gagal menambah kategori');
    } finally {
      setCreating(false);
    }
  };

  const handleToggle = async (catCode: string, catId: string | number) => {
    setTogglingId(catId);
    setError(null);
    try {
      await toggleCustomCategoryApi(catCode, propertyId, actorName);
      loadCategories();
      onCategoriesUpdated();
    } catch (err: any) {
      setError(err.message || 'Gagal mengubah status kategori');
    } finally {
      setTogglingId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
      <div className="bg-white rounded-2xl max-w-md w-full shadow-2xl overflow-hidden border border-slate-200">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/80">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-rose-100 text-rose-800 flex items-center justify-center font-bold">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-800">Kelola Kategori {transactionType}</h3>
              <p className="text-[11px] text-slate-500">Tambah kategori atau nonaktifkan yang tidak digunakan</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-200/60 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4 max-h-[75vh] overflow-y-auto text-xs">
          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl flex items-center gap-2">
              <svg className="w-4 h-4 shrink-0 text-rose-600" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          {/* Form Create */}
          <form onSubmit={handleCreate} className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
            <span className="font-bold text-slate-700 block text-[11px]">Tambah Kategori Baru</span>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                required
                placeholder="Nama Kategori..."
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg focus:border-emerald-600 outline-none text-xs"
              />
              <select
                value={newDept}
                onChange={(e) => setNewDept(e.target.value)}
                className="px-2 py-1.5 bg-white border border-slate-200 rounded-lg focus:border-emerald-600 outline-none text-xs"
              >
                <option value="GENERAL">Umum (General)</option>
                <option value="FRONT_OFFICE">Front Office</option>
                <option value="HOUSEKEEPING">Housekeeping</option>
                <option value="FNB">F&B Restoran</option>
                <option value="MAINTENANCE">Engineering</option>
                <option value="ADMIN">Keuangan / Admin</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={creating || !newName.trim()}
              className="w-full py-2 bg-emerald-800 hover:bg-emerald-900 disabled:opacity-50 text-white font-bold rounded-lg transition-colors flex items-center justify-center gap-1.5 shadow-xs"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
              </svg>
              {creating ? 'Menyimpan...' : 'Tambah Kategori'}
            </button>
          </form>

          {/* List of Custom Categories */}
          <div className="space-y-2">
            <span className="font-bold text-slate-700 block text-[11px]">Kategori Kustom Terdaftar ({categories.length})</span>
            {loading ? (
              <div className="py-4 text-center text-slate-400">Memuat kategori...</div>
            ) : categories.length === 0 ? (
              <div className="py-4 text-center text-slate-400 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                Belum ada kategori kustom tambahan
              </div>
            ) : (
              categories.map((cat) => (
                <div
                  key={cat.id}
                  className="flex items-center justify-between p-2.5 bg-white border border-slate-200 rounded-xl"
                >
                  <div>
                    <div className="font-semibold text-slate-800 flex items-center gap-2">
                      <span>{cat.name}</span>
                      <span className="text-[10px] text-slate-400 font-mono">({cat.code})</span>
                    </div>
                    <div className="text-[10px] text-slate-500">Dept: {cat.department_code || 'GENERAL'}</div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={togglingId === cat.id}
                      onClick={() => handleToggle(cat.code, cat.id)}
                      className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border transition-colors cursor-pointer ${
                        cat.is_active
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-rose-50 hover:text-rose-700 hover:border-rose-200'
                          : 'bg-slate-100 text-slate-500 border-slate-200 hover:bg-emerald-50 hover:text-emerald-700'
                      }`}
                    >
                      {cat.is_active ? 'Aktif' : 'Nonaktif'}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-200 bg-slate-50 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-xl"
          >
            Selesai
          </button>
        </div>
      </div>
    </div>
  );
};
