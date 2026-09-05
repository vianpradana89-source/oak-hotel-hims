import React, { useMemo } from 'react';
import type { OperationalRosterResponse, WorkShiftTemplate, OperationalGroupRoster, NonOperationalGroupRoster } from './scheduleTypes';
import { COLOR_KEY_STYLES } from './scheduleTypes';

const DAY_NAMES = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

interface NonOpCellClickInfo {
  departmentId: number;
  departmentName: string;
  date: string;
  employees: { employee_id: number; employee_name: string; employee_code: string | null; position_name: string | null }[];
  currentStatuses: Record<number, string>;
}

interface GroupedRosterViewProps {
  groupedRoster: OperationalRosterResponse | null;
  loading: boolean;
  onShiftCellClick: (shiftType: string, templateId: number | null, date: string, groupId?: number) => void;
  onNonOpCellClick: (info: NonOpCellClickInfo) => void;
  todayStr: string;
}

interface ShiftRow {
  type: 'shift' | 'off' | 'leave' | 'sick' | 'permission' | 'holiday';
  template?: WorkShiftTemplate;
  label: string;
  timeLabel: string;
  colorKey: string;
  bgClass: string;
  textClass: string;
  borderClass: string;
}

// ─── Operational Group Table ───

const OperationalGroupTable: React.FC<{
  group: OperationalGroupRoster;
  shiftTemplates: WorkShiftTemplate[];
  dates: string[];
  todayStr: string;
  onCellClick: (shiftType: string, templateId: number | null, date: string) => void;
}> = ({ group, shiftTemplates, dates, todayStr, onCellClick }) => {
  const shiftRows = useMemo((): ShiftRow[] => {
    const rows: ShiftRow[] = [];
    // Get relevant templates for this group (from employees' departments)
    const relevantTemplateIds = new Set<number>();
    for (const emp of group.employees) {
      for (const date of dates) {
        const sched = emp.schedules[date];
        if (sched?.shift_template_id) relevantTemplateIds.add(sched.shift_template_id);
      }
    }
    // Show templates that are used by employees in this group, plus all active templates
    const activeTemplates = shiftTemplates.filter(t => t.is_active);
    for (const tmpl of activeTemplates) {
      const sc = COLOR_KEY_STYLES[(tmpl.color_key as keyof typeof COLOR_KEY_STYLES) || 'soft_slate'];
      const timeLabel = tmpl.crosses_midnight
        ? `${tmpl.start_time.substring(0, 5)}–${tmpl.end_time.substring(0, 5)} LH`
        : `${tmpl.start_time.substring(0, 5)}–${tmpl.end_time.substring(0, 5)}`;
      rows.push({
        type: 'shift',
        template: tmpl,
        label: tmpl.name,
        timeLabel,
        colorKey: tmpl.color_key || 'soft_slate',
        bgClass: sc.bg,
        textClass: sc.text,
        borderClass: sc.border,
      });
    }
    rows.push({ type: 'off', label: 'OFF', timeLabel: '', colorKey: 'soft_slate', bgClass: 'bg-slate-50', textClass: 'text-slate-500', borderClass: 'border-slate-200' });
    rows.push({ type: 'leave', label: 'Cuti', timeLabel: '', colorKey: 'soft_purple', bgClass: 'bg-purple-50', textClass: 'text-purple-600', borderClass: 'border-purple-200' });
    rows.push({ type: 'sick', label: 'Sakit', timeLabel: '', colorKey: 'soft_rose', bgClass: 'bg-rose-50', textClass: 'text-rose-600', borderClass: 'border-rose-200' });
    rows.push({ type: 'permission', label: 'Ijin', timeLabel: '', colorKey: 'soft_amber', bgClass: 'bg-amber-50', textClass: 'text-amber-600', borderClass: 'border-amber-200' });
    rows.push({ type: 'holiday', label: 'Libur', timeLabel: '', colorKey: 'soft_cyan', bgClass: 'bg-cyan-50', textClass: 'text-cyan-600', borderClass: 'border-cyan-200' });
    return rows;
  }, [group, shiftTemplates, dates]);

  const matrix = useMemo(() => {
    const map = new Map<string, { employees: { employee_id: number; employee_name: string }[] }>();
    for (const emp of group.employees) {
      for (const date of dates) {
        const sched = emp.schedules[date];
        if (!sched || sched.schedule_status === 'CANCELLED') continue;
        let rowKey = '';
        if (sched.work_status === 'OFF') rowKey = 'off';
        else if (sched.work_status === 'LEAVE') rowKey = 'leave';
        else if (sched.work_status === 'SICK') rowKey = 'sick';
        else if (sched.work_status === 'PERMISSION') rowKey = 'permission';
        else if (sched.work_status === 'HOLIDAY') rowKey = 'holiday';
        else if (sched.shift_template_id) rowKey = `shift_${sched.shift_template_id}`;
        else continue;
        const key = `${rowKey}_${date}`;
        if (!map.has(key)) map.set(key, { employees: [] });
        map.get(key)!.employees.push({ employee_id: emp.employee_id, employee_name: emp.employee_name });
      }
    }
    return map;
  }, [group, dates]);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[10px] border-collapse min-w-[800px]">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-200/80">
            <th className="py-2 px-2 font-bold text-slate-600 uppercase tracking-wider sticky left-0 bg-slate-50 z-10 min-w-[140px]">Keterangan Jadwal</th>
            {dates.map(date => {
              const d = new Date(date + 'T00:00:00');
              const dow = d.getDay();
              const isWeekend = dow === 0 || dow === 6;
              const isToday = date === todayStr;
              return (
                <th key={date} className={`py-1 px-0.5 text-center font-bold min-w-[90px] ${isWeekend ? 'bg-slate-100/80' : ''} ${isToday ? 'bg-[#1b4332]/5' : ''}`}>
                  <div className="text-[8px] text-slate-400">{DAY_NAMES[dow]}</div>
                  <div className={`text-[9px] ${isToday ? 'text-[#1b4332] font-extrabold' : 'text-slate-700'}`}>{d.getDate()}</div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {shiftRows.map(row => {
            const rowKey = row.type === 'shift' && row.template ? `shift_${row.template.id}` : row.type;
            return (
              <tr key={rowKey} className="hover:bg-slate-50/60 transition group">
                <td className={`py-1.5 px-2 sticky left-0 z-10 ${row.type === 'shift' ? 'bg-white group-hover:bg-white/80' : 'bg-slate-50/30 group-hover:bg-slate-50/60'}`}>
                  <div className="flex items-center gap-1.5">
                    {row.type === 'shift' && <span className={`w-2 h-2 rounded-full ${row.bgClass.replace('bg-', 'bg-')} shrink-0`} />}
                    <div>
                      <div className={`font-bold text-[10px] leading-tight ${row.textClass}`}>{row.label}</div>
                      {row.timeLabel && <div className="text-[7px] text-slate-400 font-mono leading-tight">{row.timeLabel}</div>}
                    </div>
                  </div>
                </td>
                {dates.map(date => {
                  const cellKey = `${rowKey}_${date}`;
                  const cell = matrix.get(cellKey);
                  const employees = cell?.employees || [];
                  const isTodayCol = date === todayStr;
                  return (
                    <td key={date}
                      onClick={() => onCellClick(row.type, row.template?.id || null, date)}
                      className={`py-1 px-1 text-center cursor-pointer transition min-w-[90px] ${isTodayCol ? 'bg-[#1b4332]/[0.02]' : 'hover:bg-slate-50'}`}>
                      {employees.length === 0 ? (
                        <span className="text-slate-300 text-[9px]">—</span>
                      ) : (
                        <div className="flex flex-col items-start gap-px">
                          {employees.slice(0, 3).map(emp => (
                            <span key={emp.employee_id}
                              className={`inline-block px-1 py-px rounded text-[8px] font-semibold leading-tight ${row.bgClass} ${row.textClass} border ${row.borderClass} w-full text-left truncate`}
                              title={emp.employee_name}>
                              {emp.employee_name}
                            </span>
                          ))}
                          {employees.length > 3 && (
                            <span className="text-[7px] text-slate-400 font-bold px-0.5">+{employees.length - 3}</span>
                          )}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

// ─── Non-Operational Department Table ───

const NonOpDeptTable: React.FC<{
  dept: NonOperationalGroupRoster;
  dates: string[];
  todayStr: string;
  onNonOpCellClick: (info: NonOpCellClickInfo) => void;
}> = ({ dept, dates, todayStr, onNonOpCellClick }) => {
  const statusRows = [
    { type: 'work' as const, label: 'Kerja', bgClass: 'bg-emerald-50', textClass: 'text-emerald-700', borderClass: 'border-emerald-200' },
    { type: 'off' as const, label: 'OFF', bgClass: 'bg-slate-50', textClass: 'text-slate-500', borderClass: 'border-slate-200' },
    { type: 'leave' as const, label: 'Cuti', bgClass: 'bg-purple-50', textClass: 'text-purple-600', borderClass: 'border-purple-200' },
    { type: 'sick' as const, label: 'Sakit', bgClass: 'bg-rose-50', textClass: 'text-rose-600', borderClass: 'border-rose-200' },
    { type: 'permission' as const, label: 'Ijin', bgClass: 'bg-amber-50', textClass: 'text-amber-600', borderClass: 'border-amber-200' },
    { type: 'holiday' as const, label: 'Libur', bgClass: 'bg-cyan-50', textClass: 'text-cyan-600', borderClass: 'border-cyan-200' },
  ];

  const matrix = useMemo(() => {
    const map = new Map<string, { employees: { employee_id: number; employee_name: string }[] }>();
    for (const emp of dept.employees) {
      for (const date of dates) {
        const sched = emp.schedules[date];
        if (!sched || sched.schedule_status === 'CANCELLED') continue;
        let rowKey = '';
        if (sched.work_status === 'WORK') rowKey = 'work';
        else if (sched.work_status === 'OFF') rowKey = 'off';
        else if (sched.work_status === 'LEAVE') rowKey = 'leave';
        else if (sched.work_status === 'SICK') rowKey = 'sick';
        else if (sched.work_status === 'PERMISSION') rowKey = 'permission';
        else if (sched.work_status === 'HOLIDAY') rowKey = 'holiday';
        else continue;
        const key = `${rowKey}_${date}`;
        if (!map.has(key)) map.set(key, { employees: [] });
        map.get(key)!.employees.push({ employee_id: emp.employee_id, employee_name: emp.employee_name });
      }
    }
    return map;
  }, [dept, dates]);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[10px] border-collapse min-w-[800px]">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-200/80">
            <th className="py-2 px-2 font-bold text-slate-600 uppercase tracking-wider sticky left-0 bg-slate-50 z-10 min-w-[140px]">Keterangan Jadwal</th>
            {dates.map(date => {
              const d = new Date(date + 'T00:00:00');
              const dow = d.getDay();
              const isWeekend = dow === 0 || dow === 6;
              const isToday = date === todayStr;
              return (
                <th key={date} className={`py-1 px-0.5 text-center font-bold min-w-[90px] ${isWeekend ? 'bg-slate-100/80' : ''} ${isToday ? 'bg-[#1b4332]/5' : ''}`}>
                  <div className="text-[8px] text-slate-400">{DAY_NAMES[dow]}</div>
                  <div className={`text-[9px] ${isToday ? 'text-[#1b4332] font-extrabold' : 'text-slate-700'}`}>{d.getDate()}</div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {statusRows.map(row => {
            return (
              <tr key={row.type} className="hover:bg-slate-50/60 transition group">
                <td className="py-1.5 px-2 sticky left-0 bg-slate-50/30 group-hover:bg-slate-50/60 z-10">
                  <div className={`font-bold text-[10px] leading-tight ${row.textClass}`}>{row.label}</div>
                </td>
                {dates.map(date => {
                  const cellKey = `${row.type}_${date}`;
                  const cell = matrix.get(cellKey);
                  const employees = cell?.employees || [];
                  const isTodayCol = date === todayStr;

                  // Build current statuses for this date across all employees
                  const currentStatuses: Record<number, string> = {};
                  for (const emp of dept.employees) {
                    const sched = emp.schedules[date];
                    if (sched) {
                      currentStatuses[emp.employee_id] = sched.work_status;
                    }
                  }

                  const allEmps = dept.employees.map(e => ({
                    employee_id: e.employee_id,
                    employee_name: e.employee_name,
                    employee_code: e.employee_code,
                    position_name: e.position_name,
                  }));

                  return (
                    <td key={date}
                      onClick={() => onNonOpCellClick({
                        departmentId: dept.department_id,
                        departmentName: dept.department_name,
                        date,
                        employees: allEmps,
                        currentStatuses,
                      })}
                      className={`py-1 px-1 text-center cursor-pointer transition min-w-[90px] ${isTodayCol ? 'bg-[#1b4332]/[0.02]' : 'hover:bg-slate-50'}`}>
                      {employees.length === 0 ? (
                        <span className="text-slate-300 text-[9px]">—</span>
                      ) : (
                        <div className="flex flex-col items-start gap-px">
                          {employees.slice(0, 3).map(emp => (
                            <span key={emp.employee_id}
                              className={`inline-block px-1 py-px rounded text-[8px] font-semibold leading-tight ${row.bgClass} ${row.textClass} border ${row.borderClass} w-full text-left truncate`}
                              title={emp.employee_name}>
                              {emp.employee_name}
                            </span>
                          ))}
                          {employees.length > 3 && (
                            <span className="text-[7px] text-slate-400 font-bold px-0.5">+{employees.length - 3}</span>
                          )}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

// ─── Main GroupedRosterView ───

export const GroupedRosterView: React.FC<GroupedRosterViewProps> = ({
  groupedRoster, loading, onShiftCellClick, onNonOpCellClick, todayStr
}) => {
  if (loading) {
    return (
      <div className="p-12 text-center text-xs text-slate-500">
        <div className="w-8 h-8 rounded-full border-2 border-[#1b4332] border-t-transparent animate-spin mx-auto mb-2" />
        Memuat jadwal kerja...
      </div>
    );
  }

  if (!groupedRoster) {
    return (
      <div className="p-12 text-center text-slate-400 text-xs">Tidak ada data jadwal kerja.</div>
    );
  }

  const { groups, non_operational_groups, dates, shift_templates } = groupedRoster;
  const hasAnyData = groups.length > 0 || non_operational_groups.length > 0;

  if (!hasAnyData) {
    return (
      <div className="p-12 text-center text-slate-400 text-xs">
        Belum ada group operasional atau departemen non-operasional yang dikonfigurasi.
        <br />Gunakan tombol "Kelola Group Operasional" untuk membuat group.
      </div>
    );
  }

  return (
    <div className="space-y-4 p-3">
      {/* OPERASIONAL Section */}
      {groups.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[10px] font-bold uppercase tracking-widest text-[#1b4332]">Operasional</span>
            <div className="flex-1 h-px bg-[#1b4332]/20" />
          </div>
          <div className="space-y-3">
            {groups.map(group => (
              <div key={group.group_id} className="border border-slate-200 rounded-xl overflow-hidden">
                <div className="bg-[#1b4332]/5 px-3 py-1.5 border-b border-slate-200/80">
                  <span className="text-[11px] font-bold text-[#1b4332]">{group.group_name}</span>
                  <span className="text-[9px] text-slate-500 ml-2">({group.employees.length} karyawan)</span>
                </div>
                <OperationalGroupTable
                  group={group}
                  shiftTemplates={shift_templates}
                  dates={dates}
                  todayStr={todayStr}
                  onCellClick={(shiftType, templateId, date) => onShiftCellClick(shiftType, templateId, date, group.group_id)}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* NON-OPERASIONAL Section */}
      {non_operational_groups.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Non-Operasional</span>
            <div className="flex-1 h-px bg-slate-300" />
          </div>
          <div className="space-y-3">
            {non_operational_groups.map(dept => (
              <div key={dept.department_id} className="border border-slate-200 rounded-xl overflow-hidden">
                <div className="bg-slate-100/80 px-3 py-1.5 border-b border-slate-200/80">
                  <span className="text-[11px] font-bold text-slate-700">{dept.department_name}</span>
                  <span className="text-[9px] text-slate-500 ml-2">({dept.employees.length} karyawan)</span>
                </div>
                <NonOpDeptTable
                  dept={dept}
                  dates={dates}
                  todayStr={todayStr}
                  onNonOpCellClick={onNonOpCellClick}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center gap-2 text-[9px] text-slate-500 flex-wrap pt-2 border-t border-slate-100">
        <span className="font-bold uppercase tracking-wider">Legenda:</span>
        {shift_templates.filter(t => t.is_active).map(t => {
          const sc = COLOR_KEY_STYLES[t.color_key as keyof typeof COLOR_KEY_STYLES] || COLOR_KEY_STYLES.soft_slate;
          return (
            <span key={t.id} className={`px-1 py-0.5 rounded border text-[9px] font-bold ${sc.bg} ${sc.text} ${sc.border}`}>{t.name}</span>
          );
        })}
        <span className="px-1 py-0.5 rounded border text-[9px] font-bold bg-slate-50 text-slate-500 border-slate-200">OFF</span>
        <span className="px-1 py-0.5 rounded border text-[9px] font-bold bg-cyan-50 text-cyan-600 border-cyan-200">Libur</span>
        <span className="px-1 py-0.5 rounded border text-[9px] font-bold bg-purple-50 text-purple-600 border-purple-200">Cuti</span>
        <span className="px-1 py-0.5 rounded border text-[9px] font-bold bg-rose-50 text-rose-600 border-rose-200">Sakit</span>
        <span className="px-1 py-0.5 rounded border text-[9px] font-bold bg-amber-50 text-amber-600 border-amber-200">Ijin</span>
      </div>
    </div>
  );
};
