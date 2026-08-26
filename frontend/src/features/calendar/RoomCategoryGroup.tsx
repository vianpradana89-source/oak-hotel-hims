import type { RoomCategoryCalendarGroup } from './calendarTypes';

interface Props {
  group: RoomCategoryCalendarGroup;
  collapsed: boolean;
  columnCount: number;
  onToggle: () => void;
}

export default function RoomCategoryGroup({ group, collapsed, columnCount, onToggle }: Props) {
  return (
    <tr className="calendar-category-group-row">
      <td colSpan={columnCount}>
        <button
          type="button"
          className="calendar-category-group-toggle"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <span className="calendar-group-chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
          <span className="calendar-category-group-name">{group.name}</span>
          {group.code && <span className="calendar-category-group-code">{group.code}</span>}
          {group.active === false && <span className="calendar-category-inactive">Kategori nonaktif</span>}
          <span className="calendar-category-group-count">{group.roomCount} kamar fisik</span>
        </button>
      </td>
    </tr>
  );
}
