/**
 * ui/composer/Composer.tsx —— 输入区总装（哑组件）
 * ============================================================================
 * 视觉职责：chat-area 底部的整个 input-area —— 附件列表区 + 输入框（自动增高
 * textarea + 工具条）+ 工作区 chip 行 + 快捷提示行。1:1 对齐 vanilla
 * public/index.html 的 .input-area / .input-inner / .input-box / .input-toolbar
 * 与 styles/main.css 的对应样式。
 *
 * 分层铁律：只 import contracts/domain.ts 与 ui/ 内部文件；数据 props 进、
 * 交互回调出 —— 不 fetch、不读 localStorage、不调 registry。
 * ============================================================================
 */
import './composer.css';

import type { KeyboardEvent, ReactNode } from 'react';
import { useEffect, useRef } from 'react';

import type { Attachment } from '../../contracts/domain';
import { AttachmentList } from './AttachmentList';

/**
 * 权限模式。与 modals/PermissionModal.tsx 的同名联合保持一致
 * （contracts 暂不含此类型；结构化类型系统下两个定义可互换）。
 */
export type PermissionMode = 'ask' | 'auto' | 'full';

const MODE_LABELS: Record<PermissionMode, string> = {
  ask: 'ASK',
  auto: 'AUTO',
  full: 'FULL',
};

export const COMPOSER_PLACEHOLDER =
  '输入消息... (/ 触发命令, @ 触发文件, Ctrl+V 粘贴图片)';

export interface ComposerProps {
  /** 输入内容（受控）。 */
  value: string;
  onChange: (value: string) => void;
  /** 发送：Enter 或发送按钮。 */
  onSend: () => void;
  /** 生成中 —— 发送按钮变为红色停止按钮。 */
  running: boolean;
  onStop: () => void;
  /** 整体禁用（如只读模式）。 */
  disabled?: boolean;
  placeholder?: string;

  /** 附件列表数据（附件区插槽，由 AttachmentList 渲染）。 */
  attachments: Attachment[];
  onRemoveAttachment: (id: string) => void;
  /** 回形针按钮 —— 请求添加附件（真正的文件选择由容器负责）。 */
  onAttachClick: () => void;

  /** 权限模式按钮：盾牌图标 + 当前模式短名。 */
  mode: PermissionMode;
  onModeClick: () => void;

  /** 模型按钮：显示当前模型短名 + 下拉箭头。 */
  modelLabel: string;
  modelTitle?: string;
  onModelClick: () => void;

  /** input-box 内部的锚定浮层插槽（ModelPicker 等，跟随输入框定位）。 */
  popoverSlot?: ReactNode;
  /** 输入框下方一行的工作区 chip 插槽（<WorkspaceChip …/>）。 */
  workspaceSlot?: ReactNode;
  /** 输入框下方的快捷提示行（可传字符串或自定义节点）。 */
  hint?: ReactNode;
}

/** Enter 发送 / Shift+Enter 换行；IME 组合输入中的 Enter 不触发发送。 */
function shouldSendOnEnter(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (e.key !== 'Enter') return false;
  if (e.shiftKey) return false;
  return !e.nativeEvent.isComposing;
}

export function Composer(props: ComposerProps) {
  const {
    value,
    onChange,
    onSend,
    running,
    onStop,
    disabled = false,
    placeholder = COMPOSER_PLACEHOLDER,
    attachments,
    onRemoveAttachment,
    onAttachClick,
    mode,
    onModeClick,
    modelLabel,
    modelTitle,
    onModelClick,
    popoverSlot,
    workspaceSlot,
    hint,
  } = props;

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 自动增高：随内容撑开，超过 240px 出滚动条。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value]);

  const empty = value.trim() === '' && attachments.length === 0;
  const sendDisabled = !running && (disabled || empty);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (shouldSendOnEnter(e)) {
      e.preventDefault();
      if (!sendDisabled) onSend();
    }
  };

  return (
    <div className="composer">
      <div className="composer-inner">
        <AttachmentList attachments={attachments} onRemove={onRemoveAttachment} />

        <div className="composer-box">
          <textarea
            ref={textareaRef}
            className="composer-textarea"
            rows={1}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
          />

          <div className="composer-toolbar">
            <button
              type="button"
              className="composer-btn-tool"
              title="附件 (Ctrl+V 粘贴)"
              disabled={disabled}
              onClick={onAttachClick}
            >
              <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>

            <button
              type="button"
              className="composer-btn-tool composer-btn-mode"
              title="权限模式"
              disabled={disabled}
              onClick={onModeClick}
            >
              <svg className="icon mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              <span className="composer-mode-label">{MODE_LABELS[mode]}</span>
            </button>

            <div className="composer-spacer" />

            <button
              type="button"
              className="composer-btn-tool composer-btn-model"
              title={modelTitle ?? '点击查看/切换模型'}
              disabled={disabled}
              onClick={onModelClick}
            >
              <span className="composer-model-label">{modelLabel}</span>
              <svg className="icon" width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            <button
              type="button"
              className={running ? 'composer-send is-stop' : 'composer-send'}
              title={running ? '停止' : '发送 (Enter)'}
              disabled={sendDisabled}
              onClick={running ? onStop : onSend}
            >
              <svg className="icon icon-send" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
              <svg className="icon icon-stop" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <rect x="6" y="6" width="12" height="12" rx="1.5" />
              </svg>
            </button>
          </div>

          {popoverSlot}
        </div>

        {workspaceSlot ? <div className="composer-workspace-row">{workspaceSlot}</div> : null}

        {hint ? <div className="composer-hint">{hint}</div> : null}
      </div>
    </div>
  );
}
