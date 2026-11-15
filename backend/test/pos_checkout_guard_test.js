/**
 * POS ↔ CHECKOUT GUARD CONCURRENCY TEST (Kerangka)
 *
 * DB safety guard: TEST_DATABASE_URL eksplisit → 127.0.0.1:15434 /
 * oak_minibar_test / minibar_test, password wajib, query parameter ditolak.
 * Tanpa dotenv/fallback, tanpa mencetak URL/password.
 *
 * Run:
 *   TEST_DATABASE_URL=postgres://USER:PASS@127.0.0.1:15434/oak_minibar_test \
 *   node backend/test/pos_checkout_guard_test.js
 */
'use strict';

// ─── 1. DB SAFETY GUARD ─────────────────────────────────────────────────────
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !testUrl.trim()) {
  console.error('SAFETY: TEST_DATABASE_URL tidak di-set.');
  process.exit(1);
}

const ALLOWED_HOST = '127.0.0.1', ALLOWED_PORT = 15434;
const ALLOWED_DATABASE = 'oak_minibar_test', ALLOWED_USER = 'minibar_test';

let target;
try {
  const u = new URL(testUrl.trim());
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error('protocol wajib postgres');
  if (u.hostname !== ALLOWED_HOST) throw new Error(`host wajib ${ALLOWED_HOST}`);
  if (u.searchParams.size > 0) throw new Error('query parameter ditolak');
  if (!u.port || !/^\d+$/.test(u.port)) throw new Error('port eksplisit wajib');
  const port = Number(u.port);
  if (port !== ALLOWED_PORT) throw new Error(`port wajib ${ALLOWED_PORT}`);
  const user = u.username ? decodeURIComponent(u.username) : '';
  const password = u.password ? decodeURIComponent(u.password) : '';
  const database = u.pathname ? decodeURIComponent(u.pathname.replace(/^\//, '')) : '';
  if (!user) throw new Error('user wajib');
  if (!password) throw new Error('password wajib');
  if (user !== ALLOWED_USER) throw new Error(`user wajib ${ALLOWED_USER}`);
  if (database !== ALLOWED_DATABASE) throw new Error(`database wajib ${ALLOWED_DATABASE}`);
  target = { host: u.hostname, port, user, database, password };
  console.log(`[POS-CHECKOUT GUARD] Target: ${database} (user: ${user}, port: ${port})`);
} catch (e) {
  console.error(`SAFETY: TEST_DATABASE_URL tidak valid — ${e.message}`);
  process.exit(1);
}

// ─── 2. Pool eksplisit + verifikasi ─────────────────────────────────────────
const { Pool } = require('pg');
const pool = new Pool({
  host: target.host, port: target.port, user: target.user,
  password: target.password, database: target.database,
  max: 10, connectionTimeoutMillis: 10000,
});

function verifyPoolOptions() {
  const o = pool.options || {};
  for (const [val, field] of [[o.host, 'host'], [o.port, 'port'], [o.user, 'user'], [o.database, 'database']]) {
    const expected = target[field];
    if (val !== expected) throw new Error(`SAFETY: pool.options.${field}=${val}, expected ${expected}`);
  }
}

async function verifyDatabase() {
  const c = await pool.connect();
  try {
    const r = await c.query('SELECT current_database() AS db, current_user AS usr');
    if (r.rows[0].db !== target.database || r.rows[0].usr !== target.user)
      throw new Error(`SAFETY: db=${r.rows[0].db} usr=${r.rows[0].usr} tidak cocok`);
    console.log(`[POS-CHECKOUT GUARD] Verifikasi DB OK`);
  } finally { c.release(); }
}

// ─── 3. Import factory dari dist ───────────────────────────────────────────
const { createReservationCheckoutHandler } = require('../dist/domains/reservations/reservationCheckoutHandler');
const { createPosOrderCreateHandler } = require('../dist/domains/pos/posOrderCreateHandler');
const { recalculateReservationFinancials, calculateHotelCollectibleBalance } = require('../dist/domains/stayCharges/stayChargesService');
const { isFeatureEnabled } = require('../dist/domains/features/featureService');
const { getPropertyHousekeepingSettings, ensureCheckoutRoomCleaningTask } = require('../dist/domains/housekeeping/housekeepingService');
const { getHeldIdentityCustodyForCheckout } = require('../dist/domains/identity/identityCustodyService');
const { releaseReservationInventoryForCheckout } = require('../dist/domains/reservations/roomMoveService');
const { enumerateHotelDates, normalizeHotelDate } = require('../dist/utils/hotelDate');
const {
  getCanonicalReservationDto,
  buildBookingChildStatusSummary,
  deriveBookingLifecycleStatus,
  buildBookingCompletionAuditPayload,
  withReservationHotelDates,
} = require('../dist/domains/reservations/reservationLifecycleHelpers');

// ─── 3b. Verify production dependencies are functions before use ─────────
function assertDep(name, fn) {
  if (typeof fn !== 'function') {
    console.error(`SAFETY: dependency ${name} is not a function (got ${typeof fn})`);
    process.exit(1);
  }
}
assertDep('recalculateReservationFinancials', recalculateReservationFinancials);
assertDep('calculateHotelCollectibleBalance', calculateHotelCollectibleBalance);
assertDep('isFeatureEnabled', isFeatureEnabled);
assertDep('getPropertyHousekeepingSettings', getPropertyHousekeepingSettings);
assertDep('ensureCheckoutRoomCleaningTask', ensureCheckoutRoomCleaningTask);
assertDep('getHeldIdentityCustodyForCheckout', getHeldIdentityCustodyForCheckout);
assertDep('releaseReservationInventoryForCheckout', releaseReservationInventoryForCheckout);
assertDep('getCanonicalReservationDto', getCanonicalReservationDto);
assertDep('buildBookingChildStatusSummary', buildBookingChildStatusSummary);
assertDep('deriveBookingLifecycleStatus', deriveBookingLifecycleStatus);
assertDep('buildBookingCompletionAuditPayload', buildBookingCompletionAuditPayload);
assertDep('withReservationHotelDates', withReservationHotelDates);
assertDep('createReservationCheckoutHandler', createReservationCheckoutHandler);
assertDep('createPosOrderCreateHandler', createPosOrderCreateHandler);

// ─── 4. Counter + tracking fixture ──���──────────────────────────────────────
let passed = 0, failed = 0;
const tracked = {
  properties: [], roomCategories: [], roomTypes: [], rooms: [],
  bookings: [], reservations: [], posOrders: [], posOrderItems: [],
  posMenuItems: [], posMenuCategories: [],
  folioEntries: [], paymentTransactions: [],
  posSettlements: [], transactions: [],
  housekeepingTasks: [], transactionDailySequences: [],
  auditLogs: [],
  availabilityDates: [],
};

function pass(d) { passed++; console.log(`  ✓ ${d}`); }
function fail(d, e) { failed++; console.error(`  ✗ ${d}`); if (e) console.error(`    ${e.message || e}`); }

// ─── 5. Fixture helpers ──────────────────────────────────────────────────────
const crypto = require('crypto');
const fixturePrefix = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 3); // 3 chars, e.g. "A3F"
let propertySeq = 0;
let chainSeq = 0;

function nextPropertyCode() {
  if (propertySeq >= 46656) throw new Error('SAFETY: property counter overflow (>= 36^3)');
  const c = (++propertySeq).toString(36).toUpperCase().padStart(3, '0');
  const code = `${fixturePrefix}${c}`;
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error(`SAFETY: property_code invalid: ${code}`);
  return code;
}

function nextChainTag() {
  if (chainSeq >= 46656) throw new Error('SAFETY: chain counter overflow (>= 36^3)');
  return (++chainSeq).toString(36).toUpperCase().padStart(3, '0');
}

/**
 * Create an isolated test property.
 * property_code: 3-char crypto prefix + 3-char base36 counter = 6 chars.
 * Returns { propertyId, propertyCode }.
 */
async function createFixtureProperty(client) {
  const code = nextPropertyCode();
  const r = await client.query(
    `INSERT INTO properties (name, property_code, timezone, currency_code, is_active)
     VALUES ($1, $2, 'Asia/Jakarta', 'IDR', TRUE) RETURNING id`,
    [`Pos Guard Prop ${code}`, code]
  );
  const propertyId = r.rows[0].id;
  tracked.properties.push(propertyId);
  return { propertyId, propertyCode: code };
}

/**
 * Create a full reservation chain:
 *   room_categories → room_types → rooms → bookings → reservations (CHECKED_IN)
 *
 * Uses plain INSERT (no ON CONFLICT); every ID is tracked immediately.
 * BIGINT booking id returned as string. BID is immutable (trigger-enforced).
 * Returns all IDs + bid.
 */
async function createReservationChain(client, propertyId) {
  const tag = nextChainTag();

  // 1. Room category
  const catR = await client.query(
    `INSERT INTO room_categories (property_id, code, name)
     VALUES ($1, $2, 'Guard Test Cat') RETURNING id`,
    [propertyId, `GC${tag}`]
  );
  const roomCategoryId = catR.rows[0].id;
  tracked.roomCategories.push(roomCategoryId);

  // 2. Room type — unique display name: "Guard Test Type <uuid>"
  const roomTypeName = `Guard Test Type ${crypto.randomUUID()}`;
  const rtR = await client.query(
    `INSERT INTO room_types (property_id, room_category_id, code, name, capacity, max_adults, max_children, is_active, display_order, base_rate)
     VALUES ($1, $2, $3, $4, 2, 2, 0, TRUE, 1, 500000) RETURNING id`,
    [propertyId, roomCategoryId, `RT${tag}`, roomTypeName]
  );
  const roomTypeId = rtR.rows[0].id;
  tracked.roomTypes.push(roomTypeId);

  // 3. Physical room (status OCCUPIED_CLEAN — valid per housekeeping domain)
  const rmR = await client.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, status, is_active)
     VALUES ($1, $2, $3, 'OCCUPIED_CLEAN', TRUE) RETURNING id`,
    [propertyId, roomTypeId, `GT-${tag}`]
  );
  const roomId = rmR.rows[0].id;
  tracked.rooms.push(roomId);

  // 4. Booking — BID generated before INSERT, never mutated (trigger enforces)
  const bid = `${fixturePrefix}-B${tag}`;
  const bkR = await client.query(
    `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
     VALUES ($1, $2, 'Guard Test Guest', 'ACTIVE') RETURNING id`,
    [propertyId, bid]
  );
  const bookingId = String(bkR.rows[0].id); // BIGINT → string
  tracked.bookings.push(bkR.rows[0].id);

  // 5. Reservation (CHECKED_IN + IN_HOUSE; applied_deposit defaults to 0 in schema)
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const resR = await client.query(
    `INSERT INTO reservations (
       booking_id, room_id, status, stay_status, guest_name, stay_sequence,
       check_in, check_out, total_price, amount_paid, remaining_balance, payment_status,
       booked_room_type_id_snapshot
     ) VALUES ($1, $2, 'CHECKED_IN', 'IN_HOUSE', 'Guard Test Guest', 1,
               $3, $4, 500000, 0, 500000, 'UNPAID', $5)
     RETURNING id`,
    [bookingId, roomId, today, tomorrow, roomTypeId]
  );
  const reservationId = resR.rows[0].id;
  tracked.reservations.push(reservationId);

  return {
    propertyId,
    roomCategoryId,
    roomTypeId,
    roomTypeName,   // display name — used by inventory fixture
    roomId,
    bid,
    bookingId,      // string (BIGINT-safe)
    reservationId,
    checkIn: today,
    checkOut: tomorrow,
  };
}

/**
 * Create a fully-settled reservation financial state:
 *   folio_entries (ROOM_CHARGE, DEBIT, 500000, POSTED)
 *   payment_transactions (ROOM_RESERVATION, PAYMENT, SUCCESS, CASH, 500000)
 *
 * Canonical balance derivation:
 *   room charge folio = 500000
 *   payment total     = 500000
 *   remaining_balance = 0 (settled)
 *
 * Uses the same property/booking/reservation/room fixture IDs.
 * Returns { folioEntryId, paymentTransactionId }.
 */
async function createSettledReservationFinancials(client, { propertyId, bookingId, reservationId }) {
  const tag = nextChainTag();

  // 1. Folio entry: ROOM_CHARGE DEBIT 500000, status POSTED
  const feR = await client.query(
    `INSERT INTO folio_entries (reservation_id, property_id, entry_type, description, amount, direction, status)
     VALUES ($1, $2, 'ROOM_CHARGE', 'Guard Test Room Charge', 500000, 'DEBIT', 'POSTED')
     RETURNING id`,
    [reservationId, propertyId]
  );
  const folioEntryId = feR.rows[0].id;
  tracked.folioEntries.push(folioEntryId);

  // 2. Payment transaction: ROOM_RESERVATION PAYMENT SUCCESS CASH 500000
  const ptR = await client.query(
    `INSERT INTO payment_transactions (
       property_id, reservation_id, booking_id, scope,
       transaction_type, amount, payment_method, reference_code, status
     ) VALUES ($1, $2, $3, 'ROOM_RESERVATION', 'PAYMENT', 500000, 'CASH', $4, 'SUCCESS')
     RETURNING id`,
    [propertyId, reservationId, bookingId, `PCT-PAY-${tag}`]
  );
  const paymentTransactionId = ptR.rows[0].id;
  tracked.paymentTransactions.push(paymentTransactionId);

  return { folioEntryId, paymentTransactionId };
}

/**
 * Create an active POS menu item under a category in the same property.
 *   pos_menu_categories (property_id, name) — required by schema
 *   pos_menu_items (property_id, category_id, item_code, name, price, is_active)
 *
 * Price: 25000.
 * Returns { posMenuCategoryId, posMenuItemId }.
 */
async function createPosMenuFixture(client, propertyId) {
  const tag = nextChainTag();

  // 1. Category
  const catR = await client.query(
    `INSERT INTO pos_menu_categories (property_id, name)
     VALUES ($1, $2) RETURNING id`,
    [propertyId, `Guard Menu ${tag}`]
  );
  const posMenuCategoryId = catR.rows[0].id;
  tracked.posMenuCategories.push(posMenuCategoryId);

  // 2. Item
  const itemR = await client.query(
    `INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, is_active)
     VALUES ($1, $2, $3, 'Guard Menu Item', 25000, TRUE) RETURNING id`,
    [propertyId, posMenuCategoryId, `PCT-MI-${tag}`]
  );
  const posMenuItemId = itemR.rows[0].id;
  tracked.posMenuItems.push(posMenuItemId);

  return { posMenuCategoryId, posMenuItemId };
}

/**
 * S3-only inventory fixture.
 *
 * Inserts one availability_dates row per occupied night in [checkIn, checkOut):
 *   reserved_qty = 1  (exactly enough for one CHECKED_IN guest)
 *   total_rooms  = 10
 *
 * Contract satisfied by releaseReservationInventoryForCheckout:
 *   lockCanonicalAvailabilityRows requires exactly one row per
 *   (room_type_id, date) with reserved_qty >= 1 for each date in the range.
 *
  * Uses enumerateHotelDates (production) so multi-night fixtures are correct.
  * room_type display name comes from chain.roomTypeName (unique per run,
  * set by createReservationChain).  Rejects empty/null name — no fallback.
  *
  * All returned IDs are tracked immediately for cleanup + residue verification.
  * Returns { availabilityDateIds: number[] }.
  */
async function createInventoryFixtureForS3(client, chain) {
  const roomTypeName = chain.roomTypeName;
  if (typeof roomTypeName !== 'string' || roomTypeName.trim() === '') {
    throw new Error('SAFETY: chain.roomTypeName is empty — cannot create availability_dates rows');
  }
  const dates = enumerateHotelDates(chain.checkIn, chain.checkOut);
  if (dates.length === 0) {
    throw new Error('SAFETY: enumerateHotelDates returned no dates — check_in >= check_out');
  }
  const ids = [];
  for (const date of dates) {
    const r = await client.query(
      `INSERT INTO availability_dates (room_type, date, total_rooms, reserved_qty, room_type_id)
       VALUES ($1, $2::date, 10, 1, $3) RETURNING id`,
      [roomTypeName, date, chain.roomTypeId]
    );
    const id = Number(r.rows[0].id);
    tracked.availabilityDates.push(id);
    ids.push(id);
  }
  return { availabilityDateIds: ids };
}

// ─── 6. Cleanup + residue verification ──────────────────────────────────────
/**
 * Collect runtime artifact IDs that a handler may have created but not
 * tracked in `tracked` (e.g. pos_orders created by createPosOrderCreateHandler
 * that failed mid-way).  Called INSIDE the cleanup transaction.
 *
 * Uses String(id) for BIGINT-safe comparison. No "NOT IN" SQL — dedup in JS.
 */
async function collectUntrackedArtifacts(client) {
  if (tracked.properties.length === 0) return;
  for (const pid of tracked.properties) {
    // pos_orders
    const po = await client.query(
      `SELECT id FROM pos_orders WHERE property_id = $1`, [pid]
    );
    for (const row of po.rows) tracked.posOrders.push(String(row.id));

    // pos_order_items (via fixture pos_orders)
    if (tracked.posOrders.length) {
      const poi = await client.query(
        `SELECT id FROM pos_order_items WHERE order_id = ANY($1)`, [tracked.posOrders]
      );
      for (const row of poi.rows) tracked.posOrderItems.push(String(row.id));
    }

    // pos_settlements
    const ps = await client.query(
      `SELECT id FROM pos_settlements WHERE property_id = $1`, [pid]
    );
    for (const row of ps.rows) tracked.posSettlements.push(String(row.id));

    // transactions
    const tx = await client.query(
      `SELECT id FROM transactions WHERE property_id = $1`, [pid]
    );
    for (const row of tx.rows) tracked.transactions.push(String(row.id));

    // housekeeping_tasks
    const hk = await client.query(
      `SELECT id FROM housekeeping_tasks WHERE property_id = $1`, [pid]
    );
    for (const row of hk.rows) tracked.housekeepingTasks.push(String(row.id));

    // payment_transactions
    const pt = await client.query(
      `SELECT id FROM payment_transactions WHERE property_id = $1`, [pid]
    );
    for (const row of pt.rows) tracked.paymentTransactions.push(String(row.id));

    // folio_entries
    const fe = await client.query(
      `SELECT id FROM folio_entries WHERE property_id = $1`, [pid]
    );
    for (const row of fe.rows) tracked.folioEntries.push(String(row.id));

    // audit_logs
    const al = await client.query(
      `SELECT audit_id AS id FROM audit_logs WHERE property_id = $1`, [pid]
    );
    for (const row of al.rows) tracked.auditLogs.push(String(row.id));
  }
  // availability_dates is scoped by room_type_id, not property_id
  if (tracked.roomTypes.length) {
    const ad = await client.query(
      `SELECT id FROM availability_dates WHERE room_type_id = ANY($1)`, [tracked.roomTypes]
    );
    for (const row of ad.rows) {
      const sid = String(row.id);
      if (!tracked.availabilityDates.includes(sid)) tracked.availabilityDates.push(sid);
    }
  }
}

/**
 * Collect + delete all tracked/fixture artifact IDs in a single transaction.
 * Order: children → parents (FK-safe).
 * On any error → ROLLBACK + re-throw.  Errors are NOT swallowed.
 * Must be called with a dedicated client (cleanupClient).
 */
async function cleanupFixtures(cleanupClient) {
  await cleanupClient.query('BEGIN');
  try {
    // Collect untracked artifacts FIRST (inside the transaction, so we see
    // the same snapshot that will be deleted).
    await collectUntrackedArtifacts(cleanupClient);

    // Phase 1: leaf / grandchild
    if (tracked.posSettlements.length) {
      await cleanupClient.query('DELETE FROM pos_settlements WHERE id = ANY($1)', [tracked.posSettlements]);
    }
    if (tracked.posOrderItems.length) {
      await cleanupClient.query('DELETE FROM pos_order_items WHERE id = ANY($1)', [tracked.posOrderItems]);
    }
    if (tracked.posOrders.length) {
      await cleanupClient.query('DELETE FROM pos_orders WHERE id = ANY($1)', [tracked.posOrders]);
    }
    if (tracked.transactions.length) {
      await cleanupClient.query('DELETE FROM transactions WHERE id = ANY($1)', [tracked.transactions]);
    }
    if (tracked.housekeepingTasks.length) {
      await cleanupClient.query('DELETE FROM housekeeping_tasks WHERE id = ANY($1)', [tracked.housekeepingTasks]);
    }
    if (tracked.folioEntries.length) {
      await cleanupClient.query('DELETE FROM folio_entries WHERE id = ANY($1)', [tracked.folioEntries]);
    }
    if (tracked.paymentTransactions.length) {
      await cleanupClient.query('DELETE FROM payment_transactions WHERE id = ANY($1)', [tracked.paymentTransactions]);
    }
    if (tracked.auditLogs.length) {
      await cleanupClient.query('DELETE FROM audit_logs WHERE audit_id = ANY($1)', [tracked.auditLogs]);
    }
    if (tracked.availabilityDates.length) {
      await cleanupClient.query('DELETE FROM availability_dates WHERE id = ANY($1)', [tracked.availabilityDates]);
    }

    // Phase 2: mid-level
    if (tracked.reservations.length) {
      await cleanupClient.query('DELETE FROM reservations WHERE id = ANY($1)', [tracked.reservations]);
    }
    if (tracked.bookings.length) {
      await cleanupClient.query('DELETE FROM bookings WHERE id = ANY($1)', [tracked.bookings]);
    }

    // Phase 3: room hierarchy
    if (tracked.rooms.length) {
      await cleanupClient.query('DELETE FROM rooms WHERE id = ANY($1)', [tracked.rooms]);
    }
    if (tracked.roomTypes.length) {
      await cleanupClient.query('DELETE FROM room_types WHERE id = ANY($1)', [tracked.roomTypes]);
    }
    if (tracked.roomCategories.length) {
      await cleanupClient.query('DELETE FROM room_categories WHERE id = ANY($1)', [tracked.roomCategories]);
    }

    // Phase 4: POS menu
    if (tracked.posMenuItems.length) {
      await cleanupClient.query('DELETE FROM pos_menu_items WHERE id = ANY($1)', [tracked.posMenuItems]);
    }
    if (tracked.posMenuCategories.length) {
      await cleanupClient.query('DELETE FROM pos_menu_categories WHERE id = ANY($1)', [tracked.posMenuCategories]);
    }

    // Phase 5: transaction_daily_sequences (composite PK property_id+date_key)
    for (const pid of tracked.properties) {
      await cleanupClient.query('DELETE FROM transaction_daily_sequences WHERE property_id = $1', [pid]);
    }

    // Phase 6: root
    if (tracked.properties.length) {
      await cleanupClient.query('DELETE FROM property_housekeeping_settings WHERE property_id = ANY($1::int[])', [tracked.properties]);
      await cleanupClient.query('DELETE FROM properties WHERE id = ANY($1)', [tracked.properties]);
    }

    await cleanupClient.query('COMMIT');
  } catch (err) {
    await cleanupClient.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * Verify no residue remains for the fixture property IDs.
 * Uses SELECT COUNT(*) for every table.
 * Called separately (and still attempted) even if cleanupFixtures fails.
 * Returns array of residue descriptions (empty = clean).
 */
async function verifyNoResidue(verifyClient) {
  const residue = [];
  if (tracked.properties.length === 0) return residue;

  const propPids = tracked.properties;

  // Property-scoped checks
  const propChecks = [
    ['pos_settlements', 'property_id', propPids],
    ['pos_orders', 'property_id', propPids],
    ['transactions', 'property_id', propPids],
    ['housekeeping_tasks', 'property_id', propPids],
    ['folio_entries', 'property_id', propPids],
    ['payment_transactions', 'property_id', propPids],
    ['audit_logs', 'property_id', propPids],
    ['bookings', 'property_id', propPids],
    ['rooms', 'property_id', propPids],
    ['room_types', 'property_id', propPids],
    ['room_categories', 'property_id', propPids],
    ['pos_menu_items', 'property_id', propPids],
    ['pos_menu_categories', 'property_id', propPids],
    ['transaction_daily_sequences', 'property_id', propPids],
    ['property_housekeeping_settings', 'property_id', propPids],
  ];

  // Order-scoped checks
  if (tracked.posOrders.length) {
    propChecks.push(['pos_order_items', 'order_id', tracked.posOrders]);
  }
  // availability_dates is scoped by room_type_id
  if (tracked.roomTypes.length) {
    propChecks.push(['availability_dates', 'room_type_id', tracked.roomTypes]);
  }

  // Reservation + room-scoped checks (catch linkage changes)
  if (tracked.reservations.length) {
    propChecks.push(['reservations', 'id', tracked.reservations]);
  }
  if (tracked.rooms.length) {
    propChecks.push(['reservations', 'room_id', tracked.rooms]);
  }
  if (tracked.folioEntries.length) {
    // folio_entries also referenced by reservation — check by reservation linkage
    propChecks.push(['folio_entries', 'reservation_id', tracked.reservations]);
    // Also check by ID to catch any orphaned folio entries
    propChecks.push(['folio_entries', 'id', tracked.folioEntries]);
  }

  // Root check
  propChecks.push(['properties', 'id', propPids]);

  for (const [table, col, param] of propChecks) {
    const r = await verifyClient.query(
      `SELECT COUNT(*) AS count FROM ${table} WHERE ${col} = ANY($1)`,
      [param]
    );
    const n = Number(r.rows[0].count);
    if (n > 0) {
      residue.push(`${table} (${col} = ANY fixture): ${n} row(s) remain`);
    }
  }

  return residue;
}

// ─── 7. Production lifecycle helpers (imported from dist) ───────────────────
// getCanonicalReservationDto, buildBookingChildStatusSummary,
// deriveBookingLifecycleStatus, buildBookingCompletionAuditPayload,
// withReservationHotelDates — all imported from
// dist/domains/reservations/reservationLifecycleHelpers (see section 3).
// No local adapters; the exact production implementations are used.

// ─── 8. Test-assertion helpers for checkout handler ────────────────────────
function assertPropertyId(body) {
  const pid = body?.property_id;
  if (!Number.isInteger(pid) || pid <= 0) {
    throw Object.assign(new Error('property_id invalid'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  }
  return pid;
}

async function assertPropertyExists(pool, propertyId) {
  const c = await pool.connect();
  try {
    const r = await c.query('SELECT 1 FROM properties WHERE id = $1', [propertyId]);
    if (!r.rows.length) throw Object.assign(new Error('property not found'), { statusCode: 404, code: 'PROPERTY_NOT_FOUND' });
  } finally {
    c.release();
  }
}

async function assertReservationBelongsToProperty(pool, reservationId, propertyId) {
  const c = await pool.connect();
  try {
    const r = await c.query(
      `SELECT 1 FROM reservations r JOIN bookings b ON b.id = r.booking_id WHERE r.id = $1 AND b.property_id = $2`,
      [reservationId, propertyId]
    );
    if (!r.rows.length) throw Object.assign(new Error('reservation not in property'), { statusCode: 404, code: 'RESERVATION_NOT_FOUND' });
  } finally {
    c.release();
  }
}

function noopBroadcast() { /* no-op in tests */ }

// ─── 8b. Barrier & Observer Helpers ─────────────────────────────────────────
//
// createBarrier():
//   - acquired promise: resolved by signalLockAcquired() (idempotent)
//   - gate promise:     resolved by release() (idempotent)
//   - waitUntilAcquired(deadlineMs): bounded wait on acquired
//   - hold():           blocks handler until release()
//
// createBarredConnect({ pool, barrier, lockTimeoutMs, statementTimeoutMs }):
//   Returns { connect, release, getPid }.
//   Per-connect rawClient (no shared mutable state).
//   PID captured BEFORE handing wrapped client to the handler.
//   barrier may be null (waiter side): queries still execute, PID available, no hold.
//   Hold fires exactly ONCE, after RESERVATIONS FOR UPDATE succeeds.
//   release(true) destroys session state so pool consumers don't inherit timeouts.
//
// observeBlocking(observerClient, waiterPid, blockerPid, { timeoutMs }):
//   Polls pg_blocking_pids(waiterPid) on a separate client.
//   SQL errors THROW (not swallowed). Observation timeout = test failure.

// ── Default timeout values (ms) ─────────────────────────────────────────────
const BARRIER_ACQUIRE_DEADLINE_MS  = 5_000;   // max wait for signalLockAcquired
const OBSERVER_DEADLINE_MS         = 3_000;   // observeBlocking polling deadline
const OBSERVER_QUERY_TIMEOUT_MS    = 2_000;   // per-query observer timeout
const OBSERVER_POLL_INTERVAL_MS    = 100;     // ms between observer polls
const LOCK_TIMEOUT_MS              = 8_000;   // PostgreSQL lock_timeout (ms)
const STATEMENT_TIMEOUT_MS         = 20_000;  // PostgreSQL statement_timeout (ms)

/** Validate that a number is positive and finite. Throws otherwise. */
function assertPositiveFiniteInt(name, value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value}`);
  }
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite, got: ${value}`);
  }
}

/**
 * Create a two-promise concurrency barrier.
 *
 *   acquired  — resolved by signalLockAcquired() (idempotent)
 *   gate      — resolved by release() (idempotent, call in finally)
 *
 * @returns {{
 *   signalLockAcquired: () => void,
 *   waitUntilAcquired: (deadlineMs?: number) => Promise<boolean>,
 *   hold: () => Promise<void>,
 *   release: () => void,
 *   isReleased: () => boolean,
 * }}
 */
function createBarrier() {
  let acquiredResolve = null;
  const acquiredPromise = new Promise((resolve) => { acquiredResolve = resolve; });
  let acquiredSettled = false;

  let gateResolve = null;
  const gatePromise = new Promise((resolve) => { gateResolve = resolve; });
  let gateSettled = false;

  return {
    /**
     * Resolve the acquired promise. Idempotent — second call is a no-op.
     * Called by the wrapped client after a FOR UPDATE lock succeeds.
     */
    signalLockAcquired() {
      if (!acquiredSettled) {
        acquiredSettled = true;
        acquiredResolve();
      }
    },

    /**
     * Wait until signalLockAcquired() has been called.
     * @param {number} [deadlineMs] — bounded wait; default BARRIER_ACQUIRE_DEADLINE_MS
     * @returns {Promise<boolean>} true if acquired within deadline, false on timeout
     */
    waitUntilAcquired(deadlineMs) {
      assertPositiveFiniteInt('deadlineMs', deadlineMs ?? BARRIER_ACQUIRE_DEADLINE_MS);
      const deadline = Date.now() + (deadlineMs ?? BARRIER_ACQUIRE_DEADLINE_MS);
      return new Promise((resolve) => {
        if (acquiredSettled) { resolve(true); return; }
        const timer = setTimeout(() => resolve(false), deadline - Date.now());
        acquiredPromise.then(() => { clearTimeout(timer); resolve(true); });
      });
    },

    /**
     * Returns the gate promise. Handler awaits this to hold until release().
     * Multiple concurrent calls return the same promise.
     */
    hold() {
      return gatePromise;
    },

    /**
     * Resolve the gate. Idempotent. Must be called from a finally block.
     */
    release() {
      if (!gateSettled) {
        gateSettled = true;
        gateResolve();
      }
    },

    /** True once release() has been called. */
    isReleased() {
      return gateSettled;
    },
  };
}

/**
 * Create a connect/release pair that wraps a real PoolClient with barrier
 * interception on FOR UPDATE lock queries.
 *
 * The wrapped client delegates ALL SQL to the underlying PostgreSQL client.
 * After a FOR UPDATE query on RESERVATIONS succeeds (exactly once per
 * connect), the wrapper signals the barrier and awaits hold().
 *
 * @param {object} opts
 * @param {import('pg').Pool}  opts.pool
 * @param {object|null}        opts.barrier          — null for waiter side (no hold)
 * @param {number}            [opts.lockTimeoutMs]
 * @param {number}            [opts.statementTimeoutMs]
 * @returns {{
 *   connect: () => Promise<object>,
 *   release: (wrapped: object) => void,
 *   getPid: () => number,
 *   getConnected: (deadlineMs?: number) => Promise<number>,
 * }}
 */
function createBarredConnect(opts) {
  assertPositiveFiniteInt('pool', opts.pool != null ? 1 : 0); // just a guard; actual check below
  if (!opts.pool || typeof opts.pool.connect !== 'function') {
    throw new Error('createBarredConnect: pool must be a pg Pool with connect()');
  }
  const lockTimeoutMs = opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  const statementTimeoutMs = opts.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS;
  assertPositiveFiniteInt('lockTimeoutMs', lockTimeoutMs);
  assertPositiveFiniteInt('statementTimeoutMs', statementTimeoutMs);
  // barrier may be null (waiter side)

  // Per-instance state — single connect() call per instance (handler lifecycle)
  let rawClient = null;
  let rawPid = null;
  let holdFired = false;
  let released = false;
  let connectCalled = false;
  let connectSucceeded = false;
  let connectError = null;
  let connectedResolve = null;
  const connectedPromise = new Promise((resolve) => { connectedResolve = resolve; });

  /**
   * Detect whether the SQL text targets RESERVATIONS with FOR UPDATE.
   * Uses explicit predicate: `SELECT ... FROM reservations ... FOR UPDATE`.
   * Accepts both string SQL and { text: '...' } SQL objects.
   */
  function isReservationsForUpdate(textOrSql) {
    let sqlText;
    if (typeof textOrSql === 'string') {
      sqlText = textOrSql;
    } else if (textOrSql && typeof textOrSql.text === 'string') {
      sqlText = textOrSql.text;
    } else {
      return false;
    }
    const norm = sqlText.toUpperCase().replace(/\s+/g, ' ');
    return /FROM\s+RESERVATIONS\b.*FOR\s+UPDATE/.test(norm);
  }

  /**
   * Connect a real client, apply session timeouts, capture PID, return wrapped client.
   * PID is captured BEFORE the wrapped client is returned to the handler.
   * All setup wrapped in try/catch: failure signals connected with { ok:false, error }.
   * Second connect() on the same instance throws.
   */
  async function connect() {
    if (connectCalled) {
      throw new Error('createBarredConnect: connect() called more than once on the same instance');
    }
    connectCalled = true;

    let raw;
    try {
      raw = await opts.pool.connect();
    } catch (err) {
      // pool.connect failed — no client to release
      connectError = err;
      connectedResolve({ ok: false, pid: null, error: err });
      throw err;
    }
    rawClient = raw;

    try {
      // Apply session-level timeouts (must be explicit ms values)
      await raw.query(`SET lock_timeout = ${lockTimeoutMs}`);
      await raw.query(`SET statement_timeout = ${statementTimeoutMs}`);

      // Capture pg_backend_pid BEFORE handing the client to the handler
      const pidRes = await raw.query('SELECT pg_backend_pid() AS pid');
      if (!pidRes.rows.length) {
        throw new Error('createBarredConnect: pg_backend_pid returned no rows');
      }
      const pid = Number(pidRes.rows[0].pid);
      assertPositiveFiniteInt('pg_backend_pid', pid);
      rawPid = pid;

      // Build the wrapped client the handler receives
      const wrapped = {
        query: async (textOrSql, params) => {
          const result = await raw.query(textOrSql, params);

          // Fire hold exactly once, after RESERVATIONS FOR UPDATE succeeds
          if (!holdFired && opts.barrier && isReservationsForUpdate(textOrSql)) {
            holdFired = true;
            opts.barrier.signalLockAcquired();
            await opts.barrier.hold();
          }

          return result;
        },
        // Expose underlying client for advanced access (not used by handlers)
        client: raw,
      };

      connectSucceeded = true;
      // Signal that the client is ready (PID available, timeouts set)
      connectedResolve({ ok: true, pid, error: null });
      return wrapped;
    } catch (err) {
      // Setup failed — release the client (destroy session state), record error
      let releaseErr = null;
      try {
        raw.release(true);
      } catch (relErr) {
        releaseErr = relErr;
      }
      rawClient = null;
      rawPid = null;
      connectError = err;
      connectedResolve({ ok: false, pid: null, error: err });

      // If release also failed, log both errors; original error is primary
      if (releaseErr) {
        console.error(`createBarredConnect: setup error: ${err.message}; release error: ${releaseErr.message}`);
      }
      throw err;
    }
  }

  /**
   * Release the underlying client. Use release(true) to destroy session
   * settings so the next pool consumer doesn't inherit lock_timeout etc.
   * rawPid remains available via getPid() after release.
   * Release error → FAIL + exitCode=1 (not swallowed).
   * Idempotent: second and later calls are no-ops.
   */
  function release(wrapped) {
    if (released) return;
    released = true;
    if (rawClient) {
      try {
        rawClient.release(true);
      } catch (err) {
        fail('createBarredConnect release', err);
        process.exitCode = 1;
      }
      rawClient = null;
    }
  }

  /**
   * Returns the captured pg_backend_pid.
   * Available even after release() (PID is a snapshot, not a live handle).
   * Throws if connect() has not yet completed successfully.
   */
  function getPid() {
    if (rawPid == null) {
      throw new Error('createBarredConnect: PID not yet available (connect not completed)');
    }
    return rawPid;
  }

  /**
   * Await until connect() has finished setup (timeouts applied, PID captured).
   * - Success → resolve PID
   * - Failure → throw the original setup error
   * - Deadline exceeded → throw
   *
   * @param {number} [deadlineMs] — JavaScript deadline (default BARRIER_ACQUIRE_DEADLINE_MS)
   * @returns {Promise<number>} resolved PID
   */
  function getConnected(deadlineMs) {
    const dl = deadlineMs ?? BARRIER_ACQUIRE_DEADLINE_MS;
    assertPositiveFiniteInt('deadlineMs', dl);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`createBarredConnect: getConnected deadline (${dl}ms) exceeded`));
      }, dl);

      connectedPromise.then((result) => {
        clearTimeout(timer);
        if (result.ok) {
          resolve(result.pid);
        } else {
          reject(result.error);
        }
      });
    });
  }

  return { connect, release, getPid, getConnected };
}

/**
 * Observe blocking via pg_blocking_pids on a separate observer client.
 *
 * The caller must have already set statement_timeout = 2000 on observerClient
 * so each individual query is bounded at the PostgreSQL level.  No JS
 * Promise.race is used — the query is awaited to completion or error.
 *
 * Polls `SELECT pg_blocking_pids($1)` until blockerPid appears in the result.
 * SQL errors THROW (not swallowed). Observation timeout means the test FAILS.
 *
 * @param {import('pg').PoolClient} observerClient — dedicated client (test pool),
 *   must have statement_timeout ≤ 2000ms set by caller
 * @param {number} waiterPid — pg_backend_pid of the blocked side
 * @param {number} blockerPid — pg_backend_pid of the lock holder
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] — overall polling deadline (default 3000)
 * @returns {Promise<void>} resolves when blocking observed; throws on timeout or SQL error
 */
async function observeBlocking(observerClient, waiterPid, blockerPid, opts = {}) {
  assertPositiveFiniteInt('waiterPid', waiterPid);
  assertPositiveFiniteInt('blockerPid', blockerPid);
  if (waiterPid === blockerPid) {
    throw new Error('observeBlocking: waiterPid and blockerPid must be different');
  }
  const timeoutMs = opts.timeoutMs ?? OBSERVER_DEADLINE_MS;
  assertPositiveFiniteInt('timeoutMs', timeoutMs);

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // Statement-level PostgreSQL timeout (set on observerClient by caller)
    // bounds each individual query.  No JS timer needed here.
    let res;
    try {
      res = await observerClient.query(
        `SELECT pg_blocking_pids($1) AS blockers`,
        [waiterPid]
      );
    } catch (sqlErr) {
      // SQL error is a real failure — do not swallow
      throw new Error(`observeBlocking: SQL error: ${sqlErr.message}`);
    }

    const blockers = res.rows[0]?.blockers ?? [];
    const contains = blockers.some((pidStr) => Number(pidStr) === blockerPid);
    if (contains) return; // observed — success

    await new Promise((r) => setTimeout(r, OBSERVER_POLL_INTERVAL_MS));
  }

  // Deadline exceeded: this is a test failure
  throw new Error(
    `observeBlocking: blockerPid ${blockerPid} not observed blocking waiterPid ${waiterPid} within ${timeoutMs}ms`
  );
}

/**
 * Get pg_backend_pid for a live PoolClient.
 * Throws if the query fails or returns no rows.
 */
async function getBackendPid(client) {
  const res = await client.query('SELECT pg_backend_pid() AS pid');
  if (!res.rows.length) throw new Error('getBackendPid: no rows returned');
  const pid = Number(res.rows[0].pid);
  assertPositiveFiniteInt('pg_backend_pid', pid);
  return pid;
}

// ─── 9. Snapshot helper ─────────────────────────────────────────────────────
async function takeSnapshot(client, { propertyId, reservationId, roomId, bookingId, roomTypeId, checkIn, checkOut }) {
  const snap = {};

  // Reservation state
  const res = await client.query(
    `SELECT status, stay_status, checked_out_at FROM reservations WHERE id = $1`, [reservationId]
  );
  snap.reservation = res.rows[0] || null;

  // Booking state
  const bk = await client.query(
    `SELECT booking_status FROM bookings WHERE id = $1`, [bookingId]
  );
  snap.booking = bk.rows[0] || null;

  // Room state
  const rm = await client.query(
    `SELECT status FROM rooms WHERE id = $1`, [roomId]
  );
  snap.room = rm.rows[0] || null;

  // Row counts by property
  const counts = {};
  for (const [key, col, tbl] of [
    ['posOrders', 'property_id', 'pos_orders'],
    ['posSettlements', 'property_id', 'pos_settlements'],
    ['transactions', 'property_id', 'transactions'],
    ['paymentTransactions', 'property_id', 'payment_transactions'],
    ['folioEntries', 'property_id', 'folio_entries'],
    ['auditLogs', 'property_id', 'audit_logs'],
    ['housekeepingTasks', 'property_id', 'housekeeping_tasks'],
  ]) {
    const cr = await client.query(
      `SELECT COUNT(*) AS n FROM ${tbl} WHERE ${col} = $1`, [propertyId]
    );
    counts[key] = Number(cr.rows[0].n);
  }
  // pos_order_items scoped by fixture pos_orders
  const poIds = await client.query('SELECT id FROM pos_orders WHERE property_id = $1', [propertyId]);
  if (poIds.rows.length) {
    const ocr = await client.query(
      `SELECT COUNT(*) AS n FROM pos_order_items WHERE order_id = ANY($1)`, [poIds.rows.map((r) => r.id)]
    );
    counts.posOrderItems = Number(ocr.rows[0].n);
  } else {
    counts.posOrderItems = 0;
  }
  snap.counts = counts;

  // Inventory state: availability_dates for fixture room type within fixture stay range
  // NOTE: S1 does NOT insert availability_dates rows, so this snapshot proves
  // no new inventory rows appeared — it does NOT prove qty release.
  const inv = await client.query(
    `SELECT date, total_rooms, reserved_qty
     FROM availability_dates
     WHERE room_type_id = $1 AND date >= $2 AND date < $3
     ORDER BY date`,
    [roomTypeId, checkIn, checkOut]
  );
  snap.inventoryRows = inv.rows;

  return snap;
}

function snapshotEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── MAIN — S1: settled room + POS OPEN order blocks checkout ─────────────
(async () => {
  let identityVerified = false;
  let cleanupClient;
  let verifyClient;
  let httpServer;
  let s2Barrier;
  let s2CreateWrapped;
  let s2CheckoutWrapped;
  let s2ObserverClient;
  let s2HttpServer;
  let s2CreatePromise;
  let s2CheckoutPromise;
  let s3Barrier;
  let s3CheckoutWrapped;
  let s3CreateWrapped;
  let s3ObserverClient;
  let s3HttpServer;
  let s3CheckoutPromise;
  let s3CreatePromise;
  let s3InventorySnapshot;

  try {
    verifyPoolOptions();
    await verifyDatabase();
    identityVerified = true;

    // ── S1: Fixture setup ───────────────────────────────────────────────
    const setupClient = await pool.connect();
    try {
      const { propertyId } = await createFixtureProperty(setupClient);
      const chain = await createReservationChain(setupClient, propertyId);
      await createSettledReservationFinancials(setupClient, {
        propertyId, bookingId: chain.bookingId, reservationId: chain.reservationId,
      });
      const menu = await createPosMenuFixture(setupClient, propertyId);

      // Track menu IDs
      tracked.posMenuItems.push(menu.posMenuItemId);
      tracked.posMenuCategories.push(menu.posMenuCategoryId);

      // ── S1: Verify canonical balance = 0 via production calculator ──
      const balClient = await pool.connect();
      let balTxActive = false;
      try {
        await balClient.query('BEGIN');
        balTxActive = true;
        const balance = await calculateHotelCollectibleBalance(
          balClient, chain.reservationId, propertyId, 'HOTEL_COLLECT'
        );
        await balClient.query('COMMIT');
        balTxActive = false;

        // Strict assertion on canonical field
        if (
          balance == null
          || typeof balance !== 'object'
          || !( 'hotel_collectible_remaining_balance' in balance )
        ) {
          fail('S1: balance response missing hotel_collectible_remaining_balance');
          process.exitCode = 1;
          return;
        }
        const remaining = balance.hotel_collectible_remaining_balance;
        if (remaining == null || !Number.isFinite(remaining)) {
          fail(`S1: hotel_collectible_remaining_balance not finite (got ${remaining})`);
          process.exitCode = 1;
          return;
        }
        if (remaining !== 0) {
          fail(`S1: balance not zero before checkout (got ${remaining})`);
          process.exitCode = 1;
          return;
        }
        pass('S1: canonical balance = 0 (settled)');
      } catch (err) {
        if (balTxActive) {
          try { await balClient.query('ROLLBACK'); }
          catch (rbErr) {
            fail('S1: balance ROLLBACK', rbErr);
            process.exitCode = 1;
          }
        }
        fail('S1: balance check', err);
        process.exitCode = 1;
      } finally {
        try { balClient.release(); }
        catch (relErr) {
          fail('S1: balClient release', relErr);
          process.exitCode = 1;
        }
      }

      // ── S1: Assert fixture initial state before snapshot ─────────────
      const initClient = await pool.connect();
      let initStates;
      try {
        const resR = await initClient.query('SELECT status, stay_status FROM reservations WHERE id = $1', [chain.reservationId]);
        const bkR  = await initClient.query('SELECT booking_status FROM bookings WHERE id = $1', [chain.bookingId]);
        const rmR  = await initClient.query('SELECT status FROM rooms WHERE id = $1', [chain.roomId]);
        initStates = {
          reservation: resR.rows[0],
          booking: bkR.rows[0],
          room: rmR.rows[0],
        };
      } finally {
        initClient.release();
      }
      if (
        !initStates.reservation
        || initStates.reservation.status !== 'CHECKED_IN'
        || !initStates.booking
        || initStates.booking.booking_status !== 'ACTIVE'
        || !initStates.room
        || initStates.room.status !== 'OCCUPIED_CLEAN'
      ) {
        fail(`S1: fixture initial state wrong (res=${JSON.stringify(initStates.reservation)}, bk=${JSON.stringify(initStates.booking)}, room=${JSON.stringify(initStates.room)})`);
        process.exitCode = 1;
        return;
      }
      pass('S1: fixture initial state verified (CHECKED_IN, ACTIVE, OCCUPIED_CLEAN)');

      // ── S1: Wire Express with real production handlers ─────────────
      const express = require('express');
      const app = express();
      app.use(express.json());

      // POS create handler (real production factory)
      app.post('/api/pos/orders', createPosOrderCreateHandler({
        pool,
        connect: () => pool.connect(),
        release: (client) => client.release(),
        assertPropertyScope: async (req, pid) => {
          // Test-local: verify property_id is a valid positive integer.
          // In production this checks JWT property scope.
          if (!Number.isInteger(pid) || pid <= 0) {
            throw Object.assign(new Error('property_id invalid'), { statusCode: 400, code: 'VALIDATION_ERROR' });
          }
        },
        broadcastEvent: noopBroadcast,
      }));

      // Checkout handler (real production factory)
      app.post('/api/reservations/:id/checkout', createReservationCheckoutHandler({
        pool,
        connect: () => pool.connect(),
        release: (client) => client.release(),
        assertPropertyId,
        assertPropertyExists,
        assertReservationBelongsToProperty,
        isFeatureEnabled,
        getPropertyHousekeepingSettings,
        ensureCheckoutRoomCleaningTask,
        getHeldIdentityCustodyForCheckout,
        recalculateReservationFinancials,
        calculateHotelCollectibleBalance,
        releaseReservationInventoryForCheckout,
        broadcastEvent: noopBroadcast,
        getCanonicalReservationDto,
        buildBookingChildStatusSummary,
        deriveBookingLifecycleStatus,
        buildBookingCompletionAuditPayload,
        withReservationHotelDates,
      }));

      // ── S1: Listen server with error handling ──────────────────────
      httpServer = app.listen(0, '127.0.0.1');
      httpServer.on('error', (err) => {
        fail('S1: HTTP server error', err);
        process.exitCode = 1;
      });
      await new Promise((resolve, reject) => {
        httpServer.on('listening', resolve);
        httpServer.on('error', reject);
      });
      const port = httpServer.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;

      // ── S1: Create POS order via HTTP (with timeout) ───────────────
      const HTTP_TIMEOUT_MS = 15000;
      const idempotencyKey = `s1-${crypto.randomUUID()}`;
      const posRes = await fetch(`${baseUrl}/api/pos/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          property_id: propertyId,
          reservation_id: chain.reservationId,
          items: [{ menu_item_id: menu.posMenuItemId, quantity: 1 }],
        }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      const posBody = await posRes.json();
      if (posRes.status === 201) {
        const orderId = posBody.data?.id;
        const orderStatus = String(posBody.data?.status || '').toUpperCase();
        const totalAmount = Number(posBody.data?.total_amount ?? 0);
        if (orderId != null && orderStatus === 'OPEN' && totalAmount === 25000) {
          pass('S1: POS order created (201, OPEN, total=25000)');
          tracked.posOrders.push(orderId);
          // Track order items
          const itemClient = await pool.connect();
          try {
            const oi = await itemClient.query(
              'SELECT id FROM pos_order_items WHERE order_id = $1', [orderId]
            );
            for (const row of oi.rows) tracked.posOrderItems.push(String(row.id));
          } catch (err) {
            fail('S1: track order items', err);
            process.exitCode = 1;
            return;
          } finally { itemClient.release(); }
        } else {
          fail(`S1: POS order response unexpected: status=${orderStatus}, total=${totalAmount}, id=${orderId}`);
          process.exitCode = 1;
          return;
        }
      } else {
        fail(`S1: POS order create failed (HTTP ${posRes.status}): ${JSON.stringify(posBody)}`);
        process.exitCode = 1;
        return;
      }

      // ── S1: Pre-checkout snapshot (with inventory) ──────────────────
      const snapClient = await pool.connect();
      let preSnapshot;
      try {
        preSnapshot = await takeSnapshot(snapClient, {
          propertyId,
          reservationId: chain.reservationId,
          roomId: chain.roomId,
          bookingId: chain.bookingId,
          roomTypeId: chain.roomTypeId,
          checkIn: chain.checkIn,
          checkOut: chain.checkOut,
        });
      } catch (err) {
        fail('S1: pre-snapshot', err);
        process.exitCode = 1;
        return;
      } finally {
        snapClient.release();
      }

      // ── S1: Call checkout (expect 409 POS_OPEN_ORDERS_BLOCK_CHECKOUT) ─
      const chRes = await fetch(`${baseUrl}/api/reservations/${chain.reservationId}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      const chBody = await chRes.json();

      // Helper: verify the rejection response has ONLY the expected keys and no leaks
      function assertNoLeak(responseBody, label) {
        const expectedKeys = new Set(['status', 'code', 'message']);
        const actualKeys = new Set(Object.keys(responseBody));
        for (const k of actualKeys) {
          if (!expectedKeys.has(k)) {
            fail(`${label}: unexpected key "${k}" in rejection response`);
            return false;
          }
        }
        const msg = String(responseBody.message || '');
        // No numeric ID (4+ digits), no order count, no amount
        if (/\d{4,}/.test(msg) || /\bcount\b/i.test(msg) || /\btotal\b/i.test(msg) || /order/i.test(msg)) {
          fail(`${label}: message leaks numeric/order info: "${msg}"`);
          return false;
        }
        return true;
      }

      if (chRes.status === 409 && chBody.code === 'POS_OPEN_ORDERS_BLOCK_CHECKOUT') {
        if (!assertNoLeak(chBody, 'S1 plain checkout')) {
          process.exitCode = 1;
          return;
        }
        pass('S1: checkout rejected with POS_OPEN_ORDERS_BLOCK_CHECKOUT (clean response)');
      } else {
        fail(`S1: checkout not blocked as expected (HTTP ${chRes.status}, code=${chBody.code})`);
        process.exitCode = 1;
        return;
      }

      // ── S1: Repeat with force=true ──────────────────────────────────
      const chForceRes = await fetch(`${baseUrl}/api/reservations/${chain.reservationId}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId, force: true }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      const chForceBody = await chForceRes.json();
      if (chForceRes.status === 409 && chForceBody.code === 'POS_OPEN_ORDERS_BLOCK_CHECKOUT') {
        if (!assertNoLeak(chForceBody, 'S1 force=true')) {
          process.exitCode = 1;
          return;
        }
        pass('S1: force=true still blocked by POS guard (clean response)');
      } else {
        fail(`S1: force=true not blocked (HTTP ${chForceRes.status}, code=${chForceBody.code})`);
        process.exitCode = 1;
        return;
      }

      // ── S1: Repeat with skip_inspection=true ────────────────────────
      const chSkipRes = await fetch(`${baseUrl}/api/reservations/${chain.reservationId}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId, skip_inspection: true }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      const chSkipBody = await chSkipRes.json();
      if (chSkipRes.status === 409 && chSkipBody.code === 'POS_OPEN_ORDERS_BLOCK_CHECKOUT') {
        if (!assertNoLeak(chSkipBody, 'S1 skip_inspection=true')) {
          process.exitCode = 1;
          return;
        }
        pass('S1: skip_inspection=true still blocked by POS guard (clean response)');
      } else {
        fail(`S1: skip_inspection=true not blocked (HTTP ${chSkipRes.status}, code=${chSkipBody.code})`);
        process.exitCode = 1;
        return;
      }

      // ── S1: Post-checkout snapshot (must be identical to pre) ───────
      const postClient = await pool.connect();
      let postSnapshot;
      try {
        postSnapshot = await takeSnapshot(postClient, {
          propertyId,
          reservationId: chain.reservationId,
          roomId: chain.roomId,
          bookingId: chain.bookingId,
          roomTypeId: chain.roomTypeId,
          checkIn: chain.checkIn,
          checkOut: chain.checkOut,
        });
      } catch (err) {
        fail('S1: post-snapshot', err);
        process.exitCode = 1;
        return;
      } finally {
        postClient.release();
      }

      if (!snapshotEqual(preSnapshot, postSnapshot)) {
        fail(`S1: state changed after failed checkout attempts\n  pre: ${JSON.stringify(preSnapshot)}\n  post: ${JSON.stringify(postSnapshot)}`);
        process.exitCode = 1;
        return;
      }
      // NOTE: S1 does not insert availability_dates rows, so the inventory
      // snapshot only proves no NEW rows appeared. It does NOT prove qty release.
      pass('S1: state unchanged after rejected checkout attempts');

      // ── S1: Close HTTP server before cleanup ────────────────────────
      await new Promise((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      httpServer = null;

    } catch (err) {
      fail('S1 fixture/setup', err);
      process.exitCode = 1;
    } finally {
      // Release setupClient — error must FAIL
      try { setupClient.release(); } catch (err) {
        fail('S1: setupClient release', err);
        process.exitCode = 1;
      }
    }

    // ── S2: create wins, checkout blocks then is rejected ───────────────
    // S2: separate fixture setup client
    const s2SetupOuter = await pool.connect();
    try {
        const s2SetupInner = s2SetupOuter; // alias for clarity
        const { propertyId: s2PropertyId } = await createFixtureProperty(s2SetupInner);
        const s2Chain = await createReservationChain(s2SetupInner, s2PropertyId);
        await createSettledReservationFinancials(s2SetupInner, {
          propertyId: s2PropertyId,
          bookingId: s2Chain.bookingId,
          reservationId: s2Chain.reservationId,
        });
        const s2Menu = await createPosMenuFixture(s2SetupInner, s2PropertyId);
        tracked.posMenuItems.push(s2Menu.posMenuItemId);
        tracked.posMenuCategories.push(s2Menu.posMenuCategoryId);

        // ── S2: Verify canonical balance = 0 ──
        const s2BalClient = await pool.connect();
        let s2BalTxActive = false;
        try {
          await s2BalClient.query('BEGIN');
          s2BalTxActive = true;
          const s2Balance = await calculateHotelCollectibleBalance(
            s2BalClient, s2Chain.reservationId, s2PropertyId, 'HOTEL_COLLECT'
          );
          await s2BalClient.query('COMMIT');
          s2BalTxActive = false;
          if (
            s2Balance == null
            || typeof s2Balance !== 'object'
            || !( 'hotel_collectible_remaining_balance' in s2Balance )
          ) {
            fail('S2: balance response missing hotel_collectible_remaining_balance');
            process.exitCode = 1;
            return;
          }
          const s2Remaining = s2Balance.hotel_collectible_remaining_balance;
          if (s2Remaining == null || !Number.isFinite(s2Remaining)) {
            fail(`S2: hotel_collectible_remaining_balance not finite (got ${s2Remaining})`);
            process.exitCode = 1;
            return;
          }
          if (s2Remaining !== 0) {
            fail(`S2: balance not zero before test (got ${s2Remaining})`);
            process.exitCode = 1;
            return;
          }
          pass('S2: canonical balance = 0 (settled)');
        } catch (err) {
          if (s2BalTxActive) {
            try { await s2BalClient.query('ROLLBACK'); } catch (_) {}
          }
          fail('S2: balance check', err);
          process.exitCode = 1;
          return;
        } finally {
          try { s2BalClient.release(); } catch (relErr) {
            fail('S2: balClient release', relErr);
            process.exitCode = 1;
          }
        }

        // ── S2: Assert fixture initial state ──
        const s2Init = await pool.connect();
        let s2InitStates;
        try {
          const s2ResR = await s2Init.query('SELECT status FROM reservations WHERE id = $1', [s2Chain.reservationId]);
          const s2BkR  = await s2Init.query('SELECT booking_status FROM bookings WHERE id = $1', [s2Chain.bookingId]);
          const s2RmR  = await s2Init.query('SELECT status FROM rooms WHERE id = $1', [s2Chain.roomId]);
          s2InitStates = {
            reservation: s2ResR.rows[0],
            booking: s2BkR.rows[0],
            room: s2RmR.rows[0],
          };
        } finally {
          try { s2Init.release(); } catch (relErr) {
            fail('S2: init release', relErr);
            process.exitCode = 1;
          }
        }
        if (
          !s2InitStates.reservation
          || s2InitStates.reservation.status !== 'CHECKED_IN'
          || !s2InitStates.booking
          || s2InitStates.booking.booking_status !== 'ACTIVE'
          || !s2InitStates.room
          || s2InitStates.room.status !== 'OCCUPIED_CLEAN'
        ) {
          fail(`S2: fixture initial state wrong (res=${JSON.stringify(s2InitStates.reservation)}, bk=${JSON.stringify(s2InitStates.booking)}, room=${JSON.stringify(s2InitStates.room)})`);
          process.exitCode = 1;
          return;
        }
        pass('S2: fixture initial state verified (CHECKED_IN, ACTIVE, OCCUPIED_CLEAN)');

        // ── S2: Pre-snapshot (before any request) ──
        const s2PreSnapClient = await pool.connect();
        let s2PreSnapshot;
        try {
          s2PreSnapshot = await takeSnapshot(s2PreSnapClient, {
            propertyId: s2PropertyId,
            reservationId: s2Chain.reservationId,
            roomId: s2Chain.roomId,
            bookingId: s2Chain.bookingId,
            roomTypeId: s2Chain.roomTypeId,
            checkIn: s2Chain.checkIn,
            checkOut: s2Chain.checkOut,
          });
        } finally {
          try { s2PreSnapClient.release(); } catch (relErr) {
            fail('S2: preSnapClient release', relErr);
            process.exitCode = 1;
          }
        }
        pass('S2: pre-snapshot taken');

        // ── S2: Barrier + wrapped connects ──
        s2Barrier = createBarrier();
        s2CreateWrapped = createBarredConnect({
          pool,
          barrier: s2Barrier,
        });
        s2CheckoutWrapped = createBarredConnect({
          pool,
          barrier: null, // waiter side — no hold
        });

        // ── S2: Wire Express with real production handlers ──
        const s2Express = require('express');
        const s2App = s2Express();
        s2App.use(s2Express.json());

        // POS create handler with barrier-wrapped connect
        s2App.post('/api/pos/orders', createPosOrderCreateHandler({
          pool,
          connect: () => s2CreateWrapped.connect(),
          release: (client) => s2CreateWrapped.release(client),
          assertPropertyScope: async (req, pid) => {
            if (!Number.isInteger(pid) || pid <= 0) {
              throw Object.assign(new Error('property_id invalid'), { statusCode: 400, code: 'VALIDATION_ERROR' });
            }
          },
          broadcastEvent: noopBroadcast,
        }));

        // Checkout handler with separate barrier=null wrapped connect
        s2App.post('/api/reservations/:id/checkout', createReservationCheckoutHandler({
          pool,
          connect: () => s2CheckoutWrapped.connect(),
          release: (client) => s2CheckoutWrapped.release(client),
          assertPropertyId,
          assertPropertyExists,
          assertReservationBelongsToProperty,
          isFeatureEnabled,
          getPropertyHousekeepingSettings,
          ensureCheckoutRoomCleaningTask,
          getHeldIdentityCustodyForCheckout,
          recalculateReservationFinancials,
          calculateHotelCollectibleBalance,
          releaseReservationInventoryForCheckout,
          broadcastEvent: noopBroadcast,
          getCanonicalReservationDto,
          buildBookingChildStatusSummary,
          deriveBookingLifecycleStatus,
          buildBookingCompletionAuditPayload,
          withReservationHotelDates,
        }));

        // ── S2: Listen server ──
        s2HttpServer = s2App.listen(0, '127.0.0.1');
        s2HttpServer.on('error', (err) => {
          fail('S2: HTTP server error', err);
          process.exitCode = 1;
        });
        await new Promise((resolve, reject) => {
          s2HttpServer.on('listening', resolve);
          s2HttpServer.on('error', reject);
        });
        const s2Port = s2HttpServer.address().port;
        const s2BaseUrl = `http://127.0.0.1:${s2Port}`;

        // ── S2: Observer client with statement_timeout = 2000ms ──
        s2ObserverClient = await pool.connect();
        try {
          await s2ObserverClient.query('SET statement_timeout = 2000');
        } catch (err) {
          fail('S2: observer setup', err);
          process.exitCode = 1;
          return;
        }

        const S2_HTTP_TIMEOUT_MS = 15_000;

        // ── S2: Start create request — holds lock, awaits barrier ──
        s2CreatePromise = (async () => {
          const s2IdemKey = `s2-${crypto.randomUUID()}`;
          const s2PosRes = await fetch(`${s2BaseUrl}/api/pos/orders`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': s2IdemKey,
            },
            body: JSON.stringify({
              property_id: s2PropertyId,
              reservation_id: s2Chain.reservationId,
              items: [{ menu_item_id: s2Menu.posMenuItemId, quantity: 1 }],
            }),
            signal: AbortSignal.timeout(S2_HTTP_TIMEOUT_MS),
          });
          const s2PosBody = await s2PosRes.json();
          return { status: s2PosRes.status, body: s2PosBody };
        })();
        // Attach rejection handler immediately to prevent unhandled rejection
        s2CreatePromise.catch((err) => {
          fail('S2: create request', err);
          process.exitCode = 1;
        });

        // ── S2: Wait for barrier acquisition (create holds reservation lock) ──
        const s2Acquired = await s2Barrier.waitUntilAcquired(5_000);
        if (!s2Acquired) {
          fail('S2: barrier not acquired within deadline — create did not reach reservation lock');
          process.exitCode = 1;
          return;
        }
        pass('S2: barrier acquired — create holds reservation lock');

        // ── S2: Get create PID (available after connect completed) ──
        let createPid;
        try {
          createPid = await s2CreateWrapped.getConnected(5_000);
        } catch (err) {
          fail('S2: create PID unavailable', err);
          process.exitCode = 1;
          return;
        }

        // ── S2: Start checkout request (will block on reservation lock) ──
        s2CheckoutPromise = (async () => {
          const s2ChRes = await fetch(`${s2BaseUrl}/api/reservations/${s2Chain.reservationId}/checkout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ property_id: s2PropertyId }),
            signal: AbortSignal.timeout(S2_HTTP_TIMEOUT_MS),
          });
          const s2ChBody = await s2ChRes.json();
          return { status: s2ChRes.status, body: s2ChBody };
        })();
        s2CheckoutPromise.catch((err) => {
          fail('S2: checkout request', err);
          process.exitCode = 1;
        });

        // ── S2: Wait for checkout to connect and get its PID ──
        let checkoutPid;
        try {
          checkoutPid = await s2CheckoutWrapped.getConnected(5_000);
        } catch (err) {
          fail('S2: checkout PID unavailable', err);
          process.exitCode = 1;
          return;
        }

        console.log(`S2: PIDs — create=${createPid}, checkout=${checkoutPid}`);

        // ── S2: Observe blocking: pg_blocking_pids(checkoutPid) must contain createPid ──
        try {
          await observeBlocking(s2ObserverClient, checkoutPid, createPid, { timeoutMs: 3_000 });
          pass(`S2: pg_blocking_pids(${checkoutPid}) contains ${createPid} — checkout blocked by create`);
        } catch (err) {
          fail('S2: blocking not observed', err);
          process.exitCode = 1;
          return;
        }

        // ── S2: Release barrier → create proceeds (INSERT + COMMIT) ──
        s2Barrier.release();
        pass('S2: barrier released — create may proceed');

        // ── S2: Await both requests ──
        let s2CreateResult;
        try {
          s2CreateResult = await s2CreatePromise;
        } catch (err) {
          fail('S2: create request failed', err);
          process.exitCode = 1;
          return;
        }
        if (s2CreateResult.status !== 201) {
          fail(`S2: create returned HTTP ${s2CreateResult.status}, expected 201`);
          process.exitCode = 1;
          return;
        }
        const s2CreateOrder = s2CreateResult.body.data;
        if (
          !s2CreateOrder
          || String(s2CreateOrder.status || '').toUpperCase() !== 'OPEN'
          || Number(s2CreateOrder.total_amount ?? 0) !== 25000
        ) {
          fail(`S2: create response unexpected: ${JSON.stringify(s2CreateResult.body)}`);
          process.exitCode = 1;
          return;
        }
        pass('S2: create returned 201, OPEN, total=25000');
        tracked.posOrders.push(s2CreateOrder.id);
        const s2ItemClient = await pool.connect();
        try {
          const s2Oi = await s2ItemClient.query(
            'SELECT id FROM pos_order_items WHERE order_id = $1', [s2CreateOrder.id]
          );
          for (const row of s2Oi.rows) tracked.posOrderItems.push(String(row.id));
        } finally {
          try { s2ItemClient.release(); } catch (relErr) {
            fail('S2: itemClient release', relErr);
            process.exitCode = 1;
          }
        }

        let s2CheckoutResult;
        try {
          s2CheckoutResult = await s2CheckoutPromise;
        } catch (err) {
          fail('S2: checkout request failed', err);
          process.exitCode = 1;
          return;
        }
        if (s2CheckoutResult.status !== 409 || s2CheckoutResult.body.code !== 'POS_OPEN_ORDERS_BLOCK_CHECKOUT') {
          fail(`S2: checkout not blocked as expected (HTTP ${s2CheckoutResult.status}, code=${s2CheckoutResult.body.code})`);
          process.exitCode = 1;
          return;
        }
        // Verify response has ONLY expected keys (same contract as S1 assertNoLeak)
        const s2ExpectedKeys = new Set(['status', 'code', 'message']);
        for (const k of Object.keys(s2CheckoutResult.body)) {
          if (!s2ExpectedKeys.has(k)) {
            fail(`S2: checkout response has unexpected key "${k}"`);
            process.exitCode = 1;
            return;
          }
        }
        // No numeric ID, count, total, or "order" in message
        const s2ChMsg = String(s2CheckoutResult.body.message || '');
        if (/\d{4,}/.test(s2ChMsg) || /\bcount\b/i.test(s2ChMsg) || /\btotal\b/i.test(s2ChMsg) || /order/i.test(s2ChMsg)) {
          fail(`S2: checkout response leaks info: "${s2ChMsg}"`);
          process.exitCode = 1;
          return;
        }
        pass('S2: checkout rejected with POS_OPEN_ORDERS_BLOCK_CHECKOUT (clean response, expected keys only)');

        // ── S2: Post-snapshot + expected snapshot comparison ──
        const s2PostSnapClient = await pool.connect();
        let s2PostSnapshot;
        try {
          s2PostSnapshot = await takeSnapshot(s2PostSnapClient, {
            propertyId: s2PropertyId,
            reservationId: s2Chain.reservationId,
            roomId: s2Chain.roomId,
            bookingId: s2Chain.bookingId,
            roomTypeId: s2Chain.roomTypeId,
            checkIn: s2Chain.checkIn,
            checkOut: s2Chain.checkOut,
          });
        } finally {
          try { s2PostSnapClient.release(); } catch (relErr) {
            fail('S2: postSnapClient release', relErr);
            process.exitCode = 1;
          }
        }

        // expected = deep clone of pre-snapshot with posOrders+1, posOrderItems+1
        const s2ExpectedSnapshot = JSON.parse(JSON.stringify(s2PreSnapshot));
        s2ExpectedSnapshot.counts.posOrders = s2PreSnapshot.counts.posOrders + 1;
        s2ExpectedSnapshot.counts.posOrderItems = s2PreSnapshot.counts.posOrderItems + 1;

        // All other fields must be identical
        const s2SnapDiffs = [];
        for (const key of ['reservation', 'booking', 'room', 'inventoryRows']) {
          if (JSON.stringify(s2PostSnapshot[key]) !== JSON.stringify(s2ExpectedSnapshot[key])) {
            s2SnapDiffs.push(`${key}: expected=${JSON.stringify(s2ExpectedSnapshot[key])} actual=${JSON.stringify(s2PostSnapshot[key])}`);
          }
        }
        for (const countKey of Object.keys(s2ExpectedSnapshot.counts)) {
          if (Number(s2PostSnapshot.counts[countKey]) !== Number(s2ExpectedSnapshot.counts[countKey])) {
            s2SnapDiffs.push(`counts.${countKey}: expected=${s2ExpectedSnapshot.counts[countKey]} actual=${s2PostSnapshot.counts[countKey]}`);
          }
        }
        if (s2SnapDiffs.length > 0) {
          fail(`S2: post-snapshot differs from expected snapshot:\n  ${s2SnapDiffs.join('\n  ')}`);
          process.exitCode = 1;
          return;
        }
        pass('S2: post-snapshot matches expected snapshot (only posOrders+1, posOrderItems+1 changed)');

        // Explicit asserts: no transactions, no settlements
        if (Number(s2PostSnapshot.counts.transactions) !== 0) {
          fail(`S2: expected 0 transactions, got ${s2PostSnapshot.counts.transactions}`);
          process.exitCode = 1;
          return;
        }
        if (Number(s2PostSnapshot.counts.posSettlements) !== 0) {
          fail(`S2: expected 0 settlements, got ${s2PostSnapshot.counts.posSettlements}`);
          process.exitCode = 1;
          return;
        }
        pass('S2: transactions=0, settlements=0');

        // ── S2: Canonical balance re-check after both requests ──
        const s2PostBalClient = await pool.connect();
        let s2PostBalTxActive = false;
        try {
          await s2PostBalClient.query('BEGIN');
          s2PostBalTxActive = true;
          const s2PostBalance = await calculateHotelCollectibleBalance(
            s2PostBalClient, s2Chain.reservationId, s2PropertyId, 'HOTEL_COLLECT'
          );
          await s2PostBalClient.query('COMMIT');
          s2PostBalTxActive = false;
          if (
            s2PostBalance == null
            || typeof s2PostBalance !== 'object'
            || !('hotel_collectible_remaining_balance' in s2PostBalance)
          ) {
            fail('S2: post-balance response missing hotel_collectible_remaining_balance');
            process.exitCode = 1;
            return;
          }
          const s2PostRemaining = s2PostBalance.hotel_collectible_remaining_balance;
          if (s2PostRemaining == null || !Number.isFinite(s2PostRemaining) || s2PostRemaining !== 0) {
            fail(`S2: post-balance not zero (got ${s2PostRemaining})`);
            process.exitCode = 1;
            return;
          }
          pass('S2: canonical balance still 0 after both requests');
        } catch (err) {
          if (s2PostBalTxActive) {
            try { await s2PostBalClient.query('ROLLBACK'); } catch (_) {}
          }
          fail('S2: post-balance check', err);
          process.exitCode = 1;
          return;
        } finally {
          try { s2PostBalClient.release(); } catch (relErr) {
            fail('S2: postBalClient release', relErr);
            process.exitCode = 1;
          }
        }

        // ── S2: Close HTTP server before cleanup ──
        await new Promise((resolve, reject) => {
          s2HttpServer.close((err) => err ? reject(err) : resolve());
        });
        s2HttpServer = null;

      } catch (err) {
        fail('S2 fixture/setup', err);
        process.exitCode = 1;
      } finally {
        // Release S2 outer setup client
        try { s2SetupOuter.release(); } catch (err) {
          fail('S2: setupClient release', err);
          process.exitCode = 1;
        }
      }
      // NOTE: barrier release / handler awaits / observer destroy / server close
      // are handled in the outer finally below (which runs on every exit path).

      // ── S3: checkout wins, create waits then is rejected ────────────────
      // S3: separate fixture setup
      let s3PropertyId;
      let s3Chain;
      let s3Menu;
      const s3SetupOuter = await pool.connect();
      try {
        s3PropertyId = (await createFixtureProperty(s3SetupOuter)).propertyId;
        s3Chain = await createReservationChain(s3SetupOuter, s3PropertyId);
        await createSettledReservationFinancials(s3SetupOuter, {
          propertyId: s3PropertyId,
          bookingId: s3Chain.bookingId,
          reservationId: s3Chain.reservationId,
        });
        s3Menu = await createPosMenuFixture(s3SetupOuter, s3PropertyId);
        await createInventoryFixtureForS3(s3SetupOuter, s3Chain);
      } catch (err) {
        fail('S3 fixture setup', err);
        process.exitCode = 1;
        return;
      } finally {
        try { s3SetupOuter.release(); } catch (err) {
          fail('S3: setupClient release', err);
          process.exitCode = 1;
        }
      }
      // NOTE: S3 barrier, requests, observer, and server cleanup
      // are handled in the outer finally below.

      // ── S3: Post-setup verification (balance, initial state, inventory) ──
      const s3VerifyClient = await pool.connect();
      let s3VerifyTxActive = false;
      try {
        await s3VerifyClient.query('BEGIN');
        s3VerifyTxActive = true;

        // 1. Canonical balance must be exactly 0
        const s3Balance = await calculateHotelCollectibleBalance(
          s3VerifyClient, s3Chain.reservationId, s3PropertyId, 'HOTEL_COLLECT'
        );
        if (
          s3Balance == null
          || typeof s3Balance !== 'object'
          || !('hotel_collectible_remaining_balance' in s3Balance)
        ) {
          fail('S3: balance response missing hotel_collectible_remaining_balance');
          process.exitCode = 1;
          return;
        }
        const s3Remaining = s3Balance.hotel_collectible_remaining_balance;
        if (s3Remaining == null || !Number.isFinite(s3Remaining)) {
          fail(`S3: hotel_collectible_remaining_balance not finite (got ${s3Remaining})`);
          process.exitCode = 1;
          return;
        }
        if (s3Remaining !== 0) {
          fail(`S3: balance not zero after fixture setup (got ${s3Remaining})`);
          process.exitCode = 1;
          return;
        }
        pass('S3: canonical balance = 0 (settled)');

        // 2. Initial state assertions
        const s3ResR = await s3VerifyClient.query(
          'SELECT status, stay_status, checked_out_at FROM reservations WHERE id = $1',
          [s3Chain.reservationId]
        );
        const s3BkR = await s3VerifyClient.query(
          'SELECT booking_status FROM bookings WHERE id = $1',
          [s3Chain.bookingId]
        );
        const s3RmR = await s3VerifyClient.query(
          'SELECT status FROM rooms WHERE id = $1',
          [s3Chain.roomId]
        );
        const s3Res = s3ResR.rows[0];
        const s3Bk  = s3BkR.rows[0];
        const s3Rm  = s3RmR.rows[0];
        if (
          !s3Res
          || s3Res.status !== 'CHECKED_IN'
          || s3Res.stay_status !== 'IN_HOUSE'
          || !s3Bk
          || s3Bk.booking_status !== 'ACTIVE'
          || !s3Rm
          || s3Rm.status !== 'OCCUPIED_CLEAN'
        ) {
          fail(`S3: initial state wrong (res=${JSON.stringify(s3Res)}, bk=${JSON.stringify(s3Bk)}, room=${JSON.stringify(s3Rm)})`);
          process.exitCode = 1;
          return;
        }
        pass('S3: initial state verified (CHECKED_IN, IN_HOUSE, ACTIVE, OCCUPIED_CLEAN)');

        // 3. Inventory verification: enumerateHotelDates tells us exactly which
        //    dates must have availability_dates rows with reserved_qty=1.
        const s3Dates = enumerateHotelDates(s3Chain.checkIn, s3Chain.checkOut);
        const s3InvR = await s3VerifyClient.query(
          `SELECT date::text AS date, total_rooms, reserved_qty
           FROM availability_dates
           WHERE room_type_id = $1
           ORDER BY date`,
          [s3Chain.roomTypeId]
        );
        // date::text returns YYYY-MM-DD strings directly — no String(Date) conversion
        const s3InvRows = s3InvR.rows.map(r => ({
          date: String(r.date),
          total_rooms: Number(r.total_rooms),
          reserved_qty: Number(r.reserved_qty),
        }));
        if (s3InvRows.length !== s3Dates.length) {
          fail(`S3: inventory row count wrong — expected ${s3Dates.length}, got ${s3InvRows.length}`);
          process.exitCode = 1;
          return;
        }
        // Position-by-position comparison: catches missing dates, unexpected dates,
        // and duplicates in a single pass (both lists are sorted by date).
        for (let i = 0; i < s3Dates.length; i++) {
          if (s3InvRows[i].date !== s3Dates[i]) {
            fail(`S3: inventory date mismatch at index ${i} — expected ${s3Dates[i]}, got ${s3InvRows[i].date}`);
            process.exitCode = 1;
            return;
          }
          if (s3InvRows[i].reserved_qty !== 1) {
            fail(`S3: reserved_qty not 1 on ${s3Dates[i]} (got ${s3InvRows[i].reserved_qty})`);
            process.exitCode = 1;
            return;
          }
          if (s3InvRows[i].total_rooms !== 10) {
            fail(`S3: total_rooms not 10 on ${s3Dates[i]} (got ${s3InvRows[i].total_rooms})`);
            process.exitCode = 1;
            return;
          }
        }
        pass(`S3: inventory verified (${s3Dates.length} night(s), reserved_qty=1, total_rooms=10 each)`);

        // 4. Save snapshot for post-checkout comparison
        s3InventorySnapshot = s3InvRows;

        await s3VerifyClient.query('COMMIT');
        s3VerifyTxActive = false;
      } catch (err) {
        fail('S3: post-setup verification', err);
        process.exitCode = 1;
        return;
      } finally {
        // Rollback any still-active transaction before release.
        // All return paths (including assertion failures) trigger this.
        if (s3VerifyTxActive) {
          try { await s3VerifyClient.query('ROLLBACK'); } catch (rbErr) {
            fail('S3: verifyClient ROLLBACK', rbErr);
            process.exitCode = 1;
          }
        }
        try { s3VerifyClient.release(); } catch (relErr) {
          fail('S3: verifyClient release', relErr);
          process.exitCode = 1;
        }
      }

      // ── S3: Barrier + wrapped connects ──
      s3Barrier = createBarrier();
      s3CheckoutWrapped = createBarredConnect({
        pool,
        barrier: s3Barrier,
      });
      s3CreateWrapped = createBarredConnect({
        pool,
        barrier: null,
      });

      // ── S3: Wire Express with production handlers ──
      const s3Express = require('express');
      const s3App = s3Express();
      s3App.use(s3Express.json());

      s3App.post('/api/pos/orders', createPosOrderCreateHandler({
        pool,
        connect: () => s3CreateWrapped.connect(),
        release: (client) => s3CreateWrapped.release(client),
        assertPropertyScope: async (req, pid) => {
          if (!Number.isInteger(pid) || pid <= 0) {
            throw Object.assign(new Error('property_id invalid'), { statusCode: 400, code: 'VALIDATION_ERROR' });
          }
        },
        broadcastEvent: noopBroadcast,
      }));

      s3App.post('/api/reservations/:id/checkout', createReservationCheckoutHandler({
        pool,
        connect: () => s3CheckoutWrapped.connect(),
        release: (client) => s3CheckoutWrapped.release(client),
        assertPropertyId,
        assertPropertyExists,
        assertReservationBelongsToProperty,
        isFeatureEnabled,
        getPropertyHousekeepingSettings,
        ensureCheckoutRoomCleaningTask,
        getHeldIdentityCustodyForCheckout,
        recalculateReservationFinancials,
        calculateHotelCollectibleBalance,
        releaseReservationInventoryForCheckout,
        broadcastEvent: noopBroadcast,
        getCanonicalReservationDto,
        buildBookingChildStatusSummary,
        deriveBookingLifecycleStatus,
        buildBookingCompletionAuditPayload,
        withReservationHotelDates,
      }));

      // ── S3: Listen on dynamic port ──
      s3HttpServer = s3App.listen(0, '127.0.0.1');
      s3HttpServer.on('error', (err) => {
        fail('S3: HTTP server error', err);
        process.exitCode = 1;
      });
      await new Promise((resolve, reject) => {
        s3HttpServer.on('listening', resolve);
        s3HttpServer.on('error', reject);
      });
      const s3Port = s3HttpServer.address().port;
      const s3BaseUrl = `http://127.0.0.1:${s3Port}`;

      // ── S3: Observer client with statement_timeout = 2000ms ──
      s3ObserverClient = await pool.connect();
      try {
        await s3ObserverClient.query('SET statement_timeout = 2000');
      } catch (err) {
        fail('S3: observer setup', err);
        process.exitCode = 1;
        return;
      }
      // NOTE: s3ObserverClient is cleaned up in the outer finally.

      // ── S3: Start checkout request (barrier side — will hold lock) ──
      const S3_HTTP_TIMEOUT_MS = 15_000;

      s3CheckoutPromise = (async () => {
        const s3ChRes = await fetch(`${s3BaseUrl}/api/reservations/${s3Chain.reservationId}/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ property_id: s3PropertyId }),
          signal: AbortSignal.timeout(S3_HTTP_TIMEOUT_MS),
        });
        const s3ChBody = await s3ChRes.json();
        return { status: s3ChRes.status, body: s3ChBody };
      })();
      s3CheckoutPromise.catch((err) => {
        fail('S3: checkout request', err);
        process.exitCode = 1;
      });

      // ── S3: Wait for barrier acquisition (checkout holds reservation lock) ──
      const s3Acquired = await s3Barrier.waitUntilAcquired(5_000);
      if (!s3Acquired) {
        fail('S3: barrier not acquired within deadline — checkout did not reach reservation lock');
        process.exitCode = 1;
        return;
      }
      pass('S3: barrier acquired — checkout holds reservation lock');

      // ── S3: Start POS create request (waiter side — will block on checkout's lock) ──
      const s3IdemKey = `s3-${crypto.randomUUID()}`;
      s3CreatePromise = (async () => {
        const s3PosRes = await fetch(`${s3BaseUrl}/api/pos/orders`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': s3IdemKey,
          },
          body: JSON.stringify({
            property_id: s3PropertyId,
            reservation_id: s3Chain.reservationId,
            items: [{ menu_item_id: s3Menu.posMenuItemId, quantity: 1 }],
          }),
          signal: AbortSignal.timeout(S3_HTTP_TIMEOUT_MS),
        });
        const s3PosBody = await s3PosRes.json();
        return { status: s3PosRes.status, body: s3PosBody };
      })();
      s3CreatePromise.catch((err) => {
        fail('S3: create request', err);
        process.exitCode = 1;
      });

      // ── S3: Get PIDs of both handlers ──
      let s3CheckoutPid;
      try {
        s3CheckoutPid = await s3CheckoutWrapped.getConnected(5_000);
      } catch (err) {
        fail('S3: checkout PID unavailable', err);
        process.exitCode = 1;
        return;
      }
      let s3CreatePid;
      try {
        s3CreatePid = await s3CreateWrapped.getConnected(5_000);
      } catch (err) {
        fail('S3: create PID unavailable', err);
        process.exitCode = 1;
        return;
      }
      console.log(`S3: PIDs — checkout=${s3CheckoutPid}, create=${s3CreatePid}`);

      // ── S3: Prove create is blocked by checkout via pg_blocking_pids ──
      try {
        await observeBlocking(s3ObserverClient, s3CreatePid, s3CheckoutPid, { timeoutMs: 3_000 });
        pass(`S3: pg_blocking_pids(${s3CreatePid}) contains ${s3CheckoutPid} — create blocked by checkout`);
      } catch (err) {
        fail('S3: blocking not observed (create not blocked by checkout)', err);
        process.exitCode = 1;
        return;
      }

      // ── S3: Release barrier → checkout proceeds, create unblocks ──
      s3Barrier.release();
      pass('S3: barrier released — checkout may proceed');

      // ── S3: Await both responses ──
      let s3CheckoutResult;
      try {
        s3CheckoutResult = await s3CheckoutPromise;
      } catch (err) {
        fail('S3: checkout request failed', err);
        process.exitCode = 1;
        return;
      }
      let s3CreateResult;
      try {
        s3CreateResult = await s3CreatePromise;
      } catch (err) {
        fail('S3: create request failed', err);
        process.exitCode = 1;
        return;
      }

      // ── S3: Assert checkout response (production handler: 200, status=SUCCESS) ──
      if (s3CheckoutResult.status !== 200) {
        fail(`S3: checkout returned HTTP ${s3CheckoutResult.status}, expected 200. Body: ${JSON.stringify(s3CheckoutResult.body)}`);
        process.exitCode = 1;
        return;
      }
      if (s3CheckoutResult.body.status !== 'SUCCESS') {
        fail(`S3: checkout body.status not SUCCESS (got ${JSON.stringify(s3CheckoutResult.body.status)})`);
        process.exitCode = 1;
        return;
      }
      pass('S3: checkout returned HTTP 200, status=SUCCESS');

      // ── S3: Assert create response (production handler: 409 RESERVATION_CHECKED_OUT) ──
      if (s3CreateResult.status !== 409) {
        fail(`S3: create returned HTTP ${s3CreateResult.status}, expected 409. Body: ${JSON.stringify(s3CreateResult.body)}`);
        process.exitCode = 1;
        return;
      }
      if (s3CreateResult.body.code !== 'RESERVATION_CHECKED_OUT') {
        fail(`S3: create body.code not RESERVATION_CHECKED_OUT (got ${JSON.stringify(s3CreateResult.body.code)})`);
        process.exitCode = 1;
        return;
      }
      pass('S3: create rejected with HTTP 409, code=RESERVATION_CHECKED_OUT');

      // Results stored on IIFE-scoped vars for next-stage DB assertions:
      //   s3CheckoutResult, s3CreateResult (declared in catch scope above)
       // NOTE: s3CheckoutPromise / s3CreatePromise also awaited in outer finally
       // (guarded: already-resolved promises resolve immediately, no hang).

       // ── S3: Post-request DB assertions ──
       const s3DbClient = await pool.connect();
       let s3DbTxActive = false;
       try {
         await s3DbClient.query('BEGIN');
         s3DbTxActive = true;

         // 1. Reservation / booking / room final state
         const s3FinRes = await s3DbClient.query(
           'SELECT status, stay_status, checked_out_at FROM reservations WHERE id = $1',
           [s3Chain.reservationId]
         );
         const s3FinBk = await s3DbClient.query(
           'SELECT booking_status FROM bookings WHERE id = $1',
           [s3Chain.bookingId]
         );
         const s3FinRm = await s3DbClient.query(
           'SELECT status FROM rooms WHERE id = $1',
           [s3Chain.roomId]
         );
         const s3FinResRow = s3FinRes.rows[0];
         if (
           !s3FinResRow
           || s3FinResRow.status !== 'CHECKED_OUT'
           || s3FinResRow.stay_status !== 'DEPARTED'
           || !s3FinResRow.checked_out_at
         ) {
           fail(`S3: reservation final state wrong (got ${JSON.stringify(s3FinResRow)})`);
           process.exitCode = 1;
           return;
         }
         pass('S3: reservation CHECKED_OUT, stay_status DEPARTED, checked_out_at set');

         if (!s3FinBk.rows[0] || s3FinBk.rows[0].booking_status !== 'COMPLETED') {
           fail(`S3: booking not COMPLETED (got ${JSON.stringify(s3FinBk.rows[0])})`);
           process.exitCode = 1;
           return;
         }
         pass('S3: booking COMPLETED');

         if (!s3FinRm.rows[0] || s3FinRm.rows[0].status !== 'VACANT_DIRTY') {
           fail(`S3: room not VACANT_DIRTY (got ${JSON.stringify(s3FinRm.rows[0])})`);
           process.exitCode = 1;
           return;
         }
         pass('S3: room VACANT_DIRTY');

          // 2. No new POS orders, items, transactions, or settlements in S3 fixture
          const s3PoR = await s3DbClient.query(
            'SELECT COUNT(*)::int AS n FROM pos_orders WHERE property_id = $1',
            [s3PropertyId]
          );
          if (Number(s3PoR.rows[0].n) !== 0) {
            fail(`S3: unexpected pos_orders in fixture (got ${s3PoR.rows[0].n})`);
            process.exitCode = 1;
            return;
          }
          const s3TxR = await s3DbClient.query(
            'SELECT COUNT(*)::int AS n FROM transactions WHERE property_id = $1',
            [s3PropertyId]
          );
          if (Number(s3TxR.rows[0].n) !== 0) {
            fail(`S3: unexpected transactions in fixture (got ${s3TxR.rows[0].n})`);
            process.exitCode = 1;
            return;
          }
          const s3PsR = await s3DbClient.query(
            'SELECT COUNT(*)::int AS n FROM pos_settlements WHERE property_id = $1',
            [s3PropertyId]
          );
          if (Number(s3PsR.rows[0].n) !== 0) {
            fail(`S3: unexpected pos_settlements in fixture (got ${s3PsR.rows[0].n})`);
            process.exitCode = 1;
            return;
          }
          // pos_order_items scoped via pos_orders owned by s3PropertyId
          const s3PoIdsR = await s3DbClient.query(
            'SELECT id FROM pos_orders WHERE property_id = $1',
            [s3PropertyId]
          );
          let s3PoiCount = 0;
          if (s3PoIdsR.rows.length > 0) {
            const s3PoiR = await s3DbClient.query(
              'SELECT COUNT(*)::int AS n FROM pos_order_items WHERE order_id = ANY($1)',
              [s3PoIdsR.rows.map(r => r.id)]
            );
            s3PoiCount = Number(s3PoiR.rows[0].n);
          }
          if (s3PoiCount !== 0) {
            fail(`S3: unexpected pos_order_items in fixture (got ${s3PoiCount})`);
            process.exitCode = 1;
            return;
          }
          pass('S3: no pos_orders, pos_order_items, transactions, or pos_settlements in fixture');

         // 3. Inventory: dates + row count match snapshot; reserved_qty 1→0; total_rooms unchanged
         const s3FinInvR = await s3DbClient.query(
           `SELECT date::text AS date, total_rooms, reserved_qty
            FROM availability_dates
            WHERE room_type_id = $1
            ORDER BY date`,
           [s3Chain.roomTypeId]
         );
         const s3FinInvRows = s3FinInvR.rows.map(r => ({
           date: String(r.date),
           total_rooms: Number(r.total_rooms),
           reserved_qty: Number(r.reserved_qty),
         }));
         if (s3FinInvRows.length !== s3InventorySnapshot.length) {
           fail(`S3: inventory row count changed — before=${s3InventorySnapshot.length}, after=${s3FinInvRows.length}`);
           process.exitCode = 1;
           return;
         }
         for (let i = 0; i < s3InventorySnapshot.length; i++) {
           const before = s3InventorySnapshot[i];
           const after  = s3FinInvRows[i];
           if (after.date !== before.date) {
             fail(`S3: inventory date mismatch at index ${i} — before=${before.date}, after=${after.date}`);
             process.exitCode = 1;
             return;
           }
           if (after.total_rooms !== before.total_rooms) {
             fail(`S3: total_rooms changed on ${before.date} — before=${before.total_rooms}, after=${after.total_rooms}`);
             process.exitCode = 1;
             return;
           }
           if (before.reserved_qty !== 1 || after.reserved_qty !== 0) {
             fail(`S3: reserved_qty did not decrement 1→0 on ${before.date} — before=${before.reserved_qty}, after=${after.reserved_qty}`);
             process.exitCode = 1;
             return;
           }
         }
         pass(`S3: inventory reserved_qty decremented 1→0 on ${s3InventorySnapshot.length} date(s); total_rooms unchanged`);

         // 4. Canonical balance still 0
         const s3FinBalance = await calculateHotelCollectibleBalance(
           s3DbClient, s3Chain.reservationId, s3PropertyId, 'HOTEL_COLLECT'
         );
         if (
           s3FinBalance == null
           || typeof s3FinBalance !== 'object'
           || !('hotel_collectible_remaining_balance' in s3FinBalance)
         ) {
           fail('S3: post-checkout balance response missing hotel_collectible_remaining_balance');
           process.exitCode = 1;
           return;
         }
         const s3FinRemaining = s3FinBalance.hotel_collectible_remaining_balance;
         if (s3FinRemaining == null || !Number.isFinite(s3FinRemaining) || s3FinRemaining !== 0) {
           fail(`S3: post-checkout balance not zero (got ${s3FinRemaining})`);
           process.exitCode = 1;
           return;
         }
         pass('S3: canonical balance still 0 after checkout');

          // 5. Audit: CHECK_OUT on RESERVATION — exactly 1 row (fresh fixture property)
          const s3AuditChkR = await s3DbClient.query(
            `SELECT COUNT(*)::int AS n FROM audit_logs
             WHERE property_id = $1 AND action = 'CHECK_OUT' AND entity = 'RESERVATION' AND record_id = $2`,
            [s3PropertyId, String(s3Chain.reservationId)]
          );
          if (Number(s3AuditChkR.rows[0].n) !== 1) {
            fail(`S3: audit_logs CHECK_OUT/RESERVATION count wrong — expected 1, got ${s3AuditChkR.rows[0].n}`);
            process.exitCode = 1;
            return;
          }
          pass('S3: audit_logs contains exactly 1 CHECK_OUT (RESERVATION) entry');

          // 6. Audit: COMPLETE on BOOKING — exactly 1 row; new_value is TEXT (JSON.parse)
          const s3AuditCmpR = await s3DbClient.query(
            `SELECT new_value FROM audit_logs
             WHERE property_id = $1 AND action = 'COMPLETE' AND entity = 'BOOKING' AND record_id = $2`,
            [s3PropertyId, s3Chain.bookingId]
          );
          if (s3AuditCmpR.rows.length !== 1) {
            fail(`S3: audit_logs COMPLETE/BOOKING count wrong — expected 1, got ${s3AuditCmpR.rows.length}`);
            process.exitCode = 1;
            return;
          }
          // new_value is TEXT per schema (audit_logs.new_value TEXT) — pg driver returns a string
          const s3CmpRaw = s3AuditCmpR.rows[0].new_value;
          if (typeof s3CmpRaw !== 'string') {
            fail(`S3: audit_logs.new_value unexpected type (got ${typeof s3CmpRaw})`);
            process.exitCode = 1;
            return;
          }
          let s3CmpPayload;
          try {
            s3CmpPayload = JSON.parse(s3CmpRaw);
          } catch (parseErr) {
            fail(`S3: audit_logs COMPLETE new_value not valid JSON: ${parseErr.message}`);
            process.exitCode = 1;
            return;
          }
          if (
            !s3CmpPayload
            || typeof s3CmpPayload !== 'object'
            || !('child_status_summary' in s3CmpPayload)
          ) {
            fail(`S3: booking completion audit payload missing child_status_summary (got ${JSON.stringify(s3CmpPayload)})`);
            process.exitCode = 1;
            return;
          }
          if (Number(s3CmpPayload.booking_id) !== Number(s3Chain.bookingId)) {
            fail(`S3: audit payload booking_id wrong (got ${s3CmpPayload.booking_id}, expected ${s3Chain.bookingId})`);
            process.exitCode = 1;
            return;
          }
          if (Number(s3CmpPayload.trigger_reservation_id) !== Number(s3Chain.reservationId)) {
            fail(`S3: audit payload trigger_reservation_id wrong (got ${s3CmpPayload.trigger_reservation_id}, expected ${s3Chain.reservationId})`);
            process.exitCode = 1;
            return;
          }
          if (String(s3CmpPayload.new_status) !== 'COMPLETED') {
            fail(`S3: audit payload new_status not COMPLETED (got ${JSON.stringify(s3CmpPayload.new_status)})`);
            process.exitCode = 1;
            return;
          }
          const s3Summary = s3CmpPayload.child_status_summary;
          if (
            !s3Summary
            || typeof s3Summary !== 'object'
            || Number(s3Summary.checkedOut) !== 1
          ) {
            fail(`S3: child_status_summary wrong (expected checkedOut=1, got ${JSON.stringify(s3Summary)})`);
            process.exitCode = 1;
            return;
          }
          pass('S3: audit_logs COMPLETE (BOOKING) has booking_id, trigger_reservation_id, new_status=COMPLETED, child_status_summary.checkedOut=1');

          // 7. Housekeeping: ensureCheckoutRoomCleaningTask → ensureDirtyRoomCleaningTask
          //    production contract: task_type='ROOM_CLEANING', source_type='CHECKOUT_EVENT'
          //    (feature housekeeping.room_operations defaults to true; fixture has no pre-existing tasks)
          const s3HkR = await s3DbClient.query(
            `SELECT COUNT(*)::int AS n FROM housekeeping_tasks
             WHERE property_id = $1
               AND task_type = 'ROOM_CLEANING'
               AND source_type = 'CHECKOUT_EVENT'
               AND room_id = $2`,
            [s3PropertyId, s3Chain.roomId]
          );
          if (Number(s3HkR.rows[0].n) !== 1) {
            fail(`S3: housekeeping ROOM_CLEANING/CHECKOUT_EVENT task not created for room ${s3Chain.roomId} (got ${s3HkR.rows[0].n})`);
            process.exitCode = 1;
            return;
          }
          pass('S3: housekeeping ROOM_CLEANING task created by ensureCheckoutRoomCleaningTask');

         await s3DbClient.query('COMMIT');
         s3DbTxActive = false;
       } catch (err) {
         fail('S3: post-request DB assertions', err);
         process.exitCode = 1;
         return;
       } finally {
         if (s3DbTxActive) {
           try { await s3DbClient.query('ROLLBACK'); } catch (rbErr) {
             fail('S3: dbClient ROLLBACK', rbErr);
             process.exitCode = 1;
           }
         }
         try { s3DbClient.release(); } catch (relErr) {
           fail('S3: dbClient release', relErr);
           process.exitCode = 1;
         }
       }

  } catch (err) {
    fail('Main error', err);
    process.exitCode = 1;
  } finally {
    // ── S2: barrier release, await handler requests, destroy observer, close S2 server ──
    // Runs on EVERY exit path (normal return, early return, catch)
    if (s2Barrier) {
      try { s2Barrier.release(); } catch (err) {
        fail('S2: barrier release in outer finally', err);
        process.exitCode = 1;
      }
    }
    if (s2CreatePromise) {
      try { await s2CreatePromise; } catch (_) { /* already reported */ }
    }
    if (s2CheckoutPromise) {
      try { await s2CheckoutPromise; } catch (_) { /* already reported */ }
    }
    if (s2ObserverClient) {
      try { s2ObserverClient.release(true); } catch (err) {
        fail('S2: observer release in outer finally', err);
        process.exitCode = 1;
      }
      s2ObserverClient = null;
    }
    if (s2HttpServer) {
      try {
        await new Promise((resolve, reject) => {
          s2HttpServer.close((err) => err ? reject(err) : resolve());
        });
      } catch (err) {
        fail('S2: server close in outer finally', err);
        process.exitCode = 1;
      }
      s2HttpServer = null;
    }

    // ── S3: barrier release, await handler requests, destroy observer, close S3 server ──
    if (s3Barrier) {
      try { s3Barrier.release(); } catch (err) {
        fail('S3: barrier release in outer finally', err);
        process.exitCode = 1;
      }
    }
    if (s3CheckoutPromise) {
      try { await s3CheckoutPromise; } catch (err) {
        fail('S3: checkout promise in outer finally', err);
        process.exitCode = 1;
      }
    }
    if (s3CreatePromise) {
      try { await s3CreatePromise; } catch (err) {
        fail('S3: create promise in outer finally', err);
        process.exitCode = 1;
      }
    }
    if (s3ObserverClient) {
      try { s3ObserverClient.release(true); } catch (err) {
        fail('S3: observer release in outer finally', err);
        process.exitCode = 1;
      }
      s3ObserverClient = null;
    }
    if (s3HttpServer) {
      try {
        await new Promise((resolve, reject) => {
          s3HttpServer.close((err) => err ? reject(err) : resolve());
        });
      } catch (err) {
        fail('S3: server close in outer finally', err);
        process.exitCode = 1;
      }
      s3HttpServer = null;
    }

    // ─�� S1: close server, cleanup, residue, release all ──
    if (httpServer) {
      try {
        await new Promise((resolve, reject) => {
          httpServer.close((err) => err ? reject(err) : resolve());
        });
      } catch (err) {
        fail('Server close', err);
        process.exitCode = 1;
      }
      httpServer = null;
    }

    const hasFixtures = identityVerified && tracked.properties.length > 0;
    if (hasFixtures) {
      try {
        cleanupClient = await pool.connect();
      } catch (err) {
        fail('Cleanup connect', err);
        process.exitCode = 1;
      }
      if (cleanupClient) {
        try {
          await cleanupFixtures(cleanupClient);
          console.log('[CLEANUP] OK');
        } catch (err) {
          fail('Cleanup', err);
          process.exitCode = 1;
        }
      }

      try {
        verifyClient = await pool.connect();
      } catch (err) {
        fail('Verify connect', err);
        process.exitCode = 1;
      }
      if (verifyClient) {
        try {
          const residue = await verifyNoResidue(verifyClient);
          if (residue.length > 0) {
            for (const r of residue) fail(`Residue: ${r}`);
            process.exitCode = 1;
          } else {
            console.log('[RESIDUE] 0');
          }
        } catch (err) {
          fail('Residue check', err);
          process.exitCode = 1;
        }
      }
    }

    if (cleanupClient) {
      try { cleanupClient.release(); } catch (err) {
        fail('Cleanup release', err);
        process.exitCode = 1;
      }
    }
    if (verifyClient) {
      try { verifyClient.release(); } catch (err) {
        fail('Verify release', err);
        process.exitCode = 1;
      }
    }
    try { await pool.end(); } catch (err) {
      fail('Pool end', err);
      process.exitCode = 1;
    }

    // Final summary
    console.log(`\n── S1–S3 POS Checkout Guard Test Summary ──`);
    console.log(`PASS: ${passed}`);
    console.log(`FAIL: ${failed}`);
    if (failed > 0) {
      console.log(`Result: FAIL (${failed} assertion(s) failed)`);
    } else if (passed > 0) {
      console.log('Result: ALL PASSED');
    } else {
      console.log('Result: NO ASSERTIONS EXECUTED');
    }
  }
})().catch((err) => {
  fail('Unhandled main error', err);
  process.exitCode = 1;
});