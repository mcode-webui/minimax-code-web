/**
 * core/services/chat-service.ts —— ChatServicePort 实现（发送 / 停止 / 斜杠命令）
 * 【职责】POST /api/send（content + attachments）、POST /api/stop、POST /api/cmd；
 *   发送成功后只做乐观 running 标记 —— 用户消息本身由服务端 handleSend /
 *   handleCmdCommand 追加到 cs.chat 并经 pushStateFor 广播（本地再 echo 会重复）。
 * 【接缝】实现 contracts/ports.ts 的 ChatServicePort；只写目标会话的切片
 *   （经 SessionService.update），绝不影响其它会话。端口经持有器每次用时现读，
 *   热替换后立即生效。
 */
import type { HttpPort, ChatServicePort } from '../../contracts/ports';
import type { SessionId } from '../../contracts/domain';
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

export function createChatService(deps: ChatServiceDeps): ChatServicePort {
  const ports = deps.ports;

  /**
   * 置 running 态（乐观）：服务端 handleSend/handleCmdCommand 会把用户消息追加到
   * cs.chat 并经 pushStateFor 广播 —— 本地再 echo 一条用户消息会与广播重复，
   * 造成「1 条消息显示 2 次」。所以这里只标记 running，不写 messages。
   */
  function markRunning(sessionId: SessionId): void {
    ports.sessions.update(sessionId, (prev) => ({ ...prev, running: true }));
  }

  return {
    async send(sessionId: SessionId, content: string, attachments?: string[]): Promise<void> {
      await ports.http.post('/api/send', { content, attachments: attachments ?? [] });
      markRunning(sessionId);
    },

    async stop(sessionId: SessionId): Promise<void> {
      await ports.http.post('/api/stop', {});
      // 本地视图立即回到空闲；服务端 running 态随后由流帧校正
      ports.sessions.update(sessionId, (prev) => ({ ...prev, inflightId: null, running: false }));
    },

    async command(sessionId: SessionId, cmd: string): Promise<void> {
      // POST /api/cmd 保持 { cmd }（服务端按当前 cid 路由）；命令文本由服务端广播回显。
      await ports.http.post('/api/cmd', { cmd });
      markRunning(sessionId);
    },
  };
}
