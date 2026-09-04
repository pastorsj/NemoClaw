---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: nemoclaw-component-composition
status: Phase 4 typed agent runtime contract work is active; the finite loader and package-backed
  MCP slice are implemented locally, while aggregate, image, macOS, and Brev gates remain open
last_updated: "2026-09-04T00:00:00.000Z"
progress:
  total_phases: 9
  completed_phases: 1
  total_plans: 33
  completed_plans: 28
  percent: 85
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Project State

## Current Position

Phase: 4 of 9 — Agent Runtime Contract

Status: Phase 2 Plans 02-01 through 02-22 completed the package foundation. Plan 02-23 remains
pending and shares its no-messaging environment evidence with Phase 3 Plan 03-04. Phase 3 Plans
03-01 through 03-03 completed the generic, OpenClaw, and Hermes Fabric implementation; Plan 03-04
remains open. Phase 4 Plans 04-01 and 04-02 implemented the finite receipt-bound loader and
package-backed Model Context Protocol slice as a local prototype. Plans 04-03 through 04-05 remain
active because final aggregate evidence, independent package image inputs, current managed-image
receipts, and successful bounded macOS and Brev evidence are not complete.

This work does not activate or support an upstream product surface. The accepted Phase 2 decision
covers the data, sandbox, and image package foundation. It does not accept package-authored host
code as a supported extension surface.

Decision record: `.planning/PROJECT.md#phase-2-implementation-decision`

Proposal revision: `5a8253a97a1496e3ddf03ff85826672e86635eb9`

Decision record revision: `4fb6083cb02419d7a3768e9602220a00b361bc63`

## Repository Reconciliation

- Active branch: `agent-runtime-composition-architecture`
- Exact base: `origin/main` at `3d754417b5f07f9ed61ff709c5bb107aaffff1dc`
- Local upstream merge: `eef8ee45e54e39e540a10b2074a9ef4ed3dd1c26`
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
- [x] One generic sandbox-local Fabric runner selects released or package-owned adapters from
  package data without an agent-name branch.
- [x] Built artifacts have a public data-only validation command.
- [x] DCode keeps its native command while the released Deep Agents adapter provides separate
  evaluation evidence.
- [x] Pi has a package-owned adapter, exact configuration, and package-owned tests through the same
  runner.
- [x] OpenClaw supplies its package-owned Fabric adapter and deterministic package, composition,
  plugin, and Fabric lanes.
- [x] Hermes supplies its package-owned released-adapter integration and deterministic package,
  composition, subprocess, Python, and Fabric lanes.
- [x] One finite typed loader owns fixed package paths, exports, TypeScript request and result
  types, runtime schemas, value bounds, and receipt-pinned evaluation.
- [x] Package-backed MCP dispatch uses Hermes, OpenClaw, and LangChain Deep Agents Code package
  adapters without a core native fallback; Pi fails through typed capability validation.
- [x] All four packages supply typed runtime-configuration plans; OpenClaw also supplies its
  receipt-pinned restore merge grammar.
- [x] Core retains credentials, SSRF validation, policy, OpenShell execution, state, transaction,
  restart, verification, rollback, and redacted diagnostics.
- [x] A synthetic unknown package exercises MCP, configuration, and restore operations without a
  production catalogue row or agent-name branch.
- [x] Two existing OpenClaw restore test files moved from core source into package-owned host tests,
  retaining 28 declarations and 43 parameterized cases.
- [x] Layer-boundary and suite-membership checks protect package ownership with one counted legacy
  messaging build exception.
- [ ] The final E2E-support aggregate rerun is pending after command-credential and package-install
  fixture corrections.
- [ ] Current managed-image evidence is pending after the reviewed runtime bundle changed; existing
  Pi receipts bind older source bytes.
- [ ] macOS and Brev non-messaging evidence is pending and must not be reported as release evidence.

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

1. Obtain an `Accept` product decision before treating package-authored host code as canonical or
   continuing implementation of a supported extension surface.
2. Finish the final aggregate and E2E-support rerun on candidate `5a8253a97a`.
3. Replace stale managed-image evidence for the changed reviewed runtime bundle. Keep Pi candidate
   evidence separate from a shipped cohort that excludes Pi.
4. Finish the isolated macOS run and the bounded Brev/Linux Hermes Fabric, Deep Agents Code Fabric,
   and OpenClaw, Hermes, and Deep Agents Code MCP targets. Record identity, redaction, terminal
   state, and cleanup without broad reruns or messaging-service coverage.
5. Keep Plans 04-03 through 04-05 active until their exact evidence closes. Then migrate the named
   native core seams one current consumer at a time rather than claiming full agent-runtime
   independence.

The next native slices are the no-receipt MCP and configuration paths, remaining restore and CLI
grammar, closed managed startup, pairing and messaging projection, gateway and dashboard
protocols, optional agent features, shared root image inputs, Pi archive ownership, and the
2,320-line OpenClaw blueprint runner.

## Preserved Local State

The user-owned root lockfile change and the abandoned OpenShell upgrade remain in named stashes.
They are not part of this architecture branch and must not be applied, dropped, or pushed as part of
this work.
