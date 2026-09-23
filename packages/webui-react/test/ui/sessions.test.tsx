// 覆盖契约点：ui/sessions —— 按工作区分组渲染（groupSessionsByWorkspace 的视图面）、当前会话高亮（aria-current）、
// 折叠/展开只经 onToggleGroup 上抛（组件不自持折叠态）、搜索框完全受控（value/onChange 由上层持有）。
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { SessionGroup } from '../../src/contracts/domain';
import { SessionList } from '../../src/ui/sessions/SessionList';
import { SessionSearch } from '../../src/ui/sessions/SessionSearch';
import { sessionSummary } from './fixtures';

const noop = () => {};

function renderList(groups: SessionGroup[], over: Partial<Parameters<typeof SessionList>[0]> = {}) {
  return render(
    <SessionList
      groups={groups}
      activeSessionId={null}
      collapsedKeys={[]}
      onToggleGroup={noop}
      onSelect={noop}
      onRename={noop}
      onDelete={noop}
      {...over}
    />,
  );
}

const G1: SessionGroup = {
  key: '/w1',
  label: '/w1',
  sessions: [sessionSummary({ id: 's1', title: '甲会话', updatedAt: 2 }), sessionSummary({ id: 's2', title: '乙会话', updatedAt: 1 })],
};
const G2: SessionGroup = {
  key: '/w2',
  label: '/w2',
  sessions: [sessionSummary({ id: 's3', title: '丙会话', workspace: '/w2', updatedAt: 3 })],
};

describe('SessionList 分组渲染', () => {
  it('每个工作区分组渲染组名与会话数', () => {
    renderList([G1, G2]);
    expect(screen.getByText('/w1')).toBeInTheDocument();
    expect(screen.getByText('/w2')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('组内会话全部渲染', () => {
    renderList([G1, G2]);
    expect(screen.getByText('甲会话')).toBeInTheDocument();
    expect(screen.getByText('乙会话')).toBeInTheDocument();
    expect(screen.getByText('丙会话')).toBeInTheDocument();
  });

  it('空列表显示占位文案', () => {
    renderList([]);
    expect(screen.getByText('暂无会话记录')).toBeInTheDocument();
  });
});

describe('SessionList 当前会话高亮', () => {
  it('activeSessionId 对应会话带 aria-current 与高亮 class', () => {
    const { container } = renderList([G1], { activeSessionId: 's2' });
    const active = container.querySelector('[aria-current="true"]');
    expect(active).not.toBeNull();
    expect(active).toHaveClass('session-item--active');
    expect(active?.textContent).toContain('乙会话');
  });

  it('非当前会话不高亮', () => {
    const { container } = renderList([G1], { activeSessionId: 's2' });
    const items = container.querySelectorAll('.session-item');
    expect(items).toHaveLength(2);
    expect(container.querySelectorAll('.session-item--active')).toHaveLength(1);
  });
});

describe('SessionList 折叠/展开回调上抛', () => {
  it('点组头把分组 key 交给上层，组件不自持折叠态', () => {
    const onToggleGroup = vi.fn();
    renderList([G1, G2], { onToggleGroup });
    fireEvent.click(screen.getByText('/w1'));
    expect(onToggleGroup).toHaveBeenCalledTimes(1);
    expect(onToggleGroup).toHaveBeenCalledWith('/w1');
  });

  it('collapsedKeys 含该组时收起会话项（渲染结果由上层状态驱动）', () => {
    renderList([G1, G2], { collapsedKeys: ['/w1'] });
    expect(screen.queryByText('甲会话')).not.toBeInTheDocument();
    expect(screen.queryByText('乙会话')).not.toBeInTheDocument();
    expect(screen.getByText('丙会话')).toBeInTheDocument();
  });

  it('组头 aria-expanded 反映折叠态', () => {
    renderList([G1], { collapsedKeys: ['/w1'] });
    expect(screen.getByText('/w1').closest('[role="button"]')).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('SessionSearch 受控输入', () => {
  it('value 由 props 驱动，输入只 onChange 上抛', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SessionSearch value="abc" onChange={onChange} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;

    expect(input.value).toBe('abc');
    fireEvent.change(input, { target: { value: 'abcd' } });
    expect(onChange).toHaveBeenCalledWith('abcd');
    // 受控：父层不回灌则保持原值
    expect(screen.getByRole('textbox')).toHaveValue('abc');

    rerender(<SessionSearch value="abcd" onChange={onChange} />);
    expect(screen.getByRole('textbox')).toHaveValue('abcd');
  });

  it('placeholder 作可访问名，maxLength 上限透传', () => {
    render(<SessionSearch value="" onChange={noop} placeholder="搜会话" maxLength={10} />);
    const input = screen.getByRole('textbox', { name: '搜会话' });
    expect(input).toHaveAttribute('maxlength', '10');
  });
});

describe('SessionItem 动作回调', () => {
  it('点击会话上抛 onSelect(id)', () => {
    const onSelect = vi.fn();
    renderList([G1], { onSelect });
    fireEvent.click(screen.getByText('甲会话'));
    expect(onSelect).toHaveBeenCalledWith('s1');
  });

  it('重命名提交上抛 onRename(id, title)', () => {
    const onRename = vi.fn();
    renderList([G1], { onRename });
    // G1 有两个会话 → 每行都带一个"重命名会话"按钮，这里取第一个（s1）。
    fireEvent.click(screen.getAllByRole('button', { name: '重命名会话' })[0]);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '新标题' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('s1', '新标题');
  });

  it('删除需二次确认后上抛 onDelete(id)，点“否”不删', () => {
    const onDelete = vi.fn();
    const { rerender } = renderList([G1], { onDelete });
    fireEvent.click(screen.getAllByRole('button', { name: '删除会话' })[0]);
    fireEvent.click(screen.getByText('否'));
    expect(onDelete).not.toHaveBeenCalled();

    rerender(
      <SessionList
        groups={[G1]}
        activeSessionId={null}
        collapsedKeys={[]}
        onToggleGroup={noop}
        onSelect={noop}
        onRename={noop}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getAllByRole('button', { name: '删除会话' })[0]);
    fireEvent.click(screen.getByText('是'));
    expect(onDelete).toHaveBeenCalledWith('s1');
  });
});
