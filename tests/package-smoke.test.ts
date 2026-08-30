import consoleModule from "node:console";
import process from "node:process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main, parseArguments, runCommand } from "../scripts/package-smoke.mjs";

type CommandRunner = (command: string, args: readonly string[]) => number;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("package-smoke argument handling", () => {
  it("uses the build-and-pack flow with no arguments", () => {
    expect(parseArguments([])).toEqual({});
  });

  it.each([
    ["--pack-dir", ".smoke", { packDir: ".smoke" }],
    ["--tarball", ".smoke/package.tgz", { tarball: ".smoke/package.tgz" }],
  ] as const)(
    "accepts %s for consuming an existing artifact",
    (flag, value, expected) => {
      expect(parseArguments([flag, value])).toEqual(expected);
    },
  );

  it.each([
    ["--unknown"],
    ["--pack-dir"],
    ["--tarball", "one.tgz", "--pack-dir", ".smoke"],
    ["--pack-dir", ".smoke", "--tarball", "one.tgz"],
  ] as const)("rejects invalid arguments %j", (...argv) => {
    expect(() => parseArguments(argv)).toThrow(/ERR_PACKAGE_SMOKE_ARGUMENT/);
  });

  it("ignores a -- separator", () => {
    expect(parseArguments(["--", "--pack-dir", ".smoke"])).toEqual({
      packDir: ".smoke",
    });
  });
});

describe("runCommand", () => {
  // The real subprocess boundary, not a fake — this is the one function whose
  // whole job is spawning it, so its own test is `writing-tests`' boundary
  // exception, the same way scripts/sync-labels.mjs's spawnGh is tested for
  // real rather than through the CommandRunner fakes used elsewhere here.
  it("returns the child's exit code on success", () => {
    expect(runCommand(process.execPath, ["-e", "process.exit(0)"])).toBe(0);
  });

  it("returns a non-zero exit code without throwing", () => {
    expect(runCommand(process.execPath, ["-e", "process.exit(3)"])).toBe(3);
  });

  it("throws ERR_PACKAGE_SMOKE_COMMAND when the command cannot be spawned", () => {
    expect(() => runCommand("this-binary-does-not-exist-xyz", [])).toThrow(
      /ERR_PACKAGE_SMOKE_COMMAND/,
    );
  });
});

describe("package-smoke orchestration", () => {
  it("consumes an existing pack directory without rebuilding it", () => {
    const runner = vi.fn<CommandRunner>().mockReturnValue(0);

    expect(main(["--pack-dir", ".smoke"], runner)).toBe(0);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(process.execPath, [
      "scripts/smoke-package.mjs",
      "--pack-dir",
      ".smoke",
    ]);
  });

  it("consumes an existing tarball without rebuilding it", () => {
    const runner = vi.fn<CommandRunner>().mockReturnValue(0);

    expect(main(["--tarball", ".smoke/package.tgz"], runner)).toBe(0);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(process.execPath, [
      "scripts/smoke-package.mjs",
      "--tarball",
      ".smoke/package.tgz",
    ]);
  });

  it("builds, packs, and then consumes a fresh artifact by default", () => {
    const runner = vi.fn<CommandRunner>().mockReturnValue(0);

    expect(main([], runner)).toBe(0);
    expect(runner.mock.calls).toEqual([
      ["pnpm", ["run", "build"]],
      [process.execPath, ["scripts/clean.mjs", ".smoke"]],
      ["pnpm", ["pack", "--pack-destination", ".smoke"]],
      [process.execPath, ["scripts/smoke-package.mjs", "--pack-dir", ".smoke"]],
    ]);
  });

  it("stops preparation at the first failed command", () => {
    const runner = vi.fn<CommandRunner>().mockReturnValueOnce(3);
    const errorSpy = vi
      .spyOn(consoleModule, "error")
      .mockImplementation(() => undefined);

    expect(main([], runner)).toBe(1);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("ERR_PACKAGE_SMOKE"));
  });

  it("reports an unexpected, non-PackageSmokeError failure and still returns 1", () => {
    const runner = vi.fn<CommandRunner>().mockImplementation(() => {
      throw new Error("kaboom");
    });
    const errorSpy = vi
      .spyOn(consoleModule, "error")
      .mockImplementation(() => undefined);

    expect(main([], runner)).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ERR_PACKAGE_SMOKE_UNEXPECTED"),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("kaboom"));
  });

  it("returns 2 and prints usage for invalid arguments", () => {
    const runner = vi.fn<CommandRunner>();
    const errorSpy = vi
      .spyOn(consoleModule, "error")
      .mockImplementation(() => undefined);

    expect(main(["--unknown"], runner)).toBe(2);
    expect(runner).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ERR_PACKAGE_SMOKE_ARGUMENT"),
    );
  });
});
