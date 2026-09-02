/**
 * The active `LintRule`s the `lint` subcommand iterates.
 *
 * @remarks
 * Six matcher rules, plus six command/exit-code rules (`command-not-found`,
 * `missing-shebang`, `not-executable`, `unquoted-var`, `exit-1-policy`,
 * `exit-2-overrides-allow`). `docs/troubleshooting-map.md` maps official
 * Claude Code troubleshooting symptoms to a subset of these rule ids;
 * `tests/troubleshooting-map.test.ts` asserts every id it references still
 * exists here.
 */

import { commandNotFoundRule } from "./rules/commandNotFound.js";
import { exit1PolicyRule } from "./rules/exit1Policy.js";
import { exit2OverridesAllowRule } from "./rules/exit2OverridesAllow.js";
import { matcherCaseRule } from "./rules/matcherCase.js";
import { matcherCatastrophicRule } from "./rules/matcherCatastrophic.js";
import { matcherCommaVersionRule } from "./rules/matcherCommaVersion.js";
import { matcherDeadRule } from "./rules/matcherDead.js";
import { matcherHyphenVersionRule } from "./rules/matcherHyphenVersion.js";
import { matcherIsArrayRule } from "./rules/matcherIsArray.js";
import { matcherUnanchoredRule } from "./rules/matcherUnanchored.js";
import { missingShebangRule } from "./rules/missingShebang.js";
import { notExecutableRule } from "./rules/notExecutable.js";
import { unquotedVarRule } from "./rules/unquotedVar.js";
import type { LintRule } from "./types.js";

/** Every lint rule `lint` runs, in the order findings are reported. */
export const LINT_RULES: readonly LintRule[] = [
  matcherIsArrayRule,
  matcherCaseRule,
  matcherCommaVersionRule,
  matcherHyphenVersionRule,
  matcherDeadRule,
  matcherUnanchoredRule,
  matcherCatastrophicRule,
  commandNotFoundRule,
  missingShebangRule,
  notExecutableRule,
  unquotedVarRule,
  exit1PolicyRule,
  exit2OverridesAllowRule,
];
