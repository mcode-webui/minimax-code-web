// webapp/test/markdown-toc.test.ts
//
// Unit tests for the Markdown outline extractor (slice 27 — preview
// TOC). Pure logic over a minimal element-like shape: the component
// walks the RENDERED DOM (never re-parses the markdown source), and
// these tests pin the rules that walking must honour:
//
//   - only h1..h6 elements enter the outline; a mermaid block (a
//     `div.mermaid-block` / `pre.mermaid-source` pair, slice 23) is
//     NOT a chapter and must never appear — even if a future renderer
//     emits heading-shaped markup inside one;
//   - heading ids are stable (same text → same slug) and unique
//     (duplicate text gets a -2/-3 suffix, never a collision);
//   - the outline preserves document order and the heading level;
//   - a document with no headings yields an EMPTY outline (the panel
//     hides itself, it does not render an empty box).
//
// The DOM side (querySelectorAll + scroll spy) is exercised live in the
// slice-27 self-check against the built app; this suite pins the
// decision logic so a refactor cannot silently reorder or de-dupe the
// outline wrong.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  extractOutline,
  headingSlug,
  isOutlineHeading,
  type OutlineElement,
} from "../lib/markdown-toc";

/** Minimal element stub — the surface extractOutline/isOutlineHeading touch. */
function el(
  tagName: string,
  textContent: string,
  opts: { id?: string; closest?: (sel: string) => OutlineElement | null } = {},
): OutlineElement {
  return {
    tagName,
    textContent,
    getAttribute: (name: string) => (name === "id" ? opts.id ?? null : null),
    setAttribute: () => {},
    closest: opts.closest ?? (() => null),
  };
}

describe("headingSlug — stable ids for anchor jumps", () => {
  test("CJK text keeps its characters; separator runs collapse to one dash", () => {
    // Every non word-y run (space, 、, （≤, ，) becomes a single `-`;
    // the letters/digits themselves — CJK included — pass through.
    assert.equal(headingSlug("2 三、关键句（≤5，中英对照）"), "2-三-关键句-5-中英对照");
  });

  test("latin text lowercases and dashes words", () => {
    assert.equal(headingSlug("Getting Started!"), "getting-started");
  });

  test("empty / whitespace-only text still yields a non-empty id", () => {
    assert.ok(headingSlug("   ").length > 0);
    assert.ok(headingSlug("").length > 0);
  });

  test("same input always yields the same output (idempotent)", () => {
    assert.equal(headingSlug("安装 / Install"), headingSlug("安装 / Install"));
  });
});

describe("isOutlineHeading — what may enter the outline", () => {
  test("h1..h6 pass", () => {
    for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
      assert.equal(isOutlineHeading(el(tag, "x")), true, tag);
    }
  });

  test("paragraphs, list items, mermaid placeholders do not", () => {
    assert.equal(isOutlineHeading(el("p", "x")), false);
    assert.equal(isOutlineHeading(el("li", "x")), false);
    assert.equal(isOutlineHeading(el("div", "graph TD; A-->B")), false);
    assert.equal(isOutlineHeading(el("pre", "graph TD; A-->B")), false);
  });

  test("a heading nested inside a mermaid block is excluded (diagrams are not chapters)", () => {
    const mermaidHost = el("div", "");
    const heading = el("h3", "flowchart", {
      closest: (sel: string) => (sel === ".mermaid-block" ? mermaidHost : null),
    });
    assert.equal(isOutlineHeading(heading), false);
  });
});

describe("extractOutline — order, levels, ids", () => {
  test("walks document order, records levels, assigns ids when missing", () => {
    const outline = extractOutline([
      el("h1", "标题一"),
      el("h2", "安装"),
      el("h3", "从源码"),
      el("h2", "安装"),
      el("h1", "结语"),
    ]);
    assert.deepEqual(
      outline.map((e) => e.level),
      [1, 2, 3, 2, 1],
    );
    assert.deepEqual(
      outline.map((e) => e.text),
      ["标题一", "安装", "从源码", "安装", "结语"],
    );
    // First "安装" gets the bare slug; the duplicate gets -2.
    assert.equal(outline[1]!.id, "安装");
    assert.equal(outline[3]!.id, "安装-2");
  });

  test("keeps an explicit existing id instead of reassigning", () => {
    const outline = extractOutline([el("h2", "Custom", { id: "kept-id" })]);
    assert.equal(outline[0]!.id, "kept-id");
  });

  test("an empty document yields an empty outline (no placeholder entries)", () => {
    assert.deepEqual(extractOutline([]), []);
  });

  test("a document with only non-heading blocks yields an empty outline", () => {
    const outline = extractOutline([
      el("p", "just text"),
      el("div", "graph TD; A-->B"),
      el("pre", "graph TD; A-->B"),
    ]);
    assert.deepEqual(outline, []);
  });

  test("triple duplicates keep colliding ids apart (-2, -3)", () => {
    const outline = extractOutline([el("h2", "Notes"), el("h2", "Notes"), el("h2", "Notes")]);
    assert.deepEqual(
      outline.map((e) => e.id),
      ["notes", "notes-2", "notes-3"],
    );
  });
});
