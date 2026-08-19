import { useEffect, useMemo, useState } from 'react';

function buildWeekDays(anchorDate = new Date(), todayIndex = 2, windowSize = 7) {
  // Build a windowSize-day window where the anchorDate is positioned at index `todayIndex` (0-based)
  // so that "today" appears at the requested column
  const anchor = new Date(anchorDate);
  anchor.setHours(0, 0, 0, 0);

  const start = new Date(anchor);
  start.setDate(anchor.getDate() - todayIndex);

  const labelsByDay: Record<number,string> = { 0: 'MIN', 1: 'SEN', 2: 'SEL', 3: 'RAB', 4: 'KAM', 5: 'JUM', 6: 'SAB' };

  return Array.from({ length: windowSize }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    // local YYYY-MM-DD
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const iso = `${y}-${m}-${d}`;
    const weekday = date.getDay();
    return {
      label: labelsByDay[weekday] || String(weekday),
      date: iso,
      raw: date
    };
  });
}

function localDateISO(value: Date | string | undefined) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function App() {
  const [reservations, setReservations] = useState<any[]>([]);
  const [rooms, setRooms] = useState<any[]>([]);
  const [selectedRes, setSelectedRes] = useState<any>(null);
  const [roomStatuses, setRoomStatuses] = useState<Record<string, string>>({});
  const [housekeepingTasks, setHousekeepingTasks] = useState<any[]>([]);
  const [maintenanceTasks, setMaintenanceTasks] = useState<any[]>([]);
  const [posOrders, setPosOrders] = useState<any[]>([]);
  const [posMenu, setPosMenu] = useState<any[]>([]);
  const [financeSummary, setFinanceSummary] = useState<any>(null);
  const [guestProfiles, setGuestProfiles] = useState<any[]>([]);
  const [employees, setEmployees] = useState<any[]>([]);
  const [payroll, setPayroll] = useState<any[]>([]);
  const [selectedMenu, setSelectedMenu] = useState<'Kalender' | 'Transaksi' | 'Laporan' | 'Produk & Inventori' | 'Pelanggan' | 'Pengaturan'>('Kalender');
  // Anchor date for the grid window and handlers to shift the window
  const [anchorDate, setAnchorDate] = useState<Date>(new Date());
  const [windowSize, setWindowSize] = useState<number>(7);
  const [isMonthView, setIsMonthView] = useState<boolean>(false);
  const [calendarOpen, setCalendarOpen] = useState<boolean>(false);
  const [calendarViewDate, setCalendarViewDate] = useState<Date>(new Date());
  const [calendarSelectedDate, setCalendarSelectedDate] = useState<string | null>(localDateISO(new Date()));
  const [selectedRange, setSelectedRange] = useState<{start?: string, end?: string}>({});
  const [createResOpen, setCreateResOpen] = useState<boolean>(false);
  const [prefillRoomId, setPrefillRoomId] = useState<number | null>(null);
  const days = useMemo(() => {
    if (isMonthView) {
      // build month days starting from anchorDate (which should be first of month)
      const d = new Date(anchorDate);
      const y = d.getFullYear();
      const m = d.getMonth();
      const last = new Date(y, m + 1, 0).getDate();
      return Array.from({ length: last }, (_, i) => {
        const dt = new Date(y, m, i + 1);
        const y2 = dt.getFullYear();
        const mo = String(dt.getMonth() + 1).padStart(2, '0');
        const da = String(dt.getDate()).padStart(2, '0');
        const iso = `${y2}-${mo}-${da}`;
        const labelsByDay: Record<number,string> = { 0: 'MIN', 1: 'SEN', 2: 'SEL', 3: 'RAB', 4: 'KAM', 5: 'JUM', 6: 'SAB' };
        return { label: labelsByDay[dt.getDay()] || String(dt.getDay()), date: iso, raw: dt };
      });
    }
    return buildWeekDays(anchorDate, 2, windowSize);
  }, [anchorDate, windowSize, isMonthView]);

  const shiftDays = (delta: number) => {
    setAnchorDate((prev) => {
      const d = new Date(prev);
      d.setDate(d.getDate() + delta);
      return d;
    });
  };
  const goToday = () => setAnchorDate(new Date());

  // drag preview using setDragImage + cleanup element
  const handleDragStart = (e: any, r: any, fromRoomId: any) => {
    try {
      e.dataTransfer.setData('reservation-id', String(r.id));
      e.dataTransfer.setData('from-room-id', String(fromRoomId));
      (e.currentTarget as any)?.classList?.add('dragging');
      // build drag image
      const img = document.createElement('div');
      img.className = 'reservation-drag-image';
      img.style.position = 'absolute';
      img.style.top = '-1000px';
      img.style.left = '-1000px';
      img.style.padding = '8px 10px';
      img.style.background = window.getComputedStyle(e.currentTarget).background || '#fff';
      img.style.borderRadius = '8px';
      img.style.boxShadow = '0 4px 12px rgba(0,0,0,0.12)';
      img.style.color = '#111';
      img.innerText = String(r.guest_name).slice(0, 24);
      document.body.appendChild(img);
      // small offset
      try { e.dataTransfer.setDragImage(img, 20, 10); } catch (err) { /* ignore */ }
      // store element reference to remove later
      (e.currentTarget as any)._dragImageEl = img;
    } catch (err) { /* ignore */ }
  };
  const handleDragEnd = (e: any) => {
    try {
      (e.currentTarget as any)?.classList?.remove('dragging');
      const img = (e.currentTarget as any)?._dragImageEl;
      if (img && img.parentNode) img.parentNode.removeChild(img);
    } catch (err) { }
  };

  const reservationSpans = useMemo(() => {
    const map: Record<string, Array<any>> = {};
    for (const r of reservations) {
      const roomId = String(r.room_id);
      const ci = localDateISO(r.check_in);
      const co = localDateISO(r.check_out);
      const startIndex = days.findIndex(d => d.date === ci);
      const endIndex = days.findIndex(d => d.date === co);
      // If the reservation does not overlap this window, skip
      if (startIndex === -1 && endIndex === -1) continue;
      const s = Math.max(0, startIndex === -1 ? 0 : startIndex);
      const e = endIndex === -1 ? days.length : endIndex;
      const span = Math.max(1, e - s);
      if (!map[roomId]) map[roomId] = [];
      map[roomId].push({ startIndex: s, span, res: r });
    }
    // merge overlapping spans for robustness
    for (const k of Object.keys(map)) {
      map[k].sort((a: any,b: any)=>a.startIndex-b.startIndex);
      const merged: any[] = [];
      for (const s of map[k]) {
        if (merged.length === 0) { merged.push(s); continue; }
        const last = merged[merged.length-1];
        if (s.startIndex <= last.startIndex + last.span - 1) {
          // overlap/adjacent -> extend
          const newEnd = Math.max(last.startIndex + last.span, s.startIndex + s.span);
          last.span = newEnd - last.startIndex;
          // choose earliest res for display (keep last.res)
        } else {
          merged.push(s);
        }
      }
      map[k] = merged;
    }
    return map;
  }, [reservations, days]);

  // calendar helpers: build a month grid (6 rows x 7 cols) starting Monday
  const monthMatrix = (year: number, month: number) => {
    const first = new Date(year, month, 1);
    // Monday-based index (0 = Monday)
    const firstWeekday = (first.getDay() + 6) % 7;
    const start = new Date(first);
    start.setDate(first.getDate() - firstWeekday);
    const weeks: Date[][] = [];
    let cur = new Date(start);
    for (let w = 0; w < 6; w++) {
      const week: Date[] = [];
      for (let d = 0; d < 7; d++) {
        week.push(new Date(cur));
        cur.setDate(cur.getDate() + 1);
      }
      weeks.push(week);
    }
    return weeks;
  };

  const onCalendarDayClick = (iso: string) => {
    setCalendarSelectedDate(iso);
  };

  const applyCalendarSelection = () => {
    if (!calendarSelectedDate) {
      setCalendarOpen(false);
      return;
    }

    const d = new Date(calendarSelectedDate);
    const startDt = new Date(d);
    startDt.setDate(d.getDate() - 2);
    const startIso = localDateISO(startDt);

    setCalendarViewDate(d);
    setAnchorDate(d);
    setIsMonthView(false);
    setWindowSize(7);
    setCalendarOpen(false);

    fetch(`/api/tapechart?start=${startIso}&days=7`)
      .then(res => res.json())
      .then(data => {
        if (data && data.rooms) {
          setRooms(data.rooms || []);

          const flat: any[] = [];
          for (const r of data.rooms) {
            for (const c of r.cells) {
              for (const rv of c.reservations || []) {
                flat.push({ ...rv, room_id: r.id, room_number: r.room_number });
              }
            }
          }
          setReservations(flat);

          const statusMap: Record<string, string> = {};
          (data.rooms || []).forEach((r: any) => {
            const normalized = normalizeRoomStatus(r.status);
            statusMap[r.id] = normalized;
          });
          setRoomStatuses(statusMap);
        }
      }).catch(err => console.error('Error fetching tapechart', err));
  };

  const normalizeRoomStatus = (status: string | undefined) => {
    const value = String(status || '').toUpperCase();
    if (value.includes('DIRTY') || value === 'KOTOR') return 'Kotor';
    if (value.includes('MAINT')) return 'Maintenance';
    if (value.includes('OCC')) return 'Occupied';
    return 'Ready';
  };

  const getReservationCardStyle = (reservation: any) => {
    const status = String(reservation?.status || '').toUpperCase();
    const paymentStatus = String(reservation?.payment_status || '').toUpperCase();

    if (status === 'CHECKED_IN') {
      return {
        cardClass: 'res-checkedin',
        badge: 'CI',
        badgeClass: 'badge ci',
        paymentLabel: paymentStatus === 'LUNAS' ? '(LUNAS)' : paymentStatus === 'DP' ? '(DP)' : '',
      };
    }

    if (status === 'CHECKED_OUT') {
      return {
        cardClass: 'res-checkedout',
        badge: 'CO',
        badgeClass: 'badge co',
        paymentLabel: '(KOTOR)',
      };
    }

    return {
      cardClass: 'res-booked',
      badge: 'BO',
      badgeClass: 'badge bo',
      paymentLabel: paymentStatus === 'LUNAS' ? '(LUNAS)' : paymentStatus === 'DP' ? '(DP)' : '',
    };
  };

  const fetchData = () => {
    // Determine date range from days array
    const start = days.length ? days[0].date : localDateISO(new Date());
    // end should be exclusive - take day after last
    const last = days.length ? days[days.length - 1].date : localDateISO(new Date());
    const endDate = new Date(last);
    endDate.setDate(endDate.getDate() + 1);
    const end = localDateISO(endDate);

    fetch(`/api/tapechart?start=${start}&end=${end}`)
      .then(res => res.json())
      .then(data => {
        if (data && data.rooms) {
          setRooms(data.rooms || []);

          // build reservations list from rooms.cells
          const flat: any[] = [];
          for (const r of data.rooms) {
            for (const c of r.cells) {
              for (const rv of c.reservations || []) {
                flat.push({ ...rv, room_id: r.id, room_number: r.room_number });
              }
            }
          }
          setReservations(flat);

          const statusMap: Record<string, string> = {};
          (data.rooms || []).forEach((r: any) => {
            const normalized = normalizeRoomStatus(r.status);
            statusMap[r.id] = normalized;
          });
          setRoomStatuses(statusMap);
        }
      }).catch(err => console.error('Error fetching tapechart', err));
  };

  const fetchOperationsData = async () => {
    try {
      const [housekeepingRes, maintenanceRes, posMenuRes, posOrderRes, financeRes, guestsRes, employeesRes, payrollRes] = await Promise.all([
        fetch('/api/housekeeping/tasks'),
        fetch('/api/maintenance/tasks'),
        fetch('/api/pos/menu'),
        fetch('/api/pos/orders'),
        fetch('/api/accounting/summary'),
        fetch('/api/guest-profiles'),
        fetch('/api/hr/employees'),
        fetch('/api/hr/payroll')
      ]);

      const housekeepingData = await housekeepingRes.json();
      const maintenanceData = await maintenanceRes.json();
      const posMenuData = await posMenuRes.json();
      const posOrderData = await posOrderRes.json();
      const financeData = await financeRes.json();
      const guestsData = await guestsRes.json();
      const employeesData = await employeesRes.json();
      const payrollData = await payrollRes.json();

      if (housekeepingData?.status === 'OK') setHousekeepingTasks(housekeepingData.data || []);
      if (maintenanceData?.status === 'OK') setMaintenanceTasks(maintenanceData.data || []);
      if (posMenuData?.status === 'OK') setPosMenu(posMenuData.data?.items || []);
      if (posOrderData?.status === 'OK') setPosOrders(posOrderData.data || []);
      if (financeData?.status === 'OK') setFinanceSummary(financeData.data || null);
      if (guestsData?.status === 'OK') setGuestProfiles(guestsData.data || []);
      if (employeesData?.status === 'OK') setEmployees(employeesData.data || []);
      if (payrollData?.status === 'OK') setPayroll(payrollData.data || []);
    } catch (error) {
      console.error('Error fetching operations tasks', error);
    }
  };

  const createPosOrder = async () => {
    const sampleItems = posMenu.slice(0, 2).map((item: any) => ({ menu_item_id: item.id, quantity: 1 }));

    try {
      const res = await fetch('/api/pos/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table_number: '101', guest_name: 'Walk In Guest', items: sampleItems })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to create POS order');
      fetchOperationsData();
      alert('POS order created');
    } catch (error) {
      console.error('Create POS order failed', error);
      alert(`Gagal buat POS order: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  // quick create reservation used by calendar modal
  const createReservation = async (payload: any) => {
    try {
      const res = await fetch('/api/reservations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to create reservation');
      // refresh
      fetchData();
      fetchOperationsData();
      setCreateResOpen(false);
      setSelectedRange({});
      alert('Reservasi berhasil dibuat');
    } catch (err) {
      console.error('Create reservation failed', err);
      alert('Gagal membuat reservasi: ' + (err instanceof Error ? err.message : 'Unknown'));
    }
  };

  const handleReservationAction = async (reservationId: number, action: 'checkin' | 'checkout') => {
    try {
      const response = await fetch(`/api/reservations/${reservationId}/${action === 'checkin' ? 'checkin' : 'checkout'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || 'Action failed');
      }
      fetchData();
      fetchOperationsData();
      setSelectedRes(null);
      alert(action === 'checkin' ? 'Check-in berhasil' : 'Check-out berhasil');
    } catch (error) {
      console.error(`Reservation ${action} failed`, error);
      alert(`Gagal ${action === 'checkin' ? 'check-in' : 'check-out'}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  useEffect(() => {
    fetchData();
    fetchOperationsData();

    // connect to SSE for realtime updates
    let es: EventSource | null = null;
    try {
      es = new EventSource('/api/events');
      es.addEventListener('ReservationCreated', (ev: any) => {
        console.log('SSE ReservationCreated', ev.data);
        fetchData();
      });
      es.addEventListener('ReservationMoved', (ev: any) => {
        console.log('SSE ReservationMoved', ev.data);
        fetchData();
      });
      es.addEventListener('ReservationCheckedIn', (ev: any) => {
        console.log('SSE ReservationCheckedIn', ev.data);
        fetchData();
      });
      es.addEventListener('ReservationCheckedOut', (ev: any) => {
        console.log('SSE ReservationCheckedOut', ev.data);
        fetchData();
      });
      es.addEventListener('RoomStatusUpdated', (ev: any) => {
        console.log('SSE RoomStatusUpdated', ev.data);
        fetchData();
        fetchOperationsData();
      });
      es.onmessage = (m) => {
        // generic messages
        console.log('SSE message', m.data);
      };
    } catch (e) {
      console.error('SSE connection failed', e);
    }

    return () => {
      if (es) es.close();
    };
  }, []);

  // Fungsi toggle status kamar dengan sinkronisasi ke backend
  const toggleStatus = (roomId: string) => {
    const currentStatus = roomStatuses[roomId] || 'Ready';
    const newStatus = currentStatus === 'Ready' ? 'Kotor' : 'Ready';

    fetch(`/api/rooms/${roomId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.status === 'SUCCESS') {
          setRoomStatuses(prev => ({ ...prev, [roomId]: newStatus }));
        } else {
          alert('Gagal memperbarui status kamar di database');
        }
      })
      .catch(err => console.error('Error updating status:', err));
  };

  const renderRoomStatusButton = (room: any) => {
    const currentStatus = normalizeRoomStatus(roomStatuses[room.id] || room.status || 'Ready');
    const buttonClass = currentStatus === 'Kotor'
      ? 'bg-red-100 text-red-600 border-red-200'
      : currentStatus === 'Occupied'
        ? 'bg-gray-100 text-gray-700 border-gray-200'
        : currentStatus === 'Maintenance'
          ? 'bg-amber-100 text-amber-700 border-amber-200'
          : 'bg-blue-50 text-blue-600 border-blue-100';

    return (
      <button
        onClick={() => toggleStatus(room.id)}
        className={`px-3 py-1 rounded border text-[10px] transition ${buttonClass}`}
      >
        {currentStatus}
      </button>
    );
  };

  return (
    <div className="flex min-h-screen bg-gray-50 text-gray-800">
      <aside className="w-64 bg-white border-r p-4 space-y-6">
        <h1 className="text-xl font-bold text-gray-800">OAK LAWANG</h1>
        <nav className="space-y-2">
          {[
            'Kalender',
            'Transaksi',
            'Laporan',
            'Produk & Inventori',
            'Pelanggan',
            'Pengaturan'
          ].map((label) => (
            <NavItem
              key={label}
              label={label}
              active={selectedMenu === label}
              onClick={() => setSelectedMenu(label as any)}
            />
          ))}
        </nav>
      </aside>

      <main className="flex-1 p-6 space-y-6">
        <header className="flex justify-between items-center">
          <div>
            <h2 className="text-2xl font-bold">OAK LAWANG</h2>
            <p className="text-gray-500 text-sm">Selamat datang, vian.pradana89@gmail.com (Owner)</p>
          </div>
          <div className="flex gap-2">
            <button className="bg-white border px-4 py-2 rounded shadow-sm text-sm">POS</button>
            <button className="bg-white border px-4 py-2 rounded shadow-sm text-sm">Deposit</button>
          </div>
        </header>

        {selectedMenu === 'Kalender' && (
          <>
            <div className="grid grid-cols-4 gap-4">
              <StatCard title="Total Reservasi" value={`${reservations.length} (24%)`} color="bg-blue-600 text-white" />
              <StatCard title="Reservasi" value={reservations.length.toString()} color="bg-blue-500 text-white" />
              <StatCard title="Check In" value={reservations.filter(r => (r.status || '').toUpperCase() === 'CHECKED_IN').length.toString()} color="bg-green-500 text-white" />
              <StatCard title="Check Out" value={reservations.filter(r => (r.status || '').toUpperCase() === 'CHECKED_OUT').length.toString()} color="bg-orange-500 text-white" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="bg-white border rounded shadow-sm p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-bold text-sm">Housekeeping</h3>
                  <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded">{housekeepingTasks.length} task</span>
                </div>
                <div className="space-y-2">
                  {housekeepingTasks.slice(0, 4).map((task: any) => (
                    <div key={task.id} className="flex justify-between items-center border rounded p-2 text-xs">
                      <div>
                        <div className="font-semibold">Kamar {task.room_number || '-'}</div>
                        <div className="text-gray-500">{task.task_type}</div>
                      </div>
                      <span className={`px-2 py-1 rounded ${task.status === 'DONE' ? 'bg-green-100 text-green-700' : task.status === 'IN_PROGRESS' ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-700'}`}>
                        {task.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-white border rounded shadow-sm p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-bold text-sm">Maintenance</h3>
                  <span className="text-xs bg-amber-100 text-amber-700 px-2 py-1 rounded">{maintenanceTasks.length} task</span>
                </div>
                <div className="space-y-2">
                  {maintenanceTasks.slice(0, 4).map((task: any) => (
                    <div key={task.id} className="flex justify-between items-center border rounded p-2 text-xs">
                      <div>
                        <div className="font-semibold">Kamar {task.room_number || '-'}</div>
                        <div className="text-gray-500">{task.issue_type}</div>
                      </div>
                      <span className={`px-2 py-1 rounded ${task.status === 'DONE' ? 'bg-green-100 text-green-700' : task.status === 'IN_PROGRESS' ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'}`}>
                        {task.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="bg-white p-4 rounded shadow-sm border">
              <div className="flex justify-between mb-4">
                <div className="room-search-wrap">
                  <span className="room-search-icon">⌕</span>
                  <input type="text" placeholder="Cari BID, nama, HP..." className="room-search-input" />
                </div>
                <div className="flex gap-2 items-center">
                  <div className="flex items-center gap-1 rounded-md border border-gray-200 bg-white p-1 shadow-sm">
                    <button onClick={() => shiftDays(-1)} className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded-sm">Kemarin</button>
                    <button onClick={() => goToday()} className="px-3 py-1.5 text-sm bg-blue-600 text-white font-semibold rounded-sm shadow-sm">Hari Ini</button>
                    <button onClick={() => shiftDays(1)} className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded-sm">Besok</button>
                  </div>

                  <div className="ml-2 flex items-center gap-2">
                    <span className="text-[11px] text-gray-500">View:</span>
                    <button onClick={() => setWindowSize(7)} className={`px-2 py-1 border rounded text-xs ${windowSize===7 ? 'bg-blue-50 text-blue-700 font-semibold border-blue-200' : 'bg-white text-gray-700 border-gray-300'}`}>7</button>
                  </div>

                  <button onClick={() => { setCalendarViewDate(anchorDate); setCalendarSelectedDate(localDateISO(anchorDate)); setCalendarOpen(true); }} className="ml-2 border border-gray-300 px-2.5 py-1.5 text-sm bg-white rounded-md flex items-center gap-2 shadow-sm hover:bg-gray-50">
                    <span className="text-base">📅</span>
                    <span>{new Date(anchorDate).toLocaleString('id-ID', { month: 'long' })}</span>
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs" style={{ tableLayout: 'fixed' }}>
                  <thead>
                    <tr className="bg-gray-100 border">
                      <th className="p-3 border text-left" style={{ width: '220px', minWidth: '220px' }}>Kamar</th>
                      {days.map((d) => {
                        const todayIso = localDateISO(new Date());
                        const isToday = d.date === todayIso;
                        return (
                          <th
                            key={d.date}
                            className={`header-date-cell ${isToday ? 'header-date-cell--today' : ''}`}
                          >
                            <div className="day-header-label">{d.label}</div>
                            <div className={`day-header-number ${isToday ? 'is-today' : ''}`}>{d.raw.getDate()}</div>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {rooms.map(room => (
                      <tr key={room.id} className="border">
                        <td className="room-cell border font-medium bg-gray-50 text-[12px] text-gray-700 text-center align-middle" style={{ width: '220px', minWidth: '220px' }}>
                          <div className="room-cell-inner flex flex-col items-center justify-center text-center gap-1">
                            <div className="room-name-wrap flex items-center justify-center text-center">
                              <span className="room-dot"></span>
                              <span className="room-name-text">{room.room_number} {room.name}</span>
                            </div>
                            <div className="room-status-wrap flex items-center justify-center text-center">{renderRoomStatusButton(room)}</div>
                          </div>
                        </td>
                        {(() => {
                          const spans = reservationSpans[String(room.id)] || [];
                          const cells = [];
                          let i = 0;
                          while (i < days.length) {
                            const spanAt = spans.find(s => s.startIndex === i);
                            if (spanAt) {
                              const r = spanAt.res;
                              const reservationStyle = getReservationCardStyle(r);
                              cells.push(
                                <td key={`${room.id}-${i}-${r.id}`} colSpan={spanAt.span} className="p-2 border align-middle h-14">
                                  <div
                                    draggable
                                    onDragStart={(e: any) => handleDragStart(e, r, room.id)}
                                    onDragEnd={(e: any) => handleDragEnd(e)}
                                    onClick={() => setSelectedRes(r)}
                                    className={`reservation-card ${reservationStyle.cardClass} cursor-pointer truncate font-semibold`}
                                  >
                                    <div className="flex justify-between items-start">
                                      <div>
                                        <div className="flex items-center gap-2">
                                          <div className="text-sm font-bold">{r.guest_name}</div>
                                          <span className={reservationStyle.badgeClass}>{reservationStyle.badge}</span>
                                          {reservationStyle.paymentLabel && <span className="badge paid">{reservationStyle.paymentLabel}</span>}
                                        </div>
                                        <div className="text-xs opacity-80">{Math.max(1, Math.floor((new Date(r.check_out).getTime() - new Date(r.check_in).getTime())/(24*3600*1000)))} malam</div>
                                        <div className="text-xs opacity-80">{r.payment_status}</div>
                                      </div>
                                      <div className="text-xs opacity-80 ml-2">{r.status}</div>
                                    </div>
                                  </div>
                                </td>
                              );
                              i += spanAt.span;
                            } else {
                              const day = days[i];
                              const currentStatus = normalizeRoomStatus(roomStatuses[room.id] || room.status || 'Ready');
                              cells.push(
                                <td key={`${room.id}-${day.date}`} className="p-2 border text-center h-14 align-middle">
                                  <div
                                    className="status-cell-wrap"
                                    onDragOver={(e) => e.preventDefault()}
                                    onDrop={async (e) => {
                                      e.preventDefault();
                                      const reservationId = e.dataTransfer.getData('reservation-id');
                                      const fromRoomId = e.dataTransfer.getData('from-room-id');
                                      const toRoomId = String(room.id);
                                      if (!reservationId) return;
                                      if (fromRoomId === toRoomId) return;
                                      try {
                                        const resp = await fetch(`/api/reservations/${reservationId}/move`, {
                                          method: 'POST',
                                          headers: { 'Content-Type': 'application/json' },
                                          body: JSON.stringify({ to_room_id: toRoomId })
                                        });
                                        const data = await resp.json();
                                        if (resp.ok) {
                                          fetchData();
                                          alert('Move berhasil');
                                        } else {
                                          alert('Move gagal: ' + (data.message || data.error || 'Unknown'));
                                        }
                                      } catch (err) {
                                        console.error('Move error', err);
                                        const message = err instanceof Error ? err.message : 'Unknown error';
                                        alert('Move error: ' + message);
                                      }
                                    }}
                                  >
                                    {currentStatus === 'Ready' && <div className="status-ready-cell">Ready</div>}
                                    {currentStatus === 'Maintenance' && <div className="status-maintenance-cell">Maintenance</div>}
                                    {currentStatus === 'Occupied' && <div className="status-occupied-cell">Occupied</div>}
                                    {currentStatus === 'Kotor' && <div className="status-kotor-cell">Dirty</div>}
                                  </div>
                                </td>
                              );
                              i += 1;
                            }
                          }
                          return cells;
                        })()}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Calendar modal */}
            {calendarOpen && (
             <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
               <div className="bg-white rounded-md border border-gray-200 shadow-[0_4px_18px_rgba(0,0,0,0.12)] w-[460px] max-w-[95vw] px-4 pt-3 pb-4">
                   <div className="flex items-center justify-between mb-3">
                     <div className="text-[15px] font-bold text-gray-800">Pilih tanggal untuk menampilkan grid (ganti bulan/tanggal)</div>
                     <button onClick={() => setCalendarOpen(false)} className="px-3 py-1 border border-gray-200 rounded-md text-sm bg-white text-gray-700 hover:bg-gray-50">Batal</button>
                   </div>

                   <div className="flex items-center justify-between mb-2 px-1">
                     <button
                       onClick={() => setCalendarViewDate((d) => { const n = new Date(d); n.setMonth(n.getMonth() - 1); return n; })}
                       className="w-8 h-8 border border-gray-300 rounded-md text-xl text-gray-600 flex items-center justify-center hover:bg-gray-50"
                     >
                       ‹
                     </button>
                     <div className="text-[18px] font-medium text-gray-700">
                       {new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth(), 1).toLocaleString('id-ID', { month: 'long', year: 'numeric' })}
                     </div>
                     <button
                       onClick={() => setCalendarViewDate((d) => { const n = new Date(d); n.setMonth(n.getMonth() + 1); return n; })}
                       className="w-8 h-8 border border-gray-300 rounded-md text-xl text-gray-600 flex items-center justify-center hover:bg-gray-50"
                     >
                       ›
                     </button>
                   </div>

                   <div className="grid grid-cols-7 gap-1 mb-2 text-[11px] text-gray-500 font-medium text-center">
                     {['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'].map((day) => (
                       <div key={day} className="py-1">{day}</div>
                     ))}
                   </div>

                   <div className="grid grid-cols-7 gap-1 text-[13px] text-center">
                     {monthMatrix(calendarViewDate.getFullYear(), calendarViewDate.getMonth()).flat().map((d: Date) => {
                       const iso = localDateISO(d);
                       const inMonth = d.getMonth() === calendarViewDate.getMonth();
                       const selected = calendarSelectedDate === iso;
                       const cls = `h-9 flex items-center justify-center rounded-md ${inMonth ? 'cursor-pointer' : 'text-gray-300'} ${selected ? 'bg-[#0d6efd] text-white font-semibold shadow-sm' : 'text-gray-700 hover:bg-gray-100'}`;
                       return (
                         <button
                           key={iso}
                           type="button"
                           onClick={() => onCalendarDayClick(iso)}
                           className={cls}
                         >
                           {d.getDate()}
                         </button>
                       );
                     })}
                   </div>

                   <div className="mt-4 flex justify-end gap-2">
                     <button onClick={() => setCalendarOpen(false)} className="px-4 py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700">Bersihkan</button>
                     <button onClick={applyCalendarSelection} className="px-4 py-2 rounded-md text-sm bg-[#0d6efd] text-white font-medium shadow-sm">Pilih</button>
                   </div>
                 </div>
             </div>
            )}

            {/* Create reservation quick modal */}
            {createResOpen && (
              <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
                <div className="bg-white rounded p-4 w-[520px] max-w-full">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="font-bold">Buat Reservasi Cepat</h4>
                    <button onClick={() => setCreateResOpen(false)} className="text-sm px-3 py-1 border rounded">Tutup</button>
                  </div>

                  <div className="space-y-3">
                    <div>
                      <label className="text-xs">Pilih Kamar</label>
                      <select className="w-full border p-2 mt-1" value={prefillRoomId ?? ''} onChange={(e) => setPrefillRoomId(e.target.value ? Number(e.target.value) : null)}>
                        <option value="">-- Pilih Kamar --</option>
                        {rooms.map(r => <option key={r.id} value={r.id}>{r.room_number} {r.name}</option>)}
                      </select>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs">Check-in</label>
                        <input type="date" className="w-full border p-2 mt-1" defaultValue={selectedRange.start ?? localDateISO(anchorDate)} id="quick_ci" />
                      </div>
                      <div>
                        <label className="text-xs">Check-out</label>
                        <input type="date" className="w-full border p-2 mt-1" defaultValue={selectedRange.end ?? localDateISO(new Date(new Date(anchorDate).setDate(anchorDate.getDate()+1)))} id="quick_co" />
                      </div>
                    </div>

                    <div>
                      <label className="text-xs">Nama Tamu</label>
                      <input id="quick_name" className="w-full border p-2 mt-1" placeholder="Nama tamu" />
                    </div>

                    <div>
                      <label className="text-xs">No. Telepon</label>
                      <input id="quick_phone" className="w-full border p-2 mt-1" placeholder="0812..." />
                    </div>

                    <div className="flex justify-end gap-2 mt-2">
                      <button onClick={() => setCreateResOpen(false)} className="px-3 py-1 border rounded">Batal</button>
                      <button onClick={async () => {
                        const roomId = prefillRoomId;
                        const ci = (document.getElementById('quick_ci') as HTMLInputElement).value;
                        const co = (document.getElementById('quick_co') as HTMLInputElement).value;
                        const name = (document.getElementById('quick_name') as HTMLInputElement).value || 'Tamu';
                        const phone = (document.getElementById('quick_phone') as HTMLInputElement).value || '';
                        if (!roomId) { alert('Pilih kamar'); return; }
                        if (!ci || !co) { alert('Isi check-in dan check-out'); return; }
                        const payload = { room_id: roomId, guest_name: name, guest_phone: phone, check_in: ci, check_out: co, total_price: 0, payment_status: 'UNPAID' };
                        await createReservation(payload);
                      }} className="px-3 py-1 bg-green-600 text-white rounded">Buat</button>
                    </div>
                  </div>
                </div>
              </div>
            )}

          </>
        )}

        {selectedMenu === 'Transaksi' && (
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white border rounded shadow-sm p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-sm">POS / F&B</h3>
                <button onClick={createPosOrder} className="bg-blue-600 text-white text-xs px-3 py-1 rounded">Create Demo Order</button>
              </div>
              <div className="space-y-2 max-h-52 overflow-y-auto">
                {(posMenu || []).slice(0, 6).map((item: any) => (
                  <div key={item.id} className="flex justify-between border rounded p-2 text-xs">
                    <div>
                      <div className="font-semibold">{item.name}</div>
                      <div className="text-gray-500">{item.category_name}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-semibold">Rp {Number(item.price).toLocaleString('id-ID')}</div>
                      <div className="text-gray-500">{item.item_code}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white border rounded shadow-sm p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-sm">Recent POS Orders</h3>
                <span className="text-xs bg-purple-100 text-purple-700 px-2 py-1 rounded">{posOrders.length}</span>
              </div>
              <div className="space-y-2 max-h-52 overflow-y-auto">
                {posOrders.slice(0, 5).map((order: any) => (
                  <div key={order.id} className="border rounded p-2 text-xs">
                    <div className="flex justify-between">
                      <div className="font-semibold">{order.order_number}</div>
                      <span className="bg-gray-100 px-1.5 rounded">{order.status}</span>
                    </div>
                    <div className="text-gray-600">Table {order.table_number} • {order.guest_name}</div>
                    <div className="font-semibold mt-1">Rp {Number(order.total_amount || 0).toLocaleString('id-ID')}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {selectedMenu === 'Laporan' && (
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-white border rounded shadow-sm p-4">
              <div className="text-xs uppercase text-gray-500">Hutang Vendor</div>
              <div className="text-2xl font-bold mt-2">Rp {Number(financeSummary?.total_payable || 0).toLocaleString('id-ID')}</div>
            </div>
            <div className="bg-white border rounded shadow-sm p-4">
              <div className="text-xs uppercase text-gray-500">Piutang Tamu</div>
              <div className="text-2xl font-bold mt-2">Rp {Number(financeSummary?.total_receivable || 0).toLocaleString('id-ID')}</div>
            </div>
            <div className="bg-white border rounded shadow-sm p-4">
              <div className="text-xs uppercase text-gray-500">Jumlah Jurnal</div>
              <div className="text-2xl font-bold mt-2">{financeSummary?.entries?.length || 0}</div>
            </div>
          </div>
        )}

        {selectedMenu === 'Produk & Inventori' && (
          <div className="bg-white border rounded shadow-sm p-4">
            <h3 className="font-bold text-lg mb-3">Produk & Inventori</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="border rounded p-3">
                <div className="text-xs uppercase text-gray-500">Menu aktif</div>
                <div className="text-2xl font-bold mt-2">{posMenu.length}</div>
              </div>
              <div className="border rounded p-3">
                <div className="text-xs uppercase text-gray-500">Order hari ini</div>
                <div className="text-2xl font-bold mt-2">{posOrders.length}</div>
              </div>
            </div>
          </div>
        )}

        {selectedMenu === 'Pelanggan' && (
          <div className="bg-white border rounded shadow-sm p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-lg">Guest CRM</h3>
              <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded">{guestProfiles.length}</span>
            </div>
            <div className="space-y-2">
              {guestProfiles.map((guest: any) => (
                <div key={guest.id} className="border rounded p-3 text-sm">
                  <div className="font-semibold">{guest.full_name}</div>
                  <div className="text-gray-600">{guest.email || guest.phone || '-'}</div>
                  <div className="text-gray-500">Tier: {guest.loyalty_tier}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {selectedMenu === 'Pengaturan' && (
          <div className="bg-white border rounded shadow-sm p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-lg">HR & Payroll</h3>
              <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded">{employees.length}</span>
            </div>
            <div className="space-y-2">
              {employees.map((employee: any) => (
                <div key={employee.id} className="border rounded p-3 text-sm">
                  <div className="font-semibold">{employee.full_name}</div>
                  <div className="text-gray-600">{employee.position}</div>
                  <div className="text-gray-500">Net payroll: Rp {Number(payroll.find((p: any) => p.employee_id === employee.id)?.net_salary || 0).toLocaleString('id-ID')}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {selectedRes && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded-lg shadow-xl w-96 space-y-4">
            <h3 className="font-bold text-lg border-b pb-2">Detail Reservasi</h3>
            <p><strong>Nama:</strong> {selectedRes.guest_name}</p>
            <p><strong>Room:</strong> {selectedRes.room_number || selectedRes.room_id}</p>
            <p><strong>Check-in:</strong> {selectedRes.check_in ? selectedRes.check_in.split('T')[0] : '-'}</p>
            <p><strong>Check-out:</strong> {selectedRes.check_out ? selectedRes.check_out.split('T')[0] : '-'}</p>
            <p><strong>Status Pembayaran:</strong> {selectedRes.payment_status || 'UNPAID'}</p>
            <div className="flex gap-2">
              {selectedRes.status === 'CHECKED_IN' ? (
                <button onClick={() => handleReservationAction(Number(selectedRes.id), 'checkout')} className="flex-1 bg-amber-600 text-white py-2 rounded">Check Out</button>
              ) : (
                <button onClick={() => handleReservationAction(Number(selectedRes.id), 'checkin')} className="flex-1 bg-green-600 text-white py-2 rounded">Check In</button>
              )}
              <button onClick={() => setSelectedRes(null)} className="flex-1 bg-gray-200 py-2 rounded">Tutup</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NavItem({ label, active, onClick }: any) {
  return (
    <div onClick={onClick} className={`p-3 rounded cursor-pointer ${active ? 'bg-gray-100 text-blue-600 font-bold' : 'hover:bg-gray-50'}`}>
      <span className="text-sm">{label}</span>
    </div>
  );
}

function StatCard({ title, value, color }: any) {
  return (
    <div className={`${color} p-4 rounded shadow-sm`}>
      <p className="text-[10px] uppercase opacity-80">{title}</p>
      <p className="text-xl font-bold">{value}</p>
    </div>
  );
}

export default App;