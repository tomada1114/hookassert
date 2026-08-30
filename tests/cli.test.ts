import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { isMain, main, runCli } from "../src/cli.js";

/** The commands hookassert will ship, in the order the usage text lists them. */
const SUBCOMMANDS = ["explain", "lint", "record", "test"] as const;

/** The `ERR_` shape AGENTS.md fixes for every published error code. */
const ERROR_CODE = /^ERR_[A-Z0-9_]+$/;

/** First stderr line, minus the trailing newline. */
function firstLine(stderr: string): string {
  return stderr.split("\n")[0] ?? "";
}

describe("runCli help", () => {
  it("--help still exits 0 and prints the usage line", () => {
    const result = runCli(["--help"], "my-tool");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: my-tool <command> [options]");
  });

  it.each(SUBCOMMANDS)("--help lists the %s command in the usage text", (name) => {
    expect(runCli(["--help"]).stdout).toContain(`  ${name}`);
  });

  it("returns help on the short help flag", () => {
    const result = runCli(["-h"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: hookassert <command> [options]");
    expect(result.stderr).toBe("");
  });

  it("prefers help over dispatch when a command is also given", () => {
    // `hookassert explain --help` asks about `explain`; until explain exists,
    // the general usage text is the honest answer, and it must not be an error.
    const result = runCli(["explain", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("exits 0 with the usage text when given no arguments", () => {
    // Deliberate: a bare invocation stays exit 0, as it was before subcommand
    // dispatch existed. Only the empty stdout changes — printing the commands
    // is what a reader of a bare `hookassert` actually needs.
    const result = runCli([], "my-tool");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: my-tool <command> [options]");
  });
});

describe("runCli dispatch", () => {
  it("exits 4 with ERR_USAGE when the subcommand is unrecognized", () => {
    const result = runCli(["frobnicate"], "my-tool");
    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe("");
    expect(firstLine(result.stderr)).toBe(
      'my-tool: ERR_USAGE: unknown command "frobnicate". ' +
        "Expected one of: explain, lint, record, test.",
    );
  });

  it("treats a leading option as an unknown command rather than ignoring it", () => {
    // Nothing parses options yet, so `--json` reaching dispatch must fail
    // loudly instead of silently selecting no command.
    const result = runCli(["--json"]);
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain('unknown command "--json"');
  });

  it.each(SUBCOMMANDS)("exits 4 with a not-yet-implemented message for %s", (name) => {
    const result = runCli([name], "my-tool");
    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe("");
    expect(firstLine(result.stderr)).toBe(
      `my-tool: ERR_USAGE: the "${name}" command is not implemented yet.`,
    );
  });

  it("points at the help flag on every usage error", () => {
    expect(runCli(["frobnicate"], "my-tool").stderr).toContain(
      "Run `my-tool --help` for usage.",
    );
  });

  it("reports a usage error with an ERR_-prefixed code", () => {
    // The code is the contract a CI log or a wrapper script branches on; the
    // prose after it is not. See the `designing-errors` skill.
    const code = /^[^:]+: (\S+):/.exec(firstLine(runCli(["frobnicate"]).stderr))?.[1];
    expect(code).toMatch(ERROR_CODE);
  });

  it("ends stderr with a newline so a terminal does not glue on the next line", () => {
    expect(runCli(["frobnicate"]).stderr.endsWith("\n")).toBe(true);
  });
});

describe("main", () => {
  /** Capture the two streams at the process boundary, the only mock here. */
  function captureStreams(): { stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    return { stdout, stderr };
  }

  it("writes the usage text to stdout and returns 0 for --help", () => {
    const streams = captureStreams();
    expect(main(["--help"])).toBe(0);
    expect(streams.stdout.join("")).toContain("Usage: hookassert <command> [options]");
    expect(streams.stderr.join("")).toBe("");
  });

  it("writes a usage error to stderr and returns its exit code", () => {
    const streams = captureStreams();
    expect(main(["frobnicate"])).toBe(4);
    expect(streams.stdout.join("")).toBe("");
    expect(streams.stderr.join("")).toContain("ERR_USAGE");
  });
});

describe("isMain", () => {
  it("recognizes nothing when the module is not the process entry point", () => {
    // Vitest's own runner is `process.argv[1]` here, so this is the negative
    // case; it also exercises the unresolvable-path fallback, since the module
    // named below does not exist on disk.
    expect(isMain(pathToFileURL("/nonexistent/hookassert/cli.js").href)).toBe(false);
  });

  it("recognizes the module Node was actually started with", () => {
    const entry = process.argv[1];
    if (entry === undefined) {
      throw new Error("the test runner should always be process.argv[1]");
    }
    expect(isMain(pathToFileURL(entry).href)).toBe(true);
  });
});
