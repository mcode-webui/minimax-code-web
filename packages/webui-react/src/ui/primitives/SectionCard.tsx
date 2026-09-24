import type { ReactNode } from 'react';
import './section.css';

export interface SectionCardProps {
  /** 分段小标题（原 UI 的 .right-section-title）。 */
  title: ReactNode;
  /** 标题行右侧的附加节点（如 CONTEXT 的数据源徽标）。 */
  extra?: ReactNode;
  /** 为 true 时整段隐藏（保留 DOM）。 */
  hidden?: boolean;
  children?: ReactNode;
}

/**
 * SectionCard —— 右栏那种带小标题的分段容器。
 * 哑组件：只做容器排版。
 */
export function SectionCard({ title, extra, hidden, children }: SectionCardProps) {
  return (
    <section className="section-card" hidden={hidden}>
      <div className="section-card-title">
        <span className="section-card-title-text">{title}</span>
        {extra != null && <span className="section-card-extra">{extra}</span>}
      </div>
      <div className="section-card-body">{children}</div>
    </section>
  );
}
