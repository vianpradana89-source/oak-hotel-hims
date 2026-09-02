export type DepositStatus = 'RECEIVED' | 'PARTIALLY_USED' | 'CLOSED' | 'CANCELLED';
export type DepositEventType = 'RECEIVED' | 'APPLY' | 'REFUND' | 'REVERSAL';
export type IdentityDocumentType = 'KTP' | 'SIM' | 'PASSPORT' | 'OTHER';

export interface DepositBalance {
  effective_received: number;
  applied: number;
  refunded: number;
  reversed_received: number;
  remaining: number;
  status: DepositStatus;
}

export interface DepositEvent {
  id: number;
  deposit_id: number;
  event_type: DepositEventType;
  amount: number;
  performed_by: string;
  notes?: string | null;
  created_at: string;
  reversed_event_type?: string | null;
}

export interface Deposit {
  id: number;
  property_id: number;
  reservation_id: number;
  deposit_number: string;
  original_amount: number;
  payment_method: string;
  status: DepositStatus;
  received_by: string;
  notes?: string | null;
  created_at: string;
  updated_at: string;
  events: DepositEvent[];
  balance: DepositBalance;
}

export interface IdentityCustodyRecord {
  id: number;
  property_id: number;
  reservation_id: number;
  document_type: IdentityDocumentType;
  document_holder_name: string;
  document_number_masked?: string | null;
  status: 'HELD' | 'RETURNED';
  received_by: string;
  storage_location?: string | null;
  notes?: string | null;
  returned_by?: string | null;
  returned_at?: string | null;
  created_at: string;
  updated_at: string;
}

const AUTH_TOKEN_KEY = 'oak_hims_auth_token';
function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${localStorage.getItem(AUTH_TOKEN_KEY) || ''}` };
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json();
  if (!res.ok) {
    if (res.status === 401) throw new Error('Sesi login telah berakhir. Silakan login kembali.');
    if (res.status === 403) throw new Error(json?.message || 'Anda tidak memiliki izin untuk melakukan tindakan ini.');
    throw new Error(json?.message || `Request failed (${res.status})`);
  }
  return json.data ?? json;
}

export const depositApi = {
  list: (reservationId: number, propertyId: number) =>
    apiFetch<Deposit[]>(
      `/api/reservations/${reservationId}/deposits?property_id=${propertyId}`,
      { headers: authHeaders() }
    ),

  receive: (data: {
    property_id: number; reservation_id: number; amount: number;
    payment_method: string; idempotency_key: string; notes?: string;
    file?: File; evidence_note?: string;
  }) => {
    const fd = new FormData();
    fd.append('property_id', String(data.property_id));
    fd.append('reservation_id', String(data.reservation_id));
    fd.append('amount', String(data.amount));
    fd.append('payment_method', data.payment_method);
    fd.append('idempotency_key', data.idempotency_key);
    if (data.notes) fd.append('notes', data.notes);
    if (data.file) fd.append('file', data.file);
    if (data.evidence_note) fd.append('evidence_note', data.evidence_note);
    return apiFetch<any>('/api/deposits', {
      method: 'POST', body: fd, headers: authHeaders(),
    });
  },

  apply: (depositId: number, data: {
    property_id: number; reservation_id: number; amount: number;
    idempotency_key: string; notes?: string;
  }) =>
    apiFetch<any>(`/api/deposits/${depositId}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(data),
    }),

  refund: (depositId: number, data: {
    property_id: number; reservation_id: number; amount: number;
    payment_method: string; idempotency_key: string; notes?: string;
    file?: File; evidence_note?: string;
  }) => {
    const fd = new FormData();
    fd.append('property_id', String(data.property_id));
    fd.append('reservation_id', String(data.reservation_id));
    fd.append('amount', String(data.amount));
    fd.append('payment_method', data.payment_method);
    fd.append('idempotency_key', data.idempotency_key);
    if (data.notes) fd.append('notes', data.notes);
    if (data.file) fd.append('file', data.file);
    if (data.evidence_note) fd.append('evidence_note', data.evidence_note);
    return apiFetch<any>(`/api/deposits/${depositId}/refund`, {
      method: 'POST', body: fd, headers: authHeaders(),
    });
  },

  reverse: (depositId: number, data: {
    property_id: number; reservation_id: number;
    idempotency_key: string; reason: string;
  }) =>
    apiFetch<any>(`/api/deposits/${depositId}/reverse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(data),
    }),
};

export const identityCustodyApi = {
  list: (reservationId: number, propertyId: number) =>
    apiFetch<IdentityCustodyRecord[]>(
      `/api/reservations/${reservationId}/identity-custody?property_id=${propertyId}`,
      { headers: authHeaders() }
    ),

  hold: (data: {
    property_id: number; reservation_id: number;
    document_type: IdentityDocumentType; document_holder_name: string;
    storage_location?: string; notes?: string;
  }) =>
    apiFetch<IdentityCustodyRecord>('/api/identity-custody', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(data),
    }),

  returnDoc: (custodyId: number, propertyId: number) =>
    apiFetch<IdentityCustodyRecord>(`/api/identity-custody/${custodyId}/return`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ property_id: propertyId }),
    }),
};
