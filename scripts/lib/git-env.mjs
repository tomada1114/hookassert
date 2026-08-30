// Build an environment for a `git` process that must decide its own repository.
//
// Git exports `GIT_DIR` (and friends) to every hook it runs, and `lefthook.yml`
// runs this project's own test suite from one of them — `test:related` on
// pre-commit. A `git` spawned with only a `cwd`
// inherits those variables, and an inherited `GIT_DIR` outranks both the cwd and
// an explicit `-C`: git then treats the current directory as the work tree while
// writing to the *outer* repository's index, config, and object store. A
// throwaway fixture repository built that way stages its `.env` into the real
// index and rewrites the real `.git/config`.
//
// A git spawn that names the repository it means — an explicit `-C`, or a
// throwaway directory it just created — clears these variables and lets that
// name decide. `scripts/check-staged.mjs` is the one deliberate exception: it
// *is* the pre-commit layer, and `git commit -- <path>` hands its hook a
// temporary index through GIT_INDEX_FILE that the default index does not
// contain, so it has to inherit. Its tests clear the variables from their own
// process instead (`vi.stubEnv`), which is also how `tests/bootstrap.test.ts`
// keeps its fixtures out of the checkout.
import process from "node:process";

/**
 * Copy an environment with every `GIT_*` variable removed.
 *
 * @remarks
 * The whole prefix goes, not a hand-kept list: `GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_COMMON_DIR`, `GIT_NAMESPACE`,
 * `GIT_CEILING_DIRECTORIES` and the `GIT_CONFIG_*` family all redirect where git
 * reads and writes, and a list that has to be kept in step with git's own is a
 * list that will be out of date the next time one is added. A fixture repository
 * needs none of them. Nothing spawned with this environment talks to a remote,
 * so the transport and credential variables in that prefix have nothing to
 * carry: `git init`, `add`, `ls-files` and `show` against a local directory.
 *
 * @param {NodeJS.ProcessEnv} [env] - Environment to copy. Defaults to the
 * current process environment.
 * @returns {NodeJS.ProcessEnv} A copy holding no `GIT_*` variable.
 *
 * @example
 * ```js
 * execFileSync("git", ["init", "-q"], { cwd: fixture, env: isolatedGitEnv() });
 * ```
 */
export function isolatedGitEnv(env = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const isolated = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("GIT_")) {
      isolated[key] = value;
    }
  }
  return isolated;
}
