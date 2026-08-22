---
phase: 01-scope-and-behavior-baseline
plan: 01
subsystem: architecture
tags: [agent-runtime, packages, openshell, rfc]

requires: []
provides:
  - Decision-ready in-tree agent runtime package architecture
  - Reconciled public command, authority, compatibility, and sequencing choices
  - RFC and review-comment disposition tied to implementation gates
affects: [scope-baseline, package-foundation, runtime-extraction, release-qualification]

tech-stack:
  added: []
  patterns:
    - Data-only package descriptors with a fixed in-sandbox helper
    - One core-owned catalogue, release set, and OpenShell client boundary

key-files:
  created:
    - proposals/agent-runtime-packages/RFC-RECONCILIATION.md
  modified:
    - proposals/agent-runtime-packages/README.md
    - proposals/agent-runtime-packages/TECHNICAL-PLAN.md

key-decisions:
  - "Use nemoclaw harness install for one explicit local artifact and keep nemoclaw agents list as a compatibility view."
  - "Qualify self-contained packages under packages/ before any external repository handoff."
  - "Keep product and OpenShell authority outside package-supplied runtime-native reconciliation."

patterns-established:
  - "Support is selected only by the checked-in release set; compatibility or installation does not confer support."
  - "A package helper result is an executor claim until a separate trusted observer supplies evidence."

requirements-completed: [GOV-01, UX-01, UX-02]

duration: 1min
completed: 2026-08-22
---

# Phase 1 Plan 1: Reconciled Architecture Summary

**An in-tree-first agent runtime package design with one public install command, explicit authority boundaries, and a complete RFC disposition**

## Performance

- **Duration:** 1 minute
- **Started:** 2026-08-22T12:40:52Z
- **Completed:** 2026-08-22T12:41:52Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments

- Reconciled the engineering proposal and detailed design around `packages/` and
  `nemoclaw harness install` while preserving the current user journey.
- Bound support decisions to one core-owned release set and kept OpenShell lifecycle, policy,
  credential, inference, and admitted-execution authority outside packages.
- Recorded every RFC and reviewer tension, including the exact OpenShell baseline and
  `RuntimeProviderBundle` dispositions, without treating a proposed design as accepted behavior.

## Task Commits

The task outcomes were already present in one signed, consolidated pre-GSD commit:

1. **Task 1: Reconcile the engineering-lead proposal** — `4ee0009c5f`
2. **Task 2: Reconcile the detailed technical design** — `4ee0009c5f`
3. **Task 3: Produce the RFC and review-comment reconciliation** — `4ee0009c5f`

**Plan metadata:** this summary commit.

## Files Created or Modified

- `proposals/agent-runtime-packages/README.md` — Engineering-lead architecture and delivery summary.
- `proposals/agent-runtime-packages/TECHNICAL-PLAN.md` — Detailed contract, authority, migration, and qualification design.
- `proposals/agent-runtime-packages/RFC-RECONCILIATION.md` — RFC and reviewer disposition with implementation evidence gates.

## Decisions Made

- Use `agent runtime` for the internal package concept and reserve `harness` for the requested CLI namespace.
- Register exact standard packages through one checked-in release set without eagerly pulling every image.
- Keep external transport and repository conversion separate from the qualified in-tree release.

## Deviations from Plan

The production outcomes predated formal GSD execution and therefore share the consolidated
`4ee0009c5f` commit instead of one task commit per outcome. This close-out validates and records the
existing work without rewriting signed history or creating duplicate documentation changes.

## Issues Encountered

None.

## User Setup Required

None.

## Next Phase Readiness

- Ready for Plan 01-02 behavior characterization close-out.
- `GOV-01` remains globally pending at its repository-owned acceptance clause; listing it in this
  plan records the completed pre-acceptance proposal work and does not authorize Phase 2.

## Self-Check: PASSED

- All three required proposal files exist in signed commit `4ee0009c5f`.
- Automated task and plan verification passed.
- Proposal markdown lint passed with zero issues.
- No product implementation or new trust surface was introduced.

---
*Phase: 01-scope-and-behavior-baseline*
*Completed: 2026-08-22*
