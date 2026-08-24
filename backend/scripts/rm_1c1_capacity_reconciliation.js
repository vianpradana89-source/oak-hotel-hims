'use strict';

// RM-1C.1 — Inventory Authority Reconciliation
//
// Physical Room Master is authoritative for PHYSICAL CAPACITY:
//   active_physical_capacity(room_type_id) =
//     COUNT(rooms WHERE room_type_id = X AND COALESCE(is_active, TRUE))
//
// availability_dates.total_rooms is an operational ledger mirror for
// today/future (Asia/Jakarta hotel dates). This tool REPORTS drift and,
// with --repair, fixes only SAFE capacity drift. Rows whose reserved_qty
// already exceeds the authoritative capacity are never rewritten; they are
// reported as UNSAFE and cause exit code 2 (no clamping, no silent overbook).
//
// Usage:
//   node scripts/rm_1c1_capacity_reconciliation.js           # report only
//   node scripts/rm_1c1_capacity_reconciliation.js --repair  # safe repair

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const REPAIR = process.argv.includes('--repair');
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'secretpassword',
  database: process.env.PGDATABASE || 'oak_hotel_db'
});

async function main() {
  const report = {
    mode: REPAIR ? 'repair' : 'report',
    repaired_rows_total: 0,
    unsafe_types: [],
    types: [],
    legacy_unmapped_ledger_rows: 0,
    duplicate_ledger_rows: [],
    missing_future_rows_reported: []
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const types = await client.query(`
      SELECT rt.id, rt.code, rt.name, rt.is_active,
             COUNT(r.id) FILTER (WHERE COALESCE(r.is_active, TRUE))::int AS active_physical_capacity
      FROM room_types rt
      LEFT JOIN rooms r ON r.room_type_id = rt.id
      GROUP BY rt.id
      ORDER BY rt.id
    `);

    for (const type of types.rows) {
      const roomTypeId = Number(type.id);
      const capacity = Number(type.active_physical_capacity);

      const ledgerStats = await client.query(
        `SELECT COUNT(*)::int AS future_rows,
                MIN(total_rooms) AS min_total,
                MAX(total_rooms) AS max_total,
                MAX(reserved_qty)::int AS peak_reserved
         FROM availability_dates
         WHERE room_type_id = $1
           AND (date AT TIME ZONE 'Asia/Jakarta')::date >= (NOW() AT TIME ZONE 'Asia/Jakarta')::date`,
        [roomTypeId]
      );
      const stats = ledgerStats.rows[0];

      const driftRows = await client.query(
        `SELECT id FROM availability_dates
         WHERE room_type_id = $1
           AND (date AT TIME ZONE 'Asia/Jakarta')::date >= (NOW() AT TIME ZONE 'Asia/Jakarta')::date
           AND total_rooms <> $2`,
        [roomTypeId, capacity]
      );

      const unsafeRows = await client.query(
        `SELECT date::date AS day, reserved_qty, total_rooms
         FROM availability_dates
         WHERE room_type_id = $1
           AND (date AT TIME ZONE 'Asia/Jakarta')::date >= (NOW() AT TIME ZONE 'Asia/Jakarta')::date
           AND reserved_qty > $2
         ORDER BY date
         LIMIT 10`,
        [roomTypeId, capacity]
      );

      let repairedRows = 0;
      if (REPAIR && (driftRows.rowCount ?? 0) > 0 && (unsafeRows.rowCount ?? 0) === 0) {
        const repaired = await client.query(
          `UPDATE availability_dates ad
           SET total_rooms = $2
           WHERE ad.room_type_id = $1
             AND (ad.date AT TIME ZONE 'Asia/Jakarta')::date >= (NOW() AT TIME ZONE 'Asia/Jakarta')::date
             AND ad.total_rooms <> $2
             AND ad.reserved_qty <= $2
           RETURNING ad.id`,
          [roomTypeId, capacity]
        );
        repairedRows = repaired.rowCount ?? 0;
      } else if (REPAIR && (unsafeRows.rowCount ?? 0) === 0) {
        repairedRows = 0;
      }

      const typeReport = {
        room_type_id: roomTypeId,
        code: type.code,
        name: type.name,
        type_is_active: Boolean(type.is_active),
        active_physical_capacity: capacity,
        future_ledger_rows: Number(stats.future_rows || 0),
        ledger_total_min: stats.min_total === null ? null : Number(stats.min_total),
        ledger_total_max: stats.max_total === null ? null : Number(stats.max_total),
        future_reserved_peak: Number(stats.peak_reserved || 0),
        drift_rows: driftRows.rowCount ?? 0,
        repaired_rows: repairedRows,
        unsafe_rows: unsafeRows.rowCount ?? 0
      };
      report.types.push(typeReport);
      report.repaired_rows_total += repairedRows;

      if ((unsafeRows.rowCount ?? 0) > 0) {
        report.unsafe_types.push({
          room_type_id: roomTypeId,
          code: type.code,
          active_physical_capacity: capacity,
          samples: unsafeRows.rows.map((r) => ({
            date: new Date(r.day.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10),
            reserved_qty: Number(r.reserved_qty),
            ledger_total_rooms: Number(r.total_rooms)
          }))
        });
      }
    }

    const legacy = await client.query(
      `SELECT COUNT(*)::int AS c FROM availability_dates WHERE room_type_id IS NULL`
    );
    report.legacy_unmapped_ledger_rows = Number(legacy.rows[0].c || 0);

    const duplicates = await client.query(
      `SELECT room_type_id, date::date AS day, COUNT(*)::int AS rows_count
       FROM availability_dates
       WHERE room_type_id IS NOT NULL
       GROUP BY room_type_id, date
       HAVING COUNT(*) > 1`
    );
    report.duplicate_ledger_rows = duplicates.rows.map((r) => ({
      room_type_id: Number(r.room_type_id),
      date: new Date(r.day.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10),
      rows: Number(r.rows_count)
    }));

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log(JSON.stringify(report, null, 2));

  const hasStructuralProblems =
    report.unsafe_types.length > 0 || report.duplicate_ledger_rows.length > 0;
  process.exitCode = hasStructuralProblems ? 2 : 0;
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(`reconciliation failed: ${err.message}`);
    try { await pool.end(); } catch (_e) { /* noop */ }
    process.exitCode = 1;
  });
