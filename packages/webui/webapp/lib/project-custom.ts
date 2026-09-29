// webapp/lib/project-custom.ts
//
// Browser-local project customizations for the sidebar's project nodes
// (ticket 55c): a display-name overlay ("重命名项目") and a pinned set
// ("置顶项目").
//
// Why client-side localStorage rather than a server contract: the sidebar's
// tree is assembled server-side from mcode's runtime db, where a project is
// not an entity — it is the git repository root its directories resolve to
// (`server/lib/session-tree.js#buildTree`), and the name is that root's
// basename. There is no mcode surface to write a custom project name or a
// pin flag into, so the overlay lives where the only consumer lives. The
// session-title overlay this mirrors (`titleCustom` on the webui wrapper
// record) had the same shape: an overlay keyed by the id that groups the
// rows.
//
// Keying is by the project's `key` (the name the server grouped under).
// Two unrelated repositories that share a basename share a node and
// therefore a customization — the same ambiguity `buildTree` already
// accepts for grouping, recorded in its header comment.
//
// The payload is NOT namespaced per cid (unlike `persist.ts`'s UI state):
// a rename or a pin describes the project, not a browser session, so every
// tab of this browser should see it. Writes are best-effort; a failed write
// (private mode, quota) leaves the in-memory state correct, matching
// `persist.ts`'s failure policy.

/** Storage key. `v1` — bump to force a clean slate on a format change. */
const KEY = "webui:project-custom:v1";

const VERSION = 1;

export interface ProjectCustomizations {
  /** project key → user-set display name (重命名项目). */
  titles: Record<string, string>;
  /** Pinned project keys, in the order they were pinned (置顶项目). */
  pinned: string[];
}

export const DEFAULT_PROJECT_CUSTOMIZATIONS: ProjectCustomizations = {
  titles: {},
  pinned: [],
};

interface StoredPayload {
  version: number;
  titles?: Record<string, string>;
  pinned?: string[];
}

/** Best-effort read; anything unreadable or wrong-version falls back to defaults. */
export function readProjectCustomizations(): ProjectCustomizations {
  if (typeof window === "undefined") return { ...DEFAULT_PROJECT_CUSTOMIZATIONS };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PROJECT_CUSTOMIZATIONS };
    const parsed = JSON.parse(raw) as StoredPayload;
    if (!parsed || parsed.version !== VERSION) return { ...DEFAULT_PROJECT_CUSTOMIZATIONS };
    return {
      titles:
        parsed.titles && typeof parsed.titles === "object"
          ? Object.fromEntries(
              Object.entries(parsed.titles).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            )
          : {},
      pinned: Array.isArray(parsed.pinned)
        ? parsed.pinned.filter((key): key is string => typeof key === "string")
        : [],
    };
  } catch {
    return { ...DEFAULT_PROJECT_CUSTOMIZATIONS };
  }
}

/** Best-effort write; never throws (see header). */
function write(custom: ProjectCustomizations): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ version: VERSION, ...custom }));
  } catch {
    // Quota / private mode: the in-memory state stays correct for this
    // session; persistence silently no-ops.
  }
}

/** Set / clear a project's display name. An empty title removes the entry. */
export function setProjectTitle(key: string, title: string): ProjectCustomizations {
  const next = readProjectCustomizations();
  if (title) next.titles[key] = title;
  else delete next.titles[key];
  write(next);
  return next;
}

/** Toggle a project's pin. Pinning prepends so newest pins sit at the top. */
export function toggleProjectPinned(key: string): ProjectCustomizations {
  const next = readProjectCustomizations();
  if (next.pinned.includes(key)) next.pinned = next.pinned.filter((entry) => entry !== key);
  else next.pinned = [key, ...next.pinned];
  write(next);
  return next;
}

/** Drop every customization for a project (used when the project is removed). */
export function clearProjectCustomizations(key: string): ProjectCustomizations {
  const next = readProjectCustomizations();
  delete next.titles[key];
  next.pinned = next.pinned.filter((entry) => entry !== key);
  write(next);
  return next;
}
