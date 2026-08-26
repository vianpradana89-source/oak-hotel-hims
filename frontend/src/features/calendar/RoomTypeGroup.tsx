import type { RoomTypeCalendarGroup } from './calendarTypes';

interface Props {
  group: RoomTypeCalendarGroup;
  collapsed: boolean;
  columnCount: number;
  onToggle: () => void;
}

export default function RoomTypeGroup({ group, collapsed, columnCount, onToggle }: Props) {
  const label = group.code && group.code !== group.name ? `${group.name} (${group.code})` : group.name;
  return (
    <tr className="calendar-type-group-row">
      <td colSpan={columnCount}>
        <button type="button" className="calendar-type-group-toggle" aria-expanded={!collapsed} onClick={onToggle}>
          <span className="calendar-group-chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
          <span>{label}</span>
          <span className="calendar-type-group-count">{group.rooms.length} kamar</span>
        </button>
      </td>
    </tr>
  );
}
