/**
 * Reads and schema-validates the versioned hooks spec.
 *
 * @remarks
 * Static layer: reads a file's text and parses it, but never spawns a
 * process and never writes anything back — the same convention
 * `settings/load.ts` follows for settings files.
 */

import { readFileSync } from "node:fs";

import { SpecNotFoundError, SpecSchemaError } from "../errors.js";
import { isValidSpec, validateSpec } from "./guards.js";
import type { Spec } from "./types.js";

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/**
 * Validate an already-parsed value against the spec schema.
 *
 * @param raw - The result of `JSON.parse`-ing a spec file's text.
 * @param path - Absolute path of the spec file `raw` came from, used only to
 * name the offending file in a thrown {@link SpecSchemaError}.
 * @throws {SpecSchemaError} `raw` does not satisfy `schema/spec.schema.json`.
 */
export function loadSpec(raw: unknown, path: string): Spec {
  if (isValidSpec(raw)) {
    return raw;
  }
  throw new SpecSchemaError(path, validateSpec(raw).join("; "));
}

/**
 * Read, parse, and schema-validate a spec file from disk.
 *
 * @throws {SpecNotFoundError} `path` does not exist.
 * @throws {SpecSchemaError} `path`'s content is not valid JSON, or does not
 * satisfy `schema/spec.schema.json`.
 */
export function loadSpecFile(path: string): Spec {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      throw new SpecNotFoundError(path);
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SpecSchemaError(path, `invalid JSON: ${reason}`);
  }

  return loadSpec(raw, path);
}
