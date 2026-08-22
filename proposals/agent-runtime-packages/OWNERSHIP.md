<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Runtime Package Ownership

> **Status:** Proposed. Accountable people are unassigned, so this record does not satisfy the
> product scope gate.

## How to read this record

`Accountable` means the one person answerable for the decision and operating outcome. `Responsible`
names the repository or team expected to perform the work. `Consulted` records required review.
`Incident escalation` records the first response route. GitHub `CODEOWNERS` entries route reviews;
they do not assign product accountability.

## Ownership matrix

| Surface | Accountable | Responsible | Consulted | Incident escalation | Blocking decision |
|---|---|---|---|---|---|
| Contract schemas and conformance kit | Unassigned — blocking | Proposed: NemoClaw core maintainers | Agent runtime package owners; OpenShell integration owner; security | NemoClaw maintainer and security routes | Name one contract owner and compatibility policy. |
| OpenClaw package and OpenClaw plugin | Unassigned — blocking | Proposed: OpenClaw package maintainers | Core, messaging, inference, security, release | Package owner, then security or release owner by incident type | Name the package owner and upstream response policy. |
| Managed Hermes package | Unassigned — blocking | Proposed: managed Hermes package maintainers | Core, messaging, inference, security, release | Package owner, then security or release owner by incident type | Name the managed-only owner; portable Hermes and the tool broker stay separate. |
| LangChain Deep Agents Code package | Unassigned — blocking | Proposed: Deep Agents Code package maintainers | Core, inference, terminal, security, release | Package owner, then security or release owner by incident type | Name the package owner and upstream response policy. |
| Runtime-image recipes and core build-input snapshots | Unassigned — blocking | Proposed: package owners maintain recipes; core source owners maintain authoritative inputs; release maintainers verify snapshot sync | Security; package owners; image-build and release owners | Source owner for input drift; package and release owners for image impact | Name who approves each source-to-snapshot update and resulting package requalification. |
| NemoClaw catalogue, selection, plan, and product workflow | Unassigned — blocking | Proposed: NemoClaw core maintainers | Package owners; OpenShell integration; security | NemoClaw maintainer route | Name the product owner who accepts the supported surface. |
| OpenShell client and `0.0.106` compatibility | Unassigned — blocking | Proposed: NemoClaw OpenShell integration maintainers | OpenShell owners; package owners; E2E | OpenShell integration owner, then security for authority failures | Name the compatibility owner and upgrade cadence. |
| Policy, provider, credential, and supervisor boundary | Unassigned — blocking | Proposed: NemoClaw and OpenShell security owners within their existing authorities | Package owners; inference; messaging | `@NVIDIA/nemoclaw-security` is the current review route, not the accountable person | Name the incident owner and response path. |
| Release set, support status, rollback, and release decision | Unassigned — blocking | Proposed: NemoClaw release maintainers | Product, security, package, compatibility, and E2E owners | Release owner; security owner for revocation | Name who may mark an exact tuple `supported`, `revoked`, or `superseded`. |
| Runtime and inference-provider upstream compatibility | Unassigned — blocking | Proposed: each package owner plus the core inference owner | Release, security, E2E | Owning package or inference owner | Name update frequency, supported version ranges, and response time. |
| Messaging render compatibility | Unassigned — blocking | Proposed: messaging core owner and the OpenClaw or Hermes package owner | Security; E2E | Messaging owner, then package owner | Name who owns normalized intent and each native renderer. |
| Persisted identity, state migration and compatibility, snapshots, and rebuild | Unassigned — blocking | Proposed: NemoClaw state and lifecycle maintainers | Package owners; OpenShell integration; security | State owner; release owner if rollback is required | Name migration and retention owners. |
| Package and image artifact retention | Unassigned — blocking | Proposed: release and registry maintainers | Security; package owners; legal/compliance when required | Release owner | Name retention duration, deletion authority, and rollback availability. |
| Deterministic tests, Apple silicon macOS, multi-architecture, and Brev qualification | Unassigned — blocking | Proposed: NemoClaw E2E maintainers | Package, release, OpenShell, and security owners | E2E owner; release owner for a blocked candidate | Name who accepts evidence and who authorizes Brev cost. |
| Later external repository handoff | Not assigned; outside the in-tree decision | No repository is authorized yet | Product, release, security, package, retention, and E2E owners | Future external-integration owner | Requires a separate accepted decision for each package. |

The current fallback reviewer is `@NVIDIA/nemoclaw-maintainer`; tests route to
`@NVIDIA/nemoclaw-engineer`; security-sensitive paths route to `@NVIDIA/nemoclaw-security` where
specified by `.github/CODEOWNERS`. These routes are evidence for required review only.

## Trust boundaries

| Boundary | Authority retained | Untrusted or limited input | Required control and evidence |
|---|---|---|---|
| NemoClaw host core | Product selection, plan compilation, package ingestion, state linkage, rollback, and qualification | Package metadata, archive bytes, helper output, external responses | Closed parsing, bounded storage, redaction, exact identities, and core-owned decisions. |
| OpenShell gateway, driver, and supervisor | Sandbox lifecycle and durable state, compute, effective policy, credential custody, inference interception, and every admitted entrypoint or direct execution | NemoClaw requests and package runtime behavior | One NemoClaw client boundary, exact version/capability receipt, observed lifecycle outcomes, and the three named `0.0.106` descendant-wrapper exceptions. |
| Package metadata | Describes identity, compatibility, exact images, native state, settings, services, capabilities, and required access | All descriptor fields are package claims | Data-only validation; no callback, command, support, policy, driver, or host authority. |
| Package Docker build inputs | Package owns its complete recipe; core retains authoritative ownership of any snapshotted shared source | Package-local snapshot bytes and source-to-snapshot mapping | Closed manifest of source, destination, owner, mode, and digest; no credentials or mutable state; full package and image requalification on drift. |
| Sandbox `runtime-control` helper and agent runtime | Two bounded mutation-capable native reconciliation operations in V1; package-internal behavior stays private | Helper output and self-reported postconditions | Fixed path, bounded protocol, deadline, redaction, no lifecycle or supervision, executor-claim label. |
| External inference or messaging provider | Provides the upstream service | Network responses and availability | OpenShell credential custody and policy; core-owned provider/channel intent; redacted tests. |
| Persisted NemoClaw state | Records product linkage and exact package/runtime receipts | Legacy, malformed, contradictory, or future-version records | Existing state owners normalize known legacy forms; unknown identity fails before mutation. |
| Independent evidence producer | Observes only facts available at its boundary | A relayed helper value is not independent | Record producer, method, exact subject, time, and observation limits. |
| Qualification evidence | Historical proof for one exact tuple | Passing evidence is not product approval | Immutable identity and digest; separate checked-in support status and maintainer decision. |
| Checked-in release set | Selects standard exact tuples and records support status | Package data cannot modify it | Required CI, CODEOWNERS review, maintainer acceptance, ordinary merge and release process. |
| Release evidence | Supports a release decision | Mixed commits, attempts, images, or missing cleanup | Bind source, package, image, OpenShell, platform, suite, run, attempt, redaction, and cleanup. |

## Required assignments before Phase 2 or package implementation

An accepted record must name at least one accountable maintainer for the in-tree migration and must
resolve every blocking ownership row above. One person may own more than one row, but no team alias,
CODEOWNERS route, passing test, or package publisher may substitute for the accountable person.
