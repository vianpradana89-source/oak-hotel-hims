import type { PointerEvent as ReactPointerEvent } from 'react';

interface Props {
  reservation: any;
  span: number;
  density: string;
  cardClass: string;
  badge: string;
  badgeClass: string;
  paymentLabel: string;
  segmentMeta: { className: string; label: string };
  identity: string;
  statusLabel: string;
  legacy: boolean;
  resizable: boolean;
  searchMatch: boolean;
  nights: number;
  turnoverInfo?: {
    has_turnover: boolean;
    is_ready?: boolean;
    reason_message?: string | null;
    outgoing_clearance?: {
      clearance_state: 'CLEAR' | 'ISSUE_FOUND' | 'REQUESTED' | 'INSPECTING' | 'NO_CHECK';
      inspection_result?: string | null;
      issue_type?: string | null;
      issue_note?: string | null;
      estimated_charge?: number | null;
    } | null;
  } | null;
  onDragStart: (event: any) => void;
  onDragEnd: (event: any) => void;
  onOpen: () => void;
  onResize: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

export default function ReservationBar(props: Props) {
  const reservation = props.reservation;
  const turnover = props.turnoverInfo;
  const outgoingClearance = turnover?.outgoing_clearance;

  return (
    <td colSpan={props.span} className="p-2 border align-middle h-14">
      <div
        draggable
        onDragStart={props.onDragStart}
        onDragEnd={props.onDragEnd}
        onClick={props.onOpen}
        className={`reservation-card relative overflow-hidden ${props.cardClass} reservation-card--${props.density} ${props.searchMatch ? 'reservation-card--match' : 'reservation-card--dim'} cursor-pointer font-semibold`}
      >
        <div className="reservation-card-stack">
          <div className="reservation-card-topline flex-wrap gap-1">
            <div className="reservation-card-name">{reservation.guest_name}</div>
            <span className={props.badgeClass}>{props.badge}</span>
            <span className={props.segmentMeta.className}>{props.segmentMeta.label}</span>

            {/* Outgoing Checkout HK Clearance Indicator */}
            {outgoingClearance && outgoingClearance.clearance_state === 'CLEAR' && (
              <span
                className="text-[9px] px-1.5 py-0.2 rounded-sm font-bold uppercase tracking-wider inline-flex items-center gap-0.5 bg-emerald-100 text-emerald-800 border border-emerald-300 shadow-2xs"
                title="HK CLEAR: Pemeriksaan kamar checkout bersih & bebas tanggungan"
              >
                ✓ HK CLEAR
              </span>
            )}
            {outgoingClearance && outgoingClearance.clearance_state === 'ISSUE_FOUND' && (
              <span
                className="text-[9px] px-1.5 py-0.2 rounded-sm font-bold uppercase tracking-wider inline-flex items-center gap-0.5 bg-rose-100 text-rose-800 border border-rose-300 shadow-2xs"
                title={`HK ISSUE: ${outgoingClearance.issue_note || 'Ada temuan tagihan / kerusakan kamar'}`}
              >
                ⚠ HK ISSUE
              </span>
            )}
            {outgoingClearance && (outgoingClearance.clearance_state === 'REQUESTED' || outgoingClearance.clearance_state === 'INSPECTING') && (
              <span
                className="text-[9px] px-1.5 py-0.2 rounded-sm font-bold uppercase tracking-wider inline-flex items-center gap-0.5 bg-amber-100 text-amber-800 border border-amber-300 shadow-2xs"
                title="HK CEK: Pemeriksaan kamar sedang berlangsung oleh crew"
              >
                ⏳ HK CEK
              </span>
            )}

            {/* Incoming Room Readiness Indicator */}
            {turnover?.has_turnover && (
              <span
                className={`text-[9px] px-1.5 py-0.2 rounded-sm font-bold uppercase tracking-wider inline-flex items-center gap-0.5 shadow-2xs ${
                  turnover.is_ready === false
                    ? 'bg-amber-100 text-amber-900 border border-amber-300'
                    : 'bg-emerald-100 text-emerald-900 border border-emerald-300'
                }`}
                title={turnover.reason_message || (turnover.is_ready === false ? 'Turnover: Kamar belum siap untuk check-in' : 'Turnover: Kamar siap huni')}
              >
                {turnover.is_ready === false ? '⚠ NOT READY' : '✓ READY'}
              </span>
            )}
          </div>
          <div className="reservation-card-identity">{props.identity}</div>
          <div className="reservation-card-meta">
            <span>{props.nights} malam</span>
            <span>{props.statusLabel}{props.legacy ? ' · LEGACY' : ''}</span>
            {props.paymentLabel && <span>{props.paymentLabel}</span>}
          </div>
        </div>
        {props.resizable && (
          <button
            type="button"
            draggable={false}
            className="reservation-card-resize-handle absolute right-0 top-0 bottom-0"
            aria-label={`Resize ${reservation.guest_name}`}
            onDragStart={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onPointerDown={props.onResize}
            onClick={(event) => event.stopPropagation()}
          />
        )}
      </div>
    </td>
  );
}
