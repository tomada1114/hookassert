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
