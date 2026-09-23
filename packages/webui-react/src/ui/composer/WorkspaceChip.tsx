/**
 * ui/composer/WorkspaceChip.tsx —— 工作区 chip + 锚定快速切换下拉（哑组件）
 * ============================================================================
 * 视觉职责：输入框下方那一行的胶囊按钮（文件夹图标 + 名称 + 下拉箭头），
 * 以及点击后向上锚定的快速切换下拉（文件夹列表，当前项打勾 + 底部
 * 「＋ 添加工作区…」）。
 * 对齐 vanilla .chat-empty-workspace / .ws-quick-* 样式。
 * ============================================================================
 */
import './workspacechip.css';

export interface WorkspaceQuickItem {
  /** 目录路径（唯一键）。 */
  path: string;
  /** 显示名（短名）。 */
  name: string;
  /** 会话数角标（可选）。 */
  sessionCount?: number;
}

export interface WorkspaceChipProps {
  /** 当前工作区显示名。 */
  name: string;
  /** chip 的 tooltip。 */
  title?: string;
  /** 当前工作区路径（用于下拉里打勾）；null 表示无。 */
  currentPath: string | null;
  /** 下拉展开状态（受控）。 */
  open: boolean;
  onToggle: () => void;
  /** 下拉文件夹列表。 */
  items: WorkspaceQuickItem[];
  /** 选中某个工作区。 */
  onSelect: (path: string) => void;
  /** 底部「＋ 添加工作区…」。 */
  onAddWorkspace: () => void;
  /** 列表加载中。 */
  loading?: boolean;
  emptyText?: string;
}

export function WorkspaceChip(props: WorkspaceChipProps) {
  const {
    name,
    title = '点击切换工作区',
    currentPath,
    open,
    onToggle,
    items,
    onSelect,
    onAddWorkspace,
    loading = false,
    emptyText = '暂无工作区',
  } = props;

  return (
    <div className="wschip">
      <button
        type="button"
        className="wschip-button"
        title={title}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={onToggle}
      >
        <svg
          className="icon workspace-group-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <span className="wschip-name">{name}</span>
        <svg className="icon" width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open ? (
        <div className="wschip-dropdown" role="menu" aria-label="快速切换工作区">
          <div className="wschip-list">
            {loading ? <div className="wschip-loading">…</div> : null}
            {!loading && items.length === 0 ? <div className="wschip-empty">{emptyText}</div> : null}
            {items.map((it) => {
              const active = !!currentPath && it.path === currentPath;
              return (
                <button
                  key={it.path}
                  type="button"
                  role="menuitem"
                  className={active ? 'wschip-item active' : 'wschip-item'}
                  title={it.path}
                  onClick={() => onSelect(it.path)}
                >
                  <span className="wschip-item-name">{it.name}</span>
                  {typeof it.sessionCount === 'number' ? (
                    <span className="wschip-item-count">{it.sessionCount}</span>
                  ) : null}
                  {active ? <span className="wschip-check" aria-hidden="true">✓</span> : null}
                </button>
              );
            })}
          </div>
          <button type="button" role="menuitem" className="wschip-add" onClick={onAddWorkspace}>
            ＋ <span>添加工作区…</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
