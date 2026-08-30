/**
 * Reads, YAML-parses, and schema-validates a fixture file, resolving each
 * case's payload origin and rejecting a load-time-impossible expectation
 * before any process is spawned for it.
 *
 * @remarks
 * Static layer: reads a file's text — the fixture itself, and, when a case
 * declares `origin.recorded`, the envelope file it points at — and parses
 * it, but never spawns a process and never writes anything back, the same
 * convention `settings/load.ts` and `spec/load.ts` follow.
 *
 * The load-time rejection this issue exists for lives in
 * {@link toFixtureCase}: a case whose `expect.decision` is `"deny"` against
 * an event the spec documents no deny channel for — `decision/`'s
 * `canProduceDeny`, which reads both the exit-code and the JSON channel
 * rather than `blockable` alone — throws
 * {@link FixtureUnblockableDecisionError} while turning the raw case into a
 * typed `FixtureCase` — before `loadFixture` returns, so before any later
 * pipeline stage could spawn a process for it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import type { EventName, PayloadOrigin } from "../../types.js";
import { canProduceDeny } from "../decision/index.js";
import {
  FixtureNotFoundError,
  FixtureSchemaError,
  FixtureUnblockableDecisionError,
} from "../errors.js";
import type { Spec } from "../spec/index.js";
import { isValidRawFixtureFile, validateFixture } from "./guards.js";
import type {
  FixtureCase,
  FixtureFile,
  FixtureSet,
  RawFixtureCase,
  RawFixtureOrigin,
} from "./types.js";

/**
 * The event names this loader recognizes.
 *
 * @remarks
 * A fixture case's `event` is free-form text in `schema/fixture.schema.json`
 * — the schema and `guards.ts` only check that it is a non-empty string —
 * because the closed `EventName` set is a fact about this package's own
 * build, not about a fixture file's shape. This is where that fact is
 * checked instead, the same split `settings/load.ts` draws for its own
 * `KNOWN_EVENT_NAMES` map. Unlike that map, an unrecognized event here is
 * rejected rather than silently skipped: a settings file's unknown `hooks`
 * key is forward-compatible data Claude Code itself produced, while a
 * fixture's `event` is a value the fixture's own author typed, so a typo
 * should fail loudly rather than silently match nothing.
 *
 * Typed as `Record<EventName, true>` rather than an array for the same
 * reason that map is: widening `src/types.ts`'s `EventName` without
 * extending this mirror is a type error here, instead of a loader that
 * rejects every fixture naming the new event as "not a recognized Claude
 * Code hook event".
 */
const EVENT_NAMES: Readonly<Record<EventName, true>> = {
  SessionStart: true,
  Setup: true,
  InstructionsLoaded: true,
  UserPromptSubmit: true,
  UserPromptExpansion: true,
  MessageDisplay: true,
  PreToolUse: true,
  PermissionRequest: true,
  PostToolUse: true,
  PostToolUseFailure: true,
  PostToolBatch: true,
  PermissionDenied: true,
  Notification: true,
  SubagentStart: true,
  SubagentStop: true,
  TaskCreated: true,
  TaskCompleted: true,
  Stop: true,
  StopFailure: true,
  TeammateIdle: true,
  ConfigChange: true,
  CwdChanged: true,
  DirectoryAdded: true,
  FileChanged: true,
  WorktreeCreate: true,
  WorktreeRemove: true,
  PreCompact: true,
  PostCompact: true,
  PreModelSwitch: true,
  PostModelSwitch: true,
  SessionEnd: true,
  Elicitation: true,
  ElicitationResult: true,
};

function isEventName(value: string): value is EventName {
  return Object.hasOwn(EVENT_NAMES, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireEventName(
  value: string,
  index: number,
  fixturePath: string,
): EventName {
  if (!isEventName(value)) {
    throw new FixtureSchemaError(
      fixturePath,
      `cases[${String(index)}].event "${value}" is not a recognized Claude Code hook event`,
    );
  }
  return value;
}

/**
 * Read and parse the envelope file `origin.recorded` points at, returning
 * the `PayloadOrigin` `FixtureCase.origin` carries forward.
 *
 * @throws {FixtureSchemaError} the envelope file cannot be read, is not
 * valid JSON, or is missing a non-empty `capturedAt` string.
 */
function resolveOrigin(
  raw: RawFixtureOrigin | undefined,
  index: number,
  fixturePath: string,
): PayloadOrigin {
  if (raw === undefined) {
    return { kind: "synthetic" };
  }

  const sourceFile = path.resolve(path.dirname(fixturePath), raw.recorded);
  const describe = (reason: string): string =>
    `cases[${String(index)}].origin.recorded envelope file ${sourceFile} ${reason}`;

  let text: string;
  try {
    text = readFileSync(sourceFile, "utf8");
  } catch (error) {
    throw new FixtureSchemaError(
      fixturePath,
      describe(`could not be read: ${describeError(error)}`),
    );
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(text) as unknown;
  } catch (error) {
    throw new FixtureSchemaError(
      fixturePath,
      describe(`is not valid JSON: ${describeError(error)}`),
    );
  }

  if (
    !isRecord(envelope) ||
    typeof envelope["capturedAt"] !== "string" ||
    envelope["capturedAt"].length === 0
  ) {
    throw new FixtureSchemaError(
      fixturePath,
      describe('is missing a non-empty "capturedAt" string'),
    );
  }

  const claudeVersion =
    typeof envelope["claudeVersion"] === "string"
      ? envelope["claudeVersion"]
      : undefined;

  return {
    kind: "recorded",
    capturedAt: envelope["capturedAt"],
    sourceFile,
    claudeVersion,
  };
}

/**
 * Turn one already schema-valid raw case into a typed {@link FixtureCase}.
 *
 * @throws {FixtureSchemaError} `rawCase.event` is not a recognized event, or
 * its `origin.recorded` envelope cannot be resolved.
 * @throws {FixtureUnblockableDecisionError} `rawCase.expect.decision` is
 * `"deny"` against an event the loaded spec documents no deny channel for.
 */
function toFixtureCase(
  rawCase: RawFixtureCase,
  index: number,
  fixturePath: string,
  spec: Spec,
): FixtureCase {
  const event = requireEventName(rawCase.event, index, fixturePath);

  const decision = rawCase.expect.decision;
  const eventSpec = spec.events[event];
  // Only when the spec actually classifies the event: one it does not carry
  // at all is a build whose EventName union runs ahead of the loaded spec,
  // which resolveDecision reports as `unknown` rather than treating as
  // "cannot deny".
  if (decision === "deny" && eventSpec !== undefined && !canProduceDeny(eventSpec)) {
    throw new FixtureUnblockableDecisionError(fixturePath, event, decision);
  }

  return {
    event,
    tool: rawCase.tool,
    input: rawCase.input,
    origin: resolveOrigin(rawCase.origin, index, fixturePath),
    expect: {
      fires: rawCase.expect.fires,
      decision,
      exitCode: rawCase.expect.exitCode,
      stdoutContains: rawCase.expect.stdoutContains,
      stderrContains: rawCase.expect.stderrContains,
      context: rawCase.expect.context,
      updatedInput: rawCase.expect.updatedInput,
      timedOut: rawCase.expect.timedOut,
    },
    stub: rawCase.stub,
    dryRun: rawCase.dryRun,
    cwd: rawCase.cwd,
  };
}

/**
 * Validate an already YAML-parsed value against the fixture schema, then
 * resolve it into a typed {@link FixtureFile}.
 *
 * @param raw - The result of YAML-parsing a fixture file's text.
 * @param filePath - Absolute path of the fixture file `raw` came from, used
 * only to name the offending file in a thrown error and to resolve a
 * relative `origin.recorded` path.
 * @param spec - The loaded hooks spec, consulted for the load-time
 * rejection rule below.
 * @throws {FixtureSchemaError} `raw` does not satisfy
 * `schema/fixture.schema.json`, names an unrecognized event, or points
 * `origin.recorded` at an envelope file that cannot be resolved.
 * @throws {FixtureUnblockableDecisionError} a case expects `decision:
 * "deny"` from an event `spec` documents no deny channel for.
 */
export function loadFixture(raw: unknown, filePath: string, spec: Spec): FixtureFile {
  if (!isValidRawFixtureFile(raw)) {
    throw new FixtureSchemaError(filePath, validateFixture(raw).join("; "));
  }

  const cases = raw.cases.map((rawCase, index) =>
    toFixtureCase(rawCase, index, filePath, spec),
  );

  return {
    settings: raw.settings ?? [],
    defaults: raw.defaults,
    cases,
  };
}

/**
 * Read, YAML-parse, and schema-validate a fixture file from disk.
 *
 * @throws {FixtureNotFoundError} `filePath` does not exist.
 * @throws {FixtureSchemaError} `filePath`'s content is not valid YAML, or
 * does not satisfy `schema/fixture.schema.json` once parsed.
 * @throws {FixtureUnblockableDecisionError} a case expects `decision:
 * "deny"` from an event `spec` documents no deny channel for.
 */
export function loadFixtureFile(filePath: string, spec: Spec): FixtureFile {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      throw new FixtureNotFoundError(filePath);
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new FixtureSchemaError(filePath, `invalid YAML: ${describeError(error)}`);
  }

  return loadFixture(raw, filePath, spec);
}

/**
 * Read, YAML-parse, and schema-validate every fixture file named in
 * `filePaths`, in the order given.
 *
 * @throws {FixtureNotFoundError} one of `filePaths` does not exist.
 * @throws {FixtureSchemaError} one of `filePaths`' content is not valid
 * YAML, or does not satisfy `schema/fixture.schema.json` once parsed.
 * @throws {FixtureUnblockableDecisionError} a case in one of `filePaths`
 * expects `decision: "deny"` from an event `spec` documents no deny channel for.
 */
export function loadFixtures(filePaths: readonly string[], spec: Spec): FixtureSet {
  return {
    files: filePaths.map((filePath) => ({
      path: filePath,
      file: loadFixtureFile(filePath, spec),
    })),
  };
}
