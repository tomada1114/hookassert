/**
 * The `github` reporter: GitHub Actions `::error`/`::notice` workflow-command
 * annotations, sourced from a hook's own `Provenance` rather than a
 * re-derived text search.
 *
 * @remarks
 * Static layer: pure string formatting — no I/O, no process, no write.
 * `explain` has no failure/finding concept of its own (it is descriptive,
 * not adversarial), so `renderGithub` emits only the leading header line for
 * an `ExplainReport` today; a `test` failure or a `lint` `Finding` (neither
 * landed yet) maps its own `file`/`line` into a {@link ReportFinding} and
 * renders it with {@link renderGithubFinding} — this module never needs to
 * know either shape.
 */

import type { ExplainReport, ReportHeader } from "./summary.js";

/**
 * One line a reporter attaches to an exact source location, decoupled from
 * `ResolvedHook` and a future lint `Finding`.
 *
 * @remarks
 * `file`/`line` are read directly off the source's own provenance (a hook's
 * `Provenance`, or a `Finding`'s own `file`/`line`) — never re-derived by
 * scanning the settings file's text afterward.
 */
export interface ReportFinding {
  /** Absolute or workspace-relative path of the file the finding is about. */
  readonly file: string;
  /** 1-based line the finding points at. */
  readonly line: number;
  /** The rule id or case name GitHub Actions shows as the annotation title. */
  readonly title: string;
  /** Human-readable explanation, shown as the annotation body. */
  readonly message: string;
}

/**
 * Make `file` safe to pass as a GitHub Actions annotation's `file=` property.
 *
 * @remarks
 * GitHub Actions resolves an annotation's `file` relative to the repository
 * checkout root (`GITHUB_WORKSPACE`); an absolute path from `Provenance.file`
 * does not match any path in the PR diff view, so the annotation would
 * silently fail to attach to a line rather than erroring loudly. Forward
 * slashes are used even off POSIX, since GitHub's own parser expects them
 * regardless of the runner's OS.
 */
export function relativizeForGithub(file: string, workspaceRoot: string): string {
  const isAbsolute = file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file);
  const normalizedFile = file.split("\\").join("/");
  if (!isAbsolute) {
    return normalizedFile;
  }
  const isWindowsPath = /^[A-Za-z]:\//.test(normalizedFile);
  const normalizedRoot = workspaceRoot.split("\\").join("/");
  const root = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
  // Normalize separators on both sides before comparing — a Windows caller may
  // pass `file` or `workspaceRoot` (or both) with backslashes, and comparing
  // before normalizing means a Windows absolute path never matches its root.
  // Windows paths also compare case-insensitively, since its filesystem is.
  const matches = isWindowsPath
    ? normalizedFile.toLowerCase().startsWith(root.toLowerCase())
    : normalizedFile.startsWith(root);
  return matches ? normalizedFile.slice(root.length) : normalizedFile;
}

/**
 * Escape the characters GitHub Actions' workflow-command parser treats
 * specially inside a `key=value` property, per its documented escaping rules.
 */
function escapeProperty(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
}

/** Escape the characters GitHub Actions' workflow-command parser treats specially inside the message body. */
function escapeData(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

/**
 * Render one {@link ReportFinding} as a single GitHub Actions `::error`
 * workflow command, in the form
 * `::error file=<settings file>,line=<line>,title=<rule or case>::<message>`.
 */
export function renderGithubFinding(
  finding: ReportFinding,
  workspaceRoot: string,
): string {
  const file = escapeProperty(relativizeForGithub(finding.file, workspaceRoot));
  const title = escapeProperty(finding.title);
  return `::error file=${file},line=${String(finding.line)},title=${title}::${escapeData(finding.message)}`;
}

/**
 * Render the one leading informational line every `github` format output
 * carries, with the same header facts `pretty`'s free text and `json`'s
 * structured fields print.
 */
export function renderGithubHeader(header: ReportHeader): string {
  const notices =
    header.notices.length > 0 ? `; Notices: ${header.notices.join("; ")}` : "";
  return escapeData(
    `::notice title=hookassert::Claude Code version: ${header.claudeVersion}; ` +
      `Spec range: ${header.specRange}${notices}`,
  );
}

/**
 * Render an {@link ExplainReport} as GitHub Actions workflow commands: the
 * leading header line, plus one `::error` per relevant finding.
 *
 * @remarks
 * `explain` produces no findings of its own in this issue — it has nothing
 * to assert pass or fail against, unlike a `test` case or a `lint` rule — so
 * today's output is the header line alone, and takes no `workspaceRoot`
 * because it never relativizes a path. `test`/`lint` route their own
 * failures/findings through {@link renderGithubFinding} directly once they
 * exist, passing their own `workspaceRoot`, rather than through this
 * function, since neither's result shape is `ExplainReport`.
 */
export function renderGithub(report: ExplainReport): string {
  return `${renderGithubHeader(report.header)}\n`;
}
