/**
 * BrowserPanel.tsx —— 内置浏览器面板（参考 dsh-sidebar 的 sidebar browser）
 * ============================================================================
 * URL 栏 + iframe。工作区 html 文件经 /api/fs/raw 以 text/html 原样返回，
 * iframe 沙箱内直接渲染（无 allow-same-origin → 沙箱页拿不到本站会话凭据）。
 * 哑组件：url 受控，导航/刷新经回调与重挂载键实现。
 * ============================================================================
 */

import { memo, useEffect, useState } from 'react';
import { Icon } from '../primitives/Icon';
import { IconButton } from '../primitives/IconButton';
import './browser.css';

export interface BrowserPanelProps {
  /** 当前 URL（null = 空态）。 */
  url: string | null;
  onNavigate: (url: string) => void;
  onClose?: () => void;
  /** 外部变化强制 iframe 重载（容器自增）。 */
  reloadKey?: number;
  placeholder?: string;
  closeLabel?: string;
  reloadLabel?: string;
  goLabel?: string;
  systemLabel?: string;
}

/** 输入归一：空串忽略；本地路径（/ 开头或 ~）转 raw URL；其余原样当 URL。 */
function normalizeInput(raw: string, toRaw: (p: string) => string): string {
  const t = raw.trim();
  if (t === '') return '';
  if (/^https?:\/\//i.test(t)) return t;
  return toRaw(t);
}

export const BrowserPanel = memo(function BrowserPanel({
  url,
  onNavigate,
  onClose,
  reloadKey = 0,
  placeholder = '输入 URL 或文件路径…',
  closeLabel = '关闭',
  reloadLabel = '重新加载',
  goLabel = '转到',
  systemLabel = '在系统浏览器打开',
}: BrowserPanelProps) {
  const [draft, setDraft] = useState(url ?? '');
  useEffect(() => {
    setDraft(url ?? '');
  }, [url]);

  return (
    <section className="bpanel" aria-label="内置浏览器">
      <header className="bpanel-head">
        <Icon name="globe" size={13} className="bpanel-head-icon" />
        <span className="bpanel-head-title">浏览器</span>
        <div className="bpanel-head-actions">
          <IconButton icon="external" label={systemLabel} onClick={() => url && window.open(url, '_blank')} />
          {onClose ? <IconButton icon="x" label={closeLabel} onClick={onClose} /> : null}
        </div>
      </header>
      <div className="bpanel-urlrow">
        <input
          type="text"
          className="bpanel-url"
          value={draft}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const next = normalizeInput(draft, (p) => '/api/fs/raw?path=' + encodeURIComponent(p));
              if (next !== '') onNavigate(next);
            }
          }}
        />
        <IconButton
          icon="refresh"
          label={goLabel}
          onClick={() => {
            const next = normalizeInput(draft, (p) => '/api/fs/raw?path=' + encodeURIComponent(p));
            if (next !== '') onNavigate(next);
          }}
        />
        <IconButton icon="refresh" label={reloadLabel} onClick={() => url && onNavigate(url)} />
      </div>
      <div className="bpanel-body">
        {url ? (
          <iframe
            key={url + '#' + String(reloadKey)}
            className="bpanel-frame"
            src={url}
            title="内置浏览器"
            sandbox="allow-scripts allow-forms allow-modals allow-popups"
          />
        ) : (
          <div className="bpanel-empty">{'\u5728\u6587\u4ef6\u6811\u53f3\u952e html \u6587\u4ef6\u9009\u62e9\u6253\u5f00\uff0c\u6216\u8f93\u5165 URL'}</div>
        )}
      </div>
    </section>
  );
});
