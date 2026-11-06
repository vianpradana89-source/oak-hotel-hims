'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

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
let initializeDatabase;
let generateToken;
let receiveDeposit;
let applyDeposit;
let unapplyDeposit;
let getDepositsByReservation;
let recalculateReservationFinancials;
let voidFolioEntry;
let ACCESS_RESOURCES;
let setRoleAccess;
let setFeatureFlag;

async function createStayCharge(dbPool, {
  propertyId,
  reservationId,
  chargeType,
  amount,
  quantity = 1,
  notes,
  actorUserId,
  actorName = 'Kasir FO',
}) {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const totalAmt = Number(amount) * Number(quantity);
    const ins = await client.query(
      `INSERT INTO folio_entries (
        reservation_id, property_id, entry_type, source_type, source_id,
        description, amount, direction, base_amount, unit_price, quantity,
        tax_amount, service_amount, status, notes,
        revenue_category, actor_user_id, actor_name_snapshot, actor_role_snapshot
      ) VALUES (
        $1, $2, $3, $4, '',
        $5, $6, 'DEBIT', $6, $7, $8,
        0, 0, 'POSTED', $9,
        'OTHER_INCOME', $10, $11, 'STAFF'
      ) RETURNING *`,
      [
        reservationId,
        propertyId,
        chargeType,
        chargeType === 'FNB' ? 'POS' : chargeType,
        notes || chargeType,
        totalAmt,
        Number(amount),
        Number(quantity),
        notes || null,
        actorUserId || null,
        actorName,
      ]
    );
    const recalc = await recalculateReservationFinancials(client, reservationId, propertyId);
    await client.query('COMMIT');
    return { entry: ins.rows[0], reservation: recalc.reservation };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function voidStayCharge(dbPool, {
  propertyId,
  reservationId,
  entryId,
  reason,
  actorUserId,
  actorName = 'Kasir FO',
}) {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const res = await voidFolioEntry(client, propertyId, reservationId, entryId, {
      reason,
      actor_user_id: String(actorUserId || ''),
      actor_name: actorName,
      actor_role: 'STAFF',
    });
    await client.query('COMMIT');
    return res;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const TEST_PORT = 3294;
const RUN_ID = `GF_${Date.now()}_${process.pid}`;

let passed = 0;
let failed = 0;
const testResults = [];

function expect(condition, message) {
  if (!condition) {
    failed += 1;
    testResults.push({ status: 'FAIL', message });
    console.error(`  [FAIL] ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  passed += 1;
  testResults.push({ status: 'PASS', message });
  console.log(`  [PASS] ${message}`);
}

function makeRequest(method, urlPath, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const isMultipart = body && body.isMultipart;
    const headers = {};
    let payload = null;

    if (isMultipart) {
      headers['Content-Type'] = `multipart/form-data; boundary=${body.boundary}`;
      payload = body.buffer;
      headers['Content-Length'] = payload.length;
    } else if (body !== null && body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = Buffer.from(JSON.stringify(body), 'utf8');
      headers['Content-Length'] = payload.length;
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

function buildMultipartBody(fields, fileField = null) {
  const boundary = '----OakFolioBoundary' + Math.random().toString(36).slice(2);
  const chunks = [];
  for (const [key, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
      )
    );
  }
  if (fileField) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${fileField.name}"; filename="${fileField.filename}"\r\nContent-Type: ${fileField.contentType || 'image/png'}\r\n\r\n`
      )
    );
    chunks.push(fileField.buffer);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    isMultipart: true,
    boundary,
    buffer: Buffer.concat(chunks),
  };
}

// GF-F01: All PDF printing renders directly from the production React component
// (GuestFolioPrint.tsx) via Vite SSR HTML export (renderProductionComponentHtml).
// No separate/parallel HTML template is maintained.

/**
 * GF-F01: Renders the actual production React component (GuestFolioPrint.tsx)
 * via Vite SSR to static HTML markup with guestDocumentPrint.css for PDF printing.
 */
const SAMPLES_DIR = path.resolve(__dirname, '../../artifacts/guest-folio-samples');

function renderProductionComponentHtml(folioDto, viewMode = 'EFFECTIVE') {
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  const tmpJson = path.join(SAMPLES_DIR, `temp_folio_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  const tmpHtml = path.join(SAMPLES_DIR, `temp_folio_${Date.now()}_${Math.random().toString(36).slice(2)}.html`);
  try {
    fs.writeFileSync(tmpJson, JSON.stringify(folioDto), 'utf8');
    execFileSync(process.execPath, [
      path.join(__dirname, 'render_guest_folio_component.mjs'),
      tmpJson,
      tmpHtml,
      viewMode,
    ]);
    return fs.readFileSync(tmpHtml, 'utf8');
  } finally {
    try { if (fs.existsSync(tmpJson)) fs.unlinkSync(tmpJson); } catch {}
    try { if (fs.existsSync(tmpHtml)) fs.unlinkSync(tmpHtml); } catch {}
  }
}

function renderHtmlToPdfWithChrome(htmlFilePath, pdfOutputPath) {
  const chromeCandidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ];
  const browserBin = chromeCandidates.find((p) => fs.existsSync(p));
  if (!browserBin) {
    throw new Error('No headless Chromium browser (Chrome/Edge) found');
  }
  if (fs.existsSync(pdfOutputPath)) {
    fs.unlinkSync(pdfOutputPath);
  }
  const tmpProfileDir = path.join(path.dirname(pdfOutputPath), '.chrome-pdf-profile');
  fs.mkdirSync(tmpProfileDir, { recursive: true });
  const fileUrl = 'file:///' + htmlFilePath.replace(/\\/g, '/');
  execFileSync(
    browserBin,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--user-data-dir=${tmpProfileDir}`,
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfOutputPath}`,
      fileUrl,
    ],
    { stdio: 'pipe' }
  );
  try {
    fs.rmSync(tmpProfileDir, { recursive: true, force: true });
  } catch {}
}

function countPdfPages(pdfBuffer) {
  const str = pdfBuffer.toString('latin1');
  const matches = str.match(/\/Type\s*\/Page\b/g);
  return matches ? matches.length : 0;
}

function normalizeSyntheticSample(data, { roomNumber, roomTypeName, bid, guestName }) {
  const jsonStr = JSON.stringify(data);
  let s = JSON.parse(jsonStr);
  if (roomNumber) {
    const oldRoom = s.room_number || s.stay?.room_number || 'RM1B-A';
    s.room_number = roomNumber;
    if (s.stay) s.stay.room_number = roomNumber;
    if (s.reservation) s.reservation.room_number = roomNumber;
    if (s.responsibility && s.responsibility.scope_description) {
      s.responsibility.scope_description = s.responsibility.scope_description.replaceAll(oldRoom, roomNumber);
    }
    if (s.scope_description) s.scope_description = s.scope_description.replaceAll(oldRoom, roomNumber);
    if (Array.isArray(s.effective_lines)) {
      for (const line of s.effective_lines) {
        if (line.description) line.description = line.description.replaceAll(oldRoom, roomNumber);
      }
    }
    if (Array.isArray(s.audit_lines)) {
      for (const line of s.audit_lines) {
        if (line.description) line.description = line.description.replaceAll(oldRoom, roomNumber);
      }
    }
  }
  if (roomTypeName) {
    const oldType = s.room_type_name || s.stay?.room_type_name;
    if (s.stay) s.stay.room_type_name = roomTypeName;
    s.room_type_name = roomTypeName;
    if (oldType && Array.isArray(s.effective_lines)) {
      for (const line of s.effective_lines) {
        if (line.description) line.description = line.description.replaceAll(oldType, roomTypeName);
      }
    }
    if (oldType && Array.isArray(s.audit_lines)) {
      for (const line of s.audit_lines) {
        if (line.description) line.description = line.description.replaceAll(oldType, roomTypeName);
      }
    }
  }
  if (bid) {
    const oldBid = s.bid || s.reservation?.bid;
    s.bid = bid;
    if (s.reservation) {
      s.reservation.bid = bid;
      s.reservation.reservation_code = `${bid} / RES-${s.reservation.id || s.reservation_id}`;
    }
    if (s.folio_number && oldBid) s.folio_number = s.folio_number.replaceAll(oldBid, bid);
    if (s.folio_reference && oldBid) s.folio_reference = s.folio_reference.replaceAll(oldBid, bid);
    if (s.reference_value && oldBid) s.reference_value = s.reference_value.replaceAll(oldBid, bid);
    if (oldBid && Array.isArray(s.effective_lines)) {
      for (const line of s.effective_lines) {
        if (line.reference) line.reference = line.reference.replaceAll(oldBid, bid);
      }
    }
    if (oldBid && Array.isArray(s.audit_lines)) {
      for (const line of s.audit_lines) {
        if (line.reference) line.reference = line.reference.replaceAll(oldBid, bid);
      }
    }
  }
  if (guestName) {
    s.guest_name = guestName;
    if (s.guest_identity) {
      s.guest_identity.guest_name = guestName;
      s.guest_identity.primary_guest_name = guestName;
      s.guest_identity.booker_name = guestName;
    }
    s.booker_name = guestName;
  }
  return s;
}

function addDays(dateStr, days) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

async function findFreeDateWindow(pool, roomRows, nights, minStartDate = '2026-08-01') {
  const roomIds = roomRows.map((r) => Number(r.room_id));
  const roomTypeIds = Array.from(new Set(roomRows.map((r) => Number(r.room_type_id))));
  const availDatesRes = await pool.query(
    `SELECT date::text AS d
     FROM availability_dates
     WHERE room_type_id = ANY($1::int[])
       AND date >= $2::date
       AND (total_rooms - reserved_qty) >= 2
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
    const overlapRes = await pool.query(
      `SELECT 1 FROM reservations
       WHERE room_id = ANY($1::int[])
         AND status IN ('BOOKED', 'CHECKED_IN')
         AND check_in < $3::date
         AND check_out > $2::date
       LIMIT 1`,
      [roomIds, startStr, endStr]
    );
    if (overlapRes.rowCount === 0) {
      return { checkIn: startStr, checkOut: endStr, nextMinDate: addDays(endStr, 1) };
    }
  }
  throw new Error(`No free ${nights}-night window found in availability_dates after ${minStartDate}`);
}

async function runE2ETests() {
  console.log('==================================================================');
  console.log('  OAK HIMS — GUEST FOLIO DOCUMENT E2E & INVARIANT TEST SUITE');
  console.log('==================================================================\n');

  let server;
  let isPreflightVerified = false;
  let featureFlagModified = false;
  const createdReservationIds = new Set();
  const createdBookingIds = new Set();
  const createdDepositIds = new Set();
  const createdUserIds = new Set();
  const createdRoleIds = new Set();
  const createdGuestIds = new Set();
  let originalDocFeatureEnabled = true;
  let propId = 1;
  let hadOriginalFlag = false;

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
    isPreflightVerified = true;
    console.log(`[DB_TARGET_VERIFIED] Connected to ${db_name} as ${db_user} (port ${srv_port || 'local'}), zero protected port collision.`);

    // Initialize idempotent schema migrations on verified test DB
    await initializeDatabase(pool);

    await new Promise((resolve) => {
      server = app.listen(TEST_PORT, () => {
        console.log(`[SETUP] Guest Folio E2E server listening on 127.0.0.1:${TEST_PORT}`);
        resolve();
      });
    });

    // Ensure document permissions exist (doc_1b_2b_documents_permission_rows)
    await pool.query(`
      INSERT INTO permissions (resource, action, key, description, is_system)
      VALUES
        ('documents', 'view',    'documents.view',    'Hak akses VIEW pada modul documents', TRUE),
        ('documents', 'create',  'documents.create',  'Hak akses CREATE pada modul documents', TRUE),
        ('documents', 'edit',    'documents.edit',    'Hak akses EDIT pada modul documents', TRUE),
        ('documents', 'delete',  'documents.delete',  'Hak akses DELETE pada modul documents', TRUE)
      ON CONFLICT (key) DO NOTHING;
    `);
    const propRes = await pool.query(`
      SELECT p.id, p.name
      FROM properties p
      JOIN rooms r ON r.property_id = p.id
      JOIN room_types rt ON rt.id = r.room_type_id
      WHERE COALESCE(r.is_active, TRUE) = TRUE
        AND COALESCE(r.status, 'VACANT_CLEAN') NOT IN ('OUT_OF_ORDER', 'OUT_OF_SERVICE')
      GROUP BY p.id, p.name
      HAVING count(r.id) >= 2
      ORDER BY p.id ASC
      LIMIT 1
    `);
    expect(propRes.rows.length > 0, 'At least one property with >= 2 active rooms exists for testing');
    propId = Number(propRes.rows[0].id);

    const roomRes = await pool.query(
      `SELECT r.id AS room_id, r.room_number, r.room_type_id, rt.name AS room_type_name
       FROM rooms r
       JOIN room_types rt ON rt.id = r.room_type_id
       WHERE r.property_id = $1
         AND COALESCE(r.is_active, TRUE) = TRUE
         AND COALESCE(r.status, 'VACANT_CLEAN') NOT IN ('OUT_OF_ORDER', 'OUT_OF_SERVICE')
       ORDER BY r.id ASC
       LIMIT 3`,
      [propId]
    );
    expect(roomRes.rows.length >= 2, 'At least 2 active rooms exist in property 1 for testing');
    const room1 = roomRes.rows[0];
    const room2 = roomRes.rows[1];

    // Get Platform Super Admin token
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
      access_type: 'PMS_STAFF',
    });

    // GF-F04: Read real initial feature flag state before mutating
    const origFlagRes = await pool.query(
      `SELECT enabled FROM property_features WHERE property_id = $1 AND feature_key = 'documents.enabled'`,
      [propId]
    );
    hadOriginalFlag = origFlagRes.rows.length > 0;
    originalDocFeatureEnabled = hadOriginalFlag ? Boolean(origFlagRes.rows[0].enabled) : null;
    await setFeatureFlag(pool, propId, 'documents.enabled', true, 'E2E_Setup');
    featureFlagModified = true;

    const cssPath = path.resolve(
      __dirname,
      '../../frontend/src/features/documents/guestDocumentPrint.css'
    );
    const cssText = fs.readFileSync(cssPath, 'utf8');
    const samplesDir = path.resolve(__dirname, '../../artifacts/guest-folio-samples');
    fs.mkdirSync(samplesDir, { recursive: true });

    // Find 5 non-overlapping free date windows in availability_dates
    const win1 = await findFreeDateWindow(pool, [room1], 2, '2026-08-01');
    const win2 = await findFreeDateWindow(pool, [room1], 2, win1.nextMinDate);
    const winOta = await findFreeDateWindow(pool, [room1], 2, win2.nextMinDate);
    const winMulti = await findFreeDateWindow(pool, [room1, room2], 2, winOta.nextMinDate);
    const winLong = await findFreeDateWindow(pool, [room1], 10, winMulti.nextMinDate);

    // ─────────────────────────────────────────────────────────────────────
    // SCENARIO 1: Simple Unpaid Folio (2 nights room charge, 0 payment)
    // ─────────────────────────────────────────────────────────────────────
    console.log('\n--- Scenario 1: Folio Sederhana Belum Bayar (UNPAID) ---');
    const book1 = await makeRequest(
      'POST',
      '/api/bookings',
      {
        property_id: propId,
        booking_channel: 'OTA',
        booking_source: 'TIKET_COM',
        ota_source: 'Tiket.com',
        booker_name: `${RUN_ID} Booker Unpaid`,
        booker_phone: '081234560001',
        guest_name: `${RUN_ID} Guest Unpaid`,
        guest_phone: '081234560001',
        identity_number: '3507010101900001',
        has_valid_identity: true,
        reservations: [
          {
            room_type_id: Number(room1.room_type_id),
            room_id: String(room1.room_id),
            check_in: win1.checkIn,
            check_out: win1.checkOut,
            total_price: 900000,
            subtotal_amount: 900000,
            is_manual_override: true,
            manual_override_reason: 'Fixture Rate',
          },
        ],
      },
      saToken
    );
    if (book1.status !== 200 && book1.status !== 201) {
      console.error('book1 failed:', book1.status, book1.body);
    }
    expect(book1.status === 200 || book1.status === 201, 'Scenario 1 booking created');
    const bookingId1 = Number(book1.body.data.booking_id);
    const resId1 = Number(book1.body.data.reservations[0].id);
    const guestIds1 = book1.body?.data?.created_guest_ids || (book1.body?.data?.guest_id ? [book1.body?.data?.guest_id] : []);
    await trackReservation(bookingId1, resId1, guestIds1);
    await pool.query(
      `UPDATE bookings SET booking_source = 'WALK_IN', booking_channel = 'WALK_IN', referral = NULL WHERE id = $1`,
      [bookingId1]
    );

    const folio1 = await makeRequest(
      'GET',
      `/api/documents/reservations/${resId1}/folio?property_id=${propId}`,
      null,
      saToken
    );
    if (folio1.status !== 200) {
      console.error('folio1 failed:', folio1.status, folio1.body);
    }
    expect(folio1.status === 200, 'Scenario 1 GET folio returns 200 OK');
    const f1 = folio1.body.data;
    expect(f1.stay.nights === 2, 'Scenario 1 nights = 2');
    expect(f1.financial_summary.room_charges_total === 900000, 'Scenario 1 room_charges_total = 900,000');
    expect(f1.financial_summary.additional_charges_total === 0, 'Scenario 1 additional_charges_total = 0');
    expect(f1.financial_summary.payments_received_total === 0, 'Scenario 1 payments_received_total = 0');
    expect(f1.financial_summary.remaining_balance === 900000, 'Scenario 1 remaining_balance = 900,000');
    expect(f1.financial_summary.payment_status === 'UNPAID', 'Scenario 1 payment_status = UNPAID');
    expect(f1.financial_summary.payment_status_label === 'BELUM BAYAR', 'Scenario 1 label = BELUM BAYAR');
    expect(f1.reconciliation.is_reconciled === true, 'Scenario 1 reconciliation.is_reconciled = true');
    expect(f1.reconciliation.discrepancy_amount === 0, 'Scenario 1 discrepancy_amount = 0');

    // ─────────────────────────────────────────────────────────────────────
    // SCENARIO 2: Partially Paid Folio (Room + POS/Minibar/Laundry + Discount + Partial Payment)
    //             + Generate Synthetic PDF #1
    // ─────────────────────────────────────────────────────────────────────
    console.log('\n--- Scenario 2: Folio Bayar Sebagian (PARTIAL) + Sample PDF #1 ---');
    const book2 = await makeRequest(
      'POST',
      '/api/bookings',
      {
        property_id: propId,
        booking_channel: 'OTA',
        booking_source: 'TIKET_COM',
        ota_source: 'Tiket.com',
        booker_name: 'PT Nusantara Raya (Ibu Ratna)',
        booker_phone: '081234560002',
        guest_name: 'Bpk. Hendra Wijaya',
        guest_phone: '081234560002',
        guest_email: 'hendra.wijaya@nusantara.co.id',
        identity_number: '3507010101900002',
        has_valid_identity: true,
        reservations: [
          {
            room_type_id: Number(room1.room_type_id),
            room_id: String(room1.room_id),
            check_in: win2.checkIn,
            check_out: win2.checkOut,
            total_price: 1100000,
            subtotal_amount: 1200000,
            discount_type: 'FIXED',
            discount_value: 100000,
            discount_amount: 100000,
            discount_reason: 'Diskon Korporasi PT Nusantara Raya',
            is_manual_override: true,
            manual_override_reason: 'Corporate Rate',
          },
        ],
      },
      saToken
    );
    if (book2.status !== 200 && book2.status !== 201) {
      console.error('book2 failed:', book2.status, book2.body);
    }
    expect(book2.status === 200 || book2.status === 201, 'Scenario 2 booking created');
    const bookingId2 = Number(book2.body.data.booking_id);
    const resId2 = Number(book2.body.data.reservations[0].id);
    const guestIds2 = book2.body?.data?.created_guest_ids || (book2.body?.data?.guest_id ? [book2.body?.data?.guest_id] : []);
    await trackReservation(bookingId2, resId2, guestIds2);
    await pool.query(
      `UPDATE bookings SET booking_source = 'DIRECT', booking_channel = 'WALK_IN', referral = 'PT Nusantara Raya' WHERE id = $1`,
      [bookingId2]
    );

    // Add stay charges: Minibar & Laundry & F&B Room Service
    await createStayCharge(pool, {
      propertyId: propId,
      reservationId: resId2,
      chargeType: 'MINIBAR',
      amount: 65000,
      quantity: 1,
      notes: 'Minibar: 2x Sparkling Water & Kacang Almond',
      actorUserId: Number(saUser.id),
      actorName: 'Kasir FO',
    });
    await createStayCharge(pool, {
      propertyId: propId,
      reservationId: resId2,
      chargeType: 'LAUNDRY',
      amount: 85000,
      quantity: 1,
      notes: 'Express Laundry: 2 Kemeja Batik & 1 Celana Kerja',
      actorUserId: Number(saUser.id),
      actorName: 'Kasir FO',
    });
    await createStayCharge(pool, {
      propertyId: propId,
      reservationId: resId2,
      chargeType: 'FNB',
      amount: 125000,
      quantity: 1,
      notes: 'POS Restoran #POS-8821: Rawon Iga OAK & Es Kopi Susu',
      actorUserId: Number(saUser.id),
      actorName: 'Kasir Resto',
    });

    // Record partial payment Rp 750,000 via QRIS
    const pay2 = await makeRequest(
      'POST',
      `/api/reservations/${resId2}/payments`,
      buildMultipartBody(
        {
          amount: '750000',
          payment_method: 'QRIS',
          property_id: String(propId),
        },
        {
          name: 'file',
          filename: 'qris_partial.png',
          buffer: Buffer.from('fake-qris-slip'),
        }
      ),
      saToken
    );
    expect(pay2.status === 200 || pay2.status === 201, 'Scenario 2 partial QRIS payment recorded');

    const folio2 = await makeRequest(
      'GET',
      `/api/documents/reservations/${resId2}/folio?property_id=${propId}`,
      null,
      saToken
    );
    expect(folio2.status === 200, 'Scenario 2 GET folio returns 200 OK');
    const f2 = folio2.body.data;
    // Expected: Room gross 1,200,000 - Discount 100,000 + Additional 275,000 = 1,375,000 effective charges
    // Paid 750,000 -> Remaining 625,000
    expect(f2.financial_summary.room_charges_total === 1200000, 'Scenario 2 room_charges_total = 1,200,000');
    expect(f2.financial_summary.discount_total === 100000, 'Scenario 2 discount_total = 100,000');
    expect(f2.financial_summary.additional_charges_total === 275000, 'Scenario 2 additional_charges_total = 275,000');
    expect(f2.financial_summary.effective_total_charges === 1375000, 'Scenario 2 effective_total_charges = 1,375,000');
    expect(f2.financial_summary.payments_received_total === 750000, 'Scenario 2 payments_received_total = 750,000');
    expect(f2.financial_summary.remaining_balance === 625000, 'Scenario 2 remaining_balance = 625,000');
    expect(f2.financial_summary.payment_status === 'PARTIAL', 'Scenario 2 payment_status = PARTIAL');
    expect(f2.financial_summary.payment_status_label === 'DIBAYAR SEBAGIAN', 'Scenario 2 label = DIBAYAR SEBAGIAN');
    expect(f2.reconciliation.is_reconciled === true, 'Scenario 2 reconciliation.is_reconciled = true');
    expect(f2.is_derived_reference === true, 'Scenario 2 is_derived_reference = true (GF-F05)');
    expect(f2.folio_label === 'No. Referensi Folio (Turunan)', 'Scenario 2 folio_label = No. Referensi Folio (Turunan) (GF-F05)');

    // Render Sample PDF #1: Partially Paid Folio via production React component (GF-F01)
    const json1Path = path.join(samplesDir, 'sample_1_guest_folio_partial_payment.json');
    const html1Path = path.join(samplesDir, 'sample_1_guest_folio_partial_payment.html');
    const pdf1Path = path.join(samplesDir, 'sample_1_guest_folio_partial_payment.pdf');
    const sample1Data = normalizeSyntheticSample(f2, {
      roomNumber: '101',
      roomTypeName: 'Deluxe Room',
      bid: 'TST001-261106-KSGF7BRR',
      guestName: 'Bpk. Hendra Wijaya',
    });
    fs.writeFileSync(json1Path, JSON.stringify(sample1Data, null, 2), 'utf8');
    fs.writeFileSync(html1Path, renderProductionComponentHtml(sample1Data, 'EFFECTIVE'), 'utf8');
    renderHtmlToPdfWithChrome(html1Path, pdf1Path);
    expect(fs.existsSync(pdf1Path) && fs.statSync(pdf1Path).size > 5000, 'Sample PDF #1 (Partially Paid) generated from production component');
    const p1Count = countPdfPages(fs.readFileSync(pdf1Path));
    expect(p1Count === 1, `Sample PDF #1 has exactly 1 page (no orphaned footer page), got ${p1Count}`);

    // ─────────────────────────────────────────────────────────────────────
    // SCENARIO 3: Paid-In-Full Folio (LUNAS) + Generate Synthetic PDF #2
    // ─────────────────────────────────────────────────────────────────────
    console.log('\n--- Scenario 3: Folio Lunas (PAID / LUNAS) + Sample PDF #2 ---');
    const dep2 = await receiveDeposit(pool, {
      propertyId: propId,
      reservationId: resId2,
      amount: 625000,
      paymentMethod: 'BANK_TRANSFER',
      purpose: 'ADVANCE_PAYMENT',
      idempotencyKey: `${RUN_ID}_dep_recv_res2`,
      reference: `${RUN_ID}_dep_res2`,
      notes: 'Deposit pelunasan kamar 102',
      actor: { userId: String(saUser.id), name: 'Front Desk', role: 'Receptionist' },
    });
    const depositId2 = Number(dep2.id || dep2.deposit?.id);
    createdDepositIds.add(depositId2);
    const depApplied2 = await applyDeposit(pool, {
      depositId: depositId2,
      propertyId: propId,
      reservationId: resId2,
      amount: 625000,
      idempotencyKey: `${RUN_ID}_dep_apply_res2`,
      actor: { userId: String(saUser.id), name: 'Front Desk', role: 'Receptionist' },
      notes: 'Penerapan deposit untuk pelunasan kamar 102',
    });
    expect(Boolean(depApplied2.deposit), 'Scenario 3 settlement deposit applied');

    const folio3 = await makeRequest(
      'GET',
      `/api/documents/reservations/${resId2}/folio?property_id=${propId}`,
      null,
      saToken
    );
    expect(folio3.status === 200, 'Scenario 3 GET folio returns 200 OK');
    const f3 = folio3.body.data;
    expect(f3.financial_summary.payments_received_total === 750000, 'Scenario 3 payments_received_total = 750,000');
    expect(f3.financial_summary.applied_deposit === 625000, 'Scenario 3 applied_deposit = 625,000');
    expect(f3.financial_summary.deposit_applied_total === 625000, 'Scenario 3 deposit_applied_total = 625,000');
    expect(f3.financial_summary.net_deposit_applied_total === 625000, 'Scenario 3 net_deposit_applied_total = 625,000');
    expect(f3.financial_summary.remaining_balance === 0, 'Scenario 3 remaining_balance = 0');
    expect(f3.financial_summary.payment_status === 'PAID', 'Scenario 3 payment_status = PAID');
    expect(f3.financial_summary.payment_status_label === 'LUNAS', 'Scenario 3 label = LUNAS');
    expect(f3.reconciliation.is_reconciled === true, 'Scenario 3 reconciliation.is_reconciled = true');

    // Render Sample PDF #2: Paid-in-Full (LUNAS) Folio via production React component (GF-F01)
    const json2Path = path.join(samplesDir, 'sample_2_guest_folio_paid_lunas.json');
    const html2Path = path.join(samplesDir, 'sample_2_guest_folio_paid_lunas.html');
    const pdf2Path = path.join(samplesDir, 'sample_2_guest_folio_paid_lunas.pdf');
    const sample2Data = normalizeSyntheticSample(f3, {
      roomNumber: '102',
      roomTypeName: 'Superior Room',
      bid: 'TST001-261106-PAID0001',
      guestName: 'Ibu Siti Rahma',
    });
    fs.writeFileSync(json2Path, JSON.stringify(sample2Data, null, 2), 'utf8');
    fs.writeFileSync(html2Path, renderProductionComponentHtml(sample2Data, 'EFFECTIVE'), 'utf8');
    renderHtmlToPdfWithChrome(html2Path, pdf2Path);
    expect(fs.existsSync(pdf2Path) && fs.statSync(pdf2Path).size > 5000, 'Sample PDF #2 (Paid LUNAS) generated from production component');
    const p2Count = countPdfPages(fs.readFileSync(pdf2Path));
    expect(p2Count === 1, `Sample PDF #2 has exactly 1 page (no orphaned footer page), got ${p2Count}`);

    // ─────────────────────────────────────────────────────────────────────
    // SCENARIO 4 & 5: Deposit Custody Received (Not Applied) vs DEPOSIT_APPLY & DEPOSIT_UNAPPLY
    // ─────────────────────────────────────────────────────────────────────
    console.log('\n--- Scenario 4 & 5: Deposit Custody vs DEPOSIT_APPLY / DEPOSIT_UNAPPLY ---');
    const depReceived = await receiveDeposit(pool, {
      propertyId: propId,
      reservationId: resId1,
      amount: 500000,
      paymentMethod: 'CASH',
      purpose: 'ADVANCE_PAYMENT',
      idempotencyKey: `${RUN_ID}_dep_recv_1`,
      actor: { userId: String(saUser.id), name: 'Kasir FO', role: 'Super Admin' },
      notes: 'Deposit jaminan kunci & minibar',
      evidence: null,
      evidenceNote: null,
    });
    const depositId1 = Number(depReceived.id || depReceived.deposit?.id);
    createdDepositIds.add(depositId1);

    const folio4 = await makeRequest(
      'GET',
      `/api/documents/reservations/${resId1}/folio?property_id=${propId}`,
      null,
      saToken
    );
    const f4 = folio4.body.data;
    expect(f4.deposit_custody.can_view === true, 'Scenario 4 deposit_custody.can_view = true');
    expect(f4.deposit_custody.effective_received === 500000, 'Scenario 4 deposit effective_received = 500,000');
    expect(f4.deposit_custody.applied_to_folio === 0, 'Scenario 4 deposit applied_to_folio = 0');
    expect(f4.deposit_custody.remaining_held_custody === 500000, 'Scenario 4 remaining_held_custody = 500,000');
    expect(
      f4.financial_summary.remaining_balance === 900000,
      'Scenario 4 unapplied deposit custody does NOT reduce folio remaining_balance (still 900,000)'
    );
    expect(f4.reconciliation.is_reconciled === true, 'Scenario 4 reconciliation.is_reconciled = true');

    // Scenario 5A: Apply Rp 300,000 of deposit to folio
    const depApplied = await applyDeposit(pool, {
      depositId: depositId1,
      propertyId: propId,
      reservationId: resId1,
      amount: 300000,
      idempotencyKey: `${RUN_ID}_dep_apply_1`,
      actor: { userId: String(saUser.id), name: 'Kasir FO', role: 'Super Admin' },
      notes: 'Potong deposit untuk sebagian biaya kamar',
    });
    const applyEventRow = depApplied.deposit.events.find((e) => e.event_type === 'APPLY');
    expect(Boolean(applyEventRow && applyEventRow.id), 'Scenario 5A apply event created');

    const folio5a = await makeRequest(
      'GET',
      `/api/documents/reservations/${resId1}/folio?property_id=${propId}`,
      null,
      saToken
    );
    const f5a = folio5a.body.data;
    expect(f5a.financial_summary.deposit_applied_total === 300000, 'Scenario 5A deposit_applied_total = 300,000');
    expect(f5a.financial_summary.net_deposit_applied_total === 300000, 'Scenario 5A net_deposit_applied_total = 300,000');
    expect(f5a.financial_summary.remaining_balance === 600000, 'Scenario 5A remaining_balance reduced to 600,000');
    expect(f5a.deposit_custody.applied_to_folio === 300000, 'Scenario 5A custody applied_to_folio = 300,000');
    expect(f5a.deposit_custody.remaining_held_custody === 200000, 'Scenario 5A custody remaining_held_custody = 200,000');
    expect(f5a.reconciliation.is_reconciled === true, 'Scenario 5A reconciliation.is_reconciled = true');

    // Scenario 5B: Unapply Rp 100,000 of applied deposit from folio
    await unapplyDeposit(pool, {
      depositId: depositId1,
      propertyId: propId,
      reservationId: resId1,
      applyEventId: Number(applyEventRow.id),
      amount: 100000,
      idempotencyKey: `${RUN_ID}_dep_unapply_1`,
      actor: { userId: String(saUser.id), name: 'Kasir FO', role: 'Super Admin' },
      notes: 'Koreksi nilai potong deposit',
    });

    const folio5b = await makeRequest(
      'GET',
      `/api/documents/reservations/${resId1}/folio?property_id=${propId}`,
      null,
      saToken
    );
    const f5b = folio5b.body.data;
    expect(f5b.financial_summary.deposit_applied_total === 300000, 'Scenario 5B deposit_applied_total = 300,000');
    expect(f5b.financial_summary.deposit_unapplied_total === 100000, 'Scenario 5B deposit_unapplied_total = 100,000');
    expect(f5b.financial_summary.net_deposit_applied_total === 200000, 'Scenario 5B net_deposit_applied_total = 200,000');
    expect(f5b.financial_summary.remaining_balance === 700000, 'Scenario 5B remaining_balance = 700,000');
    expect(f5b.deposit_custody.remaining_held_custody === 300000, 'Scenario 5B custody remaining_held_custody = 300,000');
    expect(f5b.reconciliation.is_reconciled === true, 'Scenario 5B reconciliation.is_reconciled = true');

    // ─────────────────────────────────────────────────────────────────────
    // SCENARIO 6: Void / Correction Payment & Voided Charge (EFFECTIVE vs AUDIT)
    // ─────────────────────────────────────────────────────────────────────
    console.log('\n--- Scenario 6: Void / Koreksi Pembayaran & Void Charge (EFFECTIVE vs AUDIT) ---');
    // Add a charge of 50,000 then void it
    const tempCharge = await createStayCharge(pool, {
      propertyId: propId,
      reservationId: resId1,
      chargeType: 'ADDITIONAL_CHARGE',
      amount: 50000,
      quantity: 1,
      notes: 'Biaya salah input (akan di-void)',
      actorUserId: Number(saUser.id),
      actorName: 'Kasir FO',
    });
    await voidStayCharge(pool, {
      propertyId: propId,
      reservationId: resId1,
      entryId: Number(tempCharge.entry.id),
      reason: 'Salah kamar saat posting biaya tambahan',
      actorUserId: Number(saUser.id),
      actorName: 'Kasir FO',
    });

    // Add a payment of 400,000 then correct it to 250,000
    const payToCorrect = await makeRequest(
      'POST',
      `/api/reservations/${resId1}/payments`,
      buildMultipartBody(
        {
          amount: '400000',
          payment_method: 'CASH',
          property_id: String(propId),
        },
        {
          name: 'file',
          filename: 'cash_wrong.png',
          buffer: Buffer.from('fake-cash-wrong'),
        }
      ),
      saToken
    );
    expect(payToCorrect.status === 200 || payToCorrect.status === 201, 'Scenario 6 initial payment recorded');
    const wrongPaymentId = Number(payToCorrect.body.data?.payment?.id || payToCorrect.body.data?.payment_id || payToCorrect.body.data?.id);

    const corrRes = await makeRequest(
      'POST',
      `/api/reservations/${resId1}/payments/${wrongPaymentId}/correct`,
      buildMultipartBody(
        {
          property_id: String(propId),
          amount: '250000',
          corrected_amount: '250000',
          payment_method: 'BANK_TRANSFER',
          corrected_method: 'BANK_TRANSFER',
          reason_code: 'WRONG_AMOUNT',
          reason_text: 'Koreksi nominal pembayaran dari 400rb menjadi 250rb',
          actor_name: 'Kasir FO',
        },
        {
          name: 'file',
          filename: 'transfer_corrected.png',
          buffer: Buffer.from('fake-transfer-corrected'),
        }
      ),
      saToken
    );
    if (corrRes.status !== 200) {
      console.error('corrRes failed:', corrRes.status, corrRes.body);
    }
    expect(corrRes.status === 200, 'Scenario 6 payment corrected from 400,000 to 250,000');

    const folio6 = await makeRequest(
      'GET',
      `/api/documents/reservations/${resId1}/folio?property_id=${propId}`,
      null,
      saToken
    );
    const f6 = folio6.body.data;
    // Net balance check: 900,000 room - 200,000 net deposit applied - 250,000 active payment = 450,000
    expect(f6.financial_summary.remaining_balance === 450000, 'Scenario 6 remaining_balance = 450,000');
    expect(
      f6.reconciliation.effective_net_balance === 450000,
      'Scenario 6 effective_net_balance = 450,000'
    );
    expect(
      f6.reconciliation.audit_net_balance === 450000,
      'Scenario 6 audit_net_balance = 450,000'
    );
    expect(f6.reconciliation.is_reconciled === true, 'Scenario 6 EFFECTIVE and AUDIT modes reconcile 100%');
    expect(
      f6.effective_lines.some((l) => l.status_badge === 'REPLACEMENT'),
      'Scenario 6 effective_lines marks corrected payment with REPLACEMENT badge'
    );
    expect(
      f6.audit_lines.some((l) => l.status_badge === 'VOIDED') &&
        f6.audit_lines.some((l) => l.status_badge === 'CORRECTED') &&
        f6.audit_lines.some((l) => l.status_badge === 'REVERSAL'),
      'Scenario 6 audit_lines includes VOIDED, CORRECTED, and pairing REVERSAL rows'
    );

    // ─────────────────────────────────────────────────────────────────────
    // SCENARIO 7: OTA_COLLECT Folio with Guest Incidentals (GUEST_FOLIO vs FULL_RESERVATION)
    // ─────────────────────────────────────────────────────────────────────
    console.log('\n--- Scenario 7: Folio OTA_COLLECT dengan Insidental Tamu ---');
    const bookOta = await makeRequest(
      'POST',
      '/api/bookings',
      {
        property_id: propId,
        booking_channel: 'OTA',
        booking_source: 'TRAVELOKA',
        ota_source: 'Traveloka',
        booker_name: 'Traveloka Corporate',
        booker_phone: '081234560007',
        guest_name: `${RUN_ID} Guest OTA`,
        guest_phone: '081234560007',
        identity_number: '3507010101900007',
        has_valid_identity: true,
        reservations: [
          {
            room_type_id: Number(room1.room_type_id),
            room_id: String(room1.room_id),
            check_in: winOta.checkIn,
            check_out: winOta.checkOut,
            total_price: 800000,
            subtotal_amount: 800000,
            is_manual_override: true,
            manual_override_reason: 'OTA Rate',
          },
        ],
      },
      saToken
    );
    if (bookOta.status !== 200 && bookOta.status !== 201) {
      console.error('bookOta failed:', bookOta.status, bookOta.body);
    }
    expect(bookOta.status === 200 || bookOta.status === 201, 'Scenario 7 OTA_COLLECT booking created');
    const bookingIdOta = Number(bookOta.body.data.booking_id);
    const resIdOta = Number(bookOta.body.data.reservations[0].id);
    const guestIdsOta = bookOta.body?.data?.created_guest_ids || (bookOta.body?.data?.guest_id ? [bookOta.body?.data?.guest_id] : []);
    await trackReservation(bookingIdOta, resIdOta, guestIdsOta);
    createdBookingIds.add(bookingIdOta);
    createdReservationIds.add(resIdOta);
    await pool.query(
      `UPDATE bookings SET payment_responsibility = 'OTA_COLLECT', referral = 'Traveloka' WHERE id = $1`,
      [bookingIdOta]
    );

    await createStayCharge(pool, {
      propertyId: propId,
      reservationId: resIdOta,
      chargeType: 'MINIBAR',
      amount: 45000,
      quantity: 1,
      notes: 'Minibar tamu OTA',
      actorUserId: Number(saUser.id),
      actorName: 'Kasir FO',
    });

    const folioOtaGuest = await makeRequest(
      'GET',
      `/api/documents/reservations/${resIdOta}/folio?property_id=${propId}&scope=GUEST_FOLIO`,
      null,
      saToken
    );
    const fOtaGuest = folioOtaGuest.body.data;
    expect(fOtaGuest.responsibility.is_ota_collect === true, 'Scenario 7 is_ota_collect = true');
    expect(fOtaGuest.financial_summary.room_charges_total === 0, 'Scenario 7 GUEST_FOLIO room_charges_total = 0');
    expect(
      fOtaGuest.financial_summary.ota_room_accommodation_responsibility === 800000,
      'Scenario 7 ota_room_accommodation_responsibility = 800,000'
    );
    expect(
      fOtaGuest.financial_summary.additional_charges_total === 45000,
      'Scenario 7 GUEST_FOLIO additional_charges_total = 45,000'
    );
    expect(
      fOtaGuest.financial_summary.remaining_balance === 45000,
      'Scenario 7 GUEST_FOLIO remaining_balance = 45,000 (incidental only)'
    );
    expect(fOtaGuest.reconciliation.is_reconciled === true, 'Scenario 7 GUEST_FOLIO reconciled');

    const folioOtaFull = await makeRequest(
      'GET',
      `/api/documents/reservations/${resIdOta}/folio?property_id=${propId}&scope=FULL_RESERVATION`,
      null,
      saToken
    );
    const fOtaFull = folioOtaFull.body.data;
    expect(
      fOtaFull.financial_summary.room_charges_total === 800000,
      'Scenario 7 FULL_RESERVATION room_charges_total = 800,000'
    );
    expect(
      fOtaFull.financial_summary.effective_total_charges === 845000,
      'Scenario 7 FULL_RESERVATION effective_total_charges = 845,000'
    );
    expect(fOtaFull.reconciliation.is_reconciled === true, 'Scenario 7 FULL_RESERVATION reconciled');

    // ─────────────────────────────────────────────────────────────────────
    // SCENARIO 8: Multi-Room Booking with Group Payment Allocations
    // ─────────────────────────────────────────────────────────────────────
    console.log('\n--- Scenario 8: Booking Multi-Kamar dengan Alokasi Pembayaran Grup ---');
    const bookMulti = await makeRequest(
      'POST',
      '/api/bookings',
      {
        property_id: propId,
        booking_channel: 'OTA',
        booking_source: 'TIKET_COM',
        ota_source: 'Tiket.com',
        booker_name: `${RUN_ID} Group Booker`,
        booker_phone: '081234560008',
        guest_name: `${RUN_ID} Group Guest A`,
        guest_phone: '081234560008',
        identity_number: '3507010101900008',
        has_valid_identity: true,
        initial_payment: {
          amount: 500000,
          payment_method: 'BANK_TRANSFER',
          payment_evidence_path: '/uploads/evidences/test-group-slip.png',
        },
        reservations: [
          {
            room_type_id: Number(room1.room_type_id),
            room_id: String(room1.room_id),
            check_in: winMulti.checkIn,
            check_out: winMulti.checkOut,
            total_price: 600000,
            subtotal_amount: 600000,
            is_manual_override: true,
            manual_override_reason: 'Group Rate A',
          },
          {
            room_type_id: Number(room2.room_type_id),
            room_id: String(room2.room_id),
            check_in: winMulti.checkIn,
            check_out: winMulti.checkOut,
            total_price: 400000,
            subtotal_amount: 400000,
            is_manual_override: true,
            manual_override_reason: 'Group Rate B',
          },
        ],
      },
      saToken
    );
    if (bookMulti.status !== 200 && bookMulti.status !== 201) {
      console.error('bookMulti failed:', bookMulti.status, bookMulti.body);
    }
    expect(bookMulti.status === 200 || bookMulti.status === 201, 'Scenario 8 multi-room booking created');
    const bookingIdMulti = Number(bookMulti.body.data.booking_id);
    const resMultiA = Number(bookMulti.body.data.reservations[0].id);
    const resMultiB = Number(bookMulti.body.data.reservations[1].id);
    const guestIdsMulti = bookMulti.body?.data?.created_guest_ids || (bookMulti.body?.data?.guest_id ? [bookMulti.body?.data?.guest_id] : []);
    await trackReservation(bookingIdMulti, resMultiA, guestIdsMulti);
    await trackReservation(bookingIdMulti, resMultiB, guestIdsMulti);
    await pool.query(
      `UPDATE bookings SET booking_source = 'WALK_IN', booking_channel = 'WALK_IN', referral = NULL WHERE id = $1`,
      [bookingIdMulti]
    );

    const folioMultiA = await makeRequest(
      'GET',
      `/api/documents/reservations/${resMultiA}/folio?property_id=${propId}`,
      null,
      saToken
    );
    const fMultiA = folioMultiA.body.data;
    expect(fMultiA.booking_siblings.length === 1, 'Scenario 8 Room A lists 1 sibling reservation');
    expect(
      fMultiA.booking_siblings[0].reservation_id === resMultiB,
      'Scenario 8 sibling reservation_id matches Room B'
    );
    expect(
      fMultiA.financial_summary.room_charges_total === 600000,
      'Scenario 8 Room A shows only Room A charges (600,000), never silently merging Room B'
    );
    expect(fMultiA.reconciliation.is_reconciled === true, 'Scenario 8 Room A reconciled');

    // ─────────────────────────────────────────────────────────────────────
    // SCENARIO 9: Long Multi-Page Folio (>30 Line Items) + Generate Synthetic PDF #3
    // ─────────────────────────────────────────────────────────────────────
    console.log('\n--- Scenario 9: Folio Panjang Multi-Halaman (>30 Item) + Sample PDF #3 ---');
    const bookLong = await makeRequest(
      'POST',
      '/api/bookings',
      {
        property_id: propId,
        booking_channel: 'OTA',
        booking_source: 'TIKET_COM',
        ota_source: 'Tiket.com',
        booker_name: 'PT Garuda Energi Indonesia',
        booker_phone: '081234560009',
        guest_name: 'Ir. Bambang Suryono, M.Eng.',
        guest_phone: '081234560009',
        guest_email: 'bambang.suryono@garudaenergi.co.id',
        identity_number: '3507010101900009',
        has_valid_identity: true,
        reservations: [
          {
            room_type_id: Number(room1.room_type_id),
            room_id: String(room1.room_id),
            check_in: winLong.checkIn,
            check_out: winLong.checkOut,
            total_price: 5500000,
            subtotal_amount: 5500000,
            is_manual_override: true,
            manual_override_reason: 'Long Stay Corporate Rate',
          },
        ],
      },
      saToken
    );
    if (bookLong.status !== 200 && bookLong.status !== 201) {
      console.error('bookLong failed:', bookLong.status, bookLong.body);
    }
    expect(bookLong.status === 200 || bookLong.status === 201, 'Scenario 9 10-night booking created');
    const bookingIdLong = Number(bookLong.body.data.booking_id);
    const resIdLong = Number(bookLong.body.data.reservations[0].id);
    createdBookingIds.add(bookingIdLong);
    createdReservationIds.add(resIdLong);
    await pool.query(
      `UPDATE bookings SET booking_source = 'DIRECT', booking_channel = 'WALK_IN', referral = 'PT Garuda Energi Indonesia' WHERE id = $1`,
      [bookingIdLong]
    );

    const sampleCharges = [
      { type: 'FNB', amt: 145000, note: 'POS Restoran #POS-9001: Sarapan Tamu Tambahan & Kopi Arabika' },
      { type: 'MINIBAR', amt: 55000, note: 'Minibar Hari ke-1: 2x Pocari Sweat & Cokelat Silverqueen' },
      { type: 'LAUNDRY', amt: 95000, note: 'Laundry Reguler #LD-101: 3 Kemeja & 2 Celana Panjang' },
      { type: 'FNB', amt: 210000, note: 'POS Room Service #POS-9012: Nasi Goreng Spesial OAK & Jus Alpukat' },
      { type: 'TRANSPORT', amt: 250000, note: 'Layanan Antar-Jemput Bandara Abdul Rachman Saleh' },
      { type: 'MINIBAR', amt: 45000, note: 'Minibar Hari ke-2: 2x Air Mineral Equil & Kacang Mete' },
      { type: 'FNB', amt: 185000, note: 'POS Restoran #POS-9025: Iga Bakar Madu & Wedang Uwuh' },
      { type: 'LAUNDRY', amt: 120000, note: 'Laundry Express #LD-108: Setelan Jas Formal (Dry Clean)' },
      { type: 'SPA', amt: 325000, note: 'Traditional Javanese Reflexology & Aromatherapy (90 Menit)' },
      { type: 'FNB', amt: 160000, note: 'POS Lounge #POS-9040: Meeting Coffee Break & Snack Sore' },
      { type: 'MINIBAR', amt: 60000, note: 'Minibar Hari ke-4: Minuman Kaleng & Keripik Kentang' },
      { type: 'LAUNDRY', amt: 80000, note: 'Laundry Reguler #LD-115: 4 Pakaian Harian' },
      { type: 'FNB', amt: 240000, note: 'POS Restoran #POS-9055: Makan Malam Bisnis (Sop Buntut & Gurame Bakar)' },
      { type: 'ADDITIONAL_CHARGE', amt: 150000, note: 'Sewa Proyektor Mini & Ruang Diskusi Eksekutif (2 Jam)' },
      { type: 'FNB', amt: 135000, note: 'POS Room Service #POS-9071: Club Sandwich & Teh Tarik Hangat' },
      { type: 'MINIBAR', amt: 50000, note: 'Minibar Hari ke-6: 2x Jus Buah Kemasan' },
      { type: 'LAUNDRY', amt: 90000, note: 'Laundry Reguler #LD-122: 3 Kemeja Kerja' },
      { type: 'FNB', amt: 195000, note: 'POS Restoran #POS-9088: Ayam Betutu Lawang & Es Kelapa Muda' },
      { type: 'TRANSPORT', amt: 300000, note: 'Sewa Mobil Operasional Kunjungan Industri (Half-Day)' },
      { type: 'FNB', amt: 175000, note: 'POS Restoran #POS-9102: Makan Malam Penutup & Dessert Pisang Goreng Keju' },
      { type: 'MINIBAR', amt: 40000, note: 'Minibar Hari ke-7: 2x Teh Botol & Biskuit Cokelat' },
      { type: 'LAUNDRY', amt: 85000, note: 'Laundry Reguler #LD-130: 2 Kemeja Batik & 1 Celana Bahan' },
      { type: 'FNB', amt: 125000, note: 'POS Lounge #POS-9115: Kopi Tubruk Nusantara & Singkong Goreng' },
      { type: 'SPA', amt: 275000, note: 'Foot Reflexology & Herbal Compress (60 Menit)' },
      { type: 'FNB', amt: 165000, note: 'POS Restoran #POS-9128: Rawon Nguling Daging Sapi & Telur Asin' },
      { type: 'MINIBAR', amt: 35000, note: 'Minibar Hari ke-8: Air Kelapa Asli & Kacang Bawang' },
      { type: 'LAUNDRY', amt: 70000, note: 'Laundry Reguler #LD-138: Pakaian Kasual Santai' },
      { type: 'FNB', amt: 215000, note: 'POS Restoran #POS-9140: Bebek Goreng Kremes & Sambal Korek' },
      { type: 'TRANSPORT', amt: 150000, note: 'Antar Jemput Stasiun Kereta Api Lawang' },
      { type: 'ADDITIONAL_CHARGE', amt: 100000, note: 'Layanan Pengantaran Dokumen Bisnis & Printing Kantor' },
    ];

    for (const sc of sampleCharges) {
      await createStayCharge(pool, {
        propertyId: propId,
        reservationId: resIdLong,
        chargeType: sc.type,
        amount: sc.amt,
        quantity: 1,
        notes: sc.note,
        actorUserId: Number(saUser.id),
        actorName: 'Kasir FO',
      });
    }

    // Record 3 staged payments across stay
    for (const [idx, p] of [
      { amount: '2500000', method: 'BANK_TRANSFER' },
      { amount: '2500000', method: 'CREDIT_CARD' },
      { amount: '2000000', method: 'QRIS' },
    ].entries()) {
      await makeRequest(
        'POST',
        `/api/reservations/${resIdLong}/payments`,
        buildMultipartBody(
          {
            amount: p.amount,
            payment_method: p.method,
            property_id: String(propId),
          },
          {
            name: 'file',
            filename: `long_pay_${idx + 1}.png`,
            buffer: Buffer.from(`fake-long-pay-${idx + 1}`),
          }
        ),
        saToken
      );
    }

    const folioLong = await makeRequest(
      'GET',
      `/api/documents/reservations/${resIdLong}/folio?property_id=${propId}`,
      null,
      saToken
    );
    expect(folioLong.status === 200, 'Scenario 9 GET long folio returns 200 OK');
    const fLong = folioLong.body.data;
    expect(
      fLong.effective_lines.length >= 30,
      `Scenario 9 long folio has ${fLong.effective_lines.length} lines (>= 30)`
    );
    expect(fLong.reconciliation.is_reconciled === true, 'Scenario 9 long folio reconciled');

    // Render Sample PDF #3: Long Multi-Page Folio via production React component (GF-F01)
    const json3Path = path.join(samplesDir, 'sample_3_guest_folio_long_multipage.json');
    const html3Path = path.join(samplesDir, 'sample_3_guest_folio_long_multipage.html');
    const pdf3Path = path.join(samplesDir, 'sample_3_guest_folio_long_multipage.pdf');
    const sample3Data = normalizeSyntheticSample(fLong, {
      roomNumber: '201',
      roomTypeName: 'Executive Suite',
      bid: 'TST001-261106-LONG0001',
      guestName: 'Bpk. Bambang Soedirman',
    });
    fs.writeFileSync(json3Path, JSON.stringify(sample3Data, null, 2), 'utf8');
    fs.writeFileSync(html3Path, renderProductionComponentHtml(sample3Data, 'EFFECTIVE'), 'utf8');
    renderHtmlToPdfWithChrome(html3Path, pdf3Path);
    const pdf3Buf = fs.readFileSync(pdf3Path);
    const pdf3Pages = countPdfPages(pdf3Buf);
    expect(
      fs.existsSync(pdf3Path) && pdf3Buf.length > 10000 && pdf3Pages >= 2,
      `Sample PDF #3 (Long Multi-Page) generated from production component with ${pdf3Pages} pages (>= 2 pages)`
    );

    // ─────────────────────────────────────────────────────────────────────
    // SCENARIO 10: Security, Property Isolation, Feature Gate & Deposit Permission Separation
    // ─────────────────────────────────────────────────────────────────────
    console.log('\n--- Scenario 10: Keamanan, Isolasi Properti, Feature Gate & Izin Deposit ---');

    // 10A. Unauthenticated -> 401
    const unauthRes = await makeRequest(
      'GET',
      `/api/documents/reservations/${resId2}/folio?property_id=${propId}`,
      null,
      null
    );
    expect(unauthRes.status === 401, 'Scenario 10A unauthenticated request rejected with 401');

    // 10B. Cross-property request -> 404 (reservation belongs to propId, queried under property_id=99999)
    const crossPropRes = await makeRequest(
      'GET',
      `/api/documents/reservations/${resId2}/folio?property_id=99999`,
      null,
      saToken
    );
    expect(
      crossPropRes.status === 404 || crossPropRes.status === 403,
      `Scenario 10B cross-property request rejected with ${crossPropRes.status}`
    );

    // 10C. Create a custom staff role & user to test RBAC permissions
    const roleInsert = await pool.query(
      `INSERT INTO roles (name, description, property_id, is_system_role, is_active)
       VALUES ($1, 'Temporary E2E Role for Guest Folio RBAC', $2, FALSE, TRUE)
       RETURNING id`,
      [`${RUN_ID}_Role`, propId]
    );
    const tempRoleId = Number(roleInsert.rows[0].id);
    createdRoleIds.add(tempRoleId);

    const userInsert = await pool.query(
      `INSERT INTO users (username, email, password_hash, full_name, role_id, property_id, is_active, account_status)
       VALUES ($1, $2, 'hash', 'Folio RBAC Staff', $3, $4, TRUE, 'ACTIVE')
       RETURNING id`,
      [`${RUN_ID}_user`, `${RUN_ID}@oak.test`, tempRoleId, propId]
    );
    const tempUserId = Number(userInsert.rows[0].id);
    createdUserIds.add(tempUserId);

    const tempStaffToken = generateToken({
      id: tempUserId,
      email: `${RUN_ID}@oak.test`,
      username: `${RUN_ID}_user`,
      full_name: 'Folio RBAC Staff',
      role: `${RUN_ID}_Role`,
      role_id: tempRoleId,
      property_id: propId,
      scope: 'FULL',
      access_type: 'PMS_STAFF',
    });

    const saActor = {
      id: Number(saUser.id),
      name: String(saUser.full_name || saUser.username),
      property_id: propId,
      is_platform_super_admin: true,
    };

    // Deny 'Dokumen & Print' -> must get 403
    const gridNoDoc = {};
    for (const r of ACCESS_RESOURCES) {
      gridNoDoc[r.key] = { view: false, edit: false, delete: false };
    }
    await setRoleAccess(pool, propId, tempRoleId, gridNoDoc, saActor);

    const noDocRes = await makeRequest(
      'GET',
      `/api/documents/reservations/${resId1}/folio?property_id=${propId}`,
      null,
      tempStaffToken
    );
    expect(noDocRes.status === 403, 'Scenario 10C user without Dokumen & Print view permission gets 403');

    // Grant 'Dokumen & Print' view ONLY (without 'Transaksi' / deposit.view) -> 200 OK, deposit_custody.can_view === false
    const gridDocOnly = {};
    for (const r of ACCESS_RESOURCES) {
      gridDocOnly[r.key] = {
        view: r.key === 'Dokumen & Print',
        edit: false,
        delete: false,
      };
    }
    await setRoleAccess(pool, propId, tempRoleId, gridDocOnly, saActor);

    const docOnlyRes = await makeRequest(
      'GET',
      `/api/documents/reservations/${resId1}/folio?property_id=${propId}`,
      null,
      tempStaffToken
    );
    if (docOnlyRes.status !== 200) {
      console.error('docOnlyRes failed:', docOnlyRes.status, docOnlyRes.body);
    }
    expect(
      docOnlyRes.status === 200,
      'Scenario 10D user with Dokumen & Print (without Transaksi/deposit.view) gets 200 OK for Guest Folio'
    );
    expect(
      docOnlyRes.body.data.deposit_custody.can_view === false &&
        docOnlyRes.body.data.deposit_custody.remaining_held_custody === 0,
      'Scenario 10D deposit_custody is redacted (can_view = false) when user lacks deposit permission, while DEPOSIT_APPLY on folio remains intact'
    );
    expect(
      docOnlyRes.body.data.financial_summary.net_deposit_applied_total === 200000,
      'Scenario 10D net_deposit_applied_total on folio remains visible and accurate (200,000)'
    );

    // 10E. Disable feature flag documents.enabled -> must get 403 MODULE_DISABLED
    await setFeatureFlag(pool, propId, 'documents.enabled', false, 'E2E_Test');
    const disabledFlagRes = await makeRequest(
      'GET',
      `/api/documents/reservations/${resId1}/folio?property_id=${propId}`,
      null,
      saToken
    );
    expect(
      disabledFlagRes.status === 403 && disabledFlagRes.body.code === 'MODULE_DISABLED',
      'Scenario 10E documents.enabled=false returns 403 MODULE_DISABLED'
    );
    await setFeatureFlag(pool, propId, 'documents.enabled', true, 'E2E_Test');

    // ─────────────────────────────────────────────────────────────────────
    // SCENARIO 11: Strict Non-Mutation Proof & DB Inventory Invariants
    // ─────────────────────────────────────────────────────────────────────
    console.log('\n--- Scenario 11: Bukti Non-Mutasi (Read-Only) & Invarian Inventory ---');

    async function captureDbSnapshot(reservationId) {
      const [resSnap, folioSnap, pmtSnap, depSnap, depEventsSnap, auditSnap, invSnap] = await Promise.all([
        pool.query(`SELECT * FROM reservations WHERE id = $1`, [reservationId]),
        pool.query(`SELECT * FROM folio_entries WHERE reservation_id = $1 ORDER BY id`, [reservationId]),
        pool.query(`SELECT * FROM payment_transactions WHERE reservation_id = $1 ORDER BY id`, [reservationId]),
        pool.query(`SELECT * FROM deposits WHERE reservation_id = $1 ORDER BY id`, [reservationId]),
        pool.query(`SELECT * FROM deposit_events WHERE reservation_id = $1 ORDER BY id`, [reservationId]),
        pool.query(`SELECT audit_id, module, action, entity, record_id, timestamp FROM audit_logs ORDER BY audit_id`),
        pool.query(
          `SELECT ad.room_type_id, ad.date, ad.total_rooms, ad.reserved_qty
           FROM availability_dates ad
           JOIN room_types rt ON rt.id = ad.room_type_id
           WHERE rt.property_id = $1
           ORDER BY ad.room_type_id, ad.date`,
          [propId]
        ),
      ]);
      return JSON.stringify({
        res: resSnap.rows,
        folio: folioSnap.rows,
        pmt: pmtSnap.rows,
        dep: depSnap.rows,
        depEvents: depEventsSnap.rows,
        audit: auditSnap.rows,
        inv: invSnap.rows,
      });
    }

    const beforeSnap = await captureDbSnapshot(resId1);
    for (let i = 0; i < 5; i += 1) {
      const rA = await makeRequest(
        'GET',
        `/api/documents/reservations/${resId1}/folio?property_id=${propId}&scope=GUEST_FOLIO`,
        null,
        saToken
      );
      const rB = await makeRequest(
        'GET',
        `/api/documents/reservations/${resId1}/folio?property_id=${propId}&scope=FULL_RESERVATION`,
        null,
        saToken
      );
      if (rA.status !== 200 || rB.status !== 200) {
        throw new Error('Repeated folio GET failed');
      }
    }
    const afterSnap = await captureDbSnapshot(resId1);
    expect(
      beforeSnap === afterSnap,
      'Scenario 11 repeated Guest Folio reads (10 requests) caused ZERO database mutations across reservations, folio_entries, payment_transactions, deposits, audit_logs, and availability_dates'
    );

    // ─────────────────────────────────────────────────────────────────────
    // SCENARIO 12: GF-F02 Snapshot Read-Only Consistency Under Concurrent Mutation
    // ─────────────────────────────────────────────────────────────────────
    console.log('\n--- Scenario 12: GF-F02 Snapshot Read-Only Consistency Under Concurrent Mutation ---');
    const clientA = await pool.connect();
    try {
      await clientA.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      // Step 1: Initial query on snapshot clientA
      const initialDepsA = await getDepositsByReservation(clientA, propId, resId1);
      const initialDepCount = initialDepsA.length;

      // Step 2: Concurrently on another connection, receive deposit and commit
      const concDepRes = await receiveDeposit(pool, {
        propertyId: propId,
        reservationId: resId1,
        amount: 200000,
        paymentMethod: 'CASH',
        idempotencyKey: `DEP_CONC_${Date.now()}`,
        scope: 'ROOM_RESERVATION',
        purpose: 'SECURITY_DEPOSIT',
        actor: { userId: saUser.id, name: 'ConcurrentTester' },
        notes: 'Concurrent deposit test',
      });
      createdDepositIds.add(concDepRes.id);

      // Step 3: clientA queries again inside same transaction snapshot
      const snapDepsA = await getDepositsByReservation(clientA, propId, resId1);
      expect(
        snapDepsA.length === initialDepCount,
        `GF-F02 snapshot clientA does not see concurrently committed deposit (${snapDepsA.length} === ${initialDepCount})`
      );

      // Step 4: outer pool sees the newly committed deposit
      const outerDeps = await getDepositsByReservation(pool, propId, resId1);
      expect(
        outerDeps.length === initialDepCount + 1,
        `GF-F02 outer pool sees newly committed deposit (${outerDeps.length} === ${initialDepCount + 1})`
      );

      await clientA.query('COMMIT');
    } catch (sc12Err) {
      console.error('[SCENARIO 12 EXCEPTION]:', sc12Err);
      await clientA.query('ROLLBACK').catch(() => {});
      throw sc12Err;
    } finally {
      clientA.release();
    }

    // ─────────────────────────────────────────────────────────────────────
    // SCENARIO 13: GF-F03 Signed Balance Reconciliation & Overpayment Detection
    // ─────────────────────────────────────────────────────────────────────
    console.log('\n--- Scenario 13: GF-F03 Signed Balance Reconciliation & Overpayment Detection ---');
    const { getDocumentGuestFolio } = require('../dist/domains/documents/documentGuestFolioReadService');
    
    // 13A. Normal reconciled folio
    const normalFolioRes = await getDocumentGuestFolio(pool, propId, resId2, { user: saUser });
    expect(normalFolioRes.status === 'OK', 'GF-F03 normal folio status = OK');
    expect(normalFolioRes.data.reconciliation.is_reconciled === true, 'GF-F03 normal folio is_reconciled = true');
    expect(normalFolioRes.data.reconciliation.discrepancy_reasons.length === 0, 'GF-F03 normal folio has 0 discrepancy reasons');

    // 13B. Verify signed balance equality for overpaid / credit balance folio
    // (Voiding a post-payment incidental F&B charge creates an overpayment excess of 125,000)
    const fnbEntryRes = await pool.query(
      `SELECT id, amount FROM folio_entries WHERE reservation_id = $1 AND entry_type = 'FNB' AND is_voided = false LIMIT 1`,
      [resId2]
    );
    expect(fnbEntryRes.rows.length === 1, 'GF-F03 found F&B entry to void');
    const fnbEntryId = fnbEntryRes.rows[0].id;
    await voidStayCharge(pool, {
      propertyId: propId,
      reservationId: resId2,
      entryId: fnbEntryId,
      reason: 'Tamu membatalkan pesanan F&B setelah lunas',
      actorUserId: saUser.id,
      actorName: 'FrontDesk',
    });

    const overpayFolioRes = await getDocumentGuestFolio(pool, propId, resId2, { user: saUser });
    expect(overpayFolioRes.status === 'OK', 'GF-F03 overpaid folio status = OK');
    const opData = overpayFolioRes.data;
    expect(opData.summary.overpayment_excess === 125000, `GF-F03 overpayment_excess = 125,000 (${opData.summary.overpayment_excess})`);
    expect(opData.summary.remaining_balance === 0, 'GF-F03 remaining_balance = 0');
    const effectiveSignedDiff = opData.reconciliation.effective_debit_total - opData.reconciliation.effective_credit_total;
    expect(effectiveSignedDiff === -125000, `GF-F03 effective signed diff is -125,000 (${effectiveSignedDiff})`);
    expect(opData.reconciliation.is_reconciled === true, 'GF-F03 overpaid folio is_reconciled = true when signed balance matches calculator');
    expect(Array.isArray(opData.reconciliation.discrepancy_reasons), 'GF-F03 discrepancy_reasons is an array');
    expect(opData.reconciliation.discrepancy_reasons.length === 0, 'GF-F03 discrepancy_reasons is empty when signed balances match');

    // 13C. Adversarial test: simulate discrepancy and verify GF-F03 flags is_reconciled = false with reasons
    await pool.query(`UPDATE folio_entries SET amount = amount + 50000 WHERE id = $1`, [fnbEntryId]);
    const corruptedFolioRes = await getDocumentGuestFolio(pool, propId, resId2, { user: saUser });
    expect(corruptedFolioRes.data.reconciliation.is_reconciled === false, 'GF-F03 detects reconciliation discrepancy when balance corrupted');
    expect(corruptedFolioRes.data.reconciliation.discrepancy_reasons.length > 0, 'GF-F03 discrepancy_reasons populated with diagnostic reasons');
    // Restore entry
    await pool.query(`UPDATE folio_entries SET amount = amount - 50000 WHERE id = $1`, [fnbEntryId]);

    // Check DB Inventory Invariants (AGENTS.md Section 5)
    const negInv = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM availability_dates WHERE reserved_qty < 0`
    );
    const overInv = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM availability_dates WHERE reserved_qty > total_rooms`
    );
    expect(negInv.rows[0].cnt === 0, 'DB Invariant: count of reserved_qty < 0 is 0');
    expect(overInv.rows[0].cnt === 0, 'DB Invariant: count of reserved_qty > total_rooms is 0');

    console.log('\n==================================================================');
    console.log(`  ALL ${passed} ASSERTIONS PASSED (${failed} FAILED)`);
    console.log('==================================================================\n');
  } finally {
    let flagRestoreErr = null;
    let fixtureCleanupErr = null;

    if (isPreflightVerified) {
      // GF-F04: Faithfully restore exact initial feature flag state only if modified
      if (featureFlagModified) {
        try {
          if (hadOriginalFlag) {
            await setFeatureFlag(pool, propId, 'documents.enabled', originalDocFeatureEnabled, 'E2E_Cleanup');
          } else {
            await pool.query(
              `DELETE FROM property_features WHERE property_id = $1 AND feature_key = 'documents.enabled'`,
              [propId]
            );
          }
        } catch (flagErr) {
          flagRestoreErr = flagErr;
          console.error('[CLEANUP] Feature flag restore error:', flagErr);
        }
      }

      // Full deterministic fixture cleanup leaving ZERO residue
      if (
        createdReservationIds.size > 0 ||
        createdBookingIds.size > 0 ||
        createdDepositIds.size > 0 ||
        createdUserIds.size > 0 ||
        createdRoleIds.size > 0 ||
        createdGuestIds.size > 0
      ) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const resIds = Array.from(createdReservationIds);
          const bookIds = Array.from(createdBookingIds);
          const depIds = Array.from(createdDepositIds);
          const uIds = Array.from(createdUserIds);
          const rIds = Array.from(createdRoleIds);

          if (resIds.length > 0) {
            const resRows = await client.query(
              `SELECT id, booked_room_type_id_snapshot, check_in, check_out, status
               FROM reservations WHERE id = ANY($1::int[])`,
              [resIds]
            );
            for (const row of resRows.rows) {
              if (['BOOKED', 'CHECKED_IN'].includes(row.status)) {
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
            }

            await client.query(
              `DELETE FROM deposit_events WHERE reservation_id = ANY($1::int[]) OR deposit_id = ANY($2::int[])`,
              [resIds, depIds]
            );
            await client.query(
              `DELETE FROM deposits WHERE reservation_id = ANY($1::int[]) OR id = ANY($2::int[])`,
              [resIds, depIds]
            );

            await client.query(`DELETE FROM transactions WHERE reservation_id = ANY($1::int[])`, [resIds]);
            await client.query(`DELETE FROM payment_allocations WHERE reservation_id = ANY($1::int[])`, [resIds]);
            await client.query(`DELETE FROM payment_evidences WHERE reservation_id = ANY($1::int[])`, [resIds]);
            await client.query(`DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])`, [resIds]);
            if (bookIds.length > 0) {
              await client.query(`DELETE FROM payment_transactions WHERE booking_id = ANY($1::int[])`, [bookIds]);
            }
            await client.query(`DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])`, [resIds]);
            await client.query(`DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1::int[])`, [resIds]);
            await client.query(`DELETE FROM reservation_guests WHERE reservation_id = ANY($1::int[])`, [resIds]);
            await client.query(
              `DELETE FROM audit_logs WHERE entity = 'RESERVATION' AND record_id = ANY($1::text[])`,
              [resIds.map(String)]
            );
            await client.query(`DELETE FROM reservations WHERE id = ANY($1::int[])`, [resIds]);
          }

          if (bookIds.length > 0) {
            await client.query(
              `DELETE FROM audit_logs WHERE entity = 'BOOKING' AND record_id = ANY($1::text[])`,
              [bookIds.map(String)]
            );
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

          if (uIds.length > 0) {
            await client.query(`DELETE FROM user_permission_overrides WHERE user_id = ANY($1::int[])`, [uIds]);
            await client.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [uIds]);
          }
          if (rIds.length > 0) {
            await client.query(`DELETE FROM role_permissions WHERE role_id = ANY($1::int[])`, [rIds]);
            await client.query(`DELETE FROM roles WHERE id = ANY($1::int[])`, [rIds]);
          }

          await client.query('COMMIT');
          console.log('[CLEANUP] All Guest Folio E2E test fixtures cleaned up with zero residue.');
        } catch (cleanupErr) {
          await client.query('ROLLBACK');
          fixtureCleanupErr = cleanupErr;
          console.error('[CLEANUP ERROR] Failed to clean up fixtures:', cleanupErr);
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

    if (flagRestoreErr || fixtureCleanupErr) {
      const compositeErr = new Error(
        `E2E Suite Cleanup Failed! flagRestoreErr: ${flagRestoreErr?.message || 'none'}; fixtureCleanupErr: ${fixtureCleanupErr?.message || 'none'}`
      );
      compositeErr.flagRestoreErr = flagRestoreErr;
      compositeErr.fixtureCleanupErr = fixtureCleanupErr;
      throw compositeErr;
    }
  }
}

function bootstrapModules() {
  if (pool) return { pool, app };
  const dist = require('../dist/index');
  pool = dist.pool;
  app = dist.app;
  initializeDatabase = require('../dist/db/schema_v3').initializeDatabase;
  generateToken = require('../dist/domains/auth/authService').generateToken;
  const depService = require('../dist/domains/deposits/depositService');
  receiveDeposit = depService.receiveDeposit;
  applyDeposit = depService.applyDeposit;
  unapplyDeposit = depService.unapplyDeposit;
  getDepositsByReservation = depService.getDepositsByReservation;
  const stayService = require('../dist/domains/stayCharges/stayChargesService');
  recalculateReservationFinancials = stayService.recalculateReservationFinancials;
  voidFolioEntry = stayService.voidFolioEntry;
  const accessService = require('../dist/domains/settings/accessControlService');
  ACCESS_RESOURCES = accessService.ACCESS_RESOURCES;
  setRoleAccess = accessService.setRoleAccess;
  setFeatureFlag = require('../dist/domains/features/featureService').setFeatureFlag;
  return { pool, app };
}

runE2ETests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Guest Folio E2E Suite Failed:', err);
    process.exit(1);
  });
