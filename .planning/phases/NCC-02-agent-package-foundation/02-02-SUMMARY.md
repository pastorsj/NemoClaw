---
phase: NCC-02-agent-package-foundation
plan: 02
subsystem: package-security
tags: [agent-runtime, package-envelope, filesystem-validation, sha256]

# Dependency graph
requires:
  - phase: NCC-02-agent-package-foundation
    provides: Accepted local-fork implementation boundary from Plan 02-01
provides:
  - Closed versioned agent-runtime package envelope and exact identity
  - Data-only bounded manifest parsing with no package code execution
  - Hostile-tree validation, deterministic digesting, and verified private staging
affects: [immutable-package-store, bundled-package-catalogue, harness-installation]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Parse package metadata as closed data before constructing an AgentDefinition
    - Validate source authority before and after each bounded no-follow copy
    - Preserve replacement evidence when staging cleanup authority is uncertain

key-files:
  created:
    - src/lib/harness/package-types.ts
    - src/lib/harness/package-manifest.ts
    - src/lib/harness/package-manifest.test.ts
    - src/lib/harness/package-tree.ts
    - src/lib/harness/package-copy.ts
    - src/lib/harness/package-tree.test.ts
  modified: []

key-decisions:
  - "Keep the first package envelope fixed to kind agent-runtime and contract version 1."
  - "Separate source validation and digesting from destination staging and cleanup."
  - "Report incomplete cleanup when authority changes instead of deleting an unverified replacement."

patterns-established:
  - "Closed package data: reject unknown fields, versions, executable entry fields, and identity disagreement."
  - "Filesystem authority: accept current-UID input and read-only reviewed root-owned input only after full no-follow checks."
  - "Deterministic identity: hash sorted normalized paths, type, executable bits, byte length, and bytes."

requirements-completed: [PKG-01, PKG-02, PKG-04, PKG-04A, PKG-08, AGENT-01]

# Metrics
duration: 1h 12m
completed: 2026-08-28
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 Plan 02: Package Envelope and Tree Summary

Closed agent-runtime metadata and hostile filesystem trees now cross one bounded, data-only package
boundary with deterministic content identity.

## Performance

- **Duration:** 1h 12m
- **Started:** 2026-08-27T23:42:20Z
- **Completed:** 2026-08-28T00:54:05Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Added an exact seven-field package envelope and a digest-bound installed identity.
- Rejected malformed JSON or YAML, executable extensions, unsafe paths, unbounded input, control
  characters, and envelope-to-manifest identity drift without importing package content.
- Added bounded hostile-tree traversal, source-authority verification, deterministic SHA-256
  identity, private copying, post-copy verification, and authority-bound cleanup.
- Added 140 focused tests for schema, path, ownership, mode, resource, replacement, cleanup, and
  non-execution behavior.

## Task Commits

Each task was committed atomically:

1. **Task 1: Define and parse the closed package envelope** — `3a38563dee`
2. **Task 2: Validate, copy, and digest hostile package trees** — `6e16fefebf`

## Files Created/Modified

- `src/lib/harness/package-types.ts` — closed package envelope and digest-bound identity types
- `src/lib/harness/package-manifest.ts` — bounded package and referenced agent-manifest parsing
- `src/lib/harness/package-manifest.test.ts` — schema, path, size, metadata, and non-execution tests
- `src/lib/harness/package-tree.ts` — hostile-tree validation, source authority, and deterministic digest
- `src/lib/harness/package-copy.ts` — private staging, verified copying, and authority-bound cleanup
- `src/lib/harness/package-tree.test.ts` — filesystem type, ownership, mode, race, limit, and cleanup tests

## Decisions Made

- The package boundary accepts one `agent-runtime` kind. Package-neutral loading remains deferred.
- The parser returns validated data. Plan 02-10 remains the only `AgentDefinition` construction path.
- Source validation and digesting remain separate from destination copying and cleanup.
- Node.js does not provide portable `openat` and `unlinkat` primitives. The implementation uses
  bounded no-follow opens, stable identity snapshots, before-and-after verification, and
  conservative cleanup without claiming kernel-atomic resistance to a coordinated same-UID race.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Split package staging from package-tree validation**

- **Found during:** Task 2
- **Issue:** The planned combined implementation exceeded 1,000 lines and mixed source validation
  with destination transaction cleanup.
- **Fix:** Moved verified staging and cleanup to `package-copy.ts`. The public workflow remains
  unchanged.
- **Files modified:** `package-tree.ts`, `package-copy.ts`, `package-tree.test.ts`
- **Verification:** Both source files remain below 1,000 lines. All 60 tree tests pass.
- **Committed in:** `6e16fefebf`

**2. [Rule 1 - Bug] Preserve uncertain staging replacements**

- **Found during:** Task 2 security review
- **Issue:** Cleanup could report success after a stage disappeared or could remove a replacement
  whose identity was not captured.
- **Fix:** Cleanup now requires retained directory authority. It returns a typed incomplete-cleanup
  error and preserves unverified replacements.
- **Files modified:** `package-copy.ts`, `package-tree.test.ts`
- **Verification:** Replacement, disappearance, ancestor-swap, and idempotent-cleanup tests pass.
- **Committed in:** `6e16fefebf`

**3. [Rule 3 - Blocking] Recast new tests for the repository growth guard**

- **Found during:** Task 1 commit hooks
- **Issue:** New test helpers exceeded the repository control-flow budget.
- **Fix:** Replaced conditional test helpers with declarative cases and direct assertions.
- **Files modified:** `package-manifest.test.ts`, `package-tree.test.ts`
- **Verification:** Growth guardrails pass, and both test files contain no `if (` statements.
- **Committed in:** `3a38563dee`, `6e16fefebf`

---

**Total deviations:** 3 auto-fixed (1 missing critical, 1 bug, 1 blocker).
**Impact on plan:** The changes preserve the planned public boundary and strengthen responsibility,
cleanup, and repository-conformance guarantees.

## Issues Encountered

The first Task 1 commit attempt failed the source-growth hook. The declarative test rewrite resolved
the failure before any commit was created.

## User Setup Required

None. This plan uses deterministic local tests only.

## Verification

- `npx vitest run --project cli src/lib/harness/package-manifest.test.ts src/lib/harness/package-tree.test.ts` — 140 tests passed
- `npm run typecheck:cli` — passed
- `npx tsc -p tsconfig.src.json` — passed
- `npm run checks:repository` — passed
- `npx vitest run --project integration test/automation/pull-requests/growth-guardrails.test.ts` — 32 tests passed
- Oxlint on all six created TypeScript files — passed
- Normal pre-commit and commit-message hooks for both task commits — passed
- `git diff --check` — passed

## Next Phase Readiness

Plan 02-03 can publish one validated staged tree through a digest-addressed immutable store. It must
import `copyVerifiedPackageTree` from `package-copy.ts` and treat incomplete cleanup as an explicit
failure.

## Self-Check: PASSED

---

*Phase: NCC-02-agent-package-foundation*
*Completed: 2026-08-28*
