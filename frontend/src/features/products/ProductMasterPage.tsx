import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, Trash2 } from 'lucide-react';
import { authenticatedFetch } from '../../lib/authenticatedFetch';
import { useAuth } from '../auth/AuthContext';
import { getMasterProductCapabilities } from './productMasterPermissions';
import ProductRecipeModal from './ProductRecipeModal';
import {
  downloadProductTemplateXlsx,
  exportProductsToXlsx,
  parseProductsFromXlsxFile,
  type ProductVariantDto,
  type ParsedExcelProductRow,
} from './productExcelUtils';

export type ProductTypeCode = 'RAW_MATERIAL' | 'SEMI_FINISHED' | 'FINISHED_GOOD' | 'OPERATIONAL_ITEM';
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
  sku?: string | null;
  barcode?: string | null;
  name: string;
  category_id?: number | null;
  category_name?: string | null;
  price: number | string | null;
  cost_price?: number | string | null;
  is_active?: boolean;
  is_sellable_pos?: boolean;
  track_stock?: boolean;
  track_inventory?: boolean;
  default_location_id?: number | null;
  storage_sublocation?: string | null;
  variants?: ProductVariantDto[] | null;
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
  product_type?: ProductTypeCode | string | null;
}

export interface ProductVariantFormDraft {
  name: string;
  price: string;
  costPrice: string;
  barcode: string;
}

interface Props {
  propertyId: number | null;
  items?: ProductItem[];
  onRefresh?: () => void;
}

type StatusFilter = 'active' | 'inactive' | 'all';
type ProductTypeFilter = 'ALL' | 'FINISHED_GOOD' | 'SEMI_FINISHED' | 'RAW_MATERIAL' | 'OPERATIONAL_ITEM';
type SellableFilter = 'all' | 'sellable' | 'internal';
type StockFilter = 'all' | 'tracked' | 'untracked';

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
  trackStock?: boolean;
  defaultLocationId?: string;
  storageSublocation?: string;
  variants?: ProductVariantFormDraft[];
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
  trackStock: false,
  defaultLocationId: '',
  storageSublocation: '',
  variants: [],
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
  if (item.storage_sublocation && item.storage_sublocation.toLowerCase().includes(q)) return true;
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
  { key: 'FINISHED_GOOD', label: 'Produk Jadi' },
  { key: 'SEMI_FINISHED', label: 'Setengah Jadi' },
  { key: 'RAW_MATERIAL', label: 'Bahan Baku' },
  { key: 'OPERATIONAL_ITEM', label: 'Item Operasional' },
];

export const PRODUCT_TYPE_CHOICES: Array<{ value: ProductTypeCode; label: string; hint: string }> = [
  { value: 'FINISHED_GOOD', label: 'Produk Jadi', hint: 'Siap disajikan / dijual' },
  { value: 'SEMI_FINISHED', label: 'Setengah Jadi', hint: 'Olahan antara / prep' },
  { value: 'RAW_MATERIAL', label: 'Bahan Baku', hint: 'Bahan mentah / stok F&B' },
  { value: 'OPERATIONAL_ITEM', label: 'Item Operasional', hint: 'Linen, handuk & amenities HK' },
];

const COMMON_BASE_UNITS = ['Porsi', 'Pcs', 'Gelas', 'Botol', 'Kaleng', 'Cup', 'Pack', 'Box', 'Kg', 'Gram', 'Liter', 'Ml'];
const COMMON_STORAGE_SUBLOCATIONS = [
  'Showcase',
  'Chiller',
  'Freezer',
  'Rak Kering',
  'Gudang Kering',
  'Lemari Linen',
  'Rak Amenities',
  'Pantry',
  'Bar Counter',
  'Minibar',
];

let packagingIdempotencyCounter = 0;

export function createPackagingIdempotencyKey(propertyId: number | null | undefined, itemId: number): string {
  packagingIdempotencyCounter += 1;
  const pid = propertyId ?? 0;
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `mp03c-pkg-p${pid}-i${itemId}-${ts}-${packagingIdempotencyCounter}-${rand}`;
}

export function resolveInitialProductTypeFromTab(tab: ProductTypeFilter): string {
  if (
    tab === 'FINISHED_GOOD' ||
    tab === 'SEMI_FINISHED' ||
    tab === 'RAW_MATERIAL' ||
    tab === 'OPERATIONAL_ITEM'
  ) {
    return tab;
  }
  return '';
}

export function createInitialAddProductForm(tab: ProductTypeFilter): ProductFormState {
  const initialType = resolveInitialProductTypeFromTab(tab);
  return {
    ...EMPTY_PRODUCT_FORM,
    productType: initialType,
    isSellablePos: initialType === 'OPERATIONAL_ITEM' ? false : EMPTY_PRODUCT_FORM.isSellablePos,
    trackStock:
      initialType === 'RAW_MATERIAL' ||
      initialType === 'SEMI_FINISHED' ||
      initialType === 'OPERATIONAL_ITEM',
  };
}

export function applyProductTypeChange(form: ProductFormState, nextType: string): ProductFormState {
  const upperNext = nextType.trim().toUpperCase();
  const nextTrackStock =
    upperNext === 'RAW_MATERIAL' ||
    upperNext === 'SEMI_FINISHED' ||
    upperNext === 'OPERATIONAL_ITEM'
      ? true
      : Boolean(form.trackStock);
  const nextIsSellablePos =
    upperNext === 'OPERATIONAL_ITEM' ? false : Boolean(form.isSellablePos);
  return {
    ...form,
    productType: nextType,
    isSellablePos: nextIsSellablePos,
    trackStock: nextTrackStock,
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

// MPUI-F04: satu normalisasi stok terlacak untuk ikon, filter, KPI dan form.
// false eksplisit pada track_inventory selalu menang; fallback tipe mengikuti
// semantik buildEditProductForm (RAW_MATERIAL/SEMI_FINISHED default terlacak).
export function isStockTrackedCanonical(item: {
  product_type?: string | null;
  track_stock?: boolean | null;
  track_inventory?: boolean | null;
}): boolean {
  const hasStock = typeof item.track_stock === 'boolean';
  const hasInv = typeof item.track_inventory === 'boolean';
  if (hasStock && hasInv) {
    return item.track_stock === true && item.track_inventory !== false;
  }
  if (!hasStock && !hasInv) {
    const rawType = String(item.product_type || '').trim().toUpperCase();
    return (
      rawType === 'RAW_MATERIAL' ||
      rawType === 'SEMI_FINISHED' ||
      rawType === 'OPERATIONAL_ITEM'
    );
  }
  // Tepat satu flag tersedia (kompatibilitas record parsial/legacy):
  if (hasStock) {
    // track_stock diketahui; track_inventory absen -> hormati true, false eksplisit tidak ada
    return item.track_stock === true;
  }
  // Hanya track_inventory diketahui
  return item.track_inventory === true;
}

export function buildEditProductForm(item: ProductItem): ProductFormState {
  const rawType = String(item.product_type || '').trim().toUpperCase();
  const defaultTracked =
    rawType === 'RAW_MATERIAL' ||
    rawType === 'SEMI_FINISHED' ||
    rawType === 'OPERATIONAL_ITEM';
  const effectiveTrackStock =
    typeof item.track_stock === 'boolean'
      ? item.track_inventory === false
        ? false
        : item.track_stock
      : typeof item.track_inventory === 'boolean'
        ? item.track_inventory
        : defaultTracked;
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
    trackStock: effectiveTrackStock,
    defaultLocationId: item.default_location_id != null ? String(item.default_location_id) : '',
    storageSublocation: typeof item.storage_sublocation === 'string' ? item.storage_sublocation : '',
    variants: Array.isArray(item.variants)
      ? item.variants.map((v) => ({
          name: v.name || '',
          price: v.price != null ? String(v.price) : '0',
          costPrice: v.cost_price != null ? String(v.cost_price) : '',
          barcode: v.barcode || '',
        }))
      : [],
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
    case 'OPERATIONAL_ITEM':
      return 'Item Operasional';
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

export function formatSellingPriceDisplay(
  price: number | string | null | undefined,
  isSellablePos?: boolean
): {
  text: string;
  isUnset: boolean;
} {
  // MPUI-F02: harga produk non-POS yang belum diisi tampil tanda pisah (tidak berlaku),
  // tanpa menyentuh nilai harga yang tersimpan.
  if (price === null || price === undefined || (typeof price === 'string' && price.trim() === '')) {
    return { text: isSellablePos === false ? '—' : 'Belum diatur', isUnset: true };
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
  const [productTypeFilter, setProductTypeFilter] = useState<ProductTypeFilter>('FINISHED_GOOD');
  const [sellableFilter, setSellableFilter] = useState<SellableFilter>('all');
  const [stockFilter, setStockFilter] = useState<StockFilter>('all');
  // MPUI-F03: kontrol urutan (stabil, tanpa mutasi items/props)
  const [sortKey, setSortKey] = useState<'default' | 'name_asc' | 'name_desc'>('default');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showAddOptional, setShowAddOptional] = useState(false);
  const [showEditOptional, setShowEditOptional] = useState(false);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [editingItem, setEditingItem] = useState<ProductItem | null>(null);
  const [saving, setSaving] = useState(false);
  // kategori dropdown state
  const [categoryDropdownOpen, setCategoryDropdownOpen] = useState(false);
  const [categorySearchQuery, setCategorySearchQuery] = useState('');
  const categoryDropdownRef = useRef<HTMLButtonElement | null>(null);
  const categoryPanelRef = useRef<HTMLDivElement | null>(null);
  // MPUI-F01: posisi dropdown kategori terikat tombol trigger (portal, clamp viewport)
  const [categoryMenuPosition, setCategoryMenuPosition] = useState<{ top: number; right: number } | null>(null);
  // MPUI-F01: state toggle per row untuk menu tiga titik (portal-based, tidak clipped)
  const [openMenuRowId, setOpenMenuRowId] = useState<number | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number | null; bottom: number | null; right: number }>({ top: null, bottom: null, right: 0 });
  const menuButtonRef = useRef<HTMLElement | null>(null);
  const menuPortalRef = useRef<HTMLDivElement | null>(null);
  // Harga disimpan sebagai string agar "kosong" bisa dibedakan dari "0".
  const [newProduct, setNewProduct] = useState<ProductFormState>({ ...EMPTY_PRODUCT_FORM });
  const [editProduct, setEditProduct] = useState<ProductFormState>({ ...EMPTY_PRODUCT_FORM });
  const [categoryForm, setCategoryForm] = useState<{ mode: 'add' | 'rename'; id?: number; name: string; productType: string }>({
    mode: 'add',
    name: '',
    productType: 'FINISHED_GOOD',
  });
  const [showExcelImportModal, setShowExcelImportModal] = useState(false);
  const [excelImportRows, setExcelImportRows] = useState<ParsedExcelProductRow[]>([]);
  const [excelImportMode, setExcelImportMode] = useState<'UPSERT' | 'CREATE_ONLY' | 'UPDATE_ONLY'>('UPSERT');
  const [excelImportFileName, setExcelImportFileName] = useState<string>('');
  const [excelImportError, setExcelImportError] = useState<string | null>(null);
  const [excelImportLoading, setExcelImportLoading] = useState(false);
  const excelFileInputRef = useRef<HTMLInputElement | null>(null);
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

  // ── MP-04C: State Formula Resep / Bill of Materials (BOM) ──
  const [recipeModalItem, setRecipeModalItem] = useState<ProductItem | null>(null);

  const openRecipeModal = (item: ProductItem) => {
    setRecipeModalItem(item);
  };

  const closeRecipeModal = () => {
    setRecipeModalItem(null);
  };

  // ── MPUI-F01: Handler portal-based three-dot menu ──────────────────────────
  const toggleRowMenu = (e: React.MouseEvent | React.KeyboardEvent, item: ProductItem) => {
    e.stopPropagation();
    e.preventDefault();
    const btn = (e.currentTarget as HTMLElement) ?? null;
    const menuBtnRef = (menuButtonRef as React.MutableRefObject<HTMLElement | null>).current;
    // If this exact button is already open, close it
    if (openMenuRowId === item.id && menuBtnRef === btn) {
      setOpenMenuRowId(null);
      btn?.focus();
      return;
    }
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const estimatedMenuH = 120; // 3 items ≈ 3×28px + padding
    const openUp = rect.bottom + estimatedMenuH > viewportH;
    // Buka-ke-bawah: menu menempel di bawah tombol.
    // Buka-ke-atas: menu menempel di atas tombol, dihitung sekali dari rect.top (tanpa offset ganda).
    const top = openUp ? null : rect.bottom + 4;
    const bottom = openUp ? window.innerHeight - rect.top + 4 : null;
    const right = Math.max(4, window.innerWidth - rect.right);
    setMenuPosition({ top, bottom, right });
    // Simpan trigger aktif secara stabil agar Escape/fokus kembali ke tombol yang membuka.
    (menuButtonRef as React.MutableRefObject<HTMLElement | null>).current = btn;
    setOpenMenuRowId(item.id);
  };

  const closeRowMenu = (focusBack = true) => {
    const btn = (menuButtonRef as React.MutableRefObject<HTMLElement | null>).current;
    setOpenMenuRowId(null);
    if (focusBack && btn) {
      btn.focus();
    }
  };

  // Close on outside click / Escape
  useEffect(() => {
    if (openMenuRowId === null) return;
    const handleOutside = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      const menuEl = menuPortalRef.current;
      const triggerBtn = (menuButtonRef as React.MutableRefObject<HTMLElement | null>).current;
      if (menuEl && menuEl.contains(target)) return;
      if (triggerBtn && triggerBtn.contains(target)) return;
      closeRowMenu(false);
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeRowMenu(true);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('touchstart', handleOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('touchstart', handleOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [openMenuRowId]);

      {/* MPUI-F01/F03: tutup dropdown kategori bila filter berubah (stale guard) */}
  useEffect(() => {
    if (categoryDropdownOpen) {
      setCategoryDropdownOpen(false);
      setCategoryMenuPosition(null);
      setCategorySearchQuery('');
    }
  }, [searchQuery, productTypeFilter, sellableFilter, stockFilter, statusFilter]);

  // Close/revalidate menu when filters change (stale action protection)
  useEffect(() => {
    if (openMenuRowId !== null) {
      setOpenMenuRowId(null);
    }
  }, [searchQuery, selectedCategory, productTypeFilter, sellableFilter, stockFilter, statusFilter]);

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
      setStockFilter('all');
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
    setStockFilter('all');
    setSearchQuery('');
    setErrorMsg(null);
    setSuccessMsg(null);
    setLoading(true);
    void loadStockLocationsAndCandidates(propertyId);
  }, [propertyId]); // loadProducts dipanggil satu kali oleh useEffect([statusFilter, propertyId]) di bawah

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

  const getCategoriesForProductType = useCallback(
    (targetProductType: string, currentCategoryId?: string): CategoryOption[] => {
      const upperTarget = (targetProductType || 'FINISHED_GOOD').trim().toUpperCase();
      if (!upperTarget || upperTarget === 'ALL') return categories;
      return categories.filter((c) => {
        if (currentCategoryId && String(c.id) === String(currentCategoryId)) return true;
        const catType = c.product_type ? String(c.product_type).trim().toUpperCase() : 'FINISHED_GOOD';
        return catType === upperTarget;
      });
    },
    [categories]
  );

  const activeTabCategories = useMemo(() => {
    const activeType = productTypeFilter === 'ALL' ? 'FINISHED_GOOD' : productTypeFilter;
    return categories.filter((c) => {
      const catType = c.product_type ? String(c.product_type).trim().toUpperCase() : 'FINISHED_GOOD';
      return catType === activeType;
    });
  }, [categories, productTypeFilter]);

  // Click-outside handler for the category dropdown
  useEffect(() => {
    if (!categoryDropdownOpen) return;
    const handleOutside = (e: MouseEvent) => {
      const triggerBtn = (categoryDropdownRef as React.RefObject<HTMLButtonElement | null>).current;
      const target = e.target as Node;
      // Klik pada tombol trigger ATAU di dalam panel portal tidak dianggap klik luar;
      // mencari/ketik/memilih kategori tetap menjaga panel terbuka pada tahap mousedown.
      if (triggerBtn && triggerBtn.contains(target)) return;
      if (categoryPanelRef.current && categoryPanelRef.current.contains(target)) return;
      setCategoryDropdownOpen(false);
      setCategorySearchQuery('');
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCategoryDropdownOpen(false);
        setCategorySearchQuery('');
        const triggerBtn = (categoryDropdownRef as React.RefObject<HTMLButtonElement | null>).current;
        triggerBtn?.focus();
      }
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [categoryDropdownOpen]);

  // Statistik berdasarkan data OAK aktual yang dimuat pada filter status saat ini.
  const stats = useMemo(() => {
    const total = items.length;
    const activeCount = items.filter((i) => i.is_active !== false).length;
    const sellableCount = items.filter((i) => i.is_sellable_pos !== false).length;
    const internalCount = items.filter((i) => i.is_sellable_pos === false).length;
    const finishedCount = items.filter((i) => (i.product_type || 'FINISHED_GOOD') === 'FINISHED_GOOD').length;
    const semiCount = items.filter((i) => i.product_type === 'SEMI_FINISHED').length;
    const rawCount = items.filter((i) => i.product_type === 'RAW_MATERIAL').length;
    const operationalCount = items.filter((i) => i.product_type === 'OPERATIONAL_ITEM').length;
    const unsetTypeCount = items.filter((i) => !i.product_type).length;
    const stockTrackedCount = items.filter((i) => isStockTrackedCanonical(i)).length;
    return {
      total,
      activeCount,
      sellableCount,
      internalCount,
      finishedCount,
      semiCount,
      rawCount,
      operationalCount,
      unsetTypeCount,
      stockTrackedCount,
      categories: categories.length,
    };
  }, [items, categories]);

  const productTypeCounts = useMemo<Record<ProductTypeFilter, number>>(() => ({
    ALL: stats.total,
    FINISHED_GOOD: stats.finishedCount,
    SEMI_FINISHED: stats.semiCount,
    RAW_MATERIAL: stats.rawCount,
    OPERATIONAL_ITEM: stats.operationalCount,
  }), [stats]);

  const filteredItems = useMemo(() => {
    const list = items.filter((item) => {
      const matchSearch = matchesProductSearch(item, searchQuery);
      const matchCategory =
        selectedCategory === 'ALL' ||
        (selectedCategory !== 'NONE'
          ? (item.category_name || 'Tanpa Kategori') === selectedCategory
          : item.category_name === null || item.category_name === undefined || item.category_name === '');
      const itemProductType = item.product_type || 'FINISHED_GOOD';
      const matchProductType =
        productTypeFilter === 'ALL' || itemProductType === productTypeFilter;
      const itemSellable = item.is_sellable_pos !== false;
      const matchSellable =
        sellableFilter === 'all' ||
        (sellableFilter === 'sellable' ? itemSellable : !itemSellable);
      const isStockTracked = isStockTrackedCanonical(item);
      const matchStock =
        stockFilter === 'all' ||
        (stockFilter === 'tracked' ? isStockTracked : !isStockTracked);
      const matchStatus =
        statusFilter === 'all' ||
        (statusFilter === 'active' ? item.is_active !== false : item.is_active === false);
      return matchSearch && matchCategory && matchProductType && matchSellable && matchStock && matchStatus;
    });
    // MPUI-F03: urutan hasil filter — salinan, tanpa memutasi items/props; ties stabil (id)
    if (sortKey !== 'default') {
      const dir = sortKey === 'name_asc' ? 1 : -1;
      return [...list].sort((a, b) => {
        const cmp = (a.name || '').localeCompare((b.name || ''), 'id', { sensitivity: 'base' }) * dir;
        return cmp !== 0 ? cmp : a.id - b.id;
      });
    }
    return list;
  }, [items, searchQuery, selectedCategory, productTypeFilter, sellableFilter, stockFilter, statusFilter, sortKey]);

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
        track_stock: Boolean(newProduct.trackStock),
        track_inventory: Boolean(newProduct.trackStock),
        product_type: newProduct.productType === '' ? null : newProduct.productType,
        product_kind: newProduct.productKind === '' ? null : newProduct.productKind,
        base_unit: baseUnitClean === '' ? null : baseUnitClean,
        description: newProduct.description.trim() === '' ? null : newProduct.description.trim(),
      };
      if (canonicalCodeClean !== '') {
        productPayload.canonical_base_unit_code = canonicalCodeClean;
      }
      const addSublocationClean = (newProduct.storageSublocation || '').trim();
      if (addSublocationClean !== '') {
        productPayload.storage_sublocation = addSublocationClean;
      }
      if (newProduct.defaultLocationId && newProduct.defaultLocationId.trim() !== '') {
        const dlId = Number(newProduct.defaultLocationId);
        if (Number.isInteger(dlId) && dlId > 0) {
          productPayload.default_location_id = dlId;
        }
      }
      if (newProduct.productType === 'FINISHED_GOOD' && Array.isArray(newProduct.variants)) {
        productPayload.variants = newProduct.variants
          .filter((v) => v.name.trim() !== '')
          .map((v) => ({
            name: v.name.trim(),
            price: Math.max(0, Math.round(Number(v.price) || 0)),
            cost_price: v.costPrice.trim() !== '' ? Math.max(0, Math.round(Number(v.costPrice) || 0)) : null,
            barcode: v.barcode.trim() !== '' ? v.barcode.trim() : null,
          }));
      } else {
        productPayload.variants = [];
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
        track_stock: Boolean(editProduct.trackStock),
        track_inventory: Boolean(editProduct.trackStock),
        product_type: editProduct.productType === '' ? null : editProduct.productType,
        product_kind: editProduct.productKind === '' ? null : editProduct.productKind,
      };
      const origSublocation = typeof editingItem.storage_sublocation === 'string' ? editingItem.storage_sublocation.trim() : '';
      const nextSublocation = (editProduct.storageSublocation || '').trim();
      if (nextSublocation !== origSublocation || nextSublocation !== '') {
        patch.storage_sublocation = nextSublocation === '' ? null : nextSublocation;
      }
      const origDefaultLoc = editingItem.default_location_id != null ? String(editingItem.default_location_id) : '';
      const nextDefaultLoc = (editProduct.defaultLocationId || '').trim();
      if (nextDefaultLoc !== origDefaultLoc) {
        patch.default_location_id = nextDefaultLoc === '' ? null : Number(nextDefaultLoc) || null;
      }
      if (editProduct.productType === 'FINISHED_GOOD' && Array.isArray(editProduct.variants)) {
        patch.variants = editProduct.variants
          .filter((v) => v.name.trim() !== '')
          .map((v) => ({
            name: v.name.trim(),
            price: Math.max(0, Math.round(Number(v.price) || 0)),
            cost_price: v.costPrice.trim() !== '' ? Math.max(0, Math.round(Number(v.costPrice) || 0)) : null,
            barcode: v.barcode.trim() !== '' ? v.barcode.trim() : null,
          }));
      } else {
        patch.variants = [];
      }
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

  const handleDeleteProduct = async (item: ProductItem) => {
    if (!capabilities.canEdit && !capabilities.canToggleStatus) return;
    if (!propertyId) return;
    if (
      !window.confirm(
        `Hapus produk "${item.name}"?\n\nProduk akan dihapus dari daftar Master Barang & Produk, namun riwayat penjualan POS tetap tersimpan utuh.`
      )
    ) {
      return;
    }
    const targetPropertyId = propertyId;
    const ctx = { pid: targetPropertyId, propGen: propGenRef.current, mutGen: ++savingMutGen.current };
    const stale = () => isMutationStale(ctx);
    try {
      setSaving(true);
      setErrorMsg(null);
      const res = await authenticatedFetch(`/api/pos/menu/items/${item.id}?property_id=${targetPropertyId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: targetPropertyId }),
      });
      const json = await res.json().catch(() => null);
      if (stale()) return;
      if (!res.ok) {
        throw new Error((json as any)?.message || 'Gagal menghapus produk');
      }
      setSuccessMsg(`Produk "${item.name}" berhasil dihapus.`);
      const { propertyId: curPid, statusFilter: curSf } = ctxRef.current;
      await loadProducts(curSf, curPid);
      if (stale()) return;
      onRefresh?.();
    } catch (err: any) {
      if (!stale()) setErrorMsg(err?.message || 'Gagal menghapus produk');
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
          body: JSON.stringify({
            property_id: targetPropertyId,
            name,
            product_type: categoryForm.productType || null,
          })
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
            body: JSON.stringify({
              property_id: targetPropertyId,
              name,
              product_type: categoryForm.productType || null,
            })
          }
        );
        const json = await res.json().catch(() => null);
        if (stale()) return; // properti sudah berganti — abaikan respons submit lama
        if (!res.ok) throw new Error((json as any)?.message || 'Gagal mengganti nama kategori');
        setSuccessMsg(`Kategori berhasil diubah menjadi "${name}".`);
      }
      setShowCategoryModal(false);
      setCategoryForm({
        mode: 'add',
        name: '',
        productType: productTypeFilter !== 'ALL' ? productTypeFilter : 'FINISHED_GOOD',
      });
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

  const handleQuickAddCategoryFromDropdown = async () => {
    if (!capabilities.canManageCategory) return;
    if (!propertyId) return;
    const name = categorySearchQuery.trim();
    if (!name) {
      const inputEl = categoryPanelRef.current?.querySelector('input');
      if (inputEl instanceof HTMLInputElement) {
        inputEl.focus();
      }
      return;
    }
    const targetPropertyId = propertyId;
    const activeType = productTypeFilter !== 'ALL' ? productTypeFilter : 'FINISHED_GOOD';
    const ctx = { pid: targetPropertyId, propGen: propGenRef.current, mutGen: ++savingMutGen.current };
    const stale = () => isMutationStale(ctx);
    try {
      setSaving(true);
      setErrorMsg(null);
      const res = await authenticatedFetch('/api/pos/menu/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: targetPropertyId,
          name,
          product_type: activeType,
        }),
      });
      const json = await res.json().catch(() => null);
      if (stale()) return;
      if (!res.ok) throw new Error((json as any)?.message || 'Gagal menambah kategori');
      setCategorySearchQuery('');
      setSuccessMsg(`Kategori "${name}" (${formatProductTypeLabel(activeType)}) berhasil ditambahkan.`);
      const { propertyId: curPid, statusFilter: curSf } = ctxRef.current;
      await loadProducts(curSf, curPid);
      if (stale()) return;
      onRefresh?.();
    } catch (err: any) {
      if (!stale()) setErrorMsg(err?.message || 'Gagal menambah kategori');
    } finally {
      if (!stale() && ctx.mutGen === savingMutGen.current) setSaving(false);
    }
  };

  const handleDeleteCategory = async (cat: CategoryOption) => {
    if (!capabilities.canDeleteCategory) return;
    if (!propertyId) return;
    if (!window.confirm(`Hapus kategori "${cat.name}"?`)) return;
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
      if (selectedCategory === cat.name) {
        setSelectedCategory('ALL');
      }
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

  const openRenameCategory = (cat: CategoryOption) => {
    if (!capabilities.canManageCategory) return;
    setCategoryForm({
      mode: 'rename',
      id: cat.id,
      name: cat.name,
      productType: cat.product_type ? String(cat.product_type) : '',
    });
    setShowCategoryModal(true);
  };

  const openExcelImportModal = () => {
    setExcelImportError(null);
    setExcelImportRows([]);
    setExcelImportMode('UPSERT');
    setExcelImportFileName('');
    setShowExcelImportModal(true);
    if (propertyId) {
      void loadStockLocationsAndCandidates(propertyId);
    }
  };

  const excelImportPreviewAnalysis = useMemo(() => {
    const existingCodes = new Set<string>();
    const existingNames = new Set<string>();
    for (const it of items) {
      if (it.item_code && String(it.item_code).trim()) {
        existingCodes.add(String(it.item_code).trim().toUpperCase());
      }
      if (it.name && String(it.name).trim()) {
        existingNames.add(String(it.name).replace(/\s+/g, ' ').trim().toLowerCase());
      }
    }

    const seenFileCodes = new Set<string>();
    const seenFileNames = new Set<string>();
    let newCount = 0;
    let updateCount = 0;
    let skipCount = 0;

    const rowStatuses = excelImportRows.map((r) => {
      const codeKey = r.sku ? String(r.sku).trim().toUpperCase() : '';
      const nameKey = String(r.name || '').replace(/\s+/g, ' ').trim().toLowerCase();

      if ((codeKey && seenFileCodes.has(codeKey)) || (nameKey && seenFileNames.has(nameKey))) {
        skipCount++;
        return 'DUPLICATE_IN_FILE' as const;
      }
      if (codeKey) seenFileCodes.add(codeKey);
      if (nameKey) seenFileNames.add(nameKey);

      const existsInDb =
        (codeKey !== '' && existingCodes.has(codeKey)) ||
        (nameKey !== '' && existingNames.has(nameKey));

      if (existsInDb) {
        if (excelImportMode === 'CREATE_ONLY') {
          skipCount++;
          return 'SKIP_EXISTING' as const;
        }
        updateCount++;
        return 'UPDATE' as const;
      }

      if (excelImportMode === 'UPDATE_ONLY') {
        skipCount++;
        return 'SKIP_MISSING' as const;
      }
      newCount++;
      return 'NEW' as const;
    });

    return {
      rowStatuses,
      newCount,
      updateCount,
      skipCount,
      actionableCount: newCount + updateCount,
    };
  }, [excelImportRows, excelImportMode, items]);

  const handleExcelFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setExcelImportError(null);
    setExcelImportFileName(file.name);
    try {
      const defaultType: ProductTypeCode =
        productTypeFilter !== 'ALL' ? productTypeFilter : 'FINISHED_GOOD';
      const parsed = await parseProductsFromXlsxFile(file, defaultType);
      setExcelImportRows(parsed);
    } catch (err: any) {
      setExcelImportRows([]);
      setExcelImportError(err?.message || 'Gagal membaca file Excel (.xlsx)');
    } finally {
      if (excelFileInputRef.current) excelFileInputRef.current.value = '';
    }
  };

  const handleBulkExcelImportSubmit = async () => {
    if (!propertyId || excelImportRows.length === 0 || excelImportLoading) return;
    const targetPropertyId = propertyId;
    setExcelImportLoading(true);
    setExcelImportError(null);
    try {
      const res = await authenticatedFetch('/api/pos/menu/items/bulk-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: targetPropertyId,
          import_mode: excelImportMode,
          rows: excelImportRows.map((r) => ({
            sku: r.sku || null,
            barcode: r.barcode || null,
            name: String(r.name || '').replace(/\s+/g, ' ').trim(),
            product_type: r.product_type,
            category_name: r.category_name || null,
            base_unit: r.base_unit || 'PCS',
            location_code: r.location_code || null,
            storage_sublocation: r.storage_sublocation || null,
            stock_qty: r.stock_qty,
            cost_price: r.cost_price,
            price: r.price,
            is_sellable_pos: r.is_sellable_pos,
            track_stock: r.track_stock,
            notes: r.notes || null,
            variants: r.variants,
          })),
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error((json as any)?.message || 'Gagal mengimpor data produk dari Excel');
      }
      const data = (json as any)?.data || {};
      const created = Number(data.created_count || 0);
      const updated = Number(data.updated_count || 0);
      const skipped = Number(data.skipped_count || 0);
      const stockLocationsBound = Number(data.stock_locations_bound_count || 0);
      const stockMovements = Number(data.stock_movements_count || 0);
      const failed = Number(data.failed_count || 0);
      const rowErrors: Array<{ row_index?: number; name?: string; message?: string }> = Array.isArray(data.errors)
        ? data.errors
        : [];
      if (created === 0 && updated === 0 && failed > 0) {
        const firstErr = rowErrors[0];
        const errDetail = firstErr
          ? `Baris ${firstErr.row_index ?? '-'} (${firstErr.name || '-'}): ${firstErr.message || 'Gagal disimpan'}`
          : 'Semua baris gagal diproses.';
        setExcelImportError(`Gagal mengimpor ${failed} baris produk. Detail: ${errDetail}`);
        return;
      }
      setShowExcelImportModal(false);
      setExcelImportRows([]);
      setExcelImportFileName('');
      setSuccessMsg(
        `Import Excel selesai: ${created} produk baru ditambahkan, ${updated} produk diperbarui${
          stockLocationsBound > 0 ? `, ${stockLocationsBound} produk masuk ke lokasi Stok & Mutasi` : ''
        }${stockMovements > 0 ? ` (${stockMovements} mutasi stok dicatat)` : ''}${
          skipped > 0 ? `, ${skipped} baris dilewati` : ''
        }${
          failed > 0
            ? ` (${failed} gagal${rowErrors[0]?.message ? `: ${rowErrors[0].message}` : ''})`
            : ''
        }.`
      );
      const { propertyId: curPid, statusFilter: curSf } = ctxRef.current;
      await loadProducts(curSf, curPid ?? targetPropertyId);
      onRefresh?.();
    } catch (err: any) {
      setExcelImportError(err?.message || 'Gagal memproses import Excel');
    } finally {
      setExcelImportLoading(false);
    }
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
    if (isRoomMinibar && roomIdVal != null) {
      const selectedCandidate = roomCandidates.find((r) => Number(r.room_id) === roomIdVal);
      const existingLocId =
        selectedCandidate?.existing_stock_location_id ?? selectedCandidate?.existing_location_id ?? null;
      const existingLocCode =
        selectedCandidate?.existing_stock_location_code ?? selectedCandidate?.existing_location_code ?? null;
      const isSameEditedLocation =
        stockLocationForm.mode === 'edit' &&
        stockLocationForm.id != null &&
        existingLocId != null &&
        Number(existingLocId) === Number(stockLocationForm.id);
      if (
        !isSameEditedLocation &&
        (existingLocId != null ||
          Boolean(existingLocCode) ||
          selectedCandidate?.is_available_for_minibar === false)
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
      const payload = {
        property_id: targetPropertyId,
        code: codeClean,
        name: nameClean,
        location_type: stockLocationForm.locationType,
        room_id: isRoomMinibar ? roomIdVal : null,
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
      case 'OPERATIONAL_ITEM':
        return 'bg-purple-50 text-purple-800 border-purple-200';
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
              Manajemen Persediaan
            </span>
            <span className="text-xs text-gray-400">•</span>
            <span className="text-xs text-gray-500">Property #{propertyId || 1}</span>
          </div>
          <h1 className="text-2xl font-black text-gray-900 tracking-tight">Master Barang &amp; Produk</h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">
            Katalog barang operasional hotel, bahan baku, dan produk/menu POS beserta satuan dasar serta pengaturan visibilitas katalog POS.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
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
          <button
            type="button"
            onClick={() =>
              exportProductsToXlsx(
                filteredItems,
                productTypeFilter !== 'ALL' ? productTypeFilter : undefined
              )
            }
            className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl border border-emerald-200 bg-white hover:bg-emerald-50 text-emerald-800 text-xs sm:text-sm font-semibold shadow-xs transition-colors cursor-pointer"
            title="Export daftar produk saat ini ke file Excel (.xlsx)"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Export Excel (.xlsx)
          </button>
          {(capabilities.canCreate || capabilities.canEdit) && (
            <button
              type="button"
              onClick={openExcelImportModal}
              className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-900 text-xs sm:text-sm font-bold shadow-xs transition-colors cursor-pointer"
              title="Import banyak produk sekaligus dari 4 template Excel (.xlsx)"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              Import Excel (.xlsx)
            </button>
          )}
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
              {capabilities.canCreate || capabilities.canEdit ? 'Kelola Penyimpanan' : 'Lihat Penyimpanan'}
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
            {statusFilter === 'all' ? 'Total Produk' : `Produk (${statusFilter === 'active' ? 'Aktif' : 'Nonaktif'})`}
          </div>
          <div className="text-2xl font-black text-gray-900 mt-1">{stats.total}</div>
          <div className="text-[11px] text-gray-400 mt-0.5">
            {statusFilter === 'all'
              ? `Jadi: ${stats.finishedCount} • Setengah Jadi: ${stats.semiCount} • Bahan Baku: ${stats.rawCount}`
              : `Mengikuti filter status ${statusFilter === 'active' ? 'Aktif' : 'Nonaktif'} yang dimuat saat ini`}
          </div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-gray-500 font-medium">Aktif</div>
          <div className="text-2xl font-black text-emerald-700 mt-1">{stats.activeCount}</div>
          <div className="text-[11px] text-gray-400 mt-0.5">
            Produk yang sedang aktif
          </div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-gray-500 font-medium">Dijual di POS</div>
          <div className="text-2xl font-black text-emerald-700 mt-1">{stats.sellableCount}</div>
          <div className="text-[11px] text-gray-400 mt-0.5">
            Tampil di katalog kasir POS
          </div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-gray-500 font-medium">Lacak Persediaan</div>
          <div className="text-2xl font-black text-teal-700 mt-1">{stats.stockTrackedCount}</div>
          <div className="text-[11px] text-gray-400 mt-0.5">
            {`Produk terlacak pada filter ${statusFilter === 'all' ? 'semua status' : statusFilter === 'active' ? 'Aktif' : 'Nonaktif'} saat ini`}
          </div>
        </div>
      </div>

      {/* Product Type Classification Tabs & Search/Filter Toolbar */}
      <div className="bg-white border border-gray-200/90 rounded-2xl p-4 shadow-xs flex flex-col gap-3.5">
        {/* Baris 1: Tab Tipe Produk: Produk Jadi, Setengah Jadi, Bahan Baku, Item Operasional */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 border-b border-gray-100">
          {PRODUCT_TYPE_TABS.map((tab) => {
            const active = productTypeFilter === tab.key;
            const count = productTypeCounts[tab.key];
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => {
                  setProductTypeFilter(tab.key);
                  setSelectedCategory('ALL');
                }}
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

        {/* Baris 2: Pencarian + Filter Kategori + Urutkan */}
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

          <div className="relative flex items-center gap-2 w-full sm:w-auto">
            <button
              type="button"
              ref={categoryDropdownRef}
              onClick={(e) => {
                if (categoryDropdownOpen) {
                  setCategoryDropdownOpen(false);
                  setCategoryMenuPosition(null);
                  return;
                }
                const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                const PANEL_W = 248;
                const left = Math.max(4, Math.min(rect.left, window.innerWidth - PANEL_W - 4));
                setCategoryMenuPosition({
                  top: rect.bottom + 4,
                  right: window.innerWidth - (left + PANEL_W),
                });
                setCategoryDropdownOpen(true);
              }}
              aria-haspopup="listbox"
              aria-expanded={categoryDropdownOpen}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer border flex items-center gap-1.5 ${
                selectedCategory !== 'ALL'
                  ? 'bg-emerald-800 text-white border-emerald-700'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 border-gray-200'
              }`}
            >
              <span>{selectedCategory === 'ALL' ? 'Tambah Kategori' : `Kategori: ${selectedCategory}`}</span>
              <svg className={`w-3 h-3 transition-transform ${categoryDropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 9l-7 7-7-7"/></svg>
            </button>
            {categoryDropdownOpen && categoryMenuPosition && (() => {
              const panelStyle: React.CSSProperties = {
                position: 'fixed',
                top: Math.max(4, categoryMenuPosition.top),
                right: categoryMenuPosition.right,
                width: 248,
                zIndex: 9999,
              };
              const filteredTabCategories = activeTabCategories.filter((c) =>
                c.name.toLowerCase().includes(categorySearchQuery.toLowerCase())
              );
              return createPortal(
                <div ref={categoryPanelRef} style={panelStyle} className="bg-white border border-gray-200 rounded-xl shadow-lg max-h-72 flex flex-col overflow-hidden">
                  <div className="p-2 border-b border-gray-100">
                    <input
                      type="text"
                      placeholder="Cari / ketik kategori baru…"
                      value={categorySearchQuery}
                      onChange={(e) => setCategorySearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void handleQuickAddCategoryFromDropdown();
                        }
                      }}
                      autoFocus
                      className="w-full px-2.5 py-1.5 text-xs bg-gray-50 border border-gray-200 rounded-lg focus:ring-1 focus:ring-emerald-500 focus:outline-hidden"
                    />
                  </div>
                  <div className="flex-1 overflow-y-auto p-1 space-y-0.5">
                    {selectedCategory !== 'ALL' && (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedCategory('ALL');
                          setCategoryDropdownOpen(false);
                          setCategoryMenuPosition(null);
                          setCategorySearchQuery('');
                        }}
                        className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-semibold text-emerald-700 hover:bg-emerald-50 transition-colors cursor-pointer"
                      >
                        Tampilkan Semua ({formatProductTypeLabel(productTypeFilter !== 'ALL' ? productTypeFilter : 'FINISHED_GOOD')})
                      </button>
                    )}
                    {filteredTabCategories.length === 0 ? (
                      <div className="px-2.5 py-2 text-[11px] text-gray-400">
                        {categorySearchQuery.trim()
                          ? `Klik "+ Tambah Kategori" untuk membuat "${categorySearchQuery.trim()}"`
                          : `Belum ada kategori untuk ${formatProductTypeLabel(productTypeFilter !== 'ALL' ? productTypeFilter : 'FINISHED_GOOD')}`}
                      </div>
                    ) : (
                      filteredTabCategories.map((cat) => (
                        <div
                          key={cat.id}
                          className={`group flex items-center justify-between rounded-lg px-2 py-1 text-xs font-medium transition-colors ${
                            selectedCategory === cat.name ? 'bg-emerald-50 text-emerald-800' : 'text-gray-700 hover:bg-gray-50'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedCategory(selectedCategory === cat.name ? 'ALL' : cat.name);
                              setCategoryDropdownOpen(false);
                              setCategoryMenuPosition(null);
                              setCategorySearchQuery('');
                            }}
                            className="flex-1 text-left py-0.5 pr-2 truncate cursor-pointer flex items-center gap-1.5"
                          >
                            <span className="truncate">{cat.name}</span>
                            {selectedCategory === cat.name && (
                              <svg className="w-3.5 h-3.5 text-emerald-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7"/></svg>
                            )}
                          </button>
                          {capabilities.canDeleteCategory && (
                            <button
                              type="button"
                              title={`Hapus kategori ${cat.name}`}
                              aria-label={`Hapus kategori ${cat.name}`}
                              disabled={saving}
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleDeleteCategory(cat);
                              }}
                              className="w-5 h-5 rounded-md flex items-center justify-center text-gray-400 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer shrink-0 disabled:opacity-40"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                  {capabilities.canManageCategory && (
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void handleQuickAddCategoryFromDropdown()}
                      className="px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 border-t border-gray-100 cursor-pointer text-left flex items-center justify-between disabled:opacity-50"
                    >
                      <span className="truncate">
                        {categorySearchQuery.trim()
                          ? `+ Tambah Kategori "${categorySearchQuery.trim()}"`
                          : '+ Tambah Kategori'}
                      </span>
                    </button>
                  )}
                </div>,
                document.body
              );
            })()}
          </div>

        </div>

        {/* MPUI-F03: kontrol urutan nama */}
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <label className="text-xs text-gray-400 font-medium shrink-0" htmlFor="product-sort-select">Urutkan:</label>
          <select
            id="product-sort-select"
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as 'default' | 'name_asc' | 'name_desc')}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-gray-100 text-gray-700 border border-gray-200 cursor-pointer focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
          >
            <option value="default">Default (ID)</option>
            <option value="name_asc">Nama A–Z</option>
            <option value="name_desc">Nama Z–A</option>
          </select>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400 font-medium shrink-0">Status:</span>
            {(['active', 'inactive'] as const).map((s) => (
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
                {s === 'active' ? 'Aktif' : 'Nonaktif'}
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

          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400 font-medium shrink-0">Persediaan:</span>
            {([
              { key: 'all', label: 'Semua' },
              { key: 'tracked', label: 'Lacak Persediaan' },
              { key: 'untracked', label: 'Tidak Dilacak' },
            ] as const).map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setStockFilter(opt.key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                  stockFilter === opt.key
                    ? 'bg-teal-700 text-white'
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
                  <th className="py-3 px-4">Produk</th>
                  <th className="py-3 px-4">Tipe</th>
                  <th className="py-3 px-4">Kategori</th>
                  <th className="py-3 px-4">Satuan</th>
                  <th className="py-3 px-4 text-right">Harga Jual</th>
                  <th className="py-3 px-4 text-center">Status</th>
                  <th className="py-3 px-4 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-gray-400">
                      Tidak ada produk yang cocok dengan filter pencarian.
                    </td>
                  </tr>
                ) : (
                  filteredItems.map((item) => {
                    const isSellable = item.is_sellable_pos !== false;
                    const priceDisplay = formatSellingPriceDisplay(item.price, isSellable);
                    const typeLabel = item.product_type_label || formatProductTypeLabel(item.product_type);
                    const unitLabel = formatBaseUnitLabel(item.base_unit);
                    const isStockTracked = isStockTrackedCanonical(item);
                    const isActive = item.is_active !== false;
                    return (
                      <tr key={item.id} className="hover:bg-gray-50/60 transition-colors">
                        {/* Kolom Produk: foto + nama + ikon POS/stok + SKU */}
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-3 min-w-0">
                            {item.has_photo && item.photo_url && photoBlobUrls[item.photo_url] ? (
                              <img
                                src={photoBlobUrls[item.photo_url]}
                                alt={item.name}
                                className="w-10 h-10 rounded-lg object-cover border border-gray-200 shrink-0 bg-gray-100"
                              />
                            ) : (
                              <div
                                aria-hidden="true"
                                className="w-10 h-10 rounded-lg border border-dashed border-gray-200 bg-gray-50 flex items-center justify-center shrink-0"
                              >
                                <svg className="w-4 h-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-6l-1.586-1.586a2 2 0 00-2.828 0L4 16m16 0l-4.586-4.586a2 2 0 00-2.828 0L8 16" />
                                </svg>
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="font-semibold text-gray-900 text-xs sm:text-sm break-words" title={item.name}>
                                {item.name}
                              </div>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <span className="text-[11px] text-gray-400 font-mono whitespace-nowrap">{item.item_code || '—'}</span>
                                {isSellable && (
                                  <span title="Dijual di POS" className="inline-flex items-center justify-center w-4 h-4 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                                    <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
                                  </span>
                                )}
                                {isStockTracked && (
                                  <span title="Lacak Persediaan" className="inline-flex items-center justify-center w-4 h-4 rounded bg-teal-50 text-teal-700 border border-teal-200">
                                    <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg>
                                  </span>
                                )}
                                {item.storage_sublocation && (
                                  <span
                                    title={`Tempat penyimpanan: ${item.storage_sublocation}`}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 text-[10px] font-semibold"
                                  >
                                    <span>📍 {item.storage_sublocation}</span>
                                  </span>
                                )}
                              </div>
                              {Array.isArray(item.variants) && item.variants.length > 0 && (
                                <div className="flex flex-wrap items-center gap-1 mt-1">
                                  <span className="text-[10px] font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
                                    Varian ({item.variants.length}):
                                  </span>
                                  {item.variants.map((vr, vIdx) => (
                                    <span
                                      key={`${vr.name}-${vIdx}`}
                                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 border border-gray-200 text-[10px] font-medium"
                                    >
                                      <span>{vr.name}</span>
                                      <span className="text-emerald-700 font-bold">({formatIDR(Number(vr.price) || 0)})</span>
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                        {/* Kolom Tipe */}
                        <td className="py-3 px-4">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold border ${getProductTypeBadgeClass(item.product_type)}`}>
                            {typeLabel}
                          </span>
                        </td>
                        {/* Kolom Kategori */}
                        <td className="py-3 px-4">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${
                            item.category_name
                              ? 'bg-slate-100 text-slate-700 border-slate-200'
                              : 'bg-gray-50 text-gray-400 border-gray-200'
                          }`}>
                            {item.category_name || 'Tanpa Kategori'}
                          </span>
                        </td>
                        {/* Kolom Satuan */}
                        <td className="py-3 px-4 text-gray-700 text-xs">
                          <span className={item.base_unit ? 'font-medium text-gray-800' : 'text-gray-400 italic'}>
                            {unitLabel}
                          </span>
                          {/* MPUI-F02: kode canonical hanya ditampilkan bila benar berbeda dari label,
                              agar tidak muncul pengulangan "BOTOL BOTOL"; aturan/kode tetap ada di detail */}
                          {item.canonical_base_unit_code &&
                            item.canonical_base_unit_code.toUpperCase() !== String(unitLabel).trim().toUpperCase() && (
                              <span className="ml-1.5 inline-flex items-center px-1 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
                                {item.canonical_base_unit_code}
                              </span>
                            )}
                        </td>
                        {/* Kolom Harga Jual */}
                        <td className="py-3 px-4 text-right">
                          {priceDisplay.isUnset ? (
                            <span className="text-xs text-gray-400 italic">{priceDisplay.text}</span>
                          ) : (
                            <span className="font-bold text-gray-900">{priceDisplay.text}</span>
                          )}
                        </td>
                        {/* Kolom Status */}
                        <td className="py-3 px-4 text-center">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
                            isActive
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : 'bg-amber-50 text-amber-700 border-amber-200'
                          }`}>
                            {isActive ? 'Aktif' : 'Nonaktif'}
                          </span>
                        </td>
                        {/* Kolom Aksi: Edit + Hapus + menu ⋮ */}
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          {(capabilities.canEdit || capabilities.canToggleStatus) ? (
                            <div className="flex items-center justify-end gap-1.5">
                              {capabilities.canEdit && (
                                <button
                                  type="button"
                                  onClick={() => openEdit(item)}
                                  disabled={saving}
                                  title="Edit Produk"
                                  className="w-7 h-7 inline-flex items-center justify-center rounded-lg bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-800 transition-colors cursor-pointer disabled:opacity-50"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {(capabilities.canEdit || capabilities.canToggleStatus) && (
                                <button
                                  type="button"
                                  onClick={() => void handleDeleteProduct(item)}
                                  disabled={saving}
                                  title="Hapus Produk"
                                  className="w-7 h-7 inline-flex items-center justify-center rounded-lg bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-700 transition-colors cursor-pointer disabled:opacity-50"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {/* MPUI-F01: Portal-based three-dot menu — state-driven, not clipped by table overflow */}
                              <button
                                type="button"
                                ref={(el: HTMLElement | null) => {
                                  // Hanya simpan trigger baris yang sedang membuka menu, agar
                                  // ref aktif tidak tertimpa oleh baris lain saat di-render ulang.
                                  if (openMenuRowId === item.id) {
                                    menuButtonRef.current = el;
                                  }
                                }}
                                aria-label={`Opsi lain ${item.name}`}
                                aria-haspopup="menu"
                                aria-expanded={openMenuRowId === item.id}
                                disabled={saving}
                                onClick={(e) => toggleRowMenu(e, item)}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleRowMenu(e, item); }}
                                className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors cursor-pointer"
                              >
                                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M10 3a1 1 0 110 2 1 1 0 010-2zm0 5a1 1 0 110 2 1 1 0 010-2zm0 5a1 1 0 110 2 1 1 0 010-2z"/></svg>
                              </button>
                            </div>
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

                {/* 1. Tipe Produk (Paling Atas) */}
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
                  <div className="grid grid-cols-2 gap-2" role="group" aria-label="Pilihan tipe produk">
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

                {/* 2. Identitas & Foto Produk (Ringkas) */}
                <div className="space-y-3 pt-1 border-t border-gray-100">
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

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">
                        Kategori {newProduct.productType ? `(${formatProductTypeLabel(newProduct.productType)})` : ''}
                      </label>
                      <select
                        value={newProduct.category}
                        onChange={(e) => setNewProduct({ ...newProduct, category: e.target.value })}
                        className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2"
                      >
                        <option value="">— Tanpa Kategori —</option>
                        {getCategoriesForProductType(newProduct.productType, newProduct.category).map((c) => (
                          <option key={c.id} value={String(c.id)}>{c.name}</option>
                        ))}
                      </select>
                    </div>

                    {/* MPUI-F02: SKU manual bagian identitas */}
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
                  </div>

                  {/* Foto Produk (Ringkas 1 Baris di bawah Identitas) */}
                  <div className="p-2.5 rounded-xl bg-gray-50 border border-gray-200 flex flex-wrap items-center justify-between gap-2.5">
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      {addPhotoPreviewUrl ? (
                        <img
                          src={addPhotoPreviewUrl}
                          alt="Preview foto produk baru"
                          className="w-11 h-11 rounded-lg object-cover border border-gray-200 shrink-0"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-lg bg-white border border-gray-200 flex items-center justify-center text-gray-400 shrink-0">
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-gray-800 truncate">
                          {addPhotoPreviewUrl ? (addPhotoFile?.name || 'Foto dipilih') : 'Foto Produk (Opsional)'}
                        </div>
                        <div className={`text-[11px] truncate ${addPhotoPreviewUrl ? 'text-emerald-700' : 'text-gray-400'}`}>
                          {addPhotoPreviewUrl ? 'Akan diunggah saat Simpan Produk' : 'PNG, JPEG, WebP • Maks. 2 MB'}
                        </div>
                      </div>
                    </div>

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

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        disabled={saving}
                        aria-label="Pilih foto dari galeri"
                        onClick={() => addGalleryInputRef.current?.click()}
                        className="px-2.5 py-1.5 text-xs font-semibold text-gray-700 bg-white hover:bg-gray-100 rounded-lg border border-gray-300 cursor-pointer disabled:opacity-50"
                      >
                        {addPhotoFile ? 'Ganti Galeri' : 'Galeri'}
                      </button>
                      <button
                        type="button"
                        disabled={saving}
                        aria-label="Ambil foto dari kamera"
                        onClick={() => addCameraInputRef.current?.click()}
                        className="px-2.5 py-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 rounded-lg border border-emerald-200 cursor-pointer disabled:opacity-50"
                      >
                        Kamera
                      </button>
                      {addPhotoPreviewUrl && (
                        <button
                          type="button"
                          disabled={saving}
                          aria-label="Hapus foto produk"
                          onClick={clearAddPhoto}
                          className="px-2 py-1.5 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-lg border border-rose-200 cursor-pointer disabled:opacity-50"
                        >
                          Hapus
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* 3. Satuan & Harga */}
                <div className="space-y-3 pt-1 border-t border-gray-100">
                  <div className="space-y-1.5">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-semibold text-gray-700 mb-1">Satuan Dasar (Kanonik)</label>
                        <select
                          aria-label="Pilih satuan dasar kanonik"
                          value={newProduct.canonicalBaseUnitCode || ''}
                          onChange={(e) => setNewProduct(applyCanonicalUnitSelection(newProduct, e.target.value, canonicalUnitsCatalog))}
                          className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2"
                        >
                          <option value="">— Pilih Satuan Kanonik —</option>
                          {canonicalUnitsCatalog.map((unit) => (
                            <option key={unit.code} value={unit.code}>
                              {unit.code} — {unit.label_id} ({unit.allow_decimal ? 'Desimal' : 'Bulat'})
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-gray-700 mb-1">Label Satuan Dasar</label>
                        <input
                          type="text"
                          list="oak-product-base-units"
                          maxLength={50}
                          placeholder="Contoh: Porsi, Pcs, Kg, Liter"
                          value={newProduct.baseUnit}
                          onChange={(e) => setNewProduct(applyBaseUnitTextChange(newProduct, e.target.value, canonicalUnitsCatalog))}
                          className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2"
                        />
                      </div>
                    </div>
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

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">
                        Harga Jual (IDR) {newProduct.isSellablePos ? '*' : '(Opsional)'}
                      </label>
                      <input
                        type="number"
                        required={newProduct.isSellablePos}
                        min="0"
                        step="1"
                        placeholder={newProduct.isSellablePos ? 'Contoh: 45000 (0 bila Rp 0)' : 'Kosongkan bila non-POS'}
                        value={newProduct.price}
                        onChange={(e) => setNewProduct({ ...newProduct, price: e.target.value })}
                        className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 font-mono"
                      />
                      <div className="text-[10px] text-gray-400 mt-0.5">
                        {newProduct.isSellablePos
                          ? 'Rupiah utuh (>= 0). Isi 0 bila Rp 0.'
                          : 'Boleh dikosongkan untuk produk non-POS.'}
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

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">
                        Lokasi Gudang / Outlet Default
                      </label>
                      <select
                        aria-label="Pilih lokasi gudang default produk"
                        value={newProduct.defaultLocationId || ''}
                        onChange={(e) => setNewProduct({ ...newProduct, defaultLocationId: e.target.value })}
                        className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                      >
                        <option value="">— Otomatis (Sesuai Resep / SKU / Tipe) —</option>
                        {stockLocations
                          .filter((loc) => loc.is_active && loc.location_type !== 'ROOM_MINIBAR')
                          .map((loc) => (
                            <option key={loc.id} value={String(loc.id)}>
                              {loc.code} — {loc.name} ({loc.location_type})
                            </option>
                          ))}
                      </select>
                      <div className="text-[10px] text-gray-400 mt-0.5">
                        Titik potong stok POS otomatis (cth: KCH Dapur, RCP Toko 1, CCR Coffee Corner).
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">
                        Tempat Penyimpanan (Sub-Lokasi)
                      </label>
                      <input
                        type="text"
                        list="oak-storage-sublocations"
                        maxLength={100}
                        placeholder="Contoh: Showcase, Chiller, Freezer, Rak Kering"
                        value={newProduct.storageSublocation || ''}
                        onChange={(e) => setNewProduct({ ...newProduct, storageSublocation: e.target.value })}
                        className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                      />
                      <div className="text-[10px] text-gray-400 mt-0.5">
                        Ditampilkan di samping Lokasi pada Saldo &amp; Valuasi serta Riwayat Mutasi.
                      </div>
                    </div>
                  </div>

                  {/* Varian Produk (Khusus Produk Jadi) */}
                  {newProduct.productType === 'FINISHED_GOOD' && (
                    <div className="p-3 rounded-xl bg-emerald-50/40 border border-emerald-200/80 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-xs font-bold text-emerald-950">Varian Produk Jadi (Opsional)</div>
                          <div className="text-[11px] text-emerald-800/80">
                            Contoh: Reguler, Jumbo, Panas (Hot), Dingin (Ice), Pedas, Original.
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setNewProduct((prev) => ({
                              ...prev,
                              variants: [
                                ...(prev.variants || []),
                                { name: '', price: prev.price || '0', costPrice: '', barcode: '' },
                              ],
                            }))
                          }
                          className="px-2.5 py-1 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold cursor-pointer"
                        >
                          + Tambah Varian
                        </button>
                      </div>
                      {Array.isArray(newProduct.variants) && newProduct.variants.length > 0 && (
                        <div className="space-y-2">
                          {newProduct.variants.map((vr, idx) => (
                            <div key={idx} className="grid grid-cols-12 gap-2 items-center bg-white p-2 rounded-lg border border-emerald-200/70">
                              <div className="col-span-5">
                                <input
                                  type="text"
                                  placeholder={`Nama Varian #${idx + 1} (cth: Jumbo)`}
                                  value={vr.name}
                                  onChange={(e) => {
                                    const next = [...(newProduct.variants || [])];
                                    next[idx] = { ...next[idx], name: e.target.value };
                                    setNewProduct({ ...newProduct, variants: next });
                                  }}
                                  className="w-full text-xs bg-gray-50 border border-gray-300 rounded-md px-2 py-1.5"
                                />
                              </div>
                              <div className="col-span-3">
                                <input
                                  type="number"
                                  min="0"
                                  placeholder="Harga Jual"
                                  value={vr.price}
                                  onChange={(e) => {
                                    const next = [...(newProduct.variants || [])];
                                    next[idx] = { ...next[idx], price: e.target.value };
                                    setNewProduct({ ...newProduct, variants: next });
                                  }}
                                  className="w-full text-xs bg-gray-50 border border-gray-300 rounded-md px-2 py-1.5 font-mono"
                                />
                              </div>
                              <div className="col-span-3">
                                <input
                                  type="number"
                                  min="0"
                                  placeholder="HPP (Opsional)"
                                  value={vr.costPrice}
                                  onChange={(e) => {
                                    const next = [...(newProduct.variants || [])];
                                    next[idx] = { ...next[idx], costPrice: e.target.value };
                                    setNewProduct({ ...newProduct, variants: next });
                                  }}
                                  className="w-full text-xs bg-gray-50 border border-gray-300 rounded-md px-2 py-1.5 font-mono"
                                />
                              </div>
                              <div className="col-span-1 text-right">
                                <button
                                  type="button"
                                  onClick={() => {
                                    const next = (newProduct.variants || []).filter((_, i) => i !== idx);
                                    setNewProduct({ ...newProduct, variants: next });
                                  }}
                                  className="text-rose-600 hover:text-rose-800 text-xs font-bold px-1 cursor-pointer"
                                  title="Hapus varian"
                                >
                                  ✕
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* 4. Detail Opsional (Barcode & Deskripsi — Lipat/Collapsible) */}
                <div className="border border-gray-200 rounded-xl overflow-hidden bg-gray-50/40">
                  <button
                    type="button"
                    aria-expanded={showAddOptional}
                    onClick={() => setShowAddOptional((prev) => !prev)}
                    className="w-full flex items-center justify-between px-3.5 py-2.5 text-left text-xs font-semibold text-gray-700 hover:bg-gray-100/80 transition-colors cursor-pointer"
                  >
                    <span className="flex items-center gap-2">
                      <span>Detail Opsional (Barcode &amp; Deskripsi)</span>
                      {(newProduct.barcode.trim() !== '' || newProduct.description.trim() !== '') && (
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

                {/* 5. Pengaturan POS & Gudang (Paling Bawah — Berdampingan Ringkas) */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1 border-t border-gray-100">
                  <div className="p-3 rounded-xl bg-gray-50 border border-gray-200 flex items-start">
                    <label className="flex items-start gap-2.5 cursor-pointer w-full">
                      <input
                        type="checkbox"
                        checked={newProduct.isSellablePos}
                        onChange={(e) => setNewProduct({ ...newProduct, isSellablePos: e.target.checked })}
                        className="mt-0.5 h-4 w-4 rounded border-gray-300 text-emerald-700 focus:ring-emerald-600 shrink-0"
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-gray-900">Dijual di POS (Kasir)</div>
                        <div className="text-[11px] text-gray-500 mt-0.5">
                          Tampilkan di menu kasir POS. Matikan untuk bahan baku / non-POS.
                        </div>
                      </div>
                    </label>
                  </div>

                  <div className="p-3 rounded-xl bg-teal-50/50 border border-teal-200/80 flex items-start">
                    <label className="flex items-start gap-2.5 cursor-pointer w-full">
                      <input
                        type="checkbox"
                        data-testid="add-product-track-stock-checkbox"
                        aria-label="Lacak Stok & Penerimaan Gudang (GRN)"
                        checked={Boolean(newProduct.trackStock)}
                        onChange={(e) => setNewProduct({ ...newProduct, trackStock: e.target.checked })}
                        className="mt-0.5 h-4 w-4 rounded border-gray-300 text-emerald-700 focus:ring-emerald-600 shrink-0"
                      />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="text-xs font-bold text-gray-900">
                            Lacak Stok &amp; GRN
                          </span>
                          <span
                            className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold border ${
                              newProduct.trackStock
                                ? 'bg-emerald-100 text-emerald-900 border-emerald-300'
                                : 'bg-gray-100 text-gray-600 border-gray-200'
                            }`}
                          >
                            {newProduct.trackStock ? 'Stok Fisik' : 'Non-Stok'}
                          </span>
                        </div>
                        <div className="text-[11px] text-gray-600 mt-0.5">
                          Aktifkan untuk barang fisik gudang (PO &amp; GRN). Nonaktif untuk menu resep/BOM.
                        </div>
                      </div>
                    </label>
                  </div>
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

                {/* 1. Tipe Produk (Paling Atas) */}
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
                  <div className="grid grid-cols-2 gap-2" role="group" aria-label="Pilihan tipe produk">
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

                {/* 2. Identitas & Foto Produk (Ringkas) */}
                <div className="space-y-3 pt-1 border-t border-gray-100">
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

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">
                        Kategori {editProduct.productType ? `(${formatProductTypeLabel(editProduct.productType)})` : ''}
                      </label>
                      <select
                        value={editProduct.category}
                        onChange={(e) => setEditProduct({ ...editProduct, category: e.target.value })}
                        className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2"
                      >
                        <option value="">— Tanpa Kategori —</option>
                        {getCategoriesForProductType(editProduct.productType, editProduct.category).map((c) => (
                          <option key={c.id} value={String(c.id)}>{c.name}</option>
                        ))}
                      </select>
                    </div>

                    {/* MPUI-F02: SKU bagian identitas */}
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">Kode / SKU (Opsional)</label>
                      <input
                        type="text"
                        value={editProduct.code}
                        onChange={(e) => setEditProduct({ ...editProduct, code: e.target.value.toUpperCase() })}
                        className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 font-mono"
                      />
                    </div>
                  </div>

                  {/* Foto Produk (Ringkas di bawah Identitas) */}
                  <div className="p-2.5 rounded-xl bg-gray-50 border border-gray-200 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2.5">
                      <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        {editPhotoPreviewUrl ? (
                          <img
                            src={editPhotoPreviewUrl}
                            alt="Preview foto produk pengganti"
                            className="w-11 h-11 rounded-lg object-cover border border-gray-200 shrink-0"
                          />
                        ) : !editRemovePhoto && editingItem.has_photo ? (
                          editingItem.photo_url && photoBlobUrls[editingItem.photo_url] ? (
                            <img
                              src={photoBlobUrls[editingItem.photo_url]}
                              alt={editingItem.name}
                              className="w-11 h-11 rounded-lg object-cover border border-gray-200 shrink-0"
                            />
                          ) : (
                            <div className="w-11 h-11 rounded-lg border border-gray-200 bg-gray-100 flex items-center justify-center text-[10px] text-gray-500 shrink-0">
                              Foto
                            </div>
                          )
                        ) : (
                          <div className="w-10 h-10 rounded-lg bg-white border border-gray-200 flex items-center justify-center text-gray-400 shrink-0">
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                            </svg>
                          </div>
                        )}
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-gray-800 truncate">
                            {editPhotoPreviewUrl
                              ? (editPhotoFile?.name || 'Foto baru dipilih')
                              : editRemovePhoto
                                ? 'Foto ditandai untuk dihapus'
                                : editingItem.has_photo
                                  ? 'Foto produk tersimpan'
                                  : 'Foto Produk (Opsional)'}
                          </div>
                          <div className={`text-[11px] truncate ${editPhotoPreviewUrl ? 'text-emerald-700' : editRemovePhoto ? 'text-amber-800' : 'text-gray-400'}`}>
                            {editPhotoPreviewUrl
                              ? 'Diterapkan saat Simpan Perubahan'
                              : editRemovePhoto
                                ? 'Klik Urungkan bila batal menghapus'
                                : 'PNG, JPEG, WebP • Maks. 2 MB'}
                          </div>
                        </div>
                      </div>

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

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          disabled={saving}
                          aria-label="Pilih foto dari galeri"
                          onClick={() => editGalleryInputRef.current?.click()}
                          className="px-2.5 py-1.5 text-xs font-semibold text-gray-700 bg-white hover:bg-gray-100 rounded-lg border border-gray-300 cursor-pointer disabled:opacity-50"
                        >
                          {editPhotoFile || (!editRemovePhoto && editingItem.has_photo) ? 'Ganti Galeri' : 'Galeri'}
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          aria-label="Ambil foto dari kamera"
                          onClick={() => editCameraInputRef.current?.click()}
                          className="px-2.5 py-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 rounded-lg border border-emerald-200 cursor-pointer disabled:opacity-50"
                        >
                          Kamera
                        </button>
                        {(editPhotoPreviewUrl || (!editRemovePhoto && editingItem.has_photo)) && (
                          <button
                            type="button"
                            disabled={saving}
                            aria-label="Hapus foto produk"
                            onClick={handleEditRemovePhotoClick}
                            className="px-2 py-1.5 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-lg border border-rose-200 cursor-pointer disabled:opacity-50"
                          >
                            Hapus
                          </button>
                        )}
                        {editRemovePhoto && (
                          <button
                            type="button"
                            disabled={saving}
                            aria-label="Urungkan hapus foto"
                            onClick={handleUndoEditRemovePhoto}
                            className="px-2 py-1.5 text-xs font-semibold text-amber-900 bg-amber-50 hover:bg-amber-100 rounded-lg border border-amber-300 cursor-pointer disabled:opacity-50"
                          >
                            Urungkan
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* 3. Satuan & Harga */}
                <div className="space-y-3 pt-1 border-t border-gray-100">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="block text-xs font-semibold text-gray-700">Satuan Dasar</label>
                      <div className="flex items-center gap-2">
                        {(editProduct.productType === 'FINISHED_GOOD' || editProduct.productType === 'SEMI_FINISHED') && (
                          <button
                            type="button"
                            disabled={saving}
                            aria-label="Buka formula resep BOM produk"
                            onClick={() => openRecipeModal(editingItem)}
                            className="text-xs font-semibold text-amber-800 hover:text-amber-950 bg-amber-50 hover:bg-amber-100 border border-amber-200 px-2.5 py-1 rounded-lg cursor-pointer disabled:opacity-50"
                          >
                            Resep (BOM)
                          </button>
                        )}
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
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <select
                        aria-label="Pilih satuan dasar kanonik"
                        disabled={saving || Boolean(editingItem.is_base_unit_locked)}
                        value={editProduct.canonicalBaseUnitCode || ''}
                        onChange={(e) => setEditProduct(applyCanonicalUnitSelection(editProduct, e.target.value, canonicalUnitsCatalog))}
                        className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        <option value="">— Pilih Satuan Kanonik —</option>
                        {canonicalUnitsCatalog.map((unit) => (
                          <option key={unit.code} value={unit.code}>
                            {unit.code} — {unit.label_id} ({unit.allow_decimal ? 'Desimal' : 'Bulat'})
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        list="oak-product-base-units"
                        maxLength={50}
                        disabled={saving || Boolean(editingItem.is_base_unit_locked)}
                        placeholder="Label satuan (contoh: Porsi, Pcs, Kg)"
                        value={editProduct.baseUnit}
                        onChange={(e) => setEditProduct(applyBaseUnitTextChange(editProduct, e.target.value, canonicalUnitsCatalog))}
                        className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 disabled:opacity-60 disabled:cursor-not-allowed"
                      />
                    </div>

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

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">
                        Harga Jual (IDR) {editProduct.isSellablePos ? '' : '(Opsional)'}
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        placeholder={editProduct.isSellablePos ? 'Rupiah utuh >= 0' : 'Kosong = Belum diatur'}
                        value={editProduct.price}
                        onChange={(e) => setEditProduct({ ...editProduct, price: e.target.value })}
                        className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 font-mono"
                      />
                      <div className="text-[10px] text-gray-400 mt-0.5">
                        {editProduct.isSellablePos
                          ? 'Kosong = tetap; 0 = Rp 0.'
                          : 'Kosong = tanpa harga jual POS.'}
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

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">
                        Lokasi Gudang / Outlet Default
                      </label>
                      <select
                        aria-label="Pilih lokasi gudang default edit produk"
                        value={editProduct.defaultLocationId || ''}
                        onChange={(e) => setEditProduct({ ...editProduct, defaultLocationId: e.target.value })}
                        className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                      >
                        <option value="">— Otomatis (Sesuai Resep / SKU / Tipe) —</option>
                        {stockLocations
                          .filter((loc) => loc.is_active && loc.location_type !== 'ROOM_MINIBAR')
                          .map((loc) => (
                            <option key={loc.id} value={String(loc.id)}>
                              {loc.code} — {loc.name} ({loc.location_type})
                            </option>
                          ))}
                      </select>
                      <div className="text-[10px] text-gray-400 mt-0.5">
                        Titik potong stok POS otomatis (cth: KCH Dapur, RCP Toko 1, CCR Coffee Corner).
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">
                        Tempat Penyimpanan (Sub-Lokasi)
                      </label>
                      <input
                        type="text"
                        list="oak-storage-sublocations"
                        maxLength={100}
                        placeholder="Contoh: Showcase, Chiller, Freezer, Rak Kering"
                        value={editProduct.storageSublocation || ''}
                        onChange={(e) => setEditProduct({ ...editProduct, storageSublocation: e.target.value })}
                        className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                      />
                      <div className="text-[10px] text-gray-400 mt-0.5">
                        Ditampilkan di samping Lokasi pada Saldo &amp; Valuasi serta Riwayat Mutasi.
                      </div>
                    </div>
                  </div>

                  {/* Varian Produk (Khusus Produk Jadi) */}
                  {editProduct.productType === 'FINISHED_GOOD' && (
                    <div className="p-3 rounded-xl bg-emerald-50/40 border border-emerald-200/80 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-xs font-bold text-emerald-950">Varian Produk Jadi (Opsional)</div>
                          <div className="text-[11px] text-emerald-800/80">
                            Contoh: Reguler, Jumbo, Panas (Hot), Dingin (Ice), Pedas, Original.
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setEditProduct((prev) => ({
                              ...prev,
                              variants: [
                                ...(prev.variants || []),
                                { name: '', price: prev.price || '0', costPrice: '', barcode: '' },
                              ],
                            }))
                          }
                          className="px-2.5 py-1 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold cursor-pointer"
                        >
                          + Tambah Varian
                        </button>
                      </div>
                      {Array.isArray(editProduct.variants) && editProduct.variants.length > 0 && (
                        <div className="space-y-2">
                          {editProduct.variants.map((vr, idx) => (
                            <div key={idx} className="grid grid-cols-12 gap-2 items-center bg-white p-2 rounded-lg border border-emerald-200/70">
                              <div className="col-span-5">
                                <input
                                  type="text"
                                  placeholder={`Nama Varian #${idx + 1} (cth: Jumbo)`}
                                  value={vr.name}
                                  onChange={(e) => {
                                    const next = [...(editProduct.variants || [])];
                                    next[idx] = { ...next[idx], name: e.target.value };
                                    setEditProduct({ ...editProduct, variants: next });
                                  }}
                                  className="w-full text-xs bg-gray-50 border border-gray-300 rounded-md px-2 py-1.5"
                                />
                              </div>
                              <div className="col-span-3">
                                <input
                                  type="number"
                                  min="0"
                                  placeholder="Harga Jual"
                                  value={vr.price}
                                  onChange={(e) => {
                                    const next = [...(editProduct.variants || [])];
                                    next[idx] = { ...next[idx], price: e.target.value };
                                    setEditProduct({ ...editProduct, variants: next });
                                  }}
                                  className="w-full text-xs bg-gray-50 border border-gray-300 rounded-md px-2 py-1.5 font-mono"
                                />
                              </div>
                              <div className="col-span-3">
                                <input
                                  type="number"
                                  min="0"
                                  placeholder="HPP (Opsional)"
                                  value={vr.costPrice}
                                  onChange={(e) => {
                                    const next = [...(editProduct.variants || [])];
                                    next[idx] = { ...next[idx], costPrice: e.target.value };
                                    setEditProduct({ ...editProduct, variants: next });
                                  }}
                                  className="w-full text-xs bg-gray-50 border border-gray-300 rounded-md px-2 py-1.5 font-mono"
                                />
                              </div>
                              <div className="col-span-1 text-right">
                                <button
                                  type="button"
                                  onClick={() => {
                                    const next = (editProduct.variants || []).filter((_, i) => i !== idx);
                                    setEditProduct({ ...editProduct, variants: next });
                                  }}
                                  className="text-rose-600 hover:text-rose-800 text-xs font-bold px-1 cursor-pointer"
                                  title="Hapus varian"
                                >
                                  ✕
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* 4. Detail Opsional (Barcode & Deskripsi — Lipat/Collapsible) */}
                <div className="border border-gray-200 rounded-xl overflow-hidden bg-gray-50/40">
                  <button
                    type="button"
                    aria-expanded={showEditOptional}
                    onClick={() => setShowEditOptional((prev) => !prev)}
                    className="w-full flex items-center justify-between px-3.5 py-2.5 text-left text-xs font-semibold text-gray-700 hover:bg-gray-100/80 transition-colors cursor-pointer"
                  >
                    <span className="flex items-center gap-2">
                      <span>Detail Opsional (Barcode &amp; Deskripsi)</span>
                      {(editProduct.barcode.trim() !== '' || editProduct.description.trim() !== '') && (
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

                {/* 5. Pengaturan POS & Gudang (Paling Bawah — Berdampingan Ringkas) */}
                <div className="space-y-2.5 pt-1 border-t border-gray-100">
                  {Array.isArray(editingItem.packaging_conversions) &&
                    editingItem.packaging_conversions.some((p) => p.is_active) &&
                    !editProduct.trackStock && (
                      <div
                        data-testid="edit-product-untracked-packaging-warning"
                        className="p-2.5 rounded-lg bg-amber-50 border border-amber-300 text-amber-900 text-[11px] space-y-1"
                      >
                        <div className="font-bold">
                          ⚠ Produk ini sudah memiliki konversi kemasan pembelian, tetapi Pelacakan Stok &amp; GRN masih nonaktif.
                        </div>
                        <div>
                          Centang <strong>Lacak Stok &amp; GRN</strong> di bawah lalu klik <strong>Simpan Perubahan</strong>.
                        </div>
                      </div>
                    )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div className="p-3 rounded-xl bg-gray-50 border border-gray-200 flex items-start">
                      <label className="flex items-start gap-2.5 cursor-pointer w-full">
                        <input
                          type="checkbox"
                          checked={editProduct.isSellablePos}
                          onChange={(e) => setEditProduct({ ...editProduct, isSellablePos: e.target.checked })}
                          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-emerald-700 focus:ring-emerald-600 shrink-0"
                        />
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-gray-900">Dijual di POS (Kasir)</div>
                          <div className="text-[11px] text-gray-500 mt-0.5">
                            Tampilkan di menu kasir POS. Matikan untuk bahan baku / non-POS.
                          </div>
                        </div>
                      </label>
                    </div>

                    <div className="p-3 rounded-xl bg-teal-50/50 border border-teal-200/80 flex items-start">
                      <label className="flex items-start gap-2.5 cursor-pointer w-full">
                        <input
                          type="checkbox"
                          data-testid="edit-product-track-stock-checkbox"
                          aria-label="Lacak Stok & Penerimaan Gudang (GRN)"
                          checked={Boolean(editProduct.trackStock)}
                          onChange={(e) => setEditProduct({ ...editProduct, trackStock: e.target.checked })}
                          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-emerald-700 focus:ring-emerald-600 shrink-0"
                        />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1">
                            <span className="text-xs font-bold text-gray-900">
                              Lacak Stok &amp; GRN
                            </span>
                            <span
                              className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold border ${
                                editProduct.trackStock
                                  ? 'bg-emerald-100 text-emerald-900 border-emerald-300'
                                  : 'bg-gray-100 text-gray-600 border-gray-200'
                              }`}
                            >
                              {editProduct.trackStock ? 'Stok Fisik' : 'Non-Stok'}
                            </span>
                          </div>
                          <div className="text-[11px] text-gray-600 mt-0.5">
                            Aktifkan untuk barang fisik gudang (PO &amp; GRN). Nonaktif untuk menu resep/BOM.
                          </div>
                        </div>
                      </label>
                    </div>
                  </div>
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
                <label className="block text-xs font-semibold text-gray-700 mb-1">Kelompok Tipe Produk</label>
                <select
                  value={categoryForm.productType}
                  onChange={(e) => setCategoryForm({ ...categoryForm, productType: e.target.value })}
                  className="w-full text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2"
                >
                  <option value="FINISHED_GOOD">Produk Jadi (cth: Makanan, Minuman)</option>
                  <option value="SEMI_FINISHED">Produk Setengah Jadi (cth: Bumbu Olahan, Saus)</option>
                  <option value="RAW_MATERIAL">Bahan Baku (cth: Vegetarian, Fish Meal, Daging)</option>
                  <option value="OPERATIONAL_ITEM">Item Operasional (cth: Linen, Handuk, Amenities)</option>
                  <option value="">Umum / Semua Tipe Produk</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Nama Kategori *</label>
                <input
                  type="text"
                  required
                  maxLength={100}
                  placeholder="Contoh: Vegetarian, Fish Meal, Makanan, Minuman"
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
                    <div key={cat.id} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-medium text-gray-800 truncate">{cat.name}</span>
                        <span
                          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border shrink-0 ${getProductTypeBadgeClass(
                            cat.product_type
                          )}`}
                        >
                          {cat.product_type ? formatProductTypeLabel(cat.product_type) : 'Semua Tipe'}
                        </span>
                      </div>
                      <div className="flex gap-1 shrink-0">
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
                        disabled={saving}
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
                          disabled={saving}
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
                            const isSelfEdited =
                              stockLocationForm.mode === 'edit' &&
                              stockLocationForm.id != null &&
                              existingId != null &&
                              Number(existingId) === Number(stockLocationForm.id);
                            const isTaken =
                              !isSelfEdited &&
                              (existingId != null ||
                                Boolean(existingCode) ||
                                room.is_available_for_minibar === false);
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
      {/* MP-04C Formula Resep / BOM Modal */}
      <ProductRecipeModal
        product={recipeModalItem}
        propertyId={propertyId}
        isOpen={Boolean(recipeModalItem)}
        onClose={closeRecipeModal}
        canEdit={capabilities.canEdit}
      />

      {/* Import Produk dari Excel (.xlsx) Modal — 4 Template */}
      {showExcelImportModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-3 sm:p-4"
          onClick={() => {
            if (!excelImportLoading) setShowExcelImportModal(false);
          }}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl max-w-xl w-full border border-gray-200 max-h-[92vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="shrink-0 px-6 pt-5 pb-4 border-b border-gray-100 flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-lg font-extrabold text-gray-900">Import Master Barang &amp; Produk dari Excel</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Tambahkan atau perbarui banyak barang sekaligus dari file spreadsheet (.xlsx).
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={excelImportLoading}
                onClick={() => setShowExcelImportModal(false)}
                className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 cursor-pointer"
                aria-label="Tutup modal import excel"
              >
                ✕
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {excelImportError && (
                <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center justify-between gap-2">
                  <span>⚠ {excelImportError}</span>
                  <button
                    type="button"
                    onClick={() => setExcelImportError(null)}
                    className="font-bold text-rose-700 hover:text-rose-900"
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* Section 1: Download 4 Template Excel */}
              <div className="p-4 rounded-2xl bg-emerald-50/60 border border-emerald-200/80 space-y-3">
                <div className="flex items-start gap-2.5">
                  <span className="w-6 h-6 rounded-full bg-emerald-700 text-white text-xs font-extrabold flex items-center justify-center shrink-0 mt-0.5">
                    1
                  </span>
                  <div>
                    <div className="text-sm font-bold text-gray-900">Download Template Excel (4 Jenis Produk)</div>
                    <div className="text-xs text-gray-600 mt-0.5">
                      Pilih template sesuai jenis barang/produk yang ingin diimport. Isi data di Excel, lalu upload kembali.
                    </div>
                  </div>
                </div>

                <div className="space-y-2 pt-1">
                  <button
                    type="button"
                    onClick={() => downloadProductTemplateXlsx('FINISHED_GOOD')}
                    className="w-full py-2.5 px-4 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs sm:text-sm shadow-xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
                  >
                    <span>📦</span>
                    <span>Template Produk Jadi (Fisik + Varian)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadProductTemplateXlsx('SEMI_FINISHED')}
                    className="w-full py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs sm:text-sm shadow-xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
                  >
                    <span>🍲</span>
                    <span>Template Produk Setengah Jadi</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadProductTemplateXlsx('RAW_MATERIAL')}
                    className="w-full py-2.5 px-4 rounded-xl bg-orange-500 hover:bg-orange-600 text-white font-bold text-xs sm:text-sm shadow-xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
                  >
                    <span>🥬</span>
                    <span>Template Bahan Baku (Vegetarian, Fish Meal, dll)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadProductTemplateXlsx('OPERATIONAL_ITEM')}
                    className="w-full py-2.5 px-4 rounded-xl bg-purple-700 hover:bg-purple-800 text-white font-bold text-xs sm:text-sm shadow-xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
                  >
                    <span>🛎️</span>
                    <span>Template Item Operasional (Linen, Handuk, Amenities)</span>
                  </button>
                </div>
              </div>

              {/* Pilih Mode Import (Anti-Duplikat) */}
              <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-2.5">
                <div className="flex items-start gap-2.5">
                  <span className="w-6 h-6 rounded-full bg-indigo-700 text-white text-xs font-extrabold flex items-center justify-center shrink-0 mt-0.5">
                    2
                  </span>
                  <div>
                    <div className="text-sm font-bold text-gray-900">Pilih Mode Import (Anti-Duplikat)</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      Tentukan cara sistem memproses produk yang namanya atau kode SKU-nya sudah ada di database:
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-2 pt-1">
                  <label
                    className={`flex items-start gap-2.5 p-2.5 rounded-xl border text-xs cursor-pointer transition-colors ${
                      excelImportMode === 'UPSERT'
                        ? 'bg-emerald-50/80 border-emerald-500 text-emerald-950'
                        : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="excelImportMode"
                      checked={excelImportMode === 'UPSERT'}
                      onChange={() => setExcelImportMode('UPSERT')}
                      className="mt-0.5 accent-emerald-700"
                    />
                    <div>
                      <div className="font-bold">Tambah &amp; Perbarui Otomatis (Default — Disarankan)</div>
                      <div className="text-[11px] text-gray-600 mt-0.5">
                        Produk yang belum ada akan <strong>ditambahkan baru</strong>, sedangkan produk dengan SKU atau Nama yang sudah ada akan <strong>diperbarui (update)</strong> tanpa membuat duplikat.
                      </div>
                    </div>
                  </label>
                  <label
                    className={`flex items-start gap-2.5 p-2.5 rounded-xl border text-xs cursor-pointer transition-colors ${
                      excelImportMode === 'CREATE_ONLY'
                        ? 'bg-emerald-50/80 border-emerald-500 text-emerald-950'
                        : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="excelImportMode"
                      checked={excelImportMode === 'CREATE_ONLY'}
                      onChange={() => setExcelImportMode('CREATE_ONLY')}
                      className="mt-0.5 accent-emerald-700"
                    />
                    <div>
                      <div className="font-bold">Hanya Tambah Produk Baru (Lewati yang Sudah Ada)</div>
                      <div className="text-[11px] text-gray-600 mt-0.5">
                        Hanya menyimpan produk yang benar-benar baru. Produk yang namanya atau SKU-nya sudah terdaftar akan <strong>dilewati otomatis</strong> (tidak duplikat &amp; tidak mengubah data lama).
                      </div>
                    </div>
                  </label>
                  <label
                    className={`flex items-start gap-2.5 p-2.5 rounded-xl border text-xs cursor-pointer transition-colors ${
                      excelImportMode === 'UPDATE_ONLY'
                        ? 'bg-emerald-50/80 border-emerald-500 text-emerald-950'
                        : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="excelImportMode"
                      checked={excelImportMode === 'UPDATE_ONLY'}
                      onChange={() => setExcelImportMode('UPDATE_ONLY')}
                      className="mt-0.5 accent-emerald-700"
                    />
                    <div>
                      <div className="font-bold">Hanya Edit / Perbarui Produk yang Sudah Ada</div>
                      <div className="text-[11px] text-gray-600 mt-0.5">
                        Khusus revisi harga/kategori/varian massal. Baris yang namanya atau SKU-nya tidak ditemukan di database akan <strong>dilewati</strong> (0% risiko produk baru akibat salah ketik).
                      </div>
                    </div>
                  </label>
                </div>
              </div>

              {/* Pratinjau File Excel bila sudah dipilih */}
              {excelImportRows.length > 0 && (
                <div className="p-4 rounded-2xl bg-amber-50/70 border border-amber-300 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-xs font-extrabold text-amber-950">
                        File Siap Diimport: {excelImportFileName} ({excelImportRows.length} baris di Excel)
                      </div>
                      <div className="text-[11px] text-amber-800">
                        Periksa status tiap baris di bawah lalu klik <strong>Simpan Import ({excelImportPreviewAnalysis.actionableCount} Produk)</strong>.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setExcelImportRows([]);
                        setExcelImportFileName('');
                      }}
                      className="text-xs font-semibold text-amber-900 hover:underline cursor-pointer"
                    >
                      Reset
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pt-0.5">
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                      🟢 {excelImportPreviewAnalysis.newCount} Produk Baru
                    </span>
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-blue-100 text-blue-800 border border-blue-300">
                      🔵 {excelImportPreviewAnalysis.updateCount} Akan Diperbarui
                    </span>
                    {excelImportPreviewAnalysis.skipCount > 0 && (
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-100 text-amber-900 border border-amber-300">
                        🟡 {excelImportPreviewAnalysis.skipCount} Dilewati / Duplikat
                      </span>
                    )}
                  </div>
                  <div className="max-h-52 overflow-x-auto overflow-y-auto bg-white rounded-xl border border-amber-200">
                    <table className="w-full text-left text-[11px]">
                      <thead className="bg-amber-50 text-amber-950 font-bold border-b border-amber-200 sticky top-0">
                        <tr>
                          <th className="py-1.5 px-2.5">Status</th>
                          <th className="py-1.5 px-2.5">SKU</th>
                          <th className="py-1.5 px-2.5">Nama Item</th>
                          <th className="py-1.5 px-2.5">Jenis</th>
                          <th className="py-1.5 px-2.5">Kategori</th>
                          <th className="py-1.5 px-2.5">Satuan</th>
                          <th className="py-1.5 px-2.5">Lokasi Stok</th>
                          <th className="py-1.5 px-2.5">Penyimpanan</th>
                          <th className="py-1.5 px-2.5 text-right">Stok Masuk</th>
                          <th className="py-1.5 px-2.5 text-right">Harga Pokok</th>
                          <th className="py-1.5 px-2.5 text-right">Harga Jual</th>
                          <th className="py-1.5 px-2.5 text-center">POS</th>
                          <th className="py-1.5 px-2.5 text-center">Lacak Inv.</th>
                          <th className="py-1.5 px-2.5">Catatan</th>
                          <th className="py-1.5 px-2.5">Varian</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {excelImportRows.map((r, i) => {
                          const rowStatus = excelImportPreviewAnalysis.rowStatuses[i] ?? 'NEW';
                          const isSkipped =
                            rowStatus === 'SKIP_EXISTING' ||
                            rowStatus === 'SKIP_MISSING' ||
                            rowStatus === 'DUPLICATE_IN_FILE';
                          const matchedLoc = r.location_code
                            ? stockLocations.find(
                                (sl) =>
                                  sl.code.trim().toUpperCase() === r.location_code.trim().toUpperCase() ||
                                  sl.name.trim().toLowerCase() === r.location_code.trim().toLowerCase()
                              )
                            : undefined;
                          return (
                            <tr key={i} className={isSkipped ? 'bg-gray-50/80 opacity-65' : ''}>
                              <td className="py-1.5 px-2.5 whitespace-nowrap">
                                {rowStatus === 'NEW' && (
                                  <span className="inline-block px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-800 font-extrabold text-[10px]">
                                    BARU
                                  </span>
                                )}
                                {rowStatus === 'UPDATE' && (
                                  <span className="inline-block px-2 py-0.5 rounded-md bg-blue-100 text-blue-800 font-extrabold text-[10px]">
                                    UPDATE
                                  </span>
                                )}
                                {rowStatus === 'SKIP_EXISTING' && (
                                  <span className="inline-block px-2 py-0.5 rounded-md bg-amber-100 text-amber-900 font-bold text-[10px]">
                                    SUDAH ADA (DILEWATI)
                                  </span>
                                )}
                                {rowStatus === 'SKIP_MISSING' && (
                                  <span className="inline-block px-2 py-0.5 rounded-md bg-amber-100 text-amber-900 font-bold text-[10px]">
                                    BELUM ADA (DILEWATI)
                                  </span>
                                )}
                                {rowStatus === 'DUPLICATE_IN_FILE' && (
                                  <span className="inline-block px-2 py-0.5 rounded-md bg-rose-100 text-rose-800 font-bold text-[10px]">
                                    DUPLIKAT DI EXCEL
                                  </span>
                                )}
                              </td>
                              <td className="py-1.5 px-2.5 font-mono text-gray-600">{r.sku || 'Otomatis'}</td>
                              <td className="py-1.5 px-2.5 font-semibold text-gray-900">{r.name}</td>
                              <td className="py-1.5 px-2.5">{formatProductTypeLabel(r.product_type)}</td>
                              <td className="py-1.5 px-2.5">{r.category_name || '—'}</td>
                              <td className="py-1.5 px-2.5 font-mono">{r.base_unit}</td>
                              <td className="py-1.5 px-2.5 whitespace-nowrap">
                                {r.location_code ? (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-900 border border-indigo-200 font-mono font-bold text-[10px]">
                                    {matchedLoc ? `${matchedLoc.code} (${matchedLoc.name})` : r.location_code}
                                  </span>
                                ) : (
                                  '—'
                                )}
                              </td>
                              <td className="py-1.5 px-2.5">{r.storage_sublocation || '—'}</td>
                              <td className="py-1.5 px-2.5 text-right font-mono font-bold text-teal-800 whitespace-nowrap">
                                {r.stock_qty !== null && r.stock_qty !== undefined
                                  ? r.stock_qty > 0
                                    ? `+${r.stock_qty} ${r.base_unit}`
                                    : `0 ${r.base_unit}`
                                  : '—'}
                              </td>
                              <td className="py-1.5 px-2.5 text-right font-mono text-gray-700 whitespace-nowrap">
                                {r.cost_price > 0 ? formatIDR(r.cost_price) : '—'}
                              </td>
                              <td className="py-1.5 px-2.5 text-right font-mono whitespace-nowrap">
                                {r.price != null ? formatIDR(r.price) : '—'}
                              </td>
                              <td className="py-1.5 px-2.5 text-center whitespace-nowrap">
                                <label className="inline-flex items-center gap-1 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={Boolean(r.is_sellable_pos)}
                                    onChange={(e) => {
                                      const checked = e.target.checked;
                                      setExcelImportRows((prev) =>
                                        prev.map((rowItem, idx) =>
                                          idx === i ? { ...rowItem, is_sellable_pos: checked } : rowItem
                                        )
                                      );
                                    }}
                                    className="accent-emerald-700 cursor-pointer"
                                  />
                                  <span
                                    className={`text-[10px] font-bold ${
                                      r.is_sellable_pos ? 'text-emerald-800' : 'text-gray-400'
                                    }`}
                                  >
                                    {r.is_sellable_pos ? 'YA' : 'TIDAK'}
                                  </span>
                                </label>
                              </td>
                              <td className="py-1.5 px-2.5 text-center whitespace-nowrap">
                                <label className="inline-flex items-center gap-1 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={Boolean(r.track_stock)}
                                    onChange={(e) => {
                                      const checked = e.target.checked;
                                      setExcelImportRows((prev) =>
                                        prev.map((rowItem, idx) =>
                                          idx === i ? { ...rowItem, track_stock: checked } : rowItem
                                        )
                                      );
                                    }}
                                    className="accent-teal-700 cursor-pointer"
                                  />
                                  <span
                                    className={`text-[10px] font-bold ${
                                      r.track_stock ? 'text-teal-800' : 'text-gray-400'
                                    }`}
                                  >
                                    {r.track_stock ? 'YA' : 'TIDAK'}
                                  </span>
                                </label>
                              </td>
                              <td className="py-1.5 px-2.5 text-gray-600 max-w-[160px] truncate" title={r.notes || ''}>
                                {r.notes || '—'}
                              </td>
                              <td className="py-1.5 px-2.5">
                                {r.variants.length > 0
                                  ? r.variants.map((v) => `${v.name} (${formatIDR(v.price)})`).join(', ')
                                  : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Section 3: Format Kolom yang Didukung */}
              <div className="p-4 rounded-2xl bg-gray-50 border border-gray-200 space-y-3">
                <div className="flex items-start gap-2.5">
                  <span className="w-6 h-6 rounded-full bg-slate-700 text-white text-xs font-extrabold flex items-center justify-center shrink-0 mt-0.5">
                    3
                  </span>
                  <div>
                    <div className="text-sm font-bold text-gray-900">Format Kolom yang Didukung</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      Sistem mengenali kolom secara otomatis (case-insensitive). Berikut kolom yang didukung:
                    </div>
                  </div>
                </div>

                {stockLocations.filter((l) => l.is_active).length > 0 && (
                  <div className="p-2.5 rounded-xl bg-indigo-50/70 border border-indigo-200 text-[11px] text-indigo-950">
                    <div className="font-bold mb-1">Daftar Kode Lokasi Stok Properti Aktif (untuk kolom Kode Lokasi Stok):</div>
                    <div className="flex flex-wrap gap-1.5">
                      {stockLocations
                        .filter((l) => l.is_active)
                        .map((loc) => (
                          <span
                            key={loc.id}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white border border-indigo-200 font-mono text-[10px]"
                          >
                            <strong className="text-indigo-800">{loc.code}</strong>
                            <span className="text-gray-600">({loc.name})</span>
                          </span>
                        ))}
                    </div>
                  </div>
                )}

                <div className="space-y-2 text-xs text-gray-600 pt-1">
                  <div>
                    <span className="inline-block px-2 py-0.5 rounded bg-slate-200/80 text-slate-800 font-mono font-bold text-[11px] mr-1.5">
                      Kode Item / SKU
                    </span>
                    Kode unik produk (opsional, otomatis jika kosong; jika SKU sudah ada maka akan memperbarui data produk)
                  </div>
                  <div>
                    <span className="inline-block px-2 py-0.5 rounded bg-slate-200/80 text-slate-800 font-mono font-bold text-[11px] mr-1.5">
                      Barcode
                    </span>
                    Kode barcode produk untuk scan di kasir (opsional)
                  </div>
                  <div>
                    <span className="inline-block px-2 py-0.5 rounded bg-rose-100 text-rose-800 font-mono font-bold text-[11px] mr-1.5">
                      Nama Item
                    </span>
                    Nama produk / barang (wajib)
                  </div>
                  <div>
                    <span className="inline-block px-2 py-0.5 rounded bg-slate-200/80 text-slate-800 font-mono font-bold text-[11px] mr-1.5">
                      Jenis
                    </span>
                    Tipe: <strong>Produk Jadi</strong>, <strong>Produk Setengah Jadi</strong>, <strong>Bahan Baku</strong>, atau <strong>Item Operasional</strong>
                  </div>
                  <div>
                    <span className="inline-block px-2 py-0.5 rounded bg-slate-200/80 text-slate-800 font-mono font-bold text-[11px] mr-1.5">
                      Kategori
                    </span>
                    Kategori per jenis produk (otomatis dibuat &amp; dikelompokkan per jenis produk, cth Bahan Baku: Vegetarian, Fish Meal; Produk Jadi: Makanan, Minuman)
                  </div>
                  <div>
                    <span className="inline-block px-2 py-0.5 rounded bg-slate-200/80 text-slate-800 font-mono font-bold text-[11px] mr-1.5">
                      Satuan
                    </span>
                    Unit dasar: PCS, PORSI, CUP, BOTOL, GRAM, KG, ML, LITER, SET, dll (default: PCS)
                  </div>
                  <div>
                    <span className="inline-block px-2 py-0.5 rounded bg-indigo-100 text-indigo-900 font-mono font-bold text-[11px] mr-1.5">
                      Kode Lokasi Stok
                    </span>
                    Kode lokasi properti di menu <strong>Stok &amp; Mutasi</strong> (contoh: <strong>RCP</strong> untuk Receptionis, <strong>KCH</strong> untuk Housekeeping/Kitchen). Saat di-import, produk otomatis masuk ke lokasi tersebut di Stok &amp; Mutasi
                  </div>
                  <div>
                    <span className="inline-block px-2 py-0.5 rounded bg-slate-200/80 text-slate-800 font-mono font-bold text-[11px] mr-1.5">
                      Tempat Penyimpanan
                    </span>
                    Sub-lokasi di dalam gudang/outlet (contoh: Box Rokok, Showcase, Chiller, Freezer, Rak Linen)
                  </div>
                  <div>
                    <span className="inline-block px-2 py-0.5 rounded bg-teal-100 text-teal-900 font-mono font-bold text-[11px] mr-1.5">
                      Stok
                    </span>
                    Jumlah stok (angka) yang otomatis masuk/bertambah ke lokasi stok di halaman <strong>Stok &amp; Mutasi</strong> saat di-import
                  </div>
                  <div>
                    <span className="inline-block px-2 py-0.5 rounded bg-amber-100 text-amber-900 font-mono font-bold text-[11px] mr-1.5">
                      Harga Pokok
                    </span>
                    HPP / harga modal per satuan dasar (otomatis masuk ke <strong>Saldo Awal Persediaan</strong> &amp; perhitungan <strong>HPP Rata-rata / Moving Average</strong>)
                  </div>
                  <div>
                    <span className="inline-block px-2 py-0.5 rounded bg-slate-200/80 text-slate-800 font-mono font-bold text-[11px] mr-1.5">
                      Harga Jual
                    </span>
                    Harga jual ke konsumen (angka, wajib untuk Produk Jadi POS)
                  </div>
                  <div>
                    <span className="inline-block px-2 py-0.5 rounded bg-emerald-100 text-emerald-900 font-mono font-bold text-[11px] mr-1.5">
                      Tampil di POS
                    </span>
                    Isi <strong>YA</strong> atau <strong>TIDAK</strong> (default: YA untuk Produk Jadi, TIDAK untuk Bahan Baku / Setengah Jadi / Operasional)
                  </div>
                  <div>
                    <span className="inline-block px-2 py-0.5 rounded bg-teal-100 text-teal-900 font-mono font-bold text-[11px] mr-1.5">
                      Lacak Inventory
                    </span>
                    Isi <strong>YA</strong> atau <strong>TIDAK</strong> untuk otomatis mencentang <strong>Lacak Stok &amp; GRN</strong> (default: YA untuk semua barang fisik &amp; bahan baku; TIDAK hanya jika diisi TIDAK atau satuan PORSI racikan)
                  </div>
                  <div>
                    <span className="inline-block px-2 py-0.5 rounded bg-purple-100 text-purple-900 font-mono font-bold text-[11px] mr-1.5">
                      Catatan
                    </span>
                    Keterangan mutasi stok yang otomatis tercatat pada <strong>Riwayat Mutasi</strong> di halaman Stok &amp; Mutasi
                  </div>
                  <div>
                    <span className="inline-block px-2 py-0.5 rounded bg-slate-200/80 text-slate-800 font-mono font-bold text-[11px] mr-1.5">
                      Varian1_Nama, Varian2_Nama, ...
                    </span>
                    Nama varian khusus Produk Jadi. Jumlah varian bebas — tambah sendiri kolom Varian3_Nama, Varian4_Nama, dst. Contoh isi: Reguler, Jumbo, Kecil, Besar
                  </div>
                  <div>
                    <span className="inline-block px-2 py-0.5 rounded bg-slate-200/80 text-slate-800 font-mono font-bold text-[11px] mr-1.5">
                      Varian1_Harga, Varian2_Harga, ...
                    </span>
                    Harga jual per varian (angka)
                  </div>
                  <div>
                    <span className="inline-block px-2 py-0.5 rounded bg-slate-200/80 text-slate-800 font-mono font-bold text-[11px] mr-1.5">
                      Varian1_HPP, Varian2_HPP, ...
                    </span>
                    Modal/HPP per varian (angka, opsional)
                  </div>
                  <div>
                    <span className="inline-block px-2 py-0.5 rounded bg-slate-200/80 text-slate-800 font-mono font-bold text-[11px] mr-1.5">
                      Varian1_Barcode, Varian2_Barcode, ...
                    </span>
                    Barcode per varian (opsional)
                  </div>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="shrink-0 px-6 py-4 border-t border-gray-100 bg-white flex items-center justify-end gap-2.5">
              <input
                ref={excelFileInputRef}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={handleExcelFileChange}
                className="hidden"
              />
              <button
                type="button"
                disabled={excelImportLoading}
                onClick={() => setShowExcelImportModal(false)}
                className="px-4 py-2.5 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs sm:text-sm font-bold cursor-pointer disabled:opacity-50"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={excelImportLoading}
                onClick={() => excelFileInputRef.current?.click()}
                className="px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-xs sm:text-sm font-bold shadow-xs flex items-center gap-2 cursor-pointer disabled:opacity-50"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                {excelImportRows.length > 0 ? 'Ganti File Excel' : 'Pilih File Excel'}
              </button>
              {excelImportRows.length > 0 && (
                <button
                  type="button"
                  disabled={excelImportLoading || excelImportPreviewAnalysis.actionableCount === 0}
                  onClick={handleBulkExcelImportSubmit}
                  className="px-4 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs sm:text-sm font-bold shadow-xs cursor-pointer disabled:opacity-50"
                >
                  {excelImportLoading
                    ? 'Mengimpor…'
                    : `Simpan Import (${excelImportPreviewAnalysis.actionableCount} Produk)`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Floating Action Button (+) Tambah Produk di kanan bawah */}
      {capabilities.canCreate && (
        <button
          type="button"
          onClick={openAddModal}
          title="Tambah Produk Baru"
          aria-label="Tambah Produk"
          data-testid="fab-add-product"
          className="fixed bottom-6 right-6 z-40 w-14 h-14 rounded-full bg-[#1db954] hover:bg-emerald-600 active:scale-95 text-white shadow-lg shadow-emerald-950/25 flex items-center justify-center transition-all cursor-pointer focus:outline-hidden focus:ring-4 focus:ring-emerald-500/30"
        >
          <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" d="M12 5v14m7-7H5" />
          </svg>
        </button>
      )}

      {/* MPUI-F01: Portal-based three-dot menu — rendered outside table overflow context */}
      {openMenuRowId !== null && (() => {
          const activeItem = filteredItems.find((i) => i.id === openMenuRowId);
          if (!activeItem) return null;
          const { top, bottom, right } = menuPosition;
          const menuStyle: React.CSSProperties = {
            position: 'fixed',
            top: top ?? undefined,
            bottom: bottom ?? undefined,
            right,
            zIndex: 9999,
            minWidth: 150,
          };
          return createPortal(
            <div
              ref={(el) => { menuPortalRef.current = el; }}
              role="menu"
              aria-label={`Menu opsi ${activeItem.name}`}
              style={menuStyle}
              className="bg-white border border-gray-200 rounded-lg shadow-xl py-1"
            >
              {(capabilities.canEdit || capabilities.canCreate) && (
                <>
                  {(activeItem.product_type === 'FINISHED_GOOD' || activeItem.product_type === 'SEMI_FINISHED') && (
                    <button
                      type="button"
                      role="menuitem"
                      aria-label={`Formula resep BOM ${activeItem.name}`}
                      onClick={() => { closeRowMenu(false); openRecipeModal(activeItem); }}
                      disabled={saving}
                      className="w-full text-left px-3 py-1.5 text-xs text-amber-800 hover:bg-amber-50 cursor-pointer disabled:opacity-50"
                    >
                      Resep / BOM
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    aria-label={`Kelola kemasan ${activeItem.name}`}
                    onClick={() => { closeRowMenu(false); openPackagingModal(activeItem); }}
                    disabled={saving}
                    className="w-full text-left px-3 py-1.5 text-xs text-sky-700 hover:bg-sky-50 cursor-pointer disabled:opacity-50"
                  >
                    Kemasan
                  </button>
                </>
              )}
              {capabilities.canToggleStatus && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { closeRowMenu(false); handleToggleActive(activeItem); }}
                  disabled={saving}
                  className={`w-full text-left px-3 py-1.5 text-xs cursor-pointer disabled:opacity-50 ${activeItem.is_active !== false ? 'text-amber-700 hover:bg-amber-50' : 'text-emerald-700 hover:bg-emerald-50'}`}
                >
                  {activeItem.is_active !== false ? 'Nonaktifkan' : 'Aktifkan'}
                </button>
              )}
              {(capabilities.canEdit || capabilities.canToggleStatus) && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { closeRowMenu(false); void handleDeleteProduct(activeItem); }}
                  disabled={saving}
                  className="w-full text-left px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-50 font-semibold cursor-pointer disabled:opacity-50 border-t border-gray-100 mt-0.5 pt-1.5"
                >
                  Hapus Produk
                </button>
              )}
            </div>,
            document.body
          );
        })()}

      <datalist id="oak-storage-sublocations">
        {COMMON_STORAGE_SUBLOCATIONS.map((subloc) => (
          <option key={subloc} value={subloc} />
        ))}
      </datalist>
    </div>
  );
}
