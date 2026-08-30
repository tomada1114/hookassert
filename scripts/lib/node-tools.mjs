// Run the tools that ship with Node, and the ones installed under
// node_modules, without going through a shell.
//
// Every command is spawned as `process.execPath <script.js> …` rather than as a
// bare name. That skips PATH lookup, skips the `.cmd` shims that make bare
// names unspawnable on Windows without `shell: true`, and guarantees the child
// runs on the same Node this script is running on.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseJson, readKey, readString } from "./json.mjs";

/** Absolute path of the repository root. */
export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/**
 * Result of a spawned command.
 *
 * @typedef {object} RunResult
 * @property {number} status - Exit code; 1 when the process was killed by a signal.
 * @property {string} stdout - Captured standard output.
 * @property {string} stderr - Captured standard error.
 */

/**
 * Run a JavaScript file on the current Node.
 *
 * @param {string} script - Absolute path of the script to run.
 * @param {readonly string[]} args - Arguments passed to the script.
 * @param {object} [options] - Spawn options.
 * @param {string} [options.cwd] - Working directory.
 * @param {NodeJS.ProcessEnv} [options.env] - Environment; defaults to this one.
 * @returns {RunResult} The captured result.
 */
export function runNode(script, args, options = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    // A hung child must not hang CI. Installing a tarball and running `tsc`
    // are the slow steps and finish well inside this.
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    // The process never ran, or was killed for exceeding the timeout above.
    // Reporting the reason beats returning an empty stderr and a bare exit 1.
    return {
      status: 1,
      stdout: "",
      stderr: `${result.error.name}: ${result.error.message}`,
    };
  }
  // `status` is null only when a signal ended the process, which the branch
  // above has already covered for every case this helper can produce.
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Locate the npm CLI that ships with the running Node.
 *
 * @remarks
 * npm is used for the throwaway consumer rather than pnpm because pnpm's own
 * path is not discoverable from a `.mjs` (`npm_execpath` is undefined under
 * pnpm 11), and because a consumer installing from a tarball is what a real
 * user does. The consumer's manifest has no `devEngines`, so npm's
 * package-manager check does not apply to it.
 *
 * @returns {string} Absolute path of `npm-cli.js`.
 * @throws Error when npm cannot be found next to the Node binary.
 */
export function npmCliPath() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    // POSIX install layout, then the Windows one.
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      "ERR_NPM_NOT_FOUND: could not find the npm CLI that ships with Node.\n" +
        "Expected: npm-cli.js next to the running Node installation.\n" +
        `Actual: absent from ${candidates.map((c) => path.relative(nodeDir, c)).join(" and ")}.\n` +
        "Next: reinstall Node, or use a distribution that bundles npm.",
    );
  }
  return found;
}

/**
 * Resolve the executable entry point of an installed dependency.
 *
 * @remarks
 * Reads the dependency's own `bin` field instead of assuming a filename, and
 * targets the real script rather than the `node_modules/.bin` shim so it can be
 * handed to {@link runNode}.
 *
 * @param {string} packageName - Name of a dependency, scope included.
 * @param {string} [binName] - Which `bin` entry to use; defaults to the only one.
 * @returns {string} Absolute path of the dependency's entry script.
 * @throws Error when the dependency is not installed or declares no such bin.
 */
export function resolveDependencyBin(packageName, binName) {
  const manifestPath = path.join(repoRoot, "node_modules", packageName, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `ERR_DEPENDENCY_MISSING: ${packageName} is not installed.\n` +
        `Expected: node_modules/${packageName}/package.json\n` +
        "Next: run `pnpm install --frozen-lockfile`.",
    );
  }

  const manifest = parseJson(readFileSync(manifestPath, "utf8"));
  const bin = readKey(manifest, "bin");
  const relative =
    typeof bin === "string"
      ? bin
      : readString(bin, binName ?? readString(manifest, "name") ?? packageName);

  if (relative === undefined) {
    throw new Error(
      `ERR_DEPENDENCY_BIN_MISSING: ${packageName} declares no usable bin entry.\n` +
        `Expected: a bin field naming ${binName ?? "the package itself"}.\n` +
        "Next: check the installed version of that dependency.",
    );
  }
  return path.join(repoRoot, "node_modules", packageName, relative);
}
