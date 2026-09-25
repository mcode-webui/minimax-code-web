/**
 * DocPreviewPanel.tsx —— 右栏文档预览（参考布局：README 渲染面板）
 * ============================================================================
 * 哑组件 + 注入式 IO：loader 由容器注入（生产传 reg.workspace.readFile）。
 *   - 头部：文件标签 + 关闭钮；第二行面包屑（项目名 > 文件名）。
 *   - 工具：渲染 / 原文 切换（eye / code）。
 *   - 正文：复用 blocks/markdown 的最小 Markdown 渲染器（与助手消息一致）。
 * ============================================================================
 */

import { memo, useEffect, useState } from 'react';
import type { FsFileResult } from '../../contracts/domain';
import { renderMarkdown } from '../chat/blocks/markdown';
import { Icon } from '../primitives/Icon';
import { IconButton } from '../primitives/IconButton';
import '../chat/blocks/blocks.css';
import './docpreview.css';

export interface DocPreviewPanelProps {
  /** 当前文件绝对路径；null = 空态。 */
  path: string | null;
  /** 文件加载器（IO 接缝）。 */
  loader: (path: string) => Promise<FsFileResult>;
  /** 面包屑第一段（项目名）。 */
  projectName?: string;
  /** 关闭面板。 */
  onClose?: () => void;
  emptyText?: string;
  closeLabel?: string;
  renderLabel?: string;
  rawLabel?: string;
}

function fileName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

export const DocPreviewPanel = memo(function DocPreviewPanel({
  path,
  loader,
  projectName,
  onClose,
  emptyText = '\u5728\u53f3\u4fa7\u6587\u4ef6\u6811\u4e2d\u9009\u62e9\u6587\u4ef6\u9884\u89c8',
  closeLabel = '\u5173\u95ed',
  renderLabel = '\u6e32\u67d3',
  rawLabel = '\u539f\u6587',
}: DocPreviewPanelProps) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    if (!path) {
      setContent(null);
      setError(null);
      return () => undefined;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    loader(path)
      .then((res) => {
        if (!alive) return;
        if (res.ok && res.content !== null) setContent(res.content);
        else {
          setContent(null);
          setError(res.error ?? 'read failed');
        }
      })
      .catch(() => {
        if (alive) {
          setContent(null);
          setError('read failed');
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [path, loader]);

  const name = path ? fileName(path) : '\u9884\u89c8';

  return (
    <section className="docp" aria-label={name}>
      <header className="docp-head">
        <div className="docp-tab">
          <Icon name="file-text" size={12} className="docp-tab-icon" />
          <span className="docp-tab-name">{name}</span>
          {onClose ? <IconButton icon="x" label={closeLabel} size={12} onClick={onClose} /> : null}
        </div>
        <div className="docp-tools">
          <IconButton icon="eye" label={renderLabel} active={!raw} onClick={() => setRaw(false)} />
          <IconButton icon="code" label={rawLabel} active={raw} onClick={() => setRaw(true)} />
        </div>
      </header>
      <div className="docp-crumb">
        {projectName ? (
          <>
            <span className="docp-crumb-proj">{projectName}</span>
            <span className="docp-crumb-sep">{'\u203a'}</span>
          </>
        ) : null}
        <span className="docp-crumb-file" title={path ?? undefined}>{path ?? name}</span>
      </div>
      <div className="docp-body">
        {!path ? (
          <div className="docp-empty">{emptyText}</div>
        ) : loading ? (
          <div className="docp-empty">{'\u2026'}</div>
        ) : error !== null ? (
          <div className="docp-empty docp-empty--error">{error}</div>
        ) : raw ? (
          <pre className="docp-raw">{content}</pre>
        ) : (
          <div className="docp-md">{content !== null ? renderMarkdown(content) : null}</div>
        )}
      </div>
    </section>
  );
});
