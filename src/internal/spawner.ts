/**
 * The command-execution seam every hook eventually runs through.
 *
 * @remarks
 * Declared here — a plain module directly under `src/internal/`, outside both
 * `exec/` and `record/`, the package's dynamic layer — so the composition root
 * (`src/cli.ts`) and its tests can name the interface without importing an
 * implementation that actually spawns a process. `Spawner.spawn` returns
 * `ExecOutcome` (`src/types.ts`) rather than a new result type: that is
 * already the shape the static decision resolver consumes, so whatever
 * eventually implements this interface (the `executor` issue's `NodeSpawner`,
 * under `src/internal/exec/`) and the decision resolver speak the same
 * vocabulary for a hook's raw result.
 */

import type { ExecOutcome } from "../types.js";

/** One hook invocation, described the way a {@link Spawner} executes it. */
export interface SpawnRequest {
  /** Whether the command runs through a shell or is exec'd directly. */
  readonly form: "shell" | "exec";

  /** The command to run. */
  readonly command: string;

  /** Arguments passed to {@link SpawnRequest.command}. */
  readonly args: readonly string[];

  /** Working directory the process runs in. */
  readonly cwd: string;

  /** Environment variables the process runs with. */
  readonly env: Readonly<Record<string, string>>;

  /** Text written to the process's stdin. */
  readonly stdin: string;

  /** Deadline in milliseconds before the process is killed. */
  readonly timeoutMs: number;
}

/**
 * Runs one hook invocation and reports its outcome.
 *
 * @remarks
 * The seam that keeps `explain` and `lint` static: both accept a `Spawner`
 * through explicit dependency injection and never call it, which is what
 * `tests/cli.test.ts`'s `CountingSpawner` proves by injecting itself and
 * asserting `calls.length === 0`. A real implementation is a later issue's
 * work; see {@link createUnimplementedSpawner} for the placeholder this
 * package wires in until one exists.
 */
export interface Spawner {
  spawn(req: SpawnRequest): Promise<ExecOutcome>;
}

/**
 * A `Spawner` that rejects every call, for use where dependency injection
 * requires a value but nothing has implemented the seam yet.
 *
 * @remarks
 * `src/cli.ts` wires this in as its default `Spawner` so `main()` has a
 * complete dependency graph to run against before `#11`'s `NodeSpawner`
 * lands. Never reached by `explain` or `lint`, which never call `spawn` at
 * all.
 */
export function createUnimplementedSpawner(): Spawner {
  return {
    spawn(): Promise<ExecOutcome> {
      return Promise.reject(
        new Error(
          "spawning is not implemented yet: no Spawner has landed under src/internal/exec/",
        ),
      );
    },
  };
}
