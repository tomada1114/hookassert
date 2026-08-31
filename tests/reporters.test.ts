import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { UsageError } from "../src/internal/errors.js";
import { createUnimplementedSpawner } from "../src/internal/exec/spawner.js";
import type { MatcherOutcome } from "../src/internal/matcher/index.js";
import {
  isReportFormat,
  relativizeForGithub,
  renderGithub,
  renderGithubFinding,
  renderGithubHeader,
  renderInFormat,
  renderJson,
  renderPretty,
  toJsonReport,
  type ExplainReport,
  type FormatRenderers,
  type ReportFinding,
} from "../src/internal/report/index.js";
import { hooksForEvent, loadSettings } from "../src/internal/settings/index.js";
import type { Provenance, ResolvedHook } from "../src/types.js";

// Reaching src/internal/report/, src/internal/matcher/,
// src/internal/settings/ and src/internal/exec/ directly (rather than through
// src/index.ts's exports, per the writing-tests skill) is a deliberate,
// narrowly scoped
// exception: none of these modules has a public surface in this issue and
// never will one for its own plumbing types — see eslint.config.mjs's
// "tests/static-layer-unit-tests" block for the full reasoning.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCHEMA_PATH = path.join(REPO_ROOT, "schema", "report.schema.json");
const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/cli/", import.meta.url));
const PROJECT_WITH_HOOKS_DIR = path.join(FIXTURES_DIR, "project-with-hooks");
const PROJECT_SETTINGS_FILE = path.join(
  PROJECT_WITH_HOOKS_DIR,
  ".claude",
  "settings.json",
);
const SETTINGS_FIXTURES_DIR = fileURLToPath(
  new URL("./fixtures/settings/", import.meta.url),
);

/** The shipped spec's own declared range, from `spec/claude-code-2.1.251-2.2.0.json`. */
const SPEC_RANGE = ">=2.1.251 <2.2.0";

function readSchema(): unknown {
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as unknown;
}

function makeProvenance(overrides: Partial<Provenance> = {}): Provenance {
  return {
    file: "/abs/project/.claude/settings.json",
    layer: "project",
    line: 7,
    col: 11,
    offset: 100,
    ...overrides,
  };
}

function makeHook(overrides: Partial<ResolvedHook> = {}): ResolvedHook {
  return {
    event: "PreToolUse",
    matcher: "Bash",
    command: "./scripts/guard.sh",
    args: undefined,
    timeoutMs: undefined,
    provenance: makeProvenance(),
    dedupeKey: '["PreToolUse","Bash","./scripts/guard.sh"]',
    ...overrides,
  };
}

function baseReport(overrides: Partial<ExplainReport> = {}): ExplainReport {
  return {
    header: { claudeVersion: "2.1.300", specRange: SPEC_RANGE, notices: [] },
    event: "PreToolUse",
    target: "Bash",
    firing: [],
    matcherIgnored: [],
    rejected: [],
    ...overrides,
  };
}

/** Load the real hooks declared in `tests/fixtures/cli/project-with-hooks`. */
function loadFixtureHooks(): readonly ResolvedHook[] {
  const settings = loadSettings([{ path: PROJECT_SETTINGS_FILE, layer: "project" }]);
  return hooksForEvent(settings, "PreToolUse");
}

/** Find a hook by its declared `matcher`, failing loudly if the fixture ever drops it. */
function requireHookByMatcher(
  hooks: readonly ResolvedHook[],
  matcher: string,
): ResolvedHook {
  const hook = hooks.find((candidate) => candidate.matcher === matcher);
  if (hook === undefined) {
    throw new Error(
      `fixture has no hook declared with matcher ${JSON.stringify(matcher)}`,
    );
  }
  return hook;
}

// --- renderJson --------------------------------------------------------------

describe("renderJson", () => {
  it("validates against schema/report.schema.json for a representative report", () => {
    const hook = makeHook();
    const rejected: MatcherOutcome = {
      hook: makeHook({ matcher: "Write", command: "./scripts/write-guard.sh" }),
      kind: "exact-list",
      reason: "evaluated as an exact-match list and did not match Bash",
    };
    const report = baseReport({
      header: {
        claudeVersion: "2.1.300",
        specRange: SPEC_RANGE,
        notices: ["plugin hooks detected: /abs/plugin/hooks.json"],
      },
      firing: [hook],
      matcherIgnored: [hook],
      rejected: [rejected],
    });

    const parsed: unknown = JSON.parse(renderJson(report));

    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(readSchema() as object);
    expect(validate(parsed)).toBe(true);
  });

  it("rejects a report shape ajv should reject: missing reportVersion", () => {
    const report = baseReport();
    const parsed = JSON.parse(renderJson(report)) as Record<string, unknown>;
    delete parsed["reportVersion"];

    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(readSchema() as object);
    expect(validate(parsed)).toBe(false);
  });

  it("stays schema-valid for a negative or fractional timeoutMs, since settings/load.ts does not reject either", () => {
    // A settings file's `timeout` is an arbitrary JSON number multiplied by
    // 1000; nothing in the pipeline rejects a negative or fractional value.
    // The schema must describe what the tool can actually emit, not what a
    // well-behaved settings file would contain.
    const settings = loadSettings([
      {
        path: path.join(
          SETTINGS_FIXTURES_DIR,
          "with-negative-and-fractional-timeout",
          "project.json",
        ),
        layer: "project",
      },
    ]);
    const hooks = hooksForEvent(settings, "PreToolUse");
    expect(hooks.map((hook) => hook.timeoutMs)).toEqual([-1000, 0.5]);

    const report = baseReport({ firing: hooks });
    const parsed: unknown = JSON.parse(renderJson(report));

    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(readSchema() as object);
    expect(validate(parsed)).toBe(true);
  });

  it("includes the detected version, spec range, and incompleteness notices as data fields", () => {
    const report = baseReport({
      header: {
        claudeVersion: "2.1.300",
        specRange: SPEC_RANGE,
        notices: ["managed settings assumed: /etc/claude-code/managed-settings.json"],
      },
    });

    const parsed = toJsonReport(report);

    expect(parsed.header.claudeVersion).toBe("2.1.300");
    expect(parsed.header.specRange).toBe(SPEC_RANGE);
    expect(parsed.header.notices).toEqual([
      "managed settings assumed: /etc/claude-code/managed-settings.json",
    ]);
  });

  it("carries an undetermined version as the literal string, not a null", () => {
    const report = baseReport({
      header: { claudeVersion: "undetermined", specRange: SPEC_RANGE, notices: [] },
    });

    expect(toJsonReport(report).header.claudeVersion).toBe("undetermined");
  });

  it("marks a firing hook's matcherIgnored field true only when it was actually ignored", () => {
    const ignoredHook = makeHook({ matcher: "anything" });
    const plainHook = makeHook({ command: "./scripts/other.sh" });
    const report = baseReport({
      firing: [ignoredHook, plainHook],
      matcherIgnored: [ignoredHook],
    });

    const parsed = toJsonReport(report);

    expect(parsed.firing).toHaveLength(2);
    expect(parsed.firing[0]?.matcherIgnored).toBe(true);
    expect(parsed.firing[1]?.matcherIgnored).toBe(false);
  });

  it("serializes an absent matcher, args, and timeoutMs as null rather than omitting them", () => {
    const hook = makeHook({
      matcher: undefined,
      args: undefined,
      timeoutMs: undefined,
    });
    const report = baseReport({ firing: [hook] });

    const parsed = toJsonReport(report);

    expect(parsed.firing[0]?.matcher).toBeNull();
    expect(parsed.firing[0]?.args).toBeNull();
    expect(parsed.firing[0]?.timeoutMs).toBeNull();
  });

  it("serializes a missing matcher target as null rather than omitting it", () => {
    const report = baseReport({ target: undefined });

    expect(toJsonReport(report).target).toBeNull();
  });
});

// --- github: relativizeForGithub ---------------------------------------------

describe("relativizeForGithub", () => {
  it("makes an absolute path relative to the workspace root", () => {
    expect(relativizeForGithub(PROJECT_SETTINGS_FILE, PROJECT_WITH_HOOKS_DIR)).toBe(
      ".claude/settings.json",
    );
  });

  it("leaves an already-relative path untouched", () => {
    expect(relativizeForGithub(".claude/settings.json", PROJECT_WITH_HOOKS_DIR)).toBe(
      ".claude/settings.json",
    );
  });

  it("normalizes a Windows-style backslash separator to a forward slash", () => {
    expect(relativizeForGithub("nested\\settings.json", "/workspace")).toBe(
      "nested/settings.json",
    );
  });

  it("makes a Windows absolute path relative to a Windows workspace root", () => {
    expect(relativizeForGithub("C:\\repo\\.claude\\settings.json", "C:\\repo")).toBe(
      ".claude/settings.json",
    );
  });

  it("handles a Windows workspace root with a trailing separator", () => {
    expect(relativizeForGithub("C:\\repo\\.claude\\settings.json", "C:\\repo\\")).toBe(
      ".claude/settings.json",
    );
  });

  it("matches a Windows path against its root case-insensitively", () => {
    expect(relativizeForGithub("c:\\Repo\\.claude\\settings.json", "C:\\repo")).toBe(
      ".claude/settings.json",
    );
  });
});

// --- github: renderGithubFinding ----------------------------------------------

describe("renderGithubFinding", () => {
  it("emits ::error file=<path>,line=<line>,title=<rule or case>::<message> using the hook's own Provenance for a known fixture", () => {
    const bashHook = requireHookByMatcher(loadFixtureHooks(), "Bash");

    const finding: ReportFinding = {
      file: bashHook.provenance.file,
      line: bashHook.provenance.line,
      title: "guard-hook-missing",
      message: "expected the guard hook to block Bash, but no hook fired",
    };

    const output = renderGithubFinding(finding, PROJECT_WITH_HOOKS_DIR);

    expect(output).toBe(
      "::error file=.claude/settings.json,line=7," +
        "title=guard-hook-missing::expected the guard hook to block Bash, but no hook fired",
    );
  });

  it("escapes a comma, colon, and newline the workflow-command parser treats specially", () => {
    const output = renderGithubFinding(
      { file: "a,b:c.json", line: 1, title: "r:1,2", message: "line one\nline two" },
      "/repo",
    );

    expect(output).toBe(
      "::error file=a%2Cb%3Ac.json,line=1,title=r%3A1%2C2::line one%0Aline two",
    );
  });

  it("the emitted line number matches the settings file's actual declaration line, not an approximation", () => {
    const hooks = loadFixtureHooks();
    const bashHook = requireHookByMatcher(hooks, "Bash");
    const writeHook = requireHookByMatcher(hooks, "Write");

    // Independently verify against the fixture's own text, rather than
    // trusting the loader's own computed offset math: the reported line must
    // be the opening `{` of the hook's own object, two lines above its own
    // `command` (the intervening line is that object's `"type": "command"`).
    const lines = readFileSync(PROJECT_SETTINGS_FILE, "utf8").split("\n");
    const bashLine = lines[bashHook.provenance.line - 1];
    const bashCommandLine = lines[bashHook.provenance.line + 1];
    expect(bashLine?.trim()).toBe("{");
    expect(bashCommandLine).toContain('"command": "./scripts/guard.sh"');
    expect(bashHook.provenance.line).toBe(7);

    const writeLine = lines[writeHook.provenance.line - 1];
    const writeCommandLine = lines[writeHook.provenance.line + 1];
    expect(writeLine?.trim()).toBe("{");
    expect(writeCommandLine).toContain('"command": "./scripts/write-guard.sh"');
    expect(writeHook.provenance.line).toBe(16);

    const output = renderGithubFinding(
      {
        file: writeHook.provenance.file,
        line: writeHook.provenance.line,
        title: "case",
        message: "message",
      },
      PROJECT_WITH_HOOKS_DIR,
    );
    expect(output).toContain("line=16,");
  });
});

// --- github: renderGithubHeader / renderGithub --------------------------------

describe("renderGithubHeader", () => {
  it("carries the version, spec range, and notices in one leading informational line", () => {
    const line = renderGithubHeader({
      claudeVersion: "2.1.300",
      specRange: SPEC_RANGE,
      notices: ["plugin hooks detected: /abs/plugin/hooks.json"],
    });

    expect(line).toBe(
      `::notice title=hookassert::Claude Code version: 2.1.300; Spec range: ${SPEC_RANGE}; ` +
        "Notices: plugin hooks detected: /abs/plugin/hooks.json",
    );
  });

  it("omits the Notices segment entirely when there are none", () => {
    const line = renderGithubHeader({
      claudeVersion: "undetermined",
      specRange: SPEC_RANGE,
      notices: [],
    });

    expect(line).not.toContain("Notices");
  });
});

describe("renderGithub", () => {
  it("prints the header line even when there is nothing to flag", () => {
    const output = renderGithub(baseReport());

    expect(output).toContain("::notice title=hookassert::");
    expect(output).toContain("Claude Code version: 2.1.300");
    expect(output.endsWith("\n")).toBe(true);
  });
});

// --- format selection ---------------------------------------------------------

describe("isReportFormat", () => {
  it.each(["pretty", "json", "github"])("accepts %s", (format) => {
    expect(isReportFormat(format)).toBe(true);
  });

  it.each(["", "Pretty", "yaml", "xml"])("rejects %s", (format) => {
    expect(isReportFormat(format)).toBe(false);
  });
});

describe("renderInFormat", () => {
  function renderers(): FormatRenderers<ExplainReport> {
    return { pretty: renderPretty, json: renderJson, github: renderGithub };
  }

  it("defaults to pretty when format is undefined", () => {
    const report = baseReport();
    expect(renderInFormat(report, undefined, renderers())).toBe(renderPretty(report));
  });

  it.each(["pretty", "json", "github"] as const)(
    "routes %s to its own renderer",
    (format) => {
      const report = baseReport();
      const expected = { pretty: renderPretty, json: renderJson, github: renderGithub }[
        format
      ](report);

      expect(renderInFormat(report, format, renderers())).toBe(expected);
    },
  );

  it("throws a UsageError with the ERR_USAGE code for an unrecognized format", () => {
    expect(() => renderInFormat(baseReport(), "yaml", renderers())).toThrow(UsageError);

    let caught: unknown;
    try {
      renderInFormat(baseReport(), "yaml", renderers());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as UsageError).code).toBe("ERR_USAGE");
  });

  it("names the rejected value in the thrown error's message", () => {
    let caught: unknown;
    try {
      renderInFormat(baseReport(), "yaml", renderers());
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toContain("yaml");
  });
});

describe("--format selects the correct reporter uniformly for explain", () => {
  function explainDeps() {
    return {
      cwd: PROJECT_WITH_HOOKS_DIR,
      home: path.join(FIXTURES_DIR, "no-such-directory"),
      env: {},
    };
  }

  it("--format pretty prints free-text output", async () => {
    const result = await runCli(
      ["explain", "PreToolUse", "Bash", "--format", "pretty"],
      "hookassert",
      explainDeps(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Claude Code version:");
    expect(() => {
      JSON.parse(result.stdout);
    }).toThrow();
  });

  it("--format json prints a schema-valid JSON document", async () => {
    const result = await runCli(
      ["explain", "PreToolUse", "Bash", "--format", "json"],
      "hookassert",
      explainDeps(),
    );

    expect(result.exitCode).toBe(0);
    const parsed: unknown = JSON.parse(result.stdout);
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(readSchema() as object);
    expect(validate(parsed)).toBe(true);
  });

  it("--format github prints a GitHub Actions workflow-command line", async () => {
    const result = await runCli(
      ["explain", "PreToolUse", "Bash", "--format", "github"],
      "hookassert",
      explainDeps(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::notice title=hookassert::");
  });

  // FOLLOW-UPS: `lint` does not exist yet (#13). Once it lands and wires
  // --format through renderInFormat, that issue must extend this same
  // uniform-selection assertion to its own subcommand.
});

describe("--format selects the correct reporter uniformly for test", () => {
  const NO_OP_FIXTURE = path.join(FIXTURES_DIR, "test-no-op.yaml");

  function testDeps() {
    return {
      cwd: PROJECT_WITH_HOOKS_DIR,
      home: path.join(FIXTURES_DIR, "no-such-directory"),
      env: {},
      // `runCli`'s own default is the real `NodeSpawner`. This suite lives in
      // the fast unit project and must never launch a process — including
      // `NodeVersionProbe`'s `claude --version`, which would otherwise really
      // run on a machine that has Claude Code installed.
      spawner: createUnimplementedSpawner(),
    };
  }

  // The fixture case here declares an event with no configured hook at all
  // (`SessionEnd`, absent from `PROJECT_WITH_HOOKS_DIR`'s settings) and no
  // `expect`, so the run spawns nothing and needs no consent — keeping this
  // suite in the fast unit project rather than `automationTests`.

  it("--format pretty prints free-text output", async () => {
    const result = await runCli(
      ["test", NO_OP_FIXTURE, "--ci", "--format", "pretty"],
      "hookassert",
      testDeps(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Claude Code version:");
    expect(() => {
      JSON.parse(result.stdout);
    }).toThrow();
  });

  it("--format json prints a JSON document", async () => {
    const result = await runCli(
      ["test", NO_OP_FIXTURE, "--ci", "--format", "json"],
      "hookassert",
      testDeps(),
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { reportVersion: string };
    expect(parsed.reportVersion).toBe("1");
  });

  it("--format github prints a GitHub Actions workflow-command line", async () => {
    const result = await runCli(
      ["test", NO_OP_FIXTURE, "--ci", "--format", "github"],
      "hookassert",
      testDeps(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::notice title=hookassert::");
  });
});

// --- header parity across formats ---------------------------------------------

describe("header content is substantively equivalent across pretty, json, and github", () => {
  it("carries the same version, spec range, and notices in all three formats", () => {
    const report = baseReport({
      header: {
        claudeVersion: "2.1.300",
        specRange: SPEC_RANGE,
        notices: ["plugin hooks detected: /abs/plugin/hooks.json"],
      },
    });

    const pretty = renderPretty(report);
    const json = toJsonReport(report);
    const github = renderGithub(report);

    expect(pretty).toContain("Claude Code version: 2.1.300");
    expect(pretty).toContain(`Spec range: ${SPEC_RANGE}`);
    expect(pretty).toContain("Notice: plugin hooks detected: /abs/plugin/hooks.json");

    expect(json.header.claudeVersion).toBe("2.1.300");
    expect(json.header.specRange).toBe(SPEC_RANGE);
    expect(json.header.notices).toEqual([
      "plugin hooks detected: /abs/plugin/hooks.json",
    ]);

    expect(github).toContain("Claude Code version: 2.1.300");
    expect(github).toContain(`Spec range: ${SPEC_RANGE}`);
    expect(github).toContain("plugin hooks detected: /abs/plugin/hooks.json");
  });

  it("carries 'undetermined' consistently when no version was resolved", () => {
    const report = baseReport({
      header: { claudeVersion: "undetermined", specRange: SPEC_RANGE, notices: [] },
    });

    expect(renderPretty(report)).toContain("Claude Code version: undetermined");
    expect(toJsonReport(report).header.claudeVersion).toBe("undetermined");
    expect(renderGithub(report)).toContain("Claude Code version: undetermined");
  });
});
