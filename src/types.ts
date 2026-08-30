/**
 * The type vocabulary every other hookassert module speaks.
 *
 * @remarks
 * This module holds declarations only — no implementation — so that
 * `src/index.ts` can publish the vocabulary without publishing any of the
 * machinery behind it. Anything with a runtime body belongs in a module of its
 * own.
 *
 * @packageDocumentation
 */

/**
 * Name of a Claude Code hook event.
 *
 * @remarks
 * The complete set of officially documented event names, transcribed from the
 * Claude Code hooks documentation into `spec/claude-code-2.1.251-2.2.0.json`.
 * This union has to match that spec's `events` keys exactly; extend both
 * together when a later spec range adds or removes an event.
 *
 * @public
 */
export type EventName =
  | "SessionStart"
  | "Setup"
  | "InstructionsLoaded"
  | "UserPromptSubmit"
  | "UserPromptExpansion"
  | "MessageDisplay"
  | "PreToolUse"
  | "PermissionRequest"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PostToolBatch"
  | "PermissionDenied"
  | "Notification"
  | "SubagentStart"
  | "SubagentStop"
  | "TaskCreated"
  | "TaskCompleted"
  | "Stop"
  | "StopFailure"
  | "TeammateIdle"
  | "ConfigChange"
  | "CwdChanged"
  | "DirectoryAdded"
  | "FileChanged"
  | "WorktreeCreate"
  | "WorktreeRemove"
  | "PreCompact"
  | "PostCompact"
  | "PreModelSwitch"
  | "PostModelSwitch"
  | "SessionEnd"
  | "Elicitation"
  | "ElicitationResult";

/**
 * Which settings file a hook declaration came from.
 *
 * @remarks
 * `user`, `project`, and `local` are the three layers Claude Code merges, in
 * that order. `explicit` is a settings file named on the command line, which
 * takes part in the same merge but belongs to none of the three.
 *
 * @public
 */
export type SettingsLayer = "user" | "project" | "local" | "explicit";

/**
 * Where a hook declaration was read from.
 *
 * @remarks
 * Every field is required. A hook that cannot say which line of which file
 * declared it cannot be reported against that line, and pointing at the
 * offending line is the whole product of `explain` and of the GitHub Actions
 * reporter.
 *
 * @public
 */
export interface Provenance {
  /** Absolute path of the settings file the declaration was read from. */
  readonly file: string;

  /** Which merged layer {@link Provenance.file} belongs to. */
  readonly layer: SettingsLayer;

  /** 1-based line of the declaration within {@link Provenance.file}. */
  readonly line: number;

  /** 1-based column of the declaration within {@link Provenance.file}. */
  readonly col: number;

  /** Offset of the declaration into the settings file's source text. */
  readonly offset: number;
}

/**
 * One hook declaration, after the settings layers have been merged.
 *
 * @remarks
 * A field that can be absent is typed `T | undefined` rather than declared with
 * `?:`. Under `exactOptionalPropertyTypes` those are distinct types, and only
 * the explicit union lets a reader tell "this hook declares no matcher" from
 * "this record forgot to say" — the second is a bug in the loader, and it
 * should not typecheck.
 *
 * @public
 */
export interface ResolvedHook {
  /** Event the hook is declared under. */
  readonly event: EventName;

  /** Matcher as written, or `undefined` when the declaration carries none. */
  readonly matcher: string | undefined;

  /** Command the hook runs. */
  readonly command: string;

  /**
   * Arguments passed to {@link ResolvedHook.command}, or `undefined` when the
   * declaration passes none.
   */
  readonly args: readonly string[] | undefined;

  /**
   * Per-hook deadline in milliseconds, or `undefined` to use Claude Code's own
   * default rather than an override.
   */
  readonly timeoutMs: number | undefined;

  /** Where the declaration was read from. */
  readonly provenance: Provenance;

  /**
   * Key the concatenating merge deduplicates identical declarations on.
   *
   * @remarks
   * Opaque to a consumer: it is derived from the declaration, but which parts
   * of it and in what form is the merge's business. `explain` displays it
   * verbatim so two hooks that collapsed into one can be told apart from two
   * that did not.
   */
  readonly dedupeKey: string;
}
