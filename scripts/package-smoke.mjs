#!/usr/bin/env node
// Build and pack once on the development runtime, then delegate the consumer
// checks to smoke-package.mjs. Passing --pack-dir or --tarball skips preparation
// so a CI compatibility leg can consume an artifact on a lower Node version.
import { spawnSync } from "node:child_process";
import console from "node:console";
import process from "node:process";

import { isMain } from "./lib/is-main.mjs";
import { repoRoot } from "./lib/node-tools.mjs";

const PACK_DIRECTORY = ".smoke";
const USAGE = `Usage: pnpm run package:smoke [-- --pack-dir <dir> | --tarball <file>]

With no artifact option, builds and packs into .smoke before running the
consumer smoke test. An existing pack directory or tarball is consumed as-is.

Exit codes:
  0  the package smoke test passed
  1  preparation or the consumer smoke test failed
  2  the arguments were wrong`;

/** Error with a stable code and an actionable message. */
export class PackageSmokeError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "PackageSmokeError";
    this.code = code;
  }
}

/**
 * @typedef {(command: string, args: readonly string[]) => number} CommandRunner
 */

/**
 * Parse the optional existing-artifact mode.
 *
 * @param {readonly string[]} argv
 * @returns {{packDir?: string, tarball?: string}}
 */
export function parseArguments(argv) {
  /** @type {string | undefined} */
  let packDir;
  /** @type {string | undefined} */
  let tarball;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--") {
      continue;
    }
    if (flag !== "--pack-dir" && flag !== "--tarball") {
      throw new PackageSmokeError(
        "ERR_PACKAGE_SMOKE_ARGUMENT",
        `unknown option: ${String(flag)}\n\n${USAGE}`,
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new PackageSmokeError(
        "ERR_PACKAGE_SMOKE_ARGUMENT",
        `${flag} requires a value.\n\n${USAGE}`,
      );
    }
    if (flag === "--pack-dir") {
      if (packDir !== undefined || tarball !== undefined) {
        throw new PackageSmokeError(
          "ERR_PACKAGE_SMOKE_ARGUMENT",
          "pass exactly one of --pack-dir or --tarball.\n\n" + USAGE,
        );
      }
      packDir = value;
    } else {
      if (tarball !== undefined || packDir !== undefined) {
        throw new PackageSmokeError(
          "ERR_PACKAGE_SMOKE_ARGUMENT",
          "pass exactly one of --pack-dir or --tarball.\n\n" + USAGE,
        );
      }
      tarball = value;
    }
    index += 1;
  }

  return {
    ...(packDir === undefined ? {} : { packDir }),
    ...(tarball === undefined ? {} : { tarball }),
  };
}

/**
 * Run one preparation or smoke command without invoking a shell.
 *
 * @param {string} command
 * @param {readonly string[]} args
 * @returns {number}
 */
export function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    throw new PackageSmokeError(
      "ERR_PACKAGE_SMOKE_COMMAND",
      `${command} could not run: ${result.error.message}\nNext: install the development tools and rerun package:smoke.`,
    );
  }
  return result.status ?? 1;
}

/**
 * Run a command and turn a non-zero status into an actionable error.
 *
 * @param {CommandRunner} runner
 * @param {string} command
 * @param {readonly string[]} args
 */
function runStep(runner, command, args) {
  const status = runner(command, args);
  if (status !== 0) {
    throw new PackageSmokeError(
      "ERR_PACKAGE_SMOKE_COMMAND",
      `${command} ${args.join(" ")} failed with exit ${String(status)}.\n` +
        "Next: fix the failed preparation or consumer check, then rerun package:smoke.",
    );
  }
}

/**
 * Build, pack, and run the consumer smoke test, or consume an existing artifact.
 *
 * @param {readonly string[]} argv
 * @param {CommandRunner} [runner]
 * @returns {number}
 */
export function main(argv, runner = runCommand) {
  let target;
  try {
    target = parseArguments(argv);
    if (target.packDir !== undefined) {
      runStep(runner, process.execPath, [
        "scripts/smoke-package.mjs",
        "--pack-dir",
        target.packDir,
      ]);
      return 0;
    }
    if (target.tarball !== undefined) {
      runStep(runner, process.execPath, [
        "scripts/smoke-package.mjs",
        "--tarball",
        target.tarball,
      ]);
      return 0;
    }

    runStep(runner, "pnpm", ["run", "build"]);
    runStep(runner, process.execPath, ["scripts/clean.mjs", PACK_DIRECTORY]);
    runStep(runner, "pnpm", ["pack", "--pack-destination", PACK_DIRECTORY]);
    runStep(runner, process.execPath, [
      "scripts/smoke-package.mjs",
      "--pack-dir",
      PACK_DIRECTORY,
    ]);
    return 0;
  } catch (error) {
    if (error instanceof PackageSmokeError) {
      console.error(error.message);
      return error.code === "ERR_PACKAGE_SMOKE_ARGUMENT" ? 2 : 1;
    }
    console.error(
      `ERR_PACKAGE_SMOKE_UNEXPECTED: ${error instanceof Error ? error.message : String(error)}\n` +
        "Next: inspect the command output, then rerun package:smoke.",
    );
    return 1;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
