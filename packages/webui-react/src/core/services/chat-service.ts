/**
 * core/services/chat-service.ts —— ChatServicePort 实现（发送 / 停止 / 斜杠命令）
 * 【职责】POST /api/send（content + attachments）、POST /api/stop、POST /api/cmd；
 *   发送成功后把用户消息追加进**该会话**切片的 messages 并置 inflightId；
 *   斜杠命令同样在**该会话**切片上回显一条用户消息（role:'user' + text 块），
 *   与 send() 的行为一致 —— UI 上斜杠命令也有输入记录。
 * 【接缝】实现 contracts/ports.ts 的 ChatServicePort；只写目标会话的切片
 *   （经 SessionService.update），绝不影响其它会话。端口经持有器每次用时现读，
 *   热替换后立即生效。
 */
import type { HttpPort, ChatServicePort } from '../../contracts/ports';
import type { ChatMessage, SessionId, TextBlock } from '../../contracts/domain';
import type { SessionService } from './session-service';

/** chat-service 用到的端口窄视图（持有器视图）。 */
export interface ChatPorts {
  http: HttpPort;
  sessions: SessionService;
}

export interface ChatServiceDeps {
  /** 端口持有器：字段每次用时现读 —— 热替换后立即生效，不在构造期捕获实例。 */
  ports: ChatPorts;
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
  const ports = deps.ports;

  /** 与 send() 一致的回显：把用户输入记成 role:'user' 的文本消息，落在该会话切片上。 */
  function echoUserMessage(sessionId: SessionId, text: string): void {
    const block: TextBlock = { id: makeId(), kind: 'text', text };
    const msg: ChatMessage = {
      id: makeId(),
      role: 'user',
      blocks: [block],
      ts: Date.now(),
      streaming: false,
    };
    ports.sessions.update(sessionId, (prev) => ({
      ...prev,
      messages: [...prev.messages, msg],
      // 注意：这里**不能**写 inflightId —— inflightId 只属于「正在流式接收的
      // assistant 占位消息」。用户消息一发出去就已定稿，把它塞进 inflightId
      // 会让 UI 误以为用户消息还在生成。这里只标记 running，真正的
      // inflightId 由流式翻译层在创建 assistant 占位块时设置。
      running: true,
    }));
  }

  return {
    async send(sessionId: SessionId, content: string, attachments?: string[]): Promise<void> {
      await ports.http.post('/api/send', { content, attachments: attachments ?? [] });
      echoUserMessage(sessionId, content);
    },

    async stop(sessionId: SessionId): Promise<void> {
      await ports.http.post('/api/stop', {});
      // 本地视图立即回到空闲；服务端 running 态随后由流帧校正
      ports.sessions.update(sessionId, (prev) => ({ ...prev, inflightId: null, running: false }));
    },

    async command(sessionId: SessionId, cmd: string): Promise<void> {
      // POST /api/cmd 保持 { cmd }（服务端按当前 cid 路由）；命令文本照常回显到该会话。
      await ports.http.post('/api/cmd', { cmd });
      echoUserMessage(sessionId, cmd);
    },
  };
}
