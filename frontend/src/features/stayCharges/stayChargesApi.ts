import type {
  StayChargeRule,
  CreateStayChargeRuleDto,
  UpdateStayChargeRuleDto,
  PostStayChargeDto,
  VoidFolioEntryDto,
  CorrectFolioEntryDto
} from './stayChargesTypes';
import { authenticatedFetch } from '../../lib/authenticatedFetch';
import {
  normalizeStayChargeRule,
  parseStayChargeResponse,
  toStayChargeWritePayload
} from './stayChargeFieldMap';

const API_BASE = '/api/stay-charges';

function unwrapRule(json: any): StayChargeRule {
  return normalizeStayChargeRule(json?.data || json);
}

export async function fetchStayChargeRules(
  propertyId: number,
  options?: { chargeType?: string; includeArchived?: boolean }
): Promise<StayChargeRule[]> {
  const params = new URLSearchParams({
    property_id: String(propertyId),
    ...(options?.chargeType ? { charge_type: options.chargeType } : {}),
    ...(options?.includeArchived ? { include_archived: 'true' } : {})
  });

  const res = await authenticatedFetch(`${API_BASE}/rules?${params.toString()}`);
  const json = await parseStayChargeResponse(res, 'Gagal memuat aturan stay charge');
  const rows = Array.isArray(json) ? json : (json?.data || []);
  return rows.map(normalizeStayChargeRule);
}

export async function createStayChargeRule(
  dto: CreateStayChargeRuleDto
): Promise<StayChargeRule> {
  const res = await authenticatedFetch(`${API_BASE}/rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toStayChargeWritePayload(dto))
  });
  const json = await parseStayChargeResponse(res, 'Gagal membuat aturan stay charge');
  return unwrapRule(json);
}

export async function updateStayChargeRule(
  id: number,
  dto: UpdateStayChargeRuleDto
): Promise<StayChargeRule> {
  const res = await authenticatedFetch(`${API_BASE}/rules/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toStayChargeWritePayload(dto))
  });
  const json = await parseStayChargeResponse(res, 'Gagal memperbarui aturan stay charge');
  return unwrapRule(json);
}

export async function deleteStayChargeRule(
  id: number,
  propertyId: number,
  hard: boolean = false
): Promise<{ success: boolean; message: string }> {
  const params = new URLSearchParams({
    property_id: String(propertyId),
    ...(hard ? { hard: 'true' } : {})
  });
  const res = await authenticatedFetch(`${API_BASE}/rules/${id}?${params.toString()}`, {
    method: 'DELETE'
  });
  const json = await parseStayChargeResponse(res, 'Gagal menghapus aturan stay charge');
  return json?.data || json;
}

export async function postStayChargeToFolio(
  dto: PostStayChargeDto
): Promise<{ folio_entry: any; reservation: any }> {
  const res = await authenticatedFetch(`${API_BASE}/post-charge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dto)
  });
  const json = await parseStayChargeResponse(res, 'Gagal memposting biaya ke folio');
  return json.data || json;
}

export async function voidFolioEntry(
  id: number,
  dto: VoidFolioEntryDto
): Promise<{ folio_entry: any; reservation: any; reversal_entry: any }> {
  const res = await authenticatedFetch(`${API_BASE}/void-entry/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...dto, reason: dto.void_reason })
  });
  const json = await parseStayChargeResponse(res, 'Gagal membatalkan entry folio');
  return json.data || json;
}

export async function correctFolioEntry(
  id: number,
  dto: CorrectFolioEntryDto
): Promise<{
  original_entry: any;
  reversal_entry: any;
  replacement_entry: any;
  reservation: any;
}> {
  const res = await authenticatedFetch(`${API_BASE}/correct-entry/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dto)
  });
  const json = await parseStayChargeResponse(res, 'Gagal mengoreksi entry folio');
  return json.data || json;
}
