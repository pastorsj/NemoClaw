---
phase: NCC-04-runtime-contract
plan: 02
subsystem: agent-runtime-contract
status: complete
evidence_scope: local-prototype
product_scope: not-accepted
tags: [agent-runtime, mcp, package-adapter, receipt]
requires: [04-01]
provides:
  - Package-owned Model Context Protocol command planning for capable packages
  - Typed capability refusal for packages without Model Context Protocol support
  - Receipt-backed dispatch without a native core fallback
affects: [04-03, 04-04, 04-05]
requirements-completed: []
completed: 2026-09-04
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 4 Plan 2: Model Context Protocol Migration Summary

Hermes, OpenClaw, and LangChain Deep Agents Code now build their native Model Context Protocol
(MCP) commands from receipt-pinned package adapters. Pi declares MCP disabled and reaches the same
typed capability error as an unknown package without MCP. A package-backed request cannot fall
back to the old native translator.

This is a completed local-prototype slice. It does not approve package-authored host modules as a
supported product surface.

## Contract Operations

Every operation uses the fixed package path `host/mcp-adapter.cts`.

| Operation | Fixed export | Package result |
| --- | --- | --- |
| `register` | `buildMcpRegistrationPlan` | Execution, verification, and credential-convergence plan |
| `remove` | `buildMcpRemovalPlan` | Execution and typed removal outcome |
| `inspect` | `buildMcpInspectionCommand` | Non-empty inspection command |
| `mutationCapability` | `describeMcpMutationCapability` | `not-required` or a bounded command probe |
| `teardownCapability` | `describeMcpTeardownCapability` | `not-required` or a bounded command probe |
| `verifyRuntimeIntent` | `describeMcpRuntimeIntentVerification` | `not-required` or a bounded command probe |
| `runtime` | `buildMcpRuntimeCommand` | Argument vector that core quotes and executes |

The packages own only translation into native grammar:

| Package | Package implementation | Result |
| --- | --- | --- |
| Hermes | `packages/nemoclaw-hermes/host/mcp-adapter.cts` | Receipt-backed native plans |
| OpenClaw | `packages/nemoclaw-openclaw/host/mcp-adapter.cts` | Receipt-backed native plans |
| LangChain Deep Agents Code | `packages/nemoclaw-langchain-deepagents-code/host/mcp-adapter.cts` | Receipt-backed native plans |
| Pi | No MCP adapter; manifest capability disabled | Typed refusal before module load |

Core retains endpoint validation, credential placeholders, policy generation, credential revision
convergence, OpenShell execution, durable requested state, inspection authority, transaction
order, rollback, and redacted error reporting. The package never receives these authorities.

## Dispatch Result

Receipt-backed dispatch begins with the sandbox package identity and calls the fixed contract. It
does not choose a package implementation by agent name or adapter ID. Missing capabilities,
modules, exports, receipts, or matching package content fail closed.

The no-receipt compatibility path remains deliberately separate:

- `src/lib/actions/sandbox/mcp-bridge/legacy-mutation.ts`
- Legacy branches in `src/lib/actions/sandbox/mcp-bridge-adapters.ts`
- Deep Agents legacy configuration helpers, including
  `src/lib/actions/sandbox/mcp-bridge/deepagents-legacy-config.ts`

These files are debt for a later upgrade-boundary migration. Their existence does not provide a
fallback for a receipt-backed package.

## Recorded Evidence

- Focused MCP adapter, dispatch, capability, runtime command, intent, state, status, probe,
  mutation, rollback, and policy-authority tests passed.
- The focused MCP bridge group passed 22 tests; the execution group passed 48; registry behavior
  passed 62.
- Hermes credential-revision convergence passed on the exact candidate revision.
- Package tests exercised positive registration, replacement, removal, malformed results,
  receipt drift, and native failure behavior.
- The E2E MCP fixture now installs the selected agent runtime package before onboarding at commit
  `5a8253a97a`.

Live MCP bridge execution remains part of Plan 04-05. This summary claims only the implemented
package-backed dispatch and its deterministic evidence.
