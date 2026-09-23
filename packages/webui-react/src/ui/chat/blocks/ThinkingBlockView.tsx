/**
 * blocks/ThinkingBlockView.tsx —— 思考块
 * 可折叠（<details> 无状态折叠，组件自身不持久化任何状态）、等宽字体、灰底。
 */

import { memo } from 'react';
import type { ThinkingBlock } from '../../../contracts/domain';
import './blocks.css';

export interface ThinkingBlockViewProps {
  block: ThinkingBlock;
}

export const ThinkingBlockView = memo(function ThinkingBlockView({ block }: ThinkingBlockViewProps) {
  return (
    <details className="blk-collapsible blk-thinking">
      <summary>
        <span className="blk-caret">▶</span>
        <span className="blk-thinking-label">{block.done === false ? '思考中' : '思考过程'}</span>
        <span className="blk-thinking-count">{block.text.length} 字</span>
      </summary>
      <pre className="blk-thinking-body">{block.text}</pre>
    </details>
  );
});
