/**
 * The shared shape behind `matcher-comma-version` and `matcher-hyphen-version`:
 * a matcher that relies on a version-gated exact-list notation character
 * (a comma or a hyphen), checked against the Claude Code version this lint
 * run assumes.
 *
 * @remarks
 * Deliberately independent of `matcher/classify.ts`'s own version-gating —
 * see `shared.ts`'s doc comment for why `isExactListSyntax` (which this
 * builds on) does not fold the version gate into its own verdict.
 *
 * Mirrors `matcher/classify.ts`'s own `hasUnsatisfiedNotationRule`: both
 * rules gate the original `"tool-name"` matcher grammar only — see that
 * module's own remark for why a `"field"`/`"enum"` target's `sinceVersion:
 * null` matcher domains were never subject to this notation gate at all.
 *
 * An undetermined version degrades to an unknown-confidence `Finding`
 * rather than being silently omitted, mirroring `#5`'s own version-gating
 * rule that an undetermined version never silently passes — the message
 * says the version could not be determined rather than naming a definite
 * failure, so a reader can tell the two apart. A known version outside
 * `spec.claudeCodeRange` degrades the same way — `classify.ts`'s own
 * `isVersionKnownOutOfRange` treats such a version as unable to confirm
 * *anything* about the spec it is checked against, not only the notation
 * rules this module gates, so this mirrors that rather than trusting
 * `meetsSinceVersion` on a version the loaded spec was never declared to
 * describe.
 */

import { isInDeclaredRange, meetsSinceVersion } from "../../spec/index.js";
import type { VersionContext } from "../../matcher/index.js";
import type { Finding, LintContext, LintRule } from "../types.js";
import { isExactListSyntax, isToolNameEvent } from "../shared.js";

/**
 * Format a `"known"` {@link VersionContext} as `major.minor.patch`.
 *
 * @remarks
 * A small, local duplicate of `report/summary.ts`'s own `formatClaudeVersion`
 * rather than an import from it: `report/` is the rendering layer built on
 * top of `lint/`'s own domain types (see `report/lintReport.ts`), and a
 * dependency the other way around would invert that. Only the `"known"`
 * branch is needed here — this is only ever called after `ctx.versionContext.kind
 * === "known"` has already been checked.
 */
function formatKnownVersion(
  version: Extract<VersionContext, { kind: "known" }>,
): string {
  const { major, minor, patch } = version.version;
  return `${String(major)}.${String(minor)}.${String(patch)}`;
}

interface VersionNotationRuleOptions {
  /** `matcher-comma-version` or `matcher-hyphen-version`. */
  readonly ruleId: string;

  /** The character this notation adds to the exact-list grammar (`","` or `"-"`). */
  readonly character: string;

  /** The `spec.matcherSyntax.rules[].id` this notation is gated by (`"comma-separated-list"` or `"hyphen-exact-match"`). */
  readonly matcherSyntaxRuleId: string;

  /** How this notation reads in a message, e.g. `"a comma-separated list"`. */
  readonly notationLabel: string;
}

/** Build the `LintRule` for one version-gated exact-list notation character. */
export function createVersionNotationRule(
  options: VersionNotationRuleOptions,
): LintRule {
  const { ruleId, character, matcherSyntaxRuleId, notationLabel } = options;

  return {
    id: ruleId,

    run(ctx: LintContext): readonly Finding[] {
      const rule = ctx.spec.matcherSyntax.rules.find(
        (r) => r.id === matcherSyntaxRuleId,
      );
      if (rule === undefined) {
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
        if (!matcher.includes(character)) {
          continue;
        }
        if (!isExactListSyntax(ctx.spec, group.event, matcher)) {
          continue;
        }

        const isOutOfRange =
          ctx.versionContext.kind === "known" &&
          !isInDeclaredRange(ctx.spec, ctx.versionContext.version);

        if (
          ctx.versionContext.kind === "known" &&
          !isOutOfRange &&
          meetsSinceVersion(ctx.versionContext.version, rule.sinceVersion)
        ) {
          // Fully supported on the version this run assumes — nothing to report.
          continue;
        }

        const message =
          ctx.versionContext.kind === "undetermined" || isOutOfRange
            ? `Matcher "${matcher}" uses ${notationLabel}, supported since Claude ` +
              `Code ${rule.sinceVersion}, but the running Claude Code version could ` +
              "not be determined — this notation might not be supported."
            : `Matcher "${matcher}" uses ${notationLabel}, which requires Claude ` +
              `Code >= ${rule.sinceVersion}, but the detected version is ` +
              `${formatKnownVersion(ctx.versionContext)}.`;

        findings.push({
          file: group.file,
          line: group.line,
          ruleId,
          message,
          suggestion:
            "Pass --claude-version to confirm the running Claude Code version, or " +
            `upgrade to >= ${rule.sinceVersion}, or declare one hook per tool instead ` +
            `of ${notationLabel}.`,
        });
      }
      return findings;
    },
  };
}
