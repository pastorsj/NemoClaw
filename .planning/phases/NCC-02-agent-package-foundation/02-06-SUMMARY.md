---
phase: NCC-02-agent-package-foundation
plan: 06
subsystem: harness-install-cli
tags: [harness, install, prompt, package-contract]
requires: [02-05]
provides:
  - Explicit and interactive reviewed harness installation
  - Public command documentation and compiled CLI contract coverage
affects: [02-12, 02-22, 02-23]
requirements-completed: [UX-01, UX-02, PKG-05, TEST-03]
completed: 2026-08-28
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 Plan 06: Harness Install Summary

`nemoclaw harness install [id]` now installs only reviewed bundled packages through the existing
validated transaction. With no ID, an interactive terminal selects from packages not yet installed.

## Accomplishments

- Added a prompt with clear EOF, non-terminal, all-installed, and exact alias behavior.
- Added an idempotent install command that accepts reviewed IDs and current aliases only.
- Published list/install help and display metadata under the public `harness` topic.
- Added a compiled-process contract proving empty inventory, OpenClaw installation, and exact
  receipt-backed list output.

## Commits

1. `a0af87164a` — add harness install command
2. `2034542fbe` — publish harness package workflow

## Verification

- 18 focused source tests passed.
- The focused compiled CLI workflow and command registry passed (852 assertions total).
- Documentation build, CLI typecheck, repository checks, growth checks, format, and lint passed.
- The broad package-contract aggregate exceeded this Mac's parallel process capacity; the exact
  changed contracts passed serially and final bounded qualification remains in Plan 02-23.

## Self-Check: PASSED
