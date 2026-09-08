---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: nemoclaw-component-composition
status: NCC-06 local POC qualification is active; six receipt-backed harness packages use the
  typed package and Fabric path, while exact-candidate deterministic, macOS, Brev, and protected
  managed-image evidence remain open
last_updated: "2026-09-08T00:00:00.000Z"
progress:
  total_phases: 9
  completed_phases: 1
  total_plans: 34
  completed_plans: 31
  percent: 91
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Project State

## Current Position

Workstream: NCC-06 — Official-ready Harness Contract Local POC

Status: The package foundation, finite typed loader, package lifecycle, package-owned Fabric
adapters, and generic live runner now cover OpenClaw, Hermes, LangChain Deep Agents Code, Pi,
DeepSeek Harness, and Haystack Agent. Receipt-backed skill lifecycle uses the same typed capability:
packages declare native list/add/remove argv when available and bounded filesystem behavior when
the harness has no native operation. The latest upstream native skill work was reconciled without
adding a production-core package-ID decision. Exact-candidate aggregate and live qualification is
now running; messaging-service E2E remains intentionally excluded.

This work does not activate or support an upstream product surface. The accepted Phase 2 decision
covers the data, sandbox, and image package foundation. It does not accept package-authored host
code as a supported extension surface.

Decision record: `.planning/PROJECT.md#phase-2-implementation-decision`

Accepted Phase 2 proposal revision: `5802308d09bdb64dba62dd541e42ad6bb223ceb0`

Current code candidate before the state-only qualification commit:
`5d1caa8536dcbf8a6b17953f35e6282784de2909`

Decision record revision: `4fb6083cb02419d7a3768e9602220a00b361bc63`

## Repository Reconciliation

- Active branch: `agent-runtime-composition-architecture`
- Exact base: `origin/main` at `efd56a372999acc9d97936e9b30b2164743255a5`
- Local upstream merge: `5d1caa8536dcbf8a6b17953f35e6282784de2909`
- Preserved candidate: `backup/agent-runtime-package-migration-pre-origin-main-20260827`
- Preserved candidate tip: `e856215a07`
- All work after the previously published fork tip remains local-only and must not be pushed

At the Phase 1 baseline, the preserved candidate changed 1,773 files after its common base and main
changed 1,806. A trial direct merge produced 2,189 unresolved paths, including 1,889 paths under
`test/` and 213 under `packages/`. Phase 2 was then rebased and re-audited through the exact base
above. The migration strategy remains semantic capability-slice replay onto current main.

The tracked source packages are `nemoclaw-fabric`, `nemoclaw-openclaw`, `nemoclaw-hermes`,
`nemoclaw-langchain-deepagents-code`, `nemoclaw-pi`, `nemoclaw-deepseek-harness`, and
`nemoclaw-haystack-agent`.

After Plan 02-03, the branch merged the three newer `origin/main` commits through
`d63f7b037dbec3d34dba73ed75f09a330d36b36f`. The merge had no conflicts. Package-store,
image/policy source, integration, E2E-support, and CLI type checks passed against the refreshed
tree.

On 2026-09-08, the branch semantically merged `origin/main` through `efd56a3729`. The reconciliation
kept upstream's native agent skill lifecycle, expressed its command grammar in the existing typed
package capability, removed one literal OpenClaw decision from core and its audited debt allowance,
and retained package receipt revalidation before mutation. Contract validation, all six package
conformance checks, focused skill and runtime tests, CLI typechecking, policy materialization, the
reviewed runtime bundle, architecture budgets, assertion budgets, and growth guardrails pass. The
repository check proceeds through every ordinary gate and then stops at the protected Pi
qualification-receipt publication requirement; local code cannot manufacture that release evidence.

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
- [x] Six local-POC harnesses build as validated read-only artifacts, and one catalogue reports
  available, healthy installed, and damaged state without fallback.
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
- [x] DeepSeek Harness and Haystack Agent supply package-owned stable-Fabric adapters, immutable
  runtime configuration, cancellation and cleanup behavior, and deterministic package lanes
  without adding their IDs to production core.
- [x] One finite typed loader owns fixed package paths, exports, TypeScript request and result
  types, runtime schemas, value bounds, and receipt-pinned evaluation.
- [x] Package-backed MCP dispatch uses Hermes, OpenClaw, and LangChain Deep Agents Code package
  adapters without a core native fallback; Pi fails through typed capability validation.
- [x] All six packages supply typed runtime-configuration plans; OpenClaw also supplies its
  receipt-pinned restore merge grammar.
- [x] Core retains credentials, SSRF validation, policy, OpenShell execution, state, transaction,
  restart, verification, rollback, and redacted diagnostics.
- [x] A synthetic unknown package exercises MCP, configuration, and restore operations without a
  production catalogue row or agent-name branch.
- [x] One synthetic authoring package flows through metadata discovery, artifact materialization,
  alias installation, receipt publication, onboarding selection, Dockerfile workload selection,
  startup persistence, Fabric command selection, private standard-input handoff, and typed MCP
  refusal without a production package-ID branch.
- [x] The same unknown-package contract completed bounded macOS and Brev development runs. Its
  receipt survived interrupted onboarding, resume, stop, and start; Fabric returned `PONG` before
  and after a gateway restart; resource-scoped cleanup passed.
- [x] Two existing OpenClaw restore test files moved from core source into package-owned host tests,
  retaining 28 declarations and 43 parameterized cases.
- [x] Layer-boundary and suite-membership checks protect package ownership with one counted legacy
  messaging build exception.
- [x] The E2E-support aggregate passed: 265 files passed and 4 skipped; 3,874 tests passed and 39
  skipped. The focused package-composition test passed 1/1; the relevant compiled package contracts
  passed 14/14; CLI typecheck, assertion ratchet, 45/45 growth guard, and project membership for
  2,476 candidates across 7 projects passed.
- [ ] Current managed-image evidence is pending after the reviewed runtime bundle changed; existing
  Pi receipts bind older source bytes.
- [ ] Exact-candidate aggregate and six-package Mac and Brev live gates remain open. Earlier
  unknown-package and named-package runs are development evidence, not release evidence for this
  candidate.

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

1. Finish package-contract, E2E-support, package-owned, and changed-source deterministic aggregates
   for the state-only qualification candidate.
2. Build exact artifacts and run the shared install/onboard/Fabric-turn/restart/turn/destroy journey
   for all six packages on macOS and Brev. Keep messaging-service coverage excluded.
3. Record package digests, runtime identities, redaction, process cleanup, sandbox cleanup, and any
   bounded failure evidence in the NCC-06 qualification record.
4. Keep the protected Pi image-receipt publication gate explicit. Local development builds cannot
   replace a same-workflow AMD64 and ARM64 release receipt.
5. Obtain a separate product `Accept` decision before describing this local contract, DeepSeek,
   Haystack, or package-authored host code as canonical or supported NemoClaw behavior.

The next native slices are the no-receipt MCP and configuration paths, remaining restore and CLI
grammar, closed managed startup, pairing and messaging projection, gateway and dashboard
protocols, optional agent features, shared root image inputs, Pi archive ownership, and the
2,320-line OpenClaw blueprint runner.

## Preserved Local State

The user-owned root lockfile change and the abandoned OpenShell upgrade remain in named stashes.
They are not part of this architecture branch and must not be applied, dropped, or pushed as part of
this work.
