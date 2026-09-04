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
  user_id?: number | null;
  account_status?: string | null;
  user_is_active?: boolean | null;
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
  create_login_account?: boolean;
}

export type DiagnosisState =
  | 'NO_ACCOUNT'
  | 'LINKED_OK'
  | 'UNLINKED_MATCH_FOUND'
  | 'AMBIGUOUS_MATCH'
  | 'EMAIL_MISMATCH'
  | 'USERNAME_MISMATCH'
  | 'PROPERTY_MISMATCH'
  | 'ROLE_MISMATCH'
  | 'ACCOUNT_DISABLED'
  | 'EMPLOYEE_DISABLED'
  | 'PASSWORD_RESET_AVAILABLE'
  | 'ACCOUNT_NOT_READY';

export interface CandidateUser {
  id: number;
  property_id: number;
  username: string;
  email: string;
  full_name: string;
  is_active: boolean;
  role_name?: string;
  account_status?: string;
  employee_id?: number | null;
}

export interface LoginAccountDiagnosis {
  employee_id: number;
  employee_name: string;
  employee_code: string;
  employee_email: string | null;
  employee_username: string | null;
  employee_role: string;
  employee_active: boolean;
  linked_user_id: number | null;
  login_email: string | null;
  username: string | null;
  account_status: string | null;
  is_active: boolean | null;
  must_change_password: boolean | null;
  role_name: string | null;
  temp_password_expires_at: string | null;
  diagnosis_state: DiagnosisState;
  diagnosis_states: DiagnosisState[];
  candidate_user?: CandidateUser | null;
  mismatch_reasons: string[];
}

export type AccountRepairAction =
  | 'LINK_UNAMBIGUOUS_ACCOUNT'
  | 'SYNC_LOGIN_EMAIL'
  | 'SYNC_USERNAME'
  | 'SYNC_ROLE'
  | 'REACTIVATE_ACCOUNT';

export interface AccountRepairActionPayload {
  action: AccountRepairAction;
  target_user_id?: number;
  reason?: string;
}

export interface CreateEmployeeResult extends HrEmployee {
  auth_account_created: boolean;
  user_id?: number | null;
  temporary_password?: string;
  temp_password_expires_at?: string;
}

export interface PasswordResetResult {
  employee_id: number;
  user_id: number;
  username: string;
  email: string;
  phone?: string | null;
  temporary_password: string;
  temp_password_expires_at: string;
  must_change_password: boolean;
  account_status: string;
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

export interface DeactivateEmployeePayload {
  reason?: string;
  effective_date?: string;
}

export interface HardDeleteLoginAccountPayload {
  confirm_identity: string;
}
