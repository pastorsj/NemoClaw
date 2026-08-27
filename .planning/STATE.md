---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: nemoclaw-component-composition
status: planning
stopped_at: Architecture baseline complete; awaiting product-scope decision before implementation
last_updated: "2026-08-27T17:58:15.000Z"
last_activity: 2026-08-27 - Reconciled the architecture and test evidence through exact latest main.
progress:
  total_phases: 8
  completed_phases: 1
  total_plans: 8
  completed_plans: 1
  percent: 12
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Project State

## Current Position

Phase: 1 of 8 — Architecture Baseline

Status: Research and planning complete. No supported component surface has been implemented on this
branch. A recorded `Accept` decision with reason, placement, accountable maintainer, and validation
plan is required before Phase 2.

## Repository Reconciliation

- Active branch: `agent-runtime-composition-architecture`
- Exact base: `origin/main` at `705372dab8d4d28c0daf058aec1579ffc482db4c`
- Preserved candidate: `backup/agent-runtime-package-migration-pre-origin-main-20260827`
- Preserved candidate tip: `e856215a07`
- Pushes: none

The preserved candidate changed 1,773 files after its common base with current main; current main
changed 1,806. A trial direct merge produced 2,189 unresolved paths, including 1,889 paths under
`test/` and 213 under `packages/`. The migration strategy is therefore semantic capability-slice
replay onto current main.

The physical `packages/` directories in this checkout are ignored build leftovers from the
preserved branch. Current `HEAD` tracks no source under `packages/`.

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

## Next Gate

A recorded decision with status `Accept` must state the reason, repository placement, accountable
maintainer, and validation plan for the exact proposal revision, including:

1. the three initial package kinds and their owners;
2. the trusted-code policy for runtime-provider and serving executables;
3. the in-tree-first migration and external repository handoff criteria;
4. the supported component set, including whether Pi, NemoCUA, Podman, MXC, and DGX Station host
   preparation are candidates or supported surfaces;
5. the qualification environments and release-set ownership;
6. whether the NeMo Fabric pilot is test-only or a candidate product capability.

## Preserved Local State

The user-owned root lockfile change and the abandoned OpenShell upgrade remain in named stashes.
They are not part of this architecture branch and must not be applied, dropped, or pushed as part of
this work.
