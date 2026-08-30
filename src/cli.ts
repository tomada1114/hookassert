#!/usr/bin/env node

import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { UsageError } from "./internal/errors.js";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * The commands hookassert ships, with the one-line summary each gets in the
 * usage text.
 *
 * @remarks
 * None of them has behavior yet. Naming all four here anyway is what makes the
 * usage text and the "unknown command" message agree with each other, and with
 * the routing that replaces this dispatch once the first command lands.
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
 * Render a usage error the way a terminal and a CI log both read it.
 *
 * @remarks
 * The `code` leads, because that is the half a wrapper script may branch on;
 * the prose after it may be reworded in a patch release.
 */
function usageFailure(error: UsageError, executable: string): CliResult {
  return {
    exitCode: error.exitCode,
    stdout: "",
    stderr:
      `${executable}: ${error.code}: ${error.message}\n` +
      `Run \`${executable} --help\` for usage.\n`,
  };
}

/**
 * Run the package command without coupling its behavior to process globals.
 *
 * @param argv Arguments after the executable name.
 * @param executable Name or path shown in the usage line.
 * @returns The process result a caller should observe.
 */
export function runCli(argv: readonly string[], executable = "hookassert"): CliResult {
  const [subcommand] = argv;
  if (subcommand === undefined || argv.includes("--help") || argv.includes("-h")) {
    return { exitCode: 0, stdout: usage(executable), stderr: "" };
  }

  if (!isSubcommand(subcommand)) {
    return usageFailure(
      new UsageError(
        `unknown command ${JSON.stringify(subcommand)}. ` +
          `Expected one of: ${commandNames().join(", ")}.`,
      ),
      executable,
    );
  }

  // A recognised command with no implementation behind it is still a usage
  // error: fabricating partial behavior would make the gap invisible to the
  // issue that is supposed to close it.
  return usageFailure(
    new UsageError(`the ${JSON.stringify(subcommand)} command is not implemented yet.`),
    executable,
  );
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
