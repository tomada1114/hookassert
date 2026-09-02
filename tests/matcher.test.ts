import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { classifyMatcher, matchHooks } from "../src/internal/matcher/index.js";
import type { MatchRequest, VersionContext } from "../src/internal/matcher/index.js";
import { loadSpecFile, parseClaudeVersion } from "../src/internal/spec/index.js";
import type { Spec } from "../src/internal/spec/index.js";
import type { EventName, Provenance, ResolvedHook } from "../src/types.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REAL_SPEC_PATH = path.join(REPO_ROOT, "spec", "claude-code-2.1.251-2.2.0.json");

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

  it("classifies an event missing from spec.events as unknown rather than confidently exact-list", () => {
    const sparseSpec: Spec = { ...REAL_SPEC, events: {} };
    expect(classifyMatcher(sparseSpec, IN_RANGE_VERSION, "PreToolUse", "Bash")).toBe(
      "unknown",
    );
  });

  it("* is Claude Code's match-everything wildcard, not an uncompilable regex", () => {
    expect(classifyMatcher(REAL_SPEC, IN_RANGE_VERSION, "PreToolUse", "*")).toBe(
      "unanchored-regex",
    );

    const hook = makeHook("PreToolUse", "*");
    const result = matchHooks(
      REAL_SPEC,
      IN_RANGE_VERSION,
      requestFor("PreToolUse", hook, "Bash"),
    );
    expect(result.firing).toEqual([hook]);
    expect(result.rejected).toEqual([]);
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

  it("a * matcher with no target never fires and is rejected, rather than throwing", () => {
    const hook = makeHook("PreToolUse", "*");
    expect(() =>
      matchHooks(
        REAL_SPEC,
        IN_RANGE_VERSION,
        requestFor("PreToolUse", hook, undefined),
      ),
    ).not.toThrow();

    const result = matchHooks(
      REAL_SPEC,
      IN_RANGE_VERSION,
      requestFor("PreToolUse", hook, undefined),
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
    expect(result.rejected[0]?.reason).toBe(
      "the detected Claude Code version is below a version-gated notation rule's sinceVersion",
    );
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
    expect(result.rejected[0]?.reason).toBe(
      "the detected Claude Code version is outside spec.claudeCodeRange",
    );
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

  it("an event missing from spec.events degrades to unknown, naming that as the reason", () => {
    const sparseSpec: Spec = { ...REAL_SPEC, events: {} };
    const hook = makeHook("PreToolUse", "Bash");
    const result = matchHooks(
      sparseSpec,
      IN_RANGE_VERSION,
      requestFor("PreToolUse", hook, "Bash"),
    );
    expect(result.firing).toEqual([]);
    expect(result.rejected).toEqual([
      {
        hook,
        kind: "unknown",
        reason:
          "the PreToolUse event is not described by this spec, so its matcher cannot be classified with confidence",
      },
    ]);
  });

  it("an undetermined version's reason names the undetermined version, not the range or sinceVersion cause", () => {
    const undetermined: VersionContext = { kind: "undetermined" };
    const hook = makeHook("PreToolUse", "Edit, Write");
    const result = matchHooks(
      REAL_SPEC,
      undetermined,
      requestFor("PreToolUse", hook, "Edit"),
    );
    expect(result.firing).toEqual([]);
    expect(result.rejected).toEqual([
      {
        hook,
        kind: "unknown",
        reason:
          "the Claude Code version could not be determined, and this matcher relies on a version-gated notation rule",
      },
    ]);
  });

  it("a matcherSyntax rule id colliding with Object.prototype (toString) is treated as gating nothing", () => {
    // Object.prototype.toString is a function, not a character string; the
    // old Record-indexed lookup would have read it through the prototype
    // chain instead of finding it absent. A Map has no such hazard, so this
    // rule id — even set to an implausibly high sinceVersion — must not
    // degrade an otherwise-supported tool-name exact-list matcher.
    const specWithPrototypeRule: Spec = {
      ...REAL_SPEC,
      matcherSyntax: {
        ...REAL_SPEC.matcherSyntax,
        rules: [
          ...REAL_SPEC.matcherSyntax.rules,
          { id: "toString", sinceVersion: "99.0.0" },
        ],
      },
    };
    expect(
      classifyMatcher(specWithPrototypeRule, IN_RANGE_VERSION, "PreToolUse", "Bash"),
    ).toBe("exact-list");
  });

  it("the hyphen/comma notation rules do not gate a field-target matcher, even under an undetermined version", () => {
    // PreModelSwitch's matcherTargets.kind is "field", not "tool-name" — the
    // domain the hyphen-exact-match and comma-separated-list rules describe.
    expect(REAL_SPEC.events["PreModelSwitch"]?.matcherTargets.kind).toBe("field");

    const undetermined: VersionContext = { kind: "undetermined" };
    expect(
      classifyMatcher(REAL_SPEC, undetermined, "PreModelSwitch", "claude-opus-5"),
    ).toBe("exact-list");
  });

  it("replays every spec.matcherTable row under an undetermined version, reconciled against the row's own sinceVersion", () => {
    const undetermined: VersionContext = { kind: "undetermined" };

    for (const row of REAL_SPEC.matcherTable) {
      const atKnownVersion = classifyMatcher(
        REAL_SPEC,
        IN_RANGE_VERSION,
        row.event as EventName,
        row.matcher,
      );
      const atUndetermined = classifyMatcher(
        REAL_SPEC,
        undetermined,
        row.event as EventName,
        row.matcher,
      );

      if (row.sinceVersion === null) {
        // The spec's own statement that this matcher is not version-gated:
        // an undetermined version must never degrade it.
        expect(atUndetermined, `${row.event} ${row.matcher} (sinceVersion: null)`).toBe(
          atKnownVersion,
        );
      } else if (atKnownVersion === "exact-list") {
        // Version-gated and classified exact-list at a known in-range
        // version: cannot be confirmed under an undetermined version, so it
        // must degrade.
        expect(
          atUndetermined,
          `${row.event} ${row.matcher} (sinceVersion: ${row.sinceVersion})`,
        ).toBe("unknown");
      } else {
        // A regex-classified matcher is never gated by the notation rules,
        // whatever its row's sinceVersion says.
        expect(
          atUndetermined,
          `${row.event} ${row.matcher} (sinceVersion: ${row.sinceVersion})`,
        ).toBe(atKnownVersion);
      }
    }
  });
});

describe("matcherTargets.kind: none", () => {
  // A `"none"` event has no matcher support at all, and Claude Code
  // silently ignores a `matcher` field on one of its hook declarations —
  // the hook still runs. This supersedes an earlier plan (issue #5's TDD
  // notes) to reject such a hook; see src/internal/spec/types.ts's
  // MatcherTargets doc for the authoritative behavior.
  it("an event with matcherTargets.kind: none fires a hook that declares a matcher, ignoring it", () => {
    expect(REAL_SPEC.events["Stop"]?.matcherTargets.kind).toBe("none");

    const hook = makeHook("Stop", "manual");
    const result = matchHooks(
      REAL_SPEC,
      IN_RANGE_VERSION,
      requestFor("Stop", hook, undefined),
    );

    expect(result.firing).toEqual([hook]);
    expect(result.rejected).toEqual([]);
    expect(result.matcherIgnored).toEqual([hook]);
  });

  it("an event with matcherTargets.kind: none still fires a hook that declares no matcher, and does not list it as matcherIgnored", () => {
    const hook = makeHook("Stop", undefined);
    const result = matchHooks(
      REAL_SPEC,
      IN_RANGE_VERSION,
      requestFor("Stop", hook, undefined),
    );

    expect(result.firing).toEqual([hook]);
    expect(result.rejected).toEqual([]);
    expect(result.matcherIgnored).toEqual([]);
  });

  it("a matcher-declaring firing hook under a matcher-supporting event is not listed as matcherIgnored", () => {
    const hook = makeHook("PreToolUse", "Bash");
    const result = matchHooks(
      REAL_SPEC,
      IN_RANGE_VERSION,
      requestFor("PreToolUse", hook, "Bash"),
    );

    expect(result.firing).toEqual([hook]);
    expect(result.matcherIgnored).toEqual([]);
  });
});
