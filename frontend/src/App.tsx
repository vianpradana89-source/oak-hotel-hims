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
  const [selectedFolio, setSelectedFolio] = useState<any>(null);
  const [reservationAudit, setReservationAudit] = useState<any[]>([]);
  const [paymentDraft, setPaymentDraft] = useState<string>('');
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
  const [reservationFilter, setReservationFilter] = useState<'all' | 'booked' | 'checked_in' | 'checked_out'>('all');
  const [reservationSearch, setReservationSearch] = useState('');
  const [reservationDateFrom, setReservationDateFrom] = useState('');
  const [reservationDateTo, setReservationDateTo] = useState('');
  const [reservationEditId, setReservationEditId] = useState<number | null>(null);
  const [quickBooking, setQuickBooking] = useState({
    guestName: '',
    guestPhone: '',
    roomId: null as number | null,
    checkIn: '',
    checkOut: '',
    roomVariant: 'Deluxe King'
  });
  // Anchor date for the grid window and handlers to shift the window
  const [anchorDate, setAnchorDate] = useState<Date>(new Date());
  const [windowSize, setWindowSize] = useState<number>(7);
  const [isMonthView, setIsMonthView] = useState<boolean>(false);
  const [calendarOpen, setCalendarOpen] = useState<boolean>(false);
  const [calendarViewDate, setCalendarViewDate] = useState<Date>(new Date());
  const [calendarSelectedDate, setCalendarSelectedDate] = useState<string | null>(localDateISO(new Date()));
  const [selectedRange, setSelectedRange] = useState<{start?: string, end?: string}>({});
  const [createResOpen, setCreateResOpen] = useState<boolean>(false);
  const [checkoutConfirmOpen, setCheckoutConfirmOpen] = useState<boolean>(false);
  const [checkoutPendingId, setCheckoutPendingId] = useState<number | null>(null);
  const [dirtyConfirmOpen, setDirtyConfirmOpen] = useState<boolean>(false);
  const [dirtyConfirmRoomId, setDirtyConfirmRoomId] = useState<number | null>(null);
  const [dirtyConfirmDate, setDirtyConfirmDate] = useState<string | null>(null);
  const [prefillRoomId, setPrefillRoomId] = useState<number | null>(null);
  const [bookingType, setBookingType] = useState<'walkin' | 'ota'>('walkin');
  const [guestSegment, setGuestSegment] = useState<'Reguler' | 'Group' | 'Corporate'>('Reguler');
  const [discountType, setDiscountType] = useState<'nominal' | 'percent'>('nominal');
  const [discountValue, setDiscountValue] = useState<string>('');
  const [amountPaid, setAmountPaid] = useState<string>('');
  const [subtotalDraft, setSubtotalDraft] = useState<number>(0);
  const [ktpFile, setKtpFile] = useState<File | null>(null);
  const [buktiBayarFile, setBuktiBayarFile] = useState<File | null>(null);
  const billingSummary = useMemo(
    () => computeBillingSummary(subtotalDraft, discountValue, discountType, amountPaid),
    [subtotalDraft, discountValue, discountType, amountPaid]
  );
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

    const getNightlySpan = (checkIn: string, checkOut: string) => {
      const ci = localDateISO(checkIn);
      const co = localDateISO(checkOut);
      if (!ci || !co || ci === co) return null;

      const startIndex = days.findIndex(d => d.date === ci);
      const endIndex = days.findIndex(d => d.date === co);
      if (startIndex === -1 && endIndex === -1) return null;

      const visibleStart = startIndex === -1 ? 0 : startIndex;
      const visibleEnd = endIndex === -1 ? days.length : endIndex;
      // Nightly stay is inclusive on check-in and exclusive on check-out.
      // Example: 20 -> 21 blocks only date 20; 20 -> 28 blocks 20..27.
      const span = Math.max(1, visibleEnd - visibleStart);
      return { startIndex: visibleStart, span };
    };

    for (const r of reservations) {
      const status = String(r?.status || '').toUpperCase();
      if (status === 'CHECKED_OUT' || status === 'CANCELLED') continue;

      const roomId = String(r.room_id);
      const nightlySpan = getNightlySpan(r.check_in, r.check_out);
      if (!nightlySpan) continue;

      if (!map[roomId]) map[roomId] = [];
      map[roomId].push({ startIndex: nightlySpan.startIndex, span: nightlySpan.span, res: r });
    }

    for (const k of Object.keys(map)) {
      map[k].sort((a: any, b: any) => a.startIndex - b.startIndex);
      const merged: any[] = [];
      for (const s of map[k]) {
        if (merged.length === 0) { merged.push(s); continue; }
        const last = merged[merged.length - 1];
        if (s.startIndex < last.startIndex + last.span) {
          const newEnd = Math.max(last.startIndex + last.span, s.startIndex + s.span);
          last.span = newEnd - last.startIndex;
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
    if (value === 'VACANT_DIRTY' || value === 'OCCUPIED_DIRTY' || value.includes('DIRTY') || value === 'KOTOR') return 'Kotor';
    if (value === 'CLEANING' || value === 'OUT_OF_ORDER' || value === 'OUT_OF_SERVICE' || value.includes('MAINT')) return 'Maintenance';
    if (value === 'OCCUPIED_CLEAN' || value === 'OCCUPIED_DIRTY' || value.includes('OCC')) return 'Occupied';
    if (value === 'VACANT_CLEAN' || value === 'INSPECTED') return 'Ready';
    return 'Ready';
  };

  // Isolated operational-date helper so it can be replaced by business date/Night Audit later.
  const getOperationalDateKey = () => localDateISO(new Date());

  const getGuestSegmentMeta = (segment: any) => {
    const value = String(segment || 'Reguler').trim();
    if (value.toLowerCase() === 'group') {
      return { label: 'Group', className: 'segment-badge segment-group' };
    }
    if (value.toLowerCase() === 'corporate') {
      return { label: 'Corporate', className: 'segment-badge segment-corporate' };
    }
    return { label: 'Reguler', className: 'segment-badge segment-reguler' };
  };

  const formatCurrency = (value: number | string | undefined) => {
    const numeric = Number(value || 0);
    return new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: 'IDR',
      maximumFractionDigits: 0,
    }).format(isFinite(numeric) ? numeric : 0);
  };

  const getPaymentStatusLabel = (status: string | undefined) => {
    const normalized = String(status || '').toUpperCase();
    if (normalized === 'PAID') return 'Lunas';
    if (normalized === 'PARTIAL') return 'Kurang bayar';
    if (normalized === 'UNPAID') return 'Belum dibayar';
    return normalized || 'Belum dibayar';
  };

  const getPaymentBadgeClass = (status: string | undefined) => {
    const normalized = String(status || '').toUpperCase();
    if (normalized === 'PAID') return 'segment-corporate';
    if (normalized === 'PARTIAL') return 'segment-group';
    return 'segment-reguler';
  };

  const filteredReservations = useMemo(() => {
    const sorted = [...reservations].sort((a, b) => {
      const aTime = new Date(a.check_in || 0).getTime();
      const bTime = new Date(b.check_in || 0).getTime();
      return bTime - aTime;
    });

    const query = reservationSearch.trim().toLowerCase();

    let list = sorted.filter((reservation) => {
      if (!query) return true;
      const haystack = [
        reservation?.guest_name,
        reservation?.guest_phone,
        reservation?.room_number,
        reservation?.room_id,
        reservation?.guest_segment,
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    });

    if (reservationDateFrom) {
      list = list.filter((reservation) => !reservation?.check_in || reservation.check_in >= reservationDateFrom);
    }

    if (reservationDateTo) {
      list = list.filter((reservation) => !reservation?.check_out || reservation.check_out <= reservationDateTo);
    }

    if (reservationFilter === 'booked') {
      return list.filter((reservation) => {
        const status = String(reservation?.status || '').toUpperCase();
        return status !== 'CHECKED_IN' && status !== 'CHECKED_OUT' && status !== 'CANCELLED';
      });
    }

    if (reservationFilter === 'checked_in') {
      return list.filter((reservation) => String(reservation?.status || '').toUpperCase() === 'CHECKED_IN');
    }

    if (reservationFilter === 'checked_out') {
      return list.filter((reservation) => String(reservation?.status || '').toUpperCase() === 'CHECKED_OUT');
    }

    return list;
  }, [reservations, reservationFilter, reservationSearch, reservationDateFrom, reservationDateTo]);

  const openReservationEditor = (reservation: any) => {
    const checkIn = reservation.check_in ? reservation.check_in.split('T')[0] : '';
    const checkOut = reservation.check_out ? reservation.check_out.split('T')[0] : '';

    setReservationEditId(Number(reservation.id));
    setBookingType(reservation.booking_type || 'walkin');
    setGuestSegment((reservation.guest_segment || 'Reguler') as 'Reguler' | 'Group' | 'Corporate');
    setDiscountType(Number(reservation.discount_percent || 0) > 0 ? 'percent' : 'nominal');
    setDiscountValue(String(Number(reservation.discount_percent || reservation.discount_amount || 0)));
    setAmountPaid(String(Number(reservation.amount_paid || 0)));
    setSubtotalDraft(Number(reservation.subtotal_amount || reservation.total_price || 0));
    setPrefillRoomId(Number(reservation.room_id));
    setSelectedRange({ start: checkIn, end: checkOut });
    setQuickBooking({
      guestName: reservation.guest_name || '',
      guestPhone: reservation.guest_phone || '',
      roomId: Number(reservation.room_id),
      checkIn,
      checkOut,
      roomVariant: reservation.room_variant || 'Deluxe King'
    });
    setCreateResOpen(true);
  };

  const handleReservationCancel = async (reservationId: number) => {
    if (!window.confirm('Batalkan reservasi ini?')) return;

    try {
      const response = await fetch(`/api/reservations/${reservationId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || 'Gagal membatalkan reservasi');
      }

      setReservations(prev => prev.map((reservation) =>
        Number(reservation.id) === reservationId ? { ...reservation, status: 'CANCELLED', stay_status: 'CANCELLED' } : reservation
      ));

      if (selectedRes && Number(selectedRes.id) === reservationId) {
        setSelectedRes({ ...selectedRes, status: 'CANCELLED', stay_status: 'CANCELLED' });
      }

      fetchData();
      fetchOperationsData();
      alert('Reservasi dibatalkan');
    } catch (error) {
      console.error('Cancel reservation failed', error);
      alert(`Gagal membatalkan reservasi: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  function computeBillingSummary(subtotal: number, discountValue: string, discountType: 'nominal' | 'percent', paidAmount: string) {
    const subtotalNumber = Number(subtotal || 0);
    const discountNumeric = Number(discountValue || 0);
    const paidNumeric = Number(paidAmount || 0);
    const discount = discountType === 'percent'
      ? subtotalNumber * (discountNumeric / 100)
      : discountNumeric;
    const total = Math.max(subtotalNumber - discount, 0);
    const remaining = Math.max(total - paidNumeric, 0);
    const paymentStatus = paidNumeric <= 0 ? 'UNPAID' : remaining <= 0.01 ? 'PAID' : 'PARTIAL';

    return {
      subtotal: subtotalNumber,
      discount: Math.min(Math.max(discount, 0), subtotalNumber),
      total,
      paid: paidNumeric,
      remaining,
      paymentStatus,
    };
  }

  const getReservationCardStyle = (reservation: any) => {
    const status = String(reservation?.status || '').toUpperCase();
    const paymentStatus = String(reservation?.payment_status || '').toUpperCase();

    if (status === 'CHECKED_IN') {
      return {
        cardClass: 'res-checkedin',
        badge: 'CI',
        badgeClass: 'badge ci',
        paymentLabel: paymentStatus === 'LUNAS' ? '(LUNAS)' : paymentStatus === 'DP' ? '(DP)' : '',
        segmentMeta: getGuestSegmentMeta(reservation?.guest_segment),
      };
    }

    if (status === 'CHECKED_OUT') {
      return {
        cardClass: 'res-checkedout',
        badge: 'CO',
        badgeClass: 'badge co',
        paymentLabel: '(KOTOR)',
        segmentMeta: getGuestSegmentMeta(reservation?.guest_segment),
      };
    }

    return {
      cardClass: 'res-booked',
      badge: 'BO',
      badgeClass: 'badge bo',
      paymentLabel: paymentStatus === 'LUNAS' ? '(LUNAS)' : paymentStatus === 'DP' ? '(DP)' : '',
      segmentMeta: getGuestSegmentMeta(reservation?.guest_segment),
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

  const fetchReservationAudit = async (reservationId: number) => {
    try {
      const response = await fetch(`/api/reservations/${reservationId}/audit`);
      const data = await response.json();
      setReservationAudit(data.data || []);
    } catch (error) {
      console.error('Failed to fetch reservation audit', error);
      setReservationAudit([]);
    }
  };

  const fetchRoomAudit = async (roomId: number) => {
    try {
      const response = await fetch(`/api/rooms/${roomId}/audit`);
      const data = await response.json();
      return data.data || [];
    } catch (error) {
      console.error('Failed to fetch room audit', error);
      return [];
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

  const createReservation = async (payload: any, files?: { ktp?: File | null; buktiBayar?: File | null }) => {
    try {
      if (reservationEditId) {
        const response = await fetch(`/api/reservations/${reservationEditId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...payload,
            room_id: payload.room_id,
            guest_name: payload.guest_name,
            guest_phone: payload.guest_phone,
            guest_segment: payload.guest_segment,
            check_in: payload.check_in,
            check_out: payload.check_out,
            subtotal_amount: payload.subtotal_amount,
            total_price: payload.total_price,
            discount_amount: payload.discount_amount,
            discount_percent: payload.discount_percent,
            amount_paid: payload.amount_paid,
            remaining_balance: payload.remaining_balance,
            payment_status: payload.payment_status,
            room_variant: quickBooking.roomVariant,
            status: payload.status || 'CONFIRMED'
          })
        });

        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.message || 'Failed to update reservation');
        }

        const updatedReservation = result.data;
        setReservations((prev) => prev.map((reservation) =>
          Number(reservation.id) === reservationEditId ? { ...reservation, ...updatedReservation } : reservation
        ));

        if (selectedRes && Number(selectedRes.id) === reservationEditId) {
          setSelectedRes({ ...selectedRes, ...updatedReservation });
        }

        fetchData();
        setCreateResOpen(false);
        setSelectedRange({});
        setDiscountType('nominal');
        setDiscountValue('');
        setAmountPaid('');
        setSubtotalDraft(0);
        setKtpFile(null);
        setBuktiBayarFile(null);
        setReservationEditId(null);
        resetQuickBookingForm();
        alert('Reservasi berhasil diperbarui');
        return;
      }

      const hasFiles = Boolean(files?.ktp || files?.buktiBayar);
      let res: Response;
      let data: any;

      if (hasFiles) {
        const formData = new FormData();
        Object.entries(payload).forEach(([key, value]) => {
          if (value === undefined || value === null || value === '') return;
          formData.append(key, String(value));
        });
        if (files?.ktp) formData.append('ktp_file', files.ktp);
        if (files?.buktiBayar) formData.append('bukti_bayar_file', files.buktiBayar);

        res = await fetch('/api/reservations/upload', {
          method: 'POST',
          body: formData
        });
        data = await res.json();
      } else {
        res = await fetch('/api/reservations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        data = await res.json();
      }

      if (!res.ok) throw new Error(data.message || 'Failed to create reservation');
      fetchData();
      fetchOperationsData();
      setCreateResOpen(false);
      setSelectedRange({});
      setDiscountType('nominal');
      setDiscountValue('');
      setAmountPaid('');
      setSubtotalDraft(0);
      setKtpFile(null);
      setBuktiBayarFile(null);
      setReservationEditId(null);
      resetQuickBookingForm();
      alert('Reservasi berhasil dibuat');
    } catch (err) {
      console.error('Create reservation failed', err);
      alert('Gagal membuat reservasi: ' + (err instanceof Error ? err.message : 'Unknown'));
    }
  };

  const fetchReservationFolio = async (reservationId: number) => {
    try {
      const response = await fetch(`/api/reservations/${reservationId}/folio`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || 'Failed to load folio');
      }
      setSelectedFolio(data.data || null);
    } catch (error) {
      console.error('Failed to fetch reservation folio', error);
      setSelectedFolio(null);
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

      const updatedStatus = action === 'checkin' ? 'CHECKED_IN' : 'CHECKED_OUT';
      fetchData();
      fetchOperationsData();

      if (selectedRes) {
        setSelectedRes({ ...selectedRes, status: updatedStatus });
        fetchReservationFolio(reservationId);
      }

      if (action === 'checkout') {
        const checkoutReservation = reservations.find((item) => Number(item.id) === reservationId) || selectedRes;
        const checkoutDate = checkoutReservation?.check_out ? localDateISO(checkoutReservation.check_out) : localDateISO(new Date());

        if (checkoutReservation?.room_id) {
          const roomIdKey = String(checkoutReservation.room_id);
          const roomNumber = checkoutReservation.room_number || rooms.find((room: any) => String(room.id) === roomIdKey)?.room_number;
          if (!roomNumber) {
            throw new Error('Nomor kamar tidak ditemukan, housekeeping task tidak dapat dibuat.');
          }
          await addHousekeepingTask(
            roomNumber,
            'PENDING',
            'Kamar perlu dibersihkan setelah checkout tamu.',
            checkoutDate
          );
        }
      }

      alert(action === 'checkin' ? 'Check-in berhasil' : 'Check-out berhasil');
    } catch (error) {
      console.error(`Reservation ${action} failed`, error);
      alert(`Gagal ${action === 'checkin' ? 'check-in' : 'check-out'}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const openCheckoutConfirmation = (reservationId: number) => {
    setCheckoutPendingId(reservationId);
    setCheckoutConfirmOpen(true);
  };

  const cancelCheckoutConfirmation = () => {
    setCheckoutConfirmOpen(false);
    setCheckoutPendingId(null);
  };

  const confirmCheckout = async () => {
    if (checkoutPendingId === null) return;
    setCheckoutConfirmOpen(false);
    await handleReservationAction(checkoutPendingId, 'checkout');
    setCheckoutPendingId(null);
  };

  const closeDirtyConfirmation = () => {
    setDirtyConfirmOpen(false);
    setDirtyConfirmRoomId(null);
    setDirtyConfirmDate(null);
  };

  const getCellStatus = (roomId: number | string, date: string) => {
    if (date !== getOperationalDateKey()) return 'Ready';
    return normalizeRoomStatus(roomStatuses[String(roomId)] || 'Ready');
  };

  const confirmRoomCleaned = async () => {
    if (dirtyConfirmRoomId === null) return;
    const roomId = dirtyConfirmRoomId;
    const cleanupDate = dirtyConfirmDate || localDateISO(new Date());
    setDirtyConfirmOpen(false);
    setDirtyConfirmRoomId(null);
    setDirtyConfirmDate(null);

    try {
      const roomInfo = rooms.find((room: any) => String(room.id) === String(roomId));
      const roomNumber = roomInfo?.room_number;
      if (!roomNumber) {
        throw new Error('Nomor kamar tidak ditemukan untuk proses housekeeping.');
      }
      const matchingTask = housekeepingTasks.find((task: any) => {
        const taskRoom = String(task.room_number || '').trim();
        const taskDate = task.due_at ? localDateISO(new Date(task.due_at)) : '';
        return taskRoom === String(roomNumber)
          && task.task_type === 'ROOM_CLEANING'
          && String(task.status || '').toUpperCase() === 'PENDING'
          && taskDate === cleanupDate;
      });

      if (matchingTask?.id) {
        await updateHousekeepingTaskStatus(Number(matchingTask.id), 'DONE');
      } else {
        const createdTask = await addHousekeepingTask(
          roomNumber,
          'PENDING',
          'Menunggu konfirmasi pembersihan kamar.',
          cleanupDate
        );
        if (!createdTask?.id) {
          throw new Error('Gagal membuat housekeeping task pembersihan kamar.');
        }
        await updateHousekeepingTaskStatus(Number(createdTask.id), 'DONE');
      }
      fetchData();
      await fetchOperationsData();
    } catch (error) {
      setDirtyConfirmRoomId(roomId);
      setDirtyConfirmDate(cleanupDate);
      setDirtyConfirmOpen(true);
      console.error('Error marking room cleaned', error);
      alert(`Gagal mengubah status kamar: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handlePayment = async () => {
    if (!selectedRes || !paymentDraft) {
      alert('Masukkan nominal pembayaran terlebih dahulu');
      return;
    }

    try {
      const response = await fetch(`/api/reservations/${selectedRes.id}/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: Number(paymentDraft), payment_method: 'CASH', reference_code: `PMT-${Date.now()}` })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Failed to record payment');
      setPaymentDraft('');
      fetchData();
      fetchOperationsData();
      fetchReservationFolio(Number(selectedRes.id));
      alert('Pembayaran berhasil dicatat');
    } catch (error) {
      console.error('Payment failed', error);
      alert(`Gagal menyimpan pembayaran: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  useEffect(() => {
    if (selectedRes) {
      fetchReservationAudit(Number(selectedRes.id));
      if (selectedRes.room_id) {
        fetchRoomAudit(Number(selectedRes.room_id));
      }
    }
  }, [selectedRes?.id, selectedRes?.room_id]);

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

  const addHousekeepingTask = async (
    roomNumber: string | number | null,
    status: 'PENDING' | 'DONE',
    notes: string,
    dueDate?: string | null
  ) => {
    if (roomNumber === null || roomNumber === undefined || roomNumber === '') return;

    try {
      const dueAt = dueDate ? new Date(`${dueDate}T12:00:00`).toISOString() : new Date().toISOString();
      const response = await fetch('/api/housekeeping/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room_number: String(roomNumber),
          task_type: 'ROOM_CLEANING',
          priority: 'MEDIUM',
          status,
          assignee: 'Housekeeping',
          notes: dueDate ? `${notes} (target ${dueDate})` : notes,
          due_at: dueAt
        })
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.message || 'Failed to create housekeeping task');
      }

      await fetchOperationsData();
      return data.data;
    } catch (error) {
      console.error('Error creating housekeeping task', error);
      return null;
    }
  };

  const updateHousekeepingTaskStatus = async (taskId: number, status: 'PENDING' | 'DONE') => {
    const response = await fetch(`/api/housekeeping/tasks/${taskId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.message || `Gagal memperbarui housekeeping task (${response.status})`);
    }
    await fetchOperationsData();
    return data.data;
  };

  // Fungsi toggle status kamar dengan sinkronisasi ke backend
  const toggleStatus = async (roomId: string) => {
    const currentStatus = normalizeRoomStatus(roomStatuses[roomId] || 'Ready');
    const newStatus = currentStatus === 'Ready' ? 'Kotor' : 'Ready';

    try {
      const res = await fetch(`/api/rooms/${roomId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });

      const data = await res.json().catch(() => ({}));
      if (!(res.ok && data.status === 'SUCCESS')) {
        alert('Gagal memperbarui status kamar di database');
        return;
      }

      setRoomStatuses(prev => ({ ...prev, [roomId]: newStatus }));

      const roomInfo = rooms.find((room: any) => String(room.id) === String(roomId));
      const roomNumber = roomInfo?.room_number || roomId;
      await addHousekeepingTask(
        roomNumber,
        newStatus === 'Kotor' ? 'PENDING' : 'DONE',
        newStatus === 'Kotor'
          ? 'Kamar perlu dibersihkan dan siap untuk turnover housekeeping.'
          : 'Kamar telah dibersihkan dan siap digunakan kembali.'
      );
    } catch (err) {
      console.error('Error updating status:', err);
    }
  };

  const resetQuickBookingForm = () => {
    setQuickBooking({
      guestName: '',
      guestPhone: '',
      roomId: null,
      checkIn: '',
      checkOut: '',
      roomVariant: 'Deluxe King'
    });
  };

  const openQuickBooking = (roomId: number, startDate?: string, endDate?: string) => {
    const defaultStart = startDate || localDateISO(anchorDate);
    const defaultEnd = endDate || localDateISO(new Date(new Date(anchorDate).setDate(anchorDate.getDate() + 1)));
    setBookingType('walkin');
    setGuestSegment('Reguler');
    setDiscountType('nominal');
    setDiscountValue('');
    setAmountPaid('');
    setSubtotalDraft(0);
    setKtpFile(null);
    setBuktiBayarFile(null);
    setPrefillRoomId(roomId);
    setSelectedRange({ start: defaultStart, end: defaultEnd });
    setQuickBooking({
      guestName: '',
      guestPhone: '',
      roomId,
      checkIn: defaultStart,
      checkOut: defaultEnd,
      roomVariant: 'Deluxe King'
    });
    setCreateResOpen(true);
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
    <div className="hotel-app">
      <div className="hotel-statusbar">
        <div className="hotel-status-left">
          <span className="hotel-status-time">04:12</span>
          <span className="hotel-status-live" />
        </div>
        <div className="hotel-status-center">
          <span className="hotel-status-pill" />
        </div>
        <div className="hotel-status-right">
          <span className="hotel-status-icon">◔</span>
          <span className="hotel-status-icon">⚡</span>
          <span className="hotel-status-text">86%</span>
        </div>
      </div>

      <div className="hotel-layout">
        <aside className="hotel-sidebar">
          <div className="hotel-brand">OAK LAWANG</div>
          <nav className="hotel-nav">
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

        <main className="hotel-main">
          <header className="hotel-header">
           <div>
             <h2 className="hotel-header-title">OAK LAWANG</h2>
             <p className="hotel-header-subtitle">Selamat datang, vian.pradana89@gmail.com (Owner)</p>
           </div>
           <div className="hotel-header-actions">
             <button className="hotel-action-btn">POS</button>
             <button className="hotel-action-btn">Deposit</button>
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
                                    onClick={() => {
                                      setSelectedRes(r);
                                      fetchReservationFolio(Number(r.id));
                                    }}
                                    className={`reservation-card ${reservationStyle.cardClass} cursor-pointer truncate font-semibold`}
                                  >
                                    <div className="flex justify-between items-start">
                                      <div>
                                        <div className="flex items-center gap-2 flex-wrap">
                                          <div className="text-sm font-bold">{r.guest_name}</div>
                                          <span className={reservationStyle.badgeClass}>{reservationStyle.badge}</span>
                                          <span className={reservationStyle.segmentMeta.className}>{reservationStyle.segmentMeta.label}</span>
                                          {reservationStyle.paymentLabel && <span className="badge paid">{reservationStyle.paymentLabel}</span>}
                                        </div>
                                        <div className="text-xs opacity-80">{Math.max(1, Math.floor((new Date(r.check_out).getTime() - new Date(r.check_in).getTime())/(24*3600*1000)))} malam</div>
                                        <div className="text-xs opacity-80">{getPaymentStatusLabel(r.payment_status)}</div>
                                      </div>
                                      <div className="text-xs opacity-80 ml-2">{r.status}</div>
                                    </div>
                                  </div>
                                </td>
                              );
                              i += spanAt.span;
                            } else {
                              const day = days[i];
                              const currentStatus = getCellStatus(room.id, day.date);
                              const roomPhysicalStatus = normalizeRoomStatus(roomStatuses[String(room.id)] || 'Ready');
                              const canCleanDirtyNow = day.date === getOperationalDateKey() && roomPhysicalStatus === 'Kotor';
                              cells.push(
                                <td key={`${room.id}-${day.date}`} className="p-2 border text-center h-14 align-middle">
                                  <div
                                    className={`status-cell-wrap ${currentStatus === 'Ready' || canCleanDirtyNow ? 'status-cell-wrap--clickable' : ''}`}
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
                                    onClick={() => {
                                      if (currentStatus === 'Ready') {
                                        const nextDay = new Date(day.raw);
                                        nextDay.setDate(nextDay.getDate() + 1);
                                        openQuickBooking(room.id, day.date, localDateISO(nextDay));
                                      }
                                      if (canCleanDirtyNow) {
                                        setDirtyConfirmRoomId(Number(room.id));
                                        setDirtyConfirmDate(day.date);
                                        setDirtyConfirmOpen(true);
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
             <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
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
              <div className="booking-modal-backdrop">
                <div className="booking-modal">
                  <div className="booking-modal-header">
                    <h4 className="booking-modal-title">Tambah Booking</h4>
                    <button onClick={() => { setCreateResOpen(false); setDiscountType('nominal'); setDiscountValue(''); setAmountPaid(''); setSubtotalDraft(0); setKtpFile(null); setBuktiBayarFile(null); setReservationEditId(null); resetQuickBookingForm(); }} className="booking-modal-close" aria-label="Tutup dialog booking">×</button>
                  </div>

                  <div className="booking-type-switch" role="tablist" aria-label="Tipe booking">
                    <button
                      type="button"
                      className={bookingType === 'walkin' ? 'active' : ''}
                      onClick={() => setBookingType('walkin')}
                    >
                      Walk-in
                    </button>
                    <button
                      type="button"
                      className={bookingType === 'ota' ? 'active' : ''}
                      onClick={() => setBookingType('ota')}
                    >
                      OTA
                    </button>
                  </div>

                  <div className="booking-form-layout">
                    <div className="booking-main-panel">
                      <div className="booking-field booking-field--full">
                        <label>Nama Pelanggan</label>
                        <input
                          value={quickBooking.guestName}
                          onChange={(e) => setQuickBooking(prev => ({ ...prev, guestName: e.target.value }))}
                          placeholder="Ketik nama pelanggan..."
                        />
                      </div>
 
                      <div className="booking-field booking-field--full">
                        <label>Nomor HP *</label>
                        <input
                          value={quickBooking.guestPhone}
                          onChange={(e) => setQuickBooking(prev => ({ ...prev, guestPhone: e.target.value }))}
                          placeholder="Ketik nomor HP..."
                        />
                      </div>
 
                      <div className="booking-field booking-field--full">
                        <label>Segment Tamu</label>
                        <select value={guestSegment} onChange={(e) => setGuestSegment(e.target.value as 'Reguler' | 'Group' | 'Corporate')}>
                          <option value="Reguler">Reguler</option>
                          <option value="Group">Group</option>
                          <option value="Corporate">Corporate</option>
                        </select>
                      </div>
 
                      <div className="booking-row two-col">
                        <div className="booking-field">
                          <label>Ruangan *</label>
                          <select value={quickBooking.roomId ?? prefillRoomId ?? ''} onChange={(e) => {
                            const value = e.target.value ? Number(e.target.value) : null;
                            setPrefillRoomId(value);
                            setQuickBooking(prev => ({ ...prev, roomId: value }));
                          }}>
                            <option value="">Pilih ruang</option>
                            {rooms.map(r => <option key={r.id} value={r.id}>{r.room_number} {r.name}</option>)}
                          </select>
                        </div>
                        <div className="booking-field">
                          <label>Varian Kamar *</label>
                          <select value={quickBooking.roomVariant} onChange={(e) => setQuickBooking(prev => ({ ...prev, roomVariant: e.target.value }))}>
                            <option value="Deluxe King">Deluxe King</option>
                            <option value="Superior Twin">Superior Twin</option>
                            <option value="Suite Family">Suite Family</option>
                          </select>
                        </div>
                      </div>
 
                      <div className="booking-row two-col booking-date-row">
                        <div className="booking-field">
                          <label>Check In</label>
                          <input
                            type="date"
                            value={quickBooking.checkIn || selectedRange.start || localDateISO(anchorDate)}
                            onChange={(e) => setQuickBooking(prev => ({ ...prev, checkIn: e.target.value }))}
                          />
                        </div>
                        <div className="booking-field">
                          <label>Check Out</label>
                          <input
                            type="date"
                            value={quickBooking.checkOut || selectedRange.end || localDateISO(new Date(new Date(anchorDate).setDate(anchorDate.getDate()+1)))}
                            onChange={(e) => setQuickBooking(prev => ({ ...prev, checkOut: e.target.value }))}
                          />
                        </div>
                      </div>

                      <div className="booking-field booking-field--full">
                        <label>Harga Kamar</label>
                        <input
                          type="number"
                          min="0"
                          step="1000"
                          value={subtotalDraft}
                          onChange={(e) => setSubtotalDraft(Number(e.target.value || 0))}
                          placeholder="0"
                        />
                      </div>

                      <div className="booking-field booking-field--full">
                        <label>Diskon</label>
                        <div className="booking-discount-control">
                          <select value={discountType} onChange={(e) => setDiscountType(e.target.value as 'nominal' | 'percent')}>
                            <option value="nominal">Rp</option>
                            <option value="percent">%</option>
                          </select>
                          <input
                            type="number"
                            min="0"
                            step={discountType === 'percent' ? '1' : '1000'}
                            value={discountValue}
                            onChange={(e) => setDiscountValue(e.target.value)}
                            placeholder={discountType === 'percent' ? '0' : '50000'}
                          />
                        </div>
                      </div>

                      <div className="booking-field booking-field--full">
                        <label>Jumlah Dibayar / DP</label>
                        <input
                          type="number"
                          min="0"
                          step="1000"
                          value={amountPaid}
                          onChange={(e) => setAmountPaid(e.target.value)}
                          placeholder="0"
                        />
                      </div>

                      <div className="booking-optional">
                        <div className="booking-subtitle">Tambah Produk (Optional)</div>
                        <div className="booking-product-row">
                          <div className="booking-product-column">
                            <label>Nama Produk</label>
                            <input placeholder="Pilih atau ketik nama produk" />
                          </div>
                          <div className="booking-product-column short">
                            <label>Harga</label>
                            <input placeholder="25000" />
                          </div>
                        </div>
                        <div className="booking-product-row small">
                          <div className="booking-product-column"><label>Qty</label><input value="1" readOnly /></div>
                          <button type="button" className="booking-add-btn">Tambah</button>
                        </div>
                      </div>

                      <div className="booking-billing-box">
                        <div className="booking-subtitle">Billing / Nota</div>
                        <div className="booking-bill-row">
                          <span>Harga Kamar</span>
                          <strong>{formatCurrency(billingSummary.subtotal)}</strong>
                        </div>
                        <div className="booking-bill-row">
                          <span>Diskon</span>
                          <strong>- {formatCurrency(billingSummary.discount)}</strong>
                        </div>
                        <div className="booking-bill-row total">
                          <span>Total Keseluruhan</span>
                          <strong>{formatCurrency(billingSummary.total)}</strong>
                        </div>
                        <div className="booking-bill-row">
                          <span>Jumlah Dibayar</span>
                          <strong>{formatCurrency(billingSummary.paid)}</strong>
                        </div>
                        <div className="booking-bill-row">
                          <span>Kekurangan Pembayaran / Sisa Tagihan</span>
                          <strong>{formatCurrency(billingSummary.remaining)}</strong>
                        </div>
                      </div>
                    </div>

                    <div className="booking-side-panel">
                      <div className="booking-side-summary">
                        <div className="booking-summary-row">
                          <span>Status</span>
                          <strong>Booked</strong>
                        </div>
                        <div className="booking-summary-row">
                          <span>Room</span>
                          <strong>{prefillRoomId ? rooms.find(r => r.id === prefillRoomId)?.room_number || 'Pilih kamar' : 'Pilih kamar'}</strong>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="booking-document-section">
                    <div className="booking-subtitle">Upload Dokumen</div>
                    <div className="booking-doc-row">
                      <div className="booking-doc-field">
                        <label>Upload KTP</label>
                        <input
                          type="file"
                          accept=".jpg,.jpeg,.png,.pdf"
                          onChange={(e) => setKtpFile(e.target.files && e.target.files[0] ? e.target.files[0] : null)}
                        />
                        {ktpFile && <span className="booking-file-name">{ktpFile.name}</span>}
                      </div>
                      <div className="booking-doc-field">
                        <label>Bukti Bayar</label>
                        <input
                          type="file"
                          accept=".jpg,.jpeg,.png,.pdf"
                          onChange={(e) => setBuktiBayarFile(e.target.files && e.target.files[0] ? e.target.files[0] : null)}
                        />
                        {buktiBayarFile && <span className="booking-file-name">{buktiBayarFile.name}</span>}
                      </div>
                    </div>
                  </div>

                  <div className="booking-modal-actions">
                    <button onClick={() => {
                      setCreateResOpen(false);
                      setDiscountType('nominal');
                      setDiscountValue('');
                      setAmountPaid('');
                      setSubtotalDraft(0);
                      setKtpFile(null);
                      setBuktiBayarFile(null);
                      setReservationEditId(null);
                      resetQuickBookingForm();
                    }} className="booking-cancel-btn">Batal</button>
                    <button onClick={async () => {
                      const roomId = quickBooking.roomId ?? prefillRoomId;
                      const ci = quickBooking.checkIn || selectedRange.start || '';
                      const co = quickBooking.checkOut || selectedRange.end || '';
                      const name = quickBooking.guestName.trim() || 'Tamu';
                      const phone = quickBooking.guestPhone.trim();

                      if (!roomId) { alert('Pilih kamar'); return; }
                      if (!ci || !co) { alert('Isi check-in dan check-out'); return; }
                      if (new Date(co) <= new Date(ci)) { alert('Tanggal check-out harus setelah check-in'); return; }
                      if (!phone) { alert('Nomor HP tamu wajib diisi'); return; }

                      const payload = {
                        room_id: roomId,
                        guest_name: name,
                        guest_phone: phone,
                        guest_segment: guestSegment,
                        booking_type: bookingType,
                        source: bookingType,
                        check_in: ci,
                        check_out: co,
                        subtotal_amount: subtotalDraft,
                        total_price: subtotalDraft,
                        discount_amount: billingSummary.discount,
                        discount_percent: discountType === 'percent' ? Number(discountValue || 0) : 0,
                        amount_paid: Number(amountPaid || 0),
                        payment_status: billingSummary.paymentStatus,
                        room_variant: quickBooking.roomVariant
                      };
                      await createReservation(payload, { ktp: ktpFile, buktiBayar: buktiBayarFile });
                    }} className="booking-submit-btn">Simpan Reservasi</button>
                  </div>
                </div>
              </div>
            )}

          </>
        )}

        {selectedMenu === 'Transaksi' && (
          <div className="space-y-4">
            <div className="bg-white border rounded shadow-sm p-4">
              <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
                <h3 className="font-bold text-sm">Reservasi Terbaru</h3>
                <div className="booking-list-filter">
                  {[
                    { key: 'all', label: 'Semua' },
                    { key: 'booked', label: 'Booked' },
                    { key: 'checked_in', label: 'Check-in' },
                    { key: 'checked_out', label: 'Check-out' },
                  ].map((filter) => (
                    <button
                      key={filter.key}
                      type="button"
                      className={`booking-list-chip ${reservationFilter === filter.key ? 'active' : ''}`}
                      onClick={() => setReservationFilter(filter.key as any)}
                    >
                      {filter.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="booking-list-toolbar">
                <div className="booking-list-search-wrap">
                  <span className="booking-list-search-icon">⌕</span>
                  <input
                    type="text"
                    value={reservationSearch}
                    onChange={(e) => setReservationSearch(e.target.value)}
                    placeholder="Cari tamu / kamar / HP..."
                    className="booking-list-search-input"
                  />
                </div>
                <div className="booking-list-date-range">
                  <label>
                    <span>Dari</span>
                    <input type="date" value={reservationDateFrom} onChange={(e) => setReservationDateFrom(e.target.value)} />
                  </label>
                  <label>
                    <span>Sampai</span>
                    <input type="date" value={reservationDateTo} onChange={(e) => setReservationDateTo(e.target.value)} />
                  </label>
                </div>
              </div>

              <div className="grid grid-cols-4 gap-3 mb-4">
                {[
                  { label: 'Semua', value: reservations.length, cls: 'bg-slate-100 text-slate-700' },
                  { label: 'Booked', value: reservations.filter((r) => String(r.status || '').toUpperCase() !== 'CHECKED_IN' && String(r.status || '').toUpperCase() !== 'CHECKED_OUT' && String(r.status || '').toUpperCase() !== 'CANCELLED').length, cls: 'bg-amber-100 text-amber-700' },
                  { label: 'Check-in', value: reservations.filter((r) => String(r.status || '').toUpperCase() === 'CHECKED_IN').length, cls: 'bg-emerald-100 text-emerald-700' },
                  { label: 'Check-out', value: reservations.filter((r) => String(r.status || '').toUpperCase() === 'CHECKED_OUT').length, cls: 'bg-slate-200 text-slate-700' },
                ].map((meta) => (
                  <div key={meta.label} className={`rounded-xl p-3 ${meta.cls}`}>
                    <div className="text-[10px] uppercase font-bold tracking-wide opacity-80">{meta.label}</div>
                    <div className="text-xl font-bold mt-1">{meta.value}</div>
                  </div>
                ))}
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full text-xs booking-list-table">
                  <thead>
                    <tr className="bg-slate-100 text-left text-slate-600">
                      <th className="px-3 py-2 font-semibold">Tamu</th>
                      <th className="px-3 py-2 font-semibold">Kamar</th>
                      <th className="px-3 py-2 font-semibold">Check-in / Out</th>
                      <th className="px-3 py-2 font-semibold">Segment</th>
                      <th className="px-3 py-2 font-semibold">Pembayaran</th>
                      <th className="px-3 py-2 font-semibold">Tagihan</th>
                      <th className="px-3 py-2 font-semibold text-right">Aksi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(filteredReservations || []).slice(0, 12).map((res: any) => {
                      const paymentStatus = getPaymentStatusLabel(res.payment_status);
                      const statusClass = getPaymentBadgeClass(res.payment_status);
                      const rowStatus = String(res.status || '').toUpperCase();
                      return (
                        <tr
                          key={res.id}
                          className="booking-list-row"
                          onClick={() => {
                            setSelectedRes(res);
                            fetchReservationFolio(Number(res.id));
                          }}
                        >
                          <td className="px-3 py-2">
                            <div className="font-semibold text-slate-800">{res.guest_name}</div>
                            <div className="text-slate-500">{res.guest_phone || '-'}</div>
                          </td>
                          <td className="px-3 py-2">{res.room_number || res.room_id}</td>
                          <td className="px-3 py-2">
                            <div>{res.check_in ? res.check_in.split('T')[0] : '-'}</div>
                            <div className="text-slate-500">{res.check_out ? res.check_out.split('T')[0] : '-'}</div>
                          </td>
                          <td className="px-3 py-2">
                            <span className={`segment-badge segment-${(res.guest_segment || 'Reguler').toLowerCase()}`}>
                              {res.guest_segment || 'Reguler'}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <span className={`segment-badge ${statusClass}`}>
                              {paymentStatus}
                            </span>
                          </td>
                          <td className="px-3 py-2 font-semibold text-slate-700">
                            {formatCurrency(Number(res.total_price || res.subtotal_amount || 0))}
                          </td>
                          <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                            <div className="booking-list-actions">
                              <button type="button" className="booking-action-btn booking-action-btn--edit" onClick={() => openReservationEditor(res)}>Edit</button>
                              <button type="button" className="booking-action-btn booking-action-btn--cancel" onClick={() => handleReservationCancel(Number(res.id))}>Cancel</button>
                              {rowStatus !== 'CHECKED_IN' && rowStatus !== 'CANCELLED' && (
                                <button type="button" className="booking-action-btn booking-action-btn--checkin" onClick={() => handleReservationAction(Number(res.id), 'checkin')}>Check In</button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

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
      </div>

      {selectedRes && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="reservation-detail-modal bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[88vh] overflow-y-auto">
            <div className="reservation-detail-header">
              <div>
                <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500 font-bold">Reservasi</div>
                <h3 className="reservation-detail-title">Detail Reservasi</h3>
              </div>
              <button onClick={() => { setSelectedRes(null); setSelectedFolio(null); setPaymentDraft(''); }} className="reservation-detail-close">Tutup</button>
            </div>

            <div className="reservation-detail-body">
              <div className="reservation-detail-topbar">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500 font-bold">Tamu</div>
                  <div className="reservation-detail-name">{selectedRes.guest_name}</div>
                </div>
                <div className="reservation-detail-badges">
                  <span className={`segment-badge ${(selectedRes.guest_segment || 'Reguler').toLowerCase() === 'group' ? 'segment-group' : (selectedRes.guest_segment || 'Reguler').toLowerCase() === 'corporate' ? 'segment-corporate' : 'segment-reguler'}`}>
                    {selectedRes.guest_segment || 'Reguler'}
                  </span>
                  <span className={`segment-badge ${getPaymentBadgeClass(selectedRes.payment_status)}`}>
                    {getPaymentStatusLabel(selectedRes.payment_status)}
                  </span>
                </div>
              </div>

              <div className="reservation-detail-grid">
                <div className="detail-info-card">
              <div className="detail-card-label">Nomor Reservasi</div>
              <div className="detail-card-value">{selectedRes.booking_number || selectedRes.id}</div>
                  <div className="detail-card-meta">{selectedRes.status || 'CONFIRMED'}</div>
                </div>
                <div className="detail-info-card">
              <div className="detail-card-label">Informasi Kamar</div>
              <div className="detail-card-value">{selectedRes.room_number || selectedRes.room_id}</div>
              <div className="detail-card-meta">{selectedRes.room_variant || 'Deluxe King'}</div>
                </div>
                <div className="detail-info-card">
              <div className="detail-card-label">Durasi</div>
              <div className="detail-card-value">
                {Math.max(1, Math.floor((new Date(selectedRes.check_out || selectedRes.check_in).getTime() - new Date(selectedRes.check_in || selectedRes.check_out).getTime()) / (24 * 60 * 60 * 1000))) || 1} malam
              </div>
              <div className="detail-card-meta">{selectedRes.check_in ? selectedRes.check_in.split('T')[0] : '-'} → {selectedRes.check_out ? selectedRes.check_out.split('T')[0] : '-'}</div>
                </div>
                <div className="detail-info-card">
                  <div className="detail-card-label">Tagihan</div>
                  <div className="detail-card-value">{formatCurrency(Number(selectedRes.total_price || selectedRes.subtotal_amount || 0))}</div>
                  <div className="detail-card-meta">Sisa: {formatCurrency(Number(selectedRes.remaining_balance || 0))}</div>
                </div>
              </div>

              <div className="reservation-detail-summary">
                <div className="summary-box">
                  <div className="summary-box-head">Pembayaran</div>
                  <div className="summary-box-row"><span>Diskon</span><strong>{formatCurrency(Number(selectedRes.discount_amount || 0))}</strong></div>
                  <div className="summary-box-row"><span>Jumlah dibayar</span><strong>{formatCurrency(Number(selectedRes.amount_paid || 0))}</strong></div>
                  <div className="summary-box-row total"><span>Sisa tagihan</span><strong>{formatCurrency(Number(selectedRes.remaining_balance || 0))}</strong></div>
                </div>
                <div className="summary-box">
                  <div className="summary-box-head">Folio</div>
                  <div className="summary-box-row"><span>Total tagihan</span><strong>{formatCurrency(Number(selectedRes.total_price || 0))}</strong></div>
                  <div className="summary-box-row"><span>Sudah dibayar</span><strong>{formatCurrency(Number(selectedFolio?.payments?.reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0) || 0))}</strong></div>
                  <div className="summary-box-row total"><span>Sisa</span><strong>{formatCurrency(Math.max(Number(selectedRes.total_price || 0) - (selectedFolio?.payments?.reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0) || 0), 0))}</strong></div>
                </div>
              </div>

              {(selectedRes.ktp_path || selectedRes.bukti_bayar_path) && (
                <div className="reservation-doc-panel">
                  <div className="reservation-doc-title">Dokumen Tamu</div>
                  <div className="reservation-doc-grid">
                    {selectedRes.ktp_path && (
                      <a
                        href={selectedRes.ktp_path.startsWith('http') ? selectedRes.ktp_path : `http://localhost:5000${selectedRes.ktp_path}`}
                        target="_blank"
                        rel="noreferrer"
                        className="reservation-doc-link"
                      >
                        <span className="reservation-doc-tag">KTP</span>
                        <span>Lihat KTP</span>
                      </a>
                    )}
                    {selectedRes.bukti_bayar_path && (
                      <a
                        href={selectedRes.bukti_bayar_path.startsWith('http') ? selectedRes.bukti_bayar_path : `http://localhost:5000${selectedRes.bukti_bayar_path}`}
                        target="_blank"
                        rel="noreferrer"
                        className="reservation-doc-link"
                      >
                        <span className="reservation-doc-tag">Bayar</span>
                        <span>Lihat Bukti Bayar</span>
                      </a>
                    )}
                  </div>
                </div>
              )}

              {selectedRes.room_id && (
                <div className="reservation-doc-panel">
                  <div className="reservation-doc-title">Turnover kamar</div>
                  <div className="reservation-turnover-row">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.12em] text-slate-500 font-bold">Status</div>
                      <div className="font-bold text-slate-800">
                        {normalizeRoomStatus(roomStatuses[String(selectedRes.room_id)] || 'Ready')}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="reservation-turnover-button"
                      onClick={() => toggleStatus(String(selectedRes.room_id))}
                    >
                      {normalizeRoomStatus(roomStatuses[String(selectedRes.room_id)] || 'Ready') === 'Kotor'
                        ? 'Tandai siap pakai'
                        : 'Tandai kamar kotor'}
                    </button>
                  </div>
                </div>
              )}

              {reservationAudit.length ? (
                <div className="reservation-audit-panel">
                  <div className="reservation-doc-title">Audit trail</div>
                  <div className="reservation-audit-list">
                    {reservationAudit.slice(0, 8).map((audit: any) => (
                      <div key={`${audit.audit_id || audit.id}-${audit.timestamp}`} className="reservation-audit-item">
                        <div className="reservation-audit-icon">
                          {String(audit.action || 'UPDATE').slice(0, 1).toUpperCase()}
                        </div>
                        <div className="reservation-audit-copy">
                          <div className="font-semibold text-slate-800">{audit.action || 'UPDATE'}</div>
                          <div className="text-[11px] text-slate-500">
                            {audit.module || 'PMS'} • {audit.timestamp ? new Date(audit.timestamp).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '—'}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {selectedFolio?.folio?.length ? (
                <div className="reservation-folio-panel">
                  <div className="reservation-doc-title">Riwayat folio</div>
                  <div className="space-y-2 text-xs">
                    {selectedFolio.folio.map((entry: any, idx: number) => (
                      <div key={idx} className="flex justify-between border-b pb-1 last:border-0">
                        <span>{entry.description || 'Entry'}</span>
                        <span className={Number(entry.amount || 0) > 0 ? 'text-slate-700' : 'text-red-600'}>
                          {formatCurrency(Number(entry.amount || 0))}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="reservation-payment-panel">
                <label className="text-xs font-semibold text-slate-700">Pembayaran baru</label>
                <div className="reservation-payment-row">
                  <input
                    type="number"
                    value={paymentDraft}
                    onChange={(e) => setPaymentDraft(e.target.value)}
                    placeholder="Masukkan nominal"
                    className="flex-1 border rounded px-3 py-2 text-sm"
                  />
                  <button onClick={handlePayment} className="bg-blue-600 text-white px-3 py-2 rounded text-sm">Bayar</button>
                </div>
              </div>

              <div className="reservation-action-row">
                {selectedRes.status === 'CHECKED_IN' ? (
                  <button onClick={() => openCheckoutConfirmation(Number(selectedRes.id))} className="reservation-action-button reservation-action-button--warn">Check Out</button>
                ) : (
                  <button onClick={() => handleReservationAction(Number(selectedRes.id), 'checkin')} className="reservation-action-button reservation-action-button--success">Check In</button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {checkoutConfirmOpen && (
        <div className="booking-modal-backdrop" role="dialog" aria-modal="true">
          <div className="checkout-confirm-modal">
            <div className="checkout-confirm-icon">?</div>
            <h3 className="checkout-confirm-title">Konfirmasi Check-out</h3>
            <p className="checkout-confirm-text">Apakah jaminan deposit sudah dikembalikan kepada tamu?</p>
            <div className="checkout-confirm-actions">
              <button type="button" className="checkout-confirm-btn checkout-confirm-btn--secondary" onClick={cancelCheckoutConfirmation}>
                Belum
              </button>
              <button type="button" className="checkout-confirm-btn checkout-confirm-btn--primary" onClick={confirmCheckout}>
                Sudah
              </button>
            </div>
          </div>
        </div>
      )}

      {dirtyConfirmOpen && (
        <div className="booking-modal-backdrop" role="dialog" aria-modal="true">
          <div className="checkout-confirm-modal">
            <div className="checkout-confirm-icon">🧹</div>
            <h3 className="checkout-confirm-title">Konfirmasi Pembersihan</h3>
            <p className="checkout-confirm-text">Apakah kamar ini sudah dibersihkan?</p>
            <div className="checkout-confirm-actions">
              <button type="button" className="checkout-confirm-btn checkout-confirm-btn--secondary" onClick={closeDirtyConfirmation}>
                Belum
              </button>
              <button type="button" className="checkout-confirm-btn checkout-confirm-btn--primary" onClick={confirmRoomCleaned}>
                Sudah
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NavItem({ label, active, onClick }: any) {
  return (
    <div onClick={onClick} className={`hotel-nav-item ${active ? 'hotel-nav-item--active' : ''}`}>
      <span>{label}</span>
    </div>
  );
}

function StatCard({ title, value, color }: any) {
  return (
    <div className={`hotel-stat-card ${color}`}>
      <p className="hotel-stat-label">{title}</p>
      <p className="hotel-stat-value">{value}</p>
    </div>
  );
}

export default App;