/**
 * POS PAYMENT SETTLEMENT SERVICE — Test (Tahap 1/2: skeleton)
 *
 * Target: disposable PostgreSQL `oak_minibar_test` (host 127.0.0.1, port 15434).
 * Uji service payPosOrderCash dari dist/domains/pos/posSettlementService.
 *
 * DB safety guard (tanpa dotenv / fallback apa pun):
 * - TEST_DATABASE_URL eksplisit: postgres://, 127.0.0.1, port 15434,
 *   database oak_minibar_test, user minibar_test, password wajib.
 * - Tanpa query parameter. Tidak mencetak password/URL.
 * - Pool dibuat dari field eksplisit hasil parse URL (bukan connectionString).
 * - Verifikasi pool.options (eksak) + current_database()/current_user()
 *   sebelum mutasi apa pun. TIDAK memakai inet_server_port() sebagai guard
 *   port Docker (host 15434 → PG internal 5432).
 *
 * Run:
 *   TEST_DATABASE_URL=postgres://USER:PASS@127.0.0.1:15434/oak_minibar_test \
 *   node backend/test/pos_settlement_service_test.js
 */

'use strict';

// ─── 1. DB SAFETY GUARD (tanpa dotenv/fallback) ─────────────────────────────
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !testUrl.trim()) {
  console.error(
    'SAFETY: TEST_DATABASE_URL tidak di-set.\n' +
    'Jalankan: TEST_DATABASE_URL=postgres://USER:PASS@127.0.0.1:15434/oak_minibar_test ' +
    'node backend/test/pos_settlement_service_test.js'
  );
  process.exit(1);
}

// Allowlist target disposable — host/port/db/user harus eksak.
const ALLOWED_HOST = '127.0.0.1';
const ALLOWED_PORT = 15434;
const ALLOWED_DATABASE = 'oak_minibar_test';
const ALLOWED_USER = 'minibar_test';
const FORBIDDEN = ['staging', 'production', 'prod', 'live'];

let target; // { host, port, user, database, password }
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
  // TIDAK mencetak password / URL — hanya database & user & port.
  console.log(
    `[POS SETTLEMENT SERVICE TEST] Target DB: ${database} (user: ${user}, port: ${port})`
  );
} catch (e) {
  console.error('SAFETY: TEST_DATABASE_URL ditolak — ' + e.message);
  process.exit(1);
}

// ─── 2. Pool dari field eksplisit — tanpa connectionString, tanpa fallback ───
const { Pool, PoolClient } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  host: target.host,
  port: target.port,
  user: target.user,
  password: target.password,
  database: target.database,
  max: 5, // dua client konkuren + 1 untuk cleanup → longgar
});

// ─── 3. Import HANYA service dari dist — TANPA app/index / migration runner ─
const settlement = require('../dist/domains/pos/posSettlementService');
const {
  payPosOrderCash,
  PosSettlementError,
  computeCashSettlementFingerprint,
} = settlement;

// ─── Helper: assert sederhana dengan counter ────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

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

/**
 * Perbandingan string eksak (tanpa normalisasi kapitalisasi).
 */
function isExceed(a, b) {
  return String(a) === String(b);
}

// ─── Tracking fixture (hanya data yang DIBUAT suite ini) ──────────────────
// Cleanup wajib berdasarkan ID, di PoolClient DEDICATED dalam SATU transaksi.
const tracked = {
  properties: [],      // INTEGER ids
  roomCategories: [],  // INTEGER ids
  roomTypes: [],       // INTEGER ids
  rooms: [],           // INTEGER ids
  bookings: [],        // BIGINT ids
  reservations: [],    // INTEGER ids
  menuCategories: [],  // INTEGER ids
  menuItems: [],       // INTEGER ids
  posOrders: [],       // INTEGER ids
  transactions: [],    // BIGINT ids
  posSettlements: [],  // INTEGER ids
  auditLogs: [],       // INTEGER ids
  folioEntries: [],    // INTEGER ids
};

function track(table, id) {
  if (id == null) return;
  tracked[table].push(Number(id));
}

// Identitas unik per run → menjamin kode property / bid / order_number tidak
// pernah bentrok dengan data existing (run paralel & berurutan).
const RUN_ID =
  Date.now().toString(36).toUpperCase() +
  Math.random().toString(36).slice(2, 5).toUpperCase();

// ── State generator fixture (counter per-pemanggilan + anti-duplikat) ──────
// RUN_ID unik per run (hindari bentrok antar-run). Dalam SATU run, helper
// yang dipanggil berulang pada lingkup unique-constraint yang sama wajib
// menghasilkan nilai BERBEDA → counter per-pemanggilan + Set menolak duplikat.
//
// properties.property_code : UNIQUE global, CHECK ^[A-Z0-9]{2,6}$
//   → prefix acak 3 char + counter base36 (3 char, padStart) = 6 char eksak.
// pos_orders (property_id, order_number) : UNIQUE per property
//   → counter order agar dua order di property yang sama tak berbagi nomor.

// Prefix acak 3 karakter, dibuat SEKALI per run (dipakai semua property).
const PROPERTY_CODE_PREFIX =
  crypto.randomBytes(2).toString('hex').slice(0, 3).toUpperCase();

let propertyCounter = 0;
const usedPropertyCodes = new Set();
const PROPERTY_CODE_LIMIT = 36 * 36 * 36; // 36**3
let orderCounter = 0;

/**
 * property_code = prefix(3) + counterBase36(3, padStart) → tepat 6 char,
 * tanpa slice hasil akhir. Throw bila counter mencapai 36**3 atau kode
 * duplikat dalam run (tanpa loop acak). Validasi /^[A-Z0-9]{6}$/ sebelum
 * INSERT.
 */
function nextPropertyCode() {
  if (propertyCounter >= PROPERTY_CODE_LIMIT) {
    throw new Error(
      `nextPropertyCode: counter mencapai ${PROPERTY_CODE_LIMIT} (36**3)`
    );
  }
  const code =
    PROPERTY_CODE_PREFIX +
    propertyCounter.toString(36).toUpperCase().padStart(3, '0');
  propertyCounter++;

  if (usedPropertyCodes.has(code)) {
    throw new Error(`nextPropertyCode: duplikat kode '${code}' dalam run`);
  }
  usedPropertyCodes.add(code);

  if (!/^[A-Z0-9]{6}$/.test(code)) {
    throw new Error(`nextPropertyCode: '${code}' tidak cocok /^[A-Z0-9]{6}$/`);
  }
  return code;
}

/**
 * Buat order_number unik per-run & per-property: 'PO' + RUN_ID + counter,
 * maks 50 char. Counter per-pemanggilan menjamin dua order di property sama
 * tidak berbagi nomor.
 */
function nextOrderNumber() {
  const c = orderCounter++;
  return ('PO' + RUN_ID + '-' + c).slice(0, 50);
}

// ─── Helper FIXTURE (satu PoolClient, insert satu per satu) ───────────────
// Semua INSERT mengembalikan id → track() LANGSUNG, sehingga kegagalan parsial
// di tengah-tengah tetap bisa dibersihkan cleanup (urutan FK-safe berdasarkan
// ID yang benar-benar berhasil dibuat, bukan asumsi lengkap).
//
// Catatan penting:
// - `reservations` TIDAK memiliki `property_id` (jangan mengarang kolom itu).
//   property_id reservasi diturunkan dari `bookings.property_id`.
// - Service pembayaran TIDAK menulis folio_entries / payment_transactions.
//   Fixture folio sengaja TIDAK dibuat agar residu check tetap deterministik.

/** Buat satu properti baru (id unik). @returns {number} property id */
async function createFixtureProperty(client, label) {
  const code = nextPropertyCode();
  const q = await client.query(
    `INSERT INTO properties (name, property_code, timezone, currency_code, is_active)
     VALUES ($1, $2, 'Asia/Jakarta', 'IDR', TRUE) RETURNING id`,
    [`Settle Tst ${label} ${RUN_ID}`, code]
  );
  const id = Number(q.rows[0].id);
  track('properties', id);
  return id;
}

/**
 * Buat menu (kategori + item) bila diperlukan untuk total_amount POS order.
 * @returns {{category: number, item: number}}
 */
async function createFixtureMenu(client, propertyId) {
  const catQ = await client.query(
    `INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, $2) RETURNING id`,
    [propertyId, `Cat ${RUN_ID}`]
  );
  const catId = Number(catQ.rows[0].id);
  track('menuCategories', catId);

  const itemQ = await client.query(
    `INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, is_active)
     VALUES ($1, $2, $3, $4, 10000, TRUE) RETURNING id`,
    [propertyId, catId, `ITM-${RUN_ID}`, `Item ${RUN_ID}`]
  );
  const itemId = Number(itemQ.rows[0].id);
  track('menuItems', itemId);

  return { category: catId, item: itemId };
}

/**
 * Buat satu POS order OPEN dengan total_amount positif.
 * @returns {number} order id
 */
async function createFixturePosOrder(client, propertyId, totalAmount = 115000) {
  const orderNumber = nextOrderNumber();
  const q = await client.query(
    `INSERT INTO pos_orders (property_id, order_number, status, total_amount)
     VALUES ($1, $2, 'OPEN', $3) RETURNING id`,
    [propertyId, orderNumber, totalAmount]
  );
  const id = Number(q.rows[0].id);
  track('posOrders', id);
  return id;
}

/**
 * Buat chain reservasi terkait BID (untuk pembayaran terkait booking):
 *   room_categories → room_types → rooms → bookings → reservations
 * property_id reservasi diturunkan dari bookings (bukan kolom milik reservasi).
 * @returns {{roomCategory: number, roomType: number, room: number, booking: number, reservation: number}}
 */
async function createReservationChain(client, propertyId, guestName) {
  const rcQ = await client.query(
    `INSERT INTO room_categories (property_id, code, name)
     VALUES ($1, $2, $2) RETURNING id`,
    [propertyId, `RC-${RUN_ID}`.slice(0, 50)]
  );
  const roomCategoryId = Number(rcQ.rows[0].id);
  track('roomCategories', roomCategoryId);

  const rtQ = await client.query(
    `INSERT INTO room_types (
       property_id, code, name, room_category_id, capacity,
       max_adults, max_children, is_active, display_order, base_rate
     ) VALUES ($1, $2, $2, $3, 2, 2, 0, TRUE, 1, 500000) RETURNING id`,
    [propertyId, `RT-${RUN_ID}`.slice(0, 50), roomCategoryId]
  );
  const roomTypeId = Number(rtQ.rows[0].id);
  track('roomTypes', roomTypeId);

  const rmQ = await client.query(
    `INSERT INTO rooms (property_id, room_number, room_type_id, is_active)
     VALUES ($1, $2, $3, TRUE) RETURNING id`,
    [propertyId, `R-${RUN_ID}`.slice(0, 10), roomTypeId]
  );
  const roomId = Number(rmQ.rows[0].id);
  track('rooms', roomId);

  const bkQ = await client.query(
    `INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status)
     VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [`BID-${RUN_ID}`.slice(0, 32), propertyId, guestName]
  );
  const bookingId = Number(bkQ.rows[0].id);
  track('bookings', bookingId);

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

  return {
    roomCategory: roomCategoryId,
    roomType: roomTypeId,
    room: roomId,
    booking: bookingId,
    reservation: reservationId,
  };
}

/**
 * Cleanup FK-safe: satu PoolClient dedicated, SATU transaksi (BEGIN/…/COMMIT
 * atau ROLLBACK). DELETE berdasarkan ID run ini HANYA — tidak menyentuh data
 * existing. Urutan anak → induk diturunkan dari FK source aktual:
 *
 *   audit_logs        → properties (RESTRICT)          [hapus di akhir]
 *   pos_settlements   → properties/orders/transactions (RESTRICT)
 *   transactions      → properties (RESTRICT)
 *   transaction_daily_sequences → properties (CASCADE, aman saat hapus property)
 *   folio_entries     → reservations (RESTRICT)        [fixture tak membuatnya]
 *   pos_orders        → reservations (RESTRICT/NULL)
 *   pos_menu_items    → categories (RESTRICT)
 *   pos_menu_categories → properties
 *   reservations      → bookings, rooms
 *   bookings          → properties (RESTRICT)
 *   rooms             → room_types, properties
 *   room_types        → room_categories, properties
 *   room_categories   → properties
 *   properties        ← semua di atas (RESTRICT)       [hapus pertama yang tersisa]
 *
 * @returns {{removed: object, error?: string}}
 */
async function cleanupFixtures(cleanupClient) {
  const ids = (key) =>
    Array.isArray(tracked[key]) ? tracked[key].filter((v) => v != null) : [];

  try {
    await cleanupClient.query('BEGIN');

    // 1) audit_logs — terakhir dibuat, tidak di-CASCADE; hapus per id eksplisit
    //    agar data audit existing (property_id lain / record_id lain) aman.
    {
      const q = ids('auditLogs');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM audit_logs WHERE audit_id = ANY($1)`, [q]
        );
      }
    }

    // 2) pos_settlements — FK ke orders (RESTRICT) → harus setelah orders?
    //    Tidak: settlement adalah ANAK dari orders/transactions/properties.
    //    Hapus settlement SEBELUM order/transaction/property.
    {
      const q = ids('posSettlements');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM pos_settlements WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 3) transactions (SALE) — FK properties (RESTRICT)
    {
      const q = ids('transactions');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM transactions WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 4) transaction_daily_sequences — ON DELETE CASCADE dari properties;
    //    amankan eksplisit sebelum hapus properties.
    {
      const p = ids('properties');
      if (p.length) {
        await cleanupClient.query(
          `DELETE FROM transaction_daily_sequences WHERE property_id = ANY($1)`, [p]
        );
      }
    }

    // 5) folio_entries — service tak membuatnya; amankan bila ada (residu).
    {
      const r = ids('reservations');
      if (r.length) {
        await cleanupClient.query(
          `DELETE FROM folio_entries WHERE reservation_id = ANY($1)`, [r]
        );
      }
    }

    // 6) pos_orders — FK reservations (boleh NULL). Hapus sebelum properties.
    {
      const q = ids('posOrders');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM pos_orders WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 7) pos_menu_items → categories
    {
      const q = ids('menuItems');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM pos_menu_items WHERE id = ANY($1)`, [q]
        );
      }
    }
    // 8) pos_menu_categories → properties
    {
      const q = ids('menuCategories');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM pos_menu_categories WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 9) reservations → bookings, rooms
    {
      const q = ids('reservations');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM reservations WHERE id = ANY($1)`, [q]
        );
      }
    }
    // 10) bookings → properties (RESTRICT)
    {
      const q = ids('bookings');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM bookings WHERE id = ANY($1)`, [q]
        );
      }
    }
    // 11) rooms → room_types, properties
    {
      const q = ids('rooms');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM rooms WHERE id = ANY($1)`, [q]
        );
      }
    }
    // 12) room_types → room_categories, properties
    {
      const q = ids('roomTypes');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM room_types WHERE id = ANY($1)`, [q]
        );
      }
    }
    // 13) room_categories → properties
    {
      const q = ids('roomCategories');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM room_categories WHERE id = ANY($1)`, [q]
        );
      }
    }
    // 14) properties — terakhir (semua RESTRICT sudah dibersihkan)
    {
      const q = ids('properties');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM properties WHERE id = ANY($1)`, [q]
        );
      }
    }

    await cleanupClient.query('COMMIT');
    return { removed: 'ok' };
  } catch (err) {
    // ROLLBACK untuk mengembalikan apa pun yang sudah di-DELETE pada transaksi ini.
    try {
      await cleanupClient.query('ROLLBACK');
    } catch (_) {
      /* abaikan — error utama yang dilaporkan */
    }
    return { removed: 'error', error: String((err && err.message) || err) };
  }
}

/**
 * Verifikasi residu: seluruh ID tracked harus hilang. Return list ketidaksuaan.
 * Kegagalan → non-zero exit (dipanggil pemanggil).
 */
async function verifyNoResidue(residueClient) {
  const residue = [];
  const checks = [
    ['audit_logs', 'audit_id', 'auditLogs'],
    ['pos_settlements', 'id', 'posSettlements'],
    ['transactions', 'id', 'transactions'],
    ['pos_orders', 'id', 'posOrders'],
    ['pos_menu_items', 'id', 'menuItems'],
    ['pos_menu_categories', 'id', 'menuCategories'],
    ['reservations', 'id', 'reservations'],
    ['bookings', 'id', 'bookings'],
    ['rooms', 'id', 'rooms'],
    ['room_types', 'id', 'roomTypes'],
    ['room_categories', 'id', 'roomCategories'],
    ['properties', 'id', 'properties'],
  ];
  for (const [table, pk, trackKey] of checks) {
    const q = (Array.isArray(tracked[trackKey]) ? tracked[trackKey] : []).filter(
      (v) => v != null
    );
    if (!q.length) continue;
    const res = await residueClient.query(
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${pk} = ANY($1)`,
      [q]
    );
    const n = Number(res.rows[0].n);
    if (n > 0) residue.push(`${table}: ${n} baris tersisa (id=${q.join(',')})`);
  }
  return residue;
}

// ─── Verifikasi identitas DB SEBELUM mutasi apa pun ────────────────────────
async function verifyDbIdentity(client) {
  // a) pool.options HARUS PERSIS target (perbandingan eksak, tanpa toLowerCase).
  const mismatches = [
    ['host', String(pool.options.host ?? ''), target.host],
    ['port', String(pool.options.port ?? ''), String(target.port)],
    ['user', String(pool.options.user ?? ''), target.user],
    ['database', String(pool.options.database ?? ''), target.database],
  ].filter(([, a, b]) => a !== b);
  if (mismatches.length) {
    for (const [field, got, want] of mismatches) {
      console.error(`[GUARD] pool.options.${field}="${got}" != target "${want}"`);
    }
    process.exit(1);
  }

  // b) current_database() / current_user() HARUS PERSIS target.
  //    (TIDAK memakai inet_server_port() karena Docker memetakan host 15434
  //     → PostgreSQL internal 5432; pool.options.port adalah guard port-nya.)
  const q = await client.query(
    `SELECT current_database() AS db, current_user AS usr`
  );
  const row = q.rows[0] || {};
  if (row.db !== target.database) {
    console.error(`[GUARD] current_database "${row.db}" != target "${target.database}"`);
    process.exit(1);
  }
  if (row.usr !== target.user) {
    console.error(`[GUARD] current_user "${row.usr}" != target "${target.user}"`);
    process.exit(1);
  }
  console.log(`[GUARD] Identitas DB terverifikasi: db=${row.db} user=${row.usr}`);
}

/**
 * Ambil baseline yang TIDAK BOLEH berubah oleh service pembayaran:
 * - reservation payment_status / amount_paid / remaining_balance
 * - folio_entries pada reservasi (COUNT + total debit/credit)
 * - payment_transactions pada reservasi/property (COUNT)
 * Service settlement CASH TIDAK menyentuh tabel-tabel ini.
 */
async function captureReservationBaseline(client, reservationId, propertyId) {
  const res = await client.query(
    `SELECT payment_status, amount_paid, remaining_balance, total_price
     FROM reservations WHERE id = $1`,
    [reservationId]
  );
  const folio = await client.query(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0) AS d,
            COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0) AS c
     FROM folio_entries WHERE reservation_id = $1`,
    [reservationId]
  );
  const pay = await client.query(
    `SELECT COUNT(*) AS n FROM payment_transactions
     WHERE property_id = $1 AND reservation_id = $2`,
    [propertyId, reservationId]
  );
  const f = folio.rows[0] || {};
  const p = pay.rows[0] || {};
  return {
    payment_status: String((res.rows[0] || {}).payment_status ?? ''),
    amount_paid: Number((res.rows[0] || {}).amount_paid ?? 0),
    remaining_balance: Number((res.rows[0] || {}).remaining_balance ?? 0),
    total_price: Number((res.rows[0] || {}).total_price ?? 0),
    folio_count: Number(f.n ?? 0),
    folio_debit: Number(f.d ?? 0),
    folio_credit: Number(f.c ?? 0),
    payment_txn_count: Number(p.n ?? 0),
  };
}

/**
 * Cari & track artefak pembayaran yang DIBUAT service untuk daftar order,
 * MELALUI RELASI SOURCE AKTUAL (bukan mengandalkan return service):
 *   transactions : source_type='POS_ORDER' AND source_id IN (String(orderId))
 *   pos_settlements : pos_order_id IN (orderIds)
 *   audit_logs   : module='POS' AND action='SETTLEMENT_CASH'
 *                    AND record_id IN (settlement ids yang baru ditemukan)
 * Hasil track masuk ke tracked[] sehingga cleanup + residu mencakup semua,
 * termasuk bila service gagal di tengah (artefak tetap ditemukan & dibersihkan).
 * @returns {{transactions: number[], settlements: number[], audits: number[]}}
 */
async function collectPaymentArtifacts(client, orderIds) {
  const ids = (Array.isArray(orderIds) ? orderIds : [orderIds])
    .filter((v) => v != null)
    .map((v) => Number(v));
  const uniq = Array.from(new Set(ids));
  if (!uniq.length) return { transactions: [], settlements: [], audits: [] };

  // 1) SALE (transactions) terkait order — source_id menyimpan String(orderId).
  const tx = await client.query(
    `SELECT id FROM transactions
     WHERE source_type = 'POS_ORDER' AND source_id = ANY($1)`,
    [uniq.map((o) => String(o))]
  );
  for (const r of tx.rows || []) track('transactions', r.id);

  // 2) settlement terkait order — FK eksak pos_order_id.
  const st = await client.query(
    `SELECT id, property_id FROM pos_settlements WHERE pos_order_id = ANY($1)`,
    [uniq]
  );
  const stIds = (st.rows || []).map((r) => Number(r.id)).filter((v) => v != null);
  for (const sid of stIds) track('posSettlements', sid);

  // 3) audit SETTLEMENT_CASH terkait settlement — record_id = String(settlement.id).
  let au = { rows: [] };
  if (stIds.length) {
    au = await client.query(
      `SELECT audit_id FROM audit_logs
       WHERE module = 'POS' AND action = 'SETTLEMENT_CASH'
         AND record_id = ANY($1)`,
      [stIds.map((s) => String(s))]
    );
  }
  for (const r of au.rows || []) track('auditLogs', r.audit_id);

  return {
    transactions: (tx.rows || []).map((r) => Number(r.id)),
    settlements: stIds,
    audits: (au.rows || []).map((r) => Number(r.audit_id)),
  };
}

// ─── 4. main() dengan finally: release client & pool.end ───────────────────
async function main() {
  // Client DEDICATED untuk skenario (verify identitas + fixture + pembayaran).
  const client = await pool.connect();
  // Client DEDICATED KEDUA untuk cleanup + residu (jaga agar transaksi cleanup
  // tidak bercampur dengan transaksi skenario — aman bila skenario crash).
  const cleanupClient = await pool.connect();
  // Client DEDICATED untuk S6 konkurensi (dua client terpisah). Dibuat di-scope
  // main agar TETAP bisa di-release di finally (termasuk bila S6 gagal).
  let clientC = null;
  let clientD = null;
  let cleanupDone = false;
  // Gate: cleanup + residue check hanya berjalan bila identitas DB terverifikasi.
  let identityVerified = false;
  // Queue pemulihan mutation sementara (S8/S9/S10): tiap operasi dipanggil di
  // finally SEBELUM cleanup, sehingga data fixture kembali utuh & residu clean.
  const restoreOps = [];
  const registerRestore = (fn) => restoreOps.push(fn);

  try {
    // Verifikasi guard SEBELUM mutasi apa pun.
    await verifyDbIdentity(client);
    identityVerified = true;

    // ── Fixture (tanpa skenario pembayaran) ───────────────────────────────
    const propA = await createFixtureProperty(client, 'A');
    const menuA = await createFixtureMenu(client, propA);
    const orderA = await createFixturePosOrder(client, propA, 115000);

    // Chain reservasi terkait BID (property_id dari bookings, bukan reservasi).
    const chain = await createReservationChain(
      client,
      propA,
      `Tamu ${RUN_ID}`
    );
    // Kaitkan order ke reservasi (opsional; tetap kolom yang sah).
    await client.query(
      `UPDATE pos_orders SET reservation_id = $1 WHERE id = $2`,
      [chain.reservation, orderA]
    );

    // Baseline reservasi (TIDAK BOLEH berubah oleh pembayaran POS CASH).
    const baseline = await captureReservationBaseline(
      client,
      chain.reservation,
      propA
    );

    // Konfirmasi fixture terbaca kembali & ter-track.
    const chkQ = await client.query(
      `SELECT property_id, status, total_amount, reservation_id
       FROM pos_orders WHERE id = $1`,
      [orderA]
    );
    const chk = chkQ.rows[0] || {};
    ok('fixture: order OPEN + total_amount 115000',
      String(chk.status) === 'OPEN' && Number(chk.total_amount) === 115000,
      JSON.stringify(chk));
    ok('fixture: order ter-kait reservasi chain',
      Number(chk.reservation_id) === chain.reservation,
      `res=${chk.reservation_id} chain=${chain.reservation}`);

    // Cegah lintasan fixture yang belum terpakai (placeholder hingga skenario).
    void menuA; void orderA;

    // ── Checkpoint in-memory (tanpa DB): fingerprint & validasi input. ──
    const fp1 = computeCashSettlementFingerprint(propA, orderA, 'CASH');
    const fp2 = computeCashSettlementFingerprint(propA, orderA, 'CASH');
    const fp3 = computeCashSettlementFingerprint(propA, orderA + 1, 'CASH');
    ok('fingerprint deterministik (payload sama)', fp1 === fp2,
      `fp1=${fp1} fp2=${fp2}`);
    ok('fingerprint berbeda untuk order berbeda', fp1 !== fp3,
      `fp1=${fp1} fp3=${fp3}`);
    ok('fingerprint panjang SHA-256 hex = 64 char', fp1.length === 64,
      `len=${fp1.length}`);

    // =====================================================================
    //  SKENARIO 1 — Order umum OPEN → CASH
    // =====================================================================
    const KEY1 = `s1-${RUN_ID}`.slice(0, 60);
    const prop1 = await createFixtureProperty(client, 'S1');
    const order1 = await createFixturePosOrder(client, prop1, 250000);

    // Baseline jumlah artefak untuk prop1 sebelum bayar (harus 0).
    const preTx1 = await client.query(
      `SELECT COUNT(*) AS n FROM transactions
       WHERE property_id = $1 AND source_type = 'POS_ORDER' AND source_id = $2`,
      [prop1, String(order1)]);
    const preSt1 = await client.query(
      `SELECT COUNT(*) AS n FROM pos_settlements
       WHERE property_id = $1 AND pos_order_id = $2`,
      [prop1, order1]);

    // Simpan ID artefak pembayaran awal (S1) untuk perbandingan S3 (replay)
    // dan S5 (dua order berbeda).
    let settleIdFirst = null;
    let saleIdFirst = null;

    let res1 = null;
    let code1 = null;
    try {
      res1 = await payPosOrderCash(client, {
        propertyId: prop1,
        orderId: order1,
        idempotencyKey: KEY1,
        actorName: 'S1-actor',
        actorUserId: `actor-${RUN_ID}`,
      });
    } catch (e) {
      code1 = e && e.code;
    }

    ok('S1: pembayaran sukses (tak throw)', res1 != null,
      `code=${code1}`);
    if (res1) {
      ok('S1: settlement.id ada & created=true', res1.created === true && res1.replayed === false,
        `created=${res1.created} replayed=${res1.replayed}`);
    }

    // Efek pada order: harus PAID.
    const st1 = await client.query(`SELECT status FROM pos_orders WHERE id = $1`, [order1]);
    ok('S1: order menjadi PAID', String(st1.rows[0].status) === 'PAID',
      `status=${st1.rows[0].status}`);

    // Artefak yang service BUKA (per property+order).
    const tx1q = await client.query(
      `SELECT id, source_type, source_id, transaction_type, payment_status,
              payment_method, net_amount, amount
       FROM transactions
       WHERE property_id = $1 AND source_type = 'POS_ORDER' AND source_id = $2`,
      [prop1, String(order1)]);
    ok('S1: tepat 1 SALE transaction', Number(tx1q.rows.length) === 1,
      `n=${tx1q.rows.length}`);
    if (tx1q.rows.length === 1) {
      const t = tx1q.rows[0];
      ok('S1: SALE transaction_type=SALE & PAID & CASH',
        String(t.transaction_type) === 'SALE' &&
        String(t.payment_status) === 'PAID' &&
        String(t.payment_method) === 'CASH',
        `type=${t.transaction_type} status=${t.payment_status} method=${t.payment_method}`);
      ok('S1: net_amount = nominal order tersimpan (250000)',
        Number(t.net_amount) === 250000,
        `net=${t.net_amount} preTxCount=${preTx1.rows[0].n}`);
    }

    const st1q = await client.query(
      `SELECT id, amount, status, payment_method, transaction_id
       FROM pos_settlements
       WHERE property_id = $1 AND pos_order_id = $2`,
      [prop1, order1]);
    ok('S1: tepat 1 settlement', Number(st1q.rows.length) === 1,
      `n=${st1q.rows.length} preSettleCount=${preSt1.rows[0].n}`);
    if (st1q.rows.length === 1) {
      const s = st1q.rows[0];
      ok('S1: settlement amount = nominal order & status SUCCESS & CASH',
        Number(s.amount) === 250000 &&
        String(s.status) === 'SUCCESS' &&
        String(s.payment_method) === 'CASH',
        `amount=${s.amount} status=${s.status} method=${s.payment_method}`);
      settleIdFirst = Number(s.id);
      saleIdFirst = Number(s.transaction_id); // SALE id merujuk settlement.transaction_id
    }

    const au1q = await client.query(
      `SELECT COUNT(*) AS n FROM audit_logs
       WHERE module = 'POS' AND action = 'SETTLEMENT_CASH'
         AND record_id = (SELECT id::text FROM pos_settlements
                          WHERE property_id = $1 AND pos_order_id = $2)`,
      [prop1, order1]);
    ok('S1: tepat 1 audit SETTLEMENT_CASH', Number(au1q.rows[0].n) === 1,
      `n=${au1q.rows[0].n}`);

    // =====================================================================
    //  SKENARIO 2 — Order terkait reservasi: SALE terkait reservation_id +
    //  booking/BID sesuai kontrak; saldo/status reservasi & folio &
    //  payment_transactions TIDAK berubah.
    // =====================================================================
    const KEY2 = `s2-${RUN_ID}`.slice(0, 60);
    const order2 = await createFixturePosOrder(client, propA, 77000);
    // Kaitkan order ke reservasi (chain dari fixture utama).
    await client.query(
      `UPDATE pos_orders SET reservation_id = $1 WHERE id = $2`,
      [chain.reservation, order2]
    );
    // Baseline reservasi SEBELUM bayar (SUDAH ter-capture di `baseline`).
    const baseline2 = baseline; // reservasi yang sama

    let res2 = null;
    let code2 = null;
    try {
      res2 = await payPosOrderCash(client, {
        propertyId: propA,
        orderId: order2,
        idempotencyKey: KEY2,
      });
    } catch (e) {
      code2 = e && e.code;
    }
    ok('S2: pembayaran sukses (tak throw)', res2 != null,
      `code=${code2}`);

    // SALE harus membawa reservation_id & booking_id sesuai kontrak aktual.
    const tx2 = await client.query(
      `SELECT reservation_id, booking_id, source_id, source_type
       FROM transactions
       WHERE property_id = $1 AND source_type = 'POS_ORDER' AND source_id = $2`,
      [propA, String(order2)]);
    ok('S2: tepat 1 SALE', Number(tx2.rows.length) === 1,
      `n=${tx2.rows.length}`);
    if (tx2.rows.length === 1) {
      const t = tx2.rows[0];
      ok('S2: SALE.reservation_id = reservasi chain',
        Number(t.reservation_id) === chain.reservation,
        `got=${t.reservation_id} want=${chain.reservation}`);
      ok('S2: SALE.booking_id = booking chain',
        Number(t.booking_id) === chain.booking,
        `got=${t.booking_id} want=${chain.booking}`);
    }

    // Invariant: reservasi / folio / payment_transactions TIDAK berubah.
    const after2 = await captureReservationBaseline(client, chain.reservation, propA);
    ok('S2: payment_status reservasi tidak berubah',
      after2.payment_status === baseline2.payment_status,
      `before=${baseline2.payment_status} after=${after2.payment_status}`);
    ok('S2: amount_paid reservasi tidak berubah',
      after2.amount_paid === baseline2.amount_paid,
      `before=${baseline2.amount_paid} after=${after2.amount_paid}`);
    ok('S2: remaining_balance reservasi tidak berubah',
      after2.remaining_balance === baseline2.remaining_balance,
      `before=${baseline2.remaining_balance} after=${after2.remaining_balance}`);
    ok('S2: jumlah folio_entries tidak bertambah',
      after2.folio_count === baseline2.folio_count,
      `before=${baseline2.folio_count} after=${after2.folio_count}`);
    ok('S2: total folio debit/credit tidak berubah',
      after2.folio_debit === baseline2.folio_debit &&
      after2.folio_credit === baseline2.folio_credit,
      `d:${baseline2.folio_debit}->${after2.folio_debit} ` +
      `c:${baseline2.folio_credit}->${after2.folio_credit}`);
    ok('S2: payment_transactions tidak bertambah',
      after2.payment_txn_count === baseline2.payment_txn_count,
      `before=${baseline2.payment_txn_count} after=${after2.payment_txn_count}`);

    // =====================================================================
    //  SKENARIO 3 — Replay key sama: settlement/SALE ID sama,
    //  created=false, replayed=true; jumlah tidak bertambah.
    // =====================================================================
    const preCount3 = {
      settle: (await client.query(
        `SELECT COUNT(*) AS n FROM pos_settlements
         WHERE property_id = $1 AND pos_order_id = $2`, [prop1, order1])).rows[0].n,
      tx: (await client.query(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE property_id = $1 AND source_type = 'POS_ORDER' AND source_id = $2`,
        [prop1, String(order1)])).rows[0].n,
      audit: (await client.query(
        `SELECT COUNT(*) AS n FROM audit_logs
         WHERE module = 'POS' AND action = 'SETTLEMENT_CASH'
           AND record_id = ANY(SELECT id::text FROM pos_settlements
                               WHERE property_id = $1 AND pos_order_id = $2)`,
        [prop1, order1])).rows[0].n,
    };

    let res3 = null;
    let code3 = null;
    try {
      // Order1 SUDAH settled (sk1) → key sama + fingerprint sama → replay.
      res3 = await payPosOrderCash(client, {
        propertyId: prop1,
        orderId: order1,
        idempotencyKey: KEY1, // sama dengan skenario 1
      });
    } catch (e) {
      code3 = e && e.code;
    }
    ok('S3: replay tak throw', res3 != null, `code=${code3}`);
    if (res3) {
      ok('S3: created=false & replayed=true',
        res3.created === false && res3.replayed === true,
        `created=${res3.created} replayed=${res3.replayed}`);
    }

    const afterCount3 = {
      settle: Number((await client.query(
        `SELECT COUNT(*) AS n FROM pos_settlements
         WHERE property_id = $1 AND pos_order_id = $2`, [prop1, order1])).rows[0].n),
      tx: Number((await client.query(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE property_id = $1 AND source_type = 'POS_ORDER' AND source_id = $2`,
        [prop1, String(order1)])).rows[0].n),
      audit: Number((await client.query(
        `SELECT COUNT(*) AS n FROM audit_logs
         WHERE module = 'POS' AND action = 'SETTLEMENT_CASH'
           AND record_id = ANY(SELECT id::text FROM pos_settlements
                               WHERE property_id = $1 AND pos_order_id = $2)`,
        [prop1, order1])).rows[0].n),
    };
    ok('S3: jumlah settlement tidak bertambah',
      afterCount3.settle === Number(preCount3.settle),
      `before=${preCount3.settle} after=${afterCount3.settle}`);
    ok('S3: jumlah SALE tidak bertambah',
      afterCount3.tx === Number(preCount3.tx),
      `before=${preCount3.tx} after=${afterCount3.tx}`);
    ok('S3: jumlah audit tidak bertambah',
      afterCount3.audit === Number(preCount3.audit),
      `before=${preCount3.audit} after=${afterCount3.audit}`);

    // ID settlement/SALE sama dengan yang pertama (tak ada baris baru).
    if (res3) {
      const sameSettle = Number((await client.query(
        `SELECT COUNT(*) AS n FROM pos_settlements
         WHERE property_id = $1 AND pos_order_id = $2`,
        [prop1, order1])).rows[0].n) === 1;
      ok('S3: settlement ID tidak bertambah (masih 1)', sameSettle);

      // ID settlement & ID SALE yang di-replay HARUS SAMA dengan pembayaran awal.
      const rep = await client.query(
        `SELECT id, transaction_id FROM pos_settlements
         WHERE property_id = $1 AND pos_order_id = $2`,
        [prop1, order1]);
      if (rep.rows.length === 1) {
        ok('S3: settlement ID replay = settlement pembayaran awal',
          Number(rep.rows[0].id) === Number(settleIdFirst),
          `replay=${rep.rows[0].id} first=${settleIdFirst}`);
        ok('S3: SALE ID replay = SALE pembayaran awal',
          Number(rep.rows[0].transaction_id) === Number(saleIdFirst),
          `replay=${rep.rows[0].transaction_id} first=${saleIdFirst}`);
      } else {
        ok('S3: settlement replay terbaca (1 baris)', false,
          `n=${rep.rows.length}`);
      }
    }

    // =====================================================================
    //  SKENARIO 4 — Key berbeda pada order settled: 409 ALREADY_PAID,
    //  tidak ada efek tambahan.
    // =====================================================================
    const before4 = {
      settle: Number((await client.query(
        `SELECT COUNT(*) AS n FROM pos_settlements
         WHERE property_id = $1 AND pos_order_id = $2`, [prop1, order1])).rows[0].n),
      tx: Number((await client.query(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE property_id = $1 AND source_type = 'POS_ORDER' AND source_id = $2`,
        [prop1, String(order1)])).rows[0].n),
      audit: Number((await client.query(
        `SELECT COUNT(*) AS n FROM audit_logs
         WHERE module = 'POS' AND action = 'SETTLEMENT_CASH'
           AND record_id = ANY(SELECT id::text FROM pos_settlements
                               WHERE property_id = $1 AND pos_order_id = $2)`,
        [prop1, order1])).rows[0].n),
    };
    const KEY4 = `s4-different-${RUN_ID}`.slice(0, 60);
    let res4 = null;
    let code4 = null;
    let statusCode4 = null;
    try {
      // Key BEDA pada order yang sudah settled → ALREADY_PAID.
      res4 = await payPosOrderCash(client, {
        propertyId: prop1,
        orderId: order1,
        idempotencyKey: KEY4,
      });
    } catch (e) {
      code4 = e && e.code;
      statusCode4 = e && e.statusCode;
    }
    ok('S4: throw PosSettlementError ALREADY_PAID',
      res4 == null && code4 === 'ALREADY_PAID',
      `res4=${res4 ? 'ada' : 'null'} code=${code4}`);
    ok('S4: statusCode 409', statusCode4 === 409, `statusCode=${statusCode4}`);
    const after4 = {
      settle: Number((await client.query(
        `SELECT COUNT(*) AS n FROM pos_settlements
         WHERE property_id = $1 AND pos_order_id = $2`, [prop1, order1])).rows[0].n),
      tx: Number((await client.query(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE property_id = $1 AND source_type = 'POS_ORDER' AND source_id = $2`,
        [prop1, String(order1)])).rows[0].n),
      audit: Number((await client.query(
        `SELECT COUNT(*) AS n FROM audit_logs
         WHERE module = 'POS' AND action = 'SETTLEMENT_CASH'
           AND record_id = ANY(SELECT id::text FROM pos_settlements
                               WHERE property_id = $1 AND pos_order_id = $2)`,
        [prop1, order1])).rows[0].n),
    };
    ok('S4: jumlah settlement tidak bertambah', after4.settle === before4.settle,
      `before=${before4.settle} after=${after4.settle}`);
    ok('S4: jumlah SALE tidak bertambah', after4.tx === before4.tx,
      `before=${before4.tx} after=${after4.tx}`);
    ok('S4: jumlah audit tidak bertambah', after4.audit === before4.audit,
      `before=${before4.audit} after=${after4.audit}`);

    // =====================================================================
    //  SKENARIO 5 — Key sama untuk dua order berbeda:
    //  keduanya menghasilkan settlement & SALE masing-masing;
    //  tidak saling mereplay.
    // =====================================================================
    const KEY5 = `s5-shared-${RUN_ID}`.slice(0, 60);
    const order5a = await createFixturePosOrder(client, propA, 40000);
    const order5b = await createFixturePosOrder(client, propA, 55000);

    let res5a = null, code5a = null;
    try {
      res5a = await payPosOrderCash(client, {
        propertyId: propA, orderId: order5a, idempotencyKey: KEY5,
      });
    } catch (e) { code5a = e && e.code; }

    let res5b = null, code5b = null;
    try {
      // KEY SAMA tapi order berbeda + fingerprint berbeda → BUKAN replay.
      res5b = await payPosOrderCash(client, {
        propertyId: propA, orderId: order5b, idempotencyKey: KEY5,
      });
    } catch (e) { code5b = e && e.code; }

    ok('S5: order A bayar sukses (created, bukan replay)',
      res5a != null && res5a.created === true && res5a.replayed === false,
      `code=${code5a}`);
    ok('S5: order B bayar sukses (created, bukan replay)',
      res5b != null && res5b.created === true && res5b.replayed === false,
      `code=${code5b}`);

    const c5 = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM pos_settlements WHERE property_id=$1 AND pos_order_id=$2) AS sa,
         (SELECT COUNT(*) FROM pos_settlements WHERE property_id=$1 AND pos_order_id=$3) AS sb,
          (SELECT COUNT(*) FROM transactions WHERE property_id=$1 AND source_type='POS_ORDER' AND source_id=$2::text) AS ta,
          (SELECT COUNT(*) FROM transactions WHERE property_id=$1 AND source_type='POS_ORDER' AND source_id=$3::text) AS tb
        `,
      [propA, order5a, order5b]);
    const r5 = c5.rows[0] || {};
    ok('S5: order A punya 1 settlement & 1 SALE',
      Number(r5.sa) === 1 && Number(r5.ta) === 1,
      `sa=${r5.sa} ta=${r5.ta}`);
    ok('S5: order B punya 1 settlement & 1 SALE',
      Number(r5.sb) === 1 && Number(r5.tb) === 1,
      `sb=${r5.sb} tb=${r5.tb}`);
    ok('S5: keduanya ber-key sama tapi tak saling mereplay',
      res5a != null && res5b != null &&
      res5a.created === true && res5b.created === true,
      `a:${res5a && res5a.created} b:${res5b && res5b.created}`);

    // S5: settlement ID & SALE ID kedua order HARUS BEDA (tak berbagi artefak).
    const id5 = await client.query(
      `SELECT
         (SELECT id FROM pos_settlements WHERE property_id=$1 AND pos_order_id=$2) AS sid_a,
         (SELECT id FROM pos_settlements WHERE property_id=$1 AND pos_order_id=$3) AS sid_b,
         (SELECT transaction_id FROM pos_settlements WHERE property_id=$1 AND pos_order_id=$2) AS txid_a,
         (SELECT transaction_id FROM pos_settlements WHERE property_id=$1 AND pos_order_id=$3) AS txid_b
        `,
      [propA, order5a, order5b]);
    const i5 = id5.rows[0] || {};
    ok('S5: settlement ID order A != order B',
      i5.sid_a != null && i5.sid_b != null && Number(i5.sid_a) !== Number(i5.sid_b),
      `sidA=${i5.sid_a} sidB=${i5.sid_b}`);
    ok('S5: SALE (transaction) ID order A != order B',
      i5.txid_a != null && i5.txid_b != null && String(i5.txid_a) !== String(i5.txid_b),
      `txA=${i5.txid_a} txB=${i5.txid_b}`);

    // =====================================================================
    //  SKENARIO 6 — Konkurensi: dua PoolClient TERPISAH, order fixture baru.
    //  a) Key sama    → tepat 1 created + 1 replay, ID settlement/SALE sama.
    //  b) Key berbeda → tepat 1 created + 1 409 ALREADY_PAID.
    //  Tiap order: tepat 1 SALE, 1 settlement, 1 audit SETTLEMENT_CASH.
    //  Promise.allSettled agar kedua operasi selesai SEBELUM cleanup.
    // =====================================================================
    // Client konkuren (scope outer `let` di main agar TETAP bisa di-release
    // di finally bila S6 gagal di tengah). `clientC/D` saat ini null.
    clientC = await pool.connect();
    clientD = await pool.connect();

    const KEY6A = `s6a-${RUN_ID}`.slice(0, 60); // key SAMA (kondisi a)
    const KEY6B = `s6b-${RUN_ID}`.slice(0, 60); // key BEDA  (kondisi b)

    const prop6 = await createFixtureProperty(client, 'S6');
    // (a) satu order, dua operasi dengan KEY SAMA → 1 created + 1 replay.
    const order6a = await createFixturePosOrder(client, prop6, 30000);
    // (b) satu order, dua operasi dengan KEY BERBEDA → 1 created + 1 409.
    const order6c = await createFixturePosOrder(client, prop6, 45000);

    const payCash = (cl, propertyId, orderId, key) =>
      payPosOrderCash(cl, { propertyId, orderId, idempotencyKey: key });

    // Kondisi (a): dua operasi PARALEL, KEY SAMA, ORDER SAMA → salah satu
    // created, satu lagi replay (fingerprint sama, settlement sama).
    const opA1 = payCash(clientC, prop6, order6a, KEY6A);
    const opA2 = payCash(clientD, prop6, order6a, KEY6A);
    const settledA = await Promise.allSettled([opA1, opA2]);

    // Kondisi (b): dua operasi PARALEL, KEY BERBEDA, ORDER SAMA.
    // Karena order sudah settled setelah yang pertama created, yang kedua
    // (key beda + order sudah punya settlement) → 409 ALREADY_PAID.
    const opB1 = payCash(clientC, prop6, order6c, KEY6B);
    const opB2 = payCash(clientD, prop6, order6c, KEY6B + '-x');
    const settledB = await Promise.allSettled([opB1, opB2]);

    const createdCount = (results, pred) =>
      results.filter((r) => r.status === 'fulfilled' && pred(r.value)).length;
    const rejectedCount = (results, pred) =>
      results.filter((r) => r.status === 'rejected' && pred(r.reason)).length;

    const createdA = createdCount(settledA, (v) => v.created === true);
    const replayedA = createdCount(settledA, (v) => v.replayed === true);
    ok('S6a: tepat 1 created & 1 replay (key sama, order sama)',
      createdA === 1 && replayedA === 1,
      `createdA=${createdA} replayedA=${replayedA} ` +
      `statuses=[${settledA.map((r) => r.status).join(',')}]`);

    const createdB = createdCount(settledB, (v) => v.created === true);
    const alreadyPaidB = rejectedCount(settledB, (e) => e && e.code === 'ALREADY_PAID');
    ok('S6b: tepat 1 created & 1 409 ALREADY_PAID (key beda, order sama)',
      createdB === 1 && alreadyPaidB === 1,
      `createdB=${createdB} alreadyPaidB=${alreadyPaidB} ` +
      `statuses=[${settledB.map((r) => r.status).join(',')}]`);

    // ID settlement/SALE yang created & replay pada (a) HARUS SAMA
    // (replay mengembalikan artefak yang sama, bukan baris baru).
    const s6a = await client.query(
      `SELECT id, transaction_id FROM pos_settlements
       WHERE property_id = $1 AND pos_order_id = $2`,
      [prop6, order6a]);
    ok('S6a: tepat 1 settlement untuk order6a (created+replay)',
      Number(s6a.rows.length) === 1, `n=${s6a.rows.length}`);
    if (s6a.rows.length === 1) {
      const s6aSettleId = Number(s6a.rows[0].id);
      const s6aSaleId = Number(s6a.rows[0].transaction_id);
      const valsA = settledA.map((r) => (r.status === 'fulfilled' ? r.value : null))
        .filter(Boolean);
      const createdVal = valsA.find((v) => v.created === true);
      const replayVal = valsA.find((v) => v.replayed === true);
      ok('S6a: settlement ID replay == created == DB',
        createdVal && replayVal &&
        Number(createdVal.settlement.id) === s6aSettleId &&
        Number(replayVal.settlement.id) === s6aSettleId,
        `created=${createdVal && createdVal.settlement.id} ` +
        `replay=${replayVal && replayVal.settlement.id} db=${s6aSettleId}`);
      ok('S6a: SALE ID replay == created == DB',
        createdVal && replayVal &&
        String(createdVal.sale.id) === String(s6aSaleId) &&
        String(replayVal.sale.id) === String(s6aSaleId),
        `created=${createdVal && createdVal.sale.id} ` +
        `replay=${replayVal && replayVal.sale.id} db=${s6aSaleId}`);
    }

    // Per order: tepat 1 SALE, 1 settlement, 1 audit SETTLEMENT_CASH.
    const perOrder = async (propertyId, orderId) => {
      const tx = await client.query(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE property_id=$1 AND source_type='POS_ORDER' AND source_id=$2`,
        [propertyId, String(orderId)]);
      const st = await client.query(
        `SELECT COUNT(*) AS n FROM pos_settlements
         WHERE property_id=$1 AND pos_order_id=$2`,
        [propertyId, orderId]);
      const au = await client.query(
        `SELECT COUNT(*) AS n FROM audit_logs
         WHERE module='POS' AND action='SETTLEMENT_CASH'
           AND record_id = ANY(SELECT id::text FROM pos_settlements
                               WHERE property_id=$1 AND pos_order_id=$2)`,
        [propertyId, orderId]);
      return { tx: Number(tx.rows[0].n), st: Number(st.rows[0].n),
               au: Number(au.rows[0].n) };
    };
    const p6a = await perOrder(prop6, order6a);
    const p6c = await perOrder(prop6, order6c);
    ok('S6a: order6a tepat 1 SALE, 1 settlement, 1 audit',
      p6a.tx === 1 && p6a.st === 1 && p6a.au === 1, JSON.stringify(p6a));
    ok('S6b: order6c tepat 1 SALE, 1 settlement, 1 audit',
      p6c.tx === 1 && p6c.st === 1 && p6c.au === 1, JSON.stringify(p6c));

    // ── Release client konkuren (S6); finally mengulang bila S6 gagal. ──
    try { clientC.release(); } catch (_) {}
    try { clientD.release(); } catch (_) {}
    clientC = null;
    clientD = null;

    // =====================================================================
    //  SKENARIO 7 — Penolakan: bukti TIDAK ADA artefak pembayaran baru &
    //  status order fixture TIDAK berubah.
    // =====================================================================
    const prop7 = await createFixtureProperty(client, 'S7');
    const order7 = await createFixturePosOrder(client, prop7, 60000);
    const KEY7 = `s7-${RUN_ID}`.slice(0, 60);

    const snap7 = async (propertyId, orderId) => {
      const tx = await client.query(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE property_id=$1 AND source_type='POS_ORDER' AND source_id=$2`,
        [propertyId, String(orderId)]);
      const st = await client.query(
        `SELECT COUNT(*) AS n FROM pos_settlements
         WHERE property_id=$1 AND pos_order_id=$2`,
        [propertyId, orderId]);
      const au = await client.query(
        `SELECT COUNT(*) AS n FROM audit_logs
         WHERE module='POS' AND action='SETTLEMENT_CASH'
           AND record_id = ANY(SELECT id::text FROM pos_settlements
                               WHERE property_id=$1 AND pos_order_id=$2)`,
        [propertyId, orderId]);
      return { tx: Number(tx.rows[0].n), st: Number(st.rows[0].n),
               au: Number(au.rows[0].n) };
    };
    const before7 = await snap7(prop7, order7);

    // 7.1 cross-property: property_id milik fixture utama ≠ pemilik order7 → 403.
    let r71 = null; let c71 = null; let sc71 = null;
    try {
      r71 = await payPosOrderCash(client, {
        propertyId: propA, // PROP LAIN, bukan pemilik order7
        orderId: order7,
        idempotencyKey: KEY7,
      });
    } catch (e) { c71 = e && e.code; sc71 = e && e.statusCode; }
    ok('S7.1: cross-property → 403 CROSS_PROPERTY_ORDER',
      r71 == null && c71 === 'CROSS_PROPERTY_ORDER' && sc71 === 403,
      `code=${c71} sc=${sc71}`);

    // 7.2 order tidak ada → 404 ORDER_NOT_FOUND.
    const ghostOrderId = 999999999; // pasti tidak ada
    let r72 = null; let c72 = null; let sc72 = null;
    try {
      r72 = await payPosOrderCash(client, {
        propertyId: prop7,
        orderId: ghostOrderId,
        idempotencyKey: KEY7,
      });
    } catch (e) { c72 = e && e.code; sc72 = e && e.statusCode; }
    ok('S7.2: order tak ada → 404 ORDER_NOT_FOUND',
      r72 == null && c72 === 'ORDER_NOT_FOUND' && sc72 === 404,
      `code=${c72} sc=${sc72}`);

    // 7.3 status bukan OPEN → 409 ORDER_NOT_PAYABLE.
    const order7closed = await createFixturePosOrder(client, prop7, 60000);
    await client.query(`UPDATE pos_orders SET status='VOIDED' WHERE id=$1`, [order7closed]);
    let r73 = null; let c73 = null; let sc73 = null;
    try {
      r73 = await payPosOrderCash(client, {
        propertyId: prop7,
        orderId: order7closed,
        idempotencyKey: KEY7,
      });
    } catch (e) { c73 = e && e.code; sc73 = e && e.statusCode; }
    ok('S7.3: status tidak OPEN → 409 ORDER_NOT_PAYABLE',
      r73 == null && c73 === 'ORDER_NOT_PAYABLE' && sc73 === 409,
      `code=${c73} sc=${sc73}`);
    const st73 = await client.query(
      `SELECT status FROM pos_orders WHERE id=$1`, [order7closed]);
    ok('S7.3: status order tetap VOIDED (tidak berubah)',
      String(st73.rows[0].status) === 'VOIDED', `status=${st73.rows[0].status}`);

    // 7.4 nominal nol → 422 INVALID_ORDER_AMOUNT.
    const order7zero = await createFixturePosOrder(client, prop7, 0);
    let r74 = null; let c74 = null; let sc74 = null;
    try {
      r74 = await payPosOrderCash(client, {
        propertyId: prop7,
        orderId: order7zero,
        idempotencyKey: KEY7,
      });
    } catch (e) { c74 = e && e.code; sc74 = e && e.statusCode; }
    ok('S7.4: nominal nol → 422 INVALID_ORDER_AMOUNT',
      r74 == null && c74 === 'INVALID_ORDER_AMOUNT' && sc74 === 422,
      `code=${c74} sc=${sc74}`);
    const st74 = await client.query(
      `SELECT status FROM pos_orders WHERE id=$1`, [order7zero]);
    ok('S7.4: status order tetap OPEN (tidak berubah)',
      String(st74.rows[0].status) === 'OPEN', `status=${st74.rows[0].status}`);

    // BUKTI: tidak ada settlement/SALE/audit pembayaran baru, status order7 utuh.
    const after7 = await snap7(prop7, order7);
    ok('S7: tidak ada settlement baru untuk order7',
      after7.st === before7.st, `before=${before7.st} after=${after7.st}`);
    ok('S7: tidak ada SALE baru untuk order7',
      after7.tx === before7.tx, `before=${before7.tx} after=${after7.tx}`);
    ok('S7: tidak ada audit SETTLEMENT_CASH baru untuk order7',
      after7.au === before7.au, `before=${before7.au} after=${after7.au}`);
    const st7main = await client.query(
      `SELECT status FROM pos_orders WHERE id=$1`, [order7]);
    ok('S7: status order7 tetap OPEN',
      String(st7main.rows[0].status) === 'OPEN',
      `status=${st7main.rows[0].status}`);

    // =====================================================================
    //  SKENARIO 8 — Fingerprint mismatch: settlement fixture SUDAH DIBAYAR,
    //  ubah request_fingerprint sementara. Replay key sama wajib 409
    //  IDEMPOTENCY_CONFLICT, tanpa artefak tambahan. Nilai awal dipulihkan
    //  di finally (registerRestore).
    //  Memakai order1 yang SUDAH settled di S1 (punya 1 settlement + 1 SALE).
    // =====================================================================
    const KEY8 = `s8-${RUN_ID}`.slice(0, 60);
    // order1 sudah settled (S1). Ambil settlement id & fingerprint awal.
    const s8set = await client.query(
      `SELECT id, request_fingerprint FROM pos_settlements
       WHERE property_id = $1 AND pos_order_id = $2`,
      [prop1, order1]);
    ok('S8: pre-condition — order1 sudah punya 1 settlement',
      s8set.rows.length === 1, `n=${s8set.rows.length}`);
    let s8OrigFp = null;
    let s8SettleId = null;
    if (s8set.rows.length === 1) {
      s8OrigFp = String(s8set.rows[0].request_fingerprint);
      s8SettleId = Number(s8set.rows[0].id);
      // Mutation sementara: ubah fingerprint (VARCHAR 128, valid schema).
      await client.query(
        `UPDATE pos_settlements SET request_fingerprint = $1 WHERE id = $2`,
        ['S8-' + s8OrigFp.slice(0, 10), s8SettleId]);
      registerRestore(async () => {
        await client.query(
          `UPDATE pos_settlements SET request_fingerprint = $1 WHERE id = $2`,
          [s8OrigFp, s8SettleId]);
      });

      // Snapshot jumlah artefak SEBELUM replay (harus tetap sama setelah).
      const pre8 = await client.query(
        `SELECT
           (SELECT COUNT(*) FROM pos_settlements WHERE property_id=$1 AND pos_order_id=$2) AS st,
           (SELECT COUNT(*) FROM transactions WHERE property_id=$1 AND source_type='POS_ORDER' AND source_id=$2::text) AS tx
         `,
        [prop1, order1]);

      // Replay KEY1 (sama) tapi fingerprint sekarang BERBEDA → IDEMPOTENCY_CONFLICT.
      let r8 = null; let c8 = null; let sc8 = null;
      try {
        r8 = await payPosOrderCash(client, {
          propertyId: prop1, orderId: order1, idempotencyKey: KEY1,
        });
      } catch (e) { c8 = e && e.code; sc8 = e && e.statusCode; }
      ok('S8: replay fingerprint-beda → 409 IDEMPOTENCY_CONFLICT',
        r8 == null && c8 === 'IDEMPOTENCY_CONFLICT' && sc8 === 409,
        `code=${c8} sc=${sc8}`);

      const post8 = await client.query(
        `SELECT
           (SELECT COUNT(*) FROM pos_settlements WHERE property_id=$1 AND pos_order_id=$2) AS st,
           (SELECT COUNT(*) FROM transactions WHERE property_id=$1 AND source_type='POS_ORDER' AND source_id=$2::text) AS tx
         `,
        [prop1, order1]);
      ok('S8: jumlah settlement tidak bertambah',
        Number(post8.rows[0].st) === Number(pre8.rows[0].st),
        `before=${pre8.rows[0].st} after=${post8.rows[0].st}`);
      ok('S8: jumlah SALE tidak bertambah',
        Number(post8.rows[0].tx) === Number(pre8.rows[0].tx),
        `before=${pre8.rows[0].tx} after=${post8.rows[0].tx}`);
    }

    // =====================================================================
    //  SKENARIO 9 — Replay dengan data tak sesuai: settlement method/status
    //  & SALE identitas/status/metode salah → replay DITOLAK, bukan sukses.
    //  ONLY fixture suite; TIDAK menonaktifkan constraint / mengubah schema.
    //  Catatan: constraint `chk_pos_settlements_status` = IN ('SUCCESS') &
    //  amount>0; `payment_method` & SALE bebas constraint. Maka jalur yang
    //  valid-schema utk uji validator replay:
    //    - settlement.payment_method diubah ke 'TRANSFER' (dipulihkan)
    //    - SALE.payment_status  diubah ke 'UNPAID'      (dipulihkan)
    //    - SALE.payment_method diubah ke 'TRANSFER'     (dipulihkan)
    //  (status settlement 'SUCCESS' SANGAT ditolak constraint bila diubah;
    //   karena itu TIDAK dicek — cukup method & field SALE yang bebas.)
    // =====================================================================
    const KEY9 = `s9-${RUN_ID}`.slice(0, 60);
    // order1 sudah settled (S1): punya settlement & SALE.
    const s9set = await client.query(
      `SELECT id, transaction_id, payment_method FROM pos_settlements
       WHERE property_id = $1 AND pos_order_id = $2`,
      [prop1, order1]);
    if (s9set.rows.length === 1) {
      const s9SettleId = Number(s9set.rows[0].id);
      const s9SaleId = String(s9set.rows[0].transaction_id);
      const s9OrigMethod = String(s9set.rows[0].payment_method);
      const s9saleBefore = await client.query(
        `SELECT payment_status, payment_method FROM transactions WHERE id = $1`,
        [s9SaleId]);
      const s9OrigTxStatus = String(s9saleBefore.rows[0].payment_status);
      const s9OrigTxMethod = String(s9saleBefore.rows[0].payment_method);

      // Ubah settlement.method → 'TRANSFER' (dipulihkan).
      await client.query(
        `UPDATE pos_settlements SET payment_method = 'TRANSFER' WHERE id = $1`,
        [s9SettleId]);
      registerRestore(async () => {
        await client.query(
          `UPDATE pos_settlements SET payment_method = $1 WHERE id = $2`,
          [s9OrigMethod, s9SettleId]);
      });

      // 9a) Replay dengan settlement.method tak sesuai → ditolak.
      //     KEY9 baru (belum pernah dipakai) → jalur created; tapi order
      //     sudah PAID & settled → 409 ALREADY_PAID (tak sampai validasi
      //     replay). Untuk benar-benar uji validasi REPLAY, pakai KEY1
      //     (key settlement existing) → jalur replay memvalidasi method.
      let r9a = null; let c9a = null;
      try {
        r9a = await payPosOrderCash(client, {
          propertyId: prop1, orderId: order1, idempotencyKey: KEY1,
        });
      } catch (e) { c9a = e && e.code; }
      ok('S9a: replay dengan settlement.method=TRANSFER ditolak (bukan sukses)',
        r9a == null && c9a != null, `code=${c9a}`);

      // Ubah SALE.payment_status → 'UNPAID' (dipulihkan).
      await client.query(
        `UPDATE transactions SET payment_status = 'UNPAID' WHERE id = $1`,
        [s9SaleId]);
      registerRestore(async () => {
        await client.query(
          `UPDATE transactions SET payment_status = $1 WHERE id = $2`,
          [s9OrigTxStatus, s9SaleId]);
      });
      // Reset method settlement ke asli dulu agar isolasi variabel status.
      await client.query(
        `UPDATE pos_settlements SET payment_method = $1 WHERE id = $2`,
        [s9OrigMethod, s9SettleId]);

      // 9b) Replay dengan SALE.payment_status tak sesuai → ditolak.
      let r9b = null; let c9b = null;
      try {
        r9b = await payPosOrderCash(client, {
          propertyId: prop1, orderId: order1, idempotencyKey: KEY1,
        });
      } catch (e) { c9b = e && e.code; }
      ok('S9b: replay dengan SALE.payment_status=UNPAID ditolak (bukan sukses)',
        r9b == null && c9b != null, `code=${c9b}`);

      // Reset status SALE ke asli, ubah SALE.payment_method → 'TRANSFER'.
      await client.query(
        `UPDATE transactions SET payment_status = $1 WHERE id = $2`,
        [s9OrigTxStatus, s9SaleId]);
      await client.query(
        `UPDATE transactions SET payment_method = 'TRANSFER' WHERE id = $1`,
        [s9SaleId]);
      registerRestore(async () => {
        await client.query(
          `UPDATE transactions SET payment_method = $1 WHERE id = $2`,
          [s9OrigTxMethod, s9SaleId]);
      });

      // 9c) Replay dengan SALE.payment_method tak sesuai → ditolak.
      let r9c = null; let c9c = null;
      try {
        r9c = await payPosOrderCash(client, {
          propertyId: prop1, orderId: order1, idempotencyKey: KEY1,
        });
      } catch (e) { c9c = e && e.code; }
      ok('S9c: replay dengan SALE.payment_method=TRANSFER ditolak (bukan sukses)',
        r9c == null && c9c != null, `code=${c9c}`);
    } else {
      ok('S9: pre-condition settlement order1 ada', false,
        `n=${s9set.rows.length}`);
    }

    // =====================================================================
    //  SKENARIO 10 — Rollback setelah UPDATE order & projection.
    //  Pembungkus query pada client khusus test: gagal HANYA saat
    //  INSERT pos_settlements (setelah projection selesai); teruskan
    //  query lain ke PoolClient asli. TIDAK menambah failpoint /
    //  mengubah runtime.
    //  Buktikan: titik gagal tercapai; order kembali OPEN; SALE,
    //  settlement & audit baru TIDAK tersisa.
    // =====================================================================
    const prop10 = await createFixtureProperty(client, 'S10');
    const order10 = await createFixturePosOrder(client, prop10, 88000);
    const KEY10 = `s10-${RUN_ID}`.slice(0, 60);

    // Snapshot artefak SEBELUM (harus tetap 0 setelah rollback).
    const s10pre = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM pos_settlements WHERE property_id=$1 AND pos_order_id=$2) AS st,
         (SELECT COUNT(*) FROM transactions WHERE property_id=$1 AND source_type='POS_ORDER' AND source_id=$2::text) AS tx,
         (SELECT COUNT(*) FROM audit_logs
            WHERE module='POS' AND action='SETTLEMENT_CASH'
              AND record_id = ANY(SELECT id::text FROM pos_settlements
                                  WHERE property_id=$1 AND pos_order_id=$2)) AS au
        `,
      [prop10, order10]);

    // Pembungkus query: teruskan ke PoolClient asli, kecuali INSERT
    // pos_settlements → suntikkan kegagalan (buktikan titik gagal tercapai).
    let failpointHit = 0;
    const failingClient = {
      query: async (sqlText, params) => {
        if (
          String(sqlText || '').trim().toUpperCase().includes(
            'INSERT INTO POS_SETTLEMENTS'
          )
        ) {
          failpointHit++;
          const e = new Error(
            'S10: failpoint — simulasi kegagalan INSERT pos_settlements'
          );
          e.code = '42000'; // syntactic error code, bukan unique violation
          throw e;
        }
        // Teruskan query lainnya ke client asli.
        return client.query(sqlText, params);
      },
      // Passthrough untuk API PoolClient lain bila service membutuhkannya.
      release() {},
      getClient: () => client,
    };

    let r10 = null; let e10 = null;
    try {
      r10 = await payPosOrderCash(failingClient, {
        propertyId: prop10, orderId: order10, idempotencyKey: KEY10,
      });
    } catch (e) {
      e10 = e;
    }

    ok('S10: titik kegagalan INSERT settlement tercapai (failpoint)',
      failpointHit >= 1, `hits=${failpointHit}`);
    ok('S10: pembayaran GAGAL (throw) karena INSERT settlement gagal',
      r10 == null && e10 != null,
      `result=${r10 ? 'ada (salah)' : 'null'} err=${e10 && e10.code}`);

    // Buktikan ROLLBACK: order kembali OPEN (bukan PAID).
    const st10 = await client.query(
      `SELECT status FROM pos_orders WHERE id = $1`, [order10]);
    ok('S10: order kembali OPEN setelah rollback',
      String(st10.rows[0].status) === 'OPEN', `status=${st10.rows[0].status}`);

    // Buktikan TIDAK ada SALE / settlement / audit baru.
    const s10post = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM pos_settlements WHERE property_id=$1 AND pos_order_id=$2) AS st,
         (SELECT COUNT(*) FROM transactions WHERE property_id=$1 AND source_type='POS_ORDER' AND source_id=$2::text) AS tx,
         (SELECT COUNT(*) FROM audit_logs
            WHERE module='POS' AND action='SETTLEMENT_CASH'
              AND record_id = ANY(SELECT id::text FROM pos_settlements
                                  WHERE property_id=$1 AND pos_order_id=$2)) AS au
        `,
      [prop10, order10]);
    ok('S10: settlement baru tidak tersisa',
      Number(s10post.rows[0].st) === Number(s10pre.rows[0].st),
      `pre=${s10pre.rows[0].st} post=${s10post.rows[0].st}`);
    ok('S10: SALE baru tidak tersisa (rollback projection)',
      Number(s10post.rows[0].tx) === Number(s10pre.rows[0].tx),
      `pre=${s10pre.rows[0].tx} post=${s10post.rows[0].tx}`);
    ok('S10: audit SETTLEMENT_CASH baru tidak tersisa',
      Number(s10post.rows[0].au) === Number(s10pre.rows[0].au),
      `pre=${s10pre.rows[0].au} post=${s10post.rows[0].au}`);
  } catch (err) {
    // Kegagalan tak terduga → tandai gagal.
    console.error('\n[EXCEPTION]', err && err.stack ? err.stack : err);
    failed++;
    failures.push('exception pada alur utama: ' + (err && err.message));
  } finally {
    // ── BAWAH HANDLER TERPIHAK: semua rilis resource dilakukan di sini, ───
    //    TETAP berjalan walau block cleanup di dalamnya throw.
    try {
      // Gate: kumpulkan artefak + cleanup + residue HANYA bila identitas DB
      // sudah terverifikasi (mencegah mutasi pada target yang tak diketahui).
      if (identityVerified) {
        // (0) Pulihkan SEMUA mutation sementara (S8/S9) SEBELUM cleanup,
        //     agar data fixture kembali ke nilai awal & residu tetap bersih.
        for (const op of restoreOps) {
          try {
            await op();
          } catch (roErr) {
            failed++;
            failures.push(
              'restore mutation gagal: ' + String(roErr && roErr.message)
            );
            console.error('[RESTORE] ' + String(roErr && roErr.message));
          }
        }
        restoreOps.length = 0;

        if (!cleanupDone) {
          // (a) KUMPULKAN artefak pembayaran melalui relasi source aktual,
          //     dari SELURUH order fixture ter-track (bukan hardcoded), di
          //     cleanupClient (masih dapat query), SEBELUM DELETE.
          //     Tetap berjalan walau skenario melempar exception di tengah.
          try {
            const allOrders = (Array.isArray(tracked.posOrders) ? tracked.posOrders : [])
              .filter((v) => v != null);
            await collectPaymentArtifacts(cleanupClient, allOrders);
          } catch (artErr) {
            failed++;
            failures.push(
              'kumpul artefak pembayaran gagal: ' +
              String(artErr && artErr.message)
            );
            console.error(
              '[ARTIFACTS] Gagal kumpulkan artefak: ' +
              String(artErr && artErr.message)
            );
          }

          // (b) DELETE per ID di SATU transaksi (FK-safe, per-ID run ini).
          const cr = await cleanupFixtures(cleanupClient);
          if (cr.error) {
            failed++;
            failures.push('cleanup gagal: ' + cr.error);
            console.error('[CLEANUP] GAGAL: ' + cr.error);
          } else {
            // Cetak ringkasan sukses cleanup (jumlah ID per tabel) eksplisit.
            const counts = {};
            for (const key of Object.keys(tracked)) {
              counts[key] = (Array.isArray(tracked[key]) ? tracked[key] : [])
                .filter((v) => v != null).length;
            }
            console.log(
              '[CLEANUP] Berhasil — ' +
              JSON.stringify(counts) +
              ' ID fixture dihapus (FK-safe, satu transaksi).'
            );
          }
          cleanupDone = true;
        }

        // ── RESIDU: pastikan seluruh ID tracked hilang. ─────────────────
        try {
          const residue = await verifyNoResidue(cleanupClient);
          if (residue.length) {
            failed++;
            failures.push('residu fixture: ' + residue.join(' | '));
            console.error('[RESIDUE] ' + residue.join(' | '));
          } else {
            // Cetak ringkasan residu 0 secara eksplisit.
            console.log('[RESIDUE] 0 — seluruh ID fixture run ini bersih.');
          }
        } catch (resErr) {
          failed++;
          failures.push('cek residu gagal: ' + String(resErr && resErr.message));
          console.error('[RESIDUE-CHECK] GAGAL: ' + String(resErr && resErr.message));
        }
      } else {
        // Identitas DB GAGAL/belum terverifikasi → TIDAK melakukan mutasi
        // (tidak DELETE/residue); tandai gagal eksplisit.
        failed++;
        failures.push('identitas DB tidak terverifikasi — cleanup dilewati');
        console.error('[GUARD] Identitas DB tidak terverifikasi — cleanup dilewati.');
      }
    } finally {
      // Rilis SEMUA client & tutup pool di semua jalur (termasuk bila
      // block cleanup di atas throw, termasuk client konkuren S6).
      try { if (clientC) { clientC.release(); } } catch (_) {}
      try { if (clientD) { clientD.release(); } } catch (_) {}
      try { client.release(); } catch (_) {}
      try { cleanupClient.release(); } catch (_) {}
      await pool.end().catch(() => {});
    }
  }

  // Ringkasan
  console.log(`\n[RESULT] ${passed} PASS, ${failed} FAIL`);
  if (failed > 0) {
    console.log('Gagal:');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
}

main().catch((err) => {
  console.error('[CRASH]', err && err.stack ? err.stack : err);
  // Pastikan pool ditutup bila main() gagal sebelum try/finally-nya.
  pool.end().catch(() => {});
  process.exitCode = 1;
});