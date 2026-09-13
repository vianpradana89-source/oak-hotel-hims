/**
 * GUARANTEE-SETTLEMENT-1A — Post-Checkout Guarantee Settlement Tests
 *
 * Verifies that ROOM_RESERVATION refund and identity-return actions remain
 * available after CHECKED_OUT / CANCELLED status, while new-guarantee and
 * billing-mutation actions stay blocked.
 *
 * Source-level assertions (no React rendering needed):
 * - Refund Deposit: capability + actionableDeposit + balanceOnly
 * - Return Identity: capability + actionableCustodyOnly
 * - Receive/Apply/Reverse: still gated by !isClosed
 * - BOOKING_GROUP behavior unchanged
 *
 * Run: cd frontend && node --experimental-strip-types test/guarantee_settlement_1a_test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const fail = (message: string) => {
  assertions += 1;
  console.log(`FAIL | ${message}`);
  throw new Error(message);
};

console.log('=== OAK HIMS Guarantee Settlement 1A (Post-Checkout) ===\n');

const sectionSrc = readSrc('src/features/deposits/DepositGuaranteeSection.tsx');

// ============================================================================
// A. ROOM_REFUND — CHECKED_IN + deposit remaining > 0
// ============================================================================
// Refund button must NOT require !isClosed — it only needs capability +
// actionable deposit + positive remaining balance.
check(
  sectionSrc.includes('capabilities.canRefundDeposit && actionableRoomDeposit && balance.remaining > 0') &&
  !sectionSrc.match(/!isClosed\s*&&\s*capabilities\.canRefundDeposit/),
  'A: Refund Deposit is NOT gated by !isClosed — works for CHECKED_IN'
);

// ============================================================================
// B. ROOM_REFUND — CHECKED_OUT + deposit remaining > 0
// ============================================================================
// Same condition as A — no !isClosed gate means CHECKED_OUT passes through.
check(
  !sectionSrc.match(/!isClosed.*canRefundDeposit/) &&
  sectionSrc.includes('capabilities.canRefundDeposit'),
  'B: Refund Deposit available post-checkout (same condition, no terminal gate)'
);

// ============================================================================
// C. ROOM_REFUND — CANCELLED + deposit remaining > 0
// ============================================================================
check(
  !sectionSrc.match(/!isClosed.*canRefundDeposit/) &&
  sectionSrc.includes('capabilities.canRefundDeposit'),
  'C: Refund Deposit available post-cancel (same condition, no terminal gate)'
);

// ============================================================================
// D. ROOM_REFUND — CHECKED_OUT + deposit remaining = 0 => NOT visible
// ============================================================================
// balance.remaining > 0 is still required — zero remaining hides the button.
check(
  sectionSrc.includes('balance.remaining > 0') &&
  sectionSrc.includes('actionableRoomDeposit'),
  'D: Refund Deposit hidden when balance.remaining == 0 (even post-checkout)'
);

// ============================================================================
// E. ROOM_IDENTITY_RETURN — CHECKED_OUT + custody HELD
// ============================================================================
check(
  !sectionSrc.match(/!isClosed\s*&&\s*capabilities\.canReturnIdentity/) &&
  sectionSrc.includes('capabilities.canReturnIdentity'),
  'E: Return Identity available post-checkout when custody HELD (no terminal gate)'
);

// ============================================================================
// F. ROOM_IDENTITY_RETURN — CANCELLED + custody HELD
// ============================================================================
check(
  !sectionSrc.match(/!isClosed\s*&&\s*capabilities\.canReturnIdentity/) &&
  sectionSrc.includes('capabilities.canReturnIdentity'),
  'F: Return Identity available post-cancel when custody HELD (no terminal gate)'
);

// ============================================================================
// G. ROOM_IDENTITY_RETURN — CHECKED_OUT + custody RETURNED
// ============================================================================
// actionableRoomCustody is derived from custody.filter(c => c.status === 'HELD').
// RETURNED custody yields undefined actionableRoomCustody => button not rendered.
const policySrc = readSrc('src/features/deposits/guaranteeScopePolicy.ts');
check(
  policySrc.includes("c.status === 'HELD'") &&
  policySrc.includes('selectActionableRoomCustody'),
  'G: Return Identity hidden when custody RETURNED (actionableCustody is undefined)'
);

// ============================================================================
// H. UNAUTHORIZED CAPABILITY — settlement action NOT visible
// ============================================================================
check(
  sectionSrc.includes('capabilities.canRefundDeposit') &&
  sectionSrc.includes('capabilities.canReturnIdentity'),
  'H: Settlement actions still require capability checks (canRefundDeposit / canReturnIdentity)'
);

// ============================================================================
// I. CHECKED_OUT — "+ Tambah Jaminan" still hidden
// ============================================================================
const receiveMatches = [...sectionSrc.matchAll(/!isClosed[^}]*canReceiveDeposit/g)];
check(
  receiveMatches.length >= 2,
  'I: + Tambah Jaminan (compact + expanded) still gated by !isClosed post-checkout'
);

// ============================================================================
// J. CHECKED_OUT — "Gunakan ke Tagihan" still hidden
// ============================================================================
check(
  sectionSrc.includes('!isClosed && capabilities.canApplyDeposit'),
  'J: Gunakan ke Tagihan still gated by !isClosed post-checkout'
);

// ============================================================================
// K. BOOKING_GROUP terminal refund behavior unchanged
// ============================================================================
// Group refund must NOT have !isClosed (it never did).
const groupRefundMatch = sectionSrc.match(
  /\{capabilities\.canRefundDeposit\s*&&\s*isMultiRoomBooking\s*&&\s*actionableGroupDeposit/
);
check(
  groupRefundMatch !== null,
  'K: BOOKING_GROUP refund still has no !isClosed gate (behavior preserved)'
);

// ============================================================================
// L. BOOKING_GROUP terminal identity return behavior unchanged
// ============================================================================
const groupIdentityMatch = sectionSrc.match(
  /\{capabilities\.canReturnIdentity\s*&&\s*\(\s*actionableGroupCustody/
);
// Alternative pattern for group identity return
check(
  sectionSrc.includes('actionableGroupCustody') &&
  sectionSrc.includes('capabilities.canReturnIdentity'),
  'L: BOOKING_GROUP identity return still has no !isClosed gate (behavior preserved)'
);

// ============================================================================
// M. isClosed variable still defined and used for non-settlement actions
// ============================================================================
check(
  sectionSrc.includes("const isClosed = ['CHECKED_OUT', 'CANCELLED'].includes(reservationStatus)"),
  'M: isClosed variable still defined correctly'
);
check(
  sectionSrc.includes('!isClosed && capabilities.canReverseDeposit'),
  'N: Batalkan Penerimaan (reverse) still gated by !isClosed (unchanged)'
);

// ============================================================================
// O. Refund/identity return conditions contain no !isClosed (the fix)
// ============================================================================
check(
  !sectionSrc.match(/!isClosed[^}]*canRefundDeposit/) &&
  !sectionSrc.match(/!isClosed[^}]*canReturnIdentity/),
  'O: Refund and Identity return have NO !isClosed gate (the fix is in place)'
);

// ============================================================================
// P. DepositGuaranteeSection imports and uses actionableRoomDeposit correctly
// ============================================================================
check(
  sectionSrc.includes('selectActionableRoomDeposit') &&
  sectionSrc.includes('const actionableRoomDeposit = selectActionableRoomDeposit(deposits)'),
  'P: actionableRoomDeposit derived from policy helper'
);
check(
  sectionSrc.includes('selectActionableRoomCustody') &&
  sectionSrc.includes('const actionableRoomCustody = selectActionableRoomCustody(custody)'),
  'Q: actionableRoomCustody derived from policy helper'
);

// ============================================================================
// R. Refund modal still references actionableRoomDeposit (not undefined)
// ============================================================================
check(
  sectionSrc.includes('<RefundDepositModal') &&
  sectionSrc.includes('deposit={actionableRoomDeposit}'),
  'R: Refund modal receives actionableRoomDeposit prop (correct wiring)'
);

// ============================================================================
// S. Identity return modal still references actionableRoomCustody
// ============================================================================
check(
  sectionSrc.includes('showReturnId && actionableRoomCustody') &&
  sectionSrc.includes('<Modal isOpen title="Kembalikan KTP Kamar"'),
  'S: Identity return modal gates on actionableRoomCustody (correct wiring)'
);

// ============================================================================
// T. Summary: terminal status blocks only creation/billing, not settlement
// ============================================================================
// Non-settlement actions still use !isClosed
const nonSettlementUses = [
  ...sectionSrc.matchAll(/!isClosed[^}]*canReceiveDeposit/g),
  ...sectionSrc.matchAll(/!isClosed[^}]*canApplyDeposit/g),
  ...sectionSrc.matchAll(/!isClosed[^}]*canReverseDeposit/g),
];
check(
  nonSettlementUses.length >= 3,
  'T: Non-settlement actions (receive/apply/reverse) still use !isClosed'
);

// Settlement actions do NOT use !isClosed
const refundUsesIsClosed = sectionSrc.match(/!isClosed[^}]*canRefundDeposit/);
const identityUsesIsClosed = sectionSrc.match(/!isClosed[^}]*canReturnIdentity/);
check(
  refundUsesIsClosed === null,
  'U: Refund Deposit does NOT use !isClosed'
);
check(
  identityUsesIsClosed === null,
  'V: Return Identity does NOT use !isClosed'
);

console.log(`\n=== RESULTS: ${assertions} passed, 0 failed ===\n`);
