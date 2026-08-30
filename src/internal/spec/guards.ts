/**
 * Hand-written runtime type guards for the versioned hooks spec.
 *
 * @remarks
 * Static layer: pure structural checks over an already-parsed value, no I/O.
 * Mirrors `schema/spec.schema.json` field for field, on purpose: `ajv` stays a
 * devDependency exercised only by `tests/spec.test.ts`'s dual-validation
 * cases, never a runtime `import` inside `src/`, per this repository's
 * dependency-minimization stance (see `managing-dependencies`).
 *
 * `validateSpec` returns every violation it finds, dotted-path first, so
 * `spec/load.ts` can fold them into one {@link SpecSchemaError} reason.
 * `isValidSpec` is the boolean type guard built on top of it.
 */

import type {
  EventSpec,
  ExitCodeEffect,
  ExitCodeEffectKind,
  HookEnv,
  MatcherRule,
  MatcherSyntax,
  MatcherTableRow,
  MatcherTargets,
  PayloadShape,
  Spec,
  SpecDefaults,
  StderrDestination,
} from "./types.js";

const EXIT_CODE_EFFECT_KINDS: readonly ExitCodeEffectKind[] = [
  "block",
  "non-blocking-error",
  "ignored",
];

const STDERR_DESTINATIONS: readonly StderrDestination[] = [
  "claude",
  "user",
  "debug-log",
  "ignored",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
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

function checkMatcherTargets(
  violations: Violations,
  path: string,
  value: unknown,
): void {
  if (!isRecord(value)) {
    violations.add(path, "must be an object");
    return;
  }
  const kind = value["kind"];
  switch (kind) {
    case "none":
    case "tool-name": {
      checkObjectShape(violations, path, value, ["kind"]);
      return;
    }
    case "enum": {
      if (checkObjectShape(violations, path, value, ["kind", "field", "values"])) {
        if (typeof value["field"] !== "string") {
          violations.add(`${path}.field`, "must be a string");
        }
        const values = value["values"];
        if (!isStringArray(values) || values.length === 0) {
          violations.add(`${path}.values`, "must be a non-empty array of strings");
        }
      }
      return;
    }
    case "field": {
      if (checkObjectShape(violations, path, value, ["kind", "field"])) {
        if (typeof value["field"] !== "string") {
          violations.add(`${path}.field`, "must be a string");
        }
      }
      return;
    }
    default: {
      violations.add(
        `${path}.kind`,
        `must be one of "none", "tool-name", "enum", "field"`,
      );
    }
  }
}

function checkExitCodeEffect(
  violations: Violations,
  path: string,
  value: unknown,
): void {
  if (!checkObjectShape(violations, path, value, ["exitCode", "effect", "stderrTo"])) {
    return;
  }
  const exitCode = value["exitCode"];
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) {
    violations.add(`${path}.exitCode`, "must be an integer");
  }
  if (!isOneOf(value["effect"], EXIT_CODE_EFFECT_KINDS)) {
    violations.add(
      `${path}.effect`,
      `must be one of ${EXIT_CODE_EFFECT_KINDS.join(", ")}`,
    );
  }
  if (!isOneOf(value["stderrTo"], STDERR_DESTINATIONS)) {
    violations.add(
      `${path}.stderrTo`,
      `must be one of ${STDERR_DESTINATIONS.join(", ")}`,
    );
  }
}

function checkPayloadShape(violations: Violations, path: string, value: unknown): void {
  if (
    !checkObjectShape(
      violations,
      path,
      value,
      ["verified", "requiredKeys"],
      ["verified", "verifiedAt", "againstVersion", "requiredKeys"],
    )
  ) {
    return;
  }
  // "verifiedAt" and "againstVersion" are permitted extras, required only
  // once verified flips true — checked below rather than through the
  // required list above.
  if (typeof value["verified"] !== "boolean") {
    violations.add(`${path}.verified`, "must be a boolean");
  }
  if (!isStringArray(value["requiredKeys"])) {
    violations.add(`${path}.requiredKeys`, "must be an array of strings");
  }
  if (value["verified"] === true) {
    if (typeof value["verifiedAt"] !== "string") {
      violations.add(`${path}.verifiedAt`, "must be a string once verified is true");
    }
    if (typeof value["againstVersion"] !== "string") {
      violations.add(
        `${path}.againstVersion`,
        "must be a string once verified is true",
      );
    }
  } else {
    if (value["verifiedAt"] !== undefined && typeof value["verifiedAt"] !== "string") {
      violations.add(`${path}.verifiedAt`, "must be a string when present");
    }
    if (
      value["againstVersion"] !== undefined &&
      typeof value["againstVersion"] !== "string"
    ) {
      violations.add(`${path}.againstVersion`, "must be a string when present");
    }
  }
}

function checkEventSpec(violations: Violations, path: string, value: unknown): void {
  if (
    !checkObjectShape(violations, path, value, [
      "matcherTargets",
      "blockable",
      "honorsExit2",
      "jsonDecisions",
      "exitCodeEffects",
      "payloadShape",
    ])
  ) {
    return;
  }
  checkMatcherTargets(violations, `${path}.matcherTargets`, value["matcherTargets"]);
  if (typeof value["blockable"] !== "boolean") {
    violations.add(`${path}.blockable`, "must be a boolean");
  }
  if (typeof value["honorsExit2"] !== "boolean") {
    violations.add(`${path}.honorsExit2`, "must be a boolean");
  }
  if (!isStringArray(value["jsonDecisions"])) {
    violations.add(`${path}.jsonDecisions`, "must be an array of strings");
  }
  const exitCodeEffects = value["exitCodeEffects"];
  if (!Array.isArray(exitCodeEffects)) {
    violations.add(`${path}.exitCodeEffects`, "must be an array");
  } else {
    exitCodeEffects.forEach((effect, index) => {
      checkExitCodeEffect(
        violations,
        `${path}.exitCodeEffects[${String(index)}]`,
        effect,
      );
    });
  }
  checkPayloadShape(violations, `${path}.payloadShape`, value["payloadShape"]);
}

function checkMatcherRule(violations: Violations, path: string, value: unknown): void {
  if (!checkObjectShape(violations, path, value, ["id", "sinceVersion"])) {
    return;
  }
  if (typeof value["id"] !== "string" || value["id"].length === 0) {
    violations.add(`${path}.id`, "must be a non-empty string");
  }
  if (typeof value["sinceVersion"] !== "string" || value["sinceVersion"].length === 0) {
    violations.add(`${path}.sinceVersion`, "must be a non-empty string");
  }
}

function checkMatcherSyntax(
  violations: Violations,
  path: string,
  value: unknown,
): void {
  if (
    !checkObjectShape(violations, path, value, [
      "caseSensitive",
      "exactListPattern",
      "narrowExactMatchEvents",
      "narrowExactListPattern",
      "rules",
    ])
  ) {
    return;
  }
  if (typeof value["caseSensitive"] !== "boolean") {
    violations.add(`${path}.caseSensitive`, "must be a boolean");
  }
  if (
    typeof value["exactListPattern"] !== "string" ||
    value["exactListPattern"].length === 0
  ) {
    violations.add(`${path}.exactListPattern`, "must be a non-empty string");
  }
  if (!isStringArray(value["narrowExactMatchEvents"])) {
    violations.add(`${path}.narrowExactMatchEvents`, "must be an array of strings");
  }
  if (
    typeof value["narrowExactListPattern"] !== "string" ||
    value["narrowExactListPattern"].length === 0
  ) {
    violations.add(`${path}.narrowExactListPattern`, "must be a non-empty string");
  }
  const rules = value["rules"];
  if (!Array.isArray(rules)) {
    violations.add(`${path}.rules`, "must be an array");
  } else {
    rules.forEach((rule, index) => {
      checkMatcherRule(violations, `${path}.rules[${String(index)}]`, rule);
    });
  }
}

function checkDefaults(violations: Violations, path: string, value: unknown): void {
  if (
    !checkObjectShape(violations, path, value, [
      "hookTimeoutMs",
      "promptHookTimeoutMs",
      "agentHookTimeoutMs",
      "reducedTimeoutMs",
    ])
  ) {
    return;
  }
  for (const key of [
    "hookTimeoutMs",
    "promptHookTimeoutMs",
    "agentHookTimeoutMs",
  ] as const) {
    const timeout = value[key];
    if (typeof timeout !== "number" || timeout < 0) {
      violations.add(`${path}.${key}`, "must be a non-negative number");
    }
  }
  const reducedTimeoutMs = value["reducedTimeoutMs"];
  if (!isRecord(reducedTimeoutMs)) {
    violations.add(`${path}.reducedTimeoutMs`, "must be an object");
  } else {
    for (const [key, timeout] of Object.entries(reducedTimeoutMs)) {
      if (typeof timeout !== "number" || timeout < 0) {
        violations.add(
          `${path}.reducedTimeoutMs.${key}`,
          "must be a non-negative number",
        );
      }
    }
  }
}

function checkHookEnv(violations: Violations, path: string, value: unknown): void {
  if (!checkObjectShape(violations, path, value, ["provided"])) {
    return;
  }
  if (!isStringArray(value["provided"])) {
    violations.add(`${path}.provided`, "must be an array of strings");
  }
}

function checkMatcherTableRow(
  violations: Violations,
  path: string,
  value: unknown,
): void {
  if (
    !checkObjectShape(violations, path, value, [
      "event",
      "matcher",
      "matches",
      "doesNotMatch",
      "sinceVersion",
    ])
  ) {
    return;
  }
  if (typeof value["event"] !== "string" || value["event"].length === 0) {
    violations.add(`${path}.event`, "must be a non-empty string");
  }
  if (typeof value["matcher"] !== "string") {
    violations.add(`${path}.matcher`, "must be a string");
  }
  if (!isStringArray(value["matches"])) {
    violations.add(`${path}.matches`, "must be an array of strings");
  }
  if (!isStringArray(value["doesNotMatch"])) {
    violations.add(`${path}.doesNotMatch`, "must be an array of strings");
  }
  const sinceVersion = value["sinceVersion"];
  if (sinceVersion !== null && typeof sinceVersion !== "string") {
    violations.add(`${path}.sinceVersion`, "must be a string or null");
  }
}

/**
 * Every structural violation of `schema/spec.schema.json` found in `value`,
 * as dotted-path messages. An empty array means `value` is a valid {@link Spec}.
 */
export function validateSpec(value: unknown): readonly string[] {
  const violations = new Violations();

  if (
    !checkObjectShape(violations, "$", value, [
      "specVersion",
      "claudeCodeRange",
      "defaults",
      "hookEnv",
      "matcherSyntax",
      "knownTools",
      "events",
      "matcherTable",
    ])
  ) {
    return violations.toArray();
  }

  if (typeof value["specVersion"] !== "string" || value["specVersion"].length === 0) {
    violations.add("$.specVersion", "must be a non-empty string");
  }
  if (
    typeof value["claudeCodeRange"] !== "string" ||
    value["claudeCodeRange"].length === 0
  ) {
    violations.add("$.claudeCodeRange", "must be a non-empty string");
  }
  checkDefaults(violations, "$.defaults", value["defaults"]);
  checkHookEnv(violations, "$.hookEnv", value["hookEnv"]);
  checkMatcherSyntax(violations, "$.matcherSyntax", value["matcherSyntax"]);
  if (!isStringArray(value["knownTools"])) {
    violations.add("$.knownTools", "must be an array of strings");
  }

  const events = value["events"];
  if (!isRecord(events) || Object.keys(events).length === 0) {
    violations.add("$.events", "must be a non-empty object");
  } else {
    for (const [name, spec] of Object.entries(events)) {
      checkEventSpec(violations, `$.events.${name}`, spec);
    }
  }

  const matcherTable = value["matcherTable"];
  if (!Array.isArray(matcherTable)) {
    violations.add("$.matcherTable", "must be an array");
  } else {
    matcherTable.forEach((row, index) => {
      checkMatcherTableRow(violations, `$.matcherTable[${String(index)}]`, row);
    });
  }

  return violations.toArray();
}

/** Type guard built on {@link validateSpec}: `true` when `value` is a valid {@link Spec}. */
export function isValidSpec(value: unknown): value is Spec {
  return validateSpec(value).length === 0;
}

// Re-exported so guards.ts's own consumers (spec/load.ts, tests) can name
// the pieces this module validates without importing ./types.js twice.
export type {
  EventSpec,
  ExitCodeEffect,
  ExitCodeEffectKind,
  HookEnv,
  MatcherRule,
  MatcherSyntax,
  MatcherTableRow,
  MatcherTargets,
  PayloadShape,
  Spec,
  SpecDefaults,
  StderrDestination,
};
