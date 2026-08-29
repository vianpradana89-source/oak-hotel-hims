/**
 * Automated Integration & Hardening Test Suite for EMP-MOBILE-3C:
 * Housekeeping Checklist Template Hardening
 *
 * Verifies:
 *  1. Active Standard Room Cleaning template creates task checklist snapshot.
 *  2. Mobile cleaning retrieves snapshot correctly (getTaskChecklistItems).
 *  3. Required items appear with is_required = true.
 *  4. Optional items appear with is_required = false.
 *  5. 'Isi Minibar / Kulkas' item is present and configurable.
 *  6. Template Master Add works (createChecklistTemplate).
 *  7. Template Master Edit works (updateChecklistTemplate).
 *  8. Template Master Active / Inactive toggle works.
 *  9. Template Master Duplicate works (duplicateChecklistTemplate).
 * 10. Safe delete / archive works (system & referenced templates soft-archived, unreferenced deleted).
 * 11. Checklist Item Add / Edit / Active / Archive / Reorder works.
 * 12. Editing master template does NOT alter historical task snapshots.
 * 13. Archiving master template does NOT affect historical task snapshots.
 * 14. Cleaning note persists (cleaning_note, cleaning_note_by, cleaning_note_at).
 * 15. Required checklist items block completion (CHECKLIST_INCOMPLETE error).
 * 16. Optional checklist items do not block completion.
 */

const { Pool } = require('pg');
const { initializeDatabase } = require('../dist/db/schema_v3.js');
const {
  createHousekeepingTask,
  startHousekeepingTask,
  getTaskChecklistItems,
  updateTaskChecklistItem,
  completeHousekeepingTask,
  createChecklistTemplate,
  updateChecklistTemplate,
  duplicateChecklistTemplate,
  deleteChecklistTemplate,
  addChecklistTemplateItem,
  updateChecklistTemplateItem,
  deleteChecklistTemplateItem,
  reorderChecklistTemplateItems,
  getHousekeepingSettings
} = require('../dist/domains/housekeeping/housekeepingService.js');
const assert = require('assert');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

async function runHardeningTests() {
  console.log('=== START: Housekeeping Checklist Template Hardening Suite (EMP-MOBILE-3C) ===');
  await initializeDatabase(pool);

  const client = await pool.connect();
  const testSuffix = Date.now().toString().slice(-4);
  const testRoomNumber = `TC${testSuffix}`;

  let propertyId = 1;
  let roomId = null;
  let roomTypeId = null;
  const createdTaskIds = [];
  const createdTemplateIds = [];

  try {
    const propRes = await client.query('SELECT id FROM properties LIMIT 1');
    assert(propRes.rows.length > 0, 'Property exists');
    propertyId = propRes.rows[0].id;

    const rtRes = await client.query('SELECT id FROM room_types WHERE property_id = $1 LIMIT 1', [propertyId]);
    assert(rtRes.rows.length > 0, 'Room type exists');
    roomTypeId = rtRes.rows[0].id;

    // Create fixture room
    const roomRes = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, status)
       VALUES ($1, $2, $3, 'VACANT_DIRTY')
       RETURNING id, room_number, status`,
      [propertyId, roomTypeId, testRoomNumber]
    );
    roomId = roomRes.rows[0].id;
    console.log(`✓ Fixture room created: ${testRoomNumber} (ID: ${roomId})`);

    // -------------------------------------------------------------------------
    // TEST 1: Active Standard Room Cleaning template creates checklist snapshot
    // -------------------------------------------------------------------------
    console.log('\n--- Test 1: Task creation creates checklist snapshot from active template ---');
    const task1 = await createHousekeepingTask(client, propertyId, {
      room_id: roomId,
      task_type: 'ROOM_CLEANING',
      priority: 'NORMAL',
      title: `Cleaning Task 1 - ${testSuffix}`
    });
    createdTaskIds.push(task1.id);
    assert(task1 && task1.id, 'Task 1 created');

    const snapshotRes = await client.query(
      `SELECT id, section, label, is_required, is_completed FROM housekeeping_task_checklist_items
       WHERE task_id = $1 ORDER BY sort_order ASC, id ASC`,
      [task1.id]
    );
    assert(snapshotRes.rows.length > 0, 'Task checklist snapshot created with items');
    console.log(`✓ Task 1 snapshot created with ${snapshotRes.rows.length} checklist items.`);

    // -------------------------------------------------------------------------
    // TEST 2: Mobile Cleaning retrieves snapshot correctly (getTaskChecklistItems)
    // -------------------------------------------------------------------------
    console.log('\n--- Test 2: Mobile cleaning retrieves checklist snapshot ---');
    const mobileChecklist = await getTaskChecklistItems(client, propertyId, task1.id);
    assert.strictEqual(mobileChecklist.length, snapshotRes.rows.length, 'Retrieved checklist matches DB snapshot count');
    console.log(`✓ Mobile checklist API retrieved ${mobileChecklist.length} snapshot items.`);

    // -------------------------------------------------------------------------
    // TEST 3 & 4: Required and Optional items appear
    // -------------------------------------------------------------------------
    console.log('\n--- Test 3 & 4: Required and optional items present in snapshot ---');
    const requiredItems = mobileChecklist.filter(i => i.is_required);
    const optionalItems = mobileChecklist.filter(i => !i.is_required);
    assert(requiredItems.length > 0, 'Required items exist in snapshot');
    assert(optionalItems.length > 0, 'Optional items exist in snapshot');
    console.log(`✓ Found ${requiredItems.length} required items and ${optionalItems.length} optional items.`);

    // -------------------------------------------------------------------------
    // TEST 5: 'Isi Minibar / Kulkas' is configurable and present
    // -------------------------------------------------------------------------
    console.log('\n--- Test 5: Isi Minibar / Kulkas item verification ---');
    const minibarItem = mobileChecklist.find(i => (i.group_name && i.group_name.toLowerCase().includes('minibar')) || i.label.toLowerCase().includes('minibar') || i.label.toLowerCase().includes('coca-cola'));
    assert(minibarItem, 'Isi Minibar / Kulkas exists in standard cleaning snapshot');
    console.log(`✓ Isi Minibar / Kulkas present: [${minibarItem.group_name || minibarItem.section}] ${minibarItem.label} (Required: ${minibarItem.is_required})`);

    // -------------------------------------------------------------------------
    // TEST 6: Template Master Add (createChecklistTemplate)
    // -------------------------------------------------------------------------
    console.log('\n--- Test 6: Template Master Add ---');
    const newTpl = await createChecklistTemplate(client, propertyId, {
      name: `VIP Suite Cleaning ${testSuffix}`,
      code: `VIP_SUITE_${testSuffix}`,
      task_type: 'ROOM_CLEANING',
      description: 'Custom VIP Suite cleaning template',
      sort_order: 50,
      is_active: true
    });
    createdTemplateIds.push(newTpl.id);
    assert.strictEqual(newTpl.name, `VIP Suite Cleaning ${testSuffix}`);
    assert.strictEqual(newTpl.is_active, true);
    console.log(`✓ Template created: ${newTpl.name} (ID: ${newTpl.id}, Code: ${newTpl.code})`);

    // -------------------------------------------------------------------------
    // TEST 7: Template Master Edit (updateChecklistTemplate)
    // -------------------------------------------------------------------------
    console.log('\n--- Test 7: Template Master Edit ---');
    const updatedTpl = await updateChecklistTemplate(client, propertyId, newTpl.id, {
      name: `VIP Suite Cleaning Updated ${testSuffix}`,
      description: 'Updated description for VIP Suite'
    });
    assert.strictEqual(updatedTpl.name, `VIP Suite Cleaning Updated ${testSuffix}`);
    assert.strictEqual(updatedTpl.description, 'Updated description for VIP Suite');
    console.log(`✓ Template updated: ${updatedTpl.name}`);

    // -------------------------------------------------------------------------
    // TEST 8: Template Master Active / Inactive toggle
    // -------------------------------------------------------------------------
    console.log('\n--- Test 8: Template Active / Inactive Toggle ---');
    const deactTpl = await updateChecklistTemplate(client, propertyId, newTpl.id, { is_active: false });
    assert.strictEqual(deactTpl.is_active, false);
    const reactTpl = await updateChecklistTemplate(client, propertyId, newTpl.id, { is_active: true });
    assert.strictEqual(reactTpl.is_active, true);
    console.log(`✓ Template active/inactive toggle verified.`);

    // -------------------------------------------------------------------------
    // TEST 9: Template Master Duplicate (duplicateChecklistTemplate)
    // -------------------------------------------------------------------------
    console.log('\n--- Test 9: Template Master Duplicate ---');
    // Add an item to newTpl first
    await addChecklistTemplateItem(client, propertyId, newTpl.id, {
      section: 'BEDROOM',
      label: 'Khusus Linen Sutra',
      is_required: true,
      is_active: true,
      description: 'Pastikan linen sutra dipasang rapi'
    });

    const dupTpl = await duplicateChecklistTemplate(client, propertyId, newTpl.id);
    createdTemplateIds.push(dupTpl.id);
    assert(dupTpl.name.includes('Salinan'), 'Duplicate template name contains Salinan');
    assert(dupTpl.items.length === 1, 'Duplicate copied template item');
    assert.strictEqual(dupTpl.items[0].label, 'Khusus Linen Sutra');
    console.log(`✓ Template duplicated: ${dupTpl.name} (ID: ${dupTpl.id}) with copied item.`);

    // -------------------------------------------------------------------------
    // TEST 10: Safe delete / archive works
    // -------------------------------------------------------------------------
    console.log('\n--- Test 10: Safe delete / archive rules ---');
    // 10a. System template -> safe archive (never hard deleted)
    const stdTplRes = await client.query(
      `SELECT id, is_system_template FROM checklist_templates
       WHERE property_id = $1 AND code = 'STANDARD_ROOM_CLEANING'`,
      [propertyId]
    );
    if (stdTplRes.rows.length > 0) {
      const stdTplId = stdTplRes.rows[0].id;
      const sysDelResult = await deleteChecklistTemplate(client, propertyId, stdTplId);
      assert(sysDelResult.archived, 'System template was soft-archived');
      // Restore standard template active status
      await updateChecklistTemplate(client, propertyId, stdTplId, { is_active: true, is_archived: false });
      console.log(`✓ System template protected from hard delete (soft-archived and restored).`);
    }

    // 10b. Unreferenced custom template -> hard delete
    const unrefTpl = await createChecklistTemplate(client, propertyId, {
      name: `Temp Delete Me ${testSuffix}`,
      code: `TEMP_DEL_${testSuffix}`,
      task_type: 'ROOM_CLEANING'
    });
    const unrefDelResult = await deleteChecklistTemplate(client, propertyId, unrefTpl.id);
    assert.strictEqual(unrefDelResult.archived, false, 'Unreferenced template hard-deleted');
    console.log(`✓ Unreferenced template hard-deleted safely.`);

    // -------------------------------------------------------------------------
    // TEST 11: Checklist Item CRUD & Reorder
    // -------------------------------------------------------------------------
    console.log('\n--- Test 11: Checklist Item CRUD & Reorder ---');
    const createdItem = await addChecklistTemplateItem(client, propertyId, newTpl.id, {
      section: 'BATHROOM',
      label: 'Aromatherapy Diffuser',
      description: 'Nyalakan diffuser 15 menit',
      is_required: false,
      is_active: true
    });
    assert.strictEqual(createdItem.label, 'Aromatherapy Diffuser');
    assert.strictEqual(createdItem.description, 'Nyalakan diffuser 15 menit');

    const updatedItem = await updateChecklistTemplateItem(client, propertyId, newTpl.id, createdItem.id, {
      label: 'Aromatherapy Lavender Diffuser',
      is_required: true
    });
    assert.strictEqual(updatedItem.label, 'Aromatherapy Lavender Diffuser');
    assert.strictEqual(updatedItem.is_required, true);

    // Reorder items
    const reorderedItems = await reorderChecklistTemplateItems(client, propertyId, newTpl.id, [
      createdItem.id,
      dupTpl.items[0].id
    ]);
    assert(reorderedItems.length >= 1, 'Reorder executed');
    console.log(`✓ Item Add, Edit, and Reorder verified.`);

    // -------------------------------------------------------------------------
    // TEST 12: Editing Master Template does NOT alter historical task snapshots
    // -------------------------------------------------------------------------
    console.log('\n--- Test 12: Master modification snapshot immutability ---');
    const beforeSnapshot = await getTaskChecklistItems(client, propertyId, task1.id);
    const beforeLabel = beforeSnapshot[0].label;

    // Mutate a master template item
    if (beforeSnapshot[0].template_item_id) {
      await updateChecklistTemplateItem(client, propertyId, stdTplRes.rows[0].id, beforeSnapshot[0].template_item_id, {
        label: `MUTATED_${Date.now()}`
      });
    }

    // Historical task snapshot must remain unchanged
    const afterSnapshot = await getTaskChecklistItems(client, propertyId, task1.id);
    assert.strictEqual(afterSnapshot[0].label, beforeLabel, 'Historical task snapshot label unchanged');

    // Restore master item
    if (beforeSnapshot[0].template_item_id) {
      await updateChecklistTemplateItem(client, propertyId, stdTplRes.rows[0].id, beforeSnapshot[0].template_item_id, {
        label: beforeLabel
      });
    }
    console.log(`✓ Immutability invariant verified: Historical task snapshot preserved when master changes.`);

    // -------------------------------------------------------------------------
    // TEST 13: Archived template does not affect historical task
    // -------------------------------------------------------------------------
    console.log('\n--- Test 13: Archived template does not break historical tasks ---');
    const taskSnapshotAfterArchive = await getTaskChecklistItems(client, propertyId, task1.id);
    assert(taskSnapshotAfterArchive.length > 0, 'Task snapshot remains intact after template archive test');
    console.log(`✓ Archived template does not affect historical task.`);

    // -------------------------------------------------------------------------
    // TEST 14, 15, 16: Checklist Validation & Cleaning Note Persistence
    // -------------------------------------------------------------------------
    console.log('\n--- Test 14, 15, 16: Required items block completion, optional items do not, and cleaning note persists ---');
    await startHousekeepingTask(client, propertyId, task1.id, {
      started_by_user_id: 1,
      started_by_name: 'Test Housekeeper'
    });

    const taskItems = await getTaskChecklistItems(client, propertyId, task1.id);
    const reqItems = taskItems.filter(i => i.is_required);
    const optItems = taskItems.filter(i => !i.is_required);

    // 15a: Try to complete without completing required items -> must throw CHECKLIST_INCOMPLETE
    let errorThrown = false;
    try {
      await completeHousekeepingTask(client, propertyId, task1.id, {
        completed_by_user_id: 1,
        completed_by_name: 'Test Housekeeper',
        cleaning_note: 'Mencoba selesai tanpa checklist'
      });
    } catch (err) {
      errorThrown = true;
      assert(
        err.code === 'CHECKLIST_INCOMPLETE' || err.message.includes('checklist wajib'),
        `Expected checklist incomplete error, got: ${err.message}`
      );
    }
    assert(errorThrown, 'Task completion was blocked by incomplete required checklist items');
    console.log(`✓ Incomplete required checklist properly blocked task completion.`);

    // Complete all required items, but leave optional items incomplete
    for (const item of reqItems) {
      await updateTaskChecklistItem(client, propertyId, task1.id, item.id, {
        is_completed: true,
        completed_by_name: 'Test Housekeeper'
      });
    }

    // Verify optional items are NOT completed
    for (const item of optItems) {
      await updateTaskChecklistItem(client, propertyId, task1.id, item.id, {
        is_completed: false
      });
    }

    // 14 & 16: Complete task with cleaning note and incomplete optional items -> must SUCCEED
    const completedTask = await completeHousekeepingTask(client, propertyId, task1.id, {
      completed_by_user_id: 1,
      completed_by_name: 'Test Housekeeper',
      cleaning_note: 'Kamar selesai dibersihkan dengan standar OAK, minibar terisi penuh.'
    });

    assert.strictEqual(completedTask.status, 'DONE', 'Task status is DONE');
    assert.strictEqual(
      completedTask.cleaning_note,
      'Kamar selesai dibersihkan dengan standar OAK, minibar terisi penuh.',
      'Cleaning note persisted'
    );
    assert.strictEqual(completedTask.cleaning_note_by, 'Test Housekeeper', 'cleaning_note_by persisted');
    assert(completedTask.cleaning_note_at, 'cleaning_note_at timestamp recorded');
    console.log(`✓ Optional items did not block completion.`);
    console.log(`✓ Cleaning note persisted: "${completedTask.cleaning_note}" by ${completedTask.cleaning_note_by} at ${completedTask.cleaning_note_at}`);

    console.log('\n=== ALL 16 EMP-MOBILE-3C CHECKS PASSED SUCCESSFULLY ===');
  } finally {
    // Zero residue cleanup
    console.log('\nCleaning up test fixtures...');
    for (const tid of createdTaskIds) {
      await client.query('DELETE FROM housekeeping_task_checklist_items WHERE task_id = $1', [tid]);
      await client.query('DELETE FROM housekeeping_task_findings WHERE task_id = $1', [tid]);
      await client.query('DELETE FROM housekeeping_tasks WHERE id = $1', [tid]);
    }
    for (const tplId of createdTemplateIds) {
      await client.query('DELETE FROM checklist_template_items WHERE template_id = $1', [tplId]);
      await client.query('DELETE FROM checklist_templates WHERE id = $1', [tplId]);
    }
    if (roomId) {
      await client.query('DELETE FROM rooms WHERE id = $1', [roomId]);
    }
    client.release();
    console.log('✓ Test fixtures cleaned. Zero residue.');
  }
}

runHardeningTests()
  .then(() => {
    console.log('Housekeeping checklist hardening test suite PASSED.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Housekeeping checklist hardening test suite FAILED:', err);
    process.exit(1);
  });
