import React, { useState, useEffect, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom';
import { safeFetchJson } from './calendarApi';
import { useAuth } from '../auth/AuthContext';
import GuestSearchAutocomplete from '../booking/GuestSearchAutocomplete';
import IdentityExtractionModal from '../booking/IdentityExtractionModal';
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
  const { authFetch } = useAuth();

  // 1. Booking Source State
  const [channel, setChannel] = useState<'WALKIN' | 'OTA'>('WALKIN');
  const [walkinSubSource, setWalkinSubSource] = useState<'FRONT_DESK' | 'PHONE' | 'WEB'>('FRONT_DESK');
  const [otaSourceId, setOtaSourceId] = useState<number | null>(null);
  const [otaSources, setOtaSources] = useState<any[]>([]);

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

  // Master Data
  const [ratePlans, setRatePlans] = useState<any[]>([]);
  const [availableRoomTypes, setAvailableRoomTypes] = useState<any[] | null>(null);
  const [availabilityLoading, setAvailabilityLoading] = useState<boolean>(false);

  // Preview State
  const [previewData, setPreviewData] = useState<any>(null);

  // Identity (Lengkapi KTP) State
  const [showIdentityModal, setShowIdentityModal] = useState<boolean>(false);
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

  const activeExistingCharges = existingFolioCharges.filter((c) => !removedFolioEntryIds.includes(c.id));
  const existingStayChargesTotal = activeExistingCharges.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const pendingStayChargesTotal = pendingStayCharges.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const totalStayCharges = existingStayChargesTotal + pendingStayChargesTotal;

  const grossTotal = effectiveRoomCharge + totalStayCharges;
  const computedDiscountAmount = discountType === 'PERCENT'
    ? Math.min(grossTotal, Math.max(0, Math.round((grossTotal * Number(discountValue || 0)) / 100)))
    : Math.min(grossTotal, Math.max(0, Math.round(Number(discountValue || 0))));
  const grandTotal = Math.max(0, grossTotal - computedDiscountAmount);

  const amountPaid = Number(previewData?.amount_paid ?? reservation?.amount_paid ?? 0);
  const appliedDeposit = Number(previewData?.applied_deposit ?? reservation?.applied_deposit ?? 0);
  const paymentRequired = Number(previewData?.payment_required ?? 0);
  const newRemainingBeforePayment = Number(previewData?.new_remaining_before_payment ?? Math.max(0, grandTotal - amountPaid - appliedDeposit));
  const remainingBalance = Math.max(0, grandTotal - amountPaid - appliedDeposit);

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

  const buildEditPayload = () => ({
    allow_checked_in: true,
    booking_source: channel === 'OTA' ? 'ota' : 'walkin',
    payment_responsibility: channel === 'OTA' ? 'OTA_COLLECT' : 'HOTEL_COLLECT',
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
  if (!isOta && isManualOverride && !manualOverrideReason.trim()) {
    gateCheckErrors.push('Alasan override harga manual wajib diisi');
  }
  if (computedDiscountAmount > 0 && !discountReason.trim()) {
    gateCheckErrors.push('Alasan diskon wajib diisi ketika diskon > 0');
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

      // 2. Post any newly added stay charges
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
              note: sc.note
            })
          },
          'Gagal menambahkan layanan tambahan',
          authFetch
        );
        if (!postRes.ok) {
          throw new Error(postRes.errorMessage || 'Gagal menambahkan layanan tambahan');
        }
      }

      // 3. Save reservation edit
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

  return ReactDOM.createPortal(
    <div
      data-portal-overlay="reservation-edit"
      className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4 overflow-y-auto"
    >
      <div className="bg-stone-100 rounded-2xl max-w-7xl w-full shadow-2xl border border-stone-300 max-h-[95vh] flex flex-col overflow-hidden">
        {/* Top Forest Green Header — Identical to Reservasi Cepat (Quick Booking) */}
        <div className="px-6 py-4 bg-gradient-to-r from-emerald-950 via-emerald-900 to-teal-950 text-white flex items-center justify-between border-b border-emerald-800/60 shrink-0">
          <div className="flex items-center gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-emerald-800/70 border border-emerald-600/50 flex items-center justify-center text-emerald-200 shadow-inner">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <path d="M16 2v4M8 2v4M3 10h18" strokeLinecap="round" />
              </svg>
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base sm:text-lg font-bold tracking-tight text-white">
                  Reservasi Cepat (Quick Booking)
                </h2>
                <span className="px-2.5 py-0.5 text-[11px] font-bold bg-emerald-800/90 text-emerald-200 rounded-full border border-emerald-600/60 font-mono">
                  Edit {bidLabel}
                </span>
                <span className={`px-2.5 py-0.5 text-[11px] font-bold rounded-full uppercase ${
                  String(reservation?.status).toUpperCase() === 'CHECKED_IN'
                    ? 'bg-blue-600 text-white'
                    : 'bg-emerald-600 text-white'
                }`}>
                  {reservation?.status}
                </span>
              </div>
              <p className="text-xs text-emerald-200/80 mt-0.5">
                Perbarui sumber reservasi, data tamu &amp; KTP, kamar, layanan tambahan, dan diskon reservasi
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="text-emerald-200 hover:text-white p-1.5 rounded-lg hover:bg-emerald-800/50 transition-colors cursor-pointer"
            aria-label="Tutup"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
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
        <form onSubmit={handleSubmit} className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 overflow-hidden text-xs">
          {/* LEFT 70% PANEL */}
          <div className="lg:col-span-8 overflow-y-auto p-5 sm:p-6 space-y-5">
            {/* 1. SUMBER RESERVASI (BOOKING SOURCE) */}
            <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-xs space-y-4">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-700" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-stone-800">
                  1. Sumber Reservasi (Booking Source)
                </h3>
              </div>

              <div className="grid grid-cols-2 gap-2 p-1 bg-stone-100 rounded-xl border border-stone-200">
                <button
                  type="button"
                  onClick={() => {
                    setChannel('WALKIN');
                    setOtaSourceId(null);
                  }}
                  className={`py-2.5 px-4 rounded-lg font-bold text-xs transition-all cursor-pointer flex items-center justify-center gap-2 ${
                    channel === 'WALKIN'
                      ? 'bg-emerald-900 text-white shadow-xs'
                      : 'text-stone-600 hover:text-stone-900'
                  }`}
                >
                  <span>👤</span>
                  <span>WALK-IN / DIRECT</span>
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
                  className={`py-2.5 px-4 rounded-lg font-bold text-xs transition-all cursor-pointer flex items-center justify-center gap-2 ${
                    channel === 'OTA'
                      ? 'bg-emerald-900 text-white shadow-xs'
                      : 'text-stone-600 hover:text-stone-900'
                  }`}
                >
                  <span>🌐</span>
                  <span>OTA</span>
                </button>
              </div>

              {channel === 'WALKIN' ? (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
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
                      className={`py-2.5 px-3 rounded-xl font-semibold text-xs border transition-all cursor-pointer ${
                        walkinSubSource === sub.key
                          ? 'bg-emerald-50 border-emerald-300 text-emerald-900 font-bold'
                          : 'bg-white border-stone-200 text-stone-600 hover:bg-stone-50'
                      }`}
                    >
                      {sub.label}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">
                      Platform OTA <span className="text-rose-500">*</span>
                    </label>
                    <select
                      value={otaSourceId || ''}
                      onChange={(e) => setOtaSourceId(Number(e.target.value) || null)}
                      className="w-full px-3 py-2.5 bg-white border border-stone-300 rounded-xl focus:border-emerald-600 focus:outline-none"
                    >
                      <option value="">Pilih Platform OTA...</option>
                      {otaSources.map((ota: any) => (
                        <option key={ota.id} value={ota.id}>
                          {ota.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">
                      Nomor Booking OTA / Referral
                    </label>
                    <input
                      type="text"
                      value={referral}
                      onChange={(e) => setReferral(e.target.value)}
                      placeholder="Contoh: 1092837465..."
                      className="w-full px-3 py-2.5 bg-white border border-stone-300 rounded-xl font-mono focus:border-emerald-600 focus:outline-none"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* 2. DATA PEMESAN & TAMU MENGINAP */}
            <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-xs space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-700" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-stone-800">
                    2. Data Pemesan &amp; Tamu Menginap
                  </h3>
                </div>
                <label className="flex items-center gap-2 text-xs font-semibold text-stone-700 cursor-pointer select-none">
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
                    className="w-4 h-4 rounded text-emerald-800 focus:ring-emerald-600"
                  />
                  <span>Pemesan adalah Tamu Menginap</span>
                </label>
              </div>

              {!sameAsBooker && (
                <div className="p-3.5 bg-stone-50 rounded-xl border border-stone-200 space-y-3">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-stone-500">
                    Data Pemesan (Booker)
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block font-semibold text-stone-700 mb-1">
                        Nama Pemesan <span className="text-rose-500">*</span>
                      </label>
                      <GuestSearchAutocomplete
                        propertyId={propertyId}
                        value={bookerName}
                        onChange={(name) => {
                          setBookerName(name);
                          if (selectedBookerGuest) setSelectedBookerGuest(null);
                        }}
                        onSelectGuest={(guest) => {
                          setSelectedBookerGuest(guest);
                          setBookerName(guest.full_name);
                          setBookerPhone(guest.phone || '');
                        }}
                        onClearGuest={() => setSelectedBookerGuest(null)}
                        selectedGuest={selectedBookerGuest}
                        label=""
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-stone-700 mb-1">
                        Nomor HP Pemesan
                      </label>
                      <input
                        type="text"
                        value={bookerPhone}
                        onChange={(e) => setBookerPhone(e.target.value)}
                        placeholder="08xxxxxxxxxx"
                        className="w-full px-3 py-2 bg-white border border-stone-300 rounded-xl font-mono focus:border-emerald-600 focus:outline-none"
                      />
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-3">
                <div className="text-[11px] font-bold uppercase tracking-wider text-stone-500">
                  Tamu Menginap (Staying Guest)
                </div>

                <div>
                  <label className="block font-semibold text-stone-700 mb-1">
                    Nama Tamu Menginap <span className="text-rose-500">*</span>
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
                    required
                    label=""
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">
                      Nomor HP Tamu <span className="text-stone-400 font-normal">(opsional)</span>
                    </label>
                    <input
                      type="text"
                      value={guestPhone}
                      onChange={(e) => {
                        setGuestPhone(e.target.value);
                        if (sameAsBooker) setBookerPhone(e.target.value);
                      }}
                      placeholder="08xxxxxxxxxx"
                      className="w-full px-3 py-2.5 bg-white border border-stone-300 rounded-xl font-mono focus:border-emerald-600 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">
                      Segmentasi Tamu
                    </label>
                    <div className="flex items-center gap-2">
                      {(['Reguler', 'Corporate', 'Group'] as const).map((seg) => (
                        <button
                          key={seg}
                          type="button"
                          onClick={() => setGuestSegment(seg)}
                          className={`px-3.5 py-2 rounded-xl font-bold text-xs border transition-all cursor-pointer ${
                            guestSegment === seg
                              ? 'bg-emerald-900 text-white border-emerald-900 shadow-xs'
                              : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-50'
                          }`}
                        >
                          {seg}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* 3. DOKUMEN IDENTITAS TAMU (KTP) */}
            <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-xs space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-700" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-stone-800">
                    3. Dokumen Identitas Tamu (KTP){' '}
                    <span className="text-stone-400 font-normal">(OPSIONAL)</span>
                  </h3>
                </div>
                {hasKtpVerified && (
                  <span className="px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200 font-bold text-[11px]">
                    ✓ Terverifikasi
                  </span>
                )}
              </div>

              <div className="p-4 rounded-xl border border-dashed border-stone-300 bg-stone-50/70 flex flex-col sm:flex-row items-center justify-between gap-3">
                <div className="text-center sm:text-left">
                  {hasKtpVerified ? (
                    <div className="space-y-0.5">
                      <div className="font-bold text-emerald-900 text-xs">
                        ✓ Dokumen KTP Tersimpan {currentNik ? `• NIK: ${currentNik}` : ''}
                      </div>
                      <div className="text-[11px] text-stone-500">
                        Tamu: {guestName || reservation?.guest_name}
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-stone-600">
                      Lampirkan foto KTP atau pilih tamu yang sudah memiliki KTP tersimpan.
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setShowIdentityModal(true)}
                  className="px-4 py-2 bg-emerald-800 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl shadow-xs transition-colors cursor-pointer shrink-0"
                >
                  {hasKtpVerified ? 'Ganti / Scan Ulang KTP' : 'Unggah KTP Sekarang'}
                </button>
              </div>
            </div>

            {/* 4. DAFTAR KAMAR RESERVASI */}
            <div className="space-y-3">
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-700" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-stone-800">
                    4. Daftar Kamar Reservasi (1 Kamar)
                  </h3>
                </div>
              </div>

              <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-xs space-y-5">
                {/* Room Card Header */}
                <div className="flex items-center justify-between pb-3 border-b border-stone-100">
                  <div className="flex items-center gap-2.5">
                    <span className="px-2.5 py-1 bg-emerald-900 text-white font-bold text-[11px] rounded-lg uppercase tracking-wider">
                      Kamar 1
                    </span>
                    <span className="font-bold text-stone-800 text-xs">
                      {selectedAvailableType?.name || reservation?.room_type_name || 'Pilih Tipe Kamar'}{' '}
                      {selectedRoomObj?.room_number ? `• ${selectedRoomObj.room_number}` : ''}
                    </span>
                  </div>
                </div>

                {/* Waktu & Durasi Menginap */}
                <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 space-y-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-stone-600">
                      Waktu &amp; Durasi Menginap
                    </span>
                    <div className="flex items-center gap-1 p-0.5 bg-stone-200 rounded-lg">
                      <button
                        type="button"
                        onClick={() => setStayType('OVERNIGHT')}
                        className={`px-3 py-1 rounded-md text-[11px] font-bold transition-all cursor-pointer ${
                          stayType === 'OVERNIGHT'
                            ? 'bg-emerald-900 text-white shadow-xs'
                            : 'text-stone-600 hover:text-stone-900'
                        }`}
                      >
                        Menginap
                      </button>
                      <button
                        type="button"
                        onClick={() => setStayType('DAY_USE')}
                        className={`px-3 py-1 rounded-md text-[11px] font-bold transition-all cursor-pointer ${
                          stayType === 'DAY_USE'
                            ? 'bg-emerald-900 text-white shadow-xs'
                            : 'text-stone-600 hover:text-stone-900'
                        }`}
                      >
                        Day Use
                      </button>
                    </div>
                  </div>

                  {stayType === 'OVERNIGHT' ? (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block font-semibold text-stone-700 mb-1">
                          Check-in Date <span className="text-rose-500">*</span>
                        </label>
                        <input
                          type="date"
                          required
                          value={checkIn}
                          onChange={(e) => setCheckIn(e.target.value)}
                          className="w-full px-3 py-2 bg-white border border-stone-300 rounded-xl font-mono"
                        />
                      </div>
                      <div>
                        <label className="block font-semibold text-stone-700 mb-1">
                          Check-out Date <span className="text-rose-500">*</span>
                        </label>
                        <input
                          type="date"
                          required
                          min={checkIn}
                          value={checkOut}
                          onChange={(e) => setCheckOut(e.target.value)}
                          className="w-full px-3 py-2 bg-white border border-stone-300 rounded-xl font-mono"
                        />
                      </div>
                      <div>
                        <label className="block font-semibold text-stone-700 mb-1">
                          Durasi (Malam)
                        </label>
                        <div className="w-full px-3 py-2 bg-stone-100 border border-stone-200 rounded-xl font-bold text-stone-700">
                          {stayNights} Malam
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block font-semibold text-stone-700 mb-1">
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
                          className="w-full px-3 py-2 bg-white border border-stone-300 rounded-xl font-mono"
                        />
                      </div>
                      <div>
                        <label className="block font-semibold text-stone-700 mb-1">
                          Jam Masuk
                        </label>
                        <input
                          type="time"
                          value={checkInTime}
                          onChange={(e) => setCheckInTime(e.target.value)}
                          className="w-full px-3 py-2 bg-white border border-stone-300 rounded-xl font-mono"
                        />
                      </div>
                      <div>
                        <label className="block font-semibold text-stone-700 mb-1">
                          Jam Keluar
                        </label>
                        <input
                          type="time"
                          value={checkOutTime}
                          onChange={(e) => setCheckOutTime(e.target.value)}
                          className="w-full px-3 py-2 bg-white border border-stone-300 rounded-xl font-mono"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Tipe Kamar, Nomor Kamar, Rate Plan, Dewasa/Anak */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">
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
                      className="w-full px-3 py-2.5 bg-white border border-stone-300 rounded-xl"
                    >
                      <option value="">Pilih Tipe Kamar</option>
                      {(availableRoomTypes || []).map((rt) => (
                        <option key={rt.id} value={rt.id}>
                          {rt.name} ({rt.rooms?.length || 0} tersedia)
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">
                      Pilih Nomor Kamar <span className="text-rose-500">*</span>
                    </label>
                    <select
                      required
                      value={roomId || ''}
                      onChange={(e) => setRoomId(Number(e.target.value) || null)}
                      disabled={availabilityLoading || !roomTypeId || availableRooms.length === 0}
                      className="w-full px-3 py-2.5 bg-white border border-stone-300 rounded-xl disabled:bg-stone-100"
                    >
                      <option value="">
                        {availabilityLoading
                          ? 'Memuat kamar tersedia...'
                          : availableRooms.length === 0
                            ? 'Tidak ada kamar tersedia'
                            : 'Pilih Nomor Kamar'}
                      </option>
                      {availableRooms.map((r: any) => (
                        <option key={r.id} value={r.id}>
                          Kamar {r.room_number}{r.floor ? ` (Lt. ${r.floor})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>

                  {!isOta && (
                    <div>
                      <label className="block font-semibold text-stone-700 mb-1">
                        Rate Plan / Paket Harga <span className="text-rose-500">*</span>
                      </label>
                      <select
                        value={ratePlanId || ''}
                        onChange={(e) => {
                          setRatePlanId(Number(e.target.value) || null);
                          setRatePlanTouched(true);
                        }}
                        className="w-full px-3 py-2.5 bg-white border border-stone-300 rounded-xl"
                      >
                        {filteredRatePlans.length === 0 && (
                          <option value="">
                            {stayType === 'DAY_USE'
                              ? 'Tidak ada Paket Day Use untuk Tipe Kamar ini'
                              : 'Tidak ada Paket Tarif aktif untuk Tipe Kamar ini'}
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

                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="block font-semibold text-stone-700 mb-1">Jumlah Dewasa</label>
                      <input
                        type="number"
                        min={1}
                        value={adults}
                        onChange={(e) => setAdults(Math.max(1, Number(e.target.value)))}
                        className="w-full px-3 py-2.5 bg-white border border-stone-300 rounded-xl"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-stone-700 mb-1">Jumlah Anak</label>
                      <input
                        type="number"
                        min={0}
                        value={children}
                        onChange={(e) => setChildren(Math.max(0, Number(e.target.value)))}
                        className="w-full px-3 py-2.5 bg-white border border-stone-300 rounded-xl"
                      />
                    </div>
                  </div>
                </div>

                {/* Tarif Kamar Terkalkulasi & Manual Override / OTA Price */}
                <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 space-y-3">
                  {isOta ? (
                    <div>
                      <label className="block font-bold text-stone-800 mb-1">
                        Total Harga Kamar OTA (Rp) <span className="text-rose-500">*</span>
                      </label>
                      <input
                        type="number"
                        min={0}
                        value={manualOverridePrice}
                        onChange={(e) => setManualOverridePrice(Math.max(0, Number(e.target.value)))}
                        className="w-full px-3 py-2.5 bg-white border border-stone-300 rounded-xl font-mono font-bold text-sm text-emerald-900"
                      />
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <div>
                          <div className="text-[11px] font-bold uppercase tracking-wider text-stone-500">
                            Tarif Kamar Terkalkulasi
                          </div>
                          <div className="text-base font-bold font-mono text-emerald-950 mt-0.5">
                            Rp {effectiveRoomCharge.toLocaleString('id-ID')}
                            {previewLoading && (
                              <span className="ml-2 text-[11px] font-normal text-emerald-700 animate-pulse">
                                Menghitung...
                              </span>
                            )}
                          </div>
                        </div>

                        <label className="flex items-center gap-2 text-xs font-semibold text-stone-700 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={isManualOverride}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setIsManualOverride(checked);
                              if (checked && !manualOverridePrice) {
                                setManualOverridePrice(Math.round(quotedRoomSubtotal / stayNights));
                              }
                            }}
                            className="w-4 h-4 rounded text-emerald-800 focus:ring-emerald-600"
                          />
                          <span>Override Harga Manual</span>
                        </label>
                      </div>

                      {isManualOverride && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-stone-200">
                          <div>
                            <label className="block font-semibold text-stone-700 mb-1">
                              Harga Manual {stayType === 'DAY_USE' ? 'Day Use' : 'per Malam'} (Rp) <span className="text-rose-500">*</span>
                            </label>
                            <input
                              type="number"
                              min={0}
                              value={manualOverridePrice}
                              onChange={(e) => setManualOverridePrice(Math.max(0, Number(e.target.value)))}
                              className="w-full px-3 py-2 bg-white border border-stone-300 rounded-xl font-mono font-bold"
                            />
                          </div>
                          <div>
                            <label className="block font-semibold text-stone-700 mb-1">
                              Alasan Override Harga <span className="text-rose-500">*</span>
                            </label>
                            <input
                              type="text"
                              value={manualOverrideReason}
                              onChange={(e) => setManualOverrideReason(e.target.value)}
                              placeholder="Contoh: Harga khusus corporate / negosiasi..."
                              className="w-full px-3 py-2 bg-white border border-stone-300 rounded-xl"
                            />
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Layanan Tambahan & Denda */}
                <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-stone-600">
                      Layanan Tambahan &amp; Denda
                    </span>
                    <span className="text-xs font-bold font-mono text-emerald-900">
                      +Rp {totalStayCharges.toLocaleString('id-ID')}
                    </span>
                  </div>

                  <StayChargePickerCombobox
                    rules={stayChargeRules}
                    onSelectRule={handleAddStayChargeFromRule}
                    placeholder="Cari & tambah layanan (Extra Bed, Early Check-in, Late Check-out)..."
                  />

                  {(activeExistingCharges.length > 0 || pendingStayCharges.length > 0) && (
                    <div className="space-y-2 pt-1">
                      {activeExistingCharges.map((item) => (
                        <div
                          key={`existing-${item.id}`}
                          className="flex items-center justify-between gap-2 p-2.5 bg-white rounded-xl border border-stone-200"
                        >
                          <div>
                            <div className="font-bold text-stone-800 text-xs">{item.description}</div>
                            <div className="text-[11px] text-stone-500 font-mono">
                              {item.entry_type} • Tersimpan di Folio
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold font-mono text-stone-900">
                              +Rp {item.amount.toLocaleString('id-ID')}
                            </span>
                            <button
                              type="button"
                              onClick={() => setRemovedFolioEntryIds((prev) => [...prev, item.id])}
                              title="Hapus layanan tambahan ini"
                              className="w-6 h-6 rounded-lg flex items-center justify-center text-stone-400 hover:text-rose-600 hover:bg-rose-50 border border-transparent hover:border-rose-200 transition-colors cursor-pointer font-bold"
                            >
                              ×
                            </button>
                          </div>
                        </div>
                      ))}

                      {pendingStayCharges.map((sc) => (
                        <div
                          key={sc.tempId}
                          className="flex items-center justify-between gap-2 p-2.5 bg-emerald-50/60 rounded-xl border border-emerald-200"
                        >
                          <div className="flex-1">
                            <div className="font-bold text-emerald-950 text-xs">{sc.name}</div>
                            <div className="text-[11px] text-emerald-700 font-mono">
                              {sc.charge_type} • Baru ditambahkan
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              type="number"
                              min={1}
                              value={sc.quantity}
                              onChange={(e) => {
                                const qty = Math.max(1, Number(e.target.value));
                                setPendingStayCharges((prev) =>
                                  prev.map((p) =>
                                    p.tempId === sc.tempId ? { ...p, quantity: qty, amount: p.unit_price * qty } : p
                                  )
                                );
                              }}
                              className="w-14 px-2 py-1 bg-white border border-stone-300 rounded-lg text-center font-mono text-xs"
                              title="Kuantitas"
                            />
                            <span className="font-bold font-mono text-emerald-950 min-w-[90px] text-right">
                              +Rp {sc.amount.toLocaleString('id-ID')}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                setPendingStayCharges((prev) => prev.filter((p) => p.tempId !== sc.tempId))
                              }
                              title="Batal tambahkan"
                              className="w-6 h-6 rounded-lg flex items-center justify-center text-stone-400 hover:text-rose-600 hover:bg-rose-50 border border-transparent hover:border-rose-200 transition-colors cursor-pointer font-bold"
                            >
                              ×
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT 30% PANEL — Ringkasan Finansial, Diskon, Catatan & Gate Check */}
          <div className="lg:col-span-4 bg-white border-t lg:border-t-0 lg:border-l border-stone-200 p-5 sm:p-6 overflow-y-auto flex flex-col justify-between space-y-5">
            <div className="space-y-4">
              {/* RINGKASAN FINANSIAL */}
              <div className="p-4 rounded-2xl border border-stone-200 bg-stone-50/60 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-stone-800 uppercase tracking-wider text-xs">
                    Ringkasan Finansial
                  </h4>
                  <span className="px-2.5 py-0.5 bg-emerald-100 text-emerald-900 font-bold text-[11px] rounded-full">
                    1 Kamar
                  </span>
                </div>

                <div className="space-y-1.5 text-xs pt-1 border-t border-stone-200/80">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-stone-700 font-medium truncate">
                      Kamar 1: {selectedRoomLabel}
                    </span>
                    <span className="font-mono font-bold text-stone-900 shrink-0">
                      Rp {effectiveRoomCharge.toLocaleString('id-ID')}
                    </span>
                  </div>

                  {totalStayCharges > 0 && (
                    <div className="flex items-center justify-between gap-2 text-stone-600">
                      <span>Total Layanan Tambahan</span>
                      <span className="font-mono font-semibold text-stone-800">
                        +Rp {totalStayCharges.toLocaleString('id-ID')}
                      </span>
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-stone-200 font-bold text-stone-900">
                    <span>Gross Total</span>
                    <span className="font-mono">Rp {grossTotal.toLocaleString('id-ID')}</span>
                  </div>
                </div>

                {/* DISKON KESELURUHAN */}
                <div className="p-3 bg-white rounded-xl border border-stone-200 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-stone-600">
                      Diskon Keseluruhan
                    </span>
                    <div className="flex items-center gap-1 p-0.5 bg-stone-100 rounded-lg border border-stone-200">
                      <button
                        type="button"
                        onClick={() => setDiscountType('NOMINAL')}
                        className={`px-2 py-0.5 rounded text-[10px] font-bold cursor-pointer ${
                          discountType === 'NOMINAL'
                            ? 'bg-white text-emerald-900 shadow-2xs'
                            : 'text-stone-500'
                        }`}
                      >
                        Nominal (Rp)
                      </button>
                      <button
                        type="button"
                        onClick={() => setDiscountType('PERCENT')}
                        className={`px-2 py-0.5 rounded text-[10px] font-bold cursor-pointer ${
                          discountType === 'PERCENT'
                            ? 'bg-white text-emerald-900 shadow-2xs'
                            : 'text-stone-500'
                        }`}
                      >
                        Persentase (%)
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] text-stone-500 mb-1">
                      Nilai Diskon ({discountType === 'NOMINAL' ? 'Rp' : '%'})
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={discountType === 'PERCENT' ? 100 : undefined}
                      value={discountValue}
                      onChange={(e) => setDiscountValue(Math.max(0, Number(e.target.value)))}
                      className="w-full px-3 py-1.5 bg-stone-50 border border-stone-300 rounded-lg font-mono text-xs"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] text-stone-500 mb-1">
                      Alasan Diskon
                    </label>
                    <input
                      type="text"
                      value={discountReason}
                      onChange={(e) => setDiscountReason(e.target.value)}
                      placeholder="Contoh: Promo Direct Booking..."
                      className="w-full px-3 py-1.5 bg-stone-50 border border-stone-300 rounded-lg text-xs"
                    />
                  </div>
                </div>

                <div className="space-y-1.5 pt-1 text-xs">
                  <div className="flex items-center justify-between text-emerald-800 font-semibold">
                    <span>Total Diskon</span>
                    <span className="font-mono">-Rp {computedDiscountAmount.toLocaleString('id-ID')}</span>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-stone-200 text-sm font-bold text-stone-900">
                    <span>Grand Total</span>
                    <span className="font-mono">Rp {grandTotal.toLocaleString('id-ID')}</span>
                  </div>

                  {previewData && (
                    <div className="hidden">
                      Rp {Number(previewData.quote?.grand_total || 0).toLocaleString('id-ID')}
                    </div>
                  )}

                  <div className="flex items-center justify-between text-stone-600 pt-1">
                    <span>Jumlah Dibayar</span>
                    <span className="font-mono font-bold text-emerald-800">
                      Rp {(amountPaid + appliedDeposit).toLocaleString('id-ID')}
                    </span>
                  </div>

                  <div className="flex items-center justify-between text-stone-700 font-semibold">
                    <span>Sisa Tagihan</span>
                    <span className={`font-mono font-bold ${remainingBalance > 0 ? 'text-amber-700' : 'text-emerald-800'}`}>
                      Rp {remainingBalance.toLocaleString('id-ID')}
                    </span>
                  </div>
                </div>
              </div>

              {/* Catatan / Special Requests */}
              <div className="p-4 rounded-2xl border border-stone-200 bg-white space-y-2">
                <label className="block font-bold text-stone-700 text-xs">
                  Catatan / Special Requests
                </label>
                <textarea
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Contoh: Permintaan lantai atas, connecting room..."
                  className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl text-xs focus:bg-white focus:border-emerald-600 focus:outline-none"
                />
              </div>

              {/* KELAYAKAN RESERVASI (GATE CHECK) */}
              <div className="p-4 rounded-2xl border border-stone-200 bg-white space-y-2">
                <h4 className="font-bold text-stone-800 uppercase tracking-wider text-[11px]">
                  Kelayakan Reservasi (Gate Check)
                </h4>
                {gateCheckErrors.length > 0 ? (
                  <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 space-y-1">
                    <div className="font-bold text-xs">Harap lengkapi:</div>
                    <ul className="list-disc list-inside space-y-0.5 text-[11px]">
                      {gateCheckErrors.map((errText, idx) => (
                        <li key={idx}>{errText}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 font-semibold text-xs flex items-center gap-2">
                    <span>✓</span>
                    <span>Semua data valid dan siap disimpan.</span>
                  </div>
                )}
              </div>
            </div>

            {/* Submit & Cancel Buttons */}
            <div className="space-y-2.5 pt-2">
              <button
                type="submit"
                disabled={loading || gateCheckErrors.length > 0}
                className="w-full py-3 px-4 bg-emerald-800 hover:bg-emerald-700 disabled:bg-stone-300 disabled:text-stone-500 text-white font-bold text-xs sm:text-sm rounded-xl shadow-sm transition-colors cursor-pointer"
              >
                {loading ? 'Menyimpan Perubahan...' : 'Simpan Perubahan Reservasi'}
              </button>
              <button
                type="button"
                onClick={onClose}
                disabled={loading}
                className="w-full py-2.5 px-4 bg-stone-200 hover:bg-stone-300 text-stone-700 font-bold text-xs sm:text-sm rounded-xl transition-colors cursor-pointer"
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
        mode="UPLOAD"
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
