---
phase: NCC-04-runtime-contract
plan: 03
subsystem: agent-runtime-contract
status: active
evidence_scope: local-prototype
product_scope: not-accepted
tags: [agent-runtime, conformance, test-ownership, source-boundary]
requires: [04-02]
provides:
  - Synthetic unknown-package conformance for current typed operations
  - Package-owned native assertions and core-owned semantic assertions
  - Static core-to-package dependency enforcement
affects: [04-04, 04-05]
requirements-completed: []
last_updated: 2026-09-04
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 4 Plan 3: Contract Evidence Progress Summary

The reusable evidence structure is implemented, but this plan remains active until its package
independence and final-candidate rerun are closed. Current tests show that a package unknown to the
production catalogue can implement MCP, configuration, and restore through fixed operations
without adding a core agent branch.

## Implemented Evidence

- `src/lib/agent-runtime/host-module.test.ts` loads a synthetic fourth agent runtime through the
  fixed MCP contract.
- `src/lib/agent-runtime/config-module.test.ts` exercises synthetic configuration and restore
  adapters, including per-leaf URL policy, typed refusals, receipt pinning, and bounded write
  plans.
- `src/lib/agent-runtime/adapter/loader.test.ts` and `schema.test.ts` own generic loader, trust,
  schema, and size-limit failures.
- `test/package-contract/harness-adapter.test.ts` verifies the compiled public artifact boundary.
- `scripts/checks/layer-import-boundaries.mts` rejects static, re-export, `require`, dynamic, and
  relative imports from core into an agent runtime package.

The source gate has one counted migration exception:

```text
src/lib/messaging/applier/build/messaging-build-applier.mts
-> packages/nemoclaw-openclaw/compat/npm-remediation.mts
```

It predates this contract and must be deleted when messaging build support moves behind an
approved package boundary.

## Native Test Ownership

This phase physically moved two existing source test files into the OpenClaw package:

| Previous owner | Package owner |
| --- | --- |
| `src/lib/state/openclaw-config-merge.test.ts` | `packages/nemoclaw-openclaw/tests/host/config-merge.test.ts` |
| `src/lib/state/openclaw-config-merge-tool-search.test.ts` | `packages/nemoclaw-openclaw/tests/host/tool-merge.test.ts` |

Together they retain 28 test declarations and 43 parameterized cases. No existing test file was
moved into Hermes, LangChain Deep Agents Code, or Pi in this slice; those packages received new
package-local adapter tests instead. Package tests own native command grammar, URL decisions,
restore merge grammar, configuration anchors, image inputs, and native failures. Core tests retain
credentials, SSRF validation, policy authorization, OpenShell execution, transaction order,
rollback, state, and redaction.

## Recorded Package Results

| Package | Recorded deterministic result |
| --- | --- |
| OpenClaw | 581 package tests passed, 1 skipped; 1,117 composed tests passed, 16 skipped; 1,072 plugin tests passed |
| Hermes | 303 package tests passed, 72 skipped; 519 composed tests passed, 53 skipped; 92 serialized subprocess tests and 5 Python tests passed |
| LangChain Deep Agents Code | 399 package tests passed, 25 skipped; 476 composed tests passed, 41 skipped |
| Pi | 18 package tests and 3 composition tests passed |

Project membership, source-graph, layer-boundary, build, and type-check gates also passed during
the recorded deterministic runs.

## Why This Plan Remains Active

- The final aggregate and E2E-support rerun has not completed on the final candidate.
- Package-only rehearsal does not build the Docker image. Package Dockerfiles still consume
  reviewed root build-context assets.
- Pi's materialized archive proof remains under the root package-contract lane rather than a
  package-owned archive test.

These build and archive gaps do not invalidate the typed operation boundary, but they prevent an
independent-repository handoff claim.
