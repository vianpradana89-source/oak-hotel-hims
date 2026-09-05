import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import {
  ACCESS_ACTIONS,
  ACCESS_ACTION_LABELS,
  groupResources,
  type AccessAction,
  type AccessGrid,
  type AccessResource,
  type AccessRoleSummary,
} from '../auth/accessControl';

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
      const current = prev[resourceKey] || { view: false, edit: false, delete: false };
      const next = { ...current, [action]: !current[action] };
      // EDIT and DELETE are meaningless without the ability to open the resource.
      if ((action === 'edit' || action === 'delete') && next[action]) next.view = true;
      if (action === 'view' && !next.view) {
        next.edit = false;
        next.delete = false;
      }
      return { ...prev, [resourceKey]: next };
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

  const groupedResources = useMemo(() => groupResources(resources), [resources]);

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
        <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="font-serif font-bold text-slate-900 text-sm">Hak Akses Role</h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Tentukan akses View, Edit, dan Delete per menu untuk setiap role.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={selectedRoleId}
              onChange={event => setSelectedRoleId(Number(event.target.value))}
              className="px-2.5 py-1.5 rounded-xl border border-slate-200 bg-white text-xs font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#1b4332] cursor-pointer"
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
              className="px-3 py-1.5 rounded-xl bg-[#1b4332] text-white hover:bg-[#143326] transition font-bold text-xs disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {saving ? 'Menyimpan...' : 'Simpan Hak Akses'}
            </button>
          </div>
        </div>

        {selectedRole?.is_protected && (
          <div className="mx-4 mt-3 p-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-[11px] font-semibold text-emerald-800">
            Role Platform Super Admin memiliki akses penuh permanen dan tidak dapat diubah.
          </div>
        )}

        <div className="p-4 space-y-4">
          {groupedResources.map(group => (
            <div key={group.group}>
              <div className="text-[10px] font-bold uppercase tracking-widest text-[#1b4332] mb-1.5">{group.group}</div>
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-slate-50/80 text-slate-600 font-bold border-b border-slate-100">
                      <th className="py-2 px-3">Menu</th>
                      {ACCESS_ACTIONS.map(action => (
                        <th key={action} className="py-2 px-3 text-center w-24">{ACCESS_ACTION_LABELS[action]}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {group.resources.map(resource => (
                      <tr key={resource.key} className="hover:bg-slate-50/60 transition">
                        <td className="py-2 px-3">
                          <div className="font-bold text-slate-800 text-[11px]">{resource.label}</div>
                          <div className="text-[9px] text-slate-400 leading-tight">{resource.description}</div>
                        </td>
                        {ACCESS_ACTIONS.map(action => {
                          const checked = selectedRole?.is_protected
                            ? true
                            : draft[resource.key]?.[action] === true;
                          return (
                            <td key={action} className="py-2 px-3 text-center">
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={selectedRole?.is_protected}
                                aria-label={`${resource.label} ${ACCESS_ACTION_LABELS[action]}`}
                                onChange={() => toggleCell(resource.key, action)}
                                className="rounded border-slate-300 text-[#1b4332] focus:ring-[#1b4332] cursor-pointer disabled:cursor-not-allowed"
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>

        <div className="px-4 pb-4">
          <p className="text-[10px] text-slate-400 leading-relaxed">
            Delete di sini adalah hak hapus operasional pada menu terkait. Hapus permanen tingkat platform tetap
            memerlukan verifikasi Platform Super Admin tersendiri.
          </p>
        </div>
      </div>
    </div>
  );
};
