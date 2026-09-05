import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/AuthContext';
import { RolePermissionsMatrixTab as LegacyMenuMatrixTab } from '../settings/RolePermissionsMatrixTab';
import type { DynamicRole, GranularPermission, GranularMatrixResponse } from './hrdTypes';

interface RolePermissionsTabProps {
  propertyId: number;
  onPermissionsUpdated?: (newMap: Record<string, string[]>) => void;
}

export const RolePermissionsTab: React.FC<RolePermissionsTabProps> = ({
  propertyId,
  onPermissionsUpdated
}) => {
  const { user, authFetch } = useAuth();
  const isPlatformSuperAdmin = user?.role === 'Super Admin';

  const [subTab, setSubTab] = useState<'ROLES' | 'GRANULAR_MATRIX' | 'LEGACY_MENUS'>('ROLES');

  const [roles, setRoles] = useState<DynamicRole[]>([]);
  const [permissions, setPermissions] = useState<GranularPermission[]>([]);
  const [matrix, setMatrix] = useState<Record<number, Record<string, boolean>>>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [savingMatrix, setSavingMatrix] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Hard Delete State (Platform Super Admin Only)
  const [hardDeleteRoleTarget, setHardDeleteRoleTarget] = useState<DynamicRole | null>(null);
  const [deletingRoleHard, setDeletingRoleHard] = useState(false);
  const [hardDeleteRoleError, setHardDeleteRoleError] = useState<string | null>(null);

  // Selected role for Granular Matrix inspection / editing
  const [selectedRoleId, setSelectedRoleId] = useState<number>(0);

  // Role CRUD Modals
  const [showRoleModal, setShowRoleModal] = useState<boolean>(false);
  const [editingRole, setEditingRole] = useState<DynamicRole | null>(null);
  const [roleForm, setRoleForm] = useState({
    name: '',
    description: '',
    sort_order: 10,
    is_active: true
  });
  const [submittingRole, setSubmittingRole] = useState<boolean>(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [rolesRes, matrixRes] = await Promise.all([
        authFetch(`/api/hrd/dynamic-roles?property_id=${propertyId}&include_inactive=true`),
        authFetch(`/api/hrd/permissions/matrix?property_id=${propertyId}`)
      ]);

      const [rolesData, matrixData] = await Promise.all([rolesRes.json(), matrixRes.json()]);

      if (rolesRes.ok && Array.isArray(rolesData.data)) {
        setRoles(rolesData.data);
        if (selectedRoleId === 0 && rolesData.data.length > 0) {
          // Default select the first non-super admin role or first role
          const defaultRole = rolesData.data.find((r: DynamicRole) => r.name !== 'Super Admin') || rolesData.data[0];
          setSelectedRoleId(defaultRole.id);
        }
      }

      if (matrixRes.ok && matrixData.data) {
        const payload: GranularMatrixResponse = matrixData.data;
        setPermissions(payload.permissions || []);
        setMatrix(payload.matrix || {});
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Gagal memuat data peran dan izin' });
    } finally {
      setLoading(false);
    }
  }, [authFetch, propertyId, selectedRoleId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Handle Dynamic Role CRUD
  const handleOpenAddRole = () => {
    setEditingRole(null);
    setRoleForm({
      name: '',
      description: '',
      sort_order: (roles.length + 1) * 10,
      is_active: true
    });
    setFeedback(null);
    setShowRoleModal(true);
  };

  const handleOpenEditRole = (r: DynamicRole) => {
    setEditingRole(r);
    setRoleForm({
      name: r.name,
      description: r.description || '',
      sort_order: r.sort_order ?? 0,
      is_active: r.is_active
    });
    setFeedback(null);
    setShowRoleModal(true);
  };

  const handleSubmitRole = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmittingRole(true);
    setFeedback(null);
    try {
      const url = editingRole
        ? `/api/hrd/roles/${editingRole.id}`
        : '/api/hrd/roles';
      const method = editingRole ? 'PATCH' : 'POST';

      const payload = {
        property_id: propertyId,
        ...roleForm
      };

      const res = await authFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal menyimpan role');

      setFeedback({
        type: 'success',
        message: editingRole ? 'Role berhasil diperbarui' : 'Role baru berhasil ditambahkan'
      });
      setShowRoleModal(false);
      await fetchData();
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message });
    } finally {
      setSubmittingRole(false);
    }
  };

  const handleDeactivateRole = async (r: DynamicRole) => {
    if (r.name === 'Super Admin') return;
    try {
      const res = await authFetch(`/api/hrd/roles/${r.id}?property_id=${propertyId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal menonaktifkan role');

      setFeedback({ type: 'success', message: 'Role berhasil dinonaktifkan' });
      await fetchData();
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message });
    }
  };

  const handleReactivateRole = async (r: DynamicRole) => {
    try {
      const res = await authFetch(`/api/hrd/roles/${r.id}/reactivate?property_id=${propertyId}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal mengaktifkan role');

      setFeedback({ type: 'success', message: 'Role berhasil diaktifkan kembali' });
      await fetchData();
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message });
    }
  };

  const handleExecuteHardDeleteRole = async () => {
    if (!hardDeleteRoleTarget) return;
    setDeletingRoleHard(true);
    setHardDeleteRoleError(null);
    try {
      const res = await authFetch(`/api/hrd/roles/${hardDeleteRoleTarget.id}/hard-delete?property_id=${propertyId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal menghapus role permanen');

      setHardDeleteRoleTarget(null);
      setFeedback({ type: 'success', message: 'Role berhasil dihapus permanen' });
      await fetchData();
    } catch (err: any) {
      setHardDeleteRoleError(err.message || 'Gagal menghapus role permanen');
    } finally {
      setDeletingRoleHard(false);
    }
  };

  // Granular Matrix Toggles
  const handleTogglePermission = (roleId: number, permKey: string) => {
    const selectedRole = roles.find(r => r.id === roleId);
    if (selectedRole?.name === 'Super Admin') return; // Immutable

    setMatrix(prev => {
      const rolePerms = { ...(prev[roleId] || {}) };
      rolePerms[permKey] = !rolePerms[permKey];
      return {
        ...prev,
        [roleId]: rolePerms
      };
    });
  };

  const handleSelectAllForResource = (roleId: number, resourceName: string) => {
    const selectedRole = roles.find(r => r.id === roleId);
    if (selectedRole?.name === 'Super Admin') return;

    setMatrix(prev => {
      const rolePerms = { ...(prev[roleId] || {}) };
      const resourcePerms = permissions.filter(p => p.resource === resourceName);
      for (const p of resourcePerms) {
        rolePerms[p.key] = true;
      }
      return {
        ...prev,
        [roleId]: rolePerms
      };
    });
  };

  const handleClearAllForResource = (roleId: number, resourceName: string) => {
    const selectedRole = roles.find(r => r.id === roleId);
    if (selectedRole?.name === 'Super Admin') return;

    setMatrix(prev => {
      const rolePerms = { ...(prev[roleId] || {}) };
      const resourcePerms = permissions.filter(p => p.resource === resourceName);
      for (const p of resourcePerms) {
        rolePerms[p.key] = false;
      }
      return {
        ...prev,
        [roleId]: rolePerms
      };
    });
  };

  const handleSaveGranularPermissions = async () => {
    if (!selectedRoleId) return;
    const currentRole = roles.find(r => r.id === selectedRoleId);
    if (currentRole?.name === 'Super Admin') return;

    setSavingMatrix(true);
    setFeedback(null);
    try {
      const rolePerms = matrix[selectedRoleId] || {};
      const activeKeys = Object.keys(rolePerms).filter(k => rolePerms[k]);

      const res = await authFetch(`/api/hrd/roles/${selectedRoleId}/permissions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permission_keys: activeKeys })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal menyimpan hak akses granular');

      setFeedback({
        type: 'success',
        message: `Hak akses granular untuk "${currentRole?.name}" berhasil disimpan (${activeKeys.length} izin aktif).`
      });
      await fetchData();
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message });
    } finally {
      setSavingMatrix(false);
    }
  };

  // Group permissions by resource
  const uniqueResources = Array.from(new Set(permissions.map(p => p.resource)));
  const actionsList = ['view', 'create', 'edit', 'delete', 'approve'];

  const selectedRoleObj = roles.find(r => r.id === selectedRoleId);
  const isSuperAdminSelected = selectedRoleObj?.name === 'Super Admin';

  return (
    <div className="space-y-6">
      {feedback && (
        <div
          className={`p-3 rounded-xl border text-xs font-semibold flex items-center justify-between ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}
        >
          <span>{feedback.message}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-slate-400 hover:text-slate-600 font-bold ml-2"
          >
            ✕
          </button>
        </div>
      )}

      {/* Internal Sub-Navigation */}
      <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
        <button
          type="button"
          onClick={() => setSubTab('ROLES')}
          className={`px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 cursor-pointer ${
            subTab === 'ROLES'
              ? 'bg-[#1b4332] text-white shadow-xs'
              : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
          }`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
          </svg>
          Daftar Peran / Role ({roles.length})
        </button>

        <button
          type="button"
          onClick={() => setSubTab('GRANULAR_MATRIX')}
          className={`px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 cursor-pointer ${
            subTab === 'GRANULAR_MATRIX'
              ? 'bg-[#1b4332] text-white shadow-xs'
              : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
          }`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          Matrix Granular Permission (13 Modul x 5 Aksi)
        </button>

        <button
          type="button"
          onClick={() => setSubTab('LEGACY_MENUS')}
          className={`px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 cursor-pointer ${
            subTab === 'LEGACY_MENUS'
              ? 'bg-[#1b4332] text-white shadow-xs'
              : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
          }`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
          </svg>
          Menu Navigasi SOP (Legacy)
        </button>
      </div>

      {/* ===================================================================== */}
      {/* SUB-TAB 1: DAFTAR DYNAMIC ROLES */}
      {/* ===================================================================== */}
      {subTab === 'ROLES' && (
        <div className="bg-white border border-slate-200/90 rounded-2xl shadow-xs overflow-hidden">
          <div className="p-4 border-b border-slate-100 flex items-center justify-between gap-3 bg-slate-50/50">
            <div>
              <h2 className="font-serif font-bold text-slate-900 text-sm flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-[#1b4332]" />
                Katalog Peran & Tingkat Otorisasi
              </h2>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Role menentukan bundel izin akses pengguna. Terpisah dari Departemen dan Jabatan.
              </p>
            </div>
            <button
              type="button"
              onClick={handleOpenAddRole}
              className="px-3 py-1.5 rounded-xl bg-[#1b4332] text-white hover:bg-[#143326] transition font-bold text-xs shadow-xs cursor-pointer flex items-center gap-1.5 shrink-0"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
              </svg>
              Tambah Custom Role
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/80 text-slate-600 font-bold">
                  <th className="py-2.5 px-4">Nama Peran / Role</th>
                  <th className="py-2.5 px-4">Deskripsi</th>
                  <th className="py-2.5 px-4 text-center">Tipe</th>
                  <th className="py-2.5 px-4 text-center">Status</th>
                  <th className="py-2.5 px-4 text-center">Pengguna Aktif</th>
                  <th className="py-2.5 px-4 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-slate-400">
                      Memuat daftar role...
                    </td>
                  </tr>
                ) : (
                  roles.map(r => (
                    <tr key={r.id} className="hover:bg-slate-50/50 transition">
                      <td className="py-3 px-4 font-bold text-slate-900">
                        {r.name}
                        {r.name === 'Super Admin' && (
                          <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-extrabold bg-amber-100 text-amber-800 border border-amber-200">
                            PROTECTED
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-slate-600 max-w-xs">
                        {r.description || '—'}
                      </td>
                      <td className="py-3 px-4 text-center">
                        {r.is_system_role ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200">
                            Sistem
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-sky-50 text-sky-800 border border-sky-200">
                            Kustom
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-center">
                        {r.is_active ? (
                          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">
                            Aktif
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-500">
                            Nonaktif
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-100">
                          {r.active_user_count ?? r.user_count ?? 0}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right space-x-1 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedRoleId(r.id);
                            setSubTab('GRANULAR_MATRIX');
                          }}
                          className="px-2 py-1 text-[11px] font-semibold text-[#1b4332] bg-[#1b4332]/10 hover:bg-[#1b4332]/20 rounded-lg transition"
                        >
                          Atur Izin
                        </button>
                        {r.name !== 'Super Admin' && (
                          <>
                            {r.is_active ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => handleOpenEditRole(r)}
                                  className="px-2 py-1 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition cursor-pointer"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeactivateRole(r)}
                                  className="px-2 py-1 text-[11px] font-semibold text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg transition cursor-pointer"
                                  title="Nonaktifkan Role"
                                >
                                  Nonaktifkan
                                </button>
                                {isPlatformSuperAdmin && !r.is_system_role && (
                                  <button
                                    type="button"
                                    onClick={() => { setHardDeleteRoleTarget(r); setHardDeleteRoleError(null); }}
                                    className="px-2 py-1 text-[11px] font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition cursor-pointer"
                                    title="Hapus Permanen (Super Admin Only)"
                                  >
                                    Hapus
                                  </button>
                                )}
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  onClick={() => handleReactivateRole(r)}
                                  className="px-2 py-1 text-[11px] font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition cursor-pointer"
                                  title="Aktifkan Kembali Role"
                                >
                                  Aktifkan
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleOpenEditRole(r)}
                                  className="px-2 py-1 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition cursor-pointer"
                                >
                                  Edit
                                </button>
                                {isPlatformSuperAdmin && !r.is_system_role && (
                                  <button
                                    type="button"
                                    onClick={() => { setHardDeleteRoleTarget(r); setHardDeleteRoleError(null); }}
                                    className="px-2 py-1 text-[11px] font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition cursor-pointer"
                                    title="Hapus Permanen (Super Admin Only)"
                                  >
                                    Hapus
                                  </button>
                                )}
                              </>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* SUB-TAB 2: GRANULAR PERMISSION MATRIX */}
      {/* ===================================================================== */}
      {subTab === 'GRANULAR_MATRIX' && (
        <div className="bg-white border border-slate-200/90 rounded-2xl shadow-xs overflow-hidden space-y-4">
          <div className="p-4 border-b border-slate-100 flex flex-col md:flex-row md:items-center md:justify-between gap-3 bg-slate-50/50">
            <div>
              <h2 className="font-serif font-bold text-slate-900 text-sm flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-[#1b4332]" />
                Matriks Granular Permission ({uniqueResources.length} Modul × {actionsList.length} Aksi)
              </h2>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Konfigurasi izin teknis backend (view, create, edit, delete, approve) per sumber daya hotel.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <label className="text-xs font-bold text-slate-700 flex items-center gap-2">
                Pilih Peran:
                <select
                  value={selectedRoleId}
                  onChange={e => setSelectedRoleId(Number(e.target.value))}
                  className="px-3 py-1.5 rounded-xl border border-slate-300 bg-white font-bold text-slate-800 text-xs focus:ring-2 focus:ring-[#1b4332]"
                >
                  {roles.map(r => (
                    <option key={r.id} value={r.id}>
                      {r.name} {r.is_system_role ? '(Sistem)' : '(Kustom)'}
                    </option>
                  ))}
                </select>
              </label>

              {!isSuperAdminSelected && (
                <button
                  type="button"
                  onClick={handleSaveGranularPermissions}
                  disabled={savingMatrix}
                  className="px-4 py-1.5 rounded-xl bg-[#1b4332] text-white hover:bg-[#143326] transition font-bold text-xs shadow-xs cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
                >
                  {savingMatrix ? 'Menyimpan...' : 'Simpan Hak Akses'}
                </button>
              )}
            </div>
          </div>

          {isSuperAdminSelected && (
            <div className="mx-4 p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs flex items-center gap-2">
              <span className="font-bold">🔒 Hak Akses Penuh:</span>
              <span>Super Admin memiliki otorisasi penuh di seluruh modul sistem dan terkunci secara permanen.</span>
            </div>
          )}

          <div className="overflow-x-auto px-4 pb-4">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-700 font-bold">
                  <th className="py-2.5 px-3">Modul / Resource</th>
                  {actionsList.map(action => (
                    <th key={action} className="py-2.5 px-3 text-center uppercase tracking-wider text-[11px]">
                      {action}
                    </th>
                  ))}
                  <th className="py-2.5 px-3 text-right">Aksi Cepat</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {uniqueResources.map(resName => {
                  const currentRolePerms = matrix[selectedRoleId] || {};

                  return (
                    <tr key={resName} className="hover:bg-slate-50/50 transition">
                      <td className="py-2.5 px-3 font-semibold text-slate-900 font-mono">
                        {resName}
                      </td>

                      {actionsList.map(action => {
                        const permKey = `${resName}.${action}`;
                        const isGranted = Boolean(currentRolePerms[permKey]) || isSuperAdminSelected;

                        return (
                          <td key={action} className="py-2.5 px-3 text-center">
                            <input
                              type="checkbox"
                              checked={isGranted}
                              disabled={isSuperAdminSelected}
                              onChange={() => handleTogglePermission(selectedRoleId, permKey)}
                              className="w-4 h-4 rounded text-[#1b4332] focus:ring-[#1b4332] cursor-pointer disabled:opacity-75"
                            />
                          </td>
                        );
                      })}

                      <td className="py-2.5 px-3 text-right space-x-1">
                        {!isSuperAdminSelected && (
                          <>
                            <button
                              type="button"
                              onClick={() => handleSelectAllForResource(selectedRoleId, resName)}
                              className="px-2 py-0.5 text-[10px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded"
                            >
                              Semua
                            </button>
                            <button
                              type="button"
                              onClick={() => handleClearAllForResource(selectedRoleId, resName)}
                              className="px-2 py-0.5 text-[10px] font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 rounded"
                            >
                              Hapus
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* SUB-TAB 3: LEGACY SOP MENUS */}
      {/* ===================================================================== */}
      {subTab === 'LEGACY_MENUS' && (
        <LegacyMenuMatrixTab
          propertyId={propertyId}
          onPermissionsUpdated={onPermissionsUpdated}
        />
      )}

      {/* ===================================================================== */}
      {/* MODAL: ADD / EDIT ROLE */}
      {/* ===================================================================== */}
      {showRoleModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full border border-slate-200 shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <h3 className="font-serif font-bold text-base text-slate-900">
                {editingRole ? 'Edit Peran / Role' : 'Tambah Role Kustom Baru'}
              </h3>
              <button
                type="button"
                onClick={() => setShowRoleModal(false)}
                className="text-slate-400 hover:text-slate-700 text-sm font-bold"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmitRole} className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-700 font-bold mb-1">
                  Nama Peran / Role <span className="text-red-500">*</span>:
                </label>
                <input
                  type="text"
                  required
                  value={roleForm.name}
                  onChange={e => setRoleForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Contoh: Duty Manager, Night Auditor, Linen Runner"
                  className="w-full p-2 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">
                  Deskripsi Peran:
                </label>
                <textarea
                  rows={2}
                  value={roleForm.description}
                  onChange={e => setRoleForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Keterangan otorisasi dan fungsi peran..."
                  className="w-full p-2 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-bold mb-1">
                    Nomor Urut Tampilan:
                  </label>
                  <input
                    type="number"
                    value={roleForm.sort_order}
                    onChange={e => setRoleForm(f => ({ ...f, sort_order: Number(e.target.value) }))}
                    className="w-full p-2 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                  />
                </div>

                <div className="flex items-center pt-5">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={roleForm.is_active}
                      onChange={e => setRoleForm(f => ({ ...f, is_active: e.target.checked }))}
                      className="w-4 h-4 rounded text-[#1b4332] focus:ring-[#1b4332]"
                    />
                    <span className="font-bold text-slate-800">Status Aktif</span>
                  </label>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowRoleModal(false)}
                  className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 font-bold"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={submittingRole}
                  className="px-4 py-2 rounded-xl bg-[#1b4332] text-white hover:bg-[#143326] font-bold shadow-xs disabled:opacity-50"
                >
                  {submittingRole ? 'Menyimpan...' : 'Simpan Role'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Hard Delete Role Modal (Platform Super Admin Only) */}
      {hardDeleteRoleTarget && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full border border-slate-200 shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200">
              <h3 className="font-serif font-bold text-base text-rose-900">
                Hapus Role
              </h3>
              <button
                type="button"
                onClick={() => { setHardDeleteRoleTarget(null); setHardDeleteRoleError(null); }}
                className="text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-600">
              Yakin ingin menghapus data ini? Data akan dihapus permanen.
            </p>

            {hardDeleteRoleError && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs">
                {hardDeleteRoleError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={() => { setHardDeleteRoleTarget(null); setHardDeleteRoleError(null); }}
                className="px-4 py-2 rounded-xl text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 transition cursor-pointer"
                disabled={deletingRoleHard}
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleExecuteHardDeleteRole}
                disabled={deletingRoleHard}
                className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 transition cursor-pointer disabled:opacity-50"
              >
                {deletingRoleHard ? 'Menghapus...' : 'Hapus'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
