/**
 * POS TRANSACTION DETAIL PAYMENT — Regresi getTransactionById
 *
 * Target: disposable PostgreSQL `oak_minibar_test` (host 127.0.0.1, port 15434).
 *
 * Uji getTransactionById untuk memverifikasi pemisahan pembayaran POS
 * (pos_settlements + payment_transactions by transaction_id) dari
 * pembayaran kamar (reservation-scoped) di response detail.
 *
 * Lima skenario:
 *   S1. POS standalone + settlement SUCCESS
 *   S2. POS terkait reservasi + settlement + pembayaran kamar
 *   S3. POS status PAID tanpa pembayaran tersimpan
 *   S4. Payment legacy langsung menunjuk SALE POS
 *   S5. Detail kamar (non-POS)
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
 *   node backend/test/pos_transaction_detail_payment_test.js
 */

'use strict';

// ─── 1. DB SAFETY GUARD (tanpa dotenv/fallback) ─────────────────────────────
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !testUrl.trim()) {
  console.error(
    'SAFETY: TEST_DATABASE_URL tidak di-set.\n' +
    'Jalankan: TEST_DATABASE_URL=postgres://USER:PASS@127.0.0.1:15434/oak_minibar_test ' +
    'node backend/test/pos_transaction_detail_payment_test.js'
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
    `[POS TX DETAIL PAYMENT TEST] Target DB: ${database} (user: ${user}, port: ${port})`
  );
} catch (e) {
  console.error('SAFETY: TEST_DATABASE_URL ditolak — ' + e.message);
  process.exit(1);
}

// ─── 2. Pool dari field eksplisit — tanpa connectionString, tanpa fallback ───
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  host: target.host,
  port: target.port,
  user: target.user,
  password: target.password,
  database: target.database,
  max: 5,
});

// ─── 3. Import HANYA reader dari dist — TANPA app/index / migration runner ─
const {
  getTransactionById,
} = require('../dist/domains/transactions/transactionService');

// ─── 4. Counter PASS/FAIL + tracking ID fixture ─────────────────────────────
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

// Tracking ID fixture untuk cleanup.
const tracked = {};
function track(key, id) {
  if (!tracked[key]) tracked[key] = [];
  if (id != null) tracked[key].push(id);
}

// ─── 5. Identifier unik per run ─────────────────────────────────────────────
const RUN_ID = String(Date.now()).slice(-8);
let propertyCodeCounter = 0;
let txNumberCounter = 0;
let orderNumberCounter = 0;
let folioEntryCounter = 0;

function nextOrderNumber() {
  orderNumberCounter++;
  return `PO${RUN_ID}${orderNumberCounter}`.slice(0, 50);
}

function nextTxNo() {
  txNumberCounter++;
  return `TX${RUN_ID}${txNumberCounter}`.slice(0, 50);
}

function nextFolioEntryId() {
  folioEntryCounter++;
  return `FE-${RUN_ID}-${folioEntryCounter}`.slice(0, 50);
}

// Prefix crypto acak 3 karakter (A-Z0-9), di-generate SEKALI per run.
const PROPERTY_CODE_PREFIX = (function makePropPrefix() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const buf = crypto.randomBytes(3);
  let out = '';
  for (let i = 0; i < 3; i += 1) {
    out += alphabet[buf[i] % alphabet.length];
  }
  return out;
})();
const PROPERTY_CODE_MAX = 36 ** 3; // 46656
const PROPERTY_CODE_GENERATED = new Set();

function nextPropertyCode() {
  if (propertyCodeCounter >= PROPERTY_CODE_MAX) {
    throw new Error(
      `nextPropertyCode: counter ${propertyCodeCounter} mencapai batas ${PROPERTY_CODE_MAX}`
    );
  }
  const code = PROPERTY_CODE_PREFIX + propertyCodeCounter.toString(36).toUpperCase().padStart(3, '0');
  propertyCodeCounter++;
  if (PROPERTY_CODE_GENERATED.has(code)) {
    throw new Error(`nextPropertyCode: kode duplikat dalam run: ${code}`);
  }
  PROPERTY_CODE_GENERATED.add(code);
  return code;
}

function nextBid() {
  return `BID${RUN_ID}${propertyCodeCounter}`.slice(0, 32).toUpperCase();
}

// ─── 5b. Helper fixture ──────────────────────────────────────────────────────

/**
 * Buat property fixture.
 * Kolom aktual: name, property_code (UNIQUE global, ^[A-Z0-9]{2,6}$),
 * timezone, currency_code, is_active.
 * @returns {Promise<number>} property id
 */
async function createFixtureProperty(client, label) {
  const code = nextPropertyCode();
  const q = await client.query(
    `INSERT INTO properties (name, property_code, timezone, currency_code, is_active)
     VALUES ($1, $2, 'Asia/Jakarta', 'IDR', TRUE) RETURNING id`,
    [`Prop-${label}-${RUN_ID}`, code]
  );
  const id = Number(q.rows[0].id);
  track('properties', id);
  return id;
}

/**
 * Buat chain reservasi terkait (room_categories → room_types → rooms → bookings → reservations).
 * property_id reservasi diturunkan dari bookings.property_id (reservations TIDAK punya kolom property_id).
 * BID disimpan saat INSERT bookings & dikembalikan — JANGAN di-UPDATE setelahnya
 * (trigger immutable).
 *
 * @returns {Promise<{roomCategory: number, roomType: number, room: number, booking: string, reservation: number, bid: string, folioEntryId: number}>}
 * bookingId adalah string karena bookings.id BIGINT.
 */
async function createReservationChain(client, propertyId, guestName, totalPrice) {
  // 1) room_categories
  const rcQ = await client.query(
    `INSERT INTO room_categories (property_id, code, name)
     VALUES ($1, $2, $2) RETURNING id`,
    [propertyId, `RC-${RUN_ID}`.slice(0, 50)]
  );
  const roomCategoryId = Number(rcQ.rows[0].id);
  track('roomCategories', roomCategoryId);

  // 2) room_types
  const rtQ = await client.query(
    `INSERT INTO room_types (
       property_id, code, name, room_category_id, capacity,
       max_adults, max_children, is_active, display_order, base_rate
     ) VALUES ($1, $2, $2, $3, 2, 2, 0, TRUE, 1, 500000) RETURNING id`,
    [propertyId, `RT-${RUN_ID}`.slice(0, 50), roomCategoryId]
  );
  const roomTypeId = Number(rtQ.rows[0].id);
  track('roomTypes', roomTypeId);

  // 3) rooms
  const rmQ = await client.query(
    `INSERT INTO rooms (property_id, room_number, room_type_id, is_active)
     VALUES ($1, $2, $3, TRUE) RETURNING id`,
    [propertyId, `R-${RUN_ID}`.slice(0, 10), roomTypeId]
  );
  const roomId = Number(rmQ.rows[0].id);
  track('rooms', roomId);

  // 4) bookings — BID disimpan & dikembalikan; tak diubah setelah INSERT.
  const bid = nextBid();
  const bkQ = await client.query(
    `INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status)
     VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [bid, propertyId, guestName]
  );
  const bookingId = String(bkQ.rows[0].id); // BIGINT → string
  track('bookings', bookingId);

  // 5) reservations — property_id diturunkan via bookings.property_id.
  const rsQ = await client.query(
    `INSERT INTO reservations (
       booking_id, room_id, status, stay_status,
       check_in, check_out, guest_name, stay_sequence,
       total_price, amount_paid, remaining_balance, payment_status
     )
     VALUES ($1, $2, 'BOOKED', 'RESERVED',
             CURRENT_DATE, CURRENT_DATE + 2, $3, 1,
             $4, 0, $4, 'UNPAID')
     RETURNING id`,
    [bookingId, roomId, guestName, totalPrice]
  );
  const reservationId = Number(rsQ.rows[0].id);
  track('reservations', reservationId);

  // 6) folio_entries — ID nyata, reservation_id & property_id sudah tersedia.
  const feRes = await client.query(
    `INSERT INTO folio_entries (
       reservation_id, property_id, entry_type, source_type, description,
       amount, direction, status
     ) VALUES (
       $1, $2, 'ROOM_CHARGE', 'ROOM_CHARGE', 'Kamar fixture',
       $3, 'DEBIT', 'POSTED'
     ) RETURNING id`,
    [reservationId, propertyId, totalPrice]
  );
  const folioEntryId = Number(feRes.rows[0].id);
  track('folioEntries', folioEntryId);

  return {
    roomCategory: roomCategoryId,
    roomType: roomTypeId,
    room: roomId,
    booking: bookingId, // string (BIGINT)
    reservation: reservationId,
    bid,
    folioEntryId,
  };
}

/**
 * Buat order POS.
 * Kolom aktual: property_id, order_number, status, total_amount, reservation_id (opsional).
 * @returns {Promise<number>} order id
 */
async function createFixturePosOrder(client, propertyId, totalAmount, reservationId) {
  const orderNumber = nextOrderNumber();
  const q = await client.query(
    `INSERT INTO pos_orders (property_id, order_number, status, total_amount, reservation_id)
     VALUES ($1, $2, 'OPEN', $3, $4) RETURNING id`,
    [propertyId, orderNumber, totalAmount, reservationId || null]
  );
  const id = Number(q.rows[0].id);
  track('posOrders', id);
  return id;
}

/**
 * Buat SALE transaction POS_ORDER terkait order.
 * source_id = String(orderId) sesuai kontrak projectPosOrderToTransaction.
 * @returns {Promise<string>} transaction id (BIGINT → string)
 */
async function createPosSaleTransaction(client, propertyId, orderId, totalAmount, reservationId, bookingId) {
  const txNo = nextTxNo();
  const description = `Pesanan Restoran / POS #${orderId}`;
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
       'SALE', 'POS_ORDER', $3, $4,
       'FNB_SALES', 'Restoran / F&B / POS', 'FNB', $5,
       $6, 0, 0, 0, $6,
       'PAID', 'CASH', 'POSTED',
       $7, $8, 'TEST'
     ) RETURNING id`,
    [propertyId, txNo, String(orderId), String(orderId), description, totalAmount, reservationId || null, bookingId || null]
  );
  const id = String(q.rows[0].id); // BIGINT → string
  track('transactions', id);
  return id;
}

/**
 * Buat SALE transaction kamar (ROOM_CHARGE) terkait reservasi.
 * source_id = String(folioEntryId) — identitas folio entry nyata.
 * @returns {Promise<string>} transaction id (BIGINT → string)
 */
async function createRoomSaleTransaction(client, propertyId, folioEntryId, reservationId, bookingId, amount) {
  const txNo = nextTxNo();
  const srcId = String(folioEntryId);
  const srcRef = `RES-${reservationId}`;
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
       $5, 0, 0, 0, $5,
       'UNPAID', NULL, 'POSTED',
       $6, $7, 'TEST'
     ) RETURNING id`,
    [propertyId, txNo, srcId, srcRef, amount, reservationId || null, bookingId || null]
  );
  const id = String(q.rows[0].id);
  track('transactions', id);
  return id;
}

/**
 * INSERT payment_transactions untuk pembayaran kamar (reservation-scoped).
 * reservation_id + booking_id di-set, scope='ROOM_RESERVATION'.
 * @returns {Promise<number>} payment_transactions id
 */
async function createRoomPayment(client, propertyId, reservationId, bookingId, amount, paymentMethod) {
  const refCode = `PT-ROOM-${RUN_ID}`;
  const q = await client.query(
    `INSERT INTO payment_transactions (
       property_id, transaction_id, reservation_id, booking_id,
       scope, transaction_type, amount, payment_method,
       reference_code, status, created_by, created_at
     ) VALUES (
       $1, NULL, $2, $3, 'ROOM_RESERVATION', 'PAYMENT', $4, $5, $6, 'SUCCESS', 'TEST', NOW()
     ) RETURNING id`,
    [propertyId, reservationId, bookingId, amount, paymentMethod || 'CASH', refCode]
  );
  const id = Number(q.rows[0].id);
  track('paymentTransactions', id);
  return id;
}

/**
 * INSERT pos_settlements untuk settlement POS.
 * Kolom aktual: property_id, pos_order_id, transaction_id, amount,
 * payment_method, status, idempotency_key, request_fingerprint, created_by.
 * FK: pos_order_id → pos_orders RESTRICT, transaction_id → transactions RESTRICT.
 * UNIQUE: pos_order_id (satu settlement per order).
 * @returns {Promise<number>} pos_settlements id
 */
async function createPosSettlement(client, propertyId, orderId, transactionId, amount, paymentMethod, createdBy) {
  const q = await client.query(
    `INSERT INTO pos_settlements (
       property_id, pos_order_id, transaction_id, amount,
       payment_method, status, idempotency_key, request_fingerprint, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, 'SUCCESS', $6, $7, $8
     ) RETURNING id`,
    [
      propertyId, orderId, transactionId, amount,
      paymentMethod || 'CASH',
      `IDEM-${RUN_ID}-${orderId}`, `FP-${RUN_ID}-${orderId}`,
      createdBy || 'TEST',
    ]
  );
  const id = Number(q.rows[0].id);
  track('posSettlements', id);
  return id;
}

/**
 * Snapshot jumlah artefak pembayaran/settlement/SALE untuk property tertentu.
 * Dipakai untuk membuktikan reader tak menambah baris.
 * @returns {Promise<{sales: number, settlements: number, payments: number}>}
 */
async function snapshotCounts(client, propertyId) {
  const q = await client.query(
    `SELECT
       (SELECT COUNT(*) FROM transactions
         WHERE property_id = $1::int AND deleted_at IS NULL) AS sales,
       (SELECT COUNT(*) FROM pos_settlements WHERE property_id = $1::int) AS settlements,
       (SELECT COUNT(*) FROM payment_transactions WHERE property_id = $1::int) AS payments`,
    [propertyId]
  );
  return {
    sales: Number(q.rows[0].sales),
    settlements: Number(q.rows[0].settlements),
    payments: Number(q.rows[0].payments),
  };
}

// ─── 6. Identity verified gate ───────────────────────────────────────────────
let identityVerified = false;

async function verifyDbIdentity(client) {
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
    throw new Error('pool.options mismatch dengan target');
  }

  const q = await client.query(`SELECT current_database() AS db, current_user AS usr`);
  const row = q.rows[0] || {};
  if (row.db !== target.database) {
    console.error(`[GUARD] current_database "${row.db}" != target "${target.database}"`);
    throw new Error('current_database mismatch');
  }
  if (row.usr !== target.user) {
    console.error(`[GUARD] current_user "${row.usr}" != target "${target.user}"`);
    throw new Error('current_user mismatch');
  }
  identityVerified = true;
  console.log(`[GUARD] Identitas DB terverifikasi: db=${row.db} user=${row.usr}`);
}

// ─── 7. Cleanup fixture (FK-safe, satu transaksi, hanya ID tracked) ─────────
async function cleanupFixtures(cleanupClient) {
  const ids = (key) =>
    Array.isArray(tracked[key]) ? tracked[key].filter((v) => v != null) : [];

  try {
    if (!identityVerified) {
      return { removed: 'skipped-unverified' };
    }

    await cleanupClient.query('BEGIN');

    // 0) Kumpulkan artefak anak sebelum hapus parent.
    {
      const pIds = ids('properties');
      if (pIds.length) {
        // pos_settlements milik property.
        const st = await cleanupClient.query(
          `SELECT id FROM pos_settlements WHERE property_id = ANY($1)`, [pIds]
        );
        for (const r of st.rows) track('posSettlements', Number(r.id));
        // payment_transactions milik property.
        const pt = await cleanupClient.query(
          `SELECT id FROM payment_transactions WHERE property_id = ANY($1)`, [pIds]
        );
        for (const r of pt.rows) track('paymentTransactions', Number(r.id));
      }
      // Transaksi tambahan milik property.
      const txIds = ids('transactions');
      if (txIds.length && pIds.length) {
        const extraTx = await cleanupClient.query(
          `SELECT id::text FROM transactions
           WHERE property_id = ANY($1::int[])
             AND (reversal_of_transaction_id = ANY($2::bigint[])
                  OR id = ANY($2::bigint[]))
             AND deleted_at IS NULL`,
          [pIds, txIds.map((t) => String(t))]
        );
        for (const r of extraTx.rows) track('transactions', r.id);
      }
      // pos_settlements anak milik order.
      const oIds = ids('posOrders');
      if (oIds.length) {
        const stByOrder = await cleanupClient.query(
          `SELECT id FROM pos_settlements WHERE pos_order_id = ANY($1)`, [oIds]
        );
        for (const r of stByOrder.rows) track('posSettlements', Number(r.id));
      }
      // payment_transactions anak milik transaction.
      if (txIds.length) {
        const ptByTx = await cleanupClient.query(
          `SELECT id FROM payment_transactions WHERE transaction_id = ANY($1::bigint[])`,
          [txIds.map((t) => String(t))]
        );
        for (const r of ptByTx.rows) track('paymentTransactions', Number(r.id));
      }
    }

    // 1) pos_settlements — FK RESTRICT ke orders & transactions
    {
      const q = ids('posSettlements');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM pos_settlements WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 2) payment_transactions — FK transaction_id SET NULL, booking_id RESTRICT
    {
      const q = ids('paymentTransactions');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM payment_transactions WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 3) transactions — FK property_id RESTRICT
    {
      const q = ids('transactions');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM transactions WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 4) transaction_daily_sequences
    {
      const p = ids('properties');
      if (p.length) {
        await cleanupClient.query(
          `DELETE FROM transaction_daily_sequences WHERE property_id = ANY($1)`, [p]
        );
      }
    }

    // 5) pos_orders — FK reservation_id, property_id
    {
      const q = ids('posOrders');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM pos_orders WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 6) folio_entries
    {
      const fe = ids('folioEntries');
      if (fe.length) {
        await cleanupClient.query(
          `DELETE FROM folio_entries WHERE id = ANY($1)`, [fe]
        );
      }
      const r = ids('reservations');
      if (r.length) {
        await cleanupClient.query(
          `DELETE FROM folio_entries WHERE reservation_id = ANY($1)`, [r]
        );
      }
    }

    // 7) reservations
    {
      const q = ids('reservations');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM reservations WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 8) bookings
    {
      const q = ids('bookings');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM bookings WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 9) rooms
    {
      const q = ids('rooms');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM rooms WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 10) room_types
    {
      const q = ids('roomTypes');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM room_types WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 11) room_categories
    {
      const q = ids('roomCategories');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM room_categories WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 12) audit_logs
    {
      const q = ids('properties');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM audit_logs WHERE property_id = ANY($1)`, [q]
        );
      }
    }

    // 13) properties — terakhir
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
    try {
      await cleanupClient.query('ROLLBACK');
    } catch (_) {
      /* abaikan */
    }
    return { removed: 'error', error: String((err && err.message) || err) };
  }
}

// ─── 8. Verify no residue ────────────────────────────────────────────────────
async function verifyNoResidue(residueClient) {
  const residue = [];
  const checks = [
    ['pos_settlements', 'id', 'posSettlements'],
    ['payment_transactions', 'id', 'paymentTransactions'],
    ['transactions', 'id', 'transactions'],
    ['pos_orders', 'id', 'posOrders'],
    ['folio_entries', 'id', 'folioEntries'],
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
    const params = table === 'transactions' ? q.map(String) : q;
    const res = await residueClient.query(
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${pk} = ANY($1)`,
      [params]
    );
    const n = Number(res.rows[0].n);
    if (n > 0) residue.push(`${table}: ${n} baris tersisa (id=${q.join(',')})`);
  }

  const props = (Array.isArray(tracked.properties) ? tracked.properties : []).filter(
    (v) => v != null
  );
  if (props.length) {
    const sweeps = [
      ['pos_settlements', 'Sweep property-scoped'],
      ['payment_transactions', 'Sweep property-scoped'],
      ['audit_logs', 'Sweep property-scoped'],
    ];
    for (const [table, label] of sweeps) {
      const r = await residueClient.query(
        `SELECT COUNT(*) AS n FROM ${table} WHERE property_id = ANY($1)`,
        [props]
      );
      const m = Number(r.rows[0].n);
      if (m > 0) residue.push(`${table}: ${m} baris tersisa (${label}, property=${props.join(',')})`);
    }
  }
  return residue;
}

// ─── 9. main() dengan cleanup + residu + finally ───────────────────────────
async function main() {
  let client = null;
  let cleanupClient = null;

  let mainError = null;
  let cleanupError = null;
  let residueError = null;

  try {
    client = await pool.connect();
    cleanupClient = await pool.connect();

    await verifyDbIdentity(client);

    if (!identityVerified) {
      throw new Error('identityVerified gate tidak terlewati');
    }

    // ── S1: POS standalone + settlement SUCCESS ──────────────────────────────
    // Order + SALE net=53000, satu pos_settlements SUCCESS/CASH 53000.
    // getTransactionById → paid_amount=53000, outstanding=0,
    // linked_payments tepat satu dari POS_SETTLEMENT, pos_settlements berisi
    // identitas SALE & order yang benar.
    {
      const propId = await createFixtureProperty(client, 'S1');
      const orderId = await createFixturePosOrder(client, propId, 53000, null);
      const txId = await createPosSaleTransaction(client, propId, orderId, 53000, null, null);
      const settlementId = await createPosSettlement(client, propId, orderId, txId, 53000, 'CASH', 'TEST');

      // Snapshot jumlah artefak sebelum reader pertama.
      const snap1Before = await snapshotCounts(client, propId);

      const s1Detail = await getTransactionById(pool, propId, txId);

      // paid_amount & outstanding_amount.
      ok(
        'S1 paid_amount=53000',
        Number(s1Detail.paid_amount) === 53000,
        `got ${s1Detail.paid_amount}`
      );
      ok(
        'S1 outstanding_amount=0',
        Number(s1Detail.outstanding_amount) === 0,
        `got ${s1Detail.outstanding_amount}`
      );

      // linked_payments: tepat satu entry, sumber POS_SETTLEMENT.
      const s1Payments = s1Detail.linked_payments || [];
      ok(
        'S1 linked_payments tepat satu',
        s1Payments.length === 1,
        `got ${s1Payments.length}`
      );
      if (s1Payments.length === 1) {
        const p = s1Payments[0];
        ok(
          'S1 linked_payments[0] source=POS_SETTLEMENT',
          p.source === 'POS_SETTLEMENT',
          `got ${p.source}`
        );
        ok(
          'S1 linked_payments[0] settlement_id eksak',
          String(p.settlement_id) === String(settlementId),
          `got ${p.settlement_id} want ${settlementId}`
        );
        ok(
          'S1 linked_payments[0] pos_order_id eksak',
          String(p.pos_order_id) === String(orderId),
          `got ${p.pos_order_id} want ${orderId}`
        );
        ok(
          'S1 linked_payments[0] amount=53000',
          Number(p.amount) === 53000,
          `got ${p.amount}`
        );
        ok(
          'S1 linked_payments[0] payment_method=CASH',
          p.payment_method === 'CASH',
          `got ${p.payment_method}`
        );
        ok(
          'S1 linked_payments[0] status=SUCCESS',
          p.status === 'SUCCESS',
          `got ${p.status}`
        );
        ok(
          'S1 linked_payments[0] created_by=TEST',
          p.created_by === 'TEST',
          `got ${p.created_by}`
        );
      }

      // pos_settlements field terpisah (raw array).
      const s1Settlements = s1Detail.pos_settlements || [];
      ok(
        'S1 pos_settlements tepat satu',
        s1Settlements.length === 1,
        `got ${s1Settlements.length}`
      );
      if (s1Settlements.length === 1) {
        const st = s1Settlements[0];
        ok(
          'S1 pos_settlements[0] settlement_id eksak',
          String(st.settlement_id) === String(settlementId),
          `got ${st.settlement_id} want ${settlementId}`
        );
        ok(
          'S1 pos_settlements[0] sale_id mengacu ke txId',
          String(st.sale_id) === String(txId),
          `got ${st.sale_id} want ${txId}`
        );
        ok(
          'S1 pos_settlements[0] pos_order_id eksak',
          String(st.pos_order_id) === String(orderId),
          `got ${st.pos_order_id} want ${orderId}`
        );
        ok(
          'S1 pos_settlements[0] amount=53000',
          Number(st.amount) === 53000,
          `got ${st.amount}`
        );
        ok(
          'S1 pos_settlements[0] settlement_status=SUCCESS',
          st.settlement_status === 'SUCCESS',
          `got ${st.settlement_status}`
        );
        ok(
          'S1 pos_settlements[0] property_id eksak',
          Number(st.property_id) === propId,
          `got ${st.property_id} want ${propId}`
        );
      }

      // Identitas transaksi.
      ok(
        'S1 tx.id mengacu ke txId',
        String(s1Detail.id) === String(txId),
        `got ${s1Detail.id}`
      );
      ok(
        'S1 tx.source_type=POS_ORDER',
        s1Detail.source_type === 'POS_ORDER',
        `got ${s1Detail.source_type}`
      );
      ok(
        'S1 tx.net_amount=53000',
        Number(s1Detail.net_amount) === 53000,
        `got ${s1Detail.net_amount}`
      );

      // Snapshot setelah reader pertama; jumlah artefak tak berubah.
      const snap1After = await snapshotCounts(client, propId);
      ok(
        'S1 jumlah SALE fixture tidak berubah',
        snap1Before.sales === snap1After.sales,
        `before=${snap1Before.sales} after=${snap1After.sales}`
      );
      ok(
        'S1 jumlah pos_settlements fixture tidak berubah',
        snap1Before.settlements === snap1After.settlements,
        `before=${snap1Before.settlements} after=${snap1After.settlements}`
      );
      ok(
        'S1 jumlah payment_transactions fixture tidak berubah',
        snap1Before.payments === snap1After.payments,
        `before=${snap1Before.payments} after=${snap1After.payments}`
      );

      // Panggil reader ulang — nilai & jumlah artefak harus identik.
      const s1Detail2 = await getTransactionById(pool, propId, txId);
      ok(
        'S1 ulang paid_amount tetap 53000',
        Number(s1Detail2.paid_amount) === 53000,
        `got ${s1Detail2.paid_amount}`
      );
      ok(
        'S1 ulang outstanding_amount tetap 0',
        Number(s1Detail2.outstanding_amount) === 0,
        `got ${s1Detail2.outstanding_amount}`
      );
      const s1Payments2 = s1Detail2.linked_payments || [];
      ok(
        'S1 ulang linked_payments tetap satu',
        s1Payments2.length === 1,
        `got ${s1Payments2.length}`
      );
      if (s1Payments2.length === 1) {
        ok(
          'S1 ulang linked_payments[0] settlement_id tetap eksak',
          String(s1Payments2[0].settlement_id) === String(settlementId),
          `got ${s1Payments2[0].settlement_id}`
        );
      }

      // Snapshot setelah reader kedua; jumlah artefak tetap tak berubah.
      const snap1After2 = await snapshotCounts(client, propId);
      ok(
        'S1 ulang jumlah SALE tetap tidak berubah',
        snap1Before.sales === snap1After2.sales,
        `before=${snap1Before.sales} after=${snap1After2.sales}`
      );
      ok(
        'S1 ulang jumlah settlement tetap tidak berubah',
        snap1Before.settlements === snap1After2.settlements,
        `before=${snap1Before.settlements} after=${snap1After2.settlements}`
      );
      ok(
        'S1 ulang jumlah payment tetap tidak berubah',
        snap1Before.payments === snap1After2.payments,
        `before=${snap1Before.payments} after=${snap1After2.payments}`
      );
    }

    // ── S2: POS terkait reservasi + settlement POS + pembayaran kamar ──────
    // Tagihan kamar 588000, pembayaran kamar 588000 (ROOM_RESERVATION scope).
    // POS SALE net=18000, settlement POS SUCCESS/CASH=18000.
    // Detail POS → paid_amount=18000, outstanding=0.
    // Riwayat hanya settlement POS; pembayaran kamar TIDAK masuk.
    // Field saldo canonical hotel tidak diisi untuk detail POS.
    // Identitas reservasi/booking tetap tersedia.
    {
      const propId2 = await createFixtureProperty(client, 'S2');
      const chain2 = await createReservationChain(client, propId2, 'Guest-S2', 588000);

      // Pembayaran kamar 588000 — reservation-scoped, bukan transaction-scoped.
      await createRoomPayment(client, propId2, chain2.reservation, chain2.booking, 588000, 'CASH');

      // SALE kamar terkait reservasi (untuk konteks, tidak diuji langsung di sini).
      await createRoomSaleTransaction(client, propId2, chain2.folioEntryId, chain2.reservation, chain2.booking, 588000);

      // POS order terkait reservasi.
      const orderId2 = await createFixturePosOrder(client, propId2, 18000, chain2.reservation);
      const txId2 = await createPosSaleTransaction(
        client, propId2, orderId2, 18000,
        chain2.reservation, chain2.booking
      );
      const settlementId2 = await createPosSettlement(
        client, propId2, orderId2, txId2, 18000, 'CASH', 'TEST'
      );

      // Snapshot jumlah artefak sebelum reader.
      const snap2Before = await snapshotCounts(client, propId2);

      const s2Detail = await getTransactionById(pool, propId2, txId2);

      // paid_amount & outstanding_amount — hanya dari settlement POS,
      // pembayaran kamar TIDAK dihitung.
      ok(
        'S2 paid_amount=18000',
        Number(s2Detail.paid_amount) === 18000,
        `got ${s2Detail.paid_amount}`
      );
      ok(
        'S2 outstanding_amount=0',
        Number(s2Detail.outstanding_amount) === 0,
        `got ${s2Detail.outstanding_amount}`
      );
      ok(
        'S2 net_amount=18000',
        Number(s2Detail.net_amount) === 18000,
        `got ${s2Detail.net_amount}`
      );

      // linked_payments: hanya settlement POS, bukan pembayaran kamar.
      const s2Payments = s2Detail.linked_payments || [];
      ok(
        'S2 linked_payments tepat satu (settlement POS saja)',
        s2Payments.length === 1,
        `got ${s2Payments.length}: ${JSON.stringify(s2Payments.map(p => p.source))}`
      );
      if (s2Payments.length === 1) {
        const p = s2Payments[0];
        ok(
          'S2 linked_payments[0] source=POS_SETTLEMENT',
          p.source === 'POS_SETTLEMENT',
          `got ${p.source}`
        );
        ok(
          'S2 linked_payments[0] settlement_id eksak',
          String(p.settlement_id) === String(settlementId2),
          `got ${p.settlement_id} want ${settlementId2}`
        );
        ok(
          'S2 linked_payments[0] pos_order_id eksak',
          String(p.pos_order_id) === String(orderId2),
          `got ${p.pos_order_id} want ${orderId2}`
        );
        ok(
          'S2 linked_payments[0] amount=18000',
          Number(p.amount) === 18000,
          `got ${p.amount}`
        );
        ok(
          'S2 linked_payments[0] payment_method=CASH',
          p.payment_method === 'CASH',
          `got ${p.payment_method}`
        );
        ok(
          'S2 linked_payments[0] status=SUCCESS',
          p.status === 'SUCCESS',
          `got ${p.status}`
        );
        ok(
          'S2 linked_payments[0] created_by=TEST',
          p.created_by === 'TEST',
          `got ${p.created_by}`
        );
      }

      // pos_settlements field terpisah.
      const s2Settlements = s2Detail.pos_settlements || [];
      ok(
        'S2 pos_settlements tepat satu',
        s2Settlements.length === 1,
        `got ${s2Settlements.length}`
      );
      if (s2Settlements.length === 1) {
        const st = s2Settlements[0];
        ok(
          'S2 pos_settlements[0] settlement_id eksak',
          String(st.settlement_id) === String(settlementId2),
          `got ${st.settlement_id} want ${settlementId2}`
        );
        ok(
          'S2 pos_settlements[0] sale_id mengacu ke txId2',
          String(st.sale_id) === String(txId2),
          `got ${st.sale_id} want ${txId2}`
        );
        ok(
          'S2 pos_settlements[0] pos_order_id eksak',
          String(st.pos_order_id) === String(orderId2),
          `got ${st.pos_order_id} want ${orderId2}`
        );
        ok(
          'S2 pos_settlements[0] amount=18000',
          Number(st.amount) === 18000,
          `got ${st.amount}`
        );
      }

      // Field saldo canonical hotel TIDAK diisi untuk detail POS.
      // calculateHotelCollectibleBalance tak dipanggil untuk isPosSource,
      // jadi field-field ini tidak ada di response.
      ok(
        'S2 hotel_collectible_total tidak ada (POS)',
        s2Detail.hotel_collectible_total === undefined || s2Detail.hotel_collectible_total === null,
        `got ${s2Detail.hotel_collectible_total}`
      );
      ok(
        'S2 canonical_amount_paid tidak ada (POS)',
        s2Detail.canonical_amount_paid === undefined || s2Detail.canonical_amount_paid === null,
        `got ${s2Detail.canonical_amount_paid}`
      );
      ok(
        'S2 hotel_collectible_remaining_balance tidak ada (POS)',
        s2Detail.hotel_collectible_remaining_balance === undefined || s2Detail.hotel_collectible_remaining_balance === null,
        `got ${s2Detail.hotel_collectible_remaining_balance}`
      );

      // Identitas reservasi/booking tetap tersedia pada response.
      ok(
        'S2 reservation_id terisi',
        Number(s2Detail.reservation_id) === chain2.reservation,
        `got ${s2Detail.reservation_id} want ${chain2.reservation}`
      );
      ok(
        'S2 booking_id terisi (BIGINT → string)',
        String(s2Detail.booking_id) === String(chain2.booking),
        `got ${s2Detail.booking_id} want ${chain2.booking}`
      );
      ok(
        'S2 booking_bid terisi',
        String(s2Detail.booking_bid || '').toUpperCase() === chain2.bid,
        `got ${s2Detail.booking_bid} want ${chain2.bid}`
      );
      ok(
        'S2 source_type=POS_ORDER',
        s2Detail.source_type === 'POS_ORDER',
        `got ${s2Detail.source_type}`
      );

      // Snapshot setelah reader pertama; jumlah artefak tak berubah.
      const snap2After = await snapshotCounts(client, propId2);
      ok(
        'S2 jumlah SALE fixture tidak berubah',
        snap2Before.sales === snap2After.sales,
        `before=${snap2Before.sales} after=${snap2After.sales}`
      );
      ok(
        'S2 jumlah pos_settlements fixture tidak berubah',
        snap2Before.settlements === snap2After.settlements,
        `before=${snap2Before.settlements} after=${snap2After.settlements}`
      );
      ok(
        'S2 jumlah payment_transactions fixture tidak berubah',
        snap2Before.payments === snap2After.payments,
        `before=${snap2Before.payments} after=${snap2After.payments}`
      );

      // Panggil reader ulang — nilai & jumlah artefak harus identik.
      const s2Detail2 = await getTransactionById(pool, propId2, txId2);
      ok(
        'S2 ulang paid_amount tetap 18000',
        Number(s2Detail2.paid_amount) === 18000,
        `got ${s2Detail2.paid_amount}`
      );
      ok(
        'S2 ulang outstanding_amount tetap 0',
        Number(s2Detail2.outstanding_amount) === 0,
        `got ${s2Detail2.outstanding_amount}`
      );
      const s2Payments2 = s2Detail2.linked_payments || [];
      ok(
        'S2 ulang linked_payments tetap satu',
        s2Payments2.length === 1,
        `got ${s2Payments2.length}`
      );
      if (s2Payments2.length === 1) {
        ok(
          'S2 ulang linked_payments[0] settlement_id tetap eksak',
          String(s2Payments2[0].settlement_id) === String(settlementId2),
          `got ${s2Payments2[0].settlement_id}`
        );
      }
      const snap2After2 = await snapshotCounts(client, propId2);
      ok(
        'S2 ulang jumlah SALE tetap tidak berubah',
        snap2Before.sales === snap2After2.sales,
        `before=${snap2Before.sales} after=${snap2After2.sales}`
      );
      ok(
        'S2 ulang jumlah settlement tetap tidak berubah',
        snap2Before.settlements === snap2After2.settlements,
        `before=${snap2Before.settlements} after=${snap2After2.settlements}`
      );
      ok(
        'S2 ulang jumlah payment tetap tidak berubah',
        snap2Before.payments === snap2After2.payments,
        `before=${snap2Before.payments} after=${snap2After2.payments}`
      );
    }

    // ── S3: POS status PAID tanpa pembayaran tersimpan ───────────────────────
    // Order & SALE berstatus PAID, tetapi TIDAK ada pos_settlements maupun
    // payment_transactions. Status PAID saja bukan bukti pembayaran.
    // paid_amount=0, outstanding_amount=40000, linked_payments kosong,
    // pos_settlements kosong.
    {
      const propId3 = await createFixtureProperty(client, 'S3');
      const orderId3 = await createFixturePosOrder(client, propId3, 40000, null);
      // Helper membuat status OPEN → update menjadi PAID.
      await client.query(
        `UPDATE pos_orders SET status = 'PAID' WHERE id = $1`,
        [orderId3]
      );
      const txId3 = await createPosSaleTransaction(client, propId3, orderId3, 40000, null, null);

      // TIDAK membuat pos_settlements atau payment_transactions.

      // Snapshot jumlah artefak sebelum reader pertama.
      const snap3Before = await snapshotCounts(client, propId3);

      const s3Detail = await getTransactionById(pool, propId3, txId3);

      // 1) ID transaksi, source_type, dan source_id sesuai fixture.
      ok(
        'S3 tx.id mengacu ke txId3',
        String(s3Detail.id) === String(txId3),
        `got ${s3Detail.id} want ${txId3}`
      );
      ok(
        'S3 tx.source_type=POS_ORDER',
        s3Detail.source_type === 'POS_ORDER',
        `got ${s3Detail.source_type}`
      );
      ok(
        'S3 tx.source_id=String(orderId3)',
        String(s3Detail.source_id) === String(orderId3),
        `got ${s3Detail.source_id} want ${orderId3}`
      );

      // 2) payment_status tetap PAID.
      ok(
        'S3 payment_status=PAID',
        s3Detail.payment_status === 'PAID',
        `got ${s3Detail.payment_status}`
      );

      // 3) paid_amount=0 (tidak ada pembayaran tersimpan).
      ok(
        'S3 paid_amount=0',
        Number(s3Detail.paid_amount) === 0,
        `got ${s3Detail.paid_amount}`
      );

      // 4) outstanding_amount=40000.
      ok(
        'S3 outstanding_amount=40000',
        Number(s3Detail.outstanding_amount) === 40000,
        `got ${s3Detail.outstanding_amount}`
      );

      // 5) linked_payments kosong.
      const s3Payments = s3Detail.linked_payments || [];
      ok(
        'S3 linked_payments kosong',
        s3Payments.length === 0,
        `got ${s3Payments.length}`
      );

      // 6) pos_settlements kosong.
      const s3Settlements = s3Detail.pos_settlements || [];
      ok(
        'S3 pos_settlements kosong',
        s3Settlements.length === 0,
        `got ${s3Settlements.length}`
      );

      // net_amount tetap 40000.
      ok(
        'S3 net_amount=40000',
        Number(s3Detail.net_amount) === 40000,
        `got ${s3Detail.net_amount}`
      );

      // Snapshot setelah reader pertama; jumlah artefak tak berubah.
      const snap3After = await snapshotCounts(client, propId3);
      ok(
        'S3 jumlah SALE fixture tidak berubah',
        snap3Before.sales === snap3After.sales,
        `before=${snap3Before.sales} after=${snap3After.sales}`
      );
      ok(
        'S3 jumlah pos_settlements fixture tidak berubah',
        snap3Before.settlements === snap3After.settlements,
        `before=${snap3Before.settlements} after=${snap3After.settlements}`
      );
      ok(
        'S3 jumlah payment_transactions fixture tidak berubah',
        snap3Before.payments === snap3After.payments,
        `before=${snap3Before.payments} after=${snap3After.payments}`
      );

      // Panggil reader ulang — nilai & jumlah artefak harus identik.
      const s3Detail2 = await getTransactionById(pool, propId3, txId3);
      ok(
        'S3 ulang paid_amount tetap 0',
        Number(s3Detail2.paid_amount) === 0,
        `got ${s3Detail2.paid_amount}`
      );
      ok(
        'S3 ulang outstanding_amount tetap 40000',
        Number(s3Detail2.outstanding_amount) === 40000,
        `got ${s3Detail2.outstanding_amount}`
      );
      const s3Payments2 = s3Detail2.linked_payments || [];
      ok(
        'S3 ulang linked_payments tetap kosong',
        s3Payments2.length === 0,
        `got ${s3Payments2.length}`
      );
      const s3Settlements2 = s3Detail2.pos_settlements || [];
      ok(
        'S3 ulang pos_settlements tetap kosong',
        s3Settlements2.length === 0,
        `got ${s3Settlements2.length}`
      );

      // Snapshot setelah reader kedua; jumlah artefak tetap tak berubah.
      const snap3After2 = await snapshotCounts(client, propId3);
      ok(
        'S3 ulang jumlah SALE tetap tidak berubah',
        snap3Before.sales === snap3After2.sales,
        `before=${snap3Before.sales} after=${snap3After2.sales}`
      );
      ok(
        'S3 ulang jumlah settlement tetap tidak berubah',
        snap3Before.settlements === snap3After2.settlements,
        `before=${snap3Before.settlements} after=${snap3After2.settlements}`
      );
      ok(
        'S3 ulang jumlah payment tetap tidak berubah',
        snap3Before.payments === snap3After2.payments,
        `before=${snap3Before.payments} after=${snap3After2.payments}`
      );
    }

    // ── S4: Payment legacy langsung menunjuk SALE POS ────────────────────────
    // payment_transactions (scope valid, transaction_id → SALE POS) tanpa
    // pos_settlements. paid_amount=15000, outstanding=25000,
    // linked_payments tepat satu dari PAYMENT_TRANSACTION.
    {
      const propId4 = await createFixtureProperty(client, 'S4');
      const orderId4 = await createFixturePosOrder(client, propId4, 40000, null);
      const txId4 = await createPosSaleTransaction(client, propId4, orderId4, 40000, null, null);

      // payment_transactions legacy: menunjuk SALE POS, tanpa reservation/booking.
      // scope='ROOM_RESERVATION' (default, memenuhi CHECK constraint).
      const refCode4 = `PT-POS-${RUN_ID}`;
      const pmtQ = await client.query(
        `INSERT INTO payment_transactions (
           property_id, transaction_id, reservation_id, booking_id,
           scope, transaction_type, amount, payment_method,
           reference_code, status, created_by, created_at
         ) VALUES (
           $1, $2, NULL, NULL, 'ROOM_RESERVATION', 'PAYMENT',
           $3, 'TRANSFER', $4, 'SUCCESS', 'TEST', NOW()
         ) RETURNING id`,
        [propId4, txId4, 15000, refCode4]
      );
      const pmtId4 = Number(pmtQ.rows[0].id);
      track('paymentTransactions', pmtId4);

      // TIDAK membuat pos_settlements.

      // Snapshot jumlah artefak sebelum reader pertama.
      const snap4Before = await snapshotCounts(client, propId4);

      const s4Detail = await getTransactionById(pool, propId4, txId4);

      // 1) ID transaksi, source_type, source_id sesuai fixture.
      ok(
        'S4 tx.id mengacu ke txId4',
        String(s4Detail.id) === String(txId4),
        `got ${s4Detail.id} want ${txId4}`
      );
      ok(
        'S4 tx.source_type=POS_ORDER',
        s4Detail.source_type === 'POS_ORDER',
        `got ${s4Detail.source_type}`
      );
      ok(
        'S4 tx.source_id=String(orderId4)',
        String(s4Detail.source_id) === String(orderId4),
        `got ${s4Detail.source_id} want ${orderId4}`
      );

      // 2) paid_amount=15000, outstanding_amount=25000.
      ok(
        'S4 paid_amount=15000',
        Number(s4Detail.paid_amount) === 15000,
        `got ${s4Detail.paid_amount}`
      );
      ok(
        'S4 outstanding_amount=25000',
        Number(s4Detail.outstanding_amount) === 25000,
        `got ${s4Detail.outstanding_amount}`
      );

      // 3) linked_payments tepat satu: PAYMENT_TRANSACTION.
      const s4Payments = s4Detail.linked_payments || [];
      ok(
        'S4 linked_payments tepat satu',
        s4Payments.length === 1,
        `got ${s4Payments.length}`
      );
      if (s4Payments.length === 1) {
        const p = s4Payments[0];
        ok(
          'S4 linked_payments[0] source=PAYMENT_TRANSACTION',
          p.source === 'PAYMENT_TRANSACTION',
          `got ${p.source}`
        );
        ok(
          'S4 linked_payments[0] payment_id sesuai fixture',
          String(p.payment_id) === String(pmtId4),
          `got ${p.payment_id} want ${pmtId4}`
        );
        ok(
          'S4 linked_payments[0] amount=15000',
          Number(p.amount) === 15000,
          `got ${p.amount}`
        );
        ok(
          'S4 linked_payments[0] payment_method=TRANSFER',
          p.payment_method === 'TRANSFER',
          `got ${p.payment_method}`
        );
        ok(
          'S4 linked_payments[0] status=SUCCESS',
          p.status === 'SUCCESS',
          `got ${p.status}`
        );
        ok(
          'S4 linked_payments[0] created_by=TEST',
          p.created_by === 'TEST',
          `got ${p.created_by}`
        );
        ok(
          'S4 linked_payments[0] reference_code sesuai fixture',
          String(p.reference_code) === refCode4,
          `got ${p.reference_code} want ${refCode4}`
        );
      }

      // 4) pos_settlements kosong.
      const s4Settlements = s4Detail.pos_settlements || [];
      ok(
        'S4 pos_settlements kosong',
        s4Settlements.length === 0,
        `got ${s4Settlements.length}`
      );

      // net_amount tetap 40000.
      ok(
        'S4 net_amount=40000',
        Number(s4Detail.net_amount) === 40000,
        `got ${s4Detail.net_amount}`
      );

      // Snapshot setelah reader pertama; jumlah artefak tak berubah.
      const snap4After = await snapshotCounts(client, propId4);
      ok(
        'S4 jumlah SALE fixture tidak berubah',
        snap4Before.sales === snap4After.sales,
        `before=${snap4Before.sales} after=${snap4After.sales}`
      );
      ok(
        'S4 jumlah pos_settlements fixture tidak berubah',
        snap4Before.settlements === snap4After.settlements,
        `before=${snap4Before.settlements} after=${snap4After.settlements}`
      );
      ok(
        'S4 jumlah payment_transactions fixture tidak berubah',
        snap4Before.payments === snap4After.payments,
        `before=${snap4Before.payments} after=${snap4After.payments}`
      );

      // Panggil reader ulang — nominal & identitas pembayaran harus identik.
      const s4Detail2 = await getTransactionById(pool, propId4, txId4);
      ok(
        'S4 ulang paid_amount tetap 15000',
        Number(s4Detail2.paid_amount) === 15000,
        `got ${s4Detail2.paid_amount}`
      );
      ok(
        'S4 ulang outstanding_amount tetap 25000',
        Number(s4Detail2.outstanding_amount) === 25000,
        `got ${s4Detail2.outstanding_amount}`
      );
      const s4Payments2 = s4Detail2.linked_payments || [];
      ok(
        'S4 ulang linked_payments tetap satu',
        s4Payments2.length === 1,
        `got ${s4Payments2.length}`
      );
      if (s4Payments2.length === 1) {
        ok(
          'S4 ulang linked_payments[0] payment_id tetap eksak',
          String(s4Payments2[0].payment_id) === String(pmtId4),
          `got ${s4Payments2[0].payment_id} want ${pmtId4}`
        );
      }
      const s4Settlements2 = s4Detail2.pos_settlements || [];
      ok(
        'S4 ulang pos_settlements tetap kosong',
        s4Settlements2.length === 0,
        `got ${s4Settlements2.length}`
      );

      // Snapshot setelah reader kedua; jumlah artefak tetap tak berubah.
      const snap4After2 = await snapshotCounts(client, propId4);
      ok(
        'S4 ulang jumlah SALE tetap tidak berubah',
        snap4Before.sales === snap4After2.sales,
        `before=${snap4Before.sales} after=${snap4After2.sales}`
      );
      ok(
        'S4 ulang jumlah settlement tetap tidak berubah',
        snap4Before.settlements === snap4After2.settlements,
        `before=${snap4Before.settlements} after=${snap4After2.settlements}`
      );
      ok(
        'S4 ulang jumlah payment tetap tidak berubah',
        snap4Before.payments === snap4After2.payments,
        `before=${snap4Before.payments} after=${snap4After2.payments}`
      );
    }

    // ── S5: Detail kamar (non-POS) ────────────────────────────────────────────
    // SALE ROOM_CHARGE via folio entry nyata, pembayaran kamar 200000
    // (reservation-scoped, transaction_id=NULL). paid_amount=200000,
    // outstanding=300000, linked_payments memuat pembayaran kamar,
    // field saldo canonical tersedia (total=500000, paid=200000,
    // remaining=300000). pos_settlements kosong.
    {
      const propId5 = await createFixtureProperty(client, 'S5');
      const chain5 = await createReservationChain(client, propId5, 'Guest-S5', 500000);

      // SALE kamar: source_id = folio entry nyata hasil helper.
      const txId5 = await createRoomSaleTransaction(
        client, propId5, chain5.folioEntryId, chain5.reservation, chain5.booking, 500000
      );

      // Pembayaran kamar 200000 — reservation-scoped, transaction_id=NULL.
      const pmtId5 = await createRoomPayment(
        client, propId5, chain5.reservation, chain5.booking, 200000, 'CASH'
      );

      // reference_code yang disimpan oleh helper createRoomPayment.
      const expectedRefCode5 = `PT-ROOM-${RUN_ID}`;

      // TIDAK membuat order POS atau pos_settlements.

      // Snapshot jumlah artefak sebelum reader pertama.
      const snap5Before = await snapshotCounts(client, propId5);

      const s5Detail = await getTransactionById(pool, propId5, txId5);

      // 1) ID/source_type/source_id dan reservation_id/booking_id sesuai fixture.
      ok(
        'S5 tx.id mengacu ke txId5',
        String(s5Detail.id) === String(txId5),
        `got ${s5Detail.id} want ${txId5}`
      );
      ok(
        'S5 tx.source_type=ROOM_CHARGE',
        s5Detail.source_type === 'ROOM_CHARGE',
        `got ${s5Detail.source_type}`
      );
      ok(
        'S5 tx.source_id=String(folioEntryId)',
        String(s5Detail.source_id) === String(chain5.folioEntryId),
        `got ${s5Detail.source_id} want ${chain5.folioEntryId}`
      );
      ok(
        'S5 reservation_id sesuai chain',
        Number(s5Detail.reservation_id) === chain5.reservation,
        `got ${s5Detail.reservation_id} want ${chain5.reservation}`
      );
      ok(
        'S5 booking_id sesuai chain (BIGINT → string)',
        String(s5Detail.booking_id) === String(chain5.booking),
        `got ${s5Detail.booking_id} want ${chain5.booking}`
      );

      // 2) paid_amount=200000, outstanding_amount=300000.
      ok(
        'S5 paid_amount=200000',
        Number(s5Detail.paid_amount) === 200000,
        `got ${s5Detail.paid_amount}`
      );
      ok(
        'S5 outstanding_amount=300000',
        Number(s5Detail.outstanding_amount) === 300000,
        `got ${s5Detail.outstanding_amount}`
      );
      ok(
        'S5 net_amount=500000',
        Number(s5Detail.net_amount) === 500000,
        `got ${s5Detail.net_amount}`
      );

      // 3) linked_payments memuat pembayaran kamar fixture.
      //    Kontrak non-POS: baris mentah payment_transactions (id, bukan payment_id).
      const s5Payments = s5Detail.linked_payments || [];
      ok(
        'S5 linked_payments tepat satu',
        s5Payments.length === 1,
        `got ${s5Payments.length}`
      );
      if (s5Payments.length === 1) {
        const p = s5Payments[0];
        ok(
          'S5 linked_payments[0] id sesuai fixture',
          String(p.id) === String(pmtId5),
          `got ${p.id} want ${pmtId5}`
        );
        ok(
          'S5 linked_payments[0] amount=200000',
          Number(p.amount) === 200000,
          `got ${p.amount}`
        );
        ok(
          'S5 linked_payments[0] payment_method=CASH',
          p.payment_method === 'CASH',
          `got ${p.payment_method}`
        );
        ok(
          'S5 linked_payments[0] status=SUCCESS',
          p.status === 'SUCCESS',
          `got ${p.status}`
        );
        ok(
          'S5 linked_payments[0] reference_code sesuai helper',
          String(p.reference_code) === expectedRefCode5,
          `got ${p.reference_code} want ${expectedRefCode5}`
        );
      }

      // 4) Field saldo canonical hotel tersedia & sesuai.
      //    hotel_collectible_total=500000, canonical_amount_paid=200000,
      //    hotel_collectible_remaining_balance=300000.
      ok(
        'S5 hotel_collectible_total=500000',
        Number(s5Detail.hotel_collectible_total) === 500000,
        `got ${s5Detail.hotel_collectible_total}`
      );
      ok(
        'S5 canonical_amount_paid=200000',
        Number(s5Detail.canonical_amount_paid) === 200000,
        `got ${s5Detail.canonical_amount_paid}`
      );
      ok(
        'S5 hotel_collectible_remaining_balance=300000',
        Number(s5Detail.hotel_collectible_remaining_balance) === 300000,
        `got ${s5Detail.hotel_collectible_remaining_balance}`
      );

      // 5) pos_settlements kosong (bukan sumber POS).
      const s5Settlements = s5Detail.pos_settlements || [];
      ok(
        'S5 pos_settlements kosong',
        s5Settlements.length === 0,
        `got ${s5Settlements.length}`
      );

      // Snapshot setelah reader pertama; jumlah artefak tak berubah.
      const snap5After = await snapshotCounts(client, propId5);
      ok(
        'S5 jumlah SALE fixture tidak berubah',
        snap5Before.sales === snap5After.sales,
        `before=${snap5Before.sales} after=${snap5After.sales}`
      );
      ok(
        'S5 jumlah pos_settlements fixture tidak berubah',
        snap5Before.settlements === snap5After.settlements,
        `before=${snap5Before.settlements} after=${snap5After.settlements}`
      );
      ok(
        'S5 jumlah payment_transactions fixture tidak berubah',
        snap5Before.payments === snap5After.payments,
        `before=${snap5Before.payments} after=${snap5After.payments}`
      );

      // Panggil reader ulang — nominal, saldo canonical & identitas pembayaran tetap sama.
      const s5Detail2 = await getTransactionById(pool, propId5, txId5);
      ok(
        'S5 ulang paid_amount tetap 200000',
        Number(s5Detail2.paid_amount) === 200000,
        `got ${s5Detail2.paid_amount}`
      );
      ok(
        'S5 ulang outstanding_amount tetap 300000',
        Number(s5Detail2.outstanding_amount) === 300000,
        `got ${s5Detail2.outstanding_amount}`
      );
      ok(
        'S5 ulang hotel_collectible_total tetap 500000',
        Number(s5Detail2.hotel_collectible_total) === 500000,
        `got ${s5Detail2.hotel_collectible_total}`
      );
      ok(
        'S5 ulang canonical_amount_paid tetap 200000',
        Number(s5Detail2.canonical_amount_paid) === 200000,
        `got ${s5Detail2.canonical_amount_paid}`
      );
      ok(
        'S5 ulang hotel_collectible_remaining_balance tetap 300000',
        Number(s5Detail2.hotel_collectible_remaining_balance) === 300000,
        `got ${s5Detail2.hotel_collectible_remaining_balance}`
      );
      const s5Payments2 = s5Detail2.linked_payments || [];
      ok(
        'S5 ulang linked_payments tetap satu',
        s5Payments2.length === 1,
        `got ${s5Payments2.length}`
      );
      if (s5Payments2.length === 1) {
        ok(
          'S5 ulang linked_payments[0] id tetap eksak',
          String(s5Payments2[0].id) === String(pmtId5),
          `got ${s5Payments2[0].id} want ${pmtId5}`
        );
      }
      const s5Settlements2 = s5Detail2.pos_settlements || [];
      ok(
        'S5 ulang pos_settlements tetap kosong',
        s5Settlements2.length === 0,
        `got ${s5Settlements2.length}`
      );

      // Snapshot setelah reader kedua; jumlah artefak tetap tak berubah.
      const snap5After2 = await snapshotCounts(client, propId5);
      ok(
        'S5 ulang jumlah SALE tetap tidak berubah',
        snap5Before.sales === snap5After2.sales,
        `before=${snap5Before.sales} after=${snap5After2.sales}`
      );
      ok(
        'S5 ulang jumlah settlement tetap tidak berubah',
        snap5Before.settlements === snap5After2.settlements,
        `before=${snap5Before.settlements} after=${snap5After2.settlements}`
      );
      ok(
        'S5 ulang jumlah payment tetap tidak berubah',
        snap5Before.payments === snap5After2.payments,
        `before=${snap5Before.payments} after=${snap5After2.payments}`
      );
    }

  } catch (err) {
    mainError = err;
    process.exitCode = 1;
    console.error('[ERROR] ' + (err && err.message ? err.message : err));
  } finally {
    if (identityVerified && cleanupClient) {
      const hasFixtures = Object.keys(tracked).some(
        (k) => Array.isArray(tracked[k]) && tracked[k].length > 0
      );
      if (hasFixtures) {
        // ── Blok 1: cleanupFixtures ─────────────────────────────────────────
        try {
          const cleanupResult = await cleanupFixtures(cleanupClient);
          if (cleanupResult.removed === 'error') {
            cleanupError = new Error(cleanupResult.error);
            console.error(`[CLEANUP ERROR] ${cleanupResult.error}`);
            process.exitCode = 1;
          }
        } catch (cleanupErr) {
          cleanupError = cleanupErr;
          console.error('[CLEANUP ERROR] ' + (cleanupErr && cleanupErr.message ? cleanupErr.message : cleanupErr));
          process.exitCode = 1;
        }

        // ── Blok 2: verifyNoResidue (tetap dicoba walau cleanup gagal) ──────
        try {
          const residue = await verifyNoResidue(cleanupClient);
          if (residue.length > 0) {
            residueError = new Error(residue.join('; '));
            console.error(`[RESIDU] ${residue.join('; ')}`);
            process.exitCode = 1;
          } else if (!cleanupError) {
            console.log('[CLEANUP] Semua fixture dibersihkan, residu = 0.');
          }
        } catch (residueErr) {
          residueError = residueErr;
          console.error('[RESIDU CHECK ERROR] ' + (residueErr && residueErr.message ? residueErr.message : residueErr));
          process.exitCode = 1;
        }
      }
    }

    // ── Pelepasan client & pool (selalu jalan) ──────────────────────────────
    if (client) { try { await client.release(); } catch (_) {} }
    if (cleanupClient) { try { await cleanupClient.release(); } catch (_) {} }
    try { await pool.end(); } catch (_) {}
  }

  if (mainError) {
    failed++;
    failures.push(`main error: ${mainError && mainError.message ? mainError.message : mainError}`);
  }
  if (cleanupError) {
    failed++;
    failures.push(`cleanup error: ${cleanupError && cleanupError.message ? cleanupError.message : cleanupError}`);
  }
  if (residueError) {
    failed++;
    failures.push(`residue error: ${residueError && residueError.message ? residueError.message : residueError}`);
  }

  console.log(`\n[POS TX DETAIL PAYMENT TEST] ${passed} PASS, ${failed} FAIL`);
  if (failed > 0) {
    for (const f of failures) console.log(`  FAIL: ${f}`);
    process.exitCode = 1;
  } else {
    console.log('[POS TX DETAIL PAYMENT TEST] Semua skenario lulus.');
  }
}

main().catch((err) => {
  console.error('[FATAL] ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
