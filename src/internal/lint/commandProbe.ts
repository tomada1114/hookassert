/**
 * Static, zero-spawn resolution of a hook command's target executable, and
 * the small filesystem checks the command rules run against it once
 * resolved.
 *
 * @remarks
 * Static layer: every check here is a `node:fs` stat/access/read call —
 * never a spawned process. `lint` never spawns anything to prove a command
 * can actually start; running it is the one thing that would prove that, and
 * that is out of scope for a static check. `resolveCommandTarget` proves
 * only what a filesystem inspection can prove — that the target exists and,
 * once resolved, whether it carries the executable bit or a shebang line —
 * never whether the process it names would actually launch successfully.
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

import {
  accessSync,
  closeSync,
  constants as fsConstants,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import path from "node:path";

import type { LintContext, LintHookCommand } from "./types.js";

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

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WHITESPACE = /\s/;

/**
 * Read one leading shell "word" out of `commandLine`, starting at `start`,
 * concatenating adjacent quoted and unquoted segments the way a shell would
 * — `"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh` is one word, not the quoted
 * segment alone. Quote removal only: no backslash-escape or
 * command-substitution handling, since this is a best-effort approximation
 * of the command a shell would run, not a full shell parse.
 */
function readShellWord(
  commandLine: string,
  start: number,
): { readonly word: string; readonly end: number } | undefined {
  let i = start;
  while (i < commandLine.length && WHITESPACE.test(commandLine.charAt(i))) {
    i++;
  }
  if (i >= commandLine.length) {
    return undefined;
  }

  let word = "";
  while (i < commandLine.length && !WHITESPACE.test(commandLine.charAt(i))) {
    const char = commandLine.charAt(i);
    if (char === '"' || char === "'") {
      const closing = commandLine.indexOf(char, i + 1);
      if (closing === -1) {
        word += commandLine.slice(i + 1);
        i = commandLine.length;
        break;
      }
      word += commandLine.slice(i + 1, closing);
      i = closing + 1;
      continue;
    }
    word += char;
    i++;
  }
  return { word, end: i };
}

/**
 * Shell reserved words, special builtins, and common regular builtins that
 * are never a PATH-resolvable executable — `exit`, `cd`, `if`, `[`, and
 * friends run inside the shell itself. `resolveCommandTarget` never tries to
 * resolve one of these on `PATH`; whether it "exists" is a fact about the
 * shell, not the filesystem, and a POSIX shell always has it.
 *
 * @remarks
 * `exec` is deliberately absent: {@link extractShellTarget} already resolves
 * past a leading `exec`, to the word it launches, so `exec` itself never
 * reaches this set as a target.
 */
const SHELL_BUILTINS_AND_KEYWORDS: ReadonlySet<string> = new Set([
  // POSIX special builtins.
  ":",
  ".",
  "break",
  "continue",
  "eval",
  "exit",
  "export",
  "readonly",
  "return",
  "set",
  "shift",
  "times",
  "trap",
  "unset",
  // Common regular builtins.
  "cd",
  "command",
  "echo",
  "false",
  "getopts",
  "hash",
  "printf",
  "pwd",
  "read",
  "test",
  "true",
  "type",
  "umask",
  "wait",
  // Reserved words and grouping syntax.
  "!",
  "(",
  ")",
  "[",
  "[[",
  "]]",
  "{",
  "}",
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "select",
  "then",
  "until",
  "while",
]);

/** Whether `word` is a shell builtin or reserved word, per {@link SHELL_BUILTINS_AND_KEYWORDS}. */
export function isShellBuiltinOrKeyword(word: string): boolean {
  return SHELL_BUILTINS_AND_KEYWORDS.has(word);
}

/**
 * The first shell "word" of `commandLine` that is not a leading
 * `NAME=value` environment assignment, and not the literal `exec` — a
 * best-effort approximation of the command a shell would actually try to
 * execute, not a full shell parse.
 *
 * @remarks
 * `exec` replaces the shell with the program that follows it, so
 * `exec ./guard.sh` should resolve `./guard.sh`, not `exec` itself — the
 * same way a leading `NAME=value` assignment is skipped past to reach the
 * real command.
 */
export function extractShellTarget(commandLine: string): string | undefined {
  let index = 0;
  for (;;) {
    const read = readShellWord(commandLine, index);
    if (read === undefined) {
      return undefined;
    }
    if (ENV_ASSIGNMENT.test(read.word) || read.word === "exec") {
      index = read.end;
      continue;
    }
    return read.word;
  }
}

/**
 * The executable target `command` names: `command.command` itself under exec
 * form, or its leading shell word under shell form. `undefined` when no word
 * could be extracted at all (an empty or whitespace-only command, which
 * `parse.ts`'s `requireNonEmptyString` already rules out for a well-formed
 * settings file).
 *
 * @remarks
 * Returns the raw, unexpanded word — `"$CLAUDE_PROJECT_DIR"/x.sh` or
 * `~/.claude/hooks/x.sh` exactly as written. {@link resolveCommandTarget} is
 * where `$CLAUDE_PROJECT_DIR`/`~` expansion happens; this function stays a
 * plain extraction so a `Finding`'s "looked for ..." text can still show the
 * command the way the settings file actually declares it.
 */
export function commandTarget(command: LintHookCommand): string | undefined {
  if (spawnFormFor(command) === "exec") {
    return command.command;
  }
  return extractShellTarget(command.command);
}

/** Where {@link resolveCommandTarget} landed. */
export type CommandResolution =
  | { readonly kind: "not-found" }
  | { readonly kind: "resolved"; readonly path: string }
  /**
   * Resolution was deliberately not attempted: `target` is a shell builtin
   * or reserved word (never a PATH-resolvable executable), or still
   * contains a `$VAR`/`${VAR}` reference `resolveCommandTarget` could not
   * expand. Neither is evidence the command is broken, so
   * `command-not-found` reports nothing for it — a "not-found" here would be
   * a false positive, not a real finding.
   */
  | { readonly kind: "indeterminate" };

function exists(candidate: string): boolean {
  try {
    accessSync(candidate, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const CLAUDE_PROJECT_DIR_REF = /\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR/g;
const UNEXPANDED_VAR_REF = /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Expand the two forms of indirection Claude Code's own documentation
 * recommends inside a hook command — `$CLAUDE_PROJECT_DIR`/
 * `${CLAUDE_PROJECT_DIR}` to `projectRoot` (the same value
 * `buildHookEnv` in `exec/executor.ts` synthesizes for a real run), and a
 * leading `~/` to `homeDir` — before any filesystem check runs.
 *
 * @remarks
 * Returns `undefined` — "do not attempt resolution" — whenever the result
 * would still be a guess: a leading `~/` with no known `homeDir`, or any
 * other `$VAR`/`${VAR}` reference left over once the known substitutions are
 * applied. Reporting "not found" for either case would be a false positive,
 * not a real finding.
 */
function expandTarget(
  target: string,
  projectRoot: string,
  homeDir: string | undefined,
): string | undefined {
  let expanded = target.replace(CLAUDE_PROJECT_DIR_REF, projectRoot);

  if (expanded.startsWith("~/")) {
    if (homeDir === undefined) {
      return undefined;
    }
    expanded = path.join(homeDir, expanded.slice(2));
  }

  return UNEXPANDED_VAR_REF.test(expanded) ? undefined : expanded;
}

function computeCommandResolution(
  command: LintHookCommand,
  ctx: LintContext,
): CommandResolution {
  const target = commandTarget(command);
  if (target === undefined || target.length === 0) {
    return { kind: "not-found" };
  }

  if (spawnFormFor(command) === "shell" && isShellBuiltinOrKeyword(target)) {
    return { kind: "indeterminate" };
  }

  const expanded = expandTarget(target, ctx.projectRoot, ctx.homeDir);
  if (expanded === undefined) {
    return { kind: "indeterminate" };
  }

  if (path.isAbsolute(expanded)) {
    return exists(expanded)
      ? { kind: "resolved", path: expanded }
      : { kind: "not-found" };
  }

  if (expanded.includes("/")) {
    const resolved = path.resolve(ctx.projectRoot, expanded);
    return exists(resolved)
      ? { kind: "resolved", path: resolved }
      : { kind: "not-found" };
  }

  for (const dir of (ctx.pathEnv ?? "").split(path.delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = path.join(dir, expanded);
    if (exists(candidate)) {
      return { kind: "resolved", path: candidate };
    }
  }
  return { kind: "not-found" };
}

/**
 * Per-command resolution cache, keyed by the `LintHookCommand` object
 * `parse.ts` produced for it. A lint run resolves each command's target only
 * once even though several rules (`command-not-found`, `missing-shebang`,
 * `not-executable`, and — through `hookSourceText` — `exit-1-policy` and
 * `exit-2-overrides-allow`) all need it. The cached `ctx` is checked on
 * lookup so a `command` object reused against a different `LintContext`
 * (as a handful of tests do) still recomputes rather than returning a stale
 * answer.
 */
const resolutionCache = new WeakMap<
  LintHookCommand,
  { readonly ctx: LintContext; readonly resolution: CommandResolution }
>();

/**
 * Resolve `command`'s target to a real path, entirely through filesystem
 * inspection.
 *
 * @remarks
 * Follows the three cases the command rules need: an absolute path is
 * checked as-is; a relative path containing a path separator (`./x.sh`,
 * `scripts/x.sh`) resolves against `ctx.projectRoot`; a bare word with no
 * separator (`npx`, `jq`) is looked up on `ctx.pathEnv`, one directory at a
 * time, via `accessSync` — never by spawning it to see if it starts. Before
 * any of that, `$CLAUDE_PROJECT_DIR`/`${CLAUDE_PROJECT_DIR}` and a leading
 * `~/` are expanded, and a shell builtin or reserved word is recognized as
 * such rather than looked up on `PATH` — see {@link expandTarget} and
 * {@link isShellBuiltinOrKeyword}.
 */
export function resolveCommandTarget(
  command: LintHookCommand,
  ctx: LintContext,
): CommandResolution {
  const cached = resolutionCache.get(command);
  if (cached?.ctx === ctx) {
    return cached.resolution;
  }
  const resolution = computeCommandResolution(command, ctx);
  resolutionCache.set(command, { ctx, resolution });
  return resolution;
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
 * The most of a resolved script's own text {@link hookSourceText} reads —
 * enough for the exit-code heuristics' regexes, without reading an
 * arbitrarily large file in full.
 */
const MAX_SOURCE_READ_BYTES = 64 * 1024;

/** Read up to {@link MAX_SOURCE_READ_BYTES} of `filePath`, as UTF-8. Throws on any read failure. */
function readLeadingBytes(filePath: string, maxBytes: number): string {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

/**
 * The text the exit-code heuristics (`exit-1-policy`, `exit-2-overrides-allow`)
 * scan: `command.command`, its `args` joined in, and — when the command
 * resolves to a script-like regular file — up to
 * {@link MAX_SOURCE_READ_BYTES} of that file's own content, so a hook that
 * shells out to a script is inspected the same way an inline shell
 * one-liner is.
 *
 * @remarks
 * Best-effort: an unresolvable command, a resolved target that is not
 * script-like (`isScriptLikePath`), or an unreadable script file simply
 * contributes no extra text, rather than failing the whole lint run over a
 * heuristic rule that is explicitly out-of-scope for spawning anything to
 * find out more. Skipping a non-script-like target matters beyond
 * correctness: reading an interpreter binary in full (a hook that shells
 * out to `node`, `python3`, or `jq`) would cost a full binary read per exit
 * rule for no benefit, since neither regex can match binary content anyway.
 */
export function hookSourceText(command: LintHookCommand, ctx: LintContext): string {
  const parts = [command.command, ...(command.args ?? [])];
  const resolution = resolveCommandTarget(command, ctx);
  if (
    resolution.kind === "resolved" &&
    isScriptLikePath(resolution.path) &&
    isRegularFile(resolution.path)
  ) {
    try {
      parts.push(readLeadingBytes(resolution.path, MAX_SOURCE_READ_BYTES));
    } catch {
      // Unreadable (permissions, race with a deletion) — fall back to just
      // the command/args text already collected above.
    }
  }
  return parts.join("\n");
}
