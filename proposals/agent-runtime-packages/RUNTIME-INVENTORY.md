<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Current Agent Runtime Integration Inventory

> **Status:** Pre-acceptance engineering evidence. This inventory records current facts and proposed
> ownership at one repository revision. It does not create a supported package interface.
>
> **Current audit revision:** `a5486894c45140259d822625e74d1ccdfce807ee`
>
> **Previous audit revision:** `c7af3734b9933b2380d7d7e919d625da89096c23`

## 1. Audit contract

The three candidate tables contain every path from the previous audit that still exists at the
current audit revision. The refreshed audit found that all 674 previous rows still exist. It added
16 current-tree rows for new Hermes Portable uninstall and Hermes Discord integration surfaces.
The audit also corrected the prior exclusion of the two root OpenClaw Dockerfiles. The
resulting current-tree inventory contains 692 unique paths.

Counts use the file content at the current audit revision. A nonblank line is a physical line that
contains at least one non-whitespace character. Counts describe the whole current file; a `split`
row does not claim that every line moves.

The audit used only repository state and direct path inspection:

```sh
git ls-tree -r --name-only a5486894c45140259d822625e74d1ccdfce807ee
git diff --name-status \
  c7af3734b9933b2380d7d7e919d625da89096c23..a5486894c45140259d822625e74d1ccdfce807ee
git show a5486894c45140259d822625e74d1ccdfce807ee:<path> \
  | awk 'NF { count++ } END { print count + 0 }'
git cat-file -e a5486894c45140259d822625e74d1ccdfce807ee:<path>
```

The tables exclude generated or ignored output, public documentation, and shared core files that
do not contain package-owned implementation. Material exclusions introduced or changed in the
audit range are listed in section 7. No nonexistent path appears in a current-tree TSV.

## 2. Current runtime set

Five manifests exist at the current audit revision:

| Runtime ID | Current product position | Package migration position |
|---|---|---|
| `openclaw` | Standard managed agent runtime and current default | Standard package, Phase 7 |
| `hermes` | Standard managed agent runtime; also has separate portable and broker paths | Managed Hermes package, Phase 5; portable and broker deferred |
| `langchain-deepagents-code` | Standard managed terminal agent runtime | Standard package pilot, Phase 4 |
| `pi` | Candidate managed terminal agent runtime | Deferred; the accepted trust boundary does not authorize packaging or support |
| `nemocua` | Feature-gated terminal integration around an external image | Deferred; source, publisher authority, and checked-in support status are absent |

The package migration has three standard commitments: OpenClaw, NemoClaw-managed Hermes, and
LangChain Deep Agents Code. Portable Hermes, the Hermes tool broker, Pi, and NemoCUA remain visible
in the audit so they cannot be absorbed into a standard package by accident.

## 3. Reconciled current-tree totals

| Table | Rows | Production rows / lines | Test rows / lines | Lock rows / lines | All nonblank lines |
|---|---:|---:|---:|---:|---:|
| OpenClaw | 258 | 101 / 37,368 | 151 / 56,170 | 6 / 18,920 | 112,458 |
| Hermes, all workstreams | 334 | 109 / 39,464 | 225 / 63,044 | — | 102,508 |
| Terminal runtimes | 100 | 37 / 13,383 | 61 / 20,943 | 2 / 5,439 | 39,765 |
| **Total** | **692** | **247 / 90,215** | **437 / 140,157** | **8 / 24,359** | **254,731** |

Final disposition totals are:

| Table | Move rows / lines | Split rows / lines | Keep rows / lines | Delete rows / lines |
|---|---:|---:|---:|---:|
| OpenClaw | 160 / 79,060 | 78 / 24,237 | 19 / 6,535 | 1 / 2,626 |
| Hermes | 131 / 47,445 | 136 / 31,401 | 67 / 23,662 | 0 / 0 |
| Terminal runtimes | 68 / 31,067 | 20 / 5,399 | 12 / 3,299 | 0 / 0 |
| **Total** | **359 / 157,572** | **234 / 61,037** | **98 / 33,496** | **1 / 2,626** |

The sole `delete` row removes `nemoclaw/package-lock.json` only after the root workspace lock proves
the exact current `nemoclaw/` plugin workspace graph through clean build, type-check, test, and
package-content gates. Phase 7 separately proves the relocated plugin workspace against that same
root lock.
All other behavior is moved with its owner, split by authority, or retained in core or a deferred
workstream. Any later delete disposition must name its replacement and parity gate before it is
added.

## 4. OpenClaw integration

OpenClaw remains the widest integration. Its 258 audited paths span:

- the agent manifest and dependency graphs under `agents/openclaw/`;
- OpenClaw-specific model compatibility, native plugins, and policy input under
  `nemoclaw-blueprint/`;
- the existing OpenClaw plugin project under `nemoclaw/`;
- startup, configuration, permission, patch, and dependency-remediation scripts;
- pairing, launch-readiness, messaging, inference reload, Shields, state, voice, and onboarding
  modules under `src/lib/`; and
- detailed plugin, image, startup, patch, configuration, state, and security tests.

The package can own native image contents, configuration rendering, patches, data-only native
health declarations, state interpretation, and detailed tests. Core retains or receives the
OpenShell lifecycle, product-state, snapshot, credential, policy, authorization, messaging status
and health probe hooks, rollback, and release-qualification parts of mixed files.

Three refreshed details are explicit in the table and validation gates:

1. `nemoclaw/src/lib/subprocess-env.ts` is a split, not a whole-file move. Core retains the
   canonical sanitized subprocess environment and exact `NO_PROXY` and `no_proxy` union.
2. Independent OpenClaw runtime-image locks and `scripts/lib/openclaw-npm-remediation.mts` remain
   package-bound. The plugin workspace joins the root workspace lock, while repository-wide `tar`
   remediation and the reviewed cache seed remain core release inputs.
3. The five-minute post-rebuild doctor wait is a core lifecycle constraint. Its implementation is
   excluded from the package table and retained in the live E2E gate.

## 5. Hermes integration

Hermes has three current workstreams:

| Workstream | Rows | Nonblank lines | Migration result |
|---|---:|---:|---|
| NemoClaw-managed Hermes | 281 | 80,175 | Extract in Phase 5 after mixed core authority is split |
| Portable Hermes | 39 | 17,510 | Keep outside the managed package; separate accepted decision required |
| Hermes tool broker | 14 | 4,823 | Keep outside the managed package; separate broker lifecycle design required |

Managed Hermes can own its native image, configuration, startup, plugin, dashboard and API
translation, native MCP and messaging rendering, data-only health declarations, state schema, and
detailed tests. Core retains provider and credential custody, named host resources, effective
policy, messaging status and health probe execution and interpretation, product transactions,
lifecycle, rollback, and release qualification.

The current audit adds schema-5 Portable Hermes uninstall authority, journaling, transaction,
OpenShell executable authority, fixtures, and tests. Every one of those rows is marked `keep` in the
portable workstream. None moves into `nemoclaw-hermes`.

Hermes Discord also gained an endpointless provider profile and deterministic binding evidence.
The profile, REST and WebSocket bindings, credential contract, required policy, and effective-policy
proof remain core. The package receives only admitted logical references and owns native Hermes
configuration rendering.

## 6. Terminal integrations

LangChain Deep Agents Code remains the smallest standard-package pilot. Its 88 rows total 36,466
nonblank lines: 68 move as package-owned runtime, image, lock, or detailed-test files, and 20 split
package-specific fixture logic from core E2E selection, policy, credential, cleanup, and release
judgment.

The package owns its image, launcher, bounded session cleanup wrapper, configuration, profile plugin,
data-only native probe declarations, MCP rendering, and detailed image/runtime tests. Core retains
trusted probe execution and interpretation, generic onboarding, plan compilation, policy and
credential rejection, state linkage, lifecycle, rollback, and live E2E judgment.

Pi contributes nine rows and 3,225 nonblank lines. NemoCUA contributes three rows and 74 lines. All
12 remain `keep` rows in deferred candidate workstreams. Package installation must not imply that
either runtime is supported or normally selectable.

## 7. Refreshed-range reconciliation

### 7.1 Added paths included in current-tree TSVs

| Area | Exact current paths | Disposition |
|---|---|---|
| Portable Hermes uninstall transaction | `src/lib/actions/uninstall/hermes-portable-uninstall-transaction.ts`, `src/lib/actions/uninstall/hermes-portable-uninstall.ts`, and their tests | Keep in core portable workstream |
| Portable Hermes OpenShell authority | `src/lib/adapters/openshell/hermes-portable-uninstall.ts` and its test | Keep in core; converge through the one OpenShell client or satisfy its removal gate |
| Portable Hermes durable authority | `src/lib/state/hermes-portable-uninstall/authority.ts`, `src/lib/state/hermes-portable-uninstall/journal.ts`, and the authority test | Keep in core portable workstream |
| Portable cleanup evidence | `src/lib/actions/uninstall/portable-runtime-cleanup-schema5.test.ts`, `test/helpers/hermes-portable-uninstall-fixture.ts`, and `test/e2e/support/portable-profile-cgroup-cleanup-workflow.test.ts` | Keep in portable/core qualification |
| Hermes Discord provider contract | `src/lib/messaging/channels/discord/provider-profile/hermes.yaml`, `test/hermes-discord-credential-binding.test.ts`, `test/e2e/fixtures/hermes-discord-policy-binding.ts`, and `test/e2e/support/hermes-discord-policy-binding.test.ts` | Provider profile and binding authority stay core; native fixture logic splits from central E2E |

Existing changed paths, including Hermes Portable build and lifecycle files, Hermes Discord policy,
OpenClaw dependency graphs and remediation, plugin subprocess environment, the three managed base
images, and Pi policy inputs, retain their previous rows with refreshed counts and final
dispositions.

### 7.2 Material current-tree exclusions

These paths affect migration parity but do not contain package-owned implementation, so they remain
outside the candidate TSVs:

| Current path or group | Why excluded; retained owner and gate |
|---|---|
| `src/lib/onboard/sandbox-create/orchestration.ts` | Core transaction ordering republishes providers before replacement. Preserve through lifecycle unit tests and managed-runtime live E2E. |
| `src/lib/onboard/docker-gpu-supervisor-reconnect.ts` | Core requires affirmative final OpenShell lifecycle release before replacement. Preserve through rebuild tests and Hermes live E2E. |
| `src/lib/actions/sandbox/rebuild-post-restore-phase.ts` | Core owns the 300-second OpenClaw post-rebuild doctor timeout. Preserve through deterministic rebuild tests and `rebuild-openclaw`. |
| `src/lib/inference/bedrock-runtime/lifecycle.ts`, `src/lib/inference/bedrock-runtime/lifecycle.test.ts`, and `src/lib/actions/uninstall/bedrock-runtime-adapter-cleanup.test.ts` | Amazon Bedrock is a core inference-provider lifecycle, not an agent runtime package. Preserve through Bedrock cleanup tests and the two Bedrock live E2E targets. |
| `src/lib/messaging/channels/policy.ts`, `src/lib/onboard/messaging-bridge-provider.ts`, and their tests | Core owns provider-profile resolution, credential bindings, required policy, and effective-policy input. |
| `src/lib/adapters/openshell/sandbox-presence.ts` | Generic core OpenShell lifecycle observation; recorded in the architecture baseline rather than a runtime package table. |
| `src/lib/onboard/runtime-provider/podman-host-local-inference-probe-inspect.test.ts` | Core runtime-provider compatibility; Portable Hermes does not make Podman part of the managed package contract. |
| `scripts/patch-bundled-npm-tar.mts`, `scripts/upgrade-bundled-npm.mts`, `scripts/audit-reviewed-npm-graph.mts`, root package graphs, and `tools/mcp-tool-discovery-runtime/npm-cache-seed/tar-7.5.21.tgz` | Shared dependency and release remediation stays core. Package locks and images must still prove exact reviewed `tar` 7.5.21 content. |
| `test/installer-homebrew-formula-reuse-trust.test.ts` | Core installer trust and macOS qualification, not package-native behavior. |
| `test/helpers/dgx-station-peer-fixture.ts` | Shared DGX Station test support; no standard package extraction ownership. |

The root `Dockerfile` and `Dockerfile.base` are not exclusions. Their complete OpenClaw recipes have
explicit `move` rows in `OPENCLAW-CANDIDATES.tsv`; the shared security, policy, credential,
bootstrap, and release source files they consume retain their core owners and tests.

### 7.3 Upstream-removed path

`tools/mcp-tool-discovery-runtime/npm-cache-seed/tar-7.5.20.tgz` was removed between the previous and
current audit revisions and replaced by the reviewed `tar-7.5.21.tgz` cache seed. It is recorded
here, not in a current-tree TSV, because it does not exist at the current audit revision.

## 8. Shared boundaries that remain core

The package migration reuses these current core boundaries instead of introducing parallel ones:

- trusted runtime identity, support catalogue, aliases, and selection;
- generic onboarding and deterministic plan compilation;
- one OpenShell client boundary;
- credential references, provider profiles, binding and rewrite requirements;
- required-policy compilation and effective-policy evidence;
- product-state linkage, transactions, rollback, and checked-in support status;
- the typed E2E registry and workflow planner; and
- central live E2E and release judgment.

The architecture baseline records runtime-name branches, cross-boundary imports, direct OpenShell
paths, and all 14 `RuntimeProviderBundle` facets. Those facts are intentionally separate from the
whole-file candidate tables: they measure core convergence work, not additional package line
movement.

## 9. Reading the candidate tables

Each row has exactly one disposition:

- `move`: the whole file becomes package-owned;
- `split`: the notes name the core and package responsibilities;
- `keep`: the file stays in core or its explicitly deferred workstream; or
- `delete`: a superseded file, permitted only with a named replacement and parity gate.

Each row also names the current owner, target owner, target, phase, validation evidence, and an
ownership note. The detailed tables are:

- [OpenClaw](OPENCLAW-CANDIDATES.tsv)
- [Hermes](HERMES-CANDIDATES.tsv)
- [Deep Agents Code, Pi, and NemoCUA](TERMINAL-CANDIDATES.tsv)

Before code moves, the implementation diff must use these rows as a decreasing checklist. A split
is complete only when both named owners have tests and the old mixed path no longer carries the
other owner's authority.
