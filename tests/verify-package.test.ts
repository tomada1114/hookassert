import consoleModule from "node:console";
import path from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

import type * as NodeTools from "../scripts/lib/node-tools.mjs";

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

// scripts/verify-package.mjs's `runCheck` and `main` run publint, attw and
// the consumer smoke test as child scripts through runNode(), and resolve
// publint's entry point through resolveDependencyBin(). Mocking both at the
// scripts/lib/node-tools.mjs boundary (the `writing-tests` skill's conventions,
// following the pattern tests/check-attw.test.ts and
// tests/smoke-package.test.ts already established for this same module)
// exercises every outcome without spawning a real publint/attw/npm process.
const runNodeMock =
  vi.fn<
    (
      script: string,
      args: readonly string[],
      options?: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => RunResult
  >();
const resolveDependencyBinMock =
  vi.fn<(packageName: string, binName?: string) => string>();

vi.mock("../scripts/lib/node-tools.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeTools>();
  return {
    ...actual,
    runNode: (
      script: string,
      args: readonly string[],
      options?: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => runNodeMock(script, args, options),
    resolveDependencyBin: (packageName: string, binName?: string) =>
      resolveDependencyBinMock(packageName, binName),
  };
});

const { main, runCheck } = await import("../scripts/verify-package.mjs");

let stdoutSpy: MockInstance<typeof process.stdout.write>;
let stderrSpy: MockInstance<typeof process.stderr.write>;
let logSpy: MockInstance<typeof consoleModule.log>;
let errorSpy: MockInstance<typeof consoleModule.error>;

beforeEach(() => {
  resolveDependencyBinMock.mockReturnValue("/fake/node_modules/publint/dist/bin.js");
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  logSpy = vi.spyOn(consoleModule, "log").mockImplementation(() => undefined);
  errorSpy = vi.spyOn(consoleModule, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runCheck", () => {
  it("returns true and forwards stdout/stderr when the check exits 0", () => {
    runNodeMock.mockReturnValue({ status: 0, stdout: "all good\n", stderr: "" });

    expect(runCheck("publint", "/fake/publint.js", ["tarball.tgz"])).toBe(true);
    expect(stdoutSpy).toHaveBeenCalledWith("all good\n");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns false and reports ERR_PACKAGE_VERIFY_FAILED naming the label when the check fails", () => {
    runNodeMock.mockReturnValue({ status: 1, stdout: "", stderr: "types are wrong\n" });

    expect(runCheck("Are the Types Wrong?", "/fake/attw.js", ["tarball.tgz"])).toBe(
      false,
    );
    expect(stderrSpy).toHaveBeenCalledWith("types are wrong\n");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/ERR_PACKAGE_VERIFY_FAILED: Are the Types Wrong\?/),
    );
  });
});

describe("main", () => {
  it("returns 2 without resolving publint or running any check when the arguments are wrong", () => {
    expect(main([])).toBe(2);
    expect(resolveDependencyBinMock).not.toHaveBeenCalled();
    expect(runNodeMock).not.toHaveBeenCalled();
  });

  it("returns 2 when publint cannot be resolved", () => {
    resolveDependencyBinMock.mockImplementation(() => {
      throw new Error("ERR_DEPENDENCY_MISSING: publint is not installed.");
    });

    expect(main(["--tarball", "dist/package.tgz"])).toBe(2);
    expect(runNodeMock).not.toHaveBeenCalled();
  });

  it("runs publint, attw and the smoke test in order and returns 0 when all pass", () => {
    runNodeMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    const tarball = path.resolve("dist/package.tgz");

    expect(main(["--tarball", "dist/package.tgz"])).toBe(0);
    expect(runNodeMock).toHaveBeenCalledTimes(3);
    expect(runNodeMock.mock.calls[0]?.[1]).toEqual([tarball, "--strict"]);
    expect(runNodeMock.mock.calls[1]?.[1]).toEqual(["--tarball", tarball]);
    expect(runNodeMock.mock.calls[1]?.[0]).toContain("check-attw.mjs");
    expect(runNodeMock.mock.calls[2]?.[1]).toEqual(["--tarball", tarball]);
    expect(runNodeMock.mock.calls[2]?.[0]).toContain("smoke-package.mjs");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/package-verify: all checks passed/),
    );
  });

  it("stops at the first failing check and returns 1", () => {
    runNodeMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "bad export\n" });

    expect(main(["--tarball", "dist/package.tgz"])).toBe(1);
    expect(runNodeMock).toHaveBeenCalledTimes(1);
  });

  it("runs every check when only a later one fails", () => {
    runNodeMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "smoke failed\n" });

    expect(main(["--tarball", "dist/package.tgz"])).toBe(1);
    expect(runNodeMock).toHaveBeenCalledTimes(3);
  });
});
