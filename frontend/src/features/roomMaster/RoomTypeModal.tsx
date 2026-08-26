import { useEffect, useState } from 'react';
import { roomMasterApi } from './roomMasterApi';
import { describeApiError, MasterStatusBadge } from './roomMasterUi';
import type { RoomCategory, RoomType } from './roomMasterTypes';

type Mode = 'create' | 'edit';

interface Props {
  mode: Mode;
  roomType?: RoomType | null;
  categories: RoomCategory[];
  onClose: (changed: boolean) => void;
}

interface TypeDraft {
  code: string;
  name: string;
  room_category_id: string;
  description: string;
  capacity: number;
  max_adults: number;
  max_children: number;
  bed_type: string;
  display_order: number;
  is_active: boolean;
}

const EMPTY_DRAFT: TypeDraft = {
  code: '',
  name: '',
  room_category_id: '',
  description: '',
  capacity: 2,
  max_adults: 2,
  max_children: 0,
  bed_type: '',
  display_order: 0,
  is_active: true
};

export default function RoomTypeModal({ mode, roomType, categories, onClose }: Props) {
  const [viewing, setViewing] = useState(mode === 'edit');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<TypeDraft>(() =>
    mode === 'edit' && roomType
      ? {
          code: roomType.code,
          name: roomType.name,
           room_category_id: roomType.room_category_id == null ? '' : String(roomType.room_category_id),
          description: roomType.description ?? '',
          capacity: Number(roomType.capacity ?? 2),
          max_adults: Number(roomType.max_adults ?? roomType.capacity ?? 2),
          max_children: Number(roomType.max_children ?? 0),
          bed_type: roomType.bed_type ?? '',
          display_order: Number(roomType.display_order ?? 0),
          is_active: Boolean(roomType.is_active)
        }
      : {
          ...EMPTY_DRAFT,
           room_category_id: String(categories.find((category) => category.is_active)?.id ?? '')
        }
  );
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  useEffect(() => {
    setError(null);
  }, [viewing]);

  const setField = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  async function handleSave() {
    if (!draft.name.trim()) {
      setError({ code: 'VALIDATION_ERROR', message: 'Nama tipe wajib diisi.' });
      return;
    }
    if (!draft.room_category_id) {
      setError({ code: 'VALIDATION_ERROR', message: 'Kategori kamar wajib dipilih.' });
      return;
    }
    const nextCode = draft.code.trim().toUpperCase();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$/.test(nextCode)) {
      setError({
        code: 'VALIDATION_ERROR',
        message: 'Kode harus 2–20 karakter (huruf/angka, awali huruf atau angka; boleh _ dan -).'
      });
      return;
    }
    if (Number(draft.max_adults) > Number(draft.capacity)) {
      setError({ code: 'VALIDATION_ERROR', message: 'Max Adult tidak boleh melebihi kapasitas.' });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (mode === 'create') {
        await roomMasterApi.createRoomType({
          code: nextCode,
          name: draft.name.trim(),
          room_category_id: Number(draft.room_category_id),
          description: draft.description.trim() || null,
          capacity: Number(draft.capacity),
          max_adults: Number(draft.max_adults),
          max_children: Number(draft.max_children),
          bed_type: draft.bed_type.trim() || null,
          display_order: Number(draft.display_order || 0)
        });
      } else if (roomType) {
        await roomMasterApi.updateRoomType(roomType.id, {
          // Canonical identity stays room_types.id; the code is a unique human
          // label. Send it only when changed; backend guards duplicates.
          ...(nextCode !== roomType.code ? { code: nextCode } : {}),
          name: draft.name.trim(),
          ...(String(roomType.room_category_id ?? '') !== draft.room_category_id
            ? { room_category_id: Number(draft.room_category_id) }
            : {}),
          description: draft.description.trim() || null,
          capacity: Number(draft.capacity),
          max_adults: Number(draft.max_adults),
          max_children: Number(draft.max_children),
          bed_type: draft.bed_type.trim() || null,
          display_order: Number(draft.display_order || 0),
          ...(Boolean(roomType.is_active) !== draft.is_active ? { is_active: draft.is_active } : {})
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
            <span className="rm-kicker">Tipe Kamar</span>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <h3 className="rm-modal-title">
                {mode === 'create' ? 'Tambah Tipe Kamar' : `Tipe ${roomType?.code ?? ''}`}
              </h3>
              <span className="rm-modal-mode">{viewing && mode === 'edit' ? 'View' : 'Edit'}</span>
            </div>
          </div>
          {mode === 'edit' && (
            <MasterStatusBadge active={Boolean(roomType?.is_active)} />
          )}
        </div>

        <div className="rm-modal-body">
          {error && (
            <div className={`rm-alert rm-alert--error`} style={{ marginBottom: 12 }}>
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
                <label htmlFor="rt-code">Kode</label>
                <input
                  id="rt-code"
                  value={draft.code}
                  onChange={(e) => setField('code', e.target.value.toUpperCase())}
                  placeholder="DLX"
                />
              </div>
              <div className="rm-field">
                <label htmlFor="rt-name">Nama Tipe</label>
                <input id="rt-name" value={draft.name} onChange={(e) => setField('name', e.target.value)} />
              </div>
              <div className="rm-field">
                <label htmlFor="rt-category">Kategori Kamar</label>
                <select
                  id="rt-category"
                  value={draft.room_category_id}
                  onChange={(e) => setField('room_category_id', e.target.value)}
                >
                  <option value="">- pilih kategori -</option>
                  {categories.map((category) => (
                    <option
                      key={category.id}
                      value={category.id}
                      disabled={!category.is_active && String(category.id) !== draft.room_category_id}
                    >
                      {category.code} · {category.name}{category.is_active ? '' : ' (nonaktif)'}
                    </option>
                  ))}
                </select>
              </div>
              <div className="rm-field">
                <label htmlFor="rt-capacity">Kapasitas</label>
                <input
                  id="rt-capacity"
                  type="number"
                  min={1}
                  max={999}
                  value={draft.capacity}
                  onChange={(e) => setField('capacity', Number(e.target.value))}
                />
              </div>
              <div className="rm-field">
                <label htmlFor="rt-adults">Maks. Dewasa</label>
                <input
                  id="rt-adults"
                  type="number"
                  min={1}
                  max={999}
                  value={draft.max_adults}
                  onChange={(e) => setField('max_adults', Number(e.target.value))}
                />
              </div>
              <div className="rm-field">
                <label htmlFor="rt-children">Maks. Anak</label>
                <input
                  id="rt-children"
                  type="number"
                  min={0}
                  max={99}
                  value={draft.max_children}
                  onChange={(e) => setField('max_children', Number(e.target.value))}
                />
              </div>
              <div className="rm-field">
                <label htmlFor="rt-bed">Tipe Kasur</label>
                <input
                  id="rt-bed"
                  value={draft.bed_type}
                  onChange={(e) => setField('bed_type', e.target.value)}
                  placeholder="King / Twin / …"
                />
              </div>
              <div className="rm-field">
                <label htmlFor="rt-order">Urutan Tampilan</label>
                <input
                  id="rt-order"
                  type="number"
                  min={0}
                  value={draft.display_order}
                  onChange={(e) => setField('display_order', Number(e.target.value))}
                />
              </div>
              {mode === 'edit' && (
                <div className="rm-switch-row">
                  <input
                    id="rt-active"
                    type="checkbox"
                    checked={draft.is_active}
                    onChange={(e) => setField('is_active', e.target.checked)}
                  />
                  <label htmlFor="rt-active" className="rm-switch-label">
                    Tipe Kamar Aktif (tersedia untuk penjualan)
                  </label>
                </div>
              )}
              <div className="rm-field rm-field--full">
                <label htmlFor="rt-desc">Deskripsi</label>
                <textarea
                  id="rt-desc"
                  value={draft.description}
                  onChange={(e) => setField('description', e.target.value)}
                />
              </div>
            </div>
          ) : (
            <dl className="rm-detail-list">
              <div className="rm-detail-item"><dt>Kode</dt><dd>{roomType?.code}</dd></div>
              <div className="rm-detail-item"><dt>Nama Tipe</dt><dd>{roomType?.name}</dd></div>
              <div className="rm-detail-item">
                <dt>Kategori</dt>
                <dd>
                  {categories.find((category) => category.id === roomType?.room_category_id)?.name
                    ?? roomType?.room_category_name
                    ?? 'Belum dikategorikan'}
                </dd>
              </div>
              <div className="rm-detail-item"><dt>Tipe Kasur</dt><dd>{roomType?.bed_type || '—'}</dd></div>
              <div className="rm-detail-item"><dt>Kapasitas</dt><dd>{roomType?.capacity ?? '—'}</dd></div>
              <div className="rm-detail-item"><dt>Maks. Dewasa</dt><dd>{roomType?.max_adults ?? '—'}</dd></div>
              <div className="rm-detail-item"><dt>Maks. Anak</dt><dd>{roomType?.max_children ?? '—'}</dd></div>
              <div className="rm-detail-item"><dt>Kamar Fisik</dt><dd>{roomType?.physical_room_count ?? 0}</dd></div>
              <div className="rm-detail-item"><dt>Kamar Aktif</dt><dd>{roomType?.active_physical_rooms ?? 0}</dd></div>
              <div className="rm-detail-item"><dt>Puncak Resv</dt><dd>{roomType?.future_reserved_peak ?? 0}</dd></div>
              <div className="rm-detail-item"><dt>Status</dt><dd><MasterStatusBadge active={Boolean(roomType?.is_active)} /></dd></div>
              <div className="rm-detail-item rm-field--full"><dt>Deskripsi</dt><dd>{roomType?.description || '—'}</dd></div>
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
