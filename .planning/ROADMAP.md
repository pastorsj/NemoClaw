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

**Goal:** Install exact in-tree agent packages and resolve compatibility before durable or external
mutation while current runtime behavior and lifecycle ownership remain unchanged.

**Depends on:** Phase 1

**Requirements:** GOV-01, GOV-02, UX-01, UX-02, UX-03, PKG-01, PKG-02, PKG-03, PKG-03A, PKG-04, PKG-04A, PKG-05, PKG-08, AGENT-01, AGENT-04, COMP-03, COMP-04, COMP-04A, COMP-04B, TEST-03, TEST-04, TEST-06, TEST-07

**Success Criteria:**

1. A recorded product decision accepts this exact phase scope before production implementation
   begins.
2. `nemoclaw harness list` distinguishes installed and available packages, and
   `nemoclaw harness install [id]` installs only a reviewed bundled package through one validated
   transaction.
3. Onboarding with no installed harness creates no session, registry, runtime, or external mutation;
   one installed harness is selected automatically; multiple installed harnesses preserve current
   interactive and non-interactive behavior.
4. A new package-managed onboarding session records the selected package ID, version, contract
   version, and digest under the existing writer lock before external mutation.
5. Package-managed resume, recreate, route reservation, policy verification, final registration,
   snapshot, restore, backup, and rebuild agree on that identity or stop before their next mutation;
   qualified Pi and NemoCUA paths retain their existing non-package authority.
6. Existing installations and aliases retain their current user behavior, including legacy
   `agent: null` OpenClaw state and strict pre-upgrade backup.
7. Deterministic tests pass, followed by one no-messaging macOS development journey and one
   no-messaging Linux/Brev development journey. Neither development run replaces exact staging
   Launchable release evidence.

**Plans:** 18/23 plans executed

- [x] `02-01` — Obtain the accepted product-scope decision.
- [x] `02-02` — Define and validate the agent package envelope and hostile package tree.
- [x] `02-03` — Publish validated artifacts through an immutable store and exact receipts.
- [x] `02-04` — Build reviewed bundled artifacts and expose one package catalogue.
- [x] `02-05` — Add installed and available inventory plus `harness list`.
- [x] `02-06` — Add `harness install`, its prompt, docs, and compiled command contract.
- [x] `02-07` — Preserve `agents list` through installed package inventory.
- [x] `02-08` — Add strict session identity, migration provenance, and checkpoint v5.
- [x] `02-09` — Add strict registry, route, and policy state fields.
- [x] `02-10` — Build agent definitions from one explicit, pinned package root.
- [x] `02-11` — Route package-managed image and build context through that root.
- [x] `02-12` — Select zero, one, or many installed packages while preserving candidate gates.
- [x] `02-13` — Bind fresh and legacy session identity under the existing writer lock.
- [x] `02-14` — Reject resume drift before mutation and preserve candidate behavior.
- [x] `02-15` — Carry identity through route, policy, and sandbox creation.
- [x] `02-16` — Carry identity through recreate and checkpoint recovery.
- [x] `02-17` — Publish exact final registration and bind recovery-only retained state.
- [x] `02-18` — Reconcile legacy owners before installer backup and OpenShell changes.
- [x] `02-19` — Persist rebuild-manifest identity and bind snapshot, backup, restore, and clone.
- [ ] `02-20` — Bind prepared rebuild recovery and target context to exact identity.
- [ ] `02-21` — Carry one pinned definition through downstream rebuild consumers.
- [ ] `02-22` — Extend the existing typed E2E fixture with exact package installation and assertions.
- [ ] `02-23` — Run deterministic and no-messaging development qualification.

**Implementation slices:**

1. Add the minimal agent-package envelope, validators, digest-addressed package objects, one active
   pointer per agent, and exact receipts. Extract package-neutral storage only when a second accepted
   component kind uses it.
2. Add `nemoclaw harness list/install`; keep `nemoclaw agents list` compatible.
3. Port zero, one, multiple, non-interactive, and package-managed resume selection behavior while
   preserving explicitly qualified Pi and NemoCUA candidate paths without fabricated identity.
4. Under the existing onboarding writer lock, prove exact package authority before portable
   recovery, let recovery consume unchanged prior owner state, then record exact identity before
   route reservation or sandbox mutation. Carry it unchanged through the session, recreate journal,
   pending route reservation, policy checkpoint, and final registry. Resume by the session-pinned
   digest even when the active pointer advanced; fail closed on missing content or identity drift.
5. Preserve current post-create recovery behavior: an incomplete sandbox, registry row,
   recovery-only Session, independent retained record, and package object survive, while same-name
   resume, reuse, recreation, and fresh onboarding stay blocked.
6. Do not add a cross-component selection receipt until a second accepted component kind consumes
   the same identity and compatibility behavior.
7. Build reviewed bundled agent artifacts from the current source layout as a temporary migration
   adapter. The package identity covers the installed selection and copied asset bytes; it does not
   claim complete harness runtime provenance while remaining host behavior is statically linked.
8. Keep runtime-provider, serving, and remaining agent host code statically linked and explicitly
   registered. Only
   data and agent sandbox code are dynamically installed in this phase.
9. Preserve installer upgrade semantics through one idempotent owner-scoped migration service:
   resolve a resumed or legacy standard `agent: null` identity, install and re-read the exact bundled
   harness, persist identity and current-bundle migration provenance through same-owner Session CAS
   and locked registry writes, and make that package available to backup and rebuild before OpenShell
   changes. Unrelated sandboxes may pin different exact identities and migration times.
10. Test recovery-only cancel after create, active-pointer advancement for ordinary resume, exact
    package resume, missing content, package drift, and policy-source drift without changing the
    existing recovery transaction.

### Phase 3: Agent Runtime Packages

**Goal:** The standard agent packages are self-contained and readable examples for the next harness.

**Depends on:** Phase 2

**Requirements:** PKG-06, PKG-07, AGENT-02, AGENT-03, AGENT-05, TEST-01, TEST-02,
TEST-08

**Implementation order:**

1. Establish package-local build and test commands, root aggregate discovery, publication paths,
   and exactly-once suite membership before moving a harness test.
2. LangChain Deep Agents Code proves the terminal-agent path.
3. Hermes proves the gateway, dashboard, state, MCP, and messaging-projection path.
4. Freeze only the shared operations proven by both.
5. OpenClaw moves from `_legacy_paths` and remains the default.
6. Delete the temporary bundled-source adapter once every standard package is authored at its
   canonical package root and the installed object is the real execution asset root.
7. Pi and NemoCUA remain legacy built-in candidates until separately accepted and packaged. Their
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
