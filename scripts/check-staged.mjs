#!/usr/bin/env node
// Pre-commit gate: refuse a commit that would put a secret into history, from
// the git index alone — no tool call, no running agent.
//
// The scope is deliberately narrow. This hook only blocks what is wrong no
// matter who decided it: a secret-shaped path (`.env`, `secrets/**`) or a
// credential in the content of a staged file. Everything else a commit might
// do — deleting a workflow, relaxing a config, lowering a threshold — is a
// judgement call, and a judgement call belongs in the pull request, where a
// reader can weigh it and disagree. A hook cannot.
//
// That narrowness is the point rather than a gap. A hook that blocks
// legitimate work teaches its author to reach for `--no-verify`, and that flag
// turns off the secret check along with everything else. This one should never
// have a reason to fire on work someone meant to do.
//
// This script sees what actually reaches `git commit`, from any author — a
// human, Codex, or any other tool. Two rules are deliberately not folded in
// here, because a git diff cannot express them:
//
//   - Lockfile hand-editing. A regenerated lockfile (`pnpm install`) is an
//     ordinary, expected commit, and a git diff cannot tell that apart from a
//     hand edit — only a layer that sees the tool call that produced the
//     change could, and no such layer is enforced by this repository.
//   - `git commit --no-verify`, a bare force-push, and publish/workflow
//     dispatch leave nothing in a diff for this script to see. `--no-verify`
//     in particular disables this script along with the rest of the git hook
//     chain, so no git hook can catch it. These stay as instructions in
//     AGENTS.md rather than an enforced block — see its "Enforcement layers".
//
// Exit codes:
//   0  every staged change is safe to commit
//   1  a staged change was blocked
import { spawnSync } from "node:child_process";
import console from "node:console";
import process from "node:process";

import { checkCredentials } from "./lib/guard/credentials.mjs";
import { checkRead, describePath } from "./lib/guard/paths.mjs";
import { isMain } from "./lib/is-main.mjs";
import { repoRoot } from "./lib/node-tools.mjs";

/**
 * One line of `git diff --cached --name-status`.
 *
 * @typedef {object} StagedChange
 * @property {string} status - The first letter of the status code (`A`,
 * `M`, `D`, `T`, `C` — renames are disabled, so `R` never appears).
 * @property {string} path - Path relative to the repository root.
 */

/**
 * Run git and return its stdout, throwing on a non-zero exit.
 *
 * @param {readonly string[]} args - Arguments after `git`.
 * @param {string} cwd - Repository to run git in.
 * @returns {string} Standard output.
 */
function git(args, cwd) {
  // This one inherits GIT_*, unlike everything else that spawns git here — see
  // scripts/lib/git-env.mjs. `git commit -- <path>` hands its pre-commit hook a
  // *temporary* index through GIT_INDEX_FILE, and that index, not the default
  // one, is what this layer was invoked to judge. Its own tests clear the
  // variables instead, so a fixture repository is decided by `cwd`.
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  // `status` is null when git never ran or was killed — a missing binary, or
  // output past maxBuffer. Reporting "exited null" with an empty stderr would
  // tell the reader nothing about which of those happened.
  if (result.error !== undefined) {
    throw new Error(
      `ERR_GIT_UNAVAILABLE: git ${args.join(" ")} could not be run to completion.\n` +
        `Actual: ${result.error.message}\n` +
        "Next: check that git is on PATH and that the staged file is not larger than 32 MiB.",
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `ERR_GIT_FAILED: git ${args.join(" ")} exited ${String(result.status)}.\n` +
        `Actual: ${result.stderr}`,
    );
  }
  return result.stdout;
}

/**
 * List the changes currently staged for commit.
 *
 * @param {string} [cwd] - Repository to inspect; defaults to this repository.
 * @returns {StagedChange[]}
 */
export function stagedChanges(cwd = repoRoot) {
  const output = git(["diff", "--cached", "--name-status", "--no-renames", "-z"], cwd);
  /** @type {StagedChange[]} */
  const changes = [];
  const fields = output.split("\0").filter((field) => field !== "");
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const path = fields[index + 1];
    if (status === undefined || path === undefined) {
      continue;
    }
    changes.push({ status: status.charAt(0), path });
  }
  return changes;
}

/**
 * Read a staged file's content as it will be committed.
 *
 * @param {string} path - Path relative to the repository root.
 * @param {string} cwd - Repository the path is staged in.
 * @returns {string} The staged blob's content.
 */
function readStaged(path, cwd) {
  return git(["show", `:${path}`], cwd);
}

/**
 * Suffixes and basenames that mark a private-key-shaped file, whatever its
 * content looks like. A key file is refused on its path alone: a
 * `.pem`/`.p12`/`.pfx`/`.key`/`.ppk` container or an OpenSSH key basename can
 * be binary, encrypted, or otherwise not textually credential-shaped, so
 * `checkCredentials`'s content patterns cannot be relied on to catch it.
 * Matched case-insensitively (`.PEM` is exactly as real a container as
 * `.pem`), against a lowercased basename.
 *
 * @type {readonly string[]}
 */
const KEY_FILE_SUFFIXES = [".pem", ".p12", ".pfx", ".key", ".ppk"];

/**
 * The OpenSSH default key basenames — every `-t` key type `ssh-keygen`
 * produces, plus its FIDO/security-key (`_sk`) variants.
 *
 * @type {readonly string[]}
 */
const KEY_FILE_BASENAMES = [
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ecdsa_sk",
  "id_ed25519",
  "id_ed25519_sk",
];

/**
 * Return whether a path's basename looks like a private key file.
 *
 * @param {string} filePath - Path relative to the repository root.
 * @returns {boolean} True when the basename matches a key-file shape.
 */
function isKeyFilePath(filePath) {
  const { name } = describePath(filePath);
  const lowerName = name.toLowerCase();
  return (
    KEY_FILE_SUFFIXES.some((suffix) => lowerName.endsWith(suffix)) ||
    KEY_FILE_BASENAMES.includes(lowerName)
  );
}

/**
 * Check one staged change against every rule this script enforces.
 *
 * @param {StagedChange} change - One entry from {@link stagedChanges}.
 * @param {string} [cwd] - Repository the change is staged in; defaults to
 * this repository.
 * @returns {string | null} The block reason, or null when the change is safe.
 */
export function checkStagedChange(change, cwd = repoRoot) {
  // A deletion has no content to inspect, and whether removing a file is a
  // good idea is a question for the pull request, not for a hook that cannot
  // be reasoned with.
  if (change.status === "D") {
    return null;
  }

  // Reuses the same .env*/secrets/** classification checkRead applies to an
  // agent's Read call — the rule is "this path is secret-shaped", independent
  // of who or what is about to expose it. Decided before the blob is read, so
  // a secret file's content is never pulled into this process to reach a
  // verdict the path alone already gives.
  if (checkRead(change.path) !== null) {
    return `${change.path} looks like it holds secrets and must not be committed. Add it to .gitignore instead, or commit a .example/.sample/.template variant.`;
  }

  // A private-key file's path alone is enough to refuse it — its bytes may be
  // binary or encrypted, so it cannot be relied on to trip checkCredentials.
  if (isKeyFilePath(change.path)) {
    return `${change.path} looks like a private key file and must not be committed. Keep it out of the repository entirely.`;
  }

  const after = readStaged(change.path, cwd);

  return checkCredentials(after);
}

/**
 * Check every staged change and report every violation found.
 *
 * @param {string} [cwd] - Repository to inspect; defaults to this repository.
 * @returns {number} The process exit code: 1 blocks the commit, 0 allows it.
 */
export function main(cwd = repoRoot) {
  let blocked = false;
  for (const change of stagedChanges(cwd)) {
    const reason = checkStagedChange(change, cwd);
    if (reason !== null) {
      console.error(`Blocked: ${reason}`);
      blocked = true;
    }
  }
  return blocked ? 1 : 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = main();
}
