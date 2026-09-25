/**
 * ui/composer/WorkspacePicker.tsx —— 切换工作区 / 选择目录弹层（哑组件）
 * ============================================================================
 * 两种形态：
 *   1) recents（默认）：标题「切换工作区」+ 搜索 + 最近工作区列表（当前项打勾）
 *      + 底部「选择目录」「无需工作空间」。
 *   2) browseMode（选择目录，对齐原生目录选择器参考布局）：
 *      工具栏[主目录|上一级|新建文件夹|路径输入|取消|确定|选择当前目录]
 *      + glob 过滤行 + 名称/大小/修改时间/权限 表格；行单击高亮、双击进目录、
 *      「确定」选高亮目录、「选择当前目录」选当前路径。
 * 对齐 vanilla .workspace-picker / .ws-picker-* 样式。
 * ============================================================================
 */
import './wspicker.css';

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { memo, useEffect, useMemo, useState } from 'react';

import type { WorkspaceEntry } from '../../contracts/domain';
import { Icon } from '../primitives/Icon';

/**
 * 最近工作区条目（WorkspaceEntry + 会话数角标）。
 * 浏览模式下同构复用：recents 槽位装的是 /api/fs/read 条目，
 * 因此附带 size / mtime / mode 可选字段（表格列显示用）。
 */
export interface WorkspaceRecent extends WorkspaceEntry {
  sessionCount?: number;
  size?: number;
  mtime?: number;
  mode?: string;
}

export interface WorkspacePickerProps {
  open: boolean;
  /** 最近工作区列表（recents 模式）或浏览模式的当前目录条目（搜索/过滤在组件内）。 */
  recents: WorkspaceRecent[];
  /** 当前工作区路径；null / '' 表示无工作区。 */
  currentPath: string | null;
  /** 选定某个路径（recents 行单击 / 搜索回车）。 */
  onSelect: (path: string) => void;
  /** 「选择目录」/「确定」/「选择当前目录」。path 缺省 = 浏览模式选当前目录。 */
  onPickDirectory: (path?: string) => void;
  /** 「无需工作空间」。 */
  onNoWorkspace: () => void;
  /** Esc / 取消 关闭。 */
  onClose: () => void;
  title?: string;
  loading?: boolean;
  /** 浏览模式（选择目录）：启用工具栏 + 表格形态。 */
  browseMode?: boolean;
  /** 浏览模式当前目录绝对路径。 */
  cwd?: string;
  /** 浏览模式上一级目录；null = 已在顶层（隐藏「上一级」）。 */
  parentPath?: string | null;
  /** 导航到某目录（主目录/上一级/双击/路径输入回车）。 */
  onNavigateTo?: (path: string) => void;
  /** 新建文件夹（当前目录下）。 */
  onCreateFolder?: () => void;
}

/** 纯过滤函数：按 name / path 匹配搜索词（recents 模式）。 */
export function filterRecents(recents: WorkspaceRecent[], query: string): WorkspaceRecent[] {
  const q = query.trim().toLowerCase();
  if (!q) return recents;
  return recents.filter(
    (r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q),
  );
}

/** glob → RegExp（仅支持 * 与 ?；大小写不敏感）。非法 glob 回落子串匹配。 */
function globToRegExp(g: string): RegExp | null {
  try {
    const esc = g
      .trim()
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp('^' + esc + '$', 'i');
  } catch {
    return null;
  }
}

/** 字节数 → 人类可读；目录 / 未知 → '-'。 */
function humanSize(n: number | undefined): string {
  if (n === undefined || n === null) return '-';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
}

/** 权限八进制串（如 755）→ rwxr-xr-x；不符合格式时原样返回。 */
function formatMode(mode: string | undefined): string {
  if (!mode) return '-';
  const digits = mode.length === 4 ? mode.slice(1) : mode;
  if (!/^[0-7]{3}$/.test(digits)) return mode;
  const bits = ['r', 'w', 'x'];
  return digits
    .split('')
    .map((d) => {
      const n = parseInt(d, 10);
      return bits.map((b, i) => (n & (4 >> i) ? b : '-')).join('');
    })
    .join('');
}

/** 毫秒 → YYYY-MM-DD HH:mm（本地时区）。 */
function formatMtime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '-';
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  );
}

export const WorkspacePicker = memo(function WorkspacePicker(props: WorkspacePickerProps) {
  const {
    open,
    recents,
    currentPath,
    onSelect,
    onPickDirectory,
    onNoWorkspace,
    onClose,
    title = '切换工作区',
    loading = false,
    browseMode = false,
    cwd = '',
    parentPath = null,
    onNavigateTo,
    onCreateFolder,
  } = props;

  const [query, setQuery] = useState('');
  const [filterText, setFilterText] = useState('');
  /** 高亮行（浏览模式）：确定按钮只对目录可用。 */
  const [hilite, setHilite] = useState<string | null>(null);
  /** 路径输入框草稿（可编辑，回车导航）。 */
  const [pathDraft, setPathDraft] = useState(cwd);

  // 条目集变化（进入目录/刷新）后重置高亮，并把路径草稿同步为当前目录。
  useEffect(() => {
    setHilite(null);
  }, [recents]);
  useEffect(() => {
    setPathDraft(cwd);
  }, [cwd]);

  const filtered = useMemo(() => filterRecents(recents, query), [recents, query]);

  /** 浏览模式过滤：glob 优先，退化为子串；目录优先排序。 */
  const browseRows = useMemo(() => {
    const q = filterText.trim();
    const re = q !== '' ? globToRegExp(q) : null;
    const list = recents.filter((e) => {
      if (q === '') return true;
      if (re !== null) return re.test(e.name) || re.test(e.path);
      return e.name.toLowerCase().includes(q.toLowerCase());
    });
    return [...list].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [recents, filterText]);

  /** 高亮在可见行里的下标（↑↓ 移动用）。 */
  const visiblePaths = browseMode ? browseRows.map((e) => e.path) : filtered.map((e) => e.path);

  const moveHilite = (delta: number): void => {
    if (visiblePaths.length === 0) return;
    const idx = hilite !== null ? visiblePaths.indexOf(hilite) : -1;
    const next = idx < 0 ? 0 : Math.min(visiblePaths.length - 1, Math.max(0, idx + delta));
    setHilite(visiblePaths[next] ?? null);
  };

  const handleSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const first = filtered[0];
      if (first) onSelect(first.path);
    }
  };

  const handlePathKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const p = pathDraft.trim();
      if (p !== '') onNavigateTo?.(p);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveHilite(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveHilite(-1);
    }
  };

  const handleFilterKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveHilite(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveHilite(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (hilite !== null) onPickDirectory(hilite);
    }
  };

  if (!open) return null;

  /** 高亮条目（浏览模式）。 */
  const hiliteEntry = browseMode ? (browseRows.find((e) => e.path === hilite) ?? null) : null;
  /** 确定按钮：高亮为目录才可用。 */
  const confirmEnabled = hiliteEntry !== null && hiliteEntry.isDir;

  if (browseMode) {
    return (
      <>
      {/* 遮罩：fixed 定位不受 .chat-area overflow:hidden 裁剪，全屏可点关闭 */}
      <div className="wspicker-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="wspicker wspicker--browse" role="dialog" aria-modal="true" aria-label={title}>
        <div className="wspicker-toolbar">
          <button type="button" className="wspicker-toolbtn" title="主目录" aria-label="主目录" onClick={() => onNavigateTo?.('~')}>
            <Icon name="home" size={16} />
          </button>
          <button
            type="button"
            className="wspicker-toolbtn"
            title="上一级"
            aria-label="上一级"
            disabled={!parentPath}
            onClick={() => parentPath && onNavigateTo?.(parentPath)}
          >
            <Icon name="arrow-up" size={16} />
          </button>
          <button
            type="button"
            className="wspicker-toolbtn"
            title="新建文件夹"
            aria-label="新建文件夹"
            disabled={!onCreateFolder}
            onClick={() => onCreateFolder?.()}
          >
            <Icon name="folder-plus" size={16} />
          </button>
          <input
            type="text"
            className="wspicker-pathinput"
            value={pathDraft}
            onChange={(e) => setPathDraft(e.target.value)}
            onKeyDown={handlePathKeyDown}
            autoComplete="off"
            spellCheck={false}
            aria-label="当前路径"
          />
          <button type="button" className="wspicker-navbtn" onClick={onClose}>取消</button>
          <button
            type="button"
            className="wspicker-navbtn"
            disabled={!confirmEnabled}
            title={confirmEnabled ? '选定高亮目录' : '先在列表中选择一个目录'}
            onClick={() => hilite !== null && onPickDirectory(hilite)}
          >
            确定
          </button>
          <button type="button" className="wspicker-navbtn primary" onClick={() => onPickDirectory()}>
            选择当前目录
          </button>
        </div>

        <div className="wspicker-filterrow">
          <input
            type="text"
            className="wspicker-filter"
            value={filterText}
            placeholder="过滤…（支持 glob，如 *.txt）"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={handleFilterKeyDown}
          />
        </div>

        <div className="wspicker-table" role="listbox" aria-label="目录内容">
          <div className="wspicker-tr wspicker-thead">
            <span className="wspicker-td-name">名称</span>
            <span className="wspicker-td-size">大小</span>
            <span className="wspicker-td-mtime">修改时间</span>
            <span className="wspicker-td-mode">权限</span>
          </div>
          {loading ? <div className="wspicker-recent-loading">加载中...</div> : null}
          {!loading && browseRows.length === 0 ? (
            <div className="wspicker-recent-empty">此目录为空</div>
          ) : null}
          {browseRows.map((e) => {
            const active = hilite === e.path;
            return (
              <button
                key={e.path}
                type="button"
                role="option"
                aria-selected={active}
                className={active ? 'wspicker-tr wspicker-row hilite' : 'wspicker-tr wspicker-row'}
                title={e.path}
                onClick={() => setHilite(e.path)}
                onDoubleClick={() => {
                  if (e.isDir) onNavigateTo?.(e.path);
                }}
              >
                <span className="wspicker-td-name">
                  <Icon name={e.isDir ? 'folder' : 'file'} size={15} className="wspicker-row-icon" />
                  <span className={e.isDir ? 'wspicker-row-name is-dir' : 'wspicker-row-name'}>{e.name}</span>
                </span>
                <span className="wspicker-td-size">{e.isDir ? '-' : humanSize(e.size)}</span>
                <span className="wspicker-td-mtime">{formatMtime(e.mtime)}</span>
                <span className="wspicker-td-mode">{formatMode(e.mode)}</span>
              </button>
            );
          })}
        </div>
      </div>
      </>
    );
  }

  return (
    <div className="wspicker" role="dialog" aria-label={title}>
      <div className="wspicker-title">{title}</div>

      <div className="wspicker-search-wrap">
        <Icon name="search" size={14} className="wspicker-search-icon" />
        <input
          type="text"
          className="wspicker-search"
          value={query}
          placeholder="搜索工作区…"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleSearchKeyDown}
        />
      </div>

      <div className="wspicker-recent-list">
        {loading ? <div className="wspicker-recent-loading">加载中...</div> : null}
        {!loading && filtered.length === 0 ? <div className="wspicker-recent-empty">暂无工作区</div> : null}
        {filtered.map((r) => {
          const active = !!currentPath && r.path === currentPath;
          return (
            <button
              key={r.path}
              type="button"
              className={active ? 'wspicker-recent-item active' : 'wspicker-recent-item'}
              onClick={() => onSelect(r.path)}
            >
              <Icon name="folder" size={15} className="wspicker-recent-icon" />
              <span className="wspicker-recent-info">
                <span className="wspicker-recent-name">{r.name}</span>
                <span className="wspicker-recent-path">{r.path}</span>
              </span>
              {typeof r.sessionCount === 'number' ? (
                <span className="wspicker-recent-count">{r.sessionCount}</span>
              ) : null}
              {active ? <span className="wspicker-check" aria-hidden="true">✓</span> : null}
            </button>
          );
        })}
      </div>

      <div className="wspicker-divider" />

      <div className="wspicker-actions-row">
        <button type="button" className="wspicker-action primary" onClick={() => onPickDirectory()}>
          <Icon name="folder" size={14} />
          <span>选择目录</span>
        </button>
        <button type="button" className="wspicker-action" onClick={onNoWorkspace}>
          无需工作空间
        </button>
      </div>
    </div>
  );
});