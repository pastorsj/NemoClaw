<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Runtime Package Technical Plan

> **Status:** Exploratory. This document describes a proposed implementation after the product
> scope gate is satisfied. It does not create a supported package interface.
>
> **Inventory audit:** `c7af3734b9933b2380d7d7e919d625da89096c23`
>
> **Source refresh:** `a5486894c45140259d822625e74d1ccdfce807ee`
>
> **Related:** [engineering summary](README.md),
> [RFC reconciliation](RFC-RECONCILIATION.md), and
> [runtime inventory](RUNTIME-INVENTORY.md).

## 1. Goal and fixed constraints

Move the runtime-native implementation for the three standard managed agent runtimes into
self-contained packages under `packages/` while preserving current behavior.

The first supported outcome contains:

- `packages/nemoclaw-openclaw`;
- `packages/nemoclaw-hermes` for NemoClaw-managed Hermes only;
- `packages/nemoclaw-deepagents-code`;
- `packages/agent-runtime-contract` for shared schemas and conformance fixtures.

Phase 4 adds `packages/nemoclaw-runtime-support` only if an exact Docker build-input inventory proves
one package-neutral payload with at least two current package consumers and existing deterministic
packing cannot supply it. It receives a unique private identity and owns build inputs only; package
ingestion remains in the root CLI. If the proof fails, the workspace is not created.

The design has these fixed constraints:

1. The user experience does not change. OpenClaw remains first and default. Menu labels, order,
   prompts, defaults, `--agent`, `NEMOCLAW_AGENT`, `nemoclaw agents list`, `nemohermes`,
   `nemo-deepagents`, and resulting sandbox behavior remain compatible.
2. The public local-artifact command is `nemoclaw harness install <local-artifact>`.
3. A normal NemoClaw install registers the three standard support-catalog descriptors but does not
   eagerly pull every image.
4. Compatibility and local registration do not confer product support or normal selectability.
5. NemoClaw, OpenShell, and the agent runtime package retain separate authorities.
6. Package source qualifies in-tree before any repository split.
7. The smallest useful interface wins. No package callback, parallel lifecycle, parallel registry,
   second OpenShell client, or second E2E catalogue is introduced.

### 1.1 Terms

- **Agent runtime:** The internal technical term for OpenClaw, Hermes, and LangChain Deep Agents
  Code.
- **Harness:** The literal public compatibility command namespace. It is not the name of the new
  internal contract.
- **Plugin:** Code loaded by an agent runtime's plugin system. The existing OpenClaw plugin remains
  a plugin; an agent runtime package is not one.
- **Standard package:** An exact package selected by a checked-in NemoClaw release-set entry whose
  core-owned status is `supported`.
- **Compatible package:** A package whose static contract can be parsed and validated. This status
  alone permits listing, not selection.
- **First-party package:** Source reviewed, published, qualified, and maintained as part of the
  NemoClaw repository and release process.
- **External integration:** Package source in another repository. This classification requires a
  separate product and lifecycle decision.

### 1.2 V1 non-goals and deferred work

V1 does not include:

- PyPI or Open Container Initiative (OCI) source resolution;
- ambient discovery after `pip install` or `npm install`;
- registry search, package activation, package removal, or multi-version selection;
- moving a first-party package to an independent repository;
- Pi, NemoCUA, portable Hermes, or the Hermes tool gateway broker;
- live Telegram, Discord, WhatsApp, Slack, or other messaging-account qualification;
- a new compute driver or a package-visible `RuntimeProviderBundle`;
- host-loaded JavaScript, TypeScript, Python, or shell callbacks; or
- a new package-owned sandbox or admitted-process supervisor, provider authority, or credential
  store. The three exact existing package-descendant wrappers are bounded compatibility debt, not a
  public extension point.

The accepted Pi candidate trust boundary remains separate. Portable Hermes uninstall and inference
authority remain core lifecycle work. Amazon Bedrock adapter lifecycle cleanup also remains core.

## 2. Current baseline

### 2.1 User-facing selection

`src/lib/agent/defs.ts` discovers trusted manifests under `agents/`, sorts OpenClaw first, and exposes
the current choices and aliases. `src/lib/onboard/agent-selection.ts` presents those choices and
represents the OpenClaw default as `null`. Existing state readers accept that representation.

The migration first characterizes this behavior, then separates storage compatibility from new
writes:

- legacy `null` continues to read as OpenClaw;
- new session and sandbox writes use an explicit canonical runtime ID; and
- an unknown persisted runtime ID fails closed instead of falling back to OpenClaw.

The package catalogue replaces manifest discovery only after those assertions exist. It preserves
the same labels, order, aliases, and default.

### 2.2 Existing reusable contract material

The current repository already has useful declarative seams:

- agent manifests describe identity, image inputs, configuration, health, services, state, and
  capabilities;
- managed-image contracts bind exact image digest, source revision, release, publication cohort,
  platform, startup-profile contract, and capability contract;
- typed state receipts bind runtime provider and workload identity;
- the E2E registry and workflow planner select behavior dimensions without duplicating test logic;
  and
- `src/lib/adapters/openshell/client.ts` centralizes a growing subset of OpenShell process execution.

The package design extends these seams. It does not replace them with a general-purpose extension
framework.

### 2.3 Refreshed behavior constraints

Changes through `a5486894c451` add the following migration inputs:

| Constraint | Current owner | Migration result |
|---|---|---|
| Hermes Discord endpointless provider profile and exact REST/WebSocket bindings | NemoClaw messaging and policy modules, OpenShell credential rewrite | Remains core; the Hermes package renders native channel configuration only. |
| Rebuild waits for affirmative lifecycle release before replacement and provider republish | NemoClaw workflow over OpenShell lifecycle | Remains core and routes through the one OpenShell client boundary. |
| Hermes Portable schema-5 full-uninstall authority | Core experimental/uninstall lifecycle | Excluded from the managed Hermes package. |
| Amazon Bedrock adapter stop and uninstall authority | Core inference and uninstall lifecycle | Excluded from agent runtime packages. |
| Pi candidate trust-boundary artifacts | Core candidate checks | Does not authorize Pi packaging or support. |
| macOS Homebrew formula reuse | Installer trust and OpenShell installation | Included in macOS release validation, not package behavior. |
| OpenClaw doctor timeout of five minutes after rebuild | Core rebuild workflow | Preserved by characterization and live E2E. |
| `tar` `7.5.21` remediation | Root, OpenClaw plugin, image inputs, and package graphs | Included in clean-pack and exact image-content assertions. |

## 3. Authority model

### 3.1 NemoClaw authority

NemoClaw core owns:

- package ingestion, the package store, and exact installed receipts;
- the standard release set and support catalogue;
- user selection, logical provider selection, and generic plan compilation;
- required-policy compilation and named host routes and ports;
- product-state linkage, generation ordering, rollback, and compatibility migration;
- immutable qualification records and reviewed release-set support status; and
- central deterministic, package, and E2E qualification.

NemoClaw may request a sandbox or lifecycle operation. It does not become the durable sandbox
lifecycle authority by initiating the request.

### 3.2 OpenShell authority

The exact pinned OpenShell release owns:

- sandbox lifecycle and durable sandbox state;
- compute-driver dispatch;
- effective network, filesystem, process, and device policy;
- provider and credential custody, binding, and rewrite;
- inference interception;
- supervision of every admitted image entrypoint or direct sandbox execution; and
- authoritative observations exposed by that release.

All core OpenShell operations converge on one NemoClaw-owned client boundary. A package receives no
OpenShell endpoint, command path, host socket, provider credential, or compute-backend selector.

### 3.3 Package authority

An agent runtime package owns only bounded behavior inside its sandbox image:

- validate or render runtime-native configuration from an admitted intent;
- reconcile declared agent-owned files or registrations;
- translate normalized MCP and messaging intent to the runtime's native format; and
- ship data-only native health and readiness declarations for trusted core or OpenShell probes; and
- report a closed, credential-free executor claim for its admitted mutation.

The package helper does not start, stop, signal, replace, or supervise an admitted process. It
does not publish product state, allocate host resources, select support state, choose a provider or
driver, widen policy, or call OpenShell.

OpenShell `0.0.106` starts and waits for an admitted process once; it does not reproduce the current
Deep Agents Code session cleanup wrapper or the OpenClaw and Hermes identity- and health-aware
descendant restart loops. To preserve current behavior, those three exact wrappers move unchanged
with their package as named compatibility debt. Each may manage only descendants of its admitted
process. They are not `runtime-control`, cannot call OpenShell, cannot own sandbox lifecycle, and
are not part of the public package contract. No new descendant wrapper is allowed. Remove a wrapper
only after a later exact OpenShell pin supplies its cleanup, signal forwarding, restart, health,
authenticated replacement, and final-release behavior and the affected E2E matrix passes.

### 3.4 Data crosses the host boundary

Host-side package processing is data-only. NemoClaw may read a descriptor, schemas, digests, and
static assets. It never imports or executes package implementation code in the host process.

Executable package behavior runs only after OpenShell creates the admitted sandbox. It is treated as
untrusted even when the package is first party.

## 4. Repository and npm layout

The initial layout is one repository and one workspace graph:

```text
package.json
packages/
├── agent-runtime-contract/
│   ├── package.json
│   ├── schemas/
│   ├── src/
│   └── tests/fixtures/
├── nemoclaw-openclaw/
│   ├── package.json
│   ├── agent-runtime-package.yaml
│   ├── Dockerfile
│   ├── Dockerfile.base
│   ├── build-inputs.manifest.json
│   ├── build-inputs/
│   ├── runtime/
│   ├── controller/
│   ├── openclaw-plugin/
│   └── tests/
├── nemoclaw-hermes/
│   ├── package.json
│   ├── agent-runtime-package.yaml
│   ├── Dockerfile
│   ├── Dockerfile.base
│   ├── build-inputs.manifest.json
│   ├── build-inputs/
│   ├── runtime/
│   ├── controller/
│   └── tests/
└── nemoclaw-deepagents-code/
    ├── package.json
    ├── agent-runtime-package.yaml
    ├── Dockerfile
    ├── Dockerfile.base
    ├── build-inputs.manifest.json
    ├── build-inputs/
    ├── runtime/
    ├── controller/
    └── tests/
```

The conditional `nemoclaw-runtime-support/` workspace, when the two-consumer inventory requires it,
contains only `package.json`, an exact content manifest, and the package-neutral build inputs named
by that manifest.

Each package owns its complete Docker recipes. A package `build-inputs.manifest.json` records every
remaining core-owned Docker source by authoritative source path, package snapshot path, owner,
mode, and digest. `build-inputs/` contains only those immutable build-time snapshots. Core remains
the source owner; a changed source or snapshot requires a reviewed package digest and full image
requalification. An exact input already supplied by `nemoclaw-runtime-support` is referenced there
instead of copied again.

The exact package names are decided during the workspace preparation slice, but each must be unique.
The current root CLI and OpenClaw plugin cannot both continue to publish as `nemoclaw`. Every
workspace declares whether it is private or publishable.

The root uses npm workspaces and one root `package-lock.json` for source workspaces and local
linking, including the relocated OpenClaw plugin. A runtime-image subtree that is not an npm
workspace may retain its existing `package-lock.json` only for an independently reproduced image
dependency graph. Each exception names the image consumer and reproducibility reason in the
package contents contract. A source workspace cannot add a nested `package-lock.json`.

Developer setup and packaging stay separate:

- setup may install Git hooks, link a development CLI, and prepare local tooling;
- build creates deterministic compiled output;
- pack runs from a clean checkout with a declared environment; and
- a package-contract test opens the generated archive, verifies every path, type, mode, size, and
  digest, installs it in an empty temporary project, and invokes only declared public entrypoints.

Source-copy tests use a temporary workspace envelope containing the root workspace manifest and
lock, the selected package and contract sources, and only the other manifests required to preserve
workspace links. They copy no sibling runtime source. The root lock and envelope are repository
test metadata outside the canonical package tree; external repositories supply their own
repository-level lock without changing the qualified package-tree digest.

The workspace conversion is preparation, not the package architecture itself. It should not move
runtime behavior before package identities and packed contents are stable.

## 5. Package descriptor

### 5.1 Required shape

The descriptor is strict, versioned, credential-free, and contains no command supplied for host
execution. A representative shape is:

```json
{
  "schemaVersion": 1,
  "package": {
    "id": "nvidia.nemoclaw.openclaw",
    "version": "<exact-version>",
    "sourceRevision": "<40-hex-sha>",
    "contentsSha256": "<sha256>"
  },
  "agentRuntime": {
    "id": "openclaw",
    "displayName": "OpenClaw",
    "version": "<runtime-version>",
    "interaction": "agent-gateway"
  },
  "compatibility": {
    "agentRuntimeContract": 1,
    "runtimeControlProtocols": [1],
    "openshell": "0.0.106",
    "managedImageStartupProfiles": [1],
    "managedImageCapabilities": [1]
  },
  "images": {
    "linux/amd64": "<repository>@sha256:<digest>",
    "linux/arm64": "<repository>@sha256:<digest>"
  },
  "services": [],
  "state": [],
  "settings": [],
  "capabilities": [],
  "requiredPolicy": []
}
```

The production schema supplies bounded lengths, canonical ordering, allowed identifier syntax, and
closed objects. It rejects unknown behavior-bearing fields.

### 5.2 Descriptor may declare

The descriptor may declare:

- exact identity and compatibility versions;
- exact image digests for admitted platforms;
- runtime interaction kind: terminal or agent gateway;
- named in-sandbox services and health endpoints;
- native state roots and schema versions;
- bounded non-secret settings;
- capabilities such as MCP rendering or a supported channel renderer; and
- required access that NemoClaw may compile into a policy request.

### 5.3 Descriptor may not declare

The descriptor may not contain:

- a host command, callback, module path, or install hook;
- a raw credential or host environment projection;
- a Docker, Podman, Kubernetes, or OpenShell endpoint;
- a compute-driver or sandbox-provider selector;
- an effective policy grant;
- a host mount outside a core-defined named resource;
- support status, menu order, alias, or default authority; or
- an unpinned image tag as runtime identity.

### 5.4 Installed package receipt

Successful ingestion writes an atomic receipt that includes:

- source kind `local-artifact`;
- source file digest;
- canonical package-tree digest;
- descriptor digest and identity;
- validated file inventory and unpack limits;
- schema and helper protocol versions;
- exact image references;
- installation timestamp; and
- validation result.

It does not claim support or qualification. A separate checked-in release-set entry links an exact
installed package to immutable qualification evidence and a core-owned support status.

## 6. Support catalogue and release set

The catalogue is the sole selection source. It has two layers.

### 6.1 Exact package records

Package records describe installed static artifacts. A local artifact gets a record only after full
validation; a missing exact standard artifact is unavailable until it is present. Compatibility is
derived from the descriptor and release-set tuple rather than stored in another lifecycle field.
None of these facts is a product support decision.

### 6.2 Standard release-set entries

The repository-owned release set pins, for each standard runtime:

- canonical package ID and exact package-tree digest;
- descriptor version and digest;
- familiar menu label, order, aliases, and default status;
- exact platform image digests and managed-image publication cohort;
- exact OpenShell release and required feature markers;
- admitted driver and platform tuple;
- startup-profile and capability-contract versions;
- immutable qualification receipt identity;
- core-owned `supported`, `revoked`, or `superseded` status and decision reference; and
- last-qualified rollback tuple.

Only this layer can make a package normally selectable. Standard labels and aliases cannot be
claimed by a local package.

A normal NemoClaw installation includes or installs the three exact standard descriptors. It may
validate their metadata without pulling all sandbox images. Image materialization occurs when the
user selects a runtime and platform, or through a later explicit preload feature.

### 6.3 Compatibility commands

`nemoclaw harness list` shows catalogue records and clearly separates:

- standard and supported by the checked-in release set;
- standard but unavailable, revoked, or superseded; and
- locally registered and compatible but list-only.

`nemoclaw agents list` delegates to the same query and renders the current compatibility format. It
does not populate another registry.

The initial command surface is deliberately small:

| Command | V1 behavior |
|---|---|
| `nemoclaw harness install <local-artifact>` | Validate and atomically register one exact local artifact. Never make it selectable by itself. |
| `nemoclaw harness list` | Show standard and local package records with support and compatibility clearly separated. |
| `nemoclaw agents list` | Preserve the current view over the same catalogue. |
| `nemoclaw onboard` | Preserve current selection and onboarding behavior. |

Package activation, deactivation, update, removal, registry search, and external pull commands are
deferred.

### 6.4 Support status

Qualification is immutable historical evidence. Current support is a simple core-owned field in the
checked-in release set: `supported`, `revoked`, or `superseded`.

A reviewed status change must name:

- the accountable product or incident owner;
- the trigger, such as a vulnerability, compromised artifact, provenance failure, invalid
  qualification, contract violation, false executor claim, or package-helper mutation outside the
  accepted operation scope;
- effects on new selection, rebuild, restore, recovery, and already-running sandboxes;
- the replacement or rollback tuple; and
- incident evidence and user remediation.

Revocation never edits the qualification evidence. It changes the release-set entry through the
normal NemoClaw review and release process. Existing workloads are not silently mutated. Operations
that would materialize a revoked or superseded tuple fail closed unless the accepted incident plan
permits a bounded recovery action. There is no separate eligibility database or promotion service.

## 7. Local artifact ingestion

`nemoclaw harness install <local-artifact>` follows this sequence:

1. Open the path without following an untrusted final link.
2. Use the reviewed direct `tar@7.5.21` dependency to inspect and extract into a bounded temporary
   directory with strict entry filters.
3. Reject absolute paths, traversal, links, devices, sockets, unexpected file types, duplicate
   canonical paths, excessive files, excessive expansion, and unsupported modes.
4. Parse the descriptor as data and validate its closed schema.
5. Verify every declared digest and the canonical package-tree digest.
6. Reject a collision with a standard package ID, label, or alias unless the artifact is the exact
   release-set package already installed.
7. Verify compatibility with the current contract without executing package code.
8. Atomically commit the artifact to the content-addressed store and write its receipt.
9. Return the existing receipt for an exact repeat.

An interrupted ingestion leaves no authoritative partial record. A failed validation removes only
its temporary extraction. The package store does not download an image during metadata ingestion.

PyPI and OCI may later transport the same canonical package tree. They must not change the
descriptor or helper contract. Their trust, identity, signing, retention, and namespace rules need
separate acceptance.

## 8. Fixed in-sandbox helper

Every package image exposes `/opt/nemoclaw/bin/runtime-control`.

The helper is a short-lived executable. OpenShell starts it for one admitted operation and remains
the supervisor. The helper reads one bounded request, performs one bounded runtime-native action,
writes one bounded response, and exits before the operation deadline.

It is not:

- a daemon or resident controller;
- a child-process supervisor;
- an OpenShell or compute-backend client;
- a generic shell command runner;
- a source of credentials; or
- the authority for sandbox, service, or product lifecycle state.

### 8.1 Protocol envelope

Phase 3 defines negotiation only. Its request binds:

- supported protocol versions;
- package receipt, image, and sandbox identity;
- request nonce and deadline;
- closed size and framing limits.

Its response binds the same nonce and identities, one negotiated version, or one closed error. It
contains no native operation, intent, effect, evidence, or lifecycle field.

After the two pilots prove shared behavior, a Contract V1 operation request may additionally bind a
core-owned operation ID and normalized credential-free intent. The existing core transaction admits
and sequences the call without exposing a new transaction or generation field to the package. Its
response contains only:

- the request nonce and identities;
- exit classification;
- executor-claimed changes and digests;
- executor-claim producer identity and limitations; and
- redacted structured diagnostics.

Independent observations are separate core/OpenShell evidence records. A package response cannot
label any field independently observed.

Free-form package output is treated as credential-bearing diagnostic material. It is bounded,
redacted, and not persisted as product state.

### 8.2 Operation contract

Phase 3 freezes only the executable path, negotiation envelope, framing, bounds, deadlines, identity
binding, errors, redaction, and deny-by-default behavior. It does not invent a complete operation
catalogue before a package uses it.

Deep Agents Code adds the first provisional runtime-native operations. Managed Hermes then
implements the same applicable operations and supplies the second real consumer. Phase 6 keeps only
the intersection proved by both packages. The target V1 set is deliberately limited to two
mutation-capable requests: `reconcile-native`, admitted by the existing core shared-state
transaction for native configuration and supported MCP or messaging translation; and
`prepare-native-state`, admitted by the existing snapshot, rebuild, or restore transaction for
pre-snapshot and post-restore reconciliation. Phase 6 drops either request if both pilots do not
prove it. Session preparation, activity, auto-approval, native diagnostics, and any other
single-runtime behavior stay package-internal or on their current path.

MCP and messaging remain capabilities in the core-owned normalized intent. A package that does not
support one rejects it before mutation. Hermes and OpenClaw retain deterministic positive messaging
coverage; Deep Agents Code retains deterministic rejection. Terminal connection and gateway
connection use existing OpenShell sandbox operations; the helper does not supervise sessions.

### 8.3 Mutation and observation

Under the pinned OpenShell `0.0.106` boundary, every invocation of package-supplied
`runtime-control` is mutation-capable. V1 carries no effect-class field. Its diagnostics and output
are executor claims and cannot establish product state.

Read-only product observations use descriptor-declared health, readiness, process, service, and
state probes executed by trusted NemoClaw or OpenShell code without invoking package-supplied
executable code. OpenShell `0.0.106` has no per-exec filesystem, process, or identity policy, so
Contract V1 rejects read-only helper operations. A later contract requires a separate accepted
design and a named core- or OpenShell-enforced restriction. A package declaration, general sandbox
policy, or helper-produced digest is insufficient.

If a later qualified read-only operation mutates configuration, state, or process identity, the
operation fails closed, the evidence records the violation, and maintainers can revoke the exact
tuple in a reviewed release-set update. Historical qualification remains unchanged.

Where OpenShell `0.0.106` cannot independently observe a native effect, the receipt says
executor-claimed and limits the product-state assertion. Passing a helper-produced digest through
NemoClaw does not make it independent.

### 8.4 Failure and retry

Requests bind a nonce and the exact package, image, and sandbox identities. A replayed, mismatched,
late, or oversized response is rejected. V1 does not automatically retry a helper operation. The
existing core transaction must reconcile an interrupted effect before it issues a new request.

The helper cannot decide rollback. It reports bounded facts. NemoClaw chooses the product rollback
plan and OpenShell performs lifecycle actions.

## 9. Existing lifecycle integration

The package does not introduce a new lifecycle state machine. Existing NemoClaw product workflow
and OpenShell lifecycle remain the sequence owners.

### 9.1 Install and selection

1. Normal installation registers the exact standard release set.
2. The user selects the same familiar agent runtime through onboarding inputs.
3. NemoClaw resolves one exact package with `supported` status and its platform image.
4. An unavailable or unknown identity fails with remediation. It never falls back to another
   runtime.

### 9.2 Plan and create

1. NemoClaw compiles package-neutral product intent, required policy, logical providers, ports,
   routes, and rollback steps.
2. The single OpenShell client submits the admitted sandbox request.
3. OpenShell selects the configured compute driver, creates durable sandbox state, applies effective
   policy and provider bindings, and starts its supervisor.
4. OpenShell runs bounded helper operations inside the sandbox as needed.
5. OpenShell supervises every admitted image entrypoint or direct sandbox execution. Under
   `0.0.106`, the applicable exact package-descendant compatibility wrapper remains inside that
   admitted process.
6. NemoClaw records product linkage only after required OpenShell observations and helper evidence
   meet the operation's acceptance rule.

### 9.3 Start, stop, restart, and recovery

NemoClaw issues product intent through the same OpenShell client. OpenShell owns lifecycle state and
each admitted process. `runtime-control` cannot signal or relaunch one. The three named descendant
wrappers may retain only their current cleanup or recovery behavior because `0.0.106` lacks parity;
this is package-internal compatibility debt, not another host or sandbox lifecycle API.

The migration preserves the current distinction between process restart and sandbox restart. It
also preserves the refreshed rule that replacement waits for affirmative lifecycle release before
provider republish or replacement startup.

### 9.4 Rebuild, snapshot, and restore

NemoClaw binds the exact old and proposed package, image, state schema, OpenShell, driver, provider,
and policy identities before mutation. OpenShell performs lifecycle and durable-state operations.
The package migrates only declared native state within the admitted generation.

A failed replacement keeps the prior exact sandbox authoritative. Rollback compensates package,
policy, provider, port, route, state, and registry contributions in the order recorded by the core
workflow.

### 9.5 Cleanup

V1 keeps current sandbox destroy and full NemoClaw uninstall behavior. It does not add package
removal. Package availability, sandbox deletion, snapshot retention, and durable-state deletion are
separate decisions.

Portable Hermes full-uninstall authority and Bedrock adapter cleanup remain core and do not become
package helper operations.

## 10. State, credentials, policy, MCP, and messaging

### 10.1 State

New sandbox and rebuild records bind:

- canonical agent runtime ID;
- exact package, descriptor, package-tree, and image digest;
- helper protocol and native state-schema version;
- settings digest;
- OpenShell release, feature cohort, driver, and platform;
- policy and logical provider references;
- immutable qualification receipt; and
- release-set revision and exact entry identity at materialization time.

Legacy state continues to read through characterized compatibility logic. Unknown runtime or package
identity fails closed. A package never writes NemoClaw's host registry directly.

### 10.2 Evidence

Product-state receipts separate:

- requested intent;
- executor-claimed result;
- independently observed postcondition when available;
- evidence producer;
- observation scope and limitation; and
- accepted state assertion.

The mutating helper's report is never relabeled as independent evidence. OpenShell evidence is
independent only for facts OpenShell actually observes rather than forwards unchanged.

### 10.3 Credentials

NemoClaw compiles logical credential requirements. OpenShell owns provider configuration, secret
custody, binding, and rewrite. A package receives only credential-free intent and admitted
placeholders.

No raw credential enters a descriptor, package receipt, ordinary helper request or response,
qualification artifact, NemoClaw log, or unencrypted snapshot. Interactive runtime authentication,
if separately accepted, is a sensitive nonpersistent stream and is not part of the initial common
contract.

### 10.4 Policy

NemoClaw compiles the product-required minimum. A package may declare needed access or narrower
defaults. OpenShell applies and enforces effective policy. A package cannot remove a restriction or
grant access.

Policy templates remain core when they express product enrollment, credentials, or shared channel
security. Runtime-native executable paths and configuration translation can move with the package.

### 10.5 MCP

NemoClaw owns normalized MCP intent, logical credential references, required policy, journaling,
rollback, and trusted probe execution and interpretation. OpenShell owns credentials and
enforcement. The package owns native MCP rendering and data-only probe declarations.

The helper receives neither an OpenShell API nor arbitrary MCP host commands. Existing MCP
transaction semantics remain until equivalent package-backed tests pass.

### 10.6 Messaging

NemoClaw retains channel manifests, enrollment, logical credential references, provider profiles,
required policy, registry state, host forwarding, and the hooks that execute and interpret status
and health probes. OpenShell retains credentials, bindings, rewrite, and enforcement. The package
translates admitted channel intent into native runtime configuration and supplies data-only health
declarations.

Hermes Discord's endpointless provider profile and exact REST and WebSocket bindings remain core.
OpenClaw and Hermes retain deterministic channel configuration tests. Deep Agents Code continues to
reject unsupported messaging before mutation. Live service accounts are deferred.

## 11. OpenShell baseline and convergence

The decision baseline is derived from repository-owned source at `a5486894c451`:

- `nemoclaw-blueprint/blueprint.yaml` requires exactly OpenShell `0.0.106`.
- OpenShell tag `v0.0.106` resolves to commit `c4b500a7de64d0b66e3ee8098f58d14299092162`.
  Its supervisor process spawns the admitted entrypoint once, waits once, and returns that exit; it
  has no equivalent descendant cleanup or respawn loop. The current Deep Agents Code session
  wrapper and OpenClaw and Hermes entrypoints therefore remain compatibility debt until a later pin
  proves parity.
- The required installed messaging/MCP feature markers are
  `request-body-credential-rewrite`, `websocket-credential-rewrite`, and the repository-defined MCP
  policy marker in `src/lib/onboard/openshell-feature-gate.ts`.
- Managed-image contract, startup-profile contract, and capability contract are version `1`.
- The shipped managed-image cohort is OpenClaw, Hermes, and LangChain Deep Agents Code on
  `linux/amd64` and `linux/arm64` with exact digests.
- The production runtime-provider registry contains `docker` and `kubernetes`. The local managed
  path selects `docker` on Linux and macOS arm64. The Kubernetes entry is a compatibility path with
  no managed-image support and no direct lifecycle facet.
- Podman is an activation-gated candidate. Portable Hermes use does not make it a standard package
  driver. OpenShell MXC on Windows x64 is inactive and unqualified.

The release decision must turn this source-derived baseline into an explicit accepted matrix. The
minimum no-messaging validation matrix is:

| Host or execution environment | Architecture | Current driver path | Required result |
|---|---|---|---|
| Ubuntu Linux | amd64 | OpenShell Docker driver | All three standard packages and the full no-messaging lifecycle. |
| Official staging Brev Launchable | amd64 | Baked candidate and OpenShell Docker driver | Default OpenClaw no-messaging journey, exact candidate identity, hosted inference, and cleanup. |
| Linux | arm64 | OpenShell Docker driver | Exact multi-architecture image startup and package conformance for all three. |
| macOS with Docker Desktop or Colima | arm64 | OpenShell Docker driver | OpenClaw install, onboard, inference, restart reconciliation, exact receipt, and cleanup; Homebrew reuse trust. |
| WSL with Docker Desktop or qualified local Docker path | amd64 | Production `docker` bundle and OpenShell Docker driver | Deterministic install and lifecycle regression suite. |

Kubernetes, rootless Podman activation, Windows MXC, GPU-specific hosts, and live messaging remain
separate behavior dimensions unless the accepted release matrix adds them.

`src/lib/onboard/runtime-provider/contract.ts` remains core-only. Packages cannot implement or
select a `RuntimeProviderBundle`. Each facet's consumer, disposition, parity gate, client route, E2E
proof, and removal condition are recorded in [RFC-RECONCILIATION.md](RFC-RECONCILIATION.md).

The convergence rule is simple: remove no facet merely because upstream OpenShell has a similar
feature. First pin a supported OpenShell release with exact parity, migrate its current consumers
through the one client boundary, and pass the affected supported E2E journeys. Until then, overlap
is compatibility debt rather than a package API.

## 12. Testing and evidence ownership

### 12.1 Core deterministic tests

Core owns tests for:

- menu labels, order, prompts, default, flags, environment input, aliases, and legacy state;
- support-catalog identity, standard-name collision, static support status, revocation, and supersession;
- local artifact archive hardening, content-addressed receipts, atomicity, and idempotence;
- descriptor and closed-schema validation;
- plan determinism and the NemoClaw/OpenShell/package authority split;
- one OpenShell client boundary and decreasing direct-call budget;
- no package-to-core, package-to-OpenShell, or package-to-compute-backend imports;
- helper framing, deadlines, replay, evidence status, effect violation, redaction, and fail-closed
  behavior;
- state normalization and migration; and
- deterministic messaging behavior without external accounts.

### 12.2 Package tests

Each in-tree package owns:

- native configuration and migration unit tests;
- exact packed-contents and independent install tests;
- image build, file inventory, dependency, vulnerability, and provenance tests;
- runtime-control protocol and hostile-input tests;
- runtime-specific MCP, channel rendering, health-declaration, diagnostics, and state tests; and
- package-specific E2E fixture logic.

Each package must build and run its detailed tests after its package root is copied outside the
NemoClaw checkout. This catches undeclared repository-root imports before externalization is
considered.

### 12.3 Shared conformance

`packages/agent-runtime-contract` owns fixtures and a runner for:

- descriptor and canonical tree identity;
- clean packing and install from the generated archive;
- exact platform image identity;
- helper protocol negotiation, framing, timeout, replay, and interruption;
- rejection of every read-only package-helper operation and every operation outside
  `reconcile-native` and `prepare-native-state`;
- executor-claimed and independently observed evidence semantics;
- credential and diagnostic redaction;
- state-path and traversal attacks;
- configuration reconciliation and idempotence; and
- terminal-agent and agent-gateway interaction shapes.

The conformance runner proves compatibility. NemoClaw-owned qualification decides support.

### 12.4 Live E2E

Use the existing typed E2E registry, target catalogue, free-standing jobs, and workflow planner.
`tools/e2e/workflow-plan.mts` remains the one planner for `.github/workflows/e2e.yaml`.
Managed-image activation remains in `.github/workflows/managed-images.yaml` and contributes an
executed artifact bound to the same revision and release-set digest. Do not install a package's
entire E2E suite on an end-user machine or create a second test catalogue. `suiteIds` are reporting
metadata and do not establish an executed lifecycle result.

Each standard package must pass applicable journeys for:

- `nemoclaw harness install`, installed-package discovery, and package availability without eager
  image pull;
- interactive and noninteractive onboard;
- inference and one agent turn;
- stop and start;
- process restart or sandbox restart as currently supported;
- snapshot and restore;
- rebuild and replacement rollback;
- exact cleanup;
- credential non-disclosure and denied undeclared access; and
- exact package, image, policy, OpenShell, driver, feature-cohort, and qualification identities.

OpenClaw E2E also preserves its five-minute post-rebuild doctor timeout. macOS E2E covers Homebrew
formula-reuse trust. Hermes lifecycle E2E proves final OpenShell release before provider republish.
Package/image assertions verify `tar` `7.5.21` wherever the reviewed runtime graph requires it.

Live messaging accounts are not part of this release gate. Existing deterministic messaging tests
and fake endpoints remain mandatory.

Release qualification aggregates current behavior owners instead of adding one general-purpose
lifecycle target. Managed-image activation supplies all-three onboard, agent-turn, gateway-restart,
and cleanup results. `full-e2e`, `hermes-e2e`, `rebuild-openclaw`, `rebuild-hermes`, and
`snapshot-commands` retain their current responsibilities. The `mcp-bridge` Deep Agents shard
supplies successful Deep Agents Code rebuild and its post-rebuild tool call. The typed Deep Agents
target retains invalid-credential rejection before destructive rebuild work. Add only the missing
public package install and discovery boundary, Hermes snapshot/restore, Deep Agents Code
snapshot/restore, and the macOS `full-e2e` restart-reconciliation assertion.

### 12.5 Release evidence

A release-set change that adds or replaces a supported tuple requires:

- deterministic test results;
- exact package archive and canonical tree digests;
- exact multi-platform image digests and publication cohort;
- software bill of materials and accepted provenance;
- exact OpenShell component identity and required feature markers;
- driver/platform E2E receipts;
- executor and independent-observer evidence classification; and
- an accepted support decision recorded in the reviewed release-set change.

Green compatibility tests without an accepted support decision do not establish support or permit
the release-set change to ship.

## 13. Migration plan

### Stage 0: behavior and architecture baseline

Characterize the current selection, compatibility, and state behavior. Classify every candidate
inventory row as move, split, keep, or delete. Record exact symbol and path fingerprints for runtime
name branches, cross-boundary imports, direct OpenShell calls, and `RuntimeProviderBundle` consumers.

This stage changes no product behavior.

### Stage 1: product decision and ownership

Record Accept, Request changes, Defer, or Decline under the repository decision policy. Acceptance
must identify placement, accountable maintainer, first migration target, validation plan, security
owner, package owners, release owner, compatibility owner, state owner, artifact-retention owner,
and E2E owner. Stage 2 and package implementation cannot begin until this gate passes.

Discussion 9909 is Proposed, has no accepted answer, and does not by itself pass this gate.

### Stage 2: explicit runtime identity

Keep legacy `null` reads for OpenClaw. Make new writes explicit and unknown identities fail closed.
Do not introduce the package installer yet.

### Stage 3: package foundation

Add unique package identities, npm workspaces, deterministic packing, `packages/agent-runtime-contract`,
the release set, support catalogue, content-addressed package store, local artifact ingestion,
`nemoclaw harness install`, catalogue listing, receipts, the bounded non-supervising helper protocol,
and one OpenShell client convergence target.

Register adapters for existing in-tree behavior without changing the user journey. Locally compatible
artifacts remain list-only.

### Stage 4: LangChain Deep Agents Code pilot

Move Deep Agents Code build assets, native configuration, MCP rendering, data-only probe
declarations, state interpretation, and detailed tests under `packages/nemoclaw-deepagents-code`.
Preserve the existing terminal, inference, rebuild, and recovery behavior.

The package must test from outside the repository root and leave no runtime-name executable branch
in core for behavior it owns.

### Stage 5: managed Hermes pilot

Move managed Hermes image, native configuration, dashboard and API configuration, MCP rendering,
channel rendering, state interpretation, cron, data-only health declarations, and detailed tests
under `packages/nemoclaw-hermes`.

Keep portable Hermes, `agents/hermes/host/**`, the tool gateway broker, provider profiles, credential
bindings, host forwarding, policy authority, lifecycle release, and Bedrock lifecycle in core or in
their existing separate boundaries.

### Stage 6: freeze the common contract

Retain shared operations only when both Deep Agents Code and managed Hermes prove them. Move a
single-runtime behavior back behind a package-private adapter rather than expanding the common
contract.

Remove the two pilots' core runtime-name executable dispatch and ratchet architecture budgets.

### Stage 7: OpenClaw extraction

Move OpenClaw image inputs, startup configuration, native policy translation, patches, model setup,
agent-loaded plugins, pairing interpretation, MCP and channel rendering, state interpretation, and
detailed tests under `packages/nemoclaw-openclaw`.

Give the existing OpenClaw plugin a unique package identity under that root. Preserve its built
artifact and behavior. Keep core authorization, support, policy, credential, lifecycle, and rollback
decisions outside the package.

### Stage 8: qualify an in-tree release

Build and qualify all three packages as one exact release set on `linux/amd64` and `linux/arm64`.
Run the accepted all-package Ubuntu lifecycle, deterministic WSL checks, the real Apple silicon
macOS OpenClaw journey on Docker Desktop or Colima, and the official staging Brev default-OpenClaw
journey without live messaging accounts. Prove
prior-release onboard, upgrade, rebuild, snapshot, restore, rollback, recovery, and cleanup.

This release is the repository-handoff rollback point.

### Stage 9: decide and perform externalization

Before moving any package, accept a separate decision covering first-party versus external
classification, repository owner, namespace, transport, trust roots, provenance, retention,
revocation, supersession, security response, and cross-repository release coordination.

Move a package only if its canonical package-tree digest, descriptor, helper protocol, conformance,
and user behavior remain unchanged. Repository-only workflows and provenance metadata may sit
outside that digest.

### Stage 10: continuous compatibility

Monitor NemoClaw, OpenShell, each runtime, inference providers, and messaging-render contracts.
Propose new exact tuples in a normal release-set pull request, qualify that candidate revision
centrally, and merge only after required checks and maintainer review pass. Failure blocks the
change and leaves the last released tuple available for rollback. Do not add a second candidate
catalogue or custom promotion tool.

Pi, NemoCUA, portable Hermes, the Hermes tool gateway broker, public source search, package
activation or removal, and live messaging still require separate decisions.

## 14. Level of effort and line movement

The refreshed audit reports 90,215 production and 140,157 detailed test candidate lines across all
recorded workstreams. The three standard package commitments account for 76,096 production,
130,532 detailed test, and 22,471 dependency-lock lines. These are whole-file review surfaces, not
deletion promises; `split` rows include both retained core authority and package-owned behavior.

| Work | Estimate |
|---|---:|
| Decision, behavior baseline, candidate classification, and architecture budgets | 3–5 engineer-weeks |
| Workspace, package, catalogue, ingestion, helper, evidence, and OpenShell-client foundation | 12–18 engineer-weeks |
| Deep Agents Code migration and qualification | 8–12 engineer-weeks |
| Managed Hermes migration and qualification | 12–18 engineer-weeks |
| Contract freeze and OpenClaw migration | 15–24 engineer-weeks |
| In-tree release, cross-platform E2E, upgrade, and rollback | 8–14 engineer-weeks |
| Later external distribution and continuous qualification | 12–24 engineer-weeks |

The first complete in-tree release totals approximately 58–91 engineer-weeks across the first six
rows. Parallel work across three to four experienced engineers changes calendar duration, not this
engineering-effort range. External distribution follows rather than inflating the first migration.

Expected gross movement for the three standard managed runtimes remains:

| Change | Planning range |
|---|---:|
| Existing production source moved, split, or rewritten | 75,000–95,000 lines |
| Existing detailed tests moved, split, or rewritten | 120,000–150,000 lines |
| New generic core package, catalogue, ingestion, and control code | 8,000–14,000 lines |
| New core contract, security, and conformance tests | 12,000–24,000 lines |
| New package-owned glue and tests | 25,000–45,000 lines across the three package roots |

The migration should prefer moving known code and narrowing interfaces over rewriting working
runtime logic. Temporary compatibility paths are deleted only after equivalent evidence exists.

## 15. Risks and controls

| Risk | Control |
|---|---|
| Package compatibility is mistaken for support. | Only an exact release-set entry with core-owned `supported` status permits normal selection. |
| Package code gains host authority. | Data-only host ingestion; executable behavior stays in the sandbox; no callbacks or OpenShell/backend access. |
| The helper becomes a second supervisor. | Short-lived bounded operations only; OpenShell owns the admitted entrypoint and sandbox lifecycle. |
| Removing current descendant handling changes cleanup or availability. | Move the exact Deep Agents Code session wrapper and OpenClaw and Hermes loops unchanged as named package compatibility debt; keep them outside `runtime-control`; remove them only after exact later-pin parity and lifecycle E2E. |
| A helper result becomes unverified product state. | Separate executor-claimed and independently observed evidence with producer and limits. |
| A package helper is mistaken for a read-only observer. | Treat every package-helper invocation as mutation-capable in V1; use trusted descriptor probes for read-only product observations; require a separately qualified enforcement mechanism before adding any read-only helper operation. |
| Workspace conversion changes shipped artifacts. | Unique identities, clean-pack contents contract, archive install test, and exact file digests. |
| Standard install downloads excessive images. | Register descriptors eagerly; materialize only the selected platform image. |
| Externalization combines migration and supply-chain risk. | Qualify all packages in-tree first and require a separate external-integration decision. |
| OpenShell upstream behavior is assumed supported. | Pin exact release and feature cohort; migrate facets only after repository-owned parity and E2E evidence. |
| Messaging credentials cross into packages. | Core owns channel/provider plans; OpenShell owns credentials and rewrite; packages receive placeholders only. |
| A new abstraction duplicates a working system. | Require two current consumers and name the exact path replaced; reuse existing state, E2E, and OpenShell client seams. |

## 16. Decisions still required

Before Phase 2 or package implementation:

1. Accept or revise this architecture, placement, migration order, and no-experience-change promise.
2. Name the accountable maintainers and operational owners.
3. Accept the exact OpenShell release, feature cohort, driver/platform matrix, and
   `RuntimeProviderBundle` dispositions.
4. Accept helper evidence semantics, the fixed mutation-capable V1 operations, and trusted probe ownership.
5. Accept the support-status, revocation, supersession, and rollback policy recorded through reviewed release-set changes.
6. Decide exact npm package names and which workspaces are private or publishable.
7. Accept the standard package contents and image provenance gates.
8. Accept the deterministic, macOS, WSL, multi-architecture, and Brev no-messaging E2E matrix.

Later, after the qualified in-tree release, maintainers must separately decide external repositories,
PyPI or OCI transports, package activation or removal, Pi, NemoCUA, portable Hermes, the Hermes tool
gateway broker, and live messaging qualification.
