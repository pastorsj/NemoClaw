---
phase: NCC-02-agent-package-foundation
plan: 03
subsystem: package-storage
tags: [agent-runtime, immutable-store, receipts, transactions]

# Dependency graph
requires:
  - phase: NCC-02-agent-package-foundation
    provides: Closed package envelope and validated hostile-tree boundary from Plan 02-02
provides:
  - Strict secret-free package receipts and active pointers
  - Gateway-independent immutable object storage and pinned lookup
  - One idempotent reviewed-package installation transaction
affects: [bundled-package-catalogue, harness-commands, durable-package-identity]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Publish object, then receipt, then replace the active pointer
    - Resolve pinned package authority by exact ID and digest without scanning
    - Keep installation data-only and reject same-version content conflicts

key-files:
  created:
    - src/lib/harness/package-receipt.ts
    - src/lib/harness/package-receipt.test.ts
    - src/lib/harness/package-store.ts
    - src/lib/harness/store-files.ts
    - src/lib/harness/package-store.test.ts
    - src/lib/harness/package-install.ts
    - src/lib/harness/package-install.test.ts
  modified:
    - src/lib/state/state-root.ts
    - src/lib/state/state-root.test.ts
    - ci/source-architecture-budget.json

key-decisions:
  - "Store harness packages under the gateway-independent base NemoClaw state root."
  - "Retain immutable objects and receipts; only the small active pointer is replaceable."
  - "Use one per-harness process lock and verify filesystem authority before and after publication."
  - "Expose active IDs separately so the catalogue can report one damaged package without hiding healthy packages."

patterns-established:
  - "Crash order: durable object, immutable receipt, atomic active pointer."
  - "Exact reinstall: verify and reuse the first object and receipt without changing their bytes or metadata."
  - "Fail closed: no bundled or repository fallback when installed authority is missing or damaged."

requirements-completed: [PKG-03, PKG-03A, PKG-04, PKG-05, PKG-08, TEST-03]

# Metrics
duration: 1h 06m
completed: 2026-08-28
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 Plan 03: Immutable Package Store Summary

Reviewed harness packages now install through one data-only transaction into a private,
gateway-independent, digest-addressed store.

## Performance

- **Duration:** 1h 06m
- **Started:** 2026-08-28T00:50:00Z
- **Completed:** 2026-08-28T01:56:04Z
- **Tasks:** 3
- **Files modified:** 10

## Accomplishments

- Added bounded, canonical, secret-free receipt, source-identity, and active-pointer records.
- Added private staging, per-harness cross-process locking, durable immutable publication, atomic
  active-pointer replacement, and exact pinned lookup.
- Preserved old objects and receipts across version advancement and preserved the first receipt on
  exact reinstall.
- Rejected missing, linked, replaced, malformed, drifted, or conflicting store state without
  fallback or partial activation.
- Added one reviewed-package install service that validates package data and never invokes package
  code, scripts, tests, templates, npm, or pip.

## Task Commits

Each task was committed atomically:

1. **Task 1: Define strict receipt and pointer records** — `495225fcc5`
2. **Task 2: Publish and read immutable package objects** — `5326fe915b`
3. **Task 3: Expose one idempotent installation transaction** — `f3dbcc6cf2`

## Files Created/Modified

- `src/lib/harness/package-receipt.ts` — closed receipt, source identity, pointer parsers, and serializers
- `src/lib/harness/package-store.ts` — immutable publication, active reads, and pinned resolution
- `src/lib/harness/store-files.ts` — private filesystem authority, durability, staging, and publication
- `src/lib/harness/package-install.ts` — reviewed data-only installation transaction
- `src/lib/state/state-root.ts` — explicit gateway-independent base state root
- Corresponding focused tests — schema, failure ordering, concurrency, drift, reinstall, and non-execution evidence
- `ci/source-architecture-budget.json` — one reviewed import into the state-root helper

## Decisions Made

- Package state lives at `~/.nemoclaw/harnesses` and does not vary with the OpenShell gateway port.
- Objects and receipts are immutable and digest-addressed. The active pointer is the only mutable
  selection record.
- A pinned read derives its exact receipt and object from validated package identity and never
  follows the current active pointer.
- Installation means installed only. It does not imply selection, qualification, or support.
- Node.js does not expose portable `renameat2`, `openat`, or `unlinkat`. The implementation uses
  per-harness locking, no-follow opens, private ownership and modes, and before-and-after inode
  checks without claiming kernel-atomic defense against a coordinated malicious same-UID process.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Split filesystem publication from store orchestration**

- **Found during:** Task 2
- **Issue:** Store orchestration and low-level filesystem authority would exceed the file-size and
  single-responsibility goals in one file.
- **Fix:** Added `store-files.ts` for private directories, canonical records, durability, and
  publication. `package-store.ts` retains transaction and identity orchestration.
- **Verification:** Both source files remain below 1,000 lines; the shared focused suite passes.
- **Committed in:** `5326fe915b`

**2. [Rule 2 - Missing Critical] Report active IDs without dereferencing every package**

- **Found during:** Task 2
- **Issue:** The next catalogue needs to report a damaged installed package without hiding healthy
  active entries.
- **Fix:** Added validated active-ID enumeration while leaving each package read fail closed.
- **Verification:** Active-directory type, naming, healthy inventory, and damaged-state tests pass.
- **Committed in:** `5326fe915b`

**3. [Rule 1 - Bug] Close publication and cleanup race windows**

- **Found during:** Task 2 security review
- **Issue:** Replace-capable immutable publication, stale active-pointer reads, failed staged writes,
  and broad missing-path cleanup could overwrite, accept, or leak ambiguous state.
- **Fix:** Added absent checks with publication identity verification, active-pointer revalidation,
  exact failed-write cleanup, and narrow missing-file handling.
- **Verification:** Conflict injection, pointer advancement, failed-write, missing-ancestor, and
  independent security-review tests pass.
- **Committed in:** `5326fe915b`

**4. [Rule 1 - Bug] Treat orphan objects as retained version authority**

- **Found during:** Task 2 failure testing
- **Issue:** A crash after object publication but before receipt publication could leave content
  outside the same-version conflict check.
- **Fix:** Validate retained object bindings as well as receipts; exact bytes repair forward and
  different bytes fail closed.
- **Verification:** Orphan repair and same-version conflict tests pass.
- **Committed in:** `5326fe915b`

**5. [Rule 3 - Blocking] Keep race tests behavioral and repository scans stable**

- **Found during:** Task 2 commit hooks
- **Issue:** Five raw filesystem assertions violated the source-shape budget, and temporary test
  trees under `test/**` could race repository scanners.
- **Fix:** Assert publication behavior through store APIs and place isolated runtime fixtures under
  the ignored package-manager cache.
- **Verification:** Source-shape reports zero cases, package-store tests pass 29/29, and normal hooks pass.
- **Committed in:** `5326fe915b`

---

**Total deviations:** 5 auto-fixed (2 missing critical, 2 bugs, 1 blocker).
**Impact on plan:** The public transaction remains small while failure handling, catalogue readiness,
and repository conformance are stronger than the initial task text.

## Issues Encountered

The first Task 2 commit attempts exposed source-shape and temporary-fixture scan failures. Both were
resolved before a commit was created.

## User Setup Required

None. This plan uses deterministic local tests only.

## Verification

- `npx vitest run --project cli src/lib/harness/package-receipt.test.ts src/lib/harness/package-store.test.ts src/lib/harness/package-install.test.ts src/lib/state/state-root.test.ts` — 105 tests passed with normal and serial file scheduling
- `npm run typecheck:cli` — passed
- `npx tsc -p tsconfig.src.json` — passed
- `npm run checks:repository` — passed
- `npx vitest run --project integration test/automation/pull-requests/growth-guardrails.test.ts` — 32 tests passed
- `npm run source-shape:check` — zero cases
- Targeted Oxlint, formatting, and `git diff --check` — passed
- Normal pre-commit and commit-message hooks for all three task commits — passed
- Independent security review — passed with the documented Node filesystem limitation

## Next Phase Readiness

Plan 02-04 can build the three accepted data-only artifacts and expose available, installed, and
damaged catalogue entries over this exact store. Plan 02-08 can record the same immutable identity
in durable onboarding state.

## Self-Check: PASSED

---

*Phase: NCC-02-agent-package-foundation*
*Completed: 2026-08-28*
