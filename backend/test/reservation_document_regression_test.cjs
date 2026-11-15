'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const localEnvPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(localEnvPath)) {
  require('dotenv').config({ path: localEnvPath });
}

// GF-F04: Explicit authorized isolated test database whitelist
const AUTHORIZED_TEST_DATABASES = new Set([
  'oak_checkout_folio_gate_test',
  'oak_hotel_test',
]);

function isAuthorizedTestDatabase(dbName) {
  if (!dbName || typeof dbName !== 'string') return false;
  const normalized = dbName.trim().toLowerCase();
  if (/^(oak_hotel_db|postgres|template\d*|synthetic_unapproved_customer_test)$/i.test(normalized)) {
    return false;
  }
  if (AUTHORIZED_TEST_DATABASES.has(normalized)) {
    return true;
  }
  if (/^oak_test_[a-z0-9_]+$/i.test(normalized)) {
    return true;
  }
  return false;
}

function assertTestDatabaseTarget(dbName, srvPort) {
  const isAuthorized = isAuthorizedTestDatabase(dbName);
  if (!isAuthorized) {
    throw new Error(`Target database mismatch! "${dbName}" is not an authorized isolated test database.`);
  }
  const protectedPorts = [44187, 44185, 55451, 55449];
  if (srvPort && protectedPorts.includes(Number(srvPort))) {
    throw new Error(`Target DB is connected to protected UAT port ${srvPort}! Refusing execution.`);
  }
  return true;
}

function resolveAndValidateTestDatabaseTarget(env = process.env, srvPort = null) {
  const testDb = env && env.TEST_DB_NAME ? String(env.TEST_DB_NAME).trim() : '';
  const appDb = env && env.DB_NAME ? String(env.DB_NAME).trim() : '';

  if (testDb && appDb && testDb !== appDb) {
    throw new Error(`Target database conflict! TEST_DB_NAME="${testDb}" and DB_NAME="${appDb}" mismatch. Refusing execution.`);
  }

  const effectiveDb = testDb || appDb;
  if (!effectiveDb) {
    throw new Error('Target database is empty! Please explicitly specify DB_NAME or TEST_DB_NAME as an authorized isolated test database.');
  }

  assertTestDatabaseTarget(effectiveDb, srvPort);

  if (env) {
    env.DB_NAME = effectiveDb;
    env.TEST_DB_NAME = effectiveDb;
  }
  return effectiveDb;
}

function runStandalonePreflightCheck(targetDbName, srvPort) {
  if (targetDbName) {
    assertTestDatabaseTarget(targetDbName, srvPort);
    if (process.env) {
      process.env.DB_NAME = targetDbName;
      process.env.TEST_DB_NAME = targetDbName;
    }
    return targetDbName;
  }
  return resolveAndValidateTestDatabaseTarget(process.env, srvPort);
}

let pool;
let app;
let generateToken;

const TEST_PORT = 3295;
const RUN_ID = `DOCREG_${Date.now()}`;

let passed = 0;
let failed = 0;

function expect(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  [PASS] ${message}`);
  } else {
    failed += 1;
    console.error(`  [FAIL] ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

function addDays(dateStr, days) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

async function findFreeDateWindow(poolInstance, roomRows, nights, minStartDate = '2026-08-01') {
  const roomIds = roomRows.map((r) => Number(r.room_id));
  const roomTypeIds = Array.from(new Set(roomRows.map((r) => Number(r.room_type_id))));
  const availDatesRes = await poolInstance.query(
    `SELECT date::text AS d
     FROM availability_dates
     WHERE room_type_id = ANY($1::int[])
       AND date >= $2::date
       AND (total_rooms - reserved_qty) >= 1
     GROUP BY date
     HAVING COUNT(DISTINCT room_type_id) = $3
     ORDER BY date ASC`,
    [roomTypeIds, minStartDate, roomTypeIds.length]
  );
  const validSet = new Set(availDatesRes.rows.map((r) => String(r.d).slice(0, 10)));
  for (const row of availDatesRes.rows) {
    const startStr = String(row.d).slice(0, 10);
    let allDatesAvailable = true;
    for (let i = 0; i < nights; i += 1) {
      if (!validSet.has(addDays(startStr, i))) {
        allDatesAvailable = false;
        break;
      }
    }
    if (!allDatesAvailable) continue;
    const endStr = addDays(startStr, nights);
    const overlapRes = await poolInstance.query(
      `SELECT 1 FROM reservations
       WHERE room_id = ANY($1::int[])
         AND status IN ('BOOKED', 'CHECKED_IN')
         AND check_in < $3::date
         AND check_out > $2::date
       LIMIT 1`,
      [roomIds, startStr, endStr]
    );
    if (overlapRes.rowCount === 0) {
      return { checkIn: startStr, checkOut: endStr };
    }
  }
  throw new Error(`No free ${nights}-night window found in availability_dates after ${minStartDate}`);
}

function makeRequest(method, urlPath, body = null, token = null) {
  return new Promise((resolve, reject) => {
    let payload = null;
    const headers = {};

    if (body) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: urlPath,
        method,
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode,
              body: raw ? JSON.parse(raw) : {},
            });
          } catch {
            resolve({
              status: res.statusCode,
              body: raw,
            });
          }
        });
      }
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runRegressionSuite() {
  console.log('==================================================================');
  console.log('  OAK HIMS — RESERVATION DOCUMENT (CONFIRMATION & QUOTATION) REGRESSION');
  console.log('==================================================================\n');

  let server;
  let isPreflightVerified = false;
  const createdBookingIds = new Set();
  const createdReservationIds = new Set();
  const createdGuestIds = new Set();
  let propId = 1;

  async function trackReservation(bookingId, reservationId, guestIds = null) {
    if (bookingId) createdBookingIds.add(Number(bookingId));
    if (reservationId) createdReservationIds.add(Number(reservationId));
    if (guestIds) {
      if (Array.isArray(guestIds)) {
        for (const gid of guestIds) {
          if (gid) createdGuestIds.add(Number(gid));
        }
      } else {
        createdGuestIds.add(Number(guestIds));
      }
    }
    if (pool && reservationId) {
      try {
        const rgRes = await pool.query(
          `SELECT rg.guest_id FROM reservation_guests rg
           JOIN guests g ON g.id = rg.guest_id
           WHERE rg.reservation_id = $1 AND g.full_name LIKE $2`,
          [reservationId, `${RUN_ID}%`]
        );
        for (const r of rgRes.rows) {
          if (r.guest_id) createdGuestIds.add(Number(r.guest_id));
        }
      } catch (_e) {}
    }
  }

  try {
    const resolvedDb = resolveAndValidateTestDatabaseTarget(process.env);

    if (!pool) {
      bootstrapModules();
    }

    // GF-F04: Explicit test database validation after pool initialization
    const dbTargetRes = await pool.query(
      `SELECT current_database() as db_name, inet_server_port() as srv_port, current_user as db_user`
    );
    const { db_name, srv_port, db_user } = dbTargetRes.rows[0];
    const isAuthorizedTestDb = isAuthorizedTestDatabase(db_name);
    if (!isAuthorizedTestDb) {
      throw new Error(`Target database mismatch! "${db_name}" is not an authorized isolated test database.`);
    }
    if (db_name !== resolvedDb) {
      throw new Error(`Target database mismatch! Expected ${resolvedDb}, got ${db_name}`);
    }
    const protectedPorts = [44187, 44185, 55451, 55449];
    if (srv_port && protectedPorts.includes(Number(srv_port))) {
      throw new Error(`Target DB is connected to protected UAT port ${srv_port}! Refusing execution.`);
    }
    console.log(`[DB_TARGET_VERIFIED] Connected to ${db_name} as ${db_user} (port ${srv_port || 'local'}), zero protected port collision.`);
    isPreflightVerified = true;

    await new Promise((resolve) => {
      server = app.listen(TEST_PORT, () => {
        console.log(`[SETUP] Doc Regression server listening on 127.0.0.1:${TEST_PORT}`);
        resolve();
      });
    });

    // Dynamically pick property with active room
    const propRes = await pool.query(`
      SELECT p.id, p.name
      FROM properties p
      JOIN rooms r ON r.property_id = p.id
      JOIN room_types rt ON rt.id = r.room_type_id
      WHERE COALESCE(r.is_active, TRUE) = TRUE
        AND COALESCE(r.status, 'VACANT_CLEAN') NOT IN ('OUT_OF_ORDER', 'OUT_OF_SERVICE')
      GROUP BY p.id, p.name
      HAVING count(r.id) >= 1
      ORDER BY p.id ASC
      LIMIT 1
    `);
    expect(propRes.rows.length > 0, 'At least one property with active room exists for doc regression');
    propId = Number(propRes.rows[0].id);

    // Super Admin User & Token
    const saRes = await pool.query(`
      SELECT u.id, u.username, u.full_name, u.email, r.id AS role_id, r.name AS role
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE r.name = 'Super Admin' AND r.property_id IS NULL AND r.is_system_role = TRUE
      LIMIT 1
    `);
    const saUser = saRes.rows[0];
    const saToken = generateToken({
      id: Number(saUser.id),
      email: saUser.email || 'sa@oak.test',
      username: saUser.username,
      full_name: saUser.full_name || 'Super Admin OAK',
      role: saUser.role,
      role_id: Number(saUser.role_id),
      property_id: propId,
      scope: 'FULL',
      access_type: 'SUPER_ADMIN',
    });

    // Pick 1 room & room type
    const roomRes = await pool.query(
      `SELECT r.id AS room_id, r.room_number, r.room_type_id, rt.name AS room_type_name
       FROM rooms r
       JOIN room_types rt ON rt.id = r.room_type_id
       WHERE r.property_id = $1
         AND COALESCE(r.is_active, TRUE) = TRUE
         AND COALESCE(r.status, 'VACANT_CLEAN') NOT IN ('OUT_OF_ORDER', 'OUT_OF_SERVICE')
       ORDER BY r.id ASC
       LIMIT 1`,
      [propId]
    );
    expect(roomRes.rows.length >= 1, 'At least 1 active room available for fixture');
    const room1 = roomRes.rows[0];

    // Find free date window
    const { checkIn, checkOut } = await findFreeDateWindow(pool, [room1], 2, '2026-11-20');

    const bookRes = await makeRequest(
      'POST',
      '/api/bookings',
      {
        property_id: propId,
        booking_channel: 'DIRECT',
        booking_source: 'DIRECT_OFFLINE',
        booker_name: `${RUN_ID} Booker Regression`,
        booker_phone: '081299998888',
        guest_name: `${RUN_ID} Tamu Konfirmasi`,
        guest_phone: '081299998888',
        identity_number: '3507010101900099',
        has_valid_identity: true,
        reservations: [
          {
            room_type_id: Number(room1.room_type_id),
            room_id: String(room1.room_id),
            check_in: checkIn,
            check_out: checkOut,
            total_price: 1200000,
            subtotal_amount: 1200000,
            room_rate: 600000,
            rate_breakdown: [
              { date: checkIn, rate: 600000 },
              { date: addDays(checkIn, 1), rate: 600000 },
            ],
          },
        ],
      },
      saToken
    );

    expect(bookRes.status === 201, 'Booking fixture created via POST /api/bookings');
    const bookingId = Number(bookRes.body.data.id || bookRes.body.data.booking_id);
    const reservation = bookRes.body.data.reservations?.[0];
    const resId = Number(reservation.id);
    const guestIds = bookRes.body?.data?.created_guest_ids || (bookRes.body?.data?.guest_id ? [bookRes.body?.data?.guest_id] : []);
    await trackReservation(bookingId, resId, guestIds);

    // ─────────────────────────────────────────────────────────────────
    // Test 1: GET /api/documents/reservations (Picker list)
    // ─────────────────────────────────────────────────────────────────
    console.log('\n--- Test 1: GET /api/documents/reservations (Picker List) ---');
    const listRes = await makeRequest(
      'GET',
      `/api/documents/reservations?property_id=${propId}&search=${encodeURIComponent(RUN_ID)}`,
      null,
      saToken
    );
    expect(listRes.status === 200, 'Picker list returns 200 OK');
    expect(Array.isArray(listRes.body.data), 'Picker list returns array data');
    const found = listRes.body.data.find((item) => Number(item.id) === resId);
    expect(Boolean(found), 'Picker list finds newly created reservation by search query');
    expect(found.guest_name.includes(RUN_ID), 'Picker list includes guest_name');
    expect(found.room_type_name === room1.room_type_name, 'Picker list includes room_type_name');
    expect(
      !found.ktp_path && !found.bukti_bayar_path && !found.identity_number,
      'Picker list omits sensitive/PII columns'
    );

    // ─────────────────────────────────────────────────────────────────
    // Test 2: GET /api/documents/reservations/:id (Detail Projection)
    // ─────────────────────────────────────────────────────────────────
    console.log('\n--- Test 2: GET /api/documents/reservations/:id (Detail Projection) ---');
    const detailRes = await makeRequest(
      'GET',
      `/api/documents/reservations/${resId}?property_id=${propId}`,
      null,
      saToken
    );
    expect(detailRes.status === 200, 'Detail projection returns 200 OK');
    const data = detailRes.body.data;
    expect(Boolean(data), 'Detail projection returns data object');

    // Contract structure verification for Reservation Confirmation / Quotation
    expect(Number(data.id) === resId, 'Reservation ID matches');
    expect(data.bid && data.bid.length > 0, 'Reservation bid (booking code) present');
    expect(data.guest_name.includes(RUN_ID), 'Guest name matches');
    expect(data.guest_phone === '081299998888', 'Guest phone matches');
    expect(data.check_in.slice(0, 10) === checkIn, 'Check-in date matches');
    expect(data.check_out.slice(0, 10) === checkOut, 'Check-out date matches');
    expect(data.room_type_name === room1.room_type_name, 'Room type name matches');
    console.log('detail data financials:', {
      total_price: data.total_price,
      amount_paid: data.amount_paid,
      remaining_balance: data.remaining_balance,
      payment_status: data.payment_status,
    });
    expect(Number(data.total_price) > 0, 'Total price is greater than 0');
    expect(Number(data.remaining_balance) === Number(data.total_price), 'Remaining balance matches total price');
    expect(data.payment_status === 'UNPAID', 'Initial payment status is UNPAID');
    expect(data.applied_deposit !== undefined, 'applied_deposit column is present in detail DTO');
    expect(Number(data.applied_deposit || 0) === 0, 'applied_deposit is initially 0');

    // Verify sensitive columns are excluded
    expect(data.ktp_path === undefined, 'ktp_path is excluded');
    expect(data.bukti_bayar_path === undefined, 'bukti_bayar_path is excluded');
    expect(data.identity_number === undefined, 'identity_number is excluded');

    // ─────────────────────────────────────────────────────────────────
    // Test 3: Security & Isolation on GET /api/documents/reservations/:id
    // ─────────────────────────────────────────────────────────────────
    console.log('\n--- Test 3: Security & Cross-Property Isolation ---');
    const unauthRes = await makeRequest('GET', `/api/documents/reservations/${resId}?property_id=${propId}`);
    expect(unauthRes.status === 401, 'Unauthenticated detail request returns 401');

    const crossPropRes = await makeRequest(
      'GET',
      `/api/documents/reservations/${resId}?property_id=99999`,
      null,
      saToken
    );
    expect(crossPropRes.status === 404, 'Cross-property detail request returns 404');

    console.log('\n==================================================================');
    console.log(`  ALL ${passed} REGRESSION ASSERTIONS PASSED (${failed} FAILED)`);
    console.log('==================================================================\n');
  } finally {
    let fixtureCleanupErr = null;

    if (isPreflightVerified) {
      if (createdReservationIds.size > 0 || createdBookingIds.size > 0 || createdGuestIds.size > 0) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const resIds = Array.from(createdReservationIds);
          const bookIds = Array.from(createdBookingIds);

          if (resIds.length > 0) {
            const resRows = await client.query(
              `SELECT id, booked_room_type_id_snapshot, check_in, check_out, status
               FROM reservations WHERE id = ANY($1::int[])`,
              [resIds]
            );
            for (const row of resRows.rows) {
              let cur = new Date(row.check_in);
              const end = new Date(row.check_out);
              while (cur < end) {
                const dStr = cur.toISOString().slice(0, 10);
                await client.query(
                  `UPDATE availability_dates
                   SET reserved_qty = GREATEST(0, reserved_qty - 1)
                   WHERE room_type_id = $1 AND date = $2`,
                  [row.booked_room_type_id_snapshot, dStr]
                );
                cur.setDate(cur.getDate() + 1);
              }
            }
            await client.query(`DELETE FROM transactions WHERE reservation_id = ANY($1::int[])`, [resIds]);
            await client.query(`DELETE FROM payment_allocations WHERE reservation_id = ANY($1::int[])`, [resIds]);
            await client.query(`DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])`, [resIds]);
            await client.query(`DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])`, [resIds]);
            await client.query(`DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1::int[])`, [resIds]);
            await client.query(`DELETE FROM reservation_guests WHERE reservation_id = ANY($1::int[])`, [resIds]);
            await client.query(`DELETE FROM audit_logs WHERE entity = 'RESERVATION' AND record_id = ANY($1::text[])`, [resIds.map(String)]);
            await client.query(`DELETE FROM reservations WHERE id = ANY($1::int[])`, [resIds]);
          }
          if (bookIds.length > 0) {
            await client.query(`DELETE FROM audit_logs WHERE entity = 'BOOKING' AND record_id = ANY($1::text[])`, [bookIds.map(String)]);
            await client.query(`DELETE FROM bookings WHERE id = ANY($1::int[])`, [bookIds]);
          }
          try {
            const runGuests = await client.query(
              `SELECT id FROM guests WHERE full_name LIKE $1`,
              [`${RUN_ID}%`]
            );
            for (const r of runGuests.rows) {
              if (r.id) createdGuestIds.add(Number(r.id));
            }
          } catch (_e) {}

          const gIds = Array.from(createdGuestIds);
          if (gIds.length > 0) {
            await client.query(
              `DELETE FROM guests WHERE id = ANY($1::int[])`,
              [gIds]
            );
          }
          await client.query('COMMIT');
          console.log('[CLEANUP] Reservation document regression fixtures cleaned up with zero residue.');
        } catch (cleanupErr) {
          await client.query('ROLLBACK');
          fixtureCleanupErr = cleanupErr;
          console.error('[CLEANUP ERROR]', cleanupErr);
        } finally {
          client.release();
        }
      }
    }

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (pool) {
      await pool.end();
    }

    if (fixtureCleanupErr) {
      throw fixtureCleanupErr;
    }
  }
}

function bootstrapModules() {
  if (pool) return { pool, app };
  const dist = require('../dist/index');
  pool = dist.pool;
  app = dist.app;
  generateToken = require('../dist/domains/auth/authService').generateToken;
  return { pool, app };
}

runRegressionSuite()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('Doc Regression Failed:', err);
    process.exit(1);
  });
