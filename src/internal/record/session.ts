/**
 * `record`'s own filesystem bookkeeping: starting a capture session (writing
 * the capture script, inserting its hook entries, and recording a pre-image)
 * and stopping one (removing the hook entries and verifying a zero diff).
 *
 * @remarks
 * Dynamic layer: this is the only module in `record/` — alongside
 * `capture.ts`, which itself performs no I/O — that reads or writes a file.
 * `settings/edit.ts`'s `insertCaptureHook`/`removeCaptureHook` stay pure
 * `text -> text` functions; everything here is what reads a file's text
 * before calling them, writes the result back, and persists the session
 * bookkeeping those pure functions cannot know about on their own — the
 * SHA-256 pre-image, in particular, is computed here, before
 * `insertCaptureHook` writes anything, exactly as this issue's design
 * requires.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

import { RecordNoSessionError, RecordRestoreError, UsageError } from "../errors.js";
import {
  insertCaptureHook,
  removeCaptureHook,
  type CaptureAnchors,
  type CaptureHookEntry,
} from "../settings/index.js";
import type { EventName } from "../../types.js";
import { buildCaptureScript, CAPTURE_SCRIPT_FILENAME } from "./capture.js";

/** The project-local directory every piece of `record`'s own state lives under, never inside `.claude/`. */
const HOOKASSERT_DIR_NAME = ".hookassert";

/** Default subdirectory of {@link HOOKASSERT_DIR_NAME} captured payloads land in when `--capture-dir` is not given. */
const DEFAULT_CAPTURES_SUBDIR = "captures";

const SESSION_FILE_NAME = "record-session.json";

const LAST_VERSION_FILE_NAME = "last-recorded-version.json";

/** The settings layer `record` edits: the smallest blast-radius layer, per-user and conventionally gitignored. */
function targetSettingsFile(cwd: string): string {
  return path.join(cwd, ".claude", "settings.local.json");
}

/** Absolute path of `record`'s own state directory, `.hookassert/` at the project root. */
export function hookassertDir(cwd: string): string {
  return path.join(cwd, HOOKASSERT_DIR_NAME);
}

/** Absolute path of the session file `record` writes on start and reads (and removes) on `--stop`. */
export function sessionFilePath(cwd: string): string {
  return path.join(hookassertDir(cwd), SESSION_FILE_NAME);
}

/**
 * Whether a capture session is currently active for `cwd`.
 *
 * @remarks
 * `src/cli.ts` uses this to refuse starting a second session on top of one
 * already running: `startRecordSession` always inserts against whatever the
 * settings file currently holds, so starting twice without an intervening
 * `--stop` would insert a second matcher group next to the first one's
 * still-active leftovers instead of replacing it — a confusing state
 * `stopRecordSession`'s divergence report would otherwise have to explain
 * after the fact.
 */
export function isRecordSessionActive(cwd: string): boolean {
  return existsSync(sessionFilePath(cwd));
}

/** Absolute path of the default capture directory, used when `--capture-dir` is not given. */
export function defaultCaptureDir(cwd: string): string {
  return path.join(hookassertDir(cwd), DEFAULT_CAPTURES_SUBDIR);
}

/**
 * Absolute path of the file the capture script itself writes the most
 * recently captured, known `claudeVersion` to.
 *
 * @remarks
 * Exported so `#11`'s later "last recorded session's version" resolution
 * step is a one-line change: read this path with
 * {@link readLastRecordedClaudeVersion} rather than re-deriving it. See this
 * issue's own `UNRESOLVED` note on why the wiring itself stops here.
 */
export function lastRecordedClaudeVersionPath(cwd: string): string {
  return path.join(hookassertDir(cwd), LAST_VERSION_FILE_NAME);
}

/**
 * Read the `claudeVersion` the capture script most recently wrote, if any.
 *
 * @remarks
 * Returns `undefined` for every way this can be unavailable — the file does
 * not exist yet (no capture has landed a known version), or it exists but is
 * not the shape this module itself writes — rather than throwing: a later
 * `#11` version-resolution step that reads this is meant to fall through to
 * `"undetermined"`, not fail the run over a missing or stale bookkeeping file.
 */
export function readLastRecordedClaudeVersion(cwd: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(lastRecordedClaudeVersionPath(cwd), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "claudeVersion" in parsed &&
      typeof parsed.claudeVersion === "string"
    ) {
      return parsed.claudeVersion;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const FRESH_SETTINGS_TEMPLATE =
  '{\n  "$comment": "Created by `hookassert record`. Safe to keep after recording - ' +
  '.claude/settings.local.json is a per-user settings layer that is typically gitignored."\n}\n';

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function readTextOrUndefined(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw error;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The session bookkeeping persisted to {@link sessionFilePath}, and read back by `--stop`. */
interface RecordSessionFile {
  readonly settingsFile: string;
  readonly preImageText: string;
  readonly preImageSha256: string;

  /**
   * SHA-256 of the settings text `startRecordSession` itself wrote —
   * `insertCaptureHook`'s own output — before anything else could have
   * touched it.
   *
   * @remarks
   * `stopRecordSession` compares the settings file's current text against
   * this first: a match means nothing has touched the file since `record`
   * itself wrote it, so writing {@link preImageText} back verbatim is a
   * guaranteed byte-for-byte restore. Re-deriving the pre-image by inverting
   * the insert through `removeCaptureHook` instead cannot make that promise —
   * `jsonc-parser`'s `modify` reformats neighbouring nodes on insert, so
   * inverting it does not reliably reproduce text that was never in
   * `insertCaptureHook`'s own canonical two-space style to begin with.
   */
  readonly postImageSha256: string;

  readonly anchors: CaptureAnchors;
  readonly createdFresh: boolean;
}

function isRecordSessionFile(value: unknown): value is RecordSessionFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Partial<Record<keyof RecordSessionFile, unknown>>;
  return (
    typeof v.settingsFile === "string" &&
    typeof v.preImageText === "string" &&
    typeof v.preImageSha256 === "string" &&
    typeof v.postImageSha256 === "string" &&
    typeof v.createdFresh === "boolean" &&
    typeof v.anchors === "object" &&
    v.anchors !== null
  );
}

/** What `startRecordSession` needs to build one project's capture plan and write its bookkeeping. */
export interface StartRecordOptions {
  /** Directory `.claude/settings.local.json` and `.hookassert/` are resolved against. */
  readonly cwd: string;

  /** Every event to insert a capture-hook matcher group for, already resolved and validated by the caller. */
  readonly events: readonly EventName[];

  /** How to build each event's matcher group, from the loaded spec's own `matcherTargets`. */
  readonly matcherForEvent: (event: EventName) => string | undefined;

  /** Absolute path of the directory captured payloads land in; `undefined` selects {@link defaultCaptureDir}. */
  readonly captureDir: string | undefined;

  /** Baked into the generated capture script as its own fallback `claudeVersion`. */
  readonly claudeVersionFlag: string | undefined;
}

/** What `startRecordSession` reports back, for `record`'s own stdout. */
export interface RecordSessionInfo {
  readonly settingsFile: string;
  readonly captureScript: string;
  readonly captureDir: string;
  readonly events: readonly EventName[];
  readonly createdFresh: boolean;
}

/**
 * Start a capture session: write the capture script, insert its hook entries
 * into the target settings file, and persist the pre-image `--stop` restores
 * against.
 *
 * @remarks
 * The SHA-256 in {@link RecordSessionFile.preImageSha256} is computed from
 * `preImageText` before any write happens — including before the capture
 * script itself is written — so it can never reflect anything other than the
 * exact text `insertCaptureHook` was given.
 *
 * `insertCaptureHook` (which validates and edits `preImageText`) is called
 * before anything is written to disk at all, including the capture script
 * itself: a malformed settings file must fail cleanly rather than leaving a
 * half-started session behind. The session file is then written to a
 * temporary name and renamed into place only after the settings file write
 * has succeeded, so a failure between the two writes cannot leave an
 * orphaned capture hook that `stopRecordSession` has no session file to find.
 * The `preImageText.includes(captureScript)` check below is the other half
 * of that guarantee: it catches the orphan itself, on a later `start`, even
 * if a failure ever does slip through.
 *
 * @throws {UsageError} `preImageText` already declares the capture-hook
 * command with no active session bookkeeping to match it — the settings file
 * side of a previous `record` run that failed before its session file was
 * finalized.
 * (Also propagates `SettingsParseError` from `insertCaptureHook` when
 * `preImageText` cannot be parsed or edited.)
 */
export function startRecordSession(options: StartRecordOptions): RecordSessionInfo {
  const settingsFile = targetSettingsFile(options.cwd);
  const existingText = readTextOrUndefined(settingsFile);
  const createdFresh = existingText === undefined;
  const preImageText = existingText ?? FRESH_SETTINGS_TEMPLATE;
  const preImageSha256 = sha256(preImageText);

  const stateDir = hookassertDir(options.cwd);
  const captureScript = path.join(stateDir, CAPTURE_SCRIPT_FILENAME);

  if (preImageText.includes(captureScript)) {
    throw new UsageError(
      `${settingsFile} already declares the capture-hook command (${captureScript}), but no ` +
        `recording session is active for ${options.cwd}. A previous \`record\` run likely ` +
        `failed partway through. Remove that hook entry from ${settingsFile} by hand, then ` +
        "run `record` again.",
    );
  }

  const entries: CaptureHookEntry[] = options.events.map((event) => ({
    event,
    matcher: options.matcherForEvent(event),
  }));
  const { text: newSettingsText, anchors } = insertCaptureHook(preImageText, {
    file: settingsFile,
    command: captureScript,
    entries,
  });
  const postImageSha256 = sha256(newSettingsText);

  const captureDir =
    options.captureDir === undefined
      ? defaultCaptureDir(options.cwd)
      : path.resolve(options.cwd, options.captureDir);
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(captureDir, { recursive: true });

  const scriptText = buildCaptureScript({
    captureDir,
    claudeVersionFlag: options.claudeVersionFlag,
    lastVersionFile: lastRecordedClaudeVersionPath(options.cwd),
  });
  writeFileSync(captureScript, scriptText, "utf8");
  chmodSync(captureScript, 0o755);

  const sessionFile: RecordSessionFile = {
    settingsFile,
    preImageText,
    preImageSha256,
    postImageSha256,
    anchors,
    createdFresh,
  };
  const finalSessionPath = sessionFilePath(options.cwd);
  const tempSessionPath = `${finalSessionPath}.tmp-${String(process.pid)}-${String(Date.now())}`;
  writeFileSync(tempSessionPath, JSON.stringify(sessionFile, null, 2), "utf8");

  mkdirSync(path.dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, newSettingsText, "utf8");

  renameSync(tempSessionPath, finalSessionPath);

  return {
    settingsFile,
    captureScript,
    captureDir,
    events: options.events,
    createdFresh,
  };
}

/** What `stopRecordSession` reports back once the inverse edit has been applied and verified clean. */
export interface StopRecordResult {
  readonly settingsFile: string;
}

/**
 * Stop the active capture session: restore the settings file, and verify the
 * result is byte-for-byte identical to the stored pre-image.
 *
 * @remarks
 * The common case is a guaranteed byte-for-byte restore: when the settings
 * file's current text still matches {@link RecordSessionFile.postImageSha256}
 * (nothing touched it since `startRecordSession` itself wrote it), the stored
 * {@link RecordSessionFile.preImageText} is written back verbatim, rather
 * than re-derived by inverting the insert through `removeCaptureHook`. That
 * inversion goes through `jsonc-parser`'s `modify`, which reformats
 * neighbouring nodes on insert — an inline single-line hook group, tab
 * indentation, or compact JSON in the original file would otherwise never
 * round-trip byte-identical, even with no user edit at all.
 *
 * Only when the settings file has diverged from what `record` itself wrote —
 * a real hand edit while recording was active — does this fall back to
 * `removeCaptureHook`'s best-effort inverse edit, written back unconditionally
 * before the byte-for-byte check against the pre-image is even made, so a
 * caller who only reads the thrown error's message still finds the capture
 * hook already removed.
 *
 * The session file itself is always removed once a session was found, in
 * either branch: a stopped session is over either way, and a second `--stop`
 * must find nothing active to restore.
 *
 * @throws {RecordNoSessionError} no session file was found at
 * {@link sessionFilePath}.
 * @throws {RecordRestoreError} a session file was found but could not be
 * used (unparseable JSON, or missing required fields), or the fallback
 * inverse edit's result does not match the stored pre-image byte-for-byte
 * (the settings file was edited by hand while recording was active) — in
 * the last case, the mismatch is reported only after the capture hook has
 * already been removed from the file on disk.
 */
export function stopRecordSession(cwd: string): StopRecordResult {
  const sessionPath = sessionFilePath(cwd);
  const sessionText = readTextOrUndefined(sessionPath);
  if (sessionText === undefined) {
    throw new RecordNoSessionError(sessionPath);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(sessionText);
  } catch (error) {
    throw new RecordRestoreError(
      sessionPath,
      `the session file could not be parsed as JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isRecordSessionFile(parsed)) {
    throw new RecordRestoreError(
      sessionPath,
      "the session file is missing required fields and cannot be restored from.",
    );
  }

  const currentText = readTextOrUndefined(parsed.settingsFile) ?? "";

  if (sha256(currentText) === parsed.postImageSha256) {
    writeFileSync(parsed.settingsFile, parsed.preImageText, "utf8");
    if (existsSync(sessionPath)) {
      rmSync(sessionPath);
    }
    return { settingsFile: parsed.settingsFile };
  }

  const restoredText = removeCaptureHook(currentText, parsed.anchors);
  writeFileSync(parsed.settingsFile, restoredText, "utf8");

  // The session is over either way: a diverged stop still consumes the
  // session, so a second `--stop` correctly reports "no active session"
  // rather than re-attempting a restore that already happened.
  if (existsSync(sessionPath)) {
    rmSync(sessionPath);
  }

  const matches = sha256(restoredText) === parsed.preImageSha256;
  if (!matches) {
    throw new RecordRestoreError(
      sessionPath,
      `the capture hook was removed from ${parsed.settingsFile}, but its other content no ` +
        "longer matches its pre-recording state - it looks like the file was edited while " +
        "recording was active. Nothing was overwritten: review the file yourself to confirm " +
        "your edits are intact.",
    );
  }

  return { settingsFile: parsed.settingsFile };
}
