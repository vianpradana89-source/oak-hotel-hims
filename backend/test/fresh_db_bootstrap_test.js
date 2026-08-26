#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');

const DISPOSABLE_DB = 'oak_fresh_bootstrap_test';

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

async function tableExists(schema, tableName) {
  const r = await testPool.query(
    'SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2',
    [schema, tableName]
  );
  return r.rowCount > 0;
}

async function columnExists(tableName, columnName) {
  const r = await testPool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2",
    [tableName, columnName]
  );
  return r.rowCount > 0;
}

async function columnIsNotNull(tableName, columnName) {
  const r = await testPool.query(
    "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2",
    [tableName, columnName]
  );
  return r.rows[0] && r.rows[0].is_nullable === 'NO';
}

async function countRows(tableName) {
  const r = await testPool.query('SELECT COUNT(*)::int AS cnt FROM ' + tableName);
  return r.rows[0].cnt;
}

async function main() {
  var adminUrl = process.env.TEST_DATABASE_URL
    || ('postgresql://' + (process.env.DB_USER || 'postgres') + ':' + (process.env.DB_PASSWORD || 'secretpassword') + '@' + (process.env.DB_HOST || '127.0.0.1') + ':' + (process.env.DB_PORT || 5432) + '/postgres');

  adminPool = new Pool({ connectionString: adminUrl });

  await adminPool.query('DROP DATABASE IF EXISTS ' + DISPOSABLE_DB);
  await adminPool.query('CREATE DATABASE ' + DISPOSABLE_DB);
  console.log('Created disposable database: ' + DISPOSABLE_DB);

  var testUrl = adminUrl.replace(/\/[^\/]*$/, '/' + DISPOSABLE_DB);
  testPool = new Pool({ connectionString: testUrl });

  try {
    var initialTables = await testPool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    assert(initialTables.rowCount === 0, 'A. database initially empty');

    var schemaV3 = require('../dist/db/schema_v3');
    var initializeDatabase = schemaV3.initializeDatabase;
    var bootError = null;
    try {
      await initializeDatabase(testPool);
    } catch (e) {
      bootError = e;
    }
    assert(bootError === null, 'B. initializeDatabase() completes successfully' + (bootError ? ': ' + bootError.message : ''));

    if (bootError) {
      console.log('Cannot continue after boot failure. Aborting.');
      return;
    }

    var requiredTables = [
      'properties', 'rooms', 'reservations', 'audit_logs',
      'availability_dates', 'availability_locks',
      'room_types', 'room_categories',
      'bookings',
      'idempotency_keys', 'payment_transactions', 'folio_entries',
      'housekeeping_tasks', 'maintenance_tasks',
      'pos_menu_categories', 'pos_menu_items', 'pos_orders', 'pos_order_items',
      'accounting_gl_accounts', 'accounting_journal_entries', 'accounting_journal_lines',
      'vendor_payables', 'guest_receivables', 'guest_profiles', 'guest_profile_history',
      'hr_employees', 'payroll_records'
    ];
    var allTablesExist = true;
    for (var i = 0; i < requiredTables.length; i++) {
      if (!(await tableExists('public', requiredTables[i]))) {
        allTablesExist = false;
        console.log('  MISSING TABLE: ' + requiredTables[i]);
      }
    }
    assert(allTablesExist, 'C. all required foundation tables exist');

    assert(await tableExists('public', 'properties'), 'D. properties table exists');
    assert(await tableExists('public', 'bookings'), 'E. bookings table exists');
    assert(await columnExists('reservations', 'booking_id'), 'F. reservations has booking_id column');
    assert(await columnExists('reservations', 'stay_sequence'), 'G. reservations has stay_sequence column');

    var adNotNull = await columnIsNotNull('availability_dates', 'room_type_id');
    assert(adNotNull, 'H. availability_dates.room_type_id is NOT NULL');

    var alNotNull = await columnIsNotNull('availability_locks', 'room_type_id');
    assert(alNotNull, 'I. availability_locks.room_type_id is NOT NULL');

    assert(await countRows('properties') === 0, 'J. zero properties is valid');
    assert(await countRows('rooms') === 0, 'K. zero rooms is valid');
    assert(await countRows('room_types') === 0, 'L. zero room_types is valid');
    assert(await countRows('availability_dates') === 0, 'M. zero availability_dates is valid');

    var secondBootError = null;
    try {
      await initializeDatabase(testPool);
    } catch (e) {
      secondBootError = e;
    }
    assert(secondBootError === null, 'N. second initializeDatabase() succeeds' + (secondBootError ? ': ' + secondBootError.message : ''));

    var residueCounts = [
      await countRows('properties'),
      await countRows('rooms'),
      await countRows('room_types'),
      await countRows('room_categories'),
      await countRows('reservations'),
      await countRows('bookings'),
      await countRows('availability_dates'),
      await countRows('availability_locks')
    ];
    var hasNoResidue = residueCounts.every(function(c) { return c === 0; });
    assert(hasNoResidue, 'O. no fixture residue (all counts=0)');

  } finally {
    await testPool.end();
    await adminPool.query('DROP DATABASE IF EXISTS ' + DISPOSABLE_DB);
    await adminPool.end();
    console.log('\nDisposable database cleaned up.');
  }

  console.log('\nFresh DB bootstrap: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(function(err) {
  console.error('Fresh DB bootstrap test failed:', err.message);
  process.exitCode = 1;
});
