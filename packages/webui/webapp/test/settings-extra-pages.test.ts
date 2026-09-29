// webapp/test/settings-extra-pages.test.ts
//
// Render tests for the four pure-frontend settings sub-pages (ticket 55a):
// 快捷键 / 语音 / 个性化 / 代码审查, plus the 记忆摘要 dialog.
//
// Same discipline as usage-models-cards.test.ts: the pages live in
// components/settings-extra-pages.tsx (import-clean apart from antd's
// Select / Switch) so panels.tsx's store/api graph never enters the test
// process, and every assertion runs against RENDERED markup — a token
// that is "valid but invisible here" (the light-theme track defect that
// shipped in ticket 53's first round) or a placeholder that silently
// became a fabricated value fails here, not in a source grep.
//
// The localStorage-backed text blocks hydrate from `window.localStorage`;
// the window stub is installed through Object.defineProperty BEFORE the
// module import (the same pattern settings-general-sections.test.ts
// established — settings-local reads lazily inside each function).
//
// What is pinned, and the decision each guard exists for:
//
//   - A1 structure parity: the Shortcuts page renders BOTH desktop groups
//     with the reference's default bindings verbatim (Alt+M, Ctrl+K …),
//     the 未设置 rows render the unset placeholder WITHOUT the ✕, and
//     every binding control plus its ✕ / ↺ affordance renders disabled —
//     a browser page cannot register global shortcuts, so nothing may be
//     live. The notice banner carries the 浏览器环境不适用 wording.
//   - A1 voice placeholders: the mic dropdown's only option is the
//     standing 本地版不适用 marker (disabled); the two dictation rows
//     render 未设置.
//   - The REAL persistence: the three long-text blocks hydrate from and
//     commit through lib/settings-local.ts — a stored value renders into
//     the textarea, the save action stays disabled until the draft
//     diverges from what storage holds, and the commit helpers persist
//     before the setState forward.
//   - The 记忆摘要 dialog's permanent empty state: disabled textarea,
//     honest 0 count, 尚未生成 line, 取消 enabled / 保存 disabled.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// --- window stub (before the module import) ---------------------------------

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    localStorage: {
      getItem: (key: string) => (storage.has(key) ? (storage.get(key) as string) : null),
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
  },
});

import {
  CodeReviewSection,
  MemorySummaryModal,
  PersonalizationSection,
  ShortcutsSection,
  VoiceSection,
} from "../components/settings-extra-pages";
import { translate, type MessageKey } from "../lib/i18n";
import {
  ABOUT_USER_KEY,
  CODE_REVIEW_GUIDELINES_KEY,
  CUSTOM_INSTRUCTIONS_KEY,
  commitAboutUser,
  commitCodeReviewGuidelines,
  commitCustomInstructions,
  readAboutUser,
  readCodeReviewGuidelines,
  readCustomInstructions,
} from "../lib/settings-local";

// createElement, not JSX: this suite is a `.test.ts` file and the tsx
// loader only transpiles JSX in `.tsx`.
const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(element);
const tZh = (key: MessageKey) => translate("zh", key);

/** The OPENING TAG of the element carrying `testId`: from the `<` that
 * starts it to the `>` that closes it. Precise enough to assert that
 * control's own markup (disabled, class) regardless of attribute order,
 * and without bleeding into the neighbouring element. */
function controlMarkup(markup: string, testId: string): string {
  const at = markup.indexOf(`data-testid="${testId}"`);
  assert.ok(at >= 0, `${testId} must render`);
  const tagStart = markup.lastIndexOf("<", at);
  const tagEnd = markup.indexOf(">", at);
  return markup.slice(tagStart, tagEnd < 0 ? markup.length : tagEnd + 1);
}

describe("ShortcutsSection renders the desktop structure, all controls dead (A1)", () => {
  const markup = render(createElement(ShortcutsSection, { t: tZh }));

  test("the page opens with the browser-environment notice", () => {
    assert.ok(markup.includes('data-testid="settings-shortcuts-notice"'));
    assert.ok(markup.includes("浏览器环境不适用"), "the notice carries the standing A1 wording");
  });

  test("both reference groups render: Mini Chat (1 row) and 常用 (9 rows)", () => {
    assert.ok(markup.includes('data-testid="settings-shortcuts-group-minichat"'));
    assert.ok(markup.includes('data-testid="settings-shortcuts-group-common"'));
    assert.ok(markup.includes("Mini Chat"));
    assert.ok(markup.includes("常用"));
    // 10 shortcut rows total: 1 mini-chat + 9 common.
    const rows = markup.match(/data-testid="settings-shortcuts-row-([a-z-]+)"/g) ?? [];
    assert.equal(rows.length, 10, "ref-09 shows exactly ten rows across the two groups");
  });

  test("the bindings are the desktop defaults, verbatim", () => {
    // Set rows render the key combination as the input's value.
    for (const binding of [
      "Alt+M",
      "Ctrl+K",
      "Ctrl+G",
      "Ctrl+N",
      "Ctrl+Alt+O",
      "Ctrl+O",
      "Ctrl+,",
      "Ctrl+Enter",
    ]) {
      assert.ok(
        markup.includes(`value="${binding}"`),
        `the ${binding} row must show the desktop default binding`,
      );
    }
  });

  test("the two dictation rows render 未设置 with no ✕ affordance", () => {
    const unsetBindings = markup.match(/placeholder="未设置"/g) ?? [];
    assert.equal(unsetBindings.length, 2, "hold-dictation and toggle-dictation are unset");
    for (const id of ["hold-dictation", "toggle-dictation"]) {
      assert.ok(!markup.includes(`data-testid="settings-shortcuts-binding-${id}-clear"`),
        `an unset row must not render the clear button (${id})`);
    }
  });

  test("every binding input and every ✕ / ↺ affordance renders disabled", () => {
    // The binding ids and their clear-button ids share a prefix, so split
    // them by suffix before counting (10 boxes, 8 clear buttons).
    const ids = (markup.match(/data-testid="(settings-shortcuts-binding-[a-z-]+)"/g) ?? []).map(
      (match) => match.slice('data-testid="'.length, -1),
    );
    const boxes = ids.filter((id) => !id.endsWith("-clear"));
    const clears = ids.filter((id) => id.endsWith("-clear"));
    assert.equal(boxes.length, 10, "one binding box per shortcut row");
    for (const id of boxes) {
      assert.ok(
        controlMarkup(markup, id).includes("disabled"),
        `${id} must be a disabled control`,
      );
    }
    // 8 set rows carry the ✕ clear (the two unset rows do not).
    assert.equal(clears.length, 8, "one clear per set row");
    for (const id of clears) {
      assert.ok(controlMarkup(markup, id).includes("disabled"));
    }
    // The ↺ reset renders only on the Mini Chat row, disabled.
    assert.ok(!markup.includes('data-testid="settings-shortcuts-reset-global-search"'));
    const reset = controlMarkup(markup, "settings-shortcuts-reset-mini-chat");
    assert.ok(reset.includes("disabled"), "the reset affordance must be dead");
  });
});

describe("VoiceSection renders the A1 placeholders", () => {
  const markup = render(createElement(VoiceSection, { t: tZh }));

  test("the mic dropdown's only option is the standing marker, and it is disabled", () => {
    const mic = controlMarkup(markup, "settings-voice-mic-select");
    assert.ok(mic.includes("ant-select-disabled"), "the select must render disabled");
    assert.ok(markup.includes("本地版不适用"), "no fabricated device list may ship");
    assert.ok(!markup.includes("系统默认"), "the reference's 系统默认 entry implies a device source");
  });

  test("the two dictation rows render the desktop's unset state", () => {
    assert.ok(markup.includes('data-testid="settings-voice-hold-row"'));
    assert.ok(markup.includes('data-testid="settings-voice-toggle-row"'));
    const unset = markup.match(/placeholder="未设置"/g) ?? [];
    assert.equal(unset.length, 2);
    assert.ok(!markup.includes("-clear"), "unset rows carry no clear affordance");
  });
});

describe("PersonalizationSection: two real persisted blocks, honest memory card", () => {
  beforeEach(() => {
    storage.clear();
  });

  test("the two text blocks render the reference titles, placeholders, ⓘ and save actions", () => {
    const markup = render(createElement(PersonalizationSection, { t: tZh }));
    for (const title of ["自定义指令", "关于你", "记忆", "主动记忆", "记忆摘要"]) {
      assert.ok(markup.includes(title), `${title} must render`);
    }
    assert.ok(markup.includes("定义 Agent 应该如何工作、回答和执行任务"));
    assert.ok(markup.includes("告诉 Agent 你的背景和长期偏好"));
    // The three ⓘ glyphs of this page (two text blocks + the memory
    // card) — the Icon renders as a bare svg, so count glyphs.
    assert.equal(
      (markup.match(/<svg/g) ?? []).length,
      3,
      "two block ⓘ glyphs plus the memory card's ⓘ",
    );
  });

  test("the save actions stay disabled while the draft equals the stored value", () => {
    const markup = render(createElement(PersonalizationSection, { t: tZh }));
    for (const testId of [
      "settings-personalization-instructions-save",
      "settings-personalization-about-save",
    ]) {
      assert.ok(
        controlMarkup(markup, testId).includes("disabled"),
        `${testId} must be disabled on an unchanged (empty) block`,
      );
    }
  });

  test("a stored value hydrates into its textarea (refresh-restore contract)", () => {
    storage.set(CUSTOM_INSTRUCTIONS_KEY, "总是用中文回复");
    storage.set(ABOUT_USER_KEY, "我是前端工程师");
    const markup = render(createElement(PersonalizationSection, { t: tZh }));
    assert.ok(markup.includes("总是用中文回复"), "custom instructions hydrate from storage");
    assert.ok(markup.includes("我是前端工程师"), "about-you hydrates from storage");
  });

  test("the memory card: both switches off and greyed with the marker, 管理 enabled", () => {
    const markup = render(createElement(PersonalizationSection, { t: tZh }));
    assert.equal(
      (markup.match(/ant-switch-disabled/g) ?? []).length,
      2,
      "记忆 and 主动记忆 both render disabled switches",
    );
    // Both render OFF: the desktop's 记忆 row shows its live blue ON
    // state, which is a capability claim this client cannot make — an
    // on-looking switch next to 本地版不适用 would be the dishonest
    // form. antd's disabled state alone also keeps a checked track at
    // full blue, so the off-state carries an opacity coat.
    assert.equal((markup.match(/ant-switch-checked/g) ?? []).length, 0);
    assert.equal((markup.match(/opacity-40/g) ?? []).length, 2);
    // Each switch row carries the standing marker line (credits-card
    // precedent) — the visible honesty signal, not a tooltip.
    assert.equal((markup.match(/本地版不适用/g) ?? []).length, 2);
    const manage = controlMarkup(markup, "settings-memory-summary-manage");
    assert.ok(!manage.includes("disabled"), "管理 opens the placeholder dialog — it must be live");
    assert.ok(markup.includes("管理"));
  });

  test("the 记忆摘要 dialog is not mounted until 管理 opens it", () => {
    const markup = render(createElement(PersonalizationSection, { t: tZh }));
    assert.ok(!markup.includes('data-testid="settings-memory-summary-modal"'));
  });
});

describe("MemorySummaryModal: the permanent empty state", () => {
  const markup = render(
    createElement(MemorySummaryModal, { t: tZh, onClose: () => {} }),
  );

  test("title, placeholder and the empty-state line all render", () => {
    assert.ok(markup.includes('data-testid="settings-memory-summary-modal"'));
    assert.ok(markup.includes("记忆摘要"));
    assert.ok(markup.includes("MiniMax 整理的长期记忆会显示在这里。"));
    assert.ok(markup.includes("尚未生成记忆摘要"));
  });

  test("the honest 0 count renders in its own slot", () => {
    const at = markup.indexOf('data-testid="settings-memory-summary-count"');
    assert.ok(at >= 0, "the count slot must render");
    const close = markup.indexOf("</span>", at);
    const count = markup.slice(at, close);
    assert.ok(count.endsWith(">0"), "the count is the summary's real length (0)");
  });

  test("textarea dead, 取消 live, 保存 disabled", () => {
    assert.ok(
      controlMarkup(markup, "settings-memory-summary-textarea").includes("disabled"),
      "no local memory source — the field cannot be editable",
    );
    assert.ok(
      !controlMarkup(markup, "settings-memory-summary-cancel").includes("disabled"),
      "取消 closes the dialog",
    );
    assert.ok(
      controlMarkup(markup, "settings-memory-summary-save").includes("disabled"),
      "保存 stays disabled: there is nothing to write",
    );
  });

  test("the dialog card paints the real surface token (light-theme visibility)", () => {
    // Regression pin (the ticket-53 lesson): an earlier revision styled the
    // card `bg-bg_default`, which is NOT a token class — tokens.css has no
    // `--bg_default` — so Tailwind silently dropped it and the dialog
    // rendered transparent over the blanket in BOTH themes. Assert the
    // class that actually resolves, and that the invalid one is gone.
    assert.ok(markup.includes("bg-bg_default_primary"), "the card carries bg_default_primary");
    assert.ok(!markup.includes("bg-bg_default "), "the non-token bg-bg_default class must not ship");
  });
});

describe("CodeReviewSection: disabled method dropdown, real guideline persistence", () => {
  beforeEach(() => {
    storage.clear();
  });

  test("the card renders the reference's head, method row and guideline block", () => {
    const markup = render(createElement(CodeReviewSection, { t: tZh }));
    assert.ok(markup.includes('data-testid="settings-code-review-card"'));
    assert.ok(markup.includes("自定义内置代码审查指令的执行方式与审查准则"));
    assert.ok(markup.includes("审查方式"));
    assert.ok(markup.includes("子会话"));
    assert.ok(markup.includes("输入需要长期应用的代码审查规则"));
  });

  test("the method dropdown shows 子会话 as its only — disabled — option", () => {
    const markup = render(createElement(CodeReviewSection, { t: tZh }));
    const select = controlMarkup(markup, "settings-code-review-method-select");
    assert.ok(select.includes("ant-select-disabled"), "no second review mode exists locally");
  });

  test("a stored guideline hydrates; an unchanged block keeps save disabled", () => {
    storage.set(CODE_REVIEW_GUIDELINES_KEY, "不要吞异常");
    const markup = render(createElement(CodeReviewSection, { t: tZh }));
    assert.ok(markup.includes("不要吞异常"), "the guideline hydrates from storage");
    assert.ok(
      controlMarkup(markup, "settings-code-review-guidelines-save").includes("disabled"),
      "hydrated-but-unchanged is not dirty — save stays disabled",
    );
  });
});

describe("the three long-text keys (settings-local, ticket 55a)", () => {
  beforeEach(() => {
    storage.clear();
  });

  test("the keys live in the webui- namespace (desktop key names unverified)", () => {
    assert.equal(CUSTOM_INSTRUCTIONS_KEY, "webui-custom-instructions");
    assert.equal(ABOUT_USER_KEY, "webui-about-user");
    assert.equal(CODE_REVIEW_GUIDELINES_KEY, "webui-code-review-guidelines");
  });

  test("missing / corrupted storage reads as the empty string, never throws", () => {
    storage.set(CUSTOM_INSTRUCTIONS_KEY, "\u0000corrupt");
    assert.equal(readCustomInstructions(), "\u0000corrupt", "verbatim read — no validation");
    assert.equal(readAboutUser(), "");
    assert.equal(readCodeReviewGuidelines(), "");
  });

  test("commit helpers persist BEFORE the setState forward, verbatim", () => {
    for (const [commit, key, read] of [
      [commitCustomInstructions, CUSTOM_INSTRUCTIONS_KEY, readCustomInstructions],
      [commitAboutUser, ABOUT_USER_KEY, readAboutUser],
      [commitCodeReviewGuidelines, CODE_REVIEW_GUIDELINES_KEY, readCodeReviewGuidelines],
    ] as const) {
      storage.clear();
      let observed: string | undefined;
      commit((value: string) => {
        observed = storage.get(key);
      }, "保存我");
      assert.equal(observed, "保存我", `${key}: the write must land before the forward`);
      assert.equal(read(), "保存我");
    }
  });
});
