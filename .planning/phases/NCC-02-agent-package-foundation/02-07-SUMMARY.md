---
phase: NCC-02-agent-package-foundation
plan: 07
subsystem: agent-list-compatibility
tags: [agents, harness, compatibility]
requires: [02-05]
provides:
  - Installed-only compatibility projection for `nemoclaw agents list`
affects: [02-12, 02-23]
requirements-completed: [UX-01, UX-02, PKG-05, AGENT-01]
completed: 2026-08-28
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 Plan 07: Installed Agent List Summary

The compatibility `agents list` command now projects receipt-verified installed standard harnesses
instead of repository manifests. Package management remains owned by `harness list/install`.

## Accomplishments

- Preserved the existing command surface, descriptions, ordering, alignment, and empty-state text.
- Excluded available-only, damaged, candidate, alias, and unsupported rows.
- Kept Pi and NemoCUA under their existing independent qualification gates.

## Commit

- `637be1d24d` — make agents list installed-only

## Verification

- 9 focused CLI tests passed.
- CLI typecheck, project membership, repository checks, growth checks, format, and lint passed.

## Self-Check: PASSED
