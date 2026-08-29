---
phase: NCC-02-agent-package-foundation
plan: 22
subsystem: package-aware-e2e
tags: [e2e, harness-package, onboarding, package-identity]
requires: [02-21]
provides:
  - Public install-before-onboard coverage for every standard base E2E profile
  - Closed receipt-backed package evidence carried through one typed fixture
  - Exact final inventory, Session, and registry package identity assertions
affects: [02-23]
requirements-completed: [UX-01, UX-02, UX-03, PKG-04A, TEST-03, TEST-04]
completed: 2026-08-29
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 Plan 22: Package-Aware E2E Fixtures Summary

The existing typed E2E workflow now installs a reviewed harness package before standard onboarding
and carries one receipt-backed identity to final state validation. Package coverage remains in the
shared fixture phases and does not introduce another target catalogue or workflow planner.

## Accomplishments

- Preserved the fixture's sanitized executable `PATH` when a command supplies an explicit
  environment overlay, without inheriting unapproved host credentials.
- Added a host-observable helper that installs through `nemoclaw harness install`, reads the closed
  machine inventory, and returns one exact full package identity.
- Rejected malformed, damaged, duplicate, aliased, partial, path-bearing, and extra-key inventory
  records before onboarding.
- Installed OpenClaw, Hermes, or LangChain Deep Agents Code before every supported standard base
  profile while retaining explicit candidate-package bypass behavior.
- Routed the existing non-messaging Hermes baseline through the same typed onboarding fixture.
- Re-read receipt-verified inventory at final validation and required exact identity equality with
  the onboard Session and sandbox registry, including the complete SHA-256 digest.
- Preserved OpenClaw's null compatibility sentinel separately from its effective package identity.

## Task Commits

1. **Add package-aware E2E fixtures** — `320d529e58`

## Verification

- The four focused E2E-support files passed all 114 tests.
- Semantic E2E phase coverage passed with 133 tests across 88 files.
- Vitest project membership was exact across 2,673 candidates and 7 projects.
- CLI typecheck, repository checks, source architecture checks, and diff checks passed.
- An independent implementation review found no package-schema, environment, identity, or workflow
  authority defects.

## User Setup Required

None for deterministic coverage. Plan 02-23 uses the already approved local Mac and Brev access.

## Next Phase Readiness

Plan 02-23 can exercise the public empty-store, install, onboard, inference, backup, rebuild, and
recovery-only paths without adding live messaging credentials or another E2E workflow.

## Self-Check: PASSED
