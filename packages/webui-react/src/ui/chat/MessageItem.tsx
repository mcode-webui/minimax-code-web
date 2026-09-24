/**
 * MessageItem.tsx —— 单条消息
 * ============================================================================
 * 哑组件：只吃 ChatMessage。用户消息右侧气泡；助手消息左侧品牌 logo 头像；
 * 系统消息居中弱化。消息体由 blocks/BlockView 按 kind 分发。
 * React.memo 包裹 + key 稳定（MessageList 用 message.id）→ 长列表块级复用。
 * ============================================================================
 */

import { memo } from 'react';
import type { ChatMessage } from '../../contracts/domain';
import { BlockView } from './blocks';
import './item.css';

export interface MessageItemProps {
  message: ChatMessage;
  /** 品牌 logo 地址（默认同 vanilla /brand-logo.png）。 */
  logoSrc?: string;
  /** ask-user 块的受控选中态透传（由上层按会话保存）。 */
  askSelectedIds?: readonly string[];
  onAskToggleOption?: (optionId: string) => void;
  onAskConfirm?: (optionIds: string[]) => void;
}

const ROLE_LABEL: Record<ChatMessage['role'], string> = {
  user: '你',
  assistant: 'MiniMax Code',
  system: '系统',
};

const DEFAULT_LOGO = '/brand-logo.png';

export const MessageItem = memo(function MessageItem({
  message,
  logoSrc = DEFAULT_LOGO,
  askSelectedIds,
  onAskToggleOption,
  onAskConfirm,
}: MessageItemProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  const avatar = isUser ? (
    <div className="msg-avatar msg-avatar--user" aria-hidden="true">
      {ROLE_LABEL.user}
    </div>
  ) : isSystem ? (
    <div className="msg-avatar msg-avatar--system" aria-hidden="true">
      系
    </div>
  ) : (
    <div className="msg-avatar" aria-hidden="true">
      <img className="msg-avatar-img" src={logoSrc} alt="MiniMax Code" />
    </div>
  );

  const body = (
    <div className="msg-body">
      {message.blocks.map((block) => (
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

  const roleClass =
    message.role === 'user' ? 'msg msg--user' : isSystem ? 'msg msg--system' : 'msg msg--assistant';

  return (
    <article className={roleClass} data-message-id={message.id}>
      {isSystem ? null : avatar}
      <div className="msg-content">
        {isSystem ? null : <div className="msg-role">{ROLE_LABEL[message.role]}</div>}
        {isUser ? <div className="msg-bubble">{body}</div> : body}
      </div>
    </article>
  );
});
