---
phase: NCC-03-fabric-headless
plan: 03
subsystem: fabric-headless
tags: [fabric, hermes, agent-runtime, headless]
requires: [03-01]
provides:
  - Package-owned Hermes descriptor and supervisor for the released Fabric adapter
  - Isolated runner and Hermes adapter dependency environments
  - Atomic native, Fabric, MCP, integrity, and recovery state handling
affects: [03-04]
requirements-completed: []
completed: 2026-09-02
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 3 Plan 3: Hermes Fabric Adapter Summary

Hermes now exposes the package descriptor `nvidia.nemoclaw.hermes`. The generic runner loads its
package-owned proxy, and that proxy's supervisor invokes released `nvidia.fabric.hermes` from the
isolated Hermes adapter environment. NemoClaw core does not contain a Hermes Fabric branch.

## Accomplishments

- Kept the descriptor, lifecycle proxy, process supervisor, exact dependency locks, image files,
  configuration projection, and tests under `packages/nemoclaw-hermes`.
- Separated the generic runner environment from the released Hermes adapter and native Hermes
  environment, then validated the selected interpreter before process creation.
- Bounded lifecycle records and process trees, drained untrusted adapter diagnostics without
  exposing them, and closed the adapter on success, failure, malformed input, timeout, or parent
  loss.
- Projected the managed model route into credential-free `fabric.json`; configuration records only
  the managed credential's environment name.
- Included native config, Fabric config, MCP state, and integrity hashes in the existing Hermes
  transaction, rollback, recovery, and Shields boundaries.
- Extended the existing public-turn and rebuild fixtures without adding a Hermes-specific core
  workflow.

## Task Commits

1. **Add package-owned managed-agent adapters** — `2774d10ccd`
2. **Supervise private turns and expose package headless runners** — `5a312ee81f`, `894bff8122`
3. **Align and validate the isolated Hermes adapter boundary** — `8abdf84d28`, `431bf23f28`,
   `2b2b71c6ce`, `071b714156`
4. **Close generic runner and qualification boundaries** — `d27e5e328b`, `ee9b24cdd6`,
   `d607fb8f91`
5. **Preserve package-owned config through Shields** — `fd1372b537`, `5beb259ff9`

## Recorded Verification

- The aggregate Fabric lane ran 13 Hermes cases: 12 passed and 1 Linux-only process case skipped on
  macOS. It proved discovery of `nvidia.nemoclaw.hermes` and invocation of released
  `nvidia.fabric.hermes`.
- The recorded package-only TypeScript lane passed 332 tests with 73 skips, and all 5 Python plugin
  tests passed.
- The NemoClaw-facing parallel lane passed 583 tests with 52 skips. Its four serialized subprocess
  files passed all 39 tests on rerun after the transient version-command failure.
- After the later fixture correction, 76 relevant Hermes consumers and the composed Hermes state
  posture check passed. Hermes typecheck also passed.
- Four final public-command regression files passed all 114 tests on signed candidate
  `52714c1b25`; CLI typecheck also passed.

These are deterministic development results. Plan 03-04 still owns the live macOS and Brev
journeys, cleanup evidence, and any final qualification conclusion. This summary makes no product
support claim.

## Next Phase Readiness

Plan 03-04 can exercise the same public Fabric turn through the existing non-messaging Hermes
lifecycle targets.

## Self-Check: PASSED
