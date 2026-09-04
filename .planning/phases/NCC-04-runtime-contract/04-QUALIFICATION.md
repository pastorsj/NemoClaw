---
phase: NCC-04-runtime-contract
status: active
evidence_scope: local-prototype
product_scope: not-accepted
release_qualification: not-claimed
last_updated: 2026-09-04
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 4 Local Prototype Qualification

This record qualifies neither a NemoClaw release nor a supported external package interface. It
tracks evidence for a local architecture candidate at commit `5a8253a97a`, whose principal typed
adapter implementation is `f3fe6928c2`.

## Decision Gate

The accepted Phase 2 decision covers the data, sandbox, and image package foundation. It does not
accept package-authored host code as a supported extension boundary. The current product-scope
status is therefore `not-accepted`. Before this design becomes canonical or further implementation
creates a supported surface, a decision record must have status `Accept` and name the reason,
placement, accountable maintainer, trust and compatibility policy, and validation plan.

## Architecture Claim Under Test

NemoClaw core can compose a receipt-pinned agent runtime package through finite typed operations
without selecting native MCP, configuration, or restore behavior by agent runtime identity. The
package returns bounded data or commands. Core keeps credentials, policy, OpenShell access, state,
transactions, verification, rollback, platform, runtime-provider, hardware, and serving-runtime
authority. NeMo Fabric remains a separate sandbox-local headless request path selected by package
data.

The current evidence supports this claim for the implemented operations. It does not support the
broader claim that all agent-runtime behavior has left core.

## Deterministic Evidence

| Evidence | Recorded outcome | Gate status |
| --- | --- | --- |
| Loader, schemas, receipt drift, negative fixtures | Focused adapter tests passed | Pass |
| Unknown package conformance | MCP, configuration, and restore use fixed operations without a production catalogue row | Pass |
| Compiled package artifact | 9 package-contract tests passed | Pass |
| Core focused behavior | CLI 271; integration 101 with 4 skipped; execution 48; MCP 22; registry 62 | Pass |
| OpenClaw | Package 581/1 skip; composed 1,117/16 skip; plugin 1,072; Fabric 29/2 skip | Pass for recorded revision |
| Hermes | Package 303/72 skip plus Python 5; composed 519/53 skip; serialized subprocess 92 | Pass for recorded revision |
| LangChain Deep Agents Code | Package 399/25 skip; composed 476/41 skip; Fabric 11 | Pass for recorded revision |
| Pi | Package 18; composition 3; Fabric 20/2 skip | Pass for recorded revision |
| Static ownership | Layer boundaries, source graph, project membership, builds, type checks, format, and lint passed | Pass for recorded revision |
| Full E2E support | Earlier run had 13 failures in 6 files; fixes address at least 8, final rerun absent | Open |
| Repository checks | Stale Pi image receipt after reviewed runtime bundle changed | Blocked on new image evidence |

Recorded package counts are development evidence from the implementation cycle. They are not a
substitute for the final aggregate rerun on the exact candidate.

## Test Ownership Change

Two existing source test files moved into the OpenClaw package:

- `src/lib/state/openclaw-config-merge.test.ts` became
  `packages/nemoclaw-openclaw/tests/host/config-merge.test.ts`.
- `src/lib/state/openclaw-config-merge-tool-search.test.ts` became
  `packages/nemoclaw-openclaw/tests/host/tool-merge.test.ts`.

They contain 28 test declarations and 43 parameterized cases. Hermes, LangChain Deep Agents Code,
and Pi gained package-local adapter tests but did not receive an existing moved file in this slice.
Generic security, transaction, receipt, rollback, and composition assertions remain in core.

## Live Evidence

| Environment and target | Identity | Result | Cleanup |
| --- | --- | --- | --- |
| macOS full E2E, first attempt | Local candidate before E2E fixture correction | Homebrew OpenShell service registered but never ran; sandbox creation did not begin | No gateway, sandbox, or owned process remained |
| macOS isolated gateway, malformed endpoint attempt | `5a8253a97a` candidate | Gateway and package install passed; endpoint supplied as `/chat/completions` instead of a base URL, so onboarding stopped before sandbox creation | Gateway stopped; no sandbox created |
| macOS isolated gateway, normalized endpoint attempt | `5a8253a97a` candidate | SSRF preflight correctly refused a hostname resolving to a private corporate address without explicit trust; no Fabric phase ran | Sandbox absent; cleanup missed one test-owned gateway, which was stopped explicitly and port 18290 was verified free |
| Brev/Linux Hermes Fabric | Exact tracked tree for `5a8253a97a` | Local ARM64 image built; managed recovery rejected Hermes path variables absent from the supervisor's initial environment; no Fabric phase ran | Fixture, sandbox, and isolated gateway cleanup passed |
| Brev/Linux Deep Agents Code Fabric | Exact tracked tree for `5a8253a97a` | Pending | Pending |
| Brev/Linux MCP: OpenClaw, Hermes, Deep Agents Code | Exact tracked tree for `5a8253a97a` | Pending | Pending |
| Pi live candidate | No new immutable image receipt | Not run and not qualified | Not applicable |

The macOS results separate three host configuration issues: a Homebrew service failure, an endpoint
shape error, and missing explicit trust for corporate private DNS. The Brev result identifies a
managed lifecycle boundary mismatch that deterministic package tests did not model. None is a
successful Fabric result. Messaging services are outside the selected matrix.

## Image Evidence

Package receipts and managed-image receipts prove different facts. The package receipt binds the
locally installed source tree. Stock live E2E additionally requires one complete immutable image
cohort for the same revision and workflow attempt across every shipped package and both Linux
architectures.

The candidate changes the reviewed managed-startup runtime bundle. Existing Pi receipts bind older
source bytes. Until new exact image evidence exists, repository checks remain correctly blocked,
stock live results cannot qualify this candidate, and Pi cannot inherit a cohort that excludes Pi.

## Qualification Conclusion

Status remains `active`.

- The finite typed MCP, configuration, and restore boundary has strong deterministic local
  evidence.
- Plans 04-01 and 04-02 are executed as local-prototype slices.
- Plans 04-03, 04-04, and 04-05 remain active.
- Product acceptance, final aggregate evidence, managed-image publication, and successful bounded
  live evidence are missing.
- Release qualification and full agent-runtime independence are not claimed.
