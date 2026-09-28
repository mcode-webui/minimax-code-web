"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Locale, MessageKey } from "@/lib/i18n";
import {
  fsRawUrl,
  fsRawDownloadUrl,
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
import {
  credentialSubReasonLabel,
  tFileOpen,
} from "@/lib/i18n-file-open";

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
  /**
   * Slice 15 — initial scroll position for the inner scroll
   * container. Applied once on mount and again whenever `path`
   * changes (a file-tab switch re-mounts the inner view via the
   * caller's `key={tab.id}`, so this only fires once per tab).
   * Set to 0 (the default) to disable restoration. */
  initialScrollTop?: number;
  /**
   * Slice 15 — fired on every scroll of the inner body, with
   * the new scrollTop. The wrapper (file-tab body) debounces
   * and persists through the workspace-tabs reducer so a
   * refresh restores the user's place in a long file. */
  onScrollPersist?: (scrollTop: number) => void;
}

export function FilePreview({
  path,
  t,
  locale,
  initialScrollTop = 0,
  onScrollPersist,
}: FilePreviewProps) {
  const [payload, setPayload] = useState<FsFilePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ref to the inner scrollable container — `.file-preview-body`.
  // The outer wrapper does NOT scroll (the wrapper's `overflow`
  // is `hidden`); only this inner div scrolls, so the scroll
  // handler belongs here. The wrapper above used to attach the
  // handler to its own (non-scrolling) div, which silently
  // produced `fileScrolls: {}` — the regression the acceptance
  // run flagged.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const restoredRef = useRef<boolean>(false);

  // Last-write-wins: a quick `a → b → a` switch (e.g. user clicks through
  // the tree) should not let the older `a` payload land after the newer
  // `b`. The FilesPanel uses the same trick — keeping the discipline
  // uniform across panels makes the regression case obvious.
  const loadGen = useMemo(() => ({ current: 0 }), []);
  const load = useCallback(
    async (opts: { confirmCredential?: boolean } = {}) => {
      const gen = ++loadGen.current;
      setLoading(true);
      setError(null);
      try {
        const next = await getFsFile(path, {
          confirmCredential: opts.confirmCredential === true,
        });
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
    },
    [path, loadGen],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Restore the persisted scroll position. The restore fires
  // once per (path, initialScrollTop) pair: after the body has
  // had a chance to render its inner content (the file-preview-
  // body div's `scrollHeight` only settles once the async
  // `load()` resolves and `kind` resolves to a known renderer),
  // we apply the persisted offset. A subsequent paint would be
  // a no-op because `restoredRef.current` already flipped.
  useEffect(() => {
    restoredRef.current = false;
    if (initialScrollTop <= 0) {
      restoredRef.current = true;
      return;
    }
    let cancelled = false;
    const apply = () => {
      if (cancelled) return;
      const node = bodyRef.current;
      if (!node) {
        // Body not yet in the DOM (still loading). Re-attempt on
        // the next animation frame.
        requestAnimationFrame(apply);
        return;
      }
      if (node.scrollHeight <= node.clientHeight) {
        // File fits on screen — there's nothing to scroll.
        restoredRef.current = true;
        return;
      }
      node.scrollTop = initialScrollTop;
      restoredRef.current = true;
    };
    // Defer the first attempt so the inner content has a chance
    // to render. FilesPanel's `getFsFile` is fast (≤ 512 KiB) but
    // is still async; a single rAF is enough on average.
    requestAnimationFrame(apply);
    return () => {
      cancelled = true;
    };
  }, [path, initialScrollTop]);

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
          onConfirmCredential={() => void load({ confirmCredential: true })}
        />
      ) : null}

      {showImage || (kind && payload && payload.ok) ? (
        <div
          ref={bodyRef}
          onScroll={onScrollPersist ? (event) => {
            // Throttle by skipping equal consecutive values —
            // a redundant scroll handler can otherwise bounce
            // through the persistence layer at the browser's
            // scroll-event rate.
            const next = event.currentTarget.scrollTop;
            if (typeof next === "number") onScrollPersist(next);
          } : undefined}
          className="file-preview-body min-h-0 flex-1 overflow-auto"
          data-testid="file-preview-body-scroller"
        >
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
  onConfirmCredential,
}: {
  error: string;
  payload: FsFilePayload | null;
  fileName: string;
  path: string;
  locale: Locale;
  /**
   * Slice 16 — fired when the user clicks the "open anyway" button on
   * the credential refusal card. The parent re-fetches the file with
   * `confirmCredential: true` (server then releases the bytes). The
   * prop is optional so the existing call sites that don't want the
   * second confirmation still typecheck.
   */
  onConfirmCredential?: () => void;
}) {
  // The classification lives in lib/file-open-reason.ts so the
  // component does not re-implement the regex / prefix split. The
  // result also drives which buttons are enabled (the `actionsAvailable`
  // flag — false for out-of-bounds, where the OS opener cannot help).
  // Slice 16: pass the path so the classifier can also pick the
  // `credential` reason defensively if the server omits `code`.
  const unsupported = useMemo(
    () => classifyUnsupported(error, payload, path),
    [error, payload, path],
  );

  // Local state for the two actions that go through the OS opener:
  // which one is currently firing (so the spinner / disable lives on
  // the button, not on the whole panel), and which one last failed
  // (the panel renders the failure copy inline so a click never
  // silently no-ops).
  const [busy, setBusy] = useState<
    "open-default" | "reveal" | "open-anyway" | null
  >(null);
  const [failure, setFailure] = useState<{ key: "open-default" | "reveal"; message: string } | null>(null);
  // Disabled-by-server: when the server has already answered a previous
  // click with `code === "no-opener"`, we know the host cannot run the
  // action at all — the button stays disabled for the lifetime of this
  // open file, with the dedicated hint tooltip explaining why. Each
  // action carries its own disable flag: a server that can `reveal`
  // but not `open-default` (or vice versa) is possible on Linux
  // desktop distros where `xdg-open` is missing but the file manager
  // is still around. A "fresh" navigation to a different file clears
  // both flags back to enabled.
  const [disabledByServer, setDisabledByServer] = useState<{
    openDefault: boolean;
    reveal: boolean;
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
      // Guard each action independently. The earlier single check
      // (`openDefault || reveal`) blocked BOTH actions when only one
      // was disabled — the regression ticket called this out: an
      // open-default no-opener must not silence a still-working reveal.
      if (kind === "open-default" && disabledByServer.openDefault) return;
      if (kind === "reveal" && disabledByServer.reveal) return;
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
      // retry is still possible. Only the matching key flips — the
      // other action's disable state is preserved untouched.
      if (result.code === "no-opener") {
        setDisabledByServer((current) => ({
          ...current,
          [kind === "open-default" ? "openDefault" : "reveal"]: true,
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

  // Slice 16 — the credential override. The button is enabled only
  // when the classifier set `confirmable: true` (i.e. the server
  // emitted `code: "credential"`). The parent decides what to do
  // (re-fetch with the override flag); the component just surfaces
  // the click. The button lives next to the existing three actions
  // so the user does not need to scroll, and its label matches the
  // i18n copy (zh: "仍要打开", en: "Open anyway").
  const fireOpenAnyway = useCallback(() => {
    if (!unsupported.confirmable) return;
    if (!onConfirmCredential) return;
    setBusy("open-anyway");
    try {
      onConfirmCredential();
    } finally {
      // The parent owns the load() lifecycle — `busy` flips back when
      // the new payload arrives. We don't block on it here.
      setBusy((current) => (current === "open-anyway" ? null : current));
    }
  }, [unsupported.confirmable, onConfirmCredential]);

  // Slice 16 — credential sub-reason label. The panel substitutes it
  // into the reason copy via {{subReason}}; the helper returns "" when
  // the classifier did not pick a sub-reason, which falls back to the
  // generic "credential file" wording. The label is the localised
  // string (e.g. "env file" / "env 文件"), not the raw enum.
  const subReasonLabel =
    unsupported.reason === "credential"
      ? credentialSubReasonLabel(locale, unsupported.credentialSubReason)
      : "";

  const reasonText = reasonCopy(locale, unsupported.reason, {
    ...unsupported.params,
    // For the credential reason, override the raw enum with the
    // localised label so the {{subReason}} placeholder shows "env file"
    // / "env 文件" instead of "dotenv". The classifier owns the
    // enum; this layer owns the display string.
    ...(unsupported.reason === "credential"
      ? { subReason: subReasonLabel }
      : {}),
  });
  const language = payload?.language ?? "";

  // The hint copy the buttons render when disabled matches the
  // classifier, not the previous "no GUI opener" catch-all. Out of
  // bounds says "this path is outside the workspace"; no-opener
  // says "this environment has no GUI opener". Each reason gets its
  // own message so the user sees the actual reason for the dead
  // button.
  const disabledHintKey: "fileOpen.button.disabledHint.outOfBounds" | "fileOpen.button.disabledHint.noOpener" =
    unsupported.reason === "outOfBounds"
      ? "fileOpen.button.disabledHint.outOfBounds"
      : "fileOpen.button.disabledHint.noOpener";

  // Slice 16 — credential-specific copy. The detail line explains the
  // LAN-reachable rationale (so the user understands why we refuse by
  // default) and tells them the action is reversible only by reloading.
  const showCredentialActions = unsupported.reason === "credential";
  const credentialDetail = showCredentialActions
    ? tFileOpen(locale, "fileOpen.confirm.detail")
    : "";
  const credentialTitle = showCredentialActions
    ? tFileOpen(locale, "fileOpen.confirm.title")
    : "";

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-4 px-3 py-6 text-center text-text_default_secondary"
      data-testid="file-preview-error"
      data-reason={unsupported.reason}
    >
      {/* Centred header — the warning glyph + the title + the reason
          copy, all stacked and centred. The icon stays inline so the
          row keeps its visual rhythm; the wrap ensures the icon does
          not pull the text out of alignment. */}
      <div className="flex max-w-[260px] flex-col items-center gap-2">
        <span
          className="flex size-5 flex-shrink-0 items-center justify-center text-icon_default_secondary"
          aria-hidden
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
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
        <span
          className="text-sm font-medium text-text_default_primary"
          data-testid="file-preview-error-title"
        >
          {showCredentialActions && credentialTitle
            ? credentialTitle
            : tFileOpen(locale, "fileOpen.header.unsupported")}
        </span>
        <span
          className="text-caption-small-strong leading-5 text-text_default_secondary"
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
        {/* Slice 16 — credential-specific detail line. Explains the LAN
            rationale + reversibility, sits just below the reason so
            the user sees it before deciding to override. */}
        {showCredentialActions && credentialDetail ? (
          <span
            className="mt-1 max-w-[260px] text-caption-small-strong leading-5 text-text_default_tertiary"
            data-testid="file-preview-error-credential-detail"
          >
            {credentialDetail}
          </span>
        ) : null}
      </div>
      {/* Centred actions row — three buttons laid out in a wrap so the
          288px panel never overflows. The download action is always
          enabled (the browser handles the save directly through the
          `/api/fs/raw?download=1` URL), so the download button does
          not enter the disabled-by-server state. The other two are
          gated on the host's opener + file-manager availability.
          Slice 16 — for the credential reason, a fourth "open anyway"
          button is added that re-fetches the file with the explicit
          override flag. It is positioned first so the eye catches it
          immediately, with a stronger border so the override affordance
          is unmissable (reversibility is the headline of the user's
          decision; the button must look deliberate). */}
      <div
        className="flex flex-wrap items-center justify-center gap-2"
        data-testid="file-preview-error-actions"
      >
        {showCredentialActions ? (
          <button
            type="button"
            onClick={fireOpenAnyway}
            disabled={busy !== null || !onConfirmCredential}
            title={
              !onConfirmCredential
                ? tFileOpen(locale, "fileOpen.action.openAnyway.aria")
                : tFileOpen(locale, "fileOpen.action.openAnyway.aria")
            }
            aria-label={tFileOpen(locale, "fileOpen.action.openAnyway.aria")}
            data-testid="file-preview-error-open-anyway"
            className="flex h-7 items-center gap-1 rounded-[8px] border border-border_status_warning bg-bg_default_scrim px-2 text-caption-small-strong text-text_status_warning transition-colors hover:bg-bg_interaction_tertiary_hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-bg_default_scrim"
          >
            {busy === "open-anyway" ? (
              <span aria-hidden>…</span>
            ) : null}
            <span>{tFileOpen(locale, "fileOpen.action.openAnyway")}</span>
          </button>
        ) : null}
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
              ? tFileOpen(locale, disabledHintKey)
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
              ? tFileOpen(locale, disabledHintKey)
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
        <a
          // The download button is an anchor with the `download`
          // attribute — the browser saves the response locally
          // without leaving the panel. Same `/api/fs/raw` endpoint as
          // the image preview, gated by the same containment + size
          // cap. aria-disabled reflects the actionsAvailable flag:
          // out-of-bounds paths the server would 403, so the link
          // must not look clickable.
          //
          // Slice 16 — on a credential refusal, the URL carries
          // `confirm=1` so the server releases the bytes. Without
          // the flag the user would download the 403 JSON error
          // body, which is confusing AND a security smell (the
          // file is still on disk; we just gave them the gate's
          // error envelope instead). The credential refusal is
          // the user's explicit "I see this is sensitive" moment;
          // clicking download is the second confirmation.
          href={fsRawDownloadUrl(path, {
            confirm: unsupported.reason === "credential",
          })}
          download
          aria-disabled={!unsupported.actionsAvailable}
          aria-label={tFileOpen(locale, "fileOpen.action.download.aria")}
          title={tFileOpen(locale, "fileOpen.action.download.aria")}
          data-testid="file-preview-error-download"
          data-disabled-reason={
            !unsupported.actionsAvailable ? "out-of-bounds" : undefined
          }
          onClick={(event) => {
            // An `<a download>` on an out-of-bounds path would still
            // issue the GET (the browser does not know the URL is
            // gated). Stop the click when the classifier says the
            // path is unreachable.
            if (!unsupported.actionsAvailable) event.preventDefault();
          }}
          className={
            unsupported.actionsAvailable
              ? "flex h-7 items-center gap-1 rounded-[8px] border border-border_default bg-bg_default_scrim px-2 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
              : "flex h-7 cursor-not-allowed items-center gap-1 rounded-[8px] border border-border_default bg-bg_default_scrim px-2 text-caption-small-strong text-text_default_primary opacity-50"
          }
        >
          <span>{tFileOpen(locale, "fileOpen.action.download")}</span>
        </a>
      </div>
      {failure ? (
        <p
          className="max-w-[260px] rounded-[8px] bg-bg_grouped_tertiary px-2 py-1 text-caption-small-strong text-text_status_error"
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
  params: { mime?: string; error?: string; subReason?: string },
): string {
  switch (reason) {
    case "binary":
      return tFileOpen(locale, "fileOpen.reason.binary", params);
    case "oversize":
      return tFileOpen(locale, "fileOpen.reason.oversize", params);
    case "outOfBounds":
      return tFileOpen(locale, "fileOpen.reason.outOfBounds", params);
    case "credential":
      // The sub-reason is a localised label (e.g. "env file" / "私钥文件"),
      // not the raw enum; the classifier passes the raw enum via
      // `params.subReason`, the helper resolves it through the i18n
      // module when present. The empty-string fallback is intentional —
      // it leaves the sentence "credential file" readable, not
      // "( )".
      return tFileOpen(locale, "fileOpen.reason.credential", {
        ...params,
        subReason: params.subReason || "",
      });
    case "unknown":
    default:
      return tFileOpen(locale, "fileOpen.reason.unknown", params);
  }
}