import React, { useState, useEffect, useCallback } from 'react';

export type FieldMode = 'REQUIRED' | 'OPTIONAL' | 'HIDDEN';

export interface QuickBookingRuleMap {
  WALK_IN: Record<string, FieldMode>;
  OTA: Record<string, FieldMode>;
}

export interface DayUseDuration {
  id: number;
  property_id: number;
  name: string;
  duration_minutes: number;
  sort_order: number;
  is_active: boolean;
  is_archived: boolean;
}

const FIELD_DEFINITIONS: { key: string; label: string; desc: string }[] = [
  { key: 'booker_name', label: 'Nama Pemesan (Booker)', desc: 'Nama pihak yang memesan kamar' },
  { key: 'booker_phone', label: 'No. HP Pemesan', desc: 'Kontak nomor telepon pemesan' },
  { key: 'guest_name', label: 'Nama Tamu Menginap', desc: 'Nama tamu utama yang menempati kamar' },
  { key: 'guest_phone', label: 'No. HP Tamu Menginap', desc: 'Kontak nomor telepon tamu yang menginap' },
  { key: 'guest_segment', label: 'Segmen Tamu', desc: 'Reguler, Corporate, Group, VIP' },
  { key: 'referral', label: 'Referral / Sumber Info', desc: 'Referensi atau agen rujukan tamu' },
  { key: 'identity', label: 'Identitas / KTP', desc: 'Pemeriksaan / unggah dokumen identitas KTP/Paspor' },
  { key: 'payment_method', label: 'Metode Pembayaran', desc: 'Pilihan metode pembayaran (Cash, Transfer, QRIS, EDC)' },
  { key: 'payment_amount', label: 'Nominal Pembayaran', desc: 'Jumlah uang muka / pelunasan saat pemesanan' },
  { key: 'payment_evidence', label: 'Bukti Pembayaran', desc: 'Unggah bukti transfer/struk EDC non-tunai' },
  { key: 'rate_plan', label: 'Rate Plan / Paket Tarif', desc: 'Pilihan paket tarif kamar (Standard, Breakfast, Promo)' },
  { key: 'day_use', label: 'Layanan Day Use / Transit', desc: 'Izin dan ketersediaan opsi sewa kamar per jam / Day Use pada form reservasi' },
];

interface FrontOfficeSettingsTabProps {
  propertyId: number;
  apiBaseUrl?: string;
}

export const FrontOfficeSettingsTab: React.FC<FrontOfficeSettingsTabProps> = ({
  propertyId,
  apiBaseUrl = '/api'
}) => {
  const [subTab, setSubTab] = useState<'QUICK_BOOKING' | 'DAY_USE'>('QUICK_BOOKING');
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Quick Booking Rules State
  const [walkInRules, setWalkInRules] = useState<Record<string, FieldMode>>({});
  const [otaRules, setOtaRules] = useState<Record<string, FieldMode>>({});

  // Day Use Durations State
  const [durations, setDurations] = useState<DayUseDuration[]>([]);
  const [isDurationModalOpen, setIsDurationModalOpen] = useState<boolean>(false);
  const [editingDuration, setEditingDuration] = useState<DayUseDuration | null>(null);
  const [durationName, setDurationName] = useState<string>('');
  const [durationMinutes, setDurationMinutes] = useState<number>(180);
  const [durationSortOrder, setDurationSortOrder] = useState<number>(1);
  const [durationActive, setDurationActive] = useState<boolean>(true);

  // Load rules & durations
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [rulesRes, durationsRes] = await Promise.all([
        fetch(`${apiBaseUrl}/properties/${propertyId}/quick-booking-rules`),
        fetch(`${apiBaseUrl}/properties/${propertyId}/day-use-durations`)
      ]);

      if (rulesRes.ok) {
        const rulesJson = await rulesRes.json();
        const data = rulesJson.data?.rules || {};
        setWalkInRules(data.WALK_IN || {});
        setOtaRules(data.OTA || {});
      }

      if (durationsRes.ok) {
        const durJson = await durationsRes.json();
        setDurations(durJson.data || []);
      }
    } catch (err: any) {
      console.error('Failed to load Front Office settings:', err);
      setFeedback({ type: 'error', message: 'Gagal memuat pengaturan Front Office.' });
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, propertyId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Handle Quick Booking Save
  const handleSaveRules = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const [walkInRes, otaRes] = await Promise.all([
        fetch(`${apiBaseUrl}/properties/${propertyId}/quick-booking-rules`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel_type: 'WALK_IN', rules: walkInRules })
        }),
        fetch(`${apiBaseUrl}/properties/${propertyId}/quick-booking-rules`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel_type: 'OTA', rules: otaRules })
        })
      ]);

      if (!walkInRes.ok || !otaRes.ok) {
        throw new Error('Gagal menyimpan aturan Reservasi Cepat');
      }

      setFeedback({ type: 'success', message: 'Aturan Reservasi Cepat berhasil disimpan!' });
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Gagal menyimpan aturan.' });
    } finally {
      setSaving(false);
    }
  };

  // Handle Day Use Create / Update
  const handleSaveDuration = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!durationName.trim()) {
      alert('Nama durasi wajib diisi.');
      return;
    }
    if (durationMinutes <= 0) {
      alert('Durasi menit harus lebih dari 0.');
      return;
    }

    try {
      if (editingDuration) {
        const res = await fetch(`${apiBaseUrl}/properties/${propertyId}/day-use-durations/${editingDuration.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: durationName.trim(),
            duration_minutes: durationMinutes,
            sort_order: durationSortOrder,
            is_active: durationActive
          })
        });
        if (!res.ok) throw new Error('Gagal memperbarui durasi');
      } else {
        const res = await fetch(`${apiBaseUrl}/properties/${propertyId}/day-use-durations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: durationName.trim(),
            duration_minutes: durationMinutes,
            sort_order: durationSortOrder
          })
        });
        if (!res.ok) throw new Error('Gagal menambahkan preset durasi');
      }

      setIsDurationModalOpen(false);
      setEditingDuration(null);
      setDurationName('');
      setDurationMinutes(180);
      setDurationSortOrder(1);
      loadData();
      setFeedback({ type: 'success', message: 'Durasi Day Use berhasil disimpan!' });
    } catch (err: any) {
      alert(err.message || 'Gagal memproses data durasi');
    }
  };

  // Handle Duration Delete
  const handleDeleteDuration = async (id: number) => {
    if (!confirm('Apakah Anda yakin ingin menghapus preset durasi ini?')) return;
    try {
      const res = await fetch(`${apiBaseUrl}/properties/${propertyId}/day-use-durations/${id}`, {
        method: 'DELETE'
      });
      if (!res.ok) throw new Error('Gagal menghapus durasi');
      loadData();
      setFeedback({ type: 'success', message: 'Preset durasi berhasil dihapus.' });
    } catch (err: any) {
      alert(err.message || 'Gagal menghapus durasi');
    }
  };

  if (loading) {
    return (
      <div className="p-8 text-center text-neutral-500 flex flex-col items-center justify-center space-y-2">
        <div className="w-8 h-8 border-4 border-emerald-600 border-t-transparent rounded-full animate-spin"></div>
        <p className="text-sm font-medium">Memuat konfigurasi Front Office...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Sub Tab Navigation */}
      <div className="flex items-center justify-between border-b border-neutral-200 pb-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSubTab('QUICK_BOOKING')}
            className={`px-4 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer ${
              subTab === 'QUICK_BOOKING'
                ? 'bg-emerald-800 text-white shadow-xs'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
            }`}
          >
            ⚡ Reservasi Cepat (Quick Booking)
          </button>
          <button
            type="button"
            onClick={() => setSubTab('DAY_USE')}
            className={`px-4 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer ${
              subTab === 'DAY_USE'
                ? 'bg-emerald-800 text-white shadow-xs'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
            }`}
          >
            🕒 Day Use & Transit (Durasi)
          </button>
        </div>

        {subTab === 'QUICK_BOOKING' && (
          <button
            type="button"
            onClick={handleSaveRules}
            disabled={saving}
            className="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-xl shadow-xs transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            {saving ? 'Menyimpan...' : '💾 Simpan Pengaturan Form'}
          </button>
        )}

        {subTab === 'DAY_USE' && (
          <button
            type="button"
            onClick={() => {
              setEditingDuration(null);
              setDurationName('');
              setDurationMinutes(180);
              setDurationSortOrder(durations.length + 1);
              setDurationActive(true);
              setIsDurationModalOpen(true);
            }}
            className="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-xl shadow-xs transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            + Tambah Preset Durasi
          </button>
        )}
      </div>

      {/* Feedback Toast */}
      {feedback && (
        <div
          className={`p-3.5 rounded-xl text-xs font-semibold flex items-center justify-between ${
            feedback.type === 'success'
              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
              : 'bg-rose-50 text-rose-800 border border-rose-200'
          }`}
        >
          <span>{feedback.message}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-neutral-400 hover:text-neutral-600 ml-3"
          >
            ✕
          </button>
        </div>
      )}

      {/* Subtab 1: Quick Booking Field Mode Matrix */}
      {subTab === 'QUICK_BOOKING' && (
        <div className="bg-white rounded-2xl border border-neutral-200/90 shadow-xs overflow-hidden">
          <div className="p-5 border-b border-neutral-100 bg-neutral-50/50">
            <h4 className="text-sm font-bold text-neutral-900">
              Matriks Kewajiban Isian Form Reservasi Cepat
            </h4>
            <p className="text-xs text-neutral-500 mt-0.5">
              Tentukan field yang wajib diisi, opsional, atau disembunyikan secara independen untuk jalur Tamu Walk-In vs Jalur OTA. Backend akan memvalidasi secara otomatis.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-100/70 text-neutral-700 font-bold">
                  <th className="py-3 px-4 w-12 text-center">No</th>
                  <th className="py-3 px-4">Field Isian Form</th>
                  <th className="py-3 px-4 w-1/3">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                      <span>Jalur WALK-IN</span>
                    </div>
                  </th>
                  <th className="py-3 px-4 w-1/3">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                      <span>Jalur OTA (Online Travel Agent)</span>
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {FIELD_DEFINITIONS.map((def, idx) => {
                  const walkInMode: FieldMode = walkInRules[def.key] || 'OPTIONAL';
                  const otaMode: FieldMode = otaRules[def.key] || 'OPTIONAL';

                  return (
                    <tr key={def.key} className="hover:bg-neutral-50/80 transition-colors">
                      <td className="py-3 px-4 text-center font-medium text-neutral-400">
                        {idx + 1}
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-bold text-neutral-800">{def.label}</div>
                        <div className="text-[11px] text-neutral-500">{def.desc}</div>
                      </td>

                      {/* Walk-in Radio Pills */}
                      <td className="py-3 px-4">
                        <div className="inline-flex rounded-lg border border-neutral-200 p-0.5 bg-neutral-50">
                          {(['REQUIRED', 'OPTIONAL', 'HIDDEN'] as FieldMode[]).map((mode) => {
                            const isSelected = walkInMode === mode;
                            let activeClass = '';
                            if (isSelected) {
                              if (mode === 'REQUIRED') activeClass = 'bg-rose-600 text-white shadow-xs font-bold';
                              else if (mode === 'OPTIONAL') activeClass = 'bg-emerald-700 text-white shadow-xs font-bold';
                              else activeClass = 'bg-neutral-700 text-white shadow-xs font-bold';
                            } else {
                              activeClass = 'text-neutral-600 hover:text-neutral-900 font-medium';
                            }

                            const label = mode === 'REQUIRED' ? 'WAJIB' : mode === 'OPTIONAL' ? 'OPSIONAL' : 'SEMBUNYIKAN';

                            return (
                              <button
                                key={mode}
                                type="button"
                                onClick={() => setWalkInRules((prev) => ({ ...prev, [def.key]: mode }))}
                                className={`px-2.5 py-1 text-[11px] rounded-md transition-all cursor-pointer ${activeClass}`}
                              >
                                {label}
                              </button>
                            );
                          })}
                        </div>
                      </td>

                      {/* OTA Radio Pills */}
                      <td className="py-3 px-4">
                        <div className="inline-flex rounded-lg border border-neutral-200 p-0.5 bg-neutral-50">
                          {(['REQUIRED', 'OPTIONAL', 'HIDDEN'] as FieldMode[]).map((mode) => {
                            const isSelected = otaMode === mode;
                            let activeClass = '';
                            if (isSelected) {
                              if (mode === 'REQUIRED') activeClass = 'bg-rose-600 text-white shadow-xs font-bold';
                              else if (mode === 'OPTIONAL') activeClass = 'bg-blue-600 text-white shadow-xs font-bold';
                              else activeClass = 'bg-neutral-700 text-white shadow-xs font-bold';
                            } else {
                              activeClass = 'text-neutral-600 hover:text-neutral-900 font-medium';
                            }

                            const label = mode === 'REQUIRED' ? 'WAJIB' : mode === 'OPTIONAL' ? 'OPSIONAL' : 'SEMBUNYIKAN';

                            return (
                              <button
                                key={mode}
                                type="button"
                                onClick={() => setOtaRules((prev) => ({ ...prev, [def.key]: mode }))}
                                className={`px-2.5 py-1 text-[11px] rounded-md transition-all cursor-pointer ${activeClass}`}
                              >
                                {label}
                              </button>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="p-4 bg-neutral-50 border-t border-neutral-200 flex items-center justify-between">
            <div className="text-[11px] text-neutral-500">
              💡 Tip: Isian yang disetel <strong>SEMBUNYIKAN</strong> tidak akan ditampilkan di formulir pemesanan cepat staf.
            </div>
            <button
              type="button"
              onClick={handleSaveRules}
              disabled={saving}
              className="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-xl shadow-xs transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              {saving ? 'Menyimpan...' : '💾 Simpan Pengaturan Form'}
            </button>
          </div>
        </div>
      )}

      {/* Subtab 2: Day Use & Transit Durations Master */}
      {subTab === 'DAY_USE' && (
        <div className="bg-white rounded-2xl border border-neutral-200/90 shadow-xs overflow-hidden">
          <div className="p-5 border-b border-neutral-100 bg-neutral-50/50 flex items-center justify-between">
            <div>
              <h4 className="text-sm font-bold text-neutral-900">
                Master Durasi Day Use & Transit
              </h4>
              <p className="text-xs text-neutral-500 mt-0.5">
                Daftar pilihan durasi menginap singkat (Day Use). Jam checkout akan dihitung otomatis dari jam mulai + durasi preset.
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-100/70 text-neutral-700 font-bold">
                  <th className="py-3 px-4 w-12 text-center">Urutan</th>
                  <th className="py-3 px-4">Nama Preset</th>
                  <th className="py-3 px-4">Durasi Menit</th>
                  <th className="py-3 px-4">Durasi Jam</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {durations.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-neutral-400">
                      Belum ada preset durasi Day Use.
                    </td>
                  </tr>
                ) : (
                  durations.map((dur) => (
                    <tr key={dur.id} className="hover:bg-neutral-50/80 transition-colors">
                      <td className="py-3 px-4 text-center font-bold text-neutral-500">
                        {dur.sort_order}
                      </td>
                      <td className="py-3 px-4 font-bold text-neutral-800">
                        {dur.name}
                      </td>
                      <td className="py-3 px-4 font-mono text-neutral-700">
                        {dur.duration_minutes} menit
                      </td>
                      <td className="py-3 px-4 text-neutral-600">
                        {(dur.duration_minutes / 60).toFixed(1).replace('.0', '')} jam
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`px-2.5 py-0.5 text-[10px] font-bold rounded-full ${
                            dur.is_active
                              ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                              : 'bg-neutral-100 text-neutral-600 border border-neutral-300'
                          }`}
                        >
                          {dur.is_active ? 'AKTIF' : 'NONAKTIF'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right space-x-2">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingDuration(dur);
                            setDurationName(dur.name);
                            setDurationMinutes(dur.duration_minutes);
                            setDurationSortOrder(dur.sort_order);
                            setDurationActive(dur.is_active);
                            setIsDurationModalOpen(true);
                          }}
                          className="px-2.5 py-1 text-[11px] font-bold bg-neutral-100 hover:bg-neutral-200 text-neutral-700 rounded-lg transition-colors cursor-pointer"
                        >
                          ✏️ Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteDuration(dur.id)}
                          className="px-2.5 py-1 text-[11px] font-bold bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg transition-colors cursor-pointer"
                        >
                          🗑️ Hapus
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal Add / Edit Duration */}
      {isDurationModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-neutral-200">
              <h3 className="text-base font-bold text-neutral-900">
                {editingDuration ? 'Edit Preset Durasi' : 'Tambah Preset Durasi Day Use'}
              </h3>
              <button
                type="button"
                onClick={() => setIsDurationModalOpen(false)}
                className="text-neutral-400 hover:text-neutral-600 text-lg font-bold"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveDuration} className="space-y-4 text-xs">
              <div>
                <label className="block font-bold text-neutral-700 mb-1">
                  Nama Durasi <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="Contoh: 3 Jam, 6 Jam, 12 Jam"
                  value={durationName}
                  onChange={(e) => setDurationName(e.target.value)}
                  className="w-full px-3 py-2 border border-neutral-300 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-neutral-700 mb-1">
                    Durasi (Menit) <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="number"
                    min={30}
                    step={15}
                    required
                    value={durationMinutes}
                    onChange={(e) => setDurationMinutes(Number(e.target.value))}
                    className="w-full px-3 py-2 border border-neutral-300 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                  />
                  <span className="text-[10px] text-neutral-400 mt-0.5 block">
                    = {(durationMinutes / 60).toFixed(1).replace('.0', '')} Jam
                  </span>
                </div>

                <div>
                  <label className="block font-bold text-neutral-700 mb-1">
                    Urutan Tampilan
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={durationSortOrder}
                    onChange={(e) => setDurationSortOrder(Number(e.target.value))}
                    className="w-full px-3 py-2 border border-neutral-300 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                  />
                </div>
              </div>

              {editingDuration && (
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="checkbox"
                    id="durActive"
                    checked={durationActive}
                    onChange={(e) => setDurationActive(e.target.checked)}
                    className="w-4 h-4 text-emerald-600 rounded border-neutral-300"
                  />
                  <label htmlFor="durActive" className="font-semibold text-neutral-700 cursor-pointer">
                    Preset Aktif (Tampil di form pemesanan)
                  </label>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-4 border-t border-neutral-200">
                <button
                  type="button"
                  onClick={() => setIsDurationModalOpen(false)}
                  className="px-4 py-2 border border-neutral-300 text-neutral-700 font-bold rounded-xl hover:bg-neutral-100 transition-colors cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white font-bold rounded-xl shadow-xs transition-colors cursor-pointer"
                >
                  Simpan Durasi
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
