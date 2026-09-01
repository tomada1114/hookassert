/**
 * `matcher-comma-version`: a comma-separated-list matcher used with a
 * detected (or undetermined) Claude Code version that cannot be confirmed
 * to support `comma-separated-list` (`spec.matcherSyntax.rules[].sinceVersion`
 * `2.1.191` in the transcribed spec).
 */

import { createVersionNotationRule } from "./versionNotationRule.js";

export const matcherCommaVersionRule = createVersionNotationRule({
  ruleId: "matcher-comma-version",
  character: ",",
  matcherSyntaxRuleId: "comma-separated-list",
  notationLabel: "a comma-separated list",
});
