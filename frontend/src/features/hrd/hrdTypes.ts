export interface Department {
  id: number;
  property_id: number;
  code: string;
  name: string;
  description?: string;
  is_active: boolean;
  sort_order: number;
  employee_count?: number;
  created_at?: string;
  updated_at?: string;
}

export interface Position {
  id: number;
  property_id: number;
  department_id: number;
  department_name?: string;
  department_code?: string;
  name: string;
  code?: string;
  description?: string;
  is_active: boolean;
  sort_order: number;
  employee_count?: number;
  created_at?: string;
  updated_at?: string;
}

export interface DynamicRole {
  id: number;
  property_id: number | null;
  name: string;
  description?: string;
  is_system_role: boolean;
  is_active: boolean;
  sort_order: number;
  user_count?: number;
  permissions_count?: number;
  created_at?: string;
  updated_at?: string;
}

export interface GranularPermission {
  id: number;
  resource: string;
  action: string;
  key: string;
  description?: string;
  is_system: boolean;
  created_at?: string;
}

export interface GranularMatrixResponse {
  roles: DynamicRole[];
  permissions: GranularPermission[];
  matrix: Record<number, Record<string, boolean>>;
}
