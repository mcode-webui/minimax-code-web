/**
 * modals-feature 测试 —— 缺口 #8：AuthModal 接线。
 * ============================================================================
 * 给定 authQueue 有请求时，弹窗渲染 action / 倒计时 / 队列位置；
 * 点「允许」调 decideAuth(id, true)、「拒绝」调 decideAuth(id, false)；
 * 队列为空时弹窗不渲染。
 *
 * 容器契约：ModalsFeature({ controller }) 从 useAppSnapshot(controller).authQueue
 * 取队首渲染 AuthModal，把 onApprove/onDeny 接到 actions.decideAuth(head.requestId, …)。
 * 用 fake Registry（makeHarness）注入 authQueue，vi.spyOn 断言 decideAuth 调用。
 * ============================================================================
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { RegistryProvider } from '../../src/features/registry-context';
import { ModalsFeature } from '../../src/features/modals-feature';
import { makeHarness, pendingAuth } from '../fakes';

function renderModals(h: ReturnType<typeof makeHarness>): void {
  render(
    <RegistryProvider value={h.reg}>
      <ModalsFeature controller={h.controller} />
    </RegistryProvider>,
  );
}

describe('AuthModal 接线（缺口 #8）', () => {
  it('队列为空时不渲染弹窗', () => {
    const h = makeHarness({ authQueue: [] });
    renderModals(h);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('有一个请求时渲染 action 与倒计时', () => {
    const h = makeHarness({ authQueue: [pendingAuth({ requestId: 'r1', action: 'bash' })] });
    renderModals(h);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // action 名
    expect(screen.getByText('bash')).toBeInTheDocument();
    // 倒计时 mm:ss（expiresAt 默认 60s 后 → 01:00）
    expect(screen.getByText('01:00')).toBeInTheDocument();
  });

  it('队列长度 > 1 时渲染队列位置', () => {
    const h = makeHarness({
      authQueue: [
        pendingAuth({ requestId: 'r1', action: 'alpha' }),
        pendingAuth({ requestId: 'r2', action: 'beta' }),
      ],
    });
    renderModals(h);
    // 队列位置：第 1 / 2 个（队首 action 是 alpha）
    expect(screen.getByText('第 1 / 2 个')).toBeInTheDocument();
    expect(screen.getByText('alpha')).toBeInTheDocument();
  });

  it('点「允许」调 decideAuth(id, true)', () => {
    const h = makeHarness({ authQueue: [pendingAuth({ requestId: 'r1', action: 'bash' })] });
    const decideAuth = vi.spyOn(h.controller.actions, 'decideAuth').mockImplementation(async () => { /* noop */ });
    renderModals(h);

    fireEvent.click(screen.getByRole('button', { name: '允许' }));
    expect(decideAuth).toHaveBeenCalledWith('r1', true);
  });

  it('点「拒绝」调 decideAuth(id, false)', () => {
    const h = makeHarness({ authQueue: [pendingAuth({ requestId: 'r7', action: 'bash' })] });
    const decideAuth = vi.spyOn(h.controller.actions, 'decideAuth').mockImplementation(async () => { /* noop */ });
    renderModals(h);

    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(decideAuth).toHaveBeenCalledWith('r7', false);
  });
});
