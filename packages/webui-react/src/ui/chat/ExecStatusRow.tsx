/**
 * ExecStatusRow.tsx —— 执行状态条（参考布局：「共执行 5 秒 ›」 + 「24 token/s」）
 * ============================================================================
 * 哑组件：挂在一次「用户提问 → 助手执行」的回合上（渲染在该回合助手消息上方）。
 *   左侧：耗时（运行中 = 实时秒数；完成 = 服务端 thinkingDuration）。
 *   右侧：生成速率 token/s（wire state.context.tps / running.tps）。
 * 数据由容器按会话级状态计算后传入；历史回合无逐回合统计，不渲染本组件。
 * ============================================================================
 */

import { memo } from 'react';
import { Icon } from '../primitives/Icon';
import './execstatus.css';

export interface ExecStats {
  /** 已执行秒数（运行中实时；完成后定格）。 */
  durationSec: number | null;
  /** 生成速率 token/s；0/无数据 → 不显示右侧。 */
  tps: number | null;
  /** 是否仍在执行（控制耗时文案的"共执行/已执行"与呼吸点）。 */
  running: boolean;
}

export interface ExecStatusRowProps {
  stats: ExecStats;
  /** 文案覆盖（i18n 接缝）。 */
  durationLabel?: (sec: number, running: boolean) => string;
  tpsLabel?: (tps: number) => string;
}

function defaultDurationLabel(sec: number, running: boolean): string {
  return (running ? '已执行 ' : '共执行 ') + String(sec) + ' 秒';
}

function defaultTpsLabel(tps: number): string {
  return String(Math.round(tps)) + ' token/s';
}

export const ExecStatusRow = memo(function ExecStatusRow({
  stats,
  durationLabel = defaultDurationLabel,
  tpsLabel = defaultTpsLabel,
}: ExecStatusRowProps) {
  const { durationSec, tps, running } = stats;
  if (durationSec === null && (tps === null || tps <= 0)) return null;
  return (
    <div className={running ? 'execrow execrow--running' : 'execrow'}>
      <span className="execrow-left">
        {running ? <span className="execrow-pulse" aria-hidden="true" /> : null}
        {durationSec !== null ? (
          <span className="execrow-duration">{durationLabel(Math.max(0, Math.round(durationSec)), running)}</span>
        ) : null}
      </span>
      {tps !== null && tps > 0 ? (
        <span className="execrow-right">
          <Icon name="zap" size={12} strokeWidth={2} />
          <span>{tpsLabel(tps)}</span>
        </span>
      ) : null}
    </div>
  );
});
