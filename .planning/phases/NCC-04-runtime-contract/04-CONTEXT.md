<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 4: Agent Runtime Contract — Context

**Gathered:** 2026-09-03
**Status:** Ready for local-fork execution; any upstream support claim requires a separate accepted
product decision
**Source:** Current package implementation and remaining core integration audit

<domain>

## Architecture Thesis

NemoClaw core composes an installed agent runtime package; it does not implement that agent
runtime. A package owns every rule whose correct result changes when the selected agent runtime
changes. Core owns user intent, package identity, credentials, policy authorization, OpenShell
mutation, durable state, transaction order, rollback, platform readiness, runtime providers, and
serving runtimes.

Core calls a closed set of semantic operations. Packages cannot register lifecycle callbacks or
choose executable paths. A missing operation means that the package does not support that
capability. NeMo Fabric remains one package-owned headless invocation path; it is not the package
contract and does not move control-plane authority out of NemoClaw.

This phase moves the remaining OpenClaw, Hermes, DCode, and Pi behavior to their package roots. It
does not extract runtime providers, serving runtimes, operating-system readiness, or hardware
readiness. Those remain core work in later phases.

</domain>

<decisions>

## Boundary Decisions

- **D-01:** An installed package always resolves to a real `AgentDefinition`. Core stops treating
  `null` as OpenClaw. One isolated legacy-state migration can still translate an old null value.
- **D-02:** Core never switches on `openclaw`, `hermes`, `langchain-deepagents-code`, or `pi` to
  decide behavior. Reviewed release-set data and the isolated legacy migration may name IDs.
- **D-03:** The manifest declares data and supported capabilities. It cannot select a module path,
  callback name, shell fragment, or arbitrary hook.
- **D-04:** A capability maps to one fixed package path and one typed request and result. Core
  verifies the pinned receipt and package tree before and after reading executable helper code.
- **D-05:** Host helpers are self-contained, import-free, code-generation-disabled modules with
  frozen inputs and bounded validated outputs. Core retains execution, credentials, policy,
  rollback, and redacted diagnostics.
- **D-06:** Prefer fixed root-owned commands inside the sandbox when the operation can run there.
  Core passes structured data or environment names, not raw secrets in configuration artifacts.
- **D-07:** Do not introduce `preBuild`, `postCreate`, `onRestart`, `onRebuild`, `preDestroy`, or a
  general adapter registry. The closed operation map grows only in the package slice that wires a
  current consumer and its protecting contract test.
- **D-08:** Use one forward-moving contract. Do not create V1/V2 class names, parallel loaders, or
  compatibility wrappers. Existing package-envelope compatibility metadata remains unchanged in
  this phase.
- **D-09:** Hermes moves first, OpenClaw second, then DCode and Pi. Each step leaves all completed
  packages usable and has a separate rollback commit.
- **D-10:** The user's direction authorizes this local product-scope candidate. It does not create
  canonical NemoClaw behavior or a support claim. Any upstream or supported expansion of
  receipt-verified host execution requires a separate accepted product decision that names the
  trust boundary, accountable maintainer, validation, and rollback.

</decisions>

<contract>

## Finite Integration Points

The contract uses data when data is sufficient, a fixed sandbox command when native mutation
belongs inside the image, and a typed host plan only when core must coordinate a protected host or
OpenShell transaction.

| Responsibility | Package surface | Core responsibility |
|---|---|---|
| Identity, commands, ports, health, state, and static capabilities | `manifest.yaml` | Parse, validate, compose, and persist exact identity |
| Image and process startup | `Dockerfile.base`, `Dockerfile`, `start.sh` | Build the selected bytes and coordinate OpenShell lifecycle |
| Initial native configuration | `runtime/generate-config.sh`, installed at the fixed `/usr/local/lib/nemoclaw/generate-config` path | Validate inputs, deliver credential references, invoke, and verify outcome |
| Runtime configuration changes | Existing package code under `host/` | Add a named typed operation only when the Hermes or OpenClaw slice removes its matching core branch; core then applies the bounded plan transactionally |
| Restore merge | Existing package code under `host/` | Add a named typed operation only when the package slice wires protected restore; core retains atomic apply and rollback |
| Native command grammar | Existing package code under `host/` | Add a named typed operation only when the package slice removes native grammar from core; core retains public intent and execution |
| MCP projection | `host/mcp-adapter.cts` exporting `buildMcpRegistrationCommand` and `buildMcpRemovalCommand` | Own requested state, placeholders, policy, execution order, and rollback |
| Device or account pairing | Package code under `host/` or `runtime/` when required | Add a named typed operation only with the first real pairing migration; core authorizes, executes, and persists safe state |
| Messaging projection | Package code under `host/` or `runtime/` when required | Add a named typed operation only with the first real projection migration; core retains manifest, credentials, policy, and transaction |
| Image qualification | Declarative probes first; a typed operation only if real probes cannot express the requirement | Decide whether the selected image satisfies the requested composition |
| Runtime guards and process control | Fixed package files under `runtime/` | Invoke only named operations and retain lifecycle authority |
| Optional broker service | Package-owned service, such as Hermes `host/tool-broker.ts` | Start it only through a declared fixed service capability; never expose it as a callback |

MCP is the only operation defined by Plan 04-01 because it is the current consumer. Later package
plans name and add an operation only while removing its real core implementation. Not every package
implements every optional surface. The loader reports supported operations from verified files and
manifest capabilities. It rejects unknown operations, unknown exports, excess output, imports,
mutable receipt drift, and a capability without its fixed file.

</contract>

<structure>

## Target Core Tree

The first contract slice adds four focused files. Existing package, lifecycle, runtime, and state
owners stay in place; this phase does not reorganize unrelated core directories.

```text
src/lib/agent-runtime/
├── manifest-types.ts      declarative contract and AgentDefinition
├── manifest-readers.ts    bounded field parsing
├── manifest-loader.ts     definition construction from one pinned package
├── adapter/
│   ├── contract.ts        closed operation names and shared request/result rules
│   ├── schema.ts          bounded request and result validation
│   ├── loader.ts          receipt-bound fixed-path loading and VM boundary
│   └── mcp.ts             first concrete operation map and MCP types
├── package/               catalogue, install, receipts, store, and tree authority
├── lifecycle/             agent-neutral lifecycle coordination
├── runtime/               generic command and version behavior
└── state/                 generic state locking and restore primitives
```

`src/lib/inference/`, current runtime-provider orchestration, platform readiness, operating-system
checks, hardware checks, credentials, policy, messaging manifests, and OpenShell clients remain in
core. They consume typed package results but do not learn native runtime grammar.

## Target Package Tree

The same responsibility names apply to every agent runtime. A package creates only the folders it
uses.

```text
packages/nemoclaw-<id>/
├── README.md
├── package.json
├── manifest.yaml
├── Dockerfile.base
├── Dockerfile
├── start.sh
├── policy-additions.yaml
├── config/                build-time native configuration
├── host/                  finite receipt-verified plan builders
├── runtime/               fixed commands and guards inside the sandbox
├── fabric/                released or package-owned Fabric adapter
├── compat/                upstream-version patches and workarounds
├── plugin/                native runtime plugin, when required
├── policies/              package-owned policy data
├── provider-profiles/     package-owned provider profile data
├── model-specific-setup/  package-owned compatibility data
├── checks/                build and image checks
└── tests/
    ├── config/
    ├── host/
    ├── runtime/
    ├── compat/
    ├── image/
    ├── fabric/
    ├── integration/
    ├── e2e/
    ├── fixtures/
    └── helpers/
```

Six runtime files are required: `package.json`, `manifest.yaml`, both Dockerfiles, `start.sh`, and
`policy-additions.yaml`. `README.md` is the standard authoring guide but is not a registry
requirement. Other directories are responsibility boundaries, not required empty scaffolding. File
names use one or two words when sufficient and a third word only when needed for clarity. Exported
function names use enough words to state the semantic operation.

## Target Test Tree

```text
src/lib/agent-runtime/**/*.test.ts  core contract, security, composition, and synthetic package tests
test/package-contract/              compiled CLI and installed-artifact behavior
test/e2e/                           generic planner, runner, cleanup, and redaction only
packages/nemoclaw-<id>/tests/       all native behavior and package-specific assertions
packages/nemoclaw-<id>/tests/e2e/   package-owned target data and result assertions
```

Core tests may compose a real package as a black-box artifact, but they do not restate native
behavior. Package tests do not import NemoClaw source. Composed tests consume one exact NemoClaw
commit or release artifact.

</structure>

<workflow>

## Contributor Workflow

1. Create the six required runtime files and the standard package README.
2. Declare static capabilities in `manifest.yaml`.
3. Add a fixed host operation only while wiring a current consumer and its tests; otherwise use
   manifest data or a fixed sandbox command.
4. Prove each native operation with package-only tests.
5. Run the published contract suite against the built package.
6. Run composed tests against one exact NemoClaw artifact.
7. Add package-owned data and assertions to the existing typed E2E planner.
8. Run one live edge only when the change crosses Docker, OpenShell, process, filesystem, policy,
   network, or inference boundaries.

Adding a package does not add an agent ID, switch branch, command option, or implementation file to
core.

</workflow>

<scope_fence>

## Scope Fence

Reject a change that adds arbitrary lifecycle hooks, manifest-selected code paths, a second package
or E2E registry, agent-specific core branches, raw credentials in helper input, package-owned
OpenShell mutation, package-owned rollback, empty scaffold directories, or a broad core directory
rewrite. Keep the compatibility migration explicit and isolated until its removal is separately
approved.

</scope_fence>

---

*Phase: NCC-04-runtime-contract*
*Context gathered: 2026-09-03*
