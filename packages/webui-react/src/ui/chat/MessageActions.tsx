/**
 * MessageActions.tsx —— 助手消息操作行（参考布局：复制 / 赞 / 踩 / 重试 + 时间戳）
 * ============================================================================
 * 哑组件 + 少量本地瞬态（copied 勾的 2s 回闪由内部 useState 管理）。
 *   - 复制：把消息纯文本写入剪贴板，成败经回调外抛（容器接 notifier）。
 *   - 赞 / 踩：互斥三态（无 → 赞 / 无 → 踩），本地 UI 态，由容器持有（按消息 id）。
 *   - 重试：仅当上层给 onRetry 时渲染（通常只挂在最后一条助手消息上）。
 *   - 时间：YY/MM/dd HH:mm:ss；历史消息无真实时间戳 → "--"。
 * ============================================================================
 */

import { memo, useState } from 'react';
import { IconButton } from '../primitives/IconButton';
import { formatMessageTime, messageTimeISO } from './time';
import './msgactions.css';

export type Feedback = 'like' | 'dislike' | null;

export interface MessageActionsProps {
  /** 消息 ts（毫秒）；序号占位 → 时间显示 "--"。 */
  ts: number;
  /** 取要复制的纯文本 —— 惰性：点击时才求值（渲染期不读 blocks/text getter）。 */
  getCopyText: () => string;
  /** 当前反馈态（容器持有，按消息 id）。 */
  feedback?: Feedback;
  onFeedback?: (next: Feedback) => void;
  /** 复制结果外抛（容器接 toast）。 */
  onCopyResult?: (ok: boolean) => void;
  /** 重试（重新生成）——仅最后一条助手消息传入。 */
  onRetry?: () => void;
  labels?: Partial<MessageActionsLabels>;
}

export interface MessageActionsLabels {
  copy: string;
  copied: string;
  like: string;
  dislike: string;
  retry: string;
}

const DEFAULT_LABELS: MessageActionsLabels = {
  copy: '复制',
  copied: '已复制',
  like: '有帮助',
  dislike: '没帮助',
  retry: '重试',
};

export const MessageActions = memo(function MessageActions({
  ts,
  getCopyText,
  feedback = null,
  onFeedback,
  onCopyResult,
  onRetry,
  labels,
}: MessageActionsProps) {
  const l: MessageActionsLabels = { ...DEFAULT_LABELS, ...labels };
  const [copied, setCopied] = useState(false);
  const time = formatMessageTime(ts);

  const handleCopy = (): void => {
    const done = (ok: boolean): void => {
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }
      onCopyResult?.(ok);
    };
    const p = navigator.clipboard?.writeText(getCopyText());
    if (p) {
      void p.then(() => done(true), () => done(false));
    } else {
      done(false);
    }
  };

  return (
    <div className="msgact">
      <IconButton
        icon={copied ? 'check' : 'copy'}
        label={copied ? l.copied : l.copy}
        onClick={handleCopy}
        active={copied}
      />
      <IconButton
        icon="thumb-up"
        label={l.like}
        active={feedback === 'like'}
        onClick={() => onFeedback?.(feedback === 'like' ? null : 'like')}
      />
      <IconButton
        icon="thumb-down"
        label={l.dislike}
        active={feedback === 'dislike'}
        onClick={() => onFeedback?.(feedback === 'dislike' ? null : 'dislike')}
      />
      {onRetry ? <IconButton icon="refresh" label={l.retry} onClick={onRetry} /> : null}
      <time className="msgact-time" dateTime={messageTimeISO(ts)}>
        {time ?? '--'}
      </time>
    </div>
  );
});
