// webui/webapp/test/theme-token-pairing.test.ts
//
// Guardrail for the "invisible label" class of bug (UAT 2026-10-03, defect 3).
//
// `--text_default_inverted_static` does NOT flip with the theme: it stays a
// near-white in both light and dark palettes. Paired with
// `--bg_interaction_primary_default` — which dark mode DOES invert to pure
// white — the label composites to white-on-white and vanishes. The pairing is
// correct only on top of status colors (bg_status_warning / bg_status_error),
// which stay saturated in dark mode (see toolbar.tsx badge).
//
// This scan keeps the pairing out of primary-interaction surfaces. If a future
// component genuinely needs inverted text over a self-provided non-flipping
// surface, add an explicit allowlist entry here with a comment saying why.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const WEBAPP_DIR = path.resolve(here, "..");
const SCAN_ROOTS = [
  path.join(WEBAPP_DIR, "components"),
  path.join(WEBAPP_DIR, "app"),
];

async function listTsxFiles(dir: string): Promise<string[]> {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listTsxFiles(full)));
    else if (entry.isFile() && entry.name.endsWith(".tsx")) out.push(full);
  }
  return out.sort();
}

test("no primary-interaction surface pairs with the non-flipping inverted text token", async () => {
  const offenders = [];
  for (const root of SCAN_ROOTS) {
    for (const file of await listTsxFiles(root)) {
      const source = await fs.readFile(file, "utf8");
      if (!source.includes("text-text_default_inverted_static")) continue;
      // An offender is a className string that carries BOTH the primary
      // interaction background and the non-flipping inverted token. The
      // bg classes and the text token appear in the same string when they
      // style the same element — that is the composite that vanishes.
      const classNameStrings =
        source.match(/"(?:[^"\\]|\\.)*text-text_default_inverted_static(?:[^"\\]|\\.)*"/g) ?? [];
      for (const raw of classNameStrings) {
        if (!raw.includes("bg-bg_interaction_primary_default")) continue;
        offenders.push(`${path.relative(WEBAPP_DIR, file)}: ${raw.slice(0, 100)}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "Found primary buttons whose label vanishes in dark theme. Use " +
      "text-text_label_primary_default (the token paired with " +
      "bg_interaction_primary) instead:\n" +
      offenders.join("\n"),
  );
});

test("the sanctioned exception survives: the toolbar status badge keeps its inverted token", async () => {
  // The toolbar badge sits on bg_status_warning / bg_status_error, which stay
  // saturated in dark mode — near-white text is correct there. If this file
  // ever drops the pairing, re-evaluate rather than blindly restoring it.
  const toolbarPath = path.join(WEBAPP_DIR, "components", "toolbar.tsx");
  const source = await fs.readFile(toolbarPath, "utf8");
  assert.match(source, /text-text_default_inverted_static/);
  assert.match(source, /bg-bg_status_(warning|error)/);
});
