/** panels-feature —— 右栏容器（v3 Tab 化）：单栏 + Tab 页（文件/预览/浏览器/Git/详情），全部挂载按显示隐藏（保留各自状态），左缘拖拽调宽（接缝：SessionSlice/registry.workspace → FileTree/DocPreview/Browser/Git/RightPanel props）。 */
import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

import { BrowserPanel } from '../ui/files/BrowserPanel';
import { DocPreviewPanel } from '../ui/files/DocPreviewPanel';
import { FileTreePanel } from '../ui/files/FileTreePanel';
import { GitPanel } from '../ui/files/GitPanel';
import { ResizeHandle } from '../ui/primitives/ResizeHandle';
import { RightPanel } from '../ui/layout/RightPanel';
import type { AppController } from './app-controller';
import type { GoalState } from '../contracts/domain';
import { useRegistry } from './registry-context';
import { useAppActions, useAppSnapshot } from './use-app';

export interface PanelsFeatureProps {
  controller: AppController;
}

/** 已运行时长 → "3m12s" / "1h5m"（纯展示格式化）。 */
function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const total = Math.floor(ms / 1000);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  if (mm >= 60) return `${Math.floor(mm / 60)}h${mm % 60}m`;
  return mm > 0 ? `${mm}m${ss}s` : `${ss}s`;
}

/** 工作区路径末段（面包屑项目名）。 */
function projectLabel(dir: string | null | undefined): string | undefined {
  if (!dir) return undefined;
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : dir;
}

export function PanelsFeature({ controller }: PanelsFeatureProps) {
  const s = useAppSnapshot(controller);
  const a = useAppActions(controller);
  const reg = useRegistry();

  // 文档预览当前文件；内置浏览器当前 URL（切工作区清空，文件树重新自动选中 README）。
  const [docPath, setDocPath] = useState<string | null>(null);
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const wsDir = s.slice?.workspace?.dir ?? s.workspace?.dir ?? '';
  useEffect(() => {
    setDocPath(null);
    setBrowserUrl(null);
  }, [wsDir]);

  const selection = s.slice?.selection;
  const contextLimit = selection
    ? (s.models.find((m) => m.id === selection.model)?.contextLimit ?? null)
    : null;
  const goal: GoalState | null = s.slice?.goal ?? null;

  const readFile = useCallback((p: string) => reg.workspace.readFile(p), [reg]);
  const listDir = useCallback((p: string) => reg.workspace.listDir(p), [reg]);
  const gitStatus = useCallback((d: string) => reg.workspace.gitStatus(d), [reg]);
  const gitBranches = useCallback((d: string) => reg.workspace.gitBranches(d), [reg]);
  const gitDiff = useCallback((d: string, f2: string) => reg.workspace.gitDiff(d, f2), [reg]);
  const gitCheckout = useCallback(
    (d: string, branch: string) => reg.workspace.gitCheckout(d, branch),
    [reg],
  );

  /** 文件树选中分发：html → 内置浏览器 Tab；其余 → 文档预览 Tab。 */
  const openFile = (path: string): void => {
    if (/\.\.html?$/i.test(path)) {
      setBrowserUrl(reg.workspace.rawFileUrl(path));
      a.setRightTab('browser');
      return;
    }
    setDocPath(path);
    a.setRightTab('preview');
  };

  return (
    <div
      className={s.rightOpen ? 'right-side right-side--open' : 'right-side'}
      style={{
        '--right-w': s.rightWidth + 'px',
        display: s.rightTab ? undefined : 'none',
      } as CSSProperties}
    >
      <ResizeHandle
        width={s.rightWidth}
        minWidth={280}
        maxWidth={800}
        side="left"
        onWidthChange={(w) => a.setPanelWidth('right', w)}
        onReset={() => a.setPanelWidth('right', 420)}
      />
      {/* 全部挂载、按 Tab 显示隐藏 —— 保留文件树展开/浏览器页面/Git 数据等状态 */}
      <div className="right-pane" style={{ display: s.rightTab === 'files' ? 'flex' : 'none' }}>
        <FileTreePanel
          root={wsDir}
          loader={listDir}
          selectedPath={docPath}
          onSelectFile={openFile}
          menu={{
            onCopyPath: (p) => {
              const clipboard = navigator.clipboard?.writeText(p);
              if (clipboard) void clipboard.then(() => reg.notifier.toast('已复制路径', 'success'), () => reg.notifier.toast('复制失败', 'error'));
              else reg.notifier.toast('当前环境不支持复制', 'warn');
            },
            onOpenSystem: (p, isDir) => {
              void reg.workspace.openInSystem(p, isDir ? 'folder' : 'file').then(
                (res) => { if (!res.ok) reg.notifier.toast(res.error ?? '打开失败', 'error'); },
              );
            },
            onOpenFolder: (p) => {
              void reg.workspace.openInSystem(p, 'folder').then(
                (res) => { if (!res.ok) reg.notifier.toast(res.error ?? '打开失败', 'error'); },
              );
            },
            onOpenBrowser: (p) => {
              setBrowserUrl(reg.workspace.rawFileUrl(p));
              a.setRightTab('browser');
            },
            onPreview: (p) => {
              setDocPath(p);
              a.setRightTab('preview');
            },
          }}
        />
      </div>
      <div className="right-pane" style={{ display: s.rightTab === 'preview' ? 'flex' : 'none' }}>
        <DocPreviewPanel
          path={docPath}
          loader={readFile}
          projectName={projectLabel(s.workspace?.dir)}
          onClose={() => {
            setDocPath(null);
            a.setRightTab('files');
          }}
        />
      </div>
      <div className="right-pane" style={{ display: s.rightTab === 'browser' ? 'flex' : 'none' }}>
        <BrowserPanel
          url={browserUrl}
          reloadKey={reloadKey}
          onNavigate={(u) => {
            setBrowserUrl(u);
            setReloadKey((k) => k + 1);
          }}
          onClose={() => a.setRightTab('files')}
        />
      </div>
      <div className="right-pane" style={{ display: s.rightTab === 'git' ? 'flex' : 'none' }}>
        <GitPanel
          dir={wsDir}
          onLoadStatus={gitStatus}
          onLoadBranches={gitBranches}
          onCheckout={gitCheckout}
          onLoadDiff={gitDiff}
          onNotify={(msg, kind) => reg.notifier.toast(msg, kind)}
        />
      </div>
      <div className="right-pane" style={{ display: s.rightTab === 'details' ? 'flex' : 'none' }}>
        <div className="right-details">
          <RightPanel
            todos={s.slice?.todos ?? []}
            goal={goal}
            goalDuration={goal?.startedAt ? formatElapsed(Date.now() - goal.startedAt) : ''}
            sessionId={s.activeSessionId ?? ''}
            sessionTitle={s.slice?.summary?.title ?? ''}
            selection={selection ?? undefined}
            contextLimit={contextLimit}
            workspace={s.slice?.workspace ?? s.workspace}
            context={s.context ?? s.slice?.context ?? null}
          />
        </div>
      </div>
    </div>
  );
}
