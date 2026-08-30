import { TimeoutError } from "./errors.js";
import { asError, assertPositiveInteger } from "./internal/assert.js";

/**
 * Options for {@link withTimeout}.
 *
 * @public
 */
export interface WithTimeoutOptions {
  /**
   * Deadline in milliseconds. Must be a whole number greater than 0.
   *
   * @remarks
   * There is no default: an operation worth guarding is worth giving an
   * explicit budget.
   */
  readonly timeoutMs: number;

  /**
   * Caller-controlled signal that cancels the operation early.
   *
   * @remarks
   * An abort on this signal is forwarded to the operation with the caller's
   * original reason preserved.
   */
  readonly signal?: AbortSignal;
}

/**
 * Run an abortable operation under a deadline.
 *
 * @remarks
 * The operation receives an `AbortSignal` and is expected to cooperate: this
 * function cannot stop work that ignores its signal, it only stops *waiting*
 * for it. When the deadline passes, the signal is aborted with the same
 * {@link TimeoutError} the returned promise rejects with.
 *
 * The deadline timer is always cleared and the listener on `options.signal` is
 * always removed, on every exit path, so a long-lived caller signal does not
 * accumulate listeners.
 *
 * Uses only `AbortController` and `setTimeout`, so it behaves identically on
 * Node and in a browser.
 *
 * @param operation - Receives the signal to honor; must return a promise.
 * @param options - See {@link WithTimeoutOptions}.
 * @returns Whatever `operation` resolves with.
 * @throws TimeoutError when the deadline passes first.
 * @throws InvalidInputError when `options.timeoutMs` is out of range.
 *
 * @example
 * ```ts
 * const response = await withTimeout((signal) => fetch(url, { signal }), {
 *   timeoutMs: 5_000,
 * });
 * ```
 *
 * @public
 */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: WithTimeoutOptions,
): Promise<T> {
  assertPositiveInteger(options.timeoutMs, "options.timeoutMs");

  const external = options.signal;
  if (external?.aborted === true) {
    // Nothing to clean up yet, and running the operation would be wasted work.
    throw asError(external.reason, "The operation was aborted before it started.");
  }

  const controller = new AbortController();
  const forwardAbort = (): void => {
    controller.abort(
      asError(external?.reason, "The operation was aborted by its caller."),
    );
  };
  external?.addEventListener("abort", forwardAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        const timeout = new TimeoutError(options.timeoutMs);
        controller.abort(timeout);
        reject(timeout);
      }, options.timeoutMs);

      controller.signal.addEventListener(
        "abort",
        () => {
          reject(asError(controller.signal.reason, "The operation was aborted."));
        },
        { once: true },
      );

      try {
        void operation(controller.signal).then(resolve, (error: unknown) => {
          reject(asError(error, "The operation rejected with a non-error value."));
        });
      } catch (error) {
        // A synchronously throwing operation must not escape the executor as an
        // unhandled exception.
        reject(asError(error, "The operation threw a non-error value."));
      }
    });
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    external?.removeEventListener("abort", forwardAbort);
  }
}
