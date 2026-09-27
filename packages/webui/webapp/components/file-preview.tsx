"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Locale, MessageKey } from "@/lib/i18n";
import {
  fsRawUrl,
  getFsFile,
  openFileWithDefault,
  revealInFileManager,
  type FileOpenResult,
  type FsFilePayload,
} from "@/lib/api";
import { renderMarkdown } from "@/lib/markdown";
import {
  basenameOf,
  formatBytes,
  pickPreviewKind,
  type PreviewKind,
} from "@/lib/file-preview";
import {
  classifyUnsupported,
  type UnsupportedReason,
} from "@/lib/file-open-reason";
import { tFileOpen } from "@/lib/i18n-file-open";

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

export function FilePreview({ path, t, locale }: FilePreviewProps) {
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
          path={path}
          locale={locale}
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
  path,
  locale,
}: {
  error: string;
  payload: FsFilePayload | null;
  fileName: string;
  path: string;
  locale: Locale;
}) {
  // The classification lives in lib/file-open-reason.ts so the
  // component does not re-implement the regex / prefix split. The
  // result also drives which buttons are enabled (the `actionsAvailable`
  // flag — false for out-of-bounds, where the OS opener cannot help).
  const unsupported = useMemo(
    () => classifyUnsupported(error, payload),
    [error, payload],
  );

  // Local state for the two actions: which one is currently firing
  // (so the spinner / disable lives on the button, not on the whole
  // panel), and which one last failed (the panel renders the failure
  // copy inline so a click never silently no-ops).
  const [busy, setBusy] = useState<"open-default" | "reveal" | null>(null);
  const [failure, setFailure] = useState<{ key: "open-default" | "reveal"; message: string } | null>(null);
  // Disabled-by-server: when the server has already answered a previous
  // click with `code === "no-opener"`, we know the host cannot run the
  // action at all — the button stays disabled for the lifetime of this
  // open file, with the disabledHint tooltip explaining why. A "fresh"
  // navigation to a different file clears this back to enabled.
  const [disabledByServer, setDisabledByServer] = useState<{
    openDefault: boolean;
    reveal: boolean;
    reason?: string;
  }>({ openDefault: false, reveal: false });

  // Reset per-file state when the panel re-mounts onto a different
  // path (the React component re-uses between file switches).
  useEffect(() => {
    setBusy(null);
    setFailure(null);
    setDisabledByServer({ openDefault: false, reveal: false });
  }, [path]);

  const fireAction = useCallback(
    async (kind: "open-default" | "reveal") => {
      if (!unsupported.actionsAvailable) return;
      if (disabledByServer.openDefault || disabledByServer.reveal) return;
      setBusy(kind);
      setFailure(null);
      let result: FileOpenResult;
      try {
        result =
          kind === "open-default"
            ? await openFileWithDefault(path)
            : await revealInFileManager(path);
      } catch (cause) {
        result = {
          ok: false,
          code: "spawn-failed",
          error: cause instanceof Error ? cause.message : String(cause),
        };
      } finally {
        setBusy(null);
      }
      if (result.ok) {
        setFailure(null);
        return;
      }
      // `no-opener` is a permanent disable — the host cannot run the
      // action, so the button stays disabled with the dedicated hint.
      // Other failures (spawn-failed, network) stay transient so a
      // retry is still possible.
      if (result.code === "no-opener") {
        setDisabledByServer((current) => ({
          ...current,
          openDefault: kind === "open-default" ? true : current.openDefault,
          reveal: kind === "reveal" ? true : current.reveal,
        }));
      }
      setFailure({
        key: kind,
        message:
          result.error ||
          (result.code ? `code: ${result.code}` : "unknown error"),
      });
    },
    [path, unsupported.actionsAvailable, disabledByServer],
  );

  const reasonText = reasonCopy(locale, unsupported.reason, unsupported.params);
  const language = payload?.language ?? "";

  return (
    <div
      className="flex flex-col gap-3 rounded-[10px] border border-border_default bg-bg_grouped_secondary_elevated px-3 py-3 text-text_default_secondary"
      data-testid="file-preview-error"
      data-reason={unsupported.reason}
    >
      <div className="flex items-start gap-2">
        <span
          className="flex size-4 flex-shrink-0 items-center justify-center text-icon_default_secondary"
          aria-hidden
        >
          {/* Inline glyph keeps the row height stable without pulling in
              a new icon registration — a small "warning" style square. */}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M8 1.5L1.5 13.5h13L8 1.5z"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
            <path
              d="M8 6v3.5"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
            <circle cx="8" cy="11.5" r="0.6" fill="currentColor" />
          </svg>
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span
            className="text-caption-small-strong font-medium text-text_default_primary"
            data-testid="file-preview-error-title"
          >
            {tFileOpen(locale, "fileOpen.header.unsupported")}
          </span>
          <span
            className="text-sm"
            data-testid="file-preview-error-reason"
          >
            {reasonText}
            {language && unsupported.reason !== "outOfBounds" ? (
              <span
                className="ml-1 text-text_default_tertiary"
                data-testid="file-preview-error-language"
              >
                [{language}]
              </span>
            ) : null}
          </span>
        </div>
      </div>
      <div
        className="flex flex-wrap items-center gap-2"
        data-testid="file-preview-error-actions"
      >
        <button
          type="button"
          onClick={() => void fireAction("open-default")}
          disabled={
            !unsupported.actionsAvailable ||
            busy !== null ||
            disabledByServer.openDefault
          }
          title={
            disabledByServer.openDefault
              ? tFileOpen(locale, "fileOpen.button.disabledHint")
              : tFileOpen(locale, "fileOpen.action.openDefault.aria")
          }
          aria-label={tFileOpen(locale, "fileOpen.action.openDefault.aria")}
          data-testid="file-preview-error-open-default"
          data-disabled-reason={
            disabledByServer.openDefault ? "no-opener" : undefined
          }
          className="flex h-7 items-center gap-1 rounded-[8px] border border-border_default bg-bg_default_scrim px-2 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-bg_default_scrim"
        >
          {busy === "open-default" ? (
            <span aria-hidden>…</span>
          ) : null}
          <span>{tFileOpen(locale, "fileOpen.action.openDefault")}</span>
        </button>
        <button
          type="button"
          onClick={() => void fireAction("reveal")}
          disabled={
            !unsupported.actionsAvailable ||
            busy !== null ||
            disabledByServer.reveal
          }
          title={
            disabledByServer.reveal
              ? tFileOpen(locale, "fileOpen.button.disabledHint")
              : tFileOpen(locale, "fileOpen.action.reveal.aria")
          }
          aria-label={tFileOpen(locale, "fileOpen.action.reveal.aria")}
          data-testid="file-preview-error-reveal"
          data-disabled-reason={
            disabledByServer.reveal ? "no-opener" : undefined
          }
          className="flex h-7 items-center gap-1 rounded-[8px] border border-border_default bg-bg_default_scrim px-2 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-bg_default_scrim"
        >
          {busy === "reveal" ? <span aria-hidden>…</span> : null}
          <span>{tFileOpen(locale, "fileOpen.action.reveal")}</span>
        </button>
        {!unsupported.actionsAvailable ? (
          <span
            className="text-caption-small-strong text-text_default_tertiary"
            data-testid="file-preview-error-actions-disabled-hint"
          >
            {tFileOpen(locale, "fileOpen.button.disabledHint")}
          </span>
        ) : null}
      </div>
      {failure ? (
        <p
          className="rounded-[8px] bg-bg_grouped_tertiary px-2 py-1 text-caption-small-strong text-text_status_error"
          data-testid="file-preview-error-failure"
          data-failure-kind={failure.key}
          role="status"
        >
          {tFileOpen(
            locale,
            failure.key === "open-default"
              ? "fileOpen.failure.openDefault"
              : "fileOpen.failure.reveal",
            { error: failure.message },
          )}
        </p>
      ) : null}
      {/* fileName stays in scope for any future header line — kept in
          the props list deliberately so the next contributor does not
          have to re-thread it through the call site. */}
      <span data-testid="file-preview-error-filename" hidden>
        {fileName}
      </span>
    </div>
  );
}

/**
 * Resolve the user-facing reason copy through the slice-14 i18n module.
 *
 * Pulled out so the JSX above is a flat layout and the substitution is
 * testable. The classifier (`lib/file-open-reason.ts`) is responsible
 * for the reason key; this helper is responsible for the copy.
 */
function reasonCopy(
  locale: Locale,
  reason: UnsupportedReason,
  params: { mime?: string; error?: string },
): string {
  switch (reason) {
    case "binary":
      return tFileOpen(locale, "fileOpen.reason.binary", params);
    case "oversize":
      return tFileOpen(locale, "fileOpen.reason.oversize", params);
    case "outOfBounds":
      return tFileOpen(locale, "fileOpen.reason.outOfBounds", params);
    case "unknown":
    default:
      return tFileOpen(locale, "fileOpen.reason.unknown", params);
  }
}