/**
 * Reads the two `hookSpecificOutput` fields a fixture's `expect.context` and
 * `expect.updatedInput` compare against.
 *
 * @remarks
 * Static layer: pure function, no I/O — `readHookOutput` only ever reads the
 * `ExecOutcome` it is given.
 *
 * Claude Code's hook JSON output carries both values nested under
 * `hookSpecificOutput`: `additionalContext` (a string the model sees) and
 * `updatedInput` (an object replacing the tool's input). That nested
 * location is the only one Claude Code documents — a top-level
 * `additionalContext`/`updatedInput` key is not read.
 */

import type { ExecOutcome } from "../../types.js";
import { isPlainRecord, parseJsonStdout } from "./resolve.js";

/**
 * The two `hookSpecificOutput` fields a fixture case's `expect.context` and
 * `expect.updatedInput` compare against.
 *
 * @remarks
 * Each field is `undefined` when `outcome.stdout` is not JSON, is not a
 * plain object, or its `hookSpecificOutput` (itself not a plain object, or
 * absent) does not carry that key — `readHookOutput` never throws over a
 * hook's stdout, however malformed.
 */
export interface HookOutput {
  /** `hookSpecificOutput.additionalContext`, or `undefined` when absent. */
  readonly additionalContext: unknown;
  /** `hookSpecificOutput.updatedInput`, or `undefined` when absent. */
  readonly updatedInput: unknown;
}

const EMPTY_OUTPUT: HookOutput = {
  additionalContext: undefined,
  updatedInput: undefined,
};

/**
 * Read `outcome.stdout`'s `hookSpecificOutput.additionalContext` and
 * `hookSpecificOutput.updatedInput`, sharing `resolve.ts`'s
 * `parseJsonStdout` — the same "is this even JSON" rule `classifyJsonDecision`
 * uses for `permissionDecision`.
 */
export function readHookOutput(outcome: ExecOutcome): HookOutput {
  const parsed = parseJsonStdout(outcome.stdout);
  if (parsed.kind !== "record") {
    return EMPTY_OUTPUT;
  }

  const hookSpecificOutput = parsed.value["hookSpecificOutput"];
  if (!isPlainRecord(hookSpecificOutput)) {
    return EMPTY_OUTPUT;
  }

  return {
    additionalContext: hookSpecificOutput["additionalContext"],
    updatedInput: hookSpecificOutput["updatedInput"],
  };
}
