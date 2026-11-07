'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const { ensureCanonicalAvailabilityRange } = require('../dist/domains/inventory/canonicalAvailability');

const pool = new Pool({
  host: process.env.PGHOST || process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.PGPORT || process.env.DB_PORT || 5432),
  user: process.env.PGUSER || process.env.DB_USER || 'postgres',
  password: process.env.PGPASSWORD || process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.PGDATABASE || process.env.DB_NAME || 'oak_hotel_db',
});

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    propertyId: undefined,
    roomTypeId: undefined,
    startDate: undefined,
    endDate: undefined,
    days: 730,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--property-id' && args[i + 1]) {
      options.propertyId = Number(args[i + 1]);
      i += 1;
    } else if (arg === '--room-type-id' && args[i + 1]) {
      options.roomTypeId = Number(args[i + 1]);
      i += 1;
    } else if (arg === '--start-date' && args[i + 1]) {
      options.startDate = args[i + 1];
      i += 1;
    } else if (arg === '--end-date' && args[i + 1]) {
      options.endDate = args[i + 1];
      i += 1;
    } else if (arg === '--days' && args[i + 1]) {
      options.days = Number(args[i + 1]);
      i += 1;
    }
  }

  return options;
}

async function runInvariantChecks(client, options) {
  console.log('\n--- Checking Availability Ledger Invariants ---');

  // Check 1: reserved_qty < 0
  const negativeRes = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM availability_dates
     WHERE reserved_qty < 0`
  );
  const negativeCount = Number(negativeRes.rows[0]?.count || 0);

  // Check 2: reserved_qty > total_rooms
  const overbookedRes = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM availability_dates
     WHERE reserved_qty > total_rooms`
  );
  const overbookedCount = Number(overbookedRes.rows[0]?.count || 0);

  // Check 3: Inventory drift check (active BOOKED/CHECKED_IN nights vs reserved_qty)
  // For dates >= CURRENT_DATE
  const driftRes = await client.query(
    `WITH expected_reservations AS (
       SELECT rm.room_type_id,
              d::date AS date,
              COUNT(*)::int AS expected_reserved_qty
       FROM reservations res
       JOIN rooms rm ON rm.id = res.room_id
       CROSS JOIN LATERAL generate_series(res.check_in::date, (res.check_out::date - '1 day'::interval)::date, '1 day'::interval) d
       WHERE res.status IN ('BOOKED', 'CHECKED_IN')
         AND rm.room_type_id IS NOT NULL
       GROUP BY rm.room_type_id, d::date
     ),
     expected_holds AS (
       SELECT al.room_type_id,
              al.date::date AS date,
              SUM(al.qty_locked)::int AS hold_qty
       FROM availability_locks al
       WHERE al.reservation_id IS NULL
         AND al.lock_expires_at > NOW()
       GROUP BY al.room_type_id, al.date::date
     ),
     ledger_comparison AS (
       SELECT ad.room_type_id,
              ad.date,
              ad.reserved_qty,
              (COALESCE(er.expected_reserved_qty, 0) + COALESCE(eh.hold_qty, 0)) AS expected_qty,
              (ad.reserved_qty - (COALESCE(er.expected_reserved_qty, 0) + COALESCE(eh.hold_qty, 0))) AS drift
       FROM availability_dates ad
       LEFT JOIN expected_reservations er
         ON er.room_type_id = ad.room_type_id AND er.date = ad.date
       LEFT JOIN expected_holds eh
         ON eh.room_type_id = ad.room_type_id AND eh.date = ad.date
       WHERE ad.room_type_id IS NOT NULL
         AND ad.date >= CURRENT_DATE
     )
     SELECT COUNT(*)::int AS drift_count
     FROM ledger_comparison
     WHERE drift <> 0;`
  );
  const driftCount = Number(driftRes.rows[0]?.drift_count || 0);

  console.log(`- reserved_qty < 0 count: ${negativeCount} [${negativeCount === 0 ? 'PASS' : 'FAIL'}]`);
  console.log(`- reserved_qty > total_rooms count: ${overbookedCount} [${overbookedCount === 0 ? 'PASS' : 'FAIL'}]`);
  console.log(`- inventory drift count: ${driftCount} [${driftCount === 0 ? 'PASS' : 'FAIL'}]`);

  const passed = negativeCount === 0 && overbookedCount === 0 && driftCount === 0;
  return { passed, negativeCount, overbookedCount, driftCount };
}

async function main() {
  const options = parseArgs();
  console.log('Operational Backfill & Verification of Canonical Availability');
  console.log(`Options: ${JSON.stringify(options, null, 2)}`);

  const client = await pool.connect();
  try {
    // Determine dates if not provided
    let startDate = options.startDate;
    let endDate = options.endDate;

    if (!startDate) {
      const todayRes = await client.query(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date AS today;`);
      startDate = todayRes.rows[0].today.toISOString().split('T')[0];
    }

    if (!endDate) {
      const endRes = await client.query(
        `SELECT ($1::date + ($2 || ' days')::interval)::date AS end_date;`,
        [startDate, String(options.days)]
      );
      endDate = endRes.rows[0].end_date.toISOString().split('T')[0];
    }

    console.log(`Effective date range: ${startDate} to ${endDate}`);

    const roomTypeIds = options.roomTypeId ? [options.roomTypeId] : undefined;

    if (options.dryRun) {
      console.log('\n[DRY RUN] Inspecting missing availability rows...');
      const checkRes = await client.query(
        `WITH target_types AS (
           SELECT rt.id AS room_type_id, rt.name
           FROM room_types rt
           WHERE rt.is_active = TRUE
             AND ($1::int IS NULL OR rt.property_id = $1::int)
             AND ($2::int[] IS NULL OR rt.id = ANY($2::int[]))
         ),
         target_dates AS (
           SELECT d::date AS date
           FROM generate_series($3::date, $4::date, '1 day'::interval) d
         ),
         cross_required AS (
           SELECT tt.room_type_id, tt.name, td.date
           FROM target_types tt
           CROSS JOIN target_dates td
         )
         SELECT cr.room_type_id, cr.name, COUNT(*)::int AS missing_dates_count
         FROM cross_required cr
         LEFT JOIN availability_dates ad
           ON ad.room_type_id = cr.room_type_id AND ad.date = cr.date
         WHERE ad.id IS NULL
         GROUP BY cr.room_type_id, cr.name
         ORDER BY cr.room_type_id;`,
        [options.propertyId || null, roomTypeIds || null, startDate, endDate]
      );

      console.log(`Missing rows summary by room type:`);
      let totalMissing = 0;
      for (const row of checkRes.rows) {
        console.log(`  Room type ${row.room_type_id} (${row.name}): ${row.missing_dates_count} missing dates`);
        totalMissing += Number(row.missing_dates_count);
      }
      console.log(`Total missing availability ledger rows: ${totalMissing}`);
    } else {
      console.log('\nEnsuring canonical availability rows in range...');
      await client.query('BEGIN');
      const insertedCount = await ensureCanonicalAvailabilityRange(client, {
        propertyId: options.propertyId,
        roomTypeIds,
        startDate,
        endDate,
      });
      await client.query('COMMIT');
      console.log(`Successfully created/ensured ${insertedCount} availability ledger rows.`);
    }

    const invariants = await runInvariantChecks(client, options);
    if (!invariants.passed) {
      console.error('\nERROR: One or more availability invariants failed!');
      process.exitCode = 1;
    } else {
      console.log('\nPASS: All availability invariants verified successfully.');
    }
  } catch (err) {
    if (!options.dryRun) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('Backfill script failed:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
