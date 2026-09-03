import React, { useState, useEffect } from 'react';
import { AVAILABLE_ROLE_OPTIONS } from '../auth/permissions';
import { RolePermissionsMatrixTab } from '../settings/RolePermissionsMatrixTab';

interface HrEmployee {
  id: number;
  property_id: number;
  full_name: string;
  first_name?: string;
  last_name?: string;
  employee_code?: string;
  role: string;
  department: string;
  position?: string;
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
  temporaryPassword: string;
  expiresAt?: string;
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

export const HrdWorkspace: React.FC<HrdWorkspaceProps> = ({ propertyId, propertyName, onPermissionsUpdated }) => {
  const [activeTab, setActiveTab] = useState<'EMPLOYEES' | 'PERMISSIONS'>('EMPLOYEES');
  const [employees, setEmployees] = useState<HrEmployee[]>([]);
  const [availableRoles, setAvailableRoles] = useState<{ role: string; category: string; description: string }[]>(AVAILABLE_ROLE_OPTIONS);
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
    position: 'Staff',
    department: 'Front Office',
    role: 'Front Office',
    hire_date: new Date().toISOString().slice(0, 10),
    create_login_account: true,
    is_active: true
  });

  // One-time credential modal state
  const [credentialModal, setCredentialModal] = useState<CredentialModalData | null>(null);
  const [copySuccess, setCopySuccess] = useState<string | null>(null);

  // Diagnosis Modal state
  const [diagnosisTarget, setDiagnosisTarget] = useState<HrEmployee | null>(null);
  const [diagnosisLoading, setDiagnosisLoading] = useState(false);
  const [diagnosisData, setDiagnosisData] = useState<DiagnosisData | null>(null);
  const [diagnosisError, setDiagnosisError] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [repairNotice, setRepairNotice] = useState<string | null>(null);

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
      const [empRes, rolesRes] = await Promise.all([
        fetch(`/api/hrd/employees?property_id=${propertyId}&scope=all`, { headers: getAuthHeaders() }),
        fetch(`/api/hrd/roles?property_id=${propertyId}`, { headers: getAuthHeaders() })
      ]);

      const empData = await empRes.json();
      const rolesData = await rolesRes.json();

      if (empData.status === 'OK' && Array.isArray(empData.data)) {
        setEmployees(empData.data);
      } else {
        const fallbackRes = await fetch(`/api/hrd/employees?property_id=${propertyId}`, { headers: getAuthHeaders() });
        const fallbackData = await fallbackRes.json();
        if (fallbackData.status === 'OK') setEmployees(fallbackData.data || []);
      }

      if (rolesData.status === 'OK') {
        const rawList = Array.isArray(rolesData.data)
          ? rolesData.data
          : (rolesData.data?.available_roles || rolesData.data?.roles);
        if (Array.isArray(rawList) && rawList.length > 0) {
          setAvailableRoles(rawList.map((r: any) => ({
            role: r.role || r.name || r.key,
            category: r.category || r.department || 'Operations',
            description: r.description || ''
          })));
        }
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
    setFormPayload({
      name: '',
      username: '',
      email: '',
      phone: '',
      position: 'Staff',
      department: 'Front Office',
      role: 'Front Office',
      hire_date: new Date().toISOString().slice(0, 10),
      create_login_account: true,
      is_active: true
    });
    setEditingEmployee(null);
    setShowAddModal(true);
  };

  const handleOpenEdit = (emp: HrEmployee) => {
    setErrorMessage('');
    const displayName = emp.full_name || `${emp.first_name || ''} ${emp.last_name || ''}`.trim() || emp.username || '';
    setFormPayload({
      name: displayName,
      username: emp.username || '',
      email: emp.email || '',
      phone: emp.phone || '',
      position: emp.position || 'Staff',
      department: emp.department || 'Front Office',
      role: emp.role || 'Front Office',
      hire_date: emp.hire_date || new Date().toISOString().slice(0, 10),
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
      if (editingEmployee) {
        const res = await fetch(`/api/hrd/employees/${editingEmployee.id}`, {
          method: 'PATCH',
          headers: getAuthHeaders(),
          body: JSON.stringify({
            property_id: propertyId,
            full_name: formPayload.name,
            email: formPayload.email || null,
            phone: formPayload.phone || null,
            position: formPayload.position,
            department: formPayload.department,
            role: formPayload.role,
            hire_date: formPayload.hire_date,
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
            position: formPayload.position,
            department: formPayload.department,
            role: formPayload.role,
            hire_date: formPayload.hire_date,
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
            temporaryPassword: data.data.temporary_password,
            expiresAt: data.data.temp_password_expires_at
          });
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
        temporaryPassword: data.data.temporary_password,
        expiresAt: data.data.temp_password_expires_at
      });

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

  const handleToggleStatus = async (emp: HrEmployee) => {
    const nextStatus = !emp.is_active;
    const actionText = nextStatus ? 'aktifkan' : 'nonaktifkan';
    if (!confirm(`Apakah Anda yakin ingin me-${actionText} akun karyawan "${emp.full_name || emp.username}"?`)) return;

    try {
      if (nextStatus) {
        const res = await fetch(`/api/hrd/employees/${emp.id}`, {
          method: 'PATCH',
          headers: getAuthHeaders(),
          body: JSON.stringify({ property_id: propertyId, is_active: true, status: 'ACTIVE' })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Gagal mengaktifkan karyawan');
      } else {
        const res = await fetch(`/api/hrd/employees/${emp.id}`, {
          method: 'DELETE',
          headers: getAuthHeaders(),
          body: JSON.stringify({ property_id: propertyId })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Gagal menonaktifkan karyawan');
      }
      await fetchData();
    } catch (err: any) {
      alert(err.message || 'Gagal mengubah status akun');
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
    if (emp.user_is_active === false || emp.is_active === false) {
      return (
        <span className="inline-block px-2 py-0.5 rounded-md text-[10px] font-bold uppercase bg-rose-100 text-rose-800 border border-rose-200">
          Dinonaktifkan
        </span>
      );
    }
    if (emp.account_status === 'FIRST_LOGIN_REQUIRED') {
      return (
        <span className="inline-block px-2 py-0.5 rounded-md text-[10px] font-bold uppercase bg-amber-100 text-amber-800 border border-amber-200">
          Menunggu Login Pertama
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

  const handleDismissCredentialModal = () => {
    setCredentialModal(null);
    setCopySuccess(null);
  };

  const filteredEmployees = employees.filter(emp => {
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

      {/* Workspace Sub-Tabs Navigation */}
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
          Daftar Karyawan & Akun ({employees.length})
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('PERMISSIONS')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 cursor-pointer ${
            activeTab === 'PERMISSIONS'
              ? 'bg-[#1b4332] text-white shadow-xs'
              : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
          }`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          Hak Akses Role (Permissions Matrix)
        </button>
      </div>

      {/* Tab 2: Dynamic Role Permissions Matrix Tab */}
      {activeTab === 'PERMISSIONS' && (
        <RolePermissionsMatrixTab
          propertyId={propertyId}
          onPermissionsUpdated={(newMap) => {
            fetchData();
            if (onPermissionsUpdated) onPermissionsUpdated(newMap);
          }}
        />
      )}

      {/* Tab 1: Employees List Table Card */}
      {activeTab === 'EMPLOYEES' && (
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
              Total: <strong>{filteredEmployees.length}</strong> Karyawan
            </span>
          </div>

          {loading ? (
            <div className="p-12 text-center text-xs text-slate-500">
              <div className="w-8 h-8 rounded-full border-2 border-emerald-600 border-t-transparent animate-spin mx-auto mb-2" />
              Memuat daftar karyawan...
            </div>
          ) : filteredEmployees.length === 0 ? (
            <div className="p-12 text-center text-slate-400 text-xs">
              Tidak ada data karyawan yang sesuai dengan pencarian.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200/80 text-slate-600 font-bold uppercase tracking-wider text-[11px]">
                    <th className="py-3 px-4">Nama Lengkap & Kode</th>
                    <th className="py-3 px-4">Email & Kontak</th>
                    <th className="py-3 px-4">Role / Peran</th>
                    <th className="py-3 px-4">Departemen</th>
                    <th className="py-3 px-4 text-center">Status Akun</th>
                    <th className="py-3 px-4 text-right">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredEmployees.map((emp) => {
                    const displayName = emp.full_name || `${emp.first_name || ''} ${emp.last_name || ''}`.trim() || emp.username || 'Staf OAK';
                    return (
                      <tr key={emp.id} className="hover:bg-slate-50/80 transition">
                        <td className="py-3 px-4">
                          <div className="font-bold text-slate-900">{displayName}</div>
                          <div className="text-[11px] text-slate-400">
                            {emp.employee_code || `EMP-${emp.id}`} {emp.username ? `• @${emp.username}` : ''}
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
                        <td className="py-3 px-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
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
                              onClick={() => handleToggleStatus(emp)}
                              className={`px-2 py-1 text-[11px] font-semibold rounded-lg transition cursor-pointer ${
                                emp.is_active !== false
                                  ? 'text-rose-700 bg-rose-50 hover:bg-rose-100'
                                  : 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100'
                              }`}
                            >
                              {emp.is_active !== false ? 'Nonaktifkan' : 'Aktifkan'}
                            </button>
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
                    Nomor HP:
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
                    Posisi / Jabatan:
                  </label>
                  <input
                    type="text"
                    value={formPayload.position}
                    onChange={(e) => setFormPayload(p => ({ ...p, position: e.target.value }))}
                    placeholder="Receptionist"
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                  />
                </div>
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

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-700 font-bold mb-1">
                    Role / Peran <span className="text-red-500">*</span>:
                  </label>
                  <select
                    value={formPayload.role}
                    onChange={(e) => setFormPayload(p => ({ ...p, role: e.target.value }))}
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                  >
                    {availableRoles.map(r => (
                      <option key={r.role} value={r.role}>
                        {r.role}
                      </option>
                    ))}
                  </select>
                  {formPayload.create_login_account && formPayload.role === 'Crew' && (
                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-1.5 mt-1">
                      Peran "Crew" adalah staf operasional tanpa akun sistem HIMS. Pilih Front Office, Housekeeping, Accounting, GM, atau POS / Resto untuk membuat akun login.
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-slate-700 font-bold mb-1">
                    Departemen <span className="text-red-500">*</span>:
                  </label>
                  <select
                    value={formPayload.department}
                    onChange={(e) => setFormPayload(p => ({ ...p, department: e.target.value }))}
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                  >
                    <option value="Front Office">Front Office</option>
                    <option value="Housekeeping">Housekeeping</option>
                    <option value="Finance & Accounting">Finance & Accounting</option>
                    <option value="Food & Beverage">Food & Beverage</option>
                    <option value="Engineering & Maintenance">Engineering & Maintenance</option>
                    <option value="Management">Management</option>
                  </select>
                </div>
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
                ⚠ Berlaku 7 hari. Wajib ganti password pada login pertama.
              </p>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  const allInfo = `KREDENSIAL LOGIN OAK HIMS\nNama: ${credentialModal.fullName}\nEmail: ${credentialModal.email}\nUsername: ${credentialModal.username}\nPassword Sementara: ${credentialModal.temporaryPassword}\nCatatan: Berlaku 7 hari. Wajib ganti password saat login pertama.`;
                  handleCopy(allInfo, 'ALL');
                }}
                className="flex-1 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs transition cursor-pointer"
              >
                {copySuccess === 'ALL' ? '✓ Semua Info Tersalin' : 'Salin Semua Info Login'}
              </button>
              <button
                type="button"
                onClick={handleDismissCredentialModal}
                className="flex-1 py-2.5 rounded-xl bg-[#1b4332] hover:bg-[#143326] text-white font-bold text-xs transition cursor-pointer shadow-xs"
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
    </div>
  );
};
