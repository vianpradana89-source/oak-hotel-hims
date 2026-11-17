import React, { useState, useEffect, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom';
import { safeFetchJson } from './calendarApi';
import { useAuth } from '../auth/AuthContext';
import GuestSearchAutocomplete from '../booking/GuestSearchAutocomplete';
import IdentityExtractionModal from '../booking/IdentityExtractionModal';
import OtaSourceManagerModal from '../ota/OtaSourceManagerModal';
import { StayChargePickerCombobox } from '../stayCharges/StayChargePickerCombobox';
import type { StayChargeRule } from '../stayCharges/stayChargesTypes';
import type { Guest } from '../guests/guestTypes';

interface EditReservationModalProps {
  isOpen: boolean;
  onClose: () => void;
  reservation: any;
  propertyId: number;
  onSuccess: () => void;
}

interface ExistingFolioChargeItem {
  id: number;
  entry_type: string;
  description: string;
  amount: number;
  quantity: number;
  unit_price: number;
  rule_id?: number | null;
}

interface PendingStayChargeItem {
  tempId: string;
  rule_id: number | null;
  charge_type: string;
  name: string;
  quantity: number;
  unit_price: number;
  amount: number;
  is_override?: boolean;
  override_amount?: number;
  override_reason?: string;
  note?: string;
}

interface AdditionalRoomDraft {
  tempId: string;
  stayType: 'OVERNIGHT' | 'DAY_USE';
  checkIn: string;
  checkOut: string;
  checkInTime: string;
  checkOutTime: string;
  roomTypeId: number | null;
  roomId: number | null;
  ratePlanId: number | null;
  isManualOverride: boolean;
  manualOverridePrice: number;
  manualOverrideReason: string;
  stayCharges: PendingStayChargeItem[];
}

export const EditReservationModal: React.FC<EditReservationModalProps> = ({
  isOpen,
  onClose,
  reservation,
  propertyId,
  onSuccess
}) => {
  const [loading, setLoading] = useState<boolean>(false);
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const { authFetch, user } = useAuth();

  // 1. Booking Source State
  const [channel, setChannel] = useState<'WALKIN' | 'OTA'>('WALKIN');
  const [walkinSubSource, setWalkinSubSource] = useState<'FRONT_DESK' | 'PHONE' | 'WEB'>('FRONT_DESK');
  const [otaSourceId, setOtaSourceId] = useState<number | null>(null);
  const [otaSources, setOtaSources] = useState<any[]>([]);
  const [isOtaModalOpen, setIsOtaModalOpen] = useState<boolean>(false);
  const [paymentResponsibility, setPaymentResponsibility] = useState<'HOTEL_COLLECT' | 'OTA_COLLECT'>('HOTEL_COLLECT');

  // 2. Guest & Booker State
  const [sameAsBooker, setSameAsBooker] = useState<boolean>(true);
  const [guestName, setGuestName] = useState<string>('');
  const [guestPhone, setGuestPhone] = useState<string>('');
  const [selectedGuest, setSelectedGuest] = useState<Guest | null>(null);
  const [guestNameTouched, setGuestNameTouched] = useState<boolean>(false);
  const [guestSegment, setGuestSegment] = useState<string>('Reguler');
  const [bookerName, setBookerName] = useState<string>('');
  const [bookerPhone, setBookerPhone] = useState<string>('');
  const [selectedBookerGuest, setSelectedBookerGuest] = useState<Guest | null>(null);
  const [referral, setReferral] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [adults, setAdults] = useState<number>(2);
  const [children, setChildren] = useState<number>(0);

  // 3. Stay & Room State
  const [checkIn, setCheckIn] = useState<string>('');
  const [checkOut, setCheckOut] = useState<string>('');
  const [stayType, setStayType] = useState<'OVERNIGHT' | 'DAY_USE' | 'TRANSIT'>('OVERNIGHT');
  const [checkInTime, setCheckInTime] = useState<string>('14:00');
  const [checkOutTime, setCheckOutTime] = useState<string>('12:00');

  const [roomTypeId, setRoomTypeId] = useState<number | null>(null);
  const [roomId, setRoomId] = useState<number | null>(null);
  const [ratePlanId, setRatePlanId] = useState<number | null>(null);

  // Additional Rooms added via "+ Tambah Kamar"
  const [additionalRooms, setAdditionalRooms] = useState<AdditionalRoomDraft[]>([]);

  // 4. Manual Price Override & Global Discount State
  const [isManualOverride, setIsManualOverride] = useState<boolean>(false);
  const [manualOverridePrice, setManualOverridePrice] = useState<number>(0);
  const [manualOverrideReason, setManualOverrideReason] = useState<string>('');
  const [discountType, setDiscountType] = useState<'NOMINAL' | 'PERCENT'>('NOMINAL');
  const [discountValue, setDiscountValue] = useState<number>(0);
  const [discountReason, setDiscountReason] = useState<string>('');

  // 5. Stay Charges (Existing Folio Items + Pending Additions/Removals)
  const [stayChargeRules, setStayChargeRules] = useState<(StayChargeRule | any)[]>([]);
  const [existingFolioCharges, setExistingFolioCharges] = useState<ExistingFolioChargeItem[]>([]);
  const [removedFolioEntryIds, setRemovedFolioEntryIds] = useState<number[]>([]);
  const [pendingStayCharges, setPendingStayCharges] = useState<PendingStayChargeItem[]>([]);

  // 6. Section 5: Pembayaran & Bukti Bayar State
  const [paymentMode, setPaymentMode] = useState<'PAY_BILL' | 'ADVANCE_PAYMENT' | 'UNPAID'>('PAY_BILL');
  const [paymentMethod, setPaymentMethod] = useState<string>('CASH');
  const [newPaymentAmount, setNewPaymentAmount] = useState<number>(0);
  const [buktiBayarFile, setBuktiBayarFile] = useState<File | null>(null);

  // Master Data
  const [ratePlans, setRatePlans] = useState<any[]>([]);
  const [availableRoomTypes, setAvailableRoomTypes] = useState<any[] | null>(null);
  const [availabilityLoading, setAvailabilityLoading] = useState<boolean>(false);

  // Preview State
  const [previewData, setPreviewData] = useState<any>(null);

  // Identity (Lengkapi KTP) State
  const [showIdentityModal, setShowIdentityModal] = useState<boolean>(false);
  const [identityModalMode, setIdentityModalMode] = useState<'UPLOAD' | 'DETAIL'>('UPLOAD');
  const [identityConfirmedGuestId, setIdentityConfirmedGuestId] = useState<number | null>(null);

  // Lower Price Confirmation Modal State
  const [showDecreaseModal, setShowDecreaseModal] = useState<boolean>(false);
  const [ratePlanTouched, setRatePlanTouched] = useState<boolean>(false);
  const previewRequestRef = useRef(0);
  const availabilityRequestRef = useRef(0);
  const saveRequestKeyRef = useRef<string | null>(null);

  const isOta = channel === 'OTA' || otaSourceId != null;
  const selectedAvailableType = availableRoomTypes?.find((type) => Number(type.id) === Number(roomTypeId));
  const availableRooms = selectedAvailableType?.rooms || [];
  const hasAssignableRoom = availableRooms.some((room: any) => Number(room.id) === Number(roomId));
  const selectedRatePlan = ratePlans.find((plan) => Number(plan.id) === Number(ratePlanId));
  const hasCompatibleRatePlan = Boolean(
    selectedRatePlan
    && Number(selectedRatePlan.room_type_id) === Number(roomTypeId)
    && selectedRatePlan.is_active !== false
    && selectedRatePlan.is_archived !== true
    && (stayType === 'DAY_USE' ? selectedRatePlan.rate_type === 'DAY_USE' : selectedRatePlan.rate_type !== 'DAY_USE')
  );

  const primaryGuestId: number | null = reservation?.primary_guest?.primary_guest_id ?? null;
  const effectiveGuestId: number | null =
    selectedGuest?.id
    ?? (guestNameTouched ? null : primaryGuestId);
  const hasKtpVerified = Boolean(
    identityConfirmedGuestId ||
    selectedGuest?.has_valid_identity ||
    selectedGuest?.identity_number ||
    selectedGuest?.identity_path ||
    reservation?.has_valid_identity ||
    reservation?.identity_number ||
    reservation?.ktp_path ||
    reservation?.primary_guest?.primary_guest_identity_verified ||
    reservation?.primary_guest?.primary_guest_identity_number ||
    reservation?.precheckin_eligibility?.identity_ok
  );
  const currentNik =
    selectedGuest?.identity_number ||
    reservation?.primary_guest?.primary_guest_identity_number ||
    reservation?.identity_number ||
    null;

  // Initialize form from reservation
  useEffect(() => {
    if (!reservation || !isOpen) return;

    const initialOtaId = reservation.ota_source_id ? Number(reservation.ota_source_id) : null;
    const isInitialOta = initialOtaId != null || String(reservation.booking_source || '').toLowerCase() === 'ota';
    setChannel(isInitialOta ? 'OTA' : 'WALKIN');
    setOtaSourceId(initialOtaId);
    setPaymentResponsibility(
      String(reservation.payment_responsibility || '').toUpperCase() === 'OTA_COLLECT'
        ? 'OTA_COLLECT'
        : (isInitialOta ? 'OTA_COLLECT' : 'HOTEL_COLLECT')
    );

    const rawSubSource = String(reservation.booking_channel || reservation.booking_source || '').toUpperCase();
    if (rawSubSource.includes('PHONE') || rawSubSource.includes('WA') || rawSubSource.includes('TELEPON')) {
      setWalkinSubSource('PHONE');
    } else if (rawSubSource.includes('WEB')) {
      setWalkinSubSource('WEB');
    } else {
      setWalkinSubSource('FRONT_DESK');
    }

    const gName = reservation.guest_name || '';
    const gPhone = reservation.guest_phone || '';
    const bName = reservation.booker_name || gName;
    const bPhone = reservation.booker_phone || gPhone;
    setGuestName(gName);
    setGuestPhone(gPhone);
    setBookerName(bName);
    setBookerPhone(bPhone);
    setSameAsBooker(
      !bName ||
      (bName.trim().toLowerCase() === gName.trim().toLowerCase() &&
       (!bPhone || bPhone.trim() === gPhone.trim()))
    );

    if (reservation.primary_guest) {
      setSelectedGuest({
        id: reservation.primary_guest.primary_guest_id,
        full_name: reservation.primary_guest.primary_guest_name || reservation.guest_name,
        phone: reservation.primary_guest.primary_guest_phone || reservation.guest_phone,
        guest_code: null,
        preferred_name: null,
        gender: null,
        birth_place: null,
        birth_date: null,
        nationality: null,
        email: null,
        address: null,
        city: null,
        province: null,
        country: null,
        guest_segment: reservation.guest_segment || 'Reguler',
        vip_status: 'STANDARD' as const,
        preferences: null,
        identity_type: null,
        identity_number: reservation.primary_guest.primary_guest_identity_number || reservation.identity_number || null,
        identity_path: reservation.primary_guest.primary_guest_identity_path || reservation.ktp_path || null,
        has_valid_identity: Boolean(reservation.primary_guest.primary_guest_identity_verified || reservation.has_valid_identity),
        rt_rw: null,
        village_kelurahan: null,
        district_kecamatan: null,
        religion: null,
        marital_status: null,
        occupation: null,
        citizenship: null,
        valid_until: null,
        ktp_ocr_confidence: null,
        ktp_ocr_provider: null,
        ktp_extracted_at: null,
        ktp_regency_id: null,
        notes: null,
        is_archived: false,
        is_active: true,
        created_property_id: propertyId,
        created_at: '',
        updated_at: ''
      });
    } else {
      setSelectedGuest(null);
    }

    setGuestSegment(reservation.guest_segment || 'Reguler');
    setReferral(reservation.referral || '');
    setNotes(reservation.notes || reservation.special_requests || '');
    setAdults(Number(reservation.adults || 2));
    setChildren(Number(reservation.children || 0));

    const ci = reservation.check_in ? String(reservation.check_in).slice(0, 10) : '';
    const co = reservation.check_out ? String(reservation.check_out).slice(0, 10) : '';
    setCheckIn(ci);
    setCheckOut(co);
    const st = (reservation.stay_type || 'OVERNIGHT') as 'OVERNIGHT' | 'DAY_USE' | 'TRANSIT';
    setStayType(st);
    setCheckInTime(reservation.check_in_time || (st === 'DAY_USE' ? '10:00' : '14:00'));
    setCheckOutTime(reservation.check_out_time || (st === 'DAY_USE' ? '16:00' : '12:00'));

    setRoomTypeId(Number(reservation.room_type_id || reservation.booked_room_type_id_snapshot) || null);
    setRoomId(Number(reservation.room_id) || null);
    setRatePlanId(Number(reservation.rate_plan_id) || null);
    setAdditionalRooms([]);

    const nightsCount = st === 'DAY_USE'
      ? 1
      : Math.max(1, Math.round((new Date(co).getTime() - new Date(ci).getTime()) / 86400000) || 1);
    const initialRoomGross = Number(reservation.subtotal_amount || reservation.total_price || 0);
    const initialManualOverride = Boolean(reservation.is_manual_override);
    setIsManualOverride(initialManualOverride);
    setManualOverridePrice(
      isInitialOta
        ? Math.round(initialRoomGross)
        : Math.round(initialRoomGross / nightsCount)
    );
    setManualOverrideReason(reservation.manual_override_reason || '');

    const initialDiscount = Math.max(0, Math.round(Number(reservation.discount_amount || 0)));
    setDiscountType('NOMINAL');
    setDiscountValue(initialDiscount);
    setDiscountReason(reservation.discount_reason || '');

    setPaymentMode('PAY_BILL');
    setPaymentMethod('CASH');
    setNewPaymentAmount(0);
    setBuktiBayarFile(null);

    setRemovedFolioEntryIds([]);
    setPendingStayCharges([]);
    setRatePlanTouched(false);
    setGuestNameTouched(false);
    setError(null);
    setPreviewData(null);
    setShowDecreaseModal(false);
    setIdentityConfirmedGuestId(null);
    saveRequestKeyRef.current = null;
  }, [reservation, isOpen, propertyId]);

  const reloadOtaSources = useCallback(async () => {
    try {
      const otaRes = await safeFetchJson<{ data?: any[] }>(
        `/api/pricing/ota-sources?property_id=${propertyId}&is_active=true`,
        undefined,
        undefined,
        authFetch
      );
      if (otaRes.ok) {
        const otas = Array.isArray(otaRes.data)
          ? otaRes.data
          : (Array.isArray((otaRes.data as any)?.data) ? (otaRes.data as any).data : []);
        setOtaSources(otas.filter((o: any) => o.is_active !== false));
      }
    } catch {
      // ignore
    }
  }, [propertyId, authFetch]);

  // Load Rate Plans, OTA Sources, Stay Charge Rules, and Existing Folio Entries
  useEffect(() => {
    if (!isOpen || !reservation?.id) return;
    const loadMastersAndFolio = async () => {
      try {
        const [rpRes, otaRes, scRes, folioRes] = await Promise.all([
          safeFetchJson<{ data?: any[] }>(`/api/pricing/rate-plans?property_id=${propertyId}&is_active=true`, undefined, undefined, authFetch),
          safeFetchJson<{ data?: any[] }>(`/api/pricing/ota-sources?property_id=${propertyId}&is_active=true`, undefined, undefined, authFetch),
          safeFetchJson<{ data?: any[] }>(`/api/stay-charges/rules?property_id=${propertyId}`, undefined, undefined, authFetch),
          safeFetchJson<{ data?: any }>(`/api/reservations/${reservation.id}/folio?property_id=${propertyId}`, undefined, undefined, authFetch)
        ]);
        if (rpRes.ok) {
          const plans = Array.isArray(rpRes.data)
            ? rpRes.data
            : (Array.isArray((rpRes.data as any)?.data) ? (rpRes.data as any).data : []);
          setRatePlans(plans.filter((rp: any) => rp.is_active !== false && rp.is_archived !== true));
        }
        if (otaRes.ok) {
          const otas = Array.isArray(otaRes.data)
            ? otaRes.data
            : (Array.isArray((otaRes.data as any)?.data) ? (otaRes.data as any).data : []);
          setOtaSources(otas.filter((o: any) => o.is_active !== false));
        }
        if (scRes.ok) {
          const rules = Array.isArray(scRes.data)
            ? scRes.data
            : (Array.isArray((scRes.data as any)?.data) ? (scRes.data as any).data : []);
          setStayChargeRules(rules.filter((r: any) => r.is_active !== false && r.is_archived !== true));
        }
        if (folioRes.ok && folioRes.data?.data) {
          const entries = folioRes.data.data.entries || folioRes.data.data.folio || [];
          const nonRoomDebits: ExistingFolioChargeItem[] = entries
            .filter((ent: any) => {
              const isDebit = (ent.direction || ent.amount_type) === 'DEBIT';
              const entryTypeUpper = String(ent.entry_type || ent.source_type || '').toUpperCase();
              const sourceTypeUpper = String(ent.source_type || '').toUpperCase();
              const isRoomCharge = entryTypeUpper === 'ROOM_CHARGE' || sourceTypeUpper === 'ROOM_CHARGE';
              const isSystemEntry = ['PAYMENT_VOID', 'PAYMENT_REVERSAL', 'REFUND_DEBIT', 'DEPOSIT_UNAPPLY'].includes(entryTypeUpper);
              return isDebit && !isRoomCharge && !isSystemEntry && !ent.is_voided;
            })
            .map((ent: any) => ({
              id: Number(ent.id),
              entry_type: String(ent.entry_type || ent.source_type || 'EXTRA_BED'),
              description: String(ent.description || ent.entry_type || 'Layanan Tambahan'),
              amount: Math.round(Number(ent.amount || 0)),
              quantity: Math.max(1, Number(ent.quantity || 1)),
              unit_price: Math.round(Number(ent.unit_price || ent.amount || 0)),
              rule_id: ent.rule_id ? Number(ent.rule_id) : null
            }));
          setExistingFolioCharges(nonRoomDebits);

          const roomChargeEntry = entries.find((ent: any) => {
            const isDebit = (ent.direction || ent.amount_type) === 'DEBIT';
            const entryTypeUpper = String(ent.entry_type || ent.source_type || '').toUpperCase();
            return isDebit && entryTypeUpper === 'ROOM_CHARGE' && !ent.is_voided;
          });
          if (roomChargeEntry && Number(roomChargeEntry.amount) > 0) {
            const rcAmount = Math.round(Number(roomChargeEntry.amount));
            const st = (reservation.stay_type || 'OVERNIGHT') as string;
            const ci = reservation.check_in ? String(reservation.check_in).slice(0, 10) : '';
            const co = reservation.check_out ? String(reservation.check_out).slice(0, 10) : '';
            const nCount = st === 'DAY_USE'
              ? 1
              : Math.max(1, Math.round((new Date(co).getTime() - new Date(ci).getTime()) / 86400000) || 1);
            const isInitOta = reservation.ota_source_id != null || String(reservation.booking_source || '').toLowerCase() === 'ota';
            setManualOverridePrice(isInitOta ? rcAmount : Math.round(rcAmount / nCount));
          }
        }
      } catch (err) {
        console.warn('Failed to load master data for edit modal', err);
      }
    };
    loadMastersAndFolio();
  }, [isOpen, reservation?.id, propertyId, authFetch]);

  // Date-aware selector availability (supports both BOOKED and CHECKED_IN via allow_checked_in=1)
  useEffect(() => {
    if (!isOpen || !reservation?.id || !checkIn || (!checkOut && stayType !== 'DAY_USE')) {
      availabilityRequestRef.current += 1;
      setAvailableRoomTypes(null);
      setAvailabilityLoading(false);
      return;
    }
    const requestId = ++availabilityRequestRef.current;
    const controller = new AbortController();
    const effectiveCheckOut = stayType === 'DAY_USE' ? checkIn : checkOut;
    const params = new URLSearchParams({
      property_id: String(propertyId),
      check_in: checkIn,
      check_out: effectiveCheckOut,
      stay_type: stayType,
      allow_checked_in: '1'
    });
    const loadAvailability = async () => {
      try {
        setAvailabilityLoading(true);
        setAvailableRoomTypes(null);
        const result = await safeFetchJson<{ data?: { room_types?: any[] } }>(
          `/api/reservations/${reservation.id}/edit-availability?${params.toString()}`,
          { signal: controller.signal },
          'Gagal memuat kamar yang tersedia untuk tanggal menginap.',
          authFetch
        );
        if (requestId !== availabilityRequestRef.current) return;
        if (!result.ok || !result.data?.data) {
          setAvailableRoomTypes([]);
          setError(result.errorMessage || 'Gagal memuat kamar yang tersedia untuk tanggal menginap.');
          return;
        }
        setAvailableRoomTypes(result.data.data.room_types || []);
      } catch (err: any) {
        if (requestId === availabilityRequestRef.current && err?.name !== 'AbortError') {
          setAvailableRoomTypes([]);
          setError('Gagal memuat kamar yang tersedia untuk tanggal menginap.');
        }
      } finally {
        if (requestId === availabilityRequestRef.current) setAvailabilityLoading(false);
      }
    };
    loadAvailability();
    return () => controller.abort();
  }, [isOpen, reservation?.id, propertyId, checkIn, checkOut, stayType, authFetch]);

  useEffect(() => {
    if (availabilityLoading || availableRoomTypes === null) return;
    setRoomTypeId((currentTypeId) => {
      if (!currentTypeId) return null;
      return availableRoomTypes.some((type) => Number(type.id) === Number(currentTypeId))
        ? currentTypeId
        : (availableRoomTypes[0]?.id ? Number(availableRoomTypes[0].id) : null);
    });
  }, [availableRoomTypes, availabilityLoading]);

  useEffect(() => {
    if (availabilityLoading || availableRoomTypes === null) return;
    if (!roomTypeId) {
      setRoomId(null);
      return;
    }
    const currentType = availableRoomTypes.find((type) => Number(type.id) === Number(roomTypeId));
    const roomsForType = currentType?.rooms || [];
    setRoomId((currentRoomId) => {
      if (roomsForType.some((room: any) => Number(room.id) === Number(currentRoomId))) return currentRoomId;
      return roomsForType.length >= 1 ? Number(roomsForType[0].id) : null;
    });
  }, [availableRoomTypes, availabilityLoading, roomTypeId]);

  // Fetch Pricing Preview
  const fetchPreview = useCallback(async () => {
    if (!reservation?.id || availabilityLoading || !roomTypeId || !roomId || !hasAssignableRoom || !checkIn || (!checkOut && stayType !== 'DAY_USE') || (!isOta && !hasCompatibleRatePlan)) {
      previewRequestRef.current += 1;
      setPreviewData(null);
      setPreviewLoading(false);
      return;
    }
    const requestId = ++previewRequestRef.current;
    try {
      setPreviewLoading(true);
      setError(null);
      const result = await safeFetchJson<{ data?: any }>(
        `/api/reservations/${reservation.id}/edit-preview`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            room_type_id: roomTypeId,
            room_id: roomId,
            rate_plan_id: ratePlanId,
            preserve_rate_plan: !ratePlanTouched,
            check_in: checkIn,
            check_out: stayType === 'DAY_USE' ? checkIn : checkOut,
            stay_type: stayType,
            adults,
            children
          })
        },
        'Gagal menghitung pratinjau harga',
        authFetch
      );
      if (requestId !== previewRequestRef.current) return;
      if (result.ok && result.data?.data) {
        setPreviewData(result.data.data);
      } else {
        setError(result.errorMessage || 'Gagal menghitung pratinjau harga');
      }
    } catch (err: any) {
      console.warn('Preview error', err);
    } finally {
      if (requestId === previewRequestRef.current) setPreviewLoading(false);
    }
  }, [reservation, roomTypeId, roomId, ratePlanId, checkIn, checkOut, stayType, adults, children, availabilityLoading, hasAssignableRoom, isOta, hasCompatibleRatePlan, authFetch]);

  useEffect(() => {
    if (isOpen && checkIn && roomTypeId && roomId && hasAssignableRoom && !availabilityLoading && (isOta || hasCompatibleRatePlan)) {
      fetchPreview();
    }
  }, [isOpen, checkIn, checkOut, stayType, roomTypeId, roomId, ratePlanId, adults, children, availabilityLoading, hasAssignableRoom, isOta, hasCompatibleRatePlan, fetchPreview]);

  useEffect(() => {
    saveRequestKeyRef.current = null;
  }, [roomTypeId, roomId, ratePlanId, checkIn, checkOut, stayType, adults, children, channel, otaSourceId, isManualOverride, manualOverridePrice, discountType, discountValue]);

  useEffect(() => {
    if (!roomTypeId || ratePlans.length === 0) return;
    const compatible = ratePlans.filter((rp) =>
      Number(rp.room_type_id) === Number(roomTypeId)
      && rp.is_active !== false
      && rp.is_archived !== true
      && (stayType === 'DAY_USE' ? rp.rate_type === 'DAY_USE' : rp.rate_type !== 'DAY_USE')
    );
    if (compatible.some((rp) => Number(rp.id) === Number(ratePlanId))) return;
    const preferred = compatible.find((rp) => stayType === 'DAY_USE' ? rp.rate_type === 'DAY_USE' : rp.rate_type !== 'DAY_USE');
    setRatePlanId(preferred?.id || compatible[0]?.id || null);
  }, [ratePlans, ratePlanId, roomTypeId, stayType]);

  // Financial Calculations (matching QuickBookingModal)
  const stayNights = stayType === 'DAY_USE'
    ? 1
    : Math.max(1, Math.round((new Date(checkOut || checkIn).getTime() - new Date(checkIn).getTime()) / 86400000) || 1);

  const quotedRoomSubtotal = Number(
    previewData?.quote?.room_subtotal ??
    previewData?.quote?.grand_total ??
    reservation?.subtotal_amount ??
    reservation?.total_price ??
    0
  );

  const effectiveRoomCharge = isOta
    ? Math.max(0, Math.round(Number(manualOverridePrice || quotedRoomSubtotal)))
    : isManualOverride
      ? Math.max(0, Math.round(Number(manualOverridePrice || 0)) * stayNights)
      : Math.max(0, Math.round(quotedRoomSubtotal));

  const roomNightlyRate = Math.max(0, Math.round(quotedRoomSubtotal / stayNights));

  const activeExistingCharges = existingFolioCharges.filter((c) => !removedFolioEntryIds.includes(c.id));
  const existingStayChargesTotal = activeExistingCharges.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const pendingStayChargesTotal = pendingStayCharges.reduce((sum, item) => sum + Number(item.amount || 0), 0);

  // Additional rooms calculations
  const additionalRoomsCalcs = additionalRooms.map((ar) => {
    const arNights = ar.stayType === 'DAY_USE'
      ? 1
      : Math.max(1, Math.round((new Date(ar.checkOut || ar.checkIn).getTime() - new Date(ar.checkIn).getTime()) / 86400000) || 1);
    const arType = (availableRoomTypes || []).find((rt) => Number(rt.id) === Number(ar.roomTypeId));
    const arRoom = (arType?.rooms || []).find((r: any) => Number(r.id) === Number(ar.roomId));
    const arPlan = ratePlans.find((rp) => Number(rp.id) === Number(ar.ratePlanId));
    const arBaseNightly = Number(arPlan?.base_price || arType?.base_price || roomNightlyRate || 0);
    const arRoomCharge = isOta
      ? Math.max(0, Math.round(Number(ar.manualOverridePrice || arBaseNightly * arNights)))
      : ar.isManualOverride
        ? Math.max(0, Math.round(Number(ar.manualOverridePrice || 0)) * arNights)
        : Math.max(0, Math.round(arBaseNightly * arNights));
    const arStayCharges = ar.stayCharges.reduce((sum, sc) => sum + Number(sc.amount || 0), 0);
    const arLabel = `${arRoom?.room_number || '-'} (${arType?.name || 'Kamar'}${arType?.code ? ` (${arType.code})` : ''})`;
    return {
      nights: arNights,
      baseNightly: arBaseNightly,
      roomCharge: arRoomCharge,
      stayChargesTotal: arStayCharges,
      roomLabel: arLabel,
      roomTypeName: arType?.name || 'Belum Pilih Tipe',
      roomTypeCode: arType?.code || '',
      roomNumber: arRoom?.room_number || 'Belum Pilih Kamar'
    };
  });

  const additionalRoomChargesTotal = additionalRoomsCalcs.reduce((s, c) => s + c.roomCharge, 0);
  const additionalStayChargesTotal = additionalRoomsCalcs.reduce((s, c) => s + c.stayChargesTotal, 0);

  const totalStayCharges = existingStayChargesTotal + pendingStayChargesTotal + additionalStayChargesTotal;
  const grossTotal = effectiveRoomCharge + additionalRoomChargesTotal + totalStayCharges;
  const computedDiscountAmount = discountType === 'PERCENT'
    ? Math.min(grossTotal, Math.max(0, Math.round((grossTotal * Number(discountValue || 0)) / 100)))
    : Math.min(grossTotal, Math.max(0, Math.round(Number(discountValue || 0))));
  const grandTotal = Math.max(0, grossTotal - computedDiscountAmount);

  const amountPaid = Number(previewData?.amount_paid ?? reservation?.amount_paid ?? 0);
  const appliedDeposit = Number(previewData?.applied_deposit ?? reservation?.applied_deposit ?? 0);
  const paymentRequired = Number(previewData?.payment_required ?? 0);
  const newRemainingBeforePayment = Number(previewData?.new_remaining_before_payment ?? Math.max(0, grandTotal - amountPaid - appliedDeposit));
  const effectiveNewPayment = (channel === 'OTA' && paymentResponsibility === 'OTA_COLLECT') || paymentMode === 'UNPAID'
    ? 0
    : Math.max(0, Math.round(Number(newPaymentAmount || 0)));
  const totalSettledDisplay = amountPaid + appliedDeposit + (paymentMode === 'PAY_BILL' ? effectiveNewPayment : 0);
  const remainingBalance = Math.max(0, grandTotal - totalSettledDisplay);

  // Preserve contract helper for payment form data serialization
  const appendCanonicalPaymentFields = (formData: FormData, cashTendered: number) => {
    if (previewData && paymentRequired > 0) {
      formData.append('amount_tendered', String(cashTendered));
      formData.append('payment_amount', String(paymentRequired));
    }
  };
  void appendCanonicalPaymentFields;
  void newRemainingBeforePayment;

  const handleAddStayChargeFromRule = (rule: StayChargeRule | any) => {
    let calcUnitPrice = Number(rule.default_amount || 0);
    if (rule.charge_method === 'FULL_NIGHT') {
      calcUnitPrice = Math.round(effectiveRoomCharge / stayNights);
    } else if (rule.charge_method === 'PERCENTAGE_OF_NIGHTLY_RATE') {
      const nightlyAvg = effectiveRoomCharge / stayNights;
      calcUnitPrice = Math.round((nightlyAvg * Number(rule.percentage_rate || 0)) / 100);
    } else if (rule.charge_method === 'FREE') {
      calcUnitPrice = 0;
    }
    const newItem: PendingStayChargeItem = {
      tempId: `sc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      rule_id: rule.id,
      charge_type: rule.charge_type,
      name: rule.name,
      quantity: 1,
      unit_price: calcUnitPrice,
      amount: calcUnitPrice
    };
    setPendingStayCharges((prev) => [...prev, newItem]);
  };

  const handleAddExtraRoom = () => {
    const usedRoomIds = new Set<number>([
      ...(roomId ? [Number(roomId)] : []),
      ...additionalRooms.map((r) => Number(r.roomId)).filter(Boolean)
    ]);
    let defaultTypeId: number | null = roomTypeId;
    let defaultRoomId: number | null = null;
    for (const rt of availableRoomTypes || []) {
      const candidate = (rt.rooms || []).find((rm: any) => !usedRoomIds.has(Number(rm.id)));
      if (candidate) {
        defaultTypeId = Number(rt.id);
        defaultRoomId = Number(candidate.id);
        break;
      }
    }
    const compatible = ratePlans.filter(
      (rp) =>
        defaultTypeId &&
        Number(rp.room_type_id) === Number(defaultTypeId) &&
        rp.is_active !== false &&
        rp.is_archived !== true &&
        (stayType === 'DAY_USE' ? rp.rate_type === 'DAY_USE' : rp.rate_type !== 'DAY_USE')
    );
    const defaultPlanId = compatible[0]?.id ? Number(compatible[0].id) : ratePlanId;
    setAdditionalRooms((prev) => [
      ...prev,
      {
        tempId: `extra-room-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        stayType: stayType === 'DAY_USE' ? 'DAY_USE' : 'OVERNIGHT',
        checkIn,
        checkOut,
        checkInTime,
        checkOutTime,
        roomTypeId: defaultTypeId,
        roomId: defaultRoomId,
        ratePlanId: defaultPlanId,
        isManualOverride: false,
        manualOverridePrice: isOta ? manualOverridePrice : roomNightlyRate,
        manualOverrideReason: '',
        stayCharges: []
      }
    ]);
  };

  const handleUpdateExtraRoom = (tempId: string, patch: Partial<AdditionalRoomDraft>) => {
    setAdditionalRooms((prev) =>
      prev.map((r) => (r.tempId === tempId ? { ...r, ...patch } : r))
    );
  };

  const handleRemoveExtraRoom = (tempId: string) => {
    setAdditionalRooms((prev) => prev.filter((r) => r.tempId !== tempId));
  };

  const handleAddStayChargeToExtraRoom = (tempId: string, rule: StayChargeRule | any, roomIdx: number) => {
    const calc = additionalRoomsCalcs[roomIdx] || { roomCharge: 0, nights: 1 };
    let calcUnitPrice = Number(rule.default_amount || 0);
    if (rule.charge_method === 'FULL_NIGHT') {
      calcUnitPrice = Math.round(calc.roomCharge / calc.nights);
    } else if (rule.charge_method === 'PERCENTAGE_OF_NIGHTLY_RATE') {
      const nightlyAvg = calc.roomCharge / calc.nights;
      calcUnitPrice = Math.round((nightlyAvg * Number(rule.percentage_rate || 0)) / 100);
    } else if (rule.charge_method === 'FREE') {
      calcUnitPrice = 0;
    }
    const newItem: PendingStayChargeItem = {
      tempId: `sc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      rule_id: rule.id,
      charge_type: rule.charge_type,
      name: rule.name,
      quantity: 1,
      unit_price: calcUnitPrice,
      amount: calcUnitPrice
    };
    setAdditionalRooms((prev) =>
      prev.map((r) => (r.tempId === tempId ? { ...r, stayCharges: [...r.stayCharges, newItem] } : r))
    );
  };

  const actorName = user?.username || user?.full_name || undefined;

  const buildEditPayload = () => ({
    allow_checked_in: true,
    actor: actorName,
    booking_source: channel === 'OTA' ? 'ota' : 'walkin',
    payment_responsibility: channel === 'OTA' ? paymentResponsibility : 'HOTEL_COLLECT',
    ota_source_id: channel === 'OTA' ? otaSourceId : null,
    guest_name: guestName.trim(),
    guest_phone: guestPhone.trim(),
    guest_segment: guestSegment,
    booker_name: sameAsBooker ? guestName.trim() : (bookerName.trim() || guestName.trim()),
    booker_phone: sameAsBooker ? guestPhone.trim() : (bookerPhone.trim() || guestPhone.trim()),
    guest_id: selectedGuest?.id ?? (guestNameTouched ? undefined : (primaryGuestId ?? undefined)),
    booker_guest_id: sameAsBooker ? (selectedGuest?.id ?? undefined) : (selectedBookerGuest?.id ?? undefined),
    referral: referral.trim(),
    notes: notes.trim(),
    adults: Number(adults),
    children: Number(children),
    room_type_id: roomTypeId,
    room_id: roomId,
    rate_plan_id: ratePlanId,
    preserve_rate_plan: !ratePlanTouched,
    check_in: checkIn,
    check_out: stayType === 'DAY_USE' ? checkIn : checkOut,
    stay_type: stayType,
    check_in_time: checkInTime,
    check_out_time: checkOutTime,
    is_manual_override: isOta ? true : isManualOverride,
    manual_override_price: (isOta || isManualOverride) ? Number(manualOverridePrice || 0) : undefined,
    manual_override_reason: isManualOverride ? manualOverrideReason.trim() : (isOta ? 'Tarif OTA Manual' : undefined),
    discount_type: computedDiscountAmount > 0 ? discountType : 'NONE',
    discount_value: computedDiscountAmount > 0 ? Number(discountValue || 0) : 0,
    discount_amount: computedDiscountAmount,
    discount_reason: computedDiscountAmount > 0 ? (discountReason.trim() || 'Diskon Reservasi') : '',
    property_id: propertyId
  });

  const getSaveRequestKey = () => {
    if (!saveRequestKeyRef.current) {
      saveRequestKeyRef.current = globalThis.crypto?.randomUUID?.()
        || `edit-${reservation.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    return saveRequestKeyRef.current;
  };

  // Gate Check Validation
  const gateCheckErrors: string[] = [];
  if (!guestName.trim()) {
    gateCheckErrors.push('Nama tamu menginap wajib diisi');
  }
  if (!sameAsBooker && !bookerName.trim()) {
    gateCheckErrors.push('Nama pemesan (booker) wajib diisi');
  }
  if (channel === 'OTA' && !otaSourceId) {
    gateCheckErrors.push('Platform OTA wajib dipilih');
  }
  if (!roomTypeId || !roomId) {
    gateCheckErrors.push('Tipe kamar dan nomor kamar fisik wajib dipilih');
  }
  additionalRooms.forEach((ar, idx) => {
    if (!ar.roomTypeId || !ar.roomId) {
      gateCheckErrors.push(`Kamar ${idx + 2}: Tipe kamar dan nomor kamar fisik wajib dipilih`);
    }
    if (!ar.ratePlanId && !isOta) {
      gateCheckErrors.push(`Kamar ${idx + 2}: Rate plan wajib dipilih`);
    }
  });
  if (!isOta && isManualOverride && !manualOverrideReason.trim()) {
    gateCheckErrors.push('Alasan override harga manual wajib diisi');
  }
  if (computedDiscountAmount > 0 && !discountReason.trim()) {
    gateCheckErrors.push('Alasan diskon wajib diisi ketika diskon > 0');
  }
  if (effectiveNewPayment > 0 && !paymentMethod) {
    gateCheckErrors.push('Metode pembayaran wajib dipilih untuk nominal pembayaran > 0');
  }
  if (effectiveNewPayment > 0 && !buktiBayarFile) {
    gateCheckErrors.push('Bukti pembayaran wajib diunggah untuk nominal pembayaran > 0');
  }
  if (previewData?.room_overlap_conflict) {
    gateCheckErrors.push(previewData.overlap_message || 'Kamar bentrok dengan reservasi lain');
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reservation?.id) return;

    if (gateCheckErrors.length > 0) {
      setError(gateCheckErrors[0]);
      return;
    }

    await submitEditDecision(false);
  };

  async function submitEditDecision(keepCurrentPrice: boolean) {
    if (!reservation?.id || loading) return;
    try {
      setLoading(true);
      setError(null);

      // 1. Delete any removed existing non-room folio entries first
      for (const folioEntryId of removedFolioEntryIds) {
        const delRes = await safeFetchJson(
          `/api/stay-charges/folio-entry/${folioEntryId}?property_id=${propertyId}&reservation_id=${reservation.id}`,
          { method: 'DELETE' },
          'Gagal menghapus biaya tambahan',
          authFetch
        );
        if (!delRes.ok) {
          throw new Error(delRes.errorMessage || 'Gagal menghapus layanan tambahan');
        }
      }

      // 2. Post any newly added stay charges for Kamar 1
      for (const sc of pendingStayCharges) {
        const postRes = await safeFetchJson(
          `/api/stay-charges/post-charge`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              property_id: propertyId,
              reservation_id: Number(reservation.id),
              charge_type: sc.charge_type,
              rule_id: sc.rule_id || undefined,
              quantity: sc.quantity,
              unit_price: sc.unit_price,
              is_override: sc.is_override,
              override_amount: sc.override_amount,
              override_reason: sc.override_reason,
              note: sc.note,
              actor_name: actorName
            })
          },
          'Gagal menambahkan layanan tambahan',
          authFetch
        );
        if (!postRes.ok) {
          throw new Error(postRes.errorMessage || 'Gagal menambahkan layanan tambahan');
        }
      }

      // 3. Save reservation edit for Kamar 1
      const response = await authFetch(`/api/reservations/${reservation.id}/edit-with-payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': getSaveRequestKey()
        },
        body: JSON.stringify({
          ...buildEditPayload(),
          keep_current_price: keepCurrentPrice,
          expected_new_total: Number(previewData?.quote?.grand_total || grandTotal || 0)
        })
      });
      const data = await response.json();
      if (!response.ok || data.status === 'ERROR') {
        saveRequestKeyRef.current = null;
        throw new Error(data.message || 'Gagal menyimpan perubahan reservasi');
      }

      // 4. Add any extra rooms added via "+ Tambah Kamar"
      const bookingBid = String(reservation.bid || reservation.booking_number || '').trim();
      if (additionalRooms.length > 0 && bookingBid) {
        for (const extraRoom of additionalRooms) {
          const addRoomRes = await authFetch(
            `/api/bookings/${encodeURIComponent(bookingBid.toUpperCase())}/reservations`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                property_id: propertyId,
                room_id: extraRoom.roomId,
                rate_plan_id: extraRoom.ratePlanId,
                guest_name: guestName.trim(),
                guest_phone: guestPhone.trim() || null,
                guest_segment: guestSegment,
                check_in: extraRoom.checkIn,
                check_out: extraRoom.stayType === 'DAY_USE' ? extraRoom.checkIn : extraRoom.checkOut,
                stay_type: extraRoom.stayType,
                special_requests: notes.trim() || null,
                created_by: actorName || null,
                idempotency_key: `add-room-${reservation.id}-${extraRoom.tempId}`
              })
            }
          );
          const addRoomJson = await addRoomRes.json();
          if (!addRoomRes.ok || addRoomJson.status === 'ERROR') {
            throw new Error(addRoomJson.message || 'Gagal menambahkan kamar tambahan');
          }
          const createdResId = Number(addRoomJson.data?.reservation?.id);
          if (createdResId > 0 && extraRoom.stayCharges.length > 0) {
            for (const sc of extraRoom.stayCharges) {
              await safeFetchJson(
                `/api/stay-charges/post-charge`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    property_id: propertyId,
                    reservation_id: createdResId,
                    charge_type: sc.charge_type,
                    rule_id: sc.rule_id || undefined,
                    quantity: sc.quantity,
                    unit_price: sc.unit_price,
                    actor_name: actorName
                  })
                },
                'Gagal menambahkan layanan tambahan kamar baru',
                authFetch
              );
            }
          }
        }
      }

      // 5. Record payment if user entered Nominal Bayar > 0 in Section 5
      if (effectiveNewPayment > 0 && buktiBayarFile) {
        const payForm = new FormData();
        payForm.append('property_id', String(propertyId));
        payForm.append('amount', String(effectiveNewPayment));
        payForm.append('payment_method', paymentMethod || 'CASH');
        if (actorName) {
          payForm.append('actor_name_snapshot', actorName);
          payForm.append('created_by', actorName);
        }
        payForm.append('file', buktiBayarFile);

        const payEndpoint = paymentMode === 'ADVANCE_PAYMENT'
          ? `/api/reservations/${reservation.id}/deposits/receive`
          : `/api/reservations/${reservation.id}/payments`;
        const payRes = await authFetch(payEndpoint, {
          method: 'POST',
          body: payForm
        });
        const payJson = await payRes.json();
        if (!payRes.ok || payJson.status === 'ERROR') {
          throw new Error(payJson.message || 'Reservasi tersimpan, namun pencatatan pembayaran gagal.');
        }
      }

      setShowDecreaseModal(false);
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Terjadi kesalahan saat menyimpan reservasi');
    } finally {
      setLoading(false);
    }
  }

  if (!isOpen) return null;

  const filteredRatePlans = ratePlans.filter((rp) => {
    if (!roomTypeId || Number(rp.room_type_id) !== Number(roomTypeId)) return false;
    if (rp.is_active === false || rp.is_archived === true) return false;
    return stayType === 'DAY_USE' ? rp.rate_type === 'DAY_USE' : rp.rate_type !== 'DAY_USE';
  });

  const selectedRoomObj = availableRooms.find((r: any) => Number(r.id) === Number(roomId));
  const selectedRoomLabel = selectedRoomObj
    ? `${selectedRoomObj.room_number} (${selectedAvailableType?.name || ''}${selectedAvailableType?.code ? ` (${selectedAvailableType.code})` : ''})`
    : `${reservation?.room_number || '-'} (${reservation?.room_type_name || 'Kamar'})`;

  const bidLabel = reservation?.bid || reservation?.booking_number || `#${reservation?.id}`;
  const totalRoomsCount = 1 + additionalRooms.length;
  const selectedOtaSourceName = otaSources.find((o) => Number(o.id) === Number(otaSourceId))?.name || 'OTA';

  return ReactDOM.createPortal(
    <div
      data-portal-overlay="reservation-edit"
      className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4 overflow-y-auto"
    >
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-7xl border border-emerald-900/15 overflow-hidden flex flex-col max-h-[94vh]">
        {/* Header — Identical to Reservasi (QuickBookingModal) */}
        <div className="px-6 py-4 bg-gradient-to-r from-emerald-950 via-emerald-900 to-teal-950 text-white flex items-center justify-between border-b border-emerald-800/40 shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-800/60 rounded-xl border border-emerald-700/50">
              <svg className="w-5 h-5 text-emerald-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-lg font-bold tracking-tight text-white">
                  Reservasi
                </h2>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-700/80 text-emerald-100 font-semibold border border-emerald-600/50">
                  Multi-Kamar
                </span>
                <span className="px-2 py-0.5 text-[11px] font-bold bg-emerald-800/90 text-emerald-200 rounded-full border border-emerald-600/60 font-mono">
                  Edit {bidLabel}
                </span>
              </div>
              <p className="text-xs text-emerald-300/80">
                Input reservasi satu atau banyak kamar dengan validasi dokumen &amp; pembayaran
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="text-emerald-300 hover:text-white p-2 rounded-lg hover:bg-emerald-800/40 transition-colors cursor-pointer"
            aria-label="Tutup"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Error Banner */}
        {error && (
          <div className="mx-6 mt-3 p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-xs font-semibold flex items-center justify-between shrink-0">
            <span>⚠️ {error}</span>
            <button type="button" onClick={() => setError(null)} className="text-rose-500 hover:text-rose-700 font-bold ml-3 cursor-pointer">
              ✕
            </button>
          </div>
        )}

        {/* Main 2-Column Body (70% Left / 30% Right) */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-hidden grid grid-cols-1 lg:grid-cols-12 bg-stone-100/60 divide-y lg:divide-y-0 lg:divide-x divide-stone-200 text-xs">
          {/* LEFT 70% PANEL */}
          <div className="lg:col-span-8 p-6 overflow-y-auto space-y-6">
            {/* SEKSI 1: SUMBER RESERVASI (BOOKING SOURCE) */}
            <div className="bg-white p-5 rounded-2xl border border-stone-200/80 shadow-xs space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-950 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-700" />
                  1. Sumber Reservasi (Booking Source)
                </h3>
                {channel === 'OTA' && (
                  <button
                    type="button"
                    onClick={() => setIsOtaModalOpen(true)}
                    className="text-xs font-semibold text-emerald-800 hover:text-emerald-950 flex items-center gap-1 cursor-pointer"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    Kelola Master OTA
                  </button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2 p-1 bg-stone-100 rounded-xl">
                <button
                  type="button"
                  onClick={() => {
                    setChannel('WALKIN');
                    setOtaSourceId(null);
                    setPaymentResponsibility('HOTEL_COLLECT');
                  }}
                  className={`h-9 px-3 flex items-center justify-center gap-2 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                    channel === 'WALKIN'
                      ? 'bg-emerald-800 text-white shadow-sm'
                      : 'text-stone-600 hover:text-stone-900'
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  WALK-IN / DIRECT
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setChannel('OTA');
                    if (!otaSourceId && otaSources.length > 0) {
                      setOtaSourceId(Number(otaSources[0].id));
                    }
                    if (!manualOverridePrice && quotedRoomSubtotal > 0) {
                      setManualOverridePrice(Math.round(quotedRoomSubtotal));
                    }
                  }}
                  className={`h-9 px-3 flex items-center justify-center gap-2 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                    channel === 'OTA'
                      ? 'bg-emerald-800 text-white shadow-sm'
                      : 'text-stone-600 hover:text-stone-900'
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H12M3 12a9 9 0 019-9m-9 9h9m9 0a9 9 0 01-9 9m9-9H12" />
                  </svg>
                  OTA
                </button>
              </div>

              {channel === 'WALKIN' ? (
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      { key: 'FRONT_DESK', label: 'Resepsionis / Langsung' },
                      { key: 'PHONE', label: 'Telepon / WhatsApp' },
                      { key: 'WEB', label: 'Website Hotel' }
                    ] as const
                  ).map((sub) => (
                    <button
                      key={sub.key}
                      type="button"
                      onClick={() => setWalkinSubSource(sub.key)}
                      className={`p-2.5 rounded-xl text-xs font-semibold border transition-all text-center cursor-pointer ${
                        walkinSubSource === sub.key
                          ? 'bg-emerald-50 border-emerald-600 text-emerald-950 font-bold'
                          : 'bg-stone-50 border-stone-200 text-stone-600 hover:bg-stone-100'
                      }`}
                    >
                      {sub.label}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Pilih Platform OTA <span className="text-rose-500">*</span>
                    </label>
                    <select
                      value={otaSourceId || ''}
                      onChange={(e) => setOtaSourceId(Number(e.target.value) || null)}
                      className="w-full text-xs px-3 py-2.5 bg-stone-50 border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
                    >
                      <option value="">Pilih Platform OTA...</option>
                      {otaSources.map((ota: any) => (
                        <option key={ota.id} value={ota.id}>
                          {ota.name} {ota.commission_rate_percent ? `(Komisi ${ota.commission_rate_percent}%)` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Nomor Booking OTA / Referral
                    </label>
                    <input
                      type="text"
                      value={referral}
                      onChange={(e) => setReferral(e.target.value)}
                      placeholder="Contoh: BKG-987214"
                      className="w-full text-xs px-3.5 py-2.5 bg-stone-50 border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none font-mono"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* SEKSI 2: DATA PEMESAN & TAMU MENGINAP */}
            <div className="bg-white p-5 rounded-2xl border border-stone-200/80 shadow-xs space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-950 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-700" />
                  2. Data Pemesan &amp; Tamu Menginap
                </h3>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={sameAsBooker}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setSameAsBooker(checked);
                      if (checked) {
                        setBookerName(guestName);
                        setBookerPhone(guestPhone);
                      }
                    }}
                    className="w-4 h-4 rounded text-emerald-700 focus:ring-emerald-600 border-stone-300"
                  />
                  <span className="text-xs font-semibold text-stone-700">Pemesan adalah Tamu Menginap</span>
                </label>
              </div>

              {!sameAsBooker && (
                <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 space-y-3">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-stone-500">
                    Data Pemesan (Booker)
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-stone-700 mb-1">
                        Nama Pemesan <span className="text-rose-500">*</span>
                      </label>
                      <input
                        type="text"
                        required
                        value={bookerName}
                        onChange={(e) => {
                          setBookerName(e.target.value);
                          if (selectedBookerGuest) setSelectedBookerGuest(null);
                        }}
                        placeholder="Nama lengkap pemesan..."
                        className="w-full text-xs px-3.5 py-2.5 bg-white border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-stone-700 mb-1">
                        Nomor HP Pemesan <span className="text-stone-400 font-normal ml-1">(opsional)</span>
                      </label>
                      <input
                        type="tel"
                        value={bookerPhone}
                        onChange={(e) => setBookerPhone(e.target.value)}
                        placeholder="08xxxxxxxxxx"
                        className="w-full text-xs px-3.5 py-2.5 bg-white border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 outline-none font-mono"
                      />
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-3">
                <span className="text-[11px] font-bold uppercase tracking-wider text-stone-500 block">
                  Tamu Menginap (Staying Guest)
                </span>

                <div className="sm:col-span-2">
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Nama Tamu Menginap<span className="text-rose-500">*</span>
                  </label>
                  <GuestSearchAutocomplete
                    propertyId={propertyId}
                    value={guestName}
                    onChange={(name) => {
                      setGuestName(name);
                      setGuestNameTouched(true);
                      setIdentityConfirmedGuestId(null);
                      if (selectedGuest) setSelectedGuest(null);
                      if (sameAsBooker) setBookerName(name);
                    }}
                    onSelectGuest={(guest) => {
                      setSelectedGuest(guest);
                      setGuestNameTouched(false);
                      setGuestName(guest.full_name);
                      setGuestPhone(guest.phone || '');
                      setIdentityConfirmedGuestId(null);
                      if (sameAsBooker) {
                        setBookerName(guest.full_name);
                        setBookerPhone(guest.phone || '');
                      }
                    }}
                    onClearGuest={() => {
                      setSelectedGuest(null);
                      setGuestNameTouched(true);
                      setIdentityConfirmedGuestId(null);
                    }}
                    selectedGuest={selectedGuest}
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Nomor HP Tamu <span className="text-stone-400 font-normal ml-1">(opsional)</span>
                    </label>
                    <input
                      type="tel"
                      value={guestPhone}
                      onChange={(e) => {
                        setGuestPhone(e.target.value);
                        if (sameAsBooker) setBookerPhone(e.target.value);
                      }}
                      placeholder="08xxxxxxxxxx"
                      className="w-full text-xs px-3.5 py-2.5 bg-stone-50 border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none font-mono"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Segmentasi Tamu
                  </label>
                  <div className="flex gap-2">
                    {(['Reguler', 'Corporate', 'Group'] as const).map((seg) => (
                      <button
                        key={seg}
                        type="button"
                        onClick={() => setGuestSegment(seg)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all cursor-pointer ${
                          guestSegment === seg
                            ? 'bg-emerald-800 text-white border-emerald-900'
                            : 'bg-stone-50 text-stone-600 border-stone-200 hover:bg-stone-100'
                        }`}
                      >
                        {seg}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* SEKSI 3: DOKUMEN IDENTITAS TAMU (KTP) */}
            <div className="bg-white p-5 rounded-2xl border border-stone-200/80 shadow-xs space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-950 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-700" />
                  3. Dokumen Identitas Tamu (KTP)
                  <span className="text-stone-400 font-normal ml-1">(opsional)</span>
                </h3>
                {hasKtpVerified && (
                  <span className="text-[11px] px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold border border-emerald-200">
                    ✓ Terverifikasi
                  </span>
                )}
              </div>

              {hasKtpVerified ? (
                <div className="p-4 bg-emerald-50/50 rounded-xl border border-emerald-200 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-emerald-800 text-white rounded-lg">
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <div>
                      <div className="text-xs font-bold text-emerald-950">
                        Dokumen KTP Tersimpan
                      </div>
                      <p className="text-[11px] text-emerald-800 font-mono">
                        NIK: {currentNik || '—'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setIdentityModalMode('DETAIL');
                        setShowIdentityModal(true);
                      }}
                      className="text-xs text-emerald-800 underline font-semibold hover:text-emerald-950 cursor-pointer"
                    >
                      Detail
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIdentityModalMode('UPLOAD');
                        setShowIdentityModal(true);
                      }}
                      className="px-3 py-1.5 bg-emerald-800 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold shadow-2xs transition-colors cursor-pointer"
                    >
                      Ganti KTP
                    </button>
                  </div>
                </div>
              ) : (
                <div className="p-4 rounded-xl border-2 border-dashed border-stone-300 text-center space-y-2 bg-stone-50/50">
                  <p className="text-xs text-stone-500">
                    Wajib melampirkan foto KTP atau memilih tamu yang sudah memiliki KTP tersimpan.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setIdentityModalMode('UPLOAD');
                      setShowIdentityModal(true);
                    }}
                    className="px-4 py-2 bg-emerald-800 hover:bg-emerald-700 text-white rounded-xl text-xs font-semibold shadow-sm transition-colors cursor-pointer"
                  >
                    Unggah KTP Sekarang
                  </button>
                </div>
              )}
            </div>

            {/* SEKSI 4: DAFTAR KAMAR RESERVASI (MULTI-ROOM SUPPORT) */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-950 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-700" />
                  4. Daftar Kamar Reservasi ({totalRoomsCount} Kamar)
                </h3>
                <button
                  type="button"
                  onClick={handleAddExtraRoom}
                  className="px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-300 rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-2xs transition-all cursor-pointer"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  + Tambah Kamar
                </button>
              </div>

              {/* KAMAR 1 (Primary Reservation Being Edited) */}
              <div className="bg-white p-5 rounded-2xl border border-stone-200/90 shadow-xs space-y-4">
                {/* Room Card Header */}
                <div className="flex items-center justify-between pb-3 border-b border-stone-100">
                  <div className="flex items-center gap-2">
                    <span className="px-2.5 py-1 bg-emerald-900 text-emerald-100 text-xs font-bold rounded-lg uppercase tracking-wider">
                      Kamar 1
                    </span>
                    <span className="text-xs text-stone-500 font-medium">
                      {selectedAvailableType?.name || reservation?.room_type_name || 'Pilih Tipe Kamar'}
                      {selectedAvailableType?.code ? ` (${selectedAvailableType.code})` : ''} • {selectedRoomObj?.room_number || reservation?.room_number || 'Belum Pilih Kamar'}
                    </span>
                  </div>
                </div>

                {/* Waktu & Durasi Menginap */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-stone-500">
                      Waktu &amp; Durasi Menginap
                    </span>
                    <div className="flex items-center gap-1 p-0.5 bg-stone-100 rounded-lg text-xs font-semibold">
                      <button
                        type="button"
                        onClick={() => setStayType('OVERNIGHT')}
                        className={`px-2.5 py-1 rounded-md transition-all cursor-pointer ${
                          stayType === 'OVERNIGHT'
                            ? 'bg-white text-emerald-950 shadow-xs font-bold'
                            : 'text-stone-600'
                        }`}
                      >
                        Menginap
                      </button>
                      <button
                        type="button"
                        onClick={() => setStayType('DAY_USE')}
                        className={`px-2.5 py-1 rounded-md transition-all cursor-pointer ${
                          stayType === 'DAY_USE'
                            ? 'bg-white text-emerald-950 shadow-xs font-bold'
                            : 'text-stone-600'
                        }`}
                      >
                        Day Use
                      </button>
                    </div>
                  </div>

                  {stayType === 'OVERNIGHT' ? (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                          Check-in Date <span className="text-rose-500">*</span>
                        </label>
                        <input
                          type="date"
                          required
                          value={checkIn}
                          onChange={(e) => setCheckIn(e.target.value)}
                          className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                          Check-out Date <span className="text-rose-500">*</span>
                        </label>
                        <input
                          type="date"
                          required
                          min={checkIn}
                          value={checkOut}
                          onChange={(e) => setCheckOut(e.target.value)}
                          className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                          Durasi
                        </label>
                        <div className="w-full text-xs px-3 py-2 bg-stone-100 border border-stone-200 rounded-xl font-bold text-stone-700">
                          {stayNights} Malam
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                          Tanggal Day Use <span className="text-rose-500">*</span>
                        </label>
                        <input
                          type="date"
                          required
                          value={checkIn}
                          onChange={(e) => {
                            setCheckIn(e.target.value);
                            setCheckOut(e.target.value);
                          }}
                          className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                          Jam Mulai (Interval 15 mnt)
                        </label>
                        <input
                          type="time"
                          step={900}
                          value={checkInTime}
                          onChange={(e) => setCheckInTime(e.target.value)}
                          className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                          Jam Keluar
                        </label>
                        <input
                          type="time"
                          value={checkOutTime}
                          onChange={(e) => setCheckOutTime(e.target.value)}
                          className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl font-mono"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Tipe Kamar, Nomor Kamar & Rate Plan */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-stone-100">
                  <div>
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Tipe Kamar <span className="text-rose-500">*</span>
                    </label>
                    <select
                      required
                      value={roomTypeId || ''}
                      onChange={(e) => {
                        const newTypeId = Number(e.target.value) || null;
                        setRoomTypeId(newTypeId);
                        setRatePlanTouched(true);
                        const nextType = availableRoomTypes?.find((type) => Number(type.id) === Number(newTypeId));
                        setRoomId(nextType?.rooms?.length ? Number(nextType.rooms[0].id) : null);
                        const compatible = ratePlans.filter(
                          (rp) =>
                            newTypeId &&
                            Number(rp.room_type_id) === newTypeId &&
                            rp.is_active !== false &&
                            rp.is_archived !== true
                        );
                        const preferred = compatible.find((rp) =>
                          stayType === 'DAY_USE' ? rp.rate_type === 'DAY_USE' : rp.rate_type !== 'DAY_USE'
                        );
                        setRatePlanId(preferred?.id || compatible[0]?.id || null);
                      }}
                      className="w-full text-xs px-3 py-2.5 bg-stone-50 border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 outline-none"
                    >
                      <option value="">-- Pilih tipe kamar --</option>
                      {(availableRoomTypes || []).map((rt) => (
                        <option key={rt.id} value={rt.id}>
                          {rt.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Pilih Nomor Kamar <span className="text-rose-500">*</span>
                    </label>
                    <select
                      required
                      value={roomId || ''}
                      onChange={(e) => setRoomId(Number(e.target.value) || null)}
                      disabled={availabilityLoading || !roomTypeId || availableRooms.length === 0}
                      className="w-full text-xs px-3 py-2.5 bg-stone-50 border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 outline-none disabled:bg-stone-100"
                    >
                      <option value="">
                        {availabilityLoading
                          ? 'Memuat kamar tersedia...'
                          : availableRooms.length === 0
                            ? 'Tidak ada kamar tersedia'
                            : '-- Pilih nomor kamar --'}
                      </option>
                      {availableRooms.map((r: any) => (
                        <option key={r.id} value={r.id}>
                          Kamar {r.room_number} {selectedAvailableType?.name ? `(${selectedAvailableType.name})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>

                  {!isOta && (
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-semibold text-stone-700 mb-1">
                        Rate Plan / Paket Harga {stayType === 'DAY_USE' ? '(Khusus Day Use)' : ''} <span className="text-rose-500">*</span>
                      </label>
                      <select
                        value={ratePlanId || ''}
                        onChange={(e) => {
                          setRatePlanId(Number(e.target.value) || null);
                          setRatePlanTouched(true);
                        }}
                        className="w-full text-xs px-3 py-2.5 bg-stone-50 border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 outline-none"
                      >
                        {filteredRatePlans.length === 0 && (
                          <option value="">
                            {stayType === 'DAY_USE'
                              ? 'Tidak ada Paket Day Use untuk Tipe Kamar ini'
                              : 'Tarif Standar / Reguler'}
                          </option>
                        )}
                        {filteredRatePlans.map((rp) => (
                          <option key={rp.id} value={rp.id}>
                            {rp.name} ({rp.code}) {rp.meal_plan_name ? `• ${rp.meal_plan_name}` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>

                {/* Pricing Quote & Override */}
                <div className={`p-3.5 rounded-xl border space-y-2.5 ${channel === 'OTA' ? 'bg-amber-50/70 border-amber-200' : 'bg-stone-50 border-stone-200'}`}>
                  {isOta ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-amber-950 flex items-center gap-1.5">
                            Total Harga Kamar OTA
                          </span>
                          <span className="text-[10px] bg-amber-200/80 text-amber-900 px-2 py-0.5 rounded font-semibold">
                            Wajib Sesuai Voucher
                          </span>
                        </div>
                        <span className="text-[11px] text-amber-800 font-medium">
                          Total Net / Voucher
                        </span>
                      </div>
                      <div className="pt-1 border-t border-amber-200/60">
                        <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                          Total Harga Kamar OTA (Rp) <span className="text-rose-500">*</span>
                        </label>
                        <input
                          type="number"
                          min={0}
                          value={manualOverridePrice}
                          onChange={(e) => setManualOverridePrice(Math.max(0, Number(e.target.value)))}
                          className="w-full text-xs px-3 py-2 bg-white border border-amber-300 focus:border-amber-500 focus:ring-1 focus:ring-amber-500 rounded-lg font-mono font-bold text-stone-900"
                        />
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="text-[11px] text-stone-500">Tarif Kamar Terkalkulasi (per Malam):</span>
                          <div className="text-sm font-bold text-emerald-950 font-mono">
                            {previewLoading ? 'Menghitung...' : `Rp ${(isManualOverride ? manualOverridePrice : roomNightlyRate).toLocaleString('id-ID')}`}
                          </div>
                        </div>
                        <label className="flex items-center gap-2 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={isManualOverride}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setIsManualOverride(checked);
                              if (checked && !manualOverridePrice) {
                                setManualOverridePrice(roomNightlyRate);
                              }
                            }}
                            className="w-3.5 h-3.5 rounded text-emerald-700 focus:ring-emerald-600 border-stone-300"
                          />
                          <span className="text-xs font-semibold text-stone-700">Override Harga Manual</span>
                        </label>
                      </div>

                      {isManualOverride && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-2 border-t border-stone-200">
                          <div>
                            <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                              Harga Kamar Manual per Malam (Rp) <span className="text-rose-500">*</span>
                            </label>
                            <input
                              type="number"
                              min={0}
                              step={1000}
                              value={manualOverridePrice}
                              onChange={(e) => setManualOverridePrice(Math.max(0, Number(e.target.value)))}
                              className="w-full text-xs px-3 py-2 bg-white border border-stone-300 rounded-lg font-mono font-bold"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                              Alasan Override <span className="text-rose-500">*</span>
                            </label>
                            <input
                              type="text"
                              value={manualOverrideReason}
                              onChange={(e) => setManualOverrideReason(e.target.value)}
                              placeholder="Contoh: Diskon Direksi, Kompensasi..."
                              className="w-full text-xs px-3 py-2 bg-white border border-stone-300 rounded-lg"
                            />
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Layanan Tambahan & Denda */}
                <div className="space-y-2.5 pt-2 border-t border-stone-100">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-stone-600">
                      Layanan Tambahan &amp; Denda
                    </span>
                    {(activeExistingCharges.length + pendingStayCharges.length) > 0 && (
                      <span className="text-[11px] font-bold text-emerald-800 bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-200">
                        {activeExistingCharges.length + pendingStayCharges.length} item dipilih
                      </span>
                    )}
                  </div>

                  <StayChargePickerCombobox
                    rules={stayChargeRules}
                    onSelectRule={handleAddStayChargeFromRule}
                    placeholder="Cari Extra Bed, Late Check-out, Denda Merokok, dll"
                    label="Tambah layanan atau denda"
                  />

                  {(activeExistingCharges.length > 0 || pendingStayCharges.length > 0) && (
                    <div className="space-y-2 pt-1">
                      {activeExistingCharges.map((item) => (
                        <div
                          key={`existing-${item.id}`}
                          className="p-2.5 bg-stone-50 hover:bg-stone-100/70 rounded-xl border border-stone-200 text-xs transition-colors flex items-center justify-between gap-2"
                        >
                          <div className="min-w-0 pr-2">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-semibold text-stone-900 truncate">{item.description}</span>
                              <span className="px-1.5 py-0.2 bg-emerald-100 text-emerald-800 text-[10px] font-bold rounded">
                                Layanan
                              </span>
                            </div>
                            <div className="text-[10px] text-stone-500 mt-0.5 font-mono">
                              Rp {item.unit_price.toLocaleString('id-ID')} / unit
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <div className="flex items-center border border-stone-300 rounded-lg bg-white overflow-hidden shadow-2xs">
                              <span className="px-2.5 py-1 text-center text-xs font-semibold font-mono">{item.quantity}</span>
                            </div>
                            <span className="font-mono font-bold text-stone-900 text-right min-w-[75px]">
                              Rp {item.amount.toLocaleString('id-ID')}
                            </span>
                            <button
                              type="button"
                              onClick={() => setRemovedFolioEntryIds((prev) => [...prev, item.id])}
                              title="Hapus item"
                              className="p-1 text-stone-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))}

                      {pendingStayCharges.map((sc) => (
                        <div
                          key={sc.tempId}
                          className="p-2.5 bg-stone-50 hover:bg-stone-100/70 rounded-xl border border-stone-200 text-xs transition-colors flex items-center justify-between gap-2"
                        >
                          <div className="min-w-0 pr-2">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-semibold text-stone-900 truncate">{sc.name}</span>
                              <span className="px-1.5 py-0.2 bg-emerald-100 text-emerald-800 text-[10px] font-bold rounded">
                                Layanan
                              </span>
                            </div>
                            <div className="text-[10px] text-stone-500 mt-0.5 font-mono">
                              Rp {sc.unit_price.toLocaleString('id-ID')} / unit
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <div className="flex items-center border border-stone-300 rounded-lg bg-white overflow-hidden shadow-2xs">
                              <button
                                type="button"
                                disabled={sc.quantity <= 1}
                                onClick={() =>
                                  setPendingStayCharges((prev) =>
                                    prev.map((p) =>
                                      p.tempId === sc.tempId
                                        ? { ...p, quantity: Math.max(1, p.quantity - 1), amount: p.unit_price * Math.max(1, p.quantity - 1) }
                                        : p
                                    )
                                  )
                                }
                                className="px-2 py-1 text-stone-600 hover:bg-stone-100 disabled:opacity-40 disabled:cursor-not-allowed font-bold text-xs cursor-pointer"
                              >
                                -
                              </button>
                              <span className="w-7 text-center text-xs font-semibold font-mono">{sc.quantity}</span>
                              <button
                                type="button"
                                onClick={() =>
                                  setPendingStayCharges((prev) =>
                                    prev.map((p) =>
                                      p.tempId === sc.tempId
                                        ? { ...p, quantity: p.quantity + 1, amount: p.unit_price * (p.quantity + 1) }
                                        : p
                                    )
                                  )
                                }
                                className="px-2 py-1 text-stone-600 hover:bg-stone-100 font-bold text-xs cursor-pointer"
                              >
                                +
                              </button>
                            </div>
                            <span className="font-mono font-bold text-stone-900 text-right min-w-[75px]">
                              Rp {sc.amount.toLocaleString('id-ID')}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                setPendingStayCharges((prev) => prev.filter((p) => p.tempId !== sc.tempId))
                              }
                              title="Hapus item"
                              className="p-1 text-stone-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* ADDITIONAL ROOMS (Kamar 2, 3, ...) */}
              {additionalRooms.map((ar, idx) => {
                const arCalc = additionalRoomsCalcs[idx];
                const arTypeObj = (availableRoomTypes || []).find((rt) => Number(rt.id) === Number(ar.roomTypeId));
                const arRooms = arTypeObj?.rooms || [];
                const arPlans = ratePlans.filter((rp) => {
                  if (!ar.roomTypeId || Number(rp.room_type_id) !== Number(ar.roomTypeId)) return false;
                  if (rp.is_active === false || rp.is_archived === true) return false;
                  return ar.stayType === 'DAY_USE' ? rp.rate_type === 'DAY_USE' : rp.rate_type !== 'DAY_USE';
                });

                return (
                  <div
                    key={ar.tempId}
                    className="bg-white p-5 rounded-2xl border border-stone-200/90 shadow-xs space-y-4"
                  >
                    <div className="flex items-center justify-between pb-3 border-b border-stone-100">
                      <div className="flex items-center gap-2">
                        <span className="px-2.5 py-1 bg-emerald-900 text-emerald-100 text-xs font-bold rounded-lg uppercase tracking-wider">
                          Kamar {idx + 2}
                        </span>
                        <span className="text-xs text-stone-500 font-medium">
                          {arCalc?.roomTypeName} {arCalc?.roomTypeCode ? `(${arCalc.roomTypeCode})` : ''} • {arCalc?.roomNumber}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveExtraRoom(ar.tempId)}
                        className="text-xs text-rose-700 hover:text-rose-900 font-semibold flex items-center gap-1 cursor-pointer"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                        Hapus
                      </button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                          Check-in Date <span className="text-rose-500">*</span>
                        </label>
                        <input
                          type="date"
                          required
                          value={ar.checkIn}
                          onChange={(e) => handleUpdateExtraRoom(ar.tempId, { checkIn: e.target.value })}
                          className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                          Check-out Date <span className="text-rose-500">*</span>
                        </label>
                        <input
                          type="date"
                          required
                          min={ar.checkIn}
                          value={ar.checkOut}
                          onChange={(e) => handleUpdateExtraRoom(ar.tempId, { checkOut: e.target.value })}
                          className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                          Durasi
                        </label>
                        <div className="w-full text-xs px-3 py-2 bg-stone-100 border border-stone-200 rounded-xl font-bold text-stone-700">
                          {arCalc?.nights || 1} Malam
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-stone-100">
                      <div>
                        <label className="block text-xs font-semibold text-stone-700 mb-1">
                          Tipe Kamar <span className="text-rose-500">*</span>
                        </label>
                        <select
                          value={ar.roomTypeId || ''}
                          onChange={(e) => {
                            const nextTypeId = Number(e.target.value) || null;
                            const nextType = (availableRoomTypes || []).find((rt) => Number(rt.id) === Number(nextTypeId));
                            const nextRoomId = nextType?.rooms?.[0]?.id ? Number(nextType.rooms[0].id) : null;
                            const nextPlans = ratePlans.filter(
                              (rp) => nextTypeId && Number(rp.room_type_id) === Number(nextTypeId) && rp.is_active !== false && rp.is_archived !== true
                            );
                            handleUpdateExtraRoom(ar.tempId, {
                              roomTypeId: nextTypeId,
                              roomId: nextRoomId,
                              ratePlanId: nextPlans[0]?.id ? Number(nextPlans[0].id) : null
                            });
                          }}
                          className="w-full text-xs px-3 py-2.5 bg-stone-50 border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 outline-none"
                        >
                          <option value="">-- Pilih tipe kamar --</option>
                          {(availableRoomTypes || []).map((rt) => (
                            <option key={rt.id} value={rt.id}>
                              {rt.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-stone-700 mb-1">
                          Pilih Nomor Kamar <span className="text-rose-500">*</span>
                        </label>
                        <select
                          value={ar.roomId || ''}
                          onChange={(e) => handleUpdateExtraRoom(ar.tempId, { roomId: Number(e.target.value) || null })}
                          className="w-full text-xs px-3 py-2.5 bg-stone-50 border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 outline-none"
                        >
                          <option value="">-- Pilih nomor kamar --</option>
                          {arRooms.map((r: any) => (
                            <option key={r.id} value={r.id}>
                              Kamar {r.room_number} {arTypeObj?.name ? `(${arTypeObj.name})` : ''}
                            </option>
                          ))}
                        </select>
                      </div>

                      {!isOta && (
                        <div className="sm:col-span-2">
                          <label className="block text-xs font-semibold text-stone-700 mb-1">
                            Rate Plan / Paket Harga <span className="text-rose-500">*</span>
                          </label>
                          <select
                            value={ar.ratePlanId || ''}
                            onChange={(e) => handleUpdateExtraRoom(ar.tempId, { ratePlanId: Number(e.target.value) || null })}
                            className="w-full text-xs px-3 py-2.5 bg-stone-50 border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 outline-none"
                          >
                            {arPlans.map((rp) => (
                              <option key={rp.id} value={rp.id}>
                                {rp.name} ({rp.code}) {rp.meal_plan_name ? `• ${rp.meal_plan_name}` : ''}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>

                    <div className="space-y-2.5 pt-2 border-t border-stone-100">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-stone-600 block">
                        Layanan Tambahan &amp; Denda
                      </span>
                      <StayChargePickerCombobox
                        rules={stayChargeRules}
                        onSelectRule={(rule) => handleAddStayChargeToExtraRoom(ar.tempId, rule, idx)}
                        placeholder="Cari Extra Bed, Late Check-out, Denda Merokok, dll"
                        label="Tambah layanan atau denda"
                      />
                    </div>
                  </div>
                );
              })}

              {/* Dashed "+ Tambah Kamar (N)" Button below room cards — Identical to Gambar 2 */}
              <button
                type="button"
                onClick={handleAddExtraRoom}
                className="w-full py-3 border-2 border-dashed border-emerald-700/40 hover:border-emerald-700 bg-emerald-50/50 hover:bg-emerald-50 text-emerald-900 rounded-2xl text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                + Tambah Kamar ({totalRoomsCount + 1})
              </button>
            </div>

            {/* SEKSI 5: PEMBAYARAN & BUKTI BAYAR — Identical to Gambar 2 */}
            <div className="bg-white p-5 rounded-2xl border border-stone-200/80 shadow-xs space-y-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-950 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-700" />
                5. Pembayaran &amp; Bukti Bayar
              </h3>

              {channel === 'OTA' && (
                <div className="p-4 bg-amber-50 rounded-xl border border-amber-200 space-y-2">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-amber-800 block">
                    Skema Pembayaran OTA
                  </span>
                  <div className="flex gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={() => setPaymentResponsibility('HOTEL_COLLECT')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all cursor-pointer flex items-center justify-center gap-2 ${
                        paymentResponsibility === 'HOTEL_COLLECT'
                          ? 'bg-emerald-800 text-white border-emerald-900'
                          : 'bg-white text-stone-600 border-amber-300 hover:bg-amber-50'
                      }`}
                    >
                      Hotel Collect — Tamu bayar ke hotel
                    </button>
                    <button
                      type="button"
                      onClick={() => setPaymentResponsibility('OTA_COLLECT')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all cursor-pointer flex items-center justify-center gap-2 ${
                        paymentResponsibility === 'OTA_COLLECT'
                          ? 'bg-amber-700 text-white border-amber-800'
                          : 'bg-white text-stone-600 border-amber-300 hover:bg-amber-50'
                      }`}
                    >
                      OTA Collect — Tamu sudah bayar ke OTA
                    </button>
                  </div>
                  {paymentResponsibility === 'OTA_COLLECT' && (
                    <p className="text-[11px] text-amber-800 font-medium">
                      Tamu sudah membayar seluruh tagihan ke {selectedOtaSourceName}.
                    </p>
                  )}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">
                  Pilihan Pembayaran
                </label>
                <select
                  value={paymentMode}
                  disabled={channel === 'OTA' && paymentResponsibility === 'OTA_COLLECT'}
                  onChange={(e) => {
                    const nextMode = e.target.value as 'PAY_BILL' | 'ADVANCE_PAYMENT' | 'UNPAID';
                    setPaymentMode(nextMode);
                    if (nextMode === 'UNPAID') {
                      setNewPaymentAmount(0);
                      setBuktiBayarFile(null);
                    }
                  }}
                  className="w-full text-xs px-3.5 py-2.5 bg-stone-50 border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 outline-none"
                >
                  <option value="PAY_BILL">Bayar Tagihan</option>
                  <option value="ADVANCE_PAYMENT">Uang Muka (DP)</option>
                  <option value="UNPAID">Belum Bayar</option>
                </select>
              </div>

              {!(channel === 'OTA' && paymentResponsibility === 'OTA_COLLECT') && paymentMode !== 'UNPAID' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <div>
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Metode Pembayaran <span className="text-stone-400 font-normal ml-1">(opsional)</span>
                    </label>
                    <select
                      value={paymentMethod}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                      className="w-full text-xs px-3.5 py-2.5 bg-stone-50 border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
                    >
                      <option value="">— Pilih Metode Pembayaran —</option>
                      <option value="CASH">💵 Tunai (Cash)</option>
                      <option value="TRANSFER">🏦 Transfer Bank</option>
                      <option value="QRIS">📱 QRIS / E-Wallet</option>
                      <option value="DEBIT_CARD">💳 Kartu Debit</option>
                      <option value="CREDIT_CARD">💳 Kartu Kredit</option>
                    </select>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-semibold text-stone-700">
                        {paymentMode === 'ADVANCE_PAYMENT' ? 'Nominal Uang Muka (DP)' : 'Nominal Bayar Tagihan'}
                        <span className="text-stone-400 font-normal ml-1">(opsional)</span>
                      </label>
                      {paymentMode === 'PAY_BILL' && (
                        <button
                          type="button"
                          onClick={() => setNewPaymentAmount(Math.max(0, grandTotal - amountPaid - appliedDeposit))}
                          className="text-[10px] font-bold text-emerald-800 hover:text-emerald-950 bg-emerald-50 hover:bg-emerald-100 px-2 py-0.5 rounded-lg border border-emerald-200 cursor-pointer transition-colors"
                        >
                          Bayar Penuh (Rp {Math.max(0, grandTotal - amountPaid - appliedDeposit).toLocaleString('id-ID')})
                        </button>
                      )}
                    </div>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={newPaymentAmount}
                      onChange={(e) => setNewPaymentAmount(Math.max(0, Number(e.target.value)))}
                      className="w-full text-xs px-3.5 py-2.5 bg-stone-50 border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none font-mono font-bold text-emerald-950"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Upload Bukti Pembayaran{' '}
                      {effectiveNewPayment > 0 ? (
                        <span className="text-rose-500">*</span>
                      ) : (
                        <span className="text-stone-400 font-normal">(opsional)</span>
                      )}
                      {effectiveNewPayment > 0 && String(paymentMethod).toUpperCase() === 'CASH' && (
                        <span className="text-stone-500 font-normal ml-1 text-[10px]">— Foto uang tunai yang diterima</span>
                      )}
                    </label>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,application/pdf"
                      onChange={(e) => setBuktiBayarFile(e.target.files?.[0] || null)}
                      className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl outline-none file:mr-3 file:py-1 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-emerald-800 file:text-white hover:file:bg-emerald-700 cursor-pointer"
                    />
                    {buktiBayarFile && (
                      <span className="text-[11px] text-emerald-800 font-semibold mt-1 block">
                        ✓ File terpilih: {buktiBayarFile.name}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* RIGHT 30% PANEL — Ringkasan Finansial, Diskon, Catatan & Gate Check */}
          <div className="lg:col-span-4 p-6 bg-stone-50/90 flex flex-col justify-between space-y-6 overflow-y-auto">
            <div className="space-y-5">
              {/* RINGKASAN FINANSIAL */}
              <div className="p-4 bg-white rounded-2xl border border-stone-200 shadow-xs space-y-3">
                <div className="flex items-center justify-between border-b border-stone-100 pb-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-stone-700">
                    Ringkasan Finansial
                  </h4>
                  <span className="text-[10px] font-bold px-2 py-0.5 bg-emerald-100 text-emerald-900 rounded-full">
                    {totalRoomsCount} Kamar
                  </span>
                </div>

                <div className="space-y-2 text-xs">
                  <div className="flex justify-between text-stone-700 py-0.5 border-b border-stone-50">
                    <span>
                      <strong>Kamar 1:</strong> {selectedRoomLabel}
                    </span>
                    <span className="font-mono font-semibold">
                      Rp {effectiveRoomCharge.toLocaleString('id-ID')}
                    </span>
                  </div>

                  {additionalRoomsCalcs.map((c, idx) => (
                    <div key={idx} className="flex justify-between text-stone-700 py-0.5 border-b border-stone-50">
                      <span>
                        <strong>Kamar {idx + 2}:</strong> {c.roomLabel}
                      </span>
                      <span className="font-mono font-semibold">
                        Rp {c.roomCharge.toLocaleString('id-ID')}
                      </span>
                    </div>
                  ))}

                  {totalStayCharges > 0 && (
                    <div className="flex justify-between text-stone-600">
                      <span>Total Layanan Tambahan</span>
                      <span className="font-mono font-semibold">
                        Rp {totalStayCharges.toLocaleString('id-ID')}
                      </span>
                    </div>
                  )}

                  <div className="flex justify-between text-stone-800 font-medium pt-1 border-t border-stone-100">
                    <span>Gross Total</span>
                    <span className="font-mono font-semibold">Rp {grossTotal.toLocaleString('id-ID')}</span>
                  </div>

                  {/* DISKON KESELURUHAN */}
                  <div className="p-2.5 bg-stone-50 rounded-xl border border-stone-200 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-stone-500">
                        Diskon Keseluruhan
                      </span>
                      <div className="flex gap-1 p-0.5 bg-stone-200/70 rounded-md text-[10px] font-semibold">
                        <button
                          type="button"
                          onClick={() => setDiscountType('NOMINAL')}
                          className={`px-2 py-0.5 rounded transition cursor-pointer ${
                            discountType === 'NOMINAL'
                              ? 'bg-white text-stone-900 shadow-2xs font-bold'
                              : 'text-stone-600'
                          }`}
                        >
                          Nominal (Rp)
                        </button>
                        <button
                          type="button"
                          onClick={() => setDiscountType('PERCENT')}
                          className={`px-2 py-0.5 rounded transition cursor-pointer ${
                            discountType === 'PERCENT'
                              ? 'bg-white text-stone-900 shadow-2xs font-bold'
                              : 'text-stone-600'
                          }`}
                        >
                          Persentase (%)
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-2">
                      <div>
                        <label className="block text-[10px] font-semibold text-stone-600 mb-0.5">
                          Nilai Diskon ({discountType === 'PERCENT' ? '%' : 'Rp'})
                        </label>
                        <input
                          type="number"
                          min={0}
                          max={discountType === 'PERCENT' ? 100 : undefined}
                          value={discountValue}
                          onChange={(e) => setDiscountValue(Math.max(0, Number(e.target.value)))}
                          className="w-full text-xs px-2.5 py-1.5 bg-white border border-stone-300 rounded-lg font-mono"
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] font-semibold text-stone-600 mb-0.5">
                          Alasan Diskon{computedDiscountAmount > 0 ? ' *' : ''}
                        </label>
                        <input
                          type="text"
                          value={discountReason}
                          onChange={(e) => setDiscountReason(e.target.value)}
                          placeholder="Contoh: Promo Direct Booking..."
                          className="w-full text-xs px-2.5 py-1.5 bg-white border border-stone-300 rounded-lg"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-between text-emerald-800 font-medium">
                    <span>Total Diskon</span>
                    <span className="font-mono font-semibold">-Rp {computedDiscountAmount.toLocaleString('id-ID')}</span>
                  </div>

                  <div className="border-t border-stone-200 pt-2 flex justify-between text-stone-900 font-bold text-sm">
                    <span>Grand Total</span>
                    <span className="font-mono text-emerald-950">Rp {grandTotal.toLocaleString('id-ID')}</span>
                  </div>

                  {previewData && (
                    <div className="hidden">
                      Rp {Number(previewData.quote?.grand_total || 0).toLocaleString('id-ID')}
                    </div>
                  )}

                  <div className="flex justify-between text-stone-600 pt-1">
                    <span>Jumlah Dibayar</span>
                    <span className="font-mono font-semibold text-emerald-800">
                      Rp {totalSettledDisplay.toLocaleString('id-ID')}
                    </span>
                  </div>

                  {paymentMode === 'ADVANCE_PAYMENT' && effectiveNewPayment > 0 && (
                    <div className="flex justify-between text-stone-600">
                      <span>Uang Muka Diterima</span>
                      <span className="font-mono font-semibold text-emerald-800">
                        Rp {effectiveNewPayment.toLocaleString('id-ID')}
                      </span>
                    </div>
                  )}

                  <div className="flex justify-between text-stone-600">
                    <span>Sisa Tagihan</span>
                    <span className={`font-mono font-bold ${remainingBalance > 0 ? 'text-amber-800' : 'text-emerald-800'}`}>
                      Rp {remainingBalance.toLocaleString('id-ID')}
                    </span>
                  </div>
                </div>
              </div>

              {/* Catatan / Special Requests */}
              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">
                  Catatan / Special Requests
                </label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Contoh: Permintaan lantai atas, connecting room..."
                  className="w-full text-xs p-3 bg-white border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 outline-none"
                />
              </div>

              {/* KELAYAKAN RESERVASI (GATE CHECK) */}
              <div className="p-4 bg-white rounded-2xl border border-stone-200 text-xs space-y-2">
                <h5 className="font-bold text-stone-800 text-[11px] uppercase tracking-wider">
                  Kelayakan Reservasi (Gate Check)
                </h5>
                {gateCheckErrors.length > 0 ? (
                  <div className="p-3 bg-rose-50 rounded-xl border border-rose-200 text-rose-900 text-xs space-y-1">
                    <p className="font-semibold text-rose-800">Harap lengkapi:</p>
                    <ul className="list-disc list-inside space-y-0.5 text-[11px] text-rose-700">
                      {gateCheckErrors.map((errText, idx) => (
                        <li key={idx}>{errText}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="p-2.5 bg-emerald-50 rounded-xl border border-emerald-200 text-emerald-900 text-xs flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-600" />
                    <span className="font-semibold">Semua dokumen &amp; data wajib lengkap ({totalRoomsCount} kamar).</span>
                  </div>
                )}
              </div>
            </div>

            {/* Submit & Cancel Buttons — "Simpan Reservasi" */}
            <div className="space-y-2 pt-4 mt-6 border-t border-stone-200 shrink-0">
              <button
                type="submit"
                disabled={loading || gateCheckErrors.length > 0}
                className="w-full py-3 px-4 bg-emerald-800 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-xl font-bold text-sm shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer disabled:cursor-not-allowed"
              >
                {loading ? 'Menyimpan Reservasi...' : 'Simpan Reservasi'}
              </button>
              <button
                type="button"
                onClick={onClose}
                disabled={loading}
                className="w-full py-2.5 px-4 bg-stone-200 hover:bg-stone-300 text-stone-700 rounded-xl font-semibold text-xs transition-colors cursor-pointer"
              >
                Batal
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* Lower Price Decision Modal */}
      {showDecreaseModal && previewData && (
        <div className="fixed inset-0 z-[80] bg-black/60 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-stone-200">
              <h3 className="text-base font-bold text-stone-900">Konfirmasi Harga Baru</h3>
              <button
                type="button"
                onClick={() => setShowDecreaseModal(false)}
                disabled={loading}
                className="text-stone-400 hover:text-stone-600 text-lg font-bold cursor-pointer disabled:opacity-50"
              >
                ✕
              </button>
            </div>

            <p className="text-sm text-stone-700">
              Harga baru lebih rendah{' '}
              <strong className="text-emerald-800">
                Rp {Math.abs(Number(previewData.price_difference || 0)).toLocaleString('id-ID')}
              </strong>
            </p>

            <div className="flex flex-col sm:flex-row gap-2 pt-2">
              <button
                type="button"
                onClick={() => submitEditDecision(true)}
                disabled={loading}
                className="flex-1 px-4 py-2.5 border border-stone-300 text-stone-800 font-bold rounded-xl hover:bg-stone-100 disabled:opacity-50"
              >
                Pertahankan Harga Lama
              </button>
              <button
                type="button"
                onClick={() => submitEditDecision(false)}
                disabled={loading}
                className="flex-1 px-4 py-2.5 bg-emerald-800 hover:bg-emerald-700 text-white font-bold rounded-xl disabled:opacity-50"
              >
                {loading ? 'Menyimpan...' : 'Terapkan Harga Baru'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* OTA Source Manager Modal */}
      <OtaSourceManagerModal
        propertyId={propertyId}
        isOpen={isOtaModalOpen}
        onClose={() => setIsOtaModalOpen(false)}
        onSourceUpdated={reloadOtaSources}
      />

      {/* Identity Extraction Modal */}
      <IdentityExtractionModal
        isOpen={showIdentityModal}
        onClose={() => setShowIdentityModal(false)}
        guestId={
          selectedGuest && !guestNameTouched && Number(selectedGuest.id) !== Number(primaryGuestId)
            ? selectedGuest.id
            : null
        }
        reservationId={reservation?.id ?? null}
        expectedPrimaryGuestId={primaryGuestId}
        relinkReservationPrimaryGuest={false}
        guestName={guestName || selectedGuest?.full_name || reservation?.primary_guest?.primary_guest_name || ''}
        guestPhone={guestPhone || selectedGuest?.phone || reservation?.primary_guest?.primary_guest_phone || undefined}
        propertyId={propertyId}
        context="RESERVATION_EDIT_IDENTITY"
        mode={identityModalMode}
        onIdentityConfirmed={(_data, savedGuest) => {
          const confirmedId = Number(savedGuest?.id ?? effectiveGuestId);
          if (!Number.isInteger(confirmedId) || confirmedId <= 0) return;
          const confirmedName = String(savedGuest?.full_name || guestName || '').trim();
          setSelectedGuest((prev) => {
            const base: Guest = prev ?? {
              id: confirmedId,
              full_name: confirmedName || 'Tamu',
              phone: guestPhone || null,
              vip_status: 'STANDARD',
              has_valid_identity: false
            };
            return {
              ...base,
              id: confirmedId,
              full_name: confirmedName || base.full_name,
              has_valid_identity: true,
              identity_number: savedGuest?.identity_number ?? _data?.identity_number ?? base.identity_number ?? null,
              identity_path: savedGuest?.identity_path ?? base.identity_path ?? null
            };
          });
          setGuestNameTouched(false);
          if (confirmedName) setGuestName(confirmedName);
          setIdentityConfirmedGuestId(confirmedId);
          setShowIdentityModal(false);
        }}
      />
    </div>,
    document.body
  );
};
