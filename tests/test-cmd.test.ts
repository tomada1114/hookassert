import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCli, type CliDeps } from "../src/cli.js";
import { NodeSpawner } from "../src/internal/exec/spawner.js";
import type { Spawner, SpawnRequest } from "../src/internal/exec/spawner.js";
import type { ExecOutcome } from "../src/types.js";

// Reaching src/internal/exec/spawner.ts directly (rather than through
// src/index.ts's exports, per the writing-tests skill) is a deliberate,
// narrowly scoped exception, the same one tests/cli.test.ts and
// tests/executor.test.ts already take: `Spawner` has no public surface, and
// this file's whole point is proving `test`'s consent gate and spawn plan
// mechanically through an injected one — see eslint.config.mjs's
// "tests/static-layer-unit-tests" block for the full reasoning.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOKS_DIR = fileURLToPath(new URL("./fixtures/hooks/", import.meta.url));
const MINIMAL_SPEC_PATH = path.join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "spec",
  "valid-minimal.json",
);

const EXIT0_SILENT = path.join(HOOKS_DIR, "exit0-silent.mjs");
const EXIT2_STDERR = path.join(HOOKS_DIR, "exit2-stderr.mjs");
const EMIT_ALLOW_JSON = path.join(HOOKS_DIR, "emit-allow-json.mjs");
const PRINT_ARGV = path.join(HOOKS_DIR, "print-argv.mjs");
const PRINT_CWD = path.join(HOOKS_DIR, "print-cwd.mjs");

/**
 * Records every spawn request and actually runs it, through a real
 * `NodeSpawner` — used only by the one test that needs genuine end-to-end
 * spawning of the side-effect-free scripts under `tests/fixtures/hooks/`.
 */
class RecordingSpawner implements Spawner {
  readonly calls: SpawnRequest[] = [];
  readonly #inner = new NodeSpawner();

  spawn(req: SpawnRequest): Promise<ExecOutcome> {
    this.calls.push(req);
    return this.#inner.spawn(req);
  }
}

/** A canned outcome `FakeSpawner` resolves to for a request whose args name a given script. */
interface FakeOutcome {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

/**
 * Records every spawn request and resolves it from a canned lookup, without
 * ever actually spawning a process.
 *
 * @remarks
 * Used by every test in this file except the one dedicated "full pipeline"
 * test: real spawning is this file's whole subject for that one case, but
 * every other test only needs to observe *whether* a spawn happened and
 * *what* it would have produced — including `NodeVersionProbe`'s `claude
 * --version`, which must never really run here, since a real `claude`
 * binary may exist on the machine running this suite.
 */
class FakeSpawner implements Spawner {
  readonly calls: SpawnRequest[] = [];
  readonly #byScript: ReadonlyMap<string, FakeOutcome>;
  readonly #fallback: FakeOutcome;

  constructor(
    byScript: ReadonlyMap<string, FakeOutcome> = new Map(),
    fallback: FakeOutcome = { exitCode: 0 },
  ) {
    this.#byScript = byScript;
    this.#fallback = fallback;
  }

  spawn(req: SpawnRequest): Promise<ExecOutcome> {
    this.calls.push(req);
    const scriptArg = req.args.find((arg) => this.#byScript.has(arg));
    const outcome =
      (scriptArg === undefined ? undefined : this.#byScript.get(scriptArg)) ??
      this.#fallback;
    return Promise.resolve({
      exitCode: outcome.exitCode,
      stdout: outcome.stdout ?? "",
      stderr: outcome.stderr ?? "",
      timedOut: false,
    });
  }
}

let projectDir: string;
let fixtureCounter = 0;

beforeAll(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), "hookassert-test-cmd-"));
  mkdirSync(path.join(projectDir, ".claude"), { recursive: true });

  function commandGroup(matcher: string | undefined, script: string): unknown {
    return {
      ...(matcher === undefined ? {} : { matcher }),
      hooks: [{ type: "command", command: process.execPath, args: [script] }],
    };
  }

  const settings = {
    hooks: {
      PreToolUse: [
        commandGroup("Bash", EXIT0_SILENT),
        commandGroup("Write", EXIT2_STDERR),
        commandGroup("Edit", EMIT_ALLOW_JSON),
      ],
      // Declared but never referenced by any case in these fixtures: proves
      // hooks of events no case asserts on are never spawned.
      Notification: [commandGroup(undefined, PRINT_ARGV)],
      Stop: [commandGroup(undefined, PRINT_CWD)],
    },
  };
  writeFileSync(
    path.join(projectDir, ".claude", "settings.json"),
    JSON.stringify(settings, null, 2),
  );
});

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/** Write a fixture object (plain JSON is valid YAML) into the shared project dir. */
function writeFixture(fixture: unknown): string {
  fixtureCounter += 1;
  const filePath = path.join(projectDir, `fixture-${String(fixtureCounter)}.yaml`);
  writeFileSync(filePath, JSON.stringify(fixture, null, 2));
  return filePath;
}

function testDeps(overrides: Partial<CliDeps> = {}): Partial<CliDeps> {
  return {
    cwd: projectDir,
    home: path.join(projectDir, "no-such-home"),
    env: {},
    specPath: MINIMAL_SPEC_PATH,
    isTTY: false,
    confirm: () => Promise.resolve(false),
    spawner: new FakeSpawner(),
    ...overrides,
  };
}

interface JsonTestSummary {
  readonly asserted: number;
  readonly fromRecorded: number;
  readonly failed: number;
  readonly unknown: number;
  readonly skipped: number;
}

interface JsonTestCase {
  readonly event: string;
  readonly tool: string | null;
  readonly result: { readonly kind: string; readonly reason?: string };
}

interface JsonTestReportShape {
  readonly reportVersion: string;
  readonly header: { readonly claudeVersion: string };
  readonly cases: readonly JsonTestCase[];
  readonly summary: JsonTestSummary;
}

function parseJsonReport(stdout: string): JsonTestReportShape {
  return JSON.parse(stdout) as JsonTestReportShape;
}

describe("the full pipeline", () => {
  it("runs a fixture end to end and produces the expected pass/fail/unknown/skipped mix", async () => {
    const spawner = new RecordingSpawner();
    const fixturePath = writeFixture({
      cases: [
        {
          event: "PreToolUse",
          tool: "Bash",
          expect: { decision: "pass", exitCode: 0 },
        },
        // Deliberately wrong expectation — the hook actually denies.
        { event: "PreToolUse", tool: "Write", expect: { decision: "allow" } },
        { event: "PreToolUse", tool: "Edit", expect: { decision: "allow" } },
        // Notification has no entry in valid-minimal.json's spec, so the
        // fired hook's decision resolves to "unknown" (event-not-in-spec).
        { event: "Notification", expect: {} },
        {
          event: "PreToolUse",
          tool: "Bash",
          dryRun: true,
          expect: { decision: "pass" },
        },
        {
          event: "PreToolUse",
          tool: "Write",
          stub: { [process.execPath]: { exitCode: 0 } },
          expect: {},
        },
      ],
    });

    const result = await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300", "--yes", "--format", "json"],
      "hookassert",
      testDeps({ spawner }),
    );

    const report = parseJsonReport(result.stdout);
    expect(report.summary).toEqual({
      asserted: 3,
      fromRecorded: 0,
      failed: 1,
      unknown: 1,
      skipped: 2,
    });
    // Every real (non-dry-run, non-stub-only) case actually spawned; the
    // dry-run and stub-only cases never entered the spawn plan at all.
    expect(spawner.calls).toHaveLength(4);
  });

  it("the pretty and github reporters render a fail's diffs and its no-hook-configured reason", async () => {
    const OUTCOMES = new Map<string, FakeOutcome>([[EXIT2_STDERR, { exitCode: 2 }]]);
    const fixturePath = writeFixture({
      cases: [
        // Wrong on purpose: fires and denies, but expected "allow" — a diff-shaped fail.
        { event: "PreToolUse", tool: "Write", expect: { decision: "allow" } },
        // No hook is configured for SessionStart at all — a nonFiring-shaped fail.
        { event: "SessionStart", expect: { fires: true } },
      ],
    });

    const pretty = await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300", "--yes"],
      "hookassert",
      testDeps({ spawner: new FakeSpawner(OUTCOMES) }),
    );
    expect(pretty.stdout).toContain('decision: expected "allow", got "deny"');
    expect(pretty.stdout).toContain("no hook is declared under SessionStart");

    const github = await runCli(
      [
        "test",
        fixturePath,
        "--claude-version",
        "2.1.300",
        "--yes",
        "--format",
        "github",
      ],
      "hookassert",
      testDeps({ spawner: new FakeSpawner(OUTCOMES) }),
    );
    expect(github.stdout).toContain("::error file=");
    expect(github.stdout).toContain("test case #0");
    expect(github.stdout).toContain("test case #1");
  });
});

describe("the consent gate", () => {
  function singlePassingCaseFixture(): string {
    return writeFixture({
      cases: [{ event: "PreToolUse", tool: "Bash", expect: { decision: "pass" } }],
    });
  }

  it("on a non-TTY without --yes or --ci, exits 6 with ERR_CONSENT_REQUIRED and spawns nothing", async () => {
    const spawner = new FakeSpawner();
    const fixturePath = singlePassingCaseFixture();

    const result = await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300"],
      "hookassert",
      testDeps({ spawner }),
    );

    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain("ERR_CONSENT_REQUIRED");
    expect(spawner.calls).toHaveLength(0);
  });

  it("on a non-TTY without --yes, --ci, --claude-version, or HOOKASSERT_CLAUDE_VERSION, exits 6 and never spawns the version probe either", async () => {
    const spawner = new FakeSpawner();
    const fixturePath = singlePassingCaseFixture();

    // No --claude-version and no env var: resolveVersionContextForTest would
    // otherwise have to call NodeVersionProbe.detect(), which spawns `claude
    // --version`. This is the regression case for the bug where the probe
    // ran before the consent gate did — the assertion that matters here is
    // the spawn count, not just the exit code.
    const result = await runCli(
      ["test", fixturePath],
      "hookassert",
      testDeps({ spawner, env: {} }),
    );

    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain("ERR_CONSENT_REQUIRED");
    expect(spawner.calls).toHaveLength(0);
  });

  it("--yes bypasses the prompt and proceeds", async () => {
    const spawner = new FakeSpawner();
    const fixturePath = singlePassingCaseFixture();

    const result = await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300", "--yes"],
      "hookassert",
      testDeps({ spawner }),
    );

    expect(result.exitCode).toBe(0);
    expect(spawner.calls).toHaveLength(1);
  });

  it("--ci bypasses the prompt and proceeds", async () => {
    const spawner = new FakeSpawner();
    const fixturePath = singlePassingCaseFixture();

    const result = await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300", "--ci"],
      "hookassert",
      testDeps({ spawner }),
    );

    expect(result.exitCode).toBe(0);
    expect(spawner.calls).toHaveLength(1);
  });

  it("an interactive TTY that declines the prompt is treated the same as a refusal", async () => {
    const spawner = new FakeSpawner();
    const fixturePath = singlePassingCaseFixture();

    const result = await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300"],
      "hookassert",
      testDeps({ spawner, isTTY: true, confirm: () => Promise.resolve(false) }),
    );

    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain("ERR_CONSENT_REQUIRED");
    expect(spawner.calls).toHaveLength(0);
  });

  it("an interactive TTY that approves the prompt proceeds", async () => {
    const spawner = new FakeSpawner();
    const fixturePath = singlePassingCaseFixture();
    let promptSeen = "";

    const result = await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300"],
      "hookassert",
      testDeps({
        spawner,
        isTTY: true,
        confirm: (prompt) => {
          promptSeen = prompt;
          return Promise.resolve(true);
        },
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(spawner.calls).toHaveLength(1);
    expect(promptSeen).toContain(process.execPath);
  });
});

describe("--dry-run and stub-only exclusion from the spawn plan", () => {
  it("--dry-run excludes its cases from the spawn plan and marks them skipped", async () => {
    const spawner = new FakeSpawner();
    const fixturePath = writeFixture({
      cases: [{ event: "PreToolUse", tool: "Bash", expect: { decision: "pass" } }],
    });

    const result = await runCli(
      [
        "test",
        fixturePath,
        "--claude-version",
        "2.1.300",
        "--dry-run",
        "--format",
        "json",
      ],
      "hookassert",
      testDeps({ spawner }),
    );

    expect(result.exitCode).toBe(0);
    expect(spawner.calls).toHaveLength(0);
    const report = parseJsonReport(result.stdout);
    expect(report.cases[0]?.result).toEqual({
      kind: "skipped",
      reason: "dry-run",
      origin: { kind: "synthetic" },
    });
  });

  it("a fully stub-covered case is excluded from the spawn plan and marks skipped", async () => {
    const spawner = new FakeSpawner();
    const fixturePath = writeFixture({
      cases: [
        {
          event: "PreToolUse",
          tool: "Bash",
          stub: { [process.execPath]: { exitCode: 0 } },
          expect: {},
        },
      ],
    });

    // No --yes/--ci/isTTY needed: nothing in the plan is spawn-worthy.
    const result = await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300", "--format", "json"],
      "hookassert",
      testDeps({ spawner }),
    );

    expect(result.exitCode).toBe(0);
    expect(spawner.calls).toHaveLength(0);
    const report = parseJsonReport(result.stdout);
    expect(report.cases[0]?.result).toEqual({
      kind: "skipped",
      reason: "stub-only",
      origin: { kind: "synthetic" },
    });
  });
});

describe("ClaudeVersion resolution order", () => {
  function noOpFixture(): string {
    // SessionStart is in valid-minimal.json's spec but has no configured
    // hook in this project's settings.json, so nothing fires or spawns.
    return writeFixture({ cases: [{ event: "SessionStart", expect: {} }] });
  }

  it("--claude-version overrides the probe and the recorded-session fallback", async () => {
    const spawner = new FakeSpawner();
    const fixturePath = noOpFixture();

    const result = await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300", "--ci"],
      "hookassert",
      testDeps({ spawner }),
    );

    expect(result.exitCode).toBe(0);
    expect(spawner.calls.some((call) => call.command === "claude")).toBe(false);
  });

  it("HOOKASSERT_CLAUDE_VERSION overrides the probe when --claude-version is absent", async () => {
    const spawner = new FakeSpawner();
    const fixturePath = noOpFixture();

    const result = await runCli(
      ["test", fixturePath, "--ci"],
      "hookassert",
      testDeps({ spawner, env: { HOOKASSERT_CLAUDE_VERSION: "2.1.280" } }),
    );

    expect(result.exitCode).toBe(0);
    expect(spawner.calls.some((call) => call.command === "claude")).toBe(false);
  });

  it("the probe (VersionProbe) is used only when --claude-version and the env var are both absent", async () => {
    const spawner = new FakeSpawner();
    const fixturePath = noOpFixture();

    const result = await runCli(
      ["test", fixturePath, "--ci"],
      "hookassert",
      testDeps({ spawner, env: {} }),
    );

    expect(result.exitCode).toBe(0);
    const probeCall = spawner.calls.find((call) => call.command === "claude");
    expect(probeCall?.args).toEqual(["--version"]);
  });
});

describe("--timeout", () => {
  it("an explicit --timeout above the spec's own ceiling is honored, not clamped", async () => {
    const spawner = new FakeSpawner();
    // valid-minimal.json's own defaults.hookTimeoutMs is 600000; the point of
    // this test is that a --timeout above that ceiling still wins, mirroring
    // the exemption a hook's own declared timeoutMs already gets.
    const fixturePath = writeFixture({
      cases: [{ event: "PreToolUse", tool: "Bash", expect: { decision: "pass" } }],
    });

    const result = await runCli(
      [
        "test",
        fixturePath,
        "--claude-version",
        "2.1.300",
        "--yes",
        "--timeout",
        "900000",
      ],
      "hookassert",
      testDeps({ spawner }),
    );

    expect(result.exitCode).toBe(0);
    const hookCall = spawner.calls.find((call) => call.command !== "claude");
    expect(hookCall?.timeoutMs).toBe(900_000);
  });
});

describe("exit-code semantics", () => {
  const OUTCOMES = new Map<string, FakeOutcome>([
    [EXIT0_SILENT, { exitCode: 0 }],
    [EXIT2_STDERR, { exitCode: 2, stderr: "blocked by policy\n" }],
    [
      EMIT_ALLOW_JSON,
      {
        exitCode: 0,
        stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }),
      },
    ],
  ]);

  function fakeSpawnerWithRealOutcomes(): FakeSpawner {
    return new FakeSpawner(OUTCOMES);
  }

  it("all cases pass -> exit 0", async () => {
    const fixturePath = writeFixture({
      cases: [
        { event: "PreToolUse", tool: "Bash", expect: { decision: "pass" } },
        { event: "PreToolUse", tool: "Edit", expect: { decision: "allow" } },
      ],
    });

    const result = await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300", "--yes"],
      "hookassert",
      testDeps({ spawner: fakeSpawnerWithRealOutcomes() }),
    );

    expect(result.exitCode).toBe(0);
  });

  it("one failure among passes -> exit 1", async () => {
    const fixturePath = writeFixture({
      cases: [
        { event: "PreToolUse", tool: "Bash", expect: { decision: "pass" } },
        // Wrong on purpose: the hook actually denies.
        { event: "PreToolUse", tool: "Write", expect: { decision: "allow" } },
      ],
    });

    const result = await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300", "--yes"],
      "hookassert",
      testDeps({ spawner: fakeSpawnerWithRealOutcomes() }),
    );

    expect(result.exitCode).toBe(1);
  });

  it("zero failures, one unknown, no --ci -> exit 0", async () => {
    const fixturePath = writeFixture({
      cases: [
        { event: "PreToolUse", tool: "Bash", expect: { decision: "pass" } },
        { event: "Notification", expect: {} },
      ],
    });

    const result = await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300", "--yes"],
      "hookassert",
      testDeps({ spawner: fakeSpawnerWithRealOutcomes() }),
    );

    expect(result.exitCode).toBe(0);
  });

  it("zero failures, one unknown, --ci -> exit 3", async () => {
    const fixturePath = writeFixture({
      cases: [
        { event: "PreToolUse", tool: "Bash", expect: { decision: "pass" } },
        { event: "Notification", expect: {} },
      ],
    });

    const result = await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300", "--yes", "--ci"],
      "hookassert",
      testDeps({ spawner: fakeSpawnerWithRealOutcomes() }),
    );

    expect(result.exitCode).toBe(3);
  });

  it("one failure and one unknown together, --ci -> exit 1 (failure wins over unknown)", async () => {
    const fixturePath = writeFixture({
      cases: [
        // Wrong on purpose: the hook actually denies.
        { event: "PreToolUse", tool: "Write", expect: { decision: "allow" } },
        { event: "Notification", expect: {} },
      ],
    });

    const result = await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300", "--yes", "--ci"],
      "hookassert",
      testDeps({ spawner: fakeSpawnerWithRealOutcomes() }),
    );

    expect(result.exitCode).toBe(1);
  });
});

describe("machine guarantees", () => {
  it("hooks of events no case in the fixture asserts are never spawned", async () => {
    const spawner = new FakeSpawner();
    const fixturePath = writeFixture({
      cases: [{ event: "PreToolUse", tool: "Bash", expect: { decision: "pass" } }],
    });

    const result = await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300", "--yes"],
      "hookassert",
      testDeps({ spawner }),
    );

    expect(result.exitCode).toBe(0);
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls.some((call) => call.args.includes(PRINT_CWD))).toBe(false);
    expect(spawner.calls.some((call) => call.args.includes(PRINT_ARGV))).toBe(false);
  });

  it("stubbed commands are never spawned", async () => {
    const spawner = new FakeSpawner();
    const fixturePath = writeFixture({
      cases: [
        {
          event: "PreToolUse",
          tool: "Write",
          stub: { [process.execPath]: { exitCode: 0 } },
          // A real (non-empty) expectation: this case is NOT stub-only, so
          // it does enter the plan, but its one firing hook is still never
          // spawned — its Decision comes from the stub's declared exitCode.
          expect: { decision: "pass", exitCode: 0 },
        },
      ],
    });

    const result = await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300", "--yes", "--format", "json"],
      "hookassert",
      testDeps({ spawner }),
    );

    expect(spawner.calls).toHaveLength(0);
    const report = parseJsonReport(result.stdout);
    expect(report.cases[0]?.result.kind).toBe("pass");
  });

  it("explain and lint (both zero-execution static checks) remain at 0 spawns when run alongside test in the same CLI process", async () => {
    const spawner = new FakeSpawner();
    const deps = testDeps({ spawner });

    const explainResult = await runCli(
      ["explain", "PreToolUse", "Bash"],
      "hookassert",
      deps,
    );
    expect(explainResult.exitCode).toBe(0);
    expect(spawner.calls).toHaveLength(0);

    // Exit 0: this shared project's own settings.json (see beforeAll above)
    // declares only correctly-cased, known-tool matchers ("Bash", "Write",
    // "Edit"), so none of the five matcher rules has anything to report.
    const lintResult = await runCli(["lint"], "hookassert", deps);
    expect(lintResult.exitCode).toBe(0);
    expect(spawner.calls).toHaveLength(0);

    const fixturePath = writeFixture({
      cases: [{ event: "PreToolUse", tool: "Bash", expect: { decision: "pass" } }],
    });
    const testResult = await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300", "--yes"],
      "hookassert",
      deps,
    );
    expect(testResult.exitCode).toBe(0);
    expect(spawner.calls.length).toBeGreaterThan(0);
  });
});
