---
phase: NCC-03-fabric-headless
status: active
evidence_scope: local-fork-development
last_updated: 2026-09-04
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 3 Development Qualification

This record tracks local-fork development evidence. It is not release qualification and does not
activate a supported NemoClaw product surface.

## Deterministic Evidence Recorded

The following results cover the current local implementation. Package results are package-owned
evidence. The E2E-support aggregate covers shared fixture and workflow behavior.

| Boundary | Recorded result |
|---|---|
| OpenClaw | Package 581 passed and 1 skipped; composition 1,117 passed and 16 skipped; plugin 1,074 passed; Fabric 29 passed and 2 skipped |
| Hermes | Package 314 passed and 72 skipped plus 5 Python tests; composition 502 passed and 53 skipped; subprocess 92 passed; Fabric 12 passed and 1 skipped |
| LangChain Deep Agents Code | Package 399 passed and 25 skipped; composition 476 passed and 41 skipped; Fabric 11 passed |
| Pi | Package 18 passed; composition 3 passed; Fabric 20 passed and 2 skipped |
| Unknown-package composition | One test passed for discovery, materialization, alias install, receipt, onboarding, Dockerfile and Fabric command selection, startup persistence, private standard-input handoff, and MCP refusal |
| Compiled package contracts | 14 passed |
| E2E support | 265 files passed and 4 skipped; 3,874 tests passed and 39 skipped |
| Static checks | CLI typecheck, assertion ratchet, 45/45 growth guard, and project membership for 2,476 candidates across 7 projects passed |

The broad root aggregate and current managed-image checks remain separate open gates.

## Live Qualification Status

| Environment and scope | Identity | Result | Limitation and cleanup |
|---|---|---|---|
| macOS unknown-package development run | Local candidate through `9761597cde`; package ID `contract-probe`; OpenShell 0.0.106 | Install and inventory passed. Receipt identity survived interrupted onboarding, resume, stop, and start. Fabric returned `PONG` before and after a gateway restart. | This proves the bundled Dockerfile, terminal, and Fabric path. It does not prove managed startup or a named package. The sandbox, gateway, and test state were removed. |
| Brev/Linux unknown-package development run | `9761597cde`; Ubuntu 22.04 ARM64; OpenShell 0.0.106; NeMo Fabric 0.2.0; package digest `0b0c21672f55db5a3b9e15f056a0c9e04091c9e200c2a8ba37ea9a608e72f3b6` | The same install, interrupted-onboard, resume, stop, start, and two-turn Fabric sequence passed. | The configured endpoint returned 403. A deterministic authenticated test endpoint proved transport and composition, not that configured service. Cleanup removed the isolated sandbox, gateway, and private home. |
| Named OpenClaw and Hermes managed lifecycle | Pending | Managed activation, inference switch, Shields, rebuild, and package-specific edges are not complete. | This row remains the open part of Plan 03-04. |

The unknown package is absent from core package-ID lists and uses the ordinary Dockerfile and
terminal path. These runs prove that generic path only. Live messaging tests remain excluded.
