import type { DailyKpiDrilldownData } from './calendarApi';
import { formatKpiClock, formatKpiStayRange, maintenanceSourceLabel } from './dailyKpiFormat';

export function DailyKpiDrilldownList({
  data,
  loading,
  error,
}: {
  data: DailyKpiDrilldownData | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return <div className="py-8 text-center text-xs text-slate-400">Memuat rincian KPI...</div>;
  }
  if (error) {
    return (
      <div className="py-8 text-center text-xs text-rose-600">
        {error}
      </div>
    );
  }
  if (!data || data.count === 0) {
    return (
      <div className="py-8 text-center text-xs text-slate-400">
        Tidak ada data untuk tanggal hotel ini.
      </div>
    );
  }

  const timeZone = data.timezone || 'Asia/Jakarta';

  if (data.type === 'occupancy') {
    return (
      <div className="space-y-1.5">
        {data.items.map((item) => (
          <div key={item.reservation_id} className="p-2.5 rounded-lg bg-slate-50/70 border border-slate-200/60 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold text-slate-900">{item.room_number ? `Kamar ${item.room_number}` : 'Belum Ditentukan'}</span>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${item.status === 'CHECKED_IN' ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-50 text-blue-800'}`}>
                {item.status || '-'}
              </span>
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">{item.room_type_name || '-'}</div>
            <div className="text-[11px] text-slate-700 mt-1">{item.guest_name || '-'}</div>
            <div className="flex items-center gap-2 mt-0.5 text-[11px] text-slate-500">
              <span>{item.bid || '-'}</span>
              <span>·</span>
              <span>{formatKpiStayRange(item.check_in, item.check_out)}</span>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (data.type === 'booked') {
    return (
      <div className="space-y-2">
        <div className="text-[11px] text-slate-500">
          {data.bookings} booking · {data.rooms} kamar
        </div>
        {data.groups.map((group) => (
          <details key={group.booking_id} className="rounded-lg bg-slate-50/70 border border-slate-200/60 text-xs" open={data.groups.length <= 4}>
            <summary className="p-2.5 cursor-pointer list-none">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-slate-900">{group.bid || '-'}</span>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-blue-50 text-blue-800">
                  {group.room_count} kamar
                </span>
              </div>
              <div className="text-[11px] text-slate-700 mt-1">{group.guest_name || '-'}</div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                Dibuat {formatKpiClock(group.created_at, timeZone)}
              </div>
            </summary>
            {group.children.length > 0 && (
              <div className="px-2.5 pb-2.5 space-y-1">
                {group.children.map((child) => (
                  <div key={child.reservation_id} className="flex items-center justify-between text-[11px] text-slate-600 bg-white/80 rounded px-2 py-1">
                    <span>{child.room_number ? `Kamar ${child.room_number}` : 'Belum Ditentukan'}</span>
                    <span>{child.status || '-'}</span>
                  </div>
                ))}
              </div>
            )}
          </details>
        ))}
      </div>
    );
  }

  if (data.type === 'checkin' || data.type === 'checkout') {
    return (
      <div className="space-y-1.5">
        {data.items.map((item) => {
          const stamp = data.type === 'checkin' ? item.checked_in_at : item.checked_out_at;
          return (
            <div key={item.reservation_id} className="p-2.5 rounded-lg bg-slate-50/70 border border-slate-200/60 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-slate-900">{item.room_number ? `Kamar ${item.room_number}` : 'Belum Ditentukan'}</span>
                <span className="text-[11px] font-semibold text-slate-600">{formatKpiClock(stamp, timeZone)}</span>
              </div>
              <div className="text-[11px] text-slate-700 mt-1">{item.guest_name || '-'}</div>
              <div className="text-[11px] text-slate-500 mt-0.5">{item.bid || '-'}</div>
            </div>
          );
        })}
      </div>
    );
  }

  if (data.type === 'dirty' || data.type === 'vacant_clean') {
    return (
      <div className="space-y-1.5">
        {data.items.map((item) => (
          <div key={item.room_id} className="p-2.5 rounded-lg bg-slate-50/70 border border-slate-200/60 text-xs flex items-center justify-between">
            <div>
              <span className="font-bold text-slate-900">{item.room_number || '-'}</span>
              <span className="text-slate-500 ml-2">{item.room_type_name || ''}</span>
            </div>
            {data.type === 'dirty' && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                {item.status || '-'}
              </span>
            )}
          </div>
        ))}
      </div>
    );
  }

  if (data.type === 'checkout_check') {
    return (
      <div className="space-y-1.5">
        {data.items.map((item) => (
          <div key={item.task_id} className="p-2.5 rounded-lg bg-slate-50/70 border border-slate-200/60 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold text-slate-900">{item.room_number ? `Kamar ${item.room_number}` : 'Belum Ditentukan'}</span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                {item.status || '-'}
              </span>
            </div>
            <div className="text-[11px] text-slate-700 mt-1">{item.guest_name || '-'}</div>
            <div className="text-[11px] text-slate-500 mt-0.5">{item.bid || item.task_number || '-'}</div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {data.items.map((item) => (
        <div key={item.room_id} className="p-2.5 rounded-lg bg-slate-50/70 border border-slate-200/60 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-bold text-slate-900">{item.room_number || '-'}</span>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-rose-100 text-rose-800">
              {maintenanceSourceLabel(item.from_room_status, item.from_operational_block)}
            </span>
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">{item.room_type_name || '-'}</div>
        </div>
      ))}
    </div>
  );
}

export default DailyKpiDrilldownList;
