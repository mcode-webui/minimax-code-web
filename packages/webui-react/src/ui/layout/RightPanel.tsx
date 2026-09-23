import type { ContextUsage, GoalState, ModelSelection, SessionSlice, TodoItem, WorkspaceInfo } from '../../contracts/domain';
import { SectionCard } from '../primitives/SectionCard';
import { ContextPanel, ContextSourceBadge } from '../panels/ContextPanel';
import { GoalPanel } from '../panels/GoalPanel';
import { ModelPanel } from '../panels/ModelPanel';
import { SessionPanel } from '../panels/SessionPanel';
import { TodoList } from '../panels/TodoList';
import { WorkspacePanel } from '../panels/WorkspacePanel';
import './right.css';

export interface RightPanelProps {
  /** 移动端抽屉是否展开。 */
  open?: boolean;

  /** TODO 条目；为空时整段不渲染。 */
  todos?: readonly TodoItem[];
  /** TODO 空列表文案。 */
  todoEmptyText?: string;

  /** 目标状态；null 时整段不渲染。 */
  goal?: GoalState | null;
  /** 目标状态徽标文字（i18n 后传入）。 */
  goalStatusLabel?: string;
  /** 目标已运行时长文案（上层格式化，例如 "已运行 3m12s"）。 */
  goalDuration?: string;

  /** 会话 ID。 */
  sessionId?: string;
  /** 会话标题。 */
  sessionTitle?: string;

  /** 模型 / 思考强度选择。 */
  selection?: ModelSelection;
  /** 上下文窗口（token）。 */
  contextLimit?: number | null;

  /** 工作区。 */
  workspace?: WorkspaceInfo | null;
  /** 是否显示分支 / 状态两行（原 UI 默认隐藏）。 */
  showBranch?: boolean;
  showTree?: boolean;

  /** 上下文用量。 */
  context?: ContextUsage | null;

  /** 直接传入会话切片（可选，等价于逐项传）。 */
  slice?: SessionSlice | null;

  /** 各段标题文案覆盖。 */
  labels?: Partial<RightPanelLabels>;
}

export interface RightPanelLabels {
  todo: string;
  goal: string;
  session: string;
  model: string;
  workspace: string;
  context: string;
  goalDurationPrefix: string;
}

const DEFAULT_LABELS: RightPanelLabels = {
  todo: 'TODO',
  goal: 'GOAL',
  session: 'SESSION',
  model: 'MODEL',
  workspace: 'WORKSPACE',
  context: 'CONTEXT',
  goalDurationPrefix: '\u5df2\u8fd0\u884c',
};

/**
 * RightPanel —— 右栏六段（TODO / GOAL / SESSION / MODEL / WORKSPACE / CONTEXT）。
 * 全部用 SectionCard + KeyValueRow 拼装，各段内容组件来自 ui/panels。
 * 哑组件：数据由 props 进（或整片 SessionSlice），无任何 IO。
 */
export function RightPanel(props: RightPanelProps) {
  const {
    open,
    todos,
    todoEmptyText,
    goal,
    goalStatusLabel,
    goalDuration,
    sessionId,
    sessionTitle,
    selection,
    contextLimit,
    workspace,
    showBranch = false,
    showTree = false,
    context,
    slice,
    labels,
  } = props;

  const l: RightPanelLabels = { ...DEFAULT_LABELS, ...labels };

  // slice 作为统一数据源，逐项 props 优先。
  const effTodos: readonly TodoItem[] = todos ?? slice?.todos ?? [];
  const effGoal: GoalState | null = goal !== undefined ? goal : (slice?.goal ?? null);
  const effSessionId = sessionId ?? slice?.summary?.id ?? slice?.id ?? '';
  const effSessionTitle = sessionTitle ?? slice?.summary?.title ?? '';
  const effSelection: ModelSelection = selection ?? slice?.selection ?? { provider: '', model: '', thinking: 'off' };
  const effWorkspace = workspace !== undefined ? workspace : (slice?.workspace ?? null);
  const effContext = context !== undefined ? context : (slice?.context ?? null);

  return (
    <aside className={open ? 'right-panel right-panel--open' : 'right-panel'}>
      {/* TODO —— 有条目才渲染整段 */}
      {effTodos.length > 0 && (
        <SectionCard title={l.todo}>
          <TodoList items={effTodos} emptyText={todoEmptyText} />
        </SectionCard>
      )}

      {/* GOAL —— 有目标才渲染整段 */}
      {effGoal && (
        <SectionCard title={l.goal}>
          <GoalPanel goal={effGoal} statusLabel={goalStatusLabel} />
          <div className="goal-duration">{goalDuration ? l.goalDurationPrefix + ' ' + goalDuration : ''}</div>
        </SectionCard>
      )}

      <SectionCard title={l.session}>
        <SessionPanel sessionId={effSessionId} title={effSessionTitle} />
      </SectionCard>

      <SectionCard title={l.model}>
        <ModelPanel selection={effSelection} contextLimit={contextLimit} />
      </SectionCard>

      <SectionCard title={l.workspace}>
        <WorkspacePanel workspace={effWorkspace} showBranch={showBranch} showTree={showTree} />
      </SectionCard>

      <SectionCard title={l.context} extra={<ContextSourceBadge usage={effContext} />}>
        <ContextPanel usage={effContext} />
      </SectionCard>
    </aside>
  );
}

