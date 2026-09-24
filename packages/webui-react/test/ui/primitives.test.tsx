// 覆盖契约点：primitives 哑组件的受控行为 —— Chip（受控显隐/点击上抛）、KeyValueRow（label/value/muted/extra/hidden）、
// ToggleSwitch（checked 受控、onChange 出参）、MenuRow（onClick/aria-expanded/valueTone）。
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Chip } from '../../src/ui/primitives/Chip';
import { KeyValueRow } from '../../src/ui/primitives/KeyValueRow';
import { ToggleSwitch } from '../../src/ui/primitives/ToggleSwitch';
import { MenuRow } from '../../src/ui/primitives/MenuRow';

describe('Chip', () => {
  it('渲染 label / value / icon', () => {
    render(<Chip icon={<span>i</span>} label="只读" value="3" />);
    expect(screen.getByText('只读')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('i')).toBeInTheDocument();
  });

  it('tone 映射到语义 class', () => {
    const { container } = render(<Chip label="x" tone="danger" />);
    expect(container.querySelector('.chip--danger')).not.toBeNull();
  });

  it('传 onClick 渲染为可点按钮并上抛点击', () => {
    const onClick = vi.fn();
    render(<Chip label="刷新" onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('不传 onClick 时为纯展示（不是按钮）', () => {
    render(<Chip label="展示" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('hidden=true 时保留 DOM 但打 hidden 标记（受控显隐）', () => {
    render(<Chip label="藏" hidden={true} />);
    expect(screen.getByText('藏')).toBeInTheDocument();
    expect(screen.getByText('藏').closest('.chip')).toHaveAttribute('hidden');
  });
});

describe('KeyValueRow', () => {
  it('渲染标签与值', () => {
    render(<KeyValueRow label="BRANCH" value="main" />);
    expect(screen.getByText('BRANCH')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
  });

  it('muted 传入时值带弱化 class', () => {
    const { container } = render(<KeyValueRow label="a" value="b" muted={true} />);
    expect(container.querySelector('.kv-value--muted')).not.toBeNull();
  });

  it('extra 徽标节点渲染在值后面', () => {
    render(<KeyValueRow label="a" value="b" extra={<span>M3</span>} />);
    expect(screen.getByText('M3')).toBeInTheDocument();
  });

  it('hidden=true 保留 DOM 但打 hidden 标记', () => {
    const { container } = render(<KeyValueRow label="a" value="b" hidden={true} />);
    expect(container.querySelector('.kv-row')).toHaveAttribute('hidden');
  });
});

describe('ToggleSwitch（受控）', () => {
  it('checked 由 props 驱动，点击不自转状态，仅 onChange 上抛新值', () => {
    const onChange = vi.fn();
    const { rerender } = render(<ToggleSwitch checked={false} onChange={onChange} label="局域网" />);
    const input = screen.getByRole('checkbox', { name: '局域网' }) as HTMLInputElement;

    expect(input.checked).toBe(false);
    fireEvent.click(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
    // 父层没回灌新 checked 之前保持原状 —— 典型受控语义
    expect(screen.getByRole('checkbox', { name: '局域网' })).not.toBeChecked();

    rerender(<ToggleSwitch checked={true} onChange={onChange} label="局域网" />);
    expect(screen.getByRole('checkbox', { name: '局域网' })).toBeChecked();
  });

  it('id 与 aria-label 透传（配合外部 label）', () => {
    render(<ToggleSwitch checked={true} onChange={() => {}} id="lan-toggle" label="局域网" />);
    const input = screen.getByRole('checkbox', { name: '局域网' });
    expect(input).toHaveAttribute('id', 'lan-toggle');
  });
});

describe('MenuRow', () => {
  it('点击上抛 onClick', () => {
    const onClick = vi.fn();
    render(<MenuRow text="设置" onClick={onClick} ariaLabel="设置" />);
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('expanded 受控映射到 aria-expanded', () => {
    render(<MenuRow text="设置" onClick={() => {}} ariaLabel="设置" expanded={true} />);
    expect(screen.getByRole('button', { name: '设置' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('value 与 valueTone 渲染', () => {
    const { container } = render(<MenuRow text="用量" value="80%" valueTone="warn" />);
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(container.querySelector('.menu-row-value--warn')).not.toBeNull();
  });
});
