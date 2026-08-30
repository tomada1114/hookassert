import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkStagedChange, main, stagedChanges } from "../scripts/check-staged.mjs";

// scripts/check-staged.mjs is the pre-commit layer described in AGENTS.md's
// "Enforcement layers": it sees a staged git diff, not a tool call, so these
// tests drive it against a real throwaway repository rather than mocking git.
const repos: string[] = [];

// The suite itself runs from a git hook (`lefthook.yml` runs `test:related` on
// pre-commit), and git hands a hook GIT_DIR and, for a partial
// `git commit -- <path>`, GIT_INDEX_FILE. `scripts/check-staged.mjs`
// is meant to honor those — it is the pre-commit layer. Here they must go, or
// the fixture repositories below are built inside the checkout this suite is
// running in. See scripts/lib/git-env.mjs.
function clearGitEnvironment(): void {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("GIT_")) {
      vi.stubEnv(name, undefined);
    }
  }
}

beforeEach(clearGitEnvironment);

/** A fresh, empty git repository with a local identity, isolated from real user config. */
function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "check-staged-test-"));
  repos.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

/** Write a file, stage it, and return the repo-relative path for convenience. */
function stage(dir: string, relativePath: string, content: string): string {
  const absolute = path.join(dir, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
  execFileSync("git", ["add", relativePath], { cwd: dir });
  return relativePath;
}

/** Commit whatever is currently staged, so a later change has a HEAD to diff against. */
function commit(dir: string, message = "initial"): void {
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir });
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (repos.length > 0) {
    const dir = repos.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("stagedChanges", () => {
  it("reports an added file as status A", () => {
    const dir = makeRepo();
    stage(dir, "notes.md", "hello\n");
    expect(stagedChanges(dir)).toEqual([{ status: "A", path: "notes.md" }]);
  });

  it("reports a deleted file as status D", () => {
    const dir = makeRepo();
    stage(dir, "notes.md", "hello\n");
    commit(dir);
    execFileSync("git", ["rm", "-q", "notes.md"], { cwd: dir });
    expect(stagedChanges(dir)).toEqual([{ status: "D", path: "notes.md" }]);
  });

  it("reports nothing when the index matches HEAD", () => {
    const dir = makeRepo();
    stage(dir, "notes.md", "hello\n");
    commit(dir);
    expect(stagedChanges(dir)).toEqual([]);
  });

  it("throws ERR_GIT_FAILED when cwd is not a git repository", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "check-staged-not-a-repo-"));
    repos.push(dir);
    expect(() => stagedChanges(dir)).toThrow(/ERR_GIT_FAILED/);
  });

  it("throws ERR_GIT_UNAVAILABLE when git cannot even be spawned in cwd", () => {
    const missing = path.join(tmpdir(), "check-staged-does-not-exist-xyz");
    expect(() => stagedChanges(missing)).toThrow(/ERR_GIT_UNAVAILABLE/);
  });
});

describe("checkStagedChange", () => {
  it("blocks staging a real .env file", () => {
    const dir = makeRepo();
    const change = { status: "A", path: stage(dir, ".env", "API_TOKEN=live\n") };
    expect(checkStagedChange(change, dir)).toMatch(/must not be committed/);
  });

  it("allows staging a .env.example file", () => {
    const dir = makeRepo();
    const change = { status: "A", path: stage(dir, ".env.example", "API_TOKEN=\n") };
    expect(checkStagedChange(change, dir)).toBeNull();
  });

  it("blocks a staged file that embeds a credential", () => {
    const dir = makeRepo();
    const key = ["-----BEGIN RSA ", "PRIVATE ", "KEY-----"].join("");
    const change = { status: "A", path: stage(dir, "notes.txt", `${key}\n`) };
    expect(checkStagedChange(change, dir)).toMatch(/private key/);
  });

  it("allows weakening a config file", () => {
    // Deliberate: whether relaxing a gate is a good idea is a judgement call,
    // and a judgement call belongs in the pull request, where a reader can
    // disagree with it. A hook that blocked this would fire on legitimate work
    // and teach its author to reach for `--no-verify`, which would disable the
    // secret checks above along with it.
    const dir = makeRepo();
    stage(dir, "eslint.config.mjs", "reportUnusedDisableDirectives\n");
    commit(dir);
    const change = {
      status: "M",
      path: stage(dir, "eslint.config.mjs", "// removed\n"),
    };
    expect(checkStagedChange(change, dir)).toBeNull();
  });

  it("allows deleting a file, whatever it is", () => {
    const dir = makeRepo();
    stage(dir, "package.json", "{}\n");
    commit(dir);
    execFileSync("git", ["rm", "-q", "package.json"], { cwd: dir });
    const change = { status: "D", path: "package.json" };
    expect(checkStagedChange(change, dir)).toBeNull();
  });

  it("allows a re-generated lockfile", () => {
    // The pre-commit layer deliberately does not check lockfile content: a
    // regenerated lockfile is an ordinary, expected commit, and a git diff
    // cannot tell it apart from a hand edit. Only a layer that sees the tool
    // call that produced the change can — `permissions.deny`'s
    // `Edit(/pnpm-lock.yaml)`. See AGENTS.md's "Enforcement layers".
    const dir = makeRepo();
    stage(dir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    commit(dir);
    const change = {
      status: "M",
      path: stage(dir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\npackages: {}\n"),
    };
    expect(checkStagedChange(change, dir)).toBeNull();
  });

  it("allows an ordinary source change", () => {
    const dir = makeRepo();
    const change = {
      status: "A",
      path: stage(dir, "src/example.ts", "export const value = 1;\n"),
    };
    expect(checkStagedChange(change, dir)).toBeNull();
  });

  it.each([
    ["id_rsa", "id_rsa"],
    ["id_dsa", "id_dsa"],
    ["id_ecdsa", "id_ecdsa"],
    ["id_ecdsa_sk", "id_ecdsa_sk"],
    ["id_ed25519", "id_ed25519"],
    ["id_ed25519_sk", "id_ed25519_sk"],
    [".pem file", "server.pem"],
    [".p12 file", "client.p12"],
    [".pfx file", "client.pfx"],
    [".key file", "server.key"],
    [".ppk file", "server.ppk"],
    ["a nested key file", ".ssh/id_rsa"],
    ["a mixed-case extension", "server.PEM"],
    ["a mixed-case basename", "ID_RSA"],
  ])("blocks staging a %s regardless of its content", (_label, relativePath) => {
    const dir = makeRepo();
    // The rule fires on the path alone, so content that would otherwise pass
    // every credential-content check still gets blocked here.
    const change = {
      status: "A",
      path: stage(dir, relativePath, "not secret-shaped\n"),
    };
    expect(checkStagedChange(change, dir)).toMatch(/private key file/);
  });

  it("allows a file that merely mentions id_rsa in its own name", () => {
    const dir = makeRepo();
    const change = {
      status: "A",
      path: stage(dir, "docs/id_rsa-rotation.md", "How to rotate an id_rsa key.\n"),
    };
    expect(checkStagedChange(change, dir)).toBeNull();
  });
});

describe("main", () => {
  it("returns 0 when nothing staged is unsafe", () => {
    const dir = makeRepo();
    stage(dir, "src/example.ts", "export const value = 1;\n");
    expect(main(dir)).toBe(0);
  });

  it("returns 1 when a staged change is blocked", () => {
    const dir = makeRepo();
    stage(dir, ".env", "API_TOKEN=live\n");
    expect(main(dir)).toBe(1);
  });
});
