"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Locale, MessageKey } from "@/lib/i18n";
import {
  fsRawUrl,
  fsRawDownloadUrl,
  getFsFile,
  openFileWithDefault,
  revealInFileManager,
  saveFsFile,
  type FileOpenResult,
  type FsFilePayload,
  type FsSaveResult,
} from "@/lib/api";
import { renderMarkdown } from "@/lib/markdown";
import "@/lib/mermaid-renderer"; // registers the mermaid language renderer
import { MarkdownHtml } from "@/components/markdown-html";
import { CodeView as IdeCodeView } from "@/components/code-view";
import {
  basenameOf,
  formatBytes,
  pickPreviewKind,
  type PreviewKind,
} from "@/lib/file-preview";
import {
  canEditPreview,
  editRequiresCredentialConfirm,
  formatSaveClock,
} from "@/lib/preview-edit";
import { MarkdownToc } from "@/components/markdown-toc";
import { tPreviewToolbar } from "@/lib/i18n-preview-toolbar";
import {
  classifyUnsupported,
  type UnsupportedReason,
} from "@/lib/file-open-reason";
import {
  credentialSubReasonLabel,
  tFileOpen,
} from "@/lib/i18n-file-open";

/**
 * File preview (slice 02 of the webui-parity program, slices 15/16/22
 * upgrades, slice 27 toolbar).
 *
 * A viewer + (slice 27) editor that the right-hand `files` panel opens
 * on click. It is a small type→renderer router over
 * `/api/fs/read-file` (text, ≤512 KiB) and `/api/fs/raw` (bytes,
 * ≤20 MiB).
 *
 * Routing rules — what gets which renderer:
 *   `.md` / `.markdown`   rendered markdown (via lib/markdown.ts) with
 *                          the outline panel (slice 27)
 *   image extensions      <img src="/api/fs/raw?path=…">
 *   source / data files    IDE-grade preview (gutter + line numbers +
 *                          syntax highlighting + copy) — see
 *                          `components/code-view.tsx`.
 *   anything else         "无法预览" placeholder
 *
 * Toolbar (slice 27, every preview header):
 *   ↻  refresh     — re-read from disk, keep the scroll position, keep
 *                    the panel open. A failed refresh keeps the last
 *                    content and shows an explicit banner (a deleted
 *                    file is named, never a silent blank).
 *   预览/编辑       — flip the text preview into a plain editor
 *                    (markdown + code kinds only). Credential-shaped
 *                    paths (the slice-16 predicate) must pass an
 *                    explicit confirmation card first; the SERVER
 *                    re-checks on every save.
 *   ✓  save        — edit mode only. Never automatic. The save carries
 *                    the (mtime, size) baseline recorded at load; a
 *                    changed disk answers a conflict card (overwrite /
 *                    reload) instead of a silent overwrite. Failures
 *                    keep the buffer and state the reason.
 *
 * Containment: every fetch hits the server's shared `assertWorkspacePath`
 * gate, and the save endpoint runs the SAME gate — the write path adds
 * no escape surface.
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

/** The disk state an editor buffer was seeded from. */
interface EditBaseline {
  content: string;
  mtime?: number;
  size?: number;
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
  // Slice 27 — toolbar state.
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<
    { kind: "saved"; at: string } | { kind: "error"; message: string } | null
  >(null);
  const [conflict, setConflict] = useState<{ diskMtime: number; diskSize: number } | null>(null);
  const [showCredentialGate, setShowCredentialGate] = useState(false);
  const [credentialConfirmed, setCredentialConfirmed] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // Ref to the inner scrollable container — `.file-preview-body`.
  // The outer wrapper does NOT scroll (the wrapper's `overflow`
  // is `hidden`); only this inner div scrolls, so the scroll
  // handler belongs here.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const restoredRef = useRef<boolean>(false);
  // The baseline the editor's buffer was seeded from. Updated on every
  // successful load AND every successful save (the fresh pair the
  // server returns). NOT updated by a refresh while a dirty draft
  // exists — the draft's origin is what a save must conflict-check
  // against (see the refresh handler).
  const baselineRef = useRef<EditBaseline | null>(null);

  // Last-write-wins: a quick `a → b → a` switch (e.g. user clicks through
  // the tree) should not let the older `a` payload land after the newer
  // `b`. The FilesPanel uses the same trick — keeping the discipline
  // uniform across panels makes the regression case obvious.
  const loadGen = useMemo(() => ({ current: 0 }), []);

  const resetToolbarState = useCallback(() => {
    setMode("preview");
    setDraft(null);
    setSaving(false);
    setSaveFeedback(null);
    setConflict(null);
    setShowCredentialGate(false);
    setCredentialConfirmed(false);
    setRefreshError(null);
    baselineRef.current = null;
  }, []);

  const load = useCallback(
    async (opts: { confirmCredential?: boolean; isRefresh?: boolean } = {}) => {
      const gen = ++loadGen.current;
      setLoading(true);
      if (opts.isRefresh) setRefreshError(null);
      else setError(null);
      // A refresh preserves the scroll position across the re-render
      // (ticket A1: 不丢滚动位置). Capture before the await; restore
      // after the new content has had a frame to lay out.
      const scrollTop = opts.isRefresh ? bodyRef.current?.scrollTop ?? 0 : null;
      try {
        const next = await getFsFile(path, {
          confirmCredential: opts.confirmCredential === true,
        });
        if (gen !== loadGen.current) return;
        if (!next.ok) {
          if (opts.isRefresh) {
            // Honesty on refresh (ticket A1): keep the last content on
            // screen and NAME the failure — a deleted / moved file is a
            // banner, never a silent blank.
            setRefreshError(next.error ?? "unreadable");
          } else {
            setPayload(next);
            setError(next.error ?? "unreadable");
          }
          return;
        }
        setPayload(next);
        setError(null);
        // The baseline follows the fresh read only when no dirty draft
        // is open — a dirty draft keeps its origin baseline so a later
        // save still conflict-checks against the version it was seeded
        // from (an external edit must surface as a conflict, never be
        // silently absorbed by a refresh).
        if (draft === null || draft === baselineRef.current?.content) {
          baselineRef.current = {
            content: next.content ?? "",
            mtime: next.mtime,
            size: next.size,
          };
        }
        if (opts.isRefresh && scrollTop !== null) {
          requestAnimationFrame(() => {
            const node = bodyRef.current;
            if (node) node.scrollTop = scrollTop;
          });
        }
      } catch (cause) {
        if (gen !== loadGen.current) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        if (opts.isRefresh) setRefreshError(message);
        else {
          setError(message);
          setPayload(null);
        }
      } finally {
        if (gen === loadGen.current) setLoading(false);
      }
    },
    [path, loadGen, draft],
  );

  useEffect(() => {
    resetToolbarState();
    void load();
    // load identity changes with `draft` (baseline bookkeeping); the
    // initial read must run once per path, hence the separate effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Restore the persisted scroll position. The restore fires
  // once per mount / file switch: after the body has had a chance
  // to render its inner content (the file-preview-body div's
  // `scrollHeight` only settles once the async `load()` resolves
  // and `kind` resolves to a known renderer), we apply the
  // persisted offset.
  //
  // The effect deliberately does NOT depend on `initialScrollTop`.
  // That prop is LIVE: the file-tab wiring feeds every scroll back
  // through `onScrollPersist` → reducer → props, so a smooth scroll
  // (an outline jump, `scrollIntoView({behavior:"smooth"})`) updates
  // it mid-flight — the first scroll event lands the animation's
  // interim offset (24px, say) in the prop, and an effect keyed on
  // it would re-run and write that offset back to `scrollTop`,
  // killing the animation at 24px instead of the target heading
  // (the acceptance-run regression this slice 27 fix pins). The
  // mount-time value is captured by this effect's closure instead:
  // the effect only runs for a `path` change, and the render that
  // carries a new `path` carries the tab's persisted offset.
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
    requestAnimationFrame(apply);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see the
    // block comment above: re-running on initialScrollTop re-arms the
    // restore mid-scroll and aborts smooth jumps.
  }, [path]);

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

  // --- slice 27 toolbar handlers -----------------------------------------

  const editable = canEditPreview(kind) && !!payload?.ok;
  const dirty = draft !== null && draft !== baselineRef.current?.content;

  const enterEdit = useCallback(() => {
    if (!editable) return;
    if (editRequiresCredentialConfirm(path) && !credentialConfirmed) {
      // Write-side credential gate (ticket C2): default-refuse editing,
      // explicit confirm card — same posture as the slice-16 preview
      // guard, same predicate, and the server re-checks on save.
      setShowCredentialGate(true);
      return;
    }
    setDraft(baselineRef.current?.content ?? payload?.content ?? "");
    setMode("edit");
    setConflict(null);
    setSaveFeedback(null);
  }, [editable, path, credentialConfirmed, payload]);

  const exitEdit = useCallback(() => {
    // The draft is deliberately KEPT: switching to preview is a view
    // change, not a discard — switching back returns the buffer, and a
    // failed save never destroys what the user typed.
    setMode("preview");
    setConflict(null);
  }, []);

  const performSave = useCallback(
    async (opts: { explicitOverwrite?: boolean } = {}) => {
      if (draft === null || saving) return;
      const baseline = baselineRef.current;
      setSaving(true);
      setSaveFeedback(null);
      let result: FsSaveResult;
      try {
        result = await saveFsFile(path, draft, {
          expectedMtime: opts.explicitOverwrite ? undefined : baseline?.mtime,
          expectedSize: opts.explicitOverwrite ? undefined : baseline?.size,
          confirmCredential: editRequiresCredentialConfirm(path),
        });
      } catch (cause) {
        result = {
          ok: false,
          code: "write-failed",
          error: cause instanceof Error ? cause.message : String(cause),
        };
      } finally {
        setSaving(false);
      }
      if (result.ok) {
        // Adopt the saved state: the visible preview re-renders from the
        // saved bytes and the next save conflicts against the fresh pair.
        const nextPayload: FsFilePayload = { ...payload, ok: true, content: draft, size: result.size, mtime: result.mtime };
        setPayload(nextPayload);
        baselineRef.current = {
          content: draft,
          mtime: result.mtime,
          size: result.size,
        };
        setConflict(null);
        setSaveFeedback({ kind: "saved", at: formatSaveClock(new Date()) });
        setMode("preview");
        return;
      }
      if (result.code === "conflict") {
        // Ticket C3: prompt, never overwrite. The buffer stays; the card
        // offers both explicit resolutions.
        setConflict({
          diskMtime: result.diskMtime ?? 0,
          diskSize: result.diskSize ?? 0,
        });
        return;
      }
      setSaveFeedback({
        kind: "error",
        message: result.error ?? result.code ?? "unknown error",
      });
    },
    [draft, saving, path, payload],
  );

  const loadDiskVersion = useCallback(() => {
    // The conflict card's second exit: drop the buffer, re-read from
    // disk. The card copy already states this discards the user's edit,
    // so the click is the explicit decision.
    setDraft(null);
    setConflict(null);
    setSaveFeedback(null);
    void load({ isRefresh: true });
    setMode("preview");
  }, [load]);

  // -----------------------------------------------------------------------

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col gap-2"
      data-testid="file-preview"
      data-path={path}
      data-preview-mode={mode}
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
        {/* Slice 27 toolbar. Refresh is always available; the edit
            toggle appears for text previews; save exists only in edit
            mode (never automatic). All buttons carry aria-labels. */}
        <div
          className="flex flex-none items-center gap-1"
          data-testid="file-preview-toolbar"
          role="toolbar"
          aria-label={tPreviewToolbar(locale, "previewToolbar.toolbar.aria")}
        >
          <button
            type="button"
            onClick={() => void load({ isRefresh: true })}
            disabled={loading}
            aria-label={tPreviewToolbar(locale, "previewToolbar.refresh.aria")}
            title={tPreviewToolbar(locale, "previewToolbar.refresh.aria")}
            data-testid="file-preview-refresh"
            className="flex size-6 items-center justify-center rounded-[6px] text-icon_default_secondary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
              <path
                d="M13.8 1.8v2.7h-2.7"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {editable ? (
            <>
              <button
                type="button"
                onClick={mode === "preview" ? enterEdit : exitEdit}
                aria-label={
                  mode === "preview"
                    ? tPreviewToolbar(locale, "previewToolbar.edit.aria")
                    : tPreviewToolbar(locale, "previewToolbar.preview.aria")
                }
                title={
                  mode === "preview"
                    ? tPreviewToolbar(locale, "previewToolbar.edit.aria")
                    : tPreviewToolbar(locale, "previewToolbar.preview.aria")
                }
                aria-pressed={mode === "edit"}
                data-testid="file-preview-mode-toggle"
                data-mode={mode}
                className="flex h-6 items-center gap-1 rounded-[6px] border border-border_default px-1.5 text-caption-small-strong text-text_default_secondary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary"
              >
                <span>
                  {mode === "preview"
                    ? tPreviewToolbar(locale, "previewToolbar.edit")
                    : tPreviewToolbar(locale, "previewToolbar.preview")}
                </span>
              </button>
              {mode === "edit" ? (
                <button
                  type="button"
                  onClick={() => void performSave()}
                  disabled={!dirty || saving}
                  aria-label={tPreviewToolbar(locale, "previewToolbar.save.aria")}
                  title={tPreviewToolbar(locale, "previewToolbar.save.aria")}
                  data-testid="file-preview-save"
                  data-dirty={dirty ? "true" : "false"}
                  className="flex h-6 items-center gap-1 rounded-[6px] border border-border_default px-1.5 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path
                      d="M2.5 8.5l3.5 3.5 7.5-8"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span>{tPreviewToolbar(locale, "previewToolbar.save")}</span>
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </header>

      {/* Slice 27 — refresh honesty: a failed refresh keeps the last
          content and names the failure; the deleted-file case is called
          out explicitly (ticket A1). */}
      {refreshError ? (
        <div
          className="rounded-[8px] border border-border_status_warning bg-bg_default_scrim px-2 py-1.5 text-caption-small-strong text-text_status_warning"
          data-testid="file-preview-refresh-error"
          role="status"
        >
          <p>{tPreviewToolbar(locale, "previewToolbar.refreshFailed", { error: refreshError })}</p>
          <p className="mt-0.5 opacity-80">{tPreviewToolbar(locale, "previewToolbar.fileGone")}</p>
        </div>
      ) : null}

      {/* Slice 27 — save feedback. Success states the clock time;
          failure keeps the buffer (always — the draft is only cleared
          by an explicit action) and states the server's reason. */}
      {saveFeedback ? (
        <p
          className={
            saveFeedback.kind === "saved"
              ? "rounded-[8px] bg-bg_grouped_secondary_elevated px-2 py-1 text-caption-small-strong text-text_default_secondary"
              : "rounded-[8px] border border-border_status_error bg-bg_default_scrim px-2 py-1 text-caption-small-strong text-text_status_error"
          }
          data-testid="file-preview-save-feedback"
          data-feedback-kind={saveFeedback.kind}
          role="status"
        >
          {saveFeedback.kind === "saved"
            ? tPreviewToolbar(locale, "previewToolbar.savedAt", { time: saveFeedback.at })
            : tPreviewToolbar(locale, "previewToolbar.saveFailed", { error: saveFeedback.message })}
        </p>
      ) : null}

      {/* Slice 27 — write-side credential gate. Same posture as the
          slice-16 preview guard: default-refuse, explicit override, the
          server re-checks on save. */}
      {showCredentialGate ? (
        <div
          className="rounded-[10px] border border-border_status_warning bg-bg_default_scrim px-3 py-2.5"
          data-testid="file-preview-credential-gate"
        >
          <p className="text-sm font-medium text-text_default_primary">
            {tPreviewToolbar(locale, "previewToolbar.credential.title")}
          </p>
          <p className="mt-1 text-caption-small-strong leading-5 text-text_default_secondary">
            {tPreviewToolbar(locale, "previewToolbar.credential.detail", { name: fileName })}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setCredentialConfirmed(true);
                setShowCredentialGate(false);
                setDraft(baselineRef.current?.content ?? payload?.content ?? "");
                setMode("edit");
              }}
              className="flex h-7 items-center rounded-[8px] border border-border_status_warning px-2 text-caption-small-strong text-text_status_warning transition-colors hover:bg-bg_interaction_tertiary_hover"
              data-testid="file-preview-credential-edit-anyway"
            >
              {tPreviewToolbar(locale, "previewToolbar.credential.editAnyway")}
            </button>
            <button
              type="button"
              onClick={() => setShowCredentialGate(false)}
              className="flex h-7 items-center rounded-[8px] border border-border_default px-2 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
              data-testid="file-preview-credential-cancel"
            >
              {tPreviewToolbar(locale, "previewToolbar.credential.cancel")}
            </button>
          </div>
        </div>
      ) : null}

      {/* Slice 27 — external-modification conflict. The save stopped;
          nothing was written. Both exits are explicit. */}
      {conflict ? (
        <div
          className="rounded-[10px] border border-border_status_warning bg-bg_default_scrim px-3 py-2.5"
          data-testid="file-preview-conflict"
        >
          <p className="text-sm font-medium text-text_default_primary">
            {tPreviewToolbar(locale, "previewToolbar.conflict.title")}
          </p>
          <p className="mt-1 text-caption-small-strong leading-5 text-text_default_secondary">
            {tPreviewToolbar(locale, "previewToolbar.conflict.detail", {
              time: formatSaveClock(new Date(conflict.diskMtime || Date.now())),
              size: conflict.diskSize,
            })}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void performSave({ explicitOverwrite: true })}
              disabled={saving}
              className="flex h-7 items-center rounded-[8px] border border-border_status_warning px-2 text-caption-small-strong text-text_status_warning transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50"
              data-testid="file-preview-conflict-overwrite"
            >
              {tPreviewToolbar(locale, "previewToolbar.conflict.overwrite")}
            </button>
            <button
              type="button"
              onClick={loadDiskVersion}
              className="flex h-7 items-center rounded-[8px] border border-border_default px-2 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
              data-testid="file-preview-conflict-reload"
            >
              {tPreviewToolbar(locale, "previewToolbar.conflict.reload")}
            </button>
          </div>
        </div>
      ) : null}

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
            const next = event.currentTarget.scrollTop;
            if (typeof next === "number") onScrollPersist(next);
          } : undefined}
          className="file-preview-body min-h-0 flex-1 overflow-auto"
          data-testid="file-preview-body-scroller"
        >
          {mode === "edit" && draft !== null ? (
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
              aria-label={tPreviewToolbar(locale, "previewToolbar.editorAria")}
              data-testid="file-preview-editor"
              className="file-preview-editor h-full min-h-[240px] w-full resize-none"
            />
          ) : showImage ? (
            <ImageView path={path} />
          ) : (
            <PreviewBody kind={kind as PreviewKind} payload={payload} path={path} t={t} locale={locale} />
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
  t,
  locale,
}: {
  kind: PreviewKind;
  payload: FsFilePayload;
  path: string;
  t: (key: MessageKey) => string;
  locale: Locale;
}) {
  switch (kind) {
    case "markdown":
      return <MarkdownView content={payload.content ?? ""} locale={locale} />;
    case "image":
      return <ImageView path={path} />;
    case "code":
      // Slice 22 — delegate to the IDE-grade renderer.
      return (
        <IdeCodeView
          content={payload.content ?? ""}
          language={payload.language ?? "plain"}
          size={payload.size}
          t={t}
          locale={locale}
        />
      );
    default:
      // pickPreviewKind() never returns "unsupported" today; kept as an
      // escape hatch so the call-site exhaustiveness check stays honest.
      return <UnsupportedView fileName={basenameOf(path)} />;
  }
}

function MarkdownView({ content, locale }: { content: string; locale: Locale }) {
  // renderMarkdown() sanitises the parsed HTML on the browser side (see
  // lib/markdown.ts#sanitize) — the same policy used by chat.tsx for
  // assistant output. Reusing it keeps the threat model and allow-list
  // identical across surfaces.
  //
  // Slice 23 — the markdown is not injected directly; MarkdownHtml
  // converts the sanitised HTML to a React tree and mounts the mermaid
  // components. Slice 27 — the outline panel (components/markdown-toc)
  // walks THAT rendered DOM, so the outline lists what the page shows;
  // heading ids are assigned on those very nodes for the anchor jumps.
  const html = useMemo(() => renderMarkdown(content), [content]);
  const hostRef = useRef<HTMLDivElement | null>(null);
  return (
    <div className="flex min-h-0 w-full items-start gap-3" data-testid="file-preview-markdown-row">
      <div
        ref={hostRef}
        className="file-preview-markdown min-w-0 flex-1"
        data-testid="file-preview-markdown"
      >
        <MarkdownHtml html={html} />
      </div>
      <MarkdownToc contentRef={hostRef} renderKey={html} locale={locale} />
    </div>
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
   * `confirmCredential: true` (server then releases the bytes).
   */
  onConfirmCredential?: () => void;
}) {
  // The classification lives in lib/file-open-reason.ts so the
  // component does not re-implement the regex / prefix split.
  const unsupported = useMemo(
    () => classifyUnsupported(error, payload, path),
    [error, payload, path],
  );

  const [busy, setBusy] = useState<
    "open-default" | "reveal" | "open-anyway" | null
  >(null);
  const [failure, setFailure] = useState<{ key: "open-default" | "reveal"; message: string } | null>(null);
  const [disabledByServer, setDisabledByServer] = useState<{
    openDefault: boolean;
    reveal: boolean;
  }>({ openDefault: false, reveal: false });

  useEffect(() => {
    setBusy(null);
    setFailure(null);
    setDisabledByServer({ openDefault: false, reveal: false });
  }, [path]);

  const fireAction = useCallback(
    async (kind: "open-default" | "reveal") => {
      if (!unsupported.actionsAvailable) return;
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

  const fireOpenAnyway = useCallback(() => {
    if (!unsupported.confirmable) return;
    if (!onConfirmCredential) return;
    setBusy("open-anyway");
    try {
      onConfirmCredential();
    } finally {
      setBusy((current) => (current === "open-anyway" ? null : current));
    }
  }, [unsupported.confirmable, onConfirmCredential]);

  const subReasonLabel =
    unsupported.reason === "credential"
      ? credentialSubReasonLabel(locale, unsupported.credentialSubReason)
      : "";

  const reasonText = reasonCopy(locale, unsupported.reason, {
    ...unsupported.params,
    ...(unsupported.reason === "credential"
      ? { subReason: subReasonLabel }
      : {}),
  });
  const language = payload?.language ?? "";

  const disabledHintKey: "fileOpen.button.disabledHint.outOfBounds" | "fileOpen.button.disabledHint.noOpener" =
    unsupported.reason === "outOfBounds"
      ? "fileOpen.button.disabledHint.outOfBounds"
      : "fileOpen.button.disabledHint.noOpener";

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
        {showCredentialActions && credentialDetail ? (
          <span
            className="mt-1 max-w-[260px] text-caption-small-strong leading-5 text-text_default_tertiary"
            data-testid="file-preview-error-credential-detail"
          >
            {credentialDetail}
          </span>
        ) : null}
      </div>
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
      <span data-testid="file-preview-error-filename" hidden>
        {fileName}
      </span>
    </div>
  );
}

/**
 * Resolve the user-facing reason copy through the slice-14 i18n module.
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
      return tFileOpen(locale, "fileOpen.reason.credential", {
        ...params,
        subReason: params.subReason || "",
      });
    case "unknown":
    default:
      return tFileOpen(locale, "fileOpen.reason.unknown", params);
  }
}
