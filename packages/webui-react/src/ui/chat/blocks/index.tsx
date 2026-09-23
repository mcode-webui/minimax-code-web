/**
 * blocks/index.tsx —— 块分发器 BlockView
 * ============================================================================
 * 按 block.kind 分发到具体块视图；未知 kind 兜底渲染 JSON（向前兼容：
 * wire 侧新增块类型时旧 UI 不崩，只降级为 JSON 展示）。
 *
 * 块分发表：
 *   'text'       → TextBlockView
 *   'thinking'   → ThinkingBlockView
 *   'tool-call'  → ToolCallBlockView
 *   'tool-result'→ ToolResultBlockView
 *   'plan'       → PlanBlockView
 *   'ask-user'   → AskUserBlockView
 *   'error'      → ErrorBlockView
 *   default      → UnknownBlockView（JSON 兜底）
 * ============================================================================
 */

import { memo } from 'react';
import type { MessageBlock } from '../../../contracts/domain';
import { TextBlockView } from './TextBlockView';
import { ThinkingBlockView } from './ThinkingBlockView';
import { ToolCallBlockView } from './ToolCallBlockView';
import { ToolResultBlockView } from './ToolResultBlockView';
import { PlanBlockView } from './PlanBlockView';
import { AskUserBlockView } from './AskUserBlockView';
import { ErrorBlockView } from './ErrorBlockView';
import './blocks.css';

export interface BlockViewProps {
  block: MessageBlock;
  /** 透传给 ask-user 块的受控选中态（由上层按会话保存）。 */
  askSelectedIds?: readonly string[];
  onAskToggleOption?: (optionId: string) => void;
  onAskConfirm?: (optionIds: string[]) => void;
}

/** 未知块兜底：整块 JSON 展示。 */
const UnknownBlockView = memo(function UnknownBlockView({ block }: { block: MessageBlock }) {
  let text: string;
  try {
    text = JSON.stringify(block, null, 2) ?? String(block);
  } catch {
    text = String(block);
  }
  return (
    <div className="blk-json">
      <div className="blk-json-label">未知消息块</div>
      <pre className="blk-json-pre">{text}</pre>
    </div>
  );
});

export const BlockView = memo(function BlockView({
  block,
  askSelectedIds,
  onAskToggleOption,
  onAskConfirm,
}: BlockViewProps) {
  switch (block.kind) {
    case 'text':
      return <TextBlockView block={block} />;
    case 'thinking':
      return <ThinkingBlockView block={block} />;
    case 'tool-call':
      return <ToolCallBlockView block={block} />;
    case 'tool-result':
      return <ToolResultBlockView block={block} />;
    case 'plan':
      return <PlanBlockView block={block} />;
    case 'ask-user':
      return (
        <AskUserBlockView
          block={block}
          selectedIds={askSelectedIds}
          onToggleOption={onAskToggleOption}
          onConfirm={onAskConfirm}
        />
      );
    case 'error':
      return <ErrorBlockView block={block} />;
    default:
      return <UnknownBlockView block={block} />;
  }
});

export { TextBlockView } from './TextBlockView';
export { ThinkingBlockView } from './ThinkingBlockView';
export { ToolCallBlockView, formatArgs } from './ToolCallBlockView';
export { ToolResultBlockView } from './ToolResultBlockView';
export { PlanBlockView } from './PlanBlockView';
export { AskUserBlockView } from './AskUserBlockView';
export { ErrorBlockView } from './ErrorBlockView';
export type { TextBlockViewProps } from './TextBlockView';
export type { ThinkingBlockViewProps } from './ThinkingBlockView';
export type { ToolCallBlockViewProps } from './ToolCallBlockView';
export type { ToolResultBlockViewProps } from './ToolResultBlockView';
export type { PlanBlockViewProps } from './PlanBlockView';
export type { AskUserBlockViewProps } from './AskUserBlockView';
export type { ErrorBlockViewProps } from './ErrorBlockView';
