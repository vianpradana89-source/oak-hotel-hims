import React, { useState, useEffect, useMemo } from 'react';
import type { WeeklyRosterResponse, ColorKey, Department, HrEmployee, OperationalRosterResponse } from './scheduleTypes';
import { COLOR_KEY_STYLES } from './scheduleTypes';
import {
  getCellAssignments,
  mergeCandidatesWithAssignments,
  type CellAssignmentEmployee,
} from './scheduleCellAssignments';

const DAY_FULL_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
type CorrectionTarget = 'SHIFT' | 'OFF' | 'HOLIDAY' | 'LEAVE' | 'SICK' | 'PERMISSION' | 'REMOVE';

function formatDateDisplay(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return `${DAY_FULL_NAMES[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

interface ShiftDayModalProps {
  propertyId: number;
  shiftType: string;
  templateId: number | null;
  date: string;
  roster?: WeeklyRosterResponse | null;
  departments: Department[];
  groupId?: number;
  groupedRoster?: OperationalRosterResponse | null;
  onClose: () => void;
  onSaved: () => void;
}

export const ShiftDayModal: React.FC<ShiftDayModalProps> = ({
  propertyId, shiftType, templateId, date, roster, departments, groupId, groupedRoster, onClose, onSaved
}) => {
  const shiftTemplates = roster?.shift_templates || groupedRoster?.shift_templates || [];
  const template = templateId ? shiftTemplates.find(t => t.id === templateId) : null;
  const [employees, setEmployees] = useState<HrEmployee[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [correctionAssignment, setCorrectionAssignment] = useState<CellAssignmentEmployee | null>(null);
  const [correctionTarget, setCorrectionTarget] = useState<CorrectionTarget>('SHIFT');
  const [correctionShiftId, setCorrectionShiftId] = useState<number | ''>('');
  const [correctionReason, setCorrectionReason] = useState('');

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

  const getGroupLabel = () => {
    if (groupName) return groupName;
    return null;
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
    // If groupId is provided, get departments from the grouped roster
    if (groupId && groupedRoster) {
      const group = groupedRoster.groups.find(g => g.group_id === groupId);
      if (group?.department_ids?.length) return group.department_ids;
    }
    // Fallback to template's department
    if (template?.department_id) return [template.department_id];
    return null;
  }, [template, groupId, groupedRoster]);

  // Group name for display
  const groupName = useMemo(() => {
    if (!groupId || !groupedRoster) return null;
    return groupedRoster.groups.find(g => g.group_id === groupId)?.group_name || null;
  }, [groupId, groupedRoster]);

  const existingAssignments = useMemo(
    () => getCellAssignments(roster, groupedRoster, date, shiftType, templateId),
    [roster, groupedRoster, date, shiftType, templateId],
  );
  const assignmentByEmployeeId = useMemo(
    () => new Map(existingAssignments.map(assignment => [assignment.id, assignment])),
    [existingAssignments],
  );

  // Fetch employees
  useEffect(() => {
    const fetchEmployees = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ property_id: String(propertyId), scope: 'active' });
        // Filter by group's departments (array) or template's single department
        if (deptContext && deptContext.length === 1) {
          params.set('department_id', String(deptContext[0]));
        }
        const res = await fetch(`/api/hrd/employees?${params}`, { headers: getAuthHeaders() });
        const data = await res.json();
        if (data.status === 'OK') {
          let empList = data.data || [];
          // If multiple department IDs (group context), filter client-side
          if (deptContext && deptContext.length > 1) {
            const deptIdSet = new Set(deptContext);
            empList = empList.filter((e: any) => deptIdSet.has(e.department_id));
          }
          setEmployees(empList);
        }
      } catch { /* ignore */ } finally { setLoading(false); }
    };
    fetchEmployees();
  }, [propertyId, deptContext]);

  // Pre-select employees already assigned to this shift/date
  useEffect(() => {
    setSelectedIds(new Set(existingAssignments.map(employee => employee.id)));
  }, [existingAssignments]);

  const filteredEmployees = useMemo(() => {
    const visibleEmployees = mergeCandidatesWithAssignments(employees, existingAssignments);
    if (!search) return visibleEmployees;
    const q = search.toLowerCase();
    return visibleEmployees.filter(e =>
      e.full_name.toLowerCase().includes(q) ||
      (e.employee_code && e.employee_code.toLowerCase().includes(q)) ||
      (e.position_name && e.position_name.toLowerCase().includes(q))
    );
  }, [employees, existingAssignments, search]);

  const toggleEmployee = (empId: number) => {
    if (assignmentByEmployeeId.get(empId)?.schedule_status === 'PUBLISHED') return;
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(empId)) next.delete(empId); else next.add(empId);
      return next;
    });
  };

  const toggleAll = () => {
    const visibleIds = filteredEmployees
      .filter(employee => assignmentByEmployeeId.get(employee.id)?.schedule_status !== 'PUBLISHED')
      .map(employee => employee.id);
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

  const getAssignmentLabel = (assignment: CellAssignmentEmployee) => {
    const schedule = assignment.schedule;
    if (schedule.work_status === 'WORK') {
      return shiftTemplates.find(item => item.id === schedule.shift_template_id)?.name || 'Shift tidak dikenal';
    }
    const labels: Record<string, string> = {
      OFF: 'OFF',
      HOLIDAY: 'Libur',
      LEAVE: 'Cuti',
      SICK: 'Sakit',
      PERMISSION: 'Ijin',
    };
    return labels[schedule.work_status] || schedule.work_status;
  };

  const openCorrection = (assignment: CellAssignmentEmployee) => {
    setCorrectionAssignment(assignment);
    setCorrectionTarget('SHIFT');
    setCorrectionShiftId('');
    setCorrectionReason('');
    setError('');
  };

  const handleCorrectionSave = async () => {
    if (!correctionAssignment) return;
    if (!correctionReason.trim()) {
      setError('Alasan koreksi wajib diisi.');
      return;
    }
    if (correctionTarget === 'SHIFT' && !correctionShiftId) {
      setError('Shift tujuan wajib dipilih.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const response = await fetch(`/api/schedule/assignments/${correctionAssignment.schedule_id}/correct`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          property_id: propertyId,
          target_type: correctionTarget,
          shift_template_id: correctionTarget === 'SHIFT' ? correctionShiftId : undefined,
          reason: correctionReason.trim(),
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.message || 'Gagal menyimpan koreksi jadwal.');
      }
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Gagal menyimpan koreksi jadwal.');
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const previouslyAssigned = new Set(existingAssignments.map(employee => employee.id));

      // Employees to remove (were assigned, now deselected)
      const toRemove = [...previouslyAssigned].filter(id => !selectedIds.has(id));
      // Employees to add (newly selected, weren't previously assigned)
      const toAdd = [...selectedIds].filter(id => !previouslyAssigned.has(id));

      // Soft-cancel deselected future draft assignments by their canonical schedule IDs.
      if (toRemove.length > 0) {
        const assignmentByEmployee = new Map(existingAssignments.map(assignment => [assignment.id, assignment]));
        const scheduleIds = toRemove.map(employeeId => assignmentByEmployee.get(employeeId)!.schedule_id);
        const removeResponse = await fetch('/api/schedule/assignments', {
          method: 'DELETE',
          headers: getAuthHeaders(),
          body: JSON.stringify({ property_id: propertyId, schedule_ids: scheduleIds }),
        });
        const removeData = await removeResponse.json().catch(() => null);
        if (!removeResponse.ok) {
          throw new Error(removeData?.message || 'Gagal menghapus penugasan jadwal.');
        }
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
        } else if (shiftType === 'holiday') {
          body.work_status = 'HOLIDAY';
        }
        const addResponse = await fetch('/api/schedule/assign', {
          method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(body),
        });
        const addData = await addResponse.json().catch(() => null);
        if (!addResponse.ok) {
          throw new Error(addData?.message || 'Gagal menambahkan penugasan jadwal.');
        }
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
          {getGroupLabel() && (
            <span>Group: <span className="font-bold text-[#1b4332]">{getGroupLabel()}</span></span>
          )}
          {template?.department_id && !getGroupLabel() && (
            <span>Departemen: <span className="font-bold text-slate-700">{departments.find(d => d.id === template.department_id)?.name || '—'}</span></span>
          )}
          {!template?.department_id && shiftType === 'shift' && !getGroupLabel() && (
            <span>Departemen: <span className="font-bold text-slate-700">Global</span></span>
          )}
          {deptContext && deptContext.length > 1 && !template?.department_id && !getGroupLabel() && (
            <span>Departemen: <span className="font-bold text-slate-700">{deptContext.length} departemen</span></span>
          )}
          {existingAssignments.some(assignment => assignment.schedule_status === 'PUBLISHED') && (
            <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold">PUBLISHED</span>
          )}
        </div>

        {error && (
          <div className="mx-4 mt-2 p-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-[11px] font-semibold">{error}</div>
        )}

        {/* Employee list / compact correction form */}
        {correctionAssignment ? (
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] space-y-1">
              <div><span className="text-slate-500">Karyawan:</span> <strong>{correctionAssignment.full_name}</strong></div>
              <div><span className="text-slate-500">Tanggal:</span> <strong>{formatDateDisplay(date)}</strong></div>
              <div><span className="text-slate-500">Jadwal lama:</span> <strong>{getAssignmentLabel(correctionAssignment)}</strong></div>
              {correctionAssignment.schedule.published_by_name && (
                <div className="text-[10px] text-slate-500">
                  Dipublish oleh {correctionAssignment.schedule.published_by_name}
                  {correctionAssignment.schedule.published_at
                    ? ` · ${new Date(correctionAssignment.schedule.published_at).toLocaleString('id-ID')}`
                    : ''}
                </div>
              )}
            </div>
            <div>
              <label className="block text-[10px] font-bold text-slate-600 mb-1">Ubah menjadi</label>
              <select
                value={correctionTarget}
                onChange={event => setCorrectionTarget(event.target.value as CorrectionTarget)}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332] cursor-pointer"
              >
                <option value="SHIFT">Shift lain</option>
                <option value="OFF">OFF</option>
                <option value="HOLIDAY">Libur</option>
                <option value="LEAVE">Cuti</option>
                <option value="SICK">Sakit</option>
                <option value="PERMISSION">Ijin</option>
                <option value="REMOVE">Hapus Penugasan</option>
              </select>
            </div>
            {correctionTarget === 'SHIFT' && (
              <div>
                <label className="block text-[10px] font-bold text-slate-600 mb-1">Shift tujuan</label>
                <select
                  value={correctionShiftId}
                  onChange={event => setCorrectionShiftId(event.target.value ? Number(event.target.value) : '')}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332] cursor-pointer"
                >
                  <option value="">Pilih shift...</option>
                  {shiftTemplates.filter(item => item.is_active).map(item => (
                    <option key={item.id} value={item.id}>
                      {item.name} ({item.start_time.substring(0, 5)}–{item.end_time.substring(0, 5)})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-[10px] font-bold text-slate-600 mb-1">Alasan Koreksi</label>
              <textarea
                value={correctionReason}
                onChange={event => setCorrectionReason(event.target.value)}
                rows={3}
                placeholder="Wajib diisi"
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
              />
            </div>
          </div>
        ) : (
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
              ) : filteredEmployees.map(emp => {
                const assignment = assignmentByEmployeeId.get(emp.id);
                const isPublished = assignment?.schedule_status === 'PUBLISHED';
                return (
                <label key={emp.id} className={`flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 transition ${isPublished ? '' : 'cursor-pointer'} ${selectedIds.has(emp.id) ? 'bg-emerald-50' : ''}`}>
                  <input type="checkbox" checked={selectedIds.has(emp.id)} disabled={isPublished} onChange={() => toggleEmployee(emp.id)}
                    className="rounded border-slate-300 text-[#1b4332] focus:ring-[#1b4332]" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-bold text-slate-800 truncate">{emp.full_name}</div>
                    <div className="text-[9px] text-slate-500">{emp.position_name || '—'}{emp.department_name ? ` · ${emp.department_name}` : ''}</div>
                  </div>
                  {assignment && (
                    <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold ${
                      isPublished ? 'bg-emerald-100 text-emerald-800' :
                      assignment.schedule_status === 'CHANGED' ? 'bg-amber-100 text-amber-800' :
                      'bg-slate-100 text-slate-600'
                    }`}>
                      {assignment.schedule_status}
                    </span>
                  )}
                  {isPublished && assignment && (
                    <button
                      type="button"
                      onClick={event => {
                        event.preventDefault();
                        event.stopPropagation();
                        openCorrection(assignment);
                      }}
                      className="px-2 py-1 rounded border border-amber-300 bg-amber-50 text-[9px] font-bold text-amber-800 hover:bg-amber-100 cursor-pointer"
                    >
                      Koreksi
                    </button>
                  )}
                </label>
                );
              })}
            </div>
          )}
        </div>
        )}

        {/* Actions */}
        <div className="px-4 py-3 border-t border-slate-200 flex justify-end gap-2">
          {correctionAssignment ? (
            <>
              <button onClick={() => { setCorrectionAssignment(null); setError(''); }} disabled={saving}
                className="px-3 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 cursor-pointer">Batal</button>
              <button onClick={handleCorrectionSave} disabled={saving}
                className="px-4 py-1.5 text-[11px] font-bold rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] disabled:opacity-50 cursor-pointer">
                {saving ? 'Menyimpan...' : 'Simpan Koreksi'}
              </button>
            </>
          ) : (
            <>
              <button onClick={onClose}
                className="px-3 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 cursor-pointer">Batal</button>
              <button onClick={handleSave} disabled={saving}
                className="px-4 py-1.5 text-[11px] font-bold rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] disabled:opacity-50 cursor-pointer">
                {saving ? 'Menyimpan...' : 'Simpan'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
