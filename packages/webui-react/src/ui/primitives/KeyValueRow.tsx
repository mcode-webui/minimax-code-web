import type { ReactNode } from 'react';
import './kv.css';

export interface KeyValueRowProps {
  /** 左侧标签。 */
  label: ReactNode;
  /** 右侧值。 */
  value: ReactNode;
  /** 值使用弱化色（原 UI 的 .kv-value.muted）。 */
  muted?: boolean;
  /** 跟在值后面的小徽标节点（如 mavis 模型徽标、缓存读徽标）。 */
  extra?: ReactNode;
  /** 为 true 时隐藏整行（保留 DOM，例如 WORKSPACE 段默认隐藏的分支/状态行）。 */
  hidden?: boolean;
}

/**
 * KeyValueRow —— 左标签右值一行。
 * 哑组件：只负责排版，不做任何 IO。
 */
export function KeyValueRow({ label, value, muted, extra, hidden }: KeyValueRowProps) {
  return (
    <div className="kv-row" hidden={hidden}>
      <span className="kv-label">{label}</span>
      <span className="kv-value-wrap">
        <span className={muted ? 'kv-value kv-value--muted' : 'kv-value'}>{value}</span>
        {extra != null && <span className="kv-extra">{extra}</span>}
      </span>
    </div>
  );
}
