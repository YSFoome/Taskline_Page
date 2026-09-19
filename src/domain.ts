import {
  addDays,
  addMonths,
  addWeeks,
  differenceInCalendarDays,
  format,
  isAfter,
  parseISO
} from 'date-fns';
import type {
  AppSnapshot,
  CheckItem,
  RecurrenceRule,
  StatusColumn,
  Task
} from './types';
import { CURRENT_SCHEMA_VERSION } from './types';

export const STATUS_COLORS = ['#38bdf8', '#a78bfa', '#fbbf24', '#34d399', '#fb7185', '#94a3b8'];

export function createId(prefix = 'id'): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayString(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

export function createDefaultStatuses(): StatusColumn[] {
  return [
    { id: 'status-todo', name: '待办', color: '#38bdf8', isDone: false, sortOrder: 0 },
    { id: 'status-doing', name: '进行中', color: '#a78bfa', isDone: false, sortOrder: 1 },
    { id: 'status-done', name: '已完成', color: '#34d399', isDone: true, sortOrder: 2 }
  ];
}

export function createInitialSnapshot(): AppSnapshot {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    generatedAt: nowIso(),
    statuses: createDefaultStatuses(),
    customFields: [],
    tasks: [],
    tombstones: []
  };
}

export function cloneSnapshot(snapshot: AppSnapshot): AppSnapshot {
  return structuredClone(snapshot);
}

export function createTask(title: string, statusId: string, sortOrder: number): Task {
  const timestamp = nowIso();
  return {
    id: createId('task'),
    title: title.trim(),
    notes: '',
    statusId,
    priority: 'none',
    tags: [],
    checklist: [],
    customValues: {},
    sortOrder,
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function createCheckItem(text: string): CheckItem {
  return { id: createId('check'), text: text.trim(), done: false, createdAt: nowIso() };
}

export function sortStatuses(statuses: StatusColumn[]): StatusColumn[] {
  return [...statuses].sort((a, b) => a.sortOrder - b.sortOrder);
}

export function activeStatuses(snapshot: AppSnapshot): StatusColumn[] {
  return sortStatuses(snapshot.statuses);
}

export function doneStatus(snapshot: AppSnapshot): StatusColumn {
  return snapshot.statuses.find((status) => status.isDone) ?? snapshot.statuses.at(-1)!;
}

export function firstActiveStatus(snapshot: AppSnapshot): StatusColumn {
  return snapshot.statuses.find((status) => !status.isDone) ?? snapshot.statuses[0];
}

export function tasksForStatus(snapshot: AppSnapshot, statusId: string): Task[] {
  return snapshot.tasks
    .filter((task) => task.statusId === statusId && !task.archived)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export function renumberTasks(snapshot: AppSnapshot, statusId: string): void {
  tasksForStatus(snapshot, statusId).forEach((task, index) => {
    task.sortOrder = index;
  });
}

export function touchTask(task: Task): void {
  task.updatedAt = nowIso();
}

export function formatShortDate(date?: string): string {
  if (!date) return '';
  return format(parseISO(date), 'M月d日');
}

export function taskCoversDate(task: Task, date: string): boolean {
  if (!task.startDate && !task.dueDate) return false;
  const start = task.startDate ?? task.dueDate!;
  const end = task.dueDate ?? task.startDate!;
  return date >= start && date <= end;
}

export function shiftTaskToDate(task: Task, date: string): void {
  if (task.startDate && task.dueDate) {
    const duration = differenceInCalendarDays(parseISO(task.dueDate), parseISO(task.startDate));
    task.startDate = date;
    task.dueDate = format(addDays(parseISO(date), Math.max(0, duration)), 'yyyy-MM-dd');
  } else if (task.dueDate) {
    task.dueDate = date;
  } else {
    task.startDate = date;
  }
  touchTask(task);
}

export function nextOccurrenceDate(sourceDate: string, rule: RecurrenceRule, afterDate: string): string {
  let candidate = parseISO(sourceDate);
  const after = parseISO(afterDate);
  do {
    candidate = rule.frequency === 'daily'
      ? addDays(candidate, rule.interval)
      : rule.frequency === 'weekly'
        ? addWeeks(candidate, rule.interval)
        : addMonths(candidate, rule.interval);
  } while (!isAfter(candidate, after));
  return format(candidate, 'yyyy-MM-dd');
}

export function spawnNextRecurringTask(snapshot: AppSnapshot, task: Task): Task | null {
  if (!task.recurrence || task.generatedNextId || !task.dueDate) return null;
  const doneDate = task.completedAt?.slice(0, 10) ?? todayString();
  const nextDueDate = nextOccurrenceDate(task.dueDate, task.recurrence, doneDate);
  const next = structuredClone(task);
  const nextId = createId('task');
  const seriesId = task.seriesId ?? task.id;
  next.id = nextId;
  next.seriesId = seriesId;
  next.generatedNextId = undefined;
  next.completedAt = undefined;
  next.archived = false;
  next.statusId = firstActiveStatus(snapshot).id;
  next.dueDate = nextDueDate;
  next.startDate = task.startDate && task.dueDate
    ? format(addDays(parseISO(nextDueDate), -differenceInCalendarDays(parseISO(task.dueDate), parseISO(task.startDate))), 'yyyy-MM-dd')
    : undefined;
  next.checklist = task.checklist.map((item) => ({ ...item, id: createId('check'), done: false }));
  next.sortOrder = tasksForStatus(snapshot, next.statusId).length;
  next.createdAt = nowIso();
  next.updatedAt = nowIso();
  task.generatedNextId = nextId;
  touchTask(task);
  return next;
}

export function normalizeSnapshot(snapshot: AppSnapshot): AppSnapshot {
  const normalized = cloneSnapshot(snapshot);
  normalized.schemaVersion = CURRENT_SCHEMA_VERSION;
  normalized.statuses = sortStatuses(normalized.statuses).map((status, index) => ({ ...status, sortOrder: index }));
  if (!normalized.statuses.length) normalized.statuses = createDefaultStatuses();
  if (!normalized.statuses.some((status) => status.isDone)) normalized.statuses.at(-1)!.isDone = true;
  normalized.customFields = [...normalized.customFields].sort((a, b) => a.sortOrder - b.sortOrder);
  normalized.tasks = normalized.tasks.map((task) => ({
    ...task,
    tags: [...new Set(task.tags ?? [])],
    checklist: task.checklist ?? [],
    customValues: task.customValues ?? {},
    archived: task.archived ?? false,
    priority: task.priority ?? 'none'
  }));
  return normalized;
}
