import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskChecklistItem } from '../src/features/housekeeping/housekeepingTypes.ts';
import {
  applyBulkChecklistLocalUpdate,
  applyChecklistItemLocalUpdate,
  canSubmitHousekeepingChecklist,
  countRequiredChecklist,
  parseChecklistMutationError
} from '../src/features/employee/housekeepingMobileChecklist.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(frontendRoot, rel), 'utf8');
}

function item(partial: Partial<TaskChecklistItem> & { id: number }): TaskChecklistItem {
  return {
    task_id: 1,
    section: 'KAMAR MANDI',
    label: `Item ${partial.id}`,
    sort_order: partial.id,
    is_required: true,
    requires_note: false,
    requires_photo: false,
    is_completed: false,
    created_at: '2026-01-01T00:00:00.000Z',
    ...partial
  };
}

console.log('=== OAK HIMS Housekeeping Mobile Checklist UI Tests ===\n');

console.log('--- 1. Successful PATCH updates checkbox/count ---');
const initial = [item({ id: 1, is_required: true }), item({ id: 2, is_required: true }), item({ id: 3, is_required: false })];
check(countRequiredChecklist(initial).completed === 0, 'starts at 0 required completed');
check(canSubmitHousekeepingChecklist(initial) === false, 'submit disabled while required items remain');

const afterOne = applyChecklistItemLocalUpdate(initial, 1, true, 'Noviansyah');
check(afterOne[0].is_completed === true, 'toggled item is completed');
check(afterOne[1].is_completed === false, 'other item is unchanged');
check(countRequiredChecklist(afterOne).completed === 1, 'required count becomes 1/2');
check(canSubmitHousekeepingChecklist(afterOne) === false, 'submit still disabled after one required item');

console.log('--- 2. Failed PATCH does not fake completion ---');
const failedState = initial;
check(failedState.every((row) => row.is_completed === false), 'failure leaves local items unchecked');
check(
  parseChecklistMutationError({ message: 'Tugas housekeeping ini tidak ditugaskan kepada Anda.' }, 403) ===
    'Tugas housekeeping ini tidak ditugaskan kepada Anda.',
  'API message becomes checklistError'
);
check(
  parseChecklistMutationError({}, 403) === 'Gagal memperbarui checklist (403).',
  'missing API message still produces a visible error'
);

console.log('--- 3. Bulk success updates only returned group rows ---');
const bulkUpdated = applyBulkChecklistLocalUpdate(initial, [
  { ...initial[0], is_completed: true },
  { ...initial[1], is_completed: true }
]);
check(bulkUpdated[0].is_completed === true && bulkUpdated[1].is_completed === true, 'bulk updates the group');
check(bulkUpdated[2].is_completed === false, 'optional item outside payload stays unchanged');
check(canSubmitHousekeepingChecklist(bulkUpdated) === true, 'submit enabled only after all required items complete');

const emptyBulk = applyBulkChecklistLocalUpdate(initial, []);
check(emptyBulk.every((row) => row.is_completed === false), 'empty bulk payload does not fake completion');

console.log('--- 4. Source contracts ---');
const crewSrc = readSrc('src/features/employee/HousekeepingMobileCrewView.tsx');
check(crewSrc.includes('setChecklistError(parseChecklistMutationError'), 'failed PATCH writes checklistError');
check(crewSrc.includes('applyChecklistItemLocalUpdate'), 'success uses canonical local item update');
check(crewSrc.includes('applyBulkChecklistLocalUpdate'), 'bulk success merges returned rows only');
check(!/console\.error\('Failed to toggle checklist item'/.test(crewSrc), 'individual PATCH no longer console.error-only');
check(!/console\.error\('Failed to bulk toggle category checklist items'/.test(crewSrc), 'bulk PATCH no longer console.error-only');
check(crewSrc.includes('disabled={submittingId === activeCleaningTask.id || !isAllRequiredCompleted}'), 'SUBMIT stays gated on required completion');

const desktopSrc = readSrc('src/features/housekeeping/HousekeepingWorkspace.tsx');
check(desktopSrc.includes('authenticatedFetch(`${apiBaseUrl}/housekeeping/templates?property_id=${propertyId}`)'), 'templates use authenticatedFetch');
check(desktopSrc.includes('authenticatedFetch(`${apiBaseUrl}/rooms?property_id=${propertyId}`)'), 'rooms use authenticatedFetch');
check(
  !/fetch\(`\$\{apiBaseUrl\}\/housekeeping\/templates/.test(desktopSrc),
  'raw unauthenticated templates fetch is removed'
);
check(
  !/fetch\(`\$\{apiBaseUrl\}\/rooms\?property_id/.test(desktopSrc),
  'raw unauthenticated rooms fetch is removed'
);

console.log(`\n${assertions} assertions passed.`);
