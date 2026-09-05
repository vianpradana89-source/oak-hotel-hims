import React from 'react';
import type { WeeklyRosterResponse, WorkShiftTemplate, ColorKey } from './scheduleTypes';
import { COLOR_KEY_STYLES } from './scheduleTypes';

const DAY_NAMES = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

function getDayOfWeek(dateStr: string): number {
  return new Date(dateStr + 'T00:00:00').getDay();
}

interface EmployeeRosterViewProps {
  roster: WeeklyRosterResponse | null;
  loading: boolean;
  onCellClick: (employeeId: number, date: string) => void;
}

export const EmployeeRosterView: React.FC<EmployeeRosterViewProps> = ({ roster, loading, onCellClick }) => {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const getScheduleDisplay = (sched: any, templates: WorkShiftTemplate[]) => {
    if (!sched) return { label: '-', subLabel: '', colorClass: 'text-slate-300', bgClass: '' };
    if (sched.work_status === 'OFF') return { label: 'OFF', subLabel: '', colorClass: 'text-slate-500', bgClass: 'bg-slate-50' };
    if (sched.work_status === 'LEAVE') return { label: 'Cuti', subLabel: '', colorClass: 'text-purple-600', bgClass: 'bg-purple-50' };
    if (sched.work_status === 'SICK') return { label: 'Sakit', subLabel: '', colorClass: 'text-rose-600', bgClass: 'bg-rose-50' };
    if (sched.work_status === 'PERMISSION') return { label: 'Ijin', subLabel: '', colorClass: 'text-amber-600', bgClass: 'bg-amber-50' };
    if (sched.work_status === 'HOLIDAY') return { label: 'Libur', subLabel: '', colorClass: 'text-cyan-600', bgClass: 'bg-cyan-50' };

    const tmpl = templates.find(t => t.id === sched.shift_template_id);
    if (tmpl) {
      const sc = COLOR_KEY_STYLES[(tmpl.color_key as ColorKey) || 'soft_slate'];
      return {
        label: tmpl.name,
        subLabel: `${tmpl.start_time.substring(0, 5)}–${tmpl.end_time.substring(0, 5)}`,
        colorClass: sc.text,
        bgClass: sc.bg,
      };
    }
    return { label: sched.work_status, subLabel: '', colorClass: 'text-amber-700', bgClass: 'bg-amber-50' };
  };

  if (loading) {
    return (
      <div className="p-12 text-center text-xs text-slate-500">
        <div className="w-8 h-8 rounded-full border-2 border-[#1b4332] border-t-transparent animate-spin mx-auto mb-2" />
        Memuat jadwal kerja...
      </div>
    );
  }

  if (!roster || roster.employees.length === 0) {
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
              Nama
            </th>
            {roster.dates.map((date) => {
              const dow = getDayOfWeek(date);
              const isToday = date === todayStr;
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
          {roster.employees.map(emp => (
            <tr key={emp.employee_id} className="hover:bg-slate-50/60 transition group">
              <td className="py-2 px-3 sticky left-0 bg-white group-hover:bg-slate-50/60 z-10">
                <div className="font-bold text-slate-900 text-[11px] leading-tight">{emp.employee_name}</div>
                <div className="text-[10px] text-slate-400 leading-tight">
                  {emp.department_name || ''} {emp.position_name ? `· ${emp.position_name}` : ''}
                </div>
              </td>
              {roster.dates.map(date => {
                const sched = emp.schedules[date];
                const display = getScheduleDisplay(sched, roster.shift_templates);
                const isTodayCol = date === todayStr;
                return (
                  <td key={date}
                    onClick={() => onCellClick(emp.employee_id, date)}
                    className={`py-1.5 px-1.5 text-center cursor-pointer transition ${isTodayCol ? 'bg-[#1b4332]/[0.02]' : 'hover:bg-slate-50'}`}>
                    {display.label === '-' ? (
                      <span className="text-slate-300 text-[10px]">—</span>
                    ) : (
                      <div className={`inline-block px-2 py-1 rounded-lg text-[10px] font-bold min-w-[52px] ${display.bgClass}`}>
                        <div className={`leading-tight ${display.colorClass}`}>{display.label}</div>
                        {display.subLabel && (
                          <div className="text-[8px] font-normal text-slate-400 leading-tight">{display.subLabel}</div>
                        )}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
