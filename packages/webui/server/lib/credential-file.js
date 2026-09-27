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
// v2.5 (slice 16 fix — backup suffixes): a backup of any of the
// shapes above (`.bak` / `.old` / `.orig` / `.backup` / `.save` /
// `.swp`) is treated as a credential too. Editors, `cp -b`, `git mv`
// renames, and vim's swap files all commonly produce these
// suffixes; an operator who saves a backup of `.env` next to itself
// does NOT remove the credential risk.
//
// What is NOT covered (deliberately):
//   - `environment.ts` / `env.js` — filenames containing the substring
//     "env" but not starting with `.env.` or named `.env`. The web is
//     full of files like that and pretending otherwise would break
//     legitimate previews.
//   - `.env.example` — IS treated as a credential (see the
//     `dotenv-variant` fixture below). Reasoning: the basename does
//     not tell us whether the file is a template or a real secret,
//     and the user's chosen posture is default-refuse; copy this
//     rule locally if your workflow ships templates you preview.
//   - `.git/config` — can hold remote URLs but not secrets in normal
//     use; if a future use case surfaces, add it to the table.
//   - arbitrary basenames inside `~/.ssh/` — `~/.ssh/id_rsa` IS matched,
//     but `~/.ssh/known_hosts` is too (basename match), and we do NOT
//     sweep everything under the directory (`.ssh/config` is
//     intentionally NOT covered for the same reason `environment.ts`
//     isn't).
//   - hardlinks. The predicate is name-based. Two names that point
//     at the same inode (a hardlink `config.txt → .env`) cannot be
//     distinguished by basename: the kernel does not expose the
//     "primary" name from the inode alone, and `stat` / `realpath`
//     both report the same metadata for either path. This is an
//     inherent limit of any name-based security rule; the predicate
//     defends against **symlinks** (a single name pointing at
//     another inode, which `realpathSync` resolves) but not against
//     hardlinks. Operators concerned about hardlink aliasing must
//     keep the workspace tree uncluttered; the security model here
//     assumes the workspace operator controls their files.
//   - symlink TOCTOU. The realpath check happens at request time;
//     a symlink swapped between the realpath check and the read
//     would defeat the gate. The webui process is single-threaded
//     per request and the file is read synchronously after the
//     realpath, so the window is microseconds; a paranoid
//     deployment can run on a read-only filesystem.
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
 *
 * v2.5 (slice 16 fix): the `backup-suffix` fixture below was added
 * because an operator who saves a backup of `.env` or `id_rsa`
 * (`.bak` / `.old` / `.orig` / `.backup` / `.save` / `.swp`) does
 * NOT remove the credential risk — the file is still a credential
 * — and must NOT preview without the second confirmation.
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
    // Note: `.env.example` IS treated as a credential even though it
    // typically contains placeholder values. Reasoning: the user
    // cannot tell from the basename whether a file's content is a
    // template or a real secret; the safer default is to ask before
    // rendering. (Operators who want different behaviour can copy
    // and tweak the predicate locally; the rule here is the
    // ticket's "default-refuse".)
    hits: [".env.local", ".env.production", ".env.development", ".env.test", ".env.example", ".env.local.bak"],
    misses: [".envrc"],
  },
  {
    match: "extension",
    hits: ["server.pem", "client.pem", "private.key", "tls.key", "foo.PEM", "bar.KEY"],
    misses: ["keyword.js", "house.json", "monkey.txt"],
  },
  {
    // Backup suffixes applied to a credential basename. Editors
    // commonly drop `.bak` / `~` next to a file; cp / mv / git
    // produce `.old` / `.orig` / `.backup`; vim produces `.swp`;
    // macOS / Windows produce `.save` after a forced save. The
    // pattern is: take a known-credential stem and append one of
    // the backup suffixes — the result is still a credential.
    match: "backup-suffix",
    hits: [
      // exact-basename + .bak / .old / .orig / .backup / .save / .swp
      ".env.bak", ".env.old", ".env.orig", ".env.backup", ".env.save", ".env.swp",
      ".env.local.bak", ".env.local.old", ".env.local.orig",
      "id_rsa.bak", "id_rsa.old", "id_rsa.orig", "id_rsa.backup", "id_rsa.save",
      "id_ed25519.bak", "id_ed25519.old",
      "known_hosts.bak", "known_hosts.old",
      "authorized_keys.bak", "authorized_keys.old",
      // private-key extensions + backup suffix
      "server.pem.bak", "server.pem.old", "server.pem.orig",
      "private.key.bak", "private.key.old",
      "tls.key.backup", "tls.key.save",
      // credentials prefix + backup suffix
      "credentials.bak", "credentials.old", "credentials.orig",
      "credentials.json.bak", "credentials.json.old",
      // the unix "rc" backup idiom
      ".npmrc.bak", ".npmrc.old",
      ".pypirc.bak", ".pypirc.old",
    ],
    misses: [
      // ".bak" applied to a NON-credential basename — the suffix
      // alone is not enough; the predicate still looks at the stem
      // (the part before the LAST `.bak`).
      "readme.md.bak", "notes.txt.bak", "package.json.bak",
      // .envrc has its own escape hatches and is not in the rule
      ".envrc.bak",
      // random file that happens to end with .bak but is unrelated
      "scratch.bak",
    ],
  },
];

/** Predicate entry points. See `MATCH_*` for the matching shapes. */
export const MATCH_EXACT_BASENAME = "exact-basename";
export const MATCH_EXACT_BASENAME_PREFIX = "exact-basename-prefix";
export const MATCH_DOTENV_VARIANT = "dotenv-variant";
export const MATCH_EXTENSION = "extension";
export const MATCH_BACKUP_SUFFIX = "backup-suffix";

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

// v2.5 (slice 16 fix): backup-suffix rule. Editors, `cp -b`, vim
// swap files, git/IDE backups, and macOS / Windows forced saves
// commonly produce one of these suffixes next to the file. The
// rule is: take a basename that matches the credential shapes
// above, strip a known backup suffix, and re-test the stem. The
// stem-only check matters — `.bak` alone is not enough (a file
// like `readme.md.bak` is not a credential), so we DO NOT apply
// the suffix rule to non-credential basenames.
const BACKUP_SUFFIXES = [".bak", ".old", ".orig", ".backup", ".save", ".swp"];

/**
 * Pure predicate: does `path` (absolute or relative — we only look at the
 * basename and extension) match one of the credential shapes?
 *
 * Returns `true` / `false` only. Callers that need a UI reason use
 * `classifyCredential` (or the structured server response).
 *
 * v2.5 (slice 16 fix): the backup-suffix rule is applied at the top
 * of this function. If the basename ends with one of the known
 * backup suffixes (`.bak` / `.old` / `.orig` / `.backup` / `.save` /
 * `.swp`), the suffix is stripped and the stem is re-tested against
 * the credential shapes. A basename like `readme.md.bak` has stem
 * `readme.md`, which is not a credential — the predicate stays
 * `false`. A basename like `id_rsa.bak` has stem `id_rsa`, which IS
 * a credential — the predicate returns `true`.
 */
export function isCredentialPath(path) {
  if (typeof path !== "string" || !path) return false;
  const name = basename(path).toLowerCase();
  if (!name) return false;
  // Backup-suffix rule first — strip a trailing `.bak` / `.old` /
  // `.orig` / `.backup` / `.save` / `.swp` and re-test the stem.
  // The stem-only check (NOT `name.endsWith(".bak")`) is the
  // legibility gate: `.bak` alone is not enough; the predicate
  // re-runs against the bare stem.
  for (const suffix of BACKUP_SUFFIXES) {
    if (name.endsWith(suffix)) {
      const stem = name.slice(0, -suffix.length);
      // Recurse with the stem. The recursive call cannot loop —
      // it strips a different suffix from a shorter name.
      return isCredentialPath(stem);
    }
  }
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
  // Backup-suffix rule — same as isCredentialPath above.
  for (const suffix of BACKUP_SUFFIXES) {
    if (name.endsWith(suffix)) {
      const stem = name.slice(0, -suffix.length);
      return classifyCredential(stem);
    }
  }
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