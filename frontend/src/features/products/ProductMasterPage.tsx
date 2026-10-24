import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { authenticatedFetch } from '../../lib/authenticatedFetch';
import { useAuth } from '../auth/AuthContext';
import { getMasterProductCapabilities } from './productMasterPermissions';
import PosInventoryWorkspace from '../posInventory/PosInventoryWorkspace';

export type ProductTypeCode = 'RAW_MATERIAL' | 'SEMI_FINISHED' | 'FINISHED_GOOD';
export type ProductKindCode = 'STANDARD';
export type RoadmapProductKindCode = 'WEIGHED' | 'UNLIMITED' | 'SERVICE' | 'BUNDLE' | 'FORMULA';
export type UnitDimension = 'COUNT' | 'WEIGHT' | 'VOLUME';
export type StockLocationTypeCode =
  | 'WAREHOUSE'
  | 'KITCHEN'
  | 'POS_OUTLET'
  | 'HK_PANTRY'
  | 'ROOM_MINIBAR';

export interface CanonicalUnitOption {
  code: string;
  dimension: UnitDimension;
  label_id: string;
  aliases: readonly string[];
  allow_decimal: boolean;
  display_scale: 0 | 3;
}

export const SYSTEM_CANONICAL_UNITS: readonly CanonicalUnitOption[] = [
  {
    code: 'PCS',
    dimension: 'COUNT',
    label_id: 'Pcs',
    aliases: ['pcs', 'pc', 'piece', 'pieces', 'buah', 'biji', 'unit'],
    allow_decimal: false,
    display_scale: 0,
  },
  {
    code: 'PORSI',
    dimension: 'COUNT',
    label_id: 'Porsi',
    aliases: ['porsi', 'portion', 'serving'],
    allow_decimal: false,
    display_scale: 0,
  },
  {
    code: 'GELAS',
    dimension: 'COUNT',
    label_id: 'Gelas',
    aliases: ['gelas', 'glass'],
    allow_decimal: false,
    display_scale: 0,
  },
  {
    code: 'CUP',
    dimension: 'COUNT',
    label_id: 'Cup',
    aliases: ['cup', 'cangkir'],
    allow_decimal: false,
    display_scale: 0,
  },
  {
    code: 'BOTOL',
    dimension: 'COUNT',
    label_id: 'Botol',
    aliases: ['botol', 'btl', 'bottle'],
    allow_decimal: false,
    display_scale: 0,
  },
  {
    code: 'KALENG',
    dimension: 'COUNT',
    label_id: 'Kaleng',
    aliases: ['kaleng', 'can', 'klg'],
    allow_decimal: false,
    display_scale: 0,
  },
  {
    code: 'PACK',
    dimension: 'COUNT',
    label_id: 'Pack',
    aliases: ['pack', 'pak', 'bungkus', 'bks', 'sachet'],
    allow_decimal: false,
    display_scale: 0,
  },
  {
    code: 'BOX',
    dimension: 'COUNT',
    label_id: 'Box',
    aliases: ['box', 'kotak', 'dus', 'karton', 'carton', 'ctn'],
    allow_decimal: false,
    display_scale: 0,
  },
  {
    code: 'ROLL',
    dimension: 'COUNT',
    label_id: 'Roll',
    aliases: ['roll', 'gulung'],
    allow_decimal: false,
    display_scale: 0,
  },
  {
    code: 'SET',
    dimension: 'COUNT',
    label_id: 'Set',
    aliases: ['set', 'pasang', 'pair'],
    allow_decimal: false,
    display_scale: 0,
  },
  {
    code: 'LEMBAR',
    dimension: 'COUNT',
    label_id: 'Lembar',
    aliases: ['lembar', 'lbr', 'sheet'],
    allow_decimal: false,
    display_scale: 0,
  },
  {
    code: 'KG',
    dimension: 'WEIGHT',
    label_id: 'Kg',
    aliases: ['kg', 'kilogram', 'kilo'],
    allow_decimal: true,
    display_scale: 3,
  },
  {
    code: 'GRAM',
    dimension: 'WEIGHT',
    label_id: 'Gram',
    aliases: ['g', 'gr', 'gram', 'grams'],
    allow_decimal: true,
    display_scale: 3,
  },
  {
    code: 'LITER',
    dimension: 'VOLUME',
    label_id: 'Liter',
    aliases: ['l', 'lt', 'ltr', 'liter', 'litre'],
    allow_decimal: true,
    display_scale: 3,
  },
  {
    code: 'ML',
    dimension: 'VOLUME',
    label_id: 'mL',
    aliases: ['ml', 'milliliter', 'millilitre', 'cc'],
    allow_decimal: true,
    display_scale: 3,
  },
];

export const STOCK_LOCATION_TYPE_OPTIONS: Array<{ value: StockLocationTypeCode; label: string }> = [
  { value: 'WAREHOUSE', label: 'Gudang Utama / Penyimpanan (WAREHOUSE)' },
  { value: 'KITCHEN', label: 'Dapur / Produksi F&B (KITCHEN)' },
  { value: 'POS_OUTLET', label: 'Titik Stok Outlet Kasir / Bar / Resto (POS_OUTLET)' },
  { value: 'HK_PANTRY', label: 'Pantry Housekeeping (HK_PANTRY)' },
  { value: 'ROOM_MINIBAR', label: 'Minibar Kamar Tamu (ROOM_MINIBAR)' },
];

export function formatStockLocationTypeLabel(type: string | null | undefined): string {
  if (!type) return 'Belum diatur';
  const matched = STOCK_LOCATION_TYPE_OPTIONS.find((opt) => opt.value === type.toUpperCase());
  return matched ? matched.label : type;
}

export function getCanonicalUnitByCode(
  code: string | null | undefined,
  catalog: readonly CanonicalUnitOption[] = SYSTEM_CANONICAL_UNITS
): CanonicalUnitOption | null {
  if (!code || typeof code !== 'string') return null;
  const upper = code.trim().toUpperCase();
  return catalog.find((u) => u.code === upper) || null;
}

export function matchCanonicalUnitByText(
  raw: string | null | undefined,
  catalog: readonly CanonicalUnitOption[] = SYSTEM_CANONICAL_UNITS
): CanonicalUnitOption | null {
  if (!raw || typeof raw !== 'string') return null;
  const normalized = raw.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalized) return null;
  for (const unit of catalog) {
    if (
      unit.code.toLowerCase() === normalized ||
      unit.label_id.toLowerCase() === normalized ||
      unit.aliases.some((a) => a.toLowerCase() === normalized)
    ) {
      return unit;
    }
  }
  return null;
}

export function validatePackagingFactorDraft(
  rawFactor: string | null | undefined,
  baseUnitCode: string | null | undefined,
  catalog: readonly CanonicalUnitOption[] = SYSTEM_CANONICAL_UNITS
): { valid: true; normalizedFactor: string } | { valid: false; message: string } {
  const unit = getCanonicalUnitByCode(baseUnitCode, catalog);
  if (!unit) {
    return { valid: false, message: 'Satuan dasar kanonik produk belum valid' };
  }
  const trimmed = typeof rawFactor === 'string' ? rawFactor.trim() : '';
  if (!trimmed) {
    return { valid: false, message: 'Faktor konversi ke satuan dasar wajib diisi' };
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return { valid: false, message: 'Faktor konversi harus berupa angka positif menggunakan titik desimal' };
  }
  const [intPart, fracPart = ''] = trimmed.split('.');
  if (fracPart.length > 3) {
    return { valid: false, message: 'Faktor konversi maksimal 3 angka di belakang koma (presisi mili-unit)' };
  }
  const paddedFrac = (fracPart + '000').slice(0, 3);
  const milli = BigInt(intPart) * 1000n + BigInt(paddedFrac);
  if (milli <= 0n) {
    return { valid: false, message: 'Faktor konversi harus lebih besar dari 0' };
  }
  if (milli > 100_000_000n) {
    return { valid: false, message: 'Faktor konversi maksimal 100000 (atau 100000.000)' };
  }
  if (!unit.allow_decimal && milli % 1000n !== 0n) {
    return {
      valid: false,
      message: `Satuan dasar diskrit (${unit.label_id}) wajib memakai faktor konversi bilangan bulat`,
    };
  }
  return { valid: true, normalizedFactor: trimmed };
}

export interface PackagingConversionItem {
  id: number;
  property_id: number;
  menu_item_id: number;
  packaging_code: string;
  packaging_label: string;
  base_unit_code: string;
  to_base_factor: string;
  is_default_purchase: boolean;
  is_active: boolean;
  idempotency_key?: string | null;
}

export interface StockLocationItem {
  id: number;
  property_id: number;
  code: string;
  name: string;
  location_type: StockLocationTypeCode;
  room_id: number | null;
  room_number?: string | null;
  room_type_id?: number | null;
  room_type_name?: string | null;
  is_active: boolean;
  notes?: string | null;
}

export interface RoomMinibarCandidate {
  room_id: number;
  room_number: string;
  room_type_id: number | null;
  room_type_name: string | null;
  existing_stock_location_id?: number | null;
  existing_stock_location_code?: string | null;
  existing_stock_location_is_active?: boolean | null;
  is_available_for_minibar?: boolean;
  existing_location_id: number | null;
  existing_location_code: string | null;
  existing_location_is_active: boolean | null;
}

export interface UnconfirmedPackagingCreateState {
  itemId: number;
  propertyId: number;
  idempotencyKey: string;
  baseUnitCode: string;
  packagingCode: string;
  packagingLabel: string;
  toBaseFactor: string;
  isDefaultPurchase: boolean;
}

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
  canonical_base_unit_code?: string | null;
  canonical_base_unit_label?: string | null;
  canonical_unit_dimension?: UnitDimension | null;
  canonical_unit_allow_decimal?: boolean | null;
  canonical_unit_scale?: number | null;
  is_base_unit_locked?: boolean;
  packaging_conversions?: PackagingConversionItem[];
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
  canonicalBaseUnitCode?: string;
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
  canonicalBaseUnitCode: '',
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

let packagingIdempotencyCounter = 0;

export function createPackagingIdempotencyKey(propertyId: number | null | undefined, itemId: number): string {
  packagingIdempotencyCounter += 1;
  const pid = propertyId ?? 0;
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `mp03c-pkg-p${pid}-i${itemId}-${ts}-${packagingIdempotencyCounter}-${rand}`;
}

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

export function applyCanonicalUnitSelection(
  form: ProductFormState,
  nextCanonicalCode: string,
  catalog: readonly CanonicalUnitOption[] = SYSTEM_CANONICAL_UNITS
): ProductFormState {
  const cleanCode = nextCanonicalCode.trim().toUpperCase();
  if (!cleanCode) {
    return {
      ...form,
      canonicalBaseUnitCode: '',
      baseUnit: '',
    };
  }
  const unit = getCanonicalUnitByCode(cleanCode, catalog);
  if (!unit) {
    return {
      ...form,
      canonicalBaseUnitCode: '',
    };
  }
  return {
    ...form,
    canonicalBaseUnitCode: unit.code,
    baseUnit: unit.label_id,
  };
}

export function applyBaseUnitTextChange(
  form: ProductFormState,
  nextBaseUnitText: string,
  catalog: readonly CanonicalUnitOption[] = SYSTEM_CANONICAL_UNITS
): ProductFormState {
  const currentCode = form.canonicalBaseUnitCode ? form.canonicalBaseUnitCode.trim().toUpperCase() : '';
  if (!currentCode) {
    return {
      ...form,
      baseUnit: nextBaseUnitText,
    };
  }
  const matched = matchCanonicalUnitByText(nextBaseUnitText, catalog);
  return {
    ...form,
    baseUnit: nextBaseUnitText,
    canonicalBaseUnitCode: matched && matched.code === currentCode ? currentCode : '',
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
    canonicalBaseUnitCode: item.canonical_base_unit_code || '',
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
  const [mainTab, setMainTab] = useState<'catalog' | 'inventory'>('catalog');

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

  // ── MP-03C: State Kelola Kemasan Produk ──
  const [packagingModalItem, setPackagingModalItem] = useState<ProductItem | null>(null);
  const [packagingItems, setPackagingItems] = useState<PackagingConversionItem[]>([]);
  const [packagingLoading, setPackagingLoading] = useState<boolean>(false);
  const [packagingErrorMsg, setPackagingErrorMsg] = useState<string | null>(null);
  const [packagingDraft, setPackagingDraft] = useState<{
    packagingCode: string;
    packagingLabel: string;
    toBaseFactor: string;
    isDefaultPurchase: boolean;
    baseUnitCode: string;
    idempotencyKey: string;
  }>({
    packagingCode: 'BOX',
    packagingLabel: '',
    toBaseFactor: '',
    isDefaultPurchase: false,
    baseUnitCode: '',
    idempotencyKey: '',
  });
  const [unconfirmedPackagingCreate, setUnconfirmedPackagingCreate] =
    useState<UnconfirmedPackagingCreateState | null>(null);
  const [editingPackaging, setEditingPackaging] = useState<{
    id: number;
    packagingCode: string;
    packagingLabel: string;
    toBaseFactor: string;
    isDefaultPurchase: boolean;
    baseUnitCode: string;
  } | null>(null);

  // ── MP-03C: State Kelola Lokasi Stok & Minibar Kamar ──
  const [canonicalUnitsCatalog, setCanonicalUnitsCatalog] = useState<readonly CanonicalUnitOption[]>(SYSTEM_CANONICAL_UNITS);
  const [showStockLocationsModal, setShowStockLocationsModal] = useState<boolean>(false);
  const [stockLocations, setStockLocations] = useState<StockLocationItem[]>([]);
  const [roomCandidates, setRoomCandidates] = useState<RoomMinibarCandidate[]>([]);
  const [stockLocationsLoading, setStockLocationsLoading] = useState<boolean>(false);
  const [stockLocationErrorMsg, setStockLocationErrorMsg] = useState<string | null>(null);
  const [stockLocationForm, setStockLocationForm] = useState<{
    mode: 'add' | 'edit';
    id?: number;
    locationType: StockLocationTypeCode;
    code: string;
    name: string;
    roomId: string;
    notes: string;
  }>({
    mode: 'add',
    locationType: 'WAREHOUSE',
    code: '',
    name: '',
    roomId: '',
    notes: '',
  });

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
      const rawCanonicalUnits = (json as any)?.data?.canonical_units;
      setInternalItems(rawItems);
      setCategories(Array.isArray(rawCategories) ? rawCategories : []);
      if (Array.isArray(rawCanonicalUnits) && rawCanonicalUnits.length > 0) {
        setCanonicalUnitsCatalog(rawCanonicalUnits);
      }
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
    setPackagingModalItem(null);
    setPackagingItems([]);
    setPackagingErrorMsg(null);
    setUnconfirmedPackagingCreate(null);
    setEditingPackaging(null);
    setShowStockLocationsModal(false);
    setStockLocations([]);
    setRoomCandidates([]);
    setStockLocationErrorMsg(null);
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
      const canonicalCodeClean = newProduct.canonicalBaseUnitCode
        ? newProduct.canonicalBaseUnitCode.trim().toUpperCase()
        : '';
      const productPayload: Record<string, any> = {
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
      if (canonicalCodeClean !== '') {
        productPayload.canonical_base_unit_code = canonicalCodeClean;
      }

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
      const canonicalCodeClean = editProduct.canonicalBaseUnitCode
        ? editProduct.canonicalBaseUnitCode.trim().toUpperCase()
        : '';
      const origBaseUnit = typeof editingItem.base_unit === 'string' ? editingItem.base_unit.trim() : '';
      const origCanonicalCode =
        typeof editingItem.canonical_base_unit_code === 'string'
          ? editingItem.canonical_base_unit_code.trim().toUpperCase()
          : '';
      const unitUnchanged = baseUnitClean === origBaseUnit && canonicalCodeClean === origCanonicalCode;
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
      };
      if (unitUnchanged) {
        if (origCanonicalCode !== '' && origBaseUnit === '') {
          // Produk memiliki canonical_base_unit_code tanpa teks base_unit;
          // jangan mengirim base_unit: null agar tidak ditolak backend.
        } else {
          patch.base_unit = origBaseUnit === '' ? null : origBaseUnit;
          if (origCanonicalCode !== '') {
            patch.canonical_base_unit_code = origCanonicalCode;
          }
        }
      } else if (canonicalCodeClean !== '') {
        patch.canonical_base_unit_code = canonicalCodeClean;
        patch.base_unit =
          baseUnitClean === ''
            ? getCanonicalUnitByCode(canonicalCodeClean, canonicalUnitsCatalog)?.label_id || canonicalCodeClean
            : baseUnitClean;
      } else if (baseUnitClean === '') {
        // "Belum diatur": kedua field dikosongkan secara eksplisit.
        patch.base_unit = null;
        patch.canonical_base_unit_code = null;
      } else {
        // Satuan beralih ke teks legacy nonkosong (mis. BOTOL -> "ikat"):
        // kirim base_unit saja dan HILANGKAN canonical_base_unit_code dari
        // payload. Mengirim null bersamaan dengan teks legacy ditolak backend
        // sebagai CONFLICTING_BASE_UNIT_FIELDS.
        patch.base_unit = baseUnitClean;
      }
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

  // ── MP-03C: Kelola Kemasan Produk (Dialog Terpisah) ────────────────────────
  const packagingFetchGenRef = useRef(0);

  const loadPackagingsForItem = useCallback(async (
    itemId: number,
    propertyOverride?: number | null
  ): Promise<{ status: 'ok'; items: PackagingConversionItem[] } | { status: 'stale' } | { status: 'error'; message: string }> => {
    const pid = propertyOverride !== undefined ? propertyOverride : propertyId;
    if (!pid) return { status: 'error', message: 'Properti belum dipilih' };
    const fetchGen = ++packagingFetchGenRef.current;
    const isStale = () => packagingFetchGenRef.current !== fetchGen;
    try {
      setPackagingLoading(true);
      const res = await authenticatedFetch(`/api/pos/menu/items/${itemId}/packagings?property_id=${pid}`);
      const json = await res.json().catch(() => null);
      if (isStale()) return { status: 'stale' };
      if (!res.ok) {
        throw new Error((json as any)?.message || (json as any)?.error || 'Gagal memuat daftar kemasan produk');
      }
      const rawItems = (json as any)?.data?.packagings ?? (json as any)?.data?.items;
      if (!Array.isArray(rawItems)) {
        throw new Error('Respons daftar kemasan dari server tidak valid');
      }
      setPackagingItems(rawItems);
      const latestCanonicalCode = (json as any)?.data?.canonical_base_unit_code;
      const latestLocked = (json as any)?.data?.is_base_unit_locked;
      if (latestCanonicalCode !== undefined || latestLocked !== undefined) {
        setPackagingModalItem((prev) =>
          prev && prev.id === itemId
            ? {
                ...prev,
                canonical_base_unit_code:
                  latestCanonicalCode !== undefined ? latestCanonicalCode : prev.canonical_base_unit_code,
                is_base_unit_locked:
                  typeof latestLocked === 'boolean' ? latestLocked : prev.is_base_unit_locked,
              }
            : prev
        );
      }
      return { status: 'ok', items: rawItems };
    } catch (err: any) {
      if (isStale()) return { status: 'stale' };
      const msg = err?.message || 'Gagal memuat daftar kemasan produk';
      setPackagingErrorMsg(msg);
      return { status: 'error', message: msg };
    } finally {
      if (!isStale()) setPackagingLoading(false);
    }
  }, [propertyId]);

  const openPackagingModal = (item: ProductItem) => {
    const snapshotBaseUnit = item.canonical_base_unit_code ? item.canonical_base_unit_code.trim().toUpperCase() : '';
    setPackagingModalItem(item);
    setPackagingItems(Array.isArray(item.packaging_conversions) ? item.packaging_conversions : []);
    setPackagingErrorMsg(null);
    setUnconfirmedPackagingCreate(null);
    setEditingPackaging(null);
    setPackagingDraft({
      packagingCode: 'BOX',
      packagingLabel: '',
      toBaseFactor: '',
      isDefaultPurchase: false,
      baseUnitCode: snapshotBaseUnit,
      idempotencyKey: createPackagingIdempotencyKey(propertyId, item.id),
    });
    if (propertyId) {
      return loadPackagingsForItem(item.id, propertyId);
    }
  };

  const closePackagingModal = () => {
    if (saving) return;
    setPackagingModalItem(null);
    setPackagingItems([]);
    setPackagingErrorMsg(null);
    setUnconfirmedPackagingCreate(null);
    setEditingPackaging(null);
  };

  const handleCreatePackaging = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if ((!capabilities.canEdit && !capabilities.canCreate) || !packagingModalItem || !propertyId) return;

    const targetItem = packagingModalItem;
    const targetPropertyId = propertyId;

    const activeBaseUnitCode = unconfirmedPackagingCreate
      ? unconfirmedPackagingCreate.baseUnitCode
      : packagingDraft.baseUnitCode.trim().toUpperCase();
    const activeCode = unconfirmedPackagingCreate
      ? unconfirmedPackagingCreate.packagingCode
      : packagingDraft.packagingCode.trim().toUpperCase();
    const activeLabel = unconfirmedPackagingCreate
      ? unconfirmedPackagingCreate.packagingLabel
      : packagingDraft.packagingLabel.trim();
    const rawFactor = unconfirmedPackagingCreate
      ? unconfirmedPackagingCreate.toBaseFactor
      : packagingDraft.toBaseFactor;
    const activeDefaultPurchase = unconfirmedPackagingCreate
      ? unconfirmedPackagingCreate.isDefaultPurchase
      : packagingDraft.isDefaultPurchase;
    const activeIdempotencyKey = unconfirmedPackagingCreate
      ? unconfirmedPackagingCreate.idempotencyKey
      : packagingDraft.idempotencyKey || createPackagingIdempotencyKey(targetPropertyId, targetItem.id);

    if (!activeBaseUnitCode) {
      setPackagingErrorMsg('Tetapkan Satuan Dasar Kanonik pada produk ini terlebih dahulu sebelum menambahkan konversi kemasan.');
      return;
    }
    if (!activeCode) {
      setPackagingErrorMsg('Kode kemasan wajib diisi');
      return;
    }
    if (!activeLabel) {
      setPackagingErrorMsg('Label kemasan wajib diisi');
      return;
    }
    const factorValidation = validatePackagingFactorDraft(rawFactor, activeBaseUnitCode, canonicalUnitsCatalog);
    if (!factorValidation.valid) {
      setPackagingErrorMsg(factorValidation.message);
      return;
    }
    const activeFactor = factorValidation.normalizedFactor;

    const ctx = { pid: targetPropertyId, propGen: propGenRef.current, mutGen: ++savingMutGen.current };
    const stale = () => isMutationStale(ctx);
    try {
      setSaving(true);
      setPackagingErrorMsg(null);
      let res: Response;
      try {
        res = await authenticatedFetch(
          `/api/pos/menu/items/${targetItem.id}/packagings?property_id=${targetPropertyId}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              property_id: targetPropertyId,
              idempotency_key: activeIdempotencyKey,
              packaging_code: activeCode,
              packaging_label: activeLabel,
              base_unit_code: activeBaseUnitCode,
              to_base_factor: activeFactor,
              is_default_purchase: activeDefaultPurchase,
            }),
          }
        );
      } catch (networkErr: any) {
        if (stale()) return;
        setUnconfirmedPackagingCreate({
          itemId: targetItem.id,
          propertyId: targetPropertyId,
          idempotencyKey: activeIdempotencyKey,
          baseUnitCode: activeBaseUnitCode,
          packagingCode: activeCode,
          packagingLabel: activeLabel,
          toBaseFactor: activeFactor,
          isDefaultPurchase: activeDefaultPurchase,
        });
        throw new Error(
          `Koneksi terputus saat menyimpan kemasan "${activeLabel}" (${networkErr?.message || 'Network error'}). Status penyimpanan belum pasti; gunakan "Periksa Daftar Kemasan" atau "Ulangi Simpan Kemasan" dengan kunci idempotensi yang sama.`
        );
      }

      const json = await res.json().catch(() => null);
      if (stale()) return;

      if (!res.ok) {
        if (res.status >= 500) {
          setUnconfirmedPackagingCreate({
            itemId: targetItem.id,
            propertyId: targetPropertyId,
            idempotencyKey: activeIdempotencyKey,
            baseUnitCode: activeBaseUnitCode,
            packagingCode: activeCode,
            packagingLabel: activeLabel,
            toBaseFactor: activeFactor,
            isDefaultPurchase: activeDefaultPurchase,
          });
        }
        throw new Error((json as any)?.message || (json as any)?.error || 'Gagal menyimpan konversi kemasan');
      }

      const rawId = (json as any)?.data?.id;
      const createdId =
        typeof rawId === 'number' || (typeof rawId === 'string' && rawId.trim() !== '')
          ? Number(rawId)
          : NaN;
      if (!Number.isInteger(createdId) || createdId <= 0) {
        setUnconfirmedPackagingCreate({
          itemId: targetItem.id,
          propertyId: targetPropertyId,
          idempotencyKey: activeIdempotencyKey,
          baseUnitCode: activeBaseUnitCode,
          packagingCode: activeCode,
          packagingLabel: activeLabel,
          toBaseFactor: activeFactor,
          isDefaultPurchase: activeDefaultPurchase,
        });
        throw new Error(
          `Respons server tidak memuat ID kemasan yang valid untuk "${activeLabel}". Gunakan "Periksa Daftar Kemasan" atau "Ulangi Simpan Kemasan" tanpa mengganti kunci idempotensi.`
        );
      }

      const nextBaseUnit =
        (json as any)?.data?.base_unit_code ||
        targetItem.canonical_base_unit_code ||
        activeBaseUnitCode;
      setUnconfirmedPackagingCreate(null);
      setPackagingDraft({
        packagingCode: 'BOX',
        packagingLabel: '',
        toBaseFactor: '',
        isDefaultPurchase: false,
        baseUnitCode: nextBaseUnit,
        idempotencyKey: createPackagingIdempotencyKey(targetPropertyId, targetItem.id),
      });
      setSuccessMsg(`Kemasan "${activeLabel}" berhasil disimpan.`);
      await loadPackagingsForItem(targetItem.id, targetPropertyId);
      const { propertyId: curPid, statusFilter: curSf } = ctxRef.current;
      await loadProducts(curSf, curPid ?? targetPropertyId);
      if (stale()) return;
      onRefresh?.();
    } catch (err: any) {
      if (!stale()) setPackagingErrorMsg(err?.message || 'Gagal menyimpan konversi kemasan');
    } finally {
      if (!stale() && ctx.mutGen === savingMutGen.current) setSaving(false);
    }
  };

  const handleInspectPackagingsAfterUnconfirmedCreate = async () => {
    if (saving || !unconfirmedPackagingCreate) return;
    const pendingOp = unconfirmedPackagingCreate;
    const ctx = { pid: pendingOp.propertyId, propGen: propGenRef.current, mutGen: ++savingMutGen.current };
    const stale = () => isMutationStale(ctx);
    try {
      setSaving(true);
      setPackagingErrorMsg(null);
      const outcome = await loadPackagingsForItem(pendingOp.itemId, pendingOp.propertyId);
      if (stale()) return;
      if (outcome.status !== 'ok') {
        if (outcome.status === 'stale') {
          setPackagingErrorMsg('Respons daftar kemasan sudah kedaluwarsa (basi). Silakan klik "Periksa Daftar Kemasan" lagi.');
        }
        return;
      }
      // Hanya baris dengan idempotency_key yang SAMA PERSIS yang membuktikan operasi ini sudah tersimpan.
      // Baris dengan field serupa tetapi idempotency_key berbeda berasal dari operasi lain.
      const matchedRow = outcome.items.find(
        (row) =>
          typeof row.idempotency_key === 'string' &&
          row.idempotency_key.trim() === pendingOp.idempotencyKey &&
          Number.isInteger(Number(row.id)) &&
          Number(row.id) > 0
      );
      if (!matchedRow) {
        setPackagingErrorMsg(
          'Kemasan dengan identitas operasi ini belum terlihat pada daftar server. Karena GET tanpa baris hanya membuktikan baris belum terlihat saat pemeriksaan, kunci idempotensi tetap dipertahankan; gunakan "Ulangi Simpan Kemasan" untuk mengirim ulang secara aman tanpa duplikasi.'
        );
        return;
      }
      setUnconfirmedPackagingCreate(null);
      setPackagingDraft({
        packagingCode: 'BOX',
        packagingLabel: '',
        toBaseFactor: '',
        isDefaultPurchase: false,
        baseUnitCode: matchedRow.base_unit_code || pendingOp.baseUnitCode,
        idempotencyKey: createPackagingIdempotencyKey(pendingOp.propertyId, pendingOp.itemId),
      });
      setPackagingErrorMsg(null);
      setSuccessMsg(`Kemasan "${matchedRow.packaging_label}" terkonfirmasi sudah tersimpan.`);
      const { propertyId: curPid, statusFilter: curSf } = ctxRef.current;
      await loadProducts(curSf, curPid ?? pendingOp.propertyId);
      if (stale()) return;
      onRefresh?.();
    } finally {
      if (!stale() && ctx.mutGen === savingMutGen.current) setSaving(false);
    }
  };

  const handleUpdatePackaging = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!capabilities.canEdit && !capabilities.canCreate) || !packagingModalItem || !editingPackaging || !propertyId) return;
    const labelClean = editingPackaging.packagingLabel.trim();
    if (!labelClean) {
      setPackagingErrorMsg('Label kemasan wajib diisi');
      return;
    }
    const factorValidation = validatePackagingFactorDraft(editingPackaging.toBaseFactor, editingPackaging.baseUnitCode, canonicalUnitsCatalog);
    if (!factorValidation.valid) {
      setPackagingErrorMsg(factorValidation.message);
      return;
    }
    const targetPropertyId = propertyId;
    const targetItem = packagingModalItem;
    const ctx = { pid: targetPropertyId, propGen: propGenRef.current, mutGen: ++savingMutGen.current };
    const stale = () => isMutationStale(ctx);
    try {
      setSaving(true);
      setPackagingErrorMsg(null);
      const res = await authenticatedFetch(
        `/api/pos/menu/items/${targetItem.id}/packagings/${editingPackaging.id}?property_id=${targetPropertyId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            property_id: targetPropertyId,
            packaging_label: labelClean,
            to_base_factor: factorValidation.normalizedFactor,
            is_default_purchase: editingPackaging.isDefaultPurchase,
          }),
        }
      );
      const json = await res.json().catch(() => null);
      if (stale()) return;
      if (!res.ok) {
        throw new Error((json as any)?.message || (json as any)?.error || 'Gagal memperbarui kemasan');
      }
      setEditingPackaging(null);
      setSuccessMsg(`Kemasan "${labelClean}" berhasil diperbarui.`);
      await loadPackagingsForItem(targetItem.id, targetPropertyId);
      const { propertyId: curPid, statusFilter: curSf } = ctxRef.current;
      await loadProducts(curSf, curPid ?? targetPropertyId);
      if (stale()) return;
      onRefresh?.();
    } catch (err: any) {
      if (!stale()) setPackagingErrorMsg(err?.message || 'Gagal memperbarui kemasan');
    } finally {
      if (!stale() && ctx.mutGen === savingMutGen.current) setSaving(false);
    }
  };

  const handleTogglePackagingActive = async (pkg: PackagingConversionItem) => {
    if ((!capabilities.canEdit && !capabilities.canCreate) || !packagingModalItem || !propertyId) return;
    const nextActive = !pkg.is_active;
    const targetPropertyId = propertyId;
    const targetItem = packagingModalItem;
    const ctx = { pid: targetPropertyId, propGen: propGenRef.current, mutGen: ++savingMutGen.current };
    const stale = () => isMutationStale(ctx);
    try {
      setSaving(true);
      setPackagingErrorMsg(null);
      const res = await authenticatedFetch(
        `/api/pos/menu/items/${targetItem.id}/packagings/${pkg.id}?property_id=${targetPropertyId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            property_id: targetPropertyId,
            is_active: nextActive,
          }),
        }
      );
      const json = await res.json().catch(() => null);
      if (stale()) return;
      if (!res.ok) {
        throw new Error((json as any)?.message || (json as any)?.error || 'Gagal mengubah status kemasan');
      }
      setSuccessMsg(`Kemasan "${pkg.packaging_label}" berhasil ${nextActive ? 'diaktifkan' : 'dinonaktifkan'}.`);
      await loadPackagingsForItem(targetItem.id, targetPropertyId);
      const { propertyId: curPid, statusFilter: curSf } = ctxRef.current;
      await loadProducts(curSf, curPid ?? targetPropertyId);
      if (stale()) return;
      onRefresh?.();
    } catch (err: any) {
      if (!stale()) setPackagingErrorMsg(err?.message || 'Gagal mengubah status kemasan');
    } finally {
      if (!stale() && ctx.mutGen === savingMutGen.current) setSaving(false);
    }
  };

  // ── MP-03C: Kelola Lokasi Stok & Minibar Kamar ─────────────────────────────
  const stockLocFetchGenRef = useRef(0);

  const loadStockLocationsAndCandidates = useCallback(async (
    propertyOverride?: number | null
  ): Promise<'ok' | 'stale' | 'error'> => {
    const pid = propertyOverride !== undefined ? propertyOverride : propertyId;
    if (!pid) return 'error';
    const fetchGen = ++stockLocFetchGenRef.current;
    const isStale = () => stockLocFetchGenRef.current !== fetchGen;
    try {
      setStockLocationsLoading(true);
      setStockLocationErrorMsg(null);
      const [locRes, roomRes] = await Promise.all([
        authenticatedFetch(`/api/pos/stock-locations?property_id=${pid}&include_inactive=true`),
        authenticatedFetch(`/api/pos/stock-locations/room-candidates?property_id=${pid}`),
      ]);
      const locJson = await locRes.json().catch(() => null);
      const roomJson = await roomRes.json().catch(() => null);
      if (isStale()) return 'stale';
      if (!locRes.ok) {
        throw new Error((locJson as any)?.message || (locJson as any)?.error || 'Gagal memuat daftar lokasi stok');
      }
      const rawLocs = (locJson as any)?.data?.locations ?? (locJson as any)?.data?.items;
      if (!Array.isArray(rawLocs)) {
        throw new Error('Respons daftar lokasi stok tidak valid');
      }
      setStockLocations(rawLocs);
      if (!roomRes.ok) {
        throw new Error(
          (roomJson as any)?.message ||
            (roomJson as any)?.error ||
            'Gagal memuat daftar kandidat kamar minibar'
        );
      }
      const rawRooms = (roomJson as any)?.data?.rooms ?? (roomJson as any)?.data?.items;
      if (!Array.isArray(rawRooms)) {
        throw new Error('Respons daftar kandidat kamar tidak valid');
      }
      setRoomCandidates(rawRooms);
      return 'ok';
    } catch (err: any) {
      if (isStale()) return 'stale';
      setStockLocationErrorMsg(err?.message || 'Gagal memuat lokasi stok');
      return 'error';
    } finally {
      if (!isStale()) setStockLocationsLoading(false);
    }
  }, [propertyId]);

  const openStockLocationsModal = () => {
    if (!capabilities.canView && !capabilities.canCreate && !capabilities.canEdit && !capabilities.canManageCategory) return;
    setStockLocationErrorMsg(null);
    setStockLocationForm({
      mode: 'add',
      locationType: 'WAREHOUSE',
      code: '',
      name: '',
      roomId: '',
      notes: '',
    });
    setShowStockLocationsModal(true);
    if (propertyId) {
      return loadStockLocationsAndCandidates(propertyId);
    }
  };

  const closeStockLocationsModal = () => {
    if (saving) return;
    setShowStockLocationsModal(false);
    setStockLocationErrorMsg(null);
  };

  const openEditStockLocation = (loc: StockLocationItem) => {
    setStockLocationErrorMsg(null);
    setStockLocationForm({
      mode: 'edit',
      id: loc.id,
      locationType: loc.location_type,
      code: loc.code,
      name: loc.name,
      roomId: loc.room_id != null ? String(loc.room_id) : '',
      notes: loc.notes || '',
    });
  };

  const handleSaveStockLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!capabilities.canCreate && !capabilities.canEdit) || !propertyId) return;
    const codeClean = stockLocationForm.code.trim().toUpperCase();
    const nameClean = stockLocationForm.name.trim();
    if (!codeClean) {
      setStockLocationErrorMsg('Kode lokasi stok wajib diisi');
      return;
    }
    if (!nameClean) {
      setStockLocationErrorMsg('Nama lokasi stok wajib diisi');
      return;
    }
    const isRoomMinibar = stockLocationForm.locationType === 'ROOM_MINIBAR';
    const roomIdVal = isRoomMinibar && stockLocationForm.roomId.trim() !== ''
      ? Number(stockLocationForm.roomId)
      : null;
    if (isRoomMinibar && (!roomIdVal || !Number.isInteger(roomIdVal) || roomIdVal <= 0)) {
      setStockLocationErrorMsg('Kamar fisik wajib dipilih untuk lokasi bertipe Minibar Kamar');
      return;
    }
    if (isRoomMinibar && stockLocationForm.mode === 'add' && roomIdVal != null) {
      const selectedCandidate = roomCandidates.find((r) => Number(r.room_id) === roomIdVal);
      const existingLocId =
        selectedCandidate?.existing_stock_location_id ?? selectedCandidate?.existing_location_id ?? null;
      const existingLocCode =
        selectedCandidate?.existing_stock_location_code ?? selectedCandidate?.existing_location_code ?? null;
      if (
        existingLocId != null ||
        Boolean(existingLocCode) ||
        selectedCandidate?.is_available_for_minibar === false
      ) {
        setStockLocationErrorMsg(
          `Kamar ${selectedCandidate?.room_number || roomIdVal} sudah memiliki lokasi minibar (${existingLocCode || existingLocId})`
        );
        return;
      }
    }

    const targetPropertyId = propertyId;
    const ctx = { pid: targetPropertyId, propGen: propGenRef.current, mutGen: ++savingMutGen.current };
    const stale = () => isMutationStale(ctx);
    try {
      setSaving(true);
      setStockLocationErrorMsg(null);
      const payload =
        stockLocationForm.mode === 'add'
          ? {
              property_id: targetPropertyId,
              code: codeClean,
              name: nameClean,
              location_type: stockLocationForm.locationType,
              room_id: isRoomMinibar ? roomIdVal : null,
              notes: stockLocationForm.notes.trim() === '' ? null : stockLocationForm.notes.trim(),
            }
          : {
              property_id: targetPropertyId,
              code: codeClean,
              name: nameClean,
              notes: stockLocationForm.notes.trim() === '' ? null : stockLocationForm.notes.trim(),
            };
      const url =
        stockLocationForm.mode === 'add'
          ? `/api/pos/stock-locations?property_id=${targetPropertyId}`
          : `/api/pos/stock-locations/${stockLocationForm.id}?property_id=${targetPropertyId}`;
      const method = stockLocationForm.mode === 'add' ? 'POST' : 'PATCH';
      const res = await authenticatedFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => null);
      if (stale()) return;
      if (!res.ok) {
        throw new Error((json as any)?.message || (json as any)?.error || 'Gagal menyimpan lokasi stok');
      }
      setSuccessMsg(
        stockLocationForm.mode === 'add'
          ? `Lokasi stok "${nameClean}" berhasil ditambahkan.`
          : `Lokasi stok "${nameClean}" berhasil diperbarui.`
      );
      setStockLocationForm({
        mode: 'add',
        locationType: 'WAREHOUSE',
        code: '',
        name: '',
        roomId: '',
        notes: '',
      });
      await loadStockLocationsAndCandidates(targetPropertyId);
    } catch (err: any) {
      if (!stale()) setStockLocationErrorMsg(err?.message || 'Gagal menyimpan lokasi stok');
    } finally {
      if (!stale() && ctx.mutGen === savingMutGen.current) setSaving(false);
    }
  };

  const handleToggleStockLocationActive = async (loc: StockLocationItem) => {
    if ((!capabilities.canCreate && !capabilities.canEdit) || !propertyId) return;
    const nextActive = !loc.is_active;
    const targetPropertyId = propertyId;
    const ctx = { pid: targetPropertyId, propGen: propGenRef.current, mutGen: ++savingMutGen.current };
    const stale = () => isMutationStale(ctx);
    try {
      setSaving(true);
      setStockLocationErrorMsg(null);
      const res = await authenticatedFetch(
        `/api/pos/stock-locations/${loc.id}?property_id=${targetPropertyId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            property_id: targetPropertyId,
            is_active: nextActive,
          }),
        }
      );
      const json = await res.json().catch(() => null);
      if (stale()) return;
      if (!res.ok) {
        throw new Error((json as any)?.message || (json as any)?.error || 'Gagal mengubah status lokasi stok');
      }
      setSuccessMsg(`Lokasi stok "${loc.name}" berhasil ${nextActive ? 'diaktifkan' : 'dinonaktifkan'}.`);
      await loadStockLocationsAndCandidates(targetPropertyId);
    } catch (err: any) {
      if (!stale()) setStockLocationErrorMsg(err?.message || 'Gagal mengubah status lokasi stok');
    } finally {
      if (!stale() && ctx.mutGen === savingMutGen.current) setSaving(false);
    }
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

      {/* Top Module Subnav Tabs */}
      <div className="flex items-center gap-2 bg-white p-1.5 rounded-2xl border border-gray-200/80 shadow-2xs">
        <button
          type="button"
          onClick={() => setMainTab('catalog')}
          className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
            mainTab === 'catalog'
              ? 'bg-[#1b4332] text-white shadow-xs'
              : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
          }`}
        >
          Katalog &amp; Master Produk
        </button>
        <button
          type="button"
          onClick={() => setMainTab('inventory')}
          className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
            mainTab === 'inventory'
              ? 'bg-[#1b4332] text-white shadow-xs'
              : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
          }`}
        >
          Inventaris &amp; Saldo Stok POS
        </button>
      </div>

      {mainTab === 'inventory' ? (
        <PosInventoryWorkspace propertyId={propertyId} onRefreshParent={handleRefresh} />
      ) : (
        <>
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
          {(capabilities.canView || capabilities.canCreate || capabilities.canEdit || capabilities.canManageCategory) && (
            <button
              type="button"
              aria-label="Kelola lokasi stok"
              onClick={openStockLocationsModal}
              className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-emerald-200 bg-emerald-50/70 hover:bg-emerald-100 text-emerald-900 text-xs sm:text-sm font-semibold shadow-xs transition-colors cursor-pointer"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              {capabilities.canCreate || capabilities.canEdit ? 'Kelola Lokasi Stok' : 'Lihat Lokasi Stok'}
            </button>
          )}
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
                          <div className="flex flex-col items-start gap-1">
                            <span className={item.base_unit ? 'font-medium text-gray-800' : 'text-xs text-gray-400 italic'}>
                              {unitLabel}
                            </span>
                            <div className="flex flex-wrap items-center gap-1">
                              {item.canonical_base_unit_code && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
                                  {item.canonical_base_unit_code}
                                </span>
                              )}
                              {item.is_base_unit_locked && (
                                <span
                                  title="Satuan dasar terkunci karena kemasan atau pergerakan stok"
                                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-800 border border-amber-200"
                                >
                                  Terkunci
                                </span>
                              )}
                              {Array.isArray(item.packaging_conversions) &&
                                item.packaging_conversions.filter((p) => p.is_active).length > 0 && (
                                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-sky-50 text-sky-800 border border-sky-200">
                                    {item.packaging_conversions.filter((p) => p.is_active).length} Kemasan
                                  </span>
                                )}
                            </div>
                          </div>
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
                              {(capabilities.canEdit || capabilities.canCreate) && (
                                <button
                                  type="button"
                                  aria-label={`Kelola kemasan ${item.name}`}
                                  onClick={() => openPackagingModal(item)}
                                  disabled={saving}
                                  className="text-xs text-sky-700 hover:text-sky-900 font-medium px-2 py-1 rounded hover:bg-sky-50 transition-colors cursor-pointer"
                                >
                                  Kemasan
                                </button>
                              )}
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
        </>
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
                <div className="space-y-2">
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Satuan Dasar</label>
                  <select
                    aria-label="Pilih satuan dasar kanonik"
                    value={newProduct.canonicalBaseUnitCode || ''}
                    onChange={(e) => setNewProduct(applyCanonicalUnitSelection(newProduct, e.target.value, canonicalUnitsCatalog))}
                    className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2"
                  >
                    <option value="">— Belum diatur (Pilih Satuan Standar Kanonik) —</option>
                    {canonicalUnitsCatalog.map((unit) => (
                      <option key={unit.code} value={unit.code}>
                        {unit.code} — {unit.label_id} ({unit.allow_decimal ? 'Pecahan 3 desimal' : 'Bilangan bulat'})
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    list="oak-product-base-units"
                    maxLength={50}
                    placeholder="Contoh: Porsi, Pcs, Kg, Liter"
                    value={newProduct.baseUnit}
                    onChange={(e) => setNewProduct(applyBaseUnitTextChange(newProduct, e.target.value, canonicalUnitsCatalog))}
                    className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2"
                  />
                  <div className="text-[11px] text-gray-500">
                    {newProduct.canonicalBaseUnitCode ? (
                      <span className="text-emerald-800 font-medium">
                        Terpetakan ke satuan kanonik: <strong>{newProduct.canonicalBaseUnitCode}</strong>
                      </span>
                    ) : newProduct.baseUnit.trim() !== '' ? (
                      <span className="text-amber-700">
                        Teks satuan bebas (belum dipetakan ke kode satuan kanonik).
                      </span>
                    ) : (
                      <span>Pilih satuan kanonik atau ketik label satuan dasar produk.</span>
                    )}
                  </div>
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
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="block text-xs font-semibold text-gray-700">Satuan Dasar</label>
                    <button
                      type="button"
                      disabled={saving}
                      aria-label="Buka kelola kemasan produk"
                      onClick={() => openPackagingModal(editingItem)}
                      className="text-xs font-semibold text-sky-700 hover:text-sky-900 bg-sky-50 hover:bg-sky-100 border border-sky-200 px-2.5 py-1 rounded-lg cursor-pointer disabled:opacity-50"
                    >
                      Kelola Kemasan
                    </button>
                  </div>
                  <select
                    aria-label="Pilih satuan dasar kanonik"
                    disabled={saving || Boolean(editingItem.is_base_unit_locked)}
                    value={editProduct.canonicalBaseUnitCode || ''}
                    onChange={(e) => setEditProduct(applyCanonicalUnitSelection(editProduct, e.target.value, canonicalUnitsCatalog))}
                    className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    <option value="">— Belum diatur (Pilih Satuan Standar Kanonik) —</option>
                    {canonicalUnitsCatalog.map((unit) => (
                      <option key={unit.code} value={unit.code}>
                        {unit.code} — {unit.label_id} ({unit.allow_decimal ? 'Pecahan 3 desimal' : 'Bilangan bulat'})
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    list="oak-product-base-units"
                    maxLength={50}
                    disabled={saving || Boolean(editingItem.is_base_unit_locked)}
                    placeholder="Belum diatur (contoh: Porsi, Pcs, Kg)"
                    value={editProduct.baseUnit}
                    onChange={(e) => setEditProduct(applyBaseUnitTextChange(editProduct, e.target.value, canonicalUnitsCatalog))}
                    className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 disabled:opacity-60 disabled:cursor-not-allowed"
                  />
                  {editingItem.is_base_unit_locked ? (
                    <div className="px-2.5 py-1.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-[11px]">
                      Satuan dasar terkunci (<strong>{editingItem.canonical_base_unit_code || editingItem.base_unit}</strong>) karena produk sudah memiliki konversi kemasan atau pergerakan stok.
                    </div>
                  ) : (
                    <div className="text-[11px] text-gray-500">
                      {editProduct.canonicalBaseUnitCode ? (
                        <span className="text-emerald-800 font-medium">
                          Terpetakan ke satuan kanonik: <strong>{editProduct.canonicalBaseUnitCode}</strong>
                        </span>
                      ) : editProduct.baseUnit.trim() !== '' ? (
                        <span className="text-amber-700">
                          Teks satuan bebas (belum dipetakan ke kode satuan kanonik).
                        </span>
                      ) : (
                        <span>Pilih satuan kanonik atau ketik label satuan dasar produk.</span>
                      )}
                    </div>
                  )}
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

      {/* MP-03C: Product Packaging Conversions Modal (Dialog Terpisah) */}
      {packagingModalItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-3 sm:p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-2xl w-full border border-gray-200 max-h-[90vh] flex flex-col overflow-hidden">
            <div className="shrink-0 px-6 pt-5 pb-4 border-b border-gray-100 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-gray-900">
                  Kelola Kemasan Produk — {packagingModalItem.name}
                </h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  Satuan Dasar Kanonik Saat Ini:{' '}
                  <strong className="font-mono text-emerald-800">
                    {packagingModalItem.canonical_base_unit_code || packagingDraft.baseUnitCode || 'Belum ditetapkan'}
                  </strong>
                  {packagingModalItem.is_base_unit_locked ? ' (Terkunci)' : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={closePackagingModal}
                disabled={saving}
                aria-label="Tutup modal kemasan produk"
                className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
              {packagingErrorMsg && (
                <div className="px-3 py-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center justify-between gap-2">
                  <span>{packagingErrorMsg}</span>
                  <button
                    type="button"
                    onClick={() => setPackagingErrorMsg(null)}
                    className="font-bold hover:text-rose-900 shrink-0"
                  >
                    ✕
                  </button>
                </div>
              )}

              {!packagingModalItem.canonical_base_unit_code && !packagingDraft.baseUnitCode && (
                <div className="px-3.5 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs">
                  Produk ini belum memiliki <strong>Satuan Dasar Kanonik</strong>. Silakan tetapkan satuan dasar kanonik terlebih dahulu pada form Edit Produk sebelum menambahkan konversi kemasan.
                </div>
              )}

              {unconfirmedPackagingCreate && (
                <div className="px-3.5 py-3 rounded-xl bg-amber-50 border border-amber-300 text-amber-950 text-xs space-y-2.5">
                  <div className="font-semibold">
                    Status pembuatan kemasan &ldquo;{unconfirmedPackagingCreate.packagingLabel}&rdquo; (1 {unconfirmedPackagingCreate.packagingCode} = {unconfirmedPackagingCreate.toBaseFactor} {unconfirmedPackagingCreate.baseUnitCode}) belum terkonfirmasi dari server.
                  </div>
                  <div className="text-[11px] text-amber-800">
                    Kunci idempotensi (<span className="font-mono">{unconfirmedPackagingCreate.idempotencyKey}</span>) dan snapshot satuan dasar (<span className="font-mono">{unconfirmedPackagingCreate.baseUnitCode}</span>) dipertahankan agar pengiriman ulang aman tanpa membuat baris ganda atau mengubah arti faktor.
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={saving}
                      aria-label="Periksa daftar kemasan"
                      onClick={handleInspectPackagingsAfterUnconfirmedCreate}
                      className="px-3 py-1.5 text-xs font-semibold text-amber-900 bg-white hover:bg-amber-100 rounded-lg border border-amber-300 cursor-pointer disabled:opacity-50"
                    >
                      Periksa Daftar Kemasan
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      aria-label="Ulangi simpan kemasan"
                      onClick={() => handleCreatePackaging()}
                      className="px-3 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg cursor-pointer disabled:opacity-50"
                    >
                      Ulangi Simpan Kemasan
                    </button>
                  </div>
                </div>
              )}

              {/* Form Tambah atau Edit Kemasan */}
              {editingPackaging ? (
                <form onSubmit={handleUpdatePackaging} className="p-4 rounded-xl bg-sky-50/50 border border-sky-200 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-bold text-sky-900">
                      Edit Kemasan ({editingPackaging.packagingCode} → {editingPackaging.baseUnitCode})
                    </div>
                    <button
                      type="button"
                      disabled={saving}
                      aria-label="Batal edit kemasan"
                      onClick={() => setEditingPackaging(null)}
                      className="text-xs text-gray-500 hover:text-gray-700 cursor-pointer"
                    >
                      Batal Edit
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">Label Kemasan *</label>
                      <input
                        type="text"
                        required
                        maxLength={100}
                        aria-label="Edit label kemasan"
                        value={editingPackaging.packagingLabel}
                        onChange={(e) =>
                          setEditingPackaging((prev) => (prev ? { ...prev, packagingLabel: e.target.value } : prev))
                        }
                        className="w-full text-xs sm:text-sm bg-white border border-gray-300 rounded-lg px-3 py-2"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">
                        Faktor ke {editingPackaging.baseUnitCode} *
                      </label>
                      <input
                        type="text"
                        required
                        aria-label="Edit faktor konversi kemasan"
                        value={editingPackaging.toBaseFactor}
                        onChange={(e) =>
                          setEditingPackaging((prev) => (prev ? { ...prev, toBaseFactor: e.target.value } : prev))
                        }
                        className="w-full text-xs sm:text-sm bg-white border border-gray-300 rounded-lg px-3 py-2 font-mono"
                      />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
                    <input
                      type="checkbox"
                      aria-label="Edit jadikan kemasan beli default"
                      checked={editingPackaging.isDefaultPurchase}
                      onChange={(e) =>
                        setEditingPackaging((prev) => (prev ? { ...prev, isDefaultPurchase: e.target.checked } : prev))
                      }
                      className="h-4 w-4 rounded border-gray-300 text-emerald-700"
                    />
                    <span>Jadikan kemasan pembelian default</span>
                  </label>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => setEditingPackaging(null)}
                      className="px-3 py-1.5 text-xs font-semibold text-gray-600 bg-white border border-gray-300 rounded-lg cursor-pointer disabled:opacity-50"
                    >
                      Batal
                    </button>
                    <button
                      type="submit"
                      disabled={saving}
                      aria-label="Simpan perubahan kemasan"
                      className="px-3 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg cursor-pointer disabled:opacity-50"
                    >
                      {saving ? 'Menyimpan…' : 'Simpan Perubahan Kemasan'}
                    </button>
                  </div>
                </form>
              ) : (
                <form onSubmit={handleCreatePackaging} className="p-4 rounded-xl bg-gray-50 border border-gray-200 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-bold text-gray-800">Tambah Konversi Kemasan Baru</div>
                    <span className="text-[11px] font-mono text-gray-500">
                      Snapshot Satuan Dasar: <strong>{packagingDraft.baseUnitCode || '—'}</strong>
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">Kode Kemasan *</label>
                      <input
                        type="text"
                        list="oak-packaging-codes"
                        maxLength={30}
                        aria-label="Pilih kode kemasan"
                        disabled={saving || Boolean(unconfirmedPackagingCreate)}
                        placeholder="Contoh: BOX / KRT / DUS / PAK"
                        value={packagingDraft.packagingCode}
                        onChange={(e) =>
                          setPackagingDraft((prev) => ({ ...prev, packagingCode: e.target.value.toUpperCase() }))
                        }
                        className="w-full text-xs sm:text-sm bg-white border border-gray-300 rounded-lg px-3 py-2 font-mono"
                      />
                      <datalist id="oak-packaging-codes">
                        {['BOX', 'KRT', 'DUS', 'BAL', 'PAK', 'SLOP', 'IKAT', 'TRAY', 'JERIGEN', 'GALON'].map((c) => (
                          <option key={c} value={c} />
                        ))}
                      </datalist>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">Label Kemasan *</label>
                      <input
                        type="text"
                        maxLength={100}
                        aria-label="Label kemasan produk"
                        disabled={saving || Boolean(unconfirmedPackagingCreate)}
                        placeholder="Contoh: Karton 24 Botol"
                        value={packagingDraft.packagingLabel}
                        onChange={(e) =>
                          setPackagingDraft((prev) => ({ ...prev, packagingLabel: e.target.value }))
                        }
                        className="w-full text-xs sm:text-sm bg-white border border-gray-300 rounded-lg px-3 py-2"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">
                        Isi per Kemasan ({packagingDraft.baseUnitCode || 'Satuan Dasar'}) *
                      </label>
                      <input
                        type="text"
                        aria-label="Faktor konversi kemasan"
                        disabled={saving || Boolean(unconfirmedPackagingCreate)}
                        placeholder="Contoh: 24 atau 0.250"
                        value={packagingDraft.toBaseFactor}
                        onChange={(e) =>
                          setPackagingDraft((prev) => ({ ...prev, toBaseFactor: e.target.value }))
                        }
                        className="w-full text-xs sm:text-sm bg-white border border-gray-300 rounded-lg px-3 py-2 font-mono"
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
                      <input
                        type="checkbox"
                        aria-label="Jadikan kemasan beli default"
                        disabled={saving || Boolean(unconfirmedPackagingCreate)}
                        checked={packagingDraft.isDefaultPurchase}
                        onChange={(e) =>
                          setPackagingDraft((prev) => ({ ...prev, isDefaultPurchase: e.target.checked }))
                        }
                        className="h-4 w-4 rounded border-gray-300 text-emerald-700"
                      />
                      <span>Jadikan kemasan pembelian default</span>
                    </label>
                    <button
                      type="submit"
                      aria-label="Tambah kemasan produk"
                      disabled={saving || Boolean(unconfirmedPackagingCreate) || !packagingDraft.baseUnitCode}
                      className="px-3.5 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg cursor-pointer disabled:opacity-50"
                    >
                      {saving ? 'Menyimpan…' : 'Tambah Kemasan'}
                    </button>
                  </div>
                </form>
              )}

              {/* Daftar Kemasan Produk */}
              <div className="space-y-2">
                <div className="text-xs font-bold text-gray-700">Daftar Konversi Kemasan Terdaftar</div>
                {packagingLoading ? (
                  <div className="text-xs text-gray-400 py-4 text-center">Memuat daftar kemasan…</div>
                ) : packagingItems.length === 0 ? (
                  <div className="text-xs text-gray-400 py-4 text-center border border-dashed border-gray-200 rounded-xl">
                    Belum ada konversi kemasan untuk produk ini.
                  </div>
                ) : (
                  <div className="divide-y divide-gray-100 border border-gray-200 rounded-xl overflow-hidden">
                    {packagingItems.map((pkg) => {
                      const unitMismatch =
                        Boolean(packagingModalItem.canonical_base_unit_code) &&
                        pkg.base_unit_code !== packagingModalItem.canonical_base_unit_code;
                      return (
                        <div key={pkg.id} className="p-3 bg-white flex flex-wrap items-center justify-between gap-2">
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs font-bold text-gray-900">{pkg.packaging_code}</span>
                              <span className="text-xs font-semibold text-gray-800">{pkg.packaging_label}</span>
                              {pkg.is_default_purchase && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
                                  Default Beli
                                </span>
                              )}
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${
                                  pkg.is_active
                                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                    : 'bg-gray-100 text-gray-500 border-gray-200'
                                }`}
                              >
                                {pkg.is_active ? 'Aktif' : 'Nonaktif'}
                              </span>
                            </div>
                            <div className="text-[11px] font-mono text-gray-600">
                              1 {pkg.packaging_code} = {pkg.to_base_factor} {pkg.base_unit_code}
                              {unitMismatch && (
                                <span className="ml-2 text-rose-700 font-sans font-semibold">
                                  (Ikatan satuan dasar berbeda dari satuan produk saat ini)
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={saving}
                              aria-label={`Edit kemasan ${pkg.packaging_code}`}
                              onClick={() =>
                                setEditingPackaging({
                                  id: pkg.id,
                                  packagingCode: pkg.packaging_code,
                                  packagingLabel: pkg.packaging_label,
                                  toBaseFactor: pkg.to_base_factor,
                                  isDefaultPurchase: pkg.is_default_purchase,
                                  baseUnitCode: pkg.base_unit_code,
                                })
                              }
                              className="px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 rounded cursor-pointer disabled:opacity-50"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              disabled={saving}
                              aria-label={`${pkg.is_active ? 'Nonaktifkan' : 'Aktifkan'} kemasan ${pkg.packaging_code}`}
                              onClick={() => handleTogglePackagingActive(pkg)}
                              className={`px-2 py-1 text-xs font-medium rounded cursor-pointer disabled:opacity-50 ${
                                pkg.is_active
                                  ? 'text-rose-600 hover:bg-rose-50'
                                  : 'text-emerald-700 hover:bg-emerald-50'
                              }`}
                            >
                              {pkg.is_active ? 'Nonaktifkan' : 'Aktifkan'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="shrink-0 flex justify-end px-6 py-4 border-t border-gray-100 bg-white">
              <button
                type="button"
                onClick={closePackagingModal}
                disabled={saving}
                className="px-4 py-2 text-xs font-semibold text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg cursor-pointer disabled:opacity-50"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MP-03C: Stock Locations & Room Minibar Modal */}
      {showStockLocationsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-3 sm:p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-2xl w-full border border-gray-200 max-h-[90vh] flex flex-col overflow-hidden">
            <div className="shrink-0 px-6 pt-5 pb-4 border-b border-gray-100 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-gray-900">Kelola Lokasi Stok &amp; Minibar Kamar</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  Gudang utama, gudang outlet, dapur/bar, serta lokasi minibar yang ditautkan ke kamar fisik Room Master.
                </p>
              </div>
              <button
                type="button"
                onClick={closeStockLocationsModal}
                disabled={saving}
                aria-label="Tutup modal lokasi stok"
                className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
              {stockLocationErrorMsg && (
                <div className="px-3 py-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center justify-between gap-2">
                  <span>{stockLocationErrorMsg}</span>
                  <button
                    type="button"
                    onClick={() => setStockLocationErrorMsg(null)}
                    className="font-bold hover:text-rose-900 shrink-0"
                  >
                    ✕
                  </button>
                </div>
              )}

              {capabilities.canCreate || capabilities.canEdit ? (
                <form onSubmit={handleSaveStockLocation} className="p-4 rounded-xl bg-gray-50 border border-gray-200 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-bold text-gray-800">
                      {stockLocationForm.mode === 'add' ? 'Tambah Lokasi Stok Baru' : `Edit Lokasi Stok (${stockLocationForm.code})`}
                    </div>
                    {stockLocationForm.mode === 'edit' && (
                      <button
                        type="button"
                        disabled={saving}
                        aria-label="Batal edit lokasi stok"
                        onClick={() =>
                          setStockLocationForm({
                            mode: 'add',
                            locationType: 'WAREHOUSE',
                            code: '',
                            name: '',
                            roomId: '',
                            notes: '',
                          })
                        }
                        className="text-xs text-gray-500 hover:text-gray-700 cursor-pointer"
                      >
                        Batal Edit
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">Tipe Lokasi *</label>
                      <select
                        aria-label="Pilih tipe lokasi stok"
                        disabled={saving || stockLocationForm.mode === 'edit'}
                        value={stockLocationForm.locationType}
                        onChange={(e) => {
                          const nextType = e.target.value as StockLocationTypeCode;
                          setStockLocationForm((prev) => ({
                            ...prev,
                            locationType: nextType,
                            roomId: nextType === 'ROOM_MINIBAR' ? prev.roomId : '',
                          }));
                        }}
                        className="w-full text-xs sm:text-sm bg-white border border-gray-300 rounded-lg px-3 py-2 disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {STOCK_LOCATION_TYPE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    {stockLocationForm.locationType === 'ROOM_MINIBAR' && (
                      <div>
                        <label className="block text-xs font-semibold text-gray-700 mb-1">Kamar Fisik Minibar *</label>
                        <select
                          aria-label="Pilih kamar minibar"
                          disabled={saving || stockLocationForm.mode === 'edit'}
                          value={stockLocationForm.roomId}
                          onChange={(e) => {
                            const selectedRoomId = e.target.value;
                            const candidate = roomCandidates.find((r) => String(r.room_id) === selectedRoomId);
                            setStockLocationForm((prev) => ({
                              ...prev,
                              roomId: selectedRoomId,
                              code:
                                prev.code.trim() === '' && candidate
                                  ? `MB-${candidate.room_number}`
                                  : prev.code,
                              name:
                                prev.name.trim() === '' && candidate
                                  ? `Minibar Kamar ${candidate.room_number}`
                                  : prev.name,
                            }));
                          }}
                          className="w-full text-xs sm:text-sm bg-white border border-gray-300 rounded-lg px-3 py-2"
                        >
                          <option value="">— Pilih Kamar Fisik —</option>
                          {roomCandidates.map((room) => {
                            const existingCode = room.existing_stock_location_code ?? room.existing_location_code;
                            const existingId = room.existing_stock_location_id ?? room.existing_location_id;
                            const existingActive =
                              room.existing_stock_location_is_active ?? room.existing_location_is_active;
                            const isTaken =
                              existingId != null ||
                              Boolean(existingCode) ||
                              room.is_available_for_minibar === false;
                            return (
                              <option key={room.room_id} value={String(room.room_id)} disabled={isTaken}>
                                Kamar {room.room_number} {room.room_type_name ? `(${room.room_type_name})` : ''}
                                {existingCode
                                  ? ` — Terdaftar: ${existingCode}${existingActive === false ? ' [Nonaktif]' : ''}`
                                  : ''}
                              </option>
                            );
                          })}
                        </select>
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">Kode Lokasi *</label>
                      <input
                        type="text"
                        maxLength={50}
                        aria-label="Kode lokasi stok"
                        disabled={saving}
                        placeholder="Contoh: WH-MAIN / MB-101"
                        value={stockLocationForm.code}
                        onChange={(e) =>
                          setStockLocationForm((prev) => ({ ...prev, code: e.target.value.toUpperCase() }))
                        }
                        className="w-full text-xs sm:text-sm bg-white border border-gray-300 rounded-lg px-3 py-2 font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">Nama Lokasi *</label>
                      <input
                        type="text"
                        maxLength={120}
                        aria-label="Nama lokasi stok"
                        disabled={saving}
                        placeholder="Contoh: Gudang Utama / Minibar Kamar 101"
                        value={stockLocationForm.name}
                        onChange={(e) =>
                          setStockLocationForm((prev) => ({ ...prev, name: e.target.value }))
                        }
                        className="w-full text-xs sm:text-sm bg-white border border-gray-300 rounded-lg px-3 py-2"
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <input
                      type="text"
                      maxLength={250}
                      aria-label="Catatan lokasi stok"
                      disabled={saving}
                      placeholder="Catatan lokasi (opsional)"
                      value={stockLocationForm.notes}
                      onChange={(e) =>
                        setStockLocationForm((prev) => ({ ...prev, notes: e.target.value }))
                      }
                      className="flex-1 min-w-[200px] text-xs bg-white border border-gray-300 rounded-lg px-3 py-2"
                    />
                    <button
                      type="submit"
                      aria-label="Simpan lokasi stok"
                      disabled={saving}
                      className="px-3.5 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg cursor-pointer disabled:opacity-50"
                    >
                      {saving
                        ? 'Menyimpan…'
                        : stockLocationForm.mode === 'add'
                          ? 'Tambah Lokasi Stok'
                          : 'Simpan Lokasi Stok'}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="px-3.5 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs">
                  Mode baca saja — Anda memiliki akses lihat lokasi stok dan kandidat kamar minibar.
                </div>
              )}

              <div className="space-y-2">
                <div className="text-xs font-bold text-gray-700">Daftar Lokasi Stok Properti</div>
                {stockLocationsLoading ? (
                  <div className="text-xs text-gray-400 py-4 text-center">Memuat lokasi stok…</div>
                ) : stockLocations.length === 0 ? (
                  <div className="text-xs text-gray-400 py-4 text-center border border-dashed border-gray-200 rounded-xl">
                    Belum ada lokasi stok terdaftar di properti ini.
                  </div>
                ) : (
                  <div className="divide-y divide-gray-100 border border-gray-200 rounded-xl overflow-hidden">
                    {stockLocations.map((loc) => (
                      <div key={loc.id} className="p-3 bg-white flex flex-wrap items-center justify-between gap-2">
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-bold text-gray-900">{loc.code}</span>
                            <span className="text-xs font-semibold text-gray-800">{loc.name}</span>
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-700 border border-slate-200">
                              {formatStockLocationTypeLabel(loc.location_type)}
                            </span>
                            {loc.room_number && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
                                Kamar {loc.room_number}
                              </span>
                            )}
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${
                                loc.is_active
                                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                  : 'bg-gray-100 text-gray-500 border-gray-200'
                              }`}
                            >
                              {loc.is_active ? 'Aktif' : 'Nonaktif'}
                            </span>
                          </div>
                          {loc.notes && <div className="text-[11px] text-gray-500">{loc.notes}</div>}
                        </div>
                        {(capabilities.canCreate || capabilities.canEdit) && (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={saving}
                              aria-label={`Edit lokasi ${loc.code}`}
                              onClick={() => openEditStockLocation(loc)}
                              className="px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 rounded cursor-pointer disabled:opacity-50"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              disabled={saving}
                              aria-label={`${loc.is_active ? 'Nonaktifkan' : 'Aktifkan'} lokasi ${loc.code}`}
                              onClick={() => handleToggleStockLocationActive(loc)}
                              className={`px-2 py-1 text-xs font-medium rounded cursor-pointer disabled:opacity-50 ${
                                loc.is_active
                                  ? 'text-rose-600 hover:bg-rose-50'
                                  : 'text-emerald-700 hover:bg-emerald-50'
                              }`}
                            >
                              {loc.is_active ? 'Nonaktifkan' : 'Aktifkan'}
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="shrink-0 flex justify-end px-6 py-4 border-t border-gray-100 bg-white">
              <button
                type="button"
                onClick={closeStockLocationsModal}
                disabled={saving}
                className="px-4 py-2 text-xs font-semibold text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg cursor-pointer disabled:opacity-50"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
