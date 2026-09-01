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
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { RecordRestoreError } from "../errors.js";
import {
  insertCaptureHook,
  removeCaptureHook,
  type CaptureAnchors,
  type CaptureHookEntry,
} from "../settings/edit.js";
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
 */
export function startRecordSession(options: StartRecordOptions): RecordSessionInfo {
  const settingsFile = targetSettingsFile(options.cwd);
  const existingText = readTextOrUndefined(settingsFile);
  const createdFresh = existingText === undefined;
  const preImageText = existingText ?? FRESH_SETTINGS_TEMPLATE;
  const preImageSha256 = sha256(preImageText);

  const captureDir =
    options.captureDir === undefined
      ? defaultCaptureDir(options.cwd)
      : path.resolve(options.cwd, options.captureDir);
  const stateDir = hookassertDir(options.cwd);
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(captureDir, { recursive: true });

  const captureScript = path.join(stateDir, CAPTURE_SCRIPT_FILENAME);
  const scriptText = buildCaptureScript({
    captureDir,
    claudeVersionFlag: options.claudeVersionFlag,
    lastVersionFile: lastRecordedClaudeVersionPath(options.cwd),
  });
  writeFileSync(captureScript, scriptText, "utf8");
  chmodSync(captureScript, 0o755);

  const entries: CaptureHookEntry[] = options.events.map((event) => ({
    event,
    matcher: options.matcherForEvent(event),
  }));
  const { text: newSettingsText, anchors } = insertCaptureHook(preImageText, {
    command: captureScript,
    entries,
  });

  mkdirSync(path.dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, newSettingsText, "utf8");

  const sessionFile: RecordSessionFile = {
    settingsFile,
    preImageText,
    preImageSha256,
    anchors,
    createdFresh,
  };
  writeFileSync(
    sessionFilePath(options.cwd),
    JSON.stringify(sessionFile, null, 2),
    "utf8",
  );

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
 * Stop the active capture session: apply the inverse edit, and verify the
 * result is byte-for-byte identical to the stored pre-image.
 *
 * @remarks
 * The inverse edit is written back to `settingsFile` unconditionally, before
 * the byte-for-byte check is even made — so a caller who only reads the
 * thrown error's message still finds the capture hook already removed. The
 * session file itself is always removed too, whether the check passed or
 * not: a stopped session is over either way, and a second `--stop` must find
 * nothing active to restore.
 *
 * @throws {RecordRestoreError} no active session was found at
 * {@link sessionFilePath}, or the restored text does not match the stored
 * pre-image byte-for-byte (the settings file was edited by hand while
 * recording was active) — in the second case, the mismatch is reported only
 * after the capture hook has already been removed from the file on disk.
 */
export function stopRecordSession(cwd: string): StopRecordResult {
  const sessionPath = sessionFilePath(cwd);
  const sessionText = readTextOrUndefined(sessionPath);
  if (sessionText === undefined) {
    throw new RecordRestoreError(
      sessionPath,
      "no active recording session was found. Run `record` (without --stop) first.",
    );
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
