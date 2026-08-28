export interface HrEmployee {
  id: number;
  property_id: number;
  employee_code: string;
  full_name: string;
  position?: string | null;
  department?: string | null;
  role: string;
  username?: string | null;
  email?: string | null;
  phone?: string | null;
  hire_date?: string | null;
  monthly_salary?: number;
  status: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface HrdRolePolicySettings {
  id?: number;
  property_id: number;
  allow_hrd_assign_owner_role: boolean;
  allow_hrd_assign_gm_role: boolean;
  allow_hrd_assign_dept_manager_role: boolean;
  allow_hrd_assign_accountant_role: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface CreateEmployeePayload {
  property_id: number;
  employee_code?: string;
  full_name: string;
  position?: string;
  department?: string;
  role?: string;
  username?: string;
  email?: string;
  phone?: string;
  hire_date?: string;
  monthly_salary?: number;
  status?: string;
}

export interface UpdateEmployeePayload {
  employee_code?: string;
  full_name?: string;
  position?: string;
  department?: string;
  role?: string;
  username?: string;
  email?: string;
  phone?: string;
  hire_date?: string;
  monthly_salary?: number;
  status?: string;
  is_active?: boolean;
}

export interface RoleCategoryDef {
  key: string;
  label: string;
  department: string;
  is_privileged: boolean;
  description: string;
}

export const STANDARD_ROLE_CATEGORIES: RoleCategoryDef[] = [
  { key: 'Crew', label: 'Crew / Staff Operasional', department: 'Operations', is_privileged: false, description: 'Staf pelaksana harian (Housekeeping, F&B, Service)' },
  { key: 'Head Department / Supervisor', label: 'Head Department / Supervisor', department: 'Management', is_privileged: false, description: 'Penyelia & kepala departemen operasional' },
  { key: 'Department Manager', label: 'Department Manager', department: 'Management', is_privileged: false, description: 'Manajer divisi operasional' },
  { key: 'Accountant', label: 'Accountant / Pembukuan', department: 'Finance', is_privileged: false, description: 'Akuntan & pembukuan keuangan hotel' },
  { key: 'Front Office / Receptionist', label: 'Front Office / Receptionist', department: 'Front Office', is_privileged: false, description: 'Resepsionis & layanan tamu depan' },
  { key: 'Cashier / POS', label: 'Cashier / POS', department: 'F&B', is_privileged: false, description: 'Kasir outlet F&B dan POS restoran' },
  { key: 'Purchasing Staff', label: 'Purchasing Staff', department: 'Purchasing', is_privileged: false, description: 'Pengadaan barang dan logistik inventaris' },
  { key: 'Finance Staff', label: 'Finance Staff', department: 'Finance', is_privileged: false, description: 'Staf kasir kantor & administrasi keuangan' },
  { key: 'HRD Staff', label: 'HRD Staff', department: 'HRD', is_privileged: false, description: 'Staf personalia dan administrasi karyawan' },
  { key: 'GA / Maintenance Staff', label: 'GA / Maintenance Staff', department: 'Maintenance', is_privileged: false, description: 'Teknisi fasilitas dan pemeliharaan gedung' }
];

export const PRIVILEGED_ROLE_CATEGORIES: RoleCategoryDef[] = [
  { key: 'General Manager', label: 'General Manager (GM)', department: 'Executive', is_privileged: true, description: 'Pimpinan tertinggi operasional hotel' },
  { key: 'Owner', label: 'Owner / Direksi Properti', department: 'Executive', is_privileged: true, description: 'Pemilik properti atau dewan komisaris/direksi' }
];
