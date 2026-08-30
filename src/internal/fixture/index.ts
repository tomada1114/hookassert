/**
 * The fixture loader's own internal surface.
 *
 * @remarks
 * `src/cli.ts` (a later issue) is the composition root that will import from
 * here; nothing here is re-exported from `src/index.ts` — see
 * `types.ts`'s doc comment for why that boundary is enforced mechanically,
 * not just by convention.
 */

export { isValidRawFixtureFile, validateFixture } from "./guards.js";
export { loadFixture, loadFixtureFile, loadFixtures } from "./load.js";
export type {
  FixtureCase,
  FixtureDecision,
  FixtureDefaults,
  FixtureExpectation,
  FixtureFile,
  FixtureSet,
  FixtureStubEntry,
  LoadedFixtureFile,
  RawFixtureCase,
  RawFixtureExpectation,
  RawFixtureFile,
  RawFixtureOrigin,
} from "./types.js";
