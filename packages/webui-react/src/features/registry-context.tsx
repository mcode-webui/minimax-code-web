/**
 * features/registry-context.tsx —— 把端口注入 React 树的唯一入口
 * ============================================================================
 * 【咬合】features 层是全项目唯一允许同时看见 core（Registry）与 ui 的层。
 *   ui 组件从不 import 本文件；它们只收 props。本文件提供的 useRegistry()
 *   只被 features/ 内部与 App 组装根使用。
 * 【热插拔】测试里用 <RegistryProvider value={fakeRegistry}> 即可整套替换。
 * ============================================================================
 */

import { createContext, useContext, type ReactNode } from 'react';
import type { Registry } from '../contracts/ports';
import { getRegistry } from '../core/registry';

const RegistryContext = createContext<Registry | null>(null);

export interface RegistryProviderProps {
  value?: Registry;
  children: ReactNode;
}

export function RegistryProvider({ value, children }: RegistryProviderProps) {
  const reg = value ?? getRegistry();
  return <RegistryContext.Provider value={reg}>{children}</RegistryContext.Provider>;
}

export function useRegistry(): Registry {
  const reg = useContext(RegistryContext);
  if (!reg) throw new Error('useRegistry 必须在 <RegistryProvider> 内使用');
  return reg;
}
