"use client";

/**
 * Settings-modal port — the 工作树 tab (placeholder batch PB-3).
 *
 * The desktop reference (`design-ref/screenshots/ref-23.jpg`, read
 * directly) is a CLEANUP page, not a workspace manager: a title with an ⓘ,
 * a toolbar of three time tabs · ↻ refresh · 一键移除 in a red outline, and
 * an empty list reading 「没有可管理 Worktree」. There is no 「新建工作树」
 * button in that reference, and the engine's
 * `ManagedWorktreeServicePort` declares no create either — so this page has
 * no create button. Adding one would be inventing a capability on both
 * sides at once.
 *
 * What replaced the old placeholder. The tab used to render one sentence,
 * 「本地版暂不支持工作树管理」, which was true about the HTTP route and false
 * about the capability: `services.managedWorktrees` had been implemented in
 * v1 the whole time. The window is `GET /api/worktrees` /
 * `POST /api/worktrees/remove` (`server/engine/worktrees.js`).
 *
 * Four decisions this page makes, each of which had a plausible wrong
 * answer:
 *
 *   1. THE THREE TABS FILTER, THEY DO NOT SORT. `lastModifiedMs` is the
 *      only field the desktop's tabs can be driven by, and a tab that
 *      re-ordered rows would break the desktop's mental model (each tab is
 *      "what is in this age band"). Filtering also keeps every row
 *      reachable: sorting by age and hiding nothing means the 7-days-ago
 *      tab has to be scrolled past to reach the recent ones.
 *   2. A ROW WITH NO TIMESTAMP APPEARS IN EVERY TAB, labelled 时间未知.
 *      `worktreeLastModifiedMs` (worktrees.ts:115-127) falls back from the
 *      directory mtime to the last reflog entry and can reach neither, and
 *      `lastModifiedMs` is then genuinely `undefined`. Filing it at 0 would
 *      put a worktree modified seconds ago under 「7 天以上」; hiding it
 *      from all three would make a real worktree invisible. Both are worse
 *      than showing it everywhere with an honest label.
 *   3. PROTECTED ROWS ARE NOT SELECTABLE, AND SAY WHY. The engine refuses
 *      the main worktree, the worktree an active session runs in, and a
 *      locked one. A checkbox that ticks and then fails on submit teaches
 *      the user that the button lies, so those rows render their checkbox
 *      disabled with the matching reason beside them — the refusal is
 *      visible BEFORE the click instead of after it.
 *   4. FAILURES ARE REPORTED PER ITEM, NEVER COLLAPSED. `removeBatch`
 *      returns one `WorktreeRemovalReason` per refused item; the page maps
 *      each through one table (`REASON_TEXT`) and lists them under the
 *      toolbar. A removal where everything was refused still re-reads the
 *      list, because the rows it refused are still there.
 *
 * Pure derivations (`worktreeAgeBucket`, `worktreeBlockReason`,
 * `visibleWorktrees`) are exported and tested on their inputs in
 * `webapp/test/settings-worktree-section.test.ts`; the boundary cases are
 * exactly 3 days and exactly 7 days, which is where a `<`/`<=` slip would
 * quietly move a row between tabs.
 *
 * Import style: relative specifiers, like `settings-extra-pages.tsx`, so
 * the render harness can load this module under the tsx loader without the
 * `@/` alias.
 */

import * as React from "react";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Popconfirm as AntPopconfirm } from "antd";

import * as api from "../lib/api";
import type { MessageKey } from "../lib/i18n";
import { Icon } from "./icons";

/** The three time bands of the desktop toolbar, plus the always-visible one. */
export type WorktreeTimeBucket = "recent3d" | "days3to7" | "older7d";

/** Every tab key, in the desktop's left-to-right order. */
export const WORKTREE_TIME_BUCKETS: readonly WorktreeTimeBucket[] = Object.freeze([
  "recent3d",
  "days3to7",
  "older7d",
]);

/** A full day in milliseconds — the tab boundaries are whole days. */
export const WORKTREE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Which band a timestamp falls into, or `null` when there is no timestamp.
 *
 * Boundaries are INCLUSIVE at the top of each band: exactly 3 days old is
 * still 「近 3 天」, exactly 7 days old is still 「3-7 天前」, and only
 * beyond 7 days is it 「7 天以上」. A future timestamp (clock skew between
 * the workstation and the machine hosting the repository) yields a
 * NEGATIVE age, which the `recent3d` test accepts — "modified in the
 * future" is closest to "modified just now", and hiding the row would be
 * worse than mis-bucketing it.
 *
 * @param lastModifiedMs Epoch milliseconds, or `undefined` when unknown.
 * @param nowMs The page's single clock reading for this list load.
 * @returns The band, or `null` when the engine reported no timestamp.
 */
export function worktreeAgeBucket(
  lastModifiedMs: number | undefined,
  nowMs: number,
): WorktreeTimeBucket | null {
  if (typeof lastModifiedMs !== "number" || !Number.isFinite(lastModifiedMs)) return null;
  const age = nowMs - lastModifiedMs;
  if (age <= 3 * WORKTREE_DAY_MS) return "recent3d";
  if (age <= 7 * WORKTREE_DAY_MS) return "days3to7";
  return "older7d";
}

/**
 * Why this row cannot be removed, or `null` when it can.
 *
 * The order is the order the engine checks in
 * (`prepareManagedWorktreeRemoval`, managed-worktrees.ts:221-259), so the
 * label shown matches the reason the engine would actually return if the
 * row were submitted anyway. Checking `isMain` before `isActive` matters:
 * the repository's primary checkout is usually also the conversation's
 * workspace, and calling it 「当前工作树」 there would hide the stronger
 * 「主工作树不可移除」 fact.
 */
export function worktreeBlockReason(
  row: api.WorktreeRow,
): api.WorktreeRemovalReason | null {
  if (row.isMain) return "main_worktree";
  if (row.isActive) return "active_worktree";
  if (row.isLocked) return "locked_worktree";
  return null;
}

/**
 * The rows a tab shows: the band it names, plus every row whose age the
 * engine could not report.
 */
export function visibleWorktrees(
  rows: readonly api.WorktreeRow[],
  bucket: WorktreeTimeBucket,
  nowMs: number,
): api.WorktreeRow[] {
  return rows.filter((row) => {
    const band = worktreeAgeBucket(row.lastModifiedMs, nowMs);
    return band === null || band === bucket;
  });
}

/**
 * The engine's closed reason set, mapped to one sentence each.
 *
 * Exhaustive over `api.WorktreeRemovalReason` on purpose: adding a reason
 * upstream makes this table a compile error rather than a raw token in the
 * UI. `dirty_worktree` is the one a user can act on, so its sentence names
 * the three ways out (commit / stash / discard) instead of just refusing.
 */
const REASON_TEXT: Readonly<Record<api.WorktreeRemovalReason, MessageKey>> = Object.freeze({
  main_worktree: "settings.worktree.reason.main",
  active_worktree: "settings.worktree.reason.active",
  locked_worktree: "settings.worktree.reason.locked",
  dirty_worktree: "settings.worktree.reason.dirty",
  not_found: "settings.worktree.reason.notFound",
  unknown: "settings.worktree.reason.unknown",
});

/**
 * The label key for a refusal reason.
 *
 * Exported so a test can walk the SAME table the page renders from rather
 * than re-deriving the key names — a test that rebuilt `reason` into a key
 * itself would pass against a table that had lost a row, which is the one
 * thing the table exists to prevent.
 */
export function worktreeReasonLabelKey(reason: api.WorktreeRemovalReason): MessageKey {
  return REASON_TEXT[reason] ?? REASON_TEXT.unknown;
}

/** The tab label key, per band. */
const BUCKET_LABEL: Readonly<Record<WorktreeTimeBucket, MessageKey>> = Object.freeze({
  recent3d: "settings.worktree.filter.recent3d",
  days3to7: "settings.worktree.filter.days3to7",
  older7d: "settings.worktree.filter.older7d",
});

/** The label key for a time band. Exported for the same reason as above. */
export function worktreeBucketLabelKey(bucket: WorktreeTimeBucket): MessageKey {
  return BUCKET_LABEL[bucket];
}

/**
 * The sentence for a list failure. The engine's own discovery code is
 * appended verbatim after it: the three codes mean different operator
 * actions (open a different folder / fix permissions / look at Git), and
 * collapsing them into one 「读取失败」 would throw that away.
 */
const LIST_ERROR: Readonly<Record<string, MessageKey>> = Object.freeze({
  not_git_repository: "settings.worktree.listError.notGit",
  workspace_unavailable: "settings.worktree.listError.unavailable",
  worktree_list_failed: "settings.worktree.listError.listFailed",
});

/** One refused item, resolved to the two strings the page prints. */
interface RemovalFailureLine {
  readonly worktreeDir: string;
  readonly text: string;
}

/** A removal outcome, resolved for rendering: what went, what stayed, why. */
export interface RemovalOutcome {
  readonly removed: number;
  readonly failures: RemovalFailureLine[];
}

/**
 * Turn the engine's batch answer into the lines the page prints.
 *
 * A failure whose reason is not in the table cannot happen through the
 * route — `worktreeRemovalPayload` narrows reasons to the closed set — but
 * the default arm exists so a widened union degrades to the engine's own
 * `unknown` sentence rather than to an empty string.
 */
export function removalOutcomeOf(
  payload: api.WorktreeRemovalPayload,
  t: (key: MessageKey) => string,
): RemovalOutcome {
  const failures = payload.failedItems.map((item) => ({
    worktreeDir: item.worktreeDir,
    text: t(REASON_TEXT[item.reason] ?? REASON_TEXT.unknown),
  }));
  return { removed: payload.removedPaths.length, failures };
}

/** The absolute time a row was last modified, in the browser's locale. */
function formatModified(lastModifiedMs: number | undefined, t: (key: MessageKey) => string): string {
  if (typeof lastModifiedMs !== "number" || !Number.isFinite(lastModifiedMs)) {
    return t("settings.worktree.timeUnknown");
  }
  const stamp = new Date(lastModifiedMs);
  if (Number.isNaN(stamp.getTime())) return t("settings.worktree.timeUnknown");
  return stamp.toLocaleString();
}

export function WorktreeSection({
  t,
}: {
  t: (key: MessageKey) => string;
}): ReactElement {
  const [payload, setPayload] = useState<api.WorktreeListPayload | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  // The clock is read ONCE per list load and kept in state, not taken from
  // `Date.now()` during render: a render that re-bucketed rows would move a
  // row across a tab boundary while the user was looking at the list, and
  // the tests could not pin the result.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [bucket, setBucket] = useState<WorktreeTimeBucket>("recent3d");
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [removing, setRemoving] = useState(false);
  const [outcome, setOutcome] = useState<RemovalOutcome | null>(null);

  const load = useCallback(() => {
    setPhase("loading");
    return api
      .getWorktrees()
      .then((answer) => {
        setPayload(answer);
        setNowMs(Date.now());
        setPhase("ready");
      })
      .catch(() => setPhase("failed"));
  }, []);

  useEffect(() => {
    let live = true;
    void load().catch(() => {
      if (live) setPhase("failed");
    });
    return () => {
      live = false;
    };
  }, [load]);

  const rows = payload?.worktrees ?? [];
  const shown = useMemo(() => visibleWorktrees(rows, bucket, nowMs), [rows, bucket, nowMs]);
  const removable = useMemo(
    () => shown.filter((row) => worktreeBlockReason(row) === null),
    [shown],
  );
  const selectedPaths = useMemo(
    () => selected.filter((path) => removable.some((row) => row.path === path)),
    [selected, removable],
  );

  const toggle = (path: string) => {
    setSelected((current) =>
      current.includes(path) ? current.filter((item) => item !== path) : [...current, path],
    );
  };

  const runRemoval = async () => {
    if (selectedPaths.length === 0 || removing) return;
    setRemoving(true);
    setOutcome(null);
    const workspace = payload?.workspace ?? "";
    try {
      const answer = await api.removeWorktrees(
        selectedPaths.map((worktreeDir) => ({ workspace, worktreeDir })),
      );
      setOutcome(removalOutcomeOf(answer, t));
    } catch {
      setOutcome({ removed: 0, failures: [] });
    } finally {
      setSelected([]);
      setRemoving(false);
      // Re-read either way: a transport failure may still have removed
      // rows, and leaving a stale list on screen is how a user tries the
      // same removal twice.
      await load();
    }
  };

  const listErrorKey = payload && !payload.ok ? LIST_ERROR[payload.code ?? ""] : undefined;
  const errorText =
    phase === "failed"
      ? t("settings.worktree.readFailed")
      : phase === "loading"
        ? t("settings.worktree.loading")
        : listErrorKey
          ? t(listErrorKey)
          : payload?.error ?? null;

  return (
    <section className="webui-settings-panel" data-testid="worktree-section">
      <h3>
        {t("settings.tab.worktree")}
        <Icon
          name="info"
          size={14}
          className="text-text_default_tertiary"
          aria-label={t("settings.worktree.hint")}
        />
      </h3>

      <div className="webui-worktree-toolbar">
        <div className="webui-segmented" role="radiogroup">
          {WORKTREE_TIME_BUCKETS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="radio"
              aria-checked={candidate === bucket}
              className={candidate === bucket ? "is-selected" : undefined}
              onClick={() => setBucket(candidate)}
            >
              {t(BUCKET_LABEL[candidate])}
            </button>
          ))}
        </div>
        <div className="webui-worktree-actions">
          <button
            type="button"
            className="webui-settings-action"
            onClick={() => void load()}
            disabled={phase === "loading"}
            aria-label={t("settings.worktree.refresh")}
          >
            ↻
          </button>
          <AntPopconfirm
            title={t("settings.worktree.confirmTitle")}
            description={t("settings.worktree.confirmBody")}
            okText={t("settings.worktree.confirmOk")}
            cancelText={t("settings.worktree.confirmCancel")}
            onConfirm={() => void runRemoval()}
          >
            <button
              type="button"
              className="webui-mavis-button webui-worktree-remove"
              disabled={selectedPaths.length === 0 || removing}
            >
              {t("settings.worktree.removeOneClick")}
            </button>
          </AntPopconfirm>
        </div>
      </div>

      {errorText ? <p className="webui-settings-error">{errorText}</p> : null}

      {outcome ? (
        <p className="webui-settings-error" data-testid="worktree-outcome">
          {t("settings.worktree.removedCount").replace("{n}", String(outcome.removed))}
          {outcome.failures.map((failure) => (
            <span key={failure.worktreeDir} className="webui-worktree-failure">
              {`${failure.worktreeDir} — ${failure.text}`}
            </span>
          ))}
        </p>
      ) : null}

      {phase === "ready" && payload?.ok && shown.length === 0 ? (
        <p className="webui-settings-empty-panel" data-testid="worktree-empty">
          {t("settings.worktree.empty")}
        </p>
      ) : null}

      {shown.length > 0 ? (
        <ul className="webui-worktree-list" data-testid="worktree-list">
          {shown.map((row) => {
            const blocked = worktreeBlockReason(row);
            const checked = selected.includes(row.path);
            return (
              <li key={row.path} className="webui-worktree-row">
                <label className="webui-worktree-row-main">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={blocked !== null || removing}
                    onChange={() => toggle(row.path)}
                    aria-label={row.path}
                  />
                  <span className="webui-worktree-row-copy">
                    <strong>{row.branch || row.path}</strong>
                    <span>{row.path}</span>
                  </span>
                </label>
                <span className="webui-worktree-row-meta">
                  <span>{formatModified(row.lastModifiedMs, t)}</span>
                  {blocked !== null ? (
                    <em className="webui-worktree-badge">
                      {t(REASON_TEXT[blocked])}
                    </em>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
