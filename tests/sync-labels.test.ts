import consoleModule from "node:console";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

import { parseLabelManifest } from "../scripts/lib/labels-manifest.mjs";
import {
  applyActions,
  diffLabels,
  fetchRemoteLabels,
  formatPlan,
  ghJson,
  ghRun,
  main,
  resolveRepo,
  spawnGh,
} from "../scripts/sync-labels.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

interface GhResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** An in-memory fake `gh` runner: a real fake, not a mock of `node:child_process`. */
function makeFakeGh(responder: (args: string[]) => GhResult) {
  const calls: string[][] = [];
  const run = (args: readonly string[]): GhResult => {
    const snapshot = [...args];
    calls.push(snapshot);
    return responder(snapshot);
  };
  return { run, calls };
}

function ok(stdout = ""): GhResult {
  return { status: 0, stdout, stderr: "" };
}

function failed(stderr: string): GhResult {
  return { status: 1, stdout: "", stderr };
}

function unavailable(): GhResult {
  return { status: null, stdout: "", stderr: "", error: new Error("spawn gh ENOENT") };
}

describe("parseLabelManifest", () => {
  it("parses name, color, and description, unquoting the name when it holds a colon", () => {
    const parsed = parseLabelManifest(
      '- name: "priority: P0"\n  color: b60205\n  description: "Ship now."\n',
    );
    expect(parsed).toEqual([
      { name: "priority: P0", color: "b60205", description: "Ship now." },
    ]);
  });

  it("skips blank lines and comments", () => {
    const parsed = parseLabelManifest(
      "# a comment\n\n- name: bug\n  color: d73a4a\n  description: Bug.\n",
    );
    expect(parsed).toEqual([{ name: "bug", color: "d73a4a", description: "Bug." }]);
  });

  it("throws ERR_LABELS_MANIFEST_INCOMPLETE when a field is missing", () => {
    expect(() => parseLabelManifest("- name: bug\n  color: d73a4a\n")).toThrow(
      /ERR_LABELS_MANIFEST_INCOMPLETE/,
    );
  });

  it("throws ERR_LABELS_MANIFEST_COLOR for a color that is not six hex digits", () => {
    expect(() =>
      parseLabelManifest("- name: bug\n  color: red\n  description: Bug.\n"),
    ).toThrow(/ERR_LABELS_MANIFEST_COLOR/);
  });

  it("throws ERR_LABELS_MANIFEST_DUPLICATE when a name repeats", () => {
    const text =
      "- name: bug\n  color: d73a4a\n  description: Bug.\n" +
      "- name: bug\n  color: d73a4a\n  description: Bug again.\n";
    expect(() => parseLabelManifest(text)).toThrow(/ERR_LABELS_MANIFEST_DUPLICATE/);
  });
});

describe("diffLabels", () => {
  const manifest = [
    { name: "bug", color: "d73a4a", description: "Bug." },
    { name: "chore", color: "fef2c0", description: "Chore." },
  ];

  it("proposes creating every label absent from the remote list", () => {
    expect(diffLabels(manifest, [])).toEqual([
      { kind: "create", label: manifest[0] },
      { kind: "create", label: manifest[1] },
    ]);
  });

  it("proposes nothing when the remote already matches", () => {
    expect(diffLabels(manifest, manifest)).toEqual([]);
  });

  it("proposes updating a label whose color or description differs, case-insensitively on color", () => {
    const remote = [
      { name: "bug", color: "D73A4A", description: "Bug." },
      { name: "chore", color: "fef2c0", description: "Old description." },
    ];
    expect(diffLabels(manifest, remote)).toEqual([
      {
        kind: "update",
        label: manifest[1],
        from: { color: "fef2c0", description: "Old description." },
      },
    ]);
  });

  it("never deletes: a remote-only label produces no action", () => {
    const remote = [...manifest, { name: "extra", color: "ffffff", description: "x" }];
    expect(diffLabels(manifest, remote)).toEqual([]);
  });
});

describe("formatPlan", () => {
  it("reports nothing to do when there are no actions", () => {
    expect(formatPlan([])).toMatch(/already matches/);
  });

  it("renders one line per action", () => {
    const text = formatPlan([
      { kind: "create", label: { name: "bug", color: "d73a4a", description: "Bug." } },
      {
        kind: "update",
        label: { name: "chore", color: "fef2c0", description: "New." },
        from: { color: "000000", description: "Old." },
      },
    ]);
    const lines = text.split("\n");
    expect(lines[0]).toBe('+ create bug (d73a4a) "Bug."');
    expect(lines[1]).toBe('~ update chore: 000000 "Old." -> fef2c0 "New."');
  });
});

describe("spawnGh", () => {
  // The real `gh` CLI, not a fake: this is the one function whose whole job
  // is spawning it, so its own test is the boundary mock/fake exception —
  // `writing-tests`' "mock only at boundaries" — rather than exercising a
  // fake through it. `ubuntu-latest` GitHub Actions runners ship `gh`
  // preinstalled, and it is on the developer's PATH locally too.
  it("captures stdout and a zero status when gh runs successfully", () => {
    const result = spawnGh(["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("gh version");
    expect(result.error).toBeUndefined();
  });

  it("reports a spawn error instead of throwing when gh cannot be found on PATH", () => {
    vi.stubEnv("PATH", "");
    const result = spawnGh(["--version"]);
    expect(result.status).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
  });
});

describe("ghJson / ghRun", () => {
  it("ghJson throws ERR_GH_UNAVAILABLE when gh cannot be spawned", () => {
    const { run } = makeFakeGh(() => unavailable());
    expect(() => ghJson(["repo", "view"], run)).toThrow(/ERR_GH_UNAVAILABLE/);
  });

  it("ghJson throws ERR_GH_FAILED when gh exits non-zero", () => {
    const { run } = makeFakeGh(() => failed("not authenticated"));
    expect(() => ghJson(["repo", "view"], run)).toThrow(/ERR_GH_FAILED/);
  });

  it("ghJson returns the parsed payload on success", () => {
    const { run } = makeFakeGh(() => ok('{"nameWithOwner":"o/r"}'));
    expect(ghJson(["repo", "view"], run)).toEqual({ nameWithOwner: "o/r" });
  });

  it("ghRun throws ERR_GH_UNAVAILABLE when gh cannot be spawned", () => {
    const { run } = makeFakeGh(() => unavailable());
    expect(() => ghRun(["label", "create", "bug"], run)).toThrow(/ERR_GH_UNAVAILABLE/);
  });

  it("ghRun throws ERR_GH_FAILED when gh exits non-zero", () => {
    const { run } = makeFakeGh(() => failed("boom"));
    expect(() => ghRun(["label", "create", "bug"], run)).toThrow(/ERR_GH_FAILED/);
  });

  it("ghRun does not throw on success", () => {
    const { run } = makeFakeGh(() => ok());
    expect(() => ghRun(["label", "create", "bug"], run)).not.toThrow();
  });
});

describe("resolveRepo", () => {
  it("returns the nameWithOwner slug", () => {
    const { run } = makeFakeGh(() =>
      ok('{"nameWithOwner":"tomada1114/typescript-template"}'),
    );
    expect(resolveRepo(run)).toBe("tomada1114/typescript-template");
  });

  it("throws ERR_GH_NO_REPO when the payload has no nameWithOwner", () => {
    const { run } = makeFakeGh(() => ok("{}"));
    expect(() => resolveRepo(run)).toThrow(/ERR_GH_NO_REPO/);
  });
});

describe("fetchRemoteLabels", () => {
  it("reads name, color, and description, lower-casing color", () => {
    const { run } = makeFakeGh(() =>
      ok(JSON.stringify([{ name: "bug", color: "D73A4A", description: "Bug." }])),
    );
    expect(fetchRemoteLabels("o/r", run)).toEqual([
      { name: "bug", color: "d73a4a", description: "Bug." },
    ]);
  });

  it("defaults missing fields to empty strings and tolerates a non-array payload", () => {
    const { run } = makeFakeGh(() => ok("null"));
    expect(fetchRemoteLabels("o/r", run)).toEqual([]);
  });
});

describe("applyActions", () => {
  it("issues gh label create for a create action and gh label edit for an update", () => {
    const { run, calls } = makeFakeGh(() => ok());
    applyActions(
      "o/r",
      [
        {
          kind: "create",
          label: { name: "bug", color: "d73a4a", description: "Bug." },
        },
        {
          kind: "update",
          label: { name: "chore", color: "fef2c0", description: "New." },
          from: { color: "000000", description: "Old." },
        },
      ],
      run,
    );
    expect(calls).toEqual([
      [
        "label",
        "create",
        "bug",
        "--repo",
        "o/r",
        "--color",
        "d73a4a",
        "--description",
        "Bug.",
      ],
      [
        "label",
        "edit",
        "chore",
        "--repo",
        "o/r",
        "--color",
        "fef2c0",
        "--description",
        "New.",
      ],
    ]);
  });

  it("propagates a failure from gh label create/edit", () => {
    const { run } = makeFakeGh(() => failed("nope"));
    expect(() =>
      applyActions(
        "o/r",
        [
          {
            kind: "create",
            label: { name: "bug", color: "d73a4a", description: "Bug." },
          },
        ],
        run,
      ),
    ).toThrow(/ERR_GH_FAILED/);
  });
});

describe("main", () => {
  let errorSpy: MockInstance<typeof console.error>;
  let logSpy: MockInstance<typeof console.log>;
  const tempDirs: string[] = [];

  beforeEach(() => {
    // scripts/sync-labels.mjs imports `console` from "node:console" (AGENTS.md's
    // "Repository automation" convention), which is a distinct object from the
    // ambient global under Vitest, so the spy has to target the same module.
    errorSpy = vi.spyOn(consoleModule, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(consoleModule, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unknown arguments without touching gh, exiting 2", () => {
    const { run, calls } = makeFakeGh(() => ok());
    const code = main(["--bogus"], { root: repoRoot, run });
    expect(code).toBe(2);
    expect(calls).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/ERR_LABELS_ARGUMENT/));
  });

  it("exits 1 with a clear message when the manifest cannot be read", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sync-labels-test-"));
    tempDirs.push(dir);
    const { run } = makeFakeGh(() => ok());
    const code = main([], { root: dir, run });
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("exits 1 with ERR_GH_UNAVAILABLE when gh is not on PATH, without a silent no-op", () => {
    const { run } = makeFakeGh(() => unavailable());
    const code = main([], { root: repoRoot, run });
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/ERR_GH_UNAVAILABLE/));
  });

  it("exits 1 with ERR_GH_FAILED when gh is unauthenticated", () => {
    const { run } = makeFakeGh((args) =>
      args[0] === "repo"
        ? failed("gh: To get started with GitHub CLI, run: gh auth login")
        : ok(),
    );
    const code = main([], { root: repoRoot, run });
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/ERR_GH_FAILED/));
  });

  it("creates missing labels and updates changed ones, leaving matching labels alone", () => {
    const { run, calls } = makeFakeGh((args) => {
      if (args[0] === "repo") {
        return ok('{"nameWithOwner":"tomada1114/typescript-template"}');
      }
      if (args[1] === "list") {
        // "bug" matches the manifest exactly; "enhancement" has a stale
        // description; every other manifest label is absent from the remote.
        return ok(
          JSON.stringify([
            {
              name: "bug",
              color: "d73a4a",
              description: "Reproducible incorrect behavior.",
            },
            { name: "enhancement", color: "a2eeef", description: "Old description." },
          ]),
        );
      }
      return ok();
    });

    const code = main([], { root: repoRoot, run });
    expect(code).toBe(0);

    const mutations = calls.filter((call) => call[0] === "label" && call[1] !== "list");
    expect(
      mutations.some((call) => call[1] === "edit" && call[2] === "enhancement"),
    ).toBe(true);
    expect(
      mutations.some((call) => call[1] === "create" && call[2] === "documentation"),
    ).toBe(true);
    expect(mutations.some((call) => call[2] === "bug")).toBe(false);

    // The diff-shaped plan and the final tally both go through console.log.
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("~ update enhancement"),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(`applied ${String(mutations.length)} change(s)`),
    );
  });

  it("does not log a change tally when every label already matches", () => {
    // A dedicated fixture root with its own small manifest, rather than this
    // repository's own `.github/labels.yml`: matching it label-for-label
    // inline here would silently drift out of sync with that file.
    const dir = mkdtempSync(path.join(tmpdir(), "sync-labels-test-"));
    tempDirs.push(dir);
    mkdirSync(path.join(dir, ".github"), { recursive: true });
    writeFileSync(
      path.join(dir, ".github", "labels.yml"),
      "- name: bug\n  color: d73a4a\n  description: Bug.\n",
    );
    const { run } = makeFakeGh((args) => {
      if (args[0] === "repo") {
        return ok('{"nameWithOwner":"o/r"}');
      }
      if (args[1] === "list") {
        return ok(
          JSON.stringify([{ name: "bug", color: "d73a4a", description: "Bug." }]),
        );
      }
      return ok();
    });

    const code = main([], { root: dir, run });
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/already matches/));
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/applied \d+ change/),
    );
  });

  it("exits 1 and reports the failure when applying a change fails partway through", () => {
    const { run } = makeFakeGh((args) => {
      if (args[0] === "repo") {
        return ok('{"nameWithOwner":"tomada1114/typescript-template"}');
      }
      if (args[1] === "list") {
        return ok("[]");
      }
      return failed("gh: label create failed");
    });

    const code = main([], { root: repoRoot, run });
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/ERR_GH_FAILED/));
  });
});
