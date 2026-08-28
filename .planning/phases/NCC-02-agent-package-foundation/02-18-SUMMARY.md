---
phase: NCC-02-agent-package-foundation
plan: 18
subsystem: installer-package-reconciliation
tags: [installer, harness, package, migration, recovery]
requires: [02-17]
provides:
  - Fail-closed installer reconciliation for Session, registry, and retained owners
  - Empty-store harness guidance before host and OpenShell mutation
  - Correct Express selection, package reconciliation, and host-preparation order
affects: [02-19, 02-20, 02-21, 02-22, 02-23]
requirements-completed: [UX-01, UX-02, UX-03, PKG-03A, AGENT-04, COMP-04, TEST-03]
completed: 2026-08-28
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 Plan 18: Installer Harness Reconciliation Summary

The installer now reconciles every durable harness owner to exact package authority before strict
backup or OpenShell changes, and an empty ordinary package store follows the public harness-install
workflow instead of silently selecting repository code.

## Accomplishments

- Added one writer-locked reconciliation service that reads Session, registry, installed inventory,
  pinned package objects, and retained recovery records through their owning typed parsers.
- Preflighted every owner before the first package or state write, then re-read same-owner state and
  immutable package content after each migration and at final convergence.
- Preserved a valid cross-build pinned package during partial legacy migration instead of replacing
  it with the current bundled package.
- Kept Pi and NemoCUA on their qualified repository path: Session state carries explicit null
  authority, registry state omits package fields, and neither candidate can fabricate a receipt.
- Added a hidden, bounded installer command with a closed `ready` or `empty-store` machine result.
- Made the installer offer `nemoclaw harness install` for an interactive empty store, use the
  selected/default package in automation, and exit cleanly without Docker, OpenShell, backup, or
  onboarding when package installation is declined.
- Ordered the flow as notice acceptance, Express selection, Node/CLI preparation, package
  reconciliation, WSL and Station qualification, then host and OpenShell mutation.
- Split new process fixtures into focused support modules and lowered the legacy preflight-test size
  budget after extracting its failed-Session prompt fixture.

## Task Commit

1. **Reconcile harness authority before install** — `eef82645e2`

## Verification

- Package migration, reconciliation, Session, registry, and retained recovery passed 132 focused
  CLI tests in a serialized run.
- Installer-facing integration passed 129 tests with 17 platform skips; process-level installer
  coverage passed 211 tests with one platform skip.
- The dedicated Express ordering and full installer preflight files passed 95 tests.
- CLI build and typecheck, exact Vitest project membership, 32 growth guardrails, repository
  architecture checks, shell syntax, secret scan, normal commit hooks, and diff checks passed.
- The default parallel fast aggregate saturated this Mac and produced broad timing failures across
  unrelated subsystems. Relevant files pass in focused serialized runs; aggregate qualification
  remains part of Plan 02-23 after the upstream merge and lifecycle work.

## User Setup Required

None.

## Next Phase Readiness

Plan 02-19 can resolve backup authority from the reconciled registry identity and write that exact
identity into rebuild manifests before snapshot, restore, or clone mutation.

## Self-Check: PASSED
