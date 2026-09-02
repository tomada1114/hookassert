/**
 * `explain --emit-fixtures`'s write-side wrapper: reads captured payload
 * envelopes and writes them out as fixture YAML files.
 *
 * @remarks
 * Dynamic layer: this is the only place in `record/` that writes fixture
 * files to disk. The read-and-group logic itself — deciding what each
 * generated file's content is — lives in `src/internal/fixture/generate.ts`
 * (static layer, pure data in, pure data out); this module only calls it and
 * performs the actual `mkdirSync`/`writeFileSync`, per this issue's own
 * split between the two layers.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { generateFixtureFile, readCapturedEnvelopes } from "../fixture/index.js";
import { RecordNoCapturesError } from "../errors.js";

/** What `emitFixtures` needs to read captured envelopes and write fixtures for them. */
export interface EmitFixturesOptions {
  /** Absolute path of the directory captured payload envelopes are read from. */
  readonly captureDir: string;

  /** Absolute path of the directory generated fixture files are written into; created if it does not exist. */
  readonly outputDir: string;
}

/** What `emitFixtures` reports back, for `explain`'s own stdout. */
export interface EmitFixturesResult {
  /** Absolute path of the directory fixture files were written into. */
  readonly outputDir: string;

  /** Absolute path of every fixture file written, one per captured envelope, in capture order. */
  readonly files: readonly string[];
}

/**
 * Read every captured payload envelope in `options.captureDir` and write one
 * fixture YAML file per envelope into `options.outputDir`.
 *
 * @remarks
 * Each generated file's name is derived from its envelope's own file name
 * (see `generate.ts`'s `fixtureFileName`), so a second run against the same
 * capture directory regenerates the same files rather than duplicating them,
 * and neither can collide with an unrelated, hand-authored fixture file
 * already in `options.outputDir` — that file's content is left untouched.
 *
 * @throws {RecordNoCapturesError} `options.captureDir` holds no readable
 * captured payload envelopes.
 */
export function emitFixtures(options: EmitFixturesOptions): EmitFixturesResult {
  const envelopes = readCapturedEnvelopes(options.captureDir);
  if (envelopes.length === 0) {
    throw new RecordNoCapturesError(options.captureDir);
  }

  mkdirSync(options.outputDir, { recursive: true });

  const files = envelopes.map((envelope) => {
    const generated = generateFixtureFile(envelope, options.outputDir);
    const filePath = path.join(options.outputDir, generated.fileName);
    writeFileSync(filePath, generated.text, "utf8");
    return filePath;
  });

  return { outputDir: options.outputDir, files };
}
