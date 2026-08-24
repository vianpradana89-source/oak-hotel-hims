import { useEffect, useState } from 'react';
import { roomMasterApi } from './roomMasterApi';
import { describeApiError, MasterStatusBadge, OperationalStatusBadge } from './roomMasterUi';
import type { PhysicalRoom, RoomType } from './roomMasterTypes';

type Mode = 'create' | 'edit';

interface Props {
  mode: Mode;
  room?: PhysicalRoom | null;
  roomTypes: RoomType[];
  onClose: (changed: boolean) => void;
}

interface Draft {
  room_number: string;
  room_type_id: string;
  floor: string;
  notes: string;
  is_active: boolean;
}

export default function RoomModal({ mode, room, roomTypes, onClose }: Props) {
  const [viewing, setViewing] = useState(mode === 'edit');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [draft, setDraft] = useState<Draft>(() =>
    mode === 'edit' && room
      ? {
          room_number: room.room_number,
          room_type_id: room.room_type_id === null ? '' : String(room.room_type_id),
          floor: room.floor ?? '',
          notes: room.notes ?? '',
          is_active: Boolean(room.is_active)
        }
      : {
          room_number: '',
          // Only active types are offered for a new physical room.
          room_type_id: String(roomTypes.find((t) => t.is_active)?.id ?? ''),
          floor: '',
          notes: '',
          is_active: true
        }
  );

  useEffect(() => {
    setError(null);
  }, [viewing]);

  const setField = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  async function handleSave() {
    if (!draft.room_number.trim()) {
      setError({ code: 'VALIDATION_ERROR', message: 'Nomor kamar wajib diisi.' });
      return;
    }
    if (!draft.room_type_id) {
      setError({ code: 'VALIDATION_ERROR', message: 'Tipe kamar wajib dipilih.' });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (mode === 'create') {
        await roomMasterApi.createRoom({
          room_number: draft.room_number.trim(),
          room_type_id: Number(draft.room_type_id),
          floor: draft.floor.trim() || null,
          notes: draft.notes.trim() || null
        });
      } else if (room) {
        await roomMasterApi.updateRoom(room.id, {
          room_number: draft.room_number.trim(),
          room_type_id: Number(draft.room_type_id),
          floor: draft.floor.trim() || null,
          notes: draft.notes.trim() || null,
          ...(Boolean(room.is_active) !== draft.is_active ? { is_active: draft.is_active } : {})
        });
      }
      onClose(true);
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="rm-modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onClose(false);
      }}
    >
      <div className="rm-modal">
        <div className="rm-modal-head">
          <div>
            <span className="rm-kicker">Kamar Fisik</span>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <h3 className="rm-modal-title">
                {mode === 'create' ? 'Tambah Kamar' : `Kamar ${room?.room_number ?? ''}`}
              </h3>
              <span className="rm-modal-mode">{viewing && mode === 'edit' ? 'View' : 'Edit'}</span>
            </div>
          </div>
          {mode === 'edit' && (
            <div style={{ display: 'flex', gap: 6 }}>
              <OperationalStatusBadge status={room?.status ?? null} />
              <MasterStatusBadge active={Boolean(room?.is_active)} />
            </div>
          )}
        </div>

        <div className="rm-modal-body">
          {error && (
            <div className="rm-alert rm-alert--error" style={{ marginBottom: 12 }}>
              <span>
                {error.message}
                <span className="rm-alert-code">{error.code}</span>
              </span>
              <button type="button" className="rm-alert-dismiss" onClick={() => setError(null)}>×</button>
            </div>
          )}

          {mode === 'create' || !viewing ? (
            <div className="rm-form-grid">
              <div className="rm-field">
                <label htmlFor="rm-number">Nomor Kamar</label>
                <input
                  id="rm-number"
                  value={draft.room_number}
                  onChange={(e) => setField('room_number', e.target.value)}
                  placeholder="101"
                />
              </div>
              <div className="rm-field">
                <label htmlFor="rm-type">Tipe Kamar</label>
                <select
                  id="rm-type"
                  value={draft.room_type_id}
                  onChange={(e) => setField('room_type_id', e.target.value)}
                >
                  <option value="">— pilih tipe —</option>
                  {roomTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.code} · {t.name}{t.is_active ? '' : ' (nonaktif)'}
                    </option>
                  ))}
                </select>
              </div>
              <div className="rm-field">
                <label htmlFor="rm-floor">Lantai</label>
                <input
                  id="rm-floor"
                  value={draft.floor}
                  maxLength={10}
                  onChange={(e) => setField('floor', e.target.value)}
                  placeholder="1"
                />
              </div>
              {mode === 'edit' && (
                <div className="rm-switch-row">
                  <input
                    id="rm-active"
                    type="checkbox"
                    checked={draft.is_active}
                    onChange={(e) => setField('is_active', e.target.checked)}
                  />
                  <label htmlFor="rm-active" className="rm-switch-label">
                    Kamar Aktif (dihitung dalam kapasitas kamar)
                  </label>
                </div>
              )}
              <div className="rm-field rm-field--full">
                <label htmlFor="rm-notes">Catatan</label>
                <textarea
                  id="rm-notes"
                  value={draft.notes}
                  maxLength={500}
                  onChange={(e) => setField('notes', e.target.value)}
                />
              </div>
            </div>
          ) : (
            <dl className="rm-detail-list">
              <div className="rm-detail-item"><dt>Nomor Kamar</dt><dd>{room?.room_number}</dd></div>
              <div className="rm-detail-item">
                <dt>Tipe Kamar</dt>
                <dd>{room?.room_type_code} · {room?.room_type_name || '—'}</dd>
              </div>
              <div className="rm-detail-item"><dt>Lantai</dt><dd>{room?.floor || '—'}</dd></div>
              <div className="rm-detail-item"><dt>Status Operasional</dt><dd><OperationalStatusBadge status={room?.status ?? null} /></dd></div>
              <div className="rm-detail-item"><dt>Status Master</dt><dd><MasterStatusBadge active={Boolean(room?.is_active)} /></dd></div>
              <div className="rm-detail-item"><dt>Reservasi Aktif</dt><dd>{room?.active_reservation_count ?? 0}</dd></div>
              <div className="rm-detail-item rm-field--full"><dt>Catatan</dt><dd>{room?.notes || '—'}</dd></div>
            </dl>
          )}
        </div>

        <div className="rm-modal-foot">
          {mode === 'edit' && viewing ? (
            <>
              <button
                type="button"
                className="rm-btn rm-btn--primary"
                onClick={() => setViewing(false)}
                disabled={saving}
              >
                Edit
              </button>
              <button type="button" className="rm-btn rm-btn--secondary" onClick={() => onClose(false)}>
                Tutup
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="rm-btn rm-btn--secondary"
                onClick={() => (mode === 'edit' ? setViewing(true) : onClose(false))}
                disabled={saving}
              >
                {mode === 'edit' ? 'Batal Edit' : 'Batal'}
              </button>
              <button type="button" className="rm-btn rm-btn--primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Menyimpan…' : 'Simpan'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
