<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Requirements: NemoClaw Agent Runtime Package Migration

**Defined:** 2026-08-21
**Core Value:** Existing NemoClaw users retain the same onboarding and sandbox lifecycle while runtime-native implementation leaves NemoClaw core.

## Active Requirements

### Governance and baseline

- [ ] **GOV-01**: Characterization and inventory evidence may be prepared before acceptance. Before Phase 2 or package implementation starts, a maintainer records `Accept`, reason and placement, one accountable maintainer, and the required validation plan, bound to the exact proposal revision that reconciles NVIDIA/NemoClaw Discussion 9909.
- [ ] **GOV-02**: The accepted design names owners for the contract, each standard package, security response, releases, compatibility, state migration, artifact retention, and E2E qualification.
- [ ] **UX-01**: Existing users see the same onboarding choices, order, labels, questions, defaults, and resulting sandbox behavior.
- [ ] **UX-02**: Existing `--agent`, `NEMOCLAW_AGENT`, `nemoclaw agents list`, `nemohermes`, and `nemo-deepagents` behavior remains available during migration.
- [ ] **TEST-01**: Automated characterization tests record the accepted user-visible and persisted-state baseline for all three standard agent runtimes.

### Explicit runtime identity

- [ ] **UX-03**: Existing sessions and sandbox records resume with their original runtime identity, including legacy records where `null` represented OpenClaw.
- [ ] **STATE-01**: New selection, session, and registry writes always record an explicit runtime identity, and unknown recorded identities fail closed.

### Package and controller foundation

- [ ] **PKG-01**: `packages/agent-runtime-contract` defines the shared schemas, fixtures, and conformance entrypoints used by all agent runtime packages.
- [ ] **PKG-02**: A data-only package descriptor declares exact identity, compatibility, images, services, state, settings, capabilities, and controller protocol without executable host hooks.
- [ ] **PKG-03**: A core-owned release set declares standard package versions, exact artifacts, menu order, aliases, qualification status, and OpenClaw as the default.
- [ ] **PKG-04**: NemoClaw validates and stores package artifacts through content-addressed, atomic, idempotent receipts.
- [ ] **PKG-05**: Standard packages are selectable after the normal NemoClaw install without preloading every sandbox image.
- [ ] **PKG-06**: The root CLI, OpenClaw plugin, contract, and each runtime package have unique package identities under one npm workspace graph, and clean packaging has an explicit deterministic contents contract independent of developer setup.
- [ ] **PKG-07**: The checked-in release set keeps immutable qualification evidence separate from a core-owned support status, and a reviewed NemoClaw change records revocation, supersession, effects on new and existing workloads, and the rollback tuple.
- [ ] **CLI-01**: `nemoclaw harness install <local-artifact>` validates and registers one exact package without importing or executing package code on the host.
- [ ] **CLI-02**: `nemoclaw harness list` reports standard and explicitly installed packages, while `nemoclaw agents list` delegates to the same catalogue.
- [ ] **SEC-01**: Package ingestion rejects path traversal, links, special files, excessive expansion, identity collisions, incompatible contracts, and digest mismatches.
- [ ] **SEC-02**: NemoClaw uses one core-owned OpenShell client boundary for product workflow and rollback decisions; OpenShell remains authoritative for sandbox lifecycle and durable state, compute dispatch, effective policy, provider and credential custody, inference interception, and every admitted image entrypoint or direct sandbox execution. Until a later exact pin proves parity, the existing Deep Agents Code session cleanup wrapper and OpenClaw and Hermes entrypoint loops may manage only their current package-declared descendants; they cannot call OpenShell, own sandbox lifecycle, or become `runtime-control` operations.
- [ ] **SEC-03**: Controller negotiation uses closed schemas, bounded framing, deadlines, request nonces, exact package, image, and sandbox identity binding, redaction, and fail-closed validation.
- [ ] **CTL-01**: The shared contract reserves `/opt/nemoclaw/bin/runtime-control` and defines deny-by-default protocol negotiation; each extraction phase installs the executable in its package image.
- [ ] **CTL-02**: Runtime-neutral intent covers named services, health, settings, inference, MCP, messaging, state reconciliation, and terminal or agent-gateway interaction. Contract V1 exposes only the mutation-capable `reconcile-native` and `prepare-native-state` helper operations proven by both pilots; trusted core or OpenShell code executes and interprets product health and status probes.
- [ ] **CTL-03**: The three current integrations register through one package catalogue without changing their execution paths; Deep Agents Code and managed Hermes then prove the common controller contract against the existing NemoClaw product workflow and OpenShell lifecycle before Contract V1 freezes.
- [ ] **STATE-02**: Sandbox and rebuild state records exact package, descriptor, settings, platform image, and controller-protocol receipts.

### Runtime extraction pilots

- [ ] **DCO-01**: LangChain Deep Agents Code builds, tests, onboards, connects, runs inference, reconciles MCP, restarts, snapshots, restores, rebuilds, and cleans up from `packages/nemoclaw-deepagents-code` with baseline parity.
- [ ] **DCO-02**: Deep Agents Code runtime-native configuration, activity observation, auto-approval, MCP rendering, and state interpretation no longer execute in NemoClaw core.
- [ ] **HER-01**: NemoClaw-managed Hermes provides baseline-equivalent startup, inference, dashboard and API health, state, cron, recovery, MCP, messaging rendering, restart, snapshot, restore, rebuild, and cleanup from `packages/nemoclaw-hermes`.
- [ ] **HER-02**: Portable Hermes, `agents/hermes/host/**`, and the Hermes tool gateway broker remain outside the managed Hermes package contract.
- [ ] **MCP-01**: NemoClaw core owns normalized MCP intent, logical credential references, required policy, journaling, rollback decisions, and trusted probe execution and interpretation; OpenShell owns credential custody and effective enforcement; packages own native MCP configuration and data-only probe declarations.
- [ ] **MSG-01**: NemoClaw core owns channel manifests, enrollment, logical credential references, required policy, registry state, host forwarding, and the hooks that execute and interpret status and health probes; OpenShell owns credential custody and effective enforcement; packages own runtime-native messaging rendering and data-only health declarations.
- [ ] **MSG-02**: Existing OpenClaw and Hermes messaging configurations retain deterministic coverage, and Deep Agents Code continues to reject unsupported messaging before mutation.
- [ ] **TEST-02**: Each in-tree package builds and runs its detailed tests after being copied outside the NemoClaw checkout.

### Contract freeze and OpenClaw extraction

- [ ] **CTL-04**: Contract V1 contains only bounded helper behavior proven by both a terminal agent and an agent runtime that runs an agent gateway; generic lifecycle remains in NemoClaw and OpenShell.
- [ ] **SEC-04**: Every Contract V1 package-helper invocation is mutation-capable. A later contract can add a read-only operation only when a named trusted core or OpenShell mechanism prevents or independently detects its relevant writes; a violation fails closed, records incident evidence, and can cause a reviewed release-set revocation without rewriting historical qualification evidence.
- [ ] **CTL-05**: Product-state receipts distinguish executor-claimed results from independently observed postconditions, identify the evidence producer, preserve observation limits, and never treat a mutating helper's own result as independent proof.
- [ ] **TEST-03**: The conformance kit covers hostile packages, controller output, interruption, replay, timeout, credential redaction, state-path attacks, and rollback.
- [ ] **CORE-01**: Runtime-neutral core directories contain no Deep Agents Code or Hermes name-based executable dispatch after Contract V1 freezes.
- [ ] **CORE-03**: The migration adds no parallel package registry, lifecycle state machine, sandbox or admitted-process supervisor, OpenShell client, release-promotion system, migration API, or E2E registry. The three exact current descendant wrappers may move unchanged as bounded compatibility debt; no new wrapper is allowed. A shared abstraction needs two current runtime consumers and must replace a named superseded path.
- [ ] **OCL-01**: OpenClaw build assets, startup, configuration, policy, patches, model setup, plugins, and detailed tests reside under `packages/nemoclaw-openclaw`.
- [ ] **OCL-02**: The NemoClaw OpenClaw plugin builds and behaves equivalently from its package-owned location.
- [ ] **OCL-03**: OpenClaw-native pairing interpretation, configuration, state reconciliation, Shields translation, MCP, messaging, and inference reload run behind `runtime-control`; NemoClaw retains product authorization and rollback decisions, and OpenShell retains its enforcement and lifecycle authorities.
- [ ] **CORE-02**: No OpenClaw-specific executable onboarding or managed-startup branch remains in core, and OpenClaw stays the release-set default.

### In-tree release qualification

- [ ] **REL-01**: In-tree package workflows build exact `linux/amd64` and `linux/arm64` artifacts while preserving current public image names and the current managed-image cohort.
- [ ] **REL-02**: The root npm package and installer register the standard in-tree package release set and preserve compatibility executables.
- [ ] **REL-03**: Upgrade and rollback preserve previous-release sessions, registries, snapshots, credentials, policy, ports, and state across package receipts.
- [ ] **STATE-03**: Package availability, sandbox deletion, snapshot retention, and durable-state deletion remain separate lifecycle decisions.
- [ ] **TEST-04**: All three standard packages pass install, onboard, inference, restart, snapshot and restore, rebuild, and cleanup E2E without live messaging accounts.
- [ ] **TEST-05**: The qualified release passes deterministic Ubuntu, macOS, and WSL tests; a real Apple silicon macOS no-messaging OpenClaw install, onboard, inference, restart reconciliation, exact receipt, and cleanup journey on Docker Desktop or Colima; six exact runtime-by-architecture image-startup cells; and the protected staging Brev default-OpenClaw hosted-inference and cleanup journey.

### External repositories and continuous compatibility

- [ ] **DIST-01**: Maintainers explicitly accept converting each moved package from a first-party in-tree integration to an external integration, including artifact transports, trust policy, namespace policy, ownership, retention, revocation, and incident process, before repository handoff.
- [ ] **DIST-02**: Each package moves to its repository without changing its canonical package-tree digest, descriptor, helper protocol, package tests, or conformance behavior; repository-only workflow and provenance metadata remain outside that digest.
- [ ] **DIST-03**: Each package repository publishes exact artifacts, platform images, provenance, software bill of materials, compatibility metadata, and central qualification evidence.
- [ ] **DIST-04**: A NemoClaw release set pins one qualified external package and image tuple for each standard runtime and can roll back to the last qualified tuple.
- [ ] **DIST-05**: NemoClaw resolves, fetches, verifies, and caches exact external artifacts only through accepted transports; a reviewed release-set change can select them only after central qualification.
- [ ] **COMP-01**: Core boundary checks reject runtime-native imports, repository-root package dependencies, and runtime-name executable switches outside approved data, migration, and qualification locations.
- [ ] **COMP-02**: Compatibility CI detects relevant NemoClaw, OpenShell, runtime, inference-provider, and messaging-render contract drift before a release-set change can merge or ship.
- [ ] **COMP-03**: Failed fetch, verification, qualification, update, or revocation checks block the release-set change, keep the last released exact package available for rollback, and produce redacted evidence.

## Deferred Requirements

### Additional agent runtimes and authorities

- **NEXT-01**: Package Pi only after a separate accepted decision authorizes packaging, support, and standard release-set inclusion beyond the accepted candidate trust boundary.
- **NEXT-02**: Package NemoCUA after source authority, image ownership, provenance, state, and lifecycle requirements are available.
- **NEXT-03**: Define portable Hermes as a separate compute and lifecycle authority.
- **NEXT-04**: Define the Hermes tool gateway broker as a separate permissioned broker or sidecar contract.

### Additional distribution and messaging behavior

- **NEXT-05**: Add accepted PyPI or OCI sources after the external artifact and trust decision.
- **NEXT-06**: Add package activation, removal, registry search, and multi-version user controls after their user behavior is accepted.
- **NEXT-07**: Add live messaging-service qualification when test accounts and credential custody are available.
- **NEXT-08**: Add Deep Agents Code messaging only with an operational inbound and outbound bridge.

## Out of Scope

| Feature | Reason |
|---|---|
| Host-loaded Python entry points or package callbacks | They would execute untrusted package code inside the credential-bearing NemoClaw host process. |
| Automatic package discovery from a bare `pip install` | Package installation must be explicit, validated, and receipt-bound. |
| Simultaneous in-tree extraction and repository split | The qualified in-tree release is required as a rollback point. |
| New messaging channels | This migration preserves current channel behavior only. |
| Changes to onboarding wording or interaction design | The migration changes implementation ownership, not the accepted user journey. |

## Traceability

| Requirement | Phase | Status |
|---|---:|---|
| GOV-01, GOV-02, UX-01, UX-02, TEST-01 | Phase 1 | Pending |
| UX-03, STATE-01 | Phase 2 | Pending |
| PKG-01, PKG-02, PKG-03, PKG-04, PKG-05, PKG-06, PKG-07, CLI-01, CLI-02, SEC-01, SEC-02, SEC-03, CTL-01, CTL-03, STATE-02 | Phase 3 | Pending |
| DCO-01, DCO-02, TEST-02 | Phase 4 | Pending |
| HER-01, HER-02, MCP-01, MSG-01, MSG-02 | Phase 5 | Pending |
| CTL-02, CTL-04, SEC-04, CTL-05, TEST-03, CORE-01, CORE-03 | Phase 6 | Pending |
| OCL-01, OCL-02, OCL-03, CORE-02 | Phase 7 | Pending |
| REL-01, REL-02, REL-03, STATE-03, TEST-04, TEST-05 | Phase 8 | Pending |
| DIST-01, DIST-02, DIST-03, DIST-04, DIST-05 | Phase 9 | Pending |
| COMP-01, COMP-02, COMP-03 | Phase 10 | Pending |

**Coverage:**
- Active requirements: 55
- Mapped to phases: 55
- Unmapped: 0

---
*Requirements defined: 2026-08-21*
*Last updated: 2026-08-21 after architecture planning*
