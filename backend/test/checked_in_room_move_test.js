const assert = require('assert');
const { Pool } = require('pg');
const { initializeDatabase } = require('../dist/db/schema_v3');
const { executeRoomMove, getRoomMoveHistory, previewRoomMove } = require('../dist/domains/reservations/roomMoveService');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});
const tag = `RM${String(Date.now()).slice(-8)}`;
const tracked = { propertyId: null, reservationIds: [], bookingIds: [] };

async function cleanup() {
  const client = await pool.connect();
  try {
    if (tracked.reservationIds.length) {
      await client.query('DELETE FROM reservation_room_moves WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [tracked.reservationIds]);
    }
    if (tracked.bookingIds.length) await client.query('DELETE FROM bookings WHERE id = ANY($1::int[])', [tracked.bookingIds]);
    if (tracked.propertyId) {
      await client.query('DELETE FROM housekeeping_tasks WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM audit_logs WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM availability_dates WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id = $1)', [tracked.propertyId]);
      await client.query('DELETE FROM room_operational_blocks WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM ota_sources WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM rate_plans WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM rooms WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM room_types WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM room_categories WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM property_housekeeping_settings WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM property_pricing_settings WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM properties WHERE id = $1', [tracked.propertyId]);
    }
  } finally { client.release(); }
}

async function setup() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const property = await client.query(`INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ($1,$2,'Asia/Jakarta','IDR','Test',TRUE) RETURNING id`, [tag, tag.slice(-6)]);
    tracked.propertyId = Number(property.rows[0].id);
    await client.query(`INSERT INTO property_pricing_settings (property_id,tax_percent,service_charge_percent,prices_include_tax,prices_include_service) VALUES ($1,0,0,FALSE,FALSE)`, [tracked.propertyId]);
    const category = await client.query(`INSERT INTO room_categories (property_id,code,name,is_active) VALUES ($1,'RMV','Room Move',TRUE) RETURNING id`, [tracked.propertyId]);
    const types = await client.query(`INSERT INTO room_types (property_id,room_category_id,code,name,base_rate,capacity) VALUES ($1,$2,'A','Type A',100000,2),($1,$2,'B','Type B',150000,2) RETURNING id,code`, [tracked.propertyId, category.rows[0].id]);
    const typeA = Number(types.rows.find(row => row.code === 'A').id); const typeB = Number(types.rows.find(row => row.code === 'B').id);
    const rooms = await client.query(`INSERT INTO rooms (property_id,room_type_id,room_number,name,status,is_active) VALUES ($1,$2,'A1','A1','OCCUPIED_CLEAN',TRUE),($1,$2,'A2','A2','VACANT_CLEAN',TRUE),($1,$2,'A3','A3','VACANT_CLEAN',TRUE),($1,$2,'A4','A4','VACANT_CLEAN',TRUE),($1,$2,'A5','A5','VACANT_CLEAN',TRUE),($1,$2,'A6','A6','VACANT_CLEAN',TRUE),($1,$3,'B1','B1','VACANT_CLEAN',TRUE),($1,$3,'B2','B2','OUT_OF_ORDER',TRUE),($1,$3,'B3','B3','VACANT_CLEAN',TRUE),($1,$3,'B4','B4','VACANT_CLEAN',TRUE) RETURNING id,room_number`, [tracked.propertyId,typeA,typeB]);
    const room = n => Number(rooms.rows.find(row => row.room_number === n).id);
    const plan = await client.query(`INSERT INTO rate_plans (property_id,room_type_id,code,name,base_rate,is_active,is_archived) VALUES ($1,$2,'BAR-B','BAR B',150000,TRUE,FALSE) RETURNING id`, [tracked.propertyId,typeB]);
    const ota = await client.query(`INSERT INTO ota_sources (property_id,code,name,is_active,is_archived) VALUES ($1,'OTA-RM','OTA Room Move',TRUE,FALSE) RETURNING id`, [tracked.propertyId]);
    const hotelDates = await client.query(`SELECT
      to_char((NOW() AT TIME ZONE 'Asia/Jakarta')::date, 'YYYY-MM-DD') AS today,
      to_char(((NOW() AT TIME ZONE 'Asia/Jakarta')::date + 1), 'YYYY-MM-DD') AS tomorrow,
      to_char(((NOW() AT TIME ZONE 'Asia/Jakarta')::date + 2), 'YYYY-MM-DD') AS check_out`);
    const { today, tomorrow, check_out: checkOut } = hotelDates.rows[0];
    await client.query(`INSERT INTO room_operational_blocks (property_id,room_id,room_type_id,block_type,start_date,end_date,reason,status) VALUES ($1,$2,$3,'OUT_OF_SERVICE',$4::date,$5::date,'Test block','ACTIVE')`, [tracked.propertyId,room('B4'),typeB,today,checkOut]);
    for (const [type, total] of [[typeA, 2], [typeB, 2]]) {
      for (const date of [today, tomorrow]) await client.query(`INSERT INTO availability_dates (room_type_id,room_type,date,total_rooms,reserved_qty) VALUES ($1,$2,$3,$4,0)`, [type, type === typeA ? 'Type A' : 'Type B', date, total]);
    }
    await client.query('COMMIT');
    return { typeA, typeB, roomA1: room('A1'), roomA2: room('A2'), roomA3: room('A3'), roomA4: room('A4'), roomA5: room('A5'), roomA6: room('A6'), roomB1: room('B1'), roomB2: room('B2'), roomB3: room('B3'), roomB4: room('B4'), ratePlanB: Number(plan.rows[0].id), otaSourceId: Number(ota.rows[0].id), today, tomorrow, checkOut };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function createReservation(fixture, suffix, roomId, typeId, status = 'CHECKED_IN', ota = null) {
  const booking = await pool.query(`INSERT INTO bookings (property_id,bid,guest_name_snapshot,booking_status) VALUES ($1,$2,$3,'ACTIVE') RETURNING id`, [tracked.propertyId, `${tag}-${suffix}`, suffix]);
  tracked.bookingIds.push(Number(booking.rows[0].id));
  const reservation = await pool.query(
    `INSERT INTO reservations (booking_id,room_id,booked_room_type_id_snapshot,rate_plan_id,guest_name,check_in,check_out,subtotal_amount,total_price,remaining_balance,status,stay_status,stay_sequence,ota_source_id)
     VALUES ($1,$2,$3,NULL,$4,$5::date,$6::date,200000,200000,200000,$7,$8,1,$9) RETURNING id`,
    [booking.rows[0].id, roomId, typeId, suffix, fixture.today, fixture.checkOut, status, status === 'CHECKED_IN' ? 'IN_HOUSE' : 'BOOKED', ota]
  );
  const id = Number(reservation.rows[0].id); tracked.reservationIds.push(id);
  for (const [date, amount] of [[fixture.today, 100000], [fixture.tomorrow, 100000]]) {
    await pool.query(`INSERT INTO reservation_nightly_rates (reservation_id,property_id,stay_date,room_type_id,base_rate,final_room_rate,total_amount) VALUES ($1,$2,$3,$4,$5,$5,$5)`, [id,tracked.propertyId,date,typeId,amount]);
    await pool.query(`UPDATE availability_dates SET reserved_qty=reserved_qty+1 WHERE room_type_id=$1 AND date=$2::date`, [typeId,date]);
  }
  await pool.query(`INSERT INTO folio_entries (reservation_id,property_id,entry_type,amount,direction) VALUES ($1,$2,'ROOM_CHARGE',200000,'DEBIT')`, [id,tracked.propertyId]);
  return id;
}

async function run() {
  await initializeDatabase(pool);
  const f = await setup();
  try {
    const actor = { id: 77, full_name: 'FO Tester', role: 'Front Office' };
    const same = await createReservation(f, 'SAME', f.roomA1, f.typeA);
    await executeRoomMove(pool, same, { property_id: tracked.propertyId, to_room_id: f.roomA2, reason_category: 'GUEST_REQUEST', reason_detail: 'Minta kamar tanpa akses tangga.', pricing_treatment: 'KEEP_CURRENT_RATE', idempotency_key: `${tag}-same` }, actor, `${tag}-same`);
    const sameCheck = await pool.query(`SELECT r.room_id,r.total_price,old.status AS old_status,new.status AS new_status,(SELECT COUNT(*)::int FROM reservation_room_moves WHERE reservation_id=r.id) AS moves FROM reservations r JOIN rooms old ON old.id=$2 JOIN rooms new ON new.id=$3 WHERE r.id=$1`, [same,f.roomA1,f.roomA2]);
    assert.equal(Number(sameCheck.rows[0].room_id), f.roomA2); assert.equal(Number(sameCheck.rows[0].total_price), 200000); assert.equal(sameCheck.rows[0].old_status, 'VACANT_DIRTY'); assert.equal(sameCheck.rows[0].new_status, 'OCCUPIED_CLEAN'); assert.equal(Number(sameCheck.rows[0].moves), 1);
    const different = await createReservation(f, 'KEEP', f.roomA1, f.typeA);
    const preview = await previewRoomMove(pool, different, { property_id: tracked.propertyId, to_room_id: f.roomB1, rate_plan_id: f.ratePlanB });
    assert(preview.difference > 0, 'cross-type preview exposes price impact');
    await executeRoomMove(pool, different, { property_id: tracked.propertyId, to_room_id: f.roomB1, reason_category: 'UPGRADE', reason_detail: 'Upgrade operasional.', pricing_treatment: 'KEEP_CURRENT_RATE', idempotency_key: `${tag}-keep` }, actor);
    const rateRows = await pool.query(`SELECT room_type_id,final_room_rate FROM reservation_nightly_rates WHERE reservation_id=$1 ORDER BY stay_date`, [different]);
    assert.equal(Number(rateRows.rows[0].room_type_id), f.typeA, 'checked-in night retains old room type context');
    assert.equal(Number(rateRows.rows[1].room_type_id), f.typeB, 'future night changes to new room type context');
    assert(rateRows.rows.every(row => Number(row.final_room_rate) === 100000), 'KEEP_CURRENT_RATE preserves money');
    const repriced = await createReservation(f, 'REPRICE', f.roomA1, f.typeA);
    await executeRoomMove(pool, repriced, { property_id: tracked.propertyId, to_room_id: f.roomB3, rate_plan_id: f.ratePlanB, reason_category: 'UPGRADE', reason_detail: 'Upgrade berbayar disetujui.', pricing_treatment: 'APPLY_NEW_RATE', idempotency_key: `${tag}-reprice` }, actor);
    const repriceCheck = await pool.query(`SELECT total_price,rate_plan_id FROM reservations WHERE id=$1`, [repriced]);
    assert.equal(Number(repriceCheck.rows[0].total_price), 250000); assert.equal(Number(repriceCheck.rows[0].rate_plan_id), f.ratePlanB);
    const occupied = await createReservation(f, 'OCCUPIED', f.roomA3, f.typeA);
    await assert.rejects(() => executeRoomMove(pool, occupied, { property_id: tracked.propertyId, to_room_id: f.roomA2, reason_category: 'OTHER', reason_detail: 'Tes konflik.', pricing_treatment: 'KEEP_CURRENT_RATE' }, actor), err => err.code === 'ROOM_OVERLAP' || err.code === 'OUTGOING_NOT_CHECKED_OUT');
    await assert.rejects(() => executeRoomMove(pool, occupied, { property_id: tracked.propertyId, to_room_id: f.roomB2, reason_category: 'OTHER', reason_detail: 'Tes OOO.', pricing_treatment: 'KEEP_CURRENT_RATE' }, actor), err => err.code === 'ROOM_OUT_OF_SERVICE');
    await assert.rejects(() => executeRoomMove(pool, occupied, { property_id: tracked.propertyId, to_room_id: f.roomB4, reason_category: 'OTHER', reason_detail: 'Tes blok operasional.', pricing_treatment: 'KEEP_CURRENT_RATE' }, actor), err => err.code === 'ROOM_OPERATIONALLY_BLOCKED');
    await assert.rejects(() => executeRoomMove(pool, occupied, { property_id: tracked.propertyId, to_room_id: f.roomB1, reason_category: 'OTHER', reason_detail: 'Tes blokir.', pricing_treatment: 'KEEP_CURRENT_RATE' }, actor), err => err.code === 'ROOM_NOT_READY' || err.code === 'OUTGOING_NOT_CHECKED_OUT');
    const booked = await createReservation(f, 'BOOKED', f.roomA4, f.typeA, 'BOOKED');
    await assert.rejects(() => executeRoomMove(pool, booked, { property_id: tracked.propertyId, to_room_id: f.roomA5, reason_category: 'OTHER', reason_detail: 'Tes status.', pricing_treatment: 'KEEP_CURRENT_RATE' }, actor), err => err.code === 'CHECKED_IN_RESERVATION_REQUIRED');
    for (const status of ['CHECKED_OUT', 'CANCELLED', 'NO_SHOW']) {
      const terminal = await createReservation(f, status.replace('_', ''), f.roomA6, f.typeA, status);
      await assert.rejects(() => executeRoomMove(pool, terminal, { property_id: tracked.propertyId, to_room_id: f.roomA5, reason_category: 'OTHER', reason_detail: 'Tes status terminal.', pricing_treatment: 'KEEP_CURRENT_RATE' }, actor), err => err.code === 'CHECKED_IN_RESERVATION_REQUIRED');
    }
    const otaReservation = await createReservation(f, 'OTA', f.roomA6, f.typeA, 'CHECKED_IN', f.otaSourceId);
    await assert.rejects(() => executeRoomMove(pool, otaReservation, { property_id: tracked.propertyId, to_room_id: f.roomA5, reason_category: 'UPGRADE', reason_detail: 'Tes tarif OTA.', pricing_treatment: 'APPLY_NEW_RATE' }, actor), err => err.code === 'OTA_MANUAL_RATE_PRESERVED');
    const duplicate = await createReservation(f, 'DUP', f.roomA1, f.typeA);
    const payload = { property_id: tracked.propertyId, to_room_id: f.roomA5, reason_category: 'OTHER', reason_detail: 'Tes duplikat.', pricing_treatment: 'KEEP_CURRENT_RATE', idempotency_key: `${tag}-duplicate` };
    await executeRoomMove(pool, duplicate, payload, actor);
    await executeRoomMove(pool, duplicate, payload, actor);
    const duplicateMoves = await pool.query('SELECT COUNT(*)::int AS count FROM reservation_room_moves WHERE reservation_id=$1', [duplicate]);
    assert.equal(Number(duplicateMoves.rows[0].count), 1, 'duplicate request creates one movement');
    const audit = await pool.query(`SELECT from_room_id,to_room_id,from_room_type_id,to_room_type_id,moved_by,moved_at,reason_category,reason_detail,pricing_treatment FROM reservation_room_moves WHERE reservation_id=$1`, [same]);
    assert.equal(audit.rowCount, 1); assert.equal(Number(audit.rows[0].from_room_id), f.roomA1); assert.equal(Number(audit.rows[0].to_room_id), f.roomA2); assert.equal(audit.rows[0].moved_by, 'FO Tester'); assert.equal(audit.rows[0].reason_category, 'GUEST_REQUEST');
    const history = await getRoomMoveHistory(pool, same, tracked.propertyId);
    assert.equal(history.length, 1, 'movement history remains queryable');
    console.log('PASS checked-in room-move audited workflow');
  } finally { await cleanup(); }
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => pool.end());
