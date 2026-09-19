import { z } from 'zod';
import { normalizeSnapshot } from './domain';
import type { AppSnapshot } from './types';

const recurrenceSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  interval: z.literal(1)
});

const checklistSchema = z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean(),
  createdAt: z.string()
});

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string(),
  statusId: z.string(),
  priority: z.enum(['none', 'low', 'medium', 'high']),
  tags: z.array(z.string()),
  startDate: z.string().optional(),
  dueDate: z.string().optional(),
  checklist: z.array(checklistSchema),
  recurrence: recurrenceSchema.optional(),
  customValues: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  sortOrder: z.number(),
  archived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
  seriesId: z.string().optional(),
  generatedNextId: z.string().optional()
});

const statusSchema = z.object({
  id: z.string(), name: z.string(), color: z.string(), isDone: z.boolean(), sortOrder: z.number()
});

const customFieldSchema = z.object({
  id: z.string(), name: z.string(), type: z.enum(['text', 'number', 'date', 'select', 'boolean']),
  options: z.array(z.string()), sortOrder: z.number(), archived: z.boolean()
});

const snapshotSchema = z.object({
  schemaVersion: z.number(),
  generatedAt: z.string(),
  statuses: z.array(statusSchema),
  customFields: z.array(customFieldSchema),
  tasks: z.array(taskSchema),
  tombstones: z.array(z.object({ id: z.string(), entity: z.enum(['task', 'status', 'customField']), deletedAt: z.string() })),
  meta: z.object({ deviceName: z.string().optional(), lastWriter: z.string().optional() }).optional()
});

export function parseSnapshot(value: unknown): AppSnapshot {
  const candidate = (value as { snapshot?: unknown } | null)?.snapshot ?? value;
  const parsed = snapshotSchema.safeParse(candidate);
  if (!parsed.success) throw new Error('文件不是有效的 Taskline 数据格式。');
  return normalizeSnapshot(parsed.data);
}

export { snapshotSchema };
