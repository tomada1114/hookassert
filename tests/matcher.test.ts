import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SettingsParseError } from "../src/internal/errors.js";
import { classifyMatcher, matchHooks } from "../src/internal/matcher/index.js";
import type { MatchRequest, VersionContext } from "../src/internal/matcher/index.js";
import { loadSettings } from "../src/internal/settings/index.js";
import { loadSpecFile, parseClaudeVersion } from "../src/internal/spec/index.js";
import type { Spec } from "../src/internal/spec/index.js";
import type { EventName, Provenance, ResolvedHook } from "../src/types.js";

// Reaching src/internal/matcher/ and src/internal/spec/ directly (rather
// than through src/index.ts's exports, per the writing-tests skill) is a
// deliberate, narrowly scoped exception: this module has no public surface
// in this issue and never will one for its own plumbing types — see
// eslint.config.mjs's "tests/static-layer-unit-tests" block for the full
// reasoning.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REAL_SPEC_PATH = path.join(REPO_ROOT, "spec", "claude-code-2.1.251-2.2.0.json");
const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/matcher/", import.meta.url));

function fixturePath(caseDir: string, file: string): string {
  return path.join(FIXTURES_DIR, caseDir, file);
}

const REAL_SPEC: Spec = loadSpecFile(REAL_SPEC_PATH);

/**
 * A version inside the real spec's own `claudeCodeRange`
 * (`>=2.1.251 <2.2.0`), and past both `matcherSyntax.rules[].sinceVersion`
 * values (`2.1.191`, `2.1.195`) — every `matcherTable` row is expected to
 * behave exactly as documented at this version.
 */
const IN_RANGE_VERSION: VersionContext = {
  kind: "known",
  version: parseClaudeVersion("2.1.251"),
};

let nextOffset = 0;

function makeHook(event: EventName, matcher: string | undefined): ResolvedHook {
  const provenance: Provenance = {
    file: "/fake/settings.json",
    layer: "project",
    line: 1,
    col: 1,
    offset: nextOffset++,
  };
  return {
    event,
    matcher,
    command: "./hook.sh",
    args: undefined,
    timeoutMs: undefined,
    provenance,
    dedupeKey: JSON.stringify([event, matcher ?? "", "./hook.sh"]),
  };
}

function requestFor(
  event: EventName,
  hook: ResolvedHook,
  target: string | undefined,
): MatchRequest {
  return { event, hooks: [hook], target };
}

describe("matcherTable: generated tests from spec.matcherTable", () => {
  it("matcherTable is non-empty", () => {
    expect(REAL_SPEC.matcherTable.length).toBeGreaterThan(0);
  });

  it("every matcherTable row's event exists in spec.events", () => {
    for (const row of REAL_SPEC.matcherTable) {
      expect(REAL_SPEC.events[row.event]).toBeDefined();
    }
  });

  interface Case {
    readonly event: string;
    readonly matcher: string;
    readonly target: string;
    readonly expected: boolean;
  }

  const CASES: readonly Case[] = REAL_SPEC.matcherTable.flatMap((row) => [
    ...row.matches.map((target) => ({
      event: row.event,
      matcher: row.matcher,
      target,
      expected: true,
    })),
    ...row.doesNotMatch.map((target) => ({
      event: row.event,
      matcher: row.matcher,
      target,
      expected: false,
    })),
  ]);

  it.each(CASES)(
    "$event matcher $matcher against $target fires: $expected",
    ({ event, matcher, target, expected }) => {
      const eventName = event as EventName;
      const hook = makeHook(eventName, matcher);
      const result = matchHooks(
        REAL_SPEC,
        IN_RANGE_VERSION,
        requestFor(eventName, hook, target),
      );

      if (expected) {
        expect(result.firing).toEqual([hook]);
        expect(result.rejected).toEqual([]);
      } else {
        expect(result.firing).toEqual([]);
        expect(result.rejected).toHaveLength(1);
      }
    },
  );
});

describe("classifyMatcher: the three-way classification", () => {
  it("Edit|Write classifies as an exact-match list", () => {
    expect(
      classifyMatcher(REAL_SPEC, IN_RANGE_VERSION, "PreToolUse", "Edit|Write"),
    ).toBe("exact-list");
  });

  it("Edit.* classifies as an unanchored regex and matches NotebookEdit", () => {
    expect(classifyMatcher(REAL_SPEC, IN_RANGE_VERSION, "PreToolUse", "Edit.*")).toBe(
      "unanchored-regex",
    );

    const hook = makeHook("PreToolUse", "Edit.*");
    const result = matchHooks(
      REAL_SPEC,
      IN_RANGE_VERSION,
      requestFor("PreToolUse", hook, "NotebookEdit"),
    );
    expect(result.firing).toEqual([hook]);
    expect(result.rejected).toEqual([]);
  });

  it("bash does not match Bash (case-sensitive)", () => {
    expect(classifyMatcher(REAL_SPEC, IN_RANGE_VERSION, "PreToolUse", "bash")).toBe(
      "exact-list",
    );

    const hook = makeHook("PreToolUse", "bash");
    const result = matchHooks(
      REAL_SPEC,
      IN_RANGE_VERSION,
      requestFor("PreToolUse", hook, "Bash"),
    );
    expect(result.firing).toEqual([]);
    expect(result.rejected).toHaveLength(1);
  });

  it("classifies FileChanged's narrower exact-list pattern differently from PreToolUse's", () => {
    // "a-b" is exact-list under the broad exactListPattern (which allows
    // hyphens, gated by the hyphen-exact-match rule, satisfied at
    // IN_RANGE_VERSION) but FileChanged is in narrowExactMatchEvents, whose
    // narrowExactListPattern has no hyphen — so the identical string
    // classifies as regex there instead.
    expect(classifyMatcher(REAL_SPEC, IN_RANGE_VERSION, "PreToolUse", "a-b")).toBe(
      "exact-list",
    );
    expect(classifyMatcher(REAL_SPEC, IN_RANGE_VERSION, "FileChanged", "a-b")).toBe(
      "unanchored-regex",
    );
  });

  it("treats an event absent from spec.events as not matcherTargets.kind none", () => {
    const sparseSpec: Spec = { ...REAL_SPEC, events: {} };
    expect(classifyMatcher(sparseSpec, IN_RANGE_VERSION, "PreToolUse", "Bash")).toBe(
      "exact-list",
    );
  });
});

describe("MatcherOutcome: why a hook did not fire", () => {
  it("a non-firing hook's MatcherOutcome explains it was evaluated as an exact-match list and did not match Bash", () => {
    const hook = makeHook("PreToolUse", "Edit");
    const result = matchHooks(
      REAL_SPEC,
      IN_RANGE_VERSION,
      requestFor("PreToolUse", hook, "Bash"),
    );

    expect(result.firing).toEqual([]);
    expect(result.rejected).toEqual([
      {
        hook,
        kind: "exact-list",
        reason: "evaluated as an exact-match list and did not match Bash",
      },
    ]);
  });

  it("a non-firing hook's MatcherOutcome explains it was evaluated as an unanchored regex and did not match", () => {
    const hook = makeHook("PreToolUse", "Edit.*");
    const result = matchHooks(
      REAL_SPEC,
      IN_RANGE_VERSION,
      requestFor("PreToolUse", hook, "Bash"),
    );

    expect(result.firing).toEqual([]);
    expect(result.rejected).toEqual([
      {
        hook,
        kind: "unanchored-regex",
        reason: "evaluated as an unanchored regex and did not match",
      },
    ]);
  });

  it("an exact-list matcher with no target never fires and is rejected", () => {
    const hook = makeHook("PreToolUse", "Edit");
    const result = matchHooks(
      REAL_SPEC,
      IN_RANGE_VERSION,
      requestFor("PreToolUse", hook, undefined),
    );
    expect(result.firing).toEqual([]);
    expect(result.rejected).toEqual([
      {
        hook,
        kind: "exact-list",
        reason: "evaluated as an exact-match list and did not match <no target>",
      },
    ]);
  });

  it("an unanchored-regex matcher with no target never fires and is rejected", () => {
    const hook = makeHook("PreToolUse", "Edit.*");
    const result = matchHooks(
      REAL_SPEC,
      IN_RANGE_VERSION,
      requestFor("PreToolUse", hook, undefined),
    );
    expect(result.firing).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.kind).toBe("unanchored-regex");
  });

  it("a matcher that is not a syntactically valid regular expression never fires, rather than throwing", () => {
    const hook = makeHook("PreToolUse", "Edit(");
    expect(() =>
      matchHooks(REAL_SPEC, IN_RANGE_VERSION, requestFor("PreToolUse", hook, "Edit(")),
    ).not.toThrow();

    const result = matchHooks(
      REAL_SPEC,
      IN_RANGE_VERSION,
      requestFor("PreToolUse", hook, "Edit("),
    );
    expect(result.firing).toEqual([]);
    expect(result.rejected).toHaveLength(1);
  });

  it("a hook with no declared matcher always fires", () => {
    const hook = makeHook("PreToolUse", undefined);
    const result = matchHooks(
      REAL_SPEC,
      IN_RANGE_VERSION,
      requestFor("PreToolUse", hook, "Anything"),
    );
    expect(result.firing).toEqual([hook]);
    expect(result.rejected).toEqual([]);
  });

  it("ignores a hook declared under a different event", () => {
    const hook = makeHook("Notification", "permission_prompt");
    const result = matchHooks(
      REAL_SPEC,
      IN_RANGE_VERSION,
      requestFor("PreToolUse", hook, "Bash"),
    );
    expect(result.firing).toEqual([]);
    expect(result.rejected).toEqual([]);
  });
});

describe("version gating: never silently pass", () => {
  it("a comma-separated-list matcher below claude 2.1.191 degrades to unknown, not a silent non-match", () => {
    // The shipped spec's own claudeCodeRange (>=2.1.251 <2.2.0) starts past
    // both notation rules' sinceVersion, so this widens claudeCodeRange to
    // exercise a version that is in-range yet below comma-separated-list's
    // 2.1.191 sinceVersion.
    const widenedSpec: Spec = { ...REAL_SPEC, claudeCodeRange: ">=2.1.0 <2.2.0" };
    const belowCommaRule: VersionContext = {
      kind: "known",
      version: parseClaudeVersion("2.1.180"),
    };

    expect(
      classifyMatcher(widenedSpec, belowCommaRule, "PreToolUse", "Edit, Write"),
    ).toBe("unknown");

    const hook = makeHook("PreToolUse", "Edit, Write");
    const result = matchHooks(
      widenedSpec,
      belowCommaRule,
      requestFor("PreToolUse", hook, "Edit"),
    );
    expect(result.firing).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.kind).toBe("unknown");
  });

  it("a hyphen-exact-match matcher below claude 2.1.195 degrades to unknown", () => {
    const widenedSpec: Spec = { ...REAL_SPEC, claudeCodeRange: ">=2.1.0 <2.2.0" };
    const belowHyphenRule: VersionContext = {
      kind: "known",
      version: parseClaudeVersion("2.1.192"),
    };

    expect(classifyMatcher(widenedSpec, belowHyphenRule, "PreToolUse", "a-b")).toBe(
      "unknown",
    );
  });

  it("a version outside spec.claudeCodeRange makes every matcher judgment unknown", () => {
    const outOfRange: VersionContext = {
      kind: "known",
      version: parseClaudeVersion("3.0.0"),
    };

    expect(classifyMatcher(REAL_SPEC, outOfRange, "PreToolUse", "Edit|Write")).toBe(
      "unknown",
    );
    expect(classifyMatcher(REAL_SPEC, outOfRange, "PreToolUse", "Edit.*")).toBe(
      "unknown",
    );

    const hook = makeHook("PreToolUse", "Edit|Write");
    const result = matchHooks(
      REAL_SPEC,
      outOfRange,
      requestFor("PreToolUse", hook, "Edit"),
    );
    expect(result.firing).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.kind).toBe("unknown");
  });

  it("an undetermined version degrades version-dependent matcher judgments to unknown", () => {
    const undetermined: VersionContext = { kind: "undetermined" };

    expect(classifyMatcher(REAL_SPEC, undetermined, "PreToolUse", "Edit, Write")).toBe(
      "unknown",
    );

    // A matcher that implicates no version-gated notation is unaffected by
    // an undetermined version.
    expect(classifyMatcher(REAL_SPEC, undetermined, "PreToolUse", "Edit|Write")).toBe(
      "exact-list",
    );
  });
});

describe("matcherTargets.kind: none", () => {
  it("an event with matcherTargets.kind: none rejects any hook that declares a matcher", () => {
    expect(REAL_SPEC.events["Stop"]?.matcherTargets.kind).toBe("none");

    const hook = makeHook("Stop", "manual");
    const result = matchHooks(
      REAL_SPEC,
      IN_RANGE_VERSION,
      requestFor("Stop", hook, undefined),
    );

    expect(result.firing).toEqual([]);
    expect(result.rejected).toEqual([
      {
        hook,
        kind: "unsupported",
        reason:
          'the Stop event\'s matcherTargets.kind is "none": hooks may not declare a matcher for this event',
      },
    ]);
  });

  it("an event with matcherTargets.kind: none still fires a hook that declares no matcher", () => {
    const hook = makeHook("Stop", undefined);
    const result = matchHooks(
      REAL_SPEC,
      IN_RANGE_VERSION,
      requestFor("Stop", hook, undefined),
    );

    expect(result.firing).toEqual([hook]);
    expect(result.rejected).toEqual([]);
  });
});

describe("a matcher written as a JSON array disables every hook in that settings file", () => {
  it("throws SettingsParseError and yields zero hooks from the whole file, not just the bad one", () => {
    let caught: unknown;
    try {
      loadSettings([
        {
          path: fixturePath("array-matcher-disables-file", "project.json"),
          layer: "project",
        },
      ]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SettingsParseError);
    expect((caught as SettingsParseError).code).toBe("ERR_SETTINGS_PARSE");
    expect((caught as SettingsParseError).exitCode).toBe(5);
  });
});
