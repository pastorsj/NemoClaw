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
| Agent package | Deep Agents package | Separate exact locks, config, commands, image files, unavailable model settings, fake text and workspace turns |
| Core contract | NemoClaw | Synthetic artifact validation and generic headless command selection |
| Composition | Package plus NemoClaw | Install, list, select, stage, onboard, identity receipt, headless invocation |
| Live | Existing E2E registry | Mac fake endpoint and Brev approved inference on the pinned non-Ultra model; no messaging |

The normal feedback loop runs runner unit, released-SDK fixture, package conformance, and core
synthetic tests. Docker image checks run after dependency or image changes. Live E2E runs only after
deterministic evidence passes.
