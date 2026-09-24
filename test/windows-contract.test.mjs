import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { checkWindowsSourceLocation } from "../scripts/check-windows-source-location.mjs";
import { resolveWslPath } from "../packages/tui/src/host/wsl-path.js";

const windowsPath = String.raw`D:\Users\demo\Documents\Screen shots\截图.png`;

describe.skipIf(process.platform !== "win32")("Windows source contract", () => {
  // Two *synchronous* `fsutil` spawns. Vitest's default 5s budget is not enough
  // for that on a loaded Windows runner — measured 8.4s in CI, where the failure
  // is a timeout rather than a wrong answer. The first spawn of a binary on a
  // Defender-scanned volume pays the scan; on main's own run the same test
  // passed inside the default, which is what makes this look flaky rather than
  // broken. A generous explicit budget keeps what the test actually asserts —
  // that a real Windows host accepts this checkout on a local NTFS volume —
  // without turning it into a stopwatch on the runner.
  it("accepts the Windows checkout on a local NTFS volume", { timeout: 60_000 }, () => {
    assert.deepEqual(checkWindowsSourceLocation(), {
      ok: true,
      skipped: false,
    });
  });

  it("preserves Windows path syntax on the native host", async () => {
    assert.equal(await resolveWslPath(windowsPath), windowsPath);
  });
});
