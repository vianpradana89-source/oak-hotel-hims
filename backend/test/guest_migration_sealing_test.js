#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');

const DISPOSABLE_DB = 'oak_guest_migration_test';

let adminPool;
let testPool;
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log('PASS | ' + label);
  } else {
    failed += 1;
    console.log('FAIL | ' + label);
  }
}

async function setupFreshDb() {
  if (testPool) {
    await testPool.end();
  }
  await adminPool.query('DROP DATABASE IF EXISTS ' + DISPOSABLE_DB);
  await adminPool.query('CREATE DATABASE ' + DISPOSABLE_DB);
  const adminUrl = process.env.TEST_DATABASE_URL
    || ('postgresql://' + (process.env.DB_USER || 'postgres') + ':' + (process.env.DB_PASSWORD || 'secretpassword') + '@' + (process.env.DB_HOST || '127.0.0.1') + ':' + (process.env.DB_PORT || 5432) + '/postgres');
  const testUrl = adminUrl.replace(/\/[^\/]*$/, '/' + DISPOSABLE_DB);
  testPool = new Pool({ connectionString: testUrl });
}

async function main() {
  const adminUrl = process.env.TEST_DATABASE_URL
    || ('postgresql://' + (process.env.DB_USER || 'postgres') + ':' + (process.env.DB_PASSWORD || 'secretpassword') + '@' + (process.env.DB_HOST || '127.0.0.1') + ':' + (process.env.DB_PORT || 5432) + '/postgres');

  adminPool = new Pool({ connectionString: adminUrl });

  const { initializeDatabase } = require('../dist/db/schema_v3');

  try {
    // =========================================================================
    // Scenario E — Fresh Database Bootstrap (Zero Guest Seeds, Data Neutral)
    // =========================================================================
    console.log('\n--- Scenario E: Fresh Database Bootstrap (Data-Neutral) ---');
    await setupFreshDb();

    await initializeDatabase(testPool);

    const markerCheck = await testPool.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'guest_b1_relational_foundation'"
    );
    assert(markerCheck.rowCount === 1, 'E1. Fresh DB creates guest_b1_relational_foundation migration marker');

    const tableCheck1 = await testPool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'guests'"
    );
    assert(tableCheck1.rowCount === 1, 'E2. Fresh DB creates guests table');

    const tableCheck2 = await testPool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'reservation_guests'"
    );
    assert(tableCheck2.rowCount === 1, 'E3. Fresh DB creates reservation_guests table');

    const guestCountFresh = await testPool.query('SELECT COUNT(*)::int AS cnt FROM guests');
    assert(guestCountFresh.rows[0].cnt === 0, 'E4. Fresh DB has 0 canonical guests (zero customer seeds)');

    const resGuestCountFresh = await testPool.query('SELECT COUNT(*)::int AS cnt FROM reservation_guests');
    assert(resGuestCountFresh.rows[0].cnt === 0, 'E5. Fresh DB has 0 reservation_guests');

    // =========================================================================
    // Scenario A — Pre-GUEST-B1 Legacy Database Upgrade
    // =========================================================================
    console.log('\n--- Scenario A: Pre-GUEST-B1 Legacy Database Upgrade ---');
    await setupFreshDb();

    // 1. Initialize schema first
    await initializeDatabase(testPool);

    // 2. Drop guests & reservation_guests and delete migration marker to simulate older DB state
    await testPool.query(`
      DROP TABLE IF EXISTS reservation_guests CASCADE;
      DROP TABLE IF EXISTS guests CASCADE;
      DELETE FROM schema_migrations WHERE version = 'guest_b1_relational_foundation';
    `);

    // 3. Create property, rooms, bookings, and legacy reservations
    const propRes = await testPool.query(
      "INSERT INTO properties (property_code, name, address) VALUES ('MIG1', 'Migration Prop', 'Jl. Migrasi') RETURNING id"
    );
    const propId = propRes.rows[0].id;

    const rtRes = await testPool.query(
      "INSERT INTO room_types (property_id, code, name, base_rate, capacity) VALUES ($1, 'DLX', 'Deluxe', 500000, 2) RETURNING id",
      [propId]
    );
    const rtId = rtRes.rows[0].id;

    const rmRes = await testPool.query(
      "INSERT INTO rooms (property_id, room_number, name, room_type_id, status) VALUES ($1, '801', 'Deluxe 801', $2, 'VACANT_CLEAN') RETURNING id",
      [propId, rtId]
    );
    const rmId = rmRes.rows[0].id;

    // Insert 3 bookings with 4 reservations (2 reservations share same guest name + phone)
    const b1 = await testPool.query("INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ('BID-M-1', $1, 'Ahmad Yani') RETURNING id", [propId]);
    const b2 = await testPool.query("INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ('BID-M-2', $1, 'Ahmad Yani') RETURNING id", [propId]);
    const b3 = await testPool.query("INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ('BID-M-3', $1, 'Dewi Sartika') RETURNING id", [propId]);

    const r1 = await testPool.query(
      "INSERT INTO reservations (booking_id, stay_sequence, guest_name, guest_phone, status, room_id, check_in, check_out) VALUES ($1, 1, 'Ahmad Yani', '0812333444', 'CHECKED_OUT', $2, '2026-08-01 14:00:00', '2026-08-03 12:00:00') RETURNING id",
      [b1.rows[0].id, rmId]
    );
    const r2 = await testPool.query(
      "INSERT INTO reservations (booking_id, stay_sequence, guest_name, guest_phone, status, room_id, check_in, check_out) VALUES ($1, 1, 'Ahmad Yani', '0812333444', 'CHECKED_IN', $2, '2026-08-10 14:00:00', '2026-08-12 12:00:00') RETURNING id",
      [b2.rows[0].id, rmId]
    );
    const r3 = await testPool.query(
      "INSERT INTO reservations (booking_id, stay_sequence, guest_name, guest_phone, status, room_id, check_in, check_out) VALUES ($1, 1, 'Dewi Sartika', '0815556667', 'BOOKED', $2, '2026-08-15 14:00:00', '2026-08-17 12:00:00') RETURNING id",
      [b3.rows[0].id, rmId]
    );
    const r4 = await testPool.query(
      "INSERT INTO reservations (booking_id, stay_sequence, guest_name, guest_phone, status, room_id, check_in, check_out) VALUES ($1, 2, 'Dewi Sartika (Diff Phone)', '0899999999', 'BOOKED', $2, '2026-08-17 14:00:00', '2026-08-19 12:00:00') RETURNING id",
      [b3.rows[0].id, rmId]
    );

    // 4. Run initializeDatabase to execute migration
    await initializeDatabase(testPool);

    // Assertions for Scenario A
    const markerA = await testPool.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'guest_b1_relational_foundation'"
    );
    assert(markerA.rowCount === 1, 'A1. guest_b1_relational_foundation migration marker created');

    const guestsA = await testPool.query('SELECT * FROM guests ORDER BY full_name');
    assert(guestsA.rowCount === 3, 'A2. Exactly 3 distinct guest profiles created from 4 reservations');

    const ahmadProfile = guestsA.rows.find(g => g.full_name === 'Ahmad Yani');
    assert(ahmadProfile !== undefined, 'A3. Ahmad Yani profile created');
    assert(ahmadProfile.phone === '0812333444', 'A4. Ahmad Yani phone matches');
    assert(ahmadProfile.vip_status === 'STANDARD', 'A5. Default vip_status is STANDARD');

    const resGuestsA = await testPool.query('SELECT * FROM reservation_guests ORDER BY reservation_id');
    assert(resGuestsA.rowCount === 4, 'A6. Exactly 4 reservation_guests links created (1 per reservation)');

    // Verify all links have legacy metadata
    for (const link of resGuestsA.rows) {
      assert(link.role === 'PRIMARY_GUEST', `A7. Reservation ${link.reservation_id} role is PRIMARY_GUEST`);
      assert(link.relation_source === 'LEGACY_RESERVATION_SNAPSHOT', `A8. Reservation ${link.reservation_id} source is LEGACY_RESERVATION_SNAPSHOT`);
      assert(link.is_legacy_inferred === true, `A9. Reservation ${link.reservation_id} is_legacy_inferred = true`);
      assert(link.identity_verified === false, `A10. Reservation ${link.reservation_id} identity_verified = false`);
    }

    // Verify both Ahmad reservations link to same guest_id
    const ahmadLinks = resGuestsA.rows.filter(l => l.reservation_id === r1.rows[0].id || l.reservation_id === r2.rows[0].id);
    assert(ahmadLinks.length === 2, 'A11. Found 2 Ahmad reservation links');
    assert(ahmadLinks[0].guest_id === ahmadLinks[1].guest_id, 'A12. Both Ahmad reservations linked to same guest_id');

    // =========================================================================
    // Scenario B — Second Initialization / Restart Idempotency
    // =========================================================================
    console.log('\n--- Scenario B: Second Initialization & Restart Idempotency ---');
    let errB = null;
    try {
      await initializeDatabase(testPool);
    } catch (e) {
      errB = e;
    }
    assert(errB === null, 'B1. Second initializeDatabase() completes without error');

    // =========================================================================
    // Scenario C & D — Migrated Guests and Links Survive Restart
    // =========================================================================
    console.log('\n--- Scenario C & D: Migrated Guests and Links Survive Restart ---');
    const guestsC = await testPool.query('SELECT * FROM guests ORDER BY full_name');
    assert(guestsC.rowCount === 3, 'C1. Guest count remains 3 after restart (no duplicate profiles)');

    const resGuestsD = await testPool.query('SELECT * FROM reservation_guests ORDER BY reservation_id');
    assert(resGuestsD.rowCount === 4, 'D1. Reservation_guests count remains 4 after restart (no duplicate links)');

    // =========================================================================
    // Scenario F — Legacy Snapshot Data Remains Untouched
    // =========================================================================
    console.log('\n--- Scenario F: Legacy Snapshot Data Intact ---');
    const res1Check = await testPool.query('SELECT guest_name, guest_phone FROM reservations WHERE id = $1', [r1.rows[0].id]);
    assert(res1Check.rows[0].guest_name === 'Ahmad Yani', 'F1. reservations.guest_name intact');
    assert(res1Check.rows[0].guest_phone === '0812333444', 'F2. reservations.guest_phone intact');

    const b1Check = await testPool.query('SELECT guest_name_snapshot FROM bookings WHERE id = $1', [b1.rows[0].id]);
    assert(b1Check.rows[0].guest_name_snapshot === 'Ahmad Yani', 'F3. bookings.guest_name_snapshot intact');

  } catch (err) {
    console.error('Migration sealing test error:', err);
    failed += 1;
  } finally {
    if (testPool) {
      await testPool.end();
    }
    if (adminPool) {
      await adminPool.query('DROP DATABASE IF EXISTS ' + DISPOSABLE_DB);
      await adminPool.end();
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
