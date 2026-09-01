/**
 * `matcher-dead`: an exact-match list item that matches none of
 * `spec.knownTools`, most often a spelling mistake.
 *
 * @remarks
 * Compares case-insensitively against `spec.knownTools` so a pure case
 * mismatch (`"bash"` for `"Bash"`) is left to `matcher-case` — that item
 * genuinely corresponds to a known tool, just spelled with the wrong case,
 * which is a different, more specific fix than "this name does not exist at
 * all". Only an item that matches no known tool even case-insensitively
 * (`"Basher"`, say) is reported here.
 *
 * Scoped to matchers that are syntactically exact-match lists. A matcher
 * classified as an unanchored regex is `matcher-unanchored`'s own concern —
 * a regex that matches no known tool at all is a narrower, harder-to-
 * characterize case this rule does not attempt.
 */

import type { Finding, LintContext, LintRule } from "../types.js";
import { isExactListSyntax, isToolNameEvent, splitListItems } from "../shared.js";

export const matcherDeadRule: LintRule = {
  id: "matcher-dead",

  run(ctx: LintContext): readonly Finding[] {
    const findings: Finding[] = [];
    const knownToolsLower = new Set(
      ctx.spec.knownTools.map((tool) => tool.toLowerCase()),
    );

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
      const dead = items.filter((item) => !knownToolsLower.has(item.toLowerCase()));
      if (dead.length === 0) {
        continue;
      }

      const names = dead.map((item) => `"${item}"`).join(", ");
      findings.push({
        file: group.file,
        line: group.line,
        ruleId: "matcher-dead",
        message:
          `Matcher "${matcher}" includes ${names}, which matches none of the ` +
          `known tools (${ctx.spec.knownTools.join(", ")}). This hook can ` +
          `never fire for ${dead.length === 1 ? "it" : "these"}.`,
        suggestion: `Check for a typo — did you mean one of: ${ctx.spec.knownTools.join(", ")}?`,
      });
    }
    return findings;
  },
};
