import { authenticatedFetch } from '../../lib/authenticatedFetch';

export type GuestCommunicationScope =
  | 'STAY_OPERATIONAL'
  | 'CRM_CAMPAIGN'
  | 'BIRTHDAY'
  | 'POST_STAY'
  | 'PROMOTION';

export type GuestCommunicationCategory =
  | 'CHECKOUT_REMINDER'
  | 'DINNER_PROMO'
  | 'BREAKFAST_INFO'
  | 'LAUNDRY_PROMO'
  | 'LATE_CHECKOUT'
  | 'BIRTHDAY'
  | 'PROMOTION'
  | 'POST_STAY'
  | 'CUSTOM';

export type GuestCommunicationStatus =
  | 'INITIATED'
  | 'OPENED_WHATSAPP';

export interface GuestCommunicationTemplate {
  id: number;
  property_id: number;
  code: string;
  name: string;
  channel: 'WHATSAPP';
  scope: GuestCommunicationScope;
  category: GuestCommunicationCategory;
  message_body: string;
  allowed_reservation_statuses: string[];
  template_variables: string[];
  is_active: boolean;
  display_order: number;
  created_by_user_id: number | null;
  updated_by_user_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface GuestCommunicationTemplateInput {
  code: string;
  name: string;
  scope: GuestCommunicationScope;
  category: GuestCommunicationCategory;
  message_body: string;
  allowed_reservation_statuses?: string[];
  template_variables?: string[];
  display_order?: number;
  is_active?: boolean;
}

export interface GuestCommunicationLog {
  id: string;
  property_id: number;
  guest_id: number;
  guest_name_snapshot: string;
  destination_snapshot: string;
  reservation_id: number | null;
  template_id: number;
  template_code_snapshot: string;
  template_name_snapshot: string;
  channel: 'WHATSAPP';
  scope: GuestCommunicationScope;
  category: GuestCommunicationCategory;
  message_snapshot: string;
  status: GuestCommunicationStatus;
  initiated_by_user_id: number | null;
  initiated_by_name_snapshot: string | null;
  initiated_by_role_snapshot: string | null;
  correlation_id: string;
  metadata: Record<string, unknown>;
  initiated_at: string;
}

interface ApiSuccess<T> {
  success: true;
  data: T;
}

interface ApiError {
  success?: false;
  code?: string;
  message?: string;
}

async function request<T>(
  url: string,
  init?: RequestInit,
  fallbackMessage = 'Permintaan komunikasi tamu gagal.'
): Promise<T> {
  const response = await authenticatedFetch(url, init);
  const payload = await response.json().catch(() => null) as ApiSuccess<T> | ApiError | null;

  if (!response.ok || !payload || payload.success !== true) {
    throw new Error(
      payload && 'message' in payload && payload.message
        ? payload.message
        : fallbackMessage
    );
  }

  return payload.data;
}

export function listGuestCommunicationTemplates(
  propertyId: number
): Promise<GuestCommunicationTemplate[]> {
  return request(
    `/api/guests/communication-templates?property_id=${propertyId}`,
    undefined,
    'Template komunikasi tamu gagal dimuat.'
  );
}

export function createGuestCommunicationTemplate(
  propertyId: number,
  input: GuestCommunicationTemplateInput
): Promise<GuestCommunicationTemplate> {
  return request(
    `/api/guests/communication-templates?property_id=${propertyId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    'Template komunikasi tamu gagal dibuat.'
  );
}

export function updateGuestCommunicationTemplate(
  propertyId: number,
  templateId: number,
  input: Partial<GuestCommunicationTemplateInput>
): Promise<GuestCommunicationTemplate> {
  return request(
    `/api/guests/communication-templates/${templateId}?property_id=${propertyId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    'Template komunikasi tamu gagal diperbarui.'
  );
}

export interface PrepareWhatsAppInput {
  guest_id: number;
  reservation_id: number | null;
  template_id: number;
  metadata?: Record<string, unknown>;
}

export interface PrepareWhatsAppResult {
  log: GuestCommunicationLog;
  rendered_message: string;
  normalized_destination: string;
  whatsapp_deep_link: string;
}

export function prepareGuestWhatsApp(
  propertyId: number,
  input: PrepareWhatsAppInput
): Promise<PrepareWhatsAppResult> {
  return request(
    `/api/guests/communications/prepare-whatsapp?property_id=${propertyId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    'Pesan WhatsApp tamu gagal disiapkan.'
  );
}

export function markGuestWhatsAppOpened(
  propertyId: number,
  communicationId: string | number
): Promise<GuestCommunicationLog> {
  return request(
    `/api/guests/communications/${communicationId}/opened-whatsapp?property_id=${propertyId}`,
    { method: 'POST' },
    'Status pembukaan WhatsApp gagal diperbarui.'
  );
}

export interface GuestCommunicationHistoryResult {
  data: GuestCommunicationLog[];
  total: number;
  limit: number;
  offset: number;
}

export function getGuestCommunicationHistory(
  propertyId: number,
  params: {
    guest_id?: number;
    reservation_id?: number;
    template_id?: number;
    status?: GuestCommunicationStatus;
    limit?: number;
    offset?: number;
  } = {}
): Promise<GuestCommunicationHistoryResult> {
  const query = new URLSearchParams({
    property_id: String(propertyId),
  });

  if (params.guest_id != null) query.set('guest_id', String(params.guest_id));
  if (params.reservation_id != null) query.set('reservation_id', String(params.reservation_id));
  if (params.template_id != null) query.set('template_id', String(params.template_id));
  if (params.status) query.set('status', params.status);
  if (params.limit != null) query.set('limit', String(params.limit));
  if (params.offset != null) query.set('offset', String(params.offset));

  return request(
    `/api/guests/communication-history?${query.toString()}`,
    undefined,
    'Riwayat komunikasi tamu gagal dimuat.'
  );
}