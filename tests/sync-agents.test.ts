import consoleModule from "node:console";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MIRROR_DIRECTORY,
  SOURCE_DIRECTORY,
  SyncAgentsError,
  assertSourceDirectory,
  diffTrees,
  formatDrift,
  listFiles,
  main,
  syncTrees,
} from "../scripts/sync-agents.mjs";

// `.agents/skills/` is where the skills are authored; `.claude/skills/` is a
// committed, generated copy of it, because Claude Code discovers project
// skills only from its own directory. The first case below is the gate that
// keeps the committed pair identical: it runs from `pnpm test`, so
// `check:quick`, `check:source` and CI all enforce it. The rest exercise the
// diff itself against temp trees.
//
// The script's API is called directly rather than through a subprocess: an
// exit status cannot tell a detected drift apart from a run that never
// started (see tests/tooling-ignores.test.ts for where that bit us).
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaces: string[] = [];

function makeWorkspace(prefix: string): string {
  const workspace = mkdtempSync(path.join(tmpdir(), `${prefix}-`));
  workspaces.push(workspace);
  return workspace;
}

function makeTrees(): { source: string; mirror: string } {
  const workspace = makeWorkspace("sync-agents-test");
  const source = path.join(workspace, "source");
  const mirror = path.join(workspace, "mirror");
  mkdirSync(path.join(source, "skill", "scripts"), { recursive: true });
  writeFileSync(path.join(source, "skill", "SKILL.md"), "# Skill\n");
  writeFileSync(path.join(source, "skill", "scripts", "run.mjs"), "export {};\n");
  syncTrees(source, mirror);
  return { source, mirror };
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

describe("the committed skill trees", () => {
  it("keeps the generated mirror byte-identical to its source", () => {
    expect(
      diffTrees(
        path.join(repoRoot, SOURCE_DIRECTORY),
        path.join(repoRoot, MIRROR_DIRECTORY),
      ),
      "run `pnpm agents:sync` and commit the result",
    ).toEqual([]);
  });
});

describe("diffTrees", () => {
  it("reports nothing for two identical trees", () => {
    const { source, mirror } = makeTrees();
    expect(diffTrees(source, mirror)).toEqual([]);
  });

  it("reports a file the mirror never received as missing", () => {
    const { source, mirror } = makeTrees();
    writeFileSync(path.join(source, "skill", "NOTES.md"), "notes\n");

    expect(diffTrees(source, mirror)).toEqual([
      { kind: "missing", relative: "skill/NOTES.md" },
    ]);
  });

  it("reports a file only the mirror has as extra", () => {
    const { source, mirror } = makeTrees();
    writeFileSync(path.join(mirror, "skill", "stale.md"), "stale\n");

    expect(diffTrees(source, mirror)).toEqual([
      { kind: "extra", relative: "skill/stale.md" },
    ]);
  });

  it("reports a hand-edited mirror file as differing", () => {
    const { source, mirror } = makeTrees();
    writeFileSync(path.join(mirror, "skill", "SKILL.md"), "# Skill (edited)\n");

    expect(diffTrees(source, mirror)).toEqual([
      { kind: "differs", relative: "skill/SKILL.md" },
    ]);
  });

  it("treats an absent mirror as missing every source file", () => {
    const { source } = makeTrees();

    expect(diffTrees(source, path.join(source, "..", "never-created"))).toEqual([
      { kind: "missing", relative: "skill/SKILL.md" },
      { kind: "missing", relative: "skill/scripts/run.mjs" },
    ]);
  });

  it("refuses a symlink instead of mirroring something a clone cannot restore", () => {
    const { source, mirror } = makeTrees();
    symlinkSync("SKILL.md", path.join(source, "skill", "LINK.md"));

    expect(() => diffTrees(source, mirror)).toThrow(SyncAgentsError);
    expect(() => diffTrees(source, mirror)).toThrow(/ERR_AGENTS_UNSUPPORTED_ENTRY/);
  });
});

describe("syncTrees", () => {
  it("repairs every kind of drift and leaves the trees identical", () => {
    const { source, mirror } = makeTrees();
    writeFileSync(path.join(source, "skill", "NOTES.md"), "notes\n");
    writeFileSync(path.join(mirror, "skill", "SKILL.md"), "# Skill (edited)\n");
    mkdirSync(path.join(mirror, "skill", "gone"), { recursive: true });
    writeFileSync(path.join(mirror, "skill", "gone", "stale.md"), "stale\n");

    const repaired = syncTrees(source, mirror);

    expect(repaired.map(({ kind }) => kind).sort()).toEqual([
      "differs",
      "extra",
      "missing",
    ]);
    expect(diffTrees(source, mirror)).toEqual([]);
  });

  // A path that changed kind is reported as one `extra` and one `missing`.
  // Copying before deleting would hit the stale entry of the other kind and
  // fail with a bare `EISDIR`/`ENOTDIR` instead of repairing the drift.
  it("replaces a mirror file that the source now keeps as a directory", () => {
    const { source, mirror } = makeTrees();
    writeFileSync(path.join(mirror, "skill", "references"), "notes\n");
    mkdirSync(path.join(source, "skill", "references"), { recursive: true });
    writeFileSync(
      path.join(source, "skill", "references", "failure-modes.md"),
      "modes\n",
    );

    syncTrees(source, mirror);

    expect(diffTrees(source, mirror)).toEqual([]);
  });

  it("replaces a mirror directory that the source now keeps as a file", () => {
    const { source, mirror } = makeTrees();
    mkdirSync(path.join(mirror, "skill", "references"), { recursive: true });
    writeFileSync(
      path.join(mirror, "skill", "references", "failure-modes.md"),
      "modes\n",
    );
    writeFileSync(path.join(source, "skill", "references"), "notes\n");

    syncTrees(source, mirror);

    expect(diffTrees(source, mirror)).toEqual([]);
  });
});

describe("formatDrift", () => {
  it("names the code, both paths, and the command that repairs it", () => {
    const message = formatDrift([{ kind: "differs", relative: "skill/SKILL.md" }]);

    expect(message).toContain("ERR_AGENTS_DRIFT");
    expect(message).toContain(`${MIRROR_DIRECTORY}/skill/SKILL.md`);
    expect(message).toContain("Next: run `pnpm agents:sync`.");
  });
});

describe("listFiles", () => {
  it("lists every file recursively as sorted, forward-slash relative paths", () => {
    const workspace = makeWorkspace("sync-agents-listfiles");
    mkdirSync(path.join(workspace, "a", "b"), { recursive: true });
    writeFileSync(path.join(workspace, "top.md"), "top\n");
    writeFileSync(path.join(workspace, "a", "mid.md"), "mid\n");
    writeFileSync(path.join(workspace, "a", "b", "deep.md"), "deep\n");

    expect(listFiles(workspace, "label")).toEqual([
      "a/b/deep.md",
      "a/mid.md",
      "top.md",
    ]);
  });

  it("returns an empty array for a directory that does not exist", () => {
    const workspace = makeWorkspace("sync-agents-listfiles");

    expect(listFiles(path.join(workspace, "absent"), "label")).toEqual([]);
  });

  it("throws ERR_AGENTS_UNSUPPORTED_ENTRY for a symlink", () => {
    const workspace = makeWorkspace("sync-agents-listfiles");
    writeFileSync(path.join(workspace, "real.md"), "real\n");
    symlinkSync("real.md", path.join(workspace, "link.md"));

    expect(() => listFiles(workspace, "label")).toThrow(SyncAgentsError);
    expect(() => listFiles(workspace, "label")).toThrow(/ERR_AGENTS_UNSUPPORTED_ENTRY/);
  });
});

describe("assertSourceDirectory", () => {
  it("does not throw when the directory exists", () => {
    const workspace = makeWorkspace("sync-agents-source");
    mkdirSync(path.join(workspace, "skills"));

    expect(() => assertSourceDirectory(path.join(workspace, "skills"))).not.toThrow();
  });

  it("throws ERR_AGENTS_SOURCE_MISSING when the directory is absent", () => {
    const workspace = makeWorkspace("sync-agents-source");

    expect(() => assertSourceDirectory(path.join(workspace, "absent"))).toThrow(
      SyncAgentsError,
    );
    expect(() => assertSourceDirectory(path.join(workspace, "absent"))).toThrow(
      /ERR_AGENTS_SOURCE_MISSING/,
    );
  });

  it("rethrows a non-ENOENT filesystem error instead of reporting it as missing", () => {
    const workspace = makeWorkspace("sync-agents-source");
    const notADirectory = path.join(workspace, "not-a-directory");
    writeFileSync(notADirectory, "file, not a directory\n");

    expect(() => assertSourceDirectory(path.join(notADirectory, "child"))).toThrow(
      /ENOTDIR/,
    );
  });
});

describe("main", () => {
  function makeRoot(): string {
    return makeWorkspace("sync-agents-main");
  }

  function seedSource(root: string): void {
    mkdirSync(path.join(root, SOURCE_DIRECTORY, "skill"), { recursive: true });
    writeFileSync(path.join(root, SOURCE_DIRECTORY, "skill", "SKILL.md"), "# Skill\n");
  }

  it("returns 2 and reports an unknown option", () => {
    const errorSpy = vi
      .spyOn(consoleModule, "error")
      .mockImplementation(() => undefined);
    const root = makeRoot();

    expect(main(["--bogus"], root)).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/ERR_AGENTS_ARGUMENT/));
  });

  it("returns 2 when the source tree is missing", () => {
    vi.spyOn(consoleModule, "error").mockImplementation(() => undefined);
    const root = makeRoot();

    expect(main([], root)).toBe(2);
  });

  it("returns 0 and logs that the mirror is in sync when --check finds no drift", () => {
    const logSpy = vi.spyOn(consoleModule, "log").mockImplementation(() => undefined);
    const root = makeRoot();
    seedSource(root);
    syncTrees(path.join(root, SOURCE_DIRECTORY), path.join(root, MIRROR_DIRECTORY));

    expect(main(["--check"], root)).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/is in sync/));
  });

  it("returns 1 and reports drift when --check finds differences", () => {
    const errorSpy = vi
      .spyOn(consoleModule, "error")
      .mockImplementation(() => undefined);
    const root = makeRoot();
    seedSource(root);

    expect(main(["--check"], root)).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/ERR_AGENTS_DRIFT/));
  });

  it("repairs drift and logs the repaired count when run without --check", () => {
    const logSpy = vi.spyOn(consoleModule, "log").mockImplementation(() => undefined);
    const root = makeRoot();
    seedSource(root);

    expect(main([], root)).toBe(0);
    expect(
      diffTrees(path.join(root, SOURCE_DIRECTORY), path.join(root, MIRROR_DIRECTORY)),
    ).toEqual([]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/updated 1 path\(s\)/));
  });

  it("logs that the mirror was already in sync when nothing drifted", () => {
    const logSpy = vi.spyOn(consoleModule, "log").mockImplementation(() => undefined);
    const root = makeRoot();
    seedSource(root);
    syncTrees(path.join(root, SOURCE_DIRECTORY), path.join(root, MIRROR_DIRECTORY));

    expect(main([], root)).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/was already in sync/));
  });

  it("returns 1, not 2, when a plain filesystem error propagates instead of a SyncAgentsError", () => {
    const errorSpy = vi
      .spyOn(consoleModule, "error")
      .mockImplementation(() => undefined);
    const root = makeRoot();
    seedSource(root);
    mkdirSync(path.join(root, ".claude"), { recursive: true });
    // The mirror's own path exists as a plain file, so readdirSync on it
    // throws ENOTDIR rather than the ENOENT listFiles tolerates — the
    // uncaught-by-SyncAgentsError branch main() distinguishes with exit 1.
    writeFileSync(path.join(root, MIRROR_DIRECTORY), "not a directory\n");

    expect(main([], root)).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });
});
