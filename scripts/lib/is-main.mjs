// Decide whether a module is the process entry point.
//
// Scripts here are imported by tests *and* run as commands, so the CLI half
// must stay dormant on import. `import.meta.url.endsWith("foo.mjs")` is true in
// both cases and cannot make that distinction, and `import.meta.main` is Node
// 24+ while the supported floor is 22.14.
import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Resolve symlinks, falling back to plain resolution for a missing path.
 *
 * @remarks
 * The entry point reached through `node_modules/.bin/<name>` is a symlink, so
 * comparing the paths as written would never match.
 *
 * @param {string} target - Path to canonicalize.
 * @returns {string} The canonical path, or the absolute path when unresolvable.
 */
function canonicalize(target) {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * Report whether the calling module was executed directly.
 *
 * @param {string} moduleUrl - The caller's own `import.meta.url`.
 * @returns {boolean} True when Node was started with this module.
 *
 * @example
 * ```js
 * if (isMain(import.meta.url)) {
 *   await main(process.argv.slice(2));
 * }
 * ```
 */
export function isMain(moduleUrl) {
  const entry = process.argv[1];
  if (entry === undefined) {
    // No script path at all: `node --eval`, or an embedded host.
    return false;
  }
  return canonicalize(entry) === canonicalize(fileURLToPath(moduleUrl));
}
