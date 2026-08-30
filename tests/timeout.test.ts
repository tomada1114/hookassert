import { afterEach, describe, expect, it, vi } from "vitest";

import { InvalidInputError, TimeoutError, withTimeout } from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

/** A promise that never settles, so only the deadline can end the wait. */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

describe("withTimeout", () => {
  it("resolves with the operation result when it finishes in time", async () => {
    const result = await withTimeout(() => Promise.resolve("ok"), { timeoutMs: 1000 });
    expect(result).toBe("ok");
  });

  it("passes a live AbortSignal to the operation", async () => {
    const seen = await withTimeout((signal) => Promise.resolve(signal.aborted), {
      timeoutMs: 1000,
    });
    expect(seen).toBe(false);
  });

  it("propagates the operation's own rejection unchanged", async () => {
    const failure = new Error("boom");
    await expect(
      withTimeout(() => Promise.reject(failure), { timeoutMs: 1000 }),
    ).rejects.toBe(failure);
  });

  it("rejects with TimeoutError once the deadline passes", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(() => neverSettles<never>(), { timeoutMs: 50 });
    // eslint-disable-next-line vitest/valid-expect -- awaited below, after the fake clock has been advanced past the deadline
    const assertion = expect(pending).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it("reports the configured deadline and a stable code on timeout", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(() => neverSettles<never>(), { timeoutMs: 25 });
    const assertion = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25);
    const error = await assertion;
    expect(error).toBeInstanceOf(TimeoutError);
    const timeout = error as TimeoutError;
    expect(timeout.code).toBe("ERR_TIMEOUT");
    expect(timeout.name).toBe("TimeoutError");
    expect(timeout.timeoutMs).toBe(25);
  });

  it("aborts the operation's signal when the deadline passes", async () => {
    vi.useFakeTimers();
    let observed: unknown;
    const pending = withTimeout(
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            observed = signal.reason;
            reject(signal.reason as Error);
          });
        }),
      { timeoutMs: 10 },
    );
    const assertion = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(observed).toBeInstanceOf(TimeoutError);
  });

  it("rejects immediately when the caller's signal is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    controller.abort(reason);
    await expect(
      withTimeout(() => Promise.resolve("never"), {
        timeoutMs: 1000,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  it("does not invoke the operation when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const operation = vi.fn(() => Promise.resolve("never"));
    await expect(
      withTimeout(operation, { timeoutMs: 1000, signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(operation).not.toHaveBeenCalled();
  });

  it("forwards a later abort from the caller's signal", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled later");
    const pending = withTimeout(
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(signal.reason as Error);
          });
        }),
      { timeoutMs: 60_000, signal: controller.signal },
    );
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it("clears the deadline timer once the operation settles", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    await withTimeout(() => Promise.resolve("done"), { timeoutMs: 60_000 });
    expect(clearSpy).toHaveBeenCalled();
    // A leaked timer would keep the deadline pending after the call resolved.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes its abort listener from the caller's signal", async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    await withTimeout(() => Promise.resolve("done"), {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("converts a synchronously thrown operation into a rejection", async () => {
    const failure = new Error("threw before returning a promise");
    await expect(
      withTimeout(
        () => {
          throw failure;
        },
        { timeoutMs: 1000 },
      ),
    ).rejects.toBe(failure);
  });

  it("wraps a non-error rejection so callers always get an Error", async () => {
    const error: unknown = await withTimeout(
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- proves a non-Error rejection is normalized
      () => Promise.reject("plain string"),
      { timeoutMs: 1000 },
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).cause).toBe("plain string");
  });

  it("rejects a zero timeout", async () => {
    await expect(
      withTimeout(() => Promise.resolve("x"), { timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("rejects a fractional timeout", async () => {
    await expect(
      withTimeout(() => Promise.resolve("x"), { timeoutMs: 1.5 }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("names the timeoutMs option when it is invalid", async () => {
    const error: unknown = await withTimeout(() => Promise.resolve("x"), {
      timeoutMs: -1,
    }).catch((cause: unknown) => cause);
    expect((error as InvalidInputError).field).toBe("options.timeoutMs");
  });
});

describe("TimeoutError", () => {
  it("is an Error subclass carrying the deadline it exceeded", () => {
    const error = new TimeoutError(250);
    expect(error).toBeInstanceOf(Error);
    expect(error.timeoutMs).toBe(250);
    expect(error.message).toContain("250");
  });
});
