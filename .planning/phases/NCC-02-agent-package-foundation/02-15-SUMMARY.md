---
phase: NCC-02-agent-package-foundation
plan: 15
subsystem: onboarding-package-authority
tags: [onboard, harness, package, route, policy]
requires: [02-11, 02-14]
provides:
  - Exact Session package authority on route reservations and pending policy records
  - Pre-mutation package revalidation for inference and sandbox creation
  - Package-bound Hermes portable lifecycle publication
affects: [02-16, 02-17, 02-18, 02-22, 02-23]
requirements-completed: [AGENT-04, PKG-03A, COMP-03, COMP-04, COMP-04A, TEST-03]
completed: 2026-08-28
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 Plan 15: Route and Policy Package Authority Summary

Inference routes, pending policy records, verified-create replay, and Hermes portable lifecycle
publication now retain and revalidate the onboarding Session's exact harness package authority.

## Accomplishments

- Required session-owned route reservations to carry the complete package identity and migration
  pair. Candidate routes carry explicit `null` authority.
- Re-read the current Session and resolve its pinned package object before inference, policy,
  OpenShell, sandbox, or portable-lifecycle mutations.
- Bound pending policy records to package identity without duplicating migration provenance inside
  the nested policy record.
- Preserved exact package authority when a qualified route becomes the final registry row.
- Kept OpenClaw's null agent sentinel, qualified Pi and NemoCUA, and existing provider and policy
  ownership unchanged.
- Split new coverage into focused one- or two-word test files and kept the onboarding entry point
  net-neutral in size.

## Task Commit

1. **Bind route and policy package authority** — `540dba0e4d`

## Verification

- 381 focused CLI tests passed across route, provider, policy, sandbox-create, and package
  boundaries.
- Hermes installer integration passed 3 tests; host-local registry integration passed 16 tests.
- Final focused guardrail suite passed 65 tests.
- CLI build and typecheck, 32 growth guardrails, onboarding composition, repository checks,
  formatting, secret scan, normal commit hooks, and diff checks passed.
- The aggregate deterministic and live no-messaging qualification remains assigned to Plan 02-23.

## User Setup Required

None.

## Next Phase Readiness

Plan 02-16 can carry the same exact identity through checkpoint replay, recreate journals, and
rebuild Session creation.

## Self-Check: PASSED
