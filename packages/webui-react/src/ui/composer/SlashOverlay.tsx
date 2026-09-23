/**
 * ui/composer/SlashOverlay.tsx —— 斜杠命令浮层（哑组件）
 * ============================================================================
 * 视觉职责：输入框上方的命令面板 —— 搜索输入 + 命令结果列表 + 上下键高亮 +
 * 回车选中。1:1 对齐 vanilla .slash-overlay / .slash-input / .slash-results /
 * .slash-item / .slash-section-label / .slash-skill。
 *
 * 搜索词与高亮是纯界面瞬态（组件内部状态）；命令数据由 props 进、
 * 选中由 onSelect 回调出。
 * ============================================================================
 */
import './slash.css';

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

/** 命令条目。kind='skill' 的条目带 ⚡ 前缀（对应 vanilla .slash-skill）。 */
export interface SlashEntry {
  /** 唯一 id，例如 '/commit'、'skill:plan'。 */
  id: string;
  /** 显示并回填到输入框的命令文本，例如 '/commit'。 */
  cmd: string;
  /** 一行描述。 */
  desc: string;
  kind: 'cmd' | 'skill';
}

export interface SlashOverlayProps {
  open: boolean;
  /** 全量命令（组件按搜索词过滤 cmd/desc）。 */
  entries: SlashEntry[];
  /** 回车 / 点击选中。 */
  onSelect: (entry: SlashEntry) => void;
  /** Esc 关闭。 */
  onClose: () => void;
  placeholder?: string;
  cmdSectionLabel?: string;
  skillSectionLabel?: string;
  emptyText?: string;
}

/** 纯过滤函数：大小写不敏感地匹配 cmd / desc。 */
export function filterSlashEntries(entries: SlashEntry[], query: string): SlashEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (e) => e.cmd.toLowerCase().includes(q) || e.desc.toLowerCase().includes(q),
  );
}

export function SlashOverlay(props: SlashOverlayProps) {
  const {
    open,
    entries,
    onSelect,
    onClose,
    placeholder = '搜索命令...',
    cmdSectionLabel = '命令',
    skillSectionLabel = '技能',
    emptyText = '无匹配命令',
  } = props;

  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 打开时清空搜索、复位高亮并聚焦搜索框。
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIdx(0);
    inputRef.current?.focus();
  }, [open]);

  const filtered = useMemo(() => filterSlashEntries(entries, query), [entries, query]);
  const cmds = filtered.filter((e) => e.kind === 'cmd');
  const skills = filtered.filter((e) => e.kind === 'skill');
  // 扁平顺序：先命令后技能，与上下键高亮的索引一致。
  const flat = useMemo(() => [...cmds, ...skills], [cmds, skills]);

  useEffect(() => {
    if (activeIdx >= flat.length) setActiveIdx(flat.length === 0 ? 0 : flat.length - 1);
  }, [flat.length, activeIdx]);

  // 高亮项滚入可视区。
  useEffect(() => {
    const list = listRef.current;
    if (!list || flat.length === 0) return;
    const el = list.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, flat.length]);

  if (!open) return null;

  const move = (delta: number) => {
    if (flat.length === 0) return;
    setActiveIdx((prev) => (prev + delta + flat.length) % flat.length);
  };

  const selectIdx = (idx: number) => {
    const entry = flat[idx];
    if (entry) onSelect(entry);
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      selectIdx(activeIdx);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  let flatIdx = -1;
  const renderItem = (entry: SlashEntry) => {
    flatIdx += 1;
    const idx = flatIdx;
    return (
      <div
        key={entry.id}
        className={idx === activeIdx ? 'slash-item active' : 'slash-item'}
        data-idx={idx}
        role="option"
        aria-selected={idx === activeIdx}
        onMouseMove={() => setActiveIdx(idx)}
        onClick={() => selectIdx(idx)}
      >
        <span className="slash-item-cmd">{entry.cmd}</span>
        <span className="slash-item-desc">{entry.desc}</span>
      </div>
    );
  };

  return (
    <div className="slash-overlay" role="listbox" aria-label="斜杠命令">
      <input
        ref={inputRef}
        className="slash-input"
        value={query}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIdx(0);
        }}
        onKeyDown={handleKeyDown}
      />
      <div className="slash-results" ref={listRef}>
        {flat.length === 0 ? (
          <div className="slash-item empty">{emptyText}</div>
        ) : (
          <>
            {cmds.length > 0 ? (
              <>
                <div className="slash-section-label">{cmdSectionLabel}</div>
                {cmds.map(renderItem)}
              </>
            ) : null}
            {skills.length > 0 ? (
              <>
                <div className="slash-section-label">{skillSectionLabel}</div>
                {skills.map((entry) => (
                  <div key={`skill-${entry.id}`} className="slash-skill-wrap">
                    {renderItem(entry)}
                  </div>
                ))}
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
