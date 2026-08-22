<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Runtime Package Disposition Ledger

> **Status:** Pre-acceptance engineering evidence. This ledger does not authorize an executable
> package interface or change supported NemoClaw behavior.
>
> **Audit revision:** `a5486894c45140259d822625e74d1ccdfce807ee`
>
> **Previous audit revision:** `c7af3734b9933b2380d7d7e919d625da89096c23`

## Discovery and reconciliation

The inventory was refreshed from the repository tree at the audit revision. The audit used
`git ls-tree`, the exact previous-to-current `git diff --name-status` range, `git show` for line
counts and source review, and `git cat-file -e` for path existence. It did not add a reusable
scanner or syntax-fingerprint abstraction.

All 674 paths in the previous candidate tables still exist. Sixteen new Hermes Portable uninstall
and Hermes Discord paths were added. The audit also corrected the prior exclusion of the two root
OpenClaw Dockerfiles, producing 692 unique current-tree rows. The removed
`tools/mcp-tool-discovery-runtime/npm-cache-seed/tar-7.5.20.tgz` is recorded only in
`RUNTIME-INVENTORY.md`; it was replaced upstream by the reviewed 7.5.21 seed and does not exist at
the audit revision.

Material current-tree surfaces that remain outside the package candidate tables are:

- provider republish ordering in `src/lib/onboard/sandbox-create/orchestration.ts`;
- final OpenShell lifecycle release in `src/lib/onboard/docker-gpu-supervisor-reconnect.ts`;
- the 300-second OpenClaw rebuild doctor deadline in
  `src/lib/actions/sandbox/rebuild-post-restore-phase.ts`;
- Amazon Bedrock provider lifecycle and cleanup;
- generic messaging provider-profile, credential-binding, required-policy, and effective-policy
  authority;
- the generic OpenShell sandbox-presence adapter and runtime-provider compatibility tests;
- shared dependency remediation, reviewed cache seeds, root package graphs, and the core-owned
  inputs consumed by the package-owned runtime image recipes; and
- central installer, DGX Station, and live E2E qualification support.

Those exclusions are retained core or release evidence. They are not silently assigned to a
runtime package.

## Candidate row contract

Each TSV row has one `move`, `split`, `keep`, or `delete` disposition and supplies these fields:

| Field | Meaning |
|---|---|
| `runtime` | Current canonical runtime ID. |
| `workstream` | Hermes-only separation of managed, portable, and broker work. |
| `surface` | Production, test, or lockfile measurement. |
| `disposition` | One final ownership action. |
| `nonblank_lines` | Whole-file physical nonblank lines at the audit revision. |
| `path` | Unique current-tree path that resolves at the audit revision. |
| `current_owner` | Owner before extraction. |
| `target_owner` | Owner after the named phase. |
| `target` | Destination or explicit retained boundary. |
| `phase` | First migration phase allowed to make the disposition real. |
| `validation` | Deterministic, package, image, or live evidence that closes the row. |
| `notes` | Ownership boundary; every split names both the core and package responsibility. |

A future `delete` row must name its replacement, parity gate, rollback owner, and removal evidence.
The sole current delete replaces the OpenClaw plugin's nested workspace lock with the root workspace
lock after clean dependency, build, test, and package-content parity. No candidate is deleted merely
to reduce the table.

## Reconciled totals

| Candidate table | Rows | Nonblank lines | Move | Split | Keep | Delete |
|---|---:|---:|---:|---:|---:|---:|
| OpenClaw | 258 | 112,458 | 160 | 78 | 19 | 1 |
| Hermes, all workstreams | 334 | 102,508 | 131 | 136 | 67 | 0 |
| Terminal runtimes | 100 | 39,765 | 68 | 20 | 12 | 0 |
| **Total** | **692** | **254,731** | **359** | **234** | **98** | **1** |

The disposition line totals are 157,572 for `move`, 61,037 for `split`, 33,496 for `keep`, and
2,626 for `delete`. The surface totals are 247 production rows and 90,215 lines, 437 test rows and
140,157 lines, and eight lock rows and 24,359 lines.

Portable Hermes contributes 39 rows and 17,510 lines; the Hermes tool broker contributes 14 rows
and 4,823 lines. Pi contributes nine rows and 3,225 lines, and NemoCUA contributes three rows and
74 lines. These four workstreams remain outside the standard package commitments.

## Package and core boundary rules

1. NemoClaw core retains product selection, checked-in support status, generic plan compilation,
   logical provider selection, credential references and bindings, required-policy compilation,
   named host routes and ports, product-state linkage, rollback, and central qualification.
2. OpenShell retains sandbox lifecycle and durable sandbox state, compute dispatch, effective
   policy, provider and credential custody and rewrite, inference interception, and the admitted
   image entrypoint.
3. A package owns bounded runtime-native configuration, inspection, reconciliation, image content,
   and detailed tests inside its sandbox boundary. A package does not receive OpenShell, host,
   credential, effective-policy, arbitrary-shell, UID, mount, device, capability, or rollback
   authority. The existing Deep Agents Code session cleanup wrapper and OpenClaw and Hermes
   entrypoint loops are named compatibility debt under OpenShell `0.0.106`; they may manage only
   package-declared descendants and are not helper or sandbox lifecycle operations.
4. A whole-file `move` is allowed only when the whole file has package ownership. A `split` closes
   only when both named owners have tests and the old mixed path no longer carries the other
   owner's authority.
5. Package-native render and reconcile work runs as the sandbox account. Root-required effects use
   only a closed core/bootstrap primitive selected from the accepted fixed operation set.
6. Package tests move with package behavior. Core keeps compatibility, security, state, lifecycle,
   and release-qualification evidence. Live messaging accounts are not a migration gate;
   deterministic messaging contracts remain a gate.

## Architecture debt baseline

`ARCHITECTURE-BASELINE.json` records exact paths and containing symbols at the same revision:

| Category | Findings | Migration rule |
|---|---:|---|
| Runtime-ID executable branches in runtime-neutral core | 395 path-symbol findings / 659 source sites | Replace runtime-name execution with catalogue data, package operations, or retained checked-in support status. |
| Core imports of runtime-native implementation | 7 | Move native implementation behind the package boundary; retain only explicit shared contracts. |
| Runtime-package imports of core implementation | 7 | Replace repository-root imports with shipped package inputs or the shared contract. |
| Direct OpenShell calls outside the one client boundary | 266 path-symbol findings / 342 call sites | Converge runtime API, CLI, process, and transport calls through `src/lib/adapters/openshell/client.ts`. |
| `RuntimeProviderBundle` facets | 14 facets / 56 path-symbol consumers / 84 source sites | Apply each facet's recorded retain, converge, or remove decision only after its exact OpenShell 0.0.106 parity and E2E gate. |

The direct-call audit excludes tests, fixtures, declarative release data, OpenShell installation and
release lookup, generic local host commands, and ordinary SSH or SSHFS after a validated OpenShell
`ssh-config` response. It includes the Portable Hermes uninstall, resolver, and restored-gateway
pairing adapters explicitly. Counts are an accepted-debt ceiling: later architecture checks may
reduce a finding only when its removal evidence is satisfied.

## Privileged-action disposition

The table covers runtime-specific root or authority-bearing effects for LangChain Deep Agents Code,
NemoClaw-managed Hermes, and OpenClaw. Build-time image assembly is verified by package image
conformance and is not runtime authority. Each runtime action below has exactly one classification:
`closed core/bootstrap primitive`, `non-root package rewrite`, `package compatibility wrapper`,
or `delete`.

| ID | Runtime | Current file and symbol | Required identity | Mutated resource | Classification | Target and rollback owner | Validation evidence | Owning cutover gate |
|---|---|---|---|---|---|---|---|---|
| PA-SHARED-01 | All three | `src/lib/onboard/managed-startup/image-runtime.ts#applyManagedStartupRootRequest` | Root in the managed image, reached only through the authenticated bootstrap request | Root-owned startup envelope, runtime environment, CA material, completion marker | closed core/bootstrap primitive | Core owns bounded request validation and application; `rollbackManagedStartupSharedStateTransaction` or core rebuild/destroy is the rollback owner | `managed-startup-image-entrypoint`, root-apply, replay, and managed-image live E2E | None; keep the request schema closed. |
| PA-SHARED-02 | All three | `src/lib/onboard/managed-startup/shared-state-transaction.ts#beginManagedStartupSharedStateTransaction` | Trusted root identity | Declared native files and directories plus bounded backup, manifest, and commit receipts | closed core/bootstrap primitive | Core owns begin, commit, and `rollbackManagedStartupSharedStateTransaction`; the transaction module is the rollback owner | Shared-state transaction, image-runtime handoff, clone, rebuild, and state backup/restore tests | None; a package may declare bounded targets but cannot select arbitrary paths. |
| PA-SHARED-03 | All three | `scripts/state-dir-guard.py#run_guard` | Trusted root identity | Declared agent state-tree ownership, modes, immutable flags, and writable subpaths | closed core/bootstrap primitive | Core Shields workflow owns the exact checked-in plan and inverse transition; the Shields transaction is the rollback owner | `state-dir-guard`, verification, metadata live E2E, and both runtime Shields E2E targets | None; arbitrary paths, identities, and policies remain rejected. |
| PA-SHARED-04 | All three | `src/lib/policy/index.ts#submitComposedPolicy` | Host NemoClaw authority invoking OpenShell | Effective sandbox policy | closed core/bootstrap primitive | Core compiles required policy and OpenShell applies it; the core policy transition journal is the rollback owner | Policy apply finality, exclusion journal, package policy conformance, and network-policy live E2E | None; packages supply bounded required-policy data, never effective-policy mutation. |
| PA-DCODE-01 | Deep Agents Code | `agents/langchain-deepagents-code/start.sh#protect_dcode_login_profile` | Root before dropping permanently to `sandbox` | `/sandbox` metadata and immutable `.bash_profile` | delete | Replace with an image-baked profile plus a fixed core bootstrap verification/install primitive; managed-startup transaction or sandbox replacement is the rollback owner | Deep Agents Code image conformance, `dcode-start-keepalive`, terminal connection, and full E2E | Phase 4 cutover blocker until the fixed primitive proves the same no-follow, owner, mode, and step-down behavior. |
| PA-DCODE-02 | Deep Agents Code | `agents/langchain-deepagents-code/generate-config.ts#main` | `sandbox` account | Deep Agents Code native `config.toml` | non-root package rewrite | Package `render-config` owns native rendering; the core managed-startup transaction is the rollback owner | Package clean-copy tests, config generator tests, image conformance, and inference-routing E2E | None; the package receives normalized intent and no credential value. |
| PA-DCODE-03 | Deep Agents Code | `agents/langchain-deepagents-code/start.sh#prepare_runtime_env` | `sandbox` account after the root step-down | Process-local environment and secret-free runtime marker | non-root package rewrite | Package reconcile/startup code owns native environment material; sandbox restart or core rebuild is the rollback owner | Deep Agents Code environment-boundary, launcher, image conformance, and terminal smoke tests | None; host files and root-owned trust anchors remain outside the package operation. |
| PA-DCODE-04 | Deep Agents Code | `agents/langchain-deepagents-code/dcode-session-supervisor.py#run` | `sandbox` account wrapping one admitted terminal session | Direct Deep Agents Code child and adopted session descendants | package compatibility wrapper | Move the current wrapper unchanged into the Deep Agents Code package. It may reap and signal only descendants of its admitted session; OpenShell owns session execution and disconnect, and core/OpenShell cleanup remains the rollback owner. | Deep Agents Code session-supervisor, proxy-launcher, disconnect cleanup, terminal connection, snapshot and restore, rebuild, cleanup, and full Deep Agents Code E2E | None for Phase 4. Remove only after an accepted later OpenShell pin supplies equivalent subreaping, bounded signal forwarding, disconnect cleanup, exit propagation, and the same E2E passes. |
| PA-HERMES-01 | NemoClaw-managed Hermes | `agents/hermes/start.sh#prepare_hermes_root_runtime` | Root in legacy managed-image startup | Hermes configuration metadata, provider placeholders, messaging configuration, runtime API material, and startup markers | delete | Split into fixed core root materials and non-root package render/reconcile operations; shared-state transaction and core rebuild are the rollback owner | Hermes startup, config integrity, MCP integrity, messaging binding, image conformance, and Hermes E2E | Phase 5 cutover blocker until every effect maps to a fixed operation; do not preserve the mixed root shell as a generic primitive. |
| PA-HERMES-02 | NemoClaw-managed Hermes | `src/lib/onboard/managed-startup/image-runtime.ts#sealHermesConfiguration` | Root in the managed image | Hermes native config, environment, policy digest, ownership, and modes | closed core/bootstrap primitive | Core owns the bounded seal and descriptor validation; shared-state transaction is the rollback owner | Image-runtime handoff, Hermes managed-policy, config-hash, Shields, and state backup/restore tests | None; native content creation moves to non-root rendering before this bounded seal. |
| PA-HERMES-03 | NemoClaw-managed Hermes | `agents/hermes/config/generate.ts#generateHermesConfig` | `sandbox` account | Hermes `config.yaml`, `.env`, and native model/provider shape | non-root package rewrite | Package `render-config` owns translation; shared-state transaction is the rollback owner | Hermes generator, credential-boundary, clean-copy package, image conformance, and inference-routing tests | None; logical references arrive without credential custody. |
| PA-HERMES-04 | NemoClaw-managed Hermes | `agents/hermes/mcp-config-transaction.py#apply_transaction` | `sandbox` account in the admitted mutable generation | Hermes native MCP entries and package-owned hash state | non-root package rewrite | Package `render-mcp` or `reconcile-state` owns the bounded transaction; core generation journal is the rollback owner | Hermes MCP transaction, integrity, restart ordering, package, and Hermes Shields E2E | None; lifecycle restart and mutation admission remain core/OpenShell-owned. |
| PA-HERMES-05 | NemoClaw-managed Hermes | `agents/hermes/start.sh#supervise_hermes_gateway_current_user` | Current sandbox identity acting as PID 1 | Hermes gateway descendants, auxiliary repair, health recovery, and relaunch decision | package compatibility wrapper | Move the current bounded loop unchanged into the Hermes package. OpenShell owns the admitted entrypoint and sandbox lifecycle; the core lifecycle transaction and OpenShell stop or destroy operation remain the rollback owner. | Hermes startup, child-failure recovery, authenticated replacement, stop/start, restart, rebuild, health, final release, and full Hermes E2E | None for Phase 5. Remove only after an accepted later OpenShell pin supplies equivalent descendant identity, restart, auxiliary repair, health, authenticated replacement, and final-release behavior and the same E2E passes. |
| PA-HERMES-06 | NemoClaw-managed Hermes | `agents/hermes/start.sh#migrate_legacy_layout` | Root in legacy startup when old state requires ownership repair | `/sandbox/.hermes`, `/sandbox/.hermes-data`, and the migration sentinel | delete | Replace with one core-admitted state generation and non-root package reconciliation; shared-state transaction is the rollback owner | Hermes legacy-state migration, hostile-link, snapshot, restore, rebuild, and Shields tests | Phase 5 cutover blocker until the bounded reconciliation declares every target and restores the prior generation after interruption. |
| PA-OPENCLAW-01 | OpenClaw | `scripts/nemoclaw-start.sh#prepare_openclaw_config_for_write` | Root in legacy managed-image startup | OpenClaw config directory, config file, and hash ownership and modes | delete | Replace with a fixed core state-transition primitive followed by non-root package render; OpenClaw config transaction and core rebuild are the rollback owner | OpenClaw config transaction, hostile-input guard, Shields, restart, image conformance, and full E2E | Phase 7 cutover blocker until the fixed primitive covers the current descriptor-validated transition and inverse. |
| PA-OPENCLAW-02 | OpenClaw | `scripts/openclaw-config-guard.py#main` | Root for lock/recovery actions; sandbox identity for admitted inspections | OpenClaw configuration seal, hash, journal, and recovery state | closed core/bootstrap primitive | Core Shields/config transaction owns the closed action vocabulary; its recover or unlock transaction is the rollback owner | Config-guard, lock/reseal, startup-failure, restore, Shields, and state backup/restore tests | None; package code cannot extend the root action vocabulary. |
| PA-OPENCLAW-03 | OpenClaw | `scripts/generate-openclaw-config.mts#writeOpenClawConfig` | `sandbox` account inside an admitted writable generation | OpenClaw native configuration | non-root package rewrite | Package `render-config` owns native rendering; core config transaction is the rollback owner | Generator security and compatibility tests, clean-copy package tests, image conformance, and full E2E | None; policy, credentials, and lifecycle remain references and core/OpenShell effects. |
| PA-OPENCLAW-04 | OpenClaw | `scripts/nemoclaw-start.sh#apply_messaging_runtime_env_aliases` | `sandbox` account after core admits the messaging plan | OpenClaw native messaging environment aliases and preload selection | non-root package rewrite | Package `render-messaging` owns native translation; the core messaging plan and rebuild transaction are the rollback owner | Deterministic channel plan, credential binding, package messaging, image conformance, and no-live-account E2E | None; provider profiles, credential bindings, and effective policy stay core/OpenShell-owned. |
| PA-OPENCLAW-05 | OpenClaw | `scripts/nemoclaw-start.sh#restore_openclaw_config_after_write` | Root in legacy managed-image startup | OpenClaw configuration and hash ownership, modes, and seal state | delete | Replace with the inverse fixed core state-transition primitive; OpenClaw configuration transaction and core rebuild are the rollback owner | Configuration transaction rollback, lock/reseal, hostile-input, restart, Shields, and full E2E | Phase 7 cutover blocker with PA-OPENCLAW-01; both directions must prove interruption recovery. |
| PA-OPENCLAW-06 | OpenClaw | `scripts/nemoclaw-start.sh#launch_openclaw_gateway` | Root PID 1 before step-down to the gateway identity | OpenClaw gateway descendants, process identity records, health recovery, and bounded relaunch decision | package compatibility wrapper | Move the current bounded loop unchanged into the OpenClaw package. OpenShell owns the admitted entrypoint and sandbox lifecycle; the core lifecycle transaction and OpenShell stop or destroy operation remain the rollback owner. | OpenClaw startup, child-failure recovery, authenticated replacement, stop/start, restart, rebuild, watchdog, final release, and full E2E | None for Phase 7. Remove only after an accepted later OpenShell pin supplies equivalent descendant identity, restart, health, authenticated replacement, and final-release behavior and the same E2E passes. |
| PA-OPENCLAW-07 | OpenClaw | `scripts/nemoclaw-start.sh#migrate_legacy_layout` | Root in legacy startup when old state requires ownership repair | `/sandbox/.openclaw`, legacy data roots, symlinks, and the migration sentinel | delete | Replace with one core-admitted state generation and non-root package reconciliation; OpenClaw configuration transaction is the rollback owner | OpenClaw legacy-state migration, hostile-link, snapshot, restore, rebuild, and Shields tests | Phase 7 cutover blocker until the bounded reconciliation declares every target and restores the prior generation after interruption. |

A package must not turn a `delete` row into package-owned root code. Phase 3 freezes the helper
framing and catalogue while it registers the current execution paths unchanged. The marked rows
block only their owning package cutover: Phase 4 for Deep Agents Code, Phase 5 for managed Hermes,
and Phase 7 for OpenClaw. There is no Phase 3 blocker in this table. The three compatibility
wrappers preserve existing descendant cleanup or recovery without becoming helper operations or a
public lifecycle contract. A new unclassified effect blocks the phase that would first change or
expose that effect instead of expanding the primitive set.

## Unresolved blockers

- The repository product scope gate is not passed until the accepted decision records placement,
  accountable ownership, lifecycle, compatibility, security, and validation. These files remain
  pre-acceptance evidence.
- The remaining privileged `delete` rows need fixed-operation designs and parity evidence before
  their Phase 4, 5, or 7 package cutover. Phase 3 keeps the current startup paths. The three retained
  compatibility wrappers need an accepted exception and exact descendant-recovery E2E.
- OpenShell 0.0.106 parity is not demonstrated for every converging `RuntimeProviderBundle` facet.
  The facet stays until its recorded client route, observations, failure behavior, and exact E2E
  targets pass.
- Portable Hermes, the Hermes tool broker, Pi, NemoCUA, activation/removal, external registries,
  public PyPI or OCI transport, repository splitting, and live messaging qualification require
  separate accepted decisions.
- An independent repository split cannot start until each in-tree package passes clean-copy
  packaging, shipped-content, package contract, image conformance, lifecycle E2E, and rollback gates.
