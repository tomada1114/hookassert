/**
 * Small pieces of matcher-string logic shared by more than one rule.
 *
 * @remarks
 * Static layer: pure — no I/O, no process, no write.
 *
 * Deliberately independent of `matcher/classify.ts`'s `classifyMatcher`,
 * even though it decides a closely related question. `classifyMatcher` folds
 * a version-gated notation rule (a comma or a hyphen, gated by
 * `matcherSyntax.rules[].sinceVersion`) into its own "exact-list" verdict:
 * under an undetermined or too-old version, a matcher that is syntactically
 * an exact-match list — the very thing `matcher-case` and `matcher-dead`
 * need to know to do their own job — classifies as `"unknown"` instead. That
 * degradation is exactly `matcher-comma-version`'s and
 * `matcher-hyphen-version`'s own concern, not `matcher-case`'s or
 * `matcher-dead`'s: whether a matcher is *written* as a list of names is a
 * property of its syntax and content, independent of whether the Claude Code
 * version running it actually supports every character in that syntax.
 * {@link isExactListSyntax} answers only the syntax question, so the four
 * rules that do not care about version stay that way.
 */

import type { EventName } from "../../types.js";
import type { Spec } from "../spec/index.js";

/** Whether `event` targets a tool name — the only target kind `spec.knownTools` and the matcher-syntax rules describe. */
export function isToolNameEvent(spec: Spec, event: EventName): boolean {
  return spec.events[event]?.matcherTargets.kind === "tool-name";
}

/**
 * Whether `matcher` is syntactically a comma/pipe-delimited exact-match
 * list for `event`, independent of any version gate.
 */
export function isExactListSyntax(
  spec: Spec,
  event: EventName,
  matcher: string,
): boolean {
  const useNarrowPattern = spec.matcherSyntax.narrowExactMatchEvents.includes(event);
  const pattern = useNarrowPattern
    ? spec.matcherSyntax.narrowExactListPattern
    : spec.matcherSyntax.exactListPattern;
  return new RegExp(pattern).test(matcher);
}

/** Split an exact-match list matcher into its trimmed, non-empty items — mirrors `matcher/match.ts`'s own `exactListItems`. */
export function splitListItems(matcher: string): readonly string[] {
  return matcher
    .split(/[,|]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
