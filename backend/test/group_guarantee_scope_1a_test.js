/**
 * group_guarantee_scope_1a_test.js
 *
 * GROUP-GUARANTEE-SCOPE-1A — BOOKING_GROUP guarantee creation + check-in visibility
 *
 * T21 – Real single-room booking, omitted scope defaults to ROOM_RESERVATION
 * T22 – create BOOKING_GROUP deposit => exactly one canonical deposit row
 * T23 – group deposit visible to both child check-in gates
 * T24 – unrelated booking under SAME property cannot use group deposit
 * T25 – cross-property reservation cannot use group deposit
 * T26 – group identity custody => exactly one canonical custody row
 * T27 – group identity visible to both covered children
 * T28 – no sibling deposit/custody duplication
 * T29 – group deposit does NOT alter sibling reservations.applied_deposit
 * T30 – real single-room booking with ROOM_RESERVATION deposit passes guarantee
 * T31 – invalid deposit scope rejects with INVALID_SCOPE
 * T32 – invalid custody scope rejects with INVALID_SCOPE
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Pool } = require('pg');
const { receiveDeposit, deriveDepositBalance } = require('../dist/domains/deposits/depositService');
const { holdIdentity, returnIdentity } = require('../dist/domains/identity/identityCustodyService');
const { evaluatePreCheckinEligibility } = require('../dist/domains/checkin/checkinGateService');
const { generateToken } = require('../dist/domains/auth/authService');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

const runId = `1A-${String(Date.now()).slice(-8)}`;
let passed = 0;
let failed = 0;
const artifacts = {
  pids: [], rts: [], rooms: [], bookingIds: [], reserveIds: [],
  depIds: [], custIds: [], txIds: [], rtsByPid: {}
};

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS | ${name}`);
  } catch (error) {
    failed += 1;
    process.exitCode = 1;
    console.error(`FAIL | ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

function actor() {
  return { userId: '1', name: 'Test FO', role: 'Front Office' };
}

// ─── Fixture helpers ────────────────────────────────────────────────────────
async function createProperty(pool, suffix) {
  let propRes;
  while (true) {
    const code = `GS${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`;
    try {
      propRes = await pool.query(
        'INSERT INTO properties (name, property_code) VALUES ($1, $2) RETURNING id',
        [`gs-scope-1a-${runId}`, code]
      );
      break;
    } catch (e) {
      if (e?.code === '23505') continue;
      throw e;
    }
  }
  return Number(propRes.rows[0].id);
}

async function createRoomFixture(pool, pid, rtCode, i) {
  const rt = await pool.query(
    'INSERT INTO room_types (property_id, code, name, base_rate, is_active) VALUES ($1,$2,$3,500000,true) RETURNING id',
    [pid, rtCode, rtCode]
  );
  const rtId = Number(rt.rows[0].id);
  if (!artifacts.rtsByPid[pid]) artifacts.rtsByPid[pid] = [];
  artifacts.rtsByPid[pid].push(rtId);
  await pool.query(
    'INSERT INTO rate_plans (property_id, room_type_id, code, name, base_rate, meal_plan, rate_type, is_active, sort_order) VALUES ($1,$2,$3,$4,500000,$5,$6,true,0)',
    [pid, rtId, rtCode + 'RP', rtCode + 'RP', 'RO', 'OVERNIGHT']
  );
  await pool.query(
    `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
     VALUES ($1, $2, '2028-07-15'::date, 5, 0)
     ON CONFLICT (room_type, date) DO UPDATE SET total_rooms = 5, reserved_qty = 0`,
    [rtId, rtCode]
  );
  const room = await pool.query(
    "INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active) VALUES ($1,$2,$3,$4,'VACANT_CLEAN',true) RETURNING id",
    [pid, rtId, rtCode + 'R', rtCode + 'R']
  );
  return { rtId, rid: Number(room.rows[0].id) };
}

async function createBooking({ pool, pid, roomIds, guestName, runId }) {
  const rooms = Array.isArray(roomIds) ? roomIds : [roomIds];
  const token = generateToken({
    id: 1, username: 'FO.TEST', email: 'fo@test.com', full_name: 'Test FO',
    role: 'Super Admin', role_id: 1, property_id: 1, scope: 'FULL'
  });
  const reservations = rooms.map((rid, i) => ({
    room_id: rid,
    check_in: '2028-07-15', check_out: '2028-07-16', stay_type: 'OVERNIGHT',
    guest_name: `${guestName}-${i}`, subtotal_amount: 500000, total_price: 500000,
    is_manual_override: true, qty: 1
  }));
  const body = {
    property_id: pid,
    guest_name: guestName, guest_phone: '09171234567',
    booking_channel: 'WALK_IN', booking_source: 'WALKIN',
    has_valid_identity: true, identity_number: `31710101019900${String(Math.floor(Math.random() * 10)).padStart(2, '0')}`,
    ktp_path: '/test/ktp.jpg',
    payment_method: 'CASH', amount_paid: reservations.reduce((s, r) => s + r.total_price, 0),
    bukti_bayar_path: '/test/evidence.jpg',
    reservations
  };
  const { createCanonicalBooking } = require('../dist/index');
  const result = await createCanonicalBooking(
    { user: { username: 'FO.TEST', name: 'Test FO' }, body, headers: {} },
    body, body.reservations, { requirePropertyId: true }
  );
  const bookingId = Number(result.booking.id);
  const reserveRows = await pool.query(
    'SELECT id FROM reservations WHERE booking_id = $1 ORDER BY id',
    [bookingId]
  );
  const reserveIds = reserveRows.rows.map(r => Number(r.id));
  return { bookingId, reserveIds };
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────
const cleanupErrors = [];
async function cleanup() {
  // Child-first FK-safe order for each property
  for (const pid of artifacts.pids) {
    const steps = [
      // Evidences: may have NULL property_id — use reservation join
      ['payment_evidences', `DELETE FROM payment_evidences WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1))`, [pid]],
      ['payment_allocations', 'DELETE FROM payment_allocations WHERE property_id = $1', [pid]],
      ['folio_entries', 'DELETE FROM folio_entries WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1))', [pid]],
      ['deposit_events', 'DELETE FROM deposit_events WHERE deposit_id IN (SELECT id FROM deposits WHERE property_id = $1)', [pid]],
      ['deposits', 'DELETE FROM deposits WHERE property_id = $1', [pid]],
      ['identity_custody', 'DELETE FROM identity_custody WHERE property_id = $1', [pid]],
      // Payment transactions: catch both scoped AND legacy NULL-property rows
      ['payment_transactions', `DELETE FROM payment_transactions WHERE property_id = $1 OR reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1))`, [pid]],
      // Nightly rates BEFORE rate_plans (FK dependency)
      ['reservation_nightly_rates', 'DELETE FROM reservation_nightly_rates WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1))', [pid]],
      // Reservations BEFORE bookings, rate_plans, rooms, room_types (FK deps)
      ['reservations', 'DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1)', [pid]],
      // Availability BEFORE room_types (FK dependency) — use per-property list
      ['availability', 'DELETE FROM availability_dates WHERE room_type_id = ANY($1::int[])', [artifacts.rtsByPid[pid] || []]],
      // Rooms — delete ALL rooms for this property (booking might have added rooms)
      ['rooms', 'DELETE FROM rooms WHERE property_id = $1', [pid]],
      // Bookings (must come after reservations deleted)
      ['bookings', 'DELETE FROM bookings WHERE property_id = $1', [pid]],
      // Rate plans AFTER reservations (FK: reservations_rate_plan_id_fkey)
      ['rate_plans', 'DELETE FROM rate_plans WHERE property_id = $1', [pid]],
      // Room types AFTER rooms (FK: rooms_room_type_id_fkey)
      ['room_types', 'DELETE FROM room_types WHERE property_id = $1', [pid]],
      // Transactions (possibly referencing property directly)
      ['transactions', 'DELETE FROM transactions WHERE property_id = $1', [pid]],
      ['property_pricing_settings', 'DELETE FROM property_pricing_settings WHERE property_id = $1', [pid]],
      // Audit logs BEFORE properties (FK: fk_audit_logs_property)
      ['audit_logs', 'DELETE FROM audit_logs WHERE property_id = $1', [pid]],
      ['properties', 'DELETE FROM properties WHERE id = $1', [pid]],
    ];
    for (const [label, sql, params] of steps) {
      try {
        await pool.query(sql, params);
      } catch (e) {
        cleanupErrors.push(`[${label} pid=${pid}] ${e.message}`);
      }
    }
  }
  // Zero-residue verification — any non-zero is a test defect
  const residue = [];
  for (const pid of artifacts.pids) {
    const checks = [
      { table: 'deposits', where: `property_id = ${pid}` },
      { table: 'deposit_events', where: `deposit_id IN (SELECT id FROM deposits WHERE property_id = ${pid})` },
      { table: 'identity_custody', where: `property_id = ${pid}` },
      { table: 'payment_transactions', where: `property_id = ${pid}` },
      { table: 'payment_evidences', where: `reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = ${pid}))` },
      { table: 'payment_allocations', where: `property_id = ${pid}` },
      { table: 'folio_entries', where: `reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = ${pid}))` },
      { table: 'reservations', where: `booking_id IN (SELECT id FROM bookings WHERE property_id = ${pid})` },
      { table: 'bookings', where: `property_id = ${pid}` },
      { table: 'rooms', where: `property_id = ${pid} AND room_number LIKE 'GS%'` },
      { table: 'rate_plans', where: `property_id = ${pid}` },
      { table: 'room_types', where: `property_id = ${pid}` },
      { table: 'properties', where: `id = ${pid}` },
    ];
    for (const c of checks) {
      const r = await pool.query(`SELECT COUNT(*) AS cnt FROM ${c.table} WHERE ${c.where}`);
      if (parseInt(r.rows[0].cnt) !== 0) {
        residue.push(`${c.table} pid=${pid}: ${r.rows[0].cnt} rows`);
      }
    }
  }
  if (cleanupErrors.length > 0 || residue.length > 0) {
    for (const e of cleanupErrors) console.error('CLEANUP-ERROR:', e);
    for (const r of residue) console.error('RESIDUE:', r);
    throw new Error(`Cleanup failed: ${cleanupErrors.length} errors, ${residue.length} residue violations`);
  }
  // Stronger zero-residue: verify exact IDs no longer exist
  const strongResidue = [];
  for (const id of artifacts.depIds) {
    const r = await pool.query('SELECT COUNT(*) AS cnt FROM deposits WHERE id = $1', [id]);
    if (parseInt(r.rows[0].cnt) !== 0) strongResidue.push(`deposit id=${id} still exists`);
  }
  for (const id of artifacts.custIds) {
    const r = await pool.query('SELECT COUNT(*) AS cnt FROM identity_custody WHERE id = $1', [id]);
    if (parseInt(r.rows[0].cnt) !== 0) strongResidue.push(`custody id=${id} still exists`);
  }
  for (const id of artifacts.reserveIds) {
    const r = await pool.query('SELECT COUNT(*) AS cnt FROM reservations WHERE id = $1', [id]);
    if (parseInt(r.rows[0].cnt) !== 0) strongResidue.push(`reservation id=${id} still exists`);
  }
  for (const id of artifacts.bookingIds) {
    const r = await pool.query('SELECT COUNT(*) AS cnt FROM bookings WHERE id = $1', [id]);
    if (parseInt(r.rows[0].cnt) !== 0) strongResidue.push(`booking id=${id} still exists`);
  }
  if (strongResidue.length > 0) {
    for (const r of strongResidue) console.error('STRONG-RESIDUE:', r);
    throw new Error(`Strong residue verification failed: ${strongResidue.length} items`);
  }
  await pool.end();
}

// ─── Tests ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== GROUP-GUARANTEE-SCOPE-1A (${runId}) ===\n`);

  // ── Setup: Group booking (2-room) under pid1 ────────────────────────────
  const pid1 = await createProperty(pool, 'GRP');
  artifacts.pids.push(pid1);
  const { rtId: gRt1, rid: gRid1 } = await createRoomFixture(pool, pid1, 'GRT1', 1);
  const { rtId: gRt2, rid: gRid2 } = await createRoomFixture(pool, pid1, 'GRT2', 2);
  artifacts.rts.push(gRt1, gRt2);
  artifacts.rooms.push(gRid1, gRid2);
  const { bookingId: grpBookingId, reserveIds: [grpRes1, grpRes2] } = await createBooking({
    pool, pid: pid1, roomIds: [gRid1, gRid2], guestName: 'Group Guest', runId
  });
  artifacts.bookingIds.push(grpBookingId);
  artifacts.reserveIds.push(grpRes1, grpRes2);

  // ── Setup: Single-room booking (for T21 real regression) under pid1 ─────
  const { rtId: sRt1, rid: sRid1 } = await createRoomFixture(pool, pid1, 'SRT1', 3);
  artifacts.rts.push(sRt1);
  artifacts.rooms.push(sRid1);
  const { bookingId: singleBookingId, reserveIds: [singleRes] } = await createBooking({
    pool, pid: pid1, roomIds: sRid1, guestName: 'Single Guest', runId
  });
  artifacts.bookingIds.push(singleBookingId);
  artifacts.reserveIds.push(singleRes);

  // ── Setup: Unrelated single-room booking under SAME property (for T24) ──
  const { rtId: uRt1, rid: uRid1 } = await createRoomFixture(pool, pid1, 'URT1', 4);
  artifacts.rts.push(uRt1);
  artifacts.rooms.push(uRid1);
  const { bookingId: unrelBookingId, reserveIds: [unrelRes] } = await createBooking({
    pool, pid: pid1, roomIds: uRid1, guestName: 'Unrelated Guest', runId
  });
  artifacts.bookingIds.push(unrelBookingId);
  artifacts.reserveIds.push(unrelRes);

  // ── Setup: Cross-property booking (for T25) ─────────────────────────────
  const pid2 = await createProperty(pool, 'XPR');
  artifacts.pids.push(pid2);
  const { rtId: xRt1, rid: xRid1 } = await createRoomFixture(pool, pid2, 'XRT1', 5);
  artifacts.rts.push(xRt1);
  artifacts.rooms.push(xRid1);
  const { bookingId: xBookingId, reserveIds: [xRes] } = await createBooking({
    pool, pid: pid2, roomIds: xRid1, guestName: 'Cross Prop Guest', runId
  });
  artifacts.bookingIds.push(xBookingId);
  artifacts.reserveIds.push(xRes);

  // ══════════════════════════════════════════════════════════════════════════
  // T21 — Real single-room booking: omitted scope defaults to ROOM_RESERVATION
  // ══════════════════════════════════════════════════════════════════════════
  await test('T21 — real single-room: omitted scope defaults to ROOM_RESERVATION', async () => {
    const dep = await receiveDeposit(pool, {
      propertyId: pid1,
      reservationId: singleRes,
      amount: 500000,
      paymentMethod: 'CASH',
      idempotencyKey: `t21-${runId}`,
      actor: actor()
      // scope omitted — should default to ROOM_RESERVATION
    });
    artifacts.depIds.push(dep.id);
    const row = await pool.query(
      "SELECT scope, reservation_id, booking_id FROM deposits WHERE id = $1",
      [dep.id]
    );
    if (row.rows[0].scope !== 'ROOM_RESERVATION') throw new Error(`Expected ROOM_RESERVATION, got ${row.rows[0].scope}`);
    if (Number(row.rows[0].reservation_id) !== singleRes) throw new Error(`Expected reservation_id=${singleRes}`);
    if (Number(row.rows[0].booking_id) !== singleBookingId) throw new Error(`Expected booking_id=${singleBookingId}`);
    // Verify guarantee_ok via check-in gate
    const el = await evaluatePreCheckinEligibility(pool, pid1, singleRes);
    if (!el.guarantee_ok) throw new Error('Single-room ROOM_RES deposit should satisfy guarantee');
    if (el.missing.some(m => m.code === 'GUARANTEE_MISSING')) throw new Error('Should not have GUARANTEE_MISSING');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T22 — Create BOOKING_GROUP deposit => exactly one canonical row
  // ══════════════════════════════════════════════════════════════════════════
  await test('T22 — create BOOKING_GROUP deposit => exactly one canonical row', async () => {
    const dep = await receiveDeposit(pool, {
      propertyId: pid1, reservationId: grpRes1,
      amount: 300000, paymentMethod: 'CASH',
      idempotencyKey: `t22-${runId}`, actor: actor(),
      scope: 'BOOKING_GROUP'
    });
    artifacts.depIds.push(dep.id);
    const allGrp = await pool.query(
      "SELECT COUNT(*) AS cnt FROM deposits WHERE booking_id = $1 AND scope = 'BOOKING_GROUP'",
      [grpBookingId]
    );
    if (parseInt(allGrp.rows[0].cnt) !== 1) throw new Error('Expected exactly 1 group deposit');
    const row = await pool.query(
      "SELECT id, booking_id, reservation_id, scope, original_amount FROM deposits WHERE id = $1",
      [dep.id]
    );
    if (row.rows[0].scope !== 'BOOKING_GROUP') throw new Error(`Expected BOOKING_GROUP, got ${row.rows[0].scope}`);
    if (Number(row.rows[0].booking_id) !== grpBookingId) throw new Error(`Group deposit booking_id mismatch`);
    const events = await pool.query('SELECT * FROM deposit_events WHERE deposit_id = $1 ORDER BY id', [dep.id]);
    const balance = deriveDepositBalance(events.rows);
    if (balance.remaining !== 300000) throw new Error(`Expected remaining=300000, got ${balance.remaining}`);
    if (balance.status !== 'RECEIVED') throw new Error(`Expected RECEIVED, got ${balance.status}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T23 — Group deposit visible to both child check-in gates
  // ══════════════════════════════════════════════════════════════════════════
  await test('T23 — group deposit visible to both child check-in gates', async () => {
    const elRes1 = await evaluatePreCheckinEligibility(pool, pid1, grpRes1);
    const elRes2 = await evaluatePreCheckinEligibility(pool, pid1, grpRes2);
    if (!elRes1.guarantee_ok) throw new Error('grpRes1 should have guarantee_ok=true');
    if (!elRes2.guarantee_ok) throw new Error('grpRes2 should have guarantee_ok=true');
    for (const e of [elRes1, elRes2]) {
      if (e.missing.some(m => m.code === 'GUARANTEE_MISSING')) throw new Error('Unexpected GUARANTEE_MISSING');
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T24 — Unrelated booking under SAME property cannot use group deposit
  // ══════════════════════════════════════════════════════════════════════════
  await test('T24 — unrelated booking under SAME property cannot use group deposit', async () => {
    // unrelRes is in pid1 (same property) but belongs to a different booking
    // It must NOT gain guarantee_ok from grpBookingId's group deposit
    const elUnrel = await evaluatePreCheckinEligibility(pool, pid1, unrelRes);
    if (!elUnrel.missing.some(m => m.code === 'GUARANTEE_MISSING')) {
      throw new Error('Unrelated same-property reservation should have GUARANTEE_MISSING');
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T25 — Cross-property reservation cannot use group deposit
  // ══════════════════════════════════════════════════════════════════════════
  await test('T25 — cross-property reservation cannot use group deposit', async () => {
    const elWrongProp = await evaluatePreCheckinEligibility(pool, pid2, xRes);
    if (elWrongProp.eligible) throw new Error('Cross-property should not see our group deposit');
    if (!elWrongProp.missing.some(m => m.code === 'GUARANTEE_MISSING')) {
      throw new Error('Cross-property should report GUARANTEE_MISSING');
    }
  });

  // ═══════════════════��══════════════════════════════════════════════════════
  // T26 — Group identity custody => exactly one canonical row
  // ══════════════════════════════════════════════════════════════════════════
  await test('T26 — group identity custody => exactly one canonical row', async () => {
    const cust = await holdIdentity(pool, {
      propertyId: pid1, reservationId: grpRes1,
      documentType: 'KTP', documentHolderName: 'Group Guest',
      storageLocation: 'Safe A', notes: 'Group KTP', actor: actor(),
      scope: 'BOOKING_GROUP'
    });
    artifacts.custIds.push(cust.id);
    const allGrp = await pool.query(
      "SELECT COUNT(*) AS cnt FROM identity_custody WHERE booking_id = $1 AND scope = 'BOOKING_GROUP'",
      [grpBookingId]
    );
    if (parseInt(allGrp.rows[0].cnt) !== 1) throw new Error('Expected exactly 1 group custody');
    const row = await pool.query(
      "SELECT scope, booking_id, reservation_id, status FROM identity_custody WHERE id = $1",
      [cust.id]
    );
    if (row.rows[0].scope !== 'BOOKING_GROUP') throw new Error(`Expected BOOKING_GROUP, got ${row.rows[0].scope}`);
    if (Number(row.rows[0].booking_id) !== grpBookingId) throw new Error('Group custody booking_id mismatch');
    if (row.rows[0].status !== 'HELD') throw new Error('Expected HELD');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T24b — Identity same-property isolation: unrelated booking cannot use group custody
  // ══════════════════════════════════════════════════════════════════════════
  await test('T24b — identity same-property isolation: unrelated booking GUARANTEE_MISSING after group custody', async () => {
    // unrelRes is in pid1 (same property) but belongs to a different booking
    // After T26 creates group custody, unrelRes must still NOT gain guarantee_ok
    const elUnrel = await evaluatePreCheckinEligibility(pool, pid1, unrelRes);
    if (!elUnrel.missing.some(m => m.code === 'GUARANTEE_MISSING')) {
      throw new Error('Unrelated same-property reservation should still have GUARANTEE_MISSING after group custody creation');
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T27 — Group identity visible to both covered children
  // ══════════════════════════════════════════════════════════════════════════
  await test('T27 — group identity visible to both covered children', async () => {
    const elRes1 = await evaluatePreCheckinEligibility(pool, pid1, grpRes1);
    const elRes2 = await evaluatePreCheckinEligibility(pool, pid1, grpRes2);
    if (!elRes1.guarantee_ok) throw new Error('grpRes1 should pass guarantee with group custody');
    if (!elRes2.guarantee_ok) throw new Error('grpRes2 should pass guarantee with group custody');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T28 — No sibling deposit/custody duplication
  // ══════════════════════════════════════════════════════════════════════════
  await test('T28 — no sibling deposit/custody duplication', async () => {
    const grpDepCount = await pool.query(
      "SELECT COUNT(*) AS cnt FROM deposits WHERE booking_id = $1 AND scope = 'BOOKING_GROUP'",
      [grpBookingId]
    );
    if (parseInt(grpDepCount.rows[0].cnt) !== 1) throw new Error(`Expected 1 group deposit, got ${grpDepCount.rows[0].cnt}`);
    const grpCustCount = await pool.query(
      "SELECT COUNT(*) AS cnt FROM identity_custody WHERE booking_id = $1 AND scope = 'BOOKING_GROUP'",
      [grpBookingId]
    );
    if (parseInt(grpCustCount.rows[0].cnt) !== 1) throw new Error(`Expected 1 group custody, got ${grpCustCount.rows[0].cnt}`);
    // res2 has NO ROOM_RESERVATION-scoped deposit or custody
    const res2Dep = await pool.query(
      "SELECT COUNT(*) AS cnt FROM deposits WHERE reservation_id = $1 AND scope = 'ROOM_RESERVATION'",
      [grpRes2]
    );
    if (parseInt(res2Dep.rows[0].cnt) !== 0) throw new Error('res2 should have 0 ROOM_RESERVATION deposits');
    const res2Cust = await pool.query(
      "SELECT COUNT(*) AS cnt FROM identity_custody WHERE reservation_id = $1 AND scope = 'ROOM_RESERVATION'",
      [grpRes2]
    );
    if (parseInt(res2Cust.rows[0].cnt) !== 0) throw new Error('res2 should have 0 ROOM_RESERVATION custody records');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T29 — Group deposit does NOT alter sibling reservations.applied_deposit
  // ══════════════════════════════════════════════════════════════════════════
  await test('T29 — group deposit does NOT alter sibling reservations.applied_deposit', async () => {
    const res2Folio = await pool.query(
      "SELECT COUNT(*) AS cnt FROM folio_entries WHERE reservation_id = $1 AND entry_type = 'DEPOSIT_APPLY'",
      [grpRes2]
    );
    if (parseInt(res2Folio.rows[0].cnt) !== 0) throw new Error('Group deposit should not create DEPOSIT_APPLY folio entries');
    const res2Fin = await pool.query('SELECT applied_deposit FROM reservations WHERE id = $1', [grpRes2]);
    if (parseInt(res2Fin.rows[0].applied_deposit) !== 0) {
      throw new Error(`res2 applied_deposit should be 0, got ${res2Fin.rows[0].applied_deposit}`);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T30 — Real single-room booking with ROOM_RESERVATION deposit passes guarantee
  // ══════════════════════════════════════════════════════════════════════════
  await test('T30 — real single-room ROOM_RESERVATION behavior unchanged', async () => {
    // singleRes already has a ROOM_RESERVATION deposit from T21 — verify it still passes
    const el = await evaluatePreCheckinEligibility(pool, pid1, singleRes);
    if (!el.guarantee_ok) throw new Error('ROOM_RESERVATION deposit should still satisfy guarantee');
    const roomResDep = await pool.query(
      "SELECT id, scope, status FROM deposits WHERE reservation_id = $1 AND scope = 'ROOM_RESERVATION'",
      [singleRes]
    );
    if (roomResDep.rows.length === 0) throw new Error('ROOM_RESERVATION deposit row missing');
    if (roomResDep.rows[0].scope !== 'ROOM_RESERVATION') throw new Error('ROOM_RESERVATION scope was changed');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T31 — Invalid deposit scope rejects with INVALID_SCOPE
  // ══════════════════════════════════════════════════════════════════════════
  await test('T31 — invalid deposit scope throws INVALID_SCOPE', async () => {
    for (const badScope of ['INVALID', 'room_reservation', 'Booking_Group', '', 'GROUP', 'RESERVATION', 123, 'book_group']) {
      try {
        await receiveDeposit(pool, {
          propertyId: pid1, reservationId: grpRes1,
          amount: 100000, paymentMethod: 'CASH',
          idempotencyKey: `t31-${badScope}-${runId}`,
          actor: actor(), scope: badScope
        });
        throw new Error(`Expected INVALID_SCOPE for scope=${JSON.stringify(badScope)}`);
      } catch (e) {
        if (e.code !== 'INVALID_SCOPE') throw new Error(`Expected INVALID_SCOPE for scope=${JSON.stringify(badScope)}, got ${e.code}: ${e.message}`);
      }
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T32 — Invalid custody scope rejects with INVALID_SCOPE
  // ══════════════════════════════════════════════════════════════════════════
  await test('T32 — invalid custody scope throws INVALID_SCOPE', async () => {
    for (const badScope of ['INVALID', 'room_reservation', 'Booking_Group', '', 'GROUP', 'RESERVATION', 123, 'book_group']) {
      try {
        await holdIdentity(pool, {
          propertyId: pid1, reservationId: grpRes1,
          documentType: 'KTP', documentHolderName: 'Guest', actor: actor(),
          scope: badScope
        });
        throw new Error(`Expected INVALID_SCOPE for scope=${JSON.stringify(badScope)}`);
      } catch (e) {
        if (e.code !== 'INVALID_SCOPE') throw new Error(`Expected INVALID_SCOPE for scope=${JSON.stringify(badScope)}, got ${e.code}: ${e.message}`);
      }
    }
  });

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);

  await cleanup();
  // Exit non-zero if any test failed or cleanup failed
  if (failed > 0 || cleanupErrors.length > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error('FATAL:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
