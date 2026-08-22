<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Discussion 9909 Reconciliation

> **Status:** Decision packet. Nothing in this document records maintainer acceptance.
>
> **Discussion:** [RFC: Modular agent runtime integration packages](https://github.com/NVIDIA/NemoClaw/discussions/9909)
>
> **Repository source baseline:** `a5486894c45140259d822625e74d1ccdfce807ee`
>
> **Owning design:** [Technical plan](TECHNICAL-PLAN.md)

## 1. Decision status and method

Discussion 9909 reports `Status: Proposed`. GitHub reports its author, `ericksoa`, as a repository
`MEMBER`. The discussion requests architecture review from `cv`, but it does not name an accountable
maintainer or contain the repository decision-policy fields for placement and validation.

As inspected on 2026-08-21:

- GitHub reports no accepted answer.
- The `cv` review is a comment by a repository `MEMBER`; it is not marked as an answer.
- The `ljefford2-cmyk` review is a comment whose GitHub author association is `NONE`; it is not
  marked as an answer.
- Neither comment is a formal `Accept`, `Request changes`, `Defer`, or `Decline` record by an
  accountable maintainer under `CONTRIBUTING.md`.

This reconciliation therefore uses four dispositions:

- **Align:** The proposal implements the RFC direction. This is still pending product acceptance.
- **Requested divergence:** The user-requested plan differs from the RFC and needs explicit
  maintainer acceptance.
- **Request changes:** A reviewer identified a prerequisite or trust gap. The design may incorporate
  a response, but the request is not resolved until a maintainer accepts it.
- **Defer:** The topic needs another product, support, or lifecycle decision after the in-tree
  migration.

No row marked Align or Request changes means that supported implementation may start. The product
scope gate remains the first implementation gate.

## 2. RFC architecture reconciliation

Each row translates one distinct RFC rule into this proposal. “Phase” refers to the migration stages
in [TECHNICAL-PLAN.md](TECHNICAL-PLAN.md#13-migration-plan).

| # | RFC statement | Association | Disposition | Design response | Decision owner | Phase | Acceptance evidence |
|---:|---|---|---|---|---|---:|---|
| 1 | Define one versioned contract for an integration package per agent runtime. | RFC author: `MEMBER` | Align | `packages/agent-runtime-contract` owns strict descriptor, helper, receipt, and conformance schemas. | Contract owner | 3 | Accepted contract record and conformance tests for two representative runtimes. |
| 2 | Keep agent-specific executable behavior outside the NemoClaw host process. | RFC author: `MEMBER` | Align | Host ingestion is data-only. Executable behavior runs only through `/opt/nemoclaw/bin/runtime-control` inside an admitted sandbox. | Security and contract owners | 3 | Import-boundary checks, hostile archive tests, and credential-bearing host-process review. |
| 3 | NemoClaw owns product workflow, catalogue, generic plan compilation, durable product linkage, rollback, and qualification. | RFC author: `MEMBER` | Align | These remain core-owned. Package results cannot publish product state or support. | Core owner | 3–8 | Plan determinism, rollback, state receipt, and support-catalog tests. |
| 4 | OpenShell owns sandbox lifecycle and state, compute dispatch, policy enforcement, credentials, inference interception, supervision, and sandbox execution. | RFC author: `MEMBER` | Align with pinned-version exception | The package helper is bounded and non-supervising, and all lifecycle requests route through one core-owned OpenShell client. OpenShell `0.0.106` supervises one admitted entrypoint but does not replace the existing Deep Agents Code session cleanup wrapper or the OpenClaw and Hermes descendant repair loops, so those three wrappers remain package-local compatibility debt with later-pin removal gates. | OpenShell integration owner | 3–8 | Exact-pin OpenShell conformance plus onboard, process failure, authenticated replacement, restart, rebuild, snapshot, restore, and cleanup E2E. |
| 5 | First-party integration source lives in the NemoClaw repository. | RFC author: `MEMBER` | Align for initial release | All first implementation roots live under `packages/` and qualify together in-tree. | Product and release owners | 3–8 | One exact in-tree release set passes the accepted release matrix. |
| 6 | First-party source remains in NemoClaw; separate repositories are external integrations. | RFC author: `MEMBER` | Requested divergence | The user wants the option to move a qualified package unchanged to its own repository. Such a move converts its source boundary to an external integration unless maintainers accept another classification. It is not part of the first release. | Accountable maintainer and product owner | 9 | Separate accepted decision covering classification, ownership, transport, trust, retention, revocation, and incident response. |
| 7 | External integrations may implement the same public contract. | RFC author: `MEMBER` | Defer | The in-tree contract must first pass all three standard packages. External source ingestion and publication are later work. | Product, security, and release owners | 9 | Qualified in-tree rollback release plus accepted external-integration decision. |
| 8 | Repository placement alone does not confer support. | RFC author: `MEMBER` | Align | Support requires an exact checked-in release-set entry, immutable qualification evidence, and core-owned `supported` status. | Product and release owners | 3 | Collision, list-only, support-status, and selection tests. |
| 9 | Adding an agent runtime must not add core name branches, a driver, or another lifecycle authority. | RFC author: `MEMBER` | Align | Architecture budgets permit runtime names only in package, catalogue, compatibility, migration, and qualification locations. | Core and architecture owners | 1, 4–8 | Fingerprinted source ledger and decreasing repository checks. |
| 10 | Use `agent runtime` for the technical concept and reserve `plugin` for runtime-loaded plugins. | RFC author: `MEMBER` | Align | Internal schemas and prose use `agent runtime`; the OpenClaw plugin remains a separate package-owned plugin. | Contract and documentation owners | 3, 7 | Controlled-word and package-identity checks. |
| 11 | Use `Harness` only for the OpenClaw RFC 0027 resource. | RFC author: `MEMBER` | Requested divergence | The public command is `nemoclaw harness install` for compatibility. New internal interfaces do not use Harness as their type name. | Accountable maintainer and CLI owner | 3 | Accepted command decision and CLI contract tests. |
| 12 | Preserve current CLI commands and supported behavior during migration. | RFC author: `MEMBER` | Align | Preserve menu, order, labels, prompts, default, `--agent`, `NEMOCLAW_AGENT`, `nemoclaw agents list`, `nemohermes`, `nemo-deepagents`, state, and sandbox results. | CLI and compatibility owners | 1–8 | Behavior baseline and cross-release E2E. |
| 13 | Do not create a public marketplace. | RFC author: `MEMBER` | Align | V1 has local artifact ingestion and listing only. Registry search is deferred. | Product owner | 3 | Command-surface and help snapshot tests. |
| 14 | Do not load arbitrary host-side JavaScript, TypeScript, Python, or shell. | RFC author: `MEMBER` | Align | Descriptor parsing is data-only; archives cannot supply host callbacks or install hooks. | Security owner | 3 | Malicious descriptor, archive, and package import tests. |
| 15 | Packages cannot call OpenShell, Docker, Podman, Kubernetes, a gateway, driver, or host API. | RFC author: `MEMBER` | Align | Package imports and image grants exclude these clients and endpoints. NemoClaw owns one OpenShell client boundary. | Security and OpenShell owners | 3–8 | Import scans, image inspection, denied-access E2E, and direct-call-site ratchet. |
| 16 | Packages cannot widen effective policy. | RFC author: `MEMBER` | Align | A package declares requirements or narrower defaults. NemoClaw compiles its required baseline and OpenShell enforces the effective policy. | Policy and security owners | 3–8 | Policy compilation, exact effective-policy, and denied-egress tests. |
| 17 | Upstream provider credentials do not enter a package, sandbox metadata, plan, state, or qualification artifact. | RFC author: `MEMBER` | Align | NemoClaw uses logical references and OpenShell placeholders; OpenShell retains custody and rewrite. | Credential and security owners | 3–8 | Redaction, provider binding, snapshot scanning, and credential-generation-window E2E. |
| 18 | Contract compatibility or successful launch does not establish product support. | RFC author: `MEMBER` | Align | A local compatible artifact is list-only. Only a core release-set entry with `supported` status enables normal selection. | Product and release owners | 3 | Catalogue parsing and attempted-selection tests. |
| 19 | Do not change the current agent runtime support matrix. | RFC author: `MEMBER` | Align | The standard set remains OpenClaw, Hermes, and LangChain Deep Agents Code. Pi and NemoCUA remain outside it. | Product owner | 3–8 | Exact release-set fixture and list/onboard characterization. |
| 20 | Do not claim roadmap capability before NemoClaw pins and qualifies it. | RFC author: `MEMBER` | Align | OpenShell parity comes only from repository-owned exact pins, feature markers, and accepted E2E. | OpenShell and release owners | All | Exact component, capability, driver, and platform receipts. |
| 21 | `RuntimeProviderBundle` stays core-only and converges only after supported OpenShell parity. | RFC author: `MEMBER` | Align | No package imports or implements the bundle. The facet ledger in section 7 defines retain, converge, and remove conditions. | Core and OpenShell owners | 1, 3–10 | Consumer fingerprints, one-client checks, parity receipts, and facet-specific E2E. |
| 22 | Define one NemoClaw-owned OpenShell client boundary. | RFC author: `MEMBER` | Align | Extend `src/lib/adapters/openshell/client.ts` or its accepted successor; remove direct call sites only as their exact behavior moves. | OpenShell integration owner | 1, 3–10 | Direct-call-site budget reaches the accepted allowlist and package roots contain none. |
| 23 | The descriptor is versioned, declarative, strict, and credential-free. | RFC author: `MEMBER` | Align | The descriptor declares identity, exact images, services, state, settings, capabilities, and required access with closed schemas. | Contract owner | 3 | Schema corpus, fuzzing, and canonicalization tests. |
| 24 | The descriptor cannot choose support, provider, driver, policy authority, or host execution. | RFC author: `MEMBER` | Align | Those fields are absent and unknown behavior fields fail validation. | Contract and security owners | 3 | Negative schema and selection tests. |
| 25 | The in-sandbox adapter applies bounded native configuration and inspection. | RFC author: `MEMBER` | Align with clarification | `/opt/nemoclaw/bin/runtime-control` is short-lived and handles one typed operation. | Contract and package owners | 3–7 | Protocol, timeout, replay, effect, and package conformance tests. |
| 26 | The package helper is not a compute driver, policy authority, credential component, or supervisor. | RFC author: `MEMBER` | Align with pinned-version exception | `runtime-control` cannot call host APIs, supervise the admitted entrypoint, or make lifecycle decisions. The current Deep Agents Code session cleanup wrapper and OpenClaw and Hermes entrypoint loops are separately classified compatibility debt, not helper operations or a public extension point. | Security and OpenShell owners | 3–8 | Image boundary checks and lifecycle E2E showing OpenShell-owned entrypoint identity plus bounded package-descendant cleanup and recovery. |
| 27 | Agent runtime updates affect later materialization, not a running revision by mutable tag. | RFC author: `MEMBER` | Align | Records bind exact package and image digests. V1 adds no activation switch and does not mutate running sandboxes. | State and release owners | 3–8 | Exact receipt, rebuild, restore, and rollback tests. |
| 28 | NemoClaw keeps logical provider selection while OpenShell keeps credential custody. | RFC author: `MEMBER` | Align | Logical provider intent stays core; package input contains only approved references/placeholders. | Inference, credential, and OpenShell owners | 3–8 | Provider-switch, credential rewrite, and leak tests. |
| 29 | Messaging remains the product channel boundary, not an independently released credential module. | RFC author: `MEMBER` | Align | Core keeps channel manifests, enrollment, provider profiles, policy, state, forwarding, and hooks that execute and interpret status and health probes. Packages render native configuration and provide data-only health declarations. | Messaging and package owners | 4–8 | Deterministic OpenClaw/Hermes channel tests and unsupported Deep Agents Code rejection. |
| 30 | A package may request restrictions or access but cannot grant itself permission. | RFC author: `MEMBER` | Align | Required access is input to core compilation; OpenShell owns effective enforcement. | Policy and security owners | 3–8 | Required-policy and denied-access tests. |
| 31 | Pin exact package, image, OpenShell, driver, platform, provenance, and qualification identity. | RFC author: `MEMBER` | Align | The release set and sandbox receipts bind the complete tuple plus capability cohort and checked-in support status. | Release and state owners | 3–8 | Exact-identity package and live E2E artifacts. |
| 32 | Prove the contract with materially different runtimes before broadening it. | RFC author: `MEMBER` | Align | Deep Agents Code proves a terminal runtime; managed Hermes proves an agent runtime that runs an agent gateway. | Contract and package owners | 4–6 | Both pass the same package-contract checks and applicable existing-lifecycle suite. |
| 33 | Migrate Deep Agents Code before the default runtime. | RFC author: `MEMBER` | Align | Deep Agents Code is the first runtime extraction. | Deep Agents Code owner | 4 | Package-local tests and full applicable E2E. |
| 34 | Migrate Hermes as the gateway-oriented proof. | RFC author: `MEMBER` | Align with scope limit | Only managed Hermes moves. Portable Hermes and the tool gateway broker remain separate. | Hermes owner | 5 | Managed no-messaging lifecycle, dashboard, MCP, state, and deterministic channel tests. |
| 35 | Move OpenClaw after two representative consumers. | RFC author: `MEMBER` | Align | OpenClaw moves after the common contract freezes and retains its first/default behavior. | OpenClaw owner | 7 | Full OpenClaw parity including plugin, pairing, rebuild, snapshot, and cleanup. |
| 36 | Permit external integrations only after the first-party contract is proved. | RFC author: `MEMBER` | Align for sequencing | External artifact transports and repository handoff follow the qualified in-tree release. | Product and release owners | 9 | In-tree rollback tuple plus accepted external decision. |
| 37 | Pi and DeepSeek Harness should use the common contract before support. | RFC author: `MEMBER` | Defer | Pi packaging and any new runtime support require separate acceptance. The current Pi candidate decision is not enough. | Product owner | Later | Runtime-specific accepted issue and complete qualification. |
| 38 | Do not require foundational removal of `RuntimeProviderBundle`. | RFC author: `MEMBER` | Align | Foundation records consumers and convergence targets; it does not delete behavior without parity. | Core and OpenShell owners | 1, 3–10 | Facet ledger and removal gates in section 7. |
| 39 | Validate strict schemas, deterministic compilation, and authority boundaries. | RFC author: `MEMBER` | Align | These are core and conformance-kit requirements. | Contract and security owners | 3–8 | Unit, integration, package-contract, and E2E-support suites. |
| 40 | Separate OpenShell driver conformance from NemoClaw agent E2E. | RFC author: `MEMBER` | Align | Evidence records both the exact OpenShell/driver layer and package-backed product journey. | OpenShell and E2E owners | 8 | Two-layer exact receipts for every accepted matrix tuple. |
| 41 | Every declared capability drives applicable lifecycle and denial E2E. | RFC author: `MEMBER` | Align | The existing typed E2E planner selects package capability journeys; no second catalogue is added. | E2E and package owners | 4–8 | Registry support tests and exact live target results. |

### Unresolved RFC divergence

The major unresolved difference is source classification after the in-tree release. Discussion 9909
says first-party integration source remains in NemoClaw. The requested program wants to move each
qualified package to another repository later. This plan does not hide that difference:

1. V1 packages are first party and in-tree.
2. The in-tree release must qualify before handoff.
3. A move requires a new decision.
4. Unless maintainers explicitly define another classification, the moved package becomes an
   external integration even if NVIDIA maintains its repository.
5. Technical compatibility, repository ownership, or prior qualification cannot silently preserve
   first-party or supported status after the source and release boundary changes.

## 3. Repository-member review reconciliation

The first review comment is from `cv`, whose GitHub author association is `MEMBER`. It is not an
accepted answer.

| # | Review request | Association | Disposition | Design response | Owner | Phase | Acceptance evidence |
|---:|---|---|---|---|---|---:|---|
| C1 | Give the root CLI, OpenClaw plugin, and every real package a unique package identity and public/private declaration. | `MEMBER` | Request changes | The workspace preparation slice resolves the current duplicate `nemoclaw` identity before runtime extraction. | Build and release owners | 3 | Package graph test rejects duplicate names and undeclared publication status. |
| C2 | Adopt npm workspaces; keep separate lockfiles only for independent sandbox-image graphs. | `MEMBER` | Request changes | One root `package-lock.json` links every source workspace, including the relocated OpenClaw plugin. An existing `package-lock.json` may remain inside a runtime-image subtree that is not an npm workspace only when it reproduces an independent image dependency graph and records its image consumer and reason. A source workspace cannot add a nested lock. | Build owner | 3 | Clean root install, workspace graph, no-nested-workspace-lock check, and isolated image-build tests. |
| C3 | Separate developer setup from deterministic packaging. | `MEMBER` | Request changes | Setup may link the CLI and install hooks; clean build and pack do neither and run from a clean checkout. | Contributor tooling and release owners | 3 | Clean-checkout pack succeeds without contributor setup side effects. |
| C4 | Define shipped contents and test install from the generated tarball. | `MEMBER` | Request changes | Each package has an explicit path/type/mode/digest contract and is installed into an empty temporary project from its archive. | Package and release owners | 3–8 | Package-contract lane verifies archive inventory, installation, and public entrypoints. |
| C5 | First give the OpenClaw plugin a distinct identity, then migrate Deep Agents Code. | `MEMBER` | Request changes | Identity preparation precedes Deep Agents Code; OpenClaw runtime behavior still moves after two representative consumers. | OpenClaw plugin and Deep Agents Code owners | 3–4 | Unique plugin artifact plus Deep Agents Code package qualification. |
| C6 | Keep onboarding, messaging providers, policy, state, and OpenShell coordination in main NemoClaw for now. | `MEMBER` | Request changes, aligned boundary | Core retains product workflow and authority. Only bounded runtime-native rendering and reconciliation move. | Core, messaging, policy, state, and OpenShell owners | 3–8 | Candidate disposition ledger and cross-boundary import tests. |

The proposed design incorporates all six requests, but they remain unresolved review conditions until
maintainers accept the design and owners.

## 4. Second review reconciliation

The second review comment is from `ljefford2-cmyk`. GitHub reports author association `NONE`. The
content identifies trust-contract gaps and should be evaluated on its technical merits, but it is not
a repository-member acceptance record.

| # | Review request | Association | Disposition | Design response | Owner | Phase | Acceptance evidence |
|---:|---|---|---|---|---|---:|---|
| L1 | Distinguish an executor-claimed helper result from an independently observed postcondition; name the producer and observation limit. | `NONE` | Request changes | Pilot requests and receipts record intent, executor claim, independent observation when available, producer identity, limits, and the accepted state assertion. Forwarding a helper digest does not make it independent. | State, contract, and security owners | 4–6 | Evidence-schema tests plus mutations where helper claim and independent observation disagree. |
| L2 | Resolve whether the helper applies configuration or returns a plan because that choice determines evidence meaning. | `NONE` | Request changes | V1 permits bounded apply operations, but every result remains executor-claimed until an independent path observes the effect. Each operation declares its accepted observation rule. | Contract and package owners | 4–6 | Per-operation evidence table and conformance cases for claimed-only and independently observed results. |
| L3 | Enforce or detect read-only behavior per operation rather than trusting a declared effect class. | `NONE` | Request changes | Under OpenShell `0.0.106`, every package-helper invocation is mutation-capable. Trusted core/OpenShell descriptor probes own read-only observations. Contract V1 rejects every read-only helper operation and carries no effect-class field. | Security and OpenShell owners | 4–6 | Conformance rejects every read-only helper classification; trusted-probe fixtures prove that helper output cannot satisfy an observation. |
| L4 | Define the consequence of a read-only violation. | `NONE` | Request changes | V1 has no read-only helper promise to violate. An unknown operation or false executor claim fails before product-state publication, preserves redacted incident evidence, and may justify a reviewed release-set revocation. | Security, product, and release owners | 4–8 | Fault-injection tests drive failure and selection denial; release-set fixtures prove revocation and rollback. |
| L5 | Separate immutable qualification from revocable support status. | `NONE` | Request changes | Qualification evidence never changes. A separate core-owned release-set field can mark an exact tuple `supported`, `revoked`, or `superseded`. | Product and release owners | 3 | Catalogue fixtures preserve evidence references across reviewed status changes. |
| L6 | Define owners, triggers, new and existing workload effects, supersession, and rollback. | `NONE` | Request changes | The accepted release policy names decision owners, incident triggers, blocks on new materialization, handling for running sandboxes, replacement authority, and rollback tuple. A normal reviewed NemoClaw change records the decision. | Product, security, and incident owners | 3, 8–10 | Table-driven static release-set tests and one release rollback exercise. |

These requests explain why compatibility, qualification, and current support are separate objects in
the technical plan.

## 5. Refreshed repository deltas

The original proposal inventory remains measured at `c7af3734`. The design was refreshed against
`a5486894`. These intervening changes affect package boundaries or validation without expanding V1.

| Commit | Current behavior | Reconciliation |
|---|---|---|
| `01bf567dad29` | Hermes Discord uses an endpointless core provider profile and exact sandbox-scoped REST/WebSocket credential bindings. | Provider profiles, channel enrollment, bindings, policy, and health-probe hooks stay core. The Hermes package owns native Discord configuration and data-only health declarations. |
| `17b3834049fc` | Rebuild and GPU replacement wait for affirmative final OpenShell lifecycle release before replacement restart. | Lifecycle release and provider republish stay core through the OpenShell client; helper success is insufficient. |
| `57bfe878e904` | Full uninstall can retire exact Hermes Portable schema-5 Ollama authority with a resumable fail-closed transaction. | Portable Hermes remains outside `packages/nemoclaw-hermes` and outside the common helper contract. |
| `92487dbc04e4` | Amazon Bedrock adapter stop and cleanup fail closed on unproven authority. | Provider adapter lifecycle and uninstall remain core, not agent runtime package behavior. |
| `bd90ad61209` | Pi's accepted candidate trust boundary is bound to contract checks. | This authorizes only candidate validation. Pi package placement, standard-catalog inclusion, and support remain deferred. |
| `e47ee5dc4dac` | macOS OpenShell installation validates Homebrew formula reuse and preserves trusted binaries. | Add macOS Homebrew reuse to release validation; do not move installer authority into a package. |
| `6e8ada58bd` | OpenClaw post-rebuild doctor retains a five-minute timeout. | Characterization and macOS/Brev lifecycle E2E must preserve this deadline. |
| `e38db20141`, `a5486894c451` | The reviewed `tar` remediation is pinned at `7.5.21` across affected package and image graphs. | Clean-pack and image-content contracts verify `tar` `7.5.21`; moving files cannot drop remediation evidence. |

These changes show why source movement needs an owner ledger. A file whose name contains `hermes` or
`openclaw` may still implement core policy, credential, installer, lifecycle, or support authority.

## 6. Exact OpenShell and platform baseline

This section records repository-owned facts, not available upstream releases.

### 6.1 Supported pin

`nemoclaw-blueprint/blueprint.yaml` sets both `min_openshell_version` and
`max_openshell_version` to `0.0.106`. The migration therefore targets exactly OpenShell `0.0.106`
until an accepted NemoClaw change updates the pin and reruns qualification.

Newer upstream versions can inform design. They are not support evidence.

Tag `v0.0.106` resolves to OpenShell commit
[`c4b500a7de64d0b66e3ee8098f58d14299092162`](https://github.com/NVIDIA/OpenShell/tree/c4b500a7de64d0b66e3ee8098f58d14299092162).
Its `crates/openshell-supervisor-process/src/run.rs` implementation spawns the admitted entrypoint
once, waits for that process once, and returns its exit code. It does not implement the current Deep
Agents Code session cleanup and signal-forwarding wrapper or the OpenClaw and Hermes identity- and
health-aware descendant respawn loops. The in-tree migration therefore retains those three wrappers
as package-local compatibility entrypoints unless the accepted decision instead requires a later
OpenShell pin before their cutover. They remain outside `runtime-control`, cannot call OpenShell,
and have the removal gates defined in the disposition ledger.

### 6.2 Required capability cohort

The current repository requires:

- installed OpenShell components from one coherent `0.0.106` build;
- `request-body-credential-rewrite`;
- `websocket-credential-rewrite`;
- the repository-defined OpenShell MCP policy capability marker;
- managed-image contract version `1`;
- managed-image startup-profile contract version `1`; and
- managed-image capability contract version `1`.

OpenShell `0.0.106` has no structured installed-feature response, so
`src/lib/onboard/openshell-feature-gate.ts` uses exact component identity and bounded marker checks,
then requires authoritative effective-policy application before credential mutation. This is a
compatibility mechanism, not a package capability API. It can be removed only after a pinned
OpenShell release exposes an accepted structured capability contract and the same failure cases pass
E2E.

The shipped managed-image cohort is exactly:

- `openclaw`;
- `hermes`; and
- `langchain-deepagents-code`;

on `linux/amd64` and `linux/arm64`, with exact digest references. Pi remains a candidate outside the
shipped cohort.

### 6.3 Driver and platform matrix

The source-derived matrix proposed for acceptance is:

| Status | Host/platform | Runtime-provider or OpenShell path | Package scope | Evidence requirement |
|---|---|---|---|---|
| Standard managed path | Ubuntu Linux amd64 | Production `docker` bundle and OpenShell Docker driver | All three standard packages | Complete no-messaging journey over the existing lifecycle, plus the exact driver configuration and package/image tuple. |
| Official staging release path | Brev Launchable Linux amd64 | Baked candidate and OpenShell Docker driver | Default OpenClaw | Hosted-inference no-messaging journey, exact candidate identity, and cleanup through the existing protected target. |
| Standard managed path | Linux arm64 | Production `docker` bundle and OpenShell Docker driver | All three standard packages | Multi-architecture startup over the existing lifecycle on exact images; GPU remains a separate dimension. |
| Standard compatibility path | macOS arm64 with Docker Desktop or Colima | Production `docker` bundle and OpenShell Docker driver | Required real-host OpenClaw journey; deterministic coverage for all packages | Install, Homebrew trust, onboard, inference, restart reconciliation, exact receipt, doctor timeout, and cleanup. |
| Standard compatibility path | WSL amd64 | Existing OpenShell and Docker integration selected by current onboarding | Current standard behavior | Deterministic WSL suite and accepted live journey if release policy requires it. |
| Registered compatibility path | Other hosts resolving to `kubernetes` | Production `kubernetes` bundle; no managed-image support and no direct lifecycle facet | No new package support claim | Preserve existing behavior only; any expanded claim needs its own accepted matrix. |
| Candidate, not standard | Linux amd64/arm64 rootless | Activation-gated Podman bundle | No managed package inclusion in V1 | Full protected activation matrix before catalogue admission. Portable Hermes evidence is not admission. |
| Inactive candidate | Windows x64 | OpenShell MXC candidate | OpenClaw native artifact only, not selectable | Exact package, termination, cleanup, recovery, and live E2E gates. |

The standard release decision must say which rows it accepts. Tests against an unaccepted row remain
compatibility or exploratory evidence.

### 6.4 One-client boundary

`src/lib/adapters/openshell/client.ts` already owns common sync and async OpenShell execution, version
parsing, bounded timeout behavior, gateway-scoped sandbox lookup, and SSH-config capture. Direct
OpenShell call sites still exist elsewhere in core.

The migration target is not a new SDK. It is one core-owned compatibility boundary for the exact
`0.0.106` commands NemoClaw uses. Each direct call moves only when the boundary can preserve its
arguments, environment, gateway binding, timeout, redaction, error classification, and test
evidence. Package roots can never import that client.

## 7. `RuntimeProviderBundle` facet dispositions

`src/lib/onboard/runtime-provider/contract.ts` defines fourteen bound surfaces plus identity.
`src/lib/onboard/runtime-provider/current.ts` registers production `docker` and `kubernetes` bundles.
Podman and MXC remain gated candidates. This abstraction is internal core compatibility code, not the
agent runtime contract.

The following disposition is proposed for each facet. “Converge” means retain until the named
OpenShell parity, client migration, and E2E proof exist. “Retain” means the facet still expresses a
current core responsibility. “Remove” means no product behavior is currently implemented by that
facet; removal still needs a source and test proof.

| Facet | Current production consumers | Disposition | Supported OpenShell `0.0.106` parity | One-client target | Exact proof before completion | Removal or review condition |
|---|---|---|---|---|---|---|
| `plan` | `src/lib/onboard/compute/plan.ts`; gateway-start guidance and onboarding consume its projected launcher/driver choice. | Converge | Partial. OpenShell accepts a configured driver, but NemoClaw still selects local versus externally launched gateway behavior. | Core plan compiler emits one driver-neutral request consumed by the OpenShell client. | `full-e2e`, cloud onboarding, macOS onboard, and exact driver-config proof on accepted rows. | Remove the facet only when every consumer reads one admitted OpenShell plan and no separate launcher decision remains. |
| `capabilities` | `src/lib/onboard/host-mount/index.ts`, `src/lib/onboard/managed-image/catalog.ts`, readiness modules, snapshot managed-profile checks, inference routing, and activation validation. | Retain | No complete parity. `0.0.106` does not expose one structured capability response covering these product checks. | Client supplies independently observed OpenShell capabilities where available; core retains product and host capabilities. | Host-mount denial, managed-image multiarch, native qualification, readiness, and snapshot E2E. | Split or remove individual flags only after their consumers use supported structured parity or another core-owned contract. |
| `preflightDoctor` | Sandbox doctor, start, and stop preflight. | Converge | Partial. OpenShell reports command/lifecycle failures; host engine readiness remains NemoClaw work. | OpenShell lifecycle preflight routes through the client; host checks stay in core. | `onboard-repair`, sandbox start/stop, OpenClaw rebuild doctor, and macOS timeout evidence. | Remove lifecycle callbacks after exact client parity; retain host-doctor checks under a simpler core interface if still needed. |
| `gateway` | `src/lib/onboard/compute/plan.ts` checks launcher coherence; `src/lib/actions/sandbox/doctor-system-checks.ts` selects legacy gateway-container inspection. | Converge | Partial. Gateway lifecycle is OpenShell authority; legacy NemoClaw container detection is compatibility behavior. | Client owns gateway identity and inspection; core keeps a bounded legacy migration probe until retired. | Gateway recovery, upgrade, exact main driver config, and legacy keepalive E2E. | Remove after supported upgrades no longer need legacy container inspection and all launcher consumers use the client. |
| `workload` | `src/lib/onboard/managed-workload/onboard-orchestration.ts`, sandbox registration, workload rebuild and clone, snapshot authority, destroy, and registry persistence. | Retain | No. Exact package/image admission and NemoClaw release-set identity are product responsibilities. | Client receives only the already admitted immutable workload request; OpenShell receipt is linked, not substituted. | Managed-image activation, multiarch startup, all three rebuilds, snapshot/restore, and cleanup. | Review after OpenShell exposes exact workload identity, but retain support-catalog and package/image admission in core. |
| `hostLocalInference` | `src/lib/onboard/setup-inference.ts`, `src/lib/inference/llama-cpp/managed-installer.ts`, host-local inference lifecycle, and separate portable Hermes authority modules. | Retain | No complete parity. OpenShell intercepts inference but does not own NemoClaw host model-service installation and qualification. | Provider-neutral inference routes use the client only for OpenShell binding; host service operations stay core adapters. | Inference routing, provider switching, GPU E2E, native runtime qualification, and cleanup. | Split portable Hermes out; remove a service path only after another accepted owner provides install, recovery, and cleanup parity. |
| `lifecycle` | Sandbox start and stop through `actions/sandbox/runtime/lifecycle-runtime.ts`. | Converge | The gateway is authoritative, but local compatibility callbacks remain for current driver paths. | All start, stop, verification, and lifecycle release calls use the OpenShell client. | Sandbox operations, survival, double onboard, rebuild replacement, and final lifecycle-release E2E. | Remove after every accepted driver/platform uses supported OpenShell lifecycle with exact absence/readiness semantics. |
| `mutationAuthority` | Registry helpers guard sandbox registration, inference change, workload rebuild and clone, destroy, provider cleanup, and workload cleanup. | Retain | No. This is core authorization over product operations, not backend execution parity. | Client accepts operations only after this core guard; packages cannot see or extend it. | Negative authority tests plus inference switch, rebuild, clone/snapshot, and cleanup E2E. | Replace only with an equally explicit core operation-authority contract, never a package or driver declaration. |
| `stateMutation` | Hermes Shields runtime state fencing and activation; activation gate validation. | Converge | No supported equivalent with the same operation-scoped fence, publication, rollback, and independent activation proof. | Any OpenShell observation or enforcement call goes through the client; core retains transaction authority. | Hermes Shields configuration, restart, snapshot/restore, rollback, and hostile fence-replay tests. | Remove only after a pinned OpenShell contract proves the complete fence lifecycle and Hermes E2E passes without direct engine mutation. |
| `bootstrap` | `src/lib/onboard/managed-workload/onboard-orchestration.ts` and `src/lib/onboard/sandbox-gpu-create-run-attempt.ts` use authority-store, lifecycle, and routing adapters. | Converge | Partial. OpenShell owns sandbox bootstrap and supervision, but current NemoClaw image/state handoff carries product transactions. | Reduce to one compiled bootstrap request through the client; package helper applies native config only after sandbox creation. | Full E2E, Hermes E2E, Deep Agents Code E2E, managed-image activation, GPU create, and interruption recovery. | Remove provider-specific bootstrap surface after both representative packages and every accepted driver use the same OpenShell request/receipt flow. |
| `snapshot` | `src/lib/actions/sandbox/snapshot/provider-lifecycle.ts`, managed-profile authority, workload clone, and activation validation. | Converge | Partial. OpenShell owns sandbox state, but current exact acceleration, workload, and managed-profile receipts are not fully supplied by `0.0.106`. | Snapshot lifecycle calls route through the client; core links product/package/profile authority. | Snapshot commands, state backup/restore, clone, GPU restore, and all three package restore journeys. | Remove backend observation and mutation only after supported OpenShell parity covers lifecycle generation and exact runtime receipt. |
| `recovery` | No production caller invokes `bundle.recovery`; established bundles currently mark it unsupported. | Remove | Not needed for current behavior. OpenShell recovery exists elsewhere, not through this unused facet. | None; recovery call sites must use the accepted OpenShell client or their existing core owner. | Contract tests prove zero production consumers; full current E2E remains unchanged after removal. | Remove only after the architecture fingerprint confirms zero callers and provider-registration fixtures are updated without dropping another surface. |
| `cleanup` | Destroy execution, sandbox recreate transaction, workload image cleanup, and provider detach ordering. | Converge | Partial. OpenShell owns sandbox deletion and absence; NemoClaw still owns provider rollback and exact locally owned image cleanup. | Sandbox lifecycle cleanup uses the client; provider and workload cleanup remain typed core steps with exact authority. | Full cleanup, rebuild rollback, snapshot cleanup, missing-sandbox, shared-image, and lifecycle-release E2E. | Split instead of deleting until OpenShell proves sandbox cleanup and a core adapter retains exact provider/image ownership behavior. |
| `containerEngine` | `src/lib/onboard/runtime-provider/registry.ts` binds operation-scoped engine identities; `activation.ts` requires the complete scope set for candidates. | Converge | No. This constrains NemoClaw host adapters and prevents ambient engine substitution. It is not an agent package or OpenShell driver selector. | OpenShell operations use the client; any remaining host engine adapter keeps an exact operation-scoped identity. | Docker authority tests, exact driver config, native provider qualification, remote endpoint drift, and cleanup E2E. | Remove an identity only when the corresponding host operation is gone or delegated to a supported OpenShell contract with equal authority proof. |

### Facet-wide rules

- A package descriptor cannot mention a facet or provider ID.
- A future OpenShell release does not change a disposition until NemoClaw updates its exact pin,
  records supported parity, migrates the named consumers, and passes the named evidence.
- The one-client boundary is a routing target, not permission to flatten core product authorization
  into OpenShell.
- Removing `recovery`, the currently unused facet, must not be bundled with behavioral convergence.
  It is a separate, reviewable cleanup.
- The architecture baseline must fingerprint all facet consumers so later repository checks permit
  only reviewed changes and decreases.

## 8. Support catalog, evidence, and effect state model

The **support catalog** is the human-facing name for the core-owned support-catalog records used
throughout this proposal. It is separate from the installed-package compatibility records below.

The reviews require three identities that must not collapse into one another.

### 8.1 Compatibility record

A compatibility record says that one static package artifact passed schema and conformance checks
against one contract version. It may be local and list-only. It does not authorize selection.

### 8.2 Qualification receipt

A qualification receipt is immutable evidence that one exact package, image, OpenShell release,
capability cohort, driver, platform, and test matrix passed at a recorded time. It records:

- executor-claimed and independently observed evidence separately;
- the producer of every observation;
- limitations where the pinned release exposes no independent path; and
- exact artifact and workflow identities.

The receipt is never rewritten after discovery of a later defect.

### 8.3 Checked-in support status

Each standard release-set entry has one core-owned status: `supported`, `revoked`, or `superseded`.
The entry references immutable qualification evidence and records the accountable owner, reason,
effective release, effects on new and existing operations, replacement tuple, and rollback tuple.
Package metadata cannot set this field.

Status changes use the ordinary reviewed NemoClaw pull request and release process. There is no
second eligibility database, append-only decision store, active head, or custom promotion tool. A
candidate is simply a proposed release-set change under test. Required checks and maintainer review
gate merge and release.

New onboard and any rebuild, restore, or recovery that would materialize a `revoked` or
`superseded` tuple fail closed. Running sandboxes are not silently replaced; the incident record
states whether operators may let them continue, must stop them, or may use a bounded recovery path.
Restoring support or selecting a replacement is another reviewed release-set change.

### 8.4 Operation evidence

For each helper operation, the contract records:

- core-owned operation ID and request nonce;
- executor-claimed outcome;
- independently observed outcome when available;
- evidence producer and observation limits;
- accepted product-state assertion; and
- violation consequence.

A mutating helper cannot independently attest to its own effect. OpenShell counts as an independent
observer only for a fact it measures rather than a helper value it relays unchanged.

The initial enforcement rule is deliberately conservative: every package-helper invocation is
mutation-capable. Descriptor-declared probes executed by trusted NemoClaw or OpenShell code provide
read-only product observations. Contract V1 has no read-only package-helper operation and no effect
classification field. A later contract requires a separate accepted design before it can add one.

## 9. Decision checklist

Maintainers can accept this proposal only after they explicitly decide:

- [ ] package roots begin under `packages/`;
- [ ] public install spelling is `nemoclaw harness install <local-artifact>` while internal code uses
      `agent runtime` and reserves `plugin`;
- [ ] standard descriptors register during normal installation without eager image preload;
- [ ] local compatibility remains list-only without a support-catalog entry;
- [ ] the NemoClaw, OpenShell, and package authority split;
- [ ] the bounded, non-supervising `/opt/nemoclaw/bin/runtime-control` boundary;
- [ ] unique package identities, npm workspaces, clean packing, and explicit shipped contents;
- [ ] executor-claimed versus independently observed evidence semantics;
- [ ] V1 rejection of read-only helper operations and trusted core/OpenShell probe ownership;
- [ ] immutable qualification and reviewed `supported`, `revoked`, or `superseded` release-set status;
- [ ] exact OpenShell `0.0.106`, capability cohort, driver, and platform matrix;
- [ ] every `RuntimeProviderBundle` disposition and evidence gate;
- [ ] Deep Agents Code, managed Hermes, then OpenClaw migration order;
- [ ] Pi, NemoCUA, portable Hermes, the Hermes tool gateway broker, package activation or removal,
      registry search, and live messaging remain deferred; and
- [ ] external repository handoff requires a later, separate decision after the qualified in-tree
      release.

The acceptance record must also name the accountable maintainer, contract owner, each package owner,
security owner, release owner, compatibility owner, state owner, artifact-retention owner, and E2E
qualification owner. Until then, all three documents remain proposals.
