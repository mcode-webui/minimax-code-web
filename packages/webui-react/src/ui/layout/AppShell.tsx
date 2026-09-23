import type { ReactNode } from 'react';
import './shell.css';

export interface AppShellProps {
  /** 顶栏插槽（TopBar）。 */
  topbar?: ReactNode;
  /** 左栏插槽（LeftPanel）。 */
  left?: ReactNode;
  /** 中栏插槽（ChatArea）。 */
  chat?: ReactNode;
  /** 右栏插槽（RightPanel）。 */
  right?: ReactNode;
  /** 移动端左抽屉是否展开（由上层状态传入）。 */
  leftOpen?: boolean;
  /** 移动端右抽屉是否展开（由上层状态传入）。 */
  rightOpen?: boolean;
  /** 点击遮罩（上层用于关闭抽屉）。 */
  onBackdropClick?: () => void;
  /** 自定义遮罩文案（无障碍）。 */
  backdropLabel?: string;
}

/**
 * AppShell —— 三栏骨架：topbar + (left | chat | right)。
 * 处理移动端抽屉：leftOpen / rightOpen 由 props 传入，遮罩点击经回调上抛。
 * 哑组件：四个区块均为插槽，本组件只负责布局与遮罩。
 */
export function AppShell(props: AppShellProps) {
  const { topbar, left, chat, right, leftOpen = false, rightOpen = false, onBackdropClick, backdropLabel = '\u5173\u95ed\u4fa7\u8fb9\u680f' } = props;
  const showBackdrop = leftOpen || rightOpen;

  return (
    <div className="app-shell">
      {topbar && <div className="app-shell-topbar">{topbar}</div>}
      <div className="app-shell-body">
        {left}
        {chat}
        {right}
        <div
          className={showBackdrop ? 'drawer-backdrop drawer-backdrop--show' : 'drawer-backdrop'}
          aria-label={backdropLabel}
          onClick={onBackdropClick}
        />
      </div>
    </div>
  );
}
