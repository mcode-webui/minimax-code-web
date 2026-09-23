import type { MouseEventHandler, ReactNode } from 'react';
import './chip.css';

/** 胶囊语义色（全部映射到 tokens.css 的语义变量，禁止硬编码颜色）。 */
export type ChipTone = 'neutral' | 'on' | 'warn' | 'danger';

export interface ChipProps {
  /** 左侧小图标节点。 */
  icon?: ReactNode;
  /** 主文字。 */
  label?: ReactNode;
  /** 右侧数值/状态。 */
  value?: ReactNode;
  /** 语义色。默认 neutral。 */
  tone?: ChipTone;
  /** 传入即渲染为可点按钮；不传则为纯展示。 */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  title?: string;
  /** 为 true 时整体隐藏（保留 DOM，便于测试与状态保持）。 */
  hidden?: boolean;
}

/**
 * Chip —— 小圆角状态胶囊。
 * 哑组件：数据 props 进，交互 onClick 出；不做任何 IO。
 */
export function Chip({ icon, label, value, tone = 'neutral', onClick, title, hidden }: ChipProps) {
  const className = 'chip chip--' + tone + (onClick ? ' chip--button' : '');
  const content = (
    <>
      {icon != null && <span className="chip-icon">{icon}</span>}
      {label != null && <span className="chip-label">{label}</span>}
      {value != null && <span className="chip-value">{value}</span>}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={className} title={title} hidden={hidden} onClick={onClick}>
        {content}
      </button>
    );
  }
  return (
    <span className={className} title={title} hidden={hidden}>
      {content}
    </span>
  );
}
