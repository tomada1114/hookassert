import { describe, expect, it } from "vitest";

import * as api from "../src/index.js";
import { InvalidInputError, normalizeIdentifier, TimeoutError } from "../src/index.js";

describe("normalizeIdentifier", () => {
  it("lowercases and joins words with the default separator", () => {
    expect(normalizeIdentifier("Hello World")).toBe("hello-world");
  });

  it("collapses runs of unsupported characters into a single separator", () => {
    expect(normalizeIdentifier("a  ---  b")).toBe("a-b");
  });

  it("trims leading and trailing separators", () => {
    expect(normalizeIdentifier("  !!Hello!!  ")).toBe("hello");
  });

  it("keeps digits and ASCII letters", () => {
    expect(normalizeIdentifier("Release v2 build 30")).toBe("release-v2-build-30");
  });

  it("replaces non-ASCII letters rather than dropping them silently", () => {
    expect(normalizeIdentifier("café außen")).toBe("caf-au-en");
  });

  it("preserves case when lowercase is disabled", () => {
    expect(normalizeIdentifier("Hello World", { lowercase: false })).toBe(
      "Hello-World",
    );
  });

  it("uses a custom separator", () => {
    expect(normalizeIdentifier("Hello World", { separator: "_" })).toBe("hello_world");
  });

  it("truncates to maxLength without leaving a trailing separator", () => {
    expect(normalizeIdentifier("hello world", { maxLength: 6 })).toBe("hello");
  });

  it("returns the input unchanged when it is already normalized", () => {
    expect(normalizeIdentifier("already-normalized")).toBe("already-normalized");
  });

  it("accepts a maxLength longer than the normalized value", () => {
    expect(normalizeIdentifier("hi", { maxLength: 100 })).toBe("hi");
  });

  describe("input rejection", () => {
    it("rejects an empty string", () => {
      expect(() => normalizeIdentifier("")).toThrow(InvalidInputError);
    });

    it("rejects a whitespace-only string", () => {
      expect(() => normalizeIdentifier("   \t\n ")).toThrow(InvalidInputError);
    });

    it("rejects input with no retainable characters", () => {
      expect(() => normalizeIdentifier("!!! ???")).toThrow(InvalidInputError);
    });

    it("reports the offending field and a stable error code", () => {
      try {
        normalizeIdentifier("");
        expect.unreachable("normalizeIdentifier should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidInputError);
        const invalid = error as InvalidInputError;
        expect(invalid.code).toBe("ERR_INVALID_INPUT");
        expect(invalid.field).toBe("input");
        expect(invalid.name).toBe("InvalidInputError");
        expect(invalid.message).toContain("input");
      }
    });
  });

  describe("option rejection", () => {
    it("rejects a multi-character separator", () => {
      expect(() => normalizeIdentifier("a b", { separator: "--" })).toThrow(
        InvalidInputError,
      );
    });

    it("rejects an empty separator", () => {
      expect(() => normalizeIdentifier("a b", { separator: "" })).toThrow(
        InvalidInputError,
      );
    });

    it("rejects a separator that normalization would strip again", () => {
      expect(() => normalizeIdentifier("a b", { separator: "x" })).toThrow(
        InvalidInputError,
      );
    });

    it.each(["/", "\\", ":", "\0", "\n", "💥"])(
      "rejects filename-unsafe separator %j",
      (separator) => {
        expect(() => normalizeIdentifier("a b", { separator })).toThrow(
          InvalidInputError,
        );
      },
    );

    it.each(["-", "_", ".", "~"])("accepts safe separator %j", (separator) => {
      expect(normalizeIdentifier("a b", { separator })).toBe(`a${separator}b`);
    });

    it("names the separator option in the error", () => {
      try {
        normalizeIdentifier("a b", { separator: "??" });
        expect.unreachable("normalizeIdentifier should have thrown");
      } catch (error) {
        const invalid = error as InvalidInputError;
        expect(invalid.field).toBe("options.separator");
        expect(invalid.message).toContain("-, _, ., ~");
      }
    });

    it("rejects a zero maxLength", () => {
      expect(() => normalizeIdentifier("a b", { maxLength: 0 })).toThrow(
        InvalidInputError,
      );
    });

    it("rejects a negative maxLength", () => {
      expect(() => normalizeIdentifier("a b", { maxLength: -1 })).toThrow(
        InvalidInputError,
      );
    });

    it("rejects a fractional maxLength", () => {
      expect(() => normalizeIdentifier("a b", { maxLength: 2.5 })).toThrow(
        InvalidInputError,
      );
    });

    it("rejects a non-finite maxLength", () => {
      expect(() => normalizeIdentifier("a b", { maxLength: Number.NaN })).toThrow(
        InvalidInputError,
      );
    });

    it("names the maxLength option in the error", () => {
      try {
        normalizeIdentifier("a b", { maxLength: 0 });
        expect.unreachable("normalizeIdentifier should have thrown");
      } catch (error) {
        expect((error as InvalidInputError).field).toBe("options.maxLength");
      }
    });

    it("still returns a usable identifier when maxLength cuts inside a word", () => {
      // The normalized value always starts with an alphanumeric character, so
      // truncation can shorten the result but never empty it.
      expect(normalizeIdentifier("!ab cd", { maxLength: 3 })).toBe("ab");
    });
  });
});

describe("InvalidInputError", () => {
  it("is an Error subclass with a captured stack", () => {
    const error = new InvalidInputError("input", "input must not be empty");
    expect(error).toBeInstanceOf(Error);
    expect(typeof error.stack).toBe("string");
  });
});

// --- the error-code convention -----------------------------------------------
//
// "Naming and constants" in AGENTS.md fixes the shape of every published error:
// a `name` a reader recognises in a stack trace, and an `ERR_`-prefixed `code`
// a caller is invited to branch on. Reading the classes off the module's own
// exports is what makes that a rule instead of two assertions about two
// classes — a third error type that forgets either half fails here without
// anyone having remembered to write a test for it.

type ErrorClass = new (...args: never[]) => Error;

function isErrorClass(value: unknown): value is ErrorClass {
  return (
    typeof value === "function" && Object.prototype.isPrototypeOf.call(Error, value)
  );
}

const exportedErrorNames = Object.entries(api)
  .filter(([, value]) => isErrorClass(value))
  .map(([name]) => name)
  .sort();

/**
 * One representative instance per exported error class.
 *
 * Constructor signatures differ by design — each error carries the fields that
 * describe what it rejected — so the instances are written out rather than
 * built reflectively. The first test below compares this list against the
 * exports, so a class cannot be added and left uncovered.
 */
const representativeErrors: Record<string, Error> = {
  InvalidInputError: new InvalidInputError(
    "options.maxLength",
    "maxLength must be a positive integer",
  ),
  TimeoutError: new TimeoutError(25),
};

/** The code shape AGENTS.md fixes: `ERR_` plus SCREAMING_SNAKE_CASE. */
const ERROR_CODE = /^ERR_[A-Z0-9_]+$/;

function codeOf(error: Error): unknown {
  return (error as { code?: unknown }).code;
}

describe("the published error contract", () => {
  it("has a representative instance for every exported error class", () => {
    expect(exportedErrorNames).not.toEqual([]);
    expect(Object.keys(representativeErrors).sort()).toEqual(exportedErrorNames);
  });

  it.each(Object.entries(representativeErrors))(
    "%s sets its name and a stable ERR_ code",
    (name, error) => {
      expect(error).toBeInstanceOf(Error);
      // The default is the string "Error", which tells a reader nothing about
      // which failure they are looking at.
      expect(error.name).toBe(name);
      expect(codeOf(error)).toBeTypeOf("string");
      expect(codeOf(error)).toMatch(ERROR_CODE);
    },
  );

  it("gives each error class a code of its own", () => {
    // A shared code makes the discriminator undiscriminating: two failures a
    // caller must handle differently would be indistinguishable.
    const codes = Object.values(representativeErrors).map((error) => codeOf(error));

    expect(new Set(codes).size).toBe(codes.length);
  });
});
