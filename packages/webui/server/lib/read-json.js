// webui/server/lib/read-json.js
// One bounded JSON body reader for every request route.

/**
 * Why a shared reader.
 *
 * Nine modules each carried their own copy of
 *
 *   let body = "";
 *   for await (const chunk of req) body += chunk;
 *
 * with no size cap. The upload parser (`lib/upload.js`) has three caps —
 * 50 MiB request, 25 MiB file, 200 MiB quota — but those apply only to
 * `POST /api/upload`; every JSON route buffered without limit. The gates reject
 * an unauthenticated caller cheaply, so this is a post-authentication memory
 * exhaustion vector: a client holding the token (including over LAN) can POST
 * a multi-gigabyte body to `/api/send` and have it concatenated into one V8
 * string before `JSON.parse` is ever reached.
 *
 * 1 MiB is far above any real payload here — the largest is a chat message or
 * a session title — and it is deliberately much smaller than the upload caps,
 * because these bodies are JSON metadata, not file content. `POST /api/upload`
 * must not use this helper; it has its own streaming parser with its own caps.
 *
 * The cap is enforced *while* reading, not after, so an oversized body is
 * abandoned rather than accumulated. The socket is then destroyed so the client
 * stops sending instead of the process sitting on a half-read body.
 */

/** Default ceiling for a JSON request body: 1 MiB. */
const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;

/**
 * How much of an over-sized body we are willing to read and throw away so the
 * 413 can actually reach the client.
 *
 * The alternative — `req.destroy()` the moment the cap is passed — looks
 * cheaper, and was the first thing tried, but it kills the socket *before* the
 * handler chain can write a response. Measured: the client saw a bare
 * `HTTP 100` (the `Expect: 100-continue` interim) and a dropped connection
 * instead of a 413. Breaking out of `for await` has the same problem — the
 * iterator's `return()` destroys the stream.
 *
 * So the body is drained instead: past the cap nothing is retained, which is
 * what the vulnerability was about (unbounded *memory*, not unbounded time),
 * and the cost is bandwidth the client was going to spend anyway. This ceiling
 * bounds the drain so a body that is not merely over the cap but absurd cannot
 * hold the socket open indefinitely; past it we destroy and the client gets a
 * connection error, which is the correct outcome for that case.
 */
const DEFAULT_MAX_DRAIN_BYTES = 64 * 1024 * 1024;

function envPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const MAX_JSON_BYTES = envPositiveInt(
  "MCODE_WEBUI_MAX_JSON_BYTES",
  DEFAULT_MAX_JSON_BYTES,
);

const MAX_DRAIN_BYTES = envPositiveInt(
  "MCODE_WEBUI_MAX_JSON_DRAIN_BYTES",
  DEFAULT_MAX_DRAIN_BYTES,
);

/** Thrown when a body exceeds `MAX_JSON_BYTES`; carries the byte limit. */
export class BodyTooLargeError extends Error {
  constructor(limit) {
    super(`request body exceeds ${limit} bytes (adjust MCODE_WEBUI_MAX_JSON_BYTES to allow more)`);
    this.name = "BodyTooLargeError";
    this.limit = limit;
  }
}

/**
 * Read and parse a JSON request body.
 *
 * Returns `{}` for an empty or unparseable body, matching what the nine
 * per-route copies did — a malformed body is a client mistake, and each caller
 * already validates the fields it needs. A body over the limit throws instead,
 * because that must not be silently downgraded to "no fields set".
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJson(req, opts = {}) {
  const limit = opts.limit || MAX_JSON_BYTES;
  const chunks = [];
  let bytes = 0;
  let over = false;
  for await (const raw of req) {
    // A real Node request yields Buffers, but `Buffer.concat` below throws on
    // anything else, and this helper is also exercised against synthetic
    // streams in tests. Coerce rather than assume.
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > limit) {
      // Over the cap: keep reading so the socket survives long enough to answer
      // 413, but retain nothing further.
      if (bytes > limit + MAX_DRAIN_BYTES) {
        req.destroy();
        throw new BodyTooLargeError(limit);
      }
      over = true;
      chunks.length = 0;
      continue;
    }
    if (!over) chunks.push(chunk);
  }
  if (over) throw new BodyTooLargeError(limit);
  const body = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = JSON.parse(body || "{}");
    // `null` and primitives parse fine but have no fields; the old copies
    // returned them as-is, and callers do `payload.x` on the result, so
    // normalising to an object preserves their behaviour and removes a class
    // of TypeError.
    if (parsed === null || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

/**
 * `readJson` for callers that answer a 413 themselves.
 *
 * Returns `{ ok, value, tooLarge, limit }` instead of throwing, so a route can
 * set its own status/headers the way `POST /api/upload` does (`413` plus
 * `Connection: close`).
 */
export async function tryReadJson(req, opts = {}) {
  try {
    return { ok: true, value: await readJson(req, opts), tooLarge: false };
  } catch (cause) {
    if (cause instanceof BodyTooLargeError) {
      return { ok: false, value: null, tooLarge: true, limit: cause.limit };
    }
    throw cause;
  }
}
