---
phase: NCC-04-runtime-contract
plan: 03
subsystem: agent-runtime-contract
status: complete
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
completed: 2026-09-04
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 4 Plan 3: Contract Evidence Summary

The reusable evidence structure is implemented. Current tests show that a package absent from
core's named package sets can implement MCP, configuration, and restore through fixed operations
without adding a core agent branch. A separate `future-terminal` authoring fixture covers metadata,
materialization, installation, onboarding selection, Dockerfile and Fabric command selection,
startup persistence, and private standard-input handoff.

## Implemented Evidence

- `src/lib/agent-runtime/host-module.test.ts` loads a synthetic fourth agent runtime through the
  fixed MCP contract.
- `src/lib/agent-runtime/config-module.test.ts` exercises synthetic configuration and restore
  adapters, including per-leaf URL policy, typed refusals, receipt pinning, and bounded write
  plans.
- `src/lib/agent-runtime/adapter/loader.test.ts` and `schema.test.ts` own generic loader, trust,
  schema, and size-limit failures.
- `test/package-contract/harness-adapter.test.ts` verifies the compiled public artifact boundary.
- `test/onboarding/package-composition.test.ts` starts with an unknown authoring package and proves
  discovery, materialization, alias install, immutable receipt identity, onboarding selection,
  package Dockerfile, startup, and Fabric command selection, private standard-input handoff, and
  typed MCP refusal.
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
| OpenClaw | 581 package tests passed, 1 skipped; 1,117 composed tests passed, 16 skipped; 1,074 plugin tests passed; 29 Fabric tests passed, 2 skipped |
| Hermes | 314 package tests passed, 72 skipped; 502 composed tests passed, 53 skipped; 92 serialized subprocess tests, 5 Python tests, and 12 Fabric tests passed; 1 Fabric test skipped |
| LangChain Deep Agents Code | 399 package tests passed, 25 skipped; 476 composed tests passed, 41 skipped; 11 Fabric tests passed |
| Pi | 18 package tests and 3 composition tests passed; 20 Fabric tests passed, 2 skipped |

The focused unknown-package composition test passed 1/1. The relevant compiled package contracts
passed 14/14. E2E-support passed 265 files with 4 skipped and 3,874 tests with 39 skipped. The
original live assertion ratchet remains intact. Project membership covered 2,476 candidates across
7 projects; CLI typecheck and the 45/45 growth guard also passed.

## Remaining Handoff Limits

- Package-only rehearsal does not build the Docker image. Package Dockerfiles still consume
  reviewed root build-context assets.
- Pi's materialized archive proof remains under the root package-contract lane rather than a
  package-owned archive test.

These build and archive gaps do not invalidate or reopen this plan's typed operation and test
ownership proof. They prevent an independent-repository handoff claim and remain later work.
