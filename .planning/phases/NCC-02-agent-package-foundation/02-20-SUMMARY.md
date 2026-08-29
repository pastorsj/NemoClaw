---
phase: NCC-02-agent-package-foundation
plan: 20
subsystem: prepared-rebuild-authority
tags: [rebuild, recovery, preflight, harness-package, agent-definition]
requires: [02-19]
provides:
  - Exact prepared-recovery manifest and package authority at the delete edge
  - One receipt-verified agent definition carried through rebuild target preflight
  - Pinned package roots for ordinary and custom rebuild image preparation
affects: [02-21, 02-23]
requirements-completed: [UX-01, AGENT-04, PKG-03A, COMP-04, COMP-04A, TEST-03]
completed: 2026-08-29
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 2 Plan 20: Prepared Rebuild Authority Summary

Rebuild now resolves one receipt-verified sandbox agent before target preparation and carries that
same authority through resume, image, and recovery preflight. The final synchronous deletion fence
independently rereads the registry, selected manifest, package receipt, object, definition, and
candidate qualification before allowing a prepared-recovery mutation.

## Accomplishments

- Added exact schema-v2 prepared-recovery package validation while retaining owner-reconciled
  schema-v1 recovery and explicit package-null Pi and NemoCUA candidate behavior.
- Compared the complete selected manifest authority at every recovery fence, including rejection
  of same-path and same-timestamp manifest substitution.
- Re-resolved the package receipt, retained object, registry row, and definition inside the actual
  delete callback so drift stops before sandbox deletion or recreation.
- Resolved one `ResolvedSandboxAgent` before gateway, image, target, or backup work and carried the
  identical object through `RebuildResumeConfig` and `RebuildTargetConfig`.
- Removed ambient definition loads from ordinary base-image and custom-image preparation; both now
  use the pinned definition and its exact package root.
- Kept OpenClaw web-search credential reuse tied to the pinned effective agent identity instead of
  a null-definition sentinel.
- Proved that advancing an active package pointer cannot change an in-flight prepared recovery.
- Renamed the snapshot lifecycle test fixture in a separate commit so test support remains outside
  the production CLI build graph.

## Task Commits

1. **Keep the lifecycle fixture outside the CLI build** — `c077a57696`
2. **Bind prepared rebuild authority** — `d2b0c77b8d`

## Verification

- The final changed CLI set passed 21 files and 294 tests; the affected root integration passed 27
  tests.
- Prepared recovery passed 22 focused tests, including manifest substitution, registry drift,
  receipt/object drift, candidate-gate loss, and active-pointer advancement.
- Custom-image and target preparation passed 45 focused tests across three files.
- A bounded fast aggregate recorded 1,732 passing files and 27,412 passing tests, with 6 files and
  76 tests skipped; one unchanged uninstall test exceeded its 15-second timeout under aggregate
  load and then passed serially with all 31 assertions.
- CLI build and typecheck, source architecture, exact project membership, 32 growth guardrails,
  repository checks, normal signed commit hooks, secret scanning, and diff checks passed.

## User Setup Required

None.

## Next Phase Readiness

Plan 02-21 can pass the existing `ResolvedSandboxAgent` directly to post-restore, messaging,
dashboard, GPU, and DCode consumers. No new rebuild context abstraction is needed.

## Self-Check: PASSED
