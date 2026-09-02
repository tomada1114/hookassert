import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

import { SpecNotFoundError, SpecSchemaError } from "../src/internal/errors.js";
import {
  CLAUDE_CODE_RANGE_PATTERN,
  CLAUDE_VERSION_PATTERN,
  isInDeclaredRange,
  isValidSpec,
  loadSpec,
  loadSpecFile,
  meetsSinceVersion,
  parseClaudeVersion,
  validateSpec,
} from "../src/internal/spec/index.js";
import type { Spec } from "../src/internal/spec/index.js";
import type { EventName } from "../src/types.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REAL_SPEC_PATH = path.join(REPO_ROOT, "spec", "claude-code-2.1.251-2.2.0.json");
const SCHEMA_PATH = path.join(REPO_ROOT, "schema", "spec.schema.json");
const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/spec/", import.meta.url));

function fixturePath(file: string): string {
  return path.join(FIXTURES_DIR, file);
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/**
 * The full, officially documented event list this issue transcribed from the
 * live Claude Code hooks docs, written out by hand rather than derived from
 * the spec file or the `EventName` union under test.
 */
const DOCUMENTED_EVENT_NAMES: readonly EventName[] = [
  "SessionStart",
  "Setup",
  "InstructionsLoaded",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "MessageDisplay",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "PermissionDenied",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "Stop",
  "StopFailure",
  "TeammateIdle",
  "ConfigChange",
  "CwdChanged",
  "DirectoryAdded",
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
  "PreCompact",
  "PostCompact",
  "PreModelSwitch",
  "PostModelSwitch",
  "SessionEnd",
  "Elicitation",
  "ElicitationResult",
];

describe("loadSpecFile: the real shipped spec", () => {
  it("parses spec/claude-code-2.1.251-2.2.0.json into a typed Spec", () => {
    const spec = loadSpecFile(REAL_SPEC_PATH);

    expect(spec.specVersion).toBe("1");
    expect(spec.claudeCodeRange).toBe(">=2.1.251 <2.2.0");
    expect(spec.events["PreToolUse"]?.blockable).toBe(true);
  });

  it("throws SpecNotFoundError (exit 5) when the path does not exist", () => {
    const missing = fixturePath("does-not-exist.json");

    let caught: unknown;
    try {
      loadSpecFile(missing);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SpecNotFoundError);
    const error = caught as SpecNotFoundError;
    expect(error.code).toBe("ERR_SPEC_NOT_FOUND");
    expect(error.exitCode).toBe(5);
    expect(error.file).toBe(missing);
  });
});

describe("the schema's pattern strings match version.ts's exported patterns", () => {
  const schema = readJson(SCHEMA_PATH) as {
    properties: {
      claudeCodeRange: { pattern: string };
      matcherSyntax: {
        properties: {
          rules: { items: { properties: { sinceVersion: { pattern: string } } } };
        };
      };
    };
    $defs: { matcherTableRow: { properties: { sinceVersion: { pattern: string } } } };
  };

  it("claudeCodeRange's pattern is byte-identical to CLAUDE_CODE_RANGE_PATTERN.source", () => {
    expect(schema.properties.claudeCodeRange.pattern).toBe(
      CLAUDE_CODE_RANGE_PATTERN.source,
    );
  });

  it("matcherSyntax.rules[].sinceVersion's pattern is byte-identical to CLAUDE_VERSION_PATTERN.source", () => {
    expect(
      schema.properties.matcherSyntax.properties.rules.items.properties.sinceVersion
        .pattern,
    ).toBe(CLAUDE_VERSION_PATTERN.source);
  });

  it("matcherTableRow.sinceVersion's pattern is byte-identical to CLAUDE_VERSION_PATTERN.source", () => {
    expect(schema.$defs.matcherTableRow.properties.sinceVersion.pattern).toBe(
      CLAUDE_VERSION_PATTERN.source,
    );
  });
});

describe("loadSpec: schema validation", () => {
  it("parses a well-formed spec into a typed Spec", () => {
    const raw = readJson(fixturePath("valid-minimal.json"));
    const spec = loadSpec(raw, fixturePath("valid-minimal.json"));

    expect(spec.events["SessionStart"]?.matcherTargets).toEqual({
      kind: "enum",
      field: "source",
      values: ["startup", "resume", "clear", "compact", "fork"],
    });
  });

  it("throws SpecSchemaError (exit 5) for a spec missing a required field", () => {
    const file = fixturePath("missing-spec-version.json");
    const raw = readJson(file);

    let caught: unknown;
    try {
      loadSpec(raw, file);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SpecSchemaError);
    const error = caught as SpecSchemaError;
    expect(error.code).toBe("ERR_SPEC_SCHEMA");
    expect(error.exitCode).toBe(5);
    expect(error.file).toBe(file);
  });
});

describe("isInDeclaredRange", () => {
  it("returns true for a version inside claudeCodeRange", () => {
    const spec = loadSpecFile(REAL_SPEC_PATH);

    expect(isInDeclaredRange(spec, parseClaudeVersion("2.1.251"))).toBe(true);
  });

  it("returns false for a version outside claudeCodeRange", () => {
    const spec = loadSpecFile(REAL_SPEC_PATH);

    expect(isInDeclaredRange(spec, parseClaudeVersion("2.2.0"))).toBe(false);
    expect(isInDeclaredRange(spec, parseClaudeVersion("2.1.250"))).toBe(false);
  });
});

describe("meetsSinceVersion", () => {
  it("returns false for a comma-separated-list matcher below its sinceVersion (2.1.191)", () => {
    expect(meetsSinceVersion(parseClaudeVersion("2.1.190"), "2.1.191")).toBe(false);
  });

  it("returns true for a version at or above sinceVersion", () => {
    expect(meetsSinceVersion(parseClaudeVersion("2.1.191"), "2.1.191")).toBe(true);
    expect(meetsSinceVersion(parseClaudeVersion("2.1.195"), "2.1.191")).toBe(true);
  });
});

describe("table-health: the spec cannot silently go empty", () => {
  const spec = loadSpecFile(REAL_SPEC_PATH);

  it("matcherTable is non-empty", () => {
    expect(spec.matcherTable.length).toBeGreaterThan(0);
  });

  it("every key in spec.events is one of the officially documented event names", () => {
    for (const key of Object.keys(spec.events)) {
      expect(DOCUMENTED_EVENT_NAMES).toContain(key);
    }
  });

  it("spec.events has no missing documented event", () => {
    for (const name of DOCUMENTED_EVENT_NAMES) {
      expect(Object.keys(spec.events)).toContain(name);
    }
  });

  it("every blockable: true event's exitCodeEffects contains an exitCode: 2 row", () => {
    for (const [name, event] of Object.entries(spec.events)) {
      if (event.blockable) {
        expect(
          event.exitCodeEffects.some((effect) => effect.exitCode === 2),
          `${name} is blockable but has no exitCode: 2 row`,
        ).toBe(true);
      }
    }
  });
});

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function firstEvent(spec: Record<string, unknown>): Record<string, unknown> {
  return asRecord(Object.values(asRecord(spec["events"]))[0]);
}

describe("schema and hand-written guards agree", () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const schema = readJson(SCHEMA_PATH);
  const validateWithAjv = ajv.compile(schema as object);

  const validFixtures = ["valid-minimal.json"];
  const invalidFixtures = [
    "missing-spec-version.json",
    "wrong-type-blockable.json",
    "bad-effect-enum.json",
    "extra-top-level-property.json",
    "bad-matcher-targets-kind.json",
    "verified-missing-fields.json",
    "empty-events.json",
    "bad-claude-code-range.json",
    "bad-since-version.json",
  ];

  it(`schema and hand-written guards agree on ${String(
    validFixtures.length + invalidFixtures.length,
  )} valid/invalid spec fixtures`, () => {
    for (const file of validFixtures) {
      const raw = readJson(fixturePath(file));
      expect(validateWithAjv(raw), `ajv should accept ${file}`).toBe(true);
      expect(isValidSpec(raw), `guards should accept ${file}`).toBe(true);
    }

    for (const file of invalidFixtures) {
      const raw = readJson(fixturePath(file));
      expect(validateWithAjv(raw), `ajv should reject ${file}`).toBe(false);
      expect(isValidSpec(raw), `guards should reject ${file}`).toBe(false);
    }
  });

  it("accepts the shipped spec under both validators", () => {
    const raw = readJson(REAL_SPEC_PATH);

    expect(validateWithAjv(raw), "ajv should accept the shipped spec").toBe(true);
    expect(isValidSpec(raw), "guards should accept the shipped spec").toBe(true);
  });

  // exactListPattern's compile check is guard-only, on purpose: JSON Schema
  // draft-07 cannot express "must compile as a JavaScript regular
  // expression" without `format: "regex"`, which needs the `ajv-formats`
  // dependency this repository deliberately does not add. This fixture's
  // "[" is a non-empty string the schema's `minLength: 1` happily accepts,
  // so ajv and the guards disagree here by design rather than by drift.
  it("guard-only: rejects an uncompilable exactListPattern the schema cannot catch", () => {
    const raw = readJson(fixturePath("bad-exact-list-pattern.json"));

    expect(validateWithAjv(raw), "ajv cannot express a regex-compile check").toBe(true);
    expect(isValidSpec(raw), "guards compile-check exactListPattern").toBe(false);
  });

  // The guards are a hand-written mirror of the schema, so every constraint
  // one side expresses has to be expressed by the other. These mutations are
  // the ones that used to diverge: `minLength: 1` on a string array's items
  // and `type: "integer"` on a timeout were only in the schema, while the
  // non-empty `specVersion`/`claudeCodeRange` rules were only in the guards.
  const divergenceCases: readonly [string, (spec: Record<string, unknown>) => void][] =
    [
      ["specVersion empty", (s) => (s["specVersion"] = "")],
      ["claudeCodeRange empty", (s) => (s["claudeCodeRange"] = "")],
      [
        "defaults.hookTimeoutMs fractional",
        (s) => (asRecord(s["defaults"])["hookTimeoutMs"] = 1.5),
      ],
      [
        "defaults.reducedTimeoutMs entry fractional",
        (s) => (asRecord(asRecord(s["defaults"])["reducedTimeoutMs"])["Stop"] = 1.5),
      ],
      ["knownTools empty item", (s) => (s["knownTools"] = [""])],
      [
        "hookEnv.provided empty item",
        (s) => (asRecord(s["hookEnv"])["provided"] = [""]),
      ],
      [
        "matcherSyntax.narrowExactMatchEvents empty item",
        (s) => (asRecord(s["matcherSyntax"])["narrowExactMatchEvents"] = [""]),
      ],
      [
        "event.jsonDecisions empty item",
        (s) => (firstEvent(s)["jsonDecisions"] = [""]),
      ],
      [
        "event.payloadShape.requiredKeys empty item",
        (s) => (asRecord(firstEvent(s)["payloadShape"])["requiredKeys"] = [""]),
      ],
      [
        "event.matcherTargets enum field empty",
        (s) =>
          (firstEvent(s)["matcherTargets"] = {
            kind: "enum",
            field: "",
            values: ["a"],
          }),
      ],
      [
        "event.matcherTargets enum values empty item",
        (s) =>
          (firstEvent(s)["matcherTargets"] = {
            kind: "enum",
            field: "source",
            values: [""],
          }),
      ],
      [
        "event.matcherTargets field kind's field empty",
        (s) => (firstEvent(s)["matcherTargets"] = { kind: "field", field: "" }),
      ],
    ];

  it.each(divergenceCases)("ajv and guards both reject: %s", (_name, mutate) => {
    const raw = readJson(fixturePath("valid-minimal.json")) as Record<string, unknown>;
    mutate(raw);

    expect(validateWithAjv(raw), "ajv should reject").toBe(false);
    expect(isValidSpec(raw), "guards should reject").toBe(false);
  });
});

describe("validateSpec", () => {
  it("returns an empty array for a valid spec", () => {
    const raw = readJson(fixturePath("valid-minimal.json"));

    expect(validateSpec(raw)).toEqual([]);
  });

  it("returns dotted-path violation messages for an invalid spec", () => {
    const raw = readJson(fixturePath("missing-spec-version.json"));

    const violations = validateSpec(raw);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes("specVersion"))).toBe(true);
  });

  it("rejects a non-object value", () => {
    expect(validateSpec(null).length).toBeGreaterThan(0);
    expect(validateSpec("not a spec").length).toBeGreaterThan(0);
    expect(validateSpec(42).length).toBeGreaterThan(0);
  });
});

describe("parseClaudeVersion", () => {
  it("parses a plain major.minor.patch string", () => {
    expect(parseClaudeVersion("2.1.251")).toEqual({ major: 2, minor: 1, patch: 251 });
  });

  it("throws on a malformed version string", () => {
    expect(() => parseClaudeVersion("2.1")).toThrow(TypeError);
    expect(() => parseClaudeVersion("v2.1.251")).toThrow(TypeError);
    expect(() => parseClaudeVersion("")).toThrow(TypeError);
  });
});

describe("isInDeclaredRange and meetsSinceVersion: every comparator", () => {
  function specWithRange(claudeCodeRange: string): ReturnType<typeof loadSpec> {
    const raw = readJson(fixturePath("valid-minimal.json")) as Record<string, unknown>;
    raw["claudeCodeRange"] = claudeCodeRange;
    return loadSpec(raw, "synthetic");
  }

  it.each([
    [">2.1.0", "2.1.1", true],
    [">2.1.0", "2.1.0", false],
    ["<=2.1.0", "2.1.0", true],
    ["<=2.1.0", "2.1.1", false],
    ["=2.1.0", "2.1.0", true],
    ["=2.1.0", "2.1.1", false],
  ])("range %s against %s -> %s", (range, version, expected) => {
    expect(isInDeclaredRange(specWithRange(range), parseClaudeVersion(version))).toBe(
      expected,
    );
  });

  // `validateSpec` now rejects a malformed claudeCodeRange at load time (see
  // "loadSpec: claudeCodeRange, sinceVersion, and regex pattern validation"
  // below), so `specWithRange` can no longer be used to reach `isInDeclaredRange`
  // with one — this instead calls it directly with a hand-built, unvalidated
  // `Spec` to prove `parseRange`/`parseClaudeVersion` remain the
  // TypeError-throwing primitives design decision #2 says they stay.
  it("still throws TypeError when isInDeclaredRange is called directly with an unvalidated range", () => {
    const spec = { claudeCodeRange: "not-a-range" } as unknown as Spec;

    expect(() => isInDeclaredRange(spec, parseClaudeVersion("2.1.0"))).toThrow(
      TypeError,
    );
  });

  it("meetsSinceVersion throws when sinceVersion itself is malformed", () => {
    expect(() =>
      meetsSinceVersion(parseClaudeVersion("2.1.0"), "not-a-version"),
    ).toThrow(TypeError);
  });
});

describe("loadSpec: claudeCodeRange, sinceVersion, and regex pattern validation", () => {
  const loadRejectionCases: readonly [
    string,
    (spec: Record<string, unknown>) => void,
  ][] = [
    ["an npm-style caret range (^2.1.0)", (s) => (s["claudeCodeRange"] = "^2.1.0")],
    ["an npm-style tilde range (~2.1)", (s) => (s["claudeCodeRange"] = "~2.1")],
    [
      "a matcherSyntax.rules[].sinceVersion that is not major.minor.patch (2.1)",
      (s) =>
        (asRecord(s["matcherSyntax"])["rules"] = [
          { id: "comma-separated-list", sinceVersion: "2.1" },
        ]),
    ],
    [
      "an uncompilable exactListPattern ([)",
      (s) => (asRecord(s["matcherSyntax"])["exactListPattern"] = "["),
    ],
  ];

  it.each(loadRejectionCases)(
    "rejects %s as SpecSchemaError (exit 5)",
    (_name, mutate) => {
      const raw = readJson(fixturePath("valid-minimal.json")) as Record<
        string,
        unknown
      >;
      mutate(raw);

      let caught: unknown;
      try {
        loadSpec(raw, "synthetic");
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(SpecSchemaError);
      expect((caught as SpecSchemaError).code).toBe("ERR_SPEC_SCHEMA");
      expect((caught as SpecSchemaError).exitCode).toBe(5);
    },
  );
});

describe("loadSpecFile: filesystem edge cases", () => {
  it("throws SpecSchemaError for a file that is not valid JSON", () => {
    const file = fixturePath("malformed.json");

    let caught: unknown;
    try {
      loadSpecFile(file);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SpecSchemaError);
    const error = caught as SpecSchemaError;
    expect(error.code).toBe("ERR_SPEC_SCHEMA");
    expect(error.file).toBe(file);
  });

  it("rethrows a non-ENOENT filesystem error rather than reporting SpecNotFoundError", () => {
    // FIXTURES_DIR itself is a directory: readFileSync rejects it with EISDIR,
    // not ENOENT, so this must surface as the underlying error, not as a
    // missing-spec-file diagnostic.
    expect(() => loadSpecFile(FIXTURES_DIR)).toThrow();
    let caught: unknown;
    try {
      loadSpecFile(FIXTURES_DIR);
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeInstanceOf(SpecNotFoundError);
    expect(caught).not.toBeInstanceOf(SpecSchemaError);
  });
});

describe("validateSpec: every structural violation guards.ts checks", () => {
  function base(): Record<string, unknown> {
    return JSON.parse(
      readFileSync(fixturePath("valid-minimal.json"), "utf8"),
    ) as Record<string, unknown>;
  }

  function asObject(value: unknown): Record<string, unknown> {
    return value as Record<string, unknown>;
  }

  function eventsOf(spec: Record<string, unknown>): Record<string, unknown> {
    return asObject(spec["events"]);
  }

  function preToolUse(spec: Record<string, unknown>): Record<string, unknown> {
    return asObject(eventsOf(spec)["PreToolUse"]);
  }

  const cases: readonly [string, (spec: Record<string, unknown>) => void][] = [
    ["claudeCodeRange wrong type", (s) => (s["claudeCodeRange"] = 1)],
    ["claudeCodeRange empty string", (s) => (s["claudeCodeRange"] = "")],
    ["claudeCodeRange npm caret range", (s) => (s["claudeCodeRange"] = "^2.1.0")],
    ["claudeCodeRange npm tilde range", (s) => (s["claudeCodeRange"] = "~2.1")],
    ["knownTools not a string array", (s) => (s["knownTools"] = [1, 2])],
    ["matcherTable not an array", (s) => (s["matcherTable"] = "nope")],
    ["events not a record", (s) => (s["events"] = ["nope"])],

    ["defaults not an object", (s) => (s["defaults"] = "nope")],
    [
      "defaults.hookTimeoutMs wrong type",
      (s) => (asObject(s["defaults"])["hookTimeoutMs"] = "600000"),
    ],
    [
      "defaults.hookTimeoutMs negative",
      (s) => (asObject(s["defaults"])["hookTimeoutMs"] = -1),
    ],
    [
      "defaults.reducedTimeoutMs not an object",
      (s) => (asObject(s["defaults"])["reducedTimeoutMs"] = "nope"),
    ],
    [
      "defaults.reducedTimeoutMs entry wrong type",
      (s) => (asObject(asObject(s["defaults"])["reducedTimeoutMs"])["Stop"] = "1500"),
    ],

    ["hookEnv not an object", (s) => (s["hookEnv"] = "nope")],
    [
      "hookEnv.provided not a string array",
      (s) => (asObject(s["hookEnv"])["provided"] = [1]),
    ],

    ["matcherSyntax not an object", (s) => (s["matcherSyntax"] = "nope")],
    [
      "matcherSyntax.caseSensitive wrong type",
      (s) => (asObject(s["matcherSyntax"])["caseSensitive"] = "true"),
    ],
    [
      "matcherSyntax.exactListPattern empty",
      (s) => (asObject(s["matcherSyntax"])["exactListPattern"] = ""),
    ],
    [
      "matcherSyntax.exactListPattern uncompilable",
      (s) => (asObject(s["matcherSyntax"])["exactListPattern"] = "["),
    ],
    [
      "matcherSyntax.narrowExactMatchEvents wrong type",
      (s) => (asObject(s["matcherSyntax"])["narrowExactMatchEvents"] = [1]),
    ],
    [
      "matcherSyntax.narrowExactListPattern empty",
      (s) => (asObject(s["matcherSyntax"])["narrowExactListPattern"] = ""),
    ],
    [
      "matcherSyntax.narrowExactListPattern uncompilable",
      (s) => (asObject(s["matcherSyntax"])["narrowExactListPattern"] = "("),
    ],
    [
      "matcherSyntax.rules not an array",
      (s) => (asObject(s["matcherSyntax"])["rules"] = "nope"),
    ],
    [
      "matcherSyntax.rules[0].id empty",
      (s) =>
        (asObject(s["matcherSyntax"])["rules"] = [{ id: "", sinceVersion: "2.1.191" }]),
    ],
    [
      "matcherSyntax.rules[0].sinceVersion empty",
      (s) => (asObject(s["matcherSyntax"])["rules"] = [{ id: "x", sinceVersion: "" }]),
    ],
    [
      "matcherSyntax.rules[0].sinceVersion not major.minor.patch",
      (s) =>
        (asObject(s["matcherSyntax"])["rules"] = [{ id: "x", sinceVersion: "2.1" }]),
    ],

    [
      "event.matcherTargets not an object",
      (s) => (preToolUse(s)["matcherTargets"] = "nope"),
    ],
    [
      "event.matcherTargets 'none'/'tool-name' rejects an extra property",
      (s) => (preToolUse(s)["matcherTargets"] = { kind: "tool-name", extra: true }),
    ],
    [
      "event.matcherTargets 'enum' field wrong type",
      (s) =>
        (preToolUse(s)["matcherTargets"] = { kind: "enum", field: 1, values: ["a"] }),
    ],
    [
      "event.matcherTargets 'enum' values empty",
      (s) =>
        (preToolUse(s)["matcherTargets"] = {
          kind: "enum",
          field: "source",
          values: [],
        }),
    ],
    [
      "event.matcherTargets 'field' kind's field wrong type",
      (s) => (preToolUse(s)["matcherTargets"] = { kind: "field", field: 1 }),
    ],

    ["event.blockable wrong type", (s) => (preToolUse(s)["blockable"] = "yes")],
    ["event.honorsExit2 wrong type", (s) => (preToolUse(s)["honorsExit2"] = "yes")],
    [
      "event.jsonDecisions wrong type",
      (s) => (preToolUse(s)["jsonDecisions"] = "allow"),
    ],
    [
      "event.exitCodeEffects not an array",
      (s) => (preToolUse(s)["exitCodeEffects"] = "nope"),
    ],
    [
      "event.exitCodeEffects[0].exitCode not an integer",
      (s) =>
        (preToolUse(s)["exitCodeEffects"] = [
          { exitCode: 2.5, effect: "block", stderrTo: "claude" },
        ]),
    ],
    [
      "event.exitCodeEffects[0].stderrTo not in enum",
      (s) =>
        (preToolUse(s)["exitCodeEffects"] = [
          { exitCode: 2, effect: "block", stderrTo: "nowhere" },
        ]),
    ],

    [
      "event.payloadShape.verified wrong type",
      (s) => (asObject(preToolUse(s)["payloadShape"])["verified"] = "false"),
    ],
    [
      "event.payloadShape.requiredKeys wrong type",
      (s) => (asObject(preToolUse(s)["payloadShape"])["requiredKeys"] = "nope"),
    ],
    [
      "event.payloadShape.verifiedAt present but not a string when unverified",
      (s) => (asObject(preToolUse(s)["payloadShape"])["verifiedAt"] = 123),
    ],
    [
      "event.payloadShape.againstVersion present but not a string when unverified",
      (s) => (asObject(preToolUse(s)["payloadShape"])["againstVersion"] = 123),
    ],

    [
      "matcherTable[0].event wrong type",
      (s) => (asObject((s["matcherTable"] as unknown[])[0])["event"] = 1),
    ],
    [
      "matcherTable[0].sinceVersion not major.minor.patch",
      (s) => (asObject((s["matcherTable"] as unknown[])[0])["sinceVersion"] = "2.1"),
    ],
  ];

  it.each(cases)("flags: %s", (_name, mutate) => {
    const spec = base();
    mutate(spec);

    expect(validateSpec(spec).length).toBeGreaterThan(0);
    expect(isValidSpec(spec)).toBe(false);
  });

  it("accepts a 'field'-kind matcherTargets when well-formed", () => {
    const spec = base();
    preToolUse(spec)["matcherTargets"] = { kind: "field", field: "to_model" };

    expect(validateSpec(spec)).toEqual([]);
  });

  it("accepts payloadShape.verifiedAt/againstVersion as strings when present and unverified", () => {
    const spec = base();
    const payloadShape = asObject(preToolUse(spec)["payloadShape"]);
    payloadShape["verifiedAt"] = "2026-08-20";
    payloadShape["againstVersion"] = "2.1.251";

    expect(validateSpec(spec)).toEqual([]);
  });

  it("accepts a well-formed matcherTable[].sinceVersion string", () => {
    const spec = base();
    asObject((spec["matcherTable"] as unknown[])[0])["sinceVersion"] = "2.1.191";

    expect(validateSpec(spec)).toEqual([]);
  });
});
