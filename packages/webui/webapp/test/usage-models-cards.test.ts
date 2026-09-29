// webapp/test/usage-models-cards.test.ts
//
// Render tests for the Token Plan view's pure display cards (ticket 53).
//
// Why render tests and not another static tripwire: acceptance for the
// first 53a round shipped a light-theme defect (F-1) where the usage-bar
// track resolved to the SAME grey as its section card, because the track
// class had been copied from a surface with a different background. Every
// static-source assertion was green — the string "bg-bg_grouped_tertiary_elevated"
// was right there in the source, exactly as written. Only rendering the
// component and looking at the emitted classes catches a token that is
// "valid but invisible here". Same discipline as loading-skeleton.test.ts:
// the components live in components/usage-models-cards.tsx (import-clean
// apart from antd's Switch) so panels.tsx's store/api graph never enters
// the test process.
//
// What is pinned, and the defect each guard exists for:
//
//   - F-1: the bar track must be the border grey (visible on the section
//     card in BOTH themes) and must not be the context meter's elevated
//     grey, which is identical to the card grey in the light theme.
//   - F-2: the invoice action keeps the 去充值/管理 outline treatment
//     (border + transparent ground), not a filled grey.
//   - F-3': whole-hour reset captions drop the minute slot (「1小时后重置」).
//   - A1/B1: placeholder text in the figure slots, disabled plan actions,
//     the checked+disabled credits switch, the live outbound link — now
//     asserted against rendered markup, not source strings.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CreditsCard,
  InvoiceCard,
  PlanCard,
  UsageBar,
  resetCaption,
} from "../components/usage-models-cards";
import { translate, type MessageKey } from "../lib/i18n";

// createElement, not JSX: this suite is a `.test.ts` file (the test:webapp
// glob is `**/*.test.ts`), and the tsx loader only transpiles JSX in `.tsx`.
const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(element);
const tZh = (key: MessageKey) => translate("zh", key);
const tEn = (key: MessageKey) => translate("en", key);

describe("PlanCard renders the A1 placeholder policy", () => {
  const markup = render(createElement(PlanCard, { t: tZh }));

  test("both data regions show the not-applicable line, no fabricated expiry", () => {
    assert.ok(markup.includes('data-testid="settings-plan-card"'));
    const placeholderHits = markup.match(/本地版不适用/g) ?? [];
    assert.ok(
      placeholderHits.length >= 2,
      "plan name and credits figure both render the placeholder",
    );
    // A fabricated date line would be the A1 violation this guards against.
    assert.ok(!markup.includes("到期"), "no fabricated expiry line may render");
  });

  test("all four actions render disabled; upgrade keeps the black primary form", () => {
    for (const testId of [
      "plan-upgrade-button",
      "plan-manage-button",
      "plan-top-up-button",
      "plan-credits-manage-button",
    ]) {
      const at = markup.indexOf(`data-testid="${testId}"`);
      assert.ok(at >= 0, `${testId} must render`);
      // React emits attributes in JSX order, and data-testid precedes
      // className on these buttons — so the opening tag is just before.
      assert.ok(
        markup.slice(Math.max(0, at - 160), at).includes("<button"),
        `${testId} sits on a button element`,
      );
    }
    const disabledCount = (markup.match(/disabled(?:="")?/g) ?? []).length;
    assert.ok(disabledCount >= 4, `four disabled actions expected, found ${disabledCount}`);
    assert.ok(
      markup.includes("bg-bg_interaction_primary_default"),
      "升级 keeps the reference's black primary-button token",
    );
  });
});

describe("UsageBar: figures, placeholders, and the F-1 track token", () => {
  const emptyBar = render(
    createElement(UsageBar, {
      label: "视频限额",
      testId: "usage-bar-video",
      used: null,
      withTotal: false,
      placeholder: tZh("usage.notLocal"),
    }),
  );

  test("a null reading renders the placeholder, never a 0% figure", () => {
    assert.ok(emptyBar.includes("本地版不适用"));
    assert.ok(!emptyBar.includes("%"), "no percentage figure may render without a reading");
    assert.ok(!emptyBar.includes("aria-valuenow"), "no aria-valuenow without a reading");
  });

  test("F-1: the track is the border grey, not the card-coloured elevated grey", () => {
    // The guard for the light-theme invisibility defect: the elevated
    // token resolves to --gray_75 in the light theme — the same grey as
    // the SectionCard the bar sits on — so it must never be the track.
    assert.ok(
      emptyBar.includes("bg-border_default"),
      "the track must use the border grey (visible on the card in both themes)",
    );
    assert.ok(
      !emptyBar.includes("bg-bg_grouped_tertiary_elevated"),
      "the elevated grey is the card's own colour in the light theme — F-1 regression",
    );
  });

  test("a live reading prints the desktop figure forms and the fill", () => {
    const withTotal = render(
      createElement(UsageBar, {
        label: "5 小时限额",
        testId: "usage-bar-fiveHour",
        used: 7,
        withTotal: true,
        placeholder: tZh("usage.unavailable"),
        caption: "43分后重置",
      }),
    );
    assert.ok(withTotal.includes("7% / 100%"), "the 5-hour row prints used% / 100%");
    assert.ok(withTotal.includes('aria-valuenow="7"'));
    assert.ok(withTotal.includes("width:7%"), "the used share fills the track");
    assert.ok(withTotal.includes("43分后重置"), "the relative caption renders under the bar");

    const bare = render(
      createElement(UsageBar, {
        label: "周限额",
        testId: "usage-bar-weekly",
        used: 12,
        withTotal: false,
        placeholder: tZh("usage.unavailable"),
      }),
    );
    assert.ok(bare.includes("12%"), "the weekly row prints used%");
    assert.ok(!bare.includes("12% / 100%"), "only the 5-hour row carries the / 100% total");
  });

  test("a genuine 0% reading renders 0% with an empty track, not a placeholder", () => {
    const zero = render(
      createElement(UsageBar, {
        label: "5 小时限额",
        testId: "usage-bar-fiveHour",
        used: 0,
        withTotal: true,
        placeholder: tZh("usage.unavailable"),
      }),
    );
    assert.ok(zero.includes("0% / 100%"), "a real zero prints the figure");
    assert.ok(!zero.includes("暂无用量数据"), "a real zero is not the no-reading placeholder");
    assert.ok(!zero.includes("width:"), "an empty track renders no fill element");
  });
});

describe("CreditsCard renders decision B1: on-form, disabled", () => {
  const markup = render(createElement(CreditsCard, { t: tZh }));

  test("the switch renders checked AND disabled (greyed, blue form)", () => {
    assert.ok(
      markup.includes("ant-switch-checked"),
      "the desktop's on-state form (B1 renders the blue form)",
    );
    assert.ok(
      markup.includes("ant-switch-disabled"),
      "disabled — the local edition has no credits system to toggle",
    );
  });

  test("the reference's hint and the not-applicable marker both render", () => {
    assert.ok(markup.includes("开启后，可以在对话中消耗你的积分（含赠予积分）。"));
    assert.ok(markup.includes("本地版不适用"));
  });
});

describe("InvoiceCard renders the outbound row (F-2 outline form)", () => {
  const markup = render(createElement(InvoiceCard, { t: tZh }));

  test("live link, new tab, noreferrer", () => {
    assert.ok(markup.includes('href="https://platform.minimaxi.com/"'));
    assert.ok(markup.includes('target="_blank"'));
    assert.ok(markup.includes('rel="noreferrer"'));
  });

  test("F-2: the apply action uses the shared outline treatment, not a fill", () => {
    const at = markup.indexOf('data-testid="invoice-apply-link"');
    assert.ok(at >= 0, "the apply link carries its testid");
    // className follows data-testid in the JSX attribute order, so the
    // class list is AFTER the testid marker.
    const classes = markup.slice(at, at + 600);
    assert.ok(
      classes.includes("border border-border_default"),
      "申请 keeps the 去充值/管理 outline form the reference shows",
    );
    // The hover tint is fine; a standing grey fill is the F-2 form. Match
    // with a leading space so hover:bg-… (colon-prefixed) does not trip it.
    assert.ok(!classes.includes(" bg-bg_interaction_tertiary_hover"), "no filled grey ground");
    assert.ok(classes.includes("rotate-45"), "the ↗ glyph is the rotated arrow");
  });
});

describe("resetCaption: the reference's relative forms (F-3')", () => {
  // The +5s keeps Math.round stable against test-runner jitter: without
  // it, "exactly 60 minutes" can round down to 59 and flip the caption.
  const minutesFromNow = (n: number) => Date.now() + n * 60_000 + 5_000;

  test("sub-hour and mixed forms match the reference captions", () => {
    assert.equal(resetCaption(minutesFromNow(43), tZh), "43分后重置");
    assert.equal(resetCaption(minutesFromNow(4 * 60 + 24), tZh), "4小时24分后重置");
  });

  test("F-3': whole hours drop the minute slot", () => {
    assert.equal(resetCaption(minutesFromNow(60), tZh), "1小时后重置");
    assert.equal(resetCaption(minutesFromNow(2 * 60), tZh), "2小时后重置");
  });

  test("a past reset time renders no caption", () => {
    assert.equal(resetCaption(Date.now() - 60_000, tZh), null);
  });

  test("english locale composes through the same keys", () => {
    assert.equal(resetCaption(minutesFromNow(43), tEn), "Resets in 43 min");
    assert.equal(resetCaption(minutesFromNow(60), tEn), "Resets in 1 h");
  });
});
