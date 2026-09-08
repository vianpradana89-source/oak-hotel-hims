import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

const CATEGORY_MENU_WIDTH = 160;

function placeCategoryActionMenu(
  anchor: HTMLElement,
  panel: HTMLElement | null
): { top: number; left: number } {
  const rect = anchor.getBoundingClientRect();
  const width = CATEGORY_MENU_WIDTH;
  const height = panel?.offsetHeight || 0;
  let left = rect.right - width;
  if (left < 8) left = 8;
  if (left + width > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - width - 8);
  }
  let top = rect.bottom + 4;
  if (height > 0) {
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    if (spaceBelow < height && spaceAbove > spaceBelow) {
      top = rect.top - height - 4;
    }
    top = Math.min(Math.max(8, top), Math.max(8, window.innerHeight - height - 8));
  }
  return { top, left };
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
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null);
  const [menuCoords, setMenuCoords] = useState({ top: 0, left: 0 });
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  const closeMenu = useCallback(() => {
    setMenuOpenId(null);
    menuButtonRef.current = null;
  }, []);

  const repositionMenu = useCallback(() => {
    const anchor = menuButtonRef.current;
    if (!anchor) return;
    setMenuCoords(placeCategoryActionMenu(anchor, menuRef.current));
  }, []);

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
    closeMenu();
  }, [load, closeMenu]);

  useLayoutEffect(() => {
    if (menuOpenId == null) return;
    repositionMenu();
  }, [menuOpenId, repositionMenu]);

  useEffect(() => {
    if (menuOpenId == null) return;
    repositionMenu();
  }, [menuOpenId, repositionMenu]);

  useEffect(() => {
    if (menuOpenId == null) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || menuButtonRef.current?.contains(target)) return;
      closeMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    const onDismiss = () => closeMenu();
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onDismiss);
    window.addEventListener('scroll', onDismiss, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('scroll', onDismiss, true);
    };
  }, [menuOpenId, closeMenu]);

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
    closeMenu();
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
    closeMenu();
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

  const startEdit = (cat: PurchaseSettingsCategory) => {
    closeMenu();
    setEditing(cat);
    setName(cat.name);
    setDescription(cat.description || '');
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
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-bold text-neutral-900">Pembelian Operasional</h2>
        <p className="text-[11px] text-neutral-500 mt-0.5">
          Kategori pembelian properti dan departemen HR untuk alokasi transaksi pembelian.
        </p>
      </div>

      {feedback && (
        <div className={`text-[11px] font-semibold px-3 py-1.5 rounded-lg border ${
          feedback.type === 'success'
            ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
            : 'bg-rose-50 text-rose-800 border-rose-200'
        }`}>
          {feedback.message}
        </div>
      )}

      <section className="bg-white border border-neutral-200/90 rounded-2xl shadow-xs p-4 space-y-3">
        <div>
          <h3 className="font-bold text-sm text-neutral-900">Kategori Pembelian</h3>
          <p className="text-[11px] text-neutral-500 mt-0.5">
            Nama boleh diubah. Kode tetap. Nonaktif tidak muncul di form pembelian baru.
            Riwayat transaksi tetap terbaca jika kategori diubah namanya atau dinonaktifkan.
          </p>
        </div>

        <form onSubmit={handleSaveCategory} className="flex flex-col sm:flex-row gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={editing ? 'Ubah nama' : 'Nama kategori'}
            className="flex-1 min-w-0 px-2.5 py-1.5 text-xs bg-[#faf9f6] border border-neutral-200 rounded-lg outline-none focus:border-emerald-700"
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Deskripsi (opsional)"
            className="flex-[1.2] min-w-0 px-2.5 py-1.5 text-xs bg-[#faf9f6] border border-neutral-200 rounded-lg outline-none focus:border-emerald-700"
          />
          <div className="flex gap-1.5 shrink-0">
            <button type="submit" className="px-3 py-1.5 text-xs font-bold rounded-lg bg-[#1b4332] text-white">
              {editing ? 'Simpan' : 'Tambah'}
            </button>
            {editing && (
              <button
                type="button"
                onClick={() => { setEditing(null); setName(''); setDescription(''); }}
                className="px-3 py-1.5 text-xs font-bold rounded-lg bg-neutral-100 text-neutral-700"
              >
                Batal
              </button>
            )}
          </div>
        </form>

        {loading ? (
          <div className="text-[11px] text-neutral-500">Memuat kategori…</div>
        ) : (
          <div>
            <table className="w-full text-xs table-fixed">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-neutral-400 border-b border-neutral-200">
                  <th className="py-1.5 pr-2 font-semibold w-[42%]">Nama</th>
                  <th className="py-1.5 pr-2 font-semibold w-[28%]">Kode</th>
                  <th className="py-1.5 pr-2 font-semibold w-[18%]">Status</th>
                  <th className="py-1.5 font-semibold text-right w-10">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((cat) => {
                  const menuOpen = menuOpenId === cat.id;
                  return (
                    <tr key={cat.id} className="border-b border-neutral-100 last:border-0">
                      <td className="py-1.5 pr-2 align-middle">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="font-semibold text-neutral-800 truncate">{cat.name}</span>
                          {cat.is_system_default && (
                            <span className="shrink-0 text-[9px] font-semibold text-amber-800/90 bg-amber-50 border border-amber-100 px-1 py-px rounded">
                              Default
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-1.5 pr-2 align-middle">
                        <span className="font-mono text-[10px] text-neutral-400 truncate block">{cat.code}</span>
                      </td>
                      <td className="py-1.5 pr-2 align-middle">
                        <span className={`inline-block text-[10px] font-semibold px-1.5 py-px rounded ${
                          cat.is_active ? 'bg-emerald-50 text-emerald-800' : 'bg-neutral-100 text-neutral-500'
                        }`}>
                          {cat.is_active ? 'Aktif' : 'Nonaktif'}
                        </span>
                      </td>
                      <td className="py-1.5 align-middle text-right">
                        <button
                          type="button"
                          aria-label="Aksi kategori"
                          aria-haspopup="menu"
                          aria-expanded={menuOpen}
                          disabled={busyId === cat.id}
                          onClick={(event) => {
                            if (menuOpen) {
                              closeMenu();
                              return;
                            }
                            menuButtonRef.current = event.currentTarget;
                            setMenuOpenId(cat.id);
                          }}
                          className={`w-7 h-7 inline-flex items-center justify-center rounded-lg border text-slate-600 hover:text-slate-900 ${
                            menuOpen ? 'bg-slate-200 border-slate-300' : 'bg-slate-50 border-slate-200 hover:bg-slate-100'
                          } disabled:opacity-50`}
                        >
                          ⋯
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {menuOpenId != null && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{ top: menuCoords.top, left: menuCoords.left, width: CATEGORY_MENU_WIDTH }}
          className="fixed z-[80] bg-white border border-slate-200 rounded-xl shadow-lg py-1 text-xs text-left"
        >
          {(() => {
            const cat = categories.find((row) => row.id === menuOpenId);
            if (!cat) return null;
            const canDelete = !cat.referenced && !cat.is_system_default;
            return (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => startEdit(cat)}
                  className="w-full px-3 py-1.5 text-left text-slate-700 hover:bg-slate-50"
                >
                  Edit
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={busyId === cat.id}
                  onClick={() => handleToggle(cat)}
                  className="w-full px-3 py-1.5 text-left text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {cat.is_active ? 'Nonaktifkan' : 'Aktifkan'}
                </button>
                {canDelete ? (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={busyId === cat.id}
                    onClick={() => handleDelete(cat)}
                    className="w-full px-3 py-1.5 text-left text-rose-600 hover:bg-rose-50 hover:text-rose-700 font-medium border-t border-slate-100 mt-0.5"
                  >
                    Hapus
                  </button>
                ) : null}
              </>
            );
          })()}
        </div>,
        document.body
      )}

      <section className="bg-white border border-neutral-200/90 rounded-2xl shadow-xs p-4 space-y-3">
        <div>
          <h3 className="font-bold text-sm text-neutral-900">Departemen Alokasi Pembelian</h3>
          <p className="text-[11px] text-neutral-500 mt-0.5">
            Centang departemen yang boleh dipilih di form pembelian. Belum dikonfigurasi = semua departemen aktif.
            Master departemen tetap di HRD → Departemen & Jabatan.
          </p>
        </div>
        {departments.length === 0 && !loading && (
          <div className="text-[11px] text-neutral-500">Belum ada departemen HR pada properti ini.</div>
        )}
        <div className="space-y-1">
          {departments.map((dept) => {
            const checked = allowListConfigured ? dept.allowed : dept.is_active;
            return (
              <label
                key={dept.id}
                className="flex items-center justify-between gap-3 border border-neutral-200 rounded-lg px-2.5 py-1.5 text-xs"
              >
                <span className="font-medium text-neutral-800 truncate">
                  {dept.name}
                  {!dept.is_active && <span className="ml-1.5 text-neutral-400 font-normal">Nonaktif</span>}
                </span>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!dept.is_active || savingDepts}
                  onChange={() => handleToggleDepartment(dept)}
                  className="shrink-0"
                />
              </label>
            );
          })}
        </div>
      </section>
    </div>
  );
};
