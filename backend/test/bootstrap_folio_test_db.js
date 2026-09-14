const { Pool } = require('pg');

async function bootstrapTestDatabase(dbName) {
  const adminPool = new Pool({
    host: '127.0.0.1',
    port: 5432,
    user: 'postgres',
    password: 'secretpassword',
    database: 'postgres'
  });

  try {
    const check = await adminPool.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (check.rowCount === 0) {
      await adminPool.query(`CREATE DATABASE "${dbName}"`);
      console.log(`Created database: ${dbName}`);
    } else {
      console.log(`Database already exists: ${dbName}`);
    }
  } finally {
    await adminPool.end();
  }

  const testPool = new Pool({
    host: '127.0.0.1',
    port: 5432,
    user: 'postgres',
    password: 'secretpassword',
    database: dbName
  });

  try {
    const { initializeDatabase } = require('../dist/db/schema_v3');
    await initializeDatabase(testPool);
    console.log(`Schema initialized for ${dbName}`);

    // Fresh DB - no conflicts possible, insert directly
    await testPool.query(
      'INSERT INTO properties (id, name, property_code, address, created_at) VALUES (9999, $1, $2, $3, NOW())',
      ['Test Property', 'TST001', 'Test Address']
    );

    await testPool.query(
      'INSERT INTO roles (id, name, is_system_role, property_id, is_active) VALUES (1, $1, TRUE, NULL, TRUE)',
      ['Super Admin']
    );

    await testPool.query(
      'INSERT INTO users (id, username, full_name, email, role_id, property_id, account_status, access_type, created_at) VALUES (1, $1, $2, $3, 1, 9999, $4, $5, NOW())',
      ['test_sa', 'Test Super Admin', 'test@oak.local', 'ACTIVE', 'PLATFORM_ADMIN']
    );

    await testPool.query(
      'INSERT INTO room_types (id, property_id, name, code, description, max_adults, max_children, bed_type, is_active, display_order, created_at) VALUES (9001, 9999, $1, $2, $3, 2, 0, $4, TRUE, 1, NOW())',
      ['Test Room Type', 'TRT01', 'Test room for checkout folio gate', 'KING']
    );

    for (let i = 1; i <= 20; i++) {
      await testPool.query(
        'INSERT INTO rooms (id, property_id, room_type_id, room_number, floor, status, is_active) VALUES ($1, 9999, 9001, $2, $3, $4, $5)',
        [9000 + i, `TR${i.toString().padStart(2, '0')}`, '1', 'VACANT', true]
      );
    }

    const testDate = '2030-09-01';
    const nextDate = '2030-09-02';
    await testPool.query(
      'INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty) VALUES (9001, $1, $2, 20, 0), (9001, $1, $3, 20, 0)',
      ['TRT01', testDate, nextDate]
    );

    console.log('Rooms and availability created');
  } finally {
    await testPool.end();
  }
}

const dbName = process.argv[2] || 'oak_checkout_folio_gate_test';
bootstrapTestDatabase(dbName).catch(err => {
  console.error('Bootstrap failed:', err.message);
  process.exit(1);
});
