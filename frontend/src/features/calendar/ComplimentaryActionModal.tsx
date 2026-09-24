import React, { useState, useCallback, useRef } from 'react';
import { Modal } from '../../design-system/Modal';
import {
  ComplimentaryApiError,
  type ComplimentaryCategory,
  requestComplimentary,
  approveComplimentaryRequest,
  rejectComplimentaryRequest,
  revokeComplimentaryRequest,
} from './complimentaryApi';

// ---------------------------------------------------------------------------
// Konstanta
// ---------------------------------------------------------------------------

const CATEGORY_OPTIONS: { value: ComplimentaryCategory; label: string }[] = [
  { value: 'OWNER_GUEST', label: 'Owner / Tamu' },
  { value: 'VIP', label: 'VIP' },
  { value: 'SERVICE_RECOVERY', label: 'Service Recovery' },
  { value: 'PROMOTION', label: 'Promosi' },
  { value: 'STAFF', label: 'Staff' },
  { value: 'MANAGEMENT', label: 'Management' },
  { value: 'OTHER', label: 'Lainnya' },
];

type Action = 'REQUEST' | 'APPROVE' | 'REJECT' | 'REVOKE';

// ---------------------------------------------------------------------------
// Peta pesan UX per backend error code
// ---------------------------------------------------------------------------

function mapBackendError(
  code: string | null,
  fallback: string
): string {
  switch (code) {
    case 'ACTIVE_REQUEST_EXISTS':
      return 'Sudah ada permintaan komplementer aktif untuk reservasi ini. Tunggu hingga permintaan saat ini diselesaikan.';
    case 'APPROVED_EXISTS':
      return 'Sudah ada komplementer yang disetujui untuk reservasi ini.';
    case 'SETTLEMENT_GUARD_PAYMENT':
      return 'Tidak dapat memproses karena pembayaran sudah selesai - komplementer tidak diperbolehkan setelah settlement.';
    case 'SETTLEMENT_GUARD_DEPOSIT':
      return 'Tidak dapat memproses karena deposit sudah digunakan untuk settlement.';
    case 'NO_ELIGIBLE_AMOUNT':
      return 'Tidak ada tagihan kamar yang memenuhi syarat untuk komplementer.';
    case 'INVALID_STATUS_TRANSITION':
      return 'Aksi tidak valid pada status permintaan saat ini.';
    case 'IDEMPOTENCY_KEY_CONFLICT':
      return 'Permintaan dengan kunci idempotensi yang sama sudah ada. Tidak membuat duplikat.';
    case 'ORIG_ENTRY_NOT_FOUND':
      return 'Catatan folio komplementer asli tidak ditemukan - pemutakhiran finansial gagal.';
    case 'FORBIDDEN':
      return 'Anda tidak memiliki izin untuk melakukan tindakan ini.';
    default:
      // Unknown code: show backend message verbatim (not generic fallback)
      return fallback;
  }
}

// ---------------------------------------------------------------------------
// Tipe Props
// ---------------------------------------------------------------------------

interface ComplimentaryActionModalProps {
  isOpen: boolean;
  onClose: () => void;
  action: Action;
  reservationId: number;
  propertyId: number;
  requestId?: number;
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onSuccess?: () => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ComplimentaryActionModal: React.FC<ComplimentaryActionModalProps> = ({
  isOpen,
  onClose,
  action,
  reservationId,
  propertyId,
  requestId,
  authFetch,
  onSuccess,
}) => {
  // -- Form state ----------------------------------------------------------
  const [category, setCategory] = useState<ComplimentaryCategory | ''>('');
  const [reason, setReason] = useState('');
  const [confirmMsg, setConfirmMsg] = useState('');

  // -- UI state ------------------------------------------------------------
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backendCode, setBackendCode] = useState<string | null>(null);
  // true = mutation backend definitif commit. Disable submit button setelah ini.
  // Jika onSuccess gagal, mutationCommitted TETAP true (mutation sudah sukses).
  const [mutationCommitted, setMutationCommitted] = useState(false);

  // -- Refs: bertahan lintang render, independen dari state async ------------
  const idempotencyKeyRef = useRef<string | null>(null);
  // Hash payload terakhir yang dipakai untuk generate key idempotensi REQUEST.
  // Disimpan di ref agar tidak terpengaruh stale closure atau setState batch.
  const lastPayloadHashRef = useRef<string | null>(null);

  // -- Reset state saat modal dibuka untuk action/context baru -------------
  React.useEffect(() => {
    if (!isOpen) return;
    setCategory('');
    setReason('');
    setConfirmMsg('');
    setError(null);
    setBackendCode(null);
    setSubmitting(false);
    setMutationCommitted(false);
    // Reset key idempotensi & payload hash ke konteks baru
    idempotencyKeyRef.current = null;
    lastPayloadHashRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, action, requestId, reservationId, propertyId]);

  // -- Validasi per action -------------------------------------------------
  const validate = (): string | null => {
    if (action === 'REQUEST') {
      if (!category) return 'Kategori wajib dipilih.';
      if (!reason.trim()) return 'Alasan wajib diisi.';
    }
    if ((action === 'REJECT' || action === 'REVOKE') && !confirmMsg.trim()) {
      return 'Alasan penolakan/pencabutan wajib diisi.';
    }
    if (
      (action === 'APPROVE' || action === 'REJECT' || action === 'REVOKE') &&
      !requestId
    ) {
      return `requestId diperlukan untuk aksi ${action}.`;
    }
    return null;
  };

  // -- Dapatkan key idempotensi sesuai lifecycle ---------------------------
  // - REQUEST dengan payload SAMA setelah failed mutation -> pakai key lama
  // - REQUEST dengan payload BERUBAH -> generate key baru
  // - APPROVE/REJECT/REVOKE -> tidak butuh key idempotensi
  function getIdempotencyKey(): string {
    if (action !== 'REQUEST') {
      return crypto.randomUUID(); // placeholder, tidak dipakai
    }
    const currentHash = `${category}:${reason.trim()}`;
    if (idempotencyKeyRef.current && currentHash === lastPayloadHashRef.current) {
      return idempotencyKeyRef.current; // pakai key lama
    }
    const key = crypto.randomUUID();
    idempotencyKeyRef.current = key;
    lastPayloadHashRef.current = currentHash;
    return key;
  }

  // -- Handler submit ------------------------------------------------------
  const handleSubmit = useCallback(async () => {
    // Defense-in-depth: double-submit protection
    if (submitting || mutationCommitted) return;

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    setBackendCode(null);

    try {
      setSubmitting(true);

      switch (action) {
        case 'REQUEST': {
          const idempotencyKey = getIdempotencyKey();
          await requestComplimentary(
            reservationId,
            propertyId,
            { category: category as ComplimentaryCategory, reason: reason.trim() },
            idempotencyKey,
            authFetch
          );
          break;
        }

        case 'APPROVE': {
          if (!requestId) {
            throw new Error('requestId diperlukan untuk aksi APPROVE.');
          }
          await approveComplimentaryRequest(
            reservationId,
            requestId,
            propertyId,
            authFetch
          );
          break;
        }

        case 'REJECT': {
          if (!requestId) {
            throw new Error('requestId diperlukan untuk aksi REJECT.');
          }
          await rejectComplimentaryRequest(
            reservationId,
            requestId,
            propertyId,
            { reason: confirmMsg.trim() },
            authFetch
          );
          break;
        }

        case 'REVOKE': {
          if (!requestId) {
            throw new Error('requestId diperlukan untuk aksi REVOKE.');
          }
          await revokeComplimentaryRequest(
            reservationId,
            requestId,
            propertyId,
            { reason: confirmMsg.trim() },
            authFetch
          );
          break;
        }
      }

      // Mutation backend definitif sukses
      idempotencyKeyRef.current = null;
      lastPayloadHashRef.current = null;
      setMutationCommitted(true);

      // Panggil onSuccess SEBELUM menutup modal - PISAH dari mutation catch
      if (onSuccess) {
        try {
          await onSuccess();
        } catch (refreshErr) {
          // Mutation sudah sukses, refresh gagal. Jangan reset mutationCommitted.
          setMutationCommitted(true); // pastikan tetap true
          setBackendCode(null);
          const refreshMsg =
            refreshErr instanceof Error ? refreshErr.message : undefined;
          setError(
            'Aksi komplementer sudah berhasil diproses, tetapi data tampilan gagal disegarkan. Tutup dan buka kembali detail reservasi.' +
              (refreshMsg ? ` ('${refreshMsg}')` : '')
          );
          return; // modal tetap terbuka, tombol submit tetap disabled
        }
      }

      onClose();
    } catch (err) {
      setSubmitting(false);

      if (err instanceof ComplimentaryApiError) {
        // Mutation failed: mutationCommitted tetap false, key idempotensi TETAP
        // tersimpan di ref agar retry dengan payload sama bisa pakai key lama.
        setBackendCode(err.backendCode);
        setError(mapBackendError(err.backendCode, err.message));
      } else if (err instanceof Error) {
        // Mutation failed (network or other): mutationCommitted = false
        setMutationCommitted(false);
        setError(err.message);
      } else {
        setMutationCommitted(false);
        setError(getFallbackMessage(action));
      }
    }
  }, [
    action,
    category,
    reason,
    confirmMsg,
    requestId,
    reservationId,
    propertyId,
    submitting,
    mutationCommitted,
    authFetch,
    onSuccess,
    onClose,
  ]);

  // -- Message UX fallback per action --------------------------------------
  function getFallbackMessage(a: Action): string {
    switch (a) {
      case 'REQUEST':
        return 'Permintaan komplementer gagal dibuat.';
      case 'APPROVE':
        return 'Persetujuan komplementer gagal.';
      case 'REJECT':
        return 'Penolakan komplementer gagal.';
      case 'REVOKE':
        return 'Pencabutan komplementer gagal.';
      default:
        return 'Operasi gagal.';
    }
  }

  // -- Render --------------------------------------------------------------
  const title = {
    REQUEST: 'Ajukan Komplementer',
    APPROVE: 'Setujui Komplementer',
    REJECT: 'Tolak Komplementer',
    REVOKE: 'Cabut Komplementer',
  }[action];

  const subtitle = {
    REQUEST: 'Buat permintaan komplementer baru untuk reservasi ini.',
    APPROVE: 'Backend akan membuat entri folio CREDIT otomatis.',
    REJECT: 'Resi akan tetap tercatat dengan status REJECTED.',
    REVOKE: 'Backend akan membuat entri REVERSAL di folio.',
  }[action];

  const footer = (
    <>
      <button
        type="button"
        onClick={onClose}
        disabled={submitting}
        className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer disabled:opacity-50"
      >
        Batal
      </button>
      <button
        type="button"
        onClick={handleSubmit}
        disabled={submitting || mutationCommitted}
        className={`rounded-lg px-4 py-2 text-sm font-bold text-white transition-colors cursor-pointer disabled:opacity-50 ${
          action === 'APPROVE'
            ? 'bg-emerald-700 hover:bg-emerald-600'
            : action === 'REVOKE'
            ? 'bg-amber-600 hover:bg-amber-500'
            : action === 'REJECT'
            ? 'bg-rose-600 hover:bg-rose-500'
            : 'bg-emerald-800 hover:bg-emerald-700'
        }`}
      >
        {submitting
          ? {
              REQUEST: 'Mengajukan...',
              APPROVE: 'Menyetujui...',
              REJECT: 'Menolak...',
              REVOKE: 'Mencabut...',
            }[action]
          : mutationCommitted
          ? 'Selesai'
          : {
              REQUEST: 'Ajukan Permintaan',
              APPROVE: 'Setujui',
              REJECT: 'Tolak',
              REVOKE: 'Cabut Komplementer',
            }[action]}
      </button>
    </>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      footer={footer}
      size="md"
    >
      {/* Error display */}
      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 whitespace-pre-line mb-4">
          {error}
          {backendCode && (
            <span className="block mt-1 text-[10px] opacity-70 font-mono">
              Error code: {backendCode}
            </span>
          )}
        </div>
      )}

      {/* REQUEST: category + reason */}
      {action === 'REQUEST' && (
        <div className="space-y-4">
          <label className="block text-xs font-bold text-stone-700">
            Kategori{' '}
            <span className="text-rose-500">*</span>
            <select
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as ComplimentaryCategory)
              }
              className="mt-1.5 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm"
              disabled={submitting}
            >
              <option value="">- Pilih kategori -</option>
              {CATEGORY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-bold text-stone-700">
            Alasan{' '}
            <span className="text-rose-500">*</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Jelaskan alasan komplementer..."
              rows={3}
              className="mt-1.5 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm resize-y"
              disabled={submitting}
            />
          </label>
        </div>
      )}

      {/* APPROVE: read-only request summary */}
      {action === 'APPROVE' && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
          <p className="font-bold">Konfirmasi Persetujuan</p>
          <p className="mt-1">
            Anda akan menyetujui permintaan komplementer pada reservasi#{' '}
            {reservationId}.
            Backend akan membuat entri folio CREDIT (DISCOUNT / COMPLIMENTARY)
            dan menghitung ulang finansial reservasi.
          </p>
        </div>
      )}

      {/* REJECT + REVOKE: reason */}
      {(action === 'REJECT' || action === 'REVOKE') && (
        <label className="block text-xs font-bold text-stone-700">
          {action === 'REJECT' ? 'Alasan Penolakan' : 'Alasan Pencabutan'}{' '}
          <span className="text-rose-500">*</span>
          <textarea
            value={confirmMsg}
            onChange={(e) => setConfirmMsg(e.target.value)}
            placeholder={
              action === 'REJECT'
                ? 'Jelaskan alasan penolakan...'
                : 'Jelaskan alasan pencabutan komplementer...'
            }
            rows={3}
            className="mt-1.5 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm resize-y"
            disabled={submitting}
          />
        </label>
      )}

      {/* Info note */}
      <div className="text-[11px] text-stone-500 bg-stone-100 rounded-lg p-2 mt-4">
        {action === 'REQUEST' && (
          <>
            <p className="font-semibold">Catatan:</p>
            <p>
              Permintaan ini akan masuk status PENDING_APPROVAL dan menunggu
              persetujuan dari staff berwenang.
            </p>
            <p className="mt-1 font-mono text-[10px]">
              Kunci idempotensi dihasilkan sekali per submit attempt.
              {submitting && ' Menghindari duplikasi jika terjadi retry jaringan.'}
            </p>
          </>
        )}
        {action === 'APPROVE' && (
          <>
            <p className="font-semibold">Catatan:</p>
            <p>
              Aksi ini bersifat final. Komplementer yang disetujui akan langsung
              memengaruhi tagihan reservasi.
            </p>
          </>
        )}
        {action === 'REJECT' && (
          <>
            <p className="font-semibold">Catatan:</p>
            <p>
              Permintaan akan berubah menjadi REJECTED. Record tetap tersimpan di
              riwayat.
            </p>
          </>
        )}
        {action === 'REVOKE' && (
          <>
            <p className="font-semibold">Peringatan Pencabutan:</p>
            <p className="text-amber-800">
              Mencabut komplementer akan membuat entri REVERSAL sebesar jumlah
              yang sebelumnya dikomplementerkan. Ini merupakan koreksi finansial,
              bukan penghapusan data.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
};
