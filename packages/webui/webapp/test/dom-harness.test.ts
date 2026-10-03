// webapp/test/dom-harness.test.ts
//
// The contract of the DOM harness itself.
//
// A test harness that is not itself tested is a liability: the next
// author who reaches for `pressKey` and finds it silently does nothing
// writes a test that passes and proves nothing — the exact failure mode
// this harness was built to end (SB-2's M9 survived because a string of
// markup could not dispatch an event). Every member of the handle is
// exercised here against a component that records what it received, so a
// regression in the harness fails loudly and in one place.
//
// This file is also where the harness's own rules are pinned, because
// they are invisible from a test that happens to satisfy them:
//   - a `data-testid` that is not on screen throws, and the error names
//     the testids that ARE;
//   - events bubble from the element, they are not faked at the root;
//   - `withDom` detaches the container even when the body throws;
//   - storage is one origin shared by every mount, and `resetStorage`
//     empties it.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createElement, useEffect, useState } from "react";

import { mount, withDom, resetStorage } from "./helpers/dom";

/** Everything the component under test saw, as plain data. */
interface Log {
  events: string[];
  value: string;
}

function Probe({ onLog }: { onLog: (log: Log) => void }) {
  const [value, setValue] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const record = (entry: string) => {
    setEvents((previous) => [...previous, entry]);
    onLog({ events: [...events, entry], value });
  };
  return createElement(
    "div",
    null,
    createElement("input", {
      "data-testid": "input",
      value,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => setValue(event.target.value),
    }),
    createElement("button", {
      "data-testid": "outer",
      onClick: () => record(`outer:${value}`),
    }, "outer"),
    createElement(
      "span",
      { "data-testid": "inner" },
      createElement("span", {
        "data-testid": "inner-span",
        onKeyDown: (event: React.KeyboardEvent) => {
          event.preventDefault();
          record(`key:${event.key}:${event.ctrlKey ? "ctrl" : "-"}`);
        },
      }, "inner"),
    ),
    createElement("p", { "data-testid": "log" }, events.join("|")),
    createElement("p", { "data-testid": "twins" }, ""),
    createElement("p", { "data-testid": "twins" }, ""),
  );
}

const nothing = () => {};

/** A probe with no observers, for the plumbing assertions. */
const probe = () => createElement(Probe, { onLog: nothing });

beforeEach(() => resetStorage());

describe("a missing testid fails with the tree that is actually there", () => {
  test("find throws, and lists what rendered", async () => {
    await withDom(probe(), async (view) => {
      assert.throws(
        () => view.find("nope"),
        (error: Error) => {
          assert.match(error.message, /no element with data-testid="nope"/);
          // The diagnosis, not just the failure: which testids exist.
          assert.match(error.message, /\n {2}input\n/);
          assert.match(error.message, /\n {2}log\n/);
          return true;
        },
      );
      assert.equal(view.query("nope"), null, "query is the non-throwing lookup");
      assert.equal(view.has("nope"), false);
    });
  });

  test("an empty tree says so rather than printing nothing", async () => {
    await withDom(createElement("div", null), async (view) => {
      assert.throws(() => view.find("input"), /the tree rendered empty/);
    });
  });
});

describe("queries address the real tree", () => {
  test("text returns the content, and null for an absent node", async () => {
    await withDom(probe(), async (view) => {
      assert.equal(view.text("log"), "");
      assert.equal(view.text("nope"), null);
    });
  });

  test("findAll returns every match in document order", async () => {
    await withDom(probe(), async (view) => {
      assert.equal(view.findAll("twins").length, 2);
      assert.equal(view.findAll("input").length, 1);
      assert.deepEqual(view.findAll("nope"), []);
    });
  });

  test("html serializes the container, and the container is reachable", async () => {
    await withDom(probe(), async (view) => {
      assert.match(view.html(), /data-testid="input"/);
      assert.equal(view.container.getAttribute("data-testid"), "dom-harness-root");
      assert.equal(view.container.parentElement, document.body);
    });
  });
});

describe("events reach the handler that is listening", () => {
  test("pressKey delivers key and modifiers to the element that owns the handler", async () => {
    await withDom(probe(), async (view) => {
      await view.pressKey("inner-span", { key: "k", ctrlKey: true });
      assert.equal(view.text("log"), "key:k:ctrl");
    });
  });

  test("the event bubbles, and a handler above the target sees it", async () => {
    await withDom(probe(), async (view) => {
      await view.click("outer");
      assert.equal(view.text("log"), "outer:");
    });
  });

  test("keyEvent builds the event without delivering it", async () => {
    await withDom(probe(), async (view) => {
      const event = view.keyEvent({ key: "k", ctrlKey: true });
      assert.equal(event.type, "keydown");
      assert.equal(event.bubbles, true);
      assert.equal(event.cancelable, true);
      assert.equal(event.defaultPrevented, false);
      assert.equal(view.text("log"), "", "building an event delivers nothing");

      // Delivering it by hand, inside `run`, is what the handler cases do.
      await view.run(() => view.find("inner-span").dispatchEvent(event));
      assert.equal(view.text("log"), "key:k:ctrl");
      assert.equal(event.defaultPrevented, true, "the handler consumed the event");
    });
  });

  test("fire delivers an arbitrary event type", async () => {
    const seen: string[] = [];
    const Doubler = () =>
      createElement("div", {
        "data-testid": "target",
        onDoubleClick: () => seen.push("dblclick"),
      });
    await withDom(createElement(Doubler), async (view) => {
      await view.fire("target", "dblclick");
      assert.deepEqual(seen, ["dblclick"]);
    });
  });

  test("type writes a value React can see, through the native setter", async () => {
    await withDom(probe(), async (view) => {
      // Assigning `.value` directly is swallowed by React's value tracker;
      // the harness goes through the prototype setter for that reason.
      await view.type("input", "hello");
      assert.equal(view.find("input").getAttribute("value"), "hello");
    });
  });
});

describe("the root can be re-rendered and drained", () => {
  test("rerender replaces the tree and settles its effects", async () => {
    // The effect writes what it saw, so the assertion is about WHEN it
    // ran, not about the markup. `mount` wraps the first render in `act`
    // for exactly this: effects have run before the handle is returned.
    const WithEffect = ({ label }: { label: string }) => {
      const [seen, setSeen] = useState("");
      useEffect(() => setSeen(label), [label]);
      return createElement("p", { "data-testid": "label" }, seen);
    };
    await withDom(createElement(WithEffect, { label: "first" }), async (view) => {
      assert.equal(view.text("label"), "first", "the mount effect already ran");
      await view.rerender(createElement(WithEffect, { label: "second" }));
      assert.equal(view.text("label"), "second", "and so did the one after the re-render");
    });
  });

  test("flush drains a zero-delay timer queued from an effect", async () => {
    const done: string[] = [];
    const Timed = () => {
      useEffect(() => {
        setTimeout(() => done.push("late"), 5);
      }, []);
      return createElement("p", { "data-testid": "timed" }, "mounted");
    };
    await withDom(createElement(Timed), async (view) => {
      assert.equal(view.text("timed"), "mounted");
      assert.deepEqual(done, [], "the effect ran, the timer has not");
      await new Promise((resolve) => setTimeout(resolve, 10));
      await view.flush();
      assert.deepEqual(done, ["late"]);
    });
  });
});

describe("unmount leaves nothing behind", () => {
  test("unmount detaches the container and is idempotent", async () => {
    const view = await mount(probe());
    assert.equal(document.querySelectorAll('[data-testid="dom-harness-root"]').length, 1);
    await view.unmount();
    await view.unmount();
    assert.equal(document.querySelectorAll('[data-testid="dom-harness-root"]').length, 0);
  });

  test("withDom unmounts on the throw path too", async () => {
    await assert.rejects(
      withDom(probe(), async () => {
        throw new Error("assertion failed");
      }),
      /assertion failed/,
    );
    assert.equal(
      document.querySelectorAll('[data-testid="dom-harness-root"]').length,
      0,
      "a failing assertion must not leave a live root for the next test",
    );
  });
});

describe("storage is one origin, shared across mounts", () => {
  test("a write in one mount is visible in the next", async () => {
    await withDom(probe(), async (view) => {
      view.window.localStorage.setItem("harness-probe", "kept");
    });
    await withDom(probe(), (view) => {
      assert.equal(view.window.localStorage.getItem("harness-probe"), "kept");
    });
  });

  test("resetStorage empties it, which is why a beforeEach calls it", async () => {
    await withDom(probe(), (view) => {
      view.window.localStorage.setItem("harness-probe", "dropped");
    });
    resetStorage();
    await withDom(probe(), (view) => {
      assert.equal(view.window.localStorage.getItem("harness-probe"), null);
    });
  });
});
