/**
 * core/store/create-store.ts —— 极简可观察 store（零依赖）
 * ============================================================================
 * 【高内聚】只做一件事：一份状态 + 订阅 + 不可变更新。
 * 【热插拔】签名刻意与 useSyncExternalStore 对齐，未来可直接换成 zustand /
 *   Redux / Jotai 而不动任何订阅方。core 与 ui 都只通过它读写状态。
 * ============================================================================
 */

export type Updater<S> = Partial<S> | ((prev: S) => S);

export interface Store<S> {
  get(): S;
  set(update: Updater<S>): void;
  subscribe(listener: () => void): () => void;
  /** 供 useSyncExternalStore 使用的快照读取。 */
  snapshot(): S;
}

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();

  return {
    get: () => state,
    snapshot: () => state,
    set(update) {
      const patch = typeof update === 'function' ? update(state) : update;
      // 不可变更新：引用变了才通知，天然避免无意义的重渲染。
      state = { ...state, ...patch };
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

// 注：React 绑定（useStore）刻意不放在本文件 —— core 必须零 UI 依赖，
// 否则 headless 场景（Node 端 / 单测）无法复用本 store。绑定见 features/use-store.ts。
