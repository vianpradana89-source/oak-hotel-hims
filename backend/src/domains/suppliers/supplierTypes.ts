export type SupplierEntityType = 'SUPPLIER' | 'VENDOR' | 'BOTH';
export type SupplierStatus = 'ACTIVE' | 'INACTIVE' | 'BLACKLISTED';

export interface SupplierRow {
  id: string; // BIGINT string from pg
  property_id: number;
  code: string | null;
  name: string;
  legal_name: string | null;
  entity_type: SupplierEntityType;
  category: string | null;
  contact_person: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  tax_id: string | null;
  bank_name: string | null;
  bank_account: string | null;
  bank_holder: string | null;
  payment_terms_days: number | null;
  default_department_code: string | null;
  status: SupplierStatus;
  notes: string | null;
  is_active: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CreateSupplierDto {
  property_id: number;
  code?: string | null;
  name: string;
  legal_name?: string | null;
  entity_type?: SupplierEntityType;
  category?: string | null;
  contact_person?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  province?: string | null;
  tax_id?: string | null;
  bank_name?: string | null;
  bank_account?: string | null;
  bank_holder?: string | null;
  payment_terms_days?: number | null;
  default_department_code?: string | null;
  status?: SupplierStatus;
  notes?: string | null;
  is_active?: boolean;
  actor_name?: string | null;
  created_by?: string | null;
}

export interface UpdateSupplierDto {
  code?: string | null;
  name?: string;
  legal_name?: string | null;
  entity_type?: SupplierEntityType;
  category?: string | null;
  contact_person?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  province?: string | null;
  tax_id?: string | null;
  bank_name?: string | null;
  bank_account?: string | null;
  bank_holder?: string | null;
  payment_terms_days?: number | null;
  default_department_code?: string | null;
  status?: SupplierStatus;
  notes?: string | null;
  is_active?: boolean;
  actor_name?: string | null;
  updated_by?: string | null;
}

export interface SupplierQueryParams {
  property_id: number;
  search?: string;
  entity_type?: SupplierEntityType | string;
  category?: string;
  status?: SupplierStatus | string;
  is_active?: boolean;
  include_deleted?: boolean;
  limit?: number;
  offset?: number;
}

