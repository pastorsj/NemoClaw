<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 4: Agent Runtime Contract — Context

**Gathered:** 2026-09-03
**Status:** Local architecture candidate; no supported package API or distribution policy is
approved by this record
**Source:** Current package, adapter, Fabric, package-store, and E2E publication implementation

<domain>

## Architecture thesis

NemoClaw core composes an installed agent runtime package. It does not implement the selected
agent runtime.

A package owns every rule whose correct result changes when the selected agent runtime changes.
Core owns user intent, package identity, credentials, policy authorization, OpenShell mutation,
durable state, transaction order, rollback, platform readiness, runtime providers, and serving
runtimes.

The contract has three forms, in preferred order:

1. Validated manifest data for static facts and capabilities.
2. A fixed sandbox command for native work that belongs inside the image.
3. A finite typed host operation when core must coordinate a protected transaction.

NeMo Fabric is a fourth composition surface with a separate purpose. It runs one package-selected
headless request inside the sandbox. It does not install packages, register host callbacks, mutate
OpenShell, hold NemoClaw state, or replace the typed host contract.

</domain>

<scope>

## Current execution slice

This phase proves the architecture with Model Context Protocol (MCP), then applies the same loader
to runtime configuration and configuration restore operations.

The current slice includes:

- One generic typed adapter contract and receipt-bound loader.
- Seven fixed MCP operations for registration, removal, inspection, mutation capability, teardown
  capability, runtime-intent verification, and runtime command wrapping.
- Package-owned MCP command builders for MCP-capable packages.
- A typed validation refusal before adapter load for packages without MCP.
- Removal of package-backed MCP dispatch through core agent-name switches and native fallbacks.
- Three fixed configuration operations for update planning, URL policy, and mutable-file posture.
- One fixed restore operation for package-native configuration merge grammar.
- Synthetic package conformance, source ownership checks, and focused composition evidence.
- Confirmation that the existing Fabric path remains package-selected and agent-neutral.
- A managed-image publication receipt before stock live E2E consumes shipped images.

This slice does not claim that all core code is agent-runtime agnostic. Runtime configuration
still has a compatibility path for sandboxes without a package receipt. MCP also retains
`mcp-bridge/legacy-mutation.ts`, the no-receipt agent-adapter dispatcher, and Deep Agents legacy
configuration helpers and tests. Only OpenClaw uses the package restore operation. Full startup
still depends on `MANAGED_STARTUP_AGENTS`, core profile construction, and the startup coordinator.
CLI grammar, pairing, messaging projection, gateway and dashboard protocols, and other optional
runtime features require later package-by-package migrations.

External package repositories, registry download, publisher authentication, compatibility policy,
and a supported extension API also remain later work. They require an accepted design decision
with an `Accept` outcome before implementation or support claims.

</scope>

<decisions>

## Boundary decisions

- **D-01:** New package-managed state resolves to an explicit `AgentDefinition` and immutable
  package identity. An isolated migration may translate an older representation.
- **D-02:** The typed adapter loader does not choose behavior from `openclaw`, `hermes`,
  `langchain-deepagents-code`, or `pi`. Existing startup and lifecycle switches remain migration
  inventory. Release composition may list package IDs as data.
- **D-03:** A manifest contains data. It cannot select a host adapter module, export, callback, or
  general hook. Validated manifest fields can declare fixed in-sandbox commands.
- **D-04:** Core defines each adapter capability, fixed package path, export name, request schema,
  result schema, and byte limit.
- **D-05:** The loader verifies the pinned package receipt and tree before and after it reads a host
  module.
- **D-06:** Host modules are self-contained and synchronous. The loader provides no import loader,
  disables string and WebAssembly code generation, freezes bounded requests, and validates bounded
  results.
- **D-07:** A host helper returns data or a command plan. Core retains execution, credentials,
  policy, transaction order, rollback, and redacted diagnostics.
- **D-08:** Use a fixed root-owned sandbox command when native mutation can stay inside the image.
- **D-09:** Do not add lifecycle callbacks, an event bus, a general host extension registry, or a
  manifest-selected host adapter.
- **D-10:** Add a semantic operation only with a current consumer, package implementation, and
  negative tests. Delete the native core fallback, or identify the current upgrade boundary that
  requires a narrow compatibility path.
- **D-11:** Use one forward-moving contract. Do not add V1/V2 class names or parallel loaders.
- **D-12:** Fabric remains a package-owned headless path. Core does not import or select Fabric
  adapters.
- **D-13:** Deterministic tests prove semantics. Live E2E proves only external boundaries that a
  local test cannot model.
- **D-14:** A package installation receipt binds local source bytes. A managed-image cohort receipt
  separately binds the shipped image set used by stock E2E.
- **D-15:** This record describes a local architecture candidate. It does not establish supported
  NemoClaw behavior.

</decisions>

<contract>

## Finite integration points

| Responsibility | Package surface | Core responsibility | This phase |
| --- | --- | --- | --- |
| Identity, commands, ports, health, state, and static capabilities | `manifest.yaml` | Parse, validate, compose, and persist identity | Retain |
| Image and process startup | `Dockerfile.base`, `Dockerfile`, `start.sh` | Select bytes and coordinate OpenShell lifecycle | Retain |
| Initial native configuration | `runtime/generate-config.sh` installed at `/usr/local/lib/nemoclaw/generate-config` | Select a member of `MANAGED_STARTUP_AGENTS`, deliver validated inputs, and verify the result | Existing package convention; closed full startup |
| MCP command translation | `host/mcp-adapter.cts` | Authorize and execute registration or removal transaction | Current contract |
| Headless request | Package-owned `fabric.json`, adapter, locks, and manifest command | Select installed package and transport prompt | Verify boundary |
| Runtime configuration update | `host/config-adapter.cts` | Parse, validate, authorize, apply, verify, and restart | Current partial migration |
| Restore merge | `host/restore-adapter.cts` | Own snapshot authority, protected reads, atomic apply, and rollback | Current OpenClaw migration |
| Native CLI grammar | Package `host/` | Retain public intent, timeout, execution, and redaction | Later migration |
| Pairing | Package `host/` or `runtime/` | Authorize, execute, and persist safe state | Later migration |
| Messaging projection | Package `host/` or `runtime/` | Retain shared channel manifest, credentials, policy, and transaction | Later migration |
| Gateway and dashboard protocol | Manifest data plus package `host/` or `runtime/` | Coordinate OpenShell ports and lifecycle | Later migration |
| Image qualification | Declarative probes first; typed plan only if required | Decide whether image satisfies requested composition | Later migration |

MCP defines seven operations:

| Operation | Fixed export | Request | Result |
| --- | --- | --- | --- |
| `register` | `buildMcpRegistrationPlan` | Validated entry, managed entries, mutation flags, and optional configuration directory | Execution, verification, and credential-convergence plan |
| `remove` | `buildMcpRemovalPlan` | Validated entry, removal flags, and optional configuration directory | Execution and removal-outcome plan |
| `inspect` | `buildMcpInspectionCommand` | Validated entry, mismatch behavior, and optional configuration directory | Non-empty inspection shell command |
| `mutationCapability` | `describeMcpMutationCapability` | Validated sandbox name | `not-required` or a bounded command probe with typed success criteria |
| `teardownCapability` | `describeMcpTeardownCapability` | Validated sandbox name | `not-required` or a bounded command probe with typed success criteria |
| `verifyRuntimeIntent` | `describeMcpRuntimeIntentVerification` | Validated entries and managed server names | `not-required` or a bounded command probe with typed success criteria |
| `runtime` | `buildMcpRuntimeCommand` | Validated non-empty argument vector | Typed argument vector for the package runtime |

Core quotes each runtime argument before it builds the bridge-owned shell command. The helper does
not inspect the host, call OpenShell, execute a command, mutate policy, commit state, or choose
rollback.

Runtime configuration defines three operations in `host/config-adapter.cts`:

| Operation | Fixed export | Result |
| --- | --- | --- |
| `prepareUpdate` | `prepareConfigUpdate` | `immutable` result or bounded update transaction plan |
| `classifyUrl` | `classifyConfigUrl` | URL policy flags used by core SSRF validation |
| `describeMutable` | `describeMutableConfig` | `not-required`, `stat`, or bounded probe plan |

OpenClaw, Hermes, LangChain Deep Agents Code, and Pi provide this module. Deep Agents Code and Pi
return `immutable` because their configuration is materialized by the image. A sandbox without a
package receipt can use the current core compatibility path. When a package receipt exists, a
missing, invalid, or receipt-mismatched module fails closed.

Core calls `classifyConfigUrl` once for each URL leaf. The request includes the selected key and
the leaf's relative path, so one allowed leaf cannot authorize its sibling. Validation commands
and mutable-configuration probe or repair commands can prove success only with `exit-zero`. Only
the write command can use `config-transaction`. OpenClaw protects
`["openclaw.json", ".config-hash", "fabric.json"]` in that transaction.

Configuration restore defines `mergeState` as `mergeConfigState` in
`host/restore-adapter.cts`. The result is merged content with a finite write plan, or a typed
refusal. OpenClaw's `config-anchors` plan names `openclaw.json` and `fabric.json` as its hash
inputs, in that order. Core retains snapshot authority, protected reads, atomic apply, and
rollback.

## Adapter call workflow

```text
core receives validated user intent
-> core resolves sandbox package identity
-> loader resolves immutable object and receipt
-> loader validates manifest capability
-> loader validates package tree digest
-> loader reads the fixed host module
-> loader revalidates tree authority
-> loader evaluates the module without passing host capabilities
-> loader validates and freezes the request
-> package builds a bounded result
-> loader validates and freezes the result
-> core retains the receipt-pinned definition and plan across validation
-> core reloads the same identity and plan under the mutation lock
-> core authorizes and executes the transaction
-> core records success or performs rollback
```

The VM reduces accidental capability access. It does not make an installed package safe to treat
as hostile, and it cannot contain an adapter that creates an abandoned rejected promise. Current
in-tree adapters are synchronous and integrity verified. A future external distribution design
must either require trusted synchronous code or isolate adapter execution in another process.
Publisher trust and distribution policy remain separate design decisions.

The core operation map has TypeScript request and result types plus runtime JSON Schemas. Package
adapter `.cts` files are self-contained CommonJS source, and current package TypeScript
configurations do not compile them. Runtime validation and package behavior tests enforce that side
of the boundary.

## Fabric call workflow

```text
core selects the receipt-pinned manifest command
-> core writes the prompt to private standard input
-> nemoclaw-fabric-run owns deadline and process cleanup
-> nemoclaw-fabric validates package-owned fabric.json
-> NeMo Fabric invokes the selected adapter
-> runner bounds, redacts, and returns the result
```

The package owns the Fabric adapter or released-adapter lock, configuration projection, credential
environment names, policy additions, and native tests. The generic runner owns configuration
validation, literal-credential rejection, artifact cleanup, redaction, and result bounds.
Fabric handles only headless request execution. It does not own lifecycle, startup, runtime
configuration, restore, MCP, messaging, pairing, or durable state.

</contract>

<structure>

## Core tree

This phase adds or changes focused files. It does not reorganize unrelated core directories.

```text
src/lib/agent-runtime/
├── manifest-types.ts      declarative data types and AgentDefinition
├── manifest-readers.ts    bounded field parsing
├── manifest-loader.ts     definition construction
├── adapter/
│   ├── contract.ts        typed operation and contract definitions
│   ├── schema.ts          JSON bounds, validation, and freezing
│   ├── loader.ts          receipt-bound fixed-path loading
│   ├── mcp.ts             MCP operation types and schemas
│   └── config.ts          configuration and restore operation types and schemas
├── host-module.ts         MCP loader facade
├── config-module.ts       configuration and restore loader facade
├── package/               discovery, install, receipts, store, and tree authority
├── lifecycle/             shared lifecycle coordination primitives
├── runtime/               generic command, smoke, and version behavior
└── state/                 generic state locking and restore primitives
```

Credentials, policy authorization, messaging manifests, inference composition, OpenShell clients,
platform readiness, hardware readiness, runtime providers, and serving runtimes remain in core.
The managed-startup profile, environment, coordinator, and image apply paths still use the closed
managed-startup agent set. This phase does not add a partial startup planner that those production
paths do not consume.

## Package trees

```text
packages/
├── nemoclaw-fabric/                    generic headless Fabric runner
├── nemoclaw-openclaw/
├── nemoclaw-hermes/
├── nemoclaw-langchain-deepagents-code/
└── nemoclaw-pi/
```

Each agent runtime package uses the same responsibility names and creates only the directories it
needs:

```text
packages/nemoclaw-<id>/
├── README.md
├── package.json
├── manifest.yaml
├── Dockerfile.base
├── Dockerfile
├── start.sh
├── policy-additions.yaml
├── config/
├── host/
│   ├── config-adapter.cts   fixed typed configuration operation, when used
│   ├── mcp-adapter.cts      fixed typed MCP operations, when declared
│   ├── restore-adapter.cts  fixed typed restore operation, when used
│   └── ...                   other package host code with separate consumers
├── runtime/
├── fabric/
├── compat/
├── plugin/
├── policies/
├── provider-profiles/
├── model-specific-setup/
├── checks/
└── tests/
    ├── config/
    ├── host/
    ├── runtime/
    ├── compat/
    ├── image/
    ├── fabric/
    ├── integration/
    ├── fixtures/
    └── helpers/
```

Six runtime files are required: `package.json`, `manifest.yaml`, both Dockerfiles, `start.sh`, and
`policy-additions.yaml`. `README.md` is standard authoring guidance, not a registry requirement.
Only the `*-adapter.cts` files named by the core operation map use the generic typed loader. Other
files under `host/` can implement fixed processes, build probes, or package-internal translation.

File names use one or two words when sufficient. A third word is valid when it removes ambiguity.
Function names state the semantic action and object. Shared responsibility names matter more than
identical file counts.

## Test tree

```text
src/lib/agent-runtime/**/*.test.ts  contract, loader, security, and synthetic composition
test/package-contract/              compiled CLI and installed-artifact behavior
test/e2e/support/                   generic planner, fixture, cleanup, and redaction behavior
test/e2e/live/                      opt-in external boundaries
packages/nemoclaw-<id>/tests/       package-native behavior and composition tests
```

Core can compose a real package as a black box. It does not duplicate native assertions. Package
unit tests do not import core source. Direct `test:nemoclaw` commands use the surrounding checkout.
Only the `scripts/packages/checkout.mts composed` rehearsal names and verifies one immutable
NemoClaw commit.

</structure>

<workflow>

## Package contributor workflow

1. Add the six runtime files and package README.
2. Declare static capabilities in `manifest.yaml`.
3. Put build-time native translation in `config/`.
4. Put fixed in-sandbox commands and guards in `runtime/`.
5. Implement only the MCP, configuration, or restore host operations that the package uses.
6. Add a Fabric adapter and configuration only when it preserves required headless behavior.
7. Add package unit, artifact, Fabric, and negative tests.
8. Pass package-only rehearsal without core source.
9. Pass revision-pinned composition against one immutable revision.
10. Add live E2E data only for a real external boundary.

Adding a package to the covered adapter operations must not require an agent ID branch, command
option, second registry, or native implementation file in core. Full managed startup remains a
separate closed path in this revision.

The package-only rehearsal does not build Docker images. Current package Dockerfiles still consume
shared security and build scripts, the blueprint, the Fabric runner, or the reviewed runtime bundle
from the NemoClaw root build context. OpenClaw and Hermes also consume root messaging or
tool-disclosure source. Pi relies on the root package-contract suite for materialized and packed
artifact proof. These dependencies must gain versioned package inputs or one reviewed build-context
artifact before independent repository extraction.

</workflow>

<scope_fence>

## Scope fence

Reject a change that adds:

- Arbitrary lifecycle hooks or an event bus.
- A manifest-selected host module, export, or callback.
- Raw credentials in adapter input or package configuration.
- Package-owned OpenShell clients, policy mutation, transaction commit, or rollback control.
- A second package catalogue or E2E registry.
- An agent-name switch in ordinary core behavior.
- Empty package folders for visual symmetry.
- A live test for behavior that a deterministic boundary can prove.

</scope_fence>

<completion>

## Current definition of done

The current phase is ready for review after the package-backed MCP path has no native fallback,
the retained no-receipt MCP and configuration paths are recorded, the configuration and restore
boundaries have focused deterministic evidence, all declared gates pass, and any selected live
target records package and managed-image identities.

This condition does not establish product support or claim that all agent-specific code has moved.
The later migration inventory remains explicit and enters this contract one semantic operation at
a time.

</completion>

---

*Phase: NCC-04-runtime-contract*
*Context gathered: 2026-09-03*
