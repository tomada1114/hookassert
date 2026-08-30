#!/usr/bin/env node
// Create or update this repository's GitHub labels from `.github/labels.yml`,
// the single declarative source for the label taxonomy documented in
// the `triaging-issues` skill.
//
// Usage:
//   node scripts/sync-labels.mjs
//
// Requires the `gh` CLI, authenticated against the current repository. This
// script only ever creates or updates a label the manifest declares; it never
// deletes a label the manifest does not mention, so a repository-local label
// survives running it.
import { spawnSync } from "node:child_process";
import console from "node:console";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isMain } from "./lib/is-main.mjs";
import { parseJson, readString } from "./lib/json.mjs";
import { parseLabelManifest } from "./lib/labels-manifest.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST_PATH = ".github/labels.yml";

/**
 * @typedef {import("./lib/labels-manifest.mjs").LabelDeclaration} LabelDeclaration
 */

/**
 * Result of running one `gh` invocation.
 *
 * @typedef {object} GhResult
 * @property {number | null} status - Exit code, or null when the process never started.
 * @property {string} stdout - Captured standard output.
 * @property {string} stderr - Captured standard error.
 * @property {Error} [error] - Set when the process could not be spawned at all.
 */

/**
 * A function able to run `gh`. Tests pass an in-memory fake instead of
 * mocking `node:child_process`, following the `writing-tests` skill
 * ("prefer a real in-memory fake to a mock").
 *
 * @typedef {(args: readonly string[]) => GhResult} GhRunner
 */

/**
 * Run `gh` with the real CLI. The default {@link GhRunner} used by {@link main}.
 *
 * @param {readonly string[]} args - Arguments passed to `gh`.
 * @returns {GhResult} The raw result.
 */
export function spawnGh(args) {
  const result = spawnSync("gh", [...args], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

/**
 * Check a `gh` result for a spawn failure or a non-zero exit, throwing the
 * shared, stage-prefixed error in either case. Both {@link ghJson} and
 * {@link ghRun} call this before doing anything specific to their own return
 * shape, so the two error messages can't drift apart.
 *
 * @param {GhResult} result - The result to check.
 * @param {readonly string[]} args - Arguments passed to `gh`, for the message.
 * @returns {void}
 * @throws Error when `gh` is unavailable or the command fails.
 */
function checkGhResult(result, args) {
  if (result.error !== undefined) {
    throw new Error(
      "ERR_GH_UNAVAILABLE: could not run the GitHub CLI.\n" +
        `Expected: \`gh\` on PATH. Actual: ${result.error.message}\n` +
        "Next: install the GitHub CLI, then run `gh auth status`.",
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `ERR_GH_FAILED: \`gh ${args.join(" ")}\` exited with ${String(result.status)}.\n` +
        `Actual: ${result.stderr.trim()}\n` +
        "Next: run `gh auth status` and confirm this directory has a GitHub remote.",
    );
  }
}

/**
 * Run a `gh … --json` command and parse its output.
 *
 * @param {readonly string[]} args - Arguments passed to `gh`.
 * @param {GhRunner} run - The runner to use.
 * @returns {unknown} The decoded JSON payload.
 * @throws Error when `gh` is unavailable, unauthenticated, or the command fails.
 */
export function ghJson(args, run) {
  const result = run(args);
  checkGhResult(result, args);
  return parseJson(result.stdout === "" ? "null" : result.stdout);
}

/**
 * Run a `gh` command that mutates state and produces no JSON to parse.
 *
 * @param {readonly string[]} args - Arguments passed to `gh`.
 * @param {GhRunner} run - The runner to use.
 * @returns {void}
 * @throws Error when `gh` is unavailable or the command fails.
 */
export function ghRun(args, run) {
  const result = run(args);
  checkGhResult(result, args);
}

/**
 * Resolve the `owner/repo` slug of the repository `gh` is pointed at.
 *
 * @param {GhRunner} run - The runner to use.
 * @returns {string} The `owner/repo` slug.
 * @throws Error when `gh` cannot resolve a repository (see {@link ghJson}).
 */
export function resolveRepo(run) {
  const payload = ghJson(["repo", "view", "--json", "nameWithOwner"], run);
  const slug = readString(payload, "nameWithOwner");
  if (slug === undefined) {
    throw new Error(
      "ERR_GH_NO_REPO: `gh repo view` did not report a repository.\n" +
        "Expected: a `nameWithOwner` field in its JSON output.\n" +
        `Actual: ${JSON.stringify(payload)}\n` +
        "Next: run this from a checkout with a GitHub remote, or `gh repo set-default`.",
    );
  }
  return slug;
}

/**
 * List the labels that currently exist on a repository.
 *
 * @param {string} repo - `owner/repo` slug.
 * @param {GhRunner} run - The runner to use.
 * @returns {LabelDeclaration[]} The repository's current labels.
 */
export function fetchRemoteLabels(repo, run) {
  const payload = ghJson(
    [
      "label",
      "list",
      "--repo",
      repo,
      "--limit",
      "200",
      "--json",
      "name,color,description",
    ],
    run,
  );
  const rows = Array.isArray(payload) ? payload : [];
  return rows.map((row) => ({
    name: readString(row, "name") ?? "",
    color: (readString(row, "color") ?? "").toLowerCase(),
    description: readString(row, "description") ?? "",
  }));
}

/**
 * One action needed to bring the live repository's labels in line with the manifest.
 *
 * @typedef {{ kind: "create", label: LabelDeclaration } | { kind: "update", label: LabelDeclaration, from: { color: string, description: string } }} LabelAction
 */

/**
 * Compare the manifest to the repository's current labels.
 *
 * @param {readonly LabelDeclaration[]} manifest - Declarations from `.github/labels.yml`.
 * @param {readonly LabelDeclaration[]} remote - The repository's current labels.
 * @returns {LabelAction[]} Actions needed, in manifest order. Never a
 * deletion: a label the manifest does not mention is left alone.
 */
export function diffLabels(manifest, remote) {
  const byName = new Map(remote.map((label) => [label.name, label]));
  /** @type {LabelAction[]} */
  const actions = [];
  for (const label of manifest) {
    const existing = byName.get(label.name);
    if (existing === undefined) {
      actions.push({ kind: "create", label });
      continue;
    }
    if (
      existing.color.toLowerCase() !== label.color.toLowerCase() ||
      existing.description !== label.description
    ) {
      actions.push({
        kind: "update",
        label,
        from: { color: existing.color, description: existing.description },
      });
    }
  }
  return actions;
}

/**
 * Render the plan as a human-readable, diff-shaped report.
 *
 * @param {readonly LabelAction[]} actions - Actions from {@link diffLabels}.
 * @returns {string} One line per action, or a confirmation when nothing changed.
 */
export function formatPlan(actions) {
  if (actions.length === 0) {
    return `repo:labels: every label already matches ${MANIFEST_PATH}.`;
  }
  return actions
    .map((action) =>
      action.kind === "create"
        ? `+ create ${action.label.name} (${action.label.color}) "${action.label.description}"`
        : `~ update ${action.label.name}: ` +
          `${action.from.color} "${action.from.description}" -> ` +
          `${action.label.color} "${action.label.description}"`,
    )
    .join("\n");
}

/**
 * Apply the actions against the live repository.
 *
 * @param {string} repo - `owner/repo` slug.
 * @param {readonly LabelAction[]} actions - Actions from {@link diffLabels}.
 * @param {GhRunner} run - The runner to use.
 * @returns {void}
 * @throws Error when a `gh label create`/`gh label edit` call fails.
 */
export function applyActions(repo, actions, run) {
  for (const action of actions) {
    const { label } = action;
    const verb = action.kind === "create" ? "create" : "edit";
    ghRun(
      [
        "label",
        verb,
        label.name,
        "--repo",
        repo,
        "--color",
        label.color,
        "--description",
        label.description,
      ],
      run,
    );
  }
}

/**
 * Load and parse the label manifest from disk.
 *
 * @param {string} root - Repository root.
 * @returns {LabelDeclaration[]} The parsed declarations.
 */
function loadManifest(root) {
  const text = readFileSync(path.join(root, MANIFEST_PATH), "utf8");
  return parseLabelManifest(text);
}

/**
 * Sync the live repository's labels to `.github/labels.yml`.
 *
 * @param {readonly string[]} argv - Arguments after the script name.
 * @param {object} [options] - Injection points for tests.
 * @param {string} [options.root] - Repository root; defaults to this checkout.
 * @param {GhRunner} [options.run] - `gh` runner; defaults to the real CLI.
 * @returns {number} Process exit code.
 */
export function main(argv, { root = ROOT, run = spawnGh } = {}) {
  if (argv.length > 0) {
    console.error(
      `ERR_LABELS_ARGUMENT: unknown argument(s): ${argv.join(" ")}\n` +
        "Expected: no arguments.\n" +
        "Next: run `pnpm repo:labels` with no flags.",
    );
    return 2;
  }

  /** @type {LabelDeclaration[]} */
  let manifest;
  try {
    manifest = loadManifest(root);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  try {
    const repo = resolveRepo(run);
    const remote = fetchRemoteLabels(repo, run);
    const actions = diffLabels(manifest, remote);
    console.log(`repo:labels: syncing ${repo} against ${MANIFEST_PATH}.`);
    console.log(formatPlan(actions));
    applyActions(repo, actions, run);
    if (actions.length > 0) {
      console.log(`repo:labels: applied ${String(actions.length)} change(s).`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
