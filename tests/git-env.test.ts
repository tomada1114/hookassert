import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { isolatedGitEnv } from "../scripts/lib/git-env.mjs";

// The regression these cover is not a wrong return value: it is a fixture
// repository writing into the repository that spawned it. `lefthook.yml` runs
// this suite from pre-commit, and git hands every hook a GIT_DIR, so both
// directions are exercised here against two throwaway repositories rather than
// against the checkout the suite is running in.
const directories: string[] = [];

/** A fresh, empty git repository, isolated from the surrounding one. */
function makeRepo(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  directories.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir, env: isolatedGitEnv() });
  return dir;
}

/**
 * What git exports to a hook, pointed at a throwaway repository.
 *
 * The GIT_* variables are cleared before GIT_DIR is set, because this suite is
 * itself run from a hook: inheriting the real GIT_INDEX_FILE here would send
 * the unguarded control case below into the checkout it is running in.
 */
function hookEnvironment(outer: string): NodeJS.ProcessEnv {
  return { ...isolatedGitEnv(), GIT_DIR: path.join(outer, ".git") };
}

/** A repository's own config file, which a fixture's `git init`/`git config` would rewrite. */
function configOf(dir: string): string {
  return readFileSync(path.join(dir, ".git", "config"), "utf8");
}

/** The staged paths of a repository, as `git diff --cached --name-only` reports them. */
function stagedPaths(dir: string): string[] {
  const out = execFileSync("git", ["diff", "--cached", "--name-only"], {
    cwd: dir,
    encoding: "utf8",
    env: isolatedGitEnv(),
  });
  return out.split("\n").filter(Boolean);
}

afterEach(() => {
  while (directories.length > 0) {
    const dir = directories.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("isolatedGitEnv", () => {
  it("drops every GIT_ variable and keeps the rest", () => {
    const isolated = isolatedGitEnv({
      GIT_DIR: "/somewhere/.git",
      GIT_INDEX_FILE: "/somewhere/.git/index",
      GIT_CONFIG_GLOBAL: "/somewhere/.gitconfig",
      PATH: "/usr/bin",
      GITHUB_TOKEN: "kept — not a GIT_ variable",
    });

    expect(isolated).toStrictEqual({
      PATH: "/usr/bin",
      GITHUB_TOKEN: "kept — not a GIT_ variable",
    });
  });

  it("defaults to the current process environment", () => {
    const isolated = isolatedGitEnv();

    expect(Object.keys(isolated).some((key) => key.startsWith("GIT_"))).toBe(false);
    expect(isolated["PATH"]).toBe(process.env["PATH"]);
  });

  it("does not mutate the environment it copies", () => {
    const source = { GIT_DIR: "/somewhere/.git", PATH: "/usr/bin" };

    isolatedGitEnv(source);

    expect(source).toStrictEqual({ GIT_DIR: "/somewhere/.git", PATH: "/usr/bin" });
  });
});

describe("git spawned under a hook's GIT_DIR", () => {
  it("stages into the fixture repository, not the one that set GIT_DIR", () => {
    const outer = makeRepo("git-env-outer-");
    const fixture = makeRepo("git-env-fixture-");
    const hookEnv = hookEnvironment(outer);
    const outerConfig = configOf(outer);
    writeFileSync(path.join(fixture, ".env"), "TOKEN=fixture\n", "utf8");

    execFileSync("git", ["add", ".env"], {
      cwd: fixture,
      env: isolatedGitEnv(hookEnv),
    });
    execFileSync("git", ["config", "user.email", "fixture@example.com"], {
      cwd: fixture,
      env: isolatedGitEnv(hookEnv),
    });

    expect(stagedPaths(fixture)).toStrictEqual([".env"]);
    expect(stagedPaths(outer)).toStrictEqual([]);
    // `git init` and `git config` rewrite the *repository's* config, which is
    // shared by every worktree — the damage that outlives a single index.
    expect(configOf(outer)).toBe(outerConfig);
    expect(configOf(fixture)).toContain("fixture@example.com");
  });

  it("stages into the repository that set GIT_DIR when the variable is inherited", () => {
    const outer = makeRepo("git-env-outer-");
    const fixture = makeRepo("git-env-fixture-");
    const hookEnv = hookEnvironment(outer);
    writeFileSync(path.join(fixture, ".env"), "TOKEN=fixture\n", "utf8");

    // The unguarded spelling, kept as a control: without the isolation above
    // the fixture's own file lands in the *outer* repository's index. This is
    // the defect the guard exists for, reproduced where it can do no damage.
    execFileSync("git", ["add", ".env"], { cwd: fixture, env: hookEnv });

    expect(stagedPaths(outer)).toStrictEqual([".env"]);
    expect(stagedPaths(fixture)).toStrictEqual([]);
  });
});
