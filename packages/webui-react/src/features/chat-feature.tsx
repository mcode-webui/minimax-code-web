/** chat-feature —— 中栏容器：标题栏（会话切换下拉）+ 消息流 + 执行状态条 + 操作行接线（接缝：SessionSlice → ChatArea/MessageList props）。 */
import { useEffect, useMemo, useState } from 'react';

import type { AskUserBlock } from '../contracts/domain';
import { MessageList } from '../ui/chat/MessageList';
import { ChatArea } from '../ui/layout/ChatArea';
import { SessionTitleBar } from '../ui/chat/SessionTitleBar';
import type { ExecStats } from '../ui/chat/ExecStatusRow';
import type { Feedback } from '../ui/chat/MessageActions';
import { IconButton } from '../ui/primitives/IconButton';
import { Icon } from '../ui/primitives/Icon';
import type { AppController } from './app-controller';
import { ComposerFeature } from './composer-feature';
import { useRegistry } from './registry-context';
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
  const { notifier } = useRegistry();

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

  // ── 会话切换下拉（标题栏 ∨）──────────────────────────────────────────────
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // ── 执行状态条数据：客户端计时（running 起止）+ 服务端 context.tps ──────
  // 服务端只有 running 布尔与 tps，无逐回合耗时 —— 客户端记录 running 起点，
  // 运行中每秒跳一次；结束时定格，作为「共执行 N 秒」保留到下一回合。
  const tps = s.slice?.context?.tps ?? 0;
  const [runStart, setRunStart] = useState<number | null>(null);
  const [lastDuration, setLastDuration] = useState<number | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (running) {
      setRunStart((prev) => (prev === null ? Date.now() : prev));
    } else if (runStart !== null) {
      setLastDuration(Math.max(1, Math.round((Date.now() - runStart) / 1000)));
      setRunStart(null);
    }
  }, [running, runStart]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  // 切会话清零（执行统计只属于当前会话的最近回合）。
  useEffect(() => {
    setRunStart(null);
    setLastDuration(null);
  }, [sessionId]);
  const execStats: ExecStats | null = useMemo(() => {
    if (running && runStart !== null) {
      return { durationSec: (Date.now() - runStart) / 1000, tps: tps > 0 ? tps : null, running: true };
    }
    if (!running && lastDuration !== null) {
      return { durationSec: lastDuration, tps: tps > 0 ? tps : null, running: false };
    }
    return null;
    // tick 参与 deps：运行中每秒触发重算（lint 不查未用 dep）。
  }, [running, runStart, lastDuration, tps]);

  // ── 赞 / 踩（本地 UI 态，按消息 id，会话切换即弃）────────────────────────
  const [feedbacks, setFeedbacks] = useState<Record<string, Feedback>>({});
  useEffect(() => {
    setFeedbacks({});
  }, [sessionId]);

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

  const copyResult = (ok: boolean): void => {
    notifier.toast(ok ? '已复制' : '当前环境不支持复制', ok ? 'success' : 'warn');
  };

  const title = s.slice?.summary?.title ?? '';

  return (
    <ChatArea
      welcome={messages.length === 0}
      titlebar={
        <SessionTitleBar
          title={title}
          expanded={switcherOpen}
          running={running}
          readOnly={s.settings?.readOnly === true}
          onTitleClick={() => setSwitcherOpen((v) => !v)}
          left={
            <IconButton
              icon="panel-left"
              label="切换侧栏"
              box="md"
              active={s.leftOpen}
              onClick={() => a.setLeftOpen(!s.leftOpen)}
            />
          }
          right={
            <>
              <IconButton
                icon="columns"
                label="文件树"
                box="md"
                active={s.rightTab === 'files'}
                onClick={() => a.setRightTab(s.rightTab === 'files' ? null : 'files')}
              />
              <IconButton
                icon="book"
                label="文档预览"
                box="md"
                active={s.rightTab === 'preview'}
                onClick={() => a.setRightTab(s.rightTab === 'preview' ? null : 'preview')}
              />
              <IconButton
                icon="globe"
                label="内置浏览器"
                box="md"
                active={s.rightTab === 'browser'}
                onClick={() => a.setRightTab(s.rightTab === 'browser' ? null : 'browser')}
              />
              <IconButton
                icon="git-branch"
                label="Git 变更"
                box="md"
                active={s.rightTab === 'git'}
                onClick={() => a.setRightTab(s.rightTab === 'git' ? null : 'git')}
              />
              <IconButton
                icon="panel-right"
                label="会话详情"
                box="md"
                active={s.rightTab === 'details'}
                onClick={() => a.setRightTab(s.rightTab === 'details' ? null : 'details')}
              />
            </>
          }
          dropdown={
            switcherOpen ? (
              <>
                {/* 点外部收起 */}
                <div
                  style={{ position: 'fixed', inset: 0, zIndex: 29 }}
                  onClick={() => setSwitcherOpen(false)}
                  aria-hidden="true"
                />
                <div className="stitle-dropdown" role="listbox" style={{ zIndex: 30 }}>
                  {s.sessions.length === 0 ? (
                    <div className="stitle-option" style={{ color: 'var(--text-tertiary)' }}>
                      暂无会话
                    </div>
                  ) : (
                    s.sessions.map((sess) => (
                      <button
                        key={sess.id}
                        type="button"
                        role="option"
                        aria-selected={sess.id === s.activeSessionId}
                        className={
                          sess.id === s.activeSessionId ? 'stitle-option stitle-option--active' : 'stitle-option'
                        }
                        onClick={() => {
                          setSwitcherOpen(false);
                          if (sess.id !== s.activeSessionId) {
                            void a.selectSession(sess.id).catch((e: unknown) => {
                              notifier.toast(e instanceof Error ? e.message : String(e), 'error');
                            });
                          }
                        }}
                      >
                        <Icon name="file-text" size={13} />
                        <span className="stitle-option-text">{sess.title || sess.id}</span>
                      </button>
                    ))
                  )}
                </div>
              </>
            ) : null
          }
        />
      }
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
            execStats={execStats}
            feedbacks={feedbacks}
            onFeedback={(mid, next) => setFeedbacks((prev) => ({ ...prev, [mid]: next }))}
            onCopyResult={copyResult}
            onRetry={() => {
              void a.resendLast().catch((e: unknown) => {
                notifier.toast(e instanceof Error ? e.message : String(e), 'error');
              });
            }}
          />
        </>
      }
      composer={<ComposerFeature controller={controller} />}
      onDropFiles={(files) => void a.uploadFiles(files)}
    />
  );
}
