// 覆盖契约点：ui/layout/TopBar —— 只读 chip 仅在 readOnly 时出现（中英双语）、通知铃铛未读徽标计数（>99 显示 99+）、
// 清空回调 onClearAlerts 上抛、通知弹层受 alertsOpen 控制。
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AlertItem } from '../../src/contracts/domain';
import { TopBar } from '../../src/ui/layout/TopBar';

const ALERT: AlertItem = {
  id: 'a1',
  ts: 1000,
  level: 'error',
  msg: '连接断开',
  src: 'stream',
  sessionId: null,
  count: 2,
};

describe('TopBar 只读 chip', () => {
  it('readOnly=true 时出现中英双语只读 chip', () => {
    render(<TopBar readOnly={true} readOnlyTitle="ro-title" />);
    // “只读/READ ONLY”被分隔符拆成多个文本节点，按 title 定位 chip 再断言其文本
    const chip = screen.getByTitle('ro-title').closest('.chip');
    expect(chip).not.toBeNull();
    expect(chip).toHaveClass('chip--danger');
    expect(chip).toHaveTextContent('READ ONLY');
    // 默认 title 是中英双语说明（JS 字符串字面量，转义正常）
    render(<TopBar readOnly={true} />);
    expect(screen.getByTitle('webui 当前处于只读模式 / webui is in read-only mode')).toBeInTheDocument();
  });

  // 【src 缺陷 D1，待集成 agent 修复后启用】TopBar.tsx:159 的“只读”写在 JSX 文本位，
  // \uXXXX 不会被转义，实际渲染为字面量 "\u53ea\u8bfb"（见交付报告缺陷清单）。
  it('只读 chip 中文文案渲染为“只读”（已修复 JSX 转义缺陷）', () => {
    render(<TopBar readOnly={true} readOnlyTitle="ro-title" />);
    const chip = screen.getByTitle('ro-title').closest('.chip');
    expect(chip).toHaveTextContent('只读');
  });

  it('readOnly=false / 缺省时不出现只读 chip', () => {
    const { rerender } = render(<TopBar readOnly={false} />);
    expect(screen.queryByText('READ ONLY')).not.toBeInTheDocument();
    rerender(<TopBar />);
    expect(screen.queryByText('READ ONLY')).not.toBeInTheDocument();
  });
});

describe('TopBar 通知铃铛与未读徽标', () => {
  it('未读数渲染为徽标，>99 显示 99+', () => {
    const { rerender } = render(<TopBar unreadCount={5} />);
    expect(screen.getByText('5')).toBeInTheDocument();
    rerender(<TopBar unreadCount={150} />);
    expect(screen.getByText('99+')).toBeInTheDocument();
    rerender(<TopBar unreadCount={0} />);
    expect(document.querySelector('.alerts-badge')).toBeNull();
  });

  it('点铃铛上抛 onToggleAlerts', () => {
    const onToggleAlerts = vi.fn();
    render(<TopBar unreadCount={0} onToggleAlerts={onToggleAlerts} />);
    // 铃铛 chip 无可视文本，可访问名回退到 title
    fireEvent.click(screen.getByTitle('系统通知'));
    expect(onToggleAlerts).toHaveBeenCalledTimes(1);
  });

  it('alertsOpen=true 展示通知弹层与条目', () => {
    render(<TopBar alertsOpen={true} alerts={[ALERT]} />);
    const dialog = screen.getByRole('dialog', { name: '系统通知' });
    expect(dialog).toHaveTextContent('连接断开');
    expect(dialog).toHaveTextContent('×2');
  });

  it('空通知显示占位文案', () => {
    render(<TopBar alertsOpen={true} alerts={[]} />);
    expect(screen.getByText('暂无通知')).toBeInTheDocument();
  });

  it('弹层“清空”按钮上抛 onClearAlerts', () => {
    const onClearAlerts = vi.fn();
    render(<TopBar alertsOpen={true} alerts={[ALERT]} onClearAlerts={onClearAlerts} />);
    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    expect(onClearAlerts).toHaveBeenCalledTimes(1);
  });

  it('alertsOpen=false 不渲染弹层（受控展开）', () => {
    render(<TopBar alertsOpen={false} alerts={[ALERT]} />);
    expect(screen.queryByRole('dialog', { name: '系统通知' })).not.toBeInTheDocument();
    expect(screen.queryByText('连接断开')).not.toBeInTheDocument();
  });
});

describe('TopBar 其它状态 chip（签名完整性）', () => {
  it('在线台数 chip 按 onlineCount 显示', () => {
    render(<TopBar onlineCount={3} />);
    expect(screen.getByText('3 台')).toBeInTheDocument();
  });

  it('强制刷新 chip 点击上抛 onForceReload', () => {
    const onForceReload = vi.fn();
    render(<TopBar onForceReload={onForceReload} />);
    fireEvent.click(screen.getByRole('button', { name: /强制刷新/ }));
    expect(onForceReload).toHaveBeenCalledTimes(1);
  });

  it('局域网 chip 点击上抛 onCopyLanUrl(url)', () => {
    const onCopyLanUrl = vi.fn();
    render(<TopBar lanUrl="http://10.0.0.2:3080" onCopyLanUrl={onCopyLanUrl} />);
    fireEvent.click(screen.getByText('http://10.0.0.2:3080'));
    expect(onCopyLanUrl).toHaveBeenCalledWith('http://10.0.0.2:3080');
  });
});
