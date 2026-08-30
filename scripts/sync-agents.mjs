#!/usr/bin/env node
// Mirror `.agents/skills/` into `.claude/skills/`, byte for byte.
//
// The skills are authored once, under `.agents/skills/` — the path Codex CLI
// discovers project skills from. Claude Code only looks in `.claude/skills/`,
// so the same tree has to exist there too. A symlink would satisfy both
// lookups on this machine but not from a fresh clone on every platform, and
// Codex follows a linked directory into its own subdirectories, registering a
// nested `references/SKILL.md` as a skill of its own. So the second copy is a
// real, committed one, generated from here (`pnpm agents:sync`) and checked by
// `pnpm agents:check`, `tests/sync-agents.test.ts` and lefthook.
//
// `diffTrees` is exported so the test can assert the committed trees agree
// without spawning this file: a subprocess reports "drifted" and "never
// started" with the same non-zero exit code.
import console from "node:console";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isMain } from "./lib/is-main.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Authoring copy: what a human or an agent edits. */
export const SOURCE_DIRECTORY = ".agents/skills";

/** Generated copy: committed, never hand-edited. */
export const MIRROR_DIRECTORY = ".claude/skills";

/**
 * One way in which the mirror disagrees with the source.
 *
 * @typedef {{ kind: "missing" | "extra" | "differs", relative: string }} TreeDifference
 */

/**
 * Error with a stable code and an actionable message.
 */
export class SyncAgentsError extends Error {
  /**
   * @param {string} code - Stable `ERR_AGENTS_*` identifier.
   * @param {string} message - Human-readable detail.
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "SyncAgentsError";
    this.code = code;
  }
}

/**
 * List every regular file under a directory, as paths relative to it.
 *
 * @param {string} directory - Absolute path to walk; may be absent.
 * @param {string} label - Repository-relative name used in error messages.
 * @returns {string[]} Sorted relative paths, using `/` separators.
 *
 * @remarks
 * Exported so `tests/sync-agents.test.ts` can exercise its recursion, its
 * missing-directory tolerance and its unsupported-entry error directly,
 * rather than only indirectly through {@link diffTrees}.
 */
export function listFiles(directory, label) {
  /** @type {string[]} */
  const files = [];
  /** @type {(current: string, prefix: string) => void} */
  const visit = (current, prefix) => {
    /** @type {import("node:fs").Dirent[]} */
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        visit(path.join(current, entry.name), relative);
      } else if (entry.isFile()) {
        files.push(relative);
      } else {
        throw new SyncAgentsError(
          "ERR_AGENTS_UNSUPPORTED_ENTRY",
          `${label}/${relative} is neither a file nor a directory.\n` +
            "Expected: real files only, so both copies work from a fresh clone.\n" +
            "Actual: a symlink, socket, or device entry.\n" +
            `Next: replace it with a real file under ${SOURCE_DIRECTORY}/, then run \`pnpm agents:sync\`.`,
        );
      }
    }
  };
  visit(directory, "");
  return files.sort();
}

/**
 * Compare two files byte for byte.
 *
 * @param {string} left - Absolute path.
 * @param {string} right - Absolute path.
 * @returns {boolean} True when the contents are identical.
 */
function sameContents(left, right) {
  return readFileSync(left).equals(readFileSync(right));
}

/**
 * Report every way in which the mirror disagrees with the source tree.
 *
 * @param {string} sourceDirectory - Absolute path of the authoring tree.
 * @param {string} mirrorDirectory - Absolute path of the generated tree.
 * @returns {TreeDifference[]} Empty when the two trees are identical.
 */
export function diffTrees(sourceDirectory, mirrorDirectory) {
  const sourceFiles = listFiles(sourceDirectory, SOURCE_DIRECTORY);
  const mirrorFiles = new Set(listFiles(mirrorDirectory, MIRROR_DIRECTORY));

  /** @type {TreeDifference[]} */
  const differences = [];
  for (const relative of sourceFiles) {
    if (!mirrorFiles.has(relative)) {
      differences.push({ kind: "missing", relative });
      continue;
    }
    mirrorFiles.delete(relative);
    if (
      !sameContents(
        path.join(sourceDirectory, relative),
        path.join(mirrorDirectory, relative),
      )
    ) {
      differences.push({ kind: "differs", relative });
    }
  }
  for (const relative of [...mirrorFiles].sort()) {
    differences.push({ kind: "extra", relative });
  }
  return differences;
}

/**
 * Remove a directory once nothing is left in it, and its emptied parents.
 *
 * @param {string} directory - Absolute path that may now be empty.
 * @param {string} stopAt - Absolute path to keep, however empty.
 * @returns {void}
 */
function pruneEmptyDirectories(directory, stopAt) {
  let current = directory;
  while (current.startsWith(stopAt) && current !== stopAt) {
    if (readdirSync(current).length > 0) {
      return;
    }
    rmSync(current, { recursive: true });
    current = path.dirname(current);
  }
}

/**
 * Make the mirror a byte-identical copy of the source tree.
 *
 * @param {string} sourceDirectory - Absolute path of the authoring tree.
 * @param {string} mirrorDirectory - Absolute path of the generated tree.
 * @returns {TreeDifference[]} The differences that were repaired.
 */
export function syncTrees(sourceDirectory, mirrorDirectory) {
  const differences = diffTrees(sourceDirectory, mirrorDirectory);
  // Deletions run before copies. A path that changed kind — a mirror file
  // where the source now has a directory, or the reverse — is reported as one
  // `extra` and one `missing`, and copying first would hit the stale entry
  // (`EISDIR`, or `ENOTDIR` from `mkdirSync`) instead of replacing it.
  for (const { kind, relative } of differences) {
    if (kind !== "extra") {
      continue;
    }
    const target = path.join(mirrorDirectory, relative);
    rmSync(target);
    pruneEmptyDirectories(path.dirname(target), mirrorDirectory);
  }
  for (const { kind, relative } of differences) {
    if (kind === "extra") {
      continue;
    }
    const target = path.join(mirrorDirectory, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(sourceDirectory, relative), target);
  }
  return differences;
}

/**
 * Refuse to run against a repository that has no authoring tree.
 *
 * @param {string} sourceDirectory - Absolute path of the authoring tree.
 * @returns {void}
 */
export function assertSourceDirectory(sourceDirectory) {
  let isDirectory = false;
  try {
    isDirectory = statSync(sourceDirectory).isDirectory();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  if (!isDirectory) {
    throw new SyncAgentsError(
      "ERR_AGENTS_SOURCE_MISSING",
      `the skills source tree is absent.\n` +
        `Expected: ${SOURCE_DIRECTORY}/ to be a directory.\n` +
        "Actual: no such directory.\n" +
        `Next: restore ${SOURCE_DIRECTORY}/ from version control.`,
    );
  }
}

/**
 * Render a drift report for `--check`.
 *
 * @param {readonly TreeDifference[]} differences - Non-empty difference list.
 * @returns {string} The full multi-line error message.
 */
export function formatDrift(differences) {
  const detail = differences
    .map(({ kind, relative }) => `  ${kind}: ${MIRROR_DIRECTORY}/${relative}`)
    .join("\n");
  return (
    `ERR_AGENTS_DRIFT: ${MIRROR_DIRECTORY}/ is not a copy of ${SOURCE_DIRECTORY}/.\n` +
    `Expected: a byte-identical mirror of ${SOURCE_DIRECTORY}/.\n` +
    `Actual:\n${detail}\n` +
    "Next: run `pnpm agents:sync`."
  );
}

/**
 * Mirror the tree, or report drift without writing anything.
 *
 * @param {readonly string[]} argv - Arguments after the script name.
 * @param {string} [root] - Repository root; defaults to this checkout.
 * @returns {number} Process exit code.
 */
export function main(argv, root = ROOT) {
  const check = argv.includes("--check");
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length > 0) {
    console.error(
      `ERR_AGENTS_ARGUMENT: unknown option: ${unknown.join(" ")}\n` +
        "Expected: no arguments, or --check.\n" +
        "Next: run `pnpm agents:sync` or `pnpm agents:check`.",
    );
    return 2;
  }

  const sourceDirectory = path.join(root, SOURCE_DIRECTORY);
  const mirrorDirectory = path.join(root, MIRROR_DIRECTORY);
  try {
    assertSourceDirectory(sourceDirectory);
    if (check) {
      const differences = diffTrees(sourceDirectory, mirrorDirectory);
      if (differences.length > 0) {
        console.error(formatDrift(differences));
        return 1;
      }
      console.log(`agents:check: ${MIRROR_DIRECTORY}/ is in sync.`);
      return 0;
    }
    const repaired = syncTrees(sourceDirectory, mirrorDirectory);
    console.log(
      repaired.length === 0
        ? `agents:sync: ${MIRROR_DIRECTORY}/ was already in sync.`
        : `agents:sync: updated ${String(repaired.length)} path(s) in ${MIRROR_DIRECTORY}/.`,
    );
    for (const { kind, relative } of repaired) {
      console.log(`- ${kind}: ${relative}`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof SyncAgentsError ? 2 : 1;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
