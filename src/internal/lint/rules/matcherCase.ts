/**
 * `matcher-case`: a matcher whose case does not exactly match a known
 * tool's own case.
 *
 * @remarks
 * Conditional on `spec.matcherSyntax.caseSensitive`. When it is `true`,
 * `matcher/match.ts` compares an exact-list item against `req.target` with
 * plain `===` — so `"bash"` when the tool is `"Bash"` is a real, silent
 * non-match, not a style nit: the hook this matcher is attached to will
 * never fire. When it is `false`, `match.ts` lowercases both sides before
 * comparing, so a wrong-case matcher matches anyway and this rule reports
 * nothing.
 */

import type { Finding, LintContext, LintRule } from "../types.js";
import { isExactListSyntax, isToolNameEvent, splitListItems } from "../shared.js";

interface CaseMismatch {
  readonly item: string;
  readonly correct: string;
}

function findCaseInsensitiveMatch(
  knownTools: readonly string[],
  item: string,
): string | undefined {
  return knownTools.find((tool) => tool.toLowerCase() === item.toLowerCase());
}

function findMismatches(
  knownTools: readonly string[],
  items: readonly string[],
): readonly CaseMismatch[] {
  const mismatches: CaseMismatch[] = [];
  for (const item of items) {
    const correct = findCaseInsensitiveMatch(knownTools, item);
    if (correct !== undefined && correct !== item) {
      mismatches.push({ item, correct });
    }
  }
  return mismatches;
}

/** The delimiter `matcher` was split on — `"|"` when present, `","` otherwise (`splitListItems`'s own precedence). */
function delimiterOf(matcher: string): string {
  return matcher.includes("|") ? "|" : ",";
}

function correctedMatcher(
  matcher: string,
  items: readonly string[],
  mismatches: readonly CaseMismatch[],
): string {
  return items
    .map(
      (item) => mismatches.find((mismatch) => mismatch.item === item)?.correct ?? item,
    )
    .join(delimiterOf(matcher));
}

export const matcherCaseRule: LintRule = {
  id: "matcher-case",

  run(ctx: LintContext): readonly Finding[] {
    if (!ctx.spec.matcherSyntax.caseSensitive) {
      return [];
    }
    const findings: Finding[] = [];
    for (const group of ctx.groups) {
      if (group.matcher.kind !== "string") {
        continue;
      }
      if (!isToolNameEvent(ctx.spec, group.event)) {
        continue;
      }
      const matcher = group.matcher.value;
      if (!isExactListSyntax(ctx.spec, group.event, matcher)) {
        continue;
      }

      const items = splitListItems(matcher);
      const mismatches = findMismatches(ctx.spec.knownTools, items);
      if (mismatches.length === 0) {
        continue;
      }

      const names = mismatches.map((mismatch) => `"${mismatch.item}"`).join(", ");
      findings.push({
        file: group.file,
        line: group.line,
        ruleId: "matcher-case",
        message:
          `Matcher "${matcher}" uses the wrong case for ${names}. Matcher ` +
          "comparison is case-sensitive, so this never matches.",
        suggestion: `Use "${correctedMatcher(matcher, items, mismatches)}" instead of "${matcher}".`,
      });
    }
    return findings;
  },
};
