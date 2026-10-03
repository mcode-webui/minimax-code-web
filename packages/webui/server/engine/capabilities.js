// webui/server/engine/capabilities.js
//
// The capability-declaration contract: 14 keys, one per row of the
// capability matrix in doc/engine-abstraction-design.md §1.2, plus the
// validation rules that keep declarations honest (design doc §2.2/§4.1):
//
//   - every provider declares ALL 14 keys — no "absent means none";
//   - `partial` MUST enumerate `missing` sub-items (never "half works,
//     nobody knows which half") and MUST carry a `reason`;
//   - `none` MUST carry a `reason` distinguishing "interface-absent"
//     (the provider surface has no such method at all) from
//     "implementation-absent" (the surface exists, nobody implements it) —
//     the same distinction the design matrix records.
//
// M4-1 added one optional field, `servedBy`, and only on a `none` entry.
// It answers a DIFFERENT question from `level`: `level` is what the
// provider itself can do, `servedBy` is who answers the request when
// webui serves the endpoint from another provider's in-process host.
// The acp provider needs it for `turnDiff` and `plugins` — the one
// reverse exception the M3 plan records (§6), where the protocol has
// no such method and the endpoint works anyway. It is rejected on
// `full` and `partial` because a provider that partly implements a
// capability is not "served elsewhere", and letting the word mean two
// things is how a gate ends up trusting the wrong field. Whether the
// named provider is actually REGISTERED is not decidable here — this
// module must stay free of the registry to avoid the import cycle
// `engine/index.js` documents — so engine/index.js cross-checks it at
// import instead.
//
// Declarations are static module constants — the first source of truth,
// reviewed in code (design doc §2.3). Runtime probing is deliberately NOT
// part of this batch; see engine/index.js for what ships now.
//
// Capability keys map 1:1 to the design matrix rows (key ↔ matrix row):
//   sessionCrud↔会话 CRUD, streamingSend↔流式发送, interrupt↔中断,
//   toolSkillInvocation↔工具/技能调用, turnDiff↔回合级 diff 查询,
//   turnRewindRedo↔回合撤销/重做, plugins↔插件管理, mcp↔MCP,
//   subagents↔子 agent, usageStats↔用量统计, authCredentials↔认证/凭据,
//   updateCheck↔更新检查, fileReadWrite↔文件读写, gitOperations↔Git 操作.

import { EngineCapabilityNotSupportedError } from "./errors.js";

/** The 14 capability keys, in matrix order. Source: design doc §1.2. */
export const ENGINE_CAPABILITY_KEYS = Object.freeze([
  "sessionCrud",
  "streamingSend",
  "interrupt",
  "toolSkillInvocation",
  "turnDiff",
  "turnRewindRedo",
  "plugins",
  "mcp",
  "subagents",
  "usageStats",
  "authCredentials",
  "updateCheck",
  "fileReadWrite",
  "gitOperations",
]);

/** @typedef {"full" | "partial" | "none"} EngineCapabilityLevel */
/** @typedef {{level: "full"}} FullCapability */
/** @typedef {{level: "partial", missing: string[], reason: string}} PartialCapability */
/** @typedef {{level: "none", reason: string, servedBy?: string}} NoneCapability */
/** @typedef {Record<string, FullCapability|PartialCapability|NoneCapability>} EngineCapabilities */

/**
 * Validate a declaration object against the contract. Returns a list of
 * human-readable problems (empty = valid). Pure — used by unit tests to
 * pin every provider declaration.
 */
export function validateEngineCapabilities(capabilities) {
  const problems = [];
  if (!capabilities || typeof capabilities !== "object") {
    return ["capabilities must be an object"];
  }
  for (const key of ENGINE_CAPABILITY_KEYS) {
    const entry = capabilities[key];
    if (entry === undefined) {
      problems.push(`missing key: ${key}`);
      continue;
    }
    if (!entry || typeof entry !== "object" || typeof entry.level !== "string") {
      problems.push(`${key}: must be {level, ...}`);
      continue;
    }
    if (entry.level === "full") {
      if (entry.missing !== undefined) problems.push(`${key}: full must not carry missing`);
      if (entry.servedBy !== undefined) {
        problems.push(`${key}: full must not carry servedBy — the provider serves it itself`);
      }
      continue;
    }
    if (entry.level === "partial") {
      if (!Array.isArray(entry.missing) || entry.missing.length === 0) {
        problems.push(`${key}: partial must enumerate missing sub-items`);
      }
      if (typeof entry.reason !== "string" || entry.reason.length === 0) {
        problems.push(`${key}: partial must carry a reason`);
      }
      if (entry.servedBy !== undefined) {
        problems.push(
          `${key}: partial must not carry servedBy — it serves the capability itself; name the absent sub-items in \`missing\``,
        );
      }
      continue;
    }
    if (entry.level === "none") {
      if (typeof entry.reason !== "string" || entry.reason.length === 0) {
        problems.push(`${key}: none must carry a reason`);
      }
      if (entry.servedBy !== undefined) {
        if (typeof entry.servedBy !== "string" || entry.servedBy.length === 0) {
          problems.push(`${key}: servedBy must name a provider id`);
        }
      }
      continue;
    }
    problems.push(`${key}: unknown level "${entry.level}"`);
  }
  const extra = Object.keys(capabilities).filter((k) => !ENGINE_CAPABILITY_KEYS.includes(k));
  for (const key of extra) problems.push(`unknown key: ${key}`);
  return problems;
}

/**
 * Gate a call on a declared capability. Throws
 * EngineCapabilityNotSupportedError for level `none` — and for `partial`
 * when one of the missing sub-items is named — so callers can never reach
 * an absent provider method and mistake silence for success (#110
 * fake-success discipline).
 *
 * @param {EngineCapabilities} capabilities  The provider's declaration.
 * @param {string} capability                One of ENGINE_CAPABILITY_KEYS.
 * @param {string} provider                  Provider id, for the error payload.
 * @param {string} [subItem]                 Optional sub-item (method or
 *                                           sub-capability name) to check
 *                                           against a partial's `missing`.
 * @returns {void}
 */
export function assertEngineCapability(capabilities, capability, provider, subItem) {
  const entry = capabilities ? capabilities[capability] : undefined;
  if (entry && entry.level === "full") return;
  if (entry && entry.level === "partial") {
    if (subItem === undefined || !entry.missing.includes(subItem)) return;
    throw new EngineCapabilityNotSupportedError({
      capability,
      provider,
      missing: [subItem],
      reason: entry.reason,
    });
  }
  throw new EngineCapabilityNotSupportedError({
    capability,
    provider,
    missing: entry && Array.isArray(entry.missing) ? entry.missing : [],
    reason: entry && entry.reason ? entry.reason : "capability not declared by this provider",
  });
}

/**
 * Compute the degradation summary the frontend will render from (design
 * doc §4.2: full → render, partial → hide/disable missing sub-actions,
 * none → hide the entry point entirely). UI lands in a later batch; the
 * endpoint exposes this so the calculation has exactly one home.
 *
 * @param {EngineCapabilities} capabilities
 * @returns {{none: string[], partial: Array<{key: string, missing: string[]}>}}
 */
export function summarizeUnavailableCapabilities(capabilities) {
  const none = [];
  const partial = [];
  for (const key of ENGINE_CAPABILITY_KEYS) {
    const entry = capabilities[key];
    if (!entry) continue;
    if (entry.level === "none") none.push(key);
    else if (entry.level === "partial") partial.push({ key, missing: [...entry.missing] });
  }
  return { none, partial };
}

/**
 * List the capabilities this provider does NOT implement but webui
 * still serves, from another provider's host. M4-1's reverse
 * exception lives here: under the acp transport `turnDiff` and
 * `plugins` are honestly `none` (the protocol has neither method) and
 * still work, because the routes project the in-process
 * local-runtime-v2 host.
 *
 * DELIBERATELY NOT MERGED INTO `summarizeUnavailableCapabilities`.
 * That function is the input for design §4.2's UI rule (`none` → hide
 * the entry point), and it is the frontend's existing contract: its
 * `{none, partial}` shape is what `GET /api/engine-capabilities`
 * already serves and what the webapp's degradation test asserts. A
 * hosted capability is genuinely unavailable ON THE PROVIDER, so it
 * belongs in that list, and the fact that a different host answers is
 * a routing fact the provider cannot speak for. Adding a third bucket
 * would have changed the response shape of a shipped endpoint for
 * every existing caller; a separate function changes nothing.
 *
 * @param {EngineCapabilities} capabilities
 * @returns {Array<{key: string, servedBy: string}>} In matrix order.
 */
export function summarizeCapabilityHosting(capabilities) {
  const hosted = [];
  for (const key of ENGINE_CAPABILITY_KEYS) {
    const entry = capabilities ? capabilities[key] : undefined;
    if (entry && entry.level === "none" && typeof entry.servedBy === "string" && entry.servedBy) {
      hosted.push({ key, servedBy: entry.servedBy });
    }
  }
  return hosted;
}
