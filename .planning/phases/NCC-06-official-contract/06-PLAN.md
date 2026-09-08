---
phase: NCC-06-official-contract
type: execute
autonomous: true
depends_on:
  - "NCC-04-runtime-contract"
must_haves:
  truths:
    - "Every receipt-backed core operation uses package data, a fixed sandbox command, a finite typed plan, or a typed unsupported result."
    - "A package author can compile and run conformance tests without copying NemoClaw internals."
    - "An operator-selected external package can be installed, upgraded, removed, rolled back, and kept pinned for existing sandboxes."
    - "Managed startup and image composition do not require a harness ID branch."
    - "Package CI can invoke one generic public lifecycle without adding its harness to a core E2E catalogue."
    - "No exact-revision support claim precedes deterministic and live evidence."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 6: Official-ready harness contract POC

## Objective

Complete the smallest coherent local proof that independently maintained harness packages can
integrate with NemoClaw through a typed contract and NeMo Fabric while NemoClaw remains the trusted,
harness-agnostic control plane.

## Execution slices

1. **Stabilize the baseline.** Reconcile stale POC fixtures, classify platform-only failures, and
   retain exact evidence without weakening repository budgets.
2. **Publish the authoring boundary.** Export manifest and finite adapter types, provide reusable
   compile-time/runtime conformance, and declare prompt transport instead of inferring it from an
   executable name.
3. **Complete package lifecycle.** Accept a validated operator-selected local artifact and implement
   compatibility refusal, installation, upgrade, removal, rollback, and receipt pinning.
4. **Genericize composition.** Replace closed managed-startup and managed-image maps with qualified
   package declarations while retaining platform, runtime-provider, policy, credential, and
   transaction authority in core.
5. **Migrate native behavior.** Move one real OpenClaw, Hermes, or Deep Agents behavior and its tests
   per change. Do not add arbitrary callbacks or speculative operations.
6. **Extract build and E2E inputs.** Give packages a reviewed shared runtime/build artifact and a
   package-owned way to invoke the generic lifecycle from an independent checkout.
7. **Protect the boundary.** Reject new production-core harness IDs, native package paths, untyped
   operations, and unowned root tests.
8. **Qualify the exact revision.** Run focused, aggregate, package-only, macOS, and Brev evidence.
   Keep live messaging services out of scope.
9. **Close receipt-backed native dispatch.** Once a sandbox has a package receipt, route active
   configuration, messaging, sessions, dashboard, restore, and process behavior through manifest
   data, fixed commands, or finite typed package plans. Keep exact harness IDs only in product
   qualification, display compatibility, and historical decoding.
10. **Quarantine compatibility.** Legacy readers may identify old OpenClaw, Hermes, or Deep Agents
    state only long enough to migrate it to package authority. They must not become the behavior
    fallback for a receipt-backed sandbox.
11. **Keep live evidence proportional.** Run the short install/onboard/Fabric-turn/cleanup smoke
    journey for every package. Run the harness-neutral upgrade, pinning, rollback, deactivation,
    and restart lifecycle once per release environment rather than once per harness.

## Definition of done

- OpenClaw, Hermes, Deep Agents Code, Pi, DeepSeek, Haystack, and a synthetic unknown package use
  the same public package workflow for every capability they claim.
- Remaining unsupported capabilities are explicit and typed; none silently enter a stock-harness
  fallback.
- Package source trees build and test independently using declared shared inputs.
- Core tests describe authorization, transactions, security, platforms, runtimes, and generic
  composition. Package tests describe harness-native behavior.
- The broad deterministic lanes are green on their supported hosts, and exact-revision live
  lifecycle evidence records successful cleanup.
- The final report lists any formal product, publisher-trust, or platform qualification decision
  that code alone cannot complete.
- A repository check rejects new receipt-backed production dispatch that selects native behavior
  from an exact harness ID, while explicitly allowlisting catalogue and legacy-decoder ownership.

## Execution status

- [x] Reconcile `origin/main` through `efd56a3729` and preserve upstream native skill behavior.
- [x] Express native list/add/remove skill commands in the existing typed package capability.
- [x] Keep package receipt capture and revalidation ahead of every package-managed skill mutation.
- [x] Remove the new literal default-harness decision from core and lower the audited debt ledger.
- [x] Validate the contract and all six package artifacts after the upstream merge.
- [ ] Complete exact-candidate package-contract, E2E-support, and package-owned aggregates.
- [ ] Run all six no-messaging public lifecycle journeys on macOS and Brev.
- [ ] Record exact package identity, Fabric result, restart, redaction, and cleanup evidence.
- [ ] Commit the final local qualification record and leave the fork remote unchanged.
