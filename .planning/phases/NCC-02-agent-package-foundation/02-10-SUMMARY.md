---
phase: NCC-02-agent-package-foundation
plan: 10
subsystem: pinned-agent-definitions
tags: [agent-definition, package-root, sandbox-authority, security]
requires: [02-04, 02-09]
provides:
  - One explicit-root definition builder for repository and installed packages
  - Exact digest-addressed sandbox definition resolution
affects: [02-11, 02-14, 02-15, 02-21]
requirements-completed: [AGENT-01, AGENT-04, PKG-04A, COMP-03, COMP-04, TEST-03]
completed: 2026-08-28
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 Plan 10: Pinned Agent Definitions Summary

Repository and installed harness definitions now use one explicit trusted-root builder. A
package-managed sandbox resolves its definition from its recorded digest-addressed object and never
from the active package pointer or repository fallback.

## Accomplishments

- Extracted manifest construction from `defs.ts` into the data-only `buildAgentDefinition` path.
- Made package root, manifest path, and agent directory immutable authority fields while preserving
  existing nested definition mutability.
- Rejected absolute, traversal, containment-escaping, and symlinked package assets; legacy getters
  revalidate against post-construction symlink replacement.
- Added exact sandbox resolution that keeps recorded OpenClaw `null` separate from effective ID.
- Preserved qualified Pi and NemoCUA as non-package candidates and rejected fabricated identities.
- Rejected malformed/noncanonical persisted agent values instead of coercing them to OpenClaw.

## Commits

1. `59dda44301` — load definitions from package roots
2. `5f4b91637f` — resolve pinned sandbox definitions

## Deviations from Plan

- Independent review found stale legacy-path revalidation and malformed agent coercion gaps. Both
  were fixed before their commits and now have focused regression coverage.
- Shallow whole-object freezing would have changed historical nested mutability. Only the three
  authority properties are runtime-immutable instead.

## Verification

- 69 focused definition and sandbox-authority tests passed.
- Independent read-only security review found no remaining Plan 10 blocker.
- CLI typecheck, repository checks, growth checks, format, lint, and normal commit hooks passed.

## Self-Check: PASSED
