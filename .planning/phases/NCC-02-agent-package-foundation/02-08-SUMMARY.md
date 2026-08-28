---
phase: NCC-02-agent-package-foundation
plan: 08
subsystem: durable-package-identity
tags: [agent-runtime, package-identity, onboarding-session, checkpoint-v5]

# Dependency graph
requires:
  - phase: NCC-02-agent-package-foundation
    provides: Strict receipts and immutable package identity from Plan 02-03
provides:
  - One strict secret-free package identity and migration-provenance vocabulary
  - Session-owned exact package identity with invalid-present-state preservation
  - Checkpoint schema v5 with explicit v4 migration and identity-only authority
affects: [registry-package-authority, package-selection, legacy-reconciliation, resume]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Distinguish absent, valid, and invalid durable package authority
    - Compare every immutable identity field without following an active pointer
    - Keep migration provenance on Session while checkpoints carry exact identity only

key-files:
  created:
    - src/lib/harness/package-identity.ts
    - src/lib/harness/package-identity.test.ts
    - src/lib/state/onboard-session-package.test.ts
  modified:
    - src/lib/state/onboard-session.ts
    - src/lib/state/onboard-checkpoint-types.ts
    - src/lib/state/onboard-checkpoint.ts
    - src/lib/state/onboard-checkpoint-migrate.ts
    - src/lib/onboard/checkpoint-resume-guard.test.ts
    - src/lib/onboard/portable-retirement-authority.ts
    - src/lib/actions/uninstall/portable-runtime-cleanup.test.ts

key-decisions:
  - "Reuse receipt identity semantics and reject persisted aliases."
  - "Migration provenance has exactly four fields and never claims historical bytes."
  - "Legacy absence stays readable; malformed present authority blocks persistence and resume."
  - "V4 migration produces v5 with null package identity and never infers from an agent name."
  - "Portable completed-state readers accept legacy v4 plus the current checkpoint schema."

patterns-established:
  - "Identity equality covers kind, ID, package version, contract version, and content digest."
  - "Session owns identity plus optional migration audit; checkpoint owns exact identity only."
  - "Schema code records immutable values and performs no install, catalogue, or pointer lookup."

requirements-completed: [PKG-03A, COMP-04, COMP-04A, TEST-03]

# Metrics
duration: 1h 12m
completed: 2026-08-28
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 Plan 08: Session Package Identity Summary

Onboarding sessions can now retain exact harness-package authority and strict migration provenance.
Checkpoint schema v5 carries exact identity and migrates active v4 state without inventing it.

## Accomplishments

- Added one closed parser, serializer, guard, and full-field equality rule for agent-runtime identity.
- Added the exact four-field, secret-free legacy migration record with canonical agent/time checks.
- Added Session fields for exact identity and optional migration provenance, including fresh-write
  round trips and invalid-present-state mutation guards.
- Added checkpoint schema v5, exact key validation, Session-to-checkpoint derivation, explicit v4
  migration, and resume-time Session/checkpoint drift refusal.
- Preserved legacy sessions and candidate harnesses as package-absent; no schema path follows an
  active pointer or infers Pi or NemoCUA authority.
- Kept portable completed-onboarding authority compatible with current v5 and legacy v4 state.

## Task and Fix Commits

1. **Task 1: Normalize exact identity and migration provenance** — `ed3819b651`
2. **Task 2: Add the session fresh-write and normalization seam** — `923c9e8a02`
3. **Task 3: Migrate checkpoint schema from version 4 to version 5** — `d1d3452c7e`
4. **Fix: Preserve omitted legacy identity during derivation** — `e9b8f01c17`
5. **Fix: Accept current portable checkpoints** — `b3d2f88c0d`

## Decisions Made

- Exact identity is reused from immutable receipt semantics and rejects aliases before persistence.
- `inspectHarnessPackageState` keeps absence, validity, and malformed presence distinct.
- `harnessPackageMigration` remains Session-only; checkpoint serialization never copies it.
- A migrated v4 checkpoint is active v5 state with null identity, not a historical package claim.
- Resume accepts a package-bearing Session with a migrated null-identity v4 checkpoint, but rejects
  two present identities when any immutable field differs.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Preserve structurally legacy Session derivation**

- **Issue:** A legacy Session can omit `harnessPackage`; strict null handling tried to parse
  `undefined`.
- **Fix:** Treat null and omitted identity as legacy absence and add regression coverage.
- **Committed in:** `e9b8f01c17`

**2. [Rule 1 - Bug] Keep portable authority compatible with checkpoint v5**

- **Issue:** Portable completed-session validation hard-coded v4 and rejected current v5 state.
- **Fix:** Accept legacy v4 or `CHECKPOINT_SCHEMA_VERSION` and exercise the current schema in the
  portable lifecycle suite.
- **Committed in:** `b3d2f88c0d`

**3. [Rule 2 - Missing Critical] Compare Session and checkpoint authority at resume**

- **Issue:** Initial schema coverage did not reject malformed Session package state or two valid but
  different identities at the resume boundary.
- **Fix:** Added invalid-state refusal and full-field Session/checkpoint comparison before resume.
- **Committed in:** `d1d3452c7e`

**4. [Rule 3 - Organization] Isolate package Session persistence coverage**

- **Issue:** Focused round-trip and fail-closed cases did not belong in the broad Session test file.
- **Fix:** Added `onboard-session-package.test.ts` and the exact architecture-budget edge.
- **Committed in:** `923c9e8a02`

---

**Total deviations:** 4 auto-fixed (2 bugs, 1 missing critical, 1 organization change).
**Impact on plan:** No product-scope expansion; all fixes preserve required legacy/resume behavior.

## Verification

- Package identity tests — 32 passed.
- Session persistence/normalization tests — 94 passed.
- Checkpoint, resume-guard, and uninstall compatibility tests — 135 passed.
- Legacy rebuild recovery plus checkpoint derivation — 50 passed.
- Current portable/session/checkpoint regression set — 119 passed.
- `npm run typecheck:cli` — passed.
- `npm run checks:repository` — passed.
- Growth, source-shape, Oxlint, Oxfmt, and `git diff --check` — passed.
- Normal pre-commit and commit-message hooks — passed for all five commits.
- The default broad fast runner exceeded this Mac's process concurrency limits; final Phase 2
  qualification reruns deterministic projects with bounded scheduling in Plan 02-23.

## Next Phase Readiness

Plan 02-09 can add the same identity/provenance vocabulary to registry and policy state. Later plans
can bind, migrate, and resume exact package owners without inventing schema authority.

## Self-Check: PASSED

---

*Phase: NCC-02-agent-package-foundation*
*Completed: 2026-08-28*
