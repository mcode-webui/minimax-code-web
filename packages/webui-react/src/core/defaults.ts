/**
 * core/defaults.ts —— 默认端口实现的装配点
 * ============================================================================
 * 【热插拔】createRegistry() 的默认后端。每个端口的具体实现分散在
 *   core/transport/* 与 core/services/* —— 本文件只负责组装，
 *   因此换供应商/换传输/换状态库只改对应子目录 + 这里的一行。
 * ============================================================================
 */

import type { Registry } from '../contracts/ports';

import { createHttpPort } from './transport/http-port';
import { createStreamPort } from './transport/stream-port';
import { createKvPort } from './store/kv-port';
import { createNotifierPort } from './services/notifier-port';
import { createSessionService } from './services/session-service';
import { createChatService } from './services/chat-service';
import { createModelService } from './services/model-service';
import { createWorkspaceService } from './services/workspace-service';
import { createSettingsService } from './services/settings-service';
import { createUsageService } from './services/usage-service';
import { createAlertsService } from './services/alerts-service';
import { createAuthService } from './services/auth-service';
import { createUploadService } from './services/upload-service';

export function createDefaultRegistry(): Registry {
  const kv = createKvPort();
  const http = createHttpPort({ kv });
  const stream = createStreamPort({ http, kv });
  const alerts = createAlertsService({ http, stream });
  const auth = createAuthService({ http, stream });
  const sessions = createSessionService({ http, stream, kv });
  // 注入 kv，使"自定义供应商"跨 reload 持久化（否则只活在当前页）。
  const models = createModelService({ http, sessions, kv });

  return {
    clock: { now: () => Date.now() },
    http,
    stream,
    kv,
    notifier: createNotifierPort(),
    sessions,
    chat: createChatService({ http, sessions }),
    models,
    workspace: createWorkspaceService({ http, kv }),
    settings: createSettingsService({ http, stream }),
    usage: createUsageService({ http }),
    alerts,
    auth,
    upload: createUploadService({ http }),
  };
}
