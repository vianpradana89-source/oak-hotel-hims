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
 * T33 – ROOM_RESERVATION deposit visible only to its own reservation
 * T34 – BOOKING_GROUP deposit visible from BOTH child reservations
 * T35 – sibling ROOM_RESERVATION deposit NOT leaked to other bookings
 * T36 – unrelated same-property booking cannot see group deposit (read)
 * T37 – cross-property cannot see group deposit (read)
 * T38 – ROOM_RESERVATION custody visible only to its own reservation
 * T39 – BOOKING_GROUP custody visible from BOTH child reservations
 * T40 – sibling does NOT receive sibling ROOM_RESERVATION custody
 * T41 – unrelated same-property booking cannot see group custody (read)
 * T42 – cross-property cannot see group custody (read)
 * T43 – no duplicate canonical rows in returned arrays
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Pool } = require('pg');
const assert = require('node:assert');
const { receiveDeposit, deriveDepositBalance, getDepositsByReservation } = require('../dist/domains/deposits/depositService');
const { holdIdentity, returnIdentity, getIdentityCustodyByReservation } = require('../dist/domains/identity/identityCustodyService');
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

  // ══════════════════════════════════════════════════════════════════════════
  // T33 — Direct ROOM_RESERVATION deposit on grpRes1 visible only to grpRes1
  // ══════════════════════════════════════════════════════════════════════════
  await test('T33 — direct ROOM_RESERVATION deposit on sibling is NOT shared', async () => {
    // Create a ROOM_RESERVATION deposit on grpRes1 (sibling of grpRes2)
    const directDep = await receiveDeposit(pool, {
      propertyId: pid1, reservationId: grpRes1,
      amount: 100000, paymentMethod: 'CASH',
      idempotencyKey: `t33-${runId}`, actor: actor(),
      scope: 'ROOM_RESERVATION'
    });
    artifacts.depIds.push(directDep.id);
    // grpRes1: should see BOTH its direct deposit AND the group deposit
    const depsRes1 = await getDepositsByReservation(pool, pid1, grpRes1);
    const directInRes1 = depsRes1.filter(d => d.id === directDep.id);
    if (directInRes1.length !== 1) throw new Error('grpRes1 must see its own direct deposit');
    const grpInRes1 = depsRes1.filter(d => d.scope === 'BOOKING_GROUP');
    if (grpInRes1.length !== 1) throw new Error('grpRes1 must still see the BOOKING_GROUP deposit');
    // grpRes2: should see ONLY the group deposit, NOT the direct one
    const depsRes2 = await getDepositsByReservation(pool, pid1, grpRes2);
    const directInRes2 = depsRes2.filter(d => d.id === directDep.id);
    if (directInRes2.length !== 0) throw new Error(`grpRes2 must NOT see sibling's direct deposit, got ${directInRes2.length}`);
    const grpInRes2 = depsRes2.filter(d => d.scope === 'BOOKING_GROUP');
    if (grpInRes2.length !== 1) throw new Error('grpRes2 must still see the BOOKING_GROUP deposit');
    // Global sort: ids must be ascending
    const ids1 = depsRes1.map(d => Number(d.id));
    const ids2 = depsRes2.map(d => Number(d.id));
    for (let i = 1; i < ids1.length; i++) if (ids1[i] < ids1[i - 1]) throw new Error('Deposit ids not globally sorted in grpRes1');
    for (let i = 1; i < ids2.length; i++) if (ids2[i] < ids2[i - 1]) throw new Error('Deposit ids not globally sorted in grpRes2');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T34 — BOOKING_GROUP deposit visible from BOTH child reservations (re-verify)
  // ══════════════════════════════════════════════════════════════════════════
  await test('T34 — BOOKING_GROUP deposit visible from BOTH child reservations', async () => {
    const depsRes1 = await getDepositsByReservation(pool, pid1, grpRes1);
    const grpDepInRes1 = depsRes1.filter(d => d.scope === 'BOOKING_GROUP');
    if (grpDepInRes1.length !== 1) throw new Error(`Expected 1 BOOKING_GROUP deposit for grpRes1, got ${grpDepInRes1.length}`);
    const depsRes2 = await getDepositsByReservation(pool, pid1, grpRes2);
    const grpDepInRes2 = depsRes2.filter(d => d.scope === 'BOOKING_GROUP');
    if (grpDepInRes2.length !== 1) throw new Error(`Expected 1 BOOKING_GROUP deposit for grpRes2, got ${grpDepInRes2.length}`);
    if (grpDepInRes1[0].id !== grpDepInRes2[0].id) throw new Error('Group deposit ids differ between children');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T35 — sibling does NOT receive sibling ROOM_RESERVATION deposit (re-verify)
  // ══════════════════════════════════════════════════════════════════════════
  await test('T35 — sibling ROOM_RESERVATION deposit NOT leaked to other bookings', async () => {
    const depsUnrel = await getDepositsByReservation(pool, pid1, unrelRes);
    if (depsUnrel.length !== 0) throw new Error(`Expected 0 deposits for unrelRes, got ${depsUnrel.length}`);
  });

  // ══════════════════════════════════════════════════���═══════════════════════
  // T36 — unrelated booking in SAME property cannot see group deposit
  // ══════════════════════════════════════════════════════════════════════════
  await test('T36 — unrelated same-property booking cannot see group deposit', async () => {
    const depsUnrel = await getDepositsByReservation(pool, pid1, unrelRes);
    if (depsUnrel.some(d => d.scope === 'BOOKING_GROUP')) throw new Error('Unrelated booking should not see BOOKING_GROUP deposit');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T37 — cross-property cannot see group deposit
  // ══════════════════════════════════════════════════════════════════════════
  await test('T37 — cross-property cannot see group deposit', async () => {
    const depsXprop = await getDepositsByReservation(pool, pid2, xRes);
    if (depsXprop.some(d => d.scope === 'BOOKING_GROUP')) throw new Error('Cross-property should not see BOOKING_GROUP deposit');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T38 — Direct ROOM_RESERVATION custody on grpRes1 visible only to grpRes1
  // ══════════════════════════════════════════════════════════════════════════
  await test('T38 — direct ROOM_RESERVATION custody on sibling is NOT shared', async () => {
    // Create a ROOM_RESERVATION custody on grpRes1
    const directCust = await holdIdentity(pool, {
      propertyId: pid1, reservationId: grpRes1,
      documentType: 'KTP', documentHolderName: 'Group Guest',
      storageLocation: 'Safe B', notes: 'Direct KTP', actor: actor(),
      scope: 'ROOM_RESERVATION'
    });
    artifacts.custIds.push(directCust.id);
    // grpRes1: should see BOTH its direct custody AND the group custody
    const custRes1 = await getIdentityCustodyByReservation(pool, pid1, grpRes1);
    const directInRes1 = custRes1.filter(c => c.id === directCust.id);
    if (directInRes1.length !== 1) throw new Error('grpRes1 must see its own direct custody');
    const grpInRes1 = custRes1.filter(c => c.scope === 'BOOKING_GROUP');
    if (grpInRes1.length !== 1) throw new Error('grpRes1 must still see the BOOKING_GROUP custody');
    // grpRes2: should see ONLY the group custody, NOT the direct one
    const custRes2 = await getIdentityCustodyByReservation(pool, pid1, grpRes2);
    const directInRes2 = custRes2.filter(c => c.id === directCust.id);
    if (directInRes2.length !== 0) throw new Error(`grpRes2 must NOT see sibling's direct custody, got ${directInRes2.length}`);
    const grpInRes2 = custRes2.filter(c => c.scope === 'BOOKING_GROUP');
    if (grpInRes2.length !== 1) throw new Error('grpRes2 must still see the BOOKING_GROUP custody');
    // Global sort: ids must be ascending
    const ids1 = custRes1.map(c => Number(c.id));
    const ids2 = custRes2.map(c => Number(c.id));
    for (let i = 1; i < ids1.length; i++) if (ids1[i] < ids1[i - 1]) throw new Error('Custody ids not globally sorted in grpRes1');
    for (let i = 1; i < ids2.length; i++) if (ids2[i] < ids2[i - 1]) throw new Error('Custody ids not globally sorted in grpRes2');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T39 — BOOKING_GROUP custody visible from BOTH child reservations (re-verify)
  // ══════════════════════════════════════════════════════════════════════════
  await test('T39 — BOOKING_GROUP custody visible from BOTH child reservations', async () => {
    const custRes1 = await getIdentityCustodyByReservation(pool, pid1, grpRes1);
    const grpCustInRes1 = custRes1.filter(c => c.scope === 'BOOKING_GROUP');
    if (grpCustInRes1.length !== 1) throw new Error(`Expected 1 BOOKING_GROUP custody for grpRes1, got ${grpCustInRes1.length}`);
    const custRes2 = await getIdentityCustodyByReservation(pool, pid1, grpRes2);
    const grpCustInRes2 = custRes2.filter(c => c.scope === 'BOOKING_GROUP');
    if (grpCustInRes2.length !== 1) throw new Error(`Expected 1 BOOKING_GROUP custody for grpRes2, got ${grpCustInRes2.length}`);
    if (grpCustInRes1[0].id !== grpCustInRes2[0].id) throw new Error('Group custody ids differ between children');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T40 — sibling does NOT receive sibling ROOM_RESERVATION custody (re-verify)
  // ══════════════════════════════════════════════════════════════════════════
  await test('T40 — sibling does NOT receive sibling ROOM_RESERVATION custody', async () => {
    const custRes2 = await getIdentityCustodyByReservation(pool, pid1, grpRes2);
    const roomCustRes2 = custRes2.filter(c => c.scope === 'ROOM_RESERVATION');
    if (roomCustRes2.length !== 0) throw new Error('grpRes2 should have 0 ROOM_RESERVATION custody records');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T41 — unrelated booking in SAME property cannot see group custody
  // ══════════════════════════════════════════════════════════════════════════
  await test('T41 — unrelated same-property booking cannot see group custody', async () => {
    const custUnrel = await getIdentityCustodyByReservation(pool, pid1, unrelRes);
    if (custUnrel.some(c => c.scope === 'BOOKING_GROUP')) throw new Error('Unrelated booking should not see BOOKING_GROUP custody');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T42 — cross-property cannot see group custody
  // ══════════════════════════════════════════════════════════════════════════
  await test('T42 — cross-property cannot see group custody', async () => {
    const custXprop = await getIdentityCustodyByReservation(pool, pid2, xRes);
    if (custXprop.some(c => c.scope === 'BOOKING_GROUP')) throw new Error('Cross-property should not see BOOKING_GROUP custody');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T43 — no duplicate canonical rows in returned arrays
  // ══════════════════════════════════════════════════════════════════════════
  await test('T43 — no duplicate canonical rows in returned arrays', async () => {
    const depsRes1 = await getDepositsByReservation(pool, pid1, grpRes1);
    const idsRes1 = depsRes1.map(d => d.id);
    if (idsRes1.length !== new Set(idsRes1).size) throw new Error('Duplicate deposit ids in grpRes1 result');
    const depsRes2 = await getDepositsByReservation(pool, pid1, grpRes2);
    const idsRes2 = depsRes2.map(d => d.id);
    if (idsRes2.length !== new Set(idsRes2).size) throw new Error('Duplicate deposit ids in grpRes2 result');
    const custRes1 = await getIdentityCustodyByReservation(pool, pid1, grpRes1);
    const custIdsRes1 = custRes1.map(c => c.id);
    if (custIdsRes1.length !== new Set(custIdsRes1).size) throw new Error('Duplicate custody ids in grpRes1 result');
    const custRes2 = await getIdentityCustodyByReservation(pool, pid1, grpRes2);
    const custIdsRes2 = custRes2.map(c => c.id);
    if (custIdsRes2.length !== new Set(custIdsRes2).size) throw new Error('Duplicate custody ids in grpRes2 result');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T44 — Global ordering: deposit and custody results are ascending by id
  // ══════════════════════════════════════════════════════════════════════════
  await test('T44 — global ordering: returned ids are ascending', async () => {
    const depsRes1 = await getDepositsByReservation(pool, pid1, grpRes1);
    const ids1 = depsRes1.map(d => Number(d.id));
    for (let i = 1; i < ids1.length; i++) if (ids1[i] < ids1[i - 1]) throw new Error(`Deposit order violation at index ${i}: ${ids1[i-1]} > ${ids1[i]}`);
    const depsRes2 = await getDepositsByReservation(pool, pid1, grpRes2);
    const ids2 = depsRes2.map(d => Number(d.id));
    for (let i = 1; i < ids2.length; i++) if (ids2[i] < ids2[i - 1]) throw new Error(`Deposit order violation at index ${i}: ${ids2[i-1]} > ${ids2[i]}`);
    const custRes1 = await getIdentityCustodyByReservation(pool, pid1, grpRes1);
    const cids1 = custRes1.map(c => Number(c.id));
    for (let i = 1; i < cids1.length; i++) if (cids1[i] < cids1[i - 1]) throw new Error(`Custody order violation at index ${i}: ${cids1[i-1]} > ${cids1[i]}`);
    const custRes2 = await getIdentityCustodyByReservation(pool, pid1, grpRes2);
    const cids2 = custRes2.map(c => Number(c.id));
    for (let i = 1; i < cids2.length; i++) if (cids2[i] < cids2[i - 1]) throw new Error(`Custody order violation at index ${i}: ${cids2[i-1]} > ${cids2[i]}`);
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
