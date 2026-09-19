import { openDB, type DBSchema } from 'idb';
import { createInitialSnapshot, normalizeSnapshot } from './domain';
import type { PersistedState, SyncConfig } from './types';

interface TasklineDb extends DBSchema {
  state: {
    key: string;
    value: PersistedState;
  };
}

const DB_NAME = 'taskline-local';
const DB_VERSION = 1;

const dbPromise = openDB<TasklineDb>(DB_NAME, DB_VERSION, {
  upgrade(db) {
    if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
  }
});

export function createInitialState(): PersistedState {
  const snapshot = createInitialSnapshot();
  return { snapshot, baseSnapshot: structuredClone(snapshot) };
}

export async function loadPersistedState(): Promise<PersistedState> {
  const db = await dbPromise;
  const state = await db.get('state', 'current');
  if (!state) {
    const initial = createInitialState();
    await db.put('state', initial, 'current');
    return initial;
  }
  return {
    ...state,
    snapshot: normalizeSnapshot(state.snapshot),
    baseSnapshot: normalizeSnapshot(state.baseSnapshot)
  };
}

export async function savePersistedState(state: PersistedState): Promise<void> {
  const db = await dbPromise;
  await db.put('state', state, 'current');
}

export function readTheme(): 'system' | 'light' | 'dark' {
  const value = localStorage.getItem('taskline-theme');
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function saveTheme(theme: 'system' | 'light' | 'dark'): void {
  localStorage.setItem('taskline-theme', theme);
}

export function exportState(state: PersistedState): string {
  const payload = {
    exportedAt: new Date().toISOString(),
    snapshot: state.snapshot
  };
  return JSON.stringify(payload, null, 2);
}

export function stripToken(config?: SyncConfig): Omit<SyncConfig, 'token'> | undefined {
  if (!config) return undefined;
  const { token: _token, ...safeConfig } = config;
  return safeConfig;
}

export function downloadText(filename: string, contents: string, type = 'application/json'): void {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
