import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type { WorkShiftTemplate, EmployeeWorkSchedule, WeeklyRosterResponse, MonthlyRosterResponse, Department, ViewMode, ColorKey } from './scheduleTypes';
import { COLOR_KEY_STYLES } from './scheduleTypes';
import { ShiftTemplateManager } from './ShiftTemplateManager';

interface ScheduleTabProps {
  propertyId: number;
}

const DAY_NAMES = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const DAY_FULL_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

function getMonday(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return formatDate(d);
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

function formatDisplayDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'][d.getMonth()]}`;
}

function getDayOfWeek(dateStr: string): number {
  return new Date(dateStr + 'T00:00:00').getDay();
}

const DEFAULT_COLOR_STYLE = COLOR_KEY_STYLES.soft_slate;

function getShiftColorByColorKey(colorKey: string | undefined) {
  if (colorKey && colorKey in COLOR_KEY_STYLES) {
    return COLOR_KEY_STYLES[colorKey as ColorKey];
  }
  return DEFAULT_COLOR_STYLE;
}

export const ScheduleTab: React.FC<ScheduleTabProps> = ({ propertyId }) => {
  const [loading, setLoading] = useState(true);
  const [roster, setRoster] = useState<WeeklyRosterResponse | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [selectedDeptId, setSelectedDeptId] = useState<number | ''>('');
  const [weekOffset, setWeekOffset] = useState(0);
  const [showTemplates, setShowTemplates] = useState(false);
  const [cellMenu, setCellMenu] = useState<{ employeeId: number; date: string; x: number; y: number } | null>(null);
  const [detailDrawer, setDetailDrawer] = useState<{ employeeId: number; date: string } | null>(null);
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedCells, setSelectedCells] = useState<Set<string>>(new Set());
  const [bulkShiftId, setBulkShiftId] = useState<number | ''>('');
  const [copyConfirm, setCopyConfirm] = useState<{ sourceMonday: string; targetMonday: string } | null>(null);
  const [publishConfirm, setPublishConfirm] = useState<{ monday: string; sunday: string } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [viewMode, setViewMode] = useState<ViewMode>('weekly');
  const [monthlyRoster, setMonthlyRoster] = useState<MonthlyRosterResponse | null>(null);
  const [monthOffset, setMonthOffset] = useState(0);

  const currentMonday = useMemo(() => {
    const today = new Date();
    const m = getMonday(formatDate(today));
    return addDays(m, weekOffset * 7);
  }, [weekOffset]);

  const currentSunday = addDays(currentMonday, 6);

  const getAuthHeaders = (): HeadersInit => {
    const token = localStorage.getItem('oak_hims_auth_token');
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  };

  const fetchRoster = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ property_id: String(propertyId), start_date: currentMonday });
      if (selectedDeptId) params.set('department_id', String(selectedDeptId));
      const res = await fetch(`/api/schedule/roster?${params}`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (data.status === 'OK') setRoster(data.data);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [propertyId, currentMonday, selectedDeptId]);

  const currentMonth = useMemo(() => {
    const now = new Date();
    now.setMonth(now.getMonth() + monthOffset);
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  }, [monthOffset]);

  const fetchMonthlyRoster = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        property_id: String(propertyId),
        year: String(currentMonth.year),
        month: String(currentMonth.month),
      });
      if (selectedDeptId) params.set('department_id', String(selectedDeptId));
      const res = await fetch(`/api/schedule/roster-monthly?${params}`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (data.status === 'OK') setMonthlyRoster(data.data);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [propertyId, currentMonth.year, currentMonth.month, selectedDeptId]);

  const fetchDepartments = useCallback(async () => {
    try {
      const res = await fetch(`/api/hrd/departments?property_id=${propertyId}&include_inactive=false`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (data.status === 'OK') setDepartments(data.data || []);
    } catch { /* ignore */ }
  }, [propertyId]);

  useEffect(() => { fetchDepartments(); }, [fetchDepartments]);
  useEffect(() => {
    if (viewMode === 'weekly') fetchRoster();
    else fetchMonthlyRoster();
  }, [viewMode, fetchRoster, fetchMonthlyRoster]);

  const handleCellClick = (employeeId: number, date: string, e: React.MouseEvent) => {
    if (bulkMode) {
      const key = `${employeeId}_${date}`;
      setSelectedCells(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
      });
      return;
    }
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    setCellMenu({ employeeId, date, x: rect.left, y: rect.bottom + 4 });
  };

  const handleAssignShift = async (employeeId: number, date: string, shiftTemplateId: number | null, workStatus?: string) => {
    setCellMenu(null);
    setActionLoading(true);
    try {
      const body: any = { property_id: propertyId, employee_id: employeeId, work_date: date };
      if (shiftTemplateId) body.shift_template_id = shiftTemplateId;
      if (workStatus) body.work_status = workStatus;
      const res = await fetch('/api/schedule/assign', {
        method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal mengubah jadwal');
      await fetchRoster();
    } catch (err: any) { alert(err.message); } finally { setActionLoading(false); }
  };

  const handleBulkAssign = async () => {
    if (selectedCells.size === 0 || !bulkShiftId) return;
    setActionLoading(true);
    try {
      const cellArray = Array.from(selectedCells).map(s => {
        const [empId, date] = s.split('_');
        return { employee_id: Number(empId), work_date: date };
      });
      // Group by employee, collect all dates
      const byEmployee = new Map<number, string[]>();
      for (const c of cellArray) {
        const dates = byEmployee.get(c.employee_id) || [];
        dates.push(c.work_date);
        byEmployee.set(c.employee_id, dates);
      }
      let totalAssigned = 0;
      for (const [empId, dates] of byEmployee) {
        const sortedDates = dates.sort();
        const res = await fetch('/api/schedule/bulk-assign', {
          method: 'POST', headers: getAuthHeaders(),
          body: JSON.stringify({
            property_id: propertyId,
            employee_ids: [empId],
            shift_template_id: Number(bulkShiftId),
            start_date: sortedDates[0],
            end_date: sortedDates[sortedDates.length - 1],
          }),
        });
        const data = await res.json();
        if (data.status === 'OK') totalAssigned += data.data?.assigned_count || 0;
      }
      setSelectedCells(new Set());
      setBulkMode(false);
      setBulkShiftId('');
      await fetchRoster();
    } catch (err: any) { alert(err.message); } finally { setActionLoading(false); }
  };

  const handleCopyWeek = async () => {
    if (!copyConfirm) return;
    setActionLoading(true);
    try {
      const res = await fetch('/api/schedule/copy-week', {
        method: 'POST', headers: getAuthHeaders(),
        body: JSON.stringify({
          property_id: propertyId,
          source_start_date: copyConfirm.sourceMonday,
          target_start_date: copyConfirm.targetMonday,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message);
      setCopyConfirm(null);
      await fetchRoster();
      alert(`Berhasil menyalin ${data.data?.copied_count || 0} jadwal. ${data.data?.skipped_conflicts || 0} konflik dilewati.`);
    } catch (err: any) { alert(err.message); } finally { setActionLoading(false); }
  };

  const handlePublish = async () => {
    if (!publishConfirm) return;
    setActionLoading(true);
    try {
      const res = await fetch('/api/schedule/publish', {
        method: 'POST', headers: getAuthHeaders(),
        body: JSON.stringify({
          property_id: propertyId,
          start_date: publishConfirm.monday,
          end_date: publishConfirm.sunday,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message);
      setPublishConfirm(null);
      await fetchRoster();
      alert(`Berhasil publish ${data.data?.published_count || 0} jadwal.`);
    } catch (err: any) { alert(err.message); } finally { setActionLoading(false); }
  };

  // Close cell menu on outside click
  useEffect(() => {
    if (!cellMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-cell-menu]')) setCellMenu(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [cellMenu]);

  const getScheduleDisplay = (sched: EmployeeWorkSchedule | null, templates: WorkShiftTemplate[]) => {
    if (!sched) return { label: '-', subLabel: '', colorClass: 'bg-white text-slate-300 border-slate-200', tooltip: '' };
    if (sched.work_status === 'OFF') return { label: 'OFF', subLabel: '', colorClass: 'bg-slate-100 text-slate-500 border-slate-200', tooltip: 'OFF' };
    if (sched.work_status === 'LEAVE') return { label: 'CUTI', subLabel: '', colorClass: 'bg-purple-100 text-purple-700 border-purple-200', tooltip: 'Cuti' };
    if (sched.work_status === 'SICK') return { label: 'SAKIT', subLabel: '', colorClass: 'bg-red-100 text-red-700 border-red-200', tooltip: 'Sakit' };
    if (sched.work_status === 'PERMISSION') return { label: 'IJIN', subLabel: '', colorClass: 'bg-orange-100 text-orange-700 border-orange-200', tooltip: 'Ijin' };
    if (sched.work_status === 'HOLIDAY') return { label: 'LIBUR', subLabel: '', colorClass: 'bg-cyan-100 text-cyan-700 border-cyan-200', tooltip: 'Holiday' };

    const tmpl = templates.find(t => t.id === sched.shift_template_id);
    if (tmpl) {
      const sc = getShiftColorByColorKey(tmpl.color_key);
      const startTime = tmpl.start_time.substring(0, 5);
      const endTime = tmpl.end_time.substring(0, 5);
      const statusIcon = sched.schedule_status === 'PUBLISHED' ? '' : sched.schedule_status === 'CHANGED' ? ' *' : '';
      const shiftName = tmpl.name;
      return {
        label: `${shiftName}${statusIcon}`,
        subLabel: `${startTime}–${endTime}`,
        colorClass: `${sc.bg} ${sc.text} ${sc.border}`,
        tooltip: `${tmpl.name} (${startTime}–${endTime})${sched.schedule_status !== 'DRAFT' ? ` [${sched.schedule_status}]` : ''}`,
      };
    }
    return { label: sched.work_status, subLabel: '', colorClass: 'bg-amber-100 text-amber-800 border-amber-300', tooltip: sched.work_status };
  };

  const filteredEmployees = useMemo(() => {
    if (!roster) return [];
    let emps = roster.employees;
    if (statusFilter) {
      emps = emps.filter(emp => {
        return Object.values(emp.schedules).some(s => {
          if (!s) return false;
          if (statusFilter === 'DRAFT') return s.schedule_status === 'DRAFT';
          if (statusFilter === 'PUBLISHED') return s.schedule_status === 'PUBLISHED';
          if (statusFilter === 'CHANGED') return s.schedule_status === 'CHANGED';
          if (statusFilter === 'OFF') return s.work_status === 'OFF';
          return true;
        });
      });
    }
    return emps;
  }, [roster, statusFilter]);

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="bg-white border border-slate-200/90 rounded-2xl p-3 shadow-xs">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            {/* View Mode Toggle */}
            <div className="flex items-center border border-slate-200 rounded-lg overflow-hidden">
              <button onClick={() => setViewMode('weekly')}
                className={`px-3 py-1.5 text-[11px] font-bold transition cursor-pointer ${viewMode === 'weekly' ? 'bg-[#1b4332] text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                Mingguan
              </button>
              <button onClick={() => setViewMode('monthly')}
                className={`px-3 py-1.5 text-[11px] font-bold transition cursor-pointer ${viewMode === 'monthly' ? 'bg-[#1b4332] text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                Bulanan
              </button>
            </div>

            {viewMode === 'weekly' ? (
              <>
                <button onClick={() => setWeekOffset(w => w - 1)} className="p-1.5 rounded-lg hover:bg-slate-100 transition cursor-pointer" title="Minggu Sebelumnya">
                  <svg className="w-4 h-4 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" /></svg>
                </button>
                <span className="text-xs font-bold text-slate-800 min-w-[180px] text-center">
                  {formatDisplayDate(currentMonday)} — {formatDisplayDate(currentSunday)}
                </span>
                <button onClick={() => setWeekOffset(w => w + 1)} className="p-1.5 rounded-lg hover:bg-slate-100 transition cursor-pointer" title="Minggu Berikutnya">
                  <svg className="w-4 h-4 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" /></svg>
                </button>
                <button onClick={() => setWeekOffset(0)} className="px-2 py-1 text-[10px] font-bold rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200 transition cursor-pointer">
                  Hari Ini
                </button>
              </>
            ) : (
              <>
                <button onClick={() => setMonthOffset(m => m - 1)} className="p-1.5 rounded-lg hover:bg-slate-100 transition cursor-pointer" title="Bulan Sebelumnya">
                  <svg className="w-4 h-4 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" /></svg>
                </button>
                <span className="text-xs font-bold text-slate-800 min-w-[140px] text-center">
                  {['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'][currentMonth.month - 1]} {currentMonth.year}
                </span>
                <button onClick={() => setMonthOffset(m => m + 1)} className="p-1.5 rounded-lg hover:bg-slate-100 transition cursor-pointer" title="Bulan Berikutnya">
                  <svg className="w-4 h-4 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" /></svg>
                </button>
                <button onClick={() => setMonthOffset(0)} className="px-2 py-1 text-[10px] font-bold rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200 transition cursor-pointer">
                  Bulan Ini
                </button>
              </>
            )}

          </div>

          <div className="flex items-center gap-2">
            <select value={selectedDeptId} onChange={e => setSelectedDeptId(e.target.value ? Number(e.target.value) : '')}
              className="px-2 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#1b4332] cursor-pointer">
              <option value="">Semua Departemen</option>
              {departments.filter(d => d.is_active).map(d => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>

            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
              className="px-2 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#1b4332] cursor-pointer">
              <option value="">Semua Status</option>
              <option value="DRAFT">Draft</option>
              <option value="PUBLISHED">Published</option>
              <option value="CHANGED">Changed</option>
              <option value="OFF">OFF</option>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-slate-100">
          <button onClick={() => setShowTemplates(!showTemplates)}
            className="px-3 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition cursor-pointer">
            {showTemplates ? 'Sembunyikan Template' : 'Kelola Template'}
          </button>
          <button onClick={() => {
            const prevMonday = addDays(currentMonday, -7);
            setCopyConfirm({ sourceMonday: prevMonday, targetMonday: currentMonday });
          }}
            className="px-3 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition cursor-pointer">
            Copy Minggu Lalu
          </button>
          <div className="flex-1" />
          <button onClick={() => setBulkMode(!bulkMode)}
            className={`px-3 py-1.5 text-[11px] font-bold rounded-lg transition cursor-pointer ${bulkMode ? 'bg-[#c5a880] text-white' : 'border border-[#c5a880] text-[#8b7355] hover:bg-[#fbf7ee]'}`}>
            {bulkMode ? `Batal Bulk (${selectedCells.size})` : 'Terapkan Shift'}
          </button>
          {bulkMode && selectedCells.size > 0 && (
            <select value={bulkShiftId} onChange={e => setBulkShiftId(e.target.value ? Number(e.target.value) : '')}
              className="px-2 py-1.5 text-[11px] font-bold rounded-lg border border-[#c5a880] bg-white text-slate-700 focus:outline-none cursor-pointer">
              <option value="">Pilih Shift...</option>
              {roster?.shift_templates.filter(t => t.is_active).map(t => (
                <option key={t.id} value={t.id}>{t.code} - {t.name}</option>
              ))}
            </select>
          )}
          {bulkMode && selectedCells.size > 0 && bulkShiftId && (
            <button onClick={handleBulkAssign} disabled={actionLoading}
              className="px-3 py-1.5 text-[11px] font-bold rounded-lg bg-[#c5a880] text-white hover:bg-[#b3956d] disabled:opacity-50 cursor-pointer">
              {actionLoading ? '...' : `Apply (${selectedCells.size})`}
            </button>
          )}
          <button onClick={() => setPublishConfirm({ monday: currentMonday, sunday: currentSunday })}
            className="px-3 py-1.5 text-[11px] font-bold rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] transition cursor-pointer">
            Publish Jadwal
          </button>
        </div>
      </div>

      {/* Shift Template Manager */}
      {showTemplates && (
        <div className="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-xs">
          <ShiftTemplateManager propertyId={propertyId} onTemplatesUpdated={fetchRoster} />
        </div>
      )}

      {/* Roster Grid */}
      <div className="bg-white border border-slate-200/90 rounded-2xl shadow-xs overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-xs text-slate-500">
            <div className="w-8 h-8 rounded-full border-2 border-[#1b4332] border-t-transparent animate-spin mx-auto mb-2" />
            Memuat jadwal kerja...
          </div>
        ) : viewMode === 'weekly' ? (
          /* Weekly Roster */
          filteredEmployees.length === 0 ? (
            <div className="p-12 text-center text-slate-400 text-xs">
              Tidak ada data jadwal kerja untuk periode ini.
            </div>
          ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[11px] border-collapse min-w-[900px]">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200/80">
                  <th className="py-2.5 px-3 font-bold text-slate-600 uppercase tracking-wider sticky left-0 bg-slate-50 z-10 min-w-[180px]">
                    Nama
                  </th>
                  {roster?.dates.map((date) => {
                    const dow = getDayOfWeek(date);
                    const isToday = date === formatDate(new Date());
                    return (
                      <th key={date} className={`py-2.5 px-2 font-bold text-center uppercase tracking-wider min-w-[90px] ${isToday ? 'bg-[#1b4332]/5' : ''}`}>
                        <div className="text-[10px] text-slate-500">{DAY_NAMES[dow]}</div>
                        <div className={`text-[11px] ${isToday ? 'text-[#1b4332] font-extrabold' : 'text-slate-800'}`}>{date.split('-')[2]}</div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredEmployees.map(emp => (
                  <tr key={emp.employee_id} className="hover:bg-slate-50/60 transition group">
                    <td className="py-2 px-3 sticky left-0 bg-white group-hover:bg-slate-50/60 z-10">
                      <div className="font-bold text-slate-900 text-[11px] leading-tight">{emp.employee_name}</div>
                      <div className="text-[10px] text-slate-400 leading-tight">
                        {emp.department_name || ''} {emp.position_name ? `• ${emp.position_name}` : ''}
                      </div>
                    </td>
                    {roster?.dates.map(date => {
                      const sched = emp.schedules[date];
                      const display = getScheduleDisplay(sched, roster.shift_templates);
                      const cellKey = `${emp.employee_id}_${date}`;
                      const isSelected = selectedCells.has(cellKey);
                      return (
                        <td key={date}
                          onClick={(e) => handleCellClick(emp.employee_id, date, e)}
                          className={`py-1.5 px-1.5 text-center cursor-pointer transition ${
                            isSelected ? 'ring-2 ring-[#c5a880] ring-inset bg-[#fbf7ee]' : 'hover:bg-slate-50'
                          }`}>
                          <div
                            className={`inline-block px-2 py-1 rounded-lg border text-[10px] font-bold min-w-[52px] ${display.colorClass}`}
                            title={display.tooltip}
                          >
                            <div className="leading-tight">{display.label}</div>
                            {display.subLabel && (
                              <div className="text-[8px] font-normal opacity-75 leading-tight">{display.subLabel}</div>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )
        ) : (
          /* Monthly Roster */
          !monthlyRoster || monthlyRoster.employees.length === 0 ? (
            <div className="p-12 text-center text-slate-400 text-xs">
              Tidak ada data jadwal kerja untuk bulan ini.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[10px] border-collapse min-w-[800px]">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200/80">
                    <th className="py-2 px-2 font-bold text-slate-600 uppercase tracking-wider sticky left-0 bg-slate-50 z-10 min-w-[140px]">
                      Karyawan
                    </th>
                    {monthlyRoster.dates.map(date => {
                      const d = new Date(date + 'T00:00:00');
                      const dayNum = d.getDate();
                      const dow = d.getDay();
                      const isWeekend = dow === 0 || dow === 6;
                      return (
                        <th key={date}
                          className={`py-1 px-0.5 text-center font-bold min-w-[28px] ${isWeekend ? 'bg-slate-100' : ''}`}>
                          <div className="text-[8px] text-slate-400">{DAY_NAMES[dow]}</div>
                          <div className="text-[9px] text-slate-700">{dayNum}</div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {monthlyRoster.employees.map(emp => (
                    <tr key={emp.employee_id} className="hover:bg-slate-50/60 transition group">
                      <td className="py-1.5 px-2 sticky left-0 bg-white group-hover:bg-slate-50/60 z-10">
                        <div className="font-bold text-slate-900 text-[10px] leading-tight">{emp.employee_name}</div>
                        <div className="text-[8px] text-slate-400 leading-tight">
                          {emp.department_name || ''}
                        </div>
                      </td>
                      {monthlyRoster.dates.map(date => {
                        const sched = emp.schedules[date];
                        const display = getScheduleDisplay(sched, monthlyRoster.shift_templates);
                        const d = new Date(date + 'T00:00:00');
                        const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                        return (
                          <td key={date}
                            className={`py-0.5 px-0.5 text-center ${isWeekend ? 'bg-slate-50/50' : ''}`}>
                            <div
                              className={`inline-block px-1 py-0.5 rounded border text-[8px] font-bold min-w-[24px] ${display.colorClass}`}
                              title={display.tooltip}
                            >
                              <div className="leading-tight">{display.label}</div>
                              {display.subLabel && (
                                <div className="text-[7px] font-normal opacity-70 leading-tight">{display.subLabel}</div>
                              )}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 text-[10px] text-slate-500 flex-wrap">
        <span className="font-bold uppercase tracking-wider">Legenda:</span>
        {roster?.shift_templates.filter(t => t.is_active).map(t => {
          const sc = getShiftColorByColorKey(t.color_key);
          return (
            <span key={t.id} className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${sc.bg} ${sc.text} ${sc.border}`}>
              {t.code} = {t.name}
            </span>
          );
        })}
        <span className="px-1.5 py-0.5 rounded border text-[10px] font-bold bg-slate-100 text-slate-500 border-slate-200">OFF</span>
        <span className="text-[10px] text-slate-400 italic">* = Changed after publish</span>
      </div>

      {/* Cell Context Menu */}
      {cellMenu && (
        <div data-cell-menu
          className="fixed z-50 bg-white border border-slate-200 rounded-xl shadow-xl py-1 min-w-[160px]"
          style={{ left: cellMenu.x, top: cellMenu.y }}>
          <div className="px-3 py-1.5 text-[10px] font-bold text-slate-400 uppercase border-b border-slate-100">
            {cellMenu.date} {DAY_FULL_NAMES[getDayOfWeek(cellMenu.date)]}
          </div>
          {roster?.shift_templates.filter(t => t.is_active).map(t => (
            <button key={t.id}
              onClick={() => handleAssignShift(cellMenu.employeeId, cellMenu.date, t.id)}
              className="w-full text-left px-3 py-1.5 text-[11px] font-bold text-slate-700 hover:bg-slate-50 transition cursor-pointer flex items-center gap-2">
              <span className={`w-5 h-5 rounded flex items-center justify-center text-[9px] font-extrabold ${getShiftColorByColorKey(t.color_key).bg} ${getShiftColorByColorKey(t.color_key).text}`}>
                {t.code.charAt(0)}
              </span>
              {t.name} ({t.start_time.substring(0, 5)}-{t.end_time.substring(0, 5)})
            </button>
          ))}
          <div className="border-t border-slate-100 my-0.5" />
          <button onClick={() => handleAssignShift(cellMenu.employeeId, cellMenu.date, null, 'OFF')}
            className="w-full text-left px-3 py-1.5 text-[11px] font-bold text-slate-500 hover:bg-slate-50 transition cursor-pointer flex items-center gap-2">
            <span className="w-5 h-5 rounded flex items-center justify-center text-[9px] font-extrabold bg-slate-100 text-slate-500">-</span>
            OFF
          </button>
          <div className="border-t border-slate-100 my-0.5" />
          <button onClick={() => { setDetailDrawer(cellMenu); setCellMenu(null); }}
            className="w-full text-left px-3 py-1.5 text-[11px] font-bold text-[#1b4332] hover:bg-[#1b4332]/5 transition cursor-pointer">
            Detail & Edit...
          </button>
        </div>
      )}

      {/* Detail Drawer */}
      {detailDrawer && (
        <ScheduleDetailDrawer
          propertyId={propertyId}
          employeeId={detailDrawer.employeeId}
          date={detailDrawer.date}
          roster={roster}
          onClose={() => setDetailDrawer(null)}
          onUpdated={fetchRoster}
        />
      )}

      {/* Copy Week Confirm */}
      {copyConfirm && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full border border-slate-200 shadow-xl p-5 space-y-3">
            <h3 className="font-serif font-bold text-sm text-slate-900">Copy Minggu Sebelumnya?</h3>
            <p className="text-xs text-slate-600">
              Salin jadwal dari minggu <strong>{formatDisplayDate(copyConfirm.sourceMonday)}</strong> ke minggu <strong>{formatDisplayDate(copyConfirm.targetMonday)}</strong>?
            </p>
            <p className="text-[10px] text-slate-400">Jadwal yang sudah ada di minggu target tidak akan ditimpa (dilewati).</p>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setCopyConfirm(null)} className="px-3 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 cursor-pointer">Batal</button>
              <button onClick={handleCopyWeek} disabled={actionLoading}
                className="px-3 py-1.5 text-[11px] font-bold rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] disabled:opacity-50 cursor-pointer">
                {actionLoading ? 'Menyalin...' : 'Salin'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Publish Confirm */}
      {publishConfirm && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full border border-slate-200 shadow-xl p-5 space-y-3">
            <h3 className="font-serif font-bold text-sm text-slate-900">Publish Jadwal Kerja?</h3>
            <p className="text-xs text-slate-600">
              Publish jadwal minggu <strong>{formatDisplayDate(publishConfirm.monday)}</strong> — <strong>{formatDisplayDate(publishConfirm.sunday)}</strong>?
            </p>
            <p className="text-[10px] text-slate-400">Setelah dipublish, perubahan akan tercatat di audit trail.</p>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setPublishConfirm(null)} className="px-3 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 cursor-pointer">Batal</button>
              <button onClick={handlePublish} disabled={actionLoading}
                className="px-3 py-1.5 text-[11px] font-bold rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] disabled:opacity-50 cursor-pointer">
                {actionLoading ? 'Publishing...' : 'Publish'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Schedule Detail Drawer ───

interface ScheduleDetailDrawerProps {
  propertyId: number;
  employeeId: number;
  date: string;
  roster: WeeklyRosterResponse | null;
  onClose: () => void;
  onUpdated: () => void;
}

const ScheduleDetailDrawer: React.FC<ScheduleDetailDrawerProps> = ({ propertyId, employeeId, date, roster, onClose, onUpdated }) => {
  const emp = roster?.employees.find(e => e.employee_id === employeeId);
  const sched = emp?.schedules[date] || null;
  const [editMode, setEditMode] = useState(false);
  const [selectedShiftId, setSelectedShiftId] = useState<number | ''>(sched?.shift_template_id || '');
  const [selectedStatus, setSelectedStatus] = useState(sched?.work_status || 'WORK');
  const [notes, setNotes] = useState(sched?.notes || '');
  const [saving, setSaving] = useState(false);

  const getAuthHeaders = (): HeadersInit => {
    const token = localStorage.getItem('oak_hims_auth_token');
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const body: any = {
        property_id: propertyId,
        employee_id: employeeId,
        work_date: date,
        work_status: selectedStatus,
        notes: notes || undefined,
      };
      if (selectedStatus === 'WORK' && selectedShiftId) {
        body.shift_template_id = Number(selectedShiftId);
      }
      const res = await fetch('/api/schedule/assign', {
        method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message);
      setEditMode(false);
      onUpdated();
    } catch (err: any) { alert(err.message); } finally { setSaving(false); }
  };

  const tmpl = sched?.shift_template_id ? roster?.shift_templates.find(t => t.id === sched.shift_template_id) : null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex justify-end">
      <div className="w-[340px] bg-white h-full shadow-xl overflow-y-auto">
        <div className="p-4 border-b border-slate-200 flex items-center justify-between">
          <h3 className="font-serif font-bold text-sm text-slate-900">Detail Jadwal</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 cursor-pointer">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="p-4 space-y-3">
          {/* Employee Info */}
          <div className="bg-slate-50 rounded-xl p-3">
            <div className="text-xs font-bold text-slate-900">{emp?.employee_name || 'Unknown'}</div>
            <div className="text-[10px] text-slate-500">{emp?.department_name || ''} {emp?.position_name ? `• ${emp.position_name}` : ''}</div>
            <div className="text-[10px] text-slate-400 mt-1">
              {date} {DAY_FULL_NAMES[getDayOfWeek(date)]}
            </div>
          </div>

          {sched?.schedule_status === 'CHANGED' && (
            <div className="p-2 rounded-lg bg-amber-50 border border-amber-200 text-[10px] font-bold text-amber-800">
              Jadwal telah diubah setelah dipublish
            </div>
          )}

          {!editMode ? (
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-[10px] font-bold text-slate-500 uppercase">Shift</span>
                <span className="text-xs font-bold text-slate-900">{tmpl ? `${tmpl.code} - ${tmpl.name}` : '-'}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[10px] font-bold text-slate-500 uppercase">Jam Kerja</span>
                <span className="text-xs text-slate-700">{tmpl ? `${tmpl.start_time.substring(0, 5)} - ${tmpl.end_time.substring(0, 5)}` : '-'}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[10px] font-bold text-slate-500 uppercase">Status</span>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                  sched?.work_status === 'OFF' ? 'bg-slate-100 text-slate-600' :
                  sched?.work_status === 'WORK' ? 'bg-emerald-100 text-emerald-800' :
                  'bg-amber-100 text-amber-800'
                }`}>{sched?.work_status || 'Belum dijadwalkan'}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[10px] font-bold text-slate-500 uppercase">Status Publish</span>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                  sched?.schedule_status === 'PUBLISHED' ? 'bg-emerald-100 text-emerald-800' :
                  sched?.schedule_status === 'CHANGED' ? 'bg-amber-100 text-amber-800' :
                  'bg-slate-100 text-slate-600'
                }`}>{sched?.schedule_status || '-'}</span>
              </div>
              {sched?.notes && (
                <div>
                  <span className="text-[10px] font-bold text-slate-500 uppercase">Catatan</span>
                  <p className="text-xs text-slate-700 mt-0.5">{sched.notes}</p>
                </div>
              )}
              <div className="pt-2">
                <button onClick={() => setEditMode(true)}
                  className="w-full px-3 py-2 text-[11px] font-bold rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] transition cursor-pointer">
                  Edit Jadwal
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="block text-[10px] font-bold text-slate-600 mb-1">Status Hari</label>
                <select value={selectedStatus} onChange={e => setSelectedStatus(e.target.value as any)}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332] cursor-pointer">
                  <option value="WORK">Kerja (WORK)</option>
                  <option value="OFF">OFF</option>
                  <option value="LEAVE">Cuti (LEAVE)</option>
                  <option value="SICK">Sakit (SICK)</option>
                  <option value="PERMISSION">Ijin (PERMISSION)</option>
                  <option value="HOLIDAY">Holiday</option>
                </select>
              </div>

              {selectedStatus === 'WORK' && (
                <div>
                  <label className="block text-[10px] font-bold text-slate-600 mb-1">Shift</label>
                  <select value={selectedShiftId} onChange={e => setSelectedShiftId(e.target.value ? Number(e.target.value) : '')}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332] cursor-pointer">
                    <option value="">Pilih Shift...</option>
                    {roster?.shift_templates.filter(t => t.is_active).map(t => (
                      <option key={t.id} value={t.id}>{t.code} - {t.name} ({t.start_time.substring(0, 5)}-{t.end_time.substring(0, 5)})</option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-[10px] font-bold text-slate-600 mb-1">Catatan</label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332] resize-none"
                  placeholder="Opsional..." />
              </div>

              <div className="flex gap-2 pt-1">
                <button onClick={() => setEditMode(false)}
                  className="flex-1 px-3 py-2 text-[11px] font-bold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 cursor-pointer">
                  Batal
                </button>
                <button onClick={handleSave} disabled={saving}
                  className="flex-1 px-3 py-2 text-[11px] font-bold rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] disabled:opacity-50 cursor-pointer">
                  {saving ? 'Menyimpan...' : 'Simpan'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
