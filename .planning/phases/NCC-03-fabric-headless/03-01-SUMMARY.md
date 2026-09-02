---
phase: NCC-03-fabric-headless
plan: 01
subsystem: fabric-headless
tags: [fabric, harness, headless, dcode, pi]
provides:
  - Generic sandbox-local Fabric runner selected through package data
  - Data-only built-artifact validation command
  - Deep Agents and Pi headless integration without native command changes
affects: [03-02, 03-03, 03-04]
requirements-completed: [FABRIC-01, FABRIC-02]
completed: 2026-09-01
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 3 Plan 1: Fabric Headless Foundation Summary

The branch contains one generic `nemoclaw-fabric` runner. Agent packages select adapters through a
Fabric configuration and descriptor. NemoClaw still owns package validation, policy, credentials,
OpenShell lifecycle, state, and recovery.

## Accomplishments

- Added data-only `nemoclaw harness validate` artifact conformance.
- Added `doctor`, `run`, and version commands with prompt validation, normalized output, redacted
  failures, bounded termination, and lifecycle cleanup.
- Connected the released Deep Agents adapter without changing the native DCode command.
- Added a package-owned Pi adapter through the same runner and preserved Pi's native command.
- Made terminal headless dispatch use the package manifest command instead of an agent-specific
  Fabric branch.

## Recorded Verification

- The current aggregate Fabric run passed 56 runner unit tests and 7 runner integration tests.
- The same run passed 5 DCode tests and 12 Pi tests, with 1 documented Pi skip.
- Exact Python dependency checks passed.
- Commits `0edee9ba0b`, `78e1f99715`, `c5ef46cd65`, and `bfaac9e7fd` contain the principal
  foundation, Pi, and headless-dispatch changes.

Plan 03-04 must rerun the aggregate lane after the OpenClaw and Hermes work is final. This summary
does not record Mac, Brev, release, or product-support evidence.

## Next Work

Plans 03-02 and 03-03 connect OpenClaw and Hermes. Plan 03-04 owns the common non-messaging live
qualification.
