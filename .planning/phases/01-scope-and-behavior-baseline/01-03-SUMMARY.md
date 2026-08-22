---
phase: 01-scope-and-behavior-baseline
plan: 03
subsystem: architecture
tags: [agent-runtime, extraction, ownership, openshell, privileged-actions]

requires:
  - phase: 01-scope-and-behavior-baseline
    provides: Reconciled architecture and a fixed pre-acceptance source baseline
provides:
  - Final move, split, keep, or delete disposition for every audited runtime candidate
  - Exact architecture-debt baseline for runtime dispatch, cross-boundary imports, OpenShell calls, and provider facets
  - Closed classification of privileged runtime actions with three bounded compatibility wrappers
affects: [package-foundation, runtime-extraction, architecture-enforcement, contract-freeze]

tech-stack:
  added: []
  patterns:
    - Extraction scope is represented as revision-bound machine-checkable evidence
    - Privileged compatibility debt is named, bounded, and denied extension by default

key-files:
  created:
    - .planning/phases/01-scope-and-behavior-baseline/01-03-SUMMARY.md
  modified:
    - proposals/agent-runtime-packages/RUNTIME-INVENTORY.md
    - proposals/agent-runtime-packages/OPENCLAW-CANDIDATES.tsv
    - proposals/agent-runtime-packages/HERMES-CANDIDATES.tsv
    - proposals/agent-runtime-packages/TERMINAL-CANDIDATES.tsv
    - proposals/agent-runtime-packages/DISPOSITION-LEDGER.md
    - proposals/agent-runtime-packages/ARCHITECTURE-BASELINE.json
    - proposals/agent-runtime-packages/RFC-RECONCILIATION.md
    - .planning/phases/01-scope-and-behavior-baseline/01-03-PLAN.md

key-decisions:
  - "Every current-tree candidate has one final disposition bound to source revision a5486894c45140259d822625e74d1ccdfce807ee."
  - "Only PA-DCODE-04, PA-HERMES-05, and PA-OPENCLAW-06 may remain as descendant-only compatibility wrappers, outside runtime-control and without OpenShell or sandbox-lifecycle authority."

patterns-established:
  - "Architecture exceptions carry an exact path, symbol, owner, phase, validation target, and removal evidence."
  - "Candidate and architecture totals must reconcile mechanically before extraction starts."

requirements-completed: [GOV-02, TEST-01]

duration: 16min
completed: 2026-08-22
---
<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 1 Plan 3: Extraction Inventory and Privileged-Action Baseline Summary

**Revision-bound ledgers classify 692 extraction candidates, five architecture-debt categories,
and every privileged action before package implementation**

## Performance

- **Duration:** 16 minutes
- **Started:** 2026-08-22T12:52:56Z
- **Completed:** 2026-08-22T13:08:56Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments

- Assigned one final disposition to 258 OpenClaw, 334 Hermes, and 100 terminal-runtime candidate
  paths at source revision `a5486894c45140259d822625e74d1ccdfce807ee`.
- Recorded 395 runtime-ID findings, seven core-to-runtime imports, seven package-to-core imports, 266
  direct OpenShell findings, and all 14 `RuntimeProviderBundle` facets with migration evidence.
- Classified 21 privileged actions as six closed primitives, six non-root rewrites, six deletions,
  and exactly three bounded descendant compatibility wrappers.
- Reconciled the human-readable provider-facet dispositions with the machine-readable architecture
  baseline and repaired the executable evidence checks found during independent review.

## Task Commits

The planned proposal outcomes were already present in one signed, consolidated pre-GSD commit. Two
signed corrections make the close-out evidence exact:

1. **Task 1: Assign final dispositions to every candidate** - `4ee0009c5f`
2. **Task 2: Record the architecture and OpenShell boundary baseline** - `4ee0009c5f`, corrected by `e4f6ef0d06`
3. **Task 3: Classify privileged and root-required runtime actions** - `4ee0009c5f`, bounded by `0faf3e2c9e`

**Plan metadata:** this summary commit.

## Files Created or Modified

- `proposals/agent-runtime-packages/RUNTIME-INVENTORY.md` - Audited discovery method, revision,
  additions, removals, and exclusions.
- `proposals/agent-runtime-packages/*-CANDIDATES.tsv` - Final path-level ownership, destination,
  phase, validation, and disposition evidence for the three standard runtime workstreams.
- `proposals/agent-runtime-packages/DISPOSITION-LEDGER.md` - Reconciled totals, boundary rules,
  architecture counts, privileged-action table, and blockers.
- `proposals/agent-runtime-packages/ARCHITECTURE-BASELINE.json` - Machine-readable architecture
  findings and all provider-facet dispositions.
- `proposals/agent-runtime-packages/RFC-RECONCILIATION.md` - Human-readable facet dispositions
  aligned with the machine-readable baseline.
- `.planning/phases/01-scope-and-behavior-baseline/01-03-PLAN.md` - Corrected executable verifier
  and exact compatibility-wrapper boundary.

## Decisions Made

- Keep package extraction path-based only for whole-file ownership. Mixed files require an explicit
  split that names both retained core authority and package-owned responsibilities.
- Treat the three existing process-repair loops as named compatibility debt, not controller
  primitives. They may manage only admitted-process descendants, cannot call OpenShell, cannot own
  sandbox lifecycle, and retain rollback in core and OpenShell.
- Require architecture counts to decrease after implementation; new exceptions need a separately
  reviewed baseline change rather than silently joining the inventory.

## Deviations from Plan

### Auto-fixed Issues

**1. Executable architecture verifier had one unmatched brace**

- **Found during:** Task 2 independent verification.
- **Issue:** The planned command could not parse, so it could not prove the artifact.
- **Fix:** Removed the unmatched brace and reran the semantic verifier.
- **Files modified:** `.planning/phases/01-scope-and-behavior-baseline/01-03-PLAN.md`.
- **Verification:** The exact decoded Task 2 command passed.
- **Committed in:** `e4f6ef0d06`.

**2. Human and machine provider-facet dispositions differed**

- **Found during:** Task 2 cross-artifact review.
- **Issue:** `stateMutation` and `containerEngine` said `Retain` in the RFC table but `converge` in
  the machine-readable baseline.
- **Fix:** Aligned both RFC rows to the baseline without changing their authority or removal rules.
- **Files modified:** `proposals/agent-runtime-packages/RFC-RECONCILIATION.md`.
- **Verification:** All 14 facet rows now reconcile with the JSON baseline.
- **Committed in:** `e4f6ef0d06`.

**3. The plan omitted three intentional compatibility-wrapper classifications**

- **Found during:** Task 3 independent verification.
- **Issue:** The ledger correctly named three current descendant repair loops, but the plan allowed
  only primitives, non-root rewrites, or deletion.
- **Fix:** Allowed only the three exact action IDs and made their authority limits executable.
- **Files modified:** `.planning/phases/01-scope-and-behavior-baseline/01-03-PLAN.md`.
- **Verification:** The Task 3 command proved the exact three IDs, boundary wording, and absence of
  another wrapper.
- **Committed in:** `0faf3e2c9e`.

---

**Total deviations:** 3 auto-fixed evidence defects.
**Impact on plan:** The corrections narrow and reconcile the recorded migration boundary. They do
not add product behavior or authorize package implementation.

## Issues Encountered

The path-resolution verifier performs one Git object lookup for each of 692 rows and took about 88
seconds. It completed successfully without a retry or source change.

## Verification

- All 692 candidate paths resolve at the exact audited source revision.
- Candidate totals reconcile to 359 move, 234 split, 98 keep, and one delete disposition.
- Architecture totals reconcile to 395 runtime-ID findings, seven imports in each direction, 266
  direct OpenShell findings, and 14 provider facets.
- Privileged-action totals reconcile to 21 actions with exactly three permitted wrappers.
- Task 1, Task 2, and Task 3 automated verifiers passed.
- SHA-256 identities remain
  `ff4c0177cbc6fa69d800a39de403925ab28c57b921c3a18ebfa40e515e7dd6fd` for the architecture
  baseline and `30d094b7c8fa47960a494f86e9ef2f6902365f83f665301d79a2ac197a1c59de` for the disposition
  ledger.
- Both correction commits have valid local Git signatures and DCO sign-offs.

## User Setup Required

None.

## Next Phase Readiness

- Ready for Plan 01-04 to finish the decision packet and stop at its repository-owned acceptance
  checkpoint.
- `GOV-02` and `TEST-01` remain globally pending until Phase 1 receives complete maintainer
  acceptance. This summary does not authorize Phase 2 or package implementation.
- Brev and inference credentials are not needed before the later live-qualification phase.

## Self-Check: PASSED

- Every plan artifact exists and every automated verifier passed.
- The candidate ledger, architecture baseline, RFC table, and privileged-action table agree.
- No runtime code, product behavior, remote state, live service, credential, or Brev resource changed.

---
*Phase: 01-scope-and-behavior-baseline*
*Completed: 2026-08-22*
