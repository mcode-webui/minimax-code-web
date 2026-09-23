/**
 * App.tsx —— 组装根的视图侧
 * ============================================================================
 * 【咬合】本文件只做装配：控制器构造（在 <RegistryProvider> 之外的进程内单例）、
 *   ConfigProvider（主题/语言）、AppShell 四插槽拼装、主题/语言副作用。
 *   快照到 props 的翻译全部下沉到 features/*-feature.tsx 六个容器。
 * 【热插拔】Registry 在这里被注入 NotifierPort 的 antd 实现 —— 证明端口可换。
 * ============================================================================
 */

import { useEffect } from 'react';
import { App as AntApp, ConfigProvider, message, theme as antdTheme, Modal } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';

import { AppShell } from './ui/layout/AppShell';
import { createAppController } from './features/app-controller';
import { useAppActions, useAppSnapshot } from './features/use-app';
import { TopbarFeature } from './features/topbar-feature';
import { SessionsFeature } from './features/sessions-feature';
import { ChatFeature } from './features/chat-feature';
import { PanelsFeature } from './features/panels-feature';
import { ModalsFeature } from './features/modals-feature';
import { replacePort, getRegistry } from './core/registry';
import type { NotifierPort } from './contracts/ports';
import { setLang } from './i18n';

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

export function App() {
  const s = useAppSnapshot(controller);
  const a = useAppActions(controller);

  // 热插拔：用 antd 实现替换 NotifierPort（core 不感知 antd）。
  useEffect(() => { replacePort('notifier', antdNotifier); }, []);

  // 主题与语言跟随快照，落到 <html data-theme>（tokens.css 据此切换）。
  useEffect(() => { document.documentElement.dataset.theme = s.theme; }, [s.theme]);
  useEffect(() => { setLang(s.lang); }, [s.lang]);

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
          topbar={<TopbarFeature controller={controller} />}
          left={<SessionsFeature controller={controller} />}
          chat={<ChatFeature controller={controller} />}
          right={<PanelsFeature controller={controller} />}
        />
        <ModalsFeature controller={controller} />
      </AntApp>
    </ConfigProvider>
  );
}
