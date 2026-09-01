/**
 * `record`'s own internal surface.
 *
 * @remarks
 * `src/cli.ts` is the composition root that wires this into the `record`
 * subcommand; nothing here is re-exported from `src/index.ts` — this
 * directory has no public surface, the same as every other module under
 * `src/internal/`.
 */

export { buildCaptureScript, CAPTURE_SCRIPT_FILENAME } from "./capture.js";
export type { CaptureScriptOptions } from "./capture.js";
export {
  defaultCaptureDir,
  hookassertDir,
  isRecordSessionActive,
  lastRecordedClaudeVersionPath,
  readLastRecordedClaudeVersion,
  sessionFilePath,
  startRecordSession,
  stopRecordSession,
} from "./session.js";
export type {
  RecordSessionInfo,
  StartRecordOptions,
  StopRecordResult,
} from "./session.js";
