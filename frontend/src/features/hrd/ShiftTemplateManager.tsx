import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type { WorkShiftTemplate, Department, ShiftTemplateTeamMember, ColorKey, HrEmployee } from './scheduleTypes';
import { VALID_COLOR_KEYS, COLOR_KEY_STYLES } from './scheduleTypes';

interface ShiftTemplateManagerProps {
  propertyId: number;
  onTemplatesUpdated?: () => void;
  onRosterRefresh?: () => void;
}

const COLOR_LABELS: Record<ColorKey, string> = {
  soft_green: 'Hijau', soft_blue: 'Biru', soft_amber: 'Kuning',
  soft_purple: 'Ungu', soft_rose: 'Merah Muda', soft_cyan: 'Biru Muda', soft_slate: 'Abu-abu',
};

const WEEKDAY_LABELS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

export const ShiftTemplateManager: React.FC<ShiftTemplateManagerProps> = ({ propertyId, onTemplatesUpdated, onRosterRefresh }) => {
  const [templates, setTemplates] = useState<WorkShiftTemplate[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [deptFilter, setDeptFilter] = useState<number | string>('');
  const [teamData, setTeamData] = useState<Record<number, ShiftTemplateTeamMember[]>>({});
  const [teamPeriod, setTeamPeriod] = useState<{ start: string; end: string }>(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    return { start: `${y}-${m}-01`, end: `${y}-${m}-${String(new Date(y, now.getMonth() + 1, 0).getDate()).padStart(2, '0')}` };
  });
  const [expandedTeam, setExpandedTeam] = useState<Set<number>>(new Set());

  // ─── Assignment Modal State ───
  const [assignModal, setAssignModal] = useState<WorkShiftTemplate | null>(null);
  const [assignDeptContext, setAssignDeptContext] = useState<number | null>(null);
  const [assignEmployees, setAssignEmployees] = useState<HrEmployee[]>([]);
  const [assignSelected, setAssignSelected] = useState<Set<number>>(new Set());
  const [assignSearch, setAssignSearch] = useState('');
  const [assignStartDate, setAssignStartDate] = useState('');
  const [assignEndDate, setAssignEndDate] = useState('');
  const [assignDaysOfWeek, setAssignDaysOfWeek] = useState<Set<number>>(new Set([1, 2, 3, 4, 5, 6]));
  const [assignNotes, setAssignNotes] = useState('');
  const [assignSubmitting, setAssignSubmitting] = useState(false);
  const [assignError, setAssignError] = useState('');
  const [assignSuccess, setAssignSuccess] = useState('');

  const [form, setForm] = useState({
    code: '', name: '', start_time: '07:00', end_time: '15:00',
    crosses_midnight: false, grace_before_minutes: 15, late_grace_minutes: 15,
    checkout_grace_minutes: 60, department_id: null as number | null, color_key: 'soft_slate' as ColorKey,
  });

  const getAuthHeaders = (): HeadersInit => {
    const token = localStorage.getItem('oak_hims_auth_token');
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  };

  const fetchTemplates = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/schedule/shift-templates?property_id=${propertyId}&include_inactive=true`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (data.status === 'OK') setTemplates(data.data || []);
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  const fetchDepartments = async () => {
    try {
      const res = await fetch(`/api/hrd/departments?property_id=${propertyId}&include_inactive=false`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (data.status === 'OK') setDepartments(data.data || []);
    } catch { /* ignore */ }
  };

  const fetchTeamForTemplate = useCallback(async (templateId: number) => {
    try {
      const res = await fetch(
        `/api/schedule/shift-templates/${templateId}/team?property_id=${propertyId}&start_date=${teamPeriod.start}&end_date=${teamPeriod.end}`,
        { headers: getAuthHeaders() }
      );
      const data = await res.json();
      if (data.status === 'OK') setTeamData(prev => ({ ...prev, [templateId]: data.data || [] }));
    } catch { /* ignore */ }
  }, [propertyId, teamPeriod]);

  const fetchAllTeams = useCallback(async () => {
    for (const t of templates) await fetchTeamForTemplate(t.id);
  }, [templates, fetchTeamForTemplate]);

  useEffect(() => { fetchTemplates(); fetchDepartments(); }, [propertyId]);
  useEffect(() => { if (templates.length > 0) fetchAllTeams(); }, [templates.length, teamPeriod.start, teamPeriod.end]);

  const fetchEmployeesForDept = useCallback(async (deptId: number) => {
    try {
      const res = await fetch(
        `/api/hrd/employees?property_id=${propertyId}&department_id=${deptId}&scope=active`,
        { headers: getAuthHeaders() }
      );
      const data = await res.json();
      if (data.status === 'OK') setAssignEmployees(data.data || []);
      else setAssignEmployees([]);
    } catch { setAssignEmployees([]); }
  }, [propertyId]);

  // Fetch employees when dept context changes in modal
  useEffect(() => {
    if (assignModal && assignDeptContext) fetchEmployeesForDept(assignDeptContext);
    else setAssignEmployees([]);
  }, [assignModal, assignDeptContext, fetchEmployeesForDept]);

  const computeCrossesMidnight = (start: string, end: string) => {
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    return eh * 60 + em <= sh * 60 + sm;
  };

  const handleTimeChange = (field: 'start_time' | 'end_time', val: string) => {
    setForm(prev => {
      const next = { ...prev, [field]: val };
      next.crosses_midnight = computeCrossesMidnight(
        field === 'start_time' ? val : prev.start_time,
        field === 'end_time' ? val : prev.end_time
      );
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const body = {
        code: form.code.toUpperCase(), name: form.name, start_time: form.start_time,
        end_time: form.end_time, crosses_midnight: form.crosses_midnight,
        grace_before_minutes: form.grace_before_minutes, late_grace_minutes: form.late_grace_minutes,
        checkout_grace_minutes: form.checkout_grace_minutes, department_id: form.department_id,
        color_key: form.color_key,
      };
      let res: Response;
      if (editingId) {
        res = await fetch(`/api/schedule/shift-templates/${editingId}`, {
          method: 'PATCH', headers: getAuthHeaders(), body: JSON.stringify({ property_id: propertyId, ...body }),
        });
      } else {
        res = await fetch('/api/schedule/shift-templates', {
          method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ property_id: propertyId, ...body }),
        });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal menyimpan template');
      setShowForm(false); setEditingId(null); resetForm();
      await fetchTemplates(); onTemplatesUpdated?.();
    } catch (err: any) { setError(err.message); } finally { setSubmitting(false); }
  };

  const handleEdit = (t: WorkShiftTemplate) => {
    setEditingId(t.id);
    setForm({
      code: t.code, name: t.name, start_time: t.start_time.substring(0, 5),
      end_time: t.end_time.substring(0, 5), crosses_midnight: t.crosses_midnight,
      grace_before_minutes: t.grace_before_minutes, late_grace_minutes: t.late_grace_minutes,
      checkout_grace_minutes: t.checkout_grace_minutes, department_id: t.department_id,
      color_key: (t.color_key as ColorKey) || 'soft_slate',
    });
    setShowForm(true);
  };

  const handleDeactivate = async (id: number) => {
    if (!confirm('Nonaktifkan shift template ini?')) return;
    try {
      const res = await fetch(`/api/schedule/shift-templates/${id}`, {
        method: 'DELETE', headers: getAuthHeaders(), body: JSON.stringify({ property_id: propertyId }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.message); }
      await fetchTemplates(); onTemplatesUpdated?.();
    } catch (err: any) { alert(err.message); }
  };

  const resetForm = () => {
    setForm({ code: '', name: '', start_time: '07:00', end_time: '15:00', crosses_midnight: false, grace_before_minutes: 15, late_grace_minutes: 15, checkout_grace_minutes: 60, department_id: null, color_key: 'soft_slate' });
  };

  const formatTimeDisplay = (t: string) => t.substring(0, 5);

  const toggleTeamExpand = (id: number) => {
    setExpandedTeam(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };

  const filteredTemplates = templates.filter(t => {
    if (deptFilter === '') return true;
    if (deptFilter === 'global') return t.department_id === null;
    return t.department_id === deptFilter;
  });

  // ─── Assignment Modal Handlers ───
  const openAssignModal = (template: WorkShiftTemplate) => {
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    setAssignModal(template);
    setAssignDeptContext(template.department_id);
    setAssignSelected(new Set());
    setAssignSearch('');
    setAssignStartDate(`${y}-${m}-${d}`);
    setAssignEndDate(`${y}-${m}-${d}`);
    setAssignDaysOfWeek(new Set([1, 2, 3, 4, 5, 6]));
    setAssignNotes('');
    setAssignError('');
    setAssignSuccess('');
  };

  const closeAssignModal = () => {
    setAssignModal(null);
    setAssignDeptContext(null);
    setAssignEmployees([]);
    setAssignSelected(new Set());
  };

  const toggleEmployee = (empId: number) => {
    setAssignSelected(prev => {
      const next = new Set(prev);
      if (next.has(empId)) next.delete(empId); else next.add(empId);
      return next;
    });
  };

  const toggleAllVisible = () => {
    const visibleIds = assignEmployees
      .filter(e => e.full_name.toLowerCase().includes(assignSearch.toLowerCase()))
      .map(e => e.id);
    setAssignSelected(prev => {
      const allSelected = visibleIds.every(id => prev.has(id));
      if (allSelected) {
        const next = new Set(prev);
        visibleIds.forEach(id => next.delete(id));
        return next;
      } else {
        const next = new Set(prev);
        visibleIds.forEach(id => next.add(id));
        return next;
      }
    });
  };

  const toggleDayOfWeek = (day: number) => {
    setAssignDaysOfWeek(prev => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day); else next.add(day);
      return next;
    });
  };

  const filteredAssignEmployees = useMemo(() => {
    if (!assignSearch) return assignEmployees;
    const q = assignSearch.toLowerCase();
    return assignEmployees.filter(e =>
      e.full_name.toLowerCase().includes(q) ||
      (e.employee_code && e.employee_code.toLowerCase().includes(q)) ||
      (e.position_name && e.position_name.toLowerCase().includes(q))
    );
  }, [assignEmployees, assignSearch]);

  const allVisibleSelected = useMemo(() => {
    if (filteredAssignEmployees.length === 0) return false;
    return filteredAssignEmployees.every(e => assignSelected.has(e.id));
  }, [filteredAssignEmployees, assignSelected]);

  const handleApplySchedule = async () => {
    if (!assignModal) return;
    if (assignSelected.size === 0) { setAssignError('Pilih minimal 1 karyawan.'); return; }
    if (!assignStartDate || !assignEndDate) { setAssignError('Periode wajib diisi.'); return; }
    if (assignDaysOfWeek.size === 0) { setAssignError('Pilih minimal 1 hari.'); return; }
    if (assignStartDate > assignEndDate) { setAssignError('Tanggal mulai harus sebelum tanggal selesai.'); return; }

    setAssignSubmitting(true);
    setAssignError('');
    setAssignSuccess('');
    try {
      const res = await fetch('/api/schedule/bulk-assign', {
        method: 'POST', headers: getAuthHeaders(),
        body: JSON.stringify({
          property_id: propertyId,
          employee_ids: Array.from(assignSelected),
          shift_template_id: assignModal.id,
          start_date: assignStartDate,
          end_date: assignEndDate,
          days_of_week: Array.from(assignDaysOfWeek),
          notes: assignNotes || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal menerapkan jadwal');
      setAssignSuccess(`Berhasil menerapkan ${data.data?.assigned_count || 0} jadwal.`);
      await fetchTeamForTemplate(assignModal.id);
      onRosterRefresh?.();
      setTimeout(() => { closeAssignModal(); }, 1200);
    } catch (err: any) {
      setAssignError(err.message);
    } finally { setAssignSubmitting(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider">Shift Template</h3>
        <button type="button" onClick={() => { resetForm(); setEditingId(null); setShowForm(!showForm); }}
          className="px-3 py-1.5 text-[11px] font-bold rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] transition cursor-pointer">
          {showForm ? 'Tutup' : '+ Template Baru'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-2">
          {error && <div className="p-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-[11px] font-semibold">{error}</div>}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] font-bold text-slate-600 mb-0.5">Kode</label>
              <input type="text" required maxLength={20} value={form.code} onChange={e => setForm(p => ({ ...p, code: e.target.value }))}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]" placeholder="M" />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-600 mb-0.5">Nama</label>
              <input type="text" required maxLength={100} value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]" placeholder="Pagi" />
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-bold text-slate-600 mb-0.5">Departemen (opsional, kosong = Global)</label>
            <select value={form.department_id ?? ''} onChange={e => setForm(p => ({ ...p, department_id: e.target.value ? Number(e.target.value) : null }))}
              className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]">
              <option value="">Global (Semua Departemen)</option>
              {departments.filter(d => d.is_active).map(d => (<option key={d.id} value={d.id}>{d.name}</option>))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] font-bold text-slate-600 mb-0.5">Jam Mulai</label>
              <input type="time" required value={form.start_time} onChange={e => handleTimeChange('start_time', e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]" />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-600 mb-0.5">Jam Selesai</label>
              <input type="time" required value={form.end_time} onChange={e => handleTimeChange('end_time', e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]" />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-600">
              <input type="checkbox" checked={form.crosses_midnight} onChange={e => setForm(p => ({ ...p, crosses_midnight: e.target.checked }))}
                className="rounded border-slate-300" />
              Lewat Tengah Malam
            </label>
          </div>
          <div>
            <label className="block text-[11px] font-bold text-slate-600 mb-1">Warna</label>
            <div className="flex items-center gap-2 flex-wrap">
              {(VALID_COLOR_KEYS as readonly ColorKey[]).map(ck => {
                const style = COLOR_KEY_STYLES[ck];
                return (
                  <button key={ck} type="button" title={COLOR_LABELS[ck]}
                    onClick={() => setForm(p => ({ ...p, color_key: ck }))}
                    className={`w-7 h-7 rounded-full ${style.swatch} border-2 transition cursor-pointer ${form.color_key === ck ? 'border-slate-800 scale-110' : 'border-transparent hover:border-slate-400'}`} />
                );
              })}
              <div className="ml-2 flex items-center gap-1.5">
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${COLOR_KEY_STYLES[form.color_key].bg} ${COLOR_KEY_STYLES[form.color_key].text}`}>
                  {form.name || 'Nama Shift'}
                </span>
                <span className="text-[10px] text-slate-500">{form.start_time}–{form.end_time}</span>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => { setShowForm(false); setEditingId(null); resetForm(); }}
              className="px-3 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 cursor-pointer">Batal</button>
            <button type="submit" disabled={submitting}
              className="px-3 py-1.5 text-[11px] font-bold rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] disabled:opacity-50 cursor-pointer">
              {submitting ? 'Menyimpan...' : editingId ? 'Perbarui' : 'Simpan'}
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="text-center text-[11px] text-slate-500 py-4">Memuat...</div>
      ) : templates.length === 0 ? (
        <div className="text-center text-[11px] text-slate-400 py-4">Belum ada shift template.</div>
      ) : (
        <>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-500 uppercase">Filter:</span>
              <select value={deptFilter} onChange={e => setDeptFilter(e.target.value ? Number(e.target.value) : '')}
                className="px-2 py-1 text-[10px] font-bold rounded-lg border border-slate-200 bg-white text-slate-600 focus:outline-none cursor-pointer">
                <option value="">Semua Departemen</option>
                <option value="global">Global Saja</option>
                {departments.filter(d => d.is_active).map(d => (<option key={d.id} value={d.id}>{d.name}</option>))}
              </select>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[10px] font-bold text-slate-500 uppercase">Periode:</span>
              <input type="date" value={teamPeriod.start} onChange={e => setTeamPeriod(p => ({ ...p, start: e.target.value }))}
                className="px-2 py-1 text-[10px] font-bold rounded-lg border border-slate-200 bg-white text-slate-600 focus:outline-none" />
              <span className="text-[10px] text-slate-400">s/d</span>
              <input type="date" value={teamPeriod.end} onChange={e => setTeamPeriod(p => ({ ...p, end: e.target.value }))}
                className="px-2 py-1 text-[10px] font-bold rounded-lg border border-slate-200 bg-white text-slate-600 focus:outline-none" />
            </div>
          </div>

          <div className="space-y-2">
            {filteredTemplates.map(t => {
              const dept = departments.find(d => d.id === t.department_id);
              const sc = COLOR_KEY_STYLES[(t.color_key as ColorKey) || 'soft_slate'];
              const team = teamData[t.id] || [];
              const isExpanded = expandedTeam.has(t.id);
              const displayTeam = isExpanded ? team : team.slice(0, 3);
              const extraCount = team.length - 3;

              return (
                <div key={t.id} className={`bg-white border ${sc.border} rounded-xl p-3 transition`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${sc.bg} ${sc.text}`}>{t.name}</span>
                        <span className="text-[10px] text-slate-500 font-mono">{formatTimeDisplay(t.start_time)}–{formatTimeDisplay(t.end_time)}</span>
                        {t.crosses_midnight && <span className="text-[9px] text-amber-600 font-bold"> Lewat Malam</span>}
                        {dept && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-blue-50 text-blue-700">{dept.name}</span>}
                        {!dept && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-slate-100 text-slate-500">Global</span>}
                        {!t.is_active && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-slate-100 text-slate-400">Nonaktif</span>}
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                        {team.length === 0 ? (
                          <span className="text-[10px] text-slate-400 italic">Belum ada karyawan</span>
                        ) : (
                          <>
                            {displayTeam.map(m => (
                              <span key={m.employee_id} className="px-1.5 py-0.5 rounded bg-slate-50 border border-slate-200 text-[10px] text-slate-700 font-semibold">{m.employee_name}</span>
                            ))}
                            {extraCount > 0 && (
                              <button onClick={() => toggleTeamExpand(t.id)} className="px-1.5 py-0.5 rounded bg-slate-100 text-[10px] text-slate-600 font-bold hover:bg-slate-200 cursor-pointer">+{extraCount} lainnya</button>
                            )}
                            {isExpanded && team.length > 3 && (
                              <button onClick={() => toggleTeamExpand(t.id)} className="px-1.5 py-0.5 rounded bg-slate-100 text-[10px] text-slate-600 font-bold hover:bg-slate-200 cursor-pointer">Sembunyikan</button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {t.is_active && (
                        <button onClick={() => openAssignModal(t)} className="px-2 py-0.5 text-[10px] font-semibold text-[#1b4332] bg-emerald-50 hover:bg-emerald-100 rounded transition cursor-pointer">+ Tambah</button>
                      )}
                      <button onClick={() => handleEdit(t)} className="px-2 py-0.5 text-[10px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded transition cursor-pointer">Edit</button>
                      {t.is_active && (
                        <button onClick={() => handleDeactivate(t.id)} className="px-2 py-0.5 text-[10px] font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 rounded transition cursor-pointer">Nonaktif</button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ─── Assignment Modal ─── */}
      {assignModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={closeAssignModal}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${COLOR_KEY_STYLES[(assignModal.color_key as ColorKey) || 'soft_slate'].bg} ${COLOR_KEY_STYLES[(assignModal.color_key as ColorKey) || 'soft_slate'].text}`}>
                  {assignModal.name}
                </span>
                <span className="text-[10px] text-slate-500 font-mono">{formatTimeDisplay(assignModal.start_time)}–{formatTimeDisplay(assignModal.end_time)}</span>
              </div>
              <button onClick={closeAssignModal} className="p-1 rounded hover:bg-slate-100 cursor-pointer">
                <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="p-4 space-y-3">
              {assignError && <div className="p-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-[11px] font-semibold">{assignError}</div>}
              {assignSuccess && <div className="p-2 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-[11px] font-semibold">{assignSuccess}</div>}

              {/* Department Context (for global templates) */}
              {assignModal.department_id === null && (
                <div>
                  <label className="block text-[11px] font-bold text-slate-600 mb-0.5">Departemen *</label>
                  <select value={assignDeptContext ?? ''} onChange={e => {
                    const val = e.target.value ? Number(e.target.value) : null;
                    setAssignDeptContext(val);
                    setAssignSelected(new Set());
                  }}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]">
                    <option value="">Pilih Departemen...</option>
                    {departments.filter(d => d.is_active).map(d => (<option key={d.id} value={d.id}>{d.name}</option>))}
                  </select>
                </div>
              )}
              {assignModal.department_id !== null && (
                <div className="text-[11px] text-slate-500">
                  Departemen: <span className="font-bold text-slate-700">{departments.find(d => d.id === assignModal.department_id)?.name || '—'}</span>
                </div>
              )}

              {/* Employee Multi-Select */}
              {assignDeptContext && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[11px] font-bold text-slate-600">Karyawan *</label>
                    <span className="text-[10px] text-slate-500">{assignSelected.size} dipilih</span>
                  </div>
                  <input type="text" placeholder="Cari karyawan..." value={assignSearch} onChange={e => setAssignSearch(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332] mb-1" />
                  <div className="flex items-center gap-2 mb-1">
                    <button type="button" onClick={toggleAllVisible}
                      className="text-[10px] font-bold text-[#1b4332] hover:underline cursor-pointer">
                      {allVisibleSelected ? 'Batal Pilih Semua' : 'Pilih Semua'}
                    </button>
                    {assignSelected.size > 0 && (
                      <button type="button" onClick={() => setAssignSelected(new Set())}
                        className="text-[10px] font-bold text-rose-600 hover:underline cursor-pointer">Hapus Pilihan</button>
                    )}
                  </div>
                  <div className="border border-slate-200 rounded-lg max-h-[200px] overflow-y-auto divide-y divide-slate-100">
                    {filteredAssignEmployees.length === 0 ? (
                      <div className="px-3 py-2 text-[11px] text-slate-400 italic">Tidak ada karyawan</div>
                    ) : filteredAssignEmployees.map(emp => (
                      <label key={emp.id} className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-slate-50 transition ${assignSelected.has(emp.id) ? 'bg-emerald-50' : ''}`}>
                        <input type="checkbox" checked={assignSelected.has(emp.id)} onChange={() => toggleEmployee(emp.id)}
                          className="rounded border-slate-300 text-[#1b4332] focus:ring-[#1b4332]" />
                        <div className="flex-1 min-w-0">
                          <div className="text-[11px] font-bold text-slate-800 truncate">{emp.full_name}</div>
                          <div className="text-[9px] text-slate-500">{emp.position_name || '—'}{emp.department_name ? ` · ${emp.department_name}` : ''}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Period */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-bold text-slate-600 mb-0.5">Tanggal Mulai *</label>
                  <input type="date" required value={assignStartDate} onChange={e => setAssignStartDate(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]" />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-slate-600 mb-0.5">Tanggal Selesai *</label>
                  <input type="date" required value={assignEndDate} onChange={e => setAssignEndDate(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]" />
                </div>
              </div>

              {/* Weekdays */}
              <div>
                <label className="block text-[11px] font-bold text-slate-600 mb-1">Hari *</label>
                <div className="flex items-center gap-1.5">
                  {[1, 2, 3, 4, 5, 6, 0].map(day => (
                    <button key={day} type="button" onClick={() => toggleDayOfWeek(day)}
                      className={`px-2 py-1 text-[10px] font-bold rounded-lg border transition cursor-pointer ${assignDaysOfWeek.has(day) ? 'bg-[#1b4332] text-white border-[#1b4332]' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
                      {WEEKDAY_LABELS[day]}
                    </button>
                  ))}
                </div>
              </div>

              {/* Notes */}
              <div>
                <label className="block text-[11px] font-bold text-slate-600 mb-0.5">Catatan (opsional)</label>
                <input type="text" value={assignNotes} onChange={e => setAssignNotes(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]" placeholder="Catatan..." />
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={closeAssignModal}
                  className="px-3 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 cursor-pointer">Batal</button>
                <button type="button" onClick={handleApplySchedule} disabled={assignSubmitting || assignSelected.size === 0}
                  className="px-4 py-1.5 text-[11px] font-bold rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] disabled:opacity-50 cursor-pointer">
                  {assignSubmitting ? 'Menerapkan...' : 'Terapkan Jadwal'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
