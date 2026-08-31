export interface OtaSource {
  id: number;
  property_id: number;
  code: string;
  name: string;
  description?: string | null;
  commission_rate_percent?: number | null;
  is_active: boolean;
  is_archived: boolean;
  display_order: number;
  created_at: string;
  updated_at: string;
}

export interface CreateOtaSourceInput {
  property_id: number;
  code: string;
  name: string;
  description?: string | null;
  commission_rate_percent?: number | null;
  display_order?: number;
  is_active?: boolean;
}

export interface UpdateOtaSourceInput {
  name?: string;
  description?: string | null;
  commission_rate_percent?: number | null;
  is_active?: boolean;
  is_archived?: boolean;
  display_order?: number;
}

