---
phase: NCC-02-agent-package-foundation
plan: 14
subsystem: onboarding-package-resume
tags: [onboard, harness, package, resume, writer-lock]
requires: [02-10, 02-13]
provides:
  - Pre-mutation rejection for package-managed resume conflicts
  - Session-pinned package resolution independent of the active pointer
  - Real portable-boundary evidence for current and legacy package authority
affects: [02-15, 02-16, 02-18, 02-23]
requirements-completed: [UX-01, UX-03, PKG-03A, COMP-03, COMP-04, COMP-04A, TEST-03]
completed: 2026-08-28
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 Plan 14: Exact Package Resume Summary

Package-managed onboarding now rejects conflicting authority before Session, router, portable-host,
or runtime mutation. Resume resolves the Session-pinned object and does not follow the active
pointer.

## Accomplishments

- Rejected malformed package authority and recorded or selected agent mismatch before transition
  diagnostics, state clearing, Session updates, or router shutdown.
- Proved both `--agent` and `NEMOCLAW_AGENT` conflicts stop before portable host preparation and
  preserve the exact Session bytes.
- Moved pinned-object resume evidence into a focused package test. The tests cover active-pointer
  advancement and missing or damaged original objects.
- Preserved qualified Pi and NemoCUA resume with explicit null package authority.
- Proved direct legacy package reconciliation occurs while the writer lock and portable host fence
  remain active.

## Task Commit

1. **Reject package resume conflicts and preserve pinned authority** — `05837c7108`

## Files Created or Modified

- `src/lib/onboard/runtime-control-flow.ts` — Pre-mutation package resume transition guard.
- `src/lib/onboard/package/resume.test.ts` — Pinned object, drift, mutation, and candidate evidence.
- `src/lib/onboard/package/ordering.test.ts` — Retains package-boundary ordering evidence without
  duplicate resume cases.
- `src/lib/onboard/portable-resume-lock-boundary.test.ts` — Real command, writer-lock, host-fence,
  selector, and legacy migration evidence.
- `src/lib/onboard.ts` — Exposes the already captured internal package boundary for the hermetic
  source test. The public onboarding options and package-root authority remain unchanged.

## Decisions Made

- Package-managed resume cannot use the existing agent-change path. Any agent disagreement is an
  authority failure, not a request to clear agent-owned state.
- The portable test patches the exact internal boundary object that onboarding already owns. It
  does not add a user option, environment override, CommonJS loader hook, or compiled-artifact
  dependency.
- Legacy and qualified candidate paths remain distinct. Only valid package-managed state receives
  the new transition guard.

## Verification

- 109 focused CLI tests passed across eight resume, selection, portable-boundary, and candidate
  files.
- The portable source test passed 23 tests after `clean:cli` and `catalog:compile`; it does not
  depend on bundled `dist/harnesses` output.
- CLI typecheck, repository checks, exact Vitest membership, 32 growth guardrails, normal commit
  hooks, and `git diff --check` passed.
- Independent review found no remaining correctness, security, abstraction, or test-seam blocker.
- A broad `test:fast` attempt encountered unrelated timeout failures under concurrent execution and
  was stopped. Final deterministic qualification remains assigned to Plan 02-23.

## User Setup Required

None.

## Next Phase Readiness

Plan 02-15 can persist this exact owner identity through route reservation, pending policy
verification, provider inference, and sandbox creation.

## Self-Check: PASSED
