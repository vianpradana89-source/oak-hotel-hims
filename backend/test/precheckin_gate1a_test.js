'use strict';

// PRECHECKIN-GATE-1A — Backend Evaluator Behavior Test
// Tests evaluatePreCheckinEligibility against a mock PoolClient with controlled data.

const assert = require('node:assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { evaluatePreCheckinEligibility } = require('../dist/domains/checkin/checkinGateService');

// Mock PoolClient factory for controlled testing
function createMockClient(rows) {
  const callLog = [];

  return {
    async query(sql, params = []) {
      const key = `${sql}|${JSON.stringify(params)}`;
      callLog.push({ sql, params });

      // ── Booking ID query (for guarantee check) ─────────────────────────
      if (sql.includes('SELECT b.id AS booking_id') && sql.includes('FROM reservations r')) {
        const resId = params[0];
        const res = rows.reservations?.find(r => r.id === resId);
        if (res) {
          return { rows: [{ booking_id: String(res.booking_id || 0) }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // ── Reservation check (always first query) ─────────────────────────
      if (sql.includes('FROM reservations') && sql.includes('res.id')) {
        const resId = params[0];
        const res = rows.reservations?.find(r => r.id === resId);
        if (res) {
          // Service expects booking_property_id or room_property_id
          return {
            rows: [{
              id: res.id,
              room_id: res.room_id,
              booking_property_id: res.property_id,
              room_property_id: res.property_id
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      }

      // ── calculateReservationFinancials reservation check ────────────────
      if (sql.includes('FROM reservations') && sql.includes('r.id') && sql.includes('bookings b')) {
        const resId = params[0];
        const res = rows.reservations?.find(r => r.id === resId);
        if (!res) return { rows: [], rowCount: 0 };

        // If explicit per-reservation financial data is provided, use it
        if (rows.totalPrice !== undefined || rows.paid !== undefined || rows.appliedDeposit !== undefined) {
          const totalPrice = rows.totalPrice ?? 500000;
          const paid = rows.paid ?? 0;
          const appliedDeposit = rows.appliedDeposit ?? 0;
          // NOTE: totalPrice is ALREADY net of any folio discounts (including complimentary).
          // Do NOT subtract compAdjustment again — that would be double-counting.
          let remaining;
          if (rows.remainingBalanceNaN) {
            remaining = NaN;
          } else {
            remaining = Math.max(0, totalPrice - paid - appliedDeposit);
          }
          return {
            rows: [{
              id: res.id,
              property_id: res.property_id,
              room_id: res.room_id,
              booking_property_id: res.property_id,
              status: res.status || 'BOOKED',
              total_price: totalPrice,
              amount_paid: paid,
              applied_deposit: appliedDeposit,
              remaining_balance: remaining,
              subtotal_amount: totalPrice,
              payment_status: remaining <= 0.01 ? 'PAID' : remaining < totalPrice * 0.9 ? 'PARTIAL' : 'UNPAID'
            }],
            rowCount: 1
          };
        }

        // Otherwise, compute from payments and allocations
        const payments = rows.payments || [];
        const allocations = rows.allocations || [];
        const groupPayments = rows.groupPayments || [];
        const totalPaid = payments
          .filter(p => p.reservation_id === resId && p.status === 'SUCCESS')
          .reduce((s, p) => s + Number(p.amount || 0), 0);
        const totalAllocated = allocations
          .filter(a => a.reservation_id === resId && a.status === 'ACTIVE')
          .reduce((s, a) => {
            const parent = groupPayments.find(g => g.id === a.payment_transaction_id);
            return s + (parent && parent.scope === 'BOOKING_GROUP' && parent.status === 'SUCCESS' ? Number(a.allocated_amount) : 0);
          }, 0);
        const appliedDeposit = 0;
        // totalPrice defaults to total paid + 500000 (standard room rate) if no explicit value
        const totalPrice = res.totalPrice ?? (totalPaid + totalAllocated > 0 ? totalPaid + totalAllocated : 500000);
        const remaining = Math.max(0, totalPrice - totalPaid - totalAllocated - appliedDeposit);
        return {
          rows: [{
            id: res.id,
            property_id: res.property_id,
            room_id: res.room_id,
            booking_property_id: res.property_id,
            status: res.status || 'BOOKED',
            total_price: totalPrice,
            amount_paid: totalPaid + totalAllocated,
            applied_deposit: appliedDeposit,
            remaining_balance: remaining,
            subtotal_amount: totalPrice,
            payment_status: remaining <= 0.01 ? 'PAID' : remaining < totalPrice * 0.9 ? 'PARTIAL' : 'UNPAID'
          }],
          rowCount: 1
        };
      }

      // ── PRIMARY_GUEST name & phone ─────────────────────────────────────
      if (sql.includes('reservation_guests') && sql.includes('PRIMARY_GUEST') && sql.includes('full_name')) {
        const resId = params[0];
        const guests = rows.primary_guests || [];
        const guest = guests.find(g => g.reservation_id === resId);
        if (guest) return { rows: [guest], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }

      // ── PRIMARY_GUEST identity document ────────────────────────────────
      if (sql.includes('reservation_guests') && sql.includes('PRIMARY_GUEST') && sql.includes('identity_storage_key')) {
        const resId = params[0];
        const guests = rows.primary_guests_identity || [];
        const guest = guests.find(g => g.reservation_id === resId);
        if (guest) return { rows: [guest], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
      // ── Evidence query (COUNT only) ────────────────────────────────────
      // Must check before payment_transactions because the evidence query
      // contains a subquery referencing payment_transactions with SUCCESS.
      if (sql.includes('payment_evidences') && sql.includes('COUNT(*)')) {
        const resId = params[0];
        const evidenceList = rows.evidences || [];
        const paymentIds = new Set(
          (rows.payments || [])
            .filter(p => p.reservation_id === resId && p.status === 'SUCCESS')
            .map(p => p.id || p.payment_transaction_id)
        );
        const filtered = evidenceList.filter(e =>
          e.reservation_id === resId &&
          e.is_active === true &&
          paymentIds.has(e.payment_transaction_id)
        );
        return { rows: [{ cnt: String(filtered.length) }], rowCount: 1 };
      }

      // ── Payment query (CTE dual-read, 1B2+) ────────────────────────────
      // Handles getEffectivePaymentStateForReservation CTE query.
      // MUST be checked before the legacy payment_transactions handler below,
      // because the CTE query also contains payment_transactions + COUNT(*) + SUCCESS.
      if (sql.includes('WITH direct AS') && sql.includes('CROSS JOIN allocated')) {
        const resId = params[0];
        const propId = params[1];
        const payments = rows.payments || [];
        const allocations = rows.allocations || [];
        const groupPayments = rows.groupPayments || [];

        // Direct ROOM_RESERVATION component
        const directRows = payments.filter(p =>
          p.reservation_id === resId &&
          p.scope === 'ROOM_RESERVATION' &&
          p.status === 'SUCCESS' &&
          (p.transaction_type === 'PAYMENT' || p.transaction_type === 'CORRECTION_REPLACEMENT')
        );
        const directPaid = directRows.reduce((s, p) => s + Number(p.amount || 0), 0);
        const directSourceCnt = directRows.length;
        const directPositiveCnt = directRows.filter(p => Number(p.amount) > 0).length;

        // Allocated BOOKING_GROUP component
        const allocRows = allocations.filter(a =>
          a.reservation_id === resId &&
          a.property_id === propId &&
          a.status === 'ACTIVE'
        ).filter(a => {
          const parent = groupPayments.find(g => g.id === a.payment_transaction_id);
          return parent &&
            parent.scope === 'BOOKING_GROUP' &&
            parent.status === 'SUCCESS' &&
            (parent.transaction_type === 'PAYMENT' || parent.transaction_type === 'CORRECTION_REPLACEMENT');
        });
        const allocatedPaid = allocRows.reduce((s, a) => s + Number(a.allocated_amount || 0), 0);
        const allocSourceCnt = allocRows.length;
        const allocPositiveCnt = allocRows.filter(a => Number(a.allocated_amount) > 0).length;

        return {
          rows: [{
            direct_paid: String(directPaid),
            direct_source_cnt: String(directSourceCnt),
            direct_positive_cnt: String(directPositiveCnt),
            allocated_paid: String(allocatedPaid),
            alloc_source_cnt: String(allocSourceCnt),
            alloc_positive_cnt: String(allocPositiveCnt),
          }],
          rowCount: 1
        };
      }

      // ── Payment query (COUNT + SUM) — legacy pattern ─────────────────
      if (sql.includes('payment_transactions') && sql.includes('COUNT(*)') && sql.includes('SUCCESS') && !sql.includes('WITH direct AS')) {
        const resId = params[0];
        const payments = rows.payments || [];
        const filtered = payments.filter(p =>
          p.reservation_id === resId &&
          p.status === 'SUCCESS' &&
          p.transaction_type === 'PAYMENT' &&
          p.amount > 0
        );
        const cnt = String(filtered.length);
        const total = String(filtered.reduce((s, p) => s + Number(p.amount), 0));
        return { rows: [{ cnt, total }], rowCount: 1 };
      }

      // ── Deposit query (SELECT id - new pattern after HOTFIX-2) ──────────
      if (sql.includes('FROM deposits') && sql.includes('SELECT id')) {
        const resId = params[0];
        const propId = params[1];
        const deposits = rows.deposits || [];
        // Must match: (room-reservation scoped by reservation_id) OR (group scoped by booking_id)
        // Default scope to ROOM_RESERVATION if not specified (backward compat with older test data)
        const filtered = deposits.filter(d =>
          d.property_id === propId &&
          (d.status === 'RECEIVED' || d.status === 'PARTIALLY_USED') &&
          ((d.scope === 'BOOKING_GROUP' && rows.targetBookingId && d.booking_id === rows.targetBookingId) ||
           (d.scope !== 'BOOKING_GROUP' && d.reservation_id === resId))
        );
        return { rows: filtered.map(d => ({ id: d.id })), rowCount: filtered.length };
      }

      // ── Deposit query (SELECT id with status filter) ───────────────────
      if (sql.includes('FROM deposits') && sql.includes('status IN')) {
        const resId = params[0];
        const propId = params[1];
        const deposits = rows.deposits || [];
        const filtered = deposits.filter(d =>
          d.property_id === propId &&
          d.status === 'RECEIVED' &&
          d.reservation_id === resId
        );
        return { rows: filtered.map(d => ({ id: d.id })), rowCount: filtered.length };
      }

      // ── Deposit events query (new pattern after HOTFIX-2) ───────────────
      if (sql.includes('FROM deposit_events') && sql.includes('WHERE deposit_id')) {
        const depositId = params[0];
        const events = rows.events || [];
        const filtered = events.filter(e => e.deposit_id === depositId);
        return { rows: filtered, rowCount: filtered.length };
      }

      // ── Deposit events query (SELECT *) ────────────────────────────────
      if (sql.includes('SELECT * FROM deposit_events') && sql.includes('WHERE deposit_id')) {
        const depositId = params[0];
        const events = rows.events || [];
        const filtered = events.filter(e => e.deposit_id === depositId);
        return { rows: filtered, rowCount: filtered.length };
      }

      // ── Deposit query (COUNT) for backward compat ───────────────────────
      if (sql.includes('FROM deposits') && sql.includes('COUNT(*)')) {
        const resId = params[0];
        const propId = params[1];
        const deposits = rows.deposits || [];
        const filtered = deposits.filter(d =>
          d.reservation_id === resId &&
          d.property_id === propId &&
          d.status === 'RECEIVED' &&
          d.balance_remaining > 0
        );
        return { rows: [{ cnt: String(filtered.length) }], rowCount: 1 };
      }

      // ── Payment evidence query (Gate 5 check) - simple form ─────────────
      if (sql.includes('payment_evidences') && sql.includes('reservation_id') && !sql.includes('JOIN')) {
        const resId = params[0];
        const evidences = rows.evidences || [];
        const payments = rows.payments || [];
        // Build set of valid payment transaction IDs for this reservation
        const validPaymentIds = new Set(
          payments.filter(p =>
            p.reservation_id === resId &&
            p.status === 'SUCCESS'
          ).map(p => p.id || p.payment_transaction_id)
        );
        const filtered = evidences.filter(e =>
          e.reservation_id === resId &&
          e.is_active === true &&
          validPaymentIds.has(e.payment_transaction_id)
        );
        return { rows: filtered, rowCount: filtered.length };
      }

      // ── Payment evidence query (Gate 5 check) - JOIN with payment_allocations ──
      if (sql.includes('payment_evidences') && sql.includes('JOIN')) {
        const resId = params[0];
        const evidences = rows.evidences || [];
        const allocations = rows.allocations || [];
        const payments = rows.payments || [];
        // Valid payment transaction IDs from both direct payments and allocations
        const validPaymentIds = new Set();
        payments.filter(p => p.reservation_id === resId && p.status === 'SUCCESS')
          .forEach(p => validPaymentIds.add(p.id || p.payment_transaction_id));
        allocations.filter(a => a.reservation_id === resId && a.status === 'ACTIVE')
          .forEach(a => validPaymentIds.add(a.payment_transaction_id));
        const filtered = evidences.filter(e =>
          e.reservation_id === resId &&
          e.is_active === true &&
          validPaymentIds.has(e.payment_transaction_id)
        );
        return { rows: filtered, rowCount: filtered.length };
      }

      // ── calculateReservationFinancials DEPOSIT_APPLY query ─────────────
      if (sql.includes('DEPOSIT_APPLY') && sql.includes('folio_entries')) {
        const resId = params[0];
        const propId = params[1];
        const folioEntries = rows.folioEntries || [];
        const filtered = folioEntries.filter(e =>
          e.reservation_id === resId &&
          e.property_id === propId &&
          e.entry_type === 'DEPOSIT_APPLY' &&
          e.direction === 'CREDIT' &&
          e.status === 'POSTED' &&
          !e.is_voided &&
          !e.reversal_of_entry_id
        );
        const appliedDeposit = filtered.reduce((s, e) => s + Number(e.amount || 0), 0);
        return {
          rows: [{ applied_deposit: String(appliedDeposit) }],
          rowCount: 1
        };
      }

      // ── calculateReservationFinancials legacy fallback query ───────────
      if (sql.includes('folio_entries') && sql.includes('PAYMENT') && sql.includes('CORRECTION_REPLACEMENT') && !sql.includes('CASE')) {
        const resId = params[0];
        const folioEntries = rows.folioEntries || [];
        const credits = folioEntries.filter(e =>
          e.reservation_id === resId &&
          e.direction === 'CREDIT' &&
          (e.entry_type === 'PAYMENT' || e.entry_type === 'CORRECTION_REPLACEMENT') &&
          !e.reversal_of_entry_id
        );
        const debits = folioEntries.filter(e =>
          e.reservation_id === resId &&
          e.direction === 'DEBIT' &&
          (e.entry_type === 'PAYMENT_VOID' || e.entry_type === 'PAYMENT_REVERSAL')
        );
        const credited = credits.reduce((s, e) => s + Number(e.amount || 0), 0);
        const debited = debits.reduce((s, e) => s + Number(e.amount || 0), 0);
        const folioPaid = credited - debited;
        return {
          rows: [{ folio_paid: String(folioPaid > 0 ? folioPaid : 0) }],
          rowCount: 1
        };
      }

      // ── Identity custody query (COUNT) ─────────────────────────────────
      if (sql.includes('identity_custody') && sql.includes('COUNT(*)')) {
        const resId = params[0];
        const propId = params[1];
        const custodyList = rows.custody || [];
        const targetBookingId = rows.targetBookingId || null;
        const filtered = custodyList.filter(c =>
          c.property_id === propId &&
          c.status === 'HELD' &&
          ((c.scope !== 'BOOKING_GROUP' && c.reservation_id === resId) ||
            (c.scope === 'BOOKING_GROUP' && targetBookingId && c.booking_id === targetBookingId))
        );
        return { rows: [{ cnt: String(filtered.length) }], rowCount: 1 };
      }

      // ── Room query ─────────────────────────────────────────────────────
      if (sql.includes('FROM rooms') && sql.includes('WHERE id =')) {
        const roomId = params[0];
        const room = rows.rooms?.find(r => r.id === roomId);
        if (room) return { rows: [room], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }

      // ── Outgoing reservation query (for evaluateRoomReadiness) ─────────
      if (sql.includes('outgoing') || sql.includes('CHECKED_IN') || sql.includes('FROM reservations')) {
        return { rows: [], rowCount: 0 };
      }

      // ── calculateReservationFinancials nightly rates query ─────────────
      if (sql.includes('reservation_nightly_rates') && sql.includes('reservation_id')) {
        const resId = params[0];
        const rates = rows.nightlyRates || [];
        const filtered = rates.filter(r => r.reservation_id === resId);
        return { rows: filtered, rowCount: filtered.length };
      }

      // ── calculateReservationFinancials folio debit query ────────────────
      if (sql.includes('COALESCE(SUM(CASE') && sql.includes('folio_entries')) {
        const resId = params[0];
        const folioEntries = rows.folioEntries || [];
        const filteredDebits = folioEntries.filter(e =>
          e.reservation_id === resId &&
          e.direction === 'DEBIT' &&
          !['PAYMENT_VOID', 'PAYMENT_REVERSAL', 'REFUND_DEBIT'].includes(e.entry_type)
        );
        const grossCharges = filteredDebits.reduce((s, e) => s + Number(e.amount || 0), 0);
        const filteredCredits = folioEntries.filter(e =>
          e.reservation_id === resId &&
          e.direction === 'CREDIT' &&
          (e.reversal_of_entry_id || e.entry_type?.includes('REVERSAL'))
        );
        const chargeReversals = filteredCredits.reduce((s, e) => s + Number(e.amount || 0), 0);
        const roomChargePosted = folioEntries.filter(e =>
          e.reservation_id === resId &&
          e.direction === 'DEBIT' &&
          e.entry_type === 'ROOM_CHARGE' &&
          !e.is_voided
        ).reduce((s, e) => s + Number(e.amount || 0), 0);
        const commercialDiscounts = folioEntries.filter(e =>
          e.reservation_id === resId &&
          e.direction === 'CREDIT' &&
          e.entry_type === 'DISCOUNT' &&
          !e.is_voided &&
          !e.reversal_of_entry_id
        ).reduce((s, e) => s + Number(e.amount || 0), 0);
        return {
          rows: [{
            gross_charges: String(grossCharges),
            charge_reversals: String(chargeReversals),
            room_charge_posted: String(roomChargePosted),
            commercial_discounts: String(commercialDiscounts),
            charge_count: String(filteredDebits.length)
          }],
          rowCount: 1
        };
      }

       // ── calculateReservationFinancials: initial reservation lookup ──────
       // Matches: SELECT r.*, b.property_id AS booking_property_id FROM reservations r LEFT JOIN bookings b ...
       if (sql.includes('r.*') && sql.includes('booking_property_id') && params[0] !== undefined) {
         const resId = params[0];
         const res = rows.reservations?.find(r => r.id === resId);
        if (!res) return { rows: [], rowCount: 0 };
          const totalPrice = rows.totalPrice !== undefined ? rows.totalPrice : 500000;
          const paid = rows.paid || 0;
          const appliedDeposit = rows.appliedDeposit || 0;
          const remaining = Math.max(0, totalPrice - paid - appliedDeposit);
         return {
           rows: [{
             id: res.id,
             property_id: res.property_id,
             room_id: res.room_id,
             booking_property_id: res.property_id,
             status: res.status || 'BOOKED',
             total_price: totalPrice,
             amount_paid: paid,
             applied_deposit: appliedDeposit,
             remaining_balance: remaining,
             subtotal_amount: totalPrice,
             payment_status: remaining <= 0.01 ? 'PAID' : remaining < totalPrice * 0.9 ? 'PARTIAL' : 'UNPAID'
           }],
           rowCount: 1
         };
       }

      // ── calculateReservationFinancials DEPOSIT_APPLY query ─────────────
      if (sql.includes('payment_transaction_allocations') && sql.includes('WITH direct AS')) {
        const resId = params[0];
        const propId = params[1];
        const allocations = rows.allocations || [];
        const groupPayments = rows.groupPayments || [];
        const directAllocations = allocations.filter(a =>
          a.reservation_id === resId &&
          a.property_id === propId &&
          a.status === 'ACTIVE'
        );
        const directPaid = directAllocations.reduce((s, a) => s + Number(a.allocated_amount || 0), 0);
        const directSourceCnt = directAllocations.length;
        const directPositiveCnt = directAllocations.filter(a => Number(a.allocated_amount) > 0).length;
        const allocRows = directAllocations.filter(a => {
          const parent = groupPayments.find(g => g.id === a.payment_transaction_id);
          return parent &&
            parent.scope === 'BOOKING_GROUP' &&
            parent.status === 'SUCCESS' &&
            (parent.transaction_type === 'PAYMENT' || parent.transaction_type === 'CORRECTION_REPLACEMENT');
        });
        const allocatedPaid = allocRows.reduce((s, a) => s + Number(a.allocated_amount || 0), 0);
        const allocSourceCnt = allocRows.length;
        const allocPositiveCnt = allocRows.filter(a => Number(a.allocated_amount) > 0).length;
        return {
          rows: [{
            direct_paid: String(directPaid),
            direct_source_cnt: String(directSourceCnt),
            direct_positive_cnt: String(directPositiveCnt),
            allocated_paid: String(allocatedPaid),
            alloc_source_cnt: String(allocSourceCnt),
            alloc_positive_cnt: String(allocPositiveCnt)
          }],
          rowCount: 1
        };
      }

      // ── calculateReservationFinancials payment COUNT query ────────────
      if (sql.includes('payment_transactions') && sql.includes('COUNT(*)') && sql.includes('SUCCESS')) {
        const resId = params[0];
        const payments = rows.payments || [];
        const filtered = payments.filter(p =>
          p.reservation_id === resId &&
          p.status === 'SUCCESS' &&
          p.transaction_type === 'PAYMENT' &&
          p.amount > 0
        );
        return {
          rows: [{
            cnt: String(filtered.length),
            total: String(filtered.reduce((s, p) => s + Number(p.amount), 0))
          }],
          rowCount: 1
        };
      }

      // ── calculateReservationFinancials: initial reservation lookup ──────
      if ((sql.includes('r.*') || sql.includes('reservations r')) && sql.includes('bookings b') && params[0] !== undefined) {
        const resId = params[0];
        const res = rows.reservations?.find(r => r.id === resId);
        if (!res) return { rows: [], rowCount: 0 };
        const totalPrice = rows.totalPrice !== undefined ? rows.totalPrice : 500000;
        const paid = rows.paid || 0;
        const appliedDeposit = rows.appliedDeposit || 0;
        const remaining = Math.max(0, totalPrice - paid - appliedDeposit);
        return {
          rows: [{
            id: res.id,
            property_id: res.property_id,
            room_id: res.room_id,
            booking_property_id: res.property_id,
            status: res.status || 'BOOKED',
            total_price: totalPrice,
            amount_paid: paid,
            applied_deposit: appliedDeposit,
            remaining_balance: remaining,
            subtotal_amount: totalPrice,
            payment_status: remaining <= 0.01 ? 'PAID' : remaining < totalPrice * 0.9 ? 'PARTIAL' : 'UNPAID'
          }],
          rowCount: 1
        };
      }

      // ── calculateReservationFinancials query (general fallback) ───────
      if (sql.includes('calculateReservationFinancials') || sql.includes('total_price') || sql.includes('remaining_balance')) {
        const resId = params[0];
        const res = rows.reservations?.find(r => r.id === resId);
        if (!res) return { rows: [], rowCount: 0 };
        const total = rows.totalPrice || 500000;
        const paid = rows.paid || 0;
        const deposit = rows.appliedDeposit || 0;
        const remaining = Math.max(0, total - paid - deposit);
        return {
          rows: [{
            total_price: String(total),
            amount_paid: String(paid),
            applied_deposit: String(deposit),
            remaining_balance: String(remaining),
            payment_status: remaining <= 0.01 ? 'PAID' : remaining < total * 0.9 ? 'PARTIAL' : 'UNPAID'
          }],
          rowCount: 1
        };
      }

      // ── calculateReservationFinancials comp adjustment query (must be before general one) ──
      if (sql.includes('SUM(applied_adjustment_amount)') && sql.includes('reservation_complimentary_requests')) {
        const resId = params[0];
        const requests = rows.complimentaryRequests || [];
        const total = requests
          .filter(r => r.reservation_id === resId && r.status === 'APPROVED')
          .reduce((s, r) => s + Number(r.applied_adjustment_amount || 0), 0);
        return { rows: [{ total_comp_adjustment: String(total) }], rowCount: 1 };
      }

      // ── hasApprovedComplimentarySettled query ───────────────────────────
      if (sql.includes('reservation_complimentary_requests') && sql.includes('APPROVED')) {
        const resId = params[0];
        const requests = rows.complimentaryRequests || [];
        const filtered = requests.filter(r =>
          r.reservation_id === resId &&
          r.status === 'APPROVED' &&
          r.applied_adjustment_amount > 0
        );
        return { rows: filtered, rowCount: filtered.length };
      }

      // ── calculateReservationFinancials comp adjustment query ────────────
      if (sql.includes('SUM(applied_adjustment_amount)') && sql.includes('reservation_complimentary_requests')) {
        const resId = params[0];
        const requests = rows.complimentaryRequests || [];
        const total = requests
          .filter(r => r.reservation_id === resId && r.status === 'APPROVED')
          .reduce((s, r) => s + Number(r.applied_adjustment_amount || 0), 0);
        return { rows: [{ total_comp_adjustment: String(total) }], rowCount: 1 };
      }

      throw new Error(`Unhandled query: ${sql.substring(0, 100)}`);
    },
    release() {},
    callLog,
  };
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

function expectEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'Assertion failed'}: expected ${expected}, got ${actual}`);
  }
}

function expectHasMissing(result, code, msg) {
  const found = result.missing.find(m => m.code === code);
  if (!found) {
    throw new Error(`${msg || 'Missing requirement not found'}: expected code ${code} in missing array`);
  }
}

function expectNotHasMissing(result, code, msg) {
  const found = result.missing.find(m => m.code === code);
  if (found) {
    throw new Error(`${msg || 'Unexpected missing requirement'}: did not expect code ${code} in missing array`);
  }
}

async function main() {
  // ── Scenario 1: All seven satisfied ────────────────────────────────────
  await test('scenario-1: all gates pass => eligible true', async () => {
    const client = createMockClient({
      reservations: [{ id: 1, property_id: 1, room_id: 10, check_in: '2026-09-15' }],
      primary_guests: [{ reservation_id: 1, full_name: 'John Doe', phone: '081234567890' }],
      primary_guests_identity: [{ reservation_id: 1, identity_storage_key: 'id-docs/1/abc.jpg', has_valid_identity: true }],
      payments: [{ id: 100, reservation_id: 1, scope: 'ROOM_RESERVATION', status: 'SUCCESS', transaction_type: 'PAYMENT', amount: 500000 }],
      allocations: [],
      groupPayments: [],
      evidences: [{ reservation_id: 1, is_active: true, payment_transaction_id: 100 }],
      deposits: [{ id: 1, reservation_id: 1, property_id: 1, status: 'RECEIVED' }],
      events: [{ deposit_id: 1, event_type: 'RECEIVED', amount: 200000 }],
      rooms: [{ id: 10, status: 'VACANT_CLEAN', is_active: true }]
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 1);
    expectEq(result.eligible, true, 'eligible');
    expectEq(result.guest_name_ok, true, 'guest_name_ok');
    expectEq(result.guest_phone_ok, true, 'guest_phone_ok');
    expectEq(result.identity_ok, true, 'identity_ok');
    expectEq(result.payment_ok, true, 'payment_ok');
    expectEq(result.payment_evidence_ok, true, 'payment_evidence_ok');
    expectEq(result.guarantee_ok, true, 'guarantee_ok');
    expectEq(result.room_ready_ok, true, 'room_ready_ok');
    expectEq(result.missing.length, 0, 'missing count');
  });

  // ── Scenario 2: No PRIMARY_GUEST at all ────────────────────────────────
  await test('scenario-2: no PRIMARY_GUEST => name/phone/identity all false', async () => {
    const client = createMockClient({
      reservations: [{ id: 2, property_id: 1, room_id: 10 }],
      primary_guests: [],
      primary_guests_identity: [],
      payments: [],
      evidences: [],
      deposits: [],
      rooms: [{ id: 10, status: 'VACANT_CLEAN' }]
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 2);
    expectEq(result.eligible, false, 'eligible');
    expectEq(result.guest_name_ok, false, 'guest_name_ok');
    expectEq(result.guest_phone_ok, false, 'guest_phone_ok');
    expectEq(result.identity_ok, false, 'identity_ok');
    expectHasMissing(result, 'PRIMARY_GUEST_NAME_MISSING');
    expectHasMissing(result, 'PRIMARY_GUEST_PHONE_MISSING');
    expectHasMissing(result, 'IDENTITY_DOCUMENT_MISSING');
  });

  // ── Scenario 3: PRIMARY_GUEST has name/phone/NIK but NO document ───────
  await test('scenario-3: NIK without document upload => identity false', async () => {
    const client = createMockClient({
      reservations: [{ id: 3, property_id: 1, room_id: 10 }],
      primary_guests: [{ reservation_id: 3, full_name: 'Jane Doe', phone: '081234567891' }],
      primary_guests_identity: [{ reservation_id: 3, identity_storage_key: null, has_valid_identity: false }],
      payments: [],
      evidences: [],
      deposits: [],
      rooms: [{ id: 10, status: 'VACANT_CLEAN' }]
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 3);
    expectEq(result.eligible, false, 'eligible');
    expectEq(result.identity_ok, false, 'identity_ok');
    expectHasMissing(result, 'IDENTITY_DOCUMENT_MISSING');
    expectHasMissing(result, 'PAYMENT_MISSING');
    expectHasMissing(result, 'PAYMENT_EVIDENCE_MISSING');
  });

  // ── Scenario 4: Partial successful payment + canonical evidence ────────
  await test('scenario-4: partial payment + evidence => payment true, evidence true', async () => {
    const client = createMockClient({
      reservations: [{ id: 4, property_id: 1, room_id: 10, check_in: '2026-09-15' }],
      primary_guests: [{ reservation_id: 4, full_name: 'Bob Smith', phone: '081234567892' }],
      primary_guests_identity: [{ reservation_id: 4, identity_storage_key: 'id-docs/4/xyz.jpg', has_valid_identity: true }],
      payments: [{ id: 200, reservation_id: 4, scope: 'ROOM_RESERVATION', status: 'SUCCESS', transaction_type: 'PAYMENT', amount: 100000 }],
      allocations: [],
      groupPayments: [],
      evidences: [{ reservation_id: 4, is_active: true, payment_transaction_id: 200 }],
      deposits: [],
      rooms: [{ id: 10, status: 'VACANT_CLEAN', is_active: true }]
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 4);
    expectEq(result.payment_ok, true, 'payment_ok');
    expectEq(result.payment_evidence_ok, true, 'payment_evidence_ok');
    expectNotHasMissing(result, 'PAYMENT_MISSING');
    expectNotHasMissing(result, 'PAYMENT_EVIDENCE_MISSING');
    expectEq(result.guarantee_ok, false, 'guarantee_ok');
    expectHasMissing(result, 'GUARANTEE_MISSING');
  });

  // ── Scenario 5: No successful payment ──────────────────────────────────
  await test('scenario-5: no payment => payment false, evidence false', async () => {
    const client = createMockClient({
      reservations: [{ id: 5, property_id: 1, room_id: 10 }],
      primary_guests: [{ reservation_id: 5, full_name: 'Alice Wong', phone: '081234567893' }],
      primary_guests_identity: [{ reservation_id: 5, identity_storage_key: 'id-docs/5/doc.jpg', has_valid_identity: true }],
      payments: [],
      evidences: [],
      deposits: [],
      rooms: [{ id: 10, status: 'VACANT_CLEAN' }]
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 5);
    expectEq(result.payment_ok, false, 'payment_ok');
    expectEq(result.payment_evidence_ok, false, 'payment_evidence_ok');
    expectHasMissing(result, 'PAYMENT_MISSING');
    expectHasMissing(result, 'PAYMENT_EVIDENCE_MISSING');
  });

  // ── Scenario 6: Successful payment but no evidence ─────────────────────
  await test('scenario-6: payment exists but no evidence => payment true, evidence false', async () => {
    const client = createMockClient({
      reservations: [{ id: 6, property_id: 1, room_id: 10, check_in: '2026-09-15' }],
      primary_guests: [{ reservation_id: 6, full_name: 'Charlie Tan', phone: '081234567894' }],
      primary_guests_identity: [{ reservation_id: 6, identity_storage_key: 'id-docs/6/doc.jpg', has_valid_identity: true }],
      payments: [{ id: 300, reservation_id: 6, scope: 'ROOM_RESERVATION', status: 'SUCCESS', transaction_type: 'PAYMENT', amount: 300000 }],
      allocations: [],
      groupPayments: [],
      evidences: [],
      deposits: [],
      rooms: [{ id: 10, status: 'VACANT_CLEAN', is_active: true }]
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 6);
    expectEq(result.payment_ok, true, 'payment_ok');
    expectEq(result.payment_evidence_ok, false, 'payment_evidence_ok');
    expectNotHasMissing(result, 'PAYMENT_MISSING');
    expectHasMissing(result, 'PAYMENT_EVIDENCE_MISSING');
  });

  // ── Scenario 7: Active cash deposit ────────────────────────────────────
  await test('scenario-7: active cash deposit => guarantee true', async () => {
    const client = createMockClient({
      reservations: [{ id: 7, property_id: 1, room_id: 10, check_in: '2026-09-15' }],
      primary_guests: [{ reservation_id: 7, full_name: 'Diana Putri', phone: '081234567895' }],
      primary_guests_identity: [{ reservation_id: 7, identity_storage_key: 'id-docs/7/doc.jpg', has_valid_identity: true }],
      payments: [{ id: 400, reservation_id: 7, scope: 'ROOM_RESERVATION', status: 'SUCCESS', transaction_type: 'PAYMENT', amount: 500000 }],
      allocations: [],
      groupPayments: [],
      evidences: [{ reservation_id: 7, is_active: true, payment_transaction_id: 400 }],
      deposits: [{ id: 7, reservation_id: 7, property_id: 1, status: 'RECEIVED' }],
      events: [{ deposit_id: 7, event_type: 'RECEIVED', amount: 300000 }],
      rooms: [{ id: 10, status: 'VACANT_CLEAN', is_active: true }]
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 7);
    expectEq(result.guarantee_ok, true, 'guarantee_ok');
    expectNotHasMissing(result, 'GUARANTEE_MISSING');
  });

  // ── Scenario 8: Held identity custody ──────────────────────────────────
  await test('scenario-8: HELD identity custody => guarantee true', async () => {
    const client = createMockClient({
      reservations: [{ id: 8, property_id: 1, room_id: 10, check_in: '2026-09-15' }],
      primary_guests: [{ reservation_id: 8, full_name: 'Eko Prasetyo', phone: '081234567896' }],
      primary_guests_identity: [{ reservation_id: 8, identity_storage_key: 'id-docs/8/doc.jpg', has_valid_identity: true }],
      payments: [{ id: 500, reservation_id: 8, scope: 'ROOM_RESERVATION', status: 'SUCCESS', transaction_type: 'PAYMENT', amount: 500000 }],
      allocations: [],
      groupPayments: [],
      evidences: [{ reservation_id: 8, is_active: true, payment_transaction_id: 500 }],
      deposits: [],
      custody: [{ reservation_id: 8, property_id: 1, status: 'HELD' }],
      rooms: [{ id: 10, status: 'VACANT_CLEAN', is_active: true }]
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 8);
    expectEq(result.guarantee_ok, true, 'guarantee_ok');
    expectNotHasMissing(result, 'GUARANTEE_MISSING');
  });

  // ── Scenario 9: Returned identity custody only ─────────────────────────
  await test('scenario-9: returned custody only => guarantee false', async () => {
    const client = createMockClient({
      reservations: [{ id: 9, property_id: 1, room_id: 10, check_in: '2026-09-15' }],
      primary_guests: [{ reservation_id: 9, full_name: 'Fani Rahmawati', phone: '081234567897' }],
      primary_guests_identity: [{ reservation_id: 9, identity_storage_key: 'id-docs/9/doc.jpg', has_valid_identity: true }],
      payments: [{ id: 600, reservation_id: 9, scope: 'ROOM_RESERVATION', status: 'SUCCESS', transaction_type: 'PAYMENT', amount: 500000 }],
      allocations: [],
      groupPayments: [],
      evidences: [{ reservation_id: 9, is_active: true, payment_transaction_id: 600 }],
      deposits: [],
      custody: [{ reservation_id: 9, property_id: 1, status: 'RETURNED' }],
      rooms: [{ id: 10, status: 'VACANT_CLEAN', is_active: true }]
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 9);
    expectEq(result.guarantee_ok, false, 'guarantee_ok');
    expectHasMissing(result, 'GUARANTEE_MISSING');
  });

  // ── Scenario 10: Deposit CLOSED / zero balance ─────────────────────────
  await test('scenario-10: closed deposit with zero balance => guarantee false', async () => {
    const client = createMockClient({
      reservations: [{ id: 10, property_id: 1, room_id: 10, check_in: '2026-09-15' }],
      primary_guests: [{ reservation_id: 10, full_name: 'Gus Malindi', phone: '081234567898' }],
      primary_guests_identity: [{ reservation_id: 10, identity_storage_key: 'id-docs/10/doc.jpg', has_valid_identity: true }],
      payments: [{ id: 700, reservation_id: 10, scope: 'ROOM_RESERVATION', status: 'SUCCESS', transaction_type: 'PAYMENT', amount: 500000 }],
      allocations: [],
      groupPayments: [],
      evidences: [{ reservation_id: 10, is_active: true, payment_transaction_id: 700 }],
      deposits: [{ reservation_id: 10, property_id: 1, status: 'CLOSED', balance_remaining: 0 }],
      rooms: [{ id: 10, status: 'VACANT_CLEAN', is_active: true }]
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 10);
    expectEq(result.guarantee_ok, false, 'guarantee_ok');
    expectHasMissing(result, 'GUARANTEE_MISSING');
  });

  // ── Scenario 11: Room dirty ────────────────────────────────────────────
  await test('scenario-11: VACANT_DIRTY room => room_ready false', async () => {
    const client = createMockClient({
      reservations: [{ id: 11, property_id: 1, room_id: 11, check_in: '2026-09-15' }],
      primary_guests: [{ reservation_id: 11, full_name: 'Hana Salsabila', phone: '081234567899' }],
      primary_guests_identity: [{ reservation_id: 11, identity_storage_key: 'id-docs/11/doc.jpg', has_valid_identity: true }],
      payments: [{ id: 800, reservation_id: 11, scope: 'ROOM_RESERVATION', status: 'SUCCESS', transaction_type: 'PAYMENT', amount: 500000 }],
      allocations: [],
      groupPayments: [],
      evidences: [{ reservation_id: 11, is_active: true, payment_transaction_id: 800 }],
      deposits: [{ reservation_id: 11, property_id: 1, status: 'RECEIVED', balance_remaining: 100000 }],
      rooms: [{ id: 11, status: 'VACANT_DIRTY', is_active: true }]
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 11);
    expectEq(result.room_ready_ok, false, 'room_ready_ok');
    expectHasMissing(result, 'ROOM_NOT_READY');
  });

  // ── Scenario 12: Room ready ────────────────────────────────────────────
  await test('scenario-12: VACANT_CLEAN room => room_ready true', async () => {
    const client = createMockClient({
      reservations: [{ id: 12, property_id: 1, room_id: 12, check_in: '2026-09-15' }],
      primary_guests: [{ reservation_id: 12, full_name: 'Irfan Hakim', phone: '081234567800' }],
      primary_guests_identity: [{ reservation_id: 12, identity_storage_key: 'id-docs/12/doc.jpg', has_valid_identity: true }],
      payments: [{ id: 900, reservation_id: 12, scope: 'ROOM_RESERVATION', status: 'SUCCESS', transaction_type: 'PAYMENT', amount: 500000 }],
      allocations: [],
      groupPayments: [],
      evidences: [{ reservation_id: 12, is_active: true, payment_transaction_id: 900 }],
      deposits: [{ reservation_id: 12, property_id: 1, status: 'RECEIVED', balance_remaining: 100000 }],
      rooms: [{ id: 12, status: 'VACANT_CLEAN', is_active: true }]
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 12);
    expectEq(result.room_ready_ok, true, 'room_ready_ok');
    expectNotHasMissing(result, 'ROOM_NOT_READY');
  });

  // ── Scenario 13: Reservation not found for property ────────────────────
  await test('scenario-13: reservation from wrong property => all false', async () => {
    const client = createMockClient({
      reservations: [],
      rooms: []
    });

    const result = await evaluatePreCheckinEligibility(client, 2, 999);
    expectEq(result.eligible, false, 'eligible');
    expectEq(result.guest_name_ok, false, 'guest_name_ok');
    expectEq(result.guest_phone_ok, false, 'guest_phone_ok');
    expectEq(result.identity_ok, false, 'identity_ok');
    expectEq(result.payment_ok, false, 'payment_ok');
    expectEq(result.payment_evidence_ok, false, 'payment_evidence_ok');
    expectEq(result.guarantee_ok, false, 'guarantee_ok');
    expectEq(result.room_ready_ok, false, 'room_ready_ok');
    assert(result.missing.length > 0, 'must have missing items');
  });

  // ── Scenario 14: Identity with has_valid_identity=true but no storage key ──
  await test('scenario-14: has_valid_identity=true without storage_key => identity false', async () => {
    const client = createMockClient({
      reservations: [{ id: 14, property_id: 1, room_id: 14 }],
      primary_guests: [{ reservation_id: 14, full_name: 'Joko Widodo', phone: '081234567814' }],
      primary_guests_identity: [{ reservation_id: 14, identity_storage_key: null, has_valid_identity: true }],
      payments: [{ id: 1000, reservation_id: 14, status: 'SUCCESS', transaction_type: 'PAYMENT', amount: 500000 }],
      evidences: [{ reservation_id: 14, is_active: true, payment_transaction_id: 1000 }],
      deposits: [{ reservation_id: 14, property_id: 1, status: 'RECEIVED', balance_remaining: 100000 }],
      rooms: [{ id: 14, status: 'VACANT_CLEAN' }]
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 14);
    expectEq(result.identity_ok, false, 'identity_ok - must require storage_key');
    expectHasMissing(result, 'IDENTITY_DOCUMENT_MISSING');
  });

  // ── Scenario 15: Evidence without payment ──────────────────────────────
  await test('scenario-15: orphan evidence without payment => evidence false', async () => {
    const client = createMockClient({
      reservations: [{ id: 15, property_id: 1, room_id: 15 }],
      primary_guests: [{ reservation_id: 15, full_name: 'Kartini Sari', phone: '081234567815' }],
      primary_guests_identity: [{ reservation_id: 15, identity_storage_key: 'id-docs/15/doc.jpg', has_valid_identity: true }],
      payments: [],
      evidences: [{ reservation_id: 15, is_active: true, payment_transaction_id: 999 }],
      deposits: [],
      rooms: [{ id: 15, status: 'VACANT_CLEAN' }]
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 15);
    expectEq(result.payment_ok, false, 'payment_ok');
    expectEq(result.payment_evidence_ok, false, 'payment_evidence_ok - must be false when no payment');
    expectHasMissing(result, 'PAYMENT_MISSING');
    expectHasMissing(result, 'PAYMENT_EVIDENCE_MISSING');
  });

  // ── Scenario 16: Allocation-only payment (Gate 4 passes via group allocation) ──
  await test('scenario-16: allocation-only payment => Gate 4 passes, Gate 5 unchanged', async () => {
    const client = createMockClient({
      reservations: [{ id: 16, property_id: 1, room_id: 16, check_in: '2026-09-15' }],
      primary_guests: [{ reservation_id: 16, full_name: 'Luna Maya', phone: '081234567816' }],
      primary_guests_identity: [{ reservation_id: 16, identity_storage_key: 'id-docs/16/doc.jpg', has_valid_identity: true }],
      payments: [],
      allocations: [
        { reservation_id: 16, property_id: 1, status: 'ACTIVE', payment_transaction_id: 9001, allocated_amount: 250000 }
      ],
      groupPayments: [
        { id: 9001, scope: 'BOOKING_GROUP', status: 'SUCCESS', transaction_type: 'PAYMENT', amount: 500000 }
      ],
      evidences: [],
      deposits: [],
      rooms: [{ id: 16, status: 'VACANT_CLEAN', is_active: true }]
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 16);
    expectEq(result.payment_ok, true, 'payment_ok — allocation satisfies Gate 4');
    expectEq(result.payment_evidence_ok, false, 'payment_evidence_ok — no evidence for group payment');
    expectNotHasMissing(result, 'PAYMENT_MISSING');
    expectHasMissing(result, 'PAYMENT_EVIDENCE_MISSING');
  });

  // ── Scenario 17: Approved Complimentary only (no ordinary payment) => Gate 4 PASS, Gate 5 WAIVED ──
  await test('scenario-17: approved comp only with zero balance => payment PASS, evidence WAIVED', async () => {
    const client = createMockClient({
      reservations: [{ id: 17, property_id: 1, room_id: 17, check_in: '2026-09-15' }],
      primary_guests: [{ reservation_id: 17, full_name: 'Maya Estianty', phone: '081234567817' }],
      primary_guests_identity: [{ reservation_id: 17, identity_storage_key: 'id-docs/17/doc.jpg', has_valid_identity: true }],
      payments: [],
      allocations: [],
      groupPayments: [],
      evidences: [],
      deposits: [],
      rooms: [{ id: 17, status: 'VACANT_CLEAN', is_active: true }],
      // totalPrice is ALREADY net of the complimentary DISCOUNT folio entry.
      // Room charge 500000 was fully covered by comp, so net = 0.
      totalPrice: 0,
      paid: 0,
      appliedDeposit: 0,
      complimentaryRequests: [
        { reservation_id: 17, status: 'APPROVED', applied_adjustment_amount: 500000 }
      ]
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 17);
    expectEq(result.payment_ok, true, 'payment_ok — approved comp settles zero balance');
    expectEq(result.payment_evidence_ok, true, 'payment_evidence_ok — evidence WAIVED for comp-only');
    expectNotHasMissing(result, 'PAYMENT_MISSING');
    expectNotHasMissing(result, 'PAYMENT_EVIDENCE_MISSING');
  });

  // ── Scenario 27: Approved comp discounts room charge but extra charge remains ──
  // This tests the critical invariant: complimentary discount is ALREADY reflected
  // in netTotalCharges (via folio DISCOUNT entry). It must NOT be double-counted
  // as an additional settlement on top of effectiveSettlement.
  await test('scenario-27: comp discount on room + unpaid extra charge => payment FAILS', async () => {
    const client = createMockClient({
      reservations: [{ id: 27, property_id: 1, room_id: 27, check_in: '2026-09-15' }],
      primary_guests: [{ reservation_id: 27, full_name: 'Budi Santoso', phone: '081234567827' }],
      primary_guests_identity: [{ reservation_id: 27, identity_storage_key: 'id-docs/27/doc.jpg', has_valid_identity: true }],
      payments: [],
      allocations: [],
      groupPayments: [],
      evidences: [],
      deposits: [],
      rooms: [{ id: 27, status: 'VACANT_CLEAN', is_active: true }],
      // totalPrice is ALREADY net of the complimentary DISCOUNT folio entry:
      // gross room 588000 + extra charge 100000 - comp discount 588000 = 100000
      totalPrice: 100000,
      paid: 0,
      appliedDeposit: 0,
      complimentaryRequests: [
        { reservation_id: 27, status: 'APPROVED', applied_adjustment_amount: 588000 }
      ]
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 27);
    // Even though comp covers the room, the extra charge of 100000 is UNPAID
    expectEq(result.payment_ok, false, 'payment_ok — unpaid extra charge blocks check-in');
    expectHasMissing(result, 'PAYMENT_MISSING');
  });

  // ── Scenario 18: Pending Complimentary => Gate 4 FAILS ──
  await test('scenario-18: pending comp => payment FAILS', async () => {
    const client = createMockClient({
      reservations: [{ id: 18, property_id: 1, room_id: 18, check_in: '2026-09-15' }],
      primary_guests: [{ reservation_id: 18, full_name: 'Nikki Palenewen', phone: '081234567818' }],
      primary_guests_identity: [{ reservation_id: 18, identity_storage_key: 'id-docs/18/doc.jpg', has_valid_identity: true }],
      payments: [],
      allocations: [],
      groupPayments: [],
      evidences: [],
      deposits: [],
      rooms: [{ id: 18, status: 'VACANT_CLEAN', is_active: true }],
      totalPrice: 500000,
      paid: 0,
      appliedDeposit: 0,
      complimentaryRequests: [
        { reservation_id: 18, status: 'PENDING_APPROVAL', applied_adjustment_amount: 500000 }
      ]
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 18);
    expectEq(result.payment_ok, false, 'payment_ok — pending comp does not settle');
    expectHasMissing(result, 'PAYMENT_MISSING');
  });

  // ── Scenario 19: Rejected Complimentary => Gate 4 FAILS ��─
  await test('scenario-19: rejected comp => payment FAILS', async () => {
    const client = createMockClient({
      reservations: [{ id: 19, property_id: 1, room_id: 19, check_in: '2026-09-15' }],
      primary_guests: [{ reservation_id: 19, full_name: 'Rendy Koesnaedi', phone: '081234567819' }],
      primary_guests_identity: [{ reservation_id: 19, identity_storage_key: 'id-docs/19/doc.jpg', has_valid_identity: true }],
      payments: [],
      allocations: [],
      groupPayments: [],
      evidences: [],
      deposits: [],
      rooms: [{ id: 19, status: 'VACANT_CLEAN', is_active: true }],
      totalPrice: 500000,
      paid: 0,
      appliedDeposit: 0,
      complimentaryRequests: [
        { reservation_id: 19, status: 'REJECTED', applied_adjustment_amount: 500000 }
      ]
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 19);
    expectEq(result.payment_ok, false, 'payment_ok — rejected comp does not settle');
    expectHasMissing(result, 'PAYMENT_MISSING');
  });

  // ── Scenario 20: Revoked Complimentary => Gate 4 FAILS ──
  await test('scenario-20: revoked comp => payment FAILS', async () => {
    const client = createMockClient({
      reservations: [{ id: 20, property_id: 1, room_id: 20, check_in: '2026-09-15' }],
      primary_guests: [{ reservation_id: 20, full_name: 'Sissy Priscillia', phone: '081234567820' }],
      primary_guests_identity: [{ reservation_id: 20, identity_storage_key: 'id-docs/20/doc.jpg', has_valid_identity: true }],
      payments: [],
      allocations: [],
      groupPayments: [],
      evidences: [],
      deposits: [],
      rooms: [{ id: 20, status: 'VACANT_CLEAN', is_active: true }],
      totalPrice: 500000,
      paid: 0,
      appliedDeposit: 0,
      complimentaryRequests: [
        { reservation_id: 20, status: 'REVOKED', applied_adjustment_amount: 500000 }
      ]
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 20);
    expectEq(result.payment_ok, false, 'payment_ok — revoked comp does not settle');
    expectHasMissing(result, 'PAYMENT_MISSING');
  });

  // ── Scenario 21: Extra unpaid charge => Gate 4 FAILS ──
  await test('scenario-21: extra unpaid charge => payment FAILS', async () => {
    const client = createMockClient({
      reservations: [{ id: 21, property_id: 1, room_id: 21, check_in: '2026-09-15' }],
      primary_guests: [{ reservation_id: 21, full_name: 'Titi Kamal', phone: '081234567821' }],
      primary_guests_identity: [{ reservation_id: 21, identity_storage_key: 'id-docs/21/doc.jpg', has_valid_identity: true }],
      payments: [{ id: 2000, reservation_id: 21, scope: 'ROOM_RESERVATION', status: 'SUCCESS', transaction_type: 'PAYMENT', amount: 500000 }],
      allocations: [],
      groupPayments: [],
      evidences: [{ reservation_id: 21, is_active: true, payment_transaction_id: 2000 }],
      deposits: [],
      rooms: [{ id: 21, status: 'VACANT_CLEAN', is_active: true }],
      totalPrice: 600000,
      paid: 500000,
      appliedDeposit: 0
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 21);
    expectEq(result.payment_ok, false, 'payment_ok — outstanding charge blocks check-in');
    expectHasMissing(result, 'PAYMENT_MISSING');
  });

  // ── Scenario 22: Partial ordinary payment => Gate 4 FAILS ──
  await test('scenario-22: partial ordinary payment => payment FAILS', async () => {
    const client = createMockClient({
      reservations: [{ id: 22, property_id: 1, room_id: 22, check_in: '2026-09-15' }],
      primary_guests: [{ reservation_id: 22, full_name: 'Ungu Festival', phone: '081234567822' }],
      primary_guests_identity: [{ reservation_id: 22, identity_storage_key: 'id-docs/22/doc.jpg', has_valid_identity: true }],
      payments: [{ id: 2100, reservation_id: 22, scope: 'ROOM_RESERVATION', status: 'SUCCESS', transaction_type: 'PAYMENT', amount: 300000 }],
      allocations: [],
      groupPayments: [],
      evidences: [],
      deposits: [],
      rooms: [{ id: 22, status: 'VACANT_CLEAN', is_active: true }],
      totalPrice: 500000,
      paid: 300000,
      appliedDeposit: 0
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 22);
    expectEq(result.payment_ok, false, 'payment_ok — partial payment blocks check-in');
    expectHasMissing(result, 'PAYMENT_MISSING');
  });

  // ── Scenario 23: Full ordinary payment with evidence => PASS ──
  await test('scenario-23: full ordinary payment with evidence => PASS', async () => {
    const client = createMockClient({
      reservations: [{ id: 23, property_id: 1, room_id: 23, check_in: '2026-09-15' }],
      primary_guests: [{ reservation_id: 23, full_name: 'Vidi Shallom', phone: '081234567823' }],
      primary_guests_identity: [{ reservation_id: 23, identity_storage_key: 'id-docs/23/doc.jpg', has_valid_identity: true }],
      payments: [{ id: 2200, reservation_id: 23, scope: 'ROOM_RESERVATION', status: 'SUCCESS', transaction_type: 'PAYMENT', amount: 500000 }],
      allocations: [],
      groupPayments: [],
      evidences: [{ reservation_id: 23, is_active: true, payment_transaction_id: 2200 }],
      deposits: [],
      rooms: [{ id: 23, status: 'VACANT_CLEAN', is_active: true }],
      totalPrice: 500000,
      paid: 500000,
      appliedDeposit: 0
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 23);
    expectEq(result.payment_ok, true, 'payment_ok — full payment passes');
    expectEq(result.payment_evidence_ok, true, 'payment_evidence_ok — evidence present');
    expectNotHasMissing(result, 'PAYMENT_MISSING');
    expectNotHasMissing(result, 'PAYMENT_EVIDENCE_MISSING');
  });

  // ── Scenario 24: Full ordinary payment missing evidence => FAILS ──
  await test('scenario-24: full ordinary payment missing evidence => FAILS', async () => {
    const client = createMockClient({
      reservations: [{ id: 24, property_id: 1, room_id: 24, check_in: '2026-09-15' }],
      primary_guests: [{ reservation_id: 24, full_name: 'Wino Bastian', phone: '081234567824' }],
      primary_guests_identity: [{ reservation_id: 24, identity_storage_key: 'id-docs/24/doc.jpg', has_valid_identity: true }],
      payments: [{ id: 2300, reservation_id: 24, scope: 'ROOM_RESERVATION', status: 'SUCCESS', transaction_type: 'PAYMENT', amount: 500000 }],
      allocations: [],
      groupPayments: [],
      evidences: [],
      deposits: [],
      rooms: [{ id: 24, status: 'VACANT_CLEAN', is_active: true }],
      totalPrice: 500000,
      paid: 500000,
      appliedDeposit: 0
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 24);
    expectEq(result.payment_ok, true, 'payment_ok — full payment passes');
    expectEq(result.payment_evidence_ok, false, 'payment_evidence_ok — evidence required for ordinary payment');
    expectNotHasMissing(result, 'PAYMENT_MISSING');
    expectHasMissing(result, 'PAYMENT_EVIDENCE_MISSING');
  });

  // ── Scenario 25: Mixed Comp + Ordinary with evidence => PASS ──
  await test('scenario-25: mixed comp + ordinary with evidence => PASS', async () => {
    const client = createMockClient({
      reservations: [{ id: 25, property_id: 1, room_id: 25, check_in: '2026-09-15' }],
      primary_guests: [{ reservation_id: 25, full_name: 'Xena Princess', phone: '081234567825' }],
      primary_guests_identity: [{ reservation_id: 25, identity_storage_key: 'id-docs/25/doc.jpg', has_valid_identity: true }],
      payments: [{ id: 2400, reservation_id: 25, scope: 'ROOM_RESERVATION', status: 'SUCCESS', transaction_type: 'PAYMENT', amount: 200000 }],
      allocations: [],
      groupPayments: [],
      evidences: [{ reservation_id: 25, is_active: true, payment_transaction_id: 2400 }],
      deposits: [],
      rooms: [{ id: 25, status: 'VACANT_CLEAN', is_active: true }],
      // totalPrice is ALREADY net: gross 500000 - comp discount 300000 = 200000
      totalPrice: 200000,
      paid: 200000,
      appliedDeposit: 0,
      complimentaryRequests: [
        { reservation_id: 25, status: 'APPROVED', applied_adjustment_amount: 300000 }
      ]
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 25);
    expectEq(result.payment_ok, true, 'payment_ok — mixed comp + ordinary settles');
    expectEq(result.payment_evidence_ok, true, 'payment_evidence_ok — evidence present for ordinary portion');
    expectNotHasMissing(result, 'PAYMENT_MISSING');
    expectNotHasMissing(result, 'PAYMENT_EVIDENCE_MISSING');
  });

  // ── Scenario 26: Mixed Comp + Ordinary with outstanding => FAILS ──
  await test('scenario-26: mixed comp + ordinary outstanding => FAILS', async () => {
    const client = createMockClient({
      reservations: [{ id: 26, property_id: 1, room_id: 26, check_in: '2026-09-15' }],
      primary_guests: [{ reservation_id: 26, full_name: 'Yuki Kato', phone: '081234567826' }],
      primary_guests_identity: [{ reservation_id: 26, identity_storage_key: 'id-docs/26/doc.jpg', has_valid_identity: true }],
      payments: [{ id: 2500, reservation_id: 26, scope: 'ROOM_RESERVATION', status: 'SUCCESS', transaction_type: 'PAYMENT', amount: 200000 }],
      allocations: [],
      groupPayments: [],
      evidences: [],
      deposits: [],
      rooms: [{ id: 26, status: 'VACANT_CLEAN', is_active: true }],
      totalPrice: 500000,
      paid: 200000,
      appliedDeposit: 0,
      complimentaryRequests: [
        { reservation_id: 26, status: 'APPROVED', applied_adjustment_amount: 200000 }
      ]
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 26);
    expectEq(result.payment_ok, false, 'payment_ok — outstanding balance blocks check-in');
    expectHasMissing(result, 'PAYMENT_MISSING');
  });

  // ── Scenario 28: Non-finite remaining_balance => payment FAILS (fail-closed) ──
  await test('scenario-28: invalid remaining_balance => payment FAILS', async () => {
    const client = createMockClient({
      reservations: [{ id: 28, property_id: 1, room_id: 28, check_in: '2026-09-15' }],
      primary_guests: [{ reservation_id: 28, full_name: 'Test Guest', phone: '081234567828' }],
      primary_guests_identity: [{ reservation_id: 28, identity_storage_key: 'id-docs/28/doc.jpg', has_valid_identity: true }],
      payments: [],
      allocations: [],
      groupPayments: [],
      evidences: [],
      deposits: [],
      rooms: [{ id: 28, status: 'VACANT_CLEAN', is_active: true }],
      totalPrice: 500000,
      paid: 0,
      appliedDeposit: 0,
      remainingBalanceNaN: true,
      complimentaryRequests: []
    });

    const result = await evaluatePreCheckinEligibility(client, 1, 28);
    expectEq(result.payment_ok, false, 'payment_ok — invalid remaining_balance should fail');
    expectHasMissing(result, 'PAYMENT_MISSING');
  });

  // Print summary
  console.log(`\n========================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`========================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
