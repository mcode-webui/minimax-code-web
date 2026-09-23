/**
 * core/services/settings-service.ts —— SettingsServicePort 实现（服务端设置）
 * 【职责】GET /api/settings 取快照；POST /api/settings 更新白名单字段
 *   （lanBroadcast / lanBind / readOnly / tokenEnabled / resetToken /
 *   acknowledgeToken / trustedOrigins）；resetToken 发 {resetToken:true}，
 *   拿到新 token 后调 http.setToken 同步本地。
 * 【接缝】实现 contracts/ports.ts 的 SettingsServicePort；订阅 stream 的
 *   auth.token_rotated 控制帧，token 被服务端轮换时同步 http 身份（下一个请求生效）。
 */
import type { SettingsServicePort, StreamPort } from '../../contracts/ports';
import type { WireSettings } from '../../contracts/protocol';
import type { AuthedHttpPort } from '../transport/http-port';

export interface SettingsServiceDeps {
  http: AuthedHttpPort;
  stream: StreamPort;
}

/** 可写字段白名单：其余字段只读透传。 */
const PATCH_KEYS = [
  'lanBroadcast',
  'lanBind',
  'readOnly',
  'tokenEnabled',
  'resetToken',
  'acknowledgeToken',
  'trustedOrigins',
] as const;

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/** 取 control 帧的 {name, data}；其它帧返回 null。 */
function readControl(raw: unknown): { name: string; data: string } | null {
  const f = asRecord(raw);
  if (!f || f['type'] !== 'control') return null;
  const p = asRecord(f['payload']);
  if (!p) return null;
  const name = p['name'];
  const data = p['data'];
  if (typeof name !== 'string' || typeof data !== 'string') return null;
  return { name, data };
}

export function createSettingsService(deps: SettingsServiceDeps): SettingsServicePort {
  const { http, stream } = deps;
  let cache: WireSettings | null = null;

  function mergeIntoCache(patch: Record<string, unknown>): WireSettings {
    const next: WireSettings = { ...(cache ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'ok') continue;
      next[k] = v;
    }
    cache = next;
    return next;
  }

  // token 轮换：服务端广播 auth.token_rotated，本地身份必须立刻跟上
  stream.onFrame((raw) => {
    const ctrl = readControl(raw);
    if (!ctrl || ctrl.name !== 'auth.token_rotated') return;
    let next = '';
    try {
      const parsed: unknown = JSON.parse(ctrl.data);
      const o = asRecord(parsed);
      if (o) {
        const t = o['token'] ?? o['currentToken'];
        if (typeof t === 'string') next = t;
      } else if (typeof parsed === 'string') {
        next = parsed;
      }
    } catch {
      if (ctrl.data.trim()) next = ctrl.data.trim();
    }
    if (next) http.setToken(next);
  });

  return {
    async get(): Promise<WireSettings> {
      const res = await http.get<Record<string, unknown>>('/api/settings');
      return mergeIntoCache({ ...res });
    },

    async update(patch: Partial<WireSettings>): Promise<WireSettings> {
      const body: Record<string, unknown> = {};
      for (const key of PATCH_KEYS) {
        const v = (patch as Record<string, unknown>)[key];
        if (v !== undefined) body[key] = v;
      }
      const res = await http.post<Record<string, unknown>>('/api/settings', body);
      return mergeIntoCache({ ...body, ...res });
    },

    async resetToken(): Promise<{ token: string }> {
      const res = await http.post<Record<string, unknown>>('/api/settings', { resetToken: true });
      const token = typeof res['currentToken'] === 'string' ? res['currentToken'] : '';
      if (token) http.setToken(token); // 新 token 立即生效（含 WS 重连地址）
      mergeIntoCache({ ...res });
      return { token };
    },

    async acknowledgeToken(): Promise<void> {
      const res = await http.post<Record<string, unknown>>('/api/settings', { acknowledgeToken: true });
      mergeIntoCache({ ...res });
    },
  };
}
