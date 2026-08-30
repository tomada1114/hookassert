/**
 * Maps a hook's raw exit code and stdout to the closed `Decision` vocabulary.
 *
 * @remarks
 * Static layer: pure function, no I/O — `outcome` is a value the caller
 * already obtained (a later executor issue's `Spawner`, or a test's stub),
 * and `resolveDecision` never spawns anything itself.
 *
 * Every branch reads `spec.events[event]`'s own data (`blockable`,
 * `jsonDecisions`, `exitCodeEffects`) rather than hard-coding exit-code
 * literals: the shipped spec documents at least one event (`WorktreeCreate`)
 * whose non-`2` exit code also blocks, so "exit 2 means deny" is only true
 * because that is what most events' `exitCodeEffects` happen to say, not
 * because `2` is special to this resolver.
 */

import type { Decision, EventName, ExecOutcome } from "../../types.js";
import type { EventSpec, ExitCodeEffect, Spec } from "../spec/index.js";
import { allowed, denied, errored, passed, unknownDecision } from "./factory.js";

/** `permissionDecision` values that mean "block this action." */
const DENY_VALUES: ReadonlySet<string> = new Set(["deny", "block"]);

/** `permissionDecision` values that mean "allow this action." */
const ALLOW_VALUES: ReadonlySet<string> = new Set(["allow"]);

function looksLikeJson(text: string): boolean {
  return text.startsWith("{") || text.startsWith("[");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type JsonDecision =
  | { readonly kind: "none" }
  | { readonly kind: "malformed" }
  | { readonly kind: "schema-violation" }
  | { readonly kind: "decision"; readonly value: string };

/**
 * Read a hook's stdout for a `permissionDecision` value valid for `event`.
 *
 * @remarks
 * Only text that looks like JSON (`{`/`[`-prefixed after trimming) is even
 * attempted — most hooks print plain text and exit, and that is not an
 * error, since Claude Code itself only tries to parse stdout as JSON when it
 * looks like one. A JSON object with no `permissionDecision` key is
 * `"none"` too: a hook may validly emit JSON that carries no decision at
 * all (a log line, a status payload).
 */
function classifyJsonDecision(eventSpec: EventSpec, stdout: string): JsonDecision {
  const trimmed = stdout.trim();
  if (trimmed.length === 0 || !looksLikeJson(trimmed)) {
    return { kind: "none" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { kind: "malformed" };
  }

  if (!isPlainRecord(parsed) || !("permissionDecision" in parsed)) {
    return { kind: "none" };
  }

  const value = parsed["permissionDecision"];
  if (typeof value !== "string" || !eventSpec.jsonDecisions.includes(value)) {
    return { kind: "schema-violation" };
  }

  return { kind: "decision", value };
}

function findExitCodeEffect(
  eventSpec: EventSpec,
  exitCode: number,
): ExitCodeEffect | undefined {
  return eventSpec.exitCodeEffects.find((row) => row.exitCode === exitCode);
}

/**
 * Map a hook's raw exit code and stdout to a {@link Decision}.
 *
 * @remarks
 * A timed-out hook is never treated as a block: Claude Code does not honor a
 * hook that never finished as an `exit 2`-equivalent signal, and asserting a
 * deny that will not really happen in production is exactly the
 * over-cautious failure mode this project exists to avoid alongside the
 * under-cautious one.
 */
export function resolveDecision(
  spec: Spec,
  event: EventName,
  outcome: ExecOutcome,
): Decision {
  const eventSpec = spec.events[event];
  if (eventSpec === undefined) {
    // `EventName`'s 33 members are kept in lockstep with `spec.events`'s keys
    // (see src/types.ts's doc comment) and a real spec never omits one, but
    // `noUncheckedIndexedAccess` still types this lookup as possibly
    // undefined. The one way this genuinely fires is a hookassert build
    // whose `EventName` union has drifted ahead of the spec file it loaded —
    // exactly what "unknown" exists to report rather than throw on.
    return unknownDecision({
      kind: "version-out-of-spec-range",
      detected: event,
      specRange: spec.claudeCodeRange,
    });
  }

  if (outcome.timedOut) {
    return passed(outcome.exitCode);
  }

  const effect = findExitCodeEffect(eventSpec, outcome.exitCode);
  const jsonDecision = classifyJsonDecision(eventSpec, outcome.stdout);

  if (effect?.effect === "block") {
    // Guarded on `blockable` even though the shipped spec never actually
    // pairs a "block" effect with a non-blockable event: a hook process can
    // still exit whatever code it wants regardless of what Claude Code
    // honors, so this is the check that keeps a spec/reality mismatch from
    // being promoted into a false deny for an event that cannot deny at all.
    return eventSpec.blockable
      ? denied("exit-2", outcome.exitCode)
      : errored(outcome.exitCode, "schema-violation");
  }

  if (jsonDecision.kind === "decision") {
    if (eventSpec.blockable && DENY_VALUES.has(jsonDecision.value)) {
      return denied("permission-decision", outcome.exitCode);
    }
    if (ALLOW_VALUES.has(jsonDecision.value)) {
      return allowed(outcome.exitCode);
    }
    // A recognized decision value that is neither deny/block nor allow (for
    // example "ask" or "defer") hands the action back to Claude Code's own
    // normal flow — hookassert has nothing more specific to assert.
    return passed(outcome.exitCode);
  }

  if (jsonDecision.kind === "schema-violation") {
    return errored(outcome.exitCode, "schema-violation");
  }

  if (effect !== undefined) {
    // A documented, non-blocking exit code (`non-blocking-error` or
    // `ignored`) with no JSON decision. This is the "exit 1 from a policy
    // hook is a no-op" case: the hook's own exit code carries no weight for
    // this event, so the action proceeds unchanged.
    return passed(outcome.exitCode);
  }

  if (outcome.exitCode === 0) {
    return jsonDecision.kind === "malformed"
      ? errored(outcome.exitCode, "invalid-json")
      : passed(outcome.exitCode);
  }

  // A non-zero exit code the spec does not document for this event (neither
  // 1 nor 2) with no recognizable JSON decision: nothing tells us what the
  // hook intended.
  return errored(outcome.exitCode, "nonzero-exit-without-json");
}

/**
 * Whether `outcome` is the specific combination `resolveDecision` resolves
 * to `deny` despite stdout JSON saying `allow`: an `exit 2`-equivalent
 * block effect alongside an `allow` `permissionDecision`.
 *
 * @remarks
 * `resolveDecision`'s return type is the closed `Decision` shape this
 * issue's design pins verbatim, which has no room for a side note on the
 * `"deny"` variant it returns for this case. This predicate is the "side
 * value the resolver exposes" that design calls for, so a later `report/`
 * issue can render a dedicated warning instead of silently treating this
 * deny the same as any other.
 */
export function exit2OverridesAllowJson(
  spec: Spec,
  event: EventName,
  outcome: ExecOutcome,
): boolean {
  const eventSpec = spec.events[event];
  if (eventSpec === undefined || outcome.timedOut) {
    return false;
  }
  const effect = findExitCodeEffect(eventSpec, outcome.exitCode);
  if (effect?.effect !== "block" || !eventSpec.blockable) {
    return false;
  }
  const jsonDecision = classifyJsonDecision(eventSpec, outcome.stdout);
  return jsonDecision.kind === "decision" && ALLOW_VALUES.has(jsonDecision.value);
}
