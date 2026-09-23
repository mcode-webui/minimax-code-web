/**
 * core/services/usage-service.ts —— UsageServicePort 实现（套餐用量 + 上下文消耗）
 * 【职责】GET /api/usage 取套餐额度快照 -> UsageInfo；POST /api/refresh 触发服务端重取；
 *   GET /api/usage-real 取每轮上下文消耗 -> ContextUsage（used/limit/percent/tps/
 *   cacheRead/model/source）。
 * 【接缝】实现 contracts/ports.ts 的 UsageServicePort；线上响应字段容错解析
 *   （不可信数据一律收窄后才进 domain 对象）。
 */
import type { HttpPort, UsageServicePort } from '../../contracts/ports';
import type { ContextUsage, SessionId, UsageInfo } from '../../contracts/domain';

/** usage-service 用到的端口窄视图（持有器视图）。 */
export interface UsagePorts {
  http: HttpPort;
}

export interface UsageServiceDeps {
  /** 端口持有器：字段每次用时现读 —— 热替换后立即生效，不在构造期捕获实例。 */
  ports: UsagePorts;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** weekly 字段可能是 "91%" / 91 / "unlimited" —— 一律收窄为百分比或 null。 */
function weeklyPercent(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = v.trim().replace(/%$/, '');
    const n = Number(m);
    return Number.isFinite(n) && m !== '' ? n : null;
  }
  return null;
}

export function createUsageService(deps: UsageServiceDeps): UsageServicePort {
  const ports = deps.ports;

  return {
    async quota(): Promise<UsageInfo> {
      // 走 POST：服务端 router 只给 /api/usage 注册了 POST 处理器（handleUsage），
      // GET 会 404。POST 语义是「触发拉取并返回缓存值」，正是这里要的。
      const res = asRecord(await ports.http.post('/api/usage', {})) ?? {};
      return {
        fiveHourPercent: num(res['fiveHourPercent'] ?? res['remaining']),
        weeklyPercent: weeklyPercent(res['weeklyPercent'] ?? res['weekly']),
        fetchedAt: num(res['fetchedAt']),
        source: typeof res['source'] === 'string' ? res['source'] : undefined,
        hidden: res['hidden'] === true ? true : undefined,
      };
    },

    async refresh(): Promise<void> {
      await ports.http.post('/api/refresh', {});
    },

    async context(_sessionId: SessionId): Promise<ContextUsage | null> {
      // usage-real 按 cid（运行时）统计，暂不区分 sessionId；签名保留会话语义
      const res = asRecord(await ports.http.get('/api/usage-real')) ?? {};
      const used = num(res['lastTurnContextTokens']);
      const limit = num(res['contextLimit']);
      if (used === null && limit === null) return null;
      const u = used ?? 0;
      const l = limit ?? 0;
      return {
        used: u,
        limit: l,
        percent: l > 0 ? Math.round((u * 100) / l) : 0,
        tps: num(res['tps']) ?? 0,
        cacheRead: num(res['lastCacheReadTokens']) ?? undefined,
        model: typeof res['model'] === 'string' ? res['model'] : undefined,
        source: typeof res['source'] === 'string' ? res['source'] : 'usage-real',
      };
    },
  };
}
