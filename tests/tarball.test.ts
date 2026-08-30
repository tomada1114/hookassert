import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findSingleTarball } from "../scripts/lib/tarball.mjs";

// scripts/lib/tarball.mjs's happy path (exactly one .tgz) is already
// exercised indirectly through tests/package.test.ts's real `npm pack`
// fixture; the error paths below are only reachable with a directory
// deliberately built to violate the "exactly one tarball" contract.
const workspaces: string[] = [];

function makeWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "tarball-lib-"));
  workspaces.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of workspaces.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("findSingleTarball", () => {
  it("returns the absolute path of the one .tgz in the directory", () => {
    const dir = makeWorkspace();
    writeFileSync(path.join(dir, "package-1.0.0.tgz"), "");
    writeFileSync(path.join(dir, "readme.txt"), "not a tarball");

    expect(findSingleTarball(dir)).toBe(path.resolve(dir, "package-1.0.0.tgz"));
  });

  it("throws ERR_PACK_DIR_UNREADABLE when the directory does not exist", () => {
    const dir = path.join(tmpdir(), "tarball-lib-does-not-exist");

    expect(() => findSingleTarball(dir)).toThrow(/ERR_PACK_DIR_UNREADABLE/);
  });

  it("throws ERR_PACK_DIR_NOT_SINGLE when the directory holds no tarball", () => {
    const dir = makeWorkspace();
    writeFileSync(path.join(dir, "readme.txt"), "not a tarball");

    expect(() => findSingleTarball(dir)).toThrow(/ERR_PACK_DIR_NOT_SINGLE/);
  });

  it("throws ERR_PACK_DIR_NOT_SINGLE and names both files when more than one tarball exists", () => {
    const dir = makeWorkspace();
    writeFileSync(path.join(dir, "package-1.0.0.tgz"), "");
    writeFileSync(path.join(dir, "package-1.0.1.tgz"), "");

    expect(() => findSingleTarball(dir)).toThrow(
      /package-1\.0\.0\.tgz, package-1\.0\.1\.tgz/,
    );
  });
});
