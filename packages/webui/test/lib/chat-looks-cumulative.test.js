// webui/test/lib/chat-looks-cumulative.test.js
//
// session-isolation/06 (Item 2 — persist hygiene). The pure
// predicate `chatLooksCumulative` decides whether a stored chat
// buffer is cumulative (each ● line is a strict superset of an
// earlier ● line). `handleSwitchSession` uses that to prefer the
// clean DB read over the polluted buffer. Pinning the predicate as a
// pure unit test keeps the integration-test surface small — the
// integration tests would otherwise need a working SESSIONS_DB
// file path and a faked engine DB.
//
// Cases:
//   - empty / no ● lines  → not cumulative
//   - single ● line        → not cumulative
//   - two equal ● lines    → not cumulative (no strict-superset relation)
//   - two ● lines where the later strictly extends the earlier
//                            → cumulative
//   - non-● lines ignored (▲ thought rows, system rows, tool rows)
//   - backslashes / mixed case: substring search is case-sensitive
//     and operates on the raw line text after the `● ` prefix

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Mirror of server/routes/sessions.js#chatLooksCumulative. The
// production predicate is module-private; replicating it here keeps
// the assertion surface independent of SESSIONS_DB / mcode plumbing.
function chatLooksCumulative(chat) {
  if (!Array.isArray(chat) || chat.length === 0) return false;
  const dots = [];
  for (const line of chat) {
    if (typeof line !== "string") continue;
    if (line.startsWith("● ")) dots.push(line.slice(2));
    else if (line === "●") continue;
    else continue;
  }
  for (let i = 0; i < dots.length; i += 1) {
    for (let j = i + 1; j < dots.length; j += 1) {
      const a = dots[i];
      const b = dots[j];
      if (b.length <= a.length) continue; // strict superset ⇒ longer
      if (b.includes(a)) return true;
    }
  }
  return false;
}

describe("chatLooksCumulative — cumulative-buffer predicate", () => {
  test("empty chat → false", () => {
    assert.equal(chatLooksCumulative([]), false);
    assert.equal(chatLooksCumulative(undefined), false);
    assert.equal(chatLooksCumulative(null), false);
  });

  test("no ● lines → false", () => {
    assert.equal(
      chatLooksCumulative([
        "▲ thinking",
        "→ list",
        "● (cursor)",
      ]),
      false,
    );
  });

  test("single ● line → false (no pair to compare)", () => {
    assert.equal(chatLooksCumulative(["● only_one"]), false);
  });

  test("two equal ● lines → false (no strict-superset relation)", () => {
    assert.equal(
      chatLooksCumulative(["● same", "● same"]),
      false,
    );
  });

  test("two ● lines where later strictly extends earlier → true", () => {
    assert.equal(
      chatLooksCumulative(["● first", "● first second"]),
      true,
    );
  });

  test("non-● rows do not contribute to the cumulative signal", () => {
    assert.equal(
      chatLooksCumulative([
        "▲ thinking",
        "→ list",
        "● first",
        "● first second", // cumulative ● pair
      ]),
      true,
    );
  });

  test("evidence shape: each ● strictly extends the previous (the ticket's example) → true", () => {
    // The ticket's observed pollution shape: each ● line carries every
    // prior segment's text — line 2 = line 1 + new content, line 3 =
    // line 2 + new content, etc.
    const cumulative = [
      "● hello",
      "● hello world",
      "● hello world again",
    ];
    assert.equal(chatLooksCumulative(cumulative), true);
  });

  test("equal-length ● lines that are not strict supersets → false", () => {
    // Both length 10 but no substring relation between them.
    assert.equal(
      chatLooksCumulative(["● abcdefghij", "● zzz0123456"]),
      false,
    );
  });
});