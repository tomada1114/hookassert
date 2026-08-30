import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import {
  npmCliPath,
  repoRoot,
  resolveDependencyBin,
  runNode,
} from "../scripts/lib/node-tools.mjs";

// scripts/lib/node-tools.mjs is AGENTS.md's own worked example for the
// ERR_DEPENDENCY_MISSING error-message convention, so its error paths are
// exercised directly here rather than only incidentally through the scripts
// that call it. Real installed dependencies (typescript, prettier, publint)
// stand in for fixtures instead of mocking node:fs — the `writing-tests` skill's
// conventions prefer a real fake to a mock beyond a one-shot call, and these
// three between them cover every bin shape resolveDependencyBin has to read
// (a string bin, an object bin keyed by an explicit name, and an object bin
// that falls back to the package's own name).
const workspaces: string[] = [];

function makeWorkspace(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  workspaces.push(dir);
  return dir;
}

function writeScript(workspace: string, name: string, source: string): string {
  const file = path.join(workspace, name);
  writeFileSync(file, source);
  return file;
}

afterEach(() => {
  while (workspaces.length > 0) {
    const dir = workspaces.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("repoRoot", () => {
  it("points at the repository root", () => {
    expect(existsSync(path.join(repoRoot, "package.json"))).toBe(true);
  });
});

describe("runNode", () => {
  it("captures stdout and exit code 0 on success", () => {
    const workspace = makeWorkspace("run-node-ok-");
    const script = writeScript(
      workspace,
      "ok.mjs",
      'console.log("hello from child");\n',
    );

    const result = runNode(script, []);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("hello from child");
    expect(result.stderr).toBe("");
  });

  it("passes arguments through to the child", () => {
    const workspace = makeWorkspace("run-node-args-");
    const script = writeScript(
      workspace,
      "echo-args.mjs",
      "console.log(process.argv.slice(2).join(','));\n",
    );

    const result = runNode(script, ["a", "b c"]);

    expect(result.stdout.trim()).toBe("a,b c");
  });

  it("captures a non-zero exit code and stderr", () => {
    const workspace = makeWorkspace("run-node-fail-");
    const script = writeScript(
      workspace,
      "fail.mjs",
      'console.error("boom");\nprocess.exitCode = 7;\n',
    );

    const result = runNode(script, []);

    expect(result.status).toBe(7);
    expect(result.stderr).toContain("boom");
  });

  it("reports a spawn failure instead of throwing, on an unusable cwd", () => {
    const workspace = makeWorkspace("run-node-cwd-");
    const script = writeScript(workspace, "ok.mjs", "console.log(1);\n");
    const missingCwd = path.join(workspace, "does-not-exist");

    const result = runNode(script, [], { cwd: missingCwd });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ENOENT");
  });

  it("runs with an explicitly given environment", () => {
    const workspace = makeWorkspace("run-node-env-");
    const script = writeScript(
      workspace,
      "env.mjs",
      'console.log(process.env.NODE_TOOLS_TEST_MARKER ?? "<unset>");\n',
    );

    const result = runNode(script, [], {
      env: { ...process.env, NODE_TOOLS_TEST_MARKER: "present" },
    });

    expect(result.stdout.trim()).toBe("present");
  });

  it("defaults cwd to the repository root", () => {
    const workspace = makeWorkspace("run-node-defcwd-");
    const script = writeScript(workspace, "cwd.mjs", "console.log(process.cwd());\n");

    const result = runNode(script, []);

    expect(result.stdout.trim()).toBe(repoRoot);
  });
});

describe("npmCliPath", () => {
  it("finds the npm CLI shipped next to this Node installation", () => {
    const found = npmCliPath();

    expect(found.endsWith("npm-cli.js")).toBe(true);
    expect(existsSync(found)).toBe(true);
  });
});

describe("resolveDependencyBin", () => {
  it("throws ERR_DEPENDENCY_MISSING for a package that is not installed", () => {
    expect(() =>
      resolveDependencyBin("this-package-does-not-exist-in-node-modules"),
    ).toThrow(/ERR_DEPENDENCY_MISSING/);
  });

  it("names the missing package and the next safe command", () => {
    expect(() => resolveDependencyBin("also-not-installed")).toThrow(
      /also-not-installed[\s\S]*pnpm install --frozen-lockfile/,
    );
  });

  it("resolves a string bin field directly, ignoring binName", () => {
    // prettier declares "bin": "./bin/prettier.cjs" — a string, not an object.
    expect(resolveDependencyBin("prettier", "anything")).toBe(
      path.join(repoRoot, "node_modules", "prettier", "bin", "prettier.cjs"),
    );
  });

  it("resolves an object bin field by the requested binName", () => {
    // typescript declares two named bins: tsc and tsserver.
    expect(resolveDependencyBin("typescript", "tsc")).toBe(
      path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
    );
  });

  it("falls back to the package's own name when binName is omitted", () => {
    // publint's only bin entry is keyed by its own package name.
    expect(resolveDependencyBin("publint")).toBe(
      path.join(repoRoot, "node_modules", "publint", "src", "cli.js"),
    );
  });

  it("throws ERR_DEPENDENCY_BIN_MISSING when the requested bin is absent", () => {
    expect(() => resolveDependencyBin("typescript", "does-not-exist")).toThrow(
      /ERR_DEPENDENCY_BIN_MISSING/,
    );
  });
});
