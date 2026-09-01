import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SettingsParseError } from "../src/internal/errors.js";
import {
  buildLintContext,
  LINT_RULES,
  readMatcherGroups,
} from "../src/internal/lint/index.js";
import type { LintContext, LintRule } from "../src/internal/lint/index.js";
import type { VersionContext } from "../src/internal/matcher/index.js";
import type { SettingsSource } from "../src/internal/settings/index.js";
import { loadSpecFile, parseClaudeVersion } from "../src/internal/spec/index.js";
import type { Spec } from "../src/internal/spec/index.js";

// Reaching src/internal/lint/, src/internal/spec/, src/internal/matcher/,
// and src/internal/settings/ directly (rather than through src/index.ts's
// exports, per the writing-tests skill) is a deliberate, narrowly scoped
// exception: none of these modules has a public surface in this issue and
// never will one for their own plumbing types — see eslint.config.mjs's
// "tests/static-layer-unit-tests" block for the full reasoning.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REAL_SPEC_PATH = path.join(REPO_ROOT, "spec", "claude-code-2.1.251-2.2.0.json");
const REAL_SPEC: Spec = loadSpecFile(REAL_SPEC_PATH);

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
): LintContext {
  return buildLintContext([source], REAL_SPEC, versionContext);
}

function ruleById(id: string): LintRule {
  const rule = LINT_RULES.find((candidate) => candidate.id === id);
  if (rule === undefined) {
    throw new Error(`no LintRule is registered with id ${JSON.stringify(id)}`);
  }
  return rule;
}

/** The five matcher rules this issue ships, in `LINT_RULES`'s own order. */
const RULE_IDS = [
  "matcher-is-array",
  "matcher-case",
  "matcher-comma-version",
  "matcher-hyphen-version",
  "matcher-dead",
  "matcher-unanchored",
] as const;

describe("LINT_RULES: the registry", () => {
  it("registers exactly the five matcher rules this issue ships", () => {
    expect(LINT_RULES.map((rule) => rule.id)).toEqual(RULE_IDS);
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
});

describe("matcher-dead", () => {
  it("names the actual typo'd matcher item in its message", () => {
    const source = ruleFixtureSource("matcher-dead", "violating.json");
    const [finding] = ruleById("matcher-dead").run(contextFor(source));

    expect(finding?.message).toContain('"Basher"');
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
    };
    expect(rule.run(ctx)).toEqual([]);
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
    expect(rule.run(contextFor(source, satisfiedVersion))).toEqual([]);
  });

  it("emits a finding naming the required and detected versions when the known version is older", () => {
    const [finding] = rule.run(contextFor(source, OLD_VERSION));

    expect(finding?.message).toContain(sinceVersion);
    expect(finding?.message).toContain("2.1.100");
  });

  it("degrades to an unknown-confidence finding — rather than omitting it — when the version is undetermined", () => {
    const [finding] = rule.run(contextFor(source, UNDETERMINED));

    expect(finding).toBeDefined();
    expect(finding?.message).toContain("could not be determined");
  });

  it("produces a message distinguishable from the definite-failure case", () => {
    const [undeterminedFinding] = rule.run(contextFor(source, UNDETERMINED));
    const [oldVersionFinding] = rule.run(contextFor(source, OLD_VERSION));

    expect(undeterminedFinding?.message).not.toBe(oldVersionFinding?.message);
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

describe("buildLintContext", () => {
  it("flattens groups across every settings source given", () => {
    const ctx = buildLintContext(
      [
        ruleFixtureSource("matcher-case", "violating.json"),
        ruleFixtureSource("matcher-dead", "violating.json"),
      ],
      REAL_SPEC,
      UNDETERMINED,
    );
    expect(ctx.groups).toHaveLength(2);
  });
});
