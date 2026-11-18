import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import {
  ACCESS_ACTIONS,
  TABLE_ACTIONS,
  ACCESS_ACTION_LABELS,
  MODULE_SUPPORTED_ACTIONS,
  buildOverrideLookup,
  getOverrideChoice,
  groupResources,
  resolveEffectiveCell,
  toggleUserOverride,
  type AccessAction,
  type AccessResource,
  type AccessUserSummary,
  type EffectiveAccessResponse,
  type OverrideChoice,
} from '../auth/accessControl';
import { BlueCircleCheck } from './BlueCircleCheck';

interface UserAccessTabProps {
  propertyId: number;
}

export const UserAccessTab: React.FC<UserAccessTabProps> = ({ propertyId }) => {
  const { authFetch, refreshEffectiveAccess } = useAuth();

  const [users, setUsers] = useState<AccessUserSummary[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<number>(0);
  const [detail, setDetail] = useState<EffectiveAccessResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, OverrideChoice>>({});
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const fetchUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const res = await authFetch(`/api/access-control/users?property_id=${propertyId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal memuat daftar pengguna.');
      const list: AccessUserSummary[] = data.data.users || [];
      setUsers(list);
      setSelectedUserId(prev => (prev && list.some(u => u.user_id === prev) ? prev : list[0]?.user_id || 0));
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Gagal memuat daftar pengguna.' });
    } finally {
      setLoadingUsers(false);
    }
  }, [authFetch, propertyId]);

  const fetchDetail = useCallback(async (userId: number) => {
    if (!userId) {
      setDetail(null);
      return;
    }
    setLoadingDetail(true);
    try {
      const res = await authFetch(`/api/access-control/users/${userId}?property_id=${propertyId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal memuat hak akses pengguna.');
      const payload: EffectiveAccessResponse = data.data;
      setDetail(payload);
      const lookup = buildOverrideLookup(payload.overrides || []);
      const nextDraft: Record<string, OverrideChoice> = {};
      for (const resource of payload.resources || []) {
        for (const action of ACCESS_ACTIONS) {
          nextDraft[`${resource.key}::${action}`] = getOverrideChoice(lookup, resource.key, action);
        }
      }
      setDraft(nextDraft);
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Gagal memuat hak akses pengguna.' });
    } finally {
      setLoadingDetail(false);
    }
  }, [authFetch, propertyId]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);
  useEffect(() => { fetchDetail(selectedUserId); }, [fetchDetail, selectedUserId]);

  const isDirty = useMemo(() => {
    if (!detail) return false;
    const lookup = buildOverrideLookup(detail.overrides || []);
    return Object.entries(draft).some(([cell, choice]) => {
      const [resource, action] = cell.split('::');
      return getOverrideChoice(lookup, resource, action as AccessAction) !== choice;
    });
  }, [detail, draft]);

  const handleSave = async () => {
    if (!detail) return;
    setSaving(true);
    setFeedback(null);
    try {
      const overrides = Object.entries(draft).map(([cell, effect]) => {
        const [resource, action] = cell.split('::');
        return { resource, action, effect };
      });
      const res = await authFetch(`/api/access-control/users/${detail.user_id}/overrides`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId, overrides }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal menyimpan hak akses pengguna.');
      setFeedback({ type: 'success', message: `Hak akses "${detail.full_name}" berhasil disimpan.` });
      await fetchUsers();
      await fetchDetail(detail.user_id);
      await refreshEffectiveAccess();
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Gagal menyimpan hak akses pengguna.' });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!detail) return;
    setResetting(true);
    setFeedback(null);
    try {
      const res = await authFetch(`/api/access-control/users/${detail.user_id}/overrides/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal mereset hak akses pengguna.');
      setFeedback({ type: 'success', message: `Hak akses "${detail.full_name}" dikembalikan ke default role.` });
      await fetchUsers();
      await fetchDetail(detail.user_id);
      await refreshEffectiveAccess();
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Gagal mereset hak akses pengguna.' });
    } finally {
      setResetting(false);
    }
  };

  const allGrouped = useMemo(() => groupResources(detail?.resources || []), [detail]);
  const standardGroups = useMemo(() => allGrouped.filter(g => g.group !== 'Otorisasi Khusus'), [allGrouped]);
  const specialAuthResources: AccessResource[] = useMemo(() => {
    const specialGroup = allGrouped.find(g => g.group === 'Otorisasi Khusus');
    return specialGroup?.resources || [];
  }, [allGrouped]);

  const selectedUser = users.find(u => u.user_id === selectedUserId) || null;
  const isSuperAdminTarget = detail?.is_platform_super_admin === true;

  if (loadingUsers) {
    return <div className="p-8 text-center text-xs text-slate-400">Memuat daftar pengguna...</div>;
  }

  return (
    <div className="space-y-3">
      {feedback && (
        <div
          className={`p-3 rounded-xl border text-xs font-semibold flex items-center justify-between ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}
        >
          <span>{feedback.message}</span>
          <button type="button" onClick={() => setFeedback(null)} className="text-slate-400 hover:text-slate-600 font-bold ml-2 cursor-pointer">✕</button>
        </div>
      )}

      <div className="bg-white border border-slate-200/90 rounded-2xl shadow-xs overflow-hidden">
        <div className="px-3 py-2.5 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="font-serif font-bold text-slate-900 text-sm">Hak Akses Pengguna</h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Sesuaikan akses per pengguna di atas default role-nya. Klik lingkaran untuk mengizinkan atau menolak.
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <select
              value={selectedUserId}
              onChange={event => setSelectedUserId(Number(event.target.value))}
              className="px-2 py-1 rounded-lg border border-slate-200 bg-white text-[11px] font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#1b4332] cursor-pointer"
            >
              {users.map(user => (
                <option key={user.user_id} value={user.user_id}>
                  {user.full_name} · {user.role_name || 'Tanpa role'}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleReset}
              disabled={resetting || !detail || isSuperAdminTarget || (detail?.overrides.length || 0) === 0}
              className="px-2.5 py-1 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition font-bold text-[11px] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {resetting ? 'Mereset...' : 'Reset ke Default Role'}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !isDirty || isSuperAdminTarget}
              className="px-2.5 py-1 rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] transition font-bold text-[11px] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {saving ? 'Menyimpan...' : 'Simpan'}
            </button>
          </div>
        </div>

        {selectedUser && (
          <div className="px-3 py-2 border-b border-slate-100 flex items-center gap-4 flex-wrap text-[11px]">
            <span className="text-slate-500">Karyawan: <strong className="text-slate-800">{selectedUser.employee_name || '—'}</strong></span>
            <span className="text-slate-500">Akun Login: <strong className="text-slate-800">{selectedUser.username}</strong></span>
            <span className="text-slate-500">Role: <strong className="text-slate-800">{selectedUser.role_name || '—'}</strong></span>
            {selectedUser.override_count > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-bold text-[10px]">
                {selectedUser.override_count} override
              </span>
            )}
          </div>
        )}

        {isSuperAdminTarget && (
          <div className="mx-3 mt-2.5 p-2 rounded-lg bg-emerald-50 border border-emerald-200 text-[11px] font-semibold text-emerald-800">
            Pengguna ini adalah Platform Super Admin. Hak aksesnya penuh dan tidak dapat dibatasi di sini.
          </div>
        )}

        {loadingDetail ? (
          <div className="p-8 text-center text-xs text-slate-400">Memuat hak akses pengguna...</div>
        ) : (
          <div className="max-h-[min(34rem,65vh)] overflow-y-auto overflow-x-hidden px-3 py-2.5 space-y-4">
            {/* Standard Modules Table */}
            {standardGroups.map(group => (
              <div key={group.group}>
                <div className="text-[10px] font-bold uppercase tracking-widest text-[#1b4332] mb-1">{group.group}</div>
                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <table className="w-full table-fixed text-left text-xs border-collapse">
                    <colgroup>
                      <col />
                      <col className="w-[66px]" />
                      <col className="w-[66px]" />
                      <col className="w-[66px]" />
                      <col className="w-[66px]" />
                      <col className="w-[66px]" />
                      <col className="w-[66px]" />
                      <col className="w-[66px]" />
                    </colgroup>
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-slate-50 text-slate-600 font-bold border-b border-slate-200 text-[11px]">
                        <th className="py-1.5 px-2.5 text-left">Menu / Modul</th>
                        {TABLE_ACTIONS.map(action => (
                          <th key={action} className="py-1.5 px-1 text-center font-bold">
                            {ACCESS_ACTION_LABELS[action]}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {group.resources.map(resource => {
                        const supportedActions = MODULE_SUPPORTED_ACTIONS[resource.key] || ['view', 'detail', 'create', 'edit', 'delete'];
                        return (
                          <tr key={resource.key} className="hover:bg-slate-50/70 transition">
                            <td className="py-1.5 px-2.5 min-w-0">
                              <div className="font-bold text-slate-800 text-[11px] leading-tight break-words">
                                {resource.label}
                              </div>
                              <div className="text-[9px] text-slate-400 leading-snug break-words mt-0.5 line-clamp-1">
                                {resource.description}
                              </div>
                            </td>
                            {TABLE_ACTIONS.map(action => {
                              const isSupported = supportedActions.includes(action);
                              if (!isSupported) {
                                return (
                                  <td key={action} className="py-1.5 px-1 text-center align-middle">
                                    <span className="text-slate-300 font-bold select-none text-xs">—</span>
                                  </td>
                                );
                              }
                              const choice = draft[`${resource.key}::${action}`] || 'INHERIT';
                              const roleAllowed = detail?.role_access?.[resource.key]?.[action] === true;
                              const cell = resolveEffectiveCell({
                                isPlatformSuperAdmin: isSuperAdminTarget,
                                roleAllowed,
                                override: choice,
                              });
                              const title = isSuperAdminTarget
                                ? 'Diizinkan (Platform Super Admin)'
                                : choice === 'ALLOW'
                                  ? 'Diizinkan (Override Pengguna)'
                                  : choice === 'DENY'
                                    ? 'Ditolak (Override Pengguna)'
                                    : cell.allowed
                                      ? 'Diizinkan (Sesuai Role)'
                                      : 'Ditolak (Sesuai Role)';
                              return (
                                <td key={action} className="py-1.5 px-1 text-center align-middle">
                                  <BlueCircleCheck
                                    checked={cell.allowed}
                                    disabled={isSuperAdminTarget}
                                    ariaLabel={`${resource.label} ${ACCESS_ACTION_LABELS[action]}`}
                                    title={title}
                                    onClick={() => {
                                      const nextChoice = toggleUserOverride(roleAllowed, choice);
                                      setDraft(prev => {
                                        const next = { ...prev, [`${resource.key}::${action}`]: nextChoice };
                                        // Auto-allow view if enabling any operational action
                                        if (action !== 'view' && (nextChoice === 'ALLOW' || (nextChoice === 'INHERIT' && roleAllowed))) {
                                          const viewRoleAllowed = detail?.role_access?.[resource.key]?.view === true;
                                          const currentViewChoice = prev[`${resource.key}::view`] || 'INHERIT';
                                          const viewCell = resolveEffectiveCell({
                                            isPlatformSuperAdmin: isSuperAdminTarget,
                                            roleAllowed: viewRoleAllowed,
                                            override: currentViewChoice,
                                          });
                                          if (!viewCell.allowed) {
                                            next[`${resource.key}::view`] = 'ALLOW';
                                          }
                                        }
                                        return next;
                                      });
                                    }}
                                  />
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}

            {/* Otorisasi & Persetujuan Khusus Section */}
            {specialAuthResources.length > 0 && (
              <div className="pt-1">
                <div className="text-[10px] font-bold uppercase tracking-widest text-[#1b4332] mb-1.5">
                  OTORISASI & PERSETUJUAN KHUSUS
                </div>
                <div className="border border-slate-200 rounded-lg bg-slate-50/40 divide-y divide-slate-100">
                  {specialAuthResources.map(resource => {
                    const choice = draft[`${resource.key}::approve`] || 'INHERIT';
                    const roleAllowed = detail?.role_access?.[resource.key]?.approve === true;
                    const cell = resolveEffectiveCell({
                      isPlatformSuperAdmin: isSuperAdminTarget,
                      roleAllowed,
                      override: choice,
                    });
                    const title = isSuperAdminTarget
                      ? 'Diizinkan (Platform Super Admin)'
                      : choice === 'ALLOW'
                        ? 'Diizinkan (Override Pengguna)'
                        : choice === 'DENY'
                          ? 'Ditolak (Override Pengguna)'
                          : cell.allowed
                            ? 'Diizinkan (Sesuai Role)'
                            : 'Ditolak (Sesuai Role)';

                    return (
                      <div
                        key={resource.key}
                        className="p-3 flex items-center justify-between gap-3 hover:bg-slate-50 transition"
                      >
                        <div className="min-w-0 pr-4">
                          <div className="font-bold text-slate-800 text-xs">{resource.label}</div>
                          <div className="text-[11px] text-slate-500 mt-0.5">{resource.description}</div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            cell.allowed ? 'bg-blue-50 text-blue-700 border border-blue-200' : 'bg-slate-100 text-slate-500'
                          }`}>
                            {cell.allowed ? 'Diizinkan' : 'Ditolak'}
                          </span>
                          <BlueCircleCheck
                            checked={cell.allowed}
                            disabled={isSuperAdminTarget}
                            ariaLabel={resource.label}
                            title={title}
                            onClick={() => {
                              const nextChoice = toggleUserOverride(roleAllowed, choice);
                              setDraft(prev => ({
                                ...prev,
                                [`${resource.key}::approve`]: nextChoice,
                                [`${resource.key}::create`]: nextChoice,
                                [`${resource.key}::edit`]: nextChoice,
                                [`${resource.key}::view`]: nextChoice,
                                [`${resource.key}::detail`]: nextChoice,
                              }));
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
