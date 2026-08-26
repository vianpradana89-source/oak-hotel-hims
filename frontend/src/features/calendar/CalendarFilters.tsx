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
        <option value="Ready">Vacant Clean</option>
        <option value="Kotor">Vacant Dirty</option>
        <option value="Occupied">Occupied Clean</option>
        <option value="Maintenance">Out of Order / Service</option>
      </select>
      <label className="calendar-filter-check">
        <input type="checkbox" checked={props.includeInactive} onChange={(event) => props.onIncludeInactive(event.target.checked)} />
        Tampilkan Nonaktif
      </label>
    </div>
  );
}
