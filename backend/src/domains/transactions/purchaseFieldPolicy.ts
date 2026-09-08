import type { FieldMode } from '../frontOffice/frontOfficeSettingsService';
import type { CreatePurchaseTransactionDto, TransactionLineInput } from './transactionTypes';

export type { FieldMode };

export const FIELD_MODES: FieldMode[] = ['REQUIRED', 'OPTIONAL', 'HIDDEN'];

export const PURCHASE_FIELD_KEYS = [
  'supplier',
  'category',
  'department',
  'invoice_reference',
  'notes',
  'receiving_status',
  'payment_status',
  'payment_method',
  'paid_amount',
  'receipt_attachment',
  'payment_evidence',
  'transaction_discount',
  'line_unit',
  'line_discount',
] as const;

export type PurchaseFieldKey = (typeof PURCHASE_FIELD_KEYS)[number];

export const PURCHASE_FIELD_LABELS: Record<PurchaseFieldKey, string> = {
  supplier: 'Supplier',
  category: 'Kategori',
  department: 'Departemen Alokasi',
  invoice_reference: 'No. Faktur Supplier',
  notes: 'Catatan',
  receiving_status: 'Penerimaan',
  payment_status: 'Pembayaran',
  payment_method: 'Metode Pembayaran',
  paid_amount: 'Nominal Dibayar',
  receipt_attachment: 'Bukti Nota / Struk',
  payment_evidence: 'Bukti Pembayaran',
  transaction_discount: 'Diskon Tambahan',
  line_unit: 'Satuan Item',
  line_discount: 'Diskon Item',
};

/**
 * Defaults preserve current create/editor behavior when no property rows exist.
 * receiving_status / payment_status stay OPTIONAL so omitted API fields still work
 * (backend already defaults omitted receiving to BELUM_DITERIMA and omitted pay-now to unpaid).
 */
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

export const ALLOWED_PURCHASE_FIELD_MODES: Record<PurchaseFieldKey, FieldMode[]> = {
  supplier: ['REQUIRED', 'OPTIONAL', 'HIDDEN'],
  category: ['REQUIRED', 'HIDDEN'],
  department: ['REQUIRED', 'OPTIONAL', 'HIDDEN'],
  invoice_reference: ['REQUIRED', 'OPTIONAL', 'HIDDEN'],
  notes: ['REQUIRED', 'OPTIONAL', 'HIDDEN'],
  receiving_status: ['REQUIRED', 'OPTIONAL', 'HIDDEN'],
  payment_status: ['REQUIRED', 'OPTIONAL', 'HIDDEN'],
  payment_method: ['REQUIRED', 'HIDDEN'],
  paid_amount: ['REQUIRED', 'OPTIONAL'],
  receipt_attachment: ['OPTIONAL', 'HIDDEN'],
  payment_evidence: ['OPTIONAL', 'HIDDEN'],
  transaction_discount: ['REQUIRED', 'OPTIONAL', 'HIDDEN'],
  line_unit: ['REQUIRED'],
  line_discount: ['REQUIRED', 'OPTIONAL', 'HIDDEN'],
};

export const HIDDEN_RECEIVING_DEFAULT = 'BELUM_DITERIMA' as const;

export function isFieldMode(value: unknown): value is FieldMode {
  return value === 'REQUIRED' || value === 'OPTIONAL' || value === 'HIDDEN';
}

export function isPurchaseFieldKey(value: unknown): value is PurchaseFieldKey {
  return typeof value === 'string' && (PURCHASE_FIELD_KEYS as readonly string[]).includes(value);
}

export function policyError(statusCode: number, message: string, code: string): Error {
  const err: any = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

function hasPositiveId(value: unknown): boolean {
  const n = Number(value);
  return Number.isInteger(n) && n > 0;
}

export function coercePurchaseFieldMode(key: PurchaseFieldKey, stored: unknown): FieldMode {
  if (isFieldMode(stored) && ALLOWED_PURCHASE_FIELD_MODES[key].includes(stored)) {
    return stored;
  }
  // Stale 1D rows must fail closed, not reopen unsafe invented defaults.
  if (key === 'line_unit') return 'REQUIRED';
  if (key === 'payment_method') return 'REQUIRED';
  if (key === 'paid_amount') return 'REQUIRED';
  return DEFAULT_PURCHASE_FIELD_MODES[key];
}

export function mergePurchaseFieldModes(
  stored: Record<string, unknown> | null | undefined
): Record<PurchaseFieldKey, FieldMode> {
  const modes = { ...DEFAULT_PURCHASE_FIELD_MODES };
  if (!stored) return modes;
  for (const key of PURCHASE_FIELD_KEYS) {
    if (stored[key] !== undefined) {
      modes[key] = coercePurchaseFieldMode(key, stored[key]);
    }
  }
  return modes;
}

export function validatePurchaseFieldRuleSettings(params: {
  modes: Record<PurchaseFieldKey, FieldMode>;
  defaultPurchaseCategoryId?: number | null;
}): void {
  const { modes, defaultPurchaseCategoryId } = params;

  for (const key of PURCHASE_FIELD_KEYS) {
    const mode = modes[key];
    if (!ALLOWED_PURCHASE_FIELD_MODES[key].includes(mode)) {
      throw policyError(
        400,
        `Mode '${mode}' tidak diizinkan untuk field ${PURCHASE_FIELD_LABELS[key]}`,
        'INVALID_FIELD_MODE'
      );
    }
  }

  if (modes.category === 'HIDDEN' && !hasPositiveId(defaultPurchaseCategoryId)) {
    throw policyError(
      400,
      'Kategori disembunyikan hanya jika properti punya kategori pembelian default yang aktif',
      'DEFAULT_PURCHASE_CATEGORY_REQUIRED'
    );
  }

  if (modes.payment_status !== 'HIDDEN' && modes.payment_method === 'HIDDEN') {
    throw policyError(
      400,
      'Metode pembayaran tidak boleh disembunyikan jika status pembayaran masih tampil (bayar sekarang tidak boleh mencatat metode palsu)',
      'INVALID_PAYMENT_FIELD_COMBINATION'
    );
  }
  if (modes.payment_status !== 'HIDDEN' && modes.paid_amount === 'HIDDEN') {
    throw policyError(
      400,
      'Nominal dibayar tidak boleh disembunyikan jika status pembayaran masih tampil',
      'INVALID_PAYMENT_FIELD_COMBINATION'
    );
  }
  if (modes.payment_status === 'HIDDEN' && modes.payment_method === 'REQUIRED') {
    throw policyError(
      400,
      'Jika pembayaran disembunyikan, metode pembayaran tidak boleh Wajib (transaksi baru menjadi tempo/belum dibayar)',
      'INVALID_PAYMENT_FIELD_COMBINATION'
    );
  }
  if (modes.payment_status === 'HIDDEN' && modes.paid_amount === 'REQUIRED') {
    throw policyError(
      400,
      'Jika pembayaran disembunyikan, nominal dibayar tidak boleh Wajib (transaksi baru menjadi tempo/belum dibayar)',
      'INVALID_PAYMENT_FIELD_COMBINATION'
    );
  }

  if (modes.receipt_attachment === 'REQUIRED' || modes.payment_evidence === 'REQUIRED') {
    throw policyError(
      400,
      'Lampiran Wajib belum dapat ditegakkan pada alur unggah setelah create. Gunakan Opsional atau Sembunyikan.',
      'ATTACHMENT_REQUIRED_UNSUPPORTED'
    );
  }
}

export function applyPurchaseFieldPolicyToCreateDto(params: {
  dto: CreatePurchaseTransactionDto;
  modes: Record<PurchaseFieldKey, FieldMode>;
  defaultPurchaseCategoryId: number | null;
}): CreatePurchaseTransactionDto {
  const { modes, defaultPurchaseCategoryId } = params;
  const dto: CreatePurchaseTransactionDto = {
    ...params.dto,
    lines: (params.dto.lines || []).map((line) => ({ ...line })),
  };

  applySupplierPolicy(dto, modes.supplier);
  applyCategoryPolicy(dto, modes.category, defaultPurchaseCategoryId);
  applyDepartmentPolicy(dto, modes.department);
  applyInvoicePolicy(dto, modes.invoice_reference);
  applyNotesPolicy(dto, modes.notes);
  applyReceivingPolicy(dto, modes.receiving_status);
  applyPaymentPolicy(dto, modes);
  applyDiscountPolicy(dto, modes);
  applyLinePolicies(dto.lines, modes);

  return dto;
}

function applySupplierPolicy(dto: CreatePurchaseTransactionDto, mode: FieldMode): void {
  if (mode === 'HIDDEN') {
    dto.supplier_id = null;
    dto.supplier_name = null;
    dto.supplier_phone = null;
    dto.supplier_bank_name = null;
    dto.supplier_bank_account = null;
    dto.supplier_address = null;
    return;
  }
  if (mode === 'REQUIRED' && !hasPositiveId(dto.supplier_id) && isBlank(dto.supplier_name)) {
    throw policyError(400, 'Supplier / vendor wajib dipilih', 'VALIDATION_ERROR');
  }
}

function applyCategoryPolicy(
  dto: CreatePurchaseTransactionDto,
  mode: FieldMode,
  defaultPurchaseCategoryId: number | null
): void {
  if (mode === 'HIDDEN') {
    dto.purchase_category_id = defaultPurchaseCategoryId;
    dto.category_code = undefined;
    dto.category_name = undefined;
    if (!hasPositiveId(dto.purchase_category_id)) {
      throw policyError(
        400,
        'Kategori pembelian default properti tidak valid. Setel kategori default di pengaturan.',
        'DEFAULT_PURCHASE_CATEGORY_REQUIRED'
      );
    }
    return;
  }
  if (!hasPositiveId(dto.purchase_category_id) && isBlank(dto.category_code)) {
    throw policyError(400, 'Kategori pembelian wajib dipilih', 'VALIDATION_ERROR');
  }
}

function applyDepartmentPolicy(dto: CreatePurchaseTransactionDto, mode: FieldMode): void {
  if (mode === 'HIDDEN') {
    dto.department_id = null;
    dto.department_code = undefined;
    return;
  }
  if (mode === 'REQUIRED' && !hasPositiveId(dto.department_id)) {
    throw policyError(400, 'Departemen alokasi wajib dipilih', 'VALIDATION_ERROR');
  }
}

function applyInvoicePolicy(dto: CreatePurchaseTransactionDto, mode: FieldMode): void {
  if (mode === 'HIDDEN') {
    dto.source_reference = null;
    return;
  }
  if (mode === 'REQUIRED' && isBlank(dto.source_reference)) {
    throw policyError(400, 'No. faktur supplier wajib diisi', 'VALIDATION_ERROR');
  }
}

function applyNotesPolicy(dto: CreatePurchaseTransactionDto, mode: FieldMode): void {
  if (mode === 'HIDDEN') {
    dto.notes = null;
    return;
  }
  if (mode === 'REQUIRED' && isBlank(dto.notes)) {
    throw policyError(400, 'Catatan pembelian wajib diisi', 'VALIDATION_ERROR');
  }
}

function applyReceivingPolicy(dto: CreatePurchaseTransactionDto, mode: FieldMode): void {
  if (mode === 'HIDDEN') {
    dto.receiving_status = HIDDEN_RECEIVING_DEFAULT;
    return;
  }
  if (mode === 'REQUIRED' && isBlank(dto.receiving_status)) {
    throw policyError(400, 'Status penerimaan wajib dipilih', 'VALIDATION_ERROR');
  }
}

function isPayNow(dto: CreatePurchaseTransactionDto): boolean {
  if (dto.is_immediately_paid === false) return false;
  if (dto.is_immediately_paid === true) return true;
  const raw = dto.paid_amount;
  return raw !== undefined && raw !== null && String(raw) !== '' && Number(raw) > 0;
}

function applyPaymentPolicy(
  dto: CreatePurchaseTransactionDto,
  modes: Record<PurchaseFieldKey, FieldMode>
): void {
  if (modes.payment_status === 'HIDDEN') {
    dto.is_immediately_paid = false;
    dto.paid_amount = 0;
    dto.payment_method = null;
    return;
  }
  if (modes.payment_status === 'REQUIRED' && dto.is_immediately_paid !== true && dto.is_immediately_paid !== false) {
    throw policyError(400, 'Status pembayaran wajib dipilih', 'VALIDATION_ERROR');
  }

  const paying = isPayNow(dto);
  if (!paying) {
    if (modes.payment_method === 'HIDDEN') dto.payment_method = null;
    return;
  }

  if (isBlank(dto.payment_method)) {
    throw policyError(400, 'Metode pembayaran wajib dipilih', 'VALIDATION_ERROR');
  }

  if (modes.paid_amount === 'HIDDEN') {
    throw policyError(400, 'Nominal dibayar tidak boleh disembunyikan saat bayar sekarang', 'VALIDATION_ERROR');
  }
  if (modes.paid_amount === 'REQUIRED') {
    const raw = dto.paid_amount;
    if (raw === undefined || raw === null || String(raw) === '') {
      throw policyError(400, 'Nominal dibayar wajib diisi', 'VALIDATION_ERROR');
    }
  }
}

function applyDiscountPolicy(
  dto: CreatePurchaseTransactionDto,
  modes: Record<PurchaseFieldKey, FieldMode>
): void {
  if (modes.transaction_discount === 'HIDDEN') {
    dto.transaction_discount = 0;
    dto.discount_amount = 0;
    return;
  }
  if (modes.transaction_discount === 'REQUIRED') {
    const raw = dto.transaction_discount ?? dto.discount_amount;
    if (raw === undefined || raw === null || String(raw) === '') {
      throw policyError(400, 'Diskon tambahan wajib diisi', 'VALIDATION_ERROR');
    }
  }
}

function applyLinePolicies(
  lines: TransactionLineInput[],
  modes: Record<PurchaseFieldKey, FieldMode>
): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line.unit)) {
      throw policyError(400, `Baris item ke-${i + 1}: Satuan wajib diisi`, 'VALIDATION_ERROR');
    }

    if (modes.line_discount === 'HIDDEN') {
      line.discount_amount = 0;
    } else if (modes.line_discount === 'REQUIRED') {
      if (line.discount_amount === undefined || line.discount_amount === null || String(line.discount_amount) === '') {
        throw policyError(400, `Baris item ke-${i + 1}: Diskon item wajib diisi`, 'VALIDATION_ERROR');
      }
    }
  }
}
