/**
 * Turns captured payload envelopes (`record`'s own output, see
 * `src/internal/record/capture.ts`) into fixture-file-shaped values that
 * `load.ts`'s `loadFixtures` can read back unchanged.
 *
 * @remarks
 * Static layer: reads envelope files from a capture directory and returns
 * plain data — a generated fixture's file name and full YAML text — but
 * never writes anything itself. `src/internal/record/emit.ts` (dynamic
 * layer) is the only module that calls {@link generateFixtureFile} and
 * writes its result to disk, per this issue's design: the read-and-group
 * logic is static and pure, the write is dynamic.
 *
 * One case per envelope, per the design's explicit choice not to invent a
 * richer grouping heuristic than the captured data can actually support: a
 * "session" is not a concept an envelope file carries on its own, so nothing
 * here tries to cluster envelopes into one file by session or by event.
 *
 * `expect` is always exactly `{ fires: true }` — never a guessed `decision`,
 * `exitCode`, or output expectation. A guessed expectation that turns out
 * wrong is worse than none at all, since it would silently assert something
 * the user never reviewed; see this issue's own design note.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { stringify as stringifyYaml } from "yaml";

import type { RawFixtureCase, RawFixtureFile } from "./types.js";

/**
 * The exact first line every generated fixture file starts with — the same
 * line `#8`'s hand-authored example uses, so a generated and a hand-written
 * fixture look identical to an editor. Not computed relative to the output
 * directory: it names the path a real consumer's own `node_modules` resolves
 * to once `hookassert` is installed, which has nothing to do with where this
 * particular fixture file happens to be written.
 */
export const YAML_SCHEMA_COMMENT =
  "# yaml-language-server: $schema=./node_modules/hookassert/schema/fixture.schema.json";

/** One captured payload envelope, read off disk, with just what generation needs. */
export interface CapturedEnvelope {
  /** Absolute path of the envelope file this was read from. */
  readonly envelopePath: string;

  /** The envelope's own `event` field. Not yet checked against `EventName` — `load.ts` does that once the generated fixture is loaded back. */
  readonly event: string;

  /** The envelope's own captured payload, replayed verbatim as the generated case's `input`. */
  readonly payload: unknown;
}

/** One fixture file `generateFixtureFile` produced, ready to be written to disk. */
export interface GeneratedFixture {
  /** File name (no directory) to write this fixture under — distinct per envelope, so emitting never collides with another generated file or an unrelated hand-authored one. */
  readonly fileName: string;

  /** Full YAML file text, `YAML_SCHEMA_COMMENT` included as its first line. */
  readonly text: string;
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

/**
 * Read every captured payload envelope in `captureDir`, in filename order —
 * which, per `capture.ts`'s own naming (`capture-<iso-with-dashes>-<suffix>.json`),
 * is also capture order.
 *
 * @remarks
 * A missing capture directory reads as "nothing captured yet" (an empty
 * array), the same way `settings/load.ts` maps a missing settings file to
 * zero hooks, rather than as an error — `record` may simply never have been
 * run. A file that is not valid JSON, or is valid JSON missing a non-empty
 * `event` string or its `payload` key entirely, is skipped rather than
 * failing the whole read: it is not a shape `capture.ts`'s own script ever
 * writes, so it can only be a file something else put there, or a capture
 * that failed partway through a write.
 */
export function readCapturedEnvelopes(captureDir: string): readonly CapturedEnvelope[] {
  let entries: string[];
  try {
    entries = readdirSync(captureDir).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }
    throw error;
  }
  entries.sort();

  const envelopes: CapturedEnvelope[] = [];
  for (const name of entries) {
    const envelopePath = path.join(captureDir, name);

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(envelopePath, "utf8")) as unknown;
    } catch {
      continue;
    }

    if (
      !isRecord(parsed) ||
      typeof parsed["event"] !== "string" ||
      parsed["event"].length === 0 ||
      !("payload" in parsed)
    ) {
      continue;
    }

    envelopes.push({
      envelopePath,
      event: parsed["event"],
      payload: parsed["payload"],
    });
  }

  return envelopes;
}

/** The envelope's own `payload.tool_name`, when it names one as a non-empty string. */
function extractToolName(payload: unknown): string | undefined {
  if (!isRecord(payload) || typeof payload["tool_name"] !== "string") {
    return undefined;
  }
  return payload["tool_name"].length > 0 ? payload["tool_name"] : undefined;
}

/**
 * A generated fixture file's name: the envelope's own file name (already
 * unique per capture, per `capture.ts`'s random suffix) with `.json`
 * replaced by `.fixture.yaml` — so two runs of `explain --emit-fixtures`
 * against the same capture directory regenerate the same files rather than
 * accumulating duplicates, and neither collides with an unrelated,
 * hand-authored fixture file already in the output directory.
 */
function fixtureFileName(envelopePath: string): string {
  const stem = path.basename(envelopePath, ".json");
  return `${stem}.fixture.yaml`;
}

/** Posix-style relative path from `outputDir` to `targetPath`, for `origin.recorded`. */
function relativeOrigin(outputDir: string, targetPath: string): string {
  return path.relative(outputDir, targetPath).split(path.sep).join("/");
}

/**
 * Generate one fixture file from one captured envelope: exactly one case,
 * `origin.recorded` pointing back at the envelope, `input` replaying its
 * captured payload verbatim, and `expect` prefilled with nothing but
 * `{ fires: true }`.
 *
 * @param envelope - The captured envelope to generate a fixture from.
 * @param outputDir - Absolute path of the directory the caller is about to
 * write the result into — used only to compute `origin.recorded`'s relative
 * path back to {@link CapturedEnvelope.envelopePath}.
 */
export function generateFixtureFile(
  envelope: CapturedEnvelope,
  outputDir: string,
): GeneratedFixture {
  const tool = extractToolName(envelope.payload);

  const rawCase: RawFixtureCase = {
    event: envelope.event,
    ...(tool === undefined ? {} : { tool }),
    input: envelope.payload,
    origin: { recorded: relativeOrigin(outputDir, envelope.envelopePath) },
    expect: { fires: true },
  };

  const rawFile: RawFixtureFile = { cases: [rawCase] };

  const text = `${YAML_SCHEMA_COMMENT}\n${stringifyYaml(rawFile)}`;

  return { fileName: fixtureFileName(envelope.envelopePath), text };
}
