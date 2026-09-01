/**
 * `matcher-is-array`: a matcher written as a JSON array rather than a
 * string.
 *
 * @remarks
 * The highest-impact of the five matcher rules: Claude Code's settings
 * schema rejects an array-valued matcher, and `settings/load.ts`'s own
 * `loadSourceHooks` proves the consequence
 * (`tests/settings.test.ts`'s "a matcher written as a JSON array disables
 * every hook in that settings file" test) — the failure is not scoped to
 * the one offending hook, it discards every hook the whole settings file
 * declares. `Finding.message` says so explicitly rather than a generic
 * "invalid matcher type", because that blast radius is the entire point of
 * flagging this before it reaches a real Claude Code session.
 */

import type { Finding, LintContext, LintRule } from "../types.js";

function suggestionFor(items: readonly string[]): string {
  if (items.length === 0) {
    return 'Change the matcher to a comma-separated string, e.g. "Edit,Write".';
  }
  const joined = items.join(",");
  return `Change the matcher to the string ${JSON.stringify(joined)} instead of a JSON array.`;
}

export const matcherIsArrayRule: LintRule = {
  id: "matcher-is-array",

  run(ctx: LintContext): readonly Finding[] {
    const findings: Finding[] = [];
    for (const group of ctx.groups) {
      if (group.matcher.kind !== "array") {
        continue;
      }
      findings.push({
        file: group.file,
        line: group.line,
        ruleId: "matcher-is-array",
        message:
          `The "${group.event}" hook's matcher is a JSON array, not a string. ` +
          "Claude Code's settings schema rejects this, which disables every " +
          "hook declared in this entire settings file — not just this one hook.",
        suggestion: suggestionFor(group.matcher.items),
      });
    }
    return findings;
  },
};
