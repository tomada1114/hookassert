#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  HookassertError,
  SettingsNotFoundError,
  UsageError,
} from "./internal/errors.js";
import { matchHooks, type VersionContext } from "./internal/matcher/index.js";
import {
  buildReportHeader,
  isReportFormat,
  renderGithub,
  renderInFormat,
  renderJson,
  renderPretty,
  type ExplainReport,
} from "./internal/report/index.js";
import {
  discoverSources,
  hooksForEvent,
  loadSettings,
} from "./internal/settings/index.js";
import { loadSpecFile, parseClaudeVersion } from "./internal/spec/index.js";
import { createUnimplementedSpawner, type Spawner } from "./internal/exec/spawner.js";
import type { EventName } from "./types.js";

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
 * `explain` is the first of the four with real behavior, wired in by this
 * issue. `lint`, `record`, and `test` are still stubs: naming all four here
 * anyway is what makes the usage text and the "unknown command" message
 * agree with each other, and with the routing that replaces each stub once
 * its own issue lands.
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

/** The dependencies `explain` and `lint` are threaded through, for injection in tests. */
export interface CliDeps {
  /** Directory `project` and `local` settings, and a relative `--settings <file>`, resolve against. */
  readonly cwd: string;

  /** Directory `user` settings resolve against. */
  readonly home: string;

  /** Environment variables, read only for {@link CLAUDE_VERSION_ENV_VAR}. */
  readonly env: Readonly<Record<string, string | undefined>>;

  /**
   * The command-execution seam. `explain` and `lint` accept it but never
   * call it — see `src/internal/exec/spawner.ts`'s own remark — so a
   * `CountingSpawner` injected here is how `tests/cli.test.ts` proves the
   * zero-spawn guarantee mechanically rather than by inspection.
   */
  readonly spawner: Spawner;
}

function resolveDeps(overrides: Partial<CliDeps>): CliDeps {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    home: overrides.home ?? homedir(),
    env: overrides.env ?? process.env,
    spawner: overrides.spawner ?? createUnimplementedSpawner(),
  };
}

/**
 * Resolve the Claude Code version `explain` and `lint` run against, from the
 * two-step order this issue implements.
 *
 * @remarks
 * `--claude-version` beats {@link CLAUDE_VERSION_ENV_VAR}, which beats
 * `"undetermined"`. Deliberately no third step: a `VersionProbe` spawning
 * `claude --version`, and a fallback to the last `record` session's
 * recorded version, are both `#11`'s work, and adding either here would spawn
 * a process from a command whose whole point is guaranteeing it never does.
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
  const spec = loadSpecFile(SPEC_PATH);

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
 * Run the package command without coupling its behavior to process globals.
 *
 * @param argv Arguments after the executable name.
 * @param executable Name or path shown in the usage line.
 * @param deps Dependencies to override; anything omitted falls back to the
 * live process (`process.cwd()`, `os.homedir()`, `process.env`) or, for
 * `spawner`, a placeholder that rejects every call — see
 * `src/internal/exec/spawner.ts`.
 * @returns The process result a caller should observe.
 */
export function runCli(
  argv: readonly string[],
  executable = "hookassert",
  deps: Partial<CliDeps> = {},
): CliResult {
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
      case "record":
      case "test":
        // A recognised command with no implementation behind it is still a
        // usage error: fabricating partial behavior would make the gap
        // invisible to the issue that is supposed to close it.
        throw new UsageError(
          `the ${JSON.stringify(subcommand)} command is not implemented yet.`,
        );
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
export function main(argv: readonly string[]): number {
  const result = runCli(argv);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.exitCode;
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
