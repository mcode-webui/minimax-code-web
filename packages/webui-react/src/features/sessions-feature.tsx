/** sessions-feature —— 左栏容器：会话列表/搜索/外观/语言/局域网卡/用量弹层的接线，删除确认走 NotifierPort（接缝：filteredGroups+actions → LeftPanel/SessionList props）。 */
import { useState } from 'react';

import type { SessionId } from '../contracts/domain';
import { KeyValueRow } from '../ui/primitives/KeyValueRow';
import { LeftPanel, type LanTokenState } from '../ui/layout/LeftPanel';
import { SessionList } from '../ui/sessions/SessionList';
import type { AppController } from './app-controller';
import { useRegistry } from './registry-context';
import { useAppActions, useAppSnapshot } from './use-app';

export interface SessionsFeatureProps {
  controller: AppController;
}

export function SessionsFeature({ controller }: SessionsFeatureProps) {
  const s = useAppSnapshot(controller);
  const a = useAppActions(controller);
  const { notifier } = useRegistry();

  // 弹层开合是纯界面瞬态，留在本容器。
  const [usageOpen, setUsageOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [lanOpen, setLanOpen] = useState(false);
  const [showUsage, setShowUsage] = useState(true);
  const [tokenVisible, setTokenVisible] = useState(false);

  const settings = s.settings;
  const titleOf = (id: SessionId): string => s.sessions.find((x) => x.id === id)?.title ?? id;

  // 缺口 #5：删除前先经 NotifierPort.confirm 确认，正文带会话标题。
  const handleDelete = (id: SessionId): void => {
    void (async () => {
      const ok = await notifier.confirm('删除会话', `确定删除会话「${titleOf(id)}」？删除后不可恢复。`);
      if (ok) await a.deleteSession(id);
    })().catch((e: unknown) => {
      // 删除被拒 / 网络失败：提示而不是未处理的 Promise 拒绝。
      notifier.toast(e instanceof Error ? e.message : String(e), 'error');
    });
  };

  const copyText = (text: string, okMsg: string): void => {
    const p = navigator.clipboard?.writeText(text);
    if (p) {
      void p.then(
        () => notifier.toast(okMsg, 'success'),
        () => notifier.toast('复制失败', 'error'),
      );
    } else {
      notifier.toast('当前环境不支持复制', 'warn');
    }
  };

  const token: LanTokenState = {
    enabled: settings?.tokenEnabled === true,
    token: typeof settings?.currentToken === 'string' ? settings.currentToken : '',
    visible: tokenVisible,
    showWarning: settings?.tokenEnabled === true && settings?.tokenAcknowledged !== true,
  };

  return (
    <LeftPanel
      open={s.leftOpen}
      onNewSession={() => void a.newChat()}
      searchValue={s.searchQuery}
      onSearchChange={a.setSearchQuery}
      onRefreshSessions={() => void a.refreshSessions()}
      // 缺口 #3：一律用已按 searchQuery 过滤的 filteredGroups，裸 groups 不进列表。
      renderList={() => (
        <SessionList
          groups={s.filteredGroups}
          activeSessionId={s.activeSessionId}
          collapsedKeys={s.collapsedGroups}
          onToggleGroup={a.toggleGroup}
          onSelect={(id) => void a.selectSession(id)}
          onRename={(id, title) => {
            void a.renameSession(id, title).catch((e: unknown) => {
              notifier.toast(e instanceof Error ? e.message : String(e), 'error');
            });
          }}
          onDelete={handleDelete}
        />
      )}
      // 套餐用量弹层
      usageHidden={!showUsage}
      usageOpen={usageOpen}
      onToggleUsage={() => setUsageOpen((v) => !v)}
      usageValue={s.usage?.fiveHourPercent != null ? `${s.usage.fiveHourPercent}%` : '—'}
      onRefreshUsage={() => void a.refreshUsage()}
      usage={{
        body: (
          <>
            <KeyValueRow label="5 小时" value={s.usage?.fiveHourPercent != null ? `${s.usage.fiveHourPercent}%` : '—'} muted />
            <KeyValueRow label="每周" value={s.usage?.weeklyPercent != null ? `${s.usage.weeklyPercent}%` : '—'} muted />
          </>
        ),
      }}
      // 外观卡片（主题 + 用量显示开关）
      appearanceOpen={appearanceOpen}
      onToggleAppearance={() => setAppearanceOpen((v) => !v)}
      appearanceValue={s.theme === 'dark' ? '深色' : '明亮'}
      dark={s.theme === 'dark'}
      onToggleTheme={(dark) => a.setTheme(dark ? 'dark' : 'light')}
      showUsage={showUsage}
      onToggleShowUsage={setShowUsage}
      // 语言
      languageValue={s.lang === 'zh' ? '中文' : 'EN'}
      onToggleLanguage={() => a.setLang(s.lang === 'zh' ? 'en' : 'zh')}
      // 局域网安全卡片
      lanValue={settings?.lanBroadcast === true ? '开' : '关'}
      onToggleLan={() => setLanOpen((v) => !v)}
      lanOpen={lanOpen}
      lanBroadcast={settings?.lanBroadcast === true}
      onToggleLanBroadcast={(on) => void a.updateSettings({ lanBroadcast: on })}
      readOnly={settings?.readOnly === true}
      onToggleReadOnly={(on) => void a.updateSettings({ readOnly: on })}
      tokenAuth={settings?.tokenEnabled === true}
      onToggleTokenAuth={(on) => void a.updateSettings({ tokenEnabled: on })}
      token={token}
      onToggleTokenVisible={() => setTokenVisible((v) => !v)}
      onCopyToken={() => copyText(token.token, '已复制 token')}
      onResetToken={() => {
        // 授权门拒绝会抛 "authorize declined" —— 提示收口，不冒未处理拒绝。
        void a.resetToken().catch((e: unknown) => {
          notifier.toast(e instanceof Error ? e.message : String(e), 'error');
        });
      }}
      onAcknowledgeToken={() => void a.acknowledgeToken()}
    />
  );
}
