"use client";

import { useCallback, useEffect, useState } from "react";

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
  // The right extension area opens on 工作区 by default, matching the desktop
  // client — the panel is part of the default workspace, not something the user
  // has to summon first.
  const [panel, setPanel] = useState<PanelKind | null>("workspace");
  // Settings is a dialog rather than a drawer panel, so it has its own state.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const alertCount = useAlertCount();

  // Drawer panels are opened from the toolbar and the sidebar's nav rows; the two
  // entry points share this one piece of state so they cannot disagree.
  const openPanel = useCallback((kind: PanelKind) => {
    setPanel((current) => (current === kind ? null : kind));
  }, []);

  const openSettings = useCallback(() => setSettingsOpen(true), []);

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
              activePanel={panel === "workspace" || panel === "files" ? panel : null}
            />
          ) : null
        }
        panel={panel ? <RightPanel kind={panel} onClose={() => setPanel(null)} t={t} /> : null}
        onOpenPanel={openPanel}
        onOpenSettings={openSettings}
        alertCount={alertCount}
      >
        {hasConversation ? (
          <>
            <Chat t={t} locale={locale} />
            <Composer t={t} />
          </>
        ) : (
          <HomeState t={t} locale={locale}>
            <Composer t={t} inline />
          </HomeState>
        )}
      </AppShell>
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        t={t}
        locale={locale}
        setLocale={setLocale}
      />
      <ActionErrorBanner t={t} />
      <Modals t={t} />
    </>
  );
}
