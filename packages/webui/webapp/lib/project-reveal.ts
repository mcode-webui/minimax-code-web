import type { FileOpenResult, TreeProject } from "./api";

/**
 * Project-level 「在文件夹中显示」 (SB-6).
 *
 * The item was a placeholder claiming a browser cannot reach the OS file
 * manager. That was never true: the server already exposes
 * `POST /api/fs/reveal` (`server/routes/fs.js#handleFsReveal`), and a webui
 * install is normally the same machine that holds the workspace. What was
 * missing was the wire, not the capability.
 *
 * The two functions here are the whole contract, and they are here rather
 * than inside `components/session-tree.tsx` so that both are driveable in
 * `node:test` without a render harness — the same reason
 * `lib/session-switch.ts` and `lib/cap-toast.ts` exist. The component owns
 * the markup and nothing else.
 *
 * The dependencies are injected rather than imported. `revealInFileManager`
 * and `reportActionError` are one line each at the only call site, and
 * injecting them is what makes "a failed reveal must report" a testable
 * assertion instead of a comment.
 */

/** The transports `runProjectReveal` needs, supplied by the component. */
export interface ProjectRevealDeps {
  /** `POST /api/fs/reveal` — resolves with the result, never rejects on HTTP error. */
  reveal: (path: string) => Promise<FileOpenResult>;
  /** `lib/action-errors#reportActionError` — the surface that makes a failure visible. */
  report: (label: string, cause: unknown) => void;
}

/**
 * The single path a project row offers: its first repository root, falling
 * back to the first directory holding sessions.
 *
 * A project is not an entity in mcode's runtime db — it is the git root its
 * directories resolve to (`server/lib/session-tree.js#buildTree`) — so this is
 * the same rule the 切换目录 row already used, and the two share one helper so
 * they cannot drift. A multi-directory project exposes the per-directory
 * choice through DirectoryNode; this is the broad-stroke target.
 *
 * Returns `""` when the project is bound to no local directory at all. The
 * caller renders the item disabled with an accurate reason; the request is
 * never fired at an empty path.
 */
export function projectRevealTarget(project: TreeProject): string {
  const first = project.repoPaths[0] ?? project.directories[0]?.path;
  return (first ?? "").trim();
}

/**
 * Fire one reveal, reporting whatever did not work.
 *
 * `revealInFileManager` resolves with `FileOpenResult` on HTTP errors too, so
 * a `try/catch` alone would swallow every refusal the server states — the
 * `!result.ok` branch is the half that actually matters. Both halves report
 * through the same surface as the menu's other writes, with the menu's own
 * localized label so the banner names the action rather than a status code.
 *
 * Resolves `true` only when the server reported success. Success itself is
 * silent: the file manager window opening is the feedback, and a toast would
 * race it.
 */
export async function runProjectReveal(
  target: string,
  label: string,
  deps: ProjectRevealDeps,
): Promise<boolean> {
  const path = target.trim();
  // Pre-check, restated here so the guard does not live only in the menu's
  // `disabled` prop. A disabled antd row is a UI affordance, not an
  // invariant; this is the invariant.
  if (!path) return false;

  let result: FileOpenResult;
  try {
    result = await deps.reveal(path);
  } catch (cause) {
    deps.report(label, cause);
    return false;
  }
  if (!result.ok) {
    deps.report(label, result.error ?? result.code ?? "unknown error");
    return false;
  }
  return true;
}
