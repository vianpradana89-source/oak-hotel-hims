import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import {
  ACCESS_ACTIONS,
  TABLE_ACTIONS,
  ACCESS_ACTION_LABELS,
  MODULE_SUPPORTED_ACTIONS,
  groupResources,
  type AccessAction,
  type AccessGrid,
  type AccessResource,
  type AccessRoleSummary,
} from '../auth/accessControl';
import { BlueCircleCheck } from './BlueCircleCheck';

interface RoleAccessTabProps {
  propertyId: number;
  onAccessUpdated?: () => void;
}

export const RoleAccessTab: React.FC<RoleAccessTabProps> = ({ propertyId, onAccessUpdated }) => {
  const { authFetch, refreshEffectiveAccess } = useAuth();

  const [resources, setResources] = useState<AccessResource[]>([]);
  const [roles, setRoles] = useState<AccessRoleSummary[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState<number>(0);
  const [draft, setDraft] = useState<AccessGrid>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`/api/access-control/roles?property_id=${propertyId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal memuat hak akses role.');
      setResources(data.data.resources || []);
      setRoles(data.data.roles || []);
      setSelectedRoleId(prev => {
        if (prev && (data.data.roles || []).some((role: AccessRoleSummary) => role.id === prev)) return prev;
        const editable = (data.data.roles || []).find((role: AccessRoleSummary) => !role.is_protected);
        return editable?.id || data.data.roles?.[0]?.id || 0;
      });
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Gagal memuat hak akses role.' });
    } finally {
      setLoading(false);
    }
  }, [authFetch, propertyId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const selectedRole = useMemo(
    () => roles.find(role => role.id === selectedRoleId) || null,
    [roles, selectedRoleId]
  );

  useEffect(() => {
    setDraft(selectedRole ? JSON.parse(JSON.stringify(selectedRole.access)) : {});
  }, [selectedRole]);

  const isDirty = useMemo(() => {
    if (!selectedRole) return false;
    return JSON.stringify(selectedRole.access) !== JSON.stringify(draft);
  }, [selectedRole, draft]);

  const toggleCell = (resourceKey: string, action: AccessAction) => {
    if (!selectedRole || selectedRole.is_protected) return;
    setDraft(prev => {
      const current = prev[resourceKey] || {
        view: false,
        detail: false,
        create: false,
        edit: false,
        delete: false,
        export: false,
        import: false,
        approve: false,
      };
      const nextVal = !current[action];
      const next = { ...current, [action]: nextVal };
      // If enabling any operational/sub action, ensure view is enabled
      if (action !== 'view' && nextVal) {
        next.view = true;
      }
      // If disabling view, disable all other actions for this resource
      if (action === 'view' && !nextVal) {
        for (const act of ACCESS_ACTIONS) {
          next[act] = false;
        }
      }
      return { ...prev, [resourceKey]: next };
    });
  };

  const toggleSpecialAuth = (resourceKey: string) => {
    if (!selectedRole || selectedRole.is_protected) return;
    setDraft(prev => {
      const current = prev[resourceKey] || {
        view: false,
        detail: false,
        create: false,
        edit: false,
        delete: false,
        export: false,
        import: false,
        approve: false,
      };
      const nextVal = !current.approve;
      return {
        ...prev,
        [resourceKey]: {
          view: nextVal,
          detail: nextVal,
          create: nextVal,
          edit: nextVal,
          delete: nextVal,
          export: nextVal,
          import: nextVal,
          approve: nextVal,
        },
      };
    });
  };

  const handleSave = async () => {
    if (!selectedRole || selectedRole.is_protected) return;
    setSaving(true);
    setFeedback(null);
    try {
      const res = await authFetch(`/api/access-control/roles/${selectedRole.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId, access: draft }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal menyimpan hak akses role.');
      setFeedback({ type: 'success', message: `Hak akses role "${selectedRole.name}" berhasil disimpan.` });
      await fetchData();
      await refreshEffectiveAccess();
      if (onAccessUpdated) onAccessUpdated();
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Gagal menyimpan hak akses role.' });
    } finally {
      setSaving(false);
    }
  };

  const allGrouped = useMemo(() => groupResources(resources), [resources]);
  const standardGroups = useMemo(() => allGrouped.filter(g => g.group !== 'Otorisasi Khusus'), [allGrouped]);
  const specialAuthResources: AccessResource[] = useMemo(() => {
    const specialGroup = allGrouped.find(g => g.group === 'Otorisasi Khusus');
    return specialGroup?.resources || [];
  }, [allGrouped]);

  if (loading) {
    return <div className="p-8 text-center text-xs text-slate-400">Memuat hak akses role...</div>;
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
            <h3 className="font-serif font-bold text-slate-900 text-sm">Hak Akses Role</h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Tentukan hak akses per menu dan modul untuk setiap role jabatan. Klik lingkaran untuk mengaktifkan.
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <select
              value={selectedRoleId}
              onChange={event => setSelectedRoleId(Number(event.target.value))}
              className="px-2 py-1 rounded-lg border border-slate-200 bg-white text-[11px] font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#1b4332] cursor-pointer"
            >
              {roles.map(role => (
                <option key={role.id} value={role.id}>
                  {role.name}{role.is_active ? '' : ' (nonaktif)'}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !isDirty || !selectedRole || selectedRole.is_protected}
              className="px-2.5 py-1 rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] transition font-bold text-[11px] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {saving ? 'Menyimpan...' : 'Simpan'}
            </button>
          </div>
        </div>

        {selectedRole?.is_protected && (
          <div className="mx-3 mt-2.5 p-2 rounded-lg bg-emerald-50 border border-emerald-200 text-[11px] font-semibold text-emerald-800">
            Role Platform Super Admin memiliki akses penuh permanen dan tidak dapat diubah.
          </div>
        )}

        <div className="max-h-[min(34rem,65vh)] overflow-y-auto overflow-x-hidden px-3 py-2.5 space-y-4">
          {/* Standard Groups Table */}
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
                            <div className="font-bold text-slate-800 text-[11px] leading-tight break-words">{resource.label}</div>
                            <div className="text-[9px] text-slate-400 leading-snug break-words mt-0.5 line-clamp-1">{resource.description}</div>
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
                            const checked = selectedRole?.is_protected
                              ? true
                              : draft[resource.key]?.[action] === true;
                            return (
                              <td key={action} className="py-1.5 px-1 text-center align-middle">
                                <BlueCircleCheck
                                  checked={checked}
                                  disabled={selectedRole?.is_protected}
                                  ariaLabel={`${resource.label} ${ACCESS_ACTION_LABELS[action]}`}
                                  title={`${resource.label} - ${ACCESS_ACTION_LABELS[action]}`}
                                  onClick={() => toggleCell(resource.key, action)}
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
                  const checked = selectedRole?.is_protected
                    ? true
                    : draft[resource.key]?.approve === true;

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
                          checked ? 'bg-blue-50 text-blue-700 border border-blue-200' : 'bg-slate-100 text-slate-500'
                        }`}>
                          {checked ? 'Diizinkan' : 'Ditolak'}
                        </span>
                        <BlueCircleCheck
                          checked={checked}
                          disabled={selectedRole?.is_protected}
                          ariaLabel={resource.label}
                          title={resource.label}
                          onClick={() => toggleSpecialAuth(resource.key)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="px-3 pb-3">
          <p className="text-[10px] text-slate-400 leading-relaxed">
            Hapus di sini adalah hak hapus operasional pada menu terkait. Otorisasi khusus seperti persetujuan PO dan complimentary memerlukan centang di seksi Otorisasi Khusus.
          </p>
        </div>
      </div>
    </div>
  );
};
