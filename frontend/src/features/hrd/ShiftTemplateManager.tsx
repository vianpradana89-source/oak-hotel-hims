import React, { useState, useEffect } from 'react';
import type { WorkShiftTemplate } from './scheduleTypes';

interface ShiftTemplateManagerProps {
  propertyId: number;
  onTemplatesUpdated?: () => void;
}

export const ShiftTemplateManager: React.FC<ShiftTemplateManagerProps> = ({ propertyId, onTemplatesUpdated }) => {
  const [templates, setTemplates] = useState<WorkShiftTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    code: '',
    name: '',
    start_time: '07:00',
    end_time: '15:00',
    crosses_midnight: false,
    grace_before_minutes: 15,
    late_grace_minutes: 15,
    checkout_grace_minutes: 60,
  });

  const getAuthHeaders = (): HeadersInit => {
    const token = localStorage.getItem('oak_hims_auth_token');
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  };

  const fetchTemplates = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/schedule/shift-templates?property_id=${propertyId}&include_inactive=true`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (data.status === 'OK') setTemplates(data.data || []);
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  useEffect(() => { fetchTemplates(); }, [propertyId]);

  const computeCrossesMidnight = (start: string, end: string) => {
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    return eh * 60 + em <= sh * 60 + sm;
  };

  const handleTimeChange = (field: 'start_time' | 'end_time', val: string) => {
    setForm(prev => {
      const next = { ...prev, [field]: val };
      next.crosses_midnight = computeCrossesMidnight(
        field === 'start_time' ? val : prev.start_time,
        field === 'end_time' ? val : prev.end_time
      );
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
        const body = {
          code: form.code.toUpperCase(),
          name: form.name,
          start_time: form.start_time,
          end_time: form.end_time,
          crosses_midnight: form.crosses_midnight,
          grace_before_minutes: form.grace_before_minutes,
          late_grace_minutes: form.late_grace_minutes,
          checkout_grace_minutes: form.checkout_grace_minutes,
        };
        let res: Response;
        if (editingId) {
          res = await fetch(`/api/schedule/shift-templates/${editingId}`, {
            method: 'PATCH', headers: getAuthHeaders(), body: JSON.stringify({ property_id: propertyId, ...body }),
          });
        } else {
          res = await fetch('/api/schedule/shift-templates', {
            method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ property_id: propertyId, ...body }),
          });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal menyimpan template');
      setShowForm(false);
      setEditingId(null);
      resetForm();
      await fetchTemplates();
      onTemplatesUpdated?.();
    } catch (err: any) {
      setError(err.message);
    } finally { setSubmitting(false); }
  };

  const handleEdit = (t: WorkShiftTemplate) => {
    setEditingId(t.id);
    setForm({
      code: t.code,
      name: t.name,
      start_time: t.start_time.substring(0, 5),
      end_time: t.end_time.substring(0, 5),
      crosses_midnight: t.crosses_midnight,
      grace_before_minutes: t.grace_before_minutes,
      late_grace_minutes: t.late_grace_minutes,
      checkout_grace_minutes: t.checkout_grace_minutes,
    });
    setShowForm(true);
  };

  const handleDeactivate = async (id: number) => {
    if (!confirm('Nonaktifkan shift template ini?')) return;
    try {
      const res = await fetch(`/api/schedule/shift-templates/${id}`, {
        method: 'DELETE', headers: getAuthHeaders(),
        body: JSON.stringify({ property_id: propertyId }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.message); }
      await fetchTemplates();
      onTemplatesUpdated?.();
    } catch (err: any) { alert(err.message); }
  };

  const resetForm = () => {
    setForm({ code: '', name: '', start_time: '07:00', end_time: '15:00', crosses_midnight: false, grace_before_minutes: 15, late_grace_minutes: 15, checkout_grace_minutes: 60 });
  };

  const formatTimeDisplay = (t: string) => t.substring(0, 5);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider">Shift Template</h3>
        <button
          type="button"
          onClick={() => { resetForm(); setEditingId(null); setShowForm(!showForm); }}
          className="px-3 py-1.5 text-[11px] font-bold rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] transition cursor-pointer"
        >
          {showForm ? 'Tutup' : '+ Template Baru'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-2">
          {error && <div className="p-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-[11px] font-semibold">{error}</div>}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] font-bold text-slate-600 mb-0.5">Kode</label>
              <input type="text" required maxLength={20} value={form.code} onChange={e => setForm(p => ({ ...p, code: e.target.value }))}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]" placeholder="M" />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-600 mb-0.5">Nama</label>
              <input type="text" required maxLength={100} value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]" placeholder="Morning" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] font-bold text-slate-600 mb-0.5">Jam Mulai</label>
              <input type="time" required value={form.start_time} onChange={e => handleTimeChange('start_time', e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]" />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-600 mb-0.5">Jam Selesai</label>
              <input type="time" required value={form.end_time} onChange={e => handleTimeChange('end_time', e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#1b4332]" />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-600">
              <input type="checkbox" checked={form.crosses_midnight} onChange={e => setForm(p => ({ ...p, crosses_midnight: e.target.checked }))}
                className="rounded border-slate-300" />
              Lewat Tengah Malam
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => { setShowForm(false); setEditingId(null); resetForm(); }}
              className="px-3 py-1.5 text-[11px] font-bold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 cursor-pointer">Batal</button>
            <button type="submit" disabled={submitting}
              className="px-3 py-1.5 text-[11px] font-bold rounded-lg bg-[#1b4332] text-white hover:bg-[#143326] disabled:opacity-50 cursor-pointer">
              {submitting ? 'Menyimpan...' : editingId ? 'Perbarui' : 'Simpan'}
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="text-center text-[11px] text-slate-500 py-4">Memuat...</div>
      ) : templates.length === 0 ? (
        <div className="text-center text-[11px] text-slate-400 py-4">Belum ada shift template.</div>
      ) : (
        <div className="bg-white border border-slate-200/90 rounded-xl overflow-hidden">
          <table className="w-full text-left text-[11px] border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200/80 text-slate-600 font-bold uppercase tracking-wider">
                <th className="py-2 px-3">Kode</th>
                <th className="py-2 px-3">Nama</th>
                <th className="py-2 px-3">Jam</th>
                <th className="py-2 px-3 text-center">Midnight</th>
                <th className="py-2 px-3 text-center">Status</th>
                <th className="py-2 px-3 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {templates.map(t => (
                <tr key={t.id} className="hover:bg-slate-50/80 transition">
                  <td className="py-2 px-3 font-bold text-slate-900 font-mono">{t.code}</td>
                  <td className="py-2 px-3 text-slate-700">{t.name}</td>
                  <td className="py-2 px-3 text-slate-600">{formatTimeDisplay(t.start_time)} - {formatTimeDisplay(t.end_time)}</td>
                  <td className="py-2 px-3 text-center">
                    {t.crosses_midnight ? (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800">Ya</span>
                    ) : (
                      <span className="text-slate-400">-</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-center">
                    {t.is_active ? (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">Aktif</span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-500">Nonaktif</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right space-x-1">
                    <button onClick={() => handleEdit(t)} className="px-2 py-0.5 text-[10px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded transition cursor-pointer">Edit</button>
                    {t.is_active && (
                      <button onClick={() => handleDeactivate(t.id)} className="px-2 py-0.5 text-[10px] font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 rounded transition cursor-pointer">Nonaktif</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
