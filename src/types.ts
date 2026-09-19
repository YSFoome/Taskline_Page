export const CURRENT_SCHEMA_VERSION = 1;

export type Priority = 'none' | 'low' | 'medium' | 'high';
export type CustomFieldType = 'text' | 'number' | 'date' | 'select' | 'boolean';
export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly';

export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  interval: 1;
}

export interface CheckItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  statusId: string;
  priority: Priority;
  tags: string[];
  startDate?: string;
  dueDate?: string;
  checklist: CheckItem[];
  recurrence?: RecurrenceRule;
  customValues: Record<string, string | number | boolean | null>;
  sortOrder: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  seriesId?: string;
  generatedNextId?: string;
}

export interface StatusColumn {
  id: string;
  name: string;
  color: string;
  isDone: boolean;
  sortOrder: number;
}

export interface CustomFieldDefinition {
  id: string;
  name: string;
  type: CustomFieldType;
  options: string[];
  sortOrder: number;
  archived: boolean;
}

export interface Tombstone {
  id: string;
  entity: 'task' | 'status' | 'customField';
  deletedAt: string;
}

export interface SnapshotMeta {
  deviceName?: string;
  lastWriter?: string;
}

export interface AppSnapshot {
  schemaVersion: number;
  generatedAt: string;
  statuses: StatusColumn[];
  customFields: CustomFieldDefinition[];
  tasks: Task[];
  tombstones: Tombstone[];
  meta?: SnapshotMeta;
}

export interface SyncConfig {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  deviceName: string;
  token: string;
}

export interface PersistedState {
  snapshot: AppSnapshot;
  baseSnapshot: AppSnapshot;
  remoteSha?: string;
  syncConfig?: SyncConfig;
  lastSyncAt?: string;
  lastCommitUrl?: string;
}

export type ConflictEntity = 'task' | 'status' | 'customField';

export interface MergeConflict {
  id: string;
  entity: ConflictEntity;
  entityId: string;
  field: string;
  base: unknown;
  local: unknown;
  remote: unknown;
  message: string;
}

export interface SyncDraft {
  snapshot: AppSnapshot;
  remoteSha?: string;
  conflicts: MergeConflict[];
  resolutions: Record<string, 'local' | 'remote'>;
}
