// Validates and normalizes a parsed conformance transcript document.
//
// A transcript is this harness's own normalized stand-in for the parts of a
// real `claude --debug` session log that matter to conformance checking: for
// every tool event the maintainer's session exercised, whether a hook with a
// given matcher fired, plus any raw hook payloads captured along the way.
// See docs/conformance/README.md for the full format and how a maintainer
// produces one from a real session -- that capture step is manual, needs a
// real `claude` binary, and is out of this module's scope. This module only
// reads already-produced JSON; it never spawns anything.

import { readKey, readString } from "../json.mjs";

/**
 * @typedef {import("./predicted.mjs").FiringCase} FiringCase
 */

/**
 * @typedef {object} PayloadObservation
 * @property {string} event - The hook event the payload was captured for.
 * @property {Record<string, unknown>} payload - The raw hook payload, as
 * received on stdin by the recorded session's hook command.
 */

/**
 * @typedef {object} Transcript
 * @property {string} claudeVersion - The Claude Code version the session ran.
 * @property {readonly FiringCase[]} firingObservations - What was actually
 * observed to fire, one entry per `(event, matcher, tool)` the session
 * exercised.
 * @property {readonly PayloadObservation[]} payloadObservations - Raw
 * payloads captured along the way, for `payloadShape.verified` proposals.
 */

/** Thrown when a transcript document does not match {@link Transcript}'s shape. */
export class TranscriptShapeError extends Error {
  /**
   * @param {string} reason - What was missing or malformed, and where.
   */
  constructor(reason) {
    super(`ERR_CONFORMANCE_TRANSCRIPT_SHAPE: ${reason}`);
    this.name = "TranscriptShapeError";
    /** @readonly */
    this.code = "ERR_CONFORMANCE_TRANSCRIPT_SHAPE";
  }
}

/**
 * @param {unknown} entry
 * @param {number} index
 * @returns {FiringCase}
 */
function normalizeFiringObservation(entry, index) {
  const event = readString(entry, "event");
  const matcher = readString(entry, "matcher");
  const tool = readString(entry, "tool");
  const fired = readKey(entry, "fired");
  if (
    event === undefined ||
    matcher === undefined ||
    tool === undefined ||
    typeof fired !== "boolean"
  ) {
    throw new TranscriptShapeError(
      `firingObservations[${String(index)}] must have string "event", "matcher", "tool" ` +
        `and a boolean "fired".\nExpected: {event, matcher, tool, fired}.\n` +
        `Actual: ${JSON.stringify(entry)}.`,
    );
  }
  return { event, matcher, tool, fired };
}

/**
 * @param {unknown} entry
 * @param {number} index
 * @returns {PayloadObservation}
 */
function normalizePayloadObservation(entry, index) {
  const event = readString(entry, "event");
  const payload = readKey(entry, "payload");
  if (event === undefined || typeof payload !== "object" || payload === null) {
    throw new TranscriptShapeError(
      `payloadObservations[${String(index)}] must have a string "event" and an object "payload".\n` +
        `Expected: {event, payload}.\nActual: ${JSON.stringify(entry)}.`,
    );
  }
  return { event, payload: /** @type {Record<string, unknown>} */ (payload) };
}

/**
 * Validate and normalize a parsed transcript document.
 *
 * @param {unknown} raw - `JSON.parse` output of a transcript file.
 * @returns {Transcript} The normalized transcript.
 * @throws {TranscriptShapeError} `raw` does not match {@link Transcript}'s shape.
 */
export function normalizeTranscript(raw) {
  const claudeVersion = readString(raw, "claudeVersion");
  if (claudeVersion === undefined) {
    throw new TranscriptShapeError('missing a string field "claudeVersion".');
  }

  const rawFiring = readKey(raw, "firingObservations");
  if (!Array.isArray(rawFiring)) {
    throw new TranscriptShapeError('missing an array field "firingObservations".');
  }
  const firingObservations = rawFiring.map((entry, index) =>
    normalizeFiringObservation(entry, index),
  );

  const rawPayloads = readKey(raw, "payloadObservations") ?? [];
  if (!Array.isArray(rawPayloads)) {
    throw new TranscriptShapeError(
      '"payloadObservations" must be an array when present.',
    );
  }
  const payloadObservations = rawPayloads.map((entry, index) =>
    normalizePayloadObservation(entry, index),
  );

  return { claudeVersion, firingObservations, payloadObservations };
}
