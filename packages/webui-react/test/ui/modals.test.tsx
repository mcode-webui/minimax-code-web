// 覆盖契约点：ui/modals —— AuthModal 刻意没有关闭按钮、没有 Esc/遮罩关闭（必须显式决策，断言这两点），
// 拒绝/允许可点并分别上抛 onDeny/onApprove，deciding 时双按钮禁用（一次请求只允许一次决策）；
// AskModal 对照：有关闭按钮与 Esc/遮罩关闭，选项/跳过/发送回调上抛。
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AuthModal, formatAuthCountdown } from '../../src/ui/modals/AuthModal';
import { AskModal } from '../../src/ui/modals/AskModal';

function renderAuth(over: Partial<Parameters<typeof AuthModal>[0]> = {}) {
  return render(
    <AuthModal
      open={true}
      request={{ requestId: 'r1', action: 'run_shell', ctx: { cmd: 'rm -rf /tmp/x' } }}
      position={1}
      total={1}
      msLeft={90_000}
      onApprove={vi.fn()}
      onDeny={vi.fn()}
      {...over}
    />,
  );
}

describe('AuthModal —— 刻意不可关闭', () => {
  it('没有关闭按钮：对话框内只有“拒绝/允许”两个按钮', () => {
    renderAuth();
    const dialog = screen.getByRole('dialog', { name: '需要授权确认' });
    const buttons = within(dialog).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['拒绝', '允许']);
    expect(within(dialog).queryByRole('button', { name: /关闭|×|cancel|close/i })).not.toBeInTheDocument();
  });

  it('没有 Esc 关闭：按 Escape 后弹窗仍在（无 onClose 可走）', () => {
    renderAuth();
    const dialog = screen.getByRole('dialog', { name: '需要授权确认' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: '需要授权确认' })).toBeInTheDocument();
  });

  it('点遮罩不关闭（遮罩只压暗）', () => {
    renderAuth();
    const backdrop = document.querySelector('.auth-modal-backdrop');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as Element);
    expect(screen.getByRole('dialog', { name: '需要授权确认' })).toBeInTheDocument();
  });
});

describe('AuthModal —— 决策上抛', () => {
  it('点“允许”上抛 onApprove', () => {
    const onApprove = vi.fn();
    renderAuth({ onApprove });
    fireEvent.click(screen.getByRole('button', { name: '允许' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('点“拒绝”上抛 onDeny', () => {
    const onDeny = vi.fn();
    renderAuth({ onDeny });
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it('deciding=true 时双按钮禁用（一次请求只允许一次决策）', () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    renderAuth({ deciding: true, onApprove, onDeny });
    expect(screen.getByRole('button', { name: '允许' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeDisabled();
  });
});

describe('AuthModal —— 请求内容展示', () => {
  it('展示操作名、倒计时 mm:ss、跳过 cid 的 ctx 行', () => {
    renderAuth({
      request: { requestId: 'r1', action: 'run_shell', ctx: { cid: 'hidden', cmd: 'ls', note: null } },
    });
    expect(screen.getByText('run_shell')).toBeInTheDocument();
    expect(screen.getByText('01:30')).toBeInTheDocument();
    expect(screen.getByText('cmd')).toBeInTheDocument();
    // cid 与 null 值不上屏
    expect(screen.queryByText('hidden')).not.toBeInTheDocument();
    expect(screen.queryByText('cid')).not.toBeInTheDocument();
    expect(screen.queryByText('note')).not.toBeInTheDocument();
  });

  it('多请求时显示队列位置，error 行可见', () => {
    renderAuth({ position: 2, total: 3, error: '上次决策失败' });
    expect(screen.getByText('第 2 / 3 个')).toBeInTheDocument();
    expect(screen.getByText('上次决策失败')).toBeInTheDocument();
  });

  it('open=false 或无请求时不渲染', () => {
    const { container, rerender } = renderAuth({ open: false });
    expect(container.innerHTML).toBe('');
    rerender(
      <AuthModal
        open={true}
        request={null}
        position={1}
        total={1}
        msLeft={0}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe('');
  });
});

describe('formatAuthCountdown', () => {
  it('毫秒折算 mm:ss 并钳在 00:00', () => {
    expect(formatAuthCountdown(90_000)).toBe('01:30');
    expect(formatAuthCountdown(59_500)).toBe('01:00');
    expect(formatAuthCountdown(-1)).toBe('00:00');
    expect(formatAuthCountdown(Number.NaN)).toBe('00:00');
  });
});

describe('AskModal（对照：可关闭的提问弹窗）', () => {
  const questions = [
    { id: 'q1', question: '选哪个？', options: [{ id: 'o1', label: '甲' }, { id: 'o2', label: '乙' }], multiSelect: false },
  ];

  it('有关闭按钮，Esc 与遮罩可关闭（与 AuthModal 相反的刻意设计）', () => {
    const onClose = vi.fn();
    render(<AskModal open={true} questions={questions} onSubmit={vi.fn()} onSkip={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('单题单选一击即答', () => {
    const onSubmit = vi.fn();
    render(<AskModal open={true} questions={questions} onSubmit={onSubmit} onSkip={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /甲/ }));
    expect(onSubmit).toHaveBeenCalledWith([{ questionId: 'q1', optionIds: ['o1'], text: undefined }]);
  });

  it('跳过上抛 onSkip', () => {
    const onSkip = vi.fn();
    render(<AskModal open={true} questions={questions} onSubmit={vi.fn()} onSkip={onSkip} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '跳过' }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});
