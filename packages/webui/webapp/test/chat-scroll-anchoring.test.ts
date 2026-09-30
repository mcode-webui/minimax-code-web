// webui/test/chat-scroll-anchoring.test.ts
//
// The chat scroller's scroll offset is owned by three things only: the tail
// follow, the reader, and the persisted-position restore. The browser's scroll
// anchoring is a fourth, implicit owner — and it is the one that breaks the
// follow, because the off-switch reads "the container moved off my pin" and
// cannot attribute the move.
//
// Measured on the dev instance before this rule existed: with a turn streaming
// and the follow active, the offset jumped 55 → 125 px with no input event,
// while the transcript grew above the viewport. The follow read that as the
// reader leaving, switched itself off, and the answer went back to being
// stranded below the fold.
//
// A stylesheet rule cannot be exercised without a browser, so this is a
// source tripwire: it pins that the scroller carries the class, that the class
// is defined, and that the definition disables anchoring. The behaviour itself
// is verified end-to-end against an isolated instance (see
// `.tickets/webui-parity/88-streaming-bubble-visibility.md`).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const chatSource = readFileSync(new URL("../components/chat.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

describe("chat scroller opts out of browser scroll anchoring", () => {
  test("the scroller element carries the class", () => {
    assert.match(
      chatSource,
      /className="chat-scroll scrollbar-hide[^"]*"/,
      "the scroller div must carry the chat-scroll class",
    );
  });

  test("the class disables overflow anchoring", () => {
    assert.match(
      css,
      /\.chat-scroll\s*\{\s*overflow-anchor:\s*none;\s*\}/,
      "globals.css must define .chat-scroll with overflow-anchor: none",
    );
  });

  test("the rule is hand-written, not a Tailwind utility", () => {
    // A utility would be purged by a content-scan miss and renamed by a
    // Tailwind upgrade. globals.css places every hand-written rule outside
    // @layer for exactly that reason; keep the two in step.
    const ruleIndex = css.indexOf(".chat-scroll {");
    assert.ok(ruleIndex > 0, "the .chat-scroll rule must exist");
    const before = css.slice(0, ruleIndex);
    const openLayers = (before.match(/@layer\s+\w+\s*\{/g) ?? []).length;
    const closeLayers = (before.match(/\n\}/g) ?? []).length;
    assert.ok(
      openLayers <= closeLayers,
      "the .chat-scroll rule must sit outside any @layer block",
    );
    assert.doesNotMatch(chatSource, /overflow-anchor-none/, "do not spell it as a utility");
  });
});
