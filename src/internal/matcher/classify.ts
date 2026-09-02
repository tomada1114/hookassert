/**
 * The three-way matcher classification: exact-match list, unanchored regex,
 * or "unknown" when confidence cannot be established.
 *
 * @remarks
 * Static layer: pure, spec-driven classification — no I/O, no process, no
 * write. A matcher string is an exact-match list only when every character
 * in it is inside `spec.matcherSyntax.exactListPattern` (or
 * `narrowExactListPattern`, for the events `narrowExactMatchEvents` names);
 * anything else is an unanchored regular expression. Do not add `^`/`$`
 * anchors "to be safe" — the over-matching behavior this reproduces
 * (`"Edit.*"` matching `"NotebookEdit"`) is real, documented Claude Code
 * behavior, not a bug to fix here.
 *
 * Whether `event`'s `matcherTargets.kind` is `"none"` plays no part here:
 * `match.ts` fires every hook under such an event, matcher ignored, before
 * ever calling `classifyMatcher` — so this module's classification is
 * purely syntactic and never needs an `"unsupported"` verdict.
 *
 * A matcher on the regex path is screened by `safety.ts`'s
 * `findCatastrophicConstruct` before it is ever handed to `new RegExp` —
 * see that module's own remarks for why a nested unbounded quantifier
 * degrades to `"unknown"` here instead of being compiled and run.
 *
 * `exactListPattern` and `narrowExactListPattern` themselves are compiled
 * with `new RegExp` below without a try/catch: `spec/guards.ts`'s
 * `validateSpec` already rejects an uncompilable pattern at load time, so a
 * `Spec` reaching this module is guaranteed to carry one that compiles.
 */

import type { EventName } from "../../types.js";
import { isInDeclaredRange, meetsSinceVersion } from "../spec/index.js";
import type { Spec } from "../spec/index.js";
import { findCatastrophicConstruct } from "./safety.js";
import type { ClassifyResult, MatcherKind, VersionContext } from "./types.js";

/**
 * Which character each version-gated exact-list notation rule adds to
 * `matcherSyntax.exactListPattern`, for a `"tool-name"` target only.
 *
 * @remarks
 * The spec carries no machine-readable link from a `MatcherRule.id` to the
 * character(s) it gates — `exactListPattern` is only ever the union of every
 * currently supported character, gated or not. This maps the two rule ids
 * `spec/claude-code-2.1.251-2.2.0.json` documents today by what their names
 * say they gate: `comma-separated-list` is the delimiter `","`,
 * `hyphen-exact-match` is `"-"`. A rule id this map does not recognize is
 * treated as gating nothing, so a future spec adding an unrelated rule here
 * degrades gracefully rather than throwing.
 *
 * A `Map`, not a plain object: `RULE_CHARACTERS[rule.id]` for a rule id like
 * `"toString"` would read through `Object.prototype` and yield a function
 * rather than `undefined`, silently passing the "not a gated character"
 * guard below. `Map.prototype.get` has no such inherited-key hazard.
 *
 * Both rules gate the original `"tool-name"` matcher grammar only —
 * `spec.matcherTable`'s worked examples for `"field"`-kind targets
 * (`PreModelSwitch "claude-opus-5"`, `PostModelSwitch
 * "claude-opus-4-6|claude-opus-5"`, `Elicitation`/`ElicitationResult
 * "my-mcp-server"`) all carry `sinceVersion: null`: those matcher domains
 * were never subject to the legacy tool-name parser these rules describe,
 * so a hyphen there was never gated. Applying the character heuristic to
 * every target kind degrades those matchers to `"unknown"` under an
 * undetermined version even though the spec declares them ungated.
 */
const RULE_CHARACTERS: ReadonlyMap<string, string> = new Map([
  ["comma-separated-list", ","],
  ["hyphen-exact-match", "-"],
]);

function isVersionKnownOutOfRange(spec: Spec, v: VersionContext): boolean {
  return v.kind === "known" && !isInDeclaredRange(spec, v.version);
}

/**
 * Whether `matcher` implicates a version-gated exact-list rule that `v`
 * cannot be confirmed to satisfy.
 *
 * @remarks
 * Only applies to a `"tool-name"` target — see {@link RULE_CHARACTERS}.
 */
function hasUnsatisfiedNotationRule(
  spec: Spec,
  v: VersionContext,
  event: EventName,
  matcher: string,
): boolean {
  if (spec.events[event]?.matcherTargets.kind !== "tool-name") {
    return false;
  }
  return spec.matcherSyntax.rules.some((rule) => {
    const character = RULE_CHARACTERS.get(rule.id);
    if (character === undefined || !matcher.includes(character)) {
      return false;
    }
    return (
      v.kind === "undetermined" || !meetsSinceVersion(v.version, rule.sinceVersion)
    );
  });
}

/**
 * The shared classification logic behind {@link classifyMatcher} and
 * {@link classifyMatcherDetailed}.
 *
 * @remarks
 * Checked in this order:
 * 1. `event` missing from `spec.events` → `"unknown"` — an event this spec
 *    does not describe cannot be classified with confidence.
 * 2. A version known to be outside `spec.claudeCodeRange` → `"unknown"` for
 *    every matcher against this run, not only version-dependent notation.
 * 3. Otherwise, `matcher` is tested against the event's exact-list character
 *    set (`narrowExactListPattern` for `narrowExactMatchEvents`,
 *    `exactListPattern` for every other event). A non-match puts `matcher`
 *    on the regex path, where a nested unbounded quantifier — see
 *    `safety.ts`'s `findCatastrophicConstruct` — degrades it to
 *    `"unknown"` before it is ever compiled.
 * 4. An exact-list match that also relies on a version-gated notation (a
 *    comma or a hyphen, and only for a `"tool-name"` target — see
 *    {@link RULE_CHARACTERS}) whose `sinceVersion` the version cannot be
 *    confirmed to meet — including an undetermined version — degrades to
 *    `"unknown"` rather than silently passing as supported or failing as
 *    unsupported.
 */
function classify(
  spec: Spec,
  v: VersionContext,
  event: EventName,
  matcher: string,
): ClassifyResult {
  if (spec.events[event] === undefined) {
    return {
      kind: "unknown",
      reason: `the ${event} event is not described by this spec, so its matcher cannot be classified with confidence`,
    };
  }

  if (isVersionKnownOutOfRange(spec, v)) {
    return {
      kind: "unknown",
      reason: "the detected Claude Code version is outside spec.claudeCodeRange",
    };
  }

  const useNarrowPattern = spec.matcherSyntax.narrowExactMatchEvents.includes(event);
  const exactListPattern = useNarrowPattern
    ? spec.matcherSyntax.narrowExactListPattern
    : spec.matcherSyntax.exactListPattern;

  if (!new RegExp(exactListPattern).test(matcher)) {
    const construct = findCatastrophicConstruct(matcher);
    if (construct !== undefined) {
      return {
        kind: "unknown",
        reason: `this matcher cannot be evaluated safely: ${construct}; rewrite it without a nested quantifier`,
      };
    }
    return { kind: "unanchored-regex" };
  }

  if (hasUnsatisfiedNotationRule(spec, v, event, matcher)) {
    return {
      kind: "unknown",
      reason:
        v.kind === "undetermined"
          ? "the Claude Code version could not be determined, and this matcher relies on a version-gated notation rule"
          : "the detected Claude Code version is below a version-gated notation rule's sinceVersion",
    };
  }

  return { kind: "exact-list" };
}

/**
 * Classify `matcher` for `event` under `spec`, given the run's detected
 * Claude Code version.
 *
 * @remarks
 * See {@link classify} for the order these are checked in. Use
 * {@link classifyMatcherDetailed} when the reason behind an `"unknown"`
 * verdict is also needed.
 */
export function classifyMatcher(
  spec: Spec,
  v: VersionContext,
  event: EventName,
  matcher: string,
): MatcherKind {
  return classify(spec, v, event, matcher).kind;
}

/**
 * {@link classifyMatcher}, plus — when the verdict is `"unknown"` — the
 * specific reason classification could not be established, so
 * `MatcherOutcome.reason` can name the actual cause instead of a fixed
 * string listing every possible one.
 */
export function classifyMatcherDetailed(
  spec: Spec,
  v: VersionContext,
  event: EventName,
  matcher: string,
): ClassifyResult {
  return classify(spec, v, event, matcher);
}
