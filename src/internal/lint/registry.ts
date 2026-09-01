/**
 * The active `LintRule`s the `lint` subcommand iterates.
 *
 * @remarks
 * This issue ships only the five matcher rules; the six command/exit-code
 * rules (`command-not-found`, `missing-shebang`, `not-executable`,
 * `unquoted-var`, `exit-1-policy`, `exit-2-overrides-allow`) are a later
 * issue's own scope and are not registered here.
 */

import { matcherCaseRule } from "./rules/matcherCase.js";
import { matcherCommaVersionRule } from "./rules/matcherCommaVersion.js";
import { matcherDeadRule } from "./rules/matcherDead.js";
import { matcherHyphenVersionRule } from "./rules/matcherHyphenVersion.js";
import { matcherIsArrayRule } from "./rules/matcherIsArray.js";
import { matcherUnanchoredRule } from "./rules/matcherUnanchored.js";
import type { LintRule } from "./types.js";

/** Every lint rule `lint` runs, in the order findings are reported. */
export const LINT_RULES: readonly LintRule[] = [
  matcherIsArrayRule,
  matcherCaseRule,
  matcherCommaVersionRule,
  matcherHyphenVersionRule,
  matcherDeadRule,
  matcherUnanchoredRule,
];
