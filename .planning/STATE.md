---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: nemoclaw-component-composition
status: Phase 2 foundation is reconciled with current origin/main; Phase 3 Fabric invocation
  evaluation is active with one released Deep Agents round trip
last_updated: "2026-08-30T02:38:32.000Z"
progress:
  total_phases: 8
  completed_phases: 1
  total_plans: 24
  completed_plans: 23
  percent: 96
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Project State

## Current Position

Phase: 2 of 8 — Agent Package Foundation

Status: Plans 02-05 through 02-22 completed the public harness inventory/install workflow,
installed-only agent compatibility list, exact registry authority, package-root definitions and
builds, installed-package selection, writer-locked Session binding, and exact package-managed
resume through route reservation, policy verification, sandbox creation, recreate journals,
checkpoint replay, final publication, recovery-only retained records, installer reconciliation,
exact snapshot backup, restore, clone, and manifest authority, prepared rebuild recovery with one
pinned target definition, and one immutable definition across all downstream rebuild consumers.
The existing typed E2E fixture now installs standard packages and proves exact final identity.
Plan 02-23 is next.
This work does not activate or support an upstream product surface.

Decision record: `.planning/PROJECT.md#phase-2-implementation-decision`

Proposal revision: `5802308d09bdb64dba62dd541e42ad6bb223ceb0`

Decision record revision: `4fb6083cb02419d7a3768e9602220a00b361bc63`

## Repository Reconciliation

- Active branch: `agent-runtime-composition-architecture`
- Exact base: `origin/main` at `78f0c9b7db15b22d83024bcda510ae0cebefb118`
- Local upstream merge: `34ceb565734785bebb0229150fbde0bd5faf8a8f`
- Preserved candidate: `backup/agent-runtime-package-migration-pre-origin-main-20260827`
- Preserved candidate tip: `e856215a07`
- Pushes: none

At the Phase 1 baseline, the preserved candidate changed 1,773 files after its common base and main
changed 1,806. A trial direct merge produced 2,189 unresolved paths, including 1,889 paths under
`test/` and 213 under `packages/`. Phase 2 was then rebased and re-audited through the exact base
above. The migration strategy remains semantic capability-slice replay onto current main.

`packages/nemoclaw-fabric` is the first source package added during this replay. Other physical
`packages/` directories remain ignored build leftovers from the preserved branch.

After Plan 02-03, the branch merged the three newer `origin/main` commits through
`d63f7b037dbec3d34dba73ed75f09a330d36b36f`. The merge had no conflicts. Package-store,
image/policy source, integration, E2E-support, and CLI type checks passed against the refreshed
tree.

## Completed Evidence

- [x] Current agent definition and repository-coupled discovery mapped.
- [x] Managed-startup agent-specific branches mapped.
- [x] Existing runtime-provider contract, registry, and activation authority mapped.
- [x] Existing serving catalogue and adapter registries mapped.
- [x] Platform readiness and product-claim matrix mapped.
- [x] Messaging, MCP, state, dashboard, and observability ownership boundaries mapped.
- [x] Current test projects, E2E planner, environment coverage, and package-test ownership mapped.
- [x] Preserved package installer, receipts, onboarding gate, structures, and tests audited.
- [x] NeMo Fabric stable and current-alpha contracts, adapters, versions, and execution boundary
  audited from official documentation and source.

- [x] Common envelope, three typed contracts, folder structures, CLI flow, compatibility model,
  migration order, and test strategy proposed.
- [x] Closed agent-runtime package envelope and exact digest-bound identity implemented.
- [x] Hostile package-tree validation, deterministic digesting, verified copying, and
  authority-bound cleanup implemented with 140 focused tests.
- [x] Immutable objects, digest-addressed receipts, atomic active pointers, pinned reads, and one
  data-only installation transaction implemented with 105 focused tests.
- [x] Three accepted standard harnesses build as validated read-only artifacts, and one catalogue
  reports available, healthy installed, and damaged state without fallback.
- [x] Session state can retain exact package identity and secret-free migration provenance;
  checkpoint v5 carries exact identity and explicitly migrates active v4 state without inference.
- [x] `harness list/install` exposes only reviewed packages, and `agents list` projects healthy
  installed standard harnesses without candidate promotion.
- [x] Registry, route, and policy state can preserve exact package authority without populating it.
- [x] Repository and package-managed definitions share one containment-safe explicit-root builder;
  sandbox resolution uses the recorded digest-addressed object without active-pointer fallback.
- [x] Package-managed image selection, Dockerfile staging, patching, and rebuilds read their assets
  from the selected pinned package root.
- [x] Onboarding selection handles zero, one, or many installed harness packages without bypassing
  candidate qualification or accepting damaged package state.
- [x] Writer-locked onboarding proves exact package authority before portable recovery, then binds
  one complete fresh Session or owner-scoped legacy migration before ordinary onboarding work.
- [x] Package-managed resume rejects flag, environment, recorded-agent, object, and pointer drift
  before Session, router, portable-host, or runtime mutation.
- [x] Route, pending policy, verified-create, final registration, and Hermes portable lifecycle
  mutations revalidate the Session-pinned package authority.
- [x] Checkpoint v5, recreate transaction v2, handler recovery, and outer rebuild journals retain
  one exact package identity and revalidate it before each independently resumable mutation.
- [x] Final registration and recovery-only retained state revalidate and preserve exact package
  authority without changing OpenClaw or qualified candidate compatibility behavior.
- [x] Installer reconciliation migrates legacy owners, validates exact retained package authority,
  and handles an empty package store before backup, Docker, or OpenShell changes.
- [x] Backup, restore, clone, and recovery manifests preserve and revalidate exact package,
  provider, registry, and captured-content authority before destructive mutation.
- [x] Prepared recovery and rebuild target preflight retain one exact manifest, package object, and
  agent definition through the synchronous deletion fence and image preparation.
- [x] Messaging, dashboard, GPU, DCode, MCP, policy, gateway, backup, restore, and post-restore
  rebuild consumers retain that definition and revalidate durable authority before mutation.
- [x] Standard typed E2E profiles install before onboarding and require receipt, Session, and
  registry package identity equality without a parallel target or workflow registry.

## Architecture Recommendations

- Use one common distribution envelope, not one common executable interface.
- Keep the CLI word `harness` for installing and listing agent runtime packages.
- Treat `agent runtime`, `runtime provider`, `serving runtime`, and `platform profile` as different
  concepts.

- Keep platform facts declarative. Split privileged host preparation only when executable behavior
  and ownership justify it.

- Keep installation separate from activation and qualification.
- Keep current core security, credential, policy, state, transaction, and rollback authorities.
- Reuse current runtime-provider, serving, readiness, messaging, and E2E registries.
- Use the preserved branch as evidence and a source of focused behavior, not as merge input.
- Keep the NeMo Fabric pilot sandbox-local and let evidence decide whether it remains test-only,
  leaves NemoClaw, or earns a later optional capability proposal.

## Next Execution

Execute `.planning/phases/NCC-03-fabric-headless/03-01-PLAN.md`. Keep arbitrary installed host code,
remote package discovery, product activation, and support claims outside this work. Complete the
remaining Phase 2 no-messaging qualification as part of the combined Mac and Brev evidence. An
upstream contribution still requires its own accepted NVIDIA/NemoClaw product decision.

## Preserved Local State

The user-owned root lockfile change and the abandoned OpenShell upgrade remain in named stashes.
They are not part of this architecture branch and must not be applied, dropped, or pushed as part of
this work.
