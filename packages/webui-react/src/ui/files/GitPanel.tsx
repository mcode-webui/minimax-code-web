/**
 * GitPanel.tsx —— 右栏 Git 面板（变更 / 分支 / diff 预览）
 * ============================================================================
 * 哑组件 + 注入式 IO（loader 由容器注入，生产=reg.workspace.git*）。
 *   - 头部：分支下拉（切换经 onCheckout）+ 刷新。
 *   - 变更列表：porcelain XY 徽标（M/A/D/R/U）+ 相对路径；单击加载 diff。
 *   - diff：逐行着色的只读视图（+绿 / -红 / @@定位）。
 * ============================================================================
 */

import { memo, useCallback, useEffect, useState } from 'react';
import type { GitBranch, GitFileChange, GitStatus } from '../../contracts/domain';
import { Icon } from '../primitives/Icon';
import { IconButton } from '../primitives/IconButton';
import './git.css';

export interface GitPanelProps {
  /** 仓库目录（当前工作区）；空串 = 未选工作区。 */
  dir: string;
  onLoadStatus: (dir: string) => Promise<GitStatus>;
  onLoadBranches: (dir: string) => Promise<{ ok: boolean; branches: GitBranch[]; error?: string }>;
  onCheckout: (dir: string, branch: string) => Promise<{ ok: boolean; error?: string }>;
  onLoadDiff: (dir: string, file: string) => Promise<{ ok: boolean; diff: string; error?: string }>;
  /** checkout 成功后回调（容器刷新状态）。 */
  onNotify?: (msg: string, kind: 'success' | 'error') => void;
  title?: string;
  notRepoText?: string;
  emptyText?: string;
}

/** porcelain XY → 单字母徽标语义。 */
function changeBadge(f: GitFileChange): { label: string; kind: string; title: string } {
  if (f.x === '?' && f.y === '?') return { label: 'U', kind: 'untracked', title: '未跟踪' };
  if (f.x === 'R' || f.y === 'R') return { label: 'R', kind: 'renamed', title: '重命名' };
  const s = (f.staged ? f.x : f.y).toUpperCase();
  if (s === 'A') return { label: 'A', kind: 'added', title: '新增' };
  if (s === 'D') return { label: 'D', kind: 'deleted', title: '删除' };
  return { label: 'M', kind: 'modified', title: '修改' };
}

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  return (
    <pre className="git-diff">
      {lines.map((line, i) => {
        let cls = 'git-diff-line';
        if (line.startsWith('+++') || line.startsWith('---')) cls += ' git-diff-file';
        else if (line.startsWith('@@')) cls += ' git-diff-hunk';
        else if (line.startsWith('+')) cls += ' git-diff-add';
        else if (line.startsWith('-')) cls += ' git-diff-del';
        return (
          <span key={String(i)} className={cls}>
            {line}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}

export const GitPanel = memo(function GitPanel({
  dir,
  onLoadStatus,
  onLoadBranches,
  onCheckout,
  onLoadDiff,
  onNotify,
  title = 'GIT',
  notRepoText = '当前工作区不是 git 仓库',
  emptyText = '工作区无变更',
}: GitPanelProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [diffFile, setDiffFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    if (!dir) return;
    setBusy(true);
    void Promise.all([onLoadStatus(dir), onLoadBranches(dir)])
      .then(([st, br]) => {
        setStatus(st);
        setBranches(br.ok ? br.branches : []);
      })
      .finally(() => setBusy(false));
  }, [dir, onLoadStatus, onLoadBranches]);

  useEffect(() => {
    setStatus(null);
    setBranches([]);
    setDiffFile(null);
    setDiff(null);
    refresh();
  }, [dir, refresh]);

  const loadDiff = useCallback(
    (file: string) => {
      setDiffFile(file);
      setDiff(null);
      onLoadDiff(dir, file)
        .then((res) => setDiff(res.ok ? res.diff : (res.error ?? 'diff 失败')))
        .catch(() => setDiff('diff 失败'));
    },
    [dir, onLoadDiff],
  );

  const handleCheckout = (branch: string): void => {
    void onCheckout(dir, branch).then((res) => {
      if (onNotify) onNotify(res.ok ? '已切换到 ' + branch : (res.error ?? '切换失败'), res.ok ? 'success' : 'error');
      if (res.ok) refresh();
    });
  };

  const current = branches.find((b) => b.current)?.name ?? status?.branch ?? '';

  return (
    <section className="gpanel" aria-label={title}>
      <header className="gpanel-head">
        <Icon name="git-branch" size={14} className="gpanel-head-icon" />
        <span className="gpanel-head-title">{title}</span>
        {branches.length > 0 ? (
          <select
            className="gpanel-branch"
            value={current}
            onChange={(e) => handleCheckout(e.target.value)}
            aria-label="切换分支"
          >
            {branches.map((b) => (
              <option key={b.name} value={b.name}>
                {b.current ? '● ' : ''}
                {b.name}
              </option>
            ))}
          </select>
        ) : null}
        <div className="gpanel-head-actions">
          <IconButton icon="refresh" label="刷新" onClick={refresh} disabled={busy} />
        </div>
      </header>

      <div className="gpanel-body">
        {!dir ? (
          <div className="gpanel-empty">未选择工作区</div>
        ) : status !== null && status.isRepo === false ? (
          <div className="gpanel-empty">{notRepoText}</div>
        ) : status === null ? (
          <div className="gpanel-empty">加载中…</div>
        ) : status.ok && status.files.length === 0 ? (
          <div className="gpanel-empty">{emptyText}</div>
        ) : status.ok ? (
          <>
            {status.upstream && (status.ahead || status.behind) ? (
              <div className="gpanel-sync">
                ↑{status.ahead} ↓{status.behind}
              </div>
            ) : null}
            <div className="gpanel-files">
              {status.files.map((f) => {
                const badge = changeBadge(f);
                const selected = diffFile === f.path;
                return (
                  <button
                    key={f.path + f.x + f.y}
                    type="button"
                    className={selected ? 'gpanel-file gpanel-file--active' : 'gpanel-file'}
                    title={f.path}
                    onClick={() => loadDiff(f.path)}
                  >
                    <span className={'gpanel-badge gpanel-badge--' + badge.kind} title={badge.title}>
                      {badge.label}
                    </span>
                    <span className="gpanel-file-name">{f.path}</span>
                  </button>
                );
              })}
            </div>
            {diffFile !== null ? (
              <div className="gpanel-diffwrap">
                <div className="gpanel-diffname">{diffFile}</div>
                {diff !== null && diff.trim() !== '' ? (
                  <DiffView diff={diff} />
                ) : (
                  <div className="gpanel-empty">无 diff 内容</div>
                )}
              </div>
            ) : null}
          </>
        ) : (
          <div className="gpanel-empty gpanel-empty--error">{status.error ?? '读取失败'}</div>
        )}
      </div>
    </section>
  );
});
