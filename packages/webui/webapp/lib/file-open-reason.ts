// webapp/lib/file-open-reason.ts
//
// Pure classifier for the right-hand preview's unsupported state. The
// read-file endpoint (`/api/fs/read-file`) signals "I can't show you
// this in the preview pane" with four distinguishable shapes:
//
//   - binary     — payload.binary === true, payload.mime tells us what
//                  the server thinks the file actually is
//   - oversize   — payload.error starts with "file too large"
//   - outOfBounds — payload.error matches the containment regex the
//                  server surfaces for out-of-root paths
//   - unknown    — anything else (HTTP error string, network failure
//                  translated by lib/api.ts#request, etc.)
//
// The file-preview.tsx component's `PreviewError` block renders the
// reason + the two action buttons, and the action buttons themselves
// must be disabled when the underlying cause makes the action pointless
// (out-of-bounds: the path is not in the workspace, so the OS opener
// cannot be given a target). Extracting the classifier here keeps the
// React surface thin AND lets unit tests pin the mapping without
// spinning up React — same precedent as `lib/file-preview.ts`.

import type { FsFilePayload } from "./api";

export type UnsupportedReason = "binary" | "oversize" | "outOfBounds" | "unknown";

export interface UnsupportedView {
  /** One of the four unsupported categories. */
  reason: UnsupportedReason;
  /** Whether the "open with default app" / "reveal in file manager"
   *  actions make sense at all. Both are useless when the path is
   *  out-of-bounds (the server already rejected it), and the
   *  `missing-path` reason makes the buttons meaningless too — those
   *  are the cases where the UI must disable the row so a click never
   *  fires a doomed request. */
  actionsAvailable: boolean;
  /** Parameter bag for the i18n template. The component substitutes
   *  `{{mime}}` / `{{error}}` on the way to the user; passing the raw
   *  values through the helper keeps the React layer free of
   *  presentation branching. */
  params: { mime?: string; error?: string };
}

// Matches the `gateError` body the server emits from
// `assertWorkspacePath` failures — the Chinese containment copy
// ("不在允许范围内") plus the env-var hint ("MCODE_WEBUI_WORKSPACE_ROOTS")
// and the English keyword "allowed root" all reach the wire here.
// The slice-14 file-preview.tsx PreviewError block used to carry
// its own `/越界|allowed root|MCODE_WEBUI_WORKSPACE_ROOTS/i` regex;
// centralising the predicate here keeps the classifier the only
// owner so the two views cannot drift.
const CONTAINMENT_RE =
  /不在允许(的)?(工作区|根)|路径不在允许|allowed root|越界|MCODE_WEBUI_WORKSPACE_ROOTS/i;

/**
 * Classify the unsupported preview state.
 *
 * Pure function: same inputs always produce the same classification,
 * and the React layer never has to inspect the payload fields directly.
 * Tests pin this in `webapp/test/file-open-reason.test.ts`.
 */
export function classifyUnsupported(
  error: string,
  payload: FsFilePayload | null,
): UnsupportedView {
  // Containment is the strongest signal — checked first so a path the
  // server also said is "binary" still gets routed to the "this path
  // is unreachable" branch. The buttons are useless in this state:
  // the server already refused the path, the OS opener would be given
  // the same path, and the route would refuse it again.
  if (CONTAINMENT_RE.test(error)) {
    return {
      reason: "outOfBounds",
      actionsAvailable: false,
      params: { error },
    };
  }
  // Binary detection: the server flips payload.binary on read failures
  // it considers binary. mime / language stay populated so the user
  // sees what they tried to open.
  if (payload?.binary === true) {
    return {
      reason: "binary",
      actionsAvailable: true,
      params: { mime: payload.mime || "unknown type" },
    };
  }
  // Over-size: the read-file endpoint rejects anything > 512 KiB with
  // a `file too large (max <n> bytes)` error. The cap is the only
  // prefix this branch reads — the rest of the message is the cap
  // number, which is not interesting here.
  if (error.startsWith("file too large")) {
    return {
      reason: "oversize",
      actionsAvailable: true,
      params: {},
    };
  }
  // Catch-all. Anything that did not match the above — a network
  // failure, an HTTP 500, a missing file — lands here. The OS opener
  // may still help: a "not found" is fatal for the buttons, but the
  // component does not get that level of detail from the wire (the
  // request helper reduces everything to an `Error`). Keep the
  // buttons enabled and let the server's structured code disable
  // them when the click arrives (`code === "not-a-regular-file"`).
  return {
    reason: "unknown",
    actionsAvailable: true,
    params: { error },
  };
}
