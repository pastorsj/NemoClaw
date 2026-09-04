---
phase: NCC-04-runtime-contract
plan: 01
subsystem: agent-runtime-contract
status: complete
evidence_scope: local-prototype
product_scope: not-accepted
tags: [agent-runtime, typed-contract, package-receipt, security]
provides:
  - Finite typed adapter contract with core-owned paths, exports, schemas, and limits
  - Receipt-bound package identity for executable host helpers
  - Explicit division between package planning and core execution authority
affects: [04-02, 04-03, 04-04, 04-05]
requirements-completed: []
completed: 2026-09-04
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 4 Plan 1: Contract Foundation Summary

The local candidate now has one finite host-helper boundary. Core names each operation and owns
the request type, result type, fixed package path, fixed export, runtime schema, and byte limits.
An installed package supplies only bounded data or command plans. Core still owns credentials,
policy authorization, OpenShell access, command execution, state, locks, commit, rollback, and
redacted diagnostics.

This completion records implementation of the local prototype. No accepted product decision
authorizes package-authored host code as a supported NemoClaw extension surface, so this summary
does not establish a public API, package distribution policy, or release qualification.

## Implemented Boundary

| File | Responsibility |
| --- | --- |
| `src/lib/agent-runtime/adapter/contract.ts` | Generic typed operation and contract definitions |
| `src/lib/agent-runtime/adapter/schema.ts` | JSON compatibility, size bounds, schema validation, and freezing |
| `src/lib/agent-runtime/adapter/loader.ts` | Fixed-path, receipt-bound module loading and invocation |
| `src/lib/agent-runtime/adapter/mcp.ts` | Model Context Protocol requests, results, operations, and runtime schemas |
| `src/lib/agent-runtime/adapter/config.ts` | Configuration and restore requests, results, operations, and runtime schemas |
| `src/lib/agent-runtime/host-module.ts` | Model Context Protocol loader facade |
| `src/lib/agent-runtime/config-module.ts` | Configuration and restore loader facades |

The operation map, rather than a package manifest, selects executable host code. The loader:

1. Starts with an explicit installed package identity and immutable receipt.
2. Resolves the receipt-pinned `AgentDefinition` and required manifest capability.
3. Validates the package tree before and after reading the core-owned module path.
4. Rejects links, special files, invalid UTF-8, oversized source, imports, and code generation.
5. Evaluates a self-contained synchronous CommonJS module with string and WebAssembly code
   generation disabled.
6. Validates, bounds, and freezes the request and result.
7. Returns the receipt-pinned definition and plan to the core transaction owner.

The Model Context Protocol source limit is 512 KiB; request and result values are limited to
1 MiB. Configuration and restore source is limited to 1 MiB; its total boundary is 40 MiB and
individual configuration documents are limited to 16 MiB. Evaluation and invocation are bounded
to 500 ms.

## Trust Model

The VM reduces accidental capability access; it is not a hostile-code sandbox. The package
adapter receives no import loader, OpenShell client, filesystem handle, secret value, policy
mutator, transaction object, or rollback callback. Current adapters are synchronous and verified
against their installed package receipt. A future external distribution proposal must either
define trusted publisher and synchronous-code requirements or move evaluation into a stronger
process boundary.

The core contract is typed in TypeScript and revalidated with runtime JSON Schemas. Package
`*.cts` files are self-contained CommonJS source and are not compiled by the package TypeScript
configurations. Package behavior tests and runtime schema validation are therefore required on the
package side of the boundary.

## Recorded Evidence

- Adapter loader, schema, host-module, configuration-module, receipt drift, mutation, and negative
  fixture tests passed in the focused deterministic runs recorded for commit `f3fe6928c2`.
- A focused CLI group covering 31 files passed 271 tests.
- The compiled package-contract adapter lane passed all 9 tests.
- Type checks, layer-import boundaries, source-graph checks, and test-project membership passed.

These are local deterministic results, not a final aggregate or live qualification result.

## Remaining Boundary

Sandboxes without package receipts still use named compatibility paths. Full startup still uses
the closed `MANAGED_STARTUP_AGENTS` set, profile mappings, image selection, and startup
coordinator. Those paths are migration inventory, not exceptions that a new package can extend.
