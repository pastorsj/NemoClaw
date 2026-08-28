---
phase: NCC-02-agent-package-foundation
plan: 16
subsystem: onboarding-package-authority
tags: [onboard, harness, package, checkpoint, recreate, rebuild]
requires: [02-15]
provides:
  - Exact package authority in checkpoint v5 and recreate transaction v2
  - Package-bound recreate journals and destructive rebuild fences
  - Explicit legacy transaction migration without active-pointer fallback
affects: [02-17, 02-18, 02-19, 02-20, 02-21, 02-22, 02-23]
requirements-completed: [PKG-03A, COMP-03, COMP-04, COMP-04A, TEST-03]
completed: 2026-08-28
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 Plan 16: Recreate and Checkpoint Package Authority Summary

Checkpoint recording, replay, recreate journals, and rebuild handoffs now retain the owning
Session's exact harness package identity through every independently resumable mutation.

## Accomplishments

- Made checkpoint v5 writes carry explicit nullable package authority while preserving readable
  existing v5 records that omitted the field and explicit v4 migration.
- Added recreate transaction v2 with exact nullable package identity; active v1 transactions
  migrate without changing their IDs, phases, revisions, timestamps, generations, or legacy
  fingerprints.
- Bound checkpoint recording, replay, handler recreation, and outer rebuild journals to the same
  Session, checkpoint, transaction, registry, and immutable package object.
- Re-read authority immediately before journal publication, deletion, delete confirmation,
  completion, and rollback boundaries.
- Kept qualified candidate state explicitly package-null and preserved OpenClaw's separate null
  compatibility agent sentinel.
- Reworked rebuild fixtures to install real reviewed package bytes under isolated test homes and to
  keep restart simulations on one stable content digest.

## Task Commit

1. **Bind checkpoint and recreate package authority** — `f3055fb98c`

## Verification

- 42 changed CLI test files passed 812 tests; MCP destroy lifecycle passed 47 integration tests.
- Restart, portable reentry, DCode drift, snapshot, shields, and staging coverage passed 68 tests.
- Additional rebuild lifecycle, credential, recovery, DCode, and Hermes coverage passed 116 tests;
  package authority, ordering, and resume coverage passed 41 tests.
- Handler refactoring passed 52 focused tests and the cognitive-complexity hook.
- CLI build and typecheck, 32 growth guardrails, repository checks, exact Vitest project
  membership, formatting, secret scan, normal commit hooks, and diff checks passed.
- Default parallel aggregate attempts saturated this Mac and triggered unrelated subprocess
  deadlines. The affected files pass without cross-file contention; the final serialized aggregate
  and live no-messaging qualification remain assigned to Plan 02-23.

## User Setup Required

None.

## Next Phase Readiness

Plan 02-17 can require the same authority chain at final registry publication and preserve it in
independent recovery-only cancellation records.

## Self-Check: PASSED
