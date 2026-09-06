import { OperationalSheet } from './transactionTypes';

const TERMINAL = new Set(['VOIDED', 'CANCELLED', 'REVERSED']);

export interface LifecycleMemberInput {
  id: number | string;
  transaction_no?: string;
  transaction_type?: string;
  transaction_status?: string;
  transaction_date?: string;
  transaction_time?: string;
  source_id?: string | null;
  net_amount?: number | string;
  amount?: number | string;
  reservation_id?: number | string | null;
  booking_id?: number | string | null;
  reversal_of_transaction_id?: number | string | null;
  correction_group_id?: string | null;
  receiving_status?: string | null;
  deleted_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

export type LifecycleMemberRole = 'Original Sale' | 'Reversal' | 'Correction';

export interface SaleLifecycleGroup<T extends LifecycleMemberInput = LifecycleMemberInput> {
  key: string;
  members: T[];
  primary: T;
  effectiveNet: number;
  sheet: OperationalSheet;
}

export function toTxId(value: unknown): number {
  return Number(value);
}

export function moneyAmount(value: unknown): number {
  return Number(value || 0);
}

function upper(value: unknown): string {
  return String(value || '').trim().toUpperCase();
}

function metadataOf(row: LifecycleMemberInput): Record<string, unknown> {
  const raw = row.metadata;
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw;
}

export function restoredFromTransactionId(row: LifecycleMemberInput): number | null {
  const meta = metadataOf(row);
  const raw = meta.restored_from_transaction_id ?? meta.reversal_transaction_id;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function isCorrectionReplacement(row: LifecycleMemberInput): boolean {
  const meta = metadataOf(row);
  if (String(meta.correction_kind || '') === 'SALE_PROJECTION_REPLACEMENT') return true;
  const sourceId = String(row.source_id || '');
  return sourceId.startsWith('CORR-') && upper(row.transaction_status) === 'POSTED';
}

export function lifecycleMemberRole(row: LifecycleMemberInput, members: LifecycleMemberInput[]): LifecycleMemberRole {
  if (row.reversal_of_transaction_id != null && String(row.reversal_of_transaction_id) !== '') {
    return 'Reversal';
  }
  if (isCorrectionReplacement(row)) {
    return 'Correction';
  }
  const hasOlderVoidedOriginal = members.some((member) => (
    toTxId(member.id) < toTxId(row.id)
    && !member.reversal_of_transaction_id
    && TERMINAL.has(upper(member.transaction_status))
  ));
  if (upper(row.transaction_status) === 'POSTED' && row.correction_group_id && hasOlderVoidedOriginal) {
    return 'Correction';
  }
  return 'Original Sale';
}

class UnionFind {
  private parent = new Map<number, number>();

  add(id: number): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: number): number {
    this.add(id);
    const parent = this.parent.get(id) as number;
    if (parent !== id) {
      const root = this.find(parent);
      this.parent.set(id, root);
      return root;
    }
    return id;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

export function groupSaleLifecycles<T extends LifecycleMemberInput>(rows: T[]): SaleLifecycleGroup<T>[] {
  const byId = new Map<number, T>();
  for (const row of rows) {
    byId.set(toTxId(row.id), row);
  }
  rows = [...byId.values()];

  const uf = new UnionFind();
  const groupBuckets = new Map<string, number[]>();

  for (const row of rows) {
    const id = toTxId(row.id);
    uf.add(id);
    if (row.reversal_of_transaction_id != null && String(row.reversal_of_transaction_id) !== '') {
      uf.union(id, toTxId(row.reversal_of_transaction_id));
    }
    const restoredFrom = restoredFromTransactionId(row);
    if (restoredFrom) {
      uf.union(id, restoredFrom);
    }
    const groupId = String(row.correction_group_id || '').trim();
    if (groupId) {
      const bucket = groupBuckets.get(groupId) || [];
      bucket.push(id);
      groupBuckets.set(groupId, bucket);
    }
  }

  for (const ids of groupBuckets.values()) {
    for (let i = 1; i < ids.length; i += 1) {
      uf.union(ids[0], ids[i]);
    }
  }

  const components = new Map<number, T[]>();
  for (const row of rows) {
    const root = uf.find(toTxId(row.id));
    const list = components.get(root) || [];
    list.push(row);
    components.set(root, list);
  }

  return [...components.values()].map((members) => {
    const primary = selectLifecyclePrimary(members);
    const liveMembers = members.filter((member) => !member.deleted_at);
    const effectiveNet = liveMembers.reduce((sum, member) => sum + moneyAmount(member.net_amount), 0);
    const groupKey = String(primary.correction_group_id || '').trim()
      || `rev:${toTxId(primary.reversal_of_transaction_id || primary.id)}`;
    return {
      key: groupKey,
      members: members.sort((a, b) => toTxId(a.id) - toTxId(b.id)),
      primary,
      effectiveNet,
      sheet: deriveLifecycleSheet(primary),
    };
  });
}

export function selectLifecyclePrimary<T extends LifecycleMemberInput>(members: T[]): T {
  const live = members.filter((member) => !member.deleted_at);
  const pool = live.length > 0 ? live : members;
  const posted = pool.filter((member) => upper(member.transaction_status) === 'POSTED');
  if (posted.length > 0) {
    return posted.sort((a, b) => toTxId(b.id) - toTxId(a.id))[0];
  }
  const inProgress = pool.filter((member) => !TERMINAL.has(upper(member.transaction_status)));
  if (inProgress.length > 0) {
    return inProgress.sort((a, b) => toTxId(b.id) - toTxId(a.id))[0];
  }
  const reversed = pool.filter((member) => upper(member.transaction_status) === 'REVERSED');
  if (reversed.length > 0) {
    return reversed.sort((a, b) => toTxId(b.id) - toTxId(a.id))[0];
  }
  return pool.sort((a, b) => toTxId(b.id) - toTxId(a.id))[0];
}

export function deriveLifecycleSheet(row: LifecycleMemberInput): OperationalSheet {
  if (row.deleted_at) return 'HAPUS';
  const status = upper(row.transaction_status);
  if (TERMINAL.has(status)) return 'BATAL';
  const type = upper(row.transaction_type);
  if (type === 'PURCHASE') {
    const receiving = upper(row.receiving_status);
    if (['DITERIMA', 'DITERIMA_LENGKAP'].includes(receiving)) return 'SELESAI';
    return 'PROSES';
  }
  if (status === 'POSTED') return 'SELESAI';
  return 'PROSES';
}

export function lifecycleStatusLabel(sheet: OperationalSheet): string {
  if (sheet === 'BATAL') return 'Dibatalkan';
  if (sheet === 'SELESAI') return 'Selesai';
  if (sheet === 'HAPUS') return 'Hapus';
  return 'Proses';
}

export function presentLifecyclePrimary<T extends LifecycleMemberInput>(group: SaleLifecycleGroup<T>): T & {
  operational_sheet: OperationalSheet;
  effective_net_amount: number;
  lifecycle_raw_net_amount: number;
  lifecycle_group_key: string;
  lifecycle_member_count: number;
  is_lifecycle_primary: boolean;
  lifecycle_status_label: string;
} {
  return {
    ...group.primary,
    operational_sheet: group.sheet,
    net_amount: group.effectiveNet,
    effective_net_amount: group.effectiveNet,
    lifecycle_raw_net_amount: moneyAmount(group.primary.net_amount),
    lifecycle_group_key: group.key,
    lifecycle_member_count: group.members.length,
    is_lifecycle_primary: true,
    lifecycle_status_label: lifecycleStatusLabel(group.sheet),
  };
}

export function buildLifecycleHistory<T extends LifecycleMemberInput>(group: SaleLifecycleGroup<T>) {
  return {
    group_key: group.key,
    effective_net_amount: group.effectiveNet,
    operational_sheet: group.sheet,
    primary_transaction_id: toTxId(group.primary.id),
    member_count: group.members.length,
    members: group.members.map((member) => ({
      id: toTxId(member.id),
      transaction_no: member.transaction_no || null,
      role: lifecycleMemberRole(member, group.members),
      amount: moneyAmount(member.amount),
      net_amount: moneyAmount(member.net_amount),
      transaction_status: member.transaction_status || null,
      transaction_date: member.transaction_date || null,
    })),
  };
}

export function siblingExpansionIds(rows: LifecycleMemberInput[]): {
  ids: number[];
  parentIds: number[];
  groupIds: string[];
} {
  const ids = new Set<number>();
  const parentIds = new Set<number>();
  const groupIds = new Set<string>();
  for (const row of rows) {
    ids.add(toTxId(row.id));
    if (row.reversal_of_transaction_id != null && String(row.reversal_of_transaction_id) !== '') {
      parentIds.add(toTxId(row.reversal_of_transaction_id));
    }
    const restoredFrom = restoredFromTransactionId(row);
    if (restoredFrom) parentIds.add(restoredFrom);
    const groupId = String(row.correction_group_id || '').trim();
    if (groupId) groupIds.add(groupId);
  }
  return {
    ids: [...ids],
    parentIds: [...parentIds],
    groupIds: [...groupIds],
  };
}
