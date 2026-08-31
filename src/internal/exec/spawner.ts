/**
 * The command-execution seam every hook eventually runs through, and its real
 * implementation.
 *
 * @remarks
 * `SpawnRequest`/`Spawner`/`createUnimplementedSpawner` were originally
 * declared directly under `src/internal/`, outside both `exec/` and
 * `record/`, so the composition root (`src/cli.ts`) and its tests could name
 * the interface before `#9` (this module) existed to implement it. Now that
 * `NodeSpawner` lives here too, the interface moved down alongside its real
 * implementation — `src/cli.ts` and `tests/cli.test.ts` are still the only
 * two importers outside this directory, and both are exempt from the
 * static/dynamic boundary (`src/cli.ts` is the composition root; test files
 * reach `src/internal/**` directly per the `writing-tests` skill's
 * documented exception), so the move does not cross a layer a static module
 * would be forbidden from crossing.
 *
 * `Spawner.spawn` returns `ExecOutcome` (`src/types.ts`) rather than a new
 * result type: that is already the shape the static decision resolver
 * consumes, so `NodeSpawner` and `resolveDecision` speak the same vocabulary
 * for a hook's raw result.
 */

import { spawn as spawnChildProcess } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import process from "node:process";

import type { ExecOutcome } from "../../types.js";

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
 * asserting `calls.length === 0`. `NodeSpawner`, below, is the first real
 * implementation; `executeHooks` (`executor.ts`) is what calls it for every
 * step of an `ExecutionPlan` that is not `stub`-declared.
 */
export interface Spawner {
  spawn(req: SpawnRequest): Promise<ExecOutcome>;
}

/**
 * A `Spawner` that rejects every call, for use where dependency injection
 * requires a value but nothing has implemented the seam yet.
 *
 * @remarks
 * `src/cli.ts` used to wire this in as its default `Spawner`, before `test`
 * had a composition of its own; the default is `NodeSpawner` now, and this
 * survives for a caller that wants a `Spawner`-shaped value it can prove is
 * never called — `tests/reporters.test.ts` injects it for exactly that.
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

/**
 * The `Spawner` that actually launches a hook process.
 *
 * @remarks
 * Reproduces Claude Code's own launch mechanism exactly, per
 * `req.form` — never "improved" toward always-exec or always-shell, which is
 * a correctness requirement, not a style choice (see the `executor` issue's
 * design notes):
 *
 * - `"shell"` — `/bin/sh -c "<req.command>"`. The whole command string is
 *   interpreted by the shell, metacharacters and all, exactly as Claude Code
 *   itself would hand it to `sh`. `/bin/sh` is spawned by its absolute path
 *   rather than looked up on `PATH`, since `req.env` deliberately does not
 *   forward `PATH` by default (see `executor.ts`'s environment allowlist) and
 *   a bare `"sh"` would otherwise fail to resolve.
 * - `"exec"` — `req.command` is spawned directly with `req.args`, with no
 *   shell in between: no interpolation, no metacharacter handling at all.
 *
 * A hook that outlives `req.timeoutMs` is killed with `SIGKILL` and reported
 * with `timedOut: true`; its exit code at that point carries no meaning
 * (`resolveDecision` never reads `exitCode` once `timedOut` is set), so `-1`
 * is used as a harmless placeholder rather than `null` coerced into a number
 * that could be mistaken for a real exit status.
 *
 * The timeout kills the whole process group, not only the direct child, and
 * settles the promise from the timer itself rather than waiting for
 * `"close"`: a shell-form command whose command string is anything but a
 * single simple word forks further children (`sh` only `exec`s in that one
 * case), and those grandchildren inherit the direct child's stdio pipes.
 * `"close"` fires only once every fd referencing those pipes is closed, so a
 * surviving grandchild — orphaned by a plain `child.kill()`, which signals
 * only the direct child — would otherwise hold `"close"`, and this promise,
 * pending far past `req.timeoutMs`. Spawning `detached: true` puts the direct
 * child in its own process group (`pgid === child.pid`), which every
 * unrelocated descendant inherits, so `process.kill(-pid, "SIGKILL")` reaches
 * the whole tree at once.
 */
export class NodeSpawner implements Spawner {
  spawn(req: SpawnRequest): Promise<ExecOutcome> {
    return new Promise((resolve) => {
      const [command, args] =
        req.form === "shell"
          ? (["/bin/sh", ["-c", req.command]] as const)
          : ([req.command, [...req.args]] as const);

      const child = spawnChildProcess(command, args, {
        cwd: req.cwd,
        env: req.env,
        detached: true,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const settle = (outcome: ExecOutcome): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killProcessGroup(child);
        settle({ exitCode: -1, stdout, stderr, timedOut: true });
      }, req.timeoutMs);

      // `setEncoding` decodes the stream itself rather than each chunk
      // independently: `Buffer#toString("utf8")` per chunk mangles a
      // multi-byte character split across a chunk boundary into U+FFFD,
      // while the stream's own decoder carries a split sequence's leftover
      // bytes over to the next chunk.
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      // A process killed for a timeout, or one that never starts at all
      // (`ENOENT` on the command itself), reports through "error"/"close"
      // rather than throwing: `Spawner.spawn` promises to always resolve
      // with an `ExecOutcome`, never to reject.
      child.on("error", (error) => {
        settle({
          exitCode: -1,
          stdout,
          stderr: stderr + (stderr.length > 0 ? "\n" : "") + error.message,
          timedOut,
        });
      });
      child.on("close", (code) => {
        settle({ exitCode: code ?? -1, stdout, stderr, timedOut });
      });

      // A hook that exits before consuming its full stdin would otherwise
      // turn this write into an unhandled EPIPE.
      child.stdin.on("error", () => {
        // Deliberately empty: the process's actual outcome comes from
        // "close"/"error" above, not from whether the write succeeded.
      });
      child.stdin.end(req.stdin);
    });
  }
}

/**
 * Kill `child`'s entire process group rather than only `child` itself.
 *
 * @remarks
 * See the timeout remark on {@link NodeSpawner.spawn}. `process.kill` with a
 * negated pid signals every process sharing that pgid; falls back to
 * `child.kill()` when `child.pid` never got assigned (the process failed to
 * start at all) or the group is already gone (e.g. `ESRCH` because the child
 * had already exited on its own between the timer firing and this call).
 */
function killProcessGroup(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
