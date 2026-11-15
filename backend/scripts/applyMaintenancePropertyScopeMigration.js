#!/usr/bin/env node
/**
 * Targeted corrective migration: add property_id to maintenance_tasks and
 * safely handle pre-existing legacy demo rows.
 *
 * Migration version: property_scoped_ops_legacy_fix_v1
 *
 * Execution requirements
 * ──────────────────────
 *   DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME  — all REQUIRED.
 *   DB_USER MUST be exactly "postgres".
 *
 *   node scripts/applyMaintenancePropertyScopeMigration.js
 *
 * CRITICAL — this script:
 *   - Does NOT modify backend/src/db/schema_v3.ts
 *   - Does NOT modify backend/src/index.ts
 *   - Does NOT depend on RUN_SCHEMA_INITIALIZATION
 *   - Does NOT run automatically on app boot
 */
require('dotenv').config();
const { Pool } = require('pg');

const MIGRATION_VERSION = 'property_scoped_ops_legacy_fix_v1';

// ── 0. Require all DB env vars — no fallbacks ──────────────────────
const MISSING = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']
  .filter(k => !process.env[k] || !process.env[k].trim());

if (MISSING.length > 0) {
  console.error(`[${MIGRATION_VERSION}] Missing required environment variables:`);
  console.error('  ' + MISSING.join(', '));
  process.exit(1);
}

// Enforce DB_USER === 'postgres' exactly. Fail before BEGIN.
const DB_USER = process.env.DB_USER.trim();
if (DB_USER !== 'postgres') {
  console.error(
    `[${MIGRATION_VERSION}] DB_USER must be exactly 'postgres' ` +
    `(got '${DB_USER}'). Aborting before connection.`
  );
  process.exit(1);
}

// Destructive legacy-row handling is OFF by default.
// Only the exact string "1" enables it.
const ALLOW_DESTRUCTIVE = process.env.ALLOW_DESTRUCTIVE_LEGACY === '1';

const pool = new Pool({
  host:     process.env.DB_HOST.trim(),
  port:     parseInt(process.env.DB_PORT, 10),
  user:     DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME.trim()
});

// ── Deterministic room-mapping helper ──────────────────────────────
// For a given room_number, returns:
//   { status: 'deterministic', property_id: <id> }  — exactly 1 distinct non-null property
//   { status: 'unresolved' }                         — 0 matching rooms
//   { status: 'ambiguous' }                           — >1 distinct properties
//
// Canonical rule: COUNT(DISTINCT rooms.property_id) WHERE
//   rooms.room_number = $1 AND rooms.property_id IS NOT NULL  ==  1
async function resolveRoomNumberProperty(client, roomNumber) {
  if (roomNumber == null || String(roomNumber).trim() === '') {
    return { status: 'unresolved' };
  }
  const res = await client.query(
    `SELECT COUNT(DISTINCT property_id)::int AS distinct_cnt,
            MIN(property_id) AS sole_property_id
     FROM rooms
     WHERE room_number = $1
       AND property_id IS NOT NULL`,
    [String(roomNumber).trim()]
  );
  const cnt = Number(res.rows[0].distinct_cnt);
  if (cnt === 1) {
    return { status: 'deterministic', property_id: res.rows[0].sole_property_id };
  }
  if (cnt === 0) {
    return { status: 'unresolved' };
  }
  return { status: 'ambiguous' };
}

// ── Exact known-demo fingerprints (unresolved only: 118, 402) ─────
// Each entry is a full-row fingerprint. Deletion is allowed ONLY when
// ALL listed fields match exactly.
//
// Room 204 is NOT in this list — it is expected to be resolved
// deterministically via the rooms table (room 204 → property 1).
const KNOWN_DEMO_FINGERPRINTS = [
  {
    label: 'demo-118',
    id:          2,
    room_number: '118',
    issue_type:    'PLUMBING',
    priority:      'MEDIUM',
    status:        'IN_PROGRESS'
  },
  {
    label: 'demo-402',
    id:          3,
    room_number: '402',
    issue_type:    'LIGHTING',
    priority:      'LOW',
    status:        'OPEN'
  }
];

/**
 * Check whether a row (from the nullRows query) matches a known demo
 * fingerprint EXACTLY on ALL five fields:
 *   id, room_number, issue_type, priority, status.
 *
 * Returns the fingerprint entry on match, or null.
 *
 * created_at is intentionally NOT part of the fingerprint: the strict
 * five-field identity (including primary key `id`) is sufficient to
 * uniquely and safely identify a known legacy demo row, and relying on
 * a timestamp cutoff causes false negatives for demo rows inserted in
 * a later era.
 */
function matchKnownDemoFingerprint(row) {
  for (const fp of KNOWN_DEMO_FINGERPRINTS) {
    const roomStr = row.room_number == null ? null : String(row.room_number).trim();
    if (Number(row.id) !== fp.id) continue;
    if (roomStr !== fp.room_number) continue;
    if (row.issue_type !== fp.issue_type) continue;
    if (row.priority   !== fp.priority)   continue;
    if (row.status     !== fp.status)     continue;

    return fp; // exact match on id + room_number + issue_type + priority + status
  }
  return null;
}

async function run() {
  const client = await pool.connect();
  try {
    // ── BEGIN TRANSACTION ────────────────────────────────────────────
    await client.query('BEGIN');
    // Serialize with any concurrent schema migration holding the same lock.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('oak_hims_property_scoped_ops_legacy_fix_lock'))"
    );

    // ── 1. Ensure schema_migrations exists ─────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    VARCHAR(100) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── 2. Already applied? → verify final state and exit cleanly ──
    const already = await client.query(
      'SELECT 1 FROM schema_migrations WHERE version = $1',
      [MIGRATION_VERSION]
    );
    if ((already.rowCount ?? 0) > 0) {
      console.log(`[${MIGRATION_VERSION}] Marker exists — re-verifying final-state integrity …`);
      await verifyFinalState(client, true); // expectMarker = true
      await client.query('COMMIT');
      console.log(`[${MIGRATION_VERSION}] ✅ Re-verification passed. Nothing to do.`);
      return;
    }

    // ── 3. Pre-flight: confirm maintenance_tasks exists ────────────
    const tableCheck = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'maintenance_tasks'"
    );
    if ((tableCheck.rowCount ?? 0) === 0) {
      throw new Error(
        'maintenance_tasks table not found. Aborting — do NOT create it here; ' +
        'fresh DBs get it from schema_v3.ts at boot.'
      );
    }

    // ── 4. ALTER ADD COLUMN (nullable, no default) ────────────────
    await client.query(`
      ALTER TABLE maintenance_tasks
        ADD COLUMN IF NOT EXISTS property_id INTEGER;
    `);
    console.log(`[MIGRATION] maintenance_tasks.property_id ensured (nullable, no default).`);

    // ── 5. Classify and resolve legacy rows ─────────────────────────
    //
    // For every row with property_id IS NULL:
    //   a) If room_number maps deterministically to exactly one property
    //      → backfill that property_id.
    //   b) Otherwise, if the row matches a known demo fingerprint AND
    //      ALLOW_DESTRUCTIVE is enabled → delete it.
    //   c) Any remaining unresolved row → THROW (rollback).
    //
    // Track row counts for conservation check.
    //

    // 5a. Capture rowCountBefore
    const rowCountBeforeRes = await client.query(
      'SELECT COUNT(*)::int AS cnt FROM maintenance_tasks'
    );
    const rowCountBefore = Number(rowCountBeforeRes.rows[0].cnt);

    // 5b. Get all null-property rows
    const nullRowsRes = await client.query(`
      SELECT id, room_number, issue_type, priority, status,
             due_at, created_at
      FROM maintenance_tasks
      WHERE property_id IS NULL
      ORDER BY id
    `);
    const nullRows = nullRowsRes.rows;
    console.log(`[MIGRATION] ${nullRows.length} row(s) with null property_id.`);

    let deterministicBackfillCount = 0;
    let verifiedDemoDeleteCount = 0;

    for (const row of nullRows) {
      // (a) Try deterministic resolution via rooms table
      const roomNum = row.room_number == null ? null : String(row.room_number).trim();
      const resolution = await resolveRoomNumberProperty(client, roomNum);

      if (resolution.status === 'deterministic') {
        const upd = await client.query(
          'UPDATE maintenance_tasks SET property_id = $1 WHERE id = $2',
          [resolution.property_id, row.id]
        );
        deterministicBackfillCount += Number(upd.rowCount ?? 0);
        console.log(
          `[MIGRATION] Backfilled row id=${row.id} (room=${roomNum}) → property_id=${resolution.property_id} ` +
          `(deterministic rooms lookup).`
        );
        continue;
      }

      // (b) Not deterministically resolvable — check known demo fingerprints
      const fpMatch = matchKnownDemoFingerprint(row);

      if (fpMatch && ALLOW_DESTRUCTIVE) {
        // Verify exact fingerprint count before deletion (safety net).
        // Uses the full five-field identity (id + 4 fields).
        const fpCountRes = await client.query(`
          SELECT COUNT(*)::int AS cnt
          FROM maintenance_tasks
          WHERE property_id IS NULL
            AND id            = $1
            AND room_number   = $2
            AND issue_type    = $3
            AND priority      = $4
            AND status        = $5
        `, [fpMatch.id, fpMatch.room_number, fpMatch.issue_type, fpMatch.priority, fpMatch.status]);
        const fpCount = Number(fpCountRes.rows[0].cnt);

        if (fpCount !== 1) {
          throw new Error(
            `Expected exactly 1 row for demo fingerprint ${fpMatch.label} ` +
            `(id=${fpMatch.id}, room=${fpMatch.room_number}), found ${fpCount}. ` +
            'Aborting to prevent mass deletion.'
          );
        }

        const del = await client.query(`
          DELETE FROM maintenance_tasks
          WHERE property_id IS NULL
            AND id            = $1
            AND room_number   = $2
            AND issue_type    = $3
            AND priority      = $4
            AND status        = $5
        `, [fpMatch.id, fpMatch.room_number, fpMatch.issue_type, fpMatch.priority, fpMatch.status]);

        const deletedRows = Number(del.rowCount ?? 0);
        if (deletedRows !== 1) {
          throw new Error(
            `Expected to delete exactly 1 row for ${fpMatch.label}, deleted ${deletedRows}. Aborting.`
          );
        }
        verifiedDemoDeleteCount += deletedRows;
        console.log(
          `[MIGRATION] ⚠️  Deleted legacy demo row ${fpMatch.label} ` +
          `(room=${fpMatch.room_number}, issue_type=${fpMatch.issue_type}, ` +
          `priority=${fpMatch.priority}, status=${fpMatch.status}).`
        );
        continue;
      }

      // (c) Unresolvable — fail closed
      if (ALLOW_DESTRUCTIVE) {
        throw new Error(
          `Cannot determine property_id for maintenance_tasks row ` +
          `id=${row.id} (room=${JSON.stringify(roomNum)}, ` +
          `issue_type=${JSON.stringify(row.issue_type)}, ` +
          `priority=${JSON.stringify(row.priority)}, ` +
          `status=${JSON.stringify(row.status)}). ` +
          'Destructive flag is ON but row does not match any known demo fingerprint. ' +
          'Classify manually.'
        );
      } else {
        throw new Error(
          `Cannot determine property_id for maintenance_tasks row ` +
          `id=${row.id} (room=${JSON.stringify(roomNum)}, ` +
          `issue_type=${JSON.stringify(row.issue_type)}). ` +
          'ALLOW_DESTRUCTIVE_LEGACY is not set, so destructive handling is disabled. ' +
          'Resolve this row manually or re-run with ALLOW_DESTRUCTIVE_LEGACY=1 ' +
          'after confirming it is a safe legacy demo row.'
        );
      }
    }

    // ── 5c. Row conservation check ──────────────────────────────────
    const rowCountAfterRes = await client.query(
      'SELECT COUNT(*)::int AS cnt FROM maintenance_tasks'
    );
    const rowCountAfter = Number(rowCountAfterRes.rows[0].cnt);

    const expectedAfter = rowCountBefore - verifiedDemoDeleteCount;
    if (rowCountAfter !== expectedAfter) {
      throw new Error(
        `Row conservation violation: before=${rowCountBefore}, ` +
        `deleted=${verifiedDemoDeleteCount}, expected_after=${expectedAfter}, ` +
        `actual_after=${rowCountAfter}. Aborting.`
      );
    }
    console.log(
      `[MIGRATION] Row conservation: before=${rowCountBefore}, ` +
      `backfilled=${deterministicBackfillCount}, deleted=${verifiedDemoDeleteCount}, ` +
      `after=${rowCountAfter}. OK.`
    );

    // ── 6. Zero NULL validation ─────────────────────────────────────
    const remainingNull = await client.query(
      'SELECT COUNT(*)::int AS cnt FROM maintenance_tasks WHERE property_id IS NULL'
    );
    if (Number(remainingNull.rows[0].cnt) > 0) {
      throw new Error(
        `Cannot enforce NOT NULL — ${remainingNull.rows[0].cnt} row(s) still have ` +
        `null property_id. Re-run with correct classification.`
      );
    }

    // ── 7. Foreign key constraint (source-faithful) ────────────────
    // schema_v3.ts:125 — property_id INTEGER NOT NULL REFERENCES properties(id)
    // No explicit ON DELETE clause in source → PostgreSQL default NO ACTION.
    // Detect any existing FK on property_id (regardless of constraint name).
    const existingFkRes = await client.query(`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'maintenance_tasks'::regclass
        AND contype  = 'f'
        AND conkey   = ARRAY[
            (SELECT attnum FROM pg_attribute
             WHERE attrelid = 'maintenance_tasks'::regclass
               AND attname  = 'property_id')
          ]
    `);

    if ((existingFkRes.rowCount ?? 0) > 0) {
      // Check each existing FK: is it pointing to properties(id)?
      let correctFkExists = false;
      for (const fc of existingFkRes.rows) {
        const fkDetail = await client.query(`
          SELECT pg_get_constraintdef(c.oid) AS def
          FROM pg_constraint c
          WHERE c.conname = $1
            AND c.conrelid = 'maintenance_tasks'::regclass
        `, [fc.conname]);
        const def = String(fkDetail.rows[0].def || '');
        if (/REFERENCES\s+properties\s*\(\s*id\s*\)/i.test(def)) {
          correctFkExists = true;
        }
      }
      if (correctFkExists) {
        console.log(`[MIGRATION] FK on maintenance_tasks.property_id → properties(id) already exists — skipped.`);
      } else {
        throw new Error(
          'Conflicting FK found on maintenance_tasks.property_id that does NOT ' +
          'reference properties(id). Manual intervention required. Aborting.'
        );
      }
    } else {
      // No FK exists yet — add it (source-faithful: no explicit ON DELETE)
      await client.query(`
        ALTER TABLE maintenance_tasks
          ADD CONSTRAINT maintenance_tasks_property_id_fkey
          FOREIGN KEY (property_id) REFERENCES properties(id);
      `);
      console.log(`[MIGRATION] Added FK maintenance_tasks_property_id_fkey → properties(id).`);
    }

    // ── 8. NOT NULL enforcement (guarded) ──────────────────────────
    // Only execute if property_id is still nullable.
    const nullableCheck = await client.query(`
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'maintenance_tasks'
        AND column_name  = 'property_id'
    `);
    if (nullableCheck.rows.length === 1 && nullableCheck.rows[0].is_nullable === 'YES') {
      await client.query(`
        ALTER TABLE maintenance_tasks
          ALTER COLUMN property_id SET NOT NULL;
      `);
      console.log(`[MIGRATION] maintenance_tasks.property_id is now NOT NULL.`);
    } else {
      console.log(`[MIGRATION] maintenance_tasks.property_id is already NOT NULL — skipped.`);
    }

    // ── 9. Final-state verification (pre-marker) ────────────────────
    await verifyFinalState(client, false); // expectMarker = false
    console.log(`[INTEGRITY] ✅ Final-state checks passed.`);

    // ���─ 10. Write migration marker LAST ─────────────────────────────
    await client.query(
      'INSERT INTO schema_migrations (version) VALUES ($1)',
      [MIGRATION_VERSION]
    );
    console.log(`[MIGRATION] Marked ${MIGRATION_VERSION} as applied.`);

    await client.query('COMMIT');
    console.log(`[${MIGRATION_VERSION}] ✅ Committed successfully.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[${MIGRATION_VERSION}] ❌ Failed (rolled back):`, err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Post-migration integrity checks.
 *
 * @param {object} client  - pg client
 * @param {boolean} expectMarker  - true on idempotent re-run (marker must
 *   already exist); false on first apply, just before the marker INSERT.
 */
async function verifyFinalState(client, expectMarker) {
  const errors = [];

  // 1. property_id column exists
  const colCheck = await client.query(`
    SELECT data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'maintenance_tasks'
      AND column_name  = 'property_id'
  `);
  if ((colCheck.rowCount ?? 0) === 0) {
    errors.push('maintenance_tasks.property_id column is missing');
  } else {
    // 2. type must be integer
    if (colCheck.rows[0].data_type !== 'integer') {
      errors.push(`maintenance_tasks.property_id has unexpected type '${colCheck.rows[0].data_type}', expected 'integer'`);
    }
    // 3. NOT NULL
    if (colCheck.rows[0].is_nullable === 'YES') {
      errors.push('maintenance_tasks.property_id is still nullable');
    }
  }

  // 4. Zero NULL rows
  const nullRows = await client.query(
    'SELECT COUNT(*)::int AS cnt FROM maintenance_tasks WHERE property_id IS NULL'
  );
  if (Number(nullRows.rows[0].cnt) > 0) {
    errors.push(`${nullRows.rows[0].cnt} row(s) still have null property_id`);
  }

  // 5. Zero orphan property_ids
  const orphans = await client.query(`
    SELECT COUNT(*)::int AS cnt
    FROM maintenance_tasks mt
    LEFT JOIN properties p ON p.id = mt.property_id
    WHERE p.id IS NULL
  `);
  if (Number(orphans.rows[0].cnt) > 0) {
    errors.push(`${orphans.rows[0].cnt} maintenance_tasks row(s) reference unknown properties`);
  }

  // 6. Correct property FK exists (by column, not by name)
  const fkRes = await client.query(`
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'maintenance_tasks'::regclass
      AND contype  = 'f'
      AND conkey   = ARRAY[
          (SELECT attnum FROM pg_attribute
           WHERE attrelid = 'maintenance_tasks'::regclass
             AND attname  = 'property_id')
        ]
  `);
  if ((fkRes.rowCount ?? 0) === 0) {
    errors.push('No FK constraint found on maintenance_tasks.property_id');
  } else {
    // Verify at least one FK points to properties(id)
    let correctFk = false;
    let conflictingFk = false;
    for (const fc of fkRes.rows) {
      const fkDetail = await client.query(
        'SELECT pg_get_constraintdef(c.oid) AS def ' +
        'FROM pg_constraint c ' +
        'WHERE c.conname = $1 ' +
        "  AND c.conrelid = 'maintenance_tasks'::regclass",
        [fc.conname]
      );
      const def = String(fkDetail.rows[0].def || '');
      if (/REFERENCES\s+properties\s*\(\s*id\s*\)/i.test(def)) {
        correctFk = true;
      } else {
        conflictingFk = true;
      }
    }
    if (!correctFk) {
      errors.push('No FK on maintenance_tasks.property_id references properties(id)');
    }
    if (conflictingFk) {
      errors.push('Conflicting FK on maintenance_tasks.property_id does not reference properties(id)');
    }
  }

  // 7. maintenance_tasks_pkey still exists and is correct
  const pkeyCheck = await client.query(`
    SELECT 1 FROM pg_constraint
    WHERE conname = 'maintenance_tasks_pkey'
      AND conrelid = 'maintenance_tasks'::regclass
      AND contype  = 'p'
  `);
  if ((pkeyCheck.rowCount ?? 0) === 0) {
    errors.push('maintenance_tasks_pkey is missing or not a PRIMARY KEY');
  }

  // 8. assigned_employee_id FK still exists
  const empFkCheck = await client.query(`
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'maintenance_tasks'::regclass
      AND contype  = 'f'
      AND conkey   = ARRAY[
          (SELECT attnum FROM pg_attribute
           WHERE attrelid = 'maintenance_tasks'::regclass
             AND attname  = 'assigned_employee_id')
        ]
      AND confrelid = 'hr_employees'::regclass
  `);
  if ((empFkCheck.rowCount ?? 0) === 0) {
    errors.push('maintenance_tasks.assigned_employee_id FK to hr_employees is missing');
  }

  // 9. idx_maintenance_tasks_assigned_emp still exists
  const empIdxCheck = await client.query(`
    SELECT 1 FROM pg_class
    WHERE relname = 'idx_maintenance_tasks_assigned_emp'
  `);
  if ((empIdxCheck.rowCount ?? 0) === 0) {
    errors.push('Index idx_maintenance_tasks_assigned_emp is missing');
  }

  // 10. schema_migrations structure check
  const smColCheck = await client.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'schema_migrations'
    ORDER BY ordinal_position
  `);
  if ((smColCheck.rowCount ?? 0) < 2) {
    errors.push('schema_migrations structure incomplete (expected at least version + applied_at)');
  } else {
    const cols = smColCheck.rows.map(r => r.column_name);
    if (!cols.includes('version')) {
      errors.push('schema_migrations missing "version" column');
    }
    if (!cols.includes('applied_at')) {
      errors.push('schema_migrations missing "applied_at" column');
    }
  }

  // 11. Marker present (only enforced on idempotent re-run path)
  if (expectMarker) {
    const markerCheck = await client.query(
      'SELECT 1 FROM schema_migrations WHERE version = $1',
      [MIGRATION_VERSION]
    );
    if ((markerCheck.rowCount ?? 0) === 0) {
      errors.push('Migration marker missing from schema_migrations');
    }
  }

  if (errors.length > 0) {
    console.error(`[INTEGRITY] ERRORS:`, errors);
    throw new Error('Final-state integrity check failed — see above');
  }
}

run();
