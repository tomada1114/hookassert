/**
 * Public entry point.
 *
 * @remarks
 * This module is the entire published contract. Anything not re-exported here
 * — in particular everything under `src/internal/` — is private and may change
 * in a patch release, and `package.json#exports` blocks consumers from reaching
 * it by deep import.
 *
 * Every symbol is exported by name on purpose: no `export *`, no default
 * export. Adding a line here is an API change and needs a release-impact note
 * in the pull request.
 *
 * Today the contract is types only, so the emitted module is empty: what a
 * consumer runs is the `hookassert` command, not an import. The runtime
 * surface, if any, is a decision each later issue makes deliberately rather
 * than one this file arrived at.
 *
 * @packageDocumentation
 */

export type {
  CaseResult,
  Decision,
  EventName,
  ExecOutcome,
  ExpectationDiff,
  NonFiringExplanation,
  PayloadOrigin,
  Provenance,
  RejectedMatch,
  ResolvedHook,
  SettingsLayer,
  Summary,
  UnknownReason,
  VersionSourceName,
} from "./types.js";
