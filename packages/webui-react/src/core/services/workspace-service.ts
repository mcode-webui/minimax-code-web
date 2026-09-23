/**
 * core/services/workspace-service.ts —— WorkspaceServicePort 实现（工作区）
 * 【职责】POST /api/workspace（dir + syncTui + action）切换/复位工作区；
 *   GET /api/workspace/browse 列目录；最近 5 个工作区经 kv 持久化。
 * 【接缝】实现 contracts/ports.ts 的 WorkspaceServicePort，另暴露 useTui()
 *   （action:'useTui'，跟随 mcode TUI 当前目录）作为端口的补充建议。
 */
import type { HttpPort, KeyValueStorePort, WorkspaceServicePort } from '../../contracts/ports';
import type { WorkspaceEntry, WorkspaceInfo } from '../../contracts/domain';

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

    async browse(path?: string): Promise<WorkspaceEntry[]> {
      const query = path ? '?path=' + encodeURIComponent(path) : '';
      const res = await ports.http.get<{ children?: unknown }>('/api/workspace/browse' + query);
      const out: WorkspaceEntry[] = [];
      if (Array.isArray(res.children)) {
        for (const raw of res.children) {
          const o = asRecord(raw);
          if (!o || typeof o['path'] !== 'string' || !o['path']) continue;
          out.push({
            name: typeof o['name'] === 'string' ? o['name'] : baseName(o['path']),
            path: o['path'],
            isDir: o['isDir'] === true,
          });
        }
      }
      return out;
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
