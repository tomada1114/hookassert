/**
 * `matcher-catastrophic`: a string matcher whose pattern contains a nested
 * unbounded quantifier — the shape that makes `new RegExp(matcher).test(...)`
 * backtrack exponentially and can hang `explain`, `lint`, or `test`.
 *
 * @remarks
 * Calls the same `matcher/safety.ts`'s `findCatastrophicConstruct`
 * `matcher/classify.ts` consults on the regex path. That module's own
 * screen is what keeps `explain`/`test` from ever compiling such a pattern,
 * independent of whether `lint` ran; this rule is where the diagnosis
 * belongs — naming the file/line and a concrete rewrite.
 *
 * Applies to every string matcher regardless of `event`'s
 * `matcherTargets.kind`: a catastrophic pattern is dangerous to compile no
 * matter what value it would eventually be tested against, so this rule
 * does not gate on `isToolNameEvent` the way the other matcher rules do.
 */

import { findCatastrophicConstruct } from "../../matcher/index.js";
import type { Finding, LintContext, LintRule } from "../types.js";

export const matcherCatastrophicRule: LintRule = {
  id: "matcher-catastrophic",

  run(ctx: LintContext): readonly Finding[] {
    const findings: Finding[] = [];
    for (const group of ctx.groups) {
      if (group.matcher.kind !== "string") {
        continue;
      }
      const matcher = group.matcher.value;
      const construct = findCatastrophicConstruct(matcher);
      if (construct === undefined) {
        continue;
      }

      findings.push({
        file: group.file,
        line: group.line,
        ruleId: "matcher-catastrophic",
        message: `Matcher "${matcher}" contains a ${construct}, which can hang instead of matching.`,
        suggestion:
          `Rewrite the pattern without a nested quantifier — for example, ` +
          `"a+" instead of "(a+)+" — or use an exact-match list naming the ` +
          "intended tool(s) instead.",
      });
    }
    return findings;
  },
};
