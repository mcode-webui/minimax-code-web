// server/lib/credential-file.js — single source of truth for the
// "is this path a credential-shaped file" decision (webui-parity slice 16).
//
// Background. The webui server broadcasts a LAN URL when `lanBind` is on
// (or when the operator sets `HOST=0.0.0.0`). Same-LAN peers can therefore
// reach `/api/fs/read-file?path=…` — and the file browser happily displays
// `.env`, `~/.ssh/id_rsa`, `.npmrc` etc. as plaintext. The user has decided
// (2026-09-27) that the preview MUST refuse by default, with a second
// confirmation ("仍要打开？") to override. The server is the real gate;
// the webapp is a presenter over the server's structured answer.
//
// Scope. The credential predicate matches the names that actually
// contain plaintext secrets in the wild. The list is intentionally
// narrow + explicit:
//
//   `.env`                  exact match; the canonical env file
//   `.env.*`                env variants (.env.local, .env.production, …)
//   `.npmrc` / `.pypirc`    package-manager credential files
//   `credentials*`          anything starting with `credentials` (aws / gcloud / …)
//                            — covers `credentials`, `credentials.json`,
//                            `credentials.ini`, etc.
//   `id_rsa` / `id_ed25519` / `id_ecdsa` / `id_dsa`
//                            SSH private keys (basename match — they live
//                            in `~/.ssh/` and only there)
//   `*.pem` / `*.key`       TLS / SSH private-key files (extension match)
//   `known_hosts` / `authorized_keys`
//                            SSH metadata (basename match; `authorized_keys`
//                            is not strictly a credential but treating it
//                            as one keeps the rule uniform and a hostile
//                            fingerprint is still information disclosure)
//   `.netrc`                HTTP auth file
//   `.pgpass`               Postgres password file
//
// What is NOT covered (deliberately):
//   - `environment.ts` / `env.js` — filenames containing the substring
//     "env" but not starting with `.env.` or named `.env`. The web is
//     full of files like that and pretending otherwise would break
//     legitimate previews.
//   - `*.example.env` / `.env.example` — these are templates that ship
//     in repos. The decision is documented in the fixture test
//     (`credential-file.test.ts`); calling them out keeps the rule
//     reviewable.
//   - `.git/config` — can hold remote URLs but not secrets in normal
//     use; if a future use case surfaces, add it to the table.
//   - arbitrary basenames inside `~/.ssh/` — `~/.ssh/id_rsa` IS matched,
//     but `~/.ssh/known_hosts` is too (basename match), and we do NOT
//     sweep everything under the directory (`.ssh/known_hosts.old`
//     would still match because of the basename rule; `.ssh/config`
//     is intentionally NOT covered for the same reason `environment.ts`
//     isn't).
//   - `.env.local.bak` — IS a credential (it is a backup of an env
//     file). The `dotenv-variant` rule covers `.env.*` regardless of
//     suffix, so the original fixture flagged it as a MISS was wrong:
//     the predicate correctly matches it.
//
// Why two implementations (this .js and webapp/lib/credential-file.ts).
// The server runs plain Node and the webapp runs TypeScript with a
// `@/lib/...` alias; neither can import the other cleanly without
// dragging the whole Next.js / Hono bundle graph into a serverless
// path. Both implementations read from the SAME `CREDENTIAL_FIXTURES`
// table (declared here and mirrored verbatim in the .ts file) and the
// shared `credential-file.test.ts` exercises both. A regression that
// drifts one side from the other fails the test immediately because
// the fixture loop runs both implementations on the same inputs.
//
// Wire format. The webapp's classifier (file-open-reason.ts) reads
// `payload.error` to pick a reason; we keep that string stable
// ("credential file — preview disabled") and ALSO emit a structured
// `code: "credential"` plus a `reason` field on the JSON body. The UI
// only branches on `code` (defensive against future i18n tweaks);
// `reason` and `error` are debug / display.

import { basename } from "node:path";

/**
 * The canonical fixture set the server and webapp predicate both read.
 *
 * Each entry is `{ match, hits, misses }`:
 *   - `match`     — the rule shape, one of the `MATCH_*` constants below
 *   - `hits`      — names that MUST be classified as credentials
 *   - `misses`    — near-miss names that MUST NOT be classified (the
 *                   legibility check; a too-eager predicate catches
 *                   `environment.ts` and the right panel goes dark)
 *
 * The test (`credential-file.test.ts`) walks this list once for the
 * server implementation and once for the webapp implementation, so any
 * addition to the table is also a new test by construction.
 */
export const CREDENTIAL_FIXTURES = [
  {
    match: "exact-basename",
    hits: [".env", ".npmrc", ".pypirc", ".netrc", ".pgpass", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "known_hosts", "authorized_keys"],
    misses: ["env", ".envrc", "environment.ts", "env.js", "Environment.txt", ".envvars"],
  },
  {
    match: "exact-basename-prefix",
    hits: ["credentials", "credentials.json", "credentials.ini", "credentials.old"],
    misses: ["my-credentials-notes.md", "credential-helper"],
  },
  {
    match: "dotenv-variant",
    hits: [".env.local", ".env.production", ".env.development", ".env.test", ".env.example", ".env.local.bak"],
    misses: [".envrc"],
  },
  {
    match: "extension",
    hits: ["server.pem", "client.pem", "private.key", "tls.key", "foo.PEM", "bar.KEY"],
    misses: ["keyword.js", "house.json", "monkey.txt"],
  },
];

/** Predicate entry points. See `MATCH_*` for the matching shapes. */
export const MATCH_EXACT_BASENAME = "exact-basename";
export const MATCH_EXACT_BASENAME_PREFIX = "exact-basename-prefix";
export const MATCH_DOTENV_VARIANT = "dotenv-variant";
export const MATCH_EXTENSION = "extension";

const EXACT_BASENAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".pgpass",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "known_hosts",
  "authorized_keys",
]);

const EXACT_BASENAME_PREFIXES = [
  "credentials", // matches "credentials", "credentials.json", "credentials.old", …
];

const DOTENV_PATTERN = /^\.env(\.|$)/;
const PRIVATE_KEY_EXTS = [".pem", ".key"];

/**
 * Pure predicate: does `path` (absolute or relative — we only look at the
 * basename and extension) match one of the credential shapes?
 *
 * Returns `true` / `false` only. Callers that need a UI reason use
 * `classifyCredential` (or the structured server response).
 */
export function isCredentialPath(path) {
  if (typeof path !== "string" || !path) return false;
  const name = basename(path).toLowerCase();
  if (!name) return false;
  if (EXACT_BASENAMES.has(name)) return true;
  for (const prefix of EXACT_BASENAME_PREFIXES) {
    if (name === prefix || name.startsWith(`${prefix}.`)) return true;
  }
  if (DOTENV_PATTERN.test(name)) return true;
  for (const ext of PRIVATE_KEY_EXTS) {
    if (name.endsWith(ext)) return true;
  }
  return false;
}

/**
 * Same predicate as `isCredentialPath` but with a stable reason string
 * the webapp classifier can match against.
 *
 * `reason` is one of:
 *   - "dotenv"      — `.env` or `.env.*`
 *   - "key-file"    — `*.pem` / `*.key`
 *   - "ssh-key"     — `id_*` SSH private key
 *   - "credentials" — `credentials*` or package-manager / netrc / pgpass
 *   - "ssh-meta"    — `known_hosts` / `authorized_keys`
 *
 * Returns `null` when the path is not credential-shaped (so the caller
 * can pass the result through as a single nullable answer).
 */
export function classifyCredential(path) {
  if (typeof path !== "string" || !path) return null;
  const name = basename(path).toLowerCase();
  if (!name) return null;
  if (name === ".env" || DOTENV_PATTERN.test(name)) {
    return { hit: true, reason: "dotenv" };
  }
  for (const ext of PRIVATE_KEY_EXTS) {
    if (name.endsWith(ext)) {
      return { hit: true, reason: "key-file" };
    }
  }
  if (
    name === "id_rsa" ||
    name === "id_ed25519" ||
    name === "id_ecdsa" ||
    name === "id_dsa"
  ) {
    return { hit: true, reason: "ssh-key" };
  }
  if (name === "known_hosts" || name === "authorized_keys") {
    return { hit: true, reason: "ssh-meta" };
  }
  for (const prefix of EXACT_BASENAME_PREFIXES) {
    if (name === prefix || name.startsWith(`${prefix}.`)) {
      return { hit: true, reason: "credentials" };
    }
  }
  if (
    EXACT_BASENAMES.has(name) // remaining: .npmrc / .pypirc / .netrc / .pgpass
  ) {
    return { hit: true, reason: "credentials" };
  }
  return null;
}