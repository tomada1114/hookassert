import process from "node:process";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { isMain } from "../scripts/lib/is-main.mjs";

// process.argv is the actual Node global (imported by scripts/lib/is-main.mjs
// itself via `import process from "node:process"`), so temporarily replacing
// it is the only way to exercise the "no script path at all" branch; it is
// restored in afterEach rather than left stubbed for later tests.
const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
});

describe("isMain", () => {
  it("recognizes the module Node was actually started with", () => {
    const entry = process.argv[1];
    if (entry === undefined) {
      throw new Error("the test runner should always be process.argv[1]");
    }
    expect(isMain(pathToFileURL(entry).href)).toBe(true);
  });

  it("recognizes nothing when the module is not the process entry point", () => {
    // The named module does not exist on disk, so canonicalize's realpathSync
    // fails and falls back to plain path resolution for it.
    expect(isMain(pathToFileURL("/nonexistent/hookassert/lib/is-main.mjs").href)).toBe(
      false,
    );
  });

  it("recognizes nothing when there is no script path at all", () => {
    process.argv = [process.argv[0] ?? "node"];

    expect(isMain(import.meta.url)).toBe(false);
  });
});
