// 覆盖契约点：ui/panels —— 右栏各哑面板只渲染 domain 对象：SessionPanel(ID/标题)、ModelPanel(Model/Thinking/Context)、
// ContextPanel(已用/进度条/占比/速度 + 数据源徽标)、GoalPanel(phase 徽标)、TodoList(三态标记/空占位)、
// WorkspacePanel(分支/状态行默认隐藏但保留 DOM)。
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ContextUsage, GoalState, TodoItem, WorkspaceInfo } from '../../src/contracts/domain';
import { SessionPanel } from '../../src/ui/panels/SessionPanel';
import { ModelPanel } from '../../src/ui/panels/ModelPanel';
import { ContextPanel, ContextBar } from '../../src/ui/panels/ContextPanel';
import { GoalPanel } from '../../src/ui/panels/GoalPanel';
import { TodoList } from '../../src/ui/panels/TodoList';
import { WorkspacePanel } from '../../src/ui/panels/WorkspacePanel';

describe('SessionPanel', () => {
  it('渲染 ID / 标题 两行', () => {
    render(<SessionPanel sessionId="s-123" title="会话甲" />);
    expect(screen.getByText('ID')).toBeInTheDocument();
    expect(screen.getByText('s-123')).toBeInTheDocument();
    expect(screen.getByText('标题')).toBeInTheDocument();
    expect(screen.getByText('会话甲')).toBeInTheDocument();
  });
});

describe('ModelPanel', () => {
  it('渲染 Model / Thinking / Context 三行', () => {
    render(
      <ModelPanel
        selection={{ provider: 'minimax_api', model: 'minimax_api/MiniMax-M3', thinking: 'high' }}
        contextLimit={200_000}
      />,
    );
    expect(screen.getByText('minimax_api/MiniMax-M3')).toBeInTheDocument();
    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText('200k')).toBeInTheDocument();
  });

  it('contextLimit 未知显示 —', () => {
    render(<ModelPanel selection={{ provider: 'p', model: 'm', thinking: 'off' }} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('ContextPanel', () => {
  const usage: ContextUsage = {
    used: 120_000,
    limit: 200_000,
    percent: 60,
    tps: 30,
    cacheRead: 5_000,
    model: 'MiniMax-M3',
    source: 'estimate',
  };

  it('渲染已用/占比/速度与进度条（percent 映射到 progressbar）', () => {
    const { container } = render(<ContextPanel usage={usage} />);
    expect(screen.getByText('≈120k/200k')).toBeInTheDocument();
    expect(screen.getByText('60.0%')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '60');
    expect(container.querySelector('.context-bar-fill--estimated')).not.toBeNull();
  });

  it('无数据显示占位', () => {
    render(<ContextPanel usage={null} />);
    // 已用 / 占比 / 速度三处均为占位符
    expect(screen.getAllByText('—')).toHaveLength(3);
  });

  // 【src 缺陷 D1，待集成 agent 修复后启用】ContextPanel.tsx:135 的 ↓ 箭头写在 JSX 文本位，
  // \u2193 不会被转义（同 TopBar 只读 chip 缺陷）。
  it('缓存读徽标箭头渲染为 ↓（已修复 JSX 转义缺陷）', () => {
    render(<ContextPanel usage={usage} />);
    expect(screen.getByText(/缓存 ↓5k/)).toBeInTheDocument();
  });

  it('ContextBar 高占用降级为 danger 档', () => {
    const { container } = render(<ContextBar percent={92} />);
    expect(container.querySelector('.context-bar-fill--danger')).not.toBeNull();
  });
});

describe('GoalPanel', () => {
  it('phase 映射徽标 class 与默认中文状态', () => {
    const goal: GoalState = { objective: '补齐测试', phase: 'active', rounds: 1 };
    const { container } = render(<GoalPanel goal={goal} />);
    expect(screen.getByText('进行中')).toBeInTheDocument();
    expect(container.querySelector('.goal-status-badge--active')).not.toBeNull();
    expect(screen.getByText('补齐测试')).toBeInTheDocument();
  });
});

describe('TodoList', () => {
  it('三态条目带对应 class，空列表显示占位', () => {
    const items: TodoItem[] = [
      { id: 't1', content: '待办一', status: 'pending' },
      { id: 't2', content: '待办二', status: 'in_progress' },
      { id: 't3', content: '待办三', status: 'completed' },
    ];
    const { container, rerender } = render(<TodoList items={items} />);
    expect(screen.getByText('待办一').closest('li')).toHaveClass('todo-item--pending');
    expect(screen.getByText('待办二').closest('li')).toHaveClass('todo-item--in_progress');
    expect(screen.getByText('待办三').closest('li')).toHaveClass('todo-item--completed');

    rerender(<TodoList items={[]} />);
    expect(container.querySelector('.todo-empty')).not.toBeNull();
  });
});

describe('WorkspacePanel', () => {
  it('目录行常显；分支/状态行默认隐藏但保留 DOM', () => {
    const workspace: WorkspaceInfo = { dir: '/w1', branch: 'main', tree: 'clean' };
    render(<WorkspacePanel workspace={workspace} />);
    expect(screen.getByText('/w1')).toBeInTheDocument();
    expect(screen.getByText('main').closest('.kv-row')).toHaveAttribute('hidden');
    expect(screen.getByText('clean').closest('.kv-row')).toHaveAttribute('hidden');
  });

  it('showBranch/showTree 打开对应行', () => {
    const workspace: WorkspaceInfo = { dir: '/w1', branch: 'main', tree: 'clean' };
    render(<WorkspacePanel workspace={workspace} showBranch={true} />);
    expect(screen.getByText('main').closest('.kv-row')).not.toHaveAttribute('hidden');
    expect(screen.getByText('clean').closest('.kv-row')).toHaveAttribute('hidden');
  });
});
