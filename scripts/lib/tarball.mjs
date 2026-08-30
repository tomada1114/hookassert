// Locate the tarball produced by `pnpm pack`.
//
// `pnpm pack` runs from a package.json script, because pnpm's own path is not
// available to a plain `.mjs` (`npm_execpath` is undefined under pnpm 11). The
// scripts here therefore receive a directory and read it, which also avoids
// shell globbing: `*.tgz` is not expanded by cmd.exe.
import { readdirSync } from "node:fs";
import path from "node:path";

/**
 * Find the one tarball in a pack directory.
 *
 * @remarks
 * Requiring exactly one file is also the "produce a single tarball" check from
 * spec 02 §4 step 2: a leftover archive from an earlier version would otherwise
 * be silently inspected in place of the one just built.
 *
 * @param {string} directory - Directory passed to `--pack-destination`.
 * @returns {string} Absolute path of the single `.tgz` file.
 * @throws Error when the directory is unreadable, empty, or holds more than one
 * tarball.
 */
export function findSingleTarball(directory) {
  const resolved = path.resolve(directory);

  /** @type {string[]} */
  let names;
  try {
    names = readdirSync(resolved);
  } catch {
    throw new Error(
      `ERR_PACK_DIR_UNREADABLE: cannot read the pack directory ${directory}.\n` +
        `Expected: a directory containing exactly one .tgz file.\n` +
        `Next: run \`pnpm pack --pack-destination ${directory}\` first.`,
    );
  }

  const tarballs = names.filter((name) => name.endsWith(".tgz")).sort();
  if (tarballs.length !== 1) {
    throw new Error(
      `ERR_PACK_DIR_NOT_SINGLE: expected exactly one .tgz in ${directory}.\n` +
        `Expected: 1\n` +
        `Actual: ${String(tarballs.length)}${
          tarballs.length === 0 ? "" : ` (${tarballs.join(", ")})`
        }\n` +
        `Next: run \`node scripts/clean.mjs ${directory}\`, then ` +
        `\`pnpm pack --pack-destination ${directory}\`.`,
    );
  }

  return path.join(resolved, /** @type {string} */ (tarballs[0]));
}
