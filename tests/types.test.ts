import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  EventName,
  Provenance,
  ResolvedHook,
  SettingsLayer,
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
      | "PreToolUse"
      | "PostToolUse"
      | "Stop"
      | "StopFailure"
      | "PermissionRequest"
      | "FileChanged"
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
