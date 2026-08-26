import { useEffect, useRef, useState } from 'react';
import { roomMasterApi } from './roomMasterApi';
import { describeApiError, MasterStatusBadge } from './roomMasterUi';
import type { RoomCategory } from './roomMasterTypes';

type Mode = 'create' | 'edit';

interface Props {
  mode: Mode;
  category?: RoomCategory | null;
  initialViewing?: boolean;
  onClose: (changed: boolean) => void;
}

interface CategoryDraft {
  code: string;
  name: string;
  description: string;
  is_active: boolean;
}

const EMPTY_DRAFT: CategoryDraft = {
  code: '',
  name: '',
  description: '',
  is_active: true
};

function categoryDraft(category: RoomCategory): CategoryDraft {
  return {
    code: category.code,
    name: category.name,
    description: category.description ?? '',
    is_active: Boolean(category.is_active)
  };
}

export default function RoomCategoryModal({ mode, category, initialViewing = true, onClose }: Props) {
  const [viewing, setViewing] = useState(mode === 'edit' && initialViewing);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<CategoryDraft>(() =>
    mode === 'edit' && category
      ? categoryDraft(category)
      : { ...EMPTY_DRAFT }
  );
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const initialDraft = mode === 'edit' && category ? categoryDraft(category) : EMPTY_DRAFT;
  const dirty = draft.code !== initialDraft.code
    || draft.name !== initialDraft.name
    || draft.description !== initialDraft.description
    || draft.is_active !== initialDraft.is_active;

  useEffect(() => {
    setError(null);
  }, [viewing]);

  useEffect(() => {
    if (viewing) closeButtonRef.current?.focus();
    else codeInputRef.current?.focus();
  }, [viewing]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        requestClose();
        return;
      }
      if (event.key !== 'Tab' || !modalRef.current) return;
      const focusable = Array.from(modalRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
      ));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const setField = <K extends keyof CategoryDraft>(key: K, value: CategoryDraft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));

  function confirmDiscard() {
    return !dirty || window.confirm('Perubahan belum disimpan. Buang perubahan?');
  }

  function requestClose() {
    if (saving || (!viewing && !confirmDiscard())) return;
    onClose(false);
  }

  function cancelEdit() {
    if (saving || !confirmDiscard()) return;
    if (mode === 'edit' && category) {
      setDraft(categoryDraft(category));
      setViewing(true);
    } else {
      onClose(false);
    }
  }

  async function handleSave() {
    const nextCode = draft.code.trim().toUpperCase();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$/.test(nextCode)) {
      setError({
        code: 'VALIDATION_ERROR',
        message: 'Kode harus 2-20 karakter (huruf/angka, boleh _ dan -).'
      });
      return;
    }
    if (!draft.name.trim()) {
      setError({ code: 'VALIDATION_ERROR', message: 'Nama kategori wajib diisi.' });
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (mode === 'create') {
        await roomMasterApi.createRoomCategory({
          code: nextCode,
          name: draft.name.trim(),
          description: draft.description.trim() || null
        });
      } else if (category) {
        await roomMasterApi.updateRoomCategory(category.id, {
          ...(nextCode !== category.code ? { code: nextCode } : {}),
          name: draft.name.trim(),
          description: draft.description.trim() || null,
          ...(Boolean(category.is_active) !== draft.is_active ? { is_active: draft.is_active } : {})
        });
      }
      onClose(true);
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setSaving(false);
    }
  }

  const variantCount = category?.room_type_count ?? 0;

  return (
    <div
      className="rm-modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div ref={modalRef} className="rm-modal" role="dialog" aria-modal="true" aria-labelledby="room-category-modal-title">
        <div className="rm-modal-head">
          <div>
            <span className="rm-kicker">Kategori Kamar</span>
            <div className="rm-modal-title-row">
              <h3 id="room-category-modal-title" className="rm-modal-title">
                {mode === 'create' ? 'Tambah Kategori Kamar' : `Kategori ${category?.code ?? ''}`}
              </h3>
              <span className="rm-modal-mode">{viewing && mode === 'edit' ? 'View' : 'Edit'}</span>
            </div>
          </div>
          <div className="rm-modal-head-actions">
            {mode === 'edit' && <MasterStatusBadge active={Boolean(category?.is_active)} />}
            <button ref={closeButtonRef} type="button" className="rm-modal-close" aria-label="Tutup modal" onClick={requestClose}>×</button>
          </div>
        </div>

        <div className="rm-modal-body">
          {error && (
            <div className="rm-alert rm-alert--error rm-alert--modal">
              <span>
                {error.message}
                <span className="rm-alert-code">{error.code}</span>
              </span>
              <button type="button" className="rm-alert-dismiss" onClick={() => setError(null)}>x</button>
            </div>
          )}

          {mode === 'create' || !viewing ? (
            <div className="rm-form-grid">
              <div className="rm-field">
                <label htmlFor="rc-code">Kode</label>
                <input
                  id="rc-code"
                  ref={codeInputRef}
                  value={draft.code}
                  onChange={(event) => setField('code', event.target.value.toUpperCase())}
                  placeholder="DLX"
                />
              </div>
              <div className="rm-field">
                <label htmlFor="rc-name">Nama Kategori</label>
                <input
                  id="rc-name"
                  value={draft.name}
                  onChange={(event) => setField('name', event.target.value)}
                />
              </div>
              {mode === 'edit' && (
                <div className="rm-switch-row rm-switch-row--single">
                  <input
                    id="rc-active"
                    type="checkbox"
                    checked={draft.is_active}
                    onChange={(event) => setField('is_active', event.target.checked)}
                  />
                  <label htmlFor="rc-active" className="rm-switch-label">Kategori Aktif</label>
                </div>
              )}
              <div className="rm-field rm-field--full">
                <label htmlFor="rc-description">Deskripsi</label>
                <textarea
                  id="rc-description"
                  value={draft.description}
                  onChange={(event) => setField('description', event.target.value)}
                />
              </div>
              <p className="rm-form-note rm-field--full">
                Status kategori hanya mengatur klasifikasi. Kamar fisik aktif tetap tampil dan tetap operasional.
              </p>
            </div>
          ) : (
            <dl className="rm-detail-list">
              <div className="rm-detail-item"><dt>Kode</dt><dd>{category?.code}</dd></div>
              <div className="rm-detail-item"><dt>Nama Kategori</dt><dd>{category?.name}</dd></div>
              <div className="rm-detail-item"><dt>Tipe / Varian</dt><dd>{variantCount}</dd></div>
              <div className="rm-detail-item"><dt>Kamar Fisik</dt><dd>{category?.physical_room_count ?? 0}</dd></div>
              <div className="rm-detail-item"><dt>Status</dt><dd><MasterStatusBadge active={Boolean(category?.is_active)} /></dd></div>
              <div className="rm-detail-item rm-field--full"><dt>Deskripsi</dt><dd>{category?.description || '-'}</dd></div>
            </dl>
          )}
        </div>

        <div className={`rm-modal-foot ${mode === 'edit' && viewing ? 'rm-modal-foot--view' : ''}`}>
          {mode === 'edit' && viewing ? (
            <>
              <button type="button" className="rm-btn rm-btn--secondary" onClick={requestClose}>
                Tutup
              </button>
              <button type="button" className="rm-btn rm-btn--primary" onClick={() => setViewing(false)}>
                Edit
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="rm-btn rm-btn--secondary"
                onClick={cancelEdit}
                disabled={saving}
              >
                {mode === 'edit' ? 'Batal Edit' : 'Batal'}
              </button>
              <button type="button" className="rm-btn rm-btn--primary" onClick={() => void handleSave()} disabled={saving}>
                {saving ? 'Menyimpan...' : 'Simpan'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
