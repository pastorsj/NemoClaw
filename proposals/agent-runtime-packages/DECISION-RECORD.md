<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Runtime Package Decision Record

Status: Pending

This file is a decision packet and later transcription target. It is not the authoritative product
decision. An authorized maintainer must publish the decision in an NVIDIA/NemoClaw repository-owned
record.

## Revision binding

- Proposal revision: `e8e89ffd05a696e7476325c331d4e050a4264353` — signed commit under review. This
  revision contains this decision packet, `README.md`, `TECHNICAL-PLAN.md`,
  `RFC-RECONCILIATION.md`, the three candidate ledgers, `DISPOSITION-LEDGER.md`, and
  `ARCHITECTURE-BASELINE.json`.
- Repository source baseline: `a5486894c45140259d822625e74d1ccdfce807ee`.
- Architecture baseline SHA-256:
  `ff4c0177cbc6fa69d800a39de403925ab28c57b921c3a18ebfa40e515e7dd6fd`.
- Disposition ledger SHA-256:
  `30d094b7c8fa47960a494f86e9ef2f6902365f83f665301d79a2ac197a1c59de`.
- Accepted repository record: None. Discussion 9909 remains Proposed and has no accepted answer.

## Proposed decision

- Decision: Pending; available outcomes are Accept, Request changes, Defer, or Decline.
- Placement: Proposed — `packages/` in the NemoClaw repository for the first qualified release.
- Reason and placement: Proposed — move the three current integrations first into self-contained
  package roots under `packages/` without changing user behavior; qualify the complete in-tree
  release before any external repository handoff.
- Accountable maintainer: Unassigned — blocking.
- Validation plan: Proposed — [VALIDATION-PLAN.md](VALIDATION-PLAN.md).
- Ownership: Proposed with blocking assignments — [OWNERSHIP.md](OWNERSHIP.md).
- Threat model: [OWNERSHIP.md](OWNERSHIP.md#trust-boundaries) and the per-phase threat registers.

## Proposed supported surface

- Public commands: `nemoclaw harness install <local-artifact>` and `nemoclaw harness list`.
- Compatibility commands: existing `nemoclaw agents list`, `nemoclaw onboard`, flags, environment
  variables, aliases, `nemohermes`, and `nemo-deepagents` remain available.
- Descriptor namespace: proposed `nvidia.nemoclaw`; maintainer acceptance is required.
- Standard package IDs: proposed `nvidia.nemoclaw.openclaw`, `nvidia.nemoclaw.hermes`, and
  `nvidia.nemoclaw.langchain-deepagents-code`; maintainer acceptance is required.
- npm package names and publication state: unassigned — blocking before workspace conversion.
- Standard menu: OpenClaw, Hermes, and LangChain Deep Agents Code in the characterized order;
  OpenClaw remains default.
- Local compatible artifacts: list-only; package metadata cannot make one normally selectable.
- Support authority: a checked-in release-set entry with core-owned `supported`, `revoked`, or
  `superseded` status. Status changes use normal reviewed NemoClaw changes and releases.

## Proposed authority and compatibility decision

- NemoClaw retains product workflow, catalogue, plan compilation, required-policy compilation,
  logical provider selection, host routes and ports, product-state linkage, rollback, and central
  qualification.
- OpenShell retains sandbox lifecycle and durable state, compute, effective policy, provider and
  credential custody and rewrite, inference interception, sandbox execution, and the admitted image
  entrypoint. The accepted decision must explicitly allow the current Deep Agents Code session
  cleanup wrapper and OpenClaw and Hermes descendant repair loops under `0.0.106` or instead block
  their cutovers on a later pin with full parity.
- Packages retain bounded runtime-native configuration and reconciliation inside the
  sandbox. The host loads no package callback.
- Every package-helper invocation is mutation-capable in V1. Trusted descriptor probes provide
  read-only product observations unless a later exact OpenShell cohort qualifies a named
  operation-specific restriction.
- OpenShell release: exact `0.0.106` at this source baseline.
- Capability, driver, and platform cohort: proposed in
  [RFC-RECONCILIATION.md](RFC-RECONCILIATION.md#6-exact-openshell-and-platform-baseline).
- `RuntimeProviderBundle` dispositions: proposed in
  [RFC-RECONCILIATION.md](RFC-RECONCILIATION.md#7-runtimeproviderbundle-facet-dispositions).
- Compatibility promise: the in-tree migration preserves the characterized onboarding and
  lifecycle result. Unknown persisted identity fails closed; legacy `null` OpenClaw reads remain
  compatible until their bounded reader is retired.
- Lifecycle and retention: packages do not own sandbox or process lifecycle. Package availability,
  sandbox deletion, snapshot retention, durable-state deletion, and artifact retention remain
  separate decisions. Existing sandboxes are never silently replaced after revocation.

## RFC and review disposition

The exact proposed alignments, requested divergence for the public `harness` spelling, later
external-repository decision, repository-member review requests, and second-review trust questions
are recorded in [RFC-RECONCILIATION.md](RFC-RECONCILIATION.md). Acceptance must bind the complete
proposal revision rather than treating an individual aligned row as approval.

## Unresolved blockers

- The repository-owned decision is not Accept.
- The accountable maintainer and every accountable operating owner are unassigned.
- The descriptor namespace, standard package IDs, npm package names, and publication status are not
  accepted.
- The validation owner, Brev cost authority, artifact retention policy, incident response, and
  external handoff authority are unassigned.

## Acceptance transcription fields

These fields stay empty until an authorized maintainer publishes a complete external record:

- Status: Pending
- Proposal revision:
- Reason and placement:
- Accountable maintainer:
- Decision date:
- Validation plan:
- Accepted repository record:
