---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: nemoclaw-component-composition
status: executing
last_updated: "2026-08-27T22:55:03.336Z"
progress:
  total_phases: 8
  completed_phases: 1
  total_plans: 24
  completed_plans: 1
  percent: 4
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Project State

## Current Position

Phase: 2 of 8 — Agent Package Foundation

Status: Plan 02-01 accepted the exact Phase 2 scope for local fork implementation and development
evaluation. Plan 02-02 is next. This decision does not activate or support an upstream NemoClaw
product surface.

Decision record: `.planning/PROJECT.md#phase-2-implementation-decision`

Proposal revision: `5802308d09bdb64dba62dd541e42ad6bb223ceb0`

Decision record revision: `4fb6083cb02419d7a3768e9602220a00b361bc63`

## Repository Reconciliation

- Active branch: `agent-runtime-composition-architecture`
- Exact base: `origin/main` at `d0d5120cc6d574a5575b322b79b7cd49ca7c269d`
- Preserved candidate: `backup/agent-runtime-package-migration-pre-origin-main-20260827`
- Preserved candidate tip: `e856215a07`
- Pushes: none

At the Phase 1 baseline, the preserved candidate changed 1,773 files after its common base and main
changed 1,806. A trial direct merge produced 2,189 unresolved paths, including 1,889 paths under
`test/` and 213 under `packages/`. Phase 2 was then rebased and re-audited through the exact base
above. The migration strategy remains semantic capability-slice replay onto current main.

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

## Next Execution

Execute Plan 02-02 against the accepted local-fork boundaries. Keep arbitrary installed host code,
remote package discovery, product activation, and support claims outside this work. An upstream
contribution still requires its own accepted NVIDIA/NemoClaw product decision.

## Preserved Local State

The user-owned root lockfile change and the abandoned OpenShell upgrade remain in named stashes.
They are not part of this architecture branch and must not be applied, dropped, or pushed as part of
this work.
