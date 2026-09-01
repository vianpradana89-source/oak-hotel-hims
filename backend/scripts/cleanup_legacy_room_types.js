const { Pool } = require('pg');

const CANONICAL_ROOM_TYPE_IDS = [1, 2, 3, 4, 5, 22, 23, 51, 52];

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db',
});

async function runCleanup() {
  const client = await pool.connect();
  try {
    console.log('=== STARTING CLEANUP OF LEGACY / DEACTIVATED ROOM TYPES ===');
    console.log('Canonical Protected Room Type IDs:', CANONICAL_ROOM_TYPE_IDS.join(', '));

    await client.query('BEGIN');

    // 1. Audit rows to be removed
    const legacyTypesRes = await client.query(`
      SELECT id, name, code, is_active
      FROM room_types
      WHERE id NOT IN (${CANONICAL_ROOM_TYPE_IDS.join(',')})
    `);
    console.log(`Found ${legacyTypesRes.rowCount} legacy/non-canonical room types:`);
    console.table(legacyTypesRes.rows);

    const legacyTypeIds = legacyTypesRes.rows.map(r => r.id);

    // 2. Delete availability_dates for non-canonical room types or NULL room_type_id
    const deleteAvailRes = await client.query(`
      DELETE FROM availability_dates
      WHERE room_type_id NOT IN (${CANONICAL_ROOM_TYPE_IDS.join(',')})
         OR room_type_id IS NULL
    `);
    console.log(`[CLEANED] Deleted ${deleteAvailRes.rowCount} availability_dates rows for legacy room types.`);

    // 3. Delete availability_locks for non-canonical room types
    const deleteLocksRes = await client.query(`
      DELETE FROM availability_locks
      WHERE room_type_id NOT IN (${CANONICAL_ROOM_TYPE_IDS.join(',')})
         OR room_type_id IS NULL
    `);
    console.log(`[CLEANED] Deleted ${deleteLocksRes.rowCount} availability_locks rows for legacy room types.`);

    // 4. Delete rate_plans & rate_overrides for legacy room types if any
    if (legacyTypeIds.length > 0) {
      const deleteOverridesRes = await client.query(`
        DELETE FROM rate_overrides
        WHERE rate_plan_id IN (
          SELECT id FROM rate_plans WHERE room_type_id IN (${legacyTypeIds.join(',')})
        )
      `);
      console.log(`[CLEANED] Deleted ${deleteOverridesRes.rowCount} rate_overrides rows.`);

      const deleteRatePlansRes = await client.query(`
        DELETE FROM rate_plans
        WHERE room_type_id IN (${legacyTypeIds.join(',')})
      `);
      console.log(`[CLEANED] Deleted ${deleteRatePlansRes.rowCount} rate_plans rows.`);
    }

    // 5. Clean up test/legacy reservations & rooms on legacy room types if any
    if (legacyTypeIds.length > 0) {
      const legacyRoomsRes = await client.query(`
        SELECT id FROM rooms WHERE room_type_id IN (${legacyTypeIds.join(',')})
      `);
      const legacyRoomIds = legacyRoomsRes.rows.map(r => r.id);

      if (legacyRoomIds.length > 0) {
        // Find any reservations on these rooms
        const legacyRes = await client.query(`
          SELECT id, booking_id FROM reservations WHERE room_id IN (${legacyRoomIds.join(',')})
        `);
        const resIds = legacyRes.rows.map(r => r.id);
        const bookingIds = [...new Set(legacyRes.rows.map(r => r.booking_id).filter(Boolean))];

        if (resIds.length > 0) {
          await client.query(`DELETE FROM pos_orders WHERE reservation_id IN (${resIds.join(',')})`);
          await client.query(`DELETE FROM housekeeping_task_findings WHERE reservation_id IN (${resIds.join(',')})`);
          await client.query(`DELETE FROM housekeeping_tasks WHERE reservation_id IN (${resIds.join(',')})`);
          await client.query(`DELETE FROM guest_receivables WHERE reservation_id IN (${resIds.join(',')})`);
          await client.query(`DELETE FROM payment_evidences WHERE reservation_id IN (${resIds.join(',')})`);
          await client.query(`DELETE FROM payment_transactions WHERE reservation_id IN (${resIds.join(',')})`);
          await client.query(`DELETE FROM transactions WHERE reservation_id IN (${resIds.join(',')})`);
          await client.query(`DELETE FROM folio_entries WHERE reservation_id IN (${resIds.join(',')})`);
          await client.query(`DELETE FROM reservation_nightly_rates WHERE reservation_id IN (${resIds.join(',')})`);
          await client.query(`DELETE FROM reservation_guests WHERE reservation_id IN (${resIds.join(',')})`);
          await client.query(`DELETE FROM reservations WHERE id IN (${resIds.join(',')})`);
          console.log(`[CLEANED] Deleted ${resIds.length} test reservations on legacy rooms.`);
        }

        if (bookingIds.length > 0) {
          const bParam = bookingIds.map(b => `'${b}'`).join(',');
          await client.query(`DELETE FROM transactions WHERE booking_id IN (${bParam})`);
          await client.query(`DELETE FROM bookings WHERE bid IN (${bParam}) OR id::text IN (${bParam})`);
          console.log(`[CLEANED] Deleted ${bookingIds.length} test bookings on legacy rooms.`);
        }

        // Clean up housekeeping / operational blocks on legacy rooms
        await client.query(`DELETE FROM housekeeping_task_findings WHERE room_id IN (${legacyRoomIds.join(',')})`);
        await client.query(`DELETE FROM housekeeping_tasks WHERE room_id IN (${legacyRoomIds.join(',')})`);
        await client.query(`DELETE FROM room_operational_blocks WHERE room_id IN (${legacyRoomIds.join(',')})`);

        // Delete legacy physical rooms
        const deleteRoomsRes = await client.query(`
          DELETE FROM rooms WHERE id IN (${legacyRoomIds.join(',')})
        `);
        console.log(`[CLEANED] Deleted ${deleteRoomsRes.rowCount} physical rooms belonging to legacy room types.`);
      }

      // Clean up room operational blocks & nightly rates referencing legacy room types
      await client.query(`DELETE FROM room_operational_blocks WHERE room_type_id IN (${legacyTypeIds.join(',')})`);
      await client.query(`DELETE FROM reservation_nightly_rates WHERE room_type_id IN (${legacyTypeIds.join(',')})`);

      // Delete the legacy room_types records
      const deleteTypesRes = await client.query(`
        DELETE FROM room_types WHERE id IN (${legacyTypeIds.join(',')})
      `);
      console.log(`[CLEANED] Deleted ${deleteTypesRes.rowCount} legacy room_types rows.`);
    }

    await client.query('COMMIT');
    console.log('=== TRANSACTION COMMITTED SUCCESSFULLY ===');

    // Invariant Verification
    console.log('\n=== VERIFYING INVARIANTS ON 9 ACTIVE ROOM TYPES ===');
    const remainingTypes = await client.query(`
      SELECT rt.id, rt.name, rt.code,
             (SELECT COUNT(*) FROM rooms r WHERE r.room_type_id = rt.id) as physical_rooms,
             (SELECT COUNT(*) FROM availability_dates ad WHERE ad.room_type_id = rt.id) as availability_days,
             (SELECT COUNT(*) FROM reservations res WHERE res.room_id IN (SELECT id FROM rooms r2 WHERE r2.room_type_id = rt.id)) as active_reservations
      FROM room_types rt
      ORDER BY rt.id ASC
    `);
    console.table(remainingTypes.rows);

    const totalRooms = remainingTypes.rows.reduce((acc, r) => acc + parseInt(r.physical_rooms), 0);
    console.log(`Total Active Room Types: ${remainingTypes.rowCount} (Expected: 9)`);
    console.log(`Total Physical Rooms: ${totalRooms} (Expected: 23)`);

    // Invariant check: reserved_qty < 0 or reserved_qty > total_rooms
    const invalidQty = await client.query(`
      SELECT COUNT(*) as invalid_count
      FROM availability_dates
      WHERE reserved_qty < 0 OR reserved_qty > total_rooms
    `);
    console.log(`Invalid reserved_qty count: ${invalidQty.rows[0].invalid_count} (Must be 0)`);

    if (remainingTypes.rowCount === 9 && totalRooms === 23 && parseInt(invalidQty.rows[0].invalid_count) === 0) {
      console.log('\n>>> ALL INVARIANTS PASSED! Database is lean, clean, and 100% verified. <<<');
    } else {
      console.warn('\n>>> WARNING: Invariants check mismatch. Please review output. <<<');
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR during cleanup (rolled back):', err);
  } finally {
    client.release();
    await pool.end();
  }
}

runCleanup();
