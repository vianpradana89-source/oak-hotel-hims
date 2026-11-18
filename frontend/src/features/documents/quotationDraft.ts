import { normalizeHotelDate } from '../calendar/calendarDates';
import type { PropertyPaymentInstructionsDto } from '../settings/paymentInstructionsTypes';
export type { PropertyPaymentInstructionsDto };

export type QuotationMode = 'reservation' | 'manual';

export type QuotationAdjustmentType = 'amount' | 'percent';

export interface QuotationDraftItem {
  id: string;
  description: string;
  qty: number;
  unit: string;
  unitPrice: number;
  discountType?: QuotationAdjustmentType;
  discountValue?: number;
  note?: string;
}

export interface QuotationDraft {
  mode: QuotationMode;
  reservationId?: number | null;

  savedQuotationId?: number | null;
  quotationNumber?: string;
  revisionNumber?: number;
  revisionLabel?: string;
  version?: number;
  quotationDate: string;
  validUntil?: string;
  reference?: string;
  subject?: string;

  customerName: string;
  contactPerson?: string;
  phone?: string;
  email?: string;
  address?: string;

  checkIn?: string;
  checkOut?: string;
  roomType?: string;
  roomNumber?: string;
  guestCount?: number | null;

  items: QuotationDraftItem[];

  discountType: QuotationAdjustmentType;
  discountValue: number;

  serviceType: QuotationAdjustmentType;
  serviceValue: number;

  taxType: QuotationAdjustmentType;
  taxValue: number;

  notes?: string;
  terms?: string;

  bankName?: string;
  bankAccountName?: string;
  bankAccountNumber?: string;
}

export interface QuotationDraftTotals {
  itemTotals: number[];
  itemGrossTotals: number[];
  itemDiscounts: number[];
  subtotal: number;
  discountAmount: number;
  serviceAmount: number;
  taxAmount: number;
  grandTotal: number;
}

export function calculateQuotationItemDiscount(item: QuotationDraftItem): {
  grossTotal: number;
  discountAmount: number;
  netTotal: number;
} {
  const rawQty = Number(item.qty);
  const qty = Number.isFinite(rawQty) && rawQty > 0 ? rawQty : 0;
  const rawPrice = Number(item.unitPrice);
  const unitPrice = Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : 0;
  const grossTotal = Math.round(qty * unitPrice);

  const rawDiscVal = Number(item.discountValue);
  const validDiscVal = Number.isFinite(rawDiscVal) && rawDiscVal > 0 ? rawDiscVal : 0;
  const discType: QuotationAdjustmentType = item.discountType === 'percent' ? 'percent' : 'amount';

  let discountAmount = 0;
  if (discType === 'percent') {
    const pct = Math.min(100, Math.max(0, validDiscVal));
    discountAmount = Math.round((grossTotal * pct) / 100);
  } else {
    discountAmount = Math.round(validDiscVal);
  }
  if (discountAmount > grossTotal) {
    discountAmount = grossTotal;
  }
  const netTotal = Math.max(0, grossTotal - discountAmount);
  return { grossTotal, discountAmount, netTotal };
}


function generateLocalId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `item-${Date.now()}-${ Math.random().toString(36).slice(2, 9) }`;
}


function getTodayHotelDate(): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jakarta',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const year = parts.find((p) => p.type === 'year')?.value;
    const month = parts.find((p) => p.type === 'month')?.value;
    const day = parts.find((p) => p.type === 'day')?.value;
    const raw = year && month && day ? `${year}-${month}-${day}` : '';
    return normalizeHotelDate(raw) || raw;
  } catch {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return normalizeHotelDate(`${year}-${month}-${day}`) || `${year}-${month}-${day}`;
  }
}


/**
 * 1. createQuotationDraftItem
 * Creates a single quotation draft item with stable frontend-local ID and defaults.
 */
export function createQuotationDraftItem(partial?: Partial<QuotationDraftItem>): QuotationDraftItem {
  return {
    id: partial?.id || generateLocalId(),
    description: partial?.description ?? '',
    qty: partial?.qty !== undefined ? Math.max(0, Number(partial.qty) || 0) : 1,
    unit: partial?.unit ?? '',
    unitPrice: partial?.unitPrice !== undefined ? Math.max(0, Number(partial.unitPrice) || 0) : 0,
    discountType: partial?.discountType === 'percent' ? 'percent' : 'amount',
    discountValue: partial?.discountValue !== undefined ? Math.max(0, Number(partial.discountValue) || 0) : 0,
    ...(partial?.note !== undefined ? { note: partial.note } : {}),
  };
}


/**
 * 2. createBlankQuotationDraft
 * Creates a clean manual quotation draft for today's hotel date without dummy data.
 */
export function createBlankQuotationDraft(
  mode: QuotationMode = 'manual',
  paymentInstructions?: PropertyPaymentInstructionsDto | null
): QuotationDraft {
  const hasActiveBankInfo = Boolean(
    paymentInstructions &&
    paymentInstructions.is_active !== false &&
    (paymentInstructions.bank_name || paymentInstructions.bank_account_number)
  );

  return {
    mode,
    reservationId: null,

    quotationNumber: '',
    quotationDate: getTodayHotelDate(),
    validUntil: '',
    reference: '',
    subject: '',

    customerName: '',
    contactPerson: '',
    phone: '',
    email: '',
    address: '',

    checkIn: '',
    checkOut: '',
    roomType: '',
    roomNumber: '',
    guestCount: null,

    items: [],

    discountType: 'amount',
    discountValue: 0,

    serviceType: 'amount',
    serviceValue: 0,

    taxType: 'amount',
    taxValue: 0,

    notes: '',
    terms: '',

    bankName: hasActiveBankInfo ? (paymentInstructions?.bank_name || '') : '',
    bankAccountName: hasActiveBankInfo ? (paymentInstructions?.bank_account_name || '') : '',
    bankAccountNumber: hasActiveBankInfo ? (paymentInstructions?.bank_account_number || '') : '',
  };
}


/**
 * 3. buildQuotationDraftFromReservation
 * COPIES canonical reservation data into an editable document-local draft.
 * Never writes back to reservation / folio / accounting sources of truth.
 */
export function buildQuotationDraftFromReservation(
  reservation: any,
  paymentInstructions?: PropertyPaymentInstructionsDto | null
): QuotationDraft {
  const res = reservation ?? {};
  const reservationId = res.id !== undefined && res.id !== null ? Number(res.id) : null;
  const reference = String(res.bid || res.legacy_booking_number || '').trim();
  const customerName = String(res.guest_name || res.booker_name || '').trim();
  const contactPerson = String(
    res.contact_person ||
    (res.booker_name && res.guest_name && res.booker_name !== res.guest_name ? res.booker_name : '') ||
    ''
  ).trim();
  const phone = String(res.guest_phone || res.booker_phone || '').trim();
  const email = String(res.guest_email || res.booker_email || '').trim();
  const address = String(res.guest_address || res.address || '').trim();

  const checkIn = normalizeHotelDate(res.check_in);
  const checkOut = normalizeHotelDate(res.check_out);
  const roomType = String(res.room_type_name || res.room_type || '').trim();
  const roomNumber = res.room_number !== undefined && res.room_number !== null ? String(res.room_number).trim() : '';

  let guestCount: number | null = null;
  if (res.guest_count !== undefined && res.guest_count !== null && res.guest_count !== '') {
    const parsed = Number(res.guest_count);
    guestCount = Number.isFinite(parsed) ? parsed : null;
  } else if (res.pax !== undefined && res.pax !== null && res.pax !== '') {
    const parsed = Number(res.pax);
    guestCount = Number.isFinite(parsed) ? parsed : null;
  }

  const nightlyRates = Array.isArray(res.rate_snapshot?.nightly_rates)
    ? res.rate_snapshot.nightly_rates
    : (Array.isArray(res.nightly_rates) ? res.nightly_rates : null);

  const items: QuotationDraftItem[] = [];

  if (nightlyRates && nightlyRates.length > 0) {
    for (const nr of nightlyRates) {
      const rawDate = nr?.stay_date || nr?.hotel_date || nr?.date || '';
      const stayDate = normalizeHotelDate(rawDate) || String(rawDate).trim();
      const descParts = [roomType || 'Kamar', stayDate].filter(Boolean);
      const description = descParts.join(' - ');

      let unitPrice = 0;
      if (nr?.total_amount !== undefined && nr?.total_amount !== null) {
        unitPrice = Number(nr.total_amount);
      } else if (nr?.final_room_rate !== undefined && nr?.final_room_rate !== null) {
        unitPrice = Number(nr.final_room_rate);
      } else if (nr?.final_rate !== undefined && nr?.final_rate !== null) {
        unitPrice = Number(nr.final_rate);
      } else if (nr?.base_rate !== undefined && nr?.base_rate !== null) {
        unitPrice = Number(nr.base_rate);
      }
      unitPrice = Number.isFinite(unitPrice) && unitPrice > 0 ? Math.round(unitPrice) : 0;

      items.push(
        createQuotationDraftItem({
          description,
          qty: 1,
          unit: 'malam',
          unitPrice,
          note: nr?.note || nr?.notes || undefined,
        })
      );
    }
  } else {
    const rawTotal = Number(res.total_price || 0);
    const totalPrice = Number.isFinite(rawTotal) && rawTotal > 0 ? Math.round(rawTotal) : 0;
    const dateSpan = checkIn && checkOut ? ` (${checkIn} s/d ${checkOut})` : '';
    const description = roomType ? `Sewa Kamar ${roomType}${dateSpan}` : `Sewa Kamar${dateSpan}`;

    items.push(
      createQuotationDraftItem({
        description,
        qty: 1,
        unit: 'paket',
        unitPrice: totalPrice,
      })
    );
  }

  const hasActiveBankInfo = Boolean(
    paymentInstructions &&
    paymentInstructions.is_active !== false &&
    (paymentInstructions.bank_name || paymentInstructions.bank_account_number)
  );

  return {
    mode: 'reservation',
    reservationId,

    quotationNumber: '',
    quotationDate: getTodayHotelDate(),
    validUntil: '',
    reference: reference || undefined,
    subject: '',

    customerName,
    contactPerson: contactPerson || undefined,
    phone : phone || undefined,
    email: email || undefined,
    address: address || undefined,

    checkIn: checkIn || undefined,
    checkOut: checkOut || undefined,
    roomType: roomType || undefined,
    roomNumber: roomNumber || undefined,
    guestCount,

    items,

    discountType: 'amount',
    discountValue: 0,

    serviceType: 'amount',
    serviceValue: 0,

    taxType: 'amount',
    taxValue: 0,

    notes: String(res.special_requests || res.notes || '').trim() || undefined,
    terms: '',

    bankName: hasActiveBankInfo ? (paymentInstructions?.bank_name || '') : '',
    bankAccountName: hasActiveBankInfo ? (paymentInstructions?.bank_account_name || '') : '',
    bankAccountNumber: hasActiveBankInfo ? (paymentInstructions?.bank_account_number || '') : '',
  };
}


/**
 * 4. calculateQuotationDraftTotals
 * Pure financial calculation following OAK HIMS quotation rounding and adjustment rules.
 */
export function calculateQuotationDraftTotals(draft: QuotationDraft): QuotationDraftTotals {
  const itemCalcs = (draft.items || []).map((item) => calculateQuotationItemDiscount(item));
  const itemTotals: number[] = itemCalcs.map((c) => c.netTotal);
  const itemGrossTotals: number[] = itemCalcs.map((c) => c.grossTotal);
  const itemDiscounts: number[] = itemCalcs.map((c) => c.discountAmount);

  const subtotal = itemTotals.reduce((sum, current) => sum + current, 0);

  let discountAmount = 0;
  const rawDiscount = Number(draft.discountValue);
  const validDiscount = Number.isFinite(rawDiscount) && rawDiscount > 0 ? rawDiscount : 0;
  if (draft.discountType === 'percent') {
    discountAmount = Math.round((subtotal * validDiscount) / 100);
  } else {
    discountAmount = Math.round(validDiscount);
  }
  // Clamp discount not above subtotal
  if (discountAmount > subtotal) {
    discountAmount = subtotal;
  }

  const afterDiscount = Math.max(0, subtotal - discountAmount);

  let serviceAmount = 0;
  const rawService = Number(draft.serviceValue);
  const validService = Number.isFinite(rawService) && rawService > 0 ? rawService : 0;
  if (draft.serviceType === 'percent') {
    serviceAmount = Math.round((afterDiscount * validService) / 100);
  } else {
    serviceAmount = Math.round(validService);
  }

  let taxAmount = 0;
  const rawTax = Number(draft.taxValue);
  const validTax = Number.isFinite(rawTax) && rawTax > 0 ? rawTax : 0;
  const taxBase = afterDiscount + serviceAmount;
  if (draft.taxType === 'percent') {
    taxAmount = Math.round((taxBase * validTax) / 100);
  } else {
    taxAmount = Math.round(validTax);
  }

  const grandTotal = Math.max(0, subtotal - discountAmount + serviceAmount + taxAmount);

  return {
    itemTotals,
    itemGrossTotals,
    itemDiscounts,
    subtotal,
    discountAmount,
    serviceAmount,
    taxAmount,
    grandTotal,
  };
}


/**
 * 4. buildQuotationDraftFromSavedRecord
 * Memuat quotation tersimpan dari database ke state editor & preview secara langsung.
 * Tidak akan tertimpa oleh live rate atau seleksi reservasi.
 */
export function buildQuotationDraftFromSavedRecord(detail: any): QuotationDraft {
  const q = detail.quotation || detail;
  const rev = detail.latest_revision || detail.revision || {};
  const snap = typeof rev.snapshot === 'string' ? JSON.parse(rev.snapshot) : (rev.snapshot || {});

  const snapCustomer = snap.customer || {};
  const snapStay = snap.stay_dates || {};
  const snapPricing = snap.pricing || {};

  return {
    mode: 'manual',
    reservationId: null,

    savedQuotationId: Number(q.id),
    quotationNumber: q.quotation_number || '',
    revisionNumber: Number(rev.revision_number) || 1,
    revisionLabel: rev.revision_label || 'R1',
    version: Number(q.version) || 1,

    quotationDate: snap.created_at ? snap.created_at.slice(0, 10) : (q.created_at ? q.created_at.slice(0, 10) : getTodayHotelDate()),
    validUntil: '',
    reference: '',
    subject: '',

    customerName: snapCustomer.name || q.customer_name || '',
    contactPerson: '',
    phone: snapCustomer.phone || q.customer_phone || '',
    email: snapCustomer.email || q.customer_email || '',
    address: snapCustomer.address || q.customer_address || '',

    checkIn: snapStay.check_in_date || (q.check_in_date ? q.check_in_date.slice(0, 10) : '') || '',
    checkOut: snapStay.check_out_date || (q.check_out_date ? q.check_out_date.slice(0, 10) : '') || '',
    roomType: '',
    roomNumber: '',
    guestCount: null,

    items: (snap.items || []).map((it: any, idx: number) => ({
      id: it.id || `item-${idx + 1}`,
      description: it.description || '',
      qty: Math.max(0, Number(it.quantity ?? it.qty) || 1),
      unit: it.unit || '',
      unitPrice: Math.max(0, Number(it.unit_price ?? it.unitPrice) || 0),
      discountType: it.discount_type === 'percent' || it.discountType === 'percent' ? 'percent' : 'amount',
      discountValue: Math.max(0, Number(it.discount_value ?? it.discountValue ?? it.discount ?? 0)),
      note: it.note || '',
    })),

    discountType: 'amount',
    discountValue: Number(snapPricing.total_discount || 0),

    serviceType: snapPricing.service_rate ? 'percent' : 'amount',
    serviceValue: Number(snapPricing.service_rate || snapPricing.service_amount || 0),

    taxType: snapPricing.tax_rate ? 'percent' : 'amount',
    taxValue: Number(snapPricing.tax_rate || snapPricing.tax_amount || 0),

    notes: snap.notes || q.notes || '',
    terms: snap.terms_conditions || q.terms_conditions || '',

    bankName: snap.bank_details?.bank_name || '',
    bankAccountName: snap.bank_details?.bank_account_name || '',
    bankAccountNumber: snap.bank_details?.bank_account_number || '',
  };
}
