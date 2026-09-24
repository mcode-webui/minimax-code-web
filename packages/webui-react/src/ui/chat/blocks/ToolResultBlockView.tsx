/**
 * blocks/ToolResultBlockView.tsx —— 工具结果块
 * ok=false 时输出套红框（错误样式）；输出可折叠。
 */

import { memo } from 'react';
import type { ToolResultBlock } from '../../../contracts/domain';
import './blocks.css';

export interface ToolResultBlockViewProps {
  block: ToolResultBlock;
}

export const ToolResultBlockView = memo(function ToolResultBlockView({
  block,
}: ToolResultBlockViewProps) {
  return (
    <details className="blk-collapsible blk-tool">
      <summary>
        <span className="blk-caret">▶</span>
        <span className="blk-tool-name">result</span>
        <span className={block.ok ? 'blk-tool-status blk-tool-status--done' : 'blk-tool-status blk-tool-status--error'}>
          {block.ok ? 'done' : 'error'}
        </span>
      </summary>
      <div className="blk-tool-body">
        <div className="blk-tool-section">
          <div className="blk-tool-label">output</div>
          {block.ok ? (
            <pre className="blk-tool-pre">{block.text}</pre>
          ) : (
            <div className="blk-tool-error">{block.text}</div>
          )}
        </div>
      </div>
    </details>
  );
});
