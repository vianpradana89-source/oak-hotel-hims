export type FieldMode = 'REQUIRED' | 'OPTIONAL' | 'HIDDEN';

export type PurchaseFieldKey =
  | 'supplier'
  | 'category'
  | 'department'
  | 'invoice_reference'
  | 'notes'
  | 'receiving_status'
  | 'payment_status'
  | 'payment_method'
  | 'paid_amount'
  | 'receipt_attachment'
  | 'payment_evidence'
  | 'transaction_discount'
  | 'line_unit'
  | 'line_discount';

export const DEFAULT_PURCHASE_FIELD_MODES: Record<PurchaseFieldKey, FieldMode> = {
  supplier: 'REQUIRED',
  category: 'REQUIRED',
  department: 'OPTIONAL',
  invoice_reference: 'OPTIONAL',
  notes: 'OPTIONAL',
  receiving_status: 'OPTIONAL',
  payment_status: 'OPTIONAL',
  payment_method: 'REQUIRED',
  paid_amount: 'OPTIONAL',
  receipt_attachment: 'OPTIONAL',
  payment_evidence: 'OPTIONAL',
  transaction_discount: 'OPTIONAL',
  line_unit: 'REQUIRED',
  line_discount: 'OPTIONAL',
};

export interface PurchaseFieldRuleItem {
  field_key: PurchaseFieldKey;
  field_mode: FieldMode;
  default_mode: FieldMode;
  allowed_modes: FieldMode[];
  label: string;
}

export interface PurchaseFieldPolicy {
  property_id: number;
  fields: PurchaseFieldRuleItem[];
  modes: Record<PurchaseFieldKey, FieldMode>;
  default_purchase_category_id: number | null;
}

export function getPurchaseFieldMode(
  policy: PurchaseFieldPolicy | null | undefined,
  key: PurchaseFieldKey
): FieldMode {
  const mode = policy?.modes?.[key] || policy?.fields?.find((row) => row.field_key === key)?.field_mode;
  return mode || DEFAULT_PURCHASE_FIELD_MODES[key];
}

export function isPurchaseFieldVisible(
  policy: PurchaseFieldPolicy | null | undefined,
  key: PurchaseFieldKey
): boolean {
  return getPurchaseFieldMode(policy, key) !== 'HIDDEN';
}

export function isPurchaseFieldRequired(
  policy: PurchaseFieldPolicy | null | undefined,
  key: PurchaseFieldKey
): boolean {
  return getPurchaseFieldMode(policy, key) === 'REQUIRED';
}

/** Satuan remains visible/required until a property default-unit architecture exists. */
export function isPurchaseLineUnitVisible(): boolean {
  return true;
}

export function isPurchaseLineUnitRequired(): boolean {
  return true;
}

/**
 * When payment parent is visible, method and paid amount stay on the form.
 * Hidden payment parent forces unpaid, so these fields are not collected.
 */
export function isPurchasePayNowDetailVisible(
  policy: PurchaseFieldPolicy | null | undefined
): boolean {
  return isPurchaseFieldVisible(policy, 'payment_status');
}
