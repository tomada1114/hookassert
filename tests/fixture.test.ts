import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  FixtureFiresFalseConflictError,
  FixtureNotFoundError,
  FixtureSchemaError,
  FixtureUnblockableDecisionError,
} from "../src/internal/errors.js";
import {
  isValidRawFixtureFile,
  loadFixture,
  loadFixtureFile,
  loadFixtures,
  validateFixture,
} from "../src/internal/fixture/index.js";
import { loadSpecFile } from "../src/internal/spec/index.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REAL_SPEC_PATH = path.join(REPO_ROOT, "spec", "claude-code-2.1.251-2.2.0.json");
const SCHEMA_PATH = path.join(REPO_ROOT, "schema", "fixture.schema.json");
const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/fixture/", import.meta.url));

function fixturePath(file: string): string {
  return path.join(FIXTURES_DIR, file);
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function readYaml(file: string): unknown {
  return parseYaml(readFileSync(fixturePath(file), "utf8"));
}

const spec = loadSpecFile(REAL_SPEC_PATH);

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected fn() to throw");
}

describe("loadFixtureFile: the happy path", () => {
  it("loads a well-formed fixture YAML into a typed FixtureFile", () => {
    const file = loadFixtureFile(fixturePath("valid-minimal.yaml"), spec);

    expect(file.settings).toEqual([".claude/settings.json"]);
    expect(file.defaults).toEqual({
      timeoutMs: 5000,
      env: { MY_FLAG: "1" },
      cwd: ".",
    });
    expect(file.cases).toHaveLength(2);

    expect(file.cases[0]?.event).toBe("PreToolUse");
    expect(file.cases[0]?.tool).toBe("Bash");
    expect(file.cases[0]?.input).toEqual({ command: "git push --force" });
    expect(file.cases[0]?.expect).toEqual({
      fires: true,
      decision: "deny",
      exitCode: 2,
      stdoutContains: undefined,
      stderrContains: "force push",
      context: undefined,
      updatedInput: undefined,
      timedOut: undefined,
    });

    expect(file.cases[1]?.event).toBe("Stop");
    expect(file.cases[1]?.stub).toEqual({ "~/notify.sh": { exitCode: 0 } });
    expect(file.cases[1]?.dryRun).toBe(false);
  });

  it("an omitted origin resolves to PayloadOrigin.kind === 'synthetic'", () => {
    const file = loadFixtureFile(fixturePath("valid-minimal.yaml"), spec);

    expect(file.cases[0]?.origin).toEqual({ kind: "synthetic" });
    expect(file.cases[1]?.origin).toEqual({ kind: "synthetic" });
  });

  it("origin.recorded resolves capturedAt and claudeVersion from the envelope file it points at", () => {
    const file = loadFixtureFile(fixturePath("origin-recorded.yaml"), spec);

    expect(file.cases[0]?.origin).toEqual({
      kind: "recorded",
      capturedAt: "2026-01-15T10:00:00Z",
      claudeVersion: "2.1.251",
      sourceFile: fixturePath("envelope.json"),
    });
  });

  // The loader carries `defaults` through verbatim and leaves a case that
  // declares no override of its own `undefined`; *applying* the fallback is a
  // later pipeline stage's job, so what is asserted here is that the two
  // halves survive the load intact, not that a merge happened.
  it("carries defaults through and leaves an un-overridden case's own fields undefined", () => {
    const file = loadFixtureFile(fixturePath("defaults.yaml"), spec);

    expect(file.defaults).toEqual({
      timeoutMs: 5000,
      env: { MY_FLAG: "1" },
      cwd: ".",
    });
    expect(file.cases[0]?.cwd).toBeUndefined();
    expect(file.cases[0]?.dryRun).toBeUndefined();
  });

  it("a case's own dryRun/cwd override the file-level defaults", () => {
    const file = loadFixtureFile(fixturePath("defaults.yaml"), spec);

    expect(file.cases[1]?.cwd).toBe("/tmp/override");
    expect(file.cases[1]?.dryRun).toBe(true);
    expect(file.cases[1]?.cwd).not.toBe(file.defaults?.cwd);
  });
});

describe("loadFixtureFile: ERR_FIXTURE_SCHEMA (exit 5)", () => {
  it("throws ERR_FIXTURE_SCHEMA (exit 5) for YAML that does not conform to the schema", () => {
    const error = caught(() =>
      loadFixtureFile(fixturePath("missing-cases.yaml"), spec),
    );

    expect(error).toBeInstanceOf(FixtureSchemaError);
    const schemaError = error as FixtureSchemaError;
    expect(schemaError.code).toBe("ERR_FIXTURE_SCHEMA");
    expect(schemaError.exitCode).toBe(5);
    expect(schemaError.file).toBe(fixturePath("missing-cases.yaml"));
    expect(schemaError.message).toContain("cases");
  });

  it("throws ERR_FIXTURE_SCHEMA for YAML that does not parse at all", () => {
    const error = caught(() => loadFixtureFile(fixturePath("malformed.yaml"), spec));

    expect(error).toBeInstanceOf(FixtureSchemaError);
    expect((error as FixtureSchemaError).message).toContain("invalid YAML");
  });

  it("throws ERR_FIXTURE_SCHEMA for a case whose event is not a recognized hook event", () => {
    const error = caught(() =>
      loadFixtureFile(fixturePath("unknown-event.yaml"), spec),
    );

    expect(error).toBeInstanceOf(FixtureSchemaError);
    expect((error as FixtureSchemaError).message).toContain("NotARealEvent");
  });

  it("throws ERR_FIXTURE_SCHEMA when origin.recorded's envelope file does not exist", () => {
    const error = caught(() =>
      loadFixtureFile(fixturePath("origin-missing-envelope.yaml"), spec),
    );

    expect(error).toBeInstanceOf(FixtureSchemaError);
    expect((error as FixtureSchemaError).message).toContain("could not be read");
  });

  it("throws ERR_FIXTURE_SCHEMA when origin.recorded's envelope file is not valid JSON", () => {
    const error = caught(() =>
      loadFixtureFile(fixturePath("origin-bad-json.yaml"), spec),
    );

    expect(error).toBeInstanceOf(FixtureSchemaError);
    expect((error as FixtureSchemaError).message).toContain("not valid JSON");
  });

  it("throws ERR_FIXTURE_SCHEMA when origin.recorded's envelope file is missing capturedAt", () => {
    const error = caught(() =>
      loadFixtureFile(fixturePath("origin-missing-capturedat.yaml"), spec),
    );

    expect(error).toBeInstanceOf(FixtureSchemaError);
    expect((error as FixtureSchemaError).message).toContain("capturedAt");
  });
});

describe("loadFixtureFile: ERR_FIXTURE_UNBLOCKABLE_DECISION (exit 5)", () => {
  it("throws ERR_FIXTURE_UNBLOCKABLE_DECISION (exit 5) for expect.decision: deny on an event with no deny channel at all, before any process starts", () => {
    // This static-layer module never imports src/internal/exec/ or
    // src/internal/record/ — enforced by eslint.config.mjs's
    // boundaries/static-does-not-reach-dynamic — so there is structurally no
    // way for a process to have been spawned by the time this throws.
    // Notification denies through neither channel: not blockable, and no
    // documented jsonDecisions to carry a deny-shaped value.
    expect(spec.events["Notification"]?.blockable).toBe(false);
    expect(spec.events["Notification"]?.jsonDecisions).toEqual([]);

    const error = caught(() =>
      loadFixtureFile(fixturePath("unblockable-deny.yaml"), spec),
    );

    expect(error).toBeInstanceOf(FixtureUnblockableDecisionError);
    const decisionError = error as FixtureUnblockableDecisionError;
    expect(decisionError.code).toBe("ERR_FIXTURE_UNBLOCKABLE_DECISION");
    expect(decisionError.exitCode).toBe(5);
    expect(decisionError.event).toBe("Notification");
    expect(decisionError.decision).toBe("deny");
  });

  it("the ERR_FIXTURE_UNBLOCKABLE_DECISION message proposes an alternative expectation", () => {
    const error = caught(() =>
      loadFixtureFile(fixturePath("unblockable-deny.yaml"), spec),
    ) as FixtureUnblockableDecisionError;

    expect(error.message).toContain('decision: "error"');
    expect(error.message.toLowerCase()).toContain("stdoutcontains");
    expect(error.message.toLowerCase()).toContain("stderrcontains");
  });

  it("does not throw for expect.decision: deny on a blockable event", () => {
    expect(spec.events["PreToolUse"]?.blockable).toBe(true);

    expect(() =>
      loadFixture(
        { cases: [{ event: "PreToolUse", expect: { decision: "deny" } }] },
        fixturePath("synthetic.yaml"),
        spec,
      ),
    ).not.toThrow();
  });

  it("does not throw for a non-deny decision on a non-blockable event", () => {
    expect(() =>
      loadFixture(
        { cases: [{ event: "PostToolUse", expect: { decision: "error" } }] },
        fixturePath("synthetic.yaml"),
        spec,
      ),
    ).not.toThrow();
  });

  // `blockable` describes only the exit-code channel, so it is the wrong test
  // on its own: these three events are `blockable: false` yet deny through
  // their own `jsonDecisions`, and resolveDecision returns `denied(
  // "permission-decision", …)` for each. Rejecting them at load time would
  // make `expect.decision: deny` unusable for the most common PostToolUse
  // assertion there is.
  it.each([["PermissionRequest"], ["PostToolUse"], ["PostToolUseFailure"]])(
    "does not throw for expect.decision: deny on %s, which denies through JSON while not being blockable",
    (event) => {
      expect(spec.events[event]?.blockable).toBe(false);

      expect(() =>
        loadFixture(
          { cases: [{ event, expect: { decision: "deny" } }] },
          fixturePath("synthetic.yaml"),
          spec,
        ),
      ).not.toThrow();
    },
  );
});

describe("loadFixtureFile: ERR_FIXTURE_FIRES_FALSE_CONFLICT (exit 5)", () => {
  it("throws ERR_FIXTURE_FIRES_FALSE_CONFLICT (exit 5) when fires: false is paired with another expect field", () => {
    const error = caught(() =>
      loadFixture(
        {
          cases: [
            {
              event: "PreToolUse",
              expect: { fires: false, decision: "deny" },
            },
          ],
        },
        fixturePath("synthetic.yaml"),
        spec,
      ),
    );

    expect(error).toBeInstanceOf(FixtureFiresFalseConflictError);
    const conflictError = error as FixtureFiresFalseConflictError;
    expect(conflictError.code).toBe("ERR_FIXTURE_FIRES_FALSE_CONFLICT");
    expect(conflictError.exitCode).toBe(5);
    expect(conflictError.fields).toEqual(["decision"]);
    expect(conflictError.message).toContain("fires: false");
  });

  it("names every other declared expect field, not only the first", () => {
    const error = caught(() =>
      loadFixture(
        {
          cases: [
            {
              event: "PreToolUse",
              expect: {
                fires: false,
                exitCode: 0,
                stdoutContains: "ok",
                timedOut: false,
              },
            },
          ],
        },
        fixturePath("synthetic.yaml"),
        spec,
      ),
    ) as FixtureFiresFalseConflictError;

    expect(error.fields).toEqual(["exitCode", "stdoutContains", "timedOut"]);
  });

  it("does not throw for fires: false declared alone", () => {
    expect(() =>
      loadFixture(
        { cases: [{ event: "PreToolUse", expect: { fires: false } }] },
        fixturePath("synthetic.yaml"),
        spec,
      ),
    ).not.toThrow();
  });

  it("does not throw for fires: true paired with another expect field", () => {
    expect(() =>
      loadFixture(
        {
          cases: [{ event: "PreToolUse", expect: { fires: true, decision: "deny" } }],
        },
        fixturePath("synthetic.yaml"),
        spec,
      ),
    ).not.toThrow();
  });
});

describe("loadFixtureFile: filesystem edge cases", () => {
  it("throws FixtureNotFoundError (exit 5) when the path does not exist", () => {
    const missing = fixturePath("does-not-exist.yaml");

    const error = caught(() => loadFixtureFile(missing, spec));

    expect(error).toBeInstanceOf(FixtureNotFoundError);
    const notFound = error as FixtureNotFoundError;
    expect(notFound.code).toBe("ERR_FIXTURE_NOT_FOUND");
    expect(notFound.exitCode).toBe(5);
    expect(notFound.file).toBe(missing);
  });

  it("rethrows a non-ENOENT filesystem error rather than reporting FixtureNotFoundError", () => {
    // FIXTURES_DIR itself is a directory: readFileSync rejects it with EISDIR,
    // not ENOENT, so this must surface as the underlying error, not as a
    // missing-fixture-file diagnostic.
    const error = caught(() => loadFixtureFile(FIXTURES_DIR, spec));

    expect(error).not.toBeInstanceOf(FixtureNotFoundError);
    expect(error).not.toBeInstanceOf(FixtureSchemaError);
  });
});

describe("loadFixture: schema validation on an already-parsed value", () => {
  it("parses a well-formed fixture into a typed FixtureFile", () => {
    const raw = readYaml("valid-minimal.yaml");
    const file = loadFixture(raw, fixturePath("valid-minimal.yaml"), spec);

    expect(file.cases[0]?.event).toBe("PreToolUse");
  });

  it("throws FixtureSchemaError with a dotted-path reason for a schema violation", () => {
    const raw = readYaml("missing-cases.yaml");

    const error = caught(() =>
      loadFixture(raw, fixturePath("missing-cases.yaml"), spec),
    );

    expect(error).toBeInstanceOf(FixtureSchemaError);
    expect((error as FixtureSchemaError).message).toContain("$.cases");
  });
});

describe("loadFixtures: batch loading", () => {
  it("loads every named fixture file, in order, paired with its path", () => {
    const set = loadFixtures(
      [fixturePath("valid-minimal.yaml"), fixturePath("defaults.yaml")],
      spec,
    );

    expect(set.files).toHaveLength(2);
    expect(set.files[0]?.path).toBe(fixturePath("valid-minimal.yaml"));
    expect(set.files[0]?.file.cases).toHaveLength(2);
    expect(set.files[1]?.path).toBe(fixturePath("defaults.yaml"));
    expect(set.files[1]?.file.cases).toHaveLength(2);
  });

  it("loads zero files for an empty list", () => {
    expect(loadFixtures([], spec)).toEqual({ files: [] });
  });

  it("propagates the first file's error rather than loading the rest", () => {
    const error = caught(() =>
      loadFixtures(
        [fixturePath("missing-cases.yaml"), fixturePath("valid-minimal.yaml")],
        spec,
      ),
    );

    expect(error).toBeInstanceOf(FixtureSchemaError);
  });
});

describe("validateFixture / isValidRawFixtureFile", () => {
  it("returns an empty array and accepts a valid fixture", () => {
    const raw = readYaml("valid-minimal.yaml");

    expect(validateFixture(raw)).toEqual([]);
    expect(isValidRawFixtureFile(raw)).toBe(true);
  });

  it("returns dotted-path violation messages and rejects an invalid fixture", () => {
    const raw = readYaml("missing-cases.yaml");

    const violations = validateFixture(raw);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes("cases"))).toBe(true);
    expect(isValidRawFixtureFile(raw)).toBe(false);
  });

  it("rejects a non-object value", () => {
    expect(validateFixture(null).length).toBeGreaterThan(0);
    expect(validateFixture("not a fixture").length).toBeGreaterThan(0);
    expect(validateFixture(42).length).toBeGreaterThan(0);
    expect(validateFixture(undefined).length).toBeGreaterThan(0);
  });
});

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function firstCase(fixture: Record<string, unknown>): Record<string, unknown> {
  return asRecord((fixture["cases"] as unknown[])[0]);
}

describe("schema and hand-written guards agree", () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const schema = readJson(SCHEMA_PATH);
  const validateWithAjv = ajv.compile(schema as object);

  const validFixtures = ["valid-minimal.json"];
  const invalidFixtures = [
    "missing-cases.json",
    "extra-top-level-property.json",
    "bad-decision-enum.json",
    "empty-cases.json",
    "wrong-type-event.json",
  ];

  it(`schema and hand-written guards agree on ${String(
    validFixtures.length + invalidFixtures.length,
  )} valid/invalid fixture fixtures`, () => {
    for (const file of validFixtures) {
      const raw = readJson(fixturePath(file));
      expect(validateWithAjv(raw), `ajv should accept ${file}`).toBe(true);
      expect(isValidRawFixtureFile(raw), `guards should accept ${file}`).toBe(true);
    }

    for (const file of invalidFixtures) {
      const raw = readJson(fixturePath(file));
      expect(validateWithAjv(raw), `ajv should reject ${file}`).toBe(false);
      expect(isValidRawFixtureFile(raw), `guards should reject ${file}`).toBe(false);
    }
  });

  const divergenceCases: readonly [
    string,
    (fixture: Record<string, unknown>) => void,
  ][] = [
    [
      "defaults.timeoutMs fractional",
      (f) => (asRecord(f["defaults"])["timeoutMs"] = 1.5),
    ],
    ["defaults.timeoutMs negative", (f) => (asRecord(f["defaults"])["timeoutMs"] = -1)],
    [
      "defaults.env entry not a string",
      (f) => (asRecord(asRecord(f["defaults"])["env"])["MY_FLAG"] = 1),
    ],
    ["defaults.cwd empty", (f) => (asRecord(f["defaults"])["cwd"] = "")],
    ["defaults missing env", (f) => delete asRecord(f["defaults"])["env"]],
    ["case.event empty string", (f) => (firstCase(f)["event"] = "")],
    [
      "case.expect.exitCode fractional",
      (f) => (asRecord(firstCase(f)["expect"])["exitCode"] = 1.5),
    ],
    [
      "case.stub entry missing exitCode",
      (f) => (firstCase(f)["stub"] = { "~/notify.sh": {} }),
    ],
    [
      "case.stub entry exitCode fractional",
      (f) => (firstCase(f)["stub"] = { "~/notify.sh": { exitCode: 1.5 } }),
    ],
    ["case.origin.recorded empty", (f) => (firstCase(f)["origin"] = { recorded: "" })],
    ["case.origin missing recorded", (f) => (firstCase(f)["origin"] = {})],
    ["case.tool wrong type", (f) => (firstCase(f)["tool"] = 1)],
    ["case.tool empty string", (f) => (firstCase(f)["tool"] = "")],
    ["case.dryRun wrong type", (f) => (firstCase(f)["dryRun"] = "false")],
    ["case.cwd wrong type", (f) => (firstCase(f)["cwd"] = 1)],
    ["case.cwd empty string", (f) => (firstCase(f)["cwd"] = "")],
    ["case has an unrecognized property", (f) => (firstCase(f)["extra"] = true)],
    ["settings entry empty string", (f) => (f["settings"] = [""])],
    ["cases not an array", (f) => (f["cases"] = "nope")],
  ];

  it.each(divergenceCases)("ajv and guards both reject: %s", (_name, mutate) => {
    const raw = readJson(fixturePath("valid-minimal.json")) as Record<string, unknown>;
    mutate(raw);

    expect(validateWithAjv(raw), "ajv should reject").toBe(false);
    expect(isValidRawFixtureFile(raw), "guards should reject").toBe(false);
  });
});

describe("validateFixture: every structural violation guards.ts checks", () => {
  function base(): Record<string, unknown> {
    return JSON.parse(
      readFileSync(fixturePath("valid-minimal.json"), "utf8"),
    ) as Record<string, unknown>;
  }

  const cases: readonly [string, (fixture: Record<string, unknown>) => void][] = [
    ["root has an unrecognized property", (f) => (f["extra"] = true)],

    ["settings not a string array", (f) => (f["settings"] = [1, 2])],

    ["defaults not an object", (f) => (f["defaults"] = "nope")],
    [
      "defaults has an unrecognized property",
      (f) => (asRecord(f["defaults"])["extra"] = true),
    ],
    [
      "defaults.timeoutMs wrong type",
      (f) => (asRecord(f["defaults"])["timeoutMs"] = "5000"),
    ],
    ["defaults.env not an object", (f) => (asRecord(f["defaults"])["env"] = "nope")],
    ["defaults.cwd wrong type", (f) => (asRecord(f["defaults"])["cwd"] = 1)],

    ["cases empty array", (f) => (f["cases"] = [])],
    ["cases entry not an object", (f) => ((f["cases"] as unknown[])[0] = "nope")],
    [
      "case missing event",
      (f) => {
        const entry = firstCase(f);
        delete entry["event"];
      },
    ],
    [
      "case missing expect",
      (f) => {
        const entry = firstCase(f);
        delete entry["expect"];
      },
    ],
    ["case.event wrong type", (f) => (firstCase(f)["event"] = 1)],

    ["case.expect not an object", (f) => (firstCase(f)["expect"] = "nope")],
    [
      "case.expect has an unrecognized property",
      (f) => (asRecord(firstCase(f)["expect"])["extra"] = true),
    ],
    [
      "case.expect.fires wrong type",
      (f) => (asRecord(firstCase(f)["expect"])["fires"] = "true"),
    ],
    [
      "case.expect.decision not in enum",
      (f) => (asRecord(firstCase(f)["expect"])["decision"] = "nope"),
    ],
    [
      "case.expect.exitCode wrong type",
      (f) => (asRecord(firstCase(f)["expect"])["exitCode"] = "2"),
    ],
    [
      "case.expect.stdoutContains wrong type",
      (f) => (asRecord(firstCase(f)["expect"])["stdoutContains"] = 1),
    ],
    [
      "case.expect.stderrContains wrong type",
      (f) => (asRecord(firstCase(f)["expect"])["stderrContains"] = 1),
    ],
    [
      "case.expect.timedOut wrong type",
      (f) => (asRecord(firstCase(f)["expect"])["timedOut"] = "false"),
    ],

    ["case.origin not an object", (f) => (firstCase(f)["origin"] = "nope")],
    [
      "case.origin has an unrecognized property",
      (f) => (firstCase(f)["origin"] = { recorded: "x.json", extra: true }),
    ],
    [
      "case.origin.recorded wrong type",
      (f) => (firstCase(f)["origin"] = { recorded: 1 }),
    ],

    ["case.stub not an object", (f) => (firstCase(f)["stub"] = "nope")],
    [
      "case.stub entry not an object",
      (f) => (firstCase(f)["stub"] = { "~/notify.sh": "nope" }),
    ],
    [
      "case.stub entry has an unrecognized property",
      (f) => (firstCase(f)["stub"] = { "~/notify.sh": { exitCode: 0, extra: true } }),
    ],
  ];

  it.each(cases)("flags: %s", (_name, mutate) => {
    const raw = base();
    mutate(raw);

    expect(validateFixture(raw).length).toBeGreaterThan(0);
    expect(isValidRawFixtureFile(raw)).toBe(false);
  });

  it("accepts an expect with only optional fields present and no others", () => {
    const raw = base();
    firstCase(raw)["expect"] = { updatedInput: { a: 1 }, context: null };

    expect(validateFixture(raw)).toEqual([]);
  });
});
