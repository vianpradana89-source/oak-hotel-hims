import { useState } from 'react';
import { describeApiError } from './roomMasterUi';

interface Props {
  title: string;
  description: string;
  onConfirm: () => Promise<void>;
  onCancelled: () => void;
  onDeleted: () => void;
}

// RM-1D Safe Delete confirmation. Never deletes on a single click; the
// backend remains final authority and any domain conflict is surfaced here.
export default function ConfirmDeleteModal({ title, description, onConfirm, onCancelled, onDeleted }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onDeleted();
    } catch (err) {
      setError(describeApiError(err));
      setBusy(false);
    }
  }

  return (
    <div
      className="rm-modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancelled();
      }}
    >
      <div className="rm-modal rm-modal--confirm">
        <div className="rm-modal-head">
          <div>
            <span className="rm-kicker">Konfirmasi Hapus</span>
            <h3 className="rm-modal-title">{title}</h3>
          </div>
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
          <p className="rm-confirm-text">{description}</p>
        </div>
        <div className="rm-modal-foot">
          <button type="button" className="rm-btn rm-btn--secondary" onClick={onCancelled} disabled={busy}>
            Batal
          </button>
          <button
            type="button"
            className="rm-btn rm-btn--destructive"
            onClick={() => void handleConfirm()}
            disabled={busy}
          >
            {busy ? 'Menghapus…' : 'Hapus Permanen'}
          </button>
        </div>
      </div>
    </div>
  );
}
