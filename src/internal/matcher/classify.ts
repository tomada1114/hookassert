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
 */

import type { EventName } from "../../types.js";
import { isInDeclaredRange, meetsSinceVersion } from "../spec/index.js";
import type { Spec } from "../spec/index.js";
import type { MatcherKind, VersionContext } from "./types.js";

/**
 * Which character each version-gated exact-list notation rule adds to
 * `matcherSyntax.exactListPattern`.
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
 */
const RULE_CHARACTERS: Readonly<Record<string, string>> = {
  "comma-separated-list": ",",
  "hyphen-exact-match": "-",
};

function isVersionKnownOutOfRange(spec: Spec, v: VersionContext): boolean {
  return v.kind === "known" && !isInDeclaredRange(spec, v.version);
}

/**
 * Whether `matcher` implicates a version-gated exact-list rule that `v`
 * cannot be confirmed to satisfy.
 */
function hasUnsatisfiedNotationRule(
  spec: Spec,
  v: VersionContext,
  matcher: string,
): boolean {
  return spec.matcherSyntax.rules.some((rule) => {
    const character = RULE_CHARACTERS[rule.id];
    if (character === undefined || !matcher.includes(character)) {
      return false;
    }
    return (
      v.kind === "undetermined" || !meetsSinceVersion(v.version, rule.sinceVersion)
    );
  });
}

/**
 * Classify `matcher` for `event` under `spec`, given the run's detected
 * Claude Code version.
 *
 * @remarks
 * Checked in this order:
 * 1. `spec.events[event].matcherTargets.kind === "none"` → `"unsupported"`,
 *    regardless of version — whether an event accepts a matcher at all does
 *    not vary with the Claude Code version this spec file covers.
 * 2. A version known to be outside `spec.claudeCodeRange` → `"unknown"` for
 *    every matcher against this run, not only version-dependent notation.
 * 3. Otherwise, `matcher` is tested against the event's exact-list character
 *    set (`narrowExactListPattern` for `narrowExactMatchEvents`,
 *    `exactListPattern` for every other event). A match that also relies on
 *    a version-gated notation (a comma or a hyphen) whose `sinceVersion` the
 *    version cannot be confirmed to meet — including an undetermined
 *    version — degrades to `"unknown"` rather than silently passing as
 *    supported or failing as unsupported.
 */
export function classifyMatcher(
  spec: Spec,
  v: VersionContext,
  event: EventName,
  matcher: string,
): MatcherKind {
  const eventSpec = spec.events[event];
  if (eventSpec?.matcherTargets.kind === "none") {
    return "unsupported";
  }

  if (isVersionKnownOutOfRange(spec, v)) {
    return "unknown";
  }

  const useNarrowPattern = spec.matcherSyntax.narrowExactMatchEvents.includes(event);
  const exactListPattern = useNarrowPattern
    ? spec.matcherSyntax.narrowExactListPattern
    : spec.matcherSyntax.exactListPattern;

  if (!new RegExp(exactListPattern).test(matcher)) {
    return "unanchored-regex";
  }

  if (hasUnsatisfiedNotationRule(spec, v, matcher)) {
    return "unknown";
  }

  return "exact-list";
}
