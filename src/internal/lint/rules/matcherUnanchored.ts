/**
 * `matcher-unanchored`: an unanchored regex matcher that over-matches beyond
 * the tool name it was probably meant to target.
 *
 * @remarks
 * Builds directly on `matcher/classify.ts`'s own `classifyMatcher` — this
 * issue is the first to build static analysis on top of that classification
 * rather than a live firing decision. `"*"` is excluded outright: it is
 * Claude Code's own documented "match everything" wildcard
 * (`matcher/match.ts`'s `testUnanchoredRegex` special-cases it the same
 * way), not a mistake to flag.
 *
 * The "probably meant to target" tool is guessed from the matcher's own
 * literal prefix — the characters before its first regex metacharacter,
 * with a leading `^` anchor stripped first so an already-anchored,
 * single-match pattern (`"^Edit$"`) is never flagged (it matches at most one
 * known tool, which is gated out before the prefix guess is even
 * consulted). When two or more known tools match and the guessed prefix
 * does not equal one of them exactly, every match is reported as
 * unintended — there is no single obvious target to exclude.
 */

import { classifyMatcher } from "../../matcher/index.js";
import type { Finding, LintContext, LintRule } from "../types.js";
import { isToolNameEvent } from "../shared.js";

const REGEX_METACHARACTER = /[.*+?^${}()|[\]\\]/;

/** The literal characters before `matcher`'s first regex metacharacter, with a leading `^` anchor stripped. */
function literalPrefix(matcher: string): string {
  const stripped = matcher.startsWith("^") ? matcher.slice(1) : matcher;
  const metaIndex = stripped.search(REGEX_METACHARACTER);
  return metaIndex === -1 ? stripped : stripped.slice(0, metaIndex);
}

/** `new RegExp(matcher).test(tool)`, with `matcher/match.ts`'s own tolerance for `"*"` and an uncompilable pattern. */
function testRegexSafe(matcher: string, tool: string): boolean {
  if (matcher === "*") {
    return true;
  }
  try {
    return new RegExp(matcher).test(tool);
  } catch {
    return false;
  }
}

export const matcherUnanchoredRule: LintRule = {
  id: "matcher-unanchored",

  run(ctx: LintContext): readonly Finding[] {
    const findings: Finding[] = [];
    for (const group of ctx.groups) {
      if (group.matcher.kind !== "string") {
        continue;
      }
      if (!isToolNameEvent(ctx.spec, group.event)) {
        continue;
      }
      const matcher = group.matcher.value;
      if (matcher === "*") {
        continue;
      }
      const kind = classifyMatcher(ctx.spec, ctx.versionContext, group.event, matcher);
      if (kind !== "unanchored-regex") {
        continue;
      }

      const matched = ctx.spec.knownTools.filter((tool) =>
        testRegexSafe(matcher, tool),
      );
      if (matched.length <= 1) {
        continue;
      }
      const intended = literalPrefix(matcher);
      const unintended = matched.filter((tool) => tool !== intended);
      if (unintended.length === 0) {
        continue;
      }

      const names = unintended.map((tool) => `"${tool}"`).join(", ");
      findings.push({
        file: group.file,
        line: group.line,
        ruleId: "matcher-unanchored",
        message:
          `Matcher "${matcher}" is an unanchored regex and also matches ${names}, ` +
          "beyond the tool it was probably meant to target.",
        suggestion:
          `Anchor the pattern, e.g. "^${matcher.replace(/^\^/, "")}$", or use an ` +
          "exact-match list naming only the intended tool(s).",
      });
    }
    return findings;
  },
};
