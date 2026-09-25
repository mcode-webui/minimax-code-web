/**
 * ResizeHandle.tsx —— 面板宽度拖拽把手（通用原语）
 * ============================================================================
 * 哑组件：贴边 5px 热区，按住拖动 → onWidthChange(clamp 后的新宽度)，双击复位。
 * side：'right' = 把手在面板右缘（右拖变宽）；'left' = 左缘（左拖变宽，
 * 右侧栏用）。受控：width 由父级持有并持久化。
 * ============================================================================
 */

import { memo, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import './resizehandle.css';

export interface ResizeHandleProps {
  width: number;
  minWidth?: number;
  maxWidth?: number;
  onWidthChange: (width: number) => void;
  onReset?: () => void;
  /** 把手贴附边：'right'（默认）或 'left'。 */
  side?: 'left' | 'right';
  label?: string;
}

export const ResizeHandle = memo(function ResizeHandle({
  width,
  minWidth = 200,
  maxWidth = 800,
  onWidthChange,
  onReset,
  side = 'right',
  label = '拖拽调整宽度，双击复位',
}: ResizeHandleProps) {
  const widthRef = useRef(width);
  widthRef.current = width;
  const changeRef = useRef(onWidthChange);
  changeRef.current = onWidthChange;

  const handleMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = widthRef.current;
    const dir = side === 'left' ? -1 : 1; // 左缘把手：向左拖 = 变宽
    const move = (ev: MouseEvent): void => {
      changeRef.current(Math.min(maxWidth, Math.max(minWidth, w0 + dir * (ev.clientX - x0))));
    };
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div
      className={side === 'left' ? 'resize-handle resize-handle--left' : 'resize-handle'}
      title={label}
      aria-label={label}
      role="separator"
      aria-orientation="vertical"
      onMouseDown={handleMouseDown}
      onDoubleClick={onReset}
    />
  );
});
