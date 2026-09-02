/**
 * The type vocabulary every other hookassert module speaks.
 *
 * @remarks
 * This module holds declarations only — no implementation — so that
 * `src/index.ts` can publish the vocabulary without publishing any of the
 * machinery behind it. Anything with a runtime body belongs in a module of its
 * own.
 *
 * @packageDocumentation
 */

/**
 * Name of a Claude Code hook event.
 *
 * @remarks
 * The complete set of officially documented event names, transcribed from the
 * Claude Code hooks documentation into `spec/claude-code-2.1.251-2.2.0.json`.
 * This union has to match that spec's `events` keys exactly; extend both
 * together when a later spec range adds or removes an event.
 *
 * @public
 */
export type EventName =
  | "SessionStart"
  | "Setup"
  | "InstructionsLoaded"
  | "UserPromptSubmit"
  | "UserPromptExpansion"
  | "MessageDisplay"
  | "PreToolUse"
  | "PermissionRequest"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PostToolBatch"
  | "PermissionDenied"
  | "Notification"
  | "SubagentStart"
  | "SubagentStop"
  | "TaskCreated"
  | "TaskCompleted"
  | "Stop"
  | "StopFailure"
  | "TeammateIdle"
  | "ConfigChange"
  | "CwdChanged"
  | "DirectoryAdded"
  | "FileChanged"
  | "WorktreeCreate"
  | "WorktreeRemove"
  | "PreCompact"
  | "PostCompact"
  | "PreModelSwitch"
  | "PostModelSwitch"
  | "SessionEnd"
  | "Elicitation"
  | "ElicitationResult";

/**
 * Which settings file a hook declaration came from.
 *
 * @remarks
 * `user`, `project`, and `local` are the three layers Claude Code merges, in
 * that order. `explicit` is a settings file named on the command line, which
 * takes part in the same merge but belongs to none of the three.
 *
 * @public
 */
export type SettingsLayer = "user" | "project" | "local" | "explicit";

/**
 * Where a hook declaration was read from.
 *
 * @remarks
 * Every field is required. A hook that cannot say which line of which file
 * declared it cannot be reported against that line, and pointing at the
 * offending line is the whole product of `explain` and of the GitHub Actions
 * reporter.
 *
 * @public
 */
export interface Provenance {
  /** Absolute path of the settings file the declaration was read from. */
  readonly file: string;

  /** Which merged layer {@link Provenance.file} belongs to. */
  readonly layer: SettingsLayer;

  /** 1-based line of the declaration within {@link Provenance.file}. */
  readonly line: number;

  /** 1-based column of the declaration within {@link Provenance.file}. */
  readonly col: number;

  /** Offset of the declaration into the settings file's source text. */
  readonly offset: number;
}

/**
 * One hook declaration, after the settings layers have been merged.
 *
 * @remarks
 * A field that can be absent is typed `T | undefined` rather than declared with
 * `?:`. Under `exactOptionalPropertyTypes` those are distinct types, and only
 * the explicit union lets a reader tell "this hook declares no matcher" from
 * "this record forgot to say" — the second is a bug in the loader, and it
 * should not typecheck.
 *
 * @public
 */
export interface ResolvedHook {
  /** Event the hook is declared under. */
  readonly event: EventName;

  /** Matcher as written, or `undefined` when the declaration carries none. */
  readonly matcher: string | undefined;

  /** Command the hook runs. */
  readonly command: string;

  /**
   * Arguments passed to {@link ResolvedHook.command}, or `undefined` when the
   * declaration passes none.
   */
  readonly args: readonly string[] | undefined;

  /**
   * Per-hook deadline in milliseconds, or `undefined` to use Claude Code's own
   * default rather than an override.
   */
  readonly timeoutMs: number | undefined;

  /** Where the declaration was read from. */
  readonly provenance: Provenance;

  /**
   * Key the concatenating merge deduplicates identical declarations on.
   *
   * @remarks
   * Opaque to a consumer: it is derived from the declaration, but which parts
   * of it and in what form is the merge's business. `explain` displays it
   * verbatim so two hooks that collapsed into one can be told apart from two
   * that did not.
   */
  readonly dedupeKey: string;
}

/**
 * A hook's raw exit code, stdout, stderr, and whether it timed out.
 *
 * @remarks
 * The input the static decision resolver (`src/internal/decision/`) and the
 * future executor's `Spawner` seam both speak: whatever actually spawns a
 * hook produces one of these, and the decision resolver consumes it without
 * ever spawning anything itself.
 *
 * @public
 */
export interface ExecOutcome {
  /** The process's exit status. */
  readonly exitCode: number;

  /** Everything the hook wrote to stdout. */
  readonly stdout: string;

  /** Everything the hook wrote to stderr. */
  readonly stderr: string;

  /** Whether the hook was killed for exceeding its deadline. */
  readonly timedOut: boolean;
}

/**
 * Where a fixture case's input payload came from.
 *
 * @remarks
 * `"synthetic"` is what an omitted `origin` in a fixture YAML resolves to — a
 * payload the fixture author wrote by hand. `"recorded"` is a payload
 * captured from a real Claude Code session and replayed by pointing at the
 * envelope file the `record` capture pipeline produced;
 * `src/internal/fixture/load.ts` reads `capturedAt` and `claudeVersion` back
 * out of that envelope so a later confidence display can say how old, and
 * against which Claude Code version, the captured payload is.
 *
 * @public
 */
export type PayloadOrigin =
  | {
      /** The payload was captured from a real Claude Code session. */
      readonly kind: "recorded";
      /** When the payload was captured, as recorded in the envelope file. */
      readonly capturedAt: string;
      /** Absolute path of the envelope file `origin.recorded` pointed at. */
      readonly sourceFile: string;
      /** The Claude Code version active when the payload was captured, if the envelope recorded one. */
      readonly claudeVersion: string | undefined;
    }
  | {
      /** The payload was written by hand rather than captured. */
      readonly kind: "synthetic";
    };

/**
 * Which mechanism a version probe tried, and failed, to read Claude Code's
 * own version from.
 *
 * @remarks
 * Named here only because {@link UnknownReason}'s `"version-undetermined"`
 * member needs a closed vocabulary for `triedSources` — nothing in
 * `src/internal/decision/` actually produces that reason today. Probing
 * Claude Code's version at runtime is a later executor issue's job; this is
 * the vocabulary that probe reports against, extended there if it needs a
 * source this issue did not anticipate.
 *
 * @public
 */
export type VersionSourceName =
  "cli-flag" | "environment-variable" | "package-manifest";

/**
 * A reason the decision resolver could not assert a {@link Decision} with
 * confidence.
 *
 * @public
 */
export type UnknownReason =
  | {
      /** The detected Claude Code version falls outside the loaded spec's `claudeCodeRange`, so its documented behavior cannot be trusted for this run. */
      readonly kind: "version-out-of-spec-range";
      /** The Claude Code version that was actually detected. */
      readonly detected: string;
      /** The loaded spec's own `claudeCodeRange`, which `detected` falls outside of. */
      readonly specRange: string;
    }
  | {
      /** No probe could determine which Claude Code version is running at all. */
      readonly kind: "version-undetermined";
      /** Every {@link VersionSourceName} a probe tried before giving up. */
      readonly triedSources: readonly VersionSourceName[];
    }
  | {
      /**
       * The event's JSON payload shape has never been confirmed against a
       * live Claude Code instance (`spec.events[event].payloadShape.verified
       * === false`), so a payload-shaped assertion about it cannot be
       * trusted.
       */
      readonly kind: "payload-shape-unverified";
      /** The event whose payload shape is unverified. */
      readonly event: EventName;
      /** The loaded spec's own `specVersion`. */
      readonly specVersion: string;
    }
  | {
      /** One or more plugin-declared hook files exist that hookassert has not read, so the effective hook set is incomplete. */
      readonly kind: "plugin-hooks-present";
      /** Absolute paths of the unread plugin hook files. */
      readonly files: readonly string[];
    }
  | {
      /** A managed settings file was treated as present without being able to confirm it, because reading it is outside hookassert's reach. */
      readonly kind: "managed-settings-assumed";
      /** Absolute path of the assumed managed settings file. */
      readonly path: string;
    }
  | {
      /** `event` has no entry in the loaded spec's `events` map, so nothing about its documented behavior can be read — a hookassert build whose `EventName` union has drifted ahead of the spec file it loaded. */
      readonly kind: "event-not-in-spec";
      /** The event with no corresponding entry in the loaded spec. */
      readonly event: EventName;
      /** The loaded spec's own `specVersion`. */
      readonly specVersion: string;
    }
  | {
      /** The loaded spec documents a `block` effect for `exitCode` on `event` while also declaring `event` not `blockable` — the spec entry contradicts itself, so the hook's own output cannot be blamed for it. */
      readonly kind: "contradictory-exit-code-effect";
      /** The event whose spec entry contradicts itself. */
      readonly event: EventName;
      /** The exit code whose documented `block` effect the event's own `blockable: false` contradicts. */
      readonly exitCode: number;
    };

/**
 * The closed vocabulary a hook's raw exit code and stdout resolve to.
 *
 * @remarks
 * Constructed only through `src/internal/decision/factory.ts`'s functions —
 * see that module's own doc comment — never by writing one of these object
 * shapes out at a call site.
 *
 * @public
 */
export type Decision =
  | {
      /**
       * The action is blocked, either because the hook exited with the
       * event's documented block-effect exit code (`source: "exit-code"`) or
       * because its stdout JSON carried a recognized deny-shaped decision
       * value on that event's own `jsonDecisions` (`source:
       * "permission-decision"`).
       */
      readonly kind: "deny";
      /** Which channel produced the deny. */
      readonly source: "exit-code" | "permission-decision";
      /** The hook's raw exit code. */
      readonly exitCode: number;
    }
  | {
      /** Stdout JSON explicitly granted the action. */
      readonly kind: "allow";
      /** The hook's raw exit code. */
      readonly exitCode: number;
    }
  | {
      /**
       * No decision is present; the normal permission flow proceeds
       * unchanged. This is the required outcome for a hook that exits a
       * non-blocking code while intending to act as a policy check: exiting
       * `1` to "block" is a no-op, not a deny, and `"pass"` is what carries
       * that fact forward truthfully rather than mislabeling it a failed
       * block.
       */
      readonly kind: "pass";
      /** The hook's raw exit code. */
      readonly exitCode: number;
    }
  | {
      /** The outcome could not be turned into a decision at all. */
      readonly kind: "error";
      /** The hook's raw exit code. */
      readonly exitCode: number;
      /**
       * `"nonzero-exit-without-json"` — a non-zero, non-documented exit with
       * no recognizable JSON on stdout.
       * `"invalid-json"` — stdout looked like JSON and failed to parse.
       * `"schema-violation"` — stdout parsed but its decision value is not
       * one the event documents.
       */
      readonly cause: "nonzero-exit-without-json" | "invalid-json" | "schema-violation";
    }
  | {
      /**
       * Nothing above can be asserted; `reasons` is a non-empty tuple, so an
       * `unknown` without at least one {@link UnknownReason} cannot be
       * constructed, at the type level, by any call site.
       */
      readonly kind: "unknown";
      /** Every reason nothing more specific could be asserted. */
      readonly reasons: readonly [UnknownReason, ...UnknownReason[]];
    };

/**
 * A structured comparison between one field of a fixture case's declared
 * `expect` and what was actually observed, produced by `assertCase`
 * (`src/internal/assert/`).
 *
 * @remarks
 * Each member carries the expected and actual value for exactly one field of
 * a fixture case's `expect`, in enough structured detail for a reporter to
 * render text like "expected deny / actual pass — the hook fired but exited
 * 0" without this type ever holding a pre-rendered string itself — rendering
 * that text is a reporter's job (`src/internal/report/`), not this type's.
 *
 * @public
 */
export type ExpectationDiff =
  | {
      /** Whether any hook fired at all disagreed with `expect.fires`. */
      readonly field: "fires";
      /** The fixture's declared `expect.fires`. */
      readonly expectedFires: boolean;
      /** Whether a hook actually fired. */
      readonly actualFires: boolean;
    }
  | {
      /** The resolved `Decision.kind` disagreed with `expect.decision`. */
      readonly field: "decision";
      /** The fixture's declared `expect.decision`. */
      readonly expectedDecision: Decision["kind"];
      /** The actually resolved `Decision.kind`. */
      readonly actualDecision: Decision["kind"];
    }
  | {
      /** The resolved `Decision`'s exit code disagreed with `expect.exitCode`. */
      readonly field: "exitCode";
      /** The fixture's declared `expect.exitCode`. */
      readonly expectedExitCode: number;
      /** The actually resolved `Decision`'s exit code. */
      readonly actualExitCode: number;
    }
  | {
      /** The hook's stdout did not contain `expect.stdoutContains`. */
      readonly field: "stdoutContains";
      /** The fixture's declared `expect.stdoutContains`. */
      readonly expectedSubstring: string;
      /** The hook's actual stdout. */
      readonly actualStdout: string;
    }
  | {
      /** The hook's stderr did not contain `expect.stderrContains`. */
      readonly field: "stderrContains";
      /** The fixture's declared `expect.stderrContains`. */
      readonly expectedSubstring: string;
      /** The hook's actual stderr. */
      readonly actualStderr: string;
    }
  | {
      /** Whether the hook timed out disagreed with `expect.timedOut`. */
      readonly field: "timedOut";
      /** The fixture's declared `expect.timedOut`. */
      readonly expectedTimedOut: boolean;
      /** Whether the hook actually timed out. */
      readonly actualTimedOut: boolean;
    };

/**
 * One hook that was a matcher candidate for a case's event but did not fire,
 * paired with the reason the matcher engine rejected it.
 *
 * @public
 */
export interface RejectedMatch {
  /** The hook that did not fire. */
  readonly hook: ResolvedHook;
  /** Why the matcher engine did not fire it. */
  readonly reason: string;
}

/**
 * Why a fixture case's `expect.fires: true` was not met.
 *
 * @remarks
 * `"matcher-did-not-match"` — at least one candidate hook was declared under
 * the case's event, but every one of them was rejected by the matcher.
 * `"no-hook-configured"` — no hook at all is declared under the case's
 * event, in any settings layer the fixture loaded.
 * `"excluded-settings-layer"` — a hook that would otherwise be a candidate
 * exists, but only in a settings layer the fixture's `settings:` list did
 * not include.
 *
 * These three are kept distinct rather than collapsed into one generic "did
 * not fire" message, so a reporter can point at the actual cause: a matcher
 * to fix, a hook to add, or a fixture's `settings:` list to extend.
 *
 * @public
 */
export type NonFiringExplanation =
  | {
      /** At least one candidate hook was declared under the event, but every one of them was rejected by the matcher. */
      readonly kind: "matcher-did-not-match";
      /** Every candidate hook the matcher rejected, and why. */
      readonly hooks: readonly RejectedMatch[];
    }
  | {
      /** No hook at all is declared under the case's event, in any settings layer the fixture loaded. */
      readonly kind: "no-hook-configured";
      /** The event with no hook declared under it at all. */
      readonly event: EventName;
    }
  | {
      /** A hook that would otherwise be a candidate exists only in a settings layer the fixture's `settings:` list did not include. */
      readonly kind: "excluded-settings-layer";
      /** Hooks that would be candidates, declared in an excluded settings layer. */
      readonly hooks: readonly ResolvedHook[];
    };

/**
 * The hook whose `Decision` a case's combined verdict came from, and that
 * `Decision` itself.
 *
 * @remarks
 * When more than one hook fires for a case — the ordinary product of the
 * three-layer settings merge — `assertCase` folds every firing hook's
 * `Decision` into one verdict by precedence (`deny` > `unknown` > `error` >
 * `allow` > `pass`, see `combineDecisions` in
 * `src/internal/decision/combine.ts`) and names the hook that produced the
 * winning one here, so a report can point at it rather than leaving a
 * multi-hook case's verdict unattributed.
 *
 * @public
 */
export interface DecidingHook {
  /** The hook whose `Decision` won the fold. */
  readonly hook: ResolvedHook;
  /** The case's combined `Decision` — this hook's own, since it is the one that decided. */
  readonly decision: Decision;
}

/**
 * The comparison between one fixture case's declared `expect` and what
 * actually happened, produced by `assertCase` (`src/internal/assert/`).
 *
 * @remarks
 * `unknown`'s `reasons` is a non-empty tuple for the same reason
 * `Decision.unknown.reasons` is: an `unknown` `CaseResult` without at least
 * one {@link UnknownReason} cannot be constructed, at the type level, by any
 * call site.
 *
 * @public
 */
export type CaseResult =
  | {
      /** Every declared expectation was met. */
      readonly kind: "pass";
      /** Where the case's input payload came from. */
      readonly origin: PayloadOrigin;
      /** The hook whose `Decision` this case's verdict came from; `undefined` when no hook fired at all. */
      readonly decidedBy: DecidingHook | undefined;
    }
  | {
      /** At least one declared expectation was not met. */
      readonly kind: "fail";
      /** Where the case's input payload came from. */
      readonly origin: PayloadOrigin;
      /**
       * Every expectation field that disagreed with what was observed.
       * Non-empty whenever `nonFiring` (on this same result) is `undefined`.
       */
      readonly diffs: readonly ExpectationDiff[];
      /**
       * Set when the failure is that `expect.fires: true` was declared but
       * no hook fired; `undefined` when the failure is instead a `diffs`
       * mismatch (on this same result) on a hook that did fire.
       */
      readonly nonFiring: NonFiringExplanation | undefined;
      /** The hook whose `Decision` this case's verdict came from; `undefined` when no hook fired at all. */
      readonly decidedBy: DecidingHook | undefined;
    }
  | {
      /**
       * The resolved `Decision` could not be asserted with confidence;
       * `reasons` is a non-empty tuple, so an `unknown` without at least one
       * {@link UnknownReason} cannot be constructed, at the type level, by
       * any call site.
       */
      readonly kind: "unknown";
      /** Where the case's input payload came from. */
      readonly origin: PayloadOrigin;
      /** Every reason nothing more specific could be asserted. */
      readonly reasons: readonly [UnknownReason, ...UnknownReason[]];
      /** The hook whose `Decision` this case's verdict came from; `undefined` when no hook fired at all. */
      readonly decidedBy: DecidingHook | undefined;
    }
  | {
      /** The case declared nothing to compare, so it was skipped rather than asserted or left `unknown`. */
      readonly kind: "skipped";
      /** Where the case's input payload came from. */
      readonly origin: PayloadOrigin;
      /**
       * `"dry-run"` — the case declared `dryRun: true`, so nothing was run.
       * `"stub-only"` — the case declares only stubs and no expectation at
       * all, so there is nothing to compare.
       */
      readonly reason: "dry-run" | "stub-only";
    };

/**
 * The fold of every `CaseResult` from one or more fixture files into the
 * counts every reporter prints, produced by `summarize`
 * (`src/internal/assert/`).
 *
 * @remarks
 * Every reporter (`pretty`, and the future `json`/`github`) renders this
 * shape as-is; none of them re-derives or re-counts anything on its own —
 * this is what keeps a summary line like "asserted N cases (M from recorded
 * payloads), K unknown" honest: it interpolates {@link Summary.asserted},
 * {@link Summary.fromRecorded} and {@link Summary.unknown} directly, rather
 * than a value any reporter computed independently.
 *
 * `asserted` and `fromRecorded` count only `"pass"` and `"fail"` results —
 * a `"unknown"` or `"skipped"` `CaseResult` never contributes to either.
 *
 * @public
 */
export interface Summary {
  /** Count of `"pass"` plus `"fail"` results. */
  readonly asserted: number;
  /** Subset of {@link Summary.asserted} whose origin is `"recorded"`. */
  readonly fromRecorded: number;
  /** Count of `"fail"` results — a subset of {@link Summary.asserted}. */
  readonly failed: number;
  /** Count of `"unknown"` results. */
  readonly unknown: number;
  /** Count of `"skipped"` results. */
  readonly skipped: number;
}
