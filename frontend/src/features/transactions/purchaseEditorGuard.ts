import type { FieldMode, PurchaseFieldPolicy } from './purchaseFieldPolicy';

export const PURCHASE_FORM_OPTIONS_ERROR =
  'Gagal memuat kategori/departemen pembelian. Muat ulang sebelum menyimpan.';

export function canSubmitPurchaseCreate(state: {
  optionsFailed: boolean;
  optionsLoaded: boolean;
  categories: Array<{ id: number }>;
  categoryId: number | '';
  fieldPolicy?: PurchaseFieldPolicy | null;
}): boolean {
  if (state.optionsFailed || !state.optionsLoaded) return false;
  const categoryMode: FieldMode = state.fieldPolicy?.modes?.category || 'REQUIRED';
  if (categoryMode === 'HIDDEN') return true;
  if (!state.categories.length) return false;
  const id = Number(state.categoryId);
  if (!Number.isInteger(id) || id <= 0) return false;
  return state.categories.some((row) => row.id === id);
}
