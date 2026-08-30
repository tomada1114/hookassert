#!/usr/bin/env node
// Survey open Dependabot PRs and emit a triage table.
//
// Usage:
//   node .agents/skills/merge-dependabot/scripts/survey-prs.mjs [--json]
//
// Requires the `gh` CLI, authenticated against the current repository.
// Read-only: this script never mutates PR or branch state, and it is the only
// step of the skill that runs without human approval.
import { spawnSync } from "node:child_process";
import console from "node:console";
import process from "node:process";

import { isMain } from "../../../../scripts/lib/is-main.mjs";
import { parseJson, readKey, readString } from "../../../../scripts/lib/json.mjs";

/**
 * One triage row.
 *
 * @typedef {object} Row
 * @property {number} number - Pull request number.
 * @property {string} title - Pull request title.
 * @property {string} url - Pull request URL.
 * @property {string} branch - Head branch name.
 * @property {string | undefined} package - Dependency being bumped.
 * @property {string | undefined} from - Version before the bump.
 * @property {string | undefined} to - Version after the bump.
 * @property {string} level - `major`, `minor`, `patch` or `unknown`.
 * @property {string} ecosystem - `github_actions`, `npm` or `other`.
 * @property {string} mergeState - GitHub's mergeStateStatus.
 * @property {string} checks - `PASSING`, `FAILING`, `PENDING` or `NONE`.
 * @property {string[]} failingChecks - Names and states of failing checks.
 * @property {string[]} files - Paths the pull request touches.
 */

const FIELDS = [
  "number",
  "title",
  "author",
  "headRefName",
  "mergeable",
  "mergeStateStatus",
  "statusCheckRollup",
  "labels",
  "files",
  "url",
].join(",");

// Matches Dependabot titles such as "bump vitest from 4.1.9 to 4.1.10" and
// "update eslint requirement from ^10.6.0 to ^10.7.0".
const BUMP =
  /(?:bump|update)\s+(?<pkg>\S+?)(?:\s+requirement)?\s+from\s+(?<old>\S+)\s+to\s+(?<next>\S+)/i;

// A range like `^10.7` has no patch component, so that group stays optional.
const VERSION = /(\d+)\.(\d+)(?:\.(\d+))?/;

const FAILED_STATES = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "ERROR",
]);
const PENDING_STATES = new Set([
  "PENDING",
  "IN_PROGRESS",
  "QUEUED",
  "WAITING",
  "EXPECTED",
]);

/**
 * Read a property that must be an array.
 *
 * @param {unknown} value - Candidate object.
 * @param {string} key - Property to read.
 * @returns {unknown[]} The array, or an empty array when absent or of another type.
 */
function readArray(value, key) {
  const read = readKey(value, key);
  return Array.isArray(read) ? read : [];
}

/**
 * Run a read-only `gh … --json` command and return the parsed payload.
 *
 * @param {readonly string[]} args - Arguments passed to `gh`.
 * @returns {unknown[]} The decoded JSON array.
 * @throws Error when `gh` is unavailable or the command failed.
 */
function ghJson(args) {
  const result = spawnSync("gh", [...args], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
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
  const parsed = parseJson(result.stdout === "" ? "[]" : result.stdout);
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Pull the package and the two versions out of a bot pull request title.
 *
 * @param {string} title - Pull request title.
 * @returns {{ pkg: string | undefined, from: string | undefined, to: string | undefined }}
 * The parsed parts, each undefined when the title does not match.
 */
export function parseVersions(title) {
  const groups = BUMP.exec(title)?.groups;
  return { pkg: groups?.["pkg"], from: groups?.["old"], to: groups?.["next"] };
}

/**
 * Classify a bump as major, minor or patch.
 *
 * @param {string | undefined} from - Version before the bump.
 * @param {string | undefined} to - Version after the bump.
 * @returns {string} `major`, `minor`, `patch`, or `unknown` when unparsable.
 */
export function semverLevel(from, to) {
  if (from === undefined || to === undefined) {
    return "unknown";
  }
  const before = VERSION.exec(from);
  const after = VERSION.exec(to);
  if (before === null || after === null) {
    return "unknown";
  }
  const part = (/** @type {RegExpExecArray} */ match, /** @type {number} */ index) =>
    Number(match[index] ?? "0");
  if (part(before, 1) !== part(after, 1)) {
    return "major";
  }
  return part(before, 2) === part(after, 2) ? "patch" : "minor";
}

/**
 * Reduce a status check rollup to one overall state plus the failing checks.
 *
 * @param {readonly unknown[]} rollup - GitHub's `statusCheckRollup` array.
 * @returns {{ state: string, failing: string[] }} The summary.
 */
export function checkSummary(rollup) {
  if (rollup.length === 0) {
    return { state: "NONE", failing: [] };
  }
  /** @type {string[]} */
  const failing = [];
  let pending = false;
  for (const check of rollup) {
    // Check runs report conclusion/status; commit statuses report state.
    const state = (
      readString(check, "conclusion") ??
      readString(check, "state") ??
      ""
    ).toUpperCase();
    const status = (readString(check, "status") ?? "").toUpperCase();
    const name = readString(check, "name") ?? readString(check, "context") ?? "?";
    if (state === "" && status !== "" && status !== "COMPLETED") {
      pending = true;
    } else if (FAILED_STATES.has(state)) {
      failing.push(`${name}=${state}`);
    } else if (PENDING_STATES.has(state)) {
      pending = true;
    }
  }
  if (failing.length > 0) {
    return { state: "FAILING", failing };
  }
  return { state: pending ? "PENDING" : "PASSING", failing: [] };
}

/**
 * Classify a Dependabot branch name into an ecosystem.
 *
 * @param {string} branch - Head branch name.
 * @returns {string} `github_actions`, `npm`, or `other`.
 */
export function ecosystemOf(branch) {
  if (branch.includes("github_actions")) {
    return "github_actions";
  }
  // Dependabot still names the npm updater `npm_and_yarn`, pnpm included.
  return branch.includes("npm_and_yarn") ? "npm" : "other";
}

/**
 * Build one triage row per open bot-authored pull request.
 *
 * @returns {Row[]} Rows ordered by pull request number.
 */
function collect() {
  const pulls = ghJson([
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    FIELDS,
  ]);
  /** @type {Row[]} */
  const rows = [];
  for (const pull of pulls) {
    const login = readString(readKey(pull, "author"), "login") ?? "";
    if (!login.includes("dependabot") && !login.includes("renovate")) {
      continue;
    }
    const title = readString(pull, "title") ?? "";
    const branch = readString(pull, "headRefName") ?? "";
    const { pkg, from, to } = parseVersions(title);
    const { state, failing } = checkSummary(readArray(pull, "statusCheckRollup"));
    rows.push({
      number: Number(readKey(pull, "number") ?? 0),
      title,
      url: readString(pull, "url") ?? "",
      branch,
      package: pkg,
      from,
      to,
      level: semverLevel(from, to),
      ecosystem: ecosystemOf(branch),
      mergeState: readString(pull, "mergeStateStatus") ?? "?",
      checks: state,
      failingChecks: failing,
      files: readArray(pull, "files")
        .map((file) => readString(file, "path") ?? "")
        .filter((path) => path !== ""),
    });
  }
  rows.sort((left, right) => left.number - right.number);
  return rows;
}

/**
 * Map each file touched by more than one pull request to those pull requests.
 *
 * @param {readonly Row[]} rows - Triage rows.
 * @returns {Map<string, number[]>} Contested paths, in insertion order.
 */
export function contestedFiles(rows) {
  /** @type {Map<string, number[]>} */
  const seen = new Map();
  for (const row of rows) {
    for (const path of row.files) {
      seen.set(path, [...(seen.get(path) ?? []), row.number]);
    }
  }
  return new Map([...seen].filter(([, numbers]) => numbers.length > 1));
}

/**
 * Print the human-readable triage table.
 *
 * @param {readonly Row[]} rows - Triage rows.
 * @returns {void}
 */
function report(rows) {
  console.log(`${String(rows.length)} open bot PR(s)`);
  console.log("");
  for (const row of rows) {
    console.log(
      `  #${String(row.number).padEnd(4)} [${row.ecosystem.padEnd(14)}] ` +
        `${row.level.padEnd(7)} checks=${row.checks.padEnd(8)} merge=${row.mergeState}`,
    );
    console.log(`        ${row.title}`);
    if (row.failingChecks.length > 0) {
      console.log(`        FAILING: ${row.failingChecks.join(", ")}`);
    }
    console.log(`        files: ${row.files.join(", ") || "(none)"}`);
  }
  const contested = contestedFiles(rows);
  if (contested.size > 0) {
    console.log("");
    console.log("Overlapping files (favor a combined branch):");
    for (const [path, numbers] of contested) {
      console.log(`  ${path}: ${numbers.map((n) => `#${String(n)}`).join(", ")}`);
    }
  }
}

/**
 * Survey the pull requests and emit the requested format.
 *
 * @param {readonly string[]} argv - Command line arguments.
 * @returns {number} The process exit code.
 */
export function main(argv) {
  const asJson = argv.includes("--json");
  /** @type {Row[]} */
  let rows;
  try {
    rows = collect();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
  } else if (rows.length === 0) {
    console.log("No open Dependabot/Renovate PRs.");
  } else {
    report(rows);
  }
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
