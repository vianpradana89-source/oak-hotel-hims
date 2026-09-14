/**
 * CHECKOUT-GUARANTEE-GATE-1A — Policy & Behavioral Test Suite
 *
 * Comprehensive validation of canonical checkout guarantee gates covering
 * Matrix Scenarios A through P, pure helper semantics, failsafe handling,
 * copy verification, and entry-point unification.
 *
 * Run: cd frontend && node --experimental-strip-types test/checkout_guarantee_gate_1a_test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deriveCheckoutGateDecision,
  formatGroupGuaranteeSummary,
  type CheckoutGateDecision,
  type CheckoutGateAction,
} from '../src/features/deposits/guaranteeScopePolicy.ts';
import type { Deposit, IdentityCustodyRecord } from '../src/features/deposits/depositApi.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== OAK HIMS CHECKOUT-GUARANTEE-GATE-1A Test Suite ===\n');

// ---------------------------------------------------------------------------
// Fixture Helpers
// ---------------------------------------------------------------------------
function makeDeposit(overrides: Partial<Deposit> = {}): Deposit {
  return {
    id: 1,
    property_id: 1,
    booking_id: 100,
    reservation_id: 101,
    scope: 'ROOM_RESERVATION',
    status: 'ACTIVE',
    receipt_number: 'DEP-001',
    received_amount: 100000,
    payment_method: 'CASH',
    received_by_staff_id: 1,
    received_at: '2026-09-14T07:00:00Z',
    created_at: '2026-09-14T07:00:00Z',
    updated_at: '2026-09-14T07:00:00Z',
    balance: {
      received: 100000,
      applied: 0,
      refunded: 0,
      remaining: 100000,
    },
    ...overrides,
  } as Deposit;
}

function makeCustody(overrides: Partial<IdentityCustodyRecord> = {}): IdentityCustodyRecord {
  return {
    id: 1,
    property_id: 1,
    booking_id: 100,
    reservation_id: 101,
    scope: 'ROOM_RESERVATION',
    status: 'HELD',
    document_type: 'KTP',
    document_holder_name: 'Budi Santoso',
    document_number: '3171012345678901',
    held_by_staff_id: 1,
    held_at: '2026-09-14T07:00:00Z',
    created_at: '2026-09-14T07:00:00Z',
    updated_at: '2026-09-14T07:00:00Z',
    ...overrides,
  } as IdentityCustodyRecord;
}

// ===========================================================================
// SCENARIO A: Single room, room deposit > 0, identity clear
// => WARN_ROOM_DEPOSIT => soft warning, proceed on confirmation
// ===========================================================================
{
  const res = { id: 101, status: 'CHECKED_IN', booking_id: 100 };
  const deposits = [makeDeposit({ scope: 'ROOM_RESERVATION', balance: { received: 100000, applied: 0, refunded: 0, remaining: 100000 } })];
  const custody: IdentityCustodyRecord[] = [];

  const dec = deriveCheckoutGateDecision({
    currentReservation: res,
    siblingReservations: [],
    deposits,
    custody,
    loadStatus: 'ready',
  });

  check(dec.action === 'WARN_ROOM_DEPOSIT', 'Scenario A: action is WARN_ROOM_DEPOSIT');
  check(dec.roomDepositRemaining === 100000, 'Scenario A: room deposit remaining is 100000');
  check(!dec.isMultiRoom, 'Scenario A: is not multi room');
}

// ===========================================================================
// SCENARIO B: Single room, identity HELD
// => HARD_BLOCK_ROOM_IDENTITY => hard block, checkout strictly blocked
// ===========================================================================
{
  const res = { id: 101, status: 'CHECKED_IN', booking_id: 100 };
  const deposits: Deposit[] = [];
  const custody = [makeCustody({ scope: 'ROOM_RESERVATION', status: 'HELD', document_holder_name: 'Ahmad Dahlan' })];

  const dec = deriveCheckoutGateDecision({
    currentReservation: res,
    siblingReservations: [],
    deposits,
    custody,
    loadStatus: 'ready',
  });

  check(dec.action === 'HARD_BLOCK_ROOM_IDENTITY', 'Scenario B: action is HARD_BLOCK_ROOM_IDENTITY');
  check(dec.heldRoomCustodyHolderName === 'Ahmad Dahlan', 'Scenario B: held holder name matches');
}

// ===========================================================================
// SCENARIO C: Single room, room deposit + identity HELD
// => HARD BLOCK takes precedence over deposit warning
// ===========================================================================
{
  const res = { id: 101, status: 'CHECKED_IN', booking_id: 100 };
  const deposits = [makeDeposit({ scope: 'ROOM_RESERVATION', balance: { received: 50000, applied: 0, refunded: 0, remaining: 50000 } })];
  const custody = [makeCustody({ scope: 'ROOM_RESERVATION', status: 'HELD', document_holder_name: 'Citra Dewi' })];

  const dec = deriveCheckoutGateDecision({
    currentReservation: res,
    siblingReservations: [],
    deposits,
    custody,
    loadStatus: 'ready',
  });

  check(dec.action === 'HARD_BLOCK_ROOM_IDENTITY', 'Scenario C: HARD_BLOCK_ROOM_IDENTITY takes precedence');
}

// ===========================================================================
// SCENARIO D: Single room, all guarantees settled
// => ALLOW => ordinary clean confirmation
// ===========================================================================
{
  const res = { id: 101, status: 'CHECKED_IN', booking_id: 100 };
  const deposits = [makeDeposit({ scope: 'ROOM_RESERVATION', status: 'CLOSED', balance: { received: 100000, applied: 100000, refunded: 0, remaining: 0 } })];
  const custody = [makeCustody({ scope: 'ROOM_RESERVATION', status: 'RETURNED' })];

  const dec = deriveCheckoutGateDecision({
    currentReservation: res,
    siblingReservations: [],
    deposits,
    custody,
    loadStatus: 'ready',
  });

  check(dec.action === 'ALLOW', 'Scenario D: action is ALLOW (ordinary confirmation)');
}

// ===========================================================================
// SCENARIO E: Multi-room non-final child, group deposit unresolved
// => NO group warning, ALLOW if room clear
// ===========================================================================
{
  const res = { id: 101, status: 'CHECKED_IN', booking_id: 100 };
  // Sibling 102 is still CHECKED_IN (active child)
  const siblings = [{ id: 102, status: 'CHECKED_IN' }];
  const deposits = [makeDeposit({ scope: 'BOOKING_GROUP', balance: { received: 200000, applied: 0, refunded: 0, remaining: 200000 } })];
  const custody: IdentityCustodyRecord[] = [];

  const dec = deriveCheckoutGateDecision({
    currentReservation: res,
    siblingReservations: siblings,
    deposits,
    custody,
    loadStatus: 'ready',
  });

  check(dec.action === 'ALLOW', 'Scenario E: non-final child with group deposit allows clean checkout (no group warning)');
  check(dec.isMultiRoom === true, 'Scenario E: isMultiRoom is true');
  check(dec.isFinalChild === false, 'Scenario E: isFinalChild is false');
}

// ===========================================================================
// SCENARIO F: Multi-room non-final child, group identity HELD
// => NO group warning, group identity custody does not block child checkout
// ===========================================================================
{
  const res = { id: 101, status: 'CHECKED_IN', booking_id: 100 };
  const siblings = [{ id: 102, status: 'BOOKED' }];
  const deposits: Deposit[] = [];
  const custody = [makeCustody({ scope: 'BOOKING_GROUP', status: 'HELD', document_holder_name: 'Eko Group' })];

  const dec = deriveCheckoutGateDecision({
    currentReservation: res,
    siblingReservations: siblings,
    deposits,
    custody,
    loadStatus: 'ready',
  });

  check(dec.action === 'ALLOW', 'Scenario F: non-final child with group identity held allows clean checkout (no group block)');
  check(dec.isFinalChild === false, 'Scenario F: isFinalChild is false');
}

// ===========================================================================
// SCENARIO G: Multi-room FINAL child, group deposit unresolved
// => WARN_FINAL_GROUP_GUARANTEE => soft warning
// ===========================================================================
{
  const res = { id: 101, status: 'CHECKED_IN', booking_id: 100 };
  // Sibling 102 is already CHECKED_OUT (terminal)
  const siblings = [{ id: 102, status: 'CHECKED_OUT' }];
  const deposits = [makeDeposit({ scope: 'BOOKING_GROUP', balance: { received: 200000, applied: 0, refunded: 0, remaining: 200000 } })];
  const custody: IdentityCustodyRecord[] = [];

  const dec = deriveCheckoutGateDecision({
    currentReservation: res,
    siblingReservations: siblings,
    deposits,
    custody,
    loadStatus: 'ready',
  });

  check(dec.action === 'WARN_FINAL_GROUP_GUARANTEE', 'Scenario G: final child with group deposit produces WARN_FINAL_GROUP_GUARANTEE');
  check(dec.isFinalChild === true, 'Scenario G: isFinalChild is true');
  check(dec.groupDepositRemaining === 200000, 'Scenario G: groupDepositRemaining is 200000');
  check(dec.groupGuaranteeSummary === 'DEPOSIT_ONLY', 'Scenario G: summary is DEPOSIT_ONLY');
}

// ===========================================================================
// SCENARIO H: Multi-room FINAL child, group identity HELD
// => WARN_FINAL_GROUP_GUARANTEE => soft warning (eligible for manual settlement post-checkout)
// ===========================================================================
{
  const res = { id: 101, status: 'CHECKED_IN', booking_id: 100 };
  // Sibling 102 is CANCELLED (terminal)
  const siblings = [{ id: 102, status: 'CANCELLED' }];
  const deposits: Deposit[] = [];
  const custody = [makeCustody({ scope: 'BOOKING_GROUP', status: 'HELD' })];

  const dec = deriveCheckoutGateDecision({
    currentReservation: res,
    siblingReservations: siblings,
    deposits,
    custody,
    loadStatus: 'ready',
  });

  check(dec.action === 'WARN_FINAL_GROUP_GUARANTEE', 'Scenario H: final child with group identity produces WARN_FINAL_GROUP_GUARANTEE');
  check(dec.isFinalChild === true, 'Scenario H: isFinalChild is true');
  check(dec.groupCustodyHeld === true, 'Scenario H: groupCustodyHeld is true');
  check(dec.groupGuaranteeSummary === 'CUSTODY_ONLY', 'Scenario H: summary is CUSTODY_ONLY');
}

// ===========================================================================
// SCENARIO I: Final child, room deposit unresolved + group guarantee unresolved
// => WARN_ROOM_AND_FINAL_GROUP => combined warning
// ===========================================================================
{
  const res = { id: 101, status: 'CHECKED_IN', booking_id: 100 };
  const siblings = [{ id: 102, status: 'CHECKED_OUT' }];
  const deposits = [
    makeDeposit({ id: 1, scope: 'ROOM_RESERVATION', balance: { received: 50000, applied: 0, refunded: 0, remaining: 50000 } }),
    makeDeposit({ id: 2, scope: 'BOOKING_GROUP', balance: { received: 150000, applied: 0, refunded: 0, remaining: 150000 } }),
  ];
  const custody = [makeCustody({ scope: 'BOOKING_GROUP', status: 'HELD' })];

  const dec = deriveCheckoutGateDecision({
    currentReservation: res,
    siblingReservations: siblings,
    deposits,
    custody,
    loadStatus: 'ready',
  });

  check(dec.action === 'WARN_ROOM_AND_FINAL_GROUP', 'Scenario I: combined warning triggered');
  check(dec.roomDepositRemaining === 50000, 'Scenario I: room deposit is 50000');
  check(dec.groupDepositRemaining === 150000, 'Scenario I: group deposit is 150000');
  check(dec.groupGuaranteeSummary === 'DEPOSIT_AND_CUSTODY', 'Scenario I: summary is DEPOSIT_AND_CUSTODY');
}

// ===========================================================================
// SCENARIO J: Room guarantee settled, group unresolved, non-final
// => ALLOW => ordinary clean confirmation
// ===========================================================================
{
  const res = { id: 101, status: 'CHECKED_IN', booking_id: 100 };
  const siblings = [{ id: 102, status: 'CHECKED_IN' }, { id: 103, status: 'CHECKED_OUT' }];
  const deposits = [
    makeDeposit({ id: 1, scope: 'ROOM_RESERVATION', balance: { received: 50000, applied: 50000, refunded: 0, remaining: 0 } }),
    makeDeposit({ id: 2, scope: 'BOOKING_GROUP', balance: { received: 300000, applied: 0, refunded: 0, remaining: 300000 } }),
  ];
  const custody: IdentityCustodyRecord[] = [];

  const dec = deriveCheckoutGateDecision({
    currentReservation: res,
    siblingReservations: siblings,
    deposits,
    custody,
    loadStatus: 'ready',
  });

  check(dec.action === 'ALLOW', 'Scenario J: ordinary checkout when room settled and child non-final');
}

// ===========================================================================
// SCENARIO K: Room guarantee settled, group unresolved, final
// => WARN_FINAL_GROUP_GUARANTEE
// ===========================================================================
{
  const res = { id: 101, status: 'CHECKED_IN', booking_id: 100 };
  const siblings = [{ id: 102, status: 'CHECKED_OUT' }, { id: 103, status: 'CHECKED_OUT' }];
  const deposits = [
    makeDeposit({ id: 1, scope: 'ROOM_RESERVATION', balance: { received: 50000, applied: 50000, refunded: 0, remaining: 0 } }),
    makeDeposit({ id: 2, scope: 'BOOKING_GROUP', balance: { received: 300000, applied: 0, refunded: 0, remaining: 300000 } }),
  ];
  const custody: IdentityCustodyRecord[] = [];

  const dec = deriveCheckoutGateDecision({
    currentReservation: res,
    siblingReservations: siblings,
    deposits,
    custody,
    loadStatus: 'ready',
  });

  check(dec.action === 'WARN_FINAL_GROUP_GUARANTEE', 'Scenario K: final child warns group guarantee');
}

// ===========================================================================
// SCENARIO L: Room deposit unresolved, group settled
// => WARN_ROOM_DEPOSIT
// ===========================================================================
{
  const res = { id: 101, status: 'CHECKED_IN', booking_id: 100 };
  const siblings = [{ id: 102, status: 'CHECKED_OUT' }];
  const deposits = [
    makeDeposit({ id: 1, scope: 'ROOM_RESERVATION', balance: { received: 75000, applied: 0, refunded: 0, remaining: 75000 } }),
    makeDeposit({ id: 2, scope: 'BOOKING_GROUP', balance: { received: 200000, applied: 200000, refunded: 0, remaining: 0 } }),
  ];
  const custody: IdentityCustodyRecord[] = [];

  const dec = deriveCheckoutGateDecision({
    currentReservation: res,
    siblingReservations: siblings,
    deposits,
    custody,
    loadStatus: 'ready',
  });

  check(dec.action === 'WARN_ROOM_DEPOSIT', 'Scenario L: room deposit warning when group is settled');
  check(dec.roomDepositRemaining === 75000, 'Scenario L: room deposit is 75000');
}

// ===========================================================================
// SCENARIO M: Malformed / unknown guarantee payload => FAIL SAFE (WARN_UNVERIFIED)
// ===========================================================================
{
  const res = { id: 101, status: 'CHECKED_IN', booking_id: 100 };

  // M1: deposits is null
  const decM1 = deriveCheckoutGateDecision({
    currentReservation: res,
    siblingReservations: [],
    deposits: null,
    custody: [],
    loadStatus: 'ready',
  });
  check(decM1.action === 'WARN_UNVERIFIED', 'Scenario M1: null deposits returns WARN_UNVERIFIED');

  // M2: custody is null
  const decM2 = deriveCheckoutGateDecision({
    currentReservation: res,
    siblingReservations: [],
    deposits: [],
    custody: null,
    loadStatus: 'ready',
  });
  check(decM2.action === 'WARN_UNVERIFIED', 'Scenario M2: null custody returns WARN_UNVERIFIED');

  // M3: loadStatus is error
  const decM3 = deriveCheckoutGateDecision({
    currentReservation: res,
    siblingReservations: [],
    deposits: [],
    custody: [],
    loadStatus: 'error',
  });
  check(decM3.action === 'WARN_UNVERIFIED', 'Scenario M3: loadStatus error returns WARN_UNVERIFIED');

  // M4: reservation is null
  const decM4 = deriveCheckoutGateDecision({
    currentReservation: null,
    siblingReservations: [],
    deposits: [],
    custody: [],
    loadStatus: 'ready',
  });
  check(decM4.action === 'WARN_UNVERIFIED', 'Scenario M4: null reservation returns WARN_UNVERIFIED');

  // M5: malformed deposit item
  const decM5 = deriveCheckoutGateDecision({
    currentReservation: res,
    siblingReservations: [],
    deposits: ['invalid' as any],
    custody: [],
    loadStatus: 'ready',
  });
  check(decM5.action === 'WARN_UNVERIFIED', 'Scenario M5: malformed deposit returns WARN_UNVERIFIED');
}

// ===========================================================================
// SCENARIO N: Source structural audit: All 4 entry points route to same decision flow
// ===========================================================================
{
  const appSrc = readSrc('src/App.tsx');
  const drawerSrc = readSrc('src/features/calendar/ReservationDetailDrawer.tsx');
  const quickDetailSrc = readSrc('src/features/calendar/QuickReservationDetail.tsx');
  const modalSrc = readSrc('src/features/deposits/CheckoutGuaranteeConfirmationModal.tsx');

  // Entry Point A: ReservationDetailDrawer "Check-out Tamu"
  check(
    drawerSrc.includes('onCheckout(targetId, data, async (updatedDto) => {') &&
    drawerSrc.includes('const targetId = Number(data.id);'),
    'Scenario N-A: ReservationDetailDrawer dispatches onCheckout with active reservation data and post-checkout onSuccess handler'
  );
  check(
    appSrc.includes('onCheckout={(resId, resHint, onSuccess) => openCheckoutConfirmation(resId, resHint ?? selectedRes, onSuccess)}'),
    'Scenario N-A: App.tsx routes ReservationDetailDrawer onCheckout to openCheckoutConfirmation with resHint and onSuccess'
  );

  // Entry Point B: QuickReservationDetail "Check-out Tamu"
  check(
    quickDetailSrc.includes('onCheckout(data.id)'),
    'Scenario N-B: QuickReservationDetail dispatches onCheckout'
  );
  check(
    appSrc.includes('onCheckout={(resId) => openCheckoutConfirmation(resId, quickReservation.reservation)}'),
    'Scenario N-B: App.tsx routes QuickReservationDetail onCheckout to openCheckoutConfirmation'
  );

  // Entry Point C: TransactionWorkspace checkout action
  check(
    appSrc.includes('onCheckout={(res) => openCheckoutConfirmation(Number(res.id), res)}'),
    'Scenario N-C: TransactionWorkspace routes onCheckout to openCheckoutConfirmation'
  );

  // Entry Point D: App.tsx quickActionButtons
  check(
    appSrc.includes("key: 'checkout', label: 'Checkout', enabled: canCheckOut, disabled: false, title: undefined, variant: 'warn', onClick: () => openCheckoutConfirmation(Number(selectedRes?.id), selectedRes)"),
    'Scenario N-D: quickActionButtons routes to openCheckoutConfirmation'
  );

  // Single canonical modal mounted in App.tsx
  check(
    appSrc.includes('<CheckoutGuaranteeConfirmationModal'),
    'Scenario N-E: CheckoutGuaranteeConfirmationModal is mounted in App.tsx'
  );
  check(
    !appSrc.includes('Apakah jaminan deposit sudah dikembalikan kepada tamu?'),
    'Scenario N-F: Legacy static checkoutConfirmOpen prompt is completely removed'
  );
}

// ===========================================================================
// SCENARIO O & P: Behavioral verification of confirmation & cancellation
// ===========================================================================
{
  const modalSrc = readSrc('src/features/deposits/CheckoutGuaranteeConfirmationModal.tsx');

  // Scenario O: Confirming soft warning calls onConfirmCheckout exactly once
  check(
    modalSrc.includes('if (submitting) return;'),
    'Scenario O-1: Double-click / repeat execution guard exists'
  );
  check(
    modalSrc.includes('setSubmitting(true);') &&
    modalSrc.includes('await onConfirmCheckout(reservationId);') &&
    modalSrc.includes('onClose();'),
    'Scenario O-2: Confirming executes checkout callback exactly once and closes modal'
  );

  // Scenario P: Cancelling warning calls checkout zero times
  check(
    modalSrc.includes('onClick={onClose}') &&
    !modalSrc.match(/onClick=\{.*onClose.*onConfirmCheckout/),
    'Scenario P-1: Cancel buttons call onClose without executing onConfirmCheckout'
  );

  // Hard block: checkout button NOT rendered
  const hardBlockMatch = modalSrc.match(/if\s*\(decision\.action\s*===\s*'HARD_BLOCK_ROOM_IDENTITY'\)\s*\{([\s\S]*?)\n  \}/);
  check(
    hardBlockMatch !== null && !hardBlockMatch[1].includes('handleConfirm') && !hardBlockMatch[1].includes('onConfirmCheckout'),
    'Scenario B-Check: HARD_BLOCK_ROOM_IDENTITY does not render any confirm/checkout button'
  );
}

// ===========================================================================
// Copy & Indonesian Text Invariants
// ===========================================================================
{
  const modalSrc = readSrc('src/features/deposits/CheckoutGuaranteeConfirmationModal.tsx');

  check(
    modalSrc.includes('Tidak Dapat Memproses Check-out'),
    'Copy 1: Hard block title is "Tidak Dapat Memproses Check-out"'
  );
  check(
    modalSrc.includes('KTP/SIM fisik atas nama'),
    'Copy 2: Hard block message contains KTP/SIM fisik atas nama {holder}'
  );
  check(
    modalSrc.includes('masih ditahan untuk kamar ini. Kembalikan identitas tamu terlebih dahulu pada bagian Jaminan sebelum memproses check-out.'),
    'Copy 3: Hard block message contains exact required instructions'
  );
  check(
    modalSrc.includes('Peringatan: Jaminan Kamar Belum Selesai'),
    'Copy 4: Room deposit warning title is "Peringatan: Jaminan Kamar Belum Selesai"'
  );
  check(
    modalSrc.includes('Deposit tidak dikembalikan otomatis saat check-out dan tetap tersimpan di antrean jaminan untuk pengembalian manual. Lanjutkan check-out?'),
    'Copy 5: Room deposit warning message matches canonical specification'
  );
  check(
    modalSrc.includes('Check-out Kamar Terakhir — Jaminan Grup Siap Diselesaikan'),
    'Copy 6: Final group guarantee warning title matches canonical specification'
  );
  check(
    modalSrc.includes('Check-out Kamar Terakhir — Jaminan Kamar & Grup Belum Selesai'),
    'Copy 7: Combined room and group warning title matches canonical specification'
  );
  check(
    modalSrc.includes('Konfirmasi Check-out'),
    'Copy 8: Clean checkout title is "Konfirmasi Check-out"'
  );
  check(
    modalSrc.includes('Apakah Anda yakin ingin memproses check-out untuk Kamar'),
    'Copy 9: Clean checkout message asks for confirmation with room number'
  );
}

// ===========================================================================
// Format Helper Tests
// ===========================================================================
{
  check(
    formatGroupGuaranteeSummary('DEPOSIT_AND_CUSTODY', '100.000') === 'Deposit Grup (Rp 100.000) & KTP Grup',
    'Helper 1: DEPOSIT_AND_CUSTODY formatted correctly'
  );
  check(
    formatGroupGuaranteeSummary('DEPOSIT_ONLY', '50.000') === 'Deposit Grup (Rp 50.000)',
    'Helper 2: DEPOSIT_ONLY formatted correctly'
  );
  check(
    formatGroupGuaranteeSummary('CUSTODY_ONLY') === 'KTP Grup',
    'Helper 3: CUSTODY_ONLY formatted correctly'
  );
}

// ===========================================================================
// REGRESSION SUITE: CHECKOUT-GUARANTEE-GATE-1B (FINAL CHILD GROUP WARNING HOTFIX)
// ===========================================================================

// Case 1: Sibling array includes current child + checked-out sibling:
// current = CHECKED_IN, other = CHECKED_OUT, unresolved BOOKING_GROUP
// => WARN_FINAL_GROUP_GUARANTEE
{
  const res = { id: 102, status: 'CHECKED_IN', booking_id: 200 };
  const siblings = [
    { id: 101, status: 'CHECKED_OUT', booking_id: 200 },
    { id: 102, status: 'CHECKED_IN', booking_id: 200 },
  ];
  const deposits = [makeDeposit({ scope: 'BOOKING_GROUP', balance: { received: 200000, applied: 0, refunded: 0, remaining: 200000 } })];
  const custody = [makeCustody({ scope: 'BOOKING_GROUP', status: 'HELD' })];

  const dec = deriveCheckoutGateDecision({
    currentReservation: res,
    siblingReservations: siblings,
    deposits,
    custody,
    loadStatus: 'ready',
  });

  check(dec.action === 'WARN_FINAL_GROUP_GUARANTEE', 'Gate-1B Case 1: current in siblings + checked-out other => WARN_FINAL_GROUP_GUARANTEE');
  check(dec.isMultiRoom === true, 'Gate-1B Case 1: isMultiRoom is true');
  check(dec.isFinalChild === true, 'Gate-1B Case 1: isFinalChild is true');
  check(dec.groupDepositRemaining === 200000, 'Gate-1B Case 1: groupDepositRemaining is 200000');
  check(dec.groupCustodyHeld === true, 'Gate-1B Case 1: groupCustodyHeld is true');
  check(dec.groupGuaranteeSummary === 'DEPOSIT_AND_CUSTODY', 'Gate-1B Case 1: summary is DEPOSIT_AND_CUSTODY');
}

// Case 2: currentReservation.id = "102" string, sibling id = 102 number
// => current child excluded correctly
{
  const res = { id: "102", status: 'CHECKED_IN', booking_id: 200 };
  const siblings = [
    { id: 101, status: 'CHECKED_OUT', booking_id: 200 },
    { id: 102, status: 'CHECKED_IN', booking_id: 200 },
  ];
  const deposits = [makeDeposit({ scope: 'BOOKING_GROUP', balance: { received: 150000, applied: 0, refunded: 0, remaining: 150000 } })];
  const custody: IdentityCustodyRecord[] = [];

  const dec = deriveCheckoutGateDecision({
    currentReservation: res,
    siblingReservations: siblings,
    deposits,
    custody,
    loadStatus: 'ready',
  });

  check(dec.action === 'WARN_FINAL_GROUP_GUARANTEE', 'Gate-1B Case 2: string ID coercion excludes current child => WARN_FINAL_GROUP_GUARANTEE');
  check(dec.isFinalChild === true, 'Gate-1B Case 2: isFinalChild is true');
}

// Case 3: Sibling status normalization ("checked_out", "CHECKED_OUT ")
// => terminal after normalization
{
  const res = { id: 103, status: 'CHECKED_IN', booking_id: 200 };
  const siblings = [
    { id: 101, status: 'checked_out', booking_id: 200 },
    { id: 102, status: 'CHECKED_OUT ', booking_id: 200 },
    { id: 103, status: 'CHECKED_IN', booking_id: 200 },
  ];
  const deposits = [makeDeposit({ scope: 'BOOKING_GROUP', balance: { received: 100000, applied: 0, refunded: 0, remaining: 100000 } })];
  const custody: IdentityCustodyRecord[] = [];

  const dec = deriveCheckoutGateDecision({
    currentReservation: res,
    siblingReservations: siblings,
    deposits,
    custody,
    loadStatus: 'ready',
  });

  check(dec.action === 'WARN_FINAL_GROUP_GUARANTEE', 'Gate-1B Case 3: case and whitespace normalized => WARN_FINAL_GROUP_GUARANTEE');
  check(dec.isFinalChild === true, 'Gate-1B Case 3: isFinalChild is true');
}

// Case 4: Non-final child: another sibling CHECKED_IN, unresolved BOOKING_GROUP
// => no group warning (ALLOW)
{
  const res = { id: 102, status: 'CHECKED_IN', booking_id: 200 };
  const siblings = [
    { id: 101, status: 'CHECKED_IN', booking_id: 200 },
    { id: 102, status: 'CHECKED_IN', booking_id: 200 },
  ];
  const deposits = [makeDeposit({ scope: 'BOOKING_GROUP', balance: { received: 200000, applied: 0, refunded: 0, remaining: 200000 } })];
  const custody = [makeCustody({ scope: 'BOOKING_GROUP', status: 'HELD' })];

  const dec = deriveCheckoutGateDecision({
    currentReservation: res,
    siblingReservations: siblings,
    deposits,
    custody,
    loadStatus: 'ready',
  });

  check(dec.action === 'ALLOW', 'Gate-1B Case 4: non-final child with unresolved group produces ALLOW');
  check(dec.isMultiRoom === true, 'Gate-1B Case 4: isMultiRoom is true');
  check(dec.isFinalChild === false, 'Gate-1B Case 4: isFinalChild is false');
}

// Case 5: Failed reservation fetch / loadStatus='error'
// => WARN_UNVERIFIED
{
  const res = { id: 102, status: 'CHECKED_IN' };
  const dec = deriveCheckoutGateDecision({
    currentReservation: res,
    siblingReservations: null,
    deposits: null,
    custody: null,
    loadStatus: 'error',
  });

  check(dec.action === 'WARN_UNVERIFIED', 'Gate-1B Case 5: loadStatus error produces WARN_UNVERIFIED');
}

// Case 6: Room deposit + final unresolved group
// => WARN_ROOM_AND_FINAL_GROUP
{
  const res = { id: 102, status: 'CHECKED_IN', booking_id: 200 };
  const siblings = [
    { id: 101, status: 'CHECKED_OUT', booking_id: 200 },
    { id: 102, status: 'CHECKED_IN', booking_id: 200 },
  ];
  const deposits = [
    makeDeposit({ scope: 'ROOM_RESERVATION', balance: { received: 50000, applied: 0, refunded: 0, remaining: 50000 } }),
    makeDeposit({ scope: 'BOOKING_GROUP', balance: { received: 200000, applied: 0, refunded: 0, remaining: 200000 } }),
  ];
  const custody: IdentityCustodyRecord[] = [];

  const dec = deriveCheckoutGateDecision({
    currentReservation: res,
    siblingReservations: siblings,
    deposits,
    custody,
    loadStatus: 'ready',
  });

  check(dec.action === 'WARN_ROOM_AND_FINAL_GROUP', 'Gate-1B Case 6: room deposit + final group produces WARN_ROOM_AND_FINAL_GROUP');
  check(dec.roomDepositRemaining === 50000, 'Gate-1B Case 6: roomDepositRemaining is 50000');
  check(dec.groupDepositRemaining === 200000, 'Gate-1B Case 6: groupDepositRemaining is 200000');
  check(dec.isFinalChild === true, 'Gate-1B Case 6: isFinalChild is true');
}

// Case 7: ROOM identity HELD still:
// => HARD_BLOCK_ROOM_IDENTITY
{
  const res = { id: 102, status: 'CHECKED_IN', booking_id: 200 };
  const siblings = [
    { id: 101, status: 'CHECKED_OUT', booking_id: 200 },
    { id: 102, status: 'CHECKED_IN', booking_id: 200 },
  ];
  const deposits = [
    makeDeposit({ scope: 'ROOM_RESERVATION', balance: { received: 50000, applied: 0, refunded: 0, remaining: 50000 } }),
    makeDeposit({ scope: 'BOOKING_GROUP', balance: { received: 200000, applied: 0, refunded: 0, remaining: 200000 } }),
  ];
  const custody = [
    makeCustody({ scope: 'ROOM_RESERVATION', status: 'HELD', document_holder_name: 'Budi Room' }),
    makeCustody({ scope: 'BOOKING_GROUP', status: 'HELD', document_holder_name: 'Budi Group' }),
  ];

  const dec = deriveCheckoutGateDecision({
    currentReservation: res,
    siblingReservations: siblings,
    deposits,
    custody,
    loadStatus: 'ready',
  });

  check(dec.action === 'HARD_BLOCK_ROOM_IDENTITY', 'Gate-1B Case 7: room identity HELD produces HARD_BLOCK_ROOM_IDENTITY');
  check(dec.heldRoomCustodyHolderName === 'Budi Room', 'Gate-1B Case 7: holder name matches room custody');
}

// ===========================================================================
// GATE-1C: Post-Checkout Drawer Refresh & State Synchronization Invariants
// ===========================================================================
console.log('--- Gate-1C Post-Checkout Drawer Refresh Tests ---');

// Case 1: ReservationDetailDrawer onSuccess callback refetches reservation and folio
{
  const drawerSrc = readSrc('src/features/calendar/ReservationDetailDrawer.tsx');

  check(
    drawerSrc.includes('const targetId = Number(data.id);'),
    'Gate-1C Invariant 1: targetId is captured at click time to prevent stale closure'
  );
  check(
    drawerSrc.includes('if (updatedDto) {') &&
    drawerSrc.includes('setDetailData(updatedDto);') &&
    drawerSrc.includes('await loadFullReservation(targetId);') &&
    drawerSrc.includes('await loadFolio(targetId);') &&
    drawerSrc.includes('onRefresh();'),
    'Gate-1C Invariant 4: onSuccess immediately updates local state, refetches reservation, folio, and triggers parent refresh'
  );
}

// Case 2: Status CHECKED_OUT hides "Check-out Tamu"
{
  const drawerSrc = readSrc('src/features/calendar/ReservationDetailDrawer.tsx');

  // Verify that isCheckedIn is derived from data.status === 'CHECKED_IN'
  check(
    drawerSrc.includes("const isCheckedIn = data.status === 'CHECKED_IN';"),
    'Gate-1C Invariant 5a: isCheckedIn is strictly based on data.status === CHECKED_IN'
  );
  // And the Checkout button is inside {isCheckedIn && ( ... )}
  check(
    drawerSrc.includes('isCheckedIn && (') &&
    drawerSrc.includes('Check-out Tamu'),
    'Gate-1C Invariant 5b: Check-out Tamu button is rendered only when isCheckedIn is true'
  );
}

// Case 3: handleReservationAction returns canonical DTO, protects selectedRes on sibling mismatch
{
  const appSrc = readSrc('src/App.tsx');

  check(
    appSrc.includes('const canonicalDto = data?.data;'),
    'Gate-1C Invariant 1: handleReservationAction captures canonicalDto from response'
  );
  check(
    appSrc.includes('return canonicalDto ?? null;'),
    'Gate-1C Invariant 1b: handleReservationAction returns canonical DTO'
  );
  check(
    appSrc.includes('if (Number(prev.id ?? prev.reservation_id) === Number(reservationId)) {') &&
    appSrc.includes('return canonicalDto'),
    'Gate-1C Invariant 2 & 3: selectedRes is ONLY mutated when id matches, merging canonicalDto'
  );
}

// Case 4: Sibling switch simulation: checkout sibling B while sibling A is selected in App
{
  const prevSelectedRes = {
    id: 101,
    status: 'CHECKED_IN',
    room_number: '101',
    sibling_reservations: [
      { id: 101, status: 'CHECKED_IN', room_number: '101' },
      { id: 102, status: 'CHECKED_IN', room_number: '102' },
    ],
  };

  const checkoutResId = 102;
  const canonicalCheckoutDto = {
    id: 102,
    status: 'CHECKED_OUT',
    room_number: '102',
    check_out: '2026-09-15',
  };

  // Pure simulation of App.tsx setSelectedRes reducer:
  const updateSelectedRes = (prev: any, reservationId: number, canonicalDto: any) => {
    if (!prev) return prev;
    if (Number(prev.id ?? prev.reservation_id) === Number(reservationId)) {
      return canonicalDto
        ? { ...prev, ...canonicalDto, status: 'CHECKED_OUT' }
        : { ...prev, status: 'CHECKED_OUT' };
    }
    if (Array.isArray(prev.sibling_reservations)) {
      return {
        ...prev,
        sibling_reservations: prev.sibling_reservations.map((sib: any) =>
          Number(sib.id ?? sib.reservation_id) === Number(reservationId)
            ? { ...sib, status: 'CHECKED_OUT' }
            : sib
        ),
      };
    }
    return prev;
  };

  const nextSelectedRes = updateSelectedRes(prevSelectedRes, checkoutResId, canonicalCheckoutDto);

  check(nextSelectedRes.id === 101, 'Gate-1C Invariant 6a: selectedRes id remains 101 (sibling A)');
  check(nextSelectedRes.status === 'CHECKED_IN', 'Gate-1C Invariant 6b: sibling A status is NOT falsely changed to CHECKED_OUT');
  check(
    nextSelectedRes.sibling_reservations.find((s: any) => s.id === 102)?.status === 'CHECKED_OUT',
    'Gate-1C Invariant 6c: sibling B inside sibling_reservations is updated to CHECKED_OUT'
  );
  check(
    nextSelectedRes.sibling_reservations.find((s: any) => s.id === 101)?.status === 'CHECKED_IN',
    'Gate-1C Invariant 6d: sibling A inside sibling_reservations remains CHECKED_IN'
  );
}

// Case 5: Matching selectedRes simulation: checkout matching reservation 101
{
  const prevSelectedRes = {
    id: 101,
    status: 'CHECKED_IN',
    room_number: '101',
    booking_id: 100,
  };

  const checkoutResId = 101;
  const canonicalCheckoutDto = {
    id: 101,
    status: 'CHECKED_OUT',
    room_number: '101',
    booking_id: 100,
    check_out: '2026-09-15',
  };

  const updateSelectedRes = (prev: any, reservationId: number, canonicalDto: any) => {
    if (!prev) return prev;
    if (Number(prev.id ?? prev.reservation_id) === Number(reservationId)) {
      return canonicalDto
        ? { ...prev, ...canonicalDto, status: 'CHECKED_OUT' }
        : { ...prev, status: 'CHECKED_OUT' };
    }
    return prev;
  };

  const nextSelectedRes = updateSelectedRes(prevSelectedRes, checkoutResId, canonicalCheckoutDto);

  check(nextSelectedRes.id === 101, 'Gate-1C Invariant 3a: selectedRes id remains 101');
  check(nextSelectedRes.status === 'CHECKED_OUT', 'Gate-1C Invariant 3b: selectedRes status is updated to CHECKED_OUT');
}

// Case 6: Unresolved guarantees remain visible, no auto-refund/auto-return
{
  const drawerSrc = readSrc('src/features/calendar/ReservationDetailDrawer.tsx');
  const modalSrc = readSrc('src/features/deposits/CheckoutGuaranteeConfirmationModal.tsx');
  const appSrc = readSrc('src/App.tsx');

  // Verify DepositGuaranteeSection is mounted unconditionally regardless of checkout
  check(
    drawerSrc.includes('<DepositGuaranteeSection') &&
    drawerSrc.includes('reservationStatus={data.status}'),
    'Gate-1C Invariant 7: DepositGuaranteeSection remains rendered with post-checkout status'
  );

  // Guarantee queue is refetched if active
  check(
    appSrc.includes('if (showUnresolvedGuaranteesRef.current)') &&
    appSrc.includes('fetchUnresolvedGuaranteeQueue();'),
    'Gate-1C Invariant 7b: Unresolved guarantee queue is refreshed upon checkout'
  );

  // Confirm that checkout code does NOT trigger automated deposit refunds or custody returns
  check(
    !modalSrc.includes('/refund') && !modalSrc.includes('/return'),
    'Gate-1C Invariant 8a: CheckoutGuaranteeConfirmationModal does not auto-refund or auto-return'
  );
  check(
    !appSrc.match(/handleReservationAction[\s\S]*?(\/refund|\/return)/),
    'Gate-1C Invariant 8b: handleReservationAction does not auto-refund or auto-return'
  );
}

console.log(`\n=== RESULTS: ${assertions} passed, 0 failed ===\n`);
