/**
 * blocks/AskUserBlockView.tsx —— 提问块（问题 + 选项 + 多选框 + 已答标记）
 * 哑组件：选中态与应答动作全部由 props 进出，组件不持久化状态。
 */

import { memo } from 'react';
import type { AskUserBlock } from '../../../contracts/domain';
import './blocks.css';

export interface AskUserBlockViewProps {
  block: AskUserBlock;
  /** 当前勾选的选项 id（受控；由上层按会话保存）。 */
  selectedIds?: readonly string[];
  /** 勾选/取消勾选一个选项（单选时上层做互斥）。 */
  onToggleOption?: (optionId: string) => void;
  /** 提交答案（把全部勾选的 id 交回上层）。 */
  onConfirm?: (optionIds: string[]) => void;
}

const OPTION_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const AskUserBlockView = memo(function AskUserBlockView({
  block,
  selectedIds,
  onToggleOption,
  onConfirm,
}: AskUserBlockViewProps) {
  const selected = selectedIds ?? [];
  const answered = block.answered === true;
  const interactive = !answered && onToggleOption !== undefined;

  return (
    <div className="blk-ask">
      <div className="blk-ask-header">
        <span>需要你回答</span>
        <span className="blk-ask-multi">{block.multiSelect ? '可多选' : '单选'}</span>
      </div>
      <div className="blk-ask-question">{block.question}</div>
      <div className="blk-ask-options">
        {block.options.map((opt, idx) => {
          const isSelected = selected.includes(opt.id);
          return (
            <button
              key={opt.id}
              type="button"
              className={isSelected ? 'blk-ask-opt blk-ask-opt--selected' : 'blk-ask-opt'}
              disabled={!interactive}
              onClick={() => {
                if (onToggleOption !== undefined) onToggleOption(opt.id);
              }}
            >
              <span className="blk-ask-opt-box">
                {block.multiSelect ? (isSelected ? '✓' : '') : OPTION_LETTERS[idx] ?? String(idx + 1)}
              </span>
              <span className="blk-ask-opt-label">
                {opt.label}
                {opt.desc !== undefined && opt.desc !== '' ? (
                  <div className="blk-ask-opt-desc">{opt.desc}</div>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
      {answered ? (
        <div className="blk-ask-answered">
          <span className="blk-ask-answered-mark">✓</span>
          <span>已回答</span>
        </div>
      ) : onConfirm !== undefined ? (
        <div className="blk-ask-actions">
          <button
            type="button"
            className="blk-ask-confirm"
            disabled={selected.length === 0}
            onClick={() => {
              if (onConfirm !== undefined) onConfirm([...selected]);
            }}
          >
            发送
          </button>
        </div>
      ) : null}
    </div>
  );
});
