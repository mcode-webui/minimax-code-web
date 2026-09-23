import type { GoalPhase, GoalState } from '../../contracts/domain';
import './GoalPanel.css';

export interface GoalPanelProps {
  /** 目标状态（领域对象）。 */
  goal: GoalState;
  /** 状态徽标文字（i18n 后传入）；缺省按 phase 给中文。 */
  statusLabel?: string;
  /** 目标文字覆盖；缺省用 goal.objective。 */
  text?: string;
}

const DEFAULT_STATUS: Record<GoalPhase, string> = {
  active: '\u8fdb\u884c\u4e2d',
  paused: '\u6682\u505c',
  blocked: '\u963b\u585e',
  complete: '\u5b8c\u6210',
};

/** phase → 徽标修饰类（1:1 对齐 main.css 的 .goal-status-badge.complete/.paused）。 */
export function goalBadgeClass(phase: GoalPhase): string {
  return 'goal-status-badge goal-status-badge--' + phase;
}

/**
 * GoalPanel —— 右栏 GOAL 段内容：目标状态徽标 + 目标文字。
 * 哑组件：数据由 props 进，时长等派生文案由上层格式化后另行渲染。
 */
export function GoalPanel({ goal, statusLabel, text }: GoalPanelProps) {
  return (
    <div className="goal-content">
      <span className={goalBadgeClass(goal.phase)}>{statusLabel ?? DEFAULT_STATUS[goal.phase]}</span>
      <span className="goal-text">{text ?? goal.objective}</span>
    </div>
  );
}
