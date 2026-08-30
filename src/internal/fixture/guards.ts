/**
 * Hand-written runtime type guards for a YAML-parsed fixture file.
 *
 * @remarks
 * Static layer: pure structural checks over an already-parsed value, no I/O.
 * Mirrors `schema/fixture.schema.json` field for field, on purpose: `ajv`
 * stays a devDependency exercised only by `tests/fixture.test.ts`'s
 * dual-validation cases, never a runtime `import` inside `src/`, per this
 * repository's dependency-minimization stance (see `managing-dependencies`).
 *
 * Neither this module nor the schema restricts a case's `event` to the
 * closed set of documented Claude Code hook events — that check needs
 * `EventName`'s authoritative list, which `fixture/load.ts` owns instead,
 * the same split `settings/load.ts` draws for its own `KNOWN_EVENT_NAMES`
 * map: a structural checker should not have to be extended every time the
 * spec's event list grows.
 *
 * `validateFixture` returns every violation it finds, dotted-path first, so
 * `fixture/load.ts` can fold them into one `FixtureSchemaError` reason.
 * `isValidRawFixtureFile` is the boolean type guard built on top of it.
 */

import type { RawFixtureFile } from "./types.js";

const DECISION_VALUES = ["deny", "allow", "pass", "error", "unknown"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.length > 0)
  );
}

/** Narrows `value` to one of a fixed set of string literals. */
function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

/** Every key of `value` that is not in `allowed` — the `additionalProperties: false` check. */
function extraKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

/** Every key of `allowed` missing from `value` — the `required` check. */
function missingKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): string[] {
  return allowed.filter((key) => !(key in value));
}

class Violations {
  private readonly messages: string[] = [];

  add(path: string, message: string): void {
    this.messages.push(`${path}: ${message}`);
  }

  toArray(): readonly string[] {
    return this.messages;
  }
}

/**
 * @param required - Keys that must be present.
 * @param allowed - Every key permitted at all, `required` plus any optional
 * extras — the `additionalProperties: false` allowlist. Defaults to
 * `required` for the common case where every allowed key is required.
 */
function checkObjectShape(
  violations: Violations,
  path: string,
  value: unknown,
  required: readonly string[],
  allowed: readonly string[] = required,
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    violations.add(path, "must be an object");
    return false;
  }
  for (const key of missingKeys(value, required)) {
    violations.add(path, `missing required property "${key}"`);
  }
  for (const key of extraKeys(value, allowed)) {
    violations.add(path, `unrecognized property "${key}"`);
  }
  return true;
}

function checkDefaults(violations: Violations, path: string, value: unknown): void {
  if (!checkObjectShape(violations, path, value, ["timeoutMs", "env", "cwd"])) {
    return;
  }
  const timeoutMs = value["timeoutMs"];
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 0) {
    violations.add(`${path}.timeoutMs`, "must be a non-negative integer");
  }
  const env = value["env"];
  if (!isRecord(env)) {
    violations.add(`${path}.env`, "must be an object");
  } else {
    for (const [key, entry] of Object.entries(env)) {
      if (typeof entry !== "string") {
        violations.add(`${path}.env.${key}`, "must be a string");
      }
    }
  }
  if (typeof value["cwd"] !== "string" || value["cwd"].length === 0) {
    violations.add(`${path}.cwd`, "must be a non-empty string");
  }
}

function checkOrigin(violations: Violations, path: string, value: unknown): void {
  if (!checkObjectShape(violations, path, value, ["recorded"])) {
    return;
  }
  if (typeof value["recorded"] !== "string" || value["recorded"].length === 0) {
    violations.add(`${path}.recorded`, "must be a non-empty string");
  }
}

function checkExpectation(violations: Violations, path: string, value: unknown): void {
  if (
    !checkObjectShape(
      violations,
      path,
      value,
      [],
      [
        "fires",
        "decision",
        "exitCode",
        "stdoutContains",
        "stderrContains",
        "context",
        "updatedInput",
        "timedOut",
      ],
    )
  ) {
    return;
  }
  if (value["fires"] !== undefined && typeof value["fires"] !== "boolean") {
    violations.add(`${path}.fires`, "must be a boolean when present");
  }
  if (value["decision"] !== undefined && !isOneOf(value["decision"], DECISION_VALUES)) {
    violations.add(
      `${path}.decision`,
      `must be one of ${DECISION_VALUES.join(", ")} when present`,
    );
  }
  const exitCode = value["exitCode"];
  if (
    exitCode !== undefined &&
    (typeof exitCode !== "number" || !Number.isInteger(exitCode))
  ) {
    violations.add(`${path}.exitCode`, "must be an integer when present");
  }
  if (
    value["stdoutContains"] !== undefined &&
    typeof value["stdoutContains"] !== "string"
  ) {
    violations.add(`${path}.stdoutContains`, "must be a string when present");
  }
  if (
    value["stderrContains"] !== undefined &&
    typeof value["stderrContains"] !== "string"
  ) {
    violations.add(`${path}.stderrContains`, "must be a string when present");
  }
  if (value["timedOut"] !== undefined && typeof value["timedOut"] !== "boolean") {
    violations.add(`${path}.timedOut`, "must be a boolean when present");
  }
}

function checkStub(violations: Violations, path: string, value: unknown): void {
  if (!isRecord(value)) {
    violations.add(path, "must be an object");
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}.${key}`;
    if (!checkObjectShape(violations, entryPath, entry, ["exitCode"])) {
      continue;
    }
    const exitCode = entry["exitCode"];
    if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) {
      violations.add(`${entryPath}.exitCode`, "must be an integer");
    }
  }
}

function checkFixtureCase(violations: Violations, path: string, value: unknown): void {
  if (
    !checkObjectShape(
      violations,
      path,
      value,
      ["event", "expect"],
      ["event", "tool", "input", "origin", "expect", "stub", "dryRun", "cwd"],
    )
  ) {
    return;
  }
  if (typeof value["event"] !== "string" || value["event"].length === 0) {
    violations.add(`${path}.event`, "must be a non-empty string");
  }
  if (
    value["tool"] !== undefined &&
    (typeof value["tool"] !== "string" || value["tool"].length === 0)
  ) {
    violations.add(`${path}.tool`, "must be a non-empty string when present");
  }
  if (value["origin"] !== undefined) {
    checkOrigin(violations, `${path}.origin`, value["origin"]);
  }
  checkExpectation(violations, `${path}.expect`, value["expect"]);
  if (value["stub"] !== undefined) {
    checkStub(violations, `${path}.stub`, value["stub"]);
  }
  if (value["dryRun"] !== undefined && typeof value["dryRun"] !== "boolean") {
    violations.add(`${path}.dryRun`, "must be a boolean when present");
  }
  if (
    value["cwd"] !== undefined &&
    (typeof value["cwd"] !== "string" || value["cwd"].length === 0)
  ) {
    violations.add(`${path}.cwd`, "must be a non-empty string when present");
  }
}

/**
 * Every structural violation of `schema/fixture.schema.json` found in
 * `value`, as dotted-path messages. An empty array means `value` is a valid
 * {@link RawFixtureFile}.
 */
export function validateFixture(value: unknown): readonly string[] {
  const violations = new Violations();

  if (
    !checkObjectShape(
      violations,
      "$",
      value,
      ["cases"],
      ["settings", "defaults", "cases"],
    )
  ) {
    return violations.toArray();
  }

  if (value["settings"] !== undefined && !isNonEmptyStringArray(value["settings"])) {
    violations.add("$.settings", "must be an array of non-empty strings when present");
  }

  if (value["defaults"] !== undefined) {
    checkDefaults(violations, "$.defaults", value["defaults"]);
  }

  const cases = value["cases"];
  if (!Array.isArray(cases)) {
    violations.add("$.cases", "must be an array");
  } else if (cases.length === 0) {
    violations.add("$.cases", "must have at least one entry");
  } else {
    cases.forEach((item, index) => {
      checkFixtureCase(violations, `$.cases[${String(index)}]`, item);
    });
  }

  return violations.toArray();
}

/** Type guard built on {@link validateFixture}: `true` when `value` is a valid {@link RawFixtureFile}. */
export function isValidRawFixtureFile(value: unknown): value is RawFixtureFile {
  return validateFixture(value).length === 0;
}
