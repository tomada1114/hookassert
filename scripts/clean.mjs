#!/usr/bin/env node
// Remove build output without depending on a shell or an extra package.
// Only paths passed on the command line are removed, and only when they sit
// inside the repository, so a typo can never reach outside the project.
// Node globals are imported explicitly rather than declared as ESLint globals:
// one convention for every .mjs file here, and no extra dependency.
import console from "node:console";
import { rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isMain } from "./lib/is-main.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Remove each target path, refusing anything outside the repository.
 *
 * @remarks
 * Exported so `tests/clean.test.ts` can exercise both branches (no targets,
 * and a path outside the repository) directly, instead of only through a
 * spawned process. `root` defaults to this repository's own root and is
 * overridable so a test can point it at a throwaway `mkdtempSync` directory
 * instead of writing into the real project directory — the same
 * dependency-injection shape `sync-labels.mjs`'s `main` uses for `root`.
 *
 * @param {readonly string[]} targets - Paths to remove, relative to `root`
 * or already inside it.
 * @param {string} [root] - Directory targets must resolve inside; defaults
 * to this repository's own root.
 * @returns {number} Process exit code: 0 on success, 2 for bad usage.
 */
export function clean(targets, root = repoRoot) {
  if (targets.length === 0) {
    console.error("clean: no targets given. Usage: node scripts/clean.mjs <path>...");
    return 2;
  }

  for (const target of targets) {
    const resolved = path.resolve(root, target);
    const relative = path.relative(root, resolved);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      console.error(
        `clean: refusing to remove a path outside the repository: ${target}`,
      );
      return 2;
    }
    rmSync(resolved, { recursive: true, force: true });
  }
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = clean(process.argv.slice(2));
}
