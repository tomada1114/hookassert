import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildHookEnv,
  executeHooks,
  HOOKASSERT_DEFAULT_CONCURRENCY,
  HOOKASSERT_DEFAULT_TIMEOUT_MS,
  isCredentialShapedEnvKey,
  NodeSpawner,
  resolveDefaultTimeoutMs,
} from "../src/internal/exec/index.js";
import type {
  ExecDeps,
  ExecutionPlan,
  ExecutionStep,
} from "../src/internal/exec/index.js";
import type { Spawner, SpawnRequest } from "../src/internal/exec/index.js";
import type { FixtureStubEntry } from "../src/internal/fixture/index.js";
import { resolveDecision } from "../src/internal/decision/index.js";
import { loadSpecFile } from "../src/internal/spec/index.js";
import type { EventName, ExecOutcome, Provenance, ResolvedHook } from "../src/types.js";

// Reaching src/internal/exec/, src/internal/fixture/, src/internal/decision/
// and src/internal/spec/ directly (rather than through src/index.ts's
// exports, per the writing-tests skill) is a deliberate, narrowly scoped
// exception: the executor has no public surface in this issue and won't have
// one until a later test-cmd issue's composition root wires it in — see
// eslint.config.mjs's "tests/static-layer-unit-tests" block for the full
// reasoning.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REAL_SPEC_PATH = path.join(REPO_ROOT, "spec", "claude-code-2.1.251-2.2.0.json");
const REAL_SPEC = loadSpecFile(REAL_SPEC_PATH);
const HOOKS_DIR = fileURLToPath(new URL("./fixtures/hooks/", import.meta.url));

/** Records every call rather than performing one, so a test can assert on `calls`. */
class CountingSpawner implements Spawner {
  readonly calls: SpawnRequest[] = [];
  readonly #outcome: ExecOutcome;

  constructor(
    outcome: ExecOutcome = { exitCode: 0, stdout: "", stderr: "", timedOut: false },
  ) {
    this.#outcome = outcome;
  }

  spawn(req: SpawnRequest): Promise<ExecOutcome> {
    this.calls.push(req);
    return Promise.resolve(this.#outcome);
  }
}

let nextOffset = 0;

function makeHook(overrides: Partial<ResolvedHook> = {}): ResolvedHook {
  const provenance: Provenance = {
    file: "/fake/settings.json",
    layer: "project",
    line: 1,
    col: 1,
    offset: nextOffset++,
  };
  const event = overrides.event ?? "PreToolUse";
  const command = overrides.command ?? "./hook.sh";
  return {
    event,
    matcher: overrides.matcher,
    command,
    args: overrides.args,
    timeoutMs: overrides.timeoutMs,
    provenance: overrides.provenance ?? provenance,
    dedupeKey: overrides.dedupeKey ?? JSON.stringify([event, command, nextOffset]),
  };
}

function makeStep(
  hook: ResolvedHook,
  overrides: Partial<Omit<ExecutionStep, "hook">> = {},
): ExecutionStep {
  return {
    event: overrides.event ?? hook.event,
    hook,
    stdin: overrides.stdin ?? "",
    cwd: overrides.cwd,
    stub: overrides.stub,
  };
}

function makePlan(
  steps: readonly ExecutionStep[],
  assertedEvents?: ReadonlySet<EventName>,
): ExecutionPlan {
  return {
    steps,
    assertedEvents: assertedEvents ?? new Set(steps.map((step) => step.event)),
  };
}

function makeDeps(overrides: Partial<ExecDeps> = {}): ExecDeps {
  return {
    spawner: overrides.spawner ?? new CountingSpawner(),
    // A real, existing directory: NodeSpawner's tests actually spawn a
    // process against this cwd, and child_process.spawn reports a
    // nonexistent cwd as a misleading "spawn <command> ENOENT" on the
    // command itself rather than on the cwd.
    projectRoot: overrides.projectRoot ?? REPO_ROOT,
    processEnv: overrides.processEnv ?? {},
    providedEnvKeys: overrides.providedEnvKeys ?? [],
    allowedEnvKeys: overrides.allowedEnvKeys ?? [],
    hookassertDefaultTimeoutMs:
      overrides.hookassertDefaultTimeoutMs ?? HOOKASSERT_DEFAULT_TIMEOUT_MS,
    specDefaultTimeoutMs:
      overrides.specDefaultTimeoutMs ?? REAL_SPEC.defaults.hookTimeoutMs,
    ...(overrides.explicitDefaultTimeoutMs === undefined
      ? {}
      : { explicitDefaultTimeoutMs: overrides.explicitDefaultTimeoutMs }),
    ...(overrides.concurrency === undefined
      ? {}
      : { concurrency: overrides.concurrency }),
  };
}

/** Single-quotes `value` for embedding literally in a `sh -c` command string. */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

describe("faithful spawn forms", () => {
  it("a hook with no args launches via shell form (sh -c)", async () => {
    const spawner = new CountingSpawner();
    const hook = makeHook({ command: "echo hi", args: undefined });
    const deps = makeDeps({ spawner });
    await executeHooks(deps, makePlan([makeStep(hook)]));

    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0]?.form).toBe("shell");
    expect(spawner.calls[0]?.command).toBe("echo hi");
    expect(spawner.calls[0]?.args).toEqual([]);
  });

  it("a hook with args launches via exec form without a shell", async () => {
    const spawner = new CountingSpawner();
    const hook = makeHook({ command: "/usr/bin/env", args: ["node", "-e", "1"] });
    const deps = makeDeps({ spawner });
    await executeHooks(deps, makePlan([makeStep(hook)]));

    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0]?.form).toBe("exec");
    expect(spawner.calls[0]?.command).toBe("/usr/bin/env");
    expect(spawner.calls[0]?.args).toEqual(["node", "-e", "1"]);
  });

  it("an empty args array (declared, not omitted) still launches via exec form", async () => {
    const spawner = new CountingSpawner();
    const hook = makeHook({ command: "/usr/bin/env", args: [] });
    const deps = makeDeps({ spawner });
    await executeHooks(deps, makePlan([makeStep(hook)]));

    expect(spawner.calls[0]?.form).toBe("exec");
  });

  it("shell form interpolates a $VAR the real way; exec form passes it through literally", async () => {
    const scriptPath = path.join(HOOKS_DIR, "print-argv.mjs");
    const deps = makeDeps({
      spawner: new NodeSpawner(),
      allowedEnvKeys: ["HOOKASSERT_TEST_VAR"],
      processEnv: { HOOKASSERT_TEST_VAR: "expanded-value" },
    });

    const shellHook = makeHook({
      command: `${shQuote(process.execPath)} ${shQuote(scriptPath)} $HOOKASSERT_TEST_VAR`,
      args: undefined,
    });
    const [shellResult] = await executeHooks(deps, makePlan([makeStep(shellHook)]));
    expect(shellResult).toBeDefined();
    expect(JSON.parse(shellResult?.outcome.stdout ?? "[]")).toEqual(["expanded-value"]);

    const execHook = makeHook({
      command: process.execPath,
      args: [scriptPath, "$HOOKASSERT_TEST_VAR"],
    });
    const [execResult] = await executeHooks(deps, makePlan([makeStep(execHook)]));
    expect(execResult).toBeDefined();
    expect(JSON.parse(execResult?.outcome.stdout ?? "[]")).toEqual([
      "$HOOKASSERT_TEST_VAR",
    ]);
  });
});

describe("environment allowlist", () => {
  it("isCredentialShapedEnvKey", () => {
    for (const name of [
      "AWS_SECRET_ACCESS_KEY",
      "AWS_ACCESS_KEY_ID",
      "GITHUB_TOKEN",
      "DB_PASSWORD",
      "STRIPE_SECRET",
      "API_KEY",
      "GOOGLE_CREDENTIALS",
      "SERVICE_CREDENTIAL",
    ]) {
      expect(isCredentialShapedEnvKey(name)).toBe(true);
    }
    for (const name of ["PATH", "NODE_ENV", "CLAUDE_PROJECT_DIR", "HOME", "LANG"]) {
      expect(isCredentialShapedEnvKey(name)).toBe(false);
    }
  });

  it("env passed to the spawned process is built from the allowlist, not process.env", async () => {
    const spawner = new CountingSpawner();
    const hook = makeHook({ command: "echo hi", args: undefined });
    const deps = makeDeps({
      spawner,
      processEnv: { FOO: "bar", UNRELATED_NOISE: "should-never-appear" },
      allowedEnvKeys: ["FOO"],
    });
    await executeHooks(deps, makePlan([makeStep(hook)]));

    expect(spawner.calls[0]?.env).toEqual({ FOO: "bar" });
    expect(spawner.calls[0]?.env).not.toBe(deps.processEnv);
  });

  it("spec.hookEnv.provided variables are included by default, with CLAUDE_PROJECT_DIR synthesized", async () => {
    const spawner = new CountingSpawner();
    const hook = makeHook({ command: "echo hi", args: undefined });
    const deps = makeDeps({
      spawner,
      projectRoot: "/resolved/project/root",
      providedEnvKeys: REAL_SPEC.hookEnv.provided,
    });
    await executeHooks(deps, makePlan([makeStep(hook)]));

    expect(spawner.calls[0]?.env).toEqual({
      CLAUDE_PROJECT_DIR: "/resolved/project/root",
    });
  });

  it("a credential-shaped variable name is excluded from env unless explicitly requested", () => {
    const processEnv = { AWS_SECRET_ACCESS_KEY: "leaked-if-present" };

    const withoutRequest = buildHookEnv(processEnv, "/root", [], []);
    expect(withoutRequest).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");

    const withRequest = buildHookEnv(
      processEnv,
      "/root",
      [],
      ["AWS_SECRET_ACCESS_KEY"],
    );
    expect(withRequest).toEqual({ AWS_SECRET_ACCESS_KEY: "leaked-if-present" });
  });

  it("a credential-shaped name in providedKeys alone (not allowlisted) is dropped", () => {
    const processEnv = { AWS_SECRET_ACCESS_KEY: "leaked-if-present" };
    const env = buildHookEnv(processEnv, "/root", ["AWS_SECRET_ACCESS_KEY"], []);
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });

  it("a credential-shaped name present in both providedKeys and allowedKeys is included: explicit allowlisting wins over credential-shape filtering", () => {
    const processEnv = { AWS_SECRET_ACCESS_KEY: "leaked-if-present" };
    const env = buildHookEnv(
      processEnv,
      "/root",
      ["AWS_SECRET_ACCESS_KEY"],
      ["AWS_SECRET_ACCESS_KEY"],
    );
    expect(env).toEqual({ AWS_SECRET_ACCESS_KEY: "leaked-if-present" });
  });

  it("PATH is included in the built env by default, so exec form and shell form resolve the same bare command name identically", async () => {
    const deps = makeDeps({
      spawner: new NodeSpawner(),
      processEnv: { PATH: process.env["PATH"] ?? "" },
    });

    const shellHook = makeHook({ command: "true", args: undefined });
    const [shellResult] = await executeHooks(deps, makePlan([makeStep(shellHook)]));

    const execHook = makeHook({ command: "true", args: [] });
    const [execResult] = await executeHooks(deps, makePlan([makeStep(execHook)]));

    expect(shellResult?.outcome.exitCode).toBe(0);
    expect(execResult?.outcome.exitCode).toBe(0);
  });

  it("an allowlisted CLAUDE_PROJECT_DIR does not override the synthesized value", () => {
    const env = buildHookEnv(
      { CLAUDE_PROJECT_DIR: "/outer/session/root" },
      "/resolved/project/root",
      REAL_SPEC.hookEnv.provided,
      ["CLAUDE_PROJECT_DIR"],
    );
    expect(env["CLAUDE_PROJECT_DIR"]).toBe("/resolved/project/root");
  });
});

describe("cwd", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    tempDirs.push(dir);
    return realpathSync(dir);
  }

  it("cwd defaults to the resolved project root and is overridable per case", async () => {
    const projectRoot = makeTempDir("hookassert-executor-project-");
    const overrideDir = makeTempDir("hookassert-executor-override-");
    const scriptPath = path.join(HOOKS_DIR, "print-cwd.mjs");

    const deps = makeDeps({
      spawner: new NodeSpawner(),
      projectRoot,
    });
    const hook = makeHook({ command: process.execPath, args: [scriptPath] });

    const [defaultResult] = await executeHooks(deps, makePlan([makeStep(hook)]));
    expect(defaultResult?.outcome.stdout).toBe(projectRoot);

    const [overriddenResult] = await executeHooks(
      deps,
      makePlan([makeStep(hook, { cwd: overrideDir })]),
    );
    expect(overriddenResult?.outcome.stdout).toBe(overrideDir);
  });
});

describe("timeout", () => {
  it("the effective default timeout is min(hookassert's default, spec.defaults.hookTimeoutMs)", () => {
    expect(resolveDefaultTimeoutMs(10_000, 600_000)).toBe(10_000);
    expect(resolveDefaultTimeoutMs(600_000, 100)).toBe(100);
    expect(resolveDefaultTimeoutMs(5, 5)).toBe(5);
  });

  it("real spec: hookassert's own default wins because it is the shorter one", () => {
    expect(
      resolveDefaultTimeoutMs(
        HOOKASSERT_DEFAULT_TIMEOUT_MS,
        REAL_SPEC.defaults.hookTimeoutMs,
      ),
    ).toBe(HOOKASSERT_DEFAULT_TIMEOUT_MS);
  });

  it("a step whose hook declares no timeoutMs uses the effective default", async () => {
    const spawner = new CountingSpawner();
    const hook = makeHook({
      command: "echo hi",
      args: undefined,
      timeoutMs: undefined,
    });
    const deps = makeDeps({
      spawner,
      hookassertDefaultTimeoutMs: 10_000,
      specDefaultTimeoutMs: 600_000,
    });
    await executeHooks(deps, makePlan([makeStep(hook)]));
    expect(spawner.calls[0]?.timeoutMs).toBe(10_000);
  });

  it("explicitDefaultTimeoutMs overrides the computed default and is not clamped by specDefaultTimeoutMs", async () => {
    const spawner = new CountingSpawner();
    const hook = makeHook({
      command: "echo hi",
      args: undefined,
      timeoutMs: undefined,
    });
    const deps = makeDeps({
      spawner,
      hookassertDefaultTimeoutMs: HOOKASSERT_DEFAULT_TIMEOUT_MS,
      specDefaultTimeoutMs: 600_000,
      explicitDefaultTimeoutMs: 900_000,
    });
    await executeHooks(deps, makePlan([makeStep(hook)]));
    // Above both HOOKASSERT_DEFAULT_TIMEOUT_MS and specDefaultTimeoutMs:
    // resolveDefaultTimeoutMs's Math.min would have clamped it to 600_000,
    // which is exactly what an explicit override must not be subject to.
    expect(spawner.calls[0]?.timeoutMs).toBe(900_000);
  });

  it("a hook's own declared timeoutMs overrides the effective default", async () => {
    const spawner = new CountingSpawner();
    const hook = makeHook({ command: "echo hi", args: undefined, timeoutMs: 42 });
    const deps = makeDeps({ spawner });
    await executeHooks(deps, makePlan([makeStep(hook)]));
    expect(spawner.calls[0]?.timeoutMs).toBe(42);
  });

  it("a hook that outlives its timeout produces ExecOutcome.timedOut === true", async () => {
    const scriptPath = path.join(HOOKS_DIR, "sleep-past-timeout.mjs");
    // Self-terminates at 3000ms regardless, so a bug in the kill logic cannot
    // leave an orphaned process running past this test's own lifetime.
    const hook = makeHook({
      command: process.execPath,
      args: [scriptPath, "3000"],
      timeoutMs: 150,
    });
    const deps = makeDeps({ spawner: new NodeSpawner() });
    const [result] = await executeHooks(deps, makePlan([makeStep(hook)]));

    expect(result?.outcome.timedOut).toBe(true);
  });

  it("a shell-form command whose grandchild survives the direct child's kill still settles well under the sleep duration, and leaves no orphan behind", async () => {
    // The sleep duration itself doubles as a unique marker: pgrep -f can
    // then confirm afterward that no process still matches this exact
    // command line, i.e. the whole process group was actually killed rather
    // than only the direct `sh` child.
    const marker = (5 + Math.random()).toFixed(4);
    const hook = makeHook({
      command: `echo start; sleep ${marker}`,
      args: undefined,
      timeoutMs: 200,
    });
    const deps = makeDeps({ spawner: new NodeSpawner() });

    const startedAt = Date.now();
    const [result] = await executeHooks(deps, makePlan([makeStep(hook)]));
    const elapsedMs = Date.now() - startedAt;

    expect(result?.outcome.timedOut).toBe(true);
    // Comfortably under the 5+ second sleep, with headroom for process
    // teardown; a spawner that only waits for "close" resolves near 5000ms.
    expect(elapsedMs).toBeLessThan(2000);

    // Give the OS a moment to finish reaping the killed processes before
    // checking that none of them survived as an orphan.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stillRunning = spawnSync("pgrep", ["-f", `sleep ${marker}`]);
    expect(stillRunning.status).not.toBe(0);
  });
});

describe("stub bypass", () => {
  it("a stubbed command never reaches the Spawner — its ExecOutcome comes from the declared stub value", async () => {
    const spawner = new CountingSpawner();
    const realHook = makeHook({ command: "real-command" });
    const stubbedHook = makeHook({ command: "stubbed-command" });
    const stub: FixtureStubEntry = { exitCode: 7 };
    const deps = makeDeps({ spawner });

    const outcomes = await executeHooks(
      deps,
      makePlan([makeStep(realHook), makeStep(stubbedHook, { stub })]),
    );

    expect(outcomes).toHaveLength(2);
    expect(outcomes[1]?.outcome).toEqual({
      exitCode: 7,
      stdout: "",
      stderr: "",
      timedOut: false,
    });
    // The regression this test guards: the stubbed command's own name must
    // never show up among what was actually spawned.
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls.every((call) => call.command !== "stubbed-command")).toBe(
      true,
    );
  });
});

describe("concurrency cap", () => {
  /**
   * A `Spawner` whose calls stay pending until manually released, and which
   * records the maximum number of calls in flight at once — the fact this
   * describe block relies on to prove `executeHooks`' cap actually holds
   * during the run, not only trusting the implementation to enforce it.
   */
  class GatedSpawner implements Spawner {
    readonly calls: SpawnRequest[] = [];
    readonly #pending: (() => void)[] = [];
    #current = 0;
    maxObserved = 0;

    spawn(req: SpawnRequest): Promise<ExecOutcome> {
      this.calls.push(req);
      this.#current += 1;
      this.maxObserved = Math.max(this.maxObserved, this.#current);
      return new Promise((resolve) => {
        this.#pending.push(() => {
          this.#current -= 1;
          resolve({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
        });
      });
    }

    get current(): number {
      return this.#current;
    }

    /** Resolves every call currently pending, letting its worker move on. */
    releasePending(): void {
      const toRelease = this.#pending.splice(0, this.#pending.length);
      for (const resolveOne of toRelease) {
        resolveOne();
      }
    }
  }

  /**
   * Yields the microtask queue enough times for one released spawn's
   * continuation chain (the spawn's own promise, then `runStep`'s adopted
   * promise, then the per-step callback's `await`, then the worker's
   * `await`) to reach the next synchronous dispatch — no real timer
   * involved, since nothing here is waiting on wall-clock time.
   */
  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
  }

  it("never runs more than `concurrency` steps at once, still runs every step, and preserves each result's step pairing", async () => {
    const spawner = new GatedSpawner();
    const hooks = Array.from({ length: 7 }, (_, index) =>
      makeHook({ command: `step-${String(index)}` }),
    );
    const steps = hooks.map((hook) => makeStep(hook));
    const deps = makeDeps({ spawner, concurrency: 3 });

    const resultPromise = executeHooks(deps, makePlan(steps));

    // executeHooks' worker pool dispatches its first round synchronously:
    // each of the 3 workers runs up to its own first await (the pending
    // spawn call) before control returns here, so exactly `concurrency`
    // calls have already started — no microtask flush needed yet.
    expect(spawner.calls).toHaveLength(3);
    expect(spawner.current).toBe(3);

    while (spawner.calls.length < steps.length) {
      spawner.releasePending();
      await flushMicrotasks();
    }
    spawner.releasePending();
    await flushMicrotasks();

    const results = await resultPromise;

    expect(spawner.calls).toHaveLength(7);
    expect(spawner.current).toBe(0);
    // The cap held for the whole run, not only at the start: this is the
    // assertion the fix's completion checklist asks for.
    expect(spawner.maxObserved).toBe(3);
    expect(results).toHaveLength(7);
    // Each ExecutionResult still carries its own step, in plan order.
    expect(results.map((result) => result.step)).toEqual(steps);
  });

  it("a concurrency below 1 is treated as 1 rather than deadlocking", async () => {
    const spawner = new CountingSpawner();
    const hook = makeHook({ command: "echo hi" });
    const deps = makeDeps({ spawner, concurrency: 0 });

    const outcomes = await executeHooks(deps, makePlan([makeStep(hook)]));

    expect(outcomes).toHaveLength(1);
    expect(spawner.calls).toHaveLength(1);
  });

  it("omitting concurrency uses HOOKASSERT_DEFAULT_CONCURRENCY", async () => {
    const spawner = new CountingSpawner();
    const hookCount = HOOKASSERT_DEFAULT_CONCURRENCY + 2;
    const hooks = Array.from({ length: hookCount }, (_, index) =>
      makeHook({ command: `default-cap-${String(index)}` }),
    );
    const deps = makeDeps({ spawner });

    const outcomes = await executeHooks(
      deps,
      makePlan(hooks.map((hook) => makeStep(hook))),
    );

    expect(outcomes).toHaveLength(hookCount);
    expect(spawner.calls).toHaveLength(hookCount);
  });

  it("a stubbed step still never reaches the Spawner while the cap is in effect", async () => {
    const spawner = new CountingSpawner();
    const stub: FixtureStubEntry = { exitCode: 3 };
    const hooks = Array.from({ length: 5 }, (_, index) =>
      makeHook({ command: `mixed-${String(index)}` }),
    );
    const steps = hooks.map((hook, index) =>
      makeStep(hook, index === 2 ? { stub } : {}),
    );
    const deps = makeDeps({ spawner, concurrency: 2 });

    const outcomes = await executeHooks(deps, makePlan(steps));

    expect(outcomes).toHaveLength(5);
    // 5 steps, 1 stubbed: only 4 ever reach the Spawner.
    expect(spawner.calls).toHaveLength(4);
    expect(spawner.calls.every((call) => call.command !== "mixed-2")).toBe(true);
    expect(outcomes[2]?.outcome).toEqual({
      exitCode: 3,
      stdout: "",
      stderr: "",
      timedOut: false,
    });
  });
});

describe("event scoping", () => {
  it("a hook belonging to an event no case asserts is never spawned", async () => {
    const spawner = new CountingSpawner();
    const assertedHook = makeHook({ event: "PreToolUse", command: "asserted-command" });
    const unassertedHook = makeHook({
      event: "PostToolUse",
      command: "unasserted-command",
    });
    const deps = makeDeps({ spawner });

    const outcomes = await executeHooks(
      deps,
      makePlan(
        [makeStep(assertedHook), makeStep(unassertedHook)],
        new Set<EventName>(["PreToolUse"]),
      ),
    );

    expect(outcomes).toHaveLength(1);
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0]?.command).toBe("asserted-command");
  });
});

describe("end to end: ExecOutcome feeds resolveDecision to the expected Decision.kind", () => {
  it.each([
    ["exit0-silent.mjs", [] as readonly string[], "pass"],
    ["exit2-stderr.mjs", [] as readonly string[], "deny"],
    ["emit-allow-json.mjs", [] as readonly string[], "allow"],
  ] as const)(
    "%s resolves to Decision.kind %s",
    async (scriptName, extraArgs, expectedKind) => {
      const scriptPath = path.join(HOOKS_DIR, scriptName);
      const hook = makeHook({
        event: "PreToolUse",
        command: process.execPath,
        args: [scriptPath, ...extraArgs],
      });
      const deps = makeDeps({ spawner: new NodeSpawner() });
      const [result] = await executeHooks(deps, makePlan([makeStep(hook)]));
      if (result === undefined) {
        throw new Error("executeHooks returned no outcome for a single-step plan");
      }

      const decision = resolveDecision(REAL_SPEC, "PreToolUse", result.outcome);
      expect(decision.kind).toBe(expectedKind);
    },
  );
});

describe("Spawner never rejects", () => {
  it("NodeSpawner resolves with an ExecOutcome even for a command that cannot be found", async () => {
    const hook = makeHook({ command: "/no/such/hookassert-fixture-binary", args: [] });
    const deps = makeDeps({ spawner: new NodeSpawner() });
    const [result] = await executeHooks(deps, makePlan([makeStep(hook)]));

    expect(result).toBeDefined();
    expect(result?.outcome.timedOut).toBe(false);
    expect(result?.outcome.exitCode).not.toBe(0);
  });
});
