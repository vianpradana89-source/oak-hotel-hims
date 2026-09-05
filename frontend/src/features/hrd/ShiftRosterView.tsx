import React, { useMemo } from 'react';
import type { WeeklyRosterResponse, WorkShiftTemplate, ColorKey } from './scheduleTypes';
import { COLOR_KEY_STYLES } from './scheduleTypes';

const DAY_NAMES = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

function getDayOfWeek(dateStr: string): number {
  return new Date(dateStr + 'T00:00:00').getDay();
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

interface ShiftDayCell {
  employees: { employee_id: number; employee_name: string; department_name: string | null; position_name: string | null }[];
  scheduleStatus?: string;
}

interface ShiftRosterViewProps {
  roster: WeeklyRosterResponse | null;
  loading: boolean;
  onCellClick: (shiftType: string, templateId: number | null, date: string) => void;
}

export const ShiftRosterView: React.FC<ShiftRosterViewProps> = ({ roster, loading, onCellClick }) => {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const shiftRows = useMemo((): ShiftRow[] => {
    if (!roster) return [];
    const rows: ShiftRow[] = [];

    const activeTemplates = roster.shift_templates.filter(t => t.is_active);
    for (const tmpl of activeTemplates) {
      const sc = COLOR_KEY_STYLES[(tmpl.color_key as ColorKey) || 'soft_slate'];
      const timeLabel = tmpl.crosses_midnight
        ? `${tmpl.start_time.substring(0, 5)}–${tmpl.end_time.substring(0, 5)} Lewat Hari`
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

    rows.push({
      type: 'off', label: 'OFF / Libur', timeLabel: '',
      colorKey: 'soft_slate', bgClass: 'bg-slate-50', textClass: 'text-slate-500', borderClass: 'border-slate-200',
    });
    rows.push({
      type: 'leave', label: 'Cuti', timeLabel: '',
      colorKey: 'soft_purple', bgClass: 'bg-purple-50', textClass: 'text-purple-600', borderClass: 'border-purple-200',
    });
    rows.push({
      type: 'sick', label: 'Sakit', timeLabel: '',
      colorKey: 'soft_rose', bgClass: 'bg-rose-50', textClass: 'text-rose-600', borderClass: 'border-rose-200',
    });
    rows.push({
      type: 'permission', label: 'Ijin', timeLabel: '',
      colorKey: 'soft_amber', bgClass: 'bg-amber-50', textClass: 'text-amber-600', borderClass: 'border-amber-200',
    });
    rows.push({
      type: 'holiday', label: 'Libur', timeLabel: '',
      colorKey: 'soft_cyan', bgClass: 'bg-cyan-50', textClass: 'text-cyan-600', borderClass: 'border-cyan-200',
    });

    return rows;
  }, [roster]);

  const matrix = useMemo(() => {
    if (!roster) return new Map<string, ShiftDayCell>();
    const map = new Map<string, ShiftDayCell>();

    for (const emp of roster.employees) {
      for (const date of roster.dates) {
        const sched = emp.schedules[date];
        if (!sched) continue;

        let rowKey = '';
        if (sched.work_status === 'OFF') rowKey = 'off';
        else if (sched.work_status === 'LEAVE') rowKey = 'leave';
        else if (sched.work_status === 'SICK') rowKey = 'sick';
        else if (sched.work_status === 'PERMISSION') rowKey = 'permission';
        else if (sched.work_status === 'HOLIDAY') rowKey = 'holiday';
        else if (sched.shift_template_id) rowKey = `shift_${sched.shift_template_id}`;
        else continue;

        const key = `${rowKey}_${date}`;
        if (!map.has(key)) {
          map.set(key, { employees: [], scheduleStatus: sched.schedule_status });
        }
        map.get(key)!.employees.push({
          employee_id: emp.employee_id,
          employee_name: emp.employee_name,
          department_name: emp.department_name,
          position_name: emp.position_name,
        });
      }
    }
    return map;
  }, [roster]);

  const getCellKey = (row: ShiftRow, date: string): string => {
    if (row.type === 'shift' && row.template) return `shift_${row.template.id}_${date}`;
    return `${row.type}_${date}`;
  };

  const getRowKeyForClick = (row: ShiftRow): string => {
    if (row.type === 'shift' && row.template) return `shift_${row.template.id}`;
    return row.type;
  };

  if (loading) {
    return (
      <div className="p-12 text-center text-xs text-slate-500">
        <div className="w-8 h-8 rounded-full border-2 border-[#1b4332] border-t-transparent animate-spin mx-auto mb-2" />
        Memuat jadwal kerja...
      </div>
    );
  }

  if (!roster || shiftRows.length === 0) {
    return (
      <div className="p-12 text-center text-slate-400 text-xs">
        Tidak ada data jadwal kerja untuk periode ini.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[11px] border-collapse min-w-[900px]">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-200/80">
            <th className="py-2.5 px-3 font-bold text-slate-600 uppercase tracking-wider sticky left-0 bg-slate-50 z-10 min-w-[180px]">
              Keterangan Shift
            </th>
            {roster.dates.map((date) => {
              const dow = getDayOfWeek(date);
              const isToday = date === todayStr;
              return (
                <th key={date} className={`py-2.5 px-2 font-bold text-center uppercase tracking-wider min-w-[110px] ${isToday ? 'bg-[#1b4332]/5' : ''}`}>
                  <div className="text-[10px] text-slate-500">{DAY_NAMES[dow]}</div>
                  <div className={`text-[11px] ${isToday ? 'text-[#1b4332] font-extrabold' : 'text-slate-800'}`}>{date.split('-')[2]}</div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {shiftRows.map((row) => {
            const rowKey = getRowKeyForClick(row);
            return (
              <tr key={rowKey} className={`group transition ${row.type === 'shift' ? 'hover:bg-white/80' : 'hover:bg-slate-50/60'}`}>
                <td className={`py-2 px-3 sticky left-0 z-10 ${row.type === 'shift' ? 'bg-white group-hover:bg-white/80' : 'bg-slate-50/30 group-hover:bg-slate-50/60'}`}>
                  <div className="flex items-center gap-2">
                    {row.type === 'shift' && (
                      <span className={`w-2.5 h-2.5 rounded-full ${row.bgClass.replace('bg-', 'bg-')} shrink-0`} />
                    )}
                    <div>
                      <div className={`font-bold text-[11px] leading-tight ${row.textClass}`}>{row.label}</div>
                      {row.timeLabel && (
                        <div className="text-[9px] text-slate-400 font-mono leading-tight">{row.timeLabel}</div>
                      )}
                    </div>
                  </div>
                </td>
                {roster.dates.map(date => {
                  const cellKey = getCellKey(row, date);
                  const cell = matrix.get(cellKey);
                  const employees = cell?.employees || [];
                  const displayCount = 3;
                  const hasMore = employees.length > displayCount;
                  const isTodayCol = date === todayStr;

                  return (
                    <td key={date}
                      onClick={() => onCellClick(row.type, row.template?.id || null, date)}
                      className={`py-1.5 px-1.5 text-center cursor-pointer transition min-w-[110px] ${isTodayCol ? 'bg-[#1b4332]/[0.02]' : 'hover:bg-slate-50'}`}>
                      {employees.length === 0 ? (
                        <span className="text-slate-300 text-[10px]">—</span>
                      ) : (
                        <div className="flex flex-col items-start gap-0.5">
                          {employees.slice(0, displayCount).map(emp => (
                            <span key={emp.employee_id}
                              className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold leading-tight ${row.bgClass} ${row.textClass} border ${row.borderClass} w-full text-left truncate`}
                              title={`${emp.employee_name}${emp.position_name ? ` · ${emp.position_name}` : ''}`}>
                              {emp.employee_name}
                            </span>
                          ))}
                          {hasMore && (
                            <span className="text-[8px] text-slate-400 font-bold px-1">+{employees.length - displayCount} lainnya</span>
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
