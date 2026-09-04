---
phase: NCC-04-runtime-contract
plan: 05
subsystem: qualification-and-handoff
status: active
evidence_scope: local-prototype
product_scope: not-accepted
release_qualification: not-claimed
tags: [qualification, macos, brev, handoff, migration]
requires: [04-04]
provides:
  - Consolidated deterministic evidence for the local candidate
  - Explicit live, image, product, and remaining-migration gates
requirements-completed: []
last_updated: 2026-09-04
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 4 Plan 5: Qualification and Handoff Progress Summary

The typed MCP, configuration, and OpenClaw restore implementation has substantial deterministic
evidence. Final deterministic, image, macOS, and Brev gates are still open. This plan therefore
records progress and the exact remaining work; it does not claim completion.

## Implemented Scope

- MCP-capable packages return native plans through `host/mcp-adapter.cts`; Pi returns a typed
  capability refusal.
- All four packages implement `host/config-adapter.cts`; LangChain Deep Agents Code and Pi report
  immutable runtime configuration.
- OpenClaw implements receipt-pinned restore merge grammar through
  `host/restore-adapter.cts`.
- Core retains identity, credentials, SSRF validation, policy, OpenShell execution, transaction
  order, state, verification, restart coordination, rollback, and redacted diagnostics.
- Fabric remains a distinct package-selected headless data path.

The principal implementation is commit `f3fe6928c2` with E2E fixture corrections in
`4db4dfcd39` and `5a8253a97a`. The principal commit changed 148 files with 11,032 insertions and
1,580 deletions. Classified by responsibility, it added 4,585 and deleted 522 implementation
lines; added 4,817 and deleted 251 test lines; and added 1,630 and deleted 807 planning or guide
lines. It also changed one reviewed binary runtime bundle.

## Recorded Deterministic Evidence

| Boundary | Result |
| --- | --- |
| Focused CLI | 31 files, 271 tests passed |
| Focused integration | 3 files, 101 passed, 4 skipped |
| Compiled package contract | 9 passed |
| Execution behavior | 48 passed |
| Focused MCP behavior | 22 passed |
| Registry behavior | 62 passed |
| OpenClaw | Package 581/1 skip; composed 1,117/16 skip; plugin 1,072; Fabric 29/2 skip |
| Hermes | Package 303/72 skip plus Python 5; composed 519/53 skip; serialized subprocess 92 |
| LangChain Deep Agents Code | Package 399/25 skip; composed 476/41 skip; Fabric 11 |
| Pi | Package 18; composition 3; Fabric 20/2 skip |
| Static checks | Builds, type checks, layer boundaries, source graph, project membership, formatting, and linters passed |

The full E2E-support lane previously reported 13 failures in 6 files on the branch baseline. The
explicit credential correction resolves at least 8 failures in two files, but a complete rerun on
the final candidate is still required. The repository check remains blocked by stale Pi managed
image evidence after the shared runtime bundle changed.

## Live Evidence Status

Three macOS attempts reached progressively later boundaries without producing a live contract
pass. The first stopped at the unhealthy account-scoped Homebrew gateway. The second proved the
standalone gateway and package install, then exposed that the supplied endpoint was a completion
URL rather than a base URL. The third used the normalized base URL, but NemoClaw correctly refused
the endpoint because its hostname resolves to a private corporate address and no explicit private
host trust was supplied. The third cleanup also exposed a fixture defect: an absent-sandbox destroy
started a gateway that registration cleanup did not stop. The exact test-owned process was stopped
and its port was verified free.

The first Brev/Linux Hermes attempt built the local ARM64 image and reached managed startup. Its
authenticated recovery helper then rejected the managed Hermes path variables because it validates
the supervisor's initial process environment while those values are applied by the managed startup
handoff. Sandbox, fixture, and isolated gateway cleanup completed. This is actionable lifecycle
evidence, not a Fabric or contract pass. No live MCP, Fabric, Deep Agents Code, Hermes, OpenClaw, or
Pi success is claimed here. Live messaging remains excluded.

## Remaining Core Seams

The repository is not agent-runtime agnostic while these native seams remain:

- No-receipt MCP and runtime-configuration compatibility, including
  `mcp-bridge/legacy-mutation.ts`, legacy branches in `mcp-bridge-adapters.ts`, and Deep Agents
  legacy configuration.
- Remaining restore strategies and native CLI grammar.
- The closed `MANAGED_STARTUP_AGENTS` set, profile and image selection, environment projection,
  and startup coordinator.
- Pairing and messaging projection, including the one core-to-OpenClaw build-time import
  exception.
- Gateway, dashboard, Hermes auth and tool gateways, and agent policy compatibility.
- Update, branding, sessions, skills, cron, voice, diagnostics, backup, and recovery behavior.
- Root build-context assets and missing package-owned Pi archive proof.
- The 2,320-line OpenClaw plugin blueprint runner.

Each later slice must name one current consumer, prefer manifest data or a fixed sandbox command,
add a typed operation only when core must coordinate a protected transaction, move native tests
with native code, and delete the receipt-backed core fallback in the same change.

## Gates Still Required

1. Obtain an `Accept` product decision before treating package-authored host code as canonical or
   continuing implementation of a supported surface.
2. Rerun the complete deterministic and E2E-support gates on the final candidate.
3. Publish or otherwise provide exact development image evidence for the changed image inputs;
   publish a complete immutable cohort before stock release qualification.
4. Complete the bounded macOS and Brev non-messaging targets, record redaction and cleanup, and
   classify any infrastructure failure without broad reruns.
5. Close Plan 04-03 package-independence gaps and Plan 04-04 image evidence before marking this
   plan or phase complete.
