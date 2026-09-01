// Proposes flipping spec's per-event `payloadShape.verified` flag -- never
// flips it. `#3` gave that field a reader; this issue is its only intended
// writer, and even here the "write" is a printed proposal a human applies by
// hand in a reviewed pull request, exactly like a firing-set mismatch's
// proposed diff (compare.mjs).

/**
 * @typedef {object} PayloadShapeLike
 * @property {readonly string[]} requiredKeys
 * @property {boolean} verified
 */

/**
 * @typedef {object} PayloadShapeProposal
 * @property {string} event
 * @property {boolean} shapeMatches - True when `payload` carries every key
 * `payloadShape.requiredKeys` names.
 * @property {readonly string[]} missingKeys - `requiredKeys` entries `payload`
 * did not carry; empty when `shapeMatches` is true.
 * @property {string | null} proposedDiff - Non-null only when the shape
 * matches and `payloadShape.verified` is not already `true`. Text only:
 * never applied to `spec/**` by this function or its caller.
 */

/**
 * Compare a captured payload's keys against `spec.events[event].payloadShape
 * .requiredKeys`, and propose flipping `payloadShape.verified` to `true`
 * when the shape matches and the flag is not already set. Pure: never
 * mutates `payloadShape` or `payload`, and never writes anywhere.
 *
 * @param {string} event - The hook event `payload` was captured for.
 * @param {PayloadShapeLike} payloadShape - `spec.events[event].payloadShape`,
 * read directly from the spec JSON file.
 * @param {Record<string, unknown>} payload - A captured hook payload.
 * @returns {PayloadShapeProposal}
 */
export function proposePayloadShapeVerification(event, payloadShape, payload) {
  const payloadKeys = new Set(Object.keys(payload));
  const missingKeys = payloadShape.requiredKeys.filter((key) => !payloadKeys.has(key));
  const shapeMatches = missingKeys.length === 0;

  if (!shapeMatches || payloadShape.verified) {
    return { event, shapeMatches, missingKeys, proposedDiff: null };
  }

  return {
    event,
    shapeMatches,
    missingKeys,
    proposedDiff: [
      "# proposed spec correction -- for human review, not applied automatically",
      `events.${event}.payloadShape.verified:`,
      "- false",
      "+ true",
      "reason: a captured payload's keys satisfy every requiredKeys entry for this event.",
    ].join("\n"),
  };
}
