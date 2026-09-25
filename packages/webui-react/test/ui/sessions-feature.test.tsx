/**
 * sessions-feature 测试 —— 删除确认收敛到行内（× → 「删除？是/否」）。
 * ============================================================================
 * 行内「是」即最终确认：容器直接调 deleteSession 一次，不再二次弹
 * NotifierPort.confirm（原流程删个会话要点 4 次）。「否」/不确认则不调。
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
  it('行内「是」= 最终确认：直接调 deleteSession 一次（不再弹 Modal）', async () => {
    const h = makeHarness({ sessions: [session({ id: 's1', title: '待删' })] });
    await h.controller.actions.refreshSessions();
    const deleteSession = vi
      .spyOn(h.controller.actions, 'deleteSession')
      .mockImplementation(async () => { /* noop */ });
    renderSessions(h);

    fireEvent.click(screen.getByRole('button', { name: '删除会话' }));
    fireEvent.click(screen.getByRole('button', { name: '是' }));

    await waitFor(() => expect(deleteSession).toHaveBeenCalledTimes(1));
    expect(deleteSession).toHaveBeenCalledWith('s1');
    expect(h.confirm).not.toHaveBeenCalled(); // 行内确认取代 Modal
  });

  it('行内「否」= 取消：不调 deleteSession', async () => {
    const h = makeHarness({ sessions: [session({ id: 's1', title: '待删' })] });
    await h.controller.actions.refreshSessions();
    const deleteSession = vi
      .spyOn(h.controller.actions, 'deleteSession')
      .mockImplementation(async () => { /* noop */ });
    renderSessions(h);

    fireEvent.click(screen.getByRole('button', { name: '删除会话' }));
    fireEvent.click(screen.getByRole('button', { name: '否' }));

    expect(deleteSession).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });
});