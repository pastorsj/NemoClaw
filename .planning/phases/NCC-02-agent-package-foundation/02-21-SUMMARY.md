---
phase: NCC-02-agent-package-foundation
plan: 21
subsystem: rebuild-consumer-authority
tags: [rebuild, harness-package, agent-definition, mcp, recovery]
requires: [02-20]
provides:
  - One immutable preflight-selected agent authority across all rebuild consumers
  - Exact recreated registry, session, and package verification before harness repair
  - Pinned messaging, dashboard, DCode, MCP, policy, gateway, backup, and restore behavior
affects: [02-22, 02-23]
requirements-completed: [UX-01, AGENT-04, PKG-03A, COMP-04, COMP-04A, TEST-03]
completed: 2026-08-29
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 Plan 21: Pinned Rebuild Consumers Summary

Rebuild now selects one immutable agent definition during preflight and passes that authority through
every downstream consumer. Independently resumable and post-await mutations reread durable state and
stop when the package, definition, registry, session, gateway, or MCP bridge state has changed.

## Accomplishments

- Added one shared rebuild-authority module for exact package identity, definition, registry, and
  recreated-agent comparisons.
- Passed the selected `ResolvedSandboxAgent` through backup, restore, post-restore, messaging,
  dashboard, GPU, DCode, policy, MCP, gateway restart, and process recovery paths.
- Revalidated resume authority before Session compare-and-swap or legacy migration and revalidated
  nested authoritative onboarding before externally visible effects.
- Required exact recreated registry, Session, and receipt-backed definition equality before harness
  repair, including prepared recovery and recovery-only retained state.
- Added post-await MCP bridge-state and gateway-agent fences so stale caller snapshots cannot
  authorize mutation.
- Kept candidate Pi and NemoCUA qualification behavior and the existing public rebuild confirmation
  and version APIs intact.
- Kept baseline policy and package-root resolution tied to the pinned definition rather than an
  ambient active package pointer.
- Kept the onboarding entry point net-neutral and all changed tests within repository growth
  guardrails.

## Task Commits

1. **Bind downstream rebuild consumers to pinned authority** — `f6ab896f14`

## Verification

- The final rebuild sweep passed 65 files with one skipped file: 843 tests passed and 14 skipped.
- The consolidated mutation-order set passed 159 tests; the final naming and compatibility set
  passed 86 tests, including 18 source-API compatibility assertions.
- CLI typecheck, exact project membership across 2,673 candidates, repository checks, source
  architecture checks, diff checks, and the normal signed commit hooks passed.
- Package-contract validation passed all 1,266 assertions. One slow credential file exceeded the
  default aggregate timeout and then passed all 25 assertions with the repository's bounded
  30-second test timeout.
- A fast aggregate recorded 1,732 passing files, 6 skipped files, and 27,471 passing assertions.
  Three unchanged tests failed only under aggregate load or because the developer's real registry
  contained an unrelated `alpha` sandbox; isolated serial replays passed 5, 31, and 32 assertions.
- A later broad integration attempt was stopped after sustained worker saturation produced unrelated
  command timeouts. Focused final-state integration coverage passed after the last authority edits.

## User Setup Required

None.

## Next Phase Readiness

Plan 02-22 can validate install-to-final-state package identity through the existing typed E2E
fixtures. It does not need another target catalogue or workflow planner.

## Self-Check: PASSED
