import { describe, expect, it } from "vitest";

import { assertCase, summarize } from "../src/internal/assert/index.js";
import type { CaseObservation } from "../src/internal/assert/index.js";
import type { FixtureCase, FixtureExpectation } from "../src/internal/fixture/index.js";
import type { MatcherOutcome } from "../src/internal/matcher/index.js";
import type {
  CaseResult,
  EventName,
  ExecOutcome,
  PayloadOrigin,
  Provenance,
  ResolvedHook,
  UnknownReason,
} from "../src/types.js";

// Reaching src/internal/assert/, src/internal/fixture/, and
// src/internal/matcher/ directly (rather than through src/index.ts's
// exports, per the writing-tests skill) is a deliberate, narrowly scoped
// exception: none of these modules has a public runtime surface in this
// issue and assertCase/summarize won't have one until a later `test`-command
// issue's composition root wires them in — see eslint.config.mjs's
// "tests/static-layer-unit-tests" block for the full reasoning. The
// *published types* (`CaseResult`, `Summary`, `ExecOutcome`, `PayloadOrigin`,
// `UnknownReason`, ...) are already part of the public contract, so those
// come from "../src/types.js" like any other type test's imports.

let nextOffset = 0;

function makeHook(overrides: Partial<ResolvedHook> = {}): ResolvedHook {
  const provenance: Provenance = {
    file: "/fake/settings.json",
    layer: "project",
    line: 1,
    col: 1,
    offset: nextOffset++,
  };
  return {
    event: "PreToolUse",
    matcher: "Bash",
    command: "./hook.sh",
    args: undefined,
    timeoutMs: undefined,
    provenance,
    dedupeKey: `PreToolUse::./hook.sh::${String(nextOffset)}`,
    ...overrides,
  };
}

function makeExpect(overrides: Partial<FixtureExpectation> = {}): FixtureExpectation {
  return {
    fires: undefined,
    decision: undefined,
    exitCode: undefined,
    stdoutContains: undefined,
    stderrContains: undefined,
    context: undefined,
    updatedInput: undefined,
    timedOut: undefined,
    ...overrides,
  };
}

function makeCase(overrides: Partial<FixtureCase> = {}): FixtureCase {
  return {
    event: "PreToolUse",
    tool: undefined,
    input: undefined,
    origin: { kind: "synthetic" },
    expect: makeExpect(),
    stub: undefined,
    dryRun: undefined,
    cwd: undefined,
    ...overrides,
  };
}

function makeObservation(overrides: Partial<CaseObservation> = {}): CaseObservation {
  return {
    decision: undefined,
    execOutcome: undefined,
    rejectedByMatcher: [],
    excludedHooks: [],
    ...overrides,
  };
}

function makeExecOutcome(overrides: Partial<ExecOutcome> = {}): ExecOutcome {
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...overrides };
}

function expectFail(result: CaseResult): Extract<CaseResult, { kind: "fail" }> {
  if (result.kind !== "fail") {
    throw new Error(`expected a fail CaseResult, got ${result.kind}`);
  }
  return result;
}

function expectUnknown(result: CaseResult): Extract<CaseResult, { kind: "unknown" }> {
  if (result.kind !== "unknown") {
    throw new Error(`expected an unknown CaseResult, got ${result.kind}`);
  }
  return result;
}

function expectSkipped(result: CaseResult): Extract<CaseResult, { kind: "skipped" }> {
  if (result.kind !== "skipped") {
    throw new Error(`expected a skipped CaseResult, got ${result.kind}`);
  }
  return result;
}

describe("assertCase: expectation diffing", () => {
  it("a case whose hook fired but returned a different decision than expected produces a fail CaseResult with a non-empty diffs array", () => {
    const caseData = makeCase({ expect: makeExpect({ decision: "deny" }) });
    const observation = makeObservation({
      decision: { kind: "pass", exitCode: 0 },
    });

    const result = expectFail(assertCase(caseData, observation));

    expect(result.diffs.length).toBeGreaterThan(0);
    expect(result.nonFiring).toBeUndefined();
  });

  it("the diff data is sufficient to render 'expected deny / actual pass' style text", () => {
    const caseData = makeCase({ expect: makeExpect({ decision: "deny" }) });
    const observation = makeObservation({
      decision: { kind: "pass", exitCode: 0 },
    });

    const result = expectFail(assertCase(caseData, observation));

    expect(result.diffs).toContainEqual({
      field: "decision",
      expectedDecision: "deny",
      actualDecision: "pass",
    });
  });

  it.each([
    ["exitCode", makeExpect({ exitCode: 2 }), { kind: "pass", exitCode: 0 } as const],
    [
      "stdoutContains",
      makeExpect({ stdoutContains: "blocked" }),
      { kind: "allow", exitCode: 0 } as const,
    ],
    [
      "stderrContains",
      makeExpect({ stderrContains: "oops" }),
      { kind: "allow", exitCode: 0 } as const,
    ],
    [
      "timedOut",
      makeExpect({ timedOut: true }),
      { kind: "allow", exitCode: 0 } as const,
    ],
    ["fires", makeExpect({ fires: false }), { kind: "allow", exitCode: 0 } as const],
  ])(
    "a mismatched %s expectation produces a diff on that field",
    (field, expectation, decision) => {
      const caseData = makeCase({ expect: expectation });
      const observation = makeObservation({
        decision,
        execOutcome: makeExecOutcome(),
      });

      const result = expectFail(assertCase(caseData, observation));

      expect(result.diffs.some((diff) => diff.field === field)).toBe(true);
    },
  );

  it("a case whose expectation is fully met produces a pass CaseResult", () => {
    const caseData = makeCase({
      expect: makeExpect({
        fires: true,
        decision: "deny",
        exitCode: 2,
        stdoutContains: "blocked",
        stderrContains: "reason",
        timedOut: false,
      }),
    });
    const observation = makeObservation({
      decision: { kind: "deny", source: "exit-code", exitCode: 2 },
      execOutcome: makeExecOutcome({
        exitCode: 2,
        stdout: "action blocked by policy",
        stderr: "reason: not allowed",
        timedOut: false,
      }),
    });

    const result = assertCase(caseData, observation);

    expect(result.kind).toBe("pass");
  });

  it("a case with no expectations at all, whose hook did not fire, produces a pass CaseResult", () => {
    const caseData = makeCase();
    const result = assertCase(caseData, makeObservation());

    expect(result.kind).toBe("pass");
  });

  it("expect.timedOut defaults the actual value to false when the fired hook carries no execOutcome", () => {
    const caseData = makeCase({ expect: makeExpect({ timedOut: true }) });
    const observation = makeObservation({
      decision: { kind: "allow", exitCode: 0 },
      execOutcome: undefined,
    });

    const result = expectFail(assertCase(caseData, observation));

    expect(result.diffs).toContainEqual({
      field: "timedOut",
      expectedTimedOut: true,
      actualTimedOut: false,
    });
  });
});

describe("assertCase: non-firing explanations", () => {
  it("a case declaring expect.fires: true whose hook did not fire produces a fail CaseResult with nonFiring set", () => {
    const caseData = makeCase({ expect: makeExpect({ fires: true }) });

    const result = expectFail(assertCase(caseData, makeObservation()));

    expect(result.diffs).toEqual([]);
    expect(result.nonFiring).toBeDefined();
  });

  it("nonFiring reports matcher-did-not-match when a candidate hook was rejected by the matcher", () => {
    const caseData = makeCase({ expect: makeExpect({ fires: true }) });
    const outcome: MatcherOutcome = {
      hook: makeHook(),
      kind: "exact-list",
      reason: "evaluated as an exact-match list and did not match Bash",
    };
    const observation = makeObservation({ rejectedByMatcher: [outcome] });

    const result = expectFail(assertCase(caseData, observation));
    const { nonFiring } = result;
    if (nonFiring === undefined) {
      throw new Error("expected nonFiring to be set");
    }

    expect(nonFiring.kind).toBe("matcher-did-not-match");
    if (nonFiring.kind === "matcher-did-not-match") {
      expect(nonFiring.hooks).toEqual([{ hook: outcome.hook, reason: outcome.reason }]);
    }
  });

  it("nonFiring reports excluded-settings-layer when a hook exists only in a settings layer this fixture did not include", () => {
    const caseData = makeCase({ expect: makeExpect({ fires: true }) });
    const excludedHook = makeHook();
    const observation = makeObservation({ excludedHooks: [excludedHook] });

    const result = expectFail(assertCase(caseData, observation));
    const { nonFiring } = result;
    if (nonFiring === undefined) {
      throw new Error("expected nonFiring to be set");
    }

    expect(nonFiring.kind).toBe("excluded-settings-layer");
    if (nonFiring.kind === "excluded-settings-layer") {
      expect(nonFiring.hooks).toEqual([excludedHook]);
    }
  });

  it("nonFiring reports no-hook-configured when nothing is declared under the event at all", () => {
    const event: EventName = "SessionStart";
    const caseData = makeCase({ event, expect: makeExpect({ fires: true }) });

    const result = expectFail(assertCase(caseData, makeObservation()));
    const { nonFiring } = result;
    if (nonFiring === undefined) {
      throw new Error("expected nonFiring to be set");
    }

    expect(nonFiring).toEqual({ kind: "no-hook-configured", event });
  });

  it("nonFiring prefers matcher-did-not-match over excluded-settings-layer when both are present", () => {
    const caseData = makeCase({ expect: makeExpect({ fires: true }) });
    const outcome: MatcherOutcome = {
      hook: makeHook(),
      kind: "unanchored-regex",
      reason: "evaluated as an unanchored regex and did not match",
    };
    const observation = makeObservation({
      rejectedByMatcher: [outcome],
      excludedHooks: [makeHook()],
    });

    const result = expectFail(assertCase(caseData, observation));
    expect(result.nonFiring?.kind).toBe("matcher-did-not-match");
  });
});

describe("assertCase: unresolved decisions", () => {
  it("a case whose Decision could not be resolved produces an unknown CaseResult carrying at least one UnknownReason", () => {
    const caseData = makeCase({ expect: makeExpect({ fires: true }) });
    const reason: UnknownReason = {
      kind: "version-out-of-spec-range",
      detected: "9.9.9",
      specRange: ">=2.1.251 <2.2.0",
    };
    const observation = makeObservation({
      decision: { kind: "unknown", reasons: [reason] },
    });

    const result = expectUnknown(assertCase(caseData, observation));

    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons).toEqual([reason]);
  });

  it("an unknown Decision produces an unknown CaseResult even when the fixture expected fires: false", () => {
    // The fixture's own expectation is irrelevant once nothing can be
    // asserted with confidence at all — see assertCase's own remark.
    const caseData = makeCase({ expect: makeExpect({ fires: false }) });
    const reason: UnknownReason = {
      kind: "plugin-hooks-present",
      files: ["/etc/plugin.json"],
    };
    const observation = makeObservation({
      decision: { kind: "unknown", reasons: [reason] },
    });

    const result = assertCase(caseData, observation);

    expect(result.kind).toBe("unknown");
  });
});

describe("assertCase: skipped cases", () => {
  it("a dry-run case produces a skipped CaseResult with reason dry-run", () => {
    const caseData = makeCase({ dryRun: true });

    const result = expectSkipped(assertCase(caseData, makeObservation()));

    expect(result.reason).toBe("dry-run");
  });

  it("a stub-only case (stub declared, no expectation) produces a skipped CaseResult with reason stub-only", () => {
    const caseData = makeCase({ stub: { "./notify.sh": { exitCode: 0 } } });

    const result = expectSkipped(assertCase(caseData, makeObservation()));

    expect(result.reason).toBe("stub-only");
  });

  it("dry-run takes precedence over stub-only when both apply", () => {
    const caseData = makeCase({
      dryRun: true,
      stub: { "./notify.sh": { exitCode: 0 } },
    });

    const result = expectSkipped(assertCase(caseData, makeObservation()));

    expect(result.reason).toBe("dry-run");
  });

  it("a case that declares a stub but also an expectation is not treated as stub-only", () => {
    const caseData = makeCase({
      stub: { "./notify.sh": { exitCode: 0 } },
      expect: makeExpect({ fires: true }),
    });

    const result = assertCase(caseData, makeObservation());

    expect(result.kind).toBe("fail");
  });
});

const recordedOrigin: PayloadOrigin = {
  kind: "recorded",
  capturedAt: "2026-01-01T00:00:00Z",
  sourceFile: "/abs/envelope.json",
  claudeVersion: undefined,
};
const syntheticOrigin: PayloadOrigin = { kind: "synthetic" };

describe("summarize", () => {
  it("folds pass+fail into asserted, counts recorded-origin passes/fails into fromRecorded, and counts unknown/skipped separately", () => {
    const results: CaseResult[] = [
      { kind: "pass", origin: syntheticOrigin },
      { kind: "pass", origin: recordedOrigin },
      { kind: "fail", origin: recordedOrigin, diffs: [], nonFiring: undefined },
      { kind: "fail", origin: syntheticOrigin, diffs: [], nonFiring: undefined },
      {
        kind: "unknown",
        origin: syntheticOrigin,
        reasons: [{ kind: "plugin-hooks-present", files: [] }],
      },
      { kind: "skipped", origin: syntheticOrigin, reason: "dry-run" },
      { kind: "skipped", origin: recordedOrigin, reason: "stub-only" },
    ];

    const summary = summarize(results);

    expect(summary).toEqual({
      asserted: 4,
      fromRecorded: 2,
      failed: 2,
      unknown: 1,
      skipped: 2,
    });
  });

  it("returns every field zeroed for an empty result list", () => {
    expect(summarize([])).toEqual({
      asserted: 0,
      fromRecorded: 0,
      failed: 0,
      unknown: 0,
      skipped: 0,
    });
  });

  it("never double-counts a case across two Summary fields", () => {
    const results: CaseResult[] = [
      { kind: "pass", origin: syntheticOrigin },
      { kind: "pass", origin: recordedOrigin },
      { kind: "fail", origin: syntheticOrigin, diffs: [], nonFiring: undefined },
      {
        kind: "unknown",
        origin: syntheticOrigin,
        reasons: [{ kind: "plugin-hooks-present", files: [] }],
      },
      { kind: "skipped", origin: syntheticOrigin, reason: "dry-run" },
    ];

    const summary = summarize(results);

    // asserted, unknown, and skipped are the three disjoint buckets every
    // result falls into exactly once; failed and fromRecorded are
    // sub-counts of asserted, not additional buckets.
    expect(summary.asserted + summary.unknown + summary.skipped).toBe(results.length);
    expect(summary.failed).toBeLessThanOrEqual(summary.asserted);
    expect(summary.fromRecorded).toBeLessThanOrEqual(summary.asserted);
  });
});
