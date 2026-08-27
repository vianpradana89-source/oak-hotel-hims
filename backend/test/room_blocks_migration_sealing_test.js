#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');

const DISPOSABLE_DB = 'oak_room_blocks_migration_test';

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
    // Scenario A & D — Fresh Database Bootstrap
    // =========================================================================
    console.log('\n--- Scenario A & D: Fresh Database Bootstrap ---');
    await setupFreshDb();

    await initializeDatabase(testPool);

    const markerCheck = await testPool.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'b4c2_1_room_operational_blocks'"
    );
    assert(markerCheck.rowCount === 1, 'D1. Fresh DB creates b4c2_1_room_operational_blocks migration marker');

    const tableCheck = await testPool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'room_operational_blocks'"
    );
    assert(tableCheck.rowCount === 1, 'D2. Fresh DB creates room_operational_blocks table');

    const blockCountA = await testPool.query('SELECT COUNT(*)::int AS cnt FROM room_operational_blocks');
    assert(blockCountA.rows[0].cnt === 0, 'D3. Fresh DB is data-neutral (zero seeded room operational blocks)');

    // =========================================================================
    // Scenario B — Migration Rerun / Restart Idempotency
    // =========================================================================
    console.log('\n--- Scenario B: Migration Rerun & Restart Idempotency ---');
    let errB = null;
    try {
      await initializeDatabase(testPool);
    } catch (e) {
      errB = e;
    }
    assert(errB === null, 'B1. Second initializeDatabase() completes idempotently without error');

    // =========================================================================
    // Scenario C — Existing Block Rows Survive Restart
    // =========================================================================
    console.log('\n--- Scenario C: Existing Block Rows Survive Restart ---');
    // 1. Create property, room type, and room
    const propRes = await testPool.query(
      "INSERT INTO properties (property_code, name) VALUES ('MIG', 'Migration Property') RETURNING id"
    );
    const propId = propRes.rows[0].id;

    const rtRes = await testPool.query(
      "INSERT INTO room_types (property_id, code, name, base_rate, capacity) VALUES ($1, 'DLX', 'Deluxe', 500000, 2) RETURNING id",
      [propId]
    );
    const rtId = rtRes.rows[0].id;

    const rRes = await testPool.query(
      "INSERT INTO rooms (property_id, room_number, name, room_type_id, status) VALUES ($1, '901', 'Deluxe', $2, 'VACANT_CLEAN') RETURNING id",
      [propId, rtId]
    );
    const rId = rRes.rows[0].id;

    // 2. Insert operational block row
    await testPool.query(
      `INSERT INTO room_operational_blocks (
         property_id, room_id, room_type_id, block_type, start_date, end_date, reason, status
       ) VALUES ($1, $2, $3, 'OUT_OF_ORDER', '2026-09-01', '2026-09-05', 'Pre-existing block', 'ACTIVE')`,
      [propId, rId, rtId]
    );

    const countBefore = await testPool.query('SELECT COUNT(*)::int AS cnt FROM room_operational_blocks');
    assert(countBefore.rows[0].cnt === 1, 'C1. Block row successfully inserted before restart');

    // 3. Re-run initializeDatabase (simulating application restart)
    await initializeDatabase(testPool);

    const countAfter = await testPool.query('SELECT COUNT(*)::int AS cnt FROM room_operational_blocks');
    assert(countAfter.rows[0].cnt === 1, 'C2. Existing block rows survive initializeDatabase restart unchanged');

    const blockRow = await testPool.query('SELECT * FROM room_operational_blocks WHERE property_id = $1', [propId]);
    assert(blockRow.rows[0].reason === 'Pre-existing block', 'C3. Block row content is perfectly preserved');

    // =========================================================================
    // Scenario E — Pre-B4C2 Database Migration Simulation
    // =========================================================================
    console.log('\n--- Scenario E: Pre-B4C2 Legacy Database Migration ---');
    await setupFreshDb();
    // Initialize full schema first
    await initializeDatabase(testPool);

    // Drop room_operational_blocks table and migration marker to simulate pre-B4C2 state
    await testPool.query(`
      DROP TABLE IF EXISTS room_operational_blocks CASCADE;
      DELETE FROM schema_migrations WHERE version = 'b4c2_1_room_operational_blocks';
    `);

    const preCheck = await testPool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'room_operational_blocks'"
    );
    assert(preCheck.rowCount === 0, 'E1. Pre-B4C2 state verified (table absent)');

    // Run migration via initializeDatabase
    await initializeDatabase(testPool);

    const postCheck = await testPool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'room_operational_blocks'"
    );
    assert(postCheck.rowCount === 1, 'E2. Migration safely created room_operational_blocks on existing DB');

    const markerPostCheck = await testPool.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'b4c2_1_room_operational_blocks'"
    );
    assert(markerPostCheck.rowCount === 1, 'E3. Migration marker recorded after upgrade');

  } finally {
    if (testPool) {
      await testPool.end();
    }
    if (adminPool) {
      await adminPool.query('DROP DATABASE IF EXISTS ' + DISPOSABLE_DB);
      await adminPool.end();
    }
  }

  console.log(`\nRoom Blocks Migration Sealing: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal migration test error:', err);
  process.exit(1);
});
