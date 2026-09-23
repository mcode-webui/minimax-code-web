/**
 * Client identity.
 *
 * The server keys its per-client session and state on a `cid` query parameter
 * (`getCidFromReq` in server/lib/state-bus.js reads `?cid=`) and keeps one
 * `mcode acp` subprocess per cid. Without it every browser would share the
 * empty cid and see each other's session.
 *
 * The id is generated once and persisted under `localStorage['webui_cid']`, so
 * a reload keeps its conversation rather than spawning a new engine process.
 */

const STORAGE_KEY = "webui_cid";

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  // Fallback for contexts without crypto.randomUUID (older embedded webviews).
  return `cid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

let cached: string | null = null;

/** The stable client id for this browser. */
export function clientId(): string {
  if (cached) return cached;
  if (typeof window === "undefined") return "";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      cached = stored;
      return cached;
    }
  } catch {
    /* storage unavailable — fall through and use an in-memory id */
  }
  const id = createId();
  cached = id;
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* not fatal: the id just will not survive a reload */
  }
  return id;
}

/**
 * Query string for the current page, carrying the auth token (when the server
 * issued one) and the client id. Returned without a leading `?`.
 */
export function requestQuery(extra?: Record<string, string>): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams();
  const token = new URLSearchParams(window.location.search).get("token");
  if (token) params.set("token", token);
  const cid = clientId();
  if (cid) params.set("cid", cid);
  for (const [key, value] of Object.entries(extra ?? {})) params.set(key, value);
  return params.toString();
}

/** Append the standard query to a path. */
export function withClientQuery(path: string, extra?: Record<string, string>): string {
  const query = requestQuery(extra);
  if (!query) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${query}`;
}
