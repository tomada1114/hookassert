#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import console from "node:console";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { MARKER_TARGETS, findPlaceholders } from "./bootstrap.mjs";
import { isolatedGitEnv } from "./lib/git-env.mjs";
import { isMain } from "./lib/is-main.mjs";
import { parseJson, readKey, readString } from "./lib/json.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LEGACY_RELEASE_DIRECTORY = ".change" + "set";

/**
 * Read every backticked skill name in AGENTS.md's "## Skills" routing table.
 *
 * Mirrors `tests/skills-frontmatter.test.ts`'s own parse of this template's
 * checkout AGENTS.md ("names %s after an existing skill directory"), so the
 * same invariant it enforces there is checked against the generated tree
 * too: a table row that survives a skill's own removal or rename would
 * otherwise escape every check that only ever runs against the checkout.
 *
 * @param {string} source - AGENTS.md's full contents.
 * @returns {string[]} Every backticked name in the table's first column, in
 * document order. Empty when the file has no "## Skills" heading.
 *
 * @remarks
 * Exported so `tests/verify-bootstrap.test.ts` can exercise the parse
 * directly against a hand-built fixture string.
 */
export function listRoutingTableSkillNames(source) {
  const lines = source.split("\n");
  const headingIndex = lines.indexOf("## Skills");
  if (headingIndex === -1) {
    return [];
  }
  const nextHeadingIndex = lines.findIndex(
    (line, index) => index > headingIndex && /^##[ \t]/.test(line),
  );
  const section = lines.slice(
    headingIndex + 1,
    nextHeadingIndex === -1 ? undefined : nextHeadingIndex,
  );

  /** @type {string[]} */
  const names = [];
  for (const line of section) {
    const row = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (row?.[1] !== undefined) {
      names.push(row[1]);
    }
  }
  return names;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 *
 * @remarks
 * Exported so `tests/verify-bootstrap.test.ts` can exercise both outcomes
 * directly with a cheap real subprocess (a bare `node -e`), instead of only
 * through `main()`'s full bootstrap run.
 */
export function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "inherit",
    timeout: 900_000,
    // Every command here runs against a throwaway workspace, so none of them
    // may inherit a hook's GIT_DIR — see scripts/lib/git-env.mjs.
    env: isolatedGitEnv(),
  });
  if (result.status !== 0) {
    throw new Error(
      `ERR_BOOTSTRAP_E2E: ${command} ${args.join(" ")} failed with exit ${String(result.status)}.`,
    );
  }
}

/**
 * Check the lightweight, observable output of one bootstrap run.
 *
 * @param {string} destination
 * @param {string} packageName
 * @param {boolean} [cli=false]
 *
 * @remarks
 * Exported so `tests/verify-bootstrap.test.ts` can exercise each of its
 * failure branches directly against a hand-built fixture tree, rather than
 * only through a full, real `main()` bootstrap run.
 */
export function assertGenerated(destination, packageName, cli = false) {
  const placeholders = findPlaceholders(destination);
  if (placeholders.length > 0) {
    throw new Error(
      `ERR_PLACEHOLDER_REMAINING: generated ${packageName} still contains placeholders.\n` +
        placeholders.join("\n"),
    );
  }

  for (const relative of MARKER_TARGETS) {
    const file = path.join(destination, relative);
    if (
      /(?:template-only|profile:[a-z0-9-]+:)/.exec(readFileSync(file, "utf8")) !== null
    ) {
      throw new Error(
        `ERR_BOOTSTRAP_MARKER: generated ${packageName} retains a bootstrap marker in ${relative}.`,
      );
    }
  }

  const agentsMd = readFileSync(path.join(destination, "AGENTS.md"), "utf8");
  for (const name of listRoutingTableSkillNames(agentsMd)) {
    if (!existsSync(path.join(destination, ".agents", "skills", name))) {
      throw new Error(
        `ERR_BOOTSTRAP_STALE_SKILL_ROUTE: generated ${packageName} routes to a missing skill.\n` +
          `Expected: .agents/skills/${name} to exist, matching its AGENTS.md Skills row.\n` +
          "Next: remove the stale row from AGENTS.md's Skills table, or make the skill " +
          "self-remove alongside whatever it documents (see bootstrap.mjs's " +
          "SELF_REMOVED_PATHS and SELF_REMOVED_AGENTS_LINES), then rerun bootstrap:e2e.",
      );
    }
  }

  if (existsSync(path.join(destination, LEGACY_RELEASE_DIRECTORY))) {
    throw new Error(
      `ERR_RELEASE_INTENT_PATH_REMAINING: generated ${packageName} retains the legacy release directory.`,
    );
  }

  if (existsSync(path.join(destination, "scripts", "bootstrap.mjs"))) {
    throw new Error(
      `ERR_BOOTSTRAP_SCRIPT_REMAINING: generated ${packageName} retains scripts/bootstrap.mjs.\n` +
        "Expected: bootstrap removes its own script from the generated repository.\n" +
        "Next: add scripts/bootstrap.mjs to transform()'s removal list, then rerun bootstrap:e2e.",
    );
  }

  const changelog = readFileSync(path.join(destination, "CHANGELOG.md"), "utf8");
  if (/^## /m.test(changelog)) {
    throw new Error(
      `ERR_CHANGELOG_ENTRY_REMAINING: generated ${packageName} retains a template changelog entry.\n` +
        "Expected: a bare Keep a Changelog skeleton with no version headings.\n" +
        "Next: update the generated CHANGELOG.md skeleton, then rerun bootstrap:e2e.",
    );
  }

  const manifest = parseJson(
    readFileSync(path.join(destination, "package.json"), "utf8"),
  );
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error(
      `ERR_MANIFEST_SHAPE: generated ${packageName} has no object manifest.`,
    );
  }
  if (readKey(manifest, "name") !== packageName) {
    throw new Error(`ERR_PACKAGE_NAME: generated package name is not ${packageName}.`);
  }
  if (readKey(manifest, "version") !== "0.0.0") {
    throw new Error(
      `ERR_VERSION_REMAINING: generated ${packageName} does not start at version 0.0.0.\n` +
        `Expected: package.json#version === "0.0.0".\n` +
        `Actual: ${JSON.stringify(readKey(manifest, "version"))}\n` +
        "Next: set GENERATED_VERSION and apply it to package.json#version in " +
        "transform(), then rerun bootstrap:e2e.",
    );
  }
  const bin = readKey(manifest, "bin");
  if (!cli && bin !== undefined) {
    throw new Error(
      "ERR_BIN_REMAINING: generated package still declares package.json#bin.\n" +
        "Expected: no bin entry when bootstrap runs with --cli no.\n" +
        "Next: remove bin metadata from the template, then rerun bootstrap:e2e.",
    );
  }
  // The command a consumer types is the bin object's key, so verifying the path
  // alone would accept a package whose command is unnamed or misnamed.
  const command = packageName.slice(packageName.lastIndexOf("/") + 1);
  if (
    cli &&
    (readString(bin, command) !== "./dist/cli.js" ||
      !existsSync(path.join(destination, "src", "cli.ts")))
  ) {
    throw new Error(
      `ERR_BIN_REMAINING: generated CLI package has no emitted CLI entry.\n` +
        `Expected: package.json#bin['${command}'] === './dist/cli.js' and src/cli.ts exists.\n` +
        "Next: keep src/cli.ts and point bin at its emitted dist/cli.js, then rerun bootstrap:e2e.",
    );
  }
  if (readKey(manifest, "sideEffects") !== false) {
    throw new Error(
      "ERR_SIDE_EFFECTS_REMAINING: generated package does not declare sideEffects as false.\n" +
        "Expected: sideEffects: false in both remaining profiles.\n" +
        "Next: update the template manifest, then rerun bootstrap:e2e.",
    );
  }

  const nodeEngines = readString(readKey(manifest, "engines"), "node");
  if (nodeEngines !== undefined) {
    const floor = /^>=(\d+)$/.exec(nodeEngines)?.[1];
    const workflow = readFileSync(
      path.join(destination, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const packageFloorStart = workflow.indexOf("\n  package-floor:");
    const packageFloor =
      packageFloorStart === -1 ? "" : workflow.slice(packageFloorStart);
    if (floor === undefined || !packageFloor.includes(`node-version: ${floor}`)) {
      throw new Error(
        `ERR_NODE_ENGINES_CI_MISMATCH: generated ${packageName} publishes ${nodeEngines}, ` +
          "but its package-floor CI leg does not run that major.\n" +
          "Expected: the package-floor job's node-version to equal engines.node's >=N floor.\n" +
          "Next: rerun bootstrap with a supported --node-engines range and regenerate ci.yml.",
      );
    }
    if (!packageFloor.includes("package:smoke")) {
      throw new Error(
        `ERR_NODE_ENGINES_CI_MISMATCH: generated ${packageName} has no package:smoke floor check.\n` +
          "Expected: package-floor runs package:smoke against the packed artifact.\n" +
          "Next: restore the package-floor job in ci.yml, then rerun bootstrap:e2e.",
      );
    }
  }
}

/**
 * Decide whether a path `git ls-files` reported is safe to copy.
 *
 * `git`'s own untracked-file walk already keeps a genuine socket or FIFO out
 * of the list this guards (`git add`/`ls-files --others` silently drop them),
 * so in practice only a stale index entry or a tracked symlink reach here —
 * but the check is written against "not a regular file" rather than
 * "is a symlink" so it also holds if that git behavior ever changes, or a
 * caller feeds it a path some other way.
 *
 * @param {string} source - Absolute path on disk.
 * @param {string} relative - Repository-relative path, used in the error.
 * @returns {boolean} `true` when `source` is a regular file to copy, `false`
 * when it is a stale index entry to skip.
 */
export function assertCopyable(source, relative) {
  /** @type {import("node:fs").Stats} */
  let stats;
  try {
    stats = lstatSync(source);
  } catch (error) {
    // `git ls-files` lists a path that a later `rm` removed but no commit
    // recorded yet; that is a stale entry, not a file to copy.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (stats.isFile()) {
    return true;
  }
  throw new Error(
    `ERR_BOOTSTRAP_UNSUPPORTED_ENTRY: ${relative} is not a regular file.\n` +
      "Expected: a regular file, so the copy faithfully reproduces the source tree.\n" +
      `Actual: ${stats.isSymbolicLink() ? "a symlink" : "a socket, FIFO, or device entry"}.\n` +
      "Next: replace it with a real file, or remove it from git, then rerun bootstrap:e2e.",
  );
}

/**
 * Copy every file `git ls-files` reports from `root` into `destination`,
 * preserving relative paths.
 *
 * @param {string} destination
 * @param {string} [root] - Repository root to copy from. Defaults to this
 * template's own checkout.
 */
export function copyTemplate(destination, root = ROOT) {
  const files = spawnSync(
    "git",
    ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8", timeout: 30_000, env: isolatedGitEnv() },
  );
  if (files.status !== 0) {
    throw new Error(`ERR_GIT_FILES: ${files.stderr.trim()}`);
  }
  for (const relative of files.stdout.split("\0").filter(Boolean)) {
    const source = path.join(root, relative);
    if (!assertCopyable(source, relative)) {
      continue;
    }
    const target = path.join(destination, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

/**
 * @returns {number}
 */
export function main() {
  const workspace = mkdtempSync(path.join(tmpdir(), "typescript-template-e2e-"));
  try {
    /** @type {readonly [string | undefined, string | undefined, boolean | undefined, string | undefined][]} */
    const cases = [
      ["node-library", "acme-node-library", false, ">=24"],
      ["node-library", "acme-node-cli", true, ">=20"],
      ["universal-library", "acme-universal-library", false, ">=24"],
    ];
    for (const [profile, packageName, cli, nodeEngines] of cases) {
      if (
        profile === undefined ||
        packageName === undefined ||
        cli === undefined ||
        nodeEngines === undefined
      ) {
        throw new Error("ERR_E2E_CASE: malformed bootstrap test case.");
      }
      const destination = path.join(workspace, packageName);
      mkdirSync(destination);
      copyTemplate(destination);
      run(
        process.execPath,
        [
          "scripts/bootstrap.mjs",
          packageName,
          "--profile",
          profile,
          "--author",
          "Ada Lovelace",
          "--email",
          "ada@example.com",
          "--github-user",
          "ada",
          "--license",
          "MIT",
          "--node-engines",
          nodeEngines,
          ...(cli ? ["--cli", "yes"] : []),
        ],
        destination,
      );
      assertGenerated(destination, packageName, cli);
      console.log(
        `bootstrap-e2e: ${packageName} (${profile}, cli=${String(cli)}, engines=${nodeEngines}) passed`,
      );
    }
    return 0;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = main();
}
