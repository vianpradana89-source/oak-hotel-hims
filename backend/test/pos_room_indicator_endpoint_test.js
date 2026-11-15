/**
 * POS ROOM INDICATOR — Endpoint Integration (Kerangka)
 *
 * Uji HTTP /api/transactions GET untuk memverifikasi:
 *   1. User dengan permission pos.view menerima pos_order_count / pos_open_count.
 *   2. User tanpa pos.view tetap dapat membaca Penjualan, tetapi kedua field
 *      statistik TIDAK ADA di child rows.
 *   3. User tanpa pos.view + query includePosStats=true → statistik TIDAK
 *      diberikan (fail-closed, tidak dapat di-inject oleh client).
 *
 * DB safety guard (tanpa dotenv / fallback apa pun):
 *   - TEST_DATABASE_URL eksplisit: postgres://, 127.0.0.1, port 15434,
 *     database oak_minibar_test, user minibar_test, password wajib.
 *   - Tanpa query parameter. Tidak mencetak password/URL.
 *   - Pool dibuat dari field eksplisit hasil parse URL (bukan connectionString).
 *   - Verifikasi pool.options (eksak) + current_database()/current_user()
 *     sebelum mutasi apa pun.
 *
 * Run:
 *   TEST_DATABASE_URL=postgres://USER:PASS@127.0.0.1:15434/oak_minibar_test \
 *   node backend/test/pos_room_indicator_endpoint_test.js
 */

'use strict';

// ─── 1. DB SAFETY GUARD (tanpa dotenv/fallback) ──────────────────────────────
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !testUrl.trim()) {
  console.error(
    'SAFETY: TEST_DATABASE_URL tidak di-set.\n' +
    'Jalankan: TEST_DATABASE_URL=postgres://USER:PASS@127.0.0.1:15434/oak_minibar_test ' +
    'node backend/test/pos_room_indicator_endpoint_test.js'
  );
  process.exit(1);
}

const ALLOWED_HOST = '127.0.0.1';
const ALLOWED_PORT = 15434;
const ALLOWED_DATABASE = 'oak_minibar_test';
const ALLOWED_USER = 'minibar_test';
const FORBIDDEN = ['staging', 'production', 'prod', 'live'];

let target;
try {
  const u = new URL(testUrl.trim());
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new Error('protocol wajib postgres/postgresql');
  }
  if (u.hostname !== ALLOWED_HOST) {
    throw new Error(`host wajib ${ALLOWED_HOST} (diterima: ${u.hostname})`);
  }
  if (u.searchParams.size > 0) {
    throw new Error('query parameter tidak didukung');
  }
  if (!u.port || !/^\d+$/.test(u.port)) {
    throw new Error('port eksplisit wajib');
  }
  const port = Number(u.port);
  if (port !== ALLOWED_PORT) {
    throw new Error(`port wajib ${ALLOWED_PORT} (diterima: ${port})`);
  }
  const user = u.username ? decodeURIComponent(u.username) : '';
  const password = u.password ? decodeURIComponent(u.password) : '';
  const database = u.pathname ? decodeURIComponent(u.pathname.replace(/^\//, '')) : '';
  if (!user) throw new Error('user wajib lengkap');
  if (!password) throw new Error('password wajib lengkap');
  if (user !== ALLOWED_USER) {
    throw new Error(`user wajib ${ALLOWED_USER} (diterima: ${user})`);
  }
  if (database !== ALLOWED_DATABASE) {
    throw new Error(`database wajib ${ALLOWED_DATABASE} (diterima: ${database})`);
  }
  if (FORBIDDEN.some((p) => database.toLowerCase().includes(p))) {
    throw new Error('indikator staging/production/live terdeteksi');
  }
  target = { host: u.hostname, port, user, database, password };
  console.log(
    `[POS ROOM INDICATOR ENDPOINT] Target DB: ${database} (user: ${user}, port: ${port})`
  );
} catch (e) {
  console.error('SAFETY: TEST_DATABASE_URL ditolak — ' + e.message);
  process.exit(1);
}

// ─── 2. Pool dari field eksplisit ─────────────────────────────────────────────
const { Pool, PoolClient } = require('pg');
const http = require('http');
const express = require('express');

const pool = new Pool({
  host: target.host,
  port: target.port,
  user: target.user,
  password: target.password,
  database: target.database,
  max: 5,
});

// ─── 3. Import HANYA dari dist — TANPA app/index, migration, atau service pembayaran ─
const { createTransactionsRouter } = require('../dist/domains/transactions/transactionsRouter');
const { generateToken, getUserEffectivePermissions } = require('../dist/domains/auth/authService');

// ─── 4. Counter PASS/FAIL + tracking fixture ──────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];
let identityVerified = false;

function ok(label, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ' — ' + detail : ''}`);
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  }
}

// Tracking ID fixture untuk cleanup.
const tracked = {};
function track(key, id) {
  if (!tracked[key]) tracked[key] = [];
  if (id != null) tracked[key].push(id);
}

// ─── 5. Helper: listen server lokal + HTTP GET ────────────────────────────────
function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

/**
 * GET /api/transactions?property_id=...&transaction_type=SALE&includePosStats=true
 * @param {number} port
 * @param {string} urlPath  — path relatif (tanpa host), mis. '/api/transactions?property_id=1'
 * @param {string|null} token — Bearer token atau null
 * @returns {Promise<{status:number, json:any}>}
 */
function get(port, urlPath, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'GET',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          let json = null;
          const body = Buffer.concat(chunks).toString('utf8');
          try { json = JSON.parse(body); } catch (_) { /* ignore */ }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ─── 6. Kontrak permission (dikonfirmasi dari route + schema) ────────────────
//
// KONEK PERMISSIAN AKTUAL:
//
//   Permission key: 'pos.view'
//   Sumber: backend/src/domains/transactions/transactionsRouter.ts:211
//           permKeys.includes('pos.view')
//   Seeding:  backend/src/migrations/schema_v3.ts (resource 'pos' × action 'view')
//   AccessControl: backend/src/domains/auth/accessControlService.ts
//           POS: { view: ['pos.view'], ... }
//
//   Role bawaan yang memiliki 'pos.view' (schema_v3.ts):
//     - Front Office
//     - POS / Resto
//
//   Untuk fixture test:
//     1. INSERT roles (property_id, name, is_active, is_system_role, is_test_data)
//     2. INSERT role_permissions (role_id, permission_id, granted)
//        → SELECT p.id FROM permissions p WHERE p.key = 'pos.view'
//     3. INSERT users (property_id, role_id, username, email, password_hash,
//                      full_name, is_active, is_test_data)
//     4. generateToken({ id, username, full_name, role, role_id,
//                        property_id, scope: 'FULL', access_type: 'PMS_STAFF' })
//
//   NOTE: password_hash diset 'x' — test memakai generateToken langsung,
//   bypass login flow. is_test_data=TRUE menandai fixture untuk cleanup.

// ─── 7. Helper fixture: property / role / user ───────────────────────────────
//
// Identifier unik per run: RUN_ID dibuat satu kali di level modul,
// lalu setiap helper menghasilkan identifier unik berdasarkan RUN_ID
// + counter base36 3 karakter.

// RUN_ID: prefix acak per run (6 karakter alphanumeric).
const RUN_ID =
  Date.now().toString(36).slice(-4) +
  Math.random().toString(36).slice(2, 6);

// Prefix acak 3 karakter (A-Z0-9) SEKALI per run, dibuat dengan crypto.
const crypto = require('crypto');
const PROP_CODE_PREFIX =
  crypto.randomBytes(12).toString('hex').toUpperCase().slice(0, 3);

// Counter base36 untuk property_code / role / user identifiers.
let _propCounter = 0;
let _roleCounter = 0;
let _userCounter = 0;

function nextPropCode() {
  // property_code = prefix(3, A-Z0-9) + counter base36(3, uppercase, zero-padded).
  // Total 6 karakter. Throw bila counter mencapai batas 36³.
  _propCounter++;
  if (_propCounter >= 36 ** 3) {
    throw new Error(
      `nextPropCode: counter mencapai batas 36³ (${_propCounter}). ` +
      `Tidak cukup ruang unik untuk prefix '${PROP_CODE_PREFIX}'.`
    );
  }
  const counterPart = _propCounter.toString(36).toUpperCase().padStart(3, '0');
  const code = PROP_CODE_PREFIX + counterPart;
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    throw new Error(
      `nextPropCode: hasil '${code}' tidak valid (harus 6 karakter A-Z0-9).`
    );
  }
  return code;
}

function nextRoleName(label) {
  _roleCounter++;
  const suffix = _roleCounter.toString(36).toUpperCase().padStart(3, '0');
  return `PRIM_${label}_${RUN_ID.slice(0, 4)}_${suffix}`;
}

function nextUserName(label) {
  _userCounter++;
  const suffix = _userCounter.toString(36).toUpperCase().padStart(3, '0');
  return `prim_${label}_${RUN_ID.slice(0, 4)}_${suffix}`;
}

/**
 * Buat property fixture.
 * Kolom aktual: name, property_code, timezone, currency_code, is_active.
 * INSERT biasa tanpa ON CONFLICT. property_code unik 6 karakter.
 * @param {import('pg').PoolClient} client
 * @returns {Promise<number>} property id
 */
async function createFixtureProperty(client) {
  const propCode = nextPropCode();
  const q = await client.query(
    `INSERT INTO properties (name, property_code, timezone, currency_code, is_active)
     VALUES ($1, $2, 'Asia/Jakarta', 'IDR', TRUE) RETURNING id`,
    [`PRIM ${RUN_ID} ${propCode}`, propCode]
  );
  const id = Number(q.rows[0].id);
  track('properties', id);
  return id;
}

/**
 * Buat role fixture (bukan super-admin, bukan system role).
 * Jika canViewPos=true, grant permission 'pos.view' existing via
 * role_permissions (tanpa INSERT/UPDATE ke tabel permissions).
 * Jika permission pos.view tidak ditemukan, throw — jangan seed.
 * @param {import('pg').PoolClient} client
 * @param {number} propertyId
 * @param {boolean} canViewPos
 * @returns {Promise<number>} role id
 */
async function createFixtureRole(client, propertyId, canViewPos) {
  const roleName = nextRoleName(canViewPos ? 'POS_VIEW' : 'NO_POS_VIEW');
  const q = await client.query(
    `INSERT INTO roles (property_id, name, description, is_active, is_system_role, is_test_data)
     VALUES ($1, $2, $3, TRUE, FALSE, TRUE) RETURNING id`,
    [propertyId, roleName, `PRIM fixture role ${roleName}`]
  );
  const roleId = Number(q.rows[0].id);
  track('roles', roleId);

  if (canViewPos) {
    // Cari permission 'pos.view' yang sudah di-seed oleh schema.
    const permQ = await client.query(
      `SELECT id FROM permissions WHERE key = $1 LIMIT 1`,
      ['pos.view']
    );
    if (permQ.rows.length === 0) {
      // Hapus role yang baru dibuat untuk menghindari residu.
      await client.query(`DELETE FROM roles WHERE id = $1`, [roleId]);
      const err = new Error(
        `FIXTURE: permission 'pos.view' tidak ditemukan di tabel permissions. ` +
        `Seeding belum dijalankan? Jangan seed dari test — fail eksplisit.`
      );
      err.fixture = true;
      throw err;
    }
    const permId = Number(permQ.rows[0].id);
    await client.query(
      `INSERT INTO role_permissions (role_id, permission_id, granted, created_by)
       VALUES ($1, $2, TRUE, 'PRIM_TEST')`,
      [roleId, permId]
    );
    track('rolePermissions', roleId);
  }
  // Role tanpa canViewPos tidak diberi izin apa pun.

  return roleId;
}

/**
 * Buat user fixture aktif.
 * Kolom aktual: property_id, role_id, username, email, password_hash,
 *               full_name, is_active, is_test_data.
 * password_hash='x' (bypass login, token dibuat langsung via generateToken).
 * @param {import('pg').PoolClient} client
 * @param {number} propertyId
 * @param {number} roleId
 * @returns {Promise<{id: number, username: string, full_name: string}>}
 */
async function createFixtureUser(client, propertyId, roleId) {
  const username = nextUserName('USER');
  const email = `${username}@prim.test.local`;
  const fullName = `PRIM ${username}`;
  const q = await client.query(
    `INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active, is_test_data)
     VALUES ($1, $2, $3, $4, 'x', $5, TRUE, TRUE)
     RETURNING id, username, full_name`,
    [propertyId, roleId, username, email, fullName]
  );
  const row = q.rows[0];
  const userId = Number(row.id);
  track('users', userId);
  return {
    id: userId,
    username: row.username,
    full_name: row.full_name,
  };
}

// ─── Counter tambahan untuk identifier tx / bid / pos order ──────────────────
let _bidCounter = 0;
let _txNoCounter = 0;
let _orderNoCounter = 0;

function nextBid() {
  _bidCounter++;
  const n = _bidCounter.toString(36).toUpperCase().padStart(3, '0');
  return `BID${PROP_CODE_PREFIX}${n}`;
}

function nextTxNo() {
  _txNoCounter++;
  const n = _txNoCounter.toString(36).toUpperCase().padStart(3, '0');
  return `TX${PROP_CODE_PREFIX}${n}`;
}

function nextOrderNumber() {
  _orderNoCounter++;
  const n = _orderNoCounter.toString(36).toUpperCase().padStart(3, '0');
  return `PO${PROP_CODE_PREFIX}${n}`;
}

// ─── Helper fixture: chain reservasi ──────────────────────────────────────────

/**
 * Buat chain reservasi terkait:
 *   room_categories → room_types → rooms → bookings → reservations →
 *   folio ROOM_CHARGE nyata (500000).
 *
 * property_id reservasi diturunkan dari bookings.property_id
 * (reservations TIDAK punya kolom property_id).
 *
 * BID dibuat saat INSERT bookings & dikembalikan — JANGAN di-UPDATE
 * setelahnya (trigger immutable).
 *
 * @param {import('pg').PoolClient} client
 * @param {number} propertyId
 * @returns {Promise<{
 *   roomCategory: number,
 *   roomType: number,
 *   room: number,
 *   bookingId: string,
 *   reservationId: number,
 *   bid: string,
 *   folioEntryId: number,
 * }>}
 */
async function createReservationChain(client, propertyId) {
  const guestName = `PRIM Guest ${RUN_ID}`;

  // 1) room_categories
  const rcQ = await client.query(
    `INSERT INTO room_categories (property_id, code, name)
     VALUES ($1, $2, $2) RETURNING id`,
    [propertyId, `RC-${RUN_ID}-${_propCounter}`.slice(0, 50)]
  );
  const roomCategoryId = Number(rcQ.rows[0].id);
  track('roomCategories', roomCategoryId);

  // 2) room_types
  const rtQ = await client.query(
    `INSERT INTO room_types (
       property_id, code, name, room_category_id, capacity,
       max_adults, max_children, is_active, display_order, base_rate
     ) VALUES ($1, $2, $2, $3, 2, 2, 0, TRUE, 1, 500000) RETURNING id`,
    [propertyId, `RT-${RUN_ID}-${_propCounter}`.slice(0, 50), roomCategoryId]
  );
  const roomTypeId = Number(rtQ.rows[0].id);
  track('roomTypes', roomTypeId);

  // 3) rooms
  const rmQ = await client.query(
    `INSERT INTO rooms (property_id, room_number, room_type_id, is_active)
     VALUES ($1, $2, $3, TRUE) RETURNING id`,
    [propertyId, `R-${RUN_ID}-${_propCounter}`.slice(0, 10), roomTypeId]
  );
  const roomId = Number(rmQ.rows[0].id);
  track('rooms', roomId);

  // 4) bookings — BID dibuat saat INSERT, tidak diubah setelahnya.
  const bid = nextBid();
  const bkQ = await client.query(
    `INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status)
     VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [bid, propertyId, guestName]
  );
  const bookingId = String(bkQ.rows[0].id); // BIGINT → string
  track('bookings', bookingId);

  // 5) reservations
  // reservations TIDAK punya kolom property_id — properti diturunkan
  // via bookings.property_id.
  const rsQ = await client.query(
    `INSERT INTO reservations (
       booking_id, room_id, status, stay_status,
       check_in, check_out, guest_name, stay_sequence,
       total_price, amount_paid, remaining_balance, payment_status
     )
     VALUES ($1, $2, 'BOOKED', 'RESERVED',
             CURRENT_DATE, CURRENT_DATE + 2, $3, 1,
             500000, 0, 500000, 'UNPAID')
     RETURNING id`,
    [bookingId, roomId, guestName]
  );
  const reservationId = Number(rsQ.rows[0].id);
  track('reservations', reservationId);

  // 6) folio ROOM_CHARGE nyata sebesar 500000
  const feQ = await client.query(
    `INSERT INTO folio_entries (
       reservation_id, property_id, entry_type, source_type, description,
       amount, direction, status
     ) VALUES (
       $1, $2, 'ROOM_CHARGE', 'ROOM_CHARGE',
       'PRIM fixture ROOM_CHARGE', 500000, 'DEBIT', 'POSTED'
     ) RETURNING id`,
    [reservationId, propertyId]
  );
  const folioEntryId = Number(feQ.rows[0].id);
  track('folioEntries', folioEntryId);

  return {
    roomCategory: roomCategoryId,
    roomType: roomTypeId,
    room: roomId,
    bookingId,
    reservationId,
    bid,
    folioEntryId,
  };
}

// ─── Helper fixture: room SALE transaction ───────────────────────────────────

/**
 * Buat SALE ROOM_CHARGE transaction terkait folio entry.
 *
 * Kontrak:
 *   - amount / net_amount = 500000
 *   - source_type = 'ROOM_CHARGE'
 *   - source_id   = String(folioEntryId)  (identitas folio entry)
 *   - category_code = 'ROOM_SALES'
 *   - department_code = 'FRONT_OFFICE'
 *   - INSERT biasa RETURNING id, tanpa ON CONFLICT / fallback.
 *
 * @param {import('pg').PoolClient} client
 * @param {number} propertyId
 * @param {object} chain  Return value dari createReservationChain.
 * @returns {Promise<string>} transaction id (BIGINT → string)
 */
async function createRoomSaleTransaction(client, propertyId, chain) {
  const txNo = nextTxNo();
  const srcId = String(chain.folioEntryId);
  const srcRef = chain.bid ? `RES-${chain.reservationId}` : `RES-${chain.reservationId}`;
  const q = await client.query(
    `INSERT INTO transactions (
       property_id, transaction_no, transaction_date, transaction_time,
       transaction_type, source_type, source_id, source_reference,
       category_code, category_name, department_code, description,
       amount, discount_amount, service_amount, tax_amount, net_amount,
       payment_status, payment_method, transaction_status,
       reservation_id, booking_id, created_by
     )
     VALUES (
       $1, $2, CURRENT_DATE, CURRENT_TIMESTAMP,
       'SALE', 'ROOM_CHARGE', $3, $4,
       'ROOM_SALES', 'Kamar', 'FRONT_OFFICE', 'Pembayaran Kamar',
       500000, 0, 0, 0, 500000,
       'UNPAID', NULL, 'POSTED',
       $5, $6, 'PRIM_TEST'
     ) RETURNING id`,
    [propertyId, txNo, srcId, srcRef, chain.reservationId, chain.bookingId]
  );
  const txId = String(q.rows[0].id); // BIGINT → string
  track('transactions', txId);
  return txId;
}

// ─── Helper fixture: POS order ───────────────────────────────────────────────

/**
 * Buat POS order OPEN, total_amount = 25000.
 * Tanpa SALE POS, settlement, atau pembayaran.
 *
 * Kolom aktual: property_id, order_number, status, total_amount, reservation_id.
 * @param {import('pg').PoolClient} client
 * @param {number} propertyId
 * @param {number} reservationId
 * @returns {Promise<number>} pos_orders id
 */
async function createFixturePosOrder(client, propertyId, reservationId) {
  const orderNumber = nextOrderNumber();
  const q = await client.query(
    `INSERT INTO pos_orders (property_id, order_number, status, total_amount, reservation_id)
     VALUES ($1, $2, 'OPEN', 25000, $3) RETURNING id`,
    [propertyId, orderNumber, reservationId]
  );
  const id = Number(q.rows[0].id);
  track('posOrders', id);
  return id;
}

// ─── Helper cleanup: hapus seluruh fixture run ini ──────────────────────────

/**
 * Hapus seluruh artefak fixture dari run ini, dalam satu transaksi.
 *
 * Syarat:
 *   - identityVerified harus true — menolak membersihkan DB yang belum
 *     terverifikasi sebagai target test.
 *   - DELETE dibatasi pada ID/property/role/user fixture run ini
 *     (tracked registry + parameter property/role/user IDs).
 *   - Urutan FK: anak sebelum parent.
 *   - BEGIN / COMMIT; ROLLBACK bila gagal.
 *   - Tidak menyentuh tabel `permissions` atau role/user existing.
 *
 * @param {import('pg').PoolClient} cleanupClient — client DEDIKASI (bukan
 *     client yang sama dengan mutasi main, agar cleanup tetap bisa jalan
 *     walau client utama sudah error).
 * @returns {Promise<{error: (string | null)}>} — null = sukses, string = pesan error.
 */
async function cleanupFixtures(cleanupClient) {
  if (!identityVerified) {
    const err = 'cleanupFixtures: identityVerified=false — menolak eksekusi DELETE tanpa verifikasi DB.';
    console.error(`  ERROR ${err}`);
    return { error: err };
  }

  try {
    await cleanupClient.query('BEGIN');

    // ── 1. Artefak pembayaran / settlement (hapus SEBELUM transactions/orders)
    //     FK: pos_settlements.transaction_id → transactions(id) RESTRICT
    //         pos_settlements.pos_order_id → pos_orders(id) RESTRICT
    //     FK: payment_transactions.reservation_id → reservations(id)
    //         payment_transactions.booking_id → bookings(id) RESTRICT
    //     Dibatasi properti fixture tracked — parameter SQL, bukan hard-coded.
    if (tracked.properties && tracked.properties.length > 0) {
      const propIds = tracked.properties;
      // pos_settlements — lewat property_id (tabel punya kolom ini)
      await cleanupClient.query(
        `DELETE FROM pos_settlements WHERE property_id = ANY($1::int[])`,
        [propIds]
      );
      // payment_transactions — lewat property_id
      await cleanupClient.query(
        `DELETE FROM payment_transactions WHERE property_id = ANY($1::int[])`,
        [propIds]
      );
    }

    // ── 2. transactions (SALE ROOM_CHARGE / SALE POS_ORDER) ────────────────
    //     FK: transactions.property_id → properties(id) RESTRICT
    //     FK: transactions.reservation_id → reservations(id) SET NULL
    //     FK: transactions.booking_id → bookings(id) SET NULL
    if (tracked.transactions && tracked.transactions.length > 0) {
      await cleanupClient.query(
        `DELETE FROM transactions WHERE id = ANY($1::bigint[])`,
        [tracked.transactions]
      );
    }

    // ── 3. pos_orders ────────────────────────────────────────────────────────
    //     FK: pos_orders.property_id → properties(id)
    //     FK: pos_orders.reservation_id → reservations(id)
    if (tracked.posOrders && tracked.posOrders.length > 0) {
      await cleanupClient.query(
        `DELETE FROM pos_orders WHERE id = ANY($1::int[])`,
        [tracked.posOrders]
      );
    }

    // ── 4. folio_entries ────────────────────────────────────────────────────
    //     FK: folio_entries.reservation_id → reservations(id)
    //     FK: folio_entries.property_id → properties(id)
    if (tracked.folioEntries && tracked.folioEntries.length > 0) {
      await cleanupClient.query(
        `DELETE FROM folio_entries WHERE id = ANY($1::int[])`,
        [tracked.folioEntries]
      );
    }

    // ── 5. reservations ─────────────────────────────────────────────────────
    //     FK: reservations.booking_id → bookings(id)
    //     FK: reservations.room_id → rooms(id)
    if (tracked.reservations && tracked.reservations.length > 0) {
      await cleanupClient.query(
        `DELETE FROM reservations WHERE id = ANY($1::int[])`,
        [tracked.reservations]
      );
    }

    // ── 6. bookings ─────��───────────────────────────────────────────────────
    //     FK: bookings.property_id → properties(id)
    //     bookingId BIGINT → string dalam tracked
    if (tracked.bookings && tracked.bookings.length > 0) {
      await cleanupClient.query(
        `DELETE FROM bookings WHERE id = ANY($1::bigint[])`,
        [tracked.bookings]
      );
    }

    // ── 7. rooms → room_types → room_categories ────────────────────────────
    //     rooms.room_type_id → room_types(id)
    //     room_types.room_category_id → room_categories(id)
    //     room_types.property_id → properties(id)
    //     room_categories.property_id → properties(id)
    if (tracked.rooms && tracked.rooms.length > 0) {
      await cleanupClient.query(
        `DELETE FROM rooms WHERE id = ANY($1::int[])`,
        [tracked.rooms]
      );
    }
    if (tracked.roomTypes && tracked.roomTypes.length > 0) {
      await cleanupClient.query(
        `DELETE FROM room_types WHERE id = ANY($1::int[])`,
        [tracked.roomTypes]
      );
    }
    if (tracked.roomCategories && tracked.roomCategories.length > 0) {
      await cleanupClient.query(
        `DELETE FROM room_categories WHERE id = ANY($1::int[])`,
        [tracked.roomCategories]
      );
    }

    // ── 8. user_permission_overrides → users → role_permissions → roles ───
    //     user_permission_overrides: FK user_id → users(id) CASCADE
    //     users: FK role_id → roles(id), FK property_id → properties(id)
    //     role_permissions: PK id SERIAL (TIDAK composite key).
    //       UNIQUE (role_id, permission_id) tapi PRIMARY KEY adalah id.
    //       FK: role_id → roles(id) CASCADE
    //       FK: permission_id → permissions(id) CASCADE
    //     roles: FK property_id → properties(id)
    if (tracked.users && tracked.users.length > 0) {
      await cleanupClient.query(
        `DELETE FROM user_permission_overrides WHERE user_id = ANY($1::int[])`,
        [tracked.users]
      );
      await cleanupClient.query(
        `DELETE FROM users WHERE id = ANY($1::int[])`,
        [tracked.users]
      );
    }
    // role_permissions: PK = id SERIAL (bukan composite key).
    //     Kami track roleId saat INSERT; untuk cleanup aman cukup
    //     DELETE by role_id karena role fixture bukan system/super-admin.
    if (tracked.rolePermissions && tracked.rolePermissions.length > 0) {
      await cleanupClient.query(
        `DELETE FROM role_permissions WHERE role_id = ANY($1::int[])`,
        [tracked.rolePermissions]
      );
    }
    if (tracked.roles && tracked.roles.length > 0) {
      await cleanupClient.query(
        `DELETE FROM roles WHERE id = ANY($1::int[])`,
        [tracked.roles]
      );
    }

    // ── 9. audit_logs + transaction_daily_sequences (sebelum properties) ──
    //     FK: audit_logs.property_id → properties(id) ON DELETE RESTRICT
    //     FK: transaction_daily_sequences.property_id → properties(id) CASCADE
    //     Dibatasi property fixture tracked.
    if (tracked.properties && tracked.properties.length > 0) {
      await cleanupClient.query(
        `DELETE FROM audit_logs WHERE property_id = ANY($1::int[])`,
        [tracked.properties]
      );
      await cleanupClient.query(
        `DELETE FROM transaction_daily_sequences WHERE property_id = ANY($1::int[])`,
        [tracked.properties]
      );
    }

    // ── 10. properties ───────────────────────────────────────────────────────
    if (tracked.properties && tracked.properties.length > 0) {
      await cleanupClient.query(
        `DELETE FROM properties WHERE id = ANY($1::int[])`,
        [tracked.properties]
      );
    }

    await cleanupClient.query('COMMIT');
    return { error: null };
  } catch (e) {
    await cleanupClient.query('ROLLBACK').catch(() => { /* ROLLBACK sendiri gagal */ });
    const err = `cleanupFixtures: ${e.message}`;
    console.error(`  ERROR ${err}`);
    return { error: err };
  }
}

// ─── Helper residu: verifikasi seluruh ID fixture sudah hilang ──────────────

/**
 * Periksa seluruh ID yang di-track dan relasi fixture yang relevan.
 * Return daftar string residu (empty = bersih).
 * Query gagal → throw (bukan swallow).
 *
 * Cakupan:
 *   - payment_transactions (via tracked reservations/bookings/properties)
 *   - pos_settlements (via tracked posOrders)
 *   - transactions (via tracked transactions)
 *   - pos_orders (via tracked posOrders)
 *   - folio_entries (via tracked folioEntries)
 *   - reservations (via tracked reservations)
 *   - bookings (via tracked bookings)
 *   - rooms, room_types, room_categories
 *   - user_permission_overrides (via tracked users)
 *   - users (via tracked users)
 *   - role_permissions (via tracked rolePermissions/roles)
 *   - roles (via tracked roles)
 *   - properties (via tracked properties)
 *
 * Catatan: JANGAN menganggap bersih hanya karena parent sudah dihapus.
 *         FK CASCADE/RESTRICT bisa menyisakan anak bila cleanup di-ROLLBACK.
 *
 * @param {import('pg').PoolClient} client
 * @returns {Promise<string[]>} daftar residu; empty array = bersih.
 */
async function verifyNoResidue(client) {
  const residue = [];

  const has = (key) => tracked[key] && tracked[key].length > 0;

  // payment_transactions — lewat reservation_id / booking_id
  if (has('reservations') || has('bookings')) {
    const q = await client.query(
      `SELECT COUNT(*) AS c FROM payment_transactions
       WHERE reservation_id = ANY($1::int[]) OR booking_id = ANY($2::bigint[])`,
      [has('reservations') ? tracked.reservations : [0],
       has('bookings') ? tracked.bookings : ['0']]
    );
    if (Number(q.rows[0].c) > 0) residue.push(`payment_transactions (${q.rows[0].c} baris)`);
  }

  // pos_settlements — lewat pos_order_id
  if (has('posOrders')) {
    const q = await client.query(
      `SELECT COUNT(*) AS c FROM pos_settlements WHERE pos_order_id = ANY($1::int[])`,
      [tracked.posOrders]
    );
    if (Number(q.rows[0].c) > 0) residue.push(`pos_settlements (${q.rows[0].c} baris)`);
  }

  // transactions
  if (has('transactions')) {
    const q = await client.query(
      `SELECT COUNT(*) AS c FROM transactions WHERE id = ANY($1::bigint[])`,
      [tracked.transactions]
    );
    if (Number(q.rows[0].c) > 0) residue.push(`transactions (${q.rows[0].c} baris)`);
  }

  // pos_orders
  if (has('posOrders')) {
    const q = await client.query(
      `SELECT COUNT(*) AS c FROM pos_orders WHERE id = ANY($1::int[])`,
      [tracked.posOrders]
    );
    if (Number(q.rows[0].c) > 0) residue.push(`pos_orders (${q.rows[0].c} baris)`);
  }

  // folio_entries
  if (has('folioEntries')) {
    const q = await client.query(
      `SELECT COUNT(*) AS c FROM folio_entries WHERE id = ANY($1::int[])`,
      [tracked.folioEntries]
    );
    if (Number(q.rows[0].c) > 0) residue.push(`folio_entries (${q.rows[0].c} baris)`);
  }

  // reservations
  if (has('reservations')) {
    const q = await client.query(
      `SELECT COUNT(*) AS c FROM reservations WHERE id = ANY($1::int[])`,
      [tracked.reservations]
    );
    if (Number(q.rows[0].c) > 0) residue.push(`reservations (${q.rows[0].c} baris)`);
  }

  // bookings
  if (has('bookings')) {
    const q = await client.query(
      `SELECT COUNT(*) AS c FROM bookings WHERE id = ANY($1::bigint[])`,
      [tracked.bookings]
    );
    if (Number(q.rows[0].c) > 0) residue.push(`bookings (${q.rows[0].c} baris)`);
  }

  // rooms / room_types / room_categories
  if (has('rooms')) {
    const q = await client.query(
      `SELECT COUNT(*) AS c FROM rooms WHERE id = ANY($1::int[])`,
      [tracked.rooms]
    );
    if (Number(q.rows[0].c) > 0) residue.push(`rooms (${q.rows[0].c} baris)`);
  }
  if (has('roomTypes')) {
    const q = await client.query(
      `SELECT COUNT(*) AS c FROM room_types WHERE id = ANY($1::int[])`,
      [tracked.roomTypes]
    );
    if (Number(q.rows[0].c) > 0) residue.push(`room_types (${q.rows[0].c} baris)`);
  }
  if (has('roomCategories')) {
    const q = await client.query(
      `SELECT COUNT(*) AS c FROM room_categories WHERE id = ANY($1::int[])`,
      [tracked.roomCategories]
    );
    if (Number(q.rows[0].c) > 0) residue.push(`room_categories (${q.rows[0].c} baris)`);
  }

  // user_permission_overrides
  if (has('users')) {
    const q = await client.query(
      `SELECT COUNT(*) AS c FROM user_permission_overrides WHERE user_id = ANY($1::int[])`,
      [tracked.users]
    );
    if (Number(q.rows[0].c) > 0) residue.push(`user_permission_overrides (${q.rows[0].c} baris)`);
  }

  // users
  if (has('users')) {
    const q = await client.query(
      `SELECT COUNT(*) AS c FROM users WHERE id = ANY($1::int[])`,
      [tracked.users]
    );
    if (Number(q.rows[0].c) > 0) residue.push(`users (${q.rows[0].c} baris)`);
  }

  // role_permissions (PK = id SERIAL; UNIQUE (role_id, permission_id))
  if (has('rolePermissions')) {
    const q = await client.query(
      `SELECT COUNT(*) AS c FROM role_permissions WHERE role_id = ANY($1::int[])`,
      [tracked.rolePermissions]
    );
    if (Number(q.rows[0].c) > 0) residue.push(`role_permissions (${q.rows[0].c} baris)`);
  }

  // roles
  if (has('roles')) {
    const q = await client.query(
      `SELECT COUNT(*) AS c FROM roles WHERE id = ANY($1::int[])`,
      [tracked.roles]
    );
    if (Number(q.rows[0].c) > 0) residue.push(`roles (${q.rows[0].c} baris)`);
  }

  // ── Property-scoped checks (artefak yang mungkin belum ter-track) ───────
  //    Hanya properti fixture run ini — jangan sentuh data existing.
  if (has('properties')) {
    const propIds = tracked.properties;
    // transactions property-scoped (bukan hanya tracked ID — ada kemungkinan
    // transaction lain dibuat oleh reader di properti fixture ini)
    const txc = await client.query(
      `SELECT COUNT(*) AS c FROM transactions WHERE property_id = ANY($1::int[])`,
      [propIds]
    );
    if (Number(txc.rows[0].c) > 0) residue.push(`transactions property-scoped (${txc.rows[0].c} baris)`);

    // pos_orders property-scoped
    const poc = await client.query(
      `SELECT COUNT(*) AS c FROM pos_orders WHERE property_id = ANY($1::int[])`,
      [propIds]
    );
    if (Number(poc.rows[0].c) > 0) residue.push(`pos_orders property-scoped (${poc.rows[0].c} baris)`);

    // folio_entries property-scoped
    const fec = await client.query(
      `SELECT COUNT(*) AS c FROM folio_entries WHERE property_id = ANY($1::int[])`,
      [propIds]
    );
    if (Number(fec.rows[0].c) > 0) residue.push(`folio_entries property-scoped (${fec.rows[0].c} baris)`);

    // audit_logs property-scoped
    const alc = await client.query(
      `SELECT COUNT(*) AS c FROM audit_logs WHERE property_id = ANY($1::int[])`,
      [propIds]
    );
    if (Number(alc.rows[0].c) > 0) residue.push(`audit_logs property-scoped (${alc.rows[0].c} baris)`);

    // transaction_daily_sequences property-scoped
    const tsec = await client.query(
      `SELECT COUNT(*) AS c FROM transaction_daily_sequences WHERE property_id = ANY($1::int[])`,
      [propIds]
    );
    if (Number(tsec.rows[0].c) > 0) residue.push(`transaction_daily_sequences property-scoped (${tsec.rows[0].c} baris)`);

    // payment_transactions property-scoped
    const ptc = await client.query(
      `SELECT COUNT(*) AS c FROM payment_transactions WHERE property_id = ANY($1::int[])`,
      [propIds]
    );
    if (Number(ptc.rows[0].c) > 0) residue.push(`payment_transactions property-scoped (${ptc.rows[0].c} baris)`);

    // pos_settlements property-scoped
    const psc = await client.query(
      `SELECT COUNT(*) AS c FROM pos_settlements WHERE property_id = ANY($1::int[])`,
      [propIds]
    );
    if (Number(psc.rows[0].c) > 0) residue.push(`pos_settlements property-scoped (${psc.rows[0].c} baris)`);
  }

  // role_permissions — periksa SELURUH tracked.roles (bukan hanya tracked.rolePermissions)
  if (has('roles')) {
    const roleQ = await client.query(
      `SELECT COUNT(*) AS c FROM role_permissions WHERE role_id = ANY($1::int[])`,
      [tracked.roles]
    );
    if (Number(roleQ.rows[0].c) > 0) residue.push(`role_permissions via tracked.roles (${roleQ.rows[0].c} baris)`);
  }

  // properties — ID langsung (verifikasi cleanup properties sendiri)
  if (has('properties')) {
    const q = await client.query(
      `SELECT COUNT(*) AS c FROM properties WHERE id = ANY($1::int[])`,
      [tracked.properties]
    );
    if (Number(q.rows[0].c) > 0) residue.push(`properties (${q.rows[0].c} baris)`);
  }

  return residue;
}

// ─── 8. Main ──────────────────────────────────────────────────────────────────
async function main() {
  let server = null;
  let client = null;
  let cleanupClient = null;
  let mainError = null;
  let cleanupError = null;
  let residueError = null;
  let resourceError = null;

  try {
    // ── 1. Identitas DB ─────────────────────────────────────────────────────
    client = await pool.connect();
    cleanupClient = await pool.connect(); // dedicated cleanup client
    const idCheck = await client.query(
      `SELECT current_database() AS db, current_user AS usr`
    );
    const optsOk =
      pool.options.host === ALLOWED_HOST &&
      Number(pool.options.port) === ALLOWED_PORT &&
      pool.options.user === ALLOWED_USER &&
      pool.options.database === ALLOWED_DATABASE;
    const dbOk = idCheck.rows[0].db === ALLOWED_DATABASE;
    const usrOk = idCheck.rows[0].usr === ALLOWED_USER;
    ok(
      'DB identity: pool.options cocok target',
      optsOk,
      `host=${pool.options.host} port=${pool.options.port} db=${pool.options.database}`
    );
    ok(
      'DB identity: current_database()=' + ALLOWED_DATABASE,
      dbOk,
      `got ${idCheck.rows[0].db}`
    );
    ok(
      'DB identity: current_user()=' + ALLOWED_USER,
      usrOk,
      `got ${idCheck.rows[0].usr}`
    );
    if (!optsOk || !dbOk || !usrOk) {
      throw new Error(
        `DB identity guard: pool.options=${optsOk} current_database=${dbOk} current_user=${usrOk} — TIDAK semua cocok.`
      );
    }
    identityVerified = true;

    // ── 2. Bangun Express test app + router aktual ─────────────────────────
    const app = express();
    app.use('/api/transactions', createTransactionsRouter(pool));
    const ls = await listen(app);
    server = ls.server;
    const port = ls.port;

    // ── 3. Buat fixture: property, role/user A (pos.view), role/user B ────
    const propertyId = await createFixtureProperty(client);

    const roleAId = await createFixtureRole(client, propertyId, true);  // pos.view
    const roleBId = await createFixtureRole(client, propertyId, false); // tanpa pos.view

    const userA = await createFixtureUser(client, propertyId, roleAId);
    const userB = await createFixtureUser(client, propertyId, roleBId);

    // ── 4. Chain reservasi + SALE kamar 500000 + POS OPEN 25000 ──────────
    const chain = await createReservationChain(client, propertyId);
    await createRoomSaleTransaction(client, propertyId, chain);
    await createFixturePosOrder(client, propertyId, chain.reservationId);

    // ── 5. Verifikasi getUserEffectivePermissions ─────────────────────────
    // Signature: getUserEffectivePermissions(clientOrPool, userId)
    // Client/role di-cari oleh fungsi ini via JOIN users→roles.
    const permsA = await getUserEffectivePermissions(client, userA.id);
    const permsB = await getUserEffectivePermissions(client, userB.id);
    const aHasPosView = permsA.includes('pos.view');
    const bHasPosView = permsB.includes('pos.view');
    ok(
      'Fixture: User A memiliki pos.view',
      aHasPosView,
      `permsA=${JSON.stringify(permsA)}`
    );
    ok(
      'Fixture: User B TIDAK memiliki pos.view',
      !bHasPosView,
      `permsB=${JSON.stringify(permsB)}`
    );
    if (!aHasPosView || bHasPosView) {
      throw new Error(
        `Prasyarat permission tidak terpenuhi: A pos.view=${aHasPosView}, B pos.view=${bHasPosView}.`
      );
    }

    // ── 6. Buat token dengan identitas fixture aktual ──────────────────────
    // Ambil nama role dan email user dari DB (bukan sintetis) agar
    // token mencerminkan data tersimpan. Query terbatas pada
    // user/role/property fixture run ini.
    const roleANameQ = await client.query(
      `SELECT name FROM roles WHERE id = $1`,
      [roleAId]
    );
    const roleBNameQ = await client.query(
      `SELECT name FROM roles WHERE id = $1`,
      [roleBId]
    );
    const userAEmailQ = await client.query(
      `SELECT email FROM users WHERE id = $1`,
      [userA.id]
    );
    const userBEmailQ = await client.query(
      `SELECT email FROM users WHERE id = $1`,
      [userB.id]
    );
    const roleAName = roleANameQ.rows[0].name;
    const roleBName = roleBNameQ.rows[0].name;
    const userAEmail = userAEmailQ.rows[0].email;
    const userBEmail = userBEmailQ.rows[0].email;

    const tokenA = generateToken({
      id: userA.id,
      email: userAEmail,
      username: userA.username,
      full_name: userA.full_name,
      role: roleAName,
      role_id: roleAId,
      property_id: propertyId,
      scope: 'FULL',
      access_type: 'PMS_STAFF',
    });

    const tokenB = generateToken({
      id: userB.id,
      email: userBEmail,
      username: userB.username,
      full_name: userB.full_name,
      role: roleBName,
      role_id: roleBId,
      property_id: propertyId,
      scope: 'FULL',
      access_type: 'PMS_STAFF',
    });

    // ── 7. Siapkan path GET memakai propertyId fixture ─────────────────────
    const baseQuery = `/api/transactions?property_id=${propertyId}&transaction_type=SALE&limit=50`;

    // ── 7a. Snapshot helper: 6 tabel fixture sebelum/sesudah request ──────
    const TABLES = ['pos_orders', 'transactions', 'pos_settlements', 'payment_transactions', 'folio_entries', 'audit_logs'];
    async function takeSnapshot(label) {
      const snap = {};
      for (const t of TABLES) {
        const q = await client.query(
          `SELECT COUNT(*)::int AS c FROM ${t} WHERE property_id = $1`,
          [propertyId]
        );
        snap[t] = Number(q.rows[0].c);
      }
      console.log(`  [SNAPSHOT ${label}] ${JSON.stringify(snap)}`);
      return snap;
    }
    const beforeSnap = await takeSnapshot('BEFORE');

    // ── 7b. Helper: cari booking group + child dari response ───────────────
    // Shape response (from transactionsRouter → getTransactions):
    //   res.json → { success: true, data: { transactions: [ ... ] } }
    //   Grouped row: { ...primary, operational_sheet, payment_status,
    //                   booking_bid_group: { bid, booking_id, children: [...] } }
    //   Child: { reservation_id, net, paid, remaining,
    //            pos_order_count?, pos_open_count?, ... }
    function findGroupAndChild(data, bid, reservationId) {
      const rows = Array.isArray(data.transactions) ? data.transactions : [];
      const group = rows.find((r) => r.booking_bid_group && r.booking_bid_group.bid === bid);
      if (!group) return { found: false };
      const children = Array.isArray(group.booking_bid_group.children)
        ? group.booking_bid_group.children
        : [];
      const child = children.find(
        (c) => String(c.reservation_id) === String(reservationId)
      );
      if (!child) return { found: false, group };
      return { found: true, group, child };
    }

    // ── 7c. Helper: cek rekursif — key tidak ada di seluruh response ──────
    function hasKeyRecursive(obj, key) {
      if (obj === null || typeof obj !== 'object') return false;
      if (obj.hasOwnProperty && obj.hasOwnProperty(key)) return true;
      for (const v of Object.values(obj)) {
        if (v !== null && typeof v === 'object' && hasKeyRecursive(v, key)) return true;
      }
      return false;
    }

    // ── 7d. Helper: assert keuangan booking (net/paid/remaining) ─────────
    function assertFinancials(label, group, child) {
      // Group payload level
      ok(
        `${label}: group.net === 500000`,
        group.booking_bid_group.net === 500000,
        `got ${group.booking_bid_group.net}`
      );
      ok(
        `${label}: group.paid === 0`,
        group.booking_bid_group.paid === 0,
        `got ${group.booking_bid_group.paid}`
      );
      ok(
        `${label}: group.remaining === 500000`,
        group.booking_bid_group.remaining === 500000,
        `got ${group.booking_bid_group.remaining}`
      );
      // Child level
      ok(
        `${label}: child.net === 500000`,
        child.net === 500000,
        `got ${child.net}`
      );
      ok(
        `${label}: child.paid === 0`,
        child.paid === 0,
        `got ${child.paid}`
      );
      ok(
        `${label}: child.remaining === 500000`,
        child.remaining === 500000,
        `got ${child.remaining}`
      );
    }

    // ── S1: tokenA (pos.view) → pos_order_count=1, pos_open_count=1 ─────
    const s1Res = await get(port, baseQuery, tokenA);
    ok('S1: status 200', s1Res.status === 200, `got ${s1Res.status}`);
    ok('S1: success=true', s1Res.json && s1Res.json.success === true,
      `success=${s1Res.json && s1Res.json.success}`);
    const s1 = findGroupAndChild(s1Res.json.data, chain.bid, chain.reservationId);
    ok('S1: group found (bid=' + chain.bid + ')', s1.found,
      `rows=${s1Res.json.data.transactions.length}`);
    ok('S1: child found (reservationId=' + chain.reservationId + ')',
      s1.found && !!s1.child, '');
    if (s1.found) {
      assertFinancials('S1', s1.group, s1.child);
      ok('S1: child.pos_order_count === 1', s1.child.pos_order_count === 1,
        `got ${s1.child.pos_order_count}`);
      ok('S1: child.pos_open_count === 1', s1.child.pos_open_count === 1,
        `got ${s1.child.pos_open_count}`);
      ok('S1: pos_order_count is safe integer',
        Number.isSafeInteger(s1.child.pos_order_count),
        `got ${s1.child.pos_order_count}`);
      ok('S1: pos_open_count is safe integer',
        Number.isSafeInteger(s1.child.pos_open_count),
        `got ${s1.child.pos_open_count}`);
    }

    // ── S2: tokenB (tanpa pos.view) → field ABSENT ───────────────────────
    const s2Res = await get(port, baseQuery, tokenB);
    ok('S2: status 200', s2Res.status === 200, `got ${s2Res.status}`);
    ok('S2: success=true', s2Res.json && s2Res.json.success === true,
      `success=${s2Res.json && s2Res.json.success}`);
    const s2 = findGroupAndChild(s2Res.json.data, chain.bid, chain.reservationId);
    ok('S2: group found', s2.found, '');
    ok('S2: child found', s2.found && !!s2.child, '');
    if (s2.found) {
      assertFinancials('S2', s2.group, s2.child);
      ok('S2: child TIDAK punya pos_order_count',
        !('pos_order_count' in s2.child),
        `keys=${Object.keys(s2.child).join(',')}`);
      ok('S2: child TIDAK punya pos_open_count',
        !('pos_open_count' in s2.child), '');
      ok('S2: rekursif pos_order_count tidak ada di response',
        !hasKeyRecursive(s2Res.json, 'pos_order_count'), '');
      ok('S2: rekursif pos_open_count tidak ada di response',
        !hasKeyRecursive(s2Res.json, 'pos_open_count'), '');
    }

    // ── S3: tokenB + includePosStats=true → tetap ABSENT (fail-closed) ───
    const s3Url = baseQuery + '&includePosStats=true';
    const s3Res = await get(port, s3Url, tokenB);
    ok('S3: status 200', s3Res.status === 200, `got ${s3Res.status}`);
    ok('S3: success=true', s3Res.json && s3Res.json.success === true,
      `success=${s3Res.json && s3Res.json.success}`);
    const s3 = findGroupAndChild(s3Res.json.data, chain.bid, chain.reservationId);
    ok('S3: group found', s3.found, '');
    ok('S3: child found', s3.found && !!s3.child, '');
    if (s3.found) {
      assertFinancials('S3', s3.group, s3.child);
      ok('S3: child TIDAK punya pos_order_count (query tidak bocor)',
        !('pos_order_count' in s3.child),
        `keys=${Object.keys(s3.child).join(',')}`);
      ok('S3: child TIDAK punya pos_open_count (query tidak bocor)',
        !('pos_open_count' in s3.child), '');
      ok('S3: rekursif pos_order_count tidak ada di response',
        !hasKeyRecursive(s3Res.json, 'pos_order_count'), '');
      ok('S3: rekursif pos_open_count tidak ada di response',
        !hasKeyRecursive(s3Res.json, 'pos_open_count'), '');
    }

    // ── Snapshot setelah semua request ────────────────────────────────────
    const afterSnap = await takeSnapshot('AFTER');
    for (const t of TABLES) {
      ok(
        `Snapshot: ${t} tidak berubah (${beforeSnap[t]} -> ${afterSnap[t]})`,
        beforeSnap[t] === afterSnap[t],
        `before=${beforeSnap[t]} after=${afterSnap[t]}`
      );
    }

  } catch (err) {
    mainError = err;
    process.exitCode = 1;
    console.error('[ERROR] ' + (err && err.message ? err.message : err));
  }

  // ── Penutupan resource: server close, cleanup, residu, release ─────────
  try {
    // Tutup server (tangani error agar cleanup tetap jalan).
    if (server) {
      try {
        await new Promise((resolve) => server.close(resolve));
      } catch (closeErr) {
        resourceError = 'server.close failed: ' + (closeErr.message || closeErr);
        console.error('  [RESOURCE ERROR] ' + resourceError);
      }
      server = null;
    }

    // Cleanup + residu: hanya bila identityVerified, cleanupClient tersedia,
    // dan ada fixture tracked.
    const hasTracked = Object.values(tracked).some((v) => Array.isArray(v) && v.length > 0);
    if (identityVerified && cleanupClient && hasTracked) {
      // Cleanup fixture
      try {
        const cl = await cleanupFixtures(cleanupClient);
        cleanupError = cl.error;
        if (cleanupError) {
          failed++;
          failures.push(cleanupError);
          console.error('  [CLEANUP ERROR] ' + cleanupError);
        } else {
          console.log('  [CLEANUP] All fixture cleaned up successfully');
        }
      } catch (e) {
        cleanupError = 'cleanupFixtures exception: ' + (e.message || e);
        failed++;
        failures.push(cleanupError);
        console.error('  [CLEANUP ERROR] ' + cleanupError);
      }

      // Verifikasi residu (dicoba walau cleanup gagal)
      try {
        const residue = await verifyNoResidue(cleanupClient);
        if (residue.length > 0) {
          residueError = 'Residu ditemukan: ' + residue.join('; ');
          failed++;
          failures.push(residueError);
          console.error('  [RESIDUE] ' + residueError);
        } else {
          console.log('  [RESIDUE] 0 — bersih');
        }
      } catch (e) {
        residueError = 'verifyNoResidue exception: ' + (e.message || e);
        failed++;
        failures.push(residueError);
        console.error('  [RESIDUE ERROR] ' + residueError);
      }
    } else if (!identityVerified && cleanupClient && hasTracked) {
      resourceError = 'Skipped cleanup: identityVerified=false — fixture mungkin residu.';
      console.error('  [RESOURCE WARNING] ' + resourceError);
    }
  } finally {
    // Pelepasan resource (terpisah, selalu dijalankan).
    let releaseErr = null;
    if (client) {
      try { await client.release(); } catch (e) { releaseErr = (releaseErr ? releaseErr + '; ' : '') + 'client.release: ' + e.message; }
    }
    if (cleanupClient) {
      try { await cleanupClient.release(); } catch (e) { releaseErr = (releaseErr ? releaseErr + '; ' : '') + 'cleanupClient.release: ' + e.message; }
    }
    try {
      await pool.end();
    } catch (e) {
      releaseErr = (releaseErr ? releaseErr + '; ' : '') + 'pool.end: ' + e.message;
    }
    if (releaseErr) {
      resourceError = resourceError ? resourceError + '; ' + releaseErr : releaseErr;
      failed++;
      failures.push('Resource release error: ' + releaseErr);
      console.error('  [RESOURCE ERROR] ' + releaseErr);
      process.exitCode = 1;
    }
  }

  // ── Ringkasan hasil ──────────────────────────────────────────────────────
  // Rekam error secara independen; hindari duplikat.
  if (mainError) {
    const errMsg = '[MAIN ERROR] ' + (mainError.message || String(mainError));
    if (!failures.some((f) => f === errMsg)) {
      failed++;
      failures.push(errMsg);
    }
  }
  if (cleanupError && !failures.some((f) => f === cleanupError)) {
    failed++;
    failures.push(cleanupError);
  }
  if (residueError && !failures.some((f) => f === residueError)) {
    failed++;
    failures.push(residueError);
  }
  if (resourceError && !failures.some((f) => f === resourceError)) {
    failed++;
    failures.push(resourceError);
  }
  if (failed > 0) {
    for (const f of failures) console.log(`  FAIL: ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`[POS ROOM INDICATOR ENDPOINT] ${passed} PASS, 0 FAIL`);
  }
}

main().catch((err) => {
  console.error('[FATAL] ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
