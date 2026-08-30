import { describe, expect, it } from "vitest";

import * as api from "../src/index.js";

// hookassert's published contract is a type vocabulary plus the `hookassert`
// command; it is deliberately not an import surface with runtime values yet.
// Types are erased at build time, so the module a consumer imports is empty —
// asserted here on purpose, so the first runtime export lands as a considered
// change to the contract rather than as a side effect of a later issue.
//
// The types themselves are checked in tests/types.test.ts, and the published
// declarations from a consumer's point of view in tests/package.test.ts.
describe("the public entry point", () => {
  it("has no enumerable function or class exports", () => {
    // Asserting the whole key list rather than filtering on `typeof value`
    // states the stronger fact: nothing runtime-visible ships yet, not even a
    // constant. Every key that appears here is a published symbol.
    expect(Object.keys(api)).toEqual([]);
  });

  it("exposes no default export", () => {
    expect(Object.hasOwn(api, "default")).toBe(false);
  });
});
