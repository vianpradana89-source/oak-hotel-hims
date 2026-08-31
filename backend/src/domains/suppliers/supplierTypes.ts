export interface SupplierRow {
  id: string; // BIGINT string from pg
  property_id: number;
  name: string;
  phone: string | null;
  bank_name: string | null;
  bank_account: string | null;
  address: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateSupplierDto {
  property_id: number;
  name: string;
  phone?: string | null;
  bank_name?: string | null;
  bank_account?: string | null;
  address?: string | null;
  actor_name?: string | null;
}

export interface UpdateSupplierDto {
  name?: string;
  phone?: string | null;
  bank_name?: string | null;
  bank_account?: string | null;
  address?: string | null;
  is_active?: boolean;
  actor_name?: string | null;
}

export interface SupplierQueryParams {
  property_id: number;
  search?: string;
  is_active?: boolean;
}
