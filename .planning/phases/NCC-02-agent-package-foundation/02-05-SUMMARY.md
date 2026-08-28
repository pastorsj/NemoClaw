---
phase: NCC-02-agent-package-foundation
plan: 05
subsystem: harness-inventory
tags: [harness, inventory, cli]
requires: [02-04]
provides:
  - Stable installed and reviewed-available harness inventory
  - Human and JSON `nemoclaw harness list` output
affects: [02-06, 02-07, 02-12]
requirements-completed: [UX-01, UX-02, PKG-05, AGENT-01]
completed: 2026-08-28
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 Plan 05: Harness Inventory Summary

`nemoclaw harness list` now reads one reviewed catalogue and clearly separates installed packages
from packages available to install. It performs no ambient module, URL, or directory discovery.

## Accomplishments

- Added a stable inventory model for healthy installed, damaged installed, and available packages.
- Added separate human and machine renderers; JSON retains the complete content digest.
- Added the public `harness` topic and `harness list` command without package-specific behavior.
- Kept path validation and canonical ID/alias handling in the existing package authorities.

## Commits

1. `b5a043a34e` — expose harness package inventory
2. `b474d137a3` — add harness list command

## Verification

- 17 focused CLI tests passed.
- CLI typecheck, repository checks, project membership, growth checks, format, and lint passed.

## Self-Check: PASSED
