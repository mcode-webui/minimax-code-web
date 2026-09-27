"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "@/lib/api";
import { Chat, HomeState } from "@/components/chat";
import { Composer } from "@/components/composer";
import { Modals } from "@/components/modals";
import { ActionErrorBanner } from "@/components/action-error-banner";
import { RightPanel, SettingsModal, type PanelKind } from "@/components/panels";
import { AppShell } from "@/components/shell";
import { ConversationToolbar, useAlertCount } from "@/components/toolbar";
import { runAction } from "@/lib/action-errors";
import { SessionProvider, useSessionContext } from "@/lib/store";
import { decodeTranscript } from "@/lib/transcript";
import { useLocale } from "@/lib/use-locale";
import {
  DEFAULT_UI_STATE,
  readScrollPosition,
  readUiState,
  writeScrollPosition,
  writeUiState,
  type UiState,
} from "@/lib/persist";
import {
  applySessionRestore,
  dropSessionFromUrl,
  parseSessionFromUrl,
  writeSessionToUrl,
  type SessionRestoreOutcome,
} from "@/lib/url-restore";
import { openFileInWeb } from "@/lib/open-file";

/**
 * The application root.
 *
 * `SessionProvider` owns the single SSE subscription; the shell, the toolbar, the
 * transcript and the panels all read the same snapshot from context, so no
 * component opens its own connection.
 */
export default function Page() {
  return (
    <SessionProvider>
      <App />
    </SessionProvider>
  );
}

function App() {
  const { locale, setLocale, t } = useLocale();
  const { state, connected, error } = useSessionContext();
  // Webui-parity 07 — restore UI state synchronously from localStorage
  // BEFORE the first paint, so a refresh on /?session=A lands on the
  // same right-panel / sidebar collapsed choice the user previously
  // had open rather than flashing the default first.
  //
  // The initializer runs only on the first render; the effect below
  // mirrors any in-memory change back into storage.
  const [persisted] = useState<UiState>(() => readUiState());
  // Right panel open/closed + which kind. Seeded from `persisted.panel`.
  const [panel, setPanel] = useState<PanelKind | null>(persisted.panel);
  // Settings is a dialog rather than a drawer panel, so it has its own state.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The section the modal should land on. The modal owns its own
  // `active` state for ordinary navigation; this external value seeds
  // that state only on open transitions (see SettingsModal below) so
  // a deep-link from outside the modal still works.
  const [settingsSection, setSettingsSection] = useState<"general" | "appearance" | "connection" | "providers">("general");
  // One-shot flag consumed by ProviderManagementPanel. When true,
  // the management panel fires its `addProvider()` callback on mount,
  // so the user lands in Settings → Providers with a fresh draft
  // and the id input focused. Cleared after consumption so a later
  // open (e.g. from the sidebar) does not re-fire.
  const [pendingProviderAdd, setPendingProviderAdd] = useState(false);
  // URL-restore hint: when the URL names a session id the server no
  // longer has, we briefly surface this banner before clearing the
  // URL. Self-dismisses after a few seconds and on user dismiss.
  const [sessionHint, setSessionHint] = useState<{ kind: "not-found"; sessionId: string } | null>(null);
  const alertCount = useAlertCount();

  // Mirror panel changes into localStorage. The write helper is
  // debounced; mounting/de-mounting the panel quickly during a
  // refresh never floods storage.
  useEffect(() => {
    writeUiState({
      ...DEFAULT_UI_STATE,
      ...persisted,
      panel,
    });
    // intentionally not adding `persisted` to deps — the persist
    // module already guards the debounced write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel]);

  // Drawer panels are opened from the toolbar and the sidebar's nav rows; the two
  // entry points share this one piece of state so they cannot disagree.
  const openPanel = useCallback((kind: PanelKind) => {
    setPanel((current) => (current === kind ? null : kind));
  }, []);

  const openSettings = useCallback(() => {
    setSettingsSection("general");
    setPendingProviderAdd(false);
    setSettingsOpen(true);
  }, []);

  /**
   * Open the settings modal directly on the providers section, with
   * the management panel's add flow armed.
   *
   * Triggered by the model selector's top "Add provider" row. The
   * flag is one-shot — the panel reads it on its mount and clears it,
   * so re-opening the settings modal from the sidebar does not
   * re-fire the add. The state lives at page scope (rather than on
   * the modal) so a deep-link from anywhere — model selector, a
   * future "add from empty catalogue" affordance — all funnel through
   * the same path.
   */
  const openProviderAdd = useCallback(() => {
    setSettingsSection("providers");
    setPendingProviderAdd(true);
    setSettingsOpen(true);
  }, []);

  // Single-source "open.file.in.web" — fired from the turn summary's
  // file paths (`ActivityGroup` → `ToolCard` in `components/chat.tsx`).
  // The action in `lib/open-file.ts` is also called from the file tree
  // (`components/panels.tsx#FileRow`); both entry points converge on the
  // same `FilePreviewPane`. When the right panel is closed we open it
  // here so the user actually sees the preview they triggered — the
  // pane only renders inside `FilesPanel`.
  const onOpenFile = useCallback((path: string) => {
    openFileInWeb(path);
    setPanel((current) => (current === "files" ? current : "files"));
  }, []);

  // Ctrl+N / Ctrl+K mirror the shortcuts the sidebar advertises. Ctrl+N is only
  // bound when the shell is mounted (i.e. a session exists), matching the
  // affordance being visible.
  useEffect(() => {
    if (!state) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        // Same path as the sidebar's 新建会话 row: one action, one error surface.
        // This used to swallow the rejection, so a failed create looked like a
        // dead button.
        void runAction(t("topbar.newSession"), api.newSession());
      } else if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        openPanel("search");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, openPanel, t]);

  // URL ↔ session reconcile (webui-parity 07).
  //
  // Three triggers, all funneled through one helper so the URL grammar
  // lives in `lib/url-restore.ts` and not here:
  //
  //   1. Cold load — read `?session=` once, call switchSession if the
  //      SSE-active id disagrees.
  //   2. SSE-driven active change — the user picked a new session from
  //      the sidebar; keep the URL in sync via `replaceState` so a
  //      refresh lands them back in the same place.
  //   3. popstate (back / forward) — re-run the cold-load path.
  //
  // Server wins: any time the SSE snapshot disagrees with the URL
  // because the server itself switched off (e.g. cid key rotation),
  // the URL is rewritten to match the server and the local hint
  // banner clears.
  const [urlRestored, setUrlRestored] = useState(false);
  const lastAppliedRef = useRef<string | null>(null);
  const urlSession = typeof window !== "undefined" ? parseSessionFromUrl() : null;

  // Cold-load restore. Reads the URL once, fires `switchSession` if
  // the SSE snapshot's active id disagrees. Subsequent SSE frames do
  // NOT re-trigger this — the active-session effect below is a
  // one-way URL write that runs only on a change from the server.
  useEffect(() => {
    if (urlRestored) return;
    if (!state) return;
    if (!urlSession) {
      setUrlRestored(true);
      return;
    }
    if (state.mcodeSessionId === urlSession) {
      // Already on the requested session — adopt it and write the
      // active id back to the URL (no-op when already correct).
      lastAppliedRef.current = state.mcodeSessionId;
      writeSessionToUrl(state.mcodeSessionId);
      setUrlRestored(true);
      return;
    }
    let cancelled = false;
    void applySessionRestore(urlSession, state.mcodeSessionId ?? null).then((outcome: SessionRestoreOutcome) => {
      if (cancelled) return;
      if (outcome.status === "ok" || outcome.status === "no-op") {
        lastAppliedRef.current = urlSession;
      } else {
        // not-found / error: the requested session is gone — surface a
        // brief hint and clear the URL so a refresh does not loop.
        setSessionHint({ kind: "not-found", sessionId: urlSession });
        dropSessionFromUrl();
        // self-dismiss after 6s; the user can also dismiss manually.
        window.setTimeout(() => {
          setSessionHint((current) => (current && current.sessionId === urlSession ? null : current));
        }, 6000);
      }
      setUrlRestored(true);
    });
    return () => {
      cancelled = true;
    };
  }, [state, urlSession, urlRestored]);

  // Authoritative-session effect: once SSE says the active session is
  // X, mirror X into the URL. Does nothing when the URL already
  // matches, so a refresh that already restored X is a no-op here.
  // We deliberately use `?? urlSession` so a null active session
  // clears the URL on the next SSR-rendered page.
  useEffect(() => {
    if (!urlRestored) return;
    const active = state?.mcodeSessionId ?? null;
    if (active === lastAppliedRef.current && active === urlSession) return;
    if (active !== lastAppliedRef.current) {
      lastAppliedRef.current = active;
    }
    writeSessionToUrl(active);
    // intentionally narrow dep so a swap-after-restore writes the URL
    // through even though `urlRestored` already settled.
  }, [state?.mcodeSessionId, urlSession, urlRestored]);

  // Track the latest active session id in localStorage so the next
  // cold-load (no `?session=` in the URL) has a hint for what to land
  // on. The SSE snapshot is the source of truth — this is only the
  // cache.
  useEffect(() => {
    if (!urlRestored) return;
    const active = state?.mcodeSessionId ?? null;
    writeUiState({
      ...DEFAULT_UI_STATE,
      ...persisted,
      panel,
      lastSessionId: active,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.mcodeSessionId, urlRestored]);

  // Back / forward reconcile — re-run the cold-load path on popstate.
  useEffect(() => {
    const onPop = () => {
      // Force the cold-load path to re-evaluate; the URL alone is what
      // matters here, so resetting the latch is sufficient.
      setUrlRestored(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Upstream shows a centred three-dot loader while the renderer waits for its
  // first state push; same treatment here.
  if (!state) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-bg_grouped_secondary text-text_default_secondary">
        <span className="mavis-loading">
          <span className="mavis-dot mavis-dot-a" />
          <span className="mavis-dot mavis-dot-b" />
          <span className="mavis-dot mavis-dot-c" />
        </span>
        <p className="text-caption-small-strong">
          {connected || !error ? t("app.connecting") : t("app.disconnected")}
        </p>
      </div>
    );
  }

  // Upstream pins the composer to the bottom only once a conversation exists; on
  // the home screen it sits inline under the greeting.
  const hasConversation = decodeTranscript(state.chat).length > 0;

  return (
    <>
      <AppShell
        t={t}
        toolbar={
          hasConversation ? (
            <ConversationToolbar
              t={t}
              onOpenWorkspace={() => openPanel("workspace")}
              onOpenFiles={() => openPanel("files")}
              onOpenGit={() => openPanel("git")}
              activePanel={panel === "workspace" || panel === "files" || panel === "git" ? panel : null}
            />
          ) : null
        }
        panel={panel ? <RightPanel kind={panel} onClose={() => setPanel(null)} t={t} locale={locale} /> : null}
        onOpenPanel={openPanel}
        onOpenSettings={openSettings}
        alertCount={alertCount}
      >
        {hasConversation ? (
          <>
            <ScrollRestoredChat
              t={t}
              locale={locale}
              sessionId={state.mcodeSessionId ?? null}
              onOpenFile={onOpenFile}
            />
            <Composer t={t} onAddProvider={openProviderAdd} />
          </>
        ) : (
          <HomeState t={t} locale={locale}>
            <Composer t={t} inline onAddProvider={openProviderAdd} />
          </HomeState>
        )}
      </AppShell>
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        t={t}
        locale={locale}
        setLocale={setLocale}
        initialSection={settingsSection}
        autoAddProvider={pendingProviderAdd}
        onAutoAddConsumed={() => setPendingProviderAdd(false)}
      />
      {sessionHint ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="session-hint-banner"
          className="fixed bottom-4 left-1/2 z-[1100] flex max-w-[560px] -translate-x-1/2 items-center gap-3 rounded-[10px] border border-border_default bg-bg_default_scrim px-4 py-3 text-sm text-text_default_primary shadow-shadow_default"
        >
          <span className="flex-1">{t("session.hint.notFound")}</span>
          <button
            type="button"
            onClick={() => {
              setSessionHint(null);
              if (typeof window !== "undefined") {
                // Same effect as the auto-dismiss: clear `?session=`
                // so the next refresh starts at home.
                dropSessionFromUrl();
              }
            }}
            className="h-7 rounded-[8px] border border-border_default px-3 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
          >
            {t("session.hint.notFound.dismiss")}
          </button>
        </div>
      ) : null}
      <ActionErrorBanner t={t} />
      <Modals t={t} />
    </>
  );
}

/**
 * Webui-parity 07 — a small wrapper around `<Chat>` that reads /
 * writes the per-session scroll position. The scroll key is keyed
 * per (cid, sessionId) so two tabs on different sessions do not
 * clobber each other. The wrapper exists so the page-level
 * `state.mcodeSessionId` value drives both the read and the write,
 * which lets `Chat` stay focused on rendering.
 *
 * The wrapper passes `sessionKey` (NOT just `initialScrollTop`) so
 * Chat re-reads the saved position on every active-session change.
 * Otherwise a cold-load sequence (page mounts with `state=null`
 * first, SSE delivers the active session later) would capture `0`
 * on Chat's useState initializer and never restore.
 */
function ScrollRestoredChat({
  t,
  locale,
  sessionId,
  onOpenFile,
}: {
  t: (key: import("@/lib/i18n").MessageKey) => string;
  locale: import("@/lib/i18n").Locale;
  sessionId: string | null;
  onOpenFile?: (path: string) => void;
}) {
  const initial = sessionId ? readScrollPosition(sessionId) : 0;
  return (
    <Chat
      t={t}
      locale={locale}
      sessionKey={sessionId}
      initialScrollTop={initial}
      onScrollPersist={(top) => {
        if (!sessionId) return;
        writeScrollPosition(sessionId, top);
      }}
      onOpenFile={onOpenFile}
    />
  );
}
