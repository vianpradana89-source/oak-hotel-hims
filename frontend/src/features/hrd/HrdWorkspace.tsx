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
  username?: string;
  email?: string;
  phone?: string;
  position?: string;
  is_active: boolean;
  created_at: string;
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
  const [showResetModal, setShowResetModal] = useState(false);
  const [resetTargetEmployee, setResetTargetEmployee] = useState<HrEmployee | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = useState('OakHotel2026!');
  const [resetSuccessNotice, setResetSuccessNotice] = useState<string | null>(null);

  const [editingEmployee, setEditingEmployee] = useState<HrEmployee | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const [formPayload, setFormPayload] = useState({
    name: '',
    username: '',
    email: '',
    password: '',
    phone: '',
    role: 'Front Office',
    department: 'Front Office',
    is_active: true
  });

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
      const [usersRes, rolesRes] = await Promise.all([
        fetch(`/api/users?property_id=${propertyId}`, { headers: getAuthHeaders() }),
        fetch(`/api/hrd/roles?property_id=${propertyId}`, { headers: getAuthHeaders() })
      ]);

      const usersData = await usersRes.json();
      const rolesData = await rolesRes.json();

      if (usersData.status === 'OK' && Array.isArray(usersData.data)) {
        setEmployees(usersData.data);
      } else {
        // Fallback to legacy hrd endpoint if users table is empty
        const empRes = await fetch(`/api/hrd/employees?property_id=${propertyId}`, { headers: getAuthHeaders() });
        const empData = await empRes.json();
        if (empData.status === 'OK') setEmployees(empData.data || []);
      }

      if (rolesData.status === 'OK') {
        setAvailableRoles(rolesData.data?.available_roles || [
          { role: 'Super Admin', category: 'MANAGEMENT', description: 'Akses penuh seluruh sistem' },
          { role: 'Front Office', category: 'OPERATIONAL', description: 'Reservasi, check-in, check-out' },
          { role: 'Accounting', category: 'FINANCE', description: 'Keuangan, folio, dan laporan' },
          { role: 'Housekeeping', category: 'OPERATIONAL', description: 'Pembersihan dan status kamar' },
          { role: 'General Manager', category: 'MANAGEMENT', description: 'Pengawasan operasional' },
          { role: 'Crew', category: 'STAFF', description: 'Staf operasional umum' }
        ]);
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
      password: 'OakHotel2026!',
      phone: '',
      role: 'Front Office',
      department: 'Front Office',
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
      password: '',
      phone: emp.phone || '',
      role: emp.role || 'Front Office',
      department: emp.department || 'Front Office',
      is_active: emp.is_active !== false
    });
    setEditingEmployee(emp);
    setShowAddModal(true);
  };

  const handleOpenResetPassword = (emp: HrEmployee) => {
    setResetTargetEmployee(emp);
    setResetPasswordValue('OakHotel2026!');
    setResetSuccessNotice(null);
    setShowResetModal(true);
  };

  const handleExecuteResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetTargetEmployee) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/users/${resetTargetEmployee.id}/reset-password`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ new_password: resetPasswordValue })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal mereset password');
      setResetSuccessNotice(`Password untuk ${resetTargetEmployee.full_name || resetTargetEmployee.username} berhasil direset menjadi: ${resetPasswordValue}`);
      setTimeout(() => {
        setShowResetModal(false);
        setResetTargetEmployee(null);
      }, 2500);
    } catch (err: any) {
      alert(err.message || 'Gagal mereset password');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');
    setSubmitting(true);
    try {
      if (editingEmployee) {
        const res = await fetch(`/api/users/${editingEmployee.id}`, {
          method: 'PUT',
          headers: getAuthHeaders(),
          body: JSON.stringify({
            property_id: propertyId,
            full_name: formPayload.name,
            email: formPayload.email,
            phone: formPayload.phone,
            role: formPayload.role,
            department: formPayload.department,
            is_active: formPayload.is_active
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Gagal memperbarui akun karyawan');
      } else {
        const res = await fetch('/api/users', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({
            property_id: propertyId,
            full_name: formPayload.name,
            username: formPayload.username,
            email: formPayload.email,
            password: formPayload.password || 'OakHotel2026!',
            phone: formPayload.phone,
            role: formPayload.role,
            department: formPayload.department
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Gagal mendaftarkan karyawan');
      }

      setShowAddModal(false);
      await fetchData();
    } catch (err: any) {
      setErrorMessage(err.message || 'Terjadi kesalahan sistem');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleStatus = async (emp: HrEmployee) => {
    const nextStatus = !emp.is_active;
    const actionText = nextStatus ? 'aktifkan' : 'nonaktifkan';
    if (!confirm(`Apakah Anda yakin ingin me-${actionText} akun karyawan "${emp.full_name || emp.username}"?`)) return;

    try {
      const res = await fetch(`/api/users/${emp.id}/status`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify({ is_active: nextStatus })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal memperbarui status');
      await fetchData();
    } catch (err: any) {
      alert(err.message || 'Gagal mengubah status akun');
    }
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
                    <th className="py-3 px-4">Nama Lengkap & ID</th>
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
                            {emp.employee_code || `EMP-${emp.id}`} • @{emp.username || 'user'}
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
                          <span
                            className={`inline-block px-2 py-0.5 rounded-md text-[10px] font-bold uppercase ${
                              emp.is_active !== false
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-rose-100 text-rose-800'
                            }`}
                          >
                            {emp.is_active !== false ? 'Aktif' : 'Nonaktif'}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleOpenResetPassword(emp)}
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
          <div className="bg-white rounded-2xl max-w-md w-full border border-slate-200 shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200">
              <h3 className="font-serif font-bold text-base text-slate-900">
                {editingEmployee ? 'Edit Akun Karyawan' : 'Tambah Akun Karyawan Baru'}
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
                  placeholder="Contoh: Sarah Receptionist"
                  className="w-full p-2.5 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-700 font-bold mb-1">
                    Username Login:
                  </label>
                  <input
                    type="text"
                    value={formPayload.username}
                    onChange={(e) => setFormPayload(p => ({ ...p, username: e.target.value }))}
                    placeholder="sarah.fo"
                    disabled={Boolean(editingEmployee)}
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#1b4332] disabled:bg-slate-100"
                  />
                </div>

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
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">
                  Email Akun <span className="text-red-500">*</span>:
                </label>
                <input
                  type="email"
                  required
                  value={formPayload.email}
                  onChange={(e) => setFormPayload(p => ({ ...p, email: e.target.value }))}
                  placeholder="sarah@oaklawang.com"
                  className="w-full p-2.5 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                />
              </div>

              {!editingEmployee && (
                <div>
                  <label className="block text-slate-700 font-bold mb-1">
                    Password Awal <span className="text-red-500">*</span>:
                  </label>
                  <input
                    type="text"
                    required
                    value={formPayload.password}
                    onChange={(e) => setFormPayload(p => ({ ...p, password: e.target.value }))}
                    placeholder="OakHotel2026!"
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-slate-900 font-mono focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                  />
                  <span className="text-[10px] text-slate-400 mt-0.5 block">
                    Password sementara yang akan digunakan karyawan saat login pertama kali.
                  </span>
                </div>
              )}

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
                  {submitting ? 'Menyimpan...' : 'Simpan Akun'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reset Password Modal */}
      {showResetModal && resetTargetEmployee && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full border border-slate-200 shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200">
              <h3 className="font-serif font-bold text-base text-slate-900">
                Reset Password Karyawan
              </h3>
              <button
                type="button"
                onClick={() => setShowResetModal(false)}
                className="text-slate-400 hover:text-slate-700 text-sm font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            {resetSuccessNotice ? (
              <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold">
                ✓ {resetSuccessNotice}
              </div>
            ) : (
              <form onSubmit={handleExecuteResetPassword} className="space-y-3 text-xs">
                <p className="text-slate-600">
                  Tetapkan password baru untuk karyawan <strong>{resetTargetEmployee.full_name || resetTargetEmployee.username}</strong>:
                </p>

                <div>
                  <label className="block text-slate-700 font-bold mb-1">
                    Password Baru:
                  </label>
                  <input
                    type="text"
                    required
                    value={resetPasswordValue}
                    onChange={(e) => setResetPasswordValue(e.target.value)}
                    placeholder="Minimal 6 karakter"
                    className="w-full p-2.5 rounded-xl border border-slate-300 font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                  />
                </div>

                <div className="pt-3 border-t border-slate-200 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShowResetModal(false)}
                    className="flex-1 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold transition cursor-pointer"
                  >
                    Batal
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="flex-1 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold transition cursor-pointer shadow-xs disabled:bg-slate-300"
                  >
                    {submitting ? 'Memproses...' : 'Reset Password'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
