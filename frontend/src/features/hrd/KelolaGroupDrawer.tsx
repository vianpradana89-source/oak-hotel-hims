import React, { useState, useEffect } from 'react';
import type { ScheduleGroup, Department } from './scheduleTypes';

interface KelolaGroupDrawerProps {
  propertyId: number;
  onClose: () => void;
  onGroupsUpdated: () => void;
}

type DepartmentCategory = 'OPERATIONAL' | 'NON_OPERATIONAL' | null;

interface DepartmentWithCategory extends Department {
  schedule_category?: DepartmentCategory;
}

export const KelolaGroupDrawer: React.FC<KelolaGroupDrawerProps> = ({ propertyId, onClose, onGroupsUpdated }) => {
  const [groups, setGroups] = useState<ScheduleGroup[]>([]);
  const [departments, setDepartments] = useState<DepartmentWithCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editGroup, setEditGroup] = useState<ScheduleGroup | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showDeptClassification, setShowDeptClassification] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    code: '',
    display_order: 0,
    department_ids: [] as number[],
  });
  const [error, setError] = useState('');

  const getAuthHeaders = (): HeadersInit => {
    const token = localStorage.getItem('oak_hims_auth_token');
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  };

  const fetchGroups = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/schedule/groups?property_id=${propertyId}&include_inactive=true`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (data.status === 'OK') setGroups(data.data || []);
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  const fetchDepartments = async () => {
    try {
      const res = await fetch(`/api/hrd/departments?property_id=${propertyId}&include_inactive=false`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (data.status === 'OK') setDepartments(data.data || []);
    } catch { /* ignore */ }
  };

  const fetchDepartmentCategories = async () => {
    try {
      const res = await fetch(`/api/schedule/department-categories?property_id=${propertyId}`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (data.status === 'OK') {
        const categories = data.data || [];
        setDepartments(prev => prev.map(d => {
          const cat = categories.find((c: any) => c.department_id === d.id);
          return { ...d, schedule_category: cat?.category || null };
        }));
      }
    } catch { /* ignore */ }
  };

  const updateDepartmentCategory = async (departmentId: number, category: DepartmentCategory) => {
    try {
      const res = await fetch(`/api/schedule/department-categories/${departmentId}`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify({ property_id: propertyId, category }),
      });
      if (!res.ok) throw new Error((await res.json()).message);
      setDepartments(prev => prev.map(d => d.id === departmentId ? { ...d, schedule_category: category } : d));
    } catch (err: any) { alert(err.message); }
  };

  useEffect(() => { fetchGroups(); fetchDepartments(); fetchDepartmentCategories(); }, [propertyId]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const body: any = {
        property_id: propertyId,
        name: formData.name,
        code: formData.code,
        display_order: formData.display_order,
        department_ids: formData.department_ids,
      };

      const url = editGroup ? `/api/schedule/groups/${editGroup.id}` : '/api/schedule/groups';
      const method = editGroup ? 'PATCH' : 'POST';

      const res = await fetch(url, { method, headers: getAuthHeaders(), body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal menyimpan');

      setShowForm(false);
      setEditGroup(null);
      setFormData({ name: '', code: '', display_order: 0, department_ids: [] });
      await fetchGroups();
      onGroupsUpdated();
    } catch (err: any) { setError(err.message); } finally { setSaving(false); }
  };

  const handleDeactivate = async (groupId: number) => {
    if (!confirm('Nonaktifkan group ini?')) return;
    try {
      const res = await fetch(`/api/schedule/groups/${groupId}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
        body: JSON.stringify({ property_id: propertyId }),
      });
      if (!res.ok) throw new Error((await res.json()).message);
      await fetchGroups();
      onGroupsUpdated();
    } catch (err: any) { alert(err.message); }
  };

  const handleEdit = (group: ScheduleGroup) => {
    setEditGroup(group);
    setFormData({
      name: group.name,
      code: group.code,
      display_order: group.display_order,
      department_ids: group.departments?.map(d => d.department_id) || [],
    });
    setShowForm(true);
  };

  const toggleDepartment = (deptId: number) => {
    setFormData(prev => ({
      ...prev,
      department_ids: prev.department_ids.includes(deptId)
        ? prev.department_ids.filter(id => id !== deptId)
        : [...prev.department_ids, deptId],
    }));
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div className="w-full max-w-lg bg-white h-full shadow-2xl overflow-y-auto" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between z-10">
          <h2 className="text-sm font-bold text-slate-900">Kelola Group Operasional</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 cursor-pointer">
            <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Add New Button */}
          {!showForm && (
            <button onClick={() => { setEditGroup(null); setFormData({ name: '', code: '', display_order: 0, department_ids: [] }); setShowForm(true); }}
              className="w-full px-3 py-2 text-[11px] font-bold rounded-lg border-2 border-dashed border-slate-300 text-slate-600 hover:border-[#1b4332] hover:text-[#1b4332] transition cursor-pointer">
              + Tambah Group Baru
            </button>
          )}

          {/* Form */}
          {showForm && (
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
              <h3 className="text-xs font-bold text-slate-800">{editGroup ? 'Edit Group' : 'Group Baru'}</h3>
              {error && <div className="p-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-[11px]">{error}</div>}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-bold text-slate-600 mb-1">Nama Group</label>
                  <input value={formData.name} onChange={e => setFormData(p => ({ ...p, name: e.target.value }))}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]" />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-600 mb-1">Kode</label>
                  <input value={formData.code} onChange={e => setFormData(p => ({ ...p, code: e.target.value.toUpperCase() }))}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]" />
                </div>
              </div>
              <div>
                <label className="block text-[10px] font-bold text-slate-600 mb-1">Urutan Tampil</label>
                <input type="number" value={formData.display_order} onChange={e => setFormData(p => ({ ...p, display_order: Number(e.target.value) }))}
                  className="w-24 px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]" />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-slate-600 mb-1">Departemen (Operasional)</label>
                <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-48 overflow-y-auto">
                  {departments.filter(d => d.is_active).map(dept => (
                    <label key={dept.id} className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-slate-50 transition ${formData.department_ids.includes(dept.id) ? 'bg-emerald-50' : ''}`}>
                      <input type="checkbox" checked={formData.department_ids.includes(dept.id)} onChange={() => toggleDepartment(dept.id)}
                        className="rounded border-slate-300 text-[#1b4332] focus:ring-[#1b4332]" />
                      <span className="text-[11px] text-slate-800">{dept.name}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <button onClick={() => { setShowForm(false); setEditGroup(null); }}
                  className="flex-1 px-3 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 cursor-pointer">Batal</button>
                <button onClick={handleSave} disabled={saving || !formData.name || !formData.code}
                  className="flex-1 px-3 py-1.5 text-[11px] font-bold rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] disabled:opacity-50 cursor-pointer">
                  {saving ? 'Menyimpan...' : 'Simpan'}
                </button>
              </div>
            </div>
          )}

          {/* Groups List */}
          {loading ? (
            <div className="text-center py-8 text-slate-400 text-xs">Memuat...</div>
          ) : groups.length === 0 ? (
            <div className="text-center py-8 text-slate-400 text-xs">Belum ada group operasional.</div>
          ) : (
            <div className="space-y-2">
              {groups.map(group => (
                <div key={group.id} className={`border rounded-xl p-3 ${group.is_active ? 'border-slate-200 bg-white' : 'border-slate-100 bg-slate-50 opacity-60'}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-bold text-slate-900">{group.name}</div>
                      <div className="text-[10px] text-slate-500">Kode: {group.code} | Urutan: {group.display_order}</div>
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => handleEdit(group)} className="px-2 py-1 text-[10px] font-bold rounded border border-slate-200 text-slate-600 hover:bg-slate-50 cursor-pointer">Edit</button>
                      {group.is_active && (
                        <button onClick={() => handleDeactivate(group.id)} className="px-2 py-1 text-[10px] font-bold rounded border border-rose-200 text-rose-600 hover:bg-rose-50 cursor-pointer">Nonaktif</button>
                      )}
                    </div>
                  </div>
                  {group.departments && group.departments.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {group.departments.map(d => (
                        <span key={d.department_id} className="px-1.5 py-0.5 rounded bg-[#1b4332]/10 text-[#1b4332] text-[9px] font-bold">
                          {d.department_name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Department Classification Section */}
          <div className="pt-4 border-t border-slate-200">
            <button onClick={() => setShowDeptClassification(!showDeptClassification)}
              className="flex items-center justify-between w-full px-3 py-2 text-[11px] font-bold text-slate-700 hover:bg-slate-50 rounded-lg transition cursor-pointer">
              <span>Klasifikasi Departemen (Operasional / Non-Operasional)</span>
              <svg className={`w-4 h-4 text-slate-400 transition ${showDeptClassification ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {showDeptClassification && (
              <div className="mt-2 space-y-2">
                <p className="text-[9px] text-slate-500 px-3">
                  Klasifikasi menentukan departemen mana yang muncul di tampilan Operasional (dengan shift) dan Non-Operasional (Kerja/OFF/Cuti/Sakit/Ijin/Libur).
                </p>
                <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-64 overflow-y-auto">
                  {departments.filter(d => d.is_active).map(dept => (
                    <div key={dept.id} className="flex items-center gap-2 px-3 py-2 hover:bg-slate-50 transition">
                      <span className="text-[11px] text-slate-800 flex-1">{dept.name}</span>
                      <div className="flex items-center gap-1">
                        <select
                          value={dept.schedule_category || ''}
                          onChange={e => updateDepartmentCategory(dept.id, e.target.value as DepartmentCategory)}
                          className="px-1.5 py-0.5 text-[10px] font-bold rounded border border-slate-200 bg-white text-slate-700 focus:outline-none focus:ring-1 focus:ring-[#1b4332] cursor-pointer">
                          <option value="">Belum Diklasifikasi</option>
                          <option value="OPERATIONAL">Operasional</option>
                          <option value="NON_OPERATIONAL">Non-Operasional</option>
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2 text-[9px] text-slate-500">
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-emerald-500"></span> Operasional
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-slate-400"></span> Non-Operasional
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-amber-400"></span> Belum Diklasifikasi
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
