/**
 * core/defaults.ts —— 默认端口实现的装配点
 * ============================================================================
 * 【热插拔】createRegistry() 的默认后端。每个端口的具体实现分散在
 *   core/transport/* 与 core/services/* —— 本文件只负责组装，
 *   因此换供应商/换传输/换状态库只改对应子目录 + 这里的一行。
 *
 * 【热插拔时序】全部 service 只接收**同一个可变 ports holder**，且每次用到
 *   端口时才从 holder 现读字段（不在构造期解构捕获实例）。因此 replacePort /
 *   createRegistry 的覆盖只要**原地改写本 holder**（见 core/registry.ts 的
 *   Object.assign / 原地赋值），已创建的 service 立即用上新端口 —— 这就是
 *   "replacePort('notifier', …) 之后立即生效"的结构性保证。
 * ============================================================================
 */

import type { Registry } from '../contracts/ports';

import { createHttpPort } from './transport/http-port';
import type { AuthedHttpPort } from './transport/http-port';
import { createStreamPort } from './transport/stream-port';
import { createKvPort } from './store/kv-port';
import { createNotifierPort } from './services/notifier-port';
import { createSessionService } from './services/session-service';
import type { SessionService } from './services/session-service';
import { createChatService } from './services/chat-service';
import { createModelService } from './services/model-service';
import type { ModelService } from './services/model-service';
import { createWorkspaceService } from './services/workspace-service';
import type { WorkspaceService } from './services/workspace-service';
import { createSettingsService } from './services/settings-service';
import { createUsageService } from './services/usage-service';
import { createAlertsService } from './services/alerts-service';
import { createAuthService } from './services/auth-service';
import { createUploadService } from './services/upload-service';

/**
 * 可变端口持有器 = 装配出来的 Registry 本体。
 * 字段比 Registry 更宽：http 是带身份操作的 AuthedHttpPort，sessions/models/workspace
 * 是带扩展方法的实现类型 —— service 之间互引（chat -> sessions 等）也走这个持有器。
 */
export interface DefaultPorts extends Registry {
  http: AuthedHttpPort;
  sessions: SessionService;
  models: ModelService;
  workspace: WorkspaceService;
}

export function createDefaultRegistry(): DefaultPorts {
  // 先落 kv，其余字段按依赖顺序回填（service 之间经持有器互引，如 chat -> sessions）。
  // 用一次收窄赋值起步，随后逐字段回填到**同一个对象**上。
  const ports = { kv: createKvPort() } as DefaultPorts;
  ports.clock = { now: () => Date.now() };
  ports.http = createHttpPort({ ports });
  ports.stream = createStreamPort({ ports });
  // 默认 notifier 是 console 实现；ui 层经 replacePort('notifier', …) 原地换成 antd 实现。
  ports.notifier = createNotifierPort();
  ports.sessions = createSessionService({ ports });
  ports.chat = createChatService({ ports });
  // 注入 kv，使"自定义供应商"跨 reload 持久化（否则只活在当前页）。
  ports.models = createModelService({ ports });
  ports.workspace = createWorkspaceService({ ports });
  ports.settings = createSettingsService({ ports });
  ports.usage = createUsageService({ ports });
  ports.alerts = createAlertsService({ ports });
  ports.auth = createAuthService({ ports });
  ports.upload = createUploadService({ ports });
  return ports;
}
