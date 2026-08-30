import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// `check:source` restates, as one composite script, ground that
// `.github/workflows/ci.yml`'s `static` and `test` jobs also cover as
// separate `run:` steps (split for failure attribution — a reader should see
// which step failed, not just that the composite did). Nothing asserted the
// two lists stay in sync, so a step added to one silently stops being
// enforced by the other. `release.yml` is the only caller of `check:source`
// as a unit, so a gate added there alone is enforced only at release time.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** A script name has no exception here today, but the mechanism stays ready. */
const CI_SYNC_EXCEPTIONS = new Map<string, string>();

/**
 * Extract the `pnpm run <name>` tokens out of `check:source`'s definition,
 * in order.
 */
function checkSourceSteps(): string[] {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const scripts =
    typeof manifest === "object" && manifest !== null && "scripts" in manifest
      ? manifest.scripts
      : undefined;
  const checkSource =
    typeof scripts === "object" && scripts !== null && "check:source" in scripts
      ? scripts["check:source"]
      : undefined;
  if (typeof checkSource !== "string") {
    throw new Error('package.json has no "check:source" script to check.');
  }
  return [...checkSource.matchAll(/pnpm run ([\w:-]+)/g)].map(
    (match) => match[1] ?? "",
  );
}

/**
 * Extract every `pnpm run <name>` step inside one named top-level job block
 * of `ci.yml`, from that job's header up to the next top-level job (or the
 * end of the file).
 */
function ciJobSteps(jobName: string): string[] {
  const text = readFileSync(
    path.join(repoRoot, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  const jobStart = new RegExp(`^  ${jobName}:$`, "m").exec(text);
  if (jobStart === null) {
    throw new Error(`ci.yml has no top-level job named "${jobName}".`);
  }
  const rest = text.slice(jobStart.index + jobStart[0].length);
  const nextJob = /^ {2}[a-z][a-z-]*:$/m.exec(rest);
  const body = nextJob === null ? rest : rest.slice(0, nextJob.index);
  return [...body.matchAll(/run:\s*pnpm run ([\w:-]+)/g)].map(
    (match) => match[1] ?? "",
  );
}

describe("check:source stays in sync with ci.yml", () => {
  const steps = checkSourceSteps();
  const ciSteps = new Set([...ciJobSteps("static"), ...ciJobSteps("test")]);

  it("found at least one step to check", () => {
    expect(steps.length).toBeGreaterThan(0);
  });

  it.each(steps)(
    "%s runs as its own ci.yml step, or is a documented exception",
    (step) => {
      expect(ciSteps.has(step) || CI_SYNC_EXCEPTIONS.has(step)).toBe(true);
    },
  );

  it("every documented exception still names a real check:source step", () => {
    for (const name of CI_SYNC_EXCEPTIONS.keys()) {
      expect(steps).toContain(name);
    }
  });
});
