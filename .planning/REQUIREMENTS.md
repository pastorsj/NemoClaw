<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Requirements: NemoClaw Component Composition

**Defined:** 2026-08-27
**Core value:** A contributor can implement and test one component through a clear typed contract,
while NemoClaw safely composes exact versions without taking ownership away from OpenShell.

## Active Requirements

### Product and compatibility

- [ ] **GOV-01**: Before implementation, a recorded design decision has status `Accept` and states
  the reason, repository placement, accountable maintainer, supported initial components, trust and
  compatibility policy, validation plan and environments, and rollback plan, bound to the exact
  proposal revision.
- [ ] **GOV-02**: Registration and technical conformance do not imply product activation or support.
- [ ] **UX-01**: Existing install, onboarding, aliases, flags, environment variables, menu labels,
  defaults, resume behavior, and resulting sandbox behavior remain available during migration.
- [ ] **UX-02**: `nemoclaw harness install` and `nemoclaw harness list` are the agent-package
  management commands. `harness list` shows installed and available sections. Existing
  `nemoclaw agents list` and onboarding use only installed, selectable entries.
- [ ] **UX-03**: The regular package-managed path with zero installed harnesses stops with actionable
  installation guidance before session, registry, runtime, or external mutation; the writer lock
  may be created and released. One is selected automatically; multiple interactive harnesses use a
  picker; multiple non-interactive harnesses preserve the established OpenClaw default when it is
  installed and otherwise require `--agent`; package-managed resume requires the recorded exact
  harness. Explicit Pi and NemoCUA paths retain their existing qualification gates without
  fabricated package identity.

### Common package envelope

- [ ] **PKG-01**: Every component artifact carries a bounded, language-neutral package envelope with
  schema version, kind, ID, display name, package version, contract version, and manifest path.
- [ ] **PKG-02**: Package installation rejects links, special files, traversal, ownership or mode
  violations, excessive size or depth, identity conflicts, digest mismatches, and unknown contracts.
  One package kind, agent ID, package version, and contract version tuple cannot bind to multiple
  content digests; changed bytes require a new adapter package version.
- [ ] **PKG-03**: Installation copies and verifies immutable content into a digest-addressed object,
  changes one validated active pointer atomically, and records kind, ID, version, source identity,
  content digest, and installation time in an exact receipt. The agent inventory is stored under the
  gateway-independent base NemoClaw state root and does not change with `NEMOCLAW_GATEWAY_PORT`.
- [ ] **PKG-03A**: Package garbage collection retains immutable content while an active pointer,
  onboarding session, pending route reservation, recreate journal, pending policy checkpoint,
  sandbox, rollback record, snapshot, or supported release references its digest.
- [ ] **PKG-04**: Core package loading performs no arbitrary package import or executable callback.
  Type-specific executable behavior runs only at its accepted trust boundary.
- [ ] **PKG-04A**: In the first version, installed agent artifacts contain only validated data and
  sandbox or image-build code. Runtime-provider and serving host implementations are statically
  linked and explicitly registered at NemoClaw build time. Dynamic external host loading is
  deferred.
- [ ] **PKG-05**: Package availability, installation, registration, activation, qualification,
  support, revocation, and removal remain distinct lifecycle states.
- [ ] **PKG-06**: Packages are self-contained, independently buildable, and independently testable
  before they can leave the NemoClaw repository.
- [ ] **PKG-07**: Every in-tree package declares its authoring metadata, build output, package-local
  tests, and compiled entry point where needed. Root build, test, publication, and membership checks
  discover every declared package and fail if one is omitted.
- [ ] **PKG-08**: The first implementation is agent-specific. Package-neutral storage or discovery
  is extracted only after a second accepted component kind consumes the same safe behavior.

### Agent runtime packages

- [ ] **AGENT-01**: Agent packages extend the current `AgentDefinition` rather than replace it with a
  generic callback interface.
- [ ] **AGENT-02**: The current standard agent assets move under in-tree package roots with a shared
  responsibility structure and no root-relative legacy paths.
- [ ] **AGENT-03**: Agent-native config, startup, policy, state strategies, MCP projection, messaging
  projection, dashboard projection, skill layout, compatibility code, and optional telemetry live in
  the owning package when that responsibility exists.
- [ ] **AGENT-04**: Core retains user intent, credentials, policy authorization, safe state staging,
  transactions, independent observations, rollback, and OpenShell lifecycle coordination.
- [ ] **AGENT-05**: Generic core orchestration does not dispatch executable behavior by agent ID.

### Runtime-provider packages

- [ ] **RUNTIME-01**: Runtime-provider packages export the existing versioned
  `RuntimeProviderBundle` as their sole registration unit.
- [ ] **RUNTIME-02**: Provider source-package inclusion or registration cannot make a provider selectable;
  activation still requires exact supported agents, platforms, acceleration, inference services,
  journeys, installer behavior, and qualification evidence.
- [ ] **RUNTIME-03**: Current Docker and the Kubernetes-named external-gateway topology are wrapped
  without behavior change or a new native Kubernetes support claim before candidate Podman or MXC
  extraction or promotion.
- [ ] **RUNTIME-04**: Runtime-provider packages do not create a second OpenShell client, lifecycle
  state machine, activation registry, or destructive-operation authority.

### Serving and inference

- [ ] **SERVE-01**: Serving packages contribute current serving catalogue data plus typed
  materializer, lifecycle, preparation, and topology adapters and declarative readiness contract
  references and requirements.
- [ ] **SERVE-02**: Serving requirements describe capabilities; they do not hard-code a container
  substrate when the runtime-provider contract can supply it.
- [ ] **SERVE-03**: Remote inference APIs, local serving processes, runtime providers, and model
  recipes remain separate concepts and contracts.
- [ ] **SERVE-04**: Core retains credentials, endpoint validation, SSRF and DNS controls, OpenShell
  route publication, policy authorization, reconciliation, and rollback.

### Platform and host

- [ ] **HOST-01**: Operating system, architecture, hardware, container engine, GPU, and driver state
  remain observed readiness facts evaluated through declarative qualification profiles.
- [ ] **HOST-02**: No package represents macOS, Linux, Windows, DGX Spark, or DGX Station hardware by
  itself.
- [ ] **HOST-03**: Privileged host preparation can become a separately trusted component only when
  it has independent executable behavior, ownership, rollback, and physical qualification.
- [ ] **HOST-04**: The current platform claim matrix remains the source of product support status.

### Composition and state

- [ ] **COMP-01**: Core resolves one immutable onboarding selection receipt before mutation from the selected
  agent, runtime provider, inference route or serving profile, and observed platform facts.
- [ ] **COMP-02**: The receipt records exact component identities, contracts, digests, capability
  decisions, incompatibilities, policy and credential intent digests, and qualification evidence.
  It references existing lifecycle and transaction receipts rather than owning operations or
  rollback, and it persists no executable object or credential.
- [ ] **COMP-03**: Unsupported or ambiguous compositions fail before host, OpenShell, sandbox, policy,
  credential, or serving mutation.
- [ ] **COMP-04**: New package-managed state records exact component and selection identities.
  Upgrade, rebuild, restore, rollback, and removal verify those identities and fail closed on
  unknown authority. Legacy standard-agent migration atomically and idempotently records the
  reviewed current package identity plus strict secret-free migration provenance in its owning
  session and registry state without claiming historical byte provenance; candidate harnesses keep
  their existing non-package authority.
- [ ] **COMP-04A**: The owning onboarding session records the exact agent package ID, version, and
  digest under its existing writer lock before route reservation or sandbox mutation. That identity
  remains unchanged through the recreate journal, route reservation, policy checkpoint, and final
  sandbox registration; resume and finalization fail closed on package or session drift.
- [ ] **COMP-04B**: Cancellation or failure after sandbox creation preserves the incomplete sandbox,
  registry entry, recovery-only onboarding session, independent retained-sandbox recovery record,
  and referenced package bytes. The independent record carries exact package identity without
  owner-only migration audit metadata. Automatic or explicit resume, reuse, recreation, and
  same-name fresh onboarding remain blocked; package adoption does not restore delete-by-name or
  invent a supported record-clear operation.
- [ ] **COMP-05**: A core-owned release set pins selected artifact versions and their supported
  compatibility edges. It does not enumerate a Cartesian tuple catalogue. Immutable qualification
  history remains separate from current support status.

### NeMo Fabric

- [ ] **FABRIC-01**: A NeMo Fabric pilot does not replace the agent, runtime-provider, serving,
  platform, OpenShell, or NemoClaw lifecycle contract. If retained after the pilot, Fabric can be
  only an optional sandbox-local agent capability.
- [ ] **FABRIC-02**: Deterministic tests pin Fabric and adapter versions and digests, adapter contract,
  fixture identity, Python, OS, architecture, and capabilities, then prove discovery, planning,
  doctor, ordered invocation, partial start, malformed results, transport failures, isolation, and
  stop behavior without a live sandbox.
- [ ] **FABRIC-02A**: One bounded live test inside an already-created Linux OpenShell sandbox proves
  exact installation, policy and egress, synthetic canary-secret custody across every output and
  persisted surface, sandbox isolation, and cleanup.
- [ ] **FABRIC-03**: A real agent adapter enters qualification only when its agent semantics and exact
  dependency versions match the NemoClaw package. The supported path uses the Fabric SDK, not the
  experimentation CLI.

### Testing and release

- [ ] **TEST-01**: Package repositories own native unit tests and package-only behavior tests.
- [ ] **TEST-02**: NemoClaw publishes reusable conformance suites for package safety, contract
  versions, capabilities, entry points, negative fixtures, artifacts, and compatibility windows.
- [ ] **TEST-03**: NemoClaw core owns package installation, discovery, composition, credentials,
  policy, state, recovery, cross-package, and installed-artifact tests, including package-identity
  drift in ordinary resumable sessions, exact recovery-only evidence after post-create cancellation
  or failure, and policy-source drift at a pending verified-create checkpoint.
- [ ] **TEST-04**: The existing typed E2E registry, target catalogue, and shared workflow planner
  remain the only central automated live-test authorities. Registered package workflows consume
  exact artifacts and receipts; manual development runs cannot create release evidence.
- [ ] **TEST-05**: Live qualification covers compatibility edges and named supported compositions,
  not the full agent × runtime × serving × OS × hardware Cartesian product.
- [ ] **TEST-06**: macOS, operator-supplied development Brev/Linux, exact staging Launchable, WSL2,
  DGX Spark, DGX Station, and candidate Windows environments provide only the evidence named by
  their accepted platform claims. Generic Brev source-overlay runs never enter the release planner;
  exact staging Launchable owns release evidence.
- [ ] **TEST-07**: Live messaging-service tests remain excluded; deterministic messaging projection,
  credential, policy, migration, and failure tests remain required.
- [ ] **TEST-08**: Before an in-tree test moves under `packages/`, the package has a local test
  configuration and the root aggregate discovers it exactly once, with a membership check that
  fails when a declared package suite is skipped.
- [ ] **DIST-01**: External repository handoff preserves the qualified in-tree package tree and tests,
  and central composition consumes exact artifacts rather than sibling source checkouts.
- [ ] **DIST-02**: Publisher authenticity, signing, provenance, retention, revocation, update, and
  incident ownership are accepted before external artifact installation becomes supported.

## Deferred Requirements

- External discovery from a prior `pip install`, global npm install, or arbitrary host module path.
- A public NemoClaw plugin SDK, package registry, or marketplace.
- Runtime-provider activation from an untrusted third-party package.
- Separate messaging-channel packages before agent-native rendering is open and proven.
- General observability packages before two independent consumers prove a contract.
- Product execution through NeMo Fabric before the validation pilot and exact adapter qualification.
- Pi, NemoCUA, Podman, MXC, or a DGX Station host preparer as supported surfaces without their own
  accepted product and qualification decisions.

## Out of Scope

| Feature | Reason |
|---|---|
| One universal plugin callback | The three executable contracts have different authority and lifecycle semantics. |
| Hardware packages | Hardware is observed, not installed. |
| Full combinatorial E2E | It is expensive and duplicates contract-level evidence. |
| Package tests during user install | Installation must be deterministic and cannot run authoring tests or arbitrary code. |
| Secret values in descriptors or receipts | Core and OpenShell retain credential custody. |
| Silent component upgrades | Exact selected artifacts, compatibility edges, and rollback require reviewed release-set changes. |

## Traceability

| Requirement group | Owning phase |
|---|---:|
| GOV, UX | 2 |
| PKG-01 through PKG-05, PKG-08 | 2 |
| PKG-06, PKG-07 | 3 |
| AGENT-01, AGENT-04 | 2 |
| AGENT-02, AGENT-03, AGENT-05 | 3 |
| COMP-03, COMP-04, COMP-04A, COMP-04B | 2 |
| Shared PKG, RUNTIME, COMP | 4 |
| SERVE, COMP extension | 5 |
| HOST | 6 |
| FABRIC | 7 |
| TEST-03, TEST-04, TEST-06, TEST-07 | 2 |
| TEST-01, TEST-02, TEST-08 | 3 |
| Remaining TEST, DIST, release COMP | 8 |

---

*Requirements defined from exact current main and preserved migration evidence on 2026-08-27.*
