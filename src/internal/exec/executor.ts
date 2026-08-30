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
  const defaultTimeoutMs = resolveDefaultTimeoutMs(
    deps.hookassertDefaultTimeoutMs,
    deps.specDefaultTimeoutMs,
  );

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
 * Run every step of `plan` whose event `plan.assertedEvents` actually
 * references, and report each one's `ExecOutcome` paired with the step it
 * belongs to.
 *
 * @remarks
 * A step for an event not in `plan.assertedEvents` is skipped before
 * anything about it is inspected further — not spawned, and not even
 * checked for a `stub` — so it contributes nothing to the returned array
 * rather than a placeholder entry. Order among the steps that do run follows
 * `plan.steps`'s own order, but all of them run concurrently
 * (`Promise.all`): nothing about one step's outcome depends on another's.
 *
 * Each result carries its own `step` rather than being returned as a bare
 * positional `ExecOutcome[]`: the array here is already filtered down from
 * `plan.steps`, so a caller that only sees `plan.steps` (never the filtered
 * list) cannot reliably index back from a returned outcome to the hook that
 * produced it without re-deriving the identical filter.
 */
export async function executeHooks(
  deps: ExecDeps,
  plan: ExecutionPlan,
): Promise<readonly ExecutionResult[]> {
  const env = envForDeps(deps);
  const relevant = plan.steps.filter((step) => plan.assertedEvents.has(step.event));
  return Promise.all(
    relevant.map(async (step) => ({ step, outcome: await runStep(deps, step, env) })),
  );
}
