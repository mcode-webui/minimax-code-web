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
  | "extension";

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
    hits: [".env.local", ".env.production", ".env.development", ".env.test", ".env.example", ".env.local.bak"],
    misses: [".envrc"],
  },
  {
    match: "extension",
    hits: ["server.pem", "client.pem", "private.key", "tls.key", "foo.PEM", "bar.KEY"],
    misses: ["keyword.js", "house.json", "monkey.txt"],
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
 */
export function isCredentialPath(path: string): boolean {
  if (typeof path !== "string" || !path) return false;
  const name = basenameOf(path);
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