---
phase: NCC-02-agent-package-foundation
plan: 17
subsystem: onboarding-package-authority
tags: [onboard, harness, package, registry, recovery]
requires: [02-16]
provides:
  - Exact final package authority across every onboarding owner
  - Package-bound retained recovery records with legacy read support
  - Fail-closed candidate and standard recovery publication
affects: [02-18, 02-19, 02-20, 02-21, 02-22, 02-23]
requirements-completed: [PKG-03A, COMP-03, COMP-04, COMP-04A, COMP-04B, TEST-03]
completed: 2026-08-28
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 Plan 17: Final Registry and Recovery-Only Cancellation Summary

Final sandbox publication and post-create recovery now preserve one exact harness package identity
without changing OpenClaw's compatibility sentinel or fabricating package authority for qualified
repository agents.

## Accomplishments

- Re-read and compared the owning Session, checkpoint, recreate transaction, route reservation,
  policy checkpoint, incomplete registry row, requested final row, migration provenance, and exact
  immutable object immediately before final publication.
- Compared the Session's normalized agent with the requested effective agent, closing both standard
  package substitution and Pi/NemoCUA substitution paths.
- Preserved OpenClaw's recorded `agent: null` compatibility form while keeping its effective package
  identity separate and exact.
- Added retained recovery record v2 with canonical, identity-bound record IDs while keeping v1
  records readable and distinguishable for installer reconciliation.
- Made cancellation and post-create failure copy package authority only from a durable reread of the
  recovery-only Session.
- Required standard recovery records to match the Session agent and required Pi/NemoCUA records to
  carry explicit null package and migration authority.
- Added compare-and-swap reconciliation for one selected legacy retained record, including
  duplicate, collision, drift, retry, and candidate-null behavior.
- Updated public fresh-create fixtures to install real reviewed packages under stable private roots,
  so active-pointer changes and missing immutable bytes are exercised without weakening package
  tree validation.

## Task Commit

1. **Bind final and retained package authority** — `66aa252e81`

## Verification

- Final review suite passed 158 focused CLI tests across package identity, registration, Session,
  retained recovery, route reservation, and exit failure behavior.
- Full public fresh-create identity coverage passed 14 tests; full onboarding state-machine slices
  passed 17 tests with real installed package fixtures.
- Additional registration, cancellation, entry-gate, route, and recovery-focused suites passed
  before the final review fixes.
- CLI build and typecheck, exact Vitest project membership, 32 growth guardrails, repository
  architecture checks, formatting, secret scan, normal commit hooks, and diff checks passed.
- The default parallel aggregate remains deferred to Plan 02-23 because this Mac previously
  saturated subprocess deadlines; the affected suites pass in focused and serialized runs.

## User Setup Required

None.

## Next Phase Readiness

Plan 02-18 can reconcile legacy Session, registry, and retained-record owners before the installer
runs strict backup or changes OpenShell.

## Self-Check: PASSED
