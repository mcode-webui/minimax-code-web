/**
 * ui/modals/index.ts —— 弹窗统一导出
 * ============================================================================
 * 全部为哑组件：受控 open + 回调出，视觉对齐 vanilla public/ 的各弹窗。
 * ============================================================================
 */

export { AskModal } from './AskModal';
export type { AskModalAnswer, AskModalProps, AskModalQuestion } from './AskModal';

export { AuthModal, formatAuthCountdown } from './AuthModal';
export type { AuthModalProps, AuthModalRequest } from './AuthModal';

export { PlanModal } from './PlanModal';
export type { PlanChoice, PlanModalProps } from './PlanModal';

export { PlanModeModal } from './PlanModeModal';
export type { PlanModeChoice, PlanModeModalProps } from './PlanModeModal';

export { PermissionModal } from './PermissionModal';
export type { PermissionMode, PermissionModalProps } from './PermissionModal';

export { ApiKeyModal } from './ApiKeyModal';
export type { ApiKeyModalProps, ApiKeySource } from './ApiKeyModal';
