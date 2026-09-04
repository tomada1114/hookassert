import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { runCli, type CliDeps } from "../src/cli.js";
import { NodeSpawner } from "../src/internal/exec/index.js";
import type { Spawner, SpawnRequest } from "../src/internal/exec/index.js";
import type { ExecOutcome } from "../src/types.js";

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
  readonly launchError?: string;
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
      launchError: outcome.launchError,
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

interface JsonDecidedBy {
  readonly hook: {
    readonly command: string;
    readonly provenance: { readonly layer: string; readonly file: string };
  };
  readonly decision: { readonly kind: string };
}

interface JsonTestCase {
  readonly event: string;
  readonly tool: string | null;
  readonly result: {
    readonly kind: string;
    readonly reason?: string;
    readonly decidedBy?: JsonDecidedBy | null;
  };
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
    // Exactly one hook fired for each case here — pretty only names the
    // deciding hook once more than one fired for the same case.
    expect(pretty.stdout).not.toContain("decided by");

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

describe("launch failures (issue #39)", () => {
  // A dedicated project dir, isolated from the shared `projectDir`'s own
  // settings.json: this hook's command deliberately does not exist, and the
  // shared settings file is reused by `lint`-touching tests elsewhere in
  // this suite that assert zero findings — a nonexistent command would
  // trip `lint`'s own command-not-found rule there.
  let launchFailProjectDir: string;

  afterEach(() => {
    rmSync(launchFailProjectDir, { recursive: true, force: true });
  });

  function setUpLaunchFailProject(): void {
    launchFailProjectDir = mkdtempSync(
      path.join(tmpdir(), "hookassert-launch-fail-project-"),
    );
    mkdirSync(path.join(launchFailProjectDir, ".claude"), { recursive: true });
    const settings = {
      hooks: {
        PreToolUse: [
          // Exec form (`args` present) naming a command that does not
          // exist — the literal command name mirrors this issue's own
          // illustrative example.
          {
            matcher: "LaunchFail",
            hooks: [{ type: "command", command: "python33", args: [] }],
          },
        ],
      },
    };
    writeFileSync(
      path.join(launchFailProjectDir, ".claude", "settings.json"),
      JSON.stringify(settings, null, 2),
    );
  }

  function launchFailFixturePath(fixture: unknown): string {
    const filePath = path.join(launchFailProjectDir, "fixture.yaml");
    writeFileSync(filePath, JSON.stringify(fixture, null, 2));
    return filePath;
  }

  it("a fixture expecting decision: error passes when the hook never launches", async () => {
    setUpLaunchFailProject();
    const spawner = new RecordingSpawner();
    const fixturePath = launchFailFixturePath({
      cases: [
        { event: "PreToolUse", tool: "LaunchFail", expect: { decision: "error" } },
      ],
    });

    const result = await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300", "--yes", "--format", "json"],
      "hookassert",
      testDeps({ cwd: launchFailProjectDir, spawner }),
    );

    expect(result.exitCode).toBe(0);
    const report = parseJsonReport(result.stdout);
    expect(report.summary).toEqual({
      asserted: 1,
      fromRecorded: 0,
      failed: 0,
      unknown: 0,
      skipped: 0,
    });
    expect(report.cases[0]?.result.kind).toBe("pass");
  });

  it("pretty prints the launch-failure message and github annotates the hook's own declaration line", async () => {
    setUpLaunchFailProject();
    // Expects something a launch failure cannot satisfy, so the case fails
    // and the launch message — not the raw exitCode/decision diff — is what
    // both reporters show.
    const fixturePath = launchFailFixturePath({
      cases: [{ event: "PreToolUse", tool: "LaunchFail", expect: { exitCode: 0 } }],
    });

    const pretty = await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300", "--yes"],
      "hookassert",
      testDeps({ cwd: launchFailProjectDir, spawner: new RecordingSpawner() }),
    );
    expect(pretty.stdout).toContain("FAIL");
    expect(pretty.stdout).toContain("hook never launched: spawn python33 ENOENT");
    expect(pretty.stdout).toContain('command "python33"');
    expect(pretty.stdout).toMatch(/settings\.json:\d+\)/);
    // The launch message already names the hook and its location, so the
    // "decided by" suffix (only relevant for multi-hook cases anyway) never
    // doubles up on it.
    expect(pretty.stdout).not.toContain("decided by");

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
      testDeps({ cwd: launchFailProjectDir, spawner: new RecordingSpawner() }),
    );
    expect(github.stdout).toMatch(/::error file=\.claude\/settings\.json,line=\d+/);
    expect(github.stdout).toContain("hook never launched: spawn python33 ENOENT");
  });
});

describe("combining more than one firing hook (issue #42)", () => {
  // A dedicated project/home pair per test, isolated from the shared
  // projectDir's own settings.json: two hooks (one per settings layer) fire
  // for the same case, and only one of them denies — proving `test` folds
  // every firing hook's Decision (any deny wins) rather than reading back
  // only the first one.
  let multiHookProjectDir: string;
  let multiHookHomeDir: string;

  afterEach(() => {
    rmSync(multiHookProjectDir, { recursive: true, force: true });
    rmSync(multiHookHomeDir, { recursive: true, force: true });
  });

  function settingsDeclaring(script: string): unknown {
    return {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: process.execPath, args: [script] }],
          },
        ],
      },
    };
  }

  /** One hook in the user layer, one in the project layer, each running `userScript`/`projectScript`. */
  function setUpTwoLayers(userScript: string, projectScript: string): void {
    multiHookProjectDir = mkdtempSync(
      path.join(tmpdir(), "hookassert-multi-hook-project-"),
    );
    multiHookHomeDir = mkdtempSync(path.join(tmpdir(), "hookassert-multi-hook-home-"));
    mkdirSync(path.join(multiHookProjectDir, ".claude"), { recursive: true });
    mkdirSync(path.join(multiHookHomeDir, ".claude"), { recursive: true });
    writeFileSync(
      path.join(multiHookHomeDir, ".claude", "settings.json"),
      JSON.stringify(settingsDeclaring(userScript), null, 2),
    );
    writeFileSync(
      path.join(multiHookProjectDir, ".claude", "settings.json"),
      JSON.stringify(settingsDeclaring(projectScript), null, 2),
    );
  }

  function multiHookFixturePath(): string {
    const filePath = path.join(multiHookProjectDir, "fixture.yaml");
    writeFileSync(
      filePath,
      JSON.stringify(
        {
          cases: [{ event: "PreToolUse", tool: "Bash", expect: { decision: "pass" } }],
        },
        null,
        2,
      ),
    );
    return filePath;
  }

  const denyOutcomes = new Map<string, FakeOutcome>([
    [EXIT2_STDERR, { exitCode: 2, stderr: "blocked by policy\n" }],
  ]);

  it("a project-layer deny behind a user-layer pass is reported as failing, not passing", async () => {
    setUpTwoLayers(EXIT0_SILENT, EXIT2_STDERR);
    const fixturePath = multiHookFixturePath();
    const spawner = new FakeSpawner(denyOutcomes);

    const result = await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300", "--yes", "--format", "json"],
      "hookassert",
      testDeps({
        cwd: multiHookProjectDir,
        home: multiHookHomeDir,
        spawner,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(spawner.calls).toHaveLength(2);
    const report = parseJsonReport(result.stdout);
    expect(report.cases[0]?.result.kind).toBe("fail");
    expect(report.cases[0]?.result.decidedBy?.decision.kind).toBe("deny");
    expect(report.cases[0]?.result.decidedBy?.hook.provenance.layer).toBe("project");
  });

  it("the verdict is identical when the two hooks' settings layers are swapped", async () => {
    setUpTwoLayers(EXIT2_STDERR, EXIT0_SILENT);
    const fixturePath = multiHookFixturePath();
    const spawner = new FakeSpawner(denyOutcomes);

    const result = await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300", "--yes", "--format", "json"],
      "hookassert",
      testDeps({
        cwd: multiHookProjectDir,
        home: multiHookHomeDir,
        spawner,
      }),
    );

    expect(result.exitCode).toBe(1);
    const report = parseJsonReport(result.stdout);
    expect(report.cases[0]?.result.kind).toBe("fail");
    expect(report.cases[0]?.result.decidedBy?.decision.kind).toBe("deny");
    expect(report.cases[0]?.result.decidedBy?.hook.provenance.layer).toBe("user");
  });

  it("a second hook that times out while the first did not still sets expect.timedOut's actual value to true", async () => {
    // Two distinct scripts, one per layer: identical declarations across
    // layers collapse into a single dedupeKey (settings/merge.ts), which
    // would leave only one hook firing here.
    setUpTwoLayers(EXIT0_SILENT, PRINT_ARGV);
    const filePath = path.join(multiHookProjectDir, "fixture-timeout.yaml");
    writeFileSync(
      filePath,
      JSON.stringify(
        {
          cases: [
            {
              event: "PreToolUse",
              tool: "Bash",
              expect: { timedOut: true },
            },
          ],
        },
        null,
        2,
      ),
    );

    class TimeoutOnSecondSpawner implements Spawner {
      readonly calls: SpawnRequest[] = [];
      spawn(req: SpawnRequest): Promise<ExecOutcome> {
        this.calls.push(req);
        const timedOut = this.calls.length > 1;
        return Promise.resolve({
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut,
          launchError: undefined,
        });
      }
    }
    const spawner = new TimeoutOnSecondSpawner();

    const result = await runCli(
      ["test", filePath, "--claude-version", "2.1.300", "--yes", "--format", "json"],
      "hookassert",
      testDeps({ cwd: multiHookProjectDir, home: multiHookHomeDir, spawner }),
    );

    expect(spawner.calls).toHaveLength(2);
    const report = parseJsonReport(result.stdout);
    expect(report.cases[0]?.result.kind).toBe("pass");
  });

  it("the pretty and github reporters name the deciding hook only when more than one hook fired", async () => {
    setUpTwoLayers(EXIT0_SILENT, EXIT2_STDERR);
    const fixturePath = multiHookFixturePath();

    const pretty = await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300", "--yes"],
      "hookassert",
      testDeps({
        cwd: multiHookProjectDir,
        home: multiHookHomeDir,
        spawner: new FakeSpawner(denyOutcomes),
      }),
    );
    expect(pretty.stdout).toContain("decided by");
    // The deciding hook is the project-layer one (it declares EXIT2_STDERR here).
    expect(pretty.stdout).toContain(
      path.join(multiHookProjectDir, ".claude", "settings.json"),
    );

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
      testDeps({
        cwd: multiHookProjectDir,
        home: multiHookHomeDir,
        spawner: new FakeSpawner(denyOutcomes),
      }),
    );
    // The deciding hook's own settings file (project layer, under cwd) is
    // annotated instead of line 1 of the fixture.
    expect(github.stdout).toContain("file=.claude/settings.json");
  });

  it("a deciding hook outside the workspace keeps the github annotation on the fixture and names the hook in the message", async () => {
    // The user layer denies here, and its settings file lives under the home
    // dir — outside `cwd`, so an annotation pointing at it would attach to
    // nothing in the checkout.
    setUpTwoLayers(EXIT2_STDERR, EXIT0_SILENT);
    const fixturePath = multiHookFixturePath();

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
      testDeps({
        cwd: multiHookProjectDir,
        home: multiHookHomeDir,
        spawner: new FakeSpawner(denyOutcomes),
      }),
    );

    expect(github.stdout).toContain("file=fixture.yaml");
    expect(github.stdout).not.toContain(
      `file=${path.join(multiHookHomeDir, ".claude", "settings.json")}`,
    );
    expect(github.stdout).toContain("decided by");
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

  it("names the default cap in the prompt when there are more commands than the cap", async () => {
    const spawner = new FakeSpawner();
    const tools = ["Bash", "Write", "Edit"] as const;
    const fixturePath = writeFixture({
      // 9 spawn-worthy cases so the default cap of 8 is actually reachable —
      // with fewer commands than the cap, `gateConsent` reports the smaller
      // achievable concurrency instead (see the single-command test above).
      cases: Array.from({ length: 9 }, (_, i) => ({
        event: "PreToolUse",
        tool: tools[i % tools.length],
        expect: {},
      })),
    });
    let promptSeen = "";

    await runCli(
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

    expect(promptSeen).toContain("About to run 9 command(s), up to 8 at a time:");
  });

  it("names the achievable concurrency in the prompt when it is below the cap", async () => {
    const spawner = new FakeSpawner();
    const fixturePath = singlePassingCaseFixture();
    let promptSeen = "";

    await runCli(
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

    expect(promptSeen).toContain("About to run 1 command(s), one at a time:");
  });

  it("names a --concurrency 1 cap in the prompt as one at a time", async () => {
    const spawner = new FakeSpawner();
    const fixturePath = singlePassingCaseFixture();
    let promptSeen = "";

    await runCli(
      ["test", fixturePath, "--claude-version", "2.1.300", "--concurrency", "1"],
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

    expect(promptSeen).toContain("About to run 1 command(s), one at a time:");
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

describe("--concurrency", () => {
  it.each(["0", "-1", "1.5", "abc", ""])(
    "rejects --concurrency %j with ERR_USAGE and spawns nothing",
    async (value) => {
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
          "--yes",
          "--concurrency",
          value,
        ],
        "hookassert",
        testDeps({ spawner }),
      );

      expect(result.exitCode).toBe(4);
      expect(result.stderr).toContain("ERR_USAGE");
      expect(spawner.calls).toHaveLength(0);
    },
  );

  /**
   * A `Spawner` whose calls stay pending until manually released one at a
   * time, and which records the maximum number of calls in flight at once —
   * the same shape as the `GatedSpawner` in the cross-file concurrency
   * suite below, but releasing a single call rather than every pending one,
   * so a test can prove a second call is never issued while the first is
   * still outstanding.
   */
  class SingleReleaseGatedSpawner implements Spawner {
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
          resolve({
            exitCode: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            launchError: undefined,
          });
        });
      });
    }

    /** Resolves the single oldest pending call, letting its worker move on. */
    releaseOne(): void {
      const next = this.#pending.shift();
      next?.();
    }
  }

  it("--concurrency 1 runs firing hooks one at a time", async () => {
    const spawner = new SingleReleaseGatedSpawner();
    const fixturePath = writeFixture({
      cases: [
        { event: "PreToolUse", tool: "Bash", expect: {} },
        { event: "PreToolUse", tool: "Write", expect: {} },
        { event: "PreToolUse", tool: "Edit", expect: {} },
      ],
    });

    const resultPromise = runCli(
      [
        "test",
        fixturePath,
        "--claude-version",
        "2.1.300",
        "--yes",
        "--concurrency",
        "1",
      ],
      "hookassert",
      testDeps({ spawner }),
    );

    for (let released = 0; released < 3; released += 1) {
      await vi.waitFor(() => {
        expect(spawner.calls.length).toBeGreaterThan(released);
      });
      spawner.releaseOne();
    }

    const result = await resultPromise;

    expect(result.exitCode).toBe(0);
    expect(spawner.calls).toHaveLength(3);
    expect(spawner.maxObserved).toBe(1);
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

describe("cross-file concurrency cap (issue #40)", () => {
  /**
   * A `Spawner` whose calls stay pending until manually released, and which
   * records the maximum number of calls in flight at once — used here to
   * prove `runTest` runs its fixture files' pools one at a time rather than
   * letting every file's own `HOOKASSERT_DEFAULT_CONCURRENCY`-sized pool run
   * in parallel with the others (the fan-out issue #40 was filed against).
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
          resolve({
            exitCode: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            launchError: undefined,
          });
        });
      });
    }

    /** Resolves every call currently pending, letting its worker move on. */
    releasePending(): void {
      const toRelease = this.#pending.splice(0, this.#pending.length);
      for (const resolveOne of toRelease) {
        resolveOne();
      }
    }
  }

  /** Releases every pending call, then waits until the next call shows up. */
  async function releaseAndWaitForNextCall(spawner: GatedSpawner): Promise<void> {
    const before = spawner.calls.length;
    spawner.releasePending();
    await vi.waitFor(() => {
      expect(spawner.calls.length).toBeGreaterThan(before);
    });
  }

  it("never runs more than one fixture file's pool at once across several files", async () => {
    const spawner = new GatedSpawner();
    const casesPerFile = [
      { event: "PreToolUse", tool: "Bash", expect: {} },
      { event: "PreToolUse", tool: "Write", expect: {} },
      { event: "PreToolUse", tool: "Edit", expect: {} },
    ];
    const fixturePaths = Array.from({ length: 3 }, () =>
      writeFixture({ cases: casesPerFile }),
    );
    const totalSpawns = fixturePaths.length * casesPerFile.length;

    const resultPromise = runCli(
      ["test", ...fixturePaths, "--claude-version", "2.1.300", "--yes"],
      "hookassert",
      testDeps({ spawner }),
    );

    while (spawner.calls.length < totalSpawns) {
      await releaseAndWaitForNextCall(spawner);
    }
    spawner.releasePending();

    const result = await resultPromise;

    expect(spawner.calls).toHaveLength(totalSpawns);
    // Each file's own pool spawns at most `casesPerFile.length` calls at
    // once. If the files' pools ran in parallel instead of sequentially,
    // this could reach up to `totalSpawns`.
    expect(spawner.maxObserved).toBeLessThanOrEqual(casesPerFile.length);
    expect(result.exitCode).toBe(0);
  });
});
