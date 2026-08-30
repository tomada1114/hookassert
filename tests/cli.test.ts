import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { isMain, main, runCli, type CliDeps } from "../src/cli.js";
import { createUnimplementedSpawner } from "../src/internal/spawner.js";
import type { Spawner, SpawnRequest } from "../src/internal/spawner.js";
import type { ExecOutcome } from "../src/types.js";

// Reaching src/internal/spawner.ts directly (rather than through
// src/index.ts's exports, per the writing-tests skill) is a deliberate,
// narrowly scoped exception: explain's zero-spawn guarantee can only be
// proven by injecting a real `Spawner` implementation into its dependency
// graph, and that interface has no public surface — see
// eslint.config.mjs's "tests/static-layer-unit-tests" block for the full
// reasoning.

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/cli/", import.meta.url));
const PROJECT_WITH_HOOKS_DIR = path.join(FIXTURES_DIR, "project-with-hooks");
const PROJECT_SETTINGS_FILE = path.join(
  PROJECT_WITH_HOOKS_DIR,
  ".claude",
  "settings.json",
);
const EXPLICIT_SETTINGS_FILE = path.join(FIXTURES_DIR, "explicit-settings.json");
// Never created on disk: loadSourceHooks treats a missing settings file as
// contributing zero hooks, so this is how a test opts a layer out entirely.
const NO_SUCH_DIR = path.join(FIXTURES_DIR, "no-such-directory");

/** The shipped spec's own declared range, from `spec/claude-code-2.1.251-2.2.0.json`. */
const SPEC_RANGE = ">=2.1.251 <2.2.0";

/** Records every call rather than performing one, so a test can assert `calls.length === 0`. */
class CountingSpawner implements Spawner {
  readonly calls: SpawnRequest[] = [];

  spawn(req: SpawnRequest): Promise<ExecOutcome> {
    this.calls.push(req);
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
  }
}

function explainDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    cwd: overrides.cwd ?? PROJECT_WITH_HOOKS_DIR,
    home: overrides.home ?? NO_SUCH_DIR,
    env: overrides.env ?? {},
    spawner: overrides.spawner ?? new CountingSpawner(),
  };
}

/** The commands hookassert will ship, in the order the usage text lists them. */
const SUBCOMMANDS = ["explain", "lint", "record", "test"] as const;

/** The commands with no behavior yet — `explain` is this issue's own subject. */
const STUB_SUBCOMMANDS = ["lint", "record", "test"] as const;

/** The `ERR_` shape AGENTS.md fixes for every published error code. */
const ERROR_CODE = /^ERR_[A-Z0-9_]+$/;

/** First stderr line, minus the trailing newline. */
function firstLine(stderr: string): string {
  return stderr.split("\n")[0] ?? "";
}

describe("runCli help", () => {
  it("--help still exits 0 and prints the usage line", () => {
    const result = runCli(["--help"], "my-tool");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: my-tool <command> [options]");
  });

  it.each(SUBCOMMANDS)("--help lists the %s command in the usage text", (name) => {
    expect(runCli(["--help"]).stdout).toContain(`  ${name}`);
  });

  it("returns help on the short help flag", () => {
    const result = runCli(["-h"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: hookassert <command> [options]");
    expect(result.stderr).toBe("");
  });

  it("prefers help over dispatch when a command is also given", () => {
    // `hookassert explain --help` asks about `explain`; until explain exists,
    // the general usage text is the honest answer, and it must not be an error.
    const result = runCli(["explain", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("exits 0 with the usage text when given no arguments", () => {
    // Deliberate: a bare invocation stays exit 0, as it was before subcommand
    // dispatch existed. Only the empty stdout changes — printing the commands
    // is what a reader of a bare `hookassert` actually needs.
    const result = runCli([], "my-tool");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: my-tool <command> [options]");
  });
});

describe("runCli dispatch", () => {
  it("exits 4 with ERR_USAGE when the subcommand is unrecognized", () => {
    const result = runCli(["frobnicate"], "my-tool");
    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe("");
    expect(firstLine(result.stderr)).toBe(
      'my-tool: ERR_USAGE: unknown command "frobnicate". ' +
        "Expected one of: explain, lint, record, test.",
    );
  });

  it("treats a leading option as an unknown command rather than ignoring it", () => {
    // Nothing parses options yet, so `--json` reaching dispatch must fail
    // loudly instead of silently selecting no command.
    const result = runCli(["--json"]);
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain('unknown command "--json"');
  });

  it.each(STUB_SUBCOMMANDS)(
    "exits 4 with a not-yet-implemented message for %s",
    (name) => {
      const result = runCli([name], "my-tool");
      expect(result.exitCode).toBe(4);
      expect(result.stdout).toBe("");
      expect(firstLine(result.stderr)).toBe(
        `my-tool: ERR_USAGE: the "${name}" command is not implemented yet.`,
      );
    },
  );

  it("points at the help flag on every usage error", () => {
    expect(runCli(["frobnicate"], "my-tool").stderr).toContain(
      "Run `my-tool --help` for usage.",
    );
  });

  it("reports a usage error with an ERR_-prefixed code", () => {
    // The code is the contract a CI log or a wrapper script branches on; the
    // prose after it is not. See the `designing-errors` skill.
    const code = /^[^:]+: (\S+):/.exec(firstLine(runCli(["frobnicate"]).stderr))?.[1];
    expect(code).toMatch(ERROR_CODE);
  });

  it("ends stderr with a newline so a terminal does not glue on the next line", () => {
    expect(runCli(["frobnicate"]).stderr.endsWith("\n")).toBe(true);
  });
});

describe("runCli explain", () => {
  it("wires settings + spec + matcher and prints the firing set with layer, file, and line", () => {
    const result = runCli(
      ["explain", "PreToolUse", "Bash"],
      "hookassert",
      explainDeps(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("[project]");
    expect(result.stdout).toContain(`${PROJECT_SETTINGS_FILE}:7`);
    expect(result.stdout).toContain("./scripts/guard.sh");
  });

  it("prints a non-firing matcher's MatcherOutcome reason", () => {
    const result = runCli(
      ["explain", "PreToolUse", "Bash"],
      "hookassert",
      explainDeps(),
    );

    expect(result.stdout).toContain(`${PROJECT_SETTINGS_FILE}:16`);
    expect(result.stdout).toContain("./scripts/write-guard.sh");
    expect(result.stdout).toContain(
      "evaluated as an exact-match list and did not match Bash",
    );
  });

  it("prints 'undetermined' when no Claude Code version can be resolved", () => {
    const result = runCli(
      ["explain", "PreToolUse", "Bash"],
      "hookassert",
      explainDeps(),
    );

    expect(result.stdout).toContain("Claude Code version: undetermined");
  });

  it("prints the resolved Claude Code version when one is known", () => {
    const result = runCli(
      ["explain", "PreToolUse", "Bash", "--claude-version", "2.1.300"],
      "hookassert",
      explainDeps(),
    );

    expect(result.stdout).toContain("Claude Code version: 2.1.300");
  });

  it("always prints the spec's declared claudeCodeRange", () => {
    const result = runCli(
      ["explain", "PreToolUse", "Bash"],
      "hookassert",
      explainDeps(),
    );

    expect(result.stdout).toContain(`Spec range: ${SPEC_RANGE}`);
  });

  it("--claude-version overrides HOOKASSERT_CLAUDE_VERSION", () => {
    const result = runCli(
      ["explain", "PreToolUse", "Bash", "--claude-version", "2.1.300"],
      "hookassert",
      explainDeps({ env: { HOOKASSERT_CLAUDE_VERSION: "2.1.260" } }),
    );

    expect(result.stdout).toContain("Claude Code version: 2.1.300");
    expect(result.stdout).not.toContain("2.1.260");
  });

  it("uses HOOKASSERT_CLAUDE_VERSION when --claude-version is absent", () => {
    const result = runCli(
      ["explain", "PreToolUse", "Bash"],
      "hookassert",
      explainDeps({ env: { HOOKASSERT_CLAUDE_VERSION: "2.1.280" } }),
    );

    expect(result.stdout).toContain("Claude Code version: 2.1.280");
  });

  it("exits 4 with ERR_USAGE when explain is given an unrecognized option", () => {
    const result = runCli(["explain", "--bogus"], "hookassert", explainDeps());

    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ERR_USAGE");
  });

  it("exits 4 with ERR_USAGE when <event> is missing", () => {
    const result = runCli(["explain"], "hookassert", explainDeps());

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("ERR_USAGE");
    expect(result.stderr).toContain("<event>");
  });

  it("exits 4 with ERR_USAGE when <event> is not a documented Claude Code event", () => {
    const result = runCli(["explain", "NotARealEvent"], "hookassert", explainDeps());

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("ERR_USAGE");
    expect(result.stderr).toContain("NotARealEvent");
  });

  it("treats a set-but-empty HOOKASSERT_CLAUDE_VERSION as no version at all", () => {
    // A CI job that declares the variable without a value, or an
    // `export HOOKASSERT_CLAUDE_VERSION="$(… || true)"` that produced
    // nothing, must fall back to "undetermined" rather than failing the run.
    const result = runCli(
      ["explain", "PreToolUse", "Bash"],
      "hookassert",
      explainDeps({ env: { HOOKASSERT_CLAUDE_VERSION: "" } }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Claude Code version: undetermined");
  });

  it("names HOOKASSERT_CLAUDE_VERSION when the invalid version came from it", () => {
    const result = runCli(
      ["explain", "PreToolUse", "Bash"],
      "hookassert",
      explainDeps({ env: { HOOKASSERT_CLAUDE_VERSION: "not-a-version" } }),
    );

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("HOOKASSERT_CLAUDE_VERSION");
  });

  it("exits 4 with ERR_USAGE on an unexpected extra positional argument", () => {
    // `--settings a.json b.json` parses as one settings file plus a stray
    // positional; accepting it silently would make `b.json` the matcher
    // target and report a wrong firing set at exit 0.
    const result = runCli(
      ["explain", "PreToolUse", "Bash", "Write"],
      "hookassert",
      explainDeps(),
    );

    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ERR_USAGE");
    expect(result.stderr).toContain("Write");
  });

  it("exits 4 with ERR_USAGE when --claude-version is not major.minor.patch", () => {
    const result = runCli(
      ["explain", "PreToolUse", "Bash", "--claude-version", "not-a-version"],
      "hookassert",
      explainDeps(),
    );

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("ERR_USAGE");
  });

  it("performs exactly zero spawns", () => {
    const spawner = new CountingSpawner();
    const result = runCli(
      ["explain", "PreToolUse", "Bash"],
      "hookassert",
      explainDeps({ spawner }),
    );

    expect(result.exitCode).toBe(0);
    expect(spawner.calls).toHaveLength(0);
  });

  it("accepts --format pretty explicitly", () => {
    const result = runCli(
      ["explain", "PreToolUse", "Bash", "--format", "pretty"],
      "hookassert",
      explainDeps(),
    );

    expect(result.exitCode).toBe(0);
  });

  it.each(["json", "github"])(
    "rejects the %s report format as not implemented yet",
    (format) => {
      const result = runCli(
        ["explain", "PreToolUse", "Bash", "--format", format],
        "hookassert",
        explainDeps(),
      );

      expect(result.exitCode).toBe(4);
      expect(result.stderr).toContain("ERR_USAGE");
      expect(result.stderr).toContain("not implemented yet");
    },
  );

  it("rejects --emit-fixtures as not implemented yet", () => {
    const result = runCli(
      ["explain", "PreToolUse", "Bash", "--emit-fixtures", "/tmp/hookassert-out"],
      "hookassert",
      explainDeps(),
    );

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("ERR_USAGE");
    expect(result.stderr).toContain("--emit-fixtures");
  });

  it("adds an explicit-layer settings file with --settings", () => {
    const result = runCli(
      ["explain", "PreToolUse", "Bash", "--settings", EXPLICIT_SETTINGS_FILE],
      "hookassert",
      explainDeps({ cwd: NO_SUCH_DIR }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[explicit]");
    expect(result.stdout).toContain("./scripts/explicit-guard.sh");
  });

  it("fails with ERR_SETTINGS_NOT_FOUND when a --settings file does not exist", () => {
    // A missing *discovered* layer is not an error, but a file the caller
    // named is: without this, a typo prints "Firing hooks: none" at exit 0 —
    // a confident wrong answer from the command whose whole job is saying
    // which hooks fire.
    const result = runCli(
      ["explain", "PreToolUse", "Bash", "--settings", "no-such-settings.json"],
      "hookassert",
      explainDeps({ cwd: PROJECT_WITH_HOOKS_DIR }),
    );

    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("ERR_SETTINGS_NOT_FOUND");
    expect(result.stdout).toBe("");
  });

  it("keeps a missing discovered settings layer lenient", () => {
    // The mirror of the case above: discovery naming a file that does not
    // exist stays a zero-hook contribution, so the strictness added for
    // --settings must not leak into the three well-known layers.
    const result = runCli(
      ["explain", "PreToolUse", "Bash"],
      "hookassert",
      explainDeps({ cwd: NO_SUCH_DIR }),
    );

    expect(result.exitCode).toBe(0);
  });

  it("rethrows a non-HookassertError rather than reporting it as a usage failure", () => {
    // Passing a directory as --settings makes readFileSync fail with a plain
    // EISDIR Error, not one of loadSourceHooks' own recognized cases — this
    // proves runCli only turns a HookassertError into a graceful CliResult
    // and lets anything else propagate rather than mislabeling it.
    expect(() =>
      runCli(
        ["explain", "PreToolUse", "Bash", "--settings", PROJECT_WITH_HOOKS_DIR],
        "hookassert",
        explainDeps(),
      ),
    ).toThrow(/EISDIR/);
  });
});

describe("createUnimplementedSpawner", () => {
  it("rejects every call, as a placeholder until a real Spawner lands", async () => {
    const spawner = createUnimplementedSpawner();

    await expect(
      spawner.spawn({
        form: "exec",
        command: "true",
        args: [],
        cwd: "/",
        env: {},
        stdin: "",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/spawning is not implemented yet/);
  });
});

describe("main", () => {
  /** Capture the two streams at the process boundary, the only mock here. */
  function captureStreams(): { stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    return { stdout, stderr };
  }

  it("writes the usage text to stdout and returns 0 for --help", () => {
    const streams = captureStreams();
    expect(main(["--help"])).toBe(0);
    expect(streams.stdout.join("")).toContain("Usage: hookassert <command> [options]");
    expect(streams.stderr.join("")).toBe("");
  });

  it("writes a usage error to stderr and returns its exit code", () => {
    const streams = captureStreams();
    expect(main(["frobnicate"])).toBe(4);
    expect(streams.stdout.join("")).toBe("");
    expect(streams.stderr.join("")).toContain("ERR_USAGE");
  });
});

describe("isMain", () => {
  it("recognizes nothing when the module is not the process entry point", () => {
    // Vitest's own runner is `process.argv[1]` here, so this is the negative
    // case; it also exercises the unresolvable-path fallback, since the module
    // named below does not exist on disk.
    expect(isMain(pathToFileURL("/nonexistent/hookassert/cli.js").href)).toBe(false);
  });

  it("recognizes the module Node was actually started with", () => {
    const entry = process.argv[1];
    if (entry === undefined) {
      throw new Error("the test runner should always be process.argv[1]");
    }
    expect(isMain(pathToFileURL(entry).href)).toBe(true);
  });
});
