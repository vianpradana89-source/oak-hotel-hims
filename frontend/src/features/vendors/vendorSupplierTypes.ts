import type {
  Supplier,
  SupplierEntityType,
  SupplierStatus
} from '../transactions/transactionDomainTypes';

export type { Supplier, SupplierEntityType, SupplierStatus };

export type EntityTypeFilter = 'ALL' | SupplierEntityType;
export type StatusFilter = 'ALL' | SupplierStatus;

export interface VendorSupplierFilterState {
  search: string;
  entityType: EntityTypeFilter;
  status: StatusFilter;
  category: string;
}

export interface VendorSupplierFormData {
  id?: string | number;
  property_id: number;
  entity_type: SupplierEntityType;
  code?: string;
  name: string;
  legal_name?: string;
  category?: string;
  contact_person?: string;
  phone?: string;
  whatsapp?: string;
  email?: string;
  address?: string;
  city?: string;
  province?: string;
  tax_id?: string;
  bank_name?: string;
  bank_account?: string;
  bank_holder?: string;
  payment_terms_days?: number;
  default_department_code?: string;
  status: SupplierStatus;
  notes?: string;
}

export interface VendorSupplierStats {
  total: number;
  supplierCount: number;
  vendorCount: number;
  bothCount: number;
  activeCount: number;
  inactiveCount: number;
  blacklistedCount: number;
}
