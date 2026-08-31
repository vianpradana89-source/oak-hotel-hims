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
  onOpen: (event: React.MouseEvent<HTMLDivElement>) => void;
  onResize: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

export default function ReservationBar(props: Props) {
  const reservation = props.reservation;
  const turnover = props.turnoverInfo;
  const outgoingClearance = turnover?.outgoing_clearance;
  const isShortSpan = props.span <= 2;

  return (
    <td colSpan={props.span} className="p-1 border align-middle h-14">
      <div
        draggable
        onDragStart={props.onDragStart}
        onDragEnd={props.onDragEnd}
        onClick={(e) => props.onOpen(e)}
        className={`reservation-card relative overflow-hidden ${props.cardClass} reservation-card--${props.density} ${props.searchMatch ? 'reservation-card--match' : 'reservation-card--dim'} cursor-pointer font-semibold shadow-xs hover:shadow-sm transition-shadow`}
      >
        <div className="reservation-card-stack">
          <div className="reservation-card-topline flex-wrap items-center gap-1">
            {/* Arrival starting-edge indicator on longer stays */}
            {!isShortSpan && (
              <span
                className="inline-flex items-center text-[10px] font-extrabold text-sky-900 bg-sky-100/90 px-1.5 py-0.5 rounded border border-sky-300/80 shadow-2xs select-none shrink-0"
                title={`Check-in: ${reservation.check_in}`}
              >
                ARR ↘
              </span>
            )}

            <div className="reservation-card-name truncate font-bold text-stone-900">{reservation.guest_name}</div>
            {reservation.stay_type === 'DAY_USE' && (
              <span
                className="inline-flex items-center text-[10px] font-extrabold text-purple-900 bg-purple-100/90 px-1.5 py-0.5 rounded border border-purple-300 shadow-2xs shrink-0 select-none"
                title={`Day Use Transit: ${reservation.start_at ? new Date(reservation.start_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '10:00'} - ${reservation.end_at ? new Date(reservation.end_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '16:00'}`}
              >
                ⚡ DAY USE
              </span>
            )}
            {props.badge && !isShortSpan && <span className={`${props.badgeClass} shrink-0 text-[10px]`}>{props.badge}</span>}
            {props.segmentMeta?.label && !isShortSpan && <span className={`${props.segmentMeta.className} shrink-0 text-[10px]`}>{props.segmentMeta.label}</span>}

            {/* Outgoing Checkout HK Clearance Indicator */}
            {outgoingClearance && outgoingClearance.clearance_state === 'CLEAR' && !isShortSpan && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded font-semibold inline-flex items-center gap-0.5 bg-emerald-50 text-emerald-800 border border-emerald-300/80 shadow-2xs shrink-0"
                title="HK CLEAR: Pemeriksaan kamar checkout bersih"
              >
                ✓ Clear
              </span>
            )}
            {outgoingClearance && outgoingClearance.clearance_state === 'ISSUE_FOUND' && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded font-bold inline-flex items-center gap-0.5 bg-rose-50 text-rose-800 border border-rose-300/80 shadow-2xs shrink-0"
                title={`HK ISSUE: ${outgoingClearance.issue_note || 'Ada temuan tagihan / kerusakan kamar'}`}
              >
                ⚠ Issue
              </span>
            )}
            {outgoingClearance && (outgoingClearance.clearance_state === 'REQUESTED' || outgoingClearance.clearance_state === 'INSPECTING') && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded font-semibold inline-flex items-center gap-0.5 bg-amber-50 text-amber-800 border border-amber-300/80 shadow-2xs shrink-0"
                title="HK CEK: Pemeriksaan kamar sedang berlangsung"
              >
                ⏳ Cek
              </span>
            )}

            {/* Incoming Room Readiness Indicator */}
            {turnover?.has_turnover && (
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded font-semibold inline-flex items-center gap-0.5 shadow-2xs shrink-0 ${
                  turnover.is_ready === false
                    ? 'bg-amber-50 text-amber-900 border border-amber-300/80'
                    : 'bg-emerald-50 text-emerald-900 border border-emerald-300/80'
                }`}
                title={turnover.reason_message || (turnover.is_ready === false ? 'Turnover: Kamar belum siap untuk check-in' : 'Turnover: Kamar siap huni')}
              >
                {turnover.is_ready === false ? '⚠ Not Ready' : '✓ Ready'}
              </span>
            )}
          </div>
          <div className="reservation-card-identity truncate text-xs text-stone-600">{props.identity}</div>
          <div className="reservation-card-meta text-xs">
            <span>{reservation.stay_type === 'DAY_USE' ? 'Day Use' : `${props.nights} malam`}</span>
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
