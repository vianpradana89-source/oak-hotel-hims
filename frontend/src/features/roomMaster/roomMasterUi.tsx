import type { ReactNode } from 'react';
import { OPERATIONAL_STATUS_LABELS } from './roomMasterTypes';

export function MasterStatusBadge({ active }: { active: boolean }) {
  return (
    <span className={`rm-badge ${active ? 'rm-badge--active' : 'rm-badge--inactive'}`}>
      {active ? 'Aktif' : 'Nonaktif'}
    </span>
  );
}

export function OperationalStatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="rm-badge rm-badge--ops">—</span>;
  const normalized = String(status).toUpperCase();
  const cls = normalized.includes('CLEAN') && normalized.includes('OCCUPIED')
    ? 'rm-badge--occupied'
    : normalized === 'VACANT_CLEAN' || normalized.startsWith('OCCUPIED_CLEAN')
      ? 'rm-badge--ready'
      : normalized.includes('DIRTY')
        ? 'rm-badge--dirty'
        : normalized.includes('OUT_OF')
          ? 'rm-badge--maintenance'
          : 'rm-badge--ops';
  const label = OPERATIONAL_STATUS_LABELS[normalized] || normalized;
  return <span className={`rm-badge ${cls}`}>{label}</span>;
}

export function LoadingState({ label = 'Memuat data…' }: { label?: string }) {
  return <div className="rm-state">{label}</div>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rm-state">
      <div className="rm-state-title">Gagal memuat data</div>
      <div>{message}</div>
      <div style={{ marginTop: 10 }}>
        <button type="button" className="rm-btn rm-btn--secondary" onClick={onRetry}>
          Coba Lagi
        </button>
      </div>
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="rm-state">
      <div className="rm-state-title">{title}</div>
      {hint && <div>{hint}</div>}
    </div>
  );
}

const KNOWN_ERROR_MESSAGES: Record<string, string> = {
  ROOM_TYPE_CODE_EXISTS: 'Kode tipe kamar sudah dipakai di properti ini.',
  CAPACITY_BELOW_RESERVED: 'Kapasitas tidak boleh di bawah jumlah kamar yang sudah direservasi.',
  TYPE_HAS_ACTIVE_ROOMS: 'Tipe masih memiliki kamar fisik aktif — nonaktifkan kamar terlebih dahulu.',
  ROOM_NUMBER_EXISTS: 'Nomor kamar sudah digunakan di properti ini.',
  ROOM_TYPE_INACTIVE: 'Tipe kamar sedang tidak aktif.',
  ROOM_HAS_ACTIVE_RESERVATIONS: 'Kamar masih memiliki reservasi aktif (BOOKED / CHECKED_IN).',
  CAPACITY_CONFLICT: 'Perubahan akan membuat kapasitas aktif di bawah reservasi yang sudah ada.',
  ROOM_MASTER_INACTIVE: 'Data room master tidak aktif.',
  VALIDATION_ERROR: 'Validasi gagal.',
  NOT_FOUND: 'Data tidak ditemukan.'
};

export function describeApiError(err: unknown): { code: string; message: string } {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = String((err as { code: unknown }).code);
    const rawMessage = err instanceof Error ? err.message : 'Terjadi kesalahan tak terduga.';
    const known = KNOWN_ERROR_MESSAGES[code];
    return {
      code,
      message: known ? `${known} (${rawMessage})` : rawMessage
    };
  }
  return {
    code: 'UNKNOWN_ERROR',
    message: err instanceof Error ? err.message : 'Terjadi kesalahan tak terduga.'
  };
}
