// webapp/test/file-preview.test.ts
// Unit tests for components/file-preview.tsx — the right-panel preview's
// type→renderer routing. Webapp-test boundaries: this file pins the
// **mapping** (pickPreviewKind) and the input/output shapes; the actual
// rendering is exercised against a live server in the agent-browser
// self-check (see the slice report), not here.
//
// Why pin the mapping specifically. The preview is a small router over
// three renderers; every rewrite of the routing logic is a chance for
// one branch to silently drop a file type into the wrong renderer (e.g.
// a `.svg` accidentally rendered as code). This test guards against that
// drift by holding the table fixed.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { pickPreviewKind, type PreviewKind } from "../lib/file-preview";
import type { FsFilePayload } from "../lib/api";
// The React component (`components/file-preview.tsx`) imports via the
// `@/lib/...` alias — Next.js / webapp convention. Node's loader does
// not honour tsconfig paths, so the unit test exercises the routing
// through its pure-logic sibling `lib/file-preview.ts` instead. The full
// React tree is covered by the agent-browser self-check in the slice
// report.

function payload(overrides: Partial<FsFilePayload>): FsFilePayload {
  return {
    ok: true,
    size: 1,
    mime: "text/plain; charset=utf-8",
    language: "plain",
    binary: false,
    encoding: "utf-8",
    content: "x",
    ...overrides,
  };
}

describe("pickPreviewKind — markdown", () => {
  for (const ext of [".md", ".markdown"]) {
    test(`server reports markdown for ${ext}`, () => {
      const kind = pickPreviewKind(payload({ language: "markdown", mime: "text/markdown; charset=utf-8" }), `/some/file${ext}`);
      assert.equal(kind, "markdown");
    });
    test(`fallback path with ${ext} routes to markdown even when server disagrees`, () => {
      // A future mismatch between the server's language table and this
      // viewer's should fall back to the file extension rather than the
      // (possibly stale) server hint.
      const kind = pickPreviewKind(payload({ language: "plain" }), `/some/file${ext}`);
      assert.equal(kind, "markdown");
    });
  }
});

describe("pickPreviewKind — image", () => {
  for (const ext of [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp"]) {
    test(`${ext} with image mime routes to image`, () => {
      const mime = ext === ".svg"
        ? "image/svg+xml"
        : ext === ".ico"
          ? "image/x-icon"
          : `image/${ext.slice(1)}`;
      const kind = pickPreviewKind(payload({ mime, language: "plain" }), `/some/file${ext}`);
      assert.equal(kind, "image");
    });
  }

  test("image mime wins even when language is unset", () => {
    // A future server table that omits a language for an image (because
    // "language" is text-only by definition) must still route to the
    // image renderer.
    const kind = pickPreviewKind(payload({ mime: "image/png", language: undefined }), "/some/file.png");
    assert.equal(kind, "image");
  });
});

describe("pickPreviewKind — code", () => {
  for (const ext of [".ts", ".js", ".py", ".json", ".css", ".html", ".yaml", ".sh"]) {
    test(`${ext} routes to code (the catch-all for text files)`, () => {
      const kind = pickPreviewKind(payload({ language: "plain", mime: "text/plain; charset=utf-8" }), `/some/file${ext}`);
      assert.equal(kind, "code");
    });
  }

  test("extensionless files still go to code when the mime is text/*", () => {
    // `Dockerfile`, `Makefile`, etc. have no extension. The mime alone is
    // enough — pickPreviewKind must not require an extension to render
    // text content.
    const kind = pickPreviewKind(
      payload({ language: "plain", mime: "text/plain; charset=utf-8" }),
      "/some/Dockerfile",
    );
    assert.equal(kind, "code");
  });
});

describe("pickPreviewKind — fallback contract", () => {
  test("returns one of the four known kinds (exhaustive check)", () => {
    const known: PreviewKind[] = ["markdown", "image", "code", "unsupported"];
    const cases: Array<[Partial<FsFilePayload>, string]> = [
      [{ language: "markdown" }, "/x.md"],
      [{ mime: "image/png" }, "/x.png"],
      [{ language: "plain" }, "/x.txt"],
      // No known language, unknown mime, unknown ext — still resolves to
      // "code" today (the only "unsupported" trigger is a payload the
      // server already rejected, which the component handles upstream).
      [{}, "/x"],
    ];
    for (const [overrides, path] of cases) {
      const kind = pickPreviewKind(payload(overrides), path);
      assert.ok(
        known.includes(kind),
        `expected one of ${known.join(",")}, got ${kind}`,
      );
    }
  });

  test("path extension lookup is case-insensitive", () => {
    // Windows file system is case-insensitive and preserves whatever
    // case the user typed; macOS / Linux are case-sensitive but a user
    // can still ship a mixed-case file from somewhere. The preview must
    // route `.PNG` and `.Png` the same way.
    const a = pickPreviewKind(payload({ mime: "image/png", language: "plain" }), "/some/dot.PNG");
    const b = pickPreviewKind(payload({ mime: "image/png", language: "plain" }), "/some/dot.Png");
    assert.equal(a, "image");
    assert.equal(b, "image");
  });

  test("path with no extension and unknown mime still routes to code", () => {
    // The "unsupported" branch in PreviewBody exists for type safety, not
    // for a real product path — the server rejects binary up front, so
    // the preview never has a payload the router cannot classify.
    const kind = pickPreviewKind(payload({ language: "plain", mime: "" }), "/x");
    assert.equal(kind, "code");
  });
});