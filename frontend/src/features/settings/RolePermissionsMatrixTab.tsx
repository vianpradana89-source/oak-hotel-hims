import React, { useState, useEffect, useCallback } from 'react';
import {
  SYSTEM_AVAILABLE_MENUS,
  STANDARD_ROLE_LIST,
  type MenuItemMeta
} from '../auth/permissions';
import { useAuth } from '../auth/AuthContext';

export interface RolePermissionsMatrixTabProps {
  propertyId: number;
  onPermissionsUpdated?: (newMatrixMap: Record<string, string[]>) => void;
}

export const RolePermissionsMatrixTab: React.FC<RolePermissionsMatrixTabProps> = ({
  propertyId,
  onPermissionsUpdated
}) => {
  const { authFetch } = useAuth();
  const [matrixState, setMatrixState] = useState<Record<string, string[]>>({});
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isResetting, setIsResetting] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [lastUpdatedInfo, setLastUpdatedInfo] = useState<string | null>(null);

  // Group menus by department/group
  const menuGroups: { groupName: string; menus: MenuItemMeta[] }[] = [
    {
      groupName: 'Front Office & Pelayanan Tamu',
      menus: SYSTEM_AVAILABLE_MENUS.filter((m) => m.group === 'Front Office')
    },
    {
      groupName: 'Departemen Operasional',
      menus: SYSTEM_AVAILABLE_MENUS.filter((m) => m.group === 'Departemen')
    },
    {
      groupName: 'Manajemen & Konfigurasi Hotel',
      menus: SYSTEM_AVAILABLE_MENUS.filter((m) => m.group === 'Manajemen')
    },
    {
      groupName: 'Portal Staf & Mobile',
      menus: SYSTEM_AVAILABLE_MENUS.filter((m) => m.group === 'Operasional')
    }
  ];

  const fetchMatrix = useCallback(async () => {
    setIsLoading(true);
    setFeedback(null);
    try {
      const res = await authFetch(`/api/settings/role-permissions?property_id=${propertyId}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Gagal mengambil data hak akses');

      const data = json.data;
      const initialMap: Record<string, string[]> = {};
      if (Array.isArray(data.roles)) {
        for (const r of data.roles) {
          initialMap[r.role] = r.permissions || [];
        }
      }
      setMatrixState(initialMap);
      setLastUpdatedInfo(new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }));
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Gagal memuat konfigurasi hak akses.' });
    } finally {
      setIsLoading(false);
    }
  }, [propertyId, authFetch]);

  useEffect(() => {
    fetchMatrix();
  }, [fetchMatrix]);

  const handleToggle = (role: string, menuKey: string) => {
    if (role === 'Super Admin') return; // Locked

    setMatrixState((prev) => {
      const currentList = prev[role] || [];
      const hasPermission = currentList.includes(menuKey);
      const nextList = hasPermission
        ? currentList.filter((k) => k !== menuKey)
        : [...currentList, menuKey];

      return {
        ...prev,
        [role]: nextList
      };
    });
  };

  const handleSelectAllForRole = (role: string) => {
    if (role === 'Super Admin') return;
    setMatrixState((prev) => ({
      ...prev,
      [role]: SYSTEM_AVAILABLE_MENUS.map((m) => m.key)
    }));
  };

  const handleClearAllForRole = (role: string) => {
    if (role === 'Super Admin') return;
    setMatrixState((prev) => ({
      ...prev,
      [role]: []
    }));
  };

  const handleSave = async () => {
    setIsSaving(true);
    setFeedback(null);
    try {
      const rolesPayload = Object.entries(matrixState).map(([role, permissions]) => ({
        role,
        permissions
      }));

      const res = await authFetch('/api/settings/role-permissions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          roles: rolesPayload
        })
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Gagal menyimpan perubahan');

      setFeedback({
        type: 'success',
        message: 'Pengaturan matriks hak akses berhasil disimpan ke sistem OAK.'
      });
      setLastUpdatedInfo(new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }));

      if (onPermissionsUpdated) {
        onPermissionsUpdated(matrixState);
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Gagal menyimpan hak akses.' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleResetToSop = async () => {
    if (!window.confirm('Kembalikan seluruh hak akses role ke standar default SOP OAK Hotel?')) {
      return;
    }

    setIsResetting(true);
    setFeedback(null);
    try {
      const res = await authFetch('/api/settings/role-permissions/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId })
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Gagal mereset ke SOP');

      const data = json.data;
      const resetMap: Record<string, string[]> = {};
      if (Array.isArray(data.roles)) {
        for (const r of data.roles) {
          resetMap[r.role] = r.permissions || [];
        }
      }
      setMatrixState(resetMap);
      setFeedback({
        type: 'success',
        message: 'Matriks hak akses role berhasil dipulihkan ke standar baku SOP OAK Hotel.'
      });

      if (onPermissionsUpdated) {
        onPermissionsUpdated(resetMap);
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Gagal mereset ke default SOP.' });
    } finally {
      setIsResetting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="bg-white border border-slate-200/90 rounded-2xl p-12 text-center shadow-xs">
        <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#1b4332] mb-3"></div>
        <p className="text-xs text-slate-500 font-medium">Memuat matriks hak akses role properti...</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Top Action & Information Header */}
      <div className="bg-white border border-slate-200/90 rounded-2xl p-5 shadow-xs flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 rounded-full text-xs font-extrabold bg-[#1b4332]/10 text-[#1b4332] border border-[#1b4332]/20">
              RBAC MATRIX
            </span>
            <h2 className="text-base font-bold font-serif text-slate-900">
              Pengaturan Hak Akses Role (Dynamic Permissions)
            </h2>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Centang menu yang boleh diakses oleh masing-masing jabatan staf. Perubahan akan langsung memfilter navigasi sidebar dan memproteksi rute halaman secara dinamis.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleResetToSop}
            disabled={isResetting || isSaving}
            className="px-3.5 py-2 rounded-xl text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 transition border border-slate-300 disabled:opacity-50 cursor-pointer"
          >
            {isResetting ? 'Mereset...' : 'Reset ke Default SOP'}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving || isResetting}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-xs font-bold text-white bg-[#1b4332] hover:bg-[#143326] transition shadow-xs disabled:opacity-50 cursor-pointer"
          >
            {isSaving ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                Menyimpan...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                </svg>
                Simpan Hak Akses
              </>
            )}
          </button>
        </div>
      </div>

      {/* Feedback Banner */}
      {feedback && (
        <div
          className={`p-4 rounded-xl border text-xs flex items-center justify-between ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}
        >
          <div className="flex items-center gap-2">
            <span>{feedback.type === 'success' ? '✓' : '⚠️'}</span>
            <span className="font-medium">{feedback.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-slate-400 hover:text-slate-600 font-bold ml-4"
          >
            ✕
          </button>
        </div>
      )}

      {/* Matrix Table */}
      <div className="bg-white border border-slate-200/90 rounded-2xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[900px]">
            <thead>
              <tr className="bg-slate-900 text-white text-xs font-serif uppercase tracking-wider">
                <th className="p-4 w-[280px] border-b border-slate-800 sticky left-0 bg-slate-900 z-10">
                  Modul & Menu Sistem
                </th>
                {STANDARD_ROLE_LIST.map((roleName: string) => (
                  <th key={roleName} className="p-4 text-center border-b border-slate-800 min-w-[110px]">
                    <div className="font-bold normal-case text-sm tracking-normal">{roleName}</div>
                    {roleName === 'Super Admin' ? (
                      <span className="mt-1 inline-block text-[10px] bg-amber-400/20 text-amber-300 px-2 py-0.5 rounded-full font-mono font-medium">
                        Kunci Sistem
                      </span>
                    ) : (
                      <div className="mt-1.5 flex items-center justify-center gap-1.5 font-sans normal-case text-[10px] font-normal text-slate-300">
                        <button
                          type="button"
                          onClick={() => handleSelectAllForRole(roleName)}
                          className="hover:underline text-emerald-400 cursor-pointer"
                        >
                          Semua
                        </button>
                        <span>|</span>
                        <button
                          type="button"
                          onClick={() => handleClearAllForRole(roleName)}
                          className="hover:underline text-rose-300 cursor-pointer"
                        >
                          Kosong
                        </button>
                      </div>
                    )}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-100 text-xs">
              {menuGroups.map((group) => (
                <React.Fragment key={group.groupName}>
                  {/* Department Group Header */}
                  <tr className="bg-[#fcfbf9] font-bold text-slate-800">
                    <td colSpan={STANDARD_ROLE_LIST.length + 1} className="px-4 py-2 text-[11px] uppercase tracking-wider text-[#1b4332] bg-emerald-50/60 border-y border-emerald-100">
                      {group.groupName}
                    </td>
                  </tr>

                  {/* Menu Rows */}
                  {group.menus.map((menu) => (
                    <tr key={menu.key} className="hover:bg-slate-50/80 transition-colors">
                      {/* Menu Info */}
                      <td className="p-4 border-r border-slate-100 sticky left-0 bg-white hover:bg-slate-50/80 z-0">
                        <div className="font-bold text-slate-900 text-xs">{menu.label}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5 leading-snug">{menu.description}</div>
                      </td>

                      {/* Checkbox per Role */}
                      {STANDARD_ROLE_LIST.map((roleName: string) => {
                        const isSuperAdmin = roleName === 'Super Admin';
                        const isChecked = isSuperAdmin || (matrixState[roleName] || []).includes(menu.key);

                        return (
                          <td key={roleName} className="p-3 text-center border-r border-slate-100 last:border-r-0">
                            <label className="inline-flex items-center justify-center cursor-pointer p-1">
                              <input
                                type="checkbox"
                                checked={isChecked}
                                disabled={isSuperAdmin}
                                onChange={() => handleToggle(roleName, menu.key)}
                                className={`w-4 h-4 rounded text-[#1b4332] focus:ring-[#1b4332] transition ${
                                  isSuperAdmin
                                    ? 'opacity-60 cursor-not-allowed text-slate-400 accent-amber-600'
                                    : 'cursor-pointer accent-[#1b4332]'
                                }`}
                              />
                            </label>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer Info */}
        <div className="p-4 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between text-[11px] text-slate-500 gap-2">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block"></span>
            <span>Role <strong>Super Admin</strong> selalu memiliki akses penuh ke seluruh fitur untuk keamanan operasional hotel.</span>
          </div>
          {lastUpdatedInfo && (
            <div className="text-slate-400">
              Pembaruan terakhir: {lastUpdatedInfo}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
