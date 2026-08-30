# Contributing

## Setup

Use Node.js 24 and pnpm 11 through Corepack:

```sh
node --version
corepack enable
corepack pnpm@11.18.0 install --frozen-lockfile
pnpm hooks:install
pnpm check
```

The first command must report Node 24.x. `devEngines.runtime.onFail` is an intentional
hard error for normal development; use the documented `--config.runtime-on-fail=ignore`
override only for the minimum-Node compatibility check below.

Useful focused commands are `pnpm check:quick`, `pnpm test`, `pnpm test:coverage`,
`pnpm build`, `pnpm docs:build`, and `pnpm package:smoke`.

## Dependency cooldown

The seven-day dependency cooldown in `pnpm-workspace.yaml` is fail-closed. If an urgent
security fix is younger than seven days, a maintainer may add the exact package and
version to `minimumReleaseAgeExclude` in the same reviewed PR as the lockfile update.
Record the advisory and why waiting is riskier, remove the exception after the version
ages out, and never use a broad package-only or wildcard exclusion.

Development and source checks stay on Node 24. A generated package's published Node
floor is checked separately by the `package-floor` CI job, which consumes the packed
artifact at the selected floor.

## Pull requests

Create a feature branch, keep commits focused, and use a Conventional Commit PR title.
Update behavior tests, type tests, and documentation when the public contract changes,
and say in the PR what the change does to the version. Run `pnpm check` before
requesting review.

Every pull request explains whether it changes the published package and keeps the
README, tests, and documentation in sync when it does. Documentation, test, CI, and
tooling changes with no release impact need no release record. During the 0.x period, a
breaking change uses a minor bump and must include migration instructions; after 1.0 it
uses a major bump.

## First release

`release.yml` publishes through npm trusted publishing (OIDC, `id-token: write`,
`environment: release`), but npm only lets a trusted publisher be registered against a
package that already exists on the registry. The very first release has to get the
package onto the registry a different way before trusted publishing can take over:

1. Confirm the name is free — `package.json`'s own `name` field is the name this applies
   to. A 404 from the command below means nobody has published it yet:

   ```sh
   npm view hookassert
   ```

2. Create the `release` GitHub Environment — the name `release.yml`'s
   `environment: release` targets — and add a required reviewer to it.
3. Publish the first version once, outside `release.yml`: run `npm publish` locally with
   2FA enabled, or generate a granular, scoped npm automation token and use it exactly
   once. This repository has no opinion between the two; `release.yml` itself carries no
   token and only ever drives OIDC trusted publishing, so either method is equally fine
   for this one manual step.
4. Register npm trusted publishing for the now-existing package, pointing it at this
   repository's `release.yml` workflow.
5. Revoke or delete the one-time publish token — it should never be needed again once
   trusted publishing is registered.
6. Tag the release: an annotated `vX.Y.Z` tag matching `package.json`, the same
   convention "Cutting a prerelease" below uses. Pushing the tag still runs
   `release.yml`; since the version is already on the registry, the workflow takes its
   already-published path and only attaches the GitHub Release, without publishing
   again.

## Release recovery

Releases are driven by a reviewed release PR and an annotated `vX.Y.Z` tag matching
`package.json`. If a workflow fails before npm publish, fix the cause and rerun it. If
npm already contains the version, never publish that version again — verify it first:

```sh
npm view hookassert@X.Y.Z version
```

Then repair only the GitHub Release by rerunning the release attachment job or uploading
the original workflow artifact.

A bad release that already reached npm is fixed forward, never by republishing the same
version:

- **Broken but harmless** (a bug, not a security issue): deprecate the bad version so it
  still resolves but warns, then ship a patch release with the fix:

  ```sh
  npm deprecate hookassert@X.Y.Z "<reason>"
  ```

- **Harmful or leaking** (a real vulnerability, a leaked secret, or actively broken
  behavior): move `latest` back to the last good version first, deprecate the bad
  version, file a GitHub Security Advisory, then ship the fix:

  ```sh
  npm dist-tag add hookassert@GOOD.X.Y.Z latest
  npm deprecate hookassert@BAD.X.Y.Z "<reason>"
  ```

- **Unpublish** only inside npm's 72-hour window, and only for a version that should
  never have existed. It is never a routine rollback; a corrected new version is.

Supported versions: the latest minor release of the current major version is supported.
During the `0.x` period, only the latest `0.x` release is supported.

### Cutting a prerelease

To ship a release candidate without moving the `latest` npm dist-tag, set
`package.json`'s version to a semver prerelease (`1.0.0-rc.1`, `1.0.0-next.3`) and push
a matching annotated tag (`v1.0.0-rc.1`, `v1.0.0-next.3`). `release.yml` parses the
prerelease identifier (`rc`, `next`, …) out of the version and:

- publishes to the npm dist-tag named after that identifier instead of `latest` — a
  plain install still resolves to `latest`:

  ```sh
  npm install hookassert@rc
  npm install hookassert
  ```

- creates the GitHub Release marked as a pre-release.

A version with no prerelease identifier publishes to `latest` and creates an ordinary
GitHub Release, exactly as before.
