#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');

const DISPOSABLE_DB = 'oak_audit_sealing_test';

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
  var adminUrl = process.env.TEST_DATABASE_URL
    || ('postgresql://' + (process.env.DB_USER || 'postgres') + ':' + (process.env.DB_PASSWORD || 'secretpassword') + '@' + (process.env.DB_HOST || '127.0.0.1') + ':' + (process.env.DB_PORT || 5432) + '/postgres');
  var testUrl = adminUrl.replace(/\/[^\/]*$/, '/' + DISPOSABLE_DB);
  testPool = new Pool({ connectionString: testUrl });
}

async function main() {
  var adminUrl = process.env.TEST_DATABASE_URL
    || ('postgresql://' + (process.env.DB_USER || 'postgres') + ':' + (process.env.DB_PASSWORD || 'secretpassword') + '@' + (process.env.DB_HOST || '127.0.0.1') + ':' + (process.env.DB_PORT || 5432) + '/postgres');

  adminPool = new Pool({ connectionString: adminUrl });

  const { initializeDatabase } = require('../dist/db/schema_v3');

  try {
    // =========================================================================
    // Scenario A — Fresh Database
    // =========================================================================
    console.log('\n--- Scenario A: Fresh Database Bootstrap ---');
    await setupFreshDb();

    await initializeDatabase(testPool);
    const markerA = await testPool.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'b4b_historical_audit_backfill'"
    );
    assert(markerA.rowCount === 1, 'A1. Fresh DB creates b4b_historical_audit_backfill migration marker');

    const auditCountA = await testPool.query('SELECT COUNT(*)::int AS cnt FROM audit_logs');
    assert(auditCountA.rows[0].cnt === 0, 'A2. Fresh DB has 0 audit logs');

    // Second bootstrap
    let errA2 = null;
    try {
      await initializeDatabase(testPool);
    } catch (e) {
      errA2 = e;
    }
    assert(errA2 === null, 'A3. Second initializeDatabase() on fresh DB succeeds idempotently');

    // =========================================================================
    // Scenario B — Pre-B4B Legacy Database Upgrade
    // =========================================================================
    console.log('\n--- Scenario B: Pre-B4B Legacy Database Upgrade ---');
    await setupFreshDb();

    // 1. Initialize full schema first so standard tables and triggers exist
    await initializeDatabase(testPool);

    // 2. Strip B4B audit structures to simulate an older pre-B4B database state
    await testPool.query(`
      ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS fk_audit_logs_property;
      DROP INDEX IF EXISTS idx_audit_logs_property_entity_record;
      DROP INDEX IF EXISTS idx_audit_logs_property_timestamp;
      ALTER TABLE audit_logs DROP COLUMN IF EXISTS property_id;
      DELETE FROM schema_migrations WHERE version = 'b4b_historical_audit_backfill';
    `);

    // 3. Insert Property 1 and a Booking/Reservation hierarchy
    const propRes = await testPool.query("INSERT INTO properties (property_code, name) VALUES ('LWG', 'OAK Lawang') RETURNING id");
    const propId = propRes.rows[0].id;

    const bRes = await testPool.query(`
      INSERT INTO bookings (bid, property_id, guest_name_snapshot)
      VALUES ('BID-LEGACY-10', $1, 'Legacy Guest')
      RETURNING id
    `, [propId]);
    const bookingId = bRes.rows[0].id;

    const rRes = await testPool.query(`
      INSERT INTO reservations (booking_id, stay_sequence, guest_name, status)
      VALUES ($1, 1, 'Legacy Guest', 'BOOKED')
      RETURNING id
    `, [bookingId]);
    const resId = rRes.rows[0].id;

    // 4. Insert historical audit records into pre-B4B audit_logs (without property_id column)
    await testPool.query(`
      INSERT INTO audit_logs (audit_id, module, action, entity, record_id, new_value)
      VALUES (1, 'PMS', 'CREATE', 'RESERVATION', $1, $2)
    `, [String(resId), JSON.stringify({ reservation_id: resId })]);

    await testPool.query(`
      INSERT INTO audit_logs (audit_id, module, action, entity, record_id, new_value)
      VALUES (2, 'PMS', 'CUSTOM_ACTION', 'CUSTOM_ENTITY', '9999', $1)
    `, [JSON.stringify({ info: 'legacy payload', property_id: propId })]);

    await testPool.query(`
      INSERT INTO audit_logs (audit_id, module, action, entity, record_id, new_value)
      VALUES (3, 'PMS', 'PURGE_RESERVATION', 'RESERVATION', '7777', $1)
    `, [JSON.stringify({ purged: true })]);

    // Run initializeDatabase() on pre-B4B legacy DB
    await initializeDatabase(testPool);

    const migratedAudits = await testPool.query('SELECT audit_id, property_id FROM audit_logs ORDER BY audit_id');
    assert(migratedAudits.rows.find(r => r.audit_id === 1).property_id === propId, 'B1. Relational match successfully attributed to property 1');
    assert(migratedAudits.rows.find(r => r.audit_id === 2).property_id === propId, 'B2. Payload match successfully attributed to property 1');
    assert(migratedAudits.rows.find(r => r.audit_id === 3).property_id === null, 'B3. Ambiguous legacy row remains NULL (no blanket property 1)');

    const markerB = await testPool.query("SELECT 1 FROM schema_migrations WHERE version = 'b4b_historical_audit_backfill'");
    assert(markerB.rowCount === 1, 'B4. Migration marker recorded in schema_migrations');

    // Run second initializeDatabase()
    await initializeDatabase(testPool);
    const postSecondBootAudits = await testPool.query('SELECT audit_id, property_id FROM audit_logs ORDER BY audit_id');
    assert(postSecondBootAudits.rows.find(r => r.audit_id === 3).property_id === null, 'B5. Second boot does NOT reinterpret NULL rows');

    // =========================================================================
    // Scenario C — Already-Migrated B4B Database Without Marker (Adoption/Sealing)
    // =========================================================================
    console.log('\n--- Scenario C: Already-Migrated B4B Database Adoption ---');
    await setupFreshDb();

    // Setup full schema without marker, but with property_id column, FK, and indexes
    await initializeDatabase(testPool);
    // Delete marker to simulate already-migrated database prior to marker introduction
    await testPool.query("DELETE FROM schema_migrations WHERE version = 'b4b_historical_audit_backfill'");

    // Insert an intentionally ambiguous NULL legacy audit row
    await testPool.query(`
      INSERT INTO audit_logs (audit_id, module, action, entity, record_id, new_value, property_id)
      VALUES (500, 'PMS', 'LEGACY_NULL', 'RESERVATION', '9999', '{"unassigned":true}', NULL);
    `);

    // Run initializeDatabase() — should ADOPT and SEAL without re-running backfill
    await initializeDatabase(testPool);

    const markerC = await testPool.query("SELECT 1 FROM schema_migrations WHERE version = 'b4b_historical_audit_backfill'");
    assert(markerC.rowCount === 1, 'C1. Migration marker sealed in schema_migrations upon adoption');

    const audit500 = await testPool.query('SELECT property_id FROM audit_logs WHERE audit_id = 500');
    assert(audit500.rows[0].property_id === null, 'C2. Existing ambiguous NULL row remains strictly NULL (no backfill re-run)');

    // =========================================================================
    // Scenario D — Future Collision Protection
    // =========================================================================
    console.log('\n--- Scenario D: Numeric ID Collision Protection ---');
    // An unresolved historical audit log references reservation record_id '888'
    await testPool.query(`
      INSERT INTO audit_logs (audit_id, module, action, entity, record_id, new_value, property_id)
      VALUES (600, 'PMS', 'LEGACY_PURGE', 'RESERVATION', '888', '{"purged":true}', NULL);
    `);

    // In the future, a new booking and reservation happen to receive ID 888 under property 1
    const prop1 = await testPool.query("SELECT id FROM properties LIMIT 1");
    let testPropId = prop1.rows[0] ? prop1.rows[0].id : null;
    if (!testPropId) {
      const pRes = await testPool.query("INSERT INTO properties (property_code, name) VALUES ('LWG', 'OAK Lawang') RETURNING id");
      testPropId = pRes.rows[0].id;
    }

    const collisionBooking = await testPool.query(`
      INSERT INTO bookings (bid, property_id, guest_name_snapshot)
      VALUES ('BID-COLLISION-TEST', $1, 'New Guest')
      RETURNING id
    `, [testPropId]);

    await testPool.query(`
      INSERT INTO reservations (id, booking_id, stay_sequence, guest_name, status)
      VALUES (888, $1, 1, 'New Guest', 'BOOKED')
      ON CONFLICT (id) DO NOTHING;
    `, [collisionBooking.rows[0].id]);

    // Restart server / run initializeDatabase()
    await initializeDatabase(testPool);

    const audit600 = await testPool.query('SELECT property_id FROM audit_logs WHERE audit_id = 600');
    assert(
      audit600.rows[0].property_id === null,
      'D1. Historical NULL audit row 600 remains NULL despite new reservation 888 existing (sealing verified)'
    );

  } finally {
    if (testPool) {
      await testPool.end();
    }
    await adminPool.query('DROP DATABASE IF EXISTS ' + DISPOSABLE_DB);
    await adminPool.end();
    console.log('\nDisposable test database cleaned up.');
  }

  console.log('\nAudit Migration Sealing Test Summary: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(function(err) {
  console.error('Audit Migration Sealing Test Error:', err);
  process.exitCode = 1;
});
