/**
 * core/registry.ts —— 组装根（composition root）＝ 热插拔的唯一替换点
 * ============================================================================
 * 【热插拔易迭代】所有模块不许自己 new 端口实现，一律从这里取。
 *   - 生产：  createRegistry()        -> core/defaults.ts 的默认实现
 *   - 测试：  createRegistry({...})   -> 覆盖任意端口（注入 fake）
 *   - 运行期：replacePort('models', p) -> 换供应商实现，其余模块无感
 *
 * 【低耦合】依赖方向：features/ui -> 本文件 -> contracts/ports.ts。任何模块
 *   都不反向依赖本文件的调用方。
 * ============================================================================
 */

import type { Registry, RegistryOverrides } from '../contracts/ports';
import { createDefaultRegistry } from './defaults';

/** 用默认实现 + 覆盖项装配一套端口。纯函数，不写全局。 */
export function createRegistry(overrides: RegistryOverrides = {}): Registry {
  return { ...createDefaultRegistry(), ...overrides };
}

// 进程内单例 —— 仅供 React 组装根与非 React 代码取用。
let current: Registry | null = null;

export function getRegistry(): Registry {
  if (!current) current = createRegistry();
  return current;
}

/** 整套替换（例如切换到完全不同的后端实现）。 */
export function setRegistry(next: Registry): void {
  current = next;
}

/** 热插拔单个端口：换供应商 / 换传输 / 换状态库，其余模块无感。 */
export function replacePort<K extends keyof Registry>(key: K, impl: Registry[K]): void {
  current = { ...getRegistry(), [key]: impl };
}

/** 测试用：丢弃单例，下次 getRegistry() 重新装配。 */
export function resetRegistry(): void {
  current = null;
}
