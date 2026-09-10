/**
 * reconcile_primary_guest_phones.js
 *
 * Operational utility to reconcile missing canonical primary guest phones
 * from reservations.guest_phone for linked PRIMARY_GUEST relations.
 *
 * SAFETY INVARIANTS:
 * 1. Defaults to DRY-RUN mode. Requires explicit --execute flag to make changes.
 * 2. Only targets guests whose phone IS NULL OR TRIM(phone) = ''.
 * 3. Never overwrites an existing valid canonical phone.
 * 4. Normalizes phone using canonical normalizeDigitsOnly.
 * 5. Multi-reservation grouping & conflict detection:
 *    - SAFE: exactly one distinct normalized phone exists across all candidate reservations.
 *    - CONFLICT: multiple distinct normalized phones exist for the same guest_id.
 *      Never auto-update conflicting guests; report conflict and skip even in --execute mode.
 * 6. Runs within a transaction with automatic rollback on error.
 *
 * DO NOT EXECUTE AUTOMATICALLY.
 */

require('dotenv').config();
const { Pool } = require('pg');
const { normalizeDigitsOnly } = require('../dist/domains/guests/guestService');

/**
 * Pure classification helper: groups candidates by guest_id and classifies as SAFE or CONFLICT.
 *
 * @param {Array} candidates - Flat candidate rows from database query
 * @param {Function} normalizeFn - Phone normalization function (default normalizeDigitsOnly)
 * @returns {{ safe: Array, conflicts: Array }}
 */
function classifyReconciliationCandidates(candidates, normalizeFn = normalizeDigitsOnly) {
  const byGuest = new Map();

  for (const c of candidates) {
    const guestId = Number(c.guest_id);
    if (!byGuest.has(guestId)) {
      byGuest.set(guestId, {
        guestId,
        canonicalGuestName: c.canonical_guest_name || c.reservation_guest_name,
        canonicalPhone: c.canonical_guest_phone,
        reservations: []
      });
    }
    const entry = byGuest.get(guestId);
    const rawPhone = c.reservation_guest_phone != null ? String(c.reservation_guest_phone).trim() : '';
    if (rawPhone !== '') {
      const normPhone = normalizeFn(rawPhone);
      entry.reservations.push({
        reservationId: Number(c.reservation_id),
        rawPhone,
        normalizedPhone: normPhone
      });
    }
  }

  const safe = [];
  const conflicts = [];

  for (const [guestId, group] of byGuest.entries()) {
    const distinctNormPhones = Array.from(new Set(group.reservations.map(r => r.normalizedPhone).filter(Boolean)));

    if (distinctNormPhones.length === 1) {
      const matchedRes = group.reservations.find(r => r.normalizedPhone === distinctNormPhones[0]);
      safe.push({
        guestId,
        guestName: group.canonicalGuestName,
        phone: matchedRes.rawPhone,
        normalizedPhone: distinctNormPhones[0],
        reservationIds: group.reservations.map(r => r.reservationId)
      });
    } else if (distinctNormPhones.length > 1) {
      conflicts.push({
        guestId,
        guestName: group.canonicalGuestName,
        distinctNormalizedPhones: distinctNormPhones,
        conflictingReservations: group.reservations.map(r => ({
          reservationId: r.reservationId,
          rawPhone: r.rawPhone,
          normalizedPhone: r.normalizedPhone
        }))
      });
    }
  }

  return { safe, conflicts };
}

/**
 * Executes or simulates reconciliation on the database client.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ isExecuteMode?: boolean }} options
 */
async function reconcilePrimaryGuestPhones(client, options = {}) {
  const isExecuteMode = Boolean(options.isExecuteMode);
  console.log(`[RECONCILIATION] Mode: ${isExecuteMode ? 'EXECUTE' : 'DRY-RUN (read-only)'}`);

  // Query candidate PRIMARY_GUEST relations where guests.phone is blank/null
  // and reservations.guest_phone is present.
  const candidatesRes = await client.query(`
    SELECT
      r.id AS reservation_id,
      r.booking_id,
      r.room_id,
      r.guest_name AS reservation_guest_name,
      r.guest_phone AS reservation_guest_phone,
      rg.id AS relation_id,
      rg.guest_id,
      g.full_name AS canonical_guest_name,
      g.phone AS canonical_guest_phone,
      g.normalized_phone AS canonical_normalized_phone
    FROM reservations r
    JOIN reservation_guests rg ON rg.reservation_id = r.id AND rg.role = 'PRIMARY_GUEST'
    JOIN guests g ON g.id = rg.guest_id
    WHERE (g.phone IS NULL OR TRIM(g.phone) = '')
      AND r.guest_phone IS NOT NULL
      AND TRIM(r.guest_phone) <> ''
    ORDER BY rg.guest_id ASC, r.id ASC
  `);

  const candidates = candidatesRes.rows;
  console.log(`[RECONCILIATION] Found ${candidates.length} candidate reservation record(s).`);

  const { safe, conflicts } = classifyReconciliationCandidates(candidates, normalizeDigitsOnly);

  if (conflicts.length > 0) {
    console.warn(`[RECONCILIATION] Identified ${conflicts.length} CONFLICTING guest record(s). These will NEVER be automatically updated:`);
    for (const conf of conflicts) {
      const details = conf.conflictingReservations
        .map(cr => `Res #${cr.reservationId}: '${cr.rawPhone}' (norm: ${cr.normalizedPhone})`)
        .join(', ');
      console.warn(`  - Guest #${conf.guestId} (${conf.guestName}): ${details}`);
    }
  }

  if (safe.length === 0) {
    console.log('[RECONCILIATION] No safe candidates to backfill.');
    return {
      totalCandidates: candidates.length,
      safeCount: 0,
      conflictCount: conflicts.length,
      updatedCount: 0,
      safe,
      conflicts
    };
  }

  console.log(`[RECONCILIATION] Found ${safe.length} SAFE candidate(s) for backfill:`);
  console.table(
    safe.map(s => ({
      guest_id: s.guestId,
      guest_name: s.guestName,
      proposed_phone: s.phone,
      proposed_norm_phone: s.normalizedPhone,
      reservation_ids: s.reservationIds.join(', ')
    }))
  );

  let updatedCount = 0;

  if (!isExecuteMode) {
    console.log('[DRY-RUN] No database modifications were committed. Pass --execute to apply changes.');
    return {
      totalCandidates: candidates.length,
      safeCount: safe.length,
      conflictCount: conflicts.length,
      updatedCount: 0,
      safe,
      conflicts
    };
  }

  for (const s of safe) {
    const updateRes = await client.query(
      `UPDATE guests
       SET phone = $1,
           normalized_phone = $2,
           updated_at = NOW()
       WHERE id = $3
         AND (phone IS NULL OR TRIM(phone) = '')`,
      [s.phone, s.normalizedPhone, s.guestId]
    );

    if ((updateRes.rowCount ?? 0) > 0) {
      updatedCount += updateRes.rowCount;
    }
  }

  console.log(`[EXECUTE] Successfully updated ${updatedCount} canonical guest record(s).`);
  if (conflicts.length > 0) {
    console.log(`[EXECUTE] Skipped ${conflicts.length} conflicting guest record(s).`);
  }

  return {
    totalCandidates: candidates.length,
    safeCount: safe.length,
    conflictCount: conflicts.length,
    updatedCount,
    safe,
    conflicts
  };
}

async function main() {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'secretpassword',
    database: process.env.DB_NAME || 'oak_hotel_db'
  });

  const isExecuteMode = process.argv.includes('--execute');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await reconcilePrimaryGuestPhones(client, { isExecuteMode });
    if (isExecuteMode) {
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
    }
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[RECONCILIATION] Fatal error during reconciliation:', error.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[RECONCILIATION] Unhandled error:', err);
    process.exit(1);
  });
}

module.exports = {
  classifyReconciliationCandidates,
  reconcilePrimaryGuestPhones
};
