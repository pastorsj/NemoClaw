<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Component Composition Research

**Baseline:** `705372dab8d4d28c0daf058aec1579ffc482db4c`
**Date:** 2026-08-27
**Status:** Decision-ready architecture candidate; no product support is implied

## Executive Conclusion

NemoClaw is not merely a launcher. It is the trusted composition and product control plane above
OpenShell. It selects a known agent runtime, prepares its image and native configuration, connects
credentials and inference through OpenShell, applies policy, records state, and coordinates
recovery and rollback.

The maintainable architecture is not one universal plugin interface. The current code already
contains three strong but different extension seams:

1. **Agent runtime packages** describe and implement a harness inside the sandbox.
2. **Runtime-provider packages** implement the host and OpenShell execution substrate through the
   existing `RuntimeProviderBundle`.
3. **Serving-runtime packages** contribute model-serving catalogue data and typed lifecycle
   adapters.

All three can use the same safe distribution envelope, receipt format, and installed-component
index. They cannot share one meaningful executable callback because their authority, process
location, failure modes, and activation rules differ.

Operating systems and hardware are not installable components. NemoClaw should observe macOS,
Linux, Windows, architecture, DGX Spark, DGX Station, GPUs, drivers, and container engines, then
evaluate those facts against declarative qualification profiles. A host-mutating preparer is a
separate privileged component only when the mutation itself has independent ownership and tests.

NeMo Fabric fits naturally as an optional sandbox-local agent execution and validation capability.
It does not replace NemoClaw onboarding, OpenShell isolation, a runtime provider, a serving backend,
or an always-on agent gateway. The first useful integration is a package qualification pilot, not a
new product execution path.

## Vocabulary

The same word currently refers to several unrelated concepts. The architecture should use these
terms consistently.

| Term | Meaning in this proposal | Example |
|---|---|---|
| Harness | User-facing CLI term for an installable agent runtime package | `nemoclaw harness install openclaw` |
| Agent runtime | The agent process, native config, state, startup, image, and optional native integrations | OpenClaw, Hermes, Deep Agents Code |
| Runtime provider | The host-side execution integration that connects NemoClaw to OpenShell's deployment topology | Docker, Kubernetes, candidate Podman, candidate MXC |
| Container engine | An observed engine used by a provider; not always the provider identity | Docker Desktop, Colima, Podman engine |
| Serving runtime | A local or managed model-serving process and its materialization, lifecycle, readiness, and topology | vLLM, llama.cpp, Ollama, NIM |
| Remote inference provider | An external API protocol, endpoint, credential, policy, and model namespace | NVIDIA endpoints, OpenAI, Anthropic, Bedrock |
| Platform profile | Declarative requirements evaluated against observed OS, architecture, hardware, drivers, and engines | Apple silicon macOS, DGX Spark |
| Host preparer | Privileged code that mutates a host to satisfy a platform profile | DGX Station preparation candidate |
| Composition plan | The immutable pre-mutation result that binds exact components and qualifications | One selected agent + runtime + inference + host facts |
| Fabric runtime | NeMo Fabric's logical invocation/session boundary inside an execution environment | A Fabric adapter session inside a sandbox |

The Fabric term `runtime` must not be confused with a NemoClaw runtime provider or an agent runtime.

## Reconciliation with Latest Main

### Why the previous branch cannot be merged

The preserved migration and current main share base `67aab7ef57`. Since then:

- the preserved candidate changed 1,773 files;
- current main changed 1,806 files;
- a trial direct merge produced 2,189 unresolved paths;
- 1,889 unresolved paths were under `test/` and 213 were under `packages/`.

The initial audit also found overlapping edits that would merge without conflict markers. A raw
conflict count therefore understates the semantic replay risk, and every ported slice must be
compared with current behavior rather than accepted because Git merged it.

The final main refresh added `62f6cb83e5`, which restored fail-closed policy authority, session-owned
route reservations, verified-create checkpoints, and identity-bound cancellation recovery. It
strengthens the proposed core-authority boundary: package code can express intent, but cannot own
policy verification, session state, final registration, or recovery. Commit `705372dab8` then moved
Brave-search configuration discovery without changing a component contract.

Current main added or expanded agent manifests, runtime-provider activation, serving registries,
platform qualification, candidate providers, managed startup, E2E planning, and test organization.
Restoring the old package tree would discard newer product behavior and duplicate registries.

The safe strategy is:

1. keep the preserved branch as behavioral and test evidence;
2. begin from exact current main;
3. port one capability slice at a time;
4. use current files as the source of truth for every moved component;
5. regenerate current test and workflow ownership instead of restoring old runner configuration.

### What remains valuable from the previous branch

The candidate already demonstrated:

- `nemoclaw harness list` and `nemoclaw harness install`;
- an installed-only agent catalogue;
- zero, one, multiple, non-interactive, and resume selection behavior;
- a bounded package copy with link, traversal, ownership, mode, size, depth, and entry checks;
- executable-bit-aware content digests and atomic receipts;
- package structures organized by responsibility;
- package-only and exact-NemoClaw test lanes;
- one complete no-messaging Brev lifecycle;
- package test migration counts and root ownership boundaries.

The old approximately 1,400-line package registry should not return as one file. Its safe traversal,
copy, digest, and receipt behavior should be split into small package-neutral files. Agent-specific
required-file validation belongs in the agent contract.

## Current System Map

### Agent runtimes

The existing `AgentDefinition` already describes most of an agent integration:

- process identity and expected version;
- gateway or terminal commands;
- health and dashboard behavior;
- configuration paths and format;
- inference and MCP capability;
- durable directories, files, locks, and restore strategy;
- image, startup, policy, and plugin paths.

Evidence: `src/lib/agent/definition-types.ts:135-190`.

The remaining coupling is discovery and executable behavior:

- `src/lib/agent/defs.ts:96` fixes discovery to root `agents/`;
- `defs.ts:120-135` scans only `agents/*/manifest.yaml`;
- `defs.ts:349-377` assumes current repository filenames;
- `defs.ts:401-432` orders OpenClaw specially;
- `defs.ts:435-481` uses OpenClaw as implicit fallback;
- `agents/openclaw/manifest.yaml:143-150` still points to root Dockerfiles, startup, policy, and
  plugin assets through `_legacy_paths`.

Current tracked agents are OpenClaw, Hermes, LangChain Deep Agents Code, Pi, and experimental
NemoCUA. Their product state is not equivalent. Pi and NemoCUA must not enter an all-agents release
gate merely because a manifest exists.

The largest missing package seam is managed startup:

- `src/lib/onboard/managed-startup/profile.ts:117-125` closes the agent set;
- the profile contains named dashboard, tool, messaging, and config shapes;
- `src/lib/onboard/managed-startup/coordinator.ts:45-99` requires exactly the shipped adapters;
- `src/lib/onboard/managed-startup/image-runtime.ts` selects agent-native config behavior;
- the coordinator's prepare, apply, commit, and rollback transaction is a useful core seam.

The target is not to move the transaction. The target is to let a package translate a validated,
secret-safe startup profile into its native sandbox configuration through a fixed, versioned
operation.

Other agent-native hotspots include:

- `src/lib/sandbox/config.ts`
- `src/lib/actions/inference-set.ts`
- `src/lib/shields/index.ts`
- `src/lib/agent/onboard.ts`
- `src/lib/agent/base-image.ts`
- `src/lib/actions/sandbox/process-recovery.ts`
- `src/lib/skill-install.ts`
- `src/lib/actions/sandbox/mcp-bridge-adapters.ts`
- `src/lib/actions/sandbox/channel-status.ts`

Each needs symbol-level classification. A filename containing `openclaw` or `hermes` is evidence to
inspect, not automatic evidence that the whole file moves.

### Runtime providers

Runtime providers have the strongest existing contract. `RuntimeProviderBundle` is explicitly the
sole registration unit at `src/lib/onboard/runtime-provider/contract.ts:657-680` and binds these
surfaces to one provider identity:

1. identity
2. plan
3. capabilities
4. preflight doctor
5. gateway
6. workload
7. host-local inference
8. lifecycle
9. mutation authority
10. state mutation
11. bootstrap
12. snapshot
13. recovery
14. cleanup
15. container engine observation

The identity plus fourteen operational surfaces are already validated and frozen by
`src/lib/onboard/runtime-provider/registry.ts:602-640`. The registry also checks exact authority
before destructive cleanup and host-local inference operations.

Registration and activation are separate by design:

- `src/lib/onboard/runtime-provider/current.ts:12-30` makes Docker and Kubernetes current;
- `activation.ts:91-118` binds platform, agent, acceleration, inference service, journey,
  installer, and qualification evidence;
- `activation.ts:572-607` validates before composition;
- `podman.ts:96-104` documents the remaining candidate qualification work;
- `mxc.ts:121-191` exposes unsupported lifecycle, cleanup, and mutation surfaces.

This contract should be packaged without redesign. The package envelope identifies and installs the
provider artifact. The existing bundle remains the executable contract. Core retains registration
validation, activation, qualification, and destructive-operation authority.

### Serving runtimes

Serving already separates declarative data from executable adapters:

- `src/lib/inference/serving/types.ts` defines models, recipes, presets, provenance, support,
  requirements, and adapter references;
- `adapter-registry.ts` defines materializer, lifecycle, preparation, readiness, and topology
  descriptors;
- `catalog.ts` compiles checked-in YAML against schemas and registries;
- `catalog-loader.ts` validates the compiled catalogue before use;
- `managed-inference/` contains current models, recipes, presets, qualifications, images, and
  schemas.

The serving contract should aggregate these current seams. It should not create another generic
process runner. A serving package owns backend-specific data and implementation. The runtime
provider supplies host or container operations. Core owns the inference route, credentials, policy,
state, reconciliation, and rollback.

Some current recipes and local inference code still assume Docker or switch directly among Ollama,
vLLM, llama.cpp, and NIM. Those are the extraction points. Requirements such as GPU, architecture,
mounts, ports, CDI, and host networking should be expressed as capabilities and satisfied by the
selected runtime provider.

### Remote inference providers

Remote inference is a separate future seam. Current provider definitions, aliases, credentials,
endpoint handling, and agent-facing translation are spread across:

- `src/lib/onboard/providers.ts`
- `src/lib/onboard/inference-providers/`
- `src/lib/inference/config.ts`
- `src/lib/inference/local.ts`

A future remote-provider contribution can be mostly declarative: protocol, endpoint rules,
credential fields, model normalization, health checks, policy destinations, and compatible agent
protocols. Core must keep credential custody, endpoint validation, SSRF and DNS pinning, OpenShell
provider registration, and policy mutation.

Remote-provider extraction should follow agent, runtime-provider, and serving packages. It should
not be folded into the serving contract merely because both produce inference.

### Platform and hardware

`ci/platform-matrix.json` identifies itself as the product-claim source of truth. It records Linux,
Apple silicon macOS, DGX Spark, WSL2, DGX Station, N1x, RTX, and unsupported dimensions with
different evidence and support status.

`src/lib/readiness/platform-qualification.ts` and `src/lib/readiness/types.ts` already model
observations, capabilities, qualifications, findings, and evidence. NemoClaw should continue to
detect:

- host OS and architecture;
- WSL and virtualization state;
- Docker, Colima, Podman, and driver evidence;
- GPU, driver, toolkit, CDI, and memory evidence;
- DGX Spark, DGX Station, Jetson, and N1x markers.

The platform profile asks whether those facts satisfy a named composition. It is data, not code.
Users do not install macOS or DGX Spark.

DGX Station preparation is different because `scripts/prepare-dgx-station-host.sh` mutates the
host. If that code leaves core, it should become a separately trusted host-preparer package with
preflight, plan, apply, verify, rollback, and exact physical qualification. Do not invent a general
host-preparer contract until a second real preparer proves the common operations.

### Messaging, MCP, state, dashboards, skills, and telemetry

These are not new top-level package kinds in the first version. They are either agent-package
capabilities or core authorities.

| Area | Package-owned side | Core-owned side |
|---|---|---|
| Messaging | Native agent config projection, runtime assets, declared channel compatibility | Channel manifests, credentials, conflict checks, policy, transactions, registry, lifecycle coordination |
| MCP | Native render, inspect, register/remove projection, restart instruction | Bridge policy, credential revisions, DNS/address controls, locks, state, authorization, rollback |
| State | Native merge grammar and bounded restore-strategy implementation | Safe path staging, sanitization, backup publication, transactions, independent observation, rollback |
| Dashboard | Native config projection, path, health, and auth capabilities | Port allocation, forwarding, bind safety, tunnels, exposure auth, cleanup, display |
| Skills | Native agent directory layout and package mechanism | User command, safe transfer, policy, persistence, removal intent |
| Telemetry | Native agent config projection and declared transport | NemoClaw diagnostics, secret redaction, secure storage, opt-in, operator-owned receiver policy |

The current messaging system is already manifest-first and transaction-oriented. The agent
discriminator is still closed to OpenClaw and Hermes in
`src/lib/messaging/manifest/types.ts:18-22`. Open that native projection boundary before considering
separately distributed channel packages. Live messaging accounts remain outside this work.

State and backup authority must remain core. Provider snapshot facets are already treated as
untrusted extension output and receive detached data in
`src/lib/actions/sandbox/snapshot/provider-lifecycle.ts`. Agent-native merge implementations can
move, but packages must not receive unrestricted filesystem or publication authority.

## Target Architecture

### Three execution classes

Every contribution belongs to one of these classes:

| Class | Examples | Handling |
|---|---|---|
| Data-only profile | Platform qualification, policy additions, model recipes | Validate in core; never execute |
| Sandboxed package code | Agent config generator, startup, plugin, Fabric adapter | Pin and run only inside the selected OpenShell sandbox or image build boundary |
| Trusted host code | Runtime provider, serving host lifecycle, host preparer | Repository review, exact identity, explicit activation, least authority, qualification |

The common envelope does not erase these trust classes. The type-specific loader and activation
policy enforce them.

### Common distribution envelope

The target source-package format has one small language-neutral file at its root:

```json
{
  "schemaVersion": 1,
  "kind": "agent-runtime",
  "id": "openclaw",
  "displayName": "OpenClaw",
  "version": "0.1.0",
  "contractVersion": 1,
  "manifest": "manifest.yaml"
}
```

Suggested filename: `nemoclaw-package.json`.

The envelope answers only:

- what artifact is this;
- which typed contract validates it;
- which exact version is installed;
- where its manifest lives.

The safe installer performs only:

1. bounded envelope parsing;
2. safe relative-path resolution;
3. complete tree validation;
4. atomic copy;
5. content digest calculation;
6. receipt write and verification;
7. immutable installed identity exposure.

It does not interpret agent, provider, or serving behavior. It does not import arbitrary code.

Do not generalize this installer on the first consumer. Phase 2 implements these properties under
the agent-package boundary. The package-neutral storage layer is extracted only after a second
accepted component kind proves the same behavior. Runtime-provider and serving source packages can
use the envelope for build and release identity before they become runtime-installable artifacts.

Suggested core structure:

```text
src/lib/agent/
├── package-types.ts
├── package-manifest.ts
├── package-store.ts
├── package-install.ts
└── package-receipt.ts
```

These file names state their responsibility and stay within the requested one-to-two-word rule.
Candidate function names should be more descriptive, for example:

- `loadAgentPackageManifest`
- `validateAgentPackageTree`
- `installVerifiedAgentPackage`
- `writeAgentPackageReceipt`
- `loadInstalledAgentPackages`

Installed content begins under:

```text
~/.nemoclaw/packages/
├── objects/
│   └── sha256/
│       └── <content-digest>/
├── active/
│   └── agent-runtimes/
│       └── <agent-id>.json
└── receipts/
    └── agent-runtimes/
        └── <agent-id>.json
```

Package bytes are immutable and addressed by digest. One small validated JSON pointer selects the
active object for an agent ID. A pointer update is atomic, while retained objects make rollback and
resume possible. This is not a multi-version user interface. Garbage collection can remove an
object only after no active pointer, onboarding session, pending route reservation, recreate
journal, pending policy-verification checkpoint, sandbox, rollback record, snapshot, or supported
release references it.

### Type-specific contracts

#### Agent runtime contract

The contract evolves `AgentDefinition` into a versioned, serializable package manifest. It declares
capabilities and bounded sandbox operations rather than requiring every harness to implement every
feature. A candidate outer shape is:

```ts
interface AgentRuntimePackageManifestV1 {
  schemaVersion: 1;
  agent: AgentDefinitionDataV1;
  workload:
    | {
        kind: "managed-image";
        dockerfile: string;
        dockerfileBase?: string;
        startScript: string;
      }
    | {
        kind: "external-image";
        imageReference: string;
        imageDigest: string;
      };
  policy: {
    additions: string;
    permissive?: string;
  };
  operations: {
    configure?: AgentSandboxOperationV1;
    reconcileState?: AgentSandboxOperationV1;
  };
}

interface AgentSandboxOperationV1 {
  kind: "sandbox-command";
  contractVersion: 1;
  command: string;
  inputSchema: string;
  resultSchema: string;
}
```

`AgentDefinitionDataV1` contains the current manifest data without derived filesystem getters or
closed executable adapter unions. `AgentSandboxOperationV1` names an executable already present in
the exact image. It does not register a host callback.

Required responsibilities:

- identity and upstream version;
- runtime kind and entry command;
- image or exact external workload reference;
- baseline policy;
- configuration and state declaration;
- health or terminal smoke behavior;
- inference protocol requirements.

Optional capabilities:

- dashboard
- device pairing
- MCP projection
- messaging projection by channel contract
- skill layout
- native state merge strategies
- telemetry projection
- NeMo Fabric adapter

Registration validates a receipt-bound manifest and adds only that data to the installed agent
catalogue. Agent executable behavior runs in the sandbox or during the accepted image build. Core
passes a versioned, bounded request with package, image, sandbox, and request identity and receives a
bounded result with status, changed resources, and redacted diagnostics. Unknown schema, oversized
output, wrong identity, replay, timeout, or nonzero exit fails the current transaction. Core retains
authorization, transaction, independent postcondition, and rollback decisions.

Package policy files express requested policy intent only. NemoClaw derives and authorizes the
create policy, binds the result to the exact gateway, sandbox, lifecycle, onboarding session, and
agent package identity, and independently verifies a stable effective policy before package or
provider post-create effects run. A pending checkpoint fails closed if package identity, policy
source, session authority, or the observed sandbox changes.

#### Runtime-provider contract

The executable export remains `RuntimeProviderBundle`. No replacement interface is needed. It is
privileged host code that receives process environment and owns lifecycle, mutation, snapshot, and
cleanup callbacks.

The package adds:

- envelope identity and content receipt;
- bundle contract version;
- statically linked implementation identity;
- qualification and activation reference.

In the first version, a runtime-provider source package is independently owned and tested but is
compiled into a reviewed NemoClaw build and explicitly registered by that build. Users cannot make a
new host provider executable by installing an artifact. Registration proves contract shape.
Activation proves accepted supported journeys. These states must not collapse. Dynamic external
host code requires a separate accepted isolation, signing, input-narrowing, failure-containment, and
credential-boundary design.

The existing bundle contract supplies execution inputs and typed result or error boundaries. The
source-package manifest does not add callbacks or a second failure model. Registration rejects an
unknown bundle contract or mismatched identity before the provider can observe host state.

#### Serving-runtime contract

The serving source package aggregates current constructs through a versioned manifest:

```ts
interface ServingRuntimePackageManifestV1 {
  schemaVersion: 1;
  id: string;
  catalog: {
    models: readonly string[];
    recipes: readonly string[];
    presets: readonly string[];
    qualifications: readonly string[];
  };
  implementations: {
    materializers: readonly string[];
    lifecycles: readonly string[];
    preparations: readonly string[];
    topologies: readonly string[];
  };
  readiness: {
    contractIds: readonly string[];
  };
}
```

Catalogue paths and readiness requirements are validated data. Implementation strings must resolve
to descriptors already statically registered in the reviewed NemoClaw build. Unknown or duplicate
references fail before mutation. There is no executable readiness adapter in the current contract;
readiness remains declarative fact and requirement data.

The package contains:

- model, recipe, preset, and qualification catalogue fragments;
- materializer descriptor;
- lifecycle descriptor;
- preparation descriptor;
- topology descriptor;
- declarative readiness contract IDs and requirements;
- optional image and model provenance.

The package declares requirements such as architecture, accelerator, memory, ports, mounts, and
container capability. The runtime provider decides how those requirements become operations.
Materializer, lifecycle, preparation, and topology code is statically linked in v1. A future
data-only catalogue install is possible without enabling dynamic host code.

The current descriptor contracts remain the operation input, result, and failure boundary. The
serving manifest adds no generic executor. Catalogue compilation rejects malformed data; build-time
registration rejects missing or duplicate implementation references; current onboarding and
runtime-provider transactions handle operation failure and rollback.

### Immutable selection receipt

NemoClaw needs one pre-mutation compatibility result, not another execution plan. A candidate type
is:

```ts
interface OnboardingSelectionReceiptV1 {
  schemaVersion: 1;
  agentRuntime: {
    id: string;
    packageVersion: string;
    contractVersion: number;
    contentDigest: string;
  };
  runtimeProvider:
    | {
        source: "established";
        id: string;
        bundleContractVersion: number;
      }
    | {
        source: "activated";
        id: string;
        bundleContractVersion: number;
        activationIdentity: string;
      };
  inference: {
    selection: InferenceSelection;
    selectionDigest: string;
    source:
      | { kind: "remote-route" }
      | {
          kind: "serving-profile";
          profileId: string;
          profileSource:
            | {
                kind: "core-catalog";
                provenanceDigest: string;
              }
            | {
                kind: "package";
                packageId: string;
                packageVersion: string;
                contentDigest: string;
              };
          hostLocalInferenceReceipt?: string;
          hostLocalProvenanceDigest?: string;
        };
  };
  host: {
    readinessSchemaVersion: string;
    readinessDigest: string;
    platform: string;
    architecture: string;
  };
  policyIntentDigest: string;
  credentialIntentDigest: string;
}
```

The production type should reuse the normalized, secret-free `InferenceSelection` and current
receipt and provenance types rather than duplicate or weaken their fields. Its selection must equal
the `InferenceRouteReservationAuthority.selection` carried through pending and final registry state;
the receipt stores only credential environment names, never credential values. `established`
represents the current Docker and Kubernetes-named external-gateway bundles before package
activation records exist. `core-catalog` represents current serving profiles before serving source
packages move. The important property is explicit identity at each edge.

Candidate function names:

- `resolveOnboardingComposition`
- `validateComponentCompatibility`
- `freezeSelectionReceipt`
- `recordCompositionReceipt`

The resolver checks, in order:

1. installed package receipt matches content;
2. package and typed contract versions are understood;
3. runtime activation permits the selected agent and observed platform;
4. required runtime surfaces exist;
5. selected remote route or serving service is supported;
6. serving requirements pass readiness;
7. serving protocol and model capabilities meet agent requirements;
8. policy and credential intent can be authorized;
9. every exact component has acceptable qualification evidence.

Any failure returns a reason before mutation. The frozen selection receives a digest and becomes an
input to the existing onboarding, policy, credential, runtime-provider, serving, and state
transactions. It owns no operation, commit, rollback, or second lifecycle record. Durable state
links its digest to the existing operation and transaction receipts produced later.

## Ideal In-Tree Structure

```text
packages/
├── nemoclaw-contracts/
│   ├── schemas/
│   ├── fixtures/
│   └── tests/
├── agent-runtimes/
│   ├── nemoclaw-openclaw/
│   ├── nemoclaw-hermes/
│   └── nemoclaw-langchain-deepagents-code/
├── runtime-providers/
│   ├── nemoclaw-runtime-docker/
│   ├── nemoclaw-runtime-kubernetes/  # existing external-gateway topology
│   └── nemoclaw-runtime-podman/
└── serving-runtimes/
    ├── nemoclaw-serving-vllm/
    └── nemoclaw-serving-llama-cpp/
```

Pi, NemoCUA, MXC, Ollama, NIM, and host-preparer packages enter only after accepted scope. A folder
in this tree is not itself a support claim.

Only `agent-runtimes/` produces user-installable artifacts in v1. `runtime-providers/` and
`serving-runtimes/` are independently owned build-time source packages whose host code is included
in a reviewed NemoClaw build. The root workspace, build, packed-artifact `files` list, and release
workflow must include every declared package explicitly; current root publication includes no
`packages/**` source.

`nemoclaw-contracts` is authoring and conformance tooling, not a fourth component kind and not a
runtime-installed component. It contains language-neutral schemas, hostile fixtures, and a
conformance runner. It remains internal until a later decision publishes compatibility promises.

### Agent package story

```text
nemoclaw-openclaw/
├── README.md
├── nemoclaw-package.json
├── manifest.yaml
├── package.json
├── package-lock.json
├── tsconfig.json
├── Dockerfile.base
├── Dockerfile
├── start.sh
├── policy-additions.yaml
├── config/
├── sandbox-runtime/
├── host-setup/
├── compatibility/
├── plugin/
├── package-checks/
└── tests/
    ├── config/
    ├── sandbox-runtime/
    ├── host-setup/
    ├── compatibility/
    ├── image/
    ├── integration/
    ├── fixtures/
    └── helpers/
```

The root reads as a workflow:

1. `README.md` explains the integration and contributor commands.
2. `nemoclaw-package.json` identifies the distributed artifact.
3. `manifest.yaml` declares the agent contract and capabilities.
4. `package.json`, its lock, and language configuration define reproducible authoring, build, and
   package-local test commands.
5. `Dockerfile.base` pins the upstream dependency layer.
6. `Dockerfile` assembles the NemoClaw-managed image.
7. `start.sh` is the visible sandbox entry point.
8. `policy-additions.yaml` declares the baseline network contribution.
9. Responsibility folders contain implementation detail only when needed.
10. `tests/` follows the same responsibilities.

This is the standard managed-image OpenClaw example, not a universal list of required files. An
exact external-image agent can omit Dockerfiles and `start.sh` when its manifest supplies the
accepted immutable workload identity and entry behavior. Python packages add `pyproject.toml` and a
language lock when needed. All in-tree packages use package-local authoring commands and the root
aggregate verifies that each command runs exactly once.

Do not create empty folders. `config/` owns native configuration translation.
`sandbox-runtime/` owns sandbox commands and guards. `compatibility/` owns code tied to an exact
upstream version. `package-checks/` owns build and behavior probes. `host-setup/` is permitted only
as an in-tree migration boundary for code statically included in NemoClaw; it is never loaded from
an installed agent artifact and must either move behind a sandbox operation or receive a separate
accepted host-execution design before repository handoff. Native plugin tests can remain co-located
when that language and plugin system benefit from it.

### Runtime-provider package story

```text
nemoclaw-runtime-podman/
├── README.md
├── nemoclaw-package.json
├── manifest.yaml
├── package.json
├── package-lock.json
├── tsconfig.json
├── src/
│   ├── provider-bundle.ts
│   ├── provider-plan.ts
│   ├── host-doctor.ts
│   ├── gateway-control.ts
│   ├── workload-control.ts
│   ├── host-inference.ts
│   ├── state-control.ts
│   └── container-engine.ts
└── tests/
    ├── contract/
    ├── lifecycle/
    ├── state/
    ├── inference/
    └── fixtures/
```

The provider bundle file assembles every existing surface. `provider-plan.ts` owns plan and
capabilities. `workload-control.ts` can own workload, lifecycle, bootstrap, and cleanup until its
implementation size justifies smaller named files. `state-control.ts` owns mutation authority,
state mutation, snapshot, and recovery. The remaining files name gateway, host-local inference,
preflight, and container-engine responsibilities. No file should become a new thousand-line switch.
The compiled entry point is statically linked and registered by the NemoClaw build.

### Serving-runtime package story

```text
nemoclaw-serving-vllm/
├── README.md
├── nemoclaw-package.json
├── manifest.yaml
├── package.json
├── package-lock.json
├── tsconfig.json
├── catalog/
│   ├── models/
│   ├── recipes/
│   ├── presets/
│   └── qualifications/
├── src/
│   ├── serving-bundle.ts
│   ├── model-materializer.ts
│   ├── server-lifecycle.ts
│   ├── runtime-topology.ts
│   └── host-preparation.ts
└── tests/
    ├── catalog/
    ├── lifecycle/
    ├── readiness/
    └── fixtures/
```

The file names mirror the current typed registries and make the execution path visible before the
reader opens a file. Readiness remains catalogue data and qualification contracts, so there is no
invented `readiness.ts` executable. The source package is independently built and tested, but host
adapter code enters the first version only through a reviewed NemoClaw build.

### Platform profiles

Platform data remains in core, grouped by responsibility rather than package:

```text
platforms/
├── profiles/
│   ├── linux-docker.yaml
│   ├── macos-container.yaml
│   ├── dgx-spark.yaml
│   ├── dgx-station.yaml
│   └── wsl-docker.yaml
├── claims/
│   └── platform-matrix.json
└── schemas/
```

This is a target organization, not a request to move the current claim matrix before its consumers
can use generated paths. The key decision is that profile data remains distinct from executable
host preparation.

## CLI and Installer Workflow

### Agent package demo

The agreed user workflow remains:

```bash
bash scripts/install.sh --fresh
```

When no harness is installed, the installer says so and offers two paths:

1. install a harness now by invoking the same `nemoclaw harness install` flow;
2. exit cleanly and run the command later.

The direct demonstration is:

```bash
nemoclaw harness list
nemoclaw harness install
nemoclaw harness list
nemoclaw onboard
```

The first list has an empty Installed section and an Available section containing qualified bundled
choices. Interactive install uses that same Available inventory. The second list reports the exact
installed harness and receipt while retaining the Available section. `nemoclaw agents list` and
onboarding see only installed, selectable harnesses.

Specific and multiple installs remain simple:

```bash
nemoclaw harness install openclaw
nemoclaw harness install hermes
nemoclaw agents list
nemoclaw onboard
```

Selection behavior:

- zero installed: stop before mutation and print `nemoclaw harness install`;
- one installed: select it automatically;
- multiple interactive: show the installed choices;
- multiple non-interactive: require `--agent` unless the established OpenClaw default is installed
  and the compatibility policy retains that default;
- resume: load the session-recorded package digest, even if the active pointer advanced, and fail
  before mutation if the immutable object or session authority changed;
- explicit missing agent: fail before mutation with an install command.

If cancellation happens after sandbox creation, NemoClaw preserves the incomplete sandbox, registry
entry, onboarding session, and referenced package object. The operator continues with
`nemoclaw onboard --resume`; package extraction must not restore deletion by mutable sandbox name.

`nemoclaw agents list` remains for current users and delegates to the installed agent catalogue.
The public install verb stays `harness`, as previously agreed.

### Other component kinds

Do not add one vague `nemoclaw package install` command. Do not name runtime-provider or serving
install commands until those user surfaces and trust models are accepted. In v1 their source
packages are build-time organization, while existing commands such as `nemoclaw host probe` and
`nemoclaw profiles list` expose readiness and serving choices.

List output should distinguish:

- available
- installed
- compatible
- activated, when applicable
- blocked, with a qualification reason

### Installer composition

The current `scripts/install.sh` is over 6,000 lines and still chooses agents, runtime behavior,
host preparation, OpenShell installation, inference, and onboarding through shell branches. It
should become a thin phase driver, not the package framework.

The staged target is:

1. install or prepare the NemoClaw CLI;
2. ask core for a machine-readable install plan;
3. run accepted host prerequisites from that plan;
4. install the selected agent package through `nemoclaw harness install`;
5. invoke `nemoclaw onboard` with the resolved choices;
6. let core own state, recovery, and rollback.

Upgrade behavior has an additional ordering contract. Before an OpenShell upgrade or sandbox
backup, the installer must resolve the session's agent identity, treat legacy `agent: null` as
OpenClaw, make the exact bundled harness available, and reconcile a clean installed copy by receipt.
Backup and rebuild cannot depend on package content that the upgrade has not installed yet.

Pi and NemoCUA remain explicit legacy built-in candidates during the transition. Their existing
qualification gates remain reachable, but they do not appear as standard available or installed
harness packages until separately accepted and packaged.

Existing shell behavior moves only when an equivalent TypeScript plan and test exists. Do not
rewrite the entire installer during package extraction.

## Updates, Compatibility, and Release Ownership

Independent repositories create four version axes:

1. NemoClaw core version;
2. component package version and contract version;
3. OpenShell version and runtime-provider activation identity;
4. upstream agent or serving dependency version.

The system should manage them with explicit evidence, not loose semver hope.

### Required identities

Every supported composition records:

- NemoClaw build identity;
- package kind, ID, version, contract, and content digest;
- upstream agent or backend version;
- image reference and immutable digest;
- runtime-provider bundle contract and activation identity;
- exact OpenShell version and relevant capability cohort;
- platform readiness schema and evidence digest;
- inference route or serving profile provenance;
- qualification receipt and current support status.

### Release set

A core-owned release set selects exact artifact versions and records supported compatibility edges
for one NemoClaw release. It does not enumerate every possible component tuple. It controls
defaults, aliases, menu order, activation, support, revocation, supersession, and rollback.

Qualification evidence is immutable history. Support status can change through a reviewed release
set without rewriting that history. Revocation blocks new mutations for the affected tuple and
preserves explicit recovery guidance for existing sandboxes.

### Continuous compatibility

Each component repository runs:

- package-native unit tests;
- the published contract conformance suite;
- the oldest supported core against the newest package;
- current core against the previous supported package;
- supported schema migration fixtures;
- exact dependency and image provenance checks.

NemoClaw runs:

- current core against last released component artifacts;
- candidate core against candidate artifacts proposed by a release-set change;
- compatibility-edge integration tests;
- named live qualification profiles only when the changed edge requires them.

An update does not become supported because a package published. It becomes supported after exact
artifact verification, composition tests, required live evidence, owner review, and a release-set
change. Failure leaves the last supported tuple available.

## Test Architecture

### Current evidence

Current main already has seven disjoint Vitest projects:

- `cli`
- `integration`
- `installer-integration`
- `package-contract`
- `plugin`
- `e2e-support`
- `e2e-live`

Evidence: `vitest.config.ts:145-277`. The overlap checker at
`scripts/checks/vitest-project-overlap.mts` rejects missing, duplicate, or unexpected ownership.

The audit found exactly 2,602 files across the current seven projects:

| Vitest project | Test files |
|---|---:|
| CLI source | 1,387 |
| Root integration candidates | 778 |
| Installer integration | 22 |
| Package contract | 38 |
| E2E support | 254 |
| E2E live | 86 |
| OpenClaw plugin | 37 |

The table records disjoint project membership and sums to 2,602. Separate semantic inventories,
which overlap those projects, found 183 agent-specific files, 33 runtime-provider files, and 18
serving files.

The 183 agent-specific files are 76 OpenClaw, 73 Hermes, 33 Deep Agents Code, and one nominally
shared manifest test with OpenClaw-specific behavior. This is an inventory, not a move count. Mixed
tests that exercise core credential, policy, messaging, state, or authorization remain in core.
These counts should be regenerated at the start of Phase 3 because main changes quickly.

### Four test levels

#### 1. Package-owned tests

Agent packages own native manifest, config, startup, image, policy, compatibility, health, state
strategy, plugin, and agent-specific security tests.

Runtime packages own bundle assembly, host doctor, gateway, workload, inference, lifecycle, state,
snapshot, recovery, cleanup, and topology tests.

Serving packages own catalogue, schemas, materialization, lifecycle, readiness, topology, images,
models, and provenance tests.

Before the first move, every in-tree package needs a package-local test configuration and canonical
commands, and root `npm test` needs an aggregate runner that discovers every declared package. The
project-membership check must fail when a package suite is missing, overlaps another project, or is
declared but not executed. Current Vitest globs do not include `packages/**`, so moving files before
this runner would create false green CI.

#### 2. Reusable contract suites

Every package runs the same relevant conformance suite for:

- supported envelope and contract versions;
- immutable identity and declared capabilities;
- safe paths, size bounds, and artifact contents;
- required entry points;
- malformed and unsupported negative fixtures;
- no mutation before validation;
- exact platform and image identity;
- oldest-core/newest-package and newest-core/previous-package compatibility;
- supported schema migration and rollback.

#### 3. Core composition tests

Core owns tests that prove:

- exact artifact install into an isolated home;
- `harness list` Installed and Available sections plus installed-only `agents list` and onboarding;
- multiple component coexistence without namespace collision;
- capability matching and clear incompatibility;
- no mutation on failed composition;
- exact receipts in state;
- credentials and policy remain within core and OpenShell authority;
- upgrade, reconcile, rollback, uninstall, and missing-package behavior;
- package-native results are bounded, redacted, and independently checked where required.

Use the current `package-contract` and integration lanes first. Do not add a new Vitest project
unless an existing lane cannot express the boundary.

#### 4. Focused live qualification

Live tests prove only real boundaries:

- installer and host prerequisites;
- claimed Docker, Podman, external-gateway, or MXC behavior;
- OpenShell and sandbox lifecycle;
- host networking and filesystem behavior;
- GPU, driver, toolkit, and CDI readiness;
- real serving process lifecycle;
- exact hardware detection;
- snapshot, restore, rebuild, rollback, and cleanup.

### Avoid the Cartesian product

Use compatibility-edge coverage:

- each supported agent once on canonical Docker + hosted inference + Linux;
- each runtime provider once only when it owns a real live boundary that NemoClaw claims; the
  Kubernetes-named external-gateway bundle uses deterministic and remote-boundary evidence rather
  than native Kubernetes E2E;
- each managed serving backend once on the environment required by its accepted claim and a
  representative agent; an attached endpoint does not inherit a physical hardware gate;
- each claimed OS/hardware profile through install, preflight, and one representative journey;
- a second pairing only when it exercises a different seam;
- one incompatible-composition negative test per component kind;
- one upgrade and reconcile journey per stateful kind.

The existing native Podman qualification can retain its larger promotion matrix. It should not
become the ordinary matrix for every package change.

### Environment responsibilities

| Environment | Evidence |
|---|---|
| macOS | Deterministic suites, package install/discovery, selection resolution, and one representative Docker Desktop or Colima journey when available |
| Operator-supplied Brev/Linux | Optional development-only source-overlay proof for supported agents on Docker, lifecycle, rollback, and cleanup; never a central release target |
| Exact staging Launchable | Release-level installer and default onboarding boundary |
| WSL2 | Deterministic suites and one representative Docker journey when the support claim is accepted |
| Native Windows | Explicit MXC candidate evidence only; not general support |
| DGX Spark | Physical vLLM and llama.cpp qualification with one representative agent |
| DGX Station | Physical preflight, host preparation, backend, agent turn, recovery, and cleanup for each accepted profile |
| N1x and RTX | Recorded gaps until exact physical evidence exists |

The current E2E typed target registry, target catalogue, and their shared workflow planner remain
the only central authorities. Package metadata can generate or feed exact target fragments; it must
not create another hand-maintained registry. Exact staging Launchable owns release-level installer
and onboarding evidence. Generic Brev source-install coverage remains retired from the release
planner.

Live messaging-service tests remain excluded. Deterministic channel config, policy, credential,
migration, state, and failure coverage remains required.

## NeMo Fabric Evaluation

### What Fabric provides

Official NeMo Fabric documentation describes a typed experiment lifecycle:

```text
FabricConfig → plan/doctor → start → invoke one or more turns → stop
```

Adapters normalize results, artifacts, events, and telemetry across supported agent harnesses. They
are discovered from installed descriptor files without importing every candidate implementation.

Sources:

- [NeMo Fabric overview](https://docs.nvidia.com/nemo/fabric/about-nemo-fabric/overview/)
- [Adapter contract](https://docs.nvidia.com/nemo/fabric/adapter-contract/overview)
- [Registration and discovery](https://docs.nvidia.com/nemo/fabric/adapter-contract/registration-and-discovery)
- [Python SDK](https://docs.nvidia.com/nemo/fabric/sdk/python-sdk)
- [Adapter verification](https://docs.nvidia.com/nemo/fabric/adapter-contract/verify-an-adapter)
- [Experimentation CLI boundary](https://docs.nvidia.com/nemo/fabric/experimentation/cli)

The source audit used stable tag `v0.2.0` at commit
`810189732befa2a5a7feb139c935bbd4dfc400a2` and current main at
`019b05a186371226fecf771a53f03d67d0a20518`.

### What Fabric does not provide for NemoClaw

Fabric's runtime is a logical adapter session. Stable `v0.2.0` accepts only the local environment
provider in its runtime implementation, even though configuration schemas discuss future Docker,
OpenSandbox, and Kubernetes environments. Fabric does not currently provision or secure an
OpenShell sandbox for NemoClaw.

Its CLI is documented for experimentation, not as an application API, scheduler, deployment
controller, or always-on gateway manager. The consumer environment remains responsible for
installing Fabric, the harness, its adapter, credentials, and tools.

Therefore Fabric should not become:

- the NemoClaw package envelope;
- the agent runtime contract;
- a Docker, Podman, Kubernetes, or MXC runtime provider;
- a serving backend;
- a platform or hardware abstraction;
- the OpenShell lifecycle authority;
- the messaging or always-on gateway controller.

### Version and semantic gaps

- Stable Fabric `v0.2.0` includes adapters for Claude, Codex, Hermes Agent, LangChain Deep Agents,
  and mini-SWE-agent, but not OpenClaw.
- Fabric's Deep Agents adapter targets the SDK graph, while NemoClaw integrates the Deep Agents Code
  CLI. These are not drop-in equivalents.
- The audited Fabric Hermes dependency is `0.20.1`; NemoClaw currently pins Hermes `0.19.0`.
- Current Fabric alpha main adds a Pi adapter for Pi `^0.84.2`; current NemoClaw pins Pi `0.84.1`.
- No Fabric OpenClaw adapter exists in the audited versions.

These gaps prohibit claiming current package qualification from existing Fabric adapters.

### Candidate first use

The pilot tests whether Fabric is useful as a validation runner for an agent package. It uses two
lanes.

The deterministic lane pins and records:

- Fabric package version and digest;
- adapter package version and digest;
- adapter contract version;
- deterministic fixture identity;
- Python version, OS, and architecture;
- supported and unsupported capabilities.

Without a live sandbox, that lane proves descriptor discovery, valid and invalid planning, doctor
with satisfied and missing requirements, partial start, two ordered successful invokes, invocation
failure, transport failure, normalized and malformed results, two-runtime isolation, and stop.

The bounded live lane then:

1. creates and secures an OpenShell sandbox normally;
2. installs the exact pinned Fabric, adapter, and deterministic fixture inside it;
3. invokes the Fabric SDK;
4. proves declared policy and egress only;
5. injects a synthetic canary secret and proves it is absent from plans, results, events, artifacts,
   logs, command arguments, and persisted state;
6. proves sandbox isolation and complete cleanup.

No real credential is required. NemoClaw's E2E layer verifies the live security and lifecycle
boundary outside Fabric.

Only after that pilot should the team choose a real adapter with exact dependency alignment. Pi is
a plausible future alpha experiment, not a stable first product dependency. Relay and messaging do
not belong in the first Fabric slice.

### Decision after the pilot

The pilot should answer one question: does Fabric materially improve package-level agent invocation
and evaluation evidence beyond the current E2E harness?

If yes, a later decision can retain `execution.fabric` as an optional agent capability and use the
SDK in qualification workflows. If no, keep the Fabric experiment separate and do not add a
NemoClaw product surface.

## Migration Plan Against Current Main

### Phase 2: foundation

1. Port safe traversal, copy, digest, and receipt mechanics into the agent-package boundary; retain
   immutable digest-addressed objects and one atomic active pointer.
2. Move agent required-file validation into an agent package validator.
3. Port oclif `harness list/install` commands and focused tests.
4. Split repository-known agents from installed selectable agents in `src/lib/agent/defs.ts`, while
   keeping Pi and NemoCUA reachable as explicitly gated legacy candidates.
5. Port the zero, one, multiple, non-interactive, and resume onboarding gate.
6. Make `scripts/install.sh` call the same harness install flow and preserve exact bundled refresh,
   resumed-agent selection, and legacy `agent: null` to OpenClaw resolution before pre-upgrade
   backup.
7. Add package-local build and test configuration, a root aggregate runner, exactly-once membership,
   and root publication paths before any test or asset moves.
8. Under the existing onboarding writer lock, bind exact agent package identity before route
   reservation or sandbox mutation. Carry it unchanged through the session, recreate journal,
   pending route reservation, policy checkpoint, and final registry.
9. Resume from the session-pinned immutable package even if the active pointer advanced. Preserve
   the package and existing incomplete sandbox on cancellation; fail before mutation if either
   package content or session authority drifted.
10. Defer the cross-component selection receipt until the runtime-provider source package becomes
    the second accepted consumer.

### Phase 3: agent packages

1. Move current Deep Agents Code assets and native tests.
2. Move current managed Hermes assets and native tests.
3. Freeze only shared config and runtime operations proven by both.
4. Move OpenClaw root legacy assets and plugin.
5. Remove named-agent executable dispatch only after parity.
6. Keep generic package, security, state, and E2E tests in core.

The previous test moves must be regenerated from current main. Current test structure uses execution
lane first and behavior area second; package ownership should preserve that intent rather than
restore stale paths.

### Phase 4: runtime providers

1. Add build-time source-package identity to Docker without moving behavior.
2. Add build-time source-package identity to the existing Kubernetes-named external-gateway
   topology without implying native Kubernetes support.
3. Move implementation files behind package roots while retaining the existing registry.
4. Remove residual provider-name branches through existing surfaces.
5. Keep Podman and MXC non-activated until their current qualification gaps pass.
6. With agent and runtime-provider identities as two real consumers, extract package-neutral
   storage and resolve the first cross-component selection receipt for existing transactions.

### Phase 5: serving

1. Add a serving bundle aggregate over current typed registries and declarative readiness contracts.
2. Package one backend and its catalogue fragments.
3. Express substrate needs through runtime-provider capabilities.
4. Qualify one real backend on accepted hardware.
5. Repeat for each supported backend; keep remote providers separate.

### Phase 6 onward

1. Consolidate declarative platform profiles without changing claims.
2. Decide whether DGX Station host preparation has a second consumer and package contract.
3. Run the bounded Fabric pilot.
4. Establish exact cross-repository artifacts, conformance, qualification, and release-set updates.

## Maintainability Rules

1. One concept has one name across code, manifests, CLI, tests, and docs.
2. A shared abstraction requires two substantially different current consumers.
3. Use existing registries and transactions; do not parallel them.
4. Keep root package entry files visible and move detail into responsibility folders.
5. Create only folders a package needs.
6. Keep file names to one or two precise words; use a third only when needed.
7. Use function and class names that state action and object, generally one to four words.
8. Keep large cohesive security operations intact, but split mixed workflow switches before they
   reach another thousand lines.
9. Package code reports native results; core owns authorization and product truth.
10. Persist exact data identities, not executable objects or credentials.
11. Fail unsupported compositions before mutation.
12. A green contract test does not imply activation or support.

## Risks and Controls

| Risk | Control |
|---|---|
| Arbitrary host code through package discovery | Agent install is data and sandbox code only; provider and serving host code stays statically linked; dynamic host loading is deferred |
| False universal abstraction | Three contracts; require two consumers for shared sub-contracts |
| Installer rewrite regression | Port one planned phase at a time; keep shell behavior until parity |
| State corruption across package updates | Retained digest-addressed objects, exact receipts, immutable selection digest, staged migration, existing rollback ownership |
| Credential exposure | Core/OpenShell custody, secret-free manifests, redacted bounded operations |
| Policy expansion hidden in a package | Explicit policy intent, diff, authorization, reversible apply |
| Unsupported package becomes selectable | Separate install, register, activate, qualify, and support states |
| Test matrix explosion | Contract suites plus compatibility-edge live coverage |
| Stale external package | Release-set pin, dual-direction compatibility CI, owner and support window |
| Platform claim without hardware evidence | Keep current claim matrix authoritative; physical gates |
| Fabric becomes a second orchestrator | Sandbox-local optional SDK use only; bounded pilot decision |

## Decisions Required Before Implementation

Before any implementation, the recorded decision must use status `Accept` and state the reason,
repository placement, accountable maintainer, and validation plan for the exact proposal revision.

1. Which current agents are standard supported packages: OpenClaw, Hermes, and Deep Agents Code
   only, or also Pi?
2. Is Kubernetes a first in-tree runtime-provider package with Docker, or should it remain current
   core code until a second packaging slice?
3. Which serving backend has the available physical environment for the first package pilot?
4. Who owns runtime-provider and serving trusted-code review and activation?
5. Does DGX Station host preparation have an accountable owner and a second possible preparer
   consumer, or should it remain a named core workflow?
6. What artifact transport and authenticity policy is acceptable before external repositories?
7. Which exact Mac, Brev, WSL2, DGX Spark, and DGX Station journeys are release gates rather than
   development evidence?
8. Is the NeMo Fabric pilot test-only, or may it propose an optional `execution.fabric` capability
   after evidence?

## Recommended First Implementation Slice

After the product gate, implement only:

1. the minimal agent envelope, digest-addressed objects, and safe agent package store;
2. agent-runtime validation over the current manifest;
3. `nemoclaw harness list/install`;
4. zero, one, multiple, and resume onboarding selection;
5. exact agent package identity, recorded under the current onboarding writer lock and carried
   unchanged through reservation, verified-create checkpoint, cancellation, resume, and final
   registry, without a new cross-component plan;
6. package-local test configuration, root aggregate discovery, exactly-once membership, and root
   publication paths;
7. one self-contained Deep Agents Code package and its current native tests;
8. deterministic Mac validation and, if an operator supplies it, one no-messaging development-only
   Brev lifecycle that does not enter the release planner. Exact staging Launchable remains the
   release boundary.
9. focused core tests for cancel after create, active-pointer advancement, exact digest resume,
   missing or drifted package content, and pending policy-source drift.

This slice proves the architecture with the smallest terminal-agent integration. It does not add
runtime-provider or serving user installation. Their host code remains statically linked even after
their source moves into independently owned build-time packages.

## Evidence Index

| Finding | Current source |
|---|---|
| Agent contract | `src/lib/agent/definition-types.ts:135-190` |
| Agent filesystem coupling | `src/lib/agent/defs.ts:96,120-135,156-167,349-393` |
| OpenClaw legacy paths | `agents/openclaw/manifest.yaml:143-150` |
| Managed startup closed agents | `src/lib/onboard/managed-startup/profile.ts:117-240` |
| Managed startup transaction | `src/lib/onboard/managed-startup/coordinator.ts:121-153` |
| Runtime-provider sole bundle | `src/lib/onboard/runtime-provider/contract.ts:657-680` |
| Runtime-provider validation | `src/lib/onboard/runtime-provider/registry.ts:602-640` |
| Current providers | `src/lib/onboard/runtime-provider/current.ts:12-39` |
| Activation declaration | `src/lib/onboard/runtime-provider/activation.ts:91-118,572-607` |
| Serving contract | `src/lib/inference/serving/types.ts` |
| Serving adapters | `src/lib/inference/serving/adapter-registry.ts` |
| Platform facts | `src/lib/readiness/types.ts`, `src/lib/readiness/platform-qualification.ts` |
| Product platform claims | `ci/platform-matrix.json` |
| Messaging workflow | `src/lib/messaging/AGENTS.md` |
| State authority | `src/lib/state/sandbox.ts`, `src/lib/actions/sandbox/snapshot/provider-lifecycle.ts` |
| Composition state today | `src/lib/state/registry/types.ts:135-234` |
| Session-owned route authority | `src/lib/onboard/types.ts:131-135`, `src/lib/state/registry/route-reservation.ts:131-297` |
| Verified create and policy checkpoint | `src/lib/onboard/sandbox-create/policy-creation-receipt.ts:179-351`, `src/lib/onboard/sandbox-create/orchestration.ts:2032-2237` |
| Cancellation and recovery authority | `src/lib/state/onboard-session.ts:1164-1175`, `src/lib/onboard/sandbox-lifecycle.ts:9-28`, `src/lib/onboard/cancel-rollback.ts:8-50` |
| CLI metadata | `src/lib/cli/command-registry.ts`, `src/commands/agents/list.ts` |
| Test projects | `vitest.config.ts:145-277` |
| Test ownership rule | `test/README.md` |
| E2E registry | `test/e2e/registry/registry.ts`, `tools/e2e/workflow-plan.mts` |
| Extension trust policy | `docs/reference/extension-taxonomy-sdk-readiness.mdx` |

## Final Architecture Statement

NemoClaw should compose exact, typed, qualified components. It should not become a generic host
plugin loader.

The agent package says what runs in the sandbox and how that agent translates NemoClaw intent. The
runtime-provider package says how OpenShell-backed execution is realized. The serving package says
how a model server is materialized and observed. Platform profiles say whether the current machine
can support the requested composition. NemoClaw validates the edges, freezes the plan, authorizes
the transaction, and records exact receipts. OpenShell enforces the sandbox, credentials, network,
and runtime policy.

That division gives each integration a clear home, keeps the user workflow simple, and lets
individual repositories evolve without turning every update into a NemoClaw-wide refactor.
