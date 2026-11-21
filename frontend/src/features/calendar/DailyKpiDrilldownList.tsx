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
  if (
    !data ||
    (data.count === 0 &&
      !(data.type === 'checkout' && (data.checkout_check_items?.length ?? 0) > 0))
  ) {
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
                Dibuat {formatKpiClock(group.created_at, timeZone)}{group.created_by ? ` • oleh ${group.created_by}` : ''}
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

  if (data.type === 'checkin') {
    return (
      <div className="space-y-1.5">
        {data.items.map((item) => (
          <div key={item.reservation_id} className="p-2.5 rounded-lg bg-slate-50/70 border border-slate-200/60 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold text-slate-900">{item.room_number ? `Kamar ${item.room_number}` : 'Belum Ditentukan'}</span>
              <span className="text-[11px] font-semibold text-slate-600">{formatKpiClock(item.checked_in_at, timeZone)}</span>
            </div>
            <div className="text-[11px] text-slate-700 mt-1">{item.guest_name || '-'}</div>
            <div className="text-[11px] text-slate-500 mt-0.5">{item.bid || '-'}</div>
          </div>
        ))}
      </div>
    );
  }

  if (data.type === 'checkout') {
    const chkItems = data.checkout_check_items || [];
    return (
      <div className="space-y-4">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-amber-800 bg-amber-50/80 border border-amber-200 px-2.5 py-1.5 rounded-lg">
            <span>Checkout Check (Pemeriksaan Kamar)</span>
            <span className="px-1.5 py-0.5 rounded bg-amber-200/70 text-amber-900 text-[10px]">
              {chkItems.length} pending
            </span>
          </div>
          {chkItems.length === 0 ? (
            <div className="p-2.5 rounded-lg bg-slate-50/50 border border-slate-200/60 text-[11px] text-slate-400 text-center">
              Tidak ada pemeriksaan kamar check-out yang pending.
            </div>
          ) : (
            chkItems.map((item) => (
              <div key={item.task_id} className="p-2.5 rounded-lg bg-amber-50/40 border border-amber-200/80 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-slate-900">{item.room_number ? `Kamar ${item.room_number}` : 'Belum Ditentukan'}</span>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                    {item.status || '-'}
                  </span>
                </div>
                <div className="text-[11px] text-slate-700 mt-1">{item.guest_name || '-'}</div>
                <div className="text-[11px] text-slate-500 mt-0.5">{item.bid || item.task_number || '-'}</div>
              </div>
            ))
          )}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-slate-700 bg-slate-100 px-2.5 py-1.5 rounded-lg">
            <span>Tamu Check-out Hari Ini</span>
            <span className="px-1.5 py-0.5 rounded bg-white text-slate-800 text-[10px]">
              {data.items.length} kamar
            </span>
          </div>
          {data.items.length === 0 ? (
            <div className="p-2.5 rounded-lg bg-slate-50/50 border border-slate-200/60 text-[11px] text-slate-400 text-center">
              Belum ada kamar yang selesai check-out hari ini.
            </div>
          ) : (
            data.items.map((item) => (
              <div key={item.reservation_id} className="p-2.5 rounded-lg bg-slate-50/70 border border-slate-200/60 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-slate-900">{item.room_number ? `Kamar ${item.room_number}` : 'Belum Ditentukan'}</span>
                  <span className="text-[11px] font-semibold text-slate-600">{formatKpiClock(item.checked_out_at, timeZone)}</span>
                </div>
                <div className="text-[11px] text-slate-700 mt-1">{item.guest_name || '-'}</div>
                <div className="text-[11px] text-slate-500 mt-0.5">{item.bid || '-'}</div>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  if (data.type === 'available_rooms') {
    const groups = data.by_room_type || [];
    return (
      <div className="space-y-3">
        <div className="p-2.5 rounded-lg bg-emerald-50/70 border border-emerald-200/80 text-[11px] text-emerald-900">
          Kamar tersedia mencakup kamar <b>Vacant Clean / Inspected</b> dan <b>Kamar Kotor (Vacant Dirty)</b>. Kamar <b>OO / OOS</b> tidak dihitung.
        </div>
        {groups.map((grp) => (
          <div key={`${grp.room_type_id ?? 'other'}-${grp.room_type_name}`} className="rounded-xl border border-slate-200 bg-slate-50/60 overflow-hidden text-xs">
            <div className="px-3 py-2 bg-white border-b border-slate-200/80 flex items-center justify-between gap-2">
              <div>
                <div className="font-bold text-slate-900">{grp.room_type_name}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  Siap: <b className="text-emerald-700">{grp.clean_count}</b> · Kotor: <b className="text-amber-700">{grp.dirty_count}</b>
                </div>
              </div>
              <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-900 border border-emerald-200">
                {grp.available_count} kamar
              </span>
            </div>
            <div className="p-2.5 flex flex-wrap gap-1.5">
              {grp.rooms.map((rm) => {
                const st = String(rm.status || '').toUpperCase();
                const isClean = st === 'VACANT_CLEAN' || st === 'INSPECTED';
                return (
                  <span
                    key={rm.room_id}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold border ${
                      isClean
                        ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                        : 'bg-amber-50 text-amber-800 border-amber-200'
                    }`}
                    title={st}
                  >
                    <span className="font-mono font-bold">{rm.room_number}</span>
                    <span className="text-[9px] opacity-80">({isClean ? 'Ready' : 'Kotor'})</span>
                  </span>
                );
              })}
            </div>
          </div>
        ))}
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
