/**
 * blocks/ToolCallBlockView.tsx —— 工具调用块
 * toolName + 状态徽标（running/done/error）+ 可折叠 args(JSON)。
 */

import { memo } from 'react';
import type { ToolCallBlock } from '../../../contracts/domain';
import './blocks.css';

export interface ToolCallBlockViewProps {
  block: ToolCallBlock;
}

const STATUS_TEXT: Record<ToolCallBlock['status'], string> = {
  running: 'running',
  done: 'done',
  error: 'error',
};

/** unknown → 稳定可读的 JSON 文本（绝不抛错）。 */
export function formatArgs(args: unknown): string {
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args, null, 2) ?? String(args);
  } catch {
    return String(args);
  }
}

export const ToolCallBlockView = memo(function ToolCallBlockView({ block }: ToolCallBlockViewProps) {
  return (
    <details className="blk-collapsible blk-tool" open={block.status === 'running'}>
      <summary>
        <span className="blk-caret">▶</span>
        <span className="blk-tool-name">{block.toolName}</span>
        {block.summary !== undefined && block.summary !== '' ? (
          <span className="blk-tool-summary">{block.summary}</span>
        ) : null}
        <span className={'blk-tool-status blk-tool-status--' + block.status}>
          {STATUS_TEXT[block.status]}
        </span>
      </summary>
      <div className="blk-tool-body">
        {block.args !== undefined ? (
          <div className="blk-tool-section">
            <div className="blk-tool-label">args</div>
            <pre className="blk-tool-pre">{formatArgs(block.args)}</pre>
          </div>
        ) : null}
        {block.status === 'error' ? (
          <div className="blk-tool-section">
            <div className="blk-tool-error">工具调用失败{block.summary ? '：' + block.summary : ''}</div>
          </div>
        ) : null}
      </div>
    </details>
  );
});
