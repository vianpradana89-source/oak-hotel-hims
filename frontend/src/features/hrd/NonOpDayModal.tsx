import React, { useState, useMemo } from 'react';

const DAY_FULL_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

interface NonOpEmployee {
  employee_id: number;
  employee_name: string;
  employee_code: string | null;
  position_name: string | null;
}

interface NonOpDayModalProps {
  propertyId: number;
  departmentId: number;
  departmentName: string;
  date: string;
  employees: NonOpEmployee[];
  currentStatuses: Record<number, string>; // employee_id -> work_status for this date
  onClose: () => void;
  onSaved: () => void;
}

const STATUS_OPTIONS = [
  { value: 'WORK', label: 'Kerja', bgClass: 'bg-emerald-50', textClass: 'text-emerald-700', borderClass: 'border-emerald-200' },
  { value: 'OFF', label: 'OFF', bgClass: 'bg-slate-50', textClass: 'text-slate-500', borderClass: 'border-slate-200' },
  { value: 'LEAVE', label: 'Cuti', bgClass: 'bg-purple-50', textClass: 'text-purple-600', borderClass: 'border-purple-200' },
  { value: 'SICK', label: 'Sakit', bgClass: 'bg-rose-50', textClass: 'text-rose-600', borderClass: 'border-rose-200' },
  { value: 'PERMISSION', label: 'Ijin', bgClass: 'bg-amber-50', textClass: 'text-amber-600', borderClass: 'border-amber-200' },
  { value: 'HOLIDAY', label: 'Libur', bgClass: 'bg-cyan-50', textClass: 'text-cyan-600', borderClass: 'border-cyan-200' },
] as const;

function formatDateDisplay(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return `${DAY_FULL_NAMES[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export const NonOpDayModal: React.FC<NonOpDayModalProps> = ({
  propertyId, departmentId: _departmentId, departmentName, date, employees, currentStatuses, onClose, onSaved
}) => {
  const [localStatuses, setLocalStatuses] = useState<Record<number, string>>({ ...currentStatuses });
  const [saving, setSaving] = useState(false);
  const [savingCount, setSavingCount] = useState(0);
  const [savedCount, setSavedCount] = useState(0);
  const [error, setError] = useState('');

  const getAuthHeaders = (): HeadersInit => {
    const token = localStorage.getItem('oak_hims_auth_token');
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  };

  const setEmployeeStatus = (empId: number, status: string) => {
    setLocalStatuses(prev => ({ ...prev, [empId]: status }));
  };

  const handleSaveAll = async () => {
    setSaving(true);
    setError('');
    setSavingCount(0);
    setSavedCount(0);
    try {
      // Find employees whose status changed
      const changes: { employee_id: number; work_status: string }[] = [];
      for (const emp of employees) {
        const newStatus = localStatuses[emp.employee_id];
        const oldStatus = currentStatuses[emp.employee_id] || 'OFF';
        if (newStatus && newStatus !== oldStatus) {
          changes.push({ employee_id: emp.employee_id, work_status: newStatus });
        }
      }

      if (changes.length === 0) {
        onClose();
        return;
      }

      setSavingCount(changes.length);
      let saved = 0;

      for (const change of changes) {
        try {
          const res = await fetch('/api/schedule/non-op-assign', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
              property_id: propertyId,
              employee_id: change.employee_id,
              work_date: date,
              work_status: change.work_status,
            }),
          });
          if (res.ok) {
            saved++;
          } else {
            const data = await res.json();
            console.error(`Failed to save ${change.employee_id}:`, data.message);
          }
        } catch (err) {
          console.error(`Failed to save ${change.employee_id}:`, err);
        }
        setSavedCount(saved);
      }

      if (saved > 0) {
        onSaved();
      }
      if (saved === changes.length) {
        onClose();
      } else if (saved > 0) {
        setError(`${saved} dari ${changes.length} berhasil disimpan. Sisanya gagal.`);
      } else {
        setError('Semua perubahan gagal disimpan.');
      }
    } catch (err: any) {
      setError(err.message || 'Gagal menyimpan');
    } finally {
      setSaving(false);
    }
  };

  const changesCount = useMemo(() => {
    let count = 0;
    for (const emp of employees) {
      const newStatus = localStatuses[emp.employee_id];
      const oldStatus = currentStatuses[emp.employee_id] || 'OFF';
      if (newStatus && newStatus !== oldStatus) count++;
    }
    return count;
  }, [employees, localStatuses, currentStatuses]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-bold text-slate-900">{departmentName}</div>
            <div className="text-[10px] text-slate-500">{formatDateDisplay(date)}</div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 cursor-pointer">
            <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Status Legend */}
        <div className="px-4 py-2 bg-slate-50 border-b border-slate-100 flex items-center gap-2 flex-wrap">
          {STATUS_OPTIONS.map(opt => (
            <span key={opt.value} className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${opt.bgClass} ${opt.textClass} ${opt.borderClass}`}>
              {opt.label}
            </span>
          ))}
          <span className="text-[9px] text-slate-400 ml-1">Pilih status per karyawan</span>
        </div>

        {error && (
          <div className="mx-4 mt-2 p-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-[11px] font-semibold">{error}</div>
        )}

        {saving && (
          <div className="mx-4 mt-2 p-2 rounded-lg bg-blue-50 border border-blue-200 text-blue-800 text-[11px]">
            Menyimpan... {savedCount}/{savingCount}
          </div>
        )}

        {/* Employee list */}
        <div className="flex-1 overflow-y-auto px-4 py-2">
          <div className="text-[11px] font-bold text-slate-600 mb-2">
            Karyawan ({employees.length})
          </div>
          <div className="space-y-1.5">
            {employees.map(emp => {
              const currentStatus = localStatuses[emp.employee_id] || 'OFF';
              return (
                <div key={emp.employee_id} className="border border-slate-200 rounded-lg p-2 hover:bg-slate-50 transition">
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="min-w-0">
                      <div className="text-[11px] font-bold text-slate-800 truncate">{emp.employee_name}</div>
                      <div className="text-[9px] text-slate-500">{emp.position_name || '—'}</div>
                    </div>
                  </div>
                  <div className="flex gap-1 flex-wrap">
                    {STATUS_OPTIONS.map(opt => (
                      <button key={opt.value}
                        onClick={() => setEmployeeStatus(emp.employee_id, opt.value)}
                        className={`px-2 py-1 text-[9px] font-bold rounded border transition cursor-pointer ${
                          currentStatus === opt.value
                            ? `${opt.bgClass} ${opt.textClass} ${opt.borderClass}`
                            : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'
                        }`}>
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Actions */}
        <div className="px-4 py-3 border-t border-slate-200 flex justify-end gap-2">
          <button onClick={onClose}
            className="px-3 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 cursor-pointer">Batal</button>
          <button onClick={handleSaveAll} disabled={saving || changesCount === 0}
            className="px-4 py-1.5 text-[11px] font-bold rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] disabled:opacity-50 cursor-pointer">
            {saving ? 'Menyimpan...' : changesCount > 0 ? `Simpan (${changesCount} perubahan)` : 'Tidak Ada Perubahan'}
          </button>
        </div>
      </div>
    </div>
  );
};
