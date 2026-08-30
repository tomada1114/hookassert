#!/usr/bin/env node
// Run "Are the Types Wrong?" against the tarball that will actually be published.
//
// `attw --pack .` cannot be used here: it shells out to `npm pack`, and npm
// refuses to run in a project whose `devEngines.packageManager.name` is `pnpm`
// (EBADDEVENGINES). `attw --help` offers no way to substitute the pack command.
// So the tarball is built by `pnpm pack` in the package.json script and handed
// to attw as a file. That is strictly better than packing again: the artifact
// attw checks is byte-for-byte the one that would be uploaded.
import console from "node:console";
import path from "node:path";
import process from "node:process";

import { isMain } from "./lib/is-main.mjs";
import { repoRoot, resolveDependencyBin, runNode } from "./lib/node-tools.mjs";
import { findSingleTarball } from "./lib/tarball.mjs";

const USAGE = `Usage: node scripts/check-attw.mjs (--pack-dir <dir> | --tarball <file>)

Runs \`attw <tarball> --profile esm-only\` on an already-packed tarball.

Exit codes:
  0  the published types resolve correctly for every checked consumer
  1  attw reported a problem
  2  the arguments were wrong`;

/**
 * Resolve the tarball to check from the command line.
 *
 * @param {readonly string[]} argv - Arguments after the script path.
 * @returns {string} Path to the tarball.
 * @throws Error when the arguments are unusable.
 *
 * @remarks
 * Exported so `tests/check-attw.test.ts` can exercise argument handling
 * directly, the same way `verify-package.mjs` exports its own
 * `resolveTarballArgument`.
 */
export function resolveTarball(argv) {
  /** @type {string | undefined} */
  let packDir;
  /** @type {string | undefined} */
  let tarball;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--pack-dir" && flag !== "--tarball") {
      throw new Error(`Unknown argument: ${String(flag)}\n\n${USAGE}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value.\n\n${USAGE}`);
    }
    if (flag === "--pack-dir") {
      packDir = value;
    } else {
      tarball = value;
    }
    index += 1;
  }

  if ((packDir === undefined) === (tarball === undefined)) {
    throw new Error(`Pass exactly one of --pack-dir or --tarball.\n\n${USAGE}`);
  }
  return tarball ?? findSingleTarball(/** @type {string} */ (packDir));
}

/**
 * Run attw as a command.
 *
 * @param {readonly string[]} argv - Arguments after the script path.
 * @returns {number} Process exit code.
 *
 * @remarks
 * Exported so `tests/check-attw.test.ts` can drive the success and failure
 * paths directly, mocking `runNode` at the subprocess boundary rather than
 * spawning a real `attw` process.
 */
export function main(argv) {
  /** @type {string} */
  let tarball;
  /** @type {string} */
  let attw;
  try {
    tarball = resolveTarball(argv);
    attw = resolveDependencyBin("@arethetypeswrong/cli", "attw");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  // The profile is `esm-only` because the package publishes no CommonJS entry;
  // checking CJS resolution would report failures for a contract that was never
  // offered.
  const result = runNode(attw, [tarball, "--profile", "esm-only"], { cwd: repoRoot });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);

  if (result.status !== 0) {
    console.error(
      `\nERR_ATTW_FAILED: attw rejected ${path.basename(tarball)}.\n` +
        "Expected: exit 0 under the esm-only profile.\n" +
        `Actual: exit ${String(result.status)}.\n` +
        "Next: read the table above, then check `exports`, `types` and the " +
        "emitted .d.ts extensions in package.json and tsconfig.build.json.",
    );
  }
  return result.status;
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
