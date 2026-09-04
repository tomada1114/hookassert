import consoleModule from "node:console";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

import type * as NodeTools from "../scripts/lib/node-tools.mjs";

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

// scripts/smoke-package.mjs's checkRuntimeImports/checkRequireInterop/
// checkDeepImportBlocked/checkTypeScriptConsumers all write a generated
// script into a throwaway consumer directory and then run it through
// runNode(). Mocking runNode at the subprocess boundary (the `writing-tests` skill's
// conventions) exercises both outcomes of each check without installing a
// real tarball or compiling a real TypeScript project for every case.
// checkTarballContents (the other half of this file) already has real-fixture
// coverage in tests/package.test.ts from #83.
const runNodeMock =
  vi.fn<
    (
      script: string,
      args: readonly string[],
      options?: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => RunResult
  >();

vi.mock("../scripts/lib/node-tools.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeTools>();
  return {
    ...actual,
    runNode: (
      script: string,
      args: readonly string[],
      options?: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => runNodeMock(script, args, options),
  };
});

const {
  checkBinCommands,
  checkCliFixtureUsage,
  checkDeepImportBlocked,
  checkRequireInterop,
  checkRuntimeImports,
  checkTypeScriptConsumers,
  compileTypeScriptConsumer,
  installConsumer,
  isUniversalProfile,
  main,
  publicBinCommands,
  publicSubpaths,
  resolveTarballArgument,
  unexportedEntryPath,
} = await import("../scripts/smoke-package.mjs");
const { repoRoot } = await import("../scripts/lib/node-tools.mjs");

const workspaces: string[] = [];

function makeConsumer(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "smoke-package-test-"));
  workspaces.push(dir);
  return dir;
}

let stdoutSpy: MockInstance<typeof process.stdout.write>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  while (workspaces.length > 0) {
    const dir = workspaces.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("checkRuntimeImports", () => {
  it("passes and reports stdout when every subpath imports cleanly", () => {
    runNodeMock.mockReturnValue({ status: 0, stdout: "  ./ -> a, b\n", stderr: "" });
    const consumer = makeConsumer();

    expect(() => checkRuntimeImports(consumer, "fixture-package", [""])).not.toThrow();
    expect(stdoutSpy).toHaveBeenCalledWith("  ./ -> a, b\n");
  });

  it("throws ERR_SMOKE_IMPORT_FAILED, naming every subpath, when an import fails", () => {
    runNodeMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "Cannot find module",
    });
    const consumer = makeConsumer();

    expect(() =>
      checkRuntimeImports(consumer, "fixture-package", ["", "/sub"]),
    ).toThrow(/ERR_SMOKE_IMPORT_FAILED[\s\S]*fixture-package, fixture-package\/sub/);
  });

  it("skips the library contract for a bin-only package", () => {
    const consumer = makeConsumer();

    expect(() =>
      checkRuntimeImports(consumer, "fixture-package", [""], false),
    ).not.toThrow();
    expect(runNodeMock).not.toHaveBeenCalled();
  });

  it("keeps the named-export contract for a package that also has a bin", () => {
    runNodeMock.mockReturnValue({ status: 0, stdout: "  library ok\n", stderr: "" });
    const consumer = makeConsumer();

    expect(() =>
      checkRuntimeImports(consumer, "fixture-package", [""], true),
    ).not.toThrow();
    expect(runNodeMock).toHaveBeenCalledTimes(1);
  });

  // An entry point that publishes types only emits an empty module, so there
  // is no runtime name for the generated script to read. That is a usable
  // package when a command ships alongside it, and an empty tarball when one
  // does not — the two cases are told apart by the packed manifest's `bin`,
  // and the assertion the generated script carries is where that shows up.
  /** The script checkRuntimeImports writes into the consumer before running it. */
  function generatedCheck(consumer: string): string {
    return readFileSync(path.join(consumer, "check-runtime.mjs"), "utf8");
  }

  it("requires a named export when the package declares no command", () => {
    runNodeMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    const consumer = makeConsumer();

    checkRuntimeImports(consumer, "fixture-package", [""], true, false);

    expect(generatedCheck(consumer)).toContain("names.length > 0 || false");
  });

  it("accepts a type-only entry point when the package declares a command", () => {
    runNodeMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    const consumer = makeConsumer();

    checkRuntimeImports(consumer, "fixture-package", [""], true, true);

    expect(generatedCheck(consumer)).toContain("names.length > 0 || true");
  });

  it("says what it expected of a type-only entry point when the import fails", () => {
    runNodeMock.mockReturnValue({ status: 1, stdout: "", stderr: "boom" });
    const consumer = makeConsumer();

    expect(() =>
      checkRuntimeImports(consumer, "fixture-package", [""], true, true),
    ).toThrow(/imports cleanly and exposes no default export/);
  });
});

describe("publicBinCommands and checkBinCommands", () => {
  it("normalizes a string bin and an unnamed object bin to command names", () => {
    expect(
      publicBinCommands({ bin: "./dist/cli.js" }, "@scope/fixture-package"),
    ).toEqual(["fixture-package"]);
    expect(
      publicBinCommands(
        { bin: { "": "./dist/cli.js", other: "./dist/other.js" } },
        "fixture-package",
      ),
    ).toEqual(["fixture-package", "other"]);
  });

  it("runs every installed bin command with --help and reports stdout", () => {
    runNodeMock.mockReturnValue({ status: 0, stdout: "Usage: fixture\n", stderr: "" });
    const consumer = makeConsumer();
    const binDirectory = path.join(consumer, "node_modules", ".bin");
    mkdirSync(binDirectory, { recursive: true });
    writeFileSync(path.join(binDirectory, "fixture-package"), "#!/usr/bin/env node\n");
    writeFileSync(path.join(binDirectory, "other"), "#!/usr/bin/env node\n");

    expect(() =>
      checkBinCommands(consumer, "fixture-package", {
        bin: { "": "./dist/cli.js", other: "./dist/other.js" },
      }),
    ).not.toThrow();
    expect(runNodeMock).toHaveBeenCalledTimes(2);
    expect(runNodeMock).toHaveBeenNthCalledWith(
      1,
      path.join(binDirectory, "fixture-package"),
      ["--help"],
      expect.objectContaining({ cwd: consumer }),
    );
    expect(stdoutSpy).toHaveBeenCalledWith("Usage: fixture\n");
  });

  it("reports a missing installed bin with its own smoke error", () => {
    const consumer = makeConsumer();

    expect(() =>
      checkBinCommands(consumer, "fixture-package", {
        bin: { "": "./dist/cli.js" },
      }),
    ).toThrow(/ERR_SMOKE_BIN_MISSING/);
  });

  it("reports a bin that exits unsuccessfully or prints no help", () => {
    runNodeMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    const consumer = makeConsumer();
    const binDirectory = path.join(consumer, "node_modules", ".bin");
    mkdirSync(binDirectory, { recursive: true });
    writeFileSync(path.join(binDirectory, "fixture-package"), "#!/usr/bin/env node\n");

    expect(() =>
      checkBinCommands(consumer, "fixture-package", {
        bin: { "": "./dist/cli.js" },
      }),
    ).toThrow(/ERR_SMOKE_BIN_FAILED/);
  });

  it("does nothing, and spawns nothing, when the manifest declares no bin", () => {
    const consumer = makeConsumer();

    expect(() => checkBinCommands(consumer, "fixture-package", {})).not.toThrow();
    expect(runNodeMock).not.toHaveBeenCalled();
  });

  it("throws ERR_SMOKE_BIN_INVALID when bin is an object with no usable command names", () => {
    const consumer = makeConsumer();

    expect(() => checkBinCommands(consumer, "fixture-package", { bin: {} })).toThrow(
      /ERR_SMOKE_BIN_INVALID/,
    );
    expect(runNodeMock).not.toHaveBeenCalled();
  });

  it("throws ERR_SMOKE_BIN_INVALID for a command name that is a path segment", () => {
    const consumer = makeConsumer();

    expect(() =>
      checkBinCommands(consumer, "fixture-package", { bin: { ".": "./dist/cli.js" } }),
    ).toThrow(/ERR_SMOKE_BIN_INVALID/);
    expect(runNodeMock).not.toHaveBeenCalled();
  });
});

describe("checkCliFixtureUsage", () => {
  it("skips, without spawning anything, when the manifest declares no hookassert bin", () => {
    const consumer = makeConsumer();

    expect(() =>
      checkCliFixtureUsage(consumer, "fixture-package", { bin: { other: "./x.js" } }),
    ).not.toThrow();
    expect(runNodeMock).not.toHaveBeenCalled();
  });

  const explainJsonWithFiring = JSON.stringify({
    firing: [{ command: "echo hookassert-smoke-ok" }],
    rejected: [],
  });

  it("writes a one-hook fixture and runs explain then lint against it, isolated from the real HOME", () => {
    runNodeMock.mockReturnValue({
      status: 0,
      stdout: explainJsonWithFiring,
      stderr: "",
    });
    const consumer = makeConsumer();

    checkCliFixtureUsage(consumer, "hookassert", {
      bin: { hookassert: "./dist/cli.js" },
    });

    const projectDir = path.join(consumer, "fixture-project");
    const settingsPath = path.join(projectDir, "settings.json");
    expect(JSON.parse(readFileSync(settingsPath, "utf8")) as unknown).toMatchObject({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "echo hookassert-smoke-ok" }],
          },
        ],
      },
    });

    const scratchHome = path.join(consumer, "smoke-home");
    const executable = path.join(consumer, "node_modules", ".bin", "hookassert");
    expect(runNodeMock).toHaveBeenNthCalledWith(
      1,
      executable,
      ["explain", "PreToolUse", "Bash", "--settings", settingsPath, "--format", "json"],
      expect.objectContaining({
        cwd: projectDir,
        env: expect.objectContaining({
          HOME: scratchHome,
          USERPROFILE: scratchHome,
        }) as unknown,
      }),
    );
    expect(runNodeMock).toHaveBeenNthCalledWith(
      2,
      executable,
      ["lint", "--settings", settingsPath],
      expect.objectContaining({
        cwd: projectDir,
        env: expect.objectContaining({
          HOME: scratchHome,
          USERPROFILE: scratchHome,
        }) as unknown,
      }),
    );
  });

  it("throws ERR_SMOKE_CLI_EXPLAIN_FAILED when explain fails", () => {
    runNodeMock.mockReturnValue({ status: 1, stdout: "", stderr: "boom" });
    const consumer = makeConsumer();

    expect(() =>
      checkCliFixtureUsage(consumer, "hookassert", {
        bin: { hookassert: "./dist/cli.js" },
      }),
    ).toThrow(/ERR_SMOKE_CLI_EXPLAIN_FAILED/);
    expect(runNodeMock).toHaveBeenCalledTimes(1);
  });

  it("throws ERR_SMOKE_CLI_EXPLAIN_FAILED when explain exits 0 but the fixture hook is not firing", () => {
    runNodeMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        firing: [],
        rejected: [
          { hook: { command: "echo hookassert-smoke-ok" }, reason: "did not match" },
        ],
      }),
      stderr: "",
    });
    const consumer = makeConsumer();

    expect(() =>
      checkCliFixtureUsage(consumer, "hookassert", {
        bin: { hookassert: "./dist/cli.js" },
      }),
    ).toThrow(/ERR_SMOKE_CLI_EXPLAIN_FAILED/);
    expect(runNodeMock).toHaveBeenCalledTimes(1);
  });

  it("throws ERR_SMOKE_CLI_LINT_FAILED when lint fails against the clean fixture", () => {
    runNodeMock.mockImplementation((_script, args) =>
      args[0] === "lint"
        ? { status: 1, stdout: "", stderr: "boom" }
        : { status: 0, stdout: explainJsonWithFiring, stderr: "" },
    );
    const consumer = makeConsumer();

    expect(() =>
      checkCliFixtureUsage(consumer, "hookassert", {
        bin: { hookassert: "./dist/cli.js" },
      }),
    ).toThrow(/ERR_SMOKE_CLI_LINT_FAILED/);
    expect(runNodeMock).toHaveBeenCalledTimes(2);
  });
});

describe("checkRequireInterop", () => {
  it("passes when require() resolves the package and its package.json subpath", () => {
    runNodeMock.mockReturnValue({ status: 0, stdout: "  ok\n", stderr: "" });
    const consumer = makeConsumer();

    expect(() => checkRequireInterop(consumer, "fixture-package")).not.toThrow();
    expect(stdoutSpy).toHaveBeenCalledWith("  ok\n");
  });

  it("throws ERR_SMOKE_REQUIRE_FAILED when require() cannot resolve the package", () => {
    runNodeMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "ERR_PACKAGE_PATH_NOT_EXPORTED",
    });
    const consumer = makeConsumer();

    expect(() => checkRequireInterop(consumer, "fixture-package")).toThrow(
      /ERR_SMOKE_REQUIRE_FAILED/,
    );
  });

  it.each([
    ["requires a named export with no command", false],
    ["accepts a type-only namespace beside a command", true],
  ])("%s", (_label, hasCommand) => {
    runNodeMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    const consumer = makeConsumer();

    checkRequireInterop(consumer, "fixture-package", hasCommand);

    expect(readFileSync(path.join(consumer, "check-require.cjs"), "utf8")).toContain(
      `.length > 0 || ${String(hasCommand)}`,
    );
  });
});

describe("unexportedEntryPath", () => {
  it("returns the file behind the root export, which is not itself a subpath", () => {
    expect(
      unexportedEntryPath({
        exports: {
          ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
          "./package.json": "./package.json",
        },
      }),
    ).toBe("dist/index.js");
  });

  it("skips a packed file that the manifest also exports by that exact path", () => {
    // Such a path is public, so probing it would assert the opposite of the
    // contract.
    expect(
      unexportedEntryPath({
        exports: {
          ".": "./dist/index.js",
          "./dist/index.js": "./dist/index.js",
        },
        bin: { tool: "./dist/cli.js" },
      }),
    ).toBe("dist/cli.js");
  });

  it("returns undefined when the manifest points at no packed .js file", () => {
    expect(unexportedEntryPath({ types: "./dist/index.d.ts" })).toBeUndefined();
  });
});

describe("checkDeepImportBlocked", () => {
  it("passes when the deep import is correctly refused", () => {
    runNodeMock.mockReturnValue({ status: 0, stdout: "  refused\n", stderr: "" });
    const consumer = makeConsumer();

    expect(() =>
      checkDeepImportBlocked(consumer, "fixture-package", "dist/index.js"),
    ).not.toThrow();
  });

  it("throws ERR_SMOKE_DEEP_IMPORT_ALLOWED when the packed file is reachable", () => {
    runNodeMock.mockReturnValue({ status: 1, stdout: "", stderr: "AssertionError" });
    const consumer = makeConsumer();

    expect(() =>
      checkDeepImportBlocked(consumer, "fixture-package", "dist/index.js"),
    ).toThrow(/ERR_SMOKE_DEEP_IMPORT_ALLOWED/);
  });

  it("skips the check, without spawning anything, when there is no path to probe", () => {
    const consumer = makeConsumer();

    expect(() =>
      checkDeepImportBlocked(consumer, "fixture-package", undefined),
    ).not.toThrow();
    expect(runNodeMock).not.toHaveBeenCalled();
  });
});

describe("compileTypeScriptConsumer", () => {
  it("returns the tsc --listFiles output on success", () => {
    runNodeMock.mockReturnValue({ status: 0, stdout: "/some/file.d.ts\n", stderr: "" });
    const consumer = makeConsumer();

    expect(compileTypeScriptConsumer(consumer, "fixture-package", "NodeNext")).toBe(
      "/some/file.d.ts\n",
    );
    expect(runNodeMock).toHaveBeenCalledWith(
      expect.stringContaining("typescript"),
      ["-p", "tsconfig.json", "--listFiles"],
      expect.objectContaining({ cwd: path.join(consumer, "ts-nodenext") }),
    );
  });

  it("throws ERR_SMOKE_CONSUMER_TSC_FAILED when the consumer does not compile", () => {
    runNodeMock.mockReturnValue({ status: 2, stdout: "", stderr: "error TS2307" });
    const consumer = makeConsumer();

    expect(() =>
      compileTypeScriptConsumer(consumer, "fixture-package", "NodeNext"),
    ).toThrow(/ERR_SMOKE_CONSUMER_TSC_FAILED/);
  });
});

describe("isUniversalProfile", () => {
  it("reflects this repository's own node-library profile", () => {
    // tsconfig.build.json sets compilerOptions.types to ["node"], not the
    // empty array that signals the universal-library profile, so this
    // repository is Node profile — which is what the checkTypeScriptConsumers
    // tests below rely on to skip the Bundler-resolution consumer.
    expect(isUniversalProfile()).toBe(false);
  });
});

describe("checkTypeScriptConsumers", () => {
  it("compiles only the NodeNext consumer for a Node profile and passes when nothing leaks", () => {
    runNodeMock.mockReturnValue({
      status: 0,
      stdout: [
        path.join(repoRoot, "node_modules", "fixture-package", "dist", "index.d.ts"),
        path.join(repoRoot, "node_modules", "typescript", "lib", "lib.es2023.d.ts"),
      ].join("\n"),
      stderr: "",
    });
    const consumer = makeConsumer();

    expect(() => checkTypeScriptConsumers(consumer, "fixture-package")).not.toThrow();
    // Node profile: only the NodeNext consumer compiles, never Bundler.
    expect(runNodeMock).toHaveBeenCalledTimes(1);
  });

  it("throws ERR_SMOKE_CONSUMER_READ_REPOSITORY when the compiler read this repository's src/", () => {
    runNodeMock.mockReturnValue({
      status: 0,
      stdout: [
        path.join(repoRoot, "src", "index.ts"),
        path.join(repoRoot, "node_modules", "fixture-package", "dist", "index.d.ts"),
      ].join("\n"),
      stderr: "",
    });
    const consumer = makeConsumer();

    expect(() => checkTypeScriptConsumers(consumer, "fixture-package")).toThrow(
      /ERR_SMOKE_CONSUMER_READ_REPOSITORY/,
    );
  });

  it("throws ERR_SMOKE_CONSUMER_READ_REPOSITORY when the compiler read this repository's dist/", () => {
    runNodeMock.mockReturnValue({
      status: 0,
      stdout: path.join(repoRoot, "dist", "index.js"),
      stderr: "",
    });
    const consumer = makeConsumer();

    expect(() => checkTypeScriptConsumers(consumer, "fixture-package")).toThrow(
      /ERR_SMOKE_CONSUMER_READ_REPOSITORY/,
    );
  });

  it("propagates ERR_SMOKE_CONSUMER_TSC_FAILED when the NodeNext consumer fails to compile", () => {
    runNodeMock.mockReturnValue({ status: 2, stdout: "", stderr: "error TS2307" });
    const consumer = makeConsumer();

    expect(() => checkTypeScriptConsumers(consumer, "fixture-package")).toThrow(
      /ERR_SMOKE_CONSUMER_TSC_FAILED/,
    );
  });
});

describe("publicSubpaths", () => {
  it("returns the root only when the manifest declares no exports field", () => {
    expect(publicSubpaths({ name: "fixture-package" })).toEqual([""]);
  });

  it("returns the root only when exports is not an object", () => {
    expect(publicSubpaths({ exports: "./index.js" })).toEqual([""]);
  });

  it("returns the root only for a conditions-only exports map with no '.' key", () => {
    expect(publicSubpaths({ exports: { import: "./index.js" } })).toEqual([""]);
  });

  it("maps '.' to the empty string and sorts additional subpaths", () => {
    expect(
      publicSubpaths({
        exports: {
          "./sub": "./dist/sub.js",
          ".": "./dist/index.js",
          "./a": "./dist/a.js",
        },
      }),
    ).toEqual(["", "/a", "/sub"]);
  });

  it("excludes a wildcard pattern and a .json subpath", () => {
    expect(
      publicSubpaths({
        exports: {
          ".": "./dist/index.js",
          "./*": "./dist/*.js",
          "./package.json": "./package.json",
        },
      }),
    ).toEqual([""]);
  });
});

describe("resolveTarballArgument", () => {
  it("accepts an explicit tarball", () => {
    expect(resolveTarballArgument(["--tarball", "dist/package.tgz"])).toBe(
      "dist/package.tgz",
    );
  });

  it("resolves the single tarball in a pack directory", () => {
    const packDir = makeConsumer();
    writeFileSync(path.join(packDir, "fixture-1.0.0.tgz"), "");

    expect(resolveTarballArgument(["--pack-dir", packDir])).toBe(
      path.join(packDir, "fixture-1.0.0.tgz"),
    );
  });

  it.each([
    { args: [], reason: "neither flag given" },
    {
      args: ["--tarball", "one.tgz", "--pack-dir", "pack"],
      reason: "both flags given",
    },
  ])("rejects when $reason", ({ args }) => {
    expect(() => resolveTarballArgument(args)).toThrow(
      /Pass exactly one of --pack-dir or --tarball/,
    );
  });

  it.each([
    { args: ["--tarball"], reason: "a missing value" },
    { args: ["--tarball", "--pack-dir"], reason: "a flag-shaped value" },
  ])("rejects --tarball with $reason", ({ args }) => {
    expect(() => resolveTarballArgument(args)).toThrow(/requires a value/);
  });

  it("rejects an argument that is neither --pack-dir nor --tarball", () => {
    expect(() => resolveTarballArgument(["--help"])).toThrow(
      /Unknown argument: --help/,
    );
  });
});

describe("installConsumer", () => {
  it("writes a consumer manifest and installs the tarball, returning the consumer directory", () => {
    runNodeMock.mockReturnValue({
      status: 0,
      stdout: "added 0 packages\n",
      stderr: "",
    });
    const workspace = makeConsumer();

    const consumer = installConsumer(workspace, "/pack/fixture-package-1.0.0.tgz");

    expect(consumer).toBe(path.join(workspace, "consumer"));
    expect(
      JSON.parse(readFileSync(path.join(consumer, "package.json"), "utf8")) as unknown,
    ).toMatchObject({ name: "smoke-consumer", type: "module" });
    expect(runNodeMock).toHaveBeenCalledWith(
      expect.stringContaining("npm"),
      expect.arrayContaining([
        "install",
        "/pack/fixture-package-1.0.0.tgz",
        "--ignore-scripts",
        "--legacy-peer-deps",
      ]),
      expect.objectContaining({ cwd: consumer }),
    );
  });

  it("throws ERR_SMOKE_INSTALL_FAILED when npm install fails", () => {
    runNodeMock.mockReturnValue({ status: 1, stdout: "", stderr: "network error" });
    const workspace = makeConsumer();

    expect(() => installConsumer(workspace, "/pack/fixture-package-1.0.0.tgz")).toThrow(
      /ERR_SMOKE_INSTALL_FAILED/,
    );
  });
});

// --- main ---------------------------------------------------------------------
//
// main() reads its own repository's package.json for the name of the package
// under test, then packs/installs/checks a tarball named on the command
// line. Building a small, synthetic gzip tarball here (rather than a real
// `npm pack`) keeps checkTarballContents' real, unmocked checks fast; the
// install and every subsequent check still go through runNode, mocked at the
// subprocess boundary exactly as the rest of this file does.

/** Build one 512-byte ustar header block with a valid checksum. */
function tarHeader(name: string, size: number): Buffer {
  const block = Buffer.alloc(512);
  const octal = (value: number, width: number): string =>
    `${value.toString(8).padStart(width - 1, "0")}\0`;

  block.write(name, 0, 100, "utf8");
  block.write(octal(0o644, 8), 100, 8, "ascii");
  block.write(octal(0, 8), 108, 8, "ascii");
  block.write(octal(0, 8), 116, 8, "ascii");
  block.write(octal(size, 12), 124, 12, "ascii");
  block.write(octal(0, 12), 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii");
  block.write("0", 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");

  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

/** Pad entry data out to the next 512-byte boundary. */
function tarBody(data: Buffer): Buffer {
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return padded;
}

/** Header plus padded body for one regular file, `package/`-prefixed as npm packs. */
function tarFile(name: string, contents: string): Buffer[] {
  const data = Buffer.from(contents, "utf8");
  return [tarHeader(`package/${name}`, data.length), tarBody(data)];
}

/** Write a minimal, valid gzip tarball satisfying checkTarballContents. */
function writeFixtureTarball(destination: string, manifest: unknown): void {
  const blocks = [
    ...tarFile("package.json", JSON.stringify(manifest)),
    ...tarFile("README.md", "# fixture\n"),
    ...tarFile("LICENSE", "MIT\n"),
    ...tarFile("dist/index.js", "export const a = 1;\n"),
    ...tarFile("dist/index.d.ts", "export declare const a: 1;\n"),
  ];
  writeFileSync(destination, gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])));
}

describe("main", () => {
  let workspace: string;
  let errorSpy: MockInstance<typeof consoleModule.error>;

  beforeEach(() => {
    workspace = makeConsumer();
    errorSpy = vi.spyOn(consoleModule, "error").mockImplementation(() => undefined);
  });

  it("returns 2 without touching runNode when the arguments are wrong", () => {
    expect(main([])).toBe(2);
    expect(runNodeMock).not.toHaveBeenCalled();
  });

  it("returns 1 and reports ERR_SMOKE_UNEXPECTED when the tarball cannot be read", () => {
    const missing = path.join(workspace, "never-packed.tgz");

    expect(main(["--tarball", missing])).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ERR_SMOKE_UNEXPECTED"),
    );
    expect(runNodeMock).not.toHaveBeenCalled();
  });

  it("returns 1 and reports ERR_SMOKE_TARBALL_CONTENTS without ever installing a missing-LICENSE tarball", () => {
    const tarball = path.join(workspace, "no-license.tgz");
    writeFileSync(
      tarball,
      gzipSync(
        Buffer.concat([
          ...tarFile("package.json", JSON.stringify({ name: "fixture" })),
          ...tarFile("README.md", "# fixture\n"),
          ...tarFile("dist/index.js", "export const a = 1;\n"),
          Buffer.alloc(1024),
        ]),
      ),
    );

    expect(main(["--tarball", tarball])).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ERR_SMOKE_TARBALL_CONTENTS"),
    );
    expect(runNodeMock).not.toHaveBeenCalled();
  });

  it("installs, checks and returns 0 for a well-formed tarball", () => {
    const packageName = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { name?: string };
    const name = packageName.name;
    if (name === undefined) {
      throw new Error("this repository's own package.json has no name");
    }

    const tarball = path.join(workspace, "fixture-package-1.0.0.tgz");
    const runtimeDependency = "smoke-runtime-helper";
    writeFixtureTarball(tarball, {
      name: "smoke-fixture-package",
      version: "1.0.0",
      dependencies: { [runtimeDependency]: "1.0.0" },
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
    });

    let installArgs: readonly string[] = [];

    // Simulate npm install's package and runtime-dependency side effects since
    // runNode never actually runs npm; every other check just needs to see exit
    // 0. The nested location mirrors --install-strategy=nested, which is what
    // makes this a dependency resolved for the installed package rather than an
    // undeclared top-level one.
    runNodeMock.mockImplementation((_script, args, options) => {
      if (args[0] === "install" && options?.cwd !== undefined) {
        installArgs = args;
        const installed = path.join(options.cwd, "node_modules", name);
        mkdirSync(installed, { recursive: true });
        writeFileSync(
          path.join(installed, "package.json"),
          JSON.stringify({
            name,
            version: "0.0.0",
            dependencies: { [runtimeDependency]: "1.0.0" },
            exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
          }),
        );
        const dependency = path.join(installed, "node_modules", runtimeDependency);
        mkdirSync(dependency, { recursive: true });
        writeFileSync(
          path.join(dependency, "package.json"),
          JSON.stringify({ name: runtimeDependency, version: "1.0.0" }),
        );
      }
      return { status: 0, stdout: "  ok\n", stderr: "" };
    });

    const exitCode = main(["--tarball", tarball]);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
    // Asserting the file the mock itself just wrote would only test the mock.
    // What this case can actually protect is the production argv: the nested
    // layout is the reason a declared runtime dependency has to resolve under
    // the installed package instead of being hoisted next to it, so dropping
    // the flag must fail here rather than quietly weakening the smoke test.
    expect(installArgs).toContain("--install-strategy=nested");
    // install + runtime imports + require interop + one TypeScript consumer
    // (this repository is the node-library profile, so no Bundler consumer)
    // + the deep-import check.
    expect(runNodeMock).toHaveBeenCalledTimes(5);
  });
});
