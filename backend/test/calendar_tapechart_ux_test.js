const { Pool } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const assert = require('assert');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'oak_hotel_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function runCalendarTapeChartUxTests() {
  console.log('=== RUNNING CALENDAR TAPE CHART UX TESTS ===');
  const client = await pool.connect();
  const testPropertyId = 1;
  let testRoomId = null;
  let testBlockId = null;
  let testTaskId = null;
  let testFindingId = null;

  try {
    // 1. Create a dedicated isolated test room
    const roomRes = await client.query(`
      INSERT INTO rooms (
        property_id,
        room_number,
        room_type_id,
        status,
        is_active
      ) VALUES (
        $1, 'TEST-CAL-999', 1, 'CLEANING', true
      ) RETURNING id
    `, [testPropertyId]);
    testRoomId = roomRes.rows[0].id;

    // 2. Insert an active operational block [2026-09-01, 2026-09-05)
    const blockRes = await client.query(`
      INSERT INTO room_operational_blocks (
        property_id,
        room_id,
        room_type_id,
        block_type,
        start_date,
        end_date,
        reason,
        status
      ) VALUES (
        $1, $2, 1, 'OUT_OF_ORDER', '2026-09-01', '2026-09-05', 'AC overhaul test', 'ACTIVE'
      ) RETURNING id
    `, [testPropertyId, testRoomId]);
    testBlockId = blockRes.rows[0].id;

    // 3. Create a housekeeping task with a blocking finding
    const taskRes = await client.query(`
      INSERT INTO housekeeping_tasks (
        property_id,
        room_id,
        task_type,
        priority,
        status,
        created_at
      ) VALUES (
        $1, $2, 'DAILY_CLEAN', 'NORMAL', 'IN_PROGRESS', NOW()
      ) RETURNING id
    `, [testPropertyId, testRoomId]);
    testTaskId = taskRes.rows[0].id;

    // Find or insert a blocking finding type
    let findingTypeRes = await client.query(`
      SELECT id, code, label FROM housekeeping_finding_types WHERE block_room_ready = true LIMIT 1
    `);
    let findingTypeId;
    let findingTypeCode;
    let findingTypeLabel;
    if (findingTypeRes.rows.length > 0) {
      findingTypeId = findingTypeRes.rows[0].id;
      findingTypeCode = findingTypeRes.rows[0].code;
      findingTypeLabel = findingTypeRes.rows[0].label;
    } else {
      const newFt = await client.query(`
        INSERT INTO housekeeping_finding_types (property_id, code, label, category, default_severity, block_room_ready)
        VALUES (1, 'TEST_LEAK', 'Test Leakage', 'MAINTENANCE', 'MAJOR', true)
        RETURNING id, code, label
      `);
      findingTypeId = newFt.rows[0].id;
      findingTypeCode = newFt.rows[0].code;
      findingTypeLabel = newFt.rows[0].label;
    }

    const findingRes = await client.query(`
      INSERT INTO housekeeping_task_findings (
        property_id,
        task_id,
        finding_type_id,
        finding_type_code,
        finding_type_label,
        room_id,
        severity,
        status,
        notes
      ) VALUES (
        $1, $2, $3, $4, $5, $6, 'MAJOR', 'ACTIVE', 'Test pipe leak'
      ) RETURNING id
    `, [testPropertyId, testTaskId, findingTypeId, findingTypeCode, findingTypeLabel, testRoomId]);
    testFindingId = findingRes.rows[0].id;

    // 4. Test querying tapechart logic directly against DB
    const tapechartRoomsRes = await client.query(`
      SELECT r.id, r.room_number, r.status
      FROM rooms r
      WHERE r.id = $1
    `, [testRoomId]);
    assert.strictEqual(tapechartRoomsRes.rows.length, 1, 'Test room must exist');
    assert.strictEqual(tapechartRoomsRes.rows[0].status, 'CLEANING', 'Test room status is CLEANING');

    // 5. Test batch query of active operational blocks
    const startWindow = '2026-09-01';
    const endWindow = '2026-09-07';
    const blocksRes = await client.query(`
      SELECT
        rob.id,
        rob.room_id,
        rob.room_type_id,
        rob.block_type,
        rob.start_date::text,
        rob.end_date::text,
        rob.reason,
        rob.status
      FROM room_operational_blocks rob
      WHERE rob.property_id = $1
        AND rob.status = 'ACTIVE'
        AND rob.start_date < $3
        AND rob.end_date > $2
        AND rob.room_id = $4
    `, [testPropertyId, startWindow, endWindow, testRoomId]);

    assert.strictEqual(blocksRes.rows.length, 1, 'Active block must be fetched in window');
    assert.strictEqual(blocksRes.rows[0].block_type, 'OUT_OF_ORDER', 'Block type must match OUT_OF_ORDER');
    assert.strictEqual(blocksRes.rows[0].start_date, '2026-09-01', 'Start date matches');
    assert.strictEqual(blocksRes.rows[0].end_date, '2026-09-05', 'End date matches');

    // 6. Test batch query of active blocking findings
    const findingsRes = await client.query(`
      SELECT
        htf.id,
        htf.room_id,
        htf.task_id,
        htf.severity,
        htf.status,
        htf.notes,
        hft.label as finding_type_label,
        hft.block_room_ready
      FROM housekeeping_task_findings htf
      JOIN housekeeping_finding_types hft ON htf.finding_type_id = hft.id
      WHERE htf.room_id = $1
        AND htf.status = 'ACTIVE'
        AND hft.block_room_ready = true
    `, [testRoomId]);

    assert.strictEqual(findingsRes.rows.length, 1, 'Blocking finding must be fetched');
    assert.strictEqual(findingsRes.rows[0].block_room_ready, true, 'block_room_ready must be true');
    // 7. Test multi-night reservation span computation logic
    const testDays = [
      { date: '2026-08-27' },
      { date: '2026-08-28' },
      { date: '2026-08-29' },
      { date: '2026-08-30' },
      { date: '2026-08-31' },
      { date: '2026-09-01' },
      { date: '2026-09-02' }
    ];

    function calculateStaySpan(ci, co, days) {
      const firstVisible = days[0].date;
      const lastVisible = days[days.length - 1].date;
      // next day after last visible
      const d = new Date(lastVisible);
      d.setDate(d.getDate() + 1);
      const visibleRangeEnd = d.toISOString().slice(0, 10);

      if (co <= firstVisible || ci >= visibleRangeEnd) return null;

      const startIndex = days.findIndex(x => x.date === ci);
      const endIndex = days.findIndex(x => x.date === co);

      const visibleStart = startIndex === -1 && ci < firstVisible ? 0 : startIndex;
      const visibleEnd = endIndex === -1 && co >= visibleRangeEnd ? days.length : endIndex;

      if (visibleStart < 0 || visibleEnd < 0 || visibleEnd <= visibleStart) return null;
      return { startIndex: visibleStart, span: visibleEnd - visibleStart };
    }

    // Scenario A: Standard multi-night stay completely inside window [2026-08-29, 2026-09-02) -> 4 nights (indices 2,3,4,5)
    const spanA = calculateStaySpan('2026-08-29', '2026-09-02', testDays);
    assert.deepStrictEqual(spanA, { startIndex: 2, span: 4 }, 'Stay [29 Aug, 2 Sep) must span 4 days starting at index 2');

    // Scenario B: Left-clipped stay starting before window [2026-08-25, 2026-08-29) -> ends at index 2
    const spanB = calculateStaySpan('2026-08-25', '2026-08-29', testDays);
    assert.deepStrictEqual(spanB, { startIndex: 0, span: 2 }, 'Left-clipped stay must span from index 0 with length 2');

    // Scenario C: Right-clipped stay ending after window [2026-08-31, 2026-09-05) -> starts at index 4, spans to index 7
    const spanC = calculateStaySpan('2026-08-31', '2026-09-05', testDays);
    assert.deepStrictEqual(spanC, { startIndex: 4, span: 3 }, 'Right-clipped stay must span from index 4 to end of window (span 3)');

    // Scenario D: Operational block span [2026-09-01, 2026-09-05) -> starts at index 5, spans to index 7
    const spanD = calculateStaySpan('2026-09-01', '2026-09-05', testDays);
    assert.deepStrictEqual(spanD, { startIndex: 5, span: 2 }, 'Operational block [1 Sep, 5 Sep) spans indices 5 and 6 (span 2)');

    console.log('✔ Span calculations, boundary clipping, and multi-night spans passed successfully');

  } finally {
    // Zero residue cleanup
    if (testFindingId) {
      await client.query('DELETE FROM housekeeping_task_findings WHERE id = $1', [testFindingId]);
    }
    if (testTaskId) {
      await client.query('DELETE FROM housekeeping_tasks WHERE id = $1', [testTaskId]);
    }
    if (testBlockId) {
      await client.query('DELETE FROM room_operational_blocks WHERE id = $1', [testBlockId]);
    }
    if (testRoomId) {
      await client.query('DELETE FROM rooms WHERE id = $1', [testRoomId]);
    }
    client.release();
    console.log('✔ Test residue cleaned up cleanly');
  }
}

runCalendarTapeChartUxTests()
  .then(() => {
    console.log('ALL CALENDAR TAPE CHART UX TESTS PASSED!');
    process.exit(0);
  })
  .catch((err) => {
    console.error('CALENDAR TAPE CHART UX TEST FAILURE:', err);
    process.exit(1);
  });
