import React, { useCallback, useEffect, useState } from 'react';
import {
  createPurchaseSettingsCategoryApi,
  deletePurchaseSettingsCategoryApi,
  fetchPurchaseAllowedDepartmentsApi,
  fetchPurchaseSettingsCategoriesApi,
  savePurchaseAllowedDepartmentsApi,
  setPurchaseSettingsCategoryActiveApi,
  updatePurchaseSettingsCategoryApi,
  type PurchaseSettingsCategory,
  type PurchaseSettingsDepartment,
} from '../transactions/transactionClient';

interface PurchaseOperationalSettingsTabProps {
  propertyId: number;
}

export const PurchaseOperationalSettingsTab: React.FC<PurchaseOperationalSettingsTabProps> = ({
  propertyId,
}) => {
  const [categories, setCategories] = useState<PurchaseSettingsCategory[]>([]);
  const [departments, setDepartments] = useState<PurchaseSettingsDepartment[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingDepts, setSavingDepts] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [editing, setEditing] = useState<PurchaseSettingsCategory | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cats, deptData] = await Promise.all([
        fetchPurchaseSettingsCategoriesApi(propertyId),
        fetchPurchaseAllowedDepartmentsApi(propertyId),
      ]);
      setCategories(cats);
      setDepartments(deptData.departments);
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Gagal memuat pengaturan pembelian' });
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    load();
    setEditing(null);
    setName('');
    setDescription('');
  }, [load]);

  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      if (editing) {
        await updatePurchaseSettingsCategoryApi(editing.id, propertyId, {
          name: name.trim(),
          description: description.trim() || null,
        });
      } else {
        await createPurchaseSettingsCategoryApi({
          property_id: propertyId,
          name: name.trim(),
          description: description.trim() || null,
        });
      }
      setName('');
      setDescription('');
      setEditing(null);
      setFeedback({ type: 'success', message: editing ? 'Kategori diperbarui' : 'Kategori pembelian ditambahkan' });
      await load();
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Gagal menyimpan kategori' });
    }
  };

  const handleToggle = async (cat: PurchaseSettingsCategory) => {
    setBusyId(cat.id);
    try {
      await setPurchaseSettingsCategoryActiveApi(cat.id, propertyId, !cat.is_active);
      await load();
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Gagal mengubah status kategori' });
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (cat: PurchaseSettingsCategory) => {
    if (cat.referenced || cat.is_system_default) return;
    setBusyId(cat.id);
    try {
      await deletePurchaseSettingsCategoryApi(cat.id, propertyId);
      setFeedback({ type: 'success', message: 'Kategori dihapus' });
      await load();
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Gagal menghapus kategori' });
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleDepartment = async (dept: PurchaseSettingsDepartment) => {
    const configured = departments.some((row) => row.allowed);
    const next = configured
      ? departments.filter((row) => (row.id === dept.id ? !row.allowed : row.allowed)).map((row) => row.id)
      : departments.filter((row) => row.id !== dept.id && row.is_active).map((row) => row.id);
    setSavingDepts(true);
    try {
      const saved = await savePurchaseAllowedDepartmentsApi(propertyId, next);
      setDepartments(saved.departments);
      setFeedback({ type: 'success', message: 'Departemen alokasi pembelian disimpan' });
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Gagal menyimpan departemen alokasi' });
    } finally {
      setSavingDepts(false);
    }
  };

  const allowListConfigured = departments.some((row) => row.allowed);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-bold text-neutral-900">Pembelian Operasional</h2>
        <p className="text-xs text-neutral-500 mt-1">
          Kelola kategori pembelian properti dan departemen HR yang boleh dialokasikan pada transaksi pembelian.
        </p>
      </div>

      {feedback && (
        <div className={`text-xs font-semibold px-3 py-2 rounded-xl border ${
          feedback.type === 'success'
            ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
            : 'bg-rose-50 text-rose-800 border-rose-200'
        }`}>
          {feedback.message}
        </div>
      )}

      <section className="bg-white border border-neutral-200/90 rounded-2xl shadow-xs p-5 space-y-4">
        <div>
          <h3 className="font-bold text-sm text-neutral-900">Kategori Pembelian</h3>
          <p className="text-xs text-neutral-500">Nama boleh diubah. Kode tetap. Kategori nonaktif tidak muncul di form pembelian baru.</p>
        </div>

        <form onSubmit={handleSaveCategory} className="grid grid-cols-1 md:grid-cols-12 gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={editing ? 'Ubah nama kategori' : 'Nama kategori baru'}
            className="md:col-span-4 px-3 py-2 text-xs bg-[#faf9f6] border border-neutral-200 rounded-xl outline-none focus:border-emerald-700"
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Deskripsi (opsional)"
            className="md:col-span-5 px-3 py-2 text-xs bg-[#faf9f6] border border-neutral-200 rounded-xl outline-none focus:border-emerald-700"
          />
          <div className="md:col-span-3 flex gap-2">
            <button type="submit" className="flex-1 px-3 py-2 text-xs font-bold rounded-xl bg-[#1b4332] text-white">
              {editing ? 'Simpan' : 'Tambah'}
            </button>
            {editing && (
              <button type="button" onClick={() => { setEditing(null); setName(''); setDescription(''); }} className="px-3 py-2 text-xs font-bold rounded-xl bg-neutral-100 text-neutral-700">
                Batal
              </button>
            )}
          </div>
        </form>

        {loading ? (
          <div className="text-xs text-neutral-500">Memuat kategori…</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-neutral-500 border-b border-neutral-200">
                  <th className="py-2 pr-2 font-semibold">Nama</th>
                  <th className="py-2 pr-2 font-semibold">Kode</th>
                  <th className="py-2 pr-2 font-semibold">Status</th>
                  <th className="py-2 font-semibold text-right">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((cat) => (
                  <tr key={cat.id} className="border-b border-neutral-100">
                    <td className="py-2 pr-2 font-semibold text-neutral-800">
                      {cat.name}
                      {cat.is_system_default && (
                        <span className="ml-2 text-[10px] font-bold text-amber-800 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">Default</span>
                      )}
                    </td>
                    <td className="py-2 pr-2 font-mono text-neutral-500">{cat.code}</td>
                    <td className="py-2 pr-2">
                      <span className={`px-2 py-0.5 rounded-md font-bold ${cat.is_active ? 'bg-emerald-50 text-emerald-800' : 'bg-neutral-100 text-neutral-500'}`}>
                        {cat.is_active ? 'Aktif' : 'Nonaktif'}
                      </span>
                    </td>
                    <td className="py-2 text-right space-x-2 whitespace-nowrap">
                      <button type="button" onClick={() => { setEditing(cat); setName(cat.name); setDescription(cat.description || ''); }} className="font-bold text-emerald-800">
                        Edit
                      </button>
                      <button type="button" disabled={busyId === cat.id} onClick={() => handleToggle(cat)} className="font-bold text-slate-700">
                        {cat.is_active ? 'Nonaktifkan' : 'Aktifkan'}
                      </button>
                      <button
                        type="button"
                        disabled={cat.referenced || cat.is_system_default || busyId === cat.id}
                        onClick={() => handleDelete(cat)}
                        className="font-bold text-rose-700 disabled:text-neutral-300"
                        title={cat.referenced || cat.is_system_default ? 'Tidak dapat dihapus' : 'Hapus'}
                      >
                        Hapus
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bg-white border border-neutral-200/90 rounded-2xl shadow-xs p-5 space-y-4">
        <div>
          <h3 className="font-bold text-sm text-neutral-900">Departemen Alokasi Pembelian</h3>
          <p className="text-xs text-neutral-500">
            Centang departemen HR yang boleh dipilih di form pembelian. Belum dikonfigurasi = semua departemen aktif.
            Master departemen tetap di HRD → Departemen & Jabatan.
          </p>
        </div>
        {departments.length === 0 && !loading && (
          <div className="text-xs text-neutral-500">Belum ada departemen HR pada properti ini.</div>
        )}
        <div className="space-y-2">
          {departments.map((dept) => {
            const checked = allowListConfigured ? dept.allowed : dept.is_active;
            return (
              <label key={dept.id} className="flex items-center justify-between gap-3 border border-neutral-200 rounded-xl px-3 py-2 text-xs">
                <span className="font-semibold text-neutral-800">
                  {dept.name}
                  {!dept.is_active && <span className="ml-2 text-neutral-400 font-normal">Nonaktif</span>}
                </span>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!dept.is_active || savingDepts}
                  onChange={() => handleToggleDepartment(dept)}
                />
              </label>
            );
          })}
        </div>
      </section>
    </div>
  );
};
