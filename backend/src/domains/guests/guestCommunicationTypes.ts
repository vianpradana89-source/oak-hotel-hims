/**
 * Guest Communication Domain — types.
 *
 * Matches the tables guest_communication_templates & guest_communication_logs
 * as defined by the guest_communication_v1 migration.
 */

// ─── Enums (literal union, values are DB VARCHAR literals) ────────────────────

export type GuestCommunicationChannel = 'WHATSAPP';

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

export type GuestCommunicationStatus = 'INITIATED' | 'OPENED_WHATSAPP';

// ─── Row shapes ──────────────────────────────────────────────────────────────

export interface GuestCommunicationTemplate {
  id: number;
  property_id: number;
  code: string;
  name: string;
  channel: GuestCommunicationChannel;
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

export interface GuestCommunicationLog {
  id: number;
  property_id: number;
  guest_id: number | null;
  guest_name_snapshot: string;
  destination_snapshot: string;
  reservation_id: number | null;
  template_id: number | null;
  template_code_snapshot: string | null;
  template_name_snapshot: string | null;
  channel: GuestCommunicationChannel;
  scope: GuestCommunicationScope;
  category: GuestCommunicationCategory;
  message_snapshot: string;
  status: GuestCommunicationStatus;
  initiated_by_user_id: number | null;
  initiated_by_name_snapshot: string | null;
  initiated_by_role_snapshot: string | null;
  correlation_id: string | null;
  metadata: Record<string, unknown> | null;
  initiated_at: string;
}

// ─── Input DTOs ──────────────────────────────────────────────────────────────

export interface GuestCommunicationTemplateCreateInput {
  property_id: number;
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

export interface GuestCommunicationTemplateUpdateInput {
  code?: string;
  name?: string;
  scope?: GuestCommunicationScope;
  category?: GuestCommunicationCategory;
  message_body?: string;
  allowed_reservation_statuses?: string[];
  template_variables?: string[];
  display_order?: number;
  is_active?: boolean;
}

export interface PrepareCommunicationInput {
  property_id: number;
  guest_id: number;
  reservation_id?: number | null;
  template_id: number;
  metadata?: Record<string, unknown>;
}

// ─── Output shapes ───────────────────────────────────────────────────────────

export interface PrepareCommunicationResult {
  log: GuestCommunicationLog;
  rendered_message: string;
  normalized_destination: string;
  whatsapp_deep_link: string;
}

export interface CommunicationHistoryFilters {
  property_id: number;
  guest_id?: number | null;
  reservation_id?: number | null;
  template_id?: number | null;
  status?: GuestCommunicationStatus | null;
  limit: number;
  offset: number;
}

export interface CommunicationHistoryResponse {
  data: GuestCommunicationLog[];
  total: number;
  limit: number;
  offset: number;
}

export interface ActorSnapshot {
  userId: number;
  name: string;
  role: string;
}

// ─── Template variable placeholders ──────────────────────────────────────────

export const ALLOWED_TEMPLATE_VARIABLES = new Set<string>([
  'guest_name',
  'guest_full_name',
  'reservation_id',
  'property_name',
  'check_in_date',
  'check_out_date',
  'room_type',
  'room_number',
]);
