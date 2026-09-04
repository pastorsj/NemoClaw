---
phase: 04
slug: runtime-contract
status: active
nyquist_compliant: true
created: 2026-09-03
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 4 Validation Strategy

## Confidence model

Model Context Protocol (MCP) is the first proving capability for this phase. Runtime
configuration and configuration restore reuse the same boundary.
Each test runs at the earliest stable boundary that can detect the failure. Typed contract tests
prove semantic composition. Live E2E proves external behavior that a deterministic test cannot
model. Neither layer repeats the other.

The core contract has TypeScript request and result types plus runtime JSON Schemas. Package `.cts`
implementations are CommonJS source outside the package TypeScript compilation. Runtime contract
and package behavior tests provide their current conformance evidence.

| Lane | Owner | Required evidence | Normal cadence |
| --- | --- | --- | --- |
| Package unit | Package | Native configuration, command grammar, guards, adapter behavior, and failures used by that package | Every package change |
| Package artifact | Package; root package-contract for Pi today | Archive members, image inputs, executable modes, fixed paths, and dependency locks | Every package change |
| Loader contract | Core | Capability and file agreement, request and result schemas, VM limits, receipt drift, and negative fixtures | Every adapter change |
| Synthetic composition | Core | Unknown package IDs exercise covered operations without an agent switch | Every contract change |
| Revision-pinned composition | Package | `scripts/packages/checkout.mts composed` verifies one package candidate with one supplied NemoClaw commit and installed receipt identity | Package release candidate |
| Fabric | Package and runner | Generated configuration and selected adapter preserve the declared headless behavior | Fabric or headless change |
| Core integration | Core | Selection, credentials, policy, execution, transaction, rollback, recovery, and capability refusal | Every core change |
| E2E support | Core and package data | One typed planner owns target selection, workflow order, cleanup, and redaction | Every E2E metadata change |
| Managed-image publication | Core CI | One complete immutable shipped-image cohort and receipt | Before stock live onboarding |
| Live edge | Existing E2E registry | Real Docker, OpenShell, process, filesystem, policy, network, or inference behavior | Changed edge or release candidate |

## Adapter contract cases

### Positive cases

- Resolve one exact installed package identity and receipt.
- Load the core-owned fixed module path.
- Validate and freeze one request.
- Return a bounded result that satisfies the operation schema.
- Execute the returned plan through the core transaction owner.
- Use an unknown package ID without a core catalogue or behavior branch.
- Retain the selected receipt, receipt-pinned agent definition, and plan through configuration
  validation. Reload the same identity and plan under the mutation lock before writing.
- Ignore an ambient active-pointer change when the sandbox still records the same package receipt.

### Required negative cases

- Unknown manifest capability or unreviewed core operation.
- Declared capability with a missing fixed file, missing export, or non-function export.
- Fixed helper without its declared capability.
- Package receipt with a missing configuration adapter.
- Package ID, manifest ID, adapter, pointer, receipt, or content-digest disagreement.
- Link, special file, oversized source, invalid UTF-8, required import, or code generation.
- Package tree mutation before read, during read, or after read.
- Request or result that is not JSON-compatible, exceeds its byte limit, or fails its schema.
- Credential-shaped literal where only an environment name or OpenShell placeholder is allowed.
- Result that attempts OpenShell mutation, policy mutation, filesystem-wide access, transaction
  control, rollback, or arbitrary network access.
- A manifest without MCP receives a typed validation error before adapter load and never
  selects OpenClaw.
- Package-only test fails if it can reach required core source or a root native fixture only by
  relative traversal.

### MCP behavior cases

- Registration, replacement, removal, and teardown rollback preserve each package's native
  semantics.
- Managed entries remain deterministic and bounded.
- Credential placeholders do not become literal credentials in command output or diagnostics.
- A malformed package result stops before command execution or durable-state commit.
- A failed command, inspection, or reload reaches core rollback.
- Hermes, OpenClaw, and LangChain Deep Agents Code use their receipt-pinned package adapters.
- Pi and an unknown package without MCP use the same typed validation-refusal path.
- No package-backed command path can fall back to a native core translator.
- No-receipt sandboxes still use `mcp-bridge/legacy-mutation.ts`, the agent-adapter dispatcher, and
  Deep Agents legacy configuration helpers. Tests must keep that compatibility path separate from
  receipt-backed evidence.

### Configuration and restore cases

- An unknown package implements update planning, URL classification, mutable-file posture, and
  restore merge without a core agent ID branch.
- OpenClaw, Hermes, LangChain Deep Agents Code, and Pi load `host/config-adapter.cts` from their
  package receipts. Deep Agents Code and Pi return `immutable`.
- Update results are either `immutable` or bounded transaction plans.
- `classifyConfigUrl` runs for each URL leaf. A permission for one leaf does not authorize a
  sibling or parent path.
- Validation commands and mutable-configuration probe or repair commands accept only `exit-zero`
  proof. Only the write command can use `config-transaction` proof.
- OpenClaw's configuration transaction protects
  `["openclaw.json", ".config-hash", "fabric.json"]`.
- Core retains parsing, SSRF validation, credentials, protected execution, locks, digest and
  readback verification, and restart coordination.
- OpenClaw loads `host/restore-adapter.cts` only for the package configuration merge strategy.
- Restore returns merged content with a finite write plan, or a typed refusal, before core applies
  the result.
- OpenClaw's `config-anchors` restore plan computes the configuration hash from
  `["openclaw.json", "fabric.json"]`.
- Only a legacy sandbox without a package receipt can use the current core compatibility path. A
  missing, invalid, or receipt-mismatched module for a package-backed sandbox fails closed.
- A changed sandbox receipt or returned plan stops a configuration
  transaction before the write.

## Fabric cases

- Fabric handles only headless request execution. Lifecycle, startup, configuration, restore, MCP,
  messaging, pairing, and durable state stay outside this path.
- The package manifest selects a bounded headless command.
- Core sends prompt text through standard input, not a host process argument.
- The package configuration selects the adapter without a branch in core or the generic runner.
- Credential values are absent from configuration and diagnostics.
- Input, output, configuration, timeout, and artifact paths remain bounded.
- Success, adapter failure, timeout, cancellation, and forced stop remove private request artifacts.
- An unavailable adapter composition returns `unsupported_configuration` before client creation.
- Native and Fabric tests remain separate because their supported features can differ.

## Receipt cases

### Package installation receipt

- Publish private immutable object, receipt, and active pointer in order.
- Preserve exact object and receipt bytes on exact reinstall.
- Reject conflicting publication, non-canonical JSON, missing parts, or pointer disagreement.
- Revalidate the package tree before and after host-module read.
- Do not claim publisher authentication or runtime qualification.

### Managed-image cohort receipt

- Bind one source revision, workflow run ID, and workflow attempt.
- Contain the complete shipped-agent set.
- Contain `linux/amd64` and `linux/arm64` for every shipped agent.
- Use immutable image and base-image digests.
- Bind workload descriptors and attestations to the same agent, platform, revision, cohort, and
  builder.
- Feed the same revision and receipt to every stock live job.
- Reject partial publication, a mixed run, a mutable reference, or a downstream receipt mismatch.
- Do not treat shipped-cohort success as Pi qualification while Pi is outside the cohort.
- Do not treat root bundled-package coverage as package-owned Pi archive evidence.

## Fast execution order

Run focused deterministic tests after each behavior change. Do not run the broad suite after every
package edit.

```text
while editing: affected package, adapter, schema, and synthetic tests
-> after stabilization: revision-pinned composition for changed package candidates
-> final non-live gate: npm test once
-> project membership, typecheck, lint, and repository checks
-> selected live external edges
```

Root `npm test` runs the root non-live projects and every package's default command. Do not count
its package, package-contract, E2E-support, or composed Fabric work again as separate final runs.
A package's default command reaches direct Fabric cases through `test:nemoclaw` and
`test:fabric:composed`. Direct `test:nemoclaw` uses the surrounding checkout; only the composed
rehearsal verifies a supplied commit.

## Live edge selection

Do not run package × runtime provider × serving runtime × OS × hardware combinations. Core tests
own OS, hardware, runtime-provider, and serving-runtime semantics. A package adds matrix coverage
only for a declared compatibility difference.

### macOS

Run these deterministic host behaviors:

- No package installed.
- One package installed.
- Multiple packages installed.
- Exact install and receipt inventory.
- Package-only and revision-pinned composition commands.

Run one local Docker lifecycle only when the changed seam needs a real Docker boundary.

### Brev/Linux

For the current MCP slice, use the existing MCP bridge target for Hermes, OpenClaw, and Deep Agents
Code. Run an existing Fabric target only when Fabric, a package adapter, generated Fabric
configuration, or the headless command changed.

Each live record must contain:

- Commit and package identity.
- Managed-image cohort revision and receipt, or exact candidate image evidence.
- Target ID and coverage variant.
- Host OS and runtime provider.
- Inference endpoint class without credential values.
- Observable outcome.
- Redaction result.
- Final external state and cleanup result.

Live messaging services remain excluded. Deterministic messaging projection, policy, rollback, and
redaction tests remain required if a later messaging migration changes them.

### Retry rule

Retry only a checked-in transient signature after state reconciliation proves the operation is
safe to repeat. Do not rerun a complete failed workflow to hide an unknown failure. Record each
attempt.

## Current capability matrix

This table guides the current contract tests. The package manifest remains runtime authority.

| Capability | Hermes | OpenClaw | LangChain Deep Agents Code | Pi |
| --- | --- | --- | --- | --- |
| Native command | Declared | Declared | Declared | Declared |
| Fabric headless path | Package adapter path | Package adapter path | Released-adapter path | Package adapter path |
| MCP | Package adapter | Package adapter | Package adapter | Disabled in manifest |
| Runtime configuration | Package adapter | Package adapter | Package adapter (`immutable`) | Package adapter (`immutable`) |
| Configuration restore | No package merge | Package adapter | Core key allowlist | No package merge |
| Gateway or dashboard | Declared | Declared | Absent | Absent |
| Pairing | Package behavior | Package behavior | Absent | Absent |
| Messaging | Package behavior | Package behavior | Absent | Absent |

Do not turn this planning table into a second registry.

## Definition of done: current phase

- [x] The architecture record states the core, package, and Fabric boundaries without a supported
      package API claim.
- [x] One typed loader owns fixed paths, exports, schemas, and byte limits.
- [x] The record states that package `.cts` implementations are runtime-validated, not compiled by
      the package TypeScript configurations.
- [x] Package-backed MCP starts from explicit package identity and a matching immutable receipt.
- [x] Hermes, OpenClaw, and Deep Agents Code own native MCP command construction and detailed
      command tests.
- [x] Pi's disabled MCP capability returns a typed validation error before adapter load.
- [x] Package-backed MCP dispatch has no native core command fallback or agent-name switch.
- [x] The no-receipt MCP dispatcher and Deep Agents legacy configuration path remain named
      compatibility debt.
- [x] Core retains authorization, credentials, policy, execution, transaction, inspection
      authority, rollback, and redacted diagnostics.
- [x] Configuration adapters provide update, URL-policy, and mutable-file plans without owning
      core execution or SSRF validation.
- [x] Deep Agents Code and Pi report runtime configuration as `immutable`.
- [x] URL policy runs for each URL leaf, and sibling paths cannot inherit another leaf's
      allowance.
- [x] Only configuration writes can use `config-transaction` proof; validation and mutable
      commands require `exit-zero`.
- [x] OpenClaw configuration writes protect
      `["openclaw.json", ".config-hash", "fabric.json"]`.
- [x] OpenClaw restore merge grammar runs through its receipt-pinned package adapter.
- [x] OpenClaw restore names `["openclaw.json", "fabric.json"]` as its configuration-hash inputs.
- [x] A package-backed missing or invalid configuration adapter fails closed. Only a legacy
      no-receipt sandbox uses the documented compatibility path.
- [x] Configuration writes retain the receipt-pinned definition and plan across validation, then
      verify both under the mutation lock. An ambient active pointer cannot redirect the write.
- [x] Synthetic unknown package IDs pass the MCP, configuration, and restore operations without a
      core agent ID branch.
- [x] Full startup remains identified as closed while `MANAGED_STARTUP_AGENTS`, core profile
      mappings, and the coordinator select agent-runtime behavior.
- [x] Package-only source tests need no NemoClaw source or root native fixture.
- [x] Revision-pinned composition binds one package candidate to one supplied NemoClaw commit.
- [x] The record states that package-only rehearsal does not build Docker images and names the
      remaining root build-context inputs.
- [x] Root package-contract coverage is not reported as package-owned Pi archive proof.
- [x] Fabric stays package-selected and agent-neutral.
- [x] Package installation receipt tests pass.
- [ ] A current complete managed-image cohort receipt covers every changed shipped image input.
- [x] Source and suite-membership checks prevent ownership regression.
- [ ] The final aggregate deterministic and E2E-support gates pass on the exact candidate before
      any live success claim.
- [ ] The selected MCP and Fabric live edges pass, or the record classifies an infrastructure
      failure without claiming product success.
- [ ] Qualification records exact identities, results, cleanup, move counts, and remaining core
      seams.
- [x] The remaining-file record includes the 2,320-line OpenClaw blueprint runner.
- [ ] A product decision with status `Accept` authorizes package-authored host code before this
      candidate is treated as canonical or supported NemoClaw behavior.

The checked items describe implemented local-prototype behavior. They do not override the open
product, image, aggregate, or live gates.

## Later migration completion

The repository is not fully agent-runtime agnostic until later slices move these native concerns
out of core:

- `mcp-bridge/legacy-mutation.ts`, the legacy branches in `mcp-bridge-adapters.ts`, and the Deep
  Agents legacy configuration helpers and focused tests.
- The no-receipt runtime-configuration compatibility path.
- Remaining restore grammar and merge rules.
- Native CLI grammar.
- Pairing.
- Messaging projection.
- Gateway and dashboard protocols.
- Native image qualification that cannot be declarative.
- Agent-specific sessions, skills, cron, voice, diagnostics, backup, and recovery rules.
- Root build-context assets required by package Dockerfiles and missing package-owned Pi archive
  proof.
- The oversized OpenClaw plugin blueprint runner.

Each later slice must:

1. Name one current consumer and authority boundary.
2. Prefer manifest data or a fixed sandbox command.
3. Add a typed operation only when core must coordinate a host transaction.
4. Move package-native source and detailed tests together.
5. Delete the native core fallback in the same change.
6. Pass package-only and revision-pinned composition gates.
7. Run one live edge only when the change crosses an external boundary.

External repositories, package download, publisher authentication, compatibility policy, and
support lifecycle require a separate accepted design decision with an `Accept` outcome.

## Execution order

1. Contract foundation and package identity.
2. Hermes, OpenClaw, and Deep Agents Code MCP migration.
3. Runtime configuration and OpenClaw restore migration.
4. Synthetic conformance and ownership gates.
5. Fabric and receipt evidence.
6. Aggregate deterministic qualification.
7. Bounded macOS and Brev evidence when a changed external edge requires it.
8. Completed-scope and later-migration report.

Do not start live work while a deterministic contract, package, composition, publication, or
E2E-support gate is failing.
