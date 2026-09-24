/** chat-feature —— 中栏容器：消息流 + 空态/思考态去重（交给 MessageList）+ ask-user 行内应答接线（接缝：SessionSlice.messages → ChatArea/MessageList props）。 */
import { useEffect, useMemo, useState } from 'react';

import type { AskUserBlock } from '../contracts/domain';
import { MessageList } from '../ui/chat/MessageList';
import { ChatArea } from '../ui/layout/ChatArea';
import type { AppController } from './app-controller';
import { ComposerFeature } from './composer-feature';
import { useAppActions, useAppSnapshot } from './use-app';

export interface ChatFeatureProps {
  controller: AppController;
}

/**
 * 渲染窗口：长会话（数万行 hydrate 出数千条消息）全量渲染会压垮渲染进程 ——
 * 实测 41 万字会话点击即黑屏。只渲染最近 WINDOW 条，「加载更早」每次放行一批。
 */
const RENDER_WINDOW = 300;
const RENDER_WINDOW_STEP = 500;

export function ChatFeature({ controller }: ChatFeatureProps) {
  const s = useAppSnapshot(controller);
  const a = useAppActions(controller);

  const allMessages = s.slice?.messages ?? [];
  const running = s.slice?.running ?? false;
  const total = allMessages.length;
  // 额外放行的更早消息数（「加载更早」累加；切会话归零）。
  const [extraCount, setExtraCount] = useState(0);
  const sessionId = s.activeSessionId;
  useEffect(() => {
    setExtraCount(0);
  }, [sessionId]);
  const from = Math.max(0, total - RENDER_WINDOW - extraCount);
  const messages = useMemo(
    () => (from === 0 ? allMessages : allMessages.slice(from)),
    [allMessages, from],
  );
  const loadEarlier = (): void => setExtraCount((w) => w + RENDER_WINDOW_STEP);
  const hiddenEarlier = from;

  // 行内 ask-user 块的应答：MessageList 的回调只带 optionId，块 id 由容器定位到
  // 「最后一个未答 ask 块」（同一时刻通常只有一个待答提问）；勾选态在本容器镜像
  // 一份用于受控渲染，同时同步给 actions.sendAskOptionToggle 按会话隔离保存。
  const activeAsk = useMemo<AskUserBlock | null>(() => {
    let found: AskUserBlock | null = null;
    for (const m of messages) {
      for (const b of m.blocks) {
        if (b.kind === 'ask-user' && b.answered !== true) found = b;
      }
    }
    return found;
  }, [messages]);
  const [askSelections, setAskSelections] = useState<Record<string, readonly string[]>>({});

  const toggleAskOption = (optionId: string): void => {
    const block = activeAsk;
    if (!block) return;
    a.sendAskOptionToggle(block.id, optionId);
    setAskSelections((prev) => {
      const cur = prev[block.id] ?? [];
      const next = block.multiSelect
        ? cur.includes(optionId)
          ? cur.filter((x) => x !== optionId)
          : [...cur, optionId]
        : [optionId];
      return { ...prev, [block.id]: next };
    });
  };

  const confirmAsk = (optionIds: string[]): void => {
    const block = activeAsk;
    if (!block) return;
    a.sendAskConfirm(block.id, optionIds);
    setAskSelections((prev) => ({ ...prev, [block.id]: [] }));
  };

  return (
    <ChatArea
      welcome={messages.length === 0}
      // 缺口 #4：empty / thinking 插槽置空 —— 空态与 ThinkingBar 统一由 MessageList
      // 内部渲染（它已按 messages/streaming 二选一），不再出现双份。
      messages={
        <>
          {hiddenEarlier > 0 ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0' }}>
              <button
                type="button"
                onClick={loadEarlier}
                style={{
                  padding: '4px 14px',
                  background: 'transparent',
                  border: '1px solid var(--border, #444)',
                  borderRadius: 999,
                  color: 'var(--text-secondary, #999)',
                  fontSize: 12,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                加载更早的消息（还有 {hiddenEarlier} 条）
              </button>
            </div>
          ) : null}
          <MessageList
            messages={messages}
            streaming={running}
            sessionKey={s.activeSessionId ?? 'none'}
            askSelectedIds={activeAsk ? (askSelections[activeAsk.id] ?? []) : []}
            onAskToggleOption={toggleAskOption}
            onAskConfirm={confirmAsk}
          />
        </>
      }
      composer={<ComposerFeature controller={controller} />}
      onDropFiles={(files) => void a.uploadFiles(files)}
    />
  );
}
