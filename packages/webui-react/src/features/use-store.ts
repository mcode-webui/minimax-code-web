/**
 * features/use-store.ts —— 极简 store 的 React 绑定
 * ============================================================================
 * 【为什么放这】core/store/create-store.ts 必须零 UI 依赖（headless 可复用），
 *   而 useSyncExternalStore 是 React 专属。把这层桥接收进 features —— 正是它
 *   作为 core↔ui 咬合层的职责。
 * 【热插拔】换状态库时只改本文件与 core/store，订阅方无感。
 * ============================================================================
 */

import { useSyncExternalStore } from 'react';
import type { Store } from '../core/store/create-store';

/** 组件里 useStore(store, s => s.x) 即可，选择器最小重渲染。 */
export function useStore<S extends object, T>(store: Store<S>, selector: (s: S) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.snapshot()),
    () => selector(store.snapshot()),
  );
}
