---
phase: NCC-02-agent-package-foundation
plan: 04
subsystem: bundled-package-catalogue
tags: [agent-runtime, bundled-artifacts, package-catalogue, deterministic-build]

# Dependency graph
requires:
  - phase: NCC-02-agent-package-foundation
    provides: Immutable package store, receipts, active pointers, and pinned reads from Plan 02-03
provides:
  - Closed reviewed source declarations for the three accepted standard harnesses
  - Deterministic data-only bundled artifacts under `dist/harnesses`
  - One fail-closed catalogue separating available, installed, and damaged state
  - Non-destructive private-root materialization for deterministic package tests
affects: [harness-list, harness-install, package-selection, package-root-loading]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Closed reviewed source map to validated read-only package artifact
    - Explicit available, installed, and damaged lifecycle records
    - Exact production-root replacement while tests use private roots

key-files:
  created:
    - src/lib/harness/bundled-source.ts
    - src/lib/harness/bundled-source.test.ts
    - src/lib/harness/package-catalog.ts
    - src/lib/harness/package-catalog.test.ts
    - scripts/build-harnesses.mts
    - test/package-contract/bundled-harnesses.test.ts
  modified:
    - package.json
    - ci/source-architecture-budget.json

key-decisions:
  - "Bundle only OpenClaw, Hermes, and LangChain Deep Agents Code; Pi and NemoCUA remain candidates."
  - "Keep adapter package versions independent from upstream sandbox binary versions."
  - "Keep legacy and shared source mappings explicit and remove the adapter in Phase 3."
  - "Ship validated data and sandbox/image assets only; expose no dynamic host callback."
  - "Treat damaged installed state as damaged, never as uninstalled or eligible for fallback."
  - "Reserve destructive cleanup for exact `dist/harnesses`; deterministic tests build under absent private roots."

patterns-established:
  - "Reviewed declaration -> contained no-follow copy -> closed envelope -> read-only validated tree."
  - "Catalogue tests inject roots and never depend on HOME or ambient build output."
  - "Availability does not imply installation, activation, qualification, or support."
  - "Package tests that read shared build output never clean or rebuild it concurrently."

requirements-completed: [PKG-03, PKG-04A, PKG-05, PKG-08, UX-02, AGENT-01]

# Metrics
duration: 1h 34m
completed: 2026-08-28
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 Plan 04: Bundled Package Catalogue Summary

NemoClaw now builds reviewed, data-only package artifacts for the three accepted standard harnesses
and exposes one fail-closed catalogue that keeps availability separate from installation.

## Accomplishments

- Declared the exact transitional source mappings for OpenClaw, Hermes, and LangChain Deep Agents
  Code, including reviewed image/build dependencies and explicitly temporary shared blueprint input.
- Kept Pi and NemoCUA outside the ordinary catalogue and kept adapter SemVer independent from each
  harness manifest's upstream runtime version.
- Added deterministic read-only `nemoclaw-package.json` artifacts under
  `dist/harnesses/nemoclaw-<id>` and validated them through the install-time envelope/tree boundary.
- Added side-effect-free packed-artifact coverage for required Docker assets and exclusions for
  authoring files, credentials, caches, candidates, gitlinks, and host callbacks.
- Added one catalogue for available, installed, and damaged records with exact identity comparison,
  exact aliases, candidate rejection, and fail-closed installed-store reads.
- Removed a package-contract race by moving repeated builds into two absent private roots and proving
  shared `dist/harnesses` identity, content, and modes do not change.

## Task and Fix Commits

1. **Task 1: Declare the reviewed transitional bundle sources** — `78dda78570`
2. **Task 2: Build deterministic bundled package artifacts** — `7b5814151e`
3. **Task 3: Expose one available and installed catalogue** — `fbb532d553`
4. **Fix: Isolate deterministic bundle builds** — `ef98fb3eba`

## Decisions Made

- Current repository-layout knowledge is isolated in `bundled-source.ts`; it is a temporary build
  adapter, not the public package contract.
- Every copied path is named, contained, read without following links, and included in the digest.
- Finished artifacts are data-only and read-only. Core never imports or invokes package callbacks.
- Catalogue state is explicit. Corruption never degrades to a bundled or repository fallback.
- Production can replace only the exact managed output. Private materialization creates an absent,
  caller-owned root and never deletes or overwrites it.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Record the new source architecture edge**

- **Issue:** The build integration added one reviewed script-root file beyond the prior architecture
  budget.
- **Fix:** Updated the exact scripts budget from 42 to 43.
- **Committed in:** `7b5814151e`

**2. [Rule 1 - Bug] Remove shared-output mutation from determinism coverage**

- **Issue:** The first determinism test cleaned shared `dist/harnesses` while another package test
  copied `dist`, producing an intermittent missing-path failure.
- **Fix:** Added non-destructive private materialization and compared two private builds while
  snapshotting the unchanged shared root.
- **Committed in:** `ef98fb3eba`

---

**Total deviations:** 2 auto-fixed (1 missing critical, 1 bug).
**Impact on plan:** The public package and catalogue contracts did not expand.

## Verification

- Bundled-source tests — 14 passed.
- Package-catalogue tests — 15 passed.
- Bundled package contract — 4 passed.
- Original race regression, bundle contract plus managed-image transport together — 5 passed.
- Package-contract aggregate — 1,243 of 1,244 passed; the remaining unrelated process-dispatch
  timing case passed immediately in isolation.
- `npm run typecheck:cli` — passed.
- `npm run checks:repository` — passed.
- Growth, source-shape, Oxlint, Oxfmt, and `git diff --check` — passed.
- Normal pre-commit and commit-message hooks — passed for all four commits.

## Next Phase Readiness

Plan 02-05 can consume one deterministic catalogue for `harness list`, and Plan 02-06 can resolve
and install only reviewed available artifacts. Plans 02-10 and 02-11 can replace transitional source
mapping with exact installed roots without changing envelope, store, or lifecycle meanings.

## Self-Check: PASSED

---

*Phase: NCC-02-agent-package-foundation*
*Completed: 2026-08-28*
