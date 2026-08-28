---
phase: NCC-02-agent-package-foundation
plan: 13
subsystem: onboarding-package-authority
tags: [onboard, harness, package, migration, writer-lock]
requires: [02-08, 02-09, 02-11, 02-12]
provides:
  - Writer-locked package preparation before portable recovery
  - Exact fresh Session package binding and legacy owner migration
  - Post-recovery package and candidate revalidation
affects: [02-14, 02-15, 02-18, 02-23]
requirements-completed: [UX-01, UX-03, PKG-03A, COMP-03, COMP-04, COMP-04A, TEST-03]
completed: 2026-08-28
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 Plan 13: Writer-Locked Session Package Binding Summary

Onboarding now proves exact harness authority before portable recovery and binds fresh or migrated
Session state before ordinary onboarding work begins.

## Accomplishments

- Added one focused package boundary with the readable workflow: prepare under the writer lock,
  recover prior portable state, bind and revalidate exact authority, then continue onboarding.
- Saved fresh Session compatibility state and full package identity together; OpenClaw keeps its
  recorded null sentinel and qualified Pi/NemoCUA remain package-free.
- Reconciled direct standard legacy sessions through exact bundle validation, immutable package
  installation, object reread, owner-scoped Session CAS, and same-owner registry updates.
- Revalidated fresh packages, package-managed resumes, and qualified candidates after portable
  recovery without following an advanced active pointer.
- Kept unrelated recovery updates while rejecting changes to Session ID, sandbox owner,
  compatibility agent, package identity, or migration provenance.

## Task Commits

1. **Task 1: Reconcile standard legacy session authority** — `5df248740f`
2. **Tasks 2–3: Save exact fresh authority and enforce writer-lock ordering** — `9e689da8ad`

## Files Created/Modified

- `src/lib/onboard/package/boundary.ts` — Package preparation, recovery binding, and exact agent
  resolution for one onboarding command.
- `src/lib/onboard/package/ordering.test.ts` — Behavioral lock, recovery, binding, and mutation-order
  evidence.
- `src/lib/onboard/session-bootstrap.ts` — One complete fresh Session write with exact package
  identity or explicit candidate absence.
- `src/lib/onboard/resume/locked-runtime.ts` — Pre-effect authority binding hook.
- `src/lib/state/harness-migration.ts` — Idempotent owner-scoped legacy migration that preserves
  unrelated recovery updates.
- `src/lib/onboard.ts` — Small composition wiring from package preparation through onboarding.

## Decisions Made

- Package selection and both exact reads stay behind one onboarding package boundary; the main
  orchestrator only expresses the prepare → recover → bind → continue workflow.
- Package-managed state is resolved by its persisted digest. Active pointers select future fresh
  runs only.
- Qualified repository candidates are requalified after recovery but never receive fabricated
  package identity.

## Deviations from Plan

### Safety-driven portable first-save boundary

The plan described the first fresh Session save as preceding every host-runtime write. A complete
portable checkpoint cannot be saved honestly until consent-gated host preparation has established
and qualified the current-user Podman authority. Writing a guessed or null authority would create
an invalid resumable Session, while a preliminary Session would violate the one-envelope invariant.

The implemented boundary is therefore:

1. exact package selection and binding occur before consent or host preparation;
2. portable retirement recovery consumes the unchanged prior Session and registry bytes;
3. consent and fenced, idempotent portable host qualification may run;
4. the complete package-bound Session is the first Session write; and
5. that write precedes tracing, credential staging, runtime-boundary writes, routes, policies,
   gateway operations, and sandbox operations.

A crash during portable host qualification can leave reconciliable host preparation without a new
Session, but cannot leave a partially package-bound Session.

## Verification

- 115 focused CLI tests passed across migration, bootstrap, ordering, locked runtime, and Station
  Express state.
- CLI typecheck passed.
- Repository architecture, exact Vitest membership, and 32 growth guardrails passed.
- Oxlint, Oxfmt, secret scanning, normal commit hooks, and `git diff --check` passed.
- Independent review found no remaining blocker after fresh post-recovery revalidation and the
  production locked-runtime composition test were added.

## User Setup Required

None.

## Next Phase Readiness

Plan 02-14 can add the defensive runtime-transition guard and real portable resume qualification
without creating another package resolver or resume authority path.

## Self-Check: PASSED
