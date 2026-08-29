---
phase: NCC-02-agent-package-foundation
plan: 19
subsystem: snapshot-package-authority
tags: [snapshot, backup, restore, recovery, harness-package]
requires: [02-18]
provides:
  - Exact package identity in every new rebuild manifest
  - Pinned package definitions for backup, restore, and clone
  - Mutation-edge package, provider, content, and registry validation
affects: [02-20, 02-21, 02-23]
requirements-completed: [UX-01, AGENT-04, PKG-03A, COMP-04, COMP-04A, TEST-03]
completed: 2026-08-29
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 Plan 19: Snapshot and Manifest Authority Summary

Backup, restore, clone, and recovery now interpret sandbox state through the exact harness package
recorded for that sandbox. New rebuild manifests carry complete package and content evidence, and
destructive operations revalidate that authority at their mutation boundary.

## Accomplishments

- Split snapshot content hashing and rebuild-manifest parsing into focused state modules with a
  versioned schema, complete-backup marker, content digest, and exact harness package identity.
- Made maintenance and upgrade backup resolve one receipt-verified package definition before
  starting a stopped sandbox or opening a Shields window, then revalidate it before capture and
  publication.
- Kept legacy standard recovery explicit and owner-reconciled while preserving the qualified,
  package-null Pi and NemoCUA candidate path.
- Bound public restore and clone to the selected snapshot, current registry row, retained package
  object, provider, and captured content; clone pending and final rows inherit the source identity
  instead of following the active pointer.
- Staged private restore bytes before destination deletion and limited cleanup to operation-owned
  temporary state.
- Added compare-and-swap registry handling and live OpenShell identity checks around restore and
  clone publication.
- Reorganized oversized snapshot, maintenance, onboarding, registry, installer, process-recovery,
  and E2E-support tests into focused scenario files without raising repository shape budgets.

## Task Commit

1. **Bind snapshot and recovery authority** — `05ac45c47d`

## Verification

- Plan 19's focused authority suite passed 274 tests; the broader snapshot/state set passed 109
  tests with 2 intentional skips.
- Prepared-recovery fixtures passed 15 tests, DCode rebuild fixtures passed 94, and generic rebuild
  fixtures passed 108.
- The full fast aggregate passed 1,726 files with 6 skipped and 27,396 tests with 76 skipped.
- The reorganized lifecycle suite passed 80 tests; its wider cleanup sets passed 419 CLI/integration
  assertions, 56 installer assertions, and 78 E2E-support assertions.
- CLI build and typecheck, plugin typecheck, exact Vitest project membership, 32 growth guardrails,
  repository architecture checks, normal signed commit hooks, and diff checks passed.

## User Setup Required

None.

## Next Phase Readiness

Plan 02-20 can consume the exact manifest identity at prepared-recovery selection and deletion, and
can carry the already resolved definition into rebuild target configuration.

## Self-Check: PASSED
