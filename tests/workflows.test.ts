import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// GitHub Actions cannot be executed from here, so the properties spec 02 §5.1
// requires of every workflow are asserted against the files instead. This is
// the local evidence for DoD G.
//
// The scanner below is deliberately not a YAML parser. A parser would be a new
// dependency for a repository whose whole point is a small, reviewable
// dependency surface, and every rule here is about the *text* of a line — a
// pinned SHA, a trailing release-tag comment, a flag on a command — which
// survives round-tripping through a parser only by accident.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workflowsDir = path.join(repoRoot, ".github", "workflows");

// --- scanning ----------------------------------------------------------------

/** One structurally significant line: blanks, comments and block scalars are out. */
interface Line {
  /** Leading space count, which is what nesting is expressed with in YAML. */
  indent: number;
  /** Trimmed content with any trailing comment removed. */
  text: string;
  /** Original line including its trailing comment. */
  raw: string;
  /** 1-based line number, so a failure names a place a reader can open. */
  number: number;
}

/**
 * Split a workflow into structural lines.
 *
 * @remarks
 * Content of a block scalar (`run: |`) is skipped: a shell script contains
 * `#` comments, colons and `-` list markers that would otherwise read as YAML
 * structure. {@link runCommands} reads those bodies separately.
 */
function scan(source: string): Line[] {
  const lines: Line[] = [];
  let scalarIndent: number | null = null;

  source.split("\n").forEach((raw, index) => {
    // Trailing comments are dropped so that documenting a permission scope
    // does not change what a line means here. A `#` inside a quoted value
    // would be cut too, which is why shell bodies are read from the raw
    // source by `runCommands` instead.
    const text = raw.trim().replace(/\s+#.*$/, "");
    const indent = raw.length - raw.trimStart().length;

    if (scalarIndent !== null) {
      if (text === "" || indent > scalarIndent) {
        return;
      }
      scalarIndent = null;
    }
    if (text === "" || raw.trimStart().startsWith("#")) {
      return;
    }

    lines.push({ indent, text, raw, number: index + 1 });
    if (/:\s*[|>][+-]?\d*$/.test(text)) {
      scalarIndent = indent;
    }
  });

  return lines;
}

/** The lines nested under `lines[headerIndex]`. */
function blockOf(lines: Line[], headerIndex: number): Line[] {
  const header = lines[headerIndex];
  if (header === undefined) {
    return [];
  }

  const body: Line[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.indent <= header.indent) {
      break;
    }
    body.push(line);
  }
  return body;
}

/** The value written after `key:` on the same line, or `""` when the value is a block. */
function inlineValue(line: Line): string {
  return line.text.slice(line.text.indexOf(":") + 1).trim();
}

function topLevel(lines: Line[], key: string): Line | undefined {
  return lines.find((line) => line.indent === 0 && line.text.startsWith(`${key}:`));
}

interface Job {
  name: string;
  header: Line;
  body: Line[];
}

function jobsOf(lines: Line[]): Job[] {
  const jobsIndex = lines.findIndex(
    (line) => line.indent === 0 && line.text === "jobs:",
  );
  if (jobsIndex === -1) {
    return [];
  }

  const body = blockOf(lines, jobsIndex);
  const jobs: Job[] = [];
  body.forEach((line, index) => {
    const name = /^([A-Za-z0-9_-]+):$/.exec(line.text)?.[1];
    if (line.indent === 2 && name !== undefined) {
      jobs.push({ name, header: line, body: blockOf(body, index) });
    }
  });
  return jobs;
}

/** Each step as its list-item line plus everything nested under it. */
function stepsOf(job: Job): Line[][] {
  const stepsIndex = job.body.findIndex(
    (line) => line.indent === job.header.indent + 2 && line.text === "steps:",
  );
  if (stepsIndex === -1) {
    return [];
  }

  const body = blockOf(job.body, stepsIndex);
  const first = body[0];
  if (first === undefined) {
    return [];
  }

  const steps: Line[][] = [];
  body.forEach((line, index) => {
    if (line.indent === first.indent && line.text.startsWith("- ")) {
      steps.push([line, ...blockOf(body, index)]);
    }
  });
  return steps;
}

/**
 * A key declared directly on the job, not somewhere inside one of its steps.
 *
 * @remarks
 * The depth matters: a `timeout-minutes` on a single step would otherwise read
 * as a timeout on the whole job, which is the opposite of what it means.
 */
function jobKey(job: Job, key: string): Line | undefined {
  return job.body.find(
    (line) => line.indent === job.header.indent + 2 && line.text.startsWith(`${key}:`),
  );
}

interface UsesRef {
  line: Line;
  ref: string;
}

function usesOf(lines: Line[]): UsesRef[] {
  const refs: UsesRef[] = [];
  for (const line of lines) {
    const ref = /^(?:- )?uses:\s*(\S+)/.exec(line.text)?.[1];
    if (ref !== undefined) {
      refs.push({ line, ref });
    }
  }
  return refs;
}

interface RunCommand {
  line: number;
  command: string;
}

/** Every `run:` body, single line or block scalar, with its starting line number. */
function runCommands(source: string): RunCommand[] {
  const rawLines = source.split("\n");
  const commands: RunCommand[] = [];

  rawLines.forEach((raw, index) => {
    const match = /^(\s*)(?:- )?run:\s*(.*)$/.exec(raw);
    const indentText = match?.[1];
    const value = match?.[2];
    if (indentText === undefined || value === undefined) {
      return;
    }

    if (!/^[|>][+-]?\d*$/.test(value.trim())) {
      commands.push({ line: index + 1, command: value });
      return;
    }

    const indent = indentText.length;
    const body: string[] = [];
    for (let next = index + 1; next < rawLines.length; next += 1) {
      const bodyLine = rawLines[next];
      if (bodyLine === undefined) {
        break;
      }
      const bodyIndent = bodyLine.length - bodyLine.trimStart().length;
      if (bodyLine.trim() !== "" && bodyIndent <= indent) {
        break;
      }
      body.push(bodyLine);
    }
    commands.push({ line: index + 1, command: body.join("\n") });
  });

  return commands;
}

/**
 * The `run.shell` a `defaults:` block declares, or `undefined` when it declares
 * none — including when there is no `defaults:` block at all.
 *
 * @param scope - The line list `defaults` was found in: `lines` for the
 * workflow-level block, a job's own body for a job-level one.
 */
function defaultsRunShell(
  scope: Line[],
  defaults: Line | undefined,
): string | undefined {
  if (defaults === undefined) {
    return undefined;
  }
  return blockOf(scope, scope.indexOf(defaults))
    .filter((line) => line.text.startsWith("shell:"))
    .map((line) => inlineValue(line))[0];
}

/**
 * The `shell:` the step covering `lineNumber` declares for itself, if any.
 *
 * @remarks
 * A step's own `shell:` overrides both `defaults:` blocks, so it is the last
 * word on how a `run:` body is executed. Only the step's own keys count: the
 * depth check keeps a `shell` nested inside a `with:` — an action input that
 * happens to share the name — from reading as the step's shell.
 */
function stepShellAtLine(job: Job, lineNumber: number): string | undefined {
  const step = stepsOf(job).find((lines) =>
    lines.some((line) => line.number === lineNumber),
  );
  const header = step?.[0];
  if (step === undefined || header === undefined) {
    return undefined;
  }
  const inline = /^- shell:\s*(.*)$/.exec(header.text)?.[1];
  return (
    inline ??
    step
      .filter(
        (line) => line.indent === header.indent + 2 && line.text.startsWith("shell:"),
      )
      .map((line) => inlineValue(line))[0]
  );
}

/**
 * Whether a shell string makes a `run:` body fail closed on its own.
 *
 * @remarks
 * Both halves are required: `pipefail` alone still lets an unset variable
 * expand to the empty string, which is what `-u` is there to stop. The `-u`
 * test is a regex rather than a substring search because the flag is
 * routinely written inside a cluster (`bash -euo pipefail {0}`), where the
 * literal text `-u` never appears.
 */
function isFailClosedShell(shell: string | undefined): boolean {
  return (
    shell !== undefined &&
    shell.includes("pipefail") &&
    /(?:^|\s)-[A-Za-z]*u/.test(shell)
  );
}

/** The job whose structural lines cover `lineNumber`, if any. */
function jobAtLine(jobs: Job[], lineNumber: number): Job | undefined {
  return jobs.find(
    (job) =>
      job.header.number === lineNumber ||
      job.body.some((line) => line.number === lineNumber),
  );
}

/** The index of the first step in `steps` that uses an action starting with `prefix`. */
function stepUsing(steps: Line[][], prefix: string): number {
  return steps.findIndex((step) =>
    usesOf(step).some(({ ref }) => ref.startsWith(prefix)),
  );
}

// --- rules -------------------------------------------------------------------

/** One workflow property that spec 02 §5.1 requires and this file does not have. */
interface Problem {
  /** Stable identifier, safe to match in a test. */
  code: string;
  /** Line the reader should open. */
  line: number;
  /** What is wrong and what it should be instead. */
  message: string;
}

/** A third-party or first-party action reference that must carry a full SHA. */
const PINNED_REF = /^[^@\s]+@[0-9a-f]{40}$/;
/** The release tag a pinned SHA must be annotated with, so the pin stays readable. */
const TAG_COMMENT = /#\s*v\d+\.\d+\.\d+/;

function lintWorkflow(source: string): Problem[] {
  const lines = scan(source);
  const problems: Problem[] = [];
  const report = (code: string, line: number, message: string): void => {
    problems.push({ code, line, message });
  };

  for (const line of lines) {
    if (/^pull_request_target\b/.test(line.text)) {
      report(
        "ERR_WORKFLOW_PULL_REQUEST_TARGET",
        line.number,
        "pull_request_target runs fork code with a writable token. Use pull_request.",
      );
    }
  }

  // Actions are pinned to a full commit SHA and annotated with their release tag.
  for (const { line, ref } of usesOf(lines)) {
    if (ref.startsWith("./")) {
      continue;
    }
    if (!PINNED_REF.test(ref)) {
      report(
        "ERR_WORKFLOW_ACTION_NOT_PINNED",
        line.number,
        `${ref} is not pinned to a 40-character commit SHA.`,
      );
      continue;
    }
    if (!TAG_COMMENT.test(line.raw)) {
      report(
        "ERR_WORKFLOW_ACTION_TAG_COMMENT_MISSING",
        line.number,
        `${ref} has no trailing "# vX.Y.Z" comment, so the pin cannot be read.`,
      );
    }
  }

  // Top-level permissions are empty or read-only; jobs opt in to what they need.
  const permissions = topLevel(lines, "permissions");
  if (permissions === undefined) {
    report(
      "ERR_WORKFLOW_PERMISSIONS_MISSING",
      1,
      "No top-level permissions. Declare `permissions: {}` and grant per job.",
    );
  } else {
    const inline = inlineValue(permissions);
    const block = blockOf(lines, lines.indexOf(permissions)).map((line) => line.text);
    const readOnly =
      inline === "{}" ||
      (inline === "" && block.every((entry) => entry === "contents: read"));
    if (!readOnly) {
      report(
        "ERR_WORKFLOW_PERMISSIONS_TOO_BROAD",
        permissions.number,
        "Top-level permissions must be `{}` or `contents: read`.",
      );
    }
  }

  const jobs = jobsOf(lines);
  if (jobs.length === 0) {
    report("ERR_WORKFLOW_NO_JOBS", 1, "The workflow declares no jobs.");
  }

  for (const job of jobs) {
    if (jobKey(job, "timeout-minutes") === undefined) {
      report(
        "ERR_WORKFLOW_JOB_TIMEOUT_MISSING",
        job.header.number,
        `Job "${job.name}" has no timeout-minutes.`,
      );
    }

    const jobPermissions = jobKey(job, "permissions");
    if (jobPermissions === undefined) {
      report(
        "ERR_WORKFLOW_PERMISSIONS_MISSING",
        job.header.number,
        `Job "${job.name}" does not declare its own permissions.`,
      );
    } else {
      const scopes = [
        inlineValue(jobPermissions),
        ...blockOf(job.body, job.body.indexOf(jobPermissions)).map((line) => line.text),
      ];
      if (scopes.includes("write-all")) {
        report(
          "ERR_WORKFLOW_PERMISSIONS_TOO_BROAD",
          jobPermissions.number,
          `Job "${job.name}" grants write-all. List the scopes it actually needs.`,
        );
      }
    }

    // Checkout must not leave a usable credential behind for later steps.
    for (const step of stepsOf(job)) {
      const checkout = usesOf(step).find(({ ref }) =>
        ref.startsWith("actions/checkout@"),
      );
      if (checkout === undefined) {
        continue;
      }
      const persists = step.some((line) => line.text === "persist-credentials: false");
      if (!persists) {
        report(
          "ERR_WORKFLOW_CHECKOUT_CREDENTIALS",
          checkout.line.number,
          "actions/checkout needs `persist-credentials: false`.",
        );
      }
    }
  }

  // setup-node's default package-manager cache resolves the pnpm store path by
  // invoking pnpm. A setup-node that runs first finds no pnpm on PATH, so it
  // silently caches nothing — the failure mode is a slow job, never an error.
  for (const job of jobs) {
    const steps = stepsOf(job);
    const pnpmIndex = stepUsing(steps, "pnpm/action-setup@");
    const nodeIndex = stepUsing(steps, "actions/setup-node@");
    if (pnpmIndex === -1 || nodeIndex === -1 || pnpmIndex < nodeIndex) {
      continue;
    }
    report(
      "ERR_WORKFLOW_SETUP_ORDER",
      steps[nodeIndex]?.[0]?.number ?? job.header.number,
      `Job "${job.name}" runs actions/setup-node before pnpm/action-setup, so the pnpm store cache never engages.`,
    );
  }

  // A pull request that is pushed to again must not keep the superseded run alive.
  const on = topLevel(lines, "on");
  const triggers = on === undefined ? [] : blockOf(lines, lines.indexOf(on));
  const triggerIndent = triggers[0]?.indent;
  const onPullRequest = triggers.some((line) => line.text.startsWith("pull_request"));
  const onPush = triggers.some(
    (line) => line.indent === triggerIndent && line.text.startsWith("push:"),
  );
  const concurrency = topLevel(lines, "concurrency");
  if (onPullRequest && concurrency === undefined) {
    report(
      "ERR_WORKFLOW_CONCURRENCY_MISSING",
      on?.number ?? 1,
      "A pull-request workflow needs `concurrency` so superseded runs are cancelled.",
    );
  }

  // Cancelling is right for a superseded pull request and wrong for a push: the
  // run being killed is the only CI or analysis record a merged commit gets.
  if (onPullRequest && onPush && concurrency !== undefined) {
    const cancel = blockOf(lines, lines.indexOf(concurrency)).find((line) =>
      line.text.startsWith("cancel-in-progress:"),
    );
    if (cancel !== undefined && inlineValue(cancel) === "true") {
      report(
        "ERR_WORKFLOW_CONCURRENCY_CANCELS_PUSH",
        cancel.number,
        "This workflow also runs on push. Make cancel-in-progress conditional on the event being a pull request.",
      );
    }
  }

  // The runner's default shell is `bash -e`: an unset variable expands to the
  // empty string and a failure inside a pipeline is invisible. A script long
  // enough to need a second line is long enough for either to read as success.
  const topLevelShell = defaultsRunShell(lines, topLevel(lines, "defaults"));
  for (const { line, command } of runCommands(source)) {
    const body = command
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "" && !entry.startsWith("#"));
    if (body.length <= 1 || body[0] === "set -euo pipefail") {
      continue;
    }

    // Each level replaces the one above rather than adding to it: a job-level
    // `defaults:` discards the workflow-level one, and a step's own `shell:`
    // discards both. So the shell this body runs under is the innermost one
    // that names a shell at all.
    const job = jobAtLine(jobs, line);
    const jobShell =
      job === undefined
        ? undefined
        : defaultsRunShell(job.body, jobKey(job, "defaults"));
    const stepShell = job === undefined ? undefined : stepShellAtLine(job, line);
    if (isFailClosedShell(stepShell ?? jobShell ?? topLevelShell)) {
      continue;
    }

    report(
      "ERR_WORKFLOW_RUN_NOT_PIPEFAIL",
      line,
      'A multi-line run block must start with `set -euo pipefail`, or run under a defaults.run.shell that spells pipefail out — `shell: bash` is not enough, it leaves -u off. Expected: shell: "bash --noprofile --norc -eo pipefail -u {0}".',
    );
  }

  // An install that may resolve something other than the committed lockfile
  // would make every other gate advisory.
  for (const { line, command } of runCommands(source)) {
    for (const part of command.split("\n")) {
      if (
        /\bpnpm\b[^\n;&|]*\binstall\b/.test(part) &&
        !part.includes("--frozen-lockfile")
      ) {
        report(
          "ERR_WORKFLOW_INSTALL_NOT_FROZEN",
          line,
          `"${part.trim()}" installs without --frozen-lockfile.`,
        );
      }
    }
  }

  return problems;
}

// --- version agreement -------------------------------------------------------

/**
 * Every `version:` a pnpm/action-setup step states.
 *
 * @remarks
 * Expected to be empty: the action reads `packageManager` from package.json,
 * and that field is the only place the pnpm version is written.
 */
function pnpmSetupVersions(source: string): string[] {
  const lines = scan(source);
  const versions: string[] = [];

  for (const job of jobsOf(lines)) {
    for (const step of stepsOf(job)) {
      if (!usesOf(step).some(({ ref }) => ref.startsWith("pnpm/action-setup@"))) {
        continue;
      }
      const version = step
        .map((line) => /^version:\s*"?([\w.-]+)"?$/.exec(line.text)?.[1])
        .find((value) => value !== undefined);
      if (version !== undefined) {
        versions.push(version);
      }
    }
  }
  return versions;
}

// --- fixtures ----------------------------------------------------------------

/** A workflow that satisfies every rule; each test below breaks exactly one thing. */
const CLEAN_WORKFLOW = `name: Example

on:
  pull_request:

permissions: {}

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - name: Install dependencies
        run: pnpm install --frozen-lockfile
`;

/** The same workflow with its one `run:` turned into a block scalar. */
const MULTI_LINE_RUN_WORKFLOW = CLEAN_WORKFLOW.replace(
  "        run: pnpm install --frozen-lockfile\n",
  [
    "        run: |",
    "          pnpm install --frozen-lockfile",
    "          node ./scripts/after.mjs",
    "",
  ].join("\n"),
);

function codesOf(problems: Problem[]): string[] {
  return problems.map((problem) => problem.code);
}

function withoutLine(source: string, needle: string): string {
  return source
    .split("\n")
    .filter((line) => !line.includes(needle))
    .join("\n");
}

// --- the rules, against synthetic workflows ----------------------------------

describe("lintWorkflow", () => {
  it("accepts a workflow that satisfies every rule", () => {
    expect(lintWorkflow(CLEAN_WORKFLOW)).toEqual([]);
  });

  it("rejects an action referenced by tag instead of SHA", () => {
    const source = CLEAN_WORKFLOW.replace(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/checkout@v7",
    );

    expect(codesOf(lintWorkflow(source))).toContain("ERR_WORKFLOW_ACTION_NOT_PINNED");
  });

  it("rejects a short SHA", () => {
    const source = CLEAN_WORKFLOW.replace(
      "3d3c42e5aac5ba805825da76410c181273ba90b1",
      "3d3c42e",
    );

    expect(codesOf(lintWorkflow(source))).toContain("ERR_WORKFLOW_ACTION_NOT_PINNED");
  });

  it("rejects a pinned SHA with no release tag comment", () => {
    const source = CLEAN_WORKFLOW.replace(" # v7.0.1", "");

    expect(codesOf(lintWorkflow(source))).toEqual([
      "ERR_WORKFLOW_ACTION_TAG_COMMENT_MISSING",
    ]);
  });

  it("allows a local action, which has no SHA to pin", () => {
    const source = CLEAN_WORKFLOW.replace(
      "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile\n",
      "      - uses: ./.github/actions/setup\n",
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("rejects a job with no timeout", () => {
    const source = withoutLine(CLEAN_WORKFLOW, "timeout-minutes:");

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_JOB_TIMEOUT_MISSING"]);
  });

  it("does not accept a step timeout in place of the job's", () => {
    const source = withoutLine(CLEAN_WORKFLOW, "    timeout-minutes:").replace(
      "      - name: Install dependencies\n",
      "      - name: Install dependencies\n        timeout-minutes: 10\n",
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_JOB_TIMEOUT_MISSING"]);
  });

  it("rejects a workflow with no top-level permissions", () => {
    const source = withoutLine(CLEAN_WORKFLOW, "permissions: {}");

    expect(codesOf(lintWorkflow(source))).toContain("ERR_WORKFLOW_PERMISSIONS_MISSING");
  });

  it("rejects top-level permissions wider than contents: read", () => {
    const source = CLEAN_WORKFLOW.replace(
      "permissions: {}",
      "permissions:\n  contents: write",
    );

    expect(codesOf(lintWorkflow(source))).toContain(
      "ERR_WORKFLOW_PERMISSIONS_TOO_BROAD",
    );
  });

  it("accepts contents: read as the top-level default", () => {
    const source = CLEAN_WORKFLOW.replace(
      "permissions: {}",
      "permissions:\n  contents: read",
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("rejects a job that does not declare its own permissions", () => {
    const source = withoutLine(
      withoutLine(CLEAN_WORKFLOW, "      contents: read"),
      "    permissions:",
    );

    expect(codesOf(lintWorkflow(source))).toContain("ERR_WORKFLOW_PERMISSIONS_MISSING");
  });

  it("rejects a job that grants write-all", () => {
    const source = CLEAN_WORKFLOW.replace(
      "    permissions:\n      contents: read",
      "    permissions: write-all",
    );

    expect(codesOf(lintWorkflow(source))).toContain(
      "ERR_WORKFLOW_PERMISSIONS_TOO_BROAD",
    );
  });

  it("rejects a checkout that keeps its credentials", () => {
    const source = withoutLine(CLEAN_WORKFLOW, "persist-credentials: false");

    expect(codesOf(lintWorkflow(source))).toEqual([
      "ERR_WORKFLOW_CHECKOUT_CREDENTIALS",
    ]);
  });

  it("rejects a pull-request workflow with no concurrency group", () => {
    const source = CLEAN_WORKFLOW.replace(
      "concurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\n\n",
      "",
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_CONCURRENCY_MISSING"]);
  });

  it("does not require concurrency for a scheduled workflow", () => {
    const source = CLEAN_WORKFLOW.replace(
      "  pull_request:",
      '  schedule:\n    - cron: "0 6 * * 1"',
    ).replace(
      "concurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\n\n",
      "",
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("rejects pull_request_target", () => {
    const source = CLEAN_WORKFLOW.replace("  pull_request:", "  pull_request_target:");

    expect(codesOf(lintWorkflow(source))).toContain("ERR_WORKFLOW_PULL_REQUEST_TARGET");
  });

  it("rejects an install that is not frozen", () => {
    const source = CLEAN_WORKFLOW.replace(
      "pnpm install --frozen-lockfile",
      "pnpm install",
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_INSTALL_NOT_FROZEN"]);
  });

  it("finds an unfrozen install inside a multi-line run block", () => {
    const source = CLEAN_WORKFLOW.replace(
      "        run: pnpm install --frozen-lockfile\n",
      "        run: |\n          set -euo pipefail\n          pnpm install\n",
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_INSTALL_NOT_FROZEN"]);
  });

  it("accepts an install carrying extra pnpm flags", () => {
    const source = CLEAN_WORKFLOW.replace(
      "pnpm install --frozen-lockfile",
      "pnpm $PNPM_RUNTIME_FLAG install --frozen-lockfile",
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("ignores YAML-looking text inside a shell script", () => {
    const source = CLEAN_WORKFLOW.replace(
      "        run: pnpm install --frozen-lockfile\n",
      [
        "        run: |",
        "          set -euo pipefail",
        "          # uses: not-an-action@v1",
        '          echo "permissions: write-all"',
        "          - not a list item",
        "",
      ].join("\n"),
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("rejects setup-node running before pnpm/action-setup", () => {
    const source = CLEAN_WORKFLOW.replace(
      "      - name: Install dependencies\n",
      [
        "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
        "        with:",
        "          node-version-file: .node-version",
        "",
        "      - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10",
        "",
        "      - name: Install dependencies",
        "",
      ].join("\n"),
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_SETUP_ORDER"]);
  });

  it("accepts pnpm/action-setup running first", () => {
    const source = CLEAN_WORKFLOW.replace(
      "      - name: Install dependencies\n",
      [
        "      - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10",
        "",
        "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
        "        with:",
        "          node-version-file: .node-version",
        "",
        "      - name: Install dependencies",
        "",
      ].join("\n"),
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("rejects a multi-line run block with nothing making it fail closed", () => {
    const source = CLEAN_WORKFLOW.replace(
      "        run: pnpm install --frozen-lockfile\n",
      [
        "        run: |",
        "          pnpm install --frozen-lockfile",
        "          node ./scripts/after.mjs",
        "",
      ].join("\n"),
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_RUN_NOT_PIPEFAIL"]);
  });

  it("accepts a multi-line run block covered by a workflow-level shell default", () => {
    const source = MULTI_LINE_RUN_WORKFLOW.replace(
      "permissions: {}\n",
      [
        "permissions: {}",
        "",
        "defaults:",
        "  run:",
        '    shell: "bash --noprofile --norc -eo pipefail -u {0}"',
        "",
      ].join("\n"),
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("does not let a job that names its own shell inherit that default", () => {
    // A job-level `defaults:` replaces the workflow-level one; `shell: bash`
    // there means this job really does run without -u.
    const source = MULTI_LINE_RUN_WORKFLOW.replace(
      "permissions: {}\n",
      [
        "permissions: {}",
        "",
        "defaults:",
        "  run:",
        '    shell: "bash --noprofile --norc -eo pipefail -u {0}"',
        "",
      ].join("\n"),
    ).replace(
      "    steps:\n",
      ["    defaults:", "      run:", "        shell: bash", "    steps:", ""].join(
        "\n",
      ),
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_RUN_NOT_PIPEFAIL"]);
  });

  it("does not let a step that names its own shell inherit a fail-closed default", () => {
    // A step's `shell:` is the last word, so `shell: bash` on the step is what
    // this body really runs under however careful the job's defaults are.
    const source = MULTI_LINE_RUN_WORKFLOW.replace(
      "    steps:\n",
      [
        "    defaults:",
        "      run:",
        '        shell: "bash --noprofile --norc -eo pipefail -u {0}"',
        "    steps:",
        "",
      ].join("\n"),
    ).replace("        run: |\n", "        shell: bash\n        run: |\n");

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_RUN_NOT_PIPEFAIL"]);
  });

  it("accepts a step whose own shell is fail closed, with no set line", () => {
    const source = MULTI_LINE_RUN_WORKFLOW.replace(
      "        run: |\n",
      '        shell: "bash --noprofile --norc -eo pipefail -u {0}"\n        run: |\n',
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("rejects a shell default that spells pipefail out but leaves -u off", () => {
    // `bash -eo pipefail {0}` is the trap the error message names: pipefail is
    // there, so a substring check passes it, while an unset variable still
    // expands to the empty string.
    const source = MULTI_LINE_RUN_WORKFLOW.replace(
      "permissions: {}\n",
      [
        "permissions: {}",
        "",
        "defaults:",
        "  run:",
        '    shell: "bash -eo pipefail {0}"',
        "",
      ].join("\n"),
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_RUN_NOT_PIPEFAIL"]);
  });

  it("rejects cancelling unconditionally on a workflow that also runs on push", () => {
    const source = CLEAN_WORKFLOW.replace(
      "  pull_request:",
      "  push:\n    branches: [main]\n  pull_request:",
    );

    expect(codesOf(lintWorkflow(source))).toEqual([
      "ERR_WORKFLOW_CONCURRENCY_CANCELS_PUSH",
    ]);
  });

  it("accepts a cancellation conditional on the event being a pull request", () => {
    const source = CLEAN_WORKFLOW.replace(
      "  pull_request:",
      "  push:\n    branches: [main]\n  pull_request:",
    ).replace(
      "cancel-in-progress: true",
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("still allows a pull-request-only workflow to cancel unconditionally", () => {
    expect(lintWorkflow(CLEAN_WORKFLOW)).toEqual([]);
  });
});

// --- the rules, against the workflows this repository ships -------------------

const workflowNames = readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();

function workflowSource(name: string): string {
  return readFileSync(path.join(workflowsDir, name), "utf8");
}

describe("the workflows in .github/workflows", () => {
  it("includes every workflow spec 02 §5.2 makes mandatory", () => {
    expect(workflowNames).toEqual([
      "check-pr-title.yml",
      "ci.yml",
      "dependency-review.yml",
      "pr-label.yml",
      "release.yml",
      "security-audit.yml",
      "typos.yml",
    ]);
  });

  it.each(workflowNames)("%s satisfies every rule", (name) => {
    expect(lintWorkflow(workflowSource(name))).toEqual([]);
  });

  // The rules above are only worth anything if the scanner actually reaches
  // every job and every step. These two compare what it found against a plain
  // text count, so a silently skipped block fails here rather than passing as
  // "no problems found".
  it.each(workflowNames)("%s: the scanner sees every job", (name) => {
    const source = workflowSource(name);
    const declared = source
      .split("\n")
      // Job level only: four spaces of indent, which is where jobsOf looks.
      .filter((line) => /^ {4}timeout-minutes:/.test(line)).length;

    expect(jobsOf(scan(source))).toHaveLength(declared);
  });

  it.each(workflowNames)("%s: the scanner sees every action reference", (name) => {
    const source = workflowSource(name);
    const declared = source
      .split("\n")
      .filter((line) => /^\s*(?:- )?uses:/.test(line)).length;

    expect(usesOf(scan(source))).toHaveLength(declared);
  });

  it("pins every action, so nothing is fetched by a movable ref", () => {
    const refs = workflowNames.flatMap((name) =>
      usesOf(scan(workflowSource(name))).map(({ ref }) => ref),
    );

    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((ref) => !PINNED_REF.test(ref))).toEqual([]);
  });

  it("collects coverage exactly once", () => {
    // Spec 02 §5.2: the `test` job is the single source of truth, and a
    // second collector would make the threshold depend on which job finished.
    const collectors = runCommands(workflowSource("ci.yml")).filter(({ command }) =>
      command.includes("test:coverage"),
    );

    expect(collectors).toHaveLength(1);
  });

  it("grants a write scope only where the job cannot do its work without one", () => {
    // pr-label writes a label and tolerates the read-only token a fork PR
    // gets; release needs OIDC and a tag push. Everything else, and in
    // particular everything that runs repository code, stays read-only.
    const writers = workflowNames.filter((name) =>
      scan(workflowSource(name)).some((line) => line.text.endsWith(": write")),
    );

    expect(writers.sort()).toEqual(["pr-label.yml", "release.yml"]);
  });
});

describe("the release workflow preserves the reviewed artifact", () => {
  const source = workflowSource("release.yml");
  const publish = jobsOf(scan(source)).find((job) => job.name === "publish");

  it("uses only read access and OIDC in the publish job", () => {
    expect(publish).toBeDefined();
    if (publish === undefined) {
      return;
    }
    const permissions = jobKey(publish, "permissions");
    expect(permissions).toBeDefined();
    if (permissions === undefined) {
      return;
    }
    expect(
      blockOf(publish.body, publish.body.indexOf(permissions)).map((line) => line.text),
    ).toEqual(["contents: read", "id-token: write"]);
    expect(jobKey(publish, "environment")?.text).toBe("environment: release");
  });

  it("does not refer to a long-lived npm token or enable a dependency cache", () => {
    expect(source).not.toContain("NPM_TOKEN");
    // setup-node's package-manager-cache is explicitly disabled: a release
    // workflow must never restore build state from a previous run's cache.
    expect(source).not.toMatch(/cache:\s*(?!false\b)\S/);
  });

  it("checks the tag before publishing", () => {
    expect(source.indexOf("Verify tag matches package version")).toBeGreaterThan(-1);
    expect(source.indexOf("Verify tag matches package version")).toBeLessThan(
      source.indexOf("npm publish dist/package.tgz"),
    );
  });

  it("builds and packs once, then reuses the fixed tarball path", () => {
    expect(source.match(/\bpnpm pack\b/g)).toHaveLength(1);
    expect(source).toContain("pnpm run package:verify -- --tarball dist/package.tgz");
    expect(source).toContain("npm publish dist/package.tgz");
    expect(source).toContain(
      'npm pack "${PACKAGE}@${VERSION}" --pack-destination dist',
    );
    expect(source).toContain("path: dist/package.tgz");
    expect(source).not.toContain("pnpm check");
    expect(source).toContain("pnpm run check:source");
  });

  it("takes the publish contract from package.json rather than from flags", () => {
    // publishConfig carries access, provenance and the registry (asserted in
    // tests/package.test.ts). A flag here would be a second copy that only
    // this call site obeys — the rehearsal and a manual publish would keep
    // whatever the manifest says, and the two could drift apart unnoticed.
    // --tag is the one exception: publishConfig is a static file and cannot
    // express a per-release dist-tag decision (stable release vs. a
    // release-candidate that must not move `latest`), so that one flag is
    // required rather than forbidden.
    const publishes = runCommands(source).filter(({ command }) =>
      /\bnpm publish\b/.test(command),
    );

    expect(publishes).toHaveLength(1);
    expect(
      publishes.filter(({ command }) =>
        /--(?:access|provenance|registry)\b/.test(command),
      ),
    ).toEqual([]);
  });

  it("always publishes with an explicit dist-tag from the tag-verification step", () => {
    // A release candidate must never move the `latest` npm dist-tag. The
    // verify-tag step derives the right dist-tag (the prerelease identifier,
    // or "latest" for a stable version) and every npm publish call carries
    // it — including the stable case, where it evaluates to `--tag latest`
    // as an explicit statement rather than an implicit default.
    const publishes = runCommands(source).filter(({ command }) =>
      /\bnpm publish\b/.test(command),
    );

    expect(publishes).toHaveLength(1);
    expect(
      publishes.filter(({ command }) =>
        /--tag\s+"\$\{\{\s*steps\.verify-tag\.outputs\.dist_tag\s*\}\}"/.test(command),
      ),
    ).toHaveLength(1);
  });

  it("derives the npm dist-tag and prerelease flag from the version's prerelease identifier", () => {
    expect(source).toContain("id: verify-tag");
    expect(source).toContain('echo "dist_tag=${PRERELEASE_ID}" >> "${GITHUB_OUTPUT}"');
    expect(source).toContain('echo "dist_tag=latest" >> "${GITHUB_OUTPUT}"');
    expect(source).toContain('echo "prerelease=true" >> "${GITHUB_OUTPUT}"');
    expect(source).toContain('echo "prerelease=false" >> "${GITHUB_OUTPUT}"');
  });

  it("marks the GitHub Release as a prerelease when the version has a prerelease identifier", () => {
    expect(source).toContain("needs.publish.outputs.prerelease");
    expect(source).toContain("--prerelease");
    expect(source.indexOf("outputs:")).toBeGreaterThan(-1);
    expect(source).toContain("prerelease: ${{ steps.verify-tag.outputs.prerelease }}");
  });

  it("does not hide a rebuild or repack behind the release scripts", () => {
    const scripts = (
      JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;

    expect(scripts["check:source"]?.match(/\bpnpm run build\b/g)).toHaveLength(1);
    expect(scripts["check:source"]).not.toMatch(/\b(?:pnpm|npm) pack\b/);
    expect(scripts["package:verify"]).not.toContain("build");
    expect(scripts["package:verify"]).not.toMatch(/\b(?:pnpm|npm) pack\b/);
  });
});

// --- the pull-request vocabulary shared by the bots and the changelog --------

const dependabotConfig = readFileSync(
  path.join(repoRoot, ".github", "dependabot.yml"),
  "utf8",
);
const releaseConfig = readFileSync(
  path.join(repoRoot, ".github", "release.yml"),
  "utf8",
);

/** The entries of a `key: |` block scalar, trimmed, in file order. */
function blockScalarEntries(source: string, key: string): string[] {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${key}: |`);
  const header = lines[start];
  if (start === -1 || header === undefined) {
    return [];
  }

  const indent = header.length - header.trimStart().length;
  const entries: string[] = [];
  for (let next = start + 1; next < lines.length; next += 1) {
    const line = lines[next];
    if (line === undefined) {
      break;
    }
    if (line.trim() === "") {
      continue;
    }
    if (line.length - line.trimStart().length <= indent) {
      break;
    }
    entries.push(line.trim());
  }
  return entries;
}

/** The Conventional Commit types every `commit-message.prefix` in dependabot.yml asks for. */
function dependabotCommitTypes(source: string): string[] {
  return [...source.matchAll(/^\s*prefix:\s*"?([^"\s]+?):?"?\s*$/gm)].flatMap(
    (match) => match[1] ?? [],
  );
}

describe("the PR title vocabulary covers everything that can open a PR", () => {
  const allowedTypes = blockScalarEntries(
    workflowSource("check-pr-title.yml"),
    "types",
  );

  it("declares the allowed types instead of inheriting the action's default", () => {
    // The action's built-in default is not visible in this repository and does
    // not contain `deps`, so every Dependabot PR failed a check whose rule
    // nobody could read. What is enforced has to be written down here.
    expect(allowedTypes).toContain("feat");
    expect(allowedTypes).toContain("fix");
    expect(allowedTypes).toContain("chore");
  });

  it("accepts every prefix Dependabot commits with", () => {
    const prefixes = dependabotCommitTypes(dependabotConfig);

    expect(prefixes).not.toEqual([]);
    expect(prefixes.filter((prefix) => !allowedTypes.includes(prefix))).toEqual([]);
  });

  it("gives every label pr-label.yml can apply a changelog category", () => {
    // pr-label.yml derives a label from the title type; .github/release.yml
    // sorts the generated release notes by that label. A label with no category
    // silently drops its PRs out of the notes.
    const labels = [
      ...workflowSource("pr-label.yml").matchAll(/\blabel=([a-z][a-z-]*)/g),
    ].flatMap((match) => match[1] ?? []);
    const categorized = [...releaseConfig.matchAll(/labels:\s*\[([^\]]+)\]/g)].flatMap(
      (match) => (match[1] ?? "").split(",").map((entry) => entry.trim()),
    );

    expect(labels).not.toEqual([]);
    expect(labels.filter((label) => !categorized.includes(label))).toEqual([]);
  });
});

describe("the Dependabot cooldown agrees with the pnpm install cooldown", () => {
  it("states the same window in days and in minutes", () => {
    // pnpm refuses to install a version younger than `minimumReleaseAge`, so a
    // Dependabot PR proposing one is a PR that cannot go green. A comment in
    // dependabot.yml claims the two match; this is what checks it.
    const days = [
      ...dependabotConfig.matchAll(/^\s*default-days:\s*(\d+)\s*$/gm),
    ].flatMap((match) => match[1] ?? []);
    const minutes = /^minimumReleaseAge:\s*(\d+)\s*$/m.exec(
      readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8"),
    )?.[1];

    expect(days).not.toEqual([]);
    expect(minutes).toBeTypeOf("string");
    for (const value of days) {
      expect(Number(value) * 1440).toBe(Number(minutes));
    }
  });

  it("gives every update ecosystem a cooldown", () => {
    const ecosystems = dependabotConfig.match(/^\s*- package-ecosystem:/gm) ?? [];
    const cooldowns = dependabotConfig.match(/^\s*cooldown:/gm) ?? [];

    expect(ecosystems).not.toEqual([]);
    expect(cooldowns).toHaveLength(ecosystems.length);
  });
});

describe("workflow regression checks for repository automation", () => {
  it("runs the test job as a fail-fast-free OS matrix with one coverage leg", () => {
    const source = workflowSource("ci.yml");
    const testStart = source.indexOf("  test:");
    const packageStart = source.indexOf("  package:", testStart);
    const testJob = source.slice(testStart, packageStart);

    expect(testJob).toContain("name: Test (${{ matrix.os }})");
    expect(testJob).toContain("strategy:");
    expect(testJob).toContain("fail-fast: false");
    expect(testJob).toContain("os: [ubuntu-latest]");
    expect(testJob).toContain("if: matrix.os == 'ubuntu-latest'");
    expect(testJob).toContain("if: matrix.os != 'ubuntu-latest'");
    expect(testJob).toContain("run: pnpm run test:coverage");
    expect(testJob).toContain("run: pnpm run test");
    expect((testJob.match(/run: pnpm run test:coverage/g) ?? []).length).toBe(1);
  });

  it("keeps the template's bootstrap job out of CI", () => {
    // Bootstrap removed the flow and its scripts from this repository. A job
    // naming either would fail on a file that no longer exists, so the
    // invariant worth checking here is that neither comes back.
    const source = workflowSource("ci.yml");
    expect(source).not.toContain("  bootstrap:");
    expect(source).not.toContain("scripts/verify-bootstrap.mjs");
    expect(source).not.toContain("pnpm run bootstrap:e2e");
    expect(source.toLowerCase()).not.toContain("change" + "set");
  });

  it("keeps the dependency-review severity gate", () => {
    // Without `fail-on-severity` the action reports advisories and passes, so
    // the workflow's presence in .github/workflows/ would prove nothing.
    expect(workflowSource("dependency-review.yml")).toMatch(
      /^\s*fail-on-severity:\s*\S+/m,
    );
  });

  it("fails closed after finite security-audit retries", () => {
    const source = workflowSource("security-audit.yml");
    expect(source).not.toContain("--ignore-registry-errors");
    expect(source).toContain("for attempt in 1 2 3");
    expect(source).toContain("exit 1");
  });

  it("checks the published Node floor with package:smoke after packing on Node 24", () => {
    const source = workflowSource("ci.yml");
    const packageFloorStart = source.indexOf("  package-floor:");
    expect(packageFloorStart).toBeGreaterThan(-1);
    const packageFloor = source.slice(packageFloorStart);

    expect(packageFloor).toContain("node-version: 20");
    expect(packageFloor).toContain("pnpm run build");
    expect(packageFloor).toContain("pnpm pack --pack-destination .smoke");
    // `node`, not `pnpm run`: pnpm 11 requires Node >=22.13, so a floor below
    // that never reaches the smoke checks. Asserted so the pnpm launcher
    // cannot quietly come back.
    expect(packageFloor).toContain("node scripts/package-smoke.mjs --pack-dir .smoke");
    expect(packageFloor).not.toContain("pnpm run package:smoke");
    expect(packageFloor).toContain("pnpm install --frozen-lockfile");
  });
});

// --- agreement with package.json and .node-version ---------------------------

interface Manifest {
  engines?: { node?: string };
  packageManager?: string;
  devEngines?: {
    runtime?: { onFail?: string; version?: string };
    packageManager?: { version?: string };
  };
}

const manifest = JSON.parse(
  readFileSync(path.join(repoRoot, "package.json"), "utf8"),
) as Manifest;
describe("the development runtime contract fails closed", () => {
  it("treats the Node 24 requirement as an error", () => {
    expect(manifest.devEngines?.runtime?.onFail).toBe("error");
  });

  it("keeps devEngines and .node-version on the development Node major", () => {
    // `devEngines.runtime.version` is what pnpm enforces locally, and
    // `.node-version` is what the source-check jobs install. The published
    // `engines.node` floor is intentionally independent and is exercised by
    // the package-floor job above.
    const major = (value: string) => /(\d+)/.exec(value)?.[1];
    const nodeVersionFile = readFileSync(
      path.join(repoRoot, ".node-version"),
      "utf8",
    ).trim();

    expect(major(manifest.devEngines?.runtime?.version ?? "")).toBe(
      major(nodeVersionFile),
    );
  });

  it("keeps the published floor explicit and matching the package-floor job", () => {
    expect(manifest.engines?.node).toBe(">=20");
  });
});

describe("package.json is the only place the pnpm version is written", () => {
  const declared = manifest.devEngines?.packageManager?.version;

  it("is declared in package.json", () => {
    expect(declared).toBeTypeOf("string");
  });

  // pnpm/action-setup reads the exact `packageManager` field, so a `version:`
  // input is a second copy of a number that has one home. This used to be
  // asserted the other way round — every copy had to agree with the manifest —
  // which kept nine copies correct instead of removing them. The inversion is
  // deliberate: the version cannot drift if no workflow states it.
  it.each(workflowNames)("%s states no pnpm version of its own", (name) => {
    expect(pnpmSetupVersions(workflowSource(name))).toEqual([]);
  });

  it("would notice a version that came back", () => {
    // A rule that asserts an empty list has to be shown capable of a non-empty
    // one, or it goes on passing after the scanner stops finding anything.
    const stated = CLEAN_WORKFLOW.replace(
      "      - name: Install dependencies\n",
      [
        "      - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10",
        "        with:",
        "          version: 11.18.0",
        "",
        "      - name: Install dependencies",
        "",
      ].join("\n"),
    );

    expect(pnpmSetupVersions(stated)).toEqual(["11.18.0"]);
  });

  it("declares the same pnpm string in packageManager and devEngines", () => {
    // pnpm warns on every command when the two disagree, and says it will
    // ignore `packageManager` — the field corepack and Dependabot read. Keep
    // them byte-identical so neither the warning nor the drift can return.
    expect(manifest.packageManager).toBe(`pnpm@${declared ?? ""}`);
  });
});
