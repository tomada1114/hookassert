import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { isMain, main, runCli, type CliDeps } from "../src/cli.js";
import { createUnimplementedSpawner } from "../src/internal/exec/spawner.js";
import type { Spawner, SpawnRequest } from "../src/internal/exec/spawner.js";
import type { ExecOutcome } from "../src/types.js";

// Reaching src/internal/exec/spawner.ts directly (rather than through
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
const LINT_VIOLATING_FIXTURE = fileURLToPath(
  new URL("./fixtures/lint/matcher-is-array/violating.json", import.meta.url),
);
/** Declares a single bare-word command (`hookassert-test-tool`), resolvable only via a caller-supplied `PATH`. */
const LINT_PATH_FIXTURE = fileURLToPath(
  new URL("./fixtures/cli/lint-path/settings.json", import.meta.url),
);
/** The directory `LINT_PATH_FIXTURE`'s own command actually lives in. */
const LINT_PATH_BIN_DIR = fileURLToPath(
  new URL("./fixtures/cli/lint-path/bin/", import.meta.url),
);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

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
    specPath: overrides.specPath ?? explainDefaultSpecPath(),
    isTTY: overrides.isTTY ?? false,
    confirm: overrides.confirm ?? (() => Promise.resolve(false)),
  };
}

/** The shipped spec path, resolved the same way `src/cli.ts` resolves its own default. */
function explainDefaultSpecPath(): string {
  return fileURLToPath(
    new URL("../spec/claude-code-2.1.251-2.2.0.json", import.meta.url),
  );
}

/** The commands hookassert will ship, in the order the usage text lists them. */
const SUBCOMMANDS = ["explain", "lint", "record", "test"] as const;

/** The commands with no behavior yet — `explain`, `lint`, and `test` are all real now. */
const STUB_SUBCOMMANDS = ["record"] as const;

/** The `ERR_` shape AGENTS.md fixes for every published error code. */
const ERROR_CODE = /^ERR_[A-Z0-9_]+$/;

/** First stderr line, minus the trailing newline. */
function firstLine(stderr: string): string {
  return stderr.split("\n")[0] ?? "";
}

describe("runCli help", () => {
  it("--help still exits 0 and prints the usage line", async () => {
    const result = await runCli(["--help"], "my-tool");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: my-tool <command> [options]");
  });

  it.each(SUBCOMMANDS)(
    "--help lists the %s command in the usage text",
    async (name) => {
      expect((await runCli(["--help"])).stdout).toContain(`  ${name}`);
    },
  );

  it("returns help on the short help flag", async () => {
    const result = await runCli(["-h"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: hookassert <command> [options]");
    expect(result.stderr).toBe("");
  });

  it("prefers help over dispatch when a command is also given", async () => {
    // `hookassert explain --help` asks about `explain`; until explain exists,
    // the general usage text is the honest answer, and it must not be an error.
    const result = await runCli(["explain", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("exits 0 with the usage text when given no arguments", async () => {
    // Deliberate: a bare invocation stays exit 0, as it was before subcommand
    // dispatch existed. Only the empty stdout changes — printing the commands
    // is what a reader of a bare `hookassert` actually needs.
    const result = await runCli([], "my-tool");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: my-tool <command> [options]");
  });
});

describe("runCli dispatch", () => {
  it("exits 4 with ERR_USAGE when the subcommand is unrecognized", async () => {
    const result = await runCli(["frobnicate"], "my-tool");
    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe("");
    expect(firstLine(result.stderr)).toBe(
      'my-tool: ERR_USAGE: unknown command "frobnicate". ' +
        "Expected one of: explain, lint, record, test.",
    );
  });

  it("treats a leading option as an unknown command rather than ignoring it", async () => {
    // Nothing parses options yet, so `--json` reaching dispatch must fail
    // loudly instead of silently selecting no command.
    const result = await runCli(["--json"]);
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain('unknown command "--json"');
  });

  it.each(STUB_SUBCOMMANDS)(
    "exits 4 with a not-yet-implemented message for %s",
    async (name) => {
      const result = await runCli([name], "my-tool");
      expect(result.exitCode).toBe(4);
      expect(result.stdout).toBe("");
      expect(firstLine(result.stderr)).toBe(
        `my-tool: ERR_USAGE: the "${name}" command is not implemented yet.`,
      );
    },
  );

  it("points at the help flag on every usage error", async () => {
    expect((await runCli(["frobnicate"], "my-tool")).stderr).toContain(
      "Run `my-tool --help` for usage.",
    );
  });

  it("reports a usage error with an ERR_-prefixed code", async () => {
    // The code is the contract a CI log or a wrapper script branches on; the
    // prose after it is not. See the `designing-errors` skill.
    const code = /^[^:]+: (\S+):/.exec(
      firstLine((await runCli(["frobnicate"])).stderr),
    )?.[1];
    expect(code).toMatch(ERROR_CODE);
  });

  it("ends stderr with a newline so a terminal does not glue on the next line", async () => {
    expect((await runCli(["frobnicate"])).stderr.endsWith("\n")).toBe(true);
  });
});

describe("runCli explain", () => {
  it("wires settings + spec + matcher and prints the firing set with layer, file, and line", async () => {
    const result = await runCli(
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

  it("prints a non-firing matcher's MatcherOutcome reason", async () => {
    const result = await runCli(
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

  it("prints 'undetermined' when no Claude Code version can be resolved", async () => {
    const result = await runCli(
      ["explain", "PreToolUse", "Bash"],
      "hookassert",
      explainDeps(),
    );

    expect(result.stdout).toContain("Claude Code version: undetermined");
  });

  it("prints the resolved Claude Code version when one is known", async () => {
    const result = await runCli(
      ["explain", "PreToolUse", "Bash", "--claude-version", "2.1.300"],
      "hookassert",
      explainDeps(),
    );

    expect(result.stdout).toContain("Claude Code version: 2.1.300");
  });

  it("always prints the spec's declared claudeCodeRange", async () => {
    const result = await runCli(
      ["explain", "PreToolUse", "Bash"],
      "hookassert",
      explainDeps(),
    );

    expect(result.stdout).toContain(`Spec range: ${SPEC_RANGE}`);
  });

  it("--claude-version overrides HOOKASSERT_CLAUDE_VERSION", async () => {
    const result = await runCli(
      ["explain", "PreToolUse", "Bash", "--claude-version", "2.1.300"],
      "hookassert",
      explainDeps({ env: { HOOKASSERT_CLAUDE_VERSION: "2.1.260" } }),
    );

    expect(result.stdout).toContain("Claude Code version: 2.1.300");
    expect(result.stdout).not.toContain("2.1.260");
  });

  it("uses HOOKASSERT_CLAUDE_VERSION when --claude-version is absent", async () => {
    const result = await runCli(
      ["explain", "PreToolUse", "Bash"],
      "hookassert",
      explainDeps({ env: { HOOKASSERT_CLAUDE_VERSION: "2.1.280" } }),
    );

    expect(result.stdout).toContain("Claude Code version: 2.1.280");
  });

  it("exits 4 with ERR_USAGE when explain is given an unrecognized option", async () => {
    const result = await runCli(["explain", "--bogus"], "hookassert", explainDeps());

    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ERR_USAGE");
  });

  it("exits 4 with ERR_USAGE when <event> is missing", async () => {
    const result = await runCli(["explain"], "hookassert", explainDeps());

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("ERR_USAGE");
    expect(result.stderr).toContain("<event>");
  });

  it("exits 4 with ERR_USAGE when <event> is not a documented Claude Code event", async () => {
    const result = await runCli(
      ["explain", "NotARealEvent"],
      "hookassert",
      explainDeps(),
    );

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("ERR_USAGE");
    expect(result.stderr).toContain("NotARealEvent");
  });

  it("treats a set-but-empty HOOKASSERT_CLAUDE_VERSION as no version at all", async () => {
    // A CI job that declares the variable without a value, or an
    // `export HOOKASSERT_CLAUDE_VERSION="$(… || true)"` that produced
    // nothing, must fall back to "undetermined" rather than failing the run.
    const result = await runCli(
      ["explain", "PreToolUse", "Bash"],
      "hookassert",
      explainDeps({ env: { HOOKASSERT_CLAUDE_VERSION: "" } }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Claude Code version: undetermined");
  });

  it("names HOOKASSERT_CLAUDE_VERSION when the invalid version came from it", async () => {
    const result = await runCli(
      ["explain", "PreToolUse", "Bash"],
      "hookassert",
      explainDeps({ env: { HOOKASSERT_CLAUDE_VERSION: "not-a-version" } }),
    );

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("HOOKASSERT_CLAUDE_VERSION");
  });

  it("exits 4 with ERR_USAGE on an unexpected extra positional argument", async () => {
    // `--settings a.json b.json` parses as one settings file plus a stray
    // positional; accepting it silently would make `b.json` the matcher
    // target and report a wrong firing set at exit 0.
    const result = await runCli(
      ["explain", "PreToolUse", "Bash", "Write"],
      "hookassert",
      explainDeps(),
    );

    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ERR_USAGE");
    expect(result.stderr).toContain("Write");
  });

  it("exits 4 with ERR_USAGE when --claude-version is not major.minor.patch", async () => {
    const result = await runCli(
      ["explain", "PreToolUse", "Bash", "--claude-version", "not-a-version"],
      "hookassert",
      explainDeps(),
    );

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("ERR_USAGE");
  });

  it("performs exactly zero spawns", async () => {
    const spawner = new CountingSpawner();
    const result = await runCli(
      ["explain", "PreToolUse", "Bash"],
      "hookassert",
      explainDeps({ spawner }),
    );

    expect(result.exitCode).toBe(0);
    expect(spawner.calls).toHaveLength(0);
  });

  it("accepts --format pretty explicitly", async () => {
    const result = await runCli(
      ["explain", "PreToolUse", "Bash", "--format", "pretty"],
      "hookassert",
      explainDeps(),
    );

    expect(result.exitCode).toBe(0);
  });

  it.each(["json", "github"])("selects the %s reporter", async (format) => {
    const result = await runCli(
      ["explain", "PreToolUse", "Bash", "--format", format],
      "hookassert",
      explainDeps(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("exits 4 with ERR_USAGE for an unrecognized --format value", async () => {
    const result = await runCli(
      ["explain", "PreToolUse", "Bash", "--format", "xml"],
      "hookassert",
      explainDeps(),
    );

    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ERR_USAGE");
    expect(result.stderr).toContain("xml");
  });

  it("rejects an unrecognized --format before a failing --settings path is even checked", async () => {
    // The format must be validated before any I/O: --settings resolution,
    // spec loading, and loadSettings all come later in runExplain, so a
    // failing --settings path must never mask a typo'd --format behind an
    // unrelated ERR_SETTINGS_NOT_FOUND.
    const result = await runCli(
      [
        "explain",
        "PreToolUse",
        "Bash",
        "--format",
        "xml",
        "--settings",
        "no-such-settings.json",
      ],
      "hookassert",
      explainDeps({ cwd: PROJECT_WITH_HOOKS_DIR }),
    );

    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ERR_USAGE");
    expect(result.stderr).toContain("xml");
  });

  it("rejects --emit-fixtures as not implemented yet", async () => {
    const result = await runCli(
      ["explain", "PreToolUse", "Bash", "--emit-fixtures", "/tmp/hookassert-out"],
      "hookassert",
      explainDeps(),
    );

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("ERR_USAGE");
    expect(result.stderr).toContain("--emit-fixtures");
  });

  it("adds an explicit-layer settings file with --settings", async () => {
    const result = await runCli(
      ["explain", "PreToolUse", "Bash", "--settings", EXPLICIT_SETTINGS_FILE],
      "hookassert",
      explainDeps({ cwd: NO_SUCH_DIR }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[explicit]");
    expect(result.stdout).toContain("./scripts/explicit-guard.sh");
  });

  it("fails with ERR_SETTINGS_NOT_FOUND when a --settings file does not exist", async () => {
    // A missing *discovered* layer is not an error, but a file the caller
    // named is: without this, a typo prints "Firing hooks: none" at exit 0 —
    // a confident wrong answer from the command whose whole job is saying
    // which hooks fire.
    const result = await runCli(
      ["explain", "PreToolUse", "Bash", "--settings", "no-such-settings.json"],
      "hookassert",
      explainDeps({ cwd: PROJECT_WITH_HOOKS_DIR }),
    );

    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("ERR_SETTINGS_NOT_FOUND");
    expect(result.stdout).toBe("");
  });

  it("keeps a missing discovered settings layer lenient", async () => {
    // The mirror of the case above: discovery naming a file that does not
    // exist stays a zero-hook contribution, so the strictness added for
    // --settings must not leak into the three well-known layers.
    const result = await runCli(
      ["explain", "PreToolUse", "Bash"],
      "hookassert",
      explainDeps({ cwd: NO_SUCH_DIR }),
    );

    expect(result.exitCode).toBe(0);
  });

  it("rethrows a non-HookassertError rather than reporting it as a usage failure", async () => {
    // Passing a directory as --settings makes readFileSync fail with a plain
    // EISDIR Error, not one of loadSourceHooks' own recognized cases — this
    // proves runCli only turns a HookassertError into a graceful CliResult
    // and lets anything else propagate rather than mislabeling it.
    await expect(
      runCli(
        ["explain", "PreToolUse", "Bash", "--settings", PROJECT_WITH_HOOKS_DIR],
        "hookassert",
        explainDeps(),
      ),
    ).rejects.toThrow(/EISDIR/);
  });
});

describe("runCli lint", () => {
  it("wires settings + spec + rules and exits 0 with zero findings for a clean project", async () => {
    const result = await runCli(["lint"], "hookassert", explainDeps());

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Findings: none");
  });

  it("resolves a bare-word command against CliDeps.env's PATH rather than the host process's own PATH", async () => {
    const withoutTool = await runCli(
      ["lint", "--settings", LINT_PATH_FIXTURE],
      "hookassert",
      explainDeps({ env: {} }),
    );
    expect(withoutTool.exitCode).toBe(1);
    expect(withoutTool.stdout).toContain("command-not-found");
    expect(withoutTool.stdout).toContain("hookassert-test-tool");

    const withTool = await runCli(
      ["lint", "--settings", LINT_PATH_FIXTURE],
      "hookassert",
      explainDeps({ env: { PATH: LINT_PATH_BIN_DIR } }),
    );
    expect(withTool.exitCode).toBe(0);
    expect(withTool.stdout).not.toContain("command-not-found");
  });

  it("exits 1 and reports a Finding for a settings file with a lint violation", async () => {
    const result = await runCli(
      ["lint", "--settings", LINT_VIOLATING_FIXTURE],
      "hookassert",
      explainDeps(),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("matcher-is-array");
    expect(result.stdout).toContain(LINT_VIOLATING_FIXTURE);
  });

  it("accepts --ci and behaves identically to a plain run", async () => {
    const plain = await runCli(["lint"], "hookassert", explainDeps());
    const withCi = await runCli(["lint", "--ci"], "hookassert", explainDeps());

    expect(withCi.exitCode).toBe(plain.exitCode);
    expect(withCi.stdout).toBe(plain.stdout);
    expect(withCi.stderr).toBe(plain.stderr);
  });

  it("accepts --ci alongside a violation the same way a plain run does", async () => {
    const plain = await runCli(
      ["lint", "--settings", LINT_VIOLATING_FIXTURE],
      "hookassert",
      explainDeps(),
    );
    const withCi = await runCli(
      ["lint", "--ci", "--settings", LINT_VIOLATING_FIXTURE],
      "hookassert",
      explainDeps(),
    );

    expect(withCi.exitCode).toBe(plain.exitCode);
    expect(withCi.stdout).toBe(plain.stdout);
  });

  it("always prints the spec's declared claudeCodeRange", async () => {
    const result = await runCli(["lint"], "hookassert", explainDeps());

    expect(result.stdout).toContain(`Spec range: ${SPEC_RANGE}`);
  });

  it("prints 'undetermined' when no Claude Code version can be resolved", async () => {
    const result = await runCli(["lint"], "hookassert", explainDeps());

    expect(result.stdout).toContain("Claude Code version: undetermined");
  });

  it("resolves --claude-version the same way explain does", async () => {
    const result = await runCli(
      ["lint", "--claude-version", "2.1.300"],
      "hookassert",
      explainDeps(),
    );

    expect(result.stdout).toContain("Claude Code version: 2.1.300");
  });

  it("exits 4 with ERR_USAGE when lint is given an unrecognized option", async () => {
    const result = await runCli(["lint", "--bogus"], "hookassert", explainDeps());

    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ERR_USAGE");
  });

  it("exits 4 with ERR_USAGE on a positional argument", async () => {
    const result = await runCli(["lint", "stray"], "hookassert", explainDeps());

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("ERR_USAGE");
    expect(result.stderr).toContain("stray");
  });

  it("exits 4 with ERR_USAGE when --claude-version is not major.minor.patch", async () => {
    const result = await runCli(
      ["lint", "--claude-version", "not-a-version"],
      "hookassert",
      explainDeps(),
    );

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("ERR_USAGE");
  });

  it("exits 5 with ERR_SETTINGS_NOT_FOUND when an explicit --settings file does not exist", async () => {
    const missing = path.join(FIXTURES_DIR, "no-such-settings-file.json");
    const result = await runCli(
      ["lint", "--settings", missing],
      "hookassert",
      explainDeps(),
    );

    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("ERR_SETTINGS_NOT_FOUND");
  });

  it.each(["json", "github"])("selects the %s reporter", async (format) => {
    const result = await runCli(
      ["lint", "--format", format],
      "hookassert",
      explainDeps(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("--format json carries every finding field for a settings file with a violation", async () => {
    const result = await runCli(
      ["lint", "--settings", LINT_VIOLATING_FIXTURE, "--format", "json"],
      "hookassert",
      explainDeps(),
    );

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      readonly reportType: string;
      readonly findings: readonly {
        readonly file: string;
        readonly line: number;
        readonly ruleId: string;
        readonly message: string;
        readonly suggestion: string;
      }[];
    };
    expect(parsed.reportType).toBe("lint");
    const finding = parsed.findings.find((f) => f.ruleId === "matcher-is-array");
    expect(finding?.file).toBe(LINT_VIOLATING_FIXTURE);
    expect(finding?.line).toBe(5);
    expect(finding?.message.length).toBeGreaterThan(0);
    expect(finding?.suggestion.length).toBeGreaterThan(0);
  });

  it("--format github emits one ::error line per finding with a repository-relative path", async () => {
    const result = await runCli(
      ["lint", "--settings", LINT_VIOLATING_FIXTURE, "--format", "github"],
      "hookassert",
      explainDeps({ cwd: REPO_ROOT }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "::error file=tests/fixtures/lint/matcher-is-array/violating.json,line=5," +
        "title=matcher-is-array::",
    );
    // The relative path form only — the absolute fixture path must not leak
    // into a github annotation meant to attach to a line in the PR diff.
    expect(result.stdout).not.toContain(LINT_VIOLATING_FIXTURE);
  });

  it.each(["json", "github"])(
    "--format %s performs exactly zero spawns even when findings are reported",
    async (format) => {
      const spawner = new CountingSpawner();
      const result = await runCli(
        ["lint", "--settings", LINT_VIOLATING_FIXTURE, "--format", format],
        "hookassert",
        explainDeps({ spawner }),
      );
      expect(result.exitCode).toBe(1);
      expect(spawner.calls).toHaveLength(0);
    },
  );

  it("accepts --format pretty explicitly", async () => {
    const result = await runCli(
      ["lint", "--format", "pretty"],
      "hookassert",
      explainDeps(),
    );

    expect(result.exitCode).toBe(0);
  });

  it("exits 4 with ERR_USAGE on an unrecognized --format", async () => {
    const result = await runCli(
      ["lint", "--format", "yaml"],
      "hookassert",
      explainDeps(),
    );

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("ERR_USAGE");
  });

  it("performs exactly zero spawns", async () => {
    const spawner = new CountingSpawner();
    const result = await runCli(["lint"], "hookassert", explainDeps({ spawner }));

    expect(result.exitCode).toBe(0);
    expect(spawner.calls).toHaveLength(0);
  });

  it("performs exactly zero spawns even when findings are reported", async () => {
    const spawner = new CountingSpawner();
    const result = await runCli(
      ["lint", "--settings", LINT_VIOLATING_FIXTURE],
      "hookassert",
      explainDeps({ spawner }),
    );

    expect(result.exitCode).toBe(1);
    expect(spawner.calls).toHaveLength(0);
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

  it("writes the usage text to stdout and returns 0 for --help", async () => {
    const streams = captureStreams();
    expect(await main(["--help"])).toBe(0);
    expect(streams.stdout.join("")).toContain("Usage: hookassert <command> [options]");
    expect(streams.stderr.join("")).toBe("");
  });

  it("writes a usage error to stderr and returns its exit code", async () => {
    const streams = captureStreams();
    expect(await main(["frobnicate"])).toBe(4);
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
