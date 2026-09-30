// webapp/components/version-badge.tsx
//
// The conversation toolbar's version badge (webui-parity 89, user
// feedback F-4: 「标题栏显示当前的分支名称、commit 短编号和提交时间，
// 方便我确认版本」).
//
// Why its own file rather than a section of toolbar.tsx. The badge's
// whole contract is a RENDER decision — it must be absent for a
// non-git workspace, a repository with no commits, a failed request,
// and the pre-first-response state — and that contract is only
// testable if a test can import the component. `toolbar.tsx` uses the
// Next.js `@/…` alias, which Node's test loader does not resolve; the
// components the webapp suite renders today (activity-group,
// plugins-surface, loading-states) all use relative imports for the
// same reason, and this file follows that convention. Every module it
// pulls in — store, api, i18n, git-panel, icons — already uses
// relative imports, so nothing here is unreachable from a test.
//
// What it reads, and what it does not read. One `GET
// /api/git/status` — the SAME endpoint the right-panel Git panel
// reads, not a second source of truth. It renders nothing unless that
// endpoint reports a repository with at least one commit: a non-git
// folder is a perfectly normal workspace in this product, and an
// empty pill would be a control that looks live and says nothing.
//
// Why it does NOT poll. One call costs a `git status` (a real index
// refresh on a large tree) plus a `git log -1`. The Git panel
// deliberately fetches on workspace change and on an explicit Refresh
// rather than on a timer, and this badge follows the same rule: a
// version identity changes when the user commits or checks out a
// branch, not on a schedule, so polling would spend a subprocess per
// second to redraw a string that almost never changes. The user who
// wants it fresh after their own commit presses the Git panel's
// Refresh, which re-points the same endpoint. The relative-time half
// needs no refetch at all — it ticks off the toolbar's existing
// `useTicker(1000)`, which the elapsed-timer already pays for.
//
// When the Git panel happens to be open there are two in-flight
// requests for one endpoint. That is accepted deliberately: sharing
// them would mean lifting panel state into a provider above the shell
// and giving the badge a dependency on a panel it does not render —
// a larger coupling than one extra read of an already-warm index
// while a panel the user is reading is open.

import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "../lib/api";
import { copyTextToClipboard } from "../lib/clipboard";
import {
  resolveVersionBadge,
  versionBadgeTimeBucket,
  type VersionBadge,
} from "../lib/git-panel";
import type { MessageKey } from "../lib/i18n";
import { useSessionContext } from "../lib/store";

/**
 * The data half: read the workspace's HEAD identity, decide whether a
 * badge exists, and own the copy confirmation.
 */
export function VersionBadgeChip({
  t,
  now,
}: {
  t: (key: MessageKey) => string;
  /** Epoch ms from the toolbar's shared 1s ticker. */
  now: number;
}) {
  const { state } = useSessionContext();
  const workspaceDir = state?.workspace?.dir ?? null;
  const [status, setStatus] = useState<api.GitStatusPayload | null>(null);
  const [failed, setFailed] = useState(false);
  // Generation counter, not a boolean: switching workspaces quickly
  // must not let a slow answer for the previous dir overwrite the
  // current one. Same pattern the Git panel uses for its own refresh.
  const gen = useRef(0);

  useEffect(() => {
    const mine = ++gen.current;
    if (!workspaceDir) {
      setStatus(null);
      setFailed(false);
      return;
    }
    void api
      .getGitStatus(workspaceDir)
      .then((payload) => {
        if (mine !== gen.current) return;
        setStatus(payload);
        setFailed(false);
      })
      .catch(() => {
        if (mine !== gen.current) return;
        setStatus(null);
        setFailed(true);
      });
    return () => {
      // Invalidate the in-flight answer on unmount / workspace change
      // so a late response cannot paint a stale workspace's identity.
      gen.current += 1;
    };
  }, [workspaceDir]);

  const badge = resolveVersionBadge({ workspaceDir, status, hasError: failed });
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);

  // Clear the transient confirmation on unmount — the pending
  // timeout is what would otherwise call setState on a dead chip.
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const onCopy = useCallback(() => {
    if (!badge) return;
    void copyTextToClipboard(badge.shortSha).then((ok) => {
      // Only claim what happened: a refused clipboard shows no
      // confirmation rather than a confirmation the user acts on.
      if (!ok) return;
      setCopied(true);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
    });
  }, [badge]);

  return (
    <VersionBadgeView t={t} badge={badge} now={now} copied={copied} onCopy={onCopy} />
  );
}

/**
 * The badge's markup, split from the fetch above so the suite can
 * render it directly with plain props. Everything a render assertion
 * cares about — the null case, the branch / sha / time trio, the copy
 * button — lives here.
 */
export function VersionBadgeView({
  t,
  badge,
  now,
  copied = false,
  onCopy,
}: {
  t: (key: MessageKey) => string;
  /** `null` renders NOTHING — the whole point of the null case. */
  badge: VersionBadge | null;
  now: number;
  copied?: boolean;
  onCopy?: () => void;
}) {
  if (!badge) return null;

  const timeLabel = formatVersionBadgeTime(t, now, badge.committedAtMs);

  return (
    /* `hidden md:flex` is a floor, not a preference. The shell's
       collapsed-sidebar compensation (`pl-[142px]`, see
       components/shell.tsx) plus this row's 160px launcher reserve
       leave roughly 46px of content at a 420px viewport, and a badge
       that cannot fit must DISAPPEAR rather than collapse into a
       zero-width box parked underneath the launcher icons. Above
       `md` (768px) there is always room: 768 - 206px of sidebar =
       562px, less the 160px reserve = 402px for title + badge. */
    <div
      className="ml-auto hidden min-w-0 items-center gap-1.5 md:flex"
      data-testid="toolbar-version-badge"
    >
      {/* A detached HEAD has no branch name. The badge then shows the
          sha alone rather than a placeholder word: the sha is still a
          complete identity, and a label with nothing after it would be
          a label pretending to be a value. */}
      {badge.branch ? (
        <span
          className="min-w-0 max-w-[220px] truncate text-caption-small-strong text-text_default_tertiary"
          data-testid="toolbar-version-branch"
        >
          {badge.branch}
        </span>
      ) : null}
      <button
        type="button"
        onClick={onCopy}
        title={badge.shortSha}
        aria-label={t("git.badge.copyAria")}
        data-testid="toolbar-version-sha"
        className="flex flex-shrink-0 items-center gap-1 rounded-[6px] px-1 py-px text-caption-small-strong slashed-zero tabular-nums text-text_default_secondary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-text_default_primary"
      >
        {badge.shortSha}
        {copied ? (
          <span className="text-text_default_tertiary" data-testid="toolbar-version-copied">
            {t("git.badge.copied")}
          </span>
        ) : null}
      </button>
      {/* The relative time is the first thing to go when the bar runs
          out of room: the branch and the sha are what identify a
          build, so this span alone carries the narrow-width hiding. */}
      {timeLabel ? (
        <span
          className="hidden flex-shrink-0 text-caption-small-strong text-text_default_tertiary lg:inline"
          title={
            badge.committedAtMs === null
              ? undefined
              : new Date(badge.committedAtMs).toLocaleString()
          }
          data-testid="toolbar-version-time"
        >
          {timeLabel}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Render the badge's relative-time half: bucket key + count → one
 * localized string. Split out of the component so the `bucket:count`
 * bookkeeping and the `{n}` interpolation stay in one place, and so a
 * missing timestamp collapses to "" (the caller then omits the span)
 * rather than leaving an orphan separator behind.
 */
function formatVersionBadgeTime(
  t: (key: MessageKey) => string,
  now: number,
  committedAtMs: number | null,
): string {
  const bucket = versionBadgeTimeBucket(now, committedAtMs);
  if (bucket === "") return "";
  const separatorAt = bucket.indexOf(":");
  const key = separatorAt === -1 ? bucket : bucket.slice(0, separatorAt);
  const count = separatorAt === -1 ? "" : bucket.slice(separatorAt + 1);
  const template = t(`git.badge.${key}` as MessageKey);
  return count === "" ? template : template.replace("{n}", count);
}
