/**
 * `matcher-hyphen-version`: an exact-list matcher item containing a hyphen,
 * used with a detected (or undetermined) Claude Code version that cannot be
 * confirmed to support `hyphen-exact-match`
 * (`spec.matcherSyntax.rules[].sinceVersion` `2.1.195` in the transcribed
 * spec) — the notation an MCP tool name such as `mcp__stripe-mcp__create`
 * relies on for its hyphen to be treated as part of the exact name rather
 * than rejected.
 */

import { createVersionNotationRule } from "./versionNotationRule.js";

export const matcherHyphenVersionRule = createVersionNotationRule({
  ruleId: "matcher-hyphen-version",
  character: "-",
  matcherSyntaxRuleId: "hyphen-exact-match",
  notationLabel: "a hyphen in an exact-match item",
});
