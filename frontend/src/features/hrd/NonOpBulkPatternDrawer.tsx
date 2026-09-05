import React, { useState, useEffect } from 'react';
import type { Department, NonOpBulkPatternPreview } from './scheduleTypes';

interface NonOpBulkPatternDrawerProps {
  propertyId: number;
  departments: Department[];
  onClose: () => void;
  onPatternApplied: () => void;
}

const DAY_NAMES = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

interface Employee {
  id: number;
  full_name: string;
  employee_code: string | null;
  department_name: string | null;
  position_name: string | null;
}

export const NonOpBulkPatternDrawer: React.FC<NonOpBulkPatternDrawerProps> = ({
  propertyId, departments, onClose, onPatternApplied
}) => {
  const [selectedDeptId, setSelectedDeptId] = useState<number | ''>('');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selectedEmpIds, setSelectedEmpIds] = useState<Set<number>>(new Set());
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [workingDays, setWorkingDays] = useState<number[]>([1, 2, 3, 4, 5, 6]); // Mon-Sat default
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('17:00');
  const [notes, setNotes] = useState('');
  const [loadingEmployees, setLoadingEmployees] = useState(false);
  const [preview, setPreview] = useState<NonOpBulkPatternPreview | null>(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');

  const getAuthHeaders = (): HeadersInit => {
    const token = localStorage.getItem('oak_hims_auth_token');
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  };

  const fetchEmployees = async () => {
    if (!selectedDeptId) { setEmployees([]); return; }
    setLoadingEmployees(true);
    try {
      const params = new URLSearchParams({ property_id: String(propertyId), scope: 'active', department_id: String(selectedDeptId) });
      const res = await fetch(`/api/hrd/employees?${params}`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (data.status === 'OK') setEmployees(data.data || []);
    } catch { /* ignore */ } finally { setLoadingEmployees(false); }
  };

  useEffect(() => { fetchEmployees(); }, [selectedDeptId]);

  const toggleWorkingDay = (day: number) => {
    setWorkingDays(prev => {
      const next = prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day];
      return next;
    });
  };

  const handlePreview = async () => {
    if (!selectedDeptId || !startDate || !endDate || selectedEmpIds.size === 0) return;
    setError('');
    try {
      const res = await fetch('/api/schedule/non-op-bulk/preview', {
        method: 'POST', headers: getAuthHeaders(),
        body: JSON.stringify({
          property_id: propertyId,
          employee_ids: [...selectedEmpIds],
          start_date: startDate,
          end_date: endDate,
          working_days: workingDays,
          start_time: startTime,
          end_time: endTime,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message);
      setPreview(data.data);
    } catch (err: any) { setError(err.message); }
  };

  const handleApply = async () => {
    if (!selectedDeptId || !startDate || !endDate || selectedEmpIds.size === 0) return;
    setApplying(true);
    setError('');
    try {
      const res = await fetch('/api/schedule/non-op-bulk/apply', {
        method: 'POST', headers: getAuthHeaders(),
        body: JSON.stringify({
          property_id: propertyId,
          department_id: selectedDeptId,
          employee_ids: [...selectedEmpIds],
          start_date: startDate,
          end_date: endDate,
          working_days: workingDays,
          default_start_time: startTime,
          default_end_time: endTime,
          notes: notes || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message);
      setResult(data.data);
      onPatternApplied();
    } catch (err: any) { setError(err.message); } finally { setApplying(false); }
  };

  const toggleEmployee = (empId: number) => {
    setSelectedEmpIds(prev => {
      const next = new Set(prev);
      if (next.has(empId)) next.delete(empId); else next.add(empId);
      return next;
    });
  };

  const toggleAllEmployees = () => {
    setSelectedEmpIds(prev => {
      const allSelected = employees.every(e => prev.has(e.id));
      if (allSelected) return new Set<number>();
      return new Set(employees.map(e => e.id));
    });
  };

  const nonOpDepts = departments.filter(d => d.is_active);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div className="w-full max-w-2xl bg-white h-full shadow-2xl overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between z-10">
          <h2 className="text-sm font-bold text-slate-900">Atur Pola Non-Operasional</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 cursor-pointer">
            <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {result ? (
          <div className="p-6 text-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto">
              <svg className="w-8 h-8 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" /></svg>
            </div>
            <h3 className="text-sm font-bold text-slate-900">Pola Berhasil Diterapkan!</h3>
            <div className="text-xs text-slate-600 space-y-1">
              <p>Dibuat: <strong>{result.created_count}</strong> jadwal</p>
              <p>Dilewati (sudah ada): <strong>{result.skipped_count}</strong></p>
              <p>Dilindungi (published/changed/exception): <strong>{result.skipped_protected}</strong></p>
              <p>Hari libur: <strong>{result.skipped_holiday}</strong></p>
            </div>
            <button onClick={onClose}
              className="px-4 py-2 text-[11px] font-bold rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] cursor-pointer">
              Tutup
            </button>
          </div>
        ) : (
          <div className="p-4 space-y-4">
            {error && <div className="p-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-[11px]">{error}</div>}

            {/* Department Selection */}
            <div>
              <label className="block text-[10px] font-bold text-slate-600 mb-1">Departemen</label>
              <select value={selectedDeptId} onChange={e => { setSelectedDeptId(e.target.value ? Number(e.target.value) : ''); setSelectedEmpIds(new Set()); setPreview(null); }}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332] cursor-pointer">
                <option value="">Pilih Departemen...</option>
                {nonOpDepts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>

            {/* Date Range */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-bold text-slate-600 mb-1">Tanggal Mulai</label>
                <input type="date" value={startDate} onChange={e => { setStartDate(e.target.value); setPreview(null); }}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]" />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-slate-600 mb-1">Tanggal Selesai</label>
                <input type="date" value={endDate} onChange={e => { setEndDate(e.target.value); setPreview(null); }}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]" />
              </div>
            </div>

            {/* Working Days */}
            <div>
              <label className="block text-[10px] font-bold text-slate-600 mb-1">Hari Kerja</label>
              <div className="flex gap-1">
                {DAY_NAMES.map((day, idx) => (
                  <button key={idx} onClick={() => toggleWorkingDay(idx)}
                    className={`px-2.5 py-1.5 text-[10px] font-bold rounded-lg border transition cursor-pointer ${
                      workingDays.includes(idx)
                        ? 'bg-[#1b4332] text-white border-[#1b4332]'
                        : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                    }`}>
                    {day}
                  </button>
                ))}
              </div>
            </div>

            {/* Working Hours */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-bold text-slate-600 mb-1">Jam Mulai Kerja</label>
                <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]" />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-slate-600 mb-1">Jam Selesai Kerja</label>
                <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]" />
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-[10px] font-bold text-slate-600 mb-1">Catatan (opsional)</label>
              <input value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="Contoh: Pola kerja kantor September-Desember"
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]" />
            </div>

            {/* Employee Selection */}
            {selectedDeptId && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[10px] font-bold text-slate-600">Pilih Karyawan {selectedEmpIds.size > 0 && `(${selectedEmpIds.size})`}</label>
                  <button onClick={toggleAllEmployees}
                    className="text-[10px] font-bold text-[#1b4332] hover:underline cursor-pointer">
                    {employees.every(e => selectedEmpIds.has(e.id)) ? 'Batal Pilih Semua' : 'Pilih Semua'}
                  </button>
                </div>
                {loadingEmployees ? (
                  <div className="text-center py-4 text-slate-400 text-xs">Memuat karyawan...</div>
                ) : (
                  <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-40 overflow-y-auto">
                    {employees.length === 0 ? (
                      <div className="px-3 py-2 text-[11px] text-slate-400 italic">Tidak ada karyawan aktif</div>
                    ) : employees.map(emp => (
                      <label key={emp.id} className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-slate-50 transition ${selectedEmpIds.has(emp.id) ? 'bg-emerald-50' : ''}`}>
                        <input type="checkbox" checked={selectedEmpIds.has(emp.id)} onChange={() => toggleEmployee(emp.id)}
                          className="rounded border-slate-300 text-[#1b4332] focus:ring-[#1b4332]" />
                        <div className="flex-1 min-w-0">
                          <div className="text-[11px] font-bold text-slate-800 truncate">{emp.full_name}</div>
                          <div className="text-[9px] text-slate-500">{emp.position_name || '—'}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Preview */}
            {preview && (
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 space-y-2">
                <h4 className="text-xs font-bold text-blue-900">Preview</h4>
                <div className="grid grid-cols-2 gap-2 text-[11px] text-blue-800">
                  <div>Total target: <strong>{preview.total_dates}</strong></div>
                  <div>Jadwal baru: <strong>{preview.new_schedules}</strong></div>
                  <div>Sudah ada: <strong>{preview.existing_schedules}</strong></div>
                  <div>Dilindungi: <strong>{preview.skipped_protected}</strong></div>
                </div>
                {preview.conflicts.length > 0 && (
                  <div className="text-[10px] text-amber-700">
                    {preview.conflicts.slice(0, 5).map((c, i) => (
                      <div key={i}>{c.employee_name}: {c.work_date} ({c.current_status} / {c.current_schedule_status})</div>
                    ))}
                    {preview.conflicts.length > 5 && <div>...dan {preview.conflicts.length - 5} lainnya</div>}
                  </div>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2 pt-2 border-t border-slate-200">
              <button onClick={onClose}
                className="flex-1 px-3 py-2 text-[11px] font-bold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 cursor-pointer">Batal</button>
              {!preview ? (
                <button onClick={handlePreview}
                  disabled={!selectedDeptId || !startDate || !endDate || selectedEmpIds.size === 0}
                  className="flex-1 px-3 py-2 text-[11px] font-bold rounded-lg border border-[#1b4332] text-[#1b4332] hover:bg-[#1b4332]/5 disabled:opacity-50 cursor-pointer">
                  Preview
                </button>
              ) : (
                <button onClick={handleApply} disabled={applying}
                  className="flex-1 px-3 py-2 text-[11px] font-bold rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] disabled:opacity-50 cursor-pointer">
                  {applying ? 'Menerapkan...' : 'Terapkan Aman'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
