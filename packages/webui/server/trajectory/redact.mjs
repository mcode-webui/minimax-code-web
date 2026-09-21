/**
 * Redaction and bounding for content that may leave the local process.
 *
 * The Studio serves to 127.0.0.1 only, but tool arguments and results routinely
 * carry credentials, so any `full` detail payload is scrubbed and length-bounded
 * before it is returned over MCP or written into the HTML page.
 *
 * Two properties matter more than cleverness here:
 *
 *   **Order.** Rules run most-specific first. An `Authorization: Bearer …` header
 *   has to be consumed as a whole, because a generic key/value rule would eat the
 *   header name and leave the token with nothing to anchor the scheme match —
 *   which is exactly how the earlier revision emitted `Authorization=[redacted]
 *   <token>` with the token intact.
 *
 *   **Shape.** A redaction preserves the surrounding syntax, so the result stays
 *   valid JSON and the payload a reader needs survives. Replacing everything with
 *   `[redacted]` would be safer and useless.
 *
 * Each rule is also idempotent — applying the set twice equals applying it once —
 * because text redacted at the data source is redacted again at the egress
 * boundary, and a second pass must not corrupt the first one's output.
 */

/** A key whose value is a credential, delimited so camelCase and snake_case agree. */
const SENSITIVE_KEY = /(?:^|[_.-])(?:api[_-]?key|apikey|secret|token|passwd|password|credential|authorization|auth[_-]?token|private[_-]?key|access[_-]?key|cookie|session[_-]?id)(?:$|[_.-])/i;

/** A plain `[redacted]` marker already in place. */
const REDACTED = '[redacted]';

/**
 * Split a camelCase or PascalCase key so the delimited pattern above can see its
 * words: `secretKey` → `secret_Key`, `AWSSecretKey` → `AWS_Secret_Key`.
 */
function normalizeKey(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2');
}

/**
 * Whether a key name carries a credential.
 *
 * Deliberately fail-closed: a name that merely contains a sensitive word with no
 * word boundary (`tokenizer`, `secretary`) is treated as sensitive too, while the
 * anchored shape keeps counter-like names (`inputTokens`, `total_tokens`) out.
 */
export function isSensitiveKey(key) {
  return typeof key === 'string' && SENSITIVE_KEY.test(normalizeKey(key));
}

/** `"v"` → `"[redacted]"`, keeping whichever quote the payload used. */
function redactQuoted(value) {
  const delim = value[0];
  const quoted = delim === '"' || delim === "'";
  return quoted ? `${delim}${REDACTED}${delim}` : REDACTED;
}

/** A quoted value already redacted, so a second pass leaves it alone. */
function alreadyRedacted(value) {
  const delim = value[0];
  const quoted = delim === '"' || delim === "'";
  return (quoted ? value.slice(1, -1) : value) === REDACTED;
}

const RULES = [
  {
    // A private key block is one credential, not a key/value pair.
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    to: () => '[redacted private key]',
  },
  {
    // Inline credentials in a connection string.
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    to: (_match, scheme) => `${scheme}${REDACTED}:${REDACTED}@`,
  },
  {
    // The Authorization header as a whole, scheme included. This has to precede
    // the key/value rule below; see the module comment.
    re: /\b((?:proxy-)?authorization)(\s*[:=]\s*)(?:bearer|basic|token)?\s*[A-Za-z0-9._~+/=+-]{8,}/gi,
    to: (_match, name, separator) => `${name}${separator}${REDACTED}`,
  },
  {
    // A scheme and token with no header name in front of it.
    re: /\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+/=+-]{8,}/gi,
    to: (_match, scheme, space) => `${scheme}${space}${REDACTED}`,
  },
  {
    // Provider-shaped keys, even when nothing labels them.
    re: /\b(sk|pk|ghp|gho|ghs|ghr|glpat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g,
    to: () => REDACTED,
  },
  {
    // AWS access key ids.
    re: /\b(AKIA|ASIA)[A-Z0-9]{12,}\b/g,
    to: () => REDACTED,
  },
  {
    // `key: value`, where a quote may sit between the key and the separator — the
    // JSON object form, which an adjacency-requiring pattern silently skips. The
    // key class is a single bounded quantifier so the scan stays linear; whether a
    // key is sensitive is decided in the callback.
    re: /(["']?)([A-Za-z0-9_.-]{1,64})\1(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;'"`)\]}]+)/g,
    to: (match, quote, key, separator, value) => {
      if (!isSensitiveKey(key)) return match;
      if (alreadyRedacted(value)) return match;
      return `${quote}${key}${quote}${separator}${redactQuoted(value)}`;
    },
  },
];

/** Scrub every credential encoding a string may carry, then bound its length. */
export function redactText(value, { maxLength = 4000 } = {}) {
  if (typeof value !== 'string') return value;
  let text = value;
  for (const rule of RULES) text = text.replace(rule.re, rule.to);
  if (text.length > maxLength) {
    const omitted = text.length - maxLength;
    text = `${text.slice(0, maxLength)}\n… [truncated ${omitted} chars]`;
  }
  return text;
}

/**
 * Exact-name test for structured keys; counters like `inputTokens` stay.
 *
 * `session[_-]?id` is deliberately absent. It reads like a credential and is one in
 * many APIs, but in this runtime's schema a session id is an *addressing token*: the
 * Plugin prints it, passes it in every URL, and matches rows on it. Treating it as a
 * secret broke the whole API — `/api/sessions` returned `"sessionId": "[redacted]"`
 * and every following request 404'd. A session id is an identifier, not a bearer
 * credential, and the values that really are credentials are still caught by name
 * (`token`, `cookie`, `authorization`) and by the string rules.
 */
const SECRET_KEY_NAMES = /^(?:api[_-]?key|apikey|secret|token|passwd|password|credential|authorization|private[_-]?key|access[_-]?key|cookie)$/i;

/**
 * Deep-walk a value, redacting every string it contains.
 *
 * Structural bounds are optional and default to none: the egress sweep passes
 * none because the payload was already bounded by the caller's own limits, and
 * truncating an event list here would silently drop records. `redactValue` is the
 * bounded variant, for callers that want breadth and depth caps.
 */
function walk(value, options, depth) {
  const { maxLength, maxDepth, maxEntries } = options;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value, { maxLength });
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (maxDepth !== undefined && depth >= maxDepth) return '[depth limit]';
  if (Array.isArray(value)) {
    const head = value.slice(0, maxEntries).map((item) => walk(item, options, depth + 1));
    if (value.length > maxEntries) head.push(`… [${value.length - maxEntries} more items]`);
    return head;
  }
  if (typeof value === 'object') {
    const out = {};
    let seen = 0;
    for (const [key, item] of Object.entries(value)) {
      if (seen >= maxEntries) {
        out['…'] = `${Object.keys(value).length - maxEntries} more keys`;
        break;
      }
      seen += 1;
      // A structured key is an exact credential name, not merely one containing a
      // sensitive word: `usage.inputTokens` has to survive, and it would not.
      out[key] = SECRET_KEY_NAMES.test(key) ? REDACTED : walk(item, options, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** Recursively scrub a JSON-ish value, bounding depth, breadth and string length. */
export function redactValue(value, options = {}, depth = 0) {
  const { maxLength = 4000, maxDepth = 12, maxEntries = 200 } = options;
  return walk(value, { maxLength, maxDepth, maxEntries }, depth);
}

/** Redact an outbound payload of any shape, without restructuring it. */
export function redactPayload(value, { maxLength = 4000 } = {}) {
  return walk(value, { maxLength, maxEntries: Number.MAX_SAFE_INTEGER }, 0);
}

/** Redact an MCP event payload in `full` mode. */
export function redactEvent(event, options = {}) {
  return redactPayload(event, options);
}

/** Home-directory prefixes are stripped so paths do not leave the machine verbatim. */
export function redactPath(value, { homeDir } = {}) {
  if (typeof value !== 'string') return value;
  if (homeDir && value.startsWith(homeDir)) return `~${value.slice(homeDir.length)}`;
  return value;
}
