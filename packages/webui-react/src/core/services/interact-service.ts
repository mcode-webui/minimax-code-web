/**
 * core/services/interact-service.ts —— InteractServicePort 实现（模式互动）
 * 【职责】plan / planmode 应答走 POST /api/answer（服务端清对应状态并广播
 *   state）；权限模式走 GET /api/permissions-modes（目录）与 POST
 *   /api/permissions（切换 —— mcode 固定于启动时，服务端仅同步 UI 标签）。
 * 【接缝】实现 contracts/ports.ts 的 InteractServicePort。
 * 【边界】agree/add 的后续话术**不在这里** —— 文案本地化属于 UI 层，
 *   由容器经 chat.send 下发；传输层只搬状态。
 */
import type {
  HttpPort,
  InteractServicePort,
  PermissionModeOption,
} from '../../contracts/ports';

/** interact-service 用到的端口窄视图（持有器视图）。 */
export interface InteractPorts {
  http: HttpPort;
}

export interface InteractServiceDeps {
  /** 端口持有器：字段每次用时现读 —— 热替换后立即生效，不在构造期捕获实例。 */
  ports: InteractPorts;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function mapOption(raw: unknown): PermissionModeOption | null {
  const o = asRecord(raw);
  if (!o || typeof o['value'] !== 'string' || o['value'] === '') return null;
  return {
    value: o['value'],
    label: typeof o['label'] === 'string' ? o['label'] : o['value'],
    mcodeValue: typeof o['mcodeValue'] === 'string' ? o['mcodeValue'] : undefined,
  };
}

export function createInteractService(deps: InteractServiceDeps): InteractServicePort {
  const ports = deps.ports;
  return {
    async answerPlan(option, context) {
      await ports.http.post('/api/answer', { type: 'plan', option, context });
    },
    async answerPlanMode(choice) {
      await ports.http.post('/api/answer', { type: 'planmode', option: choice });
    },
    async permissionModes() {
      const raw = await ports.http.get('/api/permissions-modes');
      const o = asRecord(raw);
      const pick = (key: string): PermissionModeOption[] => {
        const list = o ? o[key] : null;
        if (!Array.isArray(list)) return [];
        return list.flatMap((entry) => {
          const mapped = mapOption(entry);
          return mapped ? [mapped] : [];
        });
      };
      return { webui: pick('webui'), mcode: pick('mcode') };
    },
    async setPermissionMode(mode) {
      await ports.http.post('/api/permissions', { mode });
    },
  };
}
