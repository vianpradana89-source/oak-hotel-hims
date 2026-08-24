'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

// Exercise the REAL compiled seeder artifact, exactly what runs at boot.
const { seedAvailabilityDates } = require(path.join(__dirname, '..', 'dist', 'db', 'schema_v2.js'));

const fetchFn = global.fetch || require('node-fetch');
const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:5000';
const runId = `RM1C2-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
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

async function request(method, path, body) {
  const resp = await fetchFn(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': `${runId}-api` },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_e) {
    json = null;
  }
  return { status: resp.status, text, json };
}

function addDays(dateKey, offset) {
  const base = new Date(`${dateKey}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + offset);
  return base.toISOString().slice(0, 10);
}

async function todayJakarta(client) {
  const result = await client.query("SELECT to_char((NOW() AT TIME ZONE 'Asia/Jakarta')::date, 'YYYY-MM-DD') AS d");
  return String(result.rows[0].d);
}

async function ledgerCell(client, typeId, dateKey) {
  const result = await client.query(
    `SELECT room_type_id, room_type, total_rooms, reserved_qty
     FROM availability_dates WHERE room_type_id = $1 AND date = $2::date`,
    [typeId, dateKey]
  );
  expect(result.rowCount === 1, `expected exactly one canonical ledger row for type ${typeId} on ${dateKey}`);
  const row = result.rows[0];
  return {
    room_type_id: row.room_type_id === null ? null : Number(row.room_type_id),
    room_type: String(row.room_type),
    total_rooms: Number(row.total_rooms),
    reserved_qty: Number(row.reserved_qty)
  };
}

async function countRowsForType(client, typeId) {
  const result = await client.query(
    'SELECT COUNT(*)::int AS c FROM availability_dates WHERE room_type_id = $1',
    [typeId]
  );
  return Number(result.rows[0].c);
}

function runReconciliation(args) {
  const result = spawnSync(process.execPath, [reconciliationScriptPath, ...args], { encoding: 'utf8' });
  let report = null;
  try {
    report = JSON.parse(result.stdout);
  } catch (_e) {
    report = null;
  }
  return { status: result.status, stdout: result.stdout, report };
}

const createdRoomIds = new Set();
const createdTypeIds = new Set();

async function cleanupRun(client) {
  await client.query('BEGIN');
  try {
    if (createdRoomIds.size > 0) {
      await client.query("DELETE FROM rooms WHERE id = ANY($1::int[]) AND room_number LIKE 'RM1C2-%'", [Array.from(createdRoomIds)]);
    }
    if (createdTypeIds.size > 0) {
      await client.query('DELETE FROM availability_dates WHERE room_type_id = ANY($1::int[])', [Array.from(createdTypeIds)]);
      await client.query("DELETE FROM room_types WHERE id = ANY($1::int[]) AND code LIKE 'RM1C2-%'", [Array.from(createdTypeIds)]);
    }
    await client.query('DELETE FROM audit_logs WHERE correlation_id LIKE $1', [`${runId}%`]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function verifyFinalState() {
  for (const [table, predicate] of [
    ['rooms', "room_number LIKE 'RM1C2-%'"],
    ['room_types', "code LIKE 'RM1C2-%'"]
  ]) {
    const result = await pool.query(`SELECT COUNT(*)::int AS c FROM ${table} WHERE ${predicate}`);
    expect(result.rows[0].c === 0, `residue in ${table}: ${result.rows[0].c}`);
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
  expect(negatives.rows[0].c === 0, `negative rows: ${negatives.rows[0].c}`);

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
  let typeTwo = null;
  let roomOne = null;
  let roomTwo = null;
  let today = null;

  try {
    const client = await pool.connect();
    try {
      today = await todayJakarta(client);

      const typeResponse = await request('POST', '/api/room-types', {
        code: 'RM1C2-T1',
        name: 'RM1C2 Type One',
        capacity: 3
      });
      expect(typeResponse.status === 201, `fixture type create failed: ${typeResponse.text}`);
      typeOne = typeResponse.json.data;
      createdTypeIds.add(Number(typeOne.id));

      // A. new seeded row uses canonical room_type_id (+ E first pass, B inactive exclusion)
      const roomAResponse = await request('POST', '/api/rooms', { room_number: 'RM1C2-R1', room_type_id: typeOne.id });
      expect(roomAResponse.status === 201, `fixture room R1 create failed: ${roomAResponse.text}`);
      roomOne = roomAResponse.json.data;
      createdRoomIds.add(Number(roomOne.id));

      const roomBResponse = await request('POST', '/api/rooms', { room_number: 'RM1C2-R2', room_type_id: typeOne.id });
      expect(roomBResponse.status === 201, `fixture room R2 create failed: ${roomBResponse.text}`);
      roomTwo = roomBResponse.json.data;
      createdRoomIds.add(Number(roomTwo.id));
      const deactivateB = await request('PATCH', `/api/rooms/${roomTwo.id}`, { is_active: false });
      expect(deactivateB.status === 200, `fixture deactivation of R2 failed: ${deactivateB.text}`);

      const historicalDay = addDays(today, -1);
      await client.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES ($1, $2, $3::date, 42, 0)`,
        [typeOne.id, typeOne.name, historicalDay]
      );

      await seedAvailabilityDates(pool);

      const seededCell = await ledgerCell(client, typeOne.id, addDays(today, 3));
      expect(seededCell.room_type_id === Number(typeOne.id), `A seeded row must carry canonical room_type_id, got ${seededCell.room_type_id}`);
      expect(seededCell.room_type === typeOne.name, 'A legacy room_type text must mirror the canonical name');
      expect(seededCell.total_rooms === 1, `B total_rooms must exclude inactive physical rooms (expected 1, got ${seededCell.total_rooms})`);
      mark('A. new seeded rows use canonical room_type_id + name mirror', true);
      mark('B. inactive physical room excluded from total_rooms', true);

      // C. temporary operational status does not reduce total_rooms
      const statusChange = await request('PATCH', `/api/rooms/${roomOne.id}/status`, { status: 'OUT_OF_ORDER' });
      expect(statusChange.status === 200, `C status change failed: ${statusChange.text}`);
      await seedAvailabilityDates(pool);
      const cellDuringMaintenance = await ledgerCell(client, typeOne.id, addDays(today, 4));
      expect(cellDuringMaintenance.total_rooms === 1,
        `C maintenance status must not reduce physical total_rooms, got ${cellDuringMaintenance.total_rooms}`);
      await request('PATCH', `/api/rooms/${roomOne.id}/status`, { status: 'VACANT_CLEAN' });
      mark('C. temporary operational status does not change total_rooms', true);

      // D. inactive room types seed nothing contradictory
      const typeTwoResponse = await request('POST', '/api/room-types', { code: 'RM1C2-T2', name: 'RM1C2 Type Two', capacity: 2 });
      expect(typeTwoResponse.status === 201, `fixture type two create failed: ${typeTwoResponse.text}`);
      typeTwo = typeTwoResponse.json.data;
      createdTypeIds.add(Number(typeTwo.id));
      const deactivateType = await request('PATCH', `/api/room-types/${typeTwo.id}`, { is_active: false });
      expect(deactivateType.status === 200 && deactivateType.json.data.is_active === false,
        `D fixture type deactivation failed: ${deactivateType.text}`);

      await seedAvailabilityDates(pool);

      const typeTwoRows = await countRowsForType(client, typeTwo.id);
      expect(typeTwoRows === 0, `D inactive type must not gain seeded future rows, got ${typeTwoRows}`);
      mark('D. inactive room type seeds no sellable capacity', true);

      // E. seeder idempotence
      const beforeE = await countRowsForType(client, typeOne.id);
      await seedAvailabilityDates(pool);
      const afterE = await countRowsForType(client, typeOne.id);
      const cellAfterRerun = await ledgerCell(client, typeOne.id, addDays(today, 3));
      expect(beforeE === afterE, `E rerun must not create duplicate or extra rows (${beforeE} -> ${afterE})`);
      expect(cellAfterRerun.total_rooms === 1 && cellAfterRerun.reserved_qty === 0, 'E rerun must not mutate existing totals');
      mark('E. seeder is idempotent', `${beforeE} rows stable`);

      // F. no duplicate availability rows anywhere in the canonical window
      const duplicates = await client.query(
        `SELECT room_type_id, date::date AS day, COUNT(*)::int AS rows_count
         FROM availability_dates WHERE room_type_id IS NOT NULL
         GROUP BY 1, 2 HAVING COUNT(*) > 1`
      );
      mark('F. no duplicate availability rows', duplicates.rowCount === 0, `${duplicates.rowCount} duplicate groups`);

      // G. historical rows remain unchanged
      const historyCell = await ledgerCell(client, typeOne.id, historicalDay);
      expect(historyCell.total_rooms === 42 && historyCell.reserved_qty === 0,
        `G historical row must be untouched, got ${JSON.stringify(historyCell)}`);
      mark('G. historical rows preserved across seeding', true);

      // H. reserved_qty never clamped by the seeder; conflicts left to authority
      const conflictDay = addDays(today, 9);
      await setReserved(client, typeOne.id, conflictDay, 5);
      await seedAvailabilityDates(pool);
      const cellH = await ledgerCell(client, typeOne.id, conflictDay);
      expect(cellH.reserved_qty === 5, `H seeder must never clamp reserved_qty, got ${cellH.reserved_qty}`);
      expect(cellH.total_rooms === 1, 'H existing total_rooms must stay untouched by conflict path');

      // I. reconciliation and seeder agree on active physical capacity
      const unsafeRun = runReconciliation(['--repair']);
      expect(unsafeRun.status === 2, `I reconciliation must flag reserved(${cellH.reserved_qty})>capacity(1) as unsafe, exit=${unsafeRun.status}`);
      await setReserved(client, typeOne.id, conflictDay, 0);
      const cleanRun = runReconciliation(['--repair']);
      expect(cleanRun.status === 0, 'I reconciliation must exit 0 once fixtures are restored');
      const ownReport = cleanRun.report.types.find((t) => Number(t.room_type_id) === Number(typeOne.id));
      expect(ownReport && ownReport.active_physical_capacity === 1,
        `I reconciliation active capacity must equal seeder total (got ${ownReport && ownReport.active_physical_capacity})`);
      expect(ownReport.drift_rows === 0, 'I reconciliation must see zero drift against seeder totals');
      mark('H+I. reserved never clamped; seeder and reconciliation agree', true);
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

async function setReserved(client, typeId, dateKey, value) {
  await client.query(
    'UPDATE availability_dates SET reserved_qty = $3 WHERE room_type_id = $1 AND date = $2::date',
    [typeId, dateKey, value]
  );
}

run();
