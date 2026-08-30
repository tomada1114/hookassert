import type { EventName, SettingsLayer } from "../types.js";

/**
 * The exit code every hookassert failure resolves to.
 *
 * @remarks
 * The whole table is written down here, not only the codes reachable today, so
 * a later error class cites it instead of re-deriving it:
 *
 * | code | meaning |
 * | --- | --- |
 * | `0` | run completed with zero failures (with `--ci`, zero `unknown` too) |
 * | `1` | one or more failures (assertion failures, lint violations); wins whenever it applies alongside another code |
 * | `2` | never returned: `2` means "block" in the hooks domain, so it is reserved and left empty |
 * | `3` | no failures, but one or more `unknown` results, and `--ci` was passed |
 * | `4` | usage error (unknown subcommand or option, missing required argument) |
 * | `5` | load error (a fixture, the spec, or settings could not be read, or a declaration contradicts itself) |
 * | `6` | `test` did not get consent to run (declined at a TTY prompt, or non-TTY without `--ci`/`--yes`) |
 *
 * `2` is the one value the CLI must never produce. Claude Code reads exit 2
 * from a hook as "block this tool call", so a hookassert run that exited 2
 * would be indistinguishable from the thing it is supposed to be reporting on.
 */
export abstract class HookassertError extends Error {
  /**
   * Stable discriminator a caller branches on.
   *
   * @remarks
   * Declared as a string literal by each subclass, so narrowing on `code`
   * yields the concrete error type. `message` carries no such promise.
   */
  abstract readonly code: string;

  /** The process exit code this failure resolves to, from the table above. */
  abstract readonly exitCode: number;
}

/**
 * Thrown when the command line itself is wrong.
 *
 * @remarks
 * An unknown subcommand, an unknown option, or a missing required argument —
 * anything the CLI can reject before it reads a settings file or a fixture. A
 * failure discovered while *loading* one of those is a load error (exit 5)
 * instead, because the invocation was well-formed.
 */
export class UsageError extends HookassertError {
  /** Stable discriminator, unchanged across non-breaking releases. */
  readonly code = "ERR_USAGE" as const;

  /** Usage errors always exit 4. */
  readonly exitCode = 4;

  /**
   * @param message - Human-readable explanation, naming what was expected.
   */
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Thrown when a settings source cannot be turned into hooks.
 *
 * @remarks
 * Covers both ways a settings file can be unreadable as hook configuration: a
 * JSONC syntax error the parser cannot recover from, and a `hooks` value that
 * parses fine but is not shaped the way Claude Code's own settings schema
 * requires (for example, an event whose value is not an array of matcher
 * groups). Either way the file cannot contribute hooks, so both resolve to
 * the same load error from `src/internal/errors.ts`'s exit-code table.
 */
export class SettingsParseError extends HookassertError {
  /** Stable discriminator, unchanged across non-breaking releases. */
  readonly code = "ERR_SETTINGS_PARSE" as const;

  /** Settings parse failures always exit 5 (load error). */
  readonly exitCode = 5;

  /** Absolute path of the settings file that could not be parsed. */
  readonly file: string;

  /** Which merged layer {@link SettingsParseError.file} belongs to. */
  readonly layer: SettingsLayer;

  /**
   * @param file - Absolute path of the offending settings file.
   * @param layer - Which merged layer the file belongs to.
   * @param reason - What about the file's shape or syntax was rejected.
   */
  constructor(file: string, layer: SettingsLayer, reason: string) {
    super(`Failed to parse settings file ${file} (${layer} layer): ${reason}`);
    this.name = "SettingsParseError";
    this.file = file;
    this.layer = layer;
  }
}

/**
 * Thrown when a versioned hooks spec fails schema validation.
 *
 * @remarks
 * Covers both ways `spec/load.ts` can reject a spec file's content: JSON that
 * does not parse at all, and JSON that parses but does not satisfy
 * `schema/spec.schema.json` (a missing required field, a value of the wrong
 * shape, or an unrecognized property). Either way the file cannot be turned
 * into a typed `Spec`, so both resolve to the same load error from
 * `src/internal/errors.ts`'s exit-code table.
 */
export class SpecSchemaError extends HookassertError {
  /** Stable discriminator, unchanged across non-breaking releases. */
  readonly code = "ERR_SPEC_SCHEMA" as const;

  /** Spec schema failures always exit 5 (load error). */
  readonly exitCode = 5;

  /** Absolute path of the spec file that failed validation. */
  readonly file: string;

  /**
   * @param file - Absolute path of the offending spec file.
   * @param reason - What about the file's shape was rejected.
   */
  constructor(file: string, reason: string) {
    super(`Failed to validate spec file ${file}: ${reason}`);
    this.name = "SpecSchemaError";
    this.file = file;
  }
}

/**
 * Thrown when a declared spec file does not exist on disk.
 *
 * @remarks
 * Distinct from {@link SpecSchemaError}: the file's *content* is never
 * inspected here because there is no content to read.
 */
export class SpecNotFoundError extends HookassertError {
  /** Stable discriminator, unchanged across non-breaking releases. */
  readonly code = "ERR_SPEC_NOT_FOUND" as const;

  /** Spec not-found failures always exit 5 (load error). */
  readonly exitCode = 5;

  /** Absolute path that was expected to hold a spec file. */
  readonly file: string;

  /**
   * @param file - Absolute path that was expected to hold a spec file.
   */
  constructor(file: string) {
    super(`Spec file not found: ${file}`);
    this.name = "SpecNotFoundError";
    this.file = file;
  }
}

/**
 * Thrown when a settings file named explicitly on the command line does not
 * exist on disk.
 *
 * @remarks
 * Deliberately narrower than it looks. A *discovered* settings file that is
 * missing contributes zero hooks and is not an error — most projects declare
 * only one or two of the three well-known layers, which is why
 * `settings/load.ts` maps `ENOENT` to an empty hook list.
 *
 * A file the caller named is the opposite case: they asserted it exists, so
 * silently reading zero hooks out of a typo turns `explain` into a tool that
 * confidently reports "no hooks fire" for a settings file it never opened.
 * Only the CLI can tell the two apart, because only the CLI knows which
 * sources came from the user rather than from discovery.
 *
 * Mirrors {@link SpecNotFoundError}: the file's *content* is never inspected
 * here because there is no content to read.
 */
export class SettingsNotFoundError extends HookassertError {
  /** Stable discriminator, unchanged across non-breaking releases. */
  readonly code = "ERR_SETTINGS_NOT_FOUND" as const;

  /** Settings not-found failures always exit 5 (load error). */
  readonly exitCode = 5;

  /** Path that was named on the command line but does not exist. */
  readonly file: string;

  /**
   * @param file - Path that was named on the command line but does not exist.
   */
  constructor(file: string) {
    super(`Settings file not found: ${file}`);
    this.name = "SettingsNotFoundError";
    this.file = file;
  }
}

/**
 * Thrown when a fixture file fails schema validation.
 *
 * @remarks
 * Covers every way `fixture/load.ts` can reject a fixture file's content
 * before it becomes a typed `FixtureFile`: YAML that does not parse at all,
 * YAML that parses but does not satisfy `schema/fixture.schema.json`, a
 * case's `event` that is not one of the documented Claude Code hook events,
 * and an `origin.recorded` envelope file that cannot be read or does not
 * carry a valid `capturedAt`. All of these mean the file cannot be turned
 * into a typed `FixtureFile`, so they resolve to the same load error from
 * `src/internal/errors.ts`'s exit-code table.
 */
export class FixtureSchemaError extends HookassertError {
  /** Stable discriminator, unchanged across non-breaking releases. */
  readonly code = "ERR_FIXTURE_SCHEMA" as const;

  /** Fixture schema failures always exit 5 (load error). */
  readonly exitCode = 5;

  /** Absolute path of the fixture file that failed validation. */
  readonly file: string;

  /**
   * @param file - Absolute path of the offending fixture file.
   * @param reason - What about the file's shape was rejected.
   */
  constructor(file: string, reason: string) {
    super(`Failed to validate fixture file ${file}: ${reason}`);
    this.name = "FixtureSchemaError";
    this.file = file;
  }
}

/**
 * Thrown when a declared fixture file does not exist on disk.
 *
 * @remarks
 * Distinct from {@link FixtureSchemaError}: the file's *content* is never
 * inspected here because there is no content to read. Mirrors
 * {@link SpecNotFoundError}.
 */
export class FixtureNotFoundError extends HookassertError {
  /** Stable discriminator, unchanged across non-breaking releases. */
  readonly code = "ERR_FIXTURE_NOT_FOUND" as const;

  /** Fixture not-found failures always exit 5 (load error). */
  readonly exitCode = 5;

  /** Absolute path that was expected to hold a fixture file. */
  readonly file: string;

  /**
   * @param file - Absolute path that was expected to hold a fixture file.
   */
  constructor(file: string) {
    super(`Fixture file not found: ${file}`);
    this.name = "FixtureNotFoundError";
    this.file = file;
  }
}

/**
 * Thrown when `test` did not obtain consent to spawn the hooks its fixtures
 * would run.
 *
 * @remarks
 * Raised in exactly two situations, per this issue's consent-gate design: a
 * TTY invocation where the user declined the confirmation prompt, or a
 * non-TTY invocation (`!process.stdout.isTTY`) that passed neither `--yes`
 * nor `--ci`. This is deliberately a load-time-adjacent failure (exit `6`),
 * not a plain assertion failure (`1`): nothing was actually run, so it would
 * be misleading to report it the same way as a fixture case that ran and
 * disagreed with its own `expect`.
 */
export class ConsentRequiredError extends HookassertError {
  /** Stable discriminator, unchanged across non-breaking releases. */
  readonly code = "ERR_CONSENT_REQUIRED" as const;

  /** Consent failures always exit 6. */
  readonly exitCode = 6;

  /**
   * @param message - Human-readable explanation of why consent was not obtained.
   */
  constructor(message: string) {
    super(message);
    this.name = "ConsentRequiredError";
  }
}

/**
 * Thrown when a fixture case expects a decision the event it targets can
 * never produce.
 *
 * @remarks
 * A case that declares `expect.decision: "deny"` against an event the loaded
 * spec documents no deny channel for — neither an honored blocking exit code
 * nor a deny-shaped value in its own `jsonDecisions`, which is what
 * `decision/`'s `canProduceDeny` weighs — cannot possibly pass: no hook run
 * against it will ever produce a `deny` decision. `blockable` alone is *not*
 * that test; it describes only the exit-code channel, and `PermissionRequest`,
 * `PostToolUse` and `PostToolUseFailure` all deny through JSON while being
 * `blockable: false`. `fixture/load.ts`
 * raises this at load time, before any process is spawned for the case —
 * the declaration cannot possibly be true, so it fails before any process
 * starts, never after one has already run. `message` proposes a workable
 * alternative (expecting `"error"`, or asserting
 * `stdoutContains`/`stderrContains` instead) rather than a bare rejection.
 */
export class FixtureUnblockableDecisionError extends HookassertError {
  /** Stable discriminator, unchanged across non-breaking releases. */
  readonly code = "ERR_FIXTURE_UNBLOCKABLE_DECISION" as const;

  /** Fixture unblockable-decision failures always exit 5 (load error). */
  readonly exitCode = 5;

  /** Absolute path of the fixture file the offending case was declared in. */
  readonly file: string;

  /** The event the offending case declares, which the loaded spec documents no deny channel for. */
  readonly event: EventName;

  /** The decision the offending case expects, which that event can never produce. */
  readonly decision: string;

  /**
   * @param file - Absolute path of the fixture file the case was declared in.
   * @param event - The event the case targets, which the spec documents no deny channel for.
   * @param decision - The decision the case expects.
   */
  constructor(file: string, event: EventName, decision: string) {
    super(
      `Fixture ${file} expects decision "${decision}" from event "${event}", ` +
        `but the loaded spec gives "${event}" no way to deny: it honors no ` +
        `blocking exit code and documents no deny-shaped value in its own ` +
        `jsonDecisions, so this case can never pass. ` +
        `Expect decision: "error" instead, or drop the "decision" expectation ` +
        `and assert "stdoutContains"/"stderrContains" against the hook's own output.`,
    );
    this.name = "FixtureUnblockableDecisionError";
    this.file = file;
    this.event = event;
    this.decision = decision;
  }
}
