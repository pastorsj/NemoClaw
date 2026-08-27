<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Roadmap: NemoClaw Component Composition

## Strategy

Stabilize one in-tree composition path before extracting repositories. Reuse current contracts and
registries. Introduce a common package envelope only for distribution and identity, then keep each
component behind its own typed contract.

The roadmap uses eight capability slices. Each slice must leave the current product usable and have
its own rollback point. This is intentionally smaller than the preserved 57-plan migration.

## Delivery Gates

| Gate | Phase | Evidence | Failure behavior |
|---|---:|---|---|
| Product scope | 2 | Recorded `Accept` decision with reason, placement, accountable maintainer, initial components, trust, validation, and rollback | Stop before implementation |
| Agent package | 3 | Exact package install, unchanged onboarding, package tests, and one complete lifecycle | Keep current `agents/` paths authoritative |
| Runtime provider | 4 | Current Docker and external-gateway parity with unchanged activation authority | Keep current static registration |
| Serving | 5 | Current catalogue parity and one real backend lifecycle | Keep current serving implementation |
| Platform | 6 | Readiness and claim parity plus accepted host-preparer boundary | Keep host preparation in core |
| Fabric | 7 | Deterministic contract evidence plus bounded live policy, canary-secret, isolation, and cleanup evidence | Keep Fabric outside NemoClaw |
| External handoff | 8 | Exact artifacts, compatibility edges, supported live profiles, provenance, rollback | Keep qualified packages in-tree |

## Phases

- [x] **Phase 1: Architecture Baseline** — Reconcile latest main, map current boundaries, audit the
  preserved package migration, evaluate NeMo Fabric, and define the candidate architecture.
- [ ] **Phase 2: Agent Package Foundation** — Accept product scope, port the safe agent package store
  and harness CLI, and bind exact agent package identity into current onboarding state without
  changing execution paths.
- [ ] **Phase 3: Agent Runtime Packages** — Make current supported agent integrations self-contained,
  remove named-agent generic dispatch, and move native tests to their package owners.
- [ ] **Phase 4: Runtime Provider Packages** — Wrap current Docker and the Kubernetes-named
  external-gateway bundle behind build-time in-tree package identities while preserving
  registration, activation, qualification, and current support claims.
- [ ] **Phase 5: Serving Runtime Packages** — Package serving catalogue fragments and current typed
  adapters, starting with one backend and removing substrate assumptions through existing surfaces.
- [ ] **Phase 6: Platform and Host Boundaries** — Consolidate declarative platform profiles and
  isolate only justified privileged host preparation.
- [ ] **Phase 7: NeMo Fabric Pilot** — Evaluate Fabric inside one OpenShell sandbox as a bounded
  agent-execution validation lane without changing onboarding or always-on lifecycle behavior.
- [ ] **Phase 8: Qualification and Repository Handoff** — Prove compatibility edges, exact selected
  artifacts, updates, rollback, named platform journeys, and unchanged external package trees.

## Phase Details

### Phase 1: Architecture Baseline

**Goal:** Produce decision-ready boundaries, structures, workflow, migration order, effort, and test
evidence against exact current main.

**Complete when:**

1. Current and target architectures are traceable to source evidence.
2. Each candidate is classified as executable package, declarative profile, core authority, or
   deferred capability.
3. NeMo Fabric has an explicit fit, non-fit, and bounded pilot.
4. The preserved migration has a safe semantic replay strategy.

### Phase 2: Agent Package Foundation

**Goal:** Install exact in-tree agent packages and resolve compatibility before mutation while all
current runtime behavior remains on its existing path.

**Implementation slices:**

1. Add the minimal agent-package envelope, validators, digest-addressed package objects, one active
   pointer per agent, and exact receipts. Extract package-neutral storage only when a second accepted
   component kind uses it.
2. Add `nemoclaw harness list/install`; keep `nemoclaw agents list` compatible.
3. Port zero, one, multiple, non-interactive, and resume selection behavior.
4. Under the existing onboarding writer lock, record exact agent package identity before route
   reservation or sandbox mutation. Carry it unchanged through the session, recreate journal,
   pending route reservation, policy checkpoint, and final registry. Resume by the session-pinned
   digest even when the active pointer advanced; fail closed on missing content or identity drift.
5. Preserve current cancellation behavior: an incomplete created sandbox, its registry and session
   state, and its package object survive for identity-bound `nemoclaw onboard --resume`.
6. Do not add a cross-component selection receipt until a second accepted component kind consumes
   the same identity and compatibility behavior.
7. Add package authoring metadata, build output, package-local test configurations, root aggregate
   discovery, publication paths, and an exactly-once membership check.
8. Keep runtime-provider and serving host code statically linked and explicitly registered. Only
   data and agent sandbox code are dynamically installed in this phase.
9. Preserve installer upgrade semantics: resolve a resumed or legacy `agent: null` identity,
   reconcile the exact bundled harness before pre-upgrade backup, and make that package available to
   backup and rebuild before OpenShell changes.
10. Test cancel after create, active-pointer advancement, exact package resume, missing content,
    package drift, and policy-source drift without changing the existing recovery transaction.

### Phase 3: Agent Runtime Packages

**Goal:** The standard agent packages are self-contained and readable examples for the next harness.

**Implementation order:**

1. LangChain Deep Agents Code proves the terminal-agent path.
2. Hermes proves the gateway, dashboard, state, MCP, and messaging-projection path.
3. Freeze only the shared operations proven by both.
4. OpenClaw moves from `_legacy_paths` and remains the default.
5. Pi and NemoCUA remain legacy built-in candidates until separately accepted and packaged. Their
   existing qualification gates remain reachable without making them standard installed harnesses.

### Phase 4: Runtime Provider Packages

**Goal:** Runtime provider ownership is independent without weakening privileged activation.

**Implementation order:**

1. Add build-time package identity around Docker with no behavior change.
2. Add build-time package identity around the existing Kubernetes-named external-gateway topology
   with no behavior change and no native Kubernetes support claim.
3. Move residual provider-name branching behind existing bundle surfaces.
4. Keep Podman and MXC installed or registered only as candidates until their current activation
   gaps pass.
5. With agent and runtime-provider identities as two real consumers, extract the package-neutral
   envelope/store behavior and resolve the first cross-component selection receipt. Existing
   lifecycle transactions remain the executors.

### Phase 5: Serving Runtime Packages

**Goal:** A backend owns its catalogue and executable lifecycle without owning credentials, policy,
or runtime-provider behavior.

**Implementation order:**

1. Aggregate current typed serving registries and declarative readiness requirements into a
   build-time serving-package contract.
2. Pilot vLLM or llama.cpp based on the accepted physical qualification environment.
3. Separate backend requirements from Docker-specific execution.
4. Move remaining supported backends one at a time.
5. Keep remote inference provider work as a separate later contract.

### Phase 6: Platform and Host Boundaries

**Goal:** Platform support is declarative and evidence-backed; privileged host mutation has explicit
ownership.

**Implementation order:**

1. Generate platform qualification views from readiness facts and the current claim matrix.
2. Remove duplicate OS and hardware switches where profiles can express the same rule.
3. Define a host-preparer contract only if DGX Station and a second real preparer prove it.
4. Keep platform support claims tied to physical evidence.

### Phase 7: NeMo Fabric Pilot

**Goal:** Determine whether Fabric provides useful normalized agent invocation and evaluation inside
NemoClaw sandboxes without making it a control-plane dependency.

**Implementation order:**

1. Pin exact Fabric, adapter, contract, fixture, Python, OS, architecture, and capability identities.
2. Run deterministic discovery, plan, doctor, start, two ordered invokes, failure, malformed result,
   transport, isolation, and stop contract tests outside a live sandbox.
3. Use the SDK inside one existing Linux sandbox only for installation, policy and egress, synthetic
   canary-secret custody, isolation, and cleanup evidence.
4. Compare artifacts and events with NemoClaw package qualification needs.
5. Qualify a real adapter only after exact agent dependency alignment.
6. Decide whether Fabric remains test-only, leaves NemoClaw, or earns an optional agent capability.

### Phase 8: Qualification and Repository Handoff

**Goal:** Independently released components update without breaking supported NemoClaw compositions.

**Implementation order:**

1. Run package-only tests and published conformance suites in each package repository.
2. Run core composition tests against exact package artifacts and compatibility windows.
3. Run edge-covering live profiles for each supported component boundary and platform claim. A
   managed backend runs on the environment required by its claim; an attached endpoint does not
   inherit a physical hardware gate. The
   existing Kubernetes external-gateway bundle requires deterministic and remote-boundary parity,
   not an invented native Kubernetes E2E claim.
4. Publish exact package, image, provenance, and qualification receipts.
5. Move repositories without changing the qualified package trees.
6. Gate release-set updates, revocation, rollback, and compatibility evidence in NemoClaw.

## Rough Effort

These are engineering ranges after scope acceptance, not calendar commitments.

| Workstream | Estimated effort | Primary uncertainty |
|---|---:|---|
| Agent store, CLI, and state identity | 3–5 engineer-weeks | State migration and installer compatibility |
| Agent runtime packages | 10–18 engineer-weeks | OpenClaw and Hermes native behavior still in core |
| Runtime provider packages | 4–7 engineer-weeks | Privileged registration and qualification boundaries |
| Serving runtime packages | 5–9 engineer-weeks | Docker coupling and physical GPU qualification |
| Platform and host cleanup | 3–6 engineer-weeks | DGX Station preparation and Windows ownership |
| NeMo Fabric pilot | 1–3 engineer-weeks | Exact adapter and harness version alignment |
| External repositories and release automation | 4–7 engineer-weeks | Signing, retention, revocation, and cross-repo CI |

The work is roughly 30–55 engineer-weeks if every workstream is accepted. Three to five engineers
can parallelize package-native work after Phase 2, but security, state, installer, and release gates
remain sequential. The first useful milestone—package store plus one terminal-agent package—is
roughly 5–8 engineer-weeks.
