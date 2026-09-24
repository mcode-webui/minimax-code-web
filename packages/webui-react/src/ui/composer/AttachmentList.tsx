/**
 * ui/composer/AttachmentList.tsx —— 已上传附件行（哑组件）
 * ============================================================================
 * 视觉职责：附件区的每一行 —— 文件图标、文件名、大小、上传中/失败状态、删除小叉。
 * 对齐 vanilla .attachment-list / .attachment-chip（此处扩展了大小与状态列）。
 * ============================================================================
 */
import './attachmentlist.css';

import type { ReactElement } from 'react';

import type { Attachment } from '../../contracts/domain';

export interface AttachmentListProps {
  attachments: Attachment[];
  /** 删除一行附件。 */
  onRemove: (id: string) => void;
}

/** 字节数 → 人类可读大小（纯展示函数）。 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${i === 0 ? String(n) : n.toFixed(1)} ${units[i]}`;
}

function statusNode(a: Attachment): ReactElement | null {
  if (a.status === 'uploading') {
    return <span className="attachment-status is-uploading">上传中…</span>;
  }
  if (a.status === 'error') {
    return (
      <span className="attachment-status is-error" title={a.error ?? '上传失败'}>
        上传失败
      </span>
    );
  }
  return null;
}

export function AttachmentList({ attachments, onRemove }: AttachmentListProps) {
  if (attachments.length === 0) return null;
  return (
    <div className="attachment-list">
      {attachments.map((a) => (
        <div className="attachment-chip" key={a.id}>
          <span className="attachment-icon" aria-hidden="true">📎</span>
          <span className="attachment-name" title={a.path || a.name}>{a.name}</span>
          <span className="attachment-size">{formatSize(a.size)}</span>
          {statusNode(a)}
          <button
            type="button"
            className="attachment-remove"
            title="移除附件"
            aria-label={`移除附件 ${a.name}`}
            onClick={() => onRemove(a.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
