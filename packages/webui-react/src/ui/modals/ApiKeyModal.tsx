/**
 * ui/modals/ApiKeyModal.tsx —— 配置 Subscription Key 弹窗（哑组件，受控 open）
 * ============================================================================
 * 视觉职责：标题「配置 Subscription Key」+ 右上关闭 X + 状态行
 * （已配置（含掩码）/ 未配置 + 来源 env/file 标注）+ 密钥输入框 + 帮助文案 +
 * 底部「删除 / 取消 / 保存」。
 *
 * 行为（对齐 vanilla #api-key-modal）：
 *   - 外部来源（env / file）时「删除」隐藏并给 title 说明（key 由外部管理）；
 *   - 外部来源时输入框 placeholder 提示 env/file 优先，此处保存的值暂不生效；
 *   - 输入框回车 = 保存；Esc / X / 遮罩 = onClose。
 * ============================================================================
 */
import './apikey.css';

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEffect, useRef } from 'react';

/** 密钥来源（对齐 protocol 的 tokenPlanApiKeySource）。 */
export type ApiKeySource = 'env' | 'file' | 'settings' | '';

export interface ApiKeyModalProps {
  open: boolean;
  /** 是否已配置。 */
  configured: boolean;
  /** 已保存密钥的掩码（如 'sk-cp-****1234'）。 */
  masked?: string;
  /** 密钥来源。 */
  source?: ApiKeySource;
  /** source==='file' 时的文件路径。 */
  filePath?: string;
  /** 输入值（受控，组件从不回填旧密钥）。 */
  value: string;
  onValueChange: (value: string) => void;
  /** 保存。 */
  onSave: () => void;
  /** 删除（仅 settings 来源且已配置时可用）。 */
  onDelete: () => void;
  /** 取消 / X / Esc / 遮罩。 */
  onClose: () => void;
  title?: string;
  deleteDisabledTitle?: string;
}

export function ApiKeyModal(props: ApiKeyModalProps) {
  const {
    open,
    configured,
    masked,
    source = '',
    filePath,
    value,
    onValueChange,
    onSave,
    onDelete,
    onClose,
    title = '配置 Subscription Key',
    deleteDisabledTitle = '当前 key 由外部源管理，无法在界面删除',
  } = props;

  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const external = source === 'env' || source === 'file';
  const canDelete = configured && !external;

  const statusText = configured
    ? `已保存 (${masked ?? '***'})${source === 'env' ? ' · env' : ''}${
        source === 'file' ? ` · file: ${filePath ?? ''}` : ''
      }`
    : '未配置';

  const placeholder = external
    ? source === 'env'
      ? 'env 优先，此处的值在 env 取消前不会被使用'
      : 'file 优先，此处的值在文件移除前不会被使用'
    : 'sk-cp-...';

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="apikey-modal">
      <div className="apikey-modal-backdrop" onClick={onClose} />
      <div
        className="apikey-modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="apikey-modal-title"
      >
        <div className="apikey-modal-header">
          <span className="apikey-modal-title" id="apikey-modal-title">{title}</span>
          <button type="button" className="apikey-modal-close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="apikey-modal-body">
          <div className={configured ? 'apikey-status configured' : 'apikey-status not-configured'}>
            {statusText}
          </div>
          <label className="apikey-label" htmlFor="apikey-modal-input">Subscription Key</label>
          <input
            ref={inputRef}
            id="apikey-modal-input"
            type="text"
            className="apikey-input secret-input"
            value={value}
            placeholder={placeholder}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => onValueChange(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="apikey-help">
            从 platform.minimaxi.com/user-center/token-plan 获取，明文存到 settings.json
          </div>
        </div>

        <div className="apikey-actions">
          <button
            type="button"
            className="apikey-btn apikey-btn-danger"
            hidden={!canDelete}
            title={external ? deleteDisabledTitle : undefined}
            onClick={onDelete}
          >
            删除
          </button>
          <button type="button" className="apikey-btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="apikey-btn apikey-btn-primary" onClick={onSave}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
