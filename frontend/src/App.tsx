import { Fragment, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { TransactionWorkspace } from './features/transactions/TransactionWorkspace.tsx';
import {
  formatIdrInput,
  parseIdrInput,
  validateIdrPaymentInput,
  calculateRemainingBalancePreview,
} from './features/transactions/paymentIdrHelpers.ts';
import {
  isPaymentEligibleForCorrection,
  calculateCorrectionDifference,
  validateCorrectionForm,
  validateVoidForm,
  formatHotelTimestamp,
  formatActorName,
  getPaymentStatusVisual,
  getReasonLabel,
  PAYMENT_CORRECTION_REASONS,
  type PaymentTransactionItem,
} from './features/transactions/paymentCorrectionHelpers.ts';
import {
  PaymentEvidenceUploader,
  type PaymentEvidenceFormState
} from './features/transactions/PaymentEvidenceUploader.tsx';
import {
  PaymentEvidencePreviewModal
} from './features/transactions/PaymentEvidencePreviewModal.tsx';
import {
  getPaymentEvidenceStatus,
  getActiveEvidences,
  getInactiveEvidences,
  formatEvidenceType,
  formatEvidenceFileSize,
  formatEvidenceDate,
} from './features/transactions/paymentEvidenceHelpers.ts';
import type {
  PaymentEvidenceItem,
  PaymentEvidenceType
} from './features/transactions/paymentEvidenceTypes.ts';
import { GuestCrmWorkspace } from './features/guests/GuestCrmWorkspace.tsx';
import { HousekeepingWorkspace } from './features/housekeeping/HousekeepingWorkspace.tsx';
import { EmployeeMobileWorkspace } from './features/employee/EmployeeMobileWorkspace.tsx';
import { EmployeeMobileManagementWorkspace } from './features/employee/EmployeeMobileManagementWorkspace.tsx';
import { HrdWorkspace } from './features/hrd/HrdWorkspace.tsx';
import { OccupancySection } from './features/reports/OccupancySection.tsx';
import ProductInventorySection from './features/productInventory/ProductInventorySection';
import RoomMasterPage from './features/roomMaster/RoomMasterPage';
import ProductMasterPage from './features/products/ProductMasterPage';
import PosWorkspace from './features/pos/PosWorkspace';
import { GlobalOperationsBar } from './features/shell/GlobalOperationsBar.tsx';
import { AppSidebar } from './features/shell/AppSidebar.tsx';
import type { MainNavKey } from './features/shell/shellTypes.ts';
import { AuthProvider, useAuth } from './features/auth/AuthContext';
import { ProtectedRoute } from './features/auth/ProtectedRoute';
import { isMenuAllowedForRole, getDefaultMenuForRole } from './features/auth/permissions';
import { ManagementSettingsWorkspace, type SettingsCategoryKey } from './features/settings/ManagementSettingsWorkspace.tsx';
import { getFallbackPropertyBranding, type PropertyBrandingConfig } from './features/propertySettings/propertyBrandingTypes.ts';
import { fetchPropertyBranding, savePropertyBranding } from './features/propertySettings/propertyBrandingApi.ts';
import type { ActiveRoomReservation } from './features/roomMaster/roomMasterTypes';
import CalendarFilters from './features/calendar/CalendarFilters';
import ReservationBar from './features/calendar/ReservationBar';
import OperationalBlockBar from './features/calendar/OperationalBlockBar';
import OperationalBlockDetailModal from './features/calendar/OperationalBlockDetailModal';
import RoomCategoryGroup from './features/calendar/RoomCategoryGroup';
import RoomTypeGroup from './features/calendar/RoomTypeGroup';
import QuickBookingModal from './features/booking/QuickBookingModal';
import ReservationDetailDrawer from './features/calendar/ReservationDetailDrawer';
import QuickReservationDetail from './features/calendar/QuickReservationDetail';
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
  type RoomOperationalBlock,
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

function AppContent() {
  const { user, logout } = useAuth();
  const [propertyId, setPropertyId] = useState<number | null>(null);
  const [properties, setProperties] = useState<any[]>([]);
  const [reservations, setReservations] = useState<any[]>([]);
  const [rooms, setRooms] = useState<any[]>([]);
  const [selectedRes, setSelectedRes] = useState<any>(null);
  const [quickReservation, setQuickReservation] = useState<{
    reservation: any;
    anchorRect: DOMRect | null;
    anchorPoint: { x: number; y: number } | null;
  } | null>(null);
  const isDraggingRef = useRef(false);
  const [selectedOperationalBlock, setSelectedOperationalBlock] = useState<{
    block: RoomOperationalBlock;
    roomNumber: string;
    roomTypeName: string;
  } | null>(null);
  const [selectedFolio, setSelectedFolio] = useState<any>(null);
  const [reservationAudit, setReservationAudit] = useState<any[]>([]);
  const [selectedBooking, setSelectedBooking] = useState<any>(null);
  const [selectedBookingChildren, setSelectedBookingChildren] = useState<any[]>([]);
  const [bidCopyState, setBidCopyState] = useState<{ kind: 'idle' | 'success' | 'error'; message: string }>({ kind: 'idle', message: '' });
  const [paymentDraft, setPaymentDraft] = useState<string>('');
  const [paymentSubmitting, setPaymentSubmitting] = useState<boolean>(false);
  const [paymentFeedback, setPaymentFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const paymentInputRef = useRef<HTMLInputElement | null>(null);

  const [activePaymentMenuId, setActivePaymentMenuId] = useState<number | null>(null);
  const [paymentDetailModal, setPaymentDetailModal] = useState<{
    open: boolean;
    payment: PaymentTransactionItem | null;
  }>({ open: false, payment: null });
  const [paymentCorrectionModal, setPaymentCorrectionModal] = useState<{
    open: boolean;
    payment: PaymentTransactionItem | null;
    newAmountDraft: string;
    paymentMethod: string;
    reasonCode: string;
    reasonText: string;
    submitting: boolean;
    error: string | null;
  }>({
    open: false,
    payment: null,
    newAmountDraft: '',
    paymentMethod: 'CASH',
    reasonCode: 'WRONG_AMOUNT',
    reasonText: '',
    submitting: false,
    error: null,
  });
  const [paymentVoidModal, setPaymentVoidModal] = useState<{
    open: boolean;
    payment: PaymentTransactionItem | null;
    reasonCode: string;
    reasonText: string;
    submitting: boolean;
    error: string | null;
  }>({
    open: false,
    payment: null,
    reasonCode: 'PAYMENT_CANCELLED',
    reasonText: '',
    submitting: false,
    error: null,
  });
  const [paymentEvidenceForm, setPaymentEvidenceForm] = useState<PaymentEvidenceFormState>({
    file: null,
    evidenceType: 'BANK_TRANSFER',
    note: ''
  });
  const [paymentCorrectionEvidenceForm, setPaymentCorrectionEvidenceForm] = useState<PaymentEvidenceFormState>({
    file: null,
    evidenceType: 'CASH_RECEIPT',
    note: ''
  });
  const [previewEvidence, setPreviewEvidence] = useState<PaymentEvidenceItem | null>(null);
  const [deactivateEvidenceModal, setDeactivateEvidenceModal] = useState<{
    open: boolean;
    evidence: PaymentEvidenceItem | null;
    reason: string;
    submitting: boolean;
    error: string | null;
  }>({
    open: false,
    evidence: null,
    reason: '',
    submitting: false,
    error: null
  });
  const [uploadExtraEvidenceModal, setUploadExtraEvidenceModal] = useState<{
    open: boolean;
    paymentId: number | null;
    form: PaymentEvidenceFormState;
    submitting: boolean;
    error: string | null;
  }>({
    open: false,
    paymentId: null,
    form: { file: null, evidenceType: 'BANK_TRANSFER', note: '' },
    submitting: false,
    error: null
  });
  const [roomStatuses, setRoomStatuses] = useState<Record<string, string>>({});
  const [housekeepingTasks, setHousekeepingTasks] = useState<any[]>([]);
  const [checkoutInspections, setCheckoutInspections] = useState<any[]>([]);
  const [pendingCheckoutInspectionsCount, setPendingCheckoutInspectionsCount] = useState<number>(0);
  const [selectedCheckoutInspection, setSelectedCheckoutInspection] = useState<any | null>(null);
  const [maintenanceTasks, setMaintenanceTasks] = useState<any[]>([]);
  const [posOrders, setPosOrders] = useState<any[]>([]);
  const [posMenu, setPosMenu] = useState<any[]>([]);
  const [financeSummary, setFinanceSummary] = useState<any>(null);
  const [employees, setEmployees] = useState<any[]>([]);
  const [payroll, setPayroll] = useState<any[]>([]);
  const [selectedMenu, setSelectedMenu] = useState<MainNavKey>('Kalender');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('oak_sidebar_collapsed') === 'true';
    } catch {
      return false;
    }
  });
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState<boolean>(false);
  const [propertyBrandings, setPropertyBrandings] = useState<Record<number, PropertyBrandingConfig>>({});

  const handleToggleSidebarCollapse = () => {
    setIsSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('oak_sidebar_collapsed', String(next));
      } catch {}
      return next;
    });
  };

  // Guard active menu automatically based on user role permissions
  useEffect(() => {
    if (user && !isMenuAllowedForRole(selectedMenu, user.role)) {
      setSelectedMenu(getDefaultMenuForRole(user.role));
    }
  }, [user, selectedMenu]);

  const handleSelectMenu = (menu: MainNavKey) => {
    if (user && !isMenuAllowedForRole(menu, user.role)) {
      return;
    }
    setSelectedMenu(menu);
  };

  const handleSelectProperty = (val: number) => {
    if (Number.isInteger(val) && val > 0) {
      setTransactionReservations([]);
      setTransactionError(null);
      setDailyOperations(null);
      transactionRequestVersionRef.current++;
      dailyOperationsRequestVersionRef.current++;
      setPropertyId(val);
    }
  };

  useEffect(() => {
    if (!propertyId) return;
    let isMounted = true;
    const currentProp = properties.find((p: any) => p.id === propertyId);
    fetchPropertyBranding(propertyId, currentProp?.name, currentProp?.property_code)
      .then((branding) => {
        if (isMounted) {
          setPropertyBrandings((prev) => ({
            ...prev,
            [propertyId]: branding,
          }));
        }
      })
      .catch(() => {
        // Fallback already handled in fetchPropertyBranding
      });
    return () => {
      isMounted = false;
    };
  }, [propertyId, properties]);

  const activeBranding = useMemo(() => {
    if (!propertyId) return undefined;
    const existing = propertyBrandings[propertyId];
    if (existing) return existing;
    const currentProp = properties.find((p: any) => p.id === propertyId);
    return getFallbackPropertyBranding(propertyId, currentProp?.name, currentProp?.property_code);
  }, [propertyId, properties, propertyBrandings]);

  const [propertyFeatures, setPropertyFeatures] = useState<Record<string, boolean>>({});
  const [initialSettingsCategory, setInitialSettingsCategory] = useState<SettingsCategoryKey>('housekeeping');

  useEffect(() => {
    if (!propertyId) return;
    let isMounted = true;
    fetch(`/api/properties/${propertyId}/features`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (isMounted && data?.data) {
          setPropertyFeatures(data.data);
        }
      })
      .catch((err) => console.error('Failed to fetch property features:', err));
    return () => {
      isMounted = false;
    };
  }, [propertyId]);

  const handleSaveBranding = async (updated: PropertyBrandingConfig) => {
    const saved = await savePropertyBranding(updated.propertyId, updated);
    setPropertyBrandings((prev) => ({
      ...prev,
      [saved.propertyId]: saved,
    }));
  };
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

  const fetchProperties = useCallback(() => {
    fetch('/api/properties')
      .then(r => r.json())
      .then(d => {
        if (d.status === 'OK' && Array.isArray(d.data)) {
          const list = d.data.filter((p: any) => p.is_active !== false);
          setProperties(list);
          if (list.length === 0) {
            setPropertyId(null);
          } else if (propertyId === null || !list.some((p: any) => p.id === propertyId)) {
            setPropertyId(list[0].id);
          }
        }
      })
      .catch(() => {});
  }, [propertyId]);

  useEffect(() => {
    fetchProperties();
  }, [fetchProperties]);
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
    isDraggingRef.current = true;
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
    setTimeout(() => {
      isDraggingRef.current = false;
    }, 150);
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

  const operationalBlockSpans = useMemo(() => {
    const map: Record<string, Array<{ startIndex: number; span: number; block: RoomOperationalBlock }>> = {};

    const getBlockSpan = (startDate: string, endDate: string) => {
      const s = normalizeHotelDate(startDate);
      const e = normalizeHotelDate(endDate);
      if (!s || !e || s === e) return null;

      const firstVisibleDate = days[0]?.date;
      const visibleRangeEnd = days.length > 0 ? addHotelDays(days[days.length - 1].date, 1) : '';
      if (!firstVisibleDate || !visibleRangeEnd || e <= firstVisibleDate || s >= visibleRangeEnd) return null;

      const startIndex = days.findIndex(d => d.date === s);
      const endIndex = days.findIndex(d => d.date === e);

      const visibleStart = startIndex === -1 && s < firstVisibleDate ? 0 : startIndex;
      const visibleEnd = endIndex === -1 && e >= visibleRangeEnd ? days.length : endIndex;
      if (visibleStart < 0 || visibleEnd < 0 || visibleEnd <= visibleStart) return null;
      const span = Math.max(1, visibleEnd - visibleStart);
      return { startIndex: visibleStart, span };
    };

    for (const room of (rooms as CalendarRoom[])) {
      const roomId = String(room.id);
      const blocks = room.operational_blocks || [];
      for (const block of blocks) {
        if (block.status !== 'ACTIVE') continue;
        const bSpan = getBlockSpan(block.start_date, block.end_date);
        if (!bSpan) continue;
        if (!map[roomId]) map[roomId] = [];
        map[roomId].push({ startIndex: bSpan.startIndex, span: bSpan.span, block });
      }
    }

    for (const k of Object.keys(map)) {
      map[k].sort((a, b) => a.startIndex - b.startIndex);
    }
    return map;
  }, [rooms, days]);

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
    if (value === 'CLEANING') return 'Cleaning';
    if (value === 'OUT_OF_ORDER' || value === 'OUT_OF_SERVICE' || value.includes('MAINT')) return 'Maintenance';
    if (value === 'OCCUPIED_CLEAN' || value === 'OCCUPIED_DIRTY' || value.includes('OCC')) return 'Occupied';
    if (value === 'VACANT_CLEAN' || value === 'INSPECTED' || value === 'CLEAN') return 'Ready';
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
      const [housekeepingRes, maintenanceRes, posMenuRes, posOrderRes, financeRes, employeesRes, payrollRes, checkoutRes] = await Promise.all([
        fetch(`/api/housekeeping/tasks?property_id=${targetPropertyId}`),
        fetch(`/api/maintenance/tasks?property_id=${targetPropertyId}`),
        fetch(`/api/pos/menu?property_id=${targetPropertyId}`),
        fetch('/api/pos/orders?property_id=' + targetPropertyId),
        fetch('/api/accounting/summary?property_id=' + targetPropertyId),
        fetch('/api/hr/employees'),
        fetch('/api/hr/payroll'),
        fetch(`/api/housekeeping/checkout-inspections?property_id=${targetPropertyId}`)
      ]);

      const housekeepingData = await housekeepingRes.json();
      const maintenanceData = await maintenanceRes.json();
      const posMenuData = await posMenuRes.json();
      const posOrderData = await posOrderRes.json();
      const financeData = await financeRes.json();
      const employeesData = await employeesRes.json();
      const payrollData = await payrollRes.json();
      const checkoutData = await checkoutRes.json();

      if (targetPropertyId !== propertyId) return;
      if (housekeepingData?.status === 'OK') setHousekeepingTasks(housekeepingData.data || []);
      if (checkoutData?.status === 'OK') {
        setCheckoutInspections(checkoutData.data?.inspections || []);
        setPendingCheckoutInspectionsCount(checkoutData.data?.pending_count || 0);
      }
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
      if (data.data?.reservation) {
        setSelectedRes((prev: any) => {
          if (!prev || Number(prev.id) !== Number(reservationId)) return prev;
          return {
            ...prev,
            ...data.data.reservation,
            room_number: prev.room_number ?? data.data.reservation.room_number,
          };
        });
      }
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

  const handleRequestCheckoutRoomCheck = async () => {
    if (!selectedRes || !selectedRes.id || propertyId === null) return;
    try {
      const resp = await fetch('/api/housekeeping/checkout-room-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          reservation_id: Number(selectedRes.id),
          requested_by_name_snapshot: 'Front Desk'
        })
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.message || 'Gagal meminta pemeriksaan kamar');
      }
      alert('Permintaan pemeriksaan kamar telah dikirim ke Housekeeping (Priority Critical).');
      const detailRes = await fetch(`/api/reservations/${selectedRes.id}?property_id=${propertyId}`);
      if (detailRes.ok) {
        const json = await detailRes.json();
        if (json.data) setSelectedRes((prev: any) => ({ ...prev, ...json.data }));
      }
    } catch (e: any) {
      alert(e.message || 'Gagal meminta pemeriksaan kamar');
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
    if (paymentSubmitting) return;

    if (!selectedRes) {
      setPaymentFeedback({ type: 'error', message: 'Reservasi tidak ditemukan' });
      return;
    }

    const currentRemaining = Math.max(0, Math.round(Number(selectedRes.remaining_balance ?? Math.max(Number(selectedRes.total_price || 0) - Number(selectedRes.amount_paid || 0), 0))));
    const validation = validateIdrPaymentInput(paymentDraft, currentRemaining);
    if (!validation.isValid) {
      setPaymentFeedback({ type: 'error', message: validation.error || 'Nominal pembayaran tidak valid' });
      paymentInputRef.current?.focus();
      return;
    }

    const rawAmount = validation.amount;

    if (propertyId === null) {
      setPaymentFeedback({ type: 'error', message: 'Property belum dipilih' });
      return;
    }

    if (!paymentEvidenceForm.file) {
      setPaymentFeedback({ type: 'error', message: 'Bukti pembayaran wajib dilampirkan sebelum memproses pembayaran' });
      return;
    }

    setPaymentSubmitting(true);
    setPaymentFeedback(null);

    try {
      const chosenMethod = paymentEvidenceForm.evidenceType === 'BANK_TRANSFER' ? 'BANK_TRANSFER' : paymentEvidenceForm.evidenceType === 'QRIS_RECEIPT' ? 'QRIS' : paymentEvidenceForm.evidenceType === 'EDC_SLIP' ? 'CARD' : 'CASH';

      const formData = new FormData();
      formData.append('property_id', String(propertyId));
      formData.append('amount', String(rawAmount));
      formData.append('payment_method', chosenMethod);
      formData.append('reference_code', `PMT-${Date.now()}`);
      formData.append('evidence_type', paymentEvidenceForm.evidenceType);
      if (paymentEvidenceForm.note) {
        formData.append('evidence_note', paymentEvidenceForm.note);
      }
      formData.append('file', paymentEvidenceForm.file);

      const response = await fetch(`/api/reservations/${selectedRes.id}/payments`, {
        method: 'POST',
        body: formData
      });
      const data = await response.json();
      if (!response.ok || (data.status !== 'SUCCESS' && data.status !== 'OK')) {
        throw new Error(data.message || 'Gagal mencatat pembayaran');
      }

      const updatedRes = data.data?.reservation;

      // 1. Immediately synchronize open Detail Reservasi modal state
      if (updatedRes) {
        setSelectedRes((prev: any) => {
          if (!prev || Number(prev.id) !== Number(updatedRes.id)) return prev;
          return {
            ...prev,
            ...updatedRes,
            room_number: prev.room_number ?? updatedRes.room_number,
          };
        });

        // 2. Immediately synchronize Calendar / Tapechart reservations list
        setReservations((prev) =>
          prev.map((r) =>
            Number(r.id) === Number(updatedRes.id)
              ? { ...r, ...updatedRes, room_number: r.room_number ?? updatedRes.room_number }
              : r
          )
        );

        // 3. Immediately synchronize Transaksi table reservations list (preserves page & filters)
        setTransactionReservations((prev) =>
          prev.map((r) =>
            Number(r.id) === Number(updatedRes.id)
              ? {
                  ...r,
                  ...updatedRes,
                  bid: r.bid ?? updatedRes.bid,
                  room_number: r.room_number ?? updatedRes.room_number,
                  room_type: r.room_type ?? updatedRes.room_type,
                  guest_segment: r.guest_segment ?? updatedRes.guest_segment,
                  booking_source: r.booking_source ?? updatedRes.booking_source,
                  channel: r.channel ?? updatedRes.channel,
                }
              : r
          )
        );
      }

      setPaymentEvidenceForm({ file: null, evidenceType: 'BANK_TRANSFER', note: '' });

      // 4. Authoritatively refresh Folio snapshot and payment ledger
      await fetchReservationFolio(Number(selectedRes.id));

      // 5. Background revalidations
      fetchData();
      fetchOperationsData();
      if (fetchTransactionReservationsRef.current) {
        fetchTransactionReservationsRef.current(propertyId);
      }

      // 6. Clear draft input and provide concise success feedback
      setPaymentDraft('');
      setPaymentFeedback({
        type: 'success',
        message: `Pembayaran ${formatCurrency(rawAmount)} berhasil dicatat.`
      });
    } catch (error: any) {
      console.error('Payment failed', error);
      setPaymentFeedback({
        type: 'error',
        message: `Gagal menyimpan pembayaran: ${error instanceof Error ? error.message : 'Terjadi kesalahan sistem'}`
      });
    } finally {
      setPaymentSubmitting(false);
    }
  };

  const openPaymentDetailModal = (payment: PaymentTransactionItem) => {
    setActivePaymentMenuId(null);
    setPaymentDetailModal({ open: true, payment });
  };

  const openPaymentCorrectionModal = (payment: PaymentTransactionItem) => {
    setActivePaymentMenuId(null);
    const defaultEvType: PaymentEvidenceType =
      payment.payment_method === 'TRANSFER'
        ? 'BANK_TRANSFER'
        : payment.payment_method === 'QRIS'
        ? 'QRIS_RECEIPT'
        : payment.payment_method === 'DEBIT' || payment.payment_method === 'CREDIT_CARD'
        ? 'EDC_SLIP'
        : 'CASH_RECEIPT';

    setPaymentCorrectionEvidenceForm({
      file: null,
      evidenceType: defaultEvType,
      note: `Bukti koreksi transaksi #${payment.id}`,
    });

    setPaymentCorrectionModal({
      open: true,
      payment,
      newAmountDraft: formatIdrInput(String(payment.amount || 0)),
      paymentMethod: payment.payment_method || 'CASH',
      reasonCode: 'WRONG_AMOUNT',
      reasonText: '',
      submitting: false,
      error: null,
    });
  };

  const openPaymentVoidModal = (payment: PaymentTransactionItem) => {
    setActivePaymentMenuId(null);
    setPaymentVoidModal({
      open: true,
      payment,
      reasonCode: 'PAYMENT_CANCELLED',
      reasonText: '',
      submitting: false,
      error: null,
    });
  };

  const handleDeactivateEvidence = async () => {
    if (!deactivateEvidenceModal.evidence || !selectedRes || propertyId === null || deactivateEvidenceModal.submitting) return;

    if (!deactivateEvidenceModal.reason.trim()) {
      setDeactivateEvidenceModal(prev => ({ ...prev, error: 'Alasan penonaktifan bukti wajib diisi' }));
      return;
    }

    setDeactivateEvidenceModal(prev => ({ ...prev, submitting: true, error: null }));

    try {
      const evid = deactivateEvidenceModal.evidence;
      const res = await fetch(`/api/reservations/${selectedRes.id}/payments/${evid.payment_transaction_id}/evidences/${evid.id}/deactivate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          reason: deactivateEvidenceModal.reason.trim()
        })
      });
      const data = await res.json();
      if (!res.ok || data.status !== 'SUCCESS') {
        throw new Error(data.message || 'Gagal menonaktifkan bukti');
      }

      await fetchReservationFolio(Number(selectedRes.id));
      setDeactivateEvidenceModal({ open: false, evidence: null, reason: '', submitting: false, error: null });
    } catch (err: any) {
      setDeactivateEvidenceModal(prev => ({ ...prev, submitting: false, error: err.message || 'Terjadi kesalahan' }));
    }
  };

  const handleUploadExtraEvidence = async () => {
    if (!uploadExtraEvidenceModal.paymentId || !selectedRes || propertyId === null || uploadExtraEvidenceModal.submitting) return;

    if (!uploadExtraEvidenceModal.form.file) {
      setUploadExtraEvidenceModal(prev => ({ ...prev, error: 'File bukti pembayaran wajib dipilih' }));
      return;
    }

    setUploadExtraEvidenceModal(prev => ({ ...prev, submitting: true, error: null }));

    try {
      const formData = new FormData();
      formData.append('file', uploadExtraEvidenceModal.form.file);
      formData.append('property_id', String(propertyId));
      formData.append('evidence_type', uploadExtraEvidenceModal.form.evidenceType);
      if (uploadExtraEvidenceModal.form.note) {
        formData.append('note', uploadExtraEvidenceModal.form.note);
      }

      const res = await fetch(`/api/reservations/${selectedRes.id}/payments/${uploadExtraEvidenceModal.paymentId}/evidences`, {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (!res.ok || data.status !== 'SUCCESS') {
        throw new Error(data.message || 'Gagal mengunggah bukti');
      }

      await fetchReservationFolio(Number(selectedRes.id));
      setUploadExtraEvidenceModal({
        open: false,
        paymentId: null,
        form: { file: null, evidenceType: 'BANK_TRANSFER', note: '' },
        submitting: false,
        error: null
      });
    } catch (err: any) {
      setUploadExtraEvidenceModal(prev => ({ ...prev, submitting: false, error: err.message || 'Terjadi kesalahan' }));
    }
  };

  const submitPaymentCorrection = async () => {
    if (!selectedRes || !paymentCorrectionModal.payment || paymentCorrectionModal.submitting) return;

    const originalAmount = Math.round(Number(paymentCorrectionModal.payment.amount || 0));
    const newAmount = parseIdrInput(paymentCorrectionModal.newAmountDraft);
    const totalPrice = Math.round(Number(selectedRes.total_price || 0));
    const currentPaid = Math.round(Number(selectedRes.amount_paid || 0));
    const maxAllowedNewAmount = totalPrice - (currentPaid - originalAmount);

    const validation = validateCorrectionForm({
      originalAmount,
      newAmount,
      maxAllowedNewAmount,
      reasonCode: paymentCorrectionModal.reasonCode,
      reasonText: paymentCorrectionModal.reasonText,
    });

    if (!validation.valid) {
      const firstErr = validation.errors.amount || validation.errors.reasonCode || validation.errors.reasonText;
      setPaymentCorrectionModal((prev) => ({ ...prev, error: firstErr || 'Form tidak valid' }));
      return;
    }

    if (propertyId === null) {
      setPaymentCorrectionModal((prev) => ({ ...prev, error: 'Property belum dipilih' }));
      return;
    }

    if (!paymentCorrectionEvidenceForm.file) {
      setPaymentCorrectionModal((prev) => ({ ...prev, error: 'Bukti pembayaran baru wajib dilampirkan untuk koreksi pembayaran' }));
      return;
    }

    setPaymentCorrectionModal((prev) => ({ ...prev, submitting: true, error: null }));

    try {
      const formData = new FormData();
      formData.append('property_id', String(propertyId));
      formData.append('amount', String(newAmount));
      formData.append('payment_method', paymentCorrectionModal.paymentMethod);
      formData.append('reason_code', paymentCorrectionModal.reasonCode);
      if (paymentCorrectionModal.reasonText.trim()) {
        formData.append('reason_text', paymentCorrectionModal.reasonText.trim());
      }
      formData.append('evidence_type', paymentCorrectionEvidenceForm.evidenceType);
      if (paymentCorrectionEvidenceForm.note.trim()) {
        formData.append('evidence_note', paymentCorrectionEvidenceForm.note.trim());
      }
      formData.append('file', paymentCorrectionEvidenceForm.file);

      const response = await fetch(
        `/api/reservations/${selectedRes.id}/payments/${paymentCorrectionModal.payment.id}/correct`,
        {
          method: 'POST',
          body: formData,
        }
      );
      const data = await response.json();
      if (!response.ok || data.status !== 'SUCCESS') {
        throw new Error(data.message || 'Gagal mengoreksi pembayaran');
      }

      const updatedRes = data.data?.reservation;
      if (updatedRes) {
        setSelectedRes((prev: any) => {
          if (!prev || Number(prev.id) !== Number(updatedRes.id)) return prev;
          return {
            ...prev,
            ...updatedRes,
            room_number: prev.room_number ?? updatedRes.room_number,
          };
        });

        setReservations((prev) =>
          prev.map((r) =>
            Number(r.id) === Number(updatedRes.id)
              ? { ...r, ...updatedRes, room_number: r.room_number ?? updatedRes.room_number }
              : r
          )
        );

        setTransactionReservations((prev) =>
          prev.map((r) =>
            Number(r.id) === Number(updatedRes.id)
              ? {
                  ...r,
                  ...updatedRes,
                  bid: r.bid ?? updatedRes.bid,
                  room_number: r.room_number ?? updatedRes.room_number,
                  room_type: r.room_type ?? updatedRes.room_type,
                  guest_segment: r.guest_segment ?? updatedRes.guest_segment,
                  booking_source: r.booking_source ?? updatedRes.booking_source,
                  channel: r.channel ?? updatedRes.channel,
                }
              : r
          )
        );
      }

      await fetchReservationFolio(Number(selectedRes.id));
      await fetchReservationAudit(Number(selectedRes.id));
      fetchData();
      fetchOperationsData();
      if (fetchTransactionReservationsRef.current) {
        fetchTransactionReservationsRef.current(propertyId);
      }

      setPaymentCorrectionEvidenceForm({
        file: null,
        evidenceType: 'CASH_RECEIPT',
        note: ''
      });

      setPaymentCorrectionModal({
        open: false,
        payment: null,
        newAmountDraft: '',
        paymentMethod: 'CASH',
        reasonCode: 'WRONG_AMOUNT',
        reasonText: '',
        submitting: false,
        error: null,
      });
      setPaymentFeedback({
        type: 'success',
        message: `Koreksi pembayaran berhasil disimpan. Saldo dan folio telah disinkronkan.`
      });
    } catch (err: any) {
      setPaymentCorrectionModal((prev) => ({
        ...prev,
        submitting: false,
        error: err.message || 'Terjadi kesalahan sistem',
      }));
    }
  };

  const submitPaymentVoid = async () => {
    if (!selectedRes || !paymentVoidModal.payment || paymentVoidModal.submitting) return;

    const validation = validateVoidForm({
      reasonCode: paymentVoidModal.reasonCode,
      reasonText: paymentVoidModal.reasonText,
    });

    if (!validation.valid) {
      const firstErr = validation.errors.reasonCode || validation.errors.reasonText;
      setPaymentVoidModal((prev) => ({ ...prev, error: firstErr || 'Form tidak valid' }));
      return;
    }

    if (propertyId === null) {
      setPaymentVoidModal((prev) => ({ ...prev, error: 'Property belum dipilih' }));
      return;
    }

    setPaymentVoidModal((prev) => ({ ...prev, submitting: true, error: null }));

    try {
      const response = await fetch(
        `/api/reservations/${selectedRes.id}/payments/${paymentVoidModal.payment.id}/void`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            property_id: propertyId,
            reason_code: paymentVoidModal.reasonCode,
            reason_text: paymentVoidModal.reasonText.trim() || undefined,
          }),
        }
      );
      const data = await response.json();
      if (!response.ok || data.status !== 'SUCCESS') {
        throw new Error(data.message || 'Gagal membatalkan pembayaran');
      }

      const updatedRes = data.data?.reservation;
      if (updatedRes) {
        setSelectedRes((prev: any) => {
          if (!prev || Number(prev.id) !== Number(updatedRes.id)) return prev;
          return {
            ...prev,
            ...updatedRes,
            room_number: prev.room_number ?? updatedRes.room_number,
          };
        });

        setReservations((prev) =>
          prev.map((r) =>
            Number(r.id) === Number(updatedRes.id)
              ? { ...r, ...updatedRes, room_number: r.room_number ?? updatedRes.room_number }
              : r
          )
        );

        setTransactionReservations((prev) =>
          prev.map((r) =>
            Number(r.id) === Number(updatedRes.id)
              ? {
                  ...r,
                  ...updatedRes,
                  bid: r.bid ?? updatedRes.bid,
                  room_number: r.room_number ?? updatedRes.room_number,
                  room_type: r.room_type ?? updatedRes.room_type,
                  guest_segment: r.guest_segment ?? updatedRes.guest_segment,
                  booking_source: r.booking_source ?? updatedRes.booking_source,
                  channel: r.channel ?? updatedRes.channel,
                }
              : r
          )
        );
      }

      await fetchReservationFolio(Number(selectedRes.id));
      await fetchReservationAudit(Number(selectedRes.id));
      fetchData();
      fetchOperationsData();
      if (fetchTransactionReservationsRef.current) {
        fetchTransactionReservationsRef.current(propertyId);
      }

      setPaymentVoidModal({
        open: false,
        payment: null,
        reasonCode: 'PAYMENT_CANCELLED',
        reasonText: '',
        submitting: false,
        error: null,
      });
      setPaymentFeedback({
        type: 'success',
        message: `Pembayaran berhasil dibatalkan. Reversal pembalik saldo telah dibuat.`
      });
    } catch (err: any) {
      setPaymentVoidModal((prev) => ({
        ...prev,
        submitting: false,
        error: err.message || 'Terjadi kesalahan sistem',
      }));
    }
  };

  useEffect(() => {
    setSelectedRes(null);
    setSelectedFolio(null);
    setPaymentDraft('');
    setPaymentFeedback(null);
    setPaymentSubmitting(false);
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
        alert(data.message || 'Gagal memperbarui status kamar di database');
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
      if (status === 'Maintenance') {
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
        const statusSellable = operationalStatus !== 'Maintenance';
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
    const hasBlockingFinding = Boolean(room.has_blocking_finding || (room.blocking_findings && room.blocking_findings.length > 0));
    const firstFinding = room.blocking_findings?.[0];

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

    if (hasBlockingFinding && (currentStatus === 'Ready' || rawStatus === 'VACANT_CLEAN')) {
      return (
        <span
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded border text-[10px] font-bold bg-amber-100 text-amber-900 border-amber-300 shadow-2xs"
          title={`Not Ready: ${firstFinding?.finding_type_label || 'Temuan blocking aktif'} (${firstFinding?.notes || ''})`}
        >
          <span>⚠</span>
          <span>Not Ready</span>
        </span>
      );
    }

    const buttonClass = currentStatus === 'Kotor'
      ? 'bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100'
      : currentStatus === 'Cleaning'
        ? 'bg-blue-50 text-blue-800 border-blue-200 hover:bg-blue-100'
        : currentStatus === 'Occupied'
          ? 'bg-stone-100 text-stone-700 border-stone-300 hover:bg-stone-200'
          : currentStatus === 'Maintenance'
            ? 'bg-rose-50 text-rose-800 border-rose-200 hover:bg-rose-100'
            : 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100';

    return (
      <button
        type="button"
        onClick={() => toggleStatus(room.id)}
        className={`px-2.5 py-1 rounded border text-[10px] font-semibold transition shadow-2xs ${buttonClass}`}
        title={`Status Kamar: ${statusLabel[rawStatus] || rawStatus || currentStatus}`}
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
  const selectedRoomLabel = selectedRes?.room_number ? `Kamar ${selectedRes.room_number}` : 'Belum Ditentukan';
  const selectedRoomTypeLabel = selectedRes?.room_type_name || selectedRes?.room_variant || selectedBooking?.room_type || selectedBooking?.room_variant || '—';
  const selectedBookingIdentity = selectedRes?.bid || selectedBooking?.bid || selectedRes?.booking_number || `#${selectedRes?.id ?? '-'}`;
  const selectedBookingLegacy = selectedRes?.booking_number || selectedBooking?.booking_number || '';
  const selectedBookingSource = selectedBooking?.booking_source || selectedRes?.booking_source || '';
  const selectedBookingChannel = selectedBooking?.channel || selectedRes?.channel || '';
  const [stayChangeState, setStayChangeState] = useState<{
    open: boolean;
    type: 'extend' | 'shorten';
    reservationId: number | null;
    newCheckOut: string;
    additionalNightRate: number;
    submitting?: boolean;
    loading?: boolean;
    reservationDto?: any;
    currentTotalCharge: number;
    currentAmountPaid: number;
    currentOutstanding: number;
    existingNightlyRate: number;
    pricingSource: string;
  }>({
    open: false,
    type: 'extend',
    reservationId: null,
    newCheckOut: '',
    additionalNightRate: 0,
    submitting: false,
    loading: false,
    reservationDto: null,
    currentTotalCharge: 0,
    currentAmountPaid: 0,
    currentOutstanding: 0,
    existingNightlyRate: 0,
    pricingSource: ''
  });
  const stayChangeReservation = useMemo(
    () => stayChangeState.reservationDto || (selectedRes && Number(selectedRes.id) === stayChangeState.reservationId ? selectedRes : null) || reservations.find((item) => Number(item.id) === stayChangeState.reservationId) || selectedRes,
    [stayChangeState.reservationDto, stayChangeState.reservationId, reservations, selectedRes]
  );
  const selectedNights = Math.max(
    1,
    hotelNightsBetween(normalizeHotelDate(selectedRes?.check_in), normalizeHotelDate(selectedRes?.check_out)) ?? 1
  );
  const stayChangeNightsDelta = (() => {
    if (!stayChangeState.open || !stayChangeState.reservationId) return 0;
    const reservation = stayChangeReservation;
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

  const computeStayChangeFinancialContext = (dto: any) => {
    if (!dto) return null;
    const checkIn = normalizeHotelDate(dto.check_in);
    const checkOut = normalizeHotelDate(dto.check_out);
    const existingNights = (checkIn && checkOut) ? (hotelNightsBetween(checkIn, checkOut) || 1) : 1;

    const currentTotalCharge = Number(dto.total_price ?? 0);
    const currentAmountPaid = Number(dto.amount_paid ?? 0);
    const currentOutstanding = dto.remaining_balance !== undefined
      ? Number(dto.remaining_balance)
      : Math.max(0, currentTotalCharge - currentAmountPaid);

    // Determine latest/existing nightly rate
    let existingNightlyRate = 0;
    const ratesList = dto.rate_snapshot?.nightly_rates || dto.nightly_rates;
    if (Array.isArray(ratesList) && ratesList.length > 0) {
      const lastRate = ratesList[ratesList.length - 1];
      existingNightlyRate = Math.round(Number(lastRate.final_room_rate || lastRate.base_rate || 0));
    }
    if (!existingNightlyRate && currentTotalCharge > 0) {
      existingNightlyRate = Math.round(currentTotalCharge / existingNights);
    }

    // Determine pricing source label
    const bookingSource = String(dto.booking_source || dto.booking_type || dto.bookingType || '').toUpperCase();
    const otaName = dto.ota_source_name || dto.channel || dto.ota_source || dto.otaSource;
    let pricingSource = 'Standar';
    if (bookingSource === 'OTA' || otaName) {
      pricingSource = `OTA Manual — ${otaName || 'OTA'}`;
    } else if (dto.rate_plan_name) {
      pricingSource = `Rate Plan — ${dto.rate_plan_name}`;
    } else if (bookingSource === 'DIRECT') {
      pricingSource = 'Direct Manual / Standar';
    } else if (bookingSource) {
      pricingSource = bookingSource;
    }

    return {
      currentTotalCharge,
      currentAmountPaid,
      currentOutstanding,
      existingNightlyRate,
      pricingSource
    };
  };

  const openStayChangePrompt = async (
    type: 'extend' | 'shorten',
    reservationId: number,
    overrideNewCheckOut?: string,
    initialDto?: any
  ) => {
    let candidate = initialDto || (selectedRes && Number(selectedRes.id) === reservationId ? selectedRes : null);
    if (!candidate || candidate.total_price === undefined || candidate.amount_paid === undefined) {
      const found = reservations.find((item) => Number(item.id) === reservationId);
      if (found) {
        candidate = { ...found, ...(candidate || {}) };
      }
    }

    if (!candidate) {
      console.log('RESIZE_NO_ACTIVE_STATE', { reason: 'reservation missing before confirmation', reservationId, type });
      return;
    }

    const currentCheckOut = normalizeHotelDate(candidate.check_out) || hotelDateFromInstant(new Date());
    const suggestedCheckOut = type === 'extend' ? addDaysToIso(currentCheckOut, 1) : addDaysToIso(currentCheckOut, -1);
    const nextCheckOut = overrideNewCheckOut || suggestedCheckOut || currentCheckOut;

    const validation = validateStayChangeCandidate(candidate, nextCheckOut);
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

    const initialContext = computeStayChangeFinancialContext(candidate);
    const needsFetch = !initialContext || candidate.total_price === undefined || candidate.amount_paid === undefined;

    setStayChangeState({
      open: true,
      type,
      reservationId,
      newCheckOut: nextCheckOut,
      additionalNightRate: initialContext?.existingNightlyRate || 0,
      submitting: false,
      loading: needsFetch,
      reservationDto: candidate,
      currentTotalCharge: initialContext?.currentTotalCharge || 0,
      currentAmountPaid: initialContext?.currentAmountPaid || 0,
      currentOutstanding: initialContext?.currentOutstanding || 0,
      existingNightlyRate: initialContext?.existingNightlyRate || 0,
      pricingSource: initialContext?.pricingSource || (needsFetch ? 'Memuat...' : 'Standar')
    });

    try {
      const propId = propertyId || candidate?.property_id || 1;
      const res = await fetch(`/api/reservations/${reservationId}?property_id=${propId}`);
      if (res.ok) {
        const json = await res.json();
        if (json.data) {
          const fullDto = json.data;
          const fullContext = computeStayChangeFinancialContext(fullDto);
          if (fullContext) {
            setStayChangeState((prev) => {
              if (!prev.open || prev.reservationId !== reservationId) return prev;
              const rateToUse = prev.additionalNightRate > 0 ? prev.additionalNightRate : fullContext.existingNightlyRate;
              return {
                ...prev,
                loading: false,
                reservationDto: fullDto,
                currentTotalCharge: fullContext.currentTotalCharge,
                currentAmountPaid: fullContext.currentAmountPaid,
                currentOutstanding: fullContext.currentOutstanding,
                existingNightlyRate: fullContext.existingNightlyRate,
                pricingSource: fullContext.pricingSource,
                additionalNightRate: rateToUse
              };
            });
          }
        }
      }
    } catch (err) {
      console.warn('Failed to fetch full reservation detail for stay change', err);
      setStayChangeState((prev) => ({ ...prev, loading: false }));
    }
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
        openStayChangePrompt(type, reservationId, previewCheckOut, reservation);
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
    setStayChangeState({
      open: false,
      type: 'extend',
      reservationId: null,
      newCheckOut: '',
      additionalNightRate: 0,
      submitting: false,
      loading: false,
      reservationDto: null,
      currentTotalCharge: 0,
      currentAmountPaid: 0,
      currentOutstanding: 0,
      existingNightlyRate: 0,
      pricingSource: ''
    });
  };

  const confirmStayChange = async () => {
    if (!stayChangeState.open || stayChangeState.reservationId === null) return;

    const reservationId = stayChangeState.reservationId;
    const reservation = stayChangeState.reservationDto || reservations.find((item) => Number(item.id) === reservationId) || selectedRes;
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

    const payload: any = {
      property_id: propertyId,
      new_check_out: requestedCheckOut
    };
    if (stayChangeState.type === 'extend') {
      payload.additional_night_rate = Number(stayChangeState.additionalNightRate) || 0;
    }

    setStayChangeState((prev) => ({ ...prev, submitting: true }));

    try {
      const response = await fetch(`/api/reservations/${reservationId}/${stayChangeState.type}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
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
    } catch (error: any) {
      reservationResizePreviewRef.current = {
        ...reservationResizePreviewRef.current
      };
      delete reservationResizePreviewRef.current[String(reservationId)];
      setReservationResizePreview(reservationResizePreviewRef.current);
      await fetchData();
      await fetchOperationsData();
      setStayChangeState((prev) => ({ ...prev, submitting: false }));
      alert(error?.message || `Gagal melakukan ${stayChangeState.type === 'extend' ? 'perpanjangan' : 'pemendekan'} masa inap.`);
      console.error(`${stayChangeState.type} stay failed`, error);
    }
  };

  const isRoomReadyForCheckIn = selectedRes?.readiness ? Boolean(selectedRes.readiness.is_ready) : true;
  const checkInDisabledReason = selectedRes?.readiness && !selectedRes.readiness.is_ready
    ? (selectedRes.readiness.reason_message || 'Kamar belum siap untuk check-in')
    : undefined;

  const quickActionButtons = [
    {
      key: 'checkin',
      label: 'Check In',
      enabled: canCheckIn,
      disabled: !isRoomReadyForCheckIn,
      title: checkInDisabledReason,
      variant: 'success',
      onClick: () => handleReservationAction(Number(selectedRes?.id), 'checkin')
    },
    { key: 'checkout', label: 'Checkout', enabled: canCheckOut, disabled: false, title: undefined, variant: 'warn', onClick: () => openCheckoutConfirmation(Number(selectedRes?.id)) },
    { key: 'extend', label: 'Extend', enabled: canExtend, disabled: false, title: undefined, variant: 'primary', onClick: () => selectedRes && openStayChangePrompt('extend', Number(selectedRes.id), undefined, selectedRes) },
    { key: 'shorten', label: 'Shorten', enabled: canShorten, disabled: false, title: undefined, variant: 'primary', onClick: () => selectedRes && openStayChangePrompt('shorten', Number(selectedRes.id), undefined, selectedRes) },
    { key: 'cancel', label: 'Cancel', enabled: canCancel, disabled: false, title: undefined, variant: 'danger', onClick: () => handleReservationCancel(Number(selectedRes?.id)) },
    {
      key: 'payment',
      label: 'Payment',
      enabled: canPay,
      disabled: false,
      title: undefined,
      variant: 'primary',
      onClick: () => {
        const remaining = selectedRes ? Math.max(0, Math.round(Number(selectedRes.remaining_balance ?? Math.max(Number(selectedRes.total_price || 0) - Number(selectedRes.amount_paid || 0), 0)))) : 0;
        const validation = validateIdrPaymentInput(paymentDraft, remaining);
        if (validation.isValid) {
          void handlePayment();
        } else {
          paymentInputRef.current?.focus();
        }
      }
    }
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

    // Suppress unused locals for modularized sub-components
  void [
    calculateRemainingBalancePreview,
    isPaymentEligibleForCorrection,
    getPaymentEvidenceStatus,
    canonicalBookingChildRoomId,
    canonicalRoomClassification,
    reservationAudit,
    bidCopyState,
    paymentFeedback,
    activePaymentMenuId,
    childRoomAvailability,
    bookingAvailabilityState,
    bookingSubmitting,
    setBookingSubmitting,
    ktpFile,
    buktiBayarFile,
    handleRequestCheckoutRoomCheck,
    openPaymentDetailModal,
    openPaymentCorrectionModal,
    openPaymentVoidModal,
    updateBookingChild,
    addBookingChild,
    removeBookingChild,
    activeStayStatus,
    activeBookingStatus,
    activePaymentStatus,
    bookingChildren,
    selectedStayLabel,
    selectedRoomLabel,
    selectedRoomTypeLabel,
    selectedBookingIdentity,
    selectedBookingLegacy,
    selectedBookingSource,
    selectedBookingChannel,
    selectedNights,
    quickActionButtons,
    copyBookingBid,
    bookingComposerTotals,
  ];

  const isDirectMobilePath = typeof window !== 'undefined' && (
    window.location.pathname === '/employee' || window.location.pathname === '/housekeeping'
  );

  if (isDirectMobilePath) {
    const activePropId = propertyId || (properties[0]?.id || 1);
    const activePropName = properties.find((p: any) => p.id === activePropId)?.name || 'OAK Hotel Grand';
    return (
      <EmployeeMobileWorkspace
        propertyId={activePropId}
        propertyName={activePropName}
        initialTab={window.location.pathname === '/housekeeping' ? 'TASKS' : 'HOME'}
        currentUser={{
          id: 1,
          name: 'Siti Rahmawati',
          role: 'Housekeeping',
          department: 'Housekeeping'
        }}
      />
    );
  }

  return (
    <div className="hotel-app">
      <GlobalOperationsBar
        activeProperty={properties.find((p: any) => p.id === propertyId) || null}
        properties={properties}
        onSelectProperty={handleSelectProperty}
        onToggleSidebar={() => {
          if (typeof window !== 'undefined' && window.innerWidth < 1024) {
            setIsMobileSidebarOpen(!isMobileSidebarOpen);
          } else {
            handleToggleSidebarCollapse();
          }
        }}
        isSidebarCollapsed={isSidebarCollapsed}
        currentUser={{
          name: user?.full_name || user?.username || 'Pengguna OAK',
          email: user?.email || '—',
          role: user?.role || 'Staff',
          avatarInitials: (user?.full_name || user?.username || 'OP')
            .split(' ')
            .filter(Boolean)
            .map((w: string) => w[0])
            .join('')
            .toUpperCase()
            .slice(0, 2) || 'OP',
        }}
        onLogout={logout}
        onOpenPos={() => handleSelectMenu('POS')}
        propertyBranding={activeBranding}
      />

      <div className="hotel-layout">
        <AppSidebar
          selectedMenu={selectedMenu}
          onSelectMenu={handleSelectMenu}
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={handleToggleSidebarCollapse}
          isMobileOpen={isMobileSidebarOpen}
          onCloseMobile={() => setIsMobileSidebarOpen(false)}
          activeProperty={properties.find((p: any) => p.id === propertyId) || null}
          propertyBranding={activeBranding}
          featureFlags={propertyFeatures}
        />

        <main className="hotel-main">

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

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-white border border-slate-200/90 rounded-xl shadow-xs p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold text-sm text-slate-900">PEMERIKSAAN CHECKOUT</h3>
                    <span className="text-[10px] text-slate-400 font-mono">FO Room Check</span>
                  </div>
                  <span className={`text-xs px-2.5 py-0.5 rounded-full font-bold border ${
                    pendingCheckoutInspectionsCount > 0
                      ? 'bg-amber-50 text-amber-800 border-amber-300'
                      : 'bg-emerald-50 text-emerald-800 border-emerald-200/80'
                  }`}>
                    {pendingCheckoutInspectionsCount} Menunggu
                  </span>
                </div>

                {checkoutInspections.length === 0 ? (
                  <div className="py-6 text-center text-xs text-slate-400">
                    Tidak ada permintaan pemeriksaan checkout saat ini.
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <div className="grid grid-cols-12 text-[10px] font-bold text-slate-400 uppercase tracking-wider pb-1 border-b border-slate-100">
                      <div className="col-span-4">Kamar</div>
                      <div className="col-span-4 text-center">Status</div>
                      <div className="col-span-4 text-right">Waktu</div>
                    </div>
                    {checkoutInspections.slice(0, 5).map((chk: any) => {
                      const isPending = ['REQUESTED', 'ASSIGNED'].includes(chk.status);
                      const isInProgress = ['ACKNOWLEDGED', 'IN_PROGRESS'].includes(chk.status);
                      const isClear = chk.status === 'DONE' && chk.inspection_result === 'CLEAR';
                      const isIssue = chk.status === 'DONE' && chk.inspection_result === 'ISSUE_FOUND';

                      const statusLabel = isPending
                        ? 'MENUNGGU'
                        : isInProgress
                        ? 'SEDANG DICEK'
                        : isClear
                        ? '✓ AMAN'
                        : isIssue
                        ? '⚠ ADA TEMUAN'
                        : chk.status;

                      const statusBadge = isPending
                        ? 'bg-amber-100 text-amber-900 border-amber-300'
                        : isInProgress
                        ? 'bg-blue-100 text-blue-900 border-blue-300'
                        : isClear
                        ? 'bg-emerald-100 text-emerald-900 border-emerald-300 font-extrabold'
                        : isIssue
                        ? 'bg-rose-100 text-rose-900 border-rose-300 font-extrabold'
                        : 'bg-slate-100 text-slate-700 border-slate-200';

                      const timeStr = chk.completed_at
                        ? new Date(chk.completed_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
                        : chk.created_at
                        ? new Date(chk.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
                        : '-';

                      return (
                        <div
                          key={chk.id}
                          onClick={() => setSelectedCheckoutInspection(chk)}
                          className="grid grid-cols-12 items-center p-2 rounded-lg bg-slate-50/70 hover:bg-slate-100/90 border border-slate-200/60 text-xs transition cursor-pointer"
                        >
                          <div className="col-span-4 font-bold text-slate-900 flex items-center gap-1.5">
                            <span className={`w-2 h-2 rounded-full ${isClear ? 'bg-emerald-500' : isIssue ? 'bg-rose-500' : 'bg-amber-500'}`} />
                            <span>Kamar {chk.room_number || '-'}</span>
                          </div>
                          <div className="col-span-4 text-center">
                            <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold border ${statusBadge}`}>
                              {statusLabel}
                            </span>
                          </div>
                          <div className="col-span-4 text-right font-mono text-[11px] text-slate-500">
                            {timeStr}
                          </div>
                        </div>
                      );
                    })}

                    {checkoutInspections.length > 5 && (
                      <div className="pt-1 text-center">
                        <button
                          type="button"
                          onClick={() => handleSelectMenu('Housekeeping')}
                          className="text-xs font-semibold text-[#1b4332] hover:underline cursor-pointer"
                        >
                          Lihat Semua ({checkoutInspections.length} pemeriksaan) &rarr;
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="bg-white border border-slate-200/90 rounded-xl shadow-xs p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-bold text-sm text-slate-900">Maintenance</h3>
                  <span className="text-xs bg-amber-50 text-amber-800 border border-amber-200/80 px-2.5 py-0.5 rounded-full font-semibold">{maintenanceTasks.length} task</span>
                </div>
                <div className="space-y-2">
                  {maintenanceTasks.slice(0, 4).map((task: any) => (
                    <div key={task.id} className="flex justify-between items-center border border-slate-100 bg-slate-50/60 hover:bg-slate-50/90 rounded-lg p-2.5 text-xs transition-colors">
                      <div>
                        <div className="font-semibold text-slate-800">Kamar {task.room_number || '-'}</div>
                        <div className="text-slate-500 text-[11px] mt-0.5">{task.issue_type}</div>
                      </div>
                      <span className={`px-2 py-0.5 rounded-md font-semibold text-[11px] ${task.status === 'DONE' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : task.status === 'IN_PROGRESS' ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-rose-50 text-rose-700 border border-rose-200'}`}>
                        {task.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="bg-white p-4 rounded-xl shadow-xs border border-slate-200/90">
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
                        const todayIso = getOperationalDateKey();
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
                                const blockSpans = operationalBlockSpans[String(room.id)] || [];
                                const cells = [];
                                let i = 0;
                                while (i < days.length) {
                                  const spanAt = spans.find(s => s.startIndex === i);
                                  const blockSpanAt = blockSpans.find(b => b.startIndex === i);

                                  if (spanAt) {
                                    const r = spanAt.res;
                                    const reservationStyle = getReservationCardStyle(r);
                                    const lifecycle = normalizeReservationLifecycle(r.status);
                                    const density = getCalendarReservationDensity(spanAt.span);
                                    const identity = getCalendarReservationIdentity(r);
                                    const searchMatch = isCalendarReservationMatch(r);
                                    const previewCheckOut = reservationResizePreview[String(r.id)] || r.check_out;
                                    const nights = Math.max(1, hotelNightsBetween(normalizeHotelDate(r.check_in), normalizeHotelDate(previewCheckOut)) ?? 1);
                                    const arrivalDateKey = normalizeHotelDate(r.check_in);
                                    const departureDateKey = normalizeHotelDate(previewCheckOut);
                                    const cellAtArrival = room.cells?.find(c => c.date === arrivalDateKey);
                                    const cellAtDeparture = room.cells?.find(c => c.date === departureDateKey);
                                    const outgoingInspection = (cellAtDeparture?.turnover?.outgoing?.reservation_id === r.id)
                                      ? cellAtDeparture?.turnover?.outgoing?.checkout_inspection
                                      : (cellAtArrival?.turnover?.outgoing?.reservation_id === r.id)
                                      ? cellAtArrival?.turnover?.outgoing?.checkout_inspection
                                      : null;

                                    const turnoverInfo = (cellAtArrival?.turnover || outgoingInspection) ? {
                                      has_turnover: Boolean(cellAtArrival?.turnover?.has_turnover),
                                      is_ready: cellAtArrival?.turnover?.incoming?.is_ready,
                                      reason_message: cellAtArrival?.turnover?.incoming?.reason_message,
                                      outgoing_clearance: outgoingInspection ? {
                                        clearance_state: outgoingInspection.clearance_state,
                                        inspection_result: outgoingInspection.inspection_result,
                                        issue_type: outgoingInspection.issue_type,
                                        issue_note: outgoingInspection.issue_note,
                                        estimated_charge: outgoingInspection.estimated_charge
                                      } : null
                                    } : null;

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
                                        turnoverInfo={turnoverInfo}
                                        onDragStart={(event) => handleDragStart(event, r, room.id)}
                                        onDragEnd={handleDragEnd}
                                        onOpen={(event) => {
                                          if (isDraggingRef.current) return;
                                          const rect = (event?.currentTarget as HTMLElement)?.getBoundingClientRect?.() || null;
                                          setQuickReservation({
                                            reservation: r,
                                            anchorRect: rect,
                                            anchorPoint: event ? { x: event.clientX, y: event.clientY } : null
                                          });
                                        }}
                                        onResize={(event) => handleReservationResizeMouseDown(event, r)}
                                      />
                                    );
                                    i += spanAt.span;
                                  } else if (blockSpanAt) {
                                    cells.push(
                                      <OperationalBlockBar
                                        key={`${room.id}-block-${blockSpanAt.block.id}-${i}`}
                                        block={blockSpanAt.block}
                                        span={blockSpanAt.span}
                                        roomNumber={room.room_number}
                                        onOpen={(b) => setSelectedOperationalBlock({
                                          block: b,
                                          roomNumber: room.room_number,
                                          roomTypeName: room.room_type_name || room.name
                                        })}
                                      />
                                    );
                                    i += blockSpanAt.span;
                                  } else {
                                    const day = days[i];
                                    const cellData = room.cells?.find(c => c.date === day.date);
                                    const departures = cellData?.departures || [];
                                    const arrivals = cellData?.arrivals || [];
                                    const hasDepartures = departures.length > 0;
                                    const hasArrivals = arrivals.length > 0;

                                    const cellState = !masterActive ? 'Inactive' : 'Available';
                                    const canQuickBook = cellState === 'Available';

                                    cells.push(
                                      <td key={`${room.id}-${day.date}`} className="p-1 border text-center h-14 align-middle">
                                        <div
                                          className={`status-cell-wrap ${canQuickBook ? 'status-cell-wrap--clickable' : ''}`}
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
                                          }}
                                        >
                                          {/* Subtle, compact ARR / DEP edge chips on turnover boundary */}
                                          {hasDepartures && (
                                            <span
                                              className="absolute top-1 left-1 inline-flex items-center gap-0.5 text-[9px] font-extrabold text-amber-900 bg-amber-100/95 px-1 py-0.2 rounded border border-amber-300/90 shadow-2xs select-none pointer-events-auto"
                                              title={`Check-out: ${departures.map((d: any) => d.guest_name).join(', ')}`}
                                            >
                                              DEP ↗
                                            </span>
                                          )}
                                          {hasArrivals && (
                                            <span
                                              className="absolute top-1 right-1 inline-flex items-center gap-0.5 text-[9px] font-extrabold text-sky-900 bg-sky-100/95 px-1 py-0.2 rounded border border-sky-300/90 shadow-2xs select-none pointer-events-auto"
                                              title={`Check-in: ${arrivals.map((a: any) => a.guest_name).join(', ')}`}
                                            >
                                              ARR ↘
                                            </span>
                                          )}

                                          {/* Clean, neutral empty available cell with lightweight hover feedback */}
                                          {cellState === 'Available' && (
                                            <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-150 inline-flex items-center gap-1 text-[10px] font-bold text-emerald-800 bg-emerald-100/90 px-2 py-0.5 rounded border border-emerald-300/80 shadow-2xs select-none">
                                              <span>+ Booking</span>
                                            </div>
                                          )}
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
            </>
        )}

            {/* Quick Booking Modal (Shared across Calendar and Transactions) */}
            <QuickBookingModal
              isOpen={createResOpen}
              onClose={() => {
                setCreateResOpen(false);
                setKtpFile(null);
                setBuktiBayarFile(null);
                resetQuickBookingForm();
              }}
              propertyId={propertyId || 1}
              rooms={rooms}
              roomTypes={calendarTypeOptions.map((t) => ({ id: t.id, name: t.label }))}
              initialRoomId={quickBooking.roomId}
              initialDate={quickBooking.checkIn}
              onBookingSuccess={() => {
                fetchData();
                fetchOperationsData();
                if (propertyId) {
                  const todayStr = hotelDateFromInstant(new Date());
                  fetchTransactionReservations(propertyId, todayStr, todayStr);
                }
                setCreateResOpen(false);
                setSelectedRange({});
                setKtpFile(null);
                setBuktiBayarFile(null);
                resetQuickBookingForm();
              }}
            />

        {selectedMenu === 'Transaksi' && propertyId && (
          <TransactionWorkspace
            propertyId={propertyId}
            currentStaffName="Front Desk Staff"
            onOpenQuickBooking={() => setCreateResOpen(true)}
            reservations={transactionReservations}
            reservationLoading={transactionLoading}
            reservationError={transactionError}
            onRefreshReservations={(start, end) => fetchTransactionReservations(propertyId, start, end)}
            onCheckIn={(res) => handleReservationAction(Number(res.id), 'checkin')}
            onCheckout={(res) => openCheckoutConfirmation(Number(res.id))}
            onOpenReservationDetail={(res) => {
              setSelectedRes(res);
              fetchReservationFolio(Number(res.id));
            }}
            onEditReservation={(res) => openReservationEditor(res)}
            onMoveReservation={(res) => openReservationEditor(res)}
            onExtendReservation={(res) => {
              setSelectedRes(res);
              openStayChangePrompt('extend', Number(res.id), undefined, res);
            }}
            onCancelReservation={(res) => handleReservationCancel(Number(res.id))}
            onViewReservationFolio={(res) => {
              setSelectedRes(res);
              fetchReservationFolio(Number(res.id));
            }}
            onViewReservationAudit={(res) => {
              setSelectedRes(res);
              fetchReservationAudit(Number(res.id));
            }}
            formatCurrency={formatCurrency}
            getPaymentStatusLabel={getPaymentStatusLabel}
            getPaymentBadgeClass={getPaymentBadgeClass}
            onNavigateToReservation={(resId) => {
              const target = reservations.find((r) => Number(r.id) === Number(resId));
              if (target) {
                setSelectedRes(target);
                fetchReservationFolio(Number(resId));
              }
            }}
          />
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
              <div className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2.5">Ringkasan Buku Besar Akuntansi</div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-white border border-slate-200/90 rounded-xl shadow-xs p-4">
                  <div className="text-[11px] uppercase text-slate-500 font-bold tracking-wider">Hutang Vendor</div>
                  <div className="text-2xl font-extrabold mt-1.5 text-slate-900">Rp {Number(financeSummary?.total_payable || 0).toLocaleString('id-ID')}</div>
                </div>
                <div className="bg-white border border-slate-200/90 rounded-xl shadow-xs p-4">
                  <div className="text-[11px] uppercase text-slate-500 font-bold tracking-wider">Piutang Tamu (Buku Besar)</div>
                  <div className="text-2xl font-extrabold mt-1.5 text-slate-900">Rp {Number(financeSummary?.total_receivable || 0).toLocaleString('id-ID')}</div>
                </div>
                <div className="bg-white border border-slate-200/90 rounded-xl shadow-xs p-4">
                  <div className="text-[11px] uppercase text-slate-500 font-bold tracking-wider">Jumlah Jurnal</div>
                  <div className="text-2xl font-extrabold mt-1.5 text-slate-900">{financeSummary?.entries?.length || 0}</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {selectedMenu === 'Housekeeping' && propertyId !== null && (
          <HousekeepingWorkspace
            propertyId={propertyId}
            onNavigateToSettings={(section) => {
              if (section) setInitialSettingsCategory(section as SettingsCategoryKey);
              handleSelectMenu('Pengaturan');
            }}
            featureFlags={propertyFeatures}
          />
        )}

        {selectedMenu === 'Mobile Portal' && propertyId !== null && (
          <div className="flex justify-center p-2 sm:p-6 bg-neutral-900/10 min-h-screen">
            <div className="w-full max-w-md bg-[#fdfbf7] shadow-2xl rounded-3xl overflow-hidden border border-neutral-300">
              <EmployeeMobileWorkspace
                propertyId={propertyId}
                propertyName={properties.find((p: any) => p.id === propertyId)?.name}
                isPreview={true}
                currentUser={{
                  id: 1,
                  name: 'Siti Rahmawati (Crew HK)',
                  role: 'Housekeeping',
                  department: 'Housekeeping'
                }}
                onBackToDesktop={() => setSelectedMenu('Employee Mobile')}
              />
            </div>
          </div>
        )}

        {selectedMenu === 'HRD' && propertyId !== null && (
          <HrdWorkspace
            propertyId={propertyId}
            propertyName={properties.find((p: any) => p.id === propertyId)?.name}
          />
        )}

        {selectedMenu === 'Employee Mobile' && propertyId !== null && (
          <EmployeeMobileManagementWorkspace
            propertyId={propertyId}
            propertyName={properties.find((p: any) => p.id === propertyId)?.name}
            onOpenMobilePortal={() => setSelectedMenu('Mobile Portal')}
          />
        )}

        {selectedMenu === 'Master Kamar' && (
          <RoomMasterPage
            propertyId={propertyId}
            onViewReservation={viewRoomMasterReservation}
          />
        )}

        {selectedMenu === 'Master Produk' && (
          <ProductMasterPage
            propertyId={propertyId}
            items={posMenu}
            onRefresh={() => void fetchOperationsData()}
          />
        )}

        {selectedMenu === 'POS' && (
          <PosWorkspace
            propertyId={propertyId}
            posMenu={posMenu}
            posOrders={posOrders}
            onCreateDemoOrder={createPosOrder}
            onRefresh={() => void fetchOperationsData()}
          />
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

        {selectedMenu === 'Pengaturan' && propertyId !== null && (
          <ManagementSettingsWorkspace
            propertyId={propertyId}
            activeProperty={properties.find((p: any) => p.id === propertyId)}
            activeBranding={activeBranding || getFallbackPropertyBranding(propertyId, properties.find((p: any) => p.id === propertyId)?.name, properties.find((p: any) => p.id === propertyId)?.property_code)}
            onSaveBranding={handleSaveBranding}
            employees={employees}
            payroll={payroll}
            initialCategory={initialSettingsCategory}
            onSelectProperty={(id) => setPropertyId(id)}
            onRefreshProperties={fetchProperties}
          />
        )}
        </main>
      </div>

      {/* Checkout Room Inspection Modal */}
      {selectedCheckoutInspection && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden border border-slate-200 space-y-4 p-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <div>
                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-300">
                  PEMERIKSAAN CHECKOUT
                </span>
                <h3 className="font-serif font-bold text-base text-slate-900 mt-1">
                  Kamar {selectedCheckoutInspection.room_number || '-'} — {selectedCheckoutInspection.room_type_name || 'Standar'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedCheckoutInspection(null)}
                className="text-slate-400 hover:text-slate-700 font-bold text-sm cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200">
                <span className="text-[10px] text-slate-500 block">Status Pemeriksaan</span>
                <span className={`inline-block px-2 py-0.5 mt-1 rounded text-[11px] font-extrabold border ${
                  selectedCheckoutInspection.status === 'DONE' && selectedCheckoutInspection.inspection_result === 'CLEAR'
                    ? 'bg-emerald-100 text-emerald-900 border-emerald-300'
                    : selectedCheckoutInspection.status === 'DONE' && selectedCheckoutInspection.inspection_result === 'ISSUE_FOUND'
                    ? 'bg-rose-100 text-rose-900 border-rose-300'
                    : ['ACKNOWLEDGED', 'IN_PROGRESS'].includes(selectedCheckoutInspection.status)
                    ? 'bg-blue-100 text-blue-900 border-blue-300'
                    : 'bg-amber-100 text-amber-900 border-amber-300'
                }`}>
                  {selectedCheckoutInspection.status === 'DONE' && selectedCheckoutInspection.inspection_result === 'CLEAR'
                    ? '✓ HK AMAN'
                    : selectedCheckoutInspection.status === 'DONE' && selectedCheckoutInspection.inspection_result === 'ISSUE_FOUND'
                    ? '⚠ ADA TEMUAN'
                    : ['ACKNOWLEDGED', 'IN_PROGRESS'].includes(selectedCheckoutInspection.status)
                    ? 'SEDANG DICEK'
                    : 'MENUNGGU'}
                </span>
              </div>

              <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200">
                <span className="text-[10px] text-slate-500 block">Petugas Pemeriksa (PIC)</span>
                <div className="font-bold text-slate-900 mt-1">
                  {selectedCheckoutInspection.assigned_to_name || selectedCheckoutInspection.crew_name || 'Kru Housekeeping'}
                </div>
              </div>
            </div>

            {/* Timestamps */}
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-slate-500">Waktu Permintaan:</span>
                <span className="font-mono text-slate-800">
                  {selectedCheckoutInspection.created_at ? new Date(selectedCheckoutInspection.created_at).toLocaleString('id-ID') : '-'}
                </span>
              </div>
              {selectedCheckoutInspection.started_at && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Mulai Diperiksa:</span>
                  <span className="font-mono text-slate-800">
                    {new Date(selectedCheckoutInspection.started_at).toLocaleString('id-ID')}
                  </span>
                </div>
              )}
              {selectedCheckoutInspection.completed_at && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Selesai:</span>
                  <span className="font-mono text-slate-800 font-bold">
                    {new Date(selectedCheckoutInspection.completed_at).toLocaleString('id-ID')}
                  </span>
                </div>
              )}
            </div>

            {/* Findings if any */}
            {selectedCheckoutInspection.findings && selectedCheckoutInspection.findings.length > 0 ? (
              <div className="space-y-2">
                <div className="text-xs font-bold text-rose-800 flex items-center gap-1.5">
                  <span>⚠ Daftar Temuan Pemeriksaan ({selectedCheckoutInspection.findings.length})</span>
                </div>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {selectedCheckoutInspection.findings.map((f: any, idx: number) => (
                    <div key={idx} className="p-3 rounded-xl bg-rose-50/70 border border-rose-200 text-xs space-y-1">
                      <div className="flex justify-between font-bold text-rose-900">
                        <span>{f.finding_type || f.category || 'Temuan Operasional'}</span>
                        {f.estimated_charge && Number(f.estimated_charge) > 0 && (
                          <span className="font-mono text-rose-800">
                            Rp {Number(f.estimated_charge).toLocaleString('id-ID')}
                          </span>
                        )}
                      </div>
                      {f.notes && <div className="text-rose-800">{f.notes}</div>}
                    </div>
                  ))}
                </div>
              </div>
            ) : selectedCheckoutInspection.status === 'DONE' ? (
              <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center gap-2">
                <span className="text-base font-bold text-emerald-700">✓</span>
                <div>
                  <strong>Hasil Pemeriksaan: AMAN</strong>
                  <p className="text-emerald-800 mt-0.5">
                    Tidak ditemukan kerusakan atau konsumsi minibar yang belum tercatat.
                  </p>
                </div>
              </div>
            ) : null}

            {/* Front Office Guidance banner */}
            <div className="p-3 rounded-xl bg-blue-50/70 border border-blue-200 text-xs text-blue-900 space-y-1">
              <strong className="font-bold">Panduan Front Office:</strong>
              <p className="text-blue-800 text-[11px]">
                {selectedCheckoutInspection.status === 'DONE' && selectedCheckoutInspection.inspection_result === 'CLEAR'
                  ? 'Kamar terverifikasi AMAN. Tamu dipersilakan melanjutkan penyelesaian checkout. Pembersihan kamar untuk tamu berikutnya akan berjalan terpisah dalam workstream Cleaning setelah kamar berstatus VACANT_DIRTY.'
                  : selectedCheckoutInspection.status === 'DONE' && selectedCheckoutInspection.inspection_result === 'ISSUE_FOUND'
                  ? 'Terdapat temuan barang/kerusakan. Konfirmasikan rincian biaya taksiran kepada tamu sebelum memfinalisasi checkout.'
                  : 'Pemeriksaan kamar sedang berlangsung oleh kru Housekeeping.'}
              </p>
            </div>

            <div className="pt-2 flex justify-end">
              <button
                type="button"
                onClick={() => setSelectedCheckoutInspection(null)}
                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs cursor-pointer"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}

      {quickReservation && (
        <QuickReservationDetail
          reservation={quickReservation.reservation}
          anchorRect={quickReservation.anchorRect}
          anchorPoint={quickReservation.anchorPoint}
          propertyId={propertyId ?? quickReservation.reservation?.property_id ?? null}
          onClose={() => setQuickReservation(null)}
          onOpenFullDetail={(res) => {
            const target = res || quickReservation.reservation;
            setQuickReservation(null);
            setSelectedRes(target);
            fetchReservationFolio(Number(target.id));
          }}
          onCheckin={(resId) => handleReservationAction(resId, 'checkin')}
          onCheckout={(resId) => handleReservationAction(resId, 'checkout')}
          onCancel={(resId) => handleReservationCancel(resId)}
          onOpenStayChange={(res, mode) => openStayChangePrompt(mode || 'extend', Number(res.id), undefined, res)}
          onRefresh={() => {
            fetchData();
            fetchOperationsData();
          }}
        />
      )}

      {selectedRes && (
        <ReservationDetailDrawer
          reservation={selectedRes}
          propertyId={propertyId ?? selectedRes?.property_id ?? null}
          onClose={() => {
            setSelectedRes(null);
            setSelectedFolio(null);
            setPaymentDraft('');
            setPaymentFeedback(null);
            setPaymentSubmitting(false);
          }}
          onRefresh={() => {
            fetchData();
            fetchOperationsData();
          }}
          onCheckin={(resId) => handleReservationAction(resId, 'checkin')}
          onCheckout={(resId) => handleReservationAction(resId, 'checkout')}
          onCancel={(resId) => handleReservationCancel(resId)}
          onOpenStayChange={(res, mode) => openStayChangePrompt(mode || 'extend', Number(res.id), undefined, res)}
        />
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
          <div className="checkout-confirm-modal max-w-lg w-full">
            <div className="checkout-confirm-icon">{stayChangeState.type === 'extend' ? '↗' : '↘'}</div>
            <h3 className="checkout-confirm-title">
              {stayChangeState.type === 'extend' ? 'Perpanjang Masa Menginap' : 'Ubah Tanggal Check-out'}
            </h3>
            <p className="checkout-confirm-text">
              {stayChangeState.type === 'extend'
                ? 'Konfirmasi perpanjangan malam menginap dan tentukan tarif per malam tambahan.'
                : 'Konfirmasi perubahan tanggal check-out ke tanggal lebih awal.'}
            </p>

            <div className="reservation-payment-panel space-y-2.5 mt-3 p-3.5 bg-stone-50 rounded-xl border border-stone-200 text-xs text-stone-700">
              <div className="flex justify-between py-1 border-b border-stone-200">
                <span className="text-stone-500">Nomor Reservasi / BID:</span>
                <strong className="font-mono">{String(stayChangeReservation?.bid || selectedBooking?.bid || stayChangeReservation?.id || '—')}</strong>
              </div>
              <div className="flex justify-between py-1 border-b border-stone-200">
                <span className="text-stone-500">Kamar:</span>
                <strong className="text-stone-900">
                  {stayChangeReservation?.room_number ? `Kamar ${stayChangeReservation.room_number}` : 'Belum Ditentukan'}
                </strong>
              </div>
              <div className="flex justify-between py-1 border-b border-stone-200">
                <span className="text-stone-500">Tipe Kamar:</span>
                <strong className="text-stone-900">
                  {stayChangeReservation?.room_type_name || stayChangeReservation?.room_type || stayChangeReservation?.room_variant || 'Standard Room'}
                </strong>
              </div>
              <div className="flex justify-between py-1 border-b border-stone-200">
                <span className="text-stone-500">Nama Tamu:</span>
                <strong>{stayChangeReservation?.guest_name || '—'}</strong>
              </div>
              <div className="grid grid-cols-2 gap-2 pt-1">
                <div>
                  <span className="text-stone-500 block text-[11px]">Check-out Saat Ini:</span>
                  <strong className="font-mono text-sm">{normalizeHotelDate(stayChangeReservation?.check_out) || '—'}</strong>
                </div>
                <div>
                  <span className="text-stone-500 block text-[11px]">Check-out Baru:</span>
                  <input
                    type="date"
                    value={stayChangeState.newCheckOut}
                    onChange={(event) => setStayChangeState((prev) => ({ ...prev, newCheckOut: event.target.value }))}
                    className="w-full border border-stone-300 rounded px-2 py-1 text-xs font-mono font-bold bg-white"
                  />
                </div>
              </div>

              <div className="flex justify-between py-1 border-t border-stone-200">
                <span className="text-stone-500">Perubahan Malam:</span>
                <strong className={stayChangeNightsDelta > 0 ? 'text-emerald-700 font-bold' : 'text-amber-700 font-bold'}>
                  {stayChangeNightsDelta > 0 ? `+${stayChangeNightsDelta} malam` : `${stayChangeNightsDelta} malam`}
                </strong>
              </div>

              {/* Status Finansial Saat Ini */}
              <div className="p-2.5 bg-stone-100 rounded-lg border border-stone-200 text-xs space-y-1">
                <div className="font-semibold text-stone-700 pb-1 border-b border-stone-200 flex justify-between items-center">
                  <span>Status Finansial Saat Ini</span>
                  {stayChangeState.loading && (
                    <span className="text-[10px] text-amber-700 font-normal italic">Memuat data...</span>
                  )}
                </div>
                <div className="flex justify-between text-stone-600">
                  <span>Tagihan Saat Ini:</span>
                  <strong className="font-mono text-stone-900">
                    {stayChangeState.loading ? '...' : `Rp ${stayChangeState.currentTotalCharge.toLocaleString('id-ID')}`}
                  </strong>
                </div>
                <div className="flex justify-between text-stone-600">
                  <span>Sudah Dibayar:</span>
                  <strong className="font-mono text-emerald-700">
                    {stayChangeState.loading ? '...' : `Rp ${stayChangeState.currentAmountPaid.toLocaleString('id-ID')}`}
                  </strong>
                </div>
                <div className="flex justify-between text-stone-600">
                  <span>Sisa Saat Ini:</span>
                  <strong className="font-mono text-amber-700">
                    {stayChangeState.loading ? '...' : `Rp ${stayChangeState.currentOutstanding.toLocaleString('id-ID')}`}
                  </strong>
                </div>
              </div>

              {stayChangeState.type === 'extend' && stayChangeNightsDelta > 0 && (
                <div className="pt-2 border-t border-stone-200 space-y-2">
                  <div>
                    <div className="flex justify-between items-center mb-1">
                      <label className="block text-[11px] font-semibold text-stone-800">
                        Tarif per Malam Tambahan (Rp) <span className="text-rose-600">*</span>
                      </label>
                      {stayChangeState.pricingSource && (
                        <span className="text-[10px] bg-emerald-50 text-emerald-800 px-1.5 py-0.5 rounded border border-emerald-200 font-medium">
                          {stayChangeState.pricingSource}
                        </span>
                      )}
                    </div>
                    <input
                      type="number"
                      step="1000"
                      min="0"
                      value={stayChangeState.additionalNightRate}
                      onChange={(e) => setStayChangeState((prev) => ({ ...prev, additionalNightRate: Math.max(0, Number(e.target.value) || 0) }))}
                      className="w-full border border-emerald-300 focus:border-emerald-600 rounded px-3 py-1.5 text-xs font-mono font-bold bg-white"
                    />
                    <span className="text-[10px] text-stone-500 block mt-0.5">
                      * Tarif sebelumnya: Rp {stayChangeState.existingNightlyRate.toLocaleString('id-ID')} / malam
                    </span>
                  </div>

                  {/* Financial calculation preview */}
                  {(() => {
                    const currentTotal = stayChangeState.currentTotalCharge;
                    const currentPaid = stayChangeState.currentAmountPaid;
                    const deltaCharge = stayChangeNightsDelta * (stayChangeState.additionalNightRate || 0);
                    const newTotal = currentTotal + deltaCharge;
                    const newOutstanding = Math.max(0, newTotal - currentPaid);

                    return (
                      <div className="p-2.5 bg-white rounded-lg border border-emerald-200 text-xs space-y-1">
                        <div className="flex justify-between text-stone-600">
                          <span>Tambahan Tagihan ({stayChangeNightsDelta} malam):</span>
                          <span className="font-mono font-semibold text-emerald-800">+Rp {deltaCharge.toLocaleString('id-ID')}</span>
                        </div>
                        <div className="flex justify-between text-stone-700 font-semibold border-t border-stone-100 pt-1">
                          <span>Total Tagihan Baru:</span>
                          <span className="font-mono font-bold text-stone-900">Rp {newTotal.toLocaleString('id-ID')}</span>
                        </div>
                        <div className="flex justify-between text-stone-600">
                          <span>Sudah Dibayar:</span>
                          <span className="font-mono text-emerald-700">Rp {currentPaid.toLocaleString('id-ID')}</span>
                        </div>
                        <div className="flex justify-between text-stone-800 pt-1 border-t border-stone-100 font-bold">
                          <span>Sisa Tagihan Baru:</span>
                          <span className="font-mono text-amber-700">Rp {newOutstanding.toLocaleString('id-ID')}</span>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}

              {stayChangeState.type === 'shorten' && stayChangeNightsDelta < 0 && (
                <div className="pt-2 border-t border-stone-200 space-y-2">
                  {(() => {
                    const currentTotal = stayChangeState.currentTotalCharge;
                    const currentPaid = stayChangeState.currentAmountPaid;
                    const shortenNights = Math.abs(stayChangeNightsDelta);
                    const shortenAdjustment = shortenNights * stayChangeState.existingNightlyRate;
                    const newTotal = Math.max(0, currentTotal - shortenAdjustment);
                    const newOutstanding = Math.max(0, newTotal - currentPaid);
                    const overpaidCredit = Math.max(0, currentPaid - newTotal);

                    return (
                      <div className="p-2.5 bg-white rounded-lg border border-amber-200 text-xs space-y-1">
                        <div className="flex justify-between text-stone-600">
                          <span>Penyesuaian Tagihan ({shortenNights} malam):</span>
                          <span className="font-mono font-semibold text-amber-800">-Rp {shortenAdjustment.toLocaleString('id-ID')}</span>
                        </div>
                        <div className="flex justify-between text-stone-700 font-semibold border-t border-stone-100 pt-1">
                          <span>Total Tagihan Baru:</span>
                          <span className="font-mono font-bold text-stone-900">Rp {newTotal.toLocaleString('id-ID')}</span>
                        </div>
                        <div className="flex justify-between text-stone-600">
                          <span>Sudah Dibayar:</span>
                          <span className="font-mono text-emerald-700">Rp {currentPaid.toLocaleString('id-ID')}</span>
                        </div>
                        {overpaidCredit > 0 ? (
                          <div className="flex justify-between text-emerald-900 pt-1 border-t border-stone-100 font-bold">
                            <span>Potensi Lebih Bayar (Kredit Tamu):</span>
                            <span className="font-mono text-emerald-700">Rp {overpaidCredit.toLocaleString('id-ID')}</span>
                          </div>
                        ) : (
                          <div className="flex justify-between text-stone-800 pt-1 border-t border-stone-100 font-bold">
                            <span>Sisa Tagihan Baru:</span>
                            <span className="font-mono text-amber-700">Rp {newOutstanding.toLocaleString('id-ID')}</span>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>

            <div className="checkout-confirm-actions mt-4 flex gap-2 justify-end">
              <button
                type="button"
                className="checkout-confirm-btn checkout-confirm-btn--secondary"
                onClick={closeStayChangePrompt}
                disabled={stayChangeState.submitting}
              >
                Batal
              </button>
              <button
                type="button"
                className="checkout-confirm-btn checkout-confirm-btn--primary"
                onClick={confirmStayChange}
                disabled={stayChangeState.submitting || stayChangeNightsDelta === 0}
              >
                {stayChangeState.submitting ? 'Memproses...' : (stayChangeState.type === 'extend' ? 'Konfirmasi Perpanjangan' : 'Konfirmasi Pemendekan')}
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

      {paymentDetailModal.open && paymentDetailModal.payment && (
        <div className="booking-modal-backdrop" role="dialog" aria-modal="true">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 mb-4">
              <h3 className="text-base font-bold text-slate-900">Detail Transaksi Pembayaran</h3>
              <button
                type="button"
                onClick={() => setPaymentDetailModal({ open: false, payment: null })}
                className="text-slate-400 hover:text-slate-600 text-lg font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            {(() => {
              const p = paymentDetailModal.payment;
              const visual = getPaymentStatusVisual(p.status, p.transaction_type);

              return (
                <div className="space-y-3 text-xs">
                  <div className="flex justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-500">ID Pembayaran</span>
                    <strong className="font-mono text-slate-800">#{p.id}</strong>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-500">Tipe Transaksi</span>
                    <strong className="text-slate-800">{p.transaction_type}</strong>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-500">Status</span>
                    <span className={`px-2 py-0.5 font-bold rounded border ${visual.bgColor} ${visual.textColor} ${visual.borderColor}`}>
                      {visual.label}
                    </span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-500">Nominal</span>
                    <strong className="text-sm font-bold text-emerald-800 font-mono">
                      {formatCurrency(Number(p.amount || 0))}
                    </strong>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-500">Metode</span>
                    <strong className="text-slate-800">{p.payment_method || 'CASH'}</strong>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-500">Waktu Transaksi</span>
                    <strong className="text-slate-800">{formatHotelTimestamp(p.created_at)}</strong>
                  </div>
                  {p.reference_code && (
                    <div className="flex justify-between py-1.5 border-b border-slate-100">
                      <span className="text-slate-500">Kode Referensi</span>
                      <strong className="font-mono text-slate-800">{p.reference_code}</strong>
                    </div>
                  )}
                  {p.reference_payment_id && (
                    <div className="flex justify-between py-1.5 border-b border-slate-100">
                      <span className="text-slate-500">Referensi ID</span>
                      <strong className="font-mono text-slate-800">#{p.reference_payment_id}</strong>
                    </div>
                  )}
                  {p.reason_code && (
                    <div className="flex justify-between py-1.5 border-b border-slate-100">
                      <span className="text-slate-500">Alasan</span>
                      <strong className="text-amber-800">{getReasonLabel(p.reason_code)}</strong>
                    </div>
                  )}
                  {p.reason_text && (
                    <div className="py-1.5 border-b border-slate-100">
                      <div className="text-slate-500 mb-0.5">Catatan:</div>
                      <div className="text-slate-800 bg-slate-50 p-2 rounded border border-slate-100">{p.reason_text}</div>
                    </div>
                  )}
                  <div className="flex justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-500">Dibuat Oleh</span>
                    <strong className="text-slate-800">{formatActorName(p.created_by)}</strong>
                  </div>

                  {/* BUKTI PEMBAYARAN */}
                  <div className="pt-3 border-t border-slate-100">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-slate-700 font-bold uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                        <span>📎</span> Bukti Pembayaran
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setUploadExtraEvidenceModal({
                            open: true,
                            paymentId: Number(p.id),
                            form: { file: null, evidenceType: 'BANK_TRANSFER', note: '' },
                            submitting: false,
                            error: null
                          });
                        }}
                        className="text-[11px] font-semibold text-emerald-700 hover:text-emerald-800 bg-emerald-50 hover:bg-emerald-100 px-2 py-1 rounded transition"
                      >
                        ➕ Tambah Bukti
                      </button>
                    </div>

                    {(() => {
                      const activeList = getActiveEvidences(selectedFolio?.evidences, Number(p.id));
                      const inactiveList = getInactiveEvidences(selectedFolio?.evidences, Number(p.id));

                      return (
                        <div className="space-y-2">
                          {activeList.length === 0 ? (
                            <div className="bg-amber-50 border border-amber-200 text-amber-800 p-2.5 rounded-lg text-[11px] flex items-center justify-between">
                              <span>Belum ada bukti pembayaran aktif yang terlampir.</span>
                            </div>
                          ) : (
                            <div className="space-y-1.5">
                              {activeList.map((ev) => (
                                <div
                                  key={ev.id}
                                  className="bg-slate-50 border border-slate-200 rounded-lg p-2.5 flex items-center justify-between gap-2 shadow-xs"
                                >
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <span className="font-bold text-slate-800 truncate max-w-[180px]">
                                        {ev.original_filename}
                                      </span>
                                      <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-emerald-100 text-emerald-800 border border-emerald-300">
                                        {formatEvidenceType(ev.evidence_type)}
                                      </span>
                                      <span className="text-[10px] text-slate-400">
                                        {formatEvidenceFileSize(ev.file_size_bytes)}
                                      </span>
                                    </div>
                                    <div className="text-[10px] text-slate-500 mt-0.5">
                                      {formatEvidenceDate(ev.uploaded_at)} • {formatActorName(ev.uploaded_by_name_snapshot)}
                                      {ev.note && <span className="ml-1 text-slate-600">({ev.note})</span>}
                                    </div>
                                  </div>

                                  <div className="flex items-center gap-1 shrink-0">
                                    <button
                                      type="button"
                                      onClick={() => setPreviewEvidence(ev)}
                                      className="px-2 py-1 bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 rounded text-[11px] font-semibold transition"
                                      title="Lihat Bukti"
                                    >
                                      👁️ Lihat
                                    </button>
                                    <a
                                      href={`/api/reservations/${ev.reservation_id}/payments/${ev.payment_transaction_id}/evidences/${ev.id}/content?property_id=${propertyId}&download=1`}
                                      download={ev.original_filename}
                                      className="px-2 py-1 bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 rounded text-[11px] font-semibold transition inline-block"
                                      title="Unduh Bukti"
                                    >
                                      📥 Unduh
                                    </a>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setDeactivateEvidenceModal({
                                          open: true,
                                          evidence: ev,
                                          reason: '',
                                          submitting: false,
                                          error: null
                                        });
                                      }}
                                      className="px-1.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded text-[11px] font-semibold transition"
                                      title="Nonaktifkan Bukti"
                                    >
                                      🚫
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}

                          {inactiveList.length > 0 && (
                            <details className="pt-1 text-[11px]">
                              <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-semibold select-none">
                                Riwayat Bukti Dinonaktifkan ({inactiveList.length})
                              </summary>
                              <div className="mt-1.5 space-y-1.5 pl-2 border-l-2 border-slate-200">
                                {inactiveList.map((iev) => (
                                  <div
                                    key={iev.id}
                                    className="p-2 bg-slate-100/70 border border-slate-200 rounded text-slate-500 flex items-center justify-between gap-2"
                                  >
                                    <div className="min-w-0 flex-1">
                                      <div className="font-semibold line-through text-slate-500 truncate">
                                        {iev.original_filename}
                                      </div>
                                      <div className="text-[10px] text-rose-600">
                                        Alasan: {iev.deactivation_reason || '-'} ({formatActorName(iev.deactivated_by_name_snapshot)})
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0">
                                      <button
                                        type="button"
                                        onClick={() => setPreviewEvidence(iev)}
                                        className="px-2 py-0.5 bg-white border border-slate-200 rounded text-[10px] text-slate-600"
                                      >
                                        Lihat
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </details>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              );
            })()}

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setPaymentDetailModal({ open: false, payment: null })}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg text-xs cursor-pointer"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}

      {paymentCorrectionModal.open && paymentCorrectionModal.payment && (
        <div className="booking-modal-backdrop" role="dialog" aria-modal="true">
          <div className="bg-white rounded-2xl p-6 max-w-lg w-full shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 mb-4">
              <div>
                <h3 className="text-base font-bold text-slate-900">Koreksi Pembayaran</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Koreksi nominal atau metode transaksi #{paymentCorrectionModal.payment.id}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPaymentCorrectionModal((prev) => ({ ...prev, open: false, payment: null }))}
                className="text-slate-400 hover:text-slate-600 text-lg font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            {(() => {
              const origAmount = Math.round(Number(paymentCorrectionModal.payment.amount || 0));
              const newAmount = parseIdrInput(paymentCorrectionModal.newAmountDraft);
              const diff = calculateCorrectionDifference(origAmount, newAmount);
              const totalPrice = Math.round(Number(selectedRes?.total_price || 0));
              const currentPaid = Math.round(Number(selectedRes?.amount_paid || 0));
              const maxAllowedNewAmount = totalPrice - (currentPaid - origAmount);
              const val = validateCorrectionForm({
                originalAmount: origAmount,
                newAmount,
                maxAllowedNewAmount,
                reasonCode: paymentCorrectionModal.reasonCode,
                reasonText: paymentCorrectionModal.reasonText,
              });

              return (
                <div className="space-y-3.5 text-xs">
                  <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-3 text-[11px] leading-relaxed">
                    <strong>💡 Prinsip Immutabilitas Finansial:</strong> Pembayaran asli tidak akan dihapus. Sistem akan otomatis menerbitkan transaksi <strong>REVERSAL (-Rp {formatCurrency(origAmount)})</strong> dan <strong>PEMBAYARAN PENGGANTI</strong>. Bukti pembayaran lama tetap disimpan sebagai riwayat dan tidak akan dihapus.
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-500 font-semibold mb-1">Nominal Sebelumnya</label>
                      <input
                        type="text"
                        disabled
                        value={`Rp ${formatCurrency(origAmount)}`}
                        className="w-full bg-slate-100 border border-slate-200 rounded-lg px-3 py-2 font-mono font-bold text-slate-600"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-700 font-bold mb-1">Nominal Yang Benar *</label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 font-bold text-slate-400 select-none pointer-events-none">Rp</span>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={paymentCorrectionModal.newAmountDraft}
                          onChange={(e) => {
                            const valFormatted = formatIdrInput(e.target.value);
                            setPaymentCorrectionModal((prev) => ({ ...prev, newAmountDraft: valFormatted, error: null }));
                          }}
                          placeholder="0"
                          disabled={paymentCorrectionModal.submitting}
                          className="w-full bg-white border border-slate-300 rounded-lg pl-9 pr-3 py-2 font-mono font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5 flex items-center justify-between">
                    <span className="text-slate-600">Selisih penyesuaian:</span>
                    <strong className={`font-mono text-xs ${diff.isIncrease ? 'text-emerald-700' : diff.isDecrease ? 'text-rose-700' : 'text-slate-600'}`}>
                      {diff.isIncrease ? `+ Rp ${formatCurrency(diff.absDifference)} (Tagihan berkurang)` : diff.isDecrease ? `- Rp ${formatCurrency(diff.absDifference)} (Sisa tagihan bertambah)` : 'Rp 0'}
                    </strong>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-700 font-bold mb-1">Metode Pembayaran</label>
                      <select
                        value={paymentCorrectionModal.paymentMethod}
                        onChange={(e) => setPaymentCorrectionModal((prev) => ({ ...prev, paymentMethod: e.target.value }))}
                        className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                      >
                        <option value="CASH">Tunai (CASH)</option>
                        <option value="TRANSFER">Transfer Bank</option>
                        <option value="QRIS">QRIS</option>
                        <option value="DEBIT">Kartu Debit</option>
                        <option value="CREDIT_CARD">Kartu Kredit</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-slate-700 font-bold mb-1">Alasan Koreksi *</label>
                      <select
                        value={paymentCorrectionModal.reasonCode}
                        onChange={(e) => setPaymentCorrectionModal((prev) => ({ ...prev, reasonCode: e.target.value, error: null }))}
                        className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                      >
                        {PAYMENT_CORRECTION_REASONS.map((r) => (
                          <option key={r.code} value={r.code}>{r.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-slate-700 font-bold mb-1">
                      Catatan / Keterangan {paymentCorrectionModal.reasonCode === 'OTHER' ? '(Wajib)' : '(Opsional)'}
                    </label>
                    <textarea
                      rows={2}
                      value={paymentCorrectionModal.reasonText}
                      onChange={(e) => setPaymentCorrectionModal((prev) => ({ ...prev, reasonText: e.target.value, error: null }))}
                      placeholder={paymentCorrectionModal.reasonCode === 'OTHER' ? 'Jelaskan alasan koreksi...' : 'Keterangan tambahan...'}
                      className="w-full bg-white border border-slate-300 rounded-lg p-2.5 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                    />
                  </div>

                  {/* Mandatory Replacement Evidence Uploader */}
                  <div className="pt-2 border-t border-slate-100">
                    <label className="block text-slate-700 font-bold mb-1">Bukti Pembayaran Baru *</label>
                    <PaymentEvidenceUploader
                      state={paymentCorrectionEvidenceForm}
                      onChange={setPaymentCorrectionEvidenceForm}
                      disabled={paymentCorrectionModal.submitting}
                      isRequired={true}
                    />
                    {!paymentCorrectionEvidenceForm.file && (
                      <p className="text-[11px] text-amber-700 italic mt-1">
                        * Bukti pembayaran pengganti wajib dilampirkan untuk memproses koreksi.
                      </p>
                    )}
                  </div>

                  {(paymentCorrectionModal.error || (!val.valid && (val.errors.amount || val.errors.reasonCode || val.errors.reasonText))) && (
                    <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium text-xs">
                      {paymentCorrectionModal.error || val.errors.amount || val.errors.reasonCode || val.errors.reasonText}
                    </div>
                  )}

                  <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setPaymentCorrectionModal((prev) => ({ ...prev, open: false, payment: null }))}
                      disabled={paymentCorrectionModal.submitting}
                      className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg text-xs cursor-pointer"
                    >
                      Batal
                    </button>
                    <button
                      type="button"
                      onClick={submitPaymentCorrection}
                      disabled={paymentCorrectionModal.submitting || !val.valid || !paymentCorrectionEvidenceForm.file}
                      className={`px-4 py-2 rounded-lg text-xs font-bold text-white shadow-sm transition-all ${
                        paymentCorrectionModal.submitting || !val.valid || !paymentCorrectionEvidenceForm.file
                          ? 'bg-slate-300 text-slate-500 cursor-not-allowed'
                          : 'bg-emerald-800 hover:bg-emerald-900 active:bg-emerald-950 cursor-pointer'
                      }`}
                    >
                      {paymentCorrectionModal.submitting ? 'Menyimpan...' : 'Simpan Koreksi'}
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {paymentVoidModal.open && paymentVoidModal.payment && (
        <div className="booking-modal-backdrop" role="dialog" aria-modal="true">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 mb-4">
              <div>
                <h3 className="text-base font-bold text-slate-900">Batalkan Pembayaran</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Batalkan transaksi pembayaran #{paymentVoidModal.payment.id}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPaymentVoidModal((prev) => ({ ...prev, open: false, payment: null }))}
                className="text-slate-400 hover:text-slate-600 text-lg font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            {(() => {
              const p = paymentVoidModal.payment;
              const val = validateVoidForm({
                reasonCode: paymentVoidModal.reasonCode,
                reasonText: paymentVoidModal.reasonText,
              });

              return (
                <div className="space-y-3 text-xs">
                  <div className="bg-rose-50 border border-rose-200 text-rose-900 rounded-lg p-3 text-[11px] leading-relaxed">
                    <strong>⚠️ Peringatan Pembatalan:</strong> Pembayaran asli tidak akan dihapus dari histori. Sistem akan menandai transaksi sebagai <strong>DIBATALKAN</strong> dan membuat transaksi reversal pembalik saldo sebesar <strong>-Rp {formatCurrency(Number(p.amount || 0))}</strong>. Bukti pembayaran lama tetap disimpan sebagai riwayat dan tidak akan dihapus.
                  </div>

                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1.5">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Nominal:</span>
                      <strong className="text-slate-800 font-mono font-bold text-sm">Rp {formatCurrency(Number(p.amount || 0))}</strong>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Metode:</span>
                      <strong className="text-slate-800">{p.payment_method || 'CASH'}</strong>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Waktu:</span>
                      <strong className="text-slate-800">{formatHotelTimestamp(p.created_at)}</strong>
                    </div>
                  </div>

                  <div>
                    <label className="block text-slate-700 font-bold mb-1">Alasan Pembatalan *</label>
                    <select
                      value={paymentVoidModal.reasonCode}
                      onChange={(e) => setPaymentVoidModal((prev) => ({ ...prev, reasonCode: e.target.value, error: null }))}
                      className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-rose-600"
                    >
                      {PAYMENT_CORRECTION_REASONS.map((r) => (
                        <option key={r.code} value={r.code}>{r.label}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-700 font-bold mb-1">
                      Catatan {paymentVoidModal.reasonCode === 'OTHER' ? '(Wajib)' : '(Opsional)'}
                    </label>
                    <textarea
                      rows={2}
                      value={paymentVoidModal.reasonText}
                      onChange={(e) => setPaymentVoidModal((prev) => ({ ...prev, reasonText: e.target.value, error: null }))}
                      placeholder={paymentVoidModal.reasonCode === 'OTHER' ? 'Jelaskan alasan pembatalan...' : 'Catatan pembatalan...'}
                      className="w-full bg-white border border-slate-300 rounded-lg p-2.5 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-rose-600"
                    />
                  </div>

                  {(paymentVoidModal.error || (!val.valid && (val.errors.reasonCode || val.errors.reasonText))) && (
                    <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium text-xs">
                      {paymentVoidModal.error || val.errors.reasonCode || val.errors.reasonText}
                    </div>
                  )}

                  <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setPaymentVoidModal((prev) => ({ ...prev, open: false, payment: null }))}
                      disabled={paymentVoidModal.submitting}
                      className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg text-xs cursor-pointer"
                    >
                      Kembali
                    </button>
                    <button
                      type="button"
                      onClick={submitPaymentVoid}
                      disabled={paymentVoidModal.submitting || !val.valid}
                      className={`px-4 py-2 rounded-lg text-xs font-bold text-white shadow-sm transition-all ${
                        paymentVoidModal.submitting || !val.valid
                          ? 'bg-slate-300 text-slate-500 cursor-not-allowed'
                          : 'bg-rose-700 hover:bg-rose-800 active:bg-rose-900 cursor-pointer'
                      }`}
                    >
                      {paymentVoidModal.submitting ? 'Membatalkan...' : 'Konfirmasi Batalkan'}
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* Payment Evidence Modals */}
      <PaymentEvidencePreviewModal
        isOpen={previewEvidence !== null}
        onClose={() => setPreviewEvidence(null)}
        evidence={previewEvidence}
        propertyId={propertyId ?? 1}
      />

      {deactivateEvidenceModal.open && deactivateEvidenceModal.evidence && (
        <div className="booking-modal-backdrop" role="dialog" aria-modal="true">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 mb-4">
              <div>
                <h3 className="text-base font-bold text-slate-900">Nonaktifkan Bukti Pembayaran</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Bukti #{deactivateEvidenceModal.evidence.id} ({deactivateEvidenceModal.evidence.original_filename})
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDeactivateEvidenceModal({ open: false, evidence: null, reason: '', submitting: false, error: null })}
                className="text-slate-400 hover:text-slate-600 text-lg font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="bg-rose-50 border border-rose-200 text-rose-900 rounded-lg p-3 text-[11px] leading-relaxed">
                <strong>⚠️ Kebijakan Audit:</strong> File bukti tidak dihapus dari penyimpanan. Bukti akan ditandai nonaktif dalam riwayat audit dan tidak lagi dianggap sebagai bukti aktif.
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">
                  Alasan Penonaktifan *
                </label>
                <textarea
                  rows={3}
                  value={deactivateEvidenceModal.reason}
                  onChange={(e) => setDeactivateEvidenceModal(prev => ({ ...prev, reason: e.target.value, error: null }))}
                  placeholder="Contoh: Bukti buram, salah upload dokumen, atau transfer dibatalkan..."
                  className="w-full bg-white border border-slate-300 rounded-lg p-2.5 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-rose-500"
                />
              </div>

              {deactivateEvidenceModal.error && (
                <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium text-xs">
                  {deactivateEvidenceModal.error}
                </div>
              )}

              <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeactivateEvidenceModal({ open: false, evidence: null, reason: '', submitting: false, error: null })}
                  disabled={deactivateEvidenceModal.submitting}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg text-xs cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="button"
                  onClick={handleDeactivateEvidence}
                  disabled={deactivateEvidenceModal.submitting || !deactivateEvidenceModal.reason.trim()}
                  className={`px-4 py-2 rounded-lg text-xs font-bold text-white shadow-sm transition-all ${
                    deactivateEvidenceModal.submitting || !deactivateEvidenceModal.reason.trim()
                      ? 'bg-slate-300 text-slate-500 cursor-not-allowed'
                      : 'bg-rose-600 hover:bg-rose-700 active:bg-rose-800 cursor-pointer'
                  }`}
                >
                  {deactivateEvidenceModal.submitting ? 'Menonaktifkan...' : 'Konfirmasi Nonaktifkan'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {uploadExtraEvidenceModal.open && uploadExtraEvidenceModal.paymentId && (
        <div className="booking-modal-backdrop" role="dialog" aria-modal="true">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 mb-4">
              <div>
                <h3 className="text-base font-bold text-slate-900">Tambah Bukti Pembayaran</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Lampirkan bukti tambahan untuk transaksi #{uploadExtraEvidenceModal.paymentId}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setUploadExtraEvidenceModal({ open: false, paymentId: null, form: { file: null, evidenceType: 'BANK_TRANSFER', note: '' }, submitting: false, error: null })}
                className="text-slate-400 hover:text-slate-600 text-lg font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <PaymentEvidenceUploader
                state={uploadExtraEvidenceModal.form}
                onChange={(form) => setUploadExtraEvidenceModal(prev => ({ ...prev, form, error: null }))}
                disabled={uploadExtraEvidenceModal.submitting}
                isRequired
              />

              {uploadExtraEvidenceModal.error && (
                <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium text-xs">
                  {uploadExtraEvidenceModal.error}
                </div>
              )}

              <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setUploadExtraEvidenceModal({ open: false, paymentId: null, form: { file: null, evidenceType: 'BANK_TRANSFER', note: '' }, submitting: false, error: null })}
                  disabled={uploadExtraEvidenceModal.submitting}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg text-xs cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="button"
                  onClick={handleUploadExtraEvidence}
                  disabled={uploadExtraEvidenceModal.submitting || !uploadExtraEvidenceModal.form.file}
                  className={`px-4 py-2 rounded-lg text-xs font-bold text-white shadow-sm transition-all ${
                    uploadExtraEvidenceModal.submitting || !uploadExtraEvidenceModal.form.file
                      ? 'bg-slate-300 text-slate-500 cursor-not-allowed'
                      : 'bg-emerald-800 hover:bg-emerald-900 active:bg-emerald-950 cursor-pointer'
                  }`}
                >
                  {uploadExtraEvidenceModal.submitting ? 'Mengunggah...' : 'Unggah Bukti'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {selectedOperationalBlock && (
        <OperationalBlockDetailModal
          block={selectedOperationalBlock.block}
          roomNumber={selectedOperationalBlock.roomNumber}
          roomTypeName={selectedOperationalBlock.roomTypeName}
          onClose={() => setSelectedOperationalBlock(null)}
          onRefresh={() => {
            fetchDataRef.current();
          }}
        />
      )}
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

export default function App() {
  return (
    <AuthProvider>
      <ProtectedRoute>
        <AppContent />
      </ProtectedRoute>
    </AuthProvider>
  );
}
