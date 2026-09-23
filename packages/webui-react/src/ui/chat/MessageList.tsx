/**
 * MessageList.tsx —— 消息流滚动列表（哑组件）
 * ============================================================================
 * 职责单一：滚动消息列表 + 自动滚底 + 会话隔离的滚动位置。
 *   - 自动滚到底部；用户上滚离开底部后暂停自动滚动，回到底部后恢复
 *     （判定逻辑参照 packages/webui/public/app/chat-virtual-list.js 的
 *      isNearBottom / decideScrollBehavior 思路，纯阈值计算）。
 *   - onScrollBottomChange：跨越"贴底"阈值时回调一次，供上层决定是否
 *     在流式期间继续跟随。
 *   - 会话隔离：滚动位置用 useRef<Map<sessionKey, scrollTop>> 按 key 保存，
 *     切会话恢复各自的滚动位置，绝不跨会话复用（也无任何草稿状态）。
 *   - 性能：key = message.id 稳定；MessageItem / 各块视图全部 React.memo，
 *     流式重渲染只影响变化的块（对应 chat-virtual-list.js 注释里"块级 memo"
 *     的简单性能优化路线，暂不做窗口虚拟化）。
 * ============================================================================
 */

import { memo, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { UIEvent } from 'react';
import type { ChatMessage } from '../../contracts/domain';
import { MessageItem } from './MessageItem';
import { ThinkingBar } from './ThinkingBar';
import { EmptyState } from './EmptyState';
import './list.css';

/** "贴底"判定的像素阈值（对齐 chat-virtual-list.js 的 NEAR_BOTTOM_PX）。 */
const NEAR_BOTTOM_PX = 50;

function isNearBottom(scrollTop: number, clientHeight: number, scrollHeight: number): boolean {
  if (scrollHeight <= 0) return true;
  return scrollTop + clientHeight >= scrollHeight - NEAR_BOTTOM_PX;
}

export interface MessageListProps {
  messages: ChatMessage[];
  /** 是否有进行中的流式输出（显示"思考中"指示并维持自动滚底）。 */
  streaming: boolean;
  /** 跨越"贴底"阈值时回调（true=在底部 / false=用户上滚离开底部）。 */
  onScrollBottomChange?: (atBottom: boolean) => void;
  /** 会话隔离键（通常传 sessionId）：滚动位置按 key 分别保存。 */
  sessionKey?: string;
  /** 品牌 logo 地址（头像 / 欢迎空态）。 */
  logoSrc?: string;
  /** ask-user 块交互回调透传（由上层按会话处理，组件自身不保存）。 */
  askSelectedIds?: readonly string[];
  onAskToggleOption?: (optionId: string) => void;
  onAskConfirm?: (optionIds: string[]) => void;
}

export const MessageList = memo(function MessageList({
  messages,
  streaming,
  onScrollBottomChange,
  sessionKey = '',
  logoSrc,
  askSelectedIds,
  onAskToggleOption,
  onAskConfirm,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 用户是否"贴底"（贴底才自动跟随）。 */
  const stickRef = useRef(true);
  /** 上次通知上层的贴底状态（只为跨阈值时通知一次）。 */
  const notifiedRef = useRef(true);
  /** 会话隔离：每个 sessionKey 一份滚动位置。 */
  const offsetsRef = useRef(new Map<string, number>());
  /** 回调走 ref，避免因回调身份变化重绑滚动逻辑。 */
  const cbRef = useRef(onScrollBottomChange);
  useEffect(() => {
    cbRef.current = onScrollBottomChange;
  }, [onScrollBottomChange]);

  // 自动滚到底部（用户上滚后暂停：stickRef=false）。
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  // 会话隔离：切换 sessionKey 恢复该会话自己的滚动位置（没有记录则贴底）。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const saved = offsetsRef.current.get(sessionKey);
    el.scrollTop = saved !== undefined ? saved : el.scrollHeight;
    stickRef.current = isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
    notifiedRef.current = stickRef.current;
  }, [sessionKey]);

  const handleScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      offsetsRef.current.set(sessionKey, el.scrollTop);
      const near = isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
      stickRef.current = near;
      if (near !== notifiedRef.current) {
        notifiedRef.current = near;
        const cb = cbRef.current;
        if (cb !== undefined) cb(near);
      }
    },
    [sessionKey],
  );

  const showEmpty = messages.length === 0 && !streaming;

  return (
    <div className="msg-list" ref={scrollRef} onScroll={handleScroll}>
      {showEmpty ? (
        <EmptyState logoSrc={logoSrc} />
      ) : (
        <div className="msg-list-inner">
          {messages.map((m) => (
            <MessageItem
              key={m.id}
              message={m}
              logoSrc={logoSrc}
              askSelectedIds={askSelectedIds}
              onAskToggleOption={onAskToggleOption}
              onAskConfirm={onAskConfirm}
            />
          ))}
          {streaming ? <ThinkingBar logoSrc={logoSrc} /> : null}
        </div>
      )}
    </div>
  );
});
