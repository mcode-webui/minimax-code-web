/**
 * blocks/PlanBlockView.tsx —— 计划块（标题 + 步骤列表 + 状态徽标）
 */

import { memo } from 'react';
import type { PlanBlock } from '../../../contracts/domain';
import './blocks.css';

export interface PlanBlockViewProps {
  block: PlanBlock;
}

const STATUS_TEXT: Record<PlanBlock['status'], string> = {
  pending: '待确认',
  agreed: '已确认',
  skipped: '已跳过',
};

export const PlanBlockView = memo(function PlanBlockView({ block }: PlanBlockViewProps) {
  return (
    <div className="blk-plan">
      <div className="blk-plan-header">
        <span className="blk-plan-title">{block.title}</span>
        <span className={'blk-plan-status blk-plan-status--' + block.status}>
          {STATUS_TEXT[block.status]}
        </span>
      </div>
      <ol className="blk-plan-steps">
        {block.steps.map((step, idx) => (
          <li key={block.id + '-s' + String(idx)} className="blk-plan-step">
            {step}
          </li>
        ))}
      </ol>
    </div>
  );
});
