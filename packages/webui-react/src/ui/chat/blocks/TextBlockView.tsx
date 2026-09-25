/**
 * blocks/TextBlockView.tsx —— Markdown 文本块
 * ============================================================================
 * 哑组件：只吃 TextBlock，渲染为 React 节点（不使用 dangerouslySetInnerHTML，
 * 从根上杜绝 XSS）。渲染器来自 blocks/markdown.tsx —— 与右栏文档预览共享同一
 * 最小 Markdown 子集实现（复用保证两处视觉一致）。
 * markdown=false 时按纯文本（pre-wrap）渲染。
 * ============================================================================
 */

import { memo } from 'react';
import type { TextBlock } from '../../../contracts/domain';
import { renderMarkdown } from './markdown';
import './blocks.css';

export interface TextBlockViewProps {
  block: TextBlock;
}

export const TextBlockView = memo(function TextBlockView({ block }: TextBlockViewProps) {
  if (block.markdown === false) {
    return <div className="blk-text blk-text--plain">{block.text}</div>;
  }
  return <div className="blk-text">{renderMarkdown(block.text)}</div>;
});
