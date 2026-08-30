import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as NodeTools from "../scripts/lib/node-tools.mjs";

// scripts/check-attw.mjs's `main` runs a real `attw` process through
// runNode(). Mocking runNode at the subprocess boundary (the `writing-tests` skill's
// conventions) lets both outcomes be exercised deterministically, without
// depending on attw's own output format or spawning a real packing step for
// every case.
const runNodeMock =
  vi.fn<
    (
      script: string,
      args: readonly string[],
      options?: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => { status: number; stdout: string; stderr: string }
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

const { main, resolveTarball } = await import("../scripts/check-attw.mjs");

describe("resolveTarball", () => {
  it("returns the given tarball path", () => {
    expect(resolveTarball(["--tarball", "dist/package.tgz"])).toBe("dist/package.tgz");
  });

  it("finds the single tarball in a pack directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "check-attw-test-"));
    try {
      writeFileSync(path.join(dir, "package-1.0.0.tgz"), "");
      expect(resolveTarball(["--pack-dir", dir])).toBe(
        path.join(dir, "package-1.0.0.tgz"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { args: [], label: "neither flag" },
    { args: ["--tarball", "one.tgz", "--pack-dir", "pack"], label: "both flags" },
    { args: ["--tarball"], label: "a flag with no value" },
    { args: ["--tarball", "--pack-dir"], label: "a value that looks like a flag" },
    { args: ["--unknown", "one.tgz"], label: "an unknown flag" },
  ])("rejects $label", ({ args }) => {
    expect(() => resolveTarball(args)).toThrow();
  });
});

describe("main", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "check-attw-main-test-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("returns 2 without running attw when the arguments are wrong", () => {
    expect(main([])).toBe(2);
    expect(runNodeMock).not.toHaveBeenCalled();
  });

  it("returns 0 when attw exits 0", () => {
    runNodeMock.mockReturnValue({ status: 0, stdout: "attw: all good\n", stderr: "" });
    const tarball = path.join(workspace, "package.tgz");
    writeFileSync(tarball, "");

    expect(main(["--tarball", tarball])).toBe(0);
    expect(runNodeMock).toHaveBeenCalledWith(
      expect.stringContaining("arethetypeswrong"),
      [tarball, "--profile", "esm-only"],
      expect.objectContaining({ cwd: expect.any(String) as unknown as string }),
    );
  });

  it("returns 1 and reports the failure when attw exits non-zero", () => {
    runNodeMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "attw: types are wrong\n",
    });
    const tarball = path.join(workspace, "package.tgz");
    writeFileSync(tarball, "");

    expect(main(["--tarball", tarball])).toBe(1);
  });

  it("resolves --pack-dir to the single tarball inside it", () => {
    runNodeMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    const packDir = path.join(workspace, "pack");
    mkdirSync(packDir);
    const tarball = path.join(packDir, "package-2.0.0.tgz");
    writeFileSync(tarball, "");

    expect(main(["--pack-dir", packDir])).toBe(0);
    expect(runNodeMock).toHaveBeenCalledWith(
      expect.any(String),
      [tarball, "--profile", "esm-only"],
      expect.anything(),
    );
  });
});
