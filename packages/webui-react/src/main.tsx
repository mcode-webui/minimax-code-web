/**
 * main.tsx —— 浏览器入口（组装根的最外层）
 * ============================================================================
 * 只做三件事：注入设计令牌样式、装配 Registry、挂载 <App/>。
 * 业务编排全部在 features/app-controller.ts，视觉全部在 ui/。
 * ============================================================================
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import { App } from './App';
import { RegistryProvider } from './features/registry-context';

const el = document.getElementById('root');
if (!el) throw new Error('找不到 #root 挂载点');

createRoot(el).render(
  <StrictMode>
    <RegistryProvider>
      <App />
    </RegistryProvider>
  </StrictMode>,
);
