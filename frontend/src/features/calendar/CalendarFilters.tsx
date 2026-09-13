import type { CalendarOperationalFilter } from './calendarTypes';

interface IdentityOption {
  id: number;
  label: string;
}

interface Props {
  roomSearch: string;
  roomCategoryId: string;
  roomTypeId: string;
  operationalStatus: CalendarOperationalFilter;
  includeInactive: boolean;
  categoryOptions: IdentityOption[];
  typeOptions: IdentityOption[];
  onRoomSearch: (value: string) => void;
  onRoomCategoryId: (value: string) => void;
  onRoomTypeId: (value: string) => void;
  onOperationalStatus: (value: CalendarOperationalFilter) => void;
  onIncludeInactive: (value: boolean) => void;
  showUnresolvedGuarantees?: boolean;
  onToggleUnresolvedGuarantees?: (value: boolean) => void;
  unresolvedGuaranteeCount?: number;
  unresolvedGuaranteeLoading?: boolean;
}

export default function CalendarFilters(props: Props) {
  return (
    <div className="calendar-filter-row">
      <input
        type="search"
        value={props.roomSearch}
        onChange={(event) => props.onRoomSearch(event.target.value)}
        placeholder="Nomor kamar"
        aria-label="Cari nomor kamar"
      />
      <select
        value={props.roomCategoryId}
        onChange={(event) => props.onRoomCategoryId(event.target.value)}
        aria-label="Filter kategori kamar"
      >
        <option value="">Semua kategori kamar</option>
        {props.categoryOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      <select value={props.roomTypeId} onChange={(event) => props.onRoomTypeId(event.target.value)} aria-label="Filter tipe kamar">
        <option value="">Semua tipe kamar</option>
        {props.typeOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      <select
        value={props.operationalStatus}
        onChange={(event) => props.onOperationalStatus(event.target.value as CalendarOperationalFilter)}
        aria-label="Filter status operasional"
      >
        <option value="">Semua status operasional</option>
        <option value="Ready">Vacant Clean (Siap)</option>
        <option value="Cleaning">Cleaning (Dibersihkan)</option>
        <option value="Kotor">Vacant Dirty (Kotor)</option>
        <option value="Occupied">Occupied (Terisi)</option>
        <option value="Maintenance">Out of Order / Service</option>
      </select>
      <label className="calendar-filter-check">
        <input type="checkbox" checked={props.includeInactive} onChange={(event) => props.onIncludeInactive(event.target.checked)} />
        Tampilkan Nonaktif
      </label>
      {props.onToggleUnresolvedGuarantees != null && (() => {
        const toggle = props.onToggleUnresolvedGuarantees;
        return (
          <button
            type="button"
            className={`calendar-guarantee-toggle ${props.showUnresolvedGuarantees ? 'calendar-guarantee-toggle--active' : ''}`}
            onClick={() => toggle(!props.showUnresolvedGuarantees)}
            disabled={props.unresolvedGuaranteeLoading}
            aria-pressed={props.showUnresolvedGuarantees || false}
            aria-label="Tampilkan jaminan belum selesai"
            title="Tampilkan jaminan belum selesai"
          >
            <svg className="calendar-guarantee-shield" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 12l2 2 4-4m5.618-4.016A1.95 1.95 0 012 2.94a1.95 1.95 0 018.618 3.04A12.02 12.02 0 03 9 20.591c-.627 0-1.196-.11-1.732-.32L3.34 16c-.77-1.333.192-3 1.732-3 .567 0 1.103.166 1.56.454L9 12z" />
            </svg>
            <span>Jaminan Belum Selesai</span>
            {((props.unresolvedGuaranteeCount ?? 0) > 0) && (
              <span className="calendar-guarantee-badge">{props.unresolvedGuaranteeCount}</span>
            )}
          </button>
        );
      })()}
    </div>
  );
}
