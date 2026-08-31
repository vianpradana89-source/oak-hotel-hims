import { useState } from 'react';
import { safeFetchJson } from './calendarApi';
import type { RoomOperationalBlock } from './calendarTypes';

interface Props {
  block: RoomOperationalBlock | null;
  roomNumber?: string;
  roomTypeName?: string;
  onClose: () => void;
  onRefresh?: () => void;
}

export default function OperationalBlockDetailModal({ block, roomNumber, roomTypeName, onClose, onRefresh }: Props) {
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!block) return null;

  const handleReleaseBlock = async () => {
    if (!window.confirm(`Selesaikan (Release) blok operasional kamar ${roomNumber || block.room_id} sekarang?`)) {
      return;
    }
    setLoading(true);
    setErrorMsg(null);
    try {
      const result = await safeFetchJson<{ status?: string; message?: string }>(
        `/api/room-operational-blocks/${block.id}/release`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            property_id: block.property_id,
            released_by: 'Front Office'
          })
        },
        'Gagal menyelesaikan blok operasional'
      );
      if (result.ok && result.data?.status === 'OK') {
        onRefresh?.();
        onClose();
      } else {
        setErrorMsg(result.errorMessage || 'Gagal menyelesaikan blok operasional');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Terjadi kesalahan jaringan');
    } finally {
      setLoading(false);
    }
  };

  const handleCancelBlock = async () => {
    if (!window.confirm(`Batalkan blok operasional kamar ${roomNumber || block.room_id}?`)) {
      return;
    }
    setLoading(true);
    setErrorMsg(null);
    try {
      const result = await safeFetchJson<{ status?: string; message?: string }>(
        `/api/room-operational-blocks/${block.id}/cancel`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            property_id: block.property_id,
            cancelled_by: 'Front Office',
            reason: 'Dibatalkan dari Kalender'
          })
        },
        'Gagal membatalkan blok operasional'
      );
      if (result.ok && result.data?.status === 'OK') {
        onRefresh?.();
        onClose();
      } else {
        setErrorMsg(result.errorMessage || 'Gagal membatalkan blok operasional');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Terjadi kesalahan jaringan');
    } finally {
      setLoading(false);
    }
  };

  const getBadgeStyle = () => {
    switch (block.block_type) {
      case 'OUT_OF_ORDER':
        return 'bg-rose-100 text-rose-800 border-rose-300';
      case 'OUT_OF_SERVICE':
        return 'bg-slate-100 text-slate-800 border-slate-300';
      case 'MAINTENANCE':
      default:
        return 'bg-amber-100 text-amber-800 border-amber-300';
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 animate-in fade-in duration-150">
      <div className="bg-white rounded-xl border border-neutral-200 shadow-2xl max-w-lg w-full overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 bg-stone-50 border-b border-stone-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`text-xs font-bold px-2 py-0.5 rounded border uppercase tracking-wider ${getBadgeStyle()}`}>
              {block.block_type}
            </span>
            <h3 className="font-bold text-base text-neutral-800">
              Blok Operasional Kamar {roomNumber || `#${block.room_id}`}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-700 w-8 h-8 flex items-center justify-center rounded-lg hover:bg-stone-200/50 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 text-sm">
          {errorMsg && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-700 text-xs">
              {errorMsg}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 bg-stone-50/80 p-3.5 rounded-lg border border-stone-200/60">
            <div>
              <div className="text-[11px] text-neutral-500 font-medium">Kamar & Tipe</div>
              <div className="font-semibold text-neutral-800">
                {roomNumber || block.room_id} {roomTypeName ? `· ${roomTypeName}` : ''}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-neutral-500 font-medium">Status Blok</div>
              <div className="font-semibold text-emerald-700">{block.status}</div>
            </div>
            <div>
              <div className="text-[11px] text-neutral-500 font-medium">Mulai Tanggal</div>
              <div className="font-semibold text-neutral-800">{block.start_date}</div>
            </div>
            <div>
              <div className="text-[11px] text-neutral-500 font-medium">Sampai Tanggal (Checkout)</div>
              <div className="font-semibold text-neutral-800">{block.end_date}</div>
            </div>
          </div>

          <div>
            <div className="text-xs text-neutral-500 font-medium mb-1">Alasan Pemblokiran</div>
            <div className="p-2.5 bg-white border border-neutral-200 rounded-lg text-neutral-800 font-medium">
              {block.reason || 'Tidak ada alasan spesifik tercatat'}
            </div>
          </div>

          {block.notes && (
            <div>
              <div className="text-xs text-neutral-500 font-medium mb-1">Catatan Tambahan</div>
              <div className="p-2.5 bg-white border border-neutral-200 rounded-lg text-neutral-700 text-xs">
                {block.notes}
              </div>
            </div>
          )}

          <div className="text-[11px] text-neutral-400 space-y-0.5 pt-1 border-t border-neutral-100">
            {block.created_by && <div>Dibuat oleh: <span className="font-medium text-neutral-600">{block.created_by}</span></div>}
            {block.created_at && <div>Waktu dibuat: {new Date(block.created_at).toLocaleString('id-ID')}</div>}
            {block.maintenance_task_id && (
              <div>Terkait Tugas Maintenance: <span className="font-mono text-neutral-600">#{block.maintenance_task_id}</span></div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="px-5 py-3.5 bg-stone-50 border-t border-stone-200 flex items-center justify-between gap-2">
          {block.status === 'ACTIVE' ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={loading}
                onClick={handleReleaseBlock}
                className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg text-xs font-semibold shadow-xs disabled:opacity-50"
              >
                {loading ? 'Memproses...' : 'Selesaikan Lebih Awal (Release)'}
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={handleCancelBlock}
                className="px-3 py-1.5 bg-white border border-rose-300 text-rose-700 hover:bg-rose-50 rounded-lg text-xs font-semibold shadow-xs disabled:opacity-50"
              >
                Batalkan
              </button>
            </div>
          ) : (
            <div className="text-xs text-neutral-400">Blok sudah tidak aktif</div>
          )}

          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 border border-neutral-300 rounded-lg text-xs font-medium text-neutral-700 hover:bg-stone-100 bg-white"
          >
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
}
