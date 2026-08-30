/**
 * The seam a later issue's real Claude Code version detection implements.
 *
 * @remarks
 * Declared here, as a type only, because {@link UnknownReason}'s
 * `"version-undetermined"` member (`src/types.ts`) already needs a closed
 * `VersionSourceName` vocabulary to report which sources a probe tried, and
 * the `executor` issue's design section names this interface explicitly.
 * `detect()`'s actual body — spawning `claude --version`, reading an
 * environment variable, falling back to a `record`ed session's own recorded
 * version — is the `test-cmd` issue's work, which is also what wires a real
 * `VersionProbe` into version resolution. Nothing in this package constructs
 * one yet.
 */

import type { ClaudeVersion } from "../spec/index.js";

/**
 * Detects the Claude Code version a `test` run should assume, or reports
 * that it could not.
 */
export interface VersionProbe {
  /**
   * @returns The detected version, or `undefined` when no source this probe
   * tried could determine one.
   */
  detect(): Promise<ClaudeVersion | undefined>;
}
