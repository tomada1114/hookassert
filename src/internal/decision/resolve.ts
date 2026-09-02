/**
 * Maps a hook's raw exit code and stdout to the closed `Decision` vocabulary.
 *
 * @remarks
 * Static layer: pure function, no I/O — `outcome` is a value the caller
 * already obtained (a later executor issue's `Spawner`, or a test's stub),
 * and `resolveDecision` never spawns anything itself.
 *
 * `outcome.launchError !== undefined` is checked before anything else below
 * it: a process that never started carries no meaningful exit code or
 * timeout at all, and reads a field rather than a literal — no exit-code
 * value is reserved for "never launched."
 *
 * Every other branch reads `spec.events[event]`'s own data (`blockable`,
 * `jsonDecisions`, `exitCodeEffects`) rather than hard-coding exit-code
 * literals: the shipped spec documents at least one event (`WorktreeCreate`)
 * whose non-`2` exit code also blocks, so "exit 2 means deny" is only true
 * because that is what most events' `exitCodeEffects` happen to say, not
 * because `2` is special to this resolver. The JSON channel is gated the
 * same way: whether a `permissionDecision`/`decision` value denies or allows
 * is decided from the event's own `jsonDecisions`, never from `blockable` —
 * `blockable` only ever describes the exit-code channel (it is defined as
 * equal to `honorsExit2` for every one of the spec's 33 events), and several
 * events (`PermissionRequest`, `PostToolUse`, `PostToolUseFailure`) deny
 * exclusively through JSON while being `blockable: false`.
 */

import type { Decision, EventName, ExecOutcome } from "../../types.js";
import type { EventSpec, ExitCodeEffect, Spec } from "../spec/index.js";
import { allowed, denied, errored, passed, unknownDecision } from "./factory.js";

/**
 * Words meaning "block this action," wherever an event's own `jsonDecisions`
 * documents one of them.
 */
const DENY_SHAPED_WORDS: ReadonlySet<string> = new Set([
  "deny",
  "block",
  "decline",
  "cancel",
]);

/**
 * Words meaning "allow this action," wherever an event's own `jsonDecisions`
 * documents one of them.
 */
const ALLOW_SHAPED_WORDS: ReadonlySet<string> = new Set(["allow", "accept"]);

/** The subset of `eventSpec.jsonDecisions` that are deny-shaped. */
function denyValuesFor(eventSpec: EventSpec): ReadonlySet<string> {
  return new Set(
    eventSpec.jsonDecisions.filter((value) => DENY_SHAPED_WORDS.has(value)),
  );
}

/**
 * Whether the loaded spec documents any channel at all by which `eventSpec`
 * could produce a `deny` {@link Decision}.
 *
 * @remarks
 * The two channels {@link resolveDecision} can return a `deny` from, and
 * nothing else: an honored blocking exit code (`blockable` *and* an
 * `exitCodeEffects` row whose effect is `block`), or a deny-shaped value in
 * the event's own `jsonDecisions`. `blockable` alone is not the predicate —
 * it describes only the exit-code channel, so `PermissionRequest`,
 * `PostToolUse` and `PostToolUseFailure` all deny exclusively through JSON
 * while being `blockable: false`. `fixture/load.ts` uses this to reject a
 * `expect.decision: "deny"` that could never come true, and reading it from
 * here rather than reimplementing it keeps that rejection in lockstep with
 * what this resolver will actually return.
 */
export function canProduceDeny(eventSpec: EventSpec): boolean {
  const viaExitCode =
    eventSpec.blockable &&
    eventSpec.exitCodeEffects.some((row) => row.effect === "block");
  return viaExitCode || denyValuesFor(eventSpec).size > 0;
}

/** The subset of `eventSpec.jsonDecisions` that are allow-shaped. */
function allowValuesFor(eventSpec: EventSpec): ReadonlySet<string> {
  return new Set(
    eventSpec.jsonDecisions.filter((value) => ALLOW_SHAPED_WORDS.has(value)),
  );
}

function looksLikeJson(text: string): boolean {
  return text.startsWith("{") || text.startsWith("[");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the raw decision value out of a parsed stdout object, checking the
 * locations Claude Code itself emits in order and returning the first one
 * present:
 *
 * 1. `hookSpecificOutput.permissionDecision` — `PreToolUse`, `PermissionRequest`.
 * 2. Top-level `decision` — the `jsonDecisions: ["block"]` events
 *    (`UserPromptSubmit`, `Stop`, `PostToolUse`, ...).
 * 3. Top-level `permissionDecision` — a fallback for any hook that emits the
 *    field unnested.
 *
 * `undefined` means none of the three locations carry a value at all, which
 * is not an error: a hook may validly emit JSON with no decision in it (a
 * log line, a status payload).
 */
function readDecisionValue(record: Record<string, unknown>): unknown {
  const hookSpecificOutput = record["hookSpecificOutput"];
  if (isPlainRecord(hookSpecificOutput) && "permissionDecision" in hookSpecificOutput) {
    return hookSpecificOutput["permissionDecision"];
  }
  if ("decision" in record) {
    return record["decision"];
  }
  if ("permissionDecision" in record) {
    return record["permissionDecision"];
  }
  return undefined;
}

type JsonDecision =
  | { readonly kind: "none" }
  | { readonly kind: "malformed" }
  | { readonly kind: "schema-violation" }
  | { readonly kind: "decision"; readonly value: string };

/**
 * Read a hook's stdout for a decision value valid for `event`.
 *
 * @remarks
 * Only text that looks like JSON (`{`/`[`-prefixed after trimming) is even
 * attempted — most hooks print plain text and exit, and that is not an
 * error, since Claude Code itself only tries to parse stdout as JSON when it
 * looks like one.
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

  if (!isPlainRecord(parsed)) {
    return { kind: "none" };
  }

  const raw = readDecisionValue(parsed);
  if (raw === undefined) {
    return { kind: "none" };
  }

  if (typeof raw !== "string" || !eventSpec.jsonDecisions.includes(raw)) {
    return { kind: "schema-violation" };
  }

  return { kind: "decision", value: raw };
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
 *
 * `outcome.launchError !== undefined` is checked before the timeout check
 * and before any `exitCodeEffects` lookup — a process that never launched
 * cannot have timed out or exited with a meaningful code, so nothing below
 * that check is reachable for it. A launch failure is a case-level `error`
 * decision, not a run-level load error: it is only discoverable after
 * consent and after spawning was attempted.
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
      kind: "event-not-in-spec",
      event,
      specVersion: spec.specVersion,
    });
  }

  if (outcome.launchError !== undefined) {
    return errored(outcome.exitCode, "launch-failed");
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
    // The mismatch is the *spec entry* contradicting itself (`blockable:
    // false` alongside a documented `block` effect), not the hook's own
    // output, so it is reported as `unknown` rather than blamed on the hook
    // as a `schema-violation`.
    return eventSpec.blockable
      ? denied("exit-code", outcome.exitCode)
      : unknownDecision({
          kind: "contradictory-exit-code-effect",
          event,
          exitCode: outcome.exitCode,
        });
  }

  if (jsonDecision.kind === "decision") {
    // Gated on this event's own `jsonDecisions`, never on `blockable`:
    // `classifyJsonDecision` already rejected any value outside
    // `eventSpec.jsonDecisions` as a `schema-violation`, so by this point
    // `jsonDecision.value` is one the event itself documents as a valid
    // decision — including events such as `PermissionRequest` and
    // `PostToolUse` that deny exclusively through this channel while being
    // `blockable: false`.
    if (denyValuesFor(eventSpec).has(jsonDecision.value)) {
      return denied("permission-decision", outcome.exitCode);
    }
    if (allowValuesFor(eventSpec).has(jsonDecision.value)) {
      return allowed(outcome.exitCode);
    }
    // A documented decision value that is neither deny-shaped nor
    // allow-shaped (for example `PreToolUse`'s "ask"/"defer") hands the
    // action back to Claude Code's own normal flow — hookassert has nothing
    // more specific to assert.
    return passed(outcome.exitCode);
  }

  if (jsonDecision.kind === "schema-violation") {
    return errored(outcome.exitCode, "schema-violation");
  }

  // Malformed JSON is reported here — above the "documented exit code"
  // branch below — whenever the exit code is one Claude Code actually
  // attaches meaning to (a successful `0`, or a `non-blocking-error`/
  // `ignored` row this event documents): a hook whose JSON writer crashed
  // mid-output should not be reported as a clean pass or a policy no-op just
  // because its exit code was otherwise unremarkable. An undocumented
  // nonzero exit code still falls through to `nonzero-exit-without-json`
  // below, which already covers "no idea what this exit code means."
  if (
    jsonDecision.kind === "malformed" &&
    (outcome.exitCode === 0 || effect !== undefined)
  ) {
    return errored(outcome.exitCode, "invalid-json");
  }

  if (effect !== undefined) {
    // A documented, non-blocking exit code (`non-blocking-error` or
    // `ignored`) with no JSON decision. This is the "exit 1 from a policy
    // hook is a no-op" case: the hook's own exit code carries no weight for
    // this event, so the action proceeds unchanged.
    return passed(outcome.exitCode);
  }

  if (outcome.exitCode === 0) {
    return passed(outcome.exitCode);
  }

  // A non-zero exit code the spec does not document for this event (neither
  // 1 nor 2) with no recognizable JSON decision: nothing tells us what the
  // hook intended.
  return errored(outcome.exitCode, "nonzero-exit-without-json");
}

/**
 * Whether `outcome` is the specific combination `resolveDecision` resolves
 * to `deny` despite stdout JSON saying `allow`: an `exit 2`-equivalent
 * block effect alongside an allow-shaped decision value.
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
  return (
    jsonDecision.kind === "decision" &&
    allowValuesFor(eventSpec).has(jsonDecision.value)
  );
}
