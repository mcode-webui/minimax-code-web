// webapp/test/toolbar-version-badge.test.ts
//
// Render pins for the conversation toolbar's version badge
// (webui-parity 89, user feedback F-4: "标题栏显示当前的分支名称、commit
// 短编号和提交时间，方便确认版本").
//
// Two layers, and the second one is the reason this file exists:
//
//   1. The pure decision — which workspace states render a badge at
//      all — is pinned in webapp/test/git-panel.test.ts against
//      `resolveVersionBadge`. That helper is necessary but NOT
//      sufficient: a badge can pass every one of those assertions and
//      still never reach the screen, because the component that is
//      supposed to call it is not wired into the toolbar, or its
//      `badge === null` branch paints an empty shell. Both are
//      regressions that leave typecheck and the helper tests green.
//   2. The markup itself, rendered through `renderToStaticMarkup`:
//      the null case renders an EMPTY string (not a pill), and the
//      populated case renders branch + sha + time as text a user can
//      read. A source tripwire for the wiring, a real render for the
//      output.
//
// createElement, not JSX: the test:webapp glob is `**/*.test.ts` and the
// tsx loader only transpiles JSX in `.tsx`. The React global stub is the
// one turn-chevron.test.ts documents.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

{
  const reactModule = React;
  Object.defineProperty(globalThis, "React", {
    value: reactModule,
    configurable: true,
    writable: true,
  });
}

const { VersionBadgeView } = await import("../components/version-badge");
const { translate } = await import("../lib/i18n");
import type { MessageKey } from "../lib/i18n";
import type { VersionBadge } from "../lib/git-panel";

const here = dirname(fileURLToPath(import.meta.url));
const toolbarSource = readFileSync(resolve(here, "../components/toolbar.tsx"), "utf8");
const badgeSource = readFileSync(resolve(here, "../components/version-badge.tsx"), "utf8");

const NOW = Date.parse("2026-10-01T12:00:00Z");
const t = (key: MessageKey) => translate("zh", key);

function badge(overrides: Partial<VersionBadge> = {}): VersionBadge {
  return {
    branch: "feat/version-badge",
    shortSha: "0e99b45",
    committedAtMs: NOW - 3 * 60 * 60_000,
    ...overrides,
  };
}

function render(props: Parameters<typeof VersionBadgeView>[0]): string {
  return renderToStaticMarkup(createElement(VersionBadgeView, props));
}

/**
 * The JSX element carrying `data-testid="<testId>"` — from its opening
 * tag back to the tag name, through its closing `>`. Slicing the
 * element rather than a fixed character window around the testid is
 * what keeps these assertions about the element they name: JSX writes
 * `className` before `data-testid`, and a window that runs forward
 * from the testid ends up reading the NEXT sibling's classes.
 */
function elementAround(source: string, testId: string): string {
  const at = source.indexOf(`data-testid="${testId}"`);
  assert.notEqual(at, -1, `no element carries data-testid="${testId}"`);
  const openAt = source.lastIndexOf("<", at);
  const closeAt = source.indexOf(">", at);
  assert.ok(openAt !== -1 && closeAt !== -1, `could not bound the element for ${testId}`);
  return source.slice(openAt, closeAt + 1);
}

describe("VersionBadgeView — the no-data case renders nothing at all", () => {
  test("a null badge renders an empty string, not an empty pill", () => {
    const html = render({ t, badge: null, now: NOW });
    // This is the assertion the ticket's "非 git 目录时不显示" rule
    // actually turns on: an empty <div> in the bar would read as a
    // control that is present but has nothing to say.
    assert.equal(html, "");
    assert.equal(html.includes("toolbar-version-badge"), false);
  });

  test("every non-repo / unborn / failed / loading state reaches this same null", () => {
    // The chip hands `resolveVersionBadge`'s return value straight
    // through, so those four workspace states are not four render
    // paths — they are one. Asserted on the wiring because that is
    // the only thing that makes the previous test's single null a
    // claim about all of them rather than about one of them.
    assert.ok(
      /<VersionBadgeView\s+t=\{t\}\s+badge=\{badge\}/.test(badgeSource),
      "the chip no longer passes resolveVersionBadge's result through unchanged",
    );
    assert.ok(
      badgeSource.includes("const badge = resolveVersionBadge({ workspaceDir, status, hasError: failed })"),
      "the render decision no longer goes through resolveVersionBadge",
    );
  });
});

describe("VersionBadgeView — the populated case", () => {
  test("branch, short sha and relative time are all in the markup", () => {
    const html = render({ t, badge: badge(), now: NOW });
    assert.ok(html.includes('data-testid="toolbar-version-badge"'));
    assert.ok(html.includes("feat/version-badge"), "branch name is missing");
    assert.ok(html.includes("0e99b45"), "short sha is missing");
    // 3 hours ago -> the hoursAgo bucket, localized through the
    // dictionary rather than hard-coded in the component.
    assert.ok(html.includes("3 小时前"), `expected the relative time, got ${html}`);
  });

  test("the sha is a real button wired to a copy action, not dead text", () => {
    // The ticket forbids a control that does nothing on click. The
    // button carries an aria-label and the container's onCopy is what
    // the chip hands it; pinning the wiring keeps a refactor that
    // drops the handler from shipping a dead pill.
    assert.ok(
      toolbarSource.includes('<VersionBadgeChip t={t} now={now} />'),
      "the badge is not mounted in the conversation toolbar",
    );
    assert.ok(
      badgeSource.includes("copyTextToClipboard(badge.shortSha)"),
      "the copy action no longer writes the short sha",
    );
    const html = render({ t, badge: badge(), now: NOW });
    assert.ok(html.includes("<button"), "the sha must be an actionable control");
    assert.ok(html.includes(t("git.badge.copyAria")), "the copy control needs an accessible name");
  });

  test("the copied confirmation appears only when the copy reported success", () => {
    const quiet = render({ t, badge: badge(), now: NOW });
    assert.equal(quiet.includes('data-testid="toolbar-version-copied"'), false);
    const confirmed = render({ t, badge: badge(), now: NOW, copied: true });
    assert.ok(confirmed.includes('data-testid="toolbar-version-copied"'));
    assert.ok(confirmed.includes(t("git.badge.copied")));
  });

  test("a detached HEAD drops the branch span but keeps the sha", () => {
    const html = render({ t, badge: badge({ branch: null }), now: NOW });
    assert.equal(html.includes('data-testid="toolbar-version-branch"'), false);
    assert.ok(html.includes("0e99b45"));
    assert.ok(html.includes('data-testid="toolbar-version-badge"'));
  });

  test("an unparseable commit time omits the time span, keeping branch + sha", () => {
    const html = render({ t, badge: badge({ committedAtMs: null }), now: NOW });
    assert.equal(html.includes('data-testid="toolbar-version-time"'), false);
    assert.ok(html.includes("feat/version-badge"));
    assert.ok(html.includes("0e99b45"));
  });

  test("the time span is the only part that drops at a narrow width", () => {
    // The badge must not be what breaks a narrow bar, so the branch
    // and the sha carry no responsive hiding class and the time span
    // does. Asserted on the source because Tailwind resolves
    // `hidden lg:inline` at build time, not at render time — and on
    // the ELEMENT, not on a fixed offset from the testid, because JSX
    // puts className before data-testid and an offset regex silently
    // starts asserting on the neighbouring element instead.
    for (const testId of ["toolbar-version-branch", "toolbar-version-sha"]) {
      const element = elementAround(badgeSource, testId);
      assert.ok(
        !/\b(sm|md|lg|xl):(hidden|inline)\b/.test(element),
        `${testId} must not change visibility at a breakpoint, got: ${element}`,
      );
    }
    const timeElement = elementAround(badgeSource, "toolbar-version-time");
    assert.ok(
      /\blg:inline\b/.test(timeElement),
      `the relative time is what should give way first, got: ${timeElement}`,
    );
  });

  test("the badge is pinned to the title row, clear of the fixed launcher cluster", () => {
    // `ml-auto` puts it at the far end of the flex title row, and the
    // row keeps a reserve wide enough that the `fixed right-4` launcher
    // cluster can never sit on top of it.
    assert.ok(toolbarSource.includes('<VersionBadgeChip t={t} now={now} />'));
    // The reserve must cover the cluster the row protects itself from
    // (4 × 30px + 3 × gap-1 + right-4 = 148px) plus breathing room so
    // the badge does not read as part of the button group. A `pr-20`
    // here reads as "reserved" while leaving the badge 68px underneath
    // the launchers at 1440px, so the width itself is asserted rather
    // than just the presence of a padding utility.
    const reserve = /flex min-w-0 flex-1 translate-y-\[2px\] items-center gap-2 pr-\[(\d+)px\]/.exec(
      toolbarSource,
    );
    assert.ok(reserve, "the title row lost its launcher reserve");
    const clusterPx = 4 * 30 + 3 * 4 + 16;
    assert.ok(
      Number(reserve[1]) >= clusterPx,
      `the reserve is ${reserve[1]}px but the fixed launcher cluster occupies ${clusterPx}px`,
    );
    assert.ok(
      Number(reserve[1]) - clusterPx <= 24,
      `the reserve is ${reserve[1]}px — more than 24px of dead space after the ${clusterPx}px cluster`,
    );

    // The session title must be the row's ELASTIC member. Without
    // `min-w-0` it refused to shrink, so the badge — the only item
    // that could — was crushed to a zero-width box parked under the
    // launcher icons at 420px. The title already owns a `truncate`
    // span for exactly this job; it just had no way to be given less
    // room.
    const titleAt = toolbarSource.indexOf("aria-label={state?.sessionTitle");
    assert.notEqual(titleAt, -1, "the session title button is gone from the toolbar");
    const titleClass = /className="([^"]*)"/.exec(toolbarSource.slice(titleAt, titleAt + 320));
    assert.ok(titleClass, "the session title button has no className");
    const titleClasses = titleClass[1] ?? "";
    assert.ok(
      /\bmin-w-0\b/.test(titleClasses),
      `the session title must be shrinkable (min-w-0) or it starves the badge, got: ${titleClasses}`,
    );

    // …and below the width where the badge can actually fit it must
    // disappear rather than collapse. A zero-width box under the
    // launchers is worse than no badge.
    const badgeContainer = elementAround(badgeSource, "toolbar-version-badge");
    assert.ok(
      /className="ml-auto hidden[^"]*\bmd:flex\b/.test(badgeContainer),
      `the badge needs a hidden/md:flex floor, got: ${badgeContainer}`,
    );

    // A pathological branch name must not be able to crowd out the
    // sha — the sha is what identifies a build.
    const branchEl = elementAround(badgeSource, "toolbar-version-branch");
    assert.ok(
      /\btruncate\b/.test(branchEl) && /max-w-\[\d+px\]/.test(branchEl),
      `the branch name must truncate under a width cap, got: ${branchEl}`,
    );
  });
});
