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

async function columnHasDefault(tableName, columnName) {
  const r = await testPool.query(
    "SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2",
    [tableName, columnName]
  );
  return Boolean(r.rows[0]?.column_default);
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
      'housekeeping_tasks', 'maintenance_tasks', 'room_operational_blocks',
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
    assert(await columnExists('properties', 'currency'), 'D1. properties has canonical currency column');
    assert(await tableExists('public', 'bookings'), 'E. bookings table exists');
    assert(await columnExists('reservations', 'booking_id'), 'F. reservations has booking_id column');
    assert(await columnExists('reservations', 'stay_sequence'), 'G. reservations has stay_sequence column');

    var adNotNull = await columnIsNotNull('availability_dates', 'room_type_id');
    assert(adNotNull, 'H. availability_dates.room_type_id is NOT NULL');

    var alNotNull = await columnIsNotNull('availability_locks', 'room_type_id');
    assert(alNotNull, 'I. availability_locks.room_type_id is NOT NULL');

    var posOrdersPropNotNull = await columnIsNotNull('pos_orders', 'property_id');
    assert(posOrdersPropNotNull, 'J. pos_orders.property_id is NOT NULL');

    var glAccountsPropNotNull = await columnIsNotNull('accounting_gl_accounts', 'property_id');
    assert(glAccountsPropNotNull, 'K. accounting_gl_accounts.property_id is NOT NULL');

    var journalEntriesPropNotNull = await columnIsNotNull('accounting_journal_entries', 'property_id');
    assert(journalEntriesPropNotNull, 'L. accounting_journal_entries.property_id is NOT NULL');

    var vendorPayablesPropNotNull = await columnIsNotNull('vendor_payables', 'property_id');
    assert(vendorPayablesPropNotNull, 'L1. vendor_payables.property_id is NOT NULL');

    var guestReceivablesPropNotNull = await columnIsNotNull('guest_receivables', 'property_id');
    assert(guestReceivablesPropNotNull, 'L2. guest_receivables.property_id is NOT NULL');

    assert(await columnExists('audit_logs', 'property_id'), 'L3. audit_logs has property_id column');

    var auditIndexCheck1 = await testPool.query(
      "SELECT 1 FROM pg_indexes WHERE tablename = 'audit_logs' AND indexname = 'idx_audit_logs_property_entity_record'"
    );
    assert(auditIndexCheck1.rowCount > 0, 'L4. idx_audit_logs_property_entity_record index exists');

    var auditIndexCheck2 = await testPool.query(
      "SELECT 1 FROM pg_indexes WHERE tablename = 'audit_logs' AND indexname = 'idx_audit_logs_property_timestamp'"
    );
    assert(auditIndexCheck2.rowCount > 0, 'L5. idx_audit_logs_property_timestamp index exists');

    assert(await tableExists('public', 'schema_migrations'), 'L6. schema_migrations table exists');
    var markerCheck = await testPool.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'b4b_historical_audit_backfill'"
    );
    assert(markerCheck.rowCount === 1, 'L7. b4b_historical_audit_backfill migration marker exists');
    var markerCheckBlocks = await testPool.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'b4c2_1_room_operational_blocks'"
    );
    assert(markerCheckBlocks.rowCount === 1, 'L8. b4c2_1_room_operational_blocks migration marker exists');

    assert(await countRows('properties') === 0, 'M. zero properties is valid');
    assert(await countRows('rooms') === 0, 'N. zero rooms is valid');
    assert(await countRows('room_types') === 0, 'O. zero room_types is valid');
    assert(await countRows('availability_dates') === 0, 'P. zero availability_dates is valid');
    assert(await countRows('pos_menu_categories') === 0, 'Q. zero pos_menu_categories is valid');
    assert(await countRows('pos_menu_items') === 0, 'R. zero pos_menu_items is valid');
    assert(await countRows('pos_orders') === 0, 'S. zero pos_orders is valid');
    assert(await countRows('pos_order_items') === 0, 'T. zero pos_order_items is valid');
    assert(await countRows('accounting_gl_accounts') === 0, 'U. zero accounting_gl_accounts is valid');
    assert(await countRows('accounting_journal_entries') === 0, 'V. zero accounting_journal_entries is valid');
    assert(await countRows('accounting_journal_lines') === 0, 'W. zero accounting_journal_lines is valid');
    assert(await countRows('vendor_payables') === 0, 'W1. zero vendor_payables is valid');
    assert(await countRows('guest_receivables') === 0, 'W2. zero guest_receivables is valid');
    assert(await countRows('audit_logs') === 0, 'W3. zero audit_logs is valid');
    assert(await countRows('hr_employees') === 0, 'W4. zero hr_employees is valid');
    assert(!(await columnHasDefault('hr_employees', 'property_id')), 'W5. hr_employees.property_id has no implicit default');

    var secondBootError = null;
    try {
      await initializeDatabase(testPool);
    } catch (e) {
      secondBootError = e;
    }
    assert(secondBootError === null, 'X. second initializeDatabase() succeeds' + (secondBootError ? ': ' + secondBootError.message : ''));

    var residueCounts = [
      await countRows('properties'),
      await countRows('rooms'),
      await countRows('room_types'),
      await countRows('room_categories'),
      await countRows('reservations'),
      await countRows('bookings'),
      await countRows('availability_dates'),
      await countRows('availability_locks'),
      await countRows('pos_menu_categories'),
      await countRows('pos_menu_items'),
      await countRows('pos_orders'),
      await countRows('pos_order_items'),
      await countRows('accounting_gl_accounts'),
      await countRows('accounting_journal_entries'),
      await countRows('accounting_journal_lines'),
      await countRows('vendor_payables'),
      await countRows('guest_receivables'),
      await countRows('audit_logs'),
      await countRows('hr_employees')
    ];
    var hasNoResidue = residueCounts.every(function(c) { return c === 0; });
    assert(hasNoResidue, 'Y. no fixture residue (all counts=0)');

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
