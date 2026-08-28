---
phase: NCC-02-agent-package-foundation
plan: 12
subsystem: installed-package-selection
tags: [onboard, selection, harness, integrity]
requires: [02-05, 02-07, 02-10]
provides:
  - Zero, one, and many installed-harness onboarding selection
  - Exact pinned package reread before selection returns
affects: [02-13, 02-14, 02-23]
requirements-completed: [UX-01, UX-02, AGENT-01, AGENT-04, PKG-05, TEST-03]
completed: 2026-08-28
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 Plan 12: Installed Package Selection Summary

Onboarding can now select from the healthy installed harness inventory while retaining qualified
candidate behavior and failing closed on damaged installed package state.

## Accomplishments

- Added distinct zero-, one-, and many-package selection behavior.
- Preserved the non-terminal OpenClaw default only when OpenClaw is actually installed.
- Required an explicit `--agent` in non-terminal runs when another choice is necessary.
- Preserved aliases and independent candidate qualification without presenting candidates as
  installed standard packages.
- Reread the exact pinned package before returning a selection and rejected concurrent drift.
- Added reusable package fixtures that exercise real package validation and installation.

## Commit

- `ad76410df3` — select installed harness packages

## Verification

- 23 focused CLI tests passed.
- Independent review confirmed damaged installed state cannot be hidden by a healthy peer.
- CLI typecheck, project membership, repository checks, growth checks, format, lint, and normal
  commit hooks passed.

## Self-Check: PASSED
