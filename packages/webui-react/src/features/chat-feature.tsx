/** chat-feature —— 中栏容器：消息流 + 空态/思考态去重（交给 MessageList）+ ask-user 行内应答接线（接缝：SessionSlice.messages → ChatArea/MessageList props）。 */
import { useMemo, useState } from 'react';

import type { AskUserBlock } from '../contracts/domain';
import { MessageList } from '../ui/chat/MessageList';
import { ChatArea } from '../ui/layout/ChatArea';
import type { AppController } from './app-controller';
import { ComposerFeature } from './composer-feature';
import { useAppActions, useAppSnapshot } from './use-app';

export interface ChatFeatureProps {
  controller: AppController;
}

export function ChatFeature({ controller }: ChatFeatureProps) {
  const s = useAppSnapshot(controller);
  const a = useAppActions(controller);

  const messages = s.slice?.messages ?? [];
  const running = s.slice?.running ?? false;

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
        <MessageList
          messages={messages}
          streaming={running}
          sessionKey={s.activeSessionId ?? 'none'}
          askSelectedIds={activeAsk ? (askSelections[activeAsk.id] ?? []) : []}
          onAskToggleOption={toggleAskOption}
          onAskConfirm={confirmAsk}
        />
      }
      composer={<ComposerFeature controller={controller} />}
      onDropFiles={(files) => void a.uploadFiles(files)}
    />
  );
}
