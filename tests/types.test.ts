import { describe, expect, expectTypeOf, it } from "vitest";

import {
  InvalidInputError,
  normalizeIdentifier,
  TimeoutError,
  withTimeout,
  type NormalizeIdentifierOptions,
  type WithTimeoutOptions,
} from "../src/index.js";

// These are compile-time assertions about the public surface. They run under
// Vitest so a broken type contract fails the same gate as a broken behavior,
// while tests/package.test.ts checks the *published declarations* from a
// consumer's point of view.
describe("public API types", () => {
  it("normalizeIdentifier returns a string and takes optional options", () => {
    expectTypeOf(normalizeIdentifier).toBeCallableWith("input");
    expectTypeOf(normalizeIdentifier).toBeCallableWith("input", { maxLength: 8 });
    expectTypeOf(normalizeIdentifier("input")).toEqualTypeOf<string>();
  });

  it("rejects input that is not a string", () => {
    // Declared but never invoked: the assertion is that this body fails to
    // compile without the `@ts-expect-error` comments.
    const rejected = (): void => {
      // @ts-expect-error a number is not a valid identifier source
      normalizeIdentifier(42);
      // @ts-expect-error options must be an object, not a separator string
      normalizeIdentifier("input", "-");
      // @ts-expect-error unknown options are typos, not extension points
      normalizeIdentifier("input", { seperator: "-" });
    };
    expect(rejected).toBeTypeOf("function");
  });

  it("exposes NormalizeIdentifierOptions as fully optional and readonly", () => {
    expectTypeOf<NormalizeIdentifierOptions>().toEqualTypeOf<{
      readonly separator?: string;
      readonly maxLength?: number;
      readonly lowercase?: boolean;
    }>();
  });

  it("withTimeout preserves the operation's resolved type", () => {
    expectTypeOf(withTimeout(() => Promise.resolve(1), { timeoutMs: 1 })).toEqualTypeOf<
      Promise<number>
    >();
    expectTypeOf(
      withTimeout(() => Promise.resolve("a" as const), { timeoutMs: 1 }),
    ).toEqualTypeOf<Promise<"a">>();
  });

  it("withTimeout requires an explicit deadline and a promise", () => {
    const rejected = (): void => {
      // @ts-expect-error timeoutMs is required, there is no implicit default
      void withTimeout(() => Promise.resolve(1), {});
      // @ts-expect-error the operation must return a promise
      void withTimeout(() => 1, { timeoutMs: 1 });
    };
    expect(rejected).toBeTypeOf("function");
  });

  it("passes an AbortSignal to the operation", () => {
    expectTypeOf(withTimeout<number>)
      .parameter(0)
      .parameter(0)
      .toEqualTypeOf<AbortSignal>();
  });

  it("exposes WithTimeoutOptions with a required deadline", () => {
    expectTypeOf<WithTimeoutOptions["timeoutMs"]>().toEqualTypeOf<number>();
    expectTypeOf<WithTimeoutOptions>().toEqualTypeOf<{
      readonly timeoutMs: number;
      readonly signal?: AbortSignal;
    }>();
  });

  it("narrows errors by their discriminating code", () => {
    // Taken as a parameter so the union is not narrowed by an initializer.
    const classify = (error: InvalidInputError | TimeoutError): void => {
      if (error.code === "ERR_TIMEOUT") {
        expectTypeOf(error).toEqualTypeOf<TimeoutError>();
        expectTypeOf(error.timeoutMs).toEqualTypeOf<number>();
      } else {
        expectTypeOf(error).toEqualTypeOf<InvalidInputError>();
        expectTypeOf(error.field).toEqualTypeOf<string>();
      }
    };
    classify(new TimeoutError(1));
    classify(new InvalidInputError("input", "rejected"));
  });

  it("keeps error codes as literal types", () => {
    expectTypeOf<InvalidInputError["code"]>().toEqualTypeOf<"ERR_INVALID_INPUT">();
    expectTypeOf<TimeoutError["code"]>().toEqualTypeOf<"ERR_TIMEOUT">();
  });
});
