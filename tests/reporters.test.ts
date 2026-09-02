import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv } from "ajv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { UsageError } from "../src/internal/errors.js";
import { createUnimplementedSpawner } from "../src/internal/exec/index.js";
import type { Spawner, SpawnRequest } from "../src/internal/exec/index.js";
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
import type { ExecOutcome, Provenance, ResolvedHook } from "../src/types.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCHEMA_DIR = path.join(REPO_ROOT, "schema");
const EXPLAIN_SCHEMA_PATH = path.join(SCHEMA_DIR, "explain-report.schema.json");
const TEST_SCHEMA_PATH = path.join(SCHEMA_DIR, "test-report.schema.json");
const LINT_SCHEMA_PATH = path.join(SCHEMA_DIR, "lint-report.schema.json");
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
const MINIMAL_SPEC_PATH = fileURLToPath(
  new URL("./fixtures/spec/valid-minimal.json", import.meta.url),
);
const LINT_VIOLATING_FIXTURE = fileURLToPath(
  new URL("./fixtures/lint/matcher-is-array/violating.json", import.meta.url),
);

/** The shipped spec's own declared range, from `spec/claude-code-2.1.251-2.2.0.json`. */
const SPEC_RANGE = ">=2.1.251 <2.2.0";

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

function readSchema(): unknown {
  return readJsonFile(EXPLAIN_SCHEMA_PATH);
}

/** Compile and validate `document` against the schema at `schemaPath`, returning ajv's own verdict. */
function validatesAgainstSchema(schemaPath: string, document: unknown): boolean {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(readJsonFile(schemaPath) as object);
  return validate(document);
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
  it("validates against schema/explain-report.schema.json for a representative report", () => {
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

  it("stays schema-valid for a fractional timeoutMs, since settings/load.ts converts fractional seconds as-is", () => {
    // A settings file's `timeout` is a finite, strictly-positive number of
    // seconds (settings/load.ts rejects zero, negative, and non-finite
    // values at load time); a fractional value such as `0.5` is a
    // meaningful declaration and converts to `timeoutMs: 500` exactly as
    // today. The schema must describe what the tool can actually emit.
    const settings = loadSettings([
      {
        path: path.join(SETTINGS_FIXTURES_DIR, "fractional-timeout", "project.json"),
        layer: "project",
      },
    ]);
    const hooks = hooksForEvent(settings, "PreToolUse");
    expect(hooks.map((hook) => hook.timeoutMs)).toEqual([500]);

    const report = baseReport({ firing: hooks });
    const parsed: unknown = JSON.parse(renderJson(report));

    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(readSchema() as object);
    expect(validate(parsed)).toBe(true);
  });

  it.each([0, -1000])(
    "rejects a report shape ajv should reject: timeoutMs %i, now that the schema requires exclusiveMinimum 0",
    (timeoutMs) => {
      // settings/load.ts can no longer emit a non-positive timeoutMs, but the
      // schema's `exclusiveMinimum: 0` is what actually enforces that going
      // forward — fabricate the shape directly to prove the schema itself
      // rejects it, independent of the loader.
      const report = baseReport({ firing: [makeHook({ timeoutMs })] });
      const parsed: unknown = JSON.parse(renderJson(report));

      const ajv = new Ajv({ allErrors: true, strict: false });
      const validate = ajv.compile(readSchema() as object);
      expect(validate(parsed)).toBe(false);
    },
  );

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

// --- shared $defs stay identical across the three shipped schemas -----------

describe("the three shipped report schemas", () => {
  it("carry an identical copy of every $def more than one of them declares", () => {
    const schemas: Readonly<Record<string, Record<string, unknown>>> = {
      "explain-report.schema.json": readJsonFile(EXPLAIN_SCHEMA_PATH) as Record<
        string,
        unknown
      >,
      "test-report.schema.json": readJsonFile(TEST_SCHEMA_PATH) as Record<
        string,
        unknown
      >,
      "lint-report.schema.json": readJsonFile(LINT_SCHEMA_PATH) as Record<
        string,
        unknown
      >,
    };

    const defsByFile = Object.entries(schemas).map(
      ([name, schema]) => [name, schema["$defs"] as Record<string, unknown>] as const,
    );

    const defNames = new Set(defsByFile.flatMap(([, defs]) => Object.keys(defs)));
    let comparedAtLeastOneSharedDef = false;

    for (const defName of defNames) {
      const owners = defsByFile.filter(([, defs]) => defName in defs);
      if (owners.length < 2) {
        continue;
      }
      comparedAtLeastOneSharedDef = true;
      const [firstOwnerName, firstOwnerDefs] = owners[0] ?? ["", {}];
      for (const [ownerName, ownerDefs] of owners.slice(1)) {
        expect(
          ownerDefs[defName],
          `$defs.${defName} in ${ownerName} must match ${firstOwnerName}`,
        ).toEqual(firstOwnerDefs[defName]);
      }
    }

    // `header` is declared by all three; a false-positive pass (nothing
    // compared because the file names above drifted from the $defs keys
    // below) would otherwise let this test go green for the wrong reason.
    expect(comparedAtLeastOneSharedDef).toBe(true);
    expect(defNames.has("header")).toBe(true);
  });
});

// --- test/lint: schema validation against a real rendering ------------------

/** A canned `ExecOutcome` `ScriptedSpawner` resolves to for one configured `command`. */
interface ScriptedOutcome {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly timedOut?: boolean;
  readonly launchError?: string;
}

/**
 * Resolves every spawn request from a canned lookup keyed by `req.command`,
 * without ever actually spawning a process — this suite lives in the fast
 * unit project and must never launch a real subprocess.
 */
class ScriptedSpawner implements Spawner {
  readonly calls: SpawnRequest[] = [];
  readonly #byCommand: ReadonlyMap<string, ScriptedOutcome>;

  constructor(byCommand: ReadonlyMap<string, ScriptedOutcome>) {
    this.#byCommand = byCommand;
  }

  spawn(req: SpawnRequest): Promise<ExecOutcome> {
    this.calls.push(req);
    const outcome = this.#byCommand.get(req.command) ?? { exitCode: 0 };
    return Promise.resolve({
      exitCode: outcome.exitCode,
      stdout: outcome.stdout ?? "",
      stderr: outcome.stderr ?? "",
      timedOut: outcome.timedOut ?? false,
      launchError: outcome.launchError,
    });
  }
}

/** The loosely typed shape this suite reads back out of `renderTestJson`'s output. */
interface JsonExpectationDiffShape {
  readonly field: string;
  readonly actualContext?: unknown;
  readonly actualUpdatedInput?: unknown;
}
interface JsonNonFiringExplanationShape {
  readonly kind: string;
}
interface JsonUnknownReasonShape {
  readonly kind: string;
}
interface JsonDecidingHookShape {
  readonly launchError: string | null;
}
interface JsonCaseResultShape {
  readonly kind: string;
  readonly diffs?: readonly JsonExpectationDiffShape[];
  readonly nonFiring?: JsonNonFiringExplanationShape | null;
  readonly reasons?: readonly JsonUnknownReasonShape[];
  readonly decidedBy?: JsonDecidingHookShape | null;
}
interface JsonTestCaseShape {
  readonly event: string;
  readonly tool: string | null;
  readonly result: JsonCaseResultShape;
}
interface JsonTestReportForAssertions {
  readonly reportVersion: string;
  readonly reportType: string;
  readonly cases: readonly JsonTestCaseShape[];
}

describe("renderTestJson: schema validation against a real rendering", () => {
  let projectDir: string;

  function commandGroup(matcher: string | undefined, command: string): unknown {
    return {
      ...(matcher === undefined ? {} : { matcher }),
      hooks: [{ type: "command", command }],
    };
  }

  const CMD_BASH_PASS = "cmd-bash-pass";
  const CMD_WRITE_DENY = "cmd-write-deny";
  const CMD_EDIT_EXIT0 = "cmd-edit-exit0";
  const CMD_GREP_STDOUT = "cmd-grep-stdout";
  const CMD_GLOB_STDERR = "cmd-glob-stderr";
  const CMD_WEBFETCH_TIMEOUT = "cmd-webfetch-timeout";
  const CMD_NOTIFICATION_NOOP = "cmd-notification-noop";
  const CMD_STOP_LOCAL_ONLY = "cmd-stop-local-only";
  const CMD_LAUNCH_FAIL = "cmd-launch-fail";
  const CMD_CONTEXT_MISMATCH = "cmd-context-mismatch";
  const CMD_UPDATED_INPUT_ABSENT = "cmd-updated-input-absent";

  beforeAll(() => {
    projectDir = mkdtempSync(path.join(tmpdir(), "hookassert-reporters-test-schema-"));
    mkdirSync(path.join(projectDir, ".claude"), { recursive: true });

    // The project layer: every hook a case in this suite's fixture asserts
    // against, except `Stop`'s — declared only in the local layer below, so
    // a fixture that excludes that layer produces `excluded-settings-layer`.
    const projectSettings = {
      hooks: {
        PreToolUse: [
          commandGroup("Bash", CMD_BASH_PASS),
          commandGroup("Write", CMD_WRITE_DENY),
          commandGroup("Edit", CMD_EDIT_EXIT0),
          commandGroup("Grep", CMD_GREP_STDOUT),
          commandGroup("Glob", CMD_GLOB_STDERR),
          commandGroup("WebFetch", CMD_WEBFETCH_TIMEOUT),
          // Exec form (`args` present) — issue #39's launch-failure scenario.
          {
            matcher: "LaunchFail",
            hooks: [{ type: "command", command: CMD_LAUNCH_FAIL, args: [] }],
          },
          // Issue #34: expect.context / expect.updatedInput diffs.
          commandGroup("Agent", CMD_CONTEXT_MISMATCH),
          commandGroup("AskUserQuestion", CMD_UPDATED_INPUT_ABSENT),
        ],
        Notification: [commandGroup(undefined, CMD_NOTIFICATION_NOOP)],
      },
    };
    writeFileSync(
      path.join(projectDir, ".claude", "settings.json"),
      JSON.stringify(projectSettings, null, 2),
    );

    const localSettings = {
      hooks: {
        Stop: [commandGroup(undefined, CMD_STOP_LOCAL_ONLY)],
      },
    };
    writeFileSync(
      path.join(projectDir, ".claude", "settings.local.json"),
      JSON.stringify(localSettings, null, 2),
    );
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("validates every CaseResult.kind, ExpectationDiff.field, NonFiringExplanation.kind, and an unknown reason against schema/test-report.schema.json", async () => {
    const fixture = {
      // Restricts candidates to the project layer only: `Stop`'s hook,
      // declared solely in `.claude/settings.local.json` above, is thereby
      // excluded rather than merely unmatched.
      settings: [".claude/settings.json"],
      cases: [
        // "pass", decidedBy set.
        {
          event: "PreToolUse",
          tool: "Bash",
          expect: { decision: "pass", exitCode: 0 },
        },
        // "fail" via an ExpectationDiff.field: "fires" (something fired
        // despite `expect.fires: false`).
        { event: "PreToolUse", tool: "Bash", expect: { fires: false } },
        // "fail" via field: "decision" (denies via exit 2, expected allow).
        { event: "PreToolUse", tool: "Write", expect: { decision: "allow" } },
        // "fail" via field: "exitCode".
        { event: "PreToolUse", tool: "Edit", expect: { exitCode: 5 } },
        // "fail" via field: "stdoutContains".
        {
          event: "PreToolUse",
          tool: "Grep",
          expect: { stdoutContains: "never-printed-marker" },
        },
        // "fail" via field: "stderrContains".
        {
          event: "PreToolUse",
          tool: "Glob",
          expect: { stderrContains: "never-printed-marker" },
        },
        // "fail" via field: "timedOut".
        {
          event: "PreToolUse",
          tool: "WebFetch",
          expect: { timedOut: false },
        },
        // "fail" via field: "context" (issue #34) — hookSpecificOutput.additionalContext
        // disagrees with expect.context.
        {
          event: "PreToolUse",
          tool: "Agent",
          expect: { context: "expected-context" },
        },
        // "fail" via field: "updatedInput" (issue #34), actualUpdatedInput
        // undefined — the hook's stdout is not JSON, so nothing was emitted.
        {
          event: "PreToolUse",
          tool: "AskUserQuestion",
          expect: { updatedInput: { command: "git push" } },
        },
        // "fail" via NonFiringExplanation.kind: "matcher-did-not-match" —
        // several candidates are declared under PreToolUse, none matches "Read".
        { event: "PreToolUse", tool: "Read", expect: { fires: true } },
        // "fail" via NonFiringExplanation.kind: "no-hook-configured" —
        // nothing is declared under SessionStart anywhere.
        { event: "SessionStart", expect: { fires: true } },
        // "fail" via NonFiringExplanation.kind: "excluded-settings-layer" —
        // Stop's only hook lives in the excluded local layer.
        { event: "Stop", expect: { fires: true } },
        // "unknown" via an UnknownReason.kind: "event-not-in-spec" —
        // Notification has no entry in valid-minimal.json's spec.
        { event: "Notification", expect: {} },
        // "pass" via Decision.error.cause: "launch-failed" (issue #39) — a
        // fixture that expects the launch failure exactly still passes, and
        // decidedBy.launchError carries the OS-reported reason.
        { event: "PreToolUse", tool: "LaunchFail", expect: { decision: "error" } },
        // "skipped", reason "dry-run".
        {
          event: "PreToolUse",
          tool: "Bash",
          dryRun: true,
          expect: { decision: "pass" },
        },
        // "skipped", reason "stub-only".
        {
          event: "PreToolUse",
          tool: "Bash",
          stub: { [CMD_BASH_PASS]: { exitCode: 0 } },
          expect: {},
        },
      ],
    };
    const fixturePath = path.join(projectDir, "schema-coverage.yaml");
    writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));

    const spawner = new ScriptedSpawner(
      new Map<string, ScriptedOutcome>([
        [CMD_BASH_PASS, { exitCode: 0 }],
        [CMD_WRITE_DENY, { exitCode: 2 }],
        [CMD_EDIT_EXIT0, { exitCode: 0 }],
        [CMD_GREP_STDOUT, { exitCode: 0, stdout: "actual-stdout" }],
        [CMD_GLOB_STDERR, { exitCode: 0, stderr: "actual-stderr" }],
        [CMD_WEBFETCH_TIMEOUT, { exitCode: -1, timedOut: true }],
        [CMD_NOTIFICATION_NOOP, { exitCode: 0 }],
        [
          CMD_LAUNCH_FAIL,
          { exitCode: -1, launchError: "spawn cmd-launch-fail ENOENT" },
        ],
        [
          CMD_CONTEXT_MISMATCH,
          {
            exitCode: 0,
            stdout: JSON.stringify({
              hookSpecificOutput: { additionalContext: "actual-context" },
            }),
          },
        ],
        [CMD_UPDATED_INPUT_ABSENT, { exitCode: 0, stdout: "not json" }],
      ]),
    );

    const result = await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300", "--yes", "--format", "json"],
      "hookassert",
      {
        cwd: projectDir,
        home: path.join(FIXTURES_DIR, "no-such-directory"),
        env: {},
        specPath: MINIMAL_SPEC_PATH,
        spawner,
      },
    );

    // 11 of the 16 cases fail — `resolveTestExitCode` returns 1 whenever
    // `summary.failed > 0`, regardless of `--ci`.
    expect(result.exitCode).toBe(1);
    const parsed: unknown = JSON.parse(result.stdout);
    expect(validatesAgainstSchema(TEST_SCHEMA_PATH, parsed)).toBe(true);

    const report = parsed as JsonTestReportForAssertions;
    expect(report.reportType).toBe("test");

    const kinds = new Set(report.cases.map((c) => c.result.kind));
    expect(kinds).toEqual(new Set(["pass", "fail", "unknown", "skipped"]));

    const diffFields = new Set(
      report.cases.flatMap((c) => (c.result.diffs ?? []).map((d) => d.field)),
    );
    expect(diffFields).toEqual(
      new Set([
        "fires",
        "decision",
        "exitCode",
        "stdoutContains",
        "stderrContains",
        "timedOut",
        "context",
        "updatedInput",
      ]),
    );

    const nonFiringKinds = new Set(
      report.cases
        .map((c) => c.result.nonFiring)
        .filter((n): n is JsonNonFiringExplanationShape => n != null)
        .map((n) => n.kind),
    );
    expect(nonFiringKinds).toEqual(
      new Set([
        "matcher-did-not-match",
        "no-hook-configured",
        "excluded-settings-layer",
      ]),
    );

    const unknownReasonKinds = new Set(
      report.cases.flatMap((c) => (c.result.reasons ?? []).map((r) => r.kind)),
    );
    expect(unknownReasonKinds).toContain("event-not-in-spec");

    // The one case whose failure is a `diffs` mismatch (not `nonFiring`)
    // must still carry `nonFiring: null`, not an absent key — issue #43's
    // own completion criterion.
    const decisionDiffCase = report.cases.find(
      (c) => c.event === "PreToolUse" && c.tool === "Write",
    );
    expect(decisionDiffCase?.result.nonFiring).toBeNull();

    // Issue #34: expect.context compares against hookSpecificOutput.additionalContext.
    const contextDiffCase = report.cases.find(
      (c) => c.event === "PreToolUse" && c.tool === "Agent",
    );
    expect(contextDiffCase?.result.diffs).toContainEqual(
      expect.objectContaining({ field: "context", actualContext: "actual-context" }),
    );

    // Issue #34: expect.updatedInput compares against hookSpecificOutput.updatedInput —
    // no hook emitted it here (non-JSON stdout), so actualUpdatedInput is the
    // explicit JSON `null` schema/test-report.schema.json requires, never an
    // absent key.
    const updatedInputDiffCase = report.cases.find(
      (c) => c.event === "PreToolUse" && c.tool === "AskUserQuestion",
    );
    expect(updatedInputDiffCase?.result.diffs).toContainEqual(
      expect.objectContaining({ field: "updatedInput", actualUpdatedInput: null }),
    );

    // Issue #39: a launch failure resolves to a "pass" CaseResult when the
    // fixture expects decision: "error", and decidedBy.launchError carries
    // the OS-reported reason through to the JSON report.
    const launchFailedCase = report.cases.find(
      (c) => c.event === "PreToolUse" && c.tool === "LaunchFail",
    );
    expect(launchFailedCase?.result.kind).toBe("pass");
    expect(launchFailedCase?.result.decidedBy?.launchError).toBe(
      "spawn cmd-launch-fail ENOENT",
    );
  });

  it("pretty and github both render the context and updatedInput diffs (issue #34)", async () => {
    const fixture = {
      settings: [".claude/settings.json"],
      cases: [
        { event: "PreToolUse", tool: "Agent", expect: { context: "expected-context" } },
        {
          event: "PreToolUse",
          tool: "AskUserQuestion",
          expect: { updatedInput: { command: "git push" } },
        },
      ],
    };
    const fixturePath = path.join(projectDir, "context-diff.yaml");
    writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));

    const spawner = new ScriptedSpawner(
      new Map<string, ScriptedOutcome>([
        [
          CMD_CONTEXT_MISMATCH,
          {
            exitCode: 0,
            stdout: JSON.stringify({
              hookSpecificOutput: { additionalContext: "actual-context" },
            }),
          },
        ],
        [CMD_UPDATED_INPUT_ABSENT, { exitCode: 0, stdout: "not json" }],
      ]),
    );

    const deps = {
      cwd: projectDir,
      home: path.join(FIXTURES_DIR, "no-such-directory"),
      env: {},
      specPath: MINIMAL_SPEC_PATH,
      spawner,
    };

    const prettyResult = await runCli(
      [
        "test",
        fixturePath,
        "--claude-version",
        "2.1.300",
        "--yes",
        "--format",
        "pretty",
      ],
      "hookassert",
      deps,
    );
    expect(prettyResult.stdout).toContain(
      'context: expected "expected-context", got "actual-context"',
    );
    expect(prettyResult.stdout).toContain(
      'updatedInput: expected {"command":"git push"}, got absent',
    );

    const githubResult = await runCli(
      [
        "test",
        fixturePath,
        "--claude-version",
        "2.1.300",
        "--yes",
        "--format",
        "github",
      ],
      "hookassert",
      deps,
    );
    expect(githubResult.stdout).toContain(
      'context: expected "expected-context", got "actual-context"',
    );
    expect(githubResult.stdout).toContain(
      'updatedInput: expected {"command":"git push"}, got absent',
    );
  });
});

describe("renderLintJson: schema validation against a real rendering", () => {
  it("validates a real lint finding against schema/lint-report.schema.json", async () => {
    const result = await runCli(
      ["lint", "--settings", LINT_VIOLATING_FIXTURE, "--format", "json"],
      "hookassert",
      {
        cwd: PROJECT_WITH_HOOKS_DIR,
        home: path.join(FIXTURES_DIR, "no-such-directory"),
        env: {},
      },
    );

    expect(result.exitCode).toBe(1);
    const parsed: unknown = JSON.parse(result.stdout);
    expect(validatesAgainstSchema(LINT_SCHEMA_PATH, parsed)).toBe(true);

    const report = parsed as { reportType: string; findings: readonly unknown[] };
    expect(report.reportType).toBe("lint");
    expect(report.findings.length).toBeGreaterThan(0);
  });
});
