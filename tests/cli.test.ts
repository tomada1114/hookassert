import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";

describe("runCli", () => {
  it("returns help on --help", () => {
    expect(runCli(["--help"], "my-tool")).toEqual({
      exitCode: 0,
      stdout:
        "Usage: my-tool [options]\n\n" +
        "Options:\n" +
        "  -h, --help  Show this help message.\n",
      stderr: "",
    });
  });

  it("returns help on the short help flag", () => {
    const result = runCli(["-h"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: package [options]");
    expect(result.stderr).toBe("");
  });

  it("does not write output for an invocation without options", () => {
    expect(runCli([])).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });
});
