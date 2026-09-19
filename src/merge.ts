import { cloneSnapshot, normalizeSnapshot } from './domain';
import type {
  AppSnapshot,
  CustomFieldDefinition,
  MergeConflict,
  StatusColumn,
  Task,
  Tombstone
} from './types';

function stable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function same(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

function conflictId(entity: string, id: string, field: string): string {
  return `${entity}:${id}:${field}`;
}

function mergeValue<T>(
  entity: 'task' | 'status' | 'customField',
  entityId: string,
  field: string,
  base: T,
  local: T,
  remote: T,
  conflicts: MergeConflict[]
): T {
  if (same(local, remote)) return local;
  if (same(local, base)) return remote;
  if (same(remote, base)) return local;

  if (entity === 'task' && field === 'tags' && Array.isArray(local) && Array.isArray(remote)) {
    return [...new Set([...local, ...remote])] as T;
  }

  conflicts.push({
    id: conflictId(entity, entityId, field),
    entity,
    entityId,
    field,
    base,
    local,
    remote,
    message: `${entity === 'task' ? '任务' : entity === 'status' ? '看板列' : '自定义字段'}的“${fieldLabel(field)}”在两台设备上都有修改`
  });
  return local;
}

function fieldLabel(field: string): string {
  if (field.startsWith('custom:')) return '自定义字段';
  const labels: Record<string, string> = {
    title: '标题',
    notes: '备注',
    statusId: '状态',
    priority: '优先级',
    tags: '标签',
    startDate: '开始日期',
    dueDate: '截止日期',
    checklist: '检查清单',
    recurrence: '周期',
    customValues: '自定义字段',
    sortOrder: '排序',
    archived: '归档状态',
    name: '名称',
    color: '颜色',
    isDone: '完成列设置',
    options: '选项',
    type: '类型'
  };
  return labels[field] ?? field;
}

function mergeChecklist(base: Task['checklist'], local: Task['checklist'], remote: Task['checklist']): Task['checklist'] {
  const byId = new Map<string, Task['checklist'][number]>();
  for (const item of [...base, ...local, ...remote]) byId.set(item.id, item);
  return [...byId.values()].map((item) => {
    const b = base.find((candidate) => candidate.id === item.id);
    const l = local.find((candidate) => candidate.id === item.id);
    const r = remote.find((candidate) => candidate.id === item.id);
    if (!b) return l ?? r!;
    if (!l) return r!;
    if (!r) return l;
    if (same(l, r)) return l;
    if (same(l, b)) return r;
    return l;
  });
}

function mergeCustomValues(
  taskId: string,
  base: Task['customValues'],
  local: Task['customValues'],
  remote: Task['customValues'],
  conflicts: MergeConflict[]
): Task['customValues'] {
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  const merged: Task['customValues'] = {};
  for (const key of keys) {
    merged[key] = mergeValue('task', taskId, `custom:${key}`, base[key], local[key], remote[key], conflicts);
  }
  return merged;
}

function mergeTask(base: Task | undefined, local: Task | undefined, remote: Task | undefined, conflicts: MergeConflict[], id: string): Task | undefined {
  if (!base) return local ?? remote;
  if (!local && !remote) return undefined;
  if (!local || !remote) {
    const survivor = local ?? remote;
    const changedSide = local ? local : remote;
    const untouchedSide = local ? remote : local;
    if (untouchedSide === undefined) return survivor;
    if (same(changedSide, base)) return undefined;
    conflicts.push({
      id: conflictId('task', id, 'deleted'),
      entity: 'task',
      entityId: id,
      field: 'deleted',
      base,
      local,
      remote,
      message: '任务一端被删除，另一端仍有修改'
    });
    return local ?? remote;
  }

  const fields: Array<keyof Task> = [
    'title', 'notes', 'statusId', 'priority', 'tags', 'startDate', 'dueDate',
    'checklist', 'recurrence', 'customValues', 'sortOrder', 'archived', 'completedAt',
    'seriesId', 'generatedNextId'
  ];
  const merged = { ...local };
  for (const field of fields) {
    if (field === 'checklist') {
      merged[field] = mergeChecklist(base.checklist, local.checklist, remote.checklist);
      continue;
    }
    if (field === 'customValues') {
      merged.customValues = mergeCustomValues(id, base.customValues, local.customValues, remote.customValues, conflicts);
      continue;
    }
    (merged[field] as Task[typeof field]) = mergeValue(
      'task', id, field, base[field], local[field], remote[field], conflicts
    ) as Task[typeof field];
  }
  merged.updatedAt = [local.updatedAt, remote.updatedAt].sort().at(-1) ?? local.updatedAt;
  return merged;
}

function mergeDefinition<T extends StatusColumn | CustomFieldDefinition>(
  entity: 'status' | 'customField',
  base: T | undefined,
  local: T | undefined,
  remote: T | undefined,
  conflicts: MergeConflict[],
  id: string
): T | undefined {
  if (!base) return local ?? remote;
  if (!local && !remote) return undefined;
  if (!local || !remote) {
    if (same(local, base)) return remote;
    if (same(remote, base)) return local;
    conflicts.push({
      id: conflictId(entity, id, 'deleted'), entity, entityId: id, field: 'deleted', base, local, remote,
      message: `${entity === 'status' ? '看板列' : '自定义字段'}一端被删除，另一端仍有修改`
    });
    return local ?? remote;
  }
  const fields = entity === 'status'
    ? ['name', 'color', 'isDone', 'sortOrder'] as const
    : ['name', 'type', 'options', 'sortOrder', 'archived'] as const;
  const merged = { ...local } as T;
  for (const field of fields) {
    const baseValue = (base as unknown as Record<string, unknown>)[field];
    const localValue = (local as unknown as Record<string, unknown>)[field];
    const remoteValue = (remote as unknown as Record<string, unknown>)[field];
    (merged as unknown as Record<string, unknown>)[field] = mergeValue(entity, id, field, baseValue, localValue, remoteValue, conflicts);
  }
  return merged;
}

function mergeCollection<T extends { id: string }>(
  base: T[], local: T[], remote: T[], mergeOne: (b: T | undefined, l: T | undefined, r: T | undefined, id: string) => T | undefined
): T[] {
  const ids = new Set([...base, ...local, ...remote].map((item) => item.id));
  return [...ids].map((id) => mergeOne(base.find((item) => item.id === id), local.find((item) => item.id === id), remote.find((item) => item.id === id), id)).filter((item): item is T => Boolean(item));
}

function mergeTombstones(local: Tombstone[], remote: Tombstone[]): Tombstone[] {
  const map = new Map<string, Tombstone>();
  for (const tombstone of [...local, ...remote]) {
    const key = `${tombstone.entity}:${tombstone.id}`;
    const previous = map.get(key);
    if (!previous || previous.deletedAt < tombstone.deletedAt) map.set(key, tombstone);
  }
  return [...map.values()];
}

function entityValue(snapshot: AppSnapshot, entity: Tombstone['entity'], id: string): unknown {
  if (entity === 'task') return snapshot.tasks.find((item) => item.id === id);
  if (entity === 'status') return snapshot.statuses.find((item) => item.id === id);
  return snapshot.customFields.find((item) => item.id === id);
}

function removeEntity(snapshot: AppSnapshot, entity: Tombstone['entity'], id: string): void {
  if (entity === 'task') snapshot.tasks = snapshot.tasks.filter((item) => item.id !== id);
  else if (entity === 'status') snapshot.statuses = snapshot.statuses.filter((item) => item.id !== id);
  else snapshot.customFields = snapshot.customFields.filter((item) => item.id !== id);
}

function reconcileTombstones(
  base: AppSnapshot,
  local: AppSnapshot,
  remote: AppSnapshot,
  merged: AppSnapshot,
  conflicts: MergeConflict[]
): void {
  const tombstones = mergeTombstones(local.tombstones, remote.tombstones);
  for (const tombstone of tombstones) {
    const baseValue = entityValue(base, tombstone.entity, tombstone.id);
    const localValue = entityValue(local, tombstone.entity, tombstone.id);
    const remoteValue = entityValue(remote, tombstone.entity, tombstone.id);
    const localDeleted = local.tombstones.some((item) => item.entity === tombstone.entity && item.id === tombstone.id);
    const remoteDeleted = remote.tombstones.some((item) => item.entity === tombstone.entity && item.id === tombstone.id);
    if (!baseValue) {
      if (localDeleted || remoteDeleted) removeEntity(merged, tombstone.entity, tombstone.id);
      continue;
    }
    if (localDeleted && remoteDeleted) {
      removeEntity(merged, tombstone.entity, tombstone.id);
      continue;
    }
    if (localDeleted && remoteValue) {
      if (same(remoteValue, baseValue) || (remoteValue as { updatedAt?: string }).updatedAt !== undefined && (remoteValue as { updatedAt: string }).updatedAt <= tombstone.deletedAt) {
        removeEntity(merged, tombstone.entity, tombstone.id);
      } else {
        const id = conflictId(tombstone.entity, tombstone.id, 'deleted');
        if (!conflicts.some((conflict) => conflict.id === id)) conflicts.push({ id, entity: tombstone.entity, entityId: tombstone.id, field: 'deleted', base: baseValue, local: undefined, remote: remoteValue, message: '一端删除了内容，另一端仍有修改' });
        removeEntity(merged, tombstone.entity, tombstone.id);
      }
    } else if (remoteDeleted && localValue) {
      if (same(localValue, baseValue) || (localValue as { updatedAt?: string }).updatedAt !== undefined && (localValue as { updatedAt: string }).updatedAt <= tombstone.deletedAt) {
        removeEntity(merged, tombstone.entity, tombstone.id);
      } else {
        const id = conflictId(tombstone.entity, tombstone.id, 'deleted');
        if (!conflicts.some((conflict) => conflict.id === id)) conflicts.push({ id, entity: tombstone.entity, entityId: tombstone.id, field: 'deleted', base: baseValue, local: localValue, remote: undefined, message: '一端仍在修改内容，另一端删除了它' });
      }
    }
  }
}

export function mergeSnapshots(baseInput: AppSnapshot, localInput: AppSnapshot, remoteInput: AppSnapshot): { snapshot: AppSnapshot; conflicts: MergeConflict[] } {
  const base = normalizeSnapshot(baseInput);
  const local = normalizeSnapshot(localInput);
  const remote = normalizeSnapshot(remoteInput);
  const conflicts: MergeConflict[] = [];
  const statuses = mergeCollection(base.statuses, local.statuses, remote.statuses, (b, l, r, id) => mergeDefinition('status', b, l, r, conflicts, id));
  const customFields = mergeCollection(base.customFields, local.customFields, remote.customFields, (b, l, r, id) => mergeDefinition('customField', b, l, r, conflicts, id));
  const tasks = mergeCollection(base.tasks, local.tasks, remote.tasks, (b, l, r, id) => mergeTask(b, l, r, conflicts, id));
  const mergedSnapshot = normalizeSnapshot({
      ...cloneSnapshot(local),
      generatedAt: new Date().toISOString(),
      statuses,
      customFields,
      tasks,
      tombstones: mergeTombstones(local.tombstones, remote.tombstones)
    });
  reconcileTombstones(base, local, remote, mergedSnapshot, conflicts);
  return {
    snapshot: normalizeSnapshot(mergedSnapshot),
    conflicts
  };
}

export function applyConflictChoice(snapshotInput: AppSnapshot, conflict: MergeConflict, choice: 'local' | 'remote'): AppSnapshot {
  const snapshot = cloneSnapshot(snapshotInput);
  const value = choice === 'local' ? conflict.local : conflict.remote;
  if (conflict.entity === 'task') {
    const task = snapshot.tasks.find((candidate) => candidate.id === conflict.entityId);
    if (conflict.field === 'deleted') {
      const index = snapshot.tasks.findIndex((candidate) => candidate.id === conflict.entityId);
      if (value === undefined || value === null) {
        if (index >= 0) snapshot.tasks.splice(index, 1);
      } else if (task) {
        snapshot.tasks[index] = structuredClone(value as Task);
      } else {
        snapshot.tasks.push(structuredClone(value as Task));
      }
    } else if (task) {
      (task as unknown as Record<string, unknown>)[conflict.field] = structuredClone(value);
    }
  } else if (conflict.entity === 'status') {
    const index = snapshot.statuses.findIndex((candidate) => candidate.id === conflict.entityId);
    if (value === undefined || value === null) {
      if (index >= 0) snapshot.statuses.splice(index, 1);
    } else if (index >= 0 && conflict.field !== 'deleted') {
      (snapshot.statuses[index] as unknown as Record<string, unknown>)[conflict.field] = structuredClone(value);
    } else if (index < 0) {
      snapshot.statuses.push(structuredClone(value as StatusColumn));
    }
  } else {
    const index = snapshot.customFields.findIndex((candidate) => candidate.id === conflict.entityId);
    if (value === undefined || value === null) {
      if (index >= 0) snapshot.customFields.splice(index, 1);
    } else if (index >= 0 && conflict.field !== 'deleted') {
      (snapshot.customFields[index] as unknown as Record<string, unknown>)[conflict.field] = structuredClone(value);
    } else if (index < 0) {
      snapshot.customFields.push(structuredClone(value as CustomFieldDefinition));
    }
  }
  return normalizeSnapshot(snapshot);
}

export function snapshotsEqual(a: AppSnapshot, b: AppSnapshot): boolean {
  return stable(a) === stable(b);
}
