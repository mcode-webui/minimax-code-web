// webapp/test/review-link.test.ts
//
// PB-16 (`doc/placeholder-batch-plan.md` §6.3): the client half of the
// 「Review」 control on the 「已编辑 N 个文件」 card.
//
// The rule this suite exists to pin is that the control NEVER PROMISES MORE
// THAN THE ENGINE ESTABLISHED. Three ways it could, and one test each:
//
//   1. treating "the server answered 200 with no link" and "the engine never
//      answered" as the same state. They are not: the first is a fact about
//      the user's repository, the second is a broken window, and the two
//      send the user to different places. `reviewLinkStateOf` is the only
//      place that decides, so every branch is pinned here.
//
//   2. handing the raw record to `window.open`. The wire record is untyped
//      and came from a file on disk; a `javascript:` url or a missing number
//      must not become a clickable control. `normaliseReviewLink` drops those
//      whole, exactly as the server's own projection does.
//
//   3. rendering the button without knowing whether it can work. The card's
//      own tests cover the rendering; what matters here is that the state
//      the card receives is one of exactly four sentences, never a fifth
//      vague one.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  normaliseReviewLink,
  reviewLinkStateOf,
  type ReviewLinkDisabled,
  type ReviewLinkState,
} from "../lib/review-link";
import {
  REVIEW_DISABLED_KEYS,
  reviewDisabledReasonKey,
  type ReviewLinkInertState,
} from "../components/edited-files-card";

const RECORDED = {
  vendor: "github",
  url: "https://github.com/acme/demo/pull/42",
  number: 42,
  branch: "feat/review",
  origin: "created",
  recordedAt: 1_700_000_000_000,
};

describe("normaliseReviewLink — the untrusted boundary", () => {
  test("passes a complete record through, dropping fields the card cannot use", () => {
    const link = normaliseReviewLink(RECORDED);
    assert.deepEqual(link, {
      vendor: "github",
      url: "https://github.com/acme/demo/pull/42",
      number: 42,
      branch: "feat/review",
      origin: "created",
    });
  });

  test("accepts gitlab and the `viewed` origin", () => {
    const link = normaliseReviewLink({
      ...RECORDED,
      vendor: "gitlab",
      origin: "viewed",
      url: "https://gitlab.com/acme/demo/-/merge_requests/7",
    });
    assert.equal(link?.vendor, "gitlab");
    assert.equal(link?.origin, "viewed");
  });

  test("drops a record whose url is not http(s) — the control would open it", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "not a url",
      "",
    ]) {
      assert.equal(normaliseReviewLink({ ...RECORDED, url }), null, url);
    }
  });

  test("drops a record missing any field the store requires", () => {
    for (const key of ["vendor", "url", "number", "branch", "origin"] as const) {
      const broken: Record<string, unknown> = { ...RECORDED };
      delete broken[key];
      assert.equal(normaliseReviewLink(broken), null, `missing ${key}`);
    }
    assert.equal(normaliseReviewLink({ ...RECORDED, number: 0 }), null);
    assert.equal(normaliseReviewLink({ ...RECORDED, number: 1.5 }), null);
    assert.equal(normaliseReviewLink({ ...RECORDED, branch: "" }), null);
    assert.equal(normaliseReviewLink({ ...RECORDED, vendor: "bitbucket" }), null);
  });

  test("rejects anything that is not a record", () => {
    for (const raw of [null, undefined, 7, "https://example.com", [RECORDED]]) {
      assert.equal(normaliseReviewLink(raw), null, JSON.stringify(raw) ?? "undefined");
    }
  });
});

describe("reviewLinkStateOf — four sentences, never a fifth", () => {
  test("a recorded review is available", () => {
    const state = reviewLinkStateOf({ ok: true, reviewLink: RECORDED, reason: null });
    assert.equal(state.status, "available");
  });

  test("each server reason keeps its own identity", () => {
    for (const reason of ["unknown_workspace", "no_branch", "no_review_link"] as const) {
      const state = reviewLinkStateOf({ ok: true, reviewLink: null, reason });
      assert.equal(state.status, "unavailable", reason);
      assert.equal(state.status === "unavailable" && state.reason, reason);
    }
  });

  test("a thrown request is NOT 'no review' — it is 'the engine did not answer'", () => {
    // The distinction the plan asks for: 400 / 501 / 503 all land here, and
    // none of them may be rendered as "this branch has no review".
    for (const failure of [new Error("HTTP 503"), new Error("HTTP 501"), new Error("offline")]) {
      const state = reviewLinkStateOf(null, failure);
      assert.equal(state.status, "unavailable");
      assert.equal(state.status === "unavailable" && state.reason, "engine_unavailable");
    }
  });

  test("a 200 the client cannot interpret is a refusal, not a guess", () => {
    for (const raw of [null, undefined, "ok", 42, {}, { ok: true }, { ok: true, reviewLink: null }]) {
      const state = reviewLinkStateOf(raw);
      assert.equal(state.status, "unavailable", JSON.stringify(raw) ?? "undefined");
      assert.equal(
        state.status === "unavailable" && state.reason,
        "engine_unavailable",
        JSON.stringify(raw) ?? "undefined",
      );
    }
  });

  test("an unusable record falls back to the server's reason, not to a link", () => {
    const state = reviewLinkStateOf({
      ok: true,
      reviewLink: { ...RECORDED, url: "javascript:alert(1)" },
      reason: "no_review_link",
    });
    assert.equal(state.status, "unavailable");
    assert.equal(state.status === "unavailable" && state.reason, "no_review_link");
  });
});

describe("the disabled control always has its own sentence", () => {
  test("every reason maps to a distinct i18n key", () => {
    const keys = Object.values(REVIEW_DISABLED_KEYS);
    assert.equal(new Set(keys).size, keys.length, "no two reasons share a sentence");
    assert.equal(Object.keys(REVIEW_DISABLED_KEYS).length, 4);
  });

  test("each state resolves to a key, including the loading state", () => {
    const states: ReviewLinkInertState[] = [
      { status: "loading" },
      { status: "unavailable", reason: "unknown_workspace" },
      { status: "unavailable", reason: "no_branch" },
      { status: "unavailable", reason: "no_review_link" },
      { status: "unavailable", reason: "engine_unavailable" },
    ];
    const resolved = states.map(reviewDisabledReasonKey);
    for (const key of resolved) assert.equal(typeof key, "string");
    assert.equal(new Set(resolved).size, resolved.length, "five states, five sentences");
  });

  test("an available state is never rendered as a reason", () => {
    // The table is total over the UNAVAILABLE reasons only; an available link
    // must not fall through it, which is why the card checks `status` first.
    const reasons: ReviewLinkDisabled[] = [
      "unknown_workspace",
      "no_branch",
      "no_review_link",
      "engine_unavailable",
    ];
    assert.deepEqual(Object.keys(REVIEW_DISABLED_KEYS).sort(), [...reasons].sort());
  });
});