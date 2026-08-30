/**
 * The `json` reporter: a fixed, versioned rendering of an `ExplainReport`,
 * checked against `schema/report.schema.json`.
 *
 * @remarks
 * Static layer: pure — no I/O, no process, no write. `schema/report.schema.json`
 * is a shipped public contract from the moment it ships: a later change to
 * this module's output shape needs the same `release-impact` review a
 * `src/index.ts` change would, because downstream CI tooling may parse this
 * JSON directly.
 */

import type { EventName, Provenance, ResolvedHook } from "../../types.js";
import type { MatcherKind } from "../matcher/index.js";
import type { ExplainReport } from "./summary.js";

/** JSON shape of a {@link Provenance}, mirroring `schema/report.schema.json`'s `$defs.provenance`. */
interface JsonProvenance {
  readonly file: string;
  readonly layer: string;
  readonly line: number;
  readonly col: number;
  readonly offset: number;
}

/** JSON shape of a {@link ResolvedHook}, without the `matcherIgnored` field only a firing hook carries. */
interface JsonHook {
  readonly event: EventName;
  readonly matcher: string | null;
  readonly command: string;
  readonly args: readonly string[] | null;
  readonly timeoutMs: number | null;
  readonly dedupeKey: string;
  readonly provenance: JsonProvenance;
}

/** A firing hook, plus whether its declared matcher was ignored rather than evaluated. */
interface JsonFiringHook extends JsonHook {
  readonly matcherIgnored: boolean;
}

/** One hook that did not fire, and why. */
interface JsonRejectedOutcome {
  readonly hook: JsonHook;
  readonly kind: MatcherKind;
  readonly reason: string;
}

/**
 * The shape `renderJson` emits, validated by `schema/report.schema.json`.
 *
 * @remarks
 * `reportVersion` is this contract's own version, independent of the
 * package's own semver — a later issue reshaping this output bumps
 * `reportVersion` and updates the schema in the same change, per
 * `release-impact`.
 */
export interface JsonExplainReport {
  readonly reportVersion: "1";
  readonly header: {
    readonly claudeVersion: string;
    readonly specRange: string;
    readonly notices: readonly string[];
  };
  readonly event: EventName;
  readonly target: string | null;
  readonly firing: readonly JsonFiringHook[];
  readonly rejected: readonly JsonRejectedOutcome[];
}

function toJsonProvenance(provenance: Provenance): JsonProvenance {
  return {
    file: provenance.file,
    layer: provenance.layer,
    line: provenance.line,
    col: provenance.col,
    offset: provenance.offset,
  };
}

function toJsonHook(hook: ResolvedHook): JsonHook {
  return {
    event: hook.event,
    matcher: hook.matcher ?? null,
    command: hook.command,
    args: hook.args ?? null,
    timeoutMs: hook.timeoutMs ?? null,
    dedupeKey: hook.dedupeKey,
    provenance: toJsonProvenance(hook.provenance),
  };
}

/** Build the JSON-serializable shape `renderJson` stringifies. */
export function toJsonReport(report: ExplainReport): JsonExplainReport {
  const ignored = new Set(report.matcherIgnored);
  return {
    reportVersion: "1",
    header: {
      claudeVersion: report.header.claudeVersion,
      specRange: report.header.specRange,
      notices: report.header.notices,
    },
    event: report.event,
    target: report.target ?? null,
    firing: report.firing.map((hook) => ({
      ...toJsonHook(hook),
      matcherIgnored: ignored.has(hook),
    })),
    rejected: report.rejected.map((outcome) => ({
      hook: toJsonHook(outcome.hook),
      kind: outcome.kind,
      reason: outcome.reason,
    })),
  };
}

/**
 * Render an {@link ExplainReport} as JSON matching `schema/report.schema.json`.
 *
 * @remarks
 * The header's `claudeVersion`, `specRange`, and `notices` are carried as
 * data fields rather than embedded prose — the same facts `renderPretty`
 * prints as text, here structured for a machine reader.
 */
export function renderJson(report: ExplainReport): string {
  return `${JSON.stringify(toJsonReport(report), null, 2)}\n`;
}
