const assert = require('node:assert');
const Module = require('node:module');

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

async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => error && error.code === code);
}

function loadService() {
  const servicePath = require.resolve('../dist/domains/deposits/depositService');
  delete require.cache[servicePath];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent && parent.filename === servicePath && request === '../stayCharges/stayChargesService') {
      return { recalculateReservationFinancials: async () => ({ remaining_balance: 0 }) };
    }
    if (parent && parent.filename === servicePath && request === '../payments/evidenceStorageService') {
      return {
        validateEvidenceUpload: () => ({ valid: true }),
        saveEvidenceFile: async () => ({ storageKey: 'unused' }),
        deleteEvidenceFile: async () => {}
      };
    }
    if (parent && parent.filename === servicePath && request === './depositNumberService') {
      return { generateDepositNumber: async () => 'DEP-OAK-00001' };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(servicePath);
  } finally {
    Module._load = originalLoad;
  }
}

// ── Calculator mock infrastructure ──────────────────────────────────────────
//
// TEST #15 exercises reservationFinancialCalculator.calculateReservationFinancials
// directly. It requires mocking two module-level imports:
//   - ../payments/paymentAllocationService (getEffectivePaymentStateForReservation)
//   - ./reservationBilling (shouldApplyPostedCommercialDiscount)
//
// The calculator pool returns hand-crafted aggregate rows so we can verify
// that DEPOSIT_UNAPPLY is excluded from gross charges but included in the
// applied-deposit net calculation.

function loadCalculator() {
  const calcPath = require.resolve('../dist/domains/reservations/reservationFinancialCalculator');
  delete require.cache[calcPath];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent && parent.filename === calcPath && request === '../payments/paymentAllocationService') {
      return {
        getEffectivePaymentStateForReservation: async () => ({
          totalEffectivePaid: 0,
          canonicalPaymentHistoryExists: true
        })
      };
    }
    if (parent && parent.filename === calcPath && request === './reservationBilling') {
      return {
        shouldApplyPostedCommercialDiscount: () => false
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(calcPath);
  } finally {
    Module._load = originalLoad;
  }
}

/**
 * Build a mock pool for the reservation financial calculator.
 *
 * opts:
 *   - reservationRow: the row returned for the reservation lookup
 *   - grossCharges:   SUM of DEBIT entries (excluding DEPOSIT_UNAPPLY)
 *   - chargeReversals: SUM of CREDIT reversal entries
 *   - roomChargePosted: SUM of ROOM_CHARGE DEBIT non-voided
 *   - commercialDiscounts: SUM of DISCOUNT CREDIT non-voided
 *   - chargeCount:    count of qualifying DEBIT entries
 *   - appliedDeposit: the pre-computed net applied deposit (APPLY - UNAPPLY)
 */
function calculatorPool({
  reservationRow = null,
  grossCharges = 0,
  chargeReversals = 0,
  roomChargePosted = 0,
  commercialDiscounts = 0,
  chargeCount = 0,
  appliedDeposit = 0,
  // OTA collectible (TEST #17)
  grossCollectible = 0,
  collectibleReversals = 0
} = {}) {
  const queries = [];
  const collectibleQueries = [];

  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ text, params });

      // 1. Reservation lookup
      if (text.includes('FROM reservations r') && text.includes('WHERE r.id = $1')) {
        return { rows: [reservationRow], rowCount: reservationRow ? 1 : 0 };
      }

      // 2. Gross charges aggregate (includes DEPOSIT_UNAPPLY exclusion in SQL)
      if (text.includes('AS gross_charges') && text.includes('FROM folio_entries')) {
        return {
          rows: [{
            gross_charges: grossCharges,
            charge_reversals: chargeReversals,
            room_charge_posted: roomChargePosted,
            commercial_discounts: commercialDiscounts,
            charge_count: chargeCount
          }],
          rowCount: 1
        };
      }

      // 3. Applied deposit net (DEPOSIT_APPLY CREDIT - DEPOSIT_UNAPPLY DEBIT)
      if (text.includes('AS applied_deposit') && text.includes('FROM folio_entries')) {
        return { rows: [{ applied_deposit: appliedDeposit }], rowCount: 1 };
      }

      // 4. Fallback folio paid (should not hit when canonicalPaymentHistoryExists=true)
      if (text.includes('AS folio_paid')) {
        return { rows: [{ folio_paid: 0 }], rowCount: 1 };
      }

      // 5. OTA_COLLECT collectible charge (calculateHotelCollectibleBalance step 2)
      if (text.includes('AS gross_collectible') && text.includes('FROM folio_entries')) {
        collectibleQueries.push({ text, params });
        return {
          rows: [{
            gross_collectible: grossCollectible,
            collectible_reversals: collectibleReversals
          }],
          rowCount: 1
        };
      }

      throw new Error(`Calculator pool: Unexpected query: ${text}`);
    },
    release() {}
  };

  const pool = {
    connect: async () => client,
    query: (sql, params) => client.query(sql, params)
  };

  return { pool, queries, collectibleQueries };
}

// ── bookingGroupPaymentService mock infrastructure ──────────────────────────
//
// TEST #16 exercises createBookingGroupPaymentWithAllocations directly. The
// service has two module-level imports that must be mocked:
//   - ./paymentAllocationService (getEffectivePaymentStateForReservation)
//   - ../stayCharges/stayChargesService (recalculateReservationFinancials)
//
// The DB client is mocked per-query so we can assert that the applied-deposit
// SELECT nets DEPOSIT_APPLY and DEPOSIT_UNAPPLY rather than using gross apply.

function loadGroupPaymentService() {
  const servicePath = require.resolve('../dist/domains/payments/bookingGroupPaymentService');
  delete require.cache[servicePath];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent && parent.filename === servicePath && request === './paymentAllocationService') {
      return {
        getEffectivePaymentStateForReservation: async () => ({
          totalEffectivePaid: 0,
          canonicalPaymentHistoryExists: true
        })
      };
    }
    if (parent && parent.filename === servicePath && request === '../stayCharges/stayChargesService') {
      return {
        recalculateReservationFinancials: async () => ({
          amount_paid: 600000,
          applied_deposit: 200000,
          remaining_balance: 200000,
          payment_status: 'PARTIAL'
        })
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(servicePath);
  } finally {
    Module._load = originalLoad;
  }
}

/**
 * Mock PoolClient for createBookingGroupPaymentWithAllocations.
 *
 * opts:
 *   - reservationRow: the row returned by the reservation lock query
 *   - appliedDeposit: value returned by the applied-deposit SELECT
 *                     (must be the NET of DEPOSIT_APPLY − DEPOSIT_UNAPPLY)
 */
function groupPaymentClient({ reservationRow, appliedDeposit = 0 } = {}) {
  const queries = [];
  const appliedDepositQueries = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ text, params });

      // Step 1: lock booking row
      if (text.includes('FROM bookings') && text.includes('FOR UPDATE')) {
        return { rows: [{ id: 90, property_id: 1 }], rowCount: 1 };
      }

      // Step 2: lock target reservations
      if (text.includes('FROM reservations r') && text.includes('FOR UPDATE OF r')) {
        return { rows: [reservationRow], rowCount: 1 };
      }

      // Step 3: applied deposit net (DEPOSIT_APPLY CREDIT − DEPOSIT_UNAPPLY DEBIT)
      if (text.includes('AS applied_deposit') && text.includes('FROM folio_entries')) {
        appliedDepositQueries.push({ text, params });
        return { rows: [{ applied_deposit: appliedDeposit }], rowCount: 1 };
      }

      // Step 6: insert parent payment
      if (text.startsWith('INSERT INTO payment_transactions')) {
        return {
          rows: [{
            id: 500,
            amount: params[2],
            reference_code: params[4] || `GB-PAY-${params[1]}`,
            payment_method: params[3],
            status: 'SUCCESS',
            booking_id: params[1],
            property_id: params[0],
            scope: 'BOOKING_GROUP',
            created_at: new Date()
          }],
          rowCount: 1
        };
      }

      // Step 7: insert allocation
      if (text.startsWith('INSERT INTO payment_allocations')) {
        return { rows: [{ id: 600 }], rowCount: 1 };
      }

      // Step 8: stored-row conservation verification
      if (text.startsWith('WITH parent AS')) {
        return { rows: [{ parent_amount: 600000, total_allocated: 600000, conserved: true }], rowCount: 1 };
      }

      // Step 9: project folio entries
      if (text.startsWith('INSERT INTO folio_entries')) {
        return { rows: [{ id: 700 }], rowCount: 1 };
      }

      throw new Error(`GroupPayment client: unexpected query: ${text}`);
    },
    release() {}
  };

  return { client, queries, appliedDepositQueries };
}

// ── bookingBidGrouping mock infrastructure ──────────────────────────────────
//
// TEST #18 exercises loadBookingReservationLifecycle + presentBidGroupedSales.
// The module has NO module-level runtime dependencies beyond pure helpers
// (transactionTypes, saleLifecycleGrouping), so a plain require is sufficient
// — no Module._load mock needed. The DB client is mocked per-query to capture
// the big lifecycle SQL so we can assert DEPOSIT_UNAPPLY exclusion in-SQL.

function loadBookingBidGrouping() {
  const modPath = require.resolve('../dist/domains/transactions/bookingBidGrouping');
  delete require.cache[modPath];
  return require(modPath);
}

/**
 * Mock client for loadBookingReservationLifecycle.
 *
 * opts:
 *   - lifecycleRow: the single row the big lifecycle SQL returns (pre-CTE
 *     aggregates — as they would come out of PostgreSQL with DEPOSIT_APPLY
 *     600,000 and DEPOSIT_UNAPPLY 200,000 posted).
 */
function lifecycleClient({ lifecycleRow = null } = {}) {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ text, params });
      if (text.includes('FROM folio_entries fe') && text.includes('ORDER BY r.booking_id')) {
        return { rows: lifecycleRow ? [lifecycleRow] : [], rowCount: lifecycleRow ? 1 : 0 };
      }
      throw new Error(`Lifecycle client: unexpected query: ${text}`);
    },
    release() {}
  };
  return { client, queries };
}

// ── index.ts route harness (stay extend / shorten) ─────────────────────────
//
// TEST #19 verifies the ACTUAL other_charges SQL issued by both stay-extension
// and stay-shorten handlers (app.post('/api/reservations/:id/extend|shorten')
// in dist/index.js) excludes DEPOSIT_UNAPPLY. The module is loaded from dist
// without side effects (verified: require returns {app,pool,...} with
// pool.connect/verify still overridable), so the real route handler can be
// invoked directly through the compiled Express router stack.

let indexMod = null;
let harness = null;

function loadIndexModule() {
  if (indexMod) return indexMod;
  const modPath = require.resolve('../dist/index');
  delete require.cache[modPath];
  indexMod = require(modPath);
  return indexMod;
}

function findIndexRouteHandler(pathname) {
  const { app } = loadIndexModule();
  const router = app._router || app.router;
  let found = null;
  (function walk(stack) {
    for (const layer of stack) {
      if (found) return;
      if (layer.route && layer.route.path === pathname && layer.route.methods.post) {
        found = layer.route.stack[0].handle;
        return;
      }
      if (layer.handle && layer.handle._router && layer.handle._router.stack) {
        walk(layer.handle._router.stack);
      }
    }
  })(router.stack);
  return found;
}

/**
 * Invoke one stay-extend/shorten route handler with a fully mocked pool.
 *
 * mode: 'extend' | 'shorten'
 *   - extend : check_in 2026-06-01, old check_out 2026-06-06, new 2026-06-08
 *   - shorten: check_in 2026-06-01, old check_out 2026-06-08, new 2026-06-04
 *
 * The pool stub records every query (via pool.query/pool.connect) so the
 * handler-issued other_charges SQL can be captured and asserted.
 */
function invokeStayRoute(mode) {
  const { app, pool } = loadIndexModule();
  const handler = findIndexRouteHandler(
    mode === 'extend' ? '/api/reservations/:id/extend' : '/api/reservations/:id/shorten'
  );
  if (!handler) throw new Error(`Stay route handler not found for ${mode}`);

  const queries = [];
  const reservationRow = {
    id: 20, booking_id: 90, room_id: 3, room_type_id: 7,
    booked_room_type_id_snapshot: 7,
    check_in: '2026-06-01',
    check_out: mode === 'extend' ? '2026-06-06' : '2026-06-08',
    status: mode === 'extend' ? 'CHECKED_IN' : 'BOOKED',
    total_price: 2000000, subtotal_amount: 2000000,
    discount_amount: 0, amount_paid: 0, applied_deposit: 0,
    is_manual_override: false, ota_source_id: null, booking_type: 'WALKIN'
  };

  const poolQuery = async (sql, params = []) => {
    const text = String(sql);
    queries.push({ text, params });

    // assertPropertyExists
    if (text === 'SELECT id FROM properties WHERE id = $1') {
      return { rows: [{ id: 1 }], rowCount: 1 };
    }
    // assertReservationBelongsToProperty
    if (text.includes('FROM reservations res') && text.includes('LEFT JOIN bookings')) {
      return { rows: [{ id: 20, booking_property_id: 1 }], rowCount: 1 };
    }
    // getCanonicalReservationDto
    if (text.includes('FROM reservations r') && text.includes('LEFT JOIN ota_sources')) {
      return { rows: [{ ...reservationRow, bid: 'BID-TEST-001', booking_id_value: 90, room_type: 'Deluxe King', room_type_name: 'Deluxe King' }], rowCount: 1 };
    }
    // access-control guard fallback (hasAnyEffectivePermission pool.query)
    return { rows: [], rowCount: 0 };
  };

  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ text, params });

      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      // extend: C2C2 initial plain read + lock chain
      if (text === 'SELECT * FROM reservations WHERE id = $1') {
        return { rows: [reservationRow], rowCount: 1 };
      }
      if (text === 'SELECT id FROM rooms WHERE id = $1 FOR UPDATE') {
        return { rows: [{ id: 3 }], rowCount: 1 };
      }
      if (text === 'SELECT * FROM reservations WHERE id = $1 FOR UPDATE') {
        return { rows: [reservationRow], rowCount: 1 };
      }
      // resolveReservationRoomType
      if (text.includes('FROM rooms r') && text.includes('LEFT JOIN room_types rt')) {
        return { rows: [{ room_type_id: 7, room_type: 'Deluxe King' }], rowCount: 1 };
      }
      // extend: no-charge path
      if (text.includes("ORDER BY stay_date DESC LIMIT 1")) {
        return { rows: [{ final_room_rate: 400000, base_rate: 400000 }], rowCount: 1 };
      }
      // extend: overlap checks
      if (text.includes('FROM reservations existing') && text.includes('FOR UPDATE OF existing')) {
        return { rows: [], rowCount: 0 };
      }
      // extend: operational block overlap
      if (text.includes('FROM room_operational_blocks') && text.includes('FOR UPDATE')) {
        return { rows: [], rowCount: 0 };
      }
      // block count (extend capacity check)
      if (text.includes('AS blocked_count')) {
        return { rows: [{ blocked_count: 0 }], rowCount: 1 };
      }
      // canonical availability lock
      if (text.includes('FROM availability_dates') && text.includes('FOR UPDATE')) {
        return { rows: [{ id: 500, room_type_id: 7, reserved_qty: 1, total_rooms: 10 }], rowCount: 1 };
      }
      if (text.includes('UPDATE availability_dates')) {
        return { rows: [{ id: 500 }], rowCount: 1 };
      }
      // idempotent folio lookup
      if (text.includes("FROM folio_entries") && text.includes("source_type = 'STAY_EXTENSION'")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM folio_entries") && text.includes("source_type = 'STAY_SHORTEN'")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith('INSERT INTO folio_entries')) {
        return { rows: [{ id: 800 }], rowCount: 1 };
      }
      if (text.startsWith('UPDATE folio_entries')) {
        return { rows: [{ id: 800 }], rowCount: 1 };
      }
      // extend: nightly upsert; shorten: removed-nights sum + delete
      if (text.includes('FROM reservation_nightly_rates') && text.includes('AS removed_amount')) {
        return { rows: [{ removed_amount: 1200000 }], rowCount: 1 };
      }
      if (text.includes('FROM reservation_nightly_rates') && text.includes('AS total_stay_charge')) {
        return { rows: [{ total_stay_charge: 2000000 }], rowCount: 1 };
      }
      if (text.startsWith('DELETE FROM reservation_nightly_rates')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith('INSERT INTO reservation_nightly_rates')) {
        return { rows: [], rowCount: 1 };
      }
      // THE TARGETED QUERY: other_charges
      if (text.includes('AS other_charges')) {
        return { rows: [{ other_charges: 0 }], rowCount: 1 };
      }
      // payment reconciliation
      if (text.includes('FROM payment_transactions')) {
        return { rows: [{ total_paid: 0 }], rowCount: 1 };
      }
      if (text.includes('FROM reservations WHERE id = $1') && text.includes('applied_deposit')) {
        return { rows: [{ applied_deposit: 0 }], rowCount: 1 };
      }
      if (text.startsWith('UPDATE reservations')) {
        return { rows: [], rowCount: 1 };
      }
      if (text === 'SELECT bid FROM bookings WHERE id = $1') {
        return { rows: [{ bid: 'BID-TEST-001' }], rowCount: 1 };
      }
      if (text.startsWith('INSERT INTO audit_logs')) {
        return { rows: [], rowCount: 1 };
      }
      // projectFolioEntryToTransaction: advisory projection lookup (extend path).
      // Return a CREDIT entry so the projection exits early (returns null) without
      // issuing its transaction-number / INSERT sequence; the handler wraps it in
      // try/catch anyway, but a clean exit keeps the test output warning-free.
      if (text.startsWith('SELECT \n       fe.*') || (text.includes('FROM folio_entries fe') && text.includes('WHERE fe.id = $1'))) {
        return { rows: [{ id: 800, direction: 'CREDIT', entry_type: 'DEPOSIT_APPLY', source_type: 'DEPOSIT', source_id: '10' }], rowCount: 1 };
      }
      throw new Error(`Stay-route client: unexpected query: ${text}`);
    },
    release() {}
  };

  const origPoolQuery = pool.query;
  const origPoolConnect = pool.connect;
  pool.query = poolQuery;
  pool.connect = () => Promise.resolve(client);

  const req = {
    params: { id: '20' },
    method: 'POST',
    path: mode === 'extend' ? '/api/reservations/20/extend' : '/api/reservations/20/shorten',
    originalUrl: mode === 'extend' ? '/api/reservations/20/extend' : '/api/reservations/20/shorten',
    headers: { authorization: 'Bearer ' + 'TEST_TOKEN' },
    body: {
      property_id: 1,
      new_check_out: mode === 'extend' ? '2026-06-08' : '2026-06-04',
      additional_night_rate: mode === 'extend' ? 400000 : undefined
    }
  };
  const res = {
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; }
  };

  return Promise.resolve()
    .then(() => handler(req, res))
    .then(() => {
      pool.query = origPoolQuery;
      pool.connect = origPoolConnect;
      return { status: res.statusCode, body: res.body, queries };
    })
    .catch(err => {
      pool.query = origPoolQuery;
      pool.connect = origPoolConnect;
      throw err;
    });
}

// ── Shared test fixture builder ─────────────────────────────────────────────
//
// DEPOSIT-PURPOSE-PHASE-B: UNAPPLY now targets a specific DEPOSIT_APPLY event
// via `apply_event_id` (mandatory). The mock pool below simulates:
//   - RECEIVED(1000) → APPLY(1000) [id=2, event 2]
// so a full or partial UNAPPLY against event 2 is exercised.
//
// `targetApplyEvent` controls what the service's target-lookup query returns:
//   - undefined/null → rowCount 0 → APPLY_TARGET_NOT_FOUND
//   - row             → matched target, with optional `activeAmount` override
//
// `priorUnapplied` simulates cumulative UNAPPLY already recorded against the
// target APPLY event (per-target cap check).

function unapplyPool({
  targetApplyEvent = undefined,
  targets = undefined,
  priorUnapplied = 0,
  events = undefined,
  replayEvent = undefined,
  depositPurpose = 'ADVANCE_PAYMENT',
  folios = undefined,
  seedFolios = undefined,
  seedPayments = undefined
} = {}) {
  const eventRows = events
    ? [...events]
    : [
        { id: 1, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'RECEIVED', amount: 1000, reversal_of_event_id: null },
        { id: 2, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'APPLY', amount: 1000, folio_entry_id: 70, reversal_of_event_id: null }
      ];

  // Mutable state so a single pool instance can simulate two sequential
  // UNAPPLY calls against the same target APPLY event (per-target cap).
  const state = {
    priorUnapplied,
    targets: targets ?? (targetApplyEvent ? [{ ...targetApplyEvent }] : []),
    replayEvent: replayEvent ?? null,
    paymentTransactions: seedPayments ? [...seedPayments] : [],
    folios: folios ?? (seedFolios ? [...seedFolios] : [])
  };

  const queries = [];
  const DEPOSIT_ROW = {
    id: 10,
    property_id: 1,
    reservation_id: 20,
    deposit_number: 'DEP-OAK-00001',
    original_amount: 1000,
    purpose: depositPurpose,
    scope: 'ROOM_RESERVATION',
    booking_id: 90
  };

  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ text, params });

      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }

      // lockIdempotencyKey / lockReservation advisory locks
      if (text.includes('pg_advisory_xact_lock')) {
        return { rows: [{}], rowCount: 1 };
      }

      // lockReservation
      if (text.includes('FROM reservations r') && text.includes('FOR UPDATE OF r')) {
        return { rows: [{ id: 20, status: 'CONFIRMED', booking_property_id: 1, booking_id: 90 }], rowCount: 1 };
      }

      // scopePreview (non-locking advisory read used by refundDeposit)
      if (text.includes('SELECT scope, booking_id') && text.includes('FROM deposits')) {
        return { rows: [{ scope: DEPOSIT_ROW.scope, booking_id: DEPOSIT_ROW.booking_id, reservation_id: DEPOSIT_ROW.reservation_id }], rowCount: 1 };
      }

      // lockDeposit
      if (text.includes('SELECT * FROM deposits') && text.includes('FOR UPDATE')) {
        return { rows: [DEPOSIT_ROW], rowCount: 1 };
      }

      // findIdempotentEvent — replay support
      if (text.includes('WHERE e.property_id') && text.includes('idempotency_key')) {
        if (state.replayEvent) return { rows: [state.replayEvent], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }

      // reconcileDeposit (single wide JOIN query over the whole ledger)
      // Must be matched BEFORE the generic getEvents handler: it shares the
      // "FROM deposit_events e ... ORDER BY e.id" shape but adds JOIN projections.
      if (text.includes('FROM deposit_events e') && text.includes('AS deposit_property_id')) {
        const rows = eventRows.map(e => {
          const folio = state.folios.find(f => Number(f.id) === Number(e.folio_entry_id || 0));
          const pay = state.paymentTransactions.find(p => Number(p.id) === Number(e.payment_transaction_id || 0));
          const target = e.reversal_of_event_id != null
            ? eventRows.find(x => Number(x.id) === Number(e.reversal_of_event_id))
            : null;
          return {
            ...e,
            deposit_property_id: 1,
            deposit_reservation_id: 20,
            payment_amount: pay ? pay.amount : null,
            payment_type: pay ? pay.transaction_type : null,
            payment_status: pay ? pay.status : null,
            payment_property_id: pay ? pay.property_id : null,
            payment_reservation_id: pay ? pay.reservation_id : null,
            folio_amount: folio ? folio.amount : null,
            folio_type: folio ? folio.entry_type : null,
            folio_direction: folio ? folio.direction : null,
            folio_status: folio ? folio.status : null,
            folio_is_voided: folio ? folio.is_voided : null,
            folio_property_id: folio ? folio.property_id : null,
            folio_reservation_id: folio ? folio.reservation_id : null,
            folio_source_type: folio ? folio.source_type : null,
            folio_source_id: folio ? folio.source_id : null,
            reversed_event_type: target ? target.event_type : null
          };
        });
        return { rows, rowCount: rows.length };
      }

      // getEvents (reused by balance check + status projection + hydrate)
      if (text.includes('FROM deposit_events e') && text.includes('ORDER BY e.id')) {
        return { rows: eventRows.slice(), rowCount: eventRows.length };
      }

      // DEPOSIT-PURPOSE-PHASE-B: target APPLY event lookup (new query)
      // params[0] = applyEventId requested by the caller.
      if (text.includes('FROM deposit_events e') && text.includes("e.event_type = 'APPLY'")) {
        const requestedTargetId = Number(params[0]);
        const match = state.targets.find(t => Number(t.id) === requestedTargetId);
        if (!match) return { rows: [], rowCount: 0 };
        return { rows: [match], rowCount: 1 };
      }

      // DEPOSIT-PURPOSE-PHASE-B: cumulative UNAPPLY against the target APPLY
      if (text.includes('FROM deposit_events') && text.includes('WHERE reversal_of_event_id = $1')) {
        return { rows: [{ total_unapplied: state.priorUnapplied }], rowCount: 1 };
      }

      // INSERT folio_entries (DEPOSIT_UNAPPLY debit)
      if (text.includes('INSERT INTO folio_entries')) {
        const folio = {
          id: 80 + state.folios.length,
          reservation_id: params[0],
          property_id: params[1],
          entry_type: 'DEPOSIT_UNAPPLY',
          amount: params[3],
          direction: 'DEBIT',
          status: 'POSTED',
          is_voided: false,
          source_type: 'DEPOSIT',
          source_id: params[4]
        };
        state.folios.push(folio);
        return { rows: [folio], rowCount: 1 };
      }

      // INSERT INTO payment_transactions (DEPOSIT_REFUND for refundDeposit)
      if (text.includes('INSERT INTO payment_transactions')) {
        const payId = state.paymentTransactions.length + 1;
        const payment = {
          id: payId,
          reservation_id: params[0],
          property_id: params[1],
          transaction_type: 'DEPOSIT_REFUND',
          amount: params[2],
          payment_method: params[3],
          reference_code: params[4],
          status: 'SUCCESS',
          created_by: params[5],
          booking_id: params[6],
          scope: params[7]
        };
        state.paymentTransactions.push(payment);
        return { rows: [payment], rowCount: 1 };
      }

      // INSERT deposit_events — split by event type in the SQL literal
      if (text.includes('INSERT INTO deposit_events')) {
        const newEventId = Math.max(0, ...eventRows.map(e => Number(e.id))) + 1;
        let event;
        if (text.includes("'UNAPPLY'")) {
          // params: [0]=deposit_id [1]=property_id [2]=reservation_id
          //         [3]=amount [4]=folio_entry_id [5]=reversal_of_event_id
          //         [6]=idempotency_key [7]=performed_by [8]=notes
          event = {
            id: newEventId,
            deposit_id: 10,
            property_id: 1,
            reservation_id: 20,
            event_type: 'UNAPPLY',
            amount: params[3],
            folio_entry_id: params[4],
            reversal_of_event_id: params[5],
            payment_transaction_id: null,
            idempotency_key: params[6]
          };
          // Track cumulative UNAPPLY per target for the sequential-cap scenario.
          const targetId = Number(params[5]);
          state.priorUnappliedByTarget = state.priorUnappliedByTarget || {};
          state.priorUnappliedByTarget[targetId] = (state.priorUnappliedByTarget[targetId] || 0) + Number(params[3]);
          state.priorUnapplied = state.priorUnappliedByTarget[targetId] || 0;
        } else if (text.includes("'REFUND'")) {
          // params: [0]=deposit_id [1]=property_id [2]=reservation_id
          //         [3]=amount [4]=payment_transaction_id [5]=idempotency_key
          //         [6]=performed_by [7]=notes
          event = {
            id: newEventId,
            deposit_id: 10,
            property_id: 1,
            reservation_id: 20,
            event_type: 'REFUND',
            amount: params[3],
            folio_entry_id: null,
            reversal_of_event_id: null,
            payment_transaction_id: params[4],
            idempotency_key: params[5]
          };
        } else {
          throw new Error(`Unrecognized event type in INSERT INTO deposit_events: ${text}`);
        }
        eventRows.push(event);
        return { rows: [event], rowCount: 1 };
      }

      // updateStatusProjection
      if (text.startsWith('UPDATE deposits SET status')) {
        return { rows: [], rowCount: 1 };
      }

      // logDepositAudit
      if (text.includes('INSERT INTO audit_logs')) {
        return { rows: [], rowCount: 1 };
      }

      // hydrateDeposit final read
      if (text === 'SELECT * FROM deposits WHERE id = $1') {
        return { rows: [{ ...DEPOSIT_ROW, status: 'PARTIALLY_USED' }], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${text}`);
    },
    release() {}
  };

  // reconcileDeposit accepts a Pool (not a client) and queries it directly;
  // route those queries through the same mock client so state stays coherent.
  const pool = {
    connect: async () => client,
    query: (sql, params) => client.query(sql, params)
  };

  return { pool, queries, eventRows, state };
}

function unapplyInput(overrides = {}) {
  const base = {
    propertyId: 1,
    reservationId: 20,
    depositId: 10,
    applyEventId: 2,
    amount: 1000,
    idempotencyKey: 'unapply-test',
    actor: { userId: '7', name: 'Front Desk', role: 'Front Office' }
  };
  return { ...base, ...overrides };
}

function validTargetApplyEvent(overrides = {}) {
  return {
    id: 2,
    event_type: 'APPLY',
    amount: 1000,
    folio_entry_id: 70,
    folio_status: 'POSTED',
    folio_is_voided: false,
    folio_type: 'DEPOSIT_APPLY',
    folio_direction: 'CREDIT',
    ...overrides
  };
}

function replayEvent(overrides = {}) {
  return {
    id: 3,
    deposit_id: 10,
    property_id: 1,
    reservation_id: 20,
    event_type: 'UNAPPLY',
    amount: 1000,
    folio_entry_id: 80,
    reversal_of_event_id: 2,
    idempotency_key: 'unapply-replay',
    ...overrides
  };
}

function refundInput(overrides = {}) {
  const base = {
    propertyId: 1,
    reservationId: 20,
    depositId: 10,
    amount: 1000,
    paymentMethod: 'CASH',
    idempotencyKey: 'refund-test',
    actor: { userId: '7', name: 'Front Desk', role: 'Front Office' }
  };
  return { ...base, ...overrides };
}

function reverseInput(overrides = {}) {
  const base = {
    propertyId: 1,
    reservationId: 20,
    depositId: 10,
    idempotencyKey: 'reverse-test',
    reason: 'correction: reversal must stay rejected after historical usage',
    actor: { userId: '7', name: 'Front Desk', role: 'Front Office' }
  };
  return { ...base, ...overrides };
}

async function main() {
  const { unapplyDeposit, refundDeposit, reverseDeposit, reconcileDeposit, deriveDepositBalance } = loadService();

  // ── 1. FULL UNAPPLY ───────────────────────────────────────────────────────
  await test('full unapply succeeds and records reversal_of_event_id', async () => {
    const { pool, eventRows } = unapplyPool({ targetApplyEvent: validTargetApplyEvent() });
    const result = await unapplyDeposit(pool, unapplyInput({ amount: 1000, idempotencyKey: 'unapply-full' }));

    assert.strictEqual(result.idempotent_replay, undefined);
    const unappliedEvent = eventRows.find(e => e.event_type === 'UNAPPLY');
    assert.ok(unappliedEvent, 'UNAPPLY event should have been inserted');
    assert.strictEqual(unappliedEvent.reversal_of_event_id, 2, 'UNAPPLY must point at target APPLY event');
    assert.strictEqual(unappliedEvent.amount, 1000);

    // remaining_balance should reflect the full reversal: applied back to 0.
    const balance = deriveDepositBalance(eventRows);
    assert.strictEqual(balance.applied, 0);
    assert.strictEqual(balance.remaining, 1000);
    assert.strictEqual(balance.status, 'RECEIVED');
  });

  // ── 2. PARTIAL UNAPPLY ────────────────────────────────────────────────────
  await test('partial unapply reduces applied and increases remaining by exactly that amount', async () => {
    const { pool, eventRows } = unapplyPool({ targetApplyEvent: validTargetApplyEvent() });
    await unapplyDeposit(pool, unapplyInput({ amount: 400, idempotencyKey: 'unapply-partial' }));

    const balance = deriveDepositBalance(eventRows);
    assert.strictEqual(balance.applied, 600, 'applied should drop from 1000 to 600');
    assert.strictEqual(balance.remaining, 400, 'remaining should rise from 0 to 400');
    assert.strictEqual(balance.status, 'PARTIALLY_USED');

    // The target lookup still sees the same active amount (no prior UNAPPLY
    // in this isolated pool), so a second partial against the same target up
    // to the cap is allowed — but this test only asserts the first one.
    const unappliedEvent = eventRows.find(e => e.event_type === 'UNAPPLY');
    assert.strictEqual(unappliedEvent.reversal_of_event_id, 2);
  });

  // ── 3. OVER-UNAPPLY REJECTED ──────────────────────────────────────────────
  await test('over-unapply is rejected with UNAPPLY_EXCEEDS_APPLIED', async () => {
    // 400 already unapplied against target event 2 (out of its 1000). Only
    // 600 remains active; trying to unapply another 700 must fail.
    const { pool } = unapplyPool({
      targetApplyEvent: validTargetApplyEvent(),
      priorUnapplied: 400,
      events: [
        { id: 1, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'RECEIVED', amount: 1000, reversal_of_event_id: null },
        { id: 2, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'APPLY', amount: 1000, folio_entry_id: 70, reversal_of_event_id: null },
        { id: 3, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'UNAPPLY', amount: 400, folio_entry_id: 80, reversal_of_event_id: 2 }
      ]
    });

    await rejectsCode(
      unapplyDeposit(pool, unapplyInput({ amount: 700, idempotencyKey: 'unapply-over' })),
      'UNAPPLY_EXCEEDS_APPLIED'
    );
  });

  // ── 4. TWO PARTIAL UNAPPLY ON THE SAME TARGET APPLY EVENT ───────────────
  await test('two sequential partial unapplies on the same target stay within the per-target cap', async () => {
    const { pool, eventRows } = unapplyPool({
      targets: [validTargetApplyEvent()],
      events: [
        { id: 1, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'RECEIVED', amount: 1000, reversal_of_event_id: null },
        { id: 2, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'APPLY', amount: 1000, folio_entry_id: 70, reversal_of_event_id: null }
      ]
    });

    // First partial: 400
    await unapplyDeposit(pool, unapplyInput({ amount: 400, applyEventId: 2, idempotencyKey: 'unapply-partial-1' }));
    // Second partial: 300 (total = 700, still ≤ 1000)
    await unapplyDeposit(pool, unapplyInput({ amount: 300, applyEventId: 2, idempotencyKey: 'unapply-partial-2' }));

    const unapplyEvents = eventRows.filter(e => e.event_type === 'UNAPPLY');
    assert.strictEqual(unapplyEvents.length, 2, 'exactly two UNAPPLY events should exist');
    for (const ev of unapplyEvents) {
      assert.strictEqual(ev.reversal_of_event_id, 2, 'both UNAPPLY events must point at target apply event 2');
    }
    assert.strictEqual(unapplyEvents[0].amount, 400);
    assert.strictEqual(unapplyEvents[1].amount, 300);

    const balance = deriveDepositBalance(eventRows);
    assert.strictEqual(balance.applied, 300, 'active applied after two unapplies = 1000 - 700 = 300');
    assert.strictEqual(balance.remaining, 700, 'remaining = total unapplied = 700');
  });

  // ── 5. MULTIPLE APPLY EVENTS, TARGET MUST BE EXPLICIT & DETERMINISTIC ──
  await test('unapply targets only the explicitly selected APPLY event and leaves others intact', async () => {
    const { pool, eventRows } = unapplyPool({
      targets: [
        validTargetApplyEvent({ id: 2, amount: 1000, folio_entry_id: 70 }),
        validTargetApplyEvent({ id: 4, amount: 500, folio_entry_id: 72 })
      ],
      events: [
        { id: 1, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'RECEIVED', amount: 1500, reversal_of_event_id: null },
        { id: 2, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'APPLY', amount: 1000, folio_entry_id: 70, reversal_of_event_id: null },
        { id: 4, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'APPLY', amount: 500, folio_entry_id: 72, reversal_of_event_id: null }
      ]
    });

    // Unapply 300 targeting ONLY event 4.
    const result = await unapplyDeposit(pool, unapplyInput({ amount: 300, applyEventId: 4, idempotencyKey: 'unapply-multi-target' }));

    assert.strictEqual(result.idempotent_replay, undefined);

    // Verify the UNAPPLY event points at target 4, not 2.
    const unappliedEvent = eventRows.find(e => e.event_type === 'UNAPPLY');
    assert.ok(unappliedEvent, 'UNAPPLY event should have been inserted');
    assert.strictEqual(unappliedEvent.reversal_of_event_id, 4, 'UNAPPLY must point at target APPLY event 4');
    assert.strictEqual(unappliedEvent.amount, 300);

    // Verify APPLY event 2 is untouched (no UNAPPLY targeting it).
    const unappliesOn2 = eventRows.filter(e => e.event_type === 'UNAPPLY' && e.reversal_of_event_id === 2);
    assert.strictEqual(unappliesOn2.length, 0, 'APPLY event 2 should have no UNAPPLY events');

    // Balance: applied = 1000 (from event 2) + 500 (event 4) - 300 (unapply on event 4) = 1200
    const balance = deriveDepositBalance(eventRows);
    assert.strictEqual(balance.applied, 1200, 'total applied should be 1200 (1500 - 300)');
    assert.strictEqual(balance.remaining, 300, 'remaining = 300');
  });

  // ── 6. IDEMPOTENT REPLAY FOR UNAPPLY ─────────────────────────────────────
  await test('second identical UNAPPLY request is detected as an idempotent replay and does not create a new event', async () => {
    const { pool, eventRows, state } = unapplyPool({
      targets: [validTargetApplyEvent()],
      events: [
        { id: 1, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'RECEIVED', amount: 1000, reversal_of_event_id: null },
        { id: 2, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'APPLY', amount: 1000, folio_entry_id: 70, reversal_of_event_id: null }
      ]
    });

    const input1 = unapplyInput({ amount: 400, applyEventId: 2, idempotencyKey: 'unapply-replay' });
    const result1 = await unapplyDeposit(pool, input1);
    assert.strictEqual(result1.idempotent_replay, undefined);

    // Seed the replay detection for the second call using the same key.
    state.replayEvent = {
      ...result1.event,
      event_type: 'UNAPPLY',
      reservation_id: 20,
      deposit_id: 10,
      amount: 400,
      reversal_of_event_id: 2,
      idempotency_key: 'unapply-replay'
    };

    const input2 = unapplyInput({ amount: 400, applyEventId: 2, idempotencyKey: 'unapply-replay' });
    const result2 = await unapplyDeposit(pool, input2);

    // The second call is a replay, not a new insert.
    assert.strictEqual(result2.idempotent_replay, true, 'second call should be flagged as idempotent replay');

    // No duplicate UNAPPLY events: still exactly one.
    const unapplyEvents = eventRows.filter(e => e.event_type === 'UNAPPLY');
    assert.strictEqual(unapplyEvents.length, 1, 'only one UNAPPLY event should exist after replay');
    assert.strictEqual(unapplyEvents[0].reversal_of_event_id, 2);
    assert.strictEqual(unapplyEvents[0].amount, 400);
  });

  // ── 7. SAME IDEMPOTENCY KEY, DIFFERENT apply_event_id MUST REJECT ────────
  await test('same idempotency key with a different apply_event_id is rejected with IDEMPOTENCY_KEY_REUSED', async () => {
    const { pool, eventRows, state } = unapplyPool({
      targets: [
        validTargetApplyEvent({ id: 2, amount: 1000, folio_entry_id: 70 }),
        validTargetApplyEvent({ id: 4, amount: 500, folio_entry_id: 72 })
      ],
      events: [
        { id: 1, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'RECEIVED', amount: 1500, reversal_of_event_id: null },
        { id: 2, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'APPLY', amount: 1000, folio_entry_id: 70, reversal_of_event_id: null },
        { id: 4, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'APPLY', amount: 500, folio_entry_id: 72, reversal_of_event_id: null }
      ]
    });

    // Simulate that a prior UNAPPLY with key 'unapply-replay' already exists
    // targeting APPLY event 2, amount 400.
    state.replayEvent = {
      id: 5,
      event_type: 'UNAPPLY',
      reservation_id: 20,
      deposit_id: 10,
      amount: 400,
      reversal_of_event_id: 2,
      idempotency_key: 'unapply-replay'
    };

    // New request reuses the same key but targets a DIFFERENT apply event (4).
    const input = unapplyInput({ amount: 400, applyEventId: 4, idempotencyKey: 'unapply-replay' });
    await rejectsCode(unapplyDeposit(pool, input), 'IDEMPOTENCY_KEY_REUSED');

    // No new UNAPPLY event should have been created.
    const unapplyEvents = eventRows.filter(e => e.event_type === 'UNAPPLY');
    assert.strictEqual(unapplyEvents.length, 0, 'no new UNAPPLY event should exist');
  });

  // ── 9. SECURITY_DEPOSIT UNAPPLY CORRECTION PATH ──────────────────────────
  await test('historical SECURITY_DEPOSIT with a past APPLY can be UNAPPLYed as a correction without purpose-based rejection', async () => {
    const { pool, eventRows } = unapplyPool({
      targets: [validTargetApplyEvent({ id: 2, amount: 1000, folio_entry_id: 70 })],
      events: [
        { id: 1, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'RECEIVED', amount: 1000, reversal_of_event_id: null },
        { id: 2, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'APPLY', amount: 1000, folio_entry_id: 70, reversal_of_event_id: null }
      ],
      depositPurpose: 'SECURITY_DEPOSIT'
    });

    const result = await unapplyDeposit(pool, unapplyInput({ amount: 600, applyEventId: 2, idempotencyKey: 'unapply-secdep-correction' }));

    assert.strictEqual(result.idempotent_replay, undefined);
    const unappliedEvent = eventRows.find(e => e.event_type === 'UNAPPLY');
    assert.ok(unappliedEvent, 'UNAPPLY event should have been inserted');
    assert.strictEqual(unappliedEvent.reversal_of_event_id, 2, 'UNAPPLY must point at target APPLY event');
    assert.strictEqual(unappliedEvent.amount, 600);

    const balance = deriveDepositBalance(eventRows);
    assert.strictEqual(balance.applied, 400, 'active applied should be 1000 - 600 = 400');
    assert.strictEqual(balance.remaining, 600, 'remaining custody should be 600');
  });

  // ── 10. LEGACY NULL PURPOSE BACKWARD COMPATIBILITY ───────────────────────
  await test('legacy deposit with purpose NULL can still be UNAPPLYed', async () => {
    const { pool, eventRows } = unapplyPool({
      targets: [validTargetApplyEvent({ id: 2, amount: 1000, folio_entry_id: 70 })],
      events: [
        { id: 1, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'RECEIVED', amount: 1000, reversal_of_event_id: null },
        { id: 2, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'APPLY', amount: 1000, folio_entry_id: 70, reversal_of_event_id: null }
      ],
      depositPurpose: null
    });

    const result = await unapplyDeposit(pool, unapplyInput({ amount: 500, applyEventId: 2, idempotencyKey: 'unapply-legacy-null-purpose' }));

    assert.strictEqual(result.idempotent_replay, undefined);
    const unappliedEvent = eventRows.find(e => e.event_type === 'UNAPPLY');
    assert.ok(unappliedEvent, 'UNAPPLY event should have been inserted');
    assert.strictEqual(unappliedEvent.reversal_of_event_id, 2, 'UNAPPLY must point at target APPLY event');
    assert.strictEqual(unappliedEvent.amount, 500);

    const balance = deriveDepositBalance(eventRows);
    assert.strictEqual(balance.applied, 500, 'active applied should be 1000 - 500 = 500');
    assert.strictEqual(balance.remaining, 500, 'remaining custody should be 500');
  });

  // ── 11. UNAPPLY → REFUND FROM REMAINING CUSTODY ──────────────────────────
  await test('unapply then refund from remaining custody (canonical refundDeposit path)', async () => {
    const { pool, eventRows, state } = unapplyPool({
      targets: [validTargetApplyEvent({ id: 2, amount: 1000, folio_entry_id: 70 })],
      events: [
        { id: 1, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'RECEIVED', amount: 1000, reversal_of_event_id: null },
        { id: 2, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'APPLY', amount: 1000, folio_entry_id: 70, reversal_of_event_id: null }
      ]
    });

    // Step 1: UNAPPLY 600 against APPLY event 2.
    const unapplyResult = await unapplyDeposit(pool, unapplyInput({ amount: 600, applyEventId: 2, idempotencyKey: 'unapply-then-refund' }));
    assert.strictEqual(unapplyResult.idempotent_replay, undefined);

    // UNAPPLY must NOT create any payment transaction.
    assert.strictEqual(state.paymentTransactions.length, 0, 'UNAPPLY must not create a payment transaction');

    // Step 2: canonical refund of the 600 now sitting in remaining custody.
    const refundResult = await refundDeposit(pool, refundInput({ amount: 600, idempotencyKey: 'refund-after-unapply' }));
    assert.strictEqual(refundResult.idempotent_replay, undefined);

    // Exactly one DEPOSIT_REFUND payment transaction, created by the refund only.
    assert.strictEqual(state.paymentTransactions.length, 1, 'exactly one DEPOSIT_REFUND payment transaction expected');
    const refundPayment = state.paymentTransactions[0];
    assert.strictEqual(refundPayment.transaction_type, 'DEPOSIT_REFUND');
    assert.strictEqual(refundPayment.amount, 600);
    assert.strictEqual(refundPayment.status, 'SUCCESS');

    // Event-level assertions.
    const unapplyEvent = eventRows.find(e => e.event_type === 'UNAPPLY');
    assert.ok(unapplyEvent, 'UNAPPLY event should exist');
    assert.strictEqual(unapplyEvent.reversal_of_event_id, 2, 'UNAPPLY must keep reversal_of_event_id = 2');
    assert.strictEqual(unapplyEvent.payment_transaction_id, null, 'UNAPPLY must not carry a payment_transaction_id');

    const refundEvent = eventRows.find(e => e.event_type === 'REFUND');
    assert.ok(refundEvent, 'REFUND event should exist');
    assert.strictEqual(refundEvent.amount, 600);
    assert.ok(refundEvent.payment_transaction_id !== null && refundEvent.payment_transaction_id !== undefined, 'REFUND must carry a payment_transaction_id');
    assert.strictEqual(refundEvent.payment_transaction_id, refundPayment.id, 'REFUND event must reference the created payment transaction');
    assert.strictEqual(refundEvent.reversal_of_event_id, null, 'REFUND must not carry a reversal_of_event_id');

    // Final balance projection.
    const balance = deriveDepositBalance(eventRows);
    assert.strictEqual(balance.applied, 400, 'applied = 1000 - 600 = 400');
    assert.strictEqual(balance.refunded, 600, 'refunded = 600');
    assert.strictEqual(balance.remaining, 0, 'remaining custody fully refunded');
    assert.strictEqual(balance.status, 'CLOSED', 'derived status must be CLOSED (remaining=0, applied>0)');
  });

  // ── 12. reverseDeposit STAYS REJECTED AFTER HISTORICAL USAGE (UNAPPLY'd) ─
  await test('reverseDeposit is rejected with DEPOSIT_REVERSAL_NOT_ALLOWED_AFTER_USAGE even after a full UNAPPLY', async () => {
    const { pool, eventRows } = unapplyPool({
      targets: [validTargetApplyEvent({ id: 2, amount: 1000, folio_entry_id: 70 })],
      events: [
        { id: 1, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'RECEIVED', amount: 1000, reversal_of_event_id: null },
        { id: 2, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'APPLY', amount: 1000, folio_entry_id: 70, reversal_of_event_id: null }
      ]
    });

    // Full UNAPPLY: applied back to 0, custody fully returned.
    await unapplyDeposit(pool, unapplyInput({ amount: 1000, applyEventId: 2, idempotencyKey: 'unapply-full-reverse' }));

    const preBalance = deriveDepositBalance(eventRows);
    assert.strictEqual(preBalance.applied, 0, 'applied must be fully returned to custody');
    assert.strictEqual(preBalance.remaining, 1000, 'remaining custody must equal the full receipt');

    // UNAPPLY only returns custody — the historical APPLY usage is still in the
    // ledger, so reverseDeposit must stay rejected (not a fresh "unused" receipt).
    await rejectsCode(
      reverseDeposit(pool, reverseInput({ idempotencyKey: 'reverse-after-unapply' })),
      'DEPOSIT_REVERSAL_NOT_ALLOWED_AFTER_USAGE'
    );

    // No REVERSAL event may have been created.
    assert.strictEqual(eventRows.filter(e => e.event_type === 'REVERSAL').length, 0, 'no REVERSAL event allowed');
    // Ledger untouched: still exactly 1 UNAPPLY, no new events.
    assert.strictEqual(eventRows.filter(e => e.event_type === 'UNAPPLY').length, 1, 'UNAPPLY ledger must be unchanged by the rejected reversal');
  });

  // ── 13. RECONCILE UNAPPLY LEDGER CLEAN ────────────────────────────────────
  await test('reconcileDeposit returns no issues for a valid UNAPPLY ledger', async () => {
    const { pool, eventRows, state } = unapplyPool({
      targets: [validTargetApplyEvent({ id: 2, amount: 1000, folio_entry_id: 70 })],
      events: [
        { id: 1, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'RECEIVED', amount: 1000, payment_transaction_id: 50, reversal_of_event_id: null },
        { id: 2, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'APPLY', amount: 1000, folio_entry_id: 70, reversal_of_event_id: null }
      ],
      seedPayments: [
        { id: 50, transaction_type: 'DEPOSIT', amount: 1000, status: 'SUCCESS', property_id: 1, reservation_id: 20 }
      ],
      seedFolios: [
        { id: 70, entry_type: 'DEPOSIT_APPLY', direction: 'CREDIT', status: 'POSTED', is_voided: false, amount: 1000, property_id: 1, reservation_id: 20, source_type: 'DEPOSIT', source_id: '10' }
      ]
    });

    // Create a valid UNAPPLY: 600 against APPLY event 2.
    await unapplyDeposit(pool, unapplyInput({ amount: 600, applyEventId: 2, idempotencyKey: 'unapply-reconcile' }));

    // Run reconcile.
    const issues = await reconcileDeposit(pool, 10);
    assert.deepStrictEqual(issues, [], `reconcile should be clean, got: ${JSON.stringify(issues)}`);
  });

  // ── 14. RECONCILE DEPOSits DETECTS BAD UNAPPLY PROJECTION ────────────────
  await test('reconcileDeposit detects a UNAPPLY whose reversal_of_event_id points to a non-APPLY event', async () => {
    // Seed a ledger where UNAPPLY event (id=3) wrongly points reversal_of_event_id
    // to event id=1 (RECEIVED) instead of an APPLY event.
    const { pool } = unapplyPool({
      events: [
        { id: 1, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'RECEIVED', amount: 1000, payment_transaction_id: 50, reversal_of_event_id: null },
        { id: 2, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'APPLY', amount: 1000, folio_entry_id: 70, reversal_of_event_id: null },
        { id: 3, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'UNAPPLY', amount: 600, folio_entry_id: 80, payment_transaction_id: null, reversal_of_event_id: 1 } // wrong: points to RECEIVED
      ],
      seedPayments: [
        { id: 50, transaction_type: 'DEPOSIT', amount: 1000, status: 'SUCCESS', property_id: 1, reservation_id: 20 }
      ],
      seedFolios: [
        { id: 70, entry_type: 'DEPOSIT_APPLY', direction: 'CREDIT', status: 'POSTED', is_voided: false, amount: 1000, property_id: 1, reservation_id: 20, source_type: 'DEPOSIT', source_id: '10' },
        { id: 80, entry_type: 'DEPOSIT_UNAPPLY', direction: 'DEBIT', status: 'POSTED', is_voided: false, amount: 600, property_id: 1, reservation_id: 20, source_type: 'DEPOSIT', source_id: '10' }
      ]
    });

    const issues = await reconcileDeposit(pool, 10);
    assert.ok(issues.length > 0, 'reconcile must detect the invalid UNAPPLY projection');

    // The specific issue: UNAPPLY_TARGET_INVALID_TYPE — target is not an APPLY event.
    const targetIssue = issues.find(i => i.code === 'UNAPPLY_TARGET_INVALID_TYPE');
    assert.ok(targetIssue, 'expected UNAPPLY_TARGET_INVALID_TYPE issue');
    assert.strictEqual(targetIssue.event_id, 3, 'issue must point at the bad UNAPPLY event');
  });

  // ── 15. CALCULATOR: DEPOSIT_UNAPPLY MUST NOT CREATE NEW CHARGE ───────────
  await test('calculateReservationFinancials treats DEPOSIT_UNAPPLY as reducing applied_deposit, not as a new charge', async () => {
    const { calculateReservationFinancials } = loadCalculator();

    // Reservation row with 2.000.000 total price (fallback when no folio charges,
    // but we DO provide folio charges so the aggregate path is used).
    const resRow = {
      id: 20,
      booking_id: 90,
      property_id: 1,
      booking_property_id: 1,
      status: 'CONFIRMED',
      total_price: 2000000,
      subtotal_amount: 2000000,
      amount_paid: 0,
      payment_responsibility: 'HOTEL_COLLECT'
    };

    // Folio state:
    //   - ROOM_CHARGE DEBIT = 2.000.000 (the only charge)
    //   - DEPOSIT_APLy CREDIT = 600.000
    //   - DEPOSIT_UNAPLY DEBIT = 200.000  ← excluded from gross charges by SQL
    const { pool } = calculatorPool({
      reservationRow: resRow,
      grossCharges: 2000000,          // DEPOSIT_UNAPPLY not included
      chargeReversals: 0,
      roomChargePosted: 2000000,
      commercialDiscounts: 0,
      chargeCount: 1,
      appliedDeposit: 400000          // 600.000 APPLY − 200.000 UNAPPLY
    });

    const result = await calculateReservationFinancials(pool, 20, 1);

    // Net total charges unchanged by the UNAPLY.
    assert.strictEqual(result.total_price, 2000000, 'DEPOSIT_UNAPPLY must not inflate net charges');

    // Applied deposit is net (APPLY − UNAPPLY).
    assert.strictEqual(result.applied_deposit, 400000, 'applied_deposit must be the net after UNAPPLY');

    // Effective settlement = ordinary paid + applied deposit.
    // ordinary paid = 0 (canonical engine returns 0, no folio fallback needed).
    const expectedRemaining = 2000000 - 400000;
    assert.strictEqual(result.remaining_balance, expectedRemaining, 'remaining_balance must rise by exactly the UNAPLY amount vs pre-UNAPPLY state');

    // Outstanding must NOT jump by 400.000 — only by 200.000 (the UNAPLY delta).
    // Pre-UNAPPLY: remaining = 2000000 - 600000 = 1400000
    // Post-UNAPLY: remaining = 2000000 - 400000 = 1600000
    // Delta = +200000, not +400000.
    const preUnapplyRemaining = 2000000 - 600000;
    const delta = result.remaining_balance - preUnapplyRemaining;
    assert.strictEqual(delta, 200000, 'UNAPPLY must increase remaining_balance by exactly its own amount, not double-count');
  });

  // ── 16. GROUP PAYMENT MUST USE NET APPLIED DEPOSIT AFTER UNAPPLY ────────
  await test('createBookingGroupPaymentWithAllocations uses NET applied deposit (APPLY − UNAPPLY) for remaining-due calculation', async () => {
    const { createBookingGroupPaymentWithAllocations } = loadGroupPaymentService();

    // Reservation row: total_price = 1,000,000, ordinary payment = 0
    const resRow = {
      id: 20,
      booking_id: 90,
      property_id: 1,
      total_price: 1000000,
      stay_sequence: 1,
      status: 'CONFIRMED'
    };

    // DEPOSIT_APPLY = 500,000; DEPOSIT_UNAPPLY = 300,000
    // Net applied deposit = 500,000 − 300,000 = 200,000
    // remaining due = 1,000,000 − 0 − 200,000 = 800,000
    // A 600,000 group payment is valid (600,000 ≤ 800,000)
    const { client, appliedDepositQueries } = groupPaymentClient({
      reservationRow: resRow,
      appliedDeposit: 200000  // NET value, not gross 500,000
    });

    const result = await createBookingGroupPaymentWithAllocations(client, {
      propertyId: 1,
      bookingId: 90,
      amount: 600000,
      paymentMethod: 'CASH',
      referenceCode: 'GB-PAY-TEST-001',
      createdBy: 'front-desk',
      reservationIds: [20]
    });

    // The applied-deposit query must have been issued with the correct reservation/property
    assert.strictEqual(appliedDepositQueries.length, 1, 'exactly one applied-deposit query expected');
    const adQuery = appliedDepositQueries[0];
    assert.deepStrictEqual(adQuery.params, [20, 1], 'applied-deposit query must target reservation_id=20, property_id=1');

    // The issued SQL must genuinely NET DEPOSIT_UNAPPLY against DEPOSIT_APPLY:
    //   - selects ONLY entry_type IN ('DEPOSIT_APPLY','DEPOSIT_UNAPPLY')
    //   - flips DEPOSIT_UNAPPLY to negative in the SUM
    const adSql = adQuery.text;
    assert.ok(adSql.includes("'DEPOSIT_APPLY', 'DEPOSIT_UNAPPLY'"),
      'applied-deposit query must scope to DEPOSIT_APPLY and DEPOSIT_UNAPPLY entries');
    assert.ok(adSql.includes("WHEN entry_type = 'DEPOSIT_UNAPPLY' AND direction = 'DEBIT' THEN -amount"),
      'applied-deposit query must negate DEPOSIT_UNAPPLY (net semantics, not gross apply-only)');
    assert.ok(adSql.includes("status = 'POSTED'") && adSql.includes('is_voided = FALSE'),
      'applied-deposit query must only aggregate live POSTED non-voided entries');

    // The returned applied-deposit value must be the NET (200,000), not gross (500,000).
    // Proof: remaining due = 1,000,000 − 0 − 200,000 = 800,000. A 600,000 group
    // payment is valid (600,000 ≤ 800,000), so no OVERPAYMENT_NOT_ALLOWED was
    // thrown. Had the service used the gross 500,000 apply, remaining due would be
    // 500,000 and this same call would have thrown OVERPAYMENT_NOT_ALLOWED.

    // Parent payment was created with the full 600,000
    assert.strictEqual(result.parentPayment.id, 500);
    assert.strictEqual(result.parentPayment.amount, 600000);
    assert.strictEqual(result.parentPayment.bookingId, 90);

    // Allocation went to reservation 20
    assert.strictEqual(result.allocations.length, 1);
    assert.strictEqual(result.allocations[0].reservationId, 20);
    assert.strictEqual(result.allocations[0].allocatedAmount, 600000);

    // Recalculated reservations reflect the post-payment state
    assert.strictEqual(result.recalculatedReservations.length, 1);
    assert.strictEqual(result.recalculatedReservations[0].reservationId, 20);
    assert.strictEqual(result.recalculatedReservations[0].appliedDeposit, 200000,
      'recalculated applied_deposit must be the NET value (200,000), not gross 500,000');
    assert.strictEqual(result.recalculatedReservations[0].remainingBalance, 200000,
      'remaining after 600k payment = 800k due − 600k paid = 200k');
  });

  // ── 17. OTA COLLECTIBLE: DEPOSIT_UNAPPLY MUST NOT INFLATE COLLECTIBLE CHARGE ─
  await test('calculateHotelCollectibleBalance (OTA_COLLECT) excludes DEPOSIT_UNAPPLY from collectible gross and does not double-count', async () => {
    const { calculateHotelCollectibleBalance } = loadCalculator();

    // OTA / HOTEL_COLLECT scenario per contract:
    //   - OTA_COLLECT: original ROOM_CHARGE settled outside the hotel.
    //     A non-ROOM_CHARGE collectible charge of 2,000,000 exists
    //     (e.g. STAY_EXTENSION, manually posted by hotel).
    //   - DEPOSIT_APPLY  = 600,000 (CREDIT)
    //   - DEPOSIT_UNAPPLY = 200,000 (DEBIT)
    //   - net applied deposit = 600,000 − 200,000 = 400,000
    const resRow = {
      id: 20,
      booking_id: 90,
      property_id: 1,
      booking_property_id: 1,
      status: 'CONFIRMED',
      total_price: 2000000,
      subtotal_amount: 2000000,
      amount_paid: 0,
      payment_responsibility: 'OTA_COLLECT'
    };

    const { pool, collectibleQueries } = calculatorPool({
      reservationRow: resRow,
      // canonical aggregate: gross charges exclude DEPOSIT_UNAPPLY
      grossCharges: 2000000,
      chargeReversals: 0,
      roomChargePosted: 2000000,
      commercialDiscounts: 0,
      chargeCount: 1,
      // net applied deposit after UNAPPLY
      appliedDeposit: 400000,
      // OTA collectible: non-ROOM_CHARGE gross stays flat; DEPOSIT_UNAPPLY
      // must NOT be added here as a new collectible DEBIT charge.
      grossCollectible: 2000000,
      collectibleReversals: 0
    });

    const result = await calculateHotelCollectibleBalance(pool, 20, 1, 'OTA_COLLECT');

    // Responsibility classification
    assert.strictEqual(result.payment_responsibility, 'OTA_COLLECT');

    // The OTA collectible query must have been issued with the right params
    assert.strictEqual(collectibleQueries.length, 1, 'exactly one OTA collectible query expected');
    assert.deepStrictEqual(collectibleQueries[0].params, [20], 'collectible query must target reservation_id=20');

    // The issued SQL must genuinely EXCLUDE DEPOSIT_UNAPPLY from collectible
    // DEBIT charges (netting would silently inflate the total by +200,000).
    const sql = collectibleQueries[0].text;
    assert.ok(
      sql.includes("entry_type NOT IN ('PAYMENT_VOID', 'PAYMENT_REVERSAL', 'REFUND_DEBIT', 'DEPOSIT_UNAPPLY')"),
      'OTA collectible query must exclude DEPOSIT_UNAPPLY from collectible DEBIT charges'
    );

    // Gross collectible stays at 2,000,000 — DEPOSIT_UNAPPLY did not inflate it.
    assert.strictEqual(result.hotel_collectible_total, 2000000,
      'DEPOSIT_UNAPPLY must not inflate gross collectible (no +200,000 double-count)');

    // Net applied deposit = 400,000 (600,000 APPLY − 200,000 UNAPPLY).
    assert.strictEqual(result.canonical_applied_deposit, 400000,
      'applied deposit must be the NET value after UNAPPLY');

    // Effective settlement = ordinary paid (0) + net applied (400,000) = 400,000.
    // Remaining = 2,000,000 − 400,000 = 1,600,000.
    const expectedRemaining = 2000000 - 400000;
    assert.strictEqual(result.hotel_collectible_remaining_balance, expectedRemaining,
      'remaining must equal collectible total minus NET applied deposit');

    // No double-count: pre-UNAPPLY remaining would be 2,000,000 − 600,000 = 1,400,000.
    // The delta caused by the UNAPPLY must be exactly +200,000, not +400,000.
    const preUnapplyRemaining = 2000000 - 600000;
    const delta = result.hotel_collectible_remaining_balance - preUnapplyRemaining;
    assert.strictEqual(delta, 200000,
      'UNAPPLY must raise outstanding by exactly its own amount (200,000), not double-count (+400,000)');
  });

  // ── 18. BOOKING BID GROUPING: DEPOSIT_UNAPPLY IS NOT A NEW CHARGE; APPLIED STAYS NET ─
  await test('bookingBidGrouping lifecycle SQL excludes DEPOSIT_UNAPPLY from charges/collectible and keeps applied deposit NET', async () => {
    const { loadBookingReservationLifecycle, presentBidGroupedSales } = loadBookingBidGrouping();

    // The single row the big lifecycle SQL returns for reservation 20.
    // DEPOSIT_APPLY 600,000 and DEPOSIT_UNAPPLY 200,000 both POSTED:
    //   - net_charges CTE excludes DEPOSIT_UNAPPLY  → gross_charges stays 2,000,000
    //   - deposit_apply CTE nets                    → applied_deposit = 600,000 − 200,000 = 400,000
    //   - hotel_collectible CTE excludes DEPOSIT_UNAPPLY → gross_collectible stays 2,000,000
    const lifecycleRow = {
      property_id: 1,
      booking_id: 90,
      booking_bid: 'BID-TEST-001',
      payment_responsibility: 'HOTEL_COLLECT',
      reservation_id: 20,
      reservation_status: 'CONFIRMED',
      stay_status: 'RESERVED',
      fallback_total_price: 2000000,
      subtotal_amount: 2000000,
      persisted_amount_paid: 0,
      gross_charges: 2000000,       // DEPOSIT_UNAPPLY already excluded by the CTE
      charge_reversals: 0,
      room_charge_posted: 2000000,
      commercial_discounts: 0,
      charge_count: 1,
      applied_deposit: 400000,      // NET: 600,000 APPLY − 200,000 UNAPPLY
      direct_paid: 0,
      direct_source_cnt: 0,
      direct_history_cnt: 0,
      allocated_paid: 0,
      alloc_effective_cnt: 0,
      alloc_history_cnt: 0,
      gross_collectible: 2000000,   // DEPOSIT_UNAPPLY already excluded by the CTE
      collectible_reversals: 0,
      nightly_sum: 0,
      folio_paid: 0
    };

    const { client, queries } = lifecycleClient({ lifecycleRow });

    const lifecycle = await loadBookingReservationLifecycle(client, 1, [20]);
    assert.strictEqual(lifecycle.length, 1, 'exactly one lifecycle row expected');
    const mapped = lifecycle[0];

    // applied deposit must be the NET value after UNAPPLY, not the gross 600,000.
    assert.strictEqual(mapped.applied_deposit, 400000, 'applied_deposit must be NET after UNAPPLY');

    // canonical effective paid = ordinary (0) + net applied (400,000).
    assert.strictEqual(mapped.canonical_effective_paid, 400000,
      'canonical_effective_paid must use the NET applied deposit, not the gross');

    // HOTEL_COLLECT remaining = 2,000,000 − 400,000 = 1,600,000.
    // If UNAPPLY were wrongly treated as a new DEBIT charge, gross would be
    // 2,200,000 and remaining would inflate to 1,800,000 — assert that does NOT happen.
    assert.strictEqual(mapped.canonical_remaining_balance, 1600000,
      'UNAPPLY must not inflate remaining (no new charge, no double-count)');

    // The issued SQL must genuinely exclude DEPOSIT_UNAPPLY in BOTH the
    // net-charges CTE and the hotel-collectible CTE, and net it in deposit_apply.
    const sql = queries[0].text;
    assert.ok(sql.includes("'REFUND_DEBIT', 'DEPOSIT_UNAPPLY'"),
      'lifecycle SQL must exclude DEPOSIT_UNAPPLY from DEBIT aggregates');
    const exclusionCount = sql.split("'REFUND_DEBIT', 'DEPOSIT_UNAPPLY'").length - 1;
    assert.ok(exclusionCount >= 2,
      'DEPOSIT_UNAPPLY must be excluded from both the charge and collectible CTEs');
    assert.ok(sql.includes("WHEN fe.entry_type = 'DEPOSIT_UNAPPLY' AND fe.direction = 'DEBIT' THEN -fe.amount"),
      'deposit_apply CTE must net DEPOSIT_UNAPPLY as a negative amount');

    // Feed the canonical lifecycle into the actual BID grouping presenter.
    // UNAPPLY is not a separate SALE transaction, so it must not raise the group gross.
    const presented = [
      {
        id: 7001,
        transaction_type: 'SALE',
        source_type: 'ROOM_CHARGE',
        booking_bid: 'BID-TEST-001',
        booking_id: 90,
        property_id: 1,
        reservation_id: 20,
        party_name: 'John Doe',
        amount: 2000000,
        net_amount: 2000000,
        operational_sheet: 'PROSES'
      }
    ];

    const grouped = presentBidGroupedSales(presented, { lifecycleReservations: lifecycle });
    assert.strictEqual(grouped.length, 1, 'exactly one BID group expected');
    const bidGroup = grouped[0].booking_bid_group;
    assert.strictEqual(bidGroup.bid, 'BID-TEST-001');
    assert.strictEqual(bidGroup.gross, 2000000,
      'group gross must stay 2,000,000 (UNAPPLY is not a new charge)');

    const child = bidGroup.children.find(c => c.reservation_id === 20);
    assert.ok(child, 'reservation 20 child must be present');
    assert.strictEqual(child.remaining, 1600000,
      'child remaining must equal the canonical NET remaining (no double-count)');
    assert.strictEqual(bidGroup.remaining, 1600000,
      'group remaining must equal the canonical NET remaining (no double-count)');
  });

  // ── 19. STAY EXTEND/SHORTEN: other_charges MUST EXCLUDE DEPOSIT_UNAPPLY ──
  await test('stay extend and stay shorten other_charges SQL both exclude DEPOSIT_UNAPPLY (actual handler SQL)', async () => {
    // Fixture values chosen so a wrong UNAPPLY treatment changes the total:
    //   folio has ROOM_CHARGE-family charges totaling 2,000,000 (already posted),
    //   DEPOSIT_APPLY 600,000, DEPOSIT_UNAPPLY 200,000 → net applied 400,000.
    // The mock returns other_charges = 0 (i.e., PostgreSQL itself did the
    // aggregation over an entry set where UNAPPLY is filtered out). The test
    // asserts on the ACTUAL SQL text issued by the handlers: if DEPOSIT_UNAPPLY
    // were not excluded, UNAPPLY 200,000 would enter other_charges, inflate
    // subtotal/total_price (+200,000) and remaining balance — double-counting
    // against the net applied deposit already reduced by the same 200,000.
    for (const mode of ['extend', 'shorten']) {
      const outcome = await invokeStayRoute(mode);

      // Sanity: the handler must have run to completion (not an early reject).
      assert.strictEqual(outcome.status, 200, `${mode}: handler must complete successfully, got ${outcome.status} ${JSON.stringify(outcome.body)}`);
      assert.ok(outcome.body && outcome.body.status === 'SUCCESS', `${mode}: response must be SUCCESS`);

      // Capture the ACTUAL other_charges SQL issued by this handler.
      const otherChargesQueries = outcome.queries.filter(q => q.text.includes('AS other_charges'));
      assert.strictEqual(otherChargesQueries.length, 1, `${mode}: exactly one other_charges query expected, got ${otherChargesQueries.length}`);
      const sql = otherChargesQueries[0].text;

      // The DEBIT filter must exclude DEPOSIT_UNAPPLY (not counted as a charge).
      assert.ok(
        sql.includes("AND entry_type NOT IN ('ROOM_CHARGE', 'STAY_EXTENSION', 'DEPOSIT_UNAPPLY')"),
        `${mode}: other_charges entry_type NOT IN(...) must contain 'DEPOSIT_UNAPPLY'`
      );
      assert.ok(
        sql.includes("AND source_type NOT IN ('ROOM_CHARGE', 'STAY_EXTENSION')"),
        `${mode}: other_charges must scope to non-room DEBIT entries`
      );
      assert.strictEqual(otherChargesQueries[0].params[0], 20, `${mode}: other_charges must target reservation 20`);

      // UNAPPLY must NOT appear as a counted charge anywhere in the query:
      // it only appears inside the exclusion list, never in the SUM path.
      const occurrences = sql.split('DEPOSIT_UNAPPLY').length - 1;
      assert.strictEqual(occurrences, 1, `${mode}: DEPOSIT_UNAPPLY may only appear once — inside the NOT IN exclusion list`);

      // Financial no-inflation proof via the persisted UPDATE reservations:
      // total_price = subtotal + other_charges(0) − discount. With other_charges
      // wrongly = 200,000 (UNAPPLY counted), total would be 2,200,000 instead.
      const update = outcome.queries.find(q => q.text.startsWith('UPDATE reservations') && q.text.includes('total_price'));
      assert.ok(update, `${mode}: reservation UPDATE must have been issued`);
      assert.deepStrictEqual(update.params.slice(1, 3), [2000000, 2000000],
        `${mode}: subtotal and total_price must both stay 2,000,000 (UNAPPLY did not inflate other_charges)`);
    }
  });

  console.log(`RESULT: PASS=${passed} FAIL=${failed} TOTAL=${passed + failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  console.log(`RESULT: PASS=${passed} FAIL=${failed + 1} TOTAL=${passed + failed + 1}`);
  process.exitCode = 1;
});
