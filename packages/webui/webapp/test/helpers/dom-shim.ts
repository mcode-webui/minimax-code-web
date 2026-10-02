// webapp/test/helpers/dom-shim.ts
//
// A `DOMParser` stand-in for the Node test runner, built on the `parse5`
// already in the dependency tree.
//
// Why it exists
// -------------
//
// `components/markdown-html.tsx` converts the sanitised markdown into a
// React tree by walking a `DOMParser` document. Node has no `DOMParser`,
// and the project deliberately does not pull in jsdom/happy-dom (a
// multi-megabyte dependency for one walker). That left the walker
// untested: `MarkdownHtml` silently took its SSR `dangerouslySetInnerHTML`
// branch in every unit test, so a defect in the walker's output — the
// whitespace text nodes React refuses under `<table>`, for one — reached
// production with a green gate.
//
// The shim exposes exactly the DOM Level 1 surface the walker touches:
// `parseFromString`, `body`, `childNodes`, `nodeType`, `tagName`,
// `attributes`, `classList.contains`, `textContent`, `previousSibling`.
// It is deliberately not a general DOM: a walker that grows a new DOM
// dependency fails here loudly (undefined method) instead of silently
// testing against a fake that agrees with it.
//
// On parse5: the workspace has no HTML parser of its own and does not
// depend on one. `parse5` arrives through the Next.js tree and is pinned
// in `pnpm-lock.yaml`; it is reached with `createRequire` rather than an
// `import` because `@mavis/webui` does not declare it, and an undeclared
// `import` would break `webapp:typecheck` with TS7016. The coupling is
// test-only and stated here rather than hidden: if the transitive copy ever
// disappears, the shim throws the message below and the affected tests
// fail loudly instead of quietly passing against a stub.

import { createRequire } from "node:module";

interface Parse5 {
  parse(html: string): unknown;
}

const requireFromHere = createRequire(import.meta.url);

function loadParse5(): Parse5 {
  try {
    return requireFromHere("parse5") as Parse5;
  } catch (cause) {
    throw new Error(
      "the markdown DOM shim needs `parse5`, which no longer resolves from " +
        "packages/webui. Declare it as a devDependency of @mavis/webui, or " +
        "replace this shim.",
      { cause },
    );
  }
}

const parse5 = loadParse5();

/** parse5 node, narrowed to the fields the shim reads. */
interface Parse5Node {
  nodeName: string;
  value?: string;
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Parse5Node[];
}

/** A node in the shimmed tree: DOM Level 1 fields over a parse5 node. */
export interface ShimNode {
  nodeType: number;
  nodeName: string;
  tagName: string;
  textContent: string;
  childNodes: ShimNode[];
  parentNode: ShimNode | null;
  previousSibling: ShimNode | null;
  nextSibling: ShimNode | null;
  attributes: { name: string; value: string }[];
  classList: { contains(token: string): boolean };
}

/** Minimal `document` the walker consumes (`htmlToReact` reads `.body`). */
export interface ShimDocument {
  body: ShimNode;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function toShimNode(node: Parse5Node, parent: ShimNode | null): ShimNode {
  const isText = node.nodeName === "#text";
  const isElement = node.tagName !== undefined;

  const attributes = (node.attrs ?? []).map((attr) => ({
    name: attr.name,
    value: attr.value,
  }));

  const shim: ShimNode = {
    nodeType: isText ? TEXT_NODE : isElement ? ELEMENT_NODE : 0,
    nodeName: node.nodeName,
    tagName: node.tagName ?? "",
    textContent: isText
      ? (node.value ?? "")
      : (node.childNodes ?? []).map((child) => child.value ?? "").join(""),
    childNodes: [],
    parentNode: parent,
    previousSibling: null,
    nextSibling: null,
    attributes,
    classList: {
      contains(token: string): boolean {
        const classAttr = attributes.find((attr) => attr.name === "class");
        return (classAttr?.value ?? "").split(/\s+/).includes(token);
      },
    },
  };

  shim.childNodes = (node.childNodes ?? []).map((child) => {
    const childShim = toShimNode(child, shim);
    const previous = shim.childNodes[shim.childNodes.length - 1];
    if (previous) previous.nextSibling = childShim;
    return childShim;
  });

  return shim;
}

/** A `DOMParser` whose `parseFromString` returns the shimmed tree. */
export class ShimDomParser {
  parseFromString(html: string, _type: "text/html"): ShimDocument {
    // parse5 builds the implied <html>/<head>/<body> around the fragment,
    // so <body> is a grandchild of the document, not a child.
    const bodyNode = findBody(parse5.parse(html) as Parse5Node);
    if (!bodyNode) throw new Error("parse5 produced no <body> for the fixture");
    return { body: toShimNode(bodyNode, null) };
  }
}

function findBody(node: Parse5Node): Parse5Node | undefined {
  if (node.nodeName === "body") return node;
  for (const child of node.childNodes ?? []) {
    const found = findBody(child);
    if (found) return found;
  }
  return undefined;
}

/**
 * Run `fn` with `DOMParser` shimmed in, then restore whatever was there.
 *
 * The walker resolves the bare identifier `DOMParser`, so the global must
 * be installed before `htmlToReact` is called. It is restored on the
 * throw path too: a failing assertion must not leave a fake DOM
 * installed for the rest of the file.
 */
export function withDomParserShim<T>(fn: () => T): T {
  const globals = globalThis as { DOMParser?: unknown };
  const previous = globals.DOMParser;
  globals.DOMParser = ShimDomParser;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete globals.DOMParser;
    else globals.DOMParser = previous;
  }
}
