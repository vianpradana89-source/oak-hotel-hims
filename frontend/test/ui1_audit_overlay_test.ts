import assert from 'node:assert/strict';
import {
  applyAuditOverlay
} from '../src/features/transactions/transactionDomainTypes.ts';
import {
  groupPenjualanSaleRows,
  worstVerificationStatus
} from '../src/features/transactions/penjualanBidGrouping.ts';
import type { TransactionRecord } from '../src/features/transactions/transactionDomainTypes.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

function sale(partial: Partial<TransactionRecord> & { id: number }): TransactionRecord {
  return {
    property_id: 1,
    transaction_no: `TRX-${partial.id}`,
    transaction_date: '2026-09-29',
    transaction_time: '10:00:00',
    transaction_type: 'SALE',
    source_type: 'ROOM_CHARGE',
    source_id: null,
    source_reference: null,
    party_name: 'TAMU AUDIT',
    category_code: 'ROOM_SALES',
    category_name: 'Room Sales',
    department_code: 'FRONT_OFFICE',
    description: 'Room charge',
    amount: 400000,
    discount_amount: 0,
    service_amount: 0,
    tax_amount: 0,
    net_amount: 400000,
    payment_status: 'PAID',
    payment_method: 'CASH',
    transaction_status: 'POSTED',
    guest_id: null,
    guest_name_snapshot: 'TAMU AUDIT',
    room_number_snapshot: '101',
    reservation_id: 101,
    stay_sequence: 1,
    booking_id: 10,
    booking_bid: 'BID-AUDIT-01',
    stay_type: 'OVERNIGHT',
    verification_status: 'UNVERIFIED',
    reversal_of_transaction_id: null,
    correction_group_id: null,
    notes: null,
    metadata: {},
    created_by: null,
    created_at: '2026-09-29T03:00:00.000Z',
    reservation_status: 'CHECKED_OUT',
    reservation_stay_status: 'CHECKED_OUT',
    operational_sheet: 'SELESAI',
    ...partial
  } as TransactionRecord;
}

console.log('=== OAK HIMS UI-1 Audit Overlay Tests ===\n');

// ──────────────────────────────────────────────
// A. CHECKED_OUT + UNVERIFIED => tetap SELESAI
// ──────────────────────────────────────────────
const a = applyAuditOverlay(sale({
  id: 1,
  reservation_id: 100,
  reservation_status: 'CHECKED_OUT',
  reservation_stay_status: 'CHECKED_OUT',
  verification_status: 'UNVERIFIED',
  operational_sheet: 'SELESAI'
}));
check(a === 'SELESAI', 'A. checked-out + UNVERIFIED stays SELESAI');

// ──────────────────────────────────────────────
// B. CHECKED_OUT + VERIFIED => tetap SELESAI
// ──────────────────────────────────────────────
const b = applyAuditOverlay(sale({
  id: 2,
  reservation_id: 101,
  reservation_status: 'CHECKED_OUT',
  reservation_stay_status: 'CHECKED_OUT',
  verification_status: 'VERIFIED',
  operational_sheet: 'SELESAI'
}));
check(b === 'SELESAI', 'B. checked-out + VERIFIED stays SELESAI');

// ──────────────────────────────────────────────
// C. CHECKED_OUT + REJECTED => PROSES (overlay)
// ──────────────────────────────────────────────
const c = applyAuditOverlay(sale({
  id: 3,
  reservation_id: 102,
  reservation_status: 'CHECKED_OUT',
  reservation_stay_status: 'CHECKED_OUT',
  verification_status: 'REJECTED',
  operational_sheet: 'SELESAI'
}));
check(c === 'PROSES', 'C. checked-out + REJECTED forced to PROSES');

// ──────────────────────────────────────────────
// D. CHECKED_IN + VERIFIED => tetap PROSES
// ──────────────────────────────────────────────
const d = applyAuditOverlay(sale({
  id: 4,
  reservation_id: 103,
  reservation_status: 'CHECKED_IN',
  reservation_stay_status: 'CHECKED_IN',
  verification_status: 'VERIFIED',
  operational_sheet: 'PROSES'
}));
check(d === 'PROSES', 'D. checked-in + VERIFIED stays PROSES');

// ──────────────────────────────────────────────
// E. CANCELLED + REJECTED => BATAL (terminal wins)
// ──────────────────────────────────────────────
const e = applyAuditOverlay(sale({
  id: 5,
  reservation_id: 104,
  reservation_status: 'CANCELLED',
  reservation_stay_status: 'CANCELLED',
  verification_status: 'REJECTED',
  operational_sheet: 'BATAL'
}));
check(e === 'BATAL', 'E. cancelled + REJECTED stays BATAL (terminal wins over audit)');

// ──────────────────────────────────────────────
// F. BID: fully CHECKED_OUT + one REJECTED member => parent PROSES
// ──────────────────────────────────────────────
const fGroup = groupPenjualanSaleRows([
  sale({
    id: 6,
    reservation_id: 200,
    room_number_snapshot: '201',
    booking_bid: 'BID-AUDIT-F',
    verification_status: 'UNVERIFIED',
    reservation_status: 'CHECKED_OUT',
    reservation_stay_status: 'CHECKED_OUT',
    operational_sheet: 'SELESAI'
  }),
  sale({
    id: 7,
    reservation_id: 201,
    room_number_snapshot: '202',
    booking_bid: 'BID-AUDIT-F',
    verification_status: 'REJECTED',
    reservation_status: 'CHECKED_OUT',
    reservation_stay_status: 'CHECKED_OUT',
    operational_sheet: 'SELESAI'
  })
]);
check(fGroup.length === 1 && fGroup[0].kind === 'bid_group', 'F. one bid_group');
if (fGroup[0].kind === 'bid_group') {
  const rejectedChild = fGroup[0].group.children.find((child) => child.room_number === '202');
  check(rejectedChild?.operational_sheet === 'PROSES', 'F. REJECTED child overlay to PROSES');
  check(fGroup[0].group.operational_sheet === 'PROSES', 'F. parent BID with one REJECTED member forced to PROSES');
  check(fGroup[0].group.audit_verification_status === 'REJECTED', 'F. parent audit_verification_status is REJECTED');
  const selesaiChild = fGroup[0].group.children.find((child) => child.room_number === '201');
  check(selesaiChild?.operational_sheet === 'SELESAI', 'F. non-rejected child stays SELESAI');
}

// ──────────────────────────────────────────────
// G. BID: fully CHECKED_OUT + no REJECTED => parent SELESAI
// ──────────────────────────────────────────────
const gGroup = groupPenjualanSaleRows([
  sale({
    id: 8,
    reservation_id: 300,
    room_number_snapshot: '301',
    booking_bid: 'BID-AUDIT-G',
    verification_status: 'UNVERIFIED',
    reservation_status: 'CHECKED_OUT',
    reservation_stay_status: 'CHECKED_OUT',
    operational_sheet: 'SELESAI'
  }),
  sale({
    id: 9,
    reservation_id: 0 + 301,
    room_number_snapshot: '302',
    booking_bid: 'BID-AUDIT-G',
    verification_status: 'VERIFIED',
    reservation_status: 'CHECKED_OUT',
    reservation_stay_status: 'CHECKED_OUT',
    operational_sheet: 'SELESAI'
  })
]);
check(gGroup.length === 1 && gGroup[0].kind === 'bid_group', 'G. one bid_group');
if (gGroup[0].kind === 'bid_group') {
  check(gGroup[0].group.operational_sheet === 'SELESAI', 'G. fully checked-out no REJECTED stays SELESAI');
  check(gGroup[0].group.audit_verification_status === 'UNVERIFIED', 'G. parent audit_verification_status is UNVERIFIED (mixed UNVERIFIED+VERIFIED)');
}

// ──────────────────────────────────────────────
// H. FULLY CANCELLED BID + REJECTED => BATAL (terminal wins)
// ──────────────────────────────────────────────
const hGroup = groupPenjualanSaleRows([
  sale({
    id: 10,
    reservation_id: 400,
    room_number_snapshot: '401',
    booking_bid: 'BID-AUDIT-H',
    verification_status: 'REJECTED',
    reservation_status: 'CANCELLED',
    reservation_stay_status: 'CANCELLED',
    operational_sheet: 'BATAL'
  }),
  sale({
    id: 11,
    reservation_id: 401,
    room_number_snapshot: '402',
    booking_bid: 'BID-AUDIT-H',
    verification_status: 'UNVERIFIED',
    reservation_status: 'CANCELLED',
    reservation_stay_status: 'CANCELLED',
    operational_sheet: 'BATAL'
  })
]);
check(hGroup.length === 1 && hGroup[0].kind === 'bid_group', 'H. one bid_group');
if (hGroup[0].kind === 'bid_group') {
  check(hGroup[0].group.operational_sheet === 'BATAL', 'H. fully cancelled BID stays BATAL despite REJECTED');
}

// ──────────────────────────────────────────────
// I. NON-RESERVATION SALE: REJECTED does NOT overlay
// ──────────────────────────────────────────────
const i = applyAuditOverlay(sale({
  id: 12,
  reservation_id: null,
  reservation_status: null,
  reservation_stay_status: null,
  booking_id: null,
  booking_bid: null,
  source_type: 'POS',
  verification_status: 'REJECTED',
  operational_sheet: null,
}));
check(i === 'PROSES', 'I. non-reservation POS REJECTED falls through to default PROSES (no overlay for non-reservation)');

// ──────────────────────────────────────────────
// J. worstVerificationStatus ordering
// ──────────────────────────────────────────────
check(worstVerificationStatus(['UNVERIFIED', 'VERIFIED']) === 'UNVERIFIED', 'J1. UNVERIFIED+VERIFIED => UNVERIFIED (uninspected wins over verified)');
check(worstVerificationStatus(['UNVERIFIED', 'REJECTED']) === 'REJECTED', 'J2. UNVERIFIED+REJECTED => REJECTED');
check(worstVerificationStatus(['VERIFIED', 'REJECTED']) === 'REJECTED', 'J3. VERIFIED+REJECTED => REJECTED');
check(worstVerificationStatus(['UNVERIFIED', 'UNVERIFIED']) === 'UNVERIFIED', 'J4. UNVERIFIED+UNVERIFIED => UNVERIFIED');
check(worstVerificationStatus([]) === undefined, 'J5. empty => undefined');
check(worstVerificationStatus([null, undefined]) === undefined, 'J6. null/undefined => undefined');
check(worstVerificationStatus(['VERIFIED', 'VERIFIED']) === 'VERIFIED', 'J7. VERIFIED+VERIFIED => VERIFIED');

// ──────────────────────────────────────────────
// K. BUG1: primary UNVERIFIED + secondary REJECTED => child PROSES
// ──────────────────────────────────────────────
const bug1Primary = sale({
  id: 7001,
  reservation_id: 7001,
  stay_sequence: 1,
  room_number_snapshot: '801',
  room_type_name: 'DELUXE KING',
  check_in: '2026-09-29',
  check_out: '2026-09-30',
  amount: 400000,
  discount_amount: 0,
  net_amount: 400000,
  effective_net_amount: 400000,
  reservation_amount_paid: 400000,
  reservation_remaining_balance: 0,
  reservation_status: 'CHECKED_OUT',
  reservation_stay_status: 'CHECKED_OUT',
  operational_sheet: 'SELESAI',
  verification_status: 'UNVERIFIED',
  booking_bid: 'LWG-BUG1-K',
  booking_id: 80,
});
const bug1Secondary = sale({
  id: 7002,
  reservation_id: 7001,
  stay_sequence: 1,
  room_number_snapshot: '801',
  room_type_name: 'DELUXE KING',
  source_type: 'EXTRA_BED',
  amount: 50000,
  discount_amount: 0,
  net_amount: 50000,
  effective_net_amount: 50000,
  reservation_amount_paid: 400000,
  reservation_remaining_balance: 0,
  reservation_status: 'CHECKED_OUT',
  reservation_stay_status: 'CHECKED_OUT',
  operational_sheet: 'SELESAI',
  verification_status: 'REJECTED',
  booking_bid: 'LWG-BUG1-K',
  booking_id: 80,
  transaction_time: '10:05:00',
});
const bug1Grouped = groupPenjualanSaleRows([bug1Primary, bug1Secondary]);
check(bug1Grouped.length === 1 && bug1Grouped[0].kind === 'bid_group', 'K. same-reservation two members => one bid_group');
if (bug1Grouped[0].kind === 'bid_group') {
  const child = bug1Grouped[0].group.children.find((c) => c.room_number === '801');
  check(child && child.audit_verification_status === 'REJECTED', 'K. child audit status is REJECTED (aggregated from both members)');
  check(child && child.operational_sheet === 'PROSES', 'K. child operational_sheet is PROSES despite primary being UNVERIFIED (aggregated wins)');
  check(child && child.canonical_operational_sheet === 'SELESAI', 'K. canonical sheet preserved as SELESAI');
  check(bug1Grouped[0].group.operational_sheet === 'PROSES', 'K. parent forced to PROSES by REJECTED child');
}

console.log(`\n=== ALL UI-1 AUDIT OVERLAY TESTS PASSED (${assertions} assertions) ===`);
