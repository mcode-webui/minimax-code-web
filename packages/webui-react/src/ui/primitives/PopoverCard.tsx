import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import './popover.css';

/** 弹层相对锚点的期望方位；空间不足时自动翻转到对侧。 */
export type PopoverPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface PopoverCardProps {
  /** 是否展开（受控）。 */
  open: boolean;
  /** 展开态变化回调：点外部 / Esc 时会传出 false。 */
  onOpenChange: (open: boolean) => void;
  /** 锚点节点（例如 MenuRow / Chip）。 */
  anchor?: ReactNode;
  children?: ReactNode;
  /** 期望方位，默认 bottom；空间不足时自动翻转。 */
  placement?: PopoverPlacement;
}

const FLIP: Record<PopoverPlacement, PopoverPlacement> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

/**
 * PopoverCard —— 锚定弹层，向上/向下（或左/右）空间不足时自动翻转。
 * 哑组件：只负责定位与"点外部/Esc 关闭"的事件上抛，内容由 children 提供。
 * 打开/关闭由父层通过 open 受控（锚点点击由父层自行 toggle）。
 */
export function PopoverCard({ open, onOpenChange, anchor, children, placement = 'bottom' }: PopoverCardProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [resolved, setResolved] = useState<PopoverPlacement>(placement);

  // 自动翻转：按锚点与视口的剩余空间决定最终方位（首选方位放不下且对侧更宽裕时翻转）。
  useLayoutEffect(() => {
    if (!open) {
      setResolved(placement);
      return;
    }
    const anchorEl = anchorRef.current;
    const cardEl = cardRef.current;
    if (!anchorEl || !cardEl) return;
    const a = anchorEl.getBoundingClientRect();
    const c = cardEl.getBoundingClientRect();
    const gap = 8;
    const vertical = placement === 'top' || placement === 'bottom';
    const needed = vertical ? c.height : c.width;
    // 某一侧的剩余可用空间。
    const roomFor = (side: PopoverPlacement): number => {
      if (side === 'bottom') return window.innerHeight - a.bottom - gap;
      if (side === 'top') return a.top - gap;
      if (side === 'right') return window.innerWidth - a.right - gap;
      return a.left - gap;
    };
    const primary = roomFor(placement);
    const opposite = FLIP[placement];
    const secondary = roomFor(opposite);
    const next = primary < needed && secondary > primary ? opposite : placement;
    setResolved((prev) => (prev === next ? prev : next));
  }, [open, placement]);

  // 点外部 / Esc → onOpenChange(false)。锚点与弹层同属 root，不视为"外部"。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const root = rootRef.current;
      const target = e.target;
      if (root && target instanceof Node && !root.contains(target)) onOpenChange(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onOpenChange]);

  return (
    <div className="popover-root" ref={rootRef}>
      <span className="popover-anchor" ref={anchorRef}>
        {anchor}
      </span>
      {open && (
        <div className={'popover-card popover-card--' + resolved} ref={cardRef} role="dialog">
          {children}
        </div>
      )}
    </div>
  );
}