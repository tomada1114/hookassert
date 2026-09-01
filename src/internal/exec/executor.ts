/**
 * Turns an `ExecutionPlan` into real `ExecOutcome`s, faithfully reproducing
 * how Claude Code itself launches a hook.
 *
 * @remarks
 * Dynamic layer: the only code in this module that ever calls a `Spawner` is
 * {@link executeHooks}, and only for a step that carries no `stub` — a
 * `stub`-declared command's `ExecOutcome` is built directly from its
 * declared exit code and never reaches the injected `Spawner` at all. This is
 * both the mechanism `#11`'s `CountingSpawner` tests rely on and the seam
 * that keeps hookassert's own test runs from actually shelling out to a
 * command a fixture author deliberately chose not to run for real.
 *
 * Building an `ExecutionPlan` from a loaded `FixtureSet` end to end — running
 * the matcher, gating on consent, folding results into a CI exit code — is
 * the `test-cmd` issue's work. This module only supplies the primitive that
 * issue calls once a plan already exists: given a plan and the dependencies
 * to run it against, produce the outcomes.
 */

import type { EventName, ExecOutcome, ResolvedHook } from "../../types.js";
import type { FixtureStubEntry } from "../fixture/index.js";
import type { Spawner, SpawnRequest } from "./spawner.js";

/**
 * hookassert's own default hook timeout, in milliseconds.
 *
 * @remarks
 * Deliberately far shorter than Claude Code's own production default
 * (`spec.defaults.hookTimeoutMs`, 600000ms in the shipped spec): a hung hook
 * in a real session can legitimately run for ten minutes before Claude Code
 * gives up on it, but a hookassert test run should not wait that long to
 * report the same hang. {@link resolveDefaultTimeoutMs} is what turns this
 * constant and the spec's own default into the single effective default a
 * run actually uses.
 */
export const HOOKASSERT_DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The default cap on how many steps {@link executeHooks} spawns at once.
 *
 * @remarks
 * `test` runs the user's own hooks on the user's own machine; the concrete
 * failure this bounds is `Promise.all`-ing every step of a real
 * `ExecutionPlan` at once, which for a fixture set with many cases against a
 * settings tree with several hooks per event reaches a few hundred
 * simultaneous `detached` children, each holding three pipes — enough to hit
 * `EAGAIN`/`EMFILE` on the spawner itself (reported by `NodeSpawner` as
 * `exitCode: -1`, indistinguishable from a real hook failure) well before a
 * few hundred processes is unusual.
 *
 * `8` was chosen from two measurements taken on the machine this issue was
 * fixed on (`os.availableParallelism()` also reports `8` there), spawning
 * real child processes through `/bin/sh -c` and `node -e` at caps
 * `1/4/8/16/32/unbounded`:
 *
 * - **I/O-bound** (200 steps, each `sh -c "sleep 0.02"`): cap `1` took
 *   ~7044ms; cap `8` took ~939ms (a 7.5x speedup over serial); caps `16`/`32`
 *   kept improving but only to ~601ms/~569ms — real but sharply diminishing
 *   returns past `8`.
 * - **CPU-bound** (64 steps, each a fresh `node -e` doing real work): cap `8`
 *   was the fastest point measured (~1576ms); caps `16`/`32` were *slower*
 *   (~1826ms/~1791ms) than `8`, from context-switching more processes than
 *   the machine has cores for.
 *
 * `8` sits at the CPU-bound optimum and already captures the large majority
 * of the I/O-bound benefit, without the unbounded case's fd/process-table
 * exposure. It is a fixed constant rather than a dynamic
 * `os.availableParallelism()` read: hook processes are typically
 * I/O-bound rather than CPU-bound (per the CPU-bound measurement above,
 * `availableParallelism()` would actually be the *worse* choice for that
 * workload), and a fixed default keeps a run's behavior independent of the
 * machine it happens to run on. {@link ExecDeps.concurrency} overrides this
 * per run; wiring a `--concurrency` flag to it is a CLI-surface addition left
 * for a future change.
 */
export const HOOKASSERT_DEFAULT_CONCURRENCY = 8;

/**
 * The effective default timeout for a run: the shorter of hookassert's own
 * default and the loaded spec's `defaults.hookTimeoutMs`.
 *
 * @remarks
 * The production default is a ceiling, not a floor — this is never allowed
 * to be *longer* than hookassert's own default, only shorter, in case a
 * future spec ever ships a production default under 10 seconds.
 */
export function resolveDefaultTimeoutMs(
  hookassertDefaultTimeoutMs: number,
  specDefaultTimeoutMs: number,
): number {
  return Math.min(hookassertDefaultTimeoutMs, specDefaultTimeoutMs);
}

/**
 * Variable-name shapes that read as holding a credential.
 *
 * @remarks
 * Matched against the variable's *name*, never its value — hookassert never
 * reads `process.env` values it has not already decided to include. Each
 * pattern is a documented, testable rule rather than a single catch-all
 * regex, so a new pattern can be added and tested independently of the
 * others: a suffix shared by common secret-shaped names (`*_TOKEN`,
 * `*_SECRET`, `*_KEY`, `*_PASSWORD`, `*_CREDENTIAL(S)`), plus the `AWS_`
 * prefix every AWS SDK credential variable carries.
 */
const CREDENTIAL_ENV_NAME_PATTERNS: readonly RegExp[] = [
  /_TOKEN$/i,
  /_SECRET$/i,
  /_KEY$/i,
  /_PASSWORD$/i,
  /_CREDENTIALS?$/i,
  /^AWS_/i,
];

/** Whether `name` matches one of {@link CREDENTIAL_ENV_NAME_PATTERNS}. */
export function isCredentialShapedEnvKey(name: string): boolean {
  return CREDENTIAL_ENV_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Environment variables hookassert includes in every hook's environment by
 * default, on top of whatever `spec.hookEnv.provided` names.
 *
 * @remarks
 * `PATH` is not in the shipped spec's `hookEnv.provided` list — Claude Code
 * itself never has to declare it, because a real Claude Code session's shell
 * form (`/bin/sh -c`) inherits the outer process's own `PATH` regardless.
 * Reproducing that without ever declaring it would make hookassert's two
 * spawn forms disagree about the same command: exec form's process (spawned
 * with no shell) sees exactly the built env and ENOENTs on a bare command
 * name, while shell form's `/bin/sh` silently restores its own compiled-in
 * default `PATH` and still resolves it. So hookassert declares `PATH` itself,
 * as a named baseline constant rather than a `process.env` passthrough,
 * which this issue's acceptance criterion forbids — both forms then resolve
 * a bare command name identically instead of shell form depending on an
 * implicit, machine-dependent shell default that exec form never gets.
 */
export const HOOKASSERT_DEFAULT_ENV_KEYS: readonly string[] = ["PATH"];

/**
 * Build the environment a spawned hook actually runs with.
 *
 * @remarks
 * Never `process.env` passed through: every variable that ends up in the
 * result is either one of {@link HOOKASSERT_DEFAULT_ENV_KEYS} (hookassert's
 * own baseline), one of `providedKeys` (`spec.hookEnv.provided` — the
 * variables Claude Code itself gives every hook), or one of `allowedKeys`
 * (the explicit allowlist a caller opted a variable into, e.g. through the
 * `--env` flag `test-cmd` wires up). A credential-shaped name in
 * `providedKeys` is dropped as a defense-in-depth measure — the shipped spec
 * never actually names one there — while a credential-shaped name in
 * `allowedKeys` is still included: being named in the explicit allowlist *is*
 * "explicitly requested," which is the one condition the design allows a
 * credential-shaped variable through on.
 *
 * `CLAUDE_PROJECT_DIR` is synthesized from `projectRoot` rather than read
 * from `processEnv`: it is the one `hookEnv.provided` variable hookassert
 * itself knows the value of, since it names the very project root the run
 * resolved. That synthesized value always wins, even over an explicit
 * `allowedKeys` entry — a caller running hookassert itself from inside a
 * Claude Code session could otherwise pass the outer session's own
 * `CLAUDE_PROJECT_DIR` through `--env`, silently defeating the synthesis with
 * the wrong project root.
 */
export function buildHookEnv(
  processEnv: Readonly<Record<string, string | undefined>>,
  projectRoot: string,
  providedKeys: readonly string[],
  allowedKeys: readonly string[],
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};

  for (const key of [...HOOKASSERT_DEFAULT_ENV_KEYS, ...providedKeys]) {
    if (isCredentialShapedEnvKey(key)) {
      continue;
    }
    if (key === "CLAUDE_PROJECT_DIR") {
      env[key] = projectRoot;
      continue;
    }
    const value = processEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  for (const key of allowedKeys) {
    if (key === "CLAUDE_PROJECT_DIR") {
      // The synthesized value above always wins, regardless of the
      // allowlist — see the remark above.
      continue;
    }
    // Explicitly allowlisted, so included even when credential-shaped.
    const value = processEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}

/**
 * One hook invocation an {@link ExecutionPlan} asks {@link executeHooks} to
 * produce an `ExecOutcome` for.
 */
export interface ExecutionStep {
  /** The event this step's `hook` was resolved for. */
  readonly event: EventName;

  /** The hook to run, or to build a stubbed outcome for. */
  readonly hook: ResolvedHook;

  /** Text written to the process's stdin — normally the case's JSON payload. */
  readonly stdin: string;

  /**
   * Working directory override for this step, or `undefined` to use
   * {@link ExecDeps.projectRoot}.
   */
  readonly cwd: string | undefined;

  /**
   * When set, this step's `ExecOutcome` is built directly from
   * `stub.exitCode` and {@link ExecDeps.spawner} is never called for it —
   * `stub` bypasses the spawner entirely rather than being a call the
   * spawner itself short-circuits.
   */
  readonly stub: FixtureStubEntry | undefined;
}

/**
 * A batch of hook invocations for {@link executeHooks} to run.
 *
 * @remarks
 * `assertedEvents` is what keeps execution scoped to what a fixture run
 * actually asserts: a step whose `event` is not in this set is never spawned,
 * even when its `hook` is a real, resolved hook present in the project's
 * settings. Building `assertedEvents` from a loaded `FixtureSet` (the union
 * of every case's `event`) is `test-cmd`'s job; this type only consumes the
 * finished set.
 */
export interface ExecutionPlan {
  /** Every hook invocation this plan could run. */
  readonly steps: readonly ExecutionStep[];

  /** Events at least one fixture case in this run actually asserts on. */
  readonly assertedEvents: ReadonlySet<EventName>;
}

/** Dependencies {@link executeHooks} runs a plan against. */
export interface ExecDeps {
  /** The command-execution seam. Never called for a `stub`-declared step. */
  readonly spawner: Spawner;

  /** Default working directory for a step that declares no `cwd` override. */
  readonly projectRoot: string;

  /**
   * Source `buildHookEnv` reads allowlisted values from. Never forwarded to
   * a spawned process wholesale.
   */
  readonly processEnv: Readonly<Record<string, string | undefined>>;

  /** `spec.hookEnv.provided` — variables Claude Code itself gives every hook. */
  readonly providedEnvKeys: readonly string[];

  /** Variables explicitly opted into a spawned hook's environment. */
  readonly allowedEnvKeys: readonly string[];

  /** hookassert's own default timeout; see {@link HOOKASSERT_DEFAULT_TIMEOUT_MS}. */
  readonly hookassertDefaultTimeoutMs: number;

  /** The loaded spec's own `defaults.hookTimeoutMs`. */
  readonly specDefaultTimeoutMs: number;

  /**
   * A default timeout the caller declared explicitly (`test`'s own
   * `--timeout <ms>`), rather than one hookassert computed on its own.
   *
   * @remarks
   * When present, this is the default {@link buildSpawnRequest} uses for a
   * hook that declares no `timeoutMs` of its own — bypassing
   * {@link resolveDefaultTimeoutMs}'s ceiling against `specDefaultTimeoutMs`
   * entirely, the same exemption a hook's own declared `timeoutMs` already
   * gets (see `buildSpawnRequest`'s own remark). A value the user typed on
   * the command line is at least as explicit as one written into a hook's
   * `settings.json` entry: hookassert's ceiling exists to bound the case
   * where nobody said how long is acceptable, not to second-guess a duration
   * the user actually asked for. `undefined` when `--timeout` was not given,
   * in which case the computed default is still `min(hookassert's default,
   * spec.defaults.hookTimeoutMs)`, unchanged.
   */
  readonly explicitDefaultTimeoutMs?: number;

  /**
   * Maximum number of steps {@link executeHooks} runs at once. Omit to use
   * {@link HOOKASSERT_DEFAULT_CONCURRENCY}; see its remark for how that
   * default was chosen. A value below `1` is treated as `1` rather than
   * deadlocking a plan that has steps to run.
   */
  readonly concurrency?: number;
}

/**
 * Build the environment a plan's hooks all run with, computed once rather
 * than per step: `deps` never varies across steps, so neither does the
 * resulting environment.
 */
function envForDeps(deps: ExecDeps): Readonly<Record<string, string>> {
  return buildHookEnv(
    deps.processEnv,
    deps.projectRoot,
    deps.providedEnvKeys,
    deps.allowedEnvKeys,
  );
}

/**
 * Build the `SpawnRequest` for one non-stubbed step, reproducing Claude
 * Code's own faithful shell-form/exec-form split.
 *
 * @remarks
 * `hook.timeoutMs ?? defaultTimeoutMs` deliberately applies
 * {@link resolveDefaultTimeoutMs}'s ceiling only when the hook declares no
 * timeout of its own. A hook's explicitly declared `timeoutMs` (from
 * `settings.json`'s `timeout`, converted to milliseconds) is honored as-is,
 * even when it exceeds hookassert's own default — hookassert's default exists
 * to bound the case where nobody said how long is acceptable, not to
 * second-guess a value the user actually wrote down. This is not an
 * oversight: capping a hook's own declared timeout would make hookassert
 * silently run *less* faithfully to Claude Code's real behavior than an
 * uncapped one would.
 *
 * A hook declared with no `args` (`hook.args === undefined`) launches via
 * shell form (`sh -c "<command>"`, `NodeSpawner`'s job to actually invoke);
 * a hook declared with `args` — including an explicitly empty list — launches
 * via exec form, with no shell involved. This split is a correctness
 * requirement, not a style choice: see this issue's design notes for why it
 * must never be "improved" toward always using one form.
 */
function buildSpawnRequest(
  deps: ExecDeps,
  step: ExecutionStep,
  env: Readonly<Record<string, string>>,
): SpawnRequest {
  const { hook } = step;
  const form: SpawnRequest["form"] = hook.args === undefined ? "shell" : "exec";
  const defaultTimeoutMs =
    deps.explicitDefaultTimeoutMs ??
    resolveDefaultTimeoutMs(deps.hookassertDefaultTimeoutMs, deps.specDefaultTimeoutMs);

  return {
    form,
    command: hook.command,
    args: form === "exec" ? (hook.args ?? []) : [],
    cwd: step.cwd ?? deps.projectRoot,
    env,
    stdin: step.stdin,
    timeoutMs: hook.timeoutMs ?? defaultTimeoutMs,
  };
}

/** Build the `ExecOutcome` a stubbed step resolves to, without spawning anything. */
function stubbedOutcome(stub: FixtureStubEntry): ExecOutcome {
  return { exitCode: stub.exitCode, stdout: "", stderr: "", timedOut: false };
}

/** One executed step paired with the `ExecOutcome` it produced. */
export interface ExecutionResult {
  /** The step this outcome belongs to. */
  readonly step: ExecutionStep;

  /** What running (or stubbing) `step` produced. */
  readonly outcome: ExecOutcome;
}

async function runStep(
  deps: ExecDeps,
  step: ExecutionStep,
  env: Readonly<Record<string, string>>,
): Promise<ExecOutcome> {
  if (step.stub !== undefined) {
    return stubbedOutcome(step.stub);
  }
  return deps.spawner.spawn(buildSpawnRequest(deps, step, env));
}

/**
 * Run `fn` over every item of `items`, at most `limit` invocations in flight
 * at once, and return the results in `items`' own order.
 *
 * @remarks
 * A small worker pool rather than chunking `items` into `Math.ceil(items.length
 * / limit)` batches and `Promise.all`-ing each batch in turn: batching would
 * let one slow item stall every other item in its batch even while other
 * workers sit idle, whereas each worker here pulls the next item the instant
 * it finishes its current one. `items.entries()` — rather than an indexed
 * `items[i]` loop — is what lets multiple workers share one iterator safely:
 * each `for...of` step calls the shared iterator's `next()` synchronously, so
 * two workers can never race onto the same index, and `noUncheckedIndexedAccess`
 * never comes into play since nothing here indexes the array directly.
 * `results` is written through a local `(R | undefined)[]`, then asserted to
 * `R[]` only after every worker has returned — at that point every index in
 * `[0, items.length)` was visited exactly once by exactly one worker.
 */
async function runWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: (R | undefined)[] = new Array<R | undefined>(items.length);
  const iterator = items.entries();

  async function worker(): Promise<void> {
    for (const [index, item] of iterator) {
      results[index] = await fn(item);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results as R[];
}

/**
 * Run every step of `plan` whose event `plan.assertedEvents` actually
 * references, and report each one's `ExecOutcome` paired with the step it
 * belongs to.
 *
 * @remarks
 * A step for an event not in `plan.assertedEvents` is skipped before
 * anything about it is inspected further — not spawned, and not even
 * checked for a `stub` — so it contributes nothing to the returned array
 * rather than a placeholder entry. Order among the steps that do run follows
 * `plan.steps`'s own order.
 *
 * At most `deps.concurrency` (default {@link HOOKASSERT_DEFAULT_CONCURRENCY})
 * steps are ever in flight at once — see that constant's remark for why a
 * plan built from a real `FixtureSet` cannot be trusted to stay small enough
 * to `Promise.all` outright. The cap applies to every step this function
 * considers running, `stub`-declared or not: a stubbed step never reaches
 * `deps.spawner` regardless (see `runStep`), so it occupies a worker only for
 * the negligible time {@link stubbedOutcome} takes, never competing with a
 * real spawn for the resources the cap protects.
 *
 * Each result carries its own `step` rather than being returned as a bare
 * positional `ExecOutcome[]`: the array here is already filtered down from
 * `plan.steps`, so a caller that only sees `plan.steps` (never the filtered
 * list) cannot reliably index back from a returned outcome to the hook that
 * produced it without re-deriving the identical filter. `runWithConcurrencyLimit`
 * preserves `relevant`'s order in its result regardless of which worker
 * happened to finish which item first, so this pairing survives the cap the
 * same way it survived the previous unbounded `Promise.all`.
 */
export async function executeHooks(
  deps: ExecDeps,
  plan: ExecutionPlan,
): Promise<readonly ExecutionResult[]> {
  const env = envForDeps(deps);
  const relevant = plan.steps.filter((step) => plan.assertedEvents.has(step.event));
  const concurrency = deps.concurrency ?? HOOKASSERT_DEFAULT_CONCURRENCY;
  return runWithConcurrencyLimit(relevant, concurrency, async (step) => ({
    step,
    outcome: await runStep(deps, step, env),
  }));
}
