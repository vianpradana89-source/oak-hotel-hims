import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import { safeFetchJson } from './calendarApi';
import { useAuth } from '../auth/AuthContext';

interface Props {
  isOpen: boolean;
  reservation: any;
  propertyId: number;
  onClose: () => void;
  onSuccess: () => void;
}

function formatRp(amount: number): string {
  return `Rp${Math.max(0, Math.round(amount || 0)).toLocaleString('id-ID')}`;
}

export default function BookedReservationRepriceModal({
  isOpen,
  reservation,
  propertyId,
  onClose,
  onSuccess
}: Props) {
  const { authFetch } = useAuth();
  const [preview, setPreview] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [ratePlanId, setRatePlanId] = useState<number | null>(reservation?.rate_plan_id || null);
  const [ratePlans, setRatePlans] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !reservation?.id) return;
    let active = true;
    setPreview(null);
    setReason('');
    setError(null);
    setRatePlanId(reservation.rate_plan_id || null);
    setLoading(true);

    (async () => {
      try {
        const plansRes = await authFetch(`/api/pricing/rate-plans?property_id=${propertyId}&is_active=true`);
        const plansJson = await plansRes.json();
        const plans = Array.isArray(plansJson) ? plansJson : (Array.isArray(plansJson.data) ? plansJson.data : []);
        if (active) setRatePlans(plans);
      } catch (_err) {
        if (active) setRatePlans([]);
      }
    })();

    return () => {
      active = false;
    };
  }, [isOpen, reservation?.id, reservation?.rate_plan_id, propertyId, authFetch]);

  useEffect(() => {
    if (!isOpen || !reservation?.id) return;
    let active = true;
    setLoading(true);
    setError(null);
    safeFetchJson<{ data?: any }>(
      `/api/reservations/${reservation.id}/reprice-preview`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          rate_plan_id: ratePlanId || undefined
        })
      },
      'Gagal menghitung pratinjau koreksi tarif.',
      authFetch
    ).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setPreview(null);
        setError(result.data && typeof result.data === 'object' && 'message' in (result.data as any)
          ? String((result.data as any).message)
          : (result.errorMessage || 'Gagal menghitung pratinjau koreksi tarif.'));
        return;
      }
      setPreview(result.data?.data || null);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [isOpen, reservation?.id, propertyId, ratePlanId, authFetch]);

  if (!isOpen) return null;

  const roomTypeId = Number(preview?.canonical_room_type_id || reservation.booked_room_type_id_snapshot || reservation.room_type_id);
  const compatiblePlans = ratePlans.filter((rp) =>
    Number(rp.room_type_id) === roomTypeId
    && rp.is_active !== false
    && rp.is_archived !== true
  );

  const handleConfirm = async () => {
    if (!reason.trim() || saving) return;
    try {
      setSaving(true);
      setError(null);
      const result = await safeFetchJson(
        `/api/reservations/${reservation.id}/reprice`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            property_id: propertyId,
            rate_plan_id: ratePlanId || undefined,
            reason: reason.trim()
          })
        },
        'Gagal menyimpan koreksi tarif.',
        authFetch
      );
      if (!result.ok) {
        throw new Error(
          result.data && typeof result.data === 'object' && 'message' in (result.data as any)
            ? String((result.data as any).message)
            : (result.errorMessage || 'Gagal menyimpan koreksi tarif.')
        );
      }
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Gagal menyimpan koreksi tarif.');
    } finally {
      setSaving(false);
    }
  };

  return ReactDOM.createPortal(
    <div data-portal-overlay="booked-rate-correction" className="fixed inset-0 z-[80] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-[#FBF9F4] rounded-2xl max-w-lg w-full p-5 shadow-2xl border border-stone-200 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-emerald-950">Koreksi Tarif</h3>
            <p className="text-xs text-stone-500 mt-0.5">Hanya untuk reservasi BOOKED sebelum check-in. Pembayaran lama tidak diubah.</p>
          </div>
          <button type="button" onClick={onClose} className="text-stone-500 hover:text-stone-800 text-sm font-bold">✕</button>
        </div>

        {compatiblePlans.length > 0 && (
          <label className="block text-xs font-semibold text-stone-700">
            Rate plan
            <select
              value={ratePlanId || ''}
              onChange={(e) => setRatePlanId(e.target.value ? Number(e.target.value) : null)}
              className="mt-1 w-full text-xs px-3 py-2 bg-white border border-stone-300 rounded-lg"
            >
              <option value="">Pilih rate plan</option>
              {compatiblePlans.map((rp) => (
                <option key={rp.id} value={rp.id}>{rp.name || rp.code}</option>
              ))}
            </select>
          </label>
        )}

        {loading && <p className="text-xs text-stone-500">Menghitung tarif canonical…</p>}
        {error && <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{error}</p>}

        {preview && (
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="p-2.5 bg-white rounded-lg border border-stone-200">
              <span className="block text-stone-500">Tarif saat booking</span>
              <strong className="font-mono">{formatRp(preview.before.gross)}</strong>
            </div>
            <div className="p-2.5 bg-white rounded-lg border border-emerald-200">
              <span className="block text-stone-500">Tarif canonical saat ini</span>
              <strong className="font-mono text-emerald-900">{formatRp(preview.after.gross)}</strong>
            </div>
            <div className="p-2.5 bg-white rounded-lg border border-stone-200">
              <span className="block text-stone-500">Diskon lama</span>
              <strong className="font-mono">{formatRp(preview.before.discount)}</strong>
            </div>
            <div className="p-2.5 bg-white rounded-lg border border-emerald-200">
              <span className="block text-stone-500">Diskon baru</span>
              <strong className="font-mono">{formatRp(preview.after.discount)}</strong>
            </div>
            <div className="p-2.5 bg-white rounded-lg border border-stone-200">
              <span className="block text-stone-500">Total lama</span>
              <strong className="font-mono">{formatRp(preview.before.net)}</strong>
            </div>
            <div className="p-2.5 bg-white rounded-lg border border-emerald-200">
              <span className="block text-stone-500">Total baru</span>
              <strong className="font-mono">{formatRp(preview.after.net)}</strong>
            </div>
            <div className="p-2.5 bg-white rounded-lg border border-stone-200">
              <span className="block text-stone-500">Sudah dibayar</span>
              <strong className="font-mono">{formatRp(preview.after.paid)}</strong>
            </div>
            <div className="p-2.5 bg-white rounded-lg border border-amber-200">
              <span className="block text-stone-500">Sisa baru</span>
              <strong className="font-mono text-amber-900">{formatRp(preview.after.remaining)}</strong>
            </div>
          </div>
        )}

        <label className="block text-xs font-semibold text-stone-700">
          Alasan koreksi <span className="text-rose-500">*</span>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1 w-full text-xs px-3 py-2 bg-white border border-stone-300 rounded-lg"
            placeholder="Contoh: Koreksi tarif canonical Rate Calendar"
          />
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-2 text-xs font-semibold rounded-xl border border-stone-300 bg-white text-stone-700">Batal</button>
          <button
            type="button"
            disabled={!preview || !reason.trim() || saving}
            onClick={handleConfirm}
            className={`px-3 py-2 text-xs font-bold rounded-xl ${
              !preview || !reason.trim() || saving
                ? 'bg-stone-200 text-stone-400 cursor-not-allowed'
                : 'bg-emerald-800 hover:bg-emerald-700 text-white'
            }`}
          >
            {saving ? 'Menyimpan…' : 'Konfirmasi Koreksi Tarif'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
