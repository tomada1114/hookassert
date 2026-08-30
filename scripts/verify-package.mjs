#!/usr/bin/env node
// Run every publish-artifact check against one already-packed tarball.
//
// Keeping resolution here prevents local checks and the release workflow from
// accidentally rebuilding between publint, attw, the consumer smoke test, and
// publication.
import console from "node:console";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isMain } from "./lib/is-main.mjs";
import { repoRoot, resolveDependencyBin, runNode } from "./lib/node-tools.mjs";
import { findSingleTarball } from "./lib/tarball.mjs";

const USAGE = `Usage: node scripts/verify-package.mjs (--pack-dir <dir> | --tarball <file>)

Runs publint, Are the Types Wrong?, and the consumer smoke test against one
already-packed tarball.

Exit codes:
  0  every artifact check passed
  1  a check failed
  2  the arguments were wrong`;

/**
 * Resolve the single artifact named on the command line.
 *
 * @param {readonly string[]} argv - Arguments after the script path.
 * @returns {string} Absolute tarball path.
 * @throws Error when the arguments are unusable.
 */
export function resolveTarballArgument(argv) {
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
  return path.resolve(tarball ?? findSingleTarball(/** @type {string} */ (packDir)));
}

/**
 * Run a child check and preserve its output.
 *
 * @param {string} label - Human-readable check name.
 * @param {string} script - JavaScript entry point.
 * @param {readonly string[]} args - Arguments for the entry point.
 * @returns {boolean} Whether the check passed.
 *
 * @remarks
 * Exported so `tests/verify-package.test.ts` can exercise both outcomes
 * directly, mocking `runNode` at the subprocess boundary rather than running
 * a real publint/attw/smoke check for every case.
 */
export function runCheck(label, script, args) {
  console.log(`package-verify: ${label}`);
  const result = runNode(script, args, { cwd: repoRoot });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    console.error(
      `ERR_PACKAGE_VERIFY_FAILED: ${label} failed.\n` +
        `Expected: exit 0\n` +
        `Actual: exit ${String(result.status)}\n` +
        "Next: fix the reported artifact problem, rebuild once, and pack again.",
    );
    return false;
  }
  return true;
}

/**
 * Run every artifact check.
 *
 * @param {readonly string[]} argv - Arguments after the script path.
 * @returns {number} Process exit code.
 */
export function main(argv) {
  /** @type {string} */
  let tarball;
  /** @type {string} */
  let publint;
  try {
    tarball = resolveTarballArgument(argv);
    publint = resolveDependencyBin("publint", "publint");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  console.log(`package-verify: artifact ${path.basename(tarball)}`);
  const checks = [
    { label: "publint", script: publint, args: [tarball, "--strict"] },
    {
      label: "Are the Types Wrong?",
      script: fileURLToPath(new URL("check-attw.mjs", import.meta.url)),
      args: ["--tarball", tarball],
    },
    {
      label: "consumer smoke test",
      script: fileURLToPath(new URL("smoke-package.mjs", import.meta.url)),
      args: ["--tarball", tarball],
    },
  ];

  for (const { label, script, args } of checks) {
    if (!runCheck(label, script, args)) {
      return 1;
    }
  }
  console.log("package-verify: all checks passed");
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
