/**
 * Internal plumbing types for fixture YAML files.
 *
 * @remarks
 * Everything here except `PayloadOrigin` — which is part of the published
 * contract and lives in `src/types.ts`, because a fixture's resolved origin
 * is meant to be read by a later confidence display outside this module — is
 * not part of the published contract: `src/index.ts` re-exports only
 * `src/types.ts`'s vocabulary, and ESLint's `public-api/internal-stays-private`
 * block forbids `src/index.ts` from importing anything under `src/internal/`
 * at all, so nothing declared here can leak into the public surface by
 * accident. They live next to the module that uses them rather than in
 * `src/types.ts`, which is reserved for the vocabulary every module speaks —
 * this one is spoken only by `src/internal/fixture/**`.
 *
 * Two shapes exist for a fixture's cases and top-level structure: the `Raw*`
 * interfaces mirror `schema/fixture.schema.json` field for field — an
 * `event` that has not yet been checked against the closed `EventName` set,
 * and an `origin.recorded` that is still the string path as written in the
 * YAML — and `guards.ts` validates directly against them. `load.ts` is what
 * turns a `RawFixtureFile` into a `FixtureFile`: narrowing every case's
 * `event` to `EventName` and resolving `origin` into a `PayloadOrigin`.
 */

import type { EventName, PayloadOrigin } from "../../types.js";

/** The closed set of decision kinds a fixture case's `expect.decision` may name. */
export type FixtureDecision = "deny" | "allow" | "pass" | "error" | "unknown";

/** File-level defaults a case falls back to when it declares no override of its own. */
export interface FixtureDefaults {
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

/** The raw `origin.recorded` shape straight off the schema: a string path, not yet resolved. */
export interface RawFixtureOrigin {
  readonly recorded: string;
}

/** What a fixture case expects to observe once the matching hooks have run. */
export interface FixtureExpectation {
  readonly fires: boolean | undefined;
  readonly decision: FixtureDecision | undefined;
  readonly exitCode: number | undefined;
  readonly stdoutContains: string | undefined;
  readonly stderrContains: string | undefined;
  readonly context: unknown;
  readonly updatedInput: unknown;
  readonly timedOut: boolean | undefined;
}

/** The raw `expect` shape straight off the schema, before `FixtureCase` normalizes its optional fields to `T | undefined`. */
export interface RawFixtureExpectation {
  readonly fires?: boolean;
  readonly decision?: FixtureDecision;
  readonly exitCode?: number;
  readonly stdoutContains?: string;
  readonly stderrContains?: string;
  readonly context?: unknown;
  readonly updatedInput?: unknown;
  readonly timedOut?: boolean;
}

/** One command a fixture case stubs out rather than lets a hook actually spawn. */
export interface FixtureStubEntry {
  readonly exitCode: number;
}

/** The raw `cases[].event` shape straight off the schema: a string, not yet narrowed to `EventName`. */
export interface RawFixtureCase {
  readonly event: string;
  readonly tool?: string;
  readonly input?: unknown;
  readonly origin?: RawFixtureOrigin;
  readonly expect: RawFixtureExpectation;
  readonly stub?: Readonly<Record<string, FixtureStubEntry>>;
  readonly dryRun?: boolean;
  readonly cwd?: string;
}

/** One test case declared in a fixture file, after `load.ts` has resolved its `event` and `origin`. */
export interface FixtureCase {
  readonly event: EventName;
  readonly tool: string | undefined;
  readonly input: unknown;
  readonly origin: PayloadOrigin;
  readonly expect: FixtureExpectation;
  readonly stub: Readonly<Record<string, FixtureStubEntry>> | undefined;
  readonly dryRun: boolean | undefined;
  readonly cwd: string | undefined;
}

/** The raw fixture file shape straight off `schema/fixture.schema.json`, before `load.ts` resolves it into a `FixtureFile`. */
export interface RawFixtureFile {
  readonly settings?: readonly string[];
  readonly defaults?: FixtureDefaults;
  readonly cases: readonly RawFixtureCase[];
}

/** One fixture YAML file, loaded, schema-validated, and load-time-checked against the spec. */
export interface FixtureFile {
  readonly settings: readonly string[];
  readonly defaults: FixtureDefaults | undefined;
  readonly cases: readonly FixtureCase[];
}

/** One fixture file, paired with the absolute path it was loaded from. */
export interface LoadedFixtureFile {
  readonly path: string;
  readonly file: FixtureFile;
}

/** Every fixture file `loadFixtures` was asked to load, in the order given. */
export interface FixtureSet {
  readonly files: readonly LoadedFixtureFile[];
}
