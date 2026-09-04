import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SettingsParseError } from "../src/internal/errors.js";
import {
  buildLintContext,
  LINT_RULES,
  readHookCommands,
  readMatcherGroups,
} from "../src/internal/lint/index.js";
import type {
  LintContext,
  LintHookCommand,
  LintRule,
} from "../src/internal/lint/index.js";
import type { VersionContext } from "../src/internal/matcher/index.js";
import {
  buildReportHeader,
  renderLintGithub,
  renderLintJson,
  toJsonLintReport,
  type LintReport,
} from "../src/internal/report/index.js";
import { loadSourceHooks } from "../src/internal/settings/index.js";
import type { SettingsSource } from "../src/internal/settings/index.js";
import {
  loadSpec,
  loadSpecFile,
  parseClaudeVersion,
} from "../src/internal/spec/index.js";
import type { Spec } from "../src/internal/spec/index.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REAL_SPEC_PATH = path.join(REPO_ROOT, "spec", "claude-code-2.1.251-2.2.0.json");
const REAL_SPEC: Spec = loadSpecFile(REAL_SPEC_PATH);
const SPEC_FIXTURES_DIR = fileURLToPath(new URL("./fixtures/spec/", import.meta.url));

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/**
 * `valid-minimal.json` mutated to `caseSensitive: false` — mirrors
 * `tests/matcher.test.ts`'s own `specWithCaseSensitive`. Its `knownTools`
 * (`Bash`, `Edit`, `Write`, `NotebookEdit`, …) and its `PreToolUse` event
 * (`matcherTargets.kind: "tool-name"`) are exactly what `matcher-case` and
 * `matcher-unanchored` need.
 */
const CASE_INSENSITIVE_SPEC: Spec = (() => {
  const raw = readJson(path.join(SPEC_FIXTURES_DIR, "valid-minimal.json")) as Record<
    string,
    unknown
  >;
  (raw["matcherSyntax"] as Record<string, unknown>)["caseSensitive"] = false;
  return loadSpec(raw, "synthetic-lint-caseSensitive-false");
})();

/**
 * The real spec's own `claudeCodeRange` (`">=2.1.251 <2.2.0"`) starts past
 * both notation rules' `sinceVersion` (`2.1.191`, `2.1.195`), so a version
 * below either — as `OLD_VERSION`, `COMMA_SATISFIED_VERSION` and
 * `HYPHEN_SATISFIED_VERSION` below all are — is also outside the real
 * spec's declared range. Widening the range here isolates the
 * `sinceVersion` boundary these versions exist to test from the separate
 * `spec.claudeCodeRange` check `OUT_OF_RANGE_VERSION` exists to test —
 * mirrors `tests/matcher.test.ts`'s own `widenedSpec`.
 */
const WIDENED_RANGE_SPEC: Spec = { ...REAL_SPEC, claudeCodeRange: ">=2.1.0 <2.2.0" };

const LINT_FIXTURES_DIR = fileURLToPath(new URL("./fixtures/lint/", import.meta.url));
const SETTINGS_FIXTURES_DIR = fileURLToPath(
  new URL("./fixtures/settings/", import.meta.url),
);

const UNDETERMINED: VersionContext = { kind: "undetermined" };

/** A version below both `comma-separated-list`'s and `hyphen-exact-match`'s own `sinceVersion`. */
const OLD_VERSION: VersionContext = {
  kind: "known",
  version: parseClaudeVersion("2.1.100"),
};

/** Exactly `comma-separated-list`'s own `sinceVersion` (`2.1.191`) — the boundary is inclusive. */
const COMMA_SATISFIED_VERSION: VersionContext = {
  kind: "known",
  version: parseClaudeVersion("2.1.191"),
};

/** Exactly `hyphen-exact-match`'s own `sinceVersion` (`2.1.195`) — the boundary is inclusive. */
const HYPHEN_SATISFIED_VERSION: VersionContext = {
  kind: "known",
  version: parseClaudeVersion("2.1.195"),
};

/**
 * Known, and above both notation rules' own `sinceVersion`, but outside
 * `REAL_SPEC.claudeCodeRange` (`">=2.1.251 <2.2.0"`) — the loaded spec
 * cannot vouch for a version this far from what it describes.
 */
const OUT_OF_RANGE_VERSION: VersionContext = {
  kind: "known",
  version: parseClaudeVersion("3.0.0"),
};

/**
 * Known, inside `REAL_SPEC.claudeCodeRange`, and above both notation rules'
 * own `sinceVersion` — satisfies `matcher-comma-version` and
 * `matcher-hyphen-version` outright rather than degrading to their own
 * unknown-confidence finding the way `UNDETERMINED` does. Used only where a
 * test's own point is a different rule entirely and an unrelated
 * undetermined-version finding would otherwise be noise.
 */
const NOTATION_SATISFIED_VERSION: VersionContext = {
  kind: "known",
  version: parseClaudeVersion("2.1.260"),
};

function ruleFixtureSource(
  ruleId: string,
  file: "violating.json" | "clean.json",
): SettingsSource {
  return { path: path.join(LINT_FIXTURES_DIR, ruleId, file), layer: "project" };
}

function settingsFixtureSource(caseDir: string, file: string): SettingsSource {
  return { path: path.join(SETTINGS_FIXTURES_DIR, caseDir, file), layer: "project" };
}

function contextFor(
  source: SettingsSource,
  versionContext: VersionContext = UNDETERMINED,
  spec: Spec = REAL_SPEC,
  projectRoot: string = path.dirname(source.path),
): LintContext {
  return buildLintContext([source], spec, versionContext, projectRoot);
}

function ruleById(id: string): LintRule {
  const rule = LINT_RULES.find((candidate) => candidate.id === id);
  if (rule === undefined) {
    throw new Error(`no LintRule is registered with id ${JSON.stringify(id)}`);
  }
  return rule;
}

/** `commandContext`'s own default `projectRoot`: the directory `hookCommand`'s default `file` sits in. */
const COMMAND_NOT_FOUND_FIXTURE_DIR = path.dirname(
  ruleFixtureSource("command-not-found", "clean.json").path,
);

/**
 * Build one `LintHookCommand` for a hand-constructed `LintContext`, the same
 * way the file's other rule-specific `describe` blocks build a bespoke
 * `LintMatcherGroup` inline. `file` defaults to a real committed fixture
 * settings file (`command-not-found`'s own `clean.json`) rather than a
 * synthetic path — a real, already-committed directory for a relative
 * `command` to resolve against without this file creating any filesystem
 * state of its own — see `placing-tests`'s unit project rule this file
 * stays inside.
 */
function hookCommand(overrides: Partial<LintHookCommand> = {}): LintHookCommand {
  return {
    file: ruleFixtureSource("command-not-found", "clean.json").path,
    layer: "project",
    event: "PreToolUse",
    line: 1,
    command: "./present.sh",
    args: undefined,
    ...overrides,
  };
}

/**
 * A `LintContext` carrying exactly `commands`, for the command/exit-code
 * rules' own tests. `projectRoot` defaults to `COMMAND_NOT_FOUND_FIXTURE_DIR`
 * — the directory `hookCommand`'s own default `file` sits in — so a relative
 * `command` such as its default `"./present.sh"` resolves against a real,
 * already-committed directory unless a test overrides it.
 */
function commandContext(
  commands: readonly LintHookCommand[],
  overrides: {
    readonly pathEnv?: string;
    readonly projectRoot?: string;
    readonly homeDir?: string;
  } = {},
): LintContext {
  return {
    spec: REAL_SPEC,
    versionContext: UNDETERMINED,
    groups: [],
    commands,
    projectRoot: overrides.projectRoot ?? COMMAND_NOT_FOUND_FIXTURE_DIR,
    pathEnv: overrides.pathEnv,
    homeDir: overrides.homeDir,
  };
}

/** The six matcher rules, in `LINT_RULES`'s own order. */
const RULE_IDS = [
  "matcher-is-array",
  "matcher-case",
  "matcher-comma-version",
  "matcher-hyphen-version",
  "matcher-dead",
  "matcher-unanchored",
  "matcher-catastrophic",
] as const;

/** The six command/exit-code rules this issue ships, in `LINT_RULES`'s own order. */
const COMMAND_RULE_IDS = [
  "command-not-found",
  "missing-shebang",
  "not-executable",
  "unquoted-var",
  "exit-1-policy",
  "exit-2-overrides-allow",
] as const;

describe("LINT_RULES: the registry", () => {
  it("registers exactly the six matcher rules and the six command/exit-code rules", () => {
    expect(LINT_RULES.map((rule) => rule.id)).toEqual([
      ...RULE_IDS,
      ...COMMAND_RULE_IDS,
    ]);
  });
});

describe("every matcher rule", () => {
  it.each(RULE_IDS)(
    "%s reports a Finding with file/line/ruleId/suggestion all set for its violating fixture",
    (ruleId) => {
      const source = ruleFixtureSource(ruleId, "violating.json");
      const findings = ruleById(ruleId).run(contextFor(source));

      expect(findings.length).toBeGreaterThan(0);
      for (const finding of findings) {
        expect(finding.ruleId).toBe(ruleId);
        expect(finding.file).toBe(source.path);
        expect(finding.line).toBeGreaterThan(0);
        expect(finding.message.length).toBeGreaterThan(0);
        // The suggestion must be a concrete fix, not a restatement of the
        // message — see the issue's own "Trap" note. Checked precisely by
        // each rule's own dedicated test below; this is the floor every
        // rule must clear.
        expect(finding.suggestion.length).toBeGreaterThan(0);
        expect(finding.suggestion).not.toBe(finding.message);
      }
    },
  );

  it.each(RULE_IDS)("%s reports zero findings for its clean fixture", (ruleId) => {
    const source = ruleFixtureSource(ruleId, "clean.json");
    expect(ruleById(ruleId).run(contextFor(source))).toEqual([]);
  });
});

describe("every command rule", () => {
  it.each(COMMAND_RULE_IDS)(
    "%s reports a Finding with file/line/ruleId/suggestion all set for its violating fixture",
    (ruleId) => {
      const source = ruleFixtureSource(ruleId, "violating.json");
      const findings = ruleById(ruleId).run(contextFor(source));

      expect(findings.length).toBeGreaterThan(0);
      for (const finding of findings) {
        expect(finding.ruleId).toBe(ruleId);
        expect(finding.file).toBe(source.path);
        expect(finding.line).toBeGreaterThan(0);
        expect(finding.message.length).toBeGreaterThan(0);
        expect(finding.suggestion.length).toBeGreaterThan(0);
        expect(finding.suggestion).not.toBe(finding.message);
      }
    },
  );

  it.each(COMMAND_RULE_IDS)(
    "%s reports zero findings for its clean fixture",
    (ruleId) => {
      const source = ruleFixtureSource(ruleId, "clean.json");
      expect(ruleById(ruleId).run(contextFor(source))).toEqual([]);
    },
  );
});

describe("matcher-is-array", () => {
  const rule = ruleById("matcher-is-array");

  it("states that the ENTIRE file's hooks are disabled, not just the one hook", () => {
    const source = ruleFixtureSource("matcher-is-array", "violating.json");
    const [finding] = rule.run(contextFor(source));

    expect(finding?.message).toContain("entire settings file");
    expect(finding?.message).not.toBe("invalid matcher type");
  });

  it("names the concrete corrected matcher string in its suggestion", () => {
    const source = ruleFixtureSource("matcher-is-array", "violating.json");
    const [finding] = rule.run(contextFor(source));

    // The violating fixture declares `"matcher": ["Edit", "Write"]`.
    expect(finding?.suggestion).toContain('"Edit,Write"');
  });

  it("does not throw for a matcher declared as a JSON array, unlike settings/load.ts's strict loader", () => {
    // tests/settings.test.ts's "a matcher written as a JSON array disables
    // every hook in that settings file" proves loadSettings throws
    // SettingsParseError for exactly this shape — that is right for
    // explain/test, but would make matcher-is-array's own Finding
    // unreachable. readMatcherGroups is the tolerant reader this rule
    // actually runs over.
    const source = ruleFixtureSource("matcher-is-array", "violating.json");
    const groups = readMatcherGroups(source);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.matcher).toEqual({ kind: "array", items: ["Edit", "Write"] });
  });
});

describe("matcher-case", () => {
  it("names the correctly-cased matcher string in its suggestion", () => {
    const source = ruleFixtureSource("matcher-case", "violating.json");
    const [finding] = ruleById("matcher-case").run(contextFor(source));

    // The violating fixture declares `"matcher": "bash"`.
    expect(finding?.suggestion).toContain('"Bash"');
  });

  it("preserves a pipe delimiter in its suggestion rather than switching to comma notation", () => {
    const source = ruleFixtureSource("matcher-case", "violating.json");
    const ctx: LintContext = {
      spec: REAL_SPEC,
      versionContext: UNDETERMINED,
      groups: [
        {
          file: source.path,
          layer: "project",
          event: "PreToolUse",
          line: 1,
          matcher: { kind: "string", value: "bash|Write" },
        },
      ],
      commands: [],
      projectRoot: REPO_ROOT,
      pathEnv: undefined,
      homeDir: undefined,
    };
    const [finding] = ruleById("matcher-case").run(ctx);

    expect(finding?.suggestion).toContain('"Bash|Write"');
    expect(finding?.suggestion).not.toContain('"Bash,Write"');
  });
});

describe("matcher-dead", () => {
  it("names the actual typo'd matcher item in its message", () => {
    const source = ruleFixtureSource("matcher-dead", "violating.json");
    const [finding] = ruleById("matcher-dead").run(contextFor(source));

    expect(finding?.message).toContain('"Basher"');
  });

  it("never flags an mcp__* item, which is never in spec.knownTools by construction", () => {
    const source = ruleFixtureSource("matcher-dead", "violating.json");
    const ctx: LintContext = {
      spec: REAL_SPEC,
      versionContext: UNDETERMINED,
      groups: [
        {
          file: source.path,
          layer: "project",
          event: "PreToolUse",
          line: 1,
          matcher: { kind: "string", value: "mcp__github__create_issue" },
        },
      ],
      commands: [],
      projectRoot: REPO_ROOT,
      pathEnv: undefined,
      homeDir: undefined,
    };
    expect(ruleById("matcher-dead").run(ctx)).toEqual([]);
  });
});

describe("matcher-unanchored", () => {
  const rule = ruleById("matcher-unanchored");

  it("enumerates the specific unintendedly-matched tool names for Edit.* matching NotebookEdit", () => {
    const source = ruleFixtureSource("matcher-unanchored", "violating.json");
    const [finding] = rule.run(contextFor(source));

    expect(finding?.message).toContain("NotebookEdit");
    // "Edit" is the intended target the matcher was written for; only the
    // unintended extra match belongs in the finding.
    expect(finding?.message).not.toContain('"Edit"');
  });

  it("does not flag an already-anchored pattern that matches only one known tool", () => {
    const source = ruleFixtureSource("matcher-unanchored", "clean.json");
    expect(rule.run(contextFor(source))).toEqual([]);
  });

  it("never flags the documented '*' catch-all wildcard", () => {
    const source: SettingsSource = {
      path: path.join(LINT_FIXTURES_DIR, "matcher-unanchored", "violating.json"),
      layer: "project",
    };
    // Same event/target as the violating fixture, but with the literal
    // wildcard matcher instead of "Edit.*".
    const ctx: LintContext = {
      spec: REAL_SPEC,
      versionContext: UNDETERMINED,
      groups: [
        {
          file: source.path,
          layer: "project",
          event: "PreToolUse",
          line: 1,
          matcher: { kind: "string", value: "*" },
        },
      ],
      commands: [],
      projectRoot: REPO_ROOT,
      pathEnv: undefined,
      homeDir: undefined,
    };
    expect(rule.run(ctx)).toEqual([]);
  });

  function unanchoredCtx(matcher: string): LintContext {
    const source = ruleFixtureSource("matcher-unanchored", "violating.json");
    return {
      spec: REAL_SPEC,
      versionContext: UNDETERMINED,
      groups: [
        {
          file: source.path,
          layer: "project",
          event: "PreToolUse",
          line: 1,
          matcher: { kind: "string", value: matcher },
        },
      ],
      commands: [],
      projectRoot: REPO_ROOT,
      pathEnv: undefined,
      homeDir: undefined,
    };
  }

  it("does not flag a correctly anchored alternation that matches only its own branches", () => {
    expect(rule.run(unanchoredCtx("^(Bash|Edit)$"))).toEqual([]);
  });

  it("for an unanchored alternation, lists only the genuine over-match, not the alternation's own branches", () => {
    const [finding] = rule.run(unanchoredCtx("(Edit|Write)"));

    expect(finding?.message).toContain("NotebookEdit");
    expect(finding?.message).not.toContain('"Edit"');
    expect(finding?.message).not.toContain('"Write"');
  });

  it("suggests a non-capturing anchored wrap rather than doubling an existing trailing $", () => {
    const [finding] = rule.run(unanchoredCtx("Edit$"));

    expect(finding?.suggestion).toContain('"^(?:Edit)$"');
    expect(finding?.suggestion).not.toContain("$$");
  });

  it("suggests a non-capturing anchored wrap rather than anchoring only the first alternation branch", () => {
    const [finding] = rule.run(unanchoredCtx("Edit|Write.*"));

    expect(finding?.suggestion).toContain('"^(?:Edit|Write.*)$"');
  });
});

describe("spec.matcherSyntax.caseSensitive: honored by matcher-case and matcher-unanchored", () => {
  function caseCtx(spec: Spec, matcher: string): LintContext {
    return {
      spec,
      versionContext: UNDETERMINED,
      groups: [
        {
          file: "/fake/settings.json",
          layer: "project",
          event: "PreToolUse",
          line: 1,
          matcher: { kind: "string", value: matcher },
        },
      ],
      commands: [],
      projectRoot: REPO_ROOT,
      pathEnv: undefined,
      homeDir: undefined,
    };
  }

  it('matcher-case: reports nothing for "bash" vs Bash under a caseSensitive: false spec', () => {
    const findings = ruleById("matcher-case").run(
      caseCtx(CASE_INSENSITIVE_SPEC, "bash"),
    );
    expect(findings).toEqual([]);
  });

  it('matcher-case: still reports the mismatch for "bash" vs Bash under the shipped (case-sensitive) spec', () => {
    const findings = ruleById("matcher-case").run(caseCtx(REAL_SPEC, "bash"));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe("matcher-case");
  });

  it('matcher-unanchored: "edit.*" still reports the genuine NotebookEdit over-match under a caseSensitive: false spec', () => {
    const [finding] = ruleById("matcher-unanchored").run(
      caseCtx(CASE_INSENSITIVE_SPEC, "edit.*"),
    );

    expect(finding?.message).toContain("NotebookEdit");
  });

  it('matcher-unanchored: "(edit|write)" does not misreport its own branches as unintended under a caseSensitive: false spec', () => {
    const [finding] = ruleById("matcher-unanchored").run(
      caseCtx(CASE_INSENSITIVE_SPEC, "(edit|write)"),
    );

    expect(finding?.message).toContain("NotebookEdit");
    expect(finding?.message).not.toContain('"Edit"');
    expect(finding?.message).not.toContain('"Write"');
  });
});

describe("matcher-catastrophic", () => {
  it("names the flagged construct in its message", () => {
    const source = ruleFixtureSource("matcher-catastrophic", "violating.json");
    const [finding] = ruleById("matcher-catastrophic").run(contextFor(source));

    expect(finding?.message).toContain('"(a+)+$"');
    expect(finding?.message).toContain("nested unbounded quantifier");
    expect(finding?.message).toContain('"(a+)+"');
  });

  it("suggests rewriting without a nested quantifier, not a restatement of the message", () => {
    const source = ruleFixtureSource("matcher-catastrophic", "violating.json");
    const [finding] = ruleById("matcher-catastrophic").run(contextFor(source));

    expect(finding?.suggestion).toContain("nested quantifier");
    expect(finding?.suggestion).not.toBe(finding?.message);
  });

  it("never flags a matcher whose regex-path pattern has no nested unbounded quantifier", () => {
    const source = ruleFixtureSource("matcher-catastrophic", "clean.json");
    expect(ruleById("matcher-catastrophic").run(contextFor(source))).toEqual([]);
  });

  it("applies regardless of the event's matcherTargets.kind, unlike matcher-unanchored", () => {
    const ctx: LintContext = {
      spec: REAL_SPEC,
      versionContext: UNDETERMINED,
      // Stop's matcherTargets.kind is "none" — a target-based rule such as
      // matcher-unanchored has no reason to run there, but a catastrophic
      // pattern is still dangerous to compile regardless of what it would
      // be tested against.
      groups: [
        {
          file: ruleFixtureSource("matcher-catastrophic", "violating.json").path,
          layer: "project",
          event: "Stop",
          line: 1,
          matcher: { kind: "string", value: "(a+)+$" },
        },
      ],
      commands: [],
      projectRoot: REPO_ROOT,
      pathEnv: undefined,
      homeDir: undefined,
    };
    const findings = ruleById("matcher-catastrophic").run(ctx);
    expect(findings).toHaveLength(1);
  });
});

describe.each([
  {
    ruleId: "matcher-comma-version",
    notation: "comma-separated-list",
    sinceVersion: "2.1.191",
    satisfiedVersion: COMMA_SATISFIED_VERSION,
  },
  {
    ruleId: "matcher-hyphen-version",
    notation: "hyphen-exact-match",
    sinceVersion: "2.1.195",
    satisfiedVersion: HYPHEN_SATISFIED_VERSION,
  },
])("$ruleId", ({ ruleId, sinceVersion, satisfiedVersion }) => {
  const rule = ruleById(ruleId);
  const source = ruleFixtureSource(ruleId, "violating.json");

  it("emits no finding when the known version satisfies the notation rule's sinceVersion", () => {
    expect(rule.run(contextFor(source, satisfiedVersion, WIDENED_RANGE_SPEC))).toEqual(
      [],
    );
  });

  it("emits a finding naming the required and detected versions when the known version is older", () => {
    const [finding] = rule.run(contextFor(source, OLD_VERSION, WIDENED_RANGE_SPEC));

    expect(finding?.message).toContain(sinceVersion);
    expect(finding?.message).toContain("2.1.100");
  });

  it("degrades to an unknown-confidence finding — rather than omitting it — when the version is undetermined", () => {
    const [finding] = rule.run(contextFor(source, UNDETERMINED, WIDENED_RANGE_SPEC));

    expect(finding).toBeDefined();
    expect(finding?.message).toContain("could not be determined");
  });

  it("produces a message distinguishable from the definite-failure case", () => {
    const [undeterminedFinding] = rule.run(
      contextFor(source, UNDETERMINED, WIDENED_RANGE_SPEC),
    );
    const [oldVersionFinding] = rule.run(
      contextFor(source, OLD_VERSION, WIDENED_RANGE_SPEC),
    );

    expect(undeterminedFinding?.message).not.toBe(oldVersionFinding?.message);
  });

  it("degrades to the same unknown-confidence finding — rather than silently passing — when the known version is outside spec.claudeCodeRange", () => {
    const [finding] = rule.run(contextFor(source, OUT_OF_RANGE_VERSION));

    expect(finding).toBeDefined();
    expect(finding?.message).toContain("could not be determined");
  });
});

describe("command-not-found", () => {
  const rule = ruleById("command-not-found");

  it("explains that the hook cannot start at all", () => {
    const source = ruleFixtureSource("command-not-found", "violating.json");
    const [finding] = rule.run(contextFor(source));

    expect(finding?.message).toContain("does not resolve to an existing");
    expect(finding?.message).toContain("cannot start at all");
  });

  it("checks an absolute path as-is: resolves against a real file, flags a missing one", () => {
    const existing = hookCommand({ command: path.join(REPO_ROOT, "package.json") });
    expect(rule.run(commandContext([existing]))).toEqual([]);

    const missing = hookCommand({
      command: path.join(REPO_ROOT, "definitely-does-not-exist.txt"),
    });
    expect(rule.run(commandContext([missing])).length).toBeGreaterThan(0);
  });

  it("resolves a relative command against ctx.projectRoot, not the settings file's own directory", () => {
    // command.file sits nowhere near REPO_ROOT, but "./package.json" only
    // exists relative to REPO_ROOT — this only passes if resolution uses
    // ctx.projectRoot (what Claude Code and the executor actually run
    // hooks against), never the settings file's own containing directory.
    const command = hookCommand({
      file: path.join(REPO_ROOT, ".claude", "settings.json"),
      command: "./package.json",
    });
    expect(rule.run(commandContext([command], { projectRoot: REPO_ROOT }))).toEqual([]);
  });

  it("skips a leading NAME=value environment assignment when extracting the shell target", () => {
    const command = hookCommand({ command: "FOO=bar ./present.sh" });
    expect(rule.run(commandContext([command]))).toEqual([]);
  });

  it("looks up a bare command word on ctx.pathEnv, one directory at a time, never spawning it", () => {
    const pathEnv = path.dirname(
      ruleFixtureSource("command-not-found", "clean.json").path,
    );
    const found = hookCommand({ command: "present.sh" });
    expect(rule.run(commandContext([found], { pathEnv }))).toEqual([]);

    const notFound = hookCommand({ command: "no-such-tool-xyz" });
    expect(rule.run(commandContext([notFound], { pathEnv })).length).toBeGreaterThan(0);
  });

  it("never flags a resolved exec-form command, whose args are passed through as-is", () => {
    const command = hookCommand({
      command: path.join(REPO_ROOT, "package.json"),
      args: [],
    });
    expect(rule.run(commandContext([command]))).toEqual([]);
  });

  it('expands a quoted "$CLAUDE_PROJECT_DIR" prefix to ctx.projectRoot before resolving', () => {
    const command = hookCommand({ command: '"$CLAUDE_PROJECT_DIR"/present.sh' });
    expect(
      rule.run(
        commandContext([command], { projectRoot: COMMAND_NOT_FOUND_FIXTURE_DIR }),
      ),
    ).toEqual([]);
  });

  it("expands an unquoted $CLAUDE_PROJECT_DIR prefix to ctx.projectRoot before resolving", () => {
    const command = hookCommand({ command: "$CLAUDE_PROJECT_DIR/present.sh" });
    expect(
      rule.run(
        commandContext([command], { projectRoot: COMMAND_NOT_FOUND_FIXTURE_DIR }),
      ),
    ).toEqual([]);
  });

  it("expands a leading ~/ to ctx.homeDir before resolving", () => {
    const command = hookCommand({ command: "~/present.sh" });
    expect(
      rule.run(commandContext([command], { homeDir: COMMAND_NOT_FOUND_FIXTURE_DIR })),
    ).toEqual([]);
  });

  it("skips resolution entirely — reports nothing — for a leading ~/ when ctx.homeDir is unset", () => {
    const command = hookCommand({ command: "~/present.sh" });
    expect(rule.run(commandContext([command]))).toEqual([]);
  });

  it("skips resolution entirely — reports nothing — for a target that still contains an unexpanded $VAR", () => {
    const command = hookCommand({ command: "$SOME_OTHER_VAR/present.sh" });
    expect(rule.run(commandContext([command]))).toEqual([]);
  });

  it("never flags a shell builtin or reserved word as an unresolvable PATH command", () => {
    const command = hookCommand({ command: "exit 0" });
    expect(rule.run(commandContext([command]))).toEqual([]);
  });

  it("resolves the word after a leading 'exec', not 'exec' itself", () => {
    const found = hookCommand({ command: "exec ./present.sh" });
    expect(rule.run(commandContext([found]))).toEqual([]);

    const missing = hookCommand({ command: "exec ./missing-script.sh" });
    expect(rule.run(commandContext([missing])).length).toBeGreaterThan(0);
  });

  it("never flags 'cd' as an unresolvable PATH command, even when it fronts a compound command", () => {
    // Without the builtin allowlist, this only passed on a machine that
    // happens to ship a real /usr/bin/cd (macOS does; a typical Ubuntu CI
    // image does not) — "cd" is a shell builtin everywhere, never a
    // PATH-resolvable executable.
    const command = hookCommand({
      command: 'cd "$CLAUDE_PROJECT_DIR" && ./present.sh',
    });
    expect(
      rule.run(
        commandContext([command], { projectRoot: COMMAND_NOT_FOUND_FIXTURE_DIR }),
      ),
    ).toEqual([]);
  });
});

describe("missing-shebang", () => {
  const rule = ruleById("missing-shebang");

  it("names the resolved script path and explains the risk", () => {
    const source = ruleFixtureSource("missing-shebang", "violating.json");
    const [finding] = rule.run(contextFor(source));

    expect(finding?.message).toContain('no "#!" shebang line');
    expect(finding?.suggestion).toContain("#!");
  });

  it("never flags a command that command-not-found already owns (unresolvable)", () => {
    const command = hookCommand({ command: "./does-not-exist-anywhere.sh" });
    expect(rule.run(commandContext([command]))).toEqual([]);
  });

  it("never flags a resolved file whose extension is not script-like", () => {
    const command = hookCommand({ command: path.join(REPO_ROOT, "package.json") });
    expect(rule.run(commandContext([command]))).toEqual([]);
  });
});

describe("not-executable", () => {
  const rule = ruleById("not-executable");

  it("names the resolved file path and explains the permission bit", () => {
    const source = ruleFixtureSource("not-executable", "violating.json");
    const [finding] = rule.run(contextFor(source));

    expect(finding?.message).toContain("is not executable");
    expect(finding?.suggestion).toContain("chmod +x");
  });

  it("never flags a command that command-not-found already owns (unresolvable)", () => {
    const command = hookCommand({ command: "./does-not-exist-anywhere.sh" });
    expect(rule.run(commandContext([command]))).toEqual([]);
  });

  it("never flags a resolved target that is a directory, not a regular file", () => {
    const command = hookCommand({ command: REPO_ROOT, args: [] });
    expect(rule.run(commandContext([command]))).toEqual([]);
  });
});

describe("unquoted-var", () => {
  const rule = ruleById("unquoted-var");

  it("names the unquoted reference and explains word splitting / glob expansion", () => {
    const source = ruleFixtureSource("unquoted-var", "violating.json");
    const [finding] = rule.run(contextFor(source));

    expect(finding?.message).toContain("$FILE");
    expect(finding?.message).toContain("word splitting");
    expect(finding?.suggestion).toContain('"$FILE"');
  });

  it("never flags an exec-form command, even with an unquoted-looking $VAR in its command string", () => {
    const command = hookCommand({ command: "rm $FILE", args: [] });
    expect(rule.run(commandContext([command]))).toEqual([]);
  });

  it("flags the braced ${VAR} form too", () => {
    const command = hookCommand({ command: "rm ${FILE}" });
    const [finding] = rule.run(commandContext([command]));
    expect(finding?.message).toContain("${FILE}");
  });

  it("never flags a variable reference sitting inside single quotes", () => {
    const command = hookCommand({ command: "echo '$FILE'" });
    expect(rule.run(commandContext([command]))).toEqual([]);
  });
});

describe("exit-1-policy", () => {
  const rule = ruleById("exit-1-policy");

  it("explains that only exit 2 blocks and the tool call proceeds anyway on exit 1", () => {
    const source = ruleFixtureSource("exit-1-policy", "violating.json");
    const [finding] = rule.run(contextFor(source));

    expect(finding?.message).toContain("Only exit code 2 blocks");
    expect(finding?.message).toContain("proceeds anyway");
    expect(finding?.suggestion).toContain("exit 2");
  });

  it("never flags a plain 'exit 1' with no conditional logic around it", () => {
    const command = hookCommand({ command: "echo denied; exit 1" });
    expect(rule.run(commandContext([command]))).toEqual([]);
  });

  it("never flags a policy branch that already exits 2", () => {
    const source = ruleFixtureSource("exit-1-policy", "clean.json");
    expect(rule.run(contextFor(source))).toEqual([]);
  });

  it("never reads a resolved target's own file content when it is not script-like", () => {
    // decoy.bin's own content is a textbook exit-1-policy violation
    // (conditional logic plus an "exit 1" with no "exit 2" anywhere) — if
    // hookSourceText read it despite the ".bin" extension, this would
    // report a finding.
    const command = hookCommand({ command: "./decoy.bin" });
    expect(rule.run(commandContext([command]))).toEqual([]);
  });
});

describe("exit-2-overrides-allow", () => {
  const rule = ruleById("exit-2-overrides-allow");

  it("states that exit 2 wins over the allow JSON payload", () => {
    const source = ruleFixtureSource("exit-2-overrides-allow", "violating.json");
    const [finding] = rule.run(contextFor(source));

    expect(finding?.message).toContain("exit 2");
    expect(finding?.message).toContain("override");
    expect(finding?.message).toContain('"allow"');
  });

  it("also recognizes the nested hookSpecificOutput.permissionDecision allow shape", () => {
    const command = hookCommand({
      command: 'echo \'{"hookSpecificOutput":{"permissionDecision":"allow"}}\'; exit 2',
    });
    expect(rule.run(commandContext([command])).length).toBeGreaterThan(0);
  });

  it("never flags an allow decision with no exit 2 anywhere", () => {
    const command = hookCommand({ command: 'echo \'{"decision":"allow"}\'; exit 0' });
    expect(rule.run(commandContext([command]))).toEqual([]);
  });
});

describe("readMatcherGroups: the tolerant reader's own structural strictness", () => {
  it("still throws SettingsParseError for a non-string, non-array matcher", () => {
    // tests/fixtures/settings/structural-errors/matcher-not-string.json
    // declares `"matcher": 5` — matcher-is-array's own tolerance is scoped
    // to exactly "absent | string | array", not every non-string shape.
    const source = settingsFixtureSource(
      "structural-errors",
      "matcher-not-string.json",
    );

    let caught: unknown;
    try {
      readMatcherGroups(source);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SettingsParseError);
  });

  it("still throws SettingsParseError for a root that is not an object", () => {
    const source = settingsFixtureSource("structural-errors", "root-not-object.json");
    expect(() => readMatcherGroups(source)).toThrow(SettingsParseError);
  });

  it("still throws SettingsParseError for unparsable JSONC", () => {
    const source = settingsFixtureSource("malformed-jsonc", "project.json");
    expect(() => readMatcherGroups(source)).toThrow(SettingsParseError);
  });

  it("returns zero groups for a settings file that does not exist", () => {
    const source: SettingsSource = {
      path: path.join(SETTINGS_FIXTURES_DIR, "no-such-directory", "project.json"),
      layer: "project",
    };
    expect(readMatcherGroups(source)).toEqual([]);
  });
});

describe("readHookCommands: agreement with the strict loader", () => {
  it("yields the same (event, command, args, line) tuples as loadSourceHooks, for every settings fixture the strict loader accepts", () => {
    // Both readers walk the same shared parse (`settings/jsonc.ts`) and are
    // meant to read every command entry identically — the only place they
    // may differ is how a `matcher` itself is read, which this comparison
    // never looks at. A fixture the strict loader rejects (malformed JSONC,
    // an array-valued matcher, any other structural error) is skipped here:
    // it is exactly the case the two readers are allowed to disagree about,
    // and `tests/settings.test.ts` and the "structural strictness" describe
    // block above already cover it.
    const fixtureFiles = readdirSync(SETTINGS_FIXTURES_DIR, {
      recursive: true,
      encoding: "utf8",
    })
      .filter((entry) => entry.endsWith(".json"))
      .map((relative) => path.join(SETTINGS_FIXTURES_DIR, relative));

    expect(fixtureFiles.length).toBeGreaterThan(0);

    let comparedAtLeastOne = false;
    for (const file of fixtureFiles) {
      const source: SettingsSource = { path: file, layer: "project" };

      let strictHooks: ReturnType<typeof loadSourceHooks>;
      try {
        strictHooks = loadSourceHooks(source);
      } catch (error) {
        expect(error).toBeInstanceOf(SettingsParseError);
        continue;
      }

      comparedAtLeastOne = true;
      const tolerantCommands = readHookCommands(source);
      expect(
        tolerantCommands.map((command) => [
          command.event,
          command.command,
          command.args,
          command.line,
        ]),
      ).toEqual(
        strictHooks.map((hook) => [
          hook.event,
          hook.command,
          hook.args,
          hook.provenance.line,
        ]),
      );
    }

    expect(comparedAtLeastOne).toBe(true);
  });
});

describe("buildLintContext", () => {
  it("flattens groups across every settings source given", () => {
    const ctx = buildLintContext(
      [
        ruleFixtureSource("matcher-case", "violating.json"),
        ruleFixtureSource("matcher-dead", "violating.json"),
      ],
      REAL_SPEC,
      UNDETERMINED,
      REPO_ROOT,
    );
    expect(ctx.groups).toHaveLength(2);
  });
});

describe("lint report rendering: json and github", () => {
  function reportFor(
    source: SettingsSource,
    versionContext: VersionContext = UNDETERMINED,
  ): LintReport {
    const ctx = contextFor(source, versionContext);
    const findings = LINT_RULES.flatMap((rule) => rule.run(ctx));
    return {
      header: buildReportHeader(versionContext, REAL_SPEC.claudeCodeRange),
      findings,
    };
  }

  const violatingSource = ruleFixtureSource("matcher-is-array", "violating.json");

  describe("renderLintJson / toJsonLintReport", () => {
    it("tags the report as reportType 'lint'", () => {
      const json = toJsonLintReport(reportFor(violatingSource));
      expect(json.reportType).toBe("lint");
      expect(json.reportVersion).toBe("1");
    });

    it("carries every Finding field for each finding, unmodified", () => {
      const report = reportFor(violatingSource);
      const json = toJsonLintReport(report);

      expect(json.findings).toHaveLength(report.findings.length);
      json.findings.forEach((jsonFinding, index) => {
        const finding = report.findings[index];
        expect(jsonFinding).toEqual({
          file: finding?.file,
          line: finding?.line,
          ruleId: finding?.ruleId,
          message: finding?.message,
          suggestion: finding?.suggestion,
        });
      });
    });

    it("renderLintJson stringifies exactly toJsonLintReport's own shape", () => {
      const report = reportFor(violatingSource);
      expect(JSON.parse(renderLintJson(report)) as unknown).toEqual(
        toJsonLintReport(report),
      );
    });

    it("carries an empty findings array, not an omitted one, when there is nothing to report", () => {
      // matcher-dead's own clean.json ("Bash") is clean across every rule,
      // unlike matcher-is-array's own clean.json ("Edit,Write"), which is
      // clean only for matcher-is-array itself and still trips
      // matcher-comma-version under an undetermined version.
      const cleanSource = ruleFixtureSource("matcher-dead", "clean.json");
      const json = toJsonLintReport(reportFor(cleanSource));
      expect(json.findings).toEqual([]);
    });
  });

  describe("renderLintGithub", () => {
    it("emits one ::error line per finding, with a workspace-relative path", () => {
      const report = reportFor(violatingSource);
      const output = renderLintGithub(report, REPO_ROOT);

      const relativePath = path
        .relative(REPO_ROOT, violatingSource.path)
        .split(path.sep)
        .join("/");
      expect(output).toContain(
        `::error file=${relativePath},line=5,title=matcher-is-array::`,
      );
      // The absolute path must never leak into a github annotation.
      expect(output).not.toContain(violatingSource.path);
    });

    it("folds the suggestion into the message body rather than dropping it", () => {
      const report = reportFor(violatingSource);
      const [finding] = report.findings;
      const output = renderLintGithub(report, REPO_ROOT);

      expect(finding).toBeDefined();
      expect(output).toContain(finding?.suggestion ?? "");
    });

    it("emits only the header line, no ::error, for a clean report", () => {
      const cleanSource = ruleFixtureSource("matcher-dead", "clean.json");
      const output = renderLintGithub(reportFor(cleanSource), REPO_ROOT);

      expect(output).not.toContain("::error");
      expect(output).toContain("::notice");
    });
  });
});

describe("every rule's own clean fixture, run under the full registry", () => {
  // Each `describe("<rule-id>", ...)` block above only ever runs its own
  // rule against its own clean fixture — a fixture clean for that one rule
  // can still trip a different rule entirely once every rule in LINT_RULES
  // runs over the same fixture (a command-not-found finding from a matcher
  // rule's own fixture, for example). PATH and HOME come from the real
  // process environment, not an empty stub: `unquoted-var`'s own clean
  // fixture resolves its bare "rm" against a real PATH entry, the same way
  // a real lint run would.
  const env = {
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "",
  };

  it.each([...RULE_IDS, ...COMMAND_RULE_IDS])(
    "%s's clean fixture reports zero findings from every registered rule, not just its own",
    (ruleId) => {
      const source = ruleFixtureSource(ruleId, "clean.json");
      // NOTATION_SATISFIED_VERSION, not UNDETERMINED: matcher-is-array's
      // own clean fixture ("Edit,Write") is a comma-separated matcher, and
      // matcher-comma-version's own "degrades to an unknown-confidence
      // finding ... when the version is undetermined" behavior (tested
      // above) is deliberate, pre-existing, and not what this test exists
      // to check — this test is only about the six command rules never
      // false-positiving across every rule's own fixture.
      const ctx = buildLintContext(
        [source],
        REAL_SPEC,
        NOTATION_SATISFIED_VERSION,
        path.dirname(source.path),
        env,
      );
      expect(LINT_RULES.flatMap((rule) => rule.run(ctx))).toEqual([]);
    },
  );
});
