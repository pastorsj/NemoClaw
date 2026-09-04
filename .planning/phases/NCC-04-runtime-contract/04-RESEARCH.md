<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 4 Research: Agent Runtime Contract

**Researched:** 2026-09-03
**Baseline:** `agent-runtime-composition-architecture` after the current upstream merge

## Finding

The repository already has the package shape and the required security primitive. It does not need
a second host extension framework.

The smallest reusable design is:

1. Keep discovery, installation receipts, immutable package identity, lifecycle, and rollback in
   core.
2. Use manifest data for static integration facts.
3. Use fixed commands inside the sandbox for native operations that do not need host authority.
4. Extract the existing receipt-bound host loader into one typed adapter loader.
5. Use Model Context Protocol (MCP) as the first proving capability because its packages already
   provide command builders and core has a current transaction consumer.
6. Reuse that loader for current runtime configuration and restore consumers.
7. Add another operation only while moving a specific native core implementation.
8. Keep NeMo Fabric as a separate package-selected headless data plane.

This approach preserves current user commands and avoids arbitrary callbacks.

## Evidence in the current tree

### Package foundation

- `src/lib/agent-runtime/package/` owns catalogue, install, receipt, store, and tree authority.
- `src/lib/agent-runtime/manifest-*.ts` parses package data without importing package code.
- The package store publishes immutable content, a receipt, and an active pointer.
- The four agent runtime packages, including LangChain Deep Agents Code, already own Dockerfiles,
  startup, native configuration, runtime helpers, compatibility files, Fabric inputs, and package
  tests.
- `scripts/packages/checkout.mts` rehearses package-only and revision-pinned composition in private
  workspaces.

### Typed adapter foundation

- `adapter/contract.ts` preserves request and result types for a core-owned operation map.
- `adapter/schema.ts` clones values through JSON, enforces byte limits, validates schemas, and
  freezes values.
- `adapter/loader.ts` resolves an immutable installed package, validates its receipt and tree,
  reads a fixed host module, and evaluates it without passing host capabilities.
- `adapter/mcp.ts` defines the first concrete capability and seven operations: registration,
  removal, inspection, mutation capability, teardown capability, runtime-intent verification, and
  runtime command wrapping.
- `adapter/config.ts` defines three runtime configuration operations and one restore operation.
- `config-module.ts` exposes typed configuration and restore loader facades.
- `host/mcp-adapter.cts` exists in each MCP-capable package.
- `host/config-adapter.cts` exists in OpenClaw, Hermes, LangChain Deep Agents Code, and Pi. Deep
  Agents Code and Pi return `immutable` because their configuration is materialized by the image.
- `host/restore-adapter.cts` exists in OpenClaw.

The loader is generic. Package-backed MCP dispatch uses package plans without a native core
translator. A sandbox without a package receipt still uses
`src/lib/actions/sandbox/mcp-bridge/legacy-mutation.ts`, the legacy branches in
`mcp-bridge-adapters.ts`, the `mcp-bridge-adapter-deepagents-*.ts` helpers,
`mcp-bridge/deepagents-legacy-config.ts`, and their focused tests. Runtime configuration also
permits its current core compatibility path only for a sandbox without a package receipt. A package
receipt with a missing configuration module fails closed. Other restore strategies remain in core.

The contract is typed on the core side: TypeScript connects operation names to request and result
types, and JSON Schema validates calls at runtime. The package `.cts` files are CommonJS source and
are not included in current package TypeScript compilation. Their conformance is runtime-validated
and behavior-tested rather than statically checked.

### Fabric foundation

- `packages/nemoclaw-fabric` calls the released NeMo Fabric SDK without an agent-name branch.
- Each package owns its Fabric dependency lock and generated configuration.
- Each manifest selects a bounded headless command.
- The runner rejects literal credentials, bounds input and output, uses private invocation
  artifacts, and owns deadline and cleanup behavior.
- Package tests distinguish native behavior from Fabric behavior.
- Each package's default `npm test` runs its package lane and composition against the surrounding
  checkout. The composed Fabric lane includes the direct Fabric cases, so the default does not run
  `test:fabric` separately.

Fabric solves only headless request execution. It does not solve package discovery, installation,
startup, lifecycle, runtime configuration, OpenShell mutation, state, restore, MCP reconciliation,
or rollback.

### Test foundation

- Package tests are grouped by `config`, `host`, `runtime`, `compat`, `image`, `fabric`, and
  `integration` responsibility.
- Root Vitest projects separate CLI, integration, installer, package contract, plugin, E2E support,
  and live E2E.
- The typed E2E registry and workflow planner remain the only live-test authority.
- Stock live E2E waits for a managed-image publication job and consumes one validated cohort
  receipt.

## Current core knowledge

The following core areas still contain agent-runtime-specific behavior. They are a later migration
inventory, not behavior removed by the current contract work.

### Native configuration and managed startup

The current typed configuration contract moves update planning, URL classification, mutable-file
posture, and OpenClaw restore merge grammar into packages. Core calls URL classification for each
URL leaf. Validation commands and mutable-configuration probe or repair commands require
`exit-zero` proof. Only a write command can use `config-transaction` proof. OpenClaw's write plan
protects `["openclaw.json", ".config-hash", "fabric.json"]`. Its restore `config-anchors` plan
computes the configuration hash from `["openclaw.json", "fabric.json"]`.

Core still owns parsing, SSRF checks, credentials, protected execution, locks, digest and readback
verification, restart, snapshot authority, atomic apply, and rollback. During a configuration
transaction, core retains the package receipt, receipt-pinned agent definition, and returned plan.
Under the mutation lock, it reloads the same identity, rebuilds the plan, and rejects any change.
An ambient active-pointer change cannot redirect this selection.

`buildManagedStartupImageActionPlan` uses the fixed
`/usr/local/lib/nemoclaw/generate-config` command, but its `exactActionPlanAgent` check rejects IDs
outside `MANAGED_STARTUP_AGENTS`. Core also selects profile fields, environment projections,
shared-state behavior, protected file handling, and recovery rules from that closed set.
Representative owners include:

- `src/lib/onboard/managed-startup/agent-environment.ts`
- `src/lib/onboard/managed-startup/shared-state-transaction.ts`
- `src/lib/onboard/managed-startup/image-runtime.ts`
- `src/lib/state/state-file-restore.ts`

The eventual package boundary is a fixed sandbox command or bounded typed plan. Core must retain
credential selection, authorization, apply order, and rollback.

### Native command, pairing, gateway, and dashboard behavior

Core knows native selector grammar, gateway RPC, pairing approval, dashboard tokens, runtime
readiness, and package-specific recovery. Static ports and health belong in the manifest. Native
grammar belongs in a package operation only when a real core consumer needs a returned plan.

### MCP reconciliation

MCP package helpers build registration and removal plans, inspection commands, capability probes,
runtime-intent verification, and typed runtime argument vectors. Core quotes runtime arguments and
owns execution, inspection authority, credential revision convergence, policy, transaction state,
and rollback. Those are valid core responsibilities. Package-backed sandboxes do not use
agent-switched native command fallbacks. No-receipt state still does, including Deep Agents legacy
configuration handling and its retained core tests.

The current contract includes inspection, mutation capability, teardown capability, and runtime
command wrapping because current MCP consumers require those native translations. Core still owns
the execution and interpretation that follow each typed plan.

### Messaging projection

Core should keep the shared channel manifest, credentials, network policy, onboarding flow, and
transaction. Each package should own its native configuration and startup projection. Deterministic
projection and redaction tests do not require messaging-service credentials. Live service tests
remain separate.

### Optional native behavior

Sessions, subagents, skills, cron, voice, diagnostics, backup, and restore can contain native paths
or grammar. A feature used by one package does not become a generic callback. Move the native rule
to that package and add a typed operation only when core must coordinate it.

## Contract design

### Why a closed operation map

A broad loader such as `invoke(hookName, payload)` would make package code an untyped host extension
surface. It would hide authority and make compatibility failures appear only in E2E.

The closed map exposes the opposite properties:

- Core owns the operation name.
- TypeScript links request and result types.
- JSON Schema enforces the runtime boundary.
- Core owns fixed file and export names.
- Each operation has independent byte limits and negative tests.
- An absent MCP capability produces a typed validation refusal before adapter load.
- The layer source check rejects core-to-package imports. Contract tests reject unreviewed
  operation maps and manifest-selected modules.

### Why return plans

The package understands native grammar. Core understands authority and product state. A bounded
plan keeps both responsibilities in their owner:

```text
package: validated request -> native command or data plan
core: plan -> authorize -> execute -> inspect -> commit or roll back
```

Do not pass an OpenShell client, transaction object, filesystem handle, secret value, or callback
to package code.

### Why one contract without versions

This branch is forward-moving and remains in one repository. Parallel V1/V2 loaders would double
the trust surface before an external compatibility policy exists. Change the contract and all
in-tree consumers together. Define external compatibility only after package distribution has an
accepted lifecycle decision.

## Fabric role

Fabric gives each package one common headless request execution path:

- Native adapter discovery through a package-owned Fabric configuration.
- Standard doctor and run operations.
- Environment-name credential indirection.
- Normalized bounded results.
- Per-request artifact ownership and cleanup.
- A supervisor deadline beyond the Fabric SDK timeout.

Fabric does not own startup, lifecycle, runtime configuration, restore, MCP, messaging, pairing,
or durable state. It also does not make native agent features identical. A released adapter can
lack behavior that a native command supports. The package must mark that composition unavailable
or keep the native headless path. Core must not add an agent-specific Fabric exception.

The agent package, Fabric runner, and core can therefore release on separate lanes only after the
compatibility policy is accepted:

```text
agent package -> native and Fabric tests
Fabric runner -> SDK and adapter-neutral request-execution tests
NemoClaw core -> contract, package identity, transaction, and composition tests
```

## Managed-image publication boundary

Package installation and image publication use separate receipts:

- The package receipt binds installed source bytes to one content digest.
- The managed-image cohort receipt binds one publication revision and workflow attempt to the full
  shipped agent and platform image set.

Before stock live E2E, the publication job downloads and validates the immutable cohort artifact.
It verifies immutable image references, source revision, run identity, platform coverage,
descriptors, base references, and attestations. Downstream jobs receive the same cohort revision
and receipt. This prevents partial or mixed image cohorts from producing positive lifecycle
evidence.

Pi is outside the shipped cohort at this baseline. The cohort receipt cannot qualify Pi. Pi needs
exact candidate image evidence when its live edge runs.

## Fast confidence model

Do not test the Cartesian product of package, host OS, hardware, runtime provider, serving runtime,
and inference route.

Use this order:

1. Package unit tests for native behavior.
2. Package artifact tests for archive and image layout where the package owns them. Pi currently
   relies on the root bundled-package contract for archive evidence.
3. Loader contract tests for receipt, schema, VM, bounds, and races.
4. Synthetic MCP, configuration, and restore composition with unknown package IDs.
5. Revision-pinned composition against one NemoClaw commit.
6. Fabric tests when headless behavior changes.
7. One existing live target for each changed external boundary.

OS, hardware, runtime-provider, and serving-runtime matrices remain core qualification dimensions.
An agent package should not repeat those matrices unless it declares a real compatibility
constraint that changes the composition.

Direct `test:nemoclaw` commands use the surrounding checkout. Revision-pinned composition requires
`scripts/packages/checkout.mts composed` with the supplied commit SHA.

The package-only rehearsal runs declared package and Fabric tests. It does not build a Docker
image. Current Dockerfiles still use shared root security and build scripts, the blueprint, the
Fabric runner, or the reviewed managed runtime bundle. OpenClaw and Hermes also use root messaging
or tool-disclosure source. Independent repositories therefore need versioned forms of those inputs
or one reviewed build-context artifact. Pi also needs a package-owned archive test.

## Migration sequence

### Current phase

1. State the thesis and trust boundary.
2. Stabilize the typed loader and current MCP, configuration, and restore schemas.
3. Route installed package MCP command construction through package helpers only.
4. Route installed package configuration planning and OpenClaw restore merge grammar through fixed
   package helpers.
5. Keep policy, credential revision, protected execution, inspection, transaction, and rollback in
   core.
6. Keep the existing managed-startup path explicit until a complete production consumer can use a
   generic replacement.
7. Add synthetic and package conformance tests.
8. Add source and test ownership gates.
9. Run deterministic lanes, then only the live edges selected by changed external seams.
10. Record exact package and managed-image identities.

### Later migrations

1. Remove the no-receipt MCP and configuration compatibility paths after their upgrade boundaries
   are defined. This includes the dispatcher and Deep Agents legacy configuration helpers.
2. Move remaining restore strategies and native grammar package by package.
3. Classify each remaining native core seam by owner.
4. Define a typed operation only if manifest data or a fixed sandbox command cannot express it.
5. Implement the operation in Hermes first when Hermes provides the smaller proving case.
6. Migrate OpenClaw next, then Deep Agents Code and Pi where they use the capability.
7. Move detailed native tests with the implementation.
8. Delete the core fallback in the same change.
9. Replace root Docker build inputs with versioned dependencies or a reviewed build-context
   artifact. Add package-owned Pi archive proof.
10. Split `packages/nemoclaw-openclaw/plugin/src/blueprint/runner.ts` along its existing action
    boundaries without changing its command protocol.
11. Run package-only and revision-pinned composition gates before one changed live edge.

External repositories and downloaded package discovery follow only after an accepted design
decision defines publisher trust, ownership, version compatibility, incident response, and support
lifecycle.

## Main risks

| Risk | Control |
| --- | --- |
| A generic hook grants arbitrary host execution. | Fixed paths, fixed exports, typed schemas, VM limits, and no manifest-selected host adapter. |
| A moved package silently uses its old core path. | Delete the fallback in the same slice and add a source gate. |
| Package tests pass only in the monorepo. | Package-only rehearsal omits core source; the revision-pinned rehearsal verifies one supplied commit. |
| A package-only pass is mistaken for an independent image build. | Record root build-context inputs and qualify image construction separately. |
| Contract work duplicates lifecycle or rollback. | Package returns a plan; core remains executor and transaction owner. |
| Live tests become a full combination matrix. | Deterministic tests prove semantics; live tests cover changed external edges. |
| Package update requires a core release for native syntax. | Keep grammar and detailed tests in the package. |
| Fabric becomes a second control plane. | Restrict Fabric to sandbox-local headless invocation. |
| E2E uses a partial image publication. | Require one validated managed-image cohort receipt before stock onboarding. |
| Prototype text becomes a support claim. | State product-scope status in package and planning guidance. |

## Effort boundary

The current MCP, configuration, and restore work is a local review candidate. It does
not establish a supported package API or complete the broader core extraction. Estimate each later
semantic seam only after its code and test inventory is current. Earlier raw string counts are not
reliable move estimates because mixed core files retain generic transaction and security code.

## Stop conditions

Stop and revise a proposed operation if it gives package code:

- An OpenShell client.
- A secret value instead of a credential reference.
- Filesystem-wide access.
- A transaction or rollback object.
- Policy mutation authority.
- Arbitrary network access from the host.
- An unbounded command or result.
- A callback or manifest-selected host adapter.

Stop a package migration if its package-only tests still need `src/lib` or a root native fixture.
Passing that lane does not prove an independent Docker build while root build-context inputs remain.
Stop live qualification while a deterministic contract, package, composition, or E2E-support gate
is failing.
