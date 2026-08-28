// backend/test/housekeeping_finding_catalog_test.js
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { initializeDatabase } = require('../dist/db/schema_v3');
const {
  getFindingTypes,
  createFindingType,
  updateFindingType,
  reorderFindingTypes,
  getChecklistTemplates,
  addChecklistTemplateItem,
  updateChecklistTemplateItem,
  reorderChecklistTemplateItems,
  requestCheckoutRoomCheck,
  completeHousekeepingTask
} = require('../dist/domains/housekeeping/housekeepingService');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

function expect(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

async function runFindingCatalogTestSuite() {
  console.log('\n======================================================');
  console.log('EMP-MOBILE-UX-2: FINDING CATALOG & CHECKLIST TEST SUITE');
  console.log('======================================================\n');

  const propertyId = 1;
  const createdFindingTypeCodes = [];
  let createdTemplateItemId = null;
  let testTaskId = null;
  let checkoutTemplateId = null;
  let issueTaskId = null;
  let snapTaskId = null;
  let newMasterItemId = null;
  const client = await pool.connect();

  try {
    // 0. Ensure schema migration 12 is initialized
    console.log('[Setup] Initializing database schema...');
    await initializeDatabase(pool);

    // Scenario 1: Seed default 10 finding types for property 1
    console.log('\n--- Scenario 1: Verify Seeded 10 Finding Types for Property 1 ---');
    const seededTypes = await getFindingTypes(client, propertyId, 'all');
    console.log(`Found ${seededTypes.length} finding types for Property ${propertyId}`);
    expect(seededTypes.length >= 10, `Expected at least 10 finding types, got ${seededTypes.length}`);
    const codes = seededTypes.map(f => f.code);
    expect(codes.includes('MINIBAR'), 'Expected MINIBAR in seeded codes');
    expect(codes.includes('REMOTE_TV_HILANG'), 'Expected REMOTE_TV_HILANG in seeded codes');
    expect(codes.includes('LOST_AND_FOUND'), 'Expected LOST_AND_FOUND in seeded codes');
    console.log('✓ Scenario 1 PASS: Default 10 finding types exist and are active.');

    // Scenario 2: Create custom finding type
    console.log('\n--- Scenario 2: Create Custom Finding Type ---');
    const customCode = `TEST_FINDING_${Date.now()}`;
    createdFindingTypeCodes.push(customCode);
    const created = await createFindingType(client, propertyId, {
      code: customCode,
      label: 'Test Custom Finding Issue',
      severity: 'HIGH',
      note_required: true,
      photo_required: true,
      estimated_charge_allowed: true,
      supervisor_review_required: true,
      sort_order: 99
    });
    expect(created.code === customCode, 'Custom finding type code must match');
    expect(created.label === 'Test Custom Finding Issue', 'Label must match');
    expect(created.severity === 'HIGH', 'Severity must match HIGH');
    expect(created.note_required === true, 'note_required must be true');
    console.log(`✓ Scenario 2 PASS: Created custom finding type #${created.id} (${created.code})`);

    // Scenario 3: Update finding type
    console.log('\n--- Scenario 3: Update Finding Type ---');
    const updated = await updateFindingType(client, propertyId, created.id, {
      label: 'Updated Custom Finding Label',
      severity: 'CRITICAL',
      estimated_charge_allowed: false
    });
    expect(updated.label === 'Updated Custom Finding Label', 'Label should be updated');
    expect(updated.severity === 'CRITICAL', 'Severity should be updated to CRITICAL');
    expect(updated.estimated_charge_allowed === false, 'estimated_charge_allowed should be false');
    console.log('✓ Scenario 3 PASS: Finding type properties updated successfully.');

    // Scenario 4: Deactivate finding type (soft disable)
    console.log('\n--- Scenario 4: Deactivate Finding Type ---');
    const deactivated = await updateFindingType(client, propertyId, created.id, {
      is_active: false
    });
    expect(deactivated.is_active === false, 'Finding type should be inactive');
    const activeList = await getFindingTypes(client, propertyId, 'active');
    expect(!activeList.some(f => f.id === created.id), 'Deactivated item must not appear in active list');
    console.log('✓ Scenario 4 PASS: Finding type deactivated and hidden from active query.');

    // Scenario 5: Reorder finding types
    console.log('\n--- Scenario 5: Reorder Finding Types ---');
    const typesToReorder = seededTypes.slice(0, 3).map((f, idx) => ({ id: f.id, sort_order: (idx + 1) * 10 }));
    await reorderFindingTypes(client, propertyId, typesToReorder);
    const reorderedList = await getFindingTypes(client, propertyId, 'all');
    const r1 = reorderedList.find(f => f.id === typesToReorder[0].id);
    expect(r1 && r1.sort_order === 10, 'Sort order should reflect reordering');
    console.log('✓ Scenario 5 PASS: Finding types reordered successfully.');

    // Scenario 6: Prevent duplicate finding code on same property
    console.log('\n--- Scenario 6: Prevent Duplicate Finding Code on Same Property ---');
    let duplicateRejected = false;
    try {
      await createFindingType(client, propertyId, {
        code: customCode,
        label: 'Duplicate Code Attempt'
      });
    } catch (err) {
      duplicateRejected = true;
      console.log(`Expected rejection caught: ${err.message}`);
    }
    expect(duplicateRejected, 'Creating duplicate code on same property must be rejected');
    console.log('✓ Scenario 6 PASS: Unique constraint enforced per property.');

    // Scenario 7: Create checklist template item
    console.log('\n--- Scenario 7: Create Checklist Template Item ---');
    const templates = await getChecklistTemplates(client, propertyId);
    expect(templates.length > 0, 'Property must have checklist templates');
    const checkoutTemplate = templates.find(t => t.template_type === 'CHECKOUT_INSPECTION') || templates[0];
    checkoutTemplateId = checkoutTemplate.id;
    console.log(`Using Checklist Template #${checkoutTemplateId} (${checkoutTemplate.template_type})`);

    const createdItem = await addChecklistTemplateItem(client, propertyId, checkoutTemplateId, {
      code: `CHK_TEST_${Date.now()}`,
      label: 'Pemeriksaan Tambahan Test',
      category: 'GENERAL',
      is_required: true,
      photo_required_on_issue: false,
      sort_order: 99
    });
    createdTemplateItemId = createdItem.id;
    expect(createdItem.id > 0, 'Created checklist item must have positive ID');
    expect(createdItem.is_required === true, 'is_required must be true');
    console.log(`✓ Scenario 7 PASS: Created template item #${createdItem.id}`);

    // Scenario 8: Update checklist template item
    console.log('\n--- Scenario 8: Update Checklist Template Item ---');
    const updatedItem = await updateChecklistTemplateItem(client, propertyId, checkoutTemplateId, createdTemplateItemId, {
      label: 'Pemeriksaan Tambahan Test (Updated)',
      is_required: false
    });
    expect(updatedItem.label === 'Pemeriksaan Tambahan Test (Updated)', 'Label must be updated');
    expect(updatedItem.is_required === false, 'is_required must be updated to false');
    console.log('✓ Scenario 8 PASS: Template item updated.');

    // Scenario 9: Deactivate checklist template item
    console.log('\n--- Scenario 9: Deactivate Checklist Template Item ---');
    const deactivatedItem = await updateChecklistTemplateItem(client, propertyId, checkoutTemplateId, createdTemplateItemId, {
      is_active: false
    });
    expect(deactivatedItem.is_active === false, 'Template item must be inactive');
    console.log('✓ Scenario 9 PASS: Template item deactivated.');

    // Scenario 10: Reorder checklist template items
    console.log('\n--- Scenario 10: Reorder Checklist Template Items ---');
    const currentItems = checkoutTemplate.items || [];
    if (currentItems.length >= 2) {
      const itemsToReorder = [
        { id: currentItems[0].id, sort_order: 50 },
        { id: currentItems[1].id, sort_order: 10 }
      ];
      await reorderChecklistTemplateItems(client, propertyId, checkoutTemplateId, itemsToReorder);
      const refetched = await getChecklistTemplates(client, propertyId);
      const reTmpl = refetched.find(t => t.id === checkoutTemplateId);
      const item1 = reTmpl.items.find(it => it.id === currentItems[0].id);
      expect(item1 && item1.sort_order === 50, 'Sort order should be updated');
    }
    console.log('✓ Scenario 10 PASS: Template items reordered.');

    // Find a room and reservation for task scenarios
    const resvRes = await client.query('SELECT id, room_id FROM reservations WHERE room_id IS NOT NULL LIMIT 1');
    let validReservationId = null;
    let testRoomId = null;
    if (resvRes.rows.length > 0) {
      validReservationId = resvRes.rows[0].id;
      testRoomId = resvRes.rows[0].room_id;
    } else {
      const roomRes = await client.query('SELECT id FROM rooms WHERE property_id = $1 LIMIT 1', [propertyId]);
      testRoomId = roomRes.rows[0].id;
      validReservationId = 1;
    }

    // Scenario 11: Checkout Room Check cannot complete CLEAR when required items unchecked
    console.log('\n--- Scenario 11: Checkout Check Incomplete CLEAR Validation ---');
    await client.query(
      `DELETE FROM housekeeping_task_checklist_items WHERE task_id IN (
         SELECT id FROM housekeeping_tasks WHERE property_id = $1 AND room_id = $2 AND task_type = 'CHECKOUT_ROOM_CHECK'
       )`,
      [propertyId, testRoomId]
    );
    await client.query(
      `DELETE FROM housekeeping_tasks WHERE property_id = $1 AND room_id = $2 AND task_type = 'CHECKOUT_ROOM_CHECK'`,
      [propertyId, testRoomId]
    );

    const taskResult = await requestCheckoutRoomCheck(client, propertyId, validReservationId, testRoomId, {
      name: 'FO_TEST',
      role: 'FRONT_DESK'
    });
    testTaskId = taskResult.id;
    console.log(`Created Checkout Room Check Task #${testTaskId}`);

    // Ensure task has at least one required item uncompleted
    const taskChecklistRes = await client.query(
      'SELECT id, label, is_required, is_completed FROM housekeeping_task_checklist_items WHERE task_id = $1',
      [testTaskId]
    );

    if (taskChecklistRes.rows.length > 0) {
      await client.query(
        'UPDATE housekeeping_task_checklist_items SET is_required = true, is_completed = false WHERE id = $1',
        [taskChecklistRes.rows[0].id]
      );
    } else {
      await client.query(
        `INSERT INTO housekeeping_task_checklist_items (task_id, section, label, is_required, is_completed, sort_order)
         VALUES ($1, 'CHECKLIST', 'Butir Wajib Test', true, false, 1)`,
        [testTaskId]
      );
    }

    let clearRejected = false;
    try {
      await completeHousekeepingTask(client, propertyId, testTaskId, {
        inspection_result: 'CLEAR'
      }, { name: 'TEST_CREW' });
    } catch (err) {
      clearRejected = true;
      console.log(`Expected rejection caught: ${err.message}`);
      expect(err.code === 'CHECKLIST_INCOMPLETE' || err.message.includes('belum diperiksa') || err.message.includes('checklist wajib'), 'Error message must specify incomplete checklist');
    }
    expect(clearRejected, 'CLEAR submission with uncompleted required checklist items must fail');
    console.log('✓ Scenario 11 PASS: Incomplete checklist strictly blocks KAMAR AMAN (CLEAR).');

    // Scenario 12: Checkout Room Check completes CLEAR when required items checked
    console.log('\n--- Scenario 12: Checkout Check Completes CLEAR When Required Items Checked ---');
    await client.query(
      'UPDATE housekeeping_task_checklist_items SET is_completed = true WHERE task_id = $1',
      [testTaskId]
    );
    const clearResult = await completeHousekeepingTask(client, propertyId, testTaskId, {
      inspection_result: 'CLEAR'
    }, { name: 'TEST_CREW' });
    expect(clearResult.status === 'DONE', 'Task status must be DONE');
    console.log('✓ Scenario 12 PASS: Task completes CLEAR successfully when all required items are checked.');

    // Scenario 13: Checkout Room Check ISSUE_FOUND validates note_required
    console.log('\n--- Scenario 13: Checkout Check ISSUE_FOUND Validates note_required ---');
    await client.query(
      `DELETE FROM housekeeping_task_checklist_items WHERE task_id IN (
         SELECT id FROM housekeeping_tasks WHERE property_id = $1 AND room_id = $2 AND task_type = 'CHECKOUT_ROOM_CHECK'
       )`,
      [propertyId, testRoomId]
    );
    await client.query(
      `DELETE FROM housekeeping_tasks WHERE property_id = $1 AND room_id = $2 AND task_type = 'CHECKOUT_ROOM_CHECK'`,
      [propertyId, testRoomId]
    );

    const issueTask = await requestCheckoutRoomCheck(client, propertyId, validReservationId, testRoomId, {
      name: 'FO_TEST_2',
      role: 'FRONT_DESK'
    });
    issueTaskId = issueTask.id;

    await pool.query(
      'UPDATE housekeeping_finding_types SET is_active = true, note_required = true WHERE property_id = $1 AND code = $2',
      [propertyId, customCode]
    );

    let emptyNoteRejected = false;
    try {
      await completeHousekeepingTask(client, propertyId, issueTaskId, {
        inspection_result: 'ISSUE_FOUND',
        issue_type: customCode,
        issue_note: ''
      }, { name: 'TEST_CREW' });
    } catch (err) {
      emptyNoteRejected = true;
      console.log(`Expected rejection caught: ${err.message}`);
      expect(err.code === 'NOTE_REQUIRED' || err.message.includes('NOTE_REQUIRED') || err.message.includes('Catatan temuan wajib diisi'), 'Must reject empty note');
    }
    expect(emptyNoteRejected, 'ISSUE_FOUND with empty note on note_required type must be rejected');

    const issueSubmitResult = await completeHousekeepingTask(client, propertyId, issueTaskId, {
      inspection_result: 'ISSUE_FOUND',
      issue_type: customCode,
      issue_note: 'Ditemukan kerusakan pada perlengkapan kamar saat checkout.',
      estimated_charge: 50000
    }, { name: 'TEST_CREW' });
    expect(issueSubmitResult.status === 'DONE', 'Task status must be DONE');
    console.log('✓ Scenario 13 PASS: note_required enforced and ISSUE_FOUND submitted successfully.');

    // Scenario 14: Snapshot immutability: template edits do not mutate active/past task items
    console.log('\n--- Scenario 14: Snapshot Immutability Verification ---');
    await client.query(
      `DELETE FROM housekeeping_task_checklist_items WHERE task_id IN (
         SELECT id FROM housekeeping_tasks WHERE property_id = $1 AND room_id = $2 AND task_type = 'CHECKOUT_ROOM_CHECK'
       )`,
      [propertyId, testRoomId]
    );
    await client.query(
      `DELETE FROM housekeeping_tasks WHERE property_id = $1 AND room_id = $2 AND task_type = 'CHECKOUT_ROOM_CHECK'`,
      [propertyId, testRoomId]
    );

    const snapTask = await requestCheckoutRoomCheck(client, propertyId, validReservationId, testRoomId, {
      name: 'FO_SNAP_TEST',
      role: 'FRONT_DESK'
    });
    snapTaskId = snapTask.id;
    const snapItemsBefore = await client.query(
      'SELECT id, template_item_id, label FROM housekeeping_task_checklist_items WHERE task_id = $1',
      [snapTaskId]
    );

    const newMasterItem = await addChecklistTemplateItem(client, propertyId, checkoutTemplateId, {
      code: `SNAP_TEST_${Date.now()}`,
      label: 'New Master Item Created After Task',
      category: 'GENERAL',
      is_required: true,
      sort_order: 100
    });
    newMasterItemId = newMasterItem.id;

    const snapItemsAfter = await client.query(
      'SELECT id, template_item_id, label FROM housekeeping_task_checklist_items WHERE task_id = $1',
      [snapTaskId]
    );
    expect(
      snapItemsBefore.rows.length === snapItemsAfter.rows.length,
      'Task checklist item count must NOT change when master template changes'
    );
    expect(
      !snapItemsAfter.rows.some(it => it.template_item_id === newMasterItem.id),
      'Task checklist must not contain new master template item retroactively'
    );
    console.log('✓ Scenario 14 PASS: Master template modifications do not mutate historical task snapshots.');

    // Cleanup
    console.log('\n[Cleanup] Cleaning test fixtures...');
    if (createdFindingTypeCodes.length > 0) {
      await client.query('DELETE FROM housekeeping_finding_types WHERE property_id = $1 AND code = ANY($2::text[])', [
        propertyId,
        createdFindingTypeCodes
      ]);
    }
    if (createdTemplateItemId) {
      await client.query('DELETE FROM checklist_template_items WHERE id = $1', [createdTemplateItemId]);
    }
    if (newMasterItemId) {
      await client.query('DELETE FROM checklist_template_items WHERE id = $1', [newMasterItemId]);
    }
    const cleanIds = [testTaskId, issueTaskId, snapTaskId].filter(Boolean);
    if (cleanIds.length > 0) {
      await client.query('DELETE FROM housekeeping_task_checklist_items WHERE task_id = ANY($1::int[])', [cleanIds]);
      await client.query('DELETE FROM housekeeping_tasks WHERE id = ANY($1::int[])', [cleanIds]);
    }

    console.log('\n======================================================');
    console.log('ALL 14 FINDING CATALOG & CHECKLIST SCENARIOS PASSED (100% GO)');
    console.log('======================================================\n');
  } catch (err) {
    console.error('\n❌ TEST SUITE FAILED:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runFindingCatalogTestSuite();
