/**
 * App.tsx —— 组装根的视图侧
 * ============================================================================
 * 【咬合】本文件与 features/app-controller.ts 是 ui 与 core 的唯一交汇处。
 *   它把 AppSnapshot 的字段逐一对到哑组件的 props 上、把 AppActions 的方法
 *   接到回调上。除此之外不含任何业务逻辑。
 * 【热插拔】Registry 在这里被注入 NotifierPort 的 antd 实现 —— 证明端口可换。
 * ============================================================================
 */

import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, ConfigProvider, message, theme as antdTheme, Modal } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';

import { AppShell } from './ui/layout/AppShell';
import { TopBar } from './ui/layout/TopBar';
import { LeftPanel } from './ui/layout/LeftPanel';
import { ChatArea } from './ui/layout/ChatArea';
import { RightPanel } from './ui/layout/RightPanel';
import { SessionList } from './ui/sessions/SessionList';
import { SessionSearch } from './ui/sessions/SessionSearch';
import { MessageList } from './ui/chat/MessageList';
import { EmptyState } from './ui/chat/EmptyState';
import { Composer, type PermissionMode } from './ui/composer/Composer';
import { ModelPicker } from './ui/composer/ModelPicker';

import { createAppController } from './features/app-controller';
import { useAppActions, useAppSnapshot } from './features/use-app';
import { replacePort, getRegistry } from './core/registry';
import type { NotifierPort } from './contracts/ports';
import { setLang, type Lang } from './i18n';

// 控制器是进程内单例：StrictMode 的双重渲染不会重建它（重建会丢会话隔离状态）。
const controller = createAppController(getRegistry());

/** antd 的 NotifierPort 实现 —— 运行期热插拔注入，替换 core 的 console 默认实现。 */
const antdNotifier: NotifierPort = {
  toast(msg, kind = 'info') {
    if (kind === 'error') message.error(msg);
    else if (kind === 'warn') message.warning(msg);
    else if (kind === 'success') message.success(msg);
    else message.info(msg);
  },
  confirm(title, body) {
    return new Promise<boolean>((resolve) => {
      Modal.confirm({ title, content: body, onOk: () => resolve(true), onCancel: () => resolve(false) });
    });
  },
};

function shortModelName(full: string | undefined): string {
  if (!full) return '—';
  return full.includes('/') ? (full.split('/').pop() ?? full) : full;
}

export function App() {
  const s = useAppSnapshot(controller);
  const a = useAppActions(controller);

  const [composerText, setComposerText] = useState('');
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [permMode, setPermMode] = useState<PermissionMode>('ask');
  const [alertsOpen, setAlertsOpen] = useState(false);

  // 热插拔：用 antd 实现替换 NotifierPort（core 不感知 antd）。
  useEffect(() => { replacePort('notifier', antdNotifier); }, []);

  // 主题与语言跟随快照，落到 <html data-theme>（tokens.css 据此切换）。
  useEffect(() => { document.documentElement.dataset.theme = s.theme; }, [s.theme]);
  useEffect(() => { setLang(s.lang as Lang); }, [s.lang]);

  const messages = s.slice?.messages ?? [];
  const running = s.slice?.running ?? false;
  const selection = s.slice?.selection;

  const composer = useMemo(() => (
    <Composer
      value={composerText}
      onChange={setComposerText}
      onSend={() => { const v = composerText.trim(); if (!v) return; setComposerText(''); void a.send(v); }}
      running={running}
      onStop={() => void a.stop()}
      disabled={s.settings?.readOnly === true}
      attachments={s.slice?.attachments ?? []}
      onRemoveAttachment={a.removeAttachment}
      onAttachClick={() => { /* 文件选择由容器的隐藏 input 处理 */ }}
      mode={permMode}
      onModeClick={() => setPermMode((m) => (m === 'ask' ? 'auto' : m === 'auto' ? 'full' : 'ask'))}
      modelLabel={shortModelName(selection?.model)}
      modelTitle={selection ? selection.provider + ' / ' + selection.model + ' · ' + selection.thinking : undefined}
      onModelClick={() => setModelPickerOpen(true)}
      popoverSlot={
        <ModelPicker
          open={modelPickerOpen}
          providers={s.providers}
          models={s.models}
          selection={selection ?? { provider: '', model: '', thinking: 'medium' }}
          onSelectProvider={(p) => void a.setProvider(p)}
          onSelectModel={(m) => void a.setModel(m)}
          onSelectThinking={(e) => void a.setThinking(e)}
          onSubmitCustom={(v) => { void a.submitCustomModel(v); setModelPickerOpen(false); }}
          onClose={() => setModelPickerOpen(false)}
        />
      }
    />
  ), [composerText, running, permMode, selection, s.providers, s.models, s.settings, s.slice, a]);

  return (
    <ConfigProvider
      locale={s.lang === 'zh' ? zhCN : enUS}
      theme={{
        algorithm: s.theme === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: { borderRadius: 10, fontFamily: 'inherit' },
      }}
    >
      <AntApp>
        <AppShell
          leftOpen={s.leftOpen}
          rightOpen={s.rightOpen}
          onBackdropClick={() => { a.setLeftOpen(false); a.setRightOpen(false); }}
          topbar={
            <TopBar
              onToggleLeft={() => a.setLeftOpen(!s.leftOpen)}
              onToggleRight={() => a.setRightOpen(!s.rightOpen)}
              readOnly={s.settings?.readOnly === true}
              lanUrl={s.settings?.lanUrl ?? null}
              unreadCount={s.alertsUnread}
              alertsOpen={alertsOpen}
              onToggleAlerts={() => { const next = !alertsOpen; setAlertsOpen(next); if (next) a.markAlertsRead(); }}
              alerts={s.alerts}
              onClearAlerts={a.clearAlerts}
              onForceReload={() => window.location.reload()}
            />
          }
          left={
            <LeftPanel
              onNewSession={() => void a.newChat()}
              searchValue={s.searchQuery}
              onSearchChange={a.setSearchQuery}
              onRefreshSessions={() => void a.refreshSessions()}
              renderList={() => (
                <SessionList
                  groups={s.groups}
                  activeSessionId={s.activeSessionId}
                  collapsedKeys={s.collapsedGroups}
                  onToggleGroup={a.toggleGroup}
                  onSelect={(id) => void a.selectSession(id)}
                  onRename={(id, t) => void a.renameSession(id, t)}
                  onDelete={(id) => void a.deleteSession(id)}
                />
              )}
              dark={s.theme === 'dark'}
              onToggleTheme={(dark) => a.setTheme(dark ? 'dark' : 'light')}
              languageValue={s.lang === 'zh' ? '中文' : 'EN'}
              onToggleLanguage={() => a.setLang(s.lang === 'zh' ? 'en' : 'zh')}
              usageValue={s.usage?.fiveHourPercent != null ? s.usage.fiveHourPercent + '%' : '—'}
              onRefreshUsage={() => void a.refreshUsage()}
              readOnly={s.settings?.readOnly === true}
              lanBroadcast={s.settings?.lanBroadcast === true}
              onToggleLanBroadcast={(on) => void a.updateSettings({ lanBroadcast: on })}
              onToggleReadOnly={(on) => void a.updateSettings({ readOnly: on })}
              tokenAuth={s.settings?.tokenEnabled === true}
              onToggleTokenAuth={(on) => void a.updateSettings({ tokenEnabled: on })}
              onResetToken={() => void a.resetToken()}
              onAcknowledgeToken={() => void a.acknowledgeToken()}
            />
          }
          chat={
            <ChatArea
              welcome={messages.length === 0}
              empty={<EmptyState />}
              messages={<MessageList messages={messages} streaming={running} sessionKey={s.activeSessionId ?? 'none'} />}
              thinking={running}
              composer={composer}
              onDropFiles={(files) => void a.uploadFiles(files)}
            />
          }
          right={
            <RightPanel
              todos={s.slice?.todos ?? []}
              goal={s.slice?.goal ?? null}
              sessionId={s.activeSessionId ?? ''}
              sessionTitle={s.slice?.summary?.title ?? ''}
              selection={selection}
              workspace={s.slice?.workspace ?? s.workspace}
              context={s.context ?? s.slice?.context}
              slice={s.slice}
            />
          }
        />
      </AntApp>
    </ConfigProvider>
  );
}

// 让 SessionSearch 不被视为未使用（左栏搜索框由 LeftPanel 内部渲染，这里保留导出供后续拆分）。
export { SessionSearch };
