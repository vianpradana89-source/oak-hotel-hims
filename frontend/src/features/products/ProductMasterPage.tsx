import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { authenticatedFetch } from '../../lib/authenticatedFetch';
import { useAuth } from '../auth/AuthContext';
import { getMasterProductCapabilities } from './productMasterPermissions';

export type ProductTypeCode = 'RAW_MATERIAL' | 'SEMI_FINISHED' | 'FINISHED_GOOD';
export type ProductKindCode = 'STANDARD';
export type RoadmapProductKindCode = 'WEIGHED' | 'UNLIMITED' | 'SERVICE' | 'BUNDLE' | 'FORMULA';

export interface ProductItem {
  id: number;
  item_code?: string | null;
  barcode?: string | null;
  name: string;
  category_id?: number | null;
  category_name?: string | null;
  price: number | string | null;
  is_active?: boolean;
  is_sellable_pos?: boolean;
  product_type?: ProductTypeCode | string | null;
  product_type_label?: string;
  product_kind?: ProductKindCode | string | null;
  product_kind_label?: string;
  base_unit?: string | null;
  description?: string | null;
  has_photo?: boolean;
  photo_url?: string | null;
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
type ProductTypeFilter = 'ALL' | 'FINISHED_GOOD' | 'SEMI_FINISHED' | 'RAW_MATERIAL' | 'UNSET';
type SellableFilter = 'all' | 'sellable' | 'internal';

export interface ProductFormState {
  code: string;
  barcode: string;
  name: string;
  category: string;
  price: string;
  description: string;
  productType: string;
  productKind: string;
  baseUnit: string;
  isSellablePos: boolean;
}

export const EMPTY_PRODUCT_FORM: ProductFormState = {
  code: '',
  barcode: '',
  name: '',
  category: '',
  price: '',
  description: '',
  productType: '',
  productKind: 'STANDARD',
  baseUnit: '',
  isSellablePos: true,
};

export const PRODUCT_PHOTO_MAX_BYTES = 2 * 1024 * 1024;
export const PRODUCT_PHOTO_ACCEPT = 'image/png,image/jpeg,image/webp';
const ALLOWED_PHOTO_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

export function normalizeBarcodeDraft(raw: string | null | undefined): string | null | 'TOO_LONG' {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  if (trimmed.length > 100) return 'TOO_LONG';
  return trimmed;
}

export function matchesProductSearch(item: ProductItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  if (item.name && item.name.toLowerCase().includes(q)) return true;
  if (item.item_code && item.item_code.toLowerCase().includes(q)) return true;
  if (item.barcode && item.barcode.toLowerCase().includes(q)) return true;
  return false;
}

export function validateProductPhotoFile(
  file: { type?: string; size?: number; name?: string } | null | undefined
): string | null {
  if (!file) return 'File foto tidak ditemukan';
  const mime = String(file.type || '').toLowerCase().trim();
  if (!ALLOWED_PHOTO_MIMES.has(mime)) {
    return 'Format foto harus PNG, JPEG, atau WebP';
  }
  const size = Number(file.size ?? 0);
  if (!Number.isFinite(size) || size <= 0) {
    return 'File foto kosong atau tidak valid';
  }
  if (size > PRODUCT_PHOTO_MAX_BYTES) {
    return 'Ukuran foto maksimal 2 MB';
  }
  return null;
}

export const PRODUCT_TYPE_TABS: Array<{ key: ProductTypeFilter; label: string }> = [
  { key: 'ALL', label: 'Semua Tipe' },
  { key: 'FINISHED_GOOD', label: 'Produk Jadi' },
  { key: 'SEMI_FINISHED', label: 'Setengah Jadi' },
  { key: 'RAW_MATERIAL', label: 'Bahan Baku' },
  { key: 'UNSET', label: 'Belum diatur' },
];

export const PRODUCT_TYPE_CHOICES: Array<{ value: ProductTypeCode; label: string; hint: string }> = [
  { value: 'FINISHED_GOOD', label: 'Produk Jadi', hint: 'Siap disajikan / dijual' },
  { value: 'SEMI_FINISHED', label: 'Setengah Jadi', hint: 'Olahan antara / prep' },
  { value: 'RAW_MATERIAL', label: 'Bahan Baku', hint: 'Bahan mentah / stok dasar' },
];

const COMMON_BASE_UNITS = ['Porsi', 'Pcs', 'Gelas', 'Botol', 'Kaleng', 'Cup', 'Pack', 'Box', 'Kg', 'Gram', 'Liter', 'Ml'];

export function resolveInitialProductTypeFromTab(tab: ProductTypeFilter): string {
  if (tab === 'FINISHED_GOOD' || tab === 'SEMI_FINISHED' || tab === 'RAW_MATERIAL') {
    return tab;
  }
  return '';
}

export function createInitialAddProductForm(tab: ProductTypeFilter): ProductFormState {
  return {
    ...EMPTY_PRODUCT_FORM,
    productType: resolveInitialProductTypeFromTab(tab),
  };
}

export function applyProductTypeChange(form: ProductFormState, nextType: string): ProductFormState {
  return {
    ...form,
    productType: nextType,
  };
}

export function buildEditProductForm(item: ProductItem): ProductFormState {
  return {
    code: item.item_code || '',
    barcode: typeof item.barcode === 'string' ? item.barcode : '',
    name: item.name || '',
    category: item.category_id != null ? String(item.category_id) : '',
    // Simpan harga sebagai string agar 0 tampil "0", sedangkan null tampil "".
    price: item.price === 0 ? '0' : item.price != null ? String(item.price) : '',
    description: item.description || '',
    productType: item.product_type || '',
    productKind: item.product_kind || '',
    baseUnit: item.base_unit || '',
    isSellablePos: item.is_sellable_pos !== false,
  };
}

export function formatPosSellabilityBadge(isSellablePos?: boolean | null): string {
  return isSellablePos === false ? 'Tidak dijual di POS' : 'Dijual di POS';
}

export function formatIDR(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0
  }).format(amount);
}

export function formatProductTypeLabel(productType?: string | null): string {
  if (!productType) return 'Belum diatur';
  switch (productType.toUpperCase()) {
    case 'FINISHED_GOOD':
      return 'Produk Jadi';
    case 'SEMI_FINISHED':
      return 'Setengah Jadi';
    case 'RAW_MATERIAL':
      return 'Bahan Baku';
    default:
      return 'Belum diatur';
  }
}

export function formatProductKindLabel(productKind?: string | null): string {
  if (!productKind) return 'Belum diatur';
  switch (productKind.toUpperCase()) {
    case 'STANDARD':
      return 'Biasa';
    case 'WEIGHED':
      return 'Timbangan';
    case 'UNLIMITED':
      return 'Unlimited';
    case 'SERVICE':
      return 'Jasa';
    case 'BUNDLE':
      return 'Bundle';
    case 'FORMULA':
      return 'Formula';
    default:
      return 'Belum diatur';
  }
}

export function formatBaseUnitLabel(baseUnit?: string | null): string {
  if (!baseUnit || typeof baseUnit !== 'string' || baseUnit.trim() === '') {
    return 'Belum diatur';
  }
  return baseUnit.trim();
}

export function formatSellingPriceDisplay(price: number | string | null | undefined): {
  text: string;
  isUnset: boolean;
} {
  if (price === null || price === undefined || (typeof price === 'string' && price.trim() === '')) {
    return { text: 'Belum diatur', isUnset: true };
  }
  const num = Number(price);
  if (!Number.isFinite(num) || num < 0) {
    return { text: 'Belum diatur', isUnset: true };
  }
  return { text: formatIDR(num), isUnset: false };
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
  const [productTypeFilter, setProductTypeFilter] = useState<ProductTypeFilter>('ALL');
  const [sellableFilter, setSellableFilter] = useState<SellableFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showAddOptional, setShowAddOptional] = useState(false);
  const [showEditOptional, setShowEditOptional] = useState(false);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [editingItem, setEditingItem] = useState<ProductItem | null>(null);
  const [saving, setSaving] = useState(false);
  // Harga disimpan sebagai string agar "kosong" bisa dibedakan dari "0".
  const [newProduct, setNewProduct] = useState<ProductFormState>({ ...EMPTY_PRODUCT_FORM });
  const [editProduct, setEditProduct] = useState<ProductFormState>({ ...EMPTY_PRODUCT_FORM });
  const [categoryForm, setCategoryForm] = useState<{ mode: 'add' | 'rename'; id?: number; name: string }>({ mode: 'add', name: '' });
  const addNameInputRef = useRef<HTMLInputElement | null>(null);
  const [addPhotoFile, setAddPhotoFile] = useState<File | null>(null);
  const [addPhotoPreviewUrl, setAddPhotoPreviewUrl] = useState<string | null>(null);
  const addPhotoPreviewUrlRef = useRef<string | null>(null);
  addPhotoPreviewUrlRef.current = addPhotoPreviewUrl;
  const [pendingCreatedItem, setPendingCreatedItem] = useState<{ id: number; name: string } | null>(null);
  const [unconfirmedCreate, setUnconfirmedCreate] = useState<boolean>(false);
  const [editPhotoFile, setEditPhotoFile] = useState<File | null>(null);
  const [editPhotoPreviewUrl, setEditPhotoPreviewUrl] = useState<string | null>(null);
  const editPhotoPreviewUrlRef = useRef<string | null>(null);
  editPhotoPreviewUrlRef.current = editPhotoPreviewUrl;
  const [editRemovePhoto, setEditRemovePhoto] = useState<boolean>(false);
  const [photoBlobUrls, setPhotoBlobUrls] = useState<Record<string, string>>({});
  const photoBlobUrlsRef = useRef<Record<string, string>>({});
  photoBlobUrlsRef.current = photoBlobUrls;
  const addGalleryInputRef = useRef<HTMLInputElement | null>(null);
  const addCameraInputRef = useRef<HTMLInputElement | null>(null);
  const editGalleryInputRef = useRef<HTMLInputElement | null>(null);
  const editCameraInputRef = useRef<HTMLInputElement | null>(null);

  const revokeObjectUrlSafe = useCallback((url: string | null | undefined) => {
    if (url && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }
  }, []);

  const createPreviewObjectUrl = useCallback((file: File): string => {
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      return URL.createObjectURL(file);
    }
    return `blob:preview-${file.name || 'photo'}`;
  }, []);

  const invalidatePhotoCache = useCallback((photoUrl: string | null | undefined, itemId?: number, pid?: number | null) => {
    const urlsToClear = new Set<string>();
    if (photoUrl) urlsToClear.add(photoUrl);
    if (itemId != null && pid != null) {
      urlsToClear.add(`/api/pos/menu/items/${itemId}/photo?property_id=${pid}`);
    }
    if (urlsToClear.size === 0) return;
    for (const u of urlsToClear) {
      const existingBlob = photoBlobUrlsRef.current[u];
      if (existingBlob) {
        revokeObjectUrlSafe(existingBlob);
        delete photoBlobUrlsRef.current[u];
      }
    }
    setPhotoBlobUrls((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const u of urlsToClear) {
        if (u in next) {
          delete next[u];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [revokeObjectUrlSafe]);

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

  const loadProducts = useCallback(async (
    status: StatusFilter = statusFilter,
    propertyOverride?: number | null
  ): Promise<'ok' | 'stale' | 'error'> => {
    const pid = propertyOverride !== undefined ? propertyOverride : propertyId;
    if (!pid) return 'error';
    const fetchGen = ++fetchGenRef.current; // hanya fetch ini yang terproteksi
    const isStaleFetch = () => fetchGenRef.current !== fetchGen;
    try {
      setLoading(true);
      setErrorMsg(null);
      const res = await authenticatedFetch(`/api/pos/menu?property_id=${pid}&status=${status}&scope=master`);
      const json = await res.json().catch(() => null);
      // Guard fetch: diperiksa SETELAH res.json() dan SEBELUM menulis state.
      if (isStaleFetch()) return 'stale';
      if (!res.ok) {
        throw new Error((json as any)?.message || (json as any)?.error || 'Gagal memuat katalog master produk');
      }
      const rawItems = (json as any)?.data?.items;
      if (!Array.isArray(rawItems)) {
        throw new Error('Respons daftar produk dari server tidak valid');
      }
      const rawCategories = (json as any)?.data?.categories;
      setInternalItems(rawItems);
      setCategories(Array.isArray(rawCategories) ? rawCategories : []);
      return 'ok';
    } catch (err: any) {
      if (isStaleFetch()) return 'stale';
      setErrorMsg(err?.message || 'Gagal memuat katalog produk');
      return 'error';
    } finally {
      if (!isStaleFetch()) setLoading(false);
    }
  }, [propertyId, statusFilter]);

  // propertyId berubah (termasuk null, A→B→A):
  //  - Bump generation properti → semua snapshot mutasi lama otomatis stale.
  //  - Reset saving: request mutasi lama tidak boleh memegang saving milik
  //    properti/institusi baru (identity mutasi di finally mengurus hal ini).
  //  - Bersihkan data/modal/draft. Bila null, state kosong — jangan memuat.
  useEffect(() => {
    propGenRef.current += 1;
    ctxRef.current = { propertyId, statusFilter: 'active' };
    setSaving(false);
    setAddPhotoFile(null);
    setAddPhotoPreviewUrl((prev) => {
      revokeObjectUrlSafe(prev);
      addPhotoPreviewUrlRef.current = null;
      return null;
    });
    setPendingCreatedItem(null);
    setUnconfirmedCreate(false);
    setEditPhotoFile(null);
    setEditPhotoPreviewUrl((prev) => {
      revokeObjectUrlSafe(prev);
      editPhotoPreviewUrlRef.current = null;
      return null;
    });
    setEditRemovePhoto(false);
    if (!propertyId) {
      setInternalItems([]);
      setCategories([]);
      setEditingItem(null);
      setShowAddModal(false);
      setShowAddOptional(false);
      setShowEditOptional(false);
      setShowCategoryModal(false);
      setSelectedCategory('ALL');
      setProductTypeFilter('ALL');
      setSellableFilter('all');
      setSearchQuery('');
      setErrorMsg(null);
      setSuccessMsg(null);
      setLoading(false);
      return;
    }
    setNewProduct({ ...EMPTY_PRODUCT_FORM });
    setEditProduct({ ...EMPTY_PRODUCT_FORM });
    setEditingItem(null);
    setShowAddModal(false);
    setShowAddOptional(false);
    setShowEditOptional(false);
    setShowCategoryModal(false);
    setSelectedCategory('ALL');
    setProductTypeFilter('ALL');
    setSellableFilter('all');
    setSearchQuery('');
    setErrorMsg(null);
    setSuccessMsg(null);
    setLoading(true);
    void loadProducts('active', propertyId);
  }, [propertyId]); // sengaja hanya propertyId; loadProducts di deps karena useMemo

  // Fokus otomatis ke input Nama Produk saat modal tambah dibuka.
  useEffect(() => {
    if (!showAddModal) return;
    const timer = window.setTimeout(() => {
      addNameInputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [showAddModal]);

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

  // Muat foto produk terlindungi menggunakan authenticatedFetch dan bersihkan URL.revokeObjectURL
  useEffect(() => {
    const activeUrls = new Set<string>();
    for (const item of items) {
      if (item.has_photo && typeof item.photo_url === 'string' && item.photo_url.trim() !== '') {
        activeUrls.add(item.photo_url);
      }
    }
    if (editingItem?.has_photo && typeof editingItem.photo_url === 'string' && editingItem.photo_url.trim() !== '') {
      activeUrls.add(editingItem.photo_url);
    }

    let cancelled = false;
    const currentSnapshot = photoBlobUrlsRef.current;

    for (const existingUrl of Object.keys(currentSnapshot)) {
      if (!activeUrls.has(existingUrl)) {
        revokeObjectUrlSafe(currentSnapshot[existingUrl]);
        delete currentSnapshot[existingUrl];
        setPhotoBlobUrls((prev) => {
          if (!(existingUrl in prev)) return prev;
          const next = { ...prev };
          delete next[existingUrl];
          return next;
        });
      }
    }

    for (const photoUrl of activeUrls) {
      if (currentSnapshot[photoUrl]) continue;
      Promise.resolve(authenticatedFetch(photoUrl))
        .then(async (res) => {
          if (!res || !res.ok || typeof res.blob !== 'function') return;
          const blob = await res.blob();
          if (cancelled) return;
          const objectUrl =
            typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
              ? URL.createObjectURL(blob)
              : `blob:mock-${photoUrl}`;
          if (cancelled) {
            revokeObjectUrlSafe(objectUrl);
            return;
          }
          setPhotoBlobUrls((prev) => {
            if (prev[photoUrl]) {
              if (prev[photoUrl] !== objectUrl) {
                revokeObjectUrlSafe(objectUrl);
              }
              return prev;
            }
            return { ...prev, [photoUrl]: objectUrl };
          });
        })
        .catch(() => {
          // Produk gagal muat thumbnail tetap dapat digunakan
        });
    }

    return () => {
      cancelled = true;
    };
  }, [items, editingItem, revokeObjectUrlSafe]);

  useEffect(() => {
    return () => {
      if (addPhotoPreviewUrlRef.current) {
        revokeObjectUrlSafe(addPhotoPreviewUrlRef.current);
        addPhotoPreviewUrlRef.current = null;
      }
      if (editPhotoPreviewUrlRef.current) {
        revokeObjectUrlSafe(editPhotoPreviewUrlRef.current);
        editPhotoPreviewUrlRef.current = null;
      }
      const snapshot = photoBlobUrlsRef.current;
      for (const blobUrl of Object.values(snapshot)) {
        revokeObjectUrlSafe(blobUrl);
      }
    };
  }, [revokeObjectUrlSafe]);

  const categoryNames = useMemo(
    () => categories.map((c) => c.name),
    [categories]
  );

  // Statistik berdasarkan data OAK aktual yang dimuat pada filter status saat ini.
  const stats = useMemo(() => {
    const total = items.length;
    const sellableCount = items.filter((i) => i.is_sellable_pos !== false).length;
    const internalCount = items.filter((i) => i.is_sellable_pos === false).length;
    const finishedCount = items.filter((i) => i.product_type === 'FINISHED_GOOD').length;
    const semiCount = items.filter((i) => i.product_type === 'SEMI_FINISHED').length;
    const rawCount = items.filter((i) => i.product_type === 'RAW_MATERIAL').length;
    const unsetTypeCount = items.filter((i) => !i.product_type).length;
    return {
      total,
      sellableCount,
      internalCount,
      finishedCount,
      semiCount,
      rawCount,
      unsetTypeCount,
      categories: categories.length,
    };
  }, [items, categories]);

  const productTypeCounts = useMemo<Record<ProductTypeFilter, number>>(() => ({
    ALL: stats.total,
    FINISHED_GOOD: stats.finishedCount,
    SEMI_FINISHED: stats.semiCount,
    RAW_MATERIAL: stats.rawCount,
    UNSET: stats.unsetTypeCount,
  }), [stats]);

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const matchSearch = matchesProductSearch(item, searchQuery);
      const matchCategory =
        selectedCategory === 'ALL' ||
        (selectedCategory !== 'NONE'
          ? (item.category_name || 'Tanpa Kategori') === selectedCategory
          : item.category_name === null || item.category_name === undefined || item.category_name === '');
      const matchProductType =
        productTypeFilter === 'ALL' ||
        (productTypeFilter === 'UNSET'
          ? !item.product_type
          : item.product_type === productTypeFilter);
      const itemSellable = item.is_sellable_pos !== false;
      const matchSellable =
        sellableFilter === 'all' ||
        (sellableFilter === 'sellable' ? itemSellable : !itemSellable);
      const matchStatus =
        statusFilter === 'all' ||
        (statusFilter === 'active' ? item.is_active !== false : item.is_active === false);
      return matchSearch && matchCategory && matchProductType && matchSellable && matchStatus;
    });
  }, [items, searchQuery, selectedCategory, productTypeFilter, sellableFilter, statusFilter]);

  const handleRefresh = async () => {
    const { propertyId: pid, statusFilter: sf } = ctxRef.current;
    await loadProducts(sf, pid ?? propertyId);
    onRefresh?.();
  };

  // Helper: ubah input harga (string) jadi number Rupiah utuh untuk submit.
  // - "kosong" / undefined => null.
  // - "0" => 0 (harus tersimpan eksplisit, bukan kosong).
  // - angka bulat valid >= 0 => integer number.
  // - negatif / pecahan / NaN => 'INVALID' (diblokir sebelum submit).
  const parsePriceInput = (raw: string): number | null | 'INVALID' => {
    const t = raw.trim();
    if (t === '') return null;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(n)) return 'INVALID';
    return n;
  };

  const selectAddPhoto = (file: File | null | undefined) => {
    if (!file) return;
    const err = validateProductPhotoFile(file);
    if (err) {
      setErrorMsg(err);
      return;
    }
    setErrorMsg(null);
    setAddPhotoFile(file);
    setAddPhotoPreviewUrl((prev) => {
      revokeObjectUrlSafe(prev);
      const nextUrl = createPreviewObjectUrl(file);
      addPhotoPreviewUrlRef.current = nextUrl;
      return nextUrl;
    });
  };

  const clearAddPhoto = () => {
    setAddPhotoFile(null);
    setAddPhotoPreviewUrl((prev) => {
      revokeObjectUrlSafe(prev);
      addPhotoPreviewUrlRef.current = null;
      return null;
    });
    if (addGalleryInputRef.current) addGalleryInputRef.current.value = '';
    if (addCameraInputRef.current) addCameraInputRef.current.value = '';
  };

  const selectEditPhoto = (file: File | null | undefined) => {
    if (!file) return;
    const err = validateProductPhotoFile(file);
    if (err) {
      setErrorMsg(err);
      return;
    }
    setErrorMsg(null);
    setEditPhotoFile(file);
    setEditRemovePhoto(false);
    setEditPhotoPreviewUrl((prev) => {
      revokeObjectUrlSafe(prev);
      const nextUrl = createPreviewObjectUrl(file);
      editPhotoPreviewUrlRef.current = nextUrl;
      return nextUrl;
    });
  };

  const clearEditDraftPhoto = () => {
    setEditPhotoFile(null);
    setEditPhotoPreviewUrl((prev) => {
      revokeObjectUrlSafe(prev);
      editPhotoPreviewUrlRef.current = null;
      return null;
    });
    if (editGalleryInputRef.current) editGalleryInputRef.current.value = '';
    if (editCameraInputRef.current) editCameraInputRef.current.value = '';
  };

  const handleEditRemovePhotoClick = () => {
    if (editPhotoFile) {
      clearEditDraftPhoto();
      if (editingItem?.has_photo) {
        setEditRemovePhoto(true);
      }
      return;
    }
    if (editingItem?.has_photo) {
      setEditRemovePhoto(true);
    }
  };

  const handleUndoEditRemovePhoto = () => {
    setEditRemovePhoto(false);
  };

  // Snapshot submit: { pid, propGen, mutGen }. mutGen membedakan mutasi
  // berurutan agar finally request lama tidak mereset saving milik mutasi baru.
  const savingMutGen = useRef(0); // mutasi terakhir yang memegang saving

  const isMutationStale = (ctx: { pid: number; propGen: number; mutGen: number }): boolean =>
    propGenRef.current !== ctx.propGen; // properti sudah berganti (A→B→A, →null, dll.)

  const handleAddProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!capabilities.canCreate) return;
    if (unconfirmedCreate && !pendingCreatedItem) {
      setErrorMsg(
        'Identitas produk belum terkonfirmasi karena respons server sebelumnya tidak memuat ID produk yang valid. Gunakan "Periksa Daftar Produk" untuk memeriksa daftar produk dan mencegah duplikasi.'
      );
      return;
    }
    if (!propertyId || newProduct.name.trim() === '') {
      if (newProduct.name.trim() === '') setErrorMsg('Nama produk wajib diisi');
      return;
    }
    const priceVal = parsePriceInput(newProduct.price);
    if (priceVal === 'INVALID') {
      setErrorMsg('Harga tidak valid: gunakan angka Rupiah utuh (bulat) 0 atau lebih besar');
      return;
    }
    if (newProduct.isSellablePos && priceVal === null) {
      setErrorMsg('Harga jual wajib diisi untuk produk yang dijual di POS (isi 0 secara eksplisit bila Rp 0)');
      return;
    }
    const baseUnitClean = newProduct.baseUnit.trim();
    if (baseUnitClean.length > 50) {
      setErrorMsg('Satuan dasar maksimal 50 karakter');
      return;
    }
    const barcodeClean = normalizeBarcodeDraft(newProduct.barcode);
    if (barcodeClean === 'TOO_LONG') {
      setErrorMsg('Barcode maksimal 100 karakter');
      return;
    }
    if (addPhotoFile) {
      const photoErr = validateProductPhotoFile(addPhotoFile);
      if (photoErr) {
        setErrorMsg(photoErr);
        return;
      }
    }
    // Snapshot submit SEBELUM await: propertyId + generation properti terkini.
    const targetPropertyId = propertyId;
    const ctx = { pid: targetPropertyId, propGen: propGenRef.current, mutGen: ++savingMutGen.current };
    const stale = () => isMutationStale(ctx); // properti A→B→A → propGen naik → stale
    try {
      setSaving(true);
      setErrorMsg(null);
      const productPayload = {
        property_id: targetPropertyId,
        name: newProduct.name.trim(),
        item_code: newProduct.code.trim() === '' ? null : newProduct.code.trim().toUpperCase(),
        barcode: barcodeClean,
        category_id: newProduct.category === '' ? null : Number(newProduct.category) || null,
        price: priceVal,
        is_sellable_pos: newProduct.isSellablePos,
        product_type: newProduct.productType === '' ? null : newProduct.productType,
        product_kind: newProduct.productKind === '' ? null : newProduct.productKind,
        base_unit: baseUnitClean === '' ? null : baseUnitClean,
        description: newProduct.description.trim() === '' ? null : newProduct.description.trim(),
      };

      let targetItemId: number | null = pendingCreatedItem ? pendingCreatedItem.id : null;

      if (targetItemId === null) {
        const res = await authenticatedFetch('/api/pos/menu/items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(productPayload),
        });
        const json = await res.json().catch(() => null);
        if (stale()) return; // properti sudah berganti — abaikan respons submit lama
        if (!res.ok) {
          throw new Error((json as any)?.message || 'Gagal menyimpan produk master');
        }
        const rawId = (json as any)?.data?.id;
        const createdId =
          typeof rawId === 'number' || (typeof rawId === 'string' && rawId.trim() !== '')
            ? Number(rawId)
            : NaN;
        if (!Number.isInteger(createdId) || createdId <= 0) {
          setUnconfirmedCreate(true);
          throw new Error(
            `Respons server tidak memuat ID produk yang valid untuk "${newProduct.name.trim()}". Produk mungkin sudah tersimpan di server${
              addPhotoFile ? ' namun foto belum diunggah' : ''
            }. Draft dan foto tetap dipertahankan; gunakan "Periksa Daftar Produk" untuk memeriksa daftar produk tanpa membuat produk kedua.`
          );
        }
        targetItemId = createdId;
        setUnconfirmedCreate(false);
        if (addPhotoFile) {
          setPendingCreatedItem({ id: createdId, name: newProduct.name.trim() });
        }
      } else {
        // Retry setelah produk sebelumnya sudah berhasil dibuat namun upload foto gagal:
        // perbarui produk dengan PATCH pada ID yang sama agar TIDAK membuat produk kedua.
        const res = await authenticatedFetch(`/api/pos/menu/items/${targetItemId}?property_id=${targetPropertyId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(productPayload),
        });
        const json = await res.json().catch(() => null);
        if (stale()) return;
        if (!res.ok) {
          throw new Error((json as any)?.message || 'Gagal memperbarui data produk yang sudah dibuat');
        }
        setPendingCreatedItem({ id: targetItemId, name: newProduct.name.trim() });
      }

      if (addPhotoFile && targetItemId !== null) {
        try {
          const formData = new FormData();
          formData.append('photo', addPhotoFile);
          const photoRes = await authenticatedFetch(
            `/api/pos/menu/items/${targetItemId}/photo?property_id=${targetPropertyId}`,
            {
              method: 'POST',
              body: formData,
            }
          );
          const photoJson = await photoRes.json().catch(() => null);
          if (stale()) return;
          if (!photoRes.ok) {
            const reason = (photoJson as any)?.message || 'Gagal mengunggah foto produk';
            throw new Error(reason);
          }
          invalidatePhotoCache((photoJson as any)?.data?.photo_url, targetItemId, targetPropertyId);
        } catch (photoErr: any) {
          if (stale()) return;
          throw new Error(
            `Produk "${newProduct.name.trim()}" (#${targetItemId}) sudah tersimpan, tetapi unggah foto gagal: ${
              photoErr?.message || 'Koneksi terputus'
            }. Klik Simpan Produk untuk mencoba ulang tanpa membuat produk kedua.`
          );
        }
      }

      clearAddPhoto();
      setPendingCreatedItem(null);
      setUnconfirmedCreate(false);
      setSuccessMsg(`Produk "${newProduct.name.trim()}" berhasil ditambahkan ke katalog master.`);
      setShowAddModal(false);
      setShowAddOptional(false);
      setNewProduct({ ...EMPTY_PRODUCT_FORM });
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
    const priceVal = parsePriceInput(editProduct.price);
    if (priceVal === 'INVALID') {
      setErrorMsg('Harga tidak valid: gunakan angka Rupiah utuh (bulat) 0 atau lebih besar');
      return;
    }
    const existingHadNoPrice =
      editingItem.price === null ||
      editingItem.price === undefined ||
      String(editingItem.price).trim() === '';
    if (editProduct.isSellablePos && priceVal === null && existingHadNoPrice) {
      setErrorMsg('Harga jual wajib diisi saat mengaktifkan Dijual di POS');
      return;
    }
    const baseUnitClean = editProduct.baseUnit.trim();
    if (baseUnitClean.length > 50) {
      setErrorMsg('Satuan dasar maksimal 50 karakter');
      return;
    }
    const barcodeClean = normalizeBarcodeDraft(editProduct.barcode);
    if (barcodeClean === 'TOO_LONG') {
      setErrorMsg('Barcode maksimal 100 karakter');
      return;
    }
    if (editPhotoFile) {
      const photoErr = validateProductPhotoFile(editPhotoFile);
      if (photoErr) {
        setErrorMsg(photoErr);
        return;
      }
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
        item_code: editProduct.code.trim() === '' ? null : editProduct.code.trim().toUpperCase(),
        barcode: barcodeClean,
        description: editProduct.description.trim() === '' ? null : editProduct.description.trim(),
        category_id: editProduct.category === '' ? null : Number(editProduct.category) || null,
        is_sellable_pos: editProduct.isSellablePos,
        product_type: editProduct.productType === '' ? null : editProduct.productType,
        product_kind: editProduct.productKind === '' ? null : editProduct.productKind,
        base_unit: baseUnitClean === '' ? null : baseUnitClean,
      };
      // Harga:
      // - Bila diisi angka valid (termasuk 0), kirim angka tersebut.
      // - Bila dikosongkan dan produk adalah non-POS (isSellablePos = false), kirim null.
      // - Bila dikosongkan dan produk jual (isSellablePos = true) yang sudah punya harga,
      //   tidak mengirim field price (preservasi harga lama sesuai kontrak).
      if (priceVal !== null) {
        patch.price = priceVal;
      } else if (!editProduct.isSellablePos) {
        patch.price = null;
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
      if ((json as any)?.data) {
        setEditingItem((prev) => (prev ? { ...prev, ...((json as any).data as ProductItem) } : prev));
      }

      if (editPhotoFile) {
        try {
          const formData = new FormData();
          formData.append('photo', editPhotoFile);
          const photoRes = await authenticatedFetch(
            `/api/pos/menu/items/${editingItem.id}/photo?property_id=${targetPropertyId}`,
            {
              method: 'POST',
              body: formData,
            }
          );
          const photoJson = await photoRes.json().catch(() => null);
          if (stale()) return;
          if (!photoRes.ok) {
            throw new Error((photoJson as any)?.message || 'Gagal mengunggah foto produk');
          }
          invalidatePhotoCache(editingItem.photo_url || (photoJson as any)?.data?.photo_url, editingItem.id, targetPropertyId);
        } catch (photoErr: any) {
          if (stale()) return;
          throw new Error(
            `Data produk "${editProduct.name.trim()}" sudah diperbarui, tetapi gagal mengunggah foto: ${
              photoErr?.message || 'Koneksi terputus'
            }. Klik Simpan Perubahan untuk mencoba ulang.`
          );
        }
      } else if (editRemovePhoto && editingItem.has_photo) {
        try {
          const delRes = await authenticatedFetch(
            `/api/pos/menu/items/${editingItem.id}/photo?property_id=${targetPropertyId}`,
            { method: 'DELETE' }
          );
          const delJson = await delRes.json().catch(() => null);
          if (stale()) return;
          if (!delRes.ok) {
            throw new Error((delJson as any)?.message || 'Gagal menghapus foto produk');
          }
          invalidatePhotoCache(editingItem.photo_url, editingItem.id, targetPropertyId);
        } catch (delErr: any) {
          if (stale()) return;
          throw new Error(
            `Data produk "${editProduct.name.trim()}" sudah diperbarui, tetapi gagal menghapus foto: ${
              delErr?.message || 'Koneksi terputus'
            }. Klik Simpan Perubahan untuk mencoba ulang.`
          );
        }
      }

      clearEditDraftPhoto();
      setEditRemovePhoto(false);
      setSuccessMsg(`Produk "${editProduct.name.trim()}" berhasil diperbarui.`);
      setEditingItem(null);
      setShowEditOptional(false);
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

  const openAddModal = () => {
    if (!capabilities.canCreate) return;
    setErrorMsg(null);
    clearAddPhoto();
    setPendingCreatedItem(null);
    setUnconfirmedCreate(false);
    setNewProduct(createInitialAddProductForm(productTypeFilter));
    setShowAddOptional(false);
    setShowAddModal(true);
  };

  const closeAddModal = () => {
    if (saving) return;
    const shouldRefreshCatalog = pendingCreatedItem !== null || unconfirmedCreate;
    clearAddPhoto();
    setPendingCreatedItem(null);
    setUnconfirmedCreate(false);
    setShowAddModal(false);
    setErrorMsg(null);
    if (shouldRefreshCatalog) {
      const { propertyId: curPid, statusFilter: curSf } = ctxRef.current;
      void loadProducts(curSf, curPid ?? propertyId);
      onRefresh?.();
    }
  };

  const handleInspectListAfterUnconfirmedCreate = async () => {
    if (saving) return;
    const { propertyId: curPid, statusFilter: curSf } = ctxRef.current;
    const targetPid = curPid ?? propertyId;
    if (!targetPid) {
      setErrorMsg('Properti belum dipilih. Tidak dapat memeriksa daftar produk.');
      return;
    }
    const ctx = { pid: targetPid, propGen: propGenRef.current, mutGen: ++savingMutGen.current };
    const stale = () => isMutationStale(ctx);
    try {
      setSaving(true);
      const outcome = await loadProducts(curSf, targetPid);
      if (stale()) return;
      if (outcome !== 'ok') {
        if (outcome === 'stale') {
          setErrorMsg(
            'Respons daftar produk sudah kedaluwarsa (basi). Silakan klik "Periksa Daftar Produk" lagi.'
          );
        }
        return;
      }
      clearAddPhoto();
      setPendingCreatedItem(null);
      setUnconfirmedCreate(false);
      setShowAddModal(false);
      setShowAddOptional(false);
      setNewProduct({ ...EMPTY_PRODUCT_FORM });
      setErrorMsg(null);
      onRefresh?.();
    } finally {
      if (!stale() && ctx.mutGen === savingMutGen.current) {
        setSaving(false);
      }
    }
  };

  const openEdit = (item: ProductItem) => {
    if (!capabilities.canEdit) return;
    setErrorMsg(null);
    clearEditDraftPhoto();
    setEditRemovePhoto(false);
    const nextEditForm = buildEditProductForm(item);
    setEditProduct(nextEditForm);
    setShowEditOptional(Boolean(nextEditForm.code.trim() || nextEditForm.description.trim()));
    setEditingItem(item);
  };

  const closeEditModal = () => {
    if (saving) return;
    clearEditDraftPhoto();
    setEditRemovePhoto(false);
    setEditingItem(null);
    setErrorMsg(null);
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

  const getProductTypeBadgeClass = (productType?: string | null) => {
    switch (productType) {
      case 'FINISHED_GOOD':
        return 'bg-emerald-50 text-emerald-800 border-emerald-200';
      case 'SEMI_FINISHED':
        return 'bg-amber-50 text-amber-800 border-amber-200';
      case 'RAW_MATERIAL':
        return 'bg-sky-50 text-sky-800 border-sky-200';
      default:
        return 'bg-gray-50 text-gray-500 border-gray-200';
    }
  };

  return (
    <div className="relative space-y-6 pb-24 sm:pb-28">
      <datalist id="oak-product-base-units">
        {COMMON_BASE_UNITS.map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>

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
          <h1 className="text-2xl font-black text-gray-900 tracking-tight">Master Produk &amp; Inventori Dasar</h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">
            Klasifikasi produk jadi, setengah jadi, dan bahan baku beserta satuan dasar serta pengaturan visibilitas katalog POS.
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

      {/* KPI Overview (berdasarkan data OAK yang tersedia pada filter status saat ini) */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-gray-500 font-medium">
            Produk {statusFilter === 'all' ? 'Terdaftar' : statusFilter === 'active' ? 'Aktif' : 'Nonaktif'}
          </div>
          <div className="text-2xl font-black text-gray-900 mt-1">{stats.total}</div>
          <div className="text-[11px] text-gray-400 mt-0.5">
            Jadi: {stats.finishedCount} • Setengah Jadi: {stats.semiCount} • Bahan Baku: {stats.rawCount}
          </div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-gray-500 font-medium">Dijual di POS</div>
          <div className="text-2xl font-black text-emerald-700 mt-1">{stats.sellableCount}</div>
          <div className="text-[11px] text-gray-400 mt-0.5">
            Tampil di katalog kasir POS (saat status Aktif)
          </div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-gray-500 font-medium">Produk non-POS</div>
          <div className="text-2xl font-black text-slate-700 mt-1">{stats.internalCount}</div>
          <div className="text-[11px] text-gray-400 mt-0.5">
            Tidak dijual di POS (disembunyikan dari katalog kasir)
          </div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-gray-500 font-medium">Kategori Produk</div>
          <div className="text-2xl font-black text-gray-900 mt-1">{stats.categories}</div>
          <div className="text-[11px] text-gray-400 mt-0.5">Kategori yang tersedia di properti ini</div>
        </div>
      </div>

      {/* Product Type Classification Tabs & Search/Filter Toolbar */}
      <div className="bg-white border border-gray-200/90 rounded-2xl p-4 shadow-xs flex flex-col gap-3.5">
        {/* Baris 1: Tab Tipe Produk (Referensi Santai Scale: Semua, Produk Jadi, Setengah Jadi, Bahan Baku, Belum diatur) */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 border-b border-gray-100">
          {PRODUCT_TYPE_TABS.map((tab) => {
            const active = productTypeFilter === tab.key;
            const count = productTypeCounts[tab.key];
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setProductTypeFilter(tab.key)}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-colors cursor-pointer ${
                  active
                    ? 'bg-emerald-800 text-white shadow-2xs'
                    : 'bg-gray-50 text-gray-600 hover:bg-gray-100 border border-gray-200/70'
                }`}
              >
                <span>{tab.label}</span>
                <span
                  className={`px-1.5 py-0.2 rounded-full text-[10px] font-extrabold ${
                    active ? 'bg-emerald-950/40 text-emerald-50' : 'bg-gray-200/80 text-gray-700'
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Baris 2: Pencarian + Filter Kategori */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="relative w-full sm:w-80">
            <svg className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="Cari nama produk, kode SKU, atau barcode..."
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

        {/* Baris 3: Filter Status & Filter Visibilitas POS */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
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

          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400 font-medium shrink-0">Visibilitas POS:</span>
            {([
              { key: 'all', label: 'Semua' },
              { key: 'sellable', label: 'Dijual di POS' },
              { key: 'internal', label: 'Tidak dijual di POS' },
            ] as const).map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setSellableFilter(opt.key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                  sellableFilter === opt.key
                    ? 'bg-emerald-800 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
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
                  <th className="py-3 px-4">Tipe &amp; Jenis</th>
                  <th className="py-3 px-4">Kategori</th>
                  <th className="py-3 px-4">Satuan Dasar</th>
                  <th className="py-3 px-4 text-center">Dijual di POS</th>
                  <th className="py-3 px-4 text-right">Harga Jual (IDR)</th>
                  <th className="py-3 px-4 text-center">Status</th>
                  <th className="py-3 px-4 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-12 text-center text-gray-400">
                      Tidak ada produk yang cocok dengan filter pencarian.
                    </td>
                  </tr>
                ) : (
                  filteredItems.map((item) => {
                    const priceDisplay = formatSellingPriceDisplay(item.price);
                    const typeLabel = item.product_type_label || formatProductTypeLabel(item.product_type);
                    const kindLabel = item.product_kind_label || formatProductKindLabel(item.product_kind);
                    const unitLabel = formatBaseUnitLabel(item.base_unit);
                    const isSellable = item.is_sellable_pos !== false;
                    return (
                      <tr key={item.id} className="hover:bg-gray-50/60 transition-colors">
                        <td className="py-3 px-4 font-mono font-medium text-gray-600">
                          <div>{item.item_code || `PRD-${String(item.id).padStart(4, '0')}`}</div>
                          {item.barcode && (
                            <div className="text-[11px] text-gray-400 font-mono mt-0.5">
                              Barcode: {item.barcode}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 font-semibold text-gray-900">
                          <div className="flex items-center gap-3">
                            {item.has_photo && item.photo_url && photoBlobUrls[item.photo_url] ? (
                              <img
                                src={photoBlobUrls[item.photo_url]}
                                alt={item.name}
                                className="w-10 h-10 rounded-lg object-cover border border-gray-200 shrink-0 bg-gray-100"
                              />
                            ) : (
                              <div
                                aria-hidden="true"
                                className="w-10 h-10 rounded-lg border border-dashed border-gray-200 bg-gray-50 flex items-center justify-center text-[10px] text-gray-400 shrink-0"
                              >
                                Foto
                              </div>
                            )}
                            <div>
                              <div>{item.name}</div>
                              {item.description && (
                                <div className="text-[11px] text-gray-400 font-normal mt-0.5">{item.description}</div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex flex-col items-start gap-0.5">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold border ${getProductTypeBadgeClass(item.product_type)}`}>
                              {typeLabel}
                            </span>
                            <span className="text-[11px] text-gray-400">
                              Jenis: {kindLabel}
                            </span>
                          </div>
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
                        <td className="py-3 px-4">
                          <span className={item.base_unit ? 'font-medium text-gray-800' : 'text-xs text-gray-400 italic'}>
                            {unitLabel}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-center">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
                            isSellable
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : 'bg-slate-100 text-slate-600 border-slate-200'
                          }`}>
                            {formatPosSellabilityBadge(isSellable)}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          {priceDisplay.isUnset ? (
                            <span className="text-xs text-gray-400 italic">{priceDisplay.text}</span>
                          ) : (
                            <span className="font-bold text-gray-900">{priceDisplay.text}</span>
                          )}
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
                        <td className="py-3 px-4 text-right space-x-1 whitespace-nowrap">
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
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Floating Add Product Button */}
      {capabilities.canCreate && (
        <button
          type="button"
          aria-label="Tambah produk"
          title="Tambah produk"
          onClick={openAddModal}
          className="fixed bottom-6 right-6 z-40 inline-flex h-14 w-14 items-center justify-center rounded-full bg-emerald-700 hover:bg-emerald-800 active:scale-95 text-white shadow-lg shadow-emerald-900/25 border border-emerald-600/40 transition-all cursor-pointer focus:outline-hidden focus:ring-4 focus:ring-emerald-500/30"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 5v14m7-7H5" />
          </svg>
        </button>
      )}

      {/* Add Product Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-3 sm:p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full border border-gray-200 max-h-[90vh] flex flex-col overflow-hidden">
            <div className="shrink-0 px-6 pt-5 pb-4 border-b border-gray-100 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-gray-900">Tambah Produk Baru</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  Daftarkan produk jadi, setengah jadi, atau bahan baku ke master produk properti.
                </p>
              </div>
              <button
                type="button"
                onClick={closeAddModal}
                disabled={saving}
                className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Tutup modal tambah produk"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleAddProduct} className="flex flex-col flex-1 min-h-0">
              <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
                {errorMsg && (
                  <div className="px-3 py-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center justify-between">
                    <span>{errorMsg}</span>
                    <button type="button" onClick={() => setErrorMsg(null)} className="font-bold hover:text-rose-900">✕</button>
                  </div>
                )}

                {pendingCreatedItem && (
                  <div className="px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-xs">
                    Data produk <strong>{pendingCreatedItem.name}</strong> (#{pendingCreatedItem.id}) sudah tersimpan. Klik <strong>Simpan Produk</strong> untuk memperbarui data &amp; mengulang unggah foto tanpa membuat produk kedua.
                  </div>
                )}

                {unconfirmedCreate && !pendingCreatedItem && (
                  <div className="px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-xs space-y-2">
                    <div>
                      Identitas produk belum dapat dikonfirmasi dari respons server. Pengiriman ulang (POST kedua) dinonaktifkan agar tidak membuat produk ganda. Draft dan pilihan foto Anda tetap dipertahankan di form ini.
                    </div>
                    <div>
                      <button
                        type="button"
                        disabled={saving}
                        aria-label="Periksa daftar produk"
                        onClick={handleInspectListAfterUnconfirmedCreate}
                        className="px-3 py-1.5 text-xs font-semibold text-amber-900 bg-white hover:bg-amber-100 rounded-lg border border-amber-300 cursor-pointer disabled:opacity-50"
                      >
                        Periksa Daftar Produk
                      </button>
                    </div>
                  </div>
                )}

                {/* 1. Nama Produk */}
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Nama Produk *</label>
                  <input
                    ref={addNameInputRef}
                    autoFocus
                    type="text"
                    required
                    placeholder="Contoh: Nasi Goreng Spesial / Beras Pandan Wangi"
                    value={newProduct.name}
                    onChange={(e) => setNewProduct({ ...newProduct, name: e.target.value })}
                    className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                  />
                </div>

                {/* 2. Kategori */}
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

                {/* 3. Tipe Produk & Jenis Produk */}
                <div className="space-y-3">
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="block text-xs font-semibold text-gray-700">Tipe Produk</label>
                      <button
                        type="button"
                        onClick={() => setNewProduct(applyProductTypeChange(newProduct, ''))}
                        className={`text-[11px] font-medium px-2 py-0.5 rounded-md border transition-colors cursor-pointer ${
                          newProduct.productType === ''
                            ? 'bg-gray-200/80 text-gray-800 border-gray-300 font-semibold'
                            : 'bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-100'
                        }`}
                      >
                        Belum diatur
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2" role="group" aria-label="Pilihan tipe produk">
                      {PRODUCT_TYPE_CHOICES.map((choice) => {
                        const selected = newProduct.productType === choice.value;
                        return (
                          <button
                            key={choice.value}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => setNewProduct(applyProductTypeChange(newProduct, choice.value))}
                            className={`text-left px-3 py-2 rounded-xl border transition-all cursor-pointer ${
                              selected
                                ? 'bg-emerald-50 border-emerald-600 text-emerald-900 ring-1 ring-emerald-600'
                                : 'bg-gray-50/80 border-gray-200 text-gray-700 hover:bg-gray-100'
                            }`}
                          >
                            <div className="text-xs font-bold">{choice.label}</div>
                            <div className="text-[10px] text-gray-500 mt-0.5">{choice.hint}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1">Jenis Produk</label>
                    <select
                      value={newProduct.productKind}
                      onChange={(e) => setNewProduct({ ...newProduct, productKind: e.target.value })}
                      className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2"
                    >
                      <option value="">— Belum diatur —</option>
                      <option value="STANDARD">Biasa</option>
                      <option value="WEIGHED" disabled>Timbangan (Roadmap)</option>
                      <option value="UNLIMITED" disabled>Unlimited (Roadmap)</option>
                      <option value="SERVICE" disabled>Jasa (Roadmap)</option>
                      <option value="BUNDLE" disabled>Bundle (Roadmap)</option>
                      <option value="FORMULA" disabled>Formula (Roadmap)</option>
                    </select>
                  </div>
                </div>

                {/* 4. Satuan Dasar */}
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Satuan Dasar</label>
                  <input
                    type="text"
                    list="oak-product-base-units"
                    maxLength={50}
                    placeholder="Contoh: Porsi, Pcs, Kg, Liter"
                    value={newProduct.baseUnit}
                    onChange={(e) => setNewProduct({ ...newProduct, baseUnit: e.target.value })}
                    className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2"
                  />
                </div>

                {/* 5. Dijual di POS */}
                <div className="p-3.5 rounded-xl bg-gray-50 border border-gray-200 space-y-2">
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newProduct.isSellablePos}
                      onChange={(e) => setNewProduct({ ...newProduct, isSellablePos: e.target.checked })}
                      className="mt-0.5 h-4 w-4 rounded border-gray-300 text-emerald-700 focus:ring-emerald-600"
                    />
                    <div>
                      <div className="text-xs font-bold text-gray-900">Dijual di POS (Tampilkan di Kasir)</div>
                      <div className="text-[11px] text-gray-500">
                        Matikan untuk produk non-POS seperti bahan baku atau barang setengah jadi yang tidak dijual langsung di kasir POS.
                      </div>
                    </div>
                  </label>
                </div>

                {/* 6. Harga Jual (IDR) */}
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    Harga Jual (IDR) {newProduct.isSellablePos ? '*' : '(Opsional untuk Produk non-POS)'}
                  </label>
                  <input
                    type="number"
                    required={newProduct.isSellablePos}
                    min="0"
                    step="1"
                    placeholder={newProduct.isSellablePos ? 'Contoh: 45000 (isi 0 secara eksplisit bila Rp 0)' : 'Kosongkan bila tidak dijual di POS'}
                    value={newProduct.price}
                    onChange={(e) => setNewProduct({ ...newProduct, price: e.target.value })}
                    className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 font-mono"
                  />
                  <div className="text-[11px] text-gray-400 mt-0.5">
                    {newProduct.isSellablePos
                      ? 'Wajib berupa Rupiah utuh (>= 0). Isi 0 secara eksplisit bila harga Rp 0.'
                      : 'Produk non-POS boleh disimpan tanpa harga jual (ditampilkan "Belum diatur").'}
                  </div>
                </div>

                {/* 7. Barcode (Opsional) */}
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Barcode (Opsional)</label>
                  <input
                    type="text"
                    maxLength={100}
                    aria-label="Barcode produk"
                    placeholder="Contoh: 0012345678905 (pertahankan angka nol awal)"
                    value={newProduct.barcode}
                    onChange={(e) => setNewProduct({ ...newProduct, barcode: e.target.value })}
                    className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 font-mono"
                  />
                  <div className="text-[11px] text-gray-400 mt-0.5">
                    Unik per properti (maksimal 100 karakter). Tidak diisi otomatis dari SKU.
                  </div>
                </div>

                {/* 8. Foto Produk (Opsional) */}
                <div className="p-3.5 rounded-xl bg-gray-50 border border-gray-200 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <label className="block text-xs font-semibold text-gray-700">Foto Produk (Opsional)</label>
                    <span className="text-[11px] text-gray-400">PNG, JPEG, WebP • Maks. 2 MB</span>
                  </div>

                  {addPhotoPreviewUrl && (
                    <div className="flex items-center gap-3 p-2.5 bg-white rounded-lg border border-gray-200">
                      <img
                        src={addPhotoPreviewUrl}
                        alt="Preview foto produk baru"
                        className="w-14 h-14 rounded-lg object-cover border border-gray-200 shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-gray-800 truncate">
                          {addPhotoFile?.name || 'Foto dipilih'}
                        </div>
                        <div className="text-[11px] text-emerald-700">
                          Akan diunggah saat Simpan Produk
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={saving}
                        aria-label="Hapus foto produk"
                        onClick={clearAddPhoto}
                        className="px-2.5 py-1 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-lg border border-rose-200 cursor-pointer disabled:opacity-50"
                      >
                        Hapus Foto
                      </button>
                    </div>
                  )}

                  <input
                    ref={addGalleryInputRef}
                    type="file"
                    accept={PRODUCT_PHOTO_ACCEPT}
                    data-photo-source="gallery"
                    aria-label="Input file galeri tambah produk"
                    onChange={(e) => selectAddPhoto(e.target.files?.[0] || null)}
                    className="hidden"
                  />
                  <input
                    ref={addCameraInputRef}
                    type="file"
                    accept={PRODUCT_PHOTO_ACCEPT}
                    capture="environment"
                    data-photo-source="camera"
                    aria-label="Input file kamera tambah produk"
                    onChange={(e) => selectAddPhoto(e.target.files?.[0] || null)}
                    className="hidden"
                  />

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={saving}
                      aria-label="Pilih foto dari galeri"
                      onClick={() => addGalleryInputRef.current?.click()}
                      className="px-3 py-1.5 text-xs font-semibold text-gray-700 bg-white hover:bg-gray-100 rounded-lg border border-gray-300 cursor-pointer disabled:opacity-50"
                    >
                      {addPhotoFile ? 'Ganti dari Galeri' : 'Pilih dari Galeri'}
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      aria-label="Ambil foto dari kamera"
                      onClick={() => addCameraInputRef.current?.click()}
                      className="px-3 py-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 rounded-lg border border-emerald-200 cursor-pointer disabled:opacity-50"
                    >
                      Ambil dari Kamera
                    </button>
                  </div>
                </div>

                {/* Bagian Opsional (SKU & Deskripsi) */}
                <div className="border border-gray-200 rounded-xl overflow-hidden bg-gray-50/40">
                  <button
                    type="button"
                    aria-expanded={showAddOptional}
                    onClick={() => setShowAddOptional((prev) => !prev)}
                    className="w-full flex items-center justify-between px-3.5 py-2.5 text-left text-xs font-semibold text-gray-700 hover:bg-gray-100/80 transition-colors cursor-pointer"
                  >
                    <span className="flex items-center gap-2">
                      <span>Detail Opsional (Kode SKU &amp; Deskripsi)</span>
                      {(newProduct.code.trim() !== '' || newProduct.description.trim() !== '') && (
                        <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                          Terisi
                        </span>
                      )}
                    </span>
                    <span className="text-gray-400 text-[11px]">{showAddOptional ? 'Sembunyikan ▲' : 'Tampilkan ▼'}</span>
                  </button>
                  {showAddOptional && (
                    <div className="p-3.5 pt-2 border-t border-gray-200/70 space-y-3 bg-white">
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
                        <label className="block text-xs font-semibold text-gray-700 mb-1">Deskripsi Produk (Opsional)</label>
                        <textarea
                          rows={2}
                          placeholder="Keterangan singkat komposisi, spesifikasi, atau sajian..."
                          value={newProduct.description}
                          onChange={(e) => setNewProduct({ ...newProduct, description: e.target.value })}
                          className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2"
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div className="text-[11px] text-gray-400 bg-gray-50/80 border border-gray-200/70 rounded-lg px-3 py-2">
                  Konversi kemasan, stok awal, HPP, dan mutasi stok akan diaktifkan pada tahap inventori berikutnya.
                </div>
              </div>

              <div className="shrink-0 flex justify-end gap-2 px-6 py-4 border-t border-gray-100 bg-white">
                <button
                  type="button"
                  onClick={closeAddModal}
                  disabled={saving}
                  className="px-4 py-2 text-xs font-semibold text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg cursor-pointer disabled:opacity-50"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={saving || (unconfirmedCreate && !pendingCreatedItem)}
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-3 sm:p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full border border-gray-200 max-h-[90vh] flex flex-col overflow-hidden">
            <div className="shrink-0 px-6 pt-5 pb-4 border-b border-gray-100 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-gray-900">Edit Produk</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  Ubah data dan klasifikasi produk &ldquo;{editingItem.name}&rdquo;.
                </p>
              </div>
              <button
                type="button"
                onClick={closeEditModal}
                disabled={saving}
                className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Tutup modal edit produk"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleEditSave} className="flex flex-col flex-1 min-h-0">
              <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
                {errorMsg && (
                  <div className="px-3 py-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center justify-between">
                    <span>{errorMsg}</span>
                    <button type="button" onClick={() => setErrorMsg(null)} className="font-bold hover:text-rose-900">✕</button>
                  </div>
                )}

                {/* 1. Nama Produk */}
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Nama Produk *</label>
                  <input
                    type="text"
                    required
                    value={editProduct.name}
                    onChange={(e) => setEditProduct({ ...editProduct, name: e.target.value })}
                    className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                  />
                </div>

                {/* 2. Kategori */}
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

                {/* 3. Tipe Produk & Jenis Produk */}
                <div className="space-y-3">
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="block text-xs font-semibold text-gray-700">Tipe Produk</label>
                      <button
                        type="button"
                        onClick={() => setEditProduct(applyProductTypeChange(editProduct, ''))}
                        className={`text-[11px] font-medium px-2 py-0.5 rounded-md border transition-colors cursor-pointer ${
                          editProduct.productType === ''
                            ? 'bg-gray-200/80 text-gray-800 border-gray-300 font-semibold'
                            : 'bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-100'
                        }`}
                      >
                        Belum diatur
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2" role="group" aria-label="Pilihan tipe produk">
                      {PRODUCT_TYPE_CHOICES.map((choice) => {
                        const selected = editProduct.productType === choice.value;
                        return (
                          <button
                            key={choice.value}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => setEditProduct(applyProductTypeChange(editProduct, choice.value))}
                            className={`text-left px-3 py-2 rounded-xl border transition-all cursor-pointer ${
                              selected
                                ? 'bg-emerald-50 border-emerald-600 text-emerald-900 ring-1 ring-emerald-600'
                                : 'bg-gray-50/80 border-gray-200 text-gray-700 hover:bg-gray-100'
                            }`}
                          >
                            <div className="text-xs font-bold">{choice.label}</div>
                            <div className="text-[10px] text-gray-500 mt-0.5">{choice.hint}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1">Jenis Produk</label>
                    <select
                      value={editProduct.productKind}
                      onChange={(e) => setEditProduct({ ...editProduct, productKind: e.target.value })}
                      className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2"
                    >
                      <option value="">— Belum diatur —</option>
                      <option value="STANDARD">Biasa</option>
                      <option value="WEIGHED" disabled>Timbangan (Roadmap)</option>
                      <option value="UNLIMITED" disabled>Unlimited (Roadmap)</option>
                      <option value="SERVICE" disabled>Jasa (Roadmap)</option>
                      <option value="BUNDLE" disabled>Bundle (Roadmap)</option>
                      <option value="FORMULA" disabled>Formula (Roadmap)</option>
                    </select>
                  </div>
                </div>

                {/* 4. Satuan Dasar */}
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Satuan Dasar</label>
                  <input
                    type="text"
                    list="oak-product-base-units"
                    maxLength={50}
                    placeholder="Belum diatur (contoh: Porsi, Pcs, Kg)"
                    value={editProduct.baseUnit}
                    onChange={(e) => setEditProduct({ ...editProduct, baseUnit: e.target.value })}
                    className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2"
                  />
                </div>

                {/* 5. Dijual di POS */}
                <div className="p-3.5 rounded-xl bg-gray-50 border border-gray-200 space-y-2">
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editProduct.isSellablePos}
                      onChange={(e) => setEditProduct({ ...editProduct, isSellablePos: e.target.checked })}
                      className="mt-0.5 h-4 w-4 rounded border-gray-300 text-emerald-700 focus:ring-emerald-600"
                    />
                    <div>
                      <div className="text-xs font-bold text-gray-900">Dijual di POS (Tampilkan di Kasir)</div>
                      <div className="text-[11px] text-gray-500">
                        Matikan bila produk ini merupakan bahan baku atau produk non-POS yang tidak dijual langsung di kasir POS.
                      </div>
                    </div>
                  </label>
                </div>

                {/* 6. Harga Jual (IDR) */}
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    Harga Jual (IDR) {editProduct.isSellablePos ? '' : '(Opsional untuk Produk non-POS)'}
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    placeholder={editProduct.isSellablePos ? 'Rupiah utuh >= 0' : 'Kosong = tanpa harga jual (Belum diatur)'}
                    value={editProduct.price}
                    onChange={(e) => setEditProduct({ ...editProduct, price: e.target.value })}
                    className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 font-mono"
                  />
                  <div className="text-[11px] text-gray-400 mt-0.5">
                    {editProduct.isSellablePos
                      ? 'Gunakan angka Rupiah utuh (>= 0). Kosong = tidak mengubah harga existing; 0 = Rp 0.'
                      : 'Kosongkan untuk menyimpan produk non-POS tanpa harga jual POS ("Belum diatur").'}
                  </div>
                </div>

                {/* 7. Barcode (Opsional) */}
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Barcode (Opsional)</label>
                  <input
                    type="text"
                    maxLength={100}
                    aria-label="Barcode produk"
                    placeholder="Kosongkan untuk menghapus barcode (pertahankan angka nol awal)"
                    value={editProduct.barcode}
                    onChange={(e) => setEditProduct({ ...editProduct, barcode: e.target.value })}
                    className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 font-mono"
                  />
                  <div className="text-[11px] text-gray-400 mt-0.5">
                    Kosongkan nilai ini lalu simpan bila ingin menghapus barcode produk.
                  </div>
                </div>

                {/* 8. Foto Produk (Opsional) */}
                <div className="p-3.5 rounded-xl bg-gray-50 border border-gray-200 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <label className="block text-xs font-semibold text-gray-700">Foto Produk (Opsional)</label>
                    <span className="text-[11px] text-gray-400">PNG, JPEG, WebP • Maks. 2 MB</span>
                  </div>

                  {editPhotoPreviewUrl ? (
                    <div className="flex items-center gap-3 p-2.5 bg-white rounded-lg border border-gray-200">
                      <img
                        src={editPhotoPreviewUrl}
                        alt="Preview foto produk pengganti"
                        className="w-14 h-14 rounded-lg object-cover border border-gray-200 shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-gray-800 truncate">
                          {editPhotoFile?.name || 'Foto baru dipilih'}
                        </div>
                        <div className="text-[11px] text-emerald-700">
                          Foto baru akan diterapkan saat Simpan Perubahan
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={saving}
                        aria-label="Hapus foto produk"
                        onClick={handleEditRemovePhotoClick}
                        className="px-2.5 py-1 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-lg border border-rose-200 cursor-pointer disabled:opacity-50"
                      >
                        Hapus Foto
                      </button>
                    </div>
                  ) : editRemovePhoto ? (
                    <div className="flex items-center justify-between gap-3 p-2.5 bg-amber-50 rounded-lg border border-amber-200">
                      <div className="text-xs text-amber-900">
                        Foto produk ditandai untuk dihapus saat <strong>Simpan Perubahan</strong>.
                      </div>
                      <button
                        type="button"
                        disabled={saving}
                        aria-label="Urungkan hapus foto"
                        onClick={handleUndoEditRemovePhoto}
                        className="px-2.5 py-1 text-xs font-semibold text-amber-900 bg-white hover:bg-amber-100 rounded-lg border border-amber-300 cursor-pointer shrink-0 disabled:opacity-50"
                      >
                        Urungkan Hapus Foto
                      </button>
                    </div>
                  ) : editingItem.has_photo ? (
                    <div className="flex items-center gap-3 p-2.5 bg-white rounded-lg border border-gray-200">
                      {editingItem.photo_url && photoBlobUrls[editingItem.photo_url] ? (
                        <img
                          src={photoBlobUrls[editingItem.photo_url]}
                          alt={editingItem.name}
                          className="w-14 h-14 rounded-lg object-cover border border-gray-200 shrink-0"
                        />
                      ) : (
                        <div className="w-14 h-14 rounded-lg border border-gray-200 bg-gray-100 flex items-center justify-center text-[10px] text-gray-500 shrink-0">
                          Foto
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-gray-800">Foto produk tersimpan</div>
                        <div className="text-[11px] text-gray-500">Pilih foto baru untuk mengganti atau hapus foto.</div>
                      </div>
                      <button
                        type="button"
                        disabled={saving}
                        aria-label="Hapus foto produk"
                        onClick={handleEditRemovePhotoClick}
                        className="px-2.5 py-1 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-lg border border-rose-200 cursor-pointer disabled:opacity-50"
                      >
                        Hapus Foto
                      </button>
                    </div>
                  ) : null}

                  <input
                    ref={editGalleryInputRef}
                    type="file"
                    accept={PRODUCT_PHOTO_ACCEPT}
                    data-photo-source="gallery"
                    aria-label="Input file galeri edit produk"
                    onChange={(e) => selectEditPhoto(e.target.files?.[0] || null)}
                    className="hidden"
                  />
                  <input
                    ref={editCameraInputRef}
                    type="file"
                    accept={PRODUCT_PHOTO_ACCEPT}
                    capture="environment"
                    data-photo-source="camera"
                    aria-label="Input file kamera edit produk"
                    onChange={(e) => selectEditPhoto(e.target.files?.[0] || null)}
                    className="hidden"
                  />

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={saving}
                      aria-label="Pilih foto dari galeri"
                      onClick={() => editGalleryInputRef.current?.click()}
                      className="px-3 py-1.5 text-xs font-semibold text-gray-700 bg-white hover:bg-gray-100 rounded-lg border border-gray-300 cursor-pointer disabled:opacity-50"
                    >
                      {editPhotoFile || (!editRemovePhoto && editingItem.has_photo) ? 'Ganti dari Galeri' : 'Pilih dari Galeri'}
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      aria-label="Ambil foto dari kamera"
                      onClick={() => editCameraInputRef.current?.click()}
                      className="px-3 py-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 rounded-lg border border-emerald-200 cursor-pointer disabled:opacity-50"
                    >
                      Ambil dari Kamera
                    </button>
                  </div>
                </div>

                {/* Bagian Opsional (SKU & Deskripsi) */}
                <div className="border border-gray-200 rounded-xl overflow-hidden bg-gray-50/40">
                  <button
                    type="button"
                    aria-expanded={showEditOptional}
                    onClick={() => setShowEditOptional((prev) => !prev)}
                    className="w-full flex items-center justify-between px-3.5 py-2.5 text-left text-xs font-semibold text-gray-700 hover:bg-gray-100/80 transition-colors cursor-pointer"
                  >
                    <span className="flex items-center gap-2">
                      <span>Detail Opsional (Kode SKU &amp; Deskripsi)</span>
                      {(editProduct.code.trim() !== '' || editProduct.description.trim() !== '') && (
                        <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                          Terisi
                        </span>
                      )}
                    </span>
                    <span className="text-gray-400 text-[11px]">{showEditOptional ? 'Sembunyikan ▲' : 'Tampilkan ▼'}</span>
                  </button>
                  {showEditOptional && (
                    <div className="p-3.5 pt-2 border-t border-gray-200/70 space-y-3 bg-white">
                      <div>
                        <label className="block text-xs font-semibold text-gray-700 mb-1">Kode / SKU (Opsional)</label>
                        <input
                          type="text"
                          value={editProduct.code}
                          onChange={(e) => setEditProduct({ ...editProduct, code: e.target.value.toUpperCase() })}
                          className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-gray-700 mb-1">Deskripsi Produk (Opsional)</label>
                        <textarea
                          rows={2}
                          value={editProduct.description}
                          onChange={(e) => setEditProduct({ ...editProduct, description: e.target.value })}
                          className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="shrink-0 flex justify-end gap-2 px-6 py-4 border-t border-gray-100 bg-white">
                <button
                  type="button"
                  onClick={closeEditModal}
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
