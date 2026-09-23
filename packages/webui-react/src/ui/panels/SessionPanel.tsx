import { KeyValueRow } from '../primitives/KeyValueRow';
import './SessionPanel.css';

export interface SessionPanelLabels {
  id: string;
  title: string;
}

export interface SessionPanelProps {
  /** 会话 id（原 UI 的 #r-session-id，等宽略大字）。 */
  sessionId: string;
  /** 会话标题。 */
  title: string;
  /** 标签文案覆盖（i18n 接缝）。 */
  labels?: Partial<SessionPanelLabels>;
}

const DEFAULT_LABELS: SessionPanelLabels = {
  id: 'ID',
  title: '\u6807\u9898',
};

/**
 * SessionPanel —— 右栏 SESSION 段内容：ID / 标题 两行。
 * 哑组件：只渲染 KeyValueRow。
 */
export function SessionPanel({ sessionId, title, labels }: SessionPanelProps) {
  const l: SessionPanelLabels = { ...DEFAULT_LABELS, ...labels };
  return (
    <div className="session-panel">
      <KeyValueRow label={l.id} value={sessionId} muted />
      <KeyValueRow label={l.title} value={title} muted />
    </div>
  );
}
