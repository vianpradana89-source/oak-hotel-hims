import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { TransactionReservationList } from './features/transactions/TransactionReservationList.tsx';
import { GuestCrmWorkspace } from './features/guests/GuestCrmWorkspace.tsx';
import { OccupancySection } from './features/reports/OccupancySection.tsx';
import ProductInventorySection from './features/productInventory/ProductInventorySection';
import type { ActiveRoomReservation } from './features/roomMaster/roomMasterTypes';
import CalendarFilters from './features/calendar/CalendarFilters';
import ReservationBar from './features/calendar/ReservationBar';
import RoomCategoryGroup from './features/calendar/RoomCategoryGroup';
import RoomTypeGroup from './features/calendar/RoomTypeGroup';
import { buildAvailabilityRequest, fetchTapechart, parseAvailabilityKey } from './features/calendar/calendarApi';
import {
  addHotelDays,
  buildHotelDateWindow,
  formatCompactHotelDate,
  hotelDateFromInstant,
  hotelDateToLocalDate,
  hotelDateRangesOverlap,
  hotelNightsBetween,
  normalizeHotelDate,
} from './features/calendar/calendarDates';
import {
  normalizeReservationLifecycle,
  type CalendarOperationalFilter,
  type RoomCategoryCalendarGroup,
  type CalendarRoom,
} from './features/calendar/calendarTypes';
import {
  additionalBookingChildOverrides,
  canonicalBookingChildRoomId,
  canonicalCalendarRoomBinding,
  canonicalRoomClassification,
  hasOverlappingPriorSiblingRoomSelection,
  removeBookingChildById,
  resolveBookingChildRoomId,
  updateBookingChildById,
} from './features/booking/bookingComposerState';

function buildWeekDays(anchorDate = new Date(), todayIndex = 2, windowSize = 7) {
  const hotelDates = buildHotelDateWindow(hotelDateFromInstant(anchorDate), todayIndex, windowSize);
  const labelsByDay: Record<number,string> = { 0: 'MIN', 1: 'SEN', 2: 'SEL', 3: 'RAB', 4: 'KAM', 5: 'JUM', 6: 'SAB' };

  return hotelDates.map((iso) => {
    const date = hotelDateToLocalDate(iso) || new Date();
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
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function App() {
  const [propertyId, setPropertyId] = useState<number | null>(null);
  const [properties, setProperties] = useState<any[]>([]);
  const [reservations, setReservations] = useState<any[]>([]);
  const [rooms, setRooms] = useState<any[]>([]);
  const [selectedRes, setSelectedRes] = useState<any>(null);
  const [selectedFolio, setSelectedFolio] = useState<any>(null);
  const [reservationAudit, setReservationAudit] = useState<any[]>([]);
  const [selectedBooking, setSelectedBooking] = useState<any>(null);
  const [selectedBookingChildren, setSelectedBookingChildren] = useState<any[]>([]);
  const [bidCopyState, setBidCopyState] = useState<{ kind: 'idle' | 'success' | 'error'; message: string }>({ kind: 'idle', message: '' });
  const [paymentDraft, setPaymentDraft] = useState<string>('');
  const [roomStatuses, setRoomStatuses] = useState<Record<string, string>>({});
  const [housekeepingTasks, setHousekeepingTasks] = useState<any[]>([]);
  const [maintenanceTasks, setMaintenanceTasks] = useState<any[]>([]);
  const [posOrders, setPosOrders] = useState<any[]>([]);
  const [posMenu, setPosMenu] = useState<any[]>([]);
  const [financeSummary, setFinanceSummary] = useState<any>(null);
  const [employees, setEmployees] = useState<any[]>([]);
  const [payroll, setPayroll] = useState<any[]>([]);
  const [selectedMenu, setSelectedMenu] = useState<'Kalender' | 'Transaksi' | 'Laporan' | 'Produk & Inventori' | 'Pelanggan' | 'Pengaturan'>('Kalender');
  const [calendarSearch, setCalendarSearch] = useState('');
  const [calendarRoomSearch, setCalendarRoomSearch] = useState('');
  const [calendarRoomCategoryFilter, setCalendarRoomCategoryFilter] = useState('');
  const [calendarRoomTypeFilter, setCalendarRoomTypeFilter] = useState('');
  const [calendarOperationalFilter, setCalendarOperationalFilter] = useState<CalendarOperationalFilter>('');
  const [calendarIncludeInactive, setCalendarIncludeInactive] = useState(false);
  const [collapsedCalendarGroups, setCollapsedCalendarGroups] = useState<Set<string>>(() => new Set());

  const [transactionReservations, setTransactionReservations] = useState<any[]>([]);
  const [transactionLoading, setTransactionLoading] = useState<boolean>(false);
  const [transactionError, setTransactionError] = useState<string | null>(null);
  const transactionRequestVersionRef = useRef(0);
  const transactionPeriodRangeRef = useRef<{ startDate: string; endDateExclusive: string } | null>(null);

  const [dailyOperations, setDailyOperations] = useState<any | null>(null);
  const [dailyOperationsLoading, setDailyOperationsLoading] = useState<boolean>(false);
  const dailyOperationsRequestVersionRef = useRef(0);
  const [occupancyRefreshTrigger, setOccupancyRefreshTrigger] = useState<number>(0);
  const selectedMenuRef = useRef(selectedMenu);
  selectedMenuRef.current = selectedMenu;
  const [quickBooking, setQuickBooking] = useState({
    guestName: '',
    guestPhone: '',
    roomId: null as number | null,
    roomTypeId: null as number | null,
    checkIn: '',
    checkOut: '',
    roomVariant: ''
  });
  const [bookingComposerChildren, setBookingComposerChildren] = useState<any[]>([]);
  const bookingComposerChildrenRef = useRef<any[]>([]);
  const [childRoomAvailability, setChildRoomAvailability] = useState<Record<string, any[]>>({});
  const [availabilityCache, setAvailabilityCache] = useState<Record<string, any[]>>({});
  const [bookingAvailabilityState, setBookingAvailabilityState] = useState<Record<string, 'idle' | 'loading' | 'success' | 'empty' | 'error'>>({});
  const [bookingSubmitting, setBookingSubmitting] = useState(false);
  const availabilityRequestVersionRef = useRef<Record<string, number>>({});
  const availabilityRequestPromiseRef = useRef<Record<string, Promise<void> | undefined>>({});
  const availabilityRequestFailedRef = useRef<Record<string, number>>({});
  const availabilityRequestSequenceRef = useRef(0);

  useEffect(() => {
    bookingComposerChildrenRef.current = bookingComposerChildren;
  }, [bookingComposerChildren]);

  useEffect(() => {
    fetch('/api/properties')
      .then(r => r.json())
      .then(d => {
        if (d.status === 'OK' && Array.isArray(d.data)) {
          const list = d.data.filter((p: any) => p.is_active !== false);
          setProperties(list);
          if (list.length === 1) {
            setPropertyId(list[0].id);
          } else if (list.length === 0) {
            setPropertyId(null);
          }
          // multiple: propertyId stays null until user selects
        }
      })
      .catch(() => {});
  }, []);
  // Anchor date for the grid window and handlers to shift the window
  const [anchorDate, setAnchorDate] = useState<Date>(new Date());
  const [windowSize, setWindowSize] = useState<number>(7);
  const [isMonthView, setIsMonthView] = useState<boolean>(false);
  const [calendarOpen, setCalendarOpen] = useState<boolean>(false);
  const [calendarViewDate, setCalendarViewDate] = useState<Date>(new Date());
  const [calendarSelectedDate, setCalendarSelectedDate] = useState<string | null>(hotelDateFromInstant(new Date()));
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
  const [ktpFile, setKtpFile] = useState<File | null>(null);
  const [buktiBayarFile, setBuktiBayarFile] = useState<File | null>(null);
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
      const shifted = addHotelDays(hotelDateFromInstant(prev), delta);
      return hotelDateToLocalDate(shifted) || prev;
    });
  };
  const goToday = () => {
    setWindowSize(7);
    setIsMonthView(false);
    setAnchorDate(hotelDateToLocalDate(hotelDateFromInstant(new Date())) || new Date());
  };
  const [reservationResizePreview, setReservationResizePreview] = useState<Record<string, string>>({});
  const [reservationResizeState, setReservationResizeState] = useState<{ reservationId: number; startX: number; startCheckOut: string; pointerId: number } | null>(null);
  const reservationResizeRef = useRef<{ reservationId: number; startX: number; startCheckOut: string; pointerId: number } | null>(null);
  const reservationResizePreviewRef = useRef<Record<string, string>>({});
  const fetchDataRef = useRef<() => Promise<void>>(async () => undefined);
  const tapechartRequestVersionRef = useRef(0);

  // drag preview using setDragImage + cleanup element
  const handleDragStart = (e: any, r: any, fromRoomId: any) => {
    try {
      const target = e.target as HTMLElement | null;
      if (target && target.closest && target.closest('.reservation-card-resize-handle')) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
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

  const handleReservationResizeMouseDown = (event: any, reservation: any) => {
    const status = String(reservation?.status || '').toUpperCase();
    if (!reservation || (status !== 'BOOKED' && status !== 'CHECKED_IN')) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'none';
      event.dataTransfer.dropEffect = 'none';
    }

    const startCheckOut = normalizeHotelDate(reservation.check_out) || hotelDateFromInstant(new Date());
    const resizeState = {
      reservationId: Number(reservation.id),
      startX: event.clientX,
      startCheckOut,
      pointerId: event.pointerId
    };
    reservationResizeRef.current = resizeState;
    reservationResizePreviewRef.current = {
      ...reservationResizePreviewRef.current,
      [String(reservation.id)]: startCheckOut
    };
    setReservationResizeState(resizeState);
    setReservationResizePreview(reservationResizePreviewRef.current);

    console.log('RESIZE_DOWN', {
      reservationId: Number(reservation.id),
      originalCheckOut: startCheckOut,
      checkIn: normalizeHotelDate(reservation.check_in) || null,
      pointerId: event.pointerId,
      clientX: event.clientX
    });

    if (event.currentTarget && typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
      console.log('RESIZE_CAPTURE_SET', { pointerId: event.pointerId, reservationId: Number(reservation.id) });
    }
  };

  const displayedReservations = useMemo(() => {
    const previewMap = reservationResizePreviewRef.current;

    return reservations.map((reservation) => {
      const previewCheckOut = previewMap[String(reservation.id)] ?? reservationResizePreview[String(reservation.id)];
      if (!previewCheckOut) return reservation;
      return { ...reservation, check_out: previewCheckOut };
    });
  }, [reservationResizePreview, reservations]);

  const reservationSpans = useMemo(() => {
    const map: Record<string, Array<any>> = {};

    const getNightlySpan = (checkIn: string, checkOut: string) => {
      const ci = normalizeHotelDate(checkIn);
      const co = normalizeHotelDate(checkOut);
      if (!ci || !co || ci === co) return null;

      const firstVisibleDate = days[0]?.date;
      const visibleRangeEnd = days.length > 0 ? addHotelDays(days[days.length - 1].date, 1) : '';
      if (!firstVisibleDate || !visibleRangeEnd || co <= firstVisibleDate || ci >= visibleRangeEnd) return null;

      const startIndex = days.findIndex(d => d.date === ci);
      const endIndex = days.findIndex(d => d.date === co);

      const visibleStart = startIndex === -1 && ci < firstVisibleDate ? 0 : startIndex;
      const visibleEnd = endIndex === -1 && co >= visibleRangeEnd ? days.length : endIndex;
      if (visibleStart < 0 || visibleEnd < 0 || visibleEnd <= visibleStart) return null;
      // Nightly stay is inclusive on check-in and exclusive on check-out.
      // Example: 20 -> 21 blocks only date 20; 20 -> 28 blocks 20..27.
      const span = Math.max(1, visibleEnd - visibleStart);
      return { startIndex: visibleStart, span };
    };

    for (const r of displayedReservations) {
      const { status } = normalizeReservationLifecycle(r?.status);
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
  }, [displayedReservations, days]);

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

    const d = hotelDateToLocalDate(calendarSelectedDate);
    if (!d) {
      setCalendarOpen(false);
      return;
    }

    setCalendarViewDate(d);
    setAnchorDate(d);
    setIsMonthView(false);
    setWindowSize(7);
    setCalendarOpen(false);
  };

  const normalizeRoomStatus = (status: string | undefined) => {
    const value = String(status || '').toUpperCase();
    if (value === 'VACANT_DIRTY' || value === 'OCCUPIED_DIRTY' || value.includes('DIRTY') || value === 'KOTOR') return 'Kotor';
    if (value === 'CLEANING' || value === 'OUT_OF_ORDER' || value === 'OUT_OF_SERVICE' || value.includes('MAINT')) return 'Maintenance';
    if (value === 'OCCUPIED_CLEAN' || value === 'OCCUPIED_DIRTY' || value.includes('OCC')) return 'Occupied';
    if (value === 'VACANT_CLEAN' || value === 'INSPECTED') return 'Ready';
    return 'Ready';
  };

  const getRoomTypeName = (room: any) => String(room?.name || room?.room_type || 'Standard Room').trim() || 'Standard Room';

  const calendarTypeOptions = useMemo(() => {
    const options = new Map<number, { id: number; label: string; displayOrder: number }>();
    for (const room of rooms as CalendarRoom[]) {
      if (room.room_type_id == null) continue;
      const id = Number(room.room_type_id);
      const code = String(room.room_type_code || '').trim();
      const name = String(room.room_type_name || room.name || '').trim();
      options.set(id, {
        id,
        label: code && code !== name ? `${name} (${code})` : name,
        displayOrder: Number(room.room_type_display_order || 0),
      });
    }
    return Array.from(options.values()).sort((a, b) =>
      a.displayOrder - b.displayOrder
      || a.label.localeCompare(b.label, 'id-ID', { numeric: true })
      || a.id - b.id
    );
  }, [rooms]);

  const calendarCategoryOptions = useMemo(() => {
    const options = new Map<number, { id: number; label: string; displayOrder: number }>();
    for (const room of rooms as CalendarRoom[]) {
      if (room.room_category_id == null) continue;
      const id = Number(room.room_category_id);
      const code = String(room.room_category_code || '').trim();
      const name = String(room.room_category_name || '').trim();
      options.set(id, {
        id,
        label: code && code !== name ? `${name} (${code})` : name,
        displayOrder: Number(room.room_category_display_order || 0),
      });
    }
    return Array.from(options.values()).sort((a, b) =>
      a.displayOrder - b.displayOrder
      || a.id - b.id
    );
  }, [rooms]);

  const calendarFilterTypeOptions = useMemo(() => {
    if (!calendarRoomCategoryFilter) return calendarTypeOptions;
    const allowedTypeIds = new Set(
      (rooms as CalendarRoom[])
        .filter((room) => String(room.room_category_id ?? '') === calendarRoomCategoryFilter)
        .map((room) => Number(room.room_type_id))
        .filter((roomTypeId) => Number.isInteger(roomTypeId) && roomTypeId > 0)
    );
    return calendarTypeOptions.filter((option) => allowedTypeIds.has(option.id));
  }, [calendarRoomCategoryFilter, calendarTypeOptions, rooms]);

  const visibleCalendarRooms = useMemo(() => {
    const roomQuery = calendarRoomSearch.trim().toLowerCase();
    return (rooms as CalendarRoom[]).filter((room) => {
      const masterActive = room.room_type_id !== null && room.room_is_active !== false && room.room_type_is_active !== false;
      if (!calendarIncludeInactive && !masterActive) return false;
      if (calendarRoomCategoryFilter && String(room.room_category_id ?? '') !== calendarRoomCategoryFilter) return false;
      if (calendarRoomTypeFilter && String(room.room_type_id ?? '') !== calendarRoomTypeFilter) return false;
      if (roomQuery && !String(room.room_number || '').toLowerCase().includes(roomQuery)) return false;
      if (calendarOperationalFilter) {
        const status = normalizeRoomStatus(roomStatuses[String(room.id)] || room.operational_status || room.status || undefined);
        if (status !== calendarOperationalFilter) return false;
      }
      return true;
    });
  }, [rooms, calendarIncludeInactive, calendarRoomCategoryFilter, calendarRoomTypeFilter, calendarRoomSearch, calendarOperationalFilter, roomStatuses]);

  const calendarCategoryGroups = useMemo(() => {
    const grouped = new Map<string, RoomCategoryCalendarGroup>();
    for (const room of visibleCalendarRooms) {
      const categoryId = room.room_category_id == null ? null : Number(room.room_category_id);
      const roomTypeId = room.room_type_id == null ? null : Number(room.room_type_id);
      // Canonical groups are keyed only by ids. Null identities remain explicit
      // unassigned buckets and never fall back to relational name matching.
      const categoryKey = categoryId === null ? 'category:unassigned' : `category:${categoryId}`;
      const category = grouped.get(categoryKey) || {
        key: categoryKey,
        categoryId,
        code: String(room.room_category_code || '').trim(),
        name: categoryId === null ? 'Tanpa Kategori Kamar' : String(room.room_category_name || '').trim(),
        displayOrder: categoryId === null ? Number.MAX_SAFE_INTEGER : Number(room.room_category_display_order || 0),
        active: room.room_category_is_active,
        roomTypes: [],
        roomCount: 0,
      };

      const typeKey = roomTypeId === null ? `${categoryKey}/type:unassigned` : `${categoryKey}/type:${roomTypeId}`;
      let roomType = category.roomTypes.find((group) => group.key === typeKey);
      if (!roomType) {
        roomType = {
          key: typeKey,
          roomTypeId,
          code: String(room.room_type_code || '').trim(),
          name: roomTypeId === null ? 'Tanpa Tipe Kamar' : String(room.room_type_name || room.name || '').trim(),
          displayOrder: roomTypeId === null ? Number.MAX_SAFE_INTEGER : Number(room.room_type_display_order || 0),
          rooms: [],
        };
        category.roomTypes.push(roomType);
      }
      roomType.rooms.push(room);
      category.roomCount += 1;
      grouped.set(categoryKey, category);
    }

    for (const category of grouped.values()) {
      for (const roomType of category.roomTypes) {
        roomType.rooms.sort((a, b) =>
          String(a.room_number).localeCompare(String(b.room_number), 'id-ID', { numeric: true })
          || Number(a.id) - Number(b.id)
        );
      }
      category.roomTypes.sort((a, b) =>
        a.displayOrder - b.displayOrder
        || (a.name || a.code).localeCompare(b.name || b.code, 'id-ID', { numeric: true })
        || a.code.localeCompare(b.code, 'id-ID', { numeric: true })
        || Number(a.roomTypeId ?? Number.MAX_SAFE_INTEGER) - Number(b.roomTypeId ?? Number.MAX_SAFE_INTEGER)
      );
    }

    return Array.from(grouped.values()).sort((a, b) =>
      a.displayOrder - b.displayOrder
      || Number(a.categoryId ?? Number.MAX_SAFE_INTEGER) - Number(b.categoryId ?? Number.MAX_SAFE_INTEGER)
    );
  }, [visibleCalendarRooms]);

  const toggleCalendarGroup = (key: string) => {
    setCollapsedCalendarGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const dateRangesOverlap = (startA?: string, endA?: string, startB?: string, endB?: string) => {
    if (!startA || !endA || !startB || !endB) return false;
    return hotelDateRangesOverlap(startA, endA, startB, endB);
  };

  // Isolated operational-date helper so it can be replaced by business date/Night Audit later.
  const getOperationalDateKey = () => hotelDateFromInstant(new Date());

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

  const calendarSearchQuery = calendarSearch.trim().toLowerCase();

  const getCalendarReservationIdentity = (reservation: any) => {
    const bid = String(reservation?.bid || '').trim();
    const stay = Number(reservation?.stay_sequence || 0);

    if (bid && stay > 0) return `${bid} · R${String(stay).padStart(2, '0')}`;
    if (bid) return bid;

    const legacy = String(reservation?.booking_number || reservation?.legacy_booking_number || '').trim();
    if (legacy) return legacy;

    return `Reservasi #${reservation?.id ?? '-'}`;
  };

  const getCalendarReservationSearchText = (reservation: any) => {
    return [
      reservation?.bid,
      reservation?.booking_number,
      reservation?.legacy_booking_number,
      reservation?.guest_name,
      reservation?.guest_phone,
      reservation?.room_number,
      reservation?.room_name,
      reservation?.stay_sequence ? `R${String(reservation.stay_sequence).padStart(2, '0')}` : '',
    ].join(' ').toLowerCase();
  };

  const isCalendarReservationMatch = (reservation: any) => {
    if (!calendarSearchQuery) return true;
    return getCalendarReservationSearchText(reservation).includes(calendarSearchQuery);
  };

  const getCalendarReservationDensity = (span: number) => {
    if (span >= 4) return 'wide';
    if (span >= 3) return 'medium';
    return 'compact';
  };

  const calendarSummary = useMemo(() => {
    const reservationsInRange = reservations.filter(isCalendarReservationMatch);
    const byStatus = (status: string) => reservationsInRange.filter((reservation) => String(reservation?.status || '').toUpperCase() === status).length;
    const totalRooms = rooms.length;
    const roomValues = Object.values(roomStatuses || {});

    return {
      totalReservations: reservationsInRange.length,
      bookedReservations: reservationsInRange.filter((reservation) => {
        const status = String(reservation?.status || '').toUpperCase();
        return status !== 'CHECKED_IN' && status !== 'CHECKED_OUT' && status !== 'CANCELLED';
      }).length,
      checkedInReservations: byStatus('CHECKED_IN'),
      checkedOutReservations: byStatus('CHECKED_OUT'),
      dirtyRooms: roomValues.filter((status) => status === 'Kotor').length,
      readyRooms: roomValues.filter((status) => status === 'Ready').length,
      totalRooms,
    };
  }, [reservations, roomStatuses, rooms, calendarSearchQuery]);

  const openReservationEditor = (reservation: any) => {
    const checkIn = normalizeHotelDate(reservation.check_in);
    const checkOut = normalizeHotelDate(reservation.check_out);
    const room = rooms.find((candidate: any) => Number(candidate.id) === Number(reservation.room_id));
    const roomTypeId = Number(reservation.room_type_id ?? room?.room_type_id);

    setBookingType(reservation.booking_type || 'walkin');
    setGuestSegment((reservation.guest_segment || 'Reguler') as 'Reguler' | 'Group' | 'Corporate');
    setPrefillRoomId(Number(reservation.room_id));
    setSelectedRange({ start: checkIn, end: checkOut });
    setQuickBooking({
      guestName: reservation.guest_name || '',
      guestPhone: reservation.guest_phone || '',
      roomId: Number(reservation.room_id),
      roomTypeId: Number.isInteger(roomTypeId) && roomTypeId > 0 ? roomTypeId : null,
      checkIn,
      checkOut,
      roomVariant: reservation.room_type_name || room?.room_type_name || reservation.room_variant || ''
    });
    setCreateResOpen(true);
  };

  const handleReservationCancel = async (reservationId: number) => {
    if (!window.confirm('Batalkan reservasi ini?')) return;

    try {
      const response = await fetch(`/api/reservations/${reservationId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId })
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

  const getReservationCardStyle = (reservation: any) => {
    const { status } = normalizeReservationLifecycle(reservation?.status);
    const paymentStatus = String(reservation?.payment_status || '').toUpperCase();

    if (status === 'CHECKED_IN') {
      return {
        cardClass: 'res-checkedin',
        badge: 'CI',
        badgeClass: 'badge ci',
        paymentLabel: paymentStatus === 'PAID' ? '(LUNAS)' : paymentStatus === 'PARTIAL' ? '(DP)' : '',
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

    if (status === 'CANCELLED') {
      return {
        cardClass: 'res-cancelled',
        badge: 'CN',
        badgeClass: 'badge cn',
        paymentLabel: '',
        segmentMeta: getGuestSegmentMeta(reservation?.guest_segment),
      };
    }

    return {
      cardClass: 'res-booked',
      badge: 'BO',
      badgeClass: 'badge bo',
      paymentLabel: paymentStatus === 'PAID' ? '(LUNAS)' : paymentStatus === 'PARTIAL' ? '(DP)' : '',
      segmentMeta: getGuestSegmentMeta(reservation?.guest_segment),
    };
  };

  const fetchData = async () => {
    if (propertyId === null) return;
    // Determine date range from days array
    const start = days.length ? days[0].date : hotelDateFromInstant(new Date());
    // end should be exclusive - take day after last
    const last = days.length ? days[days.length - 1].date : hotelDateFromInstant(new Date());
    const end = addHotelDays(last, 1);

    const requestVersion = ++tapechartRequestVersionRef.current;
    try {
      const data = await fetchTapechart({ start, end, propertyId, includeInactive: calendarIncludeInactive });
        if (requestVersion !== tapechartRequestVersionRef.current) return;
        if (data && data.rooms) {
          setRooms(data.rooms || []);

          // A reservation is repeated in every occupied cell; flatten by id so
          // summaries and spans count the stay once, not once per night.
          const flat = new Map<string, any>();
          for (const r of data.rooms) {
            for (const c of r.cells) {
              for (const rv of c.reservations || []) {
                const key = String(rv.id ?? rv.reservation_id);
                if (flat.has(key)) continue;
                flat.set(key, {
                  ...rv,
                  room_id: r.id,
                  room_number: r.room_number,
                  room_name: r.name,
                  room_type_id: r.room_type_id,
                  room_type_code: r.room_type_code,
                  room_type_name: r.room_type_name,
                  room_status: r.status,
                });
              }
            }
          }
          setReservations(Array.from(flat.values()));

          const statusMap: Record<string, string> = {};
          (data.rooms || []).forEach((r: any) => {
            const normalized = normalizeRoomStatus(r.status);
            statusMap[r.id] = normalized;
          });
          setRoomStatuses(statusMap);
        }
    } catch (err) {
      console.error('Error fetching tapechart', err);
    }
  };
  fetchDataRef.current = fetchData;

  useEffect(() => {
    if (selectedMenu === 'Kalender' && propertyId !== null) void fetchDataRef.current();
  }, [days[0]?.date, days[days.length - 1]?.date, calendarIncludeInactive, selectedMenu, propertyId]);

  const fetchOperationsData = async () => {
    if (propertyId === null) {
      setPosMenu([]);
      setPosOrders([]);
      setFinanceSummary(null);
      return;
    }
    const targetPropertyId = propertyId;
    setPosMenu([]);
    setPosOrders([]);
    setFinanceSummary(null);
    try {
      const [housekeepingRes, maintenanceRes, posMenuRes, posOrderRes, financeRes, employeesRes, payrollRes] = await Promise.all([
        fetch(`/api/housekeeping/tasks?property_id=${targetPropertyId}`),
        fetch(`/api/maintenance/tasks?property_id=${targetPropertyId}`),
        fetch(`/api/pos/menu?property_id=${targetPropertyId}`),
        fetch('/api/pos/orders?property_id=' + targetPropertyId),
        fetch('/api/accounting/summary?property_id=' + targetPropertyId),
        fetch('/api/hr/employees'),
        fetch('/api/hr/payroll')
      ]);

      const housekeepingData = await housekeepingRes.json();
      const maintenanceData = await maintenanceRes.json();
      const posMenuData = await posMenuRes.json();
      const posOrderData = await posOrderRes.json();
      const financeData = await financeRes.json();
      const employeesData = await employeesRes.json();
      const payrollData = await payrollRes.json();

      if (targetPropertyId !== propertyId) return;
      if (housekeepingData?.status === 'OK') setHousekeepingTasks(housekeepingData.data || []);
      if (maintenanceData?.status === 'OK') setMaintenanceTasks(maintenanceData.data || []);
      if (posMenuData?.status === 'OK') setPosMenu(posMenuData.data?.items || []);
      if (posOrderData?.status === 'OK') setPosOrders(posOrderData.data || []);
      if (financeData?.status === 'OK') setFinanceSummary(financeData.data || null);
      if (employeesData?.status === 'OK') setEmployees(employeesData.data || []);
      if (payrollData?.status === 'OK') setPayroll(payrollData.data || []);
    } catch (error) {
      console.error('Error fetching operations tasks', error);
    }
  };

  const fetchTransactionReservations = async (targetPropId?: number | null, startDate?: string, endDate?: string) => {
    const propId = targetPropId !== undefined ? targetPropId : propertyId;
    if (propId === null || propId === undefined) {
      setTransactionReservations([]);
      setTransactionError(null);
      setTransactionLoading(false);
      return;
    }

    if (startDate && endDate) {
      transactionPeriodRangeRef.current = { startDate, endDateExclusive: endDate };
    }

    const range = transactionPeriodRangeRef.current;
    const requestVersion = ++transactionRequestVersionRef.current;
    setTransactionLoading(true);
    setTransactionError(null);
    try {
      let url = `/api/reservations?property_id=${propId}`;
      if (range?.startDate && range?.endDateExclusive) {
        url += `&start_date=${encodeURIComponent(range.startDate)}&end_date=${encodeURIComponent(range.endDateExclusive)}`;
      }
      const res = await fetch(url);
      const json = await res.json().catch(() => null);
      if (requestVersion !== transactionRequestVersionRef.current) return;
      if (res.ok && (json?.status === 'SUCCESS' || json?.status === 'OK') && Array.isArray(json?.data)) {
        setTransactionReservations(json.data);
        setTransactionError(null);
      } else {
        setTransactionReservations([]);
        setTransactionError(json?.message || 'Gagal memuat data reservasi');
      }
    } catch (err: any) {
      if (requestVersion !== transactionRequestVersionRef.current) return;
      console.error('Error fetching transaction reservations', err);
      setTransactionReservations([]);
      setTransactionError(err?.message || 'Gagal terhubung ke server');
    } finally {
      if (requestVersion === transactionRequestVersionRef.current) {
        setTransactionLoading(false);
      }
    }
  };
  const fetchTransactionReservationsRef = useRef(fetchTransactionReservations);
  fetchTransactionReservationsRef.current = fetchTransactionReservations;

  const fetchDailyOperations = async (targetPropId?: number | null) => {
    const propId = targetPropId !== undefined ? targetPropId : propertyId;
    if (propId === null || propId === undefined || selectedMenuRef.current !== 'Laporan') {
      setDailyOperations(null);
      setDailyOperationsLoading(false);
      return;
    }
    const requestVersion = ++dailyOperationsRequestVersionRef.current;
    setDailyOperationsLoading(true);
    try {
      const res = await fetch(`/api/reports/daily-operations?property_id=${propId}`);
      const json = await res.json();
      if (requestVersion !== dailyOperationsRequestVersionRef.current) return;
      if (json.status === 'SUCCESS' && json.data) {
        setDailyOperations(json.data);
      } else {
        setDailyOperations(null);
      }
    } catch (err) {
      if (requestVersion !== dailyOperationsRequestVersionRef.current) return;
      console.error('Error fetching daily operations', err);
      setDailyOperations(null);
    } finally {
      if (requestVersion === dailyOperationsRequestVersionRef.current) {
        setDailyOperationsLoading(false);
      }
    }
  };
  const fetchDailyOperationsRef = useRef(fetchDailyOperations);
  fetchDailyOperationsRef.current = fetchDailyOperations;

  useEffect(() => {
    if (propertyId === null) {
      setTransactionReservations([]);
      setTransactionError(null);
      setDailyOperations(null);
      return;
    }
    if (selectedMenu === 'Transaksi') {
      void fetchTransactionReservations(propertyId);
    } else if (selectedMenu === 'Laporan') {
      void fetchDailyOperations(propertyId);
    }
  }, [propertyId, selectedMenu]);

  const fetchReservationAudit = async (reservationId: number) => {
    try {
      const response = await fetch(`/api/reservations/${reservationId}/audit?property_id=${propertyId}`);
      const data = await response.json();
      setReservationAudit(data.data || []);
    } catch (error) {
      console.error('Failed to fetch reservation audit', error);
      setReservationAudit([]);
    }
  };

  const fetchRoomAudit = async (roomId: number) => {
    try {
      const response = await fetch(`/api/rooms/${roomId}/audit?property_id=${propertyId}`);
      const data = await response.json();
      return data.data || [];
    } catch (error) {
      console.error('Failed to fetch room audit', error);
      return [];
    }
  };

  const createPosOrder = async () => {
    if (propertyId === null) return;
    const sampleItems = posMenu.slice(0, 2).map((item: any) => ({ menu_item_id: item.id, quantity: 1 }));

    try {
      const res = await fetch('/api/pos/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId, table_number: '101', guest_name: 'Walk In Guest', items: sampleItems })
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

  const fetchReservationFolio = async (reservationId: number) => {
    if (propertyId === null) {
      setSelectedFolio(null);
      return;
    }
    try {
      const response = await fetch(`/api/reservations/${reservationId}/folio?property_id=${propertyId}`);
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

  const viewRoomMasterReservation = async (summary: ActiveRoomReservation) => {
    try {
      const response = await fetch(`/api/reservations/${summary.id}?property_id=${propertyId}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || 'Gagal memuat detail reservasi');
      setSelectedRes({
        ...summary,
        ...(body.data || {}),
        room_number: summary.room_number
      });
      await fetchReservationFolio(summary.id);
    } catch (error) {
      alert(`Gagal membuka reservasi: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleReservationAction = async (reservationId: number, action: 'checkin' | 'checkout') => {
    try {
      const response = await fetch(`/api/reservations/${reservationId}/${action === 'checkin' ? 'checkin' : 'checkout'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId })
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
        const checkoutDate = normalizeHotelDate(checkoutReservation?.check_out) || hotelDateFromInstant(new Date());

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

  const confirmRoomCleaned = async () => {
    if (dirtyConfirmRoomId === null) return;
    const roomId = dirtyConfirmRoomId;
    const cleanupDate = dirtyConfirmDate || hotelDateFromInstant(new Date());
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
    if (propertyId === null) {
      alert('Property belum dipilih');
      return;
    }

    try {
      const response = await fetch(`/api/reservations/${selectedRes.id}/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          amount: Number(paymentDraft),
          payment_method: 'CASH',
          reference_code: `PMT-${Date.now()}`
        })
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
    setSelectedRes(null);
    setSelectedFolio(null);
    setPaymentDraft('');
  }, [propertyId]);

  useEffect(() => {
    if (selectedRes) {
      fetchReservationAudit(Number(selectedRes.id));
      if (selectedRes.room_id) {
        fetchRoomAudit(Number(selectedRes.room_id));
      }
    }
  }, [selectedRes?.id, selectedRes?.room_id]);

  useEffect(() => {
    const bid = String(selectedRes?.bid || '').trim();
    if (!bid) {
      setSelectedBooking(null);
      setSelectedBookingChildren([]);
      return;
    }

    let cancelled = false;

    const fetchBookingDetail = async () => {
      try {
        const [bookingRes, reservationsRes] = await Promise.all([
          fetch(`/api/bookings/${encodeURIComponent(bid)}?property_id=${propertyId}`),
          fetch(`/api/bookings/${encodeURIComponent(bid)}/reservations?property_id=${propertyId}`),
        ]);

        const bookingData = await bookingRes.json();
        const reservationsData = await reservationsRes.json();

        if (cancelled) return;
        if (!bookingRes.ok) {
          throw new Error(bookingData.message || 'Failed to load booking details');
        }

        setSelectedBooking(bookingData.data || bookingData);
        setSelectedBookingChildren(
          Array.isArray(reservationsData.data)
            ? reservationsData.data
            : Array.isArray(reservationsData)
              ? reservationsData
              : []
        );
      } catch (error) {
        if (!cancelled) {
          console.error('Booking detail fetch failed', error);
          setSelectedBooking(null);
          setSelectedBookingChildren([]);
        }
      }
    };

    fetchBookingDetail();
    setBidCopyState({ kind: 'idle', message: '' });

    return () => {
      cancelled = true;
    };
  }, [selectedRes?.bid]);

  useEffect(() => {
    fetchOperationsData();

    // connect to SSE for realtime updates
    let es: EventSource | null = null;
    try {
      es = new EventSource('/api/events');
      const calendarEvents = [
        'ReservationCreated',
        'ReservationUpdated',
        'ReservationMoved',
        'ReservationCancelled',
        'ReservationCheckedIn',
        'ReservationCheckedOut',
        'BookingCreated',
        'BookingCompleted',
      ];
      for (const eventName of calendarEvents) {
        es.addEventListener(eventName, (ev: any) => {
          console.log(`SSE ${eventName}`, ev.data);
          void fetchDataRef.current();
          void fetchTransactionReservationsRef.current();
          void fetchDailyOperationsRef.current();
        });
      }
      es.addEventListener('RoomStatusUpdated', (ev: any) => {
        console.log('SSE RoomStatusUpdated', ev.data);
        void fetchDataRef.current();
        void fetchOperationsData();
        void fetchTransactionReservationsRef.current();
        void fetchDailyOperationsRef.current();
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
          property_id: propertyId,
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
      body: JSON.stringify({ property_id: propertyId, status })
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
        body: JSON.stringify({ property_id: propertyId, status: newStatus })
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

  const makeBookingChild = (overrides: Partial<any> = {}) => {
    const defaultStart = overrides.check_in || quickBooking.checkIn || selectedRange.start || localDateISO(anchorDate);
    const defaultEnd = overrides.check_out || quickBooking.checkOut || selectedRange.end || addHotelDays(localDateISO(anchorDate), 1);

    return {
      id: overrides.id || `booking-child-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      room_id: resolveBookingChildRoomId(overrides, quickBooking.roomId ?? prefillRoomId ?? null),
      room_number: overrides.room_number ?? null,
      room_type_id: overrides.room_type_id ?? quickBooking.roomTypeId ?? null,
      room_type_code: overrides.room_type_code ?? null,
      room_type_name: overrides.room_type_name ?? null,
      room_type_display_order: overrides.room_type_display_order ?? null,
      room_category_id: overrides.room_category_id ?? null,
      room_category_code: overrides.room_category_code ?? null,
      room_category_name: overrides.room_category_name ?? null,
      room_category_display_order: overrides.room_category_display_order ?? null,
      check_in: defaultStart,
      check_out: defaultEnd,
      guest_name: overrides.guest_name ?? quickBooking.guestName ?? '',
      guest_phone: overrides.guest_phone ?? quickBooking.guestPhone ?? '',
      guest_segment: overrides.guest_segment ?? guestSegment,
      booking_type: overrides.booking_type ?? bookingType,
      room_variant: overrides.room_variant ?? quickBooking.roomVariant,
      subtotal_amount: overrides.subtotal_amount ?? 0,
      total_price: overrides.total_price ?? overrides.subtotal_amount ?? 0,
      discount_amount: overrides.discount_amount ?? 0,
      discount_percent: overrides.discount_percent ?? 0,
      discount_type: overrides.discount_type ?? 'nominal',
      amount_paid: overrides.amount_paid ?? 0,
      payment_status: overrides.payment_status ?? 'UNPAID',
      property_id: overrides.property_id ?? null,
    };
  };

  const getAvailabilityKey = (child: any) => {
    const roomTypeId = Number(child?.room_type_id);
    const roomType = String(child?.room_variant || child?.room_type || '').trim();
    const checkIn = String(child?.check_in || '').trim();
    const checkOut = String(child?.check_out || '').trim();
    if (!checkIn || !checkOut) return '';
    if (Number.isInteger(roomTypeId) && roomTypeId > 0) return `id:${roomTypeId}|${checkIn}|${checkOut}`;
    if (!roomType) return '';
    return `${roomType}|${checkIn}|${checkOut}`;
  };

  const getFilteredAvailabilityRooms = (rows: any[], key: string, child: any, composerChildren = bookingComposerChildren) => {
    const parsed = parseAvailabilityKey(key);
    if (!parsed) {
      return [] as any[];
    }
    const { roomTypeId, roomTypeName, checkIn, checkOut } = parsed;

    const hasCapacity = Array.isArray(rows) && rows.length > 0 && rows.every((row: any) => Number(row?.sellable ?? 0) > 0);
    if (!hasCapacity) {
      return [] as any[];
    }

    return rooms.filter((room: any) => {
      const sameType = roomTypeId !== null
        ? Number(room.room_type_id) === roomTypeId
        : getRoomTypeName(room) === roomTypeName;
      if (!sameType) {
        return false;
      }

      if (room.room_is_active === false || room.room_type_is_active === false) return false;

      const status = normalizeRoomStatus(roomStatuses[String(room.id)] || room.status || 'Ready');
      if (status === 'Maintenance' || status === 'Kotor') {
        return false;
      }

      const roomId = Number(room.id);
      const hasExistingReservationConflict = reservations.some((reservation: any) => {
        if (Number(reservation?.room_id) !== roomId) return false;
        const bookingStatus = String(reservation?.status || '').toUpperCase();
        if (!['BOOKED', 'CHECKED_IN'].includes(bookingStatus)) return false;
        return dateRangesOverlap(
          String(reservation?.check_in || ''),
          String(reservation?.check_out || ''),
          checkIn,
          checkOut
        );
      });
      if (hasExistingReservationConflict) {
        return false;
      }

      const hasSameBookingConflict = hasOverlappingPriorSiblingRoomSelection(
        composerChildren,
        String(child?.id || ''),
        roomId,
        checkIn,
        checkOut,
      );
      return !hasSameBookingConflict;
    });
  };

  const resetQuickBookingForm = () => {
    setQuickBooking({
      guestName: '',
      guestPhone: '',
      roomId: null,
      roomTypeId: null,
      checkIn: '',
      checkOut: '',
      roomVariant: ''
    });
    setBookingComposerChildren([]);
    setChildRoomAvailability({});
    setAvailabilityCache({});
    setBookingAvailabilityState({});
    availabilityRequestVersionRef.current = {};
    availabilityRequestPromiseRef.current = {};
    availabilityRequestFailedRef.current = {};
  };

  useEffect(() => {
    if (!createResOpen) {
      setAvailabilityCache({});
      setChildRoomAvailability({});
      setBookingAvailabilityState({});
      availabilityRequestVersionRef.current = {};
      availabilityRequestPromiseRef.current = {};
      availabilityRequestFailedRef.current = {};
      return;
    }

    setAvailabilityCache({});
    setChildRoomAvailability({});
    setBookingAvailabilityState({});
    availabilityRequestVersionRef.current = {};
    availabilityRequestPromiseRef.current = {};
    availabilityRequestFailedRef.current = {};
  }, [createResOpen]);

  useEffect(() => {
    const nextAvailability: Record<string, any[]> = {};
    const nextState: Record<string, 'idle' | 'loading' | 'success' | 'empty' | 'error'> = {};

    const applyAvailabilityResultForKey = (key: string, rows: any[], terminalState: 'success' | 'empty' | 'error') => {
      const resultRows = Array.isArray(rows) ? rows : [];
      setChildRoomAvailability((prev) => {
        const next = { ...prev };
        for (const child of bookingComposerChildrenRef.current) {
          const childId = String(child?.id ?? '');
          if (!childId || getAvailabilityKey(child) !== key) continue;
          next[childId] = getFilteredAvailabilityRooms(resultRows, key, child, bookingComposerChildrenRef.current);
        }
        return next;
      });

      setBookingAvailabilityState((prev) => {
        const next = { ...prev };
        for (const child of bookingComposerChildrenRef.current) {
          const childId = String(child?.id ?? '');
          if (!childId || getAvailabilityKey(child) !== key) continue;
          next[childId] = terminalState;
        }
        return next;
      });

      setBookingComposerChildren((prev) => {
        let changed = false;
        const updated = prev.map((child: any) => {
          if (String(child?.id ?? '') && getAvailabilityKey(child) === key && child.room_id != null) {
            const roomId = Number(child.room_id);
            const hasRoom = getFilteredAvailabilityRooms(resultRows, key, child, prev)
              .some((room: any) => Number(room.id) === roomId);
            if (!hasRoom && terminalState !== 'error') {
              changed = true;
              return { ...child, room_id: null };
            }
          }
          return child;
        });
        return changed ? updated : prev;
      });
    };

    const fetchAvailabilityRows = async (key: string, roomTypeId: number | null, roomTypeName: string, checkIn: string, checkOut: string, version: number) => {
      console.log('AVAIL_FETCH_START', { key, roomTypeId, roomTypeName, checkIn, checkOut, version });
      try {
        const response = await fetch(buildAvailabilityRequest(roomTypeId, roomTypeName, checkIn, checkOut, propertyId!));
        if (!response.ok) {
          throw new Error(`availability request failed for ${key}`);
        }

        const payload = await response.json().catch(() => ({}));
        const rows = Array.isArray(payload?.data) ? payload.data : [];

        if (availabilityRequestVersionRef.current[key] !== version) {
          console.log('AVAIL_FETCH_STALE', { key, requestVersion: version, currentVersion: availabilityRequestVersionRef.current[key] || 0, resultCount: rows.length });
          return;
        }

        console.log(rows.length > 0 ? 'AVAIL_FETCH_SUCCESS' : 'AVAIL_FETCH_EMPTY', {
          key,
          version,
          resultCount: rows.length
        });
        delete availabilityRequestFailedRef.current[key];
        delete availabilityRequestPromiseRef.current[key];
        setBookingAvailabilityState((prev) => {
          const next = { ...prev };
          for (const child of bookingComposerChildrenRef.current) {
            const childId = String(child?.id ?? '');
            if (!childId) continue;
            if (getAvailabilityKey(child) === key) {
              next[childId] = rows.length > 0 ? 'success' : 'empty';
            }
          }
          return next;
        });
        setAvailabilityCache((prev) => {
          if (prev[key] === rows) {
            return prev;
          }
          return { ...prev, [key]: rows };
        });
        applyAvailabilityResultForKey(key, rows, rows.length > 0 ? 'success' : 'empty');
      } catch (error) {
        if (availabilityRequestVersionRef.current[key] !== version) {
          console.log('AVAIL_FETCH_STALE', { key, requestVersion: version, currentVersion: availabilityRequestVersionRef.current[key] || 0, resultCount: 0 });
          return;
        }

        console.log('AVAIL_FETCH_ERROR', { key, version, error: error instanceof Error ? error.message : String(error) });
        availabilityRequestFailedRef.current[key] = version;
        delete availabilityRequestPromiseRef.current[key];
        setBookingAvailabilityState((prev) => {
          const next = { ...prev };
          for (const child of bookingComposerChildrenRef.current) {
            const childId = String(child?.id ?? '');
            if (!childId) continue;
            if (getAvailabilityKey(child) === key) {
              next[childId] = 'error';
            }
          }
          return next;
        });
        applyAvailabilityResultForKey(key, [], 'error');
        console.error('Availability fetch failed', error);
      } finally {
        console.log('AVAIL_FETCH_FINALLY', { key, version });
        if (availabilityRequestVersionRef.current[key] === version) {
          delete availabilityRequestPromiseRef.current[key];
        }
      }
    };

    const canUseCachedRows = (key: string) => Object.prototype.hasOwnProperty.call(availabilityCache, key);

    const getFilteredRoomsForChild = (child: any, cachedRows: any[]) => {
      const checkIn = String(child?.check_in || '').trim();
      const checkOut = String(child?.check_out || '').trim();
      const childRoomTypeId = Number(child?.room_type_id);
      const hasCanonicalRoomTypeId = Number.isInteger(childRoomTypeId) && childRoomTypeId > 0;
      const legacyRoomTypeName = String(child?.room_variant || child?.room_type || '').trim();

      const hasCapacity = Array.isArray(cachedRows) && cachedRows.length > 0 && cachedRows.every((row: any) => Number(row?.sellable ?? 0) > 0);
      if (!hasCapacity || (!hasCanonicalRoomTypeId && !legacyRoomTypeName) || !checkIn || !checkOut) {
        return [];
      }

      return rooms.filter((room: any) => {
        const roomId = Number(room.id);
        const roomNumber = String(room.room_number || roomId);
        const roomTypeId = room?.room_type_id ?? null;
        const roomMasterActive = room?.room_is_active !== false
          && room?.is_active !== false
          && room?.room_type_is_active !== false;
        const operationalStatus = normalizeRoomStatus(roomStatuses[String(room.id)] || room.status || 'Ready');
        const statusSellable = operationalStatus !== 'Maintenance' && operationalStatus !== 'Kotor';
        const roomTypeMatches = hasCanonicalRoomTypeId
          ? Number(roomTypeId) === childRoomTypeId
          : getRoomTypeName(room) === legacyRoomTypeName;
        const hasExistingReservationConflict = reservations.some((reservation: any) => {
          if (Number(reservation?.room_id) !== roomId) return false;
          const bookingStatus = String(reservation?.status || '').toUpperCase();
          if (!['BOOKED', 'CHECKED_IN'].includes(bookingStatus)) return false;
          return dateRangesOverlap(
            String(reservation?.check_in || ''),
            String(reservation?.check_out || ''),
            checkIn,
            checkOut
          );
        });
        const siblingConflict = hasOverlappingPriorSiblingRoomSelection(
          bookingComposerChildren,
          String(child.id),
          roomId,
          checkIn,
          checkOut,
        );

        const capacityAvailable = hasCapacity;
        const eligible = roomMasterActive && roomTypeMatches && statusSellable && !hasExistingReservationConflict && !siblingConflict && capacityAvailable;
        const exclusionReason = !roomTypeMatches
          ? 'ROOM_TYPE_MISMATCH'
          : !roomMasterActive
            ? 'INACTIVE_ROOM_MASTER'
          : !statusSellable
              ? 'OPERATIONAL_STATUS'
              : hasExistingReservationConflict
                ? 'ACTIVE_OVERLAP'
                : siblingConflict
                  ? 'SIBLING_CONFLICT'
                  : capacityAvailable
                    ? ''
                    : 'NO_CAPACITY';

        console.log('AVAILABLE_ROOM_CANDIDATE_DEBUG', {
          roomId,
          roomNumber,
          roomTypeId,
          roomTypeName: getRoomTypeName(room),
          roomStatus: operationalStatus,
          activeOverlap: Boolean(hasExistingReservationConflict),
          capacityAvailable,
          siblingConflict,
          eligible,
          exclusionReason
        });

        return eligible;
      });
    };

    for (const child of bookingComposerChildren) {
      const childId = String(child?.id ?? '');
      if (!childId) {
        continue;
      }

      const key = getAvailabilityKey(child);
      if (!key) {
        nextAvailability[childId] = [];
        nextState[childId] = 'idle';
        continue;
      }

      const cachedRows = availabilityCache[key];
      if (canUseCachedRows(key)) {
        const availableRooms = getFilteredRoomsForChild(child, cachedRows || []);
        nextAvailability[childId] = availableRooms;
        nextState[childId] = availableRooms.length > 0 ? 'success' : 'empty';
        continue;
      }

      if (availabilityRequestFailedRef.current[key]) {
        nextAvailability[childId] = [];
        nextState[childId] = 'error';
        continue;
      }

      if (!availabilityRequestPromiseRef.current[key]) {
        const version = availabilityRequestSequenceRef.current + 1;
        availabilityRequestSequenceRef.current = version;
        availabilityRequestVersionRef.current[key] = version;
        const parsed = parseAvailabilityKey(key);
        if (!parsed) continue;
        availabilityRequestPromiseRef.current[key] = fetchAvailabilityRows(
          key,
          parsed.roomTypeId,
          parsed.roomTypeName,
          parsed.checkIn,
          parsed.checkOut,
          version,
        );
      }

      nextAvailability[childId] = [];
      nextState[childId] = 'loading';
    }

    setChildRoomAvailability((prev) => ({ ...prev, ...nextAvailability }));
    setBookingAvailabilityState((prev) => ({ ...prev, ...nextState }));
    setBookingComposerChildren((prev) => {
      let changed = false;
      const updated = prev.map((child: any) => {
        const childId = String(child?.id ?? '');
        if (!childId) return child;
        const availableIds = new Set((nextAvailability[childId] || []).map((room: any) => Number(room.id)));
        const childState = nextState[childId];
        if ((childState === 'success' || childState === 'empty') && child.room_id != null && !availableIds.has(Number(child.room_id))) {
          changed = true;
          return { ...child, room_id: null };
        }
        return child;
      });
      return changed ? updated : prev;
    });
  }, [availabilityCache, bookingComposerChildren, reservations, roomStatuses, rooms]);

  const updateBookingChild = (childId: string, updates: Partial<any>) => {
    setBookingComposerChildren((prev) => updateBookingChildById(prev, childId, updates));
  };

  const addBookingChild = () => {
    const fallbackChild = {
      check_in: quickBooking.checkIn || selectedRange.start || localDateISO(anchorDate),
      check_out: quickBooking.checkOut || selectedRange.end || addHotelDays(localDateISO(anchorDate), 1),
      room_type_id: quickBooking.roomTypeId ?? null,
      room_variant: quickBooking.roomVariant ?? '',
    };

    setBookingComposerChildren((prev) => {
      const baseChild = prev[0] || fallbackChild;
      return [...prev, makeBookingChild(additionalBookingChildOverrides(baseChild, fallbackChild))];
    });
  };

  const removeBookingChild = (childId: string) => {
    setBookingComposerChildren((prev) => removeBookingChildById(prev, childId));
  };

  const openQuickBooking = (room: CalendarRoom, startDate?: string, endDate?: string) => {
    const roomBinding = canonicalCalendarRoomBinding(room);
    const roomTypeName = String(room.room_type_name || room.name || '').trim();
    const defaultStart = startDate || localDateISO(anchorDate);
    const defaultEnd = endDate || addHotelDays(defaultStart, 1);
    const initialChild = makeBookingChild({
      ...roomBinding,
      check_in: defaultStart,
      check_out: defaultEnd,
      guest_name: '',
      guest_phone: '',
      room_variant: roomTypeName,
      subtotal_amount: 0,
      total_price: 0,
      discount_amount: 0,
      discount_percent: 0,
      amount_paid: 0,
      payment_status: 'UNPAID',
    });
    setBookingType('walkin');
    setGuestSegment('Reguler');
    setKtpFile(null);
    setBuktiBayarFile(null);
    setPrefillRoomId(roomBinding.room_id);
    setSelectedRange({ start: defaultStart, end: defaultEnd });
    setQuickBooking({
      guestName: '',
      guestPhone: '',
      roomId: roomBinding.room_id,
      roomTypeId: roomBinding.room_type_id,
      checkIn: defaultStart,
      checkOut: defaultEnd,
      roomVariant: roomTypeName
    });
    setBookingComposerChildren([initialChild]);
    setCreateResOpen(true);
  };

  const renderRoomStatusButton = (room: any) => {
    const rawStatus = String(room.operational_status || room.status || '').toUpperCase();
    const currentStatus = normalizeRoomStatus(rawStatus);
    const statusLabel: Record<string, string> = {
      VACANT_CLEAN: 'Vacant Clean',
      VACANT_DIRTY: 'Vacant Dirty',
      OCCUPIED_CLEAN: 'Occupied Clean',
      OCCUPIED_DIRTY: 'Occupied Dirty',
      OUT_OF_ORDER: 'Out of Order',
      OUT_OF_SERVICE: 'Out of Service',
      CLEANING: 'Cleaning',
      INSPECTED: 'Vacant Clean',
    };
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
        {statusLabel[rawStatus] || rawStatus || currentStatus}
      </button>
    );
  };

  const activeReservationStatus = String(selectedRes?.status || '').toUpperCase();
  const activeStayStatus = String(selectedRes?.stay_status || '').toUpperCase();
  const activeBookingStatus = String(selectedBooking?.booking_status || selectedBooking?.status || '').toUpperCase();
  const activePaymentStatus = getPaymentStatusLabel(selectedRes?.payment_status);
  const bookingChildren = [...selectedBookingChildren].sort((a, b) => Number(a?.stay_sequence || 0) - Number(b?.stay_sequence || 0));
  const selectedStayLabel = selectedRes?.stay_sequence ? `R${String(selectedRes.stay_sequence).padStart(2, '0')}` : 'R01';
  const selectedRoomLabel = selectedRes?.room_number || selectedRes?.room_id || '—';
  const selectedRoomTypeLabel = selectedRes?.room_variant || selectedBooking?.room_type || selectedBooking?.room_variant || '—';
  const selectedBookingIdentity = selectedRes?.bid || selectedBooking?.bid || selectedRes?.booking_number || `#${selectedRes?.id ?? '-'}`;
  const selectedBookingLegacy = selectedRes?.booking_number || selectedBooking?.booking_number || '';
  const selectedBookingSource = selectedBooking?.booking_source || selectedRes?.booking_source || '';
  const selectedBookingChannel = selectedBooking?.channel || selectedRes?.channel || '';
  const [stayChangeState, setStayChangeState] = useState<{ open: boolean; type: 'extend' | 'shorten'; reservationId: number | null; newCheckOut: string }>({
    open: false,
    type: 'extend',
    reservationId: null,
    newCheckOut: ''
  });
  const stayChangeReservation = useMemo(
    () => reservations.find((item) => Number(item.id) === stayChangeState.reservationId) || selectedRes,
    [reservations, stayChangeState.reservationId, selectedRes]
  );
  const selectedNights = Math.max(
    1,
    hotelNightsBetween(normalizeHotelDate(selectedRes?.check_in), normalizeHotelDate(selectedRes?.check_out)) ?? 1
  );
  const stayChangeNightsDelta = (() => {
    if (!stayChangeState.open || !stayChangeState.reservationId) return 0;
    const reservation = reservations.find((item) => Number(item.id) === stayChangeState.reservationId) || selectedRes;
    if (!reservation) return 0;
    const currentCheckOut = normalizeHotelDate(reservation.check_out);
    const nextCheckOut = stayChangeState.newCheckOut;
    if (!currentCheckOut || !nextCheckOut) return 0;
    return hotelNightsBetween(currentCheckOut, nextCheckOut) ?? 0;
  })();
  const canCheckIn = !['CHECKED_IN', 'CHECKED_OUT', 'CANCELLED'].includes(activeReservationStatus);
  const canCheckOut = activeReservationStatus === 'CHECKED_IN';
  const canCancel = !['CHECKED_IN', 'CHECKED_OUT', 'CANCELLED'].includes(activeReservationStatus);
  const canPay = activeReservationStatus !== 'CANCELLED';
  const canExtend = activeReservationStatus === 'BOOKED' || activeReservationStatus === 'CHECKED_IN';
  const canShorten = activeReservationStatus === 'BOOKED';

  const addDaysToIso = (value: string | undefined, delta: number) => {
    if (!value) return '';
    return addHotelDays(value, delta);
  };

  const validateStayChangeCandidate = (reservation: any, requestedCheckOut: string) => {
    const currentCheckIn = normalizeHotelDate(reservation.check_in);
    const currentCheckOut = normalizeHotelDate(reservation.check_out);
    const requestedDate = normalizeHotelDate(requestedCheckOut);

    if (!requestedCheckOut) {
      return { valid: false, reason: 'Tanggal check-out baru wajib diisi.' };
    }
    if (!requestedDate) {
      return { valid: false, reason: 'Tanggal check-out baru tidak valid.' };
    }
    if (currentCheckOut && requestedCheckOut === currentCheckOut) {
      return { valid: false, reason: 'Tanggal check-out baru tidak berubah.' };
    }
    if (currentCheckIn && requestedDate <= currentCheckIn) {
      return { valid: false, reason: 'Check-out baru harus setelah check-in.' };
    }

    return { valid: true, reason: '' };
  };

  const openStayChangePrompt = (type: 'extend' | 'shorten', reservationId: number, overrideNewCheckOut?: string) => {
    const reservation = reservations.find((item) => Number(item.id) === reservationId) || selectedRes;
    if (!reservation) {
      console.log('RESIZE_NO_ACTIVE_STATE', { reason: 'reservation missing before confirmation', reservationId, type });
      return;
    }

    const currentCheckOut = normalizeHotelDate(reservation.check_out) || hotelDateFromInstant(new Date());
    const suggestedCheckOut = type === 'extend' ? addDaysToIso(currentCheckOut, 1) : addDaysToIso(currentCheckOut, -1);
    const nextCheckOut = overrideNewCheckOut || suggestedCheckOut || currentCheckOut;

    const validation = validateStayChangeCandidate(reservation, nextCheckOut);
    if (!validation.valid) {
      console.log('RESIZE_INVALID_DATE', {
        reservationId,
        type,
        requestedCheckOut: nextCheckOut,
        originalCheckOut: currentCheckOut,
        reason: validation.reason
      });
      setReservationResizePreview((prev) => {
        const next = { ...prev };
        delete next[String(reservationId)];
        return next;
      });
      if (overrideNewCheckOut) {
        alert(validation.reason);
      }
      return;
    }

    console.log('RESIZE_CONFIRM_OPEN', {
      operation: type.toUpperCase(),
      oldCheckOut: currentCheckOut,
      newCheckOut: nextCheckOut,
      reservationId
    });

    setStayChangeState({
      open: true,
      type,
      reservationId,
      newCheckOut: nextCheckOut
    });
  };

  useEffect(() => {
    if (!reservationResizeState) return;

    const handlePointerMove = (event: PointerEvent) => {
      const activeResize = reservationResizeRef.current;
      if (!activeResize) {
        console.log('RESIZE_NO_ACTIVE_STATE', { reason: 'pointermove no active state', pointerId: event.pointerId });
        return;
      }

      if (event.pointerId !== activeResize.pointerId) {
        console.log('RESIZE_POINTER_MISMATCH', {
          expectedPointerId: activeResize.pointerId,
          actualPointerId: event.pointerId,
          reservationId: activeResize.reservationId,
          clientX: event.clientX
        });
        return;
      }

      const table = document.querySelector('.calendar-grid-shell table');
      const sampleCell = table?.querySelector('thead th.header-date-cell');
      const cellWidth = sampleCell ? sampleCell.getBoundingClientRect().width || 76 : 76;
      const deltaDays = Math.round((event.clientX - activeResize.startX) / cellWidth);
      const nextCheckOut = addHotelDays(activeResize.startCheckOut, deltaDays);
      reservationResizePreviewRef.current = {
        ...reservationResizePreviewRef.current,
        [String(activeResize.reservationId)]: nextCheckOut
      };
      setReservationResizePreview(reservationResizePreviewRef.current);

      console.log('RESIZE_MOVE', {
        pointerId: event.pointerId,
        clientX: event.clientX,
        deltaDays,
        previewNewCheckOut: nextCheckOut
      });
    };

    const finalizeResize = (event?: PointerEvent) => {
      const activeResize = reservationResizeRef.current;
      if (!activeResize) {
        console.log('RESIZE_NO_ACTIVE_STATE', { reason: 'finalize before active state', pointerId: event?.pointerId ?? null });
        return;
      }

      if (event && event.pointerId !== activeResize.pointerId) {
        console.log('RESIZE_POINTER_MISMATCH', {
          expectedPointerId: activeResize.pointerId,
          actualPointerId: event.pointerId,
          reservationId: activeResize.reservationId,
          phase: 'pointerup'
        });
        return;
      }

      const reservationId = activeResize.reservationId;
      const reservation = reservations.find((item) => Number(item.id) === reservationId) || selectedRes;
      const previewCheckOut = reservationResizePreviewRef.current[String(reservationId)] || activeResize.startCheckOut;
      const previousCheckOut = normalizeHotelDate(reservation?.check_out) || activeResize.startCheckOut;

      console.log('RESIZE_UP', {
        pointerId: event?.pointerId ?? activeResize.pointerId,
        finalPreviewNewCheckOut: previewCheckOut,
        originalCheckOut: previousCheckOut,
        reservationId
      });

      reservationResizeRef.current = null;
      setReservationResizeState(null);
      const nextPreview = { ...reservationResizePreviewRef.current };
      delete nextPreview[String(reservationId)];
      reservationResizePreviewRef.current = nextPreview;
      setReservationResizePreview(nextPreview);

      if (reservation && previousCheckOut !== previewCheckOut) {
        const validation = validateStayChangeCandidate(reservation, previewCheckOut);
        if (!validation.valid) {
          console.log('RESIZE_INVALID_DATE', {
            reservationId,
            previewNewCheckOut: previewCheckOut,
            originalCheckOut: previousCheckOut,
            reason: validation.reason
          });
          alert(validation.reason);
          return;
        }
        if (String(reservation.status || '').toUpperCase() === 'CHECKED_IN' && previewCheckOut < previousCheckOut) {
          alert('Masa inap tamu yang sudah check-in tidak dapat diperpendek melalui resize. Gunakan proses Early Checkout.');
          return;
        }
        const type = previewCheckOut > previousCheckOut ? 'extend' : 'shorten';
        openStayChangePrompt(type, reservationId, previewCheckOut);
      } else if (reservation && previousCheckOut === previewCheckOut) {
        console.log('RESIZE_NOOP', {
          reservationId,
          previousCheckOut,
          previewCheckOut,
          reason: 'same checkout value'
        });
      }
    };

    const handlePointerEnd = (event: PointerEvent) => finalizeResize(event);

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
    };
  }, [reservationResizeState, reservations, selectedRes, openStayChangePrompt]);

  const closeStayChangePrompt = () => {
    const reservationId = stayChangeState.reservationId;
    reservationResizePreviewRef.current = {
      ...reservationResizePreviewRef.current
    };
    if (reservationId) {
      delete reservationResizePreviewRef.current[String(reservationId)];
    }
    setReservationResizePreview(reservationResizePreviewRef.current);
    setStayChangeState({ open: false, type: 'extend', reservationId: null, newCheckOut: '' });
  };

  const confirmStayChange = async () => {
    if (!stayChangeState.open || stayChangeState.reservationId === null) return;

    const reservationId = stayChangeState.reservationId;
    const reservation = reservations.find((item) => Number(item.id) === reservationId) || selectedRes;
    if (!reservation) {
      closeStayChangePrompt();
      return;
    }

    const requestedCheckOut = stayChangeState.newCheckOut.trim();
    const validation = validateStayChangeCandidate(reservation, requestedCheckOut);
    if (!validation.valid) {
      alert(validation.reason);
      closeStayChangePrompt();
      return;
    }

    try {
      const response = await fetch(`/api/reservations/${reservationId}/${stayChangeState.type}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId, new_check_out: requestedCheckOut })
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data?.message || `Gagal ${stayChangeState.type === 'extend' ? 'memperpanjang' : 'memendekkan'} masa inap`);
      }

      await fetchData();
      await fetchOperationsData();
      if (selectedRes && Number(selectedRes.id) === reservationId) {
        setSelectedRes((prev: any) => prev ? { ...prev, ...data?.data, check_out: data?.data?.check_out || prev.check_out } : prev);
      }
      if (reservationId) {
        fetchReservationFolio(reservationId);
        fetchReservationAudit(reservationId);
      }

      closeStayChangePrompt();
      alert(stayChangeState.type === 'extend' ? 'Perpanjangan masa inap berhasil.' : 'Pemendekan masa inap berhasil.');
    } catch (error) {
      reservationResizePreviewRef.current = {
        ...reservationResizePreviewRef.current
      };
      delete reservationResizePreviewRef.current[String(reservationId)];
      setReservationResizePreview(reservationResizePreviewRef.current);
      await fetchData();
      await fetchOperationsData();
      closeStayChangePrompt();
      console.error(`${stayChangeState.type} stay failed`, error);
      alert(`Gagal ${stayChangeState.type === 'extend' ? 'memperpanjang' : 'memendekkan'} masa inap: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const quickActionButtons = [
    { key: 'checkin', label: 'Check In', enabled: canCheckIn, variant: 'success', onClick: () => handleReservationAction(Number(selectedRes?.id), 'checkin') },
    { key: 'checkout', label: 'Checkout', enabled: canCheckOut, variant: 'warn', onClick: () => openCheckoutConfirmation(Number(selectedRes?.id)) },
    { key: 'extend', label: 'Extend', enabled: canExtend, variant: 'primary', onClick: () => selectedRes && openStayChangePrompt('extend', Number(selectedRes.id)) },
    { key: 'shorten', label: 'Shorten', enabled: canShorten, variant: 'primary', onClick: () => selectedRes && openStayChangePrompt('shorten', Number(selectedRes.id)) },
    { key: 'cancel', label: 'Cancel', enabled: canCancel, variant: 'danger', onClick: () => handleReservationCancel(Number(selectedRes?.id)) },
    { key: 'payment', label: 'Payment', enabled: canPay, variant: 'primary', onClick: () => handlePayment() }
  ].filter((button) => button.enabled && Number.isFinite(Number(selectedRes?.id)));

  const copyBookingBid = async () => {
    const bid = String(selectedBooking?.bid || selectedRes?.bid || '').trim();
    if (!bid) {
      setBidCopyState({ kind: 'error', message: 'BID tidak tersedia' });
      window.setTimeout(() => setBidCopyState({ kind: 'idle', message: '' }), 1800);
      return;
    }

    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        throw new Error('Clipboard tidak tersedia');
      }
      await navigator.clipboard.writeText(bid);
      setBidCopyState({ kind: 'success', message: 'BID berhasil disalin' });
      window.setTimeout(() => setBidCopyState({ kind: 'idle', message: '' }), 1800);
    } catch (error) {
      console.error('Copy BID failed', error);
      setBidCopyState({ kind: 'error', message: 'Gagal menyalin BID' });
      window.setTimeout(() => setBidCopyState({ kind: 'idle', message: '' }), 2200);
    }
  };

  const bookingComposerTotals = bookingComposerChildren.reduce((summary, child) => {
    const subtotal = Number(child.subtotal_amount || child.total_price || 0);
    const paid = Number(child.amount_paid || 0);
    const discount = Number(child.discount_amount || 0) + (Number(child.discount_percent || 0) > 0 ? subtotal * (Number(child.discount_percent || 0) / 100) : 0);
    const total = Math.max(subtotal - discount, 0);
    return {
      subtotal: summary.subtotal + subtotal,
      discount: summary.discount + Math.min(Math.max(discount, 0), subtotal),
      paid: summary.paid + paid,
      total: summary.total + total,
      remaining: summary.remaining + Math.max(total - paid, 0),
    };
  }, { subtotal: 0, discount: 0, paid: 0, total: 0, remaining: 0 });

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
          <div className="hotel-brand">{properties.find((p) => p.id === propertyId)?.name || 'OAK HIMS'}</div>
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
             <h2 className="hotel-header-title">{properties.find((p: any) => p.id === propertyId)?.name || 'OAK HIMS'}</h2>
             <p className="hotel-header-subtitle">Selamat datang, vian.pradana89@gmail.com (Owner)</p>
           </div>
           <div className="hotel-header-actions">
             {properties.length > 1 && (
               <select
                 className="hotel-action-btn"
                 value={propertyId ?? ''}
                 onChange={(e) => {
                   const val = Number(e.target.value);
                   if (Number.isInteger(val) && val > 0) {
                     setTransactionReservations([]);
                     setTransactionError(null);
                     setDailyOperations(null);
                     transactionRequestVersionRef.current++;
                     dailyOperationsRequestVersionRef.current++;
                     setPropertyId(val);
                   }
                 }}
                 style={{ marginRight: 8 }}
               >
                 <option value="" disabled>Pilih Properti</option>
                 {properties.map((p: any) => (
                   <option key={p.id} value={p.id}>{p.name}</option>
                 ))}
               </select>
             )}
             <button className="hotel-action-btn">POS</button>
             <button className="hotel-action-btn">Deposit</button>
           </div>
          </header>

          {propertyId === null && (
            <div className="p-8 text-center text-gray-500">
              <p className="text-lg font-semibold">Tidak ada properti yang dikonfigurasi</p>
              <p className="text-sm mt-2">Hubungi administrator untuk menambahkan properti.</p>
            </div>
          )}

          {propertyId !== null && selectedMenu === 'Kalender' && (
          <>
            <div className="space-y-3">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <div className="text-xs uppercase tracking-[0.24em] text-blue-600 font-semibold">Operasional kalender</div>
                  <h3 className="text-lg font-semibold text-gray-900">Ringkasan booking hari ini</h3>
                </div>
                <div className="text-xs text-gray-500">
                  {calendarSearchQuery ? `Hasil pencarian: ${calendarSummary.totalReservations}` : `Total kamar: ${calendarSummary.totalRooms}`}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
                <StatCard title="Total Reservasi" value={String(calendarSummary.totalReservations)} color="hotel-stat-card--primary" />
                <StatCard title="Booked" value={String(calendarSummary.bookedReservations)} color="hotel-stat-card--booked" />
                <StatCard title="Check In" value={String(calendarSummary.checkedInReservations)} color="hotel-stat-card--checkedin" />
                <StatCard title="Check Out" value={String(calendarSummary.checkedOutReservations)} color="hotel-stat-card--checkout" />
                <StatCard title="Kamar Kotor" value={String(calendarSummary.dirtyRooms)} color="hotel-stat-card--dirty" />
                <StatCard title="Vacant Clean" value={String(calendarSummary.readyRooms)} color="hotel-stat-card--ready" />
              </div>
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
              <div className="flex flex-col gap-3 mb-4 lg:flex-row lg:justify-between lg:items-center">
                <div className="room-search-wrap calendar-search-wrap">
                  <span className="room-search-icon">⌕</span>
                  <input
                    type="text"
                    value={calendarSearch}
                    onChange={(e) => setCalendarSearch(e.target.value)}
                    placeholder="Cari BID, nama, HP, atau room..."
                    className="room-search-input"
                  />
                </div>
                <div className="flex flex-wrap gap-2 items-center">
                  <div className="calendar-date-nav" role="group" aria-label="Navigasi tanggal Tape Chart">
                    <button type="button" onClick={() => shiftDays(-7)}>‹ 7 Hari</button>
                    <button type="button" onClick={() => shiftDays(-1)}>‹ 1 Hari</button>
                    <button type="button" className="calendar-date-nav__today" onClick={goToday}>Hari Ini</button>
                    <button type="button" onClick={() => shiftDays(1)}>1 Hari ›</button>
                    <button type="button" onClick={() => shiftDays(7)}>7 Hari ›</button>
                  </div>

                  <button onClick={() => { setCalendarViewDate(anchorDate); setCalendarSelectedDate(localDateISO(anchorDate)); setCalendarOpen(true); }} className="calendar-month-picker">
                    <span className="text-base">📅</span>
                    <span>{new Date(anchorDate).toLocaleString('id-ID', { month: 'long' })}</span>
                  </button>
                </div>
                {calendarSearchQuery && (
                  <div className="text-xs text-gray-500">
                    Menyorot {calendarSummary.totalReservations} reservasi yang cocok dengan pencarian.
                  </div>
                )}
              </div>

              <CalendarFilters
                roomSearch={calendarRoomSearch}
                roomCategoryId={calendarRoomCategoryFilter}
                roomTypeId={calendarRoomTypeFilter}
                operationalStatus={calendarOperationalFilter}
                includeInactive={calendarIncludeInactive}
                categoryOptions={calendarCategoryOptions}
                typeOptions={calendarFilterTypeOptions}
                onRoomSearch={setCalendarRoomSearch}
                onRoomCategoryId={(value) => {
                  setCalendarRoomCategoryFilter(value);
                  setCalendarRoomTypeFilter('');
                }}
                onRoomTypeId={setCalendarRoomTypeFilter}
                onOperationalStatus={setCalendarOperationalFilter}
                onIncludeInactive={setCalendarIncludeInactive}
              />

              <div className="overflow-x-auto calendar-grid-shell">
                <table className="w-full border-collapse text-xs" style={{ tableLayout: 'fixed' }}>
                  <thead>
                    <tr className="bg-gray-100 border calendar-header-row">
                      <th className="p-3 border text-left calendar-sticky-corner" style={{ width: '220px', minWidth: '220px' }}>Kamar</th>
                      {days.map((d) => {
                        const todayIso = hotelDateFromInstant(new Date());
                        const isToday = d.date === todayIso;
                        return (
                          <th
                            key={d.date}
                            className={`header-date-cell calendar-sticky-header ${isToday ? 'header-date-cell--today' : ''}`}
                          >
                            <div className="day-header-label">{d.label}</div>
                            <div className={`day-header-number ${isToday ? 'is-today' : ''}`}>{d.raw.getDate()}</div>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {calendarCategoryGroups.map((category) => (
                      <Fragment key={category.key}>
                        <RoomCategoryGroup
                          group={category}
                          collapsed={collapsedCalendarGroups.has(category.key)}
                          columnCount={days.length + 1}
                          onToggle={() => toggleCalendarGroup(category.key)}
                        />
                        {!collapsedCalendarGroups.has(category.key) && category.roomTypes.map((group) => (
                          <Fragment key={group.key}>
                            <RoomTypeGroup
                              group={group}
                              collapsed={collapsedCalendarGroups.has(group.key)}
                              columnCount={days.length + 1}
                              onToggle={() => toggleCalendarGroup(group.key)}
                            />
                            {!collapsedCalendarGroups.has(group.key) && group.rooms.map((room) => {
                          const masterActive = room.room_type_id !== null && room.room_is_active !== false && room.room_type_is_active !== false;
                          return (
                            <tr key={room.id} className={`calendar-room-row border ${masterActive ? '' : 'calendar-room-row--inactive'}`}>
                              <td className="room-cell border font-medium bg-gray-50 text-[12px] text-gray-700 text-center align-middle calendar-sticky-column" style={{ width: '220px', minWidth: '220px' }}>
                                <div className="room-cell-inner calendar-room-identity">
                                  <div className="room-name-wrap calendar-room-number-line">
                                    <span className="room-dot"></span>
                                    <span className="room-name-text">{room.room_number}</span>
                                    {!masterActive && <span className="calendar-inactive-badge">Nonaktif</span>}
                                  </div>
                                  <div className="room-status-wrap calendar-room-status">{renderRoomStatusButton(room)}</div>
                                  {room.future_reservation_count > 0 && (
                                    <div className="calendar-future-hint">
                                      {room.future_reservation_count} reservasi mendatang · mulai {formatCompactHotelDate(room.next_future_check_in)}
                                    </div>
                                  )}
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
                                    const lifecycle = normalizeReservationLifecycle(r.status);
                                    const density = getCalendarReservationDensity(spanAt.span);
                                    const identity = getCalendarReservationIdentity(r);
                                    const searchMatch = isCalendarReservationMatch(r);
                                    const previewCheckOut = reservationResizePreview[String(r.id)] || r.check_out;
                                    const nights = Math.max(1, hotelNightsBetween(normalizeHotelDate(r.check_in), normalizeHotelDate(previewCheckOut)) ?? 1);
                                    cells.push(
                                      <ReservationBar
                                        key={`${room.id}-${i}-${r.id}`}
                                        reservation={r}
                                        span={spanAt.span}
                                        density={density}
                                        cardClass={reservationStyle.cardClass}
                                        badge={reservationStyle.badge}
                                        badgeClass={reservationStyle.badgeClass}
                                        paymentLabel={[getPaymentStatusLabel(r.payment_status), reservationStyle.paymentLabel].filter(Boolean).join(' · ')}
                                        segmentMeta={reservationStyle.segmentMeta}
                                        identity={identity}
                                        statusLabel={lifecycle.status}
                                        legacy={lifecycle.legacy || Boolean(r.legacy_status)}
                                        resizable={['BOOKED', 'CHECKED_IN'].includes(String(r.status || '').toUpperCase())}
                                        searchMatch={searchMatch}
                                        nights={nights}
                                        onDragStart={(event) => handleDragStart(event, r, room.id)}
                                        onDragEnd={handleDragEnd}
                                        onOpen={() => {
                                          setSelectedRes(r);
                                          fetchReservationFolio(Number(r.id));
                                        }}
                                        onResize={(event) => handleReservationResizeMouseDown(event, r)}
                                      />
                                    );
                                    i += spanAt.span;
                                  } else {
                                    const day = days[i];
                                    const operationalStatus = normalizeRoomStatus(roomStatuses[String(room.id)] || room.operational_status || room.status || undefined);
                                    const isToday = day.date === getOperationalDateKey();
                                    const cellState = !masterActive
                                      ? 'Inactive'
                                      : operationalStatus === 'Maintenance'
                                        ? 'Maintenance'
                                        : isToday && operationalStatus === 'Kotor'
                                          ? 'Kotor'
                                          : isToday && operationalStatus === 'Occupied'
                                            ? 'Occupied'
                                            : 'Available';
                                    const canQuickBook = cellState === 'Available';
                                    const canCleanDirtyNow = cellState === 'Kotor';
                                    cells.push(
                                      <td key={`${room.id}-${day.date}`} className="p-2 border text-center h-14 align-middle">
                                        <div
                                          className={`status-cell-wrap ${canQuickBook || canCleanDirtyNow ? 'status-cell-wrap--clickable' : ''}`}
                                          onDragOver={(event) => { if (canQuickBook) event.preventDefault(); }}
                                          onDrop={async (event) => {
                                            if (!canQuickBook) return;
                                            event.preventDefault();
                                            const reservationId = event.dataTransfer.getData('reservation-id');
                                            const fromRoomId = event.dataTransfer.getData('from-room-id');
                                            const toRoomId = String(room.id);
                                            if (!reservationId || fromRoomId === toRoomId) return;
                                            try {
                                              const response = await fetch(`/api/reservations/${reservationId}/move`, {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ property_id: propertyId, to_room_id: toRoomId })
                                              });
                                              const data = await response.json();
                                              if (response.ok) {
                                                await fetchDataRef.current();
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
                                            if (canQuickBook) openQuickBooking(room, day.date, addHotelDays(day.date, 1));
                                            if (canCleanDirtyNow) {
                                              setDirtyConfirmRoomId(Number(room.id));
                                              setDirtyConfirmDate(day.date);
                                              setDirtyConfirmOpen(true);
                                            }
                                          }}
                                        >
                                          {cellState === 'Available' && <div className="status-available-cell">Tersedia</div>}
                                          {cellState === 'Maintenance' && <div className="status-maintenance-cell">Maintenance</div>}
                                          {cellState === 'Occupied' && <div className="status-occupied-cell">Occupied</div>}
                                          {cellState === 'Kotor' && <div className="status-kotor-cell">Dirty</div>}
                                          {cellState === 'Inactive' && <div className="status-inactive-cell">Nonaktif</div>}
                                        </div>
                                      </td>
                                    );
                                    i += 1;
                                  }
                                }
                                return cells;
                              })()}
                            </tr>
                          );
                            })}
                          </Fragment>
                        ))}
                      </Fragment>
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
                    <button onClick={() => { setCreateResOpen(false); setKtpFile(null); setBuktiBayarFile(null); resetQuickBookingForm(); }} className="booking-modal-close" aria-label="Tutup dialog booking">×</button>
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

                      <div className="booking-field booking-field--full" style={{ marginTop: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                          <label style={{ marginBottom: 0 }}>Reservasi Kamar</label>
                          <button type="button" className="booking-add-btn" onClick={addBookingChild}>+ Tambah Kamar</button>
                        </div>

                        {bookingComposerChildren.length === 0 ? (
                          <div className="booking-child-card" style={{ padding: 12 }}>Belum ada kamar yang ditambahkan.</div>
                        ) : (
                          bookingComposerChildren.map((child, index) => (
                            <div key={child.id} className="booking-child-card" style={{ marginBottom: 12, padding: 12, border: '1px solid #e5e7eb', borderRadius: 12, background: '#f8fafc' }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                                <strong style={{ fontSize: 13 }}>R{String(index + 1).padStart(2, '0')}</strong>
                                {bookingComposerChildren.length > 1 && (
                                  <button type="button" onClick={() => removeBookingChild(child.id)} className="booking-cancel-btn" style={{ padding: '6px 10px', fontSize: 12 }}>Hapus</button>
                                )}
                              </div>

                              <div className="booking-row two-col">
                                <div className="booking-field">
                                  <label>Ruangan *</label>
                                  {(() => {
                                  const availabilityKey = getAvailabilityKey(child);
                                  const cachedRows = availabilityKey ? availabilityCache[availabilityKey] : undefined;
                                  const derivedRooms = cachedRows
                                    ? getFilteredAvailabilityRooms(cachedRows, availabilityKey, child)
                                    : (childRoomAvailability[child.id] || []);
                                  const derivedState = cachedRows
                                    ? (derivedRooms.length > 0 ? 'success' : 'empty')
                                    : bookingAvailabilityState[child.id];
                                  const isLoading = derivedState === 'loading' && !cachedRows;
                                  return (
                                  <select
                                    value={child.room_id ?? ''}
                                    onChange={(e) => {
                                      const roomId = e.target.value ? Number(e.target.value) : null;
                                      const selectedRoom = roomId === null
                                        ? null
                                        : rooms.find((room: any) => Number(room.id) === roomId);
                                      updateBookingChild(child.id, selectedRoom
                                        ? canonicalCalendarRoomBinding(selectedRoom)
                                        : { room_id: null, room_number: null });
                                    }}
                                    disabled={isLoading}
                                  >
                                    <option value="">
                                      {isLoading
                                        ? 'Memuat kamar tersedia...'
                                        : derivedState === 'empty'
                                          ? 'Tidak ada kamar tersedia untuk tanggal ini.'
                                          : derivedState === 'error'
                                            ? 'Gagal memuat ketersediaan kamar. Coba lagi.'
                                          : 'Pilih ruang'}
                                    </option>
                                    {derivedRooms.map((room: any) => (
                                      <option key={room.id} value={room.id}>
                                        {room.room_number} {room.name ? `(${room.name})` : ''}
                                      </option>
                                    ))}
                                  </select>
                                  );
                                  })()}
                                </div>
                                <div className="booking-field">
                                  <label>Tipe Kamar *</label>
                                  <select
                                    value={child.room_type_id ?? ''}
                                    onChange={(e) => {
                                      const roomTypeId = Number(e.target.value);
                                       const representative = rooms.find((room: any) => Number(room.room_type_id) === roomTypeId);
                                       updateBookingChild(child.id, {
                                         ...(representative
                                           ? canonicalRoomClassification(representative)
                                           : { room_type_id: roomTypeId }),
                                         room_variant: representative?.room_type_name || representative?.name || '',
                                         room_id: null,
                                         room_number: null,
                                       });
                                    }}
                                  >
                                    <option value="">Pilih tipe kamar</option>
                                    {calendarTypeOptions.map((option) => (
                                      <option key={option.id} value={option.id}>{option.label}</option>
                                    ))}
                                  </select>
                                </div>
                              </div>

                              <div className="booking-row two-col booking-date-row">
                                <div className="booking-field">
                                  <label>Check In</label>
                                  <input
                                    type="date"
                                    value={child.check_in || selectedRange.start || localDateISO(anchorDate)}
                                    onChange={(e) => updateBookingChild(child.id, { check_in: e.target.value })}
                                  />
                                </div>
                                <div className="booking-field">
                                  <label>Check Out</label>
                                  <input
                                    type="date"
                                    value={child.check_out || selectedRange.end || addHotelDays(localDateISO(anchorDate), 1)}
                                    onChange={(e) => updateBookingChild(child.id, { check_out: e.target.value })}
                                  />
                                </div>
                              </div>

                              <div className="booking-field booking-field--full">
                                <label>Harga Kamar</label>
                                <input
                                  type="number"
                                  min="0"
                                  step="1000"
                                  value={Number(child.subtotal_amount || 0)}
                                  onChange={(e) => {
                                    const nextSubtotal = Number(e.target.value || 0);
                                    updateBookingChild(child.id, {
                                      subtotal_amount: nextSubtotal,
                                      total_price: nextSubtotal,
                                      discount_amount: child.discount_type === 'nominal' ? Number(child.discount_amount || 0) : 0,
                                    });
                                  }}
                                  placeholder="0"
                                />
                              </div>

                              <div className="booking-field booking-field--full">
                                <label>Diskon</label>
                                <div className="booking-discount-control">
                                  <select
                                    value={child.discount_type || 'nominal'}
                                    onChange={(e) => {
                                      const nextType = e.target.value as 'nominal' | 'percent';
                                      updateBookingChild(child.id, { discount_type: nextType, discount_percent: nextType === 'percent' ? Number(child.discount_percent || 0) : 0 });
                                    }}
                                  >
                                    <option value="nominal">Rp</option>
                                    <option value="percent">%</option>
                                  </select>
                                  <input
                                    type="number"
                                    min="0"
                                    step={child.discount_type === 'percent' ? '1' : '1000'}
                                    value={child.discount_type === 'percent' ? Number(child.discount_percent || 0) : Number(child.discount_amount || 0)}
                                    onChange={(e) => {
                                      const nextValue = Number(e.target.value || 0);
                                      if (child.discount_type === 'percent') {
                                        updateBookingChild(child.id, { discount_percent: nextValue, discount_amount: 0 });
                                      } else {
                                        updateBookingChild(child.id, { discount_amount: nextValue, discount_percent: 0 });
                                      }
                                    }}
                                    placeholder={child.discount_type === 'percent' ? '0' : '50000'}
                                  />
                                </div>
                              </div>

                              <div className="booking-field booking-field--full">
                                <label>Jumlah Dibayar / DP</label>
                                <input
                                  type="number"
                                  min="0"
                                  step="1000"
                                  value={Number(child.amount_paid || 0)}
                                  onChange={(e) => updateBookingChild(child.id, { amount_paid: Number(e.target.value || 0) })}
                                  placeholder="0"
                                />
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    <div className="booking-side-panel">
                      <div className="booking-side-summary">
                        <div className="booking-summary-row">
                          <span>Status</span>
                          <strong>Booked</strong>
                        </div>
                        <div className="booking-summary-row">
                          <span>Kamar</span>
                          <strong>{bookingComposerChildren.length} kamar</strong>
                        </div>
                        <div className="booking-summary-row">
                          <span>Total</span>
                          <strong>{formatCurrency(bookingComposerTotals.total)}</strong>
                        </div>
                        <div className="booking-summary-row">
                          <span>Bayar</span>
                          <strong>{formatCurrency(bookingComposerTotals.paid)}</strong>
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
                      setKtpFile(null);
                      setBuktiBayarFile(null);
                      resetQuickBookingForm();
                    }} className="booking-cancel-btn">Batal</button>
                    <button
                      disabled={bookingComposerChildren.length === 0 || bookingSubmitting}
                      onClick={async () => {
                         if (bookingSubmitting) return;
                         if (propertyId === null) {
                           alert('Pilih properti terlebih dahulu');
                           return;
                         }
                         const name = quickBooking.guestName.trim() || 'Tamu';
                         const phone = quickBooking.guestPhone.trim();

                         if (bookingComposerChildren.length === 0) { alert('Pilih setidaknya satu kamar'); return; }
                         const incompleteChildIndex = bookingComposerChildren.findIndex((child) => canonicalBookingChildRoomId(child) === null);
                         if (incompleteChildIndex !== -1) {
                           alert(`Pilih ruangan untuk R${String(incompleteChildIndex + 1).padStart(2, '0')}`);
                           return;
                         }
                         const validChildren = bookingComposerChildren;
                         if (!phone) { alert('Nomor HP tamu wajib diisi'); return; }

                         for (const child of validChildren) {
                           const checkIn = child.check_in || '';
                           const checkOut = child.check_out || '';
                           if (!checkIn || !checkOut) { alert('Isi check-in dan check-out untuk setiap kamar'); return; }
                           if (new Date(checkOut) <= new Date(checkIn)) { alert(`Check-out harus setelah check-in pada kamar ${child.room_id}`); return; }
                        }

                         const overlapMap = new Map<number, Array<{ start: string; end: string }>>();
                         for (const child of validChildren) {
                           const roomId = canonicalBookingChildRoomId(child)!;
                          const childPeriod = { start: child.check_in, end: child.check_out };
                          const existing = overlapMap.get(roomId) || [];
                          for (const existingPeriod of existing) {
                            const startA = new Date(existingPeriod.start).getTime();
                            const endA = new Date(existingPeriod.end).getTime();
                            const startB = new Date(childPeriod.start).getTime();
                            const endB = new Date(childPeriod.end).getTime();
                            if (startB < endA && startA < endB) {
                              const roomNumber = rooms.find((room) => Number(room.id) === roomId)?.room_number || roomId;
                              alert(`Kamar ${roomNumber} memiliki tanggal yang tumpang tindih. Periksa kembali check-in dan check-out.`);
                              return;
                            }
                          }
                          existing.push(childPeriod);
                          overlapMap.set(roomId, existing);
                        }

                        const payload = {
                          property_id: propertyId,
                          guest_name: name,
                          guest_phone: phone,
                          guest_segment: guestSegment,
                          booking_source: bookingType,
                          channel: bookingType === 'ota' ? 'OTA' : 'WALKIN',
                          currency_code: 'IDR',
                          reservations: validChildren.map((child) => {
                            const subtotal = Number(child.subtotal_amount || 0);
                            const discountAmount = child.discount_type === 'percent'
                              ? 0
                              : Number(child.discount_amount || 0);
                            const discountPercent = child.discount_type === 'percent'
                              ? Number(child.discount_percent || 0)
                              : 0;
                            const amountPaid = Number(child.amount_paid || 0);
                            const totalPrice = Number(child.total_price ?? child.subtotal_amount ?? subtotal);
                             const totalAfterDiscount = Math.max(totalPrice - (child.discount_type === 'percent' ? totalPrice * (discountPercent / 100) : discountAmount), 0);
                             return {
                               room_id: canonicalBookingChildRoomId(child)!,
                              guest_name: child.guest_name || name,
                              guest_phone: child.guest_phone || phone,
                              guest_segment: child.guest_segment || guestSegment,
                              booking_type: child.booking_type || bookingType,
                              check_in: child.check_in,
                              check_out: child.check_out,
                              subtotal_amount: subtotal,
                              total_price: totalPrice,
                              discount_amount: child.discount_type === 'percent' ? totalPrice * (discountPercent / 100) : discountAmount,
                              discount_percent: discountPercent,
                              amount_paid: amountPaid,
                              payment_status: amountPaid > 0 ? (amountPaid >= totalAfterDiscount ? 'PAID' : 'PARTIAL') : 'UNPAID',
                              qty: 1,
                              room_variant: child.room_variant || quickBooking.roomVariant
                            };
                          })
                        };

                        try {
                          setBookingSubmitting(true);
                          setBookingComposerChildren((prev) => prev.map((child: any) => ({ ...child, payment_status: Number(child.amount_paid || 0) > 0 ? 'PAID' : 'UNPAID' })));
                          const res = await fetch('/api/bookings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                          });
                          const data = await res.json();

                          if (!res.ok) {
                            throw new Error(data.message || 'Gagal membuat booking');
                          }

                          const bid = String(data?.data?.bid || '').trim();
                          const roomCount = Array.isArray(data?.data?.reservations) ? data.data.reservations.length : validChildren.length;
                          if (bid && navigator.clipboard && navigator.clipboard.writeText) {
                            try { await navigator.clipboard.writeText(bid); } catch (copyErr) { console.warn('Copy BID failed', copyErr); }
                          }
                          fetchData();
                          fetchOperationsData();
                          setCreateResOpen(false);
                          setSelectedRange({});
                          setKtpFile(null);
                          setBuktiBayarFile(null);
                          resetQuickBookingForm();
                          alert(`Booking berhasil dibuat\nBID: ${bid}\n${roomCount} kamar berhasil dipesan`);
                        } catch (error) {
                          console.error('Booking creation failed', error);
                          alert(`Gagal membuat booking: ${error instanceof Error ? error.message : 'Unknown error'}`);
                        } finally {
                          setBookingSubmitting(false);
                        }
                      }}
                      className="booking-submit-btn"
                    >
                      {bookingSubmitting ? 'Menyimpan...' : (bookingComposerChildren.length > 1 ? 'Simpan Booking' : 'Simpan Reservasi')}
                    </button>
                  </div>
                 </div>
               </div>
             )}

          </>
        )}

        {selectedMenu === 'Transaksi' && (
          <div className="space-y-4">
            <TransactionReservationList
              propertyId={propertyId}
              todayHotelDate={hotelDateFromInstant(new Date())}
              reservations={transactionReservations}
              isLoading={transactionLoading}
              error={transactionError}
              onRefresh={(start, end) => fetchTransactionReservations(propertyId, start, end)}
              onCheckIn={(res) => handleReservationAction(Number(res.id), 'checkin')}
              onCheckout={(res) => openCheckoutConfirmation(Number(res.id))}
              onOpenDetail={(res) => {
                setSelectedRes(res);
                fetchReservationFolio(Number(res.id));
              }}
              onEdit={(res) => openReservationEditor(res)}
              onMove={(res) => openReservationEditor(res)}
              onExtend={(res) => {
                setSelectedRes(res);
                openStayChangePrompt('extend', Number(res.id));
              }}
              onCancel={(res) => handleReservationCancel(Number(res.id))}
              onViewFolio={(res) => {
                setSelectedRes(res);
                fetchReservationFolio(Number(res.id));
              }}
              onViewAudit={(res) => {
                setSelectedRes(res);
                fetchReservationAudit(Number(res.id));
              }}
              formatCurrency={formatCurrency}
              getPaymentStatusLabel={getPaymentStatusLabel}
              getPaymentBadgeClass={getPaymentBadgeClass}
            />

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
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs uppercase tracking-wider text-emerald-800 font-bold">Laporan & Analitik Operasional</div>
                <h3 className="text-xl font-bold text-gray-900 mt-0.5">Ringkasan Operasional Harian</h3>
                <p className="text-xs text-gray-500 mt-1">Tanggal Hotel: <span className="font-semibold text-slate-700">{dailyOperations?.business_date || dailyOperations?.date || hotelDateFromInstant(new Date())}</span> (Asia/Jakarta)</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  fetchDailyOperations(propertyId);
                  setOccupancyRefreshTrigger((prev) => prev + 1);
                }}
                className="hotel-action-btn text-xs font-semibold px-3 py-1.5"
              >
                {dailyOperationsLoading ? 'Memuat...' : '⟳ Segarkan'}
              </button>
            </div>

            {/* Section 1: Metrik Berdasarkan Tanggal Operasional */}
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                Operasional Tanggal {dailyOperations?.business_date || dailyOperations?.date || hotelDateFromInstant(new Date())}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="bg-white border rounded-xl p-4 shadow-sm">
                  <div className="text-[11px] uppercase font-bold text-slate-500 tracking-wide">Kedatangan (Arrivals)</div>
                  <div className="text-2xl font-bold text-blue-700 mt-1">
                    {dailyOperations?.business_date_metrics?.arrivals ?? dailyOperations?.lifecycle?.arrivals_today ?? 0}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1">Check-in pada tanggal ini</div>
                </div>
                <div className="bg-white border rounded-xl p-4 shadow-sm">
                  <div className="text-[11px] uppercase font-bold text-slate-500 tracking-wide">Keberangkatan (Departures)</div>
                  <div className="text-2xl font-bold text-amber-700 mt-1">
                    {dailyOperations?.business_date_metrics?.departures ?? dailyOperations?.lifecycle?.departures_today ?? 0}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1">Check-out pada tanggal ini</div>
                </div>
                <div className="bg-white border rounded-xl p-4 shadow-sm border-l-4 border-l-emerald-600">
                  <div className="text-[11px] uppercase font-bold text-slate-500 tracking-wide">Kas Masuk Tanggal Ini</div>
                  <div className="text-2xl font-bold text-emerald-800 mt-1">
                    {formatCurrency(dailyOperations?.business_date_metrics?.cash_collected ?? dailyOperations?.financials?.cash_collected_today ?? 0)}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1">Pembayaran sukses WIB</div>
                </div>
              </div>
            </div>

            {/* Section 2: Status Operasional Saat Ini (Live Snapshot) */}
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                Status Operasional Saat Ini (Live Snapshot)
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="bg-white border rounded-xl p-4 shadow-sm">
                  <div className="text-[11px] uppercase font-bold text-slate-500 tracking-wide">Tamu In-House Saat Ini</div>
                  <div className="text-2xl font-bold text-emerald-700 mt-1">
                    {dailyOperations?.live_snapshot?.in_house_current ?? dailyOperations?.lifecycle?.in_house ?? 0}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1">Kamar aktif berstatus Checked-In</div>
                </div>
                <div className="bg-white border rounded-xl p-4 shadow-sm">
                  <div className="text-[11px] uppercase font-bold text-slate-500 tracking-wide">Booking Aktif Berjalan</div>
                  <div className="text-2xl font-bold text-slate-800 mt-1">
                    {dailyOperations?.live_snapshot?.booked_active ?? dailyOperations?.lifecycle?.booked_future_or_today ?? 0}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1">Reservasi berstatus Booked</div>
                </div>
                <div className="bg-white border rounded-xl p-4 shadow-sm border-l-4 border-l-amber-500">
                  <div className="text-[11px] uppercase font-bold text-slate-500 tracking-wide">Piutang Tamu Berjalan</div>
                  <div className="text-2xl font-bold text-amber-800 mt-1">
                    {formatCurrency(dailyOperations?.live_snapshot?.outstanding_guest_balance_current ?? dailyOperations?.financials?.outstanding_guest_balance ?? 0)}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1">Sisa tagihan reservasi non-cancelled</div>
                </div>
              </div>
            </div>

            {/* Section 3: Room Status Real-Time */}
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                Status Kamar Real-Time ({dailyOperations?.live_snapshot?.total_active_rooms ?? dailyOperations?.rooms?.total_active_rooms ?? 0} Kamar Aktif)
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3.5 shadow-sm">
                  <div className="text-[10px] uppercase font-bold text-emerald-800 tracking-wide">Siap Huni (Ready)</div>
                  <div className="text-2xl font-bold text-emerald-900 mt-1">{dailyOperations?.rooms?.vacant_ready ?? 0}</div>
                </div>
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 shadow-sm">
                  <div className="text-[10px] uppercase font-bold text-amber-800 tracking-wide">Kotor (Dirty)</div>
                  <div className="text-2xl font-bold text-amber-900 mt-1">{dailyOperations?.rooms?.vacant_dirty ?? 0}</div>
                </div>
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-3.5 shadow-sm">
                  <div className="text-[10px] uppercase font-bold text-blue-800 tracking-wide">Pembersihan</div>
                  <div className="text-2xl font-bold text-blue-900 mt-1">{dailyOperations?.rooms?.cleaning ?? 0}</div>
                </div>
                <div className="bg-purple-50 border border-purple-200 rounded-xl p-3.5 shadow-sm">
                  <div className="text-[10px] uppercase font-bold text-purple-800 tracking-wide">Inspeksi</div>
                  <div className="text-2xl font-bold text-purple-900 mt-1">{dailyOperations?.rooms?.waiting_inspection ?? 0}</div>
                </div>
                <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-3.5 shadow-sm">
                  <div className="text-[10px] uppercase font-bold text-indigo-800 tracking-wide">Terisi (Occupied)</div>
                  <div className="text-2xl font-bold text-indigo-900 mt-1">{dailyOperations?.rooms?.occupied ?? 0}</div>
                </div>
                <div className="bg-red-50 border border-red-200 rounded-xl p-3.5 shadow-sm">
                  <div className="text-[10px] uppercase font-bold text-red-800 tracking-wide">Out of Order / Svc</div>
                  <div className="text-2xl font-bold text-red-900 mt-1">{dailyOperations?.rooms?.out_of_order_or_service ?? 0}</div>
                </div>
              </div>
            </div>

            {/* Section: Kinerja Kamar (Occupancy Engine) */}
            <div className="border-t border-slate-200 pt-2">
              <OccupancySection
                propertyId={propertyId}
                refreshTrigger={occupancyRefreshTrigger}
              />
            </div>

            {/* Section 4: Akuntansi Ringkasan */}
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Ringkasan Buku Besar Akuntansi</div>
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-white border rounded shadow-sm p-4">
                  <div className="text-xs uppercase text-gray-500 font-semibold">Hutang Vendor</div>
                  <div className="text-2xl font-bold mt-2 text-slate-800">Rp {Number(financeSummary?.total_payable || 0).toLocaleString('id-ID')}</div>
                </div>
                <div className="bg-white border rounded shadow-sm p-4">
                  <div className="text-xs uppercase text-gray-500 font-semibold">Piutang Tamu (Buku Besar)</div>
                  <div className="text-2xl font-bold mt-2 text-slate-800">Rp {Number(financeSummary?.total_receivable || 0).toLocaleString('id-ID')}</div>
                </div>
                <div className="bg-white border rounded shadow-sm p-4">
                  <div className="text-xs uppercase text-gray-500 font-semibold">Jumlah Jurnal</div>
                  <div className="text-2xl font-bold mt-2 text-slate-800">{financeSummary?.entries?.length || 0}</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {selectedMenu === 'Produk & Inventori' && (
          <ProductInventorySection
            propertyId={propertyId}
            posMenuCount={posMenu.length}
            posOrderCount={posOrders.length}
            onViewReservation={viewRoomMasterReservation}
          />
        )}

        {selectedMenu === 'Pelanggan' && (
          <GuestCrmWorkspace propertyId={propertyId} />
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
              <button onClick={() => { setSelectedRes(null); setSelectedFolio(null); setPaymentDraft(''); setBidCopyState({ kind: 'idle', message: '' }); }} className="reservation-detail-close">Tutup</button>
            </div>

            <div className="reservation-detail-body">
              <div className="reservation-detail-topbar">
                <div className="booking-identity-block">
                  <div className="booking-identity-label">Booking Identity</div>
                  <div className="booking-identity-bid-row">
                    <div className="booking-identity-bid">{selectedBookingIdentity}</div>
                    <button type="button" className="booking-copy-btn" onClick={copyBookingBid}>Copy</button>
                  </div>
                  <div className="booking-identity-name">{selectedRes.guest_name}</div>
                  {bidCopyState.kind !== 'idle' && (
                    <div className={`booking-copy-state booking-copy-state--${bidCopyState.kind}`}>
                      {bidCopyState.message}
                    </div>
                  )}
                  <div className="booking-identity-line">
                    {selectedStayLabel} · Room {selectedRoomLabel} · {selectedRoomTypeLabel}
                  </div>
                  <div className="booking-identity-secondary">
                    <span>Legacy: {selectedBookingLegacy || '—'}</span>
                    <span>Reservation ID: {selectedRes.id}</span>
                  </div>
                </div>

                <div className="reservation-detail-badges reservation-detail-badges--stacked">
                  <div className="status-grid">
                    <div className="status-pill">
                      <span className="status-pill__label">Booking</span>
                      <span className="status-pill__value">{activeBookingStatus || '—'}</span>
                    </div>
                    <div className="status-pill">
                      <span className="status-pill__label">Reservation</span>
                      <span className="status-pill__value">{activeReservationStatus || '—'}</span>
                    </div>
                    <div className="status-pill">
                      <span className="status-pill__label">Stay</span>
                      <span className="status-pill__value">{activeStayStatus || '—'}</span>
                    </div>
                    <div className="status-pill">
                      <span className="status-pill__label">Payment</span>
                      <span className="status-pill__value">{activePaymentStatus}</span>
                    </div>
                  </div>
                  <div className="source-channel-grid">
                    <div className="mini-meta">
                      <span className="mini-meta__label">Booking Source</span>
                      <strong className="mini-meta__value">{selectedBookingSource || '—'}</strong>
                    </div>
                    <div className="mini-meta">
                      <span className="mini-meta__label">Channel</span>
                      <strong className="mini-meta__value">{selectedBookingChannel || '—'}</strong>
                    </div>
                  </div>
                </div>
              </div>

              {bookingChildren.length > 1 && (
                <div className="detail-section">
                  <div className="detail-section-title">Rooms in this booking</div>
                  <div className="booking-child-list">
                    {bookingChildren.map((child: any) => {
                      const childStay = child.stay_sequence ? `R${String(child.stay_sequence).padStart(2, '0')}` : 'R--';
                      const childActive = Number(child.id) === Number(selectedRes.id);
                      return (
                        <button
                          key={child.id}
                          type="button"
                          className={`booking-child-item booking-child-item--button ${childActive ? 'booking-child-item--active' : ''}`}
                          onClick={() => {
                            if (childActive) return;
                            setSelectedRes(child);
                            fetchReservationFolio(Number(child.id));
                          }}
                        >
                          <div className="booking-child-item__top">
                            <strong>{childStay} · Room {child.room_number || child.room_id || '—'}</strong>
                            <span className="booking-child-status">{child.status || '—'}</span>
                          </div>
                          <div className="booking-child-item__meta">
                            <span>{child.room_variant || child.room_type || '—'}</span>
                            <span>{normalizeHotelDate(child.check_in) || '—'}</span>
                            <span>{normalizeHotelDate(child.check_out) || '—'}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="detail-section">
                <div className="detail-section-title">Quick Actions</div>
                <div className="reservation-action-row reservation-action-row--dense">
                  {quickActionButtons.map((button) => (
                    <button
                      key={button.key}
                      type="button"
                      className={`reservation-action-button reservation-action-button--${button.variant}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        button.onClick();
                      }}
                    >
                      {button.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="detail-section">
                <div className="detail-section-title">Stay information</div>
                <div className="detail-info-grid">
                  <div className="detail-info-card">
                    <div className="detail-card-label">Check-in</div>
                    <div className="detail-card-value">{normalizeHotelDate(selectedRes.check_in) || '—'}</div>
                  </div>
                  <div className="detail-info-card">
                    <div className="detail-card-label">Check-out</div>
                    <div className="detail-card-value">{normalizeHotelDate(selectedRes.check_out) || '—'}</div>
                  </div>
                  <div className="detail-info-card">
                    <div className="detail-card-label">Nights</div>
                    <div className="detail-card-value">{selectedNights}</div>
                  </div>
                  <div className="detail-info-card">
                    <div className="detail-card-label">Room</div>
                    <div className="detail-card-value">{selectedRoomLabel}</div>
                  </div>
                  <div className="detail-info-card">
                    <div className="detail-card-label">Room Type</div>
                    <div className="detail-card-value">{selectedRoomTypeLabel}</div>
                  </div>
                  <div className="detail-info-card">
                    <div className="detail-card-label">Guest Segment</div>
                    <div className="detail-card-value">{selectedRes.guest_segment || '—'}</div>
                  </div>
                  <div className="detail-info-card">
                    <div className="detail-card-label">Phone</div>
                    <div className="detail-card-value">{selectedRes.guest_phone || '—'}</div>
                  </div>
                </div>
              </div>

              <div className="detail-section">
                <div className="detail-section-title">Financial summary</div>
                <div className="detail-summary-grid">
                  <div className="summary-box summary-box--compact">
                    <div className="summary-box-row"><span>Subtotal</span><strong>{formatCurrency(Number(selectedRes.subtotal_amount || 0))}</strong></div>
                    <div className="summary-box-row"><span>Discount</span><strong>{formatCurrency(Number(selectedRes.discount_amount || 0))}</strong></div>
                    <div className="summary-box-row"><span>Total</span><strong>{formatCurrency(Number(selectedRes.total_price || 0))}</strong></div>
                    <div className="summary-box-row"><span>Paid</span><strong>{formatCurrency(Number(selectedRes.amount_paid || 0))}</strong></div>
                    <div className="summary-box-row total"><span>Remaining Balance</span><strong>{formatCurrency(Number(selectedRes.remaining_balance || 0))}</strong></div>
                    <div className="summary-box-row"><span>Payment Status</span><strong>{activePaymentStatus}</strong></div>
                  </div>
                  <div className="summary-box summary-box--compact">
                    <div className="summary-box-head">Folio snapshot</div>
                    <div className="summary-box-row"><span>Total tagihan</span><strong>{formatCurrency(Number(selectedRes.total_price || 0))}</strong></div>
                    <div className="summary-box-row"><span>Sudah dibayar</span><strong>{formatCurrency(Number(selectedFolio?.payments?.reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0) || 0))}</strong></div>
                    <div className="summary-box-row total"><span>Sisa</span><strong>{formatCurrency(Math.max(Number(selectedRes.total_price || 0) - (selectedFolio?.payments?.reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0) || 0), 0))}</strong></div>
                  </div>
                </div>
              </div>

              {(selectedRes.ktp_path || selectedRes.bukti_bayar_path) && (
                <div className="detail-section">
                  <div className="detail-section-title">Documents</div>
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

              <div className="detail-section">
                <div className="detail-section-title">Operational actions</div>
                <div className="reservation-action-row reservation-action-row--dense">
                  {canCheckIn && (
                    <button
                      onClick={() => handleReservationAction(Number(selectedRes.id), 'checkin')}
                      className="reservation-action-button reservation-action-button--success"
                    >
                      Check In
                    </button>
                  )}
                  {canCheckOut && (
                    <button
                      onClick={() => openCheckoutConfirmation(Number(selectedRes.id))}
                      className="reservation-action-button reservation-action-button--warn"
                    >
                      Checkout
                    </button>
                  )}
                  {canCancel && (
                    <button
                      onClick={() => handleReservationCancel(Number(selectedRes.id))}
                      className="reservation-action-button reservation-action-button--danger"
                    >
                      Cancel
                    </button>
                  )}
                  {canPay && (
                    <button
                      onClick={handlePayment}
                      className="reservation-action-button reservation-action-button--primary"
                    >
                      Payment
                    </button>
                  )}
                </div>

                {selectedRes.room_id && (
                  <div className="reservation-turnover-row reservation-turnover-row--spaced">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.12em] text-slate-500 font-bold">Room status</div>
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
                )}

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
              </div>

              <div className="detail-history-grid">
                <div className="reservation-audit-panel">
                  <div className="reservation-doc-title">Reservation Activity</div>
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

                {selectedFolio?.folio?.length ? (
                  <div className="reservation-folio-panel">
                    <div className="reservation-doc-title">Folio History</div>
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

                {reservationAudit.length ? (
                  <div className="reservation-audit-panel">
                    <div className="reservation-doc-title">Audit Trail</div>
                    <div className="reservation-audit-list">
                      {reservationAudit.slice(0, 8).map((audit: any) => (
                        <div key={`${audit.audit_id || audit.id}-${audit.timestamp}-trail`} className="reservation-audit-item">
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

      {stayChangeState.open && (
        <div className="booking-modal-backdrop" role="dialog" aria-modal="true">
          <div className="checkout-confirm-modal">
            <div className="checkout-confirm-icon">{stayChangeState.type === 'extend' ? '↗' : '↘'}</div>
            <h3 className="checkout-confirm-title">{stayChangeState.type === 'extend' ? 'Perpanjang masa menginap?' : 'Perpendek masa menginap?'}</h3>
            <p className="checkout-confirm-text">
              {stayChangeState.type === 'extend'
                ? 'Konfirmasi perpanjangan hingga tanggal check-out baru.'
                : 'Konfirmasi pemendekan hingga tanggal check-out baru.'}
            </p>
            <div className="reservation-payment-panel" style={{ marginTop: 8 }}>
              <div className="text-xs text-slate-600 mb-2">
                BID: <strong>{String(stayChangeReservation?.bid || selectedBooking?.bid || selectedRes?.bid || '—')}</strong>
              </div>
              <div className="text-xs text-slate-600 mb-2">
                Kamar: <strong>{stayChangeReservation?.room_number || stayChangeReservation?.room_id || '—'}</strong>
              </div>
              <div className="text-xs text-slate-600 mb-2">
                Check-out saat ini: <strong>{(() => {
                return normalizeHotelDate(stayChangeReservation?.check_out) || '—';
                })()}</strong>
              </div>
              <div className="text-xs text-slate-600 mb-2">
                Check-out baru: <strong>{stayChangeState.newCheckOut || '—'}</strong>
              </div>
              <div className="text-xs text-slate-600 mb-2">
                Perubahan malam: <strong>{stayChangeNightsDelta > 0 ? `+${stayChangeNightsDelta}` : stayChangeNightsDelta < 0 ? `${stayChangeNightsDelta}` : '0'}</strong>
              </div>
              <label className="text-xs font-semibold text-slate-700">New check-out</label>
              <input
                type="date"
                value={stayChangeState.newCheckOut}
                onChange={(event) => setStayChangeState((prev) => ({ ...prev, newCheckOut: event.target.value }))}
                className="mt-2 flex-1 border rounded px-3 py-2 text-sm w-full"
              />
            </div>
            <div className="checkout-confirm-actions">
              <button type="button" className="checkout-confirm-btn checkout-confirm-btn--secondary" onClick={closeStayChangePrompt}>
                Batal
              </button>
              <button type="button" className="checkout-confirm-btn checkout-confirm-btn--primary" onClick={confirmStayChange}>
                {stayChangeState.type === 'extend' ? 'Confirm Extend' : 'Confirm Shorten'}
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
