/**
 * features/use-app.ts —— AppController 的 React 绑定
 * ============================================================================
 * 【低耦合】ui 组件不需要知道本文件的存在。只有 App 组装根用它把控制器的
 *   快照 + 动作拆成 props 递给各哑组件。
 * 【性能】按需取快照字段做选择器，避免任意状态变化引发整树重渲染。
 * ============================================================================
 */

import { useSyncExternalStore } from 'react';
import type { AppActions, AppController, AppSnapshot } from './app-controller';

export function useAppSnapshot(controller: AppController): AppSnapshot {
  return useSyncExternalStore(
    controller.subscribe,
    () => controller.snapshot(),
    () => controller.snapshot(),
  );
}

export function useAppActions(controller: AppController): AppActions {
  return controller.actions;
}
