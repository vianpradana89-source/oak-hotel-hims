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
        const filtered = deposits.filter(d =>
          d.reservation_id === resId &&
          d.property_id === propId &&
          (d.status === 'RECEIVED' || d.status === 'PARTIALLY_USED')
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

      // ── Identity custody query (COUNT) ─────────────────────────────────
      if (sql.includes('identity_custody') && sql.includes('COUNT(*)')) {
        const resId = params[0];
        const propId = params[1];
        const custody = rows.custody || [];
        const filtered = custody.filter(c =>
          c.reservation_id === resId &&
          c.property_id === propId &&
          c.status === 'HELD'
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

      // ── Check-in date query ────────────────────────────────────────────
      if (sql.includes('check_in FROM reservations')) {
        const resId = params[0];
        const res = rows.reservations?.find(r => r.id === resId);
        if (res) return { rows: [{ check_in: res.check_in || '2026-09-15' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
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
