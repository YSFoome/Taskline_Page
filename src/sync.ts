import { mergeSnapshots } from './merge';
import { parseSnapshot } from './schema';
import type { AppSnapshot, MergeConflict, SyncConfig } from './types';

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';

export class SyncError extends Error {
  status?: number;
  code: string;

  constructor(message: string, code = 'SYNC_ERROR', status?: number) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
    this.status = status;
  }
}

interface GithubContentResponse {
  content?: string;
  encoding?: string;
  sha?: string;
  html_url?: string;
  message?: string;
  status?: string;
  commit?: { html_url?: string };
}

export interface SyncSuccess {
  kind: 'success';
  snapshot: AppSnapshot;
  remoteSha?: string;
  commitUrl?: string;
}

export interface SyncConflict {
  kind: 'conflict';
  snapshot: AppSnapshot;
  remoteSha?: string;
  conflicts: MergeConflict[];
}

export type SyncPreview = SyncSuccess | SyncConflict;

export interface RemoteSnapshot {
  snapshot?: AppSnapshot;
  remoteSha?: string;
  commitUrl?: string;
}

function headers(token: string): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION
  };
}

function repoUrl(config: SyncConfig): string {
  return `${API_BASE}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
}

function contentUrl(config: SyncConfig): string {
  const path = config.path.split('/').map(encodeURIComponent).join('/');
  return `${repoUrl(config)}/contents/${path}`;
}

async function parseGithubResponse(response: Response): Promise<GithubContentResponse> {
  let body: GithubContentResponse = {};
  try {
    body = await response.json() as GithubContentResponse;
  } catch {
    // Keep a useful generic error below when GitHub sends an empty body.
  }
  if (!response.ok) {
    const status = response.status;
    const message = status === 401
      ? 'GitHub 令牌无效或已过期，请重新配置。'
      : status === 403
        ? 'GitHub 拒绝了请求，请检查令牌权限或 API 限流状态。'
        : status === 404
          ? '找不到仓库或数据文件，请检查设置。'
          : status === 409
            ? '远端文件刚刚被其他设备更新，请重新同步。'
            : body.message ?? `GitHub 请求失败（${status}）。`;
    throw new SyncError(message, status === 409 ? 'SHA_CONFLICT' : 'GITHUB_ERROR', status);
  }
  return body;
}

function decodeContent(content: string): string {
  const binary = atob(content.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeContent(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function validateConfig(config: SyncConfig): void {
  if (!config.owner || !config.repo || !config.branch || !config.path || !config.token) {
    throw new SyncError('请先完整填写 GitHub 仓库、分支、文件路径和令牌。', 'CONFIG_ERROR');
  }
}

export async function testGithubConnection(config: SyncConfig): Promise<void> {
  validateConfig(config);
  let response: Response;
  try {
    response = await fetch(repoUrl(config), { headers: headers(config.token) });
  } catch {
    throw new SyncError('网络不可用，无法连接 GitHub。', 'NETWORK_ERROR');
  }
  await parseGithubResponse(response);
}

async function getRemote(config: SyncConfig): Promise<{ snapshot?: AppSnapshot; sha?: string; htmlUrl?: string }> {
  validateConfig(config);
  let response: Response;
  try {
    response = await fetch(`${contentUrl(config)}?ref=${encodeURIComponent(config.branch)}`, { headers: headers(config.token) });
  } catch {
    throw new SyncError('网络不可用，本地数据没有变化，请稍后重试。', 'NETWORK_ERROR');
  }
  if (response.status === 404) return {};
  const payload = await parseGithubResponse(response);
  if (!payload.content) throw new SyncError('远端数据文件为空，无法同步。', 'INVALID_REMOTE');
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeContent(payload.content));
  } catch {
    throw new SyncError('远端数据文件不是有效 JSON，已停止同步以保护本地数据。', 'INVALID_REMOTE');
  }
  try {
    return { snapshot: parseSnapshot(parsed), sha: payload.sha, htmlUrl: payload.html_url };
  } catch {
    throw new SyncError('远端数据文件格式不受支持，已停止同步。', 'INVALID_REMOTE');
  }
}

export async function pullFromGithub(config: SyncConfig): Promise<RemoteSnapshot> {
  const remote = await getRemote(config);
  return { snapshot: remote.snapshot, remoteSha: remote.sha, commitUrl: remote.htmlUrl };
}

async function putRemote(config: SyncConfig, snapshot: AppSnapshot, sha?: string): Promise<{ sha?: string; htmlUrl?: string }> {
  const body: Record<string, unknown> = {
    message: `sync taskline from ${config.deviceName || 'device'}`,
    content: encodeContent(`${JSON.stringify({ snapshot }, null, 2)}\n`),
    branch: config.branch
  };
  if (sha) body.sha = sha;
  let response: Response;
  try {
    response = await fetch(contentUrl(config), {
      method: 'PUT',
      headers: { ...headers(config.token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch {
    throw new SyncError('网络不可用，合并结果已保留在本地。', 'NETWORK_ERROR');
  }
  const payload = await parseGithubResponse(response);
  const responsePayload = payload as unknown as { content?: string | { sha?: string }; sha?: string; html_url?: string; commit?: { html_url?: string } };
  const returnedSha = typeof responsePayload.content === 'object' ? responsePayload.content.sha : responsePayload.sha;
  return { sha: returnedSha, htmlUrl: responsePayload.commit?.html_url ?? responsePayload.html_url };
}

export async function syncWithGithub(
  config: SyncConfig,
  baseSnapshot: AppSnapshot,
  localSnapshot: AppSnapshot
): Promise<SyncPreview> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const remote = await getRemote(config);
    const remoteSnapshot = remote.snapshot ?? baseSnapshot;
    const { snapshot, conflicts } = mergeSnapshots(baseSnapshot, localSnapshot, remoteSnapshot);
    if (conflicts.length) return { kind: 'conflict', snapshot, remoteSha: remote.sha, conflicts };
    try {
      const result = await putRemote(config, snapshot, remote.sha);
      return { kind: 'success', snapshot, remoteSha: result.sha ?? remote.sha, commitUrl: result.htmlUrl };
    } catch (error) {
      if (!(error instanceof SyncError) || error.code !== 'SHA_CONFLICT' || attempt === 2) throw error;
    }
  }
  throw new SyncError('远端文件持续变化，请稍后再次同步。', 'SHA_CONFLICT');
}

export async function commitMergedSnapshot(config: SyncConfig, snapshot: AppSnapshot, remoteSha?: string): Promise<{ remoteSha?: string; commitUrl?: string }> {
  const result = await putRemote(config, snapshot, remoteSha);
  return { remoteSha: result.sha ?? remoteSha, commitUrl: result.htmlUrl };
}

export async function pushLocalToGithub(config: SyncConfig, snapshot: AppSnapshot, expectedRemoteSha?: string): Promise<{ remoteSha?: string; commitUrl?: string }> {
  const remote = await getRemote(config);
  if (expectedRemoteSha && remote.sha && expectedRemoteSha !== remote.sha) {
    throw new SyncError('GitHub 上的文件已经被更新。请先使用“合并同步”或“从远端拉取”，确认后再推送。', 'REMOTE_CHANGED');
  }
  const result = await putRemote(config, snapshot, remote.sha);
  return { remoteSha: result.sha ?? remote.sha, commitUrl: result.htmlUrl };
}
