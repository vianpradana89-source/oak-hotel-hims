import type {
  TransactionRecord,
  TransactionSummary,
  TransactionSheetCounts,
  CategoryOption,
  DepartmentOption,
  TransactionType,
  VerificationStatus,
  ReceivingStatus,
  AttachmentPurpose,
  Supplier,
  CustomCategory,
  TransactionLineInput
} from './transactionDomainTypes';

const API_BASE = '/api/transactions';
const SUPPLIERS_BASE = '/api/suppliers';

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  const contentType = res.headers.get('content-type') || '';

  if (!contentType.includes('application/json')) {
    if (!res.ok) {
      throw new Error(`Server mengembalikan respon (${res.status} ${res.statusText}). Pastikan backend aktif.`);
    }
    throw new Error('Respon server bukan format JSON yang valid.');
  }

  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Terjadi kesalahan pada sistem');
  }
  return json.data;
}

export interface GetTransactionsResponse {
  transactions: TransactionRecord[];
  total_count: number;
  summary: TransactionSummary;
  sheet_counts?: TransactionSheetCounts;
  limit: number;
  offset: number;
}

export async function fetchTransactionsApi(params: {
  property_id: number;
  transaction_type?: string;
  category_code?: string;
  department_code?: string;
  payment_status?: string;
  payment_method?: string;
  transaction_status?: string;
  verification_status?: string;
  receiving_status?: string;
  operational_status?: string;
  operational_sheet?: string;
  start_date?: string;
  end_date?: string;
  search?: string;
  supplier_id?: number;
  reservation_id?: number;
  booking_id?: string;
  limit?: number;
  offset?: number;
}): Promise<GetTransactionsResponse> {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, String(value));
    }
  });

  return await fetchJson<GetTransactionsResponse>(`${API_BASE}?${query.toString()}`);
}

export async function fetchTransactionDetailApi(
  id: number | string,
  propertyId: number
): Promise<TransactionRecord> {
  return await fetchJson<TransactionRecord>(`${API_BASE}/${id}?property_id=${propertyId}`);
}

export async function fetchCategoriesApi(propertyId: number = 1): Promise<{
  categories: CategoryOption[];
  departments: DepartmentOption[];
}> {
  return await fetchJson<{ categories: CategoryOption[]; departments: DepartmentOption[] }>(
    `${API_BASE}/categories?property_id=${propertyId}`
  );
}

// Supplier Domain APIs
export async function fetchSuppliersApi(params: {
  property_id: number;
  search?: string;
  is_active?: boolean;
}): Promise<Supplier[]> {
  const query = new URLSearchParams();
  query.set('property_id', String(params.property_id));
  if (params.search) query.set('search', params.search);
  if (params.is_active !== undefined) query.set('is_active', String(params.is_active));

  return await fetchJson<Supplier[]>(`${SUPPLIERS_BASE}?${query.toString()}`);
}

export async function createSupplierApi(data: {
  property_id: number;
  name: string;
  phone?: string | null;
  email?: string | null;
  bank_name?: string | null;
  bank_account?: string | null;
  bank_holder?: string | null;
  address?: string | null;
  tax_id?: string | null;
  actor_name?: string | null;
}): Promise<Supplier> {
  return await fetchJson<Supplier>(SUPPLIERS_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

export async function updateSupplierApi(
  id: string | number,
  data: {
    property_id: number;
    name?: string;
    phone?: string | null;
    email?: string | null;
    bank_name?: string | null;
    bank_account?: string | null;
    bank_holder?: string | null;
    address?: string | null;
    tax_id?: string | null;
    is_active?: boolean;
    actor_name?: string | null;
  }
): Promise<Supplier> {
  return await fetchJson<Supplier>(`${SUPPLIERS_BASE}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

export async function toggleSupplierApi(
  id: string | number,
  propertyId: number,
  actorName?: string
): Promise<Supplier> {
  return await fetchJson<Supplier>(`${SUPPLIERS_BASE}/${id}/toggle`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ property_id: propertyId, actor_name: actorName })
  });
}

// Custom Categories APIs
export async function fetchCustomCategoriesApi(
  propertyId: number,
  type?: TransactionType
): Promise<CustomCategory[]> {
  const query = new URLSearchParams({ property_id: String(propertyId) });
  if (type) query.set('type', type);
  return await fetchJson<CustomCategory[]>(`${API_BASE}/categories/custom?${query.toString()}`);
}

export async function createCustomCategoryApi(data: {
  property_id: number;
  code?: string;
  name: string;
  transaction_type: TransactionType;
  department_code?: string;
}): Promise<CustomCategory> {
  return await fetchJson<CustomCategory>(`${API_BASE}/categories/custom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

export async function toggleCustomCategoryApi(
  code: string,
  propertyId: number,
  actorName?: string
): Promise<CustomCategory> {
  return await fetchJson<CustomCategory>(`${API_BASE}/categories/custom/${code}/toggle`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ property_id: propertyId, actor_name: actorName })
  });
}

// Transaction-2D Dedicated Creation APIs
export async function createPurchaseTransactionApi(data: {
  property_id: number;
  transaction_date?: string;
  category_code?: string;
  category_name?: string;
  department_code?: string;
  supplier_id?: number | string | null;
  supplier_name?: string | null;
  supplier_phone?: string | null;
  supplier_bank_name?: string | null;
  supplier_bank_account?: string | null;
  supplier_address?: string | null;
  source_reference?: string | null;
  receiving_status?: ReceivingStatus;
  received_at?: string | null;
  description?: string;
  lines: TransactionLineInput[];
  discount_amount?: number;
  transaction_discount?: number;
  rounding_amount?: number;
  is_immediately_paid?: boolean;
  payment_method?: string | null;
  paid_amount?: number;
  notes?: string | null;
  actor_name?: string | null;
  actor_user_id?: string | null;
}): Promise<TransactionRecord> {
  return await fetchJson<TransactionRecord>(`${API_BASE}/purchases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

export async function createExpenseTransactionApi(data: {
  property_id: number;
  transaction_date?: string;
  category_code: string;
  category_name?: string;
  department_code?: string;
  supplier_id?: number | string | null;
  party_name?: string | null;
  description: string;
  amount: number;
  payment_method?: string | null;
  source_reference?: string | null;
  is_paid?: boolean;
  notes?: string | null;
  actor_name?: string | null;
  actor_user_id?: string | null;
}): Promise<TransactionRecord> {
  return await fetchJson<TransactionRecord>(`${API_BASE}/expenses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

export async function createIncomeTransactionApi(data: {
  property_id: number;
  transaction_date?: string;
  category_code?: string;
  category_name?: string;
  department_code?: string;
  customer_name?: string;
  party_name?: string;
  phone?: string | null;
  description: string;
  amount: number;
  payment_method: string;
  source_reference?: string | null;
  lines?: TransactionLineInput[];
  notes?: string | null;
  actor_name?: string | null;
  actor_user_id?: string | null;
}): Promise<TransactionRecord> {
  return await fetchJson<TransactionRecord>(`${API_BASE}/incomes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

export async function verifyTransactionApi(
  id: number | string,
  data: {
    property_id: number;
    verification_status: VerificationStatus;
    verification_note?: string | null;
    actor_name?: string | null;
    actor_user_id?: string | null;
  }
): Promise<TransactionRecord> {
  return await fetchJson<TransactionRecord>(`${API_BASE}/${id}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

export async function updatePurchaseReceivingStatusApi(
  id: number | string,
  propertyId: number,
  data: {
    receiving_status: ReceivingStatus;
    received_at?: string | null;
    actor_name?: string | null;
  }
): Promise<TransactionRecord> {
  return await fetchJson<TransactionRecord>(`${API_BASE}/${id}/receiving`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ property_id: propertyId, ...data })
  });
}

export async function settleTransactionPaymentApi(
  id: number | string,
  propertyId: number,
  data: {
    amount: number;
    payment_method: string;
    notes?: string | null;
    actor_name?: string | null;
  }
): Promise<TransactionRecord> {
  return await fetchJson<TransactionRecord>(`${API_BASE}/${id}/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ property_id: propertyId, ...data })
  });
}

export async function createManualTransactionApi(data: {
  property_id: number;
  transaction_type: TransactionType;
  category_code: string;
  category_name?: string;
  department_code?: string;
  description: string;
  amount: number;
  party_name?: string;
  source_reference?: string;
  payment_method?: string;
  notes?: string;
  actor_name?: string;
}): Promise<TransactionRecord> {
  return await fetchJson<TransactionRecord>(`${API_BASE}/manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

export async function voidTransactionApi(
  id: number | string,
  propertyId: number,
  reason: string,
  actorName?: string
): Promise<{ original: TransactionRecord; reversal: TransactionRecord }> {
  return await fetchJson<{ original: TransactionRecord; reversal: TransactionRecord }>(`${API_BASE}/${id}/void`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      property_id: propertyId,
      reason,
      actor_name: actorName || 'Staff'
    })
  });
}

export async function uploadTransactionAttachmentApi(
  transactionId: number | string,
  propertyId: number,
  file: File,
  purposeOrActor?: AttachmentPurpose | string,
  actorName?: string
): Promise<any> {
  const isPurpose = purposeOrActor && ['RECEIPT', 'PAYMENT_PROOF', 'INVOICE', 'OTHER'].includes(purposeOrActor);
  const purpose: AttachmentPurpose = isPurpose ? (purposeOrActor as AttachmentPurpose) : 'RECEIPT';
  const effectiveActor = isPurpose ? actorName : (purposeOrActor || actorName);

  const formData = new FormData();
  formData.append('file', file);
  formData.append('property_id', String(propertyId));
  formData.append('attachment_purpose', purpose);
  if (effectiveActor) {
    formData.append('actor_name', effectiveActor);
  }

  const res = await fetch(`${API_BASE}/${transactionId}/attachments`, {
    method: 'POST',
    body: formData
  });

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('Respon server bukan format JSON yang valid.');
  }

  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Gagal mengunggah bukti transaksi');
  }
  return json.data;
}

export async function deleteTransactionAttachmentApi(
  transactionId: number | string,
  attachmentId: number | string,
  propertyId: number,
  actorName?: string
): Promise<boolean> {
  const query = new URLSearchParams({
    property_id: String(propertyId),
    actor_name: actorName || 'Staff'
  });
  return await fetchJson<boolean>(`${API_BASE}/${transactionId}/attachments/${attachmentId}?${query.toString()}`, {
    method: 'DELETE'
  });
}

export async function softDeleteTransactionApi(
  id: number | string,
  payload: {
    property_id: number;
    delete_reason: string;
    actor_name?: string;
    actor_user_id?: string;
  }
): Promise<TransactionRecord> {
  return await fetchJson<TransactionRecord>(`${API_BASE}/${id}/soft-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}
