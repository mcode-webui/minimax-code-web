// webui/server/engine/review-link.js
//
// PB-16 (`doc/placeholder-batch-plan.md` §6.3): the 「Review」 button on the
// 「已编辑 N 个文件」 card.
//
//   GET /api/review-link → cliService.getWorkspaceReviewLink(workspaceDir, branch)
//
// WHAT THE ENGINE ALREADY KNOWS, AND WHY THIS IS A WINDOW AND NOT A FEATURE.
// A review link is recorded BY the runtime, not fetched from a git host:
// `packages/local-runtime/src/review-link/store.ts` keys one entry by
// `<workspaceDir>\n<branch>`, and the hook that writes it
// (`review-link/hook.ts`) fires when an agent turn ran `gh pr create|view`
// or `glab mr create|view`. The entry is
// `{vendor, url, number, branch, origin, recordedAt}`
// (`store.ts:ReviewLinkEntry`), and `origin` is `created` when this machine
// opened the review and `viewed` when it merely looked at one.
//
// The consequences are the whole design:
//
//   * the branch is a REQUIRED argument, so the workspace and the current
//     branch have to be resolved before the read. The workspace comes from
//     the engine's own session record (`adapter.getSession`), never from
//     the request, for the same reason `routes/queue.js` takes its session
//     id from `ctx.cs.mcodeSessionId` rather than from a body;
//   * "no recorded review" is the COMMON case, not an error. It answers
//     200 with `reviewLink: null` and the reason, because a missing entry
//     is a fact about the user's history and not a failure of the read.
//     A greyed-out button and an error banner are different statements and
//     only one of them is true here.
//
// WHY THIS IS A READ AND MAY NOT BOOT A RUNTIME. It goes through
// `peekEngineCatalogueHost()` for the reason `engine/queue.js` records at
// length: a read that boots the runtime turns a page's first paint into a
// silent multi-second stall. The card polls this once per session; a boot
// here would be a boot on every conversation.
//
// WHY THREE DIFFERENT 501s AND ONE 503. There is no capability key for
// `cliService.getWorkspaceReviewLink` on this route's gate path (the same
// situation `engine/worktrees.js` documents), so the honest gate is the
// member read at dispatch time and each of its answers is a distinct
// failure that must not fall through to a success payload:
//
//   503 engine_host_unavailable        no runtime booted
//   501 engine_member_unavailable      host without the review-link method
//   501 engine_git_metadata_unavailable host without the branch read
//   501 engine_session_reader_unavailable host without the session record
//   501 engine_capability_not_supported the provider declared the surface
//                                      away (via the shared error, so the
//                                      payload stays the one the frontend
//                                      already understands)
//
// A Review button that answered "no review" for a runtime that never booted
// is the fake-empty shape this repository refuses to reintroduce (#110).

import { engineCapabilityHttpResponse, isEngineCapabilityNotSupportedError } from "./errors.js";

/** The endpoint label every failure line starts with. */
const ENDPOINT = "/api/review-link";

/** The three engine methods this read needs, by name. */
export const REVIEW_LINK_METHOD = "getWorkspaceReviewLink";
export const REVIEW_LINK_METADATA_METHOD = "getWorkspaceGitMetadata";
export const REVIEW_LINK_SESSION_METHOD = "getSession";

/**
 * Why a 200 answer carries no link.
 *
 * These are sentences, not statuses: the client renders them as the button's
 * tooltip, and each names a different thing the user could do (open a
 * different workspace, check out a branch, run `gh pr view`).
 */
export const REVIEW_LINK_REASONS = Object.freeze({
  unknown_workspace: "unknown_workspace",
  no_branch: "no_branch",
  no_review_link: "no_review_link",
});

/** The vendors the runtime's store accepts (`store.ts:VENDORS`). */
const VENDORS = Object.freeze(["github", "gitlab"]);

/** How the review came to be known (`store.ts:ORIGINS`). */
const ORIGINS = Object.freeze(["created", "viewed"]);

/**
 * Project one engine record onto the wire, or `null` when it cannot back a
 * clickable control.
 *
 * The engine's answer is a widened `Record<string, unknown>`, so every field
 * is re-read here rather than cast. A record missing its url or whose url is
 * not http(s) is dropped whole: a button that opens `javascript:` or points at
 * nothing is worse than no button, and this store file is local but is still
 * an untrusted boundary for the browser that renders it.
 *
 * @param {unknown} raw
 * @returns {{vendor: string, url: string, number: number, branch: string, origin: string, recordedAt: number}|null}
 */
export function projectReviewLink(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw;
  const { vendor, url, number, branch, origin, recordedAt } = record;
  if (typeof vendor !== "string" || !VENDORS.includes(vendor)) return null;
  if (typeof origin !== "string" || !ORIGINS.includes(origin)) return null;
  if (typeof branch !== "string" || branch.length === 0) return null;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return null;
  if (typeof recordedAt !== "number" || !Number.isFinite(recordedAt)) return null;
  if (typeof url !== "string" || url.length === 0) return null;
  if (!isHttpUrl(url)) return null;
  return { vendor, url, number, branch, origin, recordedAt };
}

/**
 * True for the two schemes a review page can legitimately use.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:";
}

/**
 * Locate the host under the READ boot policy, or say why it could not.
 *
 * @param {Function} [getHost]
 * @returns {Promise<{ok: true, host: object}|{ok: false, code: string, status: number, error: string}>}
 */
async function requireReviewHost(getHost) {
  let host;
  try {
    const { peekEngineCatalogueHost } = await import("./host.js");
    host = getHost ? await getHost() : await peekEngineCatalogueHost();
  } catch (e) {
    return {
      ok: false,
      code: "engine_host_unavailable",
      status: 503,
      error: e && e.message ? e.message : String(e),
    };
  }
  if (!host) {
    return {
      ok: false,
      code: "engine_host_unavailable",
      status: 503,
      error: `${ENDPOINT}: the engine catalogue host is not available`,
    };
  }
  return { ok: true, host };
}

/**
 * Bind one method off the located host, or report which member is missing.
 *
 * @param {object} host
 * @param {string} path Dotted path under `host`, e.g. `cliService.getWorkspaceReviewLink`.
 * @param {string} code The 501 code for this member's absence.
 * @returns {{ok: true, member: Function}|{ok: false, code: string, status: number, error: string}}
 */
function bindMember(host, path, code) {
  const parts = path.split(".");
  let owner = host;
  for (const part of parts.slice(0, -1)) {
    owner = owner ? owner[part] : undefined;
  }
  const name = parts[parts.length - 1];
  if (!owner || typeof owner[name] !== "function") {
    return {
      ok: false,
      code,
      status: 501,
      error: `${ENDPOINT}: host.${path} is not a function`,
    };
  }
  return { ok: true, member: owner[name].bind(owner) };
}

/**
 * Map a thrown engine error onto the wire.
 *
 * `EngineCapabilityNotSupportedError` keeps the shared 501 payload
 * (`errors.js#engineCapabilityHttpResponse`) rather than this module's own
 * code, so a client that already treats `engine_capability_not_supported`
 * as "hide the entry point" needs no second vocabulary for the same fact.
 *
 * @param {unknown} error
 * @returns {{ok: false, code: string, status: number, error: string, payload?: object}}
 */
function mapReviewLinkError(error) {
  if (isEngineCapabilityNotSupportedError(error)) {
    const { status, payload } = engineCapabilityHttpResponse(error);
    return { ok: false, code: payload.code, status, error: payload.error, payload };
  }
  return {
    ok: false,
    code: "review_link_failed",
    status: 200,
    error: `${ENDPOINT}: ${error && error.message ? error.message : String(error)}`,
  };
}

/**
 * `GET /api/review-link` — the review recorded for this session's workspace
 * and current branch.
 *
 * 200 `{ok:true, reviewLink:<record|null>, reason:<why|null>, branch:<string|null>}`
 * is the whole honest answer space: a link, or a named reason there is none.
 * The `reason` field is what lets the client say something true about a
 * missing link instead of rendering a control that cannot work.
 *
 * @param {{sessionId: string, getHost?: Function}} options
 * @returns {Promise<{ok: true, payload: object}|{ok: false, code: string, status: number, error: string}>}
 */
export async function readEngineReviewLink(options) {
  const located = await requireReviewHost(options.getHost);
  if (!located.ok) return located;
  const { host } = located;

  const link = bindMember(host, `cliService.${REVIEW_LINK_METHOD}`, "engine_member_unavailable");
  if (!link.ok) return link;
  const metadata = bindMember(
    host,
    `cliService.${REVIEW_LINK_METADATA_METHOD}`,
    "engine_git_metadata_unavailable",
  );
  if (!metadata.ok) return metadata;
  const sessionReader = bindMember(
    host,
    `adapter.${REVIEW_LINK_SESSION_METHOD}`,
    "engine_session_reader_unavailable",
  );
  if (!sessionReader.ok) return sessionReader;

  // The workspace is the engine's own answer about this session, never a
  // request parameter: a client-supplied directory would let one tab read
  // another's review link, and the store is keyed by it.
  let workspaceDir;
  try {
    const session = await sessionReader.member(options.sessionId);
    const candidate = session && typeof session === "object" ? session.workspaceDir : undefined;
    workspaceDir = typeof candidate === "string" && candidate.length > 0 ? candidate : "";
  } catch (error) {
    return mapReviewLinkError(error);
  }
  if (!workspaceDir) return noLink(REVIEW_LINK_REASONS.unknown_workspace, null);

  let branch;
  try {
    const meta = await metadata.member(workspaceDir);
    const candidate = meta && typeof meta === "object" ? meta.branch : undefined;
    branch = typeof candidate === "string" ? candidate.trim() : "";
  } catch (error) {
    return mapReviewLinkError(error);
  }
  // A detached HEAD, a fresh repository with no commit, and a folder that is
  // not a Git repository all land here: there is no branch, and a review link
  // is keyed by one.
  if (!branch) return noLink(REVIEW_LINK_REASONS.no_branch, null);

  let raw;
  try {
    raw = await link.member(workspaceDir, branch);
  } catch (error) {
    return mapReviewLinkError(error);
  }
  const reviewLink = projectReviewLink(raw);
  if (!reviewLink) return noLink(REVIEW_LINK_REASONS.no_review_link, branch);
  return {
    ok: true,
    payload: { ok: true, reviewLink, reason: null, branch },
  };
}

/**
 * The 200 answer that names why there is no review link.
 *
 * Written once so the three reasons cannot drift into three payload shapes.
 *
 * @param {string} reason
 * @param {string|null} branch
 * @returns {{ok: true, payload: object}}
 */
function noLink(reason, branch) {
  return {
    ok: true,
    payload: { ok: true, reviewLink: null, reason, branch },
  };
}

// ---------------------------------------------------------------------------
// KNOWN DEBT
// ---------------------------------------------------------------------------
//
// 1. No invalidation. The store is appended to by the `gh`/`glab` hook during a
//    turn, and this endpoint is read once per session, so a review created
//    mid-session appears on the next session switch rather than immediately.
//    An SSE frame for it would be the fix; nothing in the webapp needs one
//    today, and adding the frame for a control that is greyed out most of the
//    time would be motion without a user-visible gain.
//
// 2. No cache. `LocalReviewLinkStore.read` re-reads a small JSON file per
//    call and the branch read spawns `git`. The card asks once per session
//    rather than once per turn, so this is one pair of reads per
//    conversation, not one per rendered card.