/**
 * chat-feature 测试 —— 缺口 #7（#4 去重）：空态 / 思考态只出现一个。
 * ============================================================================
 * messages 为空且 running=false 时只出现一个空态；running=true 时只出现一个「思考中」。
 * 容器契约：ChatFeature({ controller }) 把 empty/thinking 插槽置空，空态与
 * ThinkingBar 统一交给 MessageList 内部二选一渲染，避免 ChatArea 与 MessageList 双份。
 * ============================================================================
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { RegistryProvider } from '../../src/features/registry-context';
import { ChatFeature } from '../../src/features/chat-feature';
import { makeHarness } from '../fakes';

function renderChat(h: ReturnType<typeof makeHarness>): void {
  render(
    <RegistryProvider value={h.reg}>
      <ChatFeature controller={h.controller} />
    </RegistryProvider>,
  );
}

describe('空态 / 思考态去重（缺口 #7）', () => {
  it('messages 为空且 running=false 时只出现一个空态', async () => {
    const h = makeHarness({ slices: { s1: { messages: [], running: false } } });
    await h.controller.actions.selectSession('s1');
    renderChat(h);
    expect(screen.getAllByText(/还没有消息/)).toHaveLength(1);
  });

  it('running=true 时只出现一个「思考中」', async () => {
    const h = makeHarness({ slices: { s1: { messages: [], running: true } } });
    await h.controller.actions.selectSession('s1');
    renderChat(h);
    expect(screen.getAllByText('思考中')).toHaveLength(1);
  });
});
