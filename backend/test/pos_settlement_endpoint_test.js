/**
 * POS CASH SETTLEMENT ENDPOINT — Test (Tahap 3: POST /api/pos/orders/:id/pay)
 *
 * Target: disposable PostgreSQL `oak_minibar_test` (host 127.0.0.1, port 15434).
 * Uji endpoint POST /api/pos/orders/:id/pay end-to-end lewat HTTP server lokal,
 * memakai app + pool dari dist/index (TANPA initialize/seed/ALTER/reset/migration).
 *
 * DB safety guard (tanpa dotenv / fallback apa pun):
 * - TEST_DATABASE_URL eksplisit: postgres://, 127.0.0.1, port 15434,
 *   database oak_minibar_test, user minibar_test, password wajib.
 * - Tanpa query parameter. Tidak mencetak password/URL.
 * - Pool diambil dari dist/index yang membaca DB_* yang diset dari URL.
 * - Verifikasi pool.options (eksak) + current_database()/current_user()
 *   SEBELUM mutasi apa pun. TIDAK memakai inet_server_port() sebagai guard
 *   port Docker (host 15434 → PG internal 5432).
 *
 * Run:
 *   TEST_DATABASE_URL=postgres://minibar_test:<PASS>@127.0.0.1:15434/oak_minibar_test \
 *   node backend/test/pos_settlement_endpoint_test.js
 */

'use strict';

// ─── 1. DB SAFETY GUARD (tanpa dotenv/fallback) ─────────────────────────────
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !testUrl.trim()) {
  console.error(
    'SAFETY: TEST_DATABASE_URL tidak di-set.\n' +
    'Jalankan: TEST_DATABASE_URL=postgres://minibar_test:<PASS>@127.0.0.1:15434/oak_minibar_test ' +
    'node backend/test/pos_settlement_endpoint_test.js'
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
    `[POS SETTLEMENT ENDPOINT TEST] Target DB: ${database} (user: ${user}, port: ${port})`
  );
} catch (e) {
  console.error('SAFETY: TEST_DATABASE_URL ditolak — ' + e.message);
  process.exit(1);
}

// ─── 2. Setel DB_* dari target tervalidasi — TANPA hardcoded credential ─────
// Ikuti pola reservations_property_scope_test.js.
process.env.DB_HOST = target.host;
process.env.DB_PORT = String(target.port);
process.env.DB_USER = target.user;
process.env.DB_PASSWORD = target.password;
process.env.DB_NAME = target.database;
// JANGAN jalankan initializeDatabase / seed permission / sweep / reconcile
// dari dist/index. Import dist/index tetap meng-create Pool (pool.connect
// bersifat lazy), sehingga aman selama RUN_SCHEMA_INITIALIZATION=false.
process.env.RUN_SCHEMA_INITIALIZATION = 'false';

// ─── 3. Import app + pool dari dist/index (pool baru terpakai saat connect) ─
const http = require('http');
const crypto = require('crypto');
const { app, pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');
const {
  setRoleAccess,
  getPermissionKeysFor,
  ACCESS_RESOURCES,
} = require('../dist/domains/settings/accessControlService');

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

// ─── Identity unik per run → anti-bentrok dengan data existing ─────────────
const RUN_ID =
  Date.now().toString(36).toUpperCase() +
  Math.random().toString(36).slice(2, 5).toUpperCase();

// ─── Tracking fixture (hanya data yang DIBUAT suite ini) ───────────────────
// Cleanup wajib berdasarkan ID, di PoolClient DEDICATED dalam SATU transaksi.
// Urutan FK-safe & asersi skenario diisi pada tahap berikutnya.
const tracked = {
  properties: [],      // INTEGER ids
  roles: [],           // INTEGER ids
  users: [],           // INTEGER ids
  menuCategories: [],  // INTEGER ids
  menuItems: [],       // INTEGER ids
  posOrders: [],       // INTEGER ids
  transactions: [],    // BIGINT ids
  posSettlements: [],  // INTEGER ids
  auditLogs: [],       // INTEGER (audit_id)
};

// Key idempotency_keys yang mungkin dibuat test (fixture/skenario) —
// dibersihkan di cleanup untuk mencapai residu 0.
const trackedIdempotencyKeys = [];

function track(table, id) {
  if (id == null) return;
  tracked[table].push(Number(id));
}

// ─── Generator property_code & order_number (unik per run, anti-duplikat) ─
// properties.property_code: VARCHAR(6) UNIQUE global, CHECK ^[A-Z0-9]{2,6}$
//   → prefix acak 3 char (sekali per run) + counter base36 (3 char, padStart)
//     = TEPEX 6 char, TANPA pemotongan counter hasil akhir.
// pos_orders (property_id, order_number): UNIQUE per property
//   → order_number berbeda per pemanggilan (counter).
const PROPERTY_CODE_PREFIX =
  crypto.randomBytes(2).toString('hex').slice(0, 3).toUpperCase();

const usedPropertyCodes = new Set();
const PROPERTY_CODE_LIMIT = 36 * 36 * 36; // 36**3
let propertyCodeCounter = 0;
let orderCounter = 0;

function nextPropertyCode() {
  if (propertyCodeCounter >= PROPERTY_CODE_LIMIT) {
    throw new Error(`nextPropertyCode: counter mencapai ${PROPERTY_CODE_LIMIT}`);
  }
  const code =
    PROPERTY_CODE_PREFIX +
    propertyCodeCounter.toString(36).toUpperCase().padStart(3, '0');
  propertyCodeCounter++;

  if (usedPropertyCodes.has(code)) {
    throw new Error(`nextPropertyCode: duplikat kode '${code}' dalam run`);
  }
  usedPropertyCodes.add(code);

  if (!/^[A-Z0-9]{6}$/.test(code)) {
    throw new Error(`nextPropertyCode: '${code}' tidak cocok /^[A-Z0-9]{6}$/`);
  }
  return code;
}

function nextOrderNumber() {
  const c = orderCounter++;
  // 'PO' + RUN_ID + '-' + counter, maks 50 char. Berbeda per pemanggilan.
  return ('PO' + RUN_ID + '-' + c).slice(0, 50);
}

// ─── Helper FIXTURE (INSERT langsung, track ID sesaat setelah INSERT) ──────

/** Buat satu properti (property_code unik). @returns {number} */
async function createFixtureProperty(client, label) {
  const code = nextPropertyCode();
  const q = await client.query(
    `INSERT INTO properties (name, property_code, timezone, currency_code, is_active)
     VALUES ($1, $2, 'Asia/Jakarta', 'IDR', TRUE) RETURNING id`,
    [`PEnd ${label} ${RUN_ID}`, code]
  );
  const id = Number(q.rows[0].id);
  track('properties', id);
  return id;
}

/**
 * Buat role property + grant permission dari mapping aktif (resource →
 * action → key yang sudah ada di tabel `permissions`). Grid dimulai
 * DEFAULT-DENY di seluruh resource; sel yang diminta di-set TRUE.
 * @returns {number} role id
 */
async function createRoleWithPosAccess(client, propertyId, label, opts) {
  const { view, edit } = opts; // booleans
  const q = await client.query(
    `INSERT INTO roles (property_id, name, description, is_active, is_system_role, is_test_data)
     VALUES ($1, $2, $3, TRUE, FALSE, TRUE) RETURNING id`,
    [propertyId, `PEnd${label}${RUN_ID}`, `POS endpoint fixture ${label}`]
  );
  const roleId = Number(q.rows[0].id);
  track('roles', roleId);

  // Grid default-deny di semua resource; set sel yang diminta.
  const grid = {};
  for (const r of ACCESS_RESOURCES) {
    grid[r.key] = { view: false, edit: false, delete: false };
  }
  if (view) grid['POS'].view = true;
  if (edit) grid['POS'].edit = true;

  // Grant via permission key yang ADA (pos.view / pos.create / pos.edit /
  // pos.delete). edit → create + edit. view → view.
  const actor = {
    id: 0,
    name: `PEnd-fixture-${RUN_ID}`,
    property_id: propertyId,
    is_platform_super_admin: false,
  };
  await setRoleAccess(client, propertyId, roleId, grid, actor);
  return roleId;
}

/**
 * Buat user property + token (generateToken, kontrak auth existing).
 * @returns {{id:number, username:string, full_name:string, token:string}}
 */
async function createFixtureUser(client, propertyId, roleId, label) {
  const uname = `pend_${label}_${RUN_ID.toLowerCase()}`.slice(0, 100);
  const q = await client.query(
    `INSERT INTO users
       (property_id, role_id, username, email, password_hash, full_name,
        is_active, is_test_data)
     VALUES ($1, $2, $3, $4, 'x', $5, TRUE, TRUE)
     RETURNING id, username, full_name`,
    [
      propertyId,
      roleId,
      uname,
      `${uname}@test.local`,
      `PEnd ${label} ${RUN_ID}`,
    ]
  );
  const row = q.rows[0];
  const id = Number(row.id);
  track('users', id);

  const token = generateToken({
    id,
    email: `${uname}@test.local`,
    username: row.username,
    full_name: row.full_name,
    role: 'POS Fixture',
    role_id: roleId,
    property_id: propertyId,
    scope: 'FULL',
    access_type: 'PMS_STAFF',
  });

  return { id, username: row.username, full_name: row.full_name, token };
}

/**
 * Buat satu order POS OPEN dengan total_amount positif.
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

// ─── Helper HTTP: POST/GET ke server lokal pada port acak ──────────────────
// `token` null/undefined → tanpa header Authorization.
// `idempotencyKey` (opsional) → header Idempotency-Key.
//   - string non-empty → kirim header;
//   - `''` (empty string) → kirim header kosong (untuk uji S3 key kosong);
//   - undefined → header dihapus.
// `rawPath` bila true → kirim path persis apa adanya (tanpa encode) untuk
// memeriksa varian percent-encoded / trailing slash / case.
async function makeRequest(serverPort, method, pathOrUrl, body, token, opts) {
  const o = opts || {};
  const rawPath = o.rawPath ? pathOrUrl : pathOrUrl;
  const payload = body != null ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: serverPort,
      path: rawPath,
      method: method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);
    if (token) options.headers.Authorization = `Bearer ${token}`;
    if (o.idempotencyKey !== undefined) {
      options.headers['Idempotency-Key'] = String(o.idempotencyKey);
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = data ? JSON.parse(data) : {}; } catch (_) { /* keep raw */ }
        resolve({
          status: res.statusCode,
          body: parsed,
          headers: res.headers,
          raw: data,
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Verifikasi identitas DB SEBELUM mutasi apa pun ────────────────────────
// Mismatch → THROW (bukan process.exit) agar `finally` pada pemanggil tetap
// berjalan: server ditutup, client di-release, pool di-end.
// `identityVerified` di pemanggil hanya di-set SETELAH fungsi ini sukses.
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
    throw new Error('pool.options tidak cocok target disposable — hentikan sebelum mutasi');
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
    throw new Error('current_database tidak cocok target — hentikan sebelum mutasi');
  }
  if (row.usr !== target.user) {
    console.error(`[GUARD] current_user "${row.usr}" != target "${target.user}"`);
    throw new Error('current_user tidak cocok target — hentikan sebelum mutasi');
  }
  console.log(`[GUARD] Identitas DB terverifikasi: db=${row.db} user=${row.usr}`);
}

// ─── Kumpulkan artefak pembayaran yang dibuat endpoint ───────────────────────
// Melalu relasi source aktual (bukan mengandalkan return handler), sehingga
// artefak tetap ditemukan & dibersihkan walau skenario gagal di tengah.
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
    `SELECT id FROM pos_settlements WHERE pos_order_id = ANY($1)`,
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

// ─── Cleanup FK-safe (dedicated client, SATU transaksi, per-ID run ini) ─────
// HANYA hapus fixture milik run ini + artefak pembayaran + key cache.
// Role/permission existing TIDAK disentuh. Urutan anak → induk:
//
//   audit_logs (SETTLEMENT_CASH + ROLE_ACCESS_UPDATED record milik fixture)
//   → pos_settlements → transactions → pos_orders → pos_menu_items
//   → pos_menu_categories → user_permission_overrides → users
//   → role_permissions (CASCADE) → roles → properties
//   → idempotency_keys (key milik run ini)
//
// Kegagalan → return { error } (dibaca pemanggil untuk exit non-zero).
async function cleanupFixtures(cleanupClient) {
  const ids = (key) =>
    Array.isArray(tracked[key]) ? tracked[key].filter((v) => v != null) : [];

  try {
    await cleanupClient.query('BEGIN');

    // 1) audit_logs milik fixture:
    //    - SETTLEMENT_CASH record_id = settlement id run ini
    //    - ROLE_ACCESS_UPDATED record_id = role id run ini (dari setRoleAccess)
    {
      const st = ids('posSettlements');
      if (st.length) {
        await cleanupClient.query(
          `DELETE FROM audit_logs
           WHERE module = 'POS' AND action = 'SETTLEMENT_CASH'
             AND record_id = ANY($1)`,
          [st.map((s) => String(s))]
        );
      }
      const rl = ids('roles');
      if (rl.length) {
        await cleanupClient.query(
          `DELETE FROM audit_logs
           WHERE module = 'ACCESS_CONTROL' AND action = 'ROLE_ACCESS_UPDATED'
             AND record_id = ANY($1)`,
          [rl.map((s) => String(s))]
        );
      }
    }

    // 2) pos_settlements → order/transaction/property (RESTRICT)
    {
      const q = ids('posSettlements');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM pos_settlements WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 3) transactions (SALE) → property (RESTRICT)
    {
      const q = ids('transactions');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM transactions WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 4) pos_orders → reservations/properties
    {
      const q = ids('posOrders');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM pos_orders WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 5) pos_menu_items → categories
    {
      const q = ids('menuItems');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM pos_menu_items WHERE id = ANY($1)`, [q]
        );
      }
    }
    // 6) pos_menu_categories → properties
    {
      const q = ids('menuCategories');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM pos_menu_categories WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 7) user_permission_overrides milik user fixture (bila ada)
    {
      const u = ids('users');
      if (u.length) {
        await cleanupClient.query(
          `DELETE FROM user_permission_overrides WHERE user_id = ANY($1)`, [u]
        );
      }
    }

    // 8) users → roles (RESTRICT). Hapus sebelum role.
    {
      const q = ids('users');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM users WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 9) role_permissions → roles (CASCADE) + permissions (CASCADE).
    //    Bersihkan eksplisit agar tidak ada residu grant fixture.
    {
      const r = ids('roles');
      if (r.length) {
        await cleanupClient.query(
          `DELETE FROM role_permissions WHERE role_id = ANY($1)`, [r]
        );
      }
    }

    // 10) roles → properties
    {
      const q = ids('roles');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM roles WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 11) properties — terakhir (semua RESTRICT di atas sudah dibersihkan)
    {
      const q = ids('properties');
      if (q.length) {
        await cleanupClient.query(
          `DELETE FROM properties WHERE id = ANY($1)`, [q]
        );
      }
    }

    // 12) idempotency_keys — HANYA key unik milik run ini.
    {
      const keys = Array.from(new Set(trackedIdempotencyKeys));
      if (keys.length) {
        await cleanupClient.query(
          `DELETE FROM idempotency_keys WHERE key = ANY($1)`, [keys]
        );
      }
    }

    await cleanupClient.query('COMMIT');
    return { removed: 'ok' };
  } catch (err) {
    try {
      await cleanupClient.query('ROLLBACK');
    } catch (_) { /* abaikan — error utama dilaporkan */ }
    return { removed: 'error', error: String((err && err.message) || err) };
  }
}

// ─── Verifikasi residu: seluruh ID tracked + key harus hilang ───────────────
async function verifyNoResidue(residueClient) {
  const residue = [];
  const checks = [
    ['audit_logs', 'audit_id', 'auditLogs'],
    ['pos_settlements', 'id', 'posSettlements'],
    ['transactions', 'id', 'transactions'],
    ['pos_orders', 'id', 'posOrders'],
    ['pos_menu_items', 'id', 'menuItems'],
    ['pos_menu_categories', 'id', 'menuCategories'],
    ['users', 'id', 'users'],
    ['role_permissions', 'role_id', 'roles'],
    ['roles', 'id', 'roles'],
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

  // Residu key idempotency milik run ini.
  const keys = Array.from(new Set(trackedIdempotencyKeys));
  if (keys.length) {
    const res = await residueClient.query(
      `SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = ANY($1)`,
      [keys]
    );
    const n = Number(res.rows[0].n);
    if (n > 0) residue.push(`idempotency_keys: ${n} baris tersisa (key=${keys.join(',')})`);
  }
  return residue;
}

// ─── 4. main() dengan finally: tutup server & pool pada SEMUA jalur ─────────
async function main() {
  let server = null;
  let serverPort = null;
  // Client DEDICATED untuk verify identitas + skenario (pool client pool.app).
  const client = await pool.connect();
  // Client DEDICATED KEDUA untuk cleanup + residu.
  const cleanupClient = await pool.connect();
  let identityVerified = false;

  try {
    // Verifikasi guard SEBELUM mutasi apa pun.
    await verifyDbIdentity(client);
    identityVerified = true;

    // ── HTTP server lokal pada port acak (0 → OS pilih) ─────────────────
    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        resolve();
      });
    });
    console.log(`[SETUP] HTTP server test on port ${serverPort}`);

    // ── Fixture minimum (Tahap 2: belum skenario HTTP) ──────────────────
    // Properti A & B; role+user A (POS edit), A (tanpa POS edit), B (POS edit);
    // order OPEN milik properti A. Semua ID di-track sesaat setelah INSERT.
    const propA = await createFixtureProperty(client, 'A');
    const propB = await createFixtureProperty(client, 'B');

    // Role A dengan POS edit → user A (punya izin).
    const roleAEdit = await createRoleWithPosAccess(client, propA, 'AED', {
      view: true,
      edit: true,
    });
    const userAEdit = await createFixtureUser(client, propA, roleAEdit, 'AED');

    // Role A tanpa POS edit (default-deny) → user A tanpa izin.
    const roleANoEdit = await createRoleWithPosAccess(client, propA, 'ANO', {
      view: false,
      edit: false,
    });
    const userANoEdit = await createFixtureUser(client, propA, roleANoEdit, 'ANO');

    // Role B dengan POS edit → user B (properti lain; untuk uji cross-property).
    const roleBEdit = await createRoleWithPosAccess(client, propB, 'BED', {
      view: true,
      edit: true,
    });
    const userBEdit = await createFixtureUser(client, propB, roleBEdit, 'BED');

    // Order OPEN untuk properti A (target pembayaran skenario berikutnya).
    const orderA = await createFixturePosOrder(client, propA, 125000);

    // Verifikasi fixture terbaca kembali & ter-track.
    const chkQ = await client.query(
      `SELECT property_id, status, total_amount FROM pos_orders WHERE id = $1`,
      [orderA]
    );
    const chk = chkQ.rows[0] || {};
    ok('fixture: order A OPEN + total 125000',
      String(chk.status) === 'OPEN' && Number(chk.total_amount) === 125000,
      JSON.stringify(chk));
    ok('fixture: order A milik properti A', Number(chk.property_id) === propA,
      `order=${chk.property_id} propA=${propA}`);
    ok('fixture: token user A edit + A no-edit + B edit ter-generate',
      typeof userAEdit.token === 'string' && userAEdit.token.length > 0 &&
      typeof userANoEdit.token === 'string' && userANoEdit.token.length > 0 &&
      typeof userBEdit.token === 'string' && userBEdit.token.length > 0);

    // ── Skenario endpoint POST /api/pos/orders/:id/pay ──────────────────
    // Key pembayaran unik per run (track ke trackedIdempotencyKeys).
    const KEY_S1 = `pend_s1_${RUN_ID}`.slice(0, 120);
    const KEY_S3 = `pend_s3_${RUN_ID}`.slice(0, 120);
    trackedIdempotencyKeys.push(KEY_S1, KEY_S3);
    const bodyS1 = { property_id: propA, payment_method: 'CASH' };
    const payPath = `/api/pos/orders/${orderA}/pay`;

    // ── S1: user A (POS edit) → 201 created, lalu key sama → 200 replay ──
    console.log('\n--- S1: authorized + POS edit + properti sesuai ---');
    const s1created = await makeRequest(
      serverPort, 'POST', payPath, bodyS1, userAEdit.token, { idempotencyKey: KEY_S1 }
    );
    ok('S1: created → 201', s1created.status === 201,
      `status=${s1created.status} body=${s1created.raw ? s1created.raw.slice(0, 200) : JSON.stringify(s1created.body)}`);
    ok('S1: respons berisi settlement + sale + created=true',
      s1created.body && s1created.body.status === 'SUCCESS' &&
      s1created.body.data && s1created.body.data.created === true &&
      s1created.body.data.replayed === false &&
      s1created.body.data.settlement && s1created.body.data.sale);

    const s1settleId = s1created.body?.data?.settlement?.id;
    const s1saleId = s1created.body?.data?.sale?.id;
    ok('S1: settlement.id & sale.id ada', s1settleId != null && s1saleId != null,
      `settle=${s1settleId} sale=${s1saleId}`);

    const s1replay = await makeRequest(
      serverPort, 'POST', payPath, bodyS1, userAEdit.token, { idempotencyKey: KEY_S1 }
    );
    ok('S1: replay → 200', s1replay.status === 200,
      `status=${s1replay.status} body=${s1replay.raw ? s1replay.raw.slice(0, 200) : JSON.stringify(s1replay.body)}`);
    ok('S1: replay status=REPLAY & replayed=true',
      s1replay.body && s1replay.body.status === 'REPLAY' &&
      s1replay.body.data && s1replay.body.data.replayed === true &&
      s1replay.body.data.created === false);
    ok('S1: replay settlement/sale ID sama dengan created',
      s1replay.body?.data?.settlement?.id === s1settleId &&
      s1replay.body?.data?.sale?.id === s1saleId,
      `replay settle=${s1replay.body?.data?.settlement?.id} sale=${s1replay.body?.data?.sale?.id}`);

    // Tepat 1 SALE, 1 settlement, 1 audit settlement.
    {
      const stQ = await client.query(
        `SELECT COUNT(*) AS n FROM pos_settlements WHERE property_id = $1 AND pos_order_id = $2`,
        [propA, orderA]
      );
      ok('S1: tepat 1 settlement', Number(stQ.rows[0].n) === 1, `n=${stQ.rows[0].n}`);

      const txQ = await client.query(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE property_id = $1 AND source_type = 'POS_ORDER' AND source_id = $2`,
        [propA, String(orderA)]
      );
      ok('S1: tepat 1 SALE', Number(txQ.rows[0].n) === 1, `n=${txQ.rows[0].n}`);

      const auQ = await client.query(
        `SELECT COUNT(*) AS n FROM audit_logs
         WHERE module = 'POS' AND action = 'SETTLEMENT_CASH'
           AND record_id = ANY($1)`,
        [[String(s1settleId)]]
      );
      ok('S1: tepat 1 audit settlement', Number(auQ.rows[0].n) === 1, `n=${auQ.rows[0].n}`);
    }

    // ── S2: setelah S1 sukses, ulangi key S1 (tanpa token / tanpa izin /
    //    properti lain) → 401/403/403, tanpa membocorkan data pembayaran ──
    console.log('\n--- S2: key S1 ditolak (401 / 403 / 403) ---');
    const s2notoken = await makeRequest(
      serverPort, 'POST', payPath, bodyS1, null, { idempotencyKey: KEY_S1 }
    );
    ok('S2: tanpa token → 401', s2notoken.status === 401, `status=${s2notoken.status}`);
    ok('S2: tanpa token tidak membocorkan settlement/SALE',
      !(s2notoken.body && s2notoken.body.data &&
        (s2notoken.body.data.settlement || s2notoken.body.data.sale)));

    const s2noedit = await makeRequest(
      serverPort, 'POST', payPath, bodyS1, userANoEdit.token, { idempotencyKey: KEY_S1 }
    );
    ok('S2: user A tanpa POS edit → 403', s2noedit.status === 403,
      `status=${s2noedit.status} code=${s2noedit.body?.code}`);
    ok('S2: tanpa POS edit tidak membocorkan settlement/SALE',
      !(s2noedit.body && s2noedit.body.data &&
        (s2noedit.body.data.settlement || s2noedit.body.data.sale)));

    const s2cross = await makeRequest(
      serverPort, 'POST', payPath, bodyS1, userBEdit.token, { idempotencyKey: KEY_S1 }
    );
    ok('S2: user B meminta property_id=A → 403', s2cross.status === 403,
      `status=${s2cross.status} code=${s2cross.body?.code}`);
    ok('S2: user B (properti lain) tidak membocorkan settlement/SALE',
      !(s2cross.body && s2cross.body.data &&
        (s2cross.body.data.settlement || s2cross.body.data.sale)));

    // Tidak ada artefak tambahan setelah S2.
    {
      const stQ = await client.query(
        `SELECT COUNT(*) AS n FROM pos_settlements WHERE property_id = $1 AND pos_order_id = $2`,
        [propA, orderA]
      );
      ok('S2: jumlah settlement tetap 1 (tanpa artefak tambahan)',
        Number(stQ.rows[0].n) === 1, `n=${stQ.rows[0].n}`);
    }

    // ── S3: key berbeda pada order settled → 409 ALREADY_PAID;
    //    metode selain CASH & key kosong → 400, pada order OPEN baru ──
    console.log('\n--- S3: key berbeda order settled → 409; metode lain & key kosong → 400 ---');
    const s3diff = await makeRequest(
      serverPort, 'POST', payPath, bodyS1, userAEdit.token, { idempotencyKey: KEY_S3 }
    );
    ok('S3: key berbeda pada order settled → 409', s3diff.status === 409,
      `status=${s3diff.status} code=${s3diff.body?.code}`);
    ok('S3: code ALREADY_PAID', s3diff.body?.code === 'ALREADY_PAID',
      `code=${s3diff.body?.code}`);

    const orderS3 = await createFixturePosOrder(client, propA, 200000);
    const s3Path = `/api/pos/orders/${orderS3}/pay`;
    const bodyS3 = { property_id: propA, payment_method: 'CASH' };
    const s3preTx = await client.query(
      `SELECT COUNT(*) AS n FROM transactions WHERE property_id = $1 AND source_id = $2`,
      [propA, String(orderS3)]
    );
    const s3preSt = await client.query(
      `SELECT COUNT(*) AS n FROM pos_settlements WHERE property_id = $1 AND pos_order_id = $2`,
      [propA, orderS3]
    );
    const s3preAu = await client.query(
      `SELECT COUNT(*) AS n FROM audit_logs WHERE module = 'POS' AND action = 'SETTLEMENT_CASH'
       AND record_id = ANY(SELECT id::text FROM pos_settlements WHERE property_id = $1 AND pos_order_id = $2)`,
      [propA, orderS3]
    );

    const s3badmethod = await makeRequest(
      serverPort, 'POST', s3Path,
      { property_id: propA, payment_method: 'CARD' },
      userAEdit.token, { idempotencyKey: KEY_S3 }
    );
    ok('S3: metode selain CASH → 400', s3badmethod.status === 400,
      `status=${s3badmethod.status} code=${s3badmethod.body?.code}`);
    ok('S3: code UNSUPPORTED_PAYMENT_METHOD', s3badmethod.body?.code === 'UNSUPPORTED_PAYMENT_METHOD',
      `code=${s3badmethod.body?.code}`);

    const s3emptykey = await makeRequest(
      serverPort, 'POST', s3Path, bodyS3, userAEdit.token, { idempotencyKey: '' }
    );
    ok('S3: key kosong → 400', s3emptykey.status === 400,
      `status=${s3emptykey.status} code=${s3emptykey.body?.code}`);
    ok('S3: code VALIDATION_ERROR (key wajib)', s3emptykey.body?.code === 'VALIDATION_ERROR',
      `code=${s3emptykey.body?.code}`);

    // Status & jumlah artefak order OPEN baru tidak berubah.
    {
      const stQ = await client.query(
        `SELECT status FROM pos_orders WHERE id = $1`, [orderS3]
      );
      ok('S3: order S3 tetap OPEN', String(stQ.rows[0].status) === 'OPEN',
        `status=${stQ.rows[0].status}`);
      const s3postTx = await client.query(
        `SELECT COUNT(*) AS n FROM transactions WHERE property_id = $1 AND source_id = $2`,
        [propA, String(orderS3)]
      );
      const s3postSt = await client.query(
        `SELECT COUNT(*) AS n FROM pos_settlements WHERE property_id = $1 AND pos_order_id = $2`,
        [propA, orderS3]
      );
      const s3postAu = await client.query(
        `SELECT COUNT(*) AS n FROM audit_logs WHERE module = 'POS' AND action = 'SETTLEMENT_CASH'
       AND record_id = ANY(SELECT id::text FROM pos_settlements WHERE property_id = $1 AND pos_order_id = $2)`,
        [propA, orderS3]
      );
      ok('S3: jumlah SALE order S3 tidak berubah',
        Number(s3postTx.rows[0].n) === Number(s3preTx.rows[0].n),
        `pre=${s3preTx.rows[0].n} post=${s3postTx.rows[0].n}`);
      ok('S3: jumlah settlement order S3 tidak berubah',
        Number(s3postSt.rows[0].n) === Number(s3preSt.rows[0].n),
        `pre=${s3preSt.rows[0].n} post=${s3postSt.rows[0].n}`);
      ok('S3: jumlah audit order S3 tidak berubah',
        Number(s3postAu.rows[0].n) === Number(s3preAu.rows[0].n),
        `pre=${s3preAu.rows[0].n} post=${s3postAu.rows[0].n}`);
    }

    // ── S4: varian path (case, trailing slash, non-digit, percent-encoded)
    //    → 404 SEBELUM cache global; cache tidak dibuat/dipakai.
    //    Probe cache HIT (row idempotency_keys pada order BARU khusus)
    //    membuktikan cache tidak melewati auth/404.
    // ──
    console.log('\n--- S4: varian path → 404 sebelum cache global ---');
    const KEY_S4 = `pend_s4_${RUN_ID}`.slice(0, 120);
    trackedIdempotencyKeys.push(KEY_S4);
    const bodyS4 = { property_id: propA, payment_method: 'CASH' };

    // Encode digit eksplisit: setiap karakter digit dari orderA → %XX (hex uppercase).
    // Hasil: path mentah yang mengandung '%', berbeda dari canonical.
    const encodedOrderId = String(orderA).split('').map(
      (d) => '%' + d.charCodeAt(0).toString(16).toUpperCase()
    ).join('');
    ok('S4: encoded ID mengandung % dan berbeda dari canonical',
      encodedOrderId.includes('%') && encodedOrderId !== String(orderA),
      `encoded=${encodedOrderId}`);

    const s4variants = [
      { label: 'case', path: `/API/POS/orders/${orderA}/pay`, rawPath: true },
      { label: 'trailing slash', path: `/api/pos/orders/${orderA}/pay/`, rawPath: true },
      { label: 'non-digit', path: `/api/pos/orders/${orderA}x/pay`, rawPath: true },
      { label: 'percent-encoded', path: `/api/pos/orders/${encodedOrderId}/pay`, rawPath: true },
    ];
    for (const v of s4variants) {
      const r = await makeRequest(
        serverPort, 'POST', v.path, bodyS4, userAEdit.token,
        { idempotencyKey: KEY_S4, rawPath: v.rawPath }
      );
      ok(`S4: varian ${v.label} → 404`, r.status === 404,
        `status=${r.status} body=${r.raw ? r.raw.slice(0, 120) : JSON.stringify(r.body)}`);
      ok(`S4: varian ${v.label} tanpa membocorkan settlement/SALE`,
        !(r.body && r.body.data && (r.body.data.settlement || r.body.data.sale)));
    }

    // Canonical & varian tidak membuat row idempotency_keys.
    {
      const preQ = await client.query(
        `SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = $1`, [KEY_S4]
      );
      ok('S4: varian path tidak membuat row idempotency_keys (pre-assert)',
        Number(preQ.rows[0].n) === 0, `n=${preQ.rows[0].n}`);
    }

    // ── Probe cache HIT: order OPEN baru khusus, track untuk cleanup ──
    // Buat order probe (track ke tracked.posOrders → dihapus di cleanup).
    const orderProbe = await createFixturePosOrder(client, propA, 50000);
    const payPathProbe = `/api/pos/orders/${orderProbe}/pay`;
    const bodyProbe = { property_id: propA, payment_method: 'CASH' };

    // Hash mengikuti fungsi middleware cache: computeRequestHash(method, req.path, req.body)
    // = SHA-256('POST|' + req.path + '|' + JSON.stringify(req.body))
    // req.path di Express adalah path mentah SEBAGAIMANA dikirim klien.
    const probeHash = (() => {
      const cryptoMod = require('crypto');
      const bodyStr = JSON.stringify(bodyProbe);
      return cryptoMod.createHash('sha256')
        .update('POST|' + payPathProbe + '|' + bodyStr)
        .digest('hex');
    })();

    const probePreQ = await client.query(
      `SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = $1`, [KEY_S4]
    );
    ok('S4: probe cache — row belum ada sebelum INSERT', Number(probePreQ.rows[0].n) === 0);

    await client.query(
      `INSERT INTO idempotency_keys
         (key, request_hash, response_body, response_headers, status_code, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '1 day')`,
      [
        KEY_S4,
        probeHash,
        JSON.stringify({
          status: 'SUCCESS',
          data: {
            settlement: { probe: 'hit' },
            sale: { probe: 'hit' },
            created: true,
            replayed: false,
          },
        }),
        '{}',
        201,
      ]
    );
    const probePostQ = await client.query(
      `SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = $1`, [KEY_S4]
    );
    ok('S4: probe cache — row ter-INSERT (format row existing)',
      Number(probePostQ.rows[0].n) === 1, `n=${probePostQ.rows[0].n}`);

    // (a) Authorized canonical (user A edit) → bypass path canonical SEBELUM
    //     cache global → 201 dari service, bukan respons cache probe.
    const s4canon = await makeRequest(
      serverPort, 'POST', payPathProbe, bodyProbe,
      userAEdit.token, { idempotencyKey: KEY_S4 }
    );
    ok('S4: authorized canonical + cache HIT → 201 dari service (bukan respons cache)',
      s4canon.status === 201, `status=${s4canon.status}`);
    ok('S4: respons canonical bukan isi cache probe',
      !(s4canon.body?.data?.settlement && s4canon.body.data.settlement.probe === 'hit'));

    // (b) Tanpa token → 401 (auth middleware SEBELUM cache global; cache
    //     tidak melewati penolakan auth).
    const s4notoken = await makeRequest(
      serverPort, 'POST', payPathProbe, bodyProbe,
      null, { idempotencyKey: KEY_S4 }
    );
    ok('S4: tanpa token tetap 401 walau cache HIT ada',
      s4notoken.status === 401, `status=${s4notoken.status}`);

    // (c) Trailing slash + key sama → 404 (varian non-canonical di guard
    //     middleware; cache tidak melewati 404).
    const s4trail = await makeRequest(
      serverPort, 'POST', `/api/pos/orders/${orderProbe}/pay/`, bodyProbe,
      userAEdit.token, { idempotencyKey: KEY_S4, rawPath: true }
    );
    ok('S4: trailing slash tetap 404 walau cache HIT ada',
      s4trail.status === 404, `status=${s4trail.status}`);
    ok('S4: trailing slash tanpa membocorkan cache probe',
      !(s4trail.body?.data?.settlement && s4trail.body.data.settlement.probe === 'hit'));

    // Bersihkan row probe cache HIT (KEY_S4 sudah ter-track → cleanup
    // hapus via trackedIdempotencyKeys).
    const delQ = await client.query(
      `DELETE FROM idempotency_keys WHERE key = $1`, [KEY_S4]
    );
    ok('S4: probe cache HIT dibersihkan', delQ.rowCount === 1, `rowCount=${delQ.rowCount}`);

    // orderProbe sudah ter-track ke tracked.posOrders oleh createFixturePosOrder
    // → dihapus di cleanupFixtures. Artefak pembayaran (settlement/SALE/audit)
    // dari s4canon (201 created) dikumpulkan oleh collectPaymentArtifacts.

    // ── S5: batas ID INTEGER (maks 2147483647) → 400, bukan SQL 500 ───────
    console.log('\n--- S5: batas ID → 400 (bukan 500) ---');
    const s5badIds = [
      { label: '0', id: 0 },
      { label: '2147483648 (di atas INTEGER maks)', id: 2147483648 },
      { label: 'di atas INTEGER maks', id: 2147483648 + 100 },
    ];
    for (const b of s5badIds) {
      const r = await makeRequest(
        serverPort, 'POST', `/api/pos/orders/${b.id}/pay`, bodyS1,
        userAEdit.token, { idempotencyKey: KEY_S1 }
      );
      ok(`S5: ID ${b.label} → 400`, r.status === 400,
        `status=${r.status} body=${r.raw ? r.raw.slice(0, 150) : JSON.stringify(r.body)}`);
      ok(`S5: ID ${b.label} bukan 500`, r.status !== 500,
        `status=${r.status}`);
    }
    // Canonical non-digit mengikuti penolakan middleware 404 (S4).
    {
      const r = await makeRequest(
        serverPort, 'POST', '/api/pos/orders/abc/pay', bodyS1,
        userAEdit.token, { idempotencyKey: KEY_S1 }
      );
      ok('S5: canonical non-digit → 404 (middleware)', r.status === 404,
        `status=${r.status}`);
    }

  } catch (err) {
    console.error('\n[EXCEPTION]', err && err.stack ? err.stack : err);
    failed++;
    failures.push('exception pada alur utama: ' + (err && err.message));
  } finally {
    // ── TUTUP semua resource pada SEMUA jalur (sukses ATAU gagal) ─────────
    // Gate: collect artefak + cleanup + residu HANYA bila identitas DB
    // terverifikasi. Dibungkus try/finally terpisah agar server/client/pool
    // tetap ditutup walau cleanup/melewati baris di bawah throw.
    let cleanupError = null;
    let residueError = null;

    try {
      if (identityVerified) {
        // (a) Kumpulkan artefak pembayaran dari SELURUH order fixture,
        //     SEBELUM DELETE (agar settlement/SALE/audit ikut ter-track).
        try {
          const allOrders = (Array.isArray(tracked.posOrders) ? tracked.posOrders : [])
            .filter((v) => v != null);
          if (allOrders.length) {
            await collectPaymentArtifacts(cleanupClient, allOrders);
          }
        } catch (collectErr) {
          cleanupError = 'collect artefak: ' + String(collectErr && collectErr.message);
          console.error('[COLLECT] ' + cleanupError);
        }

        // (b) Cleanup FK-safe per-ID run ini + key cache.
        if (!cleanupError) {
          const res = await cleanupFixtures(cleanupClient);
          if (res.error) {
            cleanupError = res.error;
            console.error('[CLEANUP] gagal: ' + res.error);
          } else {
            console.log('[CLEANUP] fixture + artefak pembayaran + key cache dihapus.');
          }
        }

        // (c) Verifikasi residu.
        if (!cleanupError) {
          const residue = await verifyNoResidue(cleanupClient);
          if (residue.length) {
            residueError = residue.join('; ');
            console.error('[RESIDUE] ditemukan:\n  - ' + residue.join('\n  - '));
          } else {
            console.log('[RESIDUE] 0 — tidak ada residu fixture.');
          }
        }
      }
    } finally {
      // (d) Penutupan resource — SELALU dijalankan, apapun hasil cleanup.
      if (server) {
        await new Promise((resolve) => server.close(resolve));
        server = null;
        void serverPort;
      }
      try { client.release(); } catch (_) { /* ignore */ }
      try { cleanupClient.release(); } catch (_) { /* ignore */ }
      await pool.end().catch(() => {});
    }

    // ── Ringkasan ──────────────────────────────────────────────────────────
    console.log(`\n=== POS SETTLEMENT ENDPOINT TEST SUMMARY ===`);
    console.log(`  PASS: ${passed}  FAIL: ${failed}`);
    if (failures.length) {
      for (const f of failures) console.log(`  - ${f}`);
    }
    if (cleanupError) {
      console.log(`  [CLEANUP ERROR] ${cleanupError}`);
    }
    if (residueError) {
      console.log(`  [RESIDUE ERROR] ${residueError}`);
    }

    // Kegagalan (asensi gagal ATAU exception ATAU cleanup/residu error) → exit non-zero.
    if (failed > 0 || cleanupError || residueError) {
      process.exitCode = 1;
    } else {
      console.log('[OK] selesai; residu 0.');
    }
  }
}

main().catch((err) => {
  console.error('\n[UNCAUGHT]', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
