---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
stopped_at: Completed 01-02-PLAN.md
last_updated: "2026-08-22T12:51:42.581Z"
last_activity: 2026-08-22
progress:
  total_phases: 10
  completed_phases: 0
  total_plans: 50
  completed_plans: 2
  percent: 4
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Project State

## Project Reference

See: `.planning/PROJECT.md` (updated 2026-08-22)

**Core value:** Existing NemoClaw users retain the same onboarding and sandbox lifecycle while runtime-native implementation leaves NemoClaw core.
**Current focus:** Phase 1 - Scope and Behavior Baseline

## Current Position

Phase: 1 of 10 (Scope and Behavior Baseline)
Plan: 2 of 4 in current phase
Status: Behavior baseline recorded; repository acceptance blocks Phase 2
Last activity: 2026-08-22 - Validated and closed GSD Plan 01-02 against signed characterization commit `060e71e092` without changing product behavior.

Progress: [░░░░░░░░░░] 4%

## Performance Metrics

**Velocity:**

- Total plans completed: 2
- Average duration: 4 minutes
- Total execution time: 8 minutes

**By Phase:**

| Phase | Plans | Total | Average |
|---|---:|---:|---:|
| 01 | 2 | 8 min | 4 min |

## Accumulated Context

| Phase 01 P01 | 1 min | 3 tasks | 3 files |
| Phase 01 P02 | 7min | 2 tasks | 4 files |

### Decisions

Decisions are recorded in `.planning/PROJECT.md` and phase `CONTEXT.md` files.

- The public command is `nemoclaw harness install`.
- Standard packages are automatically selectable. A locally installed compatible package remains listable until a maintainer accepts it into the standard catalog.
- The first extraction boundary is `packages/` in this repository.
- The in-tree qualified release precedes any external repository handoff.
- Live messaging-service tests are excluded from this migration.
- One package catalogue, production lifecycle path, OpenShell client, checked-in release set, and E2E registry own the common behavior. Existing state readers handle compatibility. A shared abstraction requires two current consumers and must replace a named runtime-specific path.

### Pending Todos

- Keep the migration commits local until the user explicitly authorizes a remote write.
- Obtain a repository-owned accepted design decision before Phase 2 or package
  implementation begins.

- Assign the accountable product, package, security, release, compatibility, state, artifact, and
  E2E owners named in the decision packet.

- Install `hadolint` before image-file changes. The contributor doctor otherwise passes after the
  CLI rebuild.

### Blockers and Concerns

- Maintainer acceptance, accountable ownership, and the validation plan are required before Phase 2 or package implementation starts.
- The all-files manual CLI coverage run reached `test/onboard-sandbox-recreation.test.ts`, where a
  synchronous child process exceeded the declared 60-second test limit. Focused tests and all other
  pre-commit checks pass; resolve or disposition this existing test-runner hang before a pull request
  if broad coverage remains required.

- Local SSH signing is configured and the characterization commit is signed. GitHub verification
  remains a future pre-PR gate and does not block local commits.

- External artifact transport and trust policy require a separate accepted decision before Phase 9 executes.

## Deferred Items

| Category | Item | Status | Deferred At |
|---|---|---|---|
| Agent runtimes | Pi and NemoCUA packaging | Awaiting separate product decisions | Project initialization |
| Hermes | Portable mode and tool gateway broker contracts | Awaiting separate designs | Project initialization |
| Messaging | Live service qualification and Deep Agents Code bridge | Awaiting accounts or runtime capability | Project initialization |

## Session Continuity

Last session: 2026-08-22T12:51:42.574Z
Stopped at: Completed 01-02-PLAN.md
Resume file: .planning/phases/01-scope-and-behavior-baseline/01-03-PLAN.md
