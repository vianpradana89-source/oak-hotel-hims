import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/AuthContext';
import { RoleAccessTab } from '../settings/RoleAccessTab';
import { UserAccessTab } from '../settings/UserAccessTab';
import type { DynamicRole } from './hrdTypes';
import { HRD_ACTION_CELL, HrdActionCluster, HrdActionIcons, HrdIconAction } from './hrdActionUi';

interface RolePermissionsTabProps {
  propertyId: number;
  // Retained for the legacy navigation map contract used by HrdWorkspace.
  // Role access changes now propagate through the effective-permission API.
  onPermissionsUpdated?: (newMap: Record<string, string[]>) => void;
}

export const RolePermissionsTab: React.FC<RolePermissionsTabProps> = ({
  propertyId
}) => {
  const { user, authFetch } = useAuth();
  const isPlatformSuperAdmin = user?.role === 'Super Admin';

  const [subTab, setSubTab] = useState<'ROLE_ACCESS' | 'USER_ACCESS'>('ROLE_ACCESS');

  const [roles, setRoles] = useState<DynamicRole[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Hard Delete State (Platform Super Admin Only)
  const [hardDeleteRoleTarget, setHardDeleteRoleTarget] = useState<DynamicRole | null>(null);
  const [deletingRoleHard, setDeletingRoleHard] = useState(false);
  const [hardDeleteRoleError, setHardDeleteRoleError] = useState<string | null>(null);

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
      const rolesRes = await authFetch(`/api/hrd/dynamic-roles?property_id=${propertyId}&include_inactive=true`);
      const rolesData = await rolesRes.json();
      if (rolesRes.ok && Array.isArray(rolesData.data)) {
        setRoles(rolesData.data);
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Gagal memuat data peran dan izin' });
    } finally {
      setLoading(false);
    }
  }, [authFetch, propertyId]);

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
          onClick={() => setSubTab('ROLE_ACCESS')}
          className={`px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 cursor-pointer ${
            subTab === 'ROLE_ACCESS'
              ? 'bg-[#1b4332] text-white shadow-xs'
              : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
          }`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
          </svg>
          Hak Akses Role ({roles.length})
        </button>

        <button
          type="button"
          onClick={() => setSubTab('USER_ACCESS')}
          className={`px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 cursor-pointer ${
            subTab === 'USER_ACCESS'
              ? 'bg-[#1b4332] text-white shadow-xs'
              : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
          }`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
          Hak Akses Pengguna
        </button>
      </div>

      {/* ===================================================================== */}
      {/* TAB 1: HAK AKSES ROLE — role catalog + View/Edit/Delete access grid */}
      {/* ===================================================================== */}
      {subTab === 'ROLE_ACCESS' && (
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

          <div className="overflow-x-hidden">
            <table className="w-full table-fixed text-left border-collapse text-xs">
              <colgroup>
                <col className="w-[22%]" />
                <col className="w-[32%]" />
                <col className="w-[11%]" />
                <col className="w-[11%]" />
                <col className="w-[12%]" />
                <col className="w-[12%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/80 text-slate-600 font-bold">
                  <th className="py-2.5 px-3">Nama Peran / Role</th>
                  <th className="py-2.5 px-3">Deskripsi</th>
                  <th className="py-2.5 px-2 text-center">Tipe</th>
                  <th className="py-2.5 px-2 text-center">Status</th>
                  <th className="py-2.5 px-2 text-center leading-tight">Pengguna Aktif</th>
                  <th className={`py-2.5 ${HRD_ACTION_CELL}`}>Aksi</th>
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
                      <td className="py-3 px-3 font-bold text-slate-900 min-w-0 break-words">
                        {r.name}
                        {r.name === 'Super Admin' && (
                          <span className="ml-1.5 align-middle px-1.5 py-0.5 rounded text-[9px] font-extrabold bg-amber-100 text-amber-800 border border-amber-200 whitespace-nowrap">
                            PROTECTED
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-3 text-slate-600 min-w-0 break-words leading-snug">
                        {r.description || '—'}
                      </td>
                      <td className="py-3 px-2 text-center">
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
                      <td className="py-3 px-2 text-center">
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
                      <td className="py-3 px-2 text-center">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-100">
                          {r.active_user_count ?? r.user_count ?? 0}
                        </span>
                      </td>
                      <td className={`py-3 ${HRD_ACTION_CELL}`}>
                        {r.name === 'Super Admin' ? (
                          <span className="sr-only">Role Platform Super Admin dilindungi</span>
                        ) : (
                          <HrdActionCluster>
                            <HrdIconAction
                              label="Edit"
                              icon={HrdActionIcons.pencil}
                              onClick={() => handleOpenEditRole(r)}
                            />
                            {r.is_active ? (
                              <HrdIconAction
                                label="Nonaktifkan Role"
                                icon={HrdActionIcons.power}
                                tone="warning"
                                onClick={() => handleDeactivateRole(r)}
                              />
                            ) : (
                              <HrdIconAction
                                label="Aktifkan Kembali Role"
                                icon={HrdActionIcons.power}
                                tone="success"
                                onClick={() => handleReactivateRole(r)}
                              />
                            )}
                            {isPlatformSuperAdmin && !r.is_system_role && (
                              <HrdIconAction
                                label="Hapus Permanen (Super Admin Only)"
                                icon={HrdActionIcons.trash}
                                tone="danger"
                                onClick={() => { setHardDeleteRoleTarget(r); setHardDeleteRoleError(null); }}
                              />
                            )}
                          </HrdActionCluster>
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

      {subTab === 'ROLE_ACCESS' && (
        <RoleAccessTab propertyId={propertyId} onAccessUpdated={fetchData} />
      )}

      {/* ===================================================================== */}
      {/* TAB 2: HAK AKSES PENGGUNA — per-user overrides on top of role default */}
      {/* ===================================================================== */}
      {subTab === 'USER_ACCESS' && <UserAccessTab propertyId={propertyId} />}

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
