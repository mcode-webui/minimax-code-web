/**
 * FileTreePanel.tsx —— 右栏文件树（参考布局最右列）
 * ============================================================================
 * 哑组件 + 注入式 IO：loader 由容器注入（生产传 reg.workspace.listDir，测试传
 * 假函数），组件自身不 import 任何服务 —— 保持 ui 层零服务依赖。
 *   - 懒加载：首帧载根目录；展开子目录时再取该层。
 *   - 搜索：按关键字过滤「已加载」的条目（简单过滤，不做全量索引）。
 *   - 自动选中：根目录就绪后若存在 autoSelectNames（默认 README.md）则上抛。
 * ============================================================================
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { FsEntry, FsListResult } from '../../contracts/domain';
import { Icon } from '../primitives/Icon';
import './filetree.css';

export interface FileTreePanelProps {
  /** 根目录绝对路径（当前工作区）；空串 = 未选工作区（显示空态）。 */
  root: string;
  /** 根目录显示名（默认取路径末段）。 */
  rootLabel?: string;
  /** 当前选中文件路径（受控）。 */
  selectedPath?: string | null;
  onSelectFile?: (path: string) => void;
  /** 目录加载器（IO 接缝）。 */
  loader: (path: string) => Promise<FsListResult>;
  title?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /** 根目录就绪后自动选中的文件名（默认 README.md）。 */
  autoSelectNames?: readonly string[];
  /** 右键菜单动作（容器实现 IO：剪贴板/系统打开/浏览器/预览）。 */
  menu?: FileTreeMenuHandlers;
}

/** 右键菜单动作集合（全部由容器实现，组件只分发）。 */
export interface FileTreeMenuHandlers {
  /** 复制完整路径。 */
  onCopyPath: (path: string) => void;
  /** 在系统中打开（文件=默认应用；目录=文件管理器）。 */
  onOpenSystem: (path: string, isDir: boolean) => void;
  /** 在文件管理器中打开（文件=所在目录）。 */
  onOpenFolder: (path: string) => void;
  /** 在内置浏览器打开（html 等）。 */
  onOpenBrowser: (path: string) => void;
  /** 在文档预览打开（md/txt 等）。 */
  onPreview: (path: string) => void;
}

interface MenuState {
  x: number;
  y: number;
  entry: FsEntry;
}

/** 默认目录展开表：根目录路径 => true。 */
type ExpandedMap = Record<string, boolean>;

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

export const FileTreePanel = memo(function FileTreePanel({
  root,
  rootLabel,
  selectedPath,
  onSelectFile,
  loader,
  title = '\u6587\u4ef6',
  searchPlaceholder = '\u641c\u7d22',
  emptyText = '\u672a\u9009\u62e9\u5de5\u4f5c\u533a',
  autoSelectNames = ['README.md'],
  menu,
}: FileTreePanelProps) {
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ExpandedMap>({});
  const [childrenMap, setChildrenMap] = useState<Record<string, FsEntry[]>>({});
  const [query, setQuery] = useState('');
  const autoTriedRef = useRef(false);
  /** 右键菜单状态（坐标 + 目标条目）。 */
  const [menuState, setMenuState] = useState<MenuState | null>(null);

  const openMenu = (e: ReactMouseEvent<HTMLButtonElement>, entry: FsEntry): void => {
    e.preventDefault();
    setMenuState({ x: e.clientX, y: e.clientY, entry });
  };
  const closeMenu = (): void => setMenuState(null);

  // 根目录加载（root 变更重置一切）。
  useEffect(() => {
    let alive = true;
    setEntries([]);
    setChildrenMap({});
    setExpanded({});
    setError(null);
    setQuery('');
    autoTriedRef.current = false;
    if (!root) return () => undefined;
    loader(root)
      .then((res) => {
        if (!alive) return;
        if (res.ok) setEntries(res.entries);
        else setError(res.error ?? 'read failed');
      })
      .catch(() => {
        if (alive) setError('read failed');
      });
    return () => {
      alive = false;
    };
  }, [root, loader]);

  // 自动选中根目录下的 README（仅一次）。
  useEffect(() => {
    if (autoTriedRef.current || entries.length === 0) return;
    autoTriedRef.current = true;
    for (const name of autoSelectNames) {
      const hit = entries.find((e) => !e.isDir && e.name === name);
      if (hit) {
        onSelectFile?.(hit.path);
        break;
      }
    }
  }, [entries, autoSelectNames, onSelectFile]);

  /** 展开/折叠目录；首展开时懒加载子层。 */
  const toggleDir = useCallback(
    (dir: FsEntry) => {
      const isOpen = expanded[dir.path] === true;
      setExpanded((prev) => ({ ...prev, [dir.path]: !isOpen }));
      if (isOpen || childrenMap[dir.path] !== undefined) return;
      setChildrenMap((prev) => ({ ...prev, [dir.path]: [] }));
      loader(dir.path)
        .then((res) => {
          setChildrenMap((prev) => ({ ...prev, [dir.path]: res.ok ? res.entries : [] }));
        })
        .catch(() => {
          setChildrenMap((prev) => ({ ...prev, [dir.path]: [] }));
        });
    },
    [expanded, childrenMap, loader],
  );

  /** 扁平渲染行：按深度内联展开（搜索时全库过滤已加载条目）。 */
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    type Row = { entry: FsEntry; depth: number };
    const out: Row[] = [];
    const walk = (list: FsEntry[], depth: number) => {
      for (const e of list) {
        if (q !== '' && !e.path.toLowerCase().includes(q)) {
          // 过滤模式：目录仍下钻（其子条目可能命中）
          if (e.isDir && childrenMap[e.path] !== undefined && expanded[e.path]) {
            walk(childrenMap[e.path], depth + 1);
          }
          continue;
        }
        out.push({ entry: e, depth });
        if (e.isDir && expanded[e.path] && childrenMap[e.path] !== undefined) {
          walk(childrenMap[e.path], depth + 1);
        }
      }
    };
    walk(entries, 0);
    return out;
  }, [entries, expanded, childrenMap, query]);

  const label = rootLabel ?? (root ? baseName(root) : '');

  return (
    <section className="ftree" aria-label={title}>
      <header className="ftree-head">
        <Icon name="folder" size={13} className="ftree-head-icon" />
        <span className="ftree-head-title">{title}</span>
        {label ? <span className="ftree-head-root" title={root}>{label}</span> : null}
      </header>
      <div className="ftree-search">
        <Icon name="search" size={12} className="ftree-search-icon" />
        <input
          className="ftree-search-input"
          type="text"
          placeholder={searchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
        />
      </div>
      <div className="ftree-body">
        {!root ? (
          <div className="ftree-empty">{emptyText}</div>
        ) : error !== null ? (
          <div className="ftree-empty">{error}</div>
        ) : rows.length === 0 ? (
          <div className="ftree-empty">{'\u2014'}</div>
        ) : (
          rows.map(({ entry, depth }) => {
            const isOpen = expanded[entry.path] === true;
            const isSelected = !entry.isDir && entry.path === selectedPath;
            return (
              <button
                key={entry.path}
                type="button"
                className={
                  'ftree-row' +
                  (entry.isDir ? ' ftree-row--dir' : '') +
                  (isSelected ? ' ftree-row--active' : '')
                }
                style={{ paddingLeft: 8 + depth * 14 }}
                title={entry.path}
                onClick={() => (entry.isDir ? toggleDir(entry) : onSelectFile?.(entry.path))}
                onContextMenu={(ev: ReactMouseEvent<HTMLButtonElement>) => openMenu(ev, entry)}
              >
                {entry.isDir ? (
                  <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={11} className="ftree-chevron" />
                ) : (
                  <span className="ftree-chevron" aria-hidden="true" />
                )}
                <Icon name={entry.isDir ? 'folder' : 'file'} size={13} className="ftree-row-icon" />
                <span className="ftree-row-name">{entry.name}</span>
              </button>
            );
          })
        )}
      </div>
    
      {/* 右键菜单：fixed 定位 + 全屏透明层收起 */}
      {menuState !== null && menu ? (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 60 }}
            onClick={closeMenu}
            onContextMenu={(e) => {
              e.preventDefault();
              closeMenu();
            }}
            aria-hidden="true"
          />
          <div className="ftree-menu" role="menu" style={{ left: menuState.x, top: menuState.y, zIndex: 61 }}>
            {menuState.entry.isDir ? null : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="ftree-menu-item"
                  onClick={() => {
                    closeMenu();
                    menu.onPreview(menuState.entry.path);
                  }}
                >
                  <Icon name="eye" size={13} /> 在文档预览打开
                </button>
                {/\.html?$/i.test(menuState.entry.name) ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="ftree-menu-item"
                    onClick={() => {
                      closeMenu();
                      menu.onOpenBrowser(menuState.entry.path);
                    }}
                  >
                    <Icon name="globe" size={13} /> 在内置浏览器打开
                  </button>
                ) : null}
              </>
            )}
            <button
              type="button"
              role="menuitem"
              className="ftree-menu-item"
              onClick={() => {
                closeMenu();
                menu.onCopyPath(menuState.entry.path);
              }}
            >
              <Icon name="copy" size={13} /> 复制路径
            </button>
            <button
              type="button"
              role="menuitem"
              className="ftree-menu-item"
              onClick={() => {
                closeMenu();
                menu.onOpenSystem(menuState.entry.path, menuState.entry.isDir);
              }}
            >
              <Icon name="external" size={13} /> 在系统中打开
            </button>
            <button
              type="button"
              role="menuitem"
              className="ftree-menu-item"
              onClick={() => {
                closeMenu();
                menu.onOpenFolder(menuState.entry.path);
              }}
            >
              <Icon name="folder" size={13} /> 在文件管理器中打开
            </button>
          </div>
        </>
      ) : null}
</section>
  );
});
