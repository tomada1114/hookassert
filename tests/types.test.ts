import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  Decision,
  EventName,
  ExecOutcome,
  Provenance,
  ResolvedHook,
  SettingsLayer,
  UnknownReason,
  VersionSourceName,
} from "../src/index.js";

// These are compile-time assertions about the public surface. They run under
// Vitest so a broken type contract fails the same gate as a broken behavior,
// while tests/package.test.ts checks the *published declarations* from a
// consumer's point of view.
//
// src/index.ts publishes types and nothing else for now, so this file carries
// the whole contract: tests/index.test.ts can only observe that the emitted
// module is empty.

/** A complete, valid provenance record, reused by the ResolvedHook cases. */
const provenance: Provenance = {
  file: "/home/dev/project/.claude/settings.json",
  layer: "project",
  line: 12,
  col: 7,
  offset: 214,
};

describe("EventName", () => {
  it("accepts PreToolUse and rejects an arbitrary string", () => {
    expectTypeOf<"PreToolUse">().toExtend<EventName>();
    // Paired with the rejection below so the `@ts-expect-error` cannot be
    // satisfied by the union having quietly widened to `string`.
    expectTypeOf<EventName>().not.toEqualTypeOf<string>();

    // Declared but never invoked: the assertion is that this body fails to
    // compile without the `@ts-expect-error` comment.
    const rejected = (): void => {
      // @ts-expect-error an undocumented event name is a typo, not an extension point
      const event: EventName = "PreToolUsage";
      void event;
    };
    expect(rejected).toBeTypeOf("function");
  });

  it("lists exactly the events transcribed from the hooks documentation", () => {
    expectTypeOf<EventName>().toEqualTypeOf<
      | "SessionStart"
      | "Setup"
      | "InstructionsLoaded"
      | "UserPromptSubmit"
      | "UserPromptExpansion"
      | "MessageDisplay"
      | "PreToolUse"
      | "PermissionRequest"
      | "PostToolUse"
      | "PostToolUseFailure"
      | "PostToolBatch"
      | "PermissionDenied"
      | "Notification"
      | "SubagentStart"
      | "SubagentStop"
      | "TaskCreated"
      | "TaskCompleted"
      | "Stop"
      | "StopFailure"
      | "TeammateIdle"
      | "ConfigChange"
      | "CwdChanged"
      | "DirectoryAdded"
      | "FileChanged"
      | "WorktreeCreate"
      | "WorktreeRemove"
      | "PreCompact"
      | "PostCompact"
      | "PreModelSwitch"
      | "PostModelSwitch"
      | "SessionEnd"
      | "Elicitation"
      | "ElicitationResult"
    >();
  });
});

describe("SettingsLayer", () => {
  it("names the three merged layers plus an explicitly passed file", () => {
    expectTypeOf<SettingsLayer>().toEqualTypeOf<
      "user" | "project" | "local" | "explicit"
    >();
  });

  it("rejects a settings layer that is not one of the four", () => {
    const rejected = (): void => {
      // @ts-expect-error "global" is not one of the layers hookassert merges
      const layer: SettingsLayer = "global";
      void layer;
    };
    expect(rejected).toBeTypeOf("function");
  });
});

describe("Provenance", () => {
  it("requires file, layer, line, col, offset with no optional fields", () => {
    expectTypeOf<Provenance>().toEqualTypeOf<{
      readonly file: string;
      readonly layer: SettingsLayer;
      readonly line: number;
      readonly col: number;
      readonly offset: number;
    }>();
    // `Required<T>` strips `?:` and leaves everything else alone, so it is
    // equal to the original only when no property was optional to begin with.
    expectTypeOf<Required<Provenance>>().toEqualTypeOf<Provenance>();
  });

  it("rejects a record that omits the source position", () => {
    const rejected = (): void => {
      // @ts-expect-error a hook nothing can point at on a settings line is not reportable
      const incomplete: Provenance = {
        file: "/home/dev/project/.claude/settings.json",
        layer: "project",
      };
      void incomplete;
    };
    expect(rejected).toBeTypeOf("function");
  });
});

describe("ResolvedHook", () => {
  it("types matcher as string | undefined, not optional via ?:", () => {
    expectTypeOf<ResolvedHook["matcher"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Required<ResolvedHook>>().toEqualTypeOf<ResolvedHook>();
  });

  it("types every other absent-capable field the same way", () => {
    expectTypeOf<ResolvedHook["args"]>().toEqualTypeOf<readonly string[] | undefined>();
    expectTypeOf<ResolvedHook["timeoutMs"]>().toEqualTypeOf<number | undefined>();
  });

  it("accepts a declaration that spells out its absent fields", () => {
    const hook: ResolvedHook = {
      event: "PreToolUse",
      matcher: undefined,
      command: "./scripts/guard.sh",
      args: undefined,
      timeoutMs: undefined,
      provenance,
      dedupeKey: "PreToolUse::./scripts/guard.sh",
    };
    expectTypeOf(hook).toEqualTypeOf<ResolvedHook>();
    expectTypeOf(hook.provenance).toEqualTypeOf<Provenance>();
  });

  it("rejects a declaration that drops an absent-capable field entirely", () => {
    const rejected = (): void => {
      // @ts-expect-error exactOptionalPropertyTypes keeps an absent key distinct from an undefined one
      const hook: ResolvedHook = {
        event: "PreToolUse",
        command: "./scripts/guard.sh",
        args: undefined,
        timeoutMs: undefined,
        provenance,
        dedupeKey: "k",
      };
      void hook;
    };
    expect(rejected).toBeTypeOf("function");
  });

  it("rejects an event name the spec does not carry", () => {
    const rejected = (): void => {
      const hook: ResolvedHook = {
        // @ts-expect-error the event must be one of the documented hook events
        event: "BeforeToolUse",
        matcher: undefined,
        command: "./scripts/guard.sh",
        args: undefined,
        timeoutMs: undefined,
        provenance,
        dedupeKey: "k",
      };
      void hook;
    };
    expect(rejected).toBeTypeOf("function");
  });
});

describe("VersionSourceName", () => {
  it("is the closed set a version probe can report having tried", () => {
    expectTypeOf<VersionSourceName>().toEqualTypeOf<
      "cli-flag" | "environment-variable" | "package-manifest"
    >();
  });

  it("rejects a source name outside the closed set", () => {
    const rejected = (): void => {
      // @ts-expect-error not one of the three sources this issue names
      const source: VersionSourceName = "registry-lookup";
      void source;
    };
    expect(rejected).toBeTypeOf("function");
  });
});

describe("UnknownReason", () => {
  it("narrows on kind to each variant's own fields", () => {
    const narrow = (reason: UnknownReason): void => {
      switch (reason.kind) {
        case "version-out-of-spec-range": {
          expectTypeOf(reason).toEqualTypeOf<{
            readonly kind: "version-out-of-spec-range";
            readonly detected: string;
            readonly specRange: string;
          }>();
          break;
        }
        case "version-undetermined": {
          expectTypeOf(reason).toEqualTypeOf<{
            readonly kind: "version-undetermined";
            readonly triedSources: readonly VersionSourceName[];
          }>();
          break;
        }
        case "payload-shape-unverified": {
          expectTypeOf(reason).toEqualTypeOf<{
            readonly kind: "payload-shape-unverified";
            readonly event: EventName;
            readonly specVersion: string;
          }>();
          break;
        }
        case "plugin-hooks-present": {
          expectTypeOf(reason).toEqualTypeOf<{
            readonly kind: "plugin-hooks-present";
            readonly files: readonly string[];
          }>();
          break;
        }
        case "managed-settings-assumed": {
          expectTypeOf(reason).toEqualTypeOf<{
            readonly kind: "managed-settings-assumed";
            readonly path: string;
          }>();
          break;
        }
        case "event-not-in-spec": {
          expectTypeOf(reason).toEqualTypeOf<{
            readonly kind: "event-not-in-spec";
            readonly event: EventName;
            readonly specVersion: string;
          }>();
          break;
        }
        case "contradictory-exit-code-effect": {
          expectTypeOf(reason).toEqualTypeOf<{
            readonly kind: "contradictory-exit-code-effect";
            readonly event: EventName;
            readonly exitCode: number;
          }>();
          break;
        }
      }
    };
    narrow({
      kind: "version-out-of-spec-range",
      detected: "2.1.0",
      specRange: ">=2.1.251",
    });
    narrow({ kind: "version-undetermined", triedSources: ["cli-flag"] });
    narrow({
      kind: "payload-shape-unverified",
      event: "PreToolUse",
      specVersion: "1.0.0",
    });
    narrow({ kind: "plugin-hooks-present", files: [] });
    narrow({ kind: "managed-settings-assumed", path: "/etc/managed.json" });
    narrow({
      kind: "event-not-in-spec",
      event: "PreToolUse",
      specVersion: "1.0.0",
    });
    narrow({
      kind: "contradictory-exit-code-effect",
      event: "PostToolUse",
      exitCode: 2,
    });
  });

  it("rejects an event name outside EventName in payload-shape-unverified", () => {
    const rejected = (): void => {
      const reason: UnknownReason = {
        kind: "payload-shape-unverified",
        // @ts-expect-error an undocumented event name is not a valid EventName
        event: "BeforeToolUse",
        specVersion: "1.0.0",
      };
      void reason;
    };
    expect(rejected).toBeTypeOf("function");
  });
});

describe("Decision", () => {
  it("narrows on kind to each variant's own fields", () => {
    const narrow = (decision: Decision): void => {
      switch (decision.kind) {
        case "deny": {
          expectTypeOf(decision).toEqualTypeOf<{
            readonly kind: "deny";
            readonly source: "exit-code" | "permission-decision";
            readonly exitCode: number;
          }>();
          break;
        }
        case "allow": {
          expectTypeOf(decision).toEqualTypeOf<{
            readonly kind: "allow";
            readonly exitCode: number;
          }>();
          break;
        }
        case "pass": {
          expectTypeOf(decision).toEqualTypeOf<{
            readonly kind: "pass";
            readonly exitCode: number;
          }>();
          break;
        }
        case "error": {
          expectTypeOf(decision).toEqualTypeOf<{
            readonly kind: "error";
            readonly exitCode: number;
            readonly cause:
              "nonzero-exit-without-json" | "invalid-json" | "schema-violation";
          }>();
          break;
        }
        case "unknown": {
          expectTypeOf(decision).toEqualTypeOf<{
            readonly kind: "unknown";
            readonly reasons: readonly [UnknownReason, ...UnknownReason[]];
          }>();
          break;
        }
      }
    };
    narrow({ kind: "deny", source: "exit-code", exitCode: 2 });
    narrow({ kind: "allow", exitCode: 0 });
    narrow({ kind: "pass", exitCode: 1 });
    narrow({ kind: "error", exitCode: 127, cause: "nonzero-exit-without-json" });
    narrow({
      kind: "unknown",
      reasons: [{ kind: "plugin-hooks-present", files: [] }],
    });
  });

  it("rejects a deny variant missing its source", () => {
    const rejected = (): void => {
      // @ts-expect-error a deny decision must say which channel produced it
      const decision: Decision = { kind: "deny", exitCode: 2 };
      void decision;
    };
    expect(rejected).toBeTypeOf("function");
  });

  it("unknownDecision requires at least one UnknownReason: reasons rejects an empty array at compile time", () => {
    const rejected = (): void => {
      // @ts-expect-error reasons is a non-empty tuple, not a plain array — an empty array cannot construct it
      const decision: Decision = { kind: "unknown", reasons: [] };
      void decision;
    };
    expect(rejected).toBeTypeOf("function");
  });

  it("accepts an unknown variant with exactly one reason", () => {
    const reason: UnknownReason = { kind: "plugin-hooks-present", files: [] };
    const decision: Decision = { kind: "unknown", reasons: [reason] };
    expectTypeOf(decision.reasons).toEqualTypeOf<
      readonly [UnknownReason, ...UnknownReason[]]
    >();
  });
});

describe("ExecOutcome", () => {
  it("requires exitCode, stdout, stderr, timedOut with no optional fields", () => {
    expectTypeOf<ExecOutcome>().toEqualTypeOf<{
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly timedOut: boolean;
    }>();
    expectTypeOf<Required<ExecOutcome>>().toEqualTypeOf<ExecOutcome>();
  });

  it("rejects an outcome missing timedOut", () => {
    const rejected = (): void => {
      // @ts-expect-error every field is required, including timedOut
      const outcome: ExecOutcome = { exitCode: 0, stdout: "", stderr: "" };
      void outcome;
    };
    expect(rejected).toBeTypeOf("function");
  });
});
