import type { OtaSource, CreateOtaSourceInput, UpdateOtaSourceInput } from './otaTypes';

const API_BASE = '/api/ota-sources';

async function parseJsonResponse(res: Response, fallbackError: string): Promise<any> {
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await res.text();
    throw new Error(`${fallbackError} (Server status ${res.status}: ${text.slice(0, 100)})`);
  }
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.message || fallbackError);
  }
  return json;
}

export async function fetchOtaSources(
  propertyId: number,
  options?: { includeArchived?: boolean }
): Promise<OtaSource[]> {
  const params = new URLSearchParams({
    property_id: String(propertyId),
    ...(options?.includeArchived ? { include_archived: 'true' } : {})
  });

  const res = await fetch(`${API_BASE}?${params.toString()}`);
  const json = await parseJsonResponse(res, 'Gagal memuat daftar OTA');
  return json.data || [];
}

export async function createOtaSource(dto: CreateOtaSourceInput): Promise<OtaSource> {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dto)
  });
  const json = await parseJsonResponse(res, 'Gagal menambahkan channel OTA');
  return json.data;
}

export async function updateOtaSource(id: number, dto: UpdateOtaSourceInput): Promise<OtaSource> {
  const res = await fetch(`${API_BASE}/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dto)
  });
  const json = await parseJsonResponse(res, 'Gagal memperbarui channel OTA');
  return json.data;
}

export async function deleteOtaSource(id: number): Promise<{ action: 'DELETED' | 'ARCHIVED'; message: string }> {
  const res = await fetch(`${API_BASE}/${id}`, {
    method: 'DELETE'
  });
  const json = await parseJsonResponse(res, 'Gagal menghapus channel OTA');
  return {
    action: json.action || (json.data?.is_archived ? 'ARCHIVED' : 'DELETED'),
    message: json.message || 'Berhasil memproses sumber OTA'
  };
}

