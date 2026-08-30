import consoleModule from "node:console";
import process from "node:process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main, parseArguments } from "../scripts/package-smoke.mjs";

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
  ] as const)("rejects invalid arguments %j", (...argv) => {
    expect(() => parseArguments(argv)).toThrow(/ERR_PACKAGE_SMOKE_ARGUMENT/);
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
