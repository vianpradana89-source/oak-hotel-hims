'use strict';

require('dotenv').config();
const { Pool } = require('pg');

const p = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

let assertions = 0;

function expect(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
}

async function main() {
  const client = await p.connect();
  let typeId = null;
  let propertyId = null;
  try {
    // ---- 0. Setup: create disposable room type + property ----
    const property = await client.query('SELECT id FROM properties ORDER BY id LIMIT 1');
    expect(property.rowCount === 1, 'C3C test requires an existing property');
    propertyId = Number(property.rows[0].id);

    const insertType = await client.query(
      `INSERT INTO room_types (property_id, code, name, base_rate, capacity, max_adults, max_children, is_active, display_order)
       VALUES ($1, 'C3CTST', 'C3C Contract Test Type', 100000, 2, 2, 0, TRUE, 9999)
       RETURNING id`,
      [propertyId]
    );
    typeId = Number(insertType.rows[0].id);

    const todayResult = await client.query(
      "SELECT to_char((NOW() AT TIME ZONE 'Asia/Jakarta')::date, 'YYYY-MM-DD') AS d"
    );
    const testDate = String(todayResult.rows[0].d);

    // ---- A. canonical availability row insert with room_type_id succeeds ----
    await client.query(
      `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
       VALUES ($1, 'C3C contract test', $2::date, 2, 0)`,
      [typeId, testDate]
    );
    const canonicalRow = await client.query(
      'SELECT room_type_id, total_rooms, reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
      [typeId, testDate]
    );
    expect(canonicalRow.rowCount === 1, 'A: canonical insert did not create row');
    expect(Number(canonicalRow.rows[0].room_type_id) === typeId, 'A: canonical row room_type_id mismatch');

    // ---- B. NULL room_type_id availability insert is rejected ----
    let nullIdError = null;
    try {
      await client.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES (NULL, 'C3C null test', $1::date, 1, 0)`,
        [testDate]
      );
    } catch (error) { nullIdError = error; }
    expect(nullIdError?.code === '23502', `B: NULL room_type_id insert was not rejected (code=${nullIdError?.code})`);

    // ---- C. invalid room_type_id FK is rejected ----
    let fkError = null;
    try {
      await client.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES (999999999, 'C3C fk test', $1::date, 1, 0)`,
        [testDate]
      );
    } catch (error) { fkError = error; }
    expect(fkError?.code === '23503', `C: invalid FK room_type_id was not rejected (code=${fkError?.code})`);

    // ---- D. duplicate (room_type_id,date) is rejected ----
    let dupError = null;
    try {
      await client.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES ($1, 'C3C dup test', $2::date, 1, 0)`,
        [typeId, testDate]
      );
    } catch (error) { dupError = error; }
    expect(dupError?.code === '23505', `D: duplicate canonical identity was not rejected (code=${dupError?.code})`);

    // ---- E. canonical update remains valid ----
    await client.query(
      'UPDATE availability_dates SET reserved_qty = 1 WHERE room_type_id = $1 AND date = $2::date',
      [typeId, testDate]
    );
    const updatedRow = await client.query(
      'SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
      [typeId, testDate]
    );
    expect(updatedRow.rows[0].reserved_qty === 1, 'E: canonical update did not apply');

    // ---- F. legacy room_type text cannot substitute for missing canonical ID ----
    let legacySubError = null;
    try {
      await client.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES (NULL, 'C3C Contract Test Type', $1::date, 1, 0)`,
        [testDate]
      );
    } catch (error) { legacySubError = error; }
    expect(legacySubError?.code === '23502', `F: legacy text without canonical ID was not rejected (code=${legacySubError?.code})`);

    // ---- G. canonical availability lock with room_type_id succeeds ----
    await client.query(
      `INSERT INTO availability_locks (reservation_id, room_type_id, room_type, date, qty_locked, lock_expires_at)
       VALUES (NULL, $1, 'C3C lock test', $2::date, 1, NOW() + INTERVAL '30 minutes')`,
      [typeId, testDate]
    );
    const lockRow = await client.query(
      'SELECT room_type_id FROM availability_locks WHERE room_type_id = $1 AND date = $2::date AND reservation_id IS NULL',
      [typeId, testDate]
    );
    expect(lockRow.rowCount === 1, 'G: canonical lock insert did not create row');

    // ---- H. NULL-ID lock rejected ----
    let nullLockError = null;
    try {
      await client.query(
        `INSERT INTO availability_locks (reservation_id, room_type_id, room_type, date, qty_locked, lock_expires_at)
         VALUES (NULL, NULL, 'C3C null lock', $1::date, 1, NOW() + INTERVAL '30 minutes')`,
        [testDate]
      );
    } catch (error) { nullLockError = error; }
    expect(nullLockError?.code === '23502', `H: NULL-ID lock was not rejected (code=${nullLockError?.code})`);

    // ---- I. invalid lock room_type_id rejected ----
    let lockFkError = null;
    try {
      await client.query(
        `INSERT INTO availability_locks (reservation_id, room_type_id, room_type, date, qty_locked, lock_expires_at)
         VALUES (NULL, 999999999, 'C3C fk lock', $1::date, 1, NOW() + INTERVAL '30 minutes')`,
        [testDate]
      );
    } catch (error) { lockFkError = error; }
    expect(lockFkError?.code === '23503', `I: invalid FK lock room_type_id was not rejected (code=${lockFkError?.code})`);

    // ---- J. multiple legitimate holds remain possible ----
    const testDate2Result = await client.query(
      "SELECT to_char((NOW() AT TIME ZONE 'Asia/Jakarta')::date + 1, 'YYYY-MM-DD') AS d"
    );
    const testDate2 = String(testDate2Result.rows[0].d);
    await client.query(
      `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
       VALUES ($1, 'C3C lock test', $2::date, 2, 0)`,
      [typeId, testDate2]
    );
    await client.query(
      `INSERT INTO availability_locks (reservation_id, room_type_id, room_type, date, qty_locked, lock_expires_at)
       VALUES (NULL, $1, 'C3C lock test', $2::date, 1, NOW() + INTERVAL '30 minutes')`,
      [typeId, testDate2]
    );
    await client.query(
      `INSERT INTO availability_locks (reservation_id, room_type_id, room_type, date, qty_locked, lock_expires_at)
       VALUES (NULL, $1, 'C3C lock test', $2::date, 1, NOW() + INTERVAL '30 minutes')`,
      [typeId, testDate2]
    );
    const multiLocks = await client.query(
      'SELECT COUNT(*)::int AS c FROM availability_locks WHERE room_type_id = $1 AND date = $2::date',
      [typeId, testDate2]
    );
    expect(multiLocks.rows[0].c === 2, `J: multiple legitimate holds not possible (count=${multiLocks.rows[0].c})`);

    // ---- Schema verification ----
    const nullableDates = await client.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'availability_dates' AND column_name = 'room_type_id'`
    );
    expect(nullableDates.rows[0].is_nullable === 'NO', 'schema: availability_dates.room_type_id is still nullable');

    const nullableLocks = await client.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'availability_locks' AND column_name = 'room_type_id'`
    );
    expect(nullableLocks.rows[0].is_nullable === 'NO', 'schema: availability_locks.room_type_id is still nullable');

    const fkDates = await client.query(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'rm_1b_availability_dates_room_type_id_fkey'`
    );
    expect(fkDates.rows[0].convalidated === true, 'schema: availability_dates FK not validated');

    const fkLocks = await client.query(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'rm_1b_availability_locks_room_type_id_fkey'`
    );
    expect(fkLocks.rows[0].convalidated === true, 'schema: availability_locks FK not validated');

    // ---- Cleanup ----
    await client.query('DELETE FROM availability_locks WHERE room_type_id = $1', [typeId]);
    await client.query('DELETE FROM availability_dates WHERE room_type_id = $1', [typeId]);
    await client.query('DELETE FROM room_types WHERE id = $1', [typeId]);

    // ---- Verify zero residue ----
    const residue = await client.query(
      `SELECT
        (SELECT COUNT(*) FROM availability_dates WHERE room_type_id = $1)::int AS dates,
        (SELECT COUNT(*) FROM availability_locks WHERE room_type_id = $1)::int AS locks,
        (SELECT COUNT(*) FROM room_types WHERE id = $1)::int AS types`,
      [typeId]
    );
    expect(residue.rows[0].dates === 0, `residue: availability_dates rows remain (${residue.rows[0].dates})`);
    expect(residue.rows[0].locks === 0, `residue: availability_locks rows remain (${residue.rows[0].locks})`);
    expect(residue.rows[0].types === 0, `residue: room_types rows remain (${residue.rows[0].types})`);

    console.log(`C3C schema contract test PASS | assertions=${assertions}`);
  } catch (error) {
    // Best-effort cleanup on failure
    if (typeId) {
      try { await p.query('DELETE FROM availability_locks WHERE room_type_id = $1', [typeId]); } catch (_) {}
      try { await p.query('DELETE FROM availability_dates WHERE room_type_id = $1', [typeId]); } catch (_) {}
      try { await p.query('DELETE FROM room_types WHERE id = $1', [typeId]); } catch (_) {}
    }
    throw error;
  } finally {
    client.release();
    await p.end();
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
