// webapp/test/settings-log-export.test.ts
//
// SB-8 (D-3) — the About section's 「导出日志」 replaced a disabled
// 「上传日志」 button.
//
// Why a static tripwire and not a render test: the About row lives inside
// `settings-modal-port.tsx`, whose module graph reaches the store and the
// api client, so the webapp suite (server-render only, no DOM harness — see
// settings-parity-nav.test.ts's header for the standing rule) cannot mount
// it. The URL helper is import-clean and IS driven directly below; the row's
// wiring is pinned as source, the same split `settings-account-readout`
// established for the account section.
//
// The defect each guard exists for:
//
//   - The button must not be disabled. The whole point of D-3 is that the
//     action became real; a `disabled` left on it re-creates the placeholder
//     under a truthful label, which is worse than the old one because the
//     label now promises a working download.
//   - It must be an ANCHOR at the export endpoint with a `download`
//     attribute, not a button whose onClick a reader assumes fetches. The
//     endpoint answers `text/plain`; without `download` the click navigates
//     the app away to a wall of log lines.
//   - The 「上传日志」 vocabulary must be gone from the component AND the
//     dictionary in both locales (i18n-settings-parity.test.ts pins the
//     dictionary half).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { logsExportUrl } from "../lib/api";
import { translate, type MessageKey } from "../lib/i18n";

const here = dirname(fileURLToPath(import.meta.url));
const portSource = readFileSync(resolve(here, "../components/settings-modal-port.tsx"), "utf8");

/** The About row's SettingRow, from its opening tag to its closing tag. */
function aboutRowBlock(): string {
  const at = portSource.indexOf('testId="export-logs-row"');
  assert.ok(at > 0, "the export-logs row must be declared");
  return portSource.slice(portSource.lastIndexOf("<SettingRow", at), portSource.indexOf("</SettingRow>", at));
}

describe("logsExportUrl points at the endpoint that exists", () => {
  test("is the export path, carrying the client query when one exists", () => {
    const url = logsExportUrl();
    assert.match(url, /^\/api\/logs\/export(\?.*)?$/);
    // `withClientQuery` is what carries `?cid=` (and the token when set) —
    // the same client identity every other call in api.ts sends.
    assert.ok(!url.includes("?format="), "the endpoint has no format parameter to fill in");
  });
});

describe("the About row (settings-modal-port.tsx)", () => {
  test("the export action is a live anchor, not a disabled button", () => {
    // The anchor itself is declared once, in the `SettingsLink` helper; the
    // About row supplies its href. Both halves are pinned, because a
    // `download` attribute lost in the helper and a `disabled` prop added
    // at the call site are the two ways this action dies silently.
    const helper = portSource.slice(
      portSource.indexOf("function SettingsLink("),
      portSource.indexOf("function SettingRow("),
    );
    assert.match(helper, /<a\b/, "an anchor: the browser owns the download");
    assert.match(helper, /\n\s+download\b/, "the download attribute is what saves instead of navigating");
    assert.match(helper, /data-testid=\{testId\}/, "the helper forwards the caller's testId");
    assert.ok(!/disabled/.test(helper), "the helper takes no disabled state at all");

    const call = portSource.slice(
      portSource.indexOf("<SettingsLink"),
      portSource.indexOf("</SettingsLink>"),
    );
    assert.ok(call.includes('testId="export-logs-action"'), "the About row is the caller");
    assert.ok(call.includes("api.logsExportUrl()"), "the href comes from the shared helper");
    assert.ok(!/disabled/.test(call), "D-3's whole point is that this action is live");
  });

  test("the row is titled as an export and says nothing leaves the machine", () => {
    const row = aboutRowBlock();
    assert.ok(row.includes('t("settings.about.exportLogs")'), "row title key");
    assert.ok(row.includes('t("settings.about.exportLogsHint")'), "row hint key");
    const hint = translate("zh", "settings.about.exportLogsHint" as MessageKey);
    assert.match(hint, /不会上传/, "the zh hint must deny the upload it replaced");
    assert.match(translate("en", "settings.about.exportLogsHint" as MessageKey), /nothing is uploaded/);
  });

  test("no 「上传日志」 vocabulary survives in the component", () => {
    for (const key of ["settings.about.uploadLogs", "settings.about.uploadLogsHint", "settings.about.uploadUnavailable", "settings.about.uploadAction"]) {
      assert.ok(!portSource.includes(key), `${key} must not be referenced any more`);
    }
    // The prose check reads the component with its comments stripped: the
    // SB-8 comment above the row quotes the old label on purpose, and a
    // comment cannot reach the user.
    const code = portSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    assert.ok(!/Upload logs|上传日志/.test(code), "no live markup may still name the upload action");
  });

  test("the check-for-update row is untouched — it is still an honest placeholder", () => {
    // D-3 renamed ONE row. 检查更新 has no honest local implementation
    // (self-hosted update = git pull), so it keeps its disabled form; a
    // "while we were here" de-disabling would be the same lie D-3 removed.
    const at = portSource.indexOf('t("settings.about.checkUpdate")');
    assert.ok(at > 0, "the update row still exists");
    const window = portSource.slice(Math.max(0, at - 400), at);
    assert.match(window, /SettingsButton[^]*disabled|disabled[^]*SettingsButton/, "the update button stays disabled");
  });
});
