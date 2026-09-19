import { describe, expect, it } from 'vitest';
import {
  applyBatchOperation,
  completeTask,
  createInitialSnapshot,
  createTask,
  taskCoversDate,
  transitionTaskStatus
} from './domain';

describe('task workflow operations', () => {
  it('completes a task into the single done status', () => {
    const snapshot = createInitialSnapshot();
    const task = createTask('准备演示', 'status-todo', 0);
    snapshot.tasks.push(task);

    completeTask(snapshot, task.id);

    expect(task.statusId).toBe('status-done');
    expect(task.completedAt).toBeTruthy();
    expect(snapshot.tasks).toHaveLength(1);
  });

  it('creates one next recurring instance and resets checklist items', () => {
    const snapshot = createInitialSnapshot();
    const task = createTask('每月复盘', 'status-todo', 0);
    task.dueDate = '2026-09-30';
    task.recurrence = { frequency: 'monthly', interval: 1 };
    task.checklist = [{ id: 'check-1', text: '整理数据', done: true, createdAt: task.createdAt }];
    snapshot.tasks.push(task);

    completeTask(snapshot, task.id);
    completeTask(snapshot, task.id);

    expect(snapshot.tasks).toHaveLength(2);
    const next = snapshot.tasks.find((candidate) => candidate.id !== task.id)!;
    expect(next.dueDate).toBe('2026-10-30');
    expect(next.statusId).toBe('status-todo');
    expect(next.checklist[0].done).toBe(false);
  });

  it('applies batch status, tag and archive operations without tombstones', () => {
    const snapshot = createInitialSnapshot();
    const first = createTask('任务一', 'status-todo', 0);
    const second = createTask('任务二', 'status-todo', 1);
    first.tags = ['工作'];
    snapshot.tasks.push(first, second);

    applyBatchOperation(snapshot, [first.id, second.id], { type: 'add-tags', tags: ['工作', '重要'] });
    expect(first.tags).toEqual(['工作', '重要']);
    applyBatchOperation(snapshot, [first.id], { type: 'move-status', statusId: 'status-doing' });
    expect(first.statusId).toBe('status-doing');
    applyBatchOperation(snapshot, [first.id, second.id], { type: 'archive' });

    expect(snapshot.tasks.every((task) => task.archived)).toBe(true);
    expect(snapshot.tombstones).toHaveLength(0);
  });

  it('preserves a multi-day date interval when moving a task', () => {
    const snapshot = createInitialSnapshot();
    const task = createTask('跨日任务', 'status-todo', 0);
    task.startDate = '2026-09-19';
    task.dueDate = '2026-09-21';
    snapshot.tasks.push(task);

    expect(taskCoversDate(task, '2026-09-20')).toBe(true);
    expect(taskCoversDate(task, '2026-09-22')).toBe(false);
    transitionTaskStatus(snapshot, task.id, 'status-doing');
    expect(task.startDate).toBe('2026-09-19');
    expect(task.dueDate).toBe('2026-09-21');
  });
});

