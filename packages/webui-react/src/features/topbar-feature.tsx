/** topbar-feature —— 顶栏容器：把快照的只读/局域网/告警状态与动作接到 TopBar 哑组件（接缝：AppSnapshot → TopBar props）。 */
import { useState } from 'react';

import { TopBar } from '../ui/layout/TopBar';
import type { AppController } from './app-controller';
import { useRegistry } from './registry-context';
import { useAppActions, useAppSnapshot } from './use-app';

export interface TopbarFeatureProps {
  controller: AppController;
}

export function TopbarFeature({ controller }: TopbarFeatureProps) {
  const s = useAppSnapshot(controller);
  const a = useAppActions(controller);
  const { notifier } = useRegistry();
  const [alertsOpen, setAlertsOpen] = useState(false);

  const copyLanUrl = (url: string): void => {
    const p = navigator.clipboard?.writeText(url);
    if (p) {
      void p.then(
        () => notifier.toast('已复制局域网访问 URL', 'success'),
        () => notifier.toast('复制失败', 'error'),
      );
    } else {
      notifier.toast('当前环境不支持复制', 'warn');
    }
  };

  return (
    <TopBar
      onToggleLeft={() => a.setLeftOpen(!s.leftOpen)}
      onToggleRight={() => a.setRightOpen(!s.rightOpen)}
      readOnly={s.settings?.readOnly === true}
      lanUrl={s.settings?.lanUrl ?? null}
      onCopyLanUrl={copyLanUrl}
      unreadCount={s.alertsUnread}
      alertsOpen={alertsOpen}
      onToggleAlerts={() => {
        const next = !alertsOpen;
        setAlertsOpen(next);
        if (next) a.markAlertsRead();
      }}
      alerts={s.alerts}
      onClearAlerts={a.clearAlerts}
      onForceReload={() => window.location.reload()}
    />
  );
}
