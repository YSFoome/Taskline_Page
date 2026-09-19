import {
  closestCenter,
  DndContext,
  DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  parseISO,
  startOfMonth,
  startOfWeek,
  subMonths
} from 'date-fns';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import {
  activeStatuses,
  cloneSnapshot,
  createCheckItem,
  createId,
  createTask,
  firstActiveStatus,
  formatShortDate,
  nowIso,
  renumberTasks,
  shiftTaskToDate,
  spawnNextRecurringTask,
  taskCoversDate,
  tasksForStatus,
  todayString,
  touchTask
} from './domain';
import { applyConflictChoice, snapshotsEqual } from './merge';
import {
  downloadText,
  exportState,
  loadPersistedState,
  readTheme,
  savePersistedState,
  saveTheme
} from './storage';
import {
  commitMergedSnapshot,
  pullFromGithub,
  pushLocalToGithub,
  SyncError,
  syncWithGithub,
  testGithubConnection
} from './sync';
import { parseSnapshot } from './schema';
import type {
  AppSnapshot,
  CustomFieldDefinition,
  CustomFieldType,
  MergeConflict,
  PersistedState,
  Priority,
  StatusColumn,
  SyncConfig,
  SyncDraft,
  Task
} from './types';

type View = 'board' | 'calendar' | 'archive' | 'settings';
type Theme = 'system' | 'light' | 'dark';
type DateFilter = 'all' | 'today' | 'overdue';

const priorityLabels: Record<Priority, string> = {
  none: '无优先级', low: '低', medium: '中', high: '高'
};

function Icon({ name }: { name: string }) {
  const glyphs: Record<string, string> = {
    board: '▦', calendar: '▤', archive: '▥', settings: '⚙', search: '⌕', sync: '↻',
    plus: '+', arrow: '→', close: '×', check: '✓', more: '⋯', back: '‹', next: '›',
    filter: '≡', today: '◷', tag: '#', link: '↗', download: '↓', upload: '↑',
    sun: '☀', moon: '☾', info: 'i', drag: '⠿', trash: '⌫', undo: '↶'
  };
  return <span className="icon" aria-hidden="true">{glyphs[name] ?? name}</span>;
}

function uidLabel(): string {
  const platform = navigator.userAgent.toLowerCase();
  if (platform.includes('iphone') || platform.includes('ipad')) return 'iPhone / iPad';
  if (platform.includes('mac')) return 'Mac';
  if (platform.includes('win')) return 'Windows';
  return '浏览器设备';
}

function snapshotIsDirty(state: PersistedState): boolean {
  return !snapshotsEqual(state.snapshot, state.baseSnapshot);
}

function taskMatchesSearch(task: Task, snapshot: AppSnapshot, query: string): boolean {
  if (!query.trim()) return true;
  const customText = snapshot.customFields.map((field) => String(task.customValues[field.id] ?? '')).join(' ');
  const haystack = [task.title, task.notes, task.tags.join(' '), customText].join(' ').toLowerCase();
  return haystack.includes(query.trim().toLowerCase());
}

function valuePreview(value: unknown): string {
  if (value === undefined) return '未设置';
  if (value === null) return '空';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function App() {
  const [state, setState] = useState<PersistedState | null>(null);
  const [view, setView] = useState<View>('board');
  const [theme, setTheme] = useState<Theme>(readTheme());
  const [search, setSearch] = useState('');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [priorityFilter, setPriorityFilter] = useState<Priority | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(todayString());
  const [calendarMonth, setCalendarMonth] = useState(startOfMonth(new Date()));
  const [quickTitle, setQuickTitle] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncDraft, setSyncDraft] = useState<SyncDraft | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [undoSnapshot, setUndoSnapshot] = useState<AppSnapshot | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    void loadPersistedState().then(setState).catch(() => setToast('本地数据读取失败，请刷新页面重试。'));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    saveTheme(theme);
  }, [theme]);

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
  }, []);

  const notify = (message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4500);
  };

  const persist = (nextState: PersistedState) => {
    setState(nextState);
    void savePersistedState(nextState).catch(() => notify('本地保存失败，请检查浏览器存储权限。'));
  };

  const mutateSnapshot = (updater: (snapshot: AppSnapshot) => void, message?: string) => {
    if (!state) return;
    const previous = cloneSnapshot(state.snapshot);
    const snapshot = cloneSnapshot(state.snapshot);
    updater(snapshot);
    snapshot.generatedAt = nowIso();
    setUndoSnapshot(previous);
    persist({ ...state, snapshot });
    if (message) notify(message);
  };

  const undo = () => {
    if (!state || !undoSnapshot) return;
    persist({ ...state, snapshot: cloneSnapshot(undoSnapshot) });
    setUndoSnapshot(null);
    notify('已撤销上一步操作。');
  };

  const selectedTask = state?.snapshot.tasks.find((task) => task.id === selectedTaskId) ?? null;
  const dirty = state ? snapshotIsDirty(state) : false;
  const filteredTasks = useMemo(() => {
    if (!state) return [];
    const today = todayString();
    return state.snapshot.tasks.filter((task) => {
      if (view === 'archive' ? !task.archived : task.archived) return false;
      if (!taskMatchesSearch(task, state.snapshot, search)) return false;
      if (priorityFilter !== 'all' && task.priority !== priorityFilter) return false;
      if (statusFilter !== 'all' && task.statusId !== statusFilter) return false;
      if (dateFilter === 'today' && !taskCoversDate(task, today)) return false;
      if (dateFilter === 'overdue' && (!task.dueDate || task.dueDate >= today || task.archived)) return false;
      return true;
    });
  }, [dateFilter, priorityFilter, search, state, statusFilter, view]);

  const updateTask = (id: string, patch: Partial<Task>, message?: string) => {
    mutateSnapshot((snapshot) => {
      const task = snapshot.tasks.find((candidate) => candidate.id === id);
      if (!task) return;
      const previousStatus = snapshot.statuses.find((status) => status.id === task.statusId);
      Object.assign(task, patch);
      touchTask(task);
      const nextStatus = snapshot.statuses.find((status) => status.id === task.statusId);
      if (nextStatus?.isDone && !previousStatus?.isDone) {
        task.completedAt = nowIso();
        const next = spawnNextRecurringTask(snapshot, task);
        if (next) snapshot.tasks.push(next);
      } else if (!nextStatus?.isDone) {
        task.completedAt = undefined;
      }
      renumberTasks(snapshot, task.statusId);
    }, message);
  };

  const moveTaskToStatus = (id: string, statusId: string) => {
    updateTask(id, { statusId, sortOrder: tasksForStatus(state!.snapshot, statusId).length }, '任务已移动。');
  };

  const addQuickTask = (event: FormEvent) => {
    event.preventDefault();
    const title = quickTitle.trim();
    if (!title || !state) return;
    const status = firstActiveStatus(state.snapshot);
    const task = createTask(title, status.id, tasksForStatus(state.snapshot, status.id).length);
    mutateSnapshot((snapshot) => snapshot.tasks.push(task), '已添加到待办。');
    setQuickTitle('');
    setSelectedTaskId(task.id);
  };

  const addTaskInStatus = (statusId: string) => {
    if (!state) return;
    const title = window.prompt('新任务标题');
    if (!title?.trim()) return;
    const task = createTask(title, statusId, tasksForStatus(state.snapshot, statusId).length);
    mutateSnapshot((snapshot) => snapshot.tasks.push(task), '已添加任务。');
    setSelectedTaskId(task.id);
  };

  const removeTask = (id: string) => {
    if (!state || !window.confirm('删除后会在同步文件中留下删除标记，确定删除这个任务吗？')) return;
    mutateSnapshot((snapshot) => {
      snapshot.tasks = snapshot.tasks.filter((task) => task.id !== id);
      snapshot.tombstones.push({ id, entity: 'task', deletedAt: nowIso() });
    }, '任务已删除。');
    setSelectedTaskId(null);
  };

  const toggleArchive = (id: string, archived: boolean) => {
    updateTask(id, { archived }, archived ? '任务已归档。' : '任务已恢复。');
    if (archived) setSelectedTaskId(null);
  };

  const handleBoardDragEnd = (event: DragEndEvent) => {
    if (!state || !event.over) return;
    const activeId = String(event.active.id);
    const overId = String(event.over.id);
    if (!activeId.startsWith('task:')) return;
    const taskId = activeId.slice(5);
    const overTask = overId.startsWith('task:') ? state.snapshot.tasks.find((task) => task.id === overId.slice(5)) : undefined;
    const statusId = overId.startsWith('status:') ? overId.slice(7) : overTask?.statusId;
    if (!statusId) return;
    mutateSnapshot((snapshot) => {
      const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
      if (!task) return;
      const siblings = tasksForStatus(snapshot, statusId).filter((candidate) => candidate.id !== taskId);
      const targetIndex = overTask ? Math.max(0, siblings.findIndex((candidate) => candidate.id === overTask.id)) : siblings.length;
      task.statusId = statusId;
      siblings.splice(targetIndex < 0 ? siblings.length : targetIndex, 0, task);
      siblings.forEach((candidate, index) => { candidate.sortOrder = index; });
      touchTask(task);
    }, '任务顺序已更新。');
  };

  const handleCalendarDragEnd = (event: DragEndEvent) => {
    if (!state || !event.over) return;
    const activeId = String(event.active.id);
    const overId = String(event.over.id);
    if (!activeId.startsWith('calendar-task:') || !overId.startsWith('date:')) return;
    const taskId = activeId.slice('calendar-task:'.length);
    const date = overId.slice(5);
    mutateSnapshot((snapshot) => {
      const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
      if (task) shiftTaskToDate(task, date);
    }, '日期已调整。');
  };

  const resolveConflict = (conflict: MergeConflict, choice: 'local' | 'remote') => {
    if (!syncDraft) return;
    setSyncDraft({
      ...syncDraft,
      snapshot: applyConflictChoice(syncDraft.snapshot, conflict, choice),
      resolutions: { ...syncDraft.resolutions, [conflict.id]: choice }
    });
  };

  const finishConflictSync = async () => {
    if (!state || !syncDraft?.remoteSha || syncDraft.conflicts.some((conflict) => !syncDraft.resolutions[conflict.id])) return;
    if (!state.syncConfig) return;
    setSyncing(true);
    try {
      const result = await commitMergedSnapshot(state.syncConfig, syncDraft.snapshot, syncDraft.remoteSha);
      const nextState: PersistedState = {
        ...state,
        snapshot: syncDraft.snapshot,
        baseSnapshot: cloneSnapshot(syncDraft.snapshot),
        remoteSha: result.remoteSha,
        lastSyncAt: nowIso(),
        lastCommitUrl: result.commitUrl
      };
      persist(nextState);
      setSyncDraft(null);
      notify('冲突已解决并同步到 GitHub。');
    } catch (error) {
      notify(error instanceof SyncError ? error.message : '提交合并结果失败，修改仍保留在本地。');
    } finally {
      setSyncing(false);
    }
  };

  const sync = async () => {
    if (!state) return;
    if (!state.syncConfig) {
      setView('settings');
      notify('先在设置中连接一个 GitHub 数据仓库。');
      return;
    }
    setSyncing(true);
    try {
      const result = await syncWithGithub(state.syncConfig, state.baseSnapshot, state.snapshot);
      if (result.kind === 'conflict') {
        setSyncDraft({ snapshot: result.snapshot, remoteSha: result.remoteSha, conflicts: result.conflicts, resolutions: {} });
        notify(`发现 ${result.conflicts.length} 个冲突，请选择保留哪一侧。`);
      } else {
        const nextState: PersistedState = {
          ...state,
          snapshot: result.snapshot,
          baseSnapshot: cloneSnapshot(result.snapshot),
          remoteSha: result.remoteSha,
          lastSyncAt: nowIso(),
          lastCommitUrl: result.commitUrl
        };
        persist(nextState);
        notify('已同步到 GitHub。');
      }
    } catch (error) {
      notify(error instanceof SyncError ? error.message : '同步失败，本地修改没有改变。');
    } finally {
      setSyncing(false);
    }
  };

  const pullRemote = async () => {
    if (!state) return;
    if (!state.syncConfig) {
      setView('settings');
      notify('先在设置中连接一个 GitHub 数据仓库。');
      return;
    }
    setSyncing(true);
    try {
      const result = await pullFromGithub(state.syncConfig);
      if (!result.snapshot) {
        notify('远端还没有任务快照，请先使用“推送本地”初始化。');
        return;
      }
      if (snapshotIsDirty(state) && !window.confirm('本机有尚未同步的修改。从远端拉取会丢弃这些本地修改，确定继续吗？')) return;
      const nextState: PersistedState = {
        ...state,
        snapshot: result.snapshot,
        baseSnapshot: cloneSnapshot(result.snapshot),
        remoteSha: result.remoteSha,
        lastSyncAt: nowIso(),
        lastCommitUrl: result.commitUrl
      };
      persist(nextState);
      setSyncDraft(null);
      notify('已从 GitHub 拉取到本地。');
    } catch (error) {
      notify(error instanceof SyncError ? error.message : '从 GitHub 拉取失败，本地数据没有改变。');
    } finally {
      setSyncing(false);
    }
  };

  const pushLocal = async () => {
    if (!state) return;
    if (!state.syncConfig) {
      setView('settings');
      notify('先在设置中连接一个 GitHub 数据仓库。');
      return;
    }
    if (!window.confirm('推送本地会覆盖 GitHub 数据文件的当前内容。确定继续吗？')) return;
    setSyncing(true);
    try {
      const result = await pushLocalToGithub(state.syncConfig, state.snapshot, state.remoteSha);
      const nextState: PersistedState = {
        ...state,
        baseSnapshot: cloneSnapshot(state.snapshot),
        remoteSha: result.remoteSha,
        lastSyncAt: nowIso(),
        lastCommitUrl: result.commitUrl
      };
      persist(nextState);
      notify('本地任务已推送到 GitHub。');
    } catch (error) {
      notify(error instanceof SyncError ? error.message : '推送到 GitHub 失败，本地数据没有改变。');
    } finally {
      setSyncing(false);
    }
  };

  const updateConfig = (config: SyncConfig | undefined) => {
    if (!state) return;
    persist({ ...state, syncConfig: config });
  };

  if (!state) {
    return <div className="loading-screen"><div className="brand-mark">✓</div><span>正在打开本地任务库…</span></div>;
  }

  const viewTitle: Record<View, string> = { board: '我的看板', calendar: '月历', archive: '归档', settings: '设置' };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">✓</div>
          <div><strong>Taskline</strong><small>个人任务台</small></div>
        </div>
        <nav className="primary-nav" aria-label="主导航">
          <NavButton active={view === 'board'} icon="board" label="看板" onClick={() => setView('board')} />
          <NavButton active={view === 'calendar'} icon="calendar" label="月历" onClick={() => setView('calendar')} />
          <NavButton active={view === 'archive'} icon="archive" label="归档" count={state.snapshot.tasks.filter((task) => task.archived).length} onClick={() => setView('archive')} />
        </nav>
        <div className="sidebar-spacer" />
        <div className="side-sync-card">
          <div className="eyebrow">同步状态</div>
          <div className={`sync-dot ${dirty ? 'is-dirty' : state.syncConfig ? 'is-ok' : ''}`} />
          <strong>{state.syncConfig ? (dirty ? '有本地修改' : '已连接') : '尚未连接'}</strong>
          <small>{state.lastSyncAt ? `上次 ${format(new Date(state.lastSyncAt), 'M月d日 HH:mm')}` : '数据只保存在本机'}</small>
          <div className="sync-direction-actions">
            <button className="button button-ghost" onClick={() => void pullRemote()} disabled={syncing}><Icon name="download" /> 拉取</button>
            <button className="button button-primary" onClick={() => void pushLocal()} disabled={syncing}><Icon name="upload" /> 推送</button>
          </div>
          <button className="button button-ghost button-wide" onClick={() => void sync()} disabled={syncing}>
            <Icon name="sync" /> {syncing ? '同步中…' : '合并同步'}
          </button>
        </div>
        <NavButton active={view === 'settings'} icon="settings" label="设置" onClick={() => setView('settings')} />
        <div className="sidebar-footnote">离线优先 · 手动同步</div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="mobile-brand"><div className="brand-mark small">✓</div><strong>Taskline</strong></div>
          <div className="page-heading"><span className="eyebrow">工作台</span><h1>{viewTitle[view]}</h1></div>
          <div className="topbar-actions">
            <label className="search-box">
              <Icon name="search" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索任务…" aria-label="搜索任务" />
              {search && <button aria-label="清除搜索" onClick={() => setSearch('')}><Icon name="close" /></button>}
            </label>
            <button className="button button-ghost desktop-only" onClick={() => setView('settings')}><Icon name="settings" /> 设置</button>
            <button className="button button-primary sync-top-button" onClick={() => void sync()} disabled={syncing} title="拉取、合并并推送">
              <Icon name="sync" /><span className="sync-button-label">{syncing ? '同步中' : '合并'}</span>
            </button>
          </div>
        </header>

        {!state.syncConfig && view !== 'settings' && (
          <button className="setup-banner" onClick={() => setView('settings')}>
            <span className="setup-banner-icon"><Icon name="info" /></span>
            <span><strong>还没有云端备份</strong><small>连接一个私有 GitHub 仓库，换设备时手动同步任务。</small></span>
            <Icon name="arrow" />
          </button>
        )}

        {view === 'board' && (
          <BoardView
            snapshot={state.snapshot}
            tasks={filteredTasks}
            quickTitle={quickTitle}
            setQuickTitle={setQuickTitle}
            onQuickAdd={addQuickTask}
            dateFilter={dateFilter}
            setDateFilter={setDateFilter}
            priorityFilter={priorityFilter}
            setPriorityFilter={setPriorityFilter}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            onSelectTask={setSelectedTaskId}
            onDragEnd={handleBoardDragEnd}
            onMoveColumn={(id, direction) => mutateSnapshot((snapshot) => {
              const statuses = activeStatuses(snapshot);
              const index = statuses.findIndex((status) => status.id === id);
              const target = index + direction;
              if (index < 0 || target < 0 || target >= statuses.length) return;
              const current = statuses[index];
              statuses[index] = statuses[target];
              statuses[target] = current;
              statuses.forEach((status, statusIndex) => { status.sortOrder = statusIndex; });
            }, '看板顺序已更新。')}
            onAddColumn={() => {
              const name = window.prompt('新看板列名称', '待整理');
              if (!name?.trim()) return;
              mutateSnapshot((snapshot) => snapshot.statuses.push({ id: createId('status'), name: name.trim(), color: '#94a3b8', isDone: false, sortOrder: snapshot.statuses.length }), '已添加看板列。');
            }}
            onAddTaskInStatus={addTaskInStatus}
          />
        )}
        {view === 'calendar' && (
          <CalendarView
            snapshot={state.snapshot}
            tasks={filteredTasks}
            month={calendarMonth}
            selectedDate={selectedDate}
            onMonthChange={setCalendarMonth}
            onSelectDate={setSelectedDate}
            onSelectTask={setSelectedTaskId}
            onDragEnd={handleCalendarDragEnd}
          />
        )}
        {view === 'archive' && (
          <ArchiveView tasks={filteredTasks} onSelectTask={setSelectedTaskId} onRestore={(id) => toggleArchive(id, false)} />
        )}
        {view === 'settings' && (
          <SettingsView
            state={state}
            theme={theme}
            onThemeChange={setTheme}
            onConfigChange={updateConfig}
            onTestConnection={async (config) => { await testGithubConnection(config); notify('GitHub 连接成功。'); }}
            onSync={() => void sync()}
            onPull={() => void pullRemote()}
            onPush={() => void pushLocal()}
            onExport={() => downloadText(`taskline-export-${todayString()}.json`, exportState(state))}
            onImport={(snapshot) => mutateSnapshot((current) => {
              current.tasks = snapshot.tasks;
              current.statuses = snapshot.statuses;
              current.customFields = snapshot.customFields;
              current.tombstones = snapshot.tombstones;
            }, '导入完成，当前数据已标记为未同步。')}
            onUpdateStatus={(id, patch) => mutateSnapshot((snapshot) => {
              const status = snapshot.statuses.find((candidate) => candidate.id === id);
              if (!status) return;
              if (patch.isDone === true) snapshot.statuses.forEach((candidate) => { candidate.isDone = candidate.id === id; });
              if (patch.isDone === false && status.isDone && snapshot.statuses.filter((candidate) => candidate.isDone).length === 1) return;
              Object.assign(status, patch);
            }, '看板列已更新。')}
            onDeleteStatus={(id, targetId) => mutateSnapshot((snapshot) => {
              const deleted = snapshot.statuses.find((status) => status.id === id);
              snapshot.tasks.forEach((task) => { if (task.statusId === id) task.statusId = targetId; });
              if (deleted?.isDone) snapshot.statuses.forEach((status) => { status.isDone = status.id === targetId; });
              snapshot.statuses = snapshot.statuses.filter((status) => status.id !== id);
              snapshot.tombstones.push({ id, entity: 'status', deletedAt: nowIso() });
            }, '看板列已删除。')}
            onAddField={(field) => mutateSnapshot((snapshot) => snapshot.customFields.push(field), '自定义字段已添加。')}
            onUpdateField={(id, patch) => mutateSnapshot((snapshot) => {
              const field = snapshot.customFields.find((candidate) => candidate.id === id);
              if (field) Object.assign(field, patch);
            }, '自定义字段已更新。')}
            onDeleteField={(id) => mutateSnapshot((snapshot) => {
              const field = snapshot.customFields.find((candidate) => candidate.id === id);
              if (field) field.archived = true;
            }, '自定义字段已停用，历史值仍会保留。')}
          />
        )}
      </main>

      <nav className="mobile-nav" aria-label="移动端主导航">
        <NavButton active={view === 'board'} icon="board" label="看板" onClick={() => setView('board')} />
        <NavButton active={view === 'calendar'} icon="calendar" label="月历" onClick={() => setView('calendar')} />
        <NavButton active={view === 'archive'} icon="archive" label="归档" onClick={() => setView('archive')} />
        <NavButton active={view === 'settings'} icon="settings" label="设置" onClick={() => setView('settings')} />
      </nav>

      {selectedTask && (
        <TaskEditor
          task={selectedTask}
          snapshot={state.snapshot}
          onClose={() => setSelectedTaskId(null)}
          onUpdate={(patch) => updateTask(selectedTask.id, patch)}
          onDelete={() => removeTask(selectedTask.id)}
          onToggleArchive={() => toggleArchive(selectedTask.id, !selectedTask.archived)}
          onMoveStatus={(statusId) => moveTaskToStatus(selectedTask.id, statusId)}
          onAddChecklist={(text) => updateTask(selectedTask.id, { checklist: [...selectedTask.checklist, createCheckItem(text)] })}
          onToggleChecklist={(itemId) => updateTask(selectedTask.id, { checklist: selectedTask.checklist.map((item) => item.id === itemId ? { ...item, done: !item.done } : item) })}
          onDeleteChecklist={(itemId) => updateTask(selectedTask.id, { checklist: selectedTask.checklist.filter((item) => item.id !== itemId) })}
        />
      )}

      {syncDraft && (
        <ConflictPanel
          draft={syncDraft}
          onResolve={resolveConflict}
          onCancel={() => setSyncDraft(null)}
          onFinish={() => void finishConflictSync()}
        />
      )}

      {toast && <div className="toast" role="status"><span>{toast}</span>{undoSnapshot && <button onClick={undo}><Icon name="undo" /> 撤销</button>}</div>}
    </div>
  );
}

function NavButton({ active, icon, label, count, onClick }: { active: boolean; icon: string; label: string; count?: number; onClick: () => void }) {
  return <button className={`nav-button ${active ? 'active' : ''}`} onClick={onClick}><Icon name={icon} /><span>{label}</span>{count ? <em>{count}</em> : null}</button>;
}

function FilterBar({
  dateFilter, setDateFilter, priorityFilter, setPriorityFilter, statusFilter, setStatusFilter, statuses
}: {
  dateFilter: DateFilter; setDateFilter: (value: DateFilter) => void;
  priorityFilter: Priority | 'all'; setPriorityFilter: (value: Priority | 'all') => void;
  statusFilter: string; setStatusFilter: (value: string) => void; statuses: StatusColumn[];
}) {
  return <div className="filter-bar">
    <div className="filter-group">
      <button className={`filter-pill ${dateFilter === 'today' ? 'selected' : ''}`} onClick={() => setDateFilter(dateFilter === 'today' ? 'all' : 'today')}><Icon name="today" /> 今天</button>
      <button className={`filter-pill ${dateFilter === 'overdue' ? 'selected danger' : ''}`} onClick={() => setDateFilter(dateFilter === 'overdue' ? 'all' : 'overdue')}>逾期</button>
    </div>
    <label className="compact-select"><span className="sr-only">优先级</span><select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as Priority | 'all')}><option value="all">所有优先级</option>{Object.entries(priorityLabels).filter(([key]) => key !== 'none').map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
    <label className="compact-select"><span className="sr-only">状态</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">所有状态</option>{statuses.map((status) => <option value={status.id} key={status.id}>{status.name}</option>)}</select></label>
  </div>;
}

function BoardView({
  snapshot, tasks, quickTitle, setQuickTitle, onQuickAdd, dateFilter, setDateFilter, priorityFilter, setPriorityFilter,
  statusFilter, setStatusFilter, onSelectTask, onDragEnd, onMoveColumn, onAddColumn, onAddTaskInStatus
}: {
  snapshot: AppSnapshot; tasks: Task[]; quickTitle: string; setQuickTitle: (value: string) => void; onQuickAdd: (event: FormEvent) => void;
  dateFilter: DateFilter; setDateFilter: (value: DateFilter) => void; priorityFilter: Priority | 'all'; setPriorityFilter: (value: Priority | 'all') => void;
  statusFilter: string; setStatusFilter: (value: string) => void; onSelectTask: (id: string) => void; onDragEnd: (event: DragEndEvent) => void;
  onMoveColumn: (id: string, direction: number) => void; onAddColumn: () => void; onAddTaskInStatus: (id: string) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));
  const statuses = activeStatuses(snapshot);
  return <section className="workspace board-workspace">
    <div className="workspace-intro"><div><h2>把要做的事放到正确的列里</h2><p>先收集，再推进；完成的事情留在这里，方便回顾。</p></div><div className="workspace-count"><strong>{tasks.length}</strong><span>个当前任务</span></div></div>
    <form className="quick-add" onSubmit={onQuickAdd}><span className="quick-add-mark"><Icon name="plus" /></span><input value={quickTitle} onChange={(event) => setQuickTitle(event.target.value)} placeholder="快速记录一件要做的事…" aria-label="快速记录任务" /><button className="button button-primary" type="submit">添加任务 <span className="shortcut-hint">↵</span></button></form>
    <FilterBar dateFilter={dateFilter} setDateFilter={setDateFilter} priorityFilter={priorityFilter} setPriorityFilter={setPriorityFilter} statusFilter={statusFilter} setStatusFilter={setStatusFilter} statuses={statuses} />
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <div className="board-scroll"><div className="board-grid">
        {statuses.map((status, index) => <BoardColumn key={status.id} status={status} index={index} total={statuses.length} tasks={tasks.filter((task) => task.statusId === status.id)} onSelectTask={onSelectTask} onMoveColumn={onMoveColumn} onAddTask={() => onAddTaskInStatus(status.id)} />)}
        <button className="add-column-card" onClick={onAddColumn}><Icon name="plus" /><span>添加看板列</span></button>
      </div></div>
      <DragOverlay>{null}</DragOverlay>
    </DndContext>
  </section>;
}

function BoardColumn({ status, index, total, tasks, onSelectTask, onMoveColumn, onAddTask }: { status: StatusColumn; index: number; total: number; tasks: Task[]; onSelectTask: (id: string) => void; onMoveColumn: (id: string, direction: number) => void; onAddTask: () => void }) {
  const { isOver, setNodeRef } = useDroppable({ id: `status:${status.id}` });
  return <div className={`board-column ${isOver ? 'is-over' : ''}`} ref={setNodeRef}>
    <div className="column-heading"><span className="status-color" style={{ background: status.color }} /><strong>{status.name}</strong><span className="column-count">{tasks.length}</span><div className="column-actions"><button aria-label="看板列左移" disabled={index === 0} onClick={() => onMoveColumn(status.id, -1)}>‹</button><button aria-label="看板列右移" disabled={index === total - 1} onClick={() => onMoveColumn(status.id, 1)}>›</button></div></div>
    <SortableContext items={tasks.map((task) => `task:${task.id}`)} strategy={verticalListSortingStrategy}>
      <div className="column-tasks">{tasks.map((task) => <SortableTaskCard key={task.id} task={task} onSelect={() => onSelectTask(task.id)} />)}{tasks.length === 0 && <div className="column-empty">把任务拖到这里</div>}</div>
    </SortableContext>
    <button className="column-add" onClick={onAddTask}><Icon name="plus" /> 添加任务</button>
  </div>;
}

function SortableTaskCard({ task, onSelect }: { task: Task; onSelect: () => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({ id: `task:${task.id}` });
  const style: CSSProperties = { transform: CSS.Transform.toString(transform) };
  return <article ref={setNodeRef} style={style} className={`task-card ${isDragging ? 'is-dragging' : ''}`} {...attributes} {...listeners} onClick={onSelect}>
    <div className="task-card-title">{task.title}</div>
    <div className="task-card-meta">{task.priority !== 'none' && <span className={`priority-dot ${task.priority}`} title={priorityLabels[task.priority]} />}{task.dueDate && <span className={task.dueDate < todayString() && !task.completedAt ? 'date-overdue' : ''}><Icon name="calendar" /> {formatShortDate(task.dueDate)}</span>}{task.checklist.length > 0 && <span><Icon name="check" /> {task.checklist.filter((item) => item.done).length}/{task.checklist.length}</span>}</div>
    {task.tags.length > 0 && <div className="task-tags">{task.tags.slice(0, 3).map((tag) => <span key={tag}>#{tag}</span>)}</div>}
  </article>;
}

function CalendarTask({ task, onSelect }: { task: Task; onSelect: () => void }) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: `calendar-task:${task.id}` });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform) };
  return <button ref={setNodeRef} style={style} {...attributes} {...listeners} className="calendar-task" onClick={(event) => { event.stopPropagation(); onSelect(); }}><span className={`priority-bar ${task.priority}`} />{task.title}</button>;
}

function CalendarDay({ date, month, tasks, selected, onSelect, onSelectTask }: { date: Date; month: Date; tasks: Task[]; selected: boolean; onSelect: () => void; onSelectTask: (id: string) => void }) {
  const dateValue = format(date, 'yyyy-MM-dd');
  const { isOver, setNodeRef } = useDroppable({ id: `date:${dateValue}` });
  return <div ref={setNodeRef} className={`calendar-day ${!isSameMonth(date, month) ? 'muted' : ''} ${selected ? 'selected' : ''} ${isOver ? 'is-over' : ''}`} onClick={onSelect}>
    <div className="day-number"><span>{format(date, 'd')}</span>{isSameDay(date, new Date()) && <i>今天</i>}</div>
    <div className="day-tasks">{tasks.slice(0, 3).map((task) => <CalendarTask key={task.id} task={task} onSelect={() => onSelectTask(task.id)} />)}{tasks.length > 3 && <span className="more-tasks">+{tasks.length - 3} 项</span>}</div>
  </div>;
}

function CalendarView({ snapshot, tasks, month, selectedDate, onMonthChange, onSelectDate, onSelectTask, onDragEnd }: { snapshot: AppSnapshot; tasks: Task[]; month: Date; selectedDate: string; onMonthChange: (date: Date) => void; onSelectDate: (date: string) => void; onSelectTask: (id: string) => void; onDragEnd: (event: DragEndEvent) => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const days = eachDayOfInterval({ start: startOfWeek(startOfMonth(month), { weekStartsOn: 1 }), end: endOfWeek(endOfMonth(month), { weekStartsOn: 1 }) });
  const dayTasks = tasks.filter((task) => taskCoversDate(task, selectedDate)).sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));
  return <section className="workspace calendar-workspace">
    <div className="workspace-intro calendar-intro"><div><h2>{format(month, 'yyyy年M月')}</h2><p>拖动任务到另一个日期，保留原来的执行跨度。</p></div><div className="calendar-controls"><button className="icon-button" onClick={() => onMonthChange(subMonths(month, 1))} aria-label="上个月"><Icon name="back" /></button><button className="button button-ghost" onClick={() => { onMonthChange(startOfMonth(new Date())); onSelectDate(todayString()); }}>回到今天</button><button className="icon-button" onClick={() => onMonthChange(addMonths(month, 1))} aria-label="下个月"><Icon name="next" /></button></div></div>
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="calendar-layout"><div className="calendar-card"><div className="week-header">{['一', '二', '三', '四', '五', '六', '日'].map((day) => <span key={day}>{day}</span>)}</div><div className="calendar-grid">{days.map((date) => <CalendarDay key={date.toISOString()} date={date} month={month} tasks={tasks.filter((task) => taskCoversDate(task, format(date, 'yyyy-MM-dd')))} selected={format(date, 'yyyy-MM-dd') === selectedDate} onSelect={() => onSelectDate(format(date, 'yyyy-MM-dd'))} onSelectTask={onSelectTask} />)}</div></div>
        <aside className="agenda-panel"><div className="agenda-heading"><div><span className="eyebrow">当天清单</span><h3>{format(parseISO(selectedDate), 'M月d日 · EEEE')}</h3></div><span className="agenda-count">{dayTasks.length}</span></div>{dayTasks.length ? <div className="agenda-list">{dayTasks.map((task) => <button key={task.id} className="agenda-item" onClick={() => onSelectTask(task.id)}><span className={`priority-line ${task.priority}`} /><span className="agenda-item-body"><strong>{task.title}</strong><small>{task.dueDate ? `截止 ${formatShortDate(task.dueDate)}` : '无截止日期'}{task.tags.length ? ` · ${task.tags.slice(0, 2).map((tag) => `#${tag}`).join(' ')}` : ''}</small></span><Icon name="arrow" /></button>)}</div> : <div className="empty-state compact"><span className="empty-glyph">◷</span><strong>这一天还没有任务</strong><p>在看板快速记录，或把任务拖到这里。</p></div>}</aside>
      </div>
    </DndContext>
    <div className="calendar-legend">{snapshot.statuses.map((status) => <span key={status.id}><i style={{ background: status.color }} />{status.name}</span>)}</div>
  </section>;
}

function ArchiveView({ tasks, onSelectTask, onRestore }: { tasks: Task[]; onSelectTask: (id: string) => void; onRestore: (id: string) => void }) {
  return <section className="workspace archive-workspace"><div className="workspace-intro"><div><h2>归档库</h2><p>完成过的事情仍然属于你的记录，可以随时恢复。</p></div><div className="workspace-count"><strong>{tasks.length}</strong><span>个已归档</span></div></div>{tasks.length ? <div className="archive-list">{tasks.map((task) => <article className="archive-row" key={task.id}><div className="archive-check"><Icon name="check" /></div><div className="archive-body"><button onClick={() => onSelectTask(task.id)}>{task.title}</button><small>{task.completedAt ? `完成于 ${format(new Date(task.completedAt), 'yyyy年M月d日')}` : '已归档'}{task.tags.length ? ` · ${task.tags.map((tag) => `#${tag}`).join(' ')}` : ''}</small></div><button className="button button-ghost" onClick={() => onRestore(task.id)}>恢复</button></article>)}</div> : <div className="empty-state"><span className="empty-glyph">▥</span><strong>归档还是空的</strong><p>完成后不想继续显示的任务，可以从详情里归档。</p></div>}</section>;
}

function TaskEditor({ task, snapshot, onClose, onUpdate, onDelete, onToggleArchive, onMoveStatus, onAddChecklist, onToggleChecklist, onDeleteChecklist }: { task: Task; snapshot: AppSnapshot; onClose: () => void; onUpdate: (patch: Partial<Task>) => void; onDelete: () => void; onToggleArchive: () => void; onMoveStatus: (id: string) => void; onAddChecklist: (text: string) => void; onToggleChecklist: (id: string) => void; onDeleteChecklist: (id: string) => void }) {
  const [checkText, setCheckText] = useState('');
  const [tagText, setTagText] = useState(task.tags.join(', '));
  useEffect(() => setTagText(task.tags.join(', ')), [task.id, task.tags]);
  const commitTags = () => onUpdate({ tags: [...new Set(tagText.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))] });
  const addChecklist = (event: FormEvent) => { event.preventDefault(); if (!checkText.trim()) return; onAddChecklist(checkText); setCheckText(''); };
  const setDate = (key: 'startDate' | 'dueDate', value: string) => onUpdate({ [key]: value || undefined });
  return <div className="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="task-sheet" role="dialog" aria-modal="true" aria-label="任务详情">
    <div className="sheet-header"><div><span className="eyebrow">任务详情</span><span className="sheet-id">#{task.id.slice(-6)}</span></div><button className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="close" /></button></div>
    <div className="sheet-scroll"><input className="task-title-input" value={task.title} onChange={(event) => onUpdate({ title: event.target.value })} placeholder="任务标题" autoFocus />
      <div className="editor-row"><label>状态<select value={task.statusId} onChange={(event) => onMoveStatus(event.target.value)}>{activeStatuses(snapshot).map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</select></label><label>优先级<select value={task.priority} onChange={(event) => onUpdate({ priority: event.target.value as Priority })}>{Object.entries(priorityLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>
      <div className="editor-row"><label>开始日期<input type="date" value={task.startDate ?? ''} onChange={(event) => setDate('startDate', event.target.value)} /></label><label>截止日期<input type="date" value={task.dueDate ?? ''} onChange={(event) => setDate('dueDate', event.target.value)} /></label></div>
      <label className="field-label">备注<textarea value={task.notes} onChange={(event) => onUpdate({ notes: event.target.value })} placeholder="补充背景、下一步或相关信息…" rows={4} /></label>
      <label className="field-label">标签<input value={tagText} onChange={(event) => setTagText(event.target.value)} onBlur={commitTags} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitTags(); } }} placeholder="用逗号分隔，例如 工作, 阅读" /></label>
      <section className="editor-section"><div className="section-heading"><strong>周期</strong><span>完成后自动生成下一次</span></div><select value={task.recurrence?.frequency ?? 'none'} onChange={(event) => onUpdate({ recurrence: event.target.value === 'none' ? undefined : { frequency: event.target.value as 'daily' | 'weekly' | 'monthly', interval: 1 } })}><option value="none">不重复</option><option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option></select>{task.recurrence && !task.dueDate && <p className="field-help warning">周期任务需要先设置截止日期。</p>}</section>
      <section className="editor-section"><div className="section-heading"><strong>检查清单</strong><span>{task.checklist.filter((item) => item.done).length}/{task.checklist.length}</span></div>{task.checklist.map((item) => <div className="check-row" key={item.id}><button className={`check-box ${item.done ? 'checked' : ''}`} onClick={() => onToggleChecklist(item.id)} aria-label={item.done ? '取消完成' : '标记完成'}>{item.done && <Icon name="check" />}</button><span className={item.done ? 'done-text' : ''}>{item.text}</span><button className="mini-icon-button" onClick={() => onDeleteChecklist(item.id)} aria-label="删除检查项"><Icon name="close" /></button></div>)}<form className="check-add" onSubmit={addChecklist}><input value={checkText} onChange={(event) => setCheckText(event.target.value)} placeholder="添加一个步骤…" /><button type="submit" aria-label="添加检查项"><Icon name="plus" /></button></form></section>
      {snapshot.customFields.filter((field) => !field.archived).length > 0 && <section className="editor-section"><div className="section-heading"><strong>自定义字段</strong><span>按需补充</span></div>{snapshot.customFields.filter((field) => !field.archived).map((field) => <CustomFieldInput key={field.id} field={field} value={task.customValues[field.id]} onChange={(value) => onUpdate({ customValues: { ...task.customValues, [field.id]: value } })} />)}</section>}
    </div>
    <div className="sheet-footer"><button className="button button-danger-ghost" onClick={onDelete}><Icon name="trash" /> 删除</button><button className="button button-ghost" onClick={onToggleArchive}>{task.archived ? '恢复任务' : '归档任务'}</button><button className="button button-primary" onClick={onClose}>完成</button></div>
  </aside></div>;
}

function CustomFieldInput({ field, value, onChange }: { field: CustomFieldDefinition; value: string | number | boolean | null | undefined; onChange: (value: string | number | boolean | null) => void }) {
  const label = <span>{field.name}</span>;
  if (field.type === 'boolean') return <label className="boolean-field"><input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
  if (field.type === 'select') return <label className="field-label">{label}<select value={String(value ?? '')} onChange={(event) => onChange(event.target.value || null)}><option value="">未选择</option>{field.options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
  return <label className="field-label">{label}<input type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'} value={value === null || value === undefined ? '' : String(value)} onChange={(event) => onChange(field.type === 'number' ? (event.target.value ? Number(event.target.value) : null) : event.target.value || null)} /></label>;
}

function ConflictPanel({ draft, onResolve, onCancel, onFinish }: { draft: SyncDraft; onResolve: (conflict: MergeConflict, choice: 'local' | 'remote') => void; onCancel: () => void; onFinish: () => void }) {
  const allResolved = draft.conflicts.every((conflict) => draft.resolutions[conflict.id]);
  return <div className="modal-backdrop"><section className="conflict-modal" role="dialog" aria-modal="true" aria-labelledby="conflict-title"><div className="modal-header"><div><span className="eyebrow">同步需要确认</span><h2 id="conflict-title">有 {draft.conflicts.length} 个字段发生冲突</h2></div><button className="icon-button" onClick={onCancel} aria-label="取消同步"><Icon name="close" /></button></div><p className="modal-lede">其他设备和本机都修改了同一处内容。选择后才会把合并结果写回 GitHub。</p><div className="conflict-list">{draft.conflicts.map((conflict) => <article className="conflict-item" key={conflict.id}><strong>{conflict.message}</strong><div className="conflict-values"><div><span>本机</span><pre>{valuePreview(conflict.local)}</pre><button className={`button ${draft.resolutions[conflict.id] === 'local' ? 'button-primary' : 'button-ghost'}`} onClick={() => onResolve(conflict, 'local')}>保留本机</button></div><div><span>GitHub</span><pre>{valuePreview(conflict.remote)}</pre><button className={`button ${draft.resolutions[conflict.id] === 'remote' ? 'button-primary' : 'button-ghost'}`} onClick={() => onResolve(conflict, 'remote')}>采用 GitHub</button></div></div></article>)}</div><div className="modal-footer"><button className="button button-ghost" onClick={onCancel}>先不处理</button><button className="button button-primary" disabled={!allResolved} onClick={onFinish}>完成选择并同步</button></div></section></div>;
}

function SettingsView({ state, theme, onThemeChange, onConfigChange, onTestConnection, onSync, onPull, onPush, onExport, onImport, onUpdateStatus, onDeleteStatus, onAddField, onUpdateField, onDeleteField }: { state: PersistedState; theme: Theme; onThemeChange: (theme: Theme) => void; onConfigChange: (config: SyncConfig | undefined) => void; onTestConnection: (config: SyncConfig) => Promise<void>; onSync: () => void; onPull: () => void; onPush: () => void; onExport: () => void; onImport: (snapshot: AppSnapshot) => void; onUpdateStatus: (id: string, patch: Partial<StatusColumn>) => void; onDeleteStatus: (id: string, targetId: string) => void; onAddField: (field: CustomFieldDefinition) => void; onUpdateField: (id: string, patch: Partial<CustomFieldDefinition>) => void; onDeleteField: (id: string) => void }) {
  const defaultConfig: SyncConfig = state.syncConfig ?? { owner: '', repo: '', branch: 'main', path: 'task-data/snapshot.v1.json', deviceName: uidLabel(), token: '' };
  const [config, setConfig] = useState(defaultConfig);
  const [testing, setTesting] = useState(false);
  const [fieldName, setFieldName] = useState('');
  const [fieldType, setFieldType] = useState<CustomFieldType>('text');
  const [fieldOptions, setFieldOptions] = useState('');
  const importRef = useRef<HTMLInputElement>(null);
  const saveConfig = () => onConfigChange(config.token ? config : undefined);
  const testConnection = async () => { setTesting(true); try { await onTestConnection(config); } catch (error) { window.alert(error instanceof Error ? error.message : '连接测试失败。'); } finally { setTesting(false); } };
  const addField = () => { if (!fieldName.trim()) return; onAddField({ id: createId('field'), name: fieldName.trim(), type: fieldType, options: fieldType === 'select' ? fieldOptions.split(/[,，]/).map((item) => item.trim()).filter(Boolean) : [], sortOrder: state.snapshot.customFields.length, archived: false }); setFieldName(''); setFieldOptions(''); };
  const importFile = async (file?: File) => { if (!file) return; try { const parsed = JSON.parse(await file.text()); const snapshot = parseSnapshot(parsed); if (window.confirm('导入会替换当前任务、状态和自定义字段，确定继续吗？')) onImport(snapshot); } catch (error) { window.alert(error instanceof Error ? error.message : '无法导入：文件不是有效的 Taskline JSON。'); } finally { if (importRef.current) importRef.current.value = ''; } };
  return <section className="workspace settings-workspace"><div className="workspace-intro"><div><h2>设置</h2><p>连接方式、外观和任务库结构都保存在当前设备。</p></div></div>
    <div className="settings-grid"><section className="settings-card settings-connection"><div className="card-heading"><div><span className="eyebrow">GitHub 同步</span><h3>连接私有数据仓库</h3></div><span className={`connection-state ${state.syncConfig ? 'connected' : ''}`}><i />{state.syncConfig ? '已连接' : '未连接'}</span></div><p className="card-copy">应用只读写你指定仓库里的一个 JSON 文件。请创建一个私有仓库，并为它生成仅有 Contents 读写权限的细粒度令牌。</p><div className="settings-form"><div className="editor-row"><label>Owner<input value={config.owner} onChange={(event) => setConfig({ ...config, owner: event.target.value })} placeholder="你的 GitHub 用户名" /></label><label>Repository<input value={config.repo} onChange={(event) => setConfig({ ...config, repo: event.target.value })} placeholder="例如 my-tasks-data" /></label></div><div className="editor-row"><label>分支<input value={config.branch} onChange={(event) => setConfig({ ...config, branch: event.target.value })} /></label><label>设备名称<input value={config.deviceName} onChange={(event) => setConfig({ ...config, deviceName: event.target.value })} /></label></div><label>数据文件路径<input value={config.path} onChange={(event) => setConfig({ ...config, path: event.target.value })} /></label><label>Fine-grained PAT<input type="password" value={config.token} onChange={(event) => setConfig({ ...config, token: event.target.value })} placeholder={state.syncConfig ? '已保存，输入新令牌可替换' : 'github_pat_…'} autoComplete="off" /></label><div className="settings-actions"><button className="button button-primary" onClick={saveConfig}>保存连接</button><button className="button button-ghost" onClick={() => void testConnection()} disabled={testing || !config.token}>{testing ? '测试中…' : '测试连接'}</button>{state.syncConfig && <button className="button button-danger-ghost" onClick={() => onConfigChange(undefined)}>清除连接</button>}</div></div><div className="connection-footnote"><Icon name="info" /><span>令牌只保存在此设备的浏览器存储中，不会进入任务 JSON、导出文件或提交信息。<a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">创建令牌 <Icon name="link" /></a></span></div>{state.lastCommitUrl && <a className="last-commit" href={state.lastCommitUrl} target="_blank" rel="noreferrer">查看最近一次 GitHub 提交 <Icon name="link" /></a>}</section>
      <section className="settings-card"><div className="card-heading"><div><span className="eyebrow">外观</span><h3>让它适合你的设备</h3></div></div><div className="theme-options">{(['system', 'light', 'dark'] as Theme[]).map((option) => <button key={option} className={`theme-option ${theme === option ? 'selected' : ''}`} onClick={() => onThemeChange(option)}><span>{option === 'system' ? '◐' : option === 'light' ? '☀' : '☾'}</span><strong>{option === 'system' ? '跟随系统' : option === 'light' ? '浅色' : '深色'}</strong><small>{option === 'system' ? '按设备偏好自动切换' : option === 'light' ? '清爽明亮' : '适合夜间'}</small></button>)}</div></section>
      <StatusSettings statuses={activeStatuses(state.snapshot)} onUpdate={onUpdateStatus} onDelete={onDeleteStatus} />
      <CustomFieldSettings fields={state.snapshot.customFields} fieldName={fieldName} setFieldName={setFieldName} fieldType={fieldType} setFieldType={setFieldType} fieldOptions={fieldOptions} setFieldOptions={setFieldOptions} onAdd={addField} onUpdate={onUpdateField} onDelete={onDeleteField} />
      <section className="settings-card"><div className="card-heading"><div><span className="eyebrow">数据安全</span><h3>导出、恢复与同步</h3></div></div><p className="card-copy">拉取会用 GitHub 内容替换本机快照；推送会用本机快照覆盖 GitHub 文件；合并同步会尝试保留两端的修改。</p><div className="data-actions sync-action-row"><button className="button button-ghost" onClick={onPull} disabled={!state.syncConfig}><Icon name="download" /> 从远端拉取</button><button className="button button-primary" onClick={onPush} disabled={!state.syncConfig}><Icon name="upload" /> 推送本地</button><button className="button button-ghost" onClick={onSync} disabled={!state.syncConfig}><Icon name="sync" /> 合并同步</button></div><div className="data-actions"><button className="button button-ghost" onClick={onExport}><Icon name="download" /> 导出全部数据</button><button className="button button-ghost" onClick={() => importRef.current?.click()}><Icon name="upload" /> 导入数据</button><input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(event) => void importFile(event.target.files?.[0])} /></div><p className="field-help">当前版本：schema v{state.snapshot.schemaVersion} · 任务 {state.snapshot.tasks.length} 个 · 归档 {state.snapshot.tasks.filter((task) => task.archived).length} 个</p></section>
    </div>
  </section>;
}

function StatusSettings({ statuses, onUpdate, onDelete }: { statuses: StatusColumn[]; onUpdate: (id: string, patch: Partial<StatusColumn>) => void; onDelete: (id: string, targetId: string) => void }) {
  return <section className="settings-card"><div className="card-heading"><div><span className="eyebrow">看板结构</span><h3>状态列</h3></div><span className="card-side-note">必须保留一个完成列</span></div><div className="status-settings-list">{statuses.map((status, index) => <div className="status-setting-row" key={status.id}><input className="color-input" type="color" value={status.color} onChange={(event) => onUpdate(status.id, { color: event.target.value })} aria-label="状态颜色" /><input value={status.name} onChange={(event) => onUpdate(status.id, { name: event.target.value })} aria-label="状态名称" /><label className="done-toggle"><input type="checkbox" checked={status.isDone} disabled={status.isDone && statuses.filter((candidate) => candidate.isDone).length === 1} onChange={(event) => onUpdate(status.id, { isDone: event.target.checked })} />完成列</label>{statuses.length > 2 && <button className="mini-icon-button" aria-label="删除状态列" onClick={() => { const candidates = statuses.filter((candidate) => candidate.id !== status.id); const targetName = window.prompt(`删除“${status.name}”后，任务要移动到哪一列？\n可选：${candidates.map((candidate) => candidate.name).join('、')}`, candidates[0]?.name); const target = candidates.find((candidate) => candidate.name === targetName?.trim()) ?? candidates[0]; if (target && window.confirm(`确认删除“${status.name}”并将任务移动到“${target.name}”吗？`)) onDelete(status.id, target.id); }}><Icon name="trash" /></button>}<span className="status-index">{index + 1}</span></div>)}</div></section>;
}

function CustomFieldSettings({ fields, fieldName, setFieldName, fieldType, setFieldType, fieldOptions, setFieldOptions, onAdd, onUpdate, onDelete }: { fields: CustomFieldDefinition[]; fieldName: string; setFieldName: (value: string) => void; fieldType: CustomFieldType; setFieldType: (value: CustomFieldType) => void; fieldOptions: string; setFieldOptions: (value: string) => void; onAdd: () => void; onUpdate: (id: string, patch: Partial<CustomFieldDefinition>) => void; onDelete: (id: string) => void }) {
  return <section className="settings-card"><div className="card-heading"><div><span className="eyebrow">任务字段</span><h3>自定义字段</h3></div><span className="card-side-note">停用后保留历史值</span></div><div className="field-builder"><input value={fieldName} onChange={(event) => setFieldName(event.target.value)} placeholder="字段名称，例如 来源" /><select value={fieldType} onChange={(event) => setFieldType(event.target.value as CustomFieldType)}><option value="text">短文本</option><option value="number">数字</option><option value="date">日期</option><option value="select">单选</option><option value="boolean">布尔值</option></select>{fieldType === 'select' && <input value={fieldOptions} onChange={(event) => setFieldOptions(event.target.value)} placeholder="选项，用逗号分隔" />}<button className="button button-primary" onClick={onAdd}>添加字段</button></div>{fields.filter((field) => !field.archived).length ? <div className="custom-field-list">{fields.filter((field) => !field.archived).map((field) => <div className="custom-field-row" key={field.id}><span className="field-type-pill">{field.type}</span><input value={field.name} onChange={(event) => onUpdate(field.id, { name: event.target.value })} /><small>{field.type === 'select' ? field.options.join(' · ') : '任务详情中可编辑'}</small><button className="mini-icon-button" onClick={() => onDelete(field.id)} aria-label="停用字段"><Icon name="close" /></button></div>)}</div> : <div className="inline-empty">还没有自定义字段。</div>}</section>;
}

export default App;
