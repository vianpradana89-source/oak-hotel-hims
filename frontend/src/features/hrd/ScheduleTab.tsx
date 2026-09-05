import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type { WeeklyRosterResponse, MonthlyRosterResponse, Department, WorkShiftTemplate, EmployeeWorkSchedule, OperationalRosterResponse } from './scheduleTypes';
import { COLOR_KEY_STYLES } from './scheduleTypes';
import { ShiftRosterView } from './ShiftRosterView';
import { EmployeeRosterView } from './EmployeeRosterView';
import { ShiftDayModal } from './ShiftDayModal';
import { GroupedRosterView } from './GroupedRosterView';
import { KelolaShiftDrawer } from './KelolaShiftDrawer';
import { KelolaGroupDrawer } from './KelolaGroupDrawer';
import { HolidayCalendarDrawer } from './HolidayCalendarDrawer';
import { NonOpBulkPatternDrawer } from './NonOpBulkPatternDrawer';
import { NonOpDayModal } from './NonOpDayModal';

interface ScheduleTabProps {
  propertyId: number;
}

const DAY_NAMES = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const MONTHS_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

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

type ScheduleMode = 'shift' | 'employee' | 'grouped';
type SchedulePeriod = 'weekly' | 'monthly';

export const ScheduleTab: React.FC<ScheduleTabProps> = ({ propertyId }) => {
  const [loading, setLoading] = useState(true);
  const [roster, setRoster] = useState<WeeklyRosterResponse | null>(null);
  const [groupedRoster, setGroupedRoster] = useState<OperationalRosterResponse | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [selectedDeptId, setSelectedDeptId] = useState<number | ''>('');
  const [weekOffset, setWeekOffset] = useState(0);
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>('grouped');
  const [viewPeriod, setViewPeriod] = useState<SchedulePeriod>('weekly');
  const [monthOffset, setMonthOffset] = useState(0);
  const [monthlyRoster, setMonthlyRoster] = useState<MonthlyRosterResponse | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [viewMode, setViewMode] = useState<'all' | 'operational' | 'non_operational'>('all');

  const [showKelolaShift, setShowKelolaShift] = useState(false);
  const [showKelolaGroup, setShowKelolaGroup] = useState(false);
  const [showHolidayCalendar, setShowHolidayCalendar] = useState(false);
  const [showNonOpBulk, setShowNonOpBulk] = useState(false);
  const [shiftDayModal, setShiftDayModal] = useState<{ shiftType: string; templateId: number | null; date: string; groupId?: number } | null>(null);
  const [employeeDayModal, setEmployeeDayModal] = useState<{ employeeId: number; date: string } | null>(null);
  const [nonOpDayModal, setNonOpDayModal] = useState<{
    departmentId: number;
    departmentName: string;
    date: string;
    employees: { employee_id: number; employee_name: string; employee_code: string | null; position_name: string | null }[];
    currentStatuses: Record<number, string>;
  } | null>(null);
  const [copyConfirm, setCopyConfirm] = useState<{ sourceMonday: string; targetMonday: string } | null>(null);
  const [publishConfirm, setPublishConfirm] = useState<{ monday: string; sunday: string } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const currentMonday = useMemo(() => {
    const today = new Date();
    const m = getMonday(formatDate(today));
    return addDays(m, weekOffset * 7);
  }, [weekOffset]);

  const currentSunday = addDays(currentMonday, 6);

  const currentMonth = useMemo(() => {
    const now = new Date();
    now.setMonth(now.getMonth() + monthOffset);
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  }, [monthOffset]);

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

  const fetchGroupedRoster = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        property_id: String(propertyId),
        start_date: currentMonday,
        end_date: currentSunday,
        view_mode: viewMode,
      });
      if (selectedDeptId) params.set('department_id', String(selectedDeptId));
      const res = await fetch(`/api/schedule/grouped-roster?${params}`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (data.status === 'OK') setGroupedRoster(data.data);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [propertyId, currentMonday, currentSunday, viewMode, selectedDeptId]);

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
    if (scheduleMode === 'grouped' && viewPeriod === 'weekly') fetchGroupedRoster();
    else if (viewPeriod === 'weekly') fetchRoster();
    else fetchMonthlyRoster();
  }, [scheduleMode, viewPeriod, fetchRoster, fetchGroupedRoster, fetchMonthlyRoster]);

  const refreshCurrentView = useCallback(() => {
    if (scheduleMode === 'grouped' && viewPeriod === 'weekly') fetchGroupedRoster();
    else if (viewPeriod === 'weekly') fetchRoster();
    else fetchMonthlyRoster();
  }, [scheduleMode, viewPeriod, fetchRoster, fetchGroupedRoster, fetchMonthlyRoster]);

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
      refreshCurrentView();
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
      refreshCurrentView();
      alert(`Berhasil publish ${data.data?.published_count || 0} jadwal.`);
    } catch (err: any) { alert(err.message); } finally { setActionLoading(false); }
  };

  const handleShiftCellClick = (shiftType: string, templateId: number | null, date: string, groupId?: number) => {
    setShiftDayModal({ shiftType, templateId, date, groupId });
  };

  const handleEmployeeCellClick = (employeeId: number, date: string) => {
    setEmployeeDayModal({ employeeId, date });
  };

  const handleNonOpCellClick = (info: {
    departmentId: number;
    departmentName: string;
    date: string;
    employees: { employee_id: number; employee_name: string; employee_code: string | null; position_name: string | null }[];
    currentStatuses: Record<number, string>;
  }) => {
    setNonOpDayModal(info);
  };

  const handleEmployeeDaySave = async (employeeId: number, date: string, shiftTemplateId: number | null, workStatus: string) => {
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
      setEmployeeDayModal(null);
      refreshCurrentView();
    } catch (err: any) { alert(err.message); } finally { setActionLoading(false); }
  };

  // Compute publish status
  const publishStatus = useMemo(() => {
    const source = scheduleMode === 'grouped' ? null : roster;
    if (!source) return null;
    let hasDraft = false, hasChanged = false, hasPublished = false;
    for (const emp of source.employees) {
      for (const date of source.dates) {
        const sched = emp.schedules[date];
        if (!sched) continue;
        if (sched.schedule_status === 'DRAFT') hasDraft = true;
        if (sched.schedule_status === 'CHANGED') hasChanged = true;
        if (sched.schedule_status === 'PUBLISHED') hasPublished = true;
      }
    }
    if (hasChanged) return 'CHANGED';
    if (hasDraft && hasPublished) return 'MIXED';
    if (hasDraft) return 'DRAFT';
    if (hasPublished) return 'PUBLISHED';
    return null;
  }, [roster, scheduleMode]);

  const publishStatusLabel = publishStatus === 'DRAFT' ? 'Draft' :
    publishStatus === 'CHANGED' ? 'Ada Perubahan' :
    publishStatus === 'PUBLISHED' ? 'Terbit' :
    publishStatus === 'MIXED' ? 'Campuran' : null;

  const publishStatusClass = publishStatus === 'DRAFT' ? 'bg-slate-100 text-slate-600' :
    publishStatus === 'CHANGED' ? 'bg-amber-100 text-amber-800' :
    publishStatus === 'PUBLISHED' ? 'bg-emerald-100 text-emerald-800' :
    publishStatus === 'MIXED' ? 'bg-blue-100 text-blue-800' : '';

  const getScheduleDisplay = (sched: EmployeeWorkSchedule | null, templates: WorkShiftTemplate[]) => {
    if (!sched) return { label: '-', subLabel: '', colorClass: 'text-slate-300', bgClass: '' };
    if (sched.work_status === 'OFF') return { label: 'OFF', subLabel: '', colorClass: 'text-slate-500', bgClass: 'bg-slate-50' };
    if (sched.work_status === 'LEAVE') return { label: 'Cuti', subLabel: '', colorClass: 'text-purple-600', bgClass: 'bg-purple-50' };
    if (sched.work_status === 'SICK') return { label: 'Sakit', subLabel: '', colorClass: 'text-rose-600', bgClass: 'bg-rose-50' };
    if (sched.work_status === 'PERMISSION') return { label: 'Ijin', subLabel: '', colorClass: 'text-amber-600', bgClass: 'bg-amber-50' };
    if (sched.work_status === 'HOLIDAY') return { label: 'Libur', subLabel: '', colorClass: 'text-cyan-600', bgClass: 'bg-cyan-50' };
    const tmpl = templates.find(t => t.id === sched.shift_template_id);
    if (tmpl) {
      const sc = COLOR_KEY_STYLES[tmpl.color_key as keyof typeof COLOR_KEY_STYLES] || COLOR_KEY_STYLES.soft_slate;
      return { label: tmpl.name, subLabel: `${tmpl.start_time.substring(0, 5)}–${tmpl.end_time.substring(0, 5)}`, colorClass: sc.text, bgClass: sc.bg };
    }
    return { label: sched.work_status, subLabel: '', colorClass: 'text-amber-700', bgClass: 'bg-amber-50' };
  };

  const filteredMonthlyEmployees = useMemo(() => {
    if (!monthlyRoster) return [];
    if (!statusFilter) return monthlyRoster.employees;
    return monthlyRoster.employees.filter(emp => Object.values(emp.schedules).some(s => {
      if (!s) return false;
      if (statusFilter === 'DRAFT') return s.schedule_status === 'DRAFT';
      if (statusFilter === 'PUBLISHED') return s.schedule_status === 'PUBLISHED';
      if (statusFilter === 'CHANGED') return s.schedule_status === 'CHANGED';
      if (statusFilter === 'OFF') return s.work_status === 'OFF';
      return true;
    }));
  }, [monthlyRoster, statusFilter]);

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  return (
    <div className="space-y-3">
      {/* Top Action Bar */}
      <div className="bg-white border border-slate-200/90 rounded-2xl p-3 shadow-xs">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            {/* Schedule Mode Toggle */}
            <div className="flex items-center border border-slate-200 rounded-lg overflow-hidden">
              <button onClick={() => setScheduleMode('grouped')}
                className={`px-3 py-1.5 text-[11px] font-bold transition cursor-pointer ${scheduleMode === 'grouped' ? 'bg-[#1b4332] text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                Grouped
              </button>
              <button onClick={() => setScheduleMode('shift')}
                className={`px-3 py-1.5 text-[11px] font-bold transition cursor-pointer ${scheduleMode === 'shift' ? 'bg-[#1b4332] text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                Per Shift
              </button>
              <button onClick={() => setScheduleMode('employee')}
                className={`px-3 py-1.5 text-[11px] font-bold transition cursor-pointer ${scheduleMode === 'employee' ? 'bg-[#1b4332] text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                Per Karyawan
              </button>
            </div>

            {/* Period Toggle */}
            <div className="flex items-center border border-slate-200 rounded-lg overflow-hidden">
              <button onClick={() => setViewPeriod('weekly')}
                className={`px-3 py-1.5 text-[11px] font-bold transition cursor-pointer ${viewPeriod === 'weekly' ? 'bg-[#1b4332]/10 text-[#1b4332]' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                Mingguan
              </button>
              <button onClick={() => setViewPeriod('monthly')}
                className={`px-3 py-1.5 text-[11px] font-bold transition cursor-pointer ${viewPeriod === 'monthly' ? 'bg-[#1b4332]/10 text-[#1b4332]' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                Bulanan
              </button>
            </div>

            {/* Navigation */}
            {viewPeriod === 'weekly' ? (
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
                <button onClick={() => setWeekOffset(0)} className="px-2 py-1 text-[10px] font-bold rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200 transition cursor-pointer">Hari Ini</button>
              </>
            ) : (
              <>
                <button onClick={() => setMonthOffset(m => m - 1)} className="p-1.5 rounded-lg hover:bg-slate-100 transition cursor-pointer" title="Bulan Sebelumnya">
                  <svg className="w-4 h-4 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" /></svg>
                </button>
                <span className="text-xs font-bold text-slate-800 min-w-[140px] text-center">{MONTHS_ID[currentMonth.month - 1]} {currentMonth.year}</span>
                <button onClick={() => setMonthOffset(m => m + 1)} className="p-1.5 rounded-lg hover:bg-slate-100 transition cursor-pointer" title="Bulan Berikutnya">
                  <svg className="w-4 h-4 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" /></svg>
                </button>
                <button onClick={() => setMonthOffset(0)} className="px-2 py-1 text-[10px] font-bold rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200 transition cursor-pointer">Bulan Ini</button>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            {publishStatusLabel && (
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${publishStatusClass}`}>{publishStatusLabel}</span>
            )}

            <select value={selectedDeptId} onChange={e => setSelectedDeptId(e.target.value ? Number(e.target.value) : '')}
              className="px-2 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#1b4332] cursor-pointer">
              <option value="">Semua Departemen</option>
              {departments.filter(d => d.is_active).map(d => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>

            {scheduleMode === 'grouped' && (
              <div className="flex items-center border border-slate-200 rounded-lg overflow-hidden">
                <button onClick={() => setViewMode('all')}
                  className={`px-2 py-1.5 text-[10px] font-bold transition cursor-pointer ${viewMode === 'all' ? 'bg-[#1b4332] text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>Semua</button>
                <button onClick={() => setViewMode('operational')}
                  className={`px-2 py-1.5 text-[10px] font-bold transition cursor-pointer ${viewMode === 'operational' ? 'bg-[#1b4332] text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>Operasional</button>
                <button onClick={() => setViewMode('non_operational')}
                  className={`px-2 py-1.5 text-[10px] font-bold transition cursor-pointer ${viewMode === 'non_operational' ? 'bg-[#1b4332] text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>Non-Operasional</button>
              </div>
            )}

            {viewPeriod === 'monthly' && (
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
                className="px-2 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#1b4332] cursor-pointer">
                <option value="">Semua Status</option>
                <option value="DRAFT">Draft</option>
                <option value="CHANGED">Ada Perubahan</option>
                <option value="PUBLISHED">Terbit</option>
                <option value="OFF">OFF</option>
              </select>
            )}
          </div>
        </div>

        {/* Row 2: Actions */}
        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-slate-100">
          <button onClick={() => { const prevMonday = addDays(currentMonday, -7); setCopyConfirm({ sourceMonday: prevMonday, targetMonday: currentMonday }); }}
            className="px-3 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition cursor-pointer">
            Salin Minggu Lalu
          </button>
          <div className="flex-1" />
          <button onClick={() => setShowKelolaShift(true)}
            className="px-3 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition cursor-pointer">
            Kelola Shift
          </button>
          <button onClick={() => setShowKelolaGroup(true)}
            className="px-3 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition cursor-pointer">
            Kelola Group Operasional
          </button>
          <button onClick={() => setShowHolidayCalendar(true)}
            className="px-3 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition cursor-pointer">
            Kalender Hari Libur
          </button>
          <button onClick={() => setShowNonOpBulk(true)}
            className="px-3 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition cursor-pointer">
            Atur Pola Non-Operasional
          </button>
          <button onClick={() => setPublishConfirm({ monday: currentMonday, sunday: currentSunday })}
            className="px-3 py-1.5 text-[11px] font-bold rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] transition cursor-pointer">
            Publish Jadwal
          </button>
        </div>
      </div>

      {/* Roster Content */}
      <div className="bg-white border border-slate-200/90 rounded-2xl shadow-xs overflow-hidden">
        {scheduleMode === 'grouped' && viewPeriod === 'weekly' ? (
          <GroupedRosterView
            groupedRoster={groupedRoster}
            loading={loading}
            onShiftCellClick={handleShiftCellClick}
            onNonOpCellClick={handleNonOpCellClick}
            todayStr={todayStr}
          />
        ) : viewPeriod === 'weekly' ? (
          scheduleMode === 'shift' ? (
            <ShiftRosterView roster={roster} loading={loading} onCellClick={handleShiftCellClick} />
          ) : (
            <EmployeeRosterView roster={roster} loading={loading} onCellClick={handleEmployeeCellClick} />
          )
        ) : (
          /* Monthly View */
          !monthlyRoster || filteredMonthlyEmployees.length === 0 ? (
            <div className="p-12 text-center text-slate-400 text-xs">Tidak ada data jadwal kerja untuk bulan ini.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[10px] border-collapse min-w-[800px]">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200/80">
                    <th className="py-2 px-2 font-bold text-slate-600 uppercase tracking-wider sticky left-0 bg-slate-50 z-10 min-w-[140px]">
                      {scheduleMode === 'shift' ? 'Keterangan Shift' : 'Karyawan'}
                    </th>
                    {monthlyRoster.dates.map(date => {
                      const d = new Date(date + 'T00:00:00');
                      const dayNum = d.getDate();
                      const dow = d.getDay();
                      const isWeekend = dow === 0 || dow === 6;
                      const isToday = date === todayStr;
                      return (
                        <th key={date} className={`py-1 px-0.5 text-center font-bold min-w-[28px] ${isWeekend ? 'bg-slate-100' : ''} ${isToday ? 'bg-[#1b4332]/5' : ''}`}>
                          <div className="text-[8px] text-slate-400">{DAY_NAMES[dow]}</div>
                          <div className={`text-[9px] ${isToday ? 'text-[#1b4332] font-extrabold' : 'text-slate-700'}`}>{dayNum}</div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {scheduleMode === 'employee' ? (
                    filteredMonthlyEmployees.map(emp => (
                      <tr key={emp.employee_id} className="hover:bg-slate-50/60 transition group">
                        <td className="py-1.5 px-2 sticky left-0 bg-white group-hover:bg-slate-50/60 z-10">
                          <div className="font-bold text-slate-900 text-[10px] leading-tight">{emp.employee_name}</div>
                          <div className="text-[8px] text-slate-400 leading-tight">{emp.department_name || ''}</div>
                        </td>
                        {monthlyRoster.dates.map(date => {
                          const sched = emp.schedules[date];
                          const display = getScheduleDisplay(sched, monthlyRoster.shift_templates);
                          const d = new Date(date + 'T00:00:00');
                          const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                          const isToday = date === todayStr;
                          return (
                            <td key={date} onClick={() => handleEmployeeCellClick(emp.employee_id, date)}
                              className={`py-0.5 px-0.5 text-center cursor-pointer ${isWeekend ? 'bg-slate-50/50' : ''} ${isToday ? 'bg-[#1b4332]/[0.02]' : ''}`}>
                              <div className={`inline-block px-1 py-0.5 rounded border text-[8px] font-bold min-w-[24px] ${display.bgClass}`}>
                                <div className={`leading-tight ${display.colorClass}`}>{display.label}</div>
                                {display.subLabel && <div className="text-[7px] font-normal text-slate-400 leading-tight">{display.subLabel}</div>}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))
                  ) : (
                    (() => {
                      const shiftRows = monthlyRoster.shift_templates.filter(t => t.is_active);
                      return shiftRows.map(tmpl => {
                        const sc = COLOR_KEY_STYLES[tmpl.color_key as keyof typeof COLOR_KEY_STYLES] || COLOR_KEY_STYLES.soft_slate;
                        return (
                          <tr key={tmpl.id} className="hover:bg-white/80 transition group">
                            <td className="py-1.5 px-2 sticky left-0 bg-white group-hover:bg-white/80 z-10">
                              <div className="flex items-center gap-1.5">
                                <span className={`w-2 h-2 rounded-full ${sc.swatch} shrink-0`} />
                                <div>
                                  <div className={`font-bold text-[10px] leading-tight ${sc.text}`}>{tmpl.name}</div>
                                  <div className="text-[7px] text-slate-400 font-mono leading-tight">{tmpl.start_time.substring(0, 5)}–{tmpl.end_time.substring(0, 5)}</div>
                                </div>
                              </div>
                            </td>
                            {monthlyRoster.dates.map(date => {
                              const employeesOnShift: string[] = [];
                              for (const emp of monthlyRoster.employees) {
                                const sched = emp.schedules[date];
                                if (sched && sched.shift_template_id === tmpl.id && sched.work_status === 'WORK') employeesOnShift.push(emp.employee_name);
                              }
                              const d = new Date(date + 'T00:00:00');
                              const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                              const isToday = date === todayStr;
                              return (
                                <td key={date} onClick={() => handleShiftCellClick('shift', tmpl.id, date)}
                                  className={`py-0.5 px-0.5 text-center cursor-pointer ${isWeekend ? 'bg-slate-50/50' : ''} ${isToday ? 'bg-[#1b4332]/[0.02]' : ''}`}>
                                  {employeesOnShift.length === 0 ? (
                                    <span className="text-slate-300 text-[8px]">—</span>
                                  ) : (
                                    <div className="flex flex-col items-start gap-px">
                                      {employeesOnShift.slice(0, 2).map(name => (
                                        <span key={name} className={`inline-block px-0.5 py-px rounded text-[7px] font-semibold leading-tight ${sc.bg} ${sc.text} w-full text-left truncate`}>{name}</span>
                                      ))}
                                      {employeesOnShift.length > 2 && <span className="text-[6px] text-slate-400 font-bold px-0.5">+{employeesOnShift.length - 2}</span>}
                                    </div>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      });
                    })()
                  )}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>

      {/* Modals */}
      {shiftDayModal && (roster || groupedRoster) && (
        <ShiftDayModal
          propertyId={propertyId}
          shiftType={shiftDayModal.shiftType}
          templateId={shiftDayModal.templateId}
          date={shiftDayModal.date}
          roster={roster}
          departments={departments}
          groupId={shiftDayModal.groupId}
          groupedRoster={groupedRoster}
          onClose={() => setShiftDayModal(null)}
          onSaved={() => refreshCurrentView()}
        />
      )}

      {employeeDayModal && roster && (
        <EmployeeDayQuickEdit
          employeeId={employeeDayModal.employeeId}
          date={employeeDayModal.date}
          roster={roster}
          onClose={() => setEmployeeDayModal(null)}
          onSaved={(shiftTemplateId, workStatus) => handleEmployeeDaySave(employeeDayModal.employeeId, employeeDayModal.date, shiftTemplateId, workStatus)}
        />
      )}

      {nonOpDayModal && (
        <NonOpDayModal
          propertyId={propertyId}
          departmentId={nonOpDayModal.departmentId}
          departmentName={nonOpDayModal.departmentName}
          date={nonOpDayModal.date}
          employees={nonOpDayModal.employees}
          currentStatuses={nonOpDayModal.currentStatuses}
          onClose={() => setNonOpDayModal(null)}
          onSaved={() => refreshCurrentView()}
        />
      )}

      {copyConfirm && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full border border-slate-200 shadow-xl p-5 space-y-3">
            <h3 className="font-bold text-sm text-slate-900">Salin Minggu Sebelumnya?</h3>
            <p className="text-xs text-slate-600">Salin jadwal dari minggu <strong>{formatDisplayDate(copyConfirm.sourceMonday)}</strong> ke minggu <strong>{formatDisplayDate(copyConfirm.targetMonday)}</strong>?</p>
            <p className="text-[10px] text-slate-400">Jadwal yang sudah ada di minggu target tidak akan ditimpa (dilewati).</p>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setCopyConfirm(null)} className="px-3 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 cursor-pointer">Batal</button>
              <button onClick={handleCopyWeek} disabled={actionLoading} className="px-3 py-1.5 text-[11px] font-bold rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] disabled:opacity-50 cursor-pointer">{actionLoading ? 'Menyalin...' : 'Salin'}</button>
            </div>
          </div>
        </div>
      )}

      {publishConfirm && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full border border-slate-200 shadow-xl p-5 space-y-3">
            <h3 className="font-bold text-sm text-slate-900">Publish Jadwal Kerja?</h3>
            <p className="text-xs text-slate-600">Publish jadwal minggu <strong>{formatDisplayDate(publishConfirm.monday)}</strong> — <strong>{formatDisplayDate(publishConfirm.sunday)}</strong>?</p>
            <p className="text-[10px] text-slate-400">Setelah dipublish, perubahan akan tercatat di audit trail.</p>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setPublishConfirm(null)} className="px-3 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 cursor-pointer">Batal</button>
              <button onClick={handlePublish} disabled={actionLoading} className="px-3 py-1.5 text-[11px] font-bold rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] disabled:opacity-50 cursor-pointer">{actionLoading ? 'Publishing...' : 'Publish'}</button>
            </div>
          </div>
        </div>
      )}

      {showKelolaShift && <KelolaShiftDrawer propertyId={propertyId} onClose={() => setShowKelolaShift(false)} onTemplatesUpdated={() => refreshCurrentView()} />}
      {showKelolaGroup && <KelolaGroupDrawer propertyId={propertyId} onClose={() => setShowKelolaGroup(false)} onGroupsUpdated={() => refreshCurrentView()} />}
      {showHolidayCalendar && <HolidayCalendarDrawer propertyId={propertyId} onClose={() => setShowHolidayCalendar(false)} onHolidaysUpdated={() => refreshCurrentView()} />}
      {showNonOpBulk && <NonOpBulkPatternDrawer propertyId={propertyId} departments={departments} onClose={() => setShowNonOpBulk(false)} onPatternApplied={() => refreshCurrentView()} />}
    </div>
  );
};

// Employee Day Quick Edit Modal
interface EmployeeDayQuickEditProps {
  employeeId: number;
  date: string;
  roster: WeeklyRosterResponse;
  onClose: () => void;
  onSaved: (shiftTemplateId: number | null, workStatus: string) => void;
}

const EmployeeDayQuickEdit: React.FC<EmployeeDayQuickEditProps> = ({ employeeId, date, roster, onClose, onSaved }) => {
  const emp = roster.employees.find(e => e.employee_id === employeeId);
  const sched = emp?.schedules[date] || null;
  const [selectedShiftId, setSelectedShiftId] = useState<number | ''>(sched?.shift_template_id || '');
  const [selectedStatus, setSelectedStatus] = useState<string>(sched?.work_status || 'WORK');
  const DAY_FULL = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const d = new Date(date + 'T00:00:00');
  const dateLabel = `${DAY_FULL[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <div>
            <div className="text-xs font-bold text-slate-900">{emp?.employee_name || 'Karyawan'}</div>
            <div className="text-[10px] text-slate-400">{dateLabel}</div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 cursor-pointer">
            <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="block text-[10px] font-bold text-slate-600 mb-1">Status Hari</label>
            <select value={selectedStatus} onChange={e => setSelectedStatus(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332] cursor-pointer">
              <option value="WORK">Kerja (WORK)</option>
              <option value="OFF">OFF</option>
              <option value="LEAVE">Cuti (LEAVE)</option>
              <option value="SICK">Sakit (SICK)</option>
              <option value="PERMISSION">Ijin (PERMISSION)</option>
              <option value="HOLIDAY">Libur (HOLIDAY)</option>
            </select>
          </div>
          {selectedStatus === 'WORK' && (
            <div>
              <label className="block text-[10px] font-bold text-slate-600 mb-1">Shift</label>
              <select value={selectedShiftId} onChange={e => setSelectedShiftId(e.target.value ? Number(e.target.value) : '')}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332] cursor-pointer">
                <option value="">Pilih Shift...</option>
                {roster.shift_templates.filter(t => t.is_active).map(t => (
                  <option key={t.id} value={t.id}>{t.name} ({t.start_time.substring(0, 5)}-{t.end_time.substring(0, 5)})</option>
                ))}
              </select>
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button onClick={onClose} className="flex-1 px-3 py-2 text-[11px] font-bold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 cursor-pointer">Batal</button>
            <button onClick={() => onSaved(selectedStatus === 'WORK' ? (selectedShiftId as number) : null, selectedStatus)}
              className="flex-1 px-3 py-2 text-[11px] font-bold rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] cursor-pointer">Simpan</button>
          </div>
        </div>
      </div>
    </div>
  );
};
