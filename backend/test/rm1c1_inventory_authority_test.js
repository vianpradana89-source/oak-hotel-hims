'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const fetchFn = global.fetch || require('node-fetch');
const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:5000';
const runId = `RM1C1-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const reconciliationScriptPath = path.join(__dirname, '..', 'scripts', 'rm_1c1_capacity_reconciliation.js');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'secretpassword',
  database: process.env.PGDATABASE || 'oak_hotel_db'
});

function expect(condition, message) {
  if (!condition) {
    throw new Error(`ASSERT FAILED: ${message}`);
  }
}

async function request(method, path, body, correlationSuffix = '') {
  const correlationId = `${runId}${correlationSuffix ? `-${correlationSuffix}` : ''}`;
  const resp = await fetchFn(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': correlationId },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_e) {
    json = null;
  }
  return { status: resp.status, text, json, correlationId };
}

function addDays(dateKey, offset) {
  const base = new Date(`${dateKey}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + offset);
  return base.toISOString().slice(0, 10);
}

async function todayJakarta(client) {
  const result = await client.query("SELECT (NOW() AT TIME ZONE 'Asia/Jakarta')::date AS d");
  return new Date(result.rows[0].d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

async function seedTypeLedger(client, typeId, typeName, startDay, days, totalRooms) {
  for (let i = 0; i < days; i += 1) {
    const day = addDays(startDay, i);
    await client.query(
      `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
       VALUES ($1, $2, $3::date, $4, 0)`,
      [typeId, typeName, day, totalRooms]
    );
  }
}

async function getLedgerCell(client, typeId, dateKey) {
  const result = await client.query(
    'SELECT total_rooms, reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
    [typeId, dateKey]
  );
  expect(result.rowCount === 1, `ledger cell missing for type ${typeId} on ${dateKey}`);
  return { total_rooms: Number(result.rows[0].total_rooms), reserved_qty: Number(result.rows[0].reserved_qty) };
}

async function setLedgerCell(client, typeId, dateKey, fields) {
  await client.query(
    'UPDATE availability_dates SET total_rooms = $3, reserved_qty = $4 WHERE room_type_id = $1 AND date = $2::date',
    [typeId, dateKey, fields.total_rooms, fields.reserved_qty]
  );
}

async function allFutureTotalsEqual(client, typeId, expectedTotal, today, horizonDays) {
  const rows = await client.query(
    `SELECT to_char(date::date, 'YYYY-MM-DD') AS day, total_rooms
     FROM availability_dates
     WHERE room_type_id = $1 AND date >= $2::date AND date < ($2::date + ($3 || ' days')::interval)
     ORDER BY date`,
    [typeId, today, String(horizonDays)]
  );
  for (const row of rows.rows) {
    expect(Number(row.total_rooms) === expectedTotal,
      `expected total_rooms=${expectedTotal} on ${row.day}, got ${row.total_rooms}`);
  }
  return rows.rowCount;
}

function runReconciliation(args) {
  const result = spawnSync(process.execPath, [reconciliationScriptPath, ...args], { encoding: 'utf8' });
  let report = null;
  try {
    report = JSON.parse(result.stdout);
  } catch (_e) {
    report = null;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, report };
}

const createdRoomIds = new Set();
const createdTypeIds = new Set();
const createdReservationIds = new Set();
const reservationNights = new Map();
const checkedOutBaselineBefore = { count: null };

function trackReservation(reservationId, typeName, checkIn, checkOut) {
  createdReservationIds.add(Number(reservationId));
  const nights = [];
  let cursor = checkIn;
  while (cursor < checkOut) {
    nights.push(`${typeName}::${cursor}`);
    cursor = addDays(cursor, 1);
  }
  reservationNights.set(Number(reservationId), nights);
}

async function cleanupRun(client) {
  await client.query('BEGIN');
  try {
    const runRows = await client.query(
      'SELECT id FROM reservations WHERE guest_name LIKE $1 OR correlation_id LIKE $2',
      [`${runId}%`, `${runId}%`]
    );
    const reservationIds = Array.from(new Set([
      ...Array.from(createdReservationIds.values()),
      ...runRows.rows.map((r) => Number(r.id)).filter(Number.isFinite)
    ]));

    if (reservationIds.length > 0) {
      // Ledger bookkeeping: any still-owned nights must be released before delete.
      for (const reservationId of reservationIds) {
        const nights = reservationNights.get(Number(reservationId));
        if (!nights) continue;
        for (const nightKey of nights) {
          const [typeName, dateKey] = nightKey.split('::');
          await client.query(
            `UPDATE availability_dates ad SET reserved_qty = GREATEST(ad.reserved_qty - 1, 0)
             WHERE ad.room_type = $1 AND ad.date = $2::date`,
            [typeName, dateKey]
          );
        }
      }
      await client.query('DELETE FROM availability_locks WHERE reservation_id = ANY($1::int[])', [reservationIds]);
      await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [reservationIds]);
      await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [reservationIds]);
      await client.query('DELETE FROM guest_receivables WHERE reservation_id = ANY($1::int[])', [reservationIds]);
      await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [reservationIds]);
    }

    await client.query(`DELETE FROM bookings b WHERE (b.correlation_id LIKE $1 OR b.guest_name_snapshot LIKE $2)
                        AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.booking_id = b.id)`,
      [`${runId}%`, `${runId}%`]);

    if (createdRoomIds.size > 0) {
      await client.query("DELETE FROM rooms WHERE id = ANY($1::int[]) AND room_number LIKE 'RM1C1-%'", [Array.from(createdRoomIds)]);
    }
    if (createdTypeIds.size > 0) {
      await client.query('DELETE FROM availability_dates WHERE room_type_id = ANY($1::int[])', [Array.from(createdTypeIds)]);
      await client.query("DELETE FROM room_types WHERE id = ANY($1::int[]) AND code LIKE 'RM1C1-%'", [Array.from(createdTypeIds)]);
    }

    await client.query('DELETE FROM audit_logs WHERE correlation_id LIKE $1', [`${runId}%`]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function verifyFinalState(runContext) {
  const residueTables = [
    ['reservations', 'guest_name LIKE $1 OR correlation_id LIKE $2'],
    ['bookings', 'correlation_id LIKE $1 OR guest_name_snapshot LIKE $2']
  ];
  for (const [table, predicate] of residueTables) {
    const result = await pool.query(`SELECT COUNT(*)::int AS c FROM ${table} WHERE ${predicate}`, [`%${runId}%`, `${runId}%`]);
    expect(result.rows[0].c === 0, `residue in ${table}: ${result.rows[0].c}`);
  }
  const roomResidue = await pool.query("SELECT COUNT(*)::int AS c FROM rooms WHERE room_number LIKE 'RM1C1-%'");
  expect(roomResidue.rows[0].c === 0, `room residue: ${roomResidue.rows[0].c}`);
  const typeResidue = await pool.query("SELECT COUNT(*)::int AS c FROM room_types WHERE code LIKE 'RM1C1-%'");
  expect(typeResidue.rows[0].c === 0, `type residue: ${typeResidue.rows[0].c}`);

  if (checkedOutBaselineBefore.count !== null) {
    const after = await pool.query("SELECT COUNT(*)::int AS c FROM reservations WHERE status = 'CHECKED_OUT'");
    expect(Number(after.rows[0].c) >= Number(checkedOutBaselineBefore.count),
      'historical CHECKED_OUT reservations must never disappear');
  }

  const drift = await pool.query(`
    SELECT COUNT(*)::int AS drift_count
    FROM availability_dates ad
    LEFT JOIN (
      SELECT rm.room_type_id, g.d::date AS day, COUNT(*) AS active
      FROM reservations r JOIN rooms rm ON rm.id = r.room_id
      CROSS JOIN LATERAL generate_series(r.check_in, r.check_out - INTERVAL '1 day', INTERVAL '1 day') g(d)
      WHERE r.status IN ('BOOKED','CHECKED_IN') AND rm.room_type_id IS NOT NULL
      GROUP BY 1,2
    ) e ON e.room_type_id = ad.room_type_id AND e.day = ad.date::date
    WHERE ad.reserved_qty <> COALESCE(e.active, 0)`);
  expect(drift.rows[0].drift_count === 0, `inventory drift: ${drift.rows[0].drift_count}`);

  const negatives = await pool.query('SELECT COUNT(*)::int AS c FROM availability_dates WHERE reserved_qty < 0');
  expect(negatives.rows[0].c === 0, `negative inventory rows: ${negatives.rows[0].c}`);

  const overCap = await pool.query('SELECT COUNT(*)::int AS c FROM availability_dates WHERE reserved_qty > total_rooms');
  expect(overCap.rows[0].c === 0, `over-capacity rows: ${overCap.rows[0].c}`);
}

async function run() {
  const results = [];
  const mark = (label, ok, detail = '') => {
    results.push({ label, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  };

  let typeOne = null;
  let roomOne = null;
  let roomTwo = null;
  let today = null;

  try {
    const client = await pool.connect();
    try {
      today = await todayJakarta(client);
      const checkedOutCount = await client.query("SELECT COUNT(*)::int AS c FROM reservations WHERE status = 'CHECKED_OUT'");
      checkedOutBaselineBefore.count = Number(checkedOutCount.rows[0].c);

      const typeResponse = await request('POST', '/api/room-types', {
        code: 'RM1C1-T1',
        name: 'RM1C1 Type One',
        capacity: 3
      });
      expect(typeResponse.status === 201, `fixture type create failed: ${typeResponse.text}`);
      typeOne = typeResponse.json.data;
      createdTypeIds.add(Number(typeOne.id));

      // Seed a controlled ledger window BEFORE any physical room exists.
      await seedTypeLedger(client, typeOne.id, typeOne.name, today, 15, 0);

      // A. create active room increases future capacity
      const roomA = await request('POST', '/api/rooms', { room_number: 'RM1C1-R1', room_type_id: typeOne.id });
      expect(roomA.status === 201, `A room create failed: ${roomA.status} ${roomA.text}`);
      roomOne = roomA.json.data;
      createdRoomIds.add(Number(roomOne.id));
      const seededRowsA = await allFutureTotalsEqual(client, typeOne.id, 1, today, 15);
      const cellA = await getLedgerCell(client, typeOne.id, addDays(today, 3));
      expect(cellA.reserved_qty === 0, 'A reserved_qty must remain intact through capacity sync');
      mark('A. create active room raises future capacity', seededRowsA === 15 && cellA.total_rooms === 1,
        `${seededRowsA} future rows aligned`);

      // B. deactivate unused active room decreases capacity; reactivate path used later
      const roomB = await request('POST', '/api/rooms', { room_number: 'RM1C1-R2', room_type_id: typeOne.id });
      expect(roomB.status === 201, `B second room create failed: ${roomB.text}`);
      roomTwo = roomB.json.data;
      createdRoomIds.add(Number(roomTwo.id));
      const totalsAfterCreate = await allFutureTotalsEqual(client, typeOne.id, 2, today, 15);
      const deactivated = await request('PATCH', `/api/rooms/${roomTwo.id}`, { is_active: false });
      expect(deactivated.status === 200, `B deactivate failed: ${deactivated.text}`);
      const totalsAfterDeactivate = await allFutureTotalsEqual(client, typeOne.id, 1, today, 15);
      mark('B. deactivate unused room lowers future capacity', totalsAfterCreate === 15 && totalsAfterDeactivate === 15);

      // C. deactivate room with active reservation rejected
      await request('PATCH', `/api/rooms/${roomTwo.id}`, { is_active: true });
      const stayStart = addDays(today, 5);
      const stayEnd = addDays(today, 7);
      const resC = await request('POST', '/api/reservations', {
        room_id: roomTwo.id,
        guest_name: `${runId} C-Guest`,
        guest_phone: `0819${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
        check_in: stayStart,
        check_out: stayEnd,
        total_price: 200000,
        qty: 1
      }, 'C-RES');
      expect(resC.status === 201, `C reservation fixture failed: ${resC.status} ${resC.text}`);
      const resCId = Number(resC.json.data.id);
      trackReservation(resCId, typeOne.name, stayStart, stayEnd);

      const blockedDeactivate = await request('PATCH', `/api/rooms/${roomTwo.id}`, { is_active: false });
      expect(blockedDeactivate.status === 409 && blockedDeactivate.json?.code === 'ROOM_HAS_ACTIVE_RESERVATIONS',
        `C deactivation with active reservation must be 409 ROOM_HAS_ACTIVE_RESERVATIONS, got ${blockedDeactivate.status} ${blockedDeactivate.text}`);

      const cancelled = await request('POST', `/api/reservations/${resCId}/cancel`, {}, 'C-CANCEL');
      expect(cancelled.status === 200 || cancelled.status === 201, `C cancel fixture failed: ${cancelled.text}`);
      mark('C. deactivate with active reservation rejected', true);

      // D. deactivation causing reserved_qty > resulting capacity rejected, no clamping
      const conflictDay = addDays(today, 8);
      await setLedgerCell(client, typeOne.id, conflictDay, { total_rooms: 2, reserved_qty: 2 });
      const unsafeDeactivate = await request('PATCH', `/api/rooms/${roomTwo.id}`, { is_active: false });
      expect(unsafeDeactivate.status === 409 && unsafeDeactivate.json?.code === 'CAPACITY_CONFLICT',
        `D unsafe deactivation must be 409 CAPACITY_CONFLICT, got ${unsafeDeactivate.status} ${unsafeDeactivate.text}`);
      const cellD = await getLedgerCell(client, typeOne.id, conflictDay);
      expect(cellD.reserved_qty === 2 && cellD.total_rooms === 2,
        `D rejected operation must not clamp or mutate ledger (${JSON.stringify(cellD)})`);
      await setLedgerCell(client, typeOne.id, conflictDay, { total_rooms: 2, reserved_qty: 0 });
      mark('D. unsafe capacity conflict rejected without clamping', true);

      // E. reactivate restores capacity
      await request('PATCH', `/api/rooms/${roomTwo.id}`, { is_active: true });
      const restoredRows = await allFutureTotalsEqual(client, typeOne.id, 2, today, 15);
      mark('E. reactivation restores capacity', restoredRows === 15);

      // F. temporary operational statuses never change physical total_rooms
      const originalStatus = String(roomTwo.status || 'VACANT_CLEAN');
      let tempStatusOk = true;
      for (const tempStatus of ['VACANT_DIRTY', 'OUT_OF_ORDER', 'OUT_OF_SERVICE']) {
        const setStatus = await request('PATCH', `/api/rooms/${roomTwo.id}/status`, { status: tempStatus });
        expect(setStatus.status === 200, `F status change to ${tempStatus} failed: ${setStatus.text}`);
        const rowsStillTwo = await allFutureTotalsEqual(client, typeOne.id, 2, today, 15);
        if (rowsStillTwo !== 15) tempStatusOk = false;
      }
      await request('PATCH', `/api/rooms/${roomTwo.id}/status`, { status: originalStatus });
      const detailAfterStatus = await request('GET', `/api/rooms/${roomTwo.id}`);
      expect(detailAfterStatus.json.data.is_active === true, 'F temporary status cycle must not alter activation');
      mark('F. DIRTY/OOO/OOS do not mutate physical total_rooms', tempStatusOk);

      // G. inactive room excluded from booking/sellability
      await request('PATCH', `/api/rooms/${roomTwo.id}`, { is_active: false });
      const blockedBooking = await request('POST', '/api/reservations', {
        room_id: roomTwo.id,
        guest_name: `${runId} G-Guest`,
        guest_phone: `0819${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
        check_in: addDays(today, 11),
        check_out: addDays(today, 13),
        total_price: 150000,
        qty: 1
      }, 'G-BLOCKED');
      expect(blockedBooking.status === 409, `G booking against inactive room must be 409, got ${blockedBooking.status}`);
      await request('PATCH', `/api/rooms/${roomTwo.id}`, { is_active: true });
      mark('G. inactive room excluded from booking flow', true);

      // H. contradictory room-type state rejected
      const blockedTypeDeactivate = await request('PATCH', `/api/room-types/${typeOne.id}`, { is_active: false });
      expect(blockedTypeDeactivate.status === 409 && blockedTypeDeactivate.json?.code === 'TYPE_HAS_ACTIVE_ROOMS',
        `H type deactivation with active rooms must be 409 TYPE_HAS_ACTIVE_ROOMS, got ${blockedTypeDeactivate.status} ${blockedTypeDeactivate.text}`);
      const typeDetail = await request('GET', `/api/room-types/${typeOne.id}`);
      expect(typeDetail.json.data.is_active === true && Number(typeDetail.json.data.active_physical_rooms) === 2,
        'H type must remain active with both rooms counted');
      expect(Number(typeDetail.json.data.future_reserved_peak) === 0, 'H read model exposes future_reserved_peak');
      mark('H. type cannot become contradictory with active rooms', true);

      // I. reconciliation repairs safe total_rooms drift, idempotently
      const driftDay = addDays(today, 9);
      await setLedgerCell(client, typeOne.id, driftDay, { total_rooms: 99, reserved_qty: 0 });
      const repairRun = runReconciliation(['--repair']);
      expect(repairRun.status === 0, `I reconciliation --repair must exit 0, got ${repairRun.status}: ${repairRun.stderr}`);
      const repairedReport = repairRun.report;
      const ownTypeReport = repairedReport.types.find((t) => Number(t.room_type_id) === Number(typeOne.id));
      expect(ownTypeReport && ownTypeReport.repaired_rows >= 1, 'I repair must fix the drifted row');
      const cellAfterRepair = await getLedgerCell(client, typeOne.id, driftDay);
      expect(cellAfterRepair.total_rooms === 2, `I drifted row must equal authoritative capacity, got ${cellAfterRepair.total_rooms}`);
      const rerun = runReconciliation(['--repair']);
      expect(rerun.status === 0, 'I second reconciliation run must succeed');
      const rerunOwn = rerun.report.types.find((t) => Number(t.room_type_id) === Number(typeOne.id));
      expect(rerunOwn.drift_rows === 0 && rerunOwn.repaired_rows === 0, 'I reconciliation must be idempotent');
      mark('I. reconciliation repairs safe drift idempotently', true);

      // J. reconciliation refuses unsafe reserved conflicts (no auto-clamp)
      const unsafeDay = addDays(today, 10);
      await setLedgerCell(client, typeOne.id, unsafeDay, { total_rooms: 2, reserved_qty: 5 });
      const unsafeRun = runReconciliation(['--repair']);
      expect(unsafeRun.status === 2, `J unsafe reconciliation must exit 2, got ${unsafeRun.status}`);
      expect(Array.isArray(unsafeRun.report.unsafe_types) &&
        unsafeRun.report.unsafe_types.some((t) => Number(t.room_type_id) === Number(typeOne.id)),
        'J unsafe report must name the conflicted type');
      const cellUnsafe = await getLedgerCell(client, typeOne.id, unsafeDay);
      expect(cellUnsafe.reserved_qty === 5 && cellUnsafe.total_rooms === 2,
        'J unsafe row must be reported, never clamped or overwritten');
      await setLedgerCell(client, typeOne.id, unsafeDay, { total_rooms: 2, reserved_qty: 0 });
      mark('J. reconciliation reports unsafe conflicts without clamping', true);

      // K. no duplicate availability rows
      const duplicates = await client.query(
        `SELECT room_type_id, date::date AS day, COUNT(*)::int AS rows_count
         FROM availability_dates WHERE room_type_id = $1 GROUP BY 1, 2 HAVING COUNT(*) > 1`,
        [typeOne.id]
      );
      mark('K. no duplicate availability ledger rows', duplicates.rowCount === 0,
        `${duplicates.rowCount} duplicate groups`);

      // L. historical rows untouched by synchronization/reconciliation
      const historyDay = addDays(today, -30);
      await client.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES ($1, $2, $3::date, 3, 0)`,
        [typeOne.id, typeOne.name, historyDay]
      );
      const historyRepair = runReconciliation(['--repair']);
      expect(historyRepair.status === 0, 'L historical-safe reconciliation must exit 0');
      const historyCell = await getLedgerCell(client, typeOne.id, historyDay);
      expect(historyCell.total_rooms === 3, `L historical row must be untouched, got ${historyCell.total_rooms}`);
      await client.query(
        'DELETE FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
        [typeOne.id, historyDay]
      );
      mark('L. historical ledger semantics preserved', true);
    } finally {
      client.release();
    }
  } catch (err) {
    mark('UNEXPECTED FAILURE', false, err.message);
  } finally {
    const client = await pool.connect();
    try {
      await cleanupRun(client);
      await verifyFinalState();
      const passed = results.filter((r) => r.ok).length;
      const allPassed = passed === results.length;
      console.log('');
      console.log(allPassed
        ? `ALL ${passed}/${results.length} SCENARIOS PASS — zero residue, invariants clean (${runId})`
        : `${passed}/${results.length} scenarios passed; see FAIL lines above (${runId})`);
      process.exitCode = allPassed ? 0 : 1;
    } catch (cleanupErr) {
      console.error(`CLEANUP FAILURE for ${runId}: ${cleanupErr.message}`);
      process.exitCode = 1;
    } finally {
      client.release();
      await pool.end();
    }
  }
}

run();
