---
phase: 03
slug: fabric-headless
status: active
nyquist_compliant: true
created: 2026-08-30
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 3 Validation Strategy

| Lane | Owner | Required evidence |
|---|---|---|
| Runner unit | `packages/nemoclaw-fabric` | Config, prompts, doctor pass/warn/fail, succeeded/failed/cancelled, JSON/plain, redaction, exceptions |
| Released SDK | `packages/nemoclaw-fabric` | Discovery, doctor, start, two invokes, stop, malformed result, host failure, signals, no orphan |
| DCode and Pi | Owning packages | Exact locks, config, commands, image files, text or workspace turns, failures, and native-command preservation |
| OpenClaw | `packages/nemoclaw-openclaw` | Adapter, composed runner, config integrity, recovery, privilege, startup, image, timeout, and redaction |
| Hermes | `packages/nemoclaw-hermes` | Package descriptor and supervisor, released adapter, composed runner, atomic route projection, integrity, recovery, MCP state, image, timeout, and redaction |
| Core contract | NemoClaw | Data-only artifact validation, generic headless selection, multi-file restore, rebuild, and Shields behavior |
| E2E support | Existing typed fixtures | Public Fabric turn, result parsing, artifact checks, redaction, target wiring, and semantic phase membership |
| Live | Existing E2E registry | A new package starts with one typed onboard-run-destroy Fabric journey; mature package lifecycle and security edges remain when risk is distinct; no messaging |

## Execution Order

1. Run adapter-only tests without a NemoClaw checkout.
2. Run each adapter through the generic runner.
3. Run package and core lifecycle tests.
4. Run E2E-support and registry checks.
5. Build images after dependency or image changes.
6. Run one public Fabric turn as a new package's baseline after deterministic evidence passes.
7. Add another live target only when rebuild, restart, provider, operating system, hardware, or
   serving behavior creates a distinct package risk.

`03-QUALIFICATION.md` records current results. A passing deterministic contract reduces the live
matrix, but it does not replace Docker, OpenShell, policy, process, or inference evidence.

Package tests own native grammar, configuration, adapters, artifacts, and failure cases. Shared
contract tests prove composition without an agent-name branch. After those lanes pass, a new
package adds one typed `PublicFabricHarnessContract` journey for its cross-system evidence. A
lifecycle test must not repeat the Fabric turn unless that lifecycle transition changes Fabric
behavior.
