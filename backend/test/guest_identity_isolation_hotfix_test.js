/**
 * Guest Identity Isolation Hotfix Verification Suite (Baseline 04ee417)
 *
 * Verifies:
 * 1. Group placeholder shared across Res A (#1495 analogue) & Res B (#1503 analogue):
 *    Confirming Guest A on Res A creates new Guest A, relinks Res A PRIMARY_GUEST,
 *    syncs Res A snapshot, keeps BOOKER intact, and leaves Guest Group & Res B untouched.
 * 2. Confirming Guest B on Res B (same group phone) via EditReservationModal flow +
 *    executeReservationEditWithPayment creates new Guest B, relinks Res B, and leaves
 *    Res A (Guest A) and Guest Group 100% untouched.
 * 3. Explicit old/shared guest_id with different name or shared relation without NIK
 *    match is rejected (409 GUEST_IDENTITY_TARGET_MISMATCH / SHARED_PRIMARY_GUEST_CONFLICT).
 * 4. Empty NIK (nik: '') creates isolated guest on shared group room, while completing
 *    an isolated single-reservation unverified placeholder of the same name in-place.
 * 5. Strong NIK match reuses existing repeat guest; NIK collision with a different
 *    verified guest name is rejected (409 NIK_MISMATCH).
 * 6. Cross-property reservation/guest and wrong-user upload ownership rejected (403).
 * 7. Stale expected_primary_guest_id rejected (409 PRIMARY_GUEST_CHANGED) with full rollback.
 * 8. Retry/double-submit of same document_upload_id (even with guest_id: null) is idempotent;
 *    reuse for another guest/name is rejected (409 DOCUMENT_UPLOAD_ALREADY_CONSUMED).
 * 9. Expired upload and missing storage file rejected (409).
 * 10. Swapping PRIMARY_GUEST via applyReservationEdit (bookedOnly=false) to a guest without
 *     KTP clears reservation snapshot ktp_path/identity_number/has_valid_identity to NULL/FALSE.
 * 11. CRM edit of the same person (updateGuest) records explicit before/after in audit_logs
 *     and blocks duplicate NIK collision across guests in the same property (409).
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PROTECTED_PORTS = new Set([5432, 55457, 55451, 55449, 55458]);
const PROTECTED_DBS = new Set([
  'oak_hotel_db',
  'oak_hims_qb_payment_uat_20261111',
  'oak_hims_edit_reservasi'
]);
const EXPECTED_DBS = new Set(['oak_hotfix_04ee417_isolated_test']);
const EXPECTED_PORT = 55459;

const targetHost = process.env.DB_HOST || '127.0.0.1';
const targetPort = Number(process.env.DB_PORT);
const targetDb = process.env.DB_NAME;

if (!['127.0.0.1', 'localhost', '::1'].includes(targetHost)) {
  console.error(`GUARD: Refusing non-loopback host ${targetHost}`);
  process.exit(1);
}
if (targetPort !== EXPECTED_PORT || PROTECTED_PORTS.has(targetPort)) {
  console.error(`GUARD: Refusing port ${targetPort}; expected ${EXPECTED_PORT}`);
  process.exit(1);
}
if (!EXPECTED_DBS.has(targetDb) || PROTECTED_DBS.has(targetDb)) {
  console.error(`GUARD: Refusing database ${targetDb}`);
  process.exit(1);
}

const { confirmVerifiedIdentity } = require('../dist/domains/identity/identityDocumentUploadService');
const {
  executeReservationEditWithPayment,
  applyReservationEdit
} = require('../dist/domains/reservations/reservationEditService');
const { updateGuest } = require('../dist/domains/guests/guestService');

const pool = new Pool({
  host: targetHost,
  port: targetPort,
  user: process.env.DB_USER || 'oak_hotfix_test_r',
  password: process.env.DB_PASSWORD || 'oak_hotfix_local_only',
  database: targetDb
});

const STORAGE_BASE_DIR = path.resolve(__dirname, '..', 'storage');
const EVIDENCE_OUT_PATH = process.env.HOTFIX_EVIDENCE_OUT ||
  path.resolve(__dirname, '..', '..', '..', 'evidence', 'SYNTHETIC_VERIFICATION_AFTER_HOTFIX.json');

const tracked = {
  propertyIds: [],
  userIds: [],
  reservationIds: [],
  bookingIds: [],
  guestIds: [],
  uploadIds: [],
  storageFiles: []
};

const results = [];
let failures = 0;

async function runCase(id, title, fn) {
  try {
    const details = await fn();
    results.push({ id, title, status: 'PASS', details: details || {} });
    console.log(`PASS  [${id}] ${title}`);
  } catch (err) {
    failures += 1;
    results.push({
      id,
      title,
      status: 'FAIL',
      error: err.message,
      code: err.code || null,
      statusCode: err.statusCode || null
    });
    console.error(`FAIL  [${id}] ${title}\n      ${err.message}`);
  }
}

async function createUploadFixture(propertyId, userId, label, opts = {}) {
  const uploadId = crypto.randomUUID();
  const storageKey = `identity-documents/${propertyId}/${uploadId}.jpg`;
  const filePath = path.join(STORAGE_BASE_DIR, storageKey);
  if (!opts.skipFile) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const dummyJpeg = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46,
      0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      ...Buffer.from(label)
    ]);
    fs.writeFileSync(filePath, dummyJpeg);
    tracked.storageFiles.push(filePath);
  }
  const fileHash = crypto.createHash('sha256').update(`${label}-${uploadId}`).digest('hex');
  const expiresAt = opts.expired
    ? new Date(Date.now() - 3600 * 1000)
    : new Date(Date.now() + 3600 * 1000);
  await pool.query(
    `INSERT INTO identity_document_uploads
     (id, property_id, uploaded_by_user_id, storage_key, mime_type, file_hash,
      original_filename, status, created_at, expires_at)
     VALUES ($1, $2, $3, $4, 'image/jpeg', $5, $6, 'PENDING', NOW(), $7)`,
    [uploadId, propertyId, userId, storageKey, fileHash, `${label}.jpg`, expiresAt]
  );
  tracked.uploadIds.push(uploadId);
  return { uploadId, storageKey };
}

async function createReservationFixture(client, opts) {
  const {
    propertyId, roomId, roomTypeId, ratePlanId, bid,
    guestName, guestPhone, bookerName, bookerPhone,
    primaryGuestId, bookerGuestId,
    checkIn = '2036-06-01', checkOut = '2036-06-02'
  } = opts;
  const bRes = await client.query(
    `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
     VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [propertyId, bid, guestName]
  );
  const bookingId = Number(bRes.rows[0].id);
  tracked.bookingIds.push(bookingId);

  const rRes = await client.query(
    `INSERT INTO reservations (
       booking_id, room_id, booked_room_type_id_snapshot, rate_plan_id,
       guest_name, guest_phone, booker_name, booker_phone,
       check_in, check_out, subtotal_amount, discount_amount, service_amount,
       tax_amount, total_price, amount_paid, applied_deposit, remaining_balance,
       status, payment_status, stay_type, stay_sequence, has_valid_identity
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8,
       $9, $10, 500000, 0, 0,
       0, 500000, 0, 0, 500000,
       'BOOKED', 'UNPAID', 'OVERNIGHT', 1, FALSE
     ) RETURNING id`,
    [
      bookingId, roomId, roomTypeId, ratePlanId,
      guestName, guestPhone, bookerName || guestName, bookerPhone || guestPhone,
      checkIn, checkOut
    ]
  );
  const reservationId = Number(rRes.rows[0].id);
  tracked.reservationIds.push(reservationId);

  await client.query(
    `INSERT INTO folio_entries (reservation_id, property_id, entry_type, description, amount, direction)
     VALUES ($1, $2, 'ROOM_CHARGE', 'Initial room charge', 500000, 'DEBIT')`,
    [reservationId, propertyId]
  );

  if (primaryGuestId) {
    await client.query(
      `INSERT INTO reservation_guests (reservation_id, guest_id, role, relationship, is_staying, identity_verified, relation_source)
       VALUES ($1, $2, 'PRIMARY_GUEST', 'STAYING', TRUE, FALSE, 'CANONICAL_BOOKING')`,
      [reservationId, primaryGuestId]
    );
  }
  if (bookerGuestId) {
    await client.query(
      `INSERT INTO reservation_guests (reservation_id, guest_id, role, relationship, is_staying, identity_verified, relation_source)
       VALUES ($1, $2, 'BOOKER', 'BOOKER', FALSE, FALSE, 'CANONICAL_BOOKING')`,
      [reservationId, bookerGuestId]
    );
  }
  return { bookingId, reservationId };
}

async function cleanupAll() {
  const client = await pool.connect();
  try {
    for (const f of tracked.storageFiles) {
      try { fs.unlinkSync(f); } catch {}
    }
    if (tracked.uploadIds.length) {
      await client.query('DELETE FROM identity_document_uploads WHERE id = ANY($1::uuid[])', [tracked.uploadIds]).catch(() => {});
    }
    if (tracked.reservationIds.length) {
      await client.query('DELETE FROM payment_evidences WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]).catch(() => {});
      await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]).catch(() => {});
      await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]).catch(() => {});
      await client.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]).catch(() => {});
      await client.query('DELETE FROM reservation_guests WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]).catch(() => {});
      await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [tracked.reservationIds]).catch(() => {});
    }
    if (tracked.bookingIds.length) {
      await client.query('DELETE FROM bookings WHERE id = ANY($1::int[])', [tracked.bookingIds]).catch(() => {});
    }
    if (tracked.propertyIds.length) {
      await client.query('DELETE FROM identity_document_uploads WHERE property_id = ANY($1::int[])', [tracked.propertyIds]).catch(() => {});
      await client.query('DELETE FROM guests WHERE created_property_id = ANY($1::int[])', [tracked.propertyIds]).catch(() => {});
      await client.query('DELETE FROM audit_logs WHERE property_id = ANY($1::int[])', [tracked.propertyIds]).catch(() => {});
      await client.query('DELETE FROM availability_dates WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id = ANY($1::int[]))', [tracked.propertyIds]).catch(() => {});
      await client.query('DELETE FROM rate_plans WHERE property_id = ANY($1::int[])', [tracked.propertyIds]).catch(() => {});
      await client.query('DELETE FROM rooms WHERE property_id = ANY($1::int[])', [tracked.propertyIds]).catch(() => {});
      await client.query('DELETE FROM room_types WHERE property_id = ANY($1::int[])', [tracked.propertyIds]).catch(() => {});
      await client.query('DELETE FROM room_categories WHERE property_id = ANY($1::int[])', [tracked.propertyIds]).catch(() => {});
      await client.query('DELETE FROM property_pricing_settings WHERE property_id = ANY($1::int[])', [tracked.propertyIds]).catch(() => {});
    }
    if (tracked.userIds.length) {
      await client.query('DELETE FROM users WHERE id = ANY($1::int[])', [tracked.userIds]).catch(() => {});
    }
    if (tracked.propertyIds.length) {
      await client.query('DELETE FROM properties WHERE id = ANY($1::int[])', [tracked.propertyIds]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

async function main() {
  const runTag = `HFX${String(Date.now()).slice(-6)}`;
  const client = await pool.connect();
  let dbIdentityReceipt = null;
  let prop1Id, prop2Id, user1Id, user2Id, roomTypeId, ratePlanId;
  let rooms = [];
  let groupGuestId, soloGuestId, unverifiedGuestNoKtpId;
  let resAId, resBId, resCId, resSoloId, resRepeatId, resOtherId, resModeTestId;
  let guestAId, guestBId, uploadA, uploadB;

  try {
    // ── Verify live PostgreSQL database connection identity & ownership before any mutation ──
    const connGuard = await client.query(
      `SELECT current_database() AS db_name,
              current_user AS db_user,
              pg_catalog.pg_get_userbyid(d.datdba) AS db_owner,
              inet_server_addr()::text AS server_addr,
              inet_server_port()::int AS server_port
       FROM pg_catalog.pg_database d
       WHERE d.datname = current_database()`
    );
    dbIdentityReceipt = connGuard.rows[0] || null;
    if (
      !dbIdentityReceipt ||
      dbIdentityReceipt.db_name !== 'oak_hotfix_04ee417_isolated_test' ||
      dbIdentityReceipt.db_user !== 'oak_hotfix_test_r' ||
      dbIdentityReceipt.db_owner !== 'oak_hotfix_test_r'
    ) {
      throw new Error(
        `GUARD: Refusing execution due to DB identity/ownership mismatch: ${JSON.stringify(dbIdentityReceipt)}`
      );
    }

    // ── Seed isolated fixtures ───────────────────────────────────────────────
    const p1 = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ($1, $2, 'Asia/Jakarta', 'IDR', 'Hotfix Test Prop 1', TRUE) RETURNING id`,
      [`${runTag}-P1`, `H1${String(Date.now()).slice(-4)}`]
    );
    prop1Id = Number(p1.rows[0].id);
    tracked.propertyIds.push(prop1Id);

    const p2 = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ($1, $2, 'Asia/Jakarta', 'IDR', 'Hotfix Test Prop 2', TRUE) RETURNING id`,
      [`${runTag}-P2`, `H2${String(Date.now()).slice(-4)}`]
    );
    prop2Id = Number(p2.rows[0].id);
    tracked.propertyIds.push(prop2Id);

    await client.query(
      `INSERT INTO property_pricing_settings (property_id, tax_percent, service_charge_percent, prices_include_tax, prices_include_service)
       VALUES ($1, 0, 0, FALSE, FALSE), ($2, 0, 0, FALSE, FALSE)`,
      [prop1Id, prop2Id]
    );

    const u1 = await client.query(
      `INSERT INTO users (property_id, role_id, username, email, password_hash, full_name)
       VALUES ($1, 2, $2, $3, 'hash', 'FO User 1') RETURNING id`,
      [prop1Id, `u1_${runTag}`, `u1_${runTag}@test.local`]
    );
    user1Id = Number(u1.rows[0].id);
    tracked.userIds.push(user1Id);

    const u2 = await client.query(
      `INSERT INTO users (property_id, role_id, username, email, password_hash, full_name)
       VALUES ($1, 2, $2, $3, 'hash', 'FO User 2') RETURNING id`,
      [prop1Id, `u2_${runTag}`, `u2_${runTag}@test.local`]
    );
    user2Id = Number(u2.rows[0].id);
    tracked.userIds.push(user2Id);

    const cat = await client.query(
      `INSERT INTO room_categories (property_id, code, name, is_active)
       VALUES ($1, 'HFX-CAT', 'Hotfix Cat', TRUE) RETURNING id`,
      [prop1Id]
    );
    const rt = await client.query(
      `INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity)
       VALUES ($1, $2, 'HFX-DLX', 'Hotfix Deluxe', 500000, 2) RETURNING id`,
      [prop1Id, cat.rows[0].id]
    );
    roomTypeId = Number(rt.rows[0].id);

    for (let i = 1; i <= 6; i++) {
      const rm = await client.query(
        `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
         VALUES ($1, $2, $3, $4, 'VACANT_CLEAN', TRUE) RETURNING id`,
        [prop1Id, roomTypeId, `HX-${i}`, `Hotfix Room ${i}`]
      );
      rooms.push(Number(rm.rows[0].id));
    }

    const rp = await client.query(
      `INSERT INTO rate_plans (property_id, room_type_id, code, name, base_rate, rate_type, is_active)
       VALUES ($1, $2, 'HFX-BASE', 'Hotfix Base', 500000, 'OVERNIGHT', TRUE) RETURNING id`,
      [prop1Id, roomTypeId]
    );
    ratePlanId = Number(rp.rows[0].id);

    // Shared group placeholder guest (analogue of guests.id = 404 "Labkesda Prov Jatim")
    const grpGuest = await client.query(
      `INSERT INTO guests (
         guest_code, full_name, normalized_name, phone, normalized_phone,
         created_property_id, has_valid_identity, is_active
       ) VALUES ($1, $2, $3, $4, $4, $5, FALSE, TRUE) RETURNING id`,
      [`GST-${runTag}-GRP`, 'Labkesda Prov Jatim Synthetic', 'labkesda prov jatim synthetic', '081233334444', prop1Id]
    );
    groupGuestId = Number(grpGuest.rows[0].id);
    tracked.guestIds.push(groupGuestId);

    // Isolated single-reservation unverified placeholder guest
    const soloGuest = await client.query(
      `INSERT INTO guests (
         guest_code, full_name, normalized_name, phone, normalized_phone,
         created_property_id, has_valid_identity, is_active
       ) VALUES ($1, $2, $3, $4, $4, $5, FALSE, TRUE) RETURNING id`,
      [`GST-${runTag}-SOLO`, 'TAMU SOLO PLACEHOLDER', 'tamu solo placeholder', '081299990000', prop1Id]
    );
    soloGuestId = Number(soloGuest.rows[0].id);
    tracked.guestIds.push(soloGuestId);

    // Another unverified guest without KTP (for swap test)
    const noKtpGuest = await client.query(
      `INSERT INTO guests (
         guest_code, full_name, normalized_name, phone, normalized_phone,
         created_property_id, has_valid_identity, is_active
       ) VALUES ($1, $2, $3, $4, $4, $5, FALSE, TRUE) RETURNING id`,
      [`GST-${runTag}-NOKTP`, 'TAMU BARU TANPA KTP', 'tamu baru tanpa ktp', '081277778888', prop1Id]
    );
    unverifiedGuestNoKtpId = Number(noKtpGuest.rows[0].id);
    tracked.guestIds.push(unverifiedGuestNoKtpId);

    // Create Res A (#1495 analogue), Res B (#1503 analogue), Res C (3rd group room)
    resAId = (await createReservationFixture(client, {
      propertyId: prop1Id, roomId: rooms[0], roomTypeId, ratePlanId,
      bid: `${runTag}-RES-A`,
      guestName: 'Labkesda Prov Jatim Synthetic', guestPhone: '081233334444',
      bookerName: 'Labkesda Prov Jatim Synthetic', bookerPhone: '081233334444',
      primaryGuestId: groupGuestId, bookerGuestId: groupGuestId
    })).reservationId;

    resBId = (await createReservationFixture(client, {
      propertyId: prop1Id, roomId: rooms[1], roomTypeId, ratePlanId,
      bid: `${runTag}-RES-B`,
      guestName: 'Labkesda Prov Jatim Synthetic', guestPhone: '081233334444',
      bookerName: 'Labkesda Prov Jatim Synthetic', bookerPhone: '081233334444',
      primaryGuestId: groupGuestId, bookerGuestId: groupGuestId
    })).reservationId;

    resCId = (await createReservationFixture(client, {
      propertyId: prop1Id, roomId: rooms[2], roomTypeId, ratePlanId,
      bid: `${runTag}-RES-C`,
      guestName: 'Labkesda Prov Jatim Synthetic', guestPhone: '081233334444',
      bookerName: 'Labkesda Prov Jatim Synthetic', bookerPhone: '081233334444',
      primaryGuestId: groupGuestId, bookerGuestId: groupGuestId
    })).reservationId;

    resSoloId = (await createReservationFixture(client, {
      propertyId: prop1Id, roomId: rooms[3], roomTypeId, ratePlanId,
      bid: `${runTag}-RES-SOLO`,
      guestName: 'TAMU SOLO PLACEHOLDER', guestPhone: '081299990000',
      bookerName: 'TAMU SOLO PLACEHOLDER', bookerPhone: '081299990000',
      primaryGuestId: soloGuestId, bookerGuestId: soloGuestId
    })).reservationId;

    resRepeatId = (await createReservationFixture(client, {
      propertyId: prop1Id, roomId: rooms[4], roomTypeId, ratePlanId,
      bid: `${runTag}-RES-RPT`,
      guestName: 'Labkesda Prov Jatim Synthetic', guestPhone: '081233334444',
      bookerName: 'Labkesda Prov Jatim Synthetic', bookerPhone: '081233334444',
      primaryGuestId: groupGuestId, bookerGuestId: groupGuestId
    })).reservationId;

    resOtherId = (await createReservationFixture(client, {
      propertyId: prop1Id, roomId: rooms[5], roomTypeId, ratePlanId,
      bid: `${runTag}-RES-OTH`,
      guestName: 'Labkesda Prov Jatim Synthetic', guestPhone: '081233334444',
      bookerName: 'Labkesda Prov Jatim Synthetic', bookerPhone: '081233334444',
      primaryGuestId: groupGuestId, bookerGuestId: groupGuestId
    })).reservationId;

    resModeTestId = (await createReservationFixture(client, {
      propertyId: prop1Id, roomId: rooms[5], roomTypeId, ratePlanId,
      bid: `${runTag}-RES-MODE`,
      guestName: 'Labkesda Prov Jatim Synthetic', guestPhone: '081233334444',
      bookerName: 'Labkesda Prov Jatim Synthetic', bookerPhone: '081233334444',
      primaryGuestId: groupGuestId, bookerGuestId: groupGuestId,
      checkIn: '2036-06-05', checkOut: '2036-06-06'
    })).reservationId;

    // ── Scenario 1: Res A (#1495 analogue) Drawer KTP confirmation ───────────
    await runCase('S01_DRAWER_GROUP_ROOM_A_ISOLATION', 'ReservationDetailDrawer KTP confirm on Res A creates new Guest A, relinks Res A, leaves Group Guest & Res B untouched', async () => {
      uploadA = await createUploadFixture(prop1Id, user1Id, 'ktp_agil_a');
      const confirmedA = await confirmVerifiedIdentity(pool, {
        document_upload_id: uploadA.uploadId,
        property_id: prop1Id,
        actor_user_id: user1Id,
        guest_id: null,
        reservation_id: resAId,
        expected_primary_guest_id: groupGuestId,
        relink_reservation_primary_guest: true,
        name: 'AGIL SYNTHETIC A',
        nik: '3578000000000101',
        phone: '081233334444',
        address: 'MALANG SYNTHETIC A',
        context: 'CHECKIN_IDENTITY_SCAN'
      });
      guestAId = Number(confirmedA.id);
      tracked.guestIds.push(guestAId);

      assert.notStrictEqual(guestAId, groupGuestId, 'Must create a new guest row distinct from shared group placeholder');
      assert.strictEqual(confirmedA.full_name, 'AGIL SYNTHETIC A');

      // Verify Group Guest is 100% untouched
      const grpRow = (await pool.query('SELECT full_name, has_valid_identity, identity_storage_key, normalized_identity_number FROM guests WHERE id = $1', [groupGuestId])).rows[0];
      assert.strictEqual(grpRow.full_name, 'Labkesda Prov Jatim Synthetic');
      assert.strictEqual(grpRow.has_valid_identity, false);
      assert.strictEqual(grpRow.identity_storage_key, null);
      assert.strictEqual(grpRow.normalized_identity_number, null);

      // Verify Res A PRIMARY_GUEST is now guestAId, BOOKER is still groupGuestId, and snapshot is synced
      const resARel = (await pool.query('SELECT role, guest_id FROM reservation_guests WHERE reservation_id = $1', [resAId])).rows;
      const resAPg = Number(resARel.find((r) => r.role === 'PRIMARY_GUEST').guest_id);
      const resABooker = Number(resARel.find((r) => r.role === 'BOOKER').guest_id);
      assert.strictEqual(resAPg, guestAId);
      assert.strictEqual(resABooker, groupGuestId);

      const resARow = (await pool.query('SELECT guest_name, booker_name, has_valid_identity, ktp_path FROM reservations WHERE id = $1', [resAId])).rows[0];
      assert.strictEqual(resARow.guest_name, 'AGIL SYNTHETIC A');
      assert.strictEqual(resARow.booker_name, 'Labkesda Prov Jatim Synthetic');
      assert.strictEqual(resARow.has_valid_identity, true);
      assert.strictEqual(resARow.ktp_path, `/api/identity/document/${uploadA.uploadId}.jpg`);

      // Verify Res B is still linked to groupGuestId
      const resBPg = Number((await pool.query("SELECT guest_id FROM reservation_guests WHERE reservation_id = $1 AND role = 'PRIMARY_GUEST'", [resBId])).rows[0].guest_id);
      assert.strictEqual(resBPg, groupGuestId);

      return {
        group_guest_id: groupGuestId,
        new_guest_a_id: guestAId,
        res_a_primary_guest_id: resAPg,
        res_a_booker_guest_id: resABooker,
        res_b_primary_guest_id: resBPg,
        group_guest_untouched: true
      };
    });

    // ── Scenario 2: Res B (#1503 analogue) EditReservationModal KTP + Save ───
    await runCase('S02_EDIT_MODAL_GROUP_ROOM_B_ISOLATION', 'EditReservationModal KTP confirm + executeReservationEditWithPayment on Res B creates new Guest B, relinks Res B, leaves Res A (Guest A) & Group Guest untouched', async () => {
      uploadB = await createUploadFixture(prop1Id, user1Id, 'ktp_indah_b');
      const confirmedB = await confirmVerifiedIdentity(pool, {
        document_upload_id: uploadB.uploadId,
        property_id: prop1Id,
        actor_user_id: user1Id,
        guest_id: null,
        reservation_id: resBId,
        expected_primary_guest_id: groupGuestId,
        relink_reservation_primary_guest: false,
        name: 'INDAH SYNTHETIC B',
        nik: '3578000000000202',
        phone: '081233334444', // same group phone!
        address: 'SURABAYA SYNTHETIC B',
        context: 'RESERVATION_EDIT_IDENTITY'
      });
      guestBId = Number(confirmedB.id);
      tracked.guestIds.push(guestBId);

      assert.notStrictEqual(guestBId, groupGuestId, 'Must not overwrite group placeholder');
      assert.notStrictEqual(guestBId, guestAId, 'Must not merge into Guest A via shared group phone');

      await executeReservationEditWithPayment(pool, resBId, {
        property_id: prop1Id,
        room_id: rooms[1],
        check_in: '2036-06-01',
        check_out: '2036-06-02',
        stay_type: 'OVERNIGHT',
        rate_plan_id: ratePlanId,
        preserve_rate_plan: true,
        guest_id: guestBId,
        guest_name: 'INDAH SYNTHETIC B',
        guest_phone: '081233334444',
        actor_user_id: user1Id,
        idempotency_key: `idem-${runTag}-resb-1`
      });

      // Verify Res A AND Guest A are 100% untouched!
      const guestARow = (await pool.query('SELECT full_name, identity_storage_key, normalized_identity_number FROM guests WHERE id = $1', [guestAId])).rows[0];
      assert.strictEqual(guestARow.full_name, 'AGIL SYNTHETIC A');
      assert.strictEqual(guestARow.identity_storage_key, uploadA.storageKey);
      assert.strictEqual(guestARow.normalized_identity_number, '3578000000000101');

      const resARow = (await pool.query('SELECT guest_name, ktp_path FROM reservations WHERE id = $1', [resAId])).rows[0];
      const resAPg = Number((await pool.query("SELECT guest_id FROM reservation_guests WHERE reservation_id = $1 AND role = 'PRIMARY_GUEST'", [resAId])).rows[0].guest_id);
      assert.strictEqual(resAPg, guestAId);
      assert.strictEqual(resARow.guest_name, 'AGIL SYNTHETIC A');
      assert.strictEqual(resARow.ktp_path, `/api/identity/document/${uploadA.uploadId}.jpg`);

      // Verify Res B has Guest B
      const resBRow = (await pool.query('SELECT guest_name, booker_name, ktp_path, has_valid_identity FROM reservations WHERE id = $1', [resBId])).rows[0];
      const resBPg = Number((await pool.query("SELECT guest_id FROM reservation_guests WHERE reservation_id = $1 AND role = 'PRIMARY_GUEST'", [resBId])).rows[0].guest_id);
      const resBBooker = Number((await pool.query("SELECT guest_id FROM reservation_guests WHERE reservation_id = $1 AND role = 'BOOKER'", [resBId])).rows[0].guest_id);
      assert.strictEqual(resBPg, guestBId);
      assert.strictEqual(resBBooker, groupGuestId);
      assert.strictEqual(resBRow.guest_name, 'INDAH SYNTHETIC B');
      assert.strictEqual(resBRow.booker_name, 'Labkesda Prov Jatim Synthetic');
      assert.strictEqual(resBRow.ktp_path, `/api/identity/document/${uploadB.uploadId}.jpg`);
      assert.strictEqual(resBRow.has_valid_identity, true);

      return {
        new_guest_b_id: guestBId,
        res_a_primary_guest_id: resAPg,
        res_a_guest_name: resARow.guest_name,
        res_b_primary_guest_id: resBPg,
        res_b_guest_name: resBRow.guest_name,
        cross_contamination: false
      };
    });

    // ── Scenario 3: Explicit guest_id with different name or shared relation rejected (409) ──
    await runCase('S03_EXPLICIT_GUEST_ID_OVERWRITE_BLOCKED', 'Explicit old/shared guest_id with different name or shared relation without NIK match is rejected (409)', async () => {
      const upMismatch = await createUploadFixture(prop1Id, user1Id, 'ktp_mismatch_attempt');
      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: upMismatch.uploadId,
          property_id: prop1Id,
          actor_user_id: user1Id,
          guest_id: guestAId,
          reservation_id: resAId,
          name: 'NAMA ORANG LAIN',
          nik: '3578000000000101',
          context: 'CHECKIN_IDENTITY_SCAN'
        }),
        (err) => err.statusCode === 409 && err.code === 'GUEST_IDENTITY_TARGET_MISMATCH'
      );

      // Shared groupGuestId (still shared by resCId and resRepeatId) with explicit guest_id and empty NIK -> 409 SHARED_PRIMARY_GUEST_CONFLICT
      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: upMismatch.uploadId,
          property_id: prop1Id,
          actor_user_id: user1Id,
          guest_id: groupGuestId,
          reservation_id: resCId,
          name: 'Labkesda Prov Jatim Synthetic',
          nik: '',
          context: 'CHECKIN_IDENTITY_SCAN'
        }),
        (err) => err.statusCode === 409 && err.code === 'SHARED_PRIMARY_GUEST_CONFLICT'
      );

      // executeReservationEditWithPayment with guest_id=guestAId and different guest_name -> 409
      await assert.rejects(
        () => executeReservationEditWithPayment(pool, resAId, {
          property_id: prop1Id,
          room_id: rooms[0],
          check_in: '2036-06-01',
          check_out: '2036-06-02',
          stay_type: 'OVERNIGHT',
          rate_plan_id: ratePlanId,
          preserve_rate_plan: true,
          guest_id: guestAId,
          guest_name: 'NAMA OVERWRITE VIA EDIT',
          actor_user_id: user1Id,
          idempotency_key: `idem-${runTag}-resa-mismatch`
        }),
        (err) => err.statusCode === 409 && (err.code === 'GUEST_IDENTITY_TARGET_MISMATCH' || err.code === 'SHARED_PRIMARY_GUEST_CONFLICT')
      );

      const guestAAfter = (await pool.query('SELECT full_name FROM guests WHERE id = $1', [guestAId])).rows[0];
      assert.strictEqual(guestAAfter.full_name, 'AGIL SYNTHETIC A');
      return { rejected_codes: ['GUEST_IDENTITY_TARGET_MISMATCH', 'SHARED_PRIMARY_GUEST_CONFLICT'] };
    });

    // ── Scenario 4: Empty NIK (nik: '') on group room vs isolated solo placeholder ──
    await runCase('S04_EMPTY_NIK_GROUP_VS_SOLO_PLACEHOLDER', 'Empty NIK creates new isolated guest on shared group room, but completes isolated single-reservation placeholder in-place', async () => {
      // 4a: Group room resCId with empty NIK -> creates new guest, leaves groupGuestId untouched
      const upGroupNoNik = await createUploadFixture(prop1Id, user1Id, 'ktp_group_no_nik');
      const confirmedC = await confirmVerifiedIdentity(pool, {
        document_upload_id: upGroupNoNik.uploadId,
        property_id: prop1Id,
        actor_user_id: user1Id,
        guest_id: null,
        reservation_id: resCId,
        expected_primary_guest_id: groupGuestId,
        relink_reservation_primary_guest: true,
        name: 'TAMU GRUP TANPA NIK',
        nik: '',
        phone: '081233334444',
        context: 'CHECKIN_IDENTITY_SCAN'
      });
      const guestCId = Number(confirmedC.id);
      tracked.guestIds.push(guestCId);
      assert.notStrictEqual(guestCId, groupGuestId);

      // 4b: Isolated single-reservation placeholder (resSoloId -> soloGuestId) with same name & empty NIK -> completes soloGuestId in-place without orphan!
      const upSoloNoNik = await createUploadFixture(prop1Id, user1Id, 'ktp_solo_no_nik');
      const confirmedSolo = await confirmVerifiedIdentity(pool, {
        document_upload_id: upSoloNoNik.uploadId,
        property_id: prop1Id,
        actor_user_id: user1Id,
        guest_id: null,
        reservation_id: resSoloId,
        expected_primary_guest_id: soloGuestId,
        relink_reservation_primary_guest: true,
        name: 'TAMU SOLO PLACEHOLDER',
        nik: '',
        phone: '081299990000',
        context: 'CHECKIN_IDENTITY_SCAN'
      });
      assert.strictEqual(Number(confirmedSolo.id), soloGuestId, 'Isolated unverified placeholder with matching name must be completed in-place');
      return { group_no_nik_new_guest_id: guestCId, solo_placeholder_reused_in_place_id: soloGuestId };
    });

    // ── Scenario 5: Strong NIK match for repeat guest & NIK collision guard ──
    await runCase('S05_REPEAT_GUEST_NIK_MATCH_AND_COLLISION_GUARD', 'Strong NIK match reuses existing repeat guest; NIK collision with different verified name is rejected (409 NIK_MISMATCH)', async () => {
      // 5a: NIK collision with different name -> 409 NIK_MISMATCH
      const upCollision = await createUploadFixture(prop1Id, user1Id, 'ktp_nik_collision');
      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: upCollision.uploadId,
          property_id: prop1Id,
          actor_user_id: user1Id,
          guest_id: null,
          reservation_id: resRepeatId,
          expected_primary_guest_id: groupGuestId,
          relink_reservation_primary_guest: true,
          name: 'ORANG BERBEDA',
          nik: '3578000000000101', // belongs to AGIL SYNTHETIC A
          context: 'CHECKIN_IDENTITY_SCAN'
        }),
        (err) => err.statusCode === 409 && err.code === 'NIK_MISMATCH'
      );

      // 5b: Legitimate repeat guest with matching NIK and name -> reuses guestAId and links resRepeatId
      const upRepeat = await createUploadFixture(prop1Id, user1Id, 'ktp_agil_repeat');
      const confirmedRepeat = await confirmVerifiedIdentity(pool, {
        document_upload_id: upRepeat.uploadId,
        property_id: prop1Id,
        actor_user_id: user1Id,
        guest_id: null,
        reservation_id: resRepeatId,
        expected_primary_guest_id: groupGuestId,
        relink_reservation_primary_guest: true,
        name: 'AGIL SYNTHETIC A',
        nik: '3578000000000101',
        context: 'CHECKIN_IDENTITY_SCAN'
      });
      assert.strictEqual(Number(confirmedRepeat.id), guestAId, 'Repeat guest with matching NIK and name must reuse Guest A');
      const rptPg = Number((await pool.query("SELECT guest_id FROM reservation_guests WHERE reservation_id = $1 AND role = 'PRIMARY_GUEST'", [resRepeatId])).rows[0].guest_id);
      assert.strictEqual(rptPg, guestAId);
      return { reused_guest_id: guestAId, collision_rejected: true };
    });

    // ── Scenario 6: Cross-property & wrong-user upload ownership rejected (403) ──
    await runCase('S06_CROSS_PROPERTY_AND_UPLOAD_OWNERSHIP_GUARDS', 'Cross-property reservation/guest and wrong-user upload ownership rejected with 403', async () => {
      const upProp1 = await createUploadFixture(prop1Id, user1Id, 'ktp_prop_guard');

      // Wrong user (user2Id trying to confirm user1Id's upload)
      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: upProp1.uploadId,
          property_id: prop1Id,
          actor_user_id: user2Id,
          guest_id: null,
          name: 'TEST USER GUARD',
          nik: '3578000000000901',
          context: 'CHECKIN_IDENTITY_SCAN'
        }),
        (err) => err.statusCode === 403 && err.code === 'DOCUMENT_UPLOAD_NOT_OWNED'
      );

      // Cross-property upload vs property_id
      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: upProp1.uploadId,
          property_id: prop2Id,
          actor_user_id: user1Id,
          guest_id: null,
          name: 'TEST PROP GUARD',
          nik: '3578000000000902',
          context: 'CHECKIN_IDENTITY_SCAN'
        }),
        (err) => err.statusCode === 403 && err.code === 'DOCUMENT_UPLOAD_PROPERTY_MISMATCH'
      );

      // Cross-property reservation (upload on prop2Id referencing resAId on prop1Id)
      const upProp2 = await createUploadFixture(prop2Id, user1Id, 'ktp_prop2_res_guard');
      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: upProp2.uploadId,
          property_id: prop2Id,
          actor_user_id: user1Id,
          guest_id: null,
          reservation_id: resAId,
          name: 'TEST RES PROP GUARD',
          nik: '3578000000000903',
          context: 'CHECKIN_IDENTITY_SCAN'
        }),
        (err) => err.statusCode === 403 && err.code === 'RESERVATION_PROPERTY_MISMATCH'
      );
      return { ownership_guard: 'PASS', property_guard: 'PASS', reservation_property_guard: 'PASS' };
    });

    // ── Scenario 7: Stale expected_primary_guest_id CAS & full transaction rollback ──
    await runCase('S07_STALE_PRIMARY_GUEST_CAS_AND_ROLLBACK', 'Stale expected_primary_guest_id returns 409 PRIMARY_GUEST_CHANGED and rolls back completely', async () => {
      const upStale = await createUploadFixture(prop1Id, user1Id, 'ktp_stale_cas');
      const guestsBefore = Number((await pool.query('SELECT COUNT(*) AS cnt FROM guests WHERE created_property_id = $1', [prop1Id])).rows[0].cnt);

      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: upStale.uploadId,
          property_id: prop1Id,
          actor_user_id: user1Id,
          guest_id: null,
          reservation_id: resAId,
          expected_primary_guest_id: groupGuestId, // stale! resAId is now guestAId
          relink_reservation_primary_guest: true,
          name: 'TAMU STALE CAS',
          nik: '3578000000000777',
          context: 'CHECKIN_IDENTITY_SCAN'
        }),
        (err) => err.statusCode === 409 && err.code === 'PRIMARY_GUEST_CHANGED'
      );

      const guestsAfter = Number((await pool.query('SELECT COUNT(*) AS cnt FROM guests WHERE created_property_id = $1', [prop1Id])).rows[0].cnt);
      const upStatus = (await pool.query('SELECT status, confirmed_guest_id FROM identity_document_uploads WHERE id = $1', [upStale.uploadId])).rows[0];
      assert.strictEqual(guestsAfter, guestsBefore, 'No guest row may be committed when CAS fails');
      assert.strictEqual(upStatus.status, 'PENDING');
      assert.strictEqual(upStatus.confirmed_guest_id, null);
      return { cas_rejected: true, upload_remained_pending: true, guest_count_unchanged: true };
    });

    // ── Scenario 8: Idempotent retry vs cross-guest upload reuse ─────────────
    await runCase('S08_IDEMPOTENT_RETRY_VS_UPLOAD_REUSE_GUARD', 'Retry of same document_upload_id with guest_id=null is idempotent; reuse for another guest/name is rejected (409)', async () => {
      // Retry uploadA with guest_id: null and same name/nik -> idempotent 200 returning guestAId
      const retryRes = await confirmVerifiedIdentity(pool, {
        document_upload_id: uploadA.uploadId,
        property_id: prop1Id,
        actor_user_id: user1Id,
        guest_id: null,
        reservation_id: resAId,
        name: 'AGIL SYNTHETIC A',
        nik: '3578000000000101',
        context: 'CHECKIN_IDENTITY_SCAN'
      });
      assert.strictEqual(Number(retryRes.id), guestAId);

      // Attempt to reuse uploadA for a different guest/name -> 409 DOCUMENT_UPLOAD_ALREADY_CONSUMED
      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: uploadA.uploadId,
          property_id: prop1Id,
          actor_user_id: user1Id,
          guest_id: guestBId,
          name: 'INDAH SYNTHETIC B',
          nik: '3578000000000202',
          context: 'CHECKIN_IDENTITY_SCAN'
        }),
        (err) => err.statusCode === 409 && err.code === 'DOCUMENT_UPLOAD_ALREADY_CONSUMED'
      );
      return { idempotent_retry_guest_id: guestAId, cross_guest_reuse_rejected: true };
    });

    // ── Scenario 9: Expired upload & missing storage file rejected (409) ──────
    await runCase('S09_EXPIRED_AND_MISSING_FILE_UPLOADS_REJECTED', 'Expired upload and missing storage file are rejected with 409', async () => {
      const upExpired = await createUploadFixture(prop1Id, user1Id, 'ktp_expired', { expired: true });
      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: upExpired.uploadId,
          property_id: prop1Id,
          actor_user_id: user1Id,
          guest_id: null,
          name: 'EXPIRED GUEST',
          nik: '3578000000000881',
          context: 'CHECKIN_IDENTITY_SCAN'
        }),
        (err) => err.statusCode === 409 && err.code === 'DOCUMENT_UPLOAD_EXPIRED'
      );

      const upNoFile = await createUploadFixture(prop1Id, user1Id, 'ktp_no_file', { skipFile: true });
      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: upNoFile.uploadId,
          property_id: prop1Id,
          actor_user_id: user1Id,
          guest_id: null,
          name: 'MISSING FILE GUEST',
          nik: '3578000000000882',
          context: 'CHECKIN_IDENTITY_SCAN'
        }),
        (err) => err.statusCode === 409 && err.code === 'DOCUMENT_FILE_MISSING'
      );
      return { expired_rejected: true, missing_file_rejected: true };
    });

    // ── Scenario 10: Swapping PRIMARY_GUEST to a guest without KTP clears snapshot ──
    await runCase('S10_SWAP_TO_NO_KTP_GUEST_CLEARS_RESERVATION_SNAPSHOT', 'applyReservationEdit (bookedOnly=false) swapping to a guest without KTP clears ktp_path, identity_number, and has_valid_identity', async () => {
      const swapClient = await pool.connect();
      try {
        await swapClient.query('BEGIN');
        await applyReservationEdit(
          swapClient,
          resRepeatId,
          {
            property_id: prop1Id,
            room_id: rooms[4],
            check_in: '2036-06-01',
            check_out: '2036-06-02',
            stay_type: 'OVERNIGHT',
            rate_plan_id: ratePlanId,
            preserve_rate_plan: true,
            guest_id: unverifiedGuestNoKtpId,
            guest_name: 'TAMU BARU TANPA KTP',
            actor_user_id: user1Id
          },
          { bookedOnly: false }
        );
        await swapClient.query('COMMIT');
      } catch (e) {
        await swapClient.query('ROLLBACK');
        throw e;
      } finally {
        swapClient.release();
      }

      const rptRow = (await pool.query('SELECT guest_name, ktp_path, identity_number, has_valid_identity FROM reservations WHERE id = $1', [resRepeatId])).rows[0];
      assert.strictEqual(rptRow.guest_name, 'TAMU BARU TANPA KTP');
      assert.strictEqual(rptRow.ktp_path, null, 'Must not inherit previous guest KTP path');
      assert.strictEqual(rptRow.identity_number, null, 'Must not inherit previous guest NIK');
      assert.strictEqual(rptRow.has_valid_identity, false, 'Must reflect new guest has_valid_identity=false');
      return { cleared_ktp_path: true, cleared_identity_number: true, has_valid_identity: false };
    });

    // ── Scenario 11: CRM edit of the same person (before/after audit + duplicate NIK guard) ──
    await runCase('S11_CRM_EDIT_AUDIT_BEFORE_AFTER_AND_DUPLICATE_NIK_GUARD', 'updateGuest records before/after in GUEST_UPDATE audit log and rejects duplicate NIK collision (409)', async () => {
      // Duplicate NIK collision: trying to set Guest B's NIK to Guest A's NIK -> 409 DUPLICATE_IDENTITY_NUMBER
      await assert.rejects(
        () => updateGuest(pool, guestBId, { property_id: prop1Id, identity_number: '3578000000000101', updated_by: user1Id }),
        (err) => err.statusCode === 409 && err.code === 'DUPLICATE_IDENTITY_NUMBER'
      );

      // Legitimate CRM edit of Guest A (typo correction of same person)
      const updatedA = await updateGuest(pool, guestAId, {
        property_id: prop1Id,
        full_name: 'AGIL RAFI SYNTHETIC A',
        city: 'MALANG',
        updated_by: user1Id
      });
      assert.strictEqual(updatedA.full_name, 'AGIL RAFI SYNTHETIC A');

      const auditRes = await pool.query(
        `SELECT new_value FROM audit_logs
         WHERE module = 'GUEST_CRM' AND action = 'GUEST_UPDATE' AND record_id = $1
         ORDER BY audit_id DESC LIMIT 1`,
        [String(guestAId)]
      );
      assert.ok(auditRes.rowCount > 0, 'GUEST_UPDATE audit log must exist');
      const payload = typeof auditRes.rows[0].new_value === 'string'
        ? JSON.parse(auditRes.rows[0].new_value)
        : auditRes.rows[0].new_value;
      assert.strictEqual(payload.before.full_name, 'AGIL SYNTHETIC A');
      assert.strictEqual(payload.after.full_name, 'AGIL RAFI SYNTHETIC A');

      // Restore Guest A name back to 'AGIL SYNTHETIC A' for subsequent replay/isolation scenarios
      await updateGuest(pool, guestAId, {
        property_id: prop1Id,
        full_name: 'AGIL SYNTHETIC A',
        updated_by: user1Id
      });

      return {
        duplicate_nik_blocked: true,
        audit_before_full_name: payload.before.full_name,
        audit_after_full_name: payload.after.full_name
      };
    });

    // ── Scenario 12 (R1-1A): Legacy context ('CRM_EDIT' / omitted context / reservation_id=null) with explicit guest_id ──
    await runCase('S12_LEGACY_CRM_EDIT_EXPLICIT_TARGET_BLOCKED', 'Legacy CRM_EDIT or omitted context without reservation_id cannot overwrite shared master profile or verified guest with another person', async () => {
      const grpBefore = (await pool.query(
        'SELECT full_name, phone, identity_storage_key, normalized_identity_number, has_valid_identity FROM guests WHERE id = $1',
        [groupGuestId]
      )).rows[0];
      const guestABefore = (await pool.query(
        'SELECT full_name, phone, identity_storage_key, normalized_identity_number, has_valid_identity FROM guests WHERE id = $1',
        [guestAId]
      )).rows[0];
      const resOtherBefore = (await pool.query(
        "SELECT r.guest_name, r.ktp_path, rg.guest_id AS primary_guest_id FROM reservations r JOIN reservation_guests rg ON rg.reservation_id = r.id AND rg.role = 'PRIMARY_GUEST' WHERE r.id = $1",
        [resOtherId]
      )).rows[0];

      const upLegacy1 = await createUploadFixture(prop1Id, user1Id, 'ktp_legacy_crm_master');

      // 12a: Reviewer Repro 1 in PostgreSQL — context: 'CRM_EDIT', guest_id: groupGuestId, different person name, no reservation_id
      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: upLegacy1.uploadId,
          property_id: prop1Id,
          actor_user_id: user1Id,
          guest_id: groupGuestId,
          name: 'SYNTHETIC PERSON NEW',
          nik: '3578000000000404',
          context: 'CRM_EDIT'
        }),
        (err) => err.statusCode === 409 && err.code === 'GUEST_IDENTITY_TARGET_MISMATCH'
      );

      // 12b: Legacy request on shared groupGuestId with SAME group name & omitted reservation_id / omitted context -> 409 SHARED_PRIMARY_GUEST_CONFLICT
      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: upLegacy1.uploadId,
          property_id: prop1Id,
          actor_user_id: user1Id,
          guest_id: groupGuestId,
          name: 'Labkesda Prov Jatim Synthetic',
          nik: ''
        }),
        (err) => err.statusCode === 409 && err.code === 'SHARED_PRIMARY_GUEST_CONFLICT'
      );

      // 12c: Legacy CRM_EDIT on already-verified guestAId with different person name -> 409 GUEST_IDENTITY_TARGET_MISMATCH
      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: upLegacy1.uploadId,
          property_id: prop1Id,
          actor_user_id: user1Id,
          guest_id: guestAId,
          name: 'ORANG BERBEDA VIA CRM_EDIT',
          nik: '3578000000000101',
          context: 'CRM_EDIT'
        }),
        (err) => err.statusCode === 409 && err.code === 'GUEST_IDENTITY_TARGET_MISMATCH'
      );

      // 12d: Legacy CRM_EDIT on already-verified guestAId attempting to overwrite without NIK -> 409 NIK_MISMATCH
      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: upLegacy1.uploadId,
          property_id: prop1Id,
          actor_user_id: user1Id,
          guest_id: guestAId,
          name: 'AGIL SYNTHETIC A',
          nik: '',
          context: 'CRM_EDIT'
        }),
        (err) => err.statusCode === 409 && err.code === 'NIK_MISMATCH'
      );

      const grpAfter = (await pool.query(
        'SELECT full_name, phone, identity_storage_key, normalized_identity_number, has_valid_identity FROM guests WHERE id = $1',
        [groupGuestId]
      )).rows[0];
      const guestAAfter = (await pool.query(
        'SELECT full_name, phone, identity_storage_key, normalized_identity_number, has_valid_identity FROM guests WHERE id = $1',
        [guestAId]
      )).rows[0];
      const resOtherAfter = (await pool.query(
        "SELECT r.guest_name, r.ktp_path, rg.guest_id AS primary_guest_id FROM reservations r JOIN reservation_guests rg ON rg.reservation_id = r.id AND rg.role = 'PRIMARY_GUEST' WHERE r.id = $1",
        [resOtherId]
      )).rows[0];

      assert.deepStrictEqual(grpAfter, grpBefore, 'Master group guest must remain 100% unchanged');
      assert.deepStrictEqual(guestAAfter, guestABefore, 'Verified Guest A must remain 100% unchanged');
      assert.deepStrictEqual(resOtherAfter, resOtherBefore, 'Other reservations must remain 100% unchanged');

      return {
        master_group_unchanged: true,
        verified_guest_a_unchanged: true,
        other_reservation_unchanged: true
      };
    });

    // ── Scenario 13 (R1-1B): Legacy phone fallback guards + positive allowed CRM updates ──
    await runCase('S13_LEGACY_PHONE_FALLBACK_GUARDS_AND_POSITIVE_CRM_ALLOWED', 'Legacy CRM_EDIT phone fallback blocks cross-person or shared-group overwrite while allowing legitimate same-person isolated CRM updates', async () => {
      const grpBefore = (await pool.query(
        'SELECT full_name, phone, identity_storage_key, normalized_identity_number, has_valid_identity FROM guests WHERE id = $1',
        [groupGuestId]
      )).rows[0];

      const upPhoneGuard = await createUploadFixture(prop1Id, user1Id, 'ktp_legacy_phone_guard');

      // 13a: Phone fallback in CRM_EDIT matching groupGuestId phone ('081233334444') with different person name -> 409 GUEST_IDENTITY_TARGET_MISMATCH
      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: upPhoneGuard.uploadId,
          property_id: prop1Id,
          actor_user_id: user1Id,
          guest_id: null,
          name: 'SYNTHETIC PERSON VIA GROUP PHONE',
          nik: '3578000000000405',
          phone: '081233334444',
          context: 'CRM_EDIT'
        }),
        (err) => err.statusCode === 409 && err.code === 'GUEST_IDENTITY_TARGET_MISMATCH'
      );

      // 13b: Phone fallback in CRM_EDIT matching groupGuestId phone ('081233334444') even with same group name -> 409 SHARED_PRIMARY_GUEST_CONFLICT
      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: upPhoneGuard.uploadId,
          property_id: prop1Id,
          actor_user_id: user1Id,
          guest_id: null,
          name: 'Labkesda Prov Jatim Synthetic',
          nik: '',
          phone: '081233334444',
          context: 'CRM_EDIT'
        }),
        (err) => err.statusCode === 409 && err.code === 'SHARED_PRIMARY_GUEST_CONFLICT'
      );

      const grpAfter = (await pool.query(
        'SELECT full_name, phone, identity_storage_key, normalized_identity_number, has_valid_identity FROM guests WHERE id = $1',
        [groupGuestId]
      )).rows[0];
      assert.deepStrictEqual(grpAfter, grpBefore, 'Master group guest must remain untouched after phone fallback rejections');

      // 13c: Positive allowed CRM update with explicit guest_id for an isolated guest of the SAME person
      const crmExplicitInsert = await pool.query(
        `INSERT INTO guests (
           guest_code, full_name, normalized_name, phone, normalized_phone,
           created_property_id, has_valid_identity, is_active
         ) VALUES ($1, 'CRM EXPLICIT SAME PERSON', 'crm explicit same person', '081355550001', '081355550001', $2, FALSE, TRUE)
         RETURNING id`,
        [`GST-${runTag}-CRM1`, prop1Id]
      );
      const crmExplicitGuestId = Number(crmExplicitInsert.rows[0].id);
      tracked.guestIds.push(crmExplicitGuestId);

      const upCrmExplicit = await createUploadFixture(prop1Id, user1Id, 'ktp_crm_explicit_ok');
      const confirmedCrmExplicit = await confirmVerifiedIdentity(pool, {
        document_upload_id: upCrmExplicit.uploadId,
        property_id: prop1Id,
        actor_user_id: user1Id,
        guest_id: crmExplicitGuestId,
        name: 'CRM EXPLICIT SAME PERSON',
        nik: '3578000000000601',
        phone: '081355550001',
        context: 'CRM_EDIT'
      });
      assert.strictEqual(Number(confirmedCrmExplicit.id), crmExplicitGuestId);
      assert.strictEqual(confirmedCrmExplicit.has_valid_identity, true);

      // 13d: Positive allowed CRM update via phone fallback for an isolated unverified guest of the SAME person
      const crmPhoneInsert = await pool.query(
        `INSERT INTO guests (
           guest_code, full_name, normalized_name, phone, normalized_phone,
           created_property_id, has_valid_identity, is_active
         ) VALUES ($1, 'CRM PHONE SAME PERSON', 'crm phone same person', '081355550002', '081355550002', $2, FALSE, TRUE)
         RETURNING id`,
        [`GST-${runTag}-CRM2`, prop1Id]
      );
      const crmPhoneGuestId = Number(crmPhoneInsert.rows[0].id);
      tracked.guestIds.push(crmPhoneGuestId);

      const upCrmPhone = await createUploadFixture(prop1Id, user1Id, 'ktp_crm_phone_ok');
      const confirmedCrmPhone = await confirmVerifiedIdentity(pool, {
        document_upload_id: upCrmPhone.uploadId,
        property_id: prop1Id,
        actor_user_id: user1Id,
        guest_id: null,
        name: 'CRM PHONE SAME PERSON',
        nik: '3578000000000602',
        phone: '081355550002',
        context: 'CRM_EDIT'
      });
      assert.strictEqual(Number(confirmedCrmPhone.id), crmPhoneGuestId);
      assert.strictEqual(confirmedCrmPhone.has_valid_identity, true);

      return {
        phone_fallback_cross_person_rejected: true,
        phone_fallback_shared_group_rejected: true,
        positive_crm_explicit_guest_id: crmExplicitGuestId,
        positive_crm_phone_same_person_guest_id: crmPhoneGuestId
      };
    });

    // ── Scenario 14 (R1-2): Confirmation replay bound to originating operation & stale PRIMARY_GUEST detection ──
    await runCase('S14_CONFIRM_REPLAY_BINDING_AND_STALE_PRIMARY_GUEST', 'CONFIRMED receipt is bound to originating reservation/mode/target/payload and rejects stale PRIMARY_GUEST on retry', async () => {
      // 14a: Identical retry of uploadA on resAId (where PRIMARY_GUEST is still guestAId) -> 200 idempotent
      const identicalRetry = await confirmVerifiedIdentity(pool, {
        document_upload_id: uploadA.uploadId,
        property_id: prop1Id,
        actor_user_id: user1Id,
        guest_id: null,
        reservation_id: resAId,
        expected_primary_guest_id: groupGuestId,
        relink_reservation_primary_guest: true,
        name: 'AGIL SYNTHETIC A',
        nik: '3578000000000101',
        phone: '081233334444',
        context: 'CHECKIN_IDENTITY_SCAN'
      });
      assert.strictEqual(Number(identicalRetry.id), guestAId);

      // 14b: Reviewer Repro 2 in PostgreSQL — replay uploadA on a DIFFERENT reservation (resOtherId) with same guest name 'AGIL SYNTHETIC A'
      const resOtherBefore = (await pool.query(
        "SELECT r.guest_name, r.ktp_path, rg.guest_id AS primary_guest_id FROM reservations r JOIN reservation_guests rg ON rg.reservation_id = r.id AND rg.role = 'PRIMARY_GUEST' WHERE r.id = $1",
        [resOtherId]
      )).rows[0];

      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: uploadA.uploadId,
          property_id: prop1Id,
          actor_user_id: user1Id,
          guest_id: null,
          reservation_id: resOtherId,
          expected_primary_guest_id: groupGuestId,
          relink_reservation_primary_guest: true,
          name: 'AGIL SYNTHETIC A',
          nik: '3578000000000101',
          context: 'RESERVATION_IDENTITY_ASSIGN'
        }),
        (err) => err.statusCode === 409 && err.code === 'DOCUMENT_UPLOAD_ALREADY_CONSUMED'
      );

      const resOtherAfter = (await pool.query(
        "SELECT r.guest_name, r.ktp_path, rg.guest_id AS primary_guest_id FROM reservations r JOIN reservation_guests rg ON rg.reservation_id = r.id AND rg.role = 'PRIMARY_GUEST' WHERE r.id = $1",
        [resOtherId]
      )).rows[0];
      assert.deepStrictEqual(resOtherAfter, resOtherBefore, 'Replay on another reservation must not relink or mutate target reservation');

      // 14c: Target guest_id or payload (name / nik) change on replay -> 409 DOCUMENT_UPLOAD_ALREADY_CONSUMED
      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: uploadA.uploadId,
          property_id: prop1Id,
          actor_user_id: user1Id,
          guest_id: groupGuestId,
          reservation_id: resAId,
          name: 'AGIL SYNTHETIC A',
          nik: '3578000000000101',
          context: 'CHECKIN_IDENTITY_SCAN'
        }),
        (err) => err.statusCode === 409 && err.code === 'DOCUMENT_UPLOAD_ALREADY_CONSUMED'
      );

      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: uploadA.uploadId,
          property_id: prop1Id,
          actor_user_id: user1Id,
          guest_id: null,
          reservation_id: resAId,
          name: 'AGIL SYNTHETIC CHANGED NAME',
          nik: '3578000000000101',
          context: 'CHECKIN_IDENTITY_SCAN'
        }),
        (err) => err.statusCode === 409 && err.code === 'DOCUMENT_UPLOAD_ALREADY_CONSUMED'
      );

      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: uploadA.uploadId,
          property_id: prop1Id,
          actor_user_id: user1Id,
          guest_id: null,
          reservation_id: resAId,
          name: 'AGIL SYNTHETIC A',
          nik: '3578000000000999',
          context: 'CHECKIN_IDENTITY_SCAN'
        }),
        (err) => err.statusCode === 409 && err.code === 'DOCUMENT_UPLOAD_ALREADY_CONSUMED'
      );

      // 14d: Mode change on replay — receipt confirmed in RESERVATION_EDIT_IDENTITY (relink=false) replayed as RESERVATION_IDENTITY_ASSIGN (relink=true)
      const upModeEdit = await createUploadFixture(prop1Id, user1Id, 'ktp_mode_edit_draft');
      const draftGuest = await confirmVerifiedIdentity(pool, {
        document_upload_id: upModeEdit.uploadId,
        property_id: prop1Id,
        actor_user_id: user1Id,
        guest_id: null,
        reservation_id: resModeTestId,
        expected_primary_guest_id: groupGuestId,
        relink_reservation_primary_guest: false,
        name: 'TAMU DRAFT MODE EDIT',
        nik: '3578000000000603',
        context: 'RESERVATION_EDIT_IDENTITY'
      });
      tracked.guestIds.push(Number(draftGuest.id));

      // Verify resModeTestId is still linked to groupGuestId because relink=false
      const modePgBefore = Number((await pool.query(
        "SELECT guest_id FROM reservation_guests WHERE reservation_id = $1 AND role = 'PRIMARY_GUEST'",
        [resModeTestId]
      )).rows[0].guest_id);
      assert.strictEqual(modePgBefore, groupGuestId);

      // Now attempt to replay upModeEdit with relink_reservation_primary_guest=true / context='RESERVATION_IDENTITY_ASSIGN'
      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: upModeEdit.uploadId,
          property_id: prop1Id,
          actor_user_id: user1Id,
          guest_id: null,
          reservation_id: resModeTestId,
          expected_primary_guest_id: groupGuestId,
          relink_reservation_primary_guest: true,
          name: 'TAMU DRAFT MODE EDIT',
          nik: '3578000000000603',
          context: 'RESERVATION_IDENTITY_ASSIGN'
        }),
        (err) => err.statusCode === 409 && err.code === 'DOCUMENT_UPLOAD_ALREADY_CONSUMED'
      );

      const modePgAfter = Number((await pool.query(
        "SELECT guest_id FROM reservation_guests WHERE reservation_id = $1 AND role = 'PRIMARY_GUEST'",
        [resModeTestId]
      )).rows[0].guest_id);
      assert.strictEqual(modePgAfter, groupGuestId, 'Mode-change replay must not relink reservation');

      // 14e: PRIMARY_GUEST changed after initial confirmation -> identical retry must fail with 409 PRIMARY_GUEST_CHANGED
      const upAssign = await createUploadFixture(prop1Id, user1Id, 'ktp_assign_then_stale');
      const assignedGuest = await confirmVerifiedIdentity(pool, {
        document_upload_id: upAssign.uploadId,
        property_id: prop1Id,
        actor_user_id: user1Id,
        guest_id: null,
        reservation_id: resModeTestId,
        expected_primary_guest_id: groupGuestId,
        relink_reservation_primary_guest: true,
        name: 'TAMU ASSIGN AWAL',
        nik: '3578000000000604',
        context: 'RESERVATION_IDENTITY_ASSIGN'
      });
      const assignedGuestId = Number(assignedGuest.id);
      tracked.guestIds.push(assignedGuestId);

      // Simulate another operator changing PRIMARY_GUEST on resModeTestId after initial confirmation
      await pool.query(
        "UPDATE reservation_guests SET guest_id = $1, updated_at = NOW() WHERE reservation_id = $2 AND role = 'PRIMARY_GUEST'",
        [unverifiedGuestNoKtpId, resModeTestId]
      );

      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: upAssign.uploadId,
          property_id: prop1Id,
          actor_user_id: user1Id,
          guest_id: null,
          reservation_id: resModeTestId,
          expected_primary_guest_id: groupGuestId,
          relink_reservation_primary_guest: true,
          name: 'TAMU ASSIGN AWAL',
          nik: '3578000000000604',
          context: 'RESERVATION_IDENTITY_ASSIGN'
        }),
        (err) => err.statusCode === 409 && err.code === 'PRIMARY_GUEST_CHANGED'
      );

      return {
        identical_retry_ok: true,
        cross_reservation_replay_rejected: true,
        target_and_payload_change_rejected: true,
        mode_change_replay_rejected: true,
        stale_primary_guest_retry_rejected_409: true
      };
    });

    // ── Scenario 15 (R1-Followup): Unbound CONFIRMED receipt rejected in Edit & Assignment modes + concurrent retry after upload lock ──
    await runCase('S15_UNBOUND_CONFIRMED_RECEIPT_AND_CONCURRENT_RETRY_LOCK_ORDER', 'CONFIRMED receipt without verifiable operation_binding is rejected 409 in both Edit Reservasi and Assignment modes; valid identical & concurrent retries read binding after upload lock and succeed', async () => {
      // 15a:Valid identical retry in RESERVATION_EDIT_IDENTITY mode (relink=false) when PRIMARY_GUEST still matches
      const upValidEditRetry = await createUploadFixture(prop1Id, user1Id, 'ktp_valid_edit_retry');
      const editConfirmed1 = await confirmVerifiedIdentity(pool, {
        document_upload_id: upValidEditRetry.uploadId,
        property_id: prop1Id,
        actor_user_id: user1Id,
        guest_id: null,
        reservation_id: resOtherId,
        expected_primary_guest_id: groupGuestId,
        relink_reservation_primary_guest: false,
        name: 'TAMU EDIT RETRY VALID',
        nik: '3578000000000701',
        context: 'RESERVATION_EDIT_IDENTITY'
      });
      const editGuestId = Number(editConfirmed1.id);
      tracked.guestIds.push(editGuestId);

      const editConfirmed2 = await confirmVerifiedIdentity(pool, {
        document_upload_id: upValidEditRetry.uploadId,
        property_id: prop1Id,
        actor_user_id: user1Id,
        guest_id: null,
        reservation_id: resOtherId,
        expected_primary_guest_id: groupGuestId,
        relink_reservation_primary_guest: false,
        name: 'TAMU EDIT RETRY VALID',
        nik: '3578000000000701',
        context: 'RESERVATION_EDIT_IDENTITY'
      });
      assert.strictEqual(Number(editConfirmed2.id), editGuestId, 'Identical retry in RESERVATION_EDIT_IDENTITY mode with valid binding must succeed');

      // 15b: Remove audit binding row for upValidEditRetry -> CONFIRMED receipt without audit/binding in Edit Reservasi mode MUST be rejected 409
      await pool.query(
        `DELETE FROM audit_logs
         WHERE module = 'IDENTITY' AND entity = 'GUEST' AND property_id = $1
           AND (new_value::jsonb->>'document_upload_id') = $2`,
        [prop1Id, upValidEditRetry.uploadId]
      );

      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: upValidEditRetry.uploadId,
          property_id: prop1Id,
          actor_user_id: user1Id,
          guest_id: null,
          reservation_id: resOtherId,
          expected_primary_guest_id: groupGuestId,
          relink_reservation_primary_guest: false,
          name: 'TAMU EDIT RETRY VALID',
          nik: '3578000000000701',
          context: 'RESERVATION_EDIT_IDENTITY'
        }),
        (err) =>
          err.statusCode === 409 &&
          err.code === 'DOCUMENT_UPLOAD_ALREADY_CONSUMED' &&
          /unggah ulang/i.test(String(err.message))
      );

      // 15c: CONFIRMED receipt without audit/binding in Assignment mode (even when PRIMARY_GUEST and ktp_path match!) MUST be rejected 409
      // Create a legacy audit row without operation_binding on uploadA to also verify legacy unbound audit rejection
      await pool.query(
        `DELETE FROM audit_logs
         WHERE module = 'IDENTITY' AND entity = 'GUEST' AND property_id = $1
           AND (new_value::jsonb->>'document_upload_id') = $2`,
        [prop1Id, uploadA.uploadId]
      );

      await assert.rejects(
        () => confirmVerifiedIdentity(pool, {
          document_upload_id: uploadA.uploadId,
          property_id: prop1Id,
          actor_user_id: user1Id,
          guest_id: null,
          reservation_id: resAId,
          expected_primary_guest_id: groupGuestId,
          relink_reservation_primary_guest: true,
          name: 'AGIL SYNTHETIC A',
          nik: '3578000000000101',
          context: 'CHECKIN_IDENTITY_SCAN'
        }),
        (err) =>
          err.statusCode === 409 &&
          err.code === 'DOCUMENT_UPLOAD_ALREADY_CONSUMED' &&
          /unggah ulang/i.test(String(err.message))
      );

      // 15d: Concurrent identical confirmation & retry (Promise.all) — proves second transaction waiting on
      // identity_document_uploads FOR UPDATE reads the committed operation_binding from audit_logs AFTER acquiring the lock!
      const upConcurrent = await createUploadFixture(prop1Id, user1Id, 'ktp_concurrent_retry');
      const [conc1, conc2] = await Promise.all([
        confirmVerifiedIdentity(pool, {
          document_upload_id: upConcurrent.uploadId,
          property_id: prop1Id,
          actor_user_id: user1Id,
          guest_id: null,
          reservation_id: resOtherId,
          expected_primary_guest_id: groupGuestId,
          relink_reservation_primary_guest: true,
          name: 'TAMU CONCURRENT ASSIGN',
          nik: '3578000000000702',
          context: 'RESERVATION_IDENTITY_ASSIGN'
        }),
        confirmVerifiedIdentity(pool, {
          document_upload_id: upConcurrent.uploadId,
          property_id: prop1Id,
          actor_user_id: user1Id,
          guest_id: null,
          reservation_id: resOtherId,
          expected_primary_guest_id: groupGuestId,
          relink_reservation_primary_guest: true,
          name: 'TAMU CONCURRENT ASSIGN',
          nik: '3578000000000702',
          context: 'RESERVATION_IDENTITY_ASSIGN'
        })
      ]);
      tracked.guestIds.push(Number(conc1.id));
      assert.strictEqual(Number(conc1.id), Number(conc2.id), 'Concurrent identical confirmation and retry must return the exact same guest ID');

      return {
        valid_edit_mode_retry_ok: true,
        unbound_edit_mode_rejected_409: true,
        unbound_assign_mode_rejected_409: true,
        concurrent_assign_retry_after_lock_ok: true,
        concurrent_confirmed_guest_id: Number(conc1.id)
      };
    });

  } finally {
    client.release();
    await cleanupAll();
  }

  // Verify zero residue in isolated test DB for this run
  const residueCheck = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM properties WHERE id = ANY($1::int[])) AS properties_left,
       (SELECT COUNT(*)::int FROM reservations WHERE id = ANY($2::int[])) AS reservations_left,
       (SELECT COUNT(*)::int FROM guests WHERE id = ANY($3::int[])) AS guests_left,
       (SELECT COUNT(*)::int FROM identity_document_uploads WHERE id = ANY($4::uuid[])) AS uploads_left`,
    [tracked.propertyIds, tracked.reservationIds, tracked.guestIds, tracked.uploadIds]
  );
  const residue = residueCheck.rows[0];
  await pool.end();

  const receipt = {
    receipt_type: 'SYNTHETIC_VERIFICATION_AFTER_HOTFIX',
    generated_at_utc: new Date().toISOString(),
    baseline_commit: '04ee417c7af2603a40cf660041c8d429fe39e6bf',
    target_db: {
      host: targetHost,
      port: targetPort,
      database: targetDb,
      verified_connection: dbIdentityReceipt
    },
    total_cases: results.length,
    passed_cases: results.filter((r) => r.status === 'PASS').length,
    failed_cases: failures,
    cleanup_residue: residue,
    cases: results
  };

  fs.mkdirSync(path.dirname(EVIDENCE_OUT_PATH), { recursive: true });
  fs.writeFileSync(EVIDENCE_OUT_PATH, JSON.stringify(receipt, null, 2));
  console.log(`\nSaved verification receipt to ${EVIDENCE_OUT_PATH}`);

  if (
    failures > 0 ||
    residue.properties_left !== 0 ||
    residue.reservations_left !== 0 ||
    residue.guests_left !== 0 ||
    residue.uploads_left !== 0
  ) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
