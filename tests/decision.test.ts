import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  allowed,
  denied,
  errored,
  exit2OverridesAllowJson,
  passed,
  resolveDecision,
  unknownDecision,
} from "../src/internal/decision/index.js";
import type { EventSpec, Spec } from "../src/internal/spec/index.js";
import { loadSpecFile } from "../src/internal/spec/index.js";
import type { Decision, EventName, ExecOutcome, UnknownReason } from "../src/types.js";

// Reaching src/internal/decision/ and src/internal/spec/ directly (rather
// than through src/index.ts's exports, per the writing-tests skill) is a
// deliberate, narrowly scoped exception: neither module has a public runtime
// surface in this issue and won't have one until a later executor issue's
// composition root wires them in — see eslint.config.mjs's
// "tests/static-layer-unit-tests" block for the full reasoning. The
// *published types* (`Decision`, `UnknownReason`, `ExecOutcome`) are already
// part of the public contract, so those come from "../src/types.js" like any
// other type test's imports.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REAL_SPEC_PATH = path.join(REPO_ROOT, "spec", "claude-code-2.1.251-2.2.0.json");
const spec = loadSpecFile(REAL_SPEC_PATH);

function makeOutcome(overrides: Partial<ExecOutcome> = {}): ExecOutcome {
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...overrides };
}

/** `spec` with `event`'s own entry removed entirely, for the "spec/EventName drift" cases. */
function specWithoutEvent(base: Spec, event: EventName): Spec {
  const events = Object.fromEntries(
    Object.entries(base.events).filter(([name]) => name !== event),
  );
  return { ...base, events };
}

/** `spec` with `event`'s entry replaced by one that contradicts its real data. */
function specWithOverriddenEvent(
  base: Spec,
  event: EventName,
  overrides: Partial<EventSpec>,
): Spec {
  const current = base.events[event];
  if (current === undefined) {
    throw new Error(`fixture setup: spec is missing ${event}`);
  }
  return { ...base, events: { ...base.events, [event]: { ...current, ...overrides } } };
}

/**
 * Every (event, exitCodeEffects row) pair the real spec declares, flattened
 * for `it.each`. Built from the loaded spec rather than hand-transcribed, on
 * purpose: this is the table `resolveDecision` must agree with, not a value
 * it computes the same way it does internally.
 */
const exitCodeEffectCases = Object.entries(spec.events).flatMap(([event, eventSpec]) =>
  eventSpec.exitCodeEffects.map((effect) => ({
    event: event as EventName,
    exitCode: effect.exitCode,
    effect: effect.effect,
  })),
);

describe("resolveDecision: every event's documented exitCodeEffects", () => {
  it.each(exitCodeEffectCases)(
    "$event exitCode $exitCode ($effect) resolves to the matching Decision.kind",
    ({ event, exitCode, effect }) => {
      const outcome = makeOutcome({ exitCode });
      const decision = resolveDecision(spec, event, outcome);
      const expectedKind = effect === "block" ? "deny" : "pass";
      expect(decision.kind).toBe(expectedKind);
    },
  );
});

describe("table-health: the generated exitCodeEffects cases are not empty", () => {
  it("every event has at least one exitCodeEffects row", () => {
    for (const [name, eventSpec] of Object.entries(spec.events)) {
      expect(
        eventSpec.exitCodeEffects.length,
        `${name} has no exitCodeEffects rows`,
      ).toBeGreaterThan(0);
    }
  });

  it("the generated it.each table covers every event in the spec", () => {
    const coveredEvents = new Set(
      exitCodeEffectCases.map((testCase) => testCase.event),
    );
    for (const name of Object.keys(spec.events)) {
      expect(
        coveredEvents.has(name as EventName),
        `${name} has no generated test case`,
      ).toBe(true);
    }
  });
});

describe("a policy hook that exits 1 resolves to pass, not deny", () => {
  it("PreToolUse exiting 1 is a no-op, not a block", () => {
    const decision = resolveDecision(spec, "PreToolUse", makeOutcome({ exitCode: 1 }));
    expect(decision.kind).toBe("pass");
    if (decision.kind === "pass") {
      expect(decision.exitCode).toBe(1);
    }
  });
});

describe("exit 2 vs. an allow JSON payload", () => {
  it("exit 2 overrides an allow JSON payload and resolves to deny, with the override detectable on the result", () => {
    const outcome = makeOutcome({
      exitCode: 2,
      stdout: JSON.stringify({ permissionDecision: "allow" }),
    });
    const decision = resolveDecision(spec, "PreToolUse", outcome);
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.source).toBe("exit-2");
    }
    expect(exit2OverridesAllowJson(spec, "PreToolUse", outcome)).toBe(true);
  });

  it("an allow JSON payload without exit 2 resolves to allow, with no override", () => {
    const outcome = makeOutcome({
      exitCode: 0,
      stdout: JSON.stringify({ permissionDecision: "allow" }),
    });
    const decision = resolveDecision(spec, "PreToolUse", outcome);
    expect(decision.kind).toBe("allow");
    expect(exit2OverridesAllowJson(spec, "PreToolUse", outcome)).toBe(false);
  });

  it("exit 2 with no JSON payload denies without an override", () => {
    const outcome = makeOutcome({ exitCode: 2 });
    const decision = resolveDecision(spec, "PreToolUse", outcome);
    expect(decision.kind).toBe("deny");
    expect(exit2OverridesAllowJson(spec, "PreToolUse", outcome)).toBe(false);
  });

  it("exit2OverridesAllowJson is false when the outcome did not exit 2", () => {
    const outcome = makeOutcome({
      exitCode: 1,
      stdout: JSON.stringify({ permissionDecision: "allow" }),
    });
    expect(exit2OverridesAllowJson(spec, "PreToolUse", outcome)).toBe(false);
  });

  it("exit2OverridesAllowJson is false for an undocumented exit code", () => {
    expect(
      exit2OverridesAllowJson(spec, "PreToolUse", makeOutcome({ exitCode: 42 })),
    ).toBe(false);
  });

  it("exit2OverridesAllowJson is false when the hook timed out", () => {
    const outcome = makeOutcome({
      exitCode: 2,
      timedOut: true,
      stdout: JSON.stringify({ permissionDecision: "allow" }),
    });
    expect(exit2OverridesAllowJson(spec, "PreToolUse", outcome)).toBe(false);
  });

  it("exit2OverridesAllowJson is false when the spec is missing the event", () => {
    const incompleteSpec = specWithoutEvent(spec, "PreToolUse");
    const outcome = makeOutcome({
      exitCode: 2,
      stdout: JSON.stringify({ permissionDecision: "allow" }),
    });
    expect(exit2OverridesAllowJson(incompleteSpec, "PreToolUse", outcome)).toBe(false);
  });
});

describe("a JSON permissionDecision denies on a blockable event even without exit 2", () => {
  it("PreToolUse exiting 0 with a deny JSON payload still resolves to deny", () => {
    const outcome = makeOutcome({
      exitCode: 0,
      stdout: JSON.stringify({ permissionDecision: "deny" }),
    });
    const decision = resolveDecision(spec, "PreToolUse", outcome);
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.source).toBe("permission-decision");
    }
  });
});

describe("a timed-out PreToolUse hook does not resolve to deny", () => {
  it("timing out is not the same as exit 2", () => {
    const decision = resolveDecision(
      spec,
      "PreToolUse",
      makeOutcome({ exitCode: 2, timedOut: true }),
    );
    expect(decision.kind).not.toBe("deny");
    expect(decision.kind).toBe("pass");
  });
});

describe("a non-zero, non-2 exit with no valid JSON resolves to error", () => {
  it.each([
    ["malformed JSON-looking stdout", "{not valid json"],
    ["empty stdout", ""],
  ])(
    "exitCode 127 with %s resolves to error/nonzero-exit-without-json",
    (_label, stdout) => {
      const decision = resolveDecision(
        spec,
        "PreToolUse",
        makeOutcome({ exitCode: 127, stdout }),
      );
      expect(decision.kind).toBe("error");
      if (decision.kind === "error") {
        expect(decision.cause).toBe("nonzero-exit-without-json");
      }
    },
  );
});

describe("stdout JSON that fails schema validation resolves to error with cause schema-violation", () => {
  it("a permissionDecision value the event does not document", () => {
    const outcome = makeOutcome({
      exitCode: 0,
      stdout: JSON.stringify({ permissionDecision: "maybe" }),
    });
    const decision = resolveDecision(spec, "PreToolUse", outcome);
    expect(decision.kind).toBe("error");
    if (decision.kind === "error") {
      expect(decision.cause).toBe("schema-violation");
    }
  });

  it("a permissionDecision value that is not a string", () => {
    const outcome = makeOutcome({
      exitCode: 0,
      stdout: JSON.stringify({ permissionDecision: 1 }),
    });
    const decision = resolveDecision(spec, "PreToolUse", outcome);
    expect(decision.kind).toBe("error");
    if (decision.kind === "error") {
      expect(decision.cause).toBe("schema-violation");
    }
  });
});

describe("exit 0 with malformed JSON-looking stdout resolves to error with cause invalid-json", () => {
  it("a successful exit that tried and failed to emit JSON", () => {
    const outcome = makeOutcome({ exitCode: 0, stdout: "{not valid json" });
    const decision = resolveDecision(spec, "PreToolUse", outcome);
    expect(decision.kind).toBe("error");
    if (decision.kind === "error") {
      expect(decision.cause).toBe("invalid-json");
    }
  });
});

describe("PostToolUse never resolves to deny even given exitCode 2", () => {
  it("PostToolUse is not blockable, and the real spec agrees exit 2 is non-blocking for it", () => {
    const decision = resolveDecision(spec, "PostToolUse", makeOutcome({ exitCode: 2 }));
    expect(decision.kind).not.toBe("deny");
    expect(decision.kind).toBe("pass");
  });

  it("treats a block effect on a non-blockable event as a contract violation, not a deny", () => {
    // The shipped spec never actually pairs a "block" effect with a
    // non-blockable event, so this exercises resolveDecision's defensive
    // guard directly with a hand-built, self-contradictory event entry.
    const contradictorySpec = specWithOverriddenEvent(spec, "PostToolUse", {
      blockable: false,
      exitCodeEffects: [{ exitCode: 2, effect: "block", stderrTo: "user" }],
    });
    const decision = resolveDecision(
      contradictorySpec,
      "PostToolUse",
      makeOutcome({ exitCode: 2 }),
    );
    expect(decision.kind).toBe("error");
    if (decision.kind === "error") {
      expect(decision.cause).toBe("schema-violation");
    }
  });
});

describe("JSON decisions outside deny/allow fall through to the normal flow", () => {
  it("a recognized decision value that is neither deny/block nor allow resolves to pass", () => {
    const outcome = makeOutcome({
      exitCode: 0,
      stdout: JSON.stringify({ permissionDecision: "ask" }),
    });
    const decision = resolveDecision(spec, "PreToolUse", outcome);
    expect(decision.kind).toBe("pass");
  });

  it("a block permissionDecision on a non-blockable event resolves to pass, not deny", () => {
    const outcome = makeOutcome({
      exitCode: 0,
      stdout: JSON.stringify({ permissionDecision: "block" }),
    });
    const decision = resolveDecision(spec, "PostToolUse", outcome);
    expect(decision.kind).toBe("pass");
  });

  it("valid JSON with no permissionDecision key resolves to pass, not an error", () => {
    const outcome = makeOutcome({
      exitCode: 0,
      stdout: JSON.stringify({ foo: "bar" }),
    });
    const decision = resolveDecision(spec, "PreToolUse", outcome);
    expect(decision.kind).toBe("pass");
  });

  it("a JSON array on stdout resolves to pass, not schema-violation", () => {
    const outcome = makeOutcome({ exitCode: 0, stdout: "[1,2,3]" });
    const decision = resolveDecision(spec, "PreToolUse", outcome);
    expect(decision.kind).toBe("pass");
  });

  it("exit 0 with empty stdout resolves to pass", () => {
    const decision = resolveDecision(spec, "PreToolUse", makeOutcome({ exitCode: 0 }));
    expect(decision.kind).toBe("pass");
    if (decision.kind === "pass") {
      expect(decision.exitCode).toBe(0);
    }
  });
});

describe("resolveDecision when the loaded spec and EventName have drifted apart", () => {
  it("returns unknown/version-out-of-spec-range rather than throwing", () => {
    const incompleteSpec = specWithoutEvent(spec, "PostToolUse");
    const decision = resolveDecision(incompleteSpec, "PostToolUse", makeOutcome());
    expect(decision.kind).toBe("unknown");
    if (decision.kind === "unknown") {
      expect(decision.reasons[0]).toEqual({
        kind: "version-out-of-spec-range",
        detected: "PostToolUse",
        specRange: spec.claudeCodeRange,
      });
    }
  });
});

describe("unknownDecision requires at least one UnknownReason", () => {
  it("unknownDecision(reason) builds a decision carrying exactly that reason", () => {
    const reason: UnknownReason = {
      kind: "plugin-hooks-present",
      files: ["/home/dev/project/.claude-plugin/hooks.json"],
    };
    const decision = unknownDecision(reason);
    expect(decision).toEqual({ kind: "unknown", reasons: [reason] });
  });

  it("unknownDecision(first, ...rest) carries every reason passed to it", () => {
    const first: UnknownReason = {
      kind: "managed-settings-assumed",
      path: "/etc/claude-code/managed-settings.json",
    };
    const second: UnknownReason = {
      kind: "version-undetermined",
      triedSources: ["cli-flag", "environment-variable"],
    };
    const decision = unknownDecision(first, second);
    expect(decision).toEqual({ kind: "unknown", reasons: [first, second] });
  });
});

describe("factory functions build exactly the Decision shape they name", () => {
  it("denied carries its source and exit code", () => {
    const bySource: Record<"exit-2" | "permission-decision", Decision> = {
      "exit-2": denied("exit-2", 2),
      "permission-decision": denied("permission-decision", 0),
    };
    expect(bySource["exit-2"]).toEqual({ kind: "deny", source: "exit-2", exitCode: 2 });
    expect(bySource["permission-decision"]).toEqual({
      kind: "deny",
      source: "permission-decision",
      exitCode: 0,
    });
  });

  it("allowed carries its exit code", () => {
    expect(allowed(0)).toEqual({ kind: "allow", exitCode: 0 });
  });

  it("passed carries its exit code", () => {
    expect(passed(1)).toEqual({ kind: "pass", exitCode: 1 });
  });

  it("errored carries its exit code and cause", () => {
    expect(errored(127, "nonzero-exit-without-json")).toEqual({
      kind: "error",
      exitCode: 127,
      cause: "nonzero-exit-without-json",
    });
  });
});
