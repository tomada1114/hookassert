import consoleModule from "node:console";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { clean } from "../scripts/clean.mjs";

// scripts/clean.mjs imports `console` from "node:console" (AGENTS.md's
// "Repository automation" convention), which is a distinct object from the
// ambient global under Vitest, so the spy has to target the same module —
// see tests/sync-labels.test.ts for the established pattern.

const workspaces: string[] = [];

/** A throwaway "repository root" so a removal test never touches the real project directory. */
function makeRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "clean-test-"));
  workspaces.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (workspaces.length > 0) {
    const dir = workspaces.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("clean", () => {
  it("returns 2 and logs usage when no targets are given", () => {
    const errorSpy = vi
      .spyOn(consoleModule, "error")
      .mockImplementation(() => undefined);

    expect(clean([], makeRoot())).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/no targets given/));
  });

  it("removes an existing directory recursively", () => {
    const root = makeRoot();
    const target = path.join(root, "dist");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "index.js"), "export const a = 1;\n");

    expect(clean(["dist"], root)).toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it("does not error when the target does not exist (force semantics)", () => {
    const root = makeRoot();
    const target = path.join(root, "never-created");

    expect(clean(["never-created"], root)).toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it("removes every listed target", () => {
    const root = makeRoot();
    mkdirSync(path.join(root, "a"));
    mkdirSync(path.join(root, "b"));

    expect(clean(["a", "b"], root)).toBe(0);
    expect(existsSync(path.join(root, "a"))).toBe(false);
    expect(existsSync(path.join(root, "b"))).toBe(false);
  });

  it("accepts a target given as an absolute path already inside the root", () => {
    const root = makeRoot();
    const target = path.join(root, "dist");
    mkdirSync(target);

    expect(clean([target], root)).toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it.each([
    ["a parent traversal", "../outside"],
    ["an absolute path outside the root", "/etc/passwd"],
  ])("refuses %s without removing anything", (_label, target) => {
    const root = makeRoot();
    const errorSpy = vi
      .spyOn(consoleModule, "error")
      .mockImplementation(() => undefined);

    expect(clean([target], root)).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/refusing to remove a path outside the repository/),
    );
  });

  it("refuses the root itself", () => {
    const root = makeRoot();
    const errorSpy = vi
      .spyOn(consoleModule, "error")
      .mockImplementation(() => undefined);

    expect(clean(["."], root)).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/refusing to remove a path outside the repository/),
    );
  });

  it("stops at the first unsafe target and never processes the rest", () => {
    const root = makeRoot();
    const unreached = path.join(root, "unreached");
    mkdirSync(unreached);
    vi.spyOn(consoleModule, "error").mockImplementation(() => undefined);

    // "../outside" is refused before "unreached" (a legitimate target) would
    // ever be reached, proving the loop returns immediately instead of
    // continuing past an unsafe entry.
    expect(clean(["../outside", "unreached"], root)).toBe(2);
    expect(existsSync(unreached)).toBe(true);
  });

  it("defaults to this repository's own root when none is given", () => {
    const errorSpy = vi
      .spyOn(consoleModule, "error")
      .mockImplementation(() => undefined);

    // A path far outside this checkout is refused under the default root,
    // proving the parameter really does default to it rather than requiring
    // every caller — including the CLI entry point — to pass one explicitly.
    expect(clean(["../../../etc"])).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/refusing to remove a path outside the repository/),
    );
  });
});
