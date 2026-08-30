/**
 * Internal plumbing types for the settings loader.
 *
 * @remarks
 * `SettingsSource` and `ResolvedSettings` are not part of the published
 * contract: `src/index.ts` re-exports only `src/types.ts`'s vocabulary, and
 * ESLint's `public-api/internal-stays-private` block forbids `src/index.ts`
 * from importing anything under `src/internal/` at all, so nothing declared
 * here can leak into the public surface by accident. They live next to the
 * modules that use them rather than in `src/types.ts`, which is reserved for
 * the vocabulary every module speaks — this one is spoken only by
 * `src/internal/settings/**`.
 */

import type { ResolvedHook, SettingsLayer } from "../../types.js";

/**
 * One settings file to read, and which merged layer it belongs to.
 *
 * @remarks
 * `discover.ts` builds these for the three well-known layers plus any
 * repeatable `--settings <file>` argument; `load.ts` and `merge.ts` never
 * construct one themselves.
 */
export interface SettingsSource {
  /** Absolute path of the settings file. */
  readonly path: string;

  /** Which merged layer this file belongs to. */
  readonly layer: SettingsLayer;
}

/**
 * Every hook resolved from the settings layers, already merged and deduped.
 *
 * @remarks
 * `hooksForEvent` is the only sanctioned way to read `hooks` back out; keeping
 * the field here (rather than exposing `ResolvedSettings` as a bare array)
 * leaves room for the loader to attach source-level metadata later without
 * breaking every caller.
 */
export interface ResolvedSettings {
  /** Every resolved hook, concatenated across layers in `hooksForEvent`'s
   * documented order and deduped by {@link ResolvedHook.dedupeKey}. */
  readonly hooks: readonly ResolvedHook[];
}

/**
 * A hook declaration read from exactly one settings source, before the merge
 * across sources computes its {@link ResolvedHook.dedupeKey}.
 */
export type RawHook = Omit<ResolvedHook, "dedupeKey">;

/** One source's raw hooks, paired with the source they came from. */
export interface SourceHooks {
  readonly source: SettingsSource;
  readonly hooks: readonly RawHook[];
}
