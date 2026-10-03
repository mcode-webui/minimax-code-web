// webapp/lib/engine-capabilities.ts
//
// M3-B9 — the frontend half of the mode-write capability gate.
//
// The server answers a 501 when the connected engine provider declares no
// session-mode write or no generic config-option write (see
// `server/engine/mode-writes.js`). Design §4.2 says what the UI does with
// that: the entry point is HIDDEN, not answered with an error toast. A
// toast is the wrong shape for a capability that was never there — it
// reports a failure for something the user was never able to do, it
// cannot be acted on, and it reappears on every click.
//
// So the rule lives here, as data, and the controls read it. Nothing in
// the composer is allowed to interpret a 501 itself: two places each
// deciding "what does not-supported mean" is how a second one ends up
// growing a toast.
//
// The rule is deliberately FAIL-OPEN. A control is shown unless the
// declaration positively says the capability is absent:
//
//   - the probe failed, timed out, or has not finished → SHOW. We do not
//     know, and hiding a working control because a diagnostic request was
//     slow is a worse failure than showing one that may not work.
//   - the capability is `full` → SHOW.
//   - the capability is `partial` → SHOW unless THIS control's sub-item
//     is the one listed missing.
//   - the capability is `none` → HIDE.
//
// Two controls are the reason this file exists: the permission-mode
// selector and the model selector. Both are declared by
// `MODE_WRITE_BRIDGED_CONFIG_IDS` on the server, the two config ids the
// mode-write gate exempts from the generic-write refusal, so a provider
// that refuses generic config options still serves both. That table is
// mirrored here — one small literal — and
// `webapp/test/engine-capabilities-degradation.test.ts` reads the server
// module's source and fails if the two ever disagree. A mirror without
// that tripwire would be exactly the kind of drift this repository has
// been bitten by before.

/** One declared capability, as the server serialises it. */
export interface EngineCapabilityEntry {
  level: "full" | "partial" | "none";
  missing?: string[];
  reason?: string;
}

/** The 14-key declaration, or `null` when it could not be read. */
export type EngineCapabilities = Record<string, EngineCapabilityEntry> | null;

/**
 * The two config ids the mode-write gate bridges, and the engine
 * sub-item each asks for instead of the generic one.
 *
 * Mirrors `MODE_WRITE_BRIDGED_CONFIG_IDS` in
 * `server/engine/mode-writes.js`. Read it there, not here, when the two
 * disagree — and make them agree rather than picking one.
 */
export const BRIDGED_CONFIG_SUB_ITEMS = Object.freeze({
  model: "selectModel",
  permissionMode: "setPermissionMode",
} as const);

/** The two config ids with a dedicated engine write behind them. */
export type BridgedConfigId = keyof typeof BRIDGED_CONFIG_SUB_ITEMS;

/** What a control should do, and why — `reason` is for logs, not for the user. */
export interface ControlAvailability {
  available: boolean;
  /** The declaration's own `reason` when the control is hidden. */
  reason: string | null;
}

/**
 * Is one engine control usable, given the declaration?
 *
 * Pure, and the only place the rule exists. Every input shape is
 * answered, because the shapes arrive from the network and from a
 * half-initialised component: a `null` declaration, a missing key, a
 * `partial` with no `missing` array, an unknown `level`.
 *
 * @param declaration  The 14-key declaration, or `null` if unread.
 * @param capability    One of the server's capability keys.
 * @param subItem       The engine sub-item this control needs.
 */
export function controlAvailability(
  declaration: EngineCapabilities,
  capability: string,
  subItem: string,
): ControlAvailability {
  // Unread declaration: show. See the module header — failing closed
  // here would hide working controls because a diagnostic request was
  // slow, which is a self-inflicted outage.
  if (!declaration) return { available: true, reason: null };
  const entry = declaration[capability];
  // A declaration missing a key is malformed — the server's own
  // validator requires all 14 — so it is not evidence of absence.
  if (!entry) return { available: true, reason: null };
  if (entry.level === "full") return { available: true, reason: null };
  if (entry.level === "partial") {
    const missing = Array.isArray(entry.missing) ? entry.missing : [];
    if (!missing.includes(subItem)) return { available: true, reason: null };
    return { available: false, reason: entry.reason ?? null };
  }
  if (entry.level === "none") return { available: false, reason: entry.reason ?? null };
  // An unrecognised level is not "absent". The server validates the three
  // levels; anything else means a version skew, and version skew is not a
  // reason to remove a control.
  return { available: true, reason: null };
}

/** `controlAvailability` for one of the two bridged controls. */
export function bridgedControlAvailability(
  declaration: EngineCapabilities,
  configId: BridgedConfigId,
): ControlAvailability {
  return controlAvailability(declaration, "authCredentials", BRIDGED_CONFIG_SUB_ITEMS[configId]);
}

/**
 * Read the declaration once per page and share it.
 *
 * Module-level cache with an in-flight promise, because the two controls
 * mount together and a per-component fetch would double the request on
 * every composer mount. The cache is deliberately NOT invalidated: a
 * provider's declaration does not change while the page is open, and a
 * poller here would be a new failure surface for no benefit.
 */
let cached: Promise<EngineCapabilities> | null = null;

/** Drop the cache. Test-only; production never has a reason to. */
export function resetEngineCapabilitiesCache(): void {
  cached = null;
}

/**
 * Fetch `GET /api/engine-capabilities` and return its declaration.
 *
 * Resolves to `null` for every failure — network, non-200, unparseable,
 * wrong shape — because "we do not know" and "the engine cannot do it"
 * must not look alike to a control. The caller never has to catch.
 */
export function readEngineCapabilities(): Promise<EngineCapabilities> {
  if (cached) return cached;
  cached = (async () => {
    try {
      const res = await fetch("/api/engine-capabilities", {
        headers: { accept: "application/json" },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { capabilities?: unknown };
      const caps = body?.capabilities;
      if (!caps || typeof caps !== "object") return null;
      return caps as Record<string, EngineCapabilityEntry>;
    } catch {
      return null;
    }
  })();
  return cached;
}
