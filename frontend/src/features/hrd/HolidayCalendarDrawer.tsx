import React, { useState, useEffect } from 'react';
import type { PropertyHoliday } from './scheduleTypes';
import { useAuth } from '../auth/AuthContext';

interface HolidayCalendarDrawerProps {
  propertyId: number;
  onClose: () => void;
  onHolidaysUpdated: () => void;
}

const HOLIDAY_TYPES = [
  { value: 'NATIONAL', label: 'Nasional' },
  { value: 'LOCAL', label: 'Lokal' },
  { value: 'PROPERTY', label: 'Properti' },
];

export const HolidayCalendarDrawer: React.FC<HolidayCalendarDrawerProps> = ({ propertyId, onClose, onHolidaysUpdated }) => {
  const { user, authFetch } = useAuth();
  const isPlatformSuperAdmin = user?.role === 'Super Admin';

  const [holidays, setHolidays] = useState<PropertyHoliday[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editHoliday, setEditHoliday] = useState<PropertyHoliday | null>(null);
  const [filterYear, setFilterYear] = useState(new Date().getFullYear());
  const [formData, setFormData] = useState({
    holiday_date: '',
    name: '',
    holiday_type: 'NATIONAL' as 'NATIONAL' | 'LOCAL' | 'PROPERTY',
    is_active: true,
  });
  const [error, setError] = useState('');

  // Hard Delete Modal States (Platform Super Admin Only)
  const [hardDeleteHolidayTarget, setHardDeleteHolidayTarget] = useState<PropertyHoliday | null>(null);
  const [deletingHolidayHard, setDeletingHolidayHard] = useState(false);
  const [hardDeleteHolidayError, setHardDeleteHolidayError] = useState<string | null>(null);

  const fetchHolidays = async () => {
    setLoading(true);
    try {
      const res = await authFetch(`/api/schedule/holidays?property_id=${propertyId}&include_inactive=true&year=${filterYear}`);
      const data = await res.json();
      if (data.status === 'OK') setHolidays(data.data || []);
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  useEffect(() => { fetchHolidays(); }, [propertyId, filterYear]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const body: any = {
        property_id: propertyId,
        holiday_date: formData.holiday_date,
        name: formData.name,
        holiday_type: formData.holiday_type,
        is_active: formData.is_active,
      };

      const url = editHoliday ? `/api/schedule/holidays/${editHoliday.id}` : '/api/schedule/holidays';
      const method = editHoliday ? 'PATCH' : 'POST';

      const res = await authFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal menyimpan');

      setShowForm(false);
      setEditHoliday(null);
      setFormData({ holiday_date: '', name: '', holiday_type: 'NATIONAL', is_active: true });
      await fetchHolidays();
      onHolidaysUpdated();
    } catch (err: any) { setError(err.message); } finally { setSaving(false); }
  };

  const handleDeactivate = async (id: number) => {
    try {
      const res = await authFetch(`/api/schedule/holidays/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || 'Gagal menonaktifkan hari libur');
      }
      await fetchHolidays();
      onHolidaysUpdated();
    } catch (err: any) { setError(err.message); }
  };

  const handleReactivate = async (id: number) => {
    try {
      const res = await authFetch(`/api/schedule/holidays/${id}/reactivate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || 'Gagal mengaktifkan hari libur');
      }
      await fetchHolidays();
      onHolidaysUpdated();
    } catch (err: any) { setError(err.message); }
  };

  const handleExecuteHardDelete = async () => {
    if (!hardDeleteHolidayTarget) return;
    setDeletingHolidayHard(true);
    setHardDeleteHolidayError(null);
    try {
      const res = await authFetch(`/api/schedule/holidays/${hardDeleteHolidayTarget.id}/hard-delete?property_id=${propertyId}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal menghapus hari libur permanen');
      setHardDeleteHolidayTarget(null);
      await fetchHolidays();
      onHolidaysUpdated();
    } catch (err: any) {
      setHardDeleteHolidayError(err.message || 'Gagal menghapus hari libur permanen');
    } finally {
      setDeletingHolidayHard(false);
    }
  };

  const handleEdit = (holiday: PropertyHoliday) => {
    setEditHoliday(holiday);
    setFormData({
      holiday_date: holiday.holiday_date,
      name: holiday.name,
      holiday_type: holiday.holiday_type,
      is_active: holiday.is_active,
    });
    setShowForm(true);
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr + 'T00:00:00');
    return `${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'][d.getMonth()]} ${d.getFullYear()}`;
  };

  const getDayName = (dateStr: string) => {
    const d = new Date(dateStr + 'T00:00:00');
    return ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'][d.getDay()];
  };

  const yearOptions = [];
  const currentYear = new Date().getFullYear();
  for (let y = currentYear - 1; y <= currentYear + 2; y++) {
    yearOptions.push(y);
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div className="w-full max-w-lg bg-white h-full shadow-2xl overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between z-10">
          <h2 className="text-sm font-bold text-slate-900">Kalender Hari Libur</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 cursor-pointer">
            <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Year Filter + Add Button */}
          <div className="flex items-center gap-2">
            <select value={filterYear} onChange={e => setFilterYear(Number(e.target.value))}
              className="px-2 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#1b4332] cursor-pointer">
              {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            <div className="flex-1" />
            {!showForm && (
              <button onClick={() => { setEditHoliday(null); setFormData({ holiday_date: '', name: '', holiday_type: 'NATIONAL', is_active: true }); setShowForm(true); }}
                className="px-3 py-1.5 text-[11px] font-bold rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] transition cursor-pointer">
                + Tambah Libur
              </button>
            )}
          </div>

          {/* Form */}
          {showForm && (
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
              <h3 className="text-xs font-bold text-slate-800">{editHoliday ? 'Edit Hari Libur' : 'Hari Libur Baru'}</h3>
              {error && <div className="p-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-[11px]">{error}</div>}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-bold text-slate-600 mb-1">Tanggal</label>
                  <input type="date" value={formData.holiday_date} onChange={e => setFormData(p => ({ ...p, holiday_date: e.target.value }))}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]" />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-600 mb-1">Jenis</label>
                  <select value={formData.holiday_type} onChange={e => setFormData(p => ({ ...p, holiday_type: e.target.value as any }))}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332] cursor-pointer">
                    {HOLIDAY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-[10px] font-bold text-slate-600 mb-1">Nama Hari Libur</label>
                <input value={formData.name} onChange={e => setFormData(p => ({ ...p, name: e.target.value }))}
                  placeholder="Contoh: Hari Kemerdekaan"
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]" />
              </div>
              <div className="flex gap-2 pt-1">
                <button onClick={() => { setShowForm(false); setEditHoliday(null); }}
                  className="flex-1 px-3 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 cursor-pointer">Batal</button>
                <button onClick={handleSave} disabled={saving || !formData.holiday_date || !formData.name}
                  className="flex-1 px-3 py-1.5 text-[11px] font-bold rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] disabled:opacity-50 cursor-pointer">
                  {saving ? 'Menyimpan...' : 'Simpan'}
                </button>
              </div>
            </div>
          )}

          {/* Holidays List */}
          {loading ? (
            <div className="text-center py-8 text-slate-400 text-xs">Memuat...</div>
          ) : holidays.length === 0 ? (
            <div className="text-center py-8 text-slate-400 text-xs">Belum ada hari libur untuk tahun {filterYear}.</div>
          ) : (
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <table className="w-full text-left text-[11px]">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200/80">
                    <th className="py-2 px-3 font-bold text-slate-600">Tanggal</th>
                    <th className="py-2 px-3 font-bold text-slate-600">Hari</th>
                    <th className="py-2 px-3 font-bold text-slate-600">Nama</th>
                    <th className="py-2 px-3 font-bold text-slate-600">Jenis</th>
                    <th className="py-2 px-3 font-bold text-slate-600">Status</th>
                    <th className="py-2 px-3 font-bold text-slate-600">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {holidays.map(h => (
                    <tr key={h.id} className="hover:bg-slate-50/60">
                      <td className="py-1.5 px-3 font-bold text-slate-900">{formatDate(h.holiday_date)}</td>
                      <td className="py-1.5 px-3 text-slate-600">{getDayName(h.holiday_date)}</td>
                      <td className="py-1.5 px-3 text-slate-800">{h.name}</td>
                      <td className="py-1.5 px-3">
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                          h.holiday_type === 'NATIONAL' ? 'bg-blue-100 text-blue-800' :
                          h.holiday_type === 'LOCAL' ? 'bg-amber-100 text-amber-800' :
                          'bg-purple-100 text-purple-800'
                        }`}>
                          {h.holiday_type === 'NATIONAL' ? 'Nasional' : h.holiday_type === 'LOCAL' ? 'Lokal' : 'Properti'}
                        </span>
                      </td>
                      <td className="py-1.5 px-3">
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${h.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500'}`}>
                          {h.is_active ? 'Aktif' : 'Nonaktif'}
                        </span>
                      </td>
                      <td className="py-1.5 px-3">
                        <div className="flex items-center gap-1">
                          {h.is_active ? (
                            <>
                              <button
                                type="button"
                                onClick={() => handleEdit(h)}
                                className="px-2 py-0.5 text-[10px] font-bold rounded border border-slate-200 text-slate-600 hover:bg-slate-50 cursor-pointer"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeactivate(h.id)}
                                className="px-2 py-0.5 text-[10px] font-bold rounded border border-amber-200 text-amber-700 hover:bg-amber-50 cursor-pointer"
                              >
                                Nonaktifkan
                              </button>
                              {isPlatformSuperAdmin && (
                                <button
                                  type="button"
                                  onClick={() => { setHardDeleteHolidayTarget(h); setHardDeleteHolidayError(null); }}
                                  className="px-2 py-0.5 text-[10px] font-bold rounded border border-rose-200 text-rose-700 hover:bg-rose-50 cursor-pointer"
                                >
                                  Hapus
                                </button>
                              )}
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => handleReactivate(h.id)}
                                className="px-2 py-0.5 text-[10px] font-bold rounded border border-emerald-200 text-emerald-800 hover:bg-emerald-50 cursor-pointer"
                              >
                                Aktifkan
                              </button>
                              <button
                                type="button"
                                onClick={() => handleEdit(h)}
                                className="px-2 py-0.5 text-[10px] font-bold rounded border border-slate-200 text-slate-600 hover:bg-slate-50 cursor-pointer"
                              >
                                Edit
                              </button>
                              {isPlatformSuperAdmin && (
                                <button
                                  type="button"
                                  onClick={() => { setHardDeleteHolidayTarget(h); setHardDeleteHolidayError(null); }}
                                  className="px-2 py-0.5 text-[10px] font-bold rounded border border-rose-200 text-rose-700 hover:bg-rose-50 cursor-pointer"
                                >
                                  Hapus
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Hard Delete Holiday Modal (Platform Super Admin Only) */}
      {hardDeleteHolidayTarget && (
        <div className="fixed inset-0 z-60 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full border border-slate-200 shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200">
              <h3 className="font-serif font-bold text-base text-rose-900">
                Hapus Hari Libur
              </h3>
              <button
                type="button"
                onClick={() => { setHardDeleteHolidayTarget(null); setHardDeleteHolidayError(null); }}
                className="text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-600">
              Yakin ingin menghapus data ini? Data akan dihapus permanen.
            </p>

            {hardDeleteHolidayError && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs">
                {hardDeleteHolidayError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={() => { setHardDeleteHolidayTarget(null); setHardDeleteHolidayError(null); }}
                className="px-4 py-2 rounded-xl text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 transition cursor-pointer"
                disabled={deletingHolidayHard}
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleExecuteHardDelete}
                disabled={deletingHolidayHard}
                className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 transition cursor-pointer disabled:opacity-50"
              >
                {deletingHolidayHard ? 'Menghapus...' : 'Hapus'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
