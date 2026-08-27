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
  onDragStart: (event: any) => void;
  onDragEnd: (event: any) => void;
  onOpen: () => void;
  onResize: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

export default function ReservationBar(props: Props) {
  const reservation = props.reservation;
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
          <div className="reservation-card-topline">
            <div className="reservation-card-name">{reservation.guest_name}</div>
            <span className={props.badgeClass}>{props.badge}</span>
            <span className={props.segmentMeta.className}>{props.segmentMeta.label}</span>
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
