---
phase: 04
slug: runtime-contract
status: planned
nyquist_compliant: true
created: 2026-09-03
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 4 Validation Strategy

## Confidence Model

Passing a typed contract proves semantic composition. Live E2E proves the external boundaries that
cannot be modeled locally. Neither layer repeats the other.

| Lane | Owner | Required evidence | Normal cadence |
|---|---|---|---|
| Package unit | Each package | Native config, grammar, restore, pairing, MCP, messaging, guards, compatibility, and failures used by that package | Every package change |
| Package artifact | Each package | Archive membership, image inputs, executable modes, fixed paths, locks, and no sibling-root dependency | Every package change |
| Contract conformance | Published by core, run by each package | Capability/file agreement, request/result schemas, limits, negative fixtures, and forward-only contract | Every contract or package change |
| Synthetic composition | Core | One unknown-ID fixture exercises every currently defined operation with no agent switch | Every core change |
| Exact composition | Package CI | Package artifact plus one exact NemoClaw commit or release, including install receipt and lifecycle state | Every package release candidate |
| Core integration | Core | Selection, identity, credentials, policy, transaction, rollback, recovery, and unsupported-operation behavior | Every core change |
| E2E support | Core and package data | Existing planner consumes package-owned targets and assertions exactly once; cleanup and redaction stay generic | Every E2E metadata change |
| Live edge | Existing E2E registry | Real Docker/OpenShell/process/filesystem/policy/network/inference behavior only | Changed edge or release candidate |

## Required Negative Cases

- Unknown operation, export, capability, manifest field, or executable path.
- Declared capability with a missing fixed file or required export.
- Fixed helper present without its declared capability.
- Link, special file, oversized source, invalid UTF-8, import, code generation, mutable receipt, or
  post-read tree drift.
- Unbounded command, argument, environment, file plan, parsed result, or diagnostic output.
- Credential-shaped value where only an environment name or OpenShell placeholder is allowed.
- Package result that attempts filesystem-wide access, OpenShell mutation, policy mutation,
  transaction control, rollback, or network access.
- Missing optional operation returns a typed unsupported result; it never selects OpenClaw.
- Legacy null state migrates once, while new null state is rejected.
- Package-only tests fail if NemoClaw source or a root native fixture is available only by relative
  traversal.

## Fast E2E Strategy

Do not run agent × runtime provider × serving runtime × OS × hardware combinations. Use pairwise
contract evidence and one canonical live edge for each independent external boundary.

### Per package

On Linux/Brev, run one canonical no-messaging lifecycle against the existing Docker provider and
approved inference route:

```text
install exact package
-> onboard
-> native turn
-> Fabric turn when supported
-> inference switch
-> Shields transition
-> restart or rebuild
-> status and artifact assertions
-> cleanup
```

The package owns native prompts, expected files, capability-specific assertions, and redaction
sentinels. Core owns target typing, workflow order, source and package identity, OpenShell actions,
failure capture, and cleanup.

### Per platform

- macOS: package discovery, zero/one/many selection, exact install, and one representative Docker
  lifecycle.
- Brev/Linux: one canonical lifecycle per standard package because it covers the production-like
  shell, image, policy, process, and inference boundary.
- WSL2, Windows, DGX Spark, DGX Station, Podman, alternate runtime providers, and alternate serving
  runtimes: run only when the changed seam or an accepted support claim requires that evidence.
- Messaging services: excluded until credentials and environments are available. Deterministic
  projection, policy, migration, rollback, and redaction tests remain required.

### Retry rule

Retry only a checked-in transient signature after reconciling external state and proving the
operation idempotent. Do not broadly rerun a failed workflow. Record every attempt.

## Package Matrix

| Capability | Hermes | OpenClaw | DCode | Pi |
|---|---:|---:|---:|---:|
| Native configuration | Required | Required | Required | Required |
| Native command grammar | Required | Required | Required | Required |
| Config restore | Required | Required | As declared | As declared |
| MCP projection | Required | Required | Required | Absent |
| Pairing | As declared | Required | Absent | Absent |
| Messaging projection | Required | Required | Absent | Absent |
| Gateway/dashboard | Required | Required | Absent | Absent |
| Fabric path | Released adapter through package supervisor | Package adapter | Separate released-adapter evaluation | Package adapter |
| Broker service | Required | Absent | Absent | Absent |

The package manifest remains authoritative. This table is a planning checklist, not a second
runtime registry.

## Definition of Done

- [ ] The local candidate record states the finite host-helper trust boundary and excludes any
      upstream support claim.
- [ ] Every package-managed state path carries explicit `AgentDefinition` and exact package
      identity.
- [ ] Core has one contract file and one loader; there is no general callback framework.
- [ ] OpenClaw, Hermes, DCode, and Pi own their native source, assets, fixtures, and detailed tests.
- [ ] Core contains no agent-ID behavior branch, native grammar, native path, or package import.
- [ ] The only temporary agent-ID exception is the named legacy-state migration; reviewed release
      composition may list package IDs as data.
- [ ] Every declared operation has package-only positive, failure, and boundary tests.
- [ ] Every package passes contract conformance and exact-core composition.
- [ ] Root test projects retain only core behavior, compiled-artifact composition, and generic E2E
      infrastructure.
- [ ] Source and suite-membership gates prevent ownership regression.
- [ ] Linux/Brev canonical lifecycles pass for all standard packages; the bounded macOS journey
      passes; live messaging remains explicitly excluded.
- [ ] Qualification records exact commit, package digests, results, redaction, cleanup, move counts,
      and remaining exceptions.
- [ ] A fifth synthetic package exercises every currently defined operation without a core agent
      ID or branch.

## Execution Order

1. Contract boundary and explicit identity.
2. Hermes package-only and composed gates.
3. OpenClaw package-only and composed gates.
4. DCode and Pi package-only and composed gates.
5. Core source and membership gates.
6. Aggregate deterministic tests once the boundary stabilizes.
7. Mac and Brev live edges.

Do not start live work while a deterministic contract, package, composition, or E2E-support gate
is failing.
