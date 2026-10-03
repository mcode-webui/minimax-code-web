// webapp/test/helpers/happy-window.ts
//
// The one place that puts a DOM on `globalThis` for the Node test
// runner. Split out of `dom.ts` so the installation can happen at module
// evaluation time, before `dom.ts` reaches for `react-dom`.
//
// Two constraints shaped the code:
//
//   1. Node ≥ 21 ships a read-only `globalThis.navigator`, so a plain
//      assignment throws in an ES module. Every global goes in through
//      `Object.defineProperty`, which is also the pattern
//      AGENTS.md prescribes for stubbing ambient globals in tests.
//   2. The window must be reachable for `new win.KeyboardEvent(…)`.
//      Dispatching an event the component did not construct is a real
//      difference from a browser: React compares against the event's own
//      prototypes, and a Node `Event` would be a different object.

import { Window } from "happy-dom";

/** The happy-dom window the harness drives. */
export type HappyWindow = Window;

/**
 * The globals copied off the window.
 *
 * Deliberately explicit rather than a `for (const key of Object.keys(win))`
 * loop: a blanket copy would overwrite Node's own `Event`, `AbortController`
 * and `fetch`-adjacent globals with happy-dom's narrower implementations,
 * and a test that wanted the real one could not get it back. The list is
 * what a React webapp actually reaches for.
 */
const EXPOSED = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "localStorage",
  "sessionStorage",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "matchMedia",
  "Event",
  "CustomEvent",
  "UIEvent",
  "KeyboardEvent",
  "MouseEvent",
  "InputEvent",
  "FocusEvent",
  "PointerEvent",
  "ClipboardEvent",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "HTMLFormElement",
  "HTMLAnchorElement",
  "SVGElement",
  "Text",
  "Comment",
  "DocumentFragment",
  "ShadowRoot",
  "NodeList",
  "HTMLCollection",
  "DOMParser",
  "XMLSerializer",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
  "PerformanceObserver",
  "AbortController",
  "Blob",
  "URL",
  "CSS",
  "Image",
] as const;

let installed: Window | null = null;

/**
 * Create a happy-dom window and publish its globals.
 *
 * Idempotent: the same window is returned for every call, so a test file
 * that mounts ten components still has one `localStorage` origin and one
 * `document`.
 */
export function installHappyDom(url = "http://localhost/"): Window {
  if (installed) return installed;

  const win = new Window({ url });
  const target = globalThis as unknown as Record<string, unknown>;

  for (const key of EXPOSED) {
    const value = (win as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    // `window` is published as the window itself, not as a property of
    // it — happy-dom's `win.window` is already `win`.
    Object.defineProperty(target, key, {
      configurable: true,
      writable: true,
      enumerable: false,
      value: key === "window" ? win : value,
    });
  }

  installed = win;
  return win;
}
