/**
 * blocks/ErrorBlockView.tsx —— 错误块（红框）
 */

import { memo } from 'react';
import type { ErrorBlock } from '../../../contracts/domain';
import './blocks.css';

export interface ErrorBlockViewProps {
  block: ErrorBlock;
}

export const ErrorBlockView = memo(function ErrorBlockView({ block }: ErrorBlockViewProps) {
  return (
    <div className="blk-error">
      <div className="blk-error-label">错误</div>
      <div className="blk-error-text">{block.text}</div>
    </div>
  );
});
