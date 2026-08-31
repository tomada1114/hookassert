/**
 * The seam `test`'s real Claude Code version detection implements, and its
 * real implementation.
 *
 * @remarks
 * `VersionProbe` was originally declared here, as a type only, because
 * {@link UnknownReason}'s `"version-undetermined"` member (`src/types.ts`)
 * already needed a closed `VersionSourceName` vocabulary to report which
 * sources a probe tried, and the `executor` issue's design section named this
 * interface explicitly. `NodeVersionProbe`'s body — spawning `claude
 * --version` through the same {@link Spawner} seam every hook invocation
 * runs through — is this issue's own work: reusing `Spawner` rather than
 * shelling out independently is what lets `tests/cli.test.ts`'s and
 * `tests/test-cmd.test.ts`'s `CountingSpawner` observe (or assert the
 * absence of) this one real, intentional spawn the same way they already
 * observe every hook invocation. `src/cli.ts`'s `runTest` is the only code
 * that ever constructs one — `explain` and `lint` must stay at zero spawns,
 * so neither may import this class, only the `VersionProbe` type.
 *
 * "Last recorded session's version" — the step between this probe and
 * `"undetermined"` in the resolution order — reads whatever `record`'s own
 * session bookkeeping (`#15`, not yet shipped) most recently wrote. Until
 * that lands, there is nothing to read, so `src/cli.ts` simply falls through
 * to `"undetermined"` after this probe reports nothing; no placeholder
 * session-file format is invented here to fill that gap early.
 */

import { parseClaudeVersion } from "../spec/index.js";
import type { ClaudeVersion } from "../spec/index.js";
import type { Spawner } from "./spawner.js";

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

/** Matches the first `major.minor.patch` substring in `claude --version`'s output. */
const VERSION_IN_OUTPUT = /(\d+\.\d+\.\d+)/;

/** How long `NodeVersionProbe` waits for `claude --version` before giving up. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * The real {@link VersionProbe}: spawns `claude --version` and parses its
 * output for a `major.minor.patch` version.
 *
 * @remarks
 * Runs through the injected {@link Spawner} rather than `node:child_process`
 * directly, so the exact same seam that makes hook execution injectable and
 * countable in tests also covers this probe — see this module's own doc
 * comment. A non-zero exit, a spawn failure (`claude` not on `PATH`), a
 * timeout, or output with no parseable version all resolve to `undefined`
 * rather than throwing: a probe that cannot determine a version is an
 * ordinary, expected outcome (feeding version resolution's own fallback to
 * `"undetermined"`), not a failure of the run itself.
 *
 * `cwd` and the `PATH` value both come from the composition root's own
 * `CliDeps`, never from `process` directly: a programmatic `runCli(argv, exe,
 * { cwd, env })` caller has already said which directory and which
 * environment this run speaks for, and reading the ambient process instead
 * would probe a different machine state than the one every other stage of the
 * run uses.
 */
export class NodeVersionProbe implements VersionProbe {
  readonly #spawner: Spawner;
  readonly #cwd: string;
  readonly #env: Readonly<Record<string, string | undefined>>;

  constructor(
    spawner: Spawner,
    cwd: string,
    env: Readonly<Record<string, string | undefined>>,
  ) {
    this.#spawner = spawner;
    this.#cwd = cwd;
    this.#env = env;
  }

  async detect(): Promise<ClaudeVersion | undefined> {
    let outcome;
    try {
      outcome = await this.#spawner.spawn({
        form: "exec",
        command: "claude",
        args: ["--version"],
        cwd: this.#cwd,
        // No allowlisted variables beyond PATH: this probe only needs to
        // resolve `claude` itself, never a hook's own configured environment.
        env: { PATH: this.#env["PATH"] ?? "" },
        stdin: "",
        timeoutMs: PROBE_TIMEOUT_MS,
      });
    } catch {
      return undefined;
    }

    if (outcome.timedOut || outcome.exitCode !== 0) {
      return undefined;
    }

    const match = VERSION_IN_OUTPUT.exec(outcome.stdout);
    if (match?.[1] === undefined) {
      return undefined;
    }

    try {
      // `VERSION_IN_OUTPUT`'s own capture group already guarantees the
      // `\d+\.\d+\.\d+` shape `parseClaudeVersion` requires, so this never
      // actually throws in practice; the `try`/`catch` is defense in depth
      // against a future change to either pattern drifting out of sync.
      return parseClaudeVersion(match[1]);
    } catch {
      return undefined;
    }
  }
}
