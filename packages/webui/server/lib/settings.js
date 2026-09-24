// webui/server/lib/settings.js
// Runtime-tunable settings + persistent storage.
//
// Persisted to ~/.mcode-webui/settings.json; loaded at init, every
// setter auto-writes.
//
// State: process.env.TOKEN always wins over settings.json (so env
// deployments and the GUI toggle don't fight).
//
// Atomic write: write .tmp, then rename — no half-written state on
// disk.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

import { getMcodeServerInfo } from "./acp-client.js";
import { getServingPort, HOST } from "./config.js";
import { LAN_IP, isLoopbackHost } from "./lan.js";
import { MCODE_CMD, DEFAULT_WORKSPACE, DEFAULT_MODEL } from "./config.js";

// Every setter writes a `settings.update.intent` event BEFORE the
// state change and a `settings.update` outcome event after it
// (write-ahead audit). events.js#append is fail-closed: an intent
// write failure aborts the change (no mutation happened yet); an
// outcome write failure propagates to the route, which answers 5xx +
// pushes an alert — the in-memory change is NOT rolled back (the
// persist already ran; hiding it would be worse than reporting it).
import { append as _eventsAppend } from "./events.js";

// Persistent settings file path.
//
// Override via env MCODE_WEBUI_SETTINGS_PATH (used by tests + for
// non-default installs). The path is resolved lazily so tests can set
// the env var before calling init() without re-importing the module.
const SETTINGS_DIR_DEFAULT = join(homedir(), ".mcode-webui");
const SETTINGS_PATH_DEFAULT = join(SETTINGS_DIR_DEFAULT, "settings.json");
function _settingsPath() {
  return process.env.MCODE_WEBUI_SETTINGS_PATH || SETTINGS_PATH_DEFAULT;
}
const SETTINGS_VERSION = 1;

// Fields an older webui persisted for its own Token Plan quota calls. The engine
// holds that credential and answers quota over ACP now, so these are no longer
// read; init() rewrites the file without them. Listed rather than inferred so
// the retirement stays visible in one place.
const RETIRED_KEY_FIELDS = ["quotaEnabled", "tokenPlanApiKey"];

function defaultState() {
  return {
    version: SETTINGS_VERSION,
    lanBroadcast: true,       // not persisted — reboot always re-enables LAN
    readOnly: false,
    tokenEnabled: true,
    currentToken: "",         // resolved by init()
    tokenRotatedAt: 0,
    tokenAcknowledged: false,
    // Persisted opt-in for the LAN bind. Default false → config.js
    // resolves the boot bind to loopback 127.0.0.1. true → next boot
    // binds 0.0.0.0 (env HOST still wins when set). Socket bind is
    // boot-time state; flipping this at runtime takes effect after
    // restart (disclosed via bindRestartPending in the snapshot).
    lanBind: false,
    // Explicit cross-origin allowlist reflected by the CORS gate in
    // router.js. Empty default — only origins the server itself
    // serves plus these entries are ever trusted. Sanitized at write
    // time (sanitizeTrustedOrigins).
    trustedOrigins: [],
  };
}

// In-memory state. `lanBroadcast` lives outside this struct because it
// is intentionally NOT persisted (admin-friendly: server reboot always
// re-enables LAN so users aren't locked out).
let lanBroadcastEnabled = true;
let readOnlyEnabled = false;
let tokenAuthEnabled = true;
let currentToken = "";
let tokenRotatedAt = 0;
let tokenAcknowledged = false;
let lanBindEnabled = false;
let trustedOriginsList = [];

// -----------------------------------------------------------------------
// Token generation
// -----------------------------------------------------------------------

// crypto.randomBytes(16).toString('hex') = 32 hex chars. Matches the
// 32-hex convention already used elsewhere in webui (CID, session id).
// 16 bytes = 128 bits entropy = far beyond the 2^80 brute-force floor.
export function generateToken() {
  return randomBytes(16).toString("hex");
}

// -----------------------------------------------------------------------
// Token lifecycle (delegate to auth.js via setter; here we just own the
//   in-memory + persistent state, the auth gate reads it through
//   getExpectedToken() in auth.js which calls back into the public getters
//   below)
// -----------------------------------------------------------------------

// applyExpectedTokenSync — sync the auth module's expected token to
// match our in-memory currentToken. Called by init() and after rotation.
// We do this in two places: settings.js owns the persistent state, auth.js
// owns the in-memory expectation + the gate logic. They are loosely
// coupled through the exported setters below.
import { setExpectedToken as _authSetExpectedToken } from "./auth.js";

function syncAuthToken() {
  // env TOKEN always wins (preserves v1.0.1 escape hatch)
  if (process.env.TOKEN) return;
  _authSetExpectedToken(currentToken);
}

// -----------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------

function ensureDir() {
  try {
    mkdirSync(dirname(_settingsPath()), { recursive: true });
  } catch (e) {
    // Best-effort: if we can't create the dir (permission denied etc.)
    // we still try to read the file (it may exist) and log the issue.
    console.warn(`[webui] settings mkdir ${dirname(_settingsPath())} failed: ${e.message}`);
  }
}

// Best-effort 0600 file open on Unix. On Windows, the OS doesn't enforce
// POSIX mode bits, but we still pass the mode to chmod-equivalent APIs.
// We use openSync to atomically create the file with mode 0600.
function writeAtomic(path, content) {
  ensureDir();
  let fd;
  try {
    fd = openSync(path + ".tmp", "w", 0o600);
  } catch (e) {
    // On Windows / some FS, 0o600 in openSync may not be honored; fall
    // back to plain writeFileSync (still atomic via .tmp + rename).
    writeFileSync(path + ".tmp", content, { encoding: "utf8", mode: 0o600 });
    renameSync(path + ".tmp", path);
    return;
  }
  try {
    const buf = Buffer.from(content, "utf8");
    writeFileSync(fd, buf);
  } finally {
    try { closeSync(fd); } catch {}
  }
  try {
    renameSync(path + ".tmp", path);
  } catch (e) {
    console.error(`[webui] settings rename ${path} failed: ${e.message}`);
    throw e;
  }
}

function loadFromDisk() {
  const path = _settingsPath();
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    console.error(`[webui] settings read ${path} failed: ${e.message}`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return parsed;
  } catch (e) {
    // Corrupt file — back it up + fall back to defaults
    console.error(`[webui] settings parse ${path} failed: ${e.message}; backing up to .bak and using defaults`);
    try {
      renameSync(path, path + ".bak");
    } catch {}
    return null;
  }
}

// Public, testable: build the JSON body that gets persisted.
// Excludes `lanBroadcast` (intentionally not persisted per the reboot
// policy above).
export function buildPersistBody() {
  return {
    version: SETTINGS_VERSION,
    readOnly: readOnlyEnabled,
    tokenEnabled: tokenAuthEnabled,
    currentToken: currentToken,
    tokenRotatedAt: tokenRotatedAt,
    tokenAcknowledged: tokenAcknowledged,
    lanBind: lanBindEnabled,
    trustedOrigins: trustedOriginsList,
  };
}

function persistNow() {
  try {
    writeAtomic(_settingsPath(), JSON.stringify(buildPersistBody(), null, 2));
  } catch (e) {
    console.error(`[webui] settings persist ${_settingsPath()} failed: ${e.message}`);
    throw e;
  }
}

// init() — load from disk, decide initial token, write back if needed.
//
// Behavior:
//   - On disk: load all fields from settings.json. Token survives restarts.
//   - No disk (first run):
//     1. Reset in-memory state to defaults (in case previous code in
//        the same process left stale state — e.g. tests that set fields
//        then re-init).
//     2. If process.env.TOKEN is set: don't touch currentToken; we don't
//        echo env-provided tokens to stdout.
//     3. Else: generate a fresh 32-hex token, write to disk, call
//        printToken (so the operator can see/copy it).
//   - We ALWAYS call persistNow() at the end of init() when onDisk is
//     empty (i.e. first run after a fresh dir or a corrupt file). For
//     the "we loaded from disk" case we don't write back — the in-memory
//     state is already the source of truth, no need to re-serialize.
export function init(opts = {}) {
  const { printToken } = opts;
  const onDisk = loadFromDisk();
  const d = defaultState();
  let firstRun = false;
  // Settings file written by a webui version that kept a Token Plan
  // Subscription Key here. See RETIRED_KEY_FIELDS.
  const carriesRetiredKey =
    !!onDisk && RETIRED_KEY_FIELDS.some((field) => field in onDisk);

  if (onDisk) {
    // Validate + apply
    if (typeof onDisk.readOnly === "boolean") readOnlyEnabled = onDisk.readOnly;
    if (typeof onDisk.tokenEnabled === "boolean") tokenAuthEnabled = onDisk.tokenEnabled;
    if (typeof onDisk.currentToken === "string") currentToken = onDisk.currentToken;
    if (typeof onDisk.tokenRotatedAt === "number") tokenRotatedAt = onDisk.tokenRotatedAt;
    if (typeof onDisk.tokenAcknowledged === "boolean") tokenAcknowledged = onDisk.tokenAcknowledged;
    if (typeof onDisk.lanBind === "boolean") lanBindEnabled = onDisk.lanBind;
    if (Array.isArray(onDisk.trustedOrigins)) {
      const s = sanitizeTrustedOrigins(onDisk.trustedOrigins);
      // On-disk garbage (hand-edited file): keep only the valid prefix —
      // never let a corrupt allowlist widen the CORS trust surface.
      trustedOriginsList = s.ok ? s.value : [];
    }
  } else {
    firstRun = true;
    // Reset in-memory state to defaults
    readOnlyEnabled = d.readOnly;
    tokenAuthEnabled = d.tokenEnabled;
    tokenAcknowledged = d.tokenAcknowledged;
    currentToken = "";
    tokenRotatedAt = 0;
    lanBindEnabled = d.lanBind;
    trustedOriginsList = [...d.trustedOrigins];
  }

  // Token resolution priority:
  //   1. process.env.TOKEN (highest — escape hatch for deploys)
  //   2. settings.json currentToken (if any, from onDisk)
  //   3. generate fresh
  if (process.env.TOKEN) {
    // env wins — do not touch currentToken
  } else if (firstRun) {
    // No env, no disk: generate fresh
    currentToken = generateToken();
    tokenRotatedAt = Date.now();
    tokenAcknowledged = false;
  } else if (!currentToken) {
    // Loaded from disk but token field was missing/empty (shouldn't happen
    // with a valid file, but be defensive). Generate.
    currentToken = generateToken();
    tokenRotatedAt = Date.now();
    tokenAcknowledged = false;
  } else {
    // We have a currentToken from disk; if tokenEnabled is true and
    // tokenAcknowledged is false, the operator presumably hasn't seen
    // the new token yet (rotation happened while they were away). We
    // DO NOT auto-print to stdout (that would leak on every restart
    // for users who already saw it). The settings card will show it
    // because tokenAcknowledged is false.
  }

  if (firstRun) {
    // Persist the freshly initialized state
    try { persistNow(); } catch {}
    // Print to stdout ONCE (not to file logs) so the operator sees it
    // if they're running interactively. Tests can pass a printToken
    // callback to capture or suppress the print.
    if (typeof printToken === "function") {
      try { printToken(currentToken); } catch {}
    }
  }

  // Sync to auth module
  syncAuthToken();

  // Retired: webui used to keep the operator's Token Plan Subscription Key in
  // settings.json and call MiniMax's quota endpoint itself. The engine owns that
  // credential and now answers the same question over ACP (see lib/usage.js), so
  // the field is dropped from disk on the first start that finds it — a
  // plaintext credential left behind for a feature that no longer reads it is
  // the residue this change exists to remove. persistNow() writes an explicit
  // field list (buildPersistBody), so that write is what removes it.
  if (carriesRetiredKey) {
    try {
      persistNow();
      console.log("[webui] settings.json: dropped the retired Token Plan key field");
    } catch (e) {
      console.warn(
        `[webui] settings.json: could not drop the retired Token Plan key field: ${e.message}`,
      );
    }
  }
}

// -----------------------------------------------------------------------
// Getters
// -----------------------------------------------------------------------

export function getLanBroadcast() {
  return lanBroadcastEnabled;
}

export function getReadOnly() {
  return readOnlyEnabled;
}

export function getTokenEnabled() {
  return tokenAuthEnabled;
}

export function getCurrentToken() {
  return currentToken;
}

export function getTokenRotatedAt() {
  return tokenRotatedAt;
}

export function getTokenAcknowledged() {
  return tokenAcknowledged;
}

// v2 security fix (PR #55 review point 2): persisted LAN-bind opt-in.
export function getLanBind() {
  return lanBindEnabled;
}

// v2 security fix (PR #55 review point 1): explicit trusted-origin
// allowlist for the CORS gate. Returns a copy — callers must not
// mutate the module's list.
//
// v2.5: `MCODE_WEBUI_TRUSTED_ORIGINS` (comma-separated) is merged in on
//   top. Why an env var rather than only the persisted list: the dev
//   setup runs the frontend on its own port (`next dev` on :18091) and
//   proxies /api/* through to :18090, so the browser's Origin is
//   `http://localhost:18091` — never the backend's own. router.js Gate 1b
//   rejects every non-GET with an untrusted Origin, which silently killed
//   the entire mutating API (switch/new/delete session, send, settings
//   save) in dev while GETs kept working. Checking this into a user's
//   settings.json on their behalf would be invasive and sticky; an env
//   var is per-process and opt-in, which is what a dev launcher wants.
//   Same sanitizer as the persisted path — fail-closed and normalized —
//   except that a malformed value is dropped with a warning rather than
//   rejecting the batch, because there is no caller to return 400 to.
export function getTrustedOrigins() {
  return [...new Set([...trustedOriginsList, ...envTrustedOrigins()])];
}

/** `MCODE_WEBUI_TRUSTED_ORIGINS` split, sanitized, invalid entries dropped. */
function envTrustedOrigins() {
  const raw = (process.env.MCODE_WEBUI_TRUSTED_ORIGINS || "").trim();
  if (!raw) return [];
  // Parsed once per distinct value: getTrustedOrigins() runs on every request, and
  // a rejected entry would otherwise re-log on each one.
  if (raw === _envOriginsRaw) return _envOriginsCache;
  const out = [];
  for (const candidate of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const one = sanitizeTrustedOrigins([candidate]);
    if (one.ok) out.push(...one.value);
    else console.warn(`[webui] ignoring MCODE_WEBUI_TRUSTED_ORIGINS entry "${candidate.slice(0, 60)}": ${one.error}`);
  }
  _envOriginsRaw = raw;
  _envOriginsCache = out;
  return out;
}

let _envOriginsRaw = null;
let _envOriginsCache = [];

export function getAllowedInterfaces() {
  // Removed in v1.0.1 cleanup (per #16 reviewer scope). Kept as a
  // no-op stub for tests + clients that still call it — returns the
  // current "allow all" sentinel ([]).
  return [];
}

// getPersistPath — exposed for tests + startup log ("settings at ...")
export function getPersistPath() {
  return _settingsPath();
}

// -----------------------------------------------------------------------
// Setters (mutate in-memory + persist; on error, the in-memory state
//   has already changed — callers must decide what to do; we do NOT
//   revert to keep the in-memory state as source of truth).
// -----------------------------------------------------------------------

export function setLanBroadcast(v) {
  const before = lanBroadcastEnabled;
  const after = !!v;
  // Write-ahead intent — throws on audit failure before any mutation.
  if (before !== after) {
    _eventsAppend("settings.update.intent", {
      target: "lanBroadcast",
      actor: "user",
      payload: { old: before, new: after },
    });
  }
  lanBroadcastEnabled = after;
  // B01: audit toggle. lanBroadcast is intentionally NOT persisted
  // (the in-memory state survives only until reboot — reboot re-enables
  // it for admin lockout safety). But the toggle itself is a state-
  // changing action and SHOULD be auditable.
  if (before !== after) {
    _eventsAppend("settings.update", {
      target: "lanBroadcast",
      actor: "user",
      payload: { old: before, new: after },
    });
  }
  console.log(
    `[webui] LAN access ${lanBroadcastEnabled ? "enabled" : "disabled"}`,
  );
}

export function setReadOnly(v) {
  const before = readOnlyEnabled;
  const after = !!v;
  if (before !== after) {
    _eventsAppend("settings.update.intent", {
      target: "readOnly",
      actor: "user",
      payload: { old: before, new: after },
    });
  }
  readOnlyEnabled = after;
  console.log(`[webui] read-only mode ${readOnlyEnabled ? "enabled" : "disabled"}`);
  try { persistNow(); } catch (e) { /* logged in persistNow */ }
  if (before !== after) {
    _eventsAppend("settings.update", {
      target: "readOnly",
      actor: "user",
      payload: { old: before, new: after },
    });
  }
}

export function setTokenEnabled(v) {
  const before = tokenAuthEnabled;
  const after = !!v;
  if (before !== after) {
    _eventsAppend("settings.update.intent", {
      target: "tokenEnabled",
      actor: "user",
      payload: { old: before, new: after },
    });
  }
  tokenAuthEnabled = after;
  console.log(`[webui] token auth ${tokenAuthEnabled ? "enabled" : "disabled"}`);
  // No persist needed (lanBroadcast isn't persisted either; on the
  // v1.0.1 contract, tokenEnabled survives a restart by defaulting to
  // true). We DO persist it so a power-cycle keeps the user's choice.
  try { persistNow(); } catch {}
  if (before !== after) {
    _eventsAppend("settings.update", {
      target: "tokenEnabled",
      actor: "user",
      payload: { old: before, new: after },
    });
  }
}

export function setTokenAcknowledged(v) {
  const before = tokenAcknowledged;
  const after = !!v;
  if (before !== after) {
    _eventsAppend("settings.update.intent", {
      target: "tokenAcknowledged",
      actor: "user",
      payload: { old: before, new: after },
    });
  }
  tokenAcknowledged = after;
  try { persistNow(); } catch {}
  if (before !== after) {
    _eventsAppend("settings.update", {
      target: "tokenAcknowledged",
      actor: "user",
      payload: { old: before, new: after },
    });
  }
}

// -----------------------------------------------------------------------
// v2 security fix (PR #55 review points 1+2): lanBind + trustedOrigins.
// -----------------------------------------------------------------------

// Validate + normalize a candidate trustedOrigins array. Origin
// serialization only: scheme://host[:port], no path/query/userinfo —
// anything else fails the whole batch (fail-closed; the caller answers
// 400). Capped at 16 entries × 200 chars so a hostile POST can't bloat
// settings.json or the per-request trust-set build.
export function sanitizeTrustedOrigins(arr) {
  if (!Array.isArray(arr)) {
    return { ok: false, error: "trustedOrigins must be an array of strings" };
  }
  if (arr.length > 16) {
    return { ok: false, error: "trustedOrigins accepts at most 16 entries" };
  }
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    if (typeof raw !== "string") {
      return { ok: false, error: "trustedOrigins entries must be strings" };
    }
    const v = raw.trim().toLowerCase();
    if (v.length === 0 || v.length > 200) {
      return { ok: false, error: "trustedOrigins entry length must be 1..200" };
    }
    // http(s) origin only: host charset letters/digits/dot/dash plus
    // [ ]: for IPv6 literals and the optional port. No '/', '?', '#',
    // '@' — those widen matching or smuggle userinfo.
    if (!/^https?:\/\/[a-z0-9.\-\[\]]+(:\d{1,5})?$/.test(v)) {
      return { ok: false, error: `invalid origin: ${raw.slice(0, 60)}` };
    }
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return { ok: true, value: out };
}

export function setLanBind(v) {
  const before = lanBindEnabled;
  const after = !!v;
  if (before !== after) {
    _eventsAppend("settings.update.intent", {
      target: "lanBind",
      actor: "user",
      payload: { old: before, new: after },
    });
  }
  lanBindEnabled = after;
  try { persistNow(); } catch {}
  console.log(
    `[webui] LAN bind ${lanBindEnabled ? "enabled (binds 0.0.0.0 after restart)" : "disabled (binds loopback after restart)"}`,
  );
  if (before !== after) {
    _eventsAppend("settings.update", {
      target: "lanBind",
      actor: "user",
      payload: { old: before, new: after },
    });
  }
}

export function setTrustedOrigins(v) {
  const before = trustedOriginsList;
  const after = Array.isArray(v) ? [...v] : [];
  if (before.length !== after.length || before.some((o, i) => o !== after[i])) {
    _eventsAppend("settings.update.intent", {
      target: "trustedOrigins",
      actor: "user",
      payload: { old_count: before.length, new_count: after.length },
    });
  }
  trustedOriginsList = after;
  try { persistNow(); } catch {}
  if (before.length !== after.length || before.some((o, i) => o !== after[i])) {
    _eventsAppend("settings.update", {
      target: "trustedOrigins",
      actor: "user",
      payload: { old_count: before.length, new_count: trustedOriginsList.length },
    });
  }
}

export function setAllowedInterfaces(_ifaces) {
  // Removed in v1.0.1 cleanup (per #16 reviewer scope). No-op stub.
}

// rotateToken — generate a new token, persist, sync to auth module.
//   Caller is responsible for broadcasting the new token via SSE.
//   Returns the new token string.
//
// v1.0.1: order of operations is critical for crash-safety.
//   1. Generate the new token into a local variable (don't touch
//      module-level state yet).
//   2. Persist to disk FIRST. If this throws (disk full, permission
//      denied), in-memory state stays untouched — no inconsistency.
//   3. ONLY after persist succeeds, commit the new values to the
//      module-level lets and sync to the auth module.
//   This ensures the in-memory token ALWAYS matches what's on disk.
export function rotateToken() {
  const newToken = generateToken();
  const newRotatedAt = Date.now();
  // Persist into a *tentative* file first. We don't touch the
  // module-level state until persistNow() returns without throwing.
  // To do that without exposing a separate setter API, we temporarily
  // swap the in-memory values, persist, then either commit (good) or
  // roll back (throw → caught by caller, no in-memory change).
  const prevToken = currentToken;
  const prevRotatedAt = tokenRotatedAt;
  const prevAck = tokenAcknowledged;
  // Write-ahead intent (fail-closed): if the audit write fails we
  // throw BEFORE any state/persist mutation — the token stays as-is.
  // The flow-level token.reset.intent at the route (routes/settings.js)
  // covers the authorize→rotate span; this line covers direct
  // programmatic callers of rotateToken().
  _eventsAppend("token.rotate.intent", {
    target: "currentToken",
    actor: "user",
    payload: {
      old_present: prevToken.length > 0,
      rotatedAt: newRotatedAt,
    },
  });
  currentToken = newToken;
  tokenRotatedAt = newRotatedAt;
  tokenAcknowledged = false;
  try {
    persistNow();
  } catch (e) {
    // Roll back in-memory state to match what was on disk
    currentToken = prevToken;
    tokenRotatedAt = prevRotatedAt;
    tokenAcknowledged = prevAck;
    throw e;
  }
  // B01: token rotation is the highest-impact settings change — record
  // it after persist succeeds (so a rolled-back rotation has no event).
  // We log only the rotation timestamp, never the token value (security).
  // Outcome write failure propagates to the caller (route → 5xx +
  // alert); the rotation itself already succeeded and is NOT rolled
  // back — syncAuthToken() below must still run so the live auth gate
  // matches the persisted token.
  try {
    _eventsAppend("settings.update", {
      target: "currentToken",
      actor: "user",
      payload: {
        old_present: prevToken.length > 0,
        new_present: true,
        rotatedAt: newRotatedAt,
      },
    });
  } finally {
    syncAuthToken();
  }
  return currentToken;
}

// -----------------------------------------------------------------------
// LAN reject page
// v1.0.1: SINGLE bilingual page (zh + en side-by-side) — not Accept-Language
//   switching. Per user feedback: a user on a Chinese host might be
//   browsing in English (or vice versa); they want both visible at once.
//   Dynamic PORT (was hardcoded 7890 which broke when PORT was changed
//   to 18090 default).
// -----------------------------------------------------------------------

// Single bilingual HTML — both languages always visible. Each block is
// `zh` then `en` separated by a thin divider. No Accept-Language sniffing.
const LAN_REJECT_HTML = (
  remoteIp,
  localUrl,
) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>webui — LAN access disabled / 局域网访问已关闭</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; max-width: 640px; margin: 80px auto; padding: 24px; color: #333; line-height: 1.6; }
h1 { color: #c0392b; margin-top: 0; font-size: 22px; }
code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 14px; word-break: break-all; }
.box { background: #fef9e7; border-left: 4px solid #f1c40f; padding: 14px 18px; border-radius: 4px; margin: 20px 0; }
.lang { display: block; }
.lang + .lang { margin-top: 12px; padding-top: 12px; border-top: 1px dashed #ddd; }
.tag { display: inline-block; font-size: 10px; font-weight: 700; color: #888; background: #eee; padding: 1px 6px; border-radius: 3px; margin-bottom: 4px; letter-spacing: 0.5px; }
</style></head><body>

<span class="lang"><span class="tag">ZH</span>
<h1>局域网访问已关闭</h1>
<p>本 webui 当前<strong>仅允许本机访问</strong>，你的设备（<code>${remoteIp || "远程"}</code>）不在白名单内。</p>
<div class="box"><strong>如何开启：</strong><br>在 webui 所在的电脑上打开 <code>${localUrl}</code> → 左下角"局域网访问"按钮 → 开启</div>
<p>或直接用本机 URL：<code>${localUrl}</code></p>
</span>

<span class="lang"><span class="tag">EN</span>
<h1>LAN access disabled</h1>
<p>webui is currently <strong>loopback-only</strong>. Your device (<code>${remoteIp || "remote"}</code>) is not in the allowlist.</p>
<div class="box"><strong>How to enable:</strong><br>On the host machine, open <code>${localUrl}</code> → click the "LAN access" button at the bottom-left → turn it on</div>
<p>Or use the local URL directly: <code>${localUrl}</code></p>
</span>

</body></html>`;

const LAN_REJECT_JSON = {
  ok: false,
  error: "LAN access disabled. Open settings on the host machine to enable. / 局域网访问已关闭。在本机打开设置开启。",
};

export function rejectLan(res, pathname, remoteIp, _acceptLanguage) {
  // _acceptLanguage kept for back-compat with router.js's call site,
  // but no longer used — the page is now always bilingual.
  const isApi = pathname.startsWith("/api/");
  const isSettings = pathname === "/api/settings"; // 让用户能远程切回
  if (isSettings) return false;
  const localUrl = `http://127.0.0.1:${getServingPort()}/`;
  if (isApi) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(LAN_REJECT_JSON));
    return true;
  }
  res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
  res.end(LAN_REJECT_HTML(remoteIp, localUrl));
  return true;
}

// -----------------------------------------------------------------------
// getSettingsSnapshot — returned to clients via /api/settings
// -----------------------------------------------------------------------

// _effectiveShareToken — token the *server* uses to authenticate
// non-local requests. Order of precedence (per the auth gate):
//   1. process.env.TOKEN (env always wins)
//   2. in-memory currentToken (set by settings.js after init / rotation)
// Returns "" if no token configured (token auth effectively off).
function _effectiveShareToken() {
  if (process.env.TOKEN) return process.env.TOKEN.toString();
  return tokenAuthEnabled ? currentToken : "";
}

export function getSettingsSnapshot(availableInterfaces = null) {
  // currentToken is ONLY included when the operator hasn't acknowledged
  // it yet. After acknowledgment we omit the value to reduce the
  // window in which it lives in memory + over the wire.
  const includeToken = !tokenAcknowledged;
  // The engine's installed version, from its ACP `initialize` reply. Read once:
  // /api/state and /api/settings are both polled.
  const agentInfo = getMcodeServerInfo();
  // v2 security fix (PR #55 review point 1): lanUrlWithToken is a
  // first-run bootstrap surface ONLY. It used to be returned on every
  // GET /api/settings for the top-bar share chip — a long-lived
  // token-bearing URL re-leaked on each poll, exactly what the review
  // condemns. After acknowledgment the field is omitted entirely; the
  // UI falls back to the bare `lanUrl` (frontend:
  // d.lanUrlWithToken || d.lanUrl). A fresh token-bearing URL can be
  // minted again only via token rotation (resetToken), which returns
  // the new token exactly once and resets tokenAcknowledged.
  const baseUrl = `http://${LAN_IP}:${getServingPort()}`;
  const shareToken = _effectiveShareToken();
  const lanUrlWithToken = shareToken
    ? `${baseUrl}/?token=${encodeURIComponent(shareToken)}`
    : baseUrl;
  // v2 security fix (PR #55 review point 2): bind disclosure. `host`
  // below stays the actual boot-time bind (imported from config.js);
  // the fields here recompute what the NEXT boot would resolve to from
  // current state, mirroring config.js#resolveBindHost, so the settings
  // response always discloses the real exposure surface:
  //   - lanExposed: the effective bind is not loopback
  //   - bindRestartPending: the setting no longer matches the live
  //     socket (takes effect after restart); never claimed when env
  //     HOST owns the bind
  const envHost = (process.env.HOST || "").trim();
  const bindHost = envHost || (lanBindEnabled ? "0.0.0.0" : "127.0.0.1");
  const lanExposed = !isLoopbackHost(bindHost);
  const bindRestartPending = !envHost && bindHost !== HOST;
  const lanExposureNotice = lanExposed
    ? `LAN exposure ON: webui binds ${bindHost}:${getServingPort()} and is reachable from the network. / 局域网暴露已开启：webui 监听 ${bindHost}:${getServingPort()}，网络内设备均可访问。`
    : bindRestartPending
      ? `Bind change pending restart: next boot binds ${bindHost}. / 绑定变更待重启：下次启动监听 ${bindHost}。`
      : "";
  return {
    ok: true,
    lanBroadcast: lanBroadcastEnabled,
    readOnly: readOnlyEnabled,
    tokenEnabled: tokenAuthEnabled,
    tokenAcknowledged: tokenAcknowledged,
    currentToken: includeToken ? currentToken : "",
    tokenRotatedAt: tokenRotatedAt,
    port: getServingPort(),
    host: HOST,
    lanIp: LAN_IP,
    lanUrl: baseUrl,
    // v2 security fix (PR #55 review point 1): only present while
    // !tokenAcknowledged (first-run bootstrap). Omitted after ack.
    ...(includeToken ? { lanUrlWithToken } : {}),
    localUrl: `http://127.0.0.1:${getServingPort()}`,
    // v2 security fix (PR #55 review point 2): explicit exposure
    // disclosure surfaced whenever LAN sharing is (or is about to be)
    // in effect.
    lanBind: lanBindEnabled,
    bindHost,
    lanExposed,
    bindRestartPending,
    lanExposureNotice,
    mcodeCmd: MCODE_CMD,
    // A pinned constant here reported the version webui was written against
    // instead of the one running. `unknown` until a client attaches.
    mcodeVersion: (agentInfo && agentInfo.version) || "unknown",
    defaultWorkspace: DEFAULT_WORKSPACE,
    defaultModel: DEFAULT_MODEL,
  };
}
