// webapp/test/composer-models.test.ts
//
// Unit tests for the catalogue grouping the composer ModelSelect applies
// before rendering. Pin the order-preserving behaviour the ModelSelect
// panel relies on: catalogue order is preserved within each provider,
// providers are bucketed in first-seen order, and entries without a
// provider land in a single `__other` bucket so they are still reachable.
//
// Style note: pure-function re-implementation (mirroring the grouping
// inside composer.tsx#ModelSelect). The grouping logic is small and
// stable; isolating it here means the regression lives next to the test
// instead of being a snapshot of a render-tree.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

interface CatalogueEntry {
  id: string;
  label: string;
  provider?: string;
}

/** Mirror of composer.tsx ModelSelect's grouping derivation. */
function groupModelsByProvider(
  models: CatalogueEntry[],
  otherLabel: string,
): Array<{ key: string; label: string; models: CatalogueEntry[] }> {
  const order: string[] = [];
  const buckets = new Map<string, CatalogueEntry[]>();
  for (const model of models) {
    const key = model.provider ?? "__other";
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(model);
  }
  return order.map((key) => ({
    key,
    label: key === "__other" ? otherLabel : key,
    models: buckets.get(key)!,
  }));
}

describe("groupModelsByProvider — composer ModelSelect grouping", () => {
  test("groups entries by `provider` while preserving catalogue order", () => {
    const groups = groupModelsByProvider(
      [
        { id: "minimax_api/MiniMax-M3", label: "MiniMax-M3", provider: "minimax_api" },
        { id: "openai_compat/gpt-4o", label: "GPT-4o", provider: "openai_compat" },
        { id: "minimax_api/MiniMax-M2.7", label: "MiniMax-M2.7", provider: "minimax_api" },
      ],
      "Other",
    );
    assert.equal(groups.length, 2);
    const first = groups[0];
    const second = groups[1];
    assert.ok(first && second, "groups present");
    assert.equal(first.key, "minimax_api");
    assert.deepEqual(
      first.models.map((m) => m.id),
      ["minimax_api/MiniMax-M3", "minimax_api/MiniMax-M2.7"],
      "catalogue order preserved within a provider",
    );
    assert.equal(second.key, "openai_compat");
    assert.equal(second.models.length, 1);
  });

  test("provider-less entries fall into a single `__other` bucket", () => {
    const groups = groupModelsByProvider(
      [
        { id: "m:minimax_api:MiniMax-M3:v:default", label: "M3 default" },
        { id: "minimax_api/MiniMax-M3", label: "MiniMax-M3", provider: "minimax_api" },
      ],
      "Other",
    );
    const first = groups[0];
    const second = groups[1];
    assert.ok(first && second, "both groups present");
    // `__other` comes first because it was seen first in the catalogue
    assert.equal(first.key, "__other");
    assert.equal(first.label, "Other");
    assert.equal(second.key, "minimax_api");
  });

  test("empty catalogue yields no groups", () => {
    const groups = groupModelsByProvider([], "Other");
    assert.equal(groups.length, 0);
  });

  test("all-providerless catalogue collapses to one group", () => {
    const groups = groupModelsByProvider(
      [
        { id: "m:a:b:v:x", label: "x" },
        { id: "m:a:b:v:y", label: "y" },
      ],
      "Other",
    );
    assert.equal(groups.length, 1);
    const only = groups[0];
    assert.ok(only, "single group present");
    assert.equal(only.key, "__other");
    assert.equal(only.models.length, 2);
  });
});