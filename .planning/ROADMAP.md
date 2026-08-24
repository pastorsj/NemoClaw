<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Roadmap: NemoClaw Agent Runtime Package Migration

## Overview

The roadmap first records the supported scope and freezes current behavior. It then creates the package contract and registers the current integrations without changing their execution paths. Deep Agents Code and managed Hermes become the two real contract consumers before Contract V1 freezes, followed by OpenClaw extraction. Phase 8 qualifies a complete first-party in-tree release and becomes the rollback point. Only then may a separate maintainer decision convert packages to external integrations and authorize repository handoff and independent compatibility checks. An ordinary reviewed release-set change remains the only way to change supported package identities.

## Current Execution

The branch already contains the in-tree packages, `nemoclaw harness` commands, package discovery,
receipts, and package-owned runtime files described by several earlier phases. Phase 11 is the
active GSD execution list for the current local implementation. The detailed plans for Phases 1-10
remain as design history; they do not replace the Phase 11 completion tracker.

- [x] **Phase 11: Package Workflow** - Give all three packages one responsibility-based structure,
  add the fixed configuration command, remove the proven core dispatch, and qualify one
  no-messaging live journey.

Plan: `.planning/phases/11-package-workflow/11-01-PLAN.md`

## Delivery Gates

| Gate | Phase | Decision or evidence required | Failure behavior |
|---|---:|---|---|
| Supported scope | 1 | Pre-acceptance characterization and inventory evidence, followed by maintainer acceptance, placement, ownership, and validation plan | Stop before Phase 2 or package work |
| Foundation | 3 | Data-only host installation, unchanged current integration registration, and current-runtime regression evidence | Keep current runtime integrations authoritative |
| Contract V1 | 6 | Deep Agents Code and managed Hermes pass the common contract and fault matrix over the existing NemoClaw and OpenShell lifecycle | Revise the contract before OpenClaw moves |
| In-tree release | 8 | Exact package, platform, lifecycle, operating-system, architecture, and Brev evidence | Roll back to the previous NemoClaw release |
| External handoff | 9 | Accepted conversion from first-party to external integrations, repositories, transport, trust, ownership, retention, revocation, and incident process | Keep the qualified first-party in-tree packages authoritative |
| Continuous updates | 10 | Required checks and review for one exact cross-project release-set change | Do not merge or ship the change; keep the last released set available for rollback |

## Phases

- [ ] **Phase 1: Scope and Behavior Baseline** - Accept the supported boundary and protect the current user journey.
- [ ] **Phase 2: Explicit Runtime Identity** - Remove `null means OpenClaw` and fail closed for unknown recorded identities.
- [ ] **Phase 3: Package and Controller Foundation** - Add the minimal contract, catalogue, installer, controller boundary, and unchanged current-integration bridge.
- [ ] **Phase 4: Deep Agents Code Pilot** - Move the terminal agent integration into the first real package.
- [ ] **Phase 5: Managed Hermes Pilot** - Move the managed agent-gateway integration and split native MCP and messaging behavior.
- [ ] **Phase 6: Contract V1 Freeze** - Reduce and secure the common contract using evidence from two different consumers.
- [ ] **Phase 7: OpenClaw Extraction** - Move the default runtime, plugin, and native integration into its package.
- [ ] **Phase 8: In-Tree Release Qualification** - Prove the complete package architecture before repository handoff.
- [ ] **Phase 9: External Repository Handoff** - Publish and consume unchanged packages from independent repositories.
- [ ] **Phase 10: Transition Cleanup and Continuous Compatibility** - Remove expired migration code and gate ongoing updates.
- [x] **Phase 11: Package Workflow** - Organize the three in-tree packages and qualify the common workflow.

## Phase Details

### Phase 1: Scope and Behavior Baseline
**Goal**: Maintainers can accept the exact supported surface, ownership, security boundary, and validation plan against a test-protected behavior baseline.
**Depends on**: Nothing
**Requirements**: [GOV-01, GOV-02, UX-01, UX-02, TEST-01]
**Success Criteria**:
  1. The accepted decision records placement, accountable ownership, compatibility, security, lifecycle, and validation requirements.
  2. Automated tests protect current menu, defaults, aliases, commands, prompts, and persisted state for all three standard runtimes.
  3. Every audited extraction candidate has a `move`, `split`, `keep`, or `delete` disposition.
  4. The decision reconciles Discussion 9909 and its review comments, pins the supported OpenShell release and capability cohort, and inventories every `RuntimeProviderBundle` facet.
  5. No supported implementation begins before the product gate passes.
**Plans**: 4 plans

Plans:
- [x] 01-01-PLAN.md - Reconcile the proposal into decision-ready architecture choices.
- [x] 01-02-PLAN.md - Capture the compatibility and persisted-state baseline.
- [x] 01-03-PLAN.md - Complete the extraction disposition ledger.
- [ ] 01-04-PLAN.md - Record ownership, threat boundaries, validation, and maintainer acceptance.

### Phase 2: Explicit Runtime Identity
**Goal**: Every active and persisted path carries an explicit runtime identity while legacy OpenClaw records remain resumable.
**Depends on**: Phase 1
**Requirements**: [UX-03, STATE-01]
**Success Criteria**:
  1. OpenClaw selection returns an explicit agent definition instead of `null`.
  2. New session and registry writes record `openclaw` explicitly.
  3. Legacy `null` state migrates to OpenClaw without changing the onboarding experience.
  4. An unknown recorded identity stops with remediation and never selects another runtime.
**Plans**: 3 plans

Plans:
- [ ] 02-01-PLAN.md - Make selection and runtime lookup explicit.
- [ ] 02-02-PLAN.md - Migrate session and registry identity without losing legacy OpenClaw resume behavior.
- [ ] 02-03-PLAN.md - Collapse OpenClaw and non-OpenClaw onboarding branches.

### Phase 3: Package and Controller Foundation
**Goal**: The minimal package foundation installs and validates static packages while all three standard runtimes remain registered and behavior-compatible on their current execution paths.
**Depends on**: Phase 2
**Requirements**: [PKG-01, PKG-02, PKG-03, PKG-04, PKG-05, PKG-06, PKG-07, CLI-01, CLI-02, SEC-01, SEC-02, SEC-03, CTL-01, CTL-03, STATE-02]
**Success Criteria**:
  1. Unique npm package identities, workspaces, clean builds, and explicit shipped-content tests establish deterministic package boundaries.
  2. NemoClaw validates and lists data-only packages without executing their code on the host.
  3. The release set preserves standard labels, order, aliases, OpenClaw default selection, exact OpenShell capability cohort, immutable qualification evidence, and reviewed support status.
  4. The unused negotiation path rejects malformed, replayed, oversized, credential-bearing, downgraded, or identity-mismatched frames.
  5. Existing no-messaging OpenClaw, Hermes, and Deep Agents Code journeys pass through the current execution adapters after catalogue registration.
  6. Registry and rebuild operations bind exact static package and image identities without adding another lifecycle state machine.
**Plans**: 8 plans

Plans:
- [ ] 03-08-PLAN.md - Prepare unique npm workspace identities and deterministic package contents before contract implementation.
- [ ] 03-01-PLAN.md - Define descriptor and controller schemas with hostile fixtures.
- [ ] 03-02-PLAN.md - Implement the standard release set and package catalogue.
- [ ] 03-03-PLAN.md - Implement the content-addressed package store and exact receipts.
- [ ] 03-04-PLAN.md - Add `nemoclaw harness install` and `nemoclaw harness list`.
- [ ] 03-05-PLAN.md - Implement the fixed controller client and hostile-output handling.
- [ ] 03-06-PLAN.md - Converge the existing OpenShell transport and link exact package receipts into current state.
- [ ] 03-07-PLAN.md - Qualify the foundation against the existing three runtime journeys.

### Phase 4: Deep Agents Code Pilot
**Goal**: LangChain Deep Agents Code runs from a self-contained package with no runtime-native executable integration in core.
**Depends on**: Phase 3
**Requirements**: [DCO-01, DCO-02, TEST-02]
**Success Criteria**:
  1. The package builds and tests after being copied outside this repository.
  2. Terminal sessions, inference, MCP, activity observation, auto-approval, state, and rebuild match the baseline.
  3. NemoClaw retains product intent, routes, transactions, and rollback decisions; OpenShell retains effective policy, credential, sandbox-state, and admitted-entrypoint authority.
  4. The existing Deep Agents Code session cleanup wrapper moves unchanged as package-internal compatibility debt until a later exact OpenShell pin proves parity.
  5. The old Deep Agents Code host execution branches are removed after parity passes.
**Plans**: 4 plans

Plans:
- [ ] 04-01-PLAN.md - Create the self-contained Deep Agents Code package source.
- [ ] 04-02-PLAN.md - Implement its native controller, declared entry, and terminal integration.
- [ ] 04-03-PLAN.md - Move native MCP, activity, state, and rebuild behavior.
- [ ] 04-04-PLAN.md - Transfer tests, cut core over, and qualify parity.

### Phase 5: Managed Hermes Pilot
**Goal**: NemoClaw-managed Hermes uses the common package contract over the existing NemoClaw and OpenShell lifecycle. NemoClaw retains product intent, ports, transactions, and rollback decisions. OpenShell retains its enforcement and lifecycle authorities.
**Depends on**: Phase 4
**Requirements**: [HER-01, HER-02, MCP-01, MSG-01, MSG-02]
**Success Criteria**:
  1. The managed Hermes package builds and tests outside this repository without portable-mode or tool-broker code.
  2. Native configuration, startup declarations, cron, recovery, MCP and messaging rendering, data-only health declarations, and state live in the package; trusted core hooks execute and interpret dashboard, API, status, and health probes.
  3. Hermes-specific dashboard, API, port, and volume behavior stays narrow until another package proves a common core surface.
  4. The existing Hermes descendant repair loop remains package-internal compatibility debt until a later exact OpenShell pin proves parity.
  5. Deterministic messaging tests pass without live service credentials.
  6. Full no-messaging lifecycle E2E matches the baseline.
**Plans**: 5 plans

Plans:
- [ ] 05-01-PLAN.md - Establish the managed-only Hermes package boundary.
- [ ] 05-02-PLAN.md - Implement startup, configuration, health, state, and recovery.
- [ ] 05-03-PLAN.md - Move native MCP and messaging translation.
- [ ] 05-04-PLAN.md - Preserve managed Hermes dashboard, API, port, and volume parity without a premature shared abstraction.
- [ ] 05-05-PLAN.md - Transfer tests, cut core over, and qualify parity.

### Phase 6: Contract V1 Freeze
**Goal**: Contract V1 contains only behavior proven by both pilot packages and rejects runtime-native dispatch in core.
**Depends on**: Phase 5
**Requirements**: [CTL-02, CTL-04, SEC-04, CTL-05, TEST-03, CORE-01, CORE-03]
**Success Criteria**:
  1. Deep Agents Code and managed Hermes pass the same contract and fault matrix over the existing NemoClaw and OpenShell lifecycle.
  2. Single-consumer abstractions are removed from the public contract or remain package-internal.
  3. Versioned schemas, errors, compatibility rules, and the two shared mutation operations are frozen with hostile conformance evidence; existing state transactions remain their owners.
  4. Repository checks reject Deep Agents Code and Hermes executable dispatch in runtime-neutral core directories.
  5. The frozen design reuses one package catalogue, the production NemoClaw and OpenShell lifecycle, one OpenShell client, existing state readers, and one E2E registry; every shared abstraction has both pilot consumers and replaces a named old path.
**Plans**: 3 plans

Plans:
- [ ] 06-01-PLAN.md - Audit pilot evidence and reduce the shared contract.
- [ ] 06-02-PLAN.md - Freeze schemas, compatibility, errors, and the package template.
- [ ] 06-03-PLAN.md - Harden conformance, security, and core boundary checks.

### Phase 7: OpenClaw Extraction
**Goal**: OpenClaw runs entirely from its self-contained package while remaining the unchanged default experience.
**Depends on**: Phase 6
**Requirements**: [OCL-01, OCL-02, OCL-03, CORE-02]
**Success Criteria**:
  1. Core no longer imports shared implementation from the OpenClaw plugin tree.
  2. OpenClaw build, startup declarations, configuration, policy, plugin, native pairing and state translation, MCP and messaging rendering, data-only probes, and inference translation reside in its package; product authorization and probe interpretation remain core-owned.
  3. NemoClaw retains pairing approval, Shields product rules, ports, product-state transactions, and independent observation; OpenShell retains effective policy, credentials, sandbox state, and admitted-entrypoint authority; the existing OpenClaw descendant repair loop remains package-internal compatibility debt until a later exact pin proves parity.
  4. OpenClaw remains the release-set default and passes baseline onboarding and complete lifecycle parity.
**Plans**: 8 plans

Plans:
- [ ] 07-01-PLAN.md - Move shared `.cts` boundaries into core.
- [ ] 07-02-PLAN.md - Create the self-contained OpenClaw image and runtime source.
- [ ] 07-03-PLAN.md - Relocate and rebuild the NemoClaw OpenClaw plugin.
- [ ] 07-04-PLAN.md - Implement OpenClaw native controller operations and the declared process entry.
- [ ] 07-05-PLAN.md - Move pairing, state, and Shields-native translation.
- [ ] 07-06-PLAN.md - Move MCP, messaging, and inference-native translation.
- [ ] 07-07-PLAN.md - Cut the default onboarding and managed-startup paths over.
- [ ] 07-08-PLAN.md - Transfer tests and qualify complete OpenClaw parity.

### Phase 8: In-Tree Release Qualification
**Goal**: NemoClaw can release all three packages from `packages/` with exact receipts and no user-visible regression.
**Depends on**: Phase 7
**Requirements**: [REL-01, REL-02, REL-03, STATE-03, TEST-04, TEST-05]
**Success Criteria**:
  1. Each package builds and tests independently on every required platform and architecture.
  2. The installer and packed npm artifact register standard packages while preserving compatibility executables.
  3. Previous-release state upgrades and failed replacements preserve the previous exact sandbox authority.
  4. Static revoked and superseded release-set fixtures preserve immutable qualification evidence, block affected new mutations, and never silently replace a running workload.
  5. All three packages pass the central no-messaging lifecycle journey.
  6. The real Apple silicon macOS OpenClaw journey on Docker Desktop or Colima, protected staging Brev default-OpenClaw journey, and six exact runtime-by-architecture image-startup cells qualify the in-tree release as the externalization rollback point.
**Plans**: 5 plans

Plans:
- [ ] 08-01-PLAN.md - Enforce package independence and test ownership.
- [ ] 08-02-PLAN.md - Build exact in-tree package and image artifacts.
- [ ] 08-03-PLAN.md - Update npm distribution, installer, and standard registration.
- [ ] 08-04-PLAN.md - Prove upgrade, interruption, retention, and rollback.
- [ ] 08-05-PLAN.md - Run platform, multi-architecture, lifecycle, and Brev qualification.

### Phase 9: External Repository Handoff
**Goal**: Independently owned repositories publish unchanged packages that a NemoClaw release set pins and qualifies exactly.
**Depends on**: Phase 8
**Requirements**: [DIST-01, DIST-02, DIST-03, DIST-04, DIST-05]
**Success Criteria**:
  1. Maintainers explicitly accept converting the three first-party packages to external integrations and accept source, trust, ownership, retention, revocation, and rollback policy.
  2. Each package repository preserves the canonical Phase 8 package-tree digest and publishes exact descriptors, helpers, tests, images, and conformance evidence.
  3. NemoClaw fetches and verifies exact external artifacts proposed by a release-set pull request without making them active in a released build.
  4. Required central qualification and maintainer review gate the ordinary release-set change.
  5. A failed external fetch, verification, or qualification preserves the in-tree or last-qualified tuple.
**Plans**: 6 plans

Plans:
- [ ] 09-01-PLAN.md - Accept external source, trust, retention, and incident policy.
- [ ] 09-02-PLAN.md - Establish the independent package repository contract.
- [ ] 09-03-PLAN.md - Hand off Deep Agents Code without contract changes.
- [ ] 09-04-PLAN.md - Hand off managed Hermes without contract changes.
- [ ] 09-05-PLAN.md - Hand off OpenClaw and its plugin without contract changes.
- [ ] 09-06-PLAN.md - Switch the standard release set to exact external artifacts.

### Phase 10: Transition Cleanup and Continuous Compatibility
**Goal**: Core contains only generic authority, bounded migration readers, release data, and central qualification while updates fail closed against compatibility drift.
**Depends on**: Phase 9
**Requirements**: [COMP-01, COMP-02, COMP-03]
**Success Criteria**:
  1. Expired `_legacy_paths`, closed runtime unions, repository-root build assumptions, duplicate tests, and runtime-name execution switches are removed.
  2. Remaining runtime-name references are classified as release data, bounded migration code, qualification fixtures, or defects.
  3. Compatibility CI covers NemoClaw, OpenShell, agent runtime, inference-provider, and messaging-render changes before a release-set pull request can merge or ship.
  4. Failed update or revocation checks block the change, retain the last released exact package as the rollback tuple, and produce redacted evidence.
**Plans**: 4 plans

Plans:
- [ ] 10-01-PLAN.md - Complete bounded registry and snapshot migration.
- [ ] 10-02-PLAN.md - Remove expired transition code and enforce core boundaries.
- [ ] 10-03-PLAN.md - Add continuous compatibility gates for reviewed release-set changes.
- [ ] 10-04-PLAN.md - Prove final architecture, rollback, and supported operator behavior.

### Phase 11: Package Workflow
**Goal**: OpenClaw, Hermes, and LangChain Deep Agents Code use one readable in-tree package workflow while the existing onboarding experience remains unchanged.
**Depends on**: Nothing
**Requirements**: []
**Success Criteria**:
  1. The three packages use the same root authoring template and responsibility directories where their integrations have matching work.
  2. Managed startup invokes one fixed package-owned configuration command without selecting its implementation by agent ID.
  3. Package entry points show the startup workflow and keep cohesive implementation in named package-owned modules.
  4. Package contracts, integration tests, type-checks, repository checks, and one live no-messaging OpenClaw lifecycle pass.
  5. The package authoring guide states the remaining closed core integration points and the steps to add another in-tree agent runtime.
**Plans**: 1 plan

Plans:
- [x] 11-01-PLAN.md - Organize and qualify the in-tree agent runtime package workflow.

## Progress

| Phase | Plans Complete | Status | Completed |
|---|---:|---|---|
| 1. Scope and Behavior Baseline | 3/4 | In Progress | - |
| 2. Explicit Runtime Identity | 0/3 | Not started | - |
| 3. Package and Controller Foundation | 0/8 | Not started | - |
| 4. Deep Agents Code Pilot | 0/4 | Not started | - |
| 5. Managed Hermes Pilot | 0/5 | Not started | - |
| 6. Contract V1 Freeze | 0/3 | Not started | - |
| 7. OpenClaw Extraction | 0/8 | Not started | - |
| 8. In-Tree Release Qualification | 0/5 | Not started | - |
| 9. External Repository Handoff | 0/6 | Not started | - |
| 10. Transition Cleanup and Continuous Compatibility | 0/4 | Not started | - |
| 11. Package Workflow | 1/1 | Complete | 2026-08-24 |

---
*Roadmap created: 2026-08-21*
