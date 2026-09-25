/**
 * blocks/markdown.tsx —— 最小 Markdown 子集渲染器（共享纯函数）
 * ============================================================================
 * 从 TextBlockView 抽出：助手消息文本块与右栏文档预览（README 等）共用同一套
 * 渲染逻辑 —— 复用保证两处视觉一致，且都不使用 dangerouslySetInnerHTML（无 XSS）。
 *   支持：围栏代码块 / 标题(# ~ ####) / 列表(-、*、1.) / 引用(>) /
 *   分隔线(---) / 行内 code、**粗体**、*斜体*、[文字](链接)。
 * 无外部运行时依赖。
 * ============================================================================
 */

import type { ReactNode } from 'react';

/** 行内小语法：`code` / **bold** / *em* / [text](href)。返回 React 节点，无 innerHTML。 */
export function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const token = m[0];
    const key = keyPrefix + '-i' + String(k);
    k += 1;
    if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('[')) {
      const mid = token.indexOf('](');
      const label = token.slice(1, mid);
      const href = token.slice(mid + 2, -1);
      nodes.push(
        <a key={key} href={href} target="_blank" rel="noopener noreferrer">
          {label}
        </a>,
      );
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    last = m.index + token.length;
    m = re.exec(text);
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function startsSpecial(line: string): boolean {
  return (
    /^```/.test(line) ||
    /^#{1,4}\s+/.test(line) ||
    /^(-{3,}|\*{3,})\s*$/.test(line) ||
    /^>\s?/.test(line) ||
    /^\s*[-*]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line)
  );
}

/** 最小 Markdown 子集 → React 节点列表（纯函数，无 DOM/无 IO）。 */
export function renderMarkdown(src: string): ReactNode[] {
  const lines = src.split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    // 围栏代码块
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence !== null) {
      const lang = fence[1] || '';
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 吃掉收尾围栏（或到 EOF）
      out.push(
        <pre key={'md-' + String(k)} className="blk-code" data-lang={lang || undefined}>
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      k += 1;
      continue;
    }
    // 标题
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = Math.min(heading[1].length, 3);
      const inner = renderInline(heading[2], 'md-h' + String(k));
      if (level === 1) out.push(<h1 key={'md-' + String(k)}>{inner}</h1>);
      else if (level === 2) out.push(<h2 key={'md-' + String(k)}>{inner}</h2>);
      else out.push(<h3 key={'md-' + String(k)}>{inner}</h3>);
      k += 1;
      i += 1;
      continue;
    }
    // 分隔线
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push(<hr key={'md-' + String(k)} />);
      k += 1;
      i += 1;
      continue;
    }
    // 引用
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(
        <blockquote key={'md-' + String(k)}>{renderInline(buf.join(' '), 'md-q' + String(k))}</blockquote>,
      );
      k += 1;
      i += 1;
      continue;
    }
    // 列表（无序 / 有序，连续行成组）
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (
        i < lines.length &&
        (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i]))
      ) {
        items.push(lines[i].replace(/^\s*(?:[-*]|\d+[.)])\s+/, ''));
        i += 1;
      }
      const inner = items.map((t, idx) => (
        <li key={'md-' + String(k) + '-l' + String(idx)} className="blk-text-li">
          {renderInline(t, 'md-' + String(k) + '-l' + String(idx))}
        </li>
      ));
      out.push(
        ordered ? (
          <ol key={'md-' + String(k)}>{inner}</ol>
        ) : (
          <ul key={'md-' + String(k)}>{inner}</ul>
        ),
      );
      k += 1;
      continue;
    }
    // 段落：连续普通行合并为一个 <p>（行间用 <br />，贴近聊天原文排版）
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !startsSpecial(lines[i])) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push(
      <p key={'md-' + String(k)}>
        {buf.map((t, idx) => (
          <span key={'md-' + String(k) + '-p' + String(idx)}>
            {idx > 0 ? <br /> : null}
            {renderInline(t, 'md-' + String(k) + '-p' + String(idx))}
          </span>
        ))}
      </p>,
    );
    k += 1;
  }
  return out;
}
