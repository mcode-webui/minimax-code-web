/**
 * sessions-feature 测试 —— 缺口 #5：删除前先弹 NotifierPort.confirm 确认。
 * ============================================================================
 * SessionList 的 onDelete 上抛后，容器必须先弹确认：confirm 返回 false 时不调
 * deleteSession，返回 true 时调用一次。用注入的 fake NotifierPort（makeHarness 的
 * confirm spy）+ vi.spyOn(actions.deleteSession) 断言调用路径。
 * 容器契约：SessionsFeature({ controller }) 的 handleDelete 先 notifier.confirm，
 * 通过后才 actions.deleteSession(id)。
 * ============================================================================
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { RegistryProvider } from '../../src/features/registry-context';
import { SessionsFeature } from '../../src/features/sessions-feature';
import { makeHarness, session } from '../fakes';

function renderSessions(h: ReturnType<typeof makeHarness>): void {
  render(
    <RegistryProvider value={h.reg}>
      <SessionsFeature controller={h.controller} />
    </RegistryProvider>,
  );
}

describe('删除确认（缺口 #5）', () => {
  it('confirm 返回 false 时不调 deleteSession', async () => {
    const h = makeHarness({ sessions: [session({ id: 's1', title: '待删' })] });
    await h.controller.actions.refreshSessions();
    h.confirm.mockResolvedValue(false);
    const deleteSession = vi
      .spyOn(h.controller.actions, 'deleteSession')
      .mockImplementation(async () => { /* noop */ });
    renderSessions(h);

    fireEvent.click(screen.getByRole('button', { name: '删除会话' }));
    fireEvent.click(screen.getByRole('button', { name: '是' }));

    await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1));
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('confirm 返回 true 时调 deleteSession 一次', async () => {
    const h = makeHarness({ sessions: [session({ id: 's1', title: '待删' })] });
    await h.controller.actions.refreshSessions();
    h.confirm.mockResolvedValue(true);
    const deleteSession = vi
      .spyOn(h.controller.actions, 'deleteSession')
      .mockImplementation(async () => { /* noop */ });
    renderSessions(h);

    fireEvent.click(screen.getByRole('button', { name: '删除会话' }));
    fireEvent.click(screen.getByRole('button', { name: '是' }));

    await waitFor(() => expect(deleteSession).toHaveBeenCalledTimes(1));
    expect(deleteSession).toHaveBeenCalledWith('s1');
    expect(h.confirm).toHaveBeenCalledTimes(1);
  });
});
