#!/usr/bin/env node
// Black-box conformance harness: compares hookassert's predicted hook-firing
// set against a recorded `claude --debug` transcript, and reports any
// mismatch as a proposed spec correction. It never writes to
// `spec/claude-code-<range>.json` itself -- see docs/conformance/README.md
// for the full design and the reviewed-PR workflow a mismatch feeds into.
//
// This is a maintainer-only, this-repository-only step (`pnpm conformance`):
// it is never run by CI, `pnpm test`, or `pnpm check`, and consuming a fresh
// transcript first requires a maintainer to capture one from a real `claude
// --debug` session by hand -- that capture step needs a real `claude` binary
// and network/session access, and is out of this script's scope (see the
// README). What this script does need, and check for itself, is a built
// `dist/cli.js` (`pnpm build`), since it calls the built CLI as a black box
// rather than importing `src/internal/**` or `dist/internal/**` -- the same
// boundary every other `scripts/**/*.mjs` file in this repository already
// respects.
//
// The part of this file that actually spawns a process (`runExplain`) is
// kept deliberately thin, per the `placing-tests` skill's guidance to put
// logic the test suite can call in-process behind a thin child-spawning
// shell: everything else here -- argument parsing, building the throwaway
// single-hook settings a case is checked against, and the whole compare/report
// pipeline -- is exercised directly by tests/conformance.test.ts through
// `main`'s injectable dependencies, without a `claude` binary or `dist/`.

import { spawnSync } from "node:child_process";
import console from "node:console";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { compareFiringSets } from "./lib/conformance/compare.mjs";
import { isMain } from "./lib/is-main.mjs";
import { parseJson, readKey } from "./lib/json.mjs";
import { repoRoot } from "./lib/node-tools.mjs";
import { proposePayloadShapeVerification } from "./lib/conformance/payload-shape.mjs";
import { firedInExplainReport } from "./lib/conformance/predicted.mjs";
import { normalizeTranscript } from "./lib/conformance/transcript.mjs";

/**
 * Read `spec.events[event].payloadShape` off a parsed spec document.
 *
 * @param {unknown} spec - Parsed JSON from the spec file.
 * @param {string} event
 * @returns {import("./lib/conformance/payload-shape.mjs").PayloadShapeLike | undefined}
 * The shape, or undefined when `spec` does not declare a well-formed
 * `payloadShape` for `event`.
 */
function readPayloadShape(spec, event) {
  const payloadShape = readKey(readKey(readKey(spec, "events"), event), "payloadShape");
  const requiredKeysRaw = readKey(payloadShape, "requiredKeys");
  const verified = readKey(payloadShape, "verified");
  if (
    !Array.isArray(requiredKeysRaw) ||
    !requiredKeysRaw.every((entry) => typeof entry === "string") ||
    typeof verified !== "boolean"
  ) {
    return undefined;
  }
  return { requiredKeys: requiredKeysRaw, verified };
}

const USAGE = `Usage: pnpm conformance -- --transcript <path.json> [--spec <path.json>]

Compares hookassert's predicted hook-firing set (from the built CLI, called
as \`node dist/cli.js explain --format json\`) against a recorded transcript,
and reports any disagreement as a proposed spec correction. Never writes to
spec/claude-code-<range>.json.

Options:
  --transcript <path>  Required. A transcript produced per
                        docs/conformance/README.md's format.
  --spec <path>         Optional. Defaults to the single JSON file under
                        spec/. Only consulted when the transcript carries
                        payloadObservations.

Exit codes:
  0  every firing case the transcript covers agrees with the prediction
  1  at least one mismatch was found (see the printed proposed diffs)
  2  the arguments were wrong`;

/** Error with a stable code and an actionable message, matching this repository's other scripts/**. */
export class ConformanceError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ConformanceError";
    /** @readonly */
    this.code = code;
  }
}

/**
 * @typedef {object} ConformanceOptions
 * @property {string} transcriptPath
 * @property {string} [specPath]
 */

/**
 * Parse this script's command-line arguments.
 *
 * @param {readonly string[]} argv
 * @returns {ConformanceOptions}
 * @throws {ConformanceError} `ERR_CONFORMANCE_ARGUMENT` on an unknown flag, a
 * missing value, or a missing required `--transcript`.
 */
export function parseArguments(argv) {
  /** @type {string | undefined} */
  let transcriptPath;
  /** @type {string | undefined} */
  let specPath;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--transcript" && flag !== "--spec") {
      throw new ConformanceError(
        "ERR_CONFORMANCE_ARGUMENT",
        `unknown option: ${String(flag)}\n\n${USAGE}`,
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ConformanceError(
        "ERR_CONFORMANCE_ARGUMENT",
        `${flag} requires a value.\n\n${USAGE}`,
      );
    }
    if (flag === "--transcript") {
      transcriptPath = value;
    } else {
      specPath = value;
    }
    index += 1;
  }

  if (transcriptPath === undefined) {
    throw new ConformanceError(
      "ERR_CONFORMANCE_ARGUMENT",
      `--transcript <path> is required.\n\n${USAGE}`,
    );
  }

  return { transcriptPath, ...(specPath === undefined ? {} : { specPath }) };
}

/**
 * Build the throwaway single-hook settings document a `(event, matcher)`
 * pair is checked against: one hook, so `explain`'s firing set has exactly
 * one member to ask about.
 *
 * @param {string} event
 * @param {string} matcher
 * @returns {object} A settings document with exactly one hook, ready to
 * `JSON.stringify` into a throwaway `--settings` file.
 */
export function singleHookSettings(event, matcher) {
  return {
    hooks: {
      [event]: [{ matcher, hooks: [{ type: "command", command: "true" }] }],
    },
  };
}

/**
 * Locate the one spec file under `spec/`.
 *
 * @param {string} root - Repository root.
 * @returns {string} Absolute path of the spec file.
 * @throws {ConformanceError} `ERR_CONFORMANCE_SPEC_AMBIGUOUS` when `spec/`
 * holds anything other than exactly one `.json` file -- pass `--spec` to
 * disambiguate.
 */
export function defaultSpecPath(root) {
  const specDir = path.join(root, "spec");
  const candidates = readdirSync(specDir).filter((name) => name.endsWith(".json"));
  const [only] = candidates;
  if (only === undefined || candidates.length !== 1) {
    throw new ConformanceError(
      "ERR_CONFORMANCE_SPEC_AMBIGUOUS",
      `expected exactly one spec/*.json file, found ${String(candidates.length)}.\n` +
        "Next: pass --spec <path> explicitly.",
    );
  }
  return path.join(specDir, only);
}

/**
 * Run the built CLI's `explain` command as a subprocess and parse its JSON
 * report. The one function in this file that actually spawns a process --
 * exercised only by a real `pnpm conformance` run against a built `dist/`,
 * per this file's own header comment; `main`'s tests inject a fake in its
 * place instead of covering this body.
 *
 * @param {string} cliEntry - Absolute path of the built CLI (`dist/cli.js`).
 * @param {string} settingsPath - Absolute path of a single-hook settings file.
 * @param {string} event
 * @param {string} tool
 * @returns {unknown} The parsed `JsonExplainReport`.
 * @throws {ConformanceError} `ERR_CONFORMANCE_CLI_SPAWN` when the CLI could
 * not run at all (for example, `dist/cli.js` is missing); `ERR_CONFORMANCE_CLI_FAILED`
 * when it ran but exited non-zero.
 */
export function runExplain(cliEntry, settingsPath, event, tool) {
  const result = spawnSync(
    process.execPath,
    [cliEntry, "explain", event, tool, "--settings", settingsPath, "--format", "json"],
    { cwd: repoRoot, encoding: "utf8", env: process.env },
  );
  if (result.error !== undefined) {
    throw new ConformanceError(
      "ERR_CONFORMANCE_CLI_SPAWN",
      `could not run ${cliEntry}: ${result.error.message}\nNext: run \`pnpm build\` and retry.`,
    );
  }
  if (result.status !== 0) {
    throw new ConformanceError(
      "ERR_CONFORMANCE_CLI_FAILED",
      `node dist/cli.js explain ${event} ${tool} --format json exited ${String(result.status)}.\n${result.stderr}`,
    );
  }
  return parseJson(result.stdout);
}

/**
 * Ask the built CLI, for real, whether a hook declaring `matcher` fires for
 * `tool` on `event`: writes a throwaway single-hook settings file, calls
 * {@link runExplain} against it, and cleans the temporary directory up
 * whether or not that call throws.
 *
 * @param {string} event
 * @param {string} matcher
 * @param {string} tool
 * @param {string} [cliEntry] - Absolute path of the built CLI; defaults to
 * `dist/cli.js`. Overridable so tests can point this at a stand-in script
 * instead of a real built `dist/`.
 * @returns {boolean}
 */
export function defaultRunExplainCase(
  event,
  matcher,
  tool,
  cliEntry = path.join(repoRoot, "dist", "cli.js"),
) {
  const dir = mkdtempSync(path.join(tmpdir(), "hookassert-conformance-"));
  try {
    const settingsPath = path.join(dir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify(singleHookSettings(event, matcher)),
      "utf8",
    );
    const report = runExplain(cliEntry, settingsPath, event, tool);
    return firedInExplainReport(report, matcher);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @typedef {object} ConformanceDeps
 * @property {(path: string) => string} [readFile]
 * @property {() => string} [resolveSpecPath]
 * @property {(event: string, matcher: string, tool: string) => boolean} [runExplainCase]
 * @property {(text: string) => void} [log]
 * @property {(text: string) => void} [logError]
 */

/**
 * Run the conformance comparison end to end: parse arguments, load and
 * normalize the transcript, ask the (possibly injected) predictor for every
 * case the transcript observed, diff the two sets, and print any mismatch
 * plus any payload-shape proposal. Never writes to `spec/**`.
 *
 * @param {readonly string[]} argv
 * @param {ConformanceDeps} [deps] - Injected for tests: overriding
 * `runExplainCase` avoids spawning the built CLI, and overriding
 * `resolveSpecPath` avoids depending on `spec/`'s real contents.
 * @returns {number} The process exit code (see {@link USAGE}).
 */
export function main(argv, deps = {}) {
  const {
    readFile = (filePath) => readFileSync(filePath, "utf8"),
    resolveSpecPath = () => defaultSpecPath(repoRoot),
    runExplainCase = defaultRunExplainCase,
    log = (text) => {
      console.log(text);
    },
    logError = (text) => {
      console.error(text);
    },
  } = deps;

  try {
    const options = parseArguments(argv);
    const transcript = normalizeTranscript(parseJson(readFile(options.transcriptPath)));

    const predictedCases = transcript.firingObservations.map((observed) => ({
      event: observed.event,
      matcher: observed.matcher,
      tool: observed.tool,
      fired: runExplainCase(observed.event, observed.matcher, observed.tool),
    }));
    const comparison = compareFiringSets(predictedCases, transcript.firingObservations);

    if (comparison.mismatches.length === 0) {
      log(
        `conformance: ${String(comparison.agreements.length)} firing case(s) agree with the transcript; no mismatch found.`,
      );
    } else {
      logError(
        `conformance: ${String(comparison.mismatches.length)} mismatch(es) found. ` +
          "Proposed corrections below -- review and apply by hand; spec/** was not modified:\n",
      );
      for (const mismatch of comparison.mismatches) {
        logError(mismatch.proposedDiff);
        logError("");
      }
    }

    if (transcript.payloadObservations.length > 0) {
      const specPath = options.specPath ?? resolveSpecPath();
      const spec = parseJson(readFile(specPath));
      for (const observation of transcript.payloadObservations) {
        const payloadShape = readPayloadShape(spec, observation.event);
        if (payloadShape === undefined) {
          logError(
            `ERR_CONFORMANCE_UNKNOWN_EVENT: transcript payloadObservations names event ` +
              `${JSON.stringify(observation.event)}, which ${specPath} does not declare a ` +
              "payloadShape for.",
          );
          continue;
        }
        const proposal = proposePayloadShapeVerification(
          observation.event,
          payloadShape,
          observation.payload,
        );
        if (proposal.proposedDiff !== null) {
          log(proposal.proposedDiff);
          log("");
        }
      }
    }

    return comparison.mismatches.length === 0 ? 0 : 1;
  } catch (error) {
    if (error instanceof ConformanceError) {
      logError(error.message);
      return error.code === "ERR_CONFORMANCE_ARGUMENT" ? 2 : 1;
    }
    logError(
      `ERR_CONFORMANCE_UNEXPECTED: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
