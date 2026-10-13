/**
 * POS ORDER STATUS GUARD TEST
 *
 * Skenario (diimplementasikan):
 *   S1. OPEN bersih → VOIDED:
 *       HTTP 200 SUCCESS, replayed=false;
 *       response row sesuai DB;
 *       tepat satu audit VOID dengan payload & actor sesuai;
 *       tidak ada transaksi, settlement, atau payment baru.
 *   S2. Ulangi VOIDED pada order yang sama:
 *       HTTP 200 SUCCESS, replayed=true;
 *       row lengkap dan updated_at tetap identik;
 *       jumlah audit tetap satu;
 *       seluruh artefak finansial tidak berubah.
 *
 * Ini test HANDLER, bukan test middleware autentikasi produksi:
 *   - Express lokal 127.0.0.1:port dinamis;
 *   - middleware test mengisi req.user dengan actor sintetis + property_id fixture;
 *   - assertPropertyScope membandingkan req.user.property_id dengan request.
 *
 * DB safety guard: TEST_DATABASE_URL eksplisit → 127.0.0.1:15434 /
 * oak_minibar_test / minibar_test, password wajib, query parameter ditolak.
 * Tanpa dotenv, tanpa fallback, tanpa mencetak URL/password.
 *
 * Run:
 *   TEST_DATABASE_URL=postgres://USER:PASS@127.0.0.1:15434/oak_minibar_test \
 *   node backend/test/pos_order_status_guard_test.js
 */
'use strict';

// ─── 1. DB SAFETY GUARD ───────────────────────────────────────────���─────────
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !testUrl.trim()) {
  console.error('SAFETY: TEST_DATABASE_URL tidak di-set.');
  process.exit(1);
}

const ALLOWED_HOST = '127.0.0.1', ALLOWED_PORT = 15434;
const ALLOWED_DATABASE = 'oak_minibar_test', ALLOWED_USER = 'minibar_test';

let target;
try {
  const u = new URL(testUrl.trim());
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error('protocol wajib postgres');
  if (u.hostname !== ALLOWED_HOST) throw new Error(`host wajib ${ALLOWED_HOST}`);
  if (u.searchParams.size > 0) throw new Error('query parameter ditolak');
  if (!u.port || !/^\d+$/.test(u.port)) throw new Error('port eksplisit wajib');
  const port = Number(u.port);
  if (port !== ALLOWED_PORT) throw new Error(`port wajib ${ALLOWED_PORT}`);
  const user = u.username ? decodeURIComponent(u.username) : '';
  const password = u.password ? decodeURIComponent(u.password) : '';
  const database = u.pathname ? decodeURIComponent(u.pathname.replace(/^\//, '')) : '';
  if (!user) throw new Error('user wajib');
  if (!password) throw new Error('password wajib');
  if (user !== ALLOWED_USER) throw new Error(`user wajib ${ALLOWED_USER}`);
  if (database !== ALLOWED_DATABASE) throw new Error(`database wajib ${ALLOWED_DATABASE}`);
  target = { host: u.hostname, port, user, database, password };
  console.log(`[POS-ORDER-STATUS GUARD] Target: ${database} (user: ${user}, port: ${port})`);
} catch (e) {
  console.error(`SAFETY: TEST_DATABASE_URL tidak valid — ${e.message}`);
  process.exit(1);
}

// ─── 2. Pool eksplisit dari field target (tanpa fallback) ─────────────────
const { Pool } = require('pg');
const pool = new Pool({
  host: target.host,
  port: target.port,
  user: target.user,
  password: target.password,
  database: target.database,
  max: 10,
  connectionTimeoutMillis: 10000,
});

// ─── 3. Verifikasi pool.options + identitas DB ─────────────────────────────
function verifyPoolOptions() {
  const o = pool.options || {};
  for (const [val, field] of [[o.host, 'host'], [o.port, 'port'], [o.user, 'user'], [o.database, 'database']]) {
    const expected = target[field];
    if (val !== expected) {
      throw new Error(`SAFETY: pool.options.${field}=${JSON.stringify(val)}, expected ${JSON.stringify(expected)}`);
    }
  }
  console.log('[POS-ORDER-STATUS GUARD] pool.options terverifikasi');
}

async function verifyDatabase() {
  const c = await pool.connect();
  try {
    const r = await c.query('SELECT current_database() AS db, current_user AS usr');
    if (r.rows[0].db !== target.database || r.rows[0].usr !== target.user) {
      throw new Error(`SAFETY: db=${r.rows[0].db} usr=${r.rows[0].usr} tidak cocok dengan target`);
    }
    console.log('[POS-ORDER-STATUS GUARD] Verifikasi DB OK (current_database, current_user)');
  } finally {
    c.release();
  }
}

// ─── 4. Import factory dari dist (bukan index) ─────────────────────────────
const { createPosOrderStatusHandler } = require('../dist/domains/pos/posOrderStatusHandler');
if (typeof createPosOrderStatusHandler !== 'function') {
  throw new Error('SAFETY: createPosOrderStatusHandler dari dist bukan fungsi');
}
console.log('[POS-ORDER-STATUS GUARD] createPosOrderStatusHandler di-import dari dist');

// Service CASH settlement (infrastructure concurrency, dipakai S7+).
// Signature: payPosOrderCash(poolClient: PoolClient, input: PayPosOrderCashInput)
//   - Caller menyediakan PoolClient yang BELUM dalam transaksi; WAJIB me-release
//     di finally. Service tidak me-release client.
//   - input: { propertyId: number, orderId: number, idempotencyKey: string,
//              actorName?: string, actorUserId?: string, correlationId?: string }
//   - service membuka BEGIN/COMMIT/ROLLBACK sendiri; tidak menerima pool.
const { payPosOrderCash, PosSettlementError } = require('../dist/domains/pos/posSettlementService');
if (typeof payPosOrderCash !== 'function') {
  throw new Error('SAFETY: payPosOrderCash dari dist bukan fungsi');
}
console.log('[POS-ORDER-STATUS GUARD] payPosOrderCash di-import dari dist');

// ─── 5. Counter + tracked fixture arrays ───────────────────────────────────
let passed = 0, failed = 0;
const tracked = {
  properties: [],
  posOrders: [],
  posOrderItems: [],
  auditLogs: [],
  // S4: transaksi SALE POS yang sengaja dibuat test (fixture artefak 409).
  // Di-track langsung setelah INSERT agar cleanup menghapusnya secara
  // terpusat.
  transactions: [],
  // S6: settlement fixture (INTEGER id, di-track sebagai number).
  // Dihapus oleh cleanup sebelum transaksi & pos_orders (FK RESTRICT).
  posSettlements: [],
  // S7: date_key sequences di property fixture S7.
  // Dibuat oleh generateTransactionNumber; ON DELETE CASCADE pada
  // properties.id, tetapi dihapus eksplisit sebelum properties
  // agar cleanup FK-safe tanpa andalkan CASCADE.
  transactionDailySequences: [],
};

function pass(description) {
  passed++;
  console.log(`  PASS ${description}`);
}

function fail(description, err) {
  failed++;
  console.error(`  FAIL ${description}`);
  if (err && err.message) console.error(`       ${err.message}`);
}

// ─── 6. Fixture helpers ────────────────────────────────────────────────────
const crypto = require('crypto');

// Per-run prefix: 3 uppercase hex chars, generated ONCE per run.
const fixturePrefix = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 3);

// Counter for property_code suffix (base36, starts at 1).  36^3 total slots.
let propertyCodeSeq = 0;

/**
 * Next unique 6-char property_code.
 *   prefix (3 char, per-run) + base36 counter (3 char, zero-padded, uppercase).
 * Starts at 1; rejects overflow at >= 36^3 (46656).
 * Validated to be exactly 6 chars, uppercase A-Z0-9.
 *
 * @returns {string}
 */
function nextPropertyCode() {
  propertyCodeSeq++;
  if (propertyCodeSeq >= 36 ** 3) {
    throw new Error('SAFETY: property_code counter overflow');
  }
  const suffix = propertyCodeSeq.toString(36).toUpperCase().padStart(3, '0');
  const code = `${fixturePrefix}${suffix}`;
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    throw new Error(`SAFETY: property_code tidak valid (6 char A-Z0-9): ${code}`);
  }
  return code;
}

/**
 * Create an isolated test property and track its ID immediately.
 *
 * property_code = 3-char crypto prefix + 3-char base36 counter = 6 chars,
 * matching CHECK constraint ^[A-Z0-9]{2,6}$ and the unique index
 * properties_property_code_key.  currency_code = 'IDR',
 * timezone = 'Asia/Jakarta' (proven checkout-fixture convention).
 *
 * @param {import('pg').PoolClient} client
 * @returns {Promise<{ propertyId: number, propertyCode: string }>}
 */
async function createFixtureProperty(client) {
  const code = nextPropertyCode();
  const r = await client.query(
    `INSERT INTO properties (name, property_code, timezone, currency_code, is_active)
     VALUES ($1, $2, 'Asia/Jakarta', 'IDR', TRUE) RETURNING id`,
    [`POS Status Guard Prop ${code}`, code]
  );
  const propertyId = Number(r.rows[0].id);
  tracked.properties.push(propertyId);
  return { propertyId, propertyCode: code };
}

/**
 * Create a standalone POS order (no reservation linkage), status OPEN,
 * total_amount = 25000.  order_number uses POG-<uuid>.
 *
 * order_number = `POG-${crypto.randomUUID()}`.
 *   'POG-' (4) + 36-char UUID = 40 chars, within VARCHAR(50) column width
 *   and the per-property uniqueness index uq_pos_order_number_per_property.
 *
 * INSERT biasa (tanpa ON CONFLICT), RETURNING id; ID di-track segera.
 *
 * @param {import('pg').PoolClient} client
 * @param {number} propertyId
 * @returns {Promise<{ orderId: number, orderNumber: string }>}
 */
async function createFixturePosOrder(client, propertyId) {
  const orderNumber = `POG-${crypto.randomUUID()}`;
  if (orderNumber.length > 50) {
    throw new Error(`SAFETY: order_number melebihi VARCHAR(50): ${orderNumber.length} char`);
  }
  const r = await client.query(
    `INSERT INTO pos_orders (property_id, order_number, guest_name, status, total_amount)
     VALUES ($1, $2, 'POS Guard Guest', 'OPEN', 25000) RETURNING id`,
    [propertyId, orderNumber]
  );
  const orderId = Number(r.rows[0].id);
  tracked.posOrders.push(orderId);
  return { orderId, orderNumber };
}

/**
 * Buat transaksi SALE POS terkait order (fixture artefak finansial untuk S4).
 *
 * Menggunakan pola yang terbukti di pos_settlement_reader_test.js:
 *   source_type = 'POS_ORDER', source_id = String(orderId), property match
 *   → query Q1a di posOrderStatusHandler mendeteksi artefak → 409.
 *
 * transactions.id adalah BIGSERIAL (BIGINT): driver pg mengembalikannya
 * sebagai string; kita selalu mempertahankan sebagai string di sini.
 *
 * @param {import('pg').PoolClient} client
 * @param {number} propertyId
 * @param {number} orderId   pos_orders.id (INTEGER)
 * @param {number} totalAmount  BIGINT (dalam rupiah)
 * @param {object} [opts]  Opsi eksplisit (default = perilaku S4)
 *   - source_type        default 'POS_ORDER'
 *   - transaction_status default 'POSTED'
 *   - payment_status     default 'PAID'
 *   - payment_method     default 'CASH'
 *   - deleted_at         default null (TIMESTAMPTZ). Kalikan dengan deleted_at_now
 *   - deleted_at_now     default false. true → kolom diisi CURRENT_TIMESTAMP (S5).
 *   - delete_reason      default null (TEXT)
 * @returns {Promise<string>}  transaction id (BIGINT → string), di-track
 */
async function createPosSaleTransactionFixture(client, propertyId, orderId, totalAmount, opts = {}) {
  const {
    source_type = 'POS_ORDER',
    transaction_status = 'POSTED',
    payment_status = 'PAID',
    payment_method = 'CASH',
    deleted_at = null,
    deleted_at_now = false,
    delete_reason = null,
  } = opts;
  const txNo = `TXPG-${crypto.randomUUID()}`;
  if (txNo.length > 50) {
    throw new Error(`SAFETY: transaction_no melebihi VARCHAR(50): ${txNo.length} char`);
  }
  const description = `Pesanan Restoran / POS #${orderId} (fixture ${source_type})`;
  const r = await client.query(
    `INSERT INTO transactions (
       property_id, transaction_no, transaction_date, transaction_time,
       transaction_type, source_type, source_id, source_reference,
       category_code, category_name, department_code, description,
       amount, discount_amount, service_amount, tax_amount, net_amount,
       payment_status, payment_method, transaction_status,
       reservation_id, booking_id, created_by,
       deleted_at, delete_reason
     )
     VALUES (
       $1, $2, CURRENT_DATE, CURRENT_TIMESTAMP,
       'SALE', $3, $4, $4,
       'FNB_SALES', 'Restoran / F&B / POS', 'FNB', $5,
       $6, 0, 0, 0, $6,
       $7, $8, $9,
       NULL, NULL, 'TEST',
       CASE WHEN $12::boolean THEN CURRENT_TIMESTAMP
            ELSE $10::timestamptz END, $11
     ) RETURNING id`,
    [propertyId, txNo, source_type, String(orderId), description, totalAmount,
     payment_status, payment_method, transaction_status,
     deleted_at, delete_reason, deleted_at_now]
  );
  // transactions.id = BIGSERIAL → string (BIGINT dipertahankan sebagai string)
  const txId = String(r.rows[0].id);
  tracked.transactions.push(txId);
  return txId;
}

/**
 * Buat pos_settlements fixture terkait order + transaksi (untuk S6).
 *
 * Menggunakan pola terbukti di pos_settlement_reader_test.js:
 *   FK: pos_order_id → pos_orders(id) RESTRICT
 *       transaction_id → transactions(id) RESTRICT  (BIGINT)
 *   UNIQUE: pos_order_id (satu settlement per order)
 *   id adalah SERIAL (INTEGER) → di-track sebagai number.
 *
 * @param {import('pg').PoolClient} client
 * @param {number} propertyId
 * @param {number} orderId        pos_orders.id (INTEGER)
 * @param {string} transactionId  transactions.id (BIGINT → string)
 * @param {number} amount         DECIMAL(12,2)
 * @returns {Promise<number>} settlement id (INTEGER), di-track
 */
async function createPosSettlementFixture(client, propertyId, orderId, transactionId, amount) {
  const idemKey = `IDEM-PG-${crypto.randomUUID()}`;
  const fingerprint = `FP-PG-${crypto.randomUUID()}`;
  const r = await client.query(
    `INSERT INTO pos_settlements (
       property_id, pos_order_id, transaction_id, amount,
       payment_method, status, idempotency_key, request_fingerprint, created_by
     )
     VALUES (
       $1, $2, $3, $4, 'CASH', 'SUCCESS', $5, $6, 'TEST'
     ) RETURNING id`,
    [propertyId, orderId, transactionId, amount, idemKey, fingerprint]
  );
  // pos_settlements.id = SERIAL → INTEGER → number
  const settlementId = Number(r.rows[0].id);
  tracked.posSettlements.push(settlementId);
  return settlementId;
}

/**
 * Snapshot a single pos_settlements row by its own INTEGER id.
 * amount is DECIMAL(12,2) → driver pg returns string; kept as-is for compare.
 * @returns {Promise<object|null>}
 */
async function readSettlementById(settlementId) {
  const c = await pool.connect();
  try {
    const r = await c.query(
      `SELECT id, property_id, pos_order_id, transaction_id, amount,
              payment_method, status, idempotency_key, request_fingerprint,
              created_at
       FROM pos_settlements WHERE id = $1::int`,
      [settlementId]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    return {
      id: Number(row.id),
      property_id: row.property_id,
      pos_order_id: row.pos_order_id,
      // transaction_id BIGINT → string
      transaction_id: row.transaction_id === null ? null : String(row.transaction_id),
      amount: row.amount,
      payment_method: row.payment_method,
      status: row.status,
      idempotency_key: row.idempotency_key,
      request_fingerprint: row.request_fingerprint,
      // pos_settlements hanya punya created_at (TIMESTAMP, tanpa timezone)
      created_at: row.created_at === null ? null : new Date(row.created_at).toISOString(),
    };
  } finally {
    c.release();
  }
}

/**
 * Read a pos_settlements row scoped by property_id + pos_order_id
 * (not by its own id — the S7 service creates it, so the test does not
 * know the id upfront; S7 tracks it only after the service returns).
 *
 * @param {number} propertyId
 * @param {number} orderId
 * @returns {Promise<object|null>}
 */
async function readSettlementByOrder(propertyId, orderId) {
  const c = await pool.connect();
  try {
    const r = await c.query(
      `SELECT id, property_id, pos_order_id, transaction_id, amount,
              payment_method, status, idempotency_key, request_fingerprint,
              created_by, created_at
       FROM pos_settlements
       WHERE property_id = $1 AND pos_order_id = $2
       LIMIT 1`,
      [propertyId, orderId]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    return {
      id: Number(row.id),
      property_id: row.property_id,
      pos_order_id: row.pos_order_id,
      transaction_id: row.transaction_id === null ? null : String(row.transaction_id),
      amount: row.amount,
      payment_method: row.payment_method,
      status: row.status,
      idempotency_key: row.idempotency_key,
      request_fingerprint: row.request_fingerprint,
      created_by: row.created_by === null ? null : String(row.created_by),
      created_at: row.created_at === null ? null : new Date(row.created_at).toISOString(),
    };
  } finally {
    c.release();
  }
}

/**
 * Read the SETTLEMENT_CASH audit row for a S7 settlement.
 *
 * @param {number} propertyId
 * @param {number} settlementId — pos_settlements.id (INTEGER → string in record_id)
 * @returns {Promise<object|null>} — normalized audit row or null.
 */
async function readSettlementAudit(propertyId, settlementId) {
  const c = await pool.connect();
  try {
    const r = await c.query(
      `SELECT audit_id, module, action, entity, record_id, new_value, actor_user_id
       FROM audit_logs
       WHERE property_id = $1
         AND module = 'POS'
         AND action = 'SETTLEMENT_CASH'
         AND entity = 'pos_settlements'
         AND record_id = $2
       ORDER BY audit_id ASC`,
      [propertyId, String(settlementId)]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    let payload;
    try {
      payload = JSON.parse(row.new_value);
    } catch (parseErr) {
      throw new Error(
        `readSettlementAudit: JSON.parse(new_value) gagal — `
        + `new_value=${row.new_value?.slice(0, 200)}: ${parseErr.message}`
      );
    }
    return {
      audit_id: row.audit_id,
      module: row.module,
      action: row.action,
      entity: row.entity,
      record_id: row.record_id,
      actor_user_id: row.actor_user_id,
      payload,
    };
  } finally {
    c.release();
  }
}

/**
 * Collect all service-created transaction and settlement IDs for a given
 * property and track them in `tracked` arrays so cleanup can remove them.
 *
 * Scoping:
 *   - transactions: scoped to property_id only (no source_type/status/reversal filter)
 *   - pos_settlements: scoped to property_id only (no status/idempotency filter)
 *
 * Dedup:
 *   - Each ID is tracked at most once (Set-based dedup before push).
 *
 * Empty rows are NOT an error — the service may have failed before creating
 * any artifacts.  Query/collection errors THROW (caller catches → fail).
 *
 * @param {number} propertyId  — the S7 fixture property
 * @returns {Promise<{ txnIds: string[], settlementIds: number[] }>}
 */
async function collectServiceArtifacts(propertyId) {
  const c = await pool.connect();
  try {
    // Query 1: transactions (no filter other than property_id)
    const txnRes = await c.query(
      `SELECT id FROM transactions WHERE property_id = $1 ORDER BY id::bigint ASC`,
      [propertyId]
    );
    // Track immediately, dedup against existing tracked.transactions
    for (const row of txnRes.rows) {
      const id = String(row.id);
      if (!tracked.transactions.includes(id)) {
        tracked.transactions.push(id);
      }
    }

    // Query 2: pos_settlements (no filter other than property_id)
    const settleRes = await c.query(
      `SELECT id FROM pos_settlements WHERE property_id = $1 ORDER BY id ASC`,
      [propertyId]
    );
    // Track immediately, dedup against existing tracked.posSettlements
    for (const row of settleRes.rows) {
      const id = Number(row.id);
      if (!tracked.posSettlements.includes(id)) {
        tracked.posSettlements.push(id);
      }
    }
  } catch (queryErr) {
    // Query error is a test failure — re-throw so the caller handles it.
    // Release happens in finally (below).
    throw queryErr;
  } finally {
    try { c.release(); }
    catch (relErr) {
      // Release failure is recorded but does NOT mask the primary error
      fail('collectServiceArtifacts release gagal', relErr);
      if (process.exitCode !== 1) process.exitCode = 1;
    }
  }
}

// ─── 6b. Cleanup + residue verification ───────────────────────────────────
/**
 * Delete all tracked/fixture artifact IDs in a single transaction.
 *
 * Order (child → parent, FK-safe):
 *   pos_order_items (via fixture pos_orders)
 *   audit_logs      (scoped to tracked properties, collected via audit_id)
 *   pos_settlements (tracked S6 fixtures, before transactions & pos_orders)
 *   transactions    (tracked SALE POS fixtures, before properties)
 *   pos_orders
 *   properties
 *
 * Preconditions: identityVerified must be true AND tracked.properties non-empty.
 * On any error → ROLLBACK + re-throw.  Errors are NOT swallowed.
 *
 * NOTE: unexpected pos_settlements / payment_transactions / transactions
 *       created by the handler are NOT deleted here — they are reported by
 *       verifyNoResidue as unexpected residue.  Hiding them would mask a
 *       handler defect.  Only IDs explicitly tracked as test fixtures
 *       (tracked.transactions, tracked.posSettlements) are removed, and only
 *       by their own ID before properties.  Settlement must go before
 *       transactions (FK RESTRICT) and before pos_orders (FK RESTRICT).
 *
 * @param {import('pg').PoolClient} cleanupClient
 * @returns {Promise<{ discardClient: boolean }>}
 *   `discardClient` is true only when ROLLBACK itself failed (broken session).
 */
async function cleanupFixtures(cleanupClient) {
  if (!identityVerified) {
    throw new Error('SAFETY: cleanupFixtures dipanggil sebelum identitas terverifikasi');
  }
  if (tracked.properties.length === 0) {
    throw new Error('SAFETY: tidak ada tracked.properties — tidak ada fixture untuk dibersihkan');
  }

  let txnActive = false;
  let discardClient = false;
  try {
    await cleanupClient.query('BEGIN');
    txnActive = true;

    // Collect audit IDs scoped to this fixture's property IDs
    const auditRes = await cleanupClient.query(
      `SELECT audit_id FROM audit_logs WHERE property_id = ANY($1)`,
      [tracked.properties]
    );
    const auditIds = auditRes.rows.map((r) => String(r.audit_id));

    // Phase 1: delete pos_order_items via fixture order IDs
    if (tracked.posOrders.length) {
      await cleanupClient.query(
        `DELETE FROM pos_order_items WHERE order_id = ANY($1)`,
        [tracked.posOrders]
      );
    }

    // Phase 2: delete audit logs
    if (auditIds.length) {
      await cleanupClient.query(
        `DELETE FROM audit_logs WHERE audit_id = ANY($1)`,
        [auditIds]
      );
    }

    // Phase 3: delete tracked pos_settlements (S6 fixture) before
    // transactions & pos_orders. pos_settlements has FK RESTRICT on both
    // transaction_id → transactions and pos_order_id → pos_orders, so it
    // must be removed first. Only tracked settlement IDs are deleted.
    if (tracked.posSettlements.length) {
      await cleanupClient.query(
        `DELETE FROM pos_settlements WHERE id = ANY($1::int[])`,
        [tracked.posSettlements]
      );
    }

    // Phase 4: delete tracked SALE POS transactions (S4/S5/S6 fixtures)
    // before properties. transactions.property_id has FK ON DELETE
    // RESTRICT, so any tracked transaction must go first. We only delete
    // the transactions this test explicitly created (tracked.transactions)
    // — never a global sweep. Unexpected financial artifacts are reported
    // by verifyNoResidue, not hidden here.
    if (tracked.transactions.length) {
      await cleanupClient.query(
        `DELETE FROM transactions WHERE id = ANY($1::bigint[])`,
        [tracked.transactions]
      );
    }

    // Phase 5: delete pos_orders
    if (tracked.posOrders.length) {
      await cleanupClient.query(
        `DELETE FROM pos_orders WHERE id = ANY($1)`,
        [tracked.posOrders]
      );
    }

    // Phase 5b: delete transaction_daily_sequences scoped to tracked
    // property IDs. The service's generateTransactionNumber inserts one row
    // per property + date_key. ON DELETE CASCADE on properties.id would
    // handle it, but we delete explicitly for FK-safety and to be clear.
    if (tracked.transactionDailySequences.length) {
      for (const propertyId of tracked.transactionDailySequences) {
        await cleanupClient.query(
          `DELETE FROM transaction_daily_sequences WHERE property_id = $1`,
          [propertyId]
        );
      }
    }

    // Phase 6: delete properties
    await cleanupClient.query(
      `DELETE FROM properties WHERE id = ANY($1)`,
      [tracked.properties]
    );

    await cleanupClient.query('COMMIT');
    txnActive = false;
    return { discardClient: false };
  } catch (err) {
    // Attempt ROLLBACK if transaction is still active
    if (txnActive) {
      try {
        await cleanupClient.query('ROLLBACK');
        txnActive = false;
      } catch (rollbackErr) {
        fail('cleanup ROLLBACK failed', rollbackErr);
        process.exitCode = 1;
        discardClient = true;
      }
    }
    // Attach discard flag to the error so the caller can release precisely:
    //   release(discardClient) — only discard the session when ROLLBACK failed.
    err.discardClient = discardClient;
    // Re-throw the original error — caller catches and marks FAIL
    throw err;
  }
}

/**
 * Verify no residue remains for the fixture property / order IDs.
 * Uses SELECT COUNT(*) for every table.  Query errors THROW (not swallowed).
 * Returns array of residue descriptions (empty = clean).
 *
 * @param {import('pg').PoolClient} verifyClient
 * @returns {Promise<string[]>}
 */
async function verifyNoResidue(verifyClient) {
  const residue = [];
  if (tracked.properties.length === 0) return residue;

  const checks = [
    ['properties', 'id', tracked.properties],
    ['pos_orders', 'property_id', tracked.properties],
    ['pos_settlements', 'property_id', tracked.properties],
    ['transactions', 'property_id', tracked.properties],
    ['payment_transactions', 'property_id', tracked.properties],
    ['audit_logs', 'property_id', tracked.properties],
  ];

  // transaction_daily_sequences scoped to tracked property IDs
  if (tracked.transactionDailySequences.length) {
    checks.push(['transaction_daily_sequences', 'property_id', tracked.transactionDailySequences]);
  }

  // pos_order_items scoped by fixture order IDs
  if (tracked.posOrders.length) {
    checks.push(['pos_order_items', 'order_id', tracked.posOrders]);
  }

  for (const [table, col, param] of checks) {
    const r = await verifyClient.query(
      `SELECT COUNT(*) AS count FROM ${table} WHERE ${col} = ANY($1)`,
      [param]
    );
    const n = Number(r.rows[0].count);
    if (n > 0) {
      residue.push(`${table} (${col} = ANY fixture): ${n} row(s) remain`);
    }
  }

  return residue;
}

// Module-level flag so cleanupFixtures (defined at module scope) can check it.
let identityVerified = false;

// ─── 6c. Normalization helpers ────────────────────────────────────────────
/**
 * Normalize a POS order row for cross-source (DB vs JSON) comparison.
 * pg returns:  total_amount → string, created_at/updated_at → JS Date.
 * JSON returns: total_amount → number, timestamps → ISO strings.
 * This mapping makes both shapes comparable.
 */
function normalizeOrderRow(raw) {
  const row = raw || {};
  return {
    id: row.id != null ? Number(row.id) : null,
    property_id: row.property_id != null ? Number(row.property_id) : null,
    status: String(row.status || '').toUpperCase(),
    total_amount: row.total_amount != null ? Number(row.total_amount) : null,
    order_number: row.order_number != null ? String(row.order_number) : null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

/**
 * Read a POS order row directly from the DB (serial, per-client).
 * @returns {Promise<object|null>}
 */
async function readOrderFromDb(propertyId, orderId) {
  const c = await pool.connect();
  try {
    const r = await c.query(
      `SELECT * FROM pos_orders WHERE id = $1 AND property_id = $2`,
      [orderId, propertyId]
    );
    return r.rows.length ? normalizeOrderRow(r.rows[0]) : null;
  } finally {
    c.release();
  }
}

/**
 * Count rows in a property-scoped table.
 * @returns {Promise<number>}
 */
async function countPropertyTable(table, propertyId) {
  const c = await pool.connect();
  try {
    const r = await c.query(
      `SELECT COUNT(*) AS n FROM ${table} WHERE property_id = $1`,
      [propertyId]
    );
    return Number(r.rows[0].n);
  } finally {
    c.release();
  }
}

/**
 * Snapshot a single transaction by its own BIGINT id.
 * BIGINT columns (id, amount, net_amount) are normalized to string for
 * stable pre/post comparison.  `deleted_at` is returned as ISO string or null.
 * @returns {Promise<object|null>}
 */
async function readTransactionById(transactionId) {
  const c = await pool.connect();
  try {
    const r = await c.query(
      `SELECT id, property_id, transaction_no, source_type, source_id,
              transaction_status, payment_status, deleted_at,
              amount, net_amount
       FROM transactions WHERE id = $1::bigint`,
      [transactionId]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    return {
      id: String(row.id),
      property_id: row.property_id,
      transaction_no: row.transaction_no,
      source_type: row.source_type,
      source_id: row.source_id,
      transaction_status: row.transaction_status,
      payment_status: row.payment_status,
      // TIMESTAMPTZ → driver pg returns a Date; normalize to ISO for JSON compare
      deleted_at: row.deleted_at === null ? null : new Date(row.deleted_at).toISOString(),
      amount: row.amount === null ? null : String(row.amount),
      net_amount: row.net_amount === null ? null : String(row.net_amount),
    };
  } finally {
    c.release();
  }
}

/**
 * Read the VOID audit row for a POS order.
 * @returns {Promise<object|null>} — normalized audit row or null.
 */
async function readVoidAudit(propertyId, orderId) {
  const c = await pool.connect();
  try {
    const r = await c.query(
      `SELECT audit_id, module, action, entity, record_id, new_value, actor_user_id
       FROM audit_logs
       WHERE property_id = $1
         AND entity = 'pos_orders'
         AND record_id = $2
         AND action = 'VOID'
       ORDER BY audit_id ASC`,
      [propertyId, String(orderId)]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    let payload = null;
    try { payload = row.new_value ? JSON.parse(row.new_value) : null; } catch (_e) { payload = null; }
    return {
      audit_id: row.audit_id,
      module: row.module,
      action: row.action,
      entity: row.entity,
      record_id: row.record_id,
      actor_user_id: row.actor_user_id,
      payload,
    };
  } finally {
    c.release();
  }
}

/**
 * Verify all S1/S2 invariant checks on the response + DB.
 * Throws on the first violation — caller catches → fail() + exitCode=1.
 * @param {string} label — S1 or S2
 * @param {object} responseBody — parsed JSON response from PATCH
 * @param {object} ctx — { propertyId, orderId, actor }
 */
async function verifyScenario(label, responseBody, ctx) {
  const { propertyId, orderId, actor } = ctx;
  const expectedReplayed = label === 'S1' ? false : true;

  // ── HTTP + body shape ──
  if (responseBody.status !== 'SUCCESS') {
    throw new Error(`${label}: status field is ${JSON.stringify(responseBody.status)}, expected SUCCESS`);
  }
  if (typeof responseBody.replayed !== 'boolean' || responseBody.replayed !== expectedReplayed) {
    throw new Error(`${label}: replayed=${responseBody.replayed}, expected ${expectedReplayed}`);
  }

  // ── Response row vs DB row ──
  const dbRow = await readOrderFromDb(propertyId, orderId);
  if (!dbRow) {
    throw new Error(`${label}: order ${orderId} not found in DB`);
  }
  const respRow = normalizeOrderRow(responseBody.data);
  if (respRow.id !== dbRow.id) {
    throw new Error(`${label}: response id ${respRow.id} ≠ DB id ${dbRow.id}`);
  }
  if (respRow.status !== dbRow.status) {
    throw new Error(`${label}: response status ${respRow.status} ≠ DB status ${dbRow.status}`);
  }
  if (respRow.status !== 'VOIDED') {
    throw new Error(`${label}: expected VOIDED, got ${respRow.status}`);
  }
  if (respRow.total_amount !== dbRow.total_amount) {
    throw new Error(`${label}: response total ${respRow.total_amount} ≠ DB total ${dbRow.total_amount}`);
  }
  if (respRow.created_at !== dbRow.created_at) {
    throw new Error(`${label}: response created_at ${respRow.created_at} ≠ DB created_at ${dbRow.created_at}`);
  }
  if (respRow.updated_at !== dbRow.updated_at) {
    throw new Error(`${label}: response updated_at ${respRow.updated_at} ≠ DB updated_at ${dbRow.updated_at}`);
  }

  // ── Audit VOID: exactly one row, correct fields ──
  const auditCount = await countPropertyTable('audit_logs', propertyId);
  if (auditCount !== 1) {
    throw new Error(`${label}: audit_logs count=${auditCount}, expected 1`);
  }
  const audit = await readVoidAudit(propertyId, orderId);
  if (!audit) {
    throw new Error(`${label}: no VOID audit found for order ${orderId}`);
  }
  if (audit.module !== 'POS') {
    throw new Error(`${label}: audit module=${audit.module}, expected POS`);
  }
  if (audit.entity !== 'pos_orders') {
    throw new Error(`${label}: audit entity=${audit.entity}, expected pos_orders`);
  }
  if (String(audit.record_id) !== String(orderId)) {
    throw new Error(`${label}: audit record_id=${audit.record_id}, expected ${orderId}`);
  }
  if (!audit.payload || audit.payload.previous_status !== 'OPEN') {
    throw new Error(`${label}: audit payload.previous_status missing/wrong: ${JSON.stringify(audit.payload)}`);
  }
  if (audit.payload.new_status !== 'VOIDED') {
    throw new Error(`${label}: audit payload.new_status=${audit.payload.new_status}, expected VOIDED`);
  }
  if (audit.payload.actor_name !== actor.full_name) {
    throw new Error(`${label}: audit actor_name=${JSON.stringify(audit.payload.actor_name)}, expected ${actor.full_name}`);
  }
  if (audit.payload.actor_user_id !== String(actor.id)) {
    throw new Error(`${label}: audit actor_user_id=${JSON.stringify(audit.payload.actor_user_id)}, expected ${String(actor.id)}`);
  }
  if (audit.actor_user_id !== String(actor.id)) {
    throw new Error(`${label}: audit_logs.actor_user_id=${JSON.stringify(audit.actor_user_id)}, expected ${String(actor.id)}`);
  }

  // ── No financial artifacts created by the handler ──
  const txnCount = await countPropertyTable('transactions', propertyId);
  const settleCount = await countPropertyTable('pos_settlements', propertyId);
  const payTxnCount = await countPropertyTable('payment_transactions', propertyId);
  if (txnCount !== 0 || settleCount !== 0 || payTxnCount !== 0) {
    throw new Error(`${label}: unexpected financial artifacts (transactions=${txnCount}, pos_settlements=${settleCount}, payment_transactions=${payTxnCount})`);
  }

  pass(`${label}: all invariants verified`);
}

// ─── 7. Infrastruktur Concurrency (preparasi, belum dipakai skenario) ─────
// Adaptasi dari pola terbukti di pos_checkout_guard_test.js, dieruskan untuk
// pos_orders:
//   - Barrier hold sekali setelah SELECT ... FOR UPDATE di pos_orders sukses
//     (bukan reservations).
//   - PID (pg_backend_pid) ditangkap SEBELUM client dilempar ke handler/service.
//   - Deadline barrier & observer terbatas (konstanta ms eksplisit).
//   - Observer memakai statement_timeout PostgreSQL per-query.
//   - release() idempotent; session dengan timeout khusus dibuang (release(true))
//     agar pool consumer berikutnya tidak mewarisi lock/statement timeout.
// File ini TIDAK mengimpor / menjalankan pos_checkout_guard_test.js.

// ── Default timeout values (ms) ─────────────────────────────────────────────
const BARRIER_ACQUIRE_DEADLINE_MS = 5_000;  // max wait for signalLockAcquired
const OBSERVER_DEADLINE_MS        = 3_000;  // observeBlocking polling deadline
const OBSERVER_QUERY_TIMEOUT_MS   = 2_000;  // per-query observer timeout
const LOCK_TIMEOUT_MS             = 8_000;  // PostgreSQL lock_timeout (ms)
const STATEMENT_TIMEOUT_MS        = 20_000; // PostgreSQL statement_timeout (ms)

/** Validate that a number is positive and finite. Throws otherwise. */
function assertPositiveFiniteInt(name, value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value}`);
  }
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite, got: ${value}`);
  }
}

/**
 * Create a two-promise concurrency barrier.
 *
 *   acquired — resolved by signalLockAcquired() (idempotent)
 *   gate     — resolved by release() (idempotent, call in finally)
 *
 * @returns {{
 *   signalLockAcquired: () => void,
 *   waitUntilAcquired: (deadlineMs?: number) => Promise<boolean>,
 *   hold: () => Promise<void>,
 *   release: () => void,
 *   isReleased: () => boolean,
 * }}
 */
function createBarrier() {
  let acquiredResolve = null;
  const acquiredPromise = new Promise((resolve) => { acquiredResolve = resolve; });
  let acquiredSettled = false;

  let gateResolve = null;
  const gatePromise = new Promise((resolve) => { gateResolve = resolve; });
  let gateSettled = false;

  return {
    /** Resolve the acquired promise. Idempotent. Called after FOR UPDATE succeeds. */
    signalLockAcquired() {
      if (!acquiredSettled) {
        acquiredSettled = true;
        acquiredResolve();
      }
    },

    /** Bounded wait for signalLockAcquired(). true if acquired, false on timeout. */
    waitUntilAcquired(deadlineMs) {
      assertPositiveFiniteInt('deadlineMs', deadlineMs ?? BARRIER_ACQUIRE_DEADLINE_MS);
      const deadline = Date.now() + (deadlineMs ?? BARRIER_ACQUIRE_DEADLINE_MS);
      return new Promise((resolve) => {
        if (acquiredSettled) { resolve(true); return; }
        const timer = setTimeout(() => resolve(false), deadline - Date.now());
        acquiredPromise.then(() => { clearTimeout(timer); resolve(true); });
      });
    },

    /** Await until release(). Multiple calls return the same promise. */
    hold() {
      return gatePromise;
    },

    /** Resolve the gate. Idempotent. Must be called from a finally block. */
    release() {
      if (!gateSettled) {
        gateSettled = true;
        gateResolve();
      }
    },

    /** True once release() has been called. */
    isReleased() {
      return gateSettled;
    },
  };
}

/**
 * Create a connect/release pair wrapping a real PoolClient with barrier
 * interception on the pos_orders FOR UPDATE lock query.
 *
 * The wrapped client delegates ALL SQL to the underlying PostgreSQL client.
 * After the pos_orders FOR UPDATE query succeeds (exactly once per connect),
 * the wrapper signals the barrier and awaits hold().
 *
 * @param {object} opts
 * @param {import('pg').Pool}  opts.pool
 * @param {object|null}        opts.barrier — null for waiter side (no hold)
 * @param {number}            [opts.lockTimeoutMs]
 * @param {number}            [opts.statementTimeoutMs]
 * @returns {{
 *   connect: () => Promise<object>,
 *   release: (wrapped?: object) => void,
 *   getPid: () => number,
 *   getConnected: (deadlineMs?: number) => Promise<number>,
 * }}
 */
function createBarredConnect(opts) {
  if (!opts.pool || typeof opts.pool.connect !== 'function') {
    throw new Error('createBarredConnect: pool must be a pg Pool with connect()');
  }
  const lockTimeoutMs = opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  const statementTimeoutMs = opts.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS;
  assertPositiveFiniteInt('lockTimeoutMs', lockTimeoutMs);
  assertPositiveFiniteInt('statementTimeoutMs', statementTimeoutMs);
  // barrier may be null (waiter side)

  // Per-instance state — single connect() call per instance (handler lifecycle)
  let rawClient = null;
  let rawPid = null;
  let holdFired = false;
  let released = false;
  let connectCalled = false;
  let connectError = null;
  let connectedResolve = null;
  const connectedPromise = new Promise((resolve) => { connectedResolve = resolve; });

  /**
   * Detect whether the SQL text targets POS_ORDERS with FOR UPDATE.
   * Explicit predicate: `SELECT ... FROM pos_orders ... FOR UPDATE`.
   * Accepts both string SQL and { text: '...' } SQL objects.
   */
  function isPosOrdersForUpdate(textOrSql) {
    let sqlText;
    if (typeof textOrSql === 'string') {
      sqlText = textOrSql;
    } else if (textOrSql && typeof textOrSql.text === 'string') {
      sqlText = textOrSql.text;
    } else {
      return false;
    }
    const norm = sqlText.toUpperCase().replace(/\s+/g, ' ');
    return /FROM\s+POS_ORDERS\b.*FOR\s+UPDATE/.test(norm);
  }

  /**
   * Connect a real client, apply session timeouts, capture PID, return wrapped
   * client. PID is captured BEFORE the wrapped client is returned to the
   * handler/service. All setup wrapped in try/catch: failure signals
   * connected with { ok:false, error }. Second connect() throws.
   */
  async function connect() {
    if (connectCalled) {
      throw new Error('createBarredConnect: connect() called more than once on the same instance');
    }
    connectCalled = true;

    let raw;
    try {
      raw = await opts.pool.connect();
    } catch (err) {
      // pool.connect failed — no client to release
      connectError = err;
      connectedResolve({ ok: false, pid: null, error: err });
      throw err;
    }
    rawClient = raw;

    try {
      // Apply session-level timeouts (must be explicit ms values)
      await raw.query(`SET lock_timeout = ${lockTimeoutMs}`);
      await raw.query(`SET statement_timeout = ${statementTimeoutMs}`);

      // Capture pg_backend_pid BEFORE handing the client to the handler
      const pidRes = await raw.query('SELECT pg_backend_pid() AS pid');
      if (!pidRes.rows.length) {
        throw new Error('createBarredConnect: pg_backend_pid returned no rows');
      }
      const pid = Number(pidRes.rows[0].pid);
      assertPositiveFiniteInt('pg_backend_pid', pid);
      rawPid = pid;

      // Build the wrapped client the handler/service receives
      const wrapped = {
        query: async (textOrSql, params) => {
          const result = await raw.query(textOrSql, params);

          // Fire hold exactly once, after pos_orders FOR UPDATE succeeds
          if (!holdFired && opts.barrier && isPosOrdersForUpdate(textOrSql)) {
            holdFired = true;
            opts.barrier.signalLockAcquired();
            await opts.barrier.hold();
          }

          return result;
        },
        // Expose underlying client for advanced access (not used by handlers)
        client: raw,
      };

      // Signal that the client is ready (PID available, timeouts set)
      connectedResolve({ ok: true, pid, error: null });
      return wrapped;
    } catch (err) {
      // Setup failed — release the client (destroy session state), record error
      let releaseErr = null;
      try {
        raw.release(true);
      } catch (relErr) {
        releaseErr = relErr;
      }
      rawClient = null;
      rawPid = null;
      connectError = err;
      connectedResolve({ ok: false, pid: null, error: err });

      // If release also failed, log both errors; original error is primary
      if (releaseErr) {
        console.error(`createBarredConnect: setup error: ${err.message}; release error: ${releaseErr.message}`);
      }
      throw err;
    }
  }

  /**
   * Release the underlying client. Use release(true) to destroy session
   * settings so the next pool consumer doesn't inherit lock_timeout etc.
   * rawPid remains available via getPid() after release.
   * Release error → FAIL + exitCode=1 (not swallowed).
   * Idempotent: second and later calls are no-ops.
   */
  function release(wrapped) {
    if (released) return;
    released = true;
    if (rawClient) {
      try {
        rawClient.release(true);
      } catch (err) {
        fail('createBarredConnect release', err);
        process.exitCode = 1;
      }
      rawClient = null;
    }
  }

  /**
   * Returns the captured pg_backend_pid. Available even after release()
   * (PID is a snapshot, not a live handle). Throws if connect() not completed.
   */
  function getPid() {
    if (rawPid == null) {
      throw new Error('createBarredConnect: PID not yet available (connect not completed)');
    }
    return rawPid;
  }

  /**
   * Await until connect() has finished setup (timeouts applied, PID captured).
   * Success → PID; Failure → throw; Deadline exceeded → throw.
   */
  function getConnected(deadlineMs) {
    const dl = deadlineMs ?? BARRIER_ACQUIRE_DEADLINE_MS;
    assertPositiveFiniteInt('deadlineMs', dl);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`createBarredConnect: getConnected deadline (${dl}ms) exceeded`));
      }, dl);

      connectedPromise.then((result) => {
        clearTimeout(timer);
        if (result.ok) {
          resolve(result.pid);
        } else {
          reject(result.error);
        }
      });
    });
  }

  return { connect, release, getPid, getConnected };
}

/**
 * Observe blocking via pg_blocking_pids on a separate observer client.
 *
 * The caller must have already set statement_timeout = OBSERVER_QUERY_TIMEOUT_MS
 * on observerClient so each individual query is bounded at the PostgreSQL level.
 * No JS Promise.race is used — the query is awaited to completion or error.
 *
 * Polls `SELECT pg_blocking_pids($1)` until blockerPid appears in the result.
 * SQL errors THROW (not swallowed). Observation timeout means the test FAILS.
 *
 * @param {import('pg').PoolClient} observerClient — dedicated client (test pool),
 *   must have statement_timeout set by caller
 * @param {number} waiterPid  — pg_backend_pid of the blocked side
 * @param {number} blockerPid — pg_backend_pid of the lock holder
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] — overall polling deadline (default 3000)
 * @returns {Promise<void>} resolves when blocking observed; throws on timeout or SQL error
 */
async function observeBlocking(observerClient, waiterPid, blockerPid, opts = {}) {
  assertPositiveFiniteInt('waiterPid', waiterPid);
  assertPositiveFiniteInt('blockerPid', blockerPid);
  if (waiterPid === blockerPid) {
    throw new Error('observeBlocking: waiterPid and blockerPid must be different');
  }
  const timeoutMs = opts.timeoutMs ?? OBSERVER_DEADLINE_MS;
  assertPositiveFiniteInt('timeoutMs', timeoutMs);

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // Statement-level PostgreSQL timeout (set on observerClient by caller)
    // bounds each individual query. No JS timer needed here.
    let res;
    try {
      res = await observerClient.query(
        `SELECT pg_blocking_pids($1) AS blockers`,
        [waiterPid]
      );
    } catch (sqlErr) {
      // SQL error is a real failure — do not swallow
      throw new Error(`observeBlocking: SQL error: ${sqlErr.message}`);
    }

    const blockers = res.rows[0]?.blockers ?? [];
    const contains = blockers.some((pidStr) => Number(pidStr) === blockerPid);
    if (contains) return; // observed — success

    await new Promise((r) => setTimeout(r, 100));
  }

  // Deadline exceeded: this is a test failure
  throw new Error(
    `observeBlocking: blockerPid ${blockerPid} not observed blocking waiterPid ${waiterPid} within ${timeoutMs}ms`
  );
}

/**
 * Get pg_backend_pid for a live PoolClient. Throws if the query fails or
 * returns no rows.
 */
async function getBackendPid(client) {
  const res = await client.query('SELECT pg_backend_pid() AS pid');
  if (!res.rows.length) throw new Error('getBackendPid: no rows returned');
  const pid = Number(res.rows[0].pid);
  assertPositiveFiniteInt('pg_backend_pid', pid);
  return pid;
}

/**
 * Wrap a promise with a JS-side deadline (ms). Resolves with the value on
 * success; rejects with a clear error on timeout or on the underlying
 * rejection. Used to bound the service CASH promise so cleanup can always
 * settle it before pool.end().
 */
/**
 * Run a single void-vs-pay CASH concurrency trial (blocker = service CASH
 * holding the pos_orders FOR UPDATE; waiter = the void handler blocked).
 *
 * Wiring guarantees (per user spec):
 *   - Both pay and void sides use lockTimeoutMs=8000, statementTimeoutMs=20000
 *     (proven checkout-test values).
 *   - All acquisition/setup/operations are inside ONE outer try/finally.
 *     The finally runs strictly:
 *       a. release the barrier (idempotent);
 *       b. await the already-started pay & void promises via
 *          Promise.allSettled on the ORIGINAL promises (no JS bypass timer);
 *       c. only then release the pay/void clients;
 *       d. finally observer.release(true).
 *   - A service/query still running must NOT have its client released: the
 *     finally awaits the original promises first (bounded by the PostgreSQL
 *     lock_timeout/statement_timeout), then releases the clients.
 *   - The barrier-not-acquired path THROWS a test error (it does not return
 *     a result as if the trial completed); the finally still cleans up.
 *   - An observation failure also THROWS; the finally still cleans up.
 *   - Both promises receive rejection handling immediately so a later
 *     rejection can never become unhandled; the original error is preserved
 *     for scenario assertions.
 *
 * @param {object} p
 * @param {number} p.propertyId
 * @param {number} p.orderId        — the shared pos_order both sides target
 * @param {string} p.idempotencyKey — for payPosOrderCash
 * @param {string} p.actorName
 * @param {string} p.actorUserId
 * @returns {Promise<{ payResult: object|null, payError: Error|null,
 *                    voidResponse: object|null, observed: boolean,
 *                    blockerPid: number, waiterPid: number }>}
 */
async function runVoidVsPayConcurrency(p) {
  const { propertyId, orderId, idempotencyKey, actorName, actorUserId } = p;
  assertPositiveFiniteInt('propertyId', propertyId);
  assertPositiveFiniteInt('orderId', orderId);

  // ── Outer scope: clients + promises + PIDs live here so the finally can use ──
  let payClient = null;
  let voidClient = null;
  let payPromise = null;
  let voidRequestPromise = null;
  let payPid = null;
  let voidPid = null;

  // Blocker (service CASH): intercepts pos_orders FOR UPDATE, then holds.
  const barrier = createBarrier();
  const payConnect = createBarredConnect({
    pool,
    barrier,
    lockTimeoutMs: 8000,
    statementTimeoutMs: 20000,
  });

  // Waiter (void handler): no hold (barrier null), same proven timeouts.
  const voidConnect = createBarredConnect({
    pool,
    barrier: null,
    lockTimeoutMs: 8000,
    statementTimeoutMs: 20000,
  });

  // Observer: dedicated client; its polling queries are bounded by a
  // per-query statement_timeout that the caller SETs BEFORE observeBlocking.
  const observerClient = await pool.connect();

  try {
    // ── 1. Connect pay side; capture PID before handing the client ──────
    payClient = await payConnect.connect();
    payPid = payConnect.getPid();

    // ── 2. Connect void side; capture PID ─────────────────────────────────
    voidClient = await voidConnect.connect();
    voidPid = voidConnect.getPid();

    // Void handler wired on its own client (deps.connect/release pattern).
    //   connect: reuse the pre-connected wrapped client (PID captured before
    //            the handler runs, so the blocker already holds the lock).
    //   release: the handler's finally calls deps.release(client, discard).
    //            voidConnect.release is idempotent + release(true), so a
    //            second call from the orchestrator's finally is safe.
    //   assertPropertyScope: compares req.user.property_id to the request's
    //            property_id (same contract as S1–S6); rejects mismatch/invalid.
    const voidHandler = createPosOrderStatusHandler({
      pool,
      connect: async () => voidClient,
      release: (c, discard) => voidConnect.release(c),
      assertPropertyScope: async (req, reqPropertyId) => {
        const userPropertyId = Number(req?.user?.property_id);
        if (!Number.isInteger(userPropertyId) || userPropertyId <= 0) {
          throw Object.assign(new Error('actor property_id tidak valid'), {
            statusCode: 403,
            code: 'PROPERTY_SCOPE_INVALID',
          });
        }
        if (userPropertyId !== Number(reqPropertyId)) {
          throw Object.assign(new Error('actor tidak memiliki akses ke properti ini'), {
            statusCode: 403,
            code: 'PROPERTY_SCOPE_REQUIRED',
          });
        }
      },
    });

    // ── 3. Start the service CASH as a PENDING promise (do NOT await yet).
    // Attach rejection handling immediately so a later rejection is never
    // unhandled; the original error is preserved for assertions.
    payPromise = payPosOrderCash(payClient, {
      propertyId,
      orderId,
      idempotencyKey,
      actorName,
      actorUserId,
    }).then(
      (r) => ({ ok: true, result: r }),
      (e) => ({ ok: false, error: e })
    );

    // ── 4. Wait for the pay side to have acquired + fired the hold ──────
    const acquired = await barrier.waitUntilAcquired(BARRIER_ACQUIRE_DEADLINE_MS);
    if (!acquired) {
      // Barrier never fired → TEST ERROR, not a "trial completed" result.
      // finally still cleans up (barrier release + settle + client release).
      throw new Error(
        `runVoidVsPayConcurrency: barrier tidak acquired dalam ${BARRIER_ACQUIRE_DEADLINE_MS}ms `
        + `(pay lock/hold tidak memicu barrier)`
      );
    }

    // ── 5. Fire the void request while pay holds the lock ───────────────
    // The void handler's pos_orders FOR UPDATE will block on pay's lock.
    // Immediate handler → { ok:true, result } | { ok:false, error }.
    voidRequestPromise = (async () => {
      const req = {
        params: { id: String(orderId) },
        body: { status: 'VOIDED', property_id: propertyId },
        user: { id: actorUserId, full_name: actorName, property_id: propertyId },
      };
      let captured = null;
      const res = {
        status(code) { this._code = code; return this; },
        json(body) { captured = { code: this._code, body }; return this; },
      };
      await voidHandler(req, res);
      return { ok: true, result: captured };
    })().catch((e) => ({ ok: false, error: e }));

    // ── 6. Observe that pay blocks void (PID captured before handler ran)
    // SET the observer's per-query statement_timeout BEFORE polling.
    await observerClient.query(`SET statement_timeout = ${OBSERVER_QUERY_TIMEOUT_MS}`);
    await observeBlocking(observerClient, voidPid, payPid, { timeoutMs: OBSERVER_DEADLINE_MS });
    const observed = true;

    // ── 7. Blocking proven → release barrier, then await ACTUAL results ──
    barrier.release();
    const [paySet, voidSet] = await Promise.allSettled([payPromise, voidRequestPromise]);

    // Distinguish a PROMISE REJECTION (crash / infra bug) from a fulfilled
    // { ok:false } (a business error the service/handler returned). A
    // rejection here is a test-infrastructure defect → fail + nonzero exit.
    if (paySet.status === 'rejected') {
      fail('payPosOrderCash promise rejected (infra)', paySet.reason);
      if (process.exitCode !== 1) process.exitCode = 1;
    }
    if (voidSet.status === 'rejected') {
      fail('void PATCH promise rejected (infra)', voidSet.reason);
      if (process.exitCode !== 1) process.exitCode = 1;
    }

    // The fulfilled { ok:false } value is the ACTUAL business outcome —
    // returned to the caller so a scenario can assert on it. It is NOT
    // swallowed or auto-promoted to success.
    const payOutcome = paySet.status === 'fulfilled' ? paySet.value : null;
    const voidOutcome = voidSet.status === 'fulfilled' ? voidSet.value : null;

    return {
      payResult: payOutcome?.ok ? payOutcome.result : null,
      payError:  payOutcome?.ok ? null : payOutcome?.error,
      voidResponse: voidOutcome?.ok ? voidOutcome.result : null,
      voidError:  voidOutcome?.ok ? null : voidOutcome?.error,
      observed,
      blockerPid: payPid,
      waiterPid: voidPid,
    };

  } finally {
    // ── a. Release the barrier (idempotent) — unblocks the pay service ──
    barrier.release();

    // ── b. Settle EVERY started promise INDEPENDENTLY. Do NOT require both
    //     to exist: filter out any null (e.g. the void request was never
    //     started because the barrier was not acquired).
    const started = [payPromise, voidRequestPromise].filter(Boolean);
    if (started.length > 0) {
      await Promise.allSettled(started);
    }

    // ── c. Now that no service/query is running, release pay & void ─────
    payConnect.release(payClient);    // release(true) — destroy session state
    voidConnect.release(voidClient);  // release(true) — destroy session state

    // ── d. Last: discard the observer session (statement_timeout set) ────
    try { observerClient.release(true); }
    catch (relErr) { fail('observerClient.release(true) gagal', relErr); if (process.exitCode !== 1) process.exitCode = 1; }
  }
}

/**
 * Run a single void-vs-pay CASH concurrency trial (blocker = void handler
 * holding the pos_orders FOR UPDATE; waiter = service CASH blocked).
 *
 * S8 — the reverse of S7:
 *   - Void handler (blocker): holds barrier after pos_orders FOR UPDATE.
 *   - payPosOrderCash (waiter): no barrier; blocks on the same FOR UPDATE.
 *   - Observer proves pg_blocking_pids(payPid) contains voidPid.
 *   - After barrier release: void commits → order VOIDED.
 *   - CASH unblocks, re-reads order, finds VOIDED → PosSettlementError 409
 *     ORDER_NOT_PAYABLE.
 *
 * Wiring guarantees:
 *   - Both sides use lockTimeoutMs=8000, statementTimeoutMs=20000.
 *   - All acquisition/setup/operations are inside ONE outer try/finally.
 *     The finally runs strictly:
 *       a. release the barrier (idempotent);
 *       b. await the already-started void & pay promises via
 *          Promise.allSettled on the ORIGINAL promises (no JS bypass timer);
 *       c. only then release the pay/void clients;
 *       d. finally observer.release(true).
 *
 * @param {object} p
 * @param {number} p.propertyId
 * @param {number} p.orderId        — the shared pos_order both sides target
 * @param {string} p.idempotencyKey — for payPosOrderCash
 * @param {string} p.actorName
 * @param {string} p.actorUserId
 * @returns {Promise<{
 *   payResult: object|null, payError: Error|null,
 *   voidResponse: object|null, voidError: Error|null,
 *   observed: boolean,
 *   blockerPid: number, waiterPid: number
 * }>}
 */
async function runVoidVsPayConcurrencyS8(p) {
  const { propertyId, orderId, idempotencyKey, actorName, actorUserId } = p;
  assertPositiveFiniteInt('propertyId', propertyId);
  assertPositiveFiniteInt('orderId', orderId);

  // ── Outer scope: clients + promises + PIDs live here so the finally can use ──
  let payClient = null;
  let voidClient = null;
  let voidPromise = null;
  let payRequestPromise = null;
  let payPid = null;
  let voidPid = null;

  // Blocker (void handler): intercepts pos_orders FOR UPDATE, then holds.
  const barrier = createBarrier();
  const voidConnect = createBarredConnect({
    pool,
    barrier,
    lockTimeoutMs: 8000,
    statementTimeoutMs: 20000,
  });

  // Waiter (service CASH): no hold (barrier null), same proven timeouts.
  const payConnect = createBarredConnect({
    pool,
    barrier: null,
    lockTimeoutMs: 8000,
    statementTimeoutMs: 20000,
  });

  // Observer: dedicated client; its polling queries are bounded by a
  // per-query statement_timeout that the caller SETs BEFORE observeBlocking.
  const observerClient = await pool.connect();

  try {
    // ── 1. Connect void side (blocker); capture PID before handing the client ─
    voidClient = await voidConnect.connect();
    voidPid = voidConnect.getPid();

    // ── 2. Connect pay side (waiter); capture PID ──────────────────────────
    payClient = await payConnect.connect();
    payPid = payConnect.getPid();

    // Void handler wired on its own client (deps.connect/release pattern).
    //   connect: reuse the pre-connected wrapped client (PID captured before
    //            the handler runs, so the blocker already holds the lock).
    //   release: the handler's finally calls deps.release(client, discard).
    //            voidConnect.release is idempotent + release(true), so a
    //            second call from the orchestrator's finally is safe.
    const voidHandler = createPosOrderStatusHandler({
      pool,
      connect: async () => voidClient,
      release: (c, discard) => voidConnect.release(c),
      assertPropertyScope: async (req, reqPropertyId) => {
        const userPropertyId = Number(req?.user?.property_id);
        if (!Number.isInteger(userPropertyId) || userPropertyId <= 0) {
          throw Object.assign(new Error('actor property_id tidak valid'), {
            statusCode: 403,
            code: 'PROPERTY_SCOPE_INVALID',
          });
        }
        if (userPropertyId !== Number(reqPropertyId)) {
          throw Object.assign(new Error('actor tidak memiliki akses ke properti ini'), {
            statusCode: 403,
            code: 'PROPERTY_SCOPE_REQUIRED',
          });
        }
      },
    });

    // ── 3. Fire the void request as a PENDING promise (do NOT await yet).
    // Attach rejection handling immediately so a later rejection is never
    // unhandled; the original error is preserved for assertions.
    voidPromise = (async () => {
      const req = {
        params: { id: String(orderId) },
        body: { status: 'VOIDED', property_id: propertyId },
        user: { id: actorUserId, full_name: actorName, property_id: propertyId },
      };
      let captured = null;
      const res = {
        status(code) { this._code = code; return this; },
        json(body) { captured = { code: this._code, body }; return this; },
      };
      await voidHandler(req, res);
      return { ok: true, result: captured };
    })().catch((e) => ({ ok: false, error: e }));

    // ── 4. Wait for the void side to have acquired + fired the hold ───────
    const acquired = await barrier.waitUntilAcquired(BARRIER_ACQUIRE_DEADLINE_MS);
    if (!acquired) {
      // Barrier never fired → TEST ERROR, not a "trial completed" result.
      // finally still cleans up (barrier release + settle + client release).
      throw new Error(
        `runVoidVsPayConcurrencyS8: barrier tidak acquired dalam ${BARRIER_ACQUIRE_DEADLINE_MS}ms `
        + `(void lock/hold tidak memicu barrier)`
      );
    }

    // ── 5. Start the CASH service while void holds the lock ───────────────
    // The service CASH's pos_orders FOR UPDATE will block on void's lock.
    payRequestPromise = payPosOrderCash(payClient, {
      propertyId,
      orderId,
      idempotencyKey,
      actorName,
      actorUserId,
    }).then(
      (r) => ({ ok: true, result: r }),
      (e) => ({ ok: false, error: e })
    );

    // ── 6. Observe that void blocks pay (PID captured before handler ran)
    // SET the observer's per-query statement_timeout BEFORE polling.
    await observerClient.query(`SET statement_timeout = ${OBSERVER_QUERY_TIMEOUT_MS}`);
    await observeBlocking(observerClient, payPid, voidPid, { timeoutMs: OBSERVER_DEADLINE_MS });
    const observed = true;

    // ── 7. Blocking proven → release barrier, then await ACTUAL results ──
    barrier.release();
    const [voidSet, paySet] = await Promise.allSettled([voidPromise, payRequestPromise]);

    // Distinguish a PROMISE REJECTION (crash / infra bug) from a fulfilled
    // { ok:false } (a business error the service/handler returned).
    if (voidSet.status === 'rejected') {
      fail('void PATCH promise rejected (infra)', voidSet.reason);
      if (process.exitCode !== 1) process.exitCode = 1;
    }
    if (paySet.status === 'rejected') {
      fail('payPosOrderCash promise rejected (infra)', paySet.reason);
      if (process.exitCode !== 1) process.exitCode = 1;
    }

    const voidOutcome = voidSet.status === 'fulfilled' ? voidSet.value : null;
    const payOutcome = paySet.status === 'fulfilled' ? paySet.value : null;

    return {
      voidResponse: voidOutcome?.ok ? voidOutcome.result : null,
      voidError:    voidOutcome?.ok ? null : voidOutcome?.error,
      payResult:    payOutcome?.ok ? payOutcome.result : null,
      payError:     payOutcome?.ok ? null : payOutcome?.error,
      observed,
      blockerPid: voidPid,
      waiterPid:  payPid,
    };

  } finally {
    // ── a. Release the barrier (idempotent) — unblocks the void handler ───
    barrier.release();

    // ── b. Settle EVERY started promise INDEPENDENTLY ───────────────────
    const started = [voidPromise, payRequestPromise].filter(Boolean);
    if (started.length > 0) {
      await Promise.allSettled(started);
    }

    // ── c. Now that no service/query is running, release void & pay ──────
    voidConnect.release(voidClient);  // release(true) — destroy session state
    payConnect.release(payClient);    // release(true) — destroy session state

    // ── d. Last: discard the observer session (statement_timeout set) ────
    try { observerClient.release(true); }
    catch (relErr) { fail('observerClient.release(true) gagal', relErr); if (process.exitCode !== 1) process.exitCode = 1; }
  }
}

// ─── 8. Main ───────────────────────────────────────────────────────────────
(async () => {
  identityVerified = false;
  let httpServer;
  let propertyId;
  let orderId;
  let s3OrderId;
  let s4OrderId;
  let s4TxnId;
  let s1UpdatedAt;
  let s1DbRow;

  try {
    verifyPoolOptions();
    await verifyDatabase();
    identityVerified = true;

    // ── 1. Fixture setup ──────────────────────────────────────────────────
    const setupClient = await pool.connect();
    try {
      const prop = await createFixtureProperty(setupClient);
      propertyId = prop.propertyId;
      const order = await createFixturePosOrder(setupClient, propertyId);
      orderId = order.orderId;
      // S3 uses a second standalone OPEN order in the same property so the
      // rejection tests never touch the S1/S2 order.
      const s3Order = await createFixturePosOrder(setupClient, propertyId);
      s3OrderId = s3Order.orderId;
      pass('fixture: property + POS orders (S1/S2 + S3 rejection) created');
    } finally {
      try { setupClient.release(); }
      catch (relErr) { fail('setupClient.release gagal', relErr); if (process.exitCode !== 1) process.exitCode = 1; }
    }

    // ── 2. Express local server with synthetic auth middleware ──────────
    const express = require('express');
    const app = express();
    app.use(express.json());

    // Synthetic actor — used by the assertPropertyScope adapter and by
    // the handler's req.user-based audit payload construction.
    const actor = {
      id: 42,
      username: 'guard_actor',
      full_name: 'Guard Actor',
      property_id: propertyId,
    };

    // Test middleware: injects req.user (this is NOT production auth)
    app.use((req, res, next) => {
      req.user = {
        id: actor.id,
        username: actor.username,
        full_name: actor.full_name,
        property_id: actor.property_id,
      };
      next();
    });

    // Production factory — PATCH /api/pos/orders/:id/status
    app.patch(
      '/api/pos/orders/:id/status',
      createPosOrderStatusHandler({
        pool,
        connect: () => pool.connect(),
        release: (client, discard) => {
          if (discard) { client.release(true); }
          else { client.release(); }
        },
        assertPropertyScope: async (req, reqPropertyId) => {
          // Compare req.user.property_id against the request property_id
          const userPropertyId = Number(req.user?.property_id);
          if (!Number.isInteger(userPropertyId) || userPropertyId <= 0) {
            throw Object.assign(new Error('actor property_id tidak valid'), {
              statusCode: 403,
              code: 'PROPERTY_SCOPE_INVALID',
            });
          }
          if (userPropertyId !== Number(reqPropertyId)) {
            throw Object.assign(new Error('actor tidak memiliki akses ke properti ini'), {
              statusCode: 403,
              code: 'PROPERTY_SCOPE_REQUIRED',
            });
          }
        },
      })
    );

    httpServer = app.listen(0, '127.0.0.1');
    httpServer.on('error', (err) => {
      fail('Express server error', err);
      process.exitCode = 1;
    });
    await new Promise((resolve, reject) => {
      httpServer.on('listening', resolve);
      httpServer.on('error', reject);
    });
    const port = httpServer.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    pass(`Express server listening pada ${baseUrl}`);

    const HTTP_TIMEOUT_MS = 15_000;

    // ── 3. S1: PATCH VOIDED — OPEN → VOIDED ─────────────────────────────
    const s1Res = await fetch(
      `${baseUrl}/api/pos/orders/${orderId}/status`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'VOIDED', property_id: propertyId }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      }
    );
    const s1Body = await s1Res.json();
    if (s1Res.status !== 200) {
      throw new Error(`S1: HTTP ${s1Res.status} ≠ 200, body=${JSON.stringify(s1Body)}`);
    }
    await verifyScenario('S1', s1Body, { propertyId, orderId, actor });
    s1DbRow = normalizeOrderRow(s1Body.data);
    s1UpdatedAt = s1DbRow.updated_at;
    pass(`S1: updated_at terkunci = ${s1UpdatedAt}`);

    // ── 4. S2: PATCH VOIDED lagi — replay idempoten ─────────────────────
    const s2Res = await fetch(
      `${baseUrl}/api/pos/orders/${orderId}/status`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'VOIDED', property_id: propertyId }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      }
    );
    const s2Body = await s2Res.json();
    if (s2Res.status !== 200) {
      throw new Error(`S2: HTTP ${s2Res.status} ≠ 200, body=${JSON.stringify(s2Body)}`);
    }
    await verifyScenario('S2', s2Body, { propertyId, orderId, actor });

    // ── S2 specific: updated_at must be identical to S1 ──
    const s2DbRow = normalizeOrderRow(s2Body.data);
    if (s2DbRow.updated_at !== s1UpdatedAt) {
      throw new Error(`S2: updated_at berubah (S1=${s1UpdatedAt}, S2=${s2DbRow.updated_at})`);
    }
    // Full row S1 vs S2 must be identical
    if (JSON.stringify(s1DbRow) !== JSON.stringify(s2DbRow)) {
      throw new Error(`S2: row berbeda dengan S1:\n S1=${JSON.stringify(s1DbRow)}\n S2=${JSON.stringify(s2DbRow)}`);
    }
    pass('S2: row identik S1, updated_at tetap');

    // ── 5. S3: Rejection paths — no mutation, no new audit ───────────────
    // Use the second OPEN order (s3OrderId) so S1/S2 order is untouched.
    const s3PreRow = await readOrderFromDb(propertyId, s3OrderId);
    if (!s3PreRow) throw new Error(`S3: order ${s3OrderId} not found in DB (pre)`);
    const s3PreUpdatedAt = s3PreRow.updated_at;

    // Helper: fire a PATCH, assert expected status + code, confirm no leak
    async function rejectPatch(status, expectedCode, expectedHttpStatus, bodyOverride) {
      const body = bodyOverride !== undefined
        ? bodyOverride
        : JSON.stringify({ status, property_id: propertyId });
      const res = await fetch(`${baseUrl}/api/pos/orders/${s3OrderId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      const parsed = await res.json().catch(() => ({}));
      if (res.status !== expectedHttpStatus) {
        throw new Error(`S3 [${JSON.stringify(status)}]: HTTP ${res.status} ≠ ${expectedHttpStatus}, body=${JSON.stringify(parsed)}`);
      }
      if (parsed.code !== expectedCode) {
        throw new Error(`S3 [${JSON.stringify(status)}]: code=${JSON.stringify(parsed.code)}, expected ${expectedCode}`);
      }
      if (parsed.status !== 'ERROR') {
        throw new Error(`S3 [${JSON.stringify(status)}]: status field=${JSON.stringify(parsed.status)}, expected ERROR`);
      }
    }

    // 5a. status not sent at all → 400 INVALID_STATUS_TARGET
    await rejectPatch(undefined, 'INVALID_STATUS_TARGET', 400,
      JSON.stringify({ property_id: propertyId }));
    pass('S3: status not sent → 400 INVALID_STATUS_TARGET');

    // 5b. status = null → 400 INVALID_STATUS_TARGET
    await rejectPatch(null, 'INVALID_STATUS_TARGET', 400);
    pass('S3: status=null → 400 INVALID_STATUS_TARGET');

    // 5c. status = '' (empty string) → 400 INVALID_STATUS_TARGET
    await rejectPatch('', 'INVALID_STATUS_TARGET', 400);
    pass('S3: status="" → 400 INVALID_STATUS_TARGET');

    // 5d. status = number → 400 INVALID_STATUS_TARGET
    await rejectPatch(123, 'INVALID_STATUS_TARGET', 400,
      JSON.stringify({ status: 123, property_id: propertyId }));
    pass('S3: status=123 → 400 INVALID_STATUS_TARGET');

    // 5e. status = object → 400 INVALID_STATUS_TARGET
    await rejectPatch({ x: 1 }, 'INVALID_STATUS_TARGET', 400,
      JSON.stringify({ status: { x: 1 }, property_id: propertyId }));
    pass('S3: status={x:1} → 400 INVALID_STATUS_TARGET');

    // 5f. Supported-but-rejected status values → 400 UNSUPPORTED_TARGET
    for (const s of ['OPEN', 'PAID', 'COMPLETED', 'POSTED', 'CLOSED', 'CANCELLED', 'REFUNDED']) {
      await rejectPatch(s, 'UNSUPPORTED_TARGET', 400);
      pass(`S3: status=${s} → 400 UNSUPPORTED_TARGET`);
    }

    // 5g. Post-S3 invariant: s3 order row unchanged (status + updated_at)
    const s3PostRow = await readOrderFromDb(propertyId, s3OrderId);
    if (!s3PostRow) throw new Error('S3: order not found in DB (post)');
    if (s3PostRow.status !== s3PreRow.status) {
      throw new Error(`S3: order status changed ${s3PreRow.status} → ${s3PostRow.status}`);
    }
    if (s3PostRow.updated_at !== s3PreUpdatedAt) {
      throw new Error(`S3: order updated_at changed (${s3PreUpdatedAt} → ${s3PostRow.updated_at})`);
    }
    if (JSON.stringify(s3PreRow) !== JSON.stringify(s3PostRow)) {
      throw new Error(`S3: order row mutated by rejection requests:\n pre=${JSON.stringify(s3PreRow)}\n post=${JSON.stringify(s3PostRow)}`);
    }
    pass('S3: order row unchanged after all rejection requests');

    // 5h. No new audit rows for the S3 order
    const s3Audit = await readVoidAudit(propertyId, s3OrderId);
    if (s3Audit) {
      throw new Error(`S3: unexpected VOID audit for order ${s3OrderId} (audit_id=${s3Audit.audit_id})`);
    }
    pass('S3: no audit created for S3 order');

    // 5i. Property-wide audit count still equals 1 (only the S1 VOID audit)
    const auditTotal = await countPropertyTable('audit_logs', propertyId);
    if (auditTotal !== 1) {
      throw new Error(`S3: audit_logs count=${auditTotal}, expected 1 (S1 only)`);
    }
    pass(`S3: property audit count = ${auditTotal} (S1 VOID only)`);

    // 5j. Financial artifact counts remain 0
    const s3Txn = await countPropertyTable('transactions', propertyId);
    const s3Settle = await countPropertyTable('pos_settlements', propertyId);
    const s3PayTxn = await countPropertyTable('payment_transactions', propertyId);
    if (s3Txn !== 0 || s3Settle !== 0 || s3PayTxn !== 0) {
      throw new Error(`S3: financial artifacts appeared (transactions=${s3Txn}, settlements=${s3Settle}, payment_transactions=${s3PayTxn})`);
    }
    pass('S3: no financial artifacts (all counts = 0)');

    // Helper: transaksi POS terkait order (source_type POS_ORDER, source_id=String(orderId))
    async function readPosOrderTransactions(propertyId, orderId) {
      const r = await pool
        .query(
          `SELECT id, transaction_no, transaction_status, payment_status,
                  amount, net_amount, source_type, source_id
             FROM transactions
            WHERE property_id = $1
              AND source_type IN ('POS_ORDER', 'POS')
              AND source_id   = $2
            ORDER BY id::bigint`,
          [propertyId, String(orderId)]
        )
        .then((q) => q.rows);
      return r.map((row) => ({
        ...row,
        id: String(row.id),
        amount: row.amount === null ? null : String(row.amount),
        net_amount: row.net_amount === null ? null : String(row.net_amount),
      }));
    }

    // ── 7. S4: VOIDED ditolak (409) bila transaksi finansial sudah ada ─
    // Order OPEN + transaksi SALE POS terkait → void harus ditolak;
    // row order & transaksi tidak berubah, tidak ada reversal/settlement/
    // payment/audit baru. Fixture S4 dibuat JIKA diperlukan — setelah seluruh
    // asersi S3 selesai — agar tidak memengaruhi baseline S1–S3.
    // s4OrderId & s4TxnId ditrack langsung setelah INSERT; cleanup menghapus
    // transaksi berdasarkan tracked ID sebelum properties.

    // Setup dedicated untuk fixture S4 (order + transaksi SALE).
    const s4SetupClient = await pool.connect();
    try {
      const s4Order = await createFixturePosOrder(s4SetupClient, propertyId);
      s4OrderId = s4Order.orderId;
      s4TxnId = await createPosSaleTransactionFixture(s4SetupClient, propertyId, s4OrderId, 53000);
      pass('S4: fixture — OPEN order + transaksi SALE POS dibuat');
    } catch (s4SetupErr) {
      // Kegagalan setup → FAIL + abort; jangan lanjut ke pre-snapshot/PATCH
      // karena fixture S4 belum terbentuk (tidak ada yang dapat diverifikasi).
      fail('S4 fixture setup gagal', s4SetupErr);
      process.exitCode = 1;
      throw s4SetupErr; // → ditangkap oleh outer catch('Main') → cleanup tetap jalan
    } finally {
      // Release selalu dijalankan (sukses maupun gagal setup).
      try { s4SetupClient.release(); }
      catch (relErr) { fail('S4 setupClient.release gagal', relErr); if (process.exitCode !== 1) process.exitCode = 1; }
    }

    const s4PreRow = await readOrderFromDb(propertyId, s4OrderId);
    if (!s4PreRow) throw new Error(`S4: order ${s4OrderId} not found in DB (pre)`);
    const s4PreUpdatedAt = s4PreRow.updated_at;
    const s4PreTxns = await readPosOrderTransactions(propertyId, s4OrderId);
    if (s4PreTxns.length !== 1) {
      throw new Error(`S4: expected 1 POS transaction fixture, found ${s4PreTxns.length}`);
    }
    // Baseline artefak finansial: S1 (VOID S1 order) tidak menghasilkan transaksi
    // lain di properti, dan S3 hanya me-reject — tidak ada write. Jadi:
    //   transaksi properti = tepat 1 (fixture S4)
    //   audit_logs properti = 1 (hanya VOID audit S1)
    //   settlement & payment = 0 (test tidak membuat fixture)
    const s4PreTxnCount = await countPropertyTable('transactions', propertyId);
    const s4PreAudit = await countPropertyTable('audit_logs', propertyId);
    const s4PreSettle = await countPropertyTable('pos_settlements', propertyId);
    const s4PrePay = await countPropertyTable('payment_transactions', propertyId);
    if (s4PreTxnCount !== 1) throw new Error(`S4: pre-check transaksi count=${s4PreTxnCount}, expected 1 (S4 fixture)`);
    if (s4PreAudit !== 1) throw new Error(`S4: pre-check audit_logs count=${s4PreAudit}, expected 1 (S1 VOID)`);

    const s4Res = await fetch(`${baseUrl}/api/pos/orders/${s4OrderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'VOIDED', property_id: propertyId }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const s4Body = await s4Res.json();
    if (s4Res.status !== 409) {
      throw new Error(`S4: HTTP ${s4Res.status} ≠ 409, body=${JSON.stringify(s4Body)}`);
    }
    if (s4Body.code !== 'POS_ORDER_FINANCIAL_ARTIFACTS_PRESENT') {
      throw new Error(`S4: code=${JSON.stringify(s4Body.code)}, expected POS_ORDER_FINANCIAL_ARTIFACTS_PRESENT`);
    }
    if (s4Body.status !== 'ERROR') {
      throw new Error(`S4: status field=${JSON.stringify(s4Body.status)}, expected ERROR`);
    }
    pass('S4: PATCH VOIDED → 409 POS_ORDER_FINANCIAL_ARTIFACTS_PRESENT');

    // 7a. Row order & updated_at tidak berubah
    const s4PostRow = await readOrderFromDb(propertyId, s4OrderId);
    if (!s4PostRow) throw new Error('S4: order not found in DB (post)');
    if (s4PostRow.status !== s4PreRow.status) {
      throw new Error(`S4: order status changed ${s4PreRow.status} → ${s4PostRow.status}`);
    }
    if (s4PostRow.updated_at !== s4PreUpdatedAt) {
      throw new Error(`S4: order updated_at changed (${s4PreUpdatedAt} → ${s4PostRow.updated_at})`);
    }
    if (JSON.stringify(s4PreRow) !== JSON.stringify(s4PostRow)) {
      throw new Error(`S4: order row mutated:\n pre=${JSON.stringify(s4PreRow)}\n post=${JSON.stringify(s4PostRow)}`);
    }
    pass('S4: row order & updated_at identik sebelum/sesudah');

    // 7b. Transaksi fixture tidak berubah (1 row, isi identik)
    const s4PostTxns = await readPosOrderTransactions(propertyId, s4OrderId);
    if (s4PostTxns.length !== s4PreTxns.length) {
      throw new Error(`S4: transaksi count berubah ${s4PreTxns.length} → ${s4PostTxns.length}`);
    }
    if (JSON.stringify(s4PreTxns) !== JSON.stringify(s4PostTxns)) {
      throw new Error(`S4: transaksi fixture berubah:\n pre=${JSON.stringify(s4PreTxns)}\n post=${JSON.stringify(s4PostTxns)}`);
    }
    pass('S4: transaksi SALE POS fixture tidak berubah');

    // 7c. Tidak ada artefak finansial/audit baru di tingkat properti
    //     (transaction count tetap 1, settlement/payment tetap 0,
    //      audit tetap 1 → tidak ada reversal/settlement/payment/audit baru)
    const s4PostTxnCount = await countPropertyTable('transactions', propertyId);
    const s4PostAudit = await countPropertyTable('audit_logs', propertyId);
    const s4PostSettle = await countPropertyTable('pos_settlements', propertyId);
    const s4PostPay = await countPropertyTable('payment_transactions', propertyId);
    if (s4PostTxnCount !== 1) {
      throw new Error(`S4: transaksi count post=${s4PostTxnCount}, expected 1 (tidak ada reversal baru)`);
    }
    if (s4PostSettle !== 0 || s4PostPay !== 0) {
      throw new Error(`S4: artefak finansial baru muncul (settlements=${s4PostSettle}, payment_transactions=${s4PostPay})`);
    }
    if (s4PostAudit !== 1) {
      throw new Error(`S4: audit_logs count post=${s4PostAudit}, expected 1 (tidak ada audit baru dari void yang ditolak)`);
    }
    pass('S4: tidak ada reversal, settlement, payment, atau audit baru');

    // ── 8. S5: VOIDED ditolak 409 meskipun artefak POS + soft-deleted ────
    // Handler Q1a tidak memfilter source_type selain {POS_ORDER, POS},
    // tidak memfilter transaction_status, dan tidak memfilter deleted_at.
    // Fixture S5: source_type='POS', transaction_status='VOIDED', deleted_at terisi.

    const s5SetupClient = await pool.connect();
    let s5OrderId;
    let s5TxnId;
    try {
      const s5Order = await createFixturePosOrder(s5SetupClient, propertyId);
      s5OrderId = s5Order.orderId;
      s5TxnId = await createPosSaleTransactionFixture(s5SetupClient, propertyId, s5OrderId, 37500, {
        source_type: 'POS',
        transaction_status: 'VOIDED',
        payment_status: 'PAID',
        payment_method: 'CASH',
        deleted_at: null,
        deleted_at_now: true,
        delete_reason: null,
      });
      pass('S5: fixture — OPEN order + transaksi POS (VOIDED, soft-deleted) dibuat');
    } catch (s5SetupErr) {
      fail('S5 fixture setup gagal', s5SetupErr);
      process.exitCode = 1;
      throw s5SetupErr;
    } finally {
      try { s5SetupClient.release(); }
      catch (relErr) { fail('S5 setupClient.release gagal', relErr); if (process.exitCode !== 1) process.exitCode = 1; }
    }

    // 8a. Pre-snapshot: order row + transaksi berdasarkan ID
    const s5PreRow = await readOrderFromDb(propertyId, s5OrderId);
    if (!s5PreRow) throw new Error(`S5: order ${s5OrderId} not found in DB (pre)`);
    const s5PreUpdatedAt = s5PreRow.updated_at;
    const s5PreTxn = await readTransactionById(s5TxnId);
    if (!s5PreTxn) throw new Error(`S5: transaksi ${s5TxnId} tidak ditemukan (pre)`);
    if (s5PreTxn.deleted_at === null) {
      throw new Error('S5: fixture S5 harus memiliki deleted_at terisi (soft-deleted)');
    }
    pass('S5: pre-snapshot order + transaksi (deleted_at terisi)');

    // 8b. Baseline artefak: setelah S4 (1 txn), S5 menambah 1 lagi → 2.
    //     audit tetap 1 (S1 VOID), settlement/payment tetap 0.
    const s5PreTxnCount = await countPropertyTable('transactions', propertyId);
    const s5PreAudit = await countPropertyTable('audit_logs', propertyId);
    const s5PreSettle = await countPropertyTable('pos_settlements', propertyId);
    const s5PrePay = await countPropertyTable('payment_transactions', propertyId);
    if (s5PreTxnCount !== 2) {
      throw new Error(`S5: pre-check transaksi count=${s5PreTxnCount}, expected 2 (S4 + S5 fixture)`);
    }
    if (s5PreAudit !== 1) {
      throw new Error(`S5: pre-check audit_logs count=${s5PreAudit}, expected 1 (S1 VOID)`);
    }

    // 8c. PATCH VOIDED → harus 409
    const s5Res = await fetch(`${baseUrl}/api/pos/orders/${s5OrderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'VOIDED', property_id: propertyId }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const s5Body = await s5Res.json();
    if (s5Res.status !== 409) {
      throw new Error(`S5: HTTP ${s5Res.status} ≠ 409, body=${JSON.stringify(s5Body)}`);
    }
    if (s5Body.code !== 'POS_ORDER_FINANCIAL_ARTIFACTS_PRESENT') {
      throw new Error(`S5: code=${JSON.stringify(s5Body.code)}, expected POS_ORDER_FINANCIAL_ARTIFACTS_PRESENT`);
    }
    if (s5Body.status !== 'ERROR') {
      throw new Error(`S5: status field=${JSON.stringify(s5Body.status)}, expected ERROR`);
    }
    pass('S5: PATCH VOIDED → 409 POS_ORDER_FINANCIAL_ARTIFACTS_PRESENT');

    // 8d. Post: order & transaksi identik
    const s5PostRow = await readOrderFromDb(propertyId, s5OrderId);
    if (!s5PostRow) throw new Error('S5: order not found in DB (post)');
    if (s5PostRow.status !== s5PreRow.status) {
      throw new Error(`S5: order status changed ${s5PreRow.status} → ${s5PostRow.status}`);
    }
    if (s5PostRow.updated_at !== s5PreUpdatedAt) {
      throw new Error(`S5: order updated_at changed (${s5PreUpdatedAt} → ${s5PostRow.updated_at})`);
    }
    if (JSON.stringify(s5PreRow) !== JSON.stringify(s5PostRow)) {
      throw new Error(`S5: order row mutated:\n pre=${JSON.stringify(s5PreRow)}\n post=${JSON.stringify(s5PostRow)}`);
    }
    const s5PostTxn = await readTransactionById(s5TxnId);
    if (!s5PostTxn) throw new Error(`S5: transaksi ${s5TxnId} hilang (post)`);
    if (JSON.stringify(s5PreTxn) !== JSON.stringify(s5PostTxn)) {
      throw new Error(`S5: transaksi fixture berubah:\n pre=${JSON.stringify(s5PreTxn)}\n post=${JSON.stringify(s5PostTxn)}`);
    }
    pass('S5: order & transaksi (ID-based) identik sebelum/sesudah');

    // 8e. Post: artefak finansial & audit tidak bertambah
    const s5PostTxnCount = await countPropertyTable('transactions', propertyId);
    const s5PostAudit = await countPropertyTable('audit_logs', propertyId);
    const s5PostSettle = await countPropertyTable('pos_settlements', propertyId);
    const s5PostPay = await countPropertyTable('payment_transactions', propertyId);
    if (s5PostTxnCount !== 2) {
      throw new Error(`S5: transaksi count post=${s5PostTxnCount}, expected 2 (S4 + S5, tidak ada baru)`);
    }
    if (s5PostSettle !== 0 || s5PostPay !== 0) {
      throw new Error(`S5: artefak finansial baru muncul (settlements=${s5PostSettle}, payment_transactions=${s5PostPay})`);
    }
    if (s5PostAudit !== 1) {
      throw new Error(`S5: audit_logs count post=${s5PostAudit}, expected 1 (tidak ada audit baru)`);
    }
    pass('S5: jumlah artefak finansial & audit tidak bertambah');

    // ── 9. S6: VOIDED ditolak 409 bila order memiliki settlement ─────────
    // Fixture: order OPEN + transaksi SALE POS + pos_settlements terkait.
    // Handler Q2 mendeteksi pos_settlements → 409. Karena SALE juga ada,
    // skenario ini membuktikan order dengan settlement tidak dapat di-void;
    // cabang query settlement (Q2) tidak diisolasi secara tersendiri.

    const s6SetupClient = await pool.connect();
    let s6OrderId;
    let s6TxnId;
    let s6SettleId;
    try {
      const s6Order = await createFixturePosOrder(s6SetupClient, propertyId);
      s6OrderId = s6Order.orderId;
      s6TxnId = await createPosSaleTransactionFixture(s6SetupClient, propertyId, s6OrderId, 45000);
      s6SettleId = await createPosSettlementFixture(s6SetupClient, propertyId, s6OrderId, s6TxnId, 45000);
      pass('S6: fixture — OPEN order + transaksi SALE + settlement dibuat');
    } catch (s6SetupErr) {
      fail('S6 fixture setup gagal', s6SetupErr);
      process.exitCode = 1;
      throw s6SetupErr;
    } finally {
      try { s6SetupClient.release(); }
      catch (relErr) { fail('S6 setupClient.release gagal', relErr); if (process.exitCode !== 1) process.exitCode = 1; }
    }

    // 9a. Pre-snapshot: order + transaksi (by ID) + settlement (by ID)
    const s6PreRow = await readOrderFromDb(propertyId, s6OrderId);
    if (!s6PreRow) throw new Error(`S6: order ${s6OrderId} not found in DB (pre)`);
    const s6PreUpdatedAt = s6PreRow.updated_at;
    const s6PreTxn = await readTransactionById(s6TxnId);
    if (!s6PreTxn) throw new Error(`S6: transaksi ${s6TxnId} tidak ditemukan (pre)`);
    const s6PreSettle = await readSettlementById(s6SettleId);
    if (!s6PreSettle) throw new Error(`S6: settlement ${s6SettleId} tidak ditemukan (pre)`);
    pass('S6: pre-snapshot order + transaksi + settlement (by ID)');

    // 9b. Baseline artefak: S4(1) + S5(1) + S6(1) → transaksi = 3,
    //     settlement = 1, audit = 1, payment = 0.
    const s6PreTxnCount = await countPropertyTable('transactions', propertyId);
    const s6PreSettleCount = await countPropertyTable('pos_settlements', propertyId);
    const s6PreAudit = await countPropertyTable('audit_logs', propertyId);
    const s6PrePay = await countPropertyTable('payment_transactions', propertyId);
    if (s6PreTxnCount !== 3) {
      throw new Error(`S6: pre-check transaksi count=${s6PreTxnCount}, expected 3 (S4+S5+S6)`);
    }
    if (s6PreSettleCount !== 1) {
      throw new Error(`S6: pre-check settlement count=${s6PreSettleCount}, expected 1 (S6)`);
    }
    if (s6PreAudit !== 1) {
      throw new Error(`S6: pre-check audit_logs count=${s6PreAudit}, expected 1 (S1 VOID)`);
    }
    if (s6PrePay !== 0) {
      throw new Error(`S6: pre-check payment_transactions count=${s6PrePay}, expected 0`);
    }

    // 9c. PATCH VOIDED → 409
    const s6Res = await fetch(`${baseUrl}/api/pos/orders/${s6OrderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'VOIDED', property_id: propertyId }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const s6Body = await s6Res.json();
    if (s6Res.status !== 409) {
      throw new Error(`S6: HTTP ${s6Res.status} ≠ 409, body=${JSON.stringify(s6Body)}`);
    }
    if (s6Body.code !== 'POS_ORDER_FINANCIAL_ARTIFACTS_PRESENT') {
      throw new Error(`S6: code=${JSON.stringify(s6Body.code)}, expected POS_ORDER_FINANCIAL_ARTIFACTS_PRESENT`);
    }
    if (s6Body.status !== 'ERROR') {
      throw new Error(`S6: status field=${JSON.stringify(s6Body.status)}, expected ERROR`);
    }
    pass('S6: PATCH VOIDED �� 409 POS_ORDER_FINANCIAL_ARTIFACTS_PRESENT');

    // 9d. Post: order, transaksi, settlement tetap identik (by ID)
    const s6PostRow = await readOrderFromDb(propertyId, s6OrderId);
    if (!s6PostRow) throw new Error('S6: order not found in DB (post)');
    if (s6PostRow.status !== s6PreRow.status) {
      throw new Error(`S6: order status changed ${s6PreRow.status} → ${s6PostRow.status}`);
    }
    if (s6PostRow.updated_at !== s6PreUpdatedAt) {
      throw new Error(`S6: order updated_at changed (${s6PreUpdatedAt} → ${s6PostRow.updated_at})`);
    }
    if (JSON.stringify(s6PreRow) !== JSON.stringify(s6PostRow)) {
      throw new Error(`S6: order row mutated:\n pre=${JSON.stringify(s6PreRow)}\n post=${JSON.stringify(s6PostRow)}`);
    }
    const s6PostTxn = await readTransactionById(s6TxnId);
    if (!s6PostTxn) throw new Error(`S6: transaksi ${s6TxnId} hilang (post)`);
    if (JSON.stringify(s6PreTxn) !== JSON.stringify(s6PostTxn)) {
      throw new Error(`S6: transaksi fixture berubah:\n pre=${JSON.stringify(s6PreTxn)}\n post=${JSON.stringify(s6PostTxn)}`);
    }
    const s6PostSettle = await readSettlementById(s6SettleId);
    if (!s6PostSettle) throw new Error(`S6: settlement ${s6SettleId} hilang (post)`);
    if (JSON.stringify(s6PreSettle) !== JSON.stringify(s6PostSettle)) {
      throw new Error(`S6: settlement fixture berubah:\n pre=${JSON.stringify(s6PreSettle)}\n post=${JSON.stringify(s6PostSettle)}`);
    }
    pass('S6: order, transaksi & settlement identik sebelum/sesudah (by ID)');

    // 9e. Post: tidak ada artefak finansial/audit baru
    const s6PostTxnCount = await countPropertyTable('transactions', propertyId);
    const s6PostSettleCount = await countPropertyTable('pos_settlements', propertyId);
    const s6PostAudit = await countPropertyTable('audit_logs', propertyId);
    const s6PostPay = await countPropertyTable('payment_transactions', propertyId);
    if (s6PostTxnCount !== 3) {
      throw new Error(`S6: transaksi count post=${s6PostTxnCount}, expected 3 (tidak ada reversal)`);
    }
    if (s6PostSettleCount !== 1) {
      throw new Error(`S6: settlement count post=${s6PostSettleCount}, expected 1 (tidak ada settlement baru)`);
    }
    if (s6PostPay !== 0) {
      throw new Error(`S6: payment_transactions count post=${s6PostPay}, expected 0`);
    }
    if (s6PostAudit !== 1) {
      throw new Error(`S6: audit_logs count post=${s6PostAudit}, expected 1 (tidak ada audit baru)`);
    }
    pass('S6: tidak ada reversal, pembayaran, settlement, atau audit baru');

    // ── 10. S7: void-vs-pay concurrency — CASH holds lock, void blocks,
    //     pay wins → order PAID + SALE + settlement; void → 409 ─────────
    //
    // S7 uses a DEDICATED property + order so S1–S6 baselines are untouched.
    //
    // Wiring:
    //   - payPosOrderCash (blocker) holds pos_orders FOR UPDATE via barrier.
    //   - void handler (waiter) issues SELECT … FOR UPDATE → blocks on pay.
    //   - observeBlocking proves pay blocks void (both PIDs captured).
    //   - After barrier release, pay commits: order → PAID, 1 SALE txn,
    //     1 settlement SUCCESS, 1 SETTLEMENT_CASH audit.
    //   - Void then unblocks, re-reads order, finds SALE via Q1a → 409.
    //
    // No menu/items needed: payPosOrderCash → projectPosOrderToTransaction
    // only reads pos_orders (live row), not pos_order_items or pos_menu_items.

    // 10a. Dedicated property fixture for S7 (isolated from S1–S6 property)
    const s7SetupClient = await pool.connect();
    let s7PropertyId;
    let s7OrderId;
    let s7OrderIdempotencyKey;
    try {
      const s7Prop = await createFixtureProperty(s7SetupClient);
      s7PropertyId = s7Prop.propertyId;
      const s7Order = await createFixturePosOrder(s7SetupClient, s7PropertyId);
      s7OrderId = s7Order.orderId;
      s7OrderIdempotencyKey = `S7-IDEM-${crypto.randomUUID()}`;
      // Track the S7 property for transaction_daily_sequences cleanup
      tracked.transactionDailySequences.push(s7PropertyId);
      pass('S7: fixture — dedicated property + OPEN order created');
    } catch (s7SetupErr) {
      fail('S7 fixture setup gagal', s7SetupErr);
      process.exitCode = 1;
      throw s7SetupErr; // → caught by outer catch('Main') → cleanup still runs
    } finally {
      try { s7SetupClient.release(); }
      catch (relErr) { fail('S7 setupClient.release gagal', relErr); if (process.exitCode !== 1) process.exitCode = 1; }
    }

    // 10b. Pre-snapshot: order OPEN, no financial artifacts on S7 property
    const s7PreRow = await readOrderFromDb(s7PropertyId, s7OrderId);
    if (!s7PreRow) throw new Error(`S7: order ${s7OrderId} not found in DB (pre)`);
    if (s7PreRow.status !== 'OPEN') {
      throw new Error(`S7: order status pre=${s7PreRow.status}, expected OPEN`);
    }
    const s7PreTxn = await countPropertyTable('transactions', s7PropertyId);
    const s7PreSettle = await countPropertyTable('pos_settlements', s7PropertyId);
    const s7PrePay = await countPropertyTable('payment_transactions', s7PropertyId);
    const s7PreAudit = await countPropertyTable('audit_logs', s7PropertyId);
    if (s7PreTxn !== 0) throw new Error(`S7: pre-check transaksi count=${s7PreTxn}, expected 0`);
    if (s7PreSettle !== 0) throw new Error(`S7: pre-check settlement count=${s7PreSettle}, expected 0`);
    if (s7PrePay !== 0) throw new Error(`S7: pre-check payment_transactions count=${s7PrePay}, expected 0`);
    if (s7PreAudit !== 0) throw new Error(`S7: pre-check audit_logs count=${s7PreAudit}, expected 0`);
    pass('S7: pre-snapshot — order OPEN, 0 financial artifacts on dedicated property');

    // 10c. Run the concurrency trial + all assertions, wrapped in try/finally
    // so artifact collection ALWAYS runs after the orchestrator completes,
    // even when the orchestrator throws or assertions fail.
    try {
      const s7Result = await runVoidVsPayConcurrency({
        propertyId: s7PropertyId,
        orderId: s7OrderId,
        idempotencyKey: s7OrderIdempotencyKey,
        actorName: actor.full_name,
        actorUserId: String(actor.id),
      });

      // 10d. Assert blocking was observed
      if (s7Result.observed !== true) {
        throw new Error(`S7: observed=${s7Result.observed}, expected true`);
      }
      if (typeof s7Result.blockerPid !== 'number' || s7Result.blockerPid <= 0) {
        throw new Error(`S7: blockerPid=${s7Result.blockerPid}, expected positive integer`);
      }
      if (typeof s7Result.waiterPid !== 'number' || s7Result.waiterPid <= 0) {
        throw new Error(`S7: waiterPid=${s7Result.waiterPid}, expected positive integer`);
      }
      console.log(`  S7 PIDs: blocker (pay) = ${s7Result.blockerPid}, waiter (void) = ${s7Result.waiterPid}`);
      pass('S7: blocking observed — pay PID blocks void PID');

      // 10e. Assert pay success (business outcome, not promise rejection)
      if (s7Result.payError !== null) {
        throw new Error(`S7: payError=${s7Result.payError?.message || s7Result.payError}, expected null`);
      }
      if (s7Result.payResult === null) {
        throw new Error('S7: payResult is null, expected a successful settlement result');
      }
      const s7PaySettlement = s7Result.payResult.settlement;
      const s7PaySale = s7Result.payResult.sale;
      if (!s7PaySettlement || typeof s7PaySettlement.id !== 'number') {
        throw new Error(`S7: payResult.settlement missing or invalid: ${JSON.stringify(s7PaySettlement)}`);
      }
      if (!s7PaySale || typeof s7PaySale.id !== 'string') {
        throw new Error(`S7: payResult.sale.id missing or not a string: ${JSON.stringify(s7PaySale)}`);
      }
      if (s7PaySettlement.status !== 'SUCCESS') {
        throw new Error(`S7: settlement.status=${s7PaySettlement.status}, expected SUCCESS`);
      }
      if (s7PaySettlement.payment_method !== 'CASH') {
        throw new Error(`S7: settlement.payment_method=${s7PaySettlement.payment_method}, expected CASH`);
      }
      if (s7PaySettlement.property_id !== s7PropertyId) {
        throw new Error(`S7: settlement.property_id=${s7PaySettlement.property_id}, expected ${s7PropertyId}`);
      }
      if (s7PaySettlement.pos_order_id !== s7OrderId) {
        throw new Error(`S7: settlement.pos_order_id=${s7PaySettlement.pos_order_id}, expected ${s7OrderId}`);
      }
      const s7OrderTotal = 25000;
      if (Number(s7PaySettlement.amount) !== s7OrderTotal) {
        throw new Error(`S7: settlement.amount=${s7PaySettlement.amount}, expected ${s7OrderTotal}`);
      }
      if (s7PaySale.source_type !== 'POS_ORDER') {
        throw new Error(`S7: sale.source_type=${s7PaySale.source_type}, expected POS_ORDER`);
      }
      if (s7PaySale.source_id !== String(s7OrderId)) {
        throw new Error(`S7: sale.source_id=${s7PaySale.source_id}, expected ${String(s7OrderId)}`);
      }
      if (s7PaySale.payment_status !== 'PAID') {
        throw new Error(`S7: sale.payment_status=${s7PaySale.payment_status}, expected PAID`);
      }
      if (s7PaySale.payment_method !== 'CASH') {
        throw new Error(`S7: sale.payment_method=${s7PaySale.payment_method}, expected CASH`);
      }
      pass('S7: payResult — settlement SUCCESS CASH, amount & linkage correct');

      // 10f. Assert void was rejected with 409 (business error, not promise rejection)
      if (s7Result.voidError !== null) {
        throw new Error(`S7: voidError=${s7Result.voidError?.message || s7Result.voidError}, expected null`);
      }
      if (s7Result.voidResponse === null) {
        throw new Error('S7: voidResponse is null, expected a captured response');
      }
      if (s7Result.voidResponse.code !== 409) {
        throw new Error(`S7: voidResponse.code=${s7Result.voidResponse.code}, expected 409`);
      }
      if (s7Result.voidResponse.body?.code !== 'POS_ORDER_FINANCIAL_ARTIFACTS_PRESENT') {
        throw new Error(`S7: voidResponse.body.code=${s7Result.voidResponse.body?.code}, expected POS_ORDER_FINANCIAL_ARTIFACTS_PRESENT`);
      }
      pass('S7: void rejected 409 POS_ORDER_FINANCIAL_ARTIFACTS_PRESENT');

      // 10g. Post: order is PAID
      const s7PostRow = await readOrderFromDb(s7PropertyId, s7OrderId);
      if (!s7PostRow) throw new Error('S7: order not found in DB (post)');
      if (s7PostRow.status !== 'PAID') {
        throw new Error(`S7: order status post=${s7PostRow.status}, expected PAID`);
      }
      pass('S7: order PAID after pay commit');

      // 10h. Post: exactly 1 SALE transaction + 1 settlement SUCCESS
      const s7PostTxnCount = await countPropertyTable('transactions', s7PropertyId);
      if (s7PostTxnCount !== 1) {
        throw new Error(`S7: transaksi count post=${s7PostTxnCount}, expected 1 (no reversal)`);
      }
      const s7PostSettleCount = await countPropertyTable('pos_settlements', s7PropertyId);
      if (s7PostSettleCount !== 1) {
        throw new Error(`S7: settlement count post=${s7PostSettleCount}, expected 1`);
      }
      const s7SettleRow = await readSettlementByOrder(s7PropertyId, s7OrderId);
      if (!s7SettleRow) throw new Error('S7: no settlement found in DB post');
      if (s7SettleRow.status !== 'SUCCESS') {
        throw new Error(`S7: settlement.status=${s7SettleRow.status}, expected SUCCESS`);
      }
      if (Number(s7SettleRow.amount) !== s7OrderTotal) {
        throw new Error(`S7: settlement.amount=${s7SettleRow.amount}, expected ${s7OrderTotal}`);
      }
      if (s7SettleRow.transaction_id !== String(s7PaySettlement.transaction_id)) {
        throw new Error(`S7: settlement.transaction_id=${s7SettleRow.transaction_id}, expected ${s7PaySettlement.transaction_id}`);
      }
      if (s7SettleRow.property_id !== s7PropertyId) {
        throw new Error(`S7: settlement.property_id=${s7SettleRow.property_id}, expected ${s7PropertyId}`);
      }
      pass('S7: post — 1 SALE txn + 1 settlement SUCCESS, linkage correct');

      // 10i. Post: no reversal transactions, no payment_transactions
      const s7PostPayCount = await countPropertyTable('payment_transactions', s7PropertyId);
      if (s7PostPayCount !== 0) {
        throw new Error(`S7: payment_transactions count post=${s7PostPayCount}, expected 0`);
      }
      const revCheck = await pool.query(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE property_id = $1 AND reversal_of_transaction_id IS NOT NULL`,
        [s7PropertyId]
      );
      if (Number(revCheck.rows[0].n) > 0) {
        throw new Error(`S7: ${Number(revCheck.rows[0].n)} reversal transaction(s) found, expected 0`);
      }
      pass('S7: no reversal, no payment_transactions');

      // 10j. Post: no VOID audit; exactly 1 SETTLEMENT_CASH audit
      const s7PostAuditCount = await countPropertyTable('audit_logs', s7PropertyId);
      if (s7PostAuditCount !== 1) {
        throw new Error(`S7: audit_logs count post=${s7PostAuditCount}, expected 1 (SETTLEMENT_CASH only)`);
      }
      // Use the settlement ID from the DB read in 10h (s7SettleRow.id),
      // not the order ID — record_id in audit_logs is the settlement id.
      const s7SettleAudit = await readSettlementAudit(s7PropertyId, s7SettleRow.id);
      if (!s7SettleAudit) {
        throw new Error('S7: no SETTLEMENT_CASH audit found for settlement #'+s7SettleRow.id);
      }
      if (s7SettleAudit.action !== 'SETTLEMENT_CASH') {
        throw new Error(`S7: audit.action=${s7SettleAudit.action}, expected SETTLEMENT_CASH`);
      }
      // Validate the audit payload fields
      const s7AuditPayload = s7SettleAudit.payload;
      if (!s7AuditPayload || typeof s7AuditPayload !== 'object') {
        throw new Error('S7: audit payload is null or not an object');
      }
      if (s7AuditPayload.property_id !== s7PropertyId) {
        throw new Error(`S7: audit payload.property_id=${s7AuditPayload.property_id}, expected ${s7PropertyId}`);
      }
      if (s7AuditPayload.pos_order_id !== s7OrderId) {
        throw new Error(`S7: audit payload.pos_order_id=${s7AuditPayload.pos_order_id}, expected ${s7OrderId}`);
      }
      // transaction_id in the audit payload must match the settlement row
      // (both reference the same SALE transaction). Guard non-null first.
      if (s7AuditPayload.transaction_id === undefined || s7AuditPayload.transaction_id === null) {
        throw new Error('S7: audit payload.transaction_id missing');
      }
      if (String(s7AuditPayload.transaction_id) !== String(s7SettleRow.transaction_id)) {
        throw new Error(
          `S7: audit payload.transaction_id=${s7AuditPayload.transaction_id}, `
          + `settlement.transaction_id=${s7SettleRow.transaction_id} — mismatch`
        );
      }
      if (Number(s7AuditPayload.amount) !== 25000) {
        throw new Error(`S7: audit payload.amount=${s7AuditPayload.amount}, expected 25000`);
      }
      if (s7AuditPayload.payment_method !== 'CASH') {
        throw new Error(`S7: audit payload.payment_method=${s7AuditPayload.payment_method}, expected CASH`);
      }
      if (s7AuditPayload.status !== 'SUCCESS') {
        throw new Error(`S7: audit payload.status=${s7AuditPayload.status}, expected SUCCESS`);
      }
      // actor_user_id on the audit row must match the test actor
      const s7ExpectedActorId = String(actor.id);
      if (String(s7SettleAudit.actor_user_id) !== s7ExpectedActorId) {
        throw new Error(`S7: audit actor_user_id=${s7SettleAudit.actor_user_id}, expected ${s7ExpectedActorId}`);
      }
      const voidAuditCheck = await pool.query(
        `SELECT COUNT(*) AS n FROM audit_logs
         WHERE property_id = $1 AND action = 'VOID'`,
        [s7PropertyId]
      );
      if (Number(voidAuditCheck.rows[0].n) > 0) {
        throw new Error(`S7: ${Number(voidAuditCheck.rows[0].n)} VOID audit(s) found, expected 0`);
      }
      pass('S7: audit — exactly 1 SETTLEMENT_CASH, payload validated, 0 VOID');

    } finally {
      // ── 10k. Collect + track service-created artifacts (always runs) ─
      // The orchestrator's finally already settled all promises; artifacts
      // are now in the DB.  Empty result is NOT an error (service may have
      // failed before creating any).  Collection errors → FAIL + nonzero.
      try {
        await collectServiceArtifacts(s7PropertyId);
        pass('S7: service artifacts collected & tracked for cleanup');
      } catch (collectErr) {
        fail('S7: collectServiceArtifacts gagal', collectErr);
        if (process.exitCode !== 1) process.exitCode = 1;
      }
    }

    // ── 12. S8: void-vs-pay concurrency REVERSE — void holds lock,
    //     CASH blocks → void wins (order VOIDED); CASH rejected 409
    //     ORDER_NOT_PAYABLE ─────────────────────────────────────────────────
    //
    // S8 uses a DEDICATED property + order so S1–S7 baselines are untouched.
    //
    // Wiring (reverse of S7):
    //   - void handler (blocker) holds pos_orders FOR UPDATE via barrier.
    //   - payPosOrderCash (waiter) issues SELECT … FOR UPDATE → blocks on void.
    //   - observeBlocking proves void blocks pay (pg_blocking_pids(payPid)
    //     contains voidPid).
    //   - After barrier release, void commits: order → VOIDED, 1 VOID audit.
    //   - CASH then unblocks, re-reads order, finds VOIDED → 409
    //     ORDER_NOT_PAYABLE (PosSettlementError from posSettlementService).
    //
    // No menu/items needed: payPosOrderCash → projectPosOrderToTransaction
    // only reads pos_orders (live row), not pos_order_items or pos_menu_items.

    // 12a. Dedicated property fixture for S8 (isolated from S1–S7 properties)
    let s8PropertyId;
    let s8OrderId;
    let s8IdempotencyKey;
    const s8SetupClient = await pool.connect();
    try {
      const s8Prop = await createFixtureProperty(s8SetupClient);
      s8PropertyId = s8Prop.propertyId;
      const s8Order = await createFixturePosOrder(s8SetupClient, s8PropertyId);
      s8OrderId = s8Order.orderId;
      s8IdempotencyKey = `S8-IDEM-${crypto.randomUUID()}`;
      // Track the S8 property for transaction_daily_sequences cleanup
      tracked.transactionDailySequences.push(s8PropertyId);
      pass('S8: fixture — dedicated property + OPEN order created');
    } catch (s8SetupErr) {
      fail('S8 fixture setup gagal', s8SetupErr);
      process.exitCode = 1;
      throw s8SetupErr; // → caught by outer catch('Main') → cleanup still runs
    } finally {
      try { s8SetupClient.release(); }
      catch (relErr) { fail('S8 setupClient.release gagal', relErr); if (process.exitCode !== 1) process.exitCode = 1; }
    }

    // 12b. Pre-snapshot: order OPEN, no financial artifacts on S8 property
    const s8PreRow = await readOrderFromDb(s8PropertyId, s8OrderId);
    if (!s8PreRow) throw new Error(`S8: order ${s8OrderId} not found in DB (pre)`);
    if (s8PreRow.status !== 'OPEN') {
      throw new Error(`S8: order status pre=${s8PreRow.status}, expected OPEN`);
    }
    const s8PreTxn = await countPropertyTable('transactions', s8PropertyId);
    const s8PreSettle = await countPropertyTable('pos_settlements', s8PropertyId);
    const s8PrePay = await countPropertyTable('payment_transactions', s8PropertyId);
    const s8PreAudit = await countPropertyTable('audit_logs', s8PropertyId);
    if (s8PreTxn !== 0) throw new Error(`S8: pre-check transaksi count=${s8PreTxn}, expected 0`);
    if (s8PreSettle !== 0) throw new Error(`S8: pre-check settlement count=${s8PreSettle}, expected 0`);
    if (s8PrePay !== 0) throw new Error(`S8: pre-check payment_transactions count=${s8PrePay}, expected 0`);
    if (s8PreAudit !== 0) throw new Error(`S8: pre-check audit_logs count=${s8PreAudit}, expected 0`);
    pass('S8: pre-snapshot — order OPEN, 0 financial artifacts on dedicated property');

    // 12c. Run the reverse concurrency trial + all assertions, wrapped in
    // try/finally so artifact collection ALWAYS runs after the orchestrator
    // completes, even when the orchestrator throws or assertions fail.
    try {
      const s8Result = await runVoidVsPayConcurrencyS8({
        propertyId: s8PropertyId,
        orderId: s8OrderId,
        idempotencyKey: s8IdempotencyKey,
        actorName: actor.full_name,
        actorUserId: String(actor.id),
      });

      // 12d. Assert blocking was observed
      if (s8Result.observed !== true) {
        throw new Error(`S8: observed=${s8Result.observed}, expected true`);
      }
      if (typeof s8Result.blockerPid !== 'number' || s8Result.blockerPid <= 0) {
        throw new Error(`S8: blockerPid=${s8Result.blockerPid}, expected positive integer`);
      }
      if (typeof s8Result.waiterPid !== 'number' || s8Result.waiterPid <= 0) {
        throw new Error(`S8: waiterPid=${s8Result.waiterPid}, expected positive integer`);
      }
      console.log(`  S8 PIDs: blocker (void) = ${s8Result.blockerPid}, waiter (pay) = ${s8Result.waiterPid}`);
      pass('S8: blocking observed — void PID blocks pay PID');

      // 12e. Assert void SUCCESS (200, replayed=false)
      if (s8Result.voidError !== null) {
        throw new Error(`S8: voidError=${s8Result.voidError?.message || s8Result.voidError}, expected null`);
      }
      if (s8Result.voidResponse === null) {
        throw new Error('S8: voidResponse is null, expected a captured response');
      }
      if (s8Result.voidResponse.code !== 200) {
        throw new Error(`S8: voidResponse.code=${s8Result.voidResponse.code}, expected 200`);
      }
      if (s8Result.voidResponse.body?.status !== 'SUCCESS') {
        throw new Error(`S8: voidResponse.body.status=${JSON.stringify(s8Result.voidResponse.body?.status)}, expected SUCCESS`);
      }
      if (s8Result.voidResponse.body?.replayed !== false) {
        throw new Error(`S8: voidResponse.body.replayed=${JSON.stringify(s8Result.voidResponse.body?.replayed)}, expected false`);
      }
      pass('S8: void → 200 SUCCESS, replayed=false');

      // 12f. Assert CASH rejected with PosSettlementError (409 ORDER_NOT_PAYABLE)
      // Source: posSettlementService line 472–478 — when orderStatus !== 'OPEN',
      // throws PosSettlementError(409, 'ORDER_NOT_PAYABLE', …)
      if (s8Result.payResult !== null) {
        throw new Error('S8: payResult is not null, expected CASH to be rejected for VOIDED order');
      }
      if (s8Result.payError === null) {
        throw new Error('S8: payError is null, expected PosSettlementError for VOIDED order');
      }
      const s8PayErr = s8Result.payError;
      const s8PayStatusCode = s8PayErr.statusCode;
      const s8PayCode = s8PayErr.code;
      if (s8PayStatusCode !== 409) {
        throw new Error(`S8: payError.statusCode=${s8PayStatusCode}, expected 409`);
      }
      if (s8PayCode !== 'ORDER_NOT_PAYABLE') {
        throw new Error(`S8: payError.code=${JSON.stringify(s8PayCode)}, expected ORDER_NOT_PAYABLE`);
      }
      if (!(s8PayErr instanceof PosSettlementError)) {
        throw new Error(`S8: payError is ${s8PayErr.constructor?.name}, expected PosSettlementError`);
      }
      pass(`S8: CASH rejected — statusCode=${s8PayStatusCode}, code=${s8PayCode}`);

      // 12g. Post: order is VOIDED
      const s8PostRow = await readOrderFromDb(s8PropertyId, s8OrderId);
      if (!s8PostRow) throw new Error('S8: order not found in DB (post)');
      if (s8PostRow.status !== 'VOIDED') {
        throw new Error(`S8: order status post=${s8PostRow.status}, expected VOIDED`);
      }
      pass('S8: order VOIDED after void commit');

      // 12h. Post: transactions, settlements, payment_transactions all 0
      const s8PostTxnCount = await countPropertyTable('transactions', s8PropertyId);
      const s8PostSettleCount = await countPropertyTable('pos_settlements', s8PropertyId);
      const s8PostPayCount = await countPropertyTable('payment_transactions', s8PropertyId);
      if (s8PostTxnCount !== 0 || s8PostSettleCount !== 0 || s8PostPayCount !== 0) {
        throw new Error(
          `S8: unexpected financial artifacts `
          + `(transactions=${s8PostTxnCount}, pos_settlements=${s8PostSettleCount}, payment_transactions=${s8PostPayCount})`
        );
      }
      pass('S8: transactions, settlements, payment_transactions all 0');

      // 12i. Post: exactly 1 VOID audit; 0 SETTLEMENT_CASH audits
      const s8PostAuditCount = await countPropertyTable('audit_logs', s8PropertyId);
      if (s8PostAuditCount !== 1) {
        throw new Error(`S8: audit_logs count post=${s8PostAuditCount}, expected 1 (VOID only)`);
      }
      const s8VoidAudit = await readVoidAudit(s8PropertyId, s8OrderId);
      if (!s8VoidAudit) {
        throw new Error(`S8: no VOID audit found for order ${s8OrderId}`);
      }
      if (s8VoidAudit.module !== 'POS') {
        throw new Error(`S8: audit module=${s8VoidAudit.module}, expected POS`);
      }
      if (s8VoidAudit.action !== 'VOID') {
        throw new Error(`S8: audit action=${s8VoidAudit.action}, expected VOID`);
      }
      if (s8VoidAudit.entity !== 'pos_orders') {
        throw new Error(`S8: audit entity=${s8VoidAudit.entity}, expected pos_orders`);
      }
      if (String(s8VoidAudit.record_id) !== String(s8OrderId)) {
        throw new Error(`S8: audit record_id=${s8VoidAudit.record_id}, expected ${s8OrderId}`);
      }
      // Validate audit payload fields
      if (!s8VoidAudit.payload) {
        throw new Error('S8: audit payload is null');
      }
      if (s8VoidAudit.payload.previous_status !== 'OPEN') {
        throw new Error(`S8: audit payload.previous_status=${s8VoidAudit.payload.previous_status}, expected OPEN`);
      }
      if (s8VoidAudit.payload.new_status !== 'VOIDED') {
        throw new Error(`S8: audit payload.new_status=${s8VoidAudit.payload.new_status}, expected VOIDED`);
      }
      if (s8VoidAudit.payload.actor_name !== actor.full_name) {
        throw new Error(`S8: audit payload.actor_name=${JSON.stringify(s8VoidAudit.payload.actor_name)}, expected ${actor.full_name}`);
      }
      if (s8VoidAudit.payload.actor_user_id !== String(actor.id)) {
        throw new Error(`S8: audit payload.actor_user_id=${JSON.stringify(s8VoidAudit.payload.actor_user_id)}, expected ${String(actor.id)}`);
      }
      if (String(s8VoidAudit.actor_user_id) !== String(actor.id)) {
        throw new Error(`S8: audit_logs.actor_user_id=${s8VoidAudit.actor_user_id}, expected ${String(actor.id)}`);
      }
      // No SETTLEMENT_CASH audit should exist
      const s8SettleAuditCheck = await pool.query(
        `SELECT COUNT(*) AS n FROM audit_logs
         WHERE property_id = $1 AND action = 'SETTLEMENT_CASH'`,
        [s8PropertyId]
      );
      if (Number(s8SettleAuditCheck.rows[0].n) > 0) {
        throw new Error(`S8: ${Number(s8SettleAuditCheck.rows[0].n)} SETTLEMENT_CASH audit(s) found, expected 0`);
      }
      pass('S8: audit — exactly 1 VOID (correct order/property/actor), 0 SETTLEMENT_CASH');

    } finally {
      // ── 12j. Collect + track service-created artifacts (always runs) ─
      // The orchestrator's finally already settled all promises; artifacts
      // are now in the DB.  Empty result is NOT an error (CASH was rejected
      // before creating any settlement).  Collection errors → FAIL + nonzero.
      try {
        await collectServiceArtifacts(s8PropertyId);
        pass('S8: service artifacts collected & tracked for cleanup');
      } catch (collectErr) {
        fail('S8: collectServiceArtifacts gagal', collectErr);
        if (process.exitCode !== 1) process.exitCode = 1;
      }
    }

    // ── 13. S9: property scope rejection ─────────────────────────────────
    //
    // Dua properti terisolasi:
    //   propA = propertyId (S1/S2 property, actor's property)
    //   propB = dedicated S9 property (order milik propB, status OPEN)
    //
    // express server masih open; actor (middleware) memiliki property_id=propA.
    //
    // 13a. Fixture: propB + s9OrderB (OPEN, propB)
    // 13b. Pre-snapshot: s9OrderB status=OPEN, updated_at recorded;
    //     audit/financial counts = 0 on both properties
    // 13c. Case 1: PATCH s9OrderB, body property_id=propB
    //     actor has propA → assertPropertyScope(req, propB) → 403 PROPERTY_SCOPE_REQUIRED
    //     (before any DB access — scope check is before transaction)
    // 13d. Case 2: PATCH s9OrderB, body property_id=propA (matches actor)
    //     scope passes → DB: order.property_id(propB) ≠ body.property_id(propA)
    //     → 403 CROSS_PROPERTY_ORDER
    // 13e. Post-snapshot: s9OrderB unchanged (status OPEN, updated_at same)
    //     audit & financial artifacts unchanged on both properties

    let s9PropertyB;
    let s9OrderBId;

    // 13a. Create propB fixture
    const s9SetupClient = await pool.connect();
    try {
      const s9PropB = await createFixtureProperty(s9SetupClient);
      s9PropertyB = s9PropB.propertyId;
      const s9OrderB = await createFixturePosOrder(s9SetupClient, s9PropertyB);
      s9OrderBId = s9OrderB.orderId;
      pass('S9: fixture — propB + OPEN order B created');
    } catch (s9SetupErr) {
      fail('S9 fixture setup gagal', s9SetupErr);
      process.exitCode = 1;
      throw s9SetupErr;
    } finally {
      try { s9SetupClient.release(); }
      catch (relErr) { fail('S9 setupClient.release gagal', relErr); if (process.exitCode !== 1) process.exitCode = 1; }
    }

    // 13b. Pre-snapshot: order B state + financial artifact counts on both properties
    const s9PreRow = await readOrderFromDb(s9PropertyB, s9OrderBId);
    if (!s9PreRow) throw new Error(`S9: order ${s9OrderBId} not found in DB (pre)`);
    if (s9PreRow.status !== 'OPEN') {
      throw new Error(`S9: order status pre=${s9PreRow.status}, expected OPEN`);
    }
    const s9PreUpdatedAt = s9PreRow.updated_at;
    const s9PreTxnA = await countPropertyTable('transactions', propertyId);
    const s9PreSettleA = await countPropertyTable('pos_settlements', propertyId);
    const s9PreAuditA = await countPropertyTable('audit_logs', propertyId);
    const s9PreTxnB = await countPropertyTable('transactions', s9PropertyB);
    const s9PreSettleB = await countPropertyTable('pos_settlements', s9PropertyB);
    const s9PreAuditB = await countPropertyTable('audit_logs', s9PropertyB);
    pass('S9: pre-snapshot — order OPEN, financial artifacts recorded');

    // 13c. Case 1: actor has propA, body property_id=propB → 403 PROPERTY_SCOPE_REQUIRED
    // assertPropertyScope is called BEFORE the DB transaction, so no lock is
    // acquired and the order row is never touched.
    {
      const res = await fetch(
        `${baseUrl}/api/pos/orders/${s9OrderBId}/status`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'VOIDED', property_id: s9PropertyB }),
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        }
      );
      const body = await res.json().catch(() => ({}));
      if (res.status !== 403) {
        throw new Error(`S9 case1: HTTP ${res.status} ≠ 403, body=${JSON.stringify(body)}`);
      }
      if (body.code !== 'PROPERTY_SCOPE_REQUIRED') {
        throw new Error(`S9 case1: code=${JSON.stringify(body.code)}, expected PROPERTY_SCOPE_REQUIRED`);
      }
      if (body.status !== 'ERROR') {
        throw new Error(`S9 case1: status=${JSON.stringify(body.status)}, expected ERROR`);
      }
      pass('S9 case1: actor propA + body propB → 403 PROPERTY_SCOPE_REQUIRED');
    }

    // 13d. Case 2: actor has propA, body property_id=propA (scope matches),
    // but order belongs to propB → 403 CROSS_PROPERTY_ORDER (DB check)
    {
      const res = await fetch(
        `${baseUrl}/api/pos/orders/${s9OrderBId}/status`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'VOIDED', property_id: propertyId }),
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        }
      );
      const body = await res.json().catch(() => ({}));
      if (res.status !== 403) {
        throw new Error(`S9 case2: HTTP ${res.status} ≠ 403, body=${JSON.stringify(body)}`);
      }
      if (body.code !== 'CROSS_PROPERTY_ORDER') {
        throw new Error(`S9 case2: code=${JSON.stringify(body.code)}, expected CROSS_PROPERTY_ORDER`);
      }
      if (body.status !== 'ERROR') {
        throw new Error(`S9 case2: status=${JSON.stringify(body.status)}, expected ERROR`);
      }
      pass('S9 case2: actor propA + body propA + order propB → 403 CROSS_PROPERTY_ORDER');
    }

    // 13e. Post-snapshot: order B unchanged on both dimensions
    const s9PostRow = await readOrderFromDb(s9PropertyB, s9OrderBId);
    if (!s9PostRow) throw new Error('S9: order not found in DB (post)');
    if (s9PostRow.status !== 'OPEN') {
      throw new Error(`S9: order status post=${s9PostRow.status}, expected OPEN (unchanged)`);
    }
    if (s9PostRow.updated_at !== s9PreUpdatedAt) {
      throw new Error(`S9: order updated_at changed (${s9PreUpdatedAt} → ${s9PostRow.updated_at})`);
    }
    if (JSON.stringify(s9PreRow) !== JSON.stringify(s9PostRow)) {
      throw new Error(`S9: order row mutated:\n pre=${JSON.stringify(s9PreRow)}\n post=${JSON.stringify(s9PostRow)}`);
    }
    pass('S9: order B status=OPEN, updated_at unchanged after both rejections');

    // 13f. No audit or financial artifacts were created on either property
    const s9PostAuditA = await countPropertyTable('audit_logs', propertyId);
    const s9PostAuditB = await countPropertyTable('audit_logs', s9PropertyB);
    if (s9PostAuditA !== s9PreAuditA) {
      throw new Error(`S9: audit_logs propA changed (${s9PreAuditA} → ${s9PostAuditA})`);
    }
    if (s9PostAuditB !== 0) {
      throw new Error(`S9: audit_logs propB count=${s9PostAuditB}, expected 0`);
    }
    const s9PostTxnA = await countPropertyTable('transactions', propertyId);
    const s9PostTxnB = await countPropertyTable('transactions', s9PropertyB);
    if (s9PostTxnA !== s9PreTxnA) {
      throw new Error(`S9: transactions propA changed (${s9PreTxnA} → ${s9PostTxnA})`);
    }
    if (s9PostTxnB !== 0) {
      throw new Error(`S9: transactions propB count=${s9PostTxnB}, expected 0`);
    }
    const s9PostSettleA = await countPropertyTable('pos_settlements', propertyId);
    const s9PostSettleB = await countPropertyTable('pos_settlements', s9PropertyB);
    if (s9PostSettleA !== s9PreSettleA) {
      throw new Error(`S9: pos_settlements propA changed (${s9PreSettleA} → ${s9PostSettleA})`);
    }
    if (s9PostSettleB !== 0) {
      throw new Error(`S9: pos_settlements propB count=${s9PostSettleB}, expected 0`);
    }
    pass('S9: no audit or financial artifacts on either property');

    // Track propB's transaction_daily_sequences (in case any future change
    // adds a sequence row during scope rejection — currently none expected,
    // but tracking keeps cleanup FK-safe).
    tracked.transactionDailySequences.push(s9PropertyB);

    // ── 11. Tutup server SEBELUM cleanup ────────────────────────────────
    await new Promise((resolve, reject) => {
      httpServer.close((err) => err ? reject(err) : resolve());
    });
    httpServer = null;
    pass('Express server ditutup');

  } catch (err) {
    fail('Main', err);
    process.exitCode = 1;
  } finally {
    // Tutup server bila masih terbuka (mis. error terjadi sebelum close)
    if (httpServer) {
      try {
        await new Promise((resolve, reject) => {
          httpServer.close((err) => err ? reject(err) : resolve());
        });
        pass('Express server ditutup (finally)');
      } catch (closeErr) {
        fail('server.close gagal', closeErr);
        process.exitCode = 1;
      }
      httpServer = null;
    }

    // Cleanup + residue check — hanya jika identitas terverifikasi & fixture ada.
    if (identityVerified && tracked.properties.length > 0) {
      // ── Cleanup client ──
      let cleanupError = null;
      let cleanupDiscard = false;
      try {
        const cleanupClient = await pool.connect();
        let releaseDone = false;
        try {
          const result = await cleanupFixtures(cleanupClient);
          cleanupDiscard = result.discardClient;
        } catch (cleanErr) {
          cleanupError = cleanErr;
          cleanupDiscard = Boolean(cleanErr.discardClient);
        } finally {
          if (!releaseDone) {
            releaseDone = true;
            try { cleanupClient.release(cleanupDiscard); }
            catch (relErr) { fail('cleanupClient.release gagal', relErr); if (process.exitCode !== 1) process.exitCode = 1; }
          }
        }
        if (cleanupError) {
          fail('cleanupFixtures', cleanupError);
          process.exitCode = 1;
        } else {
          console.log('[CLEANUP] OK');
        }
      } catch (connectErr) {
        fail('pool.connect untuk cleanup', connectErr);
        process.exitCode = 1;
      }

      // ── Residue verification (selalu dicoba, bahkan bila cleanup gagal) ──
      try {
        const verifyClient = await pool.connect();
        let residue;
        try {
          residue = await verifyNoResidue(verifyClient);
        } finally {
          try { verifyClient.release(); }
          catch (relErr) { fail('verifyClient.release gagal', relErr); if (process.exitCode !== 1) process.exitCode = 1; }
        }
        if (residue.length > 0) {
          for (const item of residue) fail(`residu: ${item}`, new Error(item));
          process.exitCode = 1;
        } else {
          console.log('[RESIDUE] 0');
        }
      } catch (verifyErr) {
        fail('verifyNoResidue', verifyErr);
        process.exitCode = 1;
      }
    }

    // pool.end selalu dicoba; kegagalannya juga FAIL.
    try {
      await pool.end();
    } catch (endErr) {
      fail('pool.end gagal', endErr);
      if (process.exitCode !== 1) process.exitCode = 1;
    }

    if (!identityVerified) {
      console.error('SAFETY: identitas DB tidak terverifikasi sebelum pool.end.');
      process.exitCode = 1;
    }

    if (failed > 0) {
      console.log(`\n[POS-ORDER-STATUS GUARD] GAGAL: ${passed} pass, ${failed} fail.`);
      process.exitCode = 1;
    } else {
      console.log(`\n[POS-ORDER-STATUS GUARD] SEMUA LULUS: ${passed} pass, 0 fail.`);
    }
  }
})().catch((rejectionErr) => {
  // Outer catch: catat rejection yang lolos dari main/finally.
  console.error('SAFETY: unhandled rejection dari main IIFE:', rejectionErr && rejectionErr.message ? rejectionErr.message : rejectionErr);
  process.exitCode = 1;
});
