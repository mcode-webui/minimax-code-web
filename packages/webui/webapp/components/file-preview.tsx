"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Locale, MessageKey } from "@/lib/i18n";
import { fsRawUrl, getFsFile, type FsFilePayload } from "@/lib/api";
import { renderMarkdown } from "@/lib/markdown";
import {
  basenameOf,
  formatBytes,
  pickPreviewKind,
  type PreviewKind,
} from "@/lib/file-preview";

/**
 * File preview (slice 02 of the webui-parity program).
 *
 * A read-only viewer that the right-hand `files` panel opens on click. It is
 * a small type→renderer router over `/api/fs/read-file` (text, ≤512 KiB)
 * and `/api/fs/raw` (bytes, ≤20 MiB); the parent agent's `panels.tsx`
 * wiring is the follow-up that mounts this component into the tree (out of
 * scope for this slice, by design).
 *
 * Routing rules — what gets which renderer:
 *   `.md` / `.markdown`   rendered markdown (via lib/markdown.ts)
 *   image extensions      <img src="/api/fs/raw?path=…">
 *   source / data files    monospace pre, light "language" badge in the header
 *   anything else         "无法预览" placeholder
 *
 * The component never truncates the response. Oversize reads return
 * `413` and the component surfaces the server's message verbatim; binary
 * detection returns `415` and the placeholder names the mime type so the
 * user knows what they tried to open.
 *
 * Containment: every fetch hits the server's shared `assertWorkspacePath`
 * gate, so an out-of-root path is rejected before bytes leave the box. No
 * new escape hatch was added in this slice.
 */

export interface FilePreviewProps {
  /** Absolute path of the file to preview (the wire form `/api/fs/read-file`
   *  expects). The caller is responsible for surfacing only paths it itself
   *  got from a server-blessed source (the workspace picker, a tree node, …). */
  path: string;
  /** Translation function — same shape as the rest of the panels. */
  t: (key: MessageKey) => string;
  locale: Locale;
}

export function FilePreview({ path, t, locale: _locale }: FilePreviewProps) {
  const [payload, setPayload] = useState<FsFilePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Last-write-wins: a quick `a → b → a` switch (e.g. user clicks through
  // the tree) should not let the older `a` payload land after the newer
  // `b`. The FilesPanel uses the same trick — keeping the discipline
  // uniform across panels makes the regression case obvious.
  const loadGen = useMemo(() => ({ current: 0 }), []);
  const load = useCallback(async () => {
    const gen = ++loadGen.current;
    setLoading(true);
    setError(null);
    try {
      const next = await getFsFile(path);
      if (gen !== loadGen.current) return;
      setPayload(next);
      if (!next.ok) setError(next.error ?? "unreadable");
    } catch (cause) {
      if (gen !== loadGen.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setPayload(null);
    } finally {
      if (gen === loadGen.current) setLoading(false);
    }
  }, [path, loadGen]);

  useEffect(() => {
    void load();
  }, [load]);

  const fileName = basenameOf(path);
  // The read-file endpoint rejects binary (mime-stripped NUL byte) but still
  // reports the detected mime on the error payload. An image mime is a green
  // light to render via /api/fs/raw — the user's intent is "show me the
  // picture", not "tell me this is binary". We branch on the mime directly
  // (not on `kind`) so the image path wins even when the payload says
  // ok:false; the body then re-derives `kind` for non-image cases.
  const mimeIsImage = (payload?.mime ?? "").toLowerCase().startsWith("image/");
  const showImage = mimeIsImage && !!payload;
  const kind =
    payload && !showImage
      ? pickPreviewKind(payload, path)
      : null;

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col gap-2"
      data-testid="file-preview"
      data-path={path}
    >
      <header className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text_default_primary" title={path}>
          {fileName}
        </span>
        {payload?.size !== undefined && payload.size > 0 ? (
          <span
            className="flex-none text-caption-small-strong text-text_default_tertiary"
            data-testid="file-preview-size"
          >
            {formatBytes(payload.size)}
          </span>
        ) : null}
      </header>

      {loading && !payload ? (
        <p
          className="text-caption-small-strong text-text_default_tertiary"
          data-testid="file-preview-loading"
        >
          {t("app.connecting")}
        </p>
      ) : null}

      {error && !showImage ? (
        <PreviewError
          error={error}
          payload={payload}
          fileName={fileName}
        />
      ) : null}

      {showImage || (kind && payload && payload.ok) ? (
        <div className="file-preview-body min-h-0 flex-1 overflow-auto">
          {showImage ? (
            <ImageView path={path} />
          ) : (
            <PreviewBody kind={kind as PreviewKind} payload={payload} path={path} />
          )}
        </div>
      ) : null}
    </div>
  );
}

function PreviewBody({
  kind,
  payload,
  path,
}: {
  kind: PreviewKind;
  payload: FsFilePayload;
  path: string;
}) {
  switch (kind) {
    case "markdown":
      return <MarkdownView content={payload.content ?? ""} />;
    case "image":
      return <ImageView path={path} />;
    case "code":
      return <CodeView content={payload.content ?? ""} language={payload.language ?? "plain"} />;
    default:
      // pickPreviewKind() never returns "unsupported" today; kept as an
      // escape hatch so the call-site exhaustiveness check stays honest.
      return <UnsupportedView fileName={basenameOf(path)} />;
  }
}

function MarkdownView({ content }: { content: string }) {
  // renderMarkdown() sanitises the parsed HTML on the browser side (see
  // lib/markdown.ts#sanitize) — the same policy used by chat.tsx for
  // assistant output. Reusing it keeps the threat model and allow-list
  // identical across surfaces.
  const html = useMemo(() => renderMarkdown(content), [content]);
  return (
    <div
      className="file-preview-markdown"
      data-testid="file-preview-markdown"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function ImageView({ path }: { path: string }) {
  return (
    <div
      className="flex min-h-0 w-full items-start justify-center overflow-auto"
      data-testid="file-preview-image"
    >
      <img
        src={fsRawUrl(path)}
        alt={basenameOf(path)}
        className="max-w-full rounded-[8px] border border-border_default"
      />
    </div>
  );
}

function CodeView({ content, language }: { content: string; language: string }) {
  return (
    <div className="flex flex-col gap-1" data-testid="file-preview-code">
      <div className="flex items-center gap-2 text-caption-small-strong text-text_default_tertiary">
        <span data-testid="file-preview-language">{language}</span>
      </div>
      <pre
        className="file-preview-codeblock thin-scrollbar max-w-full overflow-auto rounded-[8px] bg-bg_grouped_secondary_elevated p-3 font-family-code text-caption-small-strong text-text_default_primary"
        // Plain <pre>, NOT .codeblock-pre: that selector carries the chat
        // codeblock shell (toolbar, copy button) which is meaningless for
        // a file preview, and would otherwise override our padding to 0.
      >
        <code>{content}</code>
      </pre>
    </div>
  );
}

function UnsupportedView({ fileName }: { fileName: string }) {
  return (
    <div
      className="flex items-start gap-2 rounded-[10px] border border-border_default bg-bg_grouped_secondary_elevated px-3 py-3 text-text_default_secondary"
      data-testid="file-preview-unsupported"
    >
      <span className="text-sm">无法预览 {fileName}（无法识别的文件类型）。</span>
    </div>
  );
}

function PreviewError({
  error,
  payload,
  fileName,
}: {
  error: string;
  payload: FsFilePayload | null;
  fileName: string;
}) {
  const mime = payload?.mime ?? "";
  const language = payload?.language ?? "";
  const isBinary = payload?.binary === true;
  const isTooLarge = error.startsWith("file too large");
  const isContainment = /越界|allowed root|MCODE_WEBUI_WORKSPACE_ROOTS/i.test(error);
  return (
    <div
      className="flex items-start gap-2 rounded-[10px] border border-border_default bg-bg_grouped_secondary_elevated px-3 py-3 text-text_default_secondary"
      data-testid="file-preview-error"
    >
      <span className="text-sm">
        {isContainment
          ? "无法访问该文件：路径不在允许的工作区内。"
          : isTooLarge
            ? `${fileName} 超过单文件预览上限（512 KiB），请在编辑器中打开。`
            : isBinary
              ? `${fileName} 是二进制文件（${mime || "unknown type"}），无法预览。`
              : `无法预览 ${fileName}：${error}`}
        {language && !isContainment ? (
          <span className="ml-1 text-text_default_tertiary">[{language}]</span>
        ) : null}
      </span>
    </div>
  );
}