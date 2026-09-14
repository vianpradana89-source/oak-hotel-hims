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
 * Whether a room (ROOM_RESERVATION) guarantee is still unresolved — i.e. the
 * operator has not yet completed settlement of KTP Kamar / Deposit Kamar.
 *
 * Returned true when ANY of:
 *   - HELD ROOM_RESERVATION identity custody exists, OR
 *   - active (non-CLOSED/CANCELLED) ROOM_RESERVATION deposit has remaining > 0
 *
 * False when both categories are settled (ALL room custody RETURNED + no
 * outstanding room deposit balance).
 *
 * BOOKING_GROUP records are explicitly excluded — they are managed separately.
 */
export function hasUnresolvedRoomGuarantee(
  deposits: Deposit[],
  custody: IdentityCustodyRecord[]
): boolean {
  const heldRoomCustody = custody.some(
    c => !isGroupCustody(c) && c.status === 'HELD'
  );
  const openRoomDeposit = deposits.some(
    d => !isGroupDeposit(d) && isActiveDeposit(d) && (d.balance?.remaining ?? 0) > 0
  );
  return heldRoomCustody || openRoomDeposit;
}

/**
 * Decision helper for the close-warning flow.
 *
 * Typed decision outcomes:
 *   - CLOSE          — close the drawer immediately, no warning
 *   - WAIT           — guarantee data still loading; keep close queued, do nothing yet
 *   - WARN_ROOM      — terminal + ROOM_RESERVATION guarantee unresolved
 *   - WARN_GROUP     — multi-room group terminal + BOOKING_GROUP guarantee unresolved
 *   - WARN_BOTH      — both room and group guarantees unresolved
 *   - WARN_UNVERIFIED— guarantee load FAILED; state unknown, must not be treated as settled
 */
export type GuaranteeCloseAction =
  | 'CLOSE'
  | 'WAIT'
  | 'WARN_ROOM'
  | 'WARN_GROUP'
  | 'WARN_BOTH'
  | 'WARN_UNVERIFIED';

export interface GuaranteeCloseDecision {
  action: GuaranteeCloseAction;
}

/** Load status of guarantee (deposit/custody) data. */
export type GuaranteeLoadStatus = 'loading' | 'ready' | 'error';

export function deriveGuaranteeCloseDecision(params: {
  terminal: boolean;
  status: GuaranteeLoadStatus;
  roomUnresolved: boolean;
  groupEligible: boolean;
  groupUnresolved: boolean;
}): GuaranteeCloseDecision {
  // Non-terminal reservations: always close immediately.
  if (!params.terminal) return { action: 'CLOSE' };
  // Load failed: unknown state must NOT be treated as settled — conservative warning.
  if (params.status === 'error') return { action: 'WARN_UNVERIFIED' };
  // Data not yet loaded: wait — do not close, do not show a false warning.
  if (params.status === 'loading') return { action: 'WAIT' };
  // status === 'ready': canonical unresolved predicates.
  const roomWarn = params.roomUnresolved;
  const groupWarn = params.groupEligible && params.groupUnresolved;
  if (roomWarn && groupWarn) return { action: 'WARN_BOTH' };
  if (roomWarn) return { action: 'WARN_ROOM' };
  if (groupWarn) return { action: 'WARN_GROUP' };
  return { action: 'CLOSE' };
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

/**
 * Request-sequence guard: whether a completed async response is still the LATEST request.
 *
 * A response may only commit state (deposits/custody/loadedSourceKey/loadError/loading)
 * when its request id still equals the latest issued request id. Any older response
 * must be discarded — it has ZERO authority over current state.
 */
export function isCurrentGuaranteeRequest(requestId: number, latestRequestId: number): boolean {
  return requestId === latestRequestId;
}

/**
 * Derives the guarantee load status from observable component state.
 *
 * Production truth: `loadError` is the authoritative failure flag (set only by the
 * LATEST request), `loading` is the authoritative in-flight flag (cleared only by
 * the LATEST request), and `sourceMatches` verifies the committed data belongs to
 * the current reservation+property.
 *
 * @param loading       — whether the latest request is still in flight
 * @param loadError     — whether the latest request completed with failure
 * @param sourceMatches — whether committed data belongs to current reservation+property
 */
export function deriveGuaranteeLoadStatus(params: {
  loading: boolean;
  loadError: boolean;
  sourceMatches: boolean;
}): GuaranteeLoadStatus {
  if (params.loading) return 'loading';
  if (params.loadError) return 'error';
  if (!params.sourceMatches) return 'loading';
  return 'ready';
}

/**
 * CHECKOUT-GUARANTEE-GATE-1A
 *
 * Pure decision outcomes for checkout guarantee gates.
 *
 * Distinguishes at minimum:
 *   - ALLOW                      — no unresolved relevant guarantee, clean confirmation
 *   - HARD_BLOCK_ROOM_IDENTITY   — physical ROOM_RESERVATION custody is HELD (strictly blocks checkout)
 *   - WARN_ROOM_DEPOSIT          — unresolved ROOM_RESERVATION deposit balance > 0
 *   - WARN_FINAL_GROUP_GUARANTEE — final active child of multi-room booking + unresolved group guarantee
 *   - WARN_ROOM_AND_FINAL_GROUP  — room deposit unresolved AND final active child with unresolved group guarantee
 *   - WARN_UNVERIFIED            — unknown or malformed guarantee payload / fetch error (fail safe)
 */
export type CheckoutGateAction =
  | 'ALLOW'
  | 'HARD_BLOCK_ROOM_IDENTITY'
  | 'WARN_ROOM_DEPOSIT'
  | 'WARN_FINAL_GROUP_GUARANTEE'
  | 'WARN_ROOM_AND_FINAL_GROUP'
  | 'WARN_UNVERIFIED';

export type GroupGuaranteeSummaryKind =
  | 'DEPOSIT_AND_CUSTODY'
  | 'DEPOSIT_ONLY'
  | 'CUSTODY_ONLY';

export interface CheckoutGateDecision {
  action: CheckoutGateAction;
  heldRoomCustody?: IdentityCustodyRecord;
  heldRoomCustodyHolderName?: string;
  roomDepositRemaining: number;
  groupDepositRemaining: number;
  groupCustodyHeld: boolean;
  groupGuaranteeSummary?: GroupGuaranteeSummaryKind;
  isFinalChild: boolean;
  isMultiRoom: boolean;
  unverifiedReason?: string;
}

export interface CheckoutGateDecisionParams {
  currentReservation: {
    id: number;
    status: string;
    booking_id?: number | null;
    [key: string]: any;
  } | null | undefined;
  siblingReservations?: Array<{
    id: number;
    status: string;
    [key: string]: any;
  }> | null;
  deposits: Deposit[] | null | undefined;
  custody: IdentityCustodyRecord[] | null | undefined;
  loadStatus?: GuaranteeLoadStatus; // 'loading' | 'ready' | 'error'
}

/**
 * Pure helper for evaluating checkout guarantee gate policy.
 *
 * Rules:
 * 1. Malformed or failed state -> WARN_UNVERIFIED (fail safe).
 * 2. ROOM_RESERVATION physical identity custody HELD -> HARD_BLOCK_ROOM_IDENTITY (takes precedence).
 * 3. Multi-room NON-FINAL child: ignore unresolved BOOKING_GROUP guarantee (ALLOW or WARN_ROOM_DEPOSIT).
 * 4. Multi-room FINAL child + unresolved BOOKING_GROUP guarantee -> WARN_FINAL_GROUP_GUARANTEE (or combined).
 * 5. Room deposit unresolved + final group guarantee unresolved -> WARN_ROOM_AND_FINAL_GROUP.
 * 6. Clean state -> ALLOW (ordinary checkout confirmation).
 */
export function deriveCheckoutGateDecision(
  params: CheckoutGateDecisionParams
): CheckoutGateDecision {
  const { currentReservation, siblingReservations, deposits, custody, loadStatus } = params;

  // 1. Fail safe: if reservation is missing or invalid
  if (!currentReservation || typeof currentReservation.id !== 'number') {
    return {
      action: 'WARN_UNVERIFIED',
      roomDepositRemaining: 0,
      groupDepositRemaining: 0,
      groupCustodyHeld: false,
      isFinalChild: false,
      isMultiRoom: false,
      unverifiedReason: 'INVALID_RESERVATION',
    };
  }

  // 2. Fail safe: if loadStatus is error, or deposits/custody are not arrays
  if (
    loadStatus === 'error' ||
    !Array.isArray(deposits) ||
    !Array.isArray(custody)
  ) {
    return {
      action: 'WARN_UNVERIFIED',
      roomDepositRemaining: 0,
      groupDepositRemaining: 0,
      groupCustodyHeld: false,
      isFinalChild: false,
      isMultiRoom: false,
      unverifiedReason: 'MALFORMED_OR_FAILED_GUARANTEE_DATA',
    };
  }

  // Verify elements inside deposits & custody are valid objects
  for (const d of deposits) {
    if (!d || typeof d !== 'object' || typeof d.status !== 'string') {
      return {
        action: 'WARN_UNVERIFIED',
        roomDepositRemaining: 0,
        groupDepositRemaining: 0,
        groupCustodyHeld: false,
        isFinalChild: false,
        isMultiRoom: false,
        unverifiedReason: 'MALFORMED_DEPOSIT_RECORD',
      };
    }
  }

  for (const c of custody) {
    if (!c || typeof c !== 'object' || typeof c.status !== 'string') {
      return {
        action: 'WARN_UNVERIFIED',
        roomDepositRemaining: 0,
        groupDepositRemaining: 0,
        groupCustodyHeld: false,
        isFinalChild: false,
        isMultiRoom: false,
        unverifiedReason: 'MALFORMED_CUSTODY_RECORD',
      };
    }
  }

  // 3. Evaluate ROOM_RESERVATION physical identity custody HELD (Hard Block)
  // Hard block strictly takes precedence over all other considerations.
  const heldRoomCustodyList = custody.filter(
    c => !isGroupCustody(c) && c.status === 'HELD'
  );
  if (heldRoomCustodyList.length > 0) {
    const firstHeld = heldRoomCustodyList[0];
    return {
      action: 'HARD_BLOCK_ROOM_IDENTITY',
      heldRoomCustody: firstHeld,
      heldRoomCustodyHolderName: firstHeld.document_holder_name || undefined,
      roomDepositRemaining: 0,
      groupDepositRemaining: 0,
      groupCustodyHeld: false,
      isFinalChild: false,
      isMultiRoom: false,
    };
  }

  // 4. Evaluate ROOM_RESERVATION deposit balance
  const activeRoomDeposits = deposits.filter(
    d => !isGroupDeposit(d) && isActiveDeposit(d) && (d.balance?.remaining ?? 0) > 0
  );
  const roomDepositRemaining = activeRoomDeposits.reduce(
    (sum, d) => sum + (d.balance?.remaining ?? 0),
    0
  );
  const hasUnresolvedRoomDeposit = roomDepositRemaining > 0;

  // 5. Evaluate Multi-Room & Final-Child Status
  // Sibling reservations must be evaluated considering current reservation becomes terminal.
  let isMultiRoom = false;
  let isFinalChild = false;

  if (Array.isArray(siblingReservations)) {
    const otherSiblings = siblingReservations.filter(
      s => s && s.id !== currentReservation.id
    );
    if (otherSiblings.length > 0) {
      isMultiRoom = true;
      // All other siblings must be terminal (CHECKED_OUT or CANCELLED)
      const allOtherSiblingsTerminal = otherSiblings.every(
        s => s && (s.status === 'CHECKED_OUT' || s.status === 'CANCELLED')
      );
      isFinalChild = allOtherSiblingsTerminal;
    }
  }

  // 6. Evaluate BOOKING_GROUP guarantees
  const heldGroupCustodyList = custody.filter(
    c => isGroupCustody(c) && c.status === 'HELD'
  );
  const groupCustodyHeld = heldGroupCustodyList.length > 0;

  const activeGroupDeposits = deposits.filter(
    d => isGroupDeposit(d) && isActiveDeposit(d) && (d.balance?.remaining ?? 0) > 0
  );
  const groupDepositRemaining = activeGroupDeposits.reduce(
    (sum, d) => sum + (d.balance?.remaining ?? 0),
    0
  );
  const hasUnresolvedGroupDeposit = groupDepositRemaining > 0;
  const hasUnresolvedGroupGuarantee = groupCustodyHeld || hasUnresolvedGroupDeposit;

  let groupGuaranteeSummary: GroupGuaranteeSummaryKind | undefined;
  if (groupCustodyHeld && hasUnresolvedGroupDeposit) {
    groupGuaranteeSummary = 'DEPOSIT_AND_CUSTODY';
  } else if (hasUnresolvedGroupDeposit) {
    groupGuaranteeSummary = 'DEPOSIT_ONLY';
  } else if (groupCustodyHeld) {
    groupGuaranteeSummary = 'CUSTODY_ONLY';
  }

  // 7. Synthesize outcome based on domain rules
  // Rule 3: For multi-room NON-FINAL child, unresolved BOOKING_GROUP guarantee is ignored for checkout warning.
  // Rule 4: For multi-room FINAL child, unresolved BOOKING_GROUP guarantee produces a warning.
  const relevantGroupWarning = isMultiRoom && isFinalChild && hasUnresolvedGroupGuarantee;

  if (hasUnresolvedRoomDeposit && relevantGroupWarning) {
    return {
      action: 'WARN_ROOM_AND_FINAL_GROUP',
      roomDepositRemaining,
      groupDepositRemaining,
      groupCustodyHeld,
      groupGuaranteeSummary,
      isFinalChild,
      isMultiRoom,
    };
  }

  if (hasUnresolvedRoomDeposit) {
    return {
      action: 'WARN_ROOM_DEPOSIT',
      roomDepositRemaining,
      groupDepositRemaining,
      groupCustodyHeld,
      groupGuaranteeSummary,
      isFinalChild,
      isMultiRoom,
    };
  }

  if (relevantGroupWarning) {
    return {
      action: 'WARN_FINAL_GROUP_GUARANTEE',
      roomDepositRemaining,
      groupDepositRemaining,
      groupCustodyHeld,
      groupGuaranteeSummary,
      isFinalChild,
      isMultiRoom,
    };
  }

  return {
    action: 'ALLOW',
    roomDepositRemaining,
    groupDepositRemaining,
    groupCustodyHeld,
    groupGuaranteeSummary,
    isFinalChild,
    isMultiRoom,
  };
}

/** Format group guarantee summary kind into human-readable Indonesian text. */
export function formatGroupGuaranteeSummary(
  summary?: GroupGuaranteeSummaryKind,
  formattedDepositAmount?: string
): string {
  if (summary === 'DEPOSIT_AND_CUSTODY') {
    return formattedDepositAmount
      ? `Deposit Grup (Rp ${formattedDepositAmount}) & KTP Grup`
      : 'Deposit Grup & KTP Grup';
  }
  if (summary === 'DEPOSIT_ONLY') {
    return formattedDepositAmount
      ? `Deposit Grup (Rp ${formattedDepositAmount})`
      : 'Deposit Grup';
  }
  if (summary === 'CUSTODY_ONLY') {
    return 'KTP Grup';
  }
  return 'Jaminan Grup';
}
