import type { TaskChecklistItem } from '../housekeeping/housekeepingTypes';

export function parseChecklistMutationError(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const record = body as { message?: unknown; code?: unknown };
    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message.trim();
    }
    if (typeof record.code === 'string' && record.code.trim()) {
      return record.code.trim();
    }
  }
  return `Gagal memperbarui checklist (${status}).`;
}

export function applyChecklistItemLocalUpdate(
  items: TaskChecklistItem[],
  itemId: number,
  isCompleted: boolean,
  checkedBy?: string
): TaskChecklistItem[] {
  return items.map((item) =>
    item.id === itemId
      ? { ...item, is_completed: isCompleted, completed_by_name: isCompleted ? (checkedBy || item.completed_by_name) : null }
      : item
  );
}

export function applyBulkChecklistLocalUpdate(
  items: TaskChecklistItem[],
  updatedRows: TaskChecklistItem[]
): TaskChecklistItem[] {
  if (!Array.isArray(updatedRows) || updatedRows.length === 0) {
    return items;
  }
  const updatedMap = new Map<number, TaskChecklistItem>(updatedRows.map((row) => [row.id, row]));
  return items.map((item) => updatedMap.get(item.id) || item);
}

export function countRequiredChecklist(items: TaskChecklistItem[]): { required: number; completed: number } {
  let required = 0;
  let completed = 0;
  for (const item of items) {
    if (!item.is_required) continue;
    required += 1;
    if (item.is_completed) completed += 1;
  }
  return { required, completed };
}

export function canSubmitHousekeepingChecklist(items: TaskChecklistItem[]): boolean {
  const { required, completed } = countRequiredChecklist(items);
  return required === 0 || completed === required;
}
