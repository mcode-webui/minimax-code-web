/**
 * blocks/ThinkingBlockView.tsx —— 思考块（三态：折叠 / 5 行预览 / 全文）
 * ============================================================================
 * 默认折叠；点标题进入「5 行预览」（固定高度 + 滚动），再点「展开全部」看全文，
 * 「收起」回预览、再点标题回折叠。组件内 useState（不持久化 —— 与 vanilla
 * <details> 语义一致，切会话/重渲染不串状态）。
 * 【改动原因】用户反馈：展开后全文无上限，长思维链把会话撑爆 —— 固定 5 行预览。
 * ============================================================================
 */

import { memo, useState } from 'react';
import type { ThinkingBlock } from '../../../contracts/domain';
import './blocks.css';

export interface ThinkingBlockViewProps {
  block: ThinkingBlock;
}

type ThinkMode = 'fold' | 'preview' | 'full';

export const ThinkingBlockView = memo(function ThinkingBlockView({ block }: ThinkingBlockViewProps) {
  const [mode, setMode] = useState<ThinkMode>('fold');
  const label = block.done === false ? '思考中' : '思考过程';

  return (
    <div className="blk-thinking">
      <button
        type="button"
        className="blk-thinking-toggle"
        aria-expanded={mode !== 'fold'}
        onClick={() => setMode((m) => (m === 'fold' ? 'preview' : 'fold'))}
      >
        <span className="blk-caret">{mode === 'fold' ? '▶' : '▼'}</span>
        <span className="blk-thinking-label">{label}</span>
        <span className="blk-thinking-count">{block.text.length} 字</span>
      </button>

      {mode !== 'fold' ? (
        <>
          <pre className={mode === 'preview' ? 'blk-thinking-body blk-thinking-capped' : 'blk-thinking-body'}>
            {block.text}
          </pre>
          <div className="blk-thinking-actions">
            {mode === 'preview' ? (
              <button type="button" className="blk-thinking-btn" onClick={() => setMode('full')}>
                展开全部
              </button>
            ) : (
              <button type="button" className="blk-thinking-btn" onClick={() => setMode('preview')}>
                收起
              </button>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
});
