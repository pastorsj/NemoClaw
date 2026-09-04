---
phase: NCC-04-runtime-contract
plan: 04
subsystem: fabric-and-image-evidence
status: active
evidence_scope: local-prototype
product_scope: not-accepted
release_qualification: not-claimed
tags: [fabric, package-receipt, managed-image, provenance]
requires: [04-03]
provides:
  - Package-selected Fabric headless paths for four agent runtime packages
  - Distinct package receipt and managed-image cohort gates
affects: [04-05]
requirements-completed: []
last_updated: 2026-09-04
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 4 Plan 4: Fabric and Image Evidence Progress Summary

NeMo Fabric remains a package-owned, sandbox-local headless request path. Core selects the
receipt-pinned manifest command and transports a prompt over private standard input. The generic
runner validates package-owned `fabric.json`, bounds execution and results, redacts diagnostics,
and cleans private artifacts. It does not dispatch by agent runtime name.

Fabric does not install packages or own lifecycle, startup, configuration, restore, MCP,
messaging, pairing, policy, OpenShell state, or durable NemoClaw state.

## Package Fabric Paths

| Package | Package-selected adapter identity | Recorded result |
| --- | --- | --- |
| OpenClaw | `nvidia.nemoclaw.openclaw` | 29 passed, 2 macOS process cases skipped |
| Hermes | `nvidia.nemoclaw.hermes`, delegating to released `nvidia.fabric.hermes` | Aggregate Fabric lane passed |
| LangChain Deep Agents Code | Released `nvidia.fabric.langchain.deepagents` | 11 passed |
| Pi | `nvidia.nemoclaw.pi` | 20 passed, 2 macOS process cases skipped |

The generic aggregate Fabric command also passed. Tests cover configuration selection,
credential-name projection, literal-credential rejection, bounded success and failure results,
timeout, cancellation, redaction, and request-artifact cleanup. Native and Fabric lanes remain
separate because a Fabric adapter need not reproduce every interactive native feature.

## Receipt Boundaries

The package-store tests passed for exact install, immutable object and receipt publication, active
pointer resolution, tree revalidation, exact reinstall, conflicting publication, and content
drift. This local receipt proves the bytes NemoClaw selected. It does not prove publisher identity,
image provenance, compatibility, or runtime qualification.

Stock live E2E has a separate managed-image cohort gate. It must bind one source revision and
workflow attempt to the complete shipped agent set, both `linux/amd64` and `linux/arm64`, immutable
image and base-image digests, workload descriptors, and attestations. Every stock consumer must
use the same cohort receipt.

## Open Image Gate

This plan remains active because commit `f3fe6928c2` changed
`tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/managed-startup-image-runtime.bundle`, a
direct Docker build input. Existing Pi receipts bind an older source revision, so the repository
check correctly reports stale image evidence. New immutable AMD64 and ARM64 image receipts have
not been published for the changed cohort.

Pi is not part of the shipped cohort and cannot inherit qualification from that cohort. A Pi live
claim requires its own exact candidate image evidence. The current Brev ARM64 environment can
provide development evidence from a local build, but it cannot substitute for release
qualification.
