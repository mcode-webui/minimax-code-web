/**
 * MessageItem.tsx —— 单条消息（参考布局版）
 * ============================================================================
 * 哑组件：只吃 ChatMessage + 少量交互回调。三种角色三种形态（对齐参考布局）：
 *   - user：右侧灰色圆角气泡，无头像、无角色名；气泡下方右侧一小行时间。
 *   - assistant：左对齐纯文本，无头像、无气泡；上方可挂执行状态条（ExecStatusRow，
 *     由容器决定挂哪条），下方操作行（复制/赞/踩/重试 + 时间，MessageActions）。
 *   - system：居中弱化细文本。
 * 消息体由 blocks/BlockView 按 kind 分发；React.memo + key 稳定（message.id）。
 * ============================================================================
 */

import { memo } from 'react';
import type { ChatMessage } from '../../contracts/domain';
import { BlockView } from './blocks';
import { ExecStatusRow, type ExecStats } from './ExecStatusRow';
import { MessageActions, type Feedback } from './MessageActions';
import { formatMessageTime, messageTimeISO } from './time';
import './item.css';

export interface MessageItemProps {
  message: ChatMessage;
  /** ask-user 块的受控选中态透传（由上层按会话保存）。 */
  askSelectedIds?: readonly string[];
  onAskToggleOption?: (optionId: string) => void;
  onAskConfirm?: (optionIds: string[]) => void;
  /** 执行状态条数据 —— 仅当回合（最后一条）助手消息由容器传入。 */
  execStats?: ExecStats | null;
  /** 赞/踩反馈态（容器按消息 id 持有）。 */
  feedback?: Feedback;
  onFeedback?: (messageId: string, next: Feedback) => void;
  /** 复制结果外抛（容器接 toast）。 */
  onCopyResult?: (ok: boolean) => void;
  /** 重试（重新生成）—— 仅最后一条助手消息由容器传入。 */
  onRetry?: () => void;
}

/**
 * 提取消息纯文本（复制用）：拼接 text / thinking 块的内容。
 * 吃 blocks 数组而非 message —— 配合惰性求值，保证渲染期不重复读 blocks getter。
 */
function messagePlainText(blocks: ChatMessage['blocks']): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'text' || b.kind === 'thinking') parts.push(b.text);
  }
  return parts.join('\n');
}

export const MessageItem = memo(function MessageItem({
  message,
  askSelectedIds,
  onAskToggleOption,
  onAskConfirm,
  execStats = null,
  feedback = null,
  onFeedback,
  onCopyResult,
  onRetry,
}: MessageItemProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const time = formatMessageTime(message.ts);
  // 契约：blocks getter 每次渲染只读一次（块级 memo 性能测试靠它探测重渲染）。
  const blocks = message.blocks;

  const body = (
    <div className="msg-body">
      {blocks.map((block) => (
        <BlockView
          key={block.id}
          block={block}
          askSelectedIds={askSelectedIds}
          onAskToggleOption={onAskToggleOption}
          onAskConfirm={onAskConfirm}
        />
      ))}
      {message.streaming === true ? <span className="msg-cursor">▍</span> : null}
    </div>
  );

  if (isSystem) {
    return (
      <article className="msg msg--system" data-message-id={message.id}>
        {body}
      </article>
    );
  }

  if (isUser) {
    return (
      <article className="msg msg--user" data-message-id={message.id}>
        <div className="msg-bubble">{body}</div>
        <div className="msg-meta">
          <time className="msg-meta-time" dateTime={messageTimeISO(message.ts)}>
            {time ?? '--'}
          </time>
        </div>
      </article>
    );
  }

  return (
    <article className="msg msg--assistant" data-message-id={message.id}>
      {execStats ? <ExecStatusRow stats={execStats} /> : null}
      {body}
      <MessageActions
        ts={message.ts}
        getCopyText={() => messagePlainText(blocks)}
        feedback={feedback}
        onFeedback={(next) => onFeedback?.(message.id, next)}
        onCopyResult={onCopyResult}
        onRetry={onRetry}
      />
    </article>
  );
});
