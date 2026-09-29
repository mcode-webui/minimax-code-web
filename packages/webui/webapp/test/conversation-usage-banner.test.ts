// webapp/test/conversation-usage-banner.test.ts
//
// Behaviour pins for the conversation usage banner (ticket 60 / 59 F1–F3):
// the × close button used to render with `onDismiss` unwired — visible but
// dead — and its aria-label plus the action-button fallbacks were hardcoded
// Chinese, which leaks into an English locale. These tests render the real
// component (renderToStaticMarkup, same harness as activity-group.test.ts)
// and pin the chat.tsx wiring on the source, because the dismiss STATE lives
// in Chat, not in the banner.
//
// createElement, not JSX: this suite is a `.test.ts` file (the test:webapp
// glob matches *.test.ts; tsx JSX needs .tsx).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import {
  ConversationUsageBanner,
  type ConversationUsageNotice,
} from "../components/conversation-usage-banner";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) =>
  readFileSync(resolve(here, relative), "utf8");

const baseNotice: ConversationUsageNotice = {
  kind: "five_hour",
  messageKey: "usage.banner.fiveHourLow",
  resetAtMs: null,
  actions: [],
  dismissable: true,
};

function renderBanner(props: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(ConversationUsageBanner, props as never),
  );
}

describe("conversation usage banner (ticket 59 F1–F3)", () => {
  test("a dismissable banner renders the × button with the caller's aria-label", () => {
    const markup = renderBanner({
      notice: baseNotice,
      messageText: "5-hour quota is running low",
      dismissLabel: "Close",
    });
    assert.ok(
      markup.includes('data-testid="conversation-usage-banner-dismiss"'),
      "the dismiss button must exist and keep its stable testid",
    );
    assert.ok(
      markup.includes('aria-label="Close"'),
      `the dismiss aria-label must be the caller-supplied string, got: ${markup}`,
    );
  });

  test("a non-dismissable notice renders NO close button", () => {
    const markup = renderBanner({
      notice: { ...baseNotice, dismissable: false },
      messageText: "5-hour quota is running low",
      dismissLabel: "Close",
    });
    assert.ok(!markup.includes("conversation-usage-banner-dismiss"));
  });

  test("action buttons fall back to English, never to Chinese", () => {
    // actions stay [] in the product wiring; this pins the fallback for the
    // day someone fills them without passing buttonLabels (59 D3-4).
    const markup = renderBanner({
      notice: { ...baseNotice, actions: ["buy_credits", "upgrade_plan"] },
      messageText: "5-hour quota is running low",
      dismissLabel: "Close",
    });
    assert.ok(markup.includes("Buy credits"));
    assert.ok(markup.includes("Upgrade plan"));
    assert.ok(
      !/[\u4e00-\u9fa5]/.test(markup),
      "no CJK may leak on this render",
    );
  });

  test("the reset timestamp follows the app locale, not the browser", () => {
    // 2026-01-05T15:04 local — cross-day, so both locales render month+day
    // and differ visibly (en "Jan 5, 3:04 PM" vs zh "1月5日 15:04").
    const resetAtMs = new Date(2026, 0, 5, 15, 4).getTime();
    const en = renderBanner({
      notice: { ...baseNotice, resetAtMs },
      messageText: "quota",
      dismissLabel: "Close",
      locale: "en",
    });
    const zh = renderBanner({
      notice: { ...baseNotice, resetAtMs },
      messageText: "quota",
      dismissLabel: "Close",
      locale: "zh",
    });
    assert.notEqual(en, zh, "the locale prop must reach Intl.DateTimeFormat");
    assert.match(en, /Jan 5/);
  });

  test("chat.tsx wires onDismiss to real state (the × must do something)", () => {
    const chatSource = read("../components/chat.tsx");
    assert.ok(
      chatSource.includes(
        "onDismiss={() => setDismissedUsageNoticeKey(usageNoticeKey)}",
      ),
      "the banner's onDismiss must be wired to the dismissed-key state",
    );
    assert.ok(
      chatSource.includes(
        "const visibleUsageNotice = usageNotice && usageNoticeKey !== dismissedUsageNoticeKey",
      ),
      "a dismissed notice must stop rendering until the quota window rolls",
    );
    assert.ok(
      chatSource.includes('dismissLabel={t("common.close")}'),
      "the dismiss aria-label must come from the dictionary",
    );
    assert.ok(
      chatSource.includes("locale={locale}"),
      "the banner must receive the app locale for the reset timestamp",
    );
  });
});
