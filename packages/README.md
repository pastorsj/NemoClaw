<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent runtime packages

An agent runtime package contains the native code and assets that connect one agent runtime to
NemoClaw. The public install command retains `harness` in its literal name:

```bash
nemoclaw harness list
nemoclaw harness install
nemoclaw harness install <id>
```

This implementation is a local product-scope candidate. It does not establish a supported package
API, external distribution policy, or compatibility promise. Those claims require an accepted
design decision with an `Accept` outcome, accountable maintainer, and validation plan.

## Architecture thesis

NemoClaw composes an installed package. It does not implement the selected agent runtime.

- Core owns user intent, package identity, credentials, policy authorization, OpenShell mutation,
  transaction order, rollback, durable state, platform readiness, runtime providers, and serving
  runtimes.
- A package owns every rule whose correct result changes when the selected agent runtime changes.
- The manifest supplies validated data.
- Fixed sandbox commands perform native work that belongs inside the image.
- A finite typed host adapter returns a bounded plan when core must coordinate a protected
  transaction.
- NeMo Fabric supplies the package-selected headless invocation path. It does not replace the host
  contract or NemoClaw control plane.

For covered operations, this boundary lets OpenClaw, Hermes, LangChain Deep Agents Code, Pi, and
later packages evolve without adding agent-name branches to core. Other lifecycle paths remain in
the migration inventory.

## Repository layout

```text
packages/
├── README.md
├── nemoclaw-fabric/                    generic headless Fabric runner
├── nemoclaw-openclaw/                  OpenClaw package
├── nemoclaw-hermes/                    Hermes package
├── nemoclaw-langchain-deepagents-code/ Deep Agents Code package
└── nemoclaw-pi/                        Pi package candidate
```

`nemoclaw-fabric` is shared runtime infrastructure. It reads a package-owned Fabric configuration
and invokes the selected Fabric adapter. It does not discover packages or contain an agent
catalogue.

Each agent runtime package follows this workflow:

```text
package identity
-> declarative manifest
-> image assembly
-> native configuration
-> sandbox startup
-> optional host plans
-> package tests
-> revision-pinned composition
-> bounded live qualification
```

The shared folder names state responsibility. A package creates only the folders it uses.

```text
packages/nemoclaw-<id>/
├── README.md              package workflow and compatibility notes
├── package.json           package identity, scripts, and manifest location
├── manifest.yaml          data-only capabilities and runtime metadata
├── Dockerfile.base        pinned upstream dependency layer
├── Dockerfile             NemoClaw image assembly
├── start.sh               sandbox process entry point
├── policy-additions.yaml  baseline network policy
├── config/                native configuration generation
├── host/                  typed adapters and other package-owned host code
├── runtime/               fixed commands and guards inside the sandbox
├── fabric/                released or package-owned Fabric adapter inputs
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
    ├── fixtures/
    └── helpers/
```

File names use one or two words when those words identify the responsibility. Use a third word
only when shorter text is ambiguous. Function names use enough words to state the semantic action
and object. Do not add empty folders to make two packages look alike.

## Package identity

Each package uses the directory name `packages/nemoclaw-<id>`. Its `package.json` names the
manifest:

```json
{
  "name": "@scope/nemoclaw-<id>",
  "version": "1.2.3",
  "nemoclaw": { "harnessManifest": "manifest.yaml" }
}
```

The package name can be scoped or unscoped. Its basename, directory suffix, and manifest `name`
must contain the same ID. The manifest stays at the package root.

Every installable package contains these non-empty regular files:

- `package.json`
- `manifest.yaml`
- `Dockerfile.base`
- `Dockerfile`
- `start.sh`
- `policy-additions.yaml`

`start.sh` must be executable. A package normally includes `README.md`, but the registry does not
require or execute it. The registry rejects symbolic links, invalid metadata, and
credential-shaped build-context paths.

Installation copies reviewed package bytes into the private package store under
`~/.nemoclaw/harnesses`. The store publishes three related records in order:

1. An immutable object addressed by its content digest.
2. An immutable receipt that binds package ID, version, source identity, and content digest.
3. An active pointer for the installed package ID.

The receipt detects changes to tracked paths, file types, file content, and executable bits. It
does not authenticate the publisher or prove package behavior. Treat an installed package as
trusted code. A host helper can receive credential placeholders and can influence a command that
core later executes with the user's OpenShell authority.

Receipt tracking ignores `.git`, `.DS_Store`, `node_modules`, and `__pycache__` entries. A package
helper must not load executable code from those paths.

## Manifest and fixed commands

Use `manifest.yaml` for bounded data that core can validate without executing package code. It
declares identity, commands, ports, health, state, configuration paths, runtime metadata, and
capabilities.

Use `runtime.startup_environment` only for public package constants that must exist when the
agent entrypoint first starts. NemoClaw validates the names and values, rejects credential-shaped
or core-owned keys, and forwards only the selected package's entries. Credentials, proxy settings,
OpenShell identity, and `NEMOCLAW_*` controls remain core-owned.

Use a fixed command inside the sandbox when the package can perform the native operation there.
For managed startup, the image installs `runtime/generate-config.sh` as:

```text
/usr/local/lib/nemoclaw/generate-config
```

The installed command must be a root-owned regular file with mode `0555`. Core invokes that fixed
path. It does not select a native generator by agent ID.

The current managed-startup planner accepts only IDs in `MANAGED_STARTUP_AGENTS`. The fixed command
gives those packages one native configuration entry point, but it does not let a new package enter
managed startup without a core change. Profile construction, environment projection, the startup
coordinator, and post-plan application also use the closed agent set.

### Generic composition and closed startup

An in-tree package can use the generic bundled Dockerfile and Fabric terminal path without adding
its ID to those components:

1. `scripts/build-harnesses.mts` discovers each matching `packages/nemoclaw-<id>` package that
   declares `nemoclaw.harnessManifest: "manifest.yaml"`. It materializes the package and its
   Dockerfile inputs under `dist/harnesses`.
2. `nemoclaw harness install <id>` installs that materialized package and records its receipt.
3. A runtime that advertises legacy Dockerfile builds can select the package Dockerfile. NemoClaw
   treats a source-checkout Dockerfile as package-managed only when its canonical path and bytes
   match the installed Dockerfile, and the bundled and installed package identities match.
4. `nemoclaw sandbox agent <sandbox> <prompt>` resolves the receipt-pinned
   `runtime.headless_command`.
5. For `nemoclaw-fabric-run`, NemoClaw sends the prompt through standard input. The generic runner
   bounds the package-owned Fabric adapter result.

Core does not need a known package ID for this path. The synthetic `future-terminal` test in
[`package-composition.test.ts`](../test/onboarding/package-composition.test.ts) protects install,
selection, Dockerfile workload selection, and Fabric dispatch for an unknown ID. The bundled
artifact test and build-context tests protect discovery, copied inputs, identity, and staging.

This path does not enable generic managed startup. Core must add the package and its contracts to
the closed maps rooted at `MANAGED_STARTUP_AGENTS`. Buildless onboarding has a separate closed
gate. Core must register the ID as a managed-image agent, define its runtime identity and image
repository, and supply an accepted immutable catalog contract. Do not add an agent-name branch
to the generic bundler, installer, Dockerfile selector, terminal dispatch, or Fabric runner.

Static data and fixed commands are preferable to host adapters. Add a host operation only when
core must retain authorization, credentials, transaction order, or rollback around package-native
translation.

## Typed host adapter

The adapter API is a closed map of semantic operations. Core defines every host module path, export
name, request type, result type, JSON Schema, and byte limit. The manifest can declare a
capability, but it cannot select a host module or export.

The current adapter contracts cover Model Context Protocol (MCP), runtime configuration, and
configuration restore behavior.

Here, *typed* describes the core operation map, its TypeScript request and result types, and its
runtime JSON Schemas. Package adapter files use self-contained CommonJS source with the `.cts`
extension. The package TypeScript configurations do not compile those files. Runtime schema
validation and package behavior tests enforce their current boundary; compile-time checking of the
package implementations remains future work.

The current files are:

```text
src/lib/agent-runtime/adapter/
├── contract.ts  typed contract and operation definitions
├── schema.ts    bounded JSON clone, validation, and freezing
├── loader.ts    receipt-bound module loading
├── mcp.ts       MCP request, result, and operation definitions
└── config.ts    configuration and restore definitions

src/lib/agent-runtime/
├── host-module.ts    typed MCP loader facade
└── config-module.ts  typed configuration and restore loader facade
```

### MCP operations

An MCP-capable package provides `host/mcp-adapter.cts` with these exports:

| Operation | Fixed export | Result |
| --- | --- | --- |
| `register` | `buildMcpRegistrationPlan` | Registration execution, verification, and credential-convergence plan |
| `remove` | `buildMcpRemovalPlan` | Removal execution and outcome plan |
| `inspect` | `buildMcpInspectionCommand` | Inspection shell command |
| `mutationCapability` | `describeMcpMutationCapability` | Typed capability probe |
| `teardownCapability` | `describeMcpTeardownCapability` | Typed capability probe |
| `verifyRuntimeIntent` | `describeMcpRuntimeIntentVerification` | Typed runtime-intent probe |
| `runtime` | `buildMcpRuntimeCommand` | Typed argument vector for one runtime command |

Read the implementation in this order:

1. [`contract.ts`](../src/lib/agent-runtime/adapter/contract.ts) defines the closed typed map.
2. [`mcp.ts`](../src/lib/agent-runtime/adapter/mcp.ts) defines the seven operations and schemas.
3. [`loader.ts`](../src/lib/agent-runtime/adapter/loader.ts) enforces package identity and the
   execution boundary.
4. The [Hermes](nemoclaw-hermes/host/mcp-adapter.cts),
   [OpenClaw](nemoclaw-openclaw/host/mcp-adapter.cts), and
   [Deep Agents Code](nemoclaw-langchain-deepagents-code/host/mcp-adapter.cts) modules translate
   the typed requests into native plans.
5. [`package-command.ts`](../src/lib/actions/sandbox/mcp-bridge/package-command.ts) adapts those
   plans to the existing core transaction.

The builders must preserve the package's native grammar and all declared request semantics.
Registration and removal return bounded transaction plans. Inspection returns shell source.
`buildMcpRuntimeCommand` returns an argument vector; core quotes each argument before it constructs
the bridge-owned shell command. Capability builders return either `not-required` or a bounded
command probe with typed success criteria. None of these exports executes a command.

Core reads the manifest capability before it loads this module. A package that does not declare
MCP receives a typed validation error before adapter load. Direct loader calls also reject a
manifest that does not declare the capability before module evaluation. There is no no-op adapter
or alternate result contract.

### Configuration operations

A package can provide `host/config-adapter.cts` with three fixed exports:

| Operation | Fixed export | Result |
| --- | --- | --- |
| `prepareUpdate` | `prepareConfigUpdate` | `immutable` result or bounded update transaction plan |
| `classifyUrl` | `classifyConfigUrl` | URL policy flags for core SSRF validation |
| `describeMutable` | `describeMutableConfig` | `not-required`, `stat`, or bounded probe plan |

OpenClaw, Hermes, Deep Agents Code, and Pi provide this module. Deep Agents Code and Pi return
`immutable` because their runtime configuration is materialized by the image. Core retains parsing,
server-side request forgery (SSRF) checks, credential handling, privileged execution, locks, digest
checks, readback verification, and restart coordination. A sandbox without a package receipt can
still use the current legacy core compatibility path. When a package receipt exists, a missing,
invalid, or receipt-mismatched module fails closed.

Core calls `classifyConfigUrl` for each URL leaf in a nested value. The package receives the
selected key and the leaf's relative path. An allowance for one leaf cannot authorize its sibling.
Validation commands and mutable-configuration probe or repair commands can prove success only by
exiting with status zero. Only the write command can use the structured `config-transaction`
proof. OpenClaw's write proof protects
`["openclaw.json", ".config-hash", "fabric.json"]`.

OpenClaw also provides `host/restore-adapter.cts`. Its `mergeConfigState` export returns merged
content with a finite write plan, or a typed refusal. The `config-anchors` write plan names
`["openclaw.json", "fabric.json"]` as its hash inputs. Core retains snapshot authority, protected
reads, atomic apply, and rollback. Other restore strategies remain core-owned, so configuration and
restore extraction is not complete.

Core applies this sequence for each adapter call:

1. Resolve the exact package identity recorded for the sandbox.
2. Resolve the immutable package object and receipt.
3. Validate the package manifest against the core-owned capability schema.
4. Validate the package tree and compare its digest with the receipt.
5. Read the core-owned fixed module path as a bounded regular file.
6. Revalidate tree authority after the read.
7. Evaluate the self-contained module without passing host capabilities or an import loader.
8. Clone, bound, validate, and freeze the request.
9. Call the named export.
10. Clone, bound, validate, and freeze the result.
11. Let core authorize and execute the resulting transaction.

A configuration write retains the selected package receipt, receipt-pinned agent definition, and
returned plan across validation. Under the mutation lock, core reloads the same package identity,
rebuilds the plan, and requires equality before it writes. An ambient active-pointer change cannot
redirect the transaction. A changed sandbox receipt or plan stops it.

Receipt-backed MCP calls also fail instead of using a core native translator. Sandboxes without a
package receipt still use the compatibility dispatch in
`src/lib/actions/sandbox/mcp-bridge/legacy-mutation.ts`. Retained source includes the legacy
branches in `mcp-bridge-adapters.ts`, the `mcp-bridge-adapter-deepagents-*.ts` helpers,
`mcp-bridge/deepagents-legacy-config.ts`, and their focused `*.test.ts` files. This is migration
debt, not part of the typed package contract.

The module must be synchronous and self-contained. The VM limits accidental capability access; it
is not a security sandbox for hostile package code and cannot contain an abandoned rejected
promise. Current in-tree adapters are integrity-verified trusted code. A future external package
design must either preserve that trust requirement or isolate adapter execution in another
process.

Do not add a general lifecycle hook, callback registry, manifest-selected host module, or arbitrary
command operation. A new semantic operation lands only with a current core consumer, at least one
package implementation, negative boundary tests, and removal of the old native core branch.

Some lifecycle paths still contain core-owned native translators. The current MCP, configuration,
and restore adapters prove the finite boundary. They do not show that all agent-specific code has
moved.

## NeMo Fabric headless path

NeMo Fabric is the sandbox-local data plane for one headless request:

```text
user prompt
-> NemoClaw selects the receipt-pinned manifest command
-> prompt enters the sandbox through standard input
-> nemoclaw-fabric-run owns deadline and process cleanup
-> nemoclaw-fabric validates the package-owned fabric.json
-> NeMo Fabric invokes the selected adapter
-> NemoClaw returns bounded, redacted output
```

The package owns:

- The Fabric adapter or released-adapter dependency lock.
- The generated `fabric.json` projection.
- Credential environment-variable names.
- The bounded `runtime.headless_command`.
- Agent-native adapter tests and policy destinations.

The generic runner owns Fabric configuration validation, credential-value rejection, input and
output bounds, private request artifacts, redaction, deadline handling, and cleanup. It does not
install adapters or branch on an adapter ID.

Core owns package selection, prompt transport, credential custody, OpenShell lifecycle, policy,
and user-visible command behavior. Fabric handles only headless request execution. It does not own
startup, lifecycle, configuration updates, restore, MCP reconciliation, messaging, pairing,
rollback, or durable NemoClaw state.

Keep the native interactive or gateway command available when a Fabric adapter cannot preserve a
runtime feature. A package can mark one generated Fabric composition unavailable. The generic
runner then returns a typed `unsupported_configuration` result before it creates the Fabric client.

## Test workflow

Use the earliest stable boundary that can detect a failure. A package change should not start with
a live lifecycle.

| Lane | Owner | What it proves | When to run |
| --- | --- | --- | --- |
| Package unit | Package | Native configuration, grammar, guards, adapters, and failure cases | Every package change |
| Package artifact | Package; root package-contract for Pi today | Archive members, image inputs, file modes, locks, and fixed paths | Every package change |
| Loader contract | Core | Receipt, schema, VM, size, mutation-race, and capability-refusal behavior | Every adapter change |
| Synthetic composition | Core | An unknown package ID exercises covered operations without an agent switch | Every contract change |
| Revision-pinned composition | Package | The supplied commit builds the CLI, runs package tests, installs the candidate, and verifies its identity | Package release candidate |
| Fabric | Package and runner | Package configuration works through the selected Fabric adapter | Fabric or headless change |
| Live edge | Existing E2E registry | Docker, OpenShell, process, filesystem, policy, network, or inference behavior | Changed edge only |

Each package root exposes the same primary commands:

| Command | Scope |
| --- | --- |
| `npm run test:package` | Runs package tests that do not need NemoClaw source. |
| `npm run test:fabric` | Runs the package-owned Fabric adapter lane. |
| `npm run test:fabric:composed` | Composes the adapter with the surrounding generic runner when declared. |
| `npm run test:nemoclaw` | Runs package-owned composition tests against the surrounding NemoClaw checkout. |
| `npm test` | Runs the package lane, then composition against the surrounding checkout. The composed Fabric lane includes the direct Fabric cases. |
| `npm run test:watch` | Watches checkout-independent TypeScript tests. |
| `npm run typecheck` | Type-checks package TypeScript and tests. |

The root `test:packages` and `test:spec` commands discover packages from
`nemoclaw.harnessManifest` in each package's `package.json`. A new package joins both commands when
it declares that marker and the corresponding `test` and `test:spec` scripts.

Install dependencies from each package lock before running its commands. OpenClaw also has a
separate lock under `plugin/`.

Package-only tests must not import `src/lib`, traverse to root native fixtures, or rely on ambient
credentials. A direct `test:nemoclaw` or `npm test` call uses the surrounding checkout and does not
pin its revision. Only the `composed` rehearsal below verifies a supplied immutable commit SHA.

Use `scripts/packages/checkout.mts` to rehearse both future repository layouts without changing the
source checkout:

```bash
PACKAGE_ID=openclaw

node --experimental-strip-types --no-warnings scripts/packages/checkout.mts package-only \
  --package "$PACKAGE_ID" \
  --candidate "packages/nemoclaw-$PACKAGE_ID"

NEMOCLAW_CHECKOUT="$(pwd)"
NEMOCLAW_COMMIT="$(git rev-parse HEAD)"

node --experimental-strip-types --no-warnings scripts/packages/checkout.mts composed \
  --package "$PACKAGE_ID" \
  --candidate "packages/nemoclaw-$PACKAGE_ID" \
  --nemoclaw-checkout "$NEMOCLAW_CHECKOUT" \
  --nemoclaw-commit "$NEMOCLAW_COMMIT"
```

The rehearsal copies the package into a private workspace, installs locked dependencies with
lifecycle scripts disabled, and uses a credential-free allowlisted environment. It runs reviewed
package code. It is not a sandbox for untrusted code and does not prove external distribution.

### Current extraction limits

The `package-only` rehearsal invokes `test:package` and `test:fabric`. It does not build a Docker
image or require every package to create a standalone archive. OpenClaw, Hermes, and Deep Agents
Code currently run package-owned archive tests. Pi relies on the root
`test/package-contract/bundled-harnesses.test.ts` test for its materialized package and packed root
artifact coverage.

The current Dockerfiles also require the NemoClaw repository as their build context. All four use
shared root build or security scripts, the blueprint, the Fabric runner, or the reviewed managed
runtime bundle. OpenClaw and Hermes also copy root messaging or tool-disclosure source. The
`composed` rehearsal preserves these dependencies; it does not prove that the candidate can build
from an independent repository.

Before packages move to separate repositories, define versioned inputs for those shared assets or
one reviewed build-context artifact. Add a package-owned Pi archive test at the same time. External
distribution and its build contract still require an accepted product decision.

## Managed-image publication gate

An installation receipt and a managed-image cohort receipt prove different boundaries.

| Receipt | Scope | It does not prove |
| --- | --- | --- |
| Package installation receipt | The installed package tree matches one content digest and source identity. | Publisher authenticity, image publication, or runtime behavior. |
| Managed-image cohort receipt | Every shipped agent and platform in one publication run resolves to immutable image digests with matching provenance. | A candidate package outside that cohort or successful runtime behavior. |

Stock live onboarding must wait for the managed-image publication job. The job selects one
publication run, downloads its immutable cohort artifact, and validates:

- The source revision and workflow run identity.
- The complete shipped-agent set.
- `linux/amd64` and `linux/arm64` entries for each shipped agent.
- Immutable image and base-image references.
- Workload descriptors and recorded attestations.

The gate emits one revision, cohort receipt, and optional candidate catalogue. Every stock E2E job
must consume those same values. This prevents a test from mixing images from different publication
runs or starting after only part of a cohort exists.

Pi is not part of the shipped managed-image cohort at this revision. Cohort success therefore does
not qualify Pi. A Pi live candidate needs its own exact image evidence.

## Ownership boundary

| Responsibility | Core owns | Package owns |
| --- | --- | --- |
| Discovery and install | CLI flow, package store, receipts, active identity | Package metadata and immutable source bytes |
| Onboarding | User intent, credentials, policy authorization, transaction, rollback | Native configuration translation and declared capabilities |
| Images and startup | Selected build inputs and OpenShell lifecycle | Dockerfiles, `start.sh`, native process behavior |
| Commands | Public CLI intent, execution, timeout, redaction | Interactive, headless, and native grammar |
| MCP | Requested state, credential placeholders, policy, execution, rollback | Registration, removal, inspection, capability, and runtime command plans |
| Messaging | Shared channel manifest, credentials, policy, transaction | Native configuration projection and startup behavior |
| Runtime configuration | Parsing, SSRF checks, credentials, protected execution, locks, digest verification, restart | Update, URL-policy, and mutable-file plans |
| Backup and restore | Snapshot authority, protected reads, atomic apply, rollback | Native merge grammar and package state declarations |
| Platform composition | OS, hardware, runtime provider, serving runtime | Compatibility requirements declared by the package |
| Fabric | Prompt transport and package command selection | Adapter, configuration projection, locks, and native tests |

## Add a package candidate

DeepSeek and Haystack are proposed candidates, not supported integrations. Implement either only
after an issue or design decision records `Accept`, its canonical ID, reason, placement,
accountable maintainer, lifecycle, compatibility, security, and validation plan.

1. Create `packages/nemoclaw-<id>` with the six required runtime files and a package README.
2. Declare static capabilities and commands in `manifest.yaml`.
3. Put build-time translation in `config/`.
4. Install managed startup at the fixed sandbox command path when the package uses it.
5. Put sandbox commands and guards in `runtime/`.
6. Add a Fabric configuration and adapter only when headless execution preserves required native
   behavior.
7. Implement only typed host operations that core already defines. Do not add no-op capability
   files.
8. Add package unit, artifact, Fabric, and negative tests.
9. Pass `npm run typecheck`, `npm run test:package`, `npm run test:fabric`, and
   `npm run test:fabric:composed` from the package root.
10. Pass the package-only rehearsal.
11. Pass revision-pinned composition. This gate builds the NemoClaw CLI at the supplied commit,
    runs the package's `npm test`, installs the candidate, and verifies its healthy receipt-backed
    identity with `nemoclaw harness list --json`.
12. From the NemoClaw root, pass `npm run test:package` and
    `npx vitest run --project integration test/onboarding/package-composition.test.ts`.

After scope acceptance, add one focused live target for each new package. Register it in the typed
E2E registry so shared fixtures drive the OpenShell lifecycle. Pass a
`PublicFabricHarnessContract` to `runPublicFabricTurn` without an agent-ID branch. The target must:

- Build or select the candidate image and onboard one sandbox.
- Run one prompt through `nemoclaw sandbox agent <sandbox> <prompt>`.
- Supply the package's typed values to `runPublicFabricTurn`.
- Verify the package receipt, Fabric runner, adapter descriptor, generated configuration, exact
  response, absence of credential values, and process cleanup.
- Destroy the sandbox and remove its test-owned state.

This one onboard-run-destroy journey is the live lifecycle and Fabric gate. Add a separate rebuild,
restart, provider, operating-system, or hardware target only when that boundary has a distinct
package risk. Package tests must prove native grammar and failure cases without repeating the live
matrix.

Discovery and the covered host operations must not require a new command option, core catalogue
branch, or agent-name switch. The bundled Dockerfile path requires no managed-startup entry. If a
new package needs managed startup, buildless onboarding, or a semantic operation that core does not
define, propose that capability with its consumer, trust boundary, result schema, and tests. Do not
encode it as an arbitrary callback.

External package download, PyPI discovery, separate repository ownership, publisher trust, and
compatibility policy remain later work. No external distribution design has an accepted product
decision. NemoClaw must not present those paths as supported behavior.

## Definition of done

The local contract candidate is ready for review when:

- One typed loader enforces fixed core-owned paths, exports, schemas, and byte limits.
- MCP-capable installed packages provide all seven fixed MCP exports.
- Package-backed MCP calls do not select behavior by agent ID or fall back to a native core
  translator.
- The qualification record names the no-receipt MCP and configuration compatibility paths that
  remain in core.
- A package that does not declare MCP receives a typed validation error before adapter load.
- Synthetic package IDs pass MCP, configuration, and restore tests without a core agent ID branch.
- Package-only, revision-pinned composition, Fabric, package-contract, and E2E-support lanes pass.
- The existing MCP live target proves the changed external boundary with exact package and image
  identities.
- The qualification record names skipped live edges and explains why existing evidence covers
  them.

This list does not claim product support or full agent-runtime independence. Full startup still
depends on `MANAGED_STARTUP_AGENTS`, core profile mappings, and the startup coordinator. Later
package-by-package changes must remove no-receipt MCP and configuration compatibility paths,
remaining restore and CLI grammar, pairing, messaging projection, gateway and dashboard protocols,
and other agent-specific lifecycle behavior. Standalone package image builds and Pi-owned archive
proof also remain. Each move must delete its native core fallback and move its detailed tests in
the same change.
