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
tracks evidence for implementation candidate `461e30e5d45aa97d58cfd9ce451f33b0c17f0f50`.
The principal typed adapter implementation is `f3fe6928c2`; later commits extend generic
composition and qualification.

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

The ordinary in-tree path also discovers an unknown package from authoring metadata, materializes
its artifact, installs its receipt, selects its Dockerfile, startup command, and Fabric command,
and constructs the private standard-input handoff. This path does not enable generic managed
startup, buildless onboarding, or external package download.

## Deterministic Evidence

| Evidence | Recorded outcome | Gate status |
| --- | --- | --- |
| Loader, schemas, receipt drift, negative fixtures | Focused adapter tests passed | Pass |
| Unknown package conformance | MCP, configuration, and restore use fixed operations without a production catalogue row | Pass |
| Unknown package composition | Discovery, materialization, alias install, receipt, onboarding, Dockerfile and Fabric command selection, startup persistence, private standard-input handoff, and typed MCP refusal passed 1/1 | Pass |
| Compiled package artifact | 14 package-contract tests passed | Pass |
| Core focused behavior | CLI 271; integration 101 with 4 skipped; execution 48; MCP 22; registry 62 | Pass |
| OpenClaw | Package 581/1 skip; composed 1,117/16 skip; plugin 1,074; Fabric 29/2 skip | Pass for recorded revision |
| Hermes | Package 314/72 skip plus Python 5; composed 502/53 skip; serialized subprocess 92; Fabric 12/1 skip | Pass for recorded revision |
| LangChain Deep Agents Code | Package 399/25 skip; composed 476/41 skip; Fabric 11 | Pass for recorded revision |
| Pi | Package 18; composition 3; Fabric 20/2 skip | Pass for recorded revision |
| Static ownership | CLI typecheck; original live ratchet retained at 1,955 direct expects, 3,023 direct assertion points, and 4,621 unique points; 45/45 growth guard; project membership for 2,476 candidates across 7 projects | Pass for recorded revision |
| Full E2E support | 265 files passed and 4 skipped; 3,874 tests passed and 39 skipped | Pass |
| Broad root aggregate | No passing broad root result is recorded for `461e30e5d45aa97d58cfd9ce451f33b0c17f0f50` | Open |
| Repository checks | Stale Pi image receipt after reviewed runtime bundle changed | Blocked on new image evidence |

Recorded package counts are development evidence from the implementation cycle. They are not a
substitute for a passing broad root aggregate on the exact candidate.

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
| macOS unknown-package Dockerfile and Fabric path | Local candidate through `9761597cde`; package ID `contract-probe`; OpenShell 0.0.106 | Install and inventory passed. Receipt identity survived interrupted onboarding, resume, stop, and start. Fabric returned `PONG` before and after a gateway restart. | Sandbox, gateway, and test state cleanup passed. This run did not use managed startup or qualify a named package. |
| Brev/Linux unknown-package Dockerfile and Fabric path | `9761597cde`; Ubuntu 22.04 ARM64; OpenShell 0.0.106; NeMo Fabric 0.2.0; digest `0b0c21672f55db5a3b9e15f056a0c9e04091c9e200c2a8ba37ea9a608e72f3b6` | The same install, interrupted-onboard, resume, stop, start, and two-turn Fabric sequence passed. | The configured endpoint returned 403. A deterministic authenticated test endpoint proved transport and composition, not that configured service. Cleanup removed the isolated sandbox, gateway, and private home. |
| Brev/Linux Deep Agents Code Fabric | Not run on the current candidate | Pending | Pending |
| Brev/Linux MCP: OpenClaw, Hermes, Deep Agents Code | Not run on the current candidate | Pending | Pending |
| Pi live candidate | No new immutable image receipt | Not run and not qualified | Not applicable |

The earlier macOS attempts separate three host configuration issues: a Homebrew service failure,
an endpoint shape error, and missing explicit trust for corporate private DNS. The earlier Brev
Hermes result identifies a managed lifecycle boundary mismatch. The later unknown-package runs
prove only the ordinary bundled Dockerfile, terminal, and Fabric path. Messaging services are
outside the selected matrix.

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
- Plans 04-01 through 04-03 are executed as local-prototype slices.
- Plans 04-04 and 04-05 remain active.
- Product acceptance, the broad root aggregate, managed-image publication, and named-package live
  evidence are missing.
- Bounded macOS and Brev development evidence exists for the generic Dockerfile, terminal, and
  Fabric path. It does not qualify managed startup, external distribution, or a release.
- Release qualification and full agent-runtime independence are not claimed.
