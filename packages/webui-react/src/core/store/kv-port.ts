/**
 * core/store/kv-port.ts —— KeyValueStorePort 的 localStorage 实现
 * 【职责】为 token / cid / 语言 / 最近工作区 / 每会话模型选择等轻量偏好提供持久化。
 * 【接缝】实现 contracts/ports.ts 的 KeyValueStorePort；所有读写 try/catch 容错，
 *   无 storage（隐私模式 / SSR / 配额溢出）时静默降级为进程内 Map，绝不向调用方抛错。
 */
import type { KeyValueStorePort } from '../../contracts/ports';

export function createKvPort(): KeyValueStorePort {
  const memory = new Map<string, string>();
  let storage: Storage | null = null;
  try {
    storage = typeof localStorage !== 'undefined' ? localStorage : null;
    if (storage) {
      const probe = '__webui_kv_probe__';
      storage.setItem(probe, '1');
      storage.removeItem(probe);
    }
  } catch {
    // localStorage 存在但不可用（隐私模式 / 被禁用）——降级为内存
    storage = null;
  }

  return {
    get(key: string): string | null {
      try {
        if (storage) {
          const v = storage.getItem(key);
          if (v !== null) return v;
        }
      } catch {
        // 读失败时落到内存镜像
      }
      return memory.get(key) ?? null;
    },
    set(key: string, value: string): void {
      memory.set(key, value);
      try {
        if (storage) storage.setItem(key, value);
      } catch {
        // 写失败（配额满等）——内存镜像保底
      }
    },
    remove(key: string): void {
      memory.delete(key);
      try {
        if (storage) storage.removeItem(key);
      } catch {
        // 忽略
      }
    },
  };
}
