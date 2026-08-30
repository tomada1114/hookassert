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
      expect(decision.source).toBe("exit-code");
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

describe("malformed JSON is not swallowed by a documented non-blocking exit code", () => {
  it("PreToolUse exit 1 with malformed stdout resolves to error/invalid-json, not pass", () => {
    // exit 1 is PreToolUse's documented `non-blocking-error` exit code: a
    // hook whose JSON writer crashed mid-output while still exiting 1 must
    // not be reported as a clean policy no-op.
    const outcome = makeOutcome({ exitCode: 1, stdout: "{oops" });
    const decision = resolveDecision(spec, "PreToolUse", outcome);
    expect(decision.kind).toBe("error");
    if (decision.kind === "error") {
      expect(decision.cause).toBe("invalid-json");
    }
  });

  it("an undocumented nonzero exit with malformed stdout still resolves to nonzero-exit-without-json", () => {
    // Contrast with the case above: an exit code the spec says nothing
    // about at all keeps its existing "no idea what this exit code means"
    // cause rather than being reinterpreted as an invalid-JSON failure.
    const decision = resolveDecision(
      spec,
      "PreToolUse",
      makeOutcome({ exitCode: 127, stdout: "{oops" }),
    );
    expect(decision.kind).toBe("error");
    if (decision.kind === "error") {
      expect(decision.cause).toBe("nonzero-exit-without-json");
    }
  });
});

describe("PostToolUse never resolves to deny even given exitCode 2", () => {
  it("PostToolUse is not blockable, and the real spec agrees exit 2 is non-blocking for it", () => {
    const decision = resolveDecision(spec, "PostToolUse", makeOutcome({ exitCode: 2 }));
    expect(decision.kind).not.toBe("deny");
    expect(decision.kind).toBe("pass");
  });

  it("treats a block effect on a non-blockable event as a spec contradiction, not the hook's fault", () => {
    // The shipped spec never actually pairs a "block" effect with a
    // non-blockable event, so this exercises resolveDecision's defensive
    // guard directly with a hand-built, self-contradictory event entry. The
    // spec entry is what is wrong here, not the hook's own JSON, so this
    // resolves to `unknown` rather than `error/schema-violation` — that
    // cause is reserved for a hook's own output failing to match what the
    // event documents.
    const contradictorySpec = specWithOverriddenEvent(spec, "PostToolUse", {
      blockable: false,
      exitCodeEffects: [{ exitCode: 2, effect: "block", stderrTo: "user" }],
    });
    const decision = resolveDecision(
      contradictorySpec,
      "PostToolUse",
      makeOutcome({ exitCode: 2 }),
    );
    expect(decision.kind).toBe("unknown");
    if (decision.kind === "unknown") {
      expect(decision.reasons[0]).toEqual({
        kind: "contradictory-exit-code-effect",
        event: "PostToolUse",
        exitCode: 2,
      });
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

describe("the JSON decision channel is gated on jsonDecisions, not blockable", () => {
  it("PermissionRequest denies via JSON despite being blockable: false", () => {
    const outcome = makeOutcome({
      stdout: JSON.stringify({ permissionDecision: "deny" }),
    });
    const decision = resolveDecision(spec, "PermissionRequest", outcome);
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.source).toBe("permission-decision");
    }
  });

  it("PermissionRequest allows via JSON despite being blockable: false", () => {
    const outcome = makeOutcome({
      stdout: JSON.stringify({ permissionDecision: "allow" }),
    });
    const decision = resolveDecision(spec, "PermissionRequest", outcome);
    expect(decision.kind).toBe("allow");
  });

  it.each([["PostToolUse"], ["PostToolUseFailure"]] as const)(
    '%s denies via a top-level `decision: "block"` payload despite being blockable: false',
    (event) => {
      const outcome = makeOutcome({
        stdout: JSON.stringify({ decision: "block", reason: "policy violation" }),
      });
      const decision = resolveDecision(spec, event, outcome);
      expect(decision.kind).toBe("deny");
      if (decision.kind === "deny") {
        expect(decision.source).toBe("permission-decision");
      }
    },
  );
});

describe("the decision value is read from hookSpecificOutput.permissionDecision, top-level decision, or top-level permissionDecision, in that order", () => {
  it("reads hookSpecificOutput.permissionDecision for PreToolUse", () => {
    const outcome = makeOutcome({
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
      }),
    });
    const decision = resolveDecision(spec, "PreToolUse", outcome);
    expect(decision.kind).toBe("deny");
  });

  it("reads a top-level decision when hookSpecificOutput carries no permissionDecision", () => {
    const outcome = makeOutcome({
      stdout: JSON.stringify({ decision: "block" }),
    });
    const decision = resolveDecision(spec, "Stop", outcome);
    expect(decision.kind).toBe("deny");
  });

  it("falls back to a top-level permissionDecision when neither of the other two locations is present", () => {
    const outcome = makeOutcome({
      stdout: JSON.stringify({ permissionDecision: "allow" }),
    });
    const decision = resolveDecision(spec, "PreToolUse", outcome);
    expect(decision.kind).toBe("allow");
  });

  it("prefers hookSpecificOutput.permissionDecision over a conflicting top-level decision", () => {
    const outcome = makeOutcome({
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
        },
        decision: "block",
      }),
    });
    const decision = resolveDecision(spec, "PreToolUse", outcome);
    expect(decision.kind).toBe("allow");
  });

  it("falls through to top-level decision when hookSpecificOutput is present but carries no permissionDecision key", () => {
    const outcome = makeOutcome({
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse" },
        decision: "deny",
      }),
    });
    const decision = resolveDecision(spec, "PreToolUse", outcome);
    expect(decision.kind).toBe("deny");
  });
});

describe("deny-shaped and allow-shaped jsonDecisions values are derived per event", () => {
  it.each([
    ["accept", "allow"],
    ["decline", "deny"],
    ["cancel", "deny"],
  ] as const)(
    "Elicitation permissionDecision %s resolves to %s",
    (value, expectedKind) => {
      const outcome = makeOutcome({
        stdout: JSON.stringify({ permissionDecision: value }),
      });
      const decision = resolveDecision(spec, "Elicitation", outcome);
      expect(decision.kind).toBe(expectedKind);
    },
  );
});

describe("resolveDecision when the loaded spec and EventName have drifted apart", () => {
  it("returns unknown/event-not-in-spec rather than throwing", () => {
    const incompleteSpec = specWithoutEvent(spec, "PostToolUse");
    const decision = resolveDecision(incompleteSpec, "PostToolUse", makeOutcome());
    expect(decision.kind).toBe("unknown");
    if (decision.kind === "unknown") {
      expect(decision.reasons[0]).toEqual({
        kind: "event-not-in-spec",
        event: "PostToolUse",
        specVersion: spec.specVersion,
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
    const bySource: Record<"exit-code" | "permission-decision", Decision> = {
      "exit-code": denied("exit-code", 2),
      "permission-decision": denied("permission-decision", 0),
    };
    expect(bySource["exit-code"]).toEqual({
      kind: "deny",
      source: "exit-code",
      exitCode: 2,
    });
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
