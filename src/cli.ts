#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  assertCase,
  isStubOnly,
  summarize,
  type CaseObservation,
} from "./internal/assert/index.js";
import { resolveDecision } from "./internal/decision/index.js";
import {
  ConsentRequiredError,
  HookassertError,
  SettingsNotFoundError,
  UsageError,
} from "./internal/errors.js";
import {
  executeHooks,
  HOOKASSERT_DEFAULT_TIMEOUT_MS,
  NodeVersionProbe,
  type ExecDeps,
  type ExecutionPlan,
  type ExecutionResult,
  type ExecutionStep,
} from "./internal/exec/index.js";
import { NodeSpawner, type Spawner } from "./internal/exec/spawner.js";
import type { VersionProbe } from "./internal/exec/version.js";
import {
  loadFixtures,
  type FixtureCase,
  type FixtureFile,
  type FixtureSet,
} from "./internal/fixture/index.js";
import { buildLintContext, LINT_RULES } from "./internal/lint/index.js";
import {
  isRecordSessionActive,
  startRecordSession,
  stopRecordSession,
} from "./internal/record/index.js";
import {
  matchHooks,
  type MatcherOutcome,
  type VersionContext,
} from "./internal/matcher/index.js";
import {
  buildReportHeader,
  formatClaudeVersion,
  isReportFormat,
  renderGithub,
  renderInFormat,
  renderJson,
  renderLintGithub,
  renderLintJson,
  renderLintPretty,
  renderPretty,
  renderTestGithub,
  renderTestJson,
  renderTestPretty,
  type ExplainReport,
  type LintReport,
  type TestCaseReport,
  type TestReport,
} from "./internal/report/index.js";
import {
  discoverSources,
  hooksForEvent,
  loadSettings,
} from "./internal/settings/index.js";
import { loadSpecFile, parseClaudeVersion, type Spec } from "./internal/spec/index.js";
import type { CaseResult, EventName, ExecOutcome, ResolvedHook } from "./types.js";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * The environment variable `explain` and `lint` read a Claude Code version
 * from, when `--claude-version` was not given.
 *
 * @remarks
 * Named here rather than inline so the two places that read it (this
 * module's `resolveVersionContext`) and describe it (the README, the design
 * section of the `cli-explain` issue) stay in agreement.
 */
const CLAUDE_VERSION_ENV_VAR = "HOOKASSERT_CLAUDE_VERSION";

/**
 * The shipped hooks spec `explain` and `lint` load. `#7`'s design leaves
 * multi-spec selection to a later issue; today exactly one spec file ships,
 * and both commands load it unconditionally.
 */
const SPEC_PATH = fileURLToPath(
  new URL("../spec/claude-code-2.1.251-2.2.0.json", import.meta.url),
);

/**
 * The commands hookassert ships, with the one-line summary each gets in the
 * usage text.
 *
 * @remarks
 * Every one of the four has real behavior. Naming all four here is what
 * makes the usage text and the "unknown command" message agree with each
 * other.
 */
const COMMANDS = [
  ["explain", "Show which hooks a tool event fires, and why."],
  ["lint", "Check hook declarations for matcher and command mistakes."],
  ["record", "Capture real hook payloads from a Claude Code session."],
  ["test", "Replay recorded events and assert on what the hooks did."],
] as const;

type Subcommand = (typeof COMMANDS)[number][0];

function commandNames(): readonly Subcommand[] {
  return COMMANDS.map(([name]) => name);
}

function isSubcommand(value: string): value is Subcommand {
  return commandNames().some((name) => name === value);
}

/**
 * The full set of officially documented event names, mirroring
 * `src/types.ts`'s `EventName` union.
 *
 * @remarks
 * Typed as `Record<EventName, true>` rather than an array so the mirror
 * cannot silently drift, the same technique `settings/load.ts`'s own
 * `KNOWN_EVENT_NAMES` uses: widening `EventName` without extending this map
 * is a type error here rather than an `explain <event>` invocation that
 * silently accepts an event this build does not actually know.
 */
const EVENT_NAMES: Readonly<Record<EventName, true>> = {
  SessionStart: true,
  Setup: true,
  InstructionsLoaded: true,
  UserPromptSubmit: true,
  UserPromptExpansion: true,
  MessageDisplay: true,
  PreToolUse: true,
  PermissionRequest: true,
  PostToolUse: true,
  PostToolUseFailure: true,
  PostToolBatch: true,
  PermissionDenied: true,
  Notification: true,
  SubagentStart: true,
  SubagentStop: true,
  TaskCreated: true,
  TaskCompleted: true,
  Stop: true,
  StopFailure: true,
  TeammateIdle: true,
  ConfigChange: true,
  CwdChanged: true,
  DirectoryAdded: true,
  FileChanged: true,
  WorktreeCreate: true,
  WorktreeRemove: true,
  PreCompact: true,
  PostCompact: true,
  PreModelSwitch: true,
  PostModelSwitch: true,
  SessionEnd: true,
  Elicitation: true,
  ElicitationResult: true,
};

function isEventName(value: string): value is EventName {
  return Object.hasOwn(EVENT_NAMES, value);
}

function usage(executable: string): string {
  const width = Math.max(...commandNames().map((name) => name.length));
  const commands = COMMANDS.map(
    ([name, summary]) => `  ${name.padEnd(width)}  ${summary}\n`,
  ).join("");
  return (
    `Usage: ${executable} <command> [options]\n\n` +
    `Commands:\n${commands}\n` +
    "Options:\n" +
    "  -h, --help  Show this help message.\n"
  );
}

/**
 * Render a `HookassertError` the way a terminal and a CI log both read it.
 *
 * @remarks
 * The `code` leads, because that is the half a wrapper script may branch on;
 * the prose after it may be reworded in a patch release. Not scoped to
 * `UsageError`: `explain` can also fail with a load error (`ERR_SETTINGS_PARSE`,
 * `ERR_SETTINGS_NOT_FOUND`, `ERR_SPEC_SCHEMA`, `ERR_SPEC_NOT_FOUND`) when a
 * `--settings` file or the
 * shipped spec cannot be read, and both report through this same shape.
 */
function failureResult(error: HookassertError, executable: string): CliResult {
  return {
    exitCode: error.exitCode,
    stdout: "",
    stderr:
      `${executable}: ${error.code}: ${error.message}\n` +
      `Run \`${executable} --help\` for usage.\n`,
  };
}

/** The dependencies `explain`, `lint`, and `test` are threaded through, for injection in tests. */
export interface CliDeps {
  /** Directory `project` and `local` settings, and a relative `--settings <file>`, resolve against. */
  readonly cwd: string;

  /** Directory `user` settings resolve against. */
  readonly home: string;

  /**
   * Environment variables. `explain` and `lint` read only
   * {@link CLAUDE_VERSION_ENV_VAR} from it; `test` additionally uses it as
   * the base a spawned hook's own environment is built from (see
   * `buildHookEnv` in `src/internal/exec/executor.ts`) — never forwarded
   * wholesale, only the variables that end up allowlisted.
   */
  readonly env: Readonly<Record<string, string | undefined>>;

  /**
   * The command-execution seam. `explain` and `lint` accept it but never
   * call it — see `src/internal/exec/spawner.ts`'s own remark — so a
   * `CountingSpawner` injected here is how `tests/cli.test.ts` proves the
   * zero-spawn guarantee mechanically rather than by inspection. `test` is
   * the first command that actually calls it, both to run a fixture's hooks
   * and, through `NodeVersionProbe`, to run `claude --version`.
   */
  readonly spawner: Spawner;

  /**
   * Absolute path of the shipped hooks spec to load.
   *
   * @remarks
   * Defaults to the one spec file this package ships. Overridable so a test
   * can exercise a code path the real spec cannot reach on its own — for
   * example, `resolveDecision`'s `"event-not-in-spec"` `unknown` outcome,
   * which the real spec's complete `events` map never produces.
   */
  readonly specPath: string;

  /**
   * Whether `test`'s consent gate treats this run as interactive.
   *
   * @remarks
   * Defaults to `process.stdout.isTTY === true && process.stdin.isTTY ===
   * true` — never `process.env.CI`, which answers a different question ("is a
   * CI runner driving this process") than "can a human see and answer a
   * prompt right now." Both streams have to be terminals, because the prompt
   * is printed on one and read from the other. Overridable so a test can
   * exercise both branches of the consent gate without an actual terminal
   * attached.
   */
  readonly isTTY: boolean;

  /**
   * Prints `prompt` and asks the user to confirm, for `test`'s interactive
   * consent gate.
   *
   * @remarks
   * Only ever called when {@link CliDeps.isTTY} is `true` and neither
   * `--yes` nor `--ci` was given. Defaults to a real `node:readline/promises`
   * prompt reading from `process.stdin`; overridable so a test can approve or
   * decline deterministically without a real terminal.
   */
  readonly confirm: (prompt: string) => Promise<boolean>;
}

/** {@link CliDeps.confirm}'s real implementation: an interactive y/N prompt on the real terminal. */
async function realConfirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${prompt}\nProceed? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function resolveDeps(overrides: Partial<CliDeps>): CliDeps {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    home: overrides.home ?? homedir(),
    env: overrides.env ?? process.env,
    spawner: overrides.spawner ?? new NodeSpawner(),
    specPath: overrides.specPath ?? SPEC_PATH,
    // Both streams, not stdout alone: `realConfirm` reads the answer from
    // stdin, and a `question()` on a stdin already at EOF (`hookassert test
    // … < /dev/null`) never settles, hanging the run at the prompt. `=== true`
    // because `isTTY` is `undefined`, not `false`, on a non-terminal stream.
    isTTY: overrides.isTTY ?? (process.stdout.isTTY && process.stdin.isTTY),
    confirm: overrides.confirm ?? realConfirm,
  };
}

/**
 * Resolve the Claude Code version `explain` and `lint` run against, from the
 * first two steps of the full resolution order.
 *
 * @remarks
 * `--claude-version` beats {@link CLAUDE_VERSION_ENV_VAR}, which beats
 * `"undetermined"`. Deliberately no third step here: a `VersionProbe`
 * spawning `claude --version` would violate `explain`/`lint`'s own zero-spawn
 * guarantee. `resolveVersionContextForTest`, below, is `test`'s own wrapper
 * that adds the probe (and, once `record`'s own session bookkeeping ships, a
 * last-recorded-session fallback) as the two further steps only `test` is
 * allowed to take.
 *
 * An environment variable that is set but empty counts as absent, not as a
 * malformed version: `HOOKASSERT_CLAUDE_VERSION=` in a CI job, or an
 * `export HOOKASSERT_CLAUDE_VERSION="$(… || true)"` that produced nothing, is
 * the caller declaring the variable without a value, and must fall through to
 * `"undetermined"` rather than failing the run. `--claude-version ""` is still
 * an error: an explicitly passed flag was meant to carry a version.
 *
 * @throws {UsageError} `claudeVersionFlag` (or the environment variable, when
 * the flag is absent) is not a `major.minor.patch` string.
 */
function resolveVersionContext(
  claudeVersionFlag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): VersionContext {
  const fromEnv = env[CLAUDE_VERSION_ENV_VAR];
  const text =
    claudeVersionFlag ??
    (fromEnv === undefined || fromEnv === "" ? undefined : fromEnv);
  if (text === undefined) {
    return { kind: "undetermined" };
  }
  try {
    return { kind: "known", version: parseClaudeVersion(text) };
  } catch {
    // Naming the source matters: a stale environment variable otherwise
    // produces a usage error quoting a value the caller never typed.
    const source =
      claudeVersionFlag === undefined ? CLAUDE_VERSION_ENV_VAR : "--claude-version";
    throw new UsageError(
      `${source}: "${text}" is not a valid major.minor.patch Claude Code version.`,
    );
  }
}

/** `explain`'s own option table: `common` plus `--emit-fixtures`. */
const EXPLAIN_OPTIONS = {
  settings: { type: "string", multiple: true },
  "claude-version": { type: "string" },
  format: { type: "string" },
  "emit-fixtures": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

/**
 * `parseArgs({ strict: true })` throws on an unknown option, a missing
 * required value, or a value of the wrong type. Translated here into a
 * `UsageError` rather than letting the raw exception escape `runCli`.
 */
function runExplain(args: readonly string[], deps: CliDeps): CliResult {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: EXPLAIN_OPTIONS,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UsageError(`invalid options for explain: ${reason}`);
  }

  const [event, tool] = parsed.positionals;
  if (event === undefined) {
    throw new UsageError("explain requires an <event> argument.");
  }
  if (parsed.positionals.length > 2) {
    // Not cosmetic: `--settings a.json b.json` parses as one settings file
    // plus a stray positional, so silently dropping the extras would let
    // `b.json` become the matcher target and report a plausible — but
    // wrong — firing set at exit 0.
    throw new UsageError(
      `explain accepts at most <event> and [tool]; unexpected extra argument ` +
        `${JSON.stringify(parsed.positionals[2])}.`,
    );
  }
  if (!isEventName(event)) {
    throw new UsageError(
      `unrecognized event ${JSON.stringify(event)}. ` +
        `Expected one of the documented Claude Code hook events.`,
    );
  }

  if (parsed.values["emit-fixtures"] !== undefined) {
    throw new UsageError("the --emit-fixtures option is not implemented yet.");
  }

  // Validated here, before any I/O (version resolution, spec loading, the
  // --settings existence check, loadSettings): a typo'd --format must fail
  // as its own ERR_USAGE rather than surfacing as an unrelated I/O error
  // once rendering is finally reached. `renderInFormat` below still owns the
  // actual format-to-renderer selection, so that logic stays in one place.
  if (parsed.values.format !== undefined && !isReportFormat(parsed.values.format)) {
    throw new UsageError(
      `unrecognized --format ${JSON.stringify(parsed.values.format)}. ` +
        `Expected one of: pretty, json, github.`,
    );
  }

  const versionContext = resolveVersionContext(
    parsed.values["claude-version"],
    deps.env,
  );
  const spec = loadSpecFile(deps.specPath);

  const explicitSettings = parsed.values.settings;
  // The loader maps a missing settings file to zero hooks, which is right for
  // the three discovered layers and wrong for one the caller named: a typo
  // would otherwise print "Firing hooks: none" at exit 0. This is the only
  // layer that can tell the two apart.
  for (const file of explicitSettings ?? []) {
    const resolved = path.resolve(deps.cwd, file);
    if (!existsSync(resolved)) {
      throw new SettingsNotFoundError(resolved);
    }
  }
  const sources = discoverSources({
    cwd: deps.cwd,
    home: deps.home,
    ...(explicitSettings === undefined ? {} : { explicit: explicitSettings }),
  });
  const settings = loadSettings(sources);
  const hooks = hooksForEvent(settings, event);
  const match = matchHooks(spec, versionContext, { event, hooks, target: tool });

  const report: ExplainReport = {
    header: buildReportHeader(versionContext, spec.claudeCodeRange),
    event,
    target: tool,
    firing: match.firing,
    matcherIgnored: match.matcherIgnored,
    rejected: match.rejected,
  };

  const stdout = renderInFormat(report, parsed.values.format, {
    pretty: renderPretty,
    json: renderJson,
    github: renderGithub,
  });

  return { exitCode: 0, stdout, stderr: "" };
}

/**
 * `lint`'s own option table: `common` plus `--ci`, accepted and ignored —
 * `lint` has no `<event>`/`[tool]` positionals.
 */
const LINT_OPTIONS = {
  settings: { type: "string", multiple: true },
  "claude-version": { type: "string" },
  format: { type: "string" },
  ci: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

/**
 * `lint` is a zero-execution static check: it discovers settings the same
 * way `explain` does, runs every registered `LintRule` over them, and exits
 * `1` when any `Finding` was produced, `0` otherwise. `--ci` behaves
 * identically to a plain run — lint findings are binary (found or not),
 * unlike `test`'s three-way pass/fail/unknown, so there is no separate
 * `--ci` branch here the way `resolveTestExitCode` has one.
 *
 * @remarks
 * `--format` selects among `pretty`/`json`/`github` through the same
 * `renderInFormat` selector `explain`/`test` already use — `renderLintGithub`
 * takes `deps.cwd` as its workspace root, exactly as `runTest` passes
 * `deps.cwd` to `renderTestGithub`, so a `Finding.file` (always absolute)
 * renders relative to the repository checkout rather than as a raw
 * absolute path.
 *
 * @throws {UsageError} an option was malformed, a positional argument was
 * given, `--format` named an unrecognized format, or `--claude-version` was
 * not a valid `major.minor.patch` version.
 * (Also propagates every load-time error `loadSpecFile` can throw, and
 * `SettingsNotFoundError` for a named `--settings` file that does not
 * exist.)
 */
function runLint(args: readonly string[], deps: CliDeps): CliResult {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: LINT_OPTIONS,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UsageError(`invalid options for lint: ${reason}`);
  }

  if (parsed.positionals.length > 0) {
    throw new UsageError(
      `lint accepts no positional arguments; got ${JSON.stringify(parsed.positionals[0])}.`,
    );
  }

  // Validated here, before any I/O, per the same rule runExplain follows.
  if (parsed.values.format !== undefined && !isReportFormat(parsed.values.format)) {
    throw new UsageError(
      `unrecognized --format ${JSON.stringify(parsed.values.format)}. ` +
        `Expected one of: pretty, json, github.`,
    );
  }

  const versionContext = resolveVersionContext(
    parsed.values["claude-version"],
    deps.env,
  );
  const spec = loadSpecFile(deps.specPath);

  const explicitSettings = parsed.values.settings;
  // Same rationale as runExplain: a settings file the caller named
  // explicitly is an assertion it exists, unlike a discovered layer.
  for (const file of explicitSettings ?? []) {
    const resolved = path.resolve(deps.cwd, file);
    if (!existsSync(resolved)) {
      throw new SettingsNotFoundError(resolved);
    }
  }
  const sources = discoverSources({
    cwd: deps.cwd,
    home: deps.home,
    ...(explicitSettings === undefined ? {} : { explicit: explicitSettings }),
  });

  const ctx = buildLintContext(sources, spec, versionContext);
  const findings = LINT_RULES.flatMap((rule) => rule.run(ctx));

  const report: LintReport = {
    header: buildReportHeader(versionContext, spec.claudeCodeRange),
    findings,
  };

  const stdout = renderInFormat(report, parsed.values.format, {
    pretty: renderLintPretty,
    json: renderLintJson,
    github: (r: LintReport) => renderLintGithub(r, deps.cwd),
  });

  return { exitCode: findings.length > 0 ? 1 : 0, stdout, stderr: "" };
}

/**
 * `record`'s own option table.
 *
 * @remarks
 * No `settings`/`format`/`ci` here: unlike `explain`/`lint`/`test`, `record`
 * neither reads the merged settings tree as a firing-set question nor
 * renders a `Report` — it edits exactly one settings file
 * (`.claude/settings.local.json`) and prints a short status line. `--stop`
 * takes no option beyond `--stop` itself; `runRecord` rejects any of the
 * other three alongside it.
 */
const RECORD_OPTIONS = {
  stop: { type: "boolean" },
  events: { type: "string" },
  "capture-dir": { type: "string" },
  "claude-version": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

/**
 * `record` (without `--stop`): insert the capture hook for every requested
 * event, and report where.
 *
 * @remarks
 * The version baked into the generated capture script is resolved through
 * {@link resolveVersionContext} — the same `--claude-version` beats
 * {@link CLAUDE_VERSION_ENV_VAR} precedence `explain`/`lint` use — so
 * `HOOKASSERT_CLAUDE_VERSION` set in the environment is honored here too,
 * not just an explicit flag.
 *
 * @throws {UsageError} `--claude-version` (or {@link CLAUDE_VERSION_ENV_VAR})
 * was not a valid `major.minor.patch` string, `--events` named an
 * unrecognized event, or a session is already active.
 * (Also propagates every load-time error `loadSpecFile` can throw, and every
 * error `startRecordSession` can throw.)
 */
function runRecordStart(
  parsed: ReturnType<typeof parseArgsForRecord>,
  deps: CliDeps,
): CliResult {
  const versionContext = resolveVersionContext(
    parsed.values["claude-version"],
    deps.env,
  );

  if (isRecordSessionActive(deps.cwd)) {
    throw new UsageError(
      "a recording session is already active. Run `record --stop` first, or use a " +
        "different project directory.",
    );
  }

  const spec = loadSpecFile(deps.specPath);

  let events: EventName[];
  const eventsFlag = parsed.values.events;
  if (eventsFlag === undefined) {
    events = Object.keys(spec.events).filter(isEventName);
  } else {
    // Deduped: `--events PreToolUse,PreToolUse` must insert exactly one
    // matcher group per event, not one per (possibly repeated) mention.
    const requested = [
      ...new Set(
        eventsFlag
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0),
      ),
    ];
    if (requested.length === 0) {
      throw new UsageError("--events must name at least one event.");
    }
    events = requested.map((name) => {
      if (!isEventName(name)) {
        throw new UsageError(
          `unrecognized event ${JSON.stringify(name)} in --events. ` +
            `Expected one of the documented Claude Code hook events.`,
        );
      }
      return name;
    });
  }

  const info = startRecordSession({
    cwd: deps.cwd,
    events,
    matcherForEvent: (event) =>
      spec.events[event]?.matcherTargets.kind === "none" ? undefined : "*",
    captureDir: parsed.values["capture-dir"],
    claudeVersionFlag:
      versionContext.kind === "known" ? formatClaudeVersion(versionContext) : undefined,
  });

  const stdout =
    `Recording started: capture hook inserted into ${info.settingsFile}` +
    `${info.createdFresh ? " (file created)" : ""}.\n` +
    `Capturing events: ${info.events.join(", ")}\n` +
    `Capture directory: ${info.captureDir}\n` +
    `Run \`hookassert record --stop\` when you are done recording.\n`;

  return { exitCode: 0, stdout, stderr: "" };
}

/** `parseArgs({strict:true})` result shape for `RECORD_OPTIONS`, named so both halves of `runRecord` can share it. */
function parseArgsForRecord(args: readonly string[]) {
  return parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: RECORD_OPTIONS,
  });
}

/**
 * `record`: insert (or, with `--stop`, remove and verify) the capture hook
 * `record/session.ts` manages.
 *
 * @throws {UsageError} an option was malformed, or a positional argument was
 * given.
 * (Also propagates every error `runRecordStart`/`stopRecordSession` can
 * throw — see those functions' own documentation.)
 */
function runRecord(args: readonly string[], deps: CliDeps): CliResult {
  let parsed;
  try {
    parsed = parseArgsForRecord(args);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UsageError(`invalid options for record: ${reason}`);
  }

  if (parsed.positionals.length > 0) {
    throw new UsageError(
      `record accepts no positional arguments; got ${JSON.stringify(parsed.positionals[0])}.`,
    );
  }

  if (parsed.values.stop === true) {
    if (
      parsed.values.events !== undefined ||
      parsed.values["capture-dir"] !== undefined ||
      parsed.values["claude-version"] !== undefined
    ) {
      throw new UsageError("record --stop takes no option other than --stop itself.");
    }
    const result = stopRecordSession(deps.cwd);
    return {
      exitCode: 0,
      stdout:
        `Recording stopped: ${result.settingsFile} restored to its pre-recording ` +
        "state (zero diff).\n",
      stderr: "",
    };
  }

  return runRecordStart(parsed, deps);
}

/** `test`'s own option table: `common` plus consent, timing, and execution controls. */
const TEST_OPTIONS = {
  settings: { type: "string", multiple: true },
  "claude-version": { type: "string" },
  format: { type: "string" },
  yes: { type: "boolean" },
  ci: { type: "boolean" },
  "dry-run": { type: "boolean" },
  timeout: { type: "string" },
  env: { type: "string", multiple: true },
  help: { type: "boolean", short: "h" },
} as const;

/**
 * Resolve the Claude Code version a `test` run should assume, from this
 * issue's full four-step order.
 *
 * @remarks
 * `--claude-version` and {@link CLAUDE_VERSION_ENV_VAR} are resolved exactly
 * as {@link resolveVersionContext} already does for `explain`/`lint`
 * (including its `UsageError` on an invalid value); `probe.detect()` is
 * tried only when both of those came back empty, and "last recorded
 * session's version" — the step between the probe and `"undetermined"` — is
 * a documented no-op until `record`'s own session bookkeeping (`#15`) ships:
 * there is nothing to read yet, so this always falls through past it.
 *
 * @throws {UsageError} `claudeVersionFlag` (or the environment variable, when
 * the flag is absent) is not a `major.minor.patch` string.
 */
async function resolveVersionContextForTest(
  claudeVersionFlag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  probe: VersionProbe,
): Promise<VersionContext> {
  const direct = resolveVersionContext(claudeVersionFlag, env);
  if (direct.kind === "known") {
    return direct;
  }
  const probed = await probe.detect();
  if (probed !== undefined) {
    return { kind: "known", version: probed };
  }
  return { kind: "undetermined" };
}

/**
 * Parse `--timeout`'s value into a positive millisecond count.
 *
 * @throws {UsageError} `value` is defined but not a positive finite number.
 */
function parseTimeoutOption(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageError(
      `--timeout must be a positive number of milliseconds, got ${JSON.stringify(value)}.`,
    );
  }
  return parsed;
}

/**
 * The candidate hooks a fixture case's matcher request considers, and every
 * hook this issue's `settings:` filter excluded before the matcher ever saw
 * them.
 *
 * @remarks
 * `fileSettings.length === 0` (the fixture declares no `settings:` list, the
 * common case) means "no restriction": every hook `hooksForEvent` returns is
 * a candidate, and nothing is excluded. A non-empty list restricts candidates
 * to hooks declared in one of the named files — resolved against `cwd`, the
 * same base `--settings` itself resolves against — and reports every other
 * hook under this event as {@link CaseObservation.excludedHooks}.
 */
function includedHooksForCase(
  discovered: readonly ResolvedHook[],
  fileSettings: readonly string[],
  cwd: string,
): {
  readonly candidates: readonly ResolvedHook[];
  readonly excludedHooks: readonly ResolvedHook[];
} {
  if (fileSettings.length === 0) {
    return { candidates: discovered, excludedHooks: [] };
  }
  const included = new Set(fileSettings.map((entry) => path.resolve(cwd, entry)));
  const candidates = discovered.filter((hook) => included.has(hook.provenance.file));
  const excludedHooks = discovered.filter(
    (hook) => !included.has(hook.provenance.file),
  );
  return { candidates, excludedHooks };
}

/**
 * Whether `caseData` should never enter the spawn plan at all: a `dryRun`
 * case (`--dry-run` is already folded into every case's own `dryRun` by the
 * time this is asked), or a case that declares only stubs and nothing to
 * assert.
 *
 * @remarks
 * Both halves are `assertCase`'s own verdict, borrowed rather than restated:
 * a case this returns `true` for is exactly one `assertCase` reports as
 * `"skipped"`. Reimplementing the stub-only test here — it reads every field
 * of `FixtureExpectation` — is what would let the two drift the next time a
 * field is added to that interface, leaving a case the plan spawns for and
 * the assert engine then skips.
 */
function isPreSkipped(caseData: FixtureCase): boolean {
  return caseData.dryRun === true || isStubOnly(caseData);
}

/**
 * Whether any case across `fixtureSet` could possibly enter the spawn plan —
 * decided from the fixtures alone, before settings are discovered, hooks are
 * matched, or the version is resolved.
 *
 * @remarks
 * A conservative (never a false negative) approximation of "will `spawnWorthy`
 * end up non-empty": it is exactly {@link isPreSkipped}'s own verdict, which
 * is unaffected by which hooks actually end up matched, so a case this
 * returns `true` for may still resolve to zero real steps later (no hook
 * configured for its event, every firing hook individually stubbed). It can
 * never return `false` for a case that does end up spawning, which is what
 * lets `runTest` use it to gate consent before anything downstream of the
 * fixtures has run at all.
 */
function hasSpawnableCase(fixtureSet: FixtureSet, dryRunFlag: boolean): boolean {
  if (dryRunFlag) {
    // Folded into every case's own `dryRun` before `isPreSkipped` is asked
    // (see the per-case fold in `runTest`'s loop) — so none of them can spawn.
    return false;
  }
  return fixtureSet.files.some(({ file }) =>
    file.cases.some((caseData) => !isPreSkipped(caseData)),
  );
}

/** Resolve one case's working-directory override to an absolute path, or `undefined` to use the run's own project root. */
function resolveStepCwd(
  caseData: FixtureCase,
  file: FixtureFile,
  cwd: string,
): string | undefined {
  const raw = caseData.cwd ?? file.defaults?.cwd;
  return raw === undefined ? undefined : path.resolve(cwd, raw);
}

/**
 * Build the `ExecDeps` one fixture file's steps run against.
 *
 * @remarks
 * `file.defaults.env`'s declared values are merged into the effective
 * process environment and their own keys added to the allowlist: unlike
 * `--env <NAME>`, which opts an *ambient* variable in by name, a fixture's
 * own `defaults.env` supplies its values directly, so declaring one there is
 * itself "explicitly requesting it" for `buildHookEnv`'s credential-shape
 * exception. `file.defaults.timeoutMs`, when the file declares one, takes
 * precedence over `--timeout` for that file's own hooks — a fixture's own
 * explicit default is more specific than a run-wide override — which in turn
 * takes precedence over `HOOKASSERT_DEFAULT_TIMEOUT_MS`.
 *
 * `explicitDefaultTimeoutMs` is set from `cliTimeoutOverrideMs` only when no
 * `file.defaults.timeoutMs` applies: `--timeout` is what the design calls "an
 * override for the whole run", so it must actually win over
 * `resolveDefaultTimeoutMs`'s ceiling rather than being silently clamped by
 * it — see `executor.ts`'s own remark on `ExecDeps.explicitDefaultTimeoutMs`.
 * A file's own declared default stays subject to that ceiling, unchanged.
 */
function buildExecDepsForFile(
  deps: CliDeps,
  file: FixtureFile,
  spec: Spec,
  cliTimeoutOverrideMs: number | undefined,
  cliEnvNames: readonly string[],
): ExecDeps {
  const fileEnv = file.defaults?.env ?? {};
  const fileTimeoutMs = file.defaults?.timeoutMs;
  return {
    spawner: deps.spawner,
    projectRoot: deps.cwd,
    processEnv: { ...deps.env, ...fileEnv },
    providedEnvKeys: spec.hookEnv.provided,
    allowedEnvKeys: [...cliEnvNames, ...Object.keys(fileEnv)],
    hookassertDefaultTimeoutMs:
      fileTimeoutMs ?? cliTimeoutOverrideMs ?? HOOKASSERT_DEFAULT_TIMEOUT_MS,
    specDefaultTimeoutMs: spec.defaults.hookTimeoutMs,
    ...(fileTimeoutMs === undefined && cliTimeoutOverrideMs !== undefined
      ? { explicitDefaultTimeoutMs: cliTimeoutOverrideMs }
      : {}),
  };
}

/** One command a step would actually spawn, described for a human at the consent prompt. */
function describeStepForConsent(step: ExecutionStep): string {
  const form = step.hook.args === undefined ? "shell" : "exec";
  // Quoted, not bare-joined: this line is the whole basis for the answer the
  // user gives, so an argument containing a space, a quote or a newline must
  // not read as two arguments, or as an early end to the command list.
  const args =
    step.hook.args === undefined
      ? ""
      : ` ${step.hook.args.map(quoteForConsent).join(" ")}`;
  return `  [${form}] ${quoteForConsent(step.hook.command)}${args}`;
}

/** Render one command word for the consent prompt, quoting it when it is not a single plain word. */
function quoteForConsent(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : JSON.stringify(word);
}

/**
 * Whether `test`'s consent gate is answerable at all for this invocation —
 * checked before anything downstream of the fixtures runs, so a run that
 * cannot possibly obtain consent fails before it spawns even the version
 * probe.
 *
 * @remarks
 * This is the "is there anyone to ask, or was consent already given" half of
 * the gate: it takes only `isTTY`, `yes`, and `ci` — never the firing set,
 * the spec, or the resolved `ClaudeVersion`, none of which is known yet this
 * early in `runTest`. The other half — "does this human approve this
 * specific command list" — is {@link gateConsent}, which runs later, once
 * the firing set is known, and only for a TTY (this function has already
 * ruled out every non-interactive, non-consenting case by the time that
 * runs).
 *
 * `runTest` calls this only when {@link hasSpawnableCase} says the run could
 * spawn something at all — a fixture that is entirely `--dry-run` or
 * stub-only never needs consent, interactive or not.
 *
 * @throws {ConsentRequiredError} the invocation is non-interactive and
 * neither `--yes` nor `--ci` was given.
 */
function assertConsentReachable(isTTY: boolean, yes: boolean, ci: boolean): void {
  if (isTTY || yes || ci) {
    return;
  }
  throw new ConsentRequiredError(
    "test needs consent to spawn the hooks its fixtures would run, but is " +
      "running non-interactively without --yes or --ci. Pass --yes to consent, " +
      "--ci for a non-interactive CI run, or run in a terminal to confirm interactively.",
  );
}

/**
 * Obtain a human's approval of `spawnWorthy`'s exact command list before
 * `test` runs a single one of them.
 *
 * @remarks
 * A step whose own `stub` bypasses the spawner never reaches `spawnWorthy` in
 * the first place — see `runTest`'s own filter — so an empty `spawnWorthy`
 * means nothing will actually run, and nothing needs consenting to: this
 * function returns immediately, without checking `yes` or `ci` at all.
 * `--yes` and `--ci` both bypass the prompt outright, in that order of
 * appearance below (either is sufficient). Otherwise this prints the full
 * command list and awaits {@link CliDeps.confirm}'s answer — by the time this
 * runs, {@link assertConsentReachable} has already rejected every
 * non-interactive invocation that lacked `--yes`/`--ci`, so a non-empty
 * `spawnWorthy` reaching here is always on a TTY.
 *
 * @throws {ConsentRequiredError} the interactive prompt was declined.
 */
async function gateConsent(
  deps: Pick<CliDeps, "confirm">,
  yes: boolean,
  ci: boolean,
  spawnWorthy: readonly ExecutionStep[],
): Promise<void> {
  if (spawnWorthy.length === 0 || yes || ci) {
    return;
  }

  const commandList = spawnWorthy.map(describeStepForConsent).join("\n");
  const prompt = `About to run ${String(spawnWorthy.length)} command(s):\n${commandList}`;
  const approved = await deps.confirm(prompt);
  if (!approved) {
    throw new ConsentRequiredError(
      "test needs consent to spawn the hooks its fixtures would run, and consent " +
        "was declined at the interactive prompt.",
    );
  }
}

/** Exit-code precedence for `test`, computed once from `Summary`'s counts. */
function resolveTestExitCode(
  summary: { readonly failed: number; readonly unknown: number },
  ci: boolean,
): number {
  if (summary.failed > 0) {
    return 1;
  }
  if (ci && summary.unknown > 0) {
    return 3;
  }
  return 0;
}

/** One fixture case, prepared for execution: its matcher result and (once assigned) its authoritative step. */
interface PreparedCase {
  readonly fixturePath: string;
  readonly index: number;
  readonly caseData: FixtureCase;
  /**
   * The step whose outcome this case's `Decision` is built from — the first
   * hook the matcher resolved as firing, in `ResolvedHook` order — or
   * `undefined` when the case was pre-skipped or nothing fired for it.
   *
   * @remarks
   * When more than one hook fires for the same case, every one of them is
   * still spawned (a real Claude Code session would run them all), but only
   * this first one is read back for the case's own pass/fail/unknown
   * verdict — `CaseObservation` carries a single `decision`, not one per
   * firing hook.
   */
  readonly firstStep: ExecutionStep | undefined;
  readonly rejectedByMatcher: readonly MatcherOutcome[];
  readonly excludedHooks: readonly ResolvedHook[];
}

/** One fixture file's execution plan, kept alongside the `ExecDeps` it runs against. */
interface FilePlan {
  readonly fixturePath: string;
  readonly execDeps: ExecDeps;
  readonly steps: ExecutionStep[];
  readonly assertedEvents: Set<EventName>;
}

/**
 * `test`'s own option table's positionals require at least one `<fixture>`
 * path; parses and validates every other option, then wires the full
 * pipeline this issue's design section names end to end.
 *
 * @throws {UsageError} an option was malformed, no `<fixture>` was given, or
 * `--format`/`--timeout` was given an invalid value.
 * @throws {ConsentRequiredError} consent to spawn was not obtained.
 * (Also propagates every load-time error `loadSpecFile`/`loadFixtures` can
 * throw — see those modules' own documentation.)
 */
async function runTest(args: readonly string[], deps: CliDeps): Promise<CliResult> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: TEST_OPTIONS,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UsageError(`invalid options for test: ${reason}`);
  }

  if (parsed.positionals.length === 0) {
    throw new UsageError("test requires at least one <fixture> argument.");
  }

  // Validated before any I/O, per the same rule runExplain follows.
  if (parsed.values.format !== undefined && !isReportFormat(parsed.values.format)) {
    throw new UsageError(
      `unrecognized --format ${JSON.stringify(parsed.values.format)}. ` +
        `Expected one of: pretty, json, github.`,
    );
  }
  const timeoutOverrideMs = parseTimeoutOption(parsed.values.timeout);

  const explicitSettings = parsed.values.settings;
  for (const file of explicitSettings ?? []) {
    const resolved = path.resolve(deps.cwd, file);
    if (!existsSync(resolved)) {
      throw new SettingsNotFoundError(resolved);
    }
  }

  const dryRunFlag = parsed.values["dry-run"] === true;

  const spec = loadSpecFile(deps.specPath);

  const fixturePaths = parsed.positionals.map((fixture) =>
    path.resolve(deps.cwd, fixture),
  );
  const fixtureSet = loadFixtures(fixturePaths, spec);

  // Before the probe, not after: a non-interactive invocation without
  // `--yes`/`--ci` must fail without spawning anything at all, including
  // `NodeVersionProbe`'s own `claude --version` — issue #11's own acceptance
  // criterion. `hasSpawnableCase` is decided from the fixtures alone, so a
  // fixture that is entirely `--dry-run` or stub-only never needs consent.
  if (hasSpawnableCase(fixtureSet, dryRunFlag)) {
    assertConsentReachable(
      deps.isTTY,
      parsed.values.yes === true,
      parsed.values.ci === true,
    );
  }

  const probe = new NodeVersionProbe(deps.spawner, deps.cwd, deps.env);
  const versionContext = await resolveVersionContextForTest(
    parsed.values["claude-version"],
    deps.env,
    probe,
  );

  const discoveredSources = discoverSources({
    cwd: deps.cwd,
    home: deps.home,
    ...(explicitSettings === undefined ? {} : { explicit: explicitSettings }),
  });
  const discoveredSettings = loadSettings(discoveredSources);
  const cliEnvNames = parsed.values.env ?? [];

  const prepared: PreparedCase[] = [];
  const filePlans: FilePlan[] = [];

  for (const { path: fixturePath, file } of fixtureSet.files) {
    const execDeps = buildExecDepsForFile(
      deps,
      file,
      spec,
      timeoutOverrideMs,
      cliEnvNames,
    );
    const filePlan: FilePlan = {
      fixturePath,
      execDeps,
      steps: [],
      assertedEvents: new Set<EventName>(),
    };
    filePlans.push(filePlan);

    file.cases.forEach((rawCaseData, index) => {
      filePlan.assertedEvents.add(rawCaseData.event);

      const { candidates, excludedHooks } = includedHooksForCase(
        hooksForEvent(discoveredSettings, rawCaseData.event),
        file.settings,
        deps.cwd,
      );
      const match = matchHooks(spec, versionContext, {
        event: rawCaseData.event,
        hooks: candidates,
        target: rawCaseData.tool,
      });

      // `--dry-run` applies to the whole run, but `assertCase` only ever
      // reads a case's own `dryRun` field — folding the flag into a copy
      // here is what makes its "skipped"/"dry-run" verdict (not merely the
      // absence of spawned steps below) hold for every case when the flag
      // is set, without assertCase needing to know about a CLI flag at all.
      const caseData: FixtureCase =
        dryRunFlag && rawCaseData.dryRun !== true
          ? { ...rawCaseData, dryRun: true }
          : rawCaseData;

      let firstStep: ExecutionStep | undefined;
      if (!isPreSkipped(caseData)) {
        match.firing.forEach((hook, hookIndex) => {
          const step: ExecutionStep = {
            event: caseData.event,
            hook,
            stdin: JSON.stringify(caseData.input ?? null),
            cwd: resolveStepCwd(caseData, file, deps.cwd),
            stub: caseData.stub?.[hook.command],
          };
          filePlan.steps.push(step);
          if (hookIndex === 0) {
            firstStep = step;
          }
        });
      }

      prepared.push({
        fixturePath,
        index,
        caseData,
        firstStep,
        rejectedByMatcher: match.rejected,
        excludedHooks,
      });
    });
  }

  const spawnWorthy = filePlans.flatMap((plan) =>
    plan.steps.filter((step) => step.stub === undefined),
  );
  await gateConsent(
    deps,
    parsed.values.yes === true,
    parsed.values.ci === true,
    spawnWorthy,
  );

  // Sequential, not `Promise.all`: each `executeHooks` call runs its own
  // concurrency-capped worker pool (see `executor.ts`'s
  // `HOOKASSERT_DEFAULT_CONCURRENCY`), so running the files in parallel here
  // would let N fixture files spawn N independent pools at once — the exact
  // fan-out issue #40 caps against. A `for…of` with `await` keeps at most one
  // pool in flight per run while preserving the per-file result order the
  // rest of `runTest` relies on.
  const executed: (readonly ExecutionResult[])[] = [];
  for (const plan of filePlans) {
    const executionPlan: ExecutionPlan = {
      steps: plan.steps,
      assertedEvents: plan.assertedEvents,
    };
    executed.push(await executeHooks(plan.execDeps, executionPlan));
  }

  const outcomesByStep = new Map<ExecutionStep, ExecOutcome>();
  for (const results of executed) {
    for (const { step, outcome } of results) {
      outcomesByStep.set(step, outcome);
    }
  }

  const caseReports: TestCaseReport[] = [];
  const caseResults: CaseResult[] = [];
  for (const p of prepared) {
    const outcome =
      p.firstStep === undefined ? undefined : outcomesByStep.get(p.firstStep);
    const decision =
      outcome === undefined
        ? undefined
        : resolveDecision(spec, p.caseData.event, outcome);
    const observation: CaseObservation = {
      decision,
      execOutcome: outcome,
      rejectedByMatcher: p.rejectedByMatcher,
      excludedHooks: p.excludedHooks,
    };
    const result = assertCase(p.caseData, observation);
    caseResults.push(result);
    caseReports.push({
      file: p.fixturePath,
      index: p.index,
      event: p.caseData.event,
      tool: p.caseData.tool,
      result,
    });
  }

  const summary = summarize(caseResults);
  const report: TestReport = {
    header: buildReportHeader(versionContext, spec.claudeCodeRange),
    cases: caseReports,
    summary,
  };

  const stdout = renderInFormat(report, parsed.values.format, {
    pretty: renderTestPretty,
    json: renderTestJson,
    github: (r: TestReport) => renderTestGithub(r, deps.cwd),
  });

  return {
    exitCode: resolveTestExitCode(summary, parsed.values.ci === true),
    stdout,
    stderr: "",
  };
}

/**
 * Run the package command without coupling its behavior to process globals.
 *
 * @remarks
 * Async because `test` — unlike `explain` — genuinely spawns processes
 * (fixture hooks, and `NodeVersionProbe`'s own `claude --version`) and awaits
 * their results; `explain`'s own branch stays a plain synchronous call,
 * simply returned from this `async` function like any other value.
 *
 * @param argv Arguments after the executable name.
 * @param executable Name or path shown in the usage line.
 * @param deps Dependencies to override; anything omitted falls back to the
 * live process (`process.cwd()`, `os.homedir()`, `process.env`) or, for
 * `spawner`, the real `NodeSpawner` — see `src/internal/exec/spawner.ts`.
 * @returns The process result a caller should observe.
 */
export async function runCli(
  argv: readonly string[],
  executable = "hookassert",
  deps: Partial<CliDeps> = {},
): Promise<CliResult> {
  const [subcommand] = argv;
  if (subcommand === undefined || argv.includes("--help") || argv.includes("-h")) {
    return { exitCode: 0, stdout: usage(executable), stderr: "" };
  }

  if (!isSubcommand(subcommand)) {
    return failureResult(
      new UsageError(
        `unknown command ${JSON.stringify(subcommand)}. ` +
          `Expected one of: ${commandNames().join(", ")}.`,
      ),
      executable,
    );
  }

  const rest = argv.slice(1);

  try {
    switch (subcommand) {
      case "explain":
        return runExplain(rest, resolveDeps(deps));
      case "lint":
        return runLint(rest, resolveDeps(deps));
      case "test":
        return await runTest(rest, resolveDeps(deps));
      case "record":
        return runRecord(rest, resolveDeps(deps));
    }
  } catch (error) {
    if (error instanceof HookassertError) {
      return failureResult(error, executable);
    }
    throw error;
  }
}

function canonicalize(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    // A path that does not resolve is not a reason to crash before the command
    // has said anything; compared raw, it simply fails to match.
    return path.resolve(target);
  }
}

/**
 * Whether `moduleUrl` names the module Node was started with.
 *
 * @remarks
 * `realpathSync` is what makes this survive installation: npm links a `bin`
 * into `node_modules/.bin` as a symlink, so the entry path and the module's own
 * path only agree once both are resolved.
 *
 * Exported for the same reason as {@link main} — see there.
 */
export function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return (
    entry !== undefined &&
    canonicalize(entry) === canonicalize(fileURLToPath(moduleUrl))
  );
}

/**
 * Run the command against the current process and report its exit code.
 *
 * @remarks
 * This is the seam between {@link runCli}, which is pure, and the process it
 * writes to. It is exported so a test can drive it in-process: the packaging
 * smoke test does run the installed command, but in a child process, where
 * coverage cannot see it and a regression here would surface only as a `bin`
 * that silently prints nothing.
 *
 * @param argv Arguments after the executable name.
 * @returns The exit code the caller should set on the process.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const result = await runCli(argv);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.exitCode;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
