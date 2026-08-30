/**
 * Thrown when a caller-supplied value cannot be used.
 *
 * @remarks
 * `code` and `field` are part of the published contract and are safe to branch
 * on. `message` is written for humans and may be reworded in a patch release,
 * so do not match on it.
 *
 * @public
 */
export class InvalidInputError extends Error {
  /** Stable discriminator, unchanged across non-breaking releases. */
  readonly code = "ERR_INVALID_INPUT" as const;

  /**
   * Dotted path of the rejected argument, for example `options.maxLength`.
   *
   * @remarks
   * Never contains the rejected value itself, so it is safe to log even when
   * the input was sensitive.
   */
  readonly field: string;

  /**
   * @param field - See {@link InvalidInputError.field}.
   * @param message - Human-readable explanation of the rejection.
   */
  constructor(field: string, message: string) {
    super(message);
    this.name = "InvalidInputError";
    this.field = field;
  }
}

/**
 * Thrown when an operation did not settle within its deadline.
 *
 * @remarks
 * The operation's `AbortSignal` is aborted with this same error instance as its
 * reason, so a cooperative operation can observe why it was cancelled.
 *
 * @public
 */
export class TimeoutError extends Error {
  /** Stable discriminator, unchanged across non-breaking releases. */
  readonly code = "ERR_TIMEOUT" as const;

  /** The deadline that was exceeded, in milliseconds. */
  readonly timeoutMs: number;

  /**
   * @param timeoutMs - See {@link TimeoutError.timeoutMs}.
   */
  constructor(timeoutMs: number) {
    super(`Operation timed out after ${String(timeoutMs)}ms.`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}
