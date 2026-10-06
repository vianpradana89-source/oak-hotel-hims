/**
 * POS SETTLEMENT READER — Regresi Reader paid_amount / outstanding_amount
 *
 * Target: disposable PostgreSQL `oak_minibar_test` (host 127.0.0.1, port 15434).
 * Uji reader getTransactions, getTransactionById, dan getBookingSalesDetail
 * untuk memverifikasi bahwa paid_amount pada POS sumber mencakup
 * payment_transactions + pos_settlements sesuai kontrak LATERAL JOIN.
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
 *   node backend/test/pos_settlement_reader_test.js
 */

'use strict';

// ─── 1. DB SAFETY GUARD (tanpa dotenv/fallback) ─────────────────────────────
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !testUrl.trim()) {
  console.error(
    'SAFETY: TEST_DATABASE_URL tidak di-set.\n' +
    'Jalankan: TEST_DATABASE_URL=postgres://USER:PASS@127.0.0.1:15434/oak_minibar_test ' +
    'node backend/test/pos_settlement_reader_test.js'
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
    `[POS SETTLEMENT READER TEST] Target DB: ${database} (user: ${user}, port: ${port})`
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
  max: 5, // dua client + 1 untuk cleanup → longgar
});

// ─── 3. Import HANYA reader dari dist — TANPA app/index / migration runner ─
const {
  getTransactions,
  getTransactionById,
  settleTransactionPayment,
} = require('../dist/domains/transactions/transactionService');
const { getBookingSalesDetail } = require('../dist/domains/transactions/bookingSalesDetailService');
const { payPosOrderCash } = require('../dist/domains/pos/posSettlementService');

// ─── 4. Counter PASS/FAIL + tracking ID fixture ──────────────────────────────
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

// ─── 5. Identifier unik per run ──────────────────────────────────────────────
const RUN_ID = String(Date.now()).slice(-8);
let orderNumberCounter = 0;
let propertyCodeCounter = 0;
let txNumberCounter = 0;

function nextOrderNumber() {
  orderNumberCounter++;
  return `PO${RUN_ID}${orderNumberCounter}`.slice(0, 50);
}

// Prefix crypto acak 3 karakter (A-Z0-9), di-generate SEKALI per run.
// Dipakai bersama counter base36 3 karakter untuk membentuk property_code
// tepat 6 karakter (memenuhi ^[A-Z0-9]{2,6}$) tanpa slice hasil akhir.
const PROPERTY_CODE_PREFIX = (function makePropPrefix() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const buf = crypto.randomBytes(3);
  let out = '';
  for (let i = 0; i < 3; i += 1) {
    out += alphabet[buf[i] % alphabet.length];
  }
  return out;
})();
const PROPERTY_CODE_MAX = 36 ** 3; // 46656 — batas counter base36 3 karakter
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

function nextTxNo() {
  txNumberCounter++;
  return `TX${RUN_ID}${txNumberCounter}`.slice(0, 50);
}

// ─── 6. Helper fixture ────────────────────────────────────────────────────────

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
 * (trigger immutable). Caller memakai `chain.bid` untuk pemanggilan reader.
 * @returns {Promise<{roomCategory: number, roomType: number, room: number, booking: number, reservation: number, bid: string}>}
 */
async function createReservationChain(client, propertyId, guestName) {
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
  const bookingId = Number(bkQ.rows[0].id);
  track('bookings', bookingId);

  // 5) reservations
  // reservations TIDAK punya kolom property_id — properti diturunkan via bookings.property_id.
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
    bid,
  };
}

/**
 * Buat order POS standalone (tanpa reservasi) atau terkait reservasi.
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
 *
 * Kontrak source aktual (projectFolioEntryToTransaction,
 * transactionService.ts baris 454, 564-568, 645):
 *   - source_type = 'ROOM_CHARGE' (dari entry.source_type || entry.entry_type)
 *   - source_id   = String(folioEntryId) — IDENTITAS FOLIO ENTRY, bukan kosong
 *   - ON CONFLICT (property_id, source_type, source_id) WHERE source_id IS NOT NULL
 *   - category_code = 'ROOM_SALES' (dari chargeType ROOM_CHARGE / STAY_EXTENSION)
 *   - source_reference = entry.bid || 'RES-' + reservation_id
 *
 * Untuk fixture: folio entry tak dibuat; pakai identifier sintetis unik
 * agar tidak bentrok dengan ON CONFLICT yang sudah ada di DB.
 * @returns {Promise<string>} transaction id (BIGINT → string)
 */
async function createRoomSaleTransaction(client, propertyId, reservationId, bookingId, amount, sourceIdHint) {
  const txNo = nextTxNo();
  const srcId = sourceIdHint || `FE-${RUN_ID}`; // sintetis, unik per run
  const srcRef = bookingId ? `RES-${reservationId}` : `RES-${reservationId}`;
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
  const id = String(q.rows[0].id); // BIGINT → string
  track('transactions', id);
  return id;
}

/**
 * INSERT payment_transactions.
 *
 * Kolom aktual (skema v2 + ALTER v3):
 *   - property_id     INTEGER REFERENCES properties(id) ON DELETE CASCADE
 *   - transaction_id  BIGINT REFERENCES transactions(id) ON DELETE SET NULL
 *   - reservation_id  INTEGER REFERENCES reservations(id) (NO ACTION default)
 *   - booking_id      BIGINT (FK RESTRICT, nullable)
 *   - scope           VARCHAR(32) NOT NULL DEFAULT 'ROOM_RESERVATION'
 *   - transaction_type VARCHAR(30) NOT NULL DEFAULT 'PAYMENT'
 *   - amount          DECIMAL(12,2) NOT NULL DEFAULT 0
 *   - payment_method  VARCHAR(30) DEFAULT 'CASH'
 *   - reference_code  VARCHAR(100)
 *   - status          VARCHAR(30) DEFAULT 'SUCCESS'
 *   - created_by      VARCHAR(100)
 *   - created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
 *
 * Dua penggunaan:
 *   1. Pembayaran kamar terkait reservation:
 *      reservation_id + booking_id di-set, scope='ROOM_RESERVATION'
 *   2. Pembayaran legacy POS terkait transaction_id secara eksplisit:
 *      transaction_id di-set, reservation_id/booking_id = null
 *      (JANGAN otomatis menghubungkan pembayaran POS ke reservation)
 *
 * @param {number} reservationId  — untuk pembayaran kamar; null untuk legacy POS
 * @param {number} bookingId      — untuk pembayaran kamar; null untuk legacy POS
 * @returns {Promise<number>} payment_transactions id
 */
async function createPaymentTransaction(
  client, propertyId, transactionId, amount, paymentMethod,
  reservationId, bookingId
) {
  const refCode = `PT-${RUN_ID}`;
  const q = await client.query(
    `INSERT INTO payment_transactions (
       property_id, transaction_id, reservation_id, booking_id,
       scope, transaction_type, amount, payment_method,
       reference_code, status, created_by, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, 'PAYMENT', $6, $7, $8, 'SUCCESS', 'TEST', NOW()
     ) RETURNING id`,
    [
      propertyId,
      transactionId,
      reservationId || null,
      bookingId || null,
      // scope: 'ROOM_RESERVATION' untuk pembayaran kamar,
      // 'BOOKING_GROUP' juga valid (CHECK constraint) tapi tak dipakai di sini.
      'ROOM_RESERVATION',
      amount,
      paymentMethod || 'CASH',
      refCode,
    ]
  );
  const id = Number(q.rows[0].id);
  track('paymentTransactions', id);
  return id;
}

/**
 * INSERT folio_entries untuk fixture SALE kamar.
 * Kolom aktual (skema + ALTER):
 *   reservation_id, property_id, entry_type, source_type, description,
 *   amount, direction, status, is_voided.
 * @returns {Promise<number>} folio_entries id
 */
async function createFolioEntry(client, reservationId, propertyId, entryType, amount) {
  const q = await client.query(
    `INSERT INTO folio_entries (
       reservation_id, property_id, entry_type, source_type, description,
       amount, direction, status
     ) VALUES (
       $1, $2, $3, $3, 'Fixture S3-S4', $4, 'DEBIT', 'POSTED'
     ) RETURNING id`,
    [reservationId, propertyId, entryType, amount]
  );
  const id = Number(q.rows[0].id);
  track('folioEntries', id);
  return id;
}

/**
 * INSERT pos_settlements untuk settlement POS.
 * Kolom aktual: property_id, pos_order_id, transaction_id, amount,
 * payment_method, status, idempotency_key, request_fingerprint, created_by.
 * FK: pos_order_id → pos_orders(id) RESTRICT, transaction_id → transactions(id) RESTRICT.
 * UNIQUE: pos_order_id (satu settlement per order).
 * @returns {Promise<number>} pos_settlements id
 */
async function createPosSettlement(client, propertyId, orderId, transactionId, amount) {
  const q = await client.query(
    `INSERT INTO pos_settlements (
       property_id, pos_order_id, transaction_id, amount,
       payment_method, status, idempotency_key, request_fingerprint, created_by
     ) VALUES (
       $1, $2, $3, $4, 'CASH', 'SUCCESS', $5, $6, 'TEST'
     ) RETURNING id`,
    [propertyId, orderId, transactionId, amount, `IDEM-${RUN_ID}-${orderId}`, `FP-${RUN_ID}-${orderId}`]
  );
  const id = Number(q.rows[0].id);
  track('posSettlements', id);
  return id;
}

// ─── 7. Cleanup fixture (FK-safe, satu transaksi, hanya ID tracked) ──────────

/**
 * Hapus seluruh fixture run ini dalam SATU transaksi pada cleanupClient.
 * Urutan hapus mengikuti FK aktual:
 *
 *   1. pos_settlements   → FK: pos_order_id → pos_orders RESTRICT
 *                         FK: transaction_id → transactions RESTRICT
 *   2. payment_transactions → FK: transaction_id → transactions SET NULL
 *                          (tetapi booking_id → bookings RESTRICT, jadi hapus sebelum bookings)
 *   3. transactions      → FK: property_id → properties RESTRICT
 *   4. transaction_daily_sequences → FK: property_id → properties CASCADE
 *   5. pos_orders        → FK: reservation_id → reservations (NO ACTION/RESTRICT)
 *                          FK: property_id → properties (NO ACTION/RESTRICT)
 *   6. folio_entries     → FK: reservation_id → reservations RESTRICT (aman, tak dibuat fixture)
 *   7. reservations      → FK: booking_id → bookings NO ACTION, room_id → rooms NO ACTION
 *   8. bookings          → FK: property_id → properties NO ACTION
 *   9. rooms             → FK: room_type_id → room_types, property_id → properties
 *  10. room_types        → FK: room_category_id → room_categories, property_id → properties
 *  11. room_categories   → FK: property_id → properties
 *  12. properties        → terakhir (semua RESTRICT/CASCADE sudah dibersihkan)
 *
 * @returns {Promise<{removed: string, error?: string}>}
 */
async function cleanupFixtures(cleanupClient) {
  const ids = (key) =>
    Array.isArray(tracked[key]) ? tracked[key].filter((v) => v != null) : [];

  try {
    if (!identityVerified) {
      // Jangan jalankan cleanup bila identitas DB belum terverifikasi.
      return { removed: 'skipped-unverified' };
    }

    await cleanupClient.query('BEGIN');

    // 0) Kumpulkan artefak writer milik fixture SEBELUM hapus parent.
    //    S5/S6 rejection seharusnya tak membuat baris baru; bila service gagal
    //    di tengah write path, rollback-nya sudah mengembalikan state — tapi
    //    amankan di sini: tambahkan settlement/payment/transaksi anak yang
    //    mengacu ke property/transaction/order tracked ke daftar hapus.
    //    Dilakukan pertama agar ID anak terambil sebelum parents terhapus.
    {
      const pIds = ids('properties');
      if (pIds.length) {
        // pos_settlements anak milik property fixture.
        const st = await cleanupClient.query(
          `SELECT id FROM pos_settlements WHERE property_id = ANY($1)`, [pIds]
        );
        for (const r of st.rows) track('posSettlements', Number(r.id));
        // payment_transactions anak milik property fixture.
        const pt = await cleanupClient.query(
          `SELECT id FROM payment_transactions WHERE property_id = ANY($1)`, [pIds]
        );
        for (const r of pt.rows) track('paymentTransactions', Number(r.id));
      }
      // Transaksi tambahan hasil writer yang mengacu ke SALE/transaction fixture.
      const txIds = ids('transactions');
      if (txIds.length) {
        const extraTx = await cleanupClient.query(
          `SELECT id::text FROM transactions
           WHERE property_id = ANY($1)
             AND (reversal_of_transaction_id = ANY($2::bigint[])
                  OR id = ANY($2::bigint[]))
             AND deleted_at IS NULL`,
          [pIds, txIds.map((t) => String(t))]
        );
        for (const r of extraTx.rows) track('transactions', r.id);
      }
      // pos_settlements anak milik order fixture (belt-and-suspenders).
      const oIds = ids('posOrders');
      if (oIds.length) {
        const stByOrder = await cleanupClient.query(
          `SELECT id FROM pos_settlements WHERE pos_order_id = ANY($1)`, [oIds]
        );
        for (const r of stByOrder.rows) track('posSettlements', Number(r.id));
      }
      // payment_transactions anak milik transaction fixture.
      if (txIds.length) {
        const ptByTx = await cleanupClient.query(
          `SELECT id FROM payment_transactions WHERE transaction_id = ANY($1::bigint[])`,
          [txIds.map((t) => String(t))]
        );
        for (const r of ptByTx.rows) track('paymentTransactions', Number(r.id));
      }
    }

    // 1) pos_settlements — hapus pertama (FK RESTRICT ke orders & transactions)
    {
      const q = ids('posSettlements');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM pos_settlements WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 2) payment_transactions — FK transaction_id SET NULL, booking_id RESTRICT.
    //    Hapus sebelum bookings agar RESTRICT tak menghalangi.
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

    // 5) pos_orders — FK reservation_id (NO ACTION/RESTRICT), property_id (NO ACTION/RESTRICT)
    {
      const q = ids('posOrders');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM pos_orders WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 6) folio_entries — hapus eksplisit oleh ID tracked (fixture S3-S4),
    //    lalu sweep oleh reservation_id untuk residu tak-ter-track.
    //    FK: reservation_id → reservations(id), property_id → properties(id).
    //    Harus sebelum reservations & properties.
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

    // 7) reservations — FK booking_id (NO ACTION), room_id (NO ACTION)
    {
      const q = ids('reservations');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM reservations WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 8) bookings → properties (NO ACTION)
    {
      const q = ids('bookings');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM bookings WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 9) rooms → room_types, properties
    {
      const q = ids('rooms');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM rooms WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 10) room_types → room_categories, properties
    {
      const q = ids('roomTypes');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM room_types WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 11) room_categories → properties
    {
      const q = ids('roomCategories');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM room_categories WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 12) audit_logs — FK property_id → properties RESTRICT, harus dihapus
    //     SEBELUM properties. Audit ditulis writer service (bukan fixture),
    //     tak ter-track per ID; hapus seluruhnya milik property run ini.
    {
      const q = ids('properties');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM audit_logs WHERE property_id = ANY($1)`, [q]
        );
      }
    }

    // 13) properties — terakhir (semua RESTRICT/CASCADE sudah dibersihkan).
    //     Artefak anak sudah dikumpulkan & dihapus di langkah 0-3, jadi tidak
    //     mengandalkan sweep setelah parent terhapus.
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
 * Verifikasi residu: seluruh ID tracked harus hilang.
 * @returns {Promise<string[]>} list ketidaksuaan (kosong = clean)
 */
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
    // transactions.id BIGINT → string; pos_settlements.transaction_id BIGINT → string.
    // payment_transactions.id SERIAL → number.
    const params = table === 'transactions' ? q.map(String) : q;
    const res = await residueClient.query(
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${pk} = ANY($1)`,
      [params]
    );
    const n = Number(res.rows[0].n);
    if (n > 0) residue.push(`${table}: ${n} baris tersisa (id=${q.join(',')})`);
  }

  // Sweep berbasis property: deteksi artefak writer (S5/S6 rejection
  // seharusnya tak membuat baris; bila ada, tandai sebagai residu).
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

// ─── 5. Identity verified gate ───────────────────────────────────────────────
let identityVerified = false;

async function verifyDbIdentity(client) {
  // pool.options HARUS PERSIS target (perbandingan eksak, tanpa toLowerCase).
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

  // current_database() / current_user() HARUS PERSIS target.
  // (TIDAK memakai inet_server_port() karena Docker memetakan host 15434
  //  → PostgreSQL internal 5432; pool.options.port adalah guard port-nya.)
  const q = await client.query(
    `SELECT current_database() AS db, current_user AS usr`
  );
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

// ─── 8. main() dengan cleanup + residu + finally ───────────────────────────
async function main() {
  // Client DEDICATED untuk skenario (verify identitas + fixture + pembacaan).
  // Deklarasi nullable: pool.connect() dilakukan di dalam try agar kegagalan
  // koneksi tidak meninggalkan client tak-ter-release.
  let client = null;
  // Client DEDICATED KEDUA untuk cleanup (jaga agar transaksi cleanup
  // tidak bercampur dengan transaksi skenario — aman bila skenario crash).
  let cleanupClient = null;

  let mainError = null;
  let cleanupError = null;

  try {
    // Hubungkan client di dalam try. Kegagalan koneksi tidak melakukan
    // release/pool.end di sini — penutupan resource terpusat pada finally
    // utama. Client yang gagal connect bernilai null dan dilewati di finally.
    client = await pool.connect();
    cleanupClient = await pool.connect();

    // Verifikasi guard SEBELUM mutasi apa pun.
    await verifyDbIdentity(client);

    // Gate: hanya jalankan skenario bila identitas terverifikasi.
    if (!identityVerified) {
      throw new Error('identityVerified gate tidak terlewati');
    }

    // ── S1: POS standalone tanpa pembayaran ──────────────────────────────────
    // Order + SALE nominal 53000, payment_status='PAID' tetapi TIDAK ada
    // payment_transactions / pos_settlements → paid_amount=0, outstanding=53000.
    {
      const propId = await createFixtureProperty(client, 'S1');
      const orderId = await createFixturePosOrder(client, propId, 53000, null);
      const txId = await createPosSaleTransaction(client, propId, orderId, 53000, null, null);

      // getTransactions — temukan baris berdasarkan id transaksi fixture.
      const listRes = await getTransactions(pool, {
        property_id: propId,
        source_type: 'POS_ORDER',
        transaction_type: 'SALE',
        limit: 50,
        offset: 0,
      });
      const s1InList = listRes.transactions.find(
        (row) => String(row.id) === String(txId)
      );
      ok(
        'S1 getTransactions menemukan tx oleh id',
        Boolean(s1InList),
        `id=${txId} tak ditemukan dalam ${listRes.transactions.length} baris`
      );
      ok(
        'S1 getTransactions paid_amount=0',
        s1InList && Number(s1InList.paid_amount) === 0,
        s1InList ? `got ${s1InList.paid_amount}` : 'row missing'
      );
      ok(
        'S1 getTransactions outstanding_amount=53000',
        s1InList && Number(s1InList.outstanding_amount) === 53000,
        s1InList ? `got ${s1InList.outstanding_amount}` : 'row missing'
      );

      // getTransactionById
      const s1Detail = await getTransactionById(pool, propId, txId);
      ok(
        'S1 getTransactionById paid_amount=0',
        Number(s1Detail.paid_amount) === 0,
        `got ${s1Detail.paid_amount}`
      );
      ok(
        'S1 getTransactionById outstanding_amount=53000',
        Number(s1Detail.outstanding_amount) === 53000,
        `got ${s1Detail.outstanding_amount}`
      );

      // Snapshot jumlah SALE fixture milik tx ini sebelum reader re-read.
      const snapshotBefore = await client.query(
        `SELECT
           (SELECT COUNT(*) FROM transactions
             WHERE property_id = $1::int AND source_type = 'POS_ORDER'
               AND source_id = $2::text AND deleted_at IS NULL) AS sales,
           (SELECT COUNT(*) FROM pos_settlements WHERE transaction_id = $3::bigint) AS settlements,
           (SELECT COUNT(*) FROM payment_transactions WHERE transaction_id = $3::bigint) AS payments`,
        [propId, String(orderId), txId]
      );

      // Panggil ulang reader untuk membuktikan jumlah fixture tidak bertambah.
      const listRes2 = await getTransactions(pool, {
        property_id: propId,
        source_type: 'POS_ORDER',
        transaction_type: 'SALE',
        limit: 50,
        offset: 0,
      });
      const s1InList2 = listRes2.transactions.find(
        (row) => String(row.id) === String(txId)
      );
      ok(
        'S1 getTransactions ulang paid_amount tetap 0',
        s1InList2 && Number(s1InList2.paid_amount) === 0,
        s1InList2 ? `got ${s1InList2.paid_amount}` : 'row missing'
      );
      ok(
        'S1 getTransactions ulang outstanding_amount tetap 53000',
        s1InList2 && Number(s1InList2.outstanding_amount) === 53000,
        s1InList2 ? `got ${s1InList2.outstanding_amount}` : 'row missing'
      );
      const s1Detail2 = await getTransactionById(pool, propId, txId);
      ok(
        'S1 getTransactionById ulang paid_amount tetap 0',
        Number(s1Detail2.paid_amount) === 0,
        `got ${s1Detail2.paid_amount}`
      );
      ok(
        'S1 getTransactionById ulang outstanding_amount tetap 53000',
        Number(s1Detail2.outstanding_amount) === 53000,
        `got ${s1Detail2.outstanding_amount}`
      );

      // Query ulang jumlah fixture setelah re-read; assert before = after.
      const snapshotAfter = await client.query(
        `SELECT
           (SELECT COUNT(*) FROM transactions
             WHERE property_id = $1::int AND source_type = 'POS_ORDER'
               AND source_id = $2::text AND deleted_at IS NULL) AS sales,
           (SELECT COUNT(*) FROM pos_settlements WHERE transaction_id = $3::bigint) AS settlements,
           (SELECT COUNT(*) FROM payment_transactions WHERE transaction_id = $3::bigint) AS payments`,
        [propId, String(orderId), txId]
      );
      ok(
        'S1 ulang: jumlah SALE fixture tidak berubah',
        Number(snapshotBefore.rows[0].sales) === Number(snapshotAfter.rows[0].sales),
        `before=${snapshotBefore.rows[0].sales} after=${snapshotAfter.rows[0].sales}`
      );
      ok(
        'S1 ulang: jumlah pos_settlements fixture tidak berubah',
        Number(snapshotBefore.rows[0].settlements) === Number(snapshotAfter.rows[0].settlements),
        `before=${snapshotBefore.rows[0].settlements} after=${snapshotAfter.rows[0].settlements}`
      );
      ok(
        'S1 ulang: jumlah payment_transactions fixture tidak berubah',
        Number(snapshotBefore.rows[0].payments) === Number(snapshotAfter.rows[0].payments),
        `before=${snapshotBefore.rows[0].payments} after=${snapshotAfter.rows[0].payments}`
      );
    }

    // ── S2: POS standalone dengan settlement ─────────────────────────────────
    // Order + SALE berbeda nominal 75000, satu pos_settlements SUCCESS/CASH.
    // Tidak ada payment_transactions → paid_amount=75000, outstanding=0.
    {
      const propId2 = await createFixtureProperty(client, 'S2');
      const orderId2 = await createFixturePosOrder(client, propId2, 75000, null);
      const txId2 = await createPosSaleTransaction(client, propId2, orderId2, 75000, null, null);
      const settlementId = await createPosSettlement(client, propId2, orderId2, txId2, 75000);

      // getTransactions
      const listRes2 = await getTransactions(pool, {
        property_id: propId2,
        source_type: 'POS_ORDER',
        transaction_type: 'SALE',
        limit: 50,
        offset: 0,
      });
      const s2InList = listRes2.transactions.find(
        (row) => String(row.id) === String(txId2)
      );
      ok(
        'S2 getTransactions menemukan tx oleh id',
        Boolean(s2InList),
        `id=${txId2} tak ditemukan dalam ${listRes2.transactions.length} baris`
      );
      ok(
        'S2 getTransactions paid_amount=75000',
        s2InList && Number(s2InList.paid_amount) === 75000,
        s2InList ? `got ${s2InList.paid_amount}` : 'row missing'
      );
      ok(
        'S2 getTransactions outstanding_amount=0',
        s2InList && Number(s2InList.outstanding_amount) === 0,
        s2InList ? `got ${s2InList.outstanding_amount}` : 'row missing'
      );

      // getTransactionById
      const s2Detail = await getTransactionById(pool, propId2, txId2);
      ok(
        'S2 getTransactionById paid_amount=75000',
        Number(s2Detail.paid_amount) === 75000,
        `got ${s2Detail.paid_amount}`
      );
      ok(
        'S2 getTransactionById outstanding_amount=0',
        Number(s2Detail.outstanding_amount) === 0,
        `got ${s2Detail.outstanding_amount}`
      );

      // Snapshot jumlah fixture S2 sebelum reader re-read.
      const snapshotBefore2 = await client.query(
        `SELECT
           (SELECT COUNT(*) FROM transactions
             WHERE property_id = $1::int AND source_type = 'POS_ORDER'
               AND source_id = $2::text AND deleted_at IS NULL) AS sales,
           (SELECT COUNT(*) FROM pos_settlements WHERE transaction_id = $3::bigint) AS settlements,
           (SELECT COUNT(*) FROM payment_transactions WHERE transaction_id = $3::bigint) AS payments`,
        [propId2, String(orderId2), txId2]
      );

      // Panggil ulang reader — jumlah fixture tidak berubah.
      const listRes3 = await getTransactions(pool, {
        property_id: propId2,
        source_type: 'POS_ORDER',
        transaction_type: 'SALE',
        limit: 50,
        offset: 0,
      });
      const s2InList2 = listRes3.transactions.find(
        (row) => String(row.id) === String(txId2)
      );
      ok(
        'S2 getTransactions ulang paid_amount tetap 75000',
        s2InList2 && Number(s2InList2.paid_amount) === 75000,
        s2InList2 ? `got ${s2InList2.paid_amount}` : 'row missing'
      );
      ok(
        'S2 getTransactions ulang outstanding_amount tetap 0',
        s2InList2 && Number(s2InList2.outstanding_amount) === 0,
        s2InList2 ? `got ${s2InList2.outstanding_amount}` : 'row missing'
      );
      const s2Detail2 = await getTransactionById(pool, propId2, txId2);
      ok(
        'S2 getTransactionById ulang paid_amount tetap 75000',
        Number(s2Detail2.paid_amount) === 75000,
        `got ${s2Detail2.paid_amount}`
      );
      ok(
        'S2 getTransactionById ulang outstanding_amount tetap 0',
        Number(s2Detail2.outstanding_amount) === 0,
        `got ${s2Detail2.outstanding_amount}`
      );

      // Query ulang jumlah fixture setelah re-read; assert before = after.
      const snapshotAfter2 = await client.query(
        `SELECT
           (SELECT COUNT(*) FROM transactions
             WHERE property_id = $1::int AND source_type = 'POS_ORDER'
               AND source_id = $2::text AND deleted_at IS NULL) AS sales,
           (SELECT COUNT(*) FROM pos_settlements WHERE transaction_id = $3::bigint) AS settlements,
           (SELECT COUNT(*) FROM payment_transactions WHERE transaction_id = $3::bigint) AS payments`,
        [propId2, String(orderId2), txId2]
      );
      ok(
        'S2 ulang: jumlah SALE fixture tidak berubah',
        Number(snapshotBefore2.rows[0].sales) === Number(snapshotAfter2.rows[0].sales),
        `before=${snapshotBefore2.rows[0].sales} after=${snapshotAfter2.rows[0].sales}`
      );
      ok(
        'S2 ulang: jumlah pos_settlements fixture tidak berubah',
        Number(snapshotBefore2.rows[0].settlements) === Number(snapshotAfter2.rows[0].settlements),
        `before=${snapshotBefore2.rows[0].settlements} after=${snapshotAfter2.rows[0].settlements}`
      );
      ok(
        'S2 ulang: jumlah payment_transactions fixture tidak berubah',
        Number(snapshotBefore2.rows[0].payments) === Number(snapshotAfter2.rows[0].payments),
        `before=${snapshotBefore2.rows[0].payments} after=${snapshotAfter2.rows[0].payments}`
      );
    }

    // ── S3: Pembayaran kamar tidak bocor ke POS ─────────────────────────────
    // Fixture satu booking/reservation:
    //   - folio_entry ROOM_CHARGE 500000 (DEBIT)
    //   - SALE kamar net=500000, source_id=String(folioEntryId)
    //   - payment_transactions scope=ROOM_RESERVATION amount=200000
    //   - POS A terkait reservation: net=53000, belum dibayar
    //   - POS B terkait reservation: net=75000, settlement SUCCESS 75000
    //   - Tidak ada deposit.
    {
      const propId3 = await createFixtureProperty(client, 'S3');
      const chain = await createReservationChain(client, propId3, 'Tamu-S3');
      const { reservation: reservationId, booking: bookingId, bid } = chain;
      // Assert kedua ID integer positif sebelum membuat fixture berikutnya.
      ok(
        'S3 reservationId integer positif',
        Number.isInteger(reservationId) && reservationId > 0,
        `got ${reservationId}`
      );
      ok(
        'S3 bookingId integer positif',
        Number.isInteger(bookingId) && bookingId > 0,
        `got ${bookingId}`
      );

      // Folio entry nyata untuk source_id SALE kamar.
      const folioEntryId = await createFolioEntry(client, reservationId, propId3, 'ROOM_CHARGE', 500000);

      // SALE kamar: source_type=ROOM_CHARGE, source_id=String(folioEntryId), net=500000.
      const roomTxId = await createRoomSaleTransaction(
        client, propId3, reservationId, bookingId, 500000, String(folioEntryId)
      );

      // Pembayaran kamar 200000 via payment_transactions (sumber yang dibaca
      // reservationFinancials — bukan hanya reservations.amount_paid).
      await createPaymentTransaction(
        client, propId3, null, 200000, 'CASH', reservationId, bookingId
      );

      // POS A terkait reservation: net=53000, belum dibayar.
      const orderA = await createFixturePosOrder(client, propId3, 53000, reservationId);
      const posATxId = await createPosSaleTransaction(
        client, propId3, orderA, 53000, reservationId, bookingId
      );

      // POS B terkait reservation: net=75000, settlement SUCCESS.
      const orderB = await createFixturePosOrder(client, propId3, 75000, reservationId);
      const posBTxId = await createPosSaleTransaction(
        client, propId3, orderB, 75000, reservationId, bookingId
      );
      await createPosSettlement(client, propId3, orderB, posBTxId, 75000);

      // ── S3: Reader daftar (grouping) & per-order ──────────────────────────
      // Filter source_type=POS_ORDER memilih booking yang memiliki minimal
      // satu transaksi POS (eligibility gate), tetapi total grouping tetap
      // mencakup seluruh anggota booking: SALE kamar + POS A + POS B.
      // Kontrak existing: b.bid = ANY(bids) memuat semua SALE anggota
      // setelah gate lolos; member filter tidak dilakukan.
      // Per-order: POS A (paid=0, outstanding=53000) & POS B (paid=75000,
      // outstanding=0) diverifikasi lewat getTransactionById.
      {
        // Per-order: POS A
        const posADetail = await getTransactionById(pool, propId3, posATxId);
        ok(
          'S3 POS A getTransactionById paid_amount=0',
          Number(posADetail.paid_amount) === 0,
          `got ${posADetail.paid_amount}`
        );
        ok(
          'S3 POS A getTransactionById outstanding_amount=53000',
          Number(posADetail.outstanding_amount) === 53000,
          `got ${posADetail.outstanding_amount}`
        );

        // Per-order: POS B
        const posBDetail = await getTransactionById(pool, propId3, posBTxId);
        ok(
          'S3 POS B getTransactionById paid_amount=75000',
          Number(posBDetail.paid_amount) === 75000,
          `got ${posBDetail.paid_amount}`
        );
        ok(
          'S3 POS B getTransactionById outstanding_amount=0',
          Number(posBDetail.outstanding_amount) === 0,
          `got ${posBDetail.outstanding_amount}`
        );

        // Grouping: cari baris booking_bid_group yang memuat ketiga ID
        // fixture (kamar + POS A + POS B) sebagai string (BIGINT dari pg).
        const listRes = await getTransactions(pool, {
          property_id: propId3,
          source_type: 'POS_ORDER',
          transaction_type: 'SALE',
          limit: 50,
          offset: 0,
        });
        const posGroupRow = listRes.transactions.find((row) => {
          const ids = row.booking_bid_group?.member_transaction_ids;
          if (!Array.isArray(ids)) return false;
          const set = new Set(ids.map((v) => String(v)));
          return set.has(String(roomTxId))
            && set.has(String(posATxId))
            && set.has(String(posBTxId));
        });
        ok(
          'S3 getTransactions menemukan grouping memuat kamar + POS A + POS B',
          Boolean(posGroupRow),
          `kamar=${roomTxId} POS A=${posATxId} POS B=${posBTxId} tak ditemukan bersama dalam ${listRes.transactions.length} baris`
        );
        if (posGroupRow) {
          const grp = posGroupRow.booking_bid_group;
          // Total booking lengkap (bukan hanya anggota yang cocok filter):
          // net = 500000 (kamar) + 53000 (POS A) + 75000 (POS B) = 628000
          ok(
            'S3 grouping booking_bid_group.net=628000',
            Number(grp.net) === 628000,
            `got ${grp.net}`
          );
          // paid = 200000 (kamar) + 0 (POS A) + 75000 (POS B) = 275000
          ok(
            'S3 grouping booking_bid_group.paid=275000',
            Number(grp.paid) === 275000,
            `got ${grp.paid}`
          );
          // remaining = 300000 (kamar) + 53000 (POS A) + 0 (POS B) = 353000
          ok(
            'S3 grouping booking_bid_group.remaining=353000',
            Number(grp.remaining) === 353000,
            `got ${grp.remaining}`
          );
        }
      }

      // ── S3: Reader SALE kamar (paid=200000, remaining=300000) ──────────
      {
        const roomDetail = await getTransactionById(pool, propId3, roomTxId);
        ok(
          'S3 SALE kamar getTransactionById paid_amount=200000',
          Number(roomDetail.paid_amount) === 200000,
          `got ${roomDetail.paid_amount}`
        );
        ok(
          'S3 SALE kamar getTransactionById outstanding_amount=300000',
          Number(roomDetail.outstanding_amount) === 300000,
          `got ${roomDetail.outstanding_amount}`
        );
      }

      // ── S4: Agregasi booking via getBookingSalesDetail ──────────────────
      {
        const detail = await getBookingSalesDetail(pool, propId3, bid);

        // financial: net kamar + POS = 500000 + 53000 + 75000 = 628000
        ok(
          'S4 getBookingSalesDetail financial.net=628000',
          Number(detail.financial.net) === 628000,
          `got ${detail.financial.net}`
        );
        // financial: paid = 200000 (kamar) + 0 (POS A) + 75000 (POS B) = 275000
        ok(
          'S4 getBookingSalesDetail financial.paid=275000',
          Number(detail.financial.paid) === 275000,
          `got ${detail.financial.paid}`
        );
        // financial: remaining = 300000 (kamar) + 53000 (POS A) + 0 (POS B) = 353000
        ok(
          'S4 getBookingSalesDetail financial.remaining=353000',
          Number(detail.financial.remaining) === 353000,
          `got ${detail.financial.remaining}`
        );

        // Verifikasi source_breakdown mengandung kategori POS.
        const posRows = detail.source_breakdown.filter(
          (row) => row.category === 'POS'
        );
        ok(
          'S4 source_breakdown mengandung kategori POS',
          posRows.length > 0,
          `categories: ${detail.source_breakdown.map((r) => r.category).join(',')}`
        );
        // POS net = 53000 + 75000 = 128000
        const posNet = posRows.reduce((sum, r) => sum + Number(r.net || 0), 0);
        ok(
          'S4 source_breakdown POS net=128000',
          posNet === 128000,
          `got ${posNet}`
        );

        // Verifikasi child berdasarkan field reservation ID aktual dari
        // return reader (BookingSalesChildRow.reservation_id), bukan index.
        const child = detail.children.find(
          (c) => Number(c.reservation_id) === Number(reservationId)
        );
        ok(
          'S4 child ditemukan oleh reservation_id',
          Boolean(child),
          `reservation_id=${reservationId} tak ditemukan (children=${detail.children.length})`
        );
        if (child) {
          ok(
            'S4 child.paid=275000',
            Number(child.paid) === 275000,
            `got ${child.paid}`
          );
          ok(
            'S4 child.remaining=353000',
            Number(child.remaining) === 353000,
            `got ${child.remaining}`
          );
          ok(
            'S4 child.net=628000',
            Number(child.net) === 628000,
            `got ${child.net}`
          );
        }

        // Batas API: getBookingSalesDetail TIDAK mengekspos rincian per-POS order
        // (hanya agregat source_breakdown by category). Rincian per order
        // tersedia hanya di getTransactions / getTransactionById.
        console.log(
          `  INFO  S4 getBookingSalesDetail: source_breakdown=${detail.source_breakdown.length} kategori, ` +
          `payments=${detail.payments.length} baris. Rincian per-POS tidak diekspos di sini.`
        );

        // ── S4: getTransactions booking_bid_group ──────────────────────────
        const listRes = await getTransactions(pool, {
          property_id: propId3,
          transaction_type: 'SALE',
          limit: 50,
          offset: 0,
        });
        // Cari baris yang memiliki booking_bid_group dengan bid fixture.
        const bidGroupRow = listRes.transactions.find(
          (row) => row.booking_bid_group && String(row.booking_bid_group.bid || '').toUpperCase() === bid
        );
        ok(
          'S4 getTransactions menemukan baris booking_bid_group',
          Boolean(bidGroupRow),
          `bid=${bid} tak ditemukan dalam ${listRes.transactions.length} baris`
        );
        if (bidGroupRow) {
          const grp = bidGroupRow.booking_bid_group;
          ok(
            'S4 booking_bid_group.net=628000',
            Number(grp.net) === 628000,
            `got ${grp.net}`
          );
          ok(
            'S4 booking_bid_group.paid=275000',
            Number(grp.paid) === 275000,
            `got ${grp.paid}`
          );
          ok(
            'S4 booking_bid_group.remaining=353000',
            Number(grp.remaining) === 353000,
            `got ${grp.remaining}`
          );
        }

        // ── Panggil ulang reader: hasil sama, jumlah artefak tak bertambah ─
        // Snapshot jumlah fixture S4 (SALE + settlement + payment) SEBELUM re-read.
        const snapshotBefore4 = await client.query(
          `SELECT
             (SELECT COUNT(*) FROM transactions
               WHERE property_id = $1::int AND booking_id = $2 AND transaction_type = 'SALE'
                 AND deleted_at IS NULL) AS sales,
             (SELECT COUNT(*) FROM pos_settlements WHERE transaction_id IN ($3::bigint, $4::bigint)) AS settlements,
             (SELECT COUNT(*) FROM payment_transactions
               WHERE reservation_id = $5 AND scope = 'ROOM_RESERVATION') AS payments`,
          [propId3, bookingId, posATxId, posBTxId, reservationId]
        );

        const detail2 = await getBookingSalesDetail(pool, propId3, bid);
        ok(
          'S4 getBookingSalesDetail ulang net tetap 628000',
          Number(detail2.financial.net) === 628000,
          `got ${detail2.financial.net}`
        );
        ok(
          'S4 getBookingSalesDetail ulang paid tetap 275000',
          Number(detail2.financial.paid) === 275000,
          `got ${detail2.financial.paid}`
        );
        ok(
          'S4 getBookingSalesDetail ulang remaining tetap 353000',
          Number(detail2.financial.remaining) === 353000,
          `got ${detail2.financial.remaining}`
        );

        // Query ulang jumlah fixture setelah re-read; assert before = after.
        const snapshotAfter4 = await client.query(
          `SELECT
             (SELECT COUNT(*) FROM transactions
               WHERE property_id = $1::int AND booking_id = $2 AND transaction_type = 'SALE'
                 AND deleted_at IS NULL) AS sales,
             (SELECT COUNT(*) FROM pos_settlements WHERE transaction_id IN ($3::bigint, $4::bigint)) AS settlements,
             (SELECT COUNT(*) FROM payment_transactions
               WHERE reservation_id = $5 AND scope = 'ROOM_RESERVATION') AS payments`,
          [propId3, bookingId, posATxId, posBTxId, reservationId]
        );
        ok(
          'S4 ulang: jumlah SALE fixture tidak berubah',
          Number(snapshotBefore4.rows[0].sales) === Number(snapshotAfter4.rows[0].sales),
          `before=${snapshotBefore4.rows[0].sales} after=${snapshotAfter4.rows[0].sales}`
        );
        ok(
          'S4 ulang: jumlah pos_settlements fixture tidak berubah',
          Number(snapshotBefore4.rows[0].settlements) === Number(snapshotAfter4.rows[0].settlements),
          `before=${snapshotBefore4.rows[0].settlements} after=${snapshotAfter4.rows[0].settlements}`
        );
        ok(
          'S4 ulang: jumlah payment_transactions kamar tidak berubah',
          Number(snapshotBefore4.rows[0].payments) === Number(snapshotAfter4.rows[0].payments),
          `before=${snapshotBefore4.rows[0].payments} after=${snapshotAfter4.rows[0].payments}`
        );
      }
    }

    // ── S5: Pelunasan manual menolak transaksi POS ──────────────────────────
    // settleTransactionPayment(pool, id, dto) memuat guard: source_type
    // POS_ORDER/POS → 409 POS_PAYMENT_ROUTE_REQUIRED (harus lewat pembayaran POS).
    // Seluruh fixture S5a + S5b dibuat terlebih dahulu, baru snapshot diambil
    // SEBELUM pemanggilan writer, lalu dibandingkan SETELAH kedua request.
    // Status & nominal SALE + order diverifikasi eksplisit (bukan hanya jumlah).
    {
      const propId5 = await createFixtureProperty(client, 'S5');

      // ── Buat seluruh fixture S5a & S5b terlebih dahulu ─────────────────────
      // S5a: POS tanpa settlement.
      const order5a = await createFixturePosOrder(client, propId5, 40000, null);
      const tx5a = await createPosSaleTransaction(client, propId5, order5a, 40000, null, null);

      // S5b: POS dengan settlement SUCCESS.
      const order5b = await createFixturePosOrder(client, propId5, 60000, null);
      const tx5b = await createPosSaleTransaction(client, propId5, order5b, 60000, null, null);
      const settle5bId = await createPosSettlement(client, propId5, order5b, tx5b, 60000);
      void settle5bId;

      // Snapshot SETELAH fixture lengkap, SEBELUM pemanggilan writer.
      const snap5Before = await client.query(
        `SELECT
           (SELECT COUNT(*) FROM pos_orders WHERE property_id = $1::int) AS orders,
           (SELECT COUNT(*) FROM transactions
             WHERE property_id = $1::int AND source_type = 'POS_ORDER'
               AND transaction_type = 'SALE' AND deleted_at IS NULL) AS sales,
           (SELECT COUNT(*) FROM payment_transactions WHERE property_id = $1::int) AS payments,
           (SELECT COUNT(*) FROM pos_settlements WHERE property_id = $1::int) AS settlements,
           (SELECT COUNT(*) FROM audit_logs WHERE property_id = $1::int) AS audits,
           (SELECT status FROM pos_orders WHERE id = $2::int) AS status_5a,
           (SELECT status FROM pos_orders WHERE id = $3::int) AS status_5b,
           (SELECT amount FROM transactions WHERE id = $4::bigint) AS sale_amount_5a,
           (SELECT amount FROM transactions WHERE id = $5::bigint) AS sale_amount_5b,
           (SELECT net_amount FROM transactions WHERE id = $4::bigint) AS sale_net_5a,
           (SELECT net_amount FROM transactions WHERE id = $5::bigint) AS sale_net_5b,
           (SELECT payment_status FROM transactions WHERE id = $4::bigint) AS pay_status_5a,
           (SELECT payment_status FROM transactions WHERE id = $5::bigint) AS pay_status_5b`,
        [propId5, order5a, order5b, tx5a, tx5b]
      );

      // ── S5a: call writer (POS tanpa settlement) → ditolak 409 ──────────────
      let s5aErr = null;
      try {
        await settleTransactionPayment(pool, tx5a, {
          property_id: propId5,
          amount: 40000,
          payment_method: 'CASH',
        });
      } catch (e) {
        s5aErr = e;
      }
      ok(
        'S5a settleTransactionPayment ditolak (adanya error)',
        s5aErr !== null,
        'tidak ada error'
      );
      ok(
        'S5a statusCode=409',
        s5aErr && Number(s5aErr.statusCode) === 409,
        s5aErr ? `got ${s5aErr.statusCode}` : 'no error'
      );
      ok(
        'S5a code=POS_PAYMENT_ROUTE_REQUIRED',
        s5aErr && String(s5aErr.code) === 'POS_PAYMENT_ROUTE_REQUIRED',
        s5aErr ? `got ${s5aErr.code}` : 'no error'
      );

      // ── S5b: call writer (POS dengan settlement) → ditolak 409 ────────────
      let s5bErr = null;
      try {
        await settleTransactionPayment(pool, tx5b, {
          property_id: propId5,
          amount: 60000,
          payment_method: 'CASH',
        });
      } catch (e) {
        s5bErr = e;
      }
      ok(
        'S5b settleTransactionPayment (sudah settlement) ditolak',
        s5bErr !== null,
        'tidak ada error'
      );
      ok(
        'S5b statusCode=409',
        s5bErr && Number(s5bErr.statusCode) === 409,
        s5bErr ? `got ${s5bErr.statusCode}` : 'no error'
      );
      ok(
        'S5b code=POS_PAYMENT_ROUTE_REQUIRED',
        s5bErr && String(s5bErr.code) === 'POS_PAYMENT_ROUTE_REQUIRED',
        s5bErr ? `got ${s5bErr.code}` : 'no error'
      );

      // Snapshot SETELAH kedua request writer.
      const snap5After = await client.query(
        `SELECT
           (SELECT COUNT(*) FROM pos_orders WHERE property_id = $1::int) AS orders,
           (SELECT COUNT(*) FROM transactions
             WHERE property_id = $1::int AND source_type = 'POS_ORDER'
               AND transaction_type = 'SALE' AND deleted_at IS NULL) AS sales,
           (SELECT COUNT(*) FROM payment_transactions WHERE property_id = $1::int) AS payments,
           (SELECT COUNT(*) FROM pos_settlements WHERE property_id = $1::int) AS settlements,
           (SELECT COUNT(*) FROM audit_logs WHERE property_id = $1::int) AS audits,
           (SELECT status FROM pos_orders WHERE id = $2::int) AS status_5a,
           (SELECT status FROM pos_orders WHERE id = $3::int) AS status_5b,
           (SELECT amount FROM transactions WHERE id = $4::bigint) AS sale_amount_5a,
           (SELECT amount FROM transactions WHERE id = $5::bigint) AS sale_amount_5b,
           (SELECT net_amount FROM transactions WHERE id = $4::bigint) AS sale_net_5a,
           (SELECT net_amount FROM transactions WHERE id = $5::bigint) AS sale_net_5b,
           (SELECT payment_status FROM transactions WHERE id = $4::bigint) AS pay_status_5a,
           (SELECT payment_status FROM transactions WHERE id = $5::bigint) AS pay_status_5b`,
        [propId5, order5a, order5b, tx5a, tx5b]
      );
      const c5b = snap5Before.rows[0];
      const c5a = snap5After.rows[0];
      ok(
        'S5 jumlah order tidak berubah',
        Number(c5b.orders) === Number(c5a.orders),
        `before=${c5b.orders} after=${c5a.orders}`
      );
      ok(
        'S5 jumlah SALE POS tidak berubah',
        Number(c5b.sales) === Number(c5a.sales),
        `before=${c5b.sales} after=${c5a.sales}`
      );
      ok(
        'S5 jumlah payment_transactions tidak bertambah',
        Number(c5b.payments) === Number(c5a.payments),
        `before=${c5b.payments} after=${c5a.payments}`
      );
      ok(
        'S5 jumlah pos_settlements tidak bertambah',
        Number(c5b.settlements) === Number(c5a.settlements),
        `before=${c5b.settlements} after=${c5a.settlements}`
      );
      ok(
        'S5 jumlah audit_logs tidak bertambah',
        Number(c5b.audits) === Number(c5a.audits),
        `before=${c5b.audits} after=${c5a.audits}`
      );
      // Status order tetap OPEN.
      ok(
        'S5 order 5a tetap OPEN',
        String(c5a.status_5a).toUpperCase() === 'OPEN',
        `got ${c5a.status_5a}`
      );
      ok(
        'S5 order 5b tetap OPEN',
        String(c5a.status_5b).toUpperCase() === 'OPEN',
        `got ${c5a.status_5b}`
      );
      // Nominal SALE tak berubah.
      ok(
        'S5 SALE 5a amount tetap 40000',
        Number(c5a.sale_amount_5a) === 40000,
        `got ${c5a.sale_amount_5a}`
      );
      ok(
        'S5 SALE 5b amount tetap 60000',
        Number(c5a.sale_amount_5b) === 60000,
        `got ${c5a.sale_amount_5b}`
      );
      ok(
        'S5 SALE 5a net_amount tetap 40000',
        Number(c5a.sale_net_5a) === 40000,
        `got ${c5a.sale_net_5a}`
      );
      ok(
        'S5 SALE 5b net_amount tetap 60000',
        Number(c5a.sale_net_5b) === 60000,
        `got ${c5a.sale_net_5b}`
      );
      // Payment status SALE tak berubah.
      ok(
        'S5 SALE 5a payment_status tak berubah',
        String(c5b.pay_status_5a) === String(c5a.pay_status_5a),
        `before=${c5b.pay_status_5a} after=${c5a.pay_status_5a}`
      );
      ok(
        'S5 SALE 5b payment_status tak berubah',
        String(c5b.pay_status_5b) === String(c5a.pay_status_5b),
        `before=${c5b.pay_status_5b} after=${c5a.pay_status_5b}`
      );
    }

    // ── S6: Pembayaran CASH menolak pembayaran legacy (POS_EXISTING_PAYMENT) ─
    // payPosOrderCash(client, input) menolak order POS yang sudah memiliki
    // payment_transactions SUCCESS (PAYMENT/CORRECTION_REPLACEMENT) positif
    // terkait langsung ke SALE: 409 POS_EXISTING_PAYMENT_NOT_SUPPORTED.
    // Order tetap OPEN; pembayaran legacy utuh; tidak ada settlement/SALE/audit
    // tambahan. Kasus nominal 0.01 membuktikan guard EXISTS tak kehilangan
    // pembayaran kecil akibat pembulatan INTEGER.
    {
      const propId6 = await createFixtureProperty(client, 'S6');

      // S6a: pembayaran legacy nominal penuh (100000).
      {
        const order6a = await createFixturePosOrder(client, propId6, 100000, null);
        const tx6a = await createPosSaleTransaction(client, propId6, order6a, 100000, null, null);
        const legacyPayId = await createPaymentTransaction(
          client, propId6, tx6a, 100000, 'CASH', null, null
        );

        // Snapshot count + status artefak SEBELUM pemanggilan.
        const snap6Before = await client.query(
          `SELECT
             (SELECT COUNT(*) FROM pos_settlements WHERE property_id = $1::int) AS settlements,
             (SELECT COUNT(*) FROM transactions
               WHERE property_id = $1::int AND source_type = 'POS_ORDER'
                 AND transaction_type = 'SALE' AND deleted_at IS NULL) AS sales,
             (SELECT COUNT(*) FROM payment_transactions WHERE property_id = $1::int) AS payments,
             (SELECT COUNT(*) FROM audit_logs WHERE property_id = $1::int) AS audits,
             (SELECT status FROM pos_orders WHERE id = $2::int) AS order_status`,
           [propId6, order6a]
        );

        // Call payPosOrderCash memakai client yang BELUM dalam transaksi.
        let s6aErr = null;
        const s6aClient = await pool.connect();
        try {
          await payPosOrderCash(s6aClient, {
            propertyId: propId6,
            orderId: order6a,
            idempotencyKey: `S6A-${RUN_ID}-${order6a}`,
          });
        } catch (e) {
          s6aErr = e;
        } finally {
          // Jika service BEGIN tapi gagal di tengah, pastikan rollback;
          // release + pool.end terpusat pada finally utama.
          try { await s6aClient.query('ROLLBACK'); } catch (_) {}
          s6aClient.release();
        }
        ok(
          'S6a payPosOrderCash ditolak (adanya error)',
          s6aErr !== null,
          'tidak ada error'
        );
        ok(
          'S6a statusCode=409',
          s6aErr && Number(s6aErr.statusCode) === 409,
          s6aErr ? `got ${s6aErr.statusCode}` : 'no error'
        );
        ok(
          'S6a code=POS_EXISTING_PAYMENT_NOT_SUPPORTED',
          s6aErr && String(s6aErr.code) === 'POS_EXISTING_PAYMENT_NOT_SUPPORTED',
          s6aErr ? `got ${s6aErr.code}` : 'no error'
        );

        // Verifikasi pembayaran legacy berdasarkan ID fixture (bukan jumlah).
        const legacyCheck = await client.query(
          `SELECT amount, status, transaction_id FROM payment_transactions
           WHERE id = $1::int`,
          [legacyPayId]
        );
        const legacyRow = legacyCheck.rows[0];
        ok(
          'S6a pembayaran legacy terverifikasi oleh ID',
          Boolean(legacyRow),
          `id=${legacyPayId} tak ditemukan`
        );
        ok(
          'S6a pembayaran legacy amount=100000',
          legacyRow && Number(legacyRow.amount) === 100000,
          legacyRow ? `got ${legacyRow.amount}` : 'row missing'
        );
        ok(
          'S6a pembayaran legacy status=SUCCESS',
          legacyRow && String(legacyRow.status) === 'SUCCESS',
          legacyRow ? `got ${legacyRow.status}` : 'row missing'
        );
        ok(
          'S6a pembayaran legacy transaction_id tetap menunjuk SALE fixture',
          legacyRow && String(legacyRow.transaction_id) === String(tx6a),
          legacyRow ? `got ${legacyRow.transaction_id} (want ${tx6a})` : 'row missing'
        );

        // Order tetap OPEN.
        const orderStatus6a = await client.query(
          `SELECT status FROM pos_orders WHERE id = $1`, [order6a]
        );
        ok(
          'S6a order tetap OPEN',
          orderStatus6a.rows[0] && String(orderStatus6a.rows[0].status).toUpperCase() === 'OPEN',
          orderStatus6a.rows[0] ? `got ${orderStatus6a.rows[0].status}` : 'order missing'
        );

        // Snapshot SELESAH; assert tidak ada artefak tambahan.
        const snap6After = await client.query(
          `SELECT
             (SELECT COUNT(*) FROM pos_settlements WHERE property_id = $1::int) AS settlements,
             (SELECT COUNT(*) FROM transactions
               WHERE property_id = $1::int AND source_type = 'POS_ORDER'
                 AND transaction_type = 'SALE' AND deleted_at IS NULL) AS sales,
             (SELECT COUNT(*) FROM payment_transactions WHERE property_id = $1::int) AS payments,
             (SELECT COUNT(*) FROM audit_logs WHERE property_id = $1::int) AS audits,
             (SELECT status FROM pos_orders WHERE id = $2::int) AS order_status`,
           [propId6, order6a]
        );
        const c6b = snap6Before.rows[0];
        const c6a = snap6After.rows[0];
        ok(
          'S6a tidak ada pos_settlements baru',
          Number(c6b.settlements) === Number(c6a.settlements),
          `before=${c6b.settlements} after=${c6a.settlements}`
        );
        ok(
          'S6a jumlah SALE tidak berubah',
          Number(c6b.sales) === Number(c6a.sales),
          `before=${c6b.sales} after=${c6a.sales}`
        );
        ok(
          'S6a jumlah payment_transactions tidak berubah',
          Number(c6b.payments) === Number(c6a.payments),
          `before=${c6b.payments} after=${c6a.payments}`
        );
        ok(
          'S6a jumlah audit_logs tidak berubah',
          Number(c6b.audits) === Number(c6a.audits),
          `before=${c6b.audits} after=${c6a.audits}`
        );
        ok(
          'S6a order status tetap OPEN',
          String(c6b.order_status).toUpperCase() === 'OPEN'
            && String(c6a.order_status).toUpperCase() === 'OPEN',
          `before=${c6b.order_status} after=${c6a.order_status}`
        );
      }

      // S6b: kasus nominal — guard EXISTS berdasarkan `pt.amount > 0`.
      // order/SALE nominal penuh 10000 (kolom BIGINT utuh, tak bergantung
      // pembulatan), legacy payment_transactions nominal 0.01 (DECIMAL 12,2).
      // Guard tetap harus mendeteksi pembayaran kecil 0.01 sebagai penolak.
      {
        const order6b = await createFixturePosOrder(client, propId6, 10000, null);
        const tx6b = await createPosSaleTransaction(client, propId6, order6b, 10000, null, null);
        const legacyPayId6b = await createPaymentTransaction(
          client, propId6, tx6b, 0.01, 'CASH', null, null
        );

        // Snapshot before/after untuk settlement, SALE, payment, audit, status order.
        const snap6bBefore = await client.query(
          `SELECT
             (SELECT COUNT(*) FROM pos_settlements WHERE property_id = $1::int) AS settlements,
             (SELECT COUNT(*) FROM transactions
               WHERE property_id = $1::int AND source_type = 'POS_ORDER'
                 AND transaction_type = 'SALE' AND deleted_at IS NULL) AS sales,
             (SELECT COUNT(*) FROM payment_transactions WHERE property_id = $1::int) AS payments,
             (SELECT COUNT(*) FROM audit_logs WHERE property_id = $1::int) AS audits,
             (SELECT status FROM pos_orders WHERE id = $2::int) AS order_status`,
           [propId6, order6b]
        );

        let s6bErr = null;
        const s6bClient = await pool.connect();
        try {
          await payPosOrderCash(s6bClient, {
            propertyId: propId6,
            orderId: order6b,
            idempotencyKey: `S6B-${RUN_ID}-${order6b}`,
          });
        } catch (e) {
          s6bErr = e;
        } finally {
          try { await s6bClient.query('ROLLBACK'); } catch (_) {}
          s6bClient.release();
        }
        ok(
          'S6b (legacy 0.01) payPosOrderCash ditolak',
          s6bErr !== null,
          'tidak ada error'
        );
        ok(
          'S6b (legacy 0.01) statusCode=409',
          s6bErr && Number(s6bErr.statusCode) === 409,
          s6bErr ? `got ${s6bErr.statusCode}` : 'no error'
        );
        ok(
          'S6b (legacy 0.01) code=POS_EXISTING_PAYMENT_NOT_SUPPORTED',
          s6bErr && String(s6bErr.code) === 'POS_EXISTING_PAYMENT_NOT_SUPPORTED',
          s6bErr ? `got ${s6bErr.code}` : 'no error'
        );

        // Verifikasi pembayaran legacy 0.01 berdasarkan ID fixture.
        const legacyCheck6b = await client.query(
          `SELECT amount, status, transaction_id FROM payment_transactions
           WHERE id = $1::int`,
          [legacyPayId6b]
        );
        const legacyRow6b = legacyCheck6b.rows[0];
        ok(
          'S6b (legacy 0.01) pembayaran terverifikasi oleh ID',
          Boolean(legacyRow6b),
          `id=${legacyPayId6b} tak ditemukan`
        );
        ok(
          'S6b (legacy 0.01) pembayaran amount tetap 0.01',
          legacyRow6b && Number(legacyRow6b.amount) === 0.01,
          legacyRow6b ? `got ${legacyRow6b.amount}` : 'row missing'
        );
        ok(
          'S6b (legacy 0.01) pembayaran status=SUCCESS',
          legacyRow6b && String(legacyRow6b.status) === 'SUCCESS',
          legacyRow6b ? `got ${legacyRow6b.status}` : 'row missing'
        );
        ok(
          'S6b (legacy 0.01) pembayaran transaction_id tetap menunjuk SALE fixture',
          legacyRow6b && String(legacyRow6b.transaction_id) === String(tx6b),
          legacyRow6b ? `got ${legacyRow6b.transaction_id} (want ${tx6b})` : 'row missing'
        );

        const orderStatus6b = await client.query(
          `SELECT status FROM pos_orders WHERE id = $1`, [order6b]
        );
        ok(
          'S6b (legacy 0.01) order tetap OPEN',
          orderStatus6b.rows[0] && String(orderStatus6b.rows[0].status).toUpperCase() === 'OPEN',
          orderStatus6b.rows[0] ? `got ${orderStatus6b.rows[0].status}` : 'order missing'
        );

        // Snapshot after; assert tidak ada artefak tambahan.
        const snap6bAfter = await client.query(
          `SELECT
             (SELECT COUNT(*) FROM pos_settlements WHERE property_id = $1::int) AS settlements,
             (SELECT COUNT(*) FROM transactions
               WHERE property_id = $1::int AND source_type = 'POS_ORDER'
                 AND transaction_type = 'SALE' AND deleted_at IS NULL) AS sales,
             (SELECT COUNT(*) FROM payment_transactions WHERE property_id = $1::int) AS payments,
             (SELECT COUNT(*) FROM audit_logs WHERE property_id = $1::int) AS audits,
             (SELECT status FROM pos_orders WHERE id = $2::int) AS order_status`,
           [propId6, order6b]
        );
        const c6bb = snap6bBefore.rows[0];
        const c6ba = snap6bAfter.rows[0];
        ok(
          'S6b (legacy 0.01) tidak ada pos_settlements baru',
          Number(c6bb.settlements) === Number(c6ba.settlements),
          `before=${c6bb.settlements} after=${c6ba.settlements}`
        );
        ok(
          'S6b (legacy 0.01) jumlah SALE tidak berubah',
          Number(c6bb.sales) === Number(c6ba.sales),
          `before=${c6bb.sales} after=${c6ba.sales}`
        );
        ok(
          'S6b (legacy 0.01) jumlah payment_transactions tidak berubah',
          Number(c6bb.payments) === Number(c6ba.payments),
          `before=${c6bb.payments} after=${c6ba.payments}`
        );
        ok(
          'S6b (legacy 0.01) jumlah audit_logs tidak berubah',
          Number(c6bb.audits) === Number(c6ba.audits),
          `before=${c6bb.audits} after=${c6ba.audits}`
        );
        ok(
          'S6b (legacy 0.01) order status tetap OPEN',
          String(c6bb.order_status).toUpperCase() === 'OPEN'
            && String(c6ba.order_status).toUpperCase() === 'OPEN',
          `before=${c6bb.order_status} after=${c6ba.order_status}`
        );
      }
    }

    // ── S7: Booking kamar tanpa POS — reader daftar/detail & detail booking ─
    // Fixture booking/reservation baru, folio ROOM_CHARGE nyata, SALE kamar
    // net=500000, pembayaran kamar 200000 (tanpa deposit), TIDAK ada order /
    // settlement POS.
    //   • getTransactionById (detail SALE): net=500000, paid=200000, remaining=300000.
    //   • getTransactions (daftar SALE): baris ditemukan, field sesuai.
    //   • getBookingSalesDetail: financial.net=500000, paid=200000, remaining=300000;
    //     child ditemukan berdasarkan reservation_id; payment list memuat 200000.
    //   • Panggilan ulang: nilai & jumlah artefak (SALE / payment_transactions /
    //     audit_logs) tidak berubah.
    {
      const propId7 = await createFixtureProperty(client, 'S7');
      const chain7 = await createReservationChain(client, propId7, 'Tamu-S7');
      const { reservation: reservationId7, booking: bookingId7, bid: bid7 } = chain7;

      // Folio ROOM_CHARGE nyata 500000 → SALE kamar, source_id=String(folioEntryId).
      const folioEntryId7 = await createFolioEntry(
        client, reservationId7, propId7, 'ROOM_CHARGE', 500000
      );
      const roomTxId7 = await createRoomSaleTransaction(
        client, propId7, reservationId7, bookingId7, 500000, String(folioEntryId7)
      );

      // Pembayaran kamar 200000 (tanpa deposit).
      const pay7Id = await createPaymentTransaction(
        client, propId7, null, 200000, 'CASH', reservationId7, bookingId7
      );
      void pay7Id;

      // Snapshot count artefak SEBELUM pemanggilan reader.
      const snap7Before = await client.query(
        `SELECT
           (SELECT COUNT(*) FROM transactions
             WHERE property_id = $1::int AND booking_id = $2
               AND transaction_type = 'SALE' AND deleted_at IS NULL) AS sales,
           (SELECT COUNT(*) FROM payment_transactions
             WHERE reservation_id = $3 AND scope = 'ROOM_RESERVATION') AS payments,
           (SELECT COUNT(*) FROM audit_logs WHERE property_id = $1::int) AS audits`,
        [propId7, bookingId7, reservationId7]
      );

      // ── S7: getTransactionById (detail SALE kamar) ───────────────────────
      {
        const detail7 = await getTransactionById(pool, propId7, roomTxId7);
        ok(
          'S7 getTransactionById net=500000',
          Number(detail7.net_amount) === 500000,
          `got ${detail7.net_amount}`
        );
        ok(
          'S7 getTransactionById paid=200000',
          Number(detail7.paid_amount) === 200000,
          `got ${detail7.paid_amount}`
        );
        ok(
          'S7 getTransactionById remaining=300000',
          Number(detail7.outstanding_amount) === 300000,
          `got ${detail7.outstanding_amount}`
        );
      }

      // ── S7: getTransactions (daftar SALE) ────────────────────────────────
      {
        const listRes7 = await getTransactions(pool, {
          property_id: propId7,
          transaction_type: 'SALE',
          limit: 50,
          offset: 0,
        });
        const roomRow7 = listRes7.transactions.find(
          (row) => String(row.id) === String(roomTxId7)
        );
        ok(
          'S7 getTransactions menemukan SALE kamar',
          Boolean(roomRow7),
          `id=${roomTxId7} tak ditemukan (rows=${listRes7.transactions.length})`
        );
        if (roomRow7) {
          ok(
            'S7 getTransactions paid=200000',
            Number(roomRow7.paid_amount) === 200000,
            `got ${roomRow7.paid_amount}`
          );
          ok(
            'S7 getTransactions remaining=300000',
            Number(roomRow7.outstanding_amount) === 300000,
            `got ${roomRow7.outstanding_amount}`
          );
        }
      }

      // ── S7: getBookingSalesDetail (detail booking) ───────────────────────
      {
        const detail7b = await getBookingSalesDetail(pool, propId7, bid7);
        ok(
          'S7 getBookingSalesDetail financial.net=500000',
          Number(detail7b.financial.net) === 500000,
          `got ${detail7b.financial.net}`
        );
        ok(
          'S7 getBookingSalesDetail financial.paid=200000',
          Number(detail7b.financial.paid) === 200000,
          `got ${detail7b.financial.paid}`
        );
        ok(
          'S7 getBookingSalesDetail financial.remaining=300000',
          Number(detail7b.financial.remaining) === 300000,
          `got ${detail7b.financial.remaining}`
        );

        // Child ditemukan berdasarkan identitas fixture (reservation_id).
        const child7 = detail7b.children.find(
          (c) => Number(c.reservation_id) === Number(reservationId7)
        );
        ok(
          'S7 child ditemukan oleh reservation_id',
          Boolean(child7),
          `reservation_id=${reservationId7} tak ditemukan (children=${detail7b.children.length})`
        );
        if (child7) {
          ok(
            'S7 child.net=500000',
            Number(child7.net) === 500000,
            `got ${child7.net}`
          );
          ok(
            'S7 child.paid=200000',
            Number(child7.paid) === 200000,
            `got ${child7.paid}`
          );
          ok(
            'S7 child.remaining=300000',
            Number(child7.remaining) === 300000,
            `got ${child7.remaining}`
          );
        }

        // Payment list memuat pembayaran kamar 200000 (ROOM_RESERVATION).
        const payRows7 = detail7b.payments.filter((p) =>
          p.reservation_id === Number(reservationId7)
        );
        const pay7Total = payRows7.reduce(
          (sum, p) => sum + Number(p.amount || 0), 0
        );
        ok(
          'S7 payments memuat pembayaran kamar 200000',
          Number(payRows7.length) >= 1 && pay7Total === 200000,
          `rows=${payRows7.length} total=${pay7Total}`
        );

        // booking_bid_group via getTransactions.
        const listRes7b = await getTransactions(pool, {
          property_id: propId7,
          transaction_type: 'SALE',
          limit: 50,
          offset: 0,
        });
        const bidGroupRow7 = listRes7b.transactions.find(
          (row) =>
            row.booking_bid_group &&
            String(row.booking_bid_group.bid || '').toUpperCase() === bid7
        );
        ok(
          'S7 getTransactions menemukan baris booking_bid_group',
          Boolean(bidGroupRow7),
          `bid=${bid7} tak ditemukan dalam ${listRes7b.transactions.length} baris`
        );
        if (bidGroupRow7) {
          const grp7 = bidGroupRow7.booking_bid_group;
          ok(
            'S7 booking_bid_group.net=500000',
            Number(grp7.net) === 500000,
            `got ${grp7.net}`
          );
          ok(
            'S7 booking_bid_group.paid=200000',
            Number(grp7.paid) === 200000,
            `got ${grp7.paid}`
          );
          ok(
            'S7 booking_bid_group.remaining=300000',
            Number(grp7.remaining) === 300000,
            `got ${grp7.remaining}`
          );
        }

        // ��─ S7: panggilan ulang reader — nilai & jumlah artefak tak berubah ─
        const detail7c = await getBookingSalesDetail(pool, propId7, bid7);
        ok(
          'S7 ulang getBookingSalesDetail net tetap 500000',
          Number(detail7c.financial.net) === 500000,
          `got ${detail7c.financial.net}`
        );
        ok(
          'S7 ulang getBookingSalesDetail paid tetap 200000',
          Number(detail7c.financial.paid) === 200000,
          `got ${detail7c.financial.paid}`
        );
        ok(
          'S7 ulang getBookingSalesDetail remaining tetap 300000',
          Number(detail7c.financial.remaining) === 300000,
          `got ${detail7c.financial.remaining}`
        );
      }

      // Snapshot SELESAH; assert jumlah artefak tak berubah (reader tak menulis).
      const snap7After = await client.query(
        `SELECT
           (SELECT COUNT(*) FROM transactions
             WHERE property_id = $1::int AND booking_id = $2
               AND transaction_type = 'SALE' AND deleted_at IS NULL) AS sales,
           (SELECT COUNT(*) FROM payment_transactions
             WHERE reservation_id = $3 AND scope = 'ROOM_RESERVATION') AS payments,
           (SELECT COUNT(*) FROM audit_logs WHERE property_id = $1::int) AS audits`,
        [propId7, bookingId7, reservationId7]
      );
      const c7b = snap7Before.rows[0];
      const c7a = snap7After.rows[0];
      ok(
        'S7 ulang: jumlah SALE kamar tidak berubah',
        Number(c7b.sales) === Number(c7a.sales),
        `before=${c7b.sales} after=${c7a.sales}`
      );
      ok(
        'S7 ulang: jumlah payment_transactions kamar tidak berubah',
        Number(c7b.payments) === Number(c7a.payments),
        `before=${c7b.payments} after=${c7a.payments}`
      );
      ok(
        'S7 ulang: jumlah audit_logs tidak berubah',
        Number(c7b.audits) === Number(c7a.audits),
        `before=${c7b.audits} after=${c7a.audits}`
      );
    }

  } catch (err) {
    // Kegagalan utama tercatat sebagai kegagalan → exit nonzero.
    mainError = err;
    process.exitCode = 1;
    console.error('[ERROR] ' + (err && err.message ? err.message : err));
  } finally {
    // Cleanup + residu dibungkus try/catch terpisah; kegagalan di sini juga
    // tercatat sebagai kegagalan. finally selalu release client & pool.end().
    if (identityVerified && cleanupClient) {
      const hasFixtures = Object.keys(tracked).some(
        (k) => Array.isArray(tracked[k]) && tracked[k].length > 0
      );
      if (hasFixtures) {
        try {
          const cleanupResult = await cleanupFixtures(cleanupClient);
          if (cleanupResult.removed === 'error') {
            cleanupError = new Error(cleanupResult.error);
            console.error(`[CLEANUP ERROR] ${cleanupResult.error}`);
            process.exitCode = 1;
          } else {
            // Verifikasi residu.
            const residue = await verifyNoResidue(cleanupClient);
            if (residue.length > 0) {
              cleanupError = new Error(residue.join('; '));
              console.error(`[RESIDU] ${residue.join('; ')}`);
              process.exitCode = 1;
            } else {
              console.log('[CLEANUP] Semua fixture dibersihkan, residu = 0.');
            }
          }
        } catch (cleanupErr) {
          cleanupError = cleanupErr;
          console.error('[CLEANUP/RESIDU ERROR] ' + (cleanupErr && cleanupErr.message ? cleanupErr.message : cleanupErr));
          process.exitCode = 1;
        }
      }
    }

    // Release semua client tersedia + pool.end() — selalu.
    if (client) { try { await client.release(); } catch (_) {} }
    if (cleanupClient) { try { await cleanupClient.release(); } catch (_) {} }
    await pool.end();
  }

  // Ringkasan hasil — sertakan error utama & cleanup sebagai kegagalan.
  if (mainError) {
    failed++;
    failures.push(`main error: ${mainError && mainError.message ? mainError.message : mainError}`);
  }
  if (cleanupError) {
    failed++;
    failures.push(`cleanup/residue error: ${cleanupError && cleanupError.message ? cleanupError.message : cleanupError}`);
  }

  console.log(`\n[POS SETTLEMENT READER TEST] ${passed} PASS, ${failed} FAIL`);
  if (failed > 0) {
    for (const f of failures) console.log(`  FAIL: ${f}`);
    process.exitCode = 1;
  } else {
    console.log('[POS SETTLEMENT READER TEST] Semua skenario lulus.');
  }
}

main().catch((err) => {
  console.error('[FATAL] ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
