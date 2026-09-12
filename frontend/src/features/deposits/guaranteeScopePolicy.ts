/**
 * guaranteeScopePolicy.ts — pure decision helpers for GROUP-GUARANTEE-SCOPE-1A
 *
 * All logic lives here so production code and tests share the same implementation.
 */

import type { Deposit, IdentityCustodyRecord, GuaranteeScope, DepositBalance } from './depositApi';

export type { GuaranteeScope };

/** Scope assigned to a new guarantee based on booking context. */
export function getGuaranteeScope(isMultiRoomBooking: boolean): GuaranteeScope {
  return isMultiRoomBooking ? 'BOOKING_GROUP' : 'ROOM_RESERVATION';
}

/** Whether a deposit record is a BOOKING_GROUP (read-only in 1A). */
export function isGroupDeposit(d: Deposit): boolean {
  return d.scope === 'BOOKING_GROUP';
}

/** Whether a custody record is a BOOKING_GROUP (read-only in 1A). */
export function isGroupCustody(c: IdentityCustodyRecord): boolean {
  return c.scope === 'BOOKING_GROUP';
}

/**
 * True when a deposit record is active (eligible for display / action consideration).
 * Excludes CANCELLED and CLOSED states.
 */
export function isActiveDeposit(d: Deposit): boolean {
  return d.status !== 'CANCELLED' && d.status !== 'CLOSED';
}

/** True when a custody record is actively held. */
export function isActiveCustody(c: IdentityCustodyRecord): boolean {
  return c.status === 'HELD';
}

/**
 * True if any active BOOKING_GROUP deposit exists (blocks new group deposit creation).
 * Historical CLOSED/CANCELLED/RETURNED records do NOT count.
 */
export function hasActiveGroupDeposit(deposits: Deposit[]): boolean {
  return deposits.some(
    d => isGroupDeposit(d) && (d.status === 'RECEIVED' || d.status === 'PARTIALLY_USED')
  );
}

/**
 * True if any HELD BOOKING_GROUP custody exists (blocks new group custody creation).
 */
export function hasActiveGroupCustody(custody: IdentityCustodyRecord[]): boolean {
  return custody.some(c => isGroupCustody(c) && c.status === 'HELD');
}

/**
 * Select the deterministic actionable ROOM_RESERVATION deposit for apply/refund/reverse.
 *
 * Rules:
 * - Exclude BOOKING_GROUP deposits (read-only in 1A)
 * - Exclude non-active deposits (CANCELLED and CLOSED are inactive)
 * - Pick the first non-group, active deposit (deterministic, order-independent of group presence)
 * - Returns undefined if only group deposits exist or no active deposits at all
 */
export function selectActionableRoomDeposit(deposits: Deposit[]): Deposit | undefined {
  return deposits.find(d => !isGroupDeposit(d) && isActiveDeposit(d));
}

/**
 * Select the deterministic actionable ROOM_RESERVATION custody for return.
 *
 * Rules:
 * - Exclude BOOKING_GROUP custody records (read-only in 1A)
 * - Only HELD status is actionable for return
 * - Returns undefined if only group custody exists or no active custody
 */
export function selectActionableRoomCustody(custody: IdentityCustodyRecord[]): IdentityCustodyRecord | undefined {
  return custody.find(c => !isGroupCustody(c) && isActiveCustody(c));
}

/**
 * Select the deterministic actionable BOOKING_GROUP deposit for apply/refund/reverse.
 *
 * Rules:
 * - Must be scope === 'BOOKING_GROUP'
 * - Must be active (RECEIVED or PARTIALLY_USED)
 * - Returns undefined if no active group deposit exists
 * - Distinct from ROOM_RESERVATION selector — never returns a room deposit
 */
export function selectActionableGroupDeposit(deposits: Deposit[]): Deposit | undefined {
  return deposits.find(d => isGroupDeposit(d) && isActiveDeposit(d));
}

/**
 * Select the deterministic actionable BOOKING_GROUP custody for return.
 *
 * Rules:
 * - Must be scope === 'BOOKING_GROUP'
 * - Only HELD status is actionable for return
 * - Returns undefined if no held group custody exists
 * - Distinct from ROOM_RESERVATION selector — never returns a room custody
 */
export function selectActionableGroupCustody(custody: IdentityCustodyRecord[]): IdentityCustodyRecord | undefined {
  return custody.find(c => isGroupCustody(c) && isActiveCustody(c));
}

/**
 * Whether the generic "+ Tambah Jaminan" chooser should be visible.
 *
 * - Single-room: always allowed (subject to canReceiveDeposit capability)
 * - Multi-room: allowed only when at least one category remains creatable
 *   (i.e., not both a active group deposit AND an active group custody exist)
 */
export function canShowCreateChooser(
  isMultiRoomBooking: boolean,
  deposits: Deposit[],
  custody: IdentityCustodyRecord[]
): boolean {
  if (!isMultiRoomBooking) return true;
  const groupDepositActive = hasActiveGroupDeposit(deposits);
  const groupCustodyActive = hasActiveGroupCustody(custody);
  // Hide only when BOTH categories are already occupied
  return !(groupDepositActive && groupCustodyActive);
}

/**
 * Whether a new group deposit can be created.
 * Single-room: always true (scope will be ROOM_RESERVATION).
 * Multi-room: true only when no active BOOKING_GROUP deposit exists.
 */
export function canCreateGroupDeposit(
  isMultiRoomBooking: boolean,
  deposits: Deposit[]
): boolean {
  if (!isMultiRoomBooking) return true;
  return !hasActiveGroupDeposit(deposits);
}

/**
 * Whether a new group custody can be created.
 * Single-room: always true (scope will be ROOM_RESERVATION).
 * Multi-room: true only when no HELD BOOKING_GROUP custody exists.
 */
export function canCreateGroupCustody(
  isMultiRoomBooking: boolean,
  custody: IdentityCustodyRecord[]
): boolean {
  if (!isMultiRoomBooking) return true;
  return !hasActiveGroupCustody(custody);
}

/**
 * Whether a group (BOOKING_GROUP) guarantee is still unresolved — i.e. the
 * operator has not yet completed settlement of KTP Grup / Deposit Grup.
 *
 * Returned true when ANY of:
 *   - HELD BOOKING_GROUP identity custody exists, OR
 *   - active (non-CLOSED/CANCELLED) BOOKING_GROUP deposit has remaining > 0
 *
 * False when both groups are settled (ALL group custody RETURNED + no
 * outstanding group deposit balance).
 */
export function hasUnresolvedGroupGuarantee(
  deposits: Deposit[],
  custody: IdentityCustodyRecord[]
): boolean {
  const heldGroupCustody = custody.some(c => isGroupCustody(c) && c.status === 'HELD');
  const openGroupDeposit = deposits.some(
    d => isGroupDeposit(d) && isActiveDeposit(d) && (d.balance?.remaining ?? 0) > 0
  );
  return heldGroupCustody || openGroupDeposit;
}

/**
 * Aggregate deposit balances across ALL non-CANCELLED deposits for DISPLAY summary.
 *
 * Includes both BOOKING_GROUP and ROOM_RESERVATION rows — a group deposit is
 * read-only for lifecycle mutations but still represents real money that must
 * appear in the financial summary cards.
 *
 * Canonical semantics: each deposit.balance already reflects that row's own
 * lifecycle state (applied/refunded/reversed per row), so we sum those values
 * directly. CANCELLED rows are excluded (a reversed/cancelled receipt has zero
 * effective contribution — matching the pre-existing single-row display rule
 * `deposits.find(d => d.status !== 'CANCELLED')`).
 *
 * IMPORTANT: This is DISPLAY-ONLY aggregation. It must NEVER be used to select
 * the Apply/Refund/Reverse mutation target — that remains exclusively
 * selectActionableRoomDeposit(...).
 */
export function summarizeDepositBalances(deposits: Deposit[]): DepositBalance {
  const summary: DepositBalance = {
    effective_received: 0,
    applied: 0,
    refunded: 0,
    reversed_received: 0,
    remaining: 0,
    status: 'RECEIVED',
  };
  for (const d of deposits) {
    if (d.status === 'CANCELLED') continue;
    const b = d.balance;
    if (!b) continue;
    summary.effective_received += b.effective_received ?? 0;
    summary.applied += b.applied ?? 0;
    summary.refunded += b.refunded ?? 0;
    summary.reversed_received += b.reversed_received ?? 0;
    summary.remaining += b.remaining ?? 0;
  }
  return summary;
}
