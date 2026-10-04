import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { authenticatedFetch } from '../../lib/authenticatedFetch';
import { useAuth } from '../auth/AuthContext';
import { getMasterProductCapabilities } from './productMasterPermissions';

export interface ProductItem {
  id: number;
  item_code?: string | null;
  name: string;
  category_id?: number | null;
  category_name?: string | null;
  price: number | string;
  is_active?: boolean;
  description?: string | null;
}

export interface CategoryOption {
  id: number;
  name: string;
}

interface Props {
  propertyId: number | null;
  items?: ProductItem[];
  onRefresh?: () => void;
}

type StatusFilter = 'active' | 'inactive' | 'all';

function formatIDR(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0
  }).format(amount);
}

export default function ProductMasterPage({ propertyId, items: initialItems, onRefresh }: Props) {
  const { effectiveAccess, granularPermissions, hasGranularPermission } = useAuth();
  const capabilities = useMemo(
    () => getMasterProductCapabilities(effectiveAccess, granularPermissions, hasGranularPermission),
    [effectiveAccess, granularPermissions, hasGranularPermission]
  );

  const [internalItems, setInternalItems] = useState<ProductItem[]>(initialItems || []);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [loading, setLoading] = useState<boolean>(!initialItems || initialItems.length === 0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [editingItem, setEditingItem] = useState<ProductItem | null>(null);
  const [saving, setSaving] = useState(false);
  // Harga disimpan sebagai string agar "kosong" bisa dibedakan dari "0".
  const [newProduct, setNewProduct] = useState({
    code: '',
    name: '',
    category: '',
    price: '',
    description: ''
  });
  const [editProduct, setEditProduct] = useState({
    code: '',
    name: '',
    category: '',
    price: '',
    description: ''
  });
  const [categoryForm, setCategoryForm] = useState<{ mode: 'add' | 'rename'; id?: number; name: string }>({ mode: 'add', name: '' });

  // Dua generasi TERPISAH:
  //  - propGenRef: bertambah HANYA saat propertyId berubah (termasuk null, A→B→A).
  //    Digunakan untuk memvalidasi snapshot mutasi vs. konteks properti terkini.
  //  - fetchGenRef: bertambah setiap pemanggilan loadProducts — hanya melindungi
  //    respons fetch katalog; TIDAK dipakai sebagai validasi mutasi.
  const propGenRef = useRef(0);
  const fetchGenRef = useRef(0);
  // Konteks TERKINI (property + filter) untuk refresh pasca-mutasi. Diperbarui
  // oleh effect [statusFilter, propertyId] & [propertyId], TIDAK dibaca dari
  // closure handler submit. Handler mutasi membaca ref ini SETELAH guard.
  const ctxRef = useRef<{ propertyId: number | null; statusFilter: StatusFilter }>({ propertyId: null, statusFilter: 'active' });

  const loadProducts = useCallback(async (status: StatusFilter = statusFilter, propertyOverride?: number | null) => {
    const pid = propertyOverride !== undefined ? propertyOverride : propertyId;
    if (!pid) return;
    const fetchGen = ++fetchGenRef.current; // hanya fetch ini yang terproteksi
    const isStaleFetch = () => fetchGenRef.current !== fetchGen;
    try {
      setLoading(true);
      setErrorMsg(null);
      const res = await authenticatedFetch(`/api/pos/menu?property_id=${pid}&status=${status}`);
      const json = await res.json().catch(() => null);
      // Guard fetch: diperiksa SETELAH res.json() dan SEBELUM menulis state.
      if (isStaleFetch()) return;
      if (!res.ok) {
        throw new Error((json as any)?.message || 'Gagal memuat katalog master produk');
      }
      setInternalItems((json as any)?.data?.items || []);
      setCategories((json as any)?.data?.categories || []);
    } catch (err: any) {
      if (isStaleFetch()) return;
      setErrorMsg(err?.message || 'Gagal memuat katalog produk');
    } finally {
      if (!isStaleFetch()) setLoading(false);
    }
  }, [propertyId, statusFilter]);

  // propertyId berubah (termasuk null, A→B→A):
  //  - Bump generation properti → semua snapshot mutasi lama otomatis stale.
  //  - Reset saving: request mutasi lama tidak boleh memegang saving milik
  //    properti/ksitusi baru (identity mutasi di finally mengurasi hal ini).
  //  - Bersihkan data/modal/draft. Bila null, state kosong — jangan memuat.
  useEffect(() => {
    propGenRef.current += 1;
    ctxRef.current = { propertyId, statusFilter: 'active' };
    setSaving(false);
    if (!propertyId) {
      setInternalItems([]);
      setCategories([]);
      setEditingItem(null);
      setShowAddModal(false);
      setShowCategoryModal(false);
      setSelectedCategory('ALL');
      setSearchQuery('');
      setErrorMsg(null);
      setSuccessMsg(null);
      setLoading(false);
      return;
    }
    setNewProduct({ code: '', name: '', category: '', price: '', description: '' });
    setEditProduct({ code: '', name: '', category: '', price: '', description: '' });
    setEditingItem(null);
    setShowAddModal(false);
    setShowCategoryModal(false);
    setSelectedCategory('ALL');
    setSearchQuery('');
    setErrorMsg(null);
    setSuccessMsg(null);
    setLoading(true);
    void loadProducts('active', propertyId);
  }, [propertyId]); // sengaja hanya propertyId; loadProducts di deps karena useMemo

  // Respons API adalah SATU-SATUNYA sumber data tabel. initialItems dari parent
  // TIDAK disinkronkan ke state (seeding awal saja via useState di atas).
  // Muat ulang saat statusFilter berubah (tetap properti yang sama).
  useEffect(() => {
    ctxRef.current = { propertyId, statusFilter };
    if (propertyId) {
      void loadProducts(statusFilter, propertyId);
    }
  }, [statusFilter, propertyId]);

  useEffect(() => {
    if (successMsg) {
      const timer = window.setTimeout(() => setSuccessMsg(null), 4000);
      return () => window.clearTimeout(timer);
    }
  }, [successMsg]);

  const items = internalItems;

  const categoryNames = useMemo(
    () => categories.map((c) => c.name),
    [categories]
  );

  // Statistik. Karena data dimuat sesuai statusFilter, hanya klaim angka yang
  // valid untuk subset saat ini. Bila filter 'all', total/active/inactive lengkap.
  // Bila filter 'active'/'inactive', jumlah total adalah subset, bukan seluruh.
  const stats = useMemo(() => {
    if (statusFilter === 'all') {
      const total = items.length;
      const active = items.filter((i) => i.is_active !== false).length;
      const inactive = total - active;
      return { total, active, inactive, categories: categories.length, complete: true };
    }
    // Subset: hanya total subset yang benar; active/inactive tidak bisa dihitung
    // lengkap karena data di-filter.
    return { total: items.length, active: 0, inactive: 0, categories: categories.length, complete: false };
  }, [items, categories, statusFilter]);

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const matchSearch =
        searchQuery === '' ||
        item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (item.item_code && item.item_code.toLowerCase().includes(searchQuery.toLowerCase()));
      const matchCategory =
        selectedCategory === 'ALL' ||
        (selectedCategory !== 'NONE'
          ? (item.category_name || 'Tanpa Kategori') === selectedCategory
          : item.category_name === null || item.category_name === undefined || item.category_name === '');
      const matchStatus =
        statusFilter === 'all' ||
        (statusFilter === 'active' ? item.is_active !== false : item.is_active === false);
      return matchSearch && matchCategory && matchStatus;
    });
  }, [items, searchQuery, selectedCategory, statusFilter]);

  const handleRefresh = async () => {
    const { propertyId: pid, statusFilter: sf } = ctxRef.current;
    await loadProducts(sf, pid);
    onRefresh?.();
  };

  // Helper: ubah input harga (string) jadi number untuk submit.
  // - "kosong" / undefined => null (jangan kirim).
  // - "0" => 0 (harus tersimpan, bukan kosong).
  // - angka valid >= 0 => number.
  // - invalid => NaN (diblokir sebelum submit).
  const parsePriceInput = (raw: string): number | null | 'INVALID' => {
    const t = raw.trim();
    if (t === '') return null; // sengaja tidak mengirim field (preservasi nilai lama pada PATCH).
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return 'INVALID';
    return n;
  };

  // Snapshot submit: { pid, propGen, mutGen }. mutGen membedakan mutasi
  // berurutan agar finally request lama tidak mereset saving milik mutasi baru.
  const savingMutGen = useRef(0); // mutasi terakhir yang memegang saving

  const isMutationStale = (ctx: { pid: number; propGen: number; mutGen: number }): boolean =>
    propGenRef.current !== ctx.propGen; // properti sudah berganti (A→B→A, →null, dll.)

  const handleAddProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!capabilities.canCreate) return;
    if (!propertyId || newProduct.name.trim() === '') {
      if (newProduct.name.trim() === '') setErrorMsg('Nama produk wajib diisi');
      return;
    }
    // Harga wajib diisi dan valid.
    const priceVal = parsePriceInput(newProduct.price);
    if (priceVal === 'INVALID') {
      setErrorMsg('Harga tidak valid: gunakan angka 0 atau lebih besar');
      return;
    }
    if (priceVal === null) {
      setErrorMsg('Harga jual wajib diisi');
      return;
    }
    // Snapshot submit SEBELUM await: propertyId + generation properti terkini.
    const targetPropertyId = propertyId;
    const ctx = { pid: targetPropertyId, propGen: propGenRef.current, mutGen: ++savingMutGen.current };
    const stale = () => isMutationStale(ctx); // properti A→B→A → propGen naik → stale
    try {
      setSaving(true);
      setErrorMsg(null);
      const res = await authenticatedFetch('/api/pos/menu/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: targetPropertyId,
          name: newProduct.name.trim(),
          item_code: newProduct.code.trim() === '' ? null : newProduct.code.trim().toUpperCase(),
          category_id: newProduct.category === '' ? null : Number(newProduct.category) || null,
          price: priceVal,
          description: newProduct.description.trim() === '' ? null : newProduct.description.trim()
        })
      });
      const json = await res.json().catch(() => null);
      if (stale()) return; // properti sudah berganti — abaikan respons submit lama
      if (!res.ok) {
        throw new Error((json as any)?.message || 'Gagal menyimpan produk master');
      }
      setSuccessMsg(`Produk "${newProduct.name.trim()}" berhasil ditambahkan ke katalog master.`);
      setShowAddModal(false);
      setNewProduct({ code: '', name: '', category: '', price: '', description: '' });
      // Refresh memakai konteks TERKINI dari ref, bukan closure submit lama.
      const { propertyId: curPid, statusFilter: curSf } = ctxRef.current;
      await loadProducts(curSf, curPid);
      if (stale()) return; // properti/filter berubah selama refresh — jangan notifikasi
      onRefresh?.();
    } catch (err: any) {
      if (!stale()) setErrorMsg(err?.message || 'Gagal menambahkan produk');
    } finally {
      // Hanya mutasi ini yang boleh mereset saving (identity mutasi) — request
      // lama tidak boleh mereset saving milik mutasi/properti baru.
      if (!stale() && ctx.mutGen === savingMutGen.current) setSaving(false);
    }
  };

  const handleEditSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!capabilities.canEdit || !editingItem) return;
    if (!propertyId) return;
    if (editProduct.name.trim() === '') {
      setErrorMsg('Nama produk wajib diisi');
      return;
    }
    // Validasi harga: kosong => tidak ubah harga; invalid => blok.
    const priceVal = parsePriceInput(editProduct.price);
    if (priceVal === 'INVALID') {
      setErrorMsg('Harga tidak valid: gunakan angka 0 atau lebih besar');
      return;
    }
    const targetPropertyId = propertyId;
    const ctx = { pid: targetPropertyId, propGen: propGenRef.current, mutGen: ++savingMutGen.current };
    const stale = () => isMutationStale(ctx);
    try {
      setSaving(true);
      setErrorMsg(null);
      const patch: Record<string, any> = {
        property_id: targetPropertyId,
        name: editProduct.name.trim(),
      };
      patch.item_code = editProduct.code.trim() === '' ? null : editProduct.code.trim().toUpperCase();
      patch.description = editProduct.description.trim() === '' ? null : editProduct.description.trim();
      patch.category_id = editProduct.category === '' ? null : Number(editProduct.category) || null;
      // Harga: kirim hanya bila valid (bukan kosong). "0" dikirim sebagai 0.
      if (priceVal !== null) {
        patch.price = priceVal;
      }
      const res = await authenticatedFetch(`/api/pos/menu/items/${editingItem.id}?property_id=${targetPropertyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      const json = await res.json().catch(() => null);
      if (stale()) return; // properti sudah berganti — abaikan respons submit lama
      if (!res.ok) {
        throw new Error((json as any)?.message || 'Gagal menyimpan perubahan produk');
      }
      setSuccessMsg(`Produk "${editProduct.name.trim()}" berhasil diperbarui.`);
      setEditingItem(null);
      // Refresh memakai konteks TERKINI dari ref, bukan closure submit lama.
      const { propertyId: curPid, statusFilter: curSf } = ctxRef.current;
      await loadProducts(curSf, curPid);
      if (stale()) return;
      onRefresh?.();
    } catch (err: any) {
      if (!stale()) setErrorMsg(err?.message || 'Gagal memperbarui produk');
    } finally {
      if (!stale() && ctx.mutGen === savingMutGen.current) setSaving(false);
    }
  };

  const handleToggleActive = async (item: ProductItem) => {
    if (!capabilities.canToggleStatus) return;
    if (!propertyId) return;
    const activating = item.is_active === false;
    const label = activating ? 'mengaktifkan' : 'menonaktifkan';
    if (!window.confirm(`Yakin ingin ${label} produk "${item.name}"?`)) return;
    const targetPropertyId = propertyId;
    const ctx = { pid: targetPropertyId, propGen: propGenRef.current, mutGen: ++savingMutGen.current };
    const stale = () => isMutationStale(ctx);
    try {
      setSaving(true);
      setErrorMsg(null);
      const res = await authenticatedFetch(`/api/pos/menu/items/${item.id}?property_id=${targetPropertyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: targetPropertyId, is_active: activating })
      });
      const json = await res.json().catch(() => null);
      if (stale()) return; // properti sudah berganti — abaikan respons submit lama
      if (!res.ok) {
        throw new Error((json as any)?.message || 'Gagal mengubah status produk');
      }
      setSuccessMsg(`Produk "${item.name}" berhasil ${activating ? 'diaktifkan' : 'dinonaktifkan'}.`);
      // Refresh memakai konteks TERKINI dari ref, bukan closure submit lama.
      const { propertyId: curPid, statusFilter: curSf } = ctxRef.current;
      await loadProducts(curSf, curPid);
      if (stale()) return;
      onRefresh?.();
    } catch (err: any) {
      if (!stale()) setErrorMsg(err?.message || 'Gagal mengubah status produk');
    } finally {
      if (!stale() && ctx.mutGen === savingMutGen.current) setSaving(false);
    }
  };

  const openEdit = (item: ProductItem) => {
    if (!capabilities.canEdit) return;
    setEditProduct({
      code: item.item_code || '',
      name: item.name || '',
      category: item.category_id != null ? String(item.category_id) : '',
      // Simpan harga sebagai string agar 0 tampil "0", bukan kosong.
      price: item.price === 0 ? '0' : String(item.price ?? ''),
      description: item.description || ''
    });
    setEditingItem(item);
  };

  // ── Kategori: tambah / rename / hapus ──────────────────────────────────────
  const handleCategorySave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!capabilities.canManageCategory) return;
    if (!propertyId) return;
    const name = categoryForm.name.trim();
    if (name === '') {
      setErrorMsg('Nama kategori wajib diisi');
      return;
    }
    const targetPropertyId = propertyId;
    const ctx = { pid: targetPropertyId, propGen: propGenRef.current, mutGen: ++savingMutGen.current };
    const stale = () => isMutationStale(ctx);
    try {
      setSaving(true);
      setErrorMsg(null);
      if (categoryForm.mode === 'add') {
        const res = await authenticatedFetch('/api/pos/menu/categories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ property_id: targetPropertyId, name })
        });
        const json = await res.json().catch(() => null);
        if (stale()) return; // properti sudah berganti — abaikan respons submit lama
        if (!res.ok) throw new Error((json as any)?.message || 'Gagal menambah kategori');
        setSuccessMsg(`Kategori "${name}" berhasil ditambahkan.`);
      } else {
        const res = await authenticatedFetch(
          `/api/pos/menu/categories/${categoryForm.id}?property_id=${targetPropertyId}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ property_id: targetPropertyId, name })
          }
        );
        const json = await res.json().catch(() => null);
        if (stale()) return; // properti sudah berganti — abaikan respons submit lama
        if (!res.ok) throw new Error((json as any)?.message || 'Gagal mengganti nama kategori');
        setSuccessMsg(`Kategori berhasil diubah menjadi "${name}".`);
      }
      setShowCategoryModal(false);
      setCategoryForm({ mode: 'add', name: '' });
      // Refresh memakai konteks TERKINI dari ref, bukan closure submit lama.
      const { propertyId: curPid, statusFilter: curSf } = ctxRef.current;
      await loadProducts(curSf, curPid);
      if (stale()) return;
      onRefresh?.();
    } catch (err: any) {
      if (!stale()) setErrorMsg(err?.message || 'Gagal menyimpan kategori');
    } finally {
      if (!stale() && ctx.mutGen === savingMutGen.current) setSaving(false);
    }
  };

  const handleDeleteCategory = async (cat: CategoryOption) => {
    if (!capabilities.canDeleteCategory) return;
    if (!propertyId) return;
    if (!window.confirm(`Hapus kategori "${cat.name}"? Hanya dapat dihapus bila tidak dipakai produk apa pun.`)) return;
    const targetPropertyId = propertyId;
    const ctx = { pid: targetPropertyId, propGen: propGenRef.current, mutGen: ++savingMutGen.current };
    const stale = () => isMutationStale(ctx);
    try {
      setSaving(true);
      setErrorMsg(null);
      const res = await authenticatedFetch(
        `/api/pos/menu/categories/${cat.id}?property_id=${targetPropertyId}`,
        { method: 'DELETE' }
      );
      const json = await res.json().catch(() => null);
      if (stale()) return; // properti sudah berganti — abaikan respons submit lama
      if (!res.ok) throw new Error((json as any)?.message || 'Gagal menghapus kategori');
      setSuccessMsg(`Kategori "${cat.name}" berhasil dihapus.`);
      // Refresh memakai konteks TERKINI dari ref, bukan closure submit lama.
      const { propertyId: curPid, statusFilter: curSf } = ctxRef.current;
      await loadProducts(curSf, curPid);
      if (stale()) return;
      onRefresh?.();
    } catch (err: any) {
      if (!stale()) setErrorMsg(err?.message || 'Gagal menghapus kategori');
    } finally {
      if (!stale() && ctx.mutGen === savingMutGen.current) setSaving(false);
    }
  };

  const openAddCategory = () => {
    if (!capabilities.canManageCategory) return;
    setCategoryForm({ mode: 'add', name: '' });
    setShowCategoryModal(true);
  };

  const openRenameCategory = (cat: CategoryOption) => {
    if (!capabilities.canManageCategory) return;
    setCategoryForm({ mode: 'rename', id: cat.id, name: cat.name });
    setShowCategoryModal(true);
  };

  return (
    <div className="space-y-6 pb-12">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-6 rounded-2xl border border-gray-200/80 shadow-xs">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold tracking-wider bg-emerald-50 text-emerald-800 border border-emerald-200/60 uppercase">
              Master Data Manajemen
            </span>
            <span className="text-xs text-gray-400">•</span>
            <span className="text-xs text-gray-500">Property #{propertyId || 1}</span>
          </div>
          <h1 className="text-2xl font-black text-gray-900 tracking-tight">Master Produk &amp; Layanan</h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">
            Katalog master produk hotel untuk operasional POS Restoran, Minibar, Room Service, dan Folio Charges.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleRefresh}
            className="p-2.5 rounded-xl border border-gray-200 hover:bg-gray-50 text-gray-600 transition-colors cursor-pointer"
            title="Refresh Data"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          {capabilities.canManageCategory && (
            <button
              type="button"
              onClick={openAddCategory}
              className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-gray-200 hover:bg-gray-50 text-gray-700 text-xs sm:text-sm font-semibold shadow-xs transition-colors cursor-pointer"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              Kelola Kategori
            </button>
          )}
          {capabilities.canCreate && (
            <button
              type="button"
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs sm:text-sm font-semibold shadow-xs transition-colors cursor-pointer"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
              </svg>
              Tambah Produk
            </button>
          )}
        </div>
      </div>

      {/* Notification banners */}
      {errorMsg && (
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-xl text-rose-800 text-xs flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-2">
            <span>⚠</span>
            <span>{errorMsg}</span>
          </div>
          <button onClick={() => setErrorMsg(null)} className="text-rose-600 hover:text-rose-900 font-bold ml-2">✕</button>
        </div>
      )}
      {successMsg && (
        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800 text-xs flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-2">
            <span>✓</span>
            <span>{successMsg}</span>
          </div>
          <button onClick={() => setSuccessMsg(null)} className="text-emerald-600 hover:text-emerald-900 font-bold ml-2">✕</button>
        </div>
      )}

      {/* KPI Overview (berdasarkan data aktual sesuai filter status) */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-gray-500 font-medium">
            Produk {statusFilter === 'all' ? 'Terdaftar' : statusFilter === 'active' ? 'Aktif' : 'Nonaktif'}
          </div>
          <div className="text-2xl font-black text-gray-900 mt-1">{stats.total}</div>
          <div className="text-[11px] text-gray-400 mt-0.5">Jumlah item pada filter saat ini</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-gray-500 font-medium">Produk Aktif</div>
          <div className="text-2xl font-black text-emerald-700 mt-1">
            {stats.complete ? stats.active : statusFilter === 'active' ? stats.total : '—'}
          </div>
          <div className="text-[11px] text-gray-400 mt-0.5">
            {stats.complete ? 'Tersedia untuk dijual' : 'Pilih filter "Semua" untuk hitung lengkap'}
          </div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-gray-500 font-medium">Produk Nonaktif</div>
          <div className="text-2xl font-black text-amber-600 mt-1">
            {stats.complete ? stats.inactive : statusFilter === 'inactive' ? stats.total : '—'}
          </div>
          <div className="text-[11px] text-gray-400 mt-0.5">
            {stats.complete ? 'Tidak tampil di POS' : 'Pilih filter "Semua" untuk hitung lengkap'}
          </div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-gray-500 font-medium">Kategori</div>
          <div className="text-2xl font-black text-gray-900 mt-1">{stats.categories}</div>
          <div className="text-[11px] text-gray-400 mt-0.5">Kategori yang tersedia</div>
        </div>
      </div>

      {/* Search & Filter Toolbar */}
      <div className="bg-white border border-gray-200/90 rounded-2xl p-4 shadow-xs flex flex-col gap-3">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="relative w-full sm:w-80">
            <svg className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="Cari nama produk atau kode..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
            />
          </div>

          <div className="flex items-center gap-2 overflow-x-auto w-full sm:w-auto pb-1 sm:pb-0">
            <button
              type="button"
              onClick={() => setSelectedCategory('ALL')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                selectedCategory === 'ALL'
                  ? 'bg-emerald-800 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              Semua Kategori
            </button>
            {categoryNames.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                  selectedCategory === cat
                    ? 'bg-emerald-800 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400 font-medium shrink-0">Status:</span>
          {(['active', 'inactive', 'all'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                statusFilter === s
                  ? 'bg-emerald-800 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {s === 'active' ? 'Aktif' : s === 'inactive' ? 'Nonaktif' : 'Semua'}
            </button>
          ))}
        </div>
      </div>

      {/* Product List Table / States */}
      {loading ? (
        <div className="bg-white border border-gray-200 rounded-2xl p-12 text-center text-gray-500 shadow-xs">
          <div className="text-base font-bold text-gray-800">Memuat Katalog Produk…</div>
          <div className="text-xs text-gray-400 mt-1">Mengambil data dari server</div>
        </div>
      ) : errorMsg && items.length === 0 ? (
        <div className="bg-white border border-rose-200 rounded-2xl p-12 text-center text-rose-700 shadow-xs">
          <div className="text-base font-bold">Gagal Memuat Katalog Produk</div>
          <div className="text-xs text-rose-500 mt-1">{errorMsg}</div>
          <div className="mt-4">
            <button
              type="button"
              onClick={handleRefresh}
              className="px-4 py-2 bg-emerald-800 text-white rounded-lg text-xs font-semibold hover:bg-emerald-900 cursor-pointer"
            >
              Coba Lagi
            </button>
          </div>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs sm:text-sm">
              <thead className="bg-gray-50/80 border-b border-gray-200 text-gray-600 font-semibold uppercase text-[11px] tracking-wider">
                <tr>
                  <th className="py-3 px-4">Kode / SKU</th>
                  <th className="py-3 px-4">Nama Produk</th>
                  <th className="py-3 px-4">Kategori</th>
                  <th className="py-3 px-4 text-right">Harga Jual (IDR)</th>
                  <th className="py-3 px-4 text-center">Status</th>
                  <th className="py-3 px-4 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-gray-400">
                      Tidak ada produk yang cocok dengan pencarian.
                    </td>
                  </tr>
                ) : (
          filteredItems.map((item) => (
            <tr key={item.id} className="hover:bg-gray-50/60 transition-colors">
              <td className="py-3 px-4 font-mono font-medium text-gray-600">
                {item.item_code || `PRD-${String(item.id).padStart(4, '0')}`}
              </td>
              <td className="py-3 px-4 font-semibold text-gray-900">
                {item.name}
                {item.description && (
                  <div className="text-[11px] text-gray-400 font-normal mt-0.5">{item.description}</div>
                )}
              </td>
              <td className="py-3 px-4">
                <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${
                  item.category_name
                    ? 'bg-slate-100 text-slate-700 border-slate-200'
                    : 'bg-gray-50 text-gray-400 border-gray-200'
                }`}>
                  {item.category_name || 'Tanpa Kategori'}
                </span>
              </td>
              <td className="py-3 px-4 text-right font-bold text-gray-900">
                {formatIDR(Number(item.price))}
              </td>
              <td className="py-3 px-4 text-center">
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
                  item.is_active !== false
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : 'bg-amber-50 text-amber-700 border-amber-200'
                }`}>
                  {item.is_active !== false ? 'Aktif' : 'Nonaktif'}
                </span>
              </td>
              <td className="py-3 px-4 text-right space-x-1">
                {(capabilities.canEdit || capabilities.canToggleStatus) ? (
                  <>
                    {capabilities.canEdit && (
                      <button
                        type="button"
                        onClick={() => openEdit(item)}
                        disabled={saving}
                        className="text-xs text-emerald-700 hover:text-emerald-900 font-medium px-2 py-1 rounded hover:bg-emerald-50 transition-colors cursor-pointer"
                      >
                        Edit
                      </button>
                    )}
                    {capabilities.canToggleStatus && (
                      <button
                        type="button"
                        onClick={() => handleToggleActive(item)}
                        disabled={saving}
                        className={`text-xs font-medium px-2 py-1 rounded transition-colors cursor-pointer ${
                          item.is_active !== false
                            ? 'text-rose-600 hover:text-rose-800 hover:bg-rose-50'
                            : 'text-emerald-700 hover:text-emerald-900 hover:bg-emerald-50'
                        }`}
                      >
                        {item.is_active !== false ? 'Nonaktifkan' : 'Aktifkan'}
                      </button>
                    )}
                  </>
                ) : (
                  <span className="text-[11px] text-gray-400">Hanya lihat</span>
                )}
              </td>
            </tr>
          ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add Product Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 border border-gray-200 max-h-[85vh] overflow-y-auto">
            <h3 className="text-lg font-bold text-gray-900 mb-1">Tambah Produk Baru</h3>
            <p className="text-xs text-gray-500 mb-4">Daftarkan item produk master untuk katalog hotel.</p>

            {errorMsg && (
              <div className="mb-4 px-3 py-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center justify-between">
                <span>{errorMsg}</span>
                <button type="button" onClick={() => setErrorMsg(null)} className="font-bold hover:text-rose-900">✕</button>
              </div>
            )}

            <form onSubmit={handleAddProduct} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Kode / SKU (Opsional)</label>
                <input
                  type="text"
                  placeholder="Contoh: FNB-001"
                  value={newProduct.code}
                  onChange={(e) => setNewProduct({ ...newProduct, code: e.target.value.toUpperCase() })}
                  className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Nama Produk *</label>
                <input
                  type="text"
                  required
                  placeholder="Contoh: Nasi Goreng Spesial"
                  value={newProduct.name}
                  onChange={(e) => setNewProduct({ ...newProduct, name: e.target.value })}
                  className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Kategori</label>
                <select
                  value={newProduct.category}
                  onChange={(e) => setNewProduct({ ...newProduct, category: e.target.value })}
                  className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2"
                >
                  <option value="">— Tanpa Kategori —</option>
                  {categories.map((c) => (
                    <option key={c.id} value={String(c.id)}>{c.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Harga Jual (IDR) *</label>
                <input
                  type="number"
                  required
                  min="0"
                  step="1000"
                  placeholder="Contoh: 45000 (0 untuk gratis)"
                  value={newProduct.price}
                  onChange={(e) => setNewProduct({ ...newProduct, price: e.target.value })}
                  className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 font-mono"
                />
                <div className="text-[11px] text-gray-400 mt-0.5">Kosong = wajib diisi; 0 = harga gratis.</div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Deskripsi Produk (Opsional)</label>
                <textarea
                  rows={2}
                  placeholder="Keterangan singkat komposisi atau sajian..."
                  value={newProduct.description}
                  onChange={(e) => setNewProduct({ ...newProduct, description: e.target.value })}
                  className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t border-gray-100 sticky bottom-0 bg-white">
                <button
                  type="button"
                  onClick={() => { setShowAddModal(false); setErrorMsg(null); }}
                  disabled={saving}
                  className="px-4 py-2 text-xs font-semibold text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg cursor-pointer disabled:opacity-50"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg cursor-pointer disabled:opacity-50"
                >
                  {saving ? 'Menyimpan…' : 'Simpan Produk'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Product Modal */}
      {editingItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 border border-gray-200 max-h-[85vh] overflow-y-auto">
            <h3 className="text-lg font-bold text-gray-900 mb-1">Edit Produk</h3>
            <p className="text-xs text-gray-500 mb-4">Ubah data produk "{editingItem.name}".</p>

            {errorMsg && (
              <div className="mb-4 px-3 py-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center justify-between">
                <span>{errorMsg}</span>
                <button type="button" onClick={() => setErrorMsg(null)} className="font-bold hover:text-rose-900">✕</button>
              </div>
            )}

            <form onSubmit={handleEditSave} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Kode / SKU</label>
                <input
                  type="text"
                  value={editProduct.code}
                  onChange={(e) => setEditProduct({ ...editProduct, code: e.target.value.toUpperCase() })}
                  className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Nama Produk *</label>
                <input
                  type="text"
                  required
                  value={editProduct.name}
                  onChange={(e) => setEditProduct({ ...editProduct, name: e.target.value })}
                  className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Kategori</label>
                <select
                  value={editProduct.category}
                  onChange={(e) => setEditProduct({ ...editProduct, category: e.target.value })}
                  className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2"
                >
                  <option value="">— Tanpa Kategori —</option>
                  {categories.map((c) => (
                    <option key={c.id} value={String(c.id)}>{c.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Harga Jual (IDR)</label>
                <input
                  type="number"
                  min="0"
                  step="1000"
                  value={editProduct.price}
                  onChange={(e) => setEditProduct({ ...editProduct, price: e.target.value })}
                  className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 font-mono"
                />
                <div className="text-[11px] text-gray-400 mt-0.5">Kosong = tidak mengubah harga; 0 = gratis.</div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Deskripsi Produk</label>
                <textarea
                  rows={2}
                  value={editProduct.description}
                  onChange={(e) => setEditProduct({ ...editProduct, description: e.target.value })}
                  className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t border-gray-100 sticky bottom-0 bg-white">
                <button
                  type="button"
                  onClick={() => { setEditingItem(null); setErrorMsg(null); }}
                  disabled={saving}
                  className="px-4 py-2 text-xs font-semibold text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg cursor-pointer disabled:opacity-50"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg cursor-pointer disabled:opacity-50"
                >
                  {saving ? 'Menyimpan…' : 'Simpan Perubahan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Category Management Modal */}
      {showCategoryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 border border-gray-200 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-900">
                {categoryForm.mode === 'add' ? 'Tambah Kategori' : 'Ganti Nama Kategori'}
              </h3>
              <button
                type="button"
                onClick={() => setShowCategoryModal(false)}
                className="text-gray-400 hover:text-gray-600 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCategorySave} className="space-y-4">
              {errorMsg && (
                <div className="px-3 py-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center justify-between">
                  <span>{errorMsg}</span>
                  <button type="button" onClick={() => setErrorMsg(null)} className="font-bold hover:text-rose-900">✕</button>
                </div>
              )}
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Nama Kategori *</label>
                <input
                  type="text"
                  required
                  maxLength={100}
                  value={categoryForm.name}
                  onChange={(e) => setCategoryForm({ ...categoryForm, name: e.target.value })}
                  className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t border-gray-100 sticky bottom-0 bg-white">
                <button
                  type="button"
                  onClick={() => { setShowCategoryModal(false); setErrorMsg(null); }}
                  disabled={saving}
                  className="px-4 py-2 text-xs font-semibold text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg cursor-pointer disabled:opacity-50"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg cursor-pointer disabled:opacity-50"
                >
                  {saving ? 'Menyimpan…' : categoryForm.mode === 'add' ? 'Tambah' : 'Simpan'}
                </button>
              </div>
            </form>

            {/* Existing categories list */}
            <div className="mt-6 border-t border-gray-100 pt-4">
              <div className="text-xs font-semibold text-gray-600 mb-2">Kelola Kategori</div>
              {categories.length === 0 ? (
                <div className="text-xs text-gray-400">Belum ada kategori.</div>
              ) : (
                <div className="space-y-1">
                  {categories.map((cat) => (
                    <div key={cat.id} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg">
                      <span className="text-xs font-medium text-gray-800">{cat.name}</span>
                      <div className="flex gap-1">
                        {capabilities.canManageCategory && (
                          <button
                            type="button"
                            onClick={() => openRenameCategory(cat)}
                            disabled={saving}
                            className="text-[11px] text-emerald-700 hover:text-emerald-900 font-medium px-1.5 py-0.5 rounded hover:bg-emerald-50 cursor-pointer"
                          >
                            Ganti
                          </button>
                        )}
                        {capabilities.canDeleteCategory && (
                          <button
                            type="button"
                            onClick={() => handleDeleteCategory(cat)}
                            disabled={saving}
                            className="text-[11px] text-rose-600 hover:text-rose-800 font-medium px-1.5 py-0.5 rounded hover:bg-rose-50 cursor-pointer"
                          >
                            Hapus
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="text-[11px] text-gray-400 mt-2">
                Kategori yang masih dipakai produk tidak dapat dihapus.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
