/**
 * modals-feature 测试 —— 缺口 #8：AuthModal 接线（授权队列 → decideAuth）。
 * ============================================================================
 * 容器契约（ModalsFeature({ controller })）：
 *   - useAppSnapshot(controller).authQueue 取队首 head 渲染 AuthModal；
 *   - open = head != null；request={ requestId, action, ctx }；
 *   - position=1、total=authQueue.length、msLeft = expiresAt - Date.now()（每秒刷新）；
 *   - onApprove → decideAuth(head.requestId, true)；onDeny → decideAuth(head.requestId, false)。
 * 用 makeHarness 注入 authQueue；vi.spyOn(actions.decideAuth) 断言调用。
 * 用可访问名定位（dialog / 允许 / 拒绝 / action 文案 / 倒计时 / 队列位置）。
 * ============================================================================
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

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
  it('队列为空时弹窗不渲染', () => {
    const h = makeHarness({ authQueue: [] });
    renderModals(h);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('有请求时渲染 action 与倒计时', () => {
    const h = makeHarness({
      authQueue: [pendingAuth({ requestId: 'r1', action: 'bash', expiresAt: Date.now() + 60_000 })],
    });
    renderModals(h);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // 操作名
    expect(screen.getByText('bash')).toBeInTheDocument();
    // 倒计时 mm:ss（60s → 01:00）
    expect(screen.getByText('01:00')).toBeInTheDocument();
  });

  it('队列多于一条时渲染队列位置', () => {
    const h = makeHarness({
      authQueue: [
        pendingAuth({ requestId: 'r1', action: 'alpha' }),
        pendingAuth({ requestId: 'r2', action: 'beta' }),
      ],
    });
    renderModals(h);
    expect(screen.getByText('第 1 / 2 个')).toBeInTheDocument();
  });

  it('点「允许」调 decideAuth(id, true)', async () => {
    const h = makeHarness({ authQueue: [pendingAuth({ requestId: 'r1', action: 'bash' })] });
    const decideAuth = vi
      .spyOn(h.controller.actions, 'decideAuth')
      .mockImplementation(async () => { /* noop */ });
    renderModals(h);

    fireEvent.click(screen.getByRole('button', { name: '允许' }));
    await waitFor(() => expect(decideAuth).toHaveBeenCalledTimes(1));
    expect(decideAuth).toHaveBeenCalledWith('r1', true);
  });

  it('点「拒绝」调 decideAuth(id, false)', async () => {
    const h = makeHarness({ authQueue: [pendingAuth({ requestId: 'r7', action: 'bash' })] });
    const decideAuth = vi
      .spyOn(h.controller.actions, 'decideAuth')
      .mockImplementation(async () => { /* noop */ });
    renderModals(h);

    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    await waitFor(() => expect(decideAuth).toHaveBeenCalledTimes(1));
    expect(decideAuth).toHaveBeenCalledWith('r7', false);
  });
});
