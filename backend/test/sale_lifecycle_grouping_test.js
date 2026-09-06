'use strict';

require('dotenv').config();
const {
  groupSaleLifecycles,
  selectLifecyclePrimary,
  lifecycleMemberRole,
  presentLifecyclePrimary,
  buildLifecycleHistory,
} = require('../dist/domains/transactions/saleLifecycleGrouping');

let assertions = 0;
function expect(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
}

const normal = { id: 10, transaction_type: 'SALE', transaction_status: 'POSTED', net_amount: 250000, amount: 250000 };
const groupedNormal = groupSaleLifecycles([normal]);
expect(groupedNormal.length === 1, 'normal sale is one lifecycle');
expect(Number(groupedNormal[0].primary.id) === 10, 'normal sale primary is itself');
expect(groupedNormal[0].effectiveNet === 250000, 'normal sale effective net is unchanged');
expect(groupedNormal[0].sheet === 'SELESAI', 'normal posted sale is SELESAI');
expect(lifecycleMemberRole(normal, [normal]) === 'Original Sale', 'standalone row is Original Sale');

const cancelledOrig = {
  id: 54,
  transaction_no: 'TRX-ORIG',
  transaction_type: 'SALE',
  transaction_status: 'VOIDED',
  net_amount: 418000,
  amount: 418000,
  reversal_of_transaction_id: null,
};
const cancelledRev = {
  id: 55,
  transaction_no: 'TRX-REV',
  transaction_type: 'SALE',
  transaction_status: 'REVERSED',
  net_amount: -418000,
  amount: -418000,
  reversal_of_transaction_id: 54,
};
const cancelledGroup = groupSaleLifecycles([cancelledOrig, cancelledRev]);
expect(cancelledGroup.length === 1, 'void + reversal collapse to one lifecycle');
expect(Number(selectLifecyclePrimary(cancelledGroup[0].members).id) === 55, 'cancelled primary is the reversal');
expect(cancelledGroup[0].effectiveNet === 0, 'cancelled lifecycle effective net is 0');
expect(cancelledGroup[0].sheet === 'BATAL', 'cancelled lifecycle sheet is BATAL');
expect(presentLifecyclePrimary(cancelledGroup[0]).lifecycle_status_label === 'Dibatalkan', 'cancelled primary label is Dibatalkan');

const tx94 = {
  id: 94,
  transaction_no: 'TRX-94',
  transaction_type: 'SALE',
  transaction_status: 'VOIDED',
  net_amount: 300000,
  amount: 300000,
  reservation_id: 986,
  correction_group_id: 'corr_tx94_folio850',
  source_id: '850',
};
const tx95 = {
  id: 95,
  transaction_no: 'TRX-95',
  transaction_type: 'SALE',
  transaction_status: 'REVERSED',
  net_amount: -300000,
  amount: -300000,
  reservation_id: 986,
  reversal_of_transaction_id: 94,
  correction_group_id: 'corr_tx94_folio850',
  source_id: 'REV-850',
};
const tx96 = {
  id: 96,
  transaction_no: 'TRX-96',
  transaction_type: 'SALE',
  transaction_status: 'POSTED',
  net_amount: 300000,
  amount: 300000,
  reservation_id: 986,
  correction_group_id: 'corr_tx94_folio850',
  source_id: 'CORR-850',
  metadata: { remediation_key: 'tx986-folio850-restore', correction_kind: 'SALE_PROJECTION_REPLACEMENT', restored_from_transaction_id: 94 },
};
const corrected = groupSaleLifecycles([tx94, tx95, tx96]);
expect(corrected.length === 1, 'original + reversal + correction are one lifecycle');
expect(Number(corrected[0].primary.id) === 96, 'corrected primary is the POSTED replacement');
expect(corrected[0].effectiveNet === 300000, 'corrected lifecycle effective net is +300000');
expect(corrected[0].sheet === 'SELESAI', 'corrected lifecycle sheet is SELESAI');
expect(lifecycleMemberRole(tx94, corrected[0].members) === 'Original Sale', '94 is Original Sale');
expect(lifecycleMemberRole(tx95, corrected[0].members) === 'Reversal', '95 is Reversal');
expect(lifecycleMemberRole(tx96, corrected[0].members) === 'Correction', '96 is Correction');
const history = buildLifecycleHistory(corrected[0]);
expect(history.members.length === 3, 'history keeps all three audit rows');
expect(history.effective_net_amount === 300000, 'history effective net is +300000');

const twoCancelled = groupSaleLifecycles([
  cancelledOrig,
  cancelledRev,
  { id: 70, transaction_status: 'CANCELLED', transaction_type: 'SALE', net_amount: 90000, amount: 90000 },
]);
expect(twoCancelled.length === 2, 'two distinct cancelled lifecycles stay separate');

async function runDb() {
  const pkg = require('../dist/index.js');
  const schemaPkg = require('../dist/db/schema_v3.js');
  const { getTransactions, getTransactionById } = require('../dist/domains/transactions/transactionService');
  const pool = pkg.pool;
  await schemaPkg.initializeDatabase(pool);

  const rand = Math.floor(1000 + Math.random() * 9000);
  const prop = await pool.query(
    "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('Lifecycle Grouping', $1, 'Asia/Jakarta', 'IDR', 'Addr', TRUE) RETURNING id",
    [`LG${rand}`]
  );
  const propertyId = Number(prop.rows[0].id);

  try {
    const normalIns = await pool.query(
      `INSERT INTO transactions (
         property_id, transaction_no, transaction_date, transaction_type, source_type,
         category_code, category_name, department_code, description,
         amount, net_amount, payment_status, transaction_status, guest_name_snapshot
       ) VALUES (
         $1, $2, CURRENT_DATE, 'SALE', 'MANUAL_SALE',
         'OTHER_SALES', 'Penjualan Lainnya', 'FRONT_OFFICE', 'Normal sale',
         250000, 250000, 'PAID', 'POSTED', 'TAMU NORMAL'
       ) RETURNING id, transaction_no`,
      [propertyId, `TRX-LG-N-${rand}`]
    );

    const voided = await pool.query(
      `INSERT INTO transactions (
         property_id, transaction_no, transaction_date, transaction_type, source_type,
         category_code, category_name, department_code, description,
         amount, net_amount, payment_status, transaction_status, guest_name_snapshot
       ) VALUES (
         $1, $2, CURRENT_DATE, 'SALE', 'ROOM_CHARGE',
         'ROOM_REVENUE', 'Room Revenue', 'FRONT_OFFICE', 'Cancelled original',
         400000, 400000, 'UNPAID', 'VOIDED', 'TAMU BATAL'
       ) RETURNING id`,
      [propertyId, `TRX-LG-V-${rand}`]
    );
    const reversal = await pool.query(
      `INSERT INTO transactions (
         property_id, transaction_no, transaction_date, transaction_type, source_type,
         category_code, category_name, department_code, description,
         amount, net_amount, payment_status, transaction_status, guest_name_snapshot,
         reversal_of_transaction_id
       ) VALUES (
         $1, $2, CURRENT_DATE, 'SALE', 'ROOM_CHARGE',
         'ROOM_REVENUE', 'Room Revenue', 'FRONT_OFFICE', 'Cancelled reversal',
         -400000, -400000, 'UNPAID', 'REVERSED', 'TAMU BATAL', $3
       ) RETURNING id`,
      [propertyId, `TRX-LG-R-${rand}`, voided.rows[0].id]
    );

    const groupId = `corr_tx${rand}_folio`;
    const origCorr = await pool.query(
      `INSERT INTO transactions (
         property_id, transaction_no, transaction_date, transaction_type, source_type, source_id,
         category_code, category_name, department_code, description,
         amount, net_amount, payment_status, transaction_status, guest_name_snapshot,
         room_number_snapshot, correction_group_id
       ) VALUES (
         $1, $2, CURRENT_DATE, 'SALE', 'ROOM_CHARGE', '850x',
         'ROOM_REVENUE', 'Room Revenue', 'FRONT_OFFICE', 'Historical original',
         300000, 300000, 'PAID', 'VOIDED', 'TAMU 986', '201', $3
       ) RETURNING id`,
      [propertyId, `TRX-LG-94-${rand}`, groupId]
    );
    await pool.query(
      `INSERT INTO transactions (
         property_id, transaction_no, transaction_date, transaction_type, source_type, source_id,
         category_code, category_name, department_code, description,
         amount, net_amount, payment_status, transaction_status, guest_name_snapshot,
         room_number_snapshot, reversal_of_transaction_id, correction_group_id
       ) VALUES (
         $1, $2, CURRENT_DATE, 'SALE', 'ROOM_CHARGE', 'REV-850x',
         'ROOM_REVENUE', 'Room Revenue', 'FRONT_OFFICE', 'Historical reversal',
         -300000, -300000, 'PAID', 'REVERSED', 'TAMU 986', '201', $3, $4
       )`,
      [propertyId, `TRX-LG-95-${rand}`, origCorr.rows[0].id, groupId]
    );
    const replacement = await pool.query(
      `INSERT INTO transactions (
         property_id, transaction_no, transaction_date, transaction_type, source_type, source_id,
         category_code, category_name, department_code, description,
         amount, net_amount, payment_status, transaction_status, guest_name_snapshot,
         room_number_snapshot, correction_group_id, metadata
       ) VALUES (
         $1, $2, CURRENT_DATE, 'SALE', 'ROOM_CHARGE', 'CORR-850x',
         'ROOM_REVENUE', 'Room Revenue', 'FRONT_OFFICE', 'Canonical correction',
         300000, 300000, 'PAID', 'POSTED', 'TAMU 986', '201', $3, $4::jsonb
       ) RETURNING id, transaction_no`,
      [propertyId, `TRX-LG-96-${rand}`, groupId, JSON.stringify({
        remediation_key: 'tx986-test',
        correction_kind: 'SALE_PROJECTION_REPLACEMENT',
        restored_from_transaction_id: Number(origCorr.rows[0].id),
      })]
    );

    const listed = await getTransactions(pool, { property_id: propertyId, transaction_type: 'SALE' });
    expect(listed.transactions.length === 3, 'default Penjualan list has 3 operational rows');
    expect(Number(listed.summary.count_sale) === 3, 'count_sale is lifecycle count');
    expect(Number(listed.summary.total_sale) === 550000, 'totals use effective nets: 250000 + 0 + 300000');
    expect(listed.sheet_counts.selesai === 2, 'sheet selesai counts two active lifecycles');
    expect(listed.sheet_counts.batal === 1, 'sheet batal counts one cancelled lifecycle');

    const normalRow = listed.transactions.find((row) => Number(row.id) === Number(normalIns.rows[0].id));
    const cancelledRow = listed.transactions.find((row) => Number(row.id) === Number(reversal.rows[0].id));
    const correctedRow = listed.transactions.find((row) => Number(row.id) === Number(replacement.rows[0].id));
    expect(Boolean(normalRow), 'normal sale remains its own row');
    expect(normalRow.operational_sheet === 'SELESAI', 'normal sale stays Selesai');
    expect(Number(normalRow.effective_net_amount) === 250000, 'normal sale net unchanged');
    expect(!listed.transactions.some((row) => Number(row.id) === Number(voided.rows[0].id)), 'cancelled original is not a peer list row');
    expect(Boolean(cancelledRow), 'cancelled lifecycle shows the reversal as primary');
    expect(cancelledRow.operational_sheet === 'BATAL', 'cancelled lifecycle is Dibatalkan/BATAL');
    expect(Number(cancelledRow.effective_net_amount) === 0, 'cancelled lifecycle list net is 0');
    expect(!listed.transactions.some((row) => Number(row.id) === Number(origCorr.rows[0].id)), 'historical VOIDED original is hidden from default list');
    expect(Boolean(correctedRow), 'corrected lifecycle shows the POSTED replacement');
    expect(correctedRow.operational_sheet === 'SELESAI', 'corrected lifecycle is Selesai');
    expect(Number(correctedRow.effective_net_amount) === 300000, 'corrected lifecycle list net is 300000');

    const batal = await getTransactions(pool, { property_id: propertyId, transaction_type: 'SALE', operational_sheet: 'BATAL' });
    expect(batal.transactions.length === 1, 'Batal sheet has only the cancelled lifecycle');
    expect(Number(batal.transactions[0].id) === Number(reversal.rows[0].id), 'Batal primary is the reversal');
    expect(!batal.transactions.some((row) => Number(row.id) === Number(replacement.rows[0].id)), 'active correction is not on Batal');

    const selesai = await getTransactions(pool, { property_id: propertyId, transaction_type: 'SALE', operational_sheet: 'SELESAI' });
    expect(selesai.transactions.length === 2, 'Selesai sheet has normal + corrected lifecycles');
    expect(selesai.transactions.some((row) => Number(row.id) === Number(replacement.rows[0].id)), 'corrected sale appears on Selesai');

    const searchNo = await getTransactions(pool, {
      property_id: propertyId,
      transaction_type: 'SALE',
      search: `TRX-LG-94-${rand}`,
    });
    expect(searchNo.transactions.length === 1, 'search by historical transaction number finds the lifecycle');
    expect(Number(searchNo.transactions[0].id) === Number(replacement.rows[0].id), 'search returns the effective primary');

    const searchGuest = await getTransactions(pool, {
      property_id: propertyId,
      transaction_type: 'SALE',
      search: 'TAMU 986',
    });
    expect(searchGuest.transactions.length === 1, 'search by guest finds one corrected lifecycle');
    const searchRoom = await getTransactions(pool, {
      property_id: propertyId,
      transaction_type: 'SALE',
      search: '201',
    });
    expect(searchRoom.transactions.length === 1, 'search by room finds one corrected lifecycle');

    const detail = await getTransactionById(pool, propertyId, replacement.rows[0].id);
    expect(Boolean(detail.lifecycle), 'detail exposes lifecycle history');
    expect(detail.lifecycle.member_count === 3, 'detail history has original + reversal + correction');
    expect(detail.lifecycle.effective_net_amount === 300000, 'detail effective net is 300000');
    expect(detail.lifecycle.members.some((m) => m.role === 'Original Sale' && m.transaction_status === 'VOIDED'), 'history keeps VOIDED original');
    expect(detail.lifecycle.members.some((m) => m.role === 'Reversal' && m.transaction_status === 'REVERSED'), 'history keeps REVERSED row');
    expect(detail.lifecycle.members.some((m) => m.role === 'Correction' && m.transaction_status === 'POSTED'), 'history keeps POSTED correction');
    expect(Number(detail.net_amount) === 300000, 'detail raw net of the opened row is unchanged');

    const cancelledDetail = await getTransactionById(pool, propertyId, reversal.rows[0].id);
    expect(cancelledDetail.lifecycle.member_count === 2, 'cancelled detail history remains available');
    expect(cancelledDetail.lifecycle.effective_net_amount === 0, 'cancelled detail effective net is 0');
  } finally {
    await pool.query('DELETE FROM transactions WHERE property_id = $1', [propertyId]).catch(() => {});
    await pool.query('DELETE FROM properties WHERE id = $1', [propertyId]).catch(() => {});
  }
}

(async () => {
  console.log('=== OAK HIMS Sale Lifecycle Grouping ===');
  await runDb();
  console.log(`PASS | ${assertions} assertions`);
  console.log('PASS | one operational row per lifecycle; history preserved; totals/counts use effective nets');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
