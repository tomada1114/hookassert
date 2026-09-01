/**
 * Static, zero-spawn resolution of a hook command's target executable, and
 * the small filesystem checks the command rules run against it once
 * resolved.
 *
 * @remarks
 * Static layer: every check here is a `node:fs` stat/access/read call —
 * never a spawned process. `lint`'s own zero-spawn guarantee (see this
 * issue's "Not in scope" note) rules out the one thing that would actually
 * prove a command can start: running it. `resolveCommandTarget` proves only
 * what a filesystem inspection can prove — that the target exists and, once
 * resolved, whether it carries the executable bit or a shebang line — never
 * whether the process it names would actually launch successfully.
 *
 * `spawnFormFor` mirrors `src/internal/exec/executor.ts`'s own
 * `buildSpawnRequest` (`hook.args === undefined` selects shell form), without
 * importing it: `exec/` is the dynamic layer, and `src/internal/lint/**`
 * cannot import it (`eslint.config.mjs`'s
 * `boundaries/static-does-not-reach-dynamic`) — see this module's own
 * directory, `src/internal/lint/`, which the static layer's `STATIC_LAYER`
 * list in that config already includes. The one-line classifier is
 * duplicated here rather than shared through an import, since the two
 * modules otherwise have nothing else in common.
 */

import { accessSync, constants as fsConstants, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { LintHookCommand } from "./types.js";

/** Which spawn form Claude Code would use to launch `command`. */
export type SpawnForm = "shell" | "exec";

/**
 * `command.args === undefined` selects shell form (`sh -c "<command>"`); a
 * present `args` array — including an explicitly empty one — selects exec
 * form, with no shell involved. Mirrors `executor.ts`'s `buildSpawnRequest`.
 */
export function spawnFormFor(command: LintHookCommand): SpawnForm {
  return command.args === undefined ? "shell" : "exec";
}

/**
 * The project root a relative command path resolves against: the parent of
 * the `.claude/` directory the settings file sits in, when the file's own
 * containing directory is actually named `.claude` (the real convention
 * `settings/discover.ts` builds); otherwise the settings file's own
 * containing directory, which keeps a `tests/fixtures/lint/<rule-id>/`
 * fixture — not itself nested under a `.claude/` directory — resolvable
 * against its own directory instead of failing to find a project root at
 * all.
 */
export function projectRootFor(settingsFile: string): string {
  const dir = path.dirname(settingsFile);
  return path.basename(dir) === ".claude" ? path.dirname(dir) : dir;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const LEADING_WORD = /^\s*(?:"([^"]*)"|'([^']*)'|(\S+))/;

/**
 * The first shell "word" of `commandLine` that is not a leading
 * `NAME=value` environment assignment — a best-effort approximation of the
 * command a shell would actually try to execute, not a full shell parse.
 */
export function extractShellTarget(commandLine: string): string | undefined {
  let rest = commandLine;
  for (;;) {
    const match = LEADING_WORD.exec(rest);
    if (match === null) {
      return undefined;
    }
    const word = match[1] ?? match[2] ?? match[3];
    if (word === undefined) {
      return undefined;
    }
    if (ENV_ASSIGNMENT.test(word)) {
      rest = rest.slice(match.index + match[0].length);
      continue;
    }
    return word;
  }
}

/**
 * The executable target `command` names: `command.command` itself under exec
 * form, or its leading shell word under shell form. `undefined` when no word
 * could be extracted at all (an empty or whitespace-only command, which
 * `parse.ts`'s `requireNonEmptyString` already rules out for a well-formed
 * settings file).
 */
export function commandTarget(command: LintHookCommand): string | undefined {
  if (spawnFormFor(command) === "exec") {
    return command.command;
  }
  return extractShellTarget(command.command);
}

/** Where {@link resolveCommandTarget} landed. */
export type CommandResolution =
  { readonly kind: "not-found" } | { readonly kind: "resolved"; readonly path: string };

function exists(candidate: string): boolean {
  try {
    accessSync(candidate, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `command`'s target to a real path, entirely through filesystem
 * inspection.
 *
 * @remarks
 * Follows the three cases the issue's own design settles: an absolute path
 * is checked as-is; a relative path containing a path separator (`./x.sh`,
 * `scripts/x.sh`) resolves against {@link projectRootFor}; a bare word with
 * no separator (`npx`, `jq`) is looked up on `pathEnv`, one directory at a
 * time, via `accessSync` — never by spawning it to see if it starts.
 */
export function resolveCommandTarget(
  command: LintHookCommand,
  pathEnv: string | undefined,
): CommandResolution {
  const target = commandTarget(command);
  if (target === undefined || target.length === 0) {
    return { kind: "not-found" };
  }

  if (path.isAbsolute(target)) {
    return exists(target) ? { kind: "resolved", path: target } : { kind: "not-found" };
  }

  if (target.includes("/")) {
    const resolved = path.resolve(projectRootFor(command.file), target);
    return exists(resolved)
      ? { kind: "resolved", path: resolved }
      : { kind: "not-found" };
  }

  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = path.join(dir, target);
    if (exists(candidate)) {
      return { kind: "resolved", path: candidate };
    }
  }
  return { kind: "not-found" };
}

/** Whether `resolvedPath` is a regular file — `false` for a directory, a symlink to nowhere, or a stat failure. */
export function isRegularFile(resolvedPath: string): boolean {
  try {
    return statSync(resolvedPath).isFile();
  } catch {
    return false;
  }
}

/** Whether `resolvedPath` carries the executable permission bit, from the running process's own perspective. */
export function isExecutableFile(resolvedPath: string): boolean {
  try {
    accessSync(resolvedPath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extensions `missing-shebang` treats as "this is a script, and should carry
 * a `#!` line" — deliberately narrow: a binary executable with no extension,
 * or an unrecognized one, is never flagged, since this rule cannot tell a
 * missing shebang apart from "this was never a script to begin with" for
 * those.
 */
const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".py",
  ".rb",
  ".pl",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
]);

/** Whether `resolvedPath`'s extension is one {@link SCRIPT_EXTENSIONS} recognizes. */
export function isScriptLikePath(resolvedPath: string): boolean {
  return SCRIPT_EXTENSIONS.has(path.extname(resolvedPath).toLowerCase());
}

/** Whether `resolvedPath`'s first line is a `#!` shebang. `false` for an unreadable file. */
export function hasShebangLine(resolvedPath: string): boolean {
  try {
    return readFileSync(resolvedPath, "utf8").startsWith("#!");
  } catch {
    return false;
  }
}

/**
 * The text the exit-code heuristics (`exit-1-policy`, `exit-2-overrides-allow`)
 * scan: `command.command`, its `args` joined in, and — when the command
 * resolves to a readable regular file — that file's own content, so a hook
 * that shells out to a script is inspected the same way an inline shell
 * one-liner is.
 *
 * @remarks
 * Best-effort: an unresolvable command or an unreadable script file simply
 * contributes no extra text, rather than failing the whole lint run over a
 * heuristic rule that is explicitly out-of-scope for spawning anything to
 * find out more.
 */
export function hookSourceText(
  command: LintHookCommand,
  pathEnv: string | undefined,
): string {
  const parts = [command.command, ...(command.args ?? [])];
  const resolution = resolveCommandTarget(command, pathEnv);
  if (resolution.kind === "resolved" && isRegularFile(resolution.path)) {
    try {
      parts.push(readFileSync(resolution.path, "utf8"));
    } catch {
      // Unreadable (permissions, race with a deletion) — fall back to just
      // the command/args text already collected above.
    }
  }
  return parts.join("\n");
}
