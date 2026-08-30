import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SettingsParseError } from "../src/internal/errors.js";
import {
  discoverSources,
  hooksForEvent,
  loadSettings,
  mergeSources,
} from "../src/internal/settings/index.js";
import type {
  RawHook,
  ResolvedSettings,
  SettingsSource,
} from "../src/internal/settings/types.js";
import type { EventName, SettingsLayer } from "../src/types.js";

// Reaching src/internal/settings/ directly (rather than through
// src/index.ts's exports, per the writing-tests skill) is a deliberate,
// narrowly scoped exception: this module has no public surface in this
// issue and never will one for its own plumbing types (SettingsSource,
// ResolvedSettings) — see eslint.config.mjs's "tests/static-layer-unit-tests"
// block for the full reasoning.

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/settings/", import.meta.url));

function fixturePath(caseDir: string, file: string): string {
  return path.join(FIXTURES_DIR, caseDir, file);
}

function source(caseDir: string, file: string, layer: SettingsLayer): SettingsSource {
  return { path: fixturePath(caseDir, file), layer };
}

/** Reverse of the loader's own offset -> {line, col} conversion, to check it
 * independently rather than by re-running the same algorithm. */
function offsetOf(text: string, line: number, col: number): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < line - 1; i++) {
    offset += (lines[i]?.length ?? 0) + 1;
  }
  return offset + (col - 1);
}

interface ExpectedHook {
  readonly event: EventName;
  readonly matcher: string | undefined;
  readonly command: string;
  readonly layer: SettingsLayer;
  readonly file: string;
  readonly line: number;
  readonly col: number;
}

describe("loadSettings: the concatenating merge", () => {
  it("concatenates hooks from all three layers rather than letting local override project", () => {
    const settings = loadSettings([
      source("project-and-local-same-event", "project.json", "project"),
      source("project-and-local-same-event", "local.json", "local"),
    ]);

    const firing = settings.hooks.filter((hook) => hook.event === "PreToolUse");
    expect(firing).toHaveLength(2);
    expect(firing.map((hook) => hook.command)).toEqual([
      "./scripts/project-guard.sh",
      "./scripts/local-guard.sh",
    ]);
    expect(firing.map((hook) => hook.provenance.layer)).toEqual(["project", "local"]);
  });

  it("resolves the absolute source file path and 1-based line number for a hook declared in project settings", () => {
    const file = fixturePath("project-only", "project.json");
    const settings = loadSettings([source("project-only", "project.json", "project")]);

    expect(settings.hooks).toHaveLength(1);
    const hook = settings.hooks[0];
    expect(hook?.provenance.file).toBe(file);
    expect(path.isAbsolute(hook?.provenance.file ?? "")).toBe(true);
    expect(hook?.provenance.line).toBe(7);
    expect(hook?.provenance.col).toBe(11);
  });

  it("resolves the same for a hook declared in user settings and one declared in local settings", () => {
    const settings = loadSettings([
      source("user-only", "user.json", "user"),
      source("local-only", "local.json", "local"),
    ]);

    expect(settings.hooks).toHaveLength(2);
    const [userHook, localHook] = settings.hooks;
    expect(userHook?.provenance.file).toBe(fixturePath("user-only", "user.json"));
    expect(userHook?.provenance.layer).toBe("user");
    expect(userHook?.provenance.line).toBe(7);
    expect(userHook?.provenance.col).toBe(11);

    expect(localHook?.provenance.file).toBe(fixturePath("local-only", "local.json"));
    expect(localHook?.provenance.layer).toBe("local");
    expect(localHook?.provenance.line).toBe(6);
    expect(localHook?.provenance.col).toBe(11);
  });

  it("dedupes two identical hook declarations across layers and keeps a stable dedupeKey", () => {
    const settings = loadSettings([
      source("duplicate-hook-across-layers", "project.json", "project"),
      source("duplicate-hook-across-layers", "local.json", "local"),
    ]);

    expect(settings.hooks).toHaveLength(1);
    const [hook] = settings.hooks;
    // The surviving entry is the first occurrence in layer order (project).
    expect(hook?.provenance.layer).toBe("project");
    expect(hook?.dedupeKey).toBe(
      JSON.stringify(["PermissionRequest", "Bash", "./scripts/confirm.sh"]),
    );

    // Stable: reloading the same sources yields the identical key.
    const reloaded = loadSettings([
      source("duplicate-hook-across-layers", "project.json", "project"),
      source("duplicate-hook-across-layers", "local.json", "local"),
    ]);
    expect(reloaded.hooks[0]?.dedupeKey).toBe(hook?.dedupeKey);
  });

  it("does not collapse two distinct declarations whose args contain the dedupe key's own separator", () => {
    // A plain "::"-joined key would make ["a::b"] indistinguishable from
    // ["a", "b"] once concatenated, silently dropping the second hook as a
    // false-positive duplicate.
    const provenance = {
      file: fixturePath("project-only", "project.json"),
      layer: "project" as const,
      line: 1,
      col: 1,
      offset: 0,
    };
    const rawHookWithMergedArg: RawHook = {
      event: "PreToolUse",
      matcher: "Bash",
      command: "echo",
      args: ["a::b"],
      timeoutMs: undefined,
      provenance,
    };
    const rawHookWithSplitArgs: RawHook = {
      event: "PreToolUse",
      matcher: "Bash",
      command: "echo",
      args: ["a", "b"],
      timeoutMs: undefined,
      provenance,
    };

    const merged = mergeSources([
      {
        source: { path: provenance.file, layer: "project" },
        hooks: [rawHookWithMergedArg],
      },
      {
        source: { path: provenance.file, layer: "project" },
        hooks: [rawHookWithSplitArgs],
      },
    ]);

    expect(merged.hooks).toHaveLength(2);
    expect(merged.hooks[0]?.dedupeKey).not.toBe(merged.hooks[1]?.dedupeKey);
  });

  it("hooksForEvent returns hooks in a deterministic, documented order (user, then project, then local, then explicit)", () => {
    const settings = loadSettings([
      // Passed out of layer order on purpose: the merge must sort by layer,
      // not by the order sources were given.
      source("four-layers-ordered", "local.json", "local"),
      source("four-layers-ordered", "explicit.json", "explicit"),
      source("four-layers-ordered", "user.json", "user"),
      source("four-layers-ordered", "project.json", "project"),
    ]);

    const firing = hooksForEvent(settings, "PreToolUse");
    expect(firing.map((hook) => hook.command)).toEqual([
      "./scripts/user-order.sh",
      "./scripts/project-order.sh",
      "./scripts/local-order.sh",
      "./scripts/explicit-order.sh",
    ]);
    expect(firing.map((hook) => hook.provenance.layer)).toEqual([
      "user",
      "project",
      "local",
      "explicit",
    ]);
  });

  it("an explicit --settings file contributes hooks tagged with layer: explicit", () => {
    const settings = loadSettings([
      source("explicit-layer", "explicit.json", "explicit"),
    ]);

    expect(settings.hooks).toHaveLength(1);
    expect(settings.hooks[0]?.provenance.layer).toBe("explicit");
    expect(settings.hooks[0]?.provenance.file).toBe(
      fixturePath("explicit-layer", "explicit.json"),
    );
  });

  it("throws ERR_SETTINGS_PARSE (exit 5) for a JSONC syntax error", () => {
    let caught: unknown;
    try {
      loadSettings([source("malformed-jsonc", "project.json", "project")]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SettingsParseError);
    const error = caught as SettingsParseError;
    expect(error.code).toBe("ERR_SETTINGS_PARSE");
    expect(error.exitCode).toBe(5);
    expect(error.file).toBe(fixturePath("malformed-jsonc", "project.json"));
    expect(error.layer).toBe("project");
  });
});

describe("discoverSources", () => {
  it("orders the well-known layers user, project, local before any explicit file", () => {
    const sources = discoverSources({
      cwd: "/repo",
      home: "/home/dev",
      explicit: ["extra.json"],
    });

    expect(sources.map((entry) => entry.layer)).toEqual([
      "user",
      "project",
      "local",
      "explicit",
    ]);
    expect(sources[0]?.path).toBe(path.join("/home/dev", ".claude", "settings.json"));
    expect(sources[1]?.path).toBe(path.join("/repo", ".claude", "settings.json"));
    expect(sources[2]?.path).toBe(path.join("/repo", ".claude", "settings.local.json"));
    expect(sources[3]?.path).toBe(path.resolve("/repo", "extra.json"));
  });

  it("supports multiple --settings files, preserving their given order", () => {
    const sources = discoverSources({
      cwd: "/repo",
      home: "/home/dev",
      explicit: ["a.json", "b.json"],
    });

    const explicitSources = sources.filter((entry) => entry.layer === "explicit");
    expect(explicitSources.map((entry) => entry.path)).toEqual([
      path.resolve("/repo", "a.json"),
      path.resolve("/repo", "b.json"),
    ]);
  });

  it("returns only the three well-known layers when no --settings file is given", () => {
    const sources = discoverSources({ cwd: "/repo", home: "/home/dev" });
    expect(sources).toHaveLength(3);
  });
});

const FIXTURE_CASES: readonly {
  readonly name: string;
  readonly sources: readonly SettingsSource[];
  readonly expected: readonly ExpectedHook[];
}[] = [
  {
    name: "project-only",
    sources: [source("project-only", "project.json", "project")],
    expected: [
      {
        event: "PreToolUse",
        matcher: "Bash",
        command: "./scripts/guard.sh",
        layer: "project",
        file: fixturePath("project-only", "project.json"),
        line: 7,
        col: 11,
      },
    ],
  },
  {
    name: "user-only",
    sources: [source("user-only", "user.json", "user")],
    expected: [
      {
        event: "PostToolUse",
        matcher: "Write",
        command: "./scripts/format.sh",
        layer: "user",
        file: fixturePath("user-only", "user.json"),
        line: 7,
        col: 11,
      },
    ],
  },
  {
    name: "local-only",
    sources: [source("local-only", "local.json", "local")],
    expected: [
      {
        event: "Stop",
        matcher: undefined,
        command: "./scripts/notify.sh",
        layer: "local",
        file: fixturePath("local-only", "local.json"),
        line: 6,
        col: 11,
      },
    ],
  },
  {
    name: "project-and-local-same-event",
    sources: [
      source("project-and-local-same-event", "project.json", "project"),
      source("project-and-local-same-event", "local.json", "local"),
    ],
    expected: [
      {
        event: "PreToolUse",
        matcher: "Bash",
        command: "./scripts/project-guard.sh",
        layer: "project",
        file: fixturePath("project-and-local-same-event", "project.json"),
        line: 7,
        col: 11,
      },
      {
        event: "PreToolUse",
        matcher: "Bash",
        command: "./scripts/local-guard.sh",
        layer: "local",
        file: fixturePath("project-and-local-same-event", "local.json"),
        line: 7,
        col: 11,
      },
    ],
  },
  {
    name: "all-three-layers",
    sources: [
      source("all-three-layers", "local.json", "local"),
      source("all-three-layers", "user.json", "user"),
      source("all-three-layers", "project.json", "project"),
    ],
    expected: [
      {
        event: "FileChanged",
        matcher: undefined,
        command: "./scripts/user-sync.sh",
        layer: "user",
        file: fixturePath("all-three-layers", "user.json"),
        line: 6,
        col: 11,
      },
      {
        event: "PreToolUse",
        matcher: "Bash",
        // The project file uses JSONC comments and trailing commas on
        // purpose, proving jsonc-parser tolerates both.
        command: "./scripts/project-check.sh",
        layer: "project",
        file: fixturePath("all-three-layers", "project.json"),
        line: 8,
        col: 11,
      },
      {
        event: "PostToolUse",
        matcher: "Write",
        command: "./scripts/local-format.sh",
        layer: "local",
        file: fixturePath("all-three-layers", "local.json"),
        line: 7,
        col: 11,
      },
    ],
  },
  {
    name: "duplicate-hook-across-layers",
    sources: [
      source("duplicate-hook-across-layers", "project.json", "project"),
      source("duplicate-hook-across-layers", "local.json", "local"),
    ],
    expected: [
      {
        event: "PermissionRequest",
        matcher: "Bash",
        command: "./scripts/confirm.sh",
        layer: "project",
        file: fixturePath("duplicate-hook-across-layers", "project.json"),
        line: 7,
        col: 11,
      },
    ],
  },
  {
    name: "explicit-layer",
    sources: [source("explicit-layer", "explicit.json", "explicit")],
    expected: [
      {
        event: "Stop",
        matcher: undefined,
        command: "./scripts/ci-report.sh",
        layer: "explicit",
        file: fixturePath("explicit-layer", "explicit.json"),
        line: 6,
        col: 11,
      },
    ],
  },
  {
    name: "four-layers-ordered",
    sources: [
      source("four-layers-ordered", "user.json", "user"),
      source("four-layers-ordered", "project.json", "project"),
      source("four-layers-ordered", "local.json", "local"),
      source("four-layers-ordered", "explicit.json", "explicit"),
    ],
    expected: (["user", "project", "local", "explicit"] as const).map((layer) => ({
      event: "PreToolUse",
      matcher: "Bash",
      command: `./scripts/${layer}-order.sh`,
      layer,
      file: fixturePath("four-layers-ordered", `${layer}.json`),
      line: 7,
      col: 11,
    })),
  },
  {
    name: "multiple-matchers-one-event",
    sources: [source("multiple-matchers-one-event", "project.json", "project")],
    expected: [
      {
        event: "PreToolUse",
        matcher: "Bash",
        command: "./scripts/bash-guard.sh",
        layer: "project",
        file: fixturePath("multiple-matchers-one-event", "project.json"),
        line: 7,
        col: 11,
      },
      {
        event: "PreToolUse",
        matcher: "Write",
        command: "./scripts/write-guard.sh",
        layer: "project",
        file: fixturePath("multiple-matchers-one-event", "project.json"),
        line: 16,
        col: 11,
      },
    ],
  },
  {
    name: "unknown-event-key",
    sources: [source("unknown-event-key", "project.json", "project")],
    expected: [
      {
        event: "PreToolUse",
        matcher: "Bash",
        command: "./scripts/known.sh",
        layer: "project",
        file: fixturePath("unknown-event-key", "project.json"),
        line: 17,
        col: 11,
      },
    ],
  },
  {
    name: "no-hooks-key",
    sources: [source("no-hooks-key", "project.json", "project")],
    expected: [],
  },
];

describe.each(FIXTURE_CASES)("fixture: $name", ({ sources, expected }) => {
  it("resolves the firing set, its order, absolute file path, and line number exactly", () => {
    const settings: ResolvedSettings = loadSettings(sources);
    expect(settings.hooks).toHaveLength(expected.length);
    expected.forEach((want, index) => {
      const got = settings.hooks[index];
      expect(got).toBeDefined();
      expect(got?.event).toBe(want.event);
      expect(got?.matcher).toBe(want.matcher);
      expect(got?.command).toBe(want.command);
      expect(got?.provenance.layer).toBe(want.layer);
      expect(got?.provenance.file).toBe(want.file);
      expect(got?.provenance.line).toBe(want.line);
      expect(got?.provenance.col).toBe(want.col);
    });
  });
});

describe("loadSettings: individual field validation", () => {
  it("reads an optional args array and converts timeout from seconds to milliseconds", () => {
    const settings = loadSettings([
      source("with-args-and-timeout", "project.json", "project"),
    ]);

    expect(settings.hooks).toHaveLength(1);
    const [hook] = settings.hooks;
    expect(hook?.args).toEqual(["--strict", "--fix"]);
    expect(hook?.timeoutMs).toBe(30_000);
  });

  it("treats a missing settings file as contributing zero hooks", () => {
    const settings = loadSettings([
      { path: fixturePath("project-only", "does-not-exist.json"), layer: "project" },
    ]);
    expect(settings.hooks).toEqual([]);
  });

  it("propagates a non-ENOENT filesystem error rather than treating it as zero hooks", () => {
    // project-only/ is a directory, not a file: readFileSync rejects it with
    // EISDIR, which is not the "file legitimately does not exist" case.
    const directoryPath = path.join(FIXTURES_DIR, "project-only");
    let caught: unknown;
    try {
      loadSettings([{ path: directoryPath, layer: "project" }]);
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeInstanceOf(SettingsParseError);
    expect((caught as NodeJS.ErrnoException).code).toBe("EISDIR");
  });

  const STRUCTURAL_ERROR_CASES = [
    "hooks-not-object",
    "event-not-array",
    "group-not-object",
    "group-missing-hooks",
    "hook-entry-not-object",
    "command-missing",
    "command-empty",
    "command-not-string",
    "matcher-not-string",
    "args-not-array",
    "args-element-not-string",
    "timeout-not-number",
    "root-not-object",
  ] as const;

  it.each(STRUCTURAL_ERROR_CASES)(
    "rejects a hooks value shaped wrong: %s",
    (caseName) => {
      let caught: unknown;
      try {
        loadSettings([source("structural-errors", `${caseName}.json`, "project")]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SettingsParseError);
      expect((caught as SettingsParseError).code).toBe("ERR_SETTINGS_PARSE");
      expect((caught as SettingsParseError).exitCode).toBe(5);
    },
  );
});

describe("Provenance.offset", () => {
  it("matches the loader's own offset for an independently reverse-computed line/col", () => {
    const settings = loadSettings([source("project-only", "project.json", "project")]);
    const hook = settings.hooks[0];
    expect(hook).toBeDefined();

    const text = readFileSync(fixturePath("project-only", "project.json"), "utf8");
    const expectedOffset = offsetOf(
      text,
      hook?.provenance.line ?? 0,
      hook?.provenance.col ?? 0,
    );
    expect(hook?.provenance.offset).toBe(expectedOffset);
  });
});

describe("a matcher written as a JSON array disables every hook in that settings file", () => {
  it("throws SettingsParseError and yields zero hooks from the whole file, not just the bad one", () => {
    let caught: unknown;
    try {
      loadSettings([source("array-matcher-disables-file", "project.json", "project")]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SettingsParseError);
    expect((caught as SettingsParseError).code).toBe("ERR_SETTINGS_PARSE");
    expect((caught as SettingsParseError).exitCode).toBe(5);
  });
});
