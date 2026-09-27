// webapp/lib/credential-file.ts
//
// TypeScript mirror of `server/lib/credential-file.js`. The two files
// MUST agree on hits/misses (the shared fixture test pins both) so the
// server gate and the webapp classifier cannot drift.
//
// Background: webui-parity slice 16 (2026-09-27 user decision). The
// webui server broadcasts a LAN URL when `lanBind` is on, so the same
// LAN segment can reach `/api/fs/read-file` and read `.env` /
// `~/.ssh/id_rsa` as plaintext. The user chose **default-refuse preview
// with a clear explanation + a second confirmation** — so the
// credential shape is decided server-side (the real gate) and the
// webapp is a presenter over the server's structured answer.
//
// The matching rules are documented in
// `server/lib/credential-file.js#CREDENTIAL_FIXTURES`. The fixture set
// is mirrored verbatim here (and asserted by
// `webapp/test/credential-file.test.ts`); the JS predicate is the
// canonical implementation and this file is a near-verbatim port
// because the two runtimes cannot share a module file without pulling
// the whole Next.js / Hono bundle graph into the other side.

/** Match shapes the fixture table distinguishes. */
export type CredentialMatchShape =
  | "exact-basename"
  | "exact-basename-prefix"
  | "dotenv-variant"
  | "extension"
  | "backup-suffix";

export interface CredentialFixture {
  match: CredentialMatchShape;
  /** Names that MUST be classified as credentials. */
  hits: string[];
  /** Near-miss names that MUST NOT be classified (legibility check). */
  misses: string[];
}

/**
 * The canonical fixture set the server predicate (lib/credential-file.js)
 * and the webapp predicate (this file) both read. Keep in lockstep — the
 * shared test walks this list once for each implementation.
 */
export const CREDENTIAL_FIXTURES: CredentialFixture[] = [
  {
    match: "exact-basename",
    hits: [
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
    ],
    misses: [
      "env",
      ".envrc",
      "environment.ts",
      "env.js",
      "Environment.txt",
      ".envvars",
    ],
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

export type CredentialSubReason =
  | "dotenv"
  | "key-file"
  | "ssh-key"
  | "credentials"
  | "ssh-meta";

const EXACT_BASENAMES = new Set<string>([
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

const EXACT_BASENAME_PREFIXES = ["credentials"];
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

function basenameOf(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  return base.toLowerCase();
}

/**
 * Pure predicate — same logic as `server/lib/credential-file.js#isCredentialPath`.
 *
 * Returns `true` / `false`. Callers that need a UI reason use
 * `classifyCredentialPath`.
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
export function isCredentialPath(path: string): boolean {
  if (typeof path !== "string" || !path) return false;
  const name = basenameOf(path);
  if (!name) return false;
  // Backup-suffix rule first — strip a trailing `.bak` / `.old` /
  // `.orig` / `.backup` / `.save` / `.swp` and re-test the stem.
  // The stem-only check (NOT `name.endsWith(".bak")`) is the
  // legibility gate: `.bak` alone is not enough; the predicate
  // re-runs against the bare stem.
  for (const suffix of BACKUP_SUFFIXES) {
    if (name.endsWith(suffix)) {
      const stem = name.slice(0, -suffix.length);
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

export interface CredentialHit {
  hit: true;
  reason: CredentialSubReason;
}

/**
 * Same predicate as `isCredentialPath` but with a stable sub-reason.
 * Returns `null` when the path is not credential-shaped.
 */
export function classifyCredentialPath(
  path: string,
): CredentialHit | null {
  if (typeof path !== "string" || !path) return null;
  const name = basenameOf(path);
  if (!name) return null;
  // Backup-suffix rule — same as isCredentialPath above.
  for (const suffix of BACKUP_SUFFIXES) {
    if (name.endsWith(suffix)) {
      const stem = name.slice(0, -suffix.length);
      return classifyCredentialPath(stem);
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
  if (EXACT_BASENAMES.has(name)) {
    return { hit: true, reason: "credentials" };
  }
  return null;
}