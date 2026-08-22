---
phase: 01-scope-and-behavior-baseline
plan: 02
subsystem: testing
tags: [agent-runtime, onboarding, compatibility, persisted-state]

requires:
  - phase: 01-scope-and-behavior-baseline
    provides: Reconciled architecture and an explicit pre-acceptance characterization boundary
provides:
  - Executable baseline for the three standard onboarding choices and OpenClaw default
  - Compatibility coverage for flags, environment input, list commands, and launchers
  - Before-state fixtures for legacy and explicit persisted agent runtime identities
affects: [explicit-runtime-identity, package-foundation, runtime-extraction]

tech-stack:
  added: []
  patterns:
    - Behavior tests use injected dependencies instead of terminal rendering details
    - Persisted-state fixtures name legacy migration inputs explicitly

key-files:
  created:
    - .planning/phases/01-scope-and-behavior-baseline/01-02-SUMMARY.md
  modified:
    - src/lib/onboard/agent-selection.test.ts
    - src/lib/onboard/agent-resume-state.test.ts
    - src/lib/state/onboard-session-normalization.test.ts
    - src/lib/state/registry-normalization.test.ts

key-decisions:
  - "Preserve null as the characterized OpenClaw write form until Phase 2 changes the durable identity contract."
  - "Reuse existing command and launcher tests instead of duplicating their assertions in the focused selection suite."

patterns-established:
  - "Characterization tests assert selection outcomes and durable values, not terminal formatting."
  - "Legacy absent, null, malformed, unknown, and canonical identities remain distinct fixtures."

requirements-completed: [UX-01, UX-02, TEST-01]

duration: 7min
completed: 2026-08-22
---

# Phase 1 Plan 2: Compatibility and Persisted-State Baseline Summary

**Behavior tests protect the three standard onboarding choices, compatibility commands, and persisted agent runtime identity before migration**

## Performance

- **Duration:** 7 minutes
- **Started:** 2026-08-22T12:43:59Z
- **Completed:** 2026-08-22T12:50:49Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Protected the exact OpenClaw, Hermes, and LangChain Deep Agents Code menu order, labels,
  descriptions, default, interactive selection, and non-interactive result.
- Confirmed existing flag, environment, list-command, compatibility-launcher, and compiled command
  registration tests without adding duplicate assertions.
- Recorded absent, null, explicit, unknown, and malformed persisted identities, resume writes,
  interrupted steps, and unrelated registry-field preservation.
- Kept messaging evidence deterministic and credential-free. Existing session tests continue to own
  messaging-plan persistence and validation.

## Task Commits

The task outcomes were already present in one signed, consolidated pre-GSD commit:

1. **Task 1: Characterize the missing menu behavior** - `060e71e092`
2. **Task 2: Characterize persisted identity and resume state** - `060e71e092`

**Plan metadata:** this summary commit.

## Files Created or Modified

- `src/lib/onboard/agent-selection.test.ts` - Standard menu, default, Deep Agents Code, and
  non-interactive selection baseline.
- `src/lib/onboard/agent-resume-state.test.ts` - Legacy normalization, durable writes, and
  completed or interrupted step reset baseline.
- `src/lib/state/onboard-session-normalization.test.ts` - Session identity and step-state
  normalization baseline.
- `src/lib/state/registry-normalization.test.ts` - Registry identity and unrelated-field
  preservation baseline.

## Decisions Made

- Preserve the current `null` OpenClaw write form as characterization evidence. Phase 2 owns its
  intentional replacement with an explicit identity.
- Use existing tests for `--agent`, `NEMOCLAW_AGENT`, `nemoclaw agents list`, `nemohermes`,
  `nemo-deepagents`, and command registration.

## Deviations from Plan

The production outcomes predated formal GSD execution and therefore share the consolidated
`060e71e092` commit instead of one commit for each task. This close-out validates and records the
existing signed tests without rewriting correct coverage or signed history.

## Issues Encountered

The first integration verification ran beside the package-contract verification. One
`nemo-deepagents --version` child exceeded its 10-second timeout under that contention. The isolated
file passed 11 tests, and the exact three-file integration command then passed 60 tests in 34.89
seconds. No source change was required.

## Verification

- Task 1 focused CLI command: 4 files and 109 tests passed in 6.61 seconds.
- Task 2 focused CLI command: 3 files and 65 tests passed in 4.48 seconds.
- Compatibility integration command: 3 files and 60 tests passed in 34.89 seconds.
- Compiled command registry: 1 file and 832 tests passed.
- Test title style check passed.
- All task acceptance checks passed for defaults, labels, interaction modes, identity fixtures,
  step state, unrelated fields, and credential-free test data.

## User Setup Required

None.

## Next Phase Readiness

- Ready for Plan 01-03 extraction-disposition close-out.
- `UX-01`, `UX-02`, and `TEST-01` remain globally pending until Phase 1 records the accepted design
  decision and completes all phase evidence. This summary does not authorize Phase 2.

## Self-Check: PASSED

- All four characterized test files exist in signed commit `060e71e092`.
- Every task and plan verification command passed.
- The compatibility tests cover every UX-01 and UX-02 surface named by this plan.
- No product behavior, live service, credential value, or new trust surface was introduced.

---
*Phase: 01-scope-and-behavior-baseline*
*Completed: 2026-08-22*
