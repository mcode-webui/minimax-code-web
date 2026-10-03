// webapp/test/helpers/dom.ts
//
// A mounted-DOM harness for the Node test runner: real elements, real
// bubbling events, real React effects.
//
// Why it exists
// -------------
//
// The webapp suite renders through `react-dom/server`'s
// `renderToStaticMarkup`, which produces a string and therefore cannot
// dispatch an event, run an effect, or observe a re-render. A defect that
// only shows up when a keydown actually reaches a handler is therefore
// invisible to it: the shortcut rebind box in
// `components/settings-extra-pages.tsx` had a whole capture → verdict →
// conflict-report path that no test could enter, and a mutation that
// swallowed the conflict report left the suite green (SB-2's M9).
//
// This module closes that hole without displacing `renderToStaticMarkup`.
// The two coexist by design: static markup is the right tool for "what
// does this page print", a mounted root for "what happens when the user
// presses a key". A test file picks one, or both.
//
// Why happy-dom
// -------------
//
// The three candidates, on the axes that decide it here:
//
//   | dependency        | transitive deps | what it buys           | what it costs            |
//   |-------------------|-----------------|------------------------|--------------------------|
//   | `jsdom` 30        | 22              | the reference impl.    | `undici` + `css-tree` +  |
//   |                   |                 |                        | `whatwg-url` ≈ 20 MB     |
//   | `happy-dom` 20    | 4               | elements, events,      | 8 MB unpacked            |
//   |                   |                 | storage, MutationObs.  |                          |
//   | `@testing-library` | 2 more on top   | queries, `user-event`  | needs its own global     |
//   |                   | of either        | ergonomics             | install/cleanup protocol |
//
// The suite drives `node:test`, not Vitest's DOM environment, so
// testing-library would bring its own `beforeEach`/auto-cleanup machinery
// that this runner does not have. Everything it would provide — mount,
// query, dispatch, unmount — is about forty lines here, and those forty
// lines are the contract this suite actually wants to read. jsdom buys
// spec completeness this suite does not exercise: the tests assert on
// attributes, text and event delivery, none of which is where jsdom and
// happy-dom diverge in practice.
//
// `dom-shim.ts` stays as it is. It serves a `DOMParser` to the markdown
// walker over `parse5` and needs no window at all; replacing it with a
// full DOM would be a downgrade.
//
// Import order
// ------------
//
// `react-dom` captures `canUseDOM` when it is first evaluated, so the
// globals below must exist before it loads. ES modules evaluate a
// module's dependencies in declaration order, so **import this module
// before any component import** in a test file. `react-dom/client` is
// then pulled in with a dynamic import from here, so it cannot be
// evaluated early even if a component reaches it. Getting the order
// wrong is loud, not silent: React falls back to its no-DOM host config
// and `mount()` renders nothing, so the first assertion fails.

import { act } from "react";
import type { ReactElement } from "react";

import { installHappyDom, type HappyWindow } from "./happy-window";

// `IS_REACT_ACT_ENVIRONMENT` is React 18's switch for "this root is
// driven by a test, not by a user". Without it `act()` warns on every
// call. Declared through a typed alias rather than a `var` redeclaration:
// `lib: ["dom"]` already types the ambient global, and a narrower
// structural type fails `tsc` with TS2403.
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

/** One event to deliver to a mounted tree. */
export interface KeyPress {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

/** A live React root over a real DOM subtree. */
export interface Mounted {
  /** The element the tree is mounted into. */
  readonly container: HTMLElement;
  /** The window backing the tree; its `localStorage` is the real one. */
  readonly window: HappyWindow;

  /** The one element with `data-testid="<testId>"`, or a thrown error. */
  find(testId: string): HTMLElement;
  /** The same lookup without the throw. */
  query(testId: string): HTMLElement | null;
  /** Every element with the testid, in document order. */
  findAll(testId: string): HTMLElement[];
  /** `textContent` of the testid element, or `null` when absent. */
  text(testId: string): string | null;
  /** Whether the testid element is currently rendered. */
  has(testId: string): boolean;

  /** Dispatch a bubbling, cancelable `keydown` and await React's flush. */
  pressKey(target: string | HTMLElement, press: KeyPress): Promise<void>;
  /**
   * Build a `keydown` the harness will dispatch, for the cases that assert
   * on the event object itself — whether the handler cancelled it, most of
   * all, which is the only evidence that a captured combination did not
   * also run its own action.
   */
  keyEvent(press: KeyPress): KeyboardEvent;
  /** Dispatch a bubbling, cancelable `click` and await React's flush. */
  click(target: string | HTMLElement): Promise<void>;
  /** Dispatch any event type and await React's flush. */
  fire(target: string | HTMLElement, type: string, init?: EventInit): Promise<void>;
  /**
   * Run an arbitrary block inside `act`, for the cases the typed helpers
   * do not cover — asserting on the raw `KeyboardEvent` object after the
   * handler consumed it, most of all. Dispatching outside `act` still
   * works but makes React warn on every state update it causes.
   */
  run<T>(fn: () => T | Promise<T>): Promise<T>;
  /** Type into an input the way a user does, one value + input event. */
  type(target: string | HTMLElement, value: string): Promise<void>;

  /** Re-render the root with a new tree, awaiting effects. */
  rerender(node: ReactElement): Promise<void>;
  /** Let queued microtasks and zero-delay timers drain. */
  flush(): Promise<void>;
  /** The container's serialized markup, for snapshot-style assertions. */
  html(): string;

  /** Unmount the root and detach the container. Idempotent. */
  unmount(): Promise<void>;
}

// The window has to exist before `react-dom` is evaluated: react-dom
// captures `canUseDOM` once, when it is first evaluated, and a false
// there silently disables the whole delegated event system. This module's
// body is the only place guaranteed to run before the dynamic import
// below, so the installation happens here rather than on first `mount()`.
const sharedWindow: HappyWindow = installHappyDom();

// `react-dom` is imported dynamically, AFTER the window above exists —
// see the import-order note at the top of this file.
const { createRoot } = await import("react-dom/client");

/** Empty `localStorage`, for a `beforeEach`. */
export function resetStorage(): void {
  sharedWindow.localStorage.clear();
}

/** The first `data-testid` match, or a thrown error carrying the markup. */
function requireTestId(container: HTMLElement, testId: string): HTMLElement {
  const found = container.querySelector(`[data-testid="${testId}"]`);
  if (!found) {
    const rendered = Array.from(container.querySelectorAll("[data-testid]"))
      .map((node) => `  ${node.getAttribute("data-testid")}`)
      .join("\n");
    throw new Error(
      `no element with data-testid="${testId}" in the mounted tree.\n` +
        `testids actually rendered:\n${rendered || "  (none — the tree rendered empty)"}`,
    );
  }
  return found as HTMLElement;
}

function resolveTarget(container: HTMLElement, target: string | HTMLElement): HTMLElement {
  return typeof target === "string" ? requireTestId(container, target) : target;
}

/** Let React's work loop and any pending timers settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Mount `node` into the shared document and return a handle over it.
 *
 * The initial render is wrapped in `act`, so effects (`useEffect`,
 * `useLayoutEffect`) have run by the time this resolves — a test that
 * mounts and immediately reads the DOM sees the settled tree, not the
 * first pass.
 */
export async function mount(node: ReactElement): Promise<Mounted> {
  const container = document.createElement("div");
  container.setAttribute("data-testid", "dom-harness-root");
  document.body.appendChild(container);

  const root = createRoot(container);
  let disposed = false;
  await act(async () => {
    root.render(node);
  });

  const handle: Mounted = {
    container,
    window: sharedWindow,

    find: (testId) => requireTestId(container, testId),
    query: (testId) => container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null,
    findAll: (testId) => Array.from(container.querySelectorAll(`[data-testid="${testId}"]`)),
    text: (testId) => handle.query(testId)?.textContent ?? null,
    has: (testId) => handle.query(testId) !== null,

    // The bare `Event` / `KeyboardEvent` / `MouseEvent` identifiers are
    // the globals `happy-window.ts` installed: at runtime they are
    // happy-dom's constructors, while `tsc` checks them against lib.dom.
    // That is the one place the two DOM typings meet, and it is where
    // they agree — dispatch only needs `type`, `bubbles` and
    // `cancelable`, which both declare.
    keyEvent: (init) => new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    async pressKey(target, press) {
      const element = resolveTarget(container, target);
      await act(async () => {
        element.dispatchEvent(handle.keyEvent(press));
      });
    },
    async click(target) {
      const element = resolveTarget(container, target);
      await act(async () => {
        element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
    },
    async fire(target, type, init) {
      const element = resolveTarget(container, target);
      await act(async () => {
        element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
      });
    },
    async type(target, value) {
      const element = resolveTarget(container, target) as HTMLInputElement;
      // React reads the value off the DOM node, so the native setter has
      // to be used: assigning `.value` directly is swallowed by React's
      // value tracker and the component never sees a change.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      await act(async () => {
        setter?.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },

    async run(fn) {
      return act(async () => fn());
    },

    async rerender(next) {
      await act(async () => {
        root.render(next);
      });
    },
    flush: settle,
    html: () => container.innerHTML,

    async unmount() {
      if (disposed) return;
      disposed = true;
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };

  return handle;
}

/**
 * Mount `node`, hand it to `fn`, and unmount it whatever `fn` does.
 *
 * The unmount runs on the throw path too: a failing assertion must not
 * leave a live root (and its timers) behind for the next test in the
 * file.
 */
export async function withDom<T>(node: ReactElement, fn: (view: Mounted) => Promise<T> | T): Promise<T> {
  const view = await mount(node);
  try {
    return await fn(view);
  } finally {
    await view.unmount();
  }
}
