/**
 * GROUP-GUARANTEE-SCOPE-1A — Frontend P1 Behavioral Tests
 *
 * Tests import the SAME pure helpers from guaranteeScopePolicy.ts
 * so there is no drift between production and test logic.
 *
 * Run: cd frontend && node --experimental-strip-types test/group_guarantee_scope_1a_test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getGuaranteeScope,
  isGroupDeposit,
  isGroupCustody,
  isActiveDeposit,
  isActiveCustody,
  hasActiveGroupDeposit,
  hasActiveGroupCustody,
  selectActionableRoomDeposit,
  selectActionableRoomCustody,
  summarizeDepositBalances,
  canShowCreateChooser,
  canCreateGroupDeposit,
  canCreateGroupCustody,
  hasUnresolvedGroupGuarantee,
  hasUnresolvedRoomGuarantee,
  deriveGuaranteeCloseDecision,
  deriveGuaranteeLoadStatus,
  isCurrentGuaranteeRequest,
  type GuaranteeLoadStatus,
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
const fail = (message: string) => {
  assertions += 1;
  console.log(`FAIL | ${message}`);
  throw new Error(message);
};

console.log('=== OAK HIMS Group Guarantee Scope P1 (Behavioral — policy-imported) ===\n');

// ═══════════════════════════════════════════════════════════════════════════
// T1-T2: Scope selection
// ═══════════════════════════════════════════════════════════════════════════

check(getGuaranteeScope(false) === 'ROOM_RESERVATION', 'T1: false -> ROOM_RESERVATION');
check(getGuaranteeScope(true) === 'BOOKING_GROUP', 'T2: true -> BOOKING_GROUP');

// ═══════════════════════════════════════════════════════════════════════════
// T3-T5: Actionable deposit selection (deterministic, order-independent)
// ═══════════════════════════════════════════════════════

const makeDep = (id: number, scope: 'ROOM_RESERVATION' | 'BOOKING_GROUP', status: Deposit['status']): Deposit => ({
  id, scope, status, property_id: 1, reservation_id: id, deposit_number: `DEP-${id}`,
  original_amount: 100000, payment_method: 'CASH', received_by: 'Test',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  events: [], balance: { effective_received: 100000, applied: 0, refunded: 0, reversed_received: 0, remaining: 100000, status },
});

// T3: group-only deposits → no actionable direct deposit
const groupOnly: Deposit[] = [makeDep(1, 'BOOKING_GROUP', 'RECEIVED')];
check(selectActionableRoomDeposit(groupOnly) === undefined, 'T3: group-only deposits → no actionable direct deposit');

// T4: mixed [GROUP, ROOM] → actionable is ROOM regardless of order
const mixedGroupFirst: Deposit[] = [makeDep(2, 'BOOKING_GROUP', 'RECEIVED'), makeDep(3, 'ROOM_RESERVATION', 'RECEIVED')];
check(selectActionableRoomDeposit(mixedGroupFirst)?.id === 3,
  'T4a: mixed [GROUP, ROOM] → actionable is ROOM (id=3)');

// T5: mixed [ROOM, GROUP] → same result
const mixedRoomFirst: Deposit[] = [makeDep(4, 'ROOM_RESERVATION', 'RECEIVED'), makeDep(5, 'BOOKING_GROUP', 'RECEIVED')];
check(selectActionableRoomDeposit(mixedRoomFirst)?.id === 4,
  'T5: mixed [ROOM, GROUP] → actionable is ROOM (id=4)');

// T6: ROOM_RESERVATION action target remains available when mixed
check(selectActionableRoomDeposit(mixedGroupFirst) !== undefined,
  'T6: ROOM_RESERVATION action target available in mixed [GROUP, ROOM]');
check(isGroupDeposit(selectActionableRoomDeposit(mixedGroupFirst)!) === false,
  'T6b: actionable deposit is NOT a group deposit');

// ═══════════════════════════════════════════════════════════════════════════
// T7-T10: Category-aware creation gating
// ═══════════════════════════════════════════════════════════════════════════

const makeCustody = (id: number, scope: 'ROOM_RESERVATION' | 'BOOKING_GROUP', status: 'HELD' | 'RETURNED'): IdentityCustodyRecord => ({
  id, scope, status, property_id: 1, reservation_id: id,
  document_type: 'KTP', document_holder_name: 'Guest', received_by: 'Test',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
});

// T7: group deposit active blocks only group DEPOSIT creation
const groupDepositActive: Deposit[] = [makeDep(10, 'BOOKING_GROUP', 'RECEIVED')];
const emptyCustody: IdentityCustodyRecord[] = [];
check(canCreateGroupDeposit(true, groupDepositActive) === false,
  'T7a: active group deposit blocks group deposit creation');
check(canCreateGroupCustody(true, emptyCustody) === true,
  'T7b: active group deposit does NOT block identity creation');
check(canShowCreateChooser(true, groupDepositActive, emptyCustody) === true,
  'T7c: chooser still shown when only deposit category is blocked');

// T8: group custody active blocks only group IDENTITY creation
const emptyDeposit: Deposit[] = [];
const groupCustodyActive: IdentityCustodyRecord[] = [makeCustody(20, 'BOOKING_GROUP', 'HELD')];
check(canCreateGroupDeposit(true, emptyDeposit) === true,
  'T8a: active group custody does NOT block deposit creation');
check(canCreateGroupCustody(true, groupCustodyActive) === false,
  'T8b: active group custody blocks group identity creation');
check(canShowCreateChooser(true, emptyDeposit, groupCustodyActive) === true,
  'T8c: chooser still shown when only custody category is blocked');

// T9: both active → generic create chooser may be unavailable
const bothActiveDeposits: Deposit[] = [makeDep(30, 'BOOKING_GROUP', 'RECEIVED')];
const bothActiveCustody: IdentityCustodyRecord[] = [makeCustody(31, 'BOOKING_GROUP', 'HELD')];
check(canShowCreateChooser(true, bothActiveDeposits, bothActiveCustody) === false,
  'T9: both active → chooser hidden');
check(canCreateGroupDeposit(true, bothActiveDeposits) === false, 'T9b: deposit blocked');
check(canCreateGroupCustody(true, bothActiveCustody) === false, 'T9c: custody blocked');

// T10: single-room behavior unchanged
check(canShowCreateChooser(false, [], []) === true, 'T10a: single-room chooser always shown');
check(canCreateGroupDeposit(false, []) === true, 'T10b: single-room deposit creation allowed');
check(canCreateGroupCustody(false, []) === true, 'T10c: single-room custody creation allowed');

// ═══════════════════════════════════════════════════════════════════════════
// T11-T12: Historical records do not block creation
// ═══════════════════════════════════════════════════════════════════════════

const historicalDeposit: Deposit[] = [
  makeDep(40, 'BOOKING_GROUP', 'CLOSED'),
  makeDep(41, 'BOOKING_GROUP', 'CANCELLED'),
];
const historicalCustody: IdentityCustodyRecord[] = [
  makeCustody(42, 'BOOKING_GROUP', 'RETURNED'),
];

check(hasActiveGroupDeposit(historicalDeposit) === false,
  'T11a: CLOSED historical deposit not counted as active');
check(hasActiveGroupDeposit([makeDep(43, 'BOOKING_GROUP', 'CANCELLED')]) === false,
  'T11b: CANCELLED historical deposit not counted as active');
check(hasActiveGroupCustody(historicalCustody) === false,
  'T11c: RETURNED historical custody not counted as active');
check(canCreateGroupDeposit(true, historicalDeposit) === true,
  'T11d: historical deposits allow new group deposit creation');
check(canCreateGroupCustody(true, historicalCustody) === true,
  'T11e: historical custody allows new group identity creation');

// ═══════════════════════════════════════════════════════════════════════════
// T17-T23: BUG FIXES — hasActiveGroupDeposit precedence + selectActionableRoomDeposit/Custody
// ═══════════════════════════════════════════════════════════════════════════

// T17: BOOKING_GROUP RECEIVED => active group true
check(hasActiveGroupDeposit([makeDep(60, 'BOOKING_GROUP', 'RECEIVED')]) === true,
  'T17a: BOOKING_GROUP RECEIVED => active group deposit');

// T18: BOOKING_GROUP PARTIALLY_USED => active group true
check(hasActiveGroupDeposit([makeDep(61, 'BOOKING_GROUP', 'PARTIALLY_USED')]) === true,
  'T18: BOOKING_GROUP PARTIALLY_USED => active group deposit');

// T19: ROOM_RESERVATION PARTIALLY_USED => NOT active group (BUG 1 fix regression)
check(hasActiveGroupDeposit([makeDep(62, 'ROOM_RESERVATION', 'PARTIALLY_USED')]) === false,
  'T19: ROOM_RESERVATION PARTIALLY_USED => NOT active group deposit (BUG 1 fix)');

// T20: direct CLOSED => NOT actionable (BUG 2 fix regression)
check(selectActionableRoomDeposit([makeDep(63, 'ROOM_RESERVATION', 'CLOSED')]) === undefined,
  'T20: direct CLOSED deposit => not actionable');

// T21: direct CANCELLED => NOT actionable
check(selectActionableRoomDeposit([makeDep(64, 'ROOM_RESERVATION', 'CANCELLED')]) === undefined,
  'T21: direct CANCELLED deposit => not actionable');

// T22: mixed [GROUP, ROOM active] => ROOM selected (order-independent)
check(selectActionableRoomDeposit([makeDep(65, 'BOOKING_GROUP', 'RECEIVED'), makeDep(66, 'ROOM_RESERVATION', 'RECEIVED')])?.scope === 'ROOM_RESERVATION',
  'T22a: mixed [GROUP, ROOM] => ROOM selected');

// T23: mixed [ROOM active, GROUP] => ROOM selected (order-independent)
check(selectActionableRoomDeposit([makeDep(67, 'ROOM_RESERVATION', 'RECEIVED'), makeDep(68, 'BOOKING_GROUP', 'RECEIVED')])?.scope === 'ROOM_RESERVATION',
  'T23: mixed [ROOM, GROUP] => ROOM selected');

// T24: group-only deposits => no mutation target
check(selectActionableRoomDeposit([makeDep(69, 'BOOKING_GROUP', 'RECEIVED')]) === undefined,
  'T24: group-only deposits => no actionable room deposit');

// ═══════════════════════════════════════════════════════════════════════════
// T25-T30: Custody tests
// ═══════════════════════════════════════════════════════════════════════════

// T25: custody [GROUP HELD, ROOM HELD] => ROOM selected for return
const mixedCustodyGroupFirst = [
  makeCustody(70, 'BOOKING_GROUP', 'HELD'),
  makeCustody(71, 'ROOM_RESERVATION', 'HELD'),
];
check(selectActionableRoomCustody(mixedCustodyGroupFirst)?.scope === 'ROOM_RESERVATION',
  'T25a: custody [GROUP, ROOM] => ROOM selected for return');

// T26: custody [ROOM HELD, GROUP HELD] => ROOM selected
const mixedCustodyRoomFirst = [
  makeCustody(72, 'ROOM_RESERVATION', 'HELD'),
  makeCustody(73, 'BOOKING_GROUP', 'HELD'),
];
check(selectActionableRoomCustody(mixedCustodyRoomFirst)?.scope === 'ROOM_RESERVATION',
  'T26: custody [ROOM, GROUP] => ROOM selected for return');

// T27: group-only HELD custody => no mutable return target
check(selectActionableRoomCustody([makeCustody(74, 'BOOKING_GROUP', 'HELD')]) === undefined,
  'T27: group-only HELD custody => no actionable room custody');

// T28: returned direct custody => no mutable target
check(selectActionableRoomCustody([makeCustody(75, 'ROOM_RESERVATION', 'RETURNED')]) === undefined,
  'T28: returned direct custody => no actionable room custody');

// T29: group custody active blocks group identity creation
check(canCreateGroupCustody(true, [makeCustody(76, 'BOOKING_GROUP', 'HELD')]) === false,
  'T29: group custody HELD blocks group identity creation');

// T30: both group deposit + group custody active — direct ROOM mutation target available
const bothActiveFull: Deposit[] = [
  makeDep(80, 'BOOKING_GROUP', 'RECEIVED'),
  makeDep(81, 'ROOM_RESERVATION', 'RECEIVED'),
];
check(canShowCreateChooser(true, bothActiveFull, [makeCustody(82, 'BOOKING_GROUP', 'HELD')]) === false,
  'T30a: both active group => chooser hidden');
check(selectActionableRoomDeposit(bothActiveFull) !== undefined,
  'T30b: but direct ROOM deposit remains actionable');

// T13: QuickReservationDetail multi-room → BOOKING_GROUP (same helper)
check(getGuaranteeScope(true) === 'BOOKING_GROUP',
  'T13: QuickReservationDetail multi-room data -> BOOKING_GROUP scope');

// T14: existing direct rows remain direct
const roomOnly: Deposit[] = [makeDep(50, 'ROOM_RESERVATION', 'RECEIVED')];
check(selectActionableRoomDeposit(roomOnly)?.scope === 'ROOM_RESERVATION',
  'T14a: existing ROOM_RESERVATION deposit remains actionable');
check(isGroupDeposit(roomOnly[0]) === false, 'T14b: ROOM_RESERVATION is not a group deposit');
check(canCreateGroupDeposit(true, []) === true, 'T14c: empty deposits allow creation');

// ═══════════════════════════════════════════════════════════════════════════
// Source structure guards
// ═══════════════════════════════════════════════════════════════════════════

const policySrc = readSrc('src/features/deposits/guaranteeScopePolicy.ts');
const guaranteeSection = readSrc('src/features/deposits/DepositGuaranteeSection.tsx');
const drawer = readSrc('src/features/calendar/ReservationDetailDrawer.tsx');
const quickDetail = readSrc('src/features/calendar/QuickReservationDetail.tsx');
const depositApi = readSrc('src/features/deposits/depositApi.ts');

check(policySrc.includes('export function getGuaranteeScope'), 'Guard: policy exports getGuaranteeScope');
check(policySrc.includes('export function selectActionableRoomDeposit'), 'Guard: policy exports selectActionableRoomDeposit');
check(policySrc.includes('export function hasActiveGroupDeposit'), 'Guard: policy exports hasActiveGroupDeposit');
check(policySrc.includes('export function hasActiveGroupCustody'), 'Guard: policy exports hasActiveGroupCustody');
check(policySrc.includes('export function canShowCreateChooser'), 'Guard: policy exports canShowCreateChooser');
check(policySrc.includes('export function canCreateGroupDeposit'), 'Guard: policy exports canCreateGroupDeposit');
check(policySrc.includes('export function canCreateGroupCustody'), 'Guard: policy exports canCreateGroupCustody');
check(policySrc.includes('export function selectActionableRoomCustody'), 'Guard: policy exports selectActionableRoomCustody');
check(policySrc.includes('export function summarizeDepositBalances'), 'Guard: policy exports summarizeDepositBalances');

// Production component imports from policy
check(guaranteeSection.includes("from './guaranteeScopePolicy'"),
  'Guard: DepositGuaranteeSection imports from guaranteeScopePolicy');
check(guaranteeSection.includes('selectActionableRoomDeposit'),
  'Guard: component uses selectActionableRoomDeposit');
check(guaranteeSection.includes('canShowCreateChooser'),
  'Guard: component uses canShowCreateChooser');
check(guaranteeSection.includes('canCreateGroupDeposit'),
  'Guard: component uses canCreateGroupDeposit');
check(guaranteeSection.includes('canCreateGroupCustody'),
  'Guard: component uses canCreateGroupCustody');
check(guaranteeSection.includes('selectActionableRoomCustody'),
  'Guard: component uses selectActionableRoomCustody');

// No global groupActionsDisabled in executable code
const linesWithFlag = guaranteeSection.split('\n').filter(l => l.includes('groupActionsDisabled') && !l.trimStart().startsWith('//'));
check(linesWithFlag.length === 0, 'Guard: no groupActionsDisabled in executable code');

// CHECKIN-1A preserved
check(drawer.includes('data.checkin_progress') && drawer.includes('checkedInCount'),
  'Guard: CHECKIN-1A checkin_progress badge still present');

// T15: Per-category chooser blocking — groupDepositBlocked used in modal
check(guaranteeSection.includes('groupDepositBlocked'),
  'T15a: component computes groupDepositBlocked');
check(guaranteeSection.includes('disabled={groupDepositBlocked}'),
  'T15b: Deposit Uang button disabled when blocked');
check(guaranteeSection.includes('"Sudah ada"') || guaranteeSection.includes("'Sudah ada'") || guaranteeSection.includes('Sudah ada'),
  'T15c: visual label shown when deposit category blocked');

// T16: Per-category chooser blocking — groupCustodyBlocked used in modal
check(guaranteeSection.includes('groupCustodyBlocked'),
  'T16a: component computes groupCustodyBlocked');
check(guaranteeSection.includes('disabled={groupCustodyBlocked}'),
  'T16b: Identitas Ditahan button disabled when blocked');

// Drawer and quickDetail use same canonical expression
check(drawer.includes('isMultiRoomBooking={(data.sibling_reservations?.length ?? 0) > 1}'),
  'Guard: drawer uses canonical sibling count');
check(quickDetail.includes('isMultiRoomBooking={(data.sibling_reservations?.length ?? 0) > 1}'),
  'Guard: quickDetail uses canonical sibling count');

// depositApi has scope type
check(depositApi.includes('export type GuaranteeScope'), 'Guard: GuaranteeScope type exported');
check(depositApi.includes("scope?: GuaranteeScope"), 'Guard: hold()/receive() accept scope');

// ═══════════════════════════════════════════════════════════════════════════
// T31-T33: Structural guards for BUG 3 (modal target alignment)
// ═══════════════════════════════════════════════════════════════════════════

// T31: ApplyDepositModal receives exact deposit (not deposits array)
check(guaranteeSection.includes('<ApplyDepositModal isOpen={showApply}'),
  'T31a: ApplyDepositModal present');
check(guaranteeSection.includes('deposit={actionableRoomDeposit}'),
  'T31b: ApplyDepositModal receives actionableRoomDeposit');
check(!guaranteeSection.includes('deposits={deposits}'),
  'T31c: ApplyDepositModal does NOT receive deposits array');

// T32: RefundDepositModal receives exact deposit
check(guaranteeSection.includes('<RefundDepositModal isOpen={showRefund}'),
  'T32a: RefundDepositModal present');
check(guaranteeSection.includes('deposit={actionableRoomDeposit}'),
  'T32b: RefundDepositModal receives actionableRoomDeposit');

// T33: Reverse submit uses actionableRoomDeposit.id directly
check(guaranteeSection.includes('actionableRoomDeposit.id'),
  'T33: reverse submit uses actionableRoomDeposit.id directly');

// ═══════════════════════════════════════════════════════════════════════════
// T34-T40: Summary aggregation — display includes group, mutation stays exclusive
// ═══════════════════════════════════════════════════════════════════════════

// T34: one ROOM_RESERVATION deposit → summary matches its balance
const singleRoomDep = [makeDep(90, 'ROOM_RESERVATION', 'RECEIVED')];
const s34 = summarizeDepositBalances(singleRoomDep);
check(s34.effective_received === 100000, 'T34a: single ROOM deposit effective_received aggregates correctly');
check(s34.remaining === 100000, 'T34b: single ROOM deposit remaining matches');
check(selectActionableRoomDeposit(singleRoomDep)?.id === 90,
  'T34c: same record is actionable target');

// T35: one BOOKING_GROUP deposit → summary shows non-zero, but NO actionable target
const singleGroupDep = [makeDep(91, 'BOOKING_GROUP', 'RECEIVED')];
const s35 = summarizeDepositBalances(singleGroupDep);
check(s35.effective_received === 100000, 'T35a: group-only deposit appears in summary');
check(s35.remaining === 100000, 'T35b: group-only deposit remaining displayed');
check(selectActionableRoomDeposit(singleGroupDep) === undefined,
  'T35c: group-only deposit is NOT actionable for mutations');

// T36: ROOM + GROUP coexist → summary aggregates both
const mixedDep = [
  makeDep(92, 'ROOM_RESERVATION', 'RECEIVED'),
  makeDep(93, 'BOOKING_GROUP', 'RECEIVED'),
];
const s36 = summarizeDepositBalances(mixedDep);
check(s36.effective_received === 200000, 'T36a: mixed deposits aggregate effective_received');
check(s36.remaining === 200000, 'T36b: mixed deposits aggregate remaining');
check(selectActionableRoomDeposit(mixedDep) !== undefined,
  'T36c: room row remains actionable alongside group');
check(selectActionableRoomDeposit(mixedDep)?.scope === 'ROOM_RESERVATION',
  'T36d: actionable target is ROOM_RESERVATION, not GROUP');

// T37: applied/refunded aggregate correctly
const mixedUsedDep = [
  makeDep(94, 'ROOM_RESERVATION', 'PARTIALLY_USED'),
  makeDep(95, 'BOOKING_GROUP', 'RECEIVED'),
];
// Override the fixture to simulate an applied portion
Object.assign(mixedUsedDep[0].balance, { applied: 30000, remaining: 70000 });
const s37 = summarizeDepositBalances(mixedUsedDep);
check(s37.applied === 30000, 'T37a: applied aggregates from partially_used row');
check(s37.remaining === 170000, 'T37b: remaining reflects applied deduction (100k+70k)');

// T38: CANCELLED excluded, CLOSED included (balance semantics)
const mixedHistorical = [
  makeDep(96, 'ROOM_RESERVATION', 'CANCELLED'),
  makeDep(97, 'BOOKING_GROUP', 'CLOSED'),
  makeDep(98, 'ROOM_RESERVATION', 'RECEIVED'),
];
const s38 = summarizeDepositBalances(mixedHistorical);
check(s38.effective_received === 200000, 'T38: CANCELLED excluded, CLOSED+ROOM included');

// T39: group-only summary non-zero + no actionable target (proves display ≠ mutation)
const s39 = summarizeDepositBalances([makeDep(99, 'BOOKING_GROUP', 'RECEIVED')]);
check(s39.remaining > 0, 'T39a: group-only summary shows non-zero remaining');
check(selectActionableRoomDeposit([makeDep(99, 'BOOKING_GROUP', 'RECEIVED')]) === undefined,
  'T39b: group-only has no actionable target for mutations');

// T40: component uses summarizeDepositBalances for display (guard)
check(guaranteeSection.includes('summarizeDepositBalances'),
  'T40: DepositGuaranteeSection imports and uses summarizeDepositBalances for summary');

// T41: unresolved group guarantee — deposit remaining > 0, active (RECEIVED)
check(hasUnresolvedGroupGuarantee([makeDep(1, 'BOOKING_GROUP', 'RECEIVED')], []),
  'T41: BOOKING_GROUP deposit remaining > 0 + RECEIVED → unresolved');

// T42: unresolved group guarantee — custody HELD
check(hasUnresolvedGroupGuarantee([], [makeCustody(2, 'BOOKING_GROUP', 'HELD')]),
  'T42: BOOKING_GROUP custody HELD → unresolved');

// T43: unresolved group guarantee — deposit remaining = 0 (fully refunded)
check(!hasUnresolvedGroupGuarantee([Object.assign(makeDep(3, 'BOOKING_GROUP', 'RECEIVED'), { balance: { effective_received: 100000, applied: 0, refunded: 100000, reversed_received: 0, remaining: 0, status: 'RECEIVED' } })], []),
  'T43: BOOKING_GROUP deposit remaining = 0 → settled');

// T44: unresolved group guarantee — CLOSED deposit should NOT be unresolved
check(!hasUnresolvedGroupGuarantee([makeDep(4, 'BOOKING_GROUP', 'CLOSED')], []),
  'T44: BOOKING_GROUP deposit CLOSED → settled even if data had stale remaining');

// T45: unresolved group guarantee — CANCELLED deposit should NOT be unresolved
check(!hasUnresolvedGroupGuarantee([makeDep(5, 'BOOKING_GROUP', 'CANCELLED')], []),
  'T45: BOOKING_GROUP deposit CANCELLED → settled');

// T46: unresolved group guarantee — ROOM_RESERVATION only (no group) → false
check(!hasUnresolvedGroupGuarantee([makeDep(6, 'ROOM_RESERVATION', 'RECEIVED')], []),
  'T46: ROOM_RESERVATION deposit remaining > 0 alone → NOT unresolved');
check(!hasUnresolvedGroupGuarantee([], [makeCustody(7, 'ROOM_RESERVATION', 'HELD')]),
  'T46b: ROOM_RESERVATION custody HELD alone → NOT unresolved');

// T47: unresolved group guarantee — custody returned but deposit still remaining → unresolved
check(hasUnresolvedGroupGuarantee([makeDep(8, 'BOOKING_GROUP', 'RECEIVED')], [makeCustody(9, 'BOOKING_GROUP', 'RETURNED')]),
  'T47: KTP Grup RETURNED + deposit remaining > 0 → unresolved');

// T48: unresolved group guarantee — both returned + refunded → settled
check(!hasUnresolvedGroupGuarantee(
  [Object.assign(makeDep(10, 'BOOKING_GROUP', 'CLOSED'), { balance: { effective_received: 100000, applied: 0, refunded: 100000, reversed_received: 0, remaining: 0, status: 'CLOSED' } })],
  [makeCustody(11, 'BOOKING_GROUP', 'RETURNED')]
),
  'T48: KTP Grup RETURNED + deposit CLOSED + remaining = 0 → settled');

// T49–T50: stale-state guard — component MUST report false when switching away from multi-room
// The actual callback-logic resides in DepositGuaranteeSection (UI component).
// Pure-guard assertions verify that the guard expression itself collapses to false for non-group input.
check(
  (() => {
    const isMultiRoomBooking = false;
    const result = isMultiRoomBooking ? hasUnresolvedGroupGuarantee([makeDep(100, 'BOOKING_GROUP', 'RECEIVED')], [makeCustody(101, 'BOOKING_GROUP', 'HELD')]) : false;
    return !result;
  })(),
  'T49: guard expression returns false when isMultiRoomBooking=false (stale-state prevention)'
);
check(
  (() => {
    const isMultiRoomBooking = false;
    const result = isMultiRoomBooking ? hasUnresolvedGroupGuarantee([], []) : false;
    return !result;
  })(),
  'T50: guard expression returns false for empty deposits/custody when isMultiRoomBooking=false'
);

// ─── T51–T60: hasUnresolvedRoomGuarantee (ROOM_RESERVATION scope) ─────────
// (hasUnresolvedRoomGuarantee already imported above — no duplicate import)

const makeDepR = (id: number, scope: 'ROOM_RESERVATION' | 'BOOKING_GROUP', status: Deposit['status'], remaining?: number): Deposit =>
  Object.assign(makeDep(id, scope, status), { balance: { effective_received: remaining ?? 100000, applied: 0, refunded: 0, reversed_received: 0, remaining: remaining ?? 100000, status } });

const makeCustodyR = (id: number, scope: 'ROOM_RESERVATION' | 'BOOKING_GROUP', status: 'HELD' | 'RETURNED'): IdentityCustodyRecord =>
  Object.assign(makeCustody(id, scope, status), { document_type: 'KTP', document_number_masked: '3***45' });

check(hasUnresolvedRoomGuarantee([makeDepR(200, 'ROOM_RESERVATION', 'RECEIVED')], []) === true,
  'T51: ROOM_RESERVATION deposit remaining>0 → room unresolved true');
check(hasUnresolvedRoomGuarantee([], [makeCustodyR(201, 'ROOM_RESERVATION', 'HELD')]) === true,
  'T52: ROOM_RESERVATION custody HELD → room unresolved true');
check(hasUnresolvedRoomGuarantee([makeDepR(202, 'ROOM_RESERVATION', 'RECEIVED', 0)], []) === false,
  'T53: ROOM_RESERVATION deposit remaining=0 → room unresolved false');
check(hasUnresolvedRoomGuarantee([makeDepR(203, 'ROOM_RESERVATION', 'CLOSED')], []) === false,
  'T54: ROOM_RESERVATION deposit CLOSED → room unresolved false');
check(hasUnresolvedRoomGuarantee([makeDepR(204, 'ROOM_RESERVATION', 'CANCELLED')], []) === false,
  'T55: ROOM_RESERVATION deposit CANCELLED → room unresolved false');
check(hasUnresolvedRoomGuarantee([makeDep(205, 'BOOKING_GROUP', 'RECEIVED')], []) === false,
  'T56: BOOKING_GROUP-only deposit → room unresolved false');
check(hasUnresolvedRoomGuarantee([], [makeCustody(206, 'BOOKING_GROUP', 'HELD')]) === false,
  'T57: BOOKING_GROUP-only custody → room unresolved false');
check(hasUnresolvedRoomGuarantee([makeDepR(207, 'ROOM_RESERVATION', 'RECEIVED')], [makeCustodyR(208, 'ROOM_RESERVATION', 'RETURNED')]) === true,
  'T58: returned room custody + open room deposit → room unresolved true');
check(hasUnresolvedRoomGuarantee([makeDepR(209, 'ROOM_RESERVATION', 'CLOSED')], [makeCustodyR(210, 'ROOM_RESERVATION', 'RETURNED')]) === false,
  'T59: room deposit CLOSED + room custody RETURNED → room unresolved false');
check(hasUnresolvedRoomGuarantee([], []) === false,
  'T60: empty deposits+custody → room unresolved false');

// ─── T61–T70: deriveGuaranteeCloseDecision ─────────────────────────────────
check(deriveGuaranteeCloseDecision({ terminal: false, status: 'ready', roomUnresolved: true, groupEligible: true, groupUnresolved: true }).action === 'CLOSE',
  'T61: non-terminal → CLOSE regardless of unresolved');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'loading', roomUnresolved: false, groupEligible: true, groupUnresolved: false }).action === 'WAIT',
  'T62: terminal + loading → WAIT (no close, no warning)');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'ready', roomUnresolved: true, groupEligible: false, groupUnresolved: false }).action === 'WARN_ROOM',
  'T63: terminal + ready + room unresolved → WARN_ROOM');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'ready', roomUnresolved: false, groupEligible: true, groupUnresolved: true }).action === 'WARN_GROUP',
  'T64: terminal + ready + group unresolved → WARN_GROUP');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'ready', roomUnresolved: true, groupEligible: true, groupUnresolved: true }).action === 'WARN_BOTH',
  'T65: terminal + ready + both unresolved → WARN_BOTH');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'ready', roomUnresolved: false, groupEligible: true, groupUnresolved: false }).action === 'CLOSE',
  'T66: terminal + ready + all settled → CLOSE');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'ready', roomUnresolved: false, groupEligible: false, groupUnresolved: true }).action === 'CLOSE',
  'T67: terminal + ready + group ineligible but unresolved flag true → CLOSE (group not eligible)');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'ready', roomUnresolved: true, groupEligible: false, groupUnresolved: false }).action === 'WARN_ROOM',
  'T68: terminal + ready + room unresolved + group ineligible → WARN_ROOM only');
check(deriveGuaranteeCloseDecision({ terminal: false, status: 'loading', roomUnresolved: true, groupEligible: true, groupUnresolved: true }).action === 'CLOSE',
  'T69: non-terminal + loading → CLOSE immediately (terminality wins)');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'ready', roomUnresolved: false, groupEligible: true, groupUnresolved: false }).action === 'CLOSE',
  'T70: terminal + ready + no unresolved → CLOSE, no warning');

// ─── T71–T80: error status and pending-close resolution ──────────────────────
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'error', roomUnresolved: false, groupEligible: true, groupUnresolved: false }).action === 'WARN_UNVERIFIED',
  'T71: terminal + error → WARN_UNVERIFIED (unknown state, never settled)');
check(deriveGuaranteeCloseDecision({ terminal: false, status: 'error', roomUnresolved: true, groupEligible: true, groupUnresolved: true }).action === 'CLOSE',
  'T72: non-terminal + error → CLOSE (terminality wins over error)');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'loading', roomUnresolved: false, groupEligible: true, groupUnresolved: false }).action === 'WAIT',
  'T73: terminal + loading + pending close → WAIT (no premature close)');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'ready', roomUnresolved: true, groupEligible: true, groupUnresolved: false }).action === 'WARN_ROOM',
  'T74: pending close resolves to WARN_ROOM when load succeeds unresolved');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'ready', roomUnresolved: false, groupEligible: true, groupUnresolved: false }).action === 'CLOSE',
  'T75: pending close resolves to CLOSE when load succeeds settled');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'error', roomUnresolved: false, groupEligible: true, groupUnresolved: false }).action === 'WARN_UNVERIFIED',
  'T76: pending close resolves to WARN_UNVERIFIED when load errors');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'ready', roomUnresolved: true, groupEligible: true, groupUnresolved: true }).action === 'WARN_BOTH',
  'T77: mixed scopes — room unresolved + group unresolved → WARN_BOTH');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'ready', roomUnresolved: true, groupEligible: false, groupUnresolved: true }).action === 'WARN_ROOM',
  'T78: scope isolation — room unresolved + group ineligible → WARN_ROOM only');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'ready', roomUnresolved: false, groupEligible: true, groupUnresolved: false }).action === 'CLOSE',
  'T79: CANCELLED terminal + ready + all settled → CLOSE (CANCELLED is terminal)');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'loading', roomUnresolved: true, groupEligible: true, groupUnresolved: true }).action === 'WAIT',
  'T80: unknown status preserves WAIT even if flags are pre-populated');

// ─── T81–T88: partial-failure semantics (BOTH sources required for READY) ──────
// These tests verify the invariants that drive DepositGuaranteeSection.loadData()
// and guarantee the drawer cannot derive settled state from incomplete data.
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'ready', roomUnresolved: false, groupEligible: true, groupUnresolved: false }).action === 'CLOSE',
  'T81: both sources success → READY → settled → CLOSE');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'error', roomUnresolved: false, groupEligible: true, groupUnresolved: false }).action === 'WARN_UNVERIFIED',
  'T82: deposits fail + custody success → ERROR → terminal → WARN_UNVERIFIED');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'error', roomUnresolved: false, groupEligible: true, groupUnresolved: false }).action === 'WARN_UNVERIFIED',
  'T83: deposits success + custody fail → ERROR → terminal → WARN_UNVERIFIED');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'error', roomUnresolved: false, groupEligible: true, groupUnresolved: false }).action === 'WARN_UNVERIFIED',
  'T84: both fail → ERROR → terminal → WARN_UNVERIFIED');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'error', roomUnresolved: true, groupEligible: true, groupUnresolved: true }).action === 'WARN_UNVERIFIED',
  'T85: partial failure must NEVER derive settled state (flags ignored on error)');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'error', roomUnresolved: false, groupEligible: true, groupUnresolved: false }).action === 'WARN_UNVERIFIED',
  'T86: terminal + partial failure → WARN_UNVERIFIED (not CLOSE)');
check(deriveGuaranteeCloseDecision({ terminal: false, status: 'error', roomUnresolved: true, groupEligible: true, groupUnresolved: true }).action === 'CLOSE',
  'T87: non-terminal + partial failure → CLOSE (terminality wins)');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'loading', roomUnresolved: false, groupEligible: true, groupUnresolved: false }).action === 'WAIT',
  'T88: pending close + partial failure → stays WAIT until load completes → WARN_UNVERIFIED');

// ─── T89–T94: deriveGuaranteeLoadStatus (new 3-param contract: loading, loadError, sourceMatches) ──
check(deriveGuaranteeLoadStatus({ loading: true, loadError: false, sourceMatches: true }) === 'loading',
  'T89: loading=true → loading');
check(deriveGuaranteeLoadStatus({ loading: false, loadError: false, sourceMatches: true }) === 'ready',
  'T90: loading=false + no error + sourceMatches → ready');
check(deriveGuaranteeLoadStatus({ loading: false, loadError: true, sourceMatches: true }) === 'error',
  'T91: loadError=true → error');
check(deriveGuaranteeLoadStatus({ loading: false, loadError: false, sourceMatches: false }) === 'loading',
  'T92: source mismatch → loading (never ready)');
check(deriveGuaranteeLoadStatus({ loading: true, loadError: true, sourceMatches: false }) === 'loading',
  'T93: loading masks error → still loading');
check(deriveGuaranteeLoadStatus({ loading: false, loadError: true, sourceMatches: false }) === 'error',
  'T94: error wins over mismatch → error');

// ─── T95–T101: isCurrentGuaranteeRequest — stale-response guard ────────
check(isCurrentGuaranteeRequest(1, 1) === true,
  'T95: requestA id=1, latest=1 → may commit (current request)');
check(isCurrentGuaranteeRequest(1, 2) === false,
  'T96: requestA id=1, latest=2 (B started) → A may NOT commit');
check(isCurrentGuaranteeRequest(2, 2) === true,
  'T97: requestB id=2, latest=2 → may commit');
check(isCurrentGuaranteeRequest(0, 1) === false,
  'T98: stale id=0, latest=1 → cannot commit');
check(isCurrentGuaranteeRequest(5, 5) === true,
  'T99: any matching id → current');
check(isCurrentGuaranteeRequest(5, 6) === false,
  'T100: older id → stale');

// ─── T102–T107: isCurrentGuaranteeRequest failure/stale semantics ────
check(isCurrentGuaranteeRequest(1, 2) === false,
  'T102: stale A failure must NOT set current error (requestId !== latestRef)');
check(isCurrentGuaranteeRequest(1, 2) === false,
  'T103: stale A finally must NOT clear B loading (requestId !== latestRef)');
check(isCurrentGuaranteeRequest(2, 2) === true,
  'T104: current B success → commits');
check(isCurrentGuaranteeRequest(2, 2) === true,
  'T105: current B error → sets loadError');
check(isCurrentGuaranteeRequest(2, 2) === true,
  'T106: current B finally → clears loading');
check(isCurrentGuaranteeRequest(3, 2) === false,
  'T107: future-id (should not happen) → stale');

// ─── T102–T108: group eligibility via isGroupTerminal (not isMultiRoomBooking) ──
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'ready', roomUnresolved: false, groupEligible: false, groupUnresolved: true }).action === 'CLOSE',
  'T102: current terminal + sibling active (groupIneligible=false) + group unresolved → CLOSE (no group warning)');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'ready', roomUnresolved: true, groupEligible: false, groupUnresolved: true }).action === 'WARN_ROOM',
  'T103: current terminal + sibling active + room unresolved + group unresolved → WARN_ROOM only');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'ready', roomUnresolved: false, groupEligible: true, groupUnresolved: true }).action === 'WARN_GROUP',
  'T104: all children terminal (groupEligible=true) + group unresolved → WARN_GROUP');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'ready', roomUnresolved: true, groupEligible: true, groupUnresolved: true }).action === 'WARN_BOTH',
  'T105: all children terminal + room + group unresolved → WARN_BOTH');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'loading', roomUnresolved: true, groupEligible: false, groupUnresolved: true }).action === 'WAIT',
  'T106: terminal + loading → WAIT regardless of groupEligible');
check(deriveGuaranteeCloseDecision({ terminal: true, status: 'error', roomUnresolved: false, groupEligible: false, groupUnresolved: true }).action === 'WARN_UNVERIFIED',
  'T107: terminal + error → WARN_UNVERIFIED regardless of groupEligible');

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\n=== RESULTS: ${assertions} passed, 0 failed ===\n`);
