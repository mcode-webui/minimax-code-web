/**
 * core/services/chat-service.ts —— ChatServicePort 实现（发送 / 停止 / 斜杠命令）
 * 【职责】POST /api/send（content + attachments）、POST /api/stop、POST /api/cmd；
 *   发送成功后把用户消息追加进**该会话**切片的 messages 并置 inflightId。
 * 【接缝】实现 contracts/ports.ts 的 ChatServicePort；只写目标会话的切片
 *   （经 SessionService.update），绝不影响其它会话。
 */
import type { HttpPort, ChatServicePort } from '../../contracts/ports';
import type { ChatMessage, SessionId, TextBlock } from '../../contracts/domain';
import type { SessionService } from './session-service';

export interface ChatServiceDeps {
  http: HttpPort;
  sessions: SessionService;
}

function makeId(): string {
  const c: unknown = typeof globalThis !== 'undefined' ? (globalThis as { crypto?: unknown }).crypto : undefined;
  if (typeof c === 'object' && c !== null) {
    const gen = (c as { randomUUID?: unknown }).randomUUID;
    if (typeof gen === 'function') return String(gen.call(c));
  }
  return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function createChatService(deps: ChatServiceDeps): ChatServicePort {
  const { http, sessions } = deps;

  return {
    async send(sessionId: SessionId, content: string, attachments?: string[]): Promise<void> {
      await http.post('/api/send', { content, attachments: attachments ?? [] });
      const block: TextBlock = { id: makeId(), kind: 'text', text: content };
      const msg: ChatMessage = {
        id: makeId(),
        role: 'user',
        blocks: [block],
        ts: Date.now(),
        streaming: false,
      };
      sessions.update(sessionId, (prev) => ({
        ...prev,
        messages: [...prev.messages, msg],
        inflightId: msg.id,
      }));
    },

    async stop(sessionId: SessionId): Promise<void> {
      await http.post('/api/stop', {});
      // 本地视图立即回到空闲；服务端 running 态随后由流帧校正
      sessions.update(sessionId, (prev) => ({ ...prev, inflightId: null, running: false }));
    },

    async command(_sessionId: SessionId, cmd: string): Promise<void> {
      await http.post('/api/cmd', { cmd });
    },
  };
}
