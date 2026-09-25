/**
 * core/services/workspace-service.ts —— WorkspaceServicePort 实现（工作区）
 * 【职责】POST /api/workspace（dir + syncTui + action）切换/复位工作区；
 *   GET /api/workspace/browse 列目录；最近 5 个工作区经 kv 持久化。
 * 【接缝】实现 contracts/ports.ts 的 WorkspaceServicePort，另暴露 useTui()
 *   （action:'useTui'，跟随 mcode TUI 当前目录）作为端口的补充建议。
 */
import type { HttpPort, KeyValueStorePort, WorkspaceServicePort } from '../../contracts/ports';
import type {
  FsEntry,
  FsFileResult,
  FsListResult,
  GitBranches,
  GitStatus,
  WorkspaceBrowseResult,
  WorkspaceEntry,
  WorkspaceInfo,
  WorkspaceRecentEntry,
} from '../../contracts/domain';

/** workspace-service 用到的端口窄视图（持有器视图）。 */
export interface WorkspacePorts {
  http: HttpPort;
  kv: KeyValueStorePort;
}

export interface WorkspaceServiceDeps {
  /** 端口持有器：字段每次用时现读 —— 热替换后立即生效，不在构造期捕获实例。 */
  ports: WorkspacePorts;
}

/** 比端口更宽：补齐 /api/workspace 的 action:'useTui'。 */
export interface WorkspaceService extends WorkspaceServicePort {
  useTui(): Promise<WorkspaceInfo>;
}

const RECENTS_KEY = 'webui_recent_workspaces';
const RECENTS_MAX = 5;

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function toInfo(raw: unknown): WorkspaceInfo {
  const o = asRecord(raw) ?? {};
  const dir = typeof o['dir'] === 'string' ? o['dir'] : null;
  const tree = typeof o['treeState'] === 'string' ? o['treeState'] : typeof o['tree'] === 'string' ? o['tree'] : null;
  return {
    dir,
    branch: typeof o['branch'] === 'string' ? o['branch'] : null,
    tree,
  };
}

export function createWorkspaceService(deps: WorkspaceServiceDeps): WorkspaceService {
  const ports = deps.ports;
  let current: WorkspaceInfo | null = null;

  function recentsRead(): WorkspaceEntry[] {
    try {
      const raw = ports.kv.get(RECENTS_KEY);
      if (!raw) return [];
      const arr: unknown = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      const out: WorkspaceEntry[] = [];
      for (const item of arr) {
        const o = asRecord(item);
        if (!o || typeof o['path'] !== 'string' || !o['path']) continue;
        out.push({
          name: typeof o['name'] === 'string' && o['name'] ? o['name'] : baseName(o['path']),
          path: o['path'],
          isDir: true,
        });
      }
      return out.slice(0, RECENTS_MAX);
    } catch {
      return [];
    }
  }

  function recentsWrite(list: WorkspaceEntry[]): void {
    try {
      ports.kv.set(RECENTS_KEY, JSON.stringify(list.slice(0, RECENTS_MAX)));
    } catch {
      // 持久化失败不影响内存态
    }
  }

  async function postWorkspace(body: Record<string, unknown>): Promise<WorkspaceInfo> {
    const res = await ports.http.post('/api/workspace', body);
    current = toInfo(res);
    return current;
  }

  return {
    current(): WorkspaceInfo | null {
      return current;
    },

    async use(dir: string, syncTui?: boolean): Promise<WorkspaceInfo> {
      const info = await postWorkspace({ dir, syncTui: syncTui === true });
      this.addRecent(dir);
      return info;
    },

    async reset(): Promise<WorkspaceInfo> {
      return postWorkspace({ action: 'reset' });
    },

    async useTui(): Promise<WorkspaceInfo> {
      const info = await postWorkspace({ action: 'useTui' });
      if (info.dir) this.addRecent(info.dir);
      return info;
    },

    async browse(path?: string): Promise<WorkspaceBrowseResult> {
      const query = path ? '?path=' + encodeURIComponent(path) : '';
      const res = await ports.http.get<{ dir?: unknown; parent?: unknown; children?: unknown }>(
        '/api/workspace/browse' + query,
      );
      const entries: WorkspaceEntry[] = [];
      if (Array.isArray(res.children)) {
        for (const raw of res.children) {
          const o = asRecord(raw);
          if (!o || typeof o['path'] !== 'string' || !o['path']) continue;
          entries.push({
            name: typeof o['name'] === 'string' ? o['name'] : baseName(o['path']),
            path: o['path'],
            // browse 只枚举目录；旧服务端不带 isDir 键 —— 缺失即目录，逐级下钻才可用。
            isDir: o['isDir'] !== false,
          });
        }
      }
      return {
        // 服务端回传当前目录（无 path 时落到第一个允许根）；缺失时回落 path 或 null。
        dir: typeof res.dir === 'string' && res.dir ? res.dir : (path ?? null),
        parent: typeof res.parent === 'string' && res.parent ? res.parent : null,
        entries,
      };
    },

    async listRecent(): Promise<WorkspaceRecentEntry[]> {
      const res = await ports.http.get<{ items?: unknown }>('/api/workspace/recent?limit=20');
      const out: WorkspaceRecentEntry[] = [];
      if (Array.isArray(res.items)) {
        for (const raw of res.items) {
          const o = asRecord(raw);
          if (!o || typeof o['dir'] !== 'string' || !o['dir']) continue;
          out.push({
            name: typeof o['name'] === 'string' && o['name'] ? o['name'] : baseName(o['dir']),
            path: o['dir'],
            isDir: true,
            sessionCount: typeof o['sessionCount'] === 'number' ? o['sessionCount'] : undefined,
            lastActiveAt: typeof o['lastActiveAt'] === 'number' ? o['lastActiveAt'] : undefined,
          });
        }
      }
      return out;
    },

    async listDir(path: string): Promise<FsListResult> {
      const query = '?path=' + encodeURIComponent(path);
      const res = await ports.http.get<Record<string, unknown>>('/api/fs/read' + query);
      if (res['ok'] !== true) {
        return { ok: false, dir: path, parent: null, entries: [], error: typeof res['error'] === 'string' ? res['error'] : 'read failed' };
      }
      const entries: FsEntry[] = [];
      if (Array.isArray(res['entries'])) {
        for (const raw of res['entries']) {
          const o = asRecord(raw);
          if (!o || typeof o['path'] !== 'string' || !o['path'] || typeof o['name'] !== 'string') continue;
          entries.push({
            name: o['name'],
            path: o['path'],
            isDir: o['type'] !== 'file',
            size: typeof o['size'] === 'number' ? o['size'] : undefined,
            mtime: typeof o['mtime'] === 'number' ? o['mtime'] : undefined,
            mode: typeof o['mode'] === 'string' ? o['mode'] : undefined,
          });
        }
      }
      return {
        ok: true,
        dir: typeof res['path'] === 'string' ? res['path'] : path,
        parent: typeof res['parent'] === 'string' && res['parent'] ? res['parent'] : null,
        entries,
        home: typeof res['home'] === 'string' && res['home'] ? res['home'] : null,
      };
    },

    async readFile(path: string): Promise<FsFileResult> {
      const query = '?path=' + encodeURIComponent(path);
      const res = await ports.http.get<Record<string, unknown>>('/api/fs/file' + query);
      if (res['ok'] !== true || typeof res['content'] !== 'string') {
        return {
          ok: false,
          path,
          content: null,
          error: typeof res['error'] === 'string' ? res['error'] : 'read failed',
        };
      }
      return {
        ok: true,
        path: typeof res['path'] === 'string' ? res['path'] : path,
        content: res['content'],
        size: typeof res['size'] === 'number' ? res['size'] : undefined,
      };
    },

    async createDir(path: string): Promise<{ ok: boolean; error?: string }> {
      const res = await ports.http.post<Record<string, unknown>>('/api/fs/mkdir', { path });
      return {
        ok: res['ok'] === true,
        error: typeof res['error'] === 'string' ? res['error'] : undefined,
      };
    },

    async openInSystem(path: string, mode: 'file' | 'folder'): Promise<{ ok: boolean; error?: string }> {
      const res = await ports.http.post<Record<string, unknown>>('/api/fs/open', { path, mode });
      return {
        ok: res['ok'] === true,
        error: typeof res['error'] === 'string' ? res['error'] : undefined,
      };
    },

    rawFileUrl(path: string): string {
      return '/api/fs/raw?path=' + encodeURIComponent(path);
    },

    async gitStatus(dir: string): Promise<GitStatus> {
      const res = await ports.http.get<Record<string, unknown>>('/api/git/status?dir=' + encodeURIComponent(dir));
      return {
        ok: res['ok'] === true,
        isRepo: res['isRepo'] === true,
        branch: typeof res['branch'] === 'string' ? res['branch'] : null,
        upstream: typeof res['upstream'] === 'string' ? res['upstream'] : null,
        ahead: typeof res['ahead'] === 'number' ? res['ahead'] : 0,
        behind: typeof res['behind'] === 'number' ? res['behind'] : 0,
        files: Array.isArray(res['files'])
          ? (res['files'] as Array<Record<string, unknown>>).map((f) => ({
              x: typeof f['x'] === 'string' ? f['x'] : ' ',
              y: typeof f['y'] === 'string' ? f['y'] : ' ',
              path: typeof f['path'] === 'string' ? f['path'] : '',
              origPath: typeof f['origPath'] === 'string' ? f['origPath'] : null,
              staged: f['staged'] === true,
            }))
          : [],
        error: typeof res['error'] === 'string' ? res['error'] : undefined,
      };
    },

    async gitBranches(dir: string): Promise<GitBranches> {
      const res = await ports.http.get<Record<string, unknown>>('/api/git/branches?dir=' + encodeURIComponent(dir));
      return {
        ok: res['ok'] === true,
        error: typeof res['error'] === 'string' ? res['error'] : undefined,
        branches: Array.isArray(res['branches'])
          ? (res['branches'] as Array<Record<string, unknown>>).map((b) => ({
              name: typeof b['name'] === 'string' ? b['name'] : '',
              current: b['current'] === true,
            }))
          : [],
      };
    },

    async gitCheckout(dir: string, branch: string): Promise<{ ok: boolean; error?: string }> {
      const res = await ports.http.post<Record<string, unknown>>('/api/git/checkout', { dir, branch });
      return {
        ok: res['ok'] === true,
        error: typeof res['error'] === 'string' ? res['error'] : undefined,
      };
    },

    async gitDiff(dir: string, file: string): Promise<{ ok: boolean; diff: string; error?: string }> {
      const res = await ports.http.get<Record<string, unknown>>(
        '/api/git/diff?dir=' + encodeURIComponent(dir) + '&file=' + encodeURIComponent(file),
      );
      return {
        ok: res['ok'] === true,
        diff: typeof res['diff'] === 'string' ? res['diff'] : '',
        error: typeof res['error'] === 'string' ? res['error'] : undefined,
      };
    },

    recents(): WorkspaceEntry[] {
      return recentsRead();
    },

    addRecent(path: string): void {
      if (!path) return;
      const list = recentsRead().filter((e) => e.path !== path);
      list.unshift({ name: baseName(path), path, isDir: true });
      recentsWrite(list.slice(0, RECENTS_MAX));
    },
  };
}
