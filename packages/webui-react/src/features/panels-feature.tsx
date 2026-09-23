/** panels-feature —— 右栏容器：TODO/GOAL/SESSION/MODEL/WORKSPACE/CONTEXT 六段的快照接线（接缝：SessionSlice/usage → RightPanel props）。 */
import type { GoalState } from '../contracts/domain';
import { RightPanel } from '../ui/layout/RightPanel';
import type { AppController } from './app-controller';
import { useAppSnapshot } from './use-app';

export interface PanelsFeatureProps {
  controller: AppController;
}

/** 已运行时长 → "3m12s" / "1h5m"（纯展示格式化）。 */
function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const total = Math.floor(ms / 1000);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  if (mm >= 60) return `${Math.floor(mm / 60)}h${mm % 60}m`;
  return mm > 0 ? `${mm}m${ss}s` : `${ss}s`;
}

export function PanelsFeature({ controller }: PanelsFeatureProps) {
  const s = useAppSnapshot(controller);

  const selection = s.slice?.selection;
  const contextLimit = selection
    ? (s.models.find((m) => m.id === selection.model)?.contextLimit ?? null)
    : null;
  const goal: GoalState | null = s.slice?.goal ?? null;

  return (
    <RightPanel
      open={s.rightOpen}
      todos={s.slice?.todos ?? []}
      goal={goal}
      goalDuration={goal?.startedAt ? formatElapsed(Date.now() - goal.startedAt) : ''}
      sessionId={s.activeSessionId ?? ''}
      sessionTitle={s.slice?.summary?.title ?? ''}
      selection={selection ?? undefined}
      contextLimit={contextLimit}
      workspace={s.slice?.workspace ?? s.workspace}
      context={s.context ?? s.slice?.context ?? null}
    />
  );
}
