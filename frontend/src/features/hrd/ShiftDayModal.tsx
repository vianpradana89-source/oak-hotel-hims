import React, { useState, useEffect, useMemo } from 'react';
import type { WeeklyRosterResponse, ColorKey, Department, HrEmployee } from './scheduleTypes';
import { COLOR_KEY_STYLES } from './scheduleTypes';

const DAY_FULL_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

function formatDateDisplay(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return `${DAY_FULL_NAMES[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

interface ShiftDayModalProps {
  propertyId: number;
  shiftType: string;
  templateId: number | null;
  date: string;
  roster: WeeklyRosterResponse;
  departments: Department[];
  onClose: () => void;
  onSaved: () => void;
}

export const ShiftDayModal: React.FC<ShiftDayModalProps> = ({
  propertyId, shiftType, templateId, date, roster, departments, onClose, onSaved
}) => {
  const template = templateId ? roster.shift_templates.find(t => t.id === templateId) : null;
  const [employees, setEmployees] = useState<HrEmployee[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const getAuthHeaders = (): HeadersInit => {
    const token = localStorage.getItem('oak_hims_auth_token');
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  };

  const getRowLabel = () => {
    if (shiftType === 'shift' && template) return template.name;
    if (shiftType === 'off') return 'OFF / Libur';
    if (shiftType === 'leave') return 'Cuti';
    if (shiftType === 'sick') return 'Sakit';
    if (shiftType === 'permission') return 'Ijin';
    if (shiftType === 'holiday') return 'Libur';
    return shiftType;
  };

  const getRowColor = () => {
    if (shiftType === 'shift' && template) {
      return COLOR_KEY_STYLES[(template.color_key as ColorKey) || 'soft_slate'];
    }
    if (shiftType === 'off') return COLOR_KEY_STYLES.soft_slate;
    if (shiftType === 'leave') return COLOR_KEY_STYLES.soft_purple;
    if (shiftType === 'sick') return COLOR_KEY_STYLES.soft_rose;
    if (shiftType === 'permission') return COLOR_KEY_STYLES.soft_amber;
    return COLOR_KEY_STYLES.soft_slate;
  };

  // Determine which department to filter employees by
  const deptContext = useMemo(() => {
    if (template?.department_id) return template.department_id;
    return null;
  }, [template]);

  // Fetch employees
  useEffect(() => {
    const fetchEmployees = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ property_id: String(propertyId), scope: 'active' });
        if (deptContext) params.set('department_id', String(deptContext));
        const res = await fetch(`/api/hrd/employees?${params}`, { headers: getAuthHeaders() });
        const data = await res.json();
        if (data.status === 'OK') setEmployees(data.data || []);
      } catch { /* ignore */ } finally { setLoading(false); }
    };
    fetchEmployees();
  }, [propertyId, deptContext]);

  // Pre-select employees already assigned to this shift/date
  useEffect(() => {
    const ids = new Set<number>();
    for (const emp of roster.employees) {
      const sched = emp.schedules[date];
      if (!sched) continue;
      if (shiftType === 'shift' && sched.shift_template_id === templateId && sched.work_status === 'WORK') {
        ids.add(emp.employee_id);
      } else if (shiftType === 'off' && sched.work_status === 'OFF') {
        ids.add(emp.employee_id);
      } else if (shiftType === 'leave' && sched.work_status === 'LEAVE') {
        ids.add(emp.employee_id);
      } else if (shiftType === 'sick' && sched.work_status === 'SICK') {
        ids.add(emp.employee_id);
      } else if (shiftType === 'permission' && sched.work_status === 'PERMISSION') {
        ids.add(emp.employee_id);
      }
    }
    setSelectedIds(ids);
  }, [roster, date, shiftType, templateId]);

  const filteredEmployees = useMemo(() => {
    if (!search) return employees;
    const q = search.toLowerCase();
    return employees.filter(e =>
      e.full_name.toLowerCase().includes(q) ||
      (e.employee_code && e.employee_code.toLowerCase().includes(q)) ||
      (e.position_name && e.position_name.toLowerCase().includes(q))
    );
  }, [employees, search]);

  const toggleEmployee = (empId: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(empId)) next.delete(empId); else next.add(empId);
      return next;
    });
  };

  const toggleAll = () => {
    const visibleIds = filteredEmployees.map(e => e.id);
    setSelectedIds(prev => {
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

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      // Remove all employees from this shift/date first (those who were previously assigned but now deselected)
      const previouslyAssigned = new Set<number>();
      for (const emp of roster.employees) {
        const sched = emp.schedules[date];
        if (!sched) continue;
        if (shiftType === 'shift' && sched.shift_template_id === templateId && sched.work_status === 'WORK') {
          previouslyAssigned.add(emp.employee_id);
        } else if (shiftType === 'off' && sched.work_status === 'OFF') {
          previouslyAssigned.add(emp.employee_id);
        } else if (shiftType === 'leave' && sched.work_status === 'LEAVE') {
          previouslyAssigned.add(emp.employee_id);
        } else if (shiftType === 'sick' && sched.work_status === 'SICK') {
          previouslyAssigned.add(emp.employee_id);
        } else if (shiftType === 'permission' && sched.work_status === 'PERMISSION') {
          previouslyAssigned.add(emp.employee_id);
        }
      }

      // Employees to remove (were assigned, now deselected)
      const toRemove = [...previouslyAssigned].filter(id => !selectedIds.has(id));
      // Employees to add (newly selected, weren't previously assigned)
      const toAdd = [...selectedIds].filter(id => !previouslyAssigned.has(id));

      // Remove deselected employees
      for (const empId of toRemove) {
        const body: any = { property_id: propertyId, employee_id: empId, work_date: date, work_status: 'OFF' };
        if (shiftType !== 'off' && shiftType !== 'leave' && shiftType !== 'sick' && shiftType !== 'permission' && shiftType !== 'holiday') {
          body.work_status = 'OFF';
        }
        await fetch('/api/schedule/assign', {
          method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(body),
        });
      }

      // Add newly selected employees
      for (const empId of toAdd) {
        const body: any = { property_id: propertyId, employee_id: empId, work_date: date };
        if (shiftType === 'shift' && templateId) {
          body.shift_template_id = templateId;
        } else if (shiftType === 'off') {
          body.work_status = 'OFF';
        } else if (shiftType === 'leave') {
          body.work_status = 'LEAVE';
        } else if (shiftType === 'sick') {
          body.work_status = 'SICK';
        } else if (shiftType === 'permission') {
          body.work_status = 'PERMISSION';
        }
        await fetch('/api/schedule/assign', {
          method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(body),
        });
      }

      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Gagal menyimpan');
    } finally { setSaving(false); }
  };

  const sc = getRowColor();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className={`px-4 py-3 border-b border-slate-200 flex items-center justify-between`}>
          <div className="flex items-center gap-2">
            <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${sc.bg} ${sc.text}`}>
              {getRowLabel()}
            </span>
            <span className="text-[11px] text-slate-600">{formatDateDisplay(date)}</span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 cursor-pointer">
            <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Time + Department info */}
        <div className="px-4 py-2 bg-slate-50 border-b border-slate-100 flex items-center gap-4 text-[10px] text-slate-500">
          {template && (
            <span>Jam: <span className="font-bold text-slate-700">{template.start_time.substring(0, 5)}–{template.end_time.substring(0, 5)}</span></span>
          )}
          {template?.department_id && (
            <span>Departemen: <span className="font-bold text-slate-700">{departments.find(d => d.id === template.department_id)?.name || '—'}</span></span>
          )}
          {!template?.department_id && shiftType === 'shift' && (
            <span>Departemen: <span className="font-bold text-slate-700">Global</span></span>
          )}
        </div>

        {error && (
          <div className="mx-4 mt-2 p-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-[11px] font-semibold">{error}</div>
        )}

        {/* Employee list */}
        <div className="flex-1 overflow-y-auto px-4 py-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-bold text-slate-600">Karyawan {selectedIds.size > 0 ? `(${selectedIds.size} dipilih)` : ''}</span>
            <button type="button" onClick={toggleAll}
              className="text-[10px] font-bold text-[#1b4332] hover:underline cursor-pointer">
              {filteredEmployees.every(e => selectedIds.has(e.id)) ? 'Batal Pilih Semua' : 'Pilih Semua'}
            </button>
          </div>
          <input type="text" placeholder="Cari karyawan..." value={search} onChange={e => setSearch(e.target.value)}
            className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332] mb-2" />
          {loading ? (
            <div className="text-center text-[11px] text-slate-400 py-4">Memuat karyawan...</div>
          ) : (
            <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
              {filteredEmployees.length === 0 ? (
                <div className="px-3 py-2 text-[11px] text-slate-400 italic">Tidak ada karyawan</div>
              ) : filteredEmployees.map(emp => (
                <label key={emp.id} className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-slate-50 transition ${selectedIds.has(emp.id) ? 'bg-emerald-50' : ''}`}>
                  <input type="checkbox" checked={selectedIds.has(emp.id)} onChange={() => toggleEmployee(emp.id)}
                    className="rounded border-slate-300 text-[#1b4332] focus:ring-[#1b4332]" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-bold text-slate-800 truncate">{emp.full_name}</div>
                    <div className="text-[9px] text-slate-500">{emp.position_name || '—'}{emp.department_name ? ` · ${emp.department_name}` : ''}</div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-4 py-3 border-t border-slate-200 flex justify-end gap-2">
          <button onClick={onClose}
            className="px-3 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 cursor-pointer">Batal</button>
          <button onClick={handleSave} disabled={saving}
            className="px-4 py-1.5 text-[11px] font-bold rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] disabled:opacity-50 cursor-pointer">
            {saving ? 'Menyimpan...' : 'Simpan'}
          </button>
        </div>
      </div>
    </div>
  );
};
