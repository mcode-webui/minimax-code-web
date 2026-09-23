/**
 * core/services/model-service.ts —— ModelServicePort 实现（供应商 / 模型 / 思考强度 三段切换）
 * 【职责】GET /api/models 取模型目录 {models,current}；providers() 由目录按 provider
 *   去重派生并合并 kv 持久化的自定义供应商；setProvider/setModel 走 POST /api/set-model；
 *   setThinking 更新该会话切片 selection.thinking 并同样发一次 set-model（服务端暂未
 *   实现 thinking，但契约保留）。三段选择按会话独立保存在各自切片里。
 * 【接缝】实现 contracts/ports.ts 的 ModelServicePort；切片读写走 SessionService，
 *   自定义供应商列表走 KeyValueStorePort（webui_custom_providers）。
 */
import type { HttpPort, ModelServicePort } from '../../contracts/ports';
import type {
  ModelOption,
  ModelSelection,
  ProviderId,
  ProviderOption,
  SessionId,
  ThinkingEffort,
} from '../../contracts/domain';
import { THINKING_EFFORTS, splitModelId } from '../../contracts/domain';
import type { KeyValueStorePort } from '../../contracts/ports';
import type { SessionService } from './session-service';

/** model-service 用到的端口窄视图（持有器视图）。 */
export interface ModelPorts {
  http: HttpPort;
  sessions: SessionService;
  /** 自定义供应商的持久化（持有器未提供则退化为内存，重启即失）。 */
  kv?: KeyValueStorePort;
}

export interface ModelServiceDeps {
  /** 端口持有器：字段每次用时现读 —— 热替换后立即生效，不在构造期捕获实例。 */
  ports: ModelPorts;
}

/** 比端口更宽：自定义供应商的管理留给设置面板。 */
export interface ModelService extends ModelServicePort {
  addCustomProvider(option: ProviderOption): void;
  removeCustomProvider(id: ProviderId): void;
  customProviders(): ProviderOption[];
}

interface Catalog {
  models: ModelOption[];
  current: string;
  hint: string | undefined;
}

const CUSTOM_PROVIDERS_KEY = 'webui_custom_providers';

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

export function createModelService(deps: ModelServiceDeps): ModelService {
  const ports = deps.ports;
  // 无 kv 注入时降级为进程内存储（自定义供应商不跨 reload）
  const memoryKv = new Map<string, string>();
  const memoryKvPort: KeyValueStorePort = {
    get: (k) => memoryKv.get(k) ?? null,
    set: (k, v) => void memoryKv.set(k, v),
    remove: (k) => void memoryKv.delete(k),
  };
  /** kv 用时现读 —— 持有器上被热替换后立即生效。 */
  function kv(): KeyValueStorePort {
    return ports.kv ?? memoryKvPort;
  }

  function readCustomProviders(): ProviderOption[] {
    try {
      const raw = kv().get(CUSTOM_PROVIDERS_KEY);
      if (!raw) return [];
      const arr: unknown = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      const out: ProviderOption[] = [];
      for (const item of arr) {
        const o = asRecord(item);
        if (!o || typeof o['id'] !== 'string' || !o['id']) continue;
        out.push({
          id: o['id'],
          label: typeof o['label'] === 'string' && o['label'] ? o['label'] : o['id'],
          hint: typeof o['hint'] === 'string' ? o['hint'] : undefined,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  function writeCustomProviders(list: ProviderOption[]): void {
    try {
      kv().set(CUSTOM_PROVIDERS_KEY, JSON.stringify(list));
    } catch {
      // 持久化失败不影响内存态
    }
  }

  async function fetchCatalog(): Promise<Catalog> {
    const res = await ports.http.get<{ models?: unknown; current?: unknown; hint?: unknown }>('/api/models');
    const models: ModelOption[] = [];
    if (Array.isArray(res.models)) {
      for (const raw of res.models) {
        const o = asRecord(raw);
        if (!o || typeof o['id'] !== 'string' || !o['id']) continue;
        const id = o['id'];
        const provider = typeof o['provider'] === 'string' && o['provider'] ? o['provider'] : splitModelId(id);
        models.push({
          id,
          label: typeof o['label'] === 'string' && o['label'] ? o['label'] : id,
          provider,
          contextLimit: typeof o['contextLimit'] === 'number' ? o['contextLimit'] : undefined,
        });
      }
    }
    const current = typeof res.current === 'string' ? res.current : '';
    const hint = typeof res.hint === 'string' ? res.hint : undefined;

    // 目录带回的 current 补齐「还没选过模型」的会话切片（不覆盖已有选择）
    if (current) {
      for (const id of ports.sessions.ids()) {
        const s = ports.sessions.slice(id);
        if (!s.selection.model) {
          ports.sessions.update(id, {
            selection: { ...s.selection, model: current, provider: splitModelId(current, s.selection.provider) },
          });
        }
      }
    }
    return { models, current, hint };
  }

  return {
    async providers(): Promise<ProviderOption[]> {
      const catalog = await fetchCatalog();
      const merged = new Map<ProviderId, ProviderOption>();
      for (const m of catalog.models) {
        if (!merged.has(m.provider)) merged.set(m.provider, { id: m.provider, label: m.provider, hint: catalog.hint });
      }
      for (const custom of readCustomProviders()) {
        merged.set(custom.id, custom); // 自定义项可覆盖派生项的 label/hint
      }
      return [...merged.values()];
    },

    async models(provider?: string): Promise<ModelOption[]> {
      const catalog = await fetchCatalog();
      if (!provider) return catalog.models;
      return catalog.models.filter((m) => m.provider === provider);
    },

    current(sessionId: SessionId): ModelSelection {
      return ports.sessions.slice(sessionId).selection;
    },

    async setProvider(sessionId: SessionId, provider: string): Promise<ModelSelection> {
      const sel = ports.sessions.slice(sessionId).selection;
      const list = await this.models(provider);
      // 回落到该供应商第一个模型；该供应商暂无模型时保留原模型（仍发 set-model 保契约）
      const modelId = list[0]?.id ?? sel.model;
      await ports.http.post('/api/set-model', { model: modelId });
      const next: ModelSelection = { ...sel, provider, model: modelId };
      ports.sessions.update(sessionId, { selection: next });
      return next;
    },

    async setModel(sessionId: SessionId, modelId: string): Promise<ModelSelection> {
      const sel = ports.sessions.slice(sessionId).selection;
      await ports.http.post('/api/set-model', { model: modelId });
      const next: ModelSelection = {
        ...sel,
        model: modelId,
        provider: splitModelId(modelId, sel.provider),
      };
      ports.sessions.update(sessionId, { selection: next });
      return next;
    },

    async setThinking(sessionId: SessionId, effort: ThinkingEffort): Promise<ModelSelection> {
      const safe: ThinkingEffort = (THINKING_EFFORTS as readonly string[]).includes(effort) ? effort : 'medium';
      const sel = ports.sessions.slice(sessionId).selection;
      // thinking 是本地契约字段：先落切片，服务端未实现也保留 set-model 调用
      const next: ModelSelection = { ...sel, thinking: safe };
      ports.sessions.update(sessionId, { selection: next });
      try {
        await ports.http.post('/api/set-model', { model: next.model });
      } catch {
        // 服务端暂不感知 thinking —— 不阻塞本地选择
      }
      return next;
    },

    addCustomProvider(option: ProviderOption): void {
      const list = readCustomProviders().filter((p) => p.id !== option.id);
      list.push(option);
      writeCustomProviders(list);
    },

    removeCustomProvider(id: ProviderId): void {
      writeCustomProviders(readCustomProviders().filter((p) => p.id !== id));
    },

    customProviders(): ProviderOption[] {
      return readCustomProviders();
    },
  };
}
