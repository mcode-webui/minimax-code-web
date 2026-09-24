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
  // 必须用 Object.assign 回填到同一个对象，而不是 spread 出新对象：
  // core 各 service 持有的是这个 registry 对象本身（ports holder），
  // 换成新对象会让 replacePort/overrides 作用在拷贝上，service 内部看不到新端口。
  return Object.assign(createDefaultRegistry(), overrides);
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

/**
 * 热插拔单个端口：换供应商 / 换传输 / 换状态库，其余模块无感。
 *
 * 【关键】必须**原地改**而不是换新对象 —— 调用方（例如 app-controller）可能在
 * 模块级就持有了 registry 引用；若这里返回新对象，那些持有者会继续用旧端口，
 * "热插拔"就变成假的。
 */
export function replacePort<K extends keyof Registry>(key: K, impl: Registry[K]): void {
  const live = getRegistry() as unknown as Record<string, unknown>;
  live[key as string] = impl;
}

/** 测试用：丢弃单例，下次 getRegistry() 重新装配。 */
export function resetRegistry(): void {
  current = null;
}
