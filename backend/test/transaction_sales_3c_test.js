'use strict';

const { getTransactions } = require('../dist/domains/transactions/transactionService');

let assertions = 0;
function expect(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
}

async function run() {
  const pkg = require('../dist/index.js');
  const schemaPkg = require('../dist/db/schema_v3.js');
  const pool = pkg.pool;
  await schemaPkg.initializeDatabase(pool);

  const rand = Math.floor(1000 + Math.random() * 9000);
  const prop = await pool.query(
    "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('SALES-3C', $1, 'Asia/Jakarta', 'IDR', 'Addr', TRUE) RETURNING id",
    [`S${rand}`]
  );
  const propertyId = Number(prop.rows[0].id);

  try {
    const booking = await pool.query(
      "INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status) VALUES ($1, $2, 'TAMU 3C', 'ACTIVE') RETURNING id",
      [`BID-3C-${rand}`, propertyId]
    );
    const rc = await pool.query(
      "INSERT INTO room_categories (property_id, code, name) VALUES ($1, 'S3C', 'Cat') RETURNING id",
      [propertyId]
    );
    const rt = await pool.query(
      `INSERT INTO room_types (property_id, code, name, room_category_id, capacity, max_adults, max_children, is_active, display_order, base_rate)
       VALUES ($1, 'RT-3C', 'RT 3C', $2, 2, 2, 0, TRUE, 10, 300000) RETURNING id`,
      [propertyId, rc.rows[0].id]
    );
    const room = await pool.query(
      "INSERT INTO rooms (property_id, room_number, room_type_id, is_active) VALUES ($1, '301', $2, TRUE) RETURNING id",
      [propertyId, rt.rows[0].id]
    );
    const reservation = await pool.query(
      `INSERT INTO reservations (
         booking_id, room_id, status, stay_status, check_in, check_out,
         booked_room_type_id_snapshot, guest_name, stay_sequence,
         total_price, amount_paid, remaining_balance, payment_status, stay_type
       ) VALUES (
         $1, $2, 'BOOKED', 'RESERVED', '2026-09-07', '2026-09-08',
         $3, 'TAMU 3C', 1, 300000, 0, 300000, 'UNPAID', 'OVERNIGHT'
       ) RETURNING id`,
      [booking.rows[0].id, room.rows[0].id, rt.rows[0].id]
    );

    const groupId = `corr_3c_${rand}`;
    const orig = await pool.query(
      `INSERT INTO transactions (
         property_id, transaction_no, transaction_date, transaction_time, transaction_type, source_type, source_id,
         category_code, category_name, department_code, description,
         amount, net_amount, payment_status, transaction_status, guest_name_snapshot,
         reservation_id, booking_id, correction_group_id
       ) VALUES (
         $1, $2, '2026-09-07', '2026-09-07 10:00:00+07', 'SALE', 'ROOM_CHARGE', '850c',
         'ROOM_SALES', 'Room', 'FRONT_OFFICE', 'Original',
         300000, 300000, 'UNPAID', 'VOIDED', 'TAMU 3C', $3, $4, $5
       ) RETURNING id`,
      [propertyId, `TRX-3C-94-${rand}`, reservation.rows[0].id, booking.rows[0].id, groupId]
    );
    await pool.query(
      `INSERT INTO transactions (
         property_id, transaction_no, transaction_date, transaction_time, transaction_type, source_type, source_id,
         category_code, category_name, department_code, description,
         amount, net_amount, payment_status, transaction_status, guest_name_snapshot,
         reservation_id, booking_id, reversal_of_transaction_id, correction_group_id
       ) VALUES (
         $1, $2, '2026-09-08', '2026-09-08 09:00:00+07', 'SALE', 'ROOM_CHARGE', 'REV-850c',
         'ROOM_SALES', 'Room', 'FRONT_OFFICE', 'Reversal',
         -300000, -300000, 'UNPAID', 'REVERSED', 'TAMU 3C', $3, $4, $5, $6
       )`,
      [propertyId, `TRX-3C-95-${rand}`, reservation.rows[0].id, booking.rows[0].id, orig.rows[0].id, groupId]
    );
    const replacement = await pool.query(
      `INSERT INTO transactions (
         property_id, transaction_no, transaction_date, transaction_time, transaction_type, source_type, source_id,
         category_code, category_name, department_code, description,
         amount, net_amount, payment_status, transaction_status, guest_name_snapshot,
         reservation_id, booking_id, correction_group_id, metadata
       ) VALUES (
         $1, $2, '2026-09-08', '2026-09-08 09:05:00+07', 'SALE', 'ROOM_CHARGE', 'CORR-850c',
         'ROOM_SALES', 'Room', 'FRONT_OFFICE', 'Replacement',
         300000, 300000, 'UNPAID', 'POSTED', 'TAMU 3C', $3, $4, $5, $6::jsonb
       ) RETURNING id`,
      [propertyId, `TRX-3C-96-${rand}`, reservation.rows[0].id, booking.rows[0].id, groupId, JSON.stringify({
        correction_kind: 'SALE_PROJECTION_REPLACEMENT',
        restored_from_transaction_id: Number(orig.rows[0].id),
      })]
    );

    const sep7 = await getTransactions(pool, {
      property_id: propertyId,
      transaction_type: 'SALE',
      start_date: '2026-09-07',
      end_date: '2026-09-07',
    });
    expect(!sep7.transactions.some((row) => Number(row.id) === Number(replacement.rows[0].id)), 'A. Sep7 does not show Sep8 primary');
    expect(sep7.transactions.length === 0, 'A. Sep7 has no presented lifecycle for this correction');

    const sep8 = await getTransactions(pool, {
      property_id: propertyId,
      transaction_type: 'SALE',
      start_date: '2026-09-08',
      end_date: '2026-09-08',
    });
    expect(sep8.transactions.length === 1, 'A. Sep8 shows exactly one effective sale');
    expect(Number(sep8.transactions[0].id) === Number(replacement.rows[0].id), 'A. Sep8 primary is replacement');
    expect(Number(sep8.transactions[0].effective_net_amount) === 300000, 'A. Sep8 net is effective 300000');

    const both = await getTransactions(pool, {
      property_id: propertyId,
      transaction_type: 'SALE',
      start_date: '2026-09-07',
      end_date: '2026-09-08',
    });
    expect(both.transactions.length === 1, 'A. combined dates still one economic activity');
    expect(Number(both.total_count) === 1, 'O. combined period total_count is one presented item');

    await pool.query(
      `INSERT INTO transactions (
         property_id, transaction_no, transaction_date, transaction_time, transaction_type, source_type, source_id,
         category_code, category_name, department_code, description,
         amount, net_amount, payment_status, transaction_status, guest_name_snapshot,
         reservation_id, booking_id
       ) VALUES (
         $1, $2, '2026-09-08', '2026-09-08 11:00:00+07', 'SALE', 'EXTRA_BED', '850c-xb',
         'EXTRA_BED_SALES', 'Extra Bed', 'HOUSEKEEPING', 'Extra bed',
         50000, 50000, 'UNPAID', 'POSTED', 'TAMU 3C', $3, $4
       )`,
      [propertyId, `TRX-3C-XB-${rand}`, reservation.rows[0].id, booking.rows[0].id]
    );

    const ids = [];
    for (let i = 0; i < 40; i += 1) {
      const inserted = await pool.query(
        `INSERT INTO transactions (
           property_id, transaction_no, transaction_date, transaction_time, transaction_type, source_type,
           category_code, category_name, department_code, description,
           amount, net_amount, payment_status, transaction_status, guest_name_snapshot
         ) VALUES (
           $1, $2, $3::date, ($3 || ' 12:00:00+07')::timestamptz, 'SALE', 'MANUAL_SALE',
           'OTHER_SALES', 'Other', 'GENERAL', 'Standalone',
           10000, 10000, 'PAID', 'POSTED', 'WALKIN'
         ) RETURNING id`,
        [propertyId, `TRX-3C-S-${rand}-${i}`, `2026-08-${String((i % 28) + 1).padStart(2, '0')}`]
      );
      ids.push(Number(inserted.rows[0].id));
    }
    await pool.query(
      `INSERT INTO transactions (
         property_id, transaction_no, transaction_date, transaction_type, source_type,
         category_code, category_name, department_code, description,
         amount, net_amount, payment_status, transaction_status
       ) VALUES
         ($1, $2, '2026-09-01', 'PURCHASE', 'MANUAL_PURCHASE', 'OTHER_PURCHASE', 'Pembelian', 'GENERAL', 'Buy', 5000, 5000, 'UNPAID', 'DRAFT'),
         ($1, $3, '2026-09-01', 'EXPENSE', 'MANUAL_EXPENSE', 'OTHER_EXPENSE', 'Biaya', 'GENERAL', 'Exp', 4000, 4000, 'UNPAID', 'DRAFT'),
         ($1, $4, '2026-09-01', 'INCOME', 'MANUAL_INCOME', 'OTHER_INCOME', 'Masuk', 'GENERAL', 'Inc', 3000, 3000, 'PAID', 'POSTED')`,
      [propertyId, `TRX-3C-P-${rand}`, `TRX-3C-E-${rand}`, `TRX-3C-I-${rand}`]
    );

    const allTime = await getTransactions(pool, {
      property_id: propertyId,
      limit: 25,
      offset: 0,
    });
    expect(allTime.list_fetch_stats && allTime.list_fetch_stats.mode === 'ALL_TIME', 'P. All Time uses bounded mode');
    expect(
      allTime.list_fetch_stats.fetched_transaction_rows < 40,
      `P. All Time does not load the full standalone set into Node (fetched=${allTime.list_fetch_stats.fetched_transaction_rows})`
    );
    expect(allTime.transactions.length <= 25, 'L. page size respected');
    expect(allTime.total_count >= 44, 'O. total_count is presented items, not page size');
    const pageIds = allTime.transactions.map((row) => Number(row.id));
    expect(new Set(pageIds).size === pageIds.length, 'M. no duplicates on page 1');
    const bidGroupsOnPage = allTime.transactions.filter((row) => row.booking_bid_group);
    expect(bidGroupsOnPage.length <= 1, 'L. BID group is not split across multiple page rows');
    if (bidGroupsOnPage[0]) {
      const memberIds = bidGroupsOnPage[0].booking_bid_group.member_transaction_ids || [];
      expect(memberIds.length >= 2, 'L. BID page item includes grouped SALE members, not a partial child page');
    }

    const salePage = await getTransactions(pool, {
      property_id: propertyId,
      transaction_type: 'SALE',
      limit: 1,
      offset: 0,
    });
    expect(salePage.transactions.length === 1, 'L. SALE presented page size 1');
    expect(Boolean(salePage.transactions[0].booking_bid_group), 'L. newest SALE page is the BID group, not a split child');
    expect(salePage.total_count >= 41, 'O. SALE total_count is grouped presented items');

    const page2 = await getTransactions(pool, {
      property_id: propertyId,
      limit: 25,
      offset: 25,
    });
    const overlap = page2.transactions.filter((row) => pageIds.includes(Number(row.id)));
    expect(overlap.length === 0, 'M. no duplicates across pages');
    const toSortDate = (value) => {
      if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Jakarta',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(value);
      }
      return String(value || '').slice(0, 10);
    };
    const toSortTime = (value) => {
      if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
      return String(value || '');
    };
    const sortKeys = allTime.transactions.map((row) => [
      toSortDate(row.transaction_date),
      toSortTime(row.transaction_time),
      Number(row.id),
    ]);
    for (let i = 1; i < sortKeys.length; i += 1) {
      const prev = sortKeys[i - 1];
      const cur = sortKeys[i];
      if (prev[0] !== cur[0]) {
        expect(prev[0] > cur[0], `N. date desc at index ${i}`);
        continue;
      }
      if (String(prev[1]) !== String(cur[1])) {
        expect(String(prev[1]) > String(cur[1]), `N. time desc at index ${i}`);
        continue;
      }
      expect(Number(prev[2]) >= Number(cur[2]), `N. id desc at index ${i}`);
    }
    console.log('SALES-3C fetch stats', allTime.list_fetch_stats, {
      presented_page: allTime.transactions.length,
      total_count: allTime.total_count,
      standalone_fixture_rows: 40,
    });

    const allTypes = await getTransactions(pool, { property_id: propertyId, limit: 100, offset: 0 });
    expect(allTypes.transactions.some((row) => row.transaction_type === 'PURCHASE' && !row.booking_bid_group), 'K. ALL PURCHASE standalone');
    expect(allTypes.transactions.some((row) => row.transaction_type === 'EXPENSE' && !row.booking_bid_group), 'K. ALL EXPENSE standalone');
    expect(allTypes.transactions.some((row) => row.transaction_type === 'INCOME' && !row.booking_bid_group), 'K. ALL INCOME standalone');

    const search = await getTransactions(pool, {
      property_id: propertyId,
      transaction_type: 'SALE',
      start_date: '2026-09-08',
      end_date: '2026-09-08',
      search: `TRX-3C-94-${rand}`,
    });
    expect(search.transactions.length === 1, 'I. historical tx search finds lifecycle on primary date');
    expect(Number(search.transactions[0].id) === Number(replacement.rows[0].id), 'I. search returns presented primary');
  } finally {
    await pool.query('DELETE FROM transactions WHERE property_id = $1', [propertyId]).catch(() => {});
    await pool.query('DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1)', [propertyId]).catch(() => {});
    await pool.query('DELETE FROM bookings WHERE property_id = $1', [propertyId]).catch(() => {});
    await pool.query('DELETE FROM rooms WHERE property_id = $1', [propertyId]).catch(() => {});
    await pool.query('DELETE FROM room_types WHERE property_id = $1', [propertyId]).catch(() => {});
    await pool.query('DELETE FROM room_categories WHERE property_id = $1', [propertyId]).catch(() => {});
    await pool.query('DELETE FROM properties WHERE id = $1', [propertyId]).catch(() => {});
  }

  console.log(`PASS | SALES-3C list | ${assertions} assertions`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
