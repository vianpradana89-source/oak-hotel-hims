import React, { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { DepartmentPositionTab } from './DepartmentPositionTab';
import { RolePermissionsTab } from './RolePermissionsTab';
import { ScheduleTab } from './ScheduleTab';
import { TestDataPurgeTab } from './TestDataPurgeTab';
import type { Department, Position, DynamicRole } from './hrdTypes';
import {
  normalizeIndonesianPhoneNumber,
  buildWhatsAppCredentialMessage,
  buildWhatsAppDeepLink,
  formatExpiryDateTime,
  getCanonicalLoginUrl
} from './whatsappUtils';

interface HrEmployee {
  id: number;
  property_id: number;
  full_name: string;
  first_name?: string;
  last_name?: string;
  employee_code?: string;
  role: string;
  role_id?: number | null;
  access_type?: string | null;
  department: string;
  department_id?: number | null;
  position?: string;
  position_id?: number | null;
  username?: string;
  email?: string;
  phone?: string;
  hire_date?: string;
  monthly_salary?: number;
  status?: string;
  is_active: boolean;
  user_id?: number | null;
  account_status?: string | null;
  user_is_active?: boolean | null;
  created_at?: string;
  updated_at?: string;
}

interface CredentialModalData {
  title: string;
  fullName: string;
  employeeCode?: string;
  email: string;
  username: string;
  phone?: string | null;
  temporaryPassword: string;
  expiresAt?: string;
  isReset?: boolean;
  employeeId?: number;
}

interface DiagnosisData {
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
  diagnosis_state: string;
  diagnosis_states: string[];
  candidate_user?: {
    id: number;
    username: string;
    email: string;
    full_name: string;
  } | null;
  mismatch_reasons: string[];
}

interface HrdWorkspaceProps {
  propertyId: number;
  propertyName?: string;
  onPermissionsUpdated?: (newMap: Record<string, string[]>) => void;
}

const getTodayCalendarDate = (): string => {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const toCalendarDateInput = (val?: string | null): string => {
  if (!val) return '';
  const str = String(val).trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : '';
};

const serializeCalendarDate = (val?: string | null): string | null => {
  if (!val) return null;
  const str = String(val).trim();
  if (!str) return null;
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : null;
};

const formatDateDisplay = (dateStr?: string | null): string => {
  if (!dateStr) return '—';
  const m = String(dateStr).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const parts = m[0].split('-');
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return String(dateStr);
};

export const HrdWorkspace: React.FC<HrdWorkspaceProps> = ({ propertyId, propertyName, onPermissionsUpdated }) => {
  const [activeTab, setActiveTab] = useState<'EMPLOYEES' | 'DEPARTMENTS_POSITIONS' | 'ROLES_PERMISSIONS' | 'JADWAL_KERJA' | 'DATA_TEST'>('EMPLOYEES');
  const [employees, setEmployees] = useState<HrEmployee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [dynamicRoles, setDynamicRoles] = useState<DynamicRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);

  const [editingEmployee, setEditingEmployee] = useState<HrEmployee | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const [formPayload, setFormPayload] = useState({
    name: '',
    username: '',
    email: '',
    phone: '',
    department_id: 0,
    department: 'Front Office',
    position_id: 0,
    position: 'Staff',
    role_id: 0,
    role: 'Front Office',
    access_type: 'PMS_STAFF' as 'PMS_STAFF' | 'MANAGER' | 'MOBILE_ONLY' | 'ADMIN',
    hire_date: getTodayCalendarDate(),
    create_login_account: true,
    is_active: true
  });

  // One-time credential modal state
  const [credentialModal, setCredentialModal] = useState<CredentialModalData | null>(null);
  const [copySuccess, setCopySuccess] = useState<string | null>(null);
  const [whatsAppError, setWhatsAppError] = useState<string | null>(null);
  const [whatsAppOpened, setWhatsAppOpened] = useState(false);

  // Diagnosis Modal state
  const [diagnosisTarget, setDiagnosisTarget] = useState<HrEmployee | null>(null);
  const [diagnosisLoading, setDiagnosisLoading] = useState(false);
  const [diagnosisData, setDiagnosisData] = useState<DiagnosisData | null>(null);
  const [diagnosisError, setDiagnosisError] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [repairNotice, setRepairNotice] = useState<string | null>(null);
  const { user: currentUser } = useAuth();
  const [employeeScopeTab, setEmployeeScopeTab] = useState<'ACTIVE' | 'ARCHIVE'>('ACTIVE');

  // Deactivation Modal state
  const [deactivateTarget, setDeactivateTarget] = useState<HrEmployee | null>(null);
  const [deactivateReason, setDeactivateReason] = useState('Resign / Pengunduran Diri');
  const [deactivateEffectiveDate, setDeactivateEffectiveDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [deactivating, setDeactivating] = useState(false);

  // Reactivation Modal state
  const [reactivateTarget, setReactivateTarget] = useState<HrEmployee | null>(null);
  const [reactivating, setReactivating] = useState(false);

  // Hard Delete Login Account Modal state (Platform Super Admin only)
  const [deleteAccountTarget, setDeleteAccountTarget] = useState<HrEmployee | null>(null);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteAccountError, setDeleteAccountError] = useState<string | null>(null);
  const [deleteAccountHistoryDetails, setDeleteAccountHistoryDetails] = useState<string[]>([]);

  const isPlatformSuperAdmin = currentUser?.role === 'Super Admin';

  const [hardDeleteTarget, setHardDeleteTarget] = useState<HrEmployee | null>(null);
  const [hardDeleting, setHardDeleting] = useState(false);
  const [hardDeleteError, setHardDeleteError] = useState<string | null>(null);

  const handleExecuteHardDeleteEmployee = async () => {
    if (!hardDeleteTarget) return;
    setHardDeleting(true);
    setHardDeleteError(null);
    try {
      const res = await fetch(`/api/hrd/employees/${hardDeleteTarget.id}/hard-delete?property_id=${propertyId}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Gagal menghapus karyawan');
      }
      setHardDeleteTarget(null);
      await fetchData();
    } catch (err: any) {
      setHardDeleteError(err.message || 'Gagal menghapus karyawan');
    } finally {
      setHardDeleting(false);
    }
  };

  const getAuthHeaders = (): HeadersInit => {
    const token = localStorage.getItem('oak_hims_auth_token');
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
  };

  const fetchData = async () => {
    try {
      setLoading(true);
      const [empRes, deptRes, posRes, dynRolesRes] = await Promise.all([
        fetch(`/api/hrd/employees?property_id=${propertyId}&scope=all`, { headers: getAuthHeaders() }),
        fetch(`/api/hrd/departments?property_id=${propertyId}&include_inactive=false`, { headers: getAuthHeaders() }),
        fetch(`/api/hrd/positions?property_id=${propertyId}&include_inactive=false`, { headers: getAuthHeaders() }),
        fetch(`/api/hrd/dynamic-roles?property_id=${propertyId}&include_inactive=false`, { headers: getAuthHeaders() })
      ]);

      const [empData, deptData, posData, dynRolesData] = await Promise.all([
        empRes.json(),
        deptRes.json(),
        posRes.json(),
        dynRolesRes.json()
      ]);

      if (empData.status === 'OK' && Array.isArray(empData.data)) {
        setEmployees(empData.data);
      } else {
        const fallbackRes = await fetch(`/api/hrd/employees?property_id=${propertyId}`, { headers: getAuthHeaders() });
        const fallbackData = await fallbackRes.json();
        if (fallbackData.status === 'OK') setEmployees(fallbackData.data || []);
      }

      if (deptData.status === 'OK' && Array.isArray(deptData.data)) {
        setDepartments(deptData.data);
      }

      if (posData.status === 'OK' && Array.isArray(posData.data)) {
        setPositions(posData.data);
      }

      if (dynRolesData.status === 'OK' && Array.isArray(dynRolesData.data)) {
        setDynamicRoles(dynRolesData.data);
      }
    } catch (err: any) {
      console.error('Failed to load HRD data', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [propertyId]);

  const handleOpenAdd = () => {
    setErrorMessage('');
    const defaultDept = departments.find(d => d.is_active) || departments[0];
    const deptId = defaultDept ? defaultDept.id : 0;
    const deptPositions = positions.filter(p => p.department_id === deptId && p.is_active);
    const posId = deptPositions[0]?.id || 0;
    const defaultRole = dynamicRoles.find(r => r.name === 'Front Office' && r.is_active) || dynamicRoles[0];
    const roleId = defaultRole ? defaultRole.id : 0;

    setFormPayload({
      name: '',
      username: '',
      email: '',
      phone: '',
      department_id: deptId,
      department: defaultDept?.name || 'Front Office',
      position_id: posId,
      position: deptPositions[0]?.name || 'Staff',
      role_id: roleId,
      role: defaultRole?.name || 'Front Office',
      access_type: 'PMS_STAFF',
      hire_date: getTodayCalendarDate(),
      create_login_account: true,
      is_active: true
    });
    setEditingEmployee(null);
    setShowAddModal(true);
  };

  const handleOpenEdit = (emp: HrEmployee) => {
    setErrorMessage('');
    const displayName = emp.full_name || `${emp.first_name || ''} ${emp.last_name || ''}`.trim() || emp.username || '';
    const deptId = emp.department_id || departments.find(d => d.name === emp.department)?.id || 0;
    const posId = emp.position_id || positions.find(p => p.name === emp.position)?.id || 0;
    const roleId = emp.role_id || dynamicRoles.find(r => r.name === emp.role)?.id || 0;

    setFormPayload({
      name: displayName,
      username: emp.username || '',
      email: emp.email || '',
      phone: emp.phone || '',
      department_id: deptId,
      department: emp.department || 'Front Office',
      position_id: posId,
      position: emp.position || 'Staff',
      role_id: roleId,
      role: emp.role || 'Front Office',
      access_type: (emp.access_type as any) || 'PMS_STAFF',
      hire_date: toCalendarDateInput(emp.hire_date),
      create_login_account: false,
      is_active: emp.is_active !== false
    });
    setEditingEmployee(emp);
    setShowAddModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');
    setSubmitting(true);
    try {
      const safeHireDate = serializeCalendarDate(formPayload.hire_date);
      const selectedDept = departments.find(d => d.id === Number(formPayload.department_id));
      const selectedPos = positions.find(p => p.id === Number(formPayload.position_id));
      const selectedRole = dynamicRoles.find(r => r.id === Number(formPayload.role_id));

      if (editingEmployee) {
        const res = await fetch(`/api/hrd/employees/${editingEmployee.id}`, {
          method: 'PATCH',
          headers: getAuthHeaders(),
          body: JSON.stringify({
            property_id: propertyId,
            full_name: formPayload.name,
            email: formPayload.email || null,
            phone: formPayload.phone || null,
            department_id: Number(formPayload.department_id) || undefined,
            department: selectedDept?.name || formPayload.department,
            position_id: Number(formPayload.position_id) || undefined,
            position: selectedPos?.name || formPayload.position,
            role_id: Number(formPayload.role_id) || undefined,
            role: selectedRole?.name || formPayload.role,
            access_type: formPayload.access_type,
            hire_date: safeHireDate,
            is_active: formPayload.is_active
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Gagal memperbarui data karyawan');
        setShowAddModal(false);
        await fetchData();
      } else {
        const res = await fetch('/api/hrd/employees', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({
            property_id: propertyId,
            full_name: formPayload.name,
            username: formPayload.username || undefined,
            email: formPayload.email || undefined,
            phone: formPayload.phone || undefined,
            department_id: Number(formPayload.department_id) || undefined,
            department: selectedDept?.name || formPayload.department,
            position_id: Number(formPayload.position_id) || undefined,
            position: selectedPos?.name || formPayload.position,
            role_id: Number(formPayload.role_id) || undefined,
            role: selectedRole?.name || formPayload.role,
            access_type: formPayload.access_type,
            hire_date: safeHireDate,
            create_login_account: formPayload.create_login_account
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Gagal mendaftarkan karyawan');

        setShowAddModal(false);
        await fetchData();

        if (data.data?.temporary_password) {
          setCredentialModal({
            title: 'AKUN KARYAWAN BERHASIL DIBUAT',
            fullName: data.data.full_name,
            employeeCode: data.data.employee_code,
            email: data.data.email,
            username: data.data.username,
            phone: data.data.phone || formPayload.phone,
            temporaryPassword: data.data.temporary_password,
            expiresAt: data.data.temp_password_expires_at,
            isReset: false,
            employeeId: data.data.id
          });
          setWhatsAppError(null);
          setWhatsAppOpened(false);
        }
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Terjadi kesalahan sistem');
    } finally {
      setSubmitting(false);
    }
  };

  const handleExecuteResetPassword = async (emp: HrEmployee) => {
    if (!confirm(`Reset password untuk karyawan "${emp.full_name || emp.username}"? Akun akan membutuhkan ganti password saat login pertama.`)) {
      return;
    }
    try {
      const res = await fetch(`/api/hrd/employees/${emp.id}/reset-password`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ property_id: propertyId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal mereset password');

      setCredentialModal({
        title: 'PASSWORD KARYAWAN BERHASIL DIRESET',
        fullName: emp.full_name,
        employeeCode: emp.employee_code,
        email: data.data.email,
        username: data.data.username,
        phone: data.data.phone || emp.phone,
        temporaryPassword: data.data.temporary_password,
        expiresAt: data.data.temp_password_expires_at,
        isReset: true,
        employeeId: emp.id
      });
      setWhatsAppError(null);
      setWhatsAppOpened(false);

      if (diagnosisTarget && diagnosisTarget.id === emp.id) {
        await handleOpenDiagnosis(emp);
      }
      await fetchData();
    } catch (err: any) {
      alert(err.message || 'Gagal mereset password');
    }
  };

  const handleOpenDiagnosis = async (emp: HrEmployee) => {
    setDiagnosisTarget(emp);
    setDiagnosisData(null);
    setDiagnosisError(null);
    setRepairNotice(null);
    setDiagnosisLoading(true);
    try {
      const res = await fetch(`/api/hrd/employees/${emp.id}/login-account-diagnosis?property_id=${propertyId}`, {
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal memuat diagnosa akun');
      setDiagnosisData(data.data);
    } catch (err: any) {
      setDiagnosisError(err.message || 'Gagal memuat diagnosa');
    } finally {
      setDiagnosisLoading(false);
    }
  };

  const handleExecuteRepair = async (action: string, targetUserId?: number) => {
    if (!diagnosisTarget) return;
    setRepairing(true);
    setRepairNotice(null);
    try {
      const res = await fetch(`/api/hrd/employees/${diagnosisTarget.id}/repair-login-account`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          property_id: propertyId,
          action,
          target_user_id: targetUserId,
          reason: 'Perbaikan via HRD Workspace UI'
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal melakukan perbaikan akun');
      setRepairNotice(data.message || 'Perbaikan akun berhasil diproses.');
      await handleOpenDiagnosis(diagnosisTarget);
      await fetchData();
    } catch (err: any) {
      alert(err.message || 'Gagal melakukan perbaikan akun');
    } finally {
      setRepairing(false);
    }
  };

  const handleOpenDeactivateModal = (emp: HrEmployee) => {
    setDeactivateTarget(emp);
    setDeactivateReason('Resign / Pengunduran Diri');
    setDeactivateEffectiveDate(getTodayCalendarDate());
  };

  const handleExecuteDeactivate = async () => {
    if (!deactivateTarget) return;
    setDeactivating(true);
    try {
      const res = await fetch(`/api/hrd/employees/${deactivateTarget.id}/deactivate`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          property_id: propertyId,
          reason: deactivateReason,
          effective_date: serializeCalendarDate(deactivateEffectiveDate)
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal menonaktifkan karyawan');
      setDeactivateTarget(null);
      await fetchData();
    } catch (err: any) {
      alert(err.message || 'Gagal menonaktifkan karyawan');
    } finally {
      setDeactivating(false);
    }
  };

  const handleOpenReactivateModal = (emp: HrEmployee) => {
    setReactivateTarget(emp);
  };

  const handleExecuteReactivate = async () => {
    if (!reactivateTarget) return;
    setReactivating(true);
    try {
      const res = await fetch(`/api/hrd/employees/${reactivateTarget.id}/reactivate`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ property_id: propertyId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal mengaktifkan kembali karyawan');
      const targetEmp = reactivateTarget;
      setReactivateTarget(null);
      await fetchData();
      // Requirement 16: Automatically run diagnosis to offer login account activation/creation
      await handleOpenDiagnosis(targetEmp);
    } catch (err: any) {
      alert(err.message || 'Gagal mengaktifkan kembali karyawan');
    } finally {
      setReactivating(false);
    }
  };

  const handleOpenDeleteAccountModal = (emp: HrEmployee) => {
    setDeleteAccountTarget(emp);
    setDeleteAccountError(null);
    setDeleteAccountHistoryDetails([]);
  };

  const handleExecuteDeleteAccount = async () => {
    if (!deleteAccountTarget) return;
    setDeletingAccount(true);
    setDeleteAccountError(null);
    setDeleteAccountHistoryDetails([]);
    try {
      const res = await fetch(`/api/hrd/employees/${deleteAccountTarget.id}/login-account`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          property_id: propertyId
        })
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === 'ACCOUNT_HAS_HISTORY' && Array.isArray(data.details)) {
          setDeleteAccountHistoryDetails(data.details);
        }
        throw new Error(data.message || 'Gagal menghapus akun login');
      }
      setDeleteAccountTarget(null);
      await fetchData();
    } catch (err: any) {
      setDeleteAccountError(err.message || 'Gagal menghapus akun');
    } finally {
      setDeletingAccount(false);
    }
  };

  const getAccountStatusBadge = (emp: HrEmployee) => {
    if (!emp.user_id) {
      return (
        <span className="inline-block px-2 py-0.5 rounded-md text-[10px] font-bold uppercase bg-slate-100 text-slate-600 border border-slate-200">
          Belum Ada Akun
        </span>
      );
    }
    if (emp.user_is_active === false || emp.is_active === false || emp.account_status === 'DISABLED') {
      return (
        <span className="inline-block px-2 py-0.5 rounded-md text-[10px] font-bold uppercase bg-rose-100 text-rose-800 border border-rose-200">
          Dinonaktifkan
        </span>
      );
    }
    if (emp.account_status === 'SUSPENDED') {
      return (
        <span className="inline-block px-2 py-0.5 rounded-md text-[10px] font-bold uppercase bg-red-100 text-red-800 border border-red-200">
          Ditangguhkan
        </span>
      );
    }
    if (emp.account_status === 'FIRST_LOGIN_REQUIRED') {
      return (
        <span className="inline-block px-2 py-0.5 rounded-md text-[10px] font-bold uppercase bg-amber-100 text-amber-800 border border-amber-200" title="Karyawan perlu login dan membuat password baru">
          Password Perlu Dibuat
        </span>
      );
    }
    if (emp.account_status === 'FACE_ENROLLMENT_REQUIRED') {
      return (
        <span className="inline-block px-2 py-0.5 rounded-md text-[10px] font-bold uppercase bg-sky-100 text-sky-800 border border-sky-200">
          Menunggu Foto Wajah
        </span>
      );
    }
    if (emp.account_status === 'READY') {
      return (
        <span className="inline-block px-2 py-0.5 rounded-md text-[10px] font-bold uppercase bg-emerald-100 text-emerald-800 border border-emerald-200">
          Siap Digunakan
        </span>
      );
    }
    return (
      <span className="inline-block px-2 py-0.5 rounded-md text-[10px] font-bold uppercase bg-orange-100 text-orange-800 border border-orange-200">
        Perlu Perbaikan
      </span>
    );
  };

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopySuccess(label);
    setTimeout(() => setCopySuccess(null), 2000);
  };

  const handleOpenWhatsApp = () => {
    if (!credentialModal) return;
    const phone = credentialModal.phone;
    const normalized = normalizeIndonesianPhoneNumber(phone);
    if (!normalized) {
      setWhatsAppError('Nomor WhatsApp karyawan belum tersedia atau tidak valid.');
      return;
    }
    setWhatsAppError(null);
    const expiryStr = formatExpiryDateTime(credentialModal.expiresAt);
    const loginUrl = getCanonicalLoginUrl();
    const message = buildWhatsAppCredentialMessage({
      employeeName: credentialModal.fullName,
      email: credentialModal.email,
      username: credentialModal.username,
      temporaryPassword: credentialModal.temporaryPassword,
      expiryStr,
      loginUrl,
      isReset: credentialModal.isReset
    });
    const deepLink = buildWhatsAppDeepLink(normalized, message);
    window.open(deepLink, '_blank', 'noopener,noreferrer');
    setWhatsAppOpened(true);

    // Click-to-chat audit log to backend (never logs password, only masked phone)
    if (credentialModal.employeeId) {
      fetch(`/api/hrd/employees/${credentialModal.employeeId}/audit-whatsapp-opened`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ property_id: propertyId, phone: normalized })
      }).catch(() => {});
    }
  };

  const handleDismissCredentialModal = () => {
    // Explicitly clear sensitive plaintext temporary credentials from state
    setCredentialModal(null);
    setCopySuccess(null);
    setWhatsAppError(null);
    setWhatsAppOpened(false);
  };

  const activeEmployeesList = employees.filter(emp => emp.is_active !== false && emp.status === 'ACTIVE');
  const archiveEmployeesList = employees.filter(emp => emp.is_active === false || emp.status !== 'ACTIVE');

  const displayedEmployees = (employeeScopeTab === 'ACTIVE' ? activeEmployeesList : archiveEmployeesList).filter(emp => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    const fullName = (emp.full_name || `${emp.first_name || ''} ${emp.last_name || ''}`).toLowerCase();
    const role = (emp.role || '').toLowerCase();
    const dept = (emp.department || '').toLowerCase();
    const user = (emp.username || '').toLowerCase();
    const mail = (emp.email || '').toLowerCase();
    return fullName.includes(q) || role.includes(q) || dept.includes(q) || user.includes(q) || mail.includes(q);
  });

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="bg-white border border-slate-200/90 rounded-2xl p-5 shadow-xs flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 rounded-full text-xs font-extrabold bg-[#1b4332]/10 text-[#1b4332] border border-[#1b4332]/20">
              DEPARTEMEN
            </span>
            <h1 className="text-xl font-bold font-serif text-slate-900">
              HRD — Manajemen Karyawan & Hak Akses
            </h1>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Pengelolaan identitas staf, peran otorisasi, dan pembuatan akun login untuk properti {propertyName || 'OAK Hotel'}.
          </p>
        </div>

        {activeTab === 'EMPLOYEES' && (
          <button
            type="button"
            onClick={handleOpenAdd}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#1b4332] text-white hover:bg-[#143326] transition font-bold text-xs shadow-xs cursor-pointer shrink-0"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
            </svg>
            Tambah Karyawan Baru
          </button>
        )}
      </div>

      {/* Workspace Top-Level Sub-Tabs Navigation */}
      <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
        <button
          type="button"
          onClick={() => setActiveTab('EMPLOYEES')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 cursor-pointer ${
            activeTab === 'EMPLOYEES'
              ? 'bg-[#1b4332] text-white shadow-xs'
              : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
          }`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
          </svg>
          Daftar Karyawan ({employees.length})
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('DEPARTMENTS_POSITIONS')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 cursor-pointer ${
            activeTab === 'DEPARTMENTS_POSITIONS'
              ? 'bg-[#1b4332] text-white shadow-xs'
              : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
          }`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
          </svg>
          Departemen & Jabatan ({departments.length})
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('ROLES_PERMISSIONS')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 cursor-pointer ${
            activeTab === 'ROLES_PERMISSIONS'
              ? 'bg-[#1b4332] text-white shadow-xs'
              : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
          }`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          Hak Akses ({dynamicRoles.length})
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('JADWAL_KERJA')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 cursor-pointer ${
            activeTab === 'JADWAL_KERJA'
              ? 'bg-[#1b4332] text-white shadow-xs'
              : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
          }`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          Jadwal Kerja
        </button>

        {isPlatformSuperAdmin && (
          <button
            type="button"
            onClick={() => setActiveTab('DATA_TEST')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 cursor-pointer ${
              activeTab === 'DATA_TEST'
                ? 'bg-[#7c2d12] text-white shadow-xs'
                : 'bg-white text-orange-700 hover:bg-orange-50 border border-orange-200'
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Data Test
          </button>
        )}
      </div>

      {/* Tab: Departemen & Jabatan */}
      {activeTab === 'DEPARTMENTS_POSITIONS' && (
        <DepartmentPositionTab propertyId={propertyId} />
      )}

      {/* Tab: Hak Akses Role / Hak Akses Pengguna */}
      {activeTab === 'ROLES_PERMISSIONS' && (
        <RolePermissionsTab
          propertyId={propertyId}
          onPermissionsUpdated={(newMap) => {
            fetchData();
            if (onPermissionsUpdated) onPermissionsUpdated(newMap);
          }}
        />
      )}

      {/* Tab: Jadwal Kerja / Work Schedule */}
      {activeTab === 'JADWAL_KERJA' && (
        <ScheduleTab propertyId={propertyId} />
      )}

      {/* Tab: Data Test Cleanup (Platform Super Admin only) */}
      {activeTab === 'DATA_TEST' && isPlatformSuperAdmin && (
        <TestDataPurgeTab propertyId={propertyId} />
      )}

      {/* Tab 1: Employees List Table Card */}
      {activeTab === 'EMPLOYEES' && (
        <div className="space-y-4">
          {/* Sub-Tabs: Karyawan Aktif vs Nonaktif / Arsip */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setEmployeeScopeTab('ACTIVE')}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 cursor-pointer border ${
                employeeScopeTab === 'ACTIVE'
                  ? 'bg-[#1b4332] text-white border-[#1b4332] shadow-xs'
                  : 'bg-white text-slate-700 hover:bg-slate-50 border-slate-200'
              }`}
            >
              <span>Karyawan Aktif</span>
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                  employeeScopeTab === 'ACTIVE' ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600'
                }`}
              >
                {activeEmployeesList.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setEmployeeScopeTab('ARCHIVE')}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 cursor-pointer border ${
                employeeScopeTab === 'ARCHIVE'
                  ? 'bg-stone-800 text-white border-stone-800 shadow-xs'
                  : 'bg-white text-slate-700 hover:bg-slate-50 border-slate-200'
              }`}
            >
              <span>Nonaktif / Arsip</span>
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                  employeeScopeTab === 'ARCHIVE' ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600'
                }`}
              >
                {archiveEmployeesList.length}
              </span>
            </button>
          </div>

          <div className="bg-white border border-slate-200/90 rounded-2xl shadow-xs overflow-hidden">
            {/* Search Bar */}
            <div className="p-4 border-b border-slate-100 flex items-center justify-between gap-4">
              <div className="relative flex-1 max-w-sm">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Cari karyawan berdasarkan nama, role, atau email..."
                  className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                />
                <svg className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <span className="text-xs text-slate-500 font-medium">
                Total: <strong>{displayedEmployees.length}</strong> Karyawan
              </span>
            </div>

            {loading ? (
              <div className="p-12 text-center text-xs text-slate-500">
                <div className="w-8 h-8 rounded-full border-2 border-emerald-600 border-t-transparent animate-spin mx-auto mb-2" />
                Memuat daftar karyawan...
              </div>
            ) : displayedEmployees.length === 0 ? (
              <div className="p-12 text-center text-slate-400 text-xs">
                {employeeScopeTab === 'ACTIVE'
                  ? 'Tidak ada data karyawan aktif yang sesuai dengan pencarian.'
                  : 'Tidak ada karyawan dalam arsip / nonaktif.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200/80 text-slate-600 font-bold uppercase tracking-wider text-[11px]">
                      <th className="py-3 px-4">Nama Lengkap & Kode</th>
                      <th className="py-3 px-4">Email & Kontak</th>
                      <th className="py-3 px-4">
                        {employeeScopeTab === 'ACTIVE' ? 'Role / Peran' : 'Role Terakhir'}
                      </th>
                      <th className="py-3 px-4">Departemen</th>
                      <th className="py-3 px-4 text-center">Status Akun</th>
                      {employeeScopeTab === 'ARCHIVE' && (
                        <th className="py-3 px-4">Tanggal Diperbarui</th>
                      )}
                      <th className="py-3 px-4 text-right">Aksi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {displayedEmployees.map((emp) => {
                      const displayName =
                        emp.full_name ||
                        `${emp.first_name || ''} ${emp.last_name || ''}`.trim() ||
                        emp.username ||
                        'Staf OAK';

                      return (
                        <tr key={emp.id} className="hover:bg-slate-50/80 transition">
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-slate-900">{displayName}</span>
                              {employeeScopeTab === 'ARCHIVE' && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-stone-100 text-stone-700 border border-stone-200">
                                  Arsip / Nonaktif
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-slate-400">
                              {emp.employee_code || `EMP-${emp.id}`}{' '}
                              {emp.username ? `• @${emp.username}` : ''}
                              {emp.hire_date ? ` • Masuk: ${formatDateDisplay(emp.hire_date)}` : ''}
                            </div>
                          </td>
                          <td className="py-3 px-4">
                            <div className="text-slate-800 font-medium">{emp.email || '—'}</div>
                            <div className="text-[11px] text-slate-400">{emp.phone || '—'}</div>
                          </td>
                          <td className="py-3 px-4">
                            <span className="inline-block px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-[#1b4332]/10 text-[#1b4332] border border-[#1b4332]/20">
                              {emp.role || 'Crew'}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-slate-600 font-medium">
                            {emp.department || 'Front Office'}
                          </td>
                          <td className="py-3 px-4 text-center">
                            {getAccountStatusBadge(emp)}
                          </td>
                          {employeeScopeTab === 'ARCHIVE' && (
                            <td className="py-3 px-4 text-slate-500 text-[11px]">
                              {emp.updated_at ? new Date(emp.updated_at).toLocaleDateString('id-ID') : '—'}
                            </td>
                          )}
                          <td className="py-3 px-4 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              {employeeScopeTab === 'ACTIVE' ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => handleOpenDiagnosis(emp)}
                                    className="px-2 py-1 text-[11px] font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition cursor-pointer"
                                    title="Diagnosa dan Perbaiki Kredensial Akun"
                                  >
                                    Diagnosa Akun
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleExecuteResetPassword(emp)}
                                    className="px-2 py-1 text-[11px] font-semibold text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg transition cursor-pointer"
                                    title="Reset Password Karyawan"
                                  >
                                    Reset Password
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleOpenEdit(emp)}
                                    className="px-2 py-1 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition cursor-pointer"
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleOpenDeactivateModal(emp)}
                                    className="px-2 py-1 text-[11px] font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition cursor-pointer"
                                    title="Nonaktifkan Karyawan dan Pindahkan ke Arsip"
                                  >
                                    Nonaktifkan
                                  </button>
                                  {isPlatformSuperAdmin && (
                                    <button
                                      type="button"
                                      onClick={() => { setHardDeleteTarget(emp); setHardDeleteError(null); }}
                                      className="px-2 py-1 text-[11px] font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition cursor-pointer"
                                      title="Hapus Karyawan Permanen (Khusus Super Admin)"
                                    >
                                      Hapus
                                    </button>
                                  )}
                                </>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => handleOpenDiagnosis(emp)}
                                    className="px-2 py-1 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition cursor-pointer"
                                    title="Lihat Detail Diagnosis Akun"
                                  >
                                    Lihat
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleOpenReactivateModal(emp)}
                                    className="px-2 py-1 text-[11px] font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition cursor-pointer"
                                    title="Aktifkan Kembali Karyawan"
                                  >
                                    Aktifkan Kembali
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleOpenEdit(emp)}
                                    className="px-2 py-1 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition cursor-pointer"
                                  >
                                    Edit
                                  </button>
                                  {emp.user_id && isPlatformSuperAdmin && (
                                    <button
                                      type="button"
                                      onClick={() => handleOpenDeleteAccountModal(emp)}
                                      className="px-2 py-1 text-[11px] font-semibold text-amber-700 hover:text-amber-900 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg transition cursor-pointer"
                                      title="Hapus Permanen Akun Login (Khusus Platform Super Admin)"
                                    >
                                      Hapus Akun Login
                                    </button>
                                  )}
                                  {isPlatformSuperAdmin && (
                                    <button
                                      type="button"
                                      onClick={() => { setHardDeleteTarget(emp); setHardDeleteError(null); }}
                                      className="px-2 py-1 text-[11px] font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition cursor-pointer"
                                      title="Hapus Karyawan Permanen (Khusus Super Admin)"
                                    >
                                      Hapus
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add / Edit Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full border border-slate-200 shadow-xl p-5 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200">
              <h3 className="font-serif font-bold text-base text-slate-900">
                {editingEmployee ? 'Edit Data Karyawan' : 'Tambah Karyawan Baru'}
              </h3>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="text-slate-400 hover:text-slate-700 text-sm font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            {errorMessage && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-semibold">
                ⚠ {errorMessage}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-3 text-xs">
              {editingEmployee && editingEmployee.employee_code && (
                <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between">
                  <div>
                    <span className="text-[10px] text-slate-500 uppercase font-bold block">Kode Karyawan (Employee Code)</span>
                    <span className="font-mono font-bold text-slate-900 text-xs">{editingEmployee.employee_code}</span>
                  </div>
                  <span className="text-[10px] text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded font-bold">
                    Tetap & Tidak Berubah Saat Mutasi
                  </span>
                </div>
              )}

              <div>
                <label className="block text-slate-700 font-bold mb-1">
                  Nama Lengkap <span className="text-red-500">*</span>:
                </label>
                <input
                  type="text"
                  required
                  value={formPayload.name}
                  onChange={(e) => setFormPayload(p => ({ ...p, name: e.target.value }))}
                  placeholder="Contoh: Nadya Receptionist"
                  className="w-full p-2.5 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-700 font-bold mb-1">
                    Nomor HP / WhatsApp:
                  </label>
                  <input
                    type="text"
                    value={formPayload.phone}
                    onChange={(e) => setFormPayload(p => ({ ...p, phone: e.target.value }))}
                    placeholder="08123456789"
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                  />
                </div>

                <div>
                  <label className="block text-slate-700 font-bold mb-1">
                    Email Karyawan {formPayload.create_login_account ? <span className="text-red-500">*</span> : '(Opsional)'}:
                  </label>
                  <input
                    type="email"
                    required={formPayload.create_login_account}
                    value={formPayload.email}
                    onChange={(e) => setFormPayload(p => ({ ...p, email: e.target.value }))}
                    placeholder="nadya@oaklawang.com"
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-700 font-bold mb-1">
                    Departemen <span className="text-red-500">*</span>:
                  </label>
                  <select
                    value={formPayload.department_id}
                    onChange={(e) => {
                      const newDeptId = Number(e.target.value);
                      const deptPos = positions.filter(pos => pos.department_id === newDeptId && pos.is_active);
                      const selDept = departments.find(d => d.id === newDeptId);
                      setFormPayload(p => ({
                        ...p,
                        department_id: newDeptId,
                        department: selDept?.name || p.department,
                        position_id: deptPos[0]?.id || 0,
                        position: deptPos[0]?.name || p.position
                      }));
                    }}
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                  >
                    {departments.filter(d => d.is_active || d.id === formPayload.department_id).map(d => (
                      <option key={d.id} value={d.id}>
                        {d.name} ({d.code})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-700 font-bold mb-1">
                    Posisi / Jabatan <span className="text-red-500">*</span>:
                  </label>
                  <select
                    value={formPayload.position_id}
                    onChange={(e) => {
                      const newPosId = Number(e.target.value);
                      const selPos = positions.find(pos => pos.id === newPosId);
                      setFormPayload(p => ({
                        ...p,
                        position_id: newPosId,
                        position: selPos?.name || p.position
                      }));
                    }}
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                  >
                    <option value={0} disabled>Pilih Jabatan...</option>
                    {positions
                      .filter(pos => pos.department_id === Number(formPayload.department_id) && (pos.is_active || pos.id === formPayload.position_id))
                      .map(pos => (
                        <option key={pos.id} value={pos.id}>
                          {pos.name}
                        </option>
                      ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-700 font-bold mb-1">
                    Peran / Role Sistem <span className="text-red-500">*</span>:
                  </label>
                  <select
                    value={formPayload.role_id}
                    onChange={(e) => {
                      const newRoleId = Number(e.target.value);
                      const selRole = dynamicRoles.find(r => r.id === newRoleId);
                      setFormPayload(p => ({
                        ...p,
                        role_id: newRoleId,
                        role: selRole?.name || p.role
                      }));
                    }}
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                  >
                    {dynamicRoles.filter(r => r.is_active || r.id === formPayload.role_id).map(r => (
                      <option key={r.id} value={r.id}>
                        {r.name} {r.is_system_role ? '(Sistem)' : '(Kustom)'}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-700 font-bold mb-1">
                    Tipe Akses Login <span className="text-red-500">*</span>:
                  </label>
                  <select
                    value={formPayload.access_type}
                    onChange={(e) => setFormPayload(p => ({ ...p, access_type: e.target.value as any }))}
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                  >
                    <option value="PMS_STAFF">PMS Staf (Desktop/Web)</option>
                    <option value="MANAGER">Manager / SPV</option>
                    <option value="MOBILE_ONLY">Mobile Staf Operasional</option>
                    <option value="ADMIN">Hotel Admin</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">
                  Tanggal Masuk (Hire Date):
                </label>
                <input
                  type="date"
                  value={formPayload.hire_date || ''}
                  onChange={(e) => setFormPayload(p => ({ ...p, hire_date: e.target.value }))}
                  className="w-full p-2.5 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                />
              </div>

              {!editingEmployee && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer font-bold text-slate-800">
                    <input
                      type="checkbox"
                      checked={formPayload.create_login_account}
                      onChange={(e) => setFormPayload(p => ({ ...p, create_login_account: e.target.checked }))}
                      className="rounded border-slate-300 text-[#1b4332] focus:ring-[#1b4332]"
                    />
                    <span>Buat Akun Login</span>
                  </label>
                  {formPayload.create_login_account ? (
                    <div className="space-y-2 pl-6">
                      <p className="text-[11px] text-slate-500">
                        Akun login HIMS akan dibuat otomatis menggunakan email karyawan dan password sementara yang aman.
                      </p>
                      <div>
                        <label className="block text-[11px] text-slate-600 font-medium mb-1">
                          Username (Opsional, otomatis dari email jika kosong):
                        </label>
                        <input
                          type="text"
                          value={formPayload.username}
                          onChange={(e) => setFormPayload(p => ({ ...p, username: e.target.value }))}
                          placeholder="nadya.fo"
                          className="w-full p-2 rounded-lg border border-slate-300 text-slate-900 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                        />
                      </div>
                    </div>
                  ) : (
                    <p className="text-[11px] text-slate-500 pl-6">
                      Karyawan akan didaftarkan tanpa akun login sistem. Akun login dapat dibuat atau dihubungkan kemudian.
                    </p>
                  )}
                </div>
              )}

              <div className="pt-3 border-t border-slate-200 flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="flex-1 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold transition cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 py-2.5 rounded-xl bg-[#1b4332] hover:bg-[#143326] text-white font-bold transition cursor-pointer shadow-xs disabled:bg-slate-300"
                >
                  {submitting ? 'Menyimpan...' : (editingEmployee ? 'Simpan Perubahan' : 'Simpan Karyawan')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* One-Time Credential Modal */}
      {credentialModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full border border-emerald-200 shadow-2xl p-6 space-y-4">
            <div className="text-center pb-2 border-b border-slate-100">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-emerald-100 text-emerald-800 text-2xl font-bold mb-2">
                ✓
              </div>
              <h3 className="font-serif font-bold text-base text-slate-900 tracking-tight">
                {credentialModal.title}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Salin dan berikan kredensial sementara ini kepada karyawan.
              </p>
            </div>

            <div className="space-y-2 text-xs bg-slate-50 p-4 rounded-xl border border-slate-200/80">
              <div className="flex justify-between">
                <span className="text-slate-500">Nama:</span>
                <span className="font-bold text-slate-900">{credentialModal.fullName}</span>
              </div>
              {credentialModal.employeeCode && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Kode Karyawan:</span>
                  <span className="font-mono font-semibold text-slate-800">{credentialModal.employeeCode}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-slate-500">Email:</span>
                <span className="font-semibold text-slate-800">{credentialModal.email}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Username:</span>
                <span className="font-mono font-semibold text-slate-800">@{credentialModal.username}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-500">WhatsApp:</span>
                <span className={`font-mono font-semibold ${credentialModal.phone ? 'text-slate-800' : 'text-slate-400 italic'}`}>
                  {credentialModal.phone ? credentialModal.phone : 'Belum diisi'}
                </span>
              </div>
              <div className="pt-2 border-t border-slate-200">
                <span className="text-slate-600 block mb-1 font-bold">Password Sementara:</span>
                <div className="flex items-center justify-between p-2.5 bg-white border border-emerald-300 rounded-lg">
                  <span className="font-mono font-bold text-base text-emerald-800 tracking-wider select-all">
                    {credentialModal.temporaryPassword}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCopy(credentialModal.temporaryPassword, 'PASSWORD')}
                    className="px-2.5 py-1 text-xs font-bold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-md transition cursor-pointer"
                  >
                    {copySuccess === 'PASSWORD' ? '✓ Tersalin' : 'Salin Password'}
                  </button>
                </div>
              </div>
              <p className="text-[11px] text-amber-700 bg-amber-50 p-2 rounded-lg border border-amber-200 mt-2">
                ⚠ Berlaku sampai: {formatExpiryDateTime(credentialModal.expiresAt)}. Wajib ganti password pada login pertama.
              </p>
            </div>

            {whatsAppError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700 font-medium flex items-center gap-2">
                <span>⚠</span>
                <span>{whatsAppError}</span>
              </div>
            )}

            {whatsAppOpened && (
              <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-xl text-[11px] text-emerald-800 font-medium text-center">
                ✓ WhatsApp telah dibuka. Silakan tinjau dan kirim pesan di WhatsApp.
              </div>
            )}

            <div className="space-y-2 pt-1">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleOpenWhatsApp}
                  className="flex-1 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs transition cursor-pointer shadow-xs flex items-center justify-center gap-1.5"
                >
                  <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                    <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/>
                  </svg>
                  Kirim via WhatsApp
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const expiryStr = formatExpiryDateTime(credentialModal.expiresAt);
                    const loginUrl = getCanonicalLoginUrl();
                    const allInfo = buildWhatsAppCredentialMessage({
                      employeeName: credentialModal.fullName,
                      email: credentialModal.email,
                      username: credentialModal.username,
                      temporaryPassword: credentialModal.temporaryPassword,
                      expiryStr,
                      loginUrl,
                      isReset: credentialModal.isReset
                    });
                    handleCopy(allInfo, 'ALL');
                  }}
                  className="flex-1 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs transition cursor-pointer"
                >
                  {copySuccess === 'ALL' ? '✓ Tersalin' : 'Salin Kredensial'}
                </button>
              </div>
              <button
                type="button"
                onClick={handleDismissCredentialModal}
                className="w-full py-2.5 rounded-xl bg-[#1b4332] hover:bg-[#143326] text-white font-bold text-xs transition cursor-pointer shadow-xs"
              >
                Selesai
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Diagnosis & Repair Modal */}
      {diagnosisTarget && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full border border-slate-200 shadow-xl p-5 space-y-4 max-h-[90vh] overflow-y-auto text-xs">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200">
              <div>
                <h3 className="font-serif font-bold text-base text-slate-900">
                  Diagnosa Akun Login Karyawan
                </h3>
                <p className="text-slate-500 text-[11px]">
                  {diagnosisTarget.full_name} ({diagnosisTarget.employee_code || `EMP-${diagnosisTarget.id}`})
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDiagnosisTarget(null)}
                className="text-slate-400 hover:text-slate-700 text-sm font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            {diagnosisLoading ? (
              <div className="p-8 text-center text-slate-400">
                Mendiagnosa relasi data karyawan dan kredensial login...
              </div>
            ) : diagnosisError ? (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800">
                ⚠ {diagnosisError}
              </div>
            ) : diagnosisData ? (
              <div className="space-y-3">
                {repairNotice && (
                  <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 font-semibold">
                    ✓ {repairNotice}
                  </div>
                )}

                {/* State Card */}
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-700">Status Diagnosa Utama:</span>
                    <span className="font-mono font-bold px-2 py-0.5 rounded bg-[#1b4332]/10 text-[#1b4332]">
                      {diagnosisData.diagnosis_state}
                    </span>
                  </div>
                  {diagnosisData.mismatch_reasons.length > 0 && (
                    <div className="space-y-1">
                      {diagnosisData.mismatch_reasons.map((r, i) => (
                        <div key={i} className="text-[11px] text-amber-800 bg-amber-50/80 p-2 rounded-lg border border-amber-200">
                          • {r}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Relational Table */}
                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <table className="w-full text-left border-collapse">
                    <thead className="bg-slate-100 text-slate-600 font-bold uppercase text-[10px]">
                      <tr>
                        <th className="p-2.5">Parameter</th>
                        <th className="p-2.5">Data Karyawan (HR)</th>
                        <th className="p-2.5">Akun Login (Users)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      <tr>
                        <td className="p-2.5 font-medium text-slate-500">User ID</td>
                        <td className="p-2.5 font-bold text-slate-800">ID: {diagnosisData.employee_id}</td>
                        <td className="p-2.5 font-mono text-slate-800">
                          {diagnosisData.linked_user_id ? `User #${diagnosisData.linked_user_id}` : 'Belum Terhubung'}
                        </td>
                      </tr>
                      <tr>
                        <td className="p-2.5 font-medium text-slate-500">Email</td>
                        <td className="p-2.5 text-slate-800">{diagnosisData.employee_email || '—'}</td>
                        <td className="p-2.5 text-slate-800">{diagnosisData.login_email || '—'}</td>
                      </tr>
                      <tr>
                        <td className="p-2.5 font-medium text-slate-500">Username</td>
                        <td className="p-2.5 text-slate-800">@{diagnosisData.employee_username || '—'}</td>
                        <td className="p-2.5 text-slate-800">@{diagnosisData.username || '—'}</td>
                      </tr>
                      <tr>
                        <td className="p-2.5 font-medium text-slate-500">Role / Hak Akses</td>
                        <td className="p-2.5 text-slate-800">{diagnosisData.employee_role}</td>
                        <td className="p-2.5 text-slate-800">{diagnosisData.role_name || '—'}</td>
                      </tr>
                      <tr>
                        <td className="p-2.5 font-medium text-slate-500">Status Akun</td>
                        <td className="p-2.5 text-slate-800">{diagnosisData.employee_active ? 'Aktif' : 'Nonaktif'}</td>
                        <td className="p-2.5 text-slate-800">
                          {diagnosisData.is_active === null ? '—' : (diagnosisData.is_active ? 'Aktif' : 'Nonaktif')} ({diagnosisData.account_status || '—'})
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Repair Action Section */}
                <div className="pt-2 border-t border-slate-200 space-y-2">
                  <div className="font-bold text-slate-800">Tindakan Perbaikan yang Tersedia:</div>

                  {diagnosisData.diagnosis_state === 'UNLINKED_MATCH_FOUND' && diagnosisData.candidate_user && (
                    <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl space-y-2">
                      <p className="text-[11px] text-blue-900">
                        Ditemukan akun user yang cocok: <strong>@{diagnosisData.candidate_user.username}</strong> ({diagnosisData.candidate_user.email}) namun belum terhubung ke data karyawan ini.
                      </p>
                      <button
                        type="button"
                        disabled={repairing}
                        onClick={() => handleExecuteRepair('LINK_UNAMBIGUOUS_ACCOUNT', diagnosisData.candidate_user?.id)}
                        className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg transition cursor-pointer"
                      >
                        {repairing ? 'Memproses...' : 'Hubungkan Akun Secara Otomatis'}
                      </button>
                    </div>
                  )}

                  {diagnosisData.diagnosis_states.includes('EMAIL_MISMATCH') && (
                    <button
                      type="button"
                      disabled={repairing}
                      onClick={() => handleExecuteRepair('SYNC_LOGIN_EMAIL')}
                      className="w-full py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold rounded-lg border border-slate-300 transition cursor-pointer text-left px-3 flex justify-between items-center"
                    >
                      <span>Sinkronkan Email Login ke Email Karyawan</span>
                      <span className="text-slate-400">→</span>
                    </button>
                  )}

                  {diagnosisData.diagnosis_states.includes('USERNAME_MISMATCH') && (
                    <button
                      type="button"
                      disabled={repairing}
                      onClick={() => handleExecuteRepair('SYNC_USERNAME')}
                      className="w-full py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold rounded-lg border border-slate-300 transition cursor-pointer text-left px-3 flex justify-between items-center"
                    >
                      <span>Sinkronkan Username Login ke Data Karyawan</span>
                      <span className="text-slate-400">→</span>
                    </button>
                  )}

                  {diagnosisData.diagnosis_states.includes('ROLE_MISMATCH') && (
                    <button
                      type="button"
                      disabled={repairing}
                      onClick={() => handleExecuteRepair('SYNC_ROLE')}
                      className="w-full py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold rounded-lg border border-slate-300 transition cursor-pointer text-left px-3 flex justify-between items-center"
                    >
                      <span>Sinkronkan Role Akun Login</span>
                      <span className="text-slate-400">→</span>
                    </button>
                  )}

                  {diagnosisData.diagnosis_states.includes('ACCOUNT_DISABLED') && (
                    <button
                      type="button"
                      disabled={repairing}
                      onClick={() => handleExecuteRepair('REACTIVATE_ACCOUNT')}
                      className="w-full py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg transition cursor-pointer"
                    >
                      {repairing ? 'Memproses...' : 'Aktifkan Kembali Akun Login'}
                    </button>
                  )}

                  {diagnosisData.diagnosis_states.includes('PASSWORD_RESET_AVAILABLE') && (
                    <button
                      type="button"
                      onClick={() => handleExecuteResetPassword(diagnosisTarget)}
                      className="w-full py-2 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-lg transition cursor-pointer"
                    >
                      Reset Password Karyawan
                    </button>
                  )}

                  {diagnosisData.diagnosis_state === 'LINKED_OK' && (
                    <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800 font-semibold text-center">
                      ✓ Akun login terhubung dengan benar dan sinkron dengan data karyawan.
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            <div className="pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setDiagnosisTarget(null)}
                className="w-full py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold transition cursor-pointer"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Deactivation Modal */}
      {deactivateTarget && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full border border-slate-200 shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200">
              <h3 className="font-serif font-bold text-base text-slate-900">
                Nonaktifkan Karyawan & Arsipkan
              </h3>
              <button
                type="button"
                onClick={() => setDeactivateTarget(null)}
                className="text-slate-400 hover:text-slate-700 text-sm font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="text-xs text-slate-600 space-y-1">
              <div>Karyawan: <strong className="text-slate-900">{deactivateTarget.full_name || deactivateTarget.username}</strong></div>
              <div>Kode: <strong className="text-slate-900">{deactivateTarget.employee_code || `EMP-${deactivateTarget.id}`}</strong></div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
                  Alasan Nonaktif
                </label>
                <select
                  value={deactivateReason}
                  onChange={(e) => setDeactivateReason(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs focus:ring-2 focus:ring-rose-500"
                >
                  <option value="Resign / Pengunduran Diri">Resign / Pengunduran Diri</option>
                  <option value="Pemutusan Hubungan Kerja (PHK)">Pemutusan Hubungan Kerja (PHK)</option>
                  <option value="Habis Masa Kontrak">Habis Masa Kontrak</option>
                  <option value="Pensiun">Pensiun</option>
                  <option value="Mutasi / Pindah Tugas">Mutasi / Pindah Tugas</option>
                  <option value="Lainnya">Lainnya</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
                  Tanggal Efektif
                </label>
                <input
                  type="date"
                  value={deactivateEffectiveDate}
                  onChange={(e) => setDeactivateEffectiveDate(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs focus:ring-2 focus:ring-rose-500"
                />
              </div>

              <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-[11px] text-amber-900 space-y-1">
                <p className="font-bold">Informasi Keamanan:</p>
                <p>
                  Menonaktifkan karyawan akan secara otomatis menonaktifkan akun login auth dan mencabut seluruh sesi aktif. Data operasional historis (transaksi, jadwal, audit log) tetap tersimpan aman di database.
                </p>
              </div>
            </div>

            <div className="flex gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setDeactivateTarget(null)}
                className="flex-1 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={deactivating}
                onClick={handleExecuteDeactivate}
                className="flex-1 py-2.5 rounded-xl bg-rose-700 hover:bg-rose-800 text-white text-xs font-bold transition cursor-pointer"
              >
                {deactivating ? 'Menonaktifkan...' : 'Konfirmasi Nonaktifkan'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reactivation Modal */}
      {reactivateTarget && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full border border-slate-200 shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200">
              <h3 className="font-serif font-bold text-base text-slate-900">
                Aktifkan Kembali Karyawan
              </h3>
              <button
                type="button"
                onClick={() => setReactivateTarget(null)}
                className="text-slate-400 hover:text-slate-700 text-sm font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-600 leading-relaxed">
              Apakah Anda yakin ingin mengaktifkan kembali data personil untuk{' '}
              <strong className="text-slate-900">{reactivateTarget.full_name || reactivateTarget.username}</strong>?
            </p>

            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-[11px] text-emerald-900 space-y-1">
              <p className="font-bold">Kebijakan Keamanan Akun:</p>
              <p>
                Tindakan ini hanya mengaktifkan kembali data kepegawaian. Akun login auth <strong>TIDAK</strong> akan diaktifkan secara otomatis. Setelah pengaktifan, sistem akan menampilkan opsi diagnosis untuk mengaktifkan kembali atau membuat akun login auth baru secara aman.
              </p>
            </div>

            <div className="flex gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setReactivateTarget(null)}
                className="flex-1 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={reactivating}
                onClick={handleExecuteReactivate}
                className="flex-1 py-2.5 rounded-xl bg-[#1b4332] hover:bg-[#143326] text-white text-xs font-bold transition cursor-pointer"
              >
                {reactivating ? 'Mengaktifkan...' : 'Konfirmasi Aktifkan Kembali'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hard Delete Auth Account Modal (Platform Super Admin Only) */}
      {deleteAccountTarget && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full border border-red-200 shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-red-100">
              <h3 className="font-serif font-bold text-base text-red-900">
                Hapus Akun Login
              </h3>
              <button
                type="button"
                onClick={() => setDeleteAccountTarget(null)}
                className="text-slate-400 hover:text-slate-700 text-sm font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-600">
              Yakin ingin menghapus akun login ini? Akun akan dihapus permanen.
            </p>

            {deleteAccountError && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-semibold space-y-1">
                <div>⚠ {deleteAccountError}</div>
                {deleteAccountHistoryDetails.length > 0 && (
                  <ul className="list-disc pl-4 text-[11px] space-y-0.5 mt-1 font-normal">
                    {deleteAccountHistoryDetails.map((detail, idx) => (
                      <li key={idx}>{detail}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="flex gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setDeleteAccountTarget(null)}
                className="flex-1 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={deletingAccount}
                onClick={handleExecuteDeleteAccount}
                className="flex-1 py-2.5 rounded-xl bg-red-700 hover:bg-red-800 disabled:opacity-50 text-white text-xs font-bold transition cursor-pointer"
              >
                {deletingAccount ? 'Menghapus...' : 'Hapus'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hard Delete Employee Modal (Platform Super Admin Only) */}
      {hardDeleteTarget && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full border border-slate-200 shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200">
              <h3 className="font-serif font-bold text-base text-rose-900">
                Hapus Karyawan
              </h3>
              <button
                type="button"
                onClick={() => { setHardDeleteTarget(null); setHardDeleteError(null); }}
                className="text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-600">
              Yakin ingin menghapus data ini? Data akan dihapus permanen.
            </p>

            {hardDeleteError && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs">
                {hardDeleteError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={() => { setHardDeleteTarget(null); setHardDeleteError(null); }}
                className="px-4 py-2 rounded-xl text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 transition cursor-pointer"
                disabled={hardDeleting}
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleExecuteHardDeleteEmployee}
                disabled={hardDeleting}
                className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 transition cursor-pointer disabled:opacity-50"
              >
                {hardDeleting ? 'Menghapus...' : 'Hapus'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
