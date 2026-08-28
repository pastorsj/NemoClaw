---
phase: NCC-02-agent-package-foundation
plan: 11
subsystem: package-root-builds
tags: [build-context, dockerfile, package-root, security]
requires: [02-10]
provides:
  - Package-root authority for image selection and build context
  - Separate trusted OpenClaw patch root for custom Dockerfiles
affects: [02-15, 02-20, 02-21, 02-23]
requirements-completed: [AGENT-01, AGENT-04, PKG-04A, TEST-03]
completed: 2026-08-28
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 Plan 11: Package-Root Build Summary

Image selection, Dockerfile staging, patch preparation, rebuilds, and web-search rebuilds now read
package-managed assets from the selected pinned package root instead of the repository root.

## Accomplishments

- Carried one explicit package root through base-image resolution and every build-context owner.
- Revalidated selected package roots before filesystem or Docker effects.
- Kept custom Dockerfile patching bound to a separately trusted OpenClaw package root.
- Preserved repository-root behavior for core-owned assets and compatibility call sites.
- Added regression fixtures for installed package roots, missing roots, symlinks, and root drift.

## Commit

- `db0d74737f` — root builds in selected packages

## Verification

- 163 focused CLI tests passed across seven files.
- Independent review confirmed all three package-root authority findings were resolved.
- CLI build, typecheck, repository checks, growth checks, format, lint, and normal commit hooks
  passed.

## Self-Check: PASSED
