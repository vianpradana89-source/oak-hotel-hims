const assert = require('assert');
const {
  deriveOperationalSheet,
  resolveOriginalFolioEntryId,
  projectFolioEntryToTransaction,
  getTransactions,
} = require('../dist/domains/transactions/transactionService');

let assertions = 0;
function expect(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
}

expect(resolveOriginalFolioEntryId({ source_id: '200', reversal_of_entry_id: 50 }) === '50', 'reversal_of_entry_id wins over source_id');
expect(resolveOriginalFolioEntryId({ source_id: '200' }) === null, 'stay-charge source_id is not treated as a folio id');
expect(resolveOriginalFolioEntryId({ reference_folio_entry_id: 77 }) === '77', 'reference_folio_entry_id is accepted');

expect(
  deriveOperationalSheet({
    transaction_type: 'SALE',
    transaction_status: 'POSTED',
    reservation_status: 'CANCELLED',
  }) === 'SELESAI',
  'POSTED sale sheet is SELESAI even if a sibling reservation is cancelled'
);
expect(
  deriveOperationalSheet({ transaction_type: 'SALE', transaction_status: 'REVERSED' }) === 'BATAL',
  'REVERSED sale sheet remains BATAL'
);
expect(
  deriveOperationalSheet({ transaction_type: 'SALE', transaction_status: 'VOIDED' }) === 'BATAL',
  'VOIDED sale sheet remains BATAL'
);

async function runIsolation() {
  const pkg = require('../dist/index.js');
  const schemaPkg = require('../dist/db/schema_v3.js');
  const pool = pkg.pool;
  const { initializeDatabase } = schemaPkg;
  await initializeDatabase(pool);

  const rand = Math.floor(1000 + Math.random() * 9000);
  const propCode = `SI${rand}`;
  const tracked = { propertyId: null, bookingIds: [], reservationIds: [], folioIds: [], txIds: [] };

  try {
    const propRes = await pool.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('Sale Status Isolation', $1, 'Asia/Jakarta', 'IDR', 'Addr', TRUE) RETURNING id",
      [propCode]
    );
    const propertyId = Number(propRes.rows[0].id);
    tracked.propertyId = propertyId;

    const rcRes = await pool.query(
      "INSERT INTO room_categories (property_id, code, name) VALUES ($1, 'CSSI', 'Cat SSI') RETURNING id",
      [propertyId]
    );
    const rtRes = await pool.query(
      `INSERT INTO room_types (property_id, code, name, room_category_id, capacity, max_adults, max_children, is_active, display_order, base_rate)
       VALUES ($1, 'RT-SSI', 'RT SSI', $2, 2, 2, 0, TRUE, 10, 400000) RETURNING id`,
      [propertyId, rcRes.rows[0].id]
    );
    const roomRes = await pool.query(
      "INSERT INTO rooms (property_id, room_number, room_type_id, is_active) VALUES ($1, '102', $2, TRUE) RETURNING id",
      [propertyId, rtRes.rows[0].id]
    );

    const bookingA = await pool.query(
      "INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status) VALUES ($1, $2, 'TAMU SSI', 'CANCELLED') RETURNING id",
      [`BID-A-${rand}`, propertyId]
    );
    const bookingB = await pool.query(
      "INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status) VALUES ($1, $2, 'TAMU SSI', 'ACTIVE') RETURNING id",
      [`BID-B-${rand}`, propertyId]
    );
    tracked.bookingIds.push(Number(bookingA.rows[0].id), Number(bookingB.rows[0].id));

    const resA = await pool.query(
      `INSERT INTO reservations (booking_id, room_id, status, stay_status, check_in, check_out, booked_room_type_id_snapshot, guest_name, stay_sequence, total_price, amount_paid, remaining_balance, payment_status, stay_type)
       VALUES ($1, $2, 'CANCELLED', 'CANCELLED', CURRENT_DATE, CURRENT_DATE, $3, 'TAMU SSI', 1, 400000, 0, 400000, 'UNPAID', 'DAY_USE')
       RETURNING id`,
      [bookingA.rows[0].id, roomRes.rows[0].id, rtRes.rows[0].id]
    );
    const resB = await pool.query(
      `INSERT INTO reservations (booking_id, room_id, status, stay_status, check_in, check_out, booked_room_type_id_snapshot, guest_name, stay_sequence, total_price, amount_paid, remaining_balance, payment_status, stay_type)
       VALUES ($1, $2, 'BOOKED', 'RESERVED', CURRENT_DATE, CURRENT_DATE, $3, 'TAMU SSI', 1, 400000, 0, 400000, 'UNPAID', 'DAY_USE')
       RETURNING id`,
      [bookingB.rows[0].id, roomRes.rows[0].id, rtRes.rows[0].id]
    );
    const reservationA = Number(resA.rows[0].id);
    const reservationB = Number(resB.rows[0].id);
    tracked.reservationIds.push(reservationA, reservationB);

    const folioA = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, description, amount, direction)
       VALUES ($1, $2, 'ROOM_CHARGE', 'ROOM_CHARGE', 'Day Use cancelled', 400000, 'DEBIT') RETURNING id`,
      [reservationA, propertyId]
    );
    const folioB = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, description, amount, direction)
       VALUES ($1, $2, 'ROOM_CHARGE', 'ROOM_CHARGE', 'Day Use active', 400000, 'DEBIT') RETURNING id`,
      [reservationB, propertyId]
    );
    const folioAId = Number(folioA.rows[0].id);
    const folioBId = Number(folioB.rows[0].id);
    tracked.folioIds.push(folioAId, folioBId);

    const saleA = await projectFolioEntryToTransaction(pool, folioAId, { propertyId });
    const saleB = await projectFolioEntryToTransaction(pool, folioBId, { propertyId });
    expect(saleA.transaction_status === 'POSTED', 'cancelled-stay original starts POSTED');
    expect(saleB.transaction_status === 'POSTED', 'active reservation sale starts POSTED');
    tracked.txIds.push(Number(saleA.id), Number(saleB.id));

    const reversal = await pool.query(
      `INSERT INTO folio_entries (
         reservation_id, property_id, entry_type, source_type, source_id,
         description, amount, direction, reversal_of_entry_id, status
       ) VALUES (
         $1, $2, 'REVERSAL', 'ROOM_CHARGE', $3,
         'Pembatalan: Day Use cancelled', 400000, 'CREDIT', $4, 'REVERSED'
       ) RETURNING id`,
      [reservationA, propertyId, String(folioBId), folioAId]
    );
    tracked.folioIds.push(Number(reversal.rows[0].id));

    const revTx = await projectFolioEntryToTransaction(pool, Number(reversal.rows[0].id), { propertyId });
    expect(Boolean(revTx), 'reversal transaction is created for the cancelled stay');
    expect(revTx.transaction_status === 'REVERSED', 'reversal row remains REVERSED');
    expect(Number(revTx.reservation_id) === reservationA, 'reversal stays linked to the cancelled reservation');
    tracked.txIds.push(Number(revTx.id));

    const saleAAfter = await pool.query('SELECT transaction_status, net_amount FROM transactions WHERE id = $1', [saleA.id]);
    const saleBAfter = await pool.query('SELECT transaction_status, net_amount, reservation_id FROM transactions WHERE id = $1', [saleB.id]);
    expect(saleAAfter.rows[0].transaction_status === 'REVERSED', 'cancelled reservation original is reversed');
    expect(saleBAfter.rows[0].transaction_status === 'POSTED', 'active reservation sale is not contaminated');
    expect(Number(saleBAfter.rows[0].reservation_id) === reservationB, 'active sale keeps its own reservation_id');

    const listed = await getTransactions(pool, { property_id: propertyId, transaction_type: 'SALE' });
    const rowB = listed.transactions.find((t) => Number(t.id) === Number(saleB.id));
    const rowRev = listed.transactions.find((t) => Number(t.id) === Number(revTx.id));
    expect(Boolean(rowB), 'active sale remains in Penjualan');
    expect(rowB.operational_sheet === 'SELESAI', 'active sale operational sheet is SELESAI');
    expect(rowB.transaction_status === 'POSTED', 'active sale DTO status is POSTED');
    expect(rowRev.operational_sheet === 'BATAL', 'reversal remains BATAL');
    expect(Number(listed.summary.total_sale) === 400000, 'cancelled pair nets out; active sale counts once');
    expect(Number(listed.summary.count_sale) === 3, 'original + reversal + active sale are three historical rows');
  } finally {
    if (tracked.propertyId) {
      const pid = [tracked.propertyId];
      await pool.query('DELETE FROM transactions WHERE property_id = ANY($1)', [pid]).catch(() => {});
      await pool.query('DELETE FROM folio_entries WHERE property_id = ANY($1)', [pid]).catch(() => {});
      await pool.query('DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = ANY($1))', [pid]).catch(() => {});
      await pool.query('DELETE FROM bookings WHERE property_id = ANY($1)', [pid]).catch(() => {});
      await pool.query('DELETE FROM rooms WHERE property_id = ANY($1)', [pid]).catch(() => {});
      await pool.query('DELETE FROM room_types WHERE property_id = ANY($1)', [pid]).catch(() => {});
      await pool.query('DELETE FROM room_categories WHERE property_id = ANY($1)', [pid]).catch(() => {});
      await pool.query('DELETE FROM properties WHERE id = ANY($1)', [pid]).catch(() => {});
    }
  }
}

(async () => {
  console.log('=== OAK HIMS Sale Status Isolation ===');
  await runIsolation();
  console.log(`PASS | ${assertions} assertions`);
  console.log('PASS | active sale stays non-Batal; cancelled reversal stays Batal; no BID/source_id contamination');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
