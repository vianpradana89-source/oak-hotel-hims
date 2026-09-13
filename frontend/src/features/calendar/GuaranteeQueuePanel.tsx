import { useCallback } from 'react';
import type { UnresolvedGuaranteeItem } from './calendarTypes';

interface Props {
  items: UnresolvedGuaranteeItem[];
  loading: boolean;
  error: string | null;
  propertyId: number | null;
  onOpenReservation: (reservationId: number) => void;
  onRetry?: () => void;
}

const STATUS_ORDER: Record<string, number> = {
  CHECKED_OUT: 1,
  CANCELLED: 2,
  CHECKED_IN: 3,
  BOOKED: 4,
  CONFIRMED: 4,
};

function formatStatusBadge(status: string): { label: string; className: string } {
  const s = String(status || '').toUpperCase();
  switch (s) {
    case 'CHECKED_OUT':
      return { label: 'Checked Out', className: 'guarantee-status--checked-out' };
    case 'CANCELLED':
      return { label: 'Dibatalkan', className: 'guarantee-status--cancelled' };
    case 'CHECKED_IN':
      return { label: 'Check-in', className: 'guarantee-status--checked-in' };
    case 'BOOKED':
    case 'CONFIRMED':
      return { label: 'Dipesan', className: 'guarantee-status--booked' };
    default:
      return { label: s, className: 'guarantee-status--other' };
  }
}

function formatGuaranteeLabel(item: UnresolvedGuaranteeItem): string {
  if (item.scope === 'BOOKING_GROUP') {
    const parts: string[] = [];
    if (item.unresolved_deposit_amount > 0) parts.push('Deposit Grup');
    if (item.identity_held) parts.push('KTP Grup');
    return parts.join(' + ') || '-';
  }
  const parts: string[] = [];
  if (item.unresolved_deposit_amount > 0) parts.push('Deposit Kamar');
  if (item.identity_held) parts.push('KTP Kamar');
  return parts.join(' + ') || '-';
}

function formatRoomDisplay(item: UnresolvedGuaranteeItem): string {
  if (item.scope === 'BOOKING_GROUP') {
    const count = item.room_count || 0;
    return count > 0 ? `Grup (${count} kamar)` : 'Grup';
  }
  const parts: string[] = [];
  if (item.room_number) parts.push(item.room_number);
  if (item.room_type_name) parts.push(item.room_type_name);
  return parts.length ? parts.join(' - ') : '-';
}

export default function GuaranteeQueuePanel({ items, loading, error, propertyId, onOpenReservation, onRetry }: Props) {
  const handleRetry = useCallback(() => {
    if (onRetry) onRetry();
  }, [onRetry]);

  const sortedItems = [...items].sort((a, b) => {
    const aOrder = STATUS_ORDER[a.reservation_status] ?? 99;
    const bOrder = STATUS_ORDER[b.reservation_status] ?? 99;
    if (aOrder !== bOrder) return aOrder - bOrder;
    if (a.last_activity_at && b.last_activity_at) {
      return new Date(a.last_activity_at).getTime() - new Date(b.last_activity_at).getTime();
    }
    if (a.last_activity_at) return -1;
    if (b.last_activity_at) return 1;
    return 0;
  });

  if (loading) {
    return (
      <div className="guarantee-queue-panel">
        <div className="guarantee-queue-panel__header">
          <span className="guarantee-queue-panel__title">Jaminan Belum Selesai</span>
          <span className="guarantee-queue-panel__subtitle">Memuat...</span>
        </div>
        <div className="guarantee-queue-panel__loading">
          <span className="guarantee-queue-spinner" aria-hidden="true"></span>
          Memuat data jaminan...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="guarantee-queue-panel">
        <div className="guarantee-queue-panel__header">
          <span className="guarantee-queue-panel__title">Jaminan Belum Selesai</span>
          <span className="guarantee-queue-panel__subtitle">Gagal memuat</span>
        </div>
        <div className="guarantee-queue-panel__error">
          <span>{error}</span>
          {onRetry && (
            <button type="button" className="guarantee-queue-retry" onClick={handleRetry}>
              Coba Lagi
            </button>
          )}
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="guarantee-queue-panel">
        <div className="guarantee-queue-panel__header">
          <span className="guarantee-queue-panel__title">Jaminan Belum Selesai</span>
          <span className="guarantee-queue-panel__subtitle">Semua jaminan sudah selesai.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="guarantee-queue-panel">
      <div className="guarantee-queue-panel__header">
        <span className="guarantee-queue-panel__title">Jaminan Belum Selesai</span>
        <span className="guarantee-queue-panel__subtitle">{items.length} item membutuhkan tindak lanjut</span>
      </div>
      <div className="guarantee-queue-panel__table-wrap">
        <table className="guarantee-queue-table">
          <thead>
            <tr>
              <th className="guarantee-col-status">Status</th>
              <th className="guarantee-col-bid">BID</th>
              <th className="guarantee-col-guest">Tamu</th>
              <th className="guarantee-col-room">Kamar / Grup</th>
              <th className="guarantee-col-guarantee">Jaminan</th>
              <th className="guarantee-col-outstanding">Outstanding</th>
              <th className="guarantee-col-res-status">Status Reservasi</th>
              <th className="guarantee-col-action">Aksi</th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.map((item) => {
              const statusBadge = formatStatusBadge(item.reservation_status);
              const canOpen = propertyId !== null && item.anchor_reservation_id != null;
              return (
                <tr key={`${item.scope}-${item.anchor_reservation_id}-${item.booking_id}`} className="guarantee-row">
                  <td className="guarantee-col-status">
                    <span className={`guarantee-status ${statusBadge.className}`}>
                      {statusBadge.label}
                    </span>
                  </td>
                  <td className="guarantee-col-bid">{item.bid}</td>
                  <td className="guarantee-col-guest">{item.guest_name || '-'}</td>
                  <td className="guarantee-col-room">{formatRoomDisplay(item)}</td>
                  <td className="guarantee-col-guarantee">{formatGuaranteeLabel(item)}</td>
                  <td className="guarantee-col-outstanding">
                    {item.unresolved_deposit_amount > 0
                      ? new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(item.unresolved_deposit_amount)
                      : '-'}
                  </td>
                  <td className="guarantee-col-res-status">
                    <span className={`guarantee-res-status ${statusBadge.className}`}>{item.reservation_status}</span>
                  </td>
                  <td className="guarantee-col-action">
                    {canOpen ? (
                      <button
                        type="button"
                        className="guarantee-action-btn"
                        onClick={() => onOpenReservation(Number(item.anchor_reservation_id))}
                        aria-label={`Lihat detail ${item.bid}`}
                      >
                        Lihat Detail
                      </button>
                    ) : (
                      <span className="guarantee-action-none">-</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
