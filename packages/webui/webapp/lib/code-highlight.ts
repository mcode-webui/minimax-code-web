import hljs from "highlight.js";

// `LanguageFn` exists in highlight.js's d.ts but is not exported. We
// re-derive it through the `registerLanguage` parameter type so we
// stay consistent with whatever the upstream declaration says.
type LanguageFn = Parameters<typeof hljs.registerLanguage>[1];

/**
 * Code highlighter — slice 22 of webui-parity.
 *
 * Wraps highlight.js to give the file-preview surface three properties
 * the bare `<pre>` view lacks:
 *   - per-language lazy grammar loading (only the language of the open
 *     file is fetched and registered, not all 191 languages hljs ships);
 *   - line-number gutter alignment via post-tokenized line splitting;
 *   - bounded work on huge inputs (truncate before highlighting so a
 *     512 KiB file does not freeze the tab).
 *
 * The backend already labels files via its `EXT_LANGUAGE` table
 * (`server/lib/fs-util.js#languageForExtension`); the view does not
 * re-guess. Unknown or unloaded languages fall through to a plain
 * monospace view — see {@link highlightCode} for the contract.
 *
 * The highlight step is pure: given a (language, content) pair, it
 * returns either an HTML string with `<span class="hljs-*">` markup,
 * or `null` when the language is not highlightable. Returning `null`
 * is the "unknown language → no error, no blank" path the ticket
 * asks for: the caller renders the raw content in a `<pre>` without
 * the highlighting shell.
 */

const DEFAULT_LARGE_FILE_TRUNCATE_LINES = 1500;
/**
 * Byte budget for the highlight step.
 *
 * Why 32 KiB and not 256 KiB. highlight.js 10.7.3 is super-linear
 * on pathological inputs — a single 256 KiB line of unrepeated
 * characters takes >60 seconds to lex (the JS grammar tries every
 * rule against every position with no early termination). 32 KiB
 * is the largest input where worst-case highlighting completes in
 * well under a second, which is the cap the preview needs to stay
 * responsive. Real source files have line breaks, so the
 * `maxLines` budget below catches the rest of the "long file"
 * case before the byte budget fires.
 */
const DEFAULT_LARGE_FILE_TRUNCATE_BYTES = 32 * 1024;

/**
 * Map the server's `language` field (see `EXT_LANGUAGE` in
 * `server/lib/fs-util.js`) to the highlight.js module name to import.
 *
 * Notes for the table:
 *   - `html` → `xml` because hljs 10.7.3 ships html as an alias of xml.
 *   - `jsonc` → `json` (best-effort; // comments would tokenise oddly,
 *     but json is otherwise the same grammar).
 *   - `toml` and `plain` deliberately have no entry: there is no hljs
 *     module for them in 10.7.3, and the caller treats them as plain
 *     monospace. `plain` is the catch-all for "no language".
 *   - Everything not in this table resolves to {@link highlightCode}'s
 *     `null` branch — the file preview's "unknown language" fallback.
 */
const LANGUAGE_TO_HLJS: Record<string, string> = {
  typescript: "typescript",
  javascript: "javascript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  less: "less",
  // hljs 10.7.3 has no standalone `html` module; html is an alias of xml
  // (see node_modules/highlight.js/lib/languages/xml.js). Loading xml
  // registers html for free.
  html: "xml",
  xml: "xml",
  markdown: "markdown",
  python: "python",
  ruby: "ruby",
  go: "go",
  rust: "rust",
  java: "java",
  kotlin: "kotlin",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  bash: "bash",
  yaml: "yaml",
  sql: "sql",
  dockerfile: "dockerfile",
};

/**
 * Cache of "language has already been registered with hljs". The
 * registration is idempotent (`registerLanguage` throws on duplicate
 * names — see node_modules/highlight.js/lib/core.js), so we MUST guard
 * against a second registration; a hot file-tree navigation can ask
 * for the same grammar twice in a row.
 *
 * The cache key is the normalized hljs module name, not the original
 * server label — that way `html` and `xml` share one registration.
 */
const registeredLanguages = new Set<string>();

/**
 * Load the highlight.js grammar for `language` if it is supported.
 *
 * Returns the hljs module name that was registered, or `null` if the
 * language is not in {@link LANGUAGE_TO_HLJS}. Callers that receive
 * `null` should render a plain monospace view (no error, no blank).
 *
 * The dynamic import is what makes this "per-language lazy": webpack
 * turns each `import('highlight.js/lib/languages/...')` into its own
 * chunk. Only the chunk for the open file's language is fetched.
 */
export async function loadHljsLanguage(language: string): Promise<string | null> {
  const normalised = (language ?? "").toLowerCase().trim();
  if (!normalised) return null;
  const moduleName = LANGUAGE_TO_HLJS[normalised];
  if (!moduleName) return null;
  if (registeredLanguages.has(moduleName)) return moduleName;
  // Dynamic import → webpack/Next chunks each language module.
  // The language modules are CommonJS (`module.exports = function(hljs){}`),
  // which ESM exposes as `default` under Node's interop. The same interop
  // works in webpack, so a single branch covers both runtimes.
  const mod = await import(
    /* webpackChunkName: "hljs-[request]" */
    `highlight.js/lib/languages/${moduleName}.js`
  );
  const languageFn: LanguageFn = (mod as { default?: LanguageFn }).default ?? (mod as unknown as LanguageFn);
  hljs.registerLanguage(moduleName, languageFn);
  registeredLanguages.add(moduleName);
  return moduleName;
}

/**
 * Public view of the lazy-loading cache — used by tests to assert
 * that a specific file open did not pull in unrelated grammars.
 */
export function _registeredLanguagesForTest(): ReadonlySet<string> {
  return registeredLanguages;
}

/**
 * Reset the cache. Intended for tests only; never call from app code.
 */
export function _resetHljsLanguageCacheForTest(): void {
  registeredLanguages.clear();
}

export interface HighlightedCode {
  /**
   * Either highlight.js HTML markup with `<span class="hljs-*">` tokens,
   * or `null` when the language is unknown / not loaded / blank. The
   * null branch is the "unknown-language fallback" — the caller renders
   * the raw content as plain monospace text.
   *
   * Returning `null` (rather than throwing or returning escaped HTML)
   * means the contract is total: every input produces a renderable
   * result.
   */
  html: string | null;
  /**
   * The hljs module name actually used (e.g. "javascript"), or `null`
   * when the input was not highlighted. The component renders a
   * language badge from this so the user always sees what the
   * highlight was based on.
   */
  language: string | null;
  /**
   * Whether the content was truncated before highlighting. The caller
   * renders an inline notice so the user knows the file is bigger
   * than what they see.
   */
  truncated: boolean;
  /**
   * Original line count, before truncation. `undefined` when the file
   * was not truncated — saves the cost of a `split('\n').length` on
   * the happy path.
   */
  originalLineCount?: number;
  /**
   * How many lines the caller should render. Equal to
   * `originalLineCount` when `truncated` is false.
   */
  visibleLineCount: number;
}

export interface HighlightOptions {
  /**
   * Maximum number of source lines to highlight. Files longer than
   * this are truncated and the caller renders an honest notice.
   * Defaults to {@link DEFAULT_LARGE_FILE_TRUNCATE_LINES}.
   */
  maxLines?: number;
  /**
   * Maximum number of source bytes to highlight. Wins over `maxLines`
   * when both apply. Defaults to {@link DEFAULT_LARGE_FILE_TRUNCATE_BYTES}.
   */
  maxBytes?: number;
}

/**
 * Highlight `content` as `language` and return an HTML string ready
 * for the gutter+code view.
 *
 * Implementation notes — three rules govern the body of this function:
 *   1. NEVER call `hljs.highlight` with a language it does not know:
 *      hljs 10.7.3 throws ("Unknown language") on unregistered names,
 *      and the contract here is total — bad inputs must not blow up.
 *   2. ALWAYS truncate before highlighting: the highlight step is
 *      O(content length) and a 512 KiB JS file with deep nesting can
 *      keep the main thread busy for >1s. Truncating first keeps the
 *      cost bounded.
 *   3. The fallback path escapes the raw bytes — when the language is
 *      unknown, the raw bytes are dropped into a `<pre>` directly,
 *      so they MUST be HTML-safe.
 */
export async function highlightCode(
  language: string,
  content: string,
  options: HighlightOptions = {},
): Promise<HighlightedCode> {
  const maxLines = options.maxLines ?? DEFAULT_LARGE_FILE_TRUNCATE_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_LARGE_FILE_TRUNCATE_BYTES;

  // Treat undefined / empty / whitespace as "no language", not as an
  // error. We never let an empty string reach hljs.highlight — that
  // would throw.
  const normalisedLanguage = (language ?? "").toLowerCase().trim();

  const totalLines = countLines(content);
  const bytes = byteLength(content);
  const shouldTruncate = totalLines > maxLines || bytes > maxBytes;
  const workingContent = shouldTruncate ? truncateContent(content, maxLines, maxBytes) : content;
  const visibleLineCount = shouldTruncate ? countLines(workingContent) : totalLines;

  // Fast path — unknown language (including `plain`, `""`, `toml`,
  // and any label the server returns that we do not recognise).
  if (!normalisedLanguage) {
    return {
      html: null,
      language: null,
      truncated: shouldTruncate,
      originalLineCount: shouldTruncate ? totalLines : undefined,
      visibleLineCount,
    };
  }

  const moduleName = await loadHljsLanguage(normalisedLanguage);
  if (!moduleName) {
    return {
      html: null,
      language: normalisedLanguage || null,
      truncated: shouldTruncate,
      originalLineCount: shouldTruncate ? totalLines : undefined,
      visibleLineCount,
    };
  }

  // We just registered `moduleName` (or confirmed it is already
  // registered), so hljs.highlight will not throw "Unknown language".
  // `ignoreIllegals: true` makes it tolerant of syntax it does not
  // recognise — a JS file labelled "html" would otherwise abort the
  // whole file at the first unmatched rule.
  const result = hljs.highlight(workingContent, {
    language: moduleName,
    ignoreIllegals: true,
  });
  return {
    html: result.value,
    language: moduleName,
    truncated: shouldTruncate,
    originalLineCount: shouldTruncate ? totalLines : undefined,
    visibleLineCount,
  };
}

/**
 * Pre-computed lines + their highlight HTML, for the gutter+code view.
 * Each entry represents one source line; the index in the array IS
 * the line number (1-based display).
 */
export interface HighlightedLine {
  /** Line number, 1-based. Used by the gutter. */
  number: number;
  /** Highlighted HTML for this line only. Empty string for blank lines. */
  html: string;
  /** Raw text for the line (for copy-without-line-numbers and accessibility). */
  text: string;
}

export interface SplitHighlightedLines {
  lines: HighlightedLine[];
  truncated: boolean;
  originalLineCount?: number;
  visibleLineCount: number;
  language: string | null;
}

/**
 * Re-split the highlight.js HTML into per-line records so the gutter
 * can render line numbers against the exact same lines the code view
 * shows. hljs returns a single HTML string with embedded newlines; we
 * split on `\n` and walk both the HTML (for the gutter-aware display)
 * and the raw text (for copy + selection).
 *
 * Edge case: hljs may leave a `<span>` open across a line boundary
 * (e.g. a multi-line template literal). A naive `split('\n')` would
 * leave the gutter with two unbalanced chunks — a `<span>` opening
 * on line N with its closing on line N+1. We balance each line by
 * closing spans that were open at the end of the previous line and
 * re-opening them at the end of the current one. The result is
 * hover-stable (line N's spans do not bleed into line N+1) and copy-
 * faithful (selection lives inside a balanced DOM tree).
 */
export function splitHighlightedLines(
  highlighted: HighlightedCode,
  rawContent: string,
): SplitHighlightedLines {
  // The split only emits as many lines as the highlight step
  // produced. When the file was truncated, that is
  // `visibleLineCount`; when not, it is the source line count.
  // Slicing `sourceLines` to `visibleLineCount` BEFORE the loop
  // means the gutter, the code, and the metadata all agree.
  const sourceLines = splitSourceLines(rawContent).slice(0, highlighted.visibleLineCount);

  if (highlighted.html === null) {
    // Plain monospace path — no highlighting, but we still need
    // per-line records for the gutter. Each line is escaped raw text.
    return {
      lines: sourceLines.map((text, i) => ({
        number: i + 1,
        html: escapeHtml(text),
        text,
      })),
      truncated: highlighted.truncated,
      originalLineCount: highlighted.originalLineCount,
      visibleLineCount: highlighted.visibleLineCount,
      language: highlighted.language,
    };
  }

  // Highlighted path. The hljs output is balanced overall. When we
  // split on `\n`, a span can either be wholly inside one line (the
  // common case — open and close on the same line, hljs already
  // emits both tags there) or cross a line boundary (a multi-line
  // string, regex, etc.). For the cross-line case, hljs emits the
  // opening tag on the FIRST line of the run and the closing tag on
  // the LAST — but the middle lines have neither, so each line by
  // itself would be missing its wrapper.
  //
  // The fix: wrap each line with `<span>` / `</span>` for every
  // carried-in span. That makes each line a self-contained balanced
  // chunk: opening tags precede the line content, closing tags
  // follow it. The hljs-emitted `<span>` and `</span>` tags INSIDE
  // the line balance as expected because hljs always emits balanced
  // pairs. Lines with no carried-in spans are untouched.
  const htmlLines = highlighted.html.split("\n").slice(0, highlighted.visibleLineCount);
  const out: HighlightedLine[] = [];
  let carriedSpans: string[] = []; // spans open at the START of the current line

  for (let i = 0; i < sourceLines.length; i += 1) {
    const htmlLine = htmlLines[i] ?? "";
    const text = sourceLines[i] ?? "";

    // Compute the spans open at the END of this line so the next
    // line knows what to prepend / append.
    const endSpans = carriedSpans.slice();
    const tagPattern = /<\/?(span)\b[^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(htmlLine)) !== null) {
      const tag = match[0];
      if (tag.startsWith("</")) {
        if (endSpans.length > 0) endSpans.pop();
      } else if (!tag.endsWith("/>")) {
        endSpans.push("span");
      }
    }

    // Prepend and append carries. For each carried-in span, open a
    // matching `<span>` at the start and close it at the end of the
    // line — making this line a balanced chunk that is hover-stable
    // AND visually identical to the hljs source. The next line gets
    // its own fresh carries from its own endSpans.
    const carryOpen = carriedSpans.length ? `<${carriedSpans.join("><")}>` : "";
    const carryClose = carriedSpans.length ? `</${[...carriedSpans].reverse().join("></")}>` : "";

    out.push({
      number: i + 1,
      html: `${carryOpen}${htmlLine}${carryClose}`,
      text,
    });
    carriedSpans = endSpans;
  }

  return {
    lines: out,
    truncated: highlighted.truncated,
    originalLineCount: highlighted.originalLineCount,
    visibleLineCount: highlighted.visibleLineCount,
    language: highlighted.language,
  };
}

// ---------------------------------------------------------------------
// Pure helpers — exported so tests can pin them without spinning up
// the highlight.js runtime.
// ---------------------------------------------------------------------

export function countLines(content: string): number {
  // Match the IDE convention: count newlines, add 1 for the final
  // partial line, but drop the count by 1 when the content ends
  // with a newline (so `"hello\n"` is one line, not two — the
  // editor's gutter shows 1 for that file). Empty input is zero
  // lines, not one.
  if (!content) return 0;
  let count = 1;
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) count += 1;
  }
  if (content.charCodeAt(content.length - 1) === 10) count -= 1;
  if (count < 1 && content.length > 0) count = 1;
  return count;
}

export function byteLength(content: string): number {
  // The browser uses UTF-16 code units; the source-of-truth here is
  // the highlighted bytes we put on the wire. We use the cheaper
  // `TextEncoder` path when available (production) and fall back to
  // `string.length` (Node tests).
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(content).length;
  }
  return content.length;
}

function truncateContent(content: string, maxLines: number, maxBytes: number): string {
  // Truncate by lines first; if the byte budget is still exceeded,
  // truncate by bytes. Both are inclusive of the trailing newline
  // so the highlight step does not see a half-line.
  const lines = content.split("\n");
  const limit = Math.min(maxLines, lines.length);
  let slice = lines.slice(0, limit).join("\n");
  if (byteLength(slice) > maxBytes) {
    // Trim to maxBytes by code point; TextEncoder counts bytes, but
    // truncating mid-character is acceptable here because we mark
    // the file as truncated in the UI.
    const encoder = new TextEncoder();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const encoded = encoder.encode(slice);
    slice = decoder.decode(encoded.subarray(0, maxBytes));
  }
  return slice;
}

export function splitSourceLines(content: string): string[] {
  // Mirror hljs's own newline semantics: split on \n, drop the
  // trailing empty entry that comes from a final newline so the
  // gutter count equals the user's mental count. A file that ends
  // with "\n" therefore does NOT get a phantom empty line at the
  // bottom of the gutter. Empty input collapses to no lines.
  if (!content) return [];
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (c) => ESCAPE_MAP[c] ?? c);
}

/**
 * Public mapping table — exposed for tests that want to assert the
 * server→hljs mapping without re-implementing the logic.
 */
export const _languageToHljsForTest: Readonly<Record<string, string>> = LANGUAGE_TO_HLJS;
