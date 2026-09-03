import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import { safeFetchJson } from './calendarApi';
import { useAuth } from '../auth/AuthContext';

const reasons = [
  ['GUEST_REQUEST', 'Permintaan Tamu'], ['MAINTENANCE', 'Maintenance'], ['ROOM_ISSUE', 'Masalah Kamar'],
  ['UPGRADE', 'Upgrade'], ['DOWNGRADE', 'Downgrade'], ['OPERATIONAL', 'Operasional'], ['OTHER', 'Lainnya']
];

export function RoomMoveModal({ isOpen, reservation, propertyId, onClose, onSuccess }: {
  isOpen: boolean; reservation: any; propertyId: number; onClose: () => void; onSuccess: () => void;
}) {
  const { authFetch } = useAuth();
  const [availability, setAvailability] = useState<any>(null);
  const [roomTypeId, setRoomTypeId] = useState<number | null>(null);
  const [roomId, setRoomId] = useState<number | null>(null);
  const [reason, setReason] = useState('GUEST_REQUEST');
  const [detail, setDetail] = useState('');
  const [treatment, setTreatment] = useState<'KEEP_CURRENT_RATE' | 'APPLY_NEW_RATE'>('KEEP_CURRENT_RATE');
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen || !reservation?.id) return;
    let active = true;
    setAvailability(null); setRoomTypeId(null); setRoomId(null); setPreview(null); setError(null); setDetail(''); setTreatment('KEEP_CURRENT_RATE');
    safeFetchJson<{ data?: any }>(`/api/reservations/${reservation.id}/room-move-availability?property_id=${propertyId}`, undefined, 'Gagal memuat kamar tujuan.', authFetch)
      .then(result => {
        if (!active) return;
        if (!result.ok) setError(result.errorMessage || 'Gagal memuat kamar tujuan.');
        else setAvailability(result.data?.data || null);
      })
      .catch(() => active && setError('Gagal memuat kamar tujuan.'));
    return () => { active = false; };
  }, [isOpen, reservation?.id, propertyId, authFetch]);

  const roomTypes = availability?.room_types || [];
  const rooms = roomTypes.find((type: any) => Number(type.id) === Number(roomTypeId))?.rooms || [];
  const targetTypeChanged = roomTypeId != null && Number(roomTypeId) !== Number(availability?.current_room?.room_type_id);

  useEffect(() => {
    if (!roomId || !isOpen) { setPreview(null); return; }
    let active = true;
    setLoading(true); setError(null);
    safeFetchJson<{ data?: any }>(`/api/reservations/${reservation.id}/room-move-preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ property_id: propertyId, to_room_id: roomId })
    }, 'Gagal menghitung dampak tarif.', authFetch).then(result => {
      if (!active) return;
      if (!result.ok) setError(result.errorMessage || 'Gagal menghitung dampak tarif.');
      else setPreview(result.data?.data || null);
    }).catch(() => active && setError('Gagal menghitung dampak tarif.')).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [roomId, isOpen, reservation?.id, propertyId, authFetch]);

  const submit = async () => {
    if (!roomId || !detail.trim()) { setError(!roomId ? 'Kamar tujuan wajib dipilih.' : 'Keterangan alasan wajib diisi.'); return; }
    try {
      setSaving(true); setError(null);
      const idempotencyKey = crypto.randomUUID();
      const result = await safeFetchJson(`/api/reservations/${reservation.id}/move`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ property_id: propertyId, to_room_id: roomId, reason_category: reason, reason_detail: detail.trim(), pricing_treatment: treatment })
      }, 'Pindah kamar gagal.', authFetch);
      if (!result.ok) throw new Error(result.errorMessage || 'Pindah kamar gagal.');
      onSuccess(); onClose();
    } catch (err: any) { setError(err.message || 'Pindah kamar gagal.'); }
    finally { setSaving(false); }
  };

  if (!isOpen) return null;
  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[80] bg-black/45 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Pindah Kamar">
      <div className="w-full max-w-xl rounded-2xl border border-stone-200 bg-[#fffdf7] shadow-2xl">
        <div className="px-5 py-4 border-b border-stone-200 bg-emerald-950 text-[#fff8e8] rounded-t-2xl">
          <h2 className="text-lg font-bold">Pindah Kamar</h2>
          <p className="text-xs text-emerald-100 mt-1">Perpindahan tercatat pada reservasi dan folio yang sama.</p>
        </div>
        <div className="p-5 space-y-4 text-sm">
          <div className="rounded-xl bg-stone-100 border border-stone-200 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-stone-500">Kamar Saat Ini</div>
            <div className="font-bold text-stone-900 mt-1">Kamar {availability?.current_room?.room_number || reservation?.room_number || '-'}</div>
            <div className="text-xs text-stone-600">{availability?.current_room?.room_type_name || reservation?.room_type_name || '-'}</div>
          </div>
          <label className="block text-xs font-bold text-stone-700">Tipe Kamar Tujuan
            <select value={roomTypeId || ''} onChange={e => { const value = Number(e.target.value) || null; setRoomTypeId(value); setRoomId(null); }} className="mt-1.5 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm" disabled={!availability}>
              <option value="">Pilih tipe kamar</option>
              {roomTypes.map((type: any) => <option key={type.id} value={type.id}>{type.name}</option>)}
            </select>
          </label>
          <label className="block text-xs font-bold text-stone-700">Kamar Tujuan
            <select value={roomId || ''} onChange={e => setRoomId(Number(e.target.value) || null)} className="mt-1.5 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm" disabled={!roomTypeId}>
              <option value="">Pilih kamar</option>
              {rooms.map((room: any) => <option key={room.id} value={room.id}>Kamar {room.room_number}{room.floor ? ` · Lantai ${room.floor}` : ''}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-xs font-bold text-stone-700">Alasan
              <select value={reason} onChange={e => setReason(e.target.value)} className="mt-1.5 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm">
                {reasons.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="block text-xs font-bold text-stone-700">Keterangan
              <input value={detail} onChange={e => setDetail(e.target.value)} className="mt-1.5 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm" placeholder="Wajib diisi" />
            </label>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
            <div className="text-xs font-bold text-amber-950">Dampak Tarif</div>
            {loading ? <p className="mt-1 text-xs text-amber-800">Menghitung dampak tarif...</p> : preview ? <p className="mt-1 text-xs text-amber-900">{preview.ota_manual_rate ? 'Tarif OTA manual tetap dipertahankan.' : targetTypeChanged ? `Perubahan estimasi sisa masa inap: Rp ${Number(preview.difference || 0).toLocaleString('id-ID')}` : 'Tipe kamar sama, tarif tetap.'}</p> : <p className="mt-1 text-xs text-amber-800">Pilih kamar tujuan untuk melihat ringkasan.</p>}
          </div>
          <div className="space-y-2">
            <div className="text-xs font-bold text-stone-700">Treatment</div>
            <label className="flex gap-2 text-xs text-stone-800"><input type="radio" checked={treatment === 'KEEP_CURRENT_RATE'} onChange={() => setTreatment('KEEP_CURRENT_RATE')} /> Pertahankan Tarif Saat Ini</label>
            {targetTypeChanged && !preview?.ota_manual_rate && <label className="flex gap-2 text-xs text-stone-800"><input type="radio" checked={treatment === 'APPLY_NEW_RATE'} onChange={() => setTreatment('APPLY_NEW_RATE')} /> Terapkan Tarif Baru</label>}
          </div>
          {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-stone-200 px-5 py-4">
          <button type="button" onClick={onClose} disabled={saving} className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-700">Batal</button>
          <button type="button" onClick={submit} disabled={saving || !availability} className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{saving ? 'Memindahkan...' : 'Konfirmasi Pindah Kamar'}</button>
        </div>
      </div>
    </div>, document.body
  );
}
