---
phase: NCC-03-fabric-headless
plan: 02
subsystem: fabric-headless
tags: [fabric, openclaw, agent-runtime, headless]
requires: [03-01]
provides:
  - Package-owned OpenClaw Fabric adapter, descriptor, configuration, and tests
  - Generic headless dispatch without an OpenClaw branch in the Fabric runner
  - Shared integrity and recovery handling for native and Fabric configuration
affects: [03-04]
requirements-completed: []
completed: 2026-09-02
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 3 Plan 2: OpenClaw Fabric Adapter Summary

OpenClaw now supplies the `nvidia.nemoclaw.openclaw` adapter and descriptor selected by the generic
Fabric runner. The adapter translates Fabric lifecycle calls into the managed gateway-backed
OpenClaw command while the native TUI, gateway, and startup behavior remain unchanged.

## Accomplishments

- Kept the adapter, descriptor, exact dependency lock, image installation, configuration, and tests
  under `packages/nemoclaw-openclaw`.
- Passed prompts through private mode-0600 files, validated only completed OpenClaw envelopes, and
  removed prompt files after success, failure, cancellation, or timeout.
- Contained the OpenClaw process tree and returned bounded, redacted failures without forwarding
  agent diagnostics or managed credentials.
- Generated `openclaw.json` and `fabric.json` together and included both files in configuration
  integrity, recovery, mutable-permission, and Shields transitions.
- Selected the package manifest's `headless_command` through generic NemoClaw dispatch. The generic
  Fabric runner contains no OpenClaw branch.
- Extended the existing public-turn and rebuild fixtures instead of adding another live registry or
  workflow planner.

## Task Commits

1. **Add package-owned managed-agent adapters** — `2774d10ccd`
2. **Supervise private turns and expose package headless runners** — `5a312ee81f`, `894bff8122`
3. **Harden OpenClaw process, gateway, and fallback boundaries** — `d407c3ea62`, `0a13edbe49`,
   `1c4d4d17aa`
4. **Close generic runner and qualification boundaries** — `d27e5e328b`, `ee9b24cdd6`
5. **Preserve package-owned config and reviewed locks** — `fd1372b537`, `5beb259ff9`,
   `057f308ecc`, `194cb33c1a`

## Recorded Verification

- The aggregate Fabric lane ran 24 OpenClaw cases: 22 passed and 2 Linux-only process cases skipped
  on macOS.
- The recorded package-only lane passed 576 tests with 2 skips. The NemoClaw-facing lane passed
  1,129 tests with 16 skips, and the nested plugin lane passed 1,089 tests.
- Focused generic/provider behavior passed 94 tests, timer authority passed 114 tests, and rebuild
  fixture support passed 16 tests after shared lifecycle hardening.
- Four final public-command regression files passed all 114 tests on signed candidate
  `52714c1b25`; CLI typecheck also passed.

These are deterministic development results. Plan 03-04 still owns the live macOS and Brev
journeys, cleanup evidence, and any final qualification conclusion. This summary makes no product
support claim.

## Next Phase Readiness

Plan 03-04 can exercise the same public Fabric turn through the existing non-messaging OpenClaw
lifecycle targets.

## Self-Check: PASSED
