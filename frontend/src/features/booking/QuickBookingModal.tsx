import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { OtaSource } from '../ota/otaTypes';
import { fetchOtaSources } from '../ota/otaApi';
import { fetchStayChargeRules } from '../stayCharges/stayChargesApi';
import { StayChargePickerCombobox } from '../stayCharges/StayChargePickerCombobox';
import GuestSearchAutocomplete from './GuestSearchAutocomplete';
import IdentityExtractionModal, { type ExtractedIdentityData } from './IdentityExtractionModal';
import OtaSourceManagerModal from '../ota/OtaSourceManagerModal';
import type { Guest, DuplicateCandidate } from '../guests/guestTypes';

/**
 * QuickBookingModal is strictly CREATE-ONLY (New Quick Booking Composer).
 * It creates new reservations by submitting a complete payload to POST /api/bookings.
 * 
 * IMPORTANT ARCHITECTURAL INVARIANT:
 * - Existing reservations are NEVER edited via this modal; existing reservations use EditReservationModal
 *   or ReservationDetailDrawer.
 * - Every time QuickBookingModal opens/closes, its entire transient guest, identity, and payment state
 *   is unconditionally reset via resetQuickBookingState() to prevent cross-guest state leakage.
 */
interface Props {
  isOpen: boolean;
  onClose: () => void;
  propertyId: number;
  rooms: any[];
  roomTypes: any[];
  ratePlans?: any[];
  mealPlans?: any[];
  stayChargeRules?: any[];
  initialRoomId?: number | null;
  initialDate?: string | null;
  onBookingSuccess: () => void;
}

export interface StayChargeLineItem {
  id: string;
  rule_id?: number;
  code?: string;
  charge_type: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  taxable?: boolean;
  service_chargeable?: boolean;
  charge_method?: string;
  is_manual?: boolean;
  is_override?: boolean;
  original_unit_price?: number;
  override_amount?: number;
  override_reason?: string;
  notes?: string;
  isOverrideOpen?: boolean;
}

export interface RoomDraft {
  id: string;
  roomTypeId: number | null;
  roomId: number | null;
  stayType: 'OVERNIGHT' | 'DAY_USE';
  checkIn: string;
  checkOut: string;
  dayUseHours: number;
  dayUseStartTime: string;
  adults: number;
  children: number;
  ratePlanId: number | null;
  roomNightlyRate: number;
  isManualOverride: boolean;
  manualOverridePrice: number;
  manualOverrideReason: string;
  quoteLoading: boolean;
  stayCharges: StayChargeLineItem[];
  discountType: 'NOMINAL' | 'PERCENT';
  discountValue: number;
  discountReason: string;
}

export default function QuickBookingModal({
  isOpen,
  onClose,
  propertyId,
  rooms,
  roomTypes,
  ratePlans = [],
  stayChargeRules = [],
  initialRoomId = null,
  initialDate = null,
  onBookingSuccess
}: Props) {
  const [internalRatePlans, setInternalRatePlans] = useState<any[]>(ratePlans);
  const [internalStayChargeRules, setInternalStayChargeRules] = useState<any[]>(stayChargeRules);

  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const tomorrowStr = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }, []);

  // --- Booking-Level Shared State: Channel & Source ---
  const [channelType, setChannelType] = useState<'WALKIN' | 'OTA'>('WALKIN');
  const [walkinSubSource, setWalkinSubSource] = useState<'DIRECT' | 'PHONE_WA' | 'WEBSITE'>('DIRECT');
  const [otaSources, setOtaSources] = useState<OtaSource[]>([]);
  const [selectedOtaSourceId, setSelectedOtaSourceId] = useState<number | null>(null);
  const [isOtaModalOpen, setIsOtaModalOpen] = useState(false);
  const [referral, setReferral] = useState('');

  // --- Booking-Level Shared State: Booker vs Guest ---
  const [sameAsBooker, setSameAsBooker] = useState(true);
  const [bookerName, setBookerName] = useState('');
  const [bookerPhone, setBookerPhone] = useState('');

  const [guestName, setGuestName] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [guestSegment, setGuestSegment] = useState<'Reguler' | 'Group' | 'Corporate' | 'Walk-in'>('Walk-in');
  const [selectedCrmGuest, setSelectedCrmGuest] = useState<Guest | null>(null);
  const [duplicateCandidates, setDuplicateCandidates] = useState<DuplicateCandidate[]>([]);
  const [showDuplicateModal, setShowDuplicateModal] = useState<boolean>(false);
  const [duplicateBypassed, setDuplicateBypassed] = useState<boolean>(false);

  // --- Booking-Level Shared State: Identity / KTP ---
  const [isIdentityModalOpen, setIsIdentityModalOpen] = useState(false);
  const [ktpPath, setKtpPath] = useState<string | null>(null);
  const [identityNumber, setIdentityNumber] = useState('');
  const [hasValidIdentity, setHasValidIdentity] = useState(false);
  const [identityFileName, setIdentityFileName] = useState<string | null>(null);

  // --- Booking-Level Shared State: Payment Gate ---
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'TRANSFER' | 'QRIS' | 'DEBIT_CARD' | 'CREDIT_CARD'>('CASH');
  const [amountPaid, setAmountPaid] = useState<number>(0);
  const [buktiBayarFile, setBuktiBayarFile] = useState<File | null>(null);
  const [buktiBayarPath, setBuktiBayarPath] = useState<string | null>(null);
  const [specialRequests, setSpecialRequests] = useState('');

  // --- Front Office Dynamic Property Rules & Day Use Presets ---
  const [propertyRules, setPropertyRules] = useState<{ WALK_IN: Record<string, string>; OTA: Record<string, string> }>({ WALK_IN: {}, OTA: {} });
  const [dayUseDurationsList, setDayUseDurationsList] = useState<any[]>([]);

  const activeChannelRules = useMemo(() => {
    return channelType === 'OTA' ? propertyRules.OTA || {} : propertyRules.WALK_IN || {};
  }, [channelType, propertyRules]);

  const getFieldMode = useCallback((fieldKey: string): 'REQUIRED' | 'OPTIONAL' | 'HIDDEN' => {
    return (activeChannelRules[fieldKey] as any) || 'OPTIONAL';
  }, [activeChannelRules]);

  // --- Selected OTA Source Name Memo ---
  const selectedOtaSourceName = useMemo(() => {
    return otaSources.find(o => Number(o.id) === Number(selectedOtaSourceId))?.name || '';
  }, [otaSources, selectedOtaSourceId]);

  // --- Initial Room Draft for a fresh booking session (always WALKIN default) ---
  const createInitialRoomDraft = useCallback((index: number, initRId: number | null = null): RoomDraft => {
    let defaultTypeId = roomTypes.length > 0 ? roomTypes[0].id : null;
    if (initRId) {
      const match = rooms.find(r => Number(r.id) === Number(initRId));
      if (match) {
        defaultTypeId = match.room_type_id || match.canonical_room_type_id || defaultTypeId;
      }
    }

    return {
      id: 'room-' + Date.now() + '-' + index + '-' + Math.random().toString(36).substring(2, 6),
      roomTypeId: defaultTypeId,
      roomId: initRId,
      stayType: 'OVERNIGHT',
      checkIn: initialDate || todayStr,
      checkOut: tomorrowStr,
      dayUseHours: 6,
      dayUseStartTime: '10:00',
      adults: 1,
      children: 0,
      ratePlanId: null,
      roomNightlyRate: 0,
      isManualOverride: false,
      manualOverridePrice: 0,
      manualOverrideReason: '',
      quoteLoading: false,
      stayCharges: [],
      discountType: 'NOMINAL',
      discountValue: 0,
      discountReason: ''
    };
  }, [roomTypes, rooms, initialDate, todayStr, tomorrowStr]);

  // --- Live Room Draft for adding additional rooms during an active session ---
  const createNewRoomDraft = useCallback((index: number, initRId: number | null = null): RoomDraft => {
    let defaultTypeId = roomTypes.length > 0 ? roomTypes[0].id : null;
    if (initRId) {
      const match = rooms.find(r => Number(r.id) === Number(initRId));
      if (match) {
        defaultTypeId = match.room_type_id || match.canonical_room_type_id || defaultTypeId;
      }
    }
    const isOta = channelType === 'OTA';
    const otaReason = selectedOtaSourceName ? `OTA: ${selectedOtaSourceName}` : 'OTA Booking';

    return {
      id: 'room-' + Date.now() + '-' + index + '-' + Math.random().toString(36).substring(2, 6),
      roomTypeId: defaultTypeId,
      roomId: initRId,
      stayType: 'OVERNIGHT',
      checkIn: initialDate || todayStr,
      checkOut: tomorrowStr,
      dayUseHours: 6,
      dayUseStartTime: '10:00',
      adults: 1,
      children: 0,
      ratePlanId: null,
      roomNightlyRate: 0,
      isManualOverride: isOta,
      manualOverridePrice: 0,
      manualOverrideReason: isOta ? otaReason : '',
      quoteLoading: false,
      stayCharges: [],
      discountType: 'NOMINAL',
      discountValue: 0,
      discountReason: ''
    };
  }, [roomTypes, rooms, initialDate, todayStr, tomorrowStr, channelType, selectedOtaSourceName]);

  const [roomsList, setRoomsList] = useState<RoomDraft[]>([createInitialRoomDraft(0, initialRoomId)]);

  // Track previous channelType to detect user-initiated channel transitions
  const prevChannelTypeRef = useRef<'WALKIN' | 'OTA'>(channelType);

  // Auto-synchronize OTA manual override mode on roomsList when switching channels or OTA platform
  useEffect(() => {
    const prevChannel = prevChannelTypeRef.current;
    if (prevChannel !== channelType) {
      prevChannelTypeRef.current = channelType;
      if (channelType === 'OTA') {
        const otaReason = selectedOtaSourceName ? `OTA: ${selectedOtaSourceName}` : 'OTA Booking';
        setRoomsList(prev => prev.map(r => ({
          ...r,
          isManualOverride: true,
          ratePlanId: null,
          manualOverridePrice: 0,
          manualOverrideReason: otaReason
        })));
      } else {
        setRoomsList(prev => prev.map(r => ({
          ...r,
          isManualOverride: false,
          manualOverridePrice: 0,
          manualOverrideReason: '',
          ratePlanId: null
        })));
      }
    } else if (channelType === 'OTA') {
      const otaReason = selectedOtaSourceName ? `OTA: ${selectedOtaSourceName}` : 'OTA Booking';
      setRoomsList(prev => prev.map(r => ({
        ...r,
        manualOverrideReason: otaReason
      })));
    }
  }, [channelType, selectedOtaSourceName]);

  const isDayUseAllowed = getFieldMode('day_use') !== 'HIDDEN';

  // If Day Use is not allowed for the active channel, ensure any DAY_USE drafts revert to OVERNIGHT
  useEffect(() => {
    if (!isDayUseAllowed) {
      setRoomsList(prev => {
        let changed = false;
        const updated = prev.map(draft => {
          if (draft.stayType === 'DAY_USE') {
            changed = true;
            let newCheckOut = draft.checkOut;
            if (!newCheckOut || newCheckOut <= draft.checkIn) {
              const d = new Date(draft.checkIn || todayStr);
              d.setDate(d.getDate() + 1);
              newCheckOut = d.toISOString().slice(0, 10);
            }
            return {
              ...draft,
              stayType: 'OVERNIGHT' as const,
              checkOut: newCheckOut,
              ratePlanId: null
            };
          }
          return draft;
        });
        return changed ? updated : prev;
      });
    }
  }, [isDayUseAllowed, todayStr]);

  // Helper for resilient room type matching (ID, Code prefix, and Name)
  const matchRatePlanToRoomType = useCallback((rp: any, targetTypeId: number | null): boolean => {
    if (!rp.room_type_id) return true;
    if (!targetTypeId) return false;
    if (Number(rp.room_type_id) === Number(targetTypeId)) return true;

    const activeType = roomTypes.find(t => Number(t.id) === Number(targetTypeId));
    if (activeType) {
      const activeCode = String(activeType.code || '').trim().toUpperCase();
      const rpCode = String(rp.room_type_code || '').trim().toUpperCase();
      if (activeCode && rpCode) {
        if (activeCode === rpCode || activeCode.startsWith(rpCode) || rpCode.startsWith(activeCode)) {
          return true;
        }
      }
      const activeName = String(activeType.name || '').trim().toLowerCase();
      const rpName = String(rp.room_type_name || '').trim().toLowerCase();
      if (activeName && rpName) {
        if (activeName.includes(rpName) || rpName.includes(activeName)) {
          return true;
        }
      }
    }
    return false;
  }, [roomTypes]);

  // Auto-fill default rate plan if ratePlanId is missing and channel is not OTA
  useEffect(() => {
    const allPlans = internalRatePlans.length > 0 ? internalRatePlans : ratePlans;
    if (allPlans.length === 0 || channelType === 'OTA') return;

    setRoomsList(prev => {
      let changed = false;
      const updated = prev.map(draft => {
        if (!draft.ratePlanId && draft.roomTypeId) {
          const isDayUse = draft.stayType === 'DAY_USE';
          const matchPlan = allPlans.find((rp: any) =>
            matchRatePlanToRoomType(rp, draft.roomTypeId) &&
            (isDayUse ? rp.rate_type === 'DAY_USE' : rp.rate_type !== 'DAY_USE')
          );
          if (matchPlan) {
            changed = true;
            return { ...draft, ratePlanId: Number(matchPlan.id) };
          }
        }
        return draft;
      });
      return changed ? updated : prev;
    });
  }, [internalRatePlans, ratePlans, channelType, matchRatePlanToRoomType]);

  // --- UI & Submission State ---
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Load OTA sources, Stay Charges, Rate Plans, Rules, and Day Use Presets
  const loadInitialData = async () => {
    try {
      const list = await fetchOtaSources(propertyId);
      const active = list.filter(o => o.is_active && !o.is_archived);
      setOtaSources(active);
      if (active.length > 0 && !selectedOtaSourceId) {
        setSelectedOtaSourceId(active[0].id);
      }
    } catch (err) {
      console.warn('Failed to load OTA sources', err);
    }

    try {
      if (!stayChargeRules || stayChargeRules.length === 0) {
        const rules = await fetchStayChargeRules(propertyId);
        setInternalStayChargeRules(rules);
      } else {
        setInternalStayChargeRules(stayChargeRules);
      }
    } catch (err) {
      console.warn('Failed to load stay charge rules', err);
    }

    try {
      if (!ratePlans || ratePlans.length === 0) {
        const res = await fetch('/api/pricing/rate-plans?property_id=' + propertyId);
        const json = await res.json();

        if (res.ok) {
          const plans = Array.isArray(json)
            ? json
            : (Array.isArray(json.data) ? json.data : []);

          setInternalRatePlans(plans);
        }
      } else {
        setInternalRatePlans(ratePlans);
      }
    } catch (err) {
      console.warn('Failed to load rate plans', err);
    }

    try {
      const [rulesRes, durRes] = await Promise.all([
        fetch(`/api/properties/${propertyId}/quick-booking-rules`),
        fetch(`/api/properties/${propertyId}/day-use-durations`)
      ]);
      if (rulesRes.ok) {
        const rulesJson = await rulesRes.json();
        if (rulesJson.data?.rules) {
          setPropertyRules(rulesJson.data.rules);
        }
      }
      if (durRes.ok) {
        const durJson = await durRes.json();
        if (Array.isArray(durJson.data)) {
          setDayUseDurationsList(durJson.data);
        }
      }
    } catch (err) {
      console.warn('Failed to load FO property rules / day use durations', err);
    }
  };

  useEffect(() => {
    if (isOpen && propertyId) {
      loadInitialData();
    }
  }, [isOpen, propertyId]);

  // Complete state reset function for fresh booking session
  const resetQuickBookingState = useCallback(() => {
    setChannelType('WALKIN');
    setWalkinSubSource('DIRECT');
    setSelectedOtaSourceId(null);
    setIsOtaModalOpen(false);
    setReferral('');
    setSameAsBooker(true);
    setBookerName('');
    setBookerPhone('');
    setGuestName('');
    setGuestPhone('');
    setGuestSegment('Walk-in');
    setSelectedCrmGuest(null);
    setDuplicateCandidates([]);
    setShowDuplicateModal(false);
    setDuplicateBypassed(false);
    setIsIdentityModalOpen(false);
    setKtpPath(null);
    setIdentityNumber('');
    setHasValidIdentity(false);
    setIdentityFileName(null);
    setExtractedKtpData(null);
    setPaymentMethod('CASH');
    setAmountPaid(0);
    setBuktiBayarFile(null);
    setBuktiBayarPath(null);
    setSpecialRequests('');
    setSubmitting(false);
    setErrorMsg(null);
    setChargeWarningMap({});
  }, []);

  const prevIsOpenRef = useRef(false);
  const prevInitialRoomIdRef = useRef<number | null>(null);

  // Reset entirely on open/close for fresh new booking session
  useEffect(() => {
    const wasOpen = prevIsOpenRef.current;
    const prevInitialRoomId = prevInitialRoomIdRef.current;
    prevIsOpenRef.current = isOpen;
    prevInitialRoomIdRef.current = initialRoomId;

    if (isOpen) {
      if (!wasOpen || initialRoomId !== prevInitialRoomId) {
        resetQuickBookingState();
        setRoomsList([createInitialRoomDraft(0, initialRoomId)]);
      }
    } else if (wasOpen) {
      resetQuickBookingState();
    }
  }, [isOpen, initialRoomId, createInitialRoomDraft, resetQuickBookingState]);

  // Multi-room management actions
  const handleAddRoom = () => {
    const prevRoom = roomsList[roomsList.length - 1];
    const newRoom = createNewRoomDraft(roomsList.length, null);
    if (prevRoom) {
      newRoom.stayType = prevRoom.stayType;
      newRoom.checkIn = prevRoom.checkIn;
      newRoom.checkOut = prevRoom.checkOut;
      newRoom.dayUseHours = prevRoom.dayUseHours;
      newRoom.dayUseStartTime = prevRoom.dayUseStartTime;
      if (channelType === 'OTA' && prevRoom.manualOverridePrice) {
        newRoom.manualOverridePrice = prevRoom.manualOverridePrice;
      }
    }
    setRoomsList(prev => [...prev, newRoom]);
  };

  const handleRemoveRoom = (index: number) => {
    if (roomsList.length <= 1) return;
    setRoomsList(prev => prev.filter((_, i) => i !== index));
  };

  const handleUpdateRoom = (index: number, updates: Partial<RoomDraft>) => {
    setRoomsList(prev => {
      const copy = [...prev];
      copy[index] = { ...copy[index], ...updates };
      return copy;
    });
  };

  // Pricing Quotes for Each Room
  const fetchQuoteForRoom = useCallback(async (index: number, draft: RoomDraft) => {
    if (!draft.roomTypeId || !draft.checkIn || (draft.stayType !== 'DAY_USE' && !draft.checkOut)) return;
    try {
      handleUpdateRoom(index, { quoteLoading: true });
      const res = await fetch('/api/pricing/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: Number(propertyId),
          room_type_id: Number(draft.roomTypeId),
          rate_plan_id: draft.ratePlanId ? Number(draft.ratePlanId) : undefined,
          check_in: draft.checkIn,
          check_out: draft.stayType === 'DAY_USE' ? draft.checkIn : draft.checkOut,
          stay_type: draft.stayType,
          adults: draft.adults || 1,
          children: draft.children || 0
        })
      });
      const json = await res.json();
      if (res.ok && json.success && json.data) {
        const total = Number(json.data.grand_total || json.data.room_subtotal || 0);
        setRoomsList(prev => {
          if (!prev[index]) return prev;
          const copy = [...prev];
          const curr = copy[index];
          copy[index] = {
            ...curr,
            quoteLoading: false,
            roomNightlyRate: total,
            manualOverridePrice: curr.isManualOverride
              ? curr.manualOverridePrice
              : total
          };
          return copy;
        });
      } else {
        handleUpdateRoom(index, { quoteLoading: false });
      }
    } catch (err) {
      console.warn('Failed to fetch quote for room index', index, err);
      handleUpdateRoom(index, { quoteLoading: false });
    }
  }, [propertyId]);

  // Quote triggers
  useEffect(() => {
    roomsList.forEach((draft, idx) => {
      fetchQuoteForRoom(idx, draft);
    });
  }, [
    roomsList.map(r => r.roomTypeId + '-' + r.ratePlanId + '-' + r.checkIn + '-' + r.checkOut + '-' + r.stayType).join('|'),
    fetchQuoteForRoom
  ]);

  // Math Calculations for Each Room & Aggregates
  const roomCalculations = useMemo(() => {
    return roomsList.map((draft, idx) => {
      let nightsCount = 1;
      if (draft.stayType === 'OVERNIGHT') {
        try {
          const d1 = new Date(draft.checkIn);
          const d2 = new Date(draft.checkOut);
          const diff = Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
          nightsCount = diff > 0 ? diff : 0;
        } catch {
          nightsCount = 0;
        }
      }
      // For DAY_USE, stay is 1 unit. For OVERNIGHT, multiply manual nightly rate by nightsCount
      const effectiveNights = draft.stayType === 'DAY_USE' ? 1 : Math.max(0, nightsCount);
      const roomCharge = draft.isManualOverride
        ? Math.max(0, (Number(draft.manualOverridePrice) || 0) * effectiveNights)
        : Math.max(0, Number(draft.roomNightlyRate) || 0);

      const stayChargesTotal = draft.stayCharges.reduce((acc, curr) => acc + curr.amount, 0);
      
      let discountAmount = 0;
      if (draft.discountType === 'PERCENT') {
        discountAmount = Math.round((roomCharge + stayChargesTotal) * (Math.min(100, Math.max(0, draft.discountValue)) / 100));
      } else {
        discountAmount = Math.min(roomCharge + stayChargesTotal, Math.max(0, draft.discountValue));
      }

      const netSubtotal = Math.max(0, roomCharge + stayChargesTotal - discountAmount);

      const matchedRoom = rooms.find(r => Number(r.id) === Number(draft.roomId));
      const matchedType = roomTypes.find(rt => Number(rt.id) === Number(draft.roomTypeId));

      return {
        index: idx,
        roomLabel: 'Kamar ' + (idx + 1),
        roomNumber: matchedRoom?.room_number || matchedRoom?.name || 'Belum dipilih',
        roomTypeName: matchedType?.name || 'Tipe Kamar',
        nights: nightsCount,
        nightlyRate: draft.isManualOverride ? Number(draft.manualOverridePrice || 0) : (draft.stayType === 'OVERNIGHT' && nightsCount > 0 ? Math.round(roomCharge / nightsCount) : roomCharge),
        roomCharge,
        stayChargesTotal,
        discountAmount,
        netSubtotal
      };
    });
  }, [roomsList, rooms, roomTypes]);

  const totalStayCharges = useMemo(() => roomCalculations.reduce((s, c) => s + c.stayChargesTotal, 0), [roomCalculations]);
  const totalDiscounts = useMemo(() => roomCalculations.reduce((s, c) => s + c.discountAmount, 0), [roomCalculations]);
  const grandTotal = useMemo(() => roomCalculations.reduce((s, c) => s + c.netSubtotal, 0), [roomCalculations]);
  const remainingBill = Math.max(0, grandTotal - amountPaid);

  // Auto-sync amountPaid when grandTotal changes if it was full or 0
  useEffect(() => {
    if (amountPaid === 0 || amountPaid > grandTotal) {
      setAmountPaid(grandTotal);
    }
  }, [grandTotal]);

  // CRM guest selection
  const handleSelectGuest = (guest: Guest) => {
    setSelectedCrmGuest(guest);
    setGuestName(guest.full_name);
    if (guest.phone) setGuestPhone(guest.phone);
    if (guest.guest_segment) {
      const validSegments = ['Reguler', 'Group', 'Corporate', 'Walk-in'];
      if (validSegments.includes(guest.guest_segment)) {
        setGuestSegment(guest.guest_segment as any);
      }
    }
    if (guest.identity_number) setIdentityNumber(guest.identity_number);
    if (guest.identity_path) setKtpPath(guest.identity_path);
    if (guest.has_valid_identity || guest.identity_number || guest.identity_path) {
      setHasValidIdentity(true);
    }
    setDuplicateCandidates([]);
    setShowDuplicateModal(false);
  };

  const handleClearGuest = () => {
    setSelectedCrmGuest(null);
    setDuplicateBypassed(false);
  };

  const [extractedKtpData, setExtractedKtpData] = useState<ExtractedIdentityData | null>(null);

  // OCR Identity confirmation
  const handleIdentityConfirmed = (data: ExtractedIdentityData, savedGuest?: Guest | null) => {
    setExtractedKtpData(data);
    setGuestName(data.full_name);
    setIdentityNumber(data.identity_number);
    setKtpPath(data.file_path);
    setHasValidIdentity(true);
    setIdentityFileName(data.file_path ? data.file_path.split('/').pop() || 'KTP' : 'KTP');

    if (savedGuest) {
      setSelectedCrmGuest(savedGuest);
      if (savedGuest.phone && !guestPhone) {
        setGuestPhone(savedGuest.phone);
      }
    }
  };

  const [chargeWarningMap, setChargeWarningMap] = useState<Record<number, string | null>>({});

  // Stay Charges Management for specific room
  const handleAddStayChargeToRoom = (roomIndex: number, ruleOrType: any) => {
    const rulesList = internalStayChargeRules.length > 0 ? internalStayChargeRules : stayChargeRules;
    const ruleType = typeof ruleOrType === 'string' ? ruleOrType : (ruleOrType?.charge_type || 'EXTRA_BED');
    const rule = (typeof ruleOrType === 'object' && ruleOrType?.name)
      ? ruleOrType
      : rulesList.find((r: any) => r.id === ruleOrType?.id || r.charge_type === ruleType || r.code === ruleType);

    const roomDraft = roomsList[roomIndex];
    const roomRate = roomDraft
      ? (roomDraft.isManualOverride ? roomDraft.manualOverridePrice : roomDraft.roomNightlyRate)
      : 0;

    const targetCharges = [...roomDraft.stayCharges];

    // Single-occurrence check for EARLY_CHECKIN and LATE_CHECKOUT
    if (ruleType === 'EARLY_CHECKIN' || ruleType === 'LATE_CHECKOUT') {
      const alreadyHas = targetCharges.some(it => it.charge_type === ruleType);
      if (alreadyHas) {
        setChargeWarningMap(prev => ({
          ...prev,
          [roomIndex]: `Layanan ${rule?.name || ruleType} sudah ditambahkan pada kamar ini.`
        }));
        setTimeout(() => {
          setChargeWarningMap(prev => ({ ...prev, [roomIndex]: null }));
        }, 4000);
        return;
      }
    }

    setChargeWarningMap(prev => ({ ...prev, [roomIndex]: null }));

    // Quantity merge for items that already exist and are not single-occurrence
    const existingIdx = targetCharges.findIndex(
      it => (rule?.id && it.rule_id === rule.id) || (it.charge_type === ruleType && it.description === (rule?.name || ruleType))
    );

    if (existingIdx >= 0 && ruleType !== 'EARLY_CHECKIN' && ruleType !== 'LATE_CHECKOUT') {
      const existing = targetCharges[existingIdx];
      const updatedQty = existing.quantity + 1;
      targetCharges[existingIdx] = {
        ...existing,
        quantity: updatedQty,
        amount: updatedQty * existing.unit_price
      };
      setRoomsList(prev => {
        const copy = [...prev];
        copy[roomIndex] = { ...copy[roomIndex], stayCharges: targetCharges };
        return copy;
      });
      return;
    }

    // Resolve Authoritative Master Price
    let unitPrice = 0;
    let isManual = false;
    const chargeMethod = rule?.charge_method || rule?.calculation_type || 'FIXED_AMOUNT';

    if (rule) {
      if (chargeMethod === 'FIXED_AMOUNT' || chargeMethod === 'FIXED') {
        unitPrice = Number(rule.default_amount ?? rule.default_price ?? 0);
      } else if (chargeMethod === 'FREE') {
        unitPrice = 0;
      } else if (chargeMethod === 'FULL_NIGHT' || chargeMethod === 'FULL_NIGHT_RATE') {
        unitPrice = roomRate > 0 ? roomRate : 0;
      } else if (chargeMethod === 'PERCENTAGE_OF_NIGHTLY_RATE' || chargeMethod === 'PERCENT_ROOM_RATE') {
        const pct = Number(rule.percentage_rate ?? rule.percentage_of_rate ?? 50);
        unitPrice = roomRate > 0 ? Math.round((roomRate * pct) / 100) : 0;
      } else if (chargeMethod === 'MANUAL') {
        unitPrice = 0;
        isManual = true;
      }
    } else {
      unitPrice = ruleType === 'EXTRA_BED' ? 150000 : ruleType === 'EXTRA_PERSON' ? 100000 : 50000;
    }

    const isTaxable = rule ? (rule.taxable ?? rule.is_taxable ?? (rule.charge_type !== 'PENALTY')) : true;
    const isServiceChargeable = rule ? (rule.service_chargeable ?? rule.is_service_chargeable ?? (rule.charge_type !== 'PENALTY')) : true;
    const desc = rule?.name || ('Layanan: ' + ruleType);

    const newItem: StayChargeLineItem = {
      id: 'sc-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7),
      rule_id: rule?.id,
      code: rule?.code,
      charge_type: ruleType,
      charge_method: chargeMethod,
      description: desc,
      quantity: 1,
      unit_price: unitPrice,
      amount: unitPrice,
      original_unit_price: unitPrice,
      is_manual: isManual,
      is_override: false,
      isOverrideOpen: false,
      taxable: isTaxable,
      service_chargeable: isServiceChargeable
    };

    targetCharges.push(newItem);

    setRoomsList(prev => {
      const copy = [...prev];
      copy[roomIndex] = { ...copy[roomIndex], stayCharges: targetCharges };
      return copy;
    });
  };

  const handleRemoveStayChargeFromRoom = (roomIndex: number, itemId: string) => {
    setRoomsList(prev => {
      const copy = [...prev];
      copy[roomIndex] = {
        ...copy[roomIndex],
        stayCharges: copy[roomIndex].stayCharges.filter(it => it.id !== itemId)
      };
      return copy;
    });
  };

  const handleUpdateStayChargeQty = (roomIndex: number, itemId: string, qty: number) => {
    setRoomsList(prev => {
      const copy = [...prev];
      copy[roomIndex] = {
        ...copy[roomIndex],
        stayCharges: copy[roomIndex].stayCharges.map(it => {
          if (it.id === itemId) {
            const safeQty = Math.max(1, qty);
            return {
              ...it,
              quantity: safeQty,
              amount: safeQty * it.unit_price
            };
          }
          return it;
        })
      };
      return copy;
    });
  };

  const handleToggleStayChargeOverride = (roomIndex: number, itemId: string) => {
    setRoomsList(prev => {
      const copy = [...prev];
      copy[roomIndex] = {
        ...copy[roomIndex],
        stayCharges: copy[roomIndex].stayCharges.map(it => {
          if (it.id === itemId) {
            return { ...it, isOverrideOpen: !it.isOverrideOpen };
          }
          return it;
        })
      };
      return copy;
    });
  };

  const handleSaveStayChargeOverride = (roomIndex: number, itemId: string, overrideAmount: number, overrideReason: string) => {
    if (!overrideReason.trim()) {
      alert('Alasan override harga wajib diisi');
      return;
    }
    setRoomsList(prev => {
      const copy = [...prev];
      copy[roomIndex] = {
        ...copy[roomIndex],
        stayCharges: copy[roomIndex].stayCharges.map(it => {
          if (it.id === itemId) {
            const price = Math.max(0, overrideAmount);
            return {
              ...it,
              is_override: true,
              override_amount: price,
              override_reason: overrideReason.trim(),
              unit_price: price,
              amount: price * it.quantity,
              isOverrideOpen: false
            };
          }
          return it;
        })
      };
      return copy;
    });
  };

  const handleResetStayChargeOverride = (roomIndex: number, itemId: string) => {
    setRoomsList(prev => {
      const copy = [...prev];
      copy[roomIndex] = {
        ...copy[roomIndex],
        stayCharges: copy[roomIndex].stayCharges.map(it => {
          if (it.id === itemId) {
            const origPrice = it.original_unit_price ?? it.unit_price;
            return {
              ...it,
              is_override: false,
              override_amount: undefined,
              override_reason: undefined,
              unit_price: origPrice,
              amount: origPrice * it.quantity,
              isOverrideOpen: false
            };
          }
          return it;
        })
      };
      return copy;
    });
  };

  const handleUpdateManualStayCharge = (roomIndex: number, itemId: string, amount: number, notes?: string) => {
    setRoomsList(prev => {
      const copy = [...prev];
      copy[roomIndex] = {
        ...copy[roomIndex],
        stayCharges: copy[roomIndex].stayCharges.map(it => {
          if (it.id === itemId) {
            const safeAmt = Math.max(0, amount);
            return {
              ...it,
              unit_price: safeAmt,
              amount: safeAmt * it.quantity,
              notes: notes !== undefined ? notes : it.notes
            };
          }
          return it;
        })
      };
      return copy;
    });
  };

  // Upload Bukti Bayar
  const handleBuktiBayarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setBuktiBayarFile(file);
      const formData = new FormData();
      formData.append('file', file);
      try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (res.ok && data.url) {
          setBuktiBayarPath(data.url);
        }
      } catch (err) {
        console.warn('Failed to upload payment receipt', err);
      }
    }
  };

  // Gate Validation
  const validationIssues = useMemo(() => {
    const issues: string[] = [];

    // Booker Validation
    if (!sameAsBooker) {
      if (getFieldMode('booker_name') === 'REQUIRED' && !bookerName.trim()) {
        issues.push('Nama pemesan (Booker) wajib diisi');
      }
      if (getFieldMode('booker_phone') === 'REQUIRED' && !bookerPhone.trim()) {
        issues.push('Nomor HP pemesan wajib diisi');
      }
    }

    // Guest Validation
    if (getFieldMode('guest_name') === 'REQUIRED' && !guestName.trim()) {
      issues.push('Nama tamu menginap wajib diisi');
    }
    if (getFieldMode('guest_phone') === 'REQUIRED' && !guestPhone.trim()) {
      issues.push('Nomor HP tamu menginap wajib diisi');
    }

    // Identity Gate
    if (getFieldMode('identity') === 'REQUIRED' && !hasValidIdentity && !ktpPath && !identityNumber.trim()) {
      issues.push('Dokumen identitas (KTP) wajib dilampirkan atau diisi NIK');
    }

    // Rate Plan Gate (only for non-OTA channels)
    if (channelType !== 'OTA' && getFieldMode('rate_plan') === 'REQUIRED' && roomsList.some(r => !r.ratePlanId)) {
      issues.push('Rate plan wajib dipilih untuk setiap kamar');
    }

    // OTA Source Gate
    if (channelType === 'OTA') {
      if (!selectedOtaSourceId) {
        issues.push('Pilih salah satu platform OTA');
      }
      if (!referral.trim()) {
        issues.push('Nomor booking / kode voucher OTA wajib diisi');
      }
    }

    // Payment Proof Gate
    if ((getFieldMode('payment_evidence') === 'REQUIRED' || amountPaid > 0) && !buktiBayarFile && !buktiBayarPath && amountPaid > 0) {
      issues.push('Bukti pembayaran wajib diunggah untuk nominal pembayaran > 0');
    }

    // Multi-room Validation
    if (roomsList.length === 0) {
      issues.push('Minimal 1 kamar harus dipilih');
    }

    const assignedRoomIds = new Set<number>();
    roomsList.forEach((r, idx) => {
      const label = 'Kamar ' + (idx + 1);
      if (!r.roomTypeId) issues.push(label + ': Tipe kamar belum dipilih');
      if (!r.roomId) issues.push(label + ': Nomor kamar fisik belum dipilih');
      if (!r.checkIn) issues.push(label + ': Tanggal check-in wajib diisi');
      if (r.stayType === 'OVERNIGHT' && !r.checkOut) issues.push(label + ': Tanggal check-out wajib diisi');
      if (r.stayType === 'OVERNIGHT' && r.checkIn && r.checkOut && r.checkIn >= r.checkOut) {
        issues.push(label + ': Tanggal check-out harus setelah check-in');
      }
      if (channelType === 'OTA') {
        if (!r.manualOverridePrice || Number(r.manualOverridePrice) <= 0) {
          issues.push(label + ': Tarif kamar OTA per malam wajib diisi dengan nominal lebih dari 0');
        }
      } else {
        if (r.isManualOverride && !r.manualOverrideReason.trim()) {
          issues.push(label + ': Alasan override harga manual wajib diisi');
        }
      }
      if (r.roomId) {
        if (assignedRoomIds.has(r.roomId)) {
          issues.push(label + ': Kamar fisik yang sama tidak boleh dipilih dua kali pada reservasi ini');
        }
        assignedRoomIds.add(r.roomId);
      }
    });

    return issues;
  }, [
    sameAsBooker,
    bookerName,
    bookerPhone,
    guestName,
    guestPhone,
    hasValidIdentity,
    ktpPath,
    identityNumber,
    channelType,
    selectedOtaSourceId,
    referral,
    amountPaid,
    buktiBayarFile,
    buktiBayarPath,
    roomsList,
    getFieldMode
  ]);

  const isValid = validationIssues.length === 0;

  // Submit Handler
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!isValid) {
      setErrorMsg('Harap lengkapi semua persyaratan:\n' + validationIssues.join('\n'));
      return;
    }

    try {
      setSubmitting(true);

      if (!selectedCrmGuest && !duplicateBypassed && guestPhone.trim().length >= 7) {
        try {
          const dupRes = await fetch('/api/guests/duplicate-check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              property_id: propertyId,
              full_name: guestName.trim(),
              phone: guestPhone.trim(),
              identity_number: identityNumber.trim() || undefined
            })
          });
          if (dupRes.ok) {
            const dupData = await dupRes.json();
            if (dupData.data?.has_duplicate && dupData.data.candidates?.length > 0) {
              setDuplicateCandidates(dupData.data.candidates);
              setShowDuplicateModal(true);
              setSubmitting(false);
              return;
            }
          }
        } catch (dupErr) {
          console.warn('Non-blocking duplicate check error:', dupErr);
        }
      }

      const bookingSource = channelType === 'OTA'
        ? (otaSources.find(o => o.id === selectedOtaSourceId)?.name || 'OTA')
        : walkinSubSource;

      const payload = {
        property_id: propertyId,
        guest_id: selectedCrmGuest?.id || undefined,
        guest_name: guestName.trim(),
        guest_phone: guestPhone.trim(),
        guest_segment: guestSegment,
        booker_name: sameAsBooker ? guestName.trim() : bookerName.trim(),
        booker_phone: sameAsBooker ? guestPhone.trim() : bookerPhone.trim(),
        booker_same_as_guest: sameAsBooker,
        booking_source: bookingSource,
        booking_channel: channelType === 'OTA' ? 'OTA' : 'WALK_IN',
        ota_source_id: channelType === 'OTA' ? selectedOtaSourceId : null,
        referral: referral.trim() || undefined,
        ktp_path: ktpPath || undefined,
        identity_number: identityNumber.trim() || undefined,
        has_valid_identity: hasValidIdentity || Boolean(selectedCrmGuest?.has_valid_identity || selectedCrmGuest?.identity_number || selectedCrmGuest?.identity_path),
        birth_place: extractedKtpData?.birth_place || selectedCrmGuest?.birth_place || undefined,
        birth_date: extractedKtpData?.birth_date || selectedCrmGuest?.birth_date || undefined,
        gender: extractedKtpData?.gender || selectedCrmGuest?.gender || undefined,
        address: extractedKtpData?.address || selectedCrmGuest?.address || undefined,
        rt_rw: extractedKtpData?.rt_rw || selectedCrmGuest?.rt_rw || undefined,
        village_kelurahan: extractedKtpData?.village_kelurahan || selectedCrmGuest?.village_kelurahan || undefined,
        district_kecamatan: extractedKtpData?.district_kecamatan || selectedCrmGuest?.district_kecamatan || undefined,
        religion: extractedKtpData?.religion || selectedCrmGuest?.religion || undefined,
        marital_status: extractedKtpData?.marital_status || selectedCrmGuest?.marital_status || undefined,
        occupation: extractedKtpData?.occupation || selectedCrmGuest?.occupation || undefined,
        citizenship: extractedKtpData?.citizenship || selectedCrmGuest?.citizenship || undefined,
        valid_until: extractedKtpData?.valid_until || selectedCrmGuest?.valid_until || undefined,
        ktp_ocr_confidence: extractedKtpData?.confidence || selectedCrmGuest?.ktp_ocr_confidence || undefined,
        ktp_ocr_provider: extractedKtpData?.provider || selectedCrmGuest?.ktp_ocr_provider || undefined,
        payment_method: paymentMethod,
        amount_paid: amountPaid,
        bukti_bayar_path: buktiBayarPath || undefined,
        require_strict_gates: true,
        special_requests: specialRequests.trim() || undefined,
        reservations: roomsList.map((r, idx) => {
          const calc = roomCalculations[idx];
          return {
            guest_id: selectedCrmGuest?.id || undefined,
            room_id: r.roomId,
            room_type_id: r.roomTypeId,
            guest_name: guestName.trim(),
            guest_phone: guestPhone.trim(),
            guest_segment: guestSegment,
            booker_name: sameAsBooker ? guestName.trim() : bookerName.trim(),
            booker_phone: sameAsBooker ? guestPhone.trim() : bookerPhone.trim(),
            booking_type: bookingSource,
            booking_channel: channelType === 'OTA' ? 'OTA' : 'WALK_IN',
            ota_source_id: channelType === 'OTA' ? selectedOtaSourceId : null,
            referral: referral.trim() || undefined,
            check_in: r.checkIn,
            check_out: r.stayType === 'DAY_USE' ? r.checkIn : r.checkOut,
            stay_type: r.stayType,
            start_at: r.stayType === 'DAY_USE' ? (r.checkIn + 'T' + r.dayUseStartTime + ':00') : undefined,
            end_at: r.stayType === 'DAY_USE' ? (r.checkIn + 'T' + r.dayUseStartTime + ':00') : undefined,
            rate_plan_id: channelType === 'OTA' ? undefined : (r.ratePlanId ? Number(r.ratePlanId) : undefined),
            subtotal_amount: calc.roomCharge,
            tax_amount: 0,
            service_amount: 0,
            total_price: calc.netSubtotal,
            is_manual_override: channelType === 'OTA' ? true : Boolean(r.isManualOverride),
            manual_override_reason: channelType === 'OTA'
              ? (r.manualOverrideReason || (selectedOtaSourceName ? `OTA: ${selectedOtaSourceName}` : 'OTA Booking'))
              : (r.isManualOverride ? r.manualOverrideReason : undefined),
            discount_amount: calc.discountAmount,
            discount_type: r.discountType,
            discount_value: r.discountValue,
            discount_reason: r.discountReason.trim() || undefined,
            stay_charges: r.stayCharges,
            amount_paid: idx === 0 ? amountPaid : 0,
            payment_status: amountPaid >= grandTotal ? 'PAID' : (amountPaid > 0 ? 'PARTIAL' : 'UNPAID'),
            payment_method: paymentMethod,
            ktp_path: ktpPath || undefined,
            identity_number: identityNumber.trim() || undefined,
            has_valid_identity: hasValidIdentity || Boolean(selectedCrmGuest?.has_valid_identity || selectedCrmGuest?.identity_number || selectedCrmGuest?.identity_path),
            birth_place: extractedKtpData?.birth_place || selectedCrmGuest?.birth_place || undefined,
            birth_date: extractedKtpData?.birth_date || selectedCrmGuest?.birth_date || undefined,
            gender: extractedKtpData?.gender || selectedCrmGuest?.gender || undefined,
            address: extractedKtpData?.address || selectedCrmGuest?.address || undefined,
            rt_rw: extractedKtpData?.rt_rw || selectedCrmGuest?.rt_rw || undefined,
            village_kelurahan: extractedKtpData?.village_kelurahan || selectedCrmGuest?.village_kelurahan || undefined,
            district_kecamatan: extractedKtpData?.district_kecamatan || selectedCrmGuest?.district_kecamatan || undefined,
            religion: extractedKtpData?.religion || selectedCrmGuest?.religion || undefined,
            marital_status: extractedKtpData?.marital_status || selectedCrmGuest?.marital_status || undefined,
            occupation: extractedKtpData?.occupation || selectedCrmGuest?.occupation || undefined,
            citizenship: extractedKtpData?.citizenship || selectedCrmGuest?.citizenship || undefined,
            valid_until: extractedKtpData?.valid_until || selectedCrmGuest?.valid_until || undefined,
            ktp_ocr_confidence: extractedKtpData?.confidence || selectedCrmGuest?.ktp_ocr_confidence || undefined,
            ktp_ocr_provider: extractedKtpData?.provider || selectedCrmGuest?.ktp_ocr_provider || undefined,
            bukti_bayar_path: buktiBayarPath || undefined,
            special_requests: specialRequests.trim() || undefined,
            qty: 1
          };
        })
      };

      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.message || 'Gagal membuat reservasi.');
      }

      onBookingSuccess();
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Terjadi kesalahan saat membuat booking.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 overflow-y-auto bg-black/65 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5">
        <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-6xl border border-emerald-900/15 overflow-hidden flex flex-col max-h-[94vh]">
          {/* Header */}
          <div className="px-6 py-4 bg-gradient-to-r from-emerald-950 via-emerald-900 to-teal-950 text-white flex items-center justify-between border-b border-emerald-800/40">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-emerald-800/60 rounded-xl border border-emerald-700/50">
                <svg className="w-5 h-5 text-emerald-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold tracking-tight text-white">Reservasi Cepat (Quick Booking)</h2>
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-700/80 text-emerald-100 font-semibold border border-emerald-600/50">
                    Multi-Kamar
                  </span>
                </div>
                <p className="text-xs text-emerald-300/80">Input reservasi satu atau banyak kamar dengan validasi dokumen & pembayaran</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-emerald-300 hover:text-white p-2 rounded-lg hover:bg-emerald-800/40 transition-colors cursor-pointer"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Body: 70/30 Grid */}
          <div className="flex-1 overflow-hidden grid grid-cols-1 lg:grid-cols-12 bg-stone-100/60 divide-y lg:divide-y-0 lg:divide-x divide-stone-200">
            {/* Left 70% Form Area */}
            <div className="lg:col-span-8 p-6 overflow-y-auto space-y-6">
              {errorMsg && (
                <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-start gap-3">
                  <svg className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div>
                    <strong className="font-semibold">Gagal membuat reservasi:</strong>
                    <p className="mt-0.5 whitespace-pre-line">{errorMsg}</p>
                  </div>
                </div>
              )}

              {/* SEKSI 1: SUMBER RESERVASI */}
              <div className="bg-white p-5 rounded-2xl border border-stone-200/80 shadow-xs space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-950 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-700"></span>
                    1. Sumber Reservasi (Booking Source)
                  </h3>
                  {channelType === 'OTA' && (
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
                    onClick={() => setChannelType('WALKIN')}
                    className={'py-2 text-xs font-bold rounded-lg transition-all cursor-pointer ' + (
                      channelType === 'WALKIN'
                        ? 'bg-emerald-800 text-white shadow-sm'
                        : 'text-stone-600 hover:text-stone-900'
                    )}
                  >
                    🚶 WALK-IN / DIRECT
                  </button>
                  <button
                    type="button"
                    onClick={() => setChannelType('OTA')}
                    className={'py-2 text-xs font-bold rounded-lg transition-all cursor-pointer ' + (
                      channelType === 'OTA'
                        ? 'bg-emerald-800 text-white shadow-sm'
                        : 'text-stone-600 hover:text-stone-900'
                    )}
                  >
                    🌐 ONLINE TRAVEL AGENT (OTA)
                  </button>
                </div>

                {channelType === 'WALKIN' ? (
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { id: 'DIRECT', label: 'Resepsionis / Langsung' },
                      { id: 'PHONE_WA', label: 'Telepon / WhatsApp' },
                      { id: 'WEBSITE', label: 'Website Hotel' }
                    ].map(sub => (
                      <button
                        key={sub.id}
                        type="button"
                        onClick={() => setWalkinSubSource(sub.id as any)}
                        className={'p-2.5 rounded-xl text-xs font-semibold border transition-all text-center cursor-pointer ' + (
                          walkinSubSource === sub.id
                            ? 'bg-emerald-50 border-emerald-600 text-emerald-950 font-bold'
                            : 'bg-stone-50 border-stone-200 text-stone-600 hover:bg-stone-100'
                        )}
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
                        value={selectedOtaSourceId || ''}
                        onChange={e => setSelectedOtaSourceId(Number(e.target.value))}
                        className="w-full text-xs px-3 py-2.5 bg-stone-50 border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
                      >
                        {otaSources.map(o => (
                          <option key={o.id} value={o.id}>
                            {o.name} {o.commission_rate_percent ? ('(Komisi ' + o.commission_rate_percent + '%)') : ''}
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
                        onChange={e => setReferral(e.target.value)}
                        placeholder="Contoh: BKG-987214"
                        className="w-full text-xs px-3.5 py-2.5 bg-stone-50 border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none font-mono"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* SEKSI 2: DATA PEMESAN VS DATA TAMU */}
              <div className="bg-white p-5 rounded-2xl border border-stone-200/80 shadow-xs space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-950 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-700"></span>
                    2. Data Pemesan & Tamu Menginap
                  </h3>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={sameAsBooker}
                      onChange={e => setSameAsBooker(e.target.checked)}
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
                          onChange={e => setBookerName(e.target.value)}
                          placeholder="Nama lengkap pemesan..."
                          className="w-full text-xs px-3.5 py-2.5 bg-white border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-stone-700 mb-1">
                          Nomor HP Pemesan <span className="text-rose-500">*</span>
                        </label>
                        <input
                          type="tel"
                          required
                          value={bookerPhone}
                          onChange={e => setBookerPhone(e.target.value)}
                          placeholder="08xxxxxxxxxx"
                          className="w-full text-xs px-3.5 py-2.5 bg-white border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 outline-none font-mono"
                        />
                      </div>
                    </div>
                  </div>
                )}

                <div className="space-y-3">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-stone-500">
                    Tamu Menginap (Staying Guest)
                  </span>
                  
                  <GuestSearchAutocomplete
                    propertyId={propertyId}
                    value={guestName}
                    onChange={name => setGuestName(name)}
                    onSelectGuest={handleSelectGuest}
                    onClearGuest={handleClearGuest}
                    selectedGuest={selectedCrmGuest}
                  />

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-semibold text-stone-700 mb-1">
                        Nama Tamu Menginap <span className="text-rose-500">*</span>
                      </label>
                      <input
                        type="text"
                        required
                        value={guestName}
                        onChange={e => setGuestName(e.target.value)}
                        placeholder="Nama lengkap tamu..."
                        className="w-full text-xs px-3.5 py-2.5 bg-stone-50 border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-stone-700 mb-1">
                        Nomor HP Tamu <span className="text-rose-500">*</span>
                      </label>
                      <input
                        type="tel"
                        required
                        value={guestPhone}
                        onChange={e => setGuestPhone(e.target.value)}
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
                      {['Walk-in', 'Reguler', 'Corporate', 'Group'].map(seg => (
                        <button
                          key={seg}
                          type="button"
                          onClick={() => setGuestSegment(seg as any)}
                          className={'px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all cursor-pointer ' + (
                            guestSegment === seg
                              ? 'bg-emerald-800 text-white border-emerald-900'
                              : 'bg-stone-50 text-stone-600 border-stone-200 hover:bg-stone-100'
                          )}
                        >
                          {seg}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* SEKSI 3: DOKUMEN IDENTITAS (KTP) */}
              <div className="bg-white p-5 rounded-2xl border border-stone-200/80 shadow-xs space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-950 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-700"></span>
                    3. Dokumen Identitas Tamu (KTP) <span className="text-rose-500">*</span>
                  </h3>
                  {hasValidIdentity && (
                    <span className="text-[11px] px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold border border-emerald-200">
                      ✓ Terverifikasi
                    </span>
                  )}
                </div>

                {hasValidIdentity || ktpPath || identityNumber ? (
                  <div className="p-4 bg-emerald-50/50 rounded-xl border border-emerald-200 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-emerald-800 text-white rounded-lg">
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </div>
                      <div>
                        <div className="text-xs font-bold text-emerald-950">
                          {identityFileName || 'Dokumen KTP Tersimpan'}
                        </div>
                        <p className="text-[11px] text-emerald-800 font-mono">
                          NIK: {identityNumber || '—'}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsIdentityModalOpen(true)}
                      className="text-xs text-emerald-800 underline font-semibold hover:text-emerald-950 cursor-pointer"
                    >
                      Detail
                    </button>
                  </div>
                ) : (
                  <div className="p-4 rounded-xl border-2 border-dashed border-stone-300 text-center space-y-2 bg-stone-50/50">
                    <p className="text-xs text-stone-500">
                      Wajib melampirkan foto KTP atau memilih tamu yang sudah memiliki KTP tersimpan.
                    </p>
                    <button
                      type="button"
                      onClick={() => setIsIdentityModalOpen(true)}
                      className="px-4 py-2 bg-emerald-800 hover:bg-emerald-700 text-white rounded-xl text-xs font-semibold shadow-sm transition-colors cursor-pointer"
                    >
                      Unggah KTP Sekarang
                    </button>
                  </div>
                )}
              </div>

              {/* SEKSI 4 & 5: KAMAR & DETAIL MENGINAP (MULTI-ROOM SUPPORT) */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-950 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-700"></span>
                    4. Daftar Kamar Reservasi ({roomsList.length} Kamar)
                  </h3>
                  <button
                    type="button"
                    onClick={handleAddRoom}
                    className="px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-300 rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-2xs transition-all cursor-pointer"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    + Tambah Kamar
                  </button>
                </div>

                {roomsList.map((roomDraft, roomIdx) => {
                  const calc = roomCalculations[roomIdx] || {
                    roomCharge: 0,
                    stayChargesTotal: 0,
                    discountAmount: 0,
                    netSubtotal: 0
                  };

                  const isDayUse = roomDraft.stayType === 'DAY_USE';
                  const availableRPlans = (internalRatePlans.length > 0 ? internalRatePlans : ratePlans).filter(
                    (rp: any) => {
                      if (!matchRatePlanToRoomType(rp, roomDraft.roomTypeId)) return false;
                      return isDayUse ? rp.rate_type === 'DAY_USE' : rp.rate_type !== 'DAY_USE';
                    }
                  );

                  return (
                    <div
                      key={roomDraft.id}
                      className="bg-white p-5 rounded-2xl border border-stone-200/90 shadow-xs space-y-4"
                    >
                      {/* Room Card Header */}
                      <div className="flex items-center justify-between pb-3 border-b border-stone-100">
                        <div className="flex items-center gap-2">
                          <span className="px-2.5 py-1 bg-emerald-900 text-emerald-100 text-xs font-bold rounded-lg uppercase tracking-wider">
                            Kamar {roomIdx + 1}
                          </span>
                          <span className="text-xs text-stone-500 font-medium">
                            {calc.roomTypeName} • {calc.roomNumber}
                          </span>
                        </div>
                        {roomsList.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleRemoveRoom(roomIdx)}
                            className="text-xs text-rose-700 hover:text-rose-900 font-semibold flex items-center gap-1 cursor-pointer"
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                            Hapus
                          </button>
                        )}
                      </div>

                      {/* Stay Type & Dates */}
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold uppercase tracking-wider text-stone-500">
                            Waktu & Durasi Menginap
                          </span>
                          {isDayUseAllowed && (
                            <div className="flex items-center gap-1 p-0.5 bg-stone-100 rounded-lg text-xs font-semibold">
                              <button
                                type="button"
                                onClick={() => {
                                  let newCheckOut = roomDraft.checkOut;
                                  if (!newCheckOut || newCheckOut <= roomDraft.checkIn) {
                                    const d = new Date(roomDraft.checkIn || todayStr);
                                    d.setDate(d.getDate() + 1);
                                    newCheckOut = d.toISOString().slice(0, 10);
                                  }
                                  const allPlans = internalRatePlans.length > 0 ? internalRatePlans : ratePlans;
                                  const matchingPlan = allPlans.find(
                                    (rp: any) => matchRatePlanToRoomType(rp, roomDraft.roomTypeId) && rp.rate_type !== 'DAY_USE'
                                  );
                                  handleUpdateRoom(roomIdx, {
                                    stayType: 'OVERNIGHT',
                                    checkOut: newCheckOut,
                                    ratePlanId: matchingPlan ? Number(matchingPlan.id) : null
                                  });
                                }}
                                className={'px-2.5 py-1 rounded-md transition-all cursor-pointer ' + (
                                  roomDraft.stayType === 'OVERNIGHT' ? 'bg-white text-emerald-950 shadow-xs font-bold' : 'text-stone-600'
                                )}
                              >
                                Menginap
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  const allPlans = internalRatePlans.length > 0 ? internalRatePlans : ratePlans;
                                  const matchingDayPlan = allPlans.find(
                                    (rp: any) => matchRatePlanToRoomType(rp, roomDraft.roomTypeId) && rp.rate_type === 'DAY_USE'
                                  );
                                  handleUpdateRoom(roomIdx, {
                                    stayType: 'DAY_USE',
                                    checkOut: roomDraft.checkIn,
                                    ratePlanId: matchingDayPlan ? Number(matchingDayPlan.id) : null
                                  });
                                }}
                                className={'px-2.5 py-1 rounded-md transition-all cursor-pointer ' + (
                                  roomDraft.stayType === 'DAY_USE' ? 'bg-white text-emerald-950 shadow-xs font-bold' : 'text-stone-600'
                                )}
                              >
                                Day Use
                              </button>
                            </div>
                          )}
                        </div>

                        {roomDraft.stayType === 'OVERNIGHT' ? (
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                            <div>
                              <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                                Check-in Date <span className="text-rose-500">*</span>
                              </label>
                              <input
                                type="date"
                                required
                                value={roomDraft.checkIn}
                                onChange={e => {
                                  const newCheckIn = e.target.value;
                                  let newCheckOut = roomDraft.checkOut;
                                  if (newCheckOut && newCheckOut <= newCheckIn) {
                                    const d = new Date(newCheckIn);
                                    d.setDate(d.getDate() + 1);
                                    newCheckOut = d.toISOString().slice(0, 10);
                                  }
                                  handleUpdateRoom(roomIdx, { checkIn: newCheckIn, checkOut: newCheckOut });
                                }}
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
                                min={roomDraft.checkIn}
                                value={roomDraft.checkOut}
                                onChange={e => handleUpdateRoom(roomIdx, { checkOut: e.target.value })}
                                className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl font-mono"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                                Durasi
                              </label>
                              <div className="w-full text-xs px-3 py-2 bg-stone-100 border border-stone-200 rounded-xl font-bold text-stone-700">
                                {calc.nights} Malam
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
                                value={roomDraft.checkIn}
                                onChange={e => handleUpdateRoom(roomIdx, { checkIn: e.target.value, checkOut: e.target.value })}
                                className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl font-mono"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                                Jam Mulai (Interval 30 mnt)
                              </label>
                              <input
                                type="time"
                                step={1800}
                                value={roomDraft.dayUseStartTime}
                                onChange={e => handleUpdateRoom(roomIdx, { dayUseStartTime: e.target.value })}
                                className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl font-mono"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                                Durasi Day Use
                              </label>
                              <select
                                value={roomDraft.dayUseHours}
                                onChange={e => handleUpdateRoom(roomIdx, { dayUseHours: Number(e.target.value) })}
                                className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl font-medium"
                              >
                                {(dayUseDurationsList.length > 0 ? dayUseDurationsList : [
                                  { id: 1, name: '3 Jam', duration_minutes: 180 },
                                  { id: 2, name: '4 Jam', duration_minutes: 240 },
                                  { id: 3, name: '6 Jam', duration_minutes: 360 },
                                  { id: 4, name: '8 Jam', duration_minutes: 480 },
                                  { id: 5, name: '12 Jam', duration_minutes: 720 }
                                ]).map((d: any) => {
                                  const hours = d.duration_minutes / 60;
                                  return (
                                    <option key={d.id || d.name} value={hours}>
                                      {d.name} ({hours} Jam)
                                    </option>
                                  );
                                })}
                              </select>
                              {(() => {
                                const [hh, mm] = (roomDraft.dayUseStartTime || '10:00').split(':').map(Number);
                                const totalMin = (hh * 60 + (mm || 0)) + Math.round((roomDraft.dayUseHours || 6) * 60);
                                const endH = Math.floor(totalMin / 60) % 24;
                                const endM = totalMin % 60;
                                const isNextDay = totalMin >= 24 * 60;
                                const timeStr = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
                                return (
                                  <div className="mt-1 text-[10px] font-bold text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 inline-block">
                                    Checkout: {timeStr} {isNextDay ? '(+1 hari)' : '(Hari ini)'}
                                  </div>
                                );
                              })()}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Room Type & Physical Room Selection */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-stone-100">
                        <div>
                          <label className="block text-xs font-semibold text-stone-700 mb-1">
                            Tipe Kamar <span className="text-rose-500">*</span>
                          </label>
                          <select
                            value={roomDraft.roomTypeId || ''}
                            onChange={e => {
                              const newTypeId = Number(e.target.value);
                              const matchingRooms = rooms.filter(rm => (rm.room_type_id || rm.canonical_room_type_id) === newTypeId);
                              const allPlans = internalRatePlans.length > 0 ? internalRatePlans : ratePlans;
                              const matchingPlan = allPlans.find(
                                (rp: any) =>
                                  matchRatePlanToRoomType(rp, newTypeId) &&
                                  (roomDraft.stayType === 'DAY_USE' ? rp.rate_type === 'DAY_USE' : rp.rate_type !== 'DAY_USE')
                              );
                              handleUpdateRoom(roomIdx, {
                                roomTypeId: newTypeId,
                                roomId: matchingRooms.length > 0 ? matchingRooms[0].id : null,
                                ratePlanId: matchingPlan ? Number(matchingPlan.id) : null
                              });
                            }}
                            className="w-full text-xs px-3 py-2.5 bg-stone-50 border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 outline-none"
                          >
                            {roomTypes.map(rt => (
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
                            value={roomDraft.roomId || ''}
                            onChange={e => handleUpdateRoom(roomIdx, { roomId: Number(e.target.value) })}
                            className="w-full text-xs px-3 py-2.5 bg-stone-50 border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 outline-none"
                          >
                            {rooms
                              .filter(rm => !roomDraft.roomTypeId || (rm.room_type_id || rm.canonical_room_type_id) === roomDraft.roomTypeId)
                              .map(rm => {
                                const isTakenByOther = roomsList.some((other, oIdx) => oIdx !== roomIdx && Number(other.roomId) === Number(rm.id));
                                return (
                                  <option key={rm.id} value={rm.id} disabled={isTakenByOther}>
                                    Kamar {rm.room_number} ({rm.name || rm.status}){isTakenByOther ? ' (Dipilih Kamar Lain)' : ''}
                                  </option>
                                );
                              })}
                          </select>
                        </div>

                        {channelType !== 'OTA' && (
                          <div className="sm:col-span-2">
                            <label className="block text-xs font-semibold text-stone-700 mb-1">
                              Rate Plan / Paket Harga {isDayUse ? '(Khusus Day Use)' : ''}
                            </label>
                            <select
                              value={roomDraft.ratePlanId || ''}
                              onChange={e => handleUpdateRoom(roomIdx, { ratePlanId: e.target.value ? Number(e.target.value) : null })}
                              className="w-full text-xs px-3 py-2.5 bg-stone-50 border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 outline-none"
                            >
                              <option value="">
                                {isDayUse
                                  ? (availableRPlans.length === 0 ? 'Tidak ada Paket Day Use untuk Tipe Kamar ini' : '-- Pilih Paket Day Use --')
                                  : 'Tarif Standar / Reguler'}
                              </option>
                              {availableRPlans.map((rp: any) => (
                                <option key={rp.id} value={rp.id}>
                                  {rp.name} ({rp.code}) {rp.meal_plan_name ? ('• ' + rp.meal_plan_name) : ''}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>

                      {/* Pricing Quote & Override */}
                      <div className={`p-3.5 rounded-xl border space-y-2.5 ${channelType === 'OTA' ? 'bg-amber-50/70 border-amber-200' : 'bg-stone-50 border-stone-200'}`}>
                        {channelType === 'OTA' ? (
                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-bold text-amber-950 flex items-center gap-1.5">
                                  <span>🌐</span> Tarif Kamar OTA per Malam (Manual Input)
                                </span>
                                <span className="text-[10px] bg-amber-200/80 text-amber-900 px-2 py-0.5 rounded font-semibold">
                                  Wajib Sesuai Voucher
                                </span>
                              </div>
                              <span className="text-[11px] text-amber-800 font-medium">
                                Net / Voucher Rate per Malam
                              </span>
                            </div>

                            <div className="pt-1 border-t border-amber-200/60">
                              <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                                Tarif Kamar OTA per Malam (Rp) <span className="text-rose-500">*</span>
                              </label>
                              <input
                                type="text"
                                inputMode="numeric"
                                placeholder="Contoh: 350.000"
                                value={roomDraft.manualOverridePrice > 0 ? roomDraft.manualOverridePrice.toLocaleString('id-ID') : ''}
                                onChange={e => {
                                  const rawVal = e.target.value;
                                  const numVal = rawVal === '' ? 0 : Math.max(0, parseInt(rawVal.replace(/\D/g, ''), 10) || 0);
                                  handleUpdateRoom(roomIdx, {
                                    isManualOverride: true,
                                    manualOverridePrice: numVal,
                                    manualOverrideReason: selectedOtaSourceName ? `OTA: ${selectedOtaSourceName}` : 'OTA Booking'
                                  });
                                }}
                                className="w-full text-xs px-3 py-2 bg-white border border-amber-300 focus:border-amber-500 focus:ring-1 focus:ring-amber-500 rounded-lg font-mono font-bold text-stone-900"
                              />
                              {roomDraft.manualOverridePrice > 0 && (
                                <p className="text-[11px] text-amber-800 mt-1 font-medium">
                                  Tarif per malam: <strong>Rp {roomDraft.manualOverridePrice.toLocaleString('id-ID')}</strong>
                                  {roomCalculations[roomIdx]?.nights > 1 && (
                                    <span> • Total {roomCalculations[roomIdx].nights} malam: <strong>Rp {roomCalculations[roomIdx].roomCharge.toLocaleString('id-ID')}</strong></span>
                                  )}
                                </p>
                              )}
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-center justify-between">
                              <div>
                                <span className="text-[11px] text-stone-500">Tarif Kamar Terkalkulasi (per Malam):</span>
                                <div className="text-sm font-bold text-emerald-950 font-mono">
                                  {roomDraft.quoteLoading ? 'Menghitung...' : ('Rp ' + roomDraft.roomNightlyRate.toLocaleString('id-ID'))}
                                </div>
                              </div>
                              <label className="flex items-center gap-2 cursor-pointer select-none">
                                <input
                                  type="checkbox"
                                  checked={roomDraft.isManualOverride}
                                  onChange={e => {
                                    handleUpdateRoom(roomIdx, {
                                      isManualOverride: e.target.checked,
                                      manualOverridePrice: e.target.checked ? roomDraft.manualOverridePrice || roomDraft.roomNightlyRate : roomDraft.roomNightlyRate
                                    });
                                  }}
                                  className="w-3.5 h-3.5 rounded text-emerald-700 focus:ring-emerald-600 border-stone-300"
                                />
                                <span className="text-xs font-semibold text-stone-700">Override Harga Manual</span>
                              </label>
                            </div>

                            {roomDraft.isManualOverride && (
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-2 border-t border-stone-200">
                                <div>
                                  <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                                    Harga Kamar Manual per Malam (Rp) <span className="text-rose-500">*</span>
                                  </label>
                                  <input
                                    type="number"
                                    min="0"
                                    step="1000"
                                    value={roomDraft.manualOverridePrice}
                                    onChange={e => handleUpdateRoom(roomIdx, { manualOverridePrice: Number(e.target.value) })}
                                    className="w-full text-xs px-3 py-2 bg-white border border-stone-300 rounded-lg font-mono font-bold"
                                  />
                                </div>
                                <div>
                                  <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                                    Alasan Override <span className="text-rose-500">*</span>
                                  </label>
                                  <input
                                    type="text"
                                    required
                                    value={roomDraft.manualOverrideReason}
                                    onChange={e => handleUpdateRoom(roomIdx, { manualOverrideReason: e.target.value })}
                                    placeholder="Contoh: Diskon Direksi, Kompensasi..."
                                    className="w-full text-xs px-3 py-2 bg-white border border-stone-300 rounded-lg"
                                  />
                                </div>
                              </div>
                            )}
                          </>
                        )}
                      </div>

                      {/* Stay Charges per Room */}
                      <div className="space-y-2.5 pt-2 border-t border-stone-100">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold uppercase tracking-wider text-stone-600">
                            Layanan Tambahan & Denda
                          </span>
                          {roomDraft.stayCharges.length > 0 && (
                            <span className="text-[11px] font-bold text-emerald-800 bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-200">
                              {roomDraft.stayCharges.length} item dipilih
                            </span>
                          )}
                        </div>

                        {/* Single-occurrence Warning Banner */}
                        {chargeWarningMap[roomIdx] && (
                          <div className="p-2.5 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl text-xs flex items-center justify-between font-medium animate-in fade-in">
                            <span>⚠️ {chargeWarningMap[roomIdx]}</span>
                            <button
                              type="button"
                              onClick={() => setChargeWarningMap(prev => ({ ...prev, [roomIdx]: null }))}
                              className="text-amber-800 font-bold ml-2 cursor-pointer"
                            >
                              ✕
                            </button>
                          </div>
                        )}

                        {/* Compact Searchable Picker Combobox */}
                        <StayChargePickerCombobox
                          rules={internalStayChargeRules.length > 0 ? internalStayChargeRules : stayChargeRules}
                          onSelectRule={(rule) => handleAddStayChargeToRoom(roomIdx, rule)}
                          placeholder="Cari Extra Bed, Late Check-out, Denda Merokok, dll"
                          label="Tambah layanan atau denda"
                        />

                        {/* Selected Line Items */}
                        {roomDraft.stayCharges.length > 0 && (
                          <div className="space-y-2 pt-1">
                            {roomDraft.stayCharges.map(sc => {
                              const isSingleOccurrence = sc.charge_type === 'EARLY_CHECKIN' || sc.charge_type === 'LATE_CHECKOUT';
                              const isFree = sc.charge_method === 'FREE' || (sc.unit_price === 0 && !sc.is_manual && !sc.is_override);

                              return (
                                <div
                                  key={sc.id}
                                  className="p-2.5 bg-stone-50 hover:bg-stone-100/70 rounded-xl border border-stone-200 text-xs transition-colors space-y-2"
                                >
                                  <div className="flex items-center justify-between">
                                    <div className="min-w-0 pr-2">
                                      <div className="flex items-center gap-1.5 flex-wrap">
                                        <span className="font-semibold text-stone-900 truncate">{sc.description}</span>
                                        {sc.charge_type === 'PENALTY' ? (
                                          <span className="px-1.5 py-0.2 bg-rose-100 text-rose-800 text-[10px] font-bold rounded">
                                            Denda
                                          </span>
                                        ) : (
                                          <span className="px-1.5 py-0.2 bg-emerald-100 text-emerald-800 text-[10px] font-bold rounded">
                                            Layanan
                                          </span>
                                        )}
                                        {sc.charge_method === 'PERCENTAGE_OF_NIGHTLY_RATE' && (
                                          <span className="px-1.5 py-0.2 bg-blue-100 text-blue-800 text-[10px] font-bold rounded">
                                            50% Tarif
                                          </span>
                                        )}
                                        {sc.charge_method === 'FULL_NIGHT' && (
                                          <span className="px-1.5 py-0.2 bg-indigo-100 text-indigo-800 text-[10px] font-bold rounded">
                                            Tarif 1 Malam
                                          </span>
                                        )}
                                        {isFree && (
                                          <span className="px-1.5 py-0.2 bg-stone-200 text-stone-700 text-[10px] font-bold rounded">
                                            Gratis
                                          </span>
                                        )}
                                        {sc.is_manual && (
                                          <span className="px-1.5 py-0.2 bg-purple-100 text-purple-800 text-[10px] font-bold rounded">
                                            Manual
                                          </span>
                                        )}
                                        {sc.is_override && (
                                          <span className="px-1.5 py-0.2 bg-amber-100 text-amber-900 text-[10px] font-bold rounded border border-amber-300" title={`Alasan: ${sc.override_reason}`}>
                                            Override
                                          </span>
                                        )}
                                      </div>

                                      <div className="text-[10px] text-stone-500 mt-0.5 font-mono">
                                        {isFree ? (
                                          <span className="text-emerald-700 font-bold">Gratis (Rp 0)</span>
                                        ) : sc.is_override ? (
                                          <div className="flex items-center gap-1.5">
                                            <span className="line-through text-stone-400">
                                              Rp {(sc.original_unit_price || 0).toLocaleString('id-ID')}
                                            </span>
                                            <span className="font-bold text-amber-800">
                                              Rp {sc.unit_price.toLocaleString('id-ID')} / unit
                                            </span>
                                            <span className="text-stone-500 font-sans italic truncate max-w-[150px]">
                                              ({sc.override_reason})
                                            </span>
                                          </div>
                                        ) : (
                                          <span>Rp {sc.unit_price.toLocaleString('id-ID')} / unit</span>
                                        )}
                                      </div>
                                    </div>

                                    <div className="flex items-center gap-2 shrink-0">
                                      {/* Quantity Stepper */}
                                      <div className="flex items-center border border-stone-300 rounded-lg bg-white overflow-hidden shadow-2xs">
                                        <button
                                          type="button"
                                          disabled={sc.quantity <= 1 || isSingleOccurrence}
                                          onClick={() => handleUpdateStayChargeQty(roomIdx, sc.id, sc.quantity - 1)}
                                          className="px-2 py-1 text-stone-600 hover:bg-stone-100 disabled:opacity-40 disabled:cursor-not-allowed font-bold text-xs"
                                        >
                                          -
                                        </button>
                                        <span className="w-7 text-center text-xs font-semibold font-mono">{sc.quantity}</span>
                                        <button
                                          type="button"
                                          disabled={isSingleOccurrence}
                                          onClick={() => handleUpdateStayChargeQty(roomIdx, sc.id, sc.quantity + 1)}
                                          className="px-2 py-1 text-stone-600 hover:bg-stone-100 disabled:opacity-40 disabled:cursor-not-allowed font-bold text-xs"
                                        >
                                          +
                                        </button>
                                      </div>

                                      <span className="font-mono font-bold text-stone-900 text-right min-w-[75px]">
                                        Rp {sc.amount.toLocaleString('id-ID')}
                                      </span>

                                      {/* Controlled Override Action */}
                                      {!sc.is_manual && !isFree && (
                                        <button
                                          type="button"
                                          onClick={() => handleToggleStayChargeOverride(roomIdx, sc.id)}
                                          className="p-1 text-stone-400 hover:text-amber-700 hover:bg-amber-50 rounded-lg transition-colors cursor-pointer"
                                          title="Override Harga"
                                        >
                                          ⚙️
                                        </button>
                                      )}

                                      <button
                                        type="button"
                                        onClick={() => handleRemoveStayChargeFromRoom(roomIdx, sc.id)}
                                        className="p-1 text-stone-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                                        title="Hapus item"
                                      >
                                        ✕
                                      </button>
                                    </div>
                                  </div>

                                  {/* Override Panel */}
                                  {sc.isOverrideOpen && !sc.is_manual && (
                                    <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-xl space-y-2 text-xs animate-in fade-in">
                                      <div className="flex items-center justify-between text-[11px] font-bold text-amber-900">
                                        <span>⚙️ Override Harga</span>
                                        <span className="font-mono text-stone-500 font-normal">
                                          Master: Rp {(sc.original_unit_price ?? sc.unit_price).toLocaleString('id-ID')}
                                        </span>
                                      </div>
                                      <div className="grid grid-cols-2 gap-2">
                                        <div>
                                          <label className="block text-[10px] font-semibold text-amber-900 mb-0.5">
                                            Harga Override (Rp) *
                                          </label>
                                          <input
                                            type="number"
                                            min={0}
                                            step={1000}
                                            defaultValue={sc.is_override ? sc.unit_price : (sc.original_unit_price ?? sc.unit_price)}
                                            id={`override-price-${sc.id}`}
                                            className="w-full px-2 py-1 bg-white border border-amber-300 rounded font-mono font-bold text-xs"
                                          />
                                        </div>
                                        <div>
                                          <label className="block text-[10px] font-semibold text-amber-900 mb-0.5">
                                            Alasan Override *
                                          </label>
                                          <input
                                            type="text"
                                            defaultValue={sc.override_reason || ''}
                                            id={`override-reason-${sc.id}`}
                                            placeholder="Contoh: Diskon khusus, GM approve..."
                                            className="w-full px-2 py-1 bg-white border border-amber-300 rounded text-xs"
                                          />
                                        </div>
                                      </div>
                                      <div className="flex items-center justify-end gap-1.5 pt-1">
                                        {sc.is_override && (
                                          <button
                                            type="button"
                                            onClick={() => handleResetStayChargeOverride(roomIdx, sc.id)}
                                            className="px-2 py-1 text-stone-600 hover:bg-stone-200 text-[11px] rounded font-semibold cursor-pointer"
                                          >
                                            Reset ke Master
                                          </button>
                                        )}
                                        <button
                                          type="button"
                                          onClick={() => handleToggleStayChargeOverride(roomIdx, sc.id)}
                                          className="px-2 py-1 text-stone-600 hover:bg-stone-200 text-[11px] rounded font-semibold cursor-pointer"
                                        >
                                          Batal
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => {
                                            const priceInput = document.getElementById(`override-price-${sc.id}`) as HTMLInputElement;
                                            const reasonInput = document.getElementById(`override-reason-${sc.id}`) as HTMLInputElement;
                                            const newPrice = Number(priceInput?.value || 0);
                                            const newReason = reasonInput?.value || '';
                                            handleSaveStayChargeOverride(roomIdx, sc.id, newPrice, newReason);
                                          }}
                                          className="px-2.5 py-1 bg-amber-800 hover:bg-amber-900 text-white text-[11px] font-bold rounded cursor-pointer"
                                        >
                                          Simpan
                                        </button>
                                      </div>
                                    </div>
                                  )}

                                  {/* Manual Input Panel */}
                                  {sc.is_manual && (
                                    <div className="grid grid-cols-2 gap-2 pt-1 border-t border-stone-200">
                                      <div>
                                        <label className="block text-[10px] font-semibold text-purple-900 mb-0.5">
                                          Nominal Manual (Rp) *
                                        </label>
                                        <input
                                          type="number"
                                          min={0}
                                          step={1000}
                                          value={sc.unit_price}
                                          onChange={e => handleUpdateManualStayCharge(roomIdx, sc.id, Number(e.target.value))}
                                          placeholder="Nominal..."
                                          className="w-full px-2 py-1 bg-white border border-purple-300 rounded font-mono font-bold text-xs"
                                        />
                                      </div>
                                      <div>
                                        <label className="block text-[10px] font-semibold text-purple-900 mb-0.5">
                                          Keterangan / Alasan *
                                        </label>
                                        <input
                                          type="text"
                                          value={sc.notes || ''}
                                          onChange={e => handleUpdateManualStayCharge(roomIdx, sc.id, sc.unit_price, e.target.value)}
                                          placeholder="Contoh: Pecah gelas, dll..."
                                          className="w-full px-2 py-1 bg-white border border-purple-300 rounded text-xs"
                                        />
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      {/* Diskon per Room */}
                      <div className="p-3 bg-stone-50 rounded-xl border border-stone-200 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold uppercase tracking-wider text-stone-500">
                            Diskon Kamar {roomIdx + 1}
                          </span>
                          <div className="flex gap-1 p-0.5 bg-stone-200/70 rounded-md text-[10px] font-semibold">
                            <button
                              type="button"
                              onClick={() => handleUpdateRoom(roomIdx, { discountType: 'NOMINAL' })}
                              className={'px-2 py-0.5 rounded transition cursor-pointer ' + (
                                roomDraft.discountType === 'NOMINAL' ? 'bg-white text-stone-900 shadow-2xs font-bold' : 'text-stone-600'
                              )}
                            >
                              Nominal (Rp)
                            </button>
                            <button
                              type="button"
                              onClick={() => handleUpdateRoom(roomIdx, { discountType: 'PERCENT' })}
                              className={'px-2 py-0.5 rounded transition cursor-pointer ' + (
                                roomDraft.discountType === 'PERCENT' ? 'bg-white text-stone-900 shadow-2xs font-bold' : 'text-stone-600'
                              )}
                            >
                              Persentase (%)
                            </button>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <div>
                            <label className="block text-[10px] font-semibold text-stone-600 mb-0.5">
                              Nilai Diskon ({roomDraft.discountType === 'PERCENT' ? '%' : 'Rp'})
                            </label>
                            <input
                              type="number"
                              min={0}
                              max={roomDraft.discountType === 'PERCENT' ? 100 : undefined}
                              value={roomDraft.discountValue}
                              onChange={e => handleUpdateRoom(roomIdx, { discountValue: Number(e.target.value) })}
                              className="w-full text-xs px-2.5 py-1.5 bg-white border border-stone-300 rounded-lg font-mono"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-semibold text-stone-600 mb-0.5">
                              Alasan Diskon
                            </label>
                            <input
                              type="text"
                              value={roomDraft.discountReason}
                              onChange={e => handleUpdateRoom(roomIdx, { discountReason: e.target.value })}
                              placeholder="Contoh: Promo Direct Booking..."
                              className="w-full text-xs px-2.5 py-1.5 bg-white border border-stone-300 rounded-lg"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}

                <button
                  type="button"
                  onClick={handleAddRoom}
                  className="w-full py-3 border-2 border-dashed border-emerald-700/40 hover:border-emerald-700 bg-emerald-50/50 hover:bg-emerald-50 text-emerald-900 rounded-2xl text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  + Tambah Kamar ({roomsList.length + 1})
                </button>
              </div>

              {/* SEKSI 8: PEMBAYARAN & BUKTI BAYAR */}
              <div className="bg-white p-5 rounded-2xl border border-stone-200/80 shadow-xs space-y-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-950 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-700"></span>
                  5. Pembayaran & Bukti Bayar
                </h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <div>
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Metode Pembayaran <span className="text-rose-500">*</span>
                    </label>
                    <select
                      value={paymentMethod}
                      onChange={e => setPaymentMethod(e.target.value as any)}
                      className="w-full text-xs px-3.5 py-2.5 bg-stone-50 border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
                    >
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
                        Nominal Dibayar (DP / Lunas) <span className="text-rose-500">*</span>
                      </label>
                      <button
                        type="button"
                        onClick={() => setAmountPaid(grandTotal)}
                        className="text-[10px] font-bold text-emerald-800 hover:text-emerald-950 bg-emerald-50 hover:bg-emerald-100 px-2 py-0.5 rounded-lg border border-emerald-200 cursor-pointer transition-colors"
                      >
                        Bayar Pas / Lunas (Rp {grandTotal.toLocaleString('id-ID')})
                      </button>
                    </div>
                    <input
                      type="number"
                      required
                      min="1"
                      step="1000"
                      value={amountPaid}
                      onChange={e => setAmountPaid(Number(e.target.value))}
                      className="w-full text-xs px-3.5 py-2.5 bg-stone-50 border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none font-mono font-bold text-emerald-950"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Upload Bukti Pembayaran <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="file"
                      required={amountPaid > 0}
                      accept="image/jpeg,image/png,application/pdf"
                      onChange={handleBuktiBayarChange}
                      className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl outline-none file:mr-3 file:py-1 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-emerald-800 file:text-white hover:file:bg-emerald-700 cursor-pointer"
                    />
                    {buktiBayarFile && (
                      <span className="text-[11px] text-emerald-800 font-semibold mt-1 block">
                        ✓ File terpilih: {buktiBayarFile.name}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Right 30% Sticky Financial Summary & Gate Indicator */}
            <div className="lg:col-span-4 p-6 bg-stone-50/90 flex flex-col justify-between space-y-6">
              <div className="space-y-5">
                <div className="p-4 bg-white rounded-2xl border border-stone-200 shadow-xs space-y-3">
                  <div className="flex items-center justify-between border-b border-stone-100 pb-2">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-stone-700">
                      Ringkasan Finansial
                    </h4>
                    <span className="text-[10px] font-bold px-2 py-0.5 bg-emerald-100 text-emerald-900 rounded-full">
                      {roomsList.length} Kamar
                    </span>
                  </div>

                  <div className="space-y-2 text-xs">
                    {roomCalculations.map((c, i) => (
                      <div key={i} className="flex justify-between text-stone-700 py-0.5 border-b border-stone-50">
                        <span>
                          <strong>{c.roomLabel}:</strong> {c.roomNumber} ({c.roomTypeName})
                        </span>
                        <span className="font-mono font-semibold">
                          Rp {c.roomCharge.toLocaleString('id-ID')}
                        </span>
                      </div>
                    ))}

                    {totalStayCharges > 0 && (
                      <div className="flex justify-between text-stone-600">
                        <span>Total Layanan Tambahan</span>
                        <span className="font-mono font-semibold">Rp {totalStayCharges.toLocaleString('id-ID')}</span>
                      </div>
                    )}

                    {totalDiscounts > 0 && (
                      <div className="flex justify-between text-emerald-800 font-medium">
                        <span>Total Diskon</span>
                        <span className="font-mono font-semibold">-Rp {totalDiscounts.toLocaleString('id-ID')}</span>
                      </div>
                    )}

                    <div className="border-t border-stone-200 pt-2 flex justify-between text-stone-900 font-bold text-sm">
                      <span>Grand Total</span>
                      <span className="font-mono text-emerald-950">Rp {grandTotal.toLocaleString('id-ID')}</span>
                    </div>

                    <div className="flex justify-between text-stone-600 pt-1">
                      <span>Jumlah Dibayar</span>
                      <span className="font-mono font-semibold text-emerald-800">
                        Rp {amountPaid.toLocaleString('id-ID')}
                      </span>
                    </div>

                    <div className="flex justify-between text-stone-600">
                      <span>Sisa Tagihan</span>
                      <span className={'font-mono font-bold ' + (remainingBill > 0 ? 'text-amber-800' : 'text-emerald-800')}>
                        Rp {remainingBill.toLocaleString('id-ID')}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Special Requests */}
                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Catatan / Special Requests
                  </label>
                  <textarea
                    rows={2}
                    value={specialRequests}
                    onChange={e => setSpecialRequests(e.target.value)}
                    placeholder="Contoh: Permintaan lantai atas, connecting room..."
                    className="w-full text-xs p-3 bg-white border border-stone-300 rounded-xl focus:ring-2 focus:ring-emerald-600 outline-none"
                  />
                </div>

                {/* Validation Gate Checklist */}
                <div className="p-4 bg-white rounded-2xl border border-stone-200 text-xs space-y-2">
                  <h5 className="font-bold text-stone-800 text-[11px] uppercase tracking-wider">
                    Kelayakan Reservasi (Gate Check)
                  </h5>
                  {isValid ? (
                    <div className="p-2.5 bg-emerald-50 rounded-xl border border-emerald-200 text-emerald-900 text-xs flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-600"></span>
                      <span className="font-semibold">Semua dokumen & data wajib lengkap ({roomsList.length} kamar).</span>
                    </div>
                  ) : (
                    <div className="p-3 bg-rose-50 rounded-xl border border-rose-200 text-rose-900 text-xs space-y-1">
                      <p className="font-semibold text-rose-800">Harap lengkapi:</p>
                      <ul className="list-disc list-inside space-y-0.5 text-[11px] text-rose-700">
                        {validationIssues.map((issue, idx) => (
                          <li key={idx}>{issue}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="space-y-2 pt-4 border-t border-stone-200">
                <button
                  type="button"
                  disabled={!isValid || submitting}
                  onClick={handleSubmit}
                  className="w-full py-3 px-4 bg-emerald-800 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-xl font-bold text-sm shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer disabled:cursor-not-allowed"
                >
                  {submitting ? (
                    <>
                      <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                      </svg>
                      Memproses Booking ({roomsList.length} Kamar)...
                    </>
                  ) : (
                    'Buat Reservasi (' + roomsList.length + ' Kamar)'
                  )}
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="w-full py-2.5 px-4 bg-stone-200 hover:bg-stone-300 text-stone-700 rounded-xl font-semibold text-xs transition-colors cursor-pointer"
                >
                  Batal
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* OCR Identity Extraction Review Modal */}
      <IdentityExtractionModal
        isOpen={isIdentityModalOpen}
        onClose={() => setIsIdentityModalOpen(false)}
        guestName={guestName}
        guestPhone={guestPhone}
        guestId={selectedCrmGuest?.id}
        propertyId={propertyId}
        onScanSuccess={handleIdentityConfirmed}
        onIdentityConfirmed={handleIdentityConfirmed}
      />

      {/* OTA Sources Master Manager Modal */}
      <OtaSourceManagerModal
        isOpen={isOtaModalOpen}
        onClose={() => setIsOtaModalOpen(false)}
        propertyId={propertyId}
        onSourceUpdated={loadInitialData}
      />

      {/* Duplicate Candidate Warning Modal */}
      {showDuplicateModal && duplicateCandidates.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="bg-white rounded-2xl shadow-2xl border border-amber-300 w-full max-w-lg overflow-hidden animate-in fade-in zoom-in duration-150">
            <div className="p-4 bg-amber-500 text-white flex items-center gap-2">
              <span className="text-xl">⚠️</span>
              <h4 className="text-sm font-bold">Data Tamu Serupa Ditemukan di CRM</h4>
            </div>
            <div className="p-5 space-y-4 text-xs">
              <p className="text-stone-600">
                Sistem menemukan tamu terdaftar dengan data yang serupa. Pilih untuk menautkan reservasi ke profil tamu terdaftar atau tetap lanjutkan membuat tamu baru.
              </p>
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {duplicateCandidates.map((cand) => (
                  <div key={cand.id} className="p-3 bg-stone-50 border border-stone-200 rounded-xl space-y-1.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-stone-900 text-sm">{cand.full_name}</span>
                        {cand.guest_code && (
                          <span className="text-[10px] px-1.5 py-0.2 bg-stone-200 text-stone-700 font-mono rounded font-medium">
                            {cand.guest_code}
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] px-2 py-0.5 rounded bg-amber-100 text-amber-900 border border-amber-300 font-semibold">
                        {cand.match_reason}
                      </span>
                    </div>
                    <div className="text-stone-500 flex flex-wrap gap-x-3 gap-y-0.5">
                      {cand.phone && <span>HP: <strong className="text-stone-700 font-mono">{cand.phone}</strong></span>}
                      {cand.identity_number && <span>NIK: <strong className="text-stone-700 font-mono">{cand.identity_number}</strong></span>}
                    </div>
                    <div className="text-[11px] text-stone-500 flex gap-2 pt-1 border-t border-stone-200/60">
                      <span>Total Stay: <strong>{cand.visit_count ?? 0}x</strong></span>
                      {cand.last_stay && <span>Stay Terakhir: <strong>{cand.last_stay.slice(0, 10)}</strong></span>}
                    </div>
                    <div className="pt-2 flex justify-end">
                      <button
                        type="button"
                        onClick={() => {
                          handleSelectGuest(cand as any);
                          setShowDuplicateModal(false);
                          setDuplicateCandidates([]);
                        }}
                        className="px-3 py-1.5 bg-[#1E392A] hover:bg-[#162a1f] text-white font-semibold rounded-lg text-xs transition-colors"
                      >
                        ✓ Gunakan Tamu Terdaftar Ini
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="p-4 bg-stone-50 border-t border-stone-200 flex justify-between items-center">
              <button
                type="button"
                onClick={() => {
                  setShowDuplicateModal(false);
                }}
                className="px-3.5 py-2 text-stone-600 hover:text-stone-800 text-xs font-semibold"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() => {
                  setDuplicateBypassed(true);
                  setShowDuplicateModal(false);
                  setDuplicateCandidates([]);
                }}
                className="px-4 py-2 bg-stone-200 hover:bg-stone-300 text-stone-800 text-xs font-semibold rounded-xl transition-colors"
              >
                Tetap Buat Sebagai Tamu Baru →
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
